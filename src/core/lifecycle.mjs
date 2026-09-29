// 任务 / 项目的生命周期动作：恢复已中止的任务、项目停滞后的出口、中止项目、改标题、归档。
//
// 边界（与"人只做四件事"对齐）：这里的动作只碰**调度与元数据**，不碰契约。要改契约走"提变更"（修正流水线）。
//   - **中止可反悔**：abort 只改 tasks.status + 记审计，不撤回事项、不动工作区 / 步骤图 / 分支；
//     所以恢复 = 把状态放回去，task id / 审计 / 花费归属都不变。中止期间该任务的开放事项不进任何人的待办（digest 里滤掉），恢复后重新出现。
//   - **项目停滞的三个出口**（不做成待决事项：答复要人写自由文本再解析，而这里是三个确定的动作）：
//       ① 恢复当前任务（接着半成品做；想改契约，恢复后提变更）；
//       ② 重做当前任务（丢弃半成品：同一份契约、同一 order、同一 verify_extra 新建任务，旧任务退出链 —— `project_order` 置 NULL + supersedes 边；
//          否则 advanceProject 的 `tasks.find(t => !t.merged_at)` 会永远取到旧任务）；
//       ③ 中止项目（终点；已合并的前缀是签收过的成果，仍可 deliverProject）。
//   - **归档是纯显示标记**：不改状态、按部署存；只许对已结束的（done / aborted）—— 被归档的 waiting 任务还在发通知、占预算却从列表里消失，是最坏的组合。
//     项目归档连带隐藏其任务（界面按 project.archived_at 判），项目内的任务不单独归档。
//
// 权限：任务动作 = 该任务的负责人（leadOf）；项目动作 = 项目 owner。调用方传 userId，这里判。

import { now, audit, insertEdge } from '../db/db.mjs';
import { voidOne } from './decisions.mjs';
import { leadOf } from './routing.mjs';
import { createTaskFromSpec, projectTasks, chainGraph } from './project.mjs';
import { maxOpenOf } from './project-settings.mjs';
import { recordMessage } from './inbox.mjs';
import { getParam } from './params.mjs';

const ENDED = ['done', 'aborted'];
const ABORTABLE = ['planning', 'running', 'waiting', 'suspended'];

const mustTask = (db, taskId) => db.one(`SELECT * FROM tasks WHERE id=?`, taskId) ?? (() => { throw new Error(`任务不存在：${taskId}`); })();
const mustProject = (db, projectId) => db.one(`SELECT * FROM projects WHERE id=?`, projectId) ?? (() => { throw new Error(`项目不存在：${projectId}`); })();
const requireTaskLead = (db, taskId, userId, what) => { if (leadOf(db, taskId) !== userId) throw new Error(`只有该任务的负责人能${what}`); };
const requireOwner = (p, userId, what) => { if (p.owner_id !== userId) throw new Error(`只有该项目的负责人能${what}`); };

/** 项目里已中止、还没合并的任务（按编号）。项目按依赖图推进，"当前任务"不唯一；停滞的出口针对的是这些任务。 */
const abortedOf = (db, projectId) => projectTasks(db, projectId).filter((t) => !t.merged_at && t.status === 'aborted');

// ── 恢复已中止的任务 ─────────────────────────────────────────────────────
/**
 * aborted → 中止前的去处：中止前是 planning / suspended 就回那里；否则有开放事项 → waiting，没有 → running。
 * 该任务若是某个停滞项目的当前任务，项目回 active。
 */
