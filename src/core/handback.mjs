// 交回给人的三条事项：验收没过、合并卡住、合并反复出错。
//
// 要防的形状是：任务的活都做完了，卡在**系统自己的两道关**上 ——
// 任务级验收判失败、签收后合并被"工作区有未提交的改动"挡住。若两处都只写审计，就没有任何人收到事项；
// 停等账本 30 分钟后才报一条说不出原因的警，而人在页面上对那条警能做的只有"回一句"，
// 最后只能有人登上服务器 `git checkout` 才解开。
//
// 做法是**沿用提问机制**，不做"丢弃这些改动"之类的专用按钮。所以这里的形状是：
//   卡住 → 当场挂一条事项（带失败输出 / 文件清单，给技术取舍的人 + 负责人）
//   人答复 → 答复原文 + 系统附的材料，作为一条修正交给 AI（任务回 running，走重规划那条老路）
//   人要中止 → 到任务页点「中止」（不可逆的动作不由一句答复替人做，与集成卡住那条同一规矩）
// 能由系统自己安全处理的（只剩构建产物）根本不到这里 —— 在 orchestrator / project 里就撤掉了。
//
// 认证链与 RESOLUTION_HOOKS.signoff / 集成卡住那条同理：修正消息复用这条答复的令牌（同一人、同一决策、系统代拟）。

import { newId, now, audit, insertEdge } from '../db/db.mjs';
import { insertUserMessage, markMessageConsumed } from '../db/messages.mjs';
import { routeQuestion } from './routing.mjs';
import { getParam, setParam } from './params.mjs';
import { tl, contentLang } from '../i18n/index.mjs';
import { markOf } from '../i18n/marks.mjs';
import { transition } from '../db/state.mjs';
import { insertQuestion } from './questions.mjs';
import { HOOK_APPROVE } from './hooks.mjs';
import { noteAnsweredFix } from './pr-watch.mjs';

export const HANDBACK_KEY = 'task.handback';

const BY = { kind: 'agent', id: 'handback' };
const HOW_TO_ABORT = (L) => tl(L, '不要这个任务了：到任务页点「中止」。这一步不可逆，答复里写"中止"不算数，得你自己去点。');
const NO_AI = (L) => tl(L, '（这条是系统按规则直接生成的，没有经过 AI。）');

/** 这个任务上还开着的交回事项（同一种只挂一条）。 */
export function openHandback(db, taskId, kind = null) {
  const h = getParam(db, taskId, HANDBACK_KEY);
  if (!h?.questionId || (kind && h.kind !== kind)) return null;
  const q = db.one(`SELECT id, status FROM questions WHERE id=?`, h.questionId);
  return q && ['open', 'escalated'].includes(q.status) ? h : null;
}

function raise(db, { taskId, kind, text, detail, at, extra = {}, decisionType = null }) {
  const cur = openHandback(db, taskId, kind);
  if (cur) return { questionId: cur.questionId, reused: true };
  const id = newId('q');
  return db.tx(() => {
    insertQuestion(db, { id: id, taskId: taskId, level: 3, text: text, askedAt: at });
    // 验收没过是代码的事 → 结构矛盾（必含负责人）；其余是系统卡住 → 运维（负责人可以只派给管代码的人）。都禁 default，不会到期自己消失。
    const r = routeQuestion(db, { questionId: id, decisionType: decisionType ?? (CODE_KINDS.has(kind) ? 'structural' : 'ops'), typeSource: 'hard_rule', at });
    setParam(db, { taskId, key: HANDBACK_KEY, value: { kind, questionId: id, at, detail, ...extra }, by: BY, governance: 'execution' });
    audit(db, { actorKind: 'system', action: 'handback_raised', targetType: 'task', targetId: taskId,
      payload: { kind, questionId: id, addressedTo: r.answerers } });
    return { questionId: id, text, addressedTo: r.answerers };
  });
}

const tailOf = (s, n = 20) => String(s ?? '').trim().split('\n').slice(-n).join('\n');
// 代码的事（必含负责人）；其余是系统卡住（运维）
const CODE_KINDS = new Set(['verify_failed', 'ci_failed', 'project_ci_failed']);
const DECLINE_RE = /^(不用修|不修|不用管|忽略|算了|先不管|ignore|skip|leave it)/i;

