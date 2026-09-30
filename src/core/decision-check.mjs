// 新意见 vs 尚未作废的旧决定。
//
// 三个入口（新任务描述 / 变更消息 / 对问题的答复）各自在落地前后把文本拿来，对照本项目的
// 有效决定清单过一遍轻档模型。命中就生成一条事项，让人显式地说"以新为准"还是"以旧为准"。
//
// 三条原则决定了这里每一个取舍（拍板时定的，改之前先想清楚）：
//   1. **多数是正当演进。** 系统的职责是把"作废旧决定"显式化，**不是拦住人**。所以命中不阻塞
//      任何流程：该答的答了、该改的改了，只是**同时**多出一条要人拍一下的事项。
//   2. **"以新为准"必须一键。** 三个选项里它排第一，答一句就够，旧决定当场作废。
//   3. **误报代价要低。** 一条误报应该是多点一次鼠标，不是多开一场会 —— 所以提示词里反复压
//      "补充 / 细化 / 旧决定没覆盖的地方都不算冲突"，并且设了置信下限。
//
// 模型只回答一个问题：**这两句话能不能同时成立**。它不判断谁对、不给建议、不碰任何状态。

import { withOutputLang, contentLang, tl } from '../i18n/index.mjs';
import { markOf } from '../i18n/marks.mjs';
import { newId, now, audit, insertEdge } from '../db/db.mjs';
import { routeQuestion, leadOf, routingKeyOf, rulesOf, matchChains, resolveRecipients, stripTransferHint } from './routing.mjs';
import { RESOLUTION_HOOKS } from './answers.mjs';
import { voidOne, activeDecisions, scopeHints, SOURCE_NAMES, sourceTagOf } from './decisions.mjs';
import { textOf } from '../llm/canonical.mjs';
import { flushLedger } from './ledger.mjs';
import { steeringFrom, releaseCheckHold } from './inbox.mjs';

export const CHECK_TIER = 'light';
/** 低于这个置信度的命中直接丢掉：宁可漏报，也不要用一条没把握的"冲突"去打断人。 */
export const HIT_CONFIDENCE_FLOOR = 0.6;
/** 一次最多拿几条去问：清单长到一定程度，轻档模型读不动，也不该一次报十条。 */
export const MAX_HITS = 3;

export const ENTRY_NAMES = { task: '新任务描述', revision: '变更消息', answer: '对问题的答复' };

const head = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const day = (ts) => new Date(Number(ts) || 0).toISOString().slice(0, 10);

const systemPrompt = () => `你是 SuperIntern 的决定比对器。你只做一件判断：**人刚说的这段话，和下面某一条已经定下的决定，能不能同时成立。**

不算冲突的情形（这些是绝大多数，看到就放过）：
- 补充：新话说的是旧决定没覆盖的地方；
- 细化：新话把旧决定说得更具体，方向一致；
- 重复：新话和旧决定说的是同一件事；
- 无关：新话根本没碰旧决定涉及的东西。

算冲突的只有一种：**照新话做，就必然违反那条旧决定**（或者反过来）。举例：旧决定说"错误码一律
用 ERR_ 前缀"，新话说"错误码改成数字"——两者不能同时成立，这是冲突。

你拿不准的时候，**不要报**。漏掉一条的代价，远小于用一条假冲突去打断一个正在干活的人。

你只回一个 JSON 对象，不要输出 JSON 之外的任何文字：
{"hits":[{"id":"<决定编号，必须来自下面的清单>","quote":"<新话里与之冲突的那一句，原文照抄>","why":"<一句话：为什么两者不能同时成立>","confidence":<0到1>}]}
没有冲突就回 {"hits":[]}。`;

const buildPrompt = (text, decisions, entry) => `## 已经定下的决定（本项目此刻仍然有效）
${decisions.map((d) => `- ${d.id}〔${SOURCE_NAMES[d.source_kind] ?? d.source_kind}〕${d.subject}：${head(d.statement, 400)}`).join('\n')}

## 人刚说的话（来自：${ENTRY_NAMES[entry] ?? entry}）
${text}

现在只回一个 JSON 对象。`;

const extractJson = (t) => {
  const s = String(t ?? '').trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const a = body.indexOf('{'), b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
};
const conf = (v) => { const n = typeof v === 'number' ? v : Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };

