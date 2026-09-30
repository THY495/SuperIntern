// 提问超时链。
//
// 设计：Ⅰ 级超时 → 执行默认动作 → 下次汇报中标注；Ⅱ 级超时 → 升级至另一合格应答人 →
// 仍无人应则退保守默认；Ⅲ 级无默认、无限期。默认初值：Ⅰ 30 分钟；Ⅱ 2 小时升级、8 小时退默认。
//
// 光有 `timeout_at` 列、**没东西触发它**的话，一个 Ⅰ 级问题能让任务永远等下去。
// 无人值守下这是正确性问题不是体验问题。
//
// 谁来触发：编排器**每一轮开头**扫一次（`run` 就是恢复路径），另有 `cli tick` 给 cron 用 ——
// 编排器挂起时进程已经退出，30 分钟后得有人再起一个进程。两条路走的都是这里的 sweepTimeouts。
//
// 超时答复是**系统写的**，不是人：messages 行 sender_id=NULL、trust_label='agent-generated'，
// 正文带 [超时默认] 前缀。执行器复工时看得见这条不是人答的（装配层显示 trust 标签），
// 汇报生成器把它列进"自作主张"—— 超时走默认正是"人监督价值最高"的那类事。
//
// "升级至另一合格应答人"：单用户部署下没有另一个人。升级 = 状态置 escalated + 审计 + 通知钩子再响一次，
// 重新计时到保守默认。多用户（权限画像）落地后这里换成真的改 addressed_to。

import { newId, now, audit, insertEdge } from '../db/db.mjs';
import { advanceRoute } from './routing.mjs';
import { tl, contentLang } from '../i18n/index.mjs';

export const TIMEOUT_DEFAULTS_MS = {
  l1: 30 * 60_000,          // Ⅰ 级 → 默认动作
  l2: 2 * 3600_000,         // Ⅱ 级 → 升级
  l2_fallback: 6 * 3600_000, // 升级之后再等这么久 → 保守默认（合计 8 小时，与设计一致）
};
export const TIMEOUT_KEYS = {
  l1: 'question.timeout_ms.l1', l2: 'question.timeout_ms.l2', l2_fallback: 'question.timeout_ms.l2_fallback',
};

