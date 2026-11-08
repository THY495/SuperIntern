// 交付后回路：盯已交付的 PR。假的 GitHub（fetchFn），不连网。
//   ① 记下交付的 PR；读一次：状态、CI（检查 + 提交状态）、评审、两种评论；评论人对上成员（绑定的 id / 管理员填的账号；自己填的不认）
//   ② 条件请求：第二次带 If-None-Match，304 用缓存；没变不写参数行
//   ③ 节奏：CI 在跑 1 分钟、跑完 5 分钟、关了 30 分钟、合并了不再看；出错按 1 / 5 / 15 / 45 分钟退避
//   ④ 缺权限降级：checks / statuses 403 → 标缺什么、CI 状态 unknown，别的照看；App 不给 CI 权限 → 换只读 PR 的令牌
//   ⑤ 额度见底：整体等到重置
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { openDb, ensureOwner, audit } from '../src/db/db.mjs';
import { insertTask } from '../src/db/tasks.mjs';
import { addUser } from '../src/core/users.mjs';
import { updateUser } from '../src/db/users.mjs';
import { addCredential, clearAppCache } from '../src/core/credentials.mjs';
import { recordDeliveredPr, notePrPushed, watchedPrs, makePrWatcher, prStateOf, ciSummary, memberForGithub, nextDelay, CADENCE, BACKOFF } from '../src/core/pr-watch.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-prw-'));
const db = openDb(join(TMP, 'state.db'));
const owner = ensureOwner(db);
const bound = addUser(db, { name: '甲', role: 'member', byUserId: owner.userId });
updateUser(db, bound.userId, { githubLogin: 'jia', githubId: 1001 });
const adminSet = addUser(db, { name: '乙', role: 'member', byUserId: owner.userId });
updateUser(db, adminSet.userId, { githubLogin: 'yi' });
audit(db, { actorKind: 'user', actorId: owner.userId, action: 'user_git_identity_set', targetType: 'user', targetId: adminSet.userId, payload: { github: 'yi', byAdmin: true } });
const selfSet = addUser(db, { name: '丙', role: 'member', byUserId: owner.userId });
updateUser(db, selfSet.userId, { githubLogin: 'bing' });
const taskId = insertTask(db, { ownerId: owner.userId, title: '加导出', status: 'done' });

// ── 假 GitHub ──────────────────────────────────────────────────────────────
const H = (o = {}) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const gh = {
  pr: { state: 'open', merged: false, title: '加导出', head: { sha: 'abc123' } },
  runs: [{ id: 11, name: 'test', status: 'in_progress', conclusion: null, html_url: 'https://github.com/o/r/runs/11', app: { slug: 'github-actions' } }],
  statuses: [],
  reviews: [], issueComments: [], lineComments: [],
  deny: new Set(), remaining: 4000, calls: [], down: false,
};
const fetchFn = async (url, init = {}) => {
  gh.calls.push({ url, inm: init.headers?.['if-none-match'] ?? null, auth: init.headers?.authorization });
  if (gh.down) throw new Error('fetch failed');
  const path = url.replace('https://api.github.com/repos/o/r', '');
  const body = path.startsWith('/pulls/7/reviews') ? gh.reviews : path.startsWith('/pulls/7/comments') ? gh.lineComments : path.startsWith('/pulls/7') ? gh.pr
    : path.startsWith('/issues/7/comments') ? gh.issueComments : /\/check-runs/.test(path) ? { check_runs: gh.runs } : /\/status$/.test(path) ? { statuses: gh.statuses } : null;
  const need = /check-runs/.test(path) ? 'checks' : /\/status$/.test(path) ? 'statuses' : null;
  const rate = { 'x-ratelimit-remaining': String(gh.remaining), 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) };
  if (need && gh.deny.has(need)) return { ok: false, status: 403, headers: H(rate), json: async () => ({ message: 'Resource not accessible by integration' }) };
  if (body == null) return { ok: false, status: 404, headers: H(rate), json: async () => ({}) };
  const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
  if (init.headers?.['if-none-match'] === etag) return { ok: false, status: 304, headers: H({ ...rate, etag }), json: async () => null };
  return { ok: true, status: 200, headers: H({ ...rate, etag }), json: async () => JSON.parse(JSON.stringify(body)) };
};
const env = { GITHUB_TOKEN: 'ghp_deploytoken' };
const T0 = Date.parse('2026-10-20T10:00:00Z');

