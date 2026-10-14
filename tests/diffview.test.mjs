// 改动对比（core/diffview.mjs + 两个接口）：直接取自代码的增删，任务口径与交付口径。
//
// 跑：node tests/diffview.test.mjs
//
// 真 git 仓库，不打桩：解析的是 git 自己吐出来的统一格式，包括改名、删除、生成物、超大文件。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, audit } from '../src/db/db.mjs';
import { createProject } from '../src/core/project.mjs';
import { addUser, reissueToken } from '../src/core/users.mjs';
import { disableUser } from '../src/core/handover.mjs';
import { setVisibility } from '../src/core/project-members.mjs';
import { parseGitDiff, taskRange, deliveryRange, viewOf, linesOf, DIFF_LIMITS, rangeFor, roundSinceOf } from '../src/core/diffview.mjs';
import { setParam } from '../src/core/params.mjs';
import { signoffAnswer } from '../src/core/answers.mjs';
import { startWeb } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e !== undefined ? `\n         ${typeof e === 'string' ? e : JSON.stringify(e)}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (t) => console.log(`\n── ${t}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-diffview-'));
const HOME = join(TMP, 'home'); mkdirSync(HOME);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitc = (cwd, ...a) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
const lines = (n, p = 'line') => Array.from({ length: n }, (_, i) => `${p} ${i + 1}`).join('\n') + '\n';

const SRC = join(TMP, 'src'); mkdirSync(SRC);
git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'a.txt'), lines(30));
writeFileSync(join(SRC, 'b.txt'), 'to be deleted\n');
writeFileSync(join(SRC, 'd.txt'), lines(20, 'same'));
writeFileSync(join(SRC, 'README.md'), '# demo\n');
gitc(SRC, 'add', '.'); gitc(SRC, 'commit', '-q', '-m', 'init');

const db = openDb(join(HOME, 'state.db'));
const owner = ensureOwner(db);
const P = createProject(db, { userId: owner.userId, spec: { title: 'dv', tasks: [{ title: 'T1', goal: 'g', definition_of_done: 'd', verify_command: 'node a.mjs' }] }, source: SRC, home: HOME });
const tid = P.taskIds[0];
const WS = join(HOME, 'workspaces', tid);

// 任务在工作区里的改动：两处改（隔得远 → 两个 hunk）、删一个、加一个、改名一个、一个锁文件、一个超大文件
writeFileSync(join(WS, 'a.txt'), lines(30).replace('line 5\n', 'LINE five\n').replace('line 25\n', 'line 25 changed\nline 25b\n'));
rmSync(join(WS, 'b.txt'));
writeFileSync(join(WS, 'c.txt'), 'new file\n');
git(WS, 'mv', 'd.txt', 'e.txt');
writeFileSync(join(WS, 'package-lock.json'), '{\n  "lockfileVersion": 3\n}\n');
writeFileSync(join(WS, 'big.txt'), lines(DIFF_LIMITS.fileLines + 10, 'big'));
gitc(WS, 'add', '-A'); gitc(WS, 'commit', '-q', '-m', 'work');

section('1 · 任务口径：接手时的代码 → 任务头');
const range = taskRange(db, { taskId: tid, home: HOME });
assert(range.ok, '取得到区间', range.reason);
const v = viewOf(range);
const by = Object.fromEntries((v.files ?? []).map((f) => [f.path, f]));
eq(Object.keys(by).sort(), ['a.txt', 'b.txt', 'big.txt', 'c.txt', 'e.txt', 'package-lock.json'], '六个文件都在（改名只算一个，按新名字）');
eq([by['a.txt'].status, by['b.txt'].status, by['c.txt'].status, by['e.txt'].status], ['modified', 'deleted', 'added', 'renamed'], '状态：改 / 删 / 加 / 改名');
eq(by['e.txt'].oldPath, 'd.txt', '改名带着原名');
eq(by['a.txt'].hunks.length, 2, '隔得远的两处改动 → 两段');
eq([by['a.txt'].adds, by['a.txt'].dels], [3, 2], 'a.txt +3 −2');
eq([by['a.txt'].hunks[0].oldStart, by['a.txt'].hunks[0].newStart], [2, 2], '第一段从第 2 行起（前后各 3 行上下文）');
eq(by['a.txt'].hunks[0].lines.filter((l) => l[0] !== ' ').map((l) => l.join('')), ['-line 5', '+LINE five'], '增删行原样，带标记');
eq([by['a.txt'].total, by['c.txt'].total], [31, undefined], '改过的文件带新版本总行数（页面据此给"末尾还有几行"的确数）；新增的不需要');
eq([by['package-lock.json'].omitted, by['package-lock.json'].hunks.length], ['generated', 0], '锁文件：只给行数');
eq([by['big.txt'].omitted, by['big.txt'].adds], ['too_large', DIFF_LIMITS.fileLines + 10], '超大文件：只给行数，行数照实');
eq([v.adds, v.dels], [3 + 1 + 3 + DIFF_LIMITS.fileLines + 10, 2 + 1], '总增删');

