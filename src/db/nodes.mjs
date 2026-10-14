// 步骤表（nodes）的写入。状态变化不在这里 —— 经 db/state.mjs 的 transition()。
// 原来 5 个文件各写各的 INSERT（规划器、修订、编排器补的三种系统步骤）与 UPDATE（升档、看板改优先级）。

import { newId, now } from './db.mjs';

/** 新建一个步骤（status 一律 pending —— 进 ready / running 走状态机）。 */
export function insertNode(db, { id = newId('n'), taskId, title, spec, acceptance, riskTier = 'low', modelTier = 'standard', uiChecks = null, createdAt = now() }) {
  const ui = cleanUiChecks(uiChecks);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,ui_checks,created_at) VALUES (?,?,?,?,?,'pending',?,?,?,?)`,
    id, taskId, title, spec, acceptance, riskTier, modelTier, ui.length ? JSON.stringify(ui) : null, createdAt);
  return id;
}

/** 界面条目：去空、去重、每条一句，至多 8 条 */
export const UI_CHECKS_MAX = 8;
export function cleanUiChecks(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, UI_CHECKS_MAX);
}
/** 节点的界面条目（库里是 JSON 文本或 NULL） */
export function uiChecksOf(node) {
  if (!node?.ui_checks) return [];
  try { return cleanUiChecks(JSON.parse(node.ui_checks)); } catch { return []; }
}

/** 升档：换模型档位，记下升档时刻。 */
export const escalateNodeTier = (db, nodeId, tier, at = now()) => db.run(`UPDATE nodes SET model_tier=?, tier_escalated_at=? WHERE id=?`, tier, at, nodeId);

export const setNodePriority = (db, nodeId, priority) => db.run(`UPDATE nodes SET priority=? WHERE id=?`, priority, nodeId);