/** PR 的 CI 没过、没有自动修（pr-fix.mjs）：说清为什么没自动修，失败材料附上 */
export function raiseCiFailed(db, { taskId, intro, why, logs, url, at = now() }) {
  const L = contentLang(db);
  const detail = `${intro}\n${url ?? ''}\n\n${logs}`;
  const text = `${markOf(L, 'ciFailed')}${intro}\n${url ?? ''}\n\n${tl(L, '没有自动修：{why}。', { why })}\n\n${NO_AI(L)}\n\n`
    + `${tl(L, '怎么答：')}\n`
    + `· ${tl(L, '让 AI 修：写一句你的判断（比如"是新加的测试写错了"），只写"按日志修"也行。你的话连同 CI 的输出一起交给 AI；修好之后系统把新提交推到同一个 PR（推的人是你）。')}\n`
    + `· ${tl(L, '不用修（比如 CI 自己的问题、已经有人在修）：回「不用修」。这个提交上的失败就不再管，下次推了新提交再看。')}\n`
    + `· ${HOW_TO_ABORT(L)}\n\n${logs}`;
  return raise(db, { taskId, kind: 'ci_failed', text, detail, at });
}

/** 项目的 PR（整体交付的）CI 没过：没有一个能接着修的任务，说清怎么加任务修 */
export function raiseProjectCiFailed(db, { projectId, intro, logs, url, at = now() }) {
  const L = contentLang(db);
  const host = db.one(`SELECT id FROM tasks WHERE project_id=? AND project_order=0`, projectId)?.id
    ?? db.one(`SELECT id FROM tasks WHERE project_id=? ORDER BY COALESCE(project_order,0) DESC LIMIT 1`, projectId)?.id;
  if (!host) return null;
  const text = `${markOf(L, 'ciFailed')}${intro}\n${url ?? ''}\n\n${NO_AI(L)}\n\n`
    + `${tl(L, '这是项目整体交付的 PR，这一次系统没有替你起草修复（原因见上一行）。')}\n`
    + `${tl(L, '要修：到项目页「添加任务」，把下面的输出贴进去；新任务合并之后，到项目页再交付一次 —— 推的还是这个分支，PR 跟着更新。')}\n`
    + `${tl(L, '不用修：回「不用修」。')}\n\n${logs}`;
  return raise(db, { taskId: host, kind: 'project_ci_failed', text, detail: `${intro}\n${url ?? ''}`, at, extra: { projectId } });
}

/** 修好了、往 PR 推的时候没推上去（或者修完没有新提交） */
export function raiseRedeliverFailed(db, { taskId, why, url, at = now() }) {
  const L = contentLang(db);
  const text = `${markOf(L, 'ciRedeliverFailed')}${tl(L, '按 CI 失败修了一轮，但新的提交没有推到 PR：{why}', { why })}\n${url ?? ''}\n\n${NO_AI(L)}\n\n`
    + `${tl(L, '怎么答：')}\n`
    + `· ${tl(L, '自己推：到任务页点「交付」（同一个分支，PR 跟着更新）。推完回这条「推了」。')}\n`
    + `· ${tl(L, '还要 AI 再改：写一句要它改什么，连同上面的原因交给 AI。')}\n`
    + `· ${HOW_TO_ABORT(L)}`;
  return raise(db, { taskId, kind: 'ci_redeliver_failed', text, detail: why, at });
}


