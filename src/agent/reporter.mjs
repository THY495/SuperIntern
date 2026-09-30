// 汇报生成器 —— 第三个 LLM 子程序。
//
// 汇报的三条硬要求，这里各有落点：
//   1. **仅从真相源装配**：gatherSince() 只读库和叙事文件，不读任何执行器上下文。
//      汇报"描述记录，而不是辩护记忆"—— 执行器自述天然合理化。
//   2. **自作主张的决定与假设不可省**：那一节由**代码**从 assumptions.must_disclose
//      与 decisions(actor_kind='agent') 直接生成，追加在正文里，模型写不写都在。
//      "人监督价值最高的部分"不能交给模型自选（护栏住在模型外）。
//   3. **兼任持久化纪律审计**：装配时顺手查"这段窗口里 done 的节点，交接记录在不在、
//      叙事文件在不在"。查不到就写进 gaps —— 那正是"若无法仅凭真相源
//      重建发生了什么，即证明执行器违反了 flush-before-evict"。
//
// fire-and-forget：汇报不阻塞、不等待确认。LLM 只负责摘要与"下一步 / 不确定点"的
// 散文；它挂了（厂商故障、预算触顶）就退回模板 —— 汇报永远能产生，
// 尤其是"钱花光了"那一条，它必须在钱花光之后仍能说出口。

import { withOutputLang, contentLang, tl } from '../i18n/index.mjs';
import { existsSync } from 'node:fs';
import { runToolLoop } from '../llm/client.mjs';
import { newId, now, audit, insertEdge } from '../db/db.mjs';
import { activeDecisions, scopeHints, SOURCE_NAMES as DEC_SOURCE } from '../core/decisions.mjs';

const fmtUsd = (m) => `$${(m / 1e6).toFixed(4)}`;
const head = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

// 任务做到哪一步 —— 汇报里唯一能说"完成没完成"的依据。
// 曾出现过：T2 卡在重试上限、T3 还没开工，汇报摘要却说"已完成 T2 与 T3 两块工作并沉淀为现行约定"——
// 输入里只有一行节点计数的 JSON 和一串"仍然有效的约定"（两个任务的契约批准时登记的），模型把"约定已登记"读成了"做完了"；
// 读汇报的人据此判断"其实已经做完，是计数在空转"。所以任务状态由代码写成一行放在最前，摘要里的"完成"再机械核对一遍。
// 按内容语言取（0.2.0）：lang 默认中文
const TASK_STATE = (lang = 'zh') => ({ planning: tl(lang, '未开工 / 规划中'), running: tl(lang, '进行中'), waiting: tl(lang, '等人处理'), suspended: tl(lang, '暂停'), done: tl(lang, '已做完（未合并）'), aborted: tl(lang, '已中止') });
const stateOf = (t, lang = 'zh') => (t.merged_at ? tl(lang, '已合并') : TASK_STATE(lang)[t.status] ?? t.status);
const isFinished = (t) => !!t.merged_at || t.status === 'done';
/** 任务在摘要里可能被怎么称呼：项目里的编号 #n、标题开头的 Tn、完整标题。 */
const labelsOf = (t) => [t.project_order ? `#${t.project_order}` : null, /^(T\d+)\b/.exec(t.title ?? '')?.[1] ?? null, t.title || null].filter(Boolean);

/**
 * 摘要里说某个任务"完成"了，而它其实没完成 → 返回那几个任务（空 = 没问题）。
 * 只看同一句里既点了这个任务的名、又说了"完成"，且"完成"前面不是"未 / 没 / 尚未 / 还没"。
 */