section('2 · 展开未改动的行：只取这次改过的文件');
const g = linesOf(range, { path: 'a.txt', from: 9, to: 21 });
eq([g.ok, g.lines.length, g.lines[0], g.lines.at(-1)], [true, 13, 'line 9', 'line 21'], 'hunk 之间那一段原样取出（新版本的行号）');
const tail = linesOf(range, { path: 'a.txt', from: 30, to: null });
eq(tail.lines, ['line 29', 'line 30'], '到文件末尾（新版本多了一行，所以第 30 行是原来的 29）');
eq(linesOf(range, { path: 'README.md', from: 1 }).ok, false, '没改过的文件不给读（不是任意读仓库）');
eq(linesOf(range, { path: '../../state.db', from: 1 }).ok, false, '路径穿越不给读');

section('3 · 解析：git 的边角格式');
const parsed = parseGitDiff('diff --git a/x y.txt b/x y.txt\r\nindex 1..2 100644\r\n--- a/x y.txt\r\n+++ b/x y.txt\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n\\ No newline at end of file\r\n');
eq([parsed[0].path, parsed[0].hunks[0].lines], ['x y.txt', [['-', 'a'], ['+', 'b']]], '带空格的路径、CRLF、"No newline" 提示不算内容');
eq(parseGitDiff('diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n')[0].binary, true, '二进制文件标出来');

section('4 · 交付口径：项目仓库里这个任务合并进来的那一段');
git(P.repo, 'fetch', '-q', WS, `HEAD:refs/heads/tmp-${tid}`);
gitc(P.repo, 'checkout', '-q', P.branch);
gitc(P.repo, 'merge', '-q', '--no-ff', '-m', 'merge T1', `tmp-${tid}`);
const merged = git(P.repo, 'rev-parse', 'HEAD');
audit(db, { actorKind: 'system', action: 'project_task_merged', targetType: 'project', targetId: P.projectId, payload: { taskId: tid, head: merged, order: 1 } });
const dv = viewOf(deliveryRange(db, { projectId: P.projectId, taskId: tid }));
eq([dv.ok, dv.files?.length, dv.adds, dv.dels], [true, 6, v.adds, v.dels], '与任务口径同一份改动');
eq(deliveryRange(db, { projectId: P.projectId, taskId: 't_nope' }).ok, false, '没合并的任务说"还没合并"，不给空 diff');

