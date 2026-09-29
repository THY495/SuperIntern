// 自动升档：同一节点重试 ≥ 2 次 → 升一档重试；**升档前过预算闸门**（花费 + 挂钟时间）。
//
// 设计原文：升档分两级，先加推理强度再换重档模型；闸门同时看花费金额与挂钟时间；
// 剩余预算不足以支撑重档重试时不升档，直接"汇报 + 提问"。
//
// 这里的取舍：
//   - **推理强度那一级跳过**：执行器的默认推理强度是 'high'（executor.mjs；档位级推理强度可在绑定里覆盖，但那是部署配置，
//     不是升档动作），没有更高的档可加。把基线降到 medium 再爬回 high 会改变全部真跑的基线，没有证据支持这样做。记为有意偏离。
//   - 升档只上一档（light→standard→heavy），heavy 不再升。`--tier` 显式覆盖时不升档（人说了算）。
//   - 闸门口径：预计花费 = 该节点此前每次尝试的平均花费 × 目标/当前档的输出单价比（目录里有单价）；
//     预计时长 = 上一次尝试的时长 × 1.5。任一维剩余不够 → 不升档，走该维度的触顶路径
//     （raiseLimitQuestion + waiting），提问正文说清是"升档前闸门"拦的，不是任务本身触顶。
//   - "这次失败是不是模型不够强"判不了。重试 ≥2 是代理信号，不是判断；
//     所以升档一定留审计（node_escalated），人能看见"钱是这么花上去的"。

import { now, audit } from '../db/db.mjs';
import { limitOf, priorRuntimeMs } from './limits.mjs';
import { taskSpendMicroUsd } from './ledger.mjs';

export const TIER_ORDER = ['light', 'standard', 'heavy'];
export const ESCALATE_AFTER_RETRIES = 2;
const MIN_ESTIMATE_MICRO = 50_000;   // $0.05：没花过钱的节点也按这个数过门

/** 目标档 / 当前档的输出单价比；目录里查不到就按 3。 */
export function priceRatio(from, to, binding, catalog) {
  try {
    const a = catalog[binding[from]]?.pricing?.output, b = catalog[binding[to]]?.pricing?.output;
    return a && b ? Math.max(1, b / a) : 3;
  } catch { return 3; }
}

/**
 * @returns {{tier, escalated:boolean, from?, estimateMicro?, blocked?:boolean, breach?:object, why?:string}}
 */
export function escalationFor(db, { taskId, node, binding, catalog, ctx = {}, at = now() }) {
  const base = node.model_tier;
  const idx = TIER_ORDER.indexOf(base);
  if ((node.retry_count ?? 0) < ESCALATE_AFTER_RETRIES) return { tier: base, escalated: false };
  if (idx < 0 || idx === TIER_ORDER.length - 1) return { tier: base, escalated: false, why: 'heavy 已是最高档' };
  const target = TIER_ORDER[idx + 1];

  // 花费闸门
  const nodeSpent = db.one(`SELECT COALESCE(SUM(micro_usd),0) AS m FROM usage_ledger WHERE node_id=?`, node.id).m;
  const perAttempt = nodeSpent / Math.max(1, node.retry_count);
  const estimateMicro = Math.max(MIN_ESTIMATE_MICRO, Math.round(perAttempt * priceRatio(base, target, binding, catalog)));
  const budget = limitOf(db, taskId, 'limit.budget_micro_usd');
  const spent = taskSpendMicroUsd(db, taskId);
  if (budget - spent < estimateMicro) {
    return { tier: base, escalated: false, blocked: true, breach: {
      key: 'limit.budget_micro_usd', label: '任务花费', actual: spent + estimateMicro, limit: budget,
      human: `升档前预算闸门：节点「${node.title}」已失败 ${node.retry_count} 次，升到 ${target} 档重试预计再花 `
        + `$${(estimateMicro / 1e6).toFixed(4)}，而剩余预算只有 $${((budget - spent) / 1e6).toFixed(4)}。不升档、不重试，先问人。` } };
  }
  // 挂钟闸门：上一次尝试从 started_at 到最近一次失败审计的时长
  const lastFail = db.one(`SELECT ts FROM audit_log WHERE target_id=? AND action IN ('node_stalled','node_crashed')
                           ORDER BY ts DESC LIMIT 1`, node.id)?.ts ?? null;
  const lastMs = lastFail && node.started_at && lastFail > node.started_at ? lastFail - node.started_at : null;
  if (lastMs) {
    const runtimeLimit = limitOf(db, taskId, 'limit.runtime_ms');
    const used = priorRuntimeMs(db, taskId) + (at - (ctx.startedAt ?? at));
    const need = Math.round(lastMs * 1.5);
    if (runtimeLimit - used < need) {
      return { tier: base, escalated: false, blocked: true, breach: {
        key: 'limit.runtime_ms', label: '累计运行时长', actual: used + need, limit: runtimeLimit,
        human: `升档前时长闸门：节点「${node.title}」上次尝试跑了 ${(lastMs / 60000).toFixed(1)} 分钟，升到 ${target} 档预计 `
          + `${(need / 60000).toFixed(1)} 分钟，而剩余时长只有 ${((runtimeLimit - used) / 60000).toFixed(1)} 分钟。不升档，先问人。` } };
    }
  }
  return { tier: target, escalated: true, from: base, estimateMicro, remainingMicro: budget - spent };
}

/** 升档落库：节点档位改成目标档（下次重试也沿用），记时间戳与审计。 */
export function recordEscalation(db, { taskId, node, esc }) {
  const t = now();
  db.run(`UPDATE nodes SET model_tier=?, tier_escalated_at=? WHERE id=?`, esc.tier, t, node.id);
  audit(db, { actorKind: 'system', action: 'node_escalated', targetType: 'node', targetId: node.id,
    payload: { taskId, from: esc.from, to: esc.tier, retryCount: node.retry_count,
      estimateMicro: esc.estimateMicro, remainingMicro: esc.remainingMicro, pid: process.pid } });
}