/**
 * 把文本对着一份决定清单过一遍。**只调模型与解析，不碰库、不落账**（记账由调用方 flushLedger，
 * 与 classifier.mjs 同一条规矩）。清单为空就一次模型都不调。
 *
 * @returns {{hits:Array<{id,quote,why,confidence}>, considered:number, skipped:string|null, dropped:number}}
 */
export async function checkDecisions(text, { decisions = [], llmClient, entry = 'answer', lang = null } = {}) {
  if (!String(text ?? '').trim()) return { hits: [], considered: 0, skipped: 'empty_text', dropped: 0 };
  if (!decisions.length) return { hits: [], considered: 0, skipped: 'no_decisions', dropped: 0 };
  if (!llmClient) return { hits: [], considered: decisions.length, skipped: 'no_client', dropped: 0 };
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const messages = [{ role: 'user', content: [{ type: 'text', text: buildPrompt(text, decisions, entry) }] }];
  let raw = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await llmClient.complete({ tier: CHECK_TIER, system: withOutputLang(systemPrompt(), lang), messages, maxTokens: 800 });
    raw = extractJson(textOf(resp));
    if (raw && Array.isArray(raw.hits)) break;
    raw = null;
    if (attempt === 0) {
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: [{ type: 'text', text: '你上次的回复不合规。只回一个 JSON 对象，形如 {"hits":[]}。' }] });
    }
  }
  // 解析不出来就当作没冲突：比对是**附加**的一道检查，它自己坏掉不该变成一条打断人的事项。
  if (!raw) return { hits: [], considered: decisions.length, skipped: 'unparsable', dropped: 0 };
  let dropped = 0;
  const hits = [];
  for (const h of raw.hits) {
    const d = byId.get(String(h?.id ?? '').trim());
    const c = conf(h?.confidence);
    // 编号必须来自清单：模型编一个出来，宁可丢掉也不能拿去作废一条真决定。
    if (!d || c < HIT_CONFIDENCE_FLOOR) { dropped++; continue; }
    hits.push({ id: d.id, quote: head(h?.quote, 300), why: head(h?.why, 300) || tl(lang, '（模型没给理由）'), confidence: c });
  }
  return { hits: hits.slice(0, MAX_HITS), considered: decisions.length, skipped: null, dropped: dropped + Math.max(0, hits.length - MAX_HITS) };
}

// ── 命中之后找谁 ─────────────────────────────────────────────────────────
/**
 * 三种走法（拍板时定的特例）：
 *   self    新旧同一人 → 单行确认"这会推翻你自己在某日的决定 X，确认作废？"，不劳动别人；
 *   lead    旧决定的作者已停用，**或旧决定是契约里的条款**（那是负责人批的，改它等于改契约）
 *           → 直接找负责人。后者就是现有的越权防护，不额外发明规则；
 *   parties 其余 → 两段式：双方先谈，谈不拢或超时转负责人。
 */
export function routeOf(db, { decision, by }) {
  if (decision.decided_by && by && decision.decided_by === by) return { mode: 'self', parties: [by] };
  const author = decision.decided_by ? db.one(`SELECT id, disabled_at FROM users WHERE id=?`, decision.decided_by) : null;
  if (decision.source_kind === 'contract') return { mode: 'lead', parties: [] };
  if (!author || author.disabled_at) return { mode: 'lead', parties: [] };
  return { mode: 'parties', parties: [...new Set([by, author.id].filter(Boolean))] };
}

const nameOf = (db, id) => (id ? db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id : tl(contentLang(db), '（系统）'));
/** 事项正文里的入口名（按内容语言）；ENTRY_NAMES 本身给模型的提示词用，保持中文。 */
const entryNameOf = (L, entry) => (entry === 'task' ? tl(L, '新任务描述') : entry === 'revision' ? tl(L, '变更消息') : entry === 'answer' ? tl(L, '对问题的答复') : entry);

/**
 * 一次输入命中**一组**决定时的走法：
 * 例如"把 DEFAULT_PAGE_SIZE 改成 20"可能同时推翻 4 条已登记的规则 —— 常量本身那条，
 * 加上三条断言 size===10 的行为样例。这是"一条规则只讲一件事"的必然后果：清单越细，
 * 一句话推翻的条数越多。按每条一事项，一句话会变成三四条待办，每条都要人单独选一次"以新为准"。
 * 所以按**输入**归并：一句话 = 一条事项，正文里把被推翻的都列出来，一次选定、一起作废。
 */