export function falseDoneClaims(summary, standing) {
  // 英文摘要按句号也断开（"T2 is done. T3 is next."）；否定说法（not / isn't / yet to be）先剥掉再看
  const sentences = String(summary ?? '').split(/[。；;！!，,\n]|\.\s/);
  const claims = (s) => /(?<![未没尚])完成/.test(s.replace(/(尚未|还没有?|没有|未能)完成/g, ''))
    || /\b(completed|finished|is done|are done|has been done)\b/i.test(s.replace(/\b(not|n't|never|yet to be|isn't|aren't|hasn't|haven't)\b[^.]{0,16}\b(completed|finished|done)\b/gi, ''));
  return standing.filter((t) => !isFinished(t) && sentences.some((s) => claims(s) && labelsOf(t).some((l) => s.includes(l))));
}

/**
 * 自上次汇报以来发生了什么 —— **只读真相源**。返回结构化事实与其 id 清单。
 * @param {number} sinceTs 窗口起点（上次汇报 created_at；没有就是任务 created_at）
 */
export function gatherSince(db, taskId, sinceTs) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
  const events = db.all(`SELECT id, ts, action, target_type, target_id, payload FROM audit_log
                          WHERE target_id IN (SELECT id FROM nodes WHERE task_id=?) OR target_id=?
                          AND ts>? ORDER BY id`, taskId, taskId, sinceTs)
    .filter((e) => e.ts > sinceTs)
    .map((e) => ({ ...e, payload: JSON.parse(e.payload || '{}') }));
  const titles = new Map(db.all(`SELECT id, title FROM nodes WHERE task_id=?`, taskId).map((n) => [n.id, n.title]));

  const byAction = (a) => events.filter((e) => e.action === a);
  // 同一节点在窗口内可能 done 过两次（修正后重跑）—— 按节点去重，留最后一次的交接记录。
  // 不去重的话，重跑过的节点会被列两遍，摘要读起来像做了 8 个节点，其实是 6 个。
  const nodesDone = [...byAction('node_done').reduce((m, e) => m.set(e.target_id, {
    id: e.target_id, title: titles.get(e.target_id), handoffId: e.payload.handoffId,
    narrativeRef: e.payload.narrativeRef, artifacts: e.payload.artifacts ?? [],
    reruns: (m.get(e.target_id)?.reruns ?? 0) + 1,
  }), new Map()).values()];
  const nodeTrouble = events.filter((e) => ['node_stalled', 'node_crashed', 'node_reclaimed', 'node_aborted', 'provider_error']
    .includes(e.action)).map((e) => ({ action: e.action, id: e.target_id, title: titles.get(e.target_id),
    why: head(e.payload.why ?? e.payload.error ?? e.payload.message ?? e.payload.stopped, 120) }));

  const decisions = db.all(`SELECT * FROM decisions WHERE task_id=? AND recorded_at>? ORDER BY recorded_at`, taskId, sinceTs);
  const assumptions = db.all(`SELECT * FROM assumptions WHERE task_id=? AND recorded_at>? ORDER BY recorded_at`, taskId, sinceTs);
  const revisions = db.all(`SELECT * FROM revisions WHERE task_id=? AND proposed_at>? ORDER BY proposed_at`, taskId, sinceTs);
  const questions = db.all(`SELECT * FROM questions WHERE task_id=? AND asked_at>? ORDER BY asked_at`, taskId, sinceTs);
  const messages = db.all(`SELECT * FROM messages WHERE task_id=? AND received_at>? AND kind<>'answer' ORDER BY received_at`, taskId, sinceTs);
  const breaches = byAction('limit_breached').map((e) => ({ key: e.payload.key, human: e.payload.human, onHit: e.payload.on_hit ?? 'gate' }));
  // 超时链：审计的 target 是问题 id，不在上面那条按节点/任务取的查询里，单独取。
  // "超时 → 默认动作 → **下次汇报中标注**"：标注就是这里。
  const timeouts = db.all(`SELECT ts, action, target_id, payload FROM audit_log
                           WHERE action IN ('question_defaulted','question_escalated','question_stuck') AND ts>?
                           AND target_id IN (SELECT id FROM questions WHERE task_id=?) ORDER BY id`, sinceTs, taskId)
    .map((e) => ({ ...e, payload: JSON.parse(e.payload || '{}') }))
    .map((e) => ({ action: e.action, questionId: e.target_id, level: e.payload.level, defaultAction: e.payload.defaultAction ?? null,
      text: head(db.one(`SELECT text FROM questions WHERE id=?`, e.target_id)?.text ?? '', 120) }));
  const constitution = db.one(`SELECT version, recorded_at FROM constitutions WHERE task_id=? AND superseded_at IS NULL
                               ORDER BY version DESC LIMIT 1`, taskId);
  const spend = db.one(`SELECT COALESCE(SUM(CASE WHEN ts>? THEN micro_usd ELSE 0 END),0) AS since,
                               COALESCE(SUM(micro_usd),0) AS total FROM usage_ledger WHERE task_id=?`, sinceTs, taskId);
  const counts = Object.fromEntries(db.all(`SELECT status, count(*) n FROM nodes WHERE task_id=? GROUP BY status`, taskId)
    .map((r) => [r.status, r.n]));

  // 自作主张（"人监督价值最高的部分，不可省"）：
  //   - 强制披露的假设（settled_by_me / own_artifact / 凭据不具体）
  //   - agent 在执行层做的决策（人做的、宪法层的不算"自作主张"）
  const selfDecided = {
    assumptions: assumptions.filter((a) => a.must_disclose === 1),
    decisions: decisions.filter((d) => d.actor_kind === 'agent'),
  };

  // 持久化纪律审计：这段窗口里 done 的节点，真相源里能不能重建它？
  const gaps = [];
  const lang = contentLang(db);
  for (const n of nodesDone) {
    const h = n.handoffId ? db.one(`SELECT id, narrative_ref FROM handoffs WHERE id=?`, n.handoffId) : null;
    if (!h) { gaps.push(tl(lang, '节点 {id}（{title}）记为 done，但库里没有它的交接记录 —— 只凭真相源重建不出这一步', { id: n.id, title: String(n.title) })); continue; }
    if (!h.narrative_ref || !existsSync(h.narrative_ref)) {
      gaps.push(tl(lang, '节点 {id}（{title}）的叙事文件不在：{ref} —— 上下文考古断线', { id: n.id, title: String(n.title), ref: h.narrative_ref ?? tl(lang, '（空）') }));
    }
  }
  for (const d of decisions) {
    if (!String(d.rationale ?? '').trim()) gaps.push(tl(lang, '决策 {id}（{summary}）没有理由 —— 只有结论的决策不可复盘', { id: d.id, summary: head(d.summary, 40) }));
  }

  // 现状 ≠ 历史：返工之后，窗口里同一个主题会有新旧两条假设并存，
  // 汇报若把它们混在一起列，签收的人就判断不出"文档到底改没改"，只能要求"把最终口径贴出来我再签"。
  // 所以现状单独取一份：**不按窗口取**，取此刻仍然有效的那些，按主题排。
  // 同一主题出现多条（例如修正后新口径 active、旧口径 conflicted 并存）照实列出来 ——
  // 那说明这个主题还没收敛，正是签收人该看见的事，不要替它挑一条。
  const assumptionsNow = db.all(`SELECT * FROM assumptions WHERE task_id=? AND superseded_at IS NULL
                                  AND status IN ('active','conflicted','confirmed') ORDER BY subject_key, recorded_at`, taskId);
  const supersededIn = new Set(assumptions.filter((a) => a.superseded_at || ['void', 'refuted'].includes(a.status)).map((a) => a.id));

  const facts = {
    nodes: nodesDone.map((n) => n.id), handoffs: nodesDone.map((n) => n.handoffId).filter(Boolean),
    decisions: decisions.map((d) => d.id), assumptions: assumptions.map((a) => a.id),
    revisions: revisions.map((r) => r.id), questions: questions.map((q) => q.id),
    messages: messages.map((m) => m.id), constitution: constitution?.version ?? null,
  };
  // 决定登记：签收人要能核对"本任务触及的范围里，还有哪些人拍过板的约定仍然有效"。
  // 这是给**人**看的，所以用召回式的 activeDecisions（宁可多列一条），不是给执行器的那份严格清单 ——
  // 它存在的意义正是**防规划器漏引**：规划器要是忘了把某条约定写进契约，这里还看得见。
  const registry = (() => {
    const pid = task?.project_id ?? null;
    const hints = scopeHints(`${constitution?.scope ?? ''}\n${constitution?.definition_of_done ?? ''}`);
    try { return activeDecisions(db, { projectId: pid, taskId: pid ? null : taskId, scope: hints }); } catch { return []; }
  })();

  // 本任务与同项目各任务此刻的状态（给"完成没完成"一个唯一的依据）
  const standing = task?.project_id
    ? db.all(`SELECT id, title, status, merged_at, project_order FROM tasks WHERE project_id=? ORDER BY project_order, created_at`, task.project_id)
    : task ? [{ id: task.id, title: task.title, status: task.status, merged_at: task.merged_at ?? null, project_order: null }] : [];

  return { task, sinceTs, nodesDone, nodeTrouble, decisions, assumptions, revisions, questions, messages, timeouts,
    breaches, constitution, constitutionChanged: (constitution?.recorded_at ?? 0) > sinceTs,
    spend, counts, selfDecided, gaps, facts, assumptionsNow, supersededIn, registry, standing };
}

/**
 * 分类器判定过的消息，在汇报里必须看得见。
 *
 * `kind_source` / `urgency_source` 记的是**这一处判断是谁做的**。只要有哪一处是
 * `classifier`，这条消息里就有一处是系统替人拍的板 —— 人得能在汇报里认出它来
 * （认得出，才谈得上改口）。人显式给的消息**一个标都不带**：`explicit` 与
 * `classifier` 的差别要在这里显形，不能被一句"（correction）"抹平。
 *
 * 标注只看这两列，不看消息从哪条路径写进来 —— 谁判的就写谁，这是这两列存在的全部意义。
 */
export const CLASSIFIER_MARK = '[分类器判定]';

/** 该行前缀标注；没有就是空串（人显式给的消息，渲染结果与从前逐字相同）。 */
export function classifierTag(m, lang = 'zh') {
  const which = [];
  if (m.kind_source === 'classifier') which.push(tl(lang, '类别'));
  if (m.urgency_source === 'classifier') which.push(tl(lang, '紧急度'));
  // 与 CLASSIFIER_MARK 同一个标（中文逐字相同），按内容语言写
  return which.length ? tl(lang, '[分类器判定]（{which}） ', { which: which.join('+') }) : '';
}

/**
 * 事实的确定性渲染 —— 给模型看的输入，也是模板回退时给人看的正文。
 * **分两段：现状在前、历史在后**。返工之后新旧口径混排，看的人判断不出"到底改成什么样了"。
 */
export function renderFacts(f, lang = 'zh') {
  const L = [];
  L.push(tl(lang, '## 现状（此刻的口径。下面"历史"一节是过程，两者不要混着读）'));
  if ((f.standing ?? []).length) {
    L.push(tl(lang, '任务状态（做没做完只以这一行为准）：{list}', { list: f.standing.map((t) => tl(lang, '{order}「{title}」{self}{state}', {
      order: t.project_order ? `#${t.project_order}` : '', title: head(t.title, 40),
      self: t.id === f.task?.id ? tl(lang, '（本任务）') : '', state: stateOf(t, lang) }).trim()).join(tl(lang, '；')) }));
  }
  L.push(tl(lang, '节点 {counts}｜本窗口花费 {since}，累计 {total}｜宪法 v{version}{changed}', { counts: JSON.stringify(f.counts), since: fmtUsd(f.spend.since), total: fmtUsd(f.spend.total),
    version: f.constitution?.version ?? '?', changed: f.constitutionChanged ? tl(lang, '（**本窗口内升版**）') : '' }));
  const now_ = f.assumptionsNow ?? [];
  if (now_.length) {
    const dup = new Set(now_.map((a) => a.subject_key).filter((k, i, xs) => xs.indexOf(k) !== i));
    L.push(tl(lang, '### 现行假设（此刻仍然有效的，按主题）'));
    for (const a of now_) {
      L.push(`- [${a.status}${a.must_disclose ? tl(lang, '，强制披露') : ''}] `
        + tl(lang, '{subject}：{statement}（对着 {against} 查证）', { subject: String(a.subject_key), statement: head(a.statement, 100), against: a.verified_against ?? '—' }));
    }
    if (dup.size) L.push(tl(lang, '⚠ 同一主题有多条并存：{list} —— 这个口径还没收敛，签收前先看清楚按哪条为准', { list: [...dup].join(tl(lang, '、')) }));
  }
  // 本任务范围内仍然有效的、人拍过板的约定。列在这里是为了**防规划器漏引**：
  // 契约里该写进去而没写的，签收人在这儿还能看见，对不上就打回。
  if ((f.registry ?? []).length) {
    L.push(tl(lang, '### 本任务范围内仍然有效的约定（人拍过板的，共 {n} 条）', { n: f.registry.length }));
    for (const d of f.registry) L.push(`- 〔${DEC_SOURCE[d.source_kind] ?? d.source_kind}〕${d.subject}：${head(d.statement, 120)}`);
    L.push(tl(lang, '产物与其中任何一条对不上，就是该打回的事；要改其中一条，走计划变更。约定是人批准过的**要求**，不代表已经做到 —— 做没做完只看上面的任务状态。'));
  }
  L.push(tl(lang, '## 历史（自上次汇报以来发生的过程；下面这些**不代表现状**）'));
  if (f.nodesDone.length) {
    L.push(tl(lang, '### 本窗口完成的节点'));
    for (const n of f.nodesDone) L.push(`- ${tl(lang, '{title}（{id}）产物：{artifacts}', { title: String(n.title), id: n.id, artifacts: n.artifacts.join(', ') || tl(lang, '（无）') })}`);
  }
  if (f.nodeTrouble.length) {
    L.push(tl(lang, '### 节点异常'));
    for (const t of f.nodeTrouble) L.push(`- [${t.action}] ${t.title ?? t.id}：${t.why}`);
  }
  if (f.messages.length) {
    L.push(tl(lang, '### 人发来的'));
    for (const m of f.messages) L.push(`- ${classifierTag(m, lang)}${tl(lang, '（{kind}）', { kind: String(m.kind) })}${head(m.body, 140)}`);
  }
  if (f.revisions.length) {
    L.push(tl(lang, '### 计划修正'));
    for (const r of f.revisions) L.push(`- ${r.id} ${r.status}${r.gate ? tl(lang, '｜门：{gate}', { gate: head(r.gate, 80) }) : tl(lang, '｜门未触发，自动生效')}`);
  }
  if (f.questions.length) {
    L.push(tl(lang, '### 问题'));
    for (const q of f.questions) L.push(`- ${tl(lang, 'Ⅲ{level} 级（{source}）{status}：{text}', { level: String(q.level), source: String(q.level_source), status: String(q.status), text: head(q.text, 120) })}`);
  }
  if (f.breaches.length) {
    L.push(tl(lang, '### 触顶'));
    for (const b of f.breaches) L.push(`- ${b.key}（${b.onHit}）：${b.human}`);
  }
  if (f.decisions.length) {
    L.push(tl(lang, '### 本窗口的决策（全部）'));
    for (const d of f.decisions) L.push(`- [${d.actor_kind}/${d.layer}] ${head(d.summary, 100)}`);
  }
  if (f.assumptions.length) {
    // 已被取代的照列 —— 但要标出来。上面"现行假设"才是此刻的口径。
    L.push(tl(lang, '### 本窗口的假设变动（全部，含已被取代的）'));
    for (const a of f.assumptions) {
      L.push(`- [${a.status}${a.must_disclose ? tl(lang, '，强制披露') : ''}${f.supersededIn?.has(a.id) ? tl(lang, '，**已被取代，不是现状**') : ''}]`
        + ` ${tl(lang, '{subject}：{statement}（对着 {against} 查证）', { subject: String(a.subject_key), statement: head(a.statement, 100), against: a.verified_against ?? '—' })}`);
    }
  }
  return L.join('\n');
}

/**
 * **不可省的那一节**，由代码生成，不经模型。
 * 自作主张 = 强制披露的假设 + agent 在执行层做的决策。
 */
export function renderSelfDecided(f, lang = 'zh') {
  const L = [tl(lang, '## 自作主张的决定与假设（代码生成，不由模型取舍）')];
  const { assumptions, decisions } = f.selfDecided;
  const timeouts = f.timeouts ?? [];
  if (!assumptions.length && !decisions.length && !timeouts.length) { L.push(tl(lang, '（本窗口没有）')); return L.join('\n'); }
  // 超时走默认：没有人答，系统按 agent 登记的默认动作放行了 —— 这是最该让人看见的一种"自作主张"
  for (const t of timeouts) {
    if (t.action === 'question_defaulted') L.push(tl(lang, '- **超时走默认**（{level} 级，无人答复）｜{text}\n  执行了：{action}', { level: t.level === 1 ? 'Ⅰ' : 'Ⅱ', text: String(t.text), action: head(t.defaultAction ?? '', 160) }));
    else if (t.action === 'question_escalated') L.push(tl(lang, '- 超时升级（Ⅱ 级，第一段无人答复，再等一段后退默认）｜{text}', { text: String(t.text) }));
    else L.push(tl(lang, '- 超时后仍挂起（升级后无人答，且没有默认可退）｜{text}', { text: String(t.text) }));
  }
  for (const a of assumptions) {
    const tag = a.verified_against === 'settled_by_me' ? tl(lang, '**替人做了个决定**')
      : a.verified_against === 'own_artifact' ? tl(lang, '循环论证（对着自己的产物验）')
        : tl(lang, '凭据不具体');
    L.push(tl(lang, '- {tag}｜{subject}：{statement}', { tag, subject: String(a.subject_key), statement: head(a.statement, 160) })
      + `${a.verification ? `\n  ${tl(lang, '凭据：{v}', { v: head(a.verification, 120) })}` : ''}`);
  }
  for (const d of decisions) {
    L.push(tl(lang, '- 决策｜{summary}\n  理由：{rationale}', { summary: head(d.summary, 100), rationale: head(d.rationale, 160) }));
  }
  return L.join('\n');
}

const SUBMIT_REPORT = {
  name: 'submit_report',
  description: '提交汇报。你只看得到真相源里的记录，请只描述记录里有的事，不要推测。',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '一句话：这段时间发生了什么、现在在哪。给忙人看的。' },
      current_state: { type: 'string', description: '**此刻的口径是什么样**：产物现在是什么行为、哪些约定现在生效。只看"现状"那一节，不要写过程，不要把已被取代的旧口径和现行口径并列。返工过的地方尤其要给出最终说法，而不是"改了两处"。' },
      next_steps: { type: 'string', description: '接下来会做什么（按记录推断，不承诺记录里没有的事）' },
      uncertainties: { type: 'string', description: '当前不确定 / 悬而未决的点' },
    },
    required: ['summary', 'current_state', 'next_steps', 'uncertainties'],
  },
};

