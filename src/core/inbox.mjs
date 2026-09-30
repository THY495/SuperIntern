// Inbox —— 人对系统说话的唯一入口。
//
// 最常见的一类消息是**答复**（回答一个挂起分支提出的问题）。但通道本身
// 不是为答复设计的，是为那条硬规则设计的：**指令效力只授予认证通道**。
//
// 这条规则是"规划器结构上碰不到"的护栏之一，而且带着实弹：
// 复工装配会把答复正文读进上下文，并明确告诉模型"这一条你必须照办"。
// 如果这条路径能被无令牌写入，那"必须照办"就成了任何能写库的东西都能伪造的东西。

import { newId, now, audit, insertEdge, authenticate } from '../db/db.mjs';
import { commentOnQuestion } from './answers.mjs';
import { classify } from './classifier.mjs';
import { flushLedger } from './ledger.mjs';
import { hasComparableDecisions } from './decisions.mjs';
import { tl, contentLang, I18nError } from '../i18n/index.mjs';

// 答复的实现搬到了 answers.mjs（一对多、法定人数、冲突、负责人覆盖）。这里保留同名导出，调用方不变。
export { recordAnswer } from './answers.mjs';

/** 某任务里还开着的问题。编排器每轮开头问这一句来决定要不要退出。 */
export const openQuestions = (db, taskId) => db.all(
  `SELECT * FROM questions WHERE task_id=? AND status IN ('open','escalated') ORDER BY asked_at`, taskId);

// ═══════════════════════════════════════════════════════════════════════════
// 人主动发来的消息
// ═══════════════════════════════════════════════════════════════════════════

/** 消息的四类语义。 */
export const MESSAGE_KINDS = {
  instruction: '新指令 —— 在原任务之外要求做一件新的事',
  correction: '对原任务的修正 —— 改目标、改范围、推翻已做的判断',
  context: '补充上下文 —— 情报，不改变要做什么',
  answer: '对 agent 提问的回答 —— 走 recordAnswer，不走这里',
};

/**
 * 写入一条人发来的消息。
 *
 * ⚠️ **`kind` 必须显式给**，不设默认值。理由不是严格，是 `kind_source` 这个列的
 * 存在意义：它记的是"这一类是谁判的"。没给 `--kind` 时填一个默认值再标
 * `kind_source='explicit'`，等于系统替人做了判断却签上人的名字 ——
 * 那正是这个项目反复抓到的那种安静的谎。
 * 自动分类是分类器的活，它会填 `kind_source='classifier'`。
 *
 * 本函数**保持同步、不调用模型**：分类是它之前的一步（classifier.mjs），
 * 结果经 `kind / urgency / kindSource / urgencySource / confidence / questionId`
 * 作为参数传进来。库层规矩（认证、CHECK、事务）不和一次网络调用绑在同一个函数里。
 *
 * ⚠️ `urgency` 与 `kind` **不同**：紧急只有"是/否"两态，发送者有 `--urgent` 可用
 * 而没用，本身就是一次表态。所以缺省记 `explicit` + `normal` 是诚实的；
 * 分类器判的紧急度由调用方传 `urgencySource='classifier'` 进来，这里照实落库。
 */
