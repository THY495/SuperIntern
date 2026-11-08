// 交付后回路：PR 上的评审与评论。
//
// 自动变成修正的只有一种：**成员在 GitHub 上点了「Request changes」**，而这个成员按决策路由能拍这个任务的「交付」。
//   - 成员 = 评论人对上了成员（绑定的 GitHub 数字 id，或管理员填的账号名；pr-watch.memberForGithub）；
//   - 修正的发送人是这个成员；令牌记交付那次的 —— 这条消息走的是那次交付打开的通道（PR），交付人的授权不在了就不自动转；
//   - 那次评审里的行内评论一并带上（文件:行 + 原文）；
//   - 预算闸门会撞就不自动转。
// 别的（普通评论、批准、不是成员的人的意见、上面几条没满足的「Request changes」）都是"待看意见"：
// 看板交付卡上列出来，有权交付的人点「转成修正」（以他自己的名义、他的令牌）或「不用管」。不是成员的人的话标"不是成员"，
// 不能触发任何付费动作 —— 转不转由有权的人看过原文再定。
// 意见的去向记在 delivery.pr_comments：{ [评论 id]: { status: 'auto'|'fixed'|'dismissed'|'blocked', by, at, messageId?, why? } }。
import { audit, newId, now } from '../db/db.mjs';
import { insertUserMessage } from '../db/messages.mjs';
import { transition } from '../db/state.mjs';
import { getParam, getProjectParam, writeParam } from './params.mjs';
import { authorize, requireAuthorized } from './routing.mjs';
import { spendBreach } from './spend.mjs';
import { PR_KEY, CI_FIX_KEY, prOf, prStateOf } from './pr-watch.mjs';
import { delegationProblem, ciFixOf, ciFixMax, projectCiFixMax } from './pr-fix.mjs';
import { openHandback } from './handback.mjs';
import { tl, contentLang, I18nError } from '../i18n/index.mjs';
import { markOf } from '../i18n/marks.mjs';
import { trySignal } from './signals.mjs';

export const COMMENTS_KEY = 'delivery.pr_comments';
const SYS = { kind: 'agent', id: 'system' };
const DONE = new Set(['auto', 'fixed', 'dismissed']);

const dispOf = (db, ref) => (ref.taskId ? getParam(db, ref.taskId, COMMENTS_KEY) : getProjectParam(db, ref.projectId, COMMENTS_KEY)) ?? {};
function setDisp(db, ref, id, value, at) {
  const cur = { ...dispOf(db, ref), [id]: value };
  writeParam(db, { ...ref, key: COMMENTS_KEY, value: cur, by: value.by ? { kind: 'user', id: value.by } : SYS, governance: 'execution', layer: ref.taskId ? 'task' : 'project', at });
}
const nameOf = (db, id) => (id ? db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id : null);

/** 一条意见（评审连同它的行内评论）→ 修正正文的主体 */
function commentText(db, c, all, L) {
  const who = c.author.member ? tl(L, '@{login}（成员：{name}）', { login: c.author.login, name: nameOf(db, c.author.member) }) : tl(L, '@{login}（不是成员）', { login: c.author.login });
  const lines = c.kind === 'review' ? all.filter((x) => x.kind === 'line' && `review:${x.review}` === c.id) : [];
  const head = c.kind === 'review' ? tl(L, '{who} 在 GitHub 上要求修改：', { who }) : c.kind === 'line' ? tl(L, '{who} 在 {path}:{line} 留了行内评论：', { who, path: c.path ?? '?', line: c.line ?? '?' }) : tl(L, '{who} 在 PR 上评论：', { who });
  const body = [c.body?.trim() ? c.body.trim() : null, ...lines.map((x) => `- ${x.path ?? '?'}:${x.line ?? '?'} —— ${String(x.body ?? '').trim()}`)].filter(Boolean).join('\n');
  return `${head}\n${body || tl(L, '（没有写说明）')}${c.url ? `\n${c.url}` : ''}`;
}

