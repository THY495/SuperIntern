// 答复与冲突 —— 一条事项可以有多个人各答一次。
//
// 此前"答复"= 一条 messages(kind='answer') + 一条 answers 边，问题随即 answered。多人时这不够：
// 法定人数要数人头，同一问题的不同答案要能比对，负责人覆盖介入者时被覆盖的立场要留档（异议记录）。
// 所以每次答复先落 answers 表一行，再按路由行的法定人数与冲突策略决定**这条事项算不算已决**。
//
// 规矩：
//   - 谁能答：负责人恒可；否则要在事项创建时解析出的 addressed_to 里；旁观者不能答（留言走 say）。
//     没有路由信息的旧事项（route 为 NULL）按旧规矩：任何 lead / member 都能答。
//   - 负责人的答复覆盖介入者：立即生效；已有的不同答复标 dissent，审计 answer_overridden。
//   - `latest`（轮值）：任何一个收件人的答复立即生效；已决事项被当前收件人再答 = 后答生效并通知（审计 answer_superseded）。
//   - `block`：按各链的法定人数数人头；够数后**只有一条自己写的答复**才生效；有两条 → 两边都不生效，生成"冲突"事项，
//     原事项置 escalated 等结论，受影响节点继续挂起。
//
// 答复的三个动作。此前系统按**文字是否相等**判"答复一致不一致"——
// 那只对 A / B 选项与签收成立；多人 + 自由文本时必然误报："按 A 处理，判据换成……" 与
// "听后端的，按 A" 会被判为不一致，生成一条本不该有的冲突事项，白等一轮。
// 系统从此不再猜"这两段话是不是一个意思"，改成让人显式表态（只保留不会误报的那半边比对，见 positionsOf）：
//   - **答复**（stance=answer）：写自己的意见，作数。
//   - **附议**（stance=agree）：明确同意已有的某一条答复，不写新文本；计入法定人数，不构成新的立场。
//     agrees_with 记的是附议哪一条 —— 有了它，"够数了但有两条答复"就不必再靠文字去猜。
//   - **弃权**（stance=abstain）：这不归我。从该事项的收件人里去掉自己并记审计，法定人数按剩余人数重算；
//     某条链没人了就整条丢掉；一条链都不剩 → 转下一行，没有下一行就挂给负责人。
//     （顺带解决：收件人此前没有"这不归我"的出口，除了转交无路可走。）
//   第二个及以后的答复者**看得到已有答复的原文**（看板事项面板、CLI questions 都列）——
//   与真实团队一致：知道别人说了什么才谈得上附议或提出不同意见。
// 留下的文字比对都是**充分条件**方向的（成立就一定是同一个立场，不会把不同意见判成一致）：
// 一字不差算同一立场（positionsOf）、签收按接受 / 打回的方向归并；另有两处只影响标签不决定结论 ——
// 负责人写了与某条一字不差的答复时不把那条标成 dissent，迟到的答复与结论一字不差时记为附议而不是异议。
//   - 冲突事项：先双方阶段（parties，quorum all，一个工作日）—— 一致或一方撤回即达成；再不一致或超时 → 转下一行（负责人）。
//     结论回写原事项：赢的那条 message 挂 answers 边到原事项，输的答复标 dissent。
//   - agent 只保留一件事：冲突事项正文附对称影响简报。目前是模板（两边原文等深并列），不调模型。

import { newId, now, audit, insertEdge, authenticate } from '../db/db.mjs';
import { routeQuestion, advanceRoute, leadOf, requesterOf } from './routing.mjs';
import { recordFromQuestion } from './decisions.mjs';
import { CHOICES_MARK, choicesSide } from './choices.mjs';
// 方案会签按判读的方向归并，判读只有一份（agent/approval.mjs 只依赖 core，不成环）
import { approvalThreadOf, readVerdict, reservationOf } from '../agent/approval.mjs';

/** 事项按类型解决后的钩子（签收要写参数、打回要发修正）。由各模块注册，避免循环依赖。 */
export const RESOLUTION_HOOKS = {};
/**
 * 按事项本身（不按类型）认领的钩子，先于"答复进约定清单"与类型钩子。返回非 null = 认领了，后两步都跳过。
 * 起因：「AI 替你定了几件事」走的是规格取舍 / 结构矛盾的路由，但一条"A"登记成约定毫无意义，
 * 结构矛盾那个类型钩子（交回给人）也不是它的事。
 */
export const PRE_HOOKS = [];
/** 收件前检查（按决策类型）：抛错即拒收。由各模块注册（上限事项在 limits.mjs）。 */
export const ANSWER_GUARDS = {};

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const isWithdraw = (s) => /^(撤回|撤销|withdraw)/i.test(String(s ?? '').trim());
const nameOf = (db, userId) => db.one(`SELECT display_name FROM users WHERE id=?`, userId)?.display_name ?? userId;

/** 三个动作。answer / agree 计入法定人数；abstain 是"把我从收件人里去掉"，不计入。 */
export const STANCES = { answer: '答复', agree: '附议', abstain: '弃权' };
const COUNTED = ['answer', 'agree'];

/** 问题上现有的立场为 answer 的答复（按时间）。 */
export const answersOf = (db, questionId) => db.all(`SELECT * FROM answers WHERE question_id=? ORDER BY created_at, rowid`, questionId);
/** 自己写的、仍然算数的答复（附议不是新立场，dissent / superseded 已出局）。 */
export const writtenOf = (db, questionId) => answersOf(db, questionId).filter((a) => a.stance === 'answer');

/**
 * 写入一条答复。
 * @returns {{ messageId, questionId, nodeId, userId, stillOpen, resolved: boolean, pending?: {need, have}, conflictId?: string, finalBody?: string }}
 * @throws 令牌无效 / 问题不存在 / 问题已关闭 / 无权
 */