const groupRoute = (db, group, by) => {
  const modes = group.map((g) => routeOf(db, { decision: g.decision, by }));
  // 只要有一条是契约条款（或作者已停用），整组就归负责人 —— 取最严的那一档，不让一组里混两种走法。
  // mode='lead' 时也要把负责人**当成当事一方**填进 parties：`conflict` 类型的路由表第一行就是
  // "冲突双方"，parties 给空 → 第一阶段解析出零个收件人，事项要挂满一个工作日等超时才转到下一行。
  // 一条 lead 走法的事项 addressed_to=[]，按停等账本的判据那正是"有事项却没有人会看到它"。
  if (modes.some((m) => m.mode === 'lead')) { const l = leadOf(db, group[0]?.decision?.task_id ?? null); return { mode: 'lead', parties: l ? [l] : [] }; }
  if (modes.every((m) => m.mode === 'self')) return { mode: 'self', parties: [by] };
  return { mode: 'parties', parties: [...new Set(modes.flatMap((m) => m.parties))] };
};


/**
 * 说这句话的人在这个项目里的身份，跟在名字后面。
 *
 * 为什么非有不可：这条事项要人回答的是"以新为准还是以旧为准"，而**旧决定每条都写着"由谁定下"，
 * 新说法若一个署名都没有**，负责人就可能拒绝裁定，理由是"这块是用户能看到的行为，找产品
 * 拿到取舍再回来告诉我" —— 而那句话正是产品说的，事项没告诉他。一次本可以当场结案的裁定，
 * 就变成了一轮系统外的对话。
 */
const roleHint = (db, userId) => {
  if (!userId) return '';
  const u = db.one(`SELECT display_name, role FROM users WHERE id=?`, userId);
  if (!u) return '';
  const note = db.one(`SELECT m.note FROM project_members m JOIN tasks t ON t.project_id=m.project_id
                       WHERE m.user_id=? AND m.note<>'' LIMIT 1`, userId)?.note;
  const short = note ? String(note).split(/[：:，,；;]/)[0].trim().slice(0, 12) : null;
  return short ? ` · ${short}` : (u.role === 'lead' ? tl(contentLang(db), ' · 管理员') : '');
};
const bodyOf = (db, { group, entry, by, mode, held = false }) => {
  const contract = group.some((g) => g.decision.source_kind === 'contract');
  const one = group.length === 1;
  const lead = mode === 'lead';
  const L = contentLang(db);
  const n = group.length;
  const listed = group.map(({ decision: d, hit }, i) => `${one ? '' : tl(L, '（{i}）', { i: i + 1 })}[${d.id}]${sourceTagOf(L, d.source_kind)}${d.subject}`
    + `${d.source_kind === 'contract'
      ? tl(L, '（{day} 由 {who} 定下，是批准过的契约里的条款）', { day: day(d.decided_at), who: nameOf(db, d.decided_by) })
      : tl(L, '（{day} 由 {who} 定下）', { day: day(d.decided_at), who: nameOf(db, d.decided_by) })}\n`
    + `　　${head(d.statement, 400)}\n　　${tl(L, '为什么对不上：{why}', { why: hit.why })}`).join('\n\n');
  const quote = group.find((g) => g.hit.quote)?.hit.quote ?? null;
  const entryName = entryNameOf(L, entry);
  return `${markOf(L, 'decisionConflict')}${mode === 'self'
    ? (one ? tl(L, '你这次说的，会推翻你自己先前定下的一条决定。') : tl(L, '你这次说的，会推翻你自己先前定下的{n} 条决定。', { n }))
    : (one ? tl(L, '这次的{entry}，和一条仍然有效的旧决定对不上。', { entry: entryName }) : tl(L, '这次的{entry}，和 {n} 条仍然有效的旧决定对不上。', { entry: entryName, n }))}

${tl(L, '这次说的（{who}）：{quote}', { who: `${nameOf(db, by)}${roleHint(db, by)}`, quote: quote ? `“${quote}”` : tl(L, '（见本任务的最新消息）') })}

${one ? tl(L, '旧决定：') : tl(L, '被推翻的 {n} 条旧决定：', { n })}
${listed}

${mode === 'self' ? '' : lead
    ? `${group.some((g) => g.decision.source_kind === 'contract')
      ? tl(L, '其中有契约里的条款 —— 契约是你批准过的，改它只能由你来定。')
      : tl(L, '定下这些决定的人已经停用，所以这条交给你。')}\n`
    : `${tl(L, '先由 {by} 与{others} 商量；谈不拢或超时转项目负责人裁定。', { by: nameOf(db, by), others: [...new Set(group.map((g) => nameOf(db, g.decision.decided_by)))].join(tl(L, '、')) })}\n`}${one ? tl(L, '请选一条：') : tl(L, '请选一条（一次选定，上面 {n} 条一起处理）：', { n })}
${one ? tl(L, '(A) **以新为准** —— 上面那条旧决定就此作废：回「以新为准」') : tl(L, '(A) **以新为准** —— 上面那些旧决定就此作废：回「以新为准」')}
${tl(L, '(B) 以旧为准 —— 这次的说法不算数，照旧决定执行：回「以旧为准」')}
${tl(L, '(C) 其实不冲突 —— 都能同时成立：回「不冲突：」再写一句为什么')}

${one ? tl(L, '系统不替你判谁对。选 (A) 之后，它会在清单里标成"已作废"，并记下是被这次的说法取代的。') : tl(L, '系统不替你判谁对。选 (A) 之后，它们会在清单里标成"已作废"，并记下是被这次的说法取代的。')}
${contract ? `${tl(L, '写着这条的任务说明原文不改，但那个任务之后执行时会照新的说法做，不会为这一条再来问你。')}\n` : ''}${group.length > 1 ? `\n${tl(L, '如果只想作废其中一部分，回 (C) 并说明哪几条该留，然后对该留的那几条不必再管；要改的那几条另提一次。')}\n` : ''}
${held
    // 这次说的是一条修正（或新指令），它在比对前就被挡住了 —— 上面那句"没有拦住任何事"对它不成立。
    ? tl(L, `⚠ 这次说的是一条要改计划的修正，它**在你选定之前不会执行**，这个任务也先停着。
选 (A)，修正照做；选 (B)，修正里与旧决定相冲的那部分不执行，其余照做。
旧决定在你选定之前仍然留在"已定的约定"清单上（标成"正在被争议"）。`)
    : tl(L, `⚠ 这条事项**没有拦住任何事**：这次说的已经生效了，旧决定在你选定之前也仍然留在"已定的约定"清单上
（它们会被标成"正在被争议"）。在你选之前，两边都在 —— 所以别拖。`)}`;
};