/** 发一条修正（任务 done 就放回 running），记意见去向；修好照样自动推回（pr-fix.redeliverFixes），推的人是 pushBy */
function sendCorrection(db, { taskId, ref, c, all, senderId, tokenId, pushBy, pushToken, via, intro, at }) {
  const L = contentLang(db);
  const mid = newId('m');
  const body = `${markOf(L, 'prReview')}${intro}\n\n${commentText(db, c, all, L)}\n\n${tl(L, '在这个任务的分支上按意见改；改好之后系统会把新的提交推到同一个 PR。意见不对或做不到，写进交接记录的 known_issues，别硬改。')}`;
  db.tx(() => {
    insertUserMessage(db, { id: mid, taskId, senderId, tokenId, body, kind: 'correction', urgency: 'urgent', receivedAt: at });
    if (db.one(`SELECT status FROM tasks WHERE id=?`, taskId)?.status === 'done') {
      transition(db, 'tasks', taskId, 'running');
      audit(db, { actorKind: senderId ? 'user' : 'system', actorId: senderId, action: 'task_resumed', targetType: 'task', targetId: taskId, payload: { from: 'done', to: 'running', via } });
    }
    // 修好推回：同 CI 那条，记一轮"在修"（不算 CI 的次数）
    const fix = ciFixOf(db, ref) ?? { attempts: 0 };
    writeParam(db, { taskId, key: CI_FIX_KEY, value: { ...fix, mode: 'auto', cause: 'review', by: pushBy, tokenId: pushToken, messageId: mid, at, redelivered: null, redeliverError: null }, by: SYS, governance: 'execution', layer: 'task', at });
    setDisp(db, ref, c.id, { status: via === 'review_auto' ? 'auto' : 'fixed', by: via === 'review_auto' ? null : senderId, at, messageId: mid }, at);
    audit(db, { actorKind: senderId ? 'user' : 'system', actorId: senderId, action: 'message_received', targetType: 'task', targetId: taskId,
      payload: { messageId: mid, kind: 'correction', kindSource: 'explicit', urgency: 'urgent', urgencySource: 'explicit', via, comment: c.id, github: c.author.login } });
    if (via === 'review_auto' && pushBy) trySignal(db, 'external.review_fix', { to: [pushBy], taskId, ref: mid, at, title: tl(L, '[SuperIntern] 按 {who} 的评审意见自动改，改好推到你交付的 PR', { who: c.author.login }),
      text: tl(L, '改好之后，系统会用你交付时的授权把新提交推到同一个 PR。不想让它推：到任务页把任务暂停或中止。') });
  });
  return mid;
}

/**
 * 轮询器发现变了（pr-watch 的 onChange）：新出现的「Request changes」评审，满足条件的转成修正。
 * 返回 { auto: [评论 id], blocked: [{ id, why }] }。
 */
export function onReviewChange(db, item, prev, next, { at = now() } = {}) {
  const out = { auto: [], blocked: [] };
  if (!item.taskId || !next?.comments?.length || next.error) return out;
  const ref = { taskId: item.taskId };
  const pr = prOf(db, ref) ?? item.pr;
  const disp = dispOf(db, ref);
  const task = db.one(`SELECT status FROM tasks WHERE id=?`, item.taskId);
  if (!task || task.status === 'aborted') return out;
  const L = contentLang(db);
  for (const c of next.comments) {
    if (c.kind !== 'review' || c.reviewState !== 'CHANGES_REQUESTED' || disp[c.id] || (c.at && pr.at && c.at < pr.at)) continue;
    let why = null;
    if (pr.autofix === false) why = tl(L, '交付时没有授权 AI 自动跟进这个 PR：要求修改也先给你看');
    else if (!c.author.member) why = tl(L, '评审人 @{login} 对不上成员：不是成员的意见不能直接让 AI 动手', { login: c.author.login });
    else if (!authorize(db, { taskId: item.taskId, decisionType: 'delivery', userId: c.author.member }).ok) why = tl(L, '{name} 不是这个任务「交付」的接收人：要有权交付的人看过再定', { name: nameOf(db, c.author.member) });
    else why = delegationProblem(db, { taskId: item.taskId, by: pr.by, tokenId: pr.tokenId }, L);
    if (!why && spendBreach(db, item.taskId, { at })) why = tl(L, '再改一轮会撞预算闸门');
    if (why) {
      setDisp(db, ref, c.id, { status: 'blocked', why, at }, at);
      out.blocked.push({ id: c.id, why });
      audit(db, { actorKind: 'system', action: 'pr_review_pending', targetType: 'task', targetId: item.taskId, payload: { pr: pr.number, comment: c.id, github: c.author.login, why } });
      continue;
    }
    sendCorrection(db, { taskId: item.taskId, ref, c, all: next.comments, senderId: c.author.member, tokenId: pr.tokenId, pushBy: pr.by, pushToken: pr.tokenId, via: 'review_auto', at,
      intro: tl(L, 'PR #{n} 收到要求修改的评审（评审人按决策路由有权交付这个任务，系统直接转成修正）。', { n: pr.number }) });
    out.auto.push(c.id);
  }
  return out;
}