export function recordAnswer(db, { questionId, body, stance = 'answer', agreesWith = null, plaintextToken, at = now() }) {
  if (!STANCES[stance]) throw new Error(`立场无效：${stance}（只能是 ${Object.keys(STANCES).join(' / ')}）`);
  if (stance === 'answer' && !body?.trim()) throw new Error('答复内容不能为空');

  // ① 认证。**先认证再看问题**：认证失败不该泄露"这个问题存不存在"。
  const auth = authenticate(db, plaintextToken);
  if (!auth) {
    throw new Error('令牌无效或已吊销');
  }
  const user = db.one(`SELECT id, role FROM users WHERE id=?`, auth.user_id);
  if (user.role === 'observer') throw new Error('旁观者不能答复事项；可在该事项下留言，留言会附在事项上并进入负责人的摘要，但不计入决策');

  const q = db.one(`SELECT * FROM questions WHERE id=?`, questionId);
  if (!q) throw new Error(`事项不存在：${questionId}`);
  // 签收的答案空间是封闭的，入口就要收紧。原来不以"接受"开头的一律算打回、原文当理由 ——
  // 照着正文的"(A) 接受"答一个 A，就成了以"A"为理由打回，任务据此重新规划。
  if (q.decision_type === 'signoff' && stance === 'answer') body = signoffAnswer(body);
  const lead = leadOf(db, q.task_id);
  const isLead = auth.user_id === lead;
  const addressed = JSON.parse(q.addressed_to || '[]');
  const route = q.route ? JSON.parse(q.route) : null;
  const policy = q.conflict_policy ?? 'block';
  const isRecipient = addressed.includes(auth.user_id) || (!route && addressed.length === 0);

  const open = q.status === 'open' || q.status === 'escalated';
  const supersede = !open && q.status === 'answered' && policy === 'latest' && isRecipient;
  // 已决事项（block 路径）再收到介入者的答复：先答生效，迟到的是**意见**不是指令 —— 留痕（dissent / 附议）、通知负责人
  // 与生效答复的作者，不改结论。负责人要改结论走修正流程，所以负责人仍走下面的报错。
  if (!open && q.status === 'answered' && policy === 'block' && isRecipient && !isLead) {
    if (stance === 'abstain') throw new Error(`事项 ${questionId} 已有结论，不必再弃权`);
    return recordLateAnswer(db, { q, auth, body, stance, at, lead });
  }
  if (!open && !supersede) {
    throw new Error(`事项 ${questionId} 状态为 ${q.status}，不接受答复。`
      + (q.status === 'answered' ? '该事项已有结论；如需更改，请走修正流程提交计划变更。' : ''));
  }
  if (q.status === 'escalated' && q.decision_type !== 'conflict' && db.one(`SELECT id FROM questions WHERE origin_question_id=? AND status IN ('open','escalated')`, q.id) && !isLead) {
    throw new Error(`事项 ${questionId} 正在冲突处理中，请等待冲突事项的结论`);
  }
  if (!isLead && !isRecipient) {
    throw new Error(`无权答复：你不是该事项的接收人（接收人：${addressed.map((id) => db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id).join('、') || '无'}）。可请接收人或负责人将事项转交给你`);
  }

  // 弃权：不是一条立场，是"把我从收件人里去掉"。单独走一条路。
  if (stance === 'abstain') return recordAbstain(db, { q, auth, body, at, lead, addressed });

  // 附议：认的是**哪一条**，不是一段文字。目标没歧义时（只有一条自己写的答复）可以不指。
  let target = null;
  if (stance === 'agree') {
    const written = writtenOf(db, q.id).filter((a) => a.user_id !== auth.user_id);
    if (agreesWith) {
      target = written.find((a) => a.id === agreesWith || a.id.endsWith(agreesWith));
      if (!target) throw new Error(`附议的目标 ${agreesWith} 不在这条事项的答复里`);
    } else if (written.length === 1) target = written[0];
    else if (!written.length) throw new Error('这条事项还没有别人的答复可附议 —— 请写下你自己的意见');
    else throw new Error(`这条事项有 ${written.length} 条答复（${written.map((a) => `${nameOf(db, a.user_id)}：${a.id}`).join('、')}），附议要指明是哪一条`);
    body = `附议 ${nameOf(db, target.user_id)} 的答复：${String(target.body).trim()}`;
  }
  // 按类型的收件前检查（抛错 = 拒收，什么都不记）：答复本身做不到的事，当场说清楚该去哪儿做
  if (stance === 'answer' && ANSWER_GUARDS[q.decision_type]) ANSWER_GUARDS[q.decision_type](db, { question: q, body, userId: auth.user_id });

  const mid = newId('m');
  const aid = newId('a');
  return db.tx(() => {
    // trust_label='user-authenticated' 受库层 CHECK 把守：缺 token_id 或 sender_id 直接 ABORT。
    db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
            VALUES (?,?,?,?,'answer','explicit','normal','explicit','user-authenticated',?,?)`,
    mid, q.task_id, auth.user_id, body, auth.token_id, at);
    db.run(`INSERT INTO answers (id,question_id,user_id,message_id,body,stance,agrees_with,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      aid, q.id, auth.user_id, mid, body, stance, target?.id ?? null, at);
    audit(db, { actorKind: 'user', actorId: auth.user_id, action: 'answer_recorded', targetType: 'question', targetId: q.id,
      payload: { messageId: mid, answerId: aid, level: q.level, decisionType: q.decision_type, isLead, policy, stance,
        agreesWith: target?.id ?? null, body: body.slice(0, 800), pid: process.pid } });

    const base = { messageId: mid, answerId: aid, questionId: q.id, nodeId: q.node_id, userId: auth.user_id, decisionType: q.decision_type, stance };

    // 后答生效（轮值）：旧答复标 superseded，旧 answers 边作废，通知负责人与前任（审计里）。
    if (supersede) {
      const prev = answersOf(db, q.id).filter((a) => a.id !== aid && COUNTED.includes(a.stance));
      for (const a of prev) db.run(`UPDATE answers SET stance='superseded', updated_at=? WHERE id=?`, at, a.id);
      db.run(`UPDATE edges SET superseded_at=?, valid_to=? WHERE to_id=? AND relation='answers' AND superseded_at IS NULL`, at, at, q.id);
      insertEdge(db, mid, q.id, 'answers', at);
      db.run(`UPDATE questions SET resolved_at=? WHERE id=?`, at, q.id);
      audit(db, { actorKind: 'user', actorId: auth.user_id, action: 'answer_superseded', targetType: 'question', targetId: q.id,
        payload: { messageId: mid, previous: prev.map((a) => ({ answerId: a.id, userId: a.user_id, body: a.body.slice(0, 300) })), notify: [lead, ...prev.map((a) => a.user_id)].filter(Boolean) } });
      return { ...base, resolved: true, superseded: prev.length, finalBody: body, stillOpen: openCount(db, q.task_id) };
    }

    // 负责人：立即生效，覆盖介入者；不同意见留档为 dissent。
    // 负责人附议某一条 = 以那条为准，不是新立场。
    // 例外：方案批准配了会签（某一段 all 且不止一人）—— 那是负责人自己要求几个人都签，
    // 负责人的这一下只是其中一个签字，按会签结算。要越过会签，把别人的签字位「转交」给自己。
    // 另两个例外：别人提的需求的签收（负责人签了替不了提出人）、负责人自己提的计划变更
    // （自己批自己不算）—— 负责人这一下也只是一票，交给 settleBlock 按那两条规则结算。
    if (isLead && !isCosign(db, q, route) && !leadIsOneVote(db, q, auth.user_id)) {
      const win = target ?? { message_id: mid, body, user_id: auth.user_id };
      const others = writtenOf(db, q.id).filter((a) => a.id !== aid && a.user_id !== auth.user_id && a.id !== target?.id);
      // 这里留着一次文字比对，**只决定标签不决定结论**：负责人写了与某条一字不差的答复时，
      // 没有人被否决，把它标成 dissent 会在摘要与通知里冤枉人。要表示同意已有答复，正路是附议。
      const overridden = target ? others : others.filter((a) => norm(a.body) !== norm(body));
      for (const a of overridden) db.run(`UPDATE answers SET stance='dissent', updated_at=? WHERE id=?`, at, a.id);
      if (overridden.length) {
        audit(db, { actorKind: 'user', actorId: auth.user_id, action: 'answer_overridden', targetType: 'question', targetId: q.id,
          payload: { leadMessageId: mid, leadBody: body.slice(0, 300), dissent: overridden.map((a) => ({ answerId: a.id, userId: a.user_id, body: a.body.slice(0, 300) })), notify: overridden.map((a) => a.user_id) } });
      }
      return resolve(db, { q, messageId: win.message_id, finalBody: win.body, by: win.user_id, at, base,
        how: target ? 'lead_agreed' : overridden.length ? 'lead_override' : 'lead' });
    }

    // 轮值：任一收件人答即生效。
    if (policy === 'latest') {
      const win = target ?? { message_id: mid, body, user_id: auth.user_id };
      return resolve(db, { q, messageId: win.message_id, finalBody: win.body, by: win.user_id, at, base, how: 'latest' });
    }

    return settleBlock(db, { q, at, base, answerId: aid });
  });
}

