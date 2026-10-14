// 独立验收员 —— 第四个 LLM 子程序。
//
// **仅读交接记录与产物，不读执行器记忆**；schema 校验 + 沙箱测试门禁
// 为代码层前置条件。验收员读假设表并**打回取舍型假设** ——
// settled_by_me 是"我替人做了个决定"，执行器自己不会打回自己。
//
// 它为什么必须是新鲜上下文：执行器交接时说"验收标准已满足"，那是它的记忆在辩护。
// 验收员拿到的是交接记录 + 工作区里真实的文件 + 节点的规格与验收标准，仅此而已。
// 它能读文件、能 grep，**不能写、不能跑命令** —— 验收不是再做一遍。
//
// 出口只有一个 submit_verdict。没给结论 = **打回**，不是放行：验收员挂了不能变成
// 免检通道（与"schema 校验失败就拒"同一条纪律）。

import { makeCompactor, fixedEstimate } from '../context/compact.mjs';
import { compactThresholdOf } from '../core/limits.mjs';
import { LLM_ROLES } from '../llm/canonical.mjs';
import { withOutputLang, contentLang } from '../i18n/index.mjs';
import { runToolLoop } from '../llm/client.mjs';
import { audit } from '../db/db.mjs';
import { TOOLS, makeHandlers } from './executor.mjs';
import { VERIFIER_CATEGORIES } from '../core/diagnose.mjs';
import { describeTestChanges } from '../core/test-guard.mjs';
import { uiChecksOf } from '../db/nodes.mjs';
import { liveTools, liveHandlers } from './live-tools.mjs';

const READ_ONLY = new Set(['list_dir', 'read_file', 'grep']);

const SUBMIT_VERDICT = {
  name: 'submit_verdict',
  description: '给出验收结论。只有这一个出口。打回要逐条列缺陷，每条指向具体的验收标准或文件。',
  parameters: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['accept', 'reject'] },
      defects: { type: 'array', items: { type: 'object', properties: {
        category: { type: 'string', enum: VERIFIER_CATEGORIES,
          description: 'acceptance = 某条验收标准没满足；spec = 偏离规格 / 契约 / 约束；decision = 把该问人的取舍自己定了；test = 测试缺失、期望值没出处或测试被削弱；scope = 改了这一步不该动的东西；quality = 其他实质问题' },
        summary: { type: 'string', description: '一句话说清哪里不对、应该是什么样。人会直接读这句，要能单独看懂' },
        location: { type: 'string', description: '出问题的文件（可带 :行号），或验收标准 / 规格条目的原文片段；说不出具体位置就留空' } },
        required: ['category', 'summary'] },
        description: 'reject 时必填：每条一个缺陷。同一个问题只列一次；下一轮还没改好的，用同样的 location 再列，便于判断改没改。' },
      assumption_pushbacks: { type: 'array', items: { type: 'object', properties: {
        subject_key: { type: 'string' }, why: { type: 'string' } }, required: ['subject_key', 'why'] },
      description: '交接记录里 settled_by_me 的假设中，你认为**不该由 agent 替人拍板**的那些。给了就算打回理由之一。' },
      evidence_checked: { type: 'array', items: { type: 'string' },
        description: '你实际核对过的东西（文件路径 / 命令输出 / 规格条目），供人复盘你看了什么。' },
    },
    required: ['verdict', 'evidence_checked'],
  },
};

// 界面条目逐条的结果。只在节点有界面条目时加进 submit_verdict
const UI_RESULTS = ['pass', 'fail', 'not_checked'];
const UI_CHECKS_PROP = { type: 'array', items: { type: 'object', properties: {
  n: { type: 'integer', description: '界面条目的编号' },
  result: { type: 'string', enum: UI_RESULTS, description: 'pass = 在页面上看到了；fail = 页面上不对；not_checked = 没法点验' },
  evidence: { type: 'string', description: '在哪页、做了什么、看到了什么（fail / not_checked 写清为什么）' },
  screens: { type: 'array', items: { type: 'integer' }, description: '能说明这条结论的画面编号（工具结果里的 [画面 #n]），至多 3 个 —— 签收的人看的就是这几张' } },
  required: ['n', 'result', 'evidence'] },
  description: '界面条目逐条的结果，每条一项。任何一条 fail 都是打回。' };