/**
 * 一次输入命中的那一组，挂**一条**事项。`group` = [{ decision, hit }]。
 * 已经有开着的冲突事项指着的决定先剔掉；全剔光就什么都不做。
 */
/**
 * 这几条决定落在**谁的地盘**上。按每条决定自己的 scope 去查一次路由表，
 * 取 `spec_choice` 那一链的收件人 —— 用规格取舍这一类，因为"这一片归谁"在表里就是按它写的。
 *
 * 只用来加 `informed`（该知道的人知道），**不加 answerers**：
 * 多一个人要点头会把一次裁定变成一场会，而范围所有者要的不是"让我批"，是"在我这走过"。
 * 查不到（决定没写 scope、表里只有 `*` 行）就返回空 —— 不猜。
 */
function rangeOwnersOf(db, { taskId, decisions }) {
  const key = routingKeyOf(db, taskId);
  const lead = leadOf(db, taskId);
  const rules = rulesOf(db, key);
  const out = new Set();
  for (const d of decisions ?? []) {
    // `decision` 可能来自 `shape()`（scope 已经是数组）也可能是裸的库行（scope 是 JSON 串）——
    // 这里两种都收：调用方有两条路，靠约定走迟早有一条忘了。
    let sc = d.scope;
    if (typeof sc === 'string') { try { sc = JSON.parse(sc || '[]'); } catch { sc = []; } }
    const prefixes = (Array.isArray(sc) ? sc : []).map((x) => String(x)).filter(Boolean);
    if (!prefixes.length) continue;
    for (const { scope, chain } of matchChains(rules, { decisionType: 'spec_choice', prefixes })) {
      if (scope === '*') continue;                       // `*` 是兜底行，不构成"这一片归谁"
      for (const rule of chain) {
        try { resolveRecipients(db, key, rule.recipients, { at: now(), lead }).answerers.forEach((u) => out.add(u)); }
        catch { /* 解析不出来就不猜 */ }
      }
    }
  }
  if (lead) out.delete(lead);                            // 负责人本来就在收件人里
  return [...out];
}