/**
 * 签收答复归一：选项字母（A / (A) / B：理由）换成正文；打回必须带理由；C（先查看经过）不是结论；
 * 认不出方向的自由文字**拒收**，不再默认当打回。归一之后的正文只有两种形状：「接受…」「打回：<理由>」。
 */
export function signoffAnswer(raw) {
  const s = String(raw ?? '').trim();
  const NEED = '签收只收两种答复：「接受」，或「打回：<理由>」（理由会作为修正指令，任务据此重新规划）';
  const opt = /^[（(]?\s*([ABCabc])\s*[)）]?(?=$|[\s：:，,。.、])[\s：:，,。.、]*([\s\S]*)$/.exec(s);
  if (opt) {
    const k = opt[1].toUpperCase(), rest = opt[2].trim();
    if (k === 'A') return rest ? `接受，${rest}` : '接受';
    if (k === 'B') { if (!rest) throw new Error('打回必须写理由：回「B：<理由>」或「打回：<理由>」'); return `打回：${rest}`; }
    throw new Error(`(C) 是"先查看经过"，不是结论。看完再答：${NEED}`);
  }
  if (/^(接受|accept)/i.test(s)) return s;
  const rj = /^(打回|reject(?:ed)?)[\s：:，,。]*([\s\S]*)$/i.exec(s);
  if (rj) { if (!rj[2].trim()) throw new Error('打回必须写理由：回「打回：<理由>」'); return `打回：${rj[2].trim()}`; }
  throw new Error(NEED);
}

/** 签收的答案空间是封闭的：接受 / 打回。口径与 RESOLUTION_HOOKS.signoff 一致（入口已经 signoffAnswer 归一过）。 */
const signoffSide = (b) => (/^(接受|accept)/i.test(String(b ?? '').trim()) ? 'accept' : 'reject');

/**
 * 够数之后，几个不同的立场。
 *
 * **这里对"系统退出判一致"做了一处偏离，要说清楚**：如果把
 * "有两条自己写的答复"一律当成两个立场，quorum > 1 的签收（例如签收人是产品 + 测试，quorum=all）
 * 两人都写"接受"就会当场生成一条冲突事项 —— 把一个旧毛病换成一个更响的新毛病。
 * 所以保留的是**充分条件**方向的比对，它不会误报：
 *   - 文字一字不差（空白大小写归一后）→ 同一个立场。这是充分条件，不是必要条件。
 *   - 签收另按**方向**归并：接受 / 打回。"接受"与"接受，辛苦了"是同一个意思，
 *     答案空间封闭时这个归并也不会误报。多条打回的理由合并带给修正流水线，不丢话。
 * 真正要解决的"同义不同字被判成冲突"（"按 A 处理，判据换成…" vs "听后端的，按 A"）
 * 由**附议**这个动作承担 —— 系统不猜，人明说。
 */
