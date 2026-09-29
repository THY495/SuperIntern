// 停等账本与空转检测
//
// 跑：node tests/liveness.test.mjs
//
// 断言的是判据本身，不是调度：一个没结束的任务此刻在等谁，必须能解引用到四样东西之一
// （自己的进程 / 一个到点的时刻 / 一个真收得到事项的人 / 另一件没完成的事）；解引用不到就是
// unknown，过了宽限期升成一条给负责人的事项。外加空转：系统在没有新信息时重复了自己。
//
// 为什么这些用例必须走 assessTask 而不是直接构造：这类漏接的典型形状是"人做了正确的
// 动作而调度器不看它"，而离线测试里那个"不看"往往被测试自己手动调 run 给盖住了。

import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { assessTask } from '../src/core/daemon.mjs';
import { setParam } from '../src/core/params.mjs';
import {
  stalls, stallOf, livelocks, sweepLiveness, unfinishedTasks, lastActivityAt,
  answerableQuestion, upstreamOf, STALL_MARK, LOOP_MARK, UNKNOWN_GRACE_MS,
} from '../src/core/liveness.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const db = openDb(':memory:');
const owner = ensureOwner(db);
const T0 = now();
const dead = () => false;
const assess = (d, t, o = {}) => assessTask(d, t, { alive: dead, hasWorkspace: () => true, ...o });
const taskRow = (id) => db.one(`SELECT id, title, status, project_id, project_order, merged_at FROM tasks WHERE id=?`, id);
const one = (id, at = T0) => stallOf(db, taskRow(id), assess(db, taskRow(id), { at }), { at });

const mkUser = (name, { disabled = false, role = 'member' } = {}) => {
  const id = newId('u');
  db.run(`INSERT INTO users (id,display_name,role,created_at${disabled ? ',disabled_at' : ''}) VALUES (?,?,?,?${disabled ? ',?' : ''})`,
    ...(disabled ? [id, name, role, T0, T0] : [id, name, role, T0]));
  return id;
};
const mkTask = (status = 'running', { title = '停等测试', projectId = null, order = null, mergedAt = null, createdAt = T0 } = {}) => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order,merged_at) VALUES (?,?,?,?,?,?,?,?)`,
    id, owner.userId, title, status, createdAt, projectId, order, mergedAt);
  return id;
};
const mkProject = (status = 'active') => {
  const id = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,created_at)
          VALUES (?,?,'项目','',?,?,'base','src',?,?)`, id, owner.userId, `/r/${id}`, `superintern/${id}`, status, T0);
  return id;
};
const mkQuestion = (taskId, { text = '要不要这么做？', to = null, status = 'open', askedAt = T0 } = {}) => {
  const qid = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,addressed_to,asked_at,timeout_at,status)
          VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,?,NULL,?)`, qid, taskId, text, JSON.stringify(to ?? []), askedAt, status);
  return qid;
};
const mkNode = (taskId, title = '节点') => {
  const id = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,?,'s','a','pending',5,?)`, id, taskId, title, T0);
  return id;
};
const started = (taskId, pid = 4242, at = T0) => audit(db, { actorKind: 'system', action: 'orchestrator_started', targetType: 'task', targetId: taskId, payload: { pid }, at });
const exited = (taskId, kind, at = T0) => audit(db, { actorKind: 'system', action: 'orchestrator_exit', targetType: 'task', targetId: taskId, payload: { pid: 4242, kind }, at });
const workspaceMade = (taskId) => audit(db, { actorKind: 'system', action: 'workspace_created', targetType: 'task', targetId: taskId, payload: {} });

// ════════════════════════════════════════════════════════════════════════
section('1 · 四种合法的静止都能解引用');

