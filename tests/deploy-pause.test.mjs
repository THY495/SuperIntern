// 部署级急停：管理员一键停下全部自动运行。
//   ① 启动器拒绝拉起（守护进程、看板「运行」、项目规划都走它）；
//   ② 编排器每轮开头读到就退出（任务状态不动），步骤跑到一半也在下一个工具调用轮停下（节点回 pending、不计重试、不当成撞上限去问人）；
//   ③ 守护进程暂停期间不拉、不推进、不扫停等账本（不把暂停误判成停摆）；解除后按退出类型自动接着拉；
//   ④ 状态落库，重启照样生效；
//   ⑤ 看板：所有人看到暂停状态，只有管理员能切换。
//
// 跑：node tests/deploy-pause.test.mjs

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { getSetting, setSetting } from '../src/core/settings.mjs';
import { makeLauncher } from '../src/core/launcher.mjs';
import { startDaemon, assessTask } from '../src/core/daemon.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { addUser } from '../src/core/users.mjs';
import { startWeb } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n── ${t}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-pause-'));
const HOME = join(TMP, 'home');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

const DBPATH = join(TMP, 'state.db');
const db = openDb(DBPATH);
const owner = ensureOwner(db);
const pause = (v) => setSetting(db, { key: 'deploy.paused', value: v, userId: owner.userId });

function mkTask(status = 'running') {
  const id = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'急停测试',?,?)`, id, owner.userId, status, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'写个文件','.','有文件','[]',?,?)`, newId('c'), id, t, t);
  const nid = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写文件','写 a.txt','a.txt 存在','pending','normal','standard',?)`, nid, id, t);
  const ws = join(HOME, 'workspaces', id);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'README.md'), '# x\n');
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't');
  git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init'); git(ws, 'checkout', '-q', '-b', 'v0/t');
  return { id, nid, ws };
}
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${name}_${Math.random()}`, name, args }], usage: { inputTokens: 1000, outputTokens: 20 } });
const lastExit = (taskId) => JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='orchestrator_exit' AND target_id=? ORDER BY id DESC LIMIT 1`, taskId)?.payload ?? '{}');