function positionsOf(q, written, db = null) {
  const key = q.decision_type === 'signoff' ? (a) => signoffSide(a.body)
    : String(q.text ?? '').startsWith(CHOICES_MARK) ? (a) => choicesSide(a.body)
    : db && q.decision_type === 'contract_approval' && isRevisionQuestion(db, q.id) ? (a) => revisionSide(a.body)
    : (a) => norm(a.body);
  const m = new Map();
  for (const a of written) {
    const k = key(a);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(a);
  }
  return [...m.values()];
}
/** 同一立场里多条答复时的最终正文：签收打回把各人的理由合起来，别丢话；其余取第一条。 */
function finalBodyOf(q, side) {
  if (q.decision_type !== 'signoff' || side.length < 2 || signoffSide(side[0].body) !== 'reject') return side[0].body;
  const reasons = [...new Set(side.map((a) => String(a.body).replace(/^打回[：:]\s*/, '').trim()))];
  return `打回：${reasons.join('；')}`;
}

/** 这条是配了会签的方案批准吗：方案批准类、状态机认得、路由里某一段不止一人且要多于一人表态。 */
const isCosign = (db, q, route) => ['contract_approval', 'signoff'].includes(q.decision_type)
  // 法定人数 all，或写成大于 1 的数字（例：配的是"3"，否则负责人一答就定案，另外两人的票用不上）
  && (route?.rows ?? []).some((r) => (r.recipients ?? []).length > 1 && (r.quorum === 'all' || Number(r.quorum) > 1))
  // 签收（例：配的是"负责人 + 提需求的人，都要签"，否则负责人一答就定案，提需求的人的那一票用不上）、
  // 计划变更（否则负责人在变更卡片上一点就生效，其他人的批准是摆设）也按会签结算
  && (q.decision_type === 'signoff' || !!approvalThreadOf(db, q.id) || isRevisionQuestion(db, q.id));
const isRevisionQuestion = (db, qid) => !!db.one(`SELECT 1 FROM revisions WHERE question_id=?`, qid);
const revisionProposerOf = (db, qid) => db.one(`SELECT m.sender_id FROM revisions r JOIN messages m ON m.id=r.message_id WHERE r.question_id=?`, qid)?.sender_id ?? null;
/**
 * 给界面用：这条事项上 settleBlock 的两条额外规则落在谁身上 ——
 * mustSign：必须有此人那一票（别人提的需求的签收）；selfExcluded：此人那一票不计（自己提的计划变更、名单里还有别人）。
 */
export function voteRulesOf(db, q) {
  const addressed = Array.isArray(q.addressed_to) ? q.addressed_to : JSON.parse(q.addressed_to || '[]');
  let mustSign = null, selfExcluded = null;
  if (q.decision_type === 'signoff') { const [req] = requesterOf(db, q.task_id); if (req && addressed.includes(req)) mustSign = req; }
  if (q.decision_type === 'contract_approval' && isRevisionQuestion(db, q.id)) {
    const p = revisionProposerOf(db, q.id);
    if (p && addressed.some((u) => u !== p)) selfExcluded = p;
  }
  return { mustSign, selfExcluded };
}
/** 负责人的答复只算一票（不当场定案）的两种情形；规则本身在 settleBlock 里。 */
const leadIsOneVote = (db, q, lead) => {
  const { mustSign, selfExcluded } = voteRulesOf(db, db.one(`SELECT * FROM questions WHERE id=?`, q.id));
  return (!!mustSign && mustSign !== lead) || selfExcluded === lead;
};
/** 计划变更事项的答案空间：批准（可带保留意见）/ 驳回。与 revision.mjs 的应用钩子同一口径。 */
export const revisionSide = (b) => (readVerdict(b) === 'approve' ? 'approve' : 'reject');

/**
 * 方案会签的归并。只管三台状态机判读的那类批准事项（approvalThreadOf 认得的）；计划变更那种走按钮，不在此列。
 * 返回 { messageId, finalBody, by } 或 null（真分歧 / 不归这里管 → 照旧）。
 * 合成的那条答复署最后一个答复人的名、沿用其令牌（它是"这几条认证答复的合并"，出处边指回每一条原答复）——
 * 状态机只读"答复这条事项的那条消息"，不合成的话，除了赢家之外每个人说的话都会丢。
 */
