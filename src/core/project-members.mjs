// 项目权限：负责人按项目派发。
//
// 三件事住在这里：项目成员名单（带"能不能加任务"和一句职能说明）、项目可见性、项目目标 / 完成定义的修改。
// **"谁答哪类问题"不在这里** —— 那是按项目键的路由表（routing.mjs），成员名单不改变任何一条事项的收件人。
// 反过来，被路由表点到的人即使不是项目成员也看得见这个项目（否则事项送到了人却打不开）。
//
// 身份层级不变：管理员（users.role='lead'）是部署级角色，看得见所有项目，但对不属于自己的项目没有任何写权限
// （唯一的例外仍是强制交接，见 handover.mjs）。旁观者可以是项目成员（为了可见性），但不能加任务。

import { now, audit } from '../db/db.mjs';
import { recordGoalChange } from './decisions.mjs';
import { I18nError } from '../i18n/index.mjs';

export const VISIBILITIES = { all: '全体成员可见', members: '仅本项目成员可见' };

const projectOf = (db, projectId) => {
  const p = db.one(`SELECT id, owner_id, title, visibility, goal, done_definition, status FROM projects WHERE id=?`, projectId);
  if (!p) throw new I18nError('没有这个项目：{id}', { id: projectId });
  return p;
};
const requireOwner = (p, userId) => { if (p.owner_id !== userId) throw new I18nError('只有该项目的负责人能执行此操作'); };

/** 项目成员（不含负责人本人）。 */
export const listMembers = (db, projectId) => db.all(
  `SELECT m.user_id, u.display_name, u.role, u.disabled_at, m.can_add_tasks, m.note, m.added_at
     FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY m.added_at`, projectId)
  .map((m) => ({ userId: m.user_id, name: m.display_name, role: m.role, disabled: !!m.disabled_at, canAddTasks: !!m.can_add_tasks, note: m.note, addedAt: m.added_at }));

/** 加成员或改成员（同一个入口，幂等）。 */
export function setMember(db, { projectId, userId, canAddTasks = false, note = '', by }) {
  const p = projectOf(db, projectId);
  requireOwner(p, by);
  const u = db.one(`SELECT id, role, disabled_at FROM users WHERE id=?`, userId);
  if (!u) throw new I18nError('没有这个用户：{id}', { id: userId });
  if (u.disabled_at) throw new I18nError('该用户已停用');
  if (u.id === p.owner_id) throw new I18nError('负责人不需要加入成员名单：负责人拥有该项目的全部权限');
  if (canAddTasks && u.role === 'observer') throw new I18nError('旁观者不能添加任务；可以只把他加为成员（可见），或先在"成员"页把他改为成员');
  const text = String(note ?? '').trim().slice(0, 200);
  const at = now();
  const had = db.one(`SELECT can_add_tasks, note FROM project_members WHERE project_id=? AND user_id=?`, projectId, userId);
  db.run(`INSERT INTO project_members (project_id,user_id,can_add_tasks,note,added_by,added_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(project_id,user_id) DO UPDATE SET can_add_tasks=excluded.can_add_tasks, note=excluded.note`,
    projectId, userId, canAddTasks ? 1 : 0, text, by, at);
  audit(db, { actorKind: 'user', actorId: by, action: had ? 'project_member_changed' : 'project_member_added', targetType: 'project', targetId: projectId,
    payload: { userId, canAddTasks: !!canAddTasks, note: text, ...(had ? { before: { canAddTasks: !!had.can_add_tasks, note: had.note } } : {}) } });
  return { projectId, userId, canAddTasks: !!canAddTasks, note: text, created: !had };
}

export function removeMember(db, { projectId, userId, by }) {
  const p = projectOf(db, projectId);
  requireOwner(p, by);
  const had = db.one(`SELECT 1 FROM project_members WHERE project_id=? AND user_id=?`, projectId, userId);
  if (!had) throw new I18nError('该用户不是这个项目的成员');
  db.run(`DELETE FROM project_members WHERE project_id=? AND user_id=?`, projectId, userId);
  audit(db, { actorKind: 'user', actorId: by, action: 'project_member_removed', targetType: 'project', targetId: projectId, payload: { userId } });
  return { projectId, userId, removed: true };
}

