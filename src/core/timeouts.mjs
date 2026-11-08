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
import { insertMessage } from '../db/messages.mjs';
import { advanceRoute } from './routing.mjs';
import { clearQuestionTimeout, clearRouteDue, isFastDefault } from './questions.mjs';
import { insertAnswer } from './answers.mjs';
import { tl, contentLang } from '../i18n/index.mjs';
import { transition } from '../db/state.mjs';
import { emitSignal } from './signals.mjs';

/** 超时替人做了什么，都要让人知道（底线是通知）：原来按默认结案、挂住不动完全不推，升级只推部署通道。
 *  收件人 = 这条事项原来该答的人 + 任务负责人（+ 调用方补的）。在事务里调：与状态变化同进同退。 */
function tellTimeout(db, name, q, { title, text, extra = [] }) {
  emitSignal(db, name, { to: [...JSON.parse(q.addressed_to || '[]'), 'owner', ...extra], taskId: q.task_id, ref: q.id,
    title: `[SuperIntern] ${title}`, text: `${text}\n\n${String(q.text).slice(0, 300)}` });
}
const headOf = (q) => String(q.text).split('\n')[0].slice(0, 60);

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
 * 并发：扫的不止一处 —— 守护进程每拍扫全部，每个编排器子进程每轮扫自己的任务；人也随时在答。
 * 所以到期清单只是候选：每一条在自己的事务里（先拿写锁）重读，状态或时限已经变了（别人答了、别人先扫了）就跳过。
 * 原来是事务外读、事务里盲写：两个扫描者撞上各写一次默认答复（同一件事通知两遍、"替你定的"记两条）；
 * 人刚答完、扫描再写"已按默认"抛错，整轮扫描连同编排器这一轮一起中断。一条出错只记一行审计，不连累别的。
 *
 * @returns {{defaulted: object[], escalated: object[], stuck: object[], rerouted: object[]}}
 */
