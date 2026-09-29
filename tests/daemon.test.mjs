// 守护进程
//
// 跑：node tests/daemon.test.mjs
//
// 断言的是"该不该拉起"这条规则，不是子进程：状态门、活着的编排器（自己的 / 别处的）、上次退出后有没有
// 人为动作、到点下班续跑、厂商错误 / 崩溃 / 起不来的退避、超时链并入；以及看板与守护进程共用启动器。

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { assessTask, dueTasks, startDaemon, daemonStatus, RESUME_ACTIONS, RETRY_BACKOFF_MS } from '../src/core/daemon.mjs';
import { makeLauncher } from '../src/core/launcher.mjs';
import { startWeb } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-daemon-'));
const HOME = join(TMP, 'home');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const db = openDb(':memory:');
const owner = ensureOwner(db);
const mkTask = (status = 'running') => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'守护测试','${status}',?)`, id, owner.userId, now());
  mkdirSync(join(HOME, 'workspaces', id), { recursive: true });
  return id;
};
const started = (taskId, pid = 4242) => audit(db, { actorKind: 'system', action: 'orchestrator_started', targetType: 'task', targetId: taskId, payload: { pid } });
const exited = (taskId, kind, extra = {}) => audit(db, { actorKind: 'system', action: 'orchestrator_exit', targetType: 'task', targetId: taskId, payload: { pid: 4242, kind, ...extra } });
const task = (id) => db.one(`SELECT id, status FROM tasks WHERE id=?`, id);
const dead = () => false;
const assess = (id, o = {}) => assessTask(db, task(id), { alive: dead, ...o });
const mkQuestion = (taskId, { level = 1, def = '不加', timeoutAt = now() + 60_000, status = 'open' } = {}) => {
  const nid = newId('n'), qid = newId('q');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'n','s','a','blocked',5,?)`, nid, taskId, now());
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
          VALUES (?,?,?,?,'classifier','问？',?,?,?,?)`, qid, taskId, nid, level, def, now(), timeoutAt, status);
  return qid;
};

section('1. 状态门与首跑');
{
  for (const s of ['waiting', 'suspended', 'done', 'aborted', 'planning']) {
    const id = mkTask(s);
    eq(assess(id).due, false, `${s} 不拉起`);
  }
  const id = mkTask();
  eq(assess(id).reason, 'run:first', 'running 且从没跑过 → 首跑');
  eq(assess(id, { hasWorkspace: () => false }).reason, 'no_workspace', '没有工作区不拉（拉了 run 也是 die）');
  eq(assess(id, { isLive: () => ({ pid: 1 }) }).reason, 'live', '自己起的还在跑 → 不拉');

  // `new --file` 直接给宪法块的 planning 任务：工作区建好就拉 plan（项目级分解手工串一次时撞出来的洞）
  const p = mkTask('planning');
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), p, now(), now());
  const a = assess(p);
  assert(a.due && a.verb === 'plan' && a.reason === 'plan:first', 'planning + 宪法块 + 没节点 + 有工作区 → 拉 plan');
  eq(assess(p, { hasWorkspace: () => false }).reason, 'no_workspace', '工作区没建 → 不拉 plan（那是人的开工信号）');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'n','s','a','pending',5,?)`, newId('n'), p, now());
  eq(assess(p).due, false, '已有节点 → 不再拉 plan');
}