export function raiseDecisionConflict(db, { taskId, group, entry, by, messageIds = [], at = now() }) {
  const fresh = [], reusedIds = new Set();
  for (const g of group) {
    const dup = db.one(`SELECT q.id FROM questions q JOIN edges e ON e.from_id=q.id
                        WHERE q.task_id=? AND q.status IN ('open','escalated') AND e.relation='derived_from' AND e.to_id=? LIMIT 1`, taskId, g.decision.id);
    if (dup) reusedIds.add(dup.id); else fresh.push(g);
  }
  // 出处边再指一条到**那条修正**（不只指被撞的决定）—— 没有这条边，没人知道
  // 那条修正在等谁；它也是修正被挡住的唯一依据（inbox.heldSteering 读的就是它）。
  // 复用已开着的事项时同样要连：这条修正等的正是那一条的结论。
  const linkMessages = (qid) => { for (const mid of messageIds) insertEdge(db, qid, mid, 'derived_from', at); };
  if (!fresh.length) {
    for (const qid of reusedIds) linkMessages(qid);
    return { questionId: [...reusedIds][0] ?? null, mode: null, reused: true, decisionIds: [] };
  }
  for (const qid of reusedIds) linkMessages(qid);
  const { mode, parties } = groupRoute(db, fresh, by);
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
          VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, id, taskId, bodyOf(db, { group: fresh, entry, by, mode, held: messageIds.length > 0 }), at);
  // 出处边指向每一条旧决定 —— 结论钩子靠它们认出"这是一条决定冲突"，并知道该作废哪几条。
  for (const g of fresh) insertEdge(db, id, g.decision.id, 'derived_from', at);
  linkMessages(id);
  const r = routeQuestion(db, { questionId: id, decisionType: 'conflict', typeSource: 'hard_rule', parties, at });
  if (parties.length) db.run(`UPDATE questions SET route=json_set(route,'$.parties',json(?)) WHERE id=?`, JSON.stringify(parties), id);
  // 兜底：解析完还是没有人 —— 那就是一条没有人会看到的事项（停等账本会把它算成缺陷）。
  // 与其让它躺一个工作日等超时，不如当场塞给负责人，并记一条审计说明是兜的。
  if (!JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, id).addressed_to || '[]').length) {
    const l = leadOf(db, taskId);
    if (l) {
      db.run(`UPDATE questions SET addressed_to=? WHERE id=?`, JSON.stringify([l]), id);
      audit(db, { actorKind: 'system', actorId: 'decision-check', action: 'question_rerouted', targetType: 'question', targetId: id,
        payload: { why: tl(contentLang(db), '路由表解析出零个收件人，兜底改派给项目负责人'), to: [l] } });
    }
  }
  // **冲突事项按"谁批的契约"路由，不按"这条决定落在谁的地盘上"路由。**
  // 例：size 越界的口径由产品提出、负责人裁定、两次计划变更落地，可能全程没有一条事项到过后端同事 ——
  // 而 `server/` 正是他的地盘，路由表里明明写着 `spec_choice/server → 后端同事`。他要到签收时才知道，
  // 第一句话会是"这个变更是谁批的？没在我这走过"。
  // `groupRoute` 取最严的一档归负责人，那一条本身是对的；缺的是**把范围所有者列进知会**。
  // 只加 informed、不加 answerers：这不是"多一个人要点头"（那会把裁定变成会议），是"该知道的人知道"。
  const owners = rangeOwnersOf(db, { taskId, decisions: fresh.map((g) => g.decision) });
  if (owners.length) {
    const cur = new Set(JSON.parse(db.one(`SELECT informed FROM questions WHERE id=?`, id).informed || '[]'));
    const answering = new Set(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, id).addressed_to || '[]'));
    const add = owners.filter((u) => !cur.has(u) && !answering.has(u));
    if (add.length) {
      db.run(`UPDATE questions SET informed=? WHERE id=?`, JSON.stringify([...cur, ...add]), id);
      audit(db, { actorKind: 'system', actorId: 'decision-check', action: 'question_informed_added', targetType: 'question', targetId: id,
        payload: { added: add, why: tl(contentLang(db), '这几条决定落在他们的范围上，按路由表该让他们知道') } });
    }
  }
  audit(db, { actorKind: 'system', actorId: 'decision-check', action: 'decision_conflict_raised', targetType: 'question', targetId: id,
    payload: { decisionIds: fresh.map((g) => g.decision.id), taskId, entry, mode, by, addressedTo: r.answerers, rangeOwners: owners, heldMessages: messageIds,
      hits: fresh.map((g) => ({ id: g.decision.id, confidence: g.hit.confidence, why: g.hit.why, quote: g.hit.quote ?? null })) } });
  return { questionId: id, mode, reused: false, decisionIds: fresh.map((g) => g.decision.id) };
}

