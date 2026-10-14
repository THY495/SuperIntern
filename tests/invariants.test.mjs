// 运行期不变量。每条不变量一组：成立时不报、违反时报得出来、报出的事实对。
//   ① 停等：说不出在等谁的、挂了事项还没处理的；急停时跳过
//   ② 投影漂移：状态绕过状态机被改、库层护栏少了；第一次查时就在的记作基线
//   ③ 执行器可达路径：工作区罩住数据目录 / 库 / 主密钥；建工作区时就拒
//   ④ 预算：越过上限（留容差）却没有闸门记录；有了闸门 / 改过上限再越过
//   ⑤ 租约：持有者死了还久挂着的、任务结束了还占着不续的；两分钟内自己会失效的不报
//   ⑥ 扫描：按周期、从对到错 / 从错到对各一条审计、一条查炸了不连累别的
//   ⑦ 给人看的：健康卡一项、通知、守护进程通知管理员且不重复
//
// 跑：node tests/invariants.test.mjs

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { transition } from '../src/db/state.mjs';
import { assessTask, startDaemon } from '../src/core/daemon.mjs';
import { sweepLiveness, UNKNOWN_GRACE_MS } from '../src/core/liveness.mjs';
import { INVARIANTS, sweepInvariants, invariantsView, invariantLine, BUDGET_SLACK } from '../src/core/invariants.mjs';
import { RECHECKS } from '../src/core/rechecks.mjs';
import { invariantsCheck, deploymentHealth } from '../src/core/deploy-health.mjs';
import { invariantNotice } from '../src/core/notify.mjs';
import { ensureWorkspace } from '../src/core/workspace.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { makeLauncher } from '../src/core/launcher.mjs';
import { saveModel } from '../src/llm/registry.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-inv-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const dead = () => false;
const assess = (d, t, o = {}) => assessTask(d, t, { alive: dead, hasWorkspace: () => true, ...o });
const fresh = (path = ':memory:') => { const db = openDb(path); const { userId } = ensureOwner(db); return { db, userId }; };
const mkTask = (db, userId, status = 'running', createdAt = now()) => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,?,?,?)`, id, userId, `任务 ${id}`, status, createdAt);
  return id;
};
const spend = (db, taskId, micro, ts = now()) => db.run(`INSERT INTO usage_ledger (task_id,role,model_tier,provider,model_id,input_tokens,output_tokens,micro_usd,billing,ts)
  VALUES (?,?,?,?,?,?,?,?,?,?)`, taskId, 'executor', 'standard', 'deepseek', 'deepseek/deepseek-flash', 1, 1, micro, 'computed', ts);
const run = (db, id, extra = {}) => { sweepInvariants(db, { force: true, only: [id], ...extra }); return invariantsView(db).find((r) => r.id === id); };

// ── ① ─────────────────────────────────────────────────────────────────────
section('① 停等：每个没结束的任务说得出在等谁');
{
  const { db, userId } = fresh();
  const at = now();
  const recent = mkTask(db, userId, 'suspended', at - 60_000);   // 刚动过：宽限期内
  let r = run(db, 'liveness', { at, assess });
  eq(r.violations, 0, '刚挂起的不算（宽限期内）');
  transition(db, 'tasks', recent, 'aborted');   // 下面看另一个
  const t = mkTask(db, userId, 'suspended', at - 10 * 3600_000);
  r = run(db, 'liveness', { at: at + UNKNOWN_GRACE_MS, assess });
  eq([r.violations, r.sample[0]?.ref, r.sample[0]?.state], [1, t, 'unreported'], '停了很久、说不出在等谁：报出来（还没挂事项）');
  sweepLiveness(db, { at: at + UNKNOWN_GRACE_MS, assess });
  r = run(db, 'liveness', { at: at + UNKNOWN_GRACE_MS + 1000, assess });
  eq([r.violations, r.sample[0]?.state, !!r.sample[0]?.questionId], [1, 'reported', true], '停等扫描挂了事项：仍算违反（人还没处理），标"已报"');
  assert(/已挂事项/.test(invariantLine('liveness', r.sample[0])), '命令行一行说清已经报给人了');
  setSetting(db, { key: 'deploy.paused', value: true, userId });
  r = run(db, 'liveness', { at: at + UNKNOWN_GRACE_MS + 2000, assess });
  eq([r.skipped, r.violations], ['paused', 0], '急停中：跳过（那时所有任务都"静止"是管理员的意思）');
  const noAssess = run(db, 'liveness', { at });
  eq(noAssess.skipped, 'paused', '跳过时不动违反状态');
}

section('①b 违反着的查得勤：任务恢复后一两分钟内消掉，不等下一个 10 分钟（多挂了 9 分钟）');
{
  const { db, userId } = fresh();
  const at = now();
  const t = mkTask(db, userId, 'suspended', at - 10 * 3600_000);
  sweepInvariants(db, { at, only: ['liveness'], assess });
  eq(invariantsView(db).find((r) => r.id === 'liveness').violations, 1, '到点查：违反');
  transition(db, 'tasks', t, 'aborted');
  const r1 = sweepInvariants(db, { at: at + 30_000, only: ['liveness'], assess });
  eq(r1.ran.length, 0, '不到 1 分钟不重查');
  const r2 = sweepInvariants(db, { at: at + 70_000, only: ['liveness'], assess });
  eq([r2.ran.join(','), r2.transitions.map((x) => x.to).join(',')], ['liveness', 'restored'], '违反着：1 分钟后重查，当拍恢复');
  const r3 = sweepInvariants(db, { at: at + 140_000, only: ['liveness'], assess });
  eq(r3.ran.length, 0, '恢复之后回到 10 分钟一查');
}

// ── ② ─────────────────────────────────────────────────────────────────────
section('② 投影漂移：状态绕过状态机、库层护栏少了；历史漂移记作基线');
{
  const { db, userId } = fresh();
  const t = mkTask(db, userId, 'planning');
  transition(db, 'tasks', t, 'running');
  let r = run(db, 'projection');
  assert(r.checked > 0 && r.violations === 0, `状态都经 transition()：成立（看了 ${r.checked} 个）`);
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, t);   // 合法的转换，库层触发器放行 —— 但没留审计
  r = run(db, 'projection');
  eq([r.violations, r.sample[0]?.ref, r.sample[0]?.status, r.sample[0]?.audited], [1, t, 'done', 'running'], '裸改状态（没审计）：报出状态与审计轨最后记的');
  transition(db, 'tasks', t, 'running');
  r = run(db, 'projection');
  eq(r.violations, 0, '经状态机再改一次：对上了');
  db.run(`DROP TRIGGER trg_params_no_delete`);
  r = run(db, 'projection');
  assert(r.violations === 1 && r.sample[0]?.kind === 'missing_trigger' && r.sample[0]?.ref === 'trg_params_no_delete', '护栏少了（v16 那类事）：报出是哪一个');

  // 基线：升级上来的老库，第一次查时就有漂移（v25 以前状态可以裸写）
  const { db: d2, userId: u2 } = fresh();
  const old = mkTask(d2, u2, 'planning');
  transition(d2, 'tasks', old, 'running');
  d2.run(`UPDATE tasks SET status='done' WHERE id=?`, old);
  d2.run(`DROP TRIGGER trg_params_no_delete`);
  r = run(d2, 'projection');
  eq([r.violations, r.baselined, r.sample[0]?.kind], [1, 1, 'missing_trigger'], '第一次查：历史漂移记作基线不报；护栏缺失不进基线、照报');
  const nw = mkTask(d2, u2, 'planning');
  transition(d2, 'tasks', nw, 'running');
  d2.run(`UPDATE tasks SET status='waiting' WHERE id=?`, nw);
  r = run(d2, 'projection');
  assert(r.violations === 2 && r.sample.some((v) => v.ref === nw) && !r.sample.some((v) => v.ref === old), '之后新出的漂移照报，基线里的仍不报');
}

// ── ③ ─────────────────────────────────────────────────────────────────────
section('③ 执行器可达路径与管理状态不相交');
{
  const home = join(TMP, 'deploy', 'home');
  const { db, userId } = fresh(join(home, 'state.db'));
  const okT = mkTask(db, userId), badT = mkTask(db, userId);
  const okWs = join(home, 'workspaces', okT);
  mkdirSync(okWs, { recursive: true });
  audit(db, { actorKind: 'system', action: 'workspace_created', targetType: 'task', targetId: okT, payload: { dir: okWs } });
  let r = run(db, 'executor_paths', { home });
  eq([r.checked, r.violations], [1, 0], '工作区在数据目录里面（默认位置）：成立 —— 罩住的是它自己，不是上级');
  const up = join(TMP, 'deploy');
  audit(db, { actorKind: 'system', action: 'workspace_created', targetType: 'task', targetId: badT, payload: { dir: up } });
  r = run(db, 'executor_paths', { home });
  assert(r.violations === 1 && r.sample[0].ref === badT && ['home', 'db', 'master_key'].every((w) => r.sample[0].exposes.includes(w)), `工作区是数据目录的上级：报出罩住了哪些（${r.sample[0]?.exposes}）`);
  eq(INVARIANTS.find((i) => i.id === 'executor_paths').level, 'bad', '这一条是"有问题"级');
  transition(db, 'tasks', badT, 'aborted');
  eq(run(db, 'executor_paths', { home }).violations, 0, '任务中止了：不再算');
  let err = null;
  try { ensureWorkspace(db, { taskId: newId('t'), dir: up, empty: true }); } catch (e) { err = e.message; }
  assert(/包含了系统自己的数据/.test(err ?? ''), '建工作区时就拒（--dir 指到数据目录的上级）');
  err = null;
  try { ensureWorkspace(db, { taskId: 't_fine', dir: join(home, 'workspaces', 't_fine'), empty: true }); } catch (e) { err = e.message; }
  eq(err, null, '默认位置照常能建');
  db.close();
}

// ── ④ ─────────────────────────────────────────────────────────────────────
section('④ 预算：越过上限却没有闸门记录');
{
  const { db, userId } = fresh();
  const t = mkTask(db, userId);
  const limit = 5_000_000;   // 默认任务上限 $5
  spend(db, t, limit);
  let r = run(db, 'budget');
  eq(r.violations, 0, '刚到上限：不算（闸门每轮判一次）');
  spend(db, t, limit * (BUDGET_SLACK.task - 1) + 1);
  r = run(db, 'budget');
  eq([r.violations, r.sample[0]?.scope, r.sample[0]?.ref], [1, 'task', t], `越过上限 ${BUDGET_SLACK.task} 倍还没有闸门记录：报`);
  audit(db, { actorKind: 'system', action: 'limit_breached', targetType: 'task', targetId: t, payload: { key: 'limit.budget_micro_usd', actual: limit * 1.5, limit } });
  eq(run(db, 'budget').violations, 0, '有了闸门记录：成立');
  audit(db, { actorKind: 'user', action: 'limit_set', targetType: 'task', targetId: t, payload: { key: 'limit.budget_micro_usd', value: limit } });
  eq(run(db, 'budget').violations, 1, '人改过上限之后又越过、没有新的闸门记录：再报');
  // 月度（部署）
  const { db: d2, userId: u2 } = fresh();
  setSetting(d2, { key: 'deploy.budget_usd_month', value: 1, userId: u2 });
  spend(d2, mkTask(d2, u2), 1_300_000);
  r = run(d2, 'budget');
  assert(r.violations === 1 && r.sample[0].scope === 'deployment', '部署月度预算越过 20% 没有闸门记录：报');
  assert(/整个部署本月/.test(invariantLine('budget', r.sample[0])), '命令行一行');
}

// ── ⑤ ─────────────────────────────────────────────────────────────────────
section('⑤ 租约：持有者得活着；结束的任务不该还被占着');
{
  const { db, userId } = fresh();
  const at = now();
  const lease = (resource, { pid, expiresIn, beatAgo = 0, host = hostname() }) => db.run(`INSERT INTO leases (resource, holder, pid, epoch, acquired_at, heartbeat_at, expires_at, meta) VALUES (?,?,?,1,?,?,?,'{}')`,
    resource, `${host}:${pid}:1`, pid, at - beatAgo, at - beatAgo, at + expiresIn);
  const t1 = mkTask(db, userId), t2 = mkTask(db, userId, 'done');
  lease(`task:${t1}`, { pid: 4001, expiresIn: 100_000 });                        // 死了，但两分钟内自己失效：不报
  lease('project:pj_x', { pid: 4002, expiresIn: 25 * 60_000 });                   // 死了，还要挂 25 分钟：报
  lease(`task:${t2}`, { pid: 4003, expiresIn: 30_000, beatAgo: 90_000 });         // 活着，任务结束了还占着、也不续：报
  lease('project:pj_other', { pid: 4004, expiresIn: 25 * 60_000, host: 'another-host' });   // 别的机器上的进程：查不了，不报
  const alive = (pid) => pid === 4003;
  const r = run(db, 'leases', { at, alive });
  const kinds = Object.fromEntries(r.sample.map((v) => [v.ref, v.kind]));
  eq(kinds, { 'project:pj_x': 'dead_holder', [`task:${t2}`]: 'finished_task' }, '只报会久挂着的两种；任务租约快到期的、别的机器的不报');
}

// ── ⑥ ─────────────────────────────────────────────────────────────────────
section('⑥ 扫描：周期、转换审计、一条查炸了不连累别的');
{
  const { db, userId } = fresh();
  const at = now();
  let s = sweepInvariants(db, { at, assess });
  eq(s.ran.length, INVARIANTS.length + RECHECKS.length, '第一次：全查');
  s = sweepInvariants(db, { at: at + 60_000, assess });
  eq(s.ran, [], '一分钟后：都没到周期');
  s = sweepInvariants(db, { at: at + 5 * 60_000 + 1, assess });
  eq(s.ran, ['leases'], '五分钟后：只有租约到周期');
  const t = mkTask(db, userId);
  spend(db, t, 10_000_000);
  s = sweepInvariants(db, { at: at + 10 * 60_000 + 1, assess, only: ['budget'] });
  assert(s.transitions.length === 1 && s.transitions[0].to === 'violated' && s.transitions[0].id === 'budget', '从对到错：一条转换');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='invariant_violated' AND target_id='budget'`).n, 1, '记 invariant_violated 审计');
  s = sweepInvariants(db, { at: at + 20 * 60_000 + 2, assess, only: ['budget'] });
  eq(s.transitions, [], '一直违反：不重复记');
  const since = invariantsView(db).find((r) => r.id === 'budget').since;
  eq(since, at + 10 * 60_000 + 1, '违反从哪一刻起：第一次查出的时刻');
  audit(db, { actorKind: 'system', action: 'limit_breached', targetType: 'task', targetId: t, payload: { key: 'limit.budget_micro_usd' } });
  s = sweepInvariants(db, { at: at + 30 * 60_000 + 3, assess, only: ['budget'] });
  assert(s.transitions[0]?.to === 'restored' && s.transitions[0]?.forMs === 20 * 60_000 + 2, '从错到对：一条转换，带违反了多久');
  // 查炸了
  const inv = INVARIANTS.find((i) => i.id === 'leases'), orig = inv.check;
  inv.check = () => { throw new Error('模拟炸了'); };
  try { s = sweepInvariants(db, { at: at + 3600_000, assess, force: true }); } finally { inv.check = orig; }
  const v = invariantsView(db);
  assert(v.find((r) => r.id === 'leases').error === '模拟炸了' && s.ran.length === INVARIANTS.length + RECHECKS.length, '一条查炸了：记下错误，别的照查');
  eq(invariantsCheck(db).level, 'warn', '健康卡：查炸了算注意');
}