/** 看板上点「转成修正」/「不用管」。op：'fix'（任务的 PR 才有）| 'dismiss' */
export function actOnComment(db, { taskId = null, projectId = null, commentId, op, userId, tokenId, at = now() }) {
  const ref = taskId ? { taskId } : { projectId };
  const st = prStateOf(db, ref);
  const c = st?.comments?.find((x) => x.id === commentId);
  if (!c) throw new I18nError('PR 上没有这条意见（可能已被删掉，或者还没看到）：{id}', { id: String(commentId).slice(0, 40) });
  if (taskId) requireAuthorized(db, { taskId, decisionType: 'delivery', userId });
  const L = contentLang(db);
  if (op === 'undo') {
    // 「不用管」点错了：放回待看（转成修正的撤不了 —— 修正已经交给 AI；要拦就在任务页暂停）
    if (dispOf(db, ref)[c.id]?.status !== 'dismissed') throw new I18nError('只有「不用管」的能撤回');
    const cur = { ...dispOf(db, ref) }; delete cur[c.id];
    writeParam(db, { ...ref, key: COMMENTS_KEY, value: cur, by: { kind: 'user', id: userId }, governance: 'execution', layer: taskId ? 'task' : 'project', at });
    audit(db, { actorKind: 'user', actorId: userId, action: 'pr_comment_restored', targetType: taskId ? 'task' : 'project', targetId: taskId ?? projectId, payload: { comment: c.id } });
    return { restored: c.id };
  }
  if (op === 'dismiss') {
    setDisp(db, ref, c.id, { status: 'dismissed', by: userId, at }, at);
    audit(db, { actorKind: 'user', actorId: userId, action: 'pr_comment_dismissed', targetType: taskId ? 'task' : 'project', targetId: taskId ?? projectId, payload: { comment: c.id, github: c.author.login } });
    return { dismissed: c.id };
  }
  if (op !== 'fix') throw new I18nError('不认识的操作：{op}', { op: String(op).slice(0, 20) });
  if (!taskId) throw new I18nError('项目整体交付的 PR 没有能接着改的任务：到项目页「添加任务」，把这条意见贴进去');
  if (db.one(`SELECT status FROM tasks WHERE id=?`, taskId)?.status === 'aborted') throw new I18nError('任务已中止：先恢复再转修正');
  const pr = prOf(db, ref);
  const mid = sendCorrection(db, { taskId, ref, c, all: st.comments, senderId: userId, tokenId, pushBy: userId, pushToken: tokenId, via: 'review_manual', at,
    intro: tl(L, '{name} 看过 PR #{n} 上的这条意见，决定按它改。', { name: nameOf(db, userId), n: pr?.number ?? '?' }) });
  return { messageId: mid };
}

/** 授权 / 收回 AI 跟进这个 PR（任务的 PR 才有）。授权的人成了新的授权锚点：之后自动修、转评审用的是他和他这次的令牌 */
export function setPrAutofix(db, { taskId, on, userId, tokenId, at = now() }) {
  const pr = prOf(db, { taskId });
  if (!pr) throw new I18nError('这个任务还没有交付出去的 PR');
  requireAuthorized(db, { taskId, decisionType: 'delivery', userId });
  const value = on ? { ...pr, autofix: true, by: userId, tokenId, autofixAt: at } : { ...pr, autofix: false, autofixOffBy: userId, autofixAt: at };
  writeParam(db, { taskId, key: PR_KEY, value, by: { kind: 'user', id: userId }, governance: 'execution', layer: 'task', at });
  audit(db, { actorKind: 'user', actorId: userId, action: on ? 'pr_autofix_on' : 'pr_autofix_off', targetType: 'task', targetId: taskId, payload: { pr: pr.number } });
  return { autofix: !!on };
}

/** 看板交付卡要的一切：PR、最近一次看到的样子、修到哪了、每条意见的去向与"待看"数 */
export function prView(db, ref) {
  const pr = prOf(db, ref);
  if (!pr) return null;
  const st = prStateOf(db, ref);
  const disp = dispOf(db, ref);
  const fix = ciFixOf(db, ref);
  const handledReviews = new Set(Object.entries(disp).filter(([, d]) => DONE.has(d.status)).map(([id]) => id));
  const comments = (st?.comments ?? []).filter((c) => !c.author.bot && (!c.at || !pr.at || c.at >= pr.at)).map((c) => {
    const d = disp[c.id] ?? (c.kind === 'line' && c.review && handledReviews.has(`review:${c.review}`) ? { status: 'with_review' } : null);
    return { ...c, authorName: nameOf(db, c.author.member), disposition: d, pending: !d || d.status === 'blocked' };
  }).filter((c) => !(c.kind === 'review' && c.reviewState === 'COMMENTED' && !c.body?.trim()));
  return {
    pr: { number: pr.number, url: pr.url, base: pr.base, branch: pr.branch, head: pr.head, at: pr.at, by: pr.by, byName: nameOf(db, pr.by), signed: !!pr.signed, autofix: pr.autofix !== false },
    state: st ? { state: st.state ?? null, head: st.head ?? null, title: st.title ?? null, ci: st.ci ?? null, missing: st.missing ?? [], error: st.error ?? null, at: st.at ?? null, credential: st.credential ?? null } : null,
    fix: fix ? { attempts: fix.attempts ?? 0, max: ref.taskId ? ciFixMax(db, ref.taskId) : projectCiFixMax(db, ref.projectId), mode: fix.mode ?? null, cause: fix.cause ?? 'ci', why: fix.why ?? null, redelivered: fix.redelivered ?? null, redeliverError: fix.redeliverError ?? null, at: fix.at ?? null, head: fix.head ?? null,
      // 问了人的那条事项（在任务页「待决事项」里）
      questionId: ref.taskId ? openHandback(db, ref.taskId)?.questionId ?? null : null } : null,
    max: ref.taskId ? ciFixMax(db, ref.taskId) : projectCiFixMax(db, ref.projectId),
    comments, pending: comments.filter((c) => c.pending).length,
  };
}