section('① 记下交付的 PR；读一次：状态、CI、评审与评论；评论人对上成员');
{
  recordDeliveredPr(db, { taskId, gh: { owner: 'o', repo: 'r' }, pr: { number: 7, url: 'https://github.com/o/r/pull/7', base: 'main' }, branch: 'v0/x', head: 'abc123', userId: owner.userId, tokenId: null, at: T0 });
  eq(watchedPrs(db, { at: T0 }).map((x) => [x.key, x.pr.number]), [[`t:${taskId}`, 7]], '交付时记下的 PR 进了要盯的清单');
  gh.issueComments = [
    { id: 1, user: { login: 'jia', id: 1001, type: 'User' }, body: '导出的列顺序不对', created_at: '2026-10-20T10:01:00Z', html_url: 'u1' },
    { id: 2, user: { login: 'yi', id: 2002, type: 'User' }, body: '同意', created_at: '2026-10-20T10:02:00Z', html_url: 'u2' },
    { id: 3, user: { login: 'bing', id: 3003, type: 'User' }, body: '我是丙', created_at: '2026-10-20T10:03:00Z', html_url: 'u3' },
    { id: 4, user: { login: 'codecov[bot]', id: 9, type: 'Bot' }, body: '覆盖率 80%', created_at: '2026-10-20T10:04:00Z', html_url: 'u4' },
  ];
  gh.reviews = [{ id: 5, user: { login: 'jia', id: 1001 }, state: 'CHANGES_REQUESTED', body: '改一下', submitted_at: '2026-10-20T10:05:00Z', html_url: 'r5', commit_id: 'abc123' },
    { id: 6, user: { login: 'yi', id: 2002 }, state: 'COMMENTED', body: '', submitted_at: '2026-10-20T10:06:00Z' }];
  gh.lineComments = [{ id: 8, pull_request_review_id: 5, user: { login: 'jia', id: 1001 }, body: '这里少了表头', path: 'src/export.js', line: 12, created_at: '2026-10-20T10:05:00Z', html_url: 'l8' }];
  const changes = [];
  const w = makePrWatcher(db, { fetchFn, env, onChange: async (item, prev, next) => changes.push([prev?.ci?.state ?? null, next.ci.state]) });
  eq(await w.tick(T0), 1, '一拍看了一个');
  const s = prStateOf(db, { taskId });
  eq([s.state, s.head, s.ci.state, s.ci.items.map((x) => [x.name, x.state])], ['open', 'abc123', 'pending', [['test', 'pending']]], 'PR 开着、CI 在跑');
  eq(s.comments.map((c) => [c.id, c.author.member, c.author.bot]), [
    ['issue:1', bound.userId, false], ['issue:2', adminSet.userId, false], ['issue:3', null, false], ['issue:4', null, true], ['review:5', bound.userId, false], ['line:8', bound.userId, false]],
  '评论人：绑定 id 的对上、管理员填账号的对上、自己填的不认、机器人标出来；空的"评论过"评审不收');
  eq(s.comments.find((c) => c.id === 'line:8').path, 'src/export.js', '行内评论带文件与行');
  eq(changes, [[null, 'pending']], '变了就通知（给代修与评审跟进接）');
  assert(gh.calls.every((c) => c.auth === 'Bearer ghp_deploytoken'), '用部署级连接读（系统自己发起的动作不碰成员的连接）');
  eq(memberForGithub(db, { id: 3003, login: 'bing' }), null, '自己在资料里填的账号不认（防冒领）');
}

