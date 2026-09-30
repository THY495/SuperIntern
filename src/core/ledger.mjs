// 花费入库。LlmClient 只在内存里记账，落库是这一层的事。

import { now, audit } from '../db/db.mjs';
import { tl, contentLang } from '../i18n/index.mjs';

/**
 * 把客户端内存账本**排空**并写进 usage_ledger。
 *
 * ⚠️ 排空（splice）而非读取：预算闸门按库里的总额判定，同一条内存条目若被
 * 两次落库，闸门就会提前关闸；若一次都没落库，闸门等于不存在。排空使
 * "调用过 = 记过账"成为不变量，漏调用时账面为 0 是可见的，不是似是而非的。
 *
 * @returns {{rows:number, microUsd:number}}
 */
export function flushLedger(db, client, { taskId, nodeId = null, role }) {
  // 厂商代答（响应 model ≠ 请求 model）：客户端攒着，这里落审计 —— 它是目录漂移的零成本信号，
  // 不改账（账按请求的目录键算，代答的模型价格未知）。同一 (键, 代答模型) 一个客户端寿命内只记一次。
  for (const d of (client.drifts ?? []).splice(0)) {
    audit(db, { actorKind: 'system', action: 'model_drift', targetType: 'task', targetId: taskId,
      payload: { ...d, role, nodeId, hint: tl(contentLang(db), '请求 {requested} 实际由 {served} 代答 —— 目录键 {key} 可能已退役或改名，跑 node src/cli.mjs catalog check',
        { requested: d.requested, served: d.served, key: d.key }) } });
  }
  const entries = client.ledger.splice(0, client.ledger.length);
  let microUsd = 0;
  for (const e of entries) {
    microUsd += e.microUsd;
    db.run(`INSERT INTO usage_ledger
              (task_id,node_id,role,model_tier,provider,model_id,upstream,
               input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,
               micro_usd,billing,billing_fallback,ts)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      taskId, nodeId, role, e.tier, e.vendor, e.model, e.upstream ?? null,
      e.inputTokens, e.cacheReadTokens, e.cacheWriteTokens, e.outputTokens, e.reasoningTokens,
      e.microUsd, e.billing, e.billingFallback ? 1 : 0, now());
  }
  return { rows: entries.length, microUsd };
}

/** 任务累计花费（微美元）。预算闸门读的就是这个。 */
export const taskSpendMicroUsd = (db, taskId) =>
  db.one(`SELECT COALESCE(SUM(micro_usd),0) AS total FROM usage_ledger WHERE task_id=?`, taskId).total;