section('① 启动器：暂停时拒绝拉起，解除后照常');
{
  const kids = [];
  const launcher = makeLauncher(db, { home: HOME, spawnFn: () => { const c = { pid: 5000 + kids.length, exitCode: null, on() {} }; kids.push(c); return c; } });
  const { id } = mkTask();
  eq(getSetting(db, 'deploy.paused'), false, '默认不暂停');
  pause(true);
  let err = null; try { launcher.launch(id, { verb: 'run' }); } catch (e) { err = e; }
  assert(err && /暂停了全部自动运行/.test(err.message), '暂停时拉起被拒，报错说清楚怎么恢复', err?.message);
  eq(kids.length, 0, '一个子进程都没起');
  pause(false);
  launcher.launch(id, { verb: 'run' });
  eq(kids.length, 1, '解除后照常拉起');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='setting_set' AND target_id='deploy.paused'`).n, 2, '每次切换都进审计（谁、从什么到什么）');
}

section('② 编排器：每轮开头读到就退出；步骤跑到一半在下一轮停、不计重试、不去问人');
{
  const { id, nid, ws } = mkTask();
  pause(true);
  const r = await orchestrate(db, { taskId: id, workspace: ws, narrativeDir: join(TMP, 'narr1'), verify: false, maxCycles: 2,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([]) }) });   // 空脚本：一旦去调模型就会炸
  eq(r.kind, 'deploy_paused', '开头就退出，退出类型单列');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, id).status, 'running', '任务状态不动（不是人按的暂停，不改成 suspended）');
  pause(false);

  // 跑到一半：第一次工具调用之后管理员按了暂停
  const t2 = mkTask();
  let paused = false;
  const r2 = await orchestrate(db, { taskId: t2.id, workspace: t2.ws, narrativeDir: join(TMP, 'narr2'), verify: false, maxCycles: 2,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([call('list_dir', { path: '.' }), call('list_dir', { path: '.' }), call('list_dir', { path: '.' })]) }),
    onEvent: (e) => { if (e.type === 'step' && !paused) { paused = true; pause(true); } } });
  eq(r2.kind, 'deploy_paused', '步骤跑到一半也停');
  const n = db.one(`SELECT status, retry_count FROM nodes WHERE id=?`, t2.nid);
  eq([n.status, n.retry_count], ['pending', 0], '节点回 pending、不计重试');
  eq(db.one(`SELECT count(*) n FROM questions WHERE task_id=?`, t2.id).n, 0, '没有被当成撞上限去问人');
  eq(lastExit(t2.id).kind, 'deploy_paused', '退出审计写的是 deploy_paused（守护进程据此接着拉）');
  pause(false);
}

section('③ 守护进程：暂停期间不拉、不扫停等账本；解除后自动接着拉');
{
  const { id } = mkTask();
  audit(db, { actorKind: 'system', action: 'orchestrator_started', targetType: 'task', targetId: id, payload: { pid: 4242 } });
  audit(db, { actorKind: 'system', action: 'orchestrator_exit', targetType: 'task', targetId: id, payload: { pid: 4242, kind: 'deploy_paused' } });
  const kids = [], events = [];
  const launcher = makeLauncher(db, { home: HOME, spawnFn: () => { const c = { pid: 6000 + kids.length, exitCode: null, on() {} }; kids.push(c); return c; } });
  const d = startDaemon(db, { home: HOME, launcher, intervalMs: 3600_000, alive: () => false, runtime: null, onEvent: (e) => events.push(e) });
  try {
    pause(true);
    let r = await d.tick();
    assert(r && r.paused === true, '这一轮报告处于暂停');
    eq([r.launched.length, r.liveness], [0, null], '不拉起、不扫停等账本');
    assert(r.swept && Array.isArray(r.swept.defaulted), '超时扫描照常（那是给人的，不花模型钱）');
    await d.tick();
    eq(events.filter((e) => e.type === 'deploy_paused').length, 1, '进入暂停只报一次');
    pause(false);
    eq(assessTask(db, db.one(`SELECT id, status FROM tasks WHERE id=?`, id), { alive: () => false }).reason, 'run:resume_after_deploy_pause', '因急停退出的任务：解除后判为该接着跑');
    r = await d.tick();
    assert(r.launched.some((l) => l.taskId === id), '解除后的第一轮就把它拉起来了');
    eq(events.filter((e) => e.type === 'deploy_resumed').length, 1, '解除报一次');
  } finally { d.stop(); }
}

section('④ 状态落库：重启照样生效');
{
  pause(true);
  db.close();
  const db2 = openDb(DBPATH);
  eq(getSetting(db2, 'deploy.paused'), true, '重开库仍是暂停');
  setSetting(db2, { key: 'deploy.paused', value: false, userId: owner.userId });
  db2.close();
}

section('⑤ 看板：所有人看到暂停状态，只有管理员能切换');
{
  const db3 = openDb(DBPATH);
  const member = addUser(db3, { name: '成员', role: 'member', byUserId: owner.userId });
  setSetting(db3, { key: 'deploy.paused', value: true, userId: owner.userId });
  const w = await startWeb(db3, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100 });
  const base = `http://127.0.0.1:${w.port}`;
  const get = (tok) => fetch(`${base}/api/tasks`, { headers: { 'x-superintern-token': tok } }).then((r) => r.json());
  const post = (tok, body) => fetch(`${base}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-superintern-token': tok }, body: JSON.stringify(body) }).then((r) => r.status);
  try {
    const m = await get(member.plaintext), o = await get(owner.plaintext);
    eq([m.paused, m.isAdmin], [true, false], '成员：看得到暂停，不是管理员');
    eq([o.paused, o.isAdmin], [true, true], '管理员：看得到暂停，有开关');
    eq(await post(member.plaintext, { action: 'setting', key: 'deploy.paused', value: false }), 403, '成员切换 → 403');
    eq(getSetting(db3, 'deploy.paused'), true, '仍是暂停');
    eq(await post(owner.plaintext, { action: 'setting', key: 'deploy.paused', value: false }), 200, '管理员切换 → 成功');
    eq(getSetting(db3, 'deploy.paused'), false, '已解除');
  } finally { await w.close?.(); db3.close(); }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