section('5 · 接口：可见性先过，看不见的人拿不到代码');
const fe = addUser(db, { name: '前端', role: 'member', byUserId: owner.userId });
const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100 });
const base = `http://127.0.0.1:${w.port}`;
const getAs = (tok, p) => fetch(base + p, { headers: tok ? { 'x-superintern-token': tok } : {} }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
try {
  let r = await getAs(owner.plaintext, `/api/tasks/${tid}/diff`);
  eq([r.status, r.ok, r.files?.length], [200, true, 6], '负责人：任务改动');
  r = await getAs(owner.plaintext, `/api/tasks/${tid}/diff_lines?path=a.txt&from=9&to=10`);
  eq(r.lines, ['line 9', 'line 10'], '负责人：展开未改动');
  r = await getAs(owner.plaintext, `/api/projects/${P.projectId}/diff/${tid}`);
  eq([r.status, r.files?.length], [200, 6], '负责人：交付页按任务的改动');
  setVisibility(db, { projectId: P.projectId, visibility: 'members', by: owner.userId });
  for (const p of [`/api/tasks/${tid}/diff`, `/api/tasks/${tid}/diff_lines?path=a.txt&from=1`, `/api/projects/${P.projectId}/diff/${tid}`, `/api/tasks/${tid}/log`, `/api/tasks/${tid}/report?id=x`]) {
    r = await getAs(fe.plaintext, p);
    eq(r.status, 404, `项目只对成员可见时，无关成员拿不到：${p.replace(tid, '<任务>').replace(P.projectId, '<项目>')}`);
  }
  // 写接口同样先过可见性（原来只查 GET，看不见任务的人照样能给它发指令 / 暂停 / 签收）
  const postAs = (tok, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-superintern-token': tok }, body: JSON.stringify(body) })
    .then(async (x) => ({ status: x.status, ...(await x.json()) }));
  for (const [action, body] of [['say', { body: '改成蓝色', kind: 'instruction' }], ['pause', {}], ['signoff', { accept: true }]]) {
    r = await postAs(fe.plaintext, `/api/tasks/${tid}/${action}`, body);
    eq(r.status, 404, `无关成员 POST ${action} → 404（不泄露任务存在）`);
  }
  eq(db.one(`SELECT count(*) n FROM messages WHERE task_id=? AND body='改成蓝色'`, tid).n, 0, '那条指令没有落库');
  // 实时推送：看不见的任务的审计行不推给他（原来动作 + 对象 id 广播给所有连着的人）
  const sse = async (tok) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { 'x-superintern-token': tok }, signal: ac.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    return { ac, async rowsWithin(ms) {
      const until = Date.now() + ms; const rows = [];
      while (Date.now() < until) {
        const chunk = await Promise.race([reader.read(), new Promise((r2) => setTimeout(() => r2({ timeout: true }), until - Date.now()))]);
        if (chunk.timeout || chunk.done) break;
        buf += dec.decode(chunk.value);
        for (const m of buf.matchAll(/event: change\ndata: (.*)\n\n/g)) rows.push(...JSON.parse(m[1]).rows);
        buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      }
      return rows;
    } };
  };
  const sFe = await sse(fe.plaintext), sOwner = await sse(owner.plaintext);
  await new Promise((r2) => setTimeout(r2, 150));
  audit(db, { actorKind: 'system', action: 'sse_probe', targetType: 'task', targetId: tid });
  const [rowsFe, rowsOwner] = await Promise.all([sFe.rowsWithin(800), sOwner.rowsWithin(800)]);
  sFe.ac.abort(); sOwner.ac.abort();
  assert(rowsOwner.some((x) => x.action === 'sse_probe' && x.target_id === tid), '负责人收到这条审计行');
  assert(!rowsFe.some((x) => x.target_id === tid), '看不见项目的成员收不到');

  // 吊销 / 停用即断（2026-10-12）：原来身份只在建连时认一次，令牌吊销后开着的页面照收推送
  const watch = async (tok) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { 'x-superintern-token': tok }, signal: ac.signal });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let text = '';
    const ended = (async () => { for (;;) { const c = await reader.read().catch(() => ({ done: true })); if (c.done) return true; text += dec.decode(c.value); } })();
    return { ac, ended, text: () => text };
  };
  const reissued = addUser(db, { name: '后端', role: 'member', byUserId: owner.userId });
  const toDisable = addUser(db, { name: '测试', role: 'member', byUserId: owner.userId });
  const wR = await watch(reissued.plaintext), wD = await watch(toDisable.plaintext), wO = await watch(owner.plaintext);
  await new Promise((r2) => setTimeout(r2, 250));
  const t0 = Date.now();
  reissueToken(db, { userId: reissued.userId, byUserId: owner.userId });   // 旧令牌作废
  disableUser(db, { userId: toDisable.userId, byUserId: owner.userId });  // 人被停用（令牌一并吊销）
  const timeout = (ms) => new Promise((r2) => setTimeout(() => r2(false), ms));
  const [endR, endD] = await Promise.all([Promise.race([wR.ended, timeout(2000)]), Promise.race([wD.ended, timeout(2000)])]);
  assert(endR && /event: revoked/.test(wR.text()), `令牌被重发（旧令牌吊销）→ 开着的推送收到 revoked 并断开（${Date.now() - t0} ms 内）`);
  assert(endD && /event: revoked/.test(wD.text()), '人被停用 → 开着的推送收到 revoked 并断开');
  audit(db, { actorKind: 'system', action: 'sse_after_revoke', targetType: 'user', targetId: owner.userId });
  await new Promise((r2) => setTimeout(r2, 300));
  assert(!/sse_after_revoke/.test(wR.text() + wD.text()), '断开之后的变化不会再推给他们');
  assert(/sse_after_revoke/.test(wO.text()) && !/event: revoked/.test(wO.text()), '没被吊销的人照常收、不受影响');
  wO.ac.abort(); wR.ac.abort(); wD.ac.abort();
} finally { await w.close?.(); }