export function reopenTask(db, { taskId, userId, at = now() }) {
  return db.tx(() => {
    const t = mustTask(db, taskId);
    requireTaskLead(db, taskId, userId, '恢复任务');
    if (t.status !== 'aborted') throw new Error(`任务状态为 ${t.status}，只有已中止的任务能恢复`);
    if (t.archived_at) throw new Error('任务已归档，请先取消归档');
    let project = null;
    if (t.project_id) {
      project = mustProject(db, t.project_id);
      if (t.project_order === null) throw new Error('该任务已被重做的任务取代，不能恢复');
      if (project.status === 'aborted') throw new Error('所属项目已中止，任务不能恢复');
      if (project.status === 'done') throw new Error('所属项目已完成，任务不能恢复');
      // 这里不设"开工后项目分支前进过"与"另有任务在进行"就拒（只能重做）的硬约束：那只在任务分支
      // 只能**快进**合并时才必要。合并前会先机械变基 + 重跑全部回归义务，所以**放开**：恢复回来的任务照常排队，轮到它合并时走变基那条路；变基冲突或
      // 重跑不过会当场挂一条结构矛盾事项，那时人再决定改还是重做 —— 比现在就替他决定要诚实。
      //
      // 唯一还留着的：同时开着的任务已经到上限时，恢复它会让并发超过人设的那个数。
      const cap = maxOpenOf(db, project.id);
      const open = chainGraph(db, project.id).filter((x) => x.id !== taskId && x.started && !x.merged_at && x.status !== 'aborted');
      if (open.length >= cap) {
        throw new Error(`项目里同时开着的任务已到上限 ${cap}（${open.map((x) => `#${x.order}`).join('、')}）。`
          + `等其中一个合并后再恢复，或把上限调高（项目设置 → 预算与上限），或改用「重做」`);
      }
    }
    const last = db.one(`SELECT payload FROM audit_log WHERE action='task_aborted' AND target_id=? ORDER BY id DESC LIMIT 1`, taskId);
    let from = null; try { from = JSON.parse(last?.payload || '{}').from ?? null; } catch { /* 旧数据 */ }
    const stillOpen = db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND status IN ('open','escalated')`, taskId).n > 0;
    const to = ['planning', 'suspended'].includes(from) ? from : stillOpen ? 'waiting' : 'running';
    db.run(`UPDATE tasks SET status=? WHERE id=?`, to, taskId);
    // 恢复后事项重新进待办：让守护进程再通知一次。
    db.run(`UPDATE questions SET notified_at=NULL WHERE task_id=? AND status IN ('open','escalated')`, taskId);
    audit(db, { actorKind: 'user', actorId: userId, action: 'task_reopened', targetType: 'task', targetId: taskId, payload: { from: 'aborted', to } });
    let projectResumed = false;
    if (project?.status === 'stalled' && t.project_order > 0) {
      db.run(`UPDATE projects SET status='active' WHERE id=?`, project.id);
      audit(db, { actorKind: 'user', actorId: userId, action: 'project_resumed', targetType: 'project', targetId: project.id, payload: { via: 'task_reopened', taskId, at } });
      projectResumed = true;
    }
    return { taskId, to, projectResumed };
  }, { immediate: true });
}

// ── 项目停滞的出口 ②：重做当前任务 ───────────────────────────────────────
/**
 * 丢弃半成品：按**同一份契约**（宪法块最新版逐字复制）、同一 order、同一 verify_command / verify_extra 新建任务，旧任务退出链。
 * `note`（可选）：人写的"为什么重做 / 这次注意什么"，作为一条补充上下文消息挂到新任务上（人说的话，签人的名）。
 * 旧任务的工作区与分支不删、不推；指针在审计与 supersedes 边里。新任务的工作区由 advanceProject 从项目分支建。
 */
export function redoProjectTask(db, { projectId, userId, taskId = null, note = null, plaintextToken = null, at = now() }) {
  const p = mustProject(db, projectId);
  requireOwner(p, userId, '重做任务');
  if (!['stalled', 'active'].includes(p.status)) throw new Error(`项目状态为 ${p.status}，不能重做任务`);
  // 重做哪个：给了 taskId 就是它；没给 = 已中止任务里编号最小的。
  const abortedTasks = abortedOf(db, projectId);
  const cur = taskId ? projectTasks(db, projectId).find((t) => t.id === taskId) ?? null : abortedTasks[0] ?? null;
  if (!cur) throw new Error(taskId ? '该任务不在这个项目的任务列表里（可能已被重做取代）' : '项目里没有已中止的任务');
  if (cur.merged_at) throw new Error('该任务已合并，不能重做');
  if (cur.status !== 'aborted') throw new Error(`任务状态为 ${cur.status}；只有已中止的任务能重做（进行中的请先中止）`);
  const c = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, cur.id);
  if (!c) throw new Error('当前任务没有契约，无法重做');
  const verify = getParam(db, cur.id, 'task.verify_command');
  const verifyExtra = getParam(db, cur.id, 'task.verify_extra') ?? [];
  const dependsOn = getParam(db, cur.id, 'task.depends_on');   // 编号不变，边原样带过去；下游指向的也是编号，不用改
  // 旧任务先退出链（createTaskFromSpec 自己开事务，不能嵌套；新建失败就放回去）。
  db.run(`UPDATE tasks SET project_order=NULL WHERE id=?`, cur.id);
  let created;
  try {
    // scope_paths 必须带过去：漏了它，重做出来的任务越界判据是空的，悄悄退回散文启发式。
    created = createTaskFromSpec(db, { title: cur.title, goal: c.goal, scope: c.scope, scope_paths: (() => { try { return JSON.parse(c.scope_paths || '[]'); } catch { return []; } })(), definition_of_done: c.definition_of_done,
      constraints: JSON.parse(c.constraints || '[]'), verify_command: Array.isArray(verify) ? verify.join(' ') : undefined },
    { userId: p.owner_id, projectId, order: cur.project_order, verifyExtra, dependsOn: Array.isArray(dependsOn) ? dependsOn : cur.dependsOn, batch: getParam(db, cur.id, 'task.batch') ?? null });
  } catch (e) {
    db.run(`UPDATE tasks SET project_order=? WHERE id=?`, cur.project_order, cur.id);
    throw e;
  }
  db.tx(() => {
    insertEdge(db, created.taskId, cur.id, 'supersedes', at);
    // 契约条款的登记跟着契约走：重做用的是同一份完成定义文本（规则已折在里面），
    // 可 createTaskFromSpec 只从 spec.rules 登记 —— 重做不传 rules，于是新任务的行为规则在清单上查不到，
    // 被判作废过的那几条也就没有标注可挂，而旧任务的那些仍是 active、与新任务并存成重复。
    // 行为规则整行**挪**给新任务（作废状态、裁定出处原样保留）；范围 / 验收命令新任务已经按自己的登记了，旧的作废掉。
    db.run(`UPDATE decision_registry SET task_id=? WHERE task_id=? AND source_kind='contract' AND subject LIKE '%行为规则'`, created.taskId, cur.id);
    // 用取代关系接上而不是直接作废：直接作废的会被当成"人判作废的条款"挂到旧任务页上。
    for (const d of db.all(`SELECT id, subject FROM decision_registry WHERE task_id=? AND source_kind='contract' AND status='active'`, cur.id)) {
      const kind = String(d.subject).split('｜').pop();
      const heir = db.one(`SELECT id FROM decision_registry WHERE task_id=? AND source_kind='contract' AND status='active' AND supersedes IS NULL AND subject LIKE ?`, created.taskId, `%${kind}`);
      if (heir) db.run(`UPDATE decision_registry SET supersedes=? WHERE id=?`, d.id, heir.id);
      voidOne(db, { id: d.id, by: userId ?? null, reason: `任务 #${cur.project_order} 重做，由新任务 ${created.taskId} 的契约接替`, at, supersededBy: heir?.id ?? null });
    }
    db.run(`UPDATE projects SET status='active' WHERE id=?`, projectId);
    audit(db, { actorKind: 'user', actorId: userId, action: 'project_task_redone', targetType: 'project', targetId: projectId,
      payload: { order: cur.project_order, oldTaskId: cur.id, newTaskId: created.taskId, note: note ? String(note).slice(0, 500) : null, at } });
  });
  let messageId = null;
  if (note?.trim() && plaintextToken) {
    const prevWhy = (() => { try { return JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='task_aborted' AND target_id=? ORDER BY id DESC LIMIT 1`, cur.id)?.payload || '{}').why ?? null; } catch { return null; } })();
    messageId = recordMessage(db, { taskId: created.taskId, kind: 'context', plaintextToken,
      body: `本任务是对 ${cur.id} 的重做（上一次已中止${prevWhy ? `，原因：${prevWhy}` : ''}；其半成品未带入）。负责人的说明：${String(note).trim()}` }).messageId ?? null;
  }
  return { projectId, order: cur.project_order, oldTaskId: cur.id, newTaskId: created.taskId, messageId };
}

// ── 项目停滞的出口 ③ / 叫停：中止项目 ────────────────────────────────────
/**
 * 终点。链上未结束的任务（含载体任务）一律中止，其开放事项撤回（项目中止不可反悔，留着只会变成没人该答的待办）；
 * done 但未签收的当前任务不动（没签收就不合并，它只是不再有下文）。已合并的前缀留在项目分支上，仍可交付。
 */
export function abortProject(db, { projectId, userId, why = null, at = now() }) {
  return db.tx(() => {
    const p = mustProject(db, projectId);
    requireOwner(p, userId, '中止项目');
    if (!['proposed', 'active', 'stalled'].includes(p.status)) throw new Error(`项目状态为 ${p.status}，无法中止`);
    const rows = db.all(`SELECT id, status FROM tasks WHERE project_id=? AND project_order IS NOT NULL`, projectId).filter((t) => ABORTABLE.includes(t.status));
    let withdrawn = 0;
    for (const t of rows) {
      db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, t.id);
      withdrawn += Number(db.run(`UPDATE questions SET status='withdrawn', resolved_at=? WHERE task_id=? AND status IN ('open','escalated')`, at, t.id).changes);
      audit(db, { actorKind: 'user', actorId: userId, action: 'task_aborted', targetType: 'task', targetId: t.id, payload: { from: t.status, to: 'aborted', why: '所属项目已中止', via: 'project_aborted' } });
    }
    db.run(`UPDATE projects SET status='aborted' WHERE id=?`, projectId);
    const merged = projectTasks(db, projectId).filter((t) => t.merged_at).length;
    audit(db, { actorKind: 'user', actorId: userId, action: 'project_aborted', targetType: 'project', targetId: projectId,
      payload: { from: p.status, why: why ? String(why).slice(0, 500) : null, tasksAborted: rows.map((t) => t.id), questionsWithdrawn: withdrawn, merged } });
    return { projectId, tasksAborted: rows.map((t) => t.id), questionsWithdrawn: withdrawn, merged };
  }, { immediate: true });
}

// ── 改标题 ───────────────────────────────────────────────────────────────
const cleanTitle = (s) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); if (!t) throw new Error('标题不能为空'); if (t.length > 120) throw new Error('标题不能超过 120 个字符'); return t; };
/** 标题只是显示名：契约、分支名、审计里的旧标题都不动。 */
export function renameTask(db, { taskId, title, userId }) {
  const t = mustTask(db, taskId); requireTaskLead(db, taskId, userId, '修改任务标题');
  const next = cleanTitle(title);
  if (next === t.title) return { taskId, title: next, changed: false };
  db.tx(() => {
    db.run(`UPDATE tasks SET title=? WHERE id=?`, next, taskId);
    audit(db, { actorKind: 'user', actorId: userId, action: 'task_renamed', targetType: 'task', targetId: taskId, payload: { from: t.title, to: next } });
  });
  return { taskId, title: next, changed: true };
}
export function renameProject(db, { projectId, title, userId }) {
  const p = mustProject(db, projectId); requireOwner(p, userId, '修改项目标题');
  const next = cleanTitle(title);
  if (next === p.title) return { projectId, title: next, changed: false };
  db.tx(() => {
    db.run(`UPDATE projects SET title=? WHERE id=?`, next, projectId);
    audit(db, { actorKind: 'user', actorId: userId, action: 'project_renamed', targetType: 'project', targetId: projectId, payload: { from: p.title, to: next } });
  });
  return { projectId, title: next, changed: true };
}

// ── 归档 ─────────────────────────────────────────────────────────────────
export function setTaskArchived(db, { taskId, archived, userId, at = now() }) {
  const t = mustTask(db, taskId); requireTaskLead(db, taskId, userId, archived ? '归档任务' : '取消归档');
  if (t.project_id) throw new Error('项目内的任务不能单独归档；请归档整个项目');
  if (archived && !ENDED.includes(t.status)) throw new Error(`任务状态为 ${t.status}，只有已结束（已完成 / 已中止）的任务能归档；进行中的请先中止`);
  if (!!t.archived_at === !!archived) return { taskId, archived: !!archived, changed: false };
  db.tx(() => {
    db.run(`UPDATE tasks SET archived_at=? WHERE id=?`, archived ? at : null, taskId);
    audit(db, { actorKind: 'user', actorId: userId, action: archived ? 'task_archived' : 'task_unarchived', targetType: 'task', targetId: taskId, payload: {} });
  });
  return { taskId, archived: !!archived, changed: true };
}
export function setProjectArchived(db, { projectId, archived, userId, at = now() }) {
  const p = mustProject(db, projectId); requireOwner(p, userId, archived ? '归档项目' : '取消归档');
  if (archived && !ENDED.includes(p.status)) throw new Error(`项目状态为 ${p.status}，只有已结束（已完成 / 已中止）的项目能归档；进行中的请先中止`);
  if (!!p.archived_at === !!archived) return { projectId, archived: !!archived, changed: false };
  db.tx(() => {
    db.run(`UPDATE projects SET archived_at=? WHERE id=?`, archived ? at : null, projectId);
    audit(db, { actorKind: 'user', actorId: userId, action: archived ? 'project_archived' : 'project_unarchived', targetType: 'project', targetId: projectId, payload: {} });
  });
  return { projectId, archived: !!archived, changed: true };
}