export function sweepTimeouts(db, { taskId = null, at = now(), onEvent = () => {} } = {}) {
  // 已中止任务的事项不扫（中止可反悔 —— 中止期间不替人做默认决定；恢复后已过期的在下一轮照常处理）。
  const due = db.all(`SELECT * FROM questions WHERE status IN ('open','escalated') AND timeout_at IS NOT NULL
                      AND timeout_at <= ? AND task_id NOT IN (SELECT id FROM tasks WHERE status='aborted') ${taskId ? 'AND task_id=?' : ''} ORDER BY timeout_at`, ...(taskId ? [at, taskId] : [at]));
  const out = { defaulted: [], escalated: [], stuck: [], rerouted: [] };
  const L = contentLang(db);
  /** 在事务里重读；仍是扫描时看到的样子（状态与 field 列都没变）才交给 fn。返回 fn 的结果，跳过返回 null。 */
  const still = (q, field, fn) => {
    try {
      return db.tx(() => {
        const f = db.one(`SELECT * FROM questions WHERE id=?`, q.id);
        if (!f || f.status !== q.status || f[field] !== q[field]) return null;
        return fn(f);
      });
    } catch (e) {
      try { audit(db, { actorKind: 'system', action: 'timeout_sweep_failed', targetType: 'question', targetId: q.id, payload: { field, error: String(e?.message ?? e).slice(0, 300) } }); } catch { /* 库本身出错 */ }
      return null;
    }
  };
  for (const q0 of due) {
    if (q0.level === 3) continue;   // 结构上到不了这里（CHECK），留着当断言
    if (q0.level === 2 && q0.status === 'open') {
      // Ⅱ 级第一次到期：升级。没有别的应答人时升级 = 再等一段、再喊一次。
      const fallback = paramMs(db, q0.task_id, 'l2_fallback');
      const ev = still(q0, 'timeout_at', (q) => {
        transition(db, 'questions', q.id, 'escalated', { from: ['open'], set: { escalated_at: at, timeout_at: at + fallback } });
        audit(db, { actorKind: 'system', action: 'question_escalated', targetType: 'question', targetId: q.id,
          payload: { taskId: q.task_id, nodeId: q.node_id, level: 2, askedAt: q.asked_at, timedOutAt: q.timeout_at,
            nextTimeoutAt: at + fallback, hasDefault: !!q.default_action } });
        tellTimeout(db, 'timeout.escalated', q, { title: tl(L, '没人答，已升级：{head}', { head: headOf(q) }),
          text: q.default_action ? tl(L, '这条 Ⅱ 级事项过了时限没人答。再过 {h} 小时还没人答，系统会按提出时登记的默认做法替你们定：{action}', { h: Math.round(fallback / 3600_000 * 10) / 10, action: String(q.default_action).slice(0, 200) })
            : tl(L, '这条 Ⅱ 级事项过了时限没人答。它没有默认做法，会一直等到有人答。') });
        return { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: 2, nextTimeoutAt: at + fallback, text: q.text };
      });
      if (ev) { out.escalated.push(ev); onEvent({ type: 'question_escalated', ...ev }); }
      continue;
    }
    if (!q0.default_action) {
      // Ⅱ 级升级后仍无人答、又没有保守默认可退：只能继续挂着。记一次审计，timeout_at 清掉免得每轮都记。
      const ev = still(q0, 'timeout_at', (q) => {
        clearQuestionTimeout(db, q.id);
        audit(db, { actorKind: 'system', action: 'question_stuck', targetType: 'question', targetId: q.id,
          payload: { taskId: q.task_id, nodeId: q.node_id, level: q.level, why: tl(L, '升级后仍无人答，且没有默认动作可退；分支继续挂起') } });
        tellTimeout(db, 'timeout.stuck', q, { title: tl(L, '一直没人答，任务停在这里：{head}', { head: headOf(q) }),
          text: tl(L, '这条事项升级后还是没人答，又没有默认做法可以替你们定，这部分工作会一直停着，直到有人答。') });
        return { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: q.level, text: q.text };
      });
      if (ev) { out.stuck.push(ev); onEvent({ type: 'question_stuck', ...ev }); }
      continue;
    }
    // Ⅰ 级到期，或 Ⅱ 级升级后再到期：走默认动作。答复由系统写，不冒充人。
    const ev = still(q0, 'timeout_at', (q) => (isFastDefault(q)
      ? applyDefault(db, q, at, tl(L, '项目的监督模式是「例外管理」，Ⅰ 级规格取舍不等人'), { fast: true })
      : applyDefault(db, q, at, tl(L, '问题在 {level} 级超时窗口内无人答复', { level: q.level === 1 ? 'Ⅰ' : 'Ⅱ' }))));
    if (ev) { out.defaulted.push(ev); onEvent({ type: 'question_defaulted', ...ev }); }
  }

  // ── 路由行时限 —— 与级别的 timeout_at 是两口钟 ─────────────────────────
  // 到期按当前行的超时兜底走：next = 转下一行（换收件人，不替人决定）；default = 按事项的默认动作
  // （没有默认动作的事项 —— Ⅲ 级 —— 只能继续挂）；hang 的行根本不会有 route_due_at。
  const routeDue = db.all(`SELECT * FROM questions WHERE status IN ('open','escalated') AND route_due_at IS NOT NULL
                           AND route_due_at <= ? AND task_id NOT IN (SELECT id FROM tasks WHERE status='aborted') ${taskId ? 'AND task_id=?' : ''} ORDER BY route_due_at`, ...(taskId ? [at, taskId] : [at]));
  for (const q0 of routeDue) {
    const route = JSON.parse(q0.route || 'null');
    const actions = new Set((route?.rows ?? []).map((r) => r.timeout_action));
    if (actions.has('next')) {
      const r = still(q0, 'route_due_at', (q) => {
        const from = JSON.parse(q.addressed_to || '[]');
        const adv = advanceRoute(db, { questionId: q.id, at });
        if (!adv) clearRouteDue(db, q.id);
        audit(db, { actorKind: 'system', action: adv ? 'question_rerouted' : 'question_stuck', targetType: 'question', targetId: q.id,
          payload: { taskId: q.task_id, nodeId: q.node_id, decisionType: q.decision_type, from, to: adv?.answerers ?? null, stage: adv?.route?.stage ?? null,
            nextDueAt: adv?.dueAt ?? null, why: adv ? tl(L, '路由行时限到，转下一行') : tl(L, '路由行时限到但没有下一行；继续挂起') } });
        // 转走了：告诉原来的收件人"不归你了"（新收件人由事项推送补推）；转不出去：同"一直没人答"
        if (adv) tellTimeout(db, 'timeout.rerouted', { ...q, addressed_to: JSON.stringify(from) }, { title: tl(L, '你没来得及答，已转给别人：{head}', { head: headOf(q) }),
          text: tl(L, '这条事项过了时限，按路由规则转给了 {to}。你不用再答了。', { to: (adv.answerers ?? []).map((u) => db.one(`SELECT display_name FROM users WHERE id=?`, u)?.display_name ?? u).join(tl(L, '、')) }) });
        else tellTimeout(db, 'timeout.stuck', q, { title: tl(L, '一直没人答，任务停在这里：{head}', { head: headOf(q) }),
          text: tl(L, '这条事项过了时限没人答，路由里也没有下一个可以转的人，这部分工作会一直停着，直到有人答。') });
        return { adv, ev: { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: q.level, decisionType: q.decision_type, from, to: adv?.answerers ?? [], text: q.text } };
      });
      if (r?.adv) { out.rerouted.push(r.ev); onEvent({ type: 'question_rerouted', ...r.ev }); }
      else if (r) { out.stuck.push(r.ev); onEvent({ type: 'question_stuck', ...r.ev }); }
      continue;
    }
    if (actions.has('default') && q0.default_action) {
      const ev = still(q0, 'route_due_at', (q) => applyDefault(db, q, at, tl(L, '路由行时限到，收件人为空或无人答复')));
      if (ev) { out.defaulted.push(ev); onEvent({ type: 'question_defaulted', ...ev }); }
      continue;
    }
    const ev = still(q0, 'route_due_at', (q) => {
      clearRouteDue(db, q.id);
      audit(db, { actorKind: 'system', action: 'question_stuck', targetType: 'question', targetId: q.id,
        payload: { taskId: q.task_id, nodeId: q.node_id, level: q.level, why: tl(L, '路由行时限到，兜底是 default 但事项没有默认动作；继续挂起') } });
      tellTimeout(db, 'timeout.stuck', q, { title: tl(L, '一直没人答，任务停在这里：{head}', { head: headOf(q) }),
        text: tl(L, '这条事项过了时限没人答，又没有默认做法可以替你们定，这部分工作会一直停着，直到有人答。') });
      return { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: q.level, text: q.text };
    });
    if (ev) { out.stuck.push(ev); onEvent({ type: 'question_stuck', ...ev }); }
  }
  return out;
}

