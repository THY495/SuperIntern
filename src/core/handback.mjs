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
import { routeQuestion } from './routing.mjs';
import { getParam, setParam } from './params.mjs';

export const HANDBACK_KEY = 'task.handback';
export const VERIFY_FAILED_MARK = '【验收没过】';
export const DIRTY_MARK = '【合并卡住】';

const BY = { kind: 'agent', id: 'handback' };
const HOW_TO_ABORT = '不要这个任务了：到任务页点「中止」。这一步不可逆，答复里写"中止"不算数，得你自己去点。';

/** 这个任务上还开着的交回事项（同一种只挂一条）。 */
export function openHandback(db, taskId, kind = null) {
  const h = getParam(db, taskId, HANDBACK_KEY);
  if (!h?.questionId || (kind && h.kind !== kind)) return null;
  const q = db.one(`SELECT id, status FROM questions WHERE id=?`, h.questionId);
  return q && ['open', 'escalated'].includes(q.status) ? h : null;
}

function raise(db, { taskId, kind, text, detail, at, extra = {} }) {
  const cur = openHandback(db, taskId, kind);
  if (cur) return { questionId: cur.questionId, reused: true };
  const id = newId('q');
  return db.tx(() => {
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, id, taskId, text, at);
    // 验收没过是代码的事 → 结构矛盾（必含负责人）；其余是系统卡住 → 运维（负责人可以只派给管代码的人）。都禁 default，不会到期自己消失。
    const r = routeQuestion(db, { questionId: id, decisionType: kind === 'verify_failed' ? 'structural' : 'ops', typeSource: 'hard_rule', at });
    setParam(db, { taskId, key: HANDBACK_KEY, value: { kind, questionId: id, at, detail, ...extra }, by: BY, governance: 'execution' });
    audit(db, { actorKind: 'system', action: 'handback_raised', targetType: 'task', targetId: taskId,
      payload: { kind, questionId: id, addressedTo: r.answerers } });
    return { questionId: id, text, addressedTo: r.answerers };
  });
}

const tailOf = (s, n = 20) => String(s ?? '').trim().split('\n').slice(-n).join('\n');

/** 任务级验收没过。 */
export function raiseVerifyFailed(db, { taskId, verification: v, at = now() }) {
  const task = db.one(`SELECT title FROM tasks WHERE id=?`, taskId);
  const cmd = Array.isArray(v?.argv) ? v.argv.join(' ') : '（没有命令）';
  const code = v?.code === null || v?.code === undefined ? '（没跑起来）' : v.code;
  const detail = `验收命令：${cmd}\n退出码：${code}${v?.timedOut ? '（超时）' : ''}\n输出尾部：\n${tailOf(v?.tail) || '（空）'}`;
  const text = `${VERIFY_FAILED_MARK}任务「${task?.title ?? taskId}」的步骤都做完了，但任务的验收没过，所以没有进入签收。\n\n`
    + `${detail}\n\n`
    + `（这条是系统按规则直接生成的，没有经过 AI。）\n\n`
    + `怎么答：\n`
    + `· 想先看看再决定：到任务页看「改动」（这个任务改了哪些代码）和「日志」（验收的完整输出），看完再回来答。\n`
    + `· 让 AI 接着修：直接在下面写一句你的判断或要求（比如"是测试写错了"、"先把构建修好"），只写"接着修"也行。`
    + `你写的话会连同上面的失败输出一起交给 AI，它重新规划、改完再验收。\n`
    + `· ${HOW_TO_ABORT}`;
  return raise(db, { taskId, kind: 'verify_failed', text, detail, at });
}

/** 签收之后、合并之前，工作区里还有没提交的改动（且不全是构建产物）。 */
export function raiseDirtyWorkspace(db, { taskId, files, at = now() }) {
  const task = db.one(`SELECT title FROM tasks WHERE id=?`, taskId);
  const list = files.slice(0, 30).join('\n') + (files.length > 30 ? `\n……共 ${files.length} 处` : '');
  const detail = `签收之后工作区里还有没提交的改动（不在签收过的那一版里）：\n${list}`;
  const text = `${DIRTY_MARK}任务「${task?.title ?? taskId}」已经签收，但它的工作区里还有没提交的改动，系统不替你决定要不要它们，所以先没合并。\n\n`
    + `${detail}\n\n`
    + `（这条是系统按规则直接生成的，没有经过 AI。）\n\n`
    + `怎么答：\n`
    + `· 让 AI 处理：直接写一句（比如"都不要"、"把 README 的改动提交上"），只写"让 AI 处理"也行；`
    + `拿不准某个文件是什么，就写"先看看这几个文件是什么，数据文件别删"。\n`
    + `　AI 会照你的话处理。只丢掉的话，签过的那一版一个字不变、不用重新签收；提交了新内容，才会重新请你签收。\n`
    + `· ${HOW_TO_ABORT}`;
  return raise(db, { taskId, kind: 'dirty_workspace', text, detail, at });
}