/** 任务级验收没过。 */
export function raiseVerifyFailed(db, { taskId, verification: v, at = now() }) {
  const L = contentLang(db);
  const task = db.one(`SELECT title FROM tasks WHERE id=?`, taskId);
  const cmd = Array.isArray(v?.argv) ? v.argv.join(' ') : tl(L, '（没有命令）');
  const code = v?.code === null || v?.code === undefined ? tl(L, '（没跑起来）') : v.code;
  const detail = tl(L, '验收命令：{cmd}\n退出码：{code}{timeout}\n输出尾部：\n{tail}',
    { cmd, code, timeout: v?.timedOut ? tl(L, '（超时）') : '', tail: tailOf(v?.tail) || tl(L, '（空）') });
  const text = `${markOf(L, 'verifyFailed')}${tl(L, '任务「{title}」的步骤都做完了，但任务的验收没过，所以没有进入签收。', { title: task?.title ?? taskId })}\n\n`
    + `${detail}\n\n`
    + `${NO_AI(L)}\n\n`
    + `${tl(L, '怎么答：')}\n`
    + `· ${tl(L, '想先看看再决定：到任务页看「改动」（这个任务改了哪些代码）和「日志」（验收的完整输出），看完再回来答。')}\n`
    + `· ${tl(L, '让 AI 接着修：直接在下面写一句你的判断或要求（比如"是测试写错了"、"先把构建修好"），只写"接着修"也行。你写的话会连同上面的失败输出一起交给 AI，它重新规划、改完再验收。')}\n`
    + `· ${HOW_TO_ABORT(L)}`;
  return raise(db, { taskId, kind: 'verify_failed', text, detail, at });
}

/** 签收之后、合并之前，工作区里还有没提交的改动（且不全是构建产物）。 */
export function raiseDirtyWorkspace(db, { taskId, files, at = now() }) {
  const L = contentLang(db);
  const task = db.one(`SELECT title FROM tasks WHERE id=?`, taskId);
  const list = files.slice(0, 30).join('\n') + (files.length > 30 ? `\n${tl(L, '……共 {n} 处', { n: files.length })}` : '');
  const detail = `${tl(L, '签收之后工作区里还有没提交的改动（不在签收过的那一版里）：')}\n${list}`;
  const text = `${markOf(L, 'mergeBlocked')}${tl(L, '任务「{title}」已经签收，但它的工作区里还有没提交的改动，系统不替你决定要不要它们，所以先没合并。', { title: task?.title ?? taskId })}\n\n`
    + `${detail}\n\n`
    + `${NO_AI(L)}\n\n`
    + `${tl(L, '怎么答：')}\n`
    + `· ${tl(L, '让 AI 处理：直接写一句（比如"都不要"、"把 README 的改动提交上"），只写"让 AI 处理"也行；拿不准某个文件是什么，就写"先看看这几个文件是什么，数据文件别删"。')}\n`
    + `　${tl(L, 'AI 会照你的话处理。只丢掉的话，签过的那一版一个字不变、不用重新签收；提交了新内容，才会重新请你签收。')}\n`
    + `· ${HOW_TO_ABORT(L)}`;
  return raise(db, { taskId, kind: 'dirty_workspace', text, detail, at });
}

/**
 * 项目推进（合并 / 开下一个任务）按退避表连试几次都失败了。原来退避表用完就 `?? Infinity` —— **永远不再试，也不告诉任何人**。
 * 这类错多半不是 AI 能修的（服务器、磁盘、git 状态），所以答复不转成修正：人回一句 = 再试一次（守护进程看到答复就清掉退避）。
 */
export function raiseAdvanceFailed(db, { projectId, taskId = null, error, attempts, at = now() }) {
  const host = taskId ?? db.one(`SELECT id FROM tasks WHERE project_id=? ORDER BY COALESCE(project_order,0) LIMIT 1`, projectId)?.id;
  if (!host) return { questionId: null };
  const L = contentLang(db);
  const p = db.one(`SELECT title FROM projects WHERE id=?`, projectId);
  const task = taskId ? db.one(`SELECT title FROM tasks WHERE id=?`, taskId) : null;
  const detail = tl(L, '最近一次的错误：{error}', { error: String(error ?? '').slice(0, 600) });
  const text = `${markOf(L, 'advanceFailed')}${tl(L, '项目「{project}」{when}反复出错，已经自动重试了 {n} 次。', {
    project: p?.title ?? projectId, when: task ? tl(L, '在合并任务「{task}」时', { task: task.title }) : tl(L, '在往前推进时'), n: attempts })}\n\n`
    + `${detail}\n\n`
    + `${tl(L, '这多半是系统或服务器上的问题，不是谁的疏忽，AI 也修不了。系统会隔一段时间自己再试，但不再指望它自己好。')}${NO_AI(L)}\n\n`
    + `${tl(L, '怎么答：')}\n`
    + `· ${tl(L, '你不是管理员：点「转交」把这条交给管理员，上面的错误原文就是给管理员看的。')}\n`
    + `· ${tl(L, '原因已经排除了（比如管理员说磁盘清出来了）：回一句"再试"。系统收到立刻重试；还不行的话，会接着隔一段时间自己试，又失败几次后再问一次。')}\n`
    + `· ${HOW_TO_ABORT(L)}`;
  return raise(db, { taskId: host, kind: 'advance_failed', text, detail, at });
}

