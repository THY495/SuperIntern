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

import { withOutputLang, contentLang } from '../i18n/index.mjs';
import { runToolLoop } from '../llm/client.mjs';
import { audit } from '../db/db.mjs';
import { TOOLS, makeHandlers } from './executor.mjs';

const READ_ONLY = new Set(['list_dir', 'read_file', 'grep']);

const SUBMIT_VERDICT = {
  name: 'submit_verdict',
  description: '给出验收结论。只有这一个出口。打回要逐条给理由，理由要指向具体的验收标准或文件。',
  parameters: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['accept', 'reject'] },
      reasons: { type: 'array', items: { type: 'string' },
        description: 'reject 时必填：每条对应一条没满足的验收标准，或产物里的一个具体问题（文件:行）。' },
      assumption_pushbacks: { type: 'array', items: { type: 'object', properties: {
        subject_key: { type: 'string' }, why: { type: 'string' } }, required: ['subject_key', 'why'] },
      description: '交接记录里 settled_by_me 的假设中，你认为**不该由 agent 替人拍板**的那些。给了就算打回理由之一。' },
      evidence_checked: { type: 'array', items: { type: 'string' },
        description: '你实际核对过的东西（文件路径 / 命令输出 / 规格条目），供人复盘你看了什么。' },
    },
    required: ['verdict', 'evidence_checked'],
  },
};

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

"人的裁定"一节是人经认证通道对本节点问题的答复，具指令效力：人明确放行的事，不再按约束的字面判违规。

假设登记表里 verified_against=settled_by_me 的条目是"agent 替人做了个决定"。
若那个决定是人该拍板的取舍（改了接口形状、放弃了某条要求、选了一条有代价的路），
放进 assumption_pushbacks 打回；若只是无关紧要的实现细节，放过。

只调用 submit_verdict 一次。`;

/**
 * @returns {{verdict:'accept'|'reject', reasons:string[], pushbacks:object[], evidence:string[], llmCalls:number, stopped?:string}}
 */
export async function verifyHandoff(db, {
  client, taskId, nodeId, workspace, exec, args, changed = null, tier = 'standard', maxIterations = 10,
}) {
  const node = db.one(`SELECT * FROM nodes WHERE id=?`, nodeId);
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

用 read_file / grep / list_dir 核对，然后调用 submit_verdict。`;

  const trace = [];
  const all = makeHandlers(exec, workspace, trace);
  const handlers = Object.fromEntries(Object.entries(all).filter(([k]) => READ_ONLY.has(k)));
  let out = null;
  handlers.submit_verdict = async (v) => { out = v; return '结论已记录。不要再调用任何工具。'; };

  // 分两段跑。实测（DeepSeek-pro，3/3）验收员读到最后一轮还在读文件，报数提示
  // （"这是最后一轮，必须给结论"）完全无效 —— 提示词管不住它。护栏要住在模型外：
  // 前 maxIterations-1 轮带只读工具；没结论就用同一份 messages 再起 1 轮，
  // **工具只剩 submit_verdict**，它想读也没得读。这一轮仍不给结论才算打回。
  const canon = { tier, system: withOutputLang(SYSTEM, contentLang(db)), maxTokens: 4000, effort: 'medium' };
  const readRounds = Math.max(0, maxIterations - 1);
  const loop = await runToolLoop(client, {
    ...canon, tools: [...TOOLS.filter((t) => READ_ONLY.has(t.name)), SUBMIT_VERDICT],
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  }, handlers, {
    maxIterations: readRounds, shouldStop: () => out !== null,
    iterationNote: (i, max) => {
      const left = max - i - 1;
      if (left > 3 || left < 0) return null;
      return left === 0
        ? `[系统] 只读工具到此为止。下一轮只剩 submit_verdict 一个工具 —— 现在把结论想好；核不完的写进 reasons 说清哪条没核到。`
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
    // 收窄段给 2 轮不给 1 轮：实测（DeepSeek-pro）3 次里有 1 次在只剩 submit_verdict 时仍以
    // max_iterations 收场 —— 推断是调了个没提供的工具（得到 "unknown tool"），一轮就没了。
    // 第二轮它能看见那条报错。到底在干什么，记进审计（lastTurn）。
    const final = await runToolLoop(client, { ...canon, tools: [SUBMIT_VERDICT], messages },
      { submit_verdict: handlers.submit_verdict }, { maxIterations: 2, shouldStop: () => out !== null });
    llmCalls += final.trace?.length ?? 0;
    stopped = final.stopped;
    // 没结论时把最后一轮的响应留进审计 —— 不然只知道"没给"，不知道它在干什么
    if (out === null) lastTurn = JSON.stringify(final.trace?.at(-1)?.content ?? final.resp?.content ?? null).slice(0, 800);
  }

  const pushbacks = out?.assumption_pushbacks ?? [];
  let verdict = out?.verdict === 'accept' && !pushbacks.length ? 'accept' : 'reject';
  const reasons = [...(out?.reasons ?? [])];
  if (out?.verdict === 'accept' && pushbacks.length) {
    reasons.push('验收员放行了产物，但打回了下列假设 —— 它们是人该拍板的取舍，不该由 agent 替人定');
  }
  for (const p of pushbacks) reasons.push(`假设 ${p.subject_key}：${p.why}`);
  if (!out) { verdict = 'reject'; reasons.push(`验收员没有给出结论（${stopped}，最后一轮已只剩 submit_verdict）—— 没结论不等于通过`); }
  if (verdict === 'reject' && !reasons.length) reasons.push('验收员打回但没给理由');

  audit(db, { actorKind: 'agent', actorId: 'verifier', action: 'handoff_verified',
    targetType: 'node', targetId: nodeId,
    payload: { verdict, reasons, pushbacks, evidence: out?.evidence_checked ?? [],
      toolCalls: trace.length, llmCalls, stopped, lastTurn, pid: process.pid } });
  return { verdict, reasons, pushbacks, evidence: out?.evidence_checked ?? [], llmCalls, stopped };
}
