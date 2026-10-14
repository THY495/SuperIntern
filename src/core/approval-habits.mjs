// 监测走过场。
//
// 例外置顶只解决"该看的放到眼前"，解决不了"看都不看就点接受"。自动化偏差的研究（Bainbridge 1983，
// Parasuraman & Manzey 2010）说的正是：系统一向靠谱，人的核查就退化成橡皮图章，而且本人察觉不到。
// 这里按人统计两类"批准式"决定 —— 签收（接受 / 打回）、方案批准（批准 / 要改）：
//   批准率、从提出到答复的时长、"打开到答复"的时长（看板上第一次看到这条事项 → 答复）。
// 最近几次都是批准、而且打开后很快就批了，提示负责人（不拦、不改流程：只让负责人知道）。
// 纯查询，零模型调用。"打开"只有看板记得到；命令行 / 通知里答复的没有打开时间，不参与"很快"的判断。

import { revisionSide } from './answers.mjs';

// 阈值：初值，按实际运行的数据再调
export const HABIT = {
  windowDays: 30,     // 只看最近这么多天
  streak: 5,          // 最近这么多次决定都是批准
  minMeasured: 3,     // 其中至少这么多次有打开时间
  fastMs: 60_000,     // 打开到答复的中位数低于它算"很快"
};

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
// 签收正文里"## 签收前先看这些（n 项要你处理）"：答复那一刻摆在面前、要人处理的例外条数
const pendingExceptionsIn = (text) => Number(String(text ?? '').match(/## (?:签收前先看这些（(\d+) 项要你处理）|Look at these before signing off \((\d+) need you\))/)?.slice(1).find(Boolean) ?? 0);

/**
 * 看板上第一次看到这些事项（只记写给这个人的、还开着的）。重复调用只留第一次。
 * @returns 新记下的条数
 */
export function recordViews(db, { userId, questionIds, at = Date.now() }) {
  if (!userId || !questionIds?.length) return 0;
  let n = 0;
  for (const id of questionIds.slice(0, 50)) {
    const q = db.one(`SELECT addressed_to, status FROM questions WHERE id=?`, id);
    if (!q || !['open', 'escalated'].includes(q.status) || !(json(q.addressed_to) ?? []).includes(userId)) continue;
    n += db.run(`INSERT OR IGNORE INTO question_views (question_id, user_id, first_at) VALUES (?,?,?)`, id, userId, at).changes;
  }
  return n;
}

/** 某人的批准式决定，按时间先后：[{ questionId, type, approve, at, askedAt, viewedAt, exceptions, batch }] */
export function decisionsOf(db, userId, { since = 0 } = {}) {
  const out = [];
  // 签收：结论以 task_signed_off 审计为准（它带签收人与接受与否；批量签收也在这里，各任务一条）
  for (const a of db.all(`SELECT ts, target_id, payload FROM audit_log WHERE action='task_signed_off' AND actor_id=? AND ts>=? ORDER BY id`, userId, since)) {
    const p = json(a.payload) ?? {};
    const q = p.questionId ? db.one(`SELECT id, asked_at, text FROM questions WHERE id=?`, p.questionId) : null;
    const v = q ? db.one(`SELECT first_at FROM question_views WHERE question_id=? AND user_id=?`, q.id, userId) : null;
    out.push({ questionId: q?.id ?? null, taskId: a.target_id, type: 'signoff', approve: !!p.accepted, at: a.ts, askedAt: q?.asked_at ?? null, viewedAt: v?.first_at ?? null,
      exceptions: q ? pendingExceptionsIn(q.text) : 0, batch: !!p.batch });
  }
  // 方案批准：这个人的答复 + 系统对它的判读（approval_read）；判读不了的（计划变更那种）按 (A)/(B) 认
  for (const r of db.all(`SELECT a.question_id, a.body, a.created_at, q.asked_at, q.task_id FROM answers a JOIN questions q ON q.id=a.question_id
      WHERE a.user_id=? AND q.decision_type='contract_approval' AND a.stance IN ('answer','agree') AND a.created_at>=? ORDER BY a.created_at`, userId, since)) {
    const read = db.all(`SELECT payload FROM audit_log WHERE action='approval_read' AND target_id=? AND ts>=? ORDER BY id`, r.task_id, r.created_at)
      .map((x) => json(x.payload)).find((p) => p?.questionId === r.question_id && (p.by == null || p.by === userId));
    const verdict = read?.verdict ?? (revisionSide(r.body) === 'approve' ? 'approve' : 'feedback');
    if (verdict === 'reached') continue;   // 草案里的"到此为止"不是批准与否
    const v = db.one(`SELECT first_at FROM question_views WHERE question_id=? AND user_id=?`, r.question_id, userId);
    out.push({ questionId: r.question_id, taskId: r.task_id, type: 'contract_approval', approve: verdict === 'approve', at: r.created_at, askedAt: r.asked_at, viewedAt: v?.first_at ?? null, exceptions: 0, batch: false });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 每个人的批准习惯。
 * @returns [{ userId, name, decisions, approvals, approveRate, medianResponseMs, medianOpenMs, measured, batch, fastWithExceptions, flagged, streak, recent }]
 */
export function approvalHabits(db, { at = Date.now(), userId = null } = {}) {
  const since = at - HABIT.windowDays * 86_400_000;
  const users = db.all(`SELECT id, display_name FROM users WHERE disabled_at IS NULL ${userId ? 'AND id=?' : ''} ORDER BY created_at`, ...(userId ? [userId] : []));
  const out = [];
  for (const u of users) {
    const ds = decisionsOf(db, u.id, { since });
    if (!ds.length) continue;
    const open = (d) => (d.viewedAt != null && d.viewedAt <= d.at ? d.at - d.viewedAt : null);
    const one = ds.filter((d) => !d.batch);
    const opens = one.map(open).filter((x) => x != null);
    // 最近 streak 次都是批准，其中有打开时间的够数，且打开到答复的中位数很短
    const last = ds.slice(-HABIT.streak), lastOpens = last.filter((d) => !d.batch).map(open).filter((x) => x != null);
    let streak = 0; for (let i = ds.length - 1; i >= 0 && ds[i].approve; i--) streak++;
    const flagged = last.length >= HABIT.streak && last.every((d) => d.approve) && lastOpens.length >= HABIT.minMeasured && median(lastOpens) < HABIT.fastMs;
    out.push({
      userId: u.id, name: u.display_name, decisions: ds.length, approvals: ds.filter((d) => d.approve).length,
      approveRate: ds.filter((d) => d.approve).length / ds.length,
      medianResponseMs: median(one.filter((d) => d.askedAt != null).map((d) => d.at - d.askedAt)),
      medianOpenMs: median(opens), measured: opens.length, batch: ds.filter((d) => d.batch).length,
      // 摆着要处理的例外、打开后不到"很快"阈值就接受了的签收：最该让负责人知道的那种
      fastWithExceptions: one.filter((d) => d.type === 'signoff' && d.approve && d.exceptions > 0 && open(d) != null && open(d) < HABIT.fastMs).length,
      flagged, streak,
      // 最近几次逐条（负责人据此去看：小改动快批正常，大改动、摆着例外也很快批的才值得聊）
      recent: ds.slice(-HABIT.streak).reverse().map((d) => ({ taskId: d.taskId, title: d.taskId ? db.one(`SELECT title FROM tasks WHERE id=?`, d.taskId)?.title ?? null : null,
        type: d.type, approve: d.approve, at: d.at, openMs: d.batch ? null : open(d), exceptions: d.exceptions, batch: d.batch })),
    });
  }
  return out;
}