export function recordMessage(db, {
  taskId, body, kind, urgency = 'normal', urgencySource = 'explicit',
  kindSource = 'explicit', confidence = null, questionId = null,
  classificationWhy = null, replyToMessageId = null, aboutQuestionId = null, plaintextToken,
  holdForCheck: hold = false,
}) {
  if (!body?.trim()) throw new I18nError('消息内容不能为空');

  // 分类器判为"这是在回答某个开着的问题"：**绝不插 messages、绝不自动 recordAnswer**。
  // 回答要挂 answers 边、要解冻分支、要签人的名字，必须由人显式做（cli answer）。
  // 这里只把 questionId 向上返回，让 CLI / 看板给出一条可直接执行的答复命令。
  if (questionId) {
    const q = db.one(`SELECT * FROM questions WHERE id=?`, questionId);
    if (!q) throw new I18nError('消息被识别为对事项的答复，但事项不存在：{id}', { id: questionId });
    if (q.task_id !== taskId) throw new I18nError('事项 {id} 不属于任务 {taskId}', { id: questionId, taskId });
    if (!['open', 'escalated'].includes(q.status)) {
      throw new I18nError('事项 {id} 状态为 {status}，已不接受答复，消息未作为答复处理', { id: questionId, status: q.status });
    }
    return { questionId: q.id, kind: 'answer', messageId: null, taskId,
      ...(confidence != null ? { confidence } : {}),
      ...(classificationWhy ? { classificationWhy } : {}) };
  }

  if (!MESSAGE_KINDS[kind]) {
    throw new I18nError('必须指定消息类别（kind）。可选：\n{kinds}',
      { kinds: Object.entries(MESSAGE_KINDS).map(([k, d]) => `  ${k.padEnd(12)} ${d}`).join('\n') });
  }
  if (kind === 'answer') {
    throw new I18nError('答复不能作为消息发送，请对该事项使用答复操作');
  }
  if (!['explicit', 'classifier'].includes(kindSource)) {
    throw new Error(`kind_source 无效：${kindSource}（应为 explicit 或 classifier）`);
  }
  if (!['explicit', 'classifier'].includes(urgencySource)) {
    throw new Error(`urgency_source 无效：${urgencySource}（应为 explicit 或 classifier）`);
  }

  // 认证在前。失败不该泄露"这个任务存不存在"（与 recordAnswer 同规矩）。
  const auth = authenticate(db, plaintextToken);
  if (!auth) {
    throw new I18nError('令牌无效或已吊销');
  }
  const task = db.one(`SELECT id, status FROM tasks WHERE id=?`, taskId);
  if (!task) throw new I18nError('任务不存在：{taskId}', { taskId });

  // 旁观者：留言的 trust_label 是 observed-untrusted、类别只能是 context —— 不进任何决策，但必须被看到。
  // 有令牌不等于有指令效力：效力由角色与路由表给，令牌只证明"是谁"。
  const role = db.one(`SELECT role FROM users WHERE id=?`, auth.user_id)?.role;
  const observer = role === 'observer';
  if (observer && kind !== 'context') {
    throw kind === 'instruction' ? new I18nError('旁观者只能留言（类别为 context），不能发送指令；如需调整任务方向，请联系负责人')
      : new I18nError('旁观者只能留言（类别为 context），不能发送修正；如需调整任务方向，请联系负责人');
  }
  const trust = observer ? 'observed-untrusted' : 'user-authenticated';

  const mid = newId('m');
  const t = now();
  return db.tx(() => {
    db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,
              trust_label,token_id,received_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      mid, taskId, auth.user_id, body, kind, kindSource, urgency, urgencySource, trust, auth.token_id, t);
    if (replyToMessageId) insertEdge(db, mid, replyToMessageId, 'reply_to', t);
    // 调用方接下来要拿这条去和已登记的决定比对 —— 同一个事务里标"待比对"，守护进程就不可能抢在比对之前拉走它。
    if (hold && (kind === 'correction' || kind === 'instruction') && hasComparableDecisions(db, taskId)) holdForCheck(db, [mid], { at: t });
    // 挂在某条事项上的留言：附在事项上（不进决策）；事项已决则是"记录在案的异议"。
    if (aboutQuestionId) commentOnQuestion(db, { questionId: aboutQuestionId, messageId: mid, userId: auth.user_id, body, at: t });
    audit(db, { actorKind: 'user', actorId: auth.user_id, action: 'message_received',
      targetType: 'task', targetId: taskId,
      payload: { messageId: mid, kind, kindSource, urgency, urgencySource, trust, aboutQuestionId,
        bytes: body.length, tokenId: auth.token_id,
        ...(confidence != null ? { confidence } : {}),
        ...(classificationWhy ? { classificationWhy } : {}) } });
    return { messageId: mid, kind, urgency, taskId, kindSource, urgencySource, trust, aboutQuestionId };
  });
}

/**
 * 人发消息的**唯一切入点**（CLI 与看板共用）：先分类（若没显式给 --kind）再落库。
 *
 * - 显式给了 `kind`：分类器**根本不被调用**，`kind_source='explicit'`，一个字不改。
 * - 没给 `kind`：调 classifier.mjs（standard 档）分类，落库 `kind_source='classifier'`、
 *   `urgency_source='classifier'`；低置信时 confidence 进审计 payload。
 * - 分类器判为 answer：不入 messages、不自动 recordAnswer，只把 questionId 向上返回。
 *
 * 分类器的模型调用经 flushLedger 记账（role='classifier'），无论成败都落账 ——
 * 失败的尝试同样烧了钱，漏记等于把预算闸门捅个洞（与 cmdPlan 同一条规矩）。
 */