// ── 结论 ─────────────────────────────────────────────────────────────────
/** 把答复读成三种结论之一。读不出来当作"不冲突"——最保守：不作废任何东西。 */
export function verdictOf(body) {
  const s = String(body ?? '').replace(/\s/g, '');
  // 英文说法（空白已去掉，所以按连写匹配）：go with the new / keep the old …
  if (/^\(?[AaＡ]\)?$/.test(s) || /以新为准|按新的|用新的|作废旧|新的为准|gowiththenew|usethenew|thenewone|newwins/i.test(s)) return 'new';
  if (/^\(?[BbＢ]\)?$/.test(s) || /以旧为准|按旧的|用旧的|维持原|旧的为准|撤回|keeptheold|gowiththeold|theoldone|oldwins|withdraw/i.test(s)) return 'old';
  return 'none';
}

// 这条钩子只对**没有 origin_question_id 的 conflict 事项**生效 —— 普通（两段式）冲突事项结论会回写到
// 原事项上，resolve() 那时拿的是原事项的类型，走不到这里。所以不会误伤普通冲突。
/**
 * 一条修正身上已经有结论的决定冲突 —— 重规划器拿着它干活。
 * 每条 `{ questionId, verdict: 'new'|'old'|'none', by, at, decisions: [{id, subject, statement}] }`。
 * 只认审计里那条 `decision_conflict_resolved`（结论钩子写的），不从答复原文里再猜一遍。
 */
export function verdictsOn(db, messageId) {
  const qs = db.all(`SELECT q.id, q.resolved_at FROM edges e JOIN questions q ON q.id=e.from_id
                      WHERE e.to_id=? AND e.relation='derived_from' AND q.status NOT IN ('open','escalated')
                        AND EXISTS (SELECT 1 FROM edges d WHERE d.from_id=q.id AND d.relation='derived_from' AND d.to_id LIKE 'dr_%')
                      ORDER BY q.asked_at`, messageId);
  const out = [];
  for (const q of qs) {
    const a = db.one(`SELECT actor_id, ts, payload FROM audit_log WHERE action='decision_conflict_resolved' AND target_id=? ORDER BY id DESC LIMIT 1`, q.id);
    if (!a) continue;
    const p = JSON.parse(a.payload || '{}');
    out.push({ questionId: q.id, verdict: p.verdict ?? 'none', by: a.actor_id ?? null, at: q.resolved_at ?? a.ts,
      decisions: (p.decisionIds ?? []).map((id) => db.one(`SELECT id, subject, statement FROM decision_registry WHERE id=?`, id)).filter(Boolean) });
  }
  return out;
}

