// 三个厂商适配器 + 一个 fake。每个适配器实现同一接口：
//   { id, endpoint(model), buildRequest(canon, model), parseResponse(wire), streamAccumulator() }
//
// 适配器只做翻译，不做业务判断。所有厂商差异都必须在这里被吸收干净，
// 上层（编排器、执行 loop）永远只见 canonical 形状。

import { TIER_BINDING, MODEL_CATALOG, tierEntry, GEMINI_THINKING_BUDGET } from './canonical.mjs';

// 停止原因的统一取值域。厂商各自的字符串在 adapter 里映射到这里；
// 映射不到的一律原样透出（宁可让上层看见陌生值，也不要静默归到 end_turn）。
export const STOP_REASONS = [
  'end_turn', 'tool_call', 'max_tokens', 'refusal',
  'pause_turn',        // 服务端工具跑满内部轮数，需原样再发一次续跑
  'context_exceeded',  // 撞的是上下文窗口，不是 max_tokens —— 处理方式完全不同
  'malformed',         // 模型产出的工具调用不合法（Gemini 实测：推理耗尽预算时报的就是这个）
];

// ═══════════════════════════════════════════════════════════════════════════
// Anthropic Messages API
// ═══════════════════════════════════════════════════════════════════════════

export const anthropic = {
  id: 'anthropic',
  endpoint: (_m, base = 'https://api.anthropic.com/v1') => `${base}/messages`,
  headers: (key) => ({
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }),

  buildRequest(canon, model) {
    const messages = [];
    for (const m of canon.messages) {
      if (m.role === 'tool_results') {
        // 全部并行结果进**同一条** user 消息（拆开会让模型放弃并行调用）
        const content = m.results.map((r) => ({
          type: 'tool_result',
          tool_use_id: r.callId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        }));
        // 滚动断点：工具循环里，**已经发生过的历史**同样是稳定前缀。
        // 只把断点钉在静态段落上，是把缓存能省的那一大块整个漏掉了；详见 client.mjs 的 rollingCache 注释。
        if (m.cache && content.length) content[content.length - 1].cache_control = { type: 'ephemeral' };
        messages.push({ role: 'user', content });
      } else {
        messages.push({
          role: m.role,
          content: m.content.map((b) => {
            if (b.type === 'tool_call') return { type: 'tool_use', id: b.id, name: b.name, input: b.args };
            // thinking 原样回传（opaque 里存的就是收到的整块），不重建
            if (b.type === 'thinking') return b.opaque ?? { type: 'text', text: b.text ?? '' };
            // 块级缓存断点：标到哪块，哪块之前（含）的前缀被缓存
            return b.cache
              ? { type: 'text', text: b.text, cache_control: { type: 'ephemeral' } }
              : { type: 'text', text: b.text };
          }),
        });
      }
    }
    const req = { model, max_tokens: canon.maxTokens, messages };
    if (canon.system) {
      // ⚠️ 要挂缓存断点，system 必须写成**块数组**形式；纯字符串形式挂不上。
      // canonical 只表达"到这里为止是稳定前缀"，由各 adapter 决定怎么落：
      // Anthropic 是显式断点（且写入收 1.25 倍价），其余三家自动缓存、直接忽略。
      req.system = canon.cacheSystem
        ? [{ type: 'text', text: canon.system, cache_control: { type: 'ephemeral' } }]
        : canon.system;
    }
    if (canon.tools?.length) {
      req.tools = canon.tools.map((t) => ({
        name: t.name, description: t.description, input_schema: t.parameters,
      }));
    }
    // ⚠️ 绝不发 temperature / top_p / top_k：claude-opus-5 对三者一律 400。
    // 推理强度只能经 output_config.effort 表达。
    if (canon.effort) req.output_config = { effort: canon.effort };
    return req;
  },

  parseResponse(wire) {
    const content = [];
    for (const b of wire.content ?? []) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      // thinking 块：Anthropic 要求同模型续轮时原样回传。丢弃不会报错（实测），
      // 但可能损失推理连续性 —— 故原样收进 canonical 的 opaque 里搬运。
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
        content.push({ type: 'thinking', text: b.thinking ?? '', opaque: b });
      }
      // input 已是解析好的对象，不需要 JSON.parse
      else if (b.type === 'tool_use') content.push({ type: 'tool_call', id: b.id, name: b.name, args: b.input });
    }
    const map = {
      end_turn: 'end_turn', tool_use: 'tool_call', max_tokens: 'max_tokens', refusal: 'refusal',
      pause_turn: 'pause_turn', model_context_window_exceeded: 'context_exceeded',
    };
    const u = wire.usage ?? {};
    return {
      stopReason: map[wire.stop_reason] ?? wire.stop_reason,
      stopDetails: wire.stop_details ?? null,       // 仅 refusal 时非空
      content,
      // input_tokens 与 cache_* 互斥；thinking_tokens 已含在 output_tokens 内
      usage: {
        inputTokens: u.input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
      },
    };
  },

  // 流式：工具入参以 input_json_delta.partial_json 的**字符串片段**到达，需按 index 拼接后再 parse
  streamAccumulator() {
    const blocks = new Map();     // index -> {type, id, name, jsonBuf, text}
    let stopReason = null;
    const usage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    return {
      push(ev) {
        if (ev.type === 'message_start') {
          const u = ev.message?.usage ?? {};
          usage.inputTokens = u.input_tokens ?? 0;
          usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
        } else if (ev.type === 'content_block_start') {
          const cb = ev.content_block;
          blocks.set(ev.index, cb.type === 'tool_use'
            ? { type: 'tool_call', id: cb.id, name: cb.name, jsonBuf: '' }
            : { type: 'text', text: '' });
        } else if (ev.type === 'content_block_delta') {
          const b = blocks.get(ev.index);
          if (ev.delta.type === 'text_delta') b.text += ev.delta.text;
          else if (ev.delta.type === 'input_json_delta') b.jsonBuf += ev.delta.partial_json;
        } else if (ev.type === 'message_delta') {
          const map = {
            end_turn: 'end_turn', tool_use: 'tool_call', max_tokens: 'max_tokens', refusal: 'refusal',
            pause_turn: 'pause_turn', model_context_window_exceeded: 'context_exceeded',
          };
          stopReason = map[ev.delta?.stop_reason] ?? ev.delta?.stop_reason ?? stopReason;
          usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens;
          usage.reasoningTokens = ev.usage?.output_tokens_details?.thinking_tokens ?? usage.reasoningTokens;
        }
      },
      finish() {
        const content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) =>
          b.type === 'tool_call'
            ? { type: 'tool_call', id: b.id, name: b.name, args: b.jsonBuf ? JSON.parse(b.jsonBuf) : {} }
            : { type: 'text', text: b.text });
        return { stopReason, content, usage };
      },
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// OpenAI chat/completions —— 即业界所称的"OpenAI 兼容"协议
// （覆盖 OpenAI 的 gpt-5 / gpt-5-mini，以及 DeepSeek / Moonshot / 通义 / OpenRouter / vLLM …）
//
// ⚠️ 命名从 'openai' 改为 'openai-chat'，因为 OpenAI 自己有两个互不兼容的协议。
// 第三方兼容的永远是这一个；responses 见下一个适配器。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * OpenAI 兼容形状的 usage 归一。**减法是必须的**：
 * cached_tokens ⊂ prompt_tokens，reasoning_tokens ⊂ completion_tokens（均实测确认，
 * prompt+completion == total）。不减就会把缓存命中重复计一次全价。
 * DeepSeek 用另一套字段名表达同一件事（prompt_cache_hit/miss_tokens），一并吸收。
 */
