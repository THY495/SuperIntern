// 方案批准的答复：判读、回显、防循环。
//
// 三台状态机（追问器草案、项目规划、追加 / 复盘）都拿人对 contract_approval 事项的一句话判"批准 / 放弃 / 要改"。
// 判读一直是纯正则、不经模型 —— 这一条不变。缺的是另一半：**人看不到系统怎么读自己的话**。
// 例如有人连着两次写「A 保留：…」，两次都被读成"要改"，规划器又出一版、又来问他；页面上那两条都只标着"已决定"。
//
// 这里补三件事：
//   ① 回显：答之前页面上实时显示"系统会理解为…"，答之后提示与事项历史里显示"系统理解为…"（同一个函数出字）；
//   ② 判读留痕：状态机每读一次答复写一条 approval_read 审计 —— 历史标注以它为准，不以事项状态（answered = "已决定"）为准；
//   ③ 防循环：同一条线上**连着两次**以「A」开头、却被读成"要改"，第二次不再出新版，先挂一条"先确认一下"的事项。
//      只花一条事项、不花模型钱；而多出一版要一次重档调用、六分钟、外加一条事项。
//
// 为什么是"连着两次"而不是第一次就停：第一次时页面已经实时显示过"系统会理解为：要改"了，人照样提交，多半就是要改。
// 第二次还这样，就更像是人没看见那行字 —— 这时停下来问一句最便宜。

import { hasMark, markOf } from '../i18n/marks.mjs';
import { tl, contentLang } from '../i18n/index.mjs';
import { newId, now, audit } from '../db/db.mjs';
import { getParam } from '../core/params.mjs';
import { routeQuestion } from '../core/routing.mjs';

// 中英都认（0.2.0）：答复的语言不看设置 —— 部署是英文、有人顺手写中文，照样读得懂；反之亦然。
const approvalRe = /^\s*[（(]?(A|批准|同意|approve|approved|ok|okay|yes|lgtm|looks good|confirm|confirmed|通过|可以)[)）]?[。！!.\s]*$/i;
const abandonRe = /^\s*[（(]?(C|放弃|取消|abandon|abort|cancel|give up|drop it|not needed)[)）]?[。！!.\s]*$/i;

/** 人对草案的一句话是什么意思：approve / abandon / feedback。纯正则，不经模型。 */
// 带说明的选项（例：负责人回"A。假设都合理，依赖也对……"曾被当成修改意见，白出了一版草案）。
// 只认**选项字母**开头（A / C，可带括号）+ 标点 + 说明；说明里出现转折 / 条件 / 要求改的词就不认，仍按反馈处理 ——
// 拿不准时多问一轮只花一点钱，把"A，但把 X 改成 Y"当成批准则是替人做了决定。"批准 / 可以 / ok"开头的长句不在此列。
const letterWithNote = (letter) => new RegExp(`^\\s*(?:[（(]${letter}[)）]\\s*[。．.，,：:；;、!！]?|${letter}\\s*[。．.，,：:；;、!！\\n])\\s*\\S`, 'i');
// 放弃后面的说明几乎都是在讲"为什么不要"（例：「C：这个不需要了，理由是……」曾被 hedgeRe 判成要改）——
// 只有明说"改成 / 请把……"才不算放弃。
const abandonHedgeRe = /改成|改为|换成|请(把|改)|先(把|改)|\bchange\b|\breplace\b|\bplease (make|use|switch)\b/i;
const hedgeRe = /但|不过|除非|除了|前提|只要|如果|假如|若|先(把|改)|(需要|要|请|得|应该|建议|最好|必须)[^。\n]{0,12}(改|换|调整|加上|去掉|删|补)|改成|改为|换成|\bbut\b|\bexcept\b|\bunless\b|\bif\b|\bchange\b|\bhowever\b|\binstead\b|\bprovided\b|\bas long as\b|\b(should|must|need to|needs to|please)\b[^.\n]{0,24}\b(change|replace|add|remove|rename|use|drop|fix)\b/i;
/**
 * 批准时带的那句**保留意见**。
 *
 * 必须**显式标记**（另起一行写 `保留：…`），不从语气里猜 —— 这与"封闭答案空间"同一条规矩：
 * 认标记不猜语义。猜错的代价是把一句"但把 X 改成 Y"当成批准，那是替人做决定。
 */