RESOLUTION_HOOKS.conflict = (db, { question, finalBody, by, at }) => {
  const links = db.all(`SELECT to_id FROM edges WHERE from_id=? AND relation='derived_from' AND to_id LIKE 'dr_%'`, question.id).map((e) => e.to_id);
  if (!links.length) return null;
  const verdict = verdictOf(finalBody);
  // 一次选定、一起作废：这条事项挂着几条决定，"以新为准"就把这几条一起标掉。
  if (verdict === 'new') for (const id of links) voidOne(db, { id, by, reason: tl(contentLang(db), '由事项 {id} 判定以新为准', { id: question.id }), at });
  // 作废的若是**契约条款**，它还写在那个任务的契约里。契约原文不改，标注由
  // `overruledContractRules` 从登记表机械算出、进执行器 / 规划器 / 重规划器的上下文 —— 这里只记一笔
  // "哪个任务受了影响、当时合没合并"，事后数得出来这条修法实际碰过几个任务。**不给人另挂事项**：
  // 人已经对这一条说过"以新为准"了，再挂就是让他对同一件事表第二次态。
  if (verdict === 'new') {
    for (const id of links) {
      const d = db.one(`SELECT task_id, source_kind FROM decision_registry WHERE id=?`, id);
      if (d?.source_kind !== 'contract' || !d.task_id) continue;
      const t = db.one(`SELECT status, merged_at FROM tasks WHERE id=?`, d.task_id);
      audit(db, { actorKind: 'user', actorId: by, action: 'contract_rule_overruled', targetType: 'task', targetId: d.task_id,
        payload: { decisionId: id, questionId: question.id, merged: !!t?.merged_at, status: t?.status ?? null } });
    }
  }
  audit(db, { actorKind: 'user', actorId: by, action: 'decision_conflict_resolved', targetType: 'question', targetId: question.id,
    payload: { decisionIds: links, verdict, body: String(finalBody).slice(0, 300) } });
  return { decisionIds: links, verdict };
};

/**
 * 一个入口的完整一趟：取清单 → 预筛 → 问模型 → 命中的各挂一条事项。
 * 调用方负责 flushLedger。清单为空或没有 llmClient 时是零成本的空操作。
 */
/**
 * 清单多长就**不再全量**给模型看。这个数字是测出来的，不是拍的：实测 81 条一次调用
 * $0.0013–0.0047、4–9 秒（deepseek-flash）。真要到这个量级再谈省钱。
 */
export const PREFILTER_ABOVE = 200;

export async function checkAndRaise(db, { taskId, projectId = null, text, entry, by, llmClient, messageIds = [], at = now() }) {
  const pid = projectId ?? db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;
  // ⚠️ **默认不按范围预筛。** 例："接口路径从 /orders
  // 换成 /api/orders" 这句里的 `scopeHints` 抽出了 `api/orders` —— 那是一个 **URL 路径**，被当成
  // 文件路径用；于是"两边都写了路径"成立，而真正该比的那条（`ORDERS_PATH = '/orders'`，范围
  // shared/contract.mjs）被滤掉了。"从散文里抽路径"的启发式本就不可靠：
  // 别拿它执法，而且**连预筛也别拿它做**：它省下的钱（一次半分钱）
  // 远不抵它漏掉最该比的那一条。只在清单长到 PREFILTER_ABOVE 之上才退回预筛，并记在审计里。
  // 保留意见**不进比对**：它不是一条能被违反的规则，拿它去比会把每一次触及
  // 这一处都报成冲突。它的用处在别处 —— 进上下文、进审计、可被事后统计。
  const full = activeDecisions(db, { projectId: pid, taskId: pid ? null : taskId }).filter((d) => !d.reservation);
  const prefiltered = full.length > PREFILTER_ABOVE;
  const list = prefiltered ? activeDecisions(db, { projectId: pid, taskId: pid ? null : taskId, scope: scopeHints(text) }).filter((d) => !d.reservation) : full;
  const r = await checkDecisions(text, { decisions: list, llmClient, entry, lang: contentLang(db) });
  // 一次输入 = 一条事项：命中的那一组归并起来挂，不是一条一个（一句话可能命中好几条）。
  const group = [];
  for (const h of r.hits) {
    const d = db.one(`SELECT * FROM decision_registry WHERE id=? AND status='active'`, h.id);
    if (d) group.push({ decision: d, hit: h });
  }
  const raised = group.length ? [raiseDecisionConflict(db, { taskId, group, entry, by, messageIds, at })] : [];
  if (r.skipped === null || r.hits.length) {
    audit(db, { actorKind: 'system', actorId: 'decision-check', action: 'decision_check_done', targetType: 'task', targetId: taskId,
      payload: { entry, considered: r.considered, total: full.length, prefiltered, hits: r.hits.length, dropped: r.dropped, raised: raised.map((x) => x.questionId) } });
  }
  return { ...r, raised, prefiltered };
}