const SYSTEM = `你是一个长期运行的自主 agent 的**汇报生成器**。你不是执行者：你没有它的记忆，
只有真相源里的记录（决策日志、交接记录、假设登记表、问题、修正、账本）。

你的活是把"自上次汇报以来发生了什么"写成一份给人看的简报，像一份好的 PR description：
一句话摘要、此刻的口径、下一步、不确定点。**只描述记录里有的事**。记录里说不清的地方，就说记录里说不清。

**现状与历史分开写。** 输入里"现状"一节是此刻的口径，"历史"一节是过程。返工过的地方，读汇报的人
要判断的是"最后改成什么样了"，不是"改过几次"——把这两件事混在一句话里，人就只能去翻产物自己看。
现行假设里同一主题有多条并存时，照实说"还没收敛"，不要自己挑一条当结论。

**做没做完只看"任务状态"那一行。** 契约批准了、约定登记了，都不等于做完；一个任务不是「已合并」或「已做完」，
就不要说它完成了 —— 看汇报的人会据此判断要不要继续等、要不要插手。

"自作主张的决定与假设"那一节**不用你写** —— 它由代码从登记表直接生成，你写不写都在。`;

/**
 * 生成并落库一份汇报。**永远返回一份**：模型挂了就退回模板（generated_by='template'）。
 *
 * @param {object|null} client  null = 不调模型（预算触顶等"钱花光了还要说出口"的场合）
 */