function usageFromOpenAIChat(u = {}) {
  const prompt = u.prompt_tokens ?? 0;
  const cacheRead = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cacheRead),   // 减出互斥部分
    cacheReadTokens: cacheRead,
    // 直连的两家是自动缓存、不单收写入费；网关会额外报 cache_write_tokens
    cacheWriteTokens: u.prompt_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,         // 已含推理，不能再加
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * 工具调用参数：OpenAI 形状里是 **JSON 字符串**，由模型逐字生成，不保证合法。
 * 例：DeepSeek-pro 曾在参数里塞了一段含 `\*` 的 JS 正则，
 * `JSON.parse` 抛 "Bad escaped character"，一路穿到进程顶上把编排器炸了 ——
 * 模型写错一个转义符，整个任务停摆。参数不合法是**模型的错**，要回给模型让它重发，
 * 不是基础设施错误。解析失败 → args 取空对象、原文与错误留在块上，runToolLoop 据此回错。
 */
export function toolArgs(raw) {
  if (!raw) return { args: {} };
  try { return { args: JSON.parse(raw) }; } catch (e) { return { args: {}, argsRaw: String(raw), argsError: e.message }; }
}

export const openaiChat = {
  id: 'openai-chat',
  endpoint: (_m, base = 'https://api.openai.com/v1') => `${base}/chat/completions`,
  headers: (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' }),

  buildRequest(canon, model) {
    const messages = [];
    if (canon.system) messages.push({ role: 'system', content: canon.system });  // system 是消息，不是顶层字段
    for (const m of canon.messages) {
      if (m.role === 'tool_results') {
        // ⚠️ 扇出：OpenAI 要求每个工具结果**各占一条** role:'tool' 消息
        for (const r of m.results) {
          messages.push({ role: 'tool', tool_call_id: r.callId, content: String(r.content) });
        }
      } else if (m.role === 'assistant') {
        const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const calls = m.content.filter((b) => b.type === 'tool_call');
        const msg = { role: 'assistant', content: text || null };
        if (calls.length) {
          // 入参必须序列化成 JSON **字符串**
          msg.tool_calls = calls.map((c) => ({
            id: c.id, type: 'function', function: { name: c.name, arguments: c.argsRaw ?? JSON.stringify(c.args) },
          }));
        }
        messages.push(msg);
      } else {
        messages.push({ role: 'user', content: m.content.map((b) => b.text ?? '').join('') });
      }
    }
    const req = { model, max_completion_tokens: canon.maxTokens, messages };
    if (canon.tools?.length) {
      req.tools = canon.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    // ⚠️ 同样绝不发 temperature：gpt-5 实测 400（"only the default value is supported"）。
    // reasoning_effort 是它的替代品，DeepSeek 也认（实测 low/high 的推理 token 明显不同）。
    if (canon.effort) req.reasoning_effort = canon.effort;
    // ⚠️ OpenAI 的缓存命中带**路由亲和性**：请求被分到哪台机器决定了能否命中，
    // 而分派默认按整个请求内容哈希——改动提示词尾部会换机器，前缀缓存随之落空。
    // prompt_cache_key 把路由钉在一个稳定的键上，与内容解耦。
    if (canon.cacheKey) req.prompt_cache_key = canon.cacheKey;
    // 两个字段厂商直连端点都不认识，故只在 gateway 服务商上发。
    if (canon.gateway) {
      req.usage = { include: true };
      if (canon.providerPrefs) req.provider = canon.providerPrefs;
    }
    return req;
  },

  parseResponse(wire) {
    const choice = wire.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const content = [];
    // DeepSeek 在 OpenAI 形状上多挂一个 reasoning_content（OpenAI 自己没有）
    if (msg.reasoning_content) content.push({ type: 'thinking', text: msg.reasoning_content });
    if (msg.content) content.push({ type: 'text', text: msg.content });
    for (const tc of msg.tool_calls ?? []) {
      // arguments 是 JSON 字符串，必须 parse 才能得到 canonical 的对象形态
      content.push({ type: 'tool_call', id: tc.id, name: tc.function.name, ...toolArgs(tc.function.arguments) });
    }
    const map = { stop: 'end_turn', tool_calls: 'tool_call', length: 'max_tokens', content_filter: 'refusal' };
    // ⚠️ 网关（OpenRouter 一类）会用 **HTTP 200 + finish_reason:'error'** 表达上游失败，
    // 真实原因藏在它的扩展字段 native_finish_reason 里。实测 gemini-3.1-pro-preview
    // 经 OpenRouter 约 1/4 概率返回 error / MALFORMED_FUNCTION_CALL —— 与直连是同一个
    // 失败模式（推理耗尽预算），但直连是明确的错误码，经网关变成一个 200。
    // 不翻译就等于把"调用失败"当成一次正常收尾，上层完全看不见。
    const native = choice.native_finish_reason;
    const nativeMap = {
      MALFORMED_FUNCTION_CALL: 'malformed', MALFORMED_RESPONSE: 'malformed',
      MAX_TOKENS: 'max_tokens', SAFETY: 'refusal', PROHIBITED_CONTENT: 'refusal',
    };
    let stopReason = map[choice.finish_reason] ?? choice.finish_reason;
    // 映射不到的 native 原样透出 'error'，不猜 —— 宁可让上层见到陌生值
    if (choice.finish_reason === 'error' && nativeMap[native]) stopReason = nativeMap[native];
    return {
      stopReason,
      stopDetails: native ? { native } : null,
      content,
      usage: usageFromOpenAIChat(wire.usage),
      // 网关回报的**实际计费**（微美元整数）。厂商直连不返回该字段，故为 undefined。
      // 这是记账真值：网关同一模型背后 20 家上游单价各异，我们的单价表算不准。
      reportedMicroUsd: wire.usage?.cost != null ? Math.round(Number(wire.usage.cost) * 1e6) : undefined,
      upstream: wire.provider ?? undefined,   // 本次实际服务的上游，写进账本供事后审计
    };
  },

  // 流式：delta.tool_calls[] 按 index 增量，id/name 只在首个分片出现，arguments 是字符串片段
  streamAccumulator() {
    const calls = new Map();      // index -> {id, name, argBuf}
    let text = '', stopReason = null, usage = usageFromOpenAIChat({});
    return {
      push(ev) {
        const choice = ev.choices?.[0];
        if (!choice) {
          if (ev.usage) usage = usageFromOpenAIChat(ev.usage);
          return;
        }
        const d = choice.delta ?? {};
        if (d.content) text += d.content;
        for (const tc of d.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: null, name: null, argBuf: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.argBuf += tc.function.arguments;
          calls.set(tc.index, cur);
        }
        if (choice.finish_reason) {
          const map = { stop: 'end_turn', tool_calls: 'tool_call', length: 'max_tokens', content_filter: 'refusal' };
          stopReason = map[choice.finish_reason] ?? choice.finish_reason;
        }
        if (ev.usage) usage = usageFromOpenAIChat(ev.usage);
      },
      finish() {
        const content = [];
        if (text) content.push({ type: 'text', text });
        for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
          content.push({ type: 'tool_call', id: c.id, name: c.name, ...toolArgs(c.argBuf) });
        }
        return { stopReason, content, usage };
      },
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// OpenAI Responses API —— 与 chat/completions **不兼容**的第二个 OpenAI 协议
//
// 存在的理由不是"更好用"，而是**某些模型只在这里存在**：gpt-5-pro 在
// chat/completions 上返回 404。差异点密度不低于 Anthropic vs chat/completions：
//   · messages → input，且工具结果不是消息而是**顶层 item**
//   · tools 是扁平的 {type,name,parameters}，没有 function 嵌套层
//   · 没有 finish_reason，用 status + incomplete_details 表达停止原因
//   · 工具调用同时有 id 与 call_id，回填必须用 **call_id**（用 id 会被拒）
//   · usage 字段名又变了一套：input_tokens / output_tokens
// ═══════════════════════════════════════════════════════════════════════════

export const openaiResponses = {
  id: 'openai-responses',
  endpoint: (_m, base = 'https://api.openai.com/v1') => `${base}/responses`,
  headers: (key) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' }),

  buildRequest(canon, model) {
    const input = [];
    for (const m of canon.messages) {
      if (m.role === 'tool_results') {
        // 工具结果不是"消息"，是与消息平级的 item —— 与另外三家的建模都不同
        for (const r of m.results) {
          input.push({ type: 'function_call_output', call_id: r.callId, output: String(r.content) });
        }
      } else if (m.role === 'assistant') {
        const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
        for (const c of m.content.filter((b) => b.type === 'tool_call')) {
          input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.argsRaw ?? JSON.stringify(c.args) });
        }
      } else {
        input.push({ role: 'user', content: m.content.map((b) => ({ type: 'input_text', text: b.text ?? '' })) });
      }
    }
    const req = { model, input, max_output_tokens: canon.maxTokens };
    if (canon.system) req.instructions = canon.system;            // 既不是消息也不叫 system
    if (canon.tools?.length) {
      // 扁平结构：没有 { type:'function', function:{...} } 那一层嵌套
      req.tools = canon.tools.map((t) => ({
        type: 'function', name: t.name, description: t.description, parameters: t.parameters,
      }));
    }
    if (canon.effort) req.reasoning = { effort: canon.effort };
    if (canon.cacheKey) req.prompt_cache_key = canon.cacheKey;   // 同 chat：钉住缓存路由
    return req;
  },

  parseResponse(wire) {
    const content = [];
    let refused = false;
    for (const item of wire.output ?? []) {
      if (item.type === 'message') {
        for (const c of item.content ?? []) {
          if (c.type === 'output_text') content.push({ type: 'text', text: c.text });
          else if (c.type === 'refusal') { refused = true; content.push({ type: 'text', text: c.refusal }); }
        }
      } else if (item.type === 'function_call') {
        // 回填要用 call_id 而非 id —— canonical 只留一个 ID 位，这里必须选对
        content.push({ type: 'tool_call', id: item.call_id, name: item.name, ...toolArgs(item.arguments) });
      }
      // type:'reasoning' 暂时丢弃（thinking 尚未纳入 canonical，见遗留）
    }
    const hasCall = content.some((b) => b.type === 'tool_call');
    let stopReason;
    if (refused) stopReason = 'refusal';
    else if (wire.status === 'incomplete') {
      stopReason = wire.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : wire.status;
    } else stopReason = hasCall ? 'tool_call' : 'end_turn';
    const u = wire.usage ?? {};
    const cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
    return {
      stopReason,
      stopDetails: null,
      content,
      usage: {
        inputTokens: Math.max(0, (u.input_tokens ?? 0) - cacheRead),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: u.input_tokens_details?.cache_write_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  },

  // 流式：事件是**具名的**（response.output_item.added / .delta / .done），不是 delta 数组。
  // ⚠️ 本累加器按文档实现，尚未对真实端点验证（live-check 目前只打非流式）。
  streamAccumulator() {
    const items = new Map();      // output_index -> {type, call_id, name, argBuf, text}
    let status = null, incomplete = null, usage = { inputTokens: 0, outputTokens: 0 };
    return {
      push(ev) {
        const i = ev.output_index;
        if (ev.type === 'response.output_item.added') {
          const it = ev.item ?? {};
          if (it.type === 'function_call') items.set(i, { type: 'tool_call', call_id: it.call_id, name: it.name, argBuf: '' });
          else if (it.type === 'message') items.set(i, { type: 'text', text: '' });
        } else if (ev.type === 'response.function_call_arguments.delta') {
          const it = items.get(i); if (it) it.argBuf += ev.delta ?? '';
        } else if (ev.type === 'response.output_text.delta') {
          const it = items.get(i); if (it) it.text += ev.delta ?? '';
        } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
          status = ev.response?.status ?? status;
          incomplete = ev.response?.incomplete_details ?? incomplete;
          if (ev.response?.usage) {
            usage = { inputTokens: ev.response.usage.input_tokens ?? 0, outputTokens: ev.response.usage.output_tokens ?? 0 };
          }
        }
      },
      finish() {
        // 复用非流式解析路径，保证两条路产出一致（与另外三家同样的做法）
        const output = [...items.entries()].sort((a, b) => a[0] - b[0]).map(([, it]) =>
          it.type === 'tool_call'
            ? { type: 'function_call', call_id: it.call_id, name: it.name, arguments: it.argBuf || '{}' }
            : { type: 'message', content: [{ type: 'output_text', text: it.text }] });
        return openaiResponses.parseResponse({
          output, status, incomplete_details: incomplete,
          usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
        });
      },
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Gemini generateContent
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ Gemini 的 functionCall **不带调用 ID**。适配器必须自行合成 ID，并维护
 * "合成 ID → (函数名, 本轮序号)" 的映射，否则同一函数被并行调用两次时无法把结果对回去。
 * 合成规则：`gem_{name}_{ordinal}`，回填时按同名调用的出现顺序还原。
 */
export const gemini = {
  id: 'gemini',
  endpoint: (model, base = 'https://generativelanguage.googleapis.com/v1beta') => `${base}/models/${model}:generateContent`,
  headers: (key) => ({ 'x-goog-api-key': key, 'content-type': 'application/json' }),

  buildRequest(canon, _model) {
    const contents = [];
    for (const m of canon.messages) {
      if (m.role === 'tool_results') {
        contents.push({
          role: 'user',
          parts: m.results.map((r) => ({
            functionResponse: { name: r.name, response: { result: r.content } },   // 靠 name 而非 ID 对齐
          })),
        });
      } else {
        const parts = [];
        for (const b of m.content) {
          if (b.type === 'text') parts.push({ text: b.text });
          else if (b.type === 'thinking') { if (b.opaque) parts.push(b.opaque); }
          // ⚠️ opaque 里带着 thoughtSignature，**必须原样回传**：
          // 实测 Gemini 3.x 缺它直接 HTTP 400（"Function call is missing a
          // thought_signature… required for tools to work correctly"）。
          // 2.5 系列不要求，所以只在 2.5 上测会漏掉这个 bug。
          else parts.push(b.opaque ?? { functionCall: { name: b.name, args: b.args } });
        }
        contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
      }
    }
    const req = { contents, generationConfig: { maxOutputTokens: canon.maxTokens } };
    // thinking 会吃掉 maxOutputTokens；预算不足时 Gemini 报的是 MALFORMED_FUNCTION_CALL
    // 而不是 MAX_TOKENS —— 错误码指向"函数调用格式错误"，真实原因是预算耗尽。
    if (canon.effort) req.generationConfig.thinkingConfig = { thinkingBudget: GEMINI_THINKING_BUDGET[canon.effort] };
    if (canon.system) req.systemInstruction = { parts: [{ text: canon.system }] };
    if (canon.tools?.length) {
      req.tools = [{ functionDeclarations: canon.tools.map((t) => ({
        name: t.name, description: t.description, parameters: t.parameters,
      })) }];
    }
    return req;
  },

  parseResponse(wire) {
    const cand = wire.candidates?.[0] ?? {};
    const content = [];
    const seen = new Map();   // name -> 出现次数，用于合成稳定 ID
    for (const p of cand.content?.parts ?? []) {
      // thought:true 的 part 是推理摘要，不是答复正文
      if (p.text != null && p.thought) content.push({ type: 'thinking', text: p.text, opaque: p });
      else if (p.text != null) content.push({ type: 'text', text: p.text });
      else if (p.functionCall) {
        const n = seen.get(p.functionCall.name) ?? 0;
        seen.set(p.functionCall.name, n + 1);
        content.push({
          type: 'tool_call',
          id: `gem_${p.functionCall.name}_${n}`,   // 合成 ID：厂商没给，我们造
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
          opaque: p,                               // 整个 part 原样留存（含 thoughtSignature）
        });
      }
    }
    const hasCall = content.some((b) => b.type === 'tool_call');
    const map = {
      STOP: hasCall ? 'tool_call' : 'end_turn', MAX_TOKENS: 'max_tokens',
      SAFETY: 'refusal', PROHIBITED_CONTENT: 'refusal',
      MALFORMED_FUNCTION_CALL: 'malformed', MALFORMED_RESPONSE: 'malformed',
    };
    const um = wire.usageMetadata ?? {};
    const thoughts = um.thoughtsTokenCount ?? 0;
    return {
      stopReason: map[cand.finishReason] ?? cand.finishReason,
      stopDetails: null,
      content,
      usage: {
        inputTokens: (um.promptTokenCount ?? 0) - (um.cachedContentTokenCount ?? 0),
        cacheReadTokens: um.cachedContentTokenCount ?? 0,
        cacheWriteTokens: 0,
        // ⚠️ 与另外两家相反：thoughts 与 candidates **互斥**（实测 prompt+candidates
        // +thoughts == total），所以必须相加。只读 candidates 会少算数倍输出。
        outputTokens: (um.candidatesTokenCount ?? 0) + thoughts,
        reasoningTokens: thoughts,
      },
    };
  },

  // 流式：functionCall 的 args 作为完整对象一次到达（无 partial JSON），与另两家形态完全不同
  streamAccumulator() {
    const parts = [];
    let finishReason = null, usageMetadata = {};
    return {
      push(ev) {
        const cand = ev.candidates?.[0];
        if (cand?.content?.parts) parts.push(...cand.content.parts);
        if (cand?.finishReason) finishReason = cand.finishReason;
        // 原样留存整个 usageMetadata，让 parseResponse 用同一套换算逻辑
        // （若在此处提前拆成 in/out 两个数，thoughts 的相加规则就会分叉）
        if (ev.usageMetadata) usageMetadata = ev.usageMetadata;
      },
      finish() {
        // 合并连续文本片段后复用非流式解析路径，保证两条路产出完全一致。
        // 只合并 thought 标记相同的相邻片段——推理摘要与答复正文不能拼在一起。
        const merged = [];
        for (const p of parts) {
          const prev = merged.at(-1);
          if (p.text != null && prev?.text != null && !!prev.thought === !!p.thought) prev.text += p.text;
          else merged.push({ ...p });
        }
        return gemini.parseResponse({
          candidates: [{ content: { parts: merged }, finishReason }],
          usageMetadata,
        });
      },
    };
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Fake provider —— 单元测试用，零网络、完全确定性
// ═══════════════════════════════════════════════════════════════════════════

export function makeFake(script) {
  let i = 0;
  return {
    id: 'fake',
    endpoint: () => 'fake://local',
    headers: () => ({}),
    buildRequest: (canon) => canon,
    parseResponse: (wire) => wire,
    nextScripted() {
      if (i >= script.length) throw new Error('fake provider: script exhausted');
      return script[i++];
    },
    reset() { i = 0; },
  };
}

/** adapter 名 → 实现。厂商与 adapter 是多对一，但绑定发生在**档位**上而非厂商上。 */
export const PROVIDERS = {
  anthropic,
  'openai-chat': openaiChat,
  'openai-responses': openaiResponses,
  gemini,
};

/**
 * 档位 → adapter 实现。
 * 解析单位是档位而非厂商：同一厂商内不同模型可能说不同协议，
 * 只按厂商解析会在运行期变成一个费解的 HTTP 404。
 */
export function resolveAdapter(tier, binding = TIER_BINDING, catalog = MODEL_CATALOG) {
  const { adapter, key } = tierEntry(tier, binding, catalog);
  const a = PROVIDERS[adapter];
  if (!a) throw new Error(`${key} references unimplemented adapter '${adapter}'`);
  return a;
}

export function resolveModel(tier, binding = TIER_BINDING, catalog = MODEL_CATALOG) {
  return tierEntry(tier, binding, catalog).model;
}