{
  const t = mkTask('running');
  started(t);
  const s = stallOf(db, taskRow(t), assess(db, taskRow(t), { alive: () => true, at: T0 }), { at: T0 });
  eq(s.kind, 'self', '自己的进程活着 → self');
  eq(s.ref.pid, 4242, 'self 带得出 pid');
}
{
  // 崩了一次 → 退避。退避是合法的静止，但必须带得出 readyAt。
  const t = mkTask('running');
  started(t); exited(t, 'crashed');
  const a = assess(db, taskRow(t), { at: T0 + 1000 });
  const s = stallOf(db, taskRow(t), a, { at: T0 + 1000 });
  eq(s.kind, 'clock', '退避中 → clock');
  assert(typeof s.ref.readyAt === 'number' && s.ref.readyAt > T0, 'clock 带得出 readyAt');
}
{
  const u = mkUser('阿青');
  const t = mkTask('waiting');
  const q = mkQuestion(t, { to: [u] });
  const s = one(t);
  eq(s.kind, 'human', '等人答事项 → human');
  eq(s.ref.questionId, q, 'human 带得出 questionId');
  eq(s.ref.to[0], u, 'human 带得出真的收得到的人');
}
{
  const t = mkTask('waiting');
  mkQuestion(t, { to: null });   // [] = 广播
  eq(one(t).kind, 'human', '广播事项也算 human：所有人收件箱里都有');
  assert(one(t).ref.broadcast === true, '广播标出来了');
}

section('2 · 说不出在等谁的，一律 unknown');

{
  // 典型形状：任务停在 done，没有任何事项挂着。assessTask 只会说 status:done —— 那不是理由。
  const t = mkTask('done', { title: '签收打回后没人接' });
  const s = one(t);
  eq(s.kind, 'unknown', 'done 且没有任何开着的事项 → unknown');
  assert(/status:done/.test(s.assessed ?? ''), '把守护进程原话记下来了，便于查');
  assert(/说不出谁会让它动起来/.test(s.why), 'why 说清楚了为什么这不算理由');
}
{
  // 孤儿事项：库里开着，但指定的人全停用 —— 没有任何人会看到它。
  const gone = mkUser('已离职', { disabled: true });
  const obs = mkUser('旁观者', { role: 'observer' });
  const t = mkTask('waiting');
  const q = mkQuestion(t, { to: [gone, obs] });
  const s = one(t);
  eq(s.kind, 'unknown', '事项的收件人全停用 / 全是旁观者 → unknown，不是 human');
  eq(s.ref.questionId, q, '仍然指得出是哪条事项');
}
{
  const t = mkTask('suspended', { title: '挂起但没人被告知' });
  eq(one(t).kind, 'unknown', 'suspended 而没有事项 → unknown（状态不是理由）');
}
{
  const r = answerableQuestion(db, mkTask('waiting'));
  eq(r, null, '没有事项时 answerableQuestion 返回 null');
}

section('3 · 项目里的等待指得出上游');