export const RESERVATION_RE = /^[ \t　]*(?:保留(?:意见)?|reservations?|caveats?)[ \t　]*[:：]([\s\S]*)$/im;
// 同一行的写法：「A 保留：…」「批准，保留：…」。页面上教的是"先回 A，另起一行写保留"，可人顺手就写在一行里 ——
// 曾有人连着两次这么写，两次都被当成"要改"，规划器又出一版，又来问：一个不会自己停下来的循环。
const INLINE_RESERVATION_RE = /^\s*[（(]?(A|批准|同意|approve|approved|ok|yes)[)）]?[\s，,。.、；;]*(?:保留(?:意见)?|reservations?|caveats?)[ \t　]*[:：]([\s\S]*)$/i;
export function reservationOf(body) {
  const s = String(body ?? '');
  const m = s.match(RESERVATION_RE) ?? s.match(INLINE_RESERVATION_RE);
  const text = m ? m[m.length - 1].trim() : '';
  return text || null;
}
/** 把保留意见那一段摘掉之后剩下的话 —— 判 A / C / 反馈只看这一段。 */
const withoutReservation = (body) => {
  const s = String(body ?? '');
  const inl = s.match(INLINE_RESERVATION_RE);
  if (inl) return inl[1];
  const m = s.match(RESERVATION_RE);
  return (m ? s.slice(0, m.index) : s).trim();
};
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param labels  这一页选项自己的名字：达成确认页写的是「(A) 确认达成 —— 回 "A" 或 "批准"」，
 *                人照选项名回一句「确认达成」，若被当成修改意见，规划器就又出一版一模一样的 —— 白花一次重档调用、
 *                白多一条事项。选项名本身就是封闭答案空间的一部分，只认**整句恰好是它**（可带标点），不做包含匹配。
 */
export function readVerdict(body, labels = {}) {
  const s = withoutReservation(body);
  const exact = (words) => (words ?? []).some((w) => new RegExp(`^\\s*[（(]?${escRe(w)}[)）]?[。！!.\\s]*$`, 'i').test(s));
  if (exact(labels.reached) || (labels.reached && letterWithNote('E').test(s))) return 'reached';
  if (exact(labels.approve)) return 'approve';
  if (exact(labels.abandon)) return 'abandon';
  // 先摘掉保留意见：那一段里几乎一定有"但 / 不过 / 别当硬规则"这类词，
  // 不摘掉的话，一条"A + 保留：…"会被 hedgeRe 判成反馈，人的批准反而不算数。
  if (approvalRe.test(s)) return 'approve';
  if (abandonRe.test(s)) return 'abandon';
  if (letterWithNote('A').test(s) && !hedgeRe.test(s)) return 'approve';
  if (letterWithNote('C').test(s) && !abandonHedgeRe.test(s)) return 'abandon';
  // 光写一句「保留：…」而没写 A —— 那不是批准，按反馈走（宁可多出一版草案，不替人批）。
  return 'feedback';
}