section('2. 上次退出后有没有人为动作');
{
  const id = mkTask();
  started(id); exited(id, 'suspended');
  eq(assess(id).reason, 'needs_human:suspended', '挂起后没人动过 → 等人');
  const other = mkTask();
  const qOther = mkQuestion(other);
  audit(db, { actorKind: 'user', action: 'question_answered', targetType: 'question', targetId: qOther });
  eq(assess(id).due, false, '别的任务的答题不算');
  const q = mkQuestion(id);
  audit(db, { actorKind: 'user', action: 'question_answered', targetType: 'question', targetId: q });
  eq(assess(id).reason, 'run:trigger:question_answered', '自己任务的问题被答了 → 拉起（按问题 → 任务 关联找）');
  started(id); exited(id, 'limit_breached');
  eq(assess(id).due, false, '触顶后没动作不拉');
  audit(db, { actorKind: 'user', action: 'limit_set', targetType: 'task', targetId: id, payload: { key: 'limit.llm_calls', value: 999 } });
  eq(assess(id).reason, 'run:trigger:limit_set', '加额 → 拉起');
  started(id); exited(id, 'verify_failed');
  eq(assess(id).reason, 'needs_human:verify_failed', '验收没过 → 等人（无脑重拉会每轮烧钱）');
  audit(db, { actorKind: 'user', action: 'message_received', targetType: 'task', targetId: id, payload: { kind: 'correction' } });
  eq(assess(id).reason, 'run:trigger:message_received', '留言（修正）→ 拉起');
  started(id); exited(id, 'replan_failed');
  eq(assess(id).due, false, '重规划失败 → 等人');
  assert(RESUME_ACTIONS.includes('revision_applied') && RESUME_ACTIONS.includes('task_resumed') && RESUME_ACTIONS.includes('egress_allowlist_set'),
    '批准提案 / 恢复 / 放行出网都在触发表里');
}

section('3. 到点下班 vs 真卡住');
{
  const id = mkTask();
  started(id); exited(id, 'stalled', { why: '到达 maxCycles=12' });
  eq(assess(id).reason, 'run:continue', 'maxCycles 到了 → 续跑');
  started(id); exited(id, 'stalled', { why: '没有就绪节点，但也不是全部完成 —— 依赖成环或有节点停在非终态' });
  eq(assess(id).reason, 'needs_human:stalled', '真卡住 → 等人');
}

section('4. 厂商错误 / 崩溃：退避');
{
  const id = mkTask();
  const t0 = now();
  started(id); exited(id, 'provider_error');
  let a = assess(id, { at: t0 });
  eq(a.reason, 'backoff:provider_error#1', '第 1 次厂商错误：先等');
  a = assess(id, { at: t0 + RETRY_BACKOFF_MS[0] + 1 });
  eq(a.reason, 'run:retry:provider_error#1', '等够 5 分钟 → 重试');
  for (let i = 1; i < RETRY_BACKOFF_MS.length; i++) { started(id); exited(id, 'provider_error'); }
  a = assess(id, { at: t0 + 10 * 3600_000 });
  eq(a.reason, `run:retry:provider_error#${RETRY_BACKOFF_MS.length}`, '表内最后一次仍重试');
  started(id); exited(id, 'provider_error');
  a = assess(id, { at: t0 + 100 * 3600_000 });
  eq(a.reason, `gave_up:provider_error`, '超过退避表 → 放弃等人');
  audit(db, { actorKind: 'user', action: 'message_received', targetType: 'task', targetId: id, payload: { kind: 'instruction' } });
  eq(assess(id).reason, 'run:trigger:message_received', '人一动，计数归零、立即拉起');
  started(id); exited(id, 'provider_error');
  eq(assess(id, { at: now() }).reason, 'backoff:provider_error#1', '归零后从第 1 次数起');

  // 配置问题退出的：注册表改过就立刻再拉（那几条审计是部署级的，不挂在任务上）；没改过照常退避
  const g = mkTask();
  started(g); exited(g, 'provider_error', { error: { config: true, tier: 'heavy', message: 'heavy 档绑的 x 已停用' } });
  eq(assess(g, { at: now() }).reason, 'backoff:provider_error#1', '配置问题、注册表没动：照常退避');
  audit(db, { actorKind: 'user', action: 'binding_set', targetType: 'binding', targetId: 'heavy', payload: { to: 'deepseek/deepseek-v4-pro' } });
  eq(assess(g, { at: now() }).reason, 'run:config_fixed:binding_set', '改了绑定 → 立刻再拉，不等退避');
  started(g); exited(g, 'provider_error', { error: { config: true } });
  eq(assess(g, { at: now() }).reason, 'backoff:provider_error#2', '再拉还是配置问题：那次改动在这次退出之前，不再算；回到退避');
  // 不可重试的厂商错误（401 / 403）：直接等人，不退避；改绑 / 换 key 后立刻再拉
  const rj = mkTask();
  started(rj); exited(rj, 'provider_error', { error: { status: 403, retryable: false, vendor: 'anthropic' } });
  eq(assess(rj, { at: now() + 100 * 3600_000 }).reason, 'needs_human:provider_rejected', '403：等多久都不自己重试');
  audit(db, { actorKind: 'user', action: 'key_set', targetType: 'endpoint', targetId: 'anthropic', payload: { keyEnv: 'ANTHROPIC_API_KEY', present: true } });
  eq(assess(rj, { at: now() }).reason, 'run:config_fixed:key_set', '换了 key → 立刻再拉');
  const rt = mkTask();
  started(rt); exited(rt, 'provider_error', { error: { status: 503, retryable: true } });
  eq(assess(rt, { at: now() }).reason, 'backoff:provider_error#1', '可重试的（503）照旧退避');
  const h = mkTask();
  started(h); exited(h, 'provider_error');
  audit(db, { actorKind: 'user', action: 'key_set', targetType: 'endpoint', targetId: 'deepseek', payload: { keyEnv: 'X', present: true } });
  eq(assess(h, { at: now() }).reason, 'backoff:provider_error#1', '真的厂商错误不受注册表改动影响');

  const c = mkTask();
  started(c, 777);
  eq(assess(c, { alive: (pid) => pid === 777 }).reason, 'live_foreign', '起了没退且 pid 活着（别处起的）→ 不拉');
  eq(assess(c, { at: now() }).reason, 'backoff:crashed#1', 'pid 死了 → 当崩溃，退避');
  eq(assess(c, { at: now() + RETRY_BACKOFF_MS[0] + 1 }).reason, 'run:retry:crashed#1', '退避到期重拉');
}