export const ADVANCE_FAILED_MARK = '【合并出错】';

/**
 * 项目推进（合并 / 开下一个任务）按退避表连试几次都失败了。原来退避表用完就 `?? Infinity` —— **永远不再试，也不告诉任何人**。
 * 这类错多半不是 AI 能修的（服务器、磁盘、git 状态），所以答复不转成修正：人回一句 = 再试一次（守护进程看到答复就清掉退避）。
 */
export function raiseAdvanceFailed(db, { projectId, taskId = null, error, attempts, at = now() }) {
  const host = taskId ?? db.one(`SELECT id FROM tasks WHERE project_id=? ORDER BY COALESCE(project_order,0) LIMIT 1`, projectId)?.id;
  if (!host) return { questionId: null };
  const p = db.one(`SELECT title FROM projects WHERE id=?`, projectId);
  const task = taskId ? db.one(`SELECT title FROM tasks WHERE id=?`, taskId) : null;
  const detail = `最近一次的错误：${String(error ?? '').slice(0, 600)}`;
  const text = `${ADVANCE_FAILED_MARK}项目「${p?.title ?? projectId}」${task ? `在合并任务「${task.title}」时` : '在往前推进时'}反复出错，已经自动重试了 ${attempts} 次。\n\n`
    + `${detail}\n\n`
    + `这多半是系统或服务器上的问题，不是谁的疏忽，AI 也修不了。系统会隔一段时间自己再试，但不再指望它自己好。（这条是系统按规则直接生成的，没有经过 AI。）\n\n`
    + `怎么答：\n`
    + `· 你不是管理员：点「转交」把这条交给管理员，上面的错误原文就是给管理员看的。\n`
    + `· 原因已经排除了（比如管理员说磁盘清出来了）：回一句"再试"。系统收到立刻重试；还不行的话，会接着隔一段时间自己试，又失败几次后再问一次。\n`
    + `· ${HOW_TO_ABORT}`;
  return raise(db, { taskId: host, kind: 'advance_failed', text, detail, at });
}

export const REPLAN_FAILED_MARK = '【改计划没成】';

/**
 * 人发来的修正 / 新指令，重规划器几次都没产出合规的新计划（原来：只退出、那条消息原样挂着、30 分钟后停等报警；
 * 人回 A 只会让它拿同一条话再失败一次）。答复 = 换个说法：原来那条作废，换成人这次写的；回"算了" = 原来那条作废、照原计划做。
 */
export function raiseReplanFailed(db, { taskId, messageId, why, at = now() }) {
  const task = db.one(`SELECT title FROM tasks WHERE id=?`, taskId);
  const m = messageId ? db.one(`SELECT body, sender_id FROM messages WHERE id=?`, messageId) : null;
  const who = m?.sender_id ? db.one(`SELECT display_name FROM users WHERE id=?`, m.sender_id)?.display_name : null;
  const detail = `原来那条话${who ? `（${who} 发的）` : ''}：\n${String(m?.body ?? '（找不到原文）').slice(0, 1500)}\n\n没改成的原因：${String(why ?? '（没有记下）').slice(0, 600)}`;
  const text = `${REPLAN_FAILED_MARK}发给任务「${task?.title ?? taskId}」的一条修正，AI 试了几次都没能改成一份合规的新计划，任务停在这里。\n\n`
    + `${detail}\n\n`
    + `（这条是系统按规则直接生成的，没有经过 AI。）\n\n`
    + `怎么答：\n`
    + `· 换个说法再给它一次：直接在下面写，最好说清楚要改什么、哪些不动。原来那条作废，换成你这次写的。\n`
    + `· 不改了：回"算了"。原来那条作废，任务照原来的计划接着做。\n`
    + `· ${HOW_TO_ABORT}`;
  return raise(db, { taskId, kind: 'replan_failed', text, detail, at, extra: { messageId } });
}