/** 以批准的字眼开头（「A …」「批准，…」「同意…」）—— 被读成"要改"时，这就是人和系统想的不一样的信号。 */
const LEAD_RE = /^\s*[（(]?(A|批准|同意|通过|可以|ok|okay|approved?|yes|lgtm|confirm(?:ed)?)(?![A-Za-z])/i;
export const approvalLead = (body) => String(body ?? '').match(LEAD_RE)?.[1] ?? null;

// 达成确认页的选项名（renderReached）：(A) 确认达成 / (C) 先放着 —— 照选项名回答也要认。
// 英文选项名与 i18n 目录里 renderReached / 复盘提案的英文译文一致（"(A) Confirm it's done" / "(C) Set it aside" / "(E) Already done"）。
export const REACHED_LABELS = { approve: ['确认达成', '确认', '达成', "Confirm it's done", 'Confirm it is done', 'Confirm', 'Done'], abandon: ['先放着', 'Set it aside'] };
// 复盘提出的任务方案多一个出口：人觉得这些任务都不需要、项目其实已经达成 —— 否则只能回"放弃"，
// 而放弃复盘 = 项目停滞，页面上又没有"宣布达成"的入口，负责人只能借「添加任务」绕回去，又被切成一个干活的任务。
export const REVIEW_LABELS = { reached: ['E', '已达成', '已经达成', '项目已达成', 'Already done', 'Already reached'], abandon: ['先放着', 'Set it aside'] };

/**
 * 这条事项的答复由哪台状态机读、用哪套选项名。不是这三台读的（计划变更的批准走按钮、签收、别的类型）→ null。
 * 只认"当前指针"：各状态机把正等人批的那条事项 id 记在自己的参数 / 列上。历史上的旧事项看 approval_read 审计。
 */
export function approvalThreadOf(db, questionId) {
  const q = db.one(`SELECT id, task_id, decision_type, status FROM questions WHERE id=?`, questionId);
  if (!q || q.decision_type !== 'contract_approval' || !q.task_id) return null;
  const taskId = q.task_id;
  if (db.one(`SELECT id FROM projects WHERE draft_question=? AND status='proposed'`, questionId)) return { taskId, kind: 'plan', reached: false, labels: {} };
  if (getParam(db, taskId, 'append.question') === questionId) {
    const reached = !!getParam(db, taskId, 'append.reached');
    const review = getParam(db, taskId, 'append.kind') === 'review';
    return { taskId, kind: review ? 'review' : 'append', reached, labels: reached ? REACHED_LABELS : review ? REVIEW_LABELS : {} };
  }
  if (getParam(db, taskId, 'draft.approval_question') === questionId) return { taskId, kind: 'draft', reached: false, labels: {} };
  return null;
}

const clip = (s, n = 40) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/**
 * 判读结果的人话（页面实时预览、答复后的提示、事项历史共用）。`tense`：'will'（答之前）/ 'did'（答之后）。
 * 返回 { verdict, label, text }：label 是短标签（历史状态用），text 是整段说明。
 * `lang`：判读说明随事项走，按内容语言写（调用方传 contentLang(db)；默认中文）。
 */
export function describeReading({ body, labels = {}, reached = false, tense = 'did', lang = 'zh' }) {
  const L = lang;
  const verdict = readVerdict(body, labels);
  const resv = reservationOf(body);
  const lead = approvalLead(withoutReservation(body));
  const hedge = withoutReservation(body).match(hedgeRe)?.[0] ?? null;
  // 答之前与答之后分两种开头（两处字若几乎一样，读者分不清是预览还是已经提交）
  const head = tense === 'will' ? tl(L, '如果现在点「答复」，系统会理解为') : tl(L, '已提交，系统理解为');
  let label, text;
  if (verdict === 'reached') {
    label = tl(L, '已经达成');
    text = tl(L, '{head}：已经达成（E）。这一版提的任务都不做，项目按已达成处理（填了项目级验收命令的，系统先跑一遍，过了才算）；之后可以交付。', { head });
  } else if (verdict === 'approve') {
    label = reached ? tl(L, '确认达成') : tl(L, '批准');
    text = reached ? tl(L, '{head}：确认达成（A）。填了项目级验收命令的，系统先跑一遍，过了才算达成；之后可以交付。', { head }) : tl(L, '{head}：批准（A）。这一版方案照原样生效。', { head });
    if (resv) text += '\n' + tl(L, '「{resv}」记成保留意见：不挡任何东西，只留在项目的约定清单上。', { resv: clip(resv) });
  } else if (verdict === 'abandon') {
    const shelve = reached || !!labels.reached;   // 达成确认 / 复盘提的任务方案：放弃 = 复盘先放着，项目停滞
    label = shelve ? tl(L, '先放着') : tl(L, '放弃');
    text = shelve ? tl(L, '{head}：先放着（C）。项目不标达成、转为停滞，等人添加任务、宣布达成或中止。{extra}', { head, extra: labels.reached ? tl(L, '只是不要这些任务、项目其实已经达成：回「E」。') : '' }) : tl(L, '{head}：放弃（C）。这一版方案作废，不再出新版。', { head });
  } else {
    label = reached ? tl(L, '还差东西') : tl(L, '要改');
    text = tl(L, '{head}：{what} —— 你写的这段话会原样交给 AI，按它出下一版方案，再来问你（要等 AI 重写一版，通常几分钟，花一次模型调用的钱）。', { head, what: reached ? tl(L, '还差东西（B）') : tl(L, '要改（B）') });
    if (lead) {
      text += hedge
        ? '\n' + tl(L, '你以「{lead}」开头，但后面有「{hedge}」这样要改的话，所以不算批准。', { lead, hedge })
        : '\n' + tl(L, '你以「{lead}」开头，但后面还接着写了话，系统分不清是批准还是要改，按"要改"算。', { lead });
      text += tl(L, '只想批准：只回「A」；批准但想留一句话：先回 A，另起一行写「保留：…」（不挡任何东西）。');
    }
  }
  return { verdict, label, text, reservation: resv, lead };
}

/**
 * 状态机读答复的唯一入口：判读 + 留痕（approval_read）。返回 readVerdict 的结果。
 * 留痕挂在任务上（进任务页的活动流），payload 带 questionId —— 事项历史按它标"系统理解为…"。
 */
export function readApproval(db, { taskId, questionId, body, labels = {}, reached = false, userId = null, version = null }) {
  const r = describeReading({ body, labels, reached, lang: contentLang(db) });
  audit(db, { actorKind: 'system', actorId: 'approval', action: 'approval_read', targetType: 'task', targetId: taskId,
    payload: { questionId, verdict: r.verdict, label: r.label, human: r.label, lead: r.lead, reached, version, by: userId } });
  return r.verdict;
}

/** 事项历史用：这条线上所有判读过的事项 → { verdict, label }。 */
export function readingsOf(db, taskId) {
  const out = {};
  for (const a of db.all(`SELECT payload FROM audit_log WHERE action='approval_read' AND target_id=? ORDER BY id`, taskId)) {
    try { const p = JSON.parse(a.payload); out[p.questionId] = { verdict: p.verdict, label: p.label }; } catch { /* 坏行跳过 */ }
  }
  return out;
}

export const CONFIRM_MARK = '【先确认一下】';

/**
 * 防循环：这一次的答复读成"要改"、以批准字眼开头，而且这条线上**上一次**判读也是这样 → 不出新版，先挂一条确认事项。
 * 返回 { questionId, text }（调用方把自己的指针改指向它、按 proposed 退出，返回形状带 text），或 null（照常按反馈出下一版）。
 *
 * 确认事项的答复由同一台状态机、同一套判读来读：回 A → 按当前这一版批准；写要改什么 → 按反馈出下一版；回 C → 放弃。
 * 确认事项自己的答复不再触发确认（否则会问个没完）。
 */
export function confirmBeforeRevising(db, { taskId, questionId, body, version, reached = false }) {
  if (!approvalLead(withoutReservation(body))) return null;
  const q = db.one(`SELECT text FROM questions WHERE id=?`, questionId);
  if (hasMark(q?.text, 'confirm')) return null;
  const prev = db.all(`SELECT payload FROM audit_log WHERE action='approval_read' AND target_id=? ORDER BY id DESC LIMIT 20`, taskId)
    .map((a) => { try { return JSON.parse(a.payload); } catch { return {}; } })
    .find((p) => p.questionId !== questionId);
  if (!prev || prev.verdict !== 'feedback' || !prev.lead) return null;

  const qid = newId('q'), t = now();
  // 确认事项送给原来那条的同一批人（方案分段会签时，前缀决定了哪几个人要签）
  let prevPrefixes = null; try { prevPrefixes = JSON.parse(db.one('SELECT route FROM questions WHERE id=?', questionId)?.route ?? 'null')?.prefixes ?? null; } catch { /* 没有路由信息：按任务默认 */ }
  const L = contentLang(db);
  const v = version != null ? `v${version}` : tl(L, '上一版');
  const text = [
    `${markOf(L, 'confirm')}${tl(L, '你对方案连着两次的答复都以「{lead}」开头、后面又写了话，两次系统都没法当成批准 —— 上一次已经按"要改"多出了一版。这一次先不出新版，问清楚再动。', { lead: approvalLead(withoutReservation(body)) })}`,
    tl(L, '（这条事项本身是系统按规则直接生成的，不是 AI 写的。）'),
    '',
    tl(L, '你前一条答复写的：'),
    ...String(body).split('\n').map((l) => `> ${l}`),
    '',
    tl(L, '方案本身见上一条事项（{v}）。怎么答：', { v }),
    reached ? tl(L, '- 确认达成：只回「A」。') : tl(L, '- 就按 {v} 批准：只回「A」。想留一句话，另起一行写「保留：…」—— 不挡任何东西，只记在约定清单上。', { v }),
    tl(L, '- {what}：直接写要改什么（别用「A」开头）；你前一条答复的原话会和这次写的一起交给 AI，按它出下一版。这条确认只问一次，这次的答复系统照常判读。', { what: reached ? tl(L, '还差东西') : tl(L, '要改') }),
    reached ? tl(L, '- 先放着：回「C」。') : tl(L, '- 放弃这份方案：回「C」。'),
  ].join('\n');
  db.tx(() => {
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, qid, taskId, text, t);
    routeQuestion(db, { questionId: qid, decisionType: 'contract_approval', typeSource: 'hard_rule', prefixes: prevPrefixes, at: t });
    db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
    audit(db, { actorKind: 'system', actorId: 'approval', action: 'approval_confirm_raised', targetType: 'task', targetId: taskId,
      payload: { questionId: qid, after: questionId, version, body: String(body) } });
  });
  return { questionId: qid, text };
}

/**
 * 反馈原文：答的是确认事项时，把被拦下的那段一起带上（人在确认事项里多半只补一句，别让前面那段丢了）。
 */
export function feedbackOf(db, { taskId, questionId, body }) {
  const c = db.one(`SELECT payload FROM audit_log WHERE action='approval_confirm_raised' AND target_id=? AND payload LIKE ? ORDER BY id DESC LIMIT 1`,
    taskId, `%"questionId":"${questionId}"%`);
  if (!c) return body;
  let before = null; try { before = JSON.parse(c.payload).body; } catch { /* 无 */ }
  return before ? `${before}\n\n（确认时补充）\n${body}` : body;
}