section('5. dueTasks：running 要拉；waiting 只在"有活可干"时拉（未消费的计划变更 / 就绪节点）');
{
  const ids = [mkTask(), mkTask('waiting'), mkTask()];
  const due = dueTasks(db, { alive: dead });
  assert(due.find((d) => d.taskId === ids[1]) && !due.find((d) => d.taskId === ids[1]).due, 'waiting 的在列表里但不拉（理由写明是 status）');
  assert(due.filter((d) => d.due && (d.taskId === ids[0] || d.taskId === ids[2])).length === 2, '两个首跑都该拉');

  // 结构矛盾的出路是改契约，而改契约只能发修正（答复改不了 scope）。
  // 人发了修正，任务却还是 waiting —— 守护进程若连看都不看 waiting，就会无报错、无待办、不动。
  const w = ids[1];
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
          VALUES (?,?,?,'把范围改成也能动 shared/contract.mjs','correction','explicit','normal','explicit','user-authenticated',?,?)`,
  newId('m'), w, owner.userId, owner.tokenId, now());
  assert(dueTasks(db, { alive: dead }).find((d) => d.taskId === w)?.due, 'waiting + 未消费的修正 → 拉起（编排器每轮开头就跑重规划，排在挑节点之前）');
  db.run(`UPDATE messages SET consumed_at=? WHERE task_id=?`, now(), w);
  assert(!dueTasks(db, { alive: dead }).find((d) => d.taskId === w)?.due, '消费之后不再反复拉');

  // waiting ≠ 没活可干。分支级挂起的全部意义就是"A 等人答题、独立的 B 照跑"；
  // 计划变更新增一个节点之后，新节点就绪而任务还是 waiting —— 不专门看这一条的话谁也不会去拉它。
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,created_at) VALUES (?,?,'新节点','s','a','pending',?)`, newId('n'), w, now());
  assert(dueTasks(db, { alive: dead }).find((d) => d.taskId === w)?.due, 'waiting + 有就绪节点（依赖都满足、没被挡住）→ 拉起');
  const blockedOnly = mkTask('waiting');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,created_at) VALUES (?,?,'被挡住的','s','a','blocked',?)`, newId('n'), blockedOnly, now());
  assert(!dueTasks(db, { alive: dead }).find((d) => d.taskId === blockedOnly)?.due, '只剩被挡住的节点 → 照旧不拉，别去烧钱跑一轮空转');
}

section('6. startDaemon.tick：拉起、不重复、起不来的退避、超时链并入');
{
  const db2 = openDb(':memory:');
  const o2 = ensureOwner(db2);
  const t = newId('t');
  db2.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'d','running',?)`, t, o2.userId, now());
  mkdirSync(join(HOME, 'workspaces', t), { recursive: true });
  const children = [];
  const spawnFn = () => { const c = { pid: 9000 + children.length, exitCode: null, on() {} }; children.push(c); return c; };
  const launcher = makeLauncher(db2, { home: HOME, runBinds: ['--bind', 'heavy=x/y'], spawnFn });
  const events = [];
  let clockAt = now();
  const d = startDaemon(db2, { home: HOME, launcher, intervalMs: 3600_000, onEvent: (e) => events.push(e), alive: dead, clock: () => clockAt, runtime: null });
  eq(db2.one(`SELECT count(*) n FROM audit_log WHERE action='daemon_started'`).n, 1, '守护进程启动进审计');
  let r = await d.tick();
  eq(r.launched.length, 1, '首轮拉起 1 个');
  eq(r.launched[0].reason, 'run:first', '理由是首跑');
  const row = db2.one(`SELECT * FROM audit_log WHERE action='run_launched_by_daemon' AND target_id=?`, t);
  assert(row && row.actor_kind === 'system' && JSON.parse(row.payload).reason === 'run:first' && JSON.parse(row.payload).args.includes('heavy=x/y'),
    '审计 run_launched_by_daemon：system 起的、带理由、带 --bind');
  r = await d.tick();
  eq(r.launched.length, 0, '子进程还活着 → 不重复拉');
  eq(launcher.running(t)?.pid, 9000, 'running() 看得到');

  // 子进程退了，但没写 orchestrator_started（比如 Docker 没开，run 一进去就 die）
  children[0].exitCode = 1;
  r = await d.tick();
  eq(r.launched.length, 0, '起不来 → 不立刻再拉');
  eq(r.skipped[0]?.reason, 'backoff:launch_failed#1', '按退避表等');
  clockAt += RETRY_BACKOFF_MS[0] + 1;
  r = await d.tick();
  eq(r.launched.length, 1, '退避到期 → 再拉一次');
  // 这次编排器真起来了（写了 orchestrator_started），然后挂起退出 → 失败计数归零，等人
  audit(db2, { actorKind: 'system', action: 'orchestrator_started', targetType: 'task', targetId: t, payload: { pid: 1 } });
  audit(db2, { actorKind: 'system', action: 'orchestrator_exit', targetType: 'task', targetId: t, payload: { pid: 1, kind: 'suspended' } });
  db2.run(`UPDATE tasks SET status='waiting' WHERE id=?`, t);
  children.at(-1).exitCode = 0;
  r = await d.tick();
  eq(r.launched.length + r.skipped.length, 0, 'waiting → 不拉也不算退避');

  // 超时链并入：Ⅰ 级问题到期 → 走默认 → 任务回 running → 同一轮就拉起，理由是 question_defaulted
  const nid = newId('n'), qid = newId('q');
  db2.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'n','s','a','blocked',5,?)`, nid, t, now());
  db2.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
           VALUES (?,?,?,1,'classifier','问？','默认',?,?,'open')`, qid, t, nid, now() - 3600_000, now() - 1);
  r = await d.tick();
  eq(r.swept.defaulted.length, 1, '到期的 Ⅰ 级问题走默认');
  eq(db2.one(`SELECT status FROM tasks WHERE id=?`, t).status, 'running', '任务回 running');
  eq(r.launched[0]?.reason, 'run:trigger:question_defaulted', '同一轮拉起，理由是超时走默认');
  assert(events.some((e) => e.type === 'sweep') && events.some((e) => e.type === 'launched'), '事件都给了 onEvent');
  d.stop(); db2.close();
}