const paramMs = (db, taskId, which) => {
  const row = db.one(`SELECT value FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL
                      ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, taskId, TIMEOUT_KEYS[which]);
  const v = row ? Number(JSON.parse(row.value)) : NaN;
  return Number.isFinite(v) && v > 0 ? v : TIMEOUT_DEFAULTS_MS[which];
};

/** 某级问题从提出到第一次超时的毫秒数；Ⅲ 级 null（库层 CHECK 也不允许它有 timeout_at）。 */
export function timeoutFor(db, taskId, level) {
  if (level === 1) return paramMs(db, taskId, 'l1');
  if (level === 2) return paramMs(db, taskId, 'l2');
  return null;
}

/**
 * 扫一遍到期的问题，按级别处置。幂等：处置过的问题状态已变，不会再被扫到。
 *
 * @returns {{defaulted: object[], escalated: object[], stuck: object[], rerouted: object[]}}
 */
export function sweepTimeouts(db, { taskId = null, at = now(), onEvent = () => {} } = {}) {
  // 已中止任务的事项不扫（中止可反悔 —— 中止期间不替人做默认决定；恢复后已过期的在下一轮照常处理）。
  const due = db.all(`SELECT * FROM questions WHERE status IN ('open','escalated') AND timeout_at IS NOT NULL
                      AND timeout_at <= ? AND task_id NOT IN (SELECT id FROM tasks WHERE status='aborted') ${taskId ? 'AND task_id=?' : ''} ORDER BY timeout_at`, ...(taskId ? [at, taskId] : [at]));
  const out = { defaulted: [], escalated: [], stuck: [], rerouted: [] };
  const L = contentLang(db);
  for (const q of due) {
    if (q.level === 3) continue;   // 结构上到不了这里（CHECK），留着当断言
    if (q.level === 2 && q.status === 'open') {
      // Ⅱ 级第一次到期：升级。没有别的应答人时升级 = 再等一段、再喊一次。
      const fallback = paramMs(db, q.task_id, 'l2_fallback');
      db.tx(() => {
        db.run(`UPDATE questions SET status='escalated', escalated_at=?, timeout_at=? WHERE id=?`, at, at + fallback, q.id);
        audit(db, { actorKind: 'system', action: 'question_escalated', targetType: 'question', targetId: q.id,
          payload: { taskId: q.task_id, nodeId: q.node_id, level: 2, askedAt: q.asked_at, timedOutAt: q.timeout_at,
            nextTimeoutAt: at + fallback, hasDefault: !!q.default_action } });
      });
      const ev = { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: 2, nextTimeoutAt: at + fallback, text: q.text };
      out.escalated.push(ev); onEvent({ type: 'question_escalated', ...ev });
      continue;
    }
    if (!q.default_action) {
      // Ⅱ 级升级后仍无人答、又没有保守默认可退：只能继续挂着。记一次审计，timeout_at 清掉免得每轮都记。
      db.tx(() => {
        db.run(`UPDATE questions SET timeout_at=NULL WHERE id=?`, q.id);
        audit(db, { actorKind: 'system', action: 'question_stuck', targetType: 'question', targetId: q.id,
          payload: { taskId: q.task_id, nodeId: q.node_id, level: q.level, why: tl(L, '升级后仍无人答，且没有默认动作可退；分支继续挂起') } });
      });
      const ev = { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: q.level, text: q.text };
      out.stuck.push(ev); onEvent({ type: 'question_stuck', ...ev });
      continue;
    }
    // Ⅰ 级到期，或 Ⅱ 级升级后再到期：走默认动作。答复由系统写，不冒充人。
    const ev = applyDefault(db, q, at, tl(L, '问题在 {level} 级超时窗口内无人答复', { level: q.level === 1 ? 'Ⅰ' : 'Ⅱ' }));
    out.defaulted.push(ev); onEvent({ type: 'question_defaulted', ...ev });
  }

  // ── 路由行时限 —— 与级别的 timeout_at 是两口钟 ─────────────────────────
  // 到期按当前行的超时兜底走：next = 转下一行（换收件人，不替人决定）；default = 按事项的默认动作
  // （没有默认动作的事项 —— Ⅲ 级 —— 只能继续挂）；hang 的行根本不会有 route_due_at。
  const routeDue = db.all(`SELECT * FROM questions WHERE status IN ('open','escalated') AND route_due_at IS NOT NULL
                           AND route_due_at <= ? AND task_id NOT IN (SELECT id FROM tasks WHERE status='aborted') ${taskId ? 'AND task_id=?' : ''} ORDER BY route_due_at`, ...(taskId ? [at, taskId] : [at]));
  for (const q of routeDue) {
    const route = JSON.parse(q.route || 'null');
    const actions = new Set((route?.rows ?? []).map((r) => r.timeout_action));
    if (actions.has('next')) {
      const from = JSON.parse(q.addressed_to || '[]');
      const r = db.tx(() => {
        const adv = advanceRoute(db, { questionId: q.id, at });
        if (!adv) db.run(`UPDATE questions SET route_due_at=NULL WHERE id=?`, q.id);
        audit(db, { actorKind: 'system', action: adv ? 'question_rerouted' : 'question_stuck', targetType: 'question', targetId: q.id,
          payload: { taskId: q.task_id, nodeId: q.node_id, decisionType: q.decision_type, from, to: adv?.answerers ?? null, stage: adv?.route?.stage ?? null,
            nextDueAt: adv?.dueAt ?? null, why: adv ? tl(L, '路由行时限到，转下一行') : tl(L, '路由行时限到但没有下一行；继续挂起') } });
        return adv;
      });
      const ev = { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: q.level, decisionType: q.decision_type, from, to: r?.answerers ?? [], text: q.text };
      if (r) { out.rerouted.push(ev); onEvent({ type: 'question_rerouted', ...ev }); }
      else { out.stuck.push(ev); onEvent({ type: 'question_stuck', ...ev }); }
      continue;
    }
    if (actions.has('default') && q.default_action) {
      const ev = applyDefault(db, q, at, tl(L, '路由行时限到，收件人为空或无人答复'));
      out.defaulted.push(ev); onEvent({ type: 'question_defaulted', ...ev });
      continue;
    }
    db.tx(() => {
      db.run(`UPDATE questions SET route_due_at=NULL WHERE id=?`, q.id);
      audit(db, { actorKind: 'system', action: 'question_stuck', targetType: 'question', targetId: q.id,
        payload: { taskId: q.task_id, nodeId: q.node_id, level: q.level, why: tl(L, '路由行时限到，兜底是 default 但事项没有默认动作；继续挂起') } });
    });
    const ev = { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: q.level, text: q.text };
    out.stuck.push(ev); onEvent({ type: 'question_stuck', ...ev });
  }
  return out;
}

/** 按事项登记的默认动作了结它。答复由系统写（sender NULL、agent-generated），正文带 [超时默认] 前缀。 */
function applyDefault(db, q, at, why) {
  const mid = newId('m');
  db.tx(() => {
    db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
            VALUES (?,?,NULL,?,'answer','explicit','normal','explicit','agent-generated',NULL,?)`,
    mid, q.task_id, tl(contentLang(db), '[超时默认] {why}，按你提出时登记的默认动作执行：\n{action}', { why, action: q.default_action }), at);
    insertEdge(db, mid, q.id, 'answers', at);
    db.run(`INSERT INTO answers (id,question_id,user_id,message_id,body,stance,created_at) VALUES (?,?,NULL,?,?,'answer',?)`, newId('a'), q.id, mid, q.default_action, at);
    db.run(`UPDATE questions SET status='defaulted', resolved_at=?, route_due_at=NULL WHERE id=?`, at, q.id);
    if (q.node_id) db.run(`UPDATE nodes SET status='pending' WHERE id=? AND status='blocked'`, q.node_id);
    const stillOpen = db.one(`SELECT count(*) AS n FROM questions WHERE task_id=? AND status IN ('open','escalated')`, q.task_id).n;
    if (!stillOpen) db.run(`UPDATE tasks SET status='running' WHERE id=? AND status='waiting'`, q.task_id);
    audit(db, { actorKind: 'system', action: 'question_defaulted', targetType: 'question', targetId: q.id,
      payload: { taskId: q.task_id, nodeId: q.node_id, level: q.level, messageId: mid, defaultAction: q.default_action, why,
        askedAt: q.asked_at, timedOutAt: q.timeout_at, escalatedAt: q.escalated_at } });
  });
  return { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: q.level, messageId: mid, defaultAction: q.default_action, text: q.text };
}