/** 按事项登记的默认动作了结它。答复由系统写（sender NULL、agent-generated），正文带 [超时默认] 前缀。调用方已在事务里核过它还开着。 */
function applyDefault(db, q, at, why, { fast = false } = {}) {
  const mid = newId('m');
  db.tx(() => {
    insertMessage(db, { id: mid, taskId: q.task_id, kind: 'answer', trustLabel: 'agent-generated', receivedAt: at,
      body: fast ? tl(contentLang(db), '[按默认直接走] {why}，按提出时登记的默认动作执行：\n{action}', { why, action: q.default_action })
        : tl(contentLang(db), '[超时默认] {why}，按你提出时登记的默认动作执行：\n{action}', { why, action: q.default_action }) });
    insertEdge(db, mid, q.id, 'answers', at);
    insertAnswer(db, { questionId: q.id, messageId: mid, body: q.default_action, stance: 'answer', at });
    transition(db, 'questions', q.id, 'defaulted', { from: ['open', 'escalated'], set: { resolved_at: at, route_due_at: null } });
    if (q.node_id) transition(db, 'nodes', q.node_id, 'pending', { from: ['blocked'], onMismatch: 'skip' });
    const stillOpen = db.one(`SELECT count(*) AS n FROM questions WHERE task_id=? AND status IN ('open','escalated')`, q.task_id).n;
    if (!stillOpen) transition(db, 'tasks', q.task_id, 'running', { from: ['waiting'], onMismatch: 'skip' });
    audit(db, { actorKind: 'system', action: 'question_defaulted', targetType: 'question', targetId: q.id,
      payload: { taskId: q.task_id, nodeId: q.node_id, level: q.level, messageId: mid, defaultAction: q.default_action, why, ...(fast ? { fast: true } : {}),
        askedAt: q.asked_at, timedOutAt: q.timeout_at, escalatedAt: q.escalated_at } });
    const L = contentLang(db);
    // 例外管理下按默认直接走的：不是"没人答"，换一句话说；仍是系统替人定了，和超时同一类（底线通知，个人静音不了）
    if (fast) emitSignal(db, 'question.auto_defaulted', { to: [...JSON.parse(q.addressed_to || '[]'), 'owner'], taskId: q.task_id, ref: q.id, level: 1,
      title: `[SuperIntern] ${tl(L, '按 AI 提的默认直接走了：{head}', { head: headOf(q) })}`,
      text: `${tl(L, '项目的监督模式是「例外管理」：Ⅰ 级的规格取舍不等人，系统按提出时登记的默认做法结了这条事项：{action}\n不同意的话，到任务页给它发一条「修正」消息，写明要怎么改。', { action: String(q.default_action).slice(0, 300) })}\n\n${String(q.text).slice(0, 300)}` });
    else tellTimeout(db, 'timeout.defaulted', q, { title: tl(L, '没人答，系统按默认替你们定了：{head}', { head: headOf(q) }),
      text: tl(L, '{why}，系统按提出时登记的默认做法结了这条事项：{action}\n不同意的话，到任务页给它发一条「修正」消息，写明要怎么改。', { why, action: String(q.default_action).slice(0, 300) }) });
  });
  return { questionId: q.id, taskId: q.task_id, nodeId: q.node_id, level: q.level, messageId: mid, defaultAction: q.default_action, text: q.text };
}