/**
 * 合并前的策略钩子拦下了，或要人确认。拦下：答复 = 修正交给 AI（同验收没过）；改完重新签收，合并前再查一遍。
 * 要人确认（包括"这个任务改了钩子文件"）：回「同意」放行这一版；别的答复同样当修正交给 AI。
 */
export function raiseMergeHookBlocked(db, { taskId, decision, lines, tampered = [], key, at = now() }) {
  const L = contentLang(db);
  const task = db.one(`SELECT title FROM tasks WHERE id=?`, taskId);
  const why = tampered.length
    ? tl(L, '这个任务改了策略钩子文件：{files}。合进去之后，以后的步骤与合并都按改过的钩子来，所以要人确认。', { files: tampered.join(tl(L, '、')) })
    : (lines.length ? lines.map((x) => `- ${x}`).join('\n') : tl(L, '- （钩子没写理由）'));
  const detail = decision === 'ask' ? tl(L, '合并前的策略钩子要人确认：\n{why}', { why })
    : decision === 'failed' ? tl(L, '合并前的策略钩子自己没跑成（脚本崩了、超时、输出看不懂，或者没核准），不是检查没过：\n{why}', { why })
    : tl(L, '合并前的策略钩子拦下了：\n{why}', { why });
  if (decision === 'failed') {
    // 不给"让 AI 改"这条路：AI 改不了钩子，答复转成修正只会空转
    const text = `${markOf(L, 'mergeBlocked')}${tl(L, '任务「{title}」已经签收，但合并进项目分支之前的策略钩子没能跑起来，所以先没合并。', { title: task?.title ?? taskId })}\n\n`
      + `${detail}\n\n${NO_AI(L)}\n\n${tl(L, '怎么答：')}\n`
      + `· ${tl(L, '先把钩子修好：宿主上的钩子找管理员（改过要重新核准）；仓库里的钩子要发一条变更、在任务范围里点名钩子文件。修好之后回任意一句（比如「重试」），系统下一拍重新检查。')}\n`
      + `· ${HOW_TO_ABORT(L)}`;
    return raise(db, { taskId, kind: 'merge_hook', text, detail, at, extra: { decision, key } });
  }
  const text = `${markOf(L, 'mergeBlocked')}${tl(L, '任务「{title}」已经签收，但合并进项目分支之前没过策略钩子，所以先没合并。', { title: task?.title ?? taskId })}\n\n`
    + `${detail}\n\n${NO_AI(L)}\n\n${tl(L, '怎么答：')}\n`
    + (decision === 'ask' ? `· ${tl(L, '看过没问题：回「同意」。系统放行这一版的合并（这一版只问这一次）。')}\n` : '')
    + `· ${tl(L, '让 AI 按钩子说的改：直接写一句要求（只写"按钩子改"也行）。上面的钩子输出会一起交给 AI；改完要你重新签收，合并前会再查一遍。')}\n`
    + `· ${tl(L, '觉得是钩子错了：宿主上的钩子找管理员改；仓库里的钩子（.superintern/hooks.json 等）要发一条变更、在任务范围里点名钩子文件，让 AI 去改。')}\n`
    + `· ${HOW_TO_ABORT(L)}`;
  // 要人确认（钩子说 ask，或任务改了钩子文件）是安全审批：派给管安全的人；拦下（deny）是代码的事，照旧
  return raise(db, { taskId, kind: 'merge_hook', text, detail, at, extra: { decision, key }, decisionType: decision === 'ask' ? 'security' : null });
}

// 改计划没成时人回"算了"= 撤回那条修正、照原计划做（中英都认）
const DROP_RE = /^(算了|不改了|不用了|never ?mind|forget it|drop it|leave it)/i;

