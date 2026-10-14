// 多会话端到端：团队模式下几个人各自登录、各开一条 SSE，全部动作走 HTTP。
//   ① 登录：管理员、成员甲各用自己的令牌换会话 cookie；乙经邀请链接进来（cookie + 一次性命令行令牌）；假令牌登录 401；
//   ② 三条 SSE：同一件事，看得见的人收到、看不见的人收不到（仅成员可见的项目）；
//   ③ 甲在 HTTP 上答复指给他的事项，管理员那条流收到；乙拿自己项目的任务地址、带甲那边的事项 id
//      （留言 about、答复、标报告已读）—— 一律 404，库里什么都没写；
//   ④ 同一个人开两个页面：两边拿同一个版本号改决策路由，后到的 409；
//   ⑤ 吊销甲的全部令牌：甲那条流收到 revoked 并断开、cookie 失效；管理员的流照常；管理员退出 → 他的流也断；
//   ⑥ 假令牌全流程不落盘：贴进项目目标、消息、答复，录入连接，存服务商密钥（只许进 .env），登录失败的那枚，
//      还有每一枚会话 / 长期 / 邀请令牌 —— 关掉看板后扫 home 下每个文件（git 松散对象解压后再扫）。
//
// 跑：node tests/multi-session.test.mjs

import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { inflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { insertQuestion, applyRoute } from '../src/core/questions.mjs';
import { startWeb } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e !== undefined ? `\n         ${typeof e === 'string' ? e : JSON.stringify(e)}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return !!fn(); };

// 假令牌：形状认得出的（落库前就去掉）+ 形状认不出、只经连接 / 服务商密钥进来的
const rnd = (n) => randomBytes(n).toString('hex').slice(0, n);
const GH = 'gh' + 'p_' + rnd(36), GH2 = 'gh' + 'p_' + rnd(36), SK = 's' + 'k-ant-' + rnd(40);
const CRED = 'gitea-' + rnd(30), KEY = 'corp-gw-' + rnd(28), FAKE_LOGIN = 'si_' + rnd(40);

const TMP = mkdtempSync(join(tmpdir(), 'si-msess-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const HOME = join(TMP, 'home'); mkdirSync(HOME);
const db = openDb(join(HOME, 'state.db'));
const owner = ensureOwner(db, '管理员');
const alice = addUser(db, { name: '甲', role: 'member', byUserId: owner.userId });

const PUB = 'si.e2e.lan';
const noLlm = () => { throw new Error('多会话测试不调模型'); };
const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 80, team: true, publicUrl: `https://${PUB}`,
  envFile: join(HOME, '.env'), env: {}, makeClassifierClient: noLlm, runtime: { current: () => null }, fetchFn: async () => { throw new Error('测试不联网'); } });
const port = w.port;

/** 原样带 Host / Cookie 的请求（团队模式按对外地址核来源） */
const call = (method, path, { cookie = null, body = null } = {}) => new Promise((resolve, reject) => {
  const data = body === null ? null : JSON.stringify(body);
  const r = request({ host: '127.0.0.1', port, method, path, headers: { host: PUB, 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
    let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
    res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: res.statusCode, headers: res.headers, body: j }); });
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});
const cookieOf = (r) => String([].concat(r.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];
const valueOf = (c) => c.slice(c.indexOf('=') + 1);

/** 一条 SSE：攒下原文，按需解析成事件 */
const streams = [];
const openStream = (cookie) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events', headers: { host: PUB, cookie } }, (res) => {
    const s = { status: res.statusCode, raw: '', ended: false, close: () => req.destroy() };
    res.setEncoding('utf8');
    res.on('data', (c) => { s.raw += c; });
    res.on('end', () => { s.ended = true; });
    res.on('error', () => { s.ended = true; });
    res.on('close', () => { s.ended = true; });
    streams.push(s); resolve(s);
  });
  req.on('error', reject); req.end();
});
const events = (s) => s.raw.split('\n\n').map((b) => ({ ev: /^event: (.+)$/m.exec(b)?.[1] ?? null, data: /^data: (.+)$/m.exec(b)?.[1] ?? null }))
  .filter((e) => e.ev).map((e) => ({ ev: e.ev, data: e.data ? JSON.parse(e.data) : null }));
const rowsOf = (s) => events(s).filter((e) => e.ev === 'change').flatMap((e) => e.data?.rows ?? []);
const saw = (s, pred) => rowsOf(s).some(pred);
const pings = (s) => (s.raw.match(/^: ping$/gm) ?? []).length;