// ── ⑦ ─────────────────────────────────────────────────────────────────────
section('⑦ 给人看的：健康卡、通知、守护进程告诉管理员');
{
  const { db, userId } = fresh();
  eq(invariantsCheck(db).level, 'unknown', '一条都没查过：还不知道');
  sweepInvariants(db, { assess });
  eq(invariantsCheck(db).level, 'ok', '都成立：正常');
  spend(db, mkTask(db, userId), 10_000_000);
  sweepInvariants(db, { assess, force: true });
  const c = deploymentHealth(db).checks.find((x) => x.key === 'invariants');
  assert(c?.level === 'bad' && c.rows.find((r) => r.id === 'budget').violations === 1, '预算那条不成立：健康卡里这一项"有问题"');
  const n = invariantNotice([{ id: 'budget', to: 'violated', n: 1 }, { id: 'leases', to: 'restored' }]);
  assert(/运行期自检：1 项不成立/.test(n.title) && /有花费超过了上限、却没被拦下（1 处）/.test(n.text) && /恢复了/.test(n.text) && /invariants/.test(n.text), '通知：哪条不成立、哪条恢复、去哪看');
  const en = invariantNotice([{ id: 'leases', to: 'restored' }], 'en');
  assert(/back to normal/.test(en.title) && !/Details/.test(en.text), '英文；只恢复时不附"去哪看"');

  // 守护进程：转换告诉管理员一次
  const HOME = join(TMP, 'dhome');
  mkdirSync(HOME, { recursive: true });
  const { db: d3, userId: u3 } = fresh();
  const sent = [];
  const notifyOpts = { env: { NTFY_URL: 'https://ntfy.example/si' }, fetchFn: async (url, init) => { sent.push(init.body); return { ok: true, status: 200 }; } };
  const launcher = makeLauncher(d3, { home: HOME, spawnFn: () => ({ pid: 1, exitCode: null, on() {} }) });
  const d = startDaemon(d3, { home: HOME, launcher, intervalMs: 3600_000, alive: dead, runtime: null, notifyOpts, liveness: false });
  await d.tick();
  eq(sent.length, 0, '都成立：不发');
  spend(d3, mkTask(d3, u3), 10_000_000);
  d3.run(`UPDATE invariant_state SET checked_at=0`);   // 让下一拍到期
  await d.tick();
  assert(sent.length === 1 && /有花费超过了上限/.test(sent[0]), '不成立了：告诉管理员');
  d3.run(`UPDATE invariant_state SET checked_at=0`);
  await d.tick();
  eq(sent.length, 1, '一直不成立：不重复发');
  // 重查提醒同一拍查，但只上健康卡、不推通知
  saveModel(d3, { key: 'deepseek/deepseek-flash', fields: { contextWindow: 64_000 }, userId: u3 });
  d3.run(`UPDATE invariant_state SET checked_at=0`);
  await d.tick();
  assert(d3.one(`SELECT count(*) n FROM audit_log WHERE action='recheck_due'`).n >= 1, '同一拍里重查提醒亮了（写了 recheck_due）');
  eq(sent.length, 1, '重查提醒不推通知');
  assert(d3.metrics().timings.invariants_sweep?.n >= 4, `每拍自检的耗时进了 metrics（${d3.metrics().timings.invariants_sweep?.n} 拍，最长 ${d3.metrics().timings.invariants_sweep?.maxMs} ms）`);
  d.stop?.();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
if (fail) process.exitCode = 1;