/**
 * 人发来的修正 / 新指令，重规划器几次都没产出合规的新计划（原来：只退出、那条消息原样挂着、30 分钟后停等报警；
 * 人回 A 只会让它拿同一条话再失败一次）。答复 = 换个说法：原来那条作废，换成人这次写的；回"算了" = 原来那条作废、照原计划做。
 */
export function raiseReplanFailed(db, { taskId, messageId, why, at = now() }) {
  const L = contentLang(db);
  const task = db.one(`SELECT title FROM tasks WHERE id=?`, taskId);
  const m = messageId ? db.one(`SELECT body, sender_id FROM messages WHERE id=?`, messageId) : null;
  const who = m?.sender_id ? db.one(`SELECT display_name FROM users WHERE id=?`, m.sender_id)?.display_name : null;
  const detail = tl(L, '原来那条话{who}：\n{body}\n\n没改成的原因：{why}', {
    who: who ? tl(L, '（{name} 发的）', { name: who }) : '',
    body: String(m?.body ?? tl(L, '（找不到原文）')).slice(0, 1500),
    why: String(why ?? tl(L, '（没有记下）')).slice(0, 600) });
  const text = `${markOf(L, 'replanFailed')}${tl(L, '发给任务「{title}」的一条修正，AI 试了几次都没能改成一份合规的新计划，任务停在这里。', { title: task?.title ?? taskId })}\n\n`
    + `${detail}\n\n`
    + `${NO_AI(L)}\n\n`
    + `${tl(L, '怎么答：')}\n`
    + `· ${tl(L, '换个说法再给它一次：直接在下面写，最好说清楚要改什么、哪些不动。原来那条作废，换成你这次写的。')}\n`
    + `· ${tl(L, '不改了：回"算了"。原来那条作废，任务照原来的计划接着做。')}\n`
    + `· ${HOW_TO_ABORT(L)}`;
  return raise(db, { taskId, kind: 'replan_failed', text, detail, at, extra: { messageId } });
}

/**
 * 交回事项答完之后。由 project.mjs 的 RESOLUTION_HOOKS.structural 最先调用：不是交回事项就返回 null，别的结构矛盾照旧。
 */