section('6 · 这一轮（返工签收）：上次请求签收时的头 → 现在，集成带进来的单列');
{
  const firstHead = git(WS, 'rev-parse', 'HEAD');
  setParam(db, { taskId: tid, key: 'signoff.head', value: firstHead, by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  setParam(db, { taskId: tid, key: 'signoff.since', value: null, by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  eq(roundSinceOf(db, tid), null, '第一次签收：没有"这一轮"');
  eq(rangeFor(db, { taskId: tid, home: HOME }).via === 'round', false, '不给口径 → 全部');
  // 别的任务合进了项目分支；这个任务返工时把项目分支集成进来，再改了一处
  gitc(P.repo, 'checkout', '-q', P.branch);
  writeFileSync(join(P.repo, 'other.txt'), 'from another task\n');
  gitc(P.repo, 'add', '.'); gitc(P.repo, 'commit', '-q', '-m', 'T2 merged');
  git(WS, 'fetch', '-q', P.repo, `${P.branch}:refs/remotes/pj/main`);
  gitc(WS, 'merge', '-q', '--no-edit', 'refs/remotes/pj/main');
  writeFileSync(join(WS, 'c.txt'), 'new file\nreworked\n');
  gitc(WS, 'add', '-A'); gitc(WS, 'commit', '-q', '-m', 'rework');
  setParam(db, { taskId: tid, key: 'signoff.head', value: git(WS, 'rev-parse', 'HEAD'), by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  setParam(db, { taskId: tid, key: 'signoff.since', value: firstHead, by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  eq(roundSinceOf(db, tid), firstHead, '返工：这一轮从上次请求签收时的头起');
  const rr = rangeFor(db, { taskId: tid, home: HOME });
  eq(rr.via, 'round', '不给口径、有返工那一轮 → 默认给这一轮');
  const rv = viewOf(rr);
  eq(rv.files.map((f) => f.path), ['c.txt'], '这一轮只列这个任务自己改的');
  eq(rv.brought, ['other.txt'], '集成带进来的别人的文件单列，不混进来');
  eq(viewOf(rangeFor(db, { taskId: tid, home: HOME, scope: 'all' })).files.some((f) => f.path === 'other.txt'), false, '全部：也不算别人的（归属基线是 merge-base）');
  eq(linesOf(rr, { path: 'other.txt', from: 1 }).ok, false, '这一轮的取行也不给别人的文件');
  // 老数据：没有 signoff.since 这一行，从 signoff.head 的历史里找
  // 那时的库也没有 params 的只增触发器（v16 重建时丢了、v23 补回），模拟老库就先拿掉它
  db.raw.exec(`DROP TRIGGER IF EXISTS trg_params_no_delete`);
  db.run(`DELETE FROM params WHERE task_id=? AND key='signoff.since'`, tid);
  eq(roundSinceOf(db, tid), firstHead, '老数据回退：从签收头历史里找上一个不同的头');
}

section('7 · 某一步：提交信息里 node: <id> 的那一个提交');
{
  writeFileSync(join(WS, 'step.txt'), 'step output\n');
  gitc(WS, 'add', '-A'); gitc(WS, 'commit', '-q', '-m', '做一步\n\nnode: n_abc123\nhandoff: h_x');
  writeFileSync(join(WS, 'later.txt'), 'later\n');
  gitc(WS, 'add', '-A'); gitc(WS, 'commit', '-q', '-m', '后面一步\n\nnode: n_def456\nhandoff: h_y');
  const nv = viewOf(rangeFor(db, { taskId: tid, home: HOME, scope: 'node', node: 'n_abc123' }));
  eq([nv.ok, nv.files.map((f) => f.path), nv.times], [true, ['step.txt'], 1], '只给这一步那个提交的改动');
  eq(rangeFor(db, { taskId: tid, home: HOME, scope: 'node', node: 'n_nothere' }).ok, false, '没有提交的步骤说没有，不给空 diff');
  eq(rangeFor(db, { taskId: tid, home: HOME, scope: 'node', node: 'x; rm -rf' }).ok, false, '步骤编号不合形状 → 拒');
}

section('8 · 签收答复归一：封闭的答案空间在入口收紧');
{
  eq(['A', '(A)', 'a', '（A）', 'A 没问题', '接受', 'accept', '接受，辛苦了'].map(signoffAnswer),
    ['接受', '接受', '接受', '接受', '接受，没问题', '接受', 'accept', '接受，辛苦了'], '选项字母与"接受"都归一成接受（原来 A 会被当成以"A"为理由打回）');
  eq(['B：page 口径不对', '(B) 缺文档', '打回：还差测试', '打回 还差测试', 'reject: missing docs'].map(signoffAnswer),
    ['打回：page 口径不对', '打回：缺文档', '打回：还差测试', '打回：还差测试', '打回：missing docs'], '打回带理由');
  for (const bad of ['B', '打回', '打回：', 'C', '(C)', '看起来不错', 'Also fine']) {
    let err = null; try { signoffAnswer(bad); } catch (e) { err = e.message; }
    assert(err, `拒收：「${bad}」→ ${err ?? '（没拒）'}`);
  }
}

db.close();
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上偶尔还占着 */ }
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
