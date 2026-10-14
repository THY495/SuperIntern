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
 * 参数写入的唯一入口：同一作用域 + 键，先把旧现值作废、再写新值，**一个事务里做完**。
 * 原来这两句散在 8 个文件里，一半没包事务 —— 两句之间进程死了，这个键就一行现值都没有，读的人悄悄退回默认值
 * （上限、出网名单退回默认，就是闸门悄悄松了）。v31 起库层唯一索引保证同一作用域 + 键同一时刻只有一行现值。
 *   作用域：{ taskId } 任务层 / { projectId } 项目层 / 两个都不给 = 部署层
 *   by: { kind: 'user'|'agent', id }   governance: 'constitutional'|'execution'
 *   value === undefined：只作废、不写新值（清掉这一层）
 * @returns {string|null} 新行 id
 */
export function writeParam(db, { taskId = null, projectId = null, key, value, by, governance, layer = null, at = now() }) {
  if (!by?.kind) throw new Error(`writeParam(${key})：要说明是谁写的（by.kind）`);
  if (!governance && value !== undefined) throw new Error(`writeParam(${key})：要说明治理类别（governance）`);
  const lay = layer ?? (taskId ? 'task' : projectId ? 'project' : 'system');
  return db.tx(() => {
    db.run(`UPDATE params SET superseded_at=?, valid_to=? WHERE task_id IS ? AND project_id IS ? AND key=? AND superseded_at IS NULL`, at, at, taskId, projectId, key);
    if (value === undefined) return null;
    const id = newId('p');
    db.run(`INSERT INTO params (id,task_id,project_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, taskId, projectId, key, JSON.stringify(value), lay, governance, by.kind, by.id ?? null, at, at);
    return id;
  });
}

/** 只作废、不写新值。 */
export const clearParam = (db, { taskId = null, projectId = null, key, by = { kind: 'agent' }, at = now() }) => writeParam(db, { taskId, projectId, key, value: undefined, by, at });

/**
 * 写一个任务层参数（先把旧值作废）。
 *   by: { kind: 'user'|'agent', id }   governance: 'constitutional'|'execution'   layer: 'task'（默认）
 */
export function setParam(db, { taskId, key, value, by, governance, layer = 'task' }) {
  if (!by?.kind) throw new Error(`setParam(${key})：要说明是谁写的（by.kind）`);
  if (!governance) throw new Error(`setParam(${key})：要说明治理类别（governance）`);
  return writeParam(db, { taskId, key, value, by, governance, layer });
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
  return writeParam(db, { projectId, key, value: value === null ? undefined : value, by, governance, layer: 'project' });
}