export async function sayWithClassifier(db, {
  taskId, body, kind = null, urgency = 'normal', urgencySource = 'explicit',
  replyToMessageId = null, aboutQuestionId = null, plaintextToken, llmClient, openQuestions: openQs,
  holdForCheck: hold = false,
}) {
  if (!body?.trim()) throw new I18nError('消息内容不能为空');

  if (kind) {
    // 人显式给了类别：分类器不参与。urgencySource 也如实按调用方（--urgent）给。
    return recordMessage(db, {
      taskId, body, kind, urgency, urgencySource, kindSource: 'explicit',
      replyToMessageId, aboutQuestionId, plaintextToken, holdForCheck: hold,
    });
  }

  if (!llmClient) {
    throw new I18nError('未指定消息类别，且分类器不可用');
  }

  const qs = openQs ?? openQuestions(db, taskId);
  let cls;
  try {
    cls = await classify(body, { openQuestions: qs, llmClient });
  } finally {
    flushLedger(db, llmClient, { taskId, role: 'classifier' });
  }

  return recordMessage(db, {
    taskId, body,
    kind: cls.kind,
    urgency: cls.urgency,
    urgencySource: 'classifier',
    kindSource: 'classifier',
    confidence: cls.confidence,
    questionId: cls.questionId,
    classificationWhy: cls.why,
    replyToMessageId,
    aboutQuestionId,
    plaintextToken,
    holdForCheck: hold,
  });
}

/**
 * 还没被消费的消息。
 *
 * `consumed_at` 标的是"**这条消息已经改变了系统状态**"，不是"被谁看过一眼"：
 * 一条补充上下文被读进某个节点、而那个节点最终失败退回，它当然还得再出现一次。
 * 按"看过"标记会让消息在一次失败的重试里静默蒸发。
 */
export const pendingMessages = (db, taskId, { at = now() } = {}) => db.all(
  `SELECT * FROM messages m WHERE task_id=? AND consumed_at IS NULL AND kind<>'answer'
     AND NOT (${HELD_SQL})
    ORDER BY received_at, rowid`, taskId, at);

// ── 修正等裁定 ──────────────────────────────────────────────────────────────
//
// 一条修正（或新指令）在两种情形下**先不给任何人执行**：
//   ① 待比对：它刚落库，决定比对器还在对着有效决定清单看它（几秒）。`held_until` 是个时间戳 ——
//      比对器所在的进程死在半路，到点自己放行，不会卡死。
//   ② 等裁定：比对命中了，冲突事项从它派生出来（事项 → 消息 的 derived_from 边），事项还没结论。
//      这时它的接收者就是那条事项的收件人 —— 停等账本解引用得到人，不是静默停摆。
// 两种都**不是**"消费了"：`consumed_at` 仍为空，放行之后原样出现。
//
// 被挡住的不只是重规划器：执行器的收件箱段也读 `pendingMessages`，不一起挡就等于让执行器
// 先把那句还在等裁定的话照做了。所以挡在这个唯一的读口上。
//
// "等裁定"只认**决定冲突**事项（它另有出处边指向 `dr_*`）—— 别的事项也可能从一条消息派生
// （重规划器的提问），那种事项开着时消息照常出现，行为不变。
export const HOLD_FOR_CHECK_MS = 3 * 60_000;

const VERDICT_WAIT_SQL = `EXISTS (SELECT 1 FROM edges e JOIN questions q ON q.id=e.from_id
     WHERE e.to_id=m.id AND e.relation='derived_from' AND q.status IN ('open','escalated')
       AND EXISTS (SELECT 1 FROM edges d WHERE d.from_id=q.id AND d.relation='derived_from' AND d.to_id LIKE 'dr_%'))`;
const HELD_SQL = `(m.held_until IS NOT NULL AND m.held_until > ?) OR ${VERDICT_WAIT_SQL}`;

/**
 * 还没消费、但此刻被挡住的修正 / 新指令，各带挡住的理由：
 *   { message, why: 'check', until }                    —— 待比对，`until` 到点自己放行
 *   { message, why: 'verdict', questionIds: [...] }     —— 等裁定
 */
export function heldSteering(db, taskId, { at = now() } = {}) {
  const rows = db.all(`SELECT * FROM messages m WHERE task_id=? AND consumed_at IS NULL
                         AND kind IN ('correction','instruction') AND (${HELD_SQL})
                       ORDER BY received_at, rowid`, taskId, at);
  return rows.map((m) => {
    const qs = verdictWaitOf(db, m.id);
    return qs.length ? { message: m, why: 'verdict', questionIds: qs } : { message: m, why: 'check', until: m.held_until };
  });
}

/** 这条消息在等哪几条决定冲突事项的结论（没有就空）。 */
export const verdictWaitOf = (db, messageId) => db.all(
  `SELECT q.id FROM edges e JOIN questions q ON q.id=e.from_id
    WHERE e.to_id=? AND e.relation='derived_from' AND q.status IN ('open','escalated')
      AND EXISTS (SELECT 1 FROM edges d WHERE d.from_id=q.id AND d.relation='derived_from' AND d.to_id LIKE 'dr_%')
    ORDER BY q.asked_at`, messageId).map((r) => r.id);