/**
 * 三个入口共用的一行钩子：**永远不抛、永远不阻塞**。
 *
 * 原则一说得很直白 —— 系统的职责是把"作废旧决定"显式化，不是拦住人。所以这一步放在
 * 输入已经落地之后跑：答复已经答了、消息已经收了、任务描述已经提交了，比对只是**另外**
 * 挂一条待办。比对器自己出任何问题（没配模型、调不通、解析不出来）都只记一条审计，
 * 绝不让一次"记账失败"变成人做不成事。
 *
 * @param makeClient  懒创建 —— 清单为空时一次客户端都不建（新项目、没有任何决定时零成本）
 * @param sourceId    这段文字来自哪条消息。它自己若是修正 / 新指令、或有修正从它派生（签收打回），
 *                    这些修正在落库时已标"待比对"；这里命中就把冲突事项连到它们身上，
 *                    **无论命中与否、成败与否**最后都放行"待比对"那一层 —— 比对器出任何问题都不许把修正卡死。
 */
export async function afterInput(db, { taskId, text, entry, by, makeClient, sourceId = null, at = now() }) {
  // 答复要带着它回答的那道题一起比：人对选项题只回一个字母，比对器拿到的就只有 "a" ——
  // 它会把第二题的 "a" 读成在改第一题的口径（旧决定是 b），当场挂出一条假冲突。
  if (entry === 'answer' && sourceId) {
    // "答的是哪道题"先按 answers 表找：会签事项里各人的答复消息不连 answers 边（只有合并后的那条连）——
    // 只按边找会找不到 → 纯裁决跳过与"带上题目"都失效，成员回的光秃秃的「A」照样挂假冲突。
    let aq = null;
    try {
      aq = db.one(`SELECT q.id, q.decision_type, q.text FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.message_id=? ORDER BY a.created_at DESC LIMIT 1`, sourceId)
        ?? db.one(`SELECT q.id, q.decision_type, q.text FROM edges e JOIN questions q ON q.id=e.to_id WHERE e.from_id=? AND e.relation='answers' ORDER BY e.id DESC LIMIT 1`, sourceId);
    } catch { /* 查不到就照常比 */ }
    if (aq?.decision_type === 'contract_approval') {
      // 方案批准的裁决（「A」/「批准」/「先放着」……）不带新说法：要比的是草案本身，草案起草时已经对着既有决定写过（否则「A」会被读成推翻 B）。
      // 裁决后面的保留意见才是新说法 —— 只拿它去比（否则「A + 保留意见」会被读成"前端范围那题选 A"）。
      const rest = String(text ?? '').replace(/^\s*[（(]?\s*([A-Da-d]|批准|同意|确认达成|先放着|放弃)\s*[)）]?[。！!.,，:：\s]*/, '')
        .replace(/^\s*保留(意见)?\s*[:：]\s*/, '').trim();
      if (!rest) {
        const held = steeringFrom(db, sourceId);
        if (held.length) releaseCheckHold(db, { taskId, ids: held });
        return { hits: [], raised: [], skipped: 'verdict_only' };
      }
      text = `（这是批准方案时附的保留意见；批准本身不算新说法，只看这段话与旧决定是否矛盾）\n${rest}`;
    } else if (aq?.text) {
      text = `（这是对下面这道题的答复）\n题目：${stripTransferHint(aq.text).slice(0, 1200)}\n答复：${text}`;
    }
  }
  let messageIds = [];
  try { messageIds = steeringFrom(db, sourceId); } catch { /* 找不到就不连，放行照常 */ }
  try {
    const pid = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;
    const list = activeDecisions(db, { projectId: pid, taskId: pid ? null : taskId }).filter((d) => !d.reservation);
    if (!list.length) return { hits: [], raised: [], skipped: 'no_decisions' };
    const llmClient = makeClient?.() ?? null;
    if (!llmClient) return { hits: [], raised: [], skipped: 'no_client' };
    try { return await checkAndRaise(db, { taskId, projectId: pid, text, entry, by, llmClient, messageIds, at }); }
    finally { try { flushLedger(db, llmClient, { taskId, role: 'decision-check' }); } catch { /* 记账失败不连累 */ } }
  } catch (e) {
    audit(db, { actorKind: 'system', actorId: 'decision-check', action: 'decision_check_failed', targetType: 'task', targetId: taskId,
      payload: { entry, error: e.message } });
    return { hits: [], raised: [], skipped: 'failed', error: e.message };
  } finally {
    if (messageIds.length) { try { releaseCheckHold(db, { taskId, ids: messageIds }); } catch { /* 放不掉就等 held_until 到点 */ } }
  }
}
