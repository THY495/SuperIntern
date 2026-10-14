// 事项（questions）的主人模块：事项表的写入只经这里。
//
// 原来 22 个文件各写一份 INSERT —— 列清单、级别 / 默认动作 / 时限的组合各抄一遍，库层 CHECK 拦得住非法组合，
// 但拦不住"这条路径忘了填 timeout_at、那条路径把 level_source 写成别的"。之后的 UPDATE 又散在 9 个文件里，
// 收口时查出一条各写各的不变量：**换了收件人，新加进来的人要收到推送**。通知原来按事项只发一次（notified_at），
// 有的路径换人时顺手清它（交接），有的不清（转交、超时转下一行、全员弃权转负责人）—— 不清的那几条路上新收件人
// 永远收不到推送。现在记"推到过谁"（notified_to），通知只推还没推过的人：换人的路径什么都不用记着做。
//
// 状态变化经 db/state.mjs 的 transition()；路由的计算在 core/routing.mjs，写回经这里的 applyRoute。

import { newId, now } from '../db/db.mjs';
import { tl, contentLang } from '../i18n/index.mjs';

/**
 * 新建一条事项，返回 id。
 * 级别与默认动作 / 时限的组合（Ⅲ 级不许带默认与时限、Ⅰ 级必须带默认）由库层 CHECK 执法，这里不另写一份 ——
 * 两处各写一份就会漂（m1 钉着"由库层拒绝、应用层不替它兜底"）。
 */
export function insertQuestion(db, { id = newId('q'), taskId, nodeId = null, level, levelSource = 'hard_rule', text,
  defaultAction = null, askedAt = now(), timeoutAt = null, status = 'open', originQuestionId = null }) {
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status,origin_question_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, taskId, nodeId, level, levelSource, text, defaultAction, askedAt, timeoutAt, status, originQuestionId);
  return id;
}

const json = (v) => (v == null || typeof v === 'string' ? v : JSON.stringify(v));

/** 路由的结果整体写回（routeQuestion）。 */
export function applyRoute(db, questionId, { decisionType, typeSource, quorum, conflictPolicy, addressedTo, informed, route, routeDueAt }) {
  db.run(`UPDATE questions SET decision_type=?, type_source=?, quorum=?, conflict_policy=?, addressed_to=?, informed=?, route=?, route_due_at=? WHERE id=?`,
    decisionType, typeSource, quorum, conflictPolicy, json(addressedTo), json(informed), json(route), routeDueAt, questionId);
}

/**
 * 换收件人 / 知会人 / 路由快照 / 路由时限：只改给了的那几项（undefined = 不动，null = 清空，仅 route / routeDueAt 可为 null）。
 * 新加进来的人由通知按 notified_to 补推，这里不用清任何推送记录。
 */
export function setRecipients(db, questionId, { addressedTo, informed, route, routeDueAt } = {}) {
  const cols = [], vals = [];
  if (addressedTo !== undefined) { cols.push('addressed_to=?'); vals.push(json(addressedTo)); }
  if (informed !== undefined) { cols.push('informed=?'); vals.push(json(informed)); }
  if (route !== undefined) { cols.push('route=?'); vals.push(json(route)); }
  if (routeDueAt !== undefined) { cols.push('route_due_at=?'); vals.push(routeDueAt); }
  if (!cols.length) return;
  db.run(`UPDATE questions SET ${cols.join(', ')} WHERE id=?`, ...vals, questionId);
}

/** 冲突事项：把冲突各方记进路由快照（$.parties）。 */
export function setRouteParties(db, questionId, parties) {
  db.run(`UPDATE questions SET route=json_set(route,'$.parties',json(?)) WHERE id=?`, JSON.stringify(parties), questionId);
}

/** 正文后面接一段（转交提示之类）。 */
export function appendQuestionText(db, questionId, suffix) {
  db.run(`UPDATE questions SET text=text || ? WHERE id=?`, suffix, questionId);
}

/** 记下结案时刻（状态本身经 transition）。 */
export function markResolved(db, questionId, at = now()) {
  db.run(`UPDATE questions SET resolved_at=? WHERE id=?`, at, questionId);
}

