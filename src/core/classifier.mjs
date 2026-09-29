// 收件箱分类器 —— 人没给 --kind 时，由 standard 档模型判定这条消息的
// 类别与紧急度。它是 recordMessage 之前的一步，绝不进 inbox 的库层。
//
// 为什么独立成一个模块：recordMessage 保持同步、不碰网络（认证 / CHECK / 事务是
// 库层规矩，不该和一次模型调用绑在同一个函数里）。分类器的模型调用、重试、解析
// 失败兜底全部收在这里，inbox.mjs 里的 sayWithClassifier 只负责编排顺序。
//
// 兜底策略（任务宪法）：分类器置信不足时不猜高权限类别（instruction /
// correction / answer），落成 context —— 最低权限，不改变要做什么。解析失败最多
// 重试一次，仍失败落 context，并把 confidence 交给 recordMessage 写进审计 payload，
// 让人能在看板上看见后改口。

import { MESSAGE_KINDS } from './inbox.mjs';
import { textOf } from '../llm/canonical.mjs';

export const CLASSIFIER_TIER = 'standard';
/** 低于这个置信度的高权限类别（instruction / correction / answer）一律落 context。 */
export const CONFIDENCE_FLOOR = 0.6;
/** 模型可以吐四个值；规范化后 kind 只允许 instruction / correction / context。 */
const ALLOWED_KINDS = ['instruction', 'correction', 'context', 'answer'];

// ⚠️ 不能写成模块顶层的 const：inbox.mjs 与 classifier.mjs 互相 import，
// 顶层求值会先于 MESSAGE_KINDS 初始化。放进函数里，调用时绑定已经就绪。
const systemPrompt = () => `你是 SuperIntern 收件箱分类器。你只做一件事：把人发来的一句话归类。

类别定义（原文，不得自行扩充含义）：
${Object.entries(MESSAGE_KINDS).map(([k, d]) => `${k}: ${d}`).join('\n')}

如果这句话其实是在回答下面列出的某个**开着的问题**，kind 填 "answer"，并在 questionId
里给那个问题的 id。只能从列表里选，不要自己编 questionId；拿不准是不是在回答，就不要
填 answer。

urgency 只能是 "normal" 或 "urgent"。urgent 表示这条消息需要尽快处理（明确说"紧急"，
或语义上要求立刻停下 / 改向）。拿不准就填 normal。

confidence 是 0 到 1 之间的数字，表示你对自己分类的把握。没把握时宁可给低分，也不要
在没把握时猜 instruction / correction / answer。

你只回一个 JSON 对象，不要输出 JSON 之外的任何文字。JSON 形状：
{"kind":"<instruction|correction|context|answer>","urgency":"<normal|urgent>","confidence":<0到1之间的数字>,"questionId":"<仅当 kind=answer 时给，必须来自下面的列表>","why":"<一句话理由>"}`;

const buildPrompt = (text, openQuestions) => `## 开着的问题（id 与正文）
${openQuestions.length
    ? openQuestions.map((q) => `- ${q.id}: ${q.text}`).join('\n')
    : '（当前没有开着的问题）'}

## 人说的话
${text}

现在只回一个 JSON 对象。`;

/** 从模型输出里尽量把 JSON 抠出来：容忍 markdown 代码块与前后杂文。 */
const extractJson = (text) => {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
};

/** confidence 可能是字符串数字；非法 / 缺失一律当 0（最低置信）。 */
const toConfidence = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

/**
 * 把模型的原始 JSON 规范化为可落库的结果。
 *
 * 规范化后 `kind` 只允许 instruction / correction / context 三个可写类别。
 * 模型判的 `answer` 是特殊出口：**不落 messages**，由 `questionId` 作为信号往上带，
 * 交给 sayWithClassifier → recordMessage，最终由人显式走 `cli answer`。
 */
const normalize = (raw, openQuestions) => {
  const openIds = new Set(openQuestions.map((q) => q.id));
  const kind = ALLOWED_KINDS.includes(raw?.kind) ? raw.kind : null;
  const confidence = toConfidence(raw?.confidence);
  const urgency = raw?.urgency === 'urgent' ? 'urgent' : 'normal';
  const questionId = (typeof raw?.questionId === 'string' && raw.questionId.trim())
    ? raw.questionId.trim() : null;
  const why = (typeof raw?.why === 'string' && raw.why.trim()) ? raw.why.trim().slice(0, 1000) : '';

  if (!kind) {
    return { kind: 'context', urgency: 'normal', confidence: 0, questionId: null,
      why: why || '分类器没有给出合法类别，按低置信落 context', source: 'classifier' };
  }

  if (kind === 'answer') {
    if (questionId && openIds.has(questionId) && confidence >= CONFIDENCE_FLOOR) {
      // 信号是 questionId；kind 落成 context（可写类别）只是不参与落库，由 recordMessage 短路。
      return { kind: 'context', urgency: 'normal', confidence, questionId,
        why: why || '这条消息被判定为在回答一个开着的问题', source: 'classifier' };
    }
    // answer 判据不足（questionId 缺失 / 不在开着的问题里 / 置信不足）：不猜，落 context。
    return { kind: 'context', urgency: 'normal', confidence, questionId: null,
      why: why || '分类器判 answer 但 questionId 缺失、不在开着的问题里或置信不足，落 context',
      source: 'classifier' };
  }

  // 高权限类别（instruction / correction）置信不足时不猜：落 context 并把置信度带上。
  if ((kind === 'instruction' || kind === 'correction') && confidence < CONFIDENCE_FLOOR) {
    return { kind: 'context', urgency: 'normal', confidence, questionId: null,
      why: why || '高权限类别但置信不足，落 context', source: 'classifier' };
  }

  return { kind, urgency, confidence, questionId: null, why, source: 'classifier' };
};

/**
 * 分类一条消息。**本函数只调模型与解析，不落账** —— flushLedger 由调用方
 * （sayWithClassifier）在拿到 db 后做，与 cmdPlan 的 finally 记账同一条规矩。
 *
 * @param {string} text  人说的话
 * @param {object} opts
 *   - openQuestions  开着的问题列表（id + 正文），给模型判断"是不是在回答"
 *   - llmClient      LlmClient 实例（档位固定 standard）
 * @returns {{kind:'instruction'|'correction'|'context', urgency:'normal'|'urgent',
 *            confidence:number, questionId:string|null, why:string, source:'classifier'}}
 *           questionId 非空 = 判为"在回答某个开着的问题"，应由 recordMessage 短路为答复建议。
 */
export async function classify(text, { openQuestions = [], llmClient }) {
  if (!llmClient) throw new Error('classify 需要 llmClient（standard 档）');
  const messages = [{ role: 'user', content: [{ type: 'text', text: buildPrompt(text, openQuestions) }] }];
  let lastFailure = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await llmClient.complete({
      tier: CLASSIFIER_TIER, system: systemPrompt(), messages, maxTokens: 500,
    });
    const raw = extractJson(textOf(resp));
    if (raw && ALLOWED_KINDS.includes(raw.kind)) {
      return normalize(raw, openQuestions);
    }
    lastFailure = raw ? `kind 非法：${JSON.stringify(raw.kind)}` : '没有可解析的 JSON';
    if (attempt === 0) {
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: [{ type: 'text', text:
        `你上次的回复不合规（${lastFailure}）。只回一个 JSON 对象，不要输出其他文字。` }] });
    }
  }

  return { kind: 'context', urgency: 'normal', confidence: 0, questionId: null,
    why: `分类器解析失败（${lastFailure}），按低置信落 context`, source: 'classifier' };
}