export function handbackHook(db, { question, finalBody, by, messageId, at }) {
  const taskId = question.task_id;
  const h = getParam(db, taskId, HANDBACK_KEY);
  if (!h || h.questionId !== question.id) return null;
  const L = contentLang(db);
  const body = String(finalBody ?? '').trim();
  setParam(db, { taskId, key: HANDBACK_KEY, value: null, by: BY, governance: 'execution' });
  if (/^(中止|放弃|不要了|abort)/i.test(body)) {
    audit(db, { actorKind: 'user', actorId: by, action: 'handback_answer_abort', targetType: 'task', targetId: taskId,
      payload: { questionId: question.id, kind: h.kind, why: tl(L, '答复要求中止，这一步不可逆，留给人在任务页做') } });
    return { handled: false, abort: true };
  }
  if (h.kind === 'merge_hook' && h.decision === 'ask' && HOOK_APPROVE.test(body)) {
    // 放行这一版：记下 key（任务 + 工作区的头），下一拍推进时合并闸门认它
    setParam(db, { taskId, key: 'hooks.merge_approved', value: h.key, by: { kind: 'user', id: by }, governance: 'constitutional' });
    audit(db, { actorKind: 'user', actorId: by, action: 'merge_hook_approved', targetType: 'task', targetId: taskId, payload: { questionId: question.id, key: h.key } });
    return { handled: true, approved: true, kind: h.kind };
  }
  if (h.kind === 'merge_hook' && h.decision === 'failed') {
    // 同 advance_failed：不是 AI 的活。事项一答，合并闸门下一拍重新跑
    audit(db, { actorKind: 'user', actorId: by, action: 'merge_hook_retry_requested', targetType: 'task', targetId: taskId, payload: { questionId: question.id, body: body.slice(0, 300) } });
    return { handled: true, retry: true, kind: h.kind };
  }
  if ((h.kind === 'ci_failed' || h.kind === 'project_ci_failed') && DECLINE_RE.test(body)) {
    audit(db, { actorKind: 'user', actorId: by, action: 'ci_fix_declined', targetType: 'task', targetId: taskId, payload: { questionId: question.id, kind: h.kind } });
    return { handled: true, declined: true, kind: h.kind };
  }
  if (h.kind === 'project_ci_failed' || (h.kind === 'ci_redeliver_failed' && /^(推了|已推|pushed|done)/i.test(body))) {
    // 项目那条只能人去加任务；推了那条人已经自己推了：都不转修正
    audit(db, { actorKind: 'user', actorId: by, action: 'handback_acknowledged', targetType: 'task', targetId: taskId, payload: { questionId: question.id, kind: h.kind, body: body.slice(0, 300) } });
    return { handled: true, acknowledged: true, kind: h.kind };
  }
  if (h.kind === 'advance_failed') {
    // 不转修正：这不是 AI 的活。守护进程看到这条事项答了就清掉退避、立刻再试（daemon.advanceProjects）。
    audit(db, { actorKind: 'user', actorId: by, action: 'advance_retry_requested', targetType: 'task', targetId: taskId,
      payload: { questionId: question.id, body: body.slice(0, 300) } });
    return { handled: true, retry: true, kind: h.kind };
  }
  if (h.kind === 'replan_failed' && h.messageId) {
    // 原来那条不再处理：标成已消费（不删 —— 审计与出处边都还指着它）。
    markMessageConsumed(db, h.messageId, at);
    audit(db, { actorKind: 'user', actorId: by, action: 'messages_consumed', targetType: 'task', targetId: taskId,
      payload: { messageIds: [h.messageId], why: tl(L, '改计划没成，人{what}（事项 {id}）', { what: DROP_RE.test(body) ? tl(L, '撤回了这条') : tl(L, '换了个说法'), id: question.id }) } });
    if (DROP_RE.test(body)) {
      // 没有新消息 —— 记一条 task_resumed 当触发动作，守护进程才会把任务拉起来照原计划做。
      audit(db, { actorKind: 'user', actorId: by, action: 'task_resumed', targetType: 'task', targetId: taskId,
        payload: { via: 'handback:replan_failed', dropped: h.messageId } });
      return { handled: true, dropped: true, kind: h.kind };
    }
  }
  const mark = markOf(L, { dirty_workspace: 'mergeBlocked', merge_hook: 'mergeBlocked', replan_failed: 'replanFailed', ci_failed: 'ciFailed', ci_redeliver_failed: 'ciRedeliverFailed' }[h.kind] ?? 'verifyFailed');
  const tok = messageId ? db.one(`SELECT token_id FROM messages WHERE id=?`, messageId)?.token_id ?? null : null;
  const mid = newId('m');
  const reason = `${mark}${body || tl(L, '（没有补充）')}\n\n${tl(L, '—— 系统附（不由模型生成）——')}\n${h.detail ?? ''}`;
  insertUserMessage(db, { id: mid, taskId, senderId: by, tokenId: tok, body: reason, kind: 'correction', urgency: 'urgent', receivedAt: at });
  if (messageId) insertEdge(db, mid, messageId, 'derived_from', at);
  // CI 没过那两条：这一轮由答复人授权，修好之后系统照样把新提交推回 PR（推的人是他）
  if (h.kind === 'ci_failed' || h.kind === 'ci_redeliver_failed') noteAnsweredFix(db, { taskId, by, tokenId: tok, messageId: mid, at });
  // 合并卡住的那一档任务是 done + 已签收：放回 running，否则守护进程不拉它，这条修正就没人处理。
  if (db.one(`SELECT status FROM tasks WHERE id=?`, taskId)?.status === 'done') {
    transition(db, 'tasks', taskId, 'running');
    audit(db, { actorKind: 'user', actorId: by, action: 'task_resumed', targetType: 'task', targetId: taskId,
      payload: { from: 'done', to: 'running', via: `handback:${h.kind}` } });
  }
  audit(db, { actorKind: 'user', actorId: by, action: 'message_received', targetType: 'task', targetId: taskId,
    payload: { messageId: mid, kind: 'correction', kindSource: 'explicit', urgency: 'urgent', urgencySource: 'explicit', via: `handback:${h.kind}` } });
  return { handled: true, messageId: mid, kind: h.kind };
}