/** 级别时限已处理（默认动作已生效 / 已升级）：不再按 timeout_at 触发。 */
export function clearQuestionTimeout(db, questionId) {
  db.run(`UPDATE questions SET timeout_at=NULL WHERE id=?`, questionId);
}

/** 路由时限已处理：不再按 route_due_at 触发。 */
export function clearRouteDue(db, questionId) {
  db.run(`UPDATE questions SET route_due_at=NULL WHERE id=?`, questionId);
}

/** 推送过了：记时刻，并把这次推到的人并进 notified_to。 */
export function markNotified(db, questionId, { to = [], at = now() } = {}) {
  db.run(`UPDATE questions SET notified_at=?, notified_to=(SELECT json_group_array(value) FROM (SELECT value FROM json_each(notified_to) UNION SELECT value FROM json_each(?))) WHERE id=?`,
    at, JSON.stringify(to), questionId);
}

/** 让开放事项对**所有**当前收件人再推一遍（任务从中止恢复时：事项重新进待办）。 */
export function resetNotified(db, { questionId = null, taskId = null }) {
  if (questionId) db.run(`UPDATE questions SET notified_at=NULL, notified_to='[]' WHERE id=?`, questionId);
  else db.run(`UPDATE questions SET notified_at=NULL, notified_to='[]' WHERE task_id=? AND status IN ('open','escalated')`, taskId);
}

/**
 * 该推送的开放事项：从没推过的，或有收件人 / 知会人还没推过的。每条带 fresh（这次要推的人）与 first（是不是第一次推）。
 */
export function questionsToNotify(db, { limit = 50 } = {}) {
  const rows = db.all(`SELECT q.*, t.title FROM questions q JOIN tasks t ON t.id=q.task_id
    WHERE q.status IN ('open','escalated') AND (q.notified_at IS NULL OR EXISTS (
      SELECT 1 FROM (SELECT value FROM json_each(q.addressed_to) UNION SELECT value FROM json_each(q.informed)) r
      WHERE r.value NOT IN (SELECT value FROM json_each(q.notified_to))))
    ORDER BY q.asked_at LIMIT ?`, limit);
  return rows.map((q) => {
    const all = [...new Set([...JSON.parse(q.addressed_to || '[]'), ...JSON.parse(q.informed || '[]')])];
    const done = new Set(JSON.parse(q.notified_to || '[]'));
    const first = q.notified_at == null;
    return { ...q, all, first, fresh: first ? all : all.filter((u) => !done.has(u)) };
  });
}

/**
 * 已结的事项是谁、何时、怎么结的（输掉竞争的一方看到"已由 X 于 T 处理"）。who / how 按内容语言。
 * @returns {{who: string, at: number|null, when: string, how: string, userId: string|null}}
 */
export function resolutionOf(db, q) {
  const L = contentLang(db);
  const at = q.resolved_at ?? null;
  const when = at ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : tl(L, '（时间未记）');
  if (q.status === 'answered') {
    const a = db.one(`SELECT a.user_id, u.display_name FROM answers a LEFT JOIN users u ON u.id=a.user_id
                      WHERE a.question_id=? AND a.stance='answer' ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`, q.id);
    return { who: a?.display_name ?? tl(L, '系统'), at, when, how: tl(L, '作答'), userId: a?.user_id ?? null };
  }
  if (q.status === 'defaulted') return { who: tl(L, '系统'), at, when, how: tl(L, '按超时默认动作结案'), userId: null };
  const w = db.one(`SELECT l.actor_id, u.display_name FROM audit_log l LEFT JOIN users u ON u.id=l.actor_id
                    WHERE l.target_id=? AND l.action='status_changed' AND json_extract(l.payload,'$.to')=? ORDER BY l.id DESC LIMIT 1`, q.id, q.status);
  return { who: w?.display_name ?? tl(L, '系统'), at, when, how: q.status === 'withdrawn' ? tl(L, '撤回此事项') : q.status, userId: w?.actor_id ?? null };
}
