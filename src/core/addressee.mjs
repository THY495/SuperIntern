// "这条事项真的有人会看到吗" —— 一个判断，两个用户，所以住在一个谁都能 import 的叶子模块里。
//
// 用它的两处：
//   - 停等账本（`liveness.mjs`）：解引用不到收件人 = `unknown` = 缺陷，不是"在等人"。
//   - 让路调度（`project.mjs` 的「让路」）：开着的任务全都在等人时，独立的下一个可以先跑起来。
//
// 为什么单独成一个文件而不是让 project 去 import liveness：那会成环（liveness 已经 import
// project 的 chainGraph）。环在 ESM 里多半能跑，但"多半"不是一个该留在调度路径上的词。
// 更要紧的是第二条理由：**两处各写一遍近似的判断，下场就是某天一处认得、另一处不认得**，
// 而那种不一致没有任何测试会自己发现 —— 它只会表现为"明明在等人却不让路"或者相反。

const parse = (s) => { try { return JSON.parse(s ?? 'null'); } catch { return null; } };

/**
 * 任务上开着的事项里，**真的有人会看到的**那一条。
 * `addressed_to = []` 是广播（所有人收件箱都有），算数；指名道姓但那些人全停用 / 全是旁观者的，
 * 不算 —— 那种事项躺在库里没有任何人会看到，正是 `question_unassigned` 想说的事，
 * 这时返回 `{ orphan: true }`：调用方要分得清"在等人"与"有事项但没人看得到"。
 */
export function answerableQuestion(db, taskId) {
  const qs = db.all(`SELECT id, text, addressed_to, asked_at, decision_type FROM questions
                     WHERE task_id=? AND status IN ('open','escalated') ORDER BY asked_at`, taskId);
  for (const q of qs) {
    const ids = parse(q.addressed_to);
    if (!Array.isArray(ids) || !ids.length) return { q, to: [], broadcast: true };
    const live = ids.filter((id) => db.one(`SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL AND role<>'observer'`, id));
    if (live.length) return { q, to: live, broadcast: false };
  }
  return qs.length ? { q: qs[0], to: [], broadcast: false, orphan: true } : null;
}

/** 它此刻在等人吗。`orphan` 不算 —— 没有人会看到的事项不是"在等人"，是缺陷。 */
export const waitingOnHuman = (db, taskId) => {
  const q = answerableQuestion(db, taskId);
  return !!(q && !q.orphan);
};
