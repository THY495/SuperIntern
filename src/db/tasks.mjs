// 任务表（tasks）的写入。状态变化不在这里 —— 经 db/state.mjs 的 transition()。
// 原来 6 个文件各写各的 INSERT / UPDATE；"项目规划载体"（project_order 0、标题"项目规划：…"）在三处各抄一份。

import { newId, now } from './db.mjs';

/** 新建一个任务（status 默认 planning）。 */
export function insertTask(db, { id = newId('t'), ownerId, title, status = 'planning', createdAt = now(), projectId = null, projectOrder = null }) {
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,?,?,?,?,?)`,
    id, ownerId, title, status, createdAt, projectId, projectOrder);
  return id;
}

/** 项目规划载体：项目规划器 / 追加规划的花费与审计挂在它名下（project_order 0，不进调度）。 */
export const insertCarrierTask = (db, { id = newId('t'), ownerId, projectId, title, createdAt = now() }) =>
  insertTask(db, { id, ownerId, title, createdAt, projectId, projectOrder: 0 });

export const renameTask = (db, taskId, title) => db.run(`UPDATE tasks SET title=? WHERE id=?`, title, taskId);

/** 归档 / 取消归档（at = null 取消）。 */
export const setTaskArchived = (db, taskId, at) => db.run(`UPDATE tasks SET archived_at=? WHERE id=?`, at, taskId);

/** 合进项目分支的时刻。 */
export const markTaskMerged = (db, taskId, at = now()) => db.run(`UPDATE tasks SET merged_at=? WHERE id=?`, at, taskId);
/** 撤掉合并认领：认领之后快进没成（项目分支没动），回到没合并。 */
export const unmarkTaskMerged = (db, taskId) => db.run(`UPDATE tasks SET merged_at=NULL WHERE id=?`, taskId);

/** 调度位置（null = 暂时移出调度，重做时用）。 */
export const setTaskOrder = (db, taskId, order) => db.run(`UPDATE tasks SET project_order=? WHERE id=?`, order, taskId);

export const setTaskOwner = (db, taskId, userId) => db.run(`UPDATE tasks SET owner_id=? WHERE id=?`, userId, taskId);

/** 交接：某项目里某人名下、还没结束的任务整批换负责人。 */
export function transferOpenProjectTasks(db, { projectId, fromUserId, toUserId, endedStatuses }) {
  db.run(`UPDATE tasks SET owner_id=? WHERE project_id=? AND owner_id=? AND status NOT IN (${endedStatuses.map(() => '?').join(',')})`,
    toUserId, projectId, fromUserId, ...endedStatuses);
}