const submitVerdictTool = (withUi) => (withUi
  ? { ...SUBMIT_VERDICT, parameters: { ...SUBMIT_VERDICT.parameters, properties: { ...SUBMIT_VERDICT.parameters.properties, ui_checks: UI_CHECKS_PROP },
    required: [...SUBMIT_VERDICT.parameters.required, 'ui_checks'] } }
  : SUBMIT_VERDICT);

const SYSTEM = `你是一个长期运行的自主 agent 的**独立验收员**。执行器刚提交了一份交接记录，
声称节点做完了。你要判断它**是不是真的做完了**。

你没有执行器的记忆，也不该想要 —— 它的过程记录只会替它辩护。你有的是：
节点的规格与验收标准、交接记录、工作区里真实的文件（可读、可 grep，不可写、不可跑）。

逐条核对**本节点的验收标准**（加上约束）。"看起来合理"不算满足，要在产物里找到对应的东西。
任务级完成定义不是本节点的判据 —— 那是全部节点完成后任务级验收的事，别拿它打回单个节点。
交接记录里的 acceptance_evidence 是**它说的**，不是证据 —— 去文件里看。

新写的测试里的**期望值要有出处**：能在节点规格 / 验收标准 / 约束里找到，或交接记录明确引用了规格原文。
契约里带〔规格〕标记的规则附有规格原文，那是最高依据；带〔规划器假设〕的规则是人批准过的，按字面判，不因它"不像规格"打回。
只从实现本身推出来的期望值（"我跑了一下得到 X，所以断言 X"）不算验证 —— 那是让实现给自己背书；
遇到这种情况打回，要求把期望值对到规格上。

"测试改动"一节是系统机械比对出来的（删了测试文件、加了跳过、用例或断言变少、改了期望值）。它只是信号，不是结论：
功能变了、测试跟着改是正常的。逐条核对：改动能在规格 / 验收标准 / 人的裁定里找到依据就放过；
找不到依据、看起来是为了让实现通过而把测试改松了，以 test 类缺陷打回，写清是哪个文件、哪处改动。

"人的裁定"一节是人经认证通道对本节点问题的答复，具指令效力：人明确放行的事，不再按约束的字面判违规。

假设登记表里 verified_against=settled_by_me 的条目是"agent 替人做了个决定"。
若那个决定是人该拍板的取舍（改了接口形状、放弃了某条要求、选了一条有代价的路），
放进 assumption_pushbacks 打回；若只是无关紧要的实现细节，放过。

只调用 submit_verdict 一次。`;

/**
 * @returns {{verdict:'accept'|'reject', reasons:string[], defects:object[], noVerdict:boolean, pushbacks:object[], evidence:string[], llmCalls:number, stopped?:string}}
 */
/** 验收员的轮数。每条界面条目大约要两轮（点 + 看 / 刷新），读产物另要十来轮。
 *  按界面条目数量增加轮数，避免后面的条目因轮数不足而无法检查。 */
export function verifierRounds({ live, uiCount }) {
  return live ? Math.min(30, Math.max(16, 10 + 2 * uiCount)) : 10;
}