section('7. 看板与守护进程共用启动器');
{
  const db3 = openDb(':memory:');
  const o3 = ensureOwner(db3);
  const t = newId('t');
  db3.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'w','running',?)`, t, o3.userId, now());
  const kids = [];
  const launcher = makeLauncher(db3, { home: HOME, spawnFn: () => { const c = { pid: 31337, exitCode: null, on() {} }; kids.push(c); return c; } });
  const w = await startWeb(db3, { home: HOME, port: 0, tokenPlain: o3.plaintext, launcher, pollMs: 100 });
  const base = `http://127.0.0.1:${w.port}`;
  launcher.launch(t, { action: 'run_launched_by_daemon', reason: 'run:first' });
  const detail = await fetch(`${base}/api/tasks/${t}`).then((r) => r.json());
  eq(detail.running?.pid, 31337, '守护进程起的 run，看板的 running 看得到');
  const r = await fetch(`${base}/api/tasks/${t}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  eq(r.status, 400, '看板再按运行 → 拒（同一任务同时只跑一个）');
  // 心跳：看板没带 --daemon，但独立守护进程在跑 → 如实显示开；停了 / 心跳过期 → 关
  const tl = () => fetch(base + '/api/tasks').then((x) => x.json());
  eq((await tl()).daemon, false, '没有心跳：自动运行关');
  const d7 = startDaemon(db3, { home: HOME, launcher, intervalMs: 3600_000, runtime: null });
  const on = await tl();
  eq(JSON.stringify([on.daemon, on.daemonInfo.inProcess, on.daemonInfo.pid]), JSON.stringify([true, false, process.pid]), '独立守护进程有心跳：看板显示开，标明不是随看板启动的');
  writeFileSync(join(HOME, 'daemon.heartbeat'), JSON.stringify({ pid: 1, at: Date.now() - 120_000, intervalMs: 15_000 }));
  eq(JSON.stringify([daemonStatus(HOME).alive, (await tl()).daemon]), JSON.stringify([false, false]), '心跳过期（超过 3 个间隔且超过 60 秒）：算停了');
  await d7.tick();
  eq(daemonStatus(HOME).alive, true, '每轮刷新心跳');
  d7.stop();
  eq(daemonStatus(HOME).alive, false, '正常停止时清掉心跳');
  w.close(); db3.close();
}

// ── 容器运行时不在的时候，不去拉要用沙箱的那几步（不烧重试次数），恢复了自己接着拉 ──
{
  console.log('\n── 运行时不在：不拉 run、不烧重试；恢复后自己接着拉');
  const db4 = openDb(':memory:');
  const o4 = ensureOwner(db4);
  const t = newId('t');
  db4.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'rt','running',?)`, t, o4.userId, now());
  mkdirSync(join(HOME, 'workspaces', t), { recursive: true });
  const children = [];
  const launcher = makeLauncher(db4, { home: HOME, spawnFn: () => { const c = { pid: 7000 + children.length, exitCode: null, on() {} }; children.push(c); return c; } });
  let up = false;
  const runtime = { fresh: async () => (up ? { ok: true, cli: 'docker', version: '29' } : { ok: false, cli: 'docker', why: 'failed to connect to the docker API' }) };
  const d = startDaemon(db4, { home: HOME, launcher, intervalMs: 3600_000, alive: dead, runtime });
  let r = await d.tick();
  eq(r.launched.length, 0, '运行时不在：该跑的 run 不拉');
  eq(r.skipped.find((s) => s.taskId === t)?.reason, 'runtime_down', '跳过的理由写的是运行时不在，不是退避');
  eq(db4.one(`SELECT count(*) n FROM audit_log WHERE action='runtime_down'`).n, 1, '状态变化记一条审计（看板 / 活动流据此说话）');
  r = await d.tick();
  eq(db4.one(`SELECT count(*) n FROM audit_log WHERE action='runtime_down'`).n, 1, '一直不在：不重复记');
  eq(db4.one(`SELECT count(*) n FROM audit_log WHERE action='run_launched_by_daemon'`).n, 0, '没烧掉任何一次拉起（退避表的重试次数原样留着）');
  up = true;
  r = await d.tick();
  eq(JSON.stringify(r.launched.map((x) => x.taskId)), JSON.stringify([t]), '恢复了：当拍就拉，不用人点');
  eq(db4.one(`SELECT count(*) n FROM audit_log WHERE action='runtime_up'`).n, 1, '恢复也记一条');
  d.stop?.();
  db4.close();
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 200);