section('② 条件请求：304 用缓存；没变不写参数行');
{
  const w = makePrWatcher(db, { fetchFn, env });
  await w.tick(T0 + 1);
  const rows0 = db.one(`SELECT COUNT(*) n FROM params WHERE task_id=? AND key='delivery.pr_state'`, taskId).n;
  gh.calls.length = 0;
  await w.pollNow({ taskId }, T0 + 2 * 60_000);
  assert(gh.calls.length >= 5 && gh.calls.every((c) => c.inm), '第二次每个地址都带 If-None-Match', JSON.stringify(gh.calls.map((c) => c.inm)));
  eq(db.one(`SELECT COUNT(*) n FROM params WHERE task_id=? AND key='delivery.pr_state'`, taskId).n, rows0, '什么都没变：不写新的一行（参数表带历史，轮询不能每分钟写一行）');
}

section('③ 节奏与退避');
{
  eq([nextDelay({ state: 'open', ci: { state: 'pending' } }), nextDelay({ state: 'open', ci: { state: 'success' } }), nextDelay({ state: 'closed' }), nextDelay({ state: 'merged' })],
    [CADENCE.pending, CADENCE.settled, CADENCE.closed, null], 'CI 在跑 1 分钟、跑完 5 分钟、关了 30 分钟、合并了不再看');
  eq([1, 2, 3, 4, 9].map((n) => nextDelay({ state: 'open' }, n)), [BACKOFF[0], BACKOFF[1], BACKOFF[2], BACKOFF[3], BACKOFF[3]], '出错 1 / 5 / 15 / 45 分钟，之后停在 45');
  const w = makePrWatcher(db, { fetchFn, env });
  await w.tick(T0 + 10 * 60_000);
  eq(await w.tick(T0 + 10 * 60_000 + 30_000), 0, '还没到下一次：不看');
  eq(await w.tick(T0 + 11 * 60_000 + 1), 1, 'CI 在跑：1 分钟后再看');
  gh.runs = [{ ...gh.runs[0], status: 'completed', conclusion: 'failure' }];
  await w.pollNow({ taskId }, T0 + 12 * 60_000);
  eq(prStateOf(db, { taskId }).ci.state, 'failure', 'CI 失败看到了');
  eq(w._state().due.get(`t:${taskId}`), T0 + 12 * 60_000 + CADENCE.settled, '跑完了：5 分钟一次');
  const n0 = db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='pr_state_changed' AND target_id=?`, taskId).n;
  gh.down = true;
  await w.pollNow({ taskId }, T0 + 20 * 60_000);
  const st = prStateOf(db, { taskId });
  assert(st.error && /读 PR 失败/.test(st.error.msg) && st.ci.state === 'failure', '网络出错：记下原因，上一次看到的保留着', JSON.stringify(st.error));
  eq(w._state().due.get(`t:${taskId}`), T0 + 20 * 60_000 + BACKOFF[0], '第一次出错：1 分钟后再试');
  await w.pollNow({ taskId }, T0 + 21 * 60_000);
  eq(w._state().due.get(`t:${taskId}`), T0 + 21 * 60_000 + BACKOFF[1], '第二次：5 分钟');
  eq(db.one(`SELECT COUNT(*) n FROM audit_log WHERE action='pr_state_changed' AND target_id=?`, taskId).n, n0 + 1, '连续出错只记一条审计（出错这件事变了一次）');
  gh.down = false;
  await w.pollNow({ taskId }, T0 + 30 * 60_000);
  assert(!prStateOf(db, { taskId }).error && w._state().fails.get(`t:${taskId}`) === 0, '好了：清掉错误与退避');
  gh.pr = { ...gh.pr, state: 'closed', merged: true, merged_at: '2026-10-20T11:00:00Z' };
  await w.pollNow({ taskId }, T0 + 40 * 60_000);
  eq([prStateOf(db, { taskId }).state, watchedPrs(db, { at: T0 + 41 * 60_000 }).length], ['merged', 0], '合并了：不再盯');
  gh.pr = { state: 'open', merged: false, title: '加导出', head: { sha: 'def456' } };
}

section('④ 缺权限降级');
{
  const t2 = insertTask(db, { ownerId: owner.userId, title: '第二个', status: 'done' });
  recordDeliveredPr(db, { taskId: t2, gh: { owner: 'o', repo: 'r' }, pr: { number: 7, url: 'u', base: 'main' }, branch: 'v0/y', head: 'def456', userId: owner.userId, at: T0 });
  gh.deny = new Set(['checks', 'statuses']);
  const w = makePrWatcher(db, { fetchFn, env });
  await w.pollNow({ taskId: t2 }, T0 + 50 * 60_000);
  const s = prStateOf(db, { taskId: t2 });
  eq([s.ci.state, s.missing, s.state, s.error], ['unknown', ['checks:read', 'statuses:read'], 'open', null], '连接读不了检查 / 状态：CI 标 unknown、记下缺什么；PR 状态与评论照看，不算出错');
  gh.deny = new Set();
  // GitHub App 没给 CI 那几项权限：要 poll 权限的安装令牌换不出来 → 换只要 PR 读权限的那份，CI 标缺
  clearAppCache();
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  addCredential(db, { kind: 'github_app', name: '团队 App', appId: '4242', secret: privateKey.export({ type: 'pkcs1', format: 'pem' }), pathGlob: 'o/*', byUserId: owner.userId });
  const mints = [];
  const appFetch = async (url, init = {}) => {
    if (url.endsWith('/installation')) return { ok: true, status: 200, headers: H(), json: async () => ({ id: 77 }) };
    if (url.endsWith('/access_tokens')) {
      const perms = JSON.parse(init.body).permissions;
      mints.push(Object.keys(perms).sort().join(','));
      if (perms.checks) return { ok: false, status: 422, headers: H(), json: async () => ({}) };
      return { ok: true, status: 201, headers: H(), json: async () => ({ token: 'ghs_basic', expires_at: new Date(Date.now() + 3600_000).toISOString() }) };
    }
    return fetchFn(url, init);
  };
  const w2 = makePrWatcher(db, { fetchFn: appFetch, env: {} });
  await w2.pollNow({ taskId: t2 }, T0 + 60 * 60_000);
  const s2 = prStateOf(db, { taskId: t2 });
  eq(mints, ['actions,checks,metadata,pull_requests,statuses', 'metadata,pull_requests'], '先要读 CI 的权限，App 不给就只要读 PR 的');
  eq([s2.ci.state, s2.missing.includes('checks:read'), s2.credential], ['unknown', true, '团队 App'], 'CI 标缺权限，用的是 App');
  const w3 = makePrWatcher(db, { fetchFn: async () => ({ ok: false, status: 401, headers: H(), json: async () => ({}) }), env: {} });
  clearAppCache();
  db.run(`UPDATE credentials SET revoked_at=1`);
  await w3.pollNow({ taskId: t2 }, T0 + 70 * 60_000);
  assert(/没有能读 o\/r 的连接/.test(prStateOf(db, { taskId: t2 }).error?.msg ?? '') || /没有能读 \{repo\}/.test(prStateOf(db, { taskId: t2 }).error?.msg ?? ''), '一份能读的连接都没有：说清去哪里装', JSON.stringify(prStateOf(db, { taskId: t2 }).error));
}

section('⑤ 额度见底：整体等到重置；再交付推送记下新头');
{
  const t3 = insertTask(db, { ownerId: owner.userId, title: '第三个', status: 'done' });
  recordDeliveredPr(db, { taskId: t3, gh: { owner: 'o', repo: 'r' }, pr: { number: 7, url: 'u', base: 'main' }, branch: 'v0/z', head: 'def456', userId: owner.userId, at: T0 });
  gh.remaining = 10;
  const w = makePrWatcher(db, { fetchFn, env, perTick: 10 });
  const at = Date.now();
  await w.tick(at);
  assert(w._state().holdUntil > at, '剩余额度低于 50：记下等到重置的时刻');
  eq(await w.tick(at + 1000), 0, '重置之前一个都不看');
  gh.remaining = 4000;
  eq(notePrPushed(db, { taskId: t3, head: 'fff999' }).head, 'fff999', '再交付推送：记下新头（CI 按新头读）');
  eq(ciSummary([], [{ context: 'ci/jenkins', state: 'error', target_url: 'j' }]).state, 'failure', '提交状态 error 也算失败（Jenkins 之类不走检查接口）');
}

db.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