{
  const pj = mkProject('active');
  const a = mkTask('done', { title: 'A', projectId: pj, order: 1, mergedAt: null });
  const b = mkTask('planning', { title: 'B', projectId: pj, order: 2 });
  setParam(db, { taskId: b, key: 'task.depends_on', value: [1], by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  const s = one(b);
  eq(s.kind, 'upstream', '依赖的任务还没合并 → upstream');
  eq(s.ref.taskId, a, 'upstream 指得出是在等哪个任务');
  assert(/#1/.test(s.why), 'why 点出了编号');
}
{
  // 依赖都合并了，但另一个任务开着：串行调度轮不到它。
  const pj = mkProject('active');
  const a = mkTask('done', { title: 'A', projectId: pj, order: 1, mergedAt: T0 });
  const b = mkTask('running', { title: 'B', projectId: pj, order: 2 });
  workspaceMade(b);
  const c = mkTask('planning', { title: 'C', projectId: pj, order: 3 });
  setParam(db, { taskId: c, key: 'task.depends_on', value: [1], by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  void a;
  const s = one(c);
  eq(s.kind, 'upstream', '依赖满足但别的任务开着 → upstream');
  eq(s.ref.taskId, b, '指得出是在等哪个开着的任务');
}
{
  const pj = mkProject('proposed');
  const carrier = mkTask('planning', { title: '项目方案', projectId: pj, order: 0 });
  const t1 = mkTask('planning', { title: 'T1', projectId: pj, order: 1 });
  const s = one(t1);
  eq(s.kind, 'upstream', '项目方案还没批准时，任务在等载体任务');
  eq(s.ref.taskId, carrier, '指得出载体任务');
  eq(upstreamOf(db, taskRow(carrier)), null, '载体任务自己没有上游（它等的是批准事项）');
}
{
  // 项目批准之后，载体任务只有在复盘 / 追加待批的那一段才算"没结束"，
  // 而 assessTask 对它一辈子只会说 status:waiting —— 规划器与复盘挂在**项目 id** 上跑，它看不见。
  // 若这里 return null，载体必然落到 unknown：项目一直在正常干活，载体却静止上百分钟，
  // 账本照判据报警、给负责人提一条 Ⅲ 级事项。判据没错，是它指不过去。
  const pj = mkProject('active');
  const carrier = mkTask('waiting', { title: '项目方案', projectId: pj, order: 0 });
  const t1 = mkTask('running', { title: 'T1', projectId: pj, order: 1 });
  const u1 = upstreamOf(db, taskRow(carrier));
  eq(u1?.taskId, t1, '这一批还没做完 → 载体在等那个还开着的任务');
  assert(/还没做完/.test(u1.why), '理由说得出是哪一批没做完');
  db.run(`UPDATE tasks SET merged_at=? WHERE id=?`, T0, t1);
  const u2 = upstreamOf(db, taskRow(carrier));
  eq(u2?.taskId, null, '全都合并了 → 指的是项目本身，不再指某个任务');
  eq(u2?.projectId, pj, '指得过去：项目 id 在');
  assert(/复盘/.test(u2.why), '理由说得出在等复盘 / 达成确认');
}

section('4 · 什么算"没结束"');

{
  const before = unfinishedTasks(db).length;
  const t = mkTask('done');
  setParam(db, { taskId: t, key: 'signoff.status', value: 'accepted', by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  eq(unfinishedTasks(db).length, before, '独立任务：done 且签收已接受 = 结束');
}
{
  const pj = mkProject('active');
  const m = mkTask('done', { projectId: pj, order: 7, mergedAt: T0 });
  assert(!unfinishedTasks(db).some((x) => x.id === m), '项目任务：合并了 = 结束');
  const acc = mkTask('done', { projectId: pj, order: 8 });
  setParam(db, { taskId: acc, key: 'signoff.status', value: 'accepted', by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  assert(unfinishedTasks(db).some((x) => x.id === acc),
    '项目任务：签收接受但一直没合并，仍算没结束 —— 这本身就是该报的停等');
}
{
  const pj = mkProject('active');
  const carrier = mkTask('planning', { projectId: pj, order: 0 });
  assert(!unfinishedTasks(db).some((x) => x.id === carrier),
    '载体任务：项目已 active 且没有待批准的追加 → 它的活干完了，不算没结束');
}

section('5 · 宽限期与升事项');

{
  const t = mkTask('suspended', { title: '刚挂起' });
  audit(db, { actorKind: 'system', action: 'task_paused', targetType: 'task', targetId: t, payload: {} });
  const r = sweepLiveness(db, { at: T0 + 60_000, assess, hasWorkspace: () => true, alive: dead });
  assert(!r.stuck.some((x) => x.taskId === t), '刚动过的不报：宽限期内不算停摆');
}
{
  const t = mkTask('suspended', { title: '停了很久没人管', createdAt: T0 - 10 * 60 * 60_000 });
  const at = T0 + UNKNOWN_GRACE_MS + 60_000;
  const r = sweepLiveness(db, { at, assess, hasWorkspace: () => true, alive: dead });
  const mine = r.stuck.find((x) => x.taskId === t);
  assert(!!mine, '超过宽限期的 unknown 被报出来');
  const q = db.one(`SELECT id, text, addressed_to, timeout_at, default_action FROM questions WHERE task_id=? AND status='open'`, t);
  assert(!!q && q.text.startsWith(STALL_MARK), '升成了一条事项，不是一行日志');
  eq(q.timeout_at, null, '报警事项不会超时自己消失');
  eq(q.default_action, null, '报警事项没有默认动作：不会被替人决定');
  assert(JSON.parse(q.addressed_to).includes(owner.userId), '事项送到了负责人手上');
  assert(!!db.one(`SELECT 1 FROM audit_log WHERE action='stall_detected' AND target_id=?`, t), '记了审计');

  // 去重靠判据本身：报警事项挂上去之后，这个任务就解引用得到人了。
  const after = one(t);
  eq(after.kind, 'human', '报警之后 kind 从 unknown 变成 human');
  const r2 = sweepLiveness(db, { at: at + 60_000, assess, hasWorkspace: () => true, alive: dead });
  assert(!r2.stuck.some((x) => x.taskId === t), '第二轮不再重复报');
  eq(db.all(`SELECT id FROM questions WHERE task_id=? AND status='open'`, t).length, 1, '只有一条报警事项');
}

section('6 · 空转：系统在没有新信息时重复自己');

{
  // 典型形状：人答"授权你改 scope"，可答复改不了契约，于是同一个问题被反复提出来。
  const t = mkTask('waiting', { title: '反复问同一个问题' });
  const txt = '规格没写 scope 能不能扩到 shared/，请授权';
  for (let i = 0; i < 3; i++) mkQuestion(t, { text: `${txt}（第 ${i} 轮）`.replace(/（第 \d+ 轮）/, ''), status: i < 2 ? 'answered' : 'open', to: [owner.userId], askedAt: T0 + i });
  const l = livelocks(db, { at: T0 }).filter((x) => x.taskId === t);
  eq(l.length, 1, '同一条事项提出三次 → 一条空转');
  eq(l[0].kind, 'question', '认出是事项在重复');
  eq(l[0].n, 3, '数对了次数');
  const r = sweepLiveness(db, { at: T0, assess, hasWorkspace: () => true, alive: dead });
  assert(r.raised.some((x) => x.taskId === t && x.kind === 'livelock'), '空转升成了事项');
  const q = db.one(`SELECT text FROM questions WHERE task_id=? AND text LIKE ?`, t, `${LOOP_MARK}%`);
  assert(!!q && /计划变更/.test(q.text), '事项正文指明出路是计划变更，而不是再答一遍');
  const r2 = sweepLiveness(db, { at: T0 + 1000, assess, hasWorkspace: () => true, alive: dead });
  assert(!r2.raised.some((x) => x.taskId === t && x.kind === 'livelock'), '空转事项不重复挂');
}
{
  const t = mkTask('waiting', { title: '两条不同的问题' });
  for (const x of ['甲问题', '乙问题', '丙问题']) mkQuestion(t, { text: x, to: [owner.userId] });
  assert(!livelocks(db, { at: T0 }).some((l) => l.taskId === t && l.kind === 'question'), '三条不同的事项不算空转');
}
{
  // 典型形状：两条机械校验合起来无解，节点每次都停在同一处。
  const t = mkTask('running', { title: '节点反复同一个死法' });
  const n = mkNode(t, '交接产物');
  for (let i = 0; i < 3; i++) audit(db, { actorKind: 'agent', actorId: 'executor', action: 'node_stalled', targetType: 'node', targetId: n, payload: { stopped: '交接校验不通过：没有可交的改动' } });
  const l = livelocks(db, { at: T0 }).filter((x) => x.taskId === t && x.kind === 'node');
  eq(l.length, 1, '同一节点以同一原因失败三次 → 空转');
  eq(l[0].ref.nodeId, n, '指得出是哪个节点');
}
{
  const t = mkTask('running', { title: '停因每次都在变' });
  const n = mkNode(t, '正常推进');
  for (const s of ['编译错', '测试红', '到达 maxCycles']) audit(db, { actorKind: 'agent', actorId: 'executor', action: 'node_stalled', targetType: 'node', targetId: n, payload: { stopped: s } });
  assert(!livelocks(db, { at: T0 }).some((x) => x.taskId === t && x.kind === 'node'),
    '停因每次都不一样 = 还在往前走，不算空转');
}

section('7 · 判据的边界，写清楚免得下次又忘');

{
  const t = mkTask('running');
  started(t);
  const s = stallOf(db, taskRow(t), { due: true, verb: 'run', reason: 'run:trigger:question_answered' }, { at: T0 });
  eq(s.kind, 'self', '该拉起的任务不算停 —— 它马上就会动');
}
{
  // 没有 readyAt 的"退避"不算合法静止：那跟说"等一会"一样，解引用不到任何东西。
  const t = mkTask('running');
  const s = stallOf(db, taskRow(t), { due: false, verb: 'run', reason: 'backoff:crashed#2' }, { at: T0 });
  eq(s.kind, 'unknown', '说在退避却给不出 readyAt → unknown');
}
{
  const t = mkTask('running');
  assert(lastActivityAt(db, t) >= T0, '从没有审计的任务，用创建时间兜底，不会算成"停了无限久"');
}
{
  let threw = null;
  try { stalls(db, { at: T0 }); } catch (e) { threw = e.message; }
  assert(/需要 assess/.test(threw ?? ''), 'stalls 必须由调用方传 assessTask：判据和调度不能各算各的');
}

// ════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
console.log(fail ? `❌ ${pass} 通过，${fail} 失败` : `✅ ${pass} 通过，0 失败`);
console.log('═'.repeat(72));
process.exit(fail ? 1 : 0);