export async function makeReport(db, { taskId, trigger, triggerRef = null, client = null, tier = 'light' }) {
  const prev = db.one(`SELECT id, created_at FROM reports WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`, taskId);
  // 终版汇报（task_done / verify_failed）覆盖**整个任务**，不是上一份汇报之后的几秒钟：
  // 它是签收与 PR 正文的取材口（"完成声明 + 终版报告"）。只取上一份之后的话，PR 正文会是
  // "本窗口只有一行状态" —— 因为 node_done 汇报刚写完，task_done 的窗口只剩 0.3 秒。
  const taskCreated = db.one(`SELECT created_at FROM tasks WHERE id=?`, taskId)?.created_at ?? 0;
  const sinceTs = (trigger === 'task_done' || trigger === 'verify_failed') ? taskCreated : (prev?.created_at ?? taskCreated);
  const f = gatherSince(db, taskId, sinceTs);
  const lang = contentLang(db);
  const facts = renderFacts(f, lang);
  const selfDecided = renderSelfDecided(f, lang);

  let prose = null, generatedBy = 'template';
  const gaps = [...f.gaps];
  if (client) {
    try {
      let out = null;
      await runToolLoop(client, {
        tier, system: withOutputLang(SYSTEM, contentLang(db)), tools: [SUBMIT_REPORT], maxTokens: 2000,
        messages: [{ role: 'user', content: [{ type: 'text',
          text: `触发：${trigger}${triggerRef ? `（${triggerRef}）` : ''}\n\n${facts}\n\n现在调用 submit_report。` }] }],
      }, {
        submit_report: async (args) => { out = args; return '已收到。不要再调用任何工具。'; },
      }, { maxIterations: 2, shouldStop: () => out !== null });
      if (out?.summary?.trim()) { prose = out; generatedBy = 'llm'; }
      else gaps.push(tl(lang, '汇报生成器没有产出摘要，已退回模板'));
    } catch (e) {
      // 厂商挂了 / 预算被闸门掐 —— 汇报仍然要产生。这不是吞异常：原因写进 gaps。
      gaps.push(tl(lang, '汇报生成器调用失败（{error}），已退回模板', { error: head(e.message, 100) }));
    }
  }

  let summary = prose?.summary?.trim()
    ?? tl(lang, '[{trigger}] 节点 {counts}，本窗口花费 {since}', { trigger: String(trigger), counts: JSON.stringify(f.counts), since: fmtUsd(f.spend.since) })
      + `${f.nodesDone.length ? tl(lang, '，完成 {list}', { list: f.nodesDone.map((n) => n.title).join(tl(lang, '、')) }) : ''}`;
  // 摘要在没做完的任务旁边说了"完成"：前面补一句此刻的状态，**只陈述、不判对错**。
  // 不写"下面说它'完成'不对"：那样容易误报 ——「完成了 T2 的验收脚本（2 个节点里的第 1 个）」
  // 与「T2 完成了」字面上分不开。补状态总是对的；替模型判"说错了"则不一定。
  const unfinished = prose ? falseDoneClaims(summary, f.standing) : [];
  if (unfinished.length) {
    const said = (t) => labelsOf(t).find((l) => summary.includes(l)) ?? labelsOf(t)[0];   // 用摘要里的叫法，人对得上
    summary = `${tl(lang, '〔此刻：{list}〕', { list: unfinished.map((t) => tl(lang, '{name}{state}', { name: said(t), state: stateOf(t, lang) })).join(tl(lang, '、')) })}${summary}`;
    gaps.push(tl(lang, '摘要在 {names} 旁边提到"完成"，而它此刻{states} —— 已在摘要前补上状态', { names: unfinished.map(said).join(tl(lang, '、')), states: unfinished.map((t) => tl(lang, '「{state}」', { state: stateOf(t, lang) })).join(tl(lang, '、')) }));
  }
  const body = [
    `# ${tl(lang, '汇报')} · ${trigger}${triggerRef ? ` · ${triggerRef}` : ''}`,
    `**${summary}**`,
    prose ? [prose.current_state?.trim() ? `## ${tl(lang, '此刻的口径')}\n${prose.current_state}` : '',
      `## ${tl(lang, '下一步')}\n${prose.next_steps}`, `## ${tl(lang, '不确定点')}\n${prose.uncertainties}`].filter(Boolean).join('\n\n')
      : `## ${tl(lang, '下一步 / 不确定点')}\n${tl(lang, '（模板汇报，未经模型生成）')}`,
    selfDecided,
    `## ${tl(lang, '自上次汇报以来（真相源 diff）')}\n${facts}`,
    gaps.length ? `## ${tl(lang, '⚠️ 持久化纪律审计')}\n${gaps.map((g) => `- ${g}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const id = newId('rp');
  const t = now();
  db.tx(() => {
    db.run(`INSERT INTO reports (id,task_id,trigger,trigger_ref,since_report_id,since_ts,summary,body,facts,
              generated_by,gaps,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, taskId, trigger, triggerRef, prev?.id ?? null, sinceTs, summary, body,
    JSON.stringify(f.facts), generatedBy, JSON.stringify(gaps), t);
    // 出处：这份汇报因为哪个事件而存在；它读了哪些记录在 facts 里。
    if (triggerRef) insertEdge(db, id, triggerRef, 'derived_from', t);
    audit(db, { actorKind: 'agent', actorId: 'reporter', action: 'report_generated',
      targetType: 'task', targetId: taskId,
      payload: { reportId: id, trigger, triggerRef, generatedBy, gaps: gaps.length,
        selfDecided: f.selfDecided.assumptions.length + f.selfDecided.decisions.length, pid: process.pid } });
  });
  return { id, taskId, trigger, triggerRef, summary, body, generatedBy, gaps, facts: f.facts,
    selfDecidedCount: f.selfDecided.assumptions.length + f.selfDecided.decisions.length };
}

/** 未读汇报（或全部）。 */
export const listReports = (db, taskId, { all = false } = {}) => db.all(
  `SELECT id, trigger, trigger_ref, summary, generated_by, gaps, read_at, created_at FROM reports
    WHERE task_id=? ${all ? '' : 'AND read_at IS NULL'} ORDER BY created_at, rowid`, taskId);

export const markReportsRead = (db, ids) => {
  const t = now();
  for (const id of ids) db.run(`UPDATE reports SET read_at=? WHERE id=? AND read_at IS NULL`, t, id);
};