function cosign(db, { q, written, at }) {
  const th = approvalThreadOf(db, q.id);
  if (!th) return null;
  const names = Object.fromEntries(db.all(`SELECT id, display_name FROM users`).map((u) => [u.id, u.display_name]));
  const who = (a) => names[a.user_id] ?? a.user_id;
  const sides = written.map((a) => ({ a, v: readVerdict(a.body, th.labels) }));
  const has = (v) => sides.some((s) => s.v === v);
  if (has('abandon') && sides.some((s) => s.v !== 'abandon')) return null;   // 有人要放弃、有人不：真分歧，走冲突
  if (has('reached') && sides.some((s) => s.v !== 'reached')) return null;   // 有人说"已经达成、这些都不要"、有人不：同上
  let body;
  if (sides.every((s) => s.v === 'approve')) {
    const resv = sides.map((s) => { const r = reservationOf(s.a.body); return r ? `${who(s.a)}：${r}` : null; }).filter(Boolean);
    body = resv.length ? `A\n保留：${resv.join('；')}` : 'A';
  } else if (sides.every((s) => s.v === 'abandon')) {
    body = 'C';
  } else if (sides.every((s) => s.v === 'reached')) {
    body = 'E';
  } else {
    // 有人要改：批准的那几位这一版等于白批 —— 下一版会再送他们看（会签批的是同一版）
    body = `会签：${sides.filter((s) => s.v === 'feedback').map((s) => `${who(s.a)}要改`).join('、')}${has('approve') ? `（${sides.filter((s) => s.v === 'approve').map((s) => who(s.a)).join('、')}批准了这一版）` : ''}\n`
      + sides.filter((s) => s.v === 'feedback').map((s) => `${who(s.a)}：${String(s.a.body).trim()}`).join('\n');
  }
  const last = written.at(-1);
  const src = db.one(`SELECT token_id FROM messages WHERE id=?`, last.message_id);
  const mid = newId('m');
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
          VALUES (?,?,?,?,'answer','explicit','normal','explicit','user-authenticated',?,?)`, mid, q.task_id, last.user_id, body, src?.token_id ?? null, at);
  for (const a of written) insertEdge(db, mid, a.message_id, 'derived_from', at);
  audit(db, { actorKind: 'system', action: 'cosign_merged', targetType: 'question', targetId: q.id,
    payload: { messageId: mid, sides: sides.map((s) => ({ userId: s.a.user_id, verdict: s.v })), human: `会签：${sides.map((s) => `${who(s.a)}${{ approve: '批准', feedback: '要改', abandon: '放弃', reached: '已经达成' }[s.v]}`).join('，')}` } });
  return { messageId: mid, finalBody: body, by: last.user_id };
}

/**
 * block 策略下的结算：数人头 → 够数就看**有几个不同的立场**。
 * 从 recordAnswer 与 recordAbstain 两处调用 —— 弃权会让法定人数按剩余人数重算，
 * 重算之后很可能当场就够数了（quorum 2、一人已答、另一人弃权）。
 * 忘了在弃权路径上结算，事项就会停在"等一个永远不会来的人"上，守护模式下无人接手、无报错、无待办。
 */
function settleBlock(db, { q, at, base, answerId = null }) {
  const fresh = db.one(`SELECT * FROM questions WHERE id=?`, q.id);
  const route = fresh.route ? JSON.parse(fresh.route) : null;
  const addressed = JSON.parse(fresh.addressed_to || '[]');
  // 没有路由信息的旧事项按 quorum 1。
  const rows = route?.rows?.length ? route.rows : [{ recipients: addressed, quorum: '1' }];
  const all = answersOf(db, q.id);
  let counted = all.filter((a) => COUNTED.includes(a.stance));
  // 计划变更（宪法层）的提出人不能独自批准自己的改动：名单里还有别人时，提出人那一票不计入人数（仍可答、仍留痕）。
  // 否则：成员发的修正要改完成定义，审批法定人数 1、提出人本人在名单里 → 一个人就能批了自己的宪法改动。
  const { mustSign, selfExcluded } = voteRulesOf(db, fresh);
  if (selfExcluded) counted = counted.filter((a) => a.user_id !== selfExcluded);
  const pending = [];
  for (const row of rows) {
    // 提出人的席位也一起去掉，不只是票：否则"都要签（all）"会永远差他那一个。
    const r = selfExcluded && row.recipients.includes(selfExcluded) ? { ...row, recipients: row.recipients.filter((u) => u !== selfExcluded) } : row;
    if (!r.recipients.length && row.recipients.length) continue;   // 这一段只有提出人自己 → 这一段不设门槛，由别的段把关
    const need = r.quorum === 'all' ? r.recipients.length : Math.min(Number(r.quorum), r.recipients.length || Number(r.quorum));
    const have = new Set(counted.filter((a) => r.recipients.includes(a.user_id) || !r.recipients.length).map((a) => a.user_id)).size;
    if (have < need) pending.push({ scope: r.scope ?? '*', need, have });
  }
  // 兜底：各段都只剩提出人时上面全跳过了 —— 至少要有一个别人批。
  if (selfExcluded && !pending.length && !counted.length) pending.push({ scope: '提出人以外', need: 1, have: 0 });
  // 谁提的需求谁签收：提出人在签收人里时，必须有提出人那一票 —— 负责人可以一起签，但替不了。
  // 否则：签收配成"负责人 + 提需求的人"、法定人数 1，负责人先签，就把别人提的需求替提出人签掉了。
  // 提出人自己点了"不归我"（弃权）就不在收件人里了，这条不再拦。
  if (mustSign && !counted.some((a) => a.user_id === mustSign)) pending.push({ scope: '需求提出人', need: 1, have: 0, requester: mustSign });
  if (pending.length) {
    audit(db, { actorKind: 'system', action: 'answer_pending_quorum', targetType: 'question', targetId: q.id, payload: { pending, answerId } });
    return { ...base, resolved: false, pending, stillOpen: openCount(db, q.task_id) };
  }
  // 够数。冲突事项里"撤回"是放弃自己的立场（历史上是一句文字，现在也可以用弃权动作，见 recordAbstain）。
  const written = all.filter((a) => a.stance === 'answer'
    && !(q.decision_type === 'conflict' && (isWithdraw(a.body) || all.some((x) => x.user_id === a.user_id && x.stance === 'withdrawn'))));
  // 方案会签：几个人批同一份方案，按判读的方向归并 —— 都批准 = 批准（各人的保留意见合在一起），
  // 有人要改 = 出下一版（各人要改的话合在一起）；只有"有人放弃、有人不放弃"才是真分歧，走冲突。
  // 原来按文字归并：一个回"A"、一个回"A 保留：…"就成了冲突事项 —— 会签没法用。
  if (q.decision_type === 'contract_approval' && written.length > 1) {
    const co = cosign(db, { q, written, at });
    if (co) return resolve(db, { q, messageId: co.messageId, finalBody: co.finalBody, by: co.by, at, base, how: 'cosign' });
  }
  const groups = positionsOf(q, written, db);
  if (groups.length === 1) {
    const side = groups[0];
    const win = side[0];
    return resolve(db, { q, messageId: win.message_id, finalBody: finalBodyOf(q, side), by: win.user_id, at, base,
      how: q.decision_type === 'conflict' ? 'parties_agreed' : 'quorum' });
  }
  if (q.decision_type === 'conflict') {
    // 双方再度不一致（或都撤回了，没有立场可采）：不套娃，直接转下一行（负责人）。
    for (const a of all.filter((x) => x.stance === 'answer')) db.run(`UPDATE answers SET stance='dissent', updated_at=? WHERE id=?`, at, a.id);
    const adv = advanceRoute(db, { questionId: q.id, at });
    audit(db, { actorKind: 'system', action: 'conflict_escalated', targetType: 'question', targetId: q.id,
      payload: { why: written.length ? '双方阶段仍不一致' : '双方都撤回了立场，没有可采的答复', to: adv?.answerers ?? null,
        stances: all.map((a) => ({ userId: a.user_id, stance: a.stance, body: a.body.slice(0, 300) })) } });
    return { ...base, resolved: false, escalated: true, to: adv?.answerers ?? [], stillOpen: openCount(db, q.task_id) };
  }
  const conflictId = raiseConflict(db, { q, answers: written, at });
  return { ...base, resolved: false, conflictId, stillOpen: openCount(db, q.task_id) };
}

/**
 * 弃权："这不归我"。从收件人里去掉自己，法定人数按剩余人数重算。
 *
 * 没人了的链整条丢掉（曾出现过的形状：范围解析把否定句读成肯定枚举，把 `shared/` 的问题错发给了前端 ——
 * 前端说"不是 client/ 的地盘，我不表态"，而那时除了转交没有别的出口，提交它反而会被当成一条答复）。
 * 一条链都不剩 → 转下一行；没有下一行就挂给负责人；负责人自己也弃权了 → 挂着不动，进摘要等人处理。
 * 冲突事项里"这不归我"其实是**撤回自己的立场**，记 withdrawn，随即重新结算。
 */
function recordAbstain(db, { q, auth, body, at, lead, addressed }) {
  if (!addressed.includes(auth.user_id)) throw new Error('你不在这条事项的接收人里，无需弃权');
  const isConflict = q.decision_type === 'conflict';
  const mid = newId('m'), aid = newId('a');
  const note = String(body ?? '').trim();
  const text = isConflict ? `撤回：不再坚持自己的立场${note ? `（${note}）` : ''}` : `弃权：这条不归我${note ? `（${note}）` : ''}`;
  return db.tx(() => {
    db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
            VALUES (?,?,?,?,'answer','explicit','normal','explicit','user-authenticated',?,?)`, mid, q.task_id, auth.user_id, text, auth.token_id, at);
    db.run(`INSERT INTO answers (id,question_id,user_id,message_id,body,stance,created_at) VALUES (?,?,?,?,?,?,?)`,
      aid, q.id, auth.user_id, mid, text, isConflict ? 'withdrawn' : 'abstain', at);
    const base = { messageId: mid, answerId: aid, questionId: q.id, nodeId: q.node_id, userId: auth.user_id, decisionType: q.decision_type, stance: 'abstain' };

    if (isConflict) {
      // 立场撤回：自己此前写的答复作废，再结算（对方一条还在 → 当场达成）。
      for (const a of writtenOf(db, q.id).filter((x) => x.user_id === auth.user_id)) {
        db.run(`UPDATE answers SET stance='withdrawn', updated_at=? WHERE id=?`, at, a.id);
      }
      audit(db, { actorKind: 'user', actorId: auth.user_id, action: 'answer_withdrawn', targetType: 'question', targetId: q.id, payload: { answerId: aid, note } });
      return settleBlock(db, { q, at, base, answerId: aid });
    }

    const left = addressed.filter((u) => u !== auth.user_id);
    const route = q.route ? JSON.parse(q.route) : null;
    let dropped = [];
    if (route?.rows) {
      for (const r of route.rows) r.recipients = (r.recipients ?? []).filter((u) => u !== auth.user_id);
      dropped = route.rows.filter((r) => !r.recipients.length).map((r) => r.scope ?? '*');
      route.rows = route.rows.filter((r) => r.recipients.length);
      route.abstained = [...(route.abstained ?? []), auth.user_id];
    }
    db.run(`UPDATE questions SET addressed_to=?, route=? WHERE id=?`, JSON.stringify(left), route ? JSON.stringify(route) : q.route, q.id);
    audit(db, { actorKind: 'user', actorId: auth.user_id, action: 'answer_abstained', targetType: 'question', targetId: q.id,
      payload: { note, left, droppedChains: dropped, notify: [lead].filter((u) => u && u !== auth.user_id) } });

    // 一个收件人都不剩：转下一行 → 挂给负责人 → 都不行就挂着（进摘要）。
    if (!left.length || (route && !route.rows.length)) {
      const adv = advanceRoute(db, { questionId: q.id, at });
      if (adv?.answerers?.length) {
        audit(db, { actorKind: 'system', action: 'question_rerouted', targetType: 'question', targetId: q.id,
          payload: { why: '收件人全部弃权', to: adv.answerers } });
        return { ...base, resolved: false, reassigned: adv.answerers, stillOpen: openCount(db, q.task_id) };
      }
      if (lead && lead !== auth.user_id) {
        const row = { rule_id: null, scope: '*', recipients: [lead], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null, last: true, from_abstention: true };
        db.run(`UPDATE questions SET addressed_to=?, route=? WHERE id=?`, JSON.stringify([lead]),
          JSON.stringify({ ...(route ?? { stage: 0, chains: [] }), rows: [row] }), q.id);
        audit(db, { actorKind: 'system', action: 'question_rerouted', targetType: 'question', targetId: q.id,
          payload: { why: '收件人全部弃权，且路由没有下一顺位', to: [lead] } });
        return { ...base, resolved: false, reassigned: [lead], stillOpen: openCount(db, q.task_id) };
      }
      audit(db, { actorKind: 'system', action: 'question_unassigned', targetType: 'question', targetId: q.id,
        payload: { why: '收件人全部弃权，且没有下一顺位、负责人也弃权了' } });
      return { ...base, resolved: false, unassigned: true, stillOpen: openCount(db, q.task_id) };
    }
    return settleBlock(db, { q, at, base, answerId: aid });
  });
}