/** 有没有**此刻能处理**的修正 / 新指令（被挡住的不算）。守护进程与编排器共用这一个口径。 */
export const hasSteering = (db, taskId, { at = now() } = {}) =>
  pendingMessages(db, taskId, { at }).some((m) => m.kind === 'correction' || m.kind === 'instruction');

/** 标"待比对"。只标还没消费的修正 / 新指令。 */
export function holdForCheck(db, ids, { at = now() } = {}) {
  for (const id of ids) {
    db.run(`UPDATE messages SET held_until=? WHERE id=? AND consumed_at IS NULL AND kind IN ('correction','instruction')`,
      at + HOLD_FOR_CHECK_MS, id);
  }
}

/**
 * 比对跑完（命中与否、成败与否）一律调这个。放行的是"待比对"那一层；命中了的那条仍被
 * "等裁定"挡着 —— 那一层靠事项状态，不靠这一列。
 * 真正变得可处理的消息记一条 `message_released`：守护进程认它是触发动作，
 * 否则比对期间被拉起又退出的那一轮之后，就没有东西再叫醒这个任务。
 */
export function releaseCheckHold(db, { taskId, ids, at = now() }) {
  const freed = [], waiting = [];
  for (const id of ids) {
    const m = db.one(`SELECT id, held_until, consumed_at FROM messages WHERE id=?`, id);
    if (!m || m.held_until == null) continue;
    db.run(`UPDATE messages SET held_until=NULL WHERE id=?`, id);
    if (m.consumed_at != null) continue;
    const qs = verdictWaitOf(db, id);
    if (qs.length) waiting.push({ id, questionIds: qs }); else freed.push(id);
  }
  if (freed.length) {
    audit(db, { actorKind: 'system', actorId: 'decision-check', action: 'message_released', targetType: 'task', targetId: taskId,
      payload: { messageIds: freed, why: tl(contentLang(db), '比对已跑完，没有撞上仍然有效的旧决定') } });
  }
  for (const w of waiting) {
    audit(db, { actorKind: 'system', actorId: 'decision-check', action: 'message_held_for_verdict', targetType: 'task', targetId: taskId,
      payload: { messageId: w.id, questionIds: w.questionIds, why: tl(contentLang(db), '这条修正里有说法撞上了仍然有效的旧决定，等那条冲突事项有结论再执行') } });
  }
  return { freed, waiting };
}

/**
 * 从一条输入找出"这次比对替谁把关"的那几条修正：它自己（若本身就是修正 / 新指令），
 * 加上从它派生出来、还没消费的修正 / 新指令 —— 签收打回那条路上，比对的是**答复**的原文，
 * 而要等的是钩子从答复生成的那条修正。
 */
export function steeringFrom(db, sourceId) {
  if (!sourceId) return [];
  const own = db.one(`SELECT id FROM messages WHERE id=? AND consumed_at IS NULL AND kind IN ('correction','instruction')`, sourceId);
  const derived = db.all(`SELECT m.id FROM edges e JOIN messages m ON m.id=e.from_id
                           WHERE e.to_id=? AND e.relation='derived_from' AND m.consumed_at IS NULL
                             AND m.kind IN ('correction','instruction')`, sourceId).map((r) => r.id);
  return [...new Set([...(own ? [own.id] : []), ...derived])];
}

/**
 * 标记消费的**无事务**版本。给已经在事务里的调用方用。
 *
 * ⚠️ 分成两个函数而不是在里面判断"当前是不是已在事务中"：SQLite 不支持嵌套
 * `BEGIN`，而"自己看看在不在事务里"这种隐式魔法会让调用方读不出真实行为。
 * 谁在事务里，谁就显式调这一个。（实测踩过：applyRevision 包着事务调
 * consumeMessages，直接 `cannot start a transaction within a transaction`。）
 */
export function markConsumed(db, { taskId, ids, why }) {
  if (!ids.length) return 0;
  const t = now();
  for (const id of ids) db.run(`UPDATE messages SET consumed_at=? WHERE id=? AND consumed_at IS NULL`, t, id);
  audit(db, { actorKind: 'system', action: 'messages_consumed', targetType: 'task', targetId: taskId,
    payload: { messageIds: ids, why, pid: process.pid } });
  return ids.length;
}

/** 标记消费。`why` 进审计 —— 复盘时"这条消息是被什么处理掉的"要答得出来。 */
export function consumeMessages(db, { taskId, ids, why }) {
  if (!ids.length) return 0;
  return db.tx(() => markConsumed(db, { taskId, ids, why }));
}