export function setVisibility(db, { projectId, visibility, by }) {
  const p = projectOf(db, projectId);
  requireOwner(p, by);
  if (!VISIBILITIES[visibility]) throw new I18nError('可见性只能是：{values}', { values: Object.keys(VISIBILITIES).join(' / ') });
  if (p.visibility === visibility) return { projectId, visibility, changed: false };
  db.run(`UPDATE projects SET visibility=? WHERE id=?`, visibility, projectId);
  audit(db, { actorKind: 'user', actorId: by, action: 'project_visibility_changed', targetType: 'project', targetId: projectId, payload: { from: p.visibility, to: visibility } });
  return { projectId, visibility, changed: true };
}

/** 能不能给项目加任务：负责人，或带 can_add_tasks 的未停用非旁观者成员。 */
export function canAddTasks(db, projectId, userId) {
  const p = db.one(`SELECT owner_id FROM projects WHERE id=?`, projectId);
  if (!p || !userId) return false;
  if (p.owner_id === userId) return true;
  return !!db.one(`SELECT 1 FROM project_members m JOIN users u ON u.id=m.user_id
                    WHERE m.project_id=? AND m.user_id=? AND m.can_add_tasks=1 AND u.disabled_at IS NULL AND u.role<>'observer'`, projectId, userId);
}

/** 与这个项目有关：负责人、成员、或它的待决事项点到的人（收件人 / 只知会）。"只看与我有关"与可见性共用。 */
export function involvedIn(db, projectId, userId) {
  if (!userId) return false;
  const p = db.one(`SELECT owner_id FROM projects WHERE id=?`, projectId);
  if (!p) return false;
  if (p.owner_id === userId) return true;
  if (db.one(`SELECT 1 FROM project_members WHERE project_id=? AND user_id=?`, projectId, userId)) return true;
  const qs = db.all(`SELECT q.addressed_to, q.informed FROM questions q JOIN tasks t ON t.id=q.task_id
                      WHERE t.project_id=? AND q.status IN ('open','escalated')`, projectId);
  return qs.some((q) => JSON.parse(q.addressed_to || '[]').includes(userId) || JSON.parse(q.informed || '[]').includes(userId));
}

/** 看不看得见：'all' 谁都行；'members' 只有管理员与 involvedIn 的人。 */
export function canSeeProject(db, projectId, userId) {
  const p = db.one(`SELECT visibility FROM projects WHERE id=?`, projectId);
  if (!p) return false;
  if (p.visibility !== 'members') return true;
  if (!userId) return false;
  if (db.one(`SELECT 1 FROM users WHERE id=? AND role='lead' AND disabled_at IS NULL`, userId)) return true;
  return involvedIn(db, projectId, userId);
}

/** 任务看不看得见：跟随所属项目；旧的独立任务一律可见（与此前一致）。 */
export function canSeeTask(db, taskId, userId) {
  const t = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId);
  if (!t) return false;
  return t.project_id ? canSeeProject(db, t.project_id, userId) : true;
}

/** 改项目目标 / 完成定义。只改文字、留审计（前后全文）；不动任何任务的契约；改动同时登记成一条"决定"。 */
export function editProjectGoal(db, { projectId, goal = null, doneDefinition = null, by }) {
  const p = projectOf(db, projectId);
  requireOwner(p, by);
  if (['aborted'].includes(p.status)) throw new I18nError('项目已中止，不能修改目标');
  const g = goal === null ? p.goal : String(goal).trim();
  const d = doneDefinition === null ? p.done_definition : String(doneDefinition).trim();
  if (!g) throw new I18nError('项目目标不能为空');
  if (!d) throw new I18nError('完成定义不能为空');
  if (g === p.goal && d === p.done_definition) return { projectId, changed: false };
  db.run(`UPDATE projects SET goal=?, done_definition=? WHERE id=?`, g, d, projectId);
  audit(db, { actorKind: 'user', actorId: by, action: 'project_goal_changed', targetType: 'project', targetId: projectId,
    payload: { before: { goal: p.goal, doneDefinition: p.done_definition }, after: { goal: g, doneDefinition: d } } });
  // 决定登记：目标只有一份，新的一定取代旧的 —— recordGoalChange 自己把上一条置作废。
  recordGoalChange(db, { projectId, goal: g, doneDefinition: d, userId: by });
  return { projectId, changed: true };
}