const openCount = (db, taskId) => db.one(`SELECT count(*) AS n FROM questions WHERE task_id=? AND status IN ('open','escalated')`, taskId).n;

/** 已决事项上迟到的答复（"先答生效，迟到的异议留痕"）：与结论不同 → dissent；相同 → 附议（comment）。不挂 answers 边、不动状态。 */
function recordLateAnswer(db, { q, auth, body, stance: action = 'answer', at, lead }) {
  const effective = db.one(`SELECT m.body, m.sender_id FROM messages m JOIN edges e ON e.from_id=m.id AND e.to_id=? AND e.relation='answers' AND e.superseded_at IS NULL ORDER BY e.id DESC LIMIT 1`, q.id);
  if (action === 'agree') body = `附议已生效的结论`;
  // 附议迟到的必然是附议；写了字的仍按老规矩：与结论一字不差算附议，否则是异议（只影响标签）。
  const differs = action !== 'agree' && (!effective || norm(effective.body) !== norm(body));
  const stance = differs ? 'dissent' : 'comment';
  const mid = newId('m'), aid = newId('a');
  return db.tx(() => {
    db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
            VALUES (?,?,?,?,'answer','explicit','normal','explicit','user-authenticated',?,?)`, mid, q.task_id, auth.user_id, body, auth.token_id, at);
    db.run(`INSERT INTO answers (id,question_id,user_id,message_id,body,stance,created_at) VALUES (?,?,?,?,?,?,?)`, aid, q.id, auth.user_id, mid, body, stance, at);
    const notify = [...new Set([lead, effective?.sender_id].filter((u) => u && u !== auth.user_id))];
    audit(db, { actorKind: 'user', actorId: auth.user_id, action: differs ? 'late_dissent_noted' : 'late_agreement_noted', targetType: 'question', targetId: q.id,
      payload: { answerId: aid, messageId: mid, decisionType: q.decision_type, effective: effective?.body?.slice(0, 300) ?? null, body: body.slice(0, 300), notify } });
    const note = differs ? '该事项已有结论。你的不同意见已记录，并已通知负责人与答复人；如需更改结论，请由负责人走修正流程' : '该事项已有结论，且与你的答复一致，已记为附议';
    return { messageId: mid, answerId: aid, questionId: q.id, nodeId: q.node_id, userId: auth.user_id, decisionType: q.decision_type,
      resolved: false, late: true, stance, finalBody: effective?.body ?? null, note, stillOpen: openCount(db, q.task_id) };
  });
}

/**
 * 冲突事项正文里的影响段：只写库里机械可算的（哪一步卡住、下游哪些步骤等它、任务是否因此挂起、签收未定则不能交付），
 * 不写判断。"采纳 A / B 各意味着什么"的模型版暂不做（有真实冲突样本再定）。
 */
function conflictImpact(db, q) {
  const lines = [];
  const task = db.one(`SELECT id, status FROM tasks WHERE id=?`, q.task_id);
  if (q.node_id) {
    const n = db.one(`SELECT id, title, risk_tier, status FROM nodes WHERE id=?`, q.node_id);
    const seen = new Set([q.node_id]); const queue = [q.node_id]; const down = [];
    while (queue.length) {
      const cur = queue.shift();
      for (const r of db.all(`SELECT n.id, n.title, n.risk_tier, n.status FROM edges e JOIN nodes n ON n.id=e.from_id WHERE e.to_id=? AND e.relation='depends_on' AND e.superseded_at IS NULL ORDER BY n.created_at`, cur)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id); down.push(r); queue.push(r.id);
      }
    }
    const tier = (t) => (t ? `风险 ${t}` : '');
    if (n) lines.push(`- 卡住的步骤：「${n.title}」（${[n.status, tier(n.risk_tier)].filter(Boolean).join('，')}）—— 有结论前不会继续`);
    lines.push(down.length
      ? `- 等它的下游步骤 ${down.length} 个：${down.map((d) => `「${d.title}」${d.risk_tier ? `（${tier(d.risk_tier)}）` : ''}`).join('、')} —— 都不会开始`
      : '- 没有下游步骤等它');
  } else {
    lines.push('- 这条事项不挂在某个步骤上：整个任务等结论');
  }
  // 调用时任务还没被置 waiting（raiseConflict 在正文之后才改状态），这里写的是冲突生效后的状态。
  if (task) lines.push(task.status === 'done' ? `- 任务已完成（${task.id}），冲突只影响完成后的事项`
    : ['running', 'waiting'].includes(task.status) ? `- 任务 ${task.id} 挂起等结论` : `- 任务 ${task.id} 处于 ${task.status}`);
  if (q.decision_type === 'signoff') lines.push('- 签收未定：任务不能交付');
  return lines.join('\n');
}

/** 事项已决：挂 answers 边、置 answered、解冻分支与任务、跑类型钩子；冲突事项还要回写原事项。 */
function resolve(db, { q, messageId, finalBody, by, at, base, how }) {
  insertEdge(db, messageId, q.id, 'answers', at);
  db.run(`UPDATE questions SET status='answered', resolved_at=?, route_due_at=NULL WHERE id=?`, at, q.id);
  // 分支解冻。**不置 ready 只置 pending**：就绪与否由 readyNodes 按依赖现算。
  if (q.node_id) db.run(`UPDATE nodes SET status='pending' WHERE id=? AND status='blocked'`, q.node_id);
  let origin = null;
  if (q.decision_type === 'conflict' && q.origin_question_id) {
    origin = db.one(`SELECT * FROM questions WHERE id=?`, q.origin_question_id);
    if (origin && ['open', 'escalated'].includes(origin.status)) {
      // 谁赢了看**作者**，不看文字：冲突阶段的重申多半是换了说法的同一立场，按文字找赢家找不着。
      // 主动撤回的一方标 withdrawn（是他自己让的），被负责人否掉的才标 dissent（异议记录）。
      const gaveUp = new Set(answersOf(db, q.id).filter((a) => ['withdrawn', 'abstain', 'agree'].includes(a.stance)
        || (a.stance === 'dissent' && isWithdraw(a.body))).map((a) => a.user_id));
      const losers = writtenOf(db, origin.id).filter((a) => a.user_id !== by);
      for (const a of losers) db.run(`UPDATE answers SET stance=?, updated_at=? WHERE id=?`, gaveUp.has(a.user_id) ? 'withdrawn' : 'dissent', at, a.id);
      const winner = writtenOf(db, origin.id).find((a) => a.user_id === by);
      if (!winner) db.run(`INSERT INTO answers (id,question_id,user_id,message_id,body,stance,created_at) VALUES (?,?,?,?,?,'answer',?)`, newId('a'), origin.id, by, messageId, finalBody, at);
      insertEdge(db, winner?.message_id ?? messageId, origin.id, 'answers', at);
      db.run(`UPDATE questions SET status='answered', resolved_at=?, route_due_at=NULL WHERE id=?`, at, origin.id);
      if (origin.node_id) db.run(`UPDATE nodes SET status='pending' WHERE id=? AND status='blocked'`, origin.node_id);
      audit(db, { actorKind: 'system', action: 'conflict_resolved', targetType: 'question', targetId: origin.id,
        payload: { conflictId: q.id, how, by, finalBody: finalBody.slice(0, 300), dissent: losers.map((a) => ({ userId: a.user_id, body: a.body.slice(0, 300) })) } });
    }
  }
  // 任务解冻的条件是**没有别的问题还开着**，不是"这个问题答了"。
  const stillOpen = openCount(db, q.task_id);
  if (!stillOpen) db.run(`UPDATE tasks SET status='running' WHERE id=? AND status='waiting'`, q.task_id);
  audit(db, { actorKind: 'user', actorId: by, action: 'question_answered', targetType: 'question', targetId: q.id,
    payload: { messageId, nodeId: q.node_id, level: q.level, decisionType: q.decision_type, how, stillOpen, body: String(finalBody).slice(0, 800), pid: process.pid } });
  const target = origin ?? q;
  for (const pre of PRE_HOOKS) {
    const out = pre(db, { question: target, finalBody, by, messageId, at });
    if (out != null) return { ...base, questionId: q.id, resolved: true, finalBody, how, stillOpen, originId: origin?.id ?? null, hook: out };
  }
  // 决定登记：有结论的规格取舍 / 结构矛盾进项目的约定清单。冲突事项本身不记 —— 结论已经回写到
  // 原事项上，记 target 就够了。登记失败不许连累答复：人已经答了，这一步是记账。
  try { recordFromQuestion(db, { question: target, finalBody, by, at }); }
  catch (e) { audit(db, { actorKind: 'system', action: 'decision_register_failed', targetType: 'question', targetId: target.id, payload: { error: e.message } }); }
  const hook = RESOLUTION_HOOKS[target.decision_type];
  const hookOut = hook ? hook(db, { question: target, finalBody, by, messageId, at }) : null;
  return { ...base, questionId: q.id, resolved: true, finalBody, how, stillOpen, originId: origin?.id ?? null, hook: hookOut };
}

/** 同级不一致 → 冲突事项（第八种决策类型）。正文 = 原问题 + 各方答复等深并列（对称影响简报的模板版）。 */
function raiseConflict(db, { q, answers, at }) {
  const id = newId('q');
  const parties = [...new Set(answers.map((a) => a.user_id))];
  const names = Object.fromEntries(db.all(`SELECT id, display_name FROM users`).map((u) => [u.id, u.display_name]));
  const backers = answersOf(db, q.id).filter((a) => a.stance === 'agree');
  const sides = answers.map((a, i) => {
    const mine = backers.filter((b) => b.agrees_with === a.id).map((b) => names[b.user_id] ?? b.user_id);
    return `（${String.fromCharCode(65 + i)}）${names[a.user_id] ?? a.user_id}：${a.body.trim()}${mine.length ? `\n　　（${mine.join('、')} 附议这一条）` : ''}`;
  }).join('\n');
  const text = `【冲突】同一事项收到不一致的答复，各方答复均未生效。\n\n原事项（${q.id}）：\n${String(q.text).trim().split('\n').map((l) => `> ${l}`).join('\n')}\n\n各方答复：\n${sides}\n\n`
    + `在有结论之前：\n${conflictImpact(db, q)}\n以上为各方答复原文，系统不作裁决。\n\n`
    + `请冲突双方在此表态，三选一：\n`
    + `- **附议**对方那一条（点这条事项下的「附议」）—— 以对方为准，当场达成结论；\n`
    + `- **撤回**自己的立场（点「撤回」）—— 效果和附议一样（以对方为准），挑一个点就行；\n`
    + `- **重申**自己的立场（写下答复）—— 双方都重申即仍不一致，转负责人裁定。\n`
    + `超时未达成一致也会转负责人裁定。`;
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status,origin_question_id)
          VALUES (?,?,?,3,'hard_rule',?,NULL,?,NULL,'open',?)`, id, q.task_id, q.node_id, text, at, q.id);
  insertEdge(db, id, q.id, 'derived_from', at);
  const r = routeQuestion(db, { questionId: id, decisionType: 'conflict', typeSource: 'hard_rule', parties, at });
  db.run(`UPDATE questions SET route=json_set(route,'$.parties',json(?)) WHERE id=?`, JSON.stringify(parties), id);
  // 原事项进冲突处理：级别超时钟停掉（否则 Ⅱ 级会在冲突未决时按默认走），结论由冲突事项回写。
  db.run(`UPDATE questions SET status='escalated', timeout_at=NULL, route_due_at=NULL WHERE id=?`, q.id);
  db.run(`UPDATE tasks SET status='waiting' WHERE id=? AND status IN ('running','waiting')`, q.task_id);
  audit(db, { actorKind: 'system', action: 'conflict_raised', targetType: 'question', targetId: q.id,
    payload: { conflictId: id, parties, addressedTo: r.answerers, dueAt: r.dueAt, stances: answers.map((a) => ({ userId: a.user_id, body: a.body.slice(0, 300) })) } });
  return id;
}

/**
 * 旁观者 / 任何人对已决事项的留言：附在事项上（answers.stance='comment'），不进决策。
 * 挂在已决事项上的留言：审计 dissent_noted，进负责人摘要。
 */
export function commentOnQuestion(db, { questionId, messageId, userId, body, at = now() }) {
  const q = db.one(`SELECT id, status, task_id FROM questions WHERE id=?`, questionId);
  if (!q) throw new Error(`事项不存在：${questionId}`);
  const id = newId('a');
  db.run(`INSERT INTO answers (id,question_id,user_id,message_id,body,stance,created_at) VALUES (?,?,?,?,?,'comment',?)`, id, questionId, userId, messageId, body, at);
  const decided = !['open', 'escalated'].includes(q.status);
  audit(db, { actorKind: 'user', actorId: userId, action: decided ? 'dissent_noted' : 'comment_noted', targetType: 'question', targetId: questionId,
    payload: { answerId: id, messageId, decided, body: body.slice(0, 300) } });
  return { id, decided };
}