const secrets = [];   // [名字, 明文, 允许出现的文件（相对 home）]
try {
  section('① 登录：各用各的令牌换会话；邀请进来的拿到 cookie + 一次性命令行令牌');
  let r = await call('POST', '/api/login', { body: { token: FAKE_LOGIN } });
  eq(r.status, 401, '假令牌登录 → 401');
  r = await call('POST', '/api/login', { body: { token: owner.plaintext } });
  const A = cookieOf(r);
  r = await call('POST', '/api/login', { body: { token: owner.plaintext } });
  const A2 = cookieOf(r);   // 同一个人的第二个页面（另一台电脑 / 另一个浏览器）
  r = await call('POST', '/api/login', { body: { token: alice.plaintext } });
  const B = cookieOf(r);
  assert(/^si_token=/.test(A) && /^si_token=/.test(B) && A !== A2, '每次登录一枚新的会话 cookie（同一个人两个页面是两枚）');
  assert(![A, A2, B].some((c) => [owner.plaintext, alice.plaintext].includes(valueOf(c))), 'cookie 里是会话令牌，不是长期令牌');
  eq([(await call('GET', '/api/me', { cookie: A })).body.id, (await call('GET', '/api/me', { cookie: B })).body.id], [owner.userId, alice.userId], '两枚 cookie 各认各的人');

  r = await call('POST', '/api/invites', { cookie: A, body: { role: 'member', name: '乙' } });
  const code = decodeURIComponent(new URL(r.body.link).searchParams.get('invite'));
  assert(r.status === 200 && code, '管理员经 HTTP 发邀请');
  r = await call('GET', `/api/invites/peek?code=${encodeURIComponent(code)}`);
  eq([r.status, r.body.role], [200, 'member'], '邀请链接能看（角色）');
  r = await call('POST', '/api/invites/accept', { body: { code } });
  const C = cookieOf(r), bobCli = r.body.cliToken, bobId = r.body.userId;
  assert(r.status === 200 && /^si_token=/.test(C) && bobCli, '乙接受邀请：会话 cookie + 一次性命令行令牌');
  secrets.push(['会话 A', valueOf(A)], ['会话 A2', valueOf(A2)], ['会话 B', valueOf(B)], ['会话 C', valueOf(C)],
    ['管理员长期令牌', owner.plaintext], ['甲长期令牌', alice.plaintext], ['乙命令行令牌', bobCli], ['邀请码', code], ['登录失败的假令牌', FAKE_LOGIN]);

  section('② 三条 SSE：看得见的人收到，看不见的收不到');
  const sA = await openStream(A), sB = await openStream(B), sC = await openStream(C);
  assert(await until(() => [sA, sB, sC].every((s) => events(s)[0]?.ev === 'hello')), '三条流都连上、先收 hello');
  eq([sA.status, sB.status, sC.status], [200, 200, 200], '三条流都是 200');
  eq((await openStream('si_token=' + FAKE_LOGIN)).status, 401, '假 cookie 开流 → 401');

  const nProj = db.one(`SELECT count(*) n FROM projects`).n;
  r = await call('POST', '/api/projects', { cookie: A, body: { goal: 'x', doneDefinition: 'y', empty: true, visibility: 'secret' } });
  eq([r.status, db.one(`SELECT count(*) n FROM projects`).n], [400, nProj], '可见性写错 → 400，项目没建');
  r = await call('POST', '/api/projects', { cookie: A, body: { goal: `做一个小工具（部署用的令牌是 ${GH}）`, doneDefinition: '能跑', empty: true, title: '仅成员项目', visibility: 'members' } });
  const P1 = r.body.result?.projectId, T1 = r.body.result?.firstTaskId;
  assert(r.status === 200 && P1 && T1, '管理员经 HTTP 建项目：建的时候就定为仅成员可见（目标里贴了一枚令牌）', r.body);
  eq(db.one(`SELECT visibility FROM projects WHERE id=?`, P1).visibility, 'members', '库里是仅成员可见');
  r = await call('POST', `/api/projects/${P1}/member`, { cookie: A, body: { userId: alice.userId, canAddTasks: false } });
  eq(r.status, 200, '把甲加进项目成员');
  assert(await until(() => saw(sA, (x) => x.action === 'project_created' && x.target_id === P1)), '管理员的流收到「建了项目」');
  assert(await until(() => saw(sB, (x) => x.target_id === P1 && /member/.test(x.action))), '甲的流收到「加进成员」那一行（加进去之后他看得见了）');
  r = await call('POST', '/api/projects', { cookie: C, body: { goal: '乙自己的小活', doneDefinition: '能跑', empty: true } });
  const P2 = r.body.result?.projectId, T2 = r.body.result?.firstTaskId;
  assert(r.status === 200 && T2, '乙也建一个自己的项目（下面拿它的任务地址试越权）', r.body);

  // agent 那一侧（不走 HTTP）：在 T1 上提一个指给甲的事项
  const Q = insertQuestion(db, { taskId: T1, level: 3, text: '用哪个数据库？' });
  applyRoute(db, Q, { decisionType: 'spec_choice', typeSource: 'hard_rule', quorum: null, conflictPolicy: 'block', addressedTo: [alice.userId], informed: [], route: null, routeDueAt: null });
  audit(db, { actorKind: 'agent', action: 'question_opened', targetType: 'question', targetId: Q, payload: {} });
  assert(await until(() => saw(sA, (x) => x.target_id === Q) && saw(sB, (x) => x.target_id === Q)), '管理员与甲的流都收到这个事项');
  const pc = pings(sC);
  await until(() => pings(sC) > pc + 2, 2000);
  assert(!saw(sC, (x) => [Q, T1, P1].includes(x.target_id)), '乙的流里没有这个项目的任何一行，建项目那几行也没有（原来只能建好再改可见性，这之间全员收得到）', rowsOf(sC).filter((x) => [Q, T1, P1].includes(x.target_id)));
  eq((await call('GET', `/api/tasks/${T1}`, { cookie: C })).status, 404, '乙拉这个任务 → 404');
  r = await call('GET', '/api/tasks', { cookie: C });
  assert(!JSON.stringify(r.body).includes(T1) && JSON.stringify(r.body).includes(T2), '乙的任务列表里只有自己的');

  section('③ 甲经 HTTP 答复；乙借自己的任务地址够别人的事项 → 404');
  r = await call('POST', `/api/tasks/${T2}/say`, { cookie: C, body: { body: '顺便看看', kind: 'context', about: Q } });
  eq(r.status, 404, '乙在自己的任务上发消息、about 指向甲那边的事项 → 404（原来留言会挂到看不见的项目的事项下）');
  r = await call('POST', `/api/tasks/${T2}/answer`, { cookie: C, body: { questionId: Q, body: '用 SQLite' } });
  eq(r.status, 404, '乙经自己的任务地址答复甲那边的事项 → 404');
  assert(!JSON.stringify(r.body).includes('甲'), '报错里不说该谁答（原来会列出接收人的名字）');
  r = await call('POST', `/api/tasks/${T2}/answer`, { cookie: C, body: { questionId: 'q_nope', body: 'x' } });
  eq(r.status, 404, '不存在的事项也是同一个 404（看不出在不在）');
  const R1 = newId('r');
  db.run(`INSERT INTO reports (id,task_id,trigger,since_ts,summary,body,facts,generated_by,created_at) VALUES (?,?,'node_done',?,'s','b','{}','template',?)`, R1, T1, now(), now());
  r = await call('POST', `/api/tasks/${T2}/reportsRead`, { cookie: C, body: { ids: [R1] } });
  eq([r.status, db.one(`SELECT read_at FROM reports WHERE id=?`, R1).read_at], [200, null], '乙经自己的任务地址标甲那边的报告已读 → 不生效（原来任意 id 都标）');
  r = await call('POST', `/api/tasks/${T1}/reportsRead`, { cookie: B, body: { ids: [R1] } });
  assert(r.status === 200 && db.one(`SELECT read_at FROM reports WHERE id=?`, R1).read_at, '甲在自己看得见的任务上标已读 → 生效（原来路由只认小写，reportsRead 一直 404）', r.body);
  eq(db.one(`SELECT count(*) n FROM answers WHERE question_id=?`, Q).n, 0, '库里那个事项下一条都没多');

  r = await call('POST', `/api/tasks/${T1}/answer`, { cookie: B, body: { questionId: Q, body: `用 Postgres，连接串里的 key 是 ${SK}` } });
  eq(r.status, 200, '甲经 HTTP 答复指给他的事项', r.body);
  assert(await until(() => saw(sA, (x) => x.target_id === Q && x.action !== 'question_opened')), '管理员的流收到答复那一行');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, Q).status, 'answered', '事项已答');
  r = await call('POST', `/api/tasks/${T1}/say`, { cookie: B, body: { body: `推送用这个：${GH2}`, kind: 'context' } });
  eq(r.status, 200, '甲在任务上补一句（贴了令牌）', r.body);
  assert(await until(() => saw(sA, (x) => x.action === 'message_received' || (x.target_id === T1 && /message/.test(x.action)))), '管理员的流收到这条消息');

  section('④ 同一个人两个页面：拿同一个版本号改决策路由，后到的 409');
  const v = (await call('GET', `/api/routing?project=${P1}`, { cookie: A })).body.version;
  eq((await call('GET', `/api/routing?project=${P1}`, { cookie: A2 })).body.version, v, '两个页面读到同一个版本');
  const duty = { project: P1, action: 'duty', version: v, users: [owner.userId, alice.userId], startDay: '2026-11-02', startTime: '10:00', periodDays: 7 };
  r = await call('POST', '/api/routing', { cookie: A, body: duty });
  eq(r.status, 200, '页面一先存', r.body);
  r = await call('POST', '/api/routing', { cookie: A2, body: { ...duty, users: [alice.userId] } });
  eq(r.status, 409, '页面二拿旧版本号再存 → 409（不静默覆盖）', r.body);

  section('⑤ 连接与服务商密钥：明文只给一次，之后谁拉都没有');
  r = await call('POST', '/api/connections', { cookie: A, body: { action: 'add', kind: 'token', name: '自建 Gitea', host: 'git.example.com', secret: CRED } });
  assert(r.status === 200 && !JSON.stringify(r.body).includes(CRED), '管理员经 HTTP 录入连接：回包里没有明文', r.body);
  for (const [who, c] of [['管理员', A], ['甲', B]]) assert(!JSON.stringify((await call('GET', '/api/connections', { cookie: c })).body).includes(CRED), `${who}拉连接列表：没有明文`);
  const llm = (await call('GET', '/api/llm', { cookie: A })).body;
    const ep = llm.endpoints?.[0]?.id;
  r = await call('POST', '/api/llm', { cookie: A, body: { action: 'key_set', id: ep, value: KEY } });
  assert(r.status === 200 && r.body.result?.present && !JSON.stringify(r.body).includes(KEY), `存服务商密钥（${ep}）：回包里没有明文`, r.body);
  assert(!JSON.stringify((await call('GET', '/api/llm', { cookie: A })).body).includes(KEY), '再拉服务商：没有明文');
  secrets.push(['GH', GH], ['GH2', GH2], ['SK', SK], ['CRED', CRED], ['KEY', KEY, ['.env']]);

  section('⑥ 吊销与退出：被吊销的那条流收到 revoked 并断开，别人的照常');
  r = await call('POST', '/api/admin/tokens/revoke', { cookie: A, body: { userId: alice.userId } });
  eq(r.status, 200, '管理员吊销甲的全部令牌');
  assert(await until(() => events(sB).some((e) => e.ev === 'revoked') && sB.ended), '甲的流收到 revoked 并断开');
  eq((await call('GET', '/api/me', { cookie: B })).status, 401, '甲的 cookie 失效');
  assert(!sA.ended && !sC.ended, '管理员与乙的流还开着');
  audit(db, { actorKind: 'system', action: 'e2e_ping', targetType: 'system', targetId: 'x', payload: {} });
  assert(await until(() => saw(sA, (x) => x.action === 'e2e_ping') && saw(sC, (x) => x.action === 'e2e_ping')), '之后的推送管理员与乙照常收到');
  r = await call('POST', '/api/logout', { cookie: A, body: {} });
  eq(r.status, 200, '管理员在页面一退出', r.body);
  assert(await until(() => events(sA).some((e) => e.ev === 'revoked') && sA.ended), '页面一的流收到 revoked 并断开');
  eq([(await call('GET', '/api/me', { cookie: A })).status, (await call('GET', '/api/me', { cookie: A2 })).status], [401, 200], '退出只退这一个会话：页面二还在');
} finally {
  for (const s of streams) s.close();
  await w.close();
}

section('⑦ 假令牌全流程不落盘：扫 home 下每个文件');
db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
const files = [];
const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f) : files.push(f); } };
walk(HOME);
const leaks = [];
let gitObjs = 0;
for (const f of files) {
  const rel = f.slice(HOME.length + 1).split(sep).join('/');
  let buf = readFileSync(f);
  // git 松散对象是 zlib 压缩的，直接扫看不见；解开再扫
  if (/\.git\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/.test(rel)) { try { buf = inflateSync(buf); gitObjs++; } catch { /* 不是对象 */ } }
  for (const [what, val, allowed = []] of secrets) if (buf.includes(Buffer.from(val)) && !allowed.includes(rel)) leaks.push(`${rel}: ${what}`);
}
assert(files.length >= 3, `扫了 ${files.length} 个落盘文件（其中 git 对象 ${gitObjs} 个）`);
eq(leaks, [], `${secrets.length} 枚假令牌 / 会话令牌，home 下任何文件里都找不到（服务商密钥只许在 .env）`);
assert(readFileSync(join(HOME, '.env'), 'utf8').includes(KEY), '服务商密钥确实写进了 .env（对照：扫描本身有效）');

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
