// params 表的读写小工具。
//
// 库层 CHECK：governance_class='constitutional' 只能由 set_by_kind='user' 写 —— 宪法层参数 agent 永不自改。
// 所以这里不给默认的 governance：谁写、以什么身份写，调用方必须说清；说不清的就落不进去。

import { newId, now } from '../db/db.mjs';

/** 读一个参数（JSON 解析后）；没有就 null。 */
export const getParam = (db, taskId, key) => {
  const row = db.one(`SELECT value FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, taskId, key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
};

/**
 * 写一个参数（先把旧值作废）。
 *   by: { kind: 'user'|'agent', id }   governance: 'constitutional'|'execution'   layer: 'task'（默认）
 */
export function setParam(db, { taskId, key, value, by, governance, layer = 'task' }) {
  if (!by?.kind) throw new Error(`setParam(${key})：要说明是谁写的（by.kind）`);
  if (!governance) throw new Error(`setParam(${key})：要说明治理类别（governance）`);
  const t = now();
  const id = newId('p');
  db.run(`UPDATE params SET superseded_at=?, valid_to=? WHERE task_id=? AND key=? AND superseded_at IS NULL`, t, t, taskId, key);
  db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, id, taskId, key, JSON.stringify(value), layer, governance, by.kind, by.id ?? null, t, t);
  return id;
}

// ── 项目层（v16）──────────────────────────────────────────────────────
// 项目层的行 task_id 为 NULL、project_id 非 NULL，layer='project'。查它要**同时**给两个条件：
// 只写 `task_id IS NULL` 会同时捞到部署级的行，只写 `project_id=?` 在语义上倒是够，但两边写法一致
// 才不会有人照着其中一条改出另一条的 bug。

/** 读一个项目层参数；没设过就 null。**不回落**到部署默认 —— 回落是调用方的事（要说清"来自哪一层"）。 */
export const getProjectParam = (db, projectId, key) => {
  const row = db.one(`SELECT value FROM params WHERE project_id=? AND task_id IS NULL AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, projectId, key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
};

/** 写一个项目层参数。`value === null` = 清掉这一层（回落到部署默认），只作废旧行、不写新行。 */
export function setProjectParam(db, { projectId, key, value, by, governance }) {
  if (!by?.kind) throw new Error(`setProjectParam(${key})：要说明是谁写的（by.kind）`);
  if (!governance) throw new Error(`setProjectParam(${key})：要说明治理类别（governance）`);
  const t = now();
  db.run(`UPDATE params SET superseded_at=?, valid_to=? WHERE project_id=? AND task_id IS NULL AND key=? AND superseded_at IS NULL`, t, t, projectId, key);
  if (value === null) return null;
  const id = newId('p');
  db.run(`INSERT INTO params (id,task_id,project_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
          VALUES (?,NULL,?,?,?,'project',?,?,?,?,?)`, id, projectId, key, JSON.stringify(value), governance, by.kind, by.id ?? null, t, t);
  return id;
}