export async function verifyHandoff(db, {
  client, taskId, nodeId, workspace, exec, args, changed = null, testChanges = [], tier = LLM_ROLES.verifier, maxIterations = null, picked = null,
  live = null, liveWhy = null, vision = false,
}) {
  const node = db.one(`SELECT * FROM nodes WHERE id=?`, nodeId);
  // 界面条目与运行中的应用。live = 这次验收能起的应用会话（没有时 liveWhy 说为什么）；点验要来回操作，轮数给多一些
  const ui = uiChecksOf(node);
  maxIterations ??= verifierRounds({ live: !!live, uiCount: ui.length });
  const c = db.one(`SELECT goal, definition_of_done, constraints FROM constitutions WHERE task_id=?
                    AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);
  const files = changed ? [...changed].slice(0, 12) : (args.artifacts ?? []).map((a) => a.path).slice(0, 12);
  // 人的裁定：**本任务所有**已答问题里经认证通道的答复（超时默认答复是系统写的，不算人拍板）。
  // 例：执行器问"改一条既有测试断言行不行"，人答"行，只这一条"，验收员若看不见答复，
  // 就会按约束字面"既有测试一行不许改"打回 —— 约束的字面压过了人的明确决定。裁定必须进验收员的眼睛。
  // 范围是任务不是节点：人对某节点放行的改动会留在工作区里，后面的节点被验收时
  // 改动集里仍有它；裁定本质上是对任务约束的一次修正，对同一任务的每个节点都成立。
  const rulings = db.all(`SELECT q.text, m.body FROM questions q
      JOIN edges e ON e.to_id=q.id AND e.relation='answers' AND e.superseded_at IS NULL
      JOIN messages m ON m.id=e.from_id
     WHERE q.task_id=? AND q.status='answered' AND m.trust_label='user-authenticated'
     ORDER BY q.asked_at`, taskId);

  const user = `# 任务目标
${c?.goal ?? ''}

## 任务级完成定义（只供理解全局；**不是本节点的判据** —— 它由任务级验收在全部节点完成后判，别拿它打回单个节点）
${c?.definition_of_done ?? ''}

## 约束
${JSON.parse(c?.constraints || '[]').map((x) => `- ${x}`).join('\n') || '（无）'}

## 人的裁定（经认证通道，具指令效力）
${rulings.length ? rulings.map((r) => `- 问：${String(r.text).replace(/\s+/g, ' ').slice(0, 400)}\n  答：${String(r.body).replace(/\s+/g, ' ').slice(0, 600)}`).join('\n') : '（无）'}
${rulings.length ? '人明确放行的事项不再按约束字面判违规；裁定没覆盖的部分约束照旧。' : ''}

# 节点
**${node.title}**
规格：${node.spec}
**验收标准**：${node.acceptance}

# 执行器提交的交接记录
产物：${(args.artifacts ?? []).map((a) => `${a.path}（${a.kind}）`).join('、') || '（无）'}
接口契约：${args.interface_contract ?? ''}
它声称的验收证据：${args.acceptance_evidence ?? '（无）'}
已知问题：${JSON.stringify(args.known_issues ?? [])}
关键决策：${(args.key_decisions ?? []).map((d) => `${d.summary} —— ${d.rationale}`).join('；') || '（无）'}
假设：${(args.assumptions ?? []).map((a) => `[${a.verified_against ?? '?'}] ${a.subject_key}：${a.statement}`).join('\n　　') || '（无）'}

# 本节点改动过的文件（相对开跑时的基线）
${files.map((p) => `- ${p}`).join('\n') || '（工作区不是 git，无法列改动；按产物清单看）'}

# 测试改动（系统机械比对，相对本节点开跑时）
${testChanges?.length ? describeTestChanges(testChanges, 'zh') : '（没有测试被删、跳过、变少或改期望值）'}

${liveSection(ui, live, liveWhy)}
用 read_file / grep / list_dir 核对${live ? '，界面用 open_page 等工具在运行中的应用上看' : ''}，然后调用 submit_verdict。`;

  const trace = [];
  const all = makeHandlers(exec, workspace, trace);
  const handlers = { ...Object.fromEntries(Object.entries(all).filter(([k]) => READ_ONLY.has(k))), ...(live ? liveHandlers(live) : {}) };
  let out = null, nagged = false;
  handlers.submit_verdict = async (v) => {
    // 界面条目缺了结果，或应用能起却一次都没打开过：提醒一次（与 "做不到"出口必填项同一个做法），第二次照收、缺的记成"没点验"
    const given = new Set((Array.isArray(v?.ui_checks) ? v.ui_checks : []).map((x) => Number(x?.n)));
    const missing = ui.map((_, i) => i + 1).filter((n) => !given.has(n));
    const neverOpened = live && ui.length && live.actions === 0 && live.state !== 'failed';
    if (!nagged && (missing.length || neverOpened)) {
      nagged = true;
      return [missing.length ? `界面条目第 ${missing.join('、')} 条没给结果：ui_checks 里每条都要有一项（pass / fail / not_checked，带 evidence）。` : '',
        neverOpened ? '应用还一次都没打开过：界面条目要在运行中的页面上点验（open_page），读代码推出来的不算。' : '',
        '补上再调用 submit_verdict；确实点验不了的标 not_checked 并写清为什么。'].filter(Boolean).join('\n');
    }
    out = v; return '结论已记录。不要再调用任何工具。';
  };

  // 分两段跑，结论阶段撤掉只读工具，避免验收员继续读文件而不给结论：
  // 前 maxIterations-1 轮带只读工具；没结论就用同一份 messages 再起 1 轮，
  // **工具只剩 submit_verdict**，它想读也没得读。这一轮仍不给结论才算打回。
  const canon = { role: 'verifier', tier, system: withOutputLang(SYSTEM, contentLang(db)), maxTokens: 4000, effort: 'medium' };
  const readRounds = Math.max(0, maxIterations - 1);
  const tools = [...TOOLS.filter((t) => READ_ONLY.has(t.name)), ...(live ? liveTools({ vision }) : []), submitVerdictTool(ui.length > 0)];
  // 上下文整理：验收员只做第 1 级（把读过的大文件、页面换成占位行，要时重读），不调模型写简报 —— 它只跑十来轮，判断要看原文
  let window = null;
  try { window = client.catalog?.[client.entryFor(tier, 'verifier').key]?.contextWindow ?? null; } catch { window = null; }
  const compactAt = compactThresholdOf(db, taskId, { contextWindow: window }).at;
  const compactor = compactAt ? makeCompactor(db, { client, taskId, nodeId, tier, role: 'verifier', workspace, at: compactAt, levels: [1],
    fixed: fixedEstimate(canon.system, tools), maxIterations: readRounds }) : null;
  const vStart = Date.now();   // 耗时埋点（perf-g4）：这次验收里模型与工具各花了多久
  const loop = await runToolLoop(client, {
    ...canon, tools,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  }, handlers, {
    maxIterations: readRounds, shouldStop: () => out !== null, compactor,
    iterationNote: (i, max) => {
      const left = max - i - 1;
      if (left > 3 || left < 0) return null;
      return left === 0
        ? `[系统] 只读工具到此为止。下一轮只剩 submit_verdict 一个工具 —— 现在把结论想好；核不完的写进 defects 说清哪条没核到。`
        : `[系统] 还剩 ${left} 轮可读文件。看得差不多了就给结论。`;
    },
  });
  let llmCalls = loop.trace?.length ?? 0;
  let lastTurn = null;
  let stopped = loop.stopped;
  if (out === null && !String(stopped).startsWith('aborted')) {
    const messages = loop.messages;
    // 循环只在"工具调用 + 结果"成对时回填历史；模型若以纯文本收尾，那一轮不在 messages 里。
    // 补回它，再接一条 user 说明工具已收窄 —— 紧跟 tool_results 之后不能再发 user 文本，
    // 但这种情况下末尾必是 assistant/user 之一，不会撞那条形状限制。
    if (messages[messages.length - 1]?.role !== 'tool_results') {
      if (loop.resp?.content?.length) messages.push({ role: 'assistant', content: loop.resp.content });
      messages.push({ role: 'user', content: [{ type: 'text', text: '[系统] 只读工具已撤。现在只有 submit_verdict 一个工具，调用它给结论。' }] });
    }
    // 收窄段保留两轮，让模型在调用未提供的工具后仍有机会读到报错并提交结论。
    // 第二轮它能看见那条报错。到底在干什么，记进审计（lastTurn）。
    const final = await runToolLoop(client, { ...canon, tools: [submitVerdictTool(ui.length > 0)], messages },
      { submit_verdict: handlers.submit_verdict }, { maxIterations: 2, shouldStop: () => out !== null });
    llmCalls += final.trace?.length ?? 0;
    stopped = final.stopped;
    // 没结论时把最后一轮的响应留进审计 —— 不然只知道"没给"，不知道它在干什么
    if (out === null) lastTurn = JSON.stringify(final.trace?.at(-1)?.content ?? final.resp?.content ?? null).slice(0, 800);
  }

  const pushbacks = out?.assumption_pushbacks ?? [];
  let verdict = out?.verdict === 'accept' && !pushbacks.length ? 'accept' : 'reject';
  // 结构化缺陷：诊断层按类别 + 位置判"同一条缺陷还在不在"。旧格式（只给 reasons 文字）照收，类别记 quality
  const defects = (Array.isArray(out?.defects) ? out.defects : [])
    .filter((d) => String(d?.summary ?? '').trim())
    .map((d) => ({ category: VERIFIER_CATEGORIES.includes(d.category) ? d.category : 'quality', summary: String(d.summary).trim(), locations: d.location ? [String(d.location).trim()] : [] }));
  for (const r of out?.reasons ?? []) defects.push({ category: 'quality', summary: String(r), locations: [] });
  const reasons = defects.map((d) => (d.locations.length ? `${d.summary}（${d.locations[0]}）` : d.summary));
  if (out?.verdict === 'accept' && pushbacks.length) {
    reasons.push('验收员放行了产物，但打回了下列假设 —— 它们是人该拍板的取舍，不该由 agent 替人定');
  }
  for (const p of pushbacks) { reasons.push(`假设 ${p.subject_key}：${p.why}`); defects.push({ category: 'assumption', summary: p.why, locations: [p.subject_key] }); }
  // 界面条目逐条结果。验收员没给的记成"没点验"（by: system）。任何一条 fail 都打回 —— 说页面上不对、结论却放行，按打回算；
  // 缺陷位置写"界面条目 n"，诊断层按它判同一条缺陷还在不在
  const uiChecks = ui.map((item, i) => {
    const r = (Array.isArray(out?.ui_checks) ? out.ui_checks : []).find((x) => Number(x?.n) === i + 1);
    const result = UI_RESULTS.includes(r?.result) ? r.result : 'not_checked';
    // 引用的画面（只认这次会话真存下来的），签收的人在看板上看这几张
    const screens = live?.cite ? live.cite(r?.screens) : [];
    return { n: i + 1, item, result, evidence: String(r?.evidence ?? '').trim() || (live ? (live.state === 'failed' ? live.why : null) : liveWhy), by: r ? 'verifier' : 'system',
      ...(screens.length ? { screens } : {}) };
  });
  for (const c of uiChecks.filter((x) => x.result === 'fail')) {
    if (verdict === 'accept') verdict = 'reject';
    const s = `界面条目没过：${c.item}${c.evidence ? ` —— ${c.evidence}` : ''}`;
    reasons.push(s); defects.push({ category: 'acceptance', summary: s, locations: [`界面条目 ${c.n}`] });
  }
  // 没结论：验收员自己的问题，不是这份改动的（诊断层环境问题）—— 照样不放行，但标出来，执行器那边不算一轮缺陷
  const noVerdict = !out;
  if (!out) { verdict = 'reject'; reasons.push(`验收员没有给出结论（${stopped}，最后一轮已只剩 submit_verdict）—— 没结论不等于通过`); }
  if (verdict === 'reject' && !reasons.length) { reasons.push('验收员打回但没给理由'); defects.push({ category: 'quality', summary: reasons[0], locations: [] }); }

  audit(db, { actorKind: 'agent', actorId: 'verifier', action: 'handoff_verified',
    targetType: 'node', targetId: nodeId,
    payload: { verdict, reasons, defects, noVerdict, pushbacks, evidence: out?.evidence_checked ?? [],
      toolCalls: trace.length, llmCalls, stopped, lastTurn, pid: process.pid,
      // 这次验收的模型时间与工具时间（客户端里还没落账的那几笔；验收期间没有别的角色用这个客户端）
      timing: { modelMs: client.ledger.filter((e) => (e.startedAt ?? 0) >= vStart).reduce((s, e) => s + (e.durationMs ?? 0), 0),
        toolMs: (client.toolLog ?? []).filter((t) => t.role === 'verifier' && t.startedAt >= vStart).reduce((s, t) => s + t.durationMs, 0),
        wallMs: Date.now() - vStart },
      // 界面条目逐条结果；应用这次起没起来、点了几下、截了几张
      ...(ui.length || live ? { ui: { checks: uiChecks, live: live ? { state: live.state, why: live.why ?? null, actions: live.actions, shots: live.shots, vision, ...(live.key ? { screens: live.key } : {}) } : { state: 'none', why: liveWhy } } } : {}),
      // 这次验收用的哪个模型、为什么是它（档位 / 单独绑定 / 异厂商策略换的），与执行器是不是同一家
      ...(picked ? { model: picked } : {}) } });
  return { verdict, reasons, defects, noVerdict, pushbacks, evidence: out?.evidence_checked ?? [], llmCalls, stopped, uiChecks };
}

/** 给验收员的"界面条目 / 运行中的应用"一节 */
function liveSection(ui, live, liveWhy) {
  if (!ui.length && !live) return '';
  const list = ui.map((x, i) => `${i + 1}. ${x}`).join('\n');
  if (!ui.length) return `
# 运行中的应用
这一步改了界面。需要时可以用 open_page 等工具把应用打开看（第一次打开要等它起起来）。
`;
  return `
# 界面条目（必须在运行中的页面上逐条点验）
${list}

${live
    ? `用 open_page 打开应用，照条目去点、去填，看页面上的结果 —— 读代码推出来的不算点验。${live.keepDir ? '\n每次打开、点、填、选之后系统都存一张当时的画面（结果里的 [画面 #n]）。签收的人看不到运行中的页面，只看这些画面：ui_checks 每条在 screens 里填能说明结论的画面号（pass 填看得出结果的那张；排序、删除这类要对比才看得出的，连操作前的那张一起填；fail 填看到问题的那张）。' : ''}`
    : `应用这次起不来（${liveWhy ?? '原因不明'}），界面条目没法点验：都标 not_checked、evidence 照写原因，其余照常按产物判。`}
在 submit_verdict 的 ui_checks 里逐条给结果：pass（页面上看到了）/ fail（页面上不对，evidence 写看到了什么）/ not_checked（没法点验，写清为什么）。任何一条 fail 都是打回。
页面本身的毛病（报错、一直停在加载中、点了没反应）是 fail，不是 not_checked —— not_checked 只用于工具做不到或应用起不来；fail 的会交给执行器去改，not_checked 的不会。
`;
}

/**
 * 两个验收员会签：都通过才算过。有一个打回 → 打回，理由与缺陷合在一起（执行器照常逐条改）；
 * 没人打回但有一个没给出结论 → 按"没结论"处理（环境问题，不算一轮缺陷），不能拿另一个的通过顶上。
 */
export function combineVerdicts(vs) {
  const rejected = vs.filter((v) => v.verdict !== 'accept' && !v.noVerdict);
  if (rejected.length) return { verdict: 'reject', noVerdict: false, reasons: rejected.flatMap((v) => v.reasons), defects: rejected.flatMap((v) => v.defects ?? []),
    pushbacks: rejected.flatMap((v) => v.pushbacks ?? []), evidence: vs.flatMap((v) => v.evidence ?? []), llmCalls: vs.reduce((n, v) => n + (v.llmCalls ?? 0), 0) };
  const silent = vs.find((v) => v.noVerdict);
  if (silent) return { ...silent, llmCalls: vs.reduce((n, v) => n + (v.llmCalls ?? 0), 0) };
  return { verdict: 'accept', noVerdict: false, reasons: [], defects: [], pushbacks: [], evidence: vs.flatMap((v) => v.evidence ?? []), llmCalls: vs.reduce((n, v) => n + (v.llmCalls ?? 0), 0) };
}