/**
 * 交回事项答完之后。由 project.mjs 的 RESOLUTION_HOOKS.structural 最先调用：不是交回事项就返回 null，别的结构矛盾照旧。
 */
export function handbackHook(db, { question, finalBody, by, messageId, at }) {
  const taskId = question.task_id;
  const h = getParam(db, taskId, HANDBACK_KEY);
  if (!h || h.questionId !== question.id) return null;
  const body = String(finalBody ?? '').trim();
  setParam(db, { taskId, key: HANDBACK_KEY, value: null, by: BY, governance: 'execution' });
  if (/^(中止|放弃|不要了|abort)/i.test(body)) {
    audit(db, { actorKind: 'user', actorId: by, action: 'handback_answer_abort', targetType: 'task', targetId: taskId,
      payload: { questionId: question.id, kind: h.kind, why: '答复要求中止，这一步不可逆，留给人在任务页做' } });
    return { handled: false, abort: true };
  }
  if (h.kind === 'advance_failed') {
    // 不转修正：这不是 AI 的活。守护进程看到这条事项答了就清掉退避、立刻再试（daemon.advanceProjects）。
    audit(db, { actorKind: 'user', actorId: by, action: 'advance_retry_requested', targetType: 'task', targetId: taskId,
      payload: { questionId: question.id, body: body.slice(0, 300) } });
    return { handled: true, retry: true, kind: h.kind };
  }
  if (h.kind === 'replan_failed' && h.messageId) {
    // 原来那条不再处理：标成已消费（不删 —— 审计与出处边都还指着它）。
    db.run(`UPDATE messages SET consumed_at=? WHERE id=? AND consumed_at IS NULL`, at, h.messageId);
    audit(db, { actorKind: 'user', actorId: by, action: 'messages_consumed', targetType: 'task', targetId: taskId,
      payload: { messageIds: [h.messageId], why: `改计划没成，人${/^(算了|不改了|不用了)/.test(body) ? '撤回了这条' : '换了个说法'}（事项 ${question.id}）` } });
    if (/^(算了|不改了|不用了)/.test(body)) {
      // 没有新消息 —— 记一条 task_resumed 当触发动作，守护进程才会把任务拉起来照原计划做。
      audit(db, { actorKind: 'user', actorId: by, action: 'task_resumed', targetType: 'task', targetId: taskId,
        payload: { via: 'handback:replan_failed', dropped: h.messageId } });
      return { handled: true, dropped: true, kind: h.kind };
    }
  }
  const mark = { dirty_workspace: DIRTY_MARK, replan_failed: REPLAN_FAILED_MARK }[h.kind] ?? VERIFY_FAILED_MARK;
  const tok = messageId ? db.one(`SELECT token_id FROM messages WHERE id=?`, messageId)?.token_id ?? null : null;
  const mid = newId('m');
  const reason = `${mark}${body || '（没有补充）'}\n\n—— 系统附（不由模型生成）——\n${h.detail ?? ''}`;
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
          VALUES (?,?,?,?,'correction','explicit','urgent','explicit','user-authenticated',?,?)`, mid, taskId, by, reason, tok, at);
  if (messageId) insertEdge(db, mid, messageId, 'derived_from', at);
  // 合并卡住的那一档任务是 done + 已签收：放回 running，否则守护进程不拉它，这条修正就没人处理。
  if (db.one(`SELECT status FROM tasks WHERE id=?`, taskId)?.status === 'done') {
    db.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);
    audit(db, { actorKind: 'user', actorId: by, action: 'task_resumed', targetType: 'task', targetId: taskId,
      payload: { from: 'done', to: 'running', via: `handback:${h.kind}` } });
  }
  audit(db, { actorKind: 'user', actorId: by, action: 'message_received', targetType: 'task', targetId: taskId,
    payload: { messageId: mid, kind: 'correction', kindSource: 'explicit', urgency: 'urgent', urgencySource: 'explicit', via: `handback:${h.kind}` } });
  return { handled: true, messageId: mid, kind: h.kind };
}
