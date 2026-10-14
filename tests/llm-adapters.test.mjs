// 厂商适配层一致性测试：同一个逻辑场景，用各家厂商自己的**线格式**编码，
// 验证适配层能把它们归一到完全相同的 canonical 形状。
//
// 场景刻意选了「同一个函数被并行调用两次」（Paris + London），
// 因为这恰好击穿 Gemini 没有调用 ID 的设计。
//
// 跑：node tests/llm-adapters.test.mjs（离线，不调任何厂商 API）

import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { anthropic, openaiChat as openai, openaiResponses, gemini, makeFake, PROVIDERS, STOP_REASONS } from '../src/llm/providers.mjs';
import { LlmClient, runToolLoop, withoutImages } from '../src/llm/client.mjs';
import { semanticShape, costMicroUsd, fmtUsd, VENDORS, MODEL_CATALOG, TIER_BINDING, SINGLE_VENDOR_BINDINGS,
  tierEntry, textOf, addUsage, EMPTY_USAGE, clampEffort, EFFORTS, TIERS, CACHE_FLOORS } from '../src/llm/canonical.mjs';
import { SESSIONS, TOOL_EFFECTS } from '../src/core/capabilities.mjs';

let pass = 0, fail = 0;
const sect = (t) => console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`);
const ok = (m) => { console.log(`  [PASS] ${m}`); pass++; };
const bad = (m, d) => { console.log(`  [FAIL] ${m}\n         ${d}`); fail++; };
const eq = (a, b, m) => JSON.stringify(a) === JSON.stringify(b)
  ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}\n         实际 ${JSON.stringify(a)}`);
const assert = (c, m, d = '') => c ? ok(m) : bad(m, d);

// ── 共用的 canonical 请求 ──────────────────────────────────────────────────
const TOOLS = [{
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}];

// 带工具的调用要带会话角色，角色要在能力表里登记：这里登记一个只用于适配器测试的会话
TOOL_EFFECTS.get_weather = 'read';
SESSIONS['adapter-test'] = { tools: ['get_weather'], untrusted: [], sensitive: 'none', external: 'none' };

const CANON_REQ = {
  role: 'adapter-test',
  tier: 'standard',
  system: '你是一个天气助手。',
  messages: [{ role: 'user', content: [{ type: 'text', text: '巴黎和伦敦现在天气如何？' }] }],
  tools: TOOLS,
  maxTokens: 1024,
};

// ── 三家的线格式响应（同一逻辑内容）───────────────────────────────────────
const WIRE = {
  anthropic: {
    content: [
      { type: 'text', text: '我来查一下。' },
      { type: 'tool_use', id: 'toolu_01A', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'toolu_01B', name: 'get_weather', input: { city: 'London' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 412, output_tokens: 88 },
  },
  openai: {
    choices: [{
      message: {
        role: 'assistant',
        content: '我来查一下。',
        tool_calls: [
          // 注意：arguments 是 JSON **字符串**，不是对象
          { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          { id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '{"city":"London"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 412, completion_tokens: 88 },
  },
  gemini: {
    candidates: [{
      content: {
        parts: [
          { text: '我来查一下。' },
          // 注意：没有任何 ID 字段
          { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
          { functionCall: { name: 'get_weather', args: { city: 'London' } } },
        ],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 412, candidatesTokenCount: 88 },
  },
};

// ── 三家的流式事件序列（同一逻辑内容）─────────────────────────────────────
const STREAM = {
  anthropic: [
    { type: 'message_start', message: { usage: { input_tokens: 412 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '查一下。' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01A', name: 'get_weather', input: {} } },
    // 入参以字符串碎片到达，可能断在任意位置（这里刻意断在 JSON 中间）
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"ci' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ty":"Pa' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ris"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01B', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":"London"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 88 } },
  ],
  openai: [
    { choices: [{ delta: { role: 'assistant', content: '我来' }, finish_reason: null }] },
    { choices: [{ delta: { content: '查一下。' }, finish_reason: null }] },
    // id 与 name 只在首个分片出现，后续分片只有 index + arguments 碎片
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"city":"London"}' } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 412, completion_tokens: 88 } },
  ],
  gemini: [
    { candidates: [{ content: { parts: [{ text: '我来' }] } }] },
    { candidates: [{ content: { parts: [{ text: '查一下。' }] } }] },
    // functionCall 的 args 整体到达，没有部分 JSON 的概念
    { candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'London' } } }] } }] },
    { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 412, candidatesTokenCount: 88 } },
  ],
};

const PROV = { anthropic, openai, gemini };

// ═══════════════════════════════════════════════════════════════════════════
sect('1. 非流式：三家线格式归一到同一 canonical 形状');
// ═══════════════════════════════════════════════════════════════════════════

const EXPECTED = {
  stopReason: 'tool_call',
  text: '我来查一下。',
  calls: [
    { name: 'get_weather', args: { city: 'Paris' } },
    { name: 'get_weather', args: { city: 'London' } },
  ],
};

const parsed = {};
for (const [id, p] of Object.entries(PROV)) {
  parsed[id] = p.parseResponse(WIRE[id]);
  eq(semanticShape(parsed[id]), EXPECTED, `${id.padEnd(9)} 归一化结果与预期一致`);
}
eq(parsed.anthropic.usage, { inputTokens: 412, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 88, reasoningTokens: 0 },
  'usage 归一为五个互斥字段（三家字段名与包含关系都不同）');
eq(parsed.openai.usage, parsed.gemini.usage, 'openai 与 gemini 的 usage 归一后相同');

// ═══════════════════════════════════════════════════════════════════════════
sect('2. 流式：累加器产出与非流式**逐字节相同**');
// ═══════════════════════════════════════════════════════════════════════════

for (const [id, p] of Object.entries(PROV)) {
  const acc = p.streamAccumulator();
  for (const ev of STREAM[id]) acc.push(ev);
  const streamed = acc.finish();
  eq(semanticShape(streamed), semanticShape(parsed[id]), `${id.padEnd(9)} 流式 == 非流式`);
}

const antStream = (() => { const a = anthropic.streamAccumulator(); STREAM.anthropic.forEach((e) => a.push(e)); return a.finish(); })();
assert(antStream.content[1].args.city === 'Paris',
  'Anthropic：断在 JSON 中间的 partial_json 碎片被正确拼接（"{"ci" + "ty":"Pa" + "ris"}"）');

const oaStream = (() => { const a = openai.streamAccumulator(); STREAM.openai.forEach((e) => a.push(e)); return a.finish(); })();
assert(oaStream.content[1].id === 'call_a' && oaStream.content[2].id === 'call_b',
  'OpenAI：id/name 只在首分片出现，按 index 归并后仍能对上');

// ═══════════════════════════════════════════════════════════════════════════
sect('3. 工具结果回填：canonical 的聚合形状被正确扇出/保持');
// ═══════════════════════════════════════════════════════════════════════════

const withResults = {
  ...CANON_REQ,
  messages: [
    ...CANON_REQ.messages,
    { role: 'assistant', content: parsed.anthropic.content },
    { role: 'tool_results', results: [
      { callId: 'toolu_01A', name: 'get_weather', content: '巴黎 18°C 晴' },
      { callId: 'toolu_01B', name: 'get_weather', content: '伦敦 14°C 阴' },
    ] },
  ],
};

const antReq = anthropic.buildRequest(withResults, 'claude-sonnet-5');
const antToolMsgs = antReq.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
assert(antToolMsgs.length === 1 && antToolMsgs[0].content.length === 2,
  'Anthropic：两个结果合并进**一条** user 消息（拆开会让模型放弃并行调用）',
  `得到 ${antToolMsgs.length} 条消息`);

const oaReq = openai.buildRequest({ ...withResults,
  messages: withResults.messages.map((m) => m.role === 'assistant'
    ? { ...m, content: parsed.openai.content } : m) }, 'gpt-5');
const oaToolMsgs = oaReq.messages.filter((m) => m.role === 'tool');
assert(oaToolMsgs.length === 2, 'OpenAI：同样两个结果扇出成**两条** role:"tool" 消息', `得到 ${oaToolMsgs.length} 条`);
assert(typeof oaReq.messages.find((m) => m.role === 'assistant')?.tool_calls?.[0].function.arguments === 'string',
  'OpenAI：回填的 tool_calls.arguments 被重新序列化为字符串');

const gemReq = gemini.buildRequest({ ...withResults,
  messages: withResults.messages.map((m) => m.role === 'assistant'
    ? { ...m, content: parsed.gemini.content } : m) }, 'gemini-2.5-flash');
const gemFnResp = gemReq.contents.filter((c) => c.parts.some((p) => p.functionResponse));
assert(gemFnResp.length === 1 && gemFnResp[0].parts.length === 2,
  'Gemini：两个结果进同一 content 的两个 functionResponse part');
assert(gemReq.systemInstruction?.parts[0].text === CANON_REQ.system, 'Gemini：system 走 systemInstruction 顶层字段');
assert(oaReq.messages[0].role === 'system', 'OpenAI：system 是消息数组的第一条');
assert(antReq.system === CANON_REQ.system, 'Anthropic：system 是顶层字段');

// ═══════════════════════════════════════════════════════════════════════════
sect('4. Gemini 无调用 ID —— 适配器合成 ID 的正确性');
// ═══════════════════════════════════════════════════════════════════════════

const gemCalls = parsed.gemini.content.filter((b) => b.type === 'tool_call');
assert(gemCalls[0].id !== gemCalls[1].id,
  `同名函数并行调用两次得到不同的合成 ID（${gemCalls[0].id} / ${gemCalls[1].id}）`);
assert(gemCalls[0].id === 'gem_get_weather_0' && gemCalls[1].id === 'gem_get_weather_1',
  '合成 ID 规则稳定可复现：gem_{name}_{ordinal}');
const raw = gemini.parseResponse(WIRE.gemini).content.filter((b) => b.type === 'tool_call');
assert(raw[0].id === gemCalls[0].id, '同一响应重复解析得到相同 ID（纯函数，无随机）');
assert(gemFnResp[0].parts[0].functionResponse.name === 'get_weather',
  '回填时 Gemini 只能按 name 对齐（无 ID 位置）—— 顺序即语义，不可重排');

// ═══════════════════════════════════════════════════════════════════════════
sect('5. 三层注册表：档位可**跨厂商**绑定，用户可自由增删型号');
// ═══════════════════════════════════════════════════════════════════════════

for (const tier of TIERS) {
  const e = tierEntry(tier);
  console.log(`  ....   ${tier.padEnd(9)} ${e.key.padEnd(30)} adapter=${e.adapter.padEnd(17)} 力度=${e.efforts.join('/') || '无'}`);
}
{
  const vendors = new Set(TIERS.map((t) => tierEntry(t).vendorId));
  assert(vendors.size >= 2,
    `默认绑定就是跨厂商的（${[...vendors].join(' + ')}）—— 旧的"档位嵌在厂商下"结构表达不了这个`);
}
let threw = false;
try { tierEntry('ultra'); } catch { threw = true; }
assert(threw, '未绑定的档位直接抛错，不静默降级');

// 用户自定义绑定：随便混搭，代码零改动
{
  const mine = { light: 'gemini/gemini-3.5-flash-lite', standard: 'deepseek/deepseek-v4-pro', heavy: 'anthropic/claude-fable-5' };
  const r = TIERS.map((t) => tierEntry(t, mine));
  eq(r.map((x) => x.vendorId), ['gemini', 'deepseek', 'anthropic'],
    '三档来自三家不同厂商，解析正常（"用户自选各级模型"的核心用例）');
  eq(r.map((x) => x.adapter), ['gemini', 'openai-chat', 'anthropic'],
    '协议随型号走，跨厂商混搭时自动各用各的 adapter');
  assert(r[2].model === 'claude-fable-5',
    '未占用默认档位的型号（fable-5）照样能被用户绑定上来');
}
// 用户新增型号：目录加一条即可
{
  const catalog = { ...MODEL_CATALOG, 'deepseek/my-finetune': {
    vendor: 'deepseek', model: 'my-finetune-v1', pricing: { input: 0.2, output: 0.4 } } };
  const e = tierEntry('standard', { standard: 'deepseek/my-finetune' }, catalog);
  assert(e.model === 'my-finetune-v1' && e.adapter === 'openai-chat' && e.efforts === EFFORTS,
    '新增型号只需一条目录项：协议与力度域缺省继承接入点，价格必填');
}
{
  let msg = '';
  try { tierEntry('standard', { standard: 'nope/nope' }); } catch (e) { msg = e.message; }
  // 报错文案会随多语言改写，只钉住"点名了是哪个键"这一要点
  assert(msg.includes('nope/nope'), '绑定到不存在的目录键 → 报错直指配置（点名那个键）', msg);
}
assert(VENDORS.deepseek.adapter === 'openai-chat' && tierEntry('light', SINGLE_VENDOR_BINDINGS.deepseek).adapter === 'openai-chat',
  'DeepSeek 复用 openai-chat adapter（OpenAI 兼容端点零新增代码）');
assert(openai.endpoint('x', VENDORS.deepseek.baseUrl) === 'https://api.deepseek.com/v1/chat/completions',
  'baseUrl 挂在接入点上，adapter 保持无状态');
{
  const b = SINGLE_VENDOR_BINDINGS.deepseek;
  assert(tierEntry('light', b).model === tierEntry('standard', b).model,
    'DeepSeek 只有两个型号，light 与 standard 塌缩——绑定允许塌缩，调用方无感');
}

// ═══════════════════════════════════════════════════════════════════════════
sect('5b. adapter 与力度域绑定在**型号**上而非厂商上');
// ═══════════════════════════════════════════════════════════════════════════

// 机制断言用**合成目录**，与生产目录解耦——否则每次换型号测试都会红，
// 而"能否表达跨协议型号"这个能力与今天配了哪个型号无关。
const MIXED_CATALOG = {
  'openai/new': { vendor: 'openai', model: 'new-model', pricing: { input: 1, output: 2 } },
  'openai/legacy': { vendor: 'openai', model: 'legacy-chat-only', adapter: 'openai-chat', pricing: { input: 1, output: 2 } },
  'openai/pro': { vendor: 'openai', model: 'pro-only-high', efforts: ['high'], pricing: { input: 1, output: 2 } },
  'openai/bogus': { vendor: 'openai', model: 'x', adapter: 'openai-realtime', pricing: { input: 1, output: 2 } },
};
const MIXED = { light: 'openai/new', standard: 'openai/legacy', heavy: 'openai/pro' };
assert(tierEntry('light', MIXED, MIXED_CATALOG).adapter === 'openai-responses'
    && tierEntry('standard', MIXED, MIXED_CATALOG).adapter === 'openai-chat',
  '同一厂商内不同型号可解析到不同协议（例：gpt-5-pro 只存在于 /v1/responses）');
assert(tierEntry('heavy', MIXED, MIXED_CATALOG).model === 'pro-only-high',
  '目录项覆盖力度域时，型号解析不受影响');
assert(openaiResponses.endpoint('m', VENDORS.openai.baseUrl) === 'https://api.openai.com/v1/responses',
  'responses adapter 打到 /v1/responses');
{
  // 引用未实现的 adapter 必须在**解析期**炸掉，而不是拖到线上变成 404
  let msg = '';
  try { new LlmClient({ binding: { light: 'openai/bogus' }, catalog: MIXED_CATALOG, mode: 'live' })._resolve('light'); }
  catch (e) { msg = e.message; }
  assert(msg.includes('unimplemented adapter'), '型号引用未实现的 adapter → 解析期报错，错误信息直指配置', msg);
}
assert(Object.keys(PROVIDERS).includes('openai-chat') && Object.keys(PROVIDERS).includes('openai-responses'),
  `'OpenAI 兼容'实为两个不兼容协议，注册表里必须是两个 adapter（${Object.keys(PROVIDERS).join(', ')}）`);

// 当下的生产目录事实（会随型号更新而变，与上面的机制断言分开）
assert(TIERS.every((t) => tierEntry(t, SINGLE_VENDOR_BINDINGS.openai).adapter === 'openai-responses'),
  'OpenAI 三档全部走 responses —— 新型号在 chat/completions 上不允许 tools 与 reasoning_effort 共存');
assert(tierEntry('standard', SINGLE_VENDOR_BINDINGS.deepseek).adapter === 'openai-chat',
  "反直觉但正确：OpenAI 自己已不走 'openai-chat'，走它的是第三方兼容厂商（adapter 名描述协议而非厂商）");
{
  const stale = /gpt-5-(mini|pro)$|^gpt-5$|deepseek-(chat|reasoner)$|gemini-2\.5/;
  const all = Object.values(MODEL_CATALOG).map((m) => m.model);
  assert(!all.some((m) => stale.test(m)), `目录里没有已知的过期/废弃型号 ID（${all.join(' ')}）`);
  assert(Object.entries(MODEL_CATALOG).every(([, m]) => m.pricing && m.pricing.input > 0 && m.pricing.output > 0),
    '目录里每个型号都有单价——没有价格的型号会让预算闸门失效');
}

// responses 协议的形状差异被吸收
{
  const rq = openaiResponses.buildRequest({ ...withResults,
    messages: withResults.messages.map((m) => m.role === 'assistant'
      ? { ...m, content: parsed.openai.content } : m) }, 'gpt-5-pro');
  assert(rq.instructions === CANON_REQ.system && rq.messages === undefined,
    'responses：system 叫 instructions，且没有 messages 字段（是 input）');
  assert(rq.tools[0].name === 'get_weather' && rq.tools[0].function === undefined,
    'responses：tools 是扁平结构，没有 function 嵌套层');
  const outs = rq.input.filter((i) => i.type === 'function_call_output');
  const wantIds = withResults.messages.at(-1).results.map((r) => r.callId);
  assert(outs.length === 2 && outs.every((o, i) => o.call_id === wantIds[i]) && !rq.input.some((i) => i.role === 'tool'),
    'responses：工具结果是顶层 item 而非消息，且按 call_id 对齐',
    `得到 ${JSON.stringify(outs.map((o) => o.call_id))}`);
  const wire = {
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: '我来查一下。' }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'get_weather', arguments: '{"city":"London"}' },
    ],
    usage: { input_tokens: 412, output_tokens: 88 },
  };
  const p = openaiResponses.parseResponse(wire);
  eq(semanticShape(p), EXPECTED, 'responses 线格式归一到与另外三家完全相同的 canonical 形状');
  assert(p.content[1].id === 'call_a', 'responses：canonical 的 ID 取 call_id 而非 id（回填用的是 call_id）');
  eq(p.usage, { inputTokens: 412, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 88, reasoningTokens: 0 },
    'responses：第四套 usage 字段名被吸收');
  assert(openaiResponses.parseResponse({ ...wire, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
    .stopReason === 'max_tokens', 'responses：没有 finish_reason，用 status + incomplete_details 表达停止原因');
}

// ═══════════════════════════════════════════════════════════════════════════
sect('5c. usage 归一：各家的包含关系互不相同');
// ═══════════════════════════════════════════════════════════════════════════

{
  // Gemini：thoughts 与 candidates **互斥**，必须相加
  const g = gemini.parseResponse({
    candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 18, candidatesTokenCount: 280, thoughtsTokenCount: 292, totalTokenCount: 590 },
  });
  eq(g.usage, { inputTokens: 18, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 572, reasoningTokens: 292 },
    'Gemini：thoughts 与 candidates 互斥 → outputTokens 必须相加（280+292，只读 candidates 会少算 2 倍）');
  assert(g.usage.inputTokens + g.usage.outputTokens === 590,
    '归一后与厂商的 totalTokenCount 对得上（590），证明没有重复计或漏计');

  // OpenAI：cached ⊂ prompt，reasoning ⊂ completion，必须相减
  const o = openai.parseResponse({
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 458, total_tokens: 1458,
      prompt_tokens_details: { cached_tokens: 900 },
      completion_tokens_details: { reasoning_tokens: 448 } },
  });
  eq(o.usage, { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 458, reasoningTokens: 448 },
    'OpenAI：cached ⊂ prompt → inputTokens 必须相减（1000-900），reasoning ⊂ completion → 不能再加');

  // DeepSeek：同一 adapter，另一套缓存字段名
  const d = openai.parseResponse({
    choices: [{ message: { content: 'hi', reasoning_content: 'thinking…' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 279, completion_tokens: 101,
      prompt_cache_hit_tokens: 256, prompt_cache_miss_tokens: 23 },
  });
  assert(d.usage.inputTokens === 23 && d.usage.cacheReadTokens === 256,
    'DeepSeek 用 prompt_cache_hit/miss 表达同一件事，被同一个 adapter 吸收',
    JSON.stringify(d.usage));
  assert(d.content[0].type === 'thinking' && d.content[0].text === 'thinking…',
    'DeepSeek 独有的 reasoning_content 归一为 thinking 块，不污染 textOf');
  eq(textOf(d), 'hi', 'thinking 块不混进正文文本');

  // Anthropic：input 与 cache_* 互斥，thinking ⊂ output
  const a = anthropic.parseResponse({
    content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 14, cache_creation_input_tokens: 3603, cache_read_input_tokens: 0,
      output_tokens: 153, output_tokens_details: { thinking_tokens: 32 } },
  });
  eq(a.usage, { inputTokens: 14, cacheReadTokens: 0, cacheWriteTokens: 3603, outputTokens: 153, reasoningTokens: 32 },
    'Anthropic：input 与 cache_* 互斥，thinking ⊂ output');
  assert(a.content[0].type === 'thinking' && a.content[0].opaque?.signature === 'sig',
    'Anthropic thinking 块连签名一起原样存进 opaque（同模型续轮需回传）');

  // 只读 in/out 会漏掉多少钱
  const price = MODEL_CATALOG['anthropic/claude-opus-5'].pricing;
  const naive = costMicroUsd({ inputTokens: 14, outputTokens: 153 }, price);
  const real = costMicroUsd(a.usage, price);
  assert(real > naive * 5,
    `忽略缓存写入会严重少算：只读 in/out=${fmtUsd(naive)}，计入缓存后=${fmtUsd(real)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
sect('5d. opaque 透传：Gemini 少了 thought_signature 会 HTTP 400');
// ═══════════════════════════════════════════════════════════════════════════

{
  const wire = {
    candidates: [{ content: { parts: [
      { text: '我来查一下。' },
      { functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'SIG_A' },
      { functionCall: { name: 'get_weather', args: { city: 'London' } }, thoughtSignature: 'SIG_B' },
    ] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 64, candidatesTokenCount: 32, thoughtsTokenCount: 135 },
  };
  const p = gemini.parseResponse(wire);
  const calls = p.content.filter((b) => b.type === 'tool_call');
  assert(calls.every((c) => c.opaque?.thoughtSignature),
    'thoughtSignature 被收进 canonical 的 opaque（canonical 不解读，只搬运）');

  // 回填后必须仍带着签名
  const rq = gemini.buildRequest({
    tier: 'standard', maxTokens: 512, tools: TOOLS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Weather?' }] },
      { role: 'assistant', content: p.content },
      { role: 'tool_results', results: calls.map((c) => ({ callId: c.id, name: c.name, content: 'ok' })) },
    ],
  }, 'gemini-3.6-flash');
  const modelParts = rq.contents.find((c) => c.role === 'model').parts;
  const sigs = modelParts.filter((x) => x.functionCall).map((x) => x.thoughtSignature);
  eq(sigs, ['SIG_A', 'SIG_B'],
    '回填的 model 轮里 thoughtSignature 原样带回 —— 少了它 Gemini 3.x 直接 400');
  assert(gemini.parseResponse({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }).stopReason === 'malformed',
    'MALFORMED_FUNCTION_CALL 映射为 malformed（实测：推理耗尽 maxOutputTokens 时报的就是它）');
}

// ═══════════════════════════════════════════════════════════════════════════
sect('5e. effort：与档位正交的第二个旋钮，四家参数名全不同');
// ═══════════════════════════════════════════════════════════════════════════

{
  const req = { tier: 'standard', maxTokens: 512, effort: 'low', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  assert(anthropic.buildRequest(req, 'claude-opus-5').output_config?.effort === 'low',
    'Anthropic：output_config.effort');
  assert(openai.buildRequest(req, 'gpt-5').reasoning_effort === 'low',
    'OpenAI chat：reasoning_effort（DeepSeek 复用同一 adapter，实测同样生效）');
  assert(openaiResponses.buildRequest(req, 'gpt-5-pro').reasoning?.effort === 'low',
    'OpenAI responses：reasoning.effort');
  assert(gemini.buildRequest(req, 'gemini-3.6-flash').generationConfig.thinkingConfig?.thinkingBudget === 512,
    'Gemini：thinkingConfig.thinkingBudget —— 是**数值**不是枚举，adapter 负责换算');

  // 力度可用域也是按型号的 —— 与 adapter 同构的第二个实例
  eq(clampEffort('high', tierEntry('light', SINGLE_VENDOR_BINDINGS.anthropic).efforts), undefined,
    'haiku-4-5 不支持 effort（efforts:[]）→ clamp 成 undefined，参数根本不发（发了就 400）');
  eq(clampEffort('low', tierEntry('heavy', MIXED, MIXED_CATALOG).efforts), 'high',
    '只接受 high 的型号 → 请求 low 被 clamp 上去，而不是发出去挨 400');
  eq(clampEffort('low', tierEntry('heavy').efforts), 'low', '正常档位原样透传');
  eq(clampEffort(undefined, tierEntry('heavy').efforts), undefined, '没请求力度就不发该参数');
  {
    const c = new LlmClient({ binding: SINGLE_VENDOR_BINDINGS.anthropic, mode: 'replay', cassette: '/nonexistent' });
    let msg = '';
    // 这条只验 clamp：不带工具（带工具的调用必须带会话角色，见 core/capabilities.mjs）
    try { await c.complete({ ...CANON_REQ, tools: [], tier: 'light', effort: 'high' }); } catch (e) { msg = e.message; }
    assert(msg.includes('replay miss'), 'client 在构造线请求前完成 clamp（走到 replay 才失败，说明没在 buildRequest 前炸）');
  }

  // 采样参数：canonical 里根本没有这个字段，因此不可能误发
  for (const [name, p] of [['anthropic', anthropic], ['openai-chat', openai], ['gemini', gemini]]) {
    const r = p.buildRequest({ ...req, temperature: 0.7, top_p: 0.9 }, 'm');
    const body = JSON.stringify(r);
    assert(!/temperature|top_p|top_k/.test(body),
      `${name}：canonical 无采样参数字段，即使调用方硬塞也不会进线请求（opus-5/gpt-5 对它们一律 400）`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
sect('5f. 网关通道（OpenRouter 一类）：接入零成本，但失败语义要额外翻译');
// ═══════════════════════════════════════════════════════════════════════════

{
  // 接入点这一层确实零成本：网关就是"另一个说 openai-chat 的 baseUrl"，无新 adapter
  assert(VENDORS.openrouter.adapter === 'openai-chat' && VENDORS.openrouter.baseUrl.includes('openrouter'),
    '网关只是目录里多一条接入点，复用既有 openai-chat adapter（无需任何新适配代码）');
  assert(openai.endpoint('any/model', VENDORS.openrouter.baseUrl) === 'https://openrouter.ai/api/v1/chat/completions',
    'endpoint 由 baseUrl 参数化，adapter 本身不认识任何具体厂商');

  // ⚠️ 但失败语义不是零成本：gemini-3.1-pro-preview 经网关约 1/4 概率
  // 返回 **HTTP 200 + finish_reason:'error'**，真实原因在扩展字段 native_finish_reason。
  // 直连时这是一个明确的错误响应；经网关变成一次"成功"的调用。
  const gw = openai.parseResponse({
    choices: [{ message: { content: null }, finish_reason: 'error', native_finish_reason: 'MALFORMED_FUNCTION_CALL' }],
    usage: { prompt_tokens: 90, completion_tokens: 512 },
  });
  eq(gw.stopReason, 'malformed',
    "网关的 finish_reason:'error' 经 native_finish_reason 翻译回 canonical 的 malformed —— 不翻译就会被当成正常收尾");
  eq(gw.stopDetails, { native: 'MALFORMED_FUNCTION_CALL' },
    '原始 native 码留在 stopDetails 里，归因不丢');
  assert(!STOP_REASONS.includes('error'),
    "'error' 不是 canonical 的合法停止原因 —— 若某天出现未知 native 码，会以陌生值透出而非静默归为 end_turn");

  const unknown = openai.parseResponse({
    choices: [{ message: { content: null }, finish_reason: 'error', native_finish_reason: 'SOMETHING_NEW' }],
  });
  eq(unknown.stopReason, 'error', '映射不到的 native 码不猜，原样透出让上层看见');
  eq(unknown.stopDetails, { native: 'SOMETHING_NEW' }, '陌生 native 码同样保留在 stopDetails');

  // 直连路径不受影响：没有 native_finish_reason 时行为与从前完全一致
  const direct = openai.parseResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
  eq(direct.stopReason, 'end_turn', '直连响应无 native 字段，翻译逻辑不介入');
  eq(direct.stopDetails, null, '直连时 stopDetails 保持 null');

  // ── 记账口径：网关按**回报的实际计费**，不按目录单价 ──────────────────────
  const gwReq = openai.buildRequest({ ...CANON_REQ, gateway: true, providerPrefs: { only: ['anthropic'] } }, 'anthropic/claude-opus-5');
  eq(gwReq.usage, { include: true }, '网关请求带 usage:{include:true}，要它回报实际计费');
  eq(gwReq.provider, { only: ['anthropic'] }, '上游偏好原样透传给网关');
  const plain = openai.buildRequest(CANON_REQ, 'deepseek-v4-flash');
  assert(plain.usage === undefined && plain.provider === undefined,
    '直连请求不带这两个字段（厂商端点不认识，发了是多余风险）');

  const gwResp = openai.parseResponse({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    provider: 'DeepInfra',
    usage: { prompt_tokens: 2057, completion_tokens: 8, cost: 0.000111762,
      prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 0 } },
  });
  eq(gwResp.reportedMicroUsd, 112, '回报的实际计费归一成微美元整数');
  eq(gwResp.upstream, 'DeepInfra', '本次实际上游写进响应，供账本审计');
  assert(gwResp.usage.cacheReadTokens === 1024 && gwResp.usage.inputTokens === 1033,
    '钉住上游后缓存分解**完整可见**（此前"分解丢失"的结论是未钉上游导致的假象）',
    JSON.stringify(gwResp.usage));

  // 账本落地：同一份 usage，两种口径记出不同的钱
  const GW = { 'gw/x': { vendor: 'openrouter', model: 'anthropic/claude-opus-5', pricing: { input: 5, output: 25, cacheRead: 0.5 } } };
  const acct = (billing) => {
    const c = new LlmClient({ binding: { light: 'gw/x' }, catalog: { 'gw/x': { ...GW['gw/x'], billing } } });
    c._account(gwResp, 'light', { ...tierEntry('light', { light: 'gw/x' }, { 'gw/x': { ...GW['gw/x'], billing } }) });
    return c.ledger[0];
  };
  const rep = acct('reported'), com = acct('computed');
  eq(rep.microUsd, 112, "billing:'reported' → 记回报值");
  assert(com.microUsd !== rep.microUsd,
    `billing:'computed' → 按目录单价算，与实际计费不同（${com.microUsd} vs ${rep.microUsd} 微美元）`);
  eq(rep.upstream, 'DeepInfra', '账本记下本次上游是谁');

  // 安全兜底：声明按回报计费却没回报，且无兜底单价 → 拒绝入账，不按 0 计
  {
    const noPrice = { 'gw/y': { vendor: 'openrouter', model: 'm', billing: 'reported' } };
    const c = new LlmClient({ binding: { light: 'gw/y' }, catalog: noPrice });
    let msg = '';
    try { c._account({ usage: {} }, 'light', tierEntry('light', { light: 'gw/y' }, noPrice)); } catch (e) { msg = e.message; }
    assert(msg.includes('拒绝按 0 入账'), '回报缺失且无兜底单价 → 抛错，绝不静默按 0 计（预算闸门是安全机制）');
  }

  // 上游偏好是**可选**的：不填走默认路由，代码不强制
  assert(tierEntry('light', { light: 'openrouter/claude-opus-5' }).providerPrefs === undefined,
    '目录项可以不钉上游 —— 用哪家上游是用户的选择，代码只披露差异不做禁止');
  assert(tierEntry('light', { light: 'openrouter/claude-opus-5@anthropic' }).providerPrefs?.only?.[0] === 'anthropic',
    '要钉也钉得住，同一型号可并存"钉死版"与"默认路由版"两条目录项');
}

// ═══════════════════════════════════════════════════════════════════════════
sect('5g. 缓存断点：canonical 只表达"到这里为止稳定"，各家落法完全不同');
// ═══════════════════════════════════════════════════════════════════════════

{
  const base = { tier: 'standard', maxTokens: 512, system: 'CONSTITUTION',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

  // Anthropic 是四家里唯一的**显式**缓存：不挂断点则永远 0 命中
  const plain = anthropic.buildRequest(base, 'claude-opus-5');
  eq(plain.system, 'CONSTITUTION', '不要求缓存时 system 仍是纯字符串（不平白改变线格式）');
  const marked = anthropic.buildRequest({ ...base, cacheSystem: true }, 'claude-opus-5');
  eq(marked.system, [{ type: 'text', text: 'CONSTITUTION', cache_control: { type: 'ephemeral' } }],
    '要缓存时 system 必须转成**块数组**——字符串形式挂不上 cache_control');

  // 块级断点：稳定段与易变段分块，断点打在稳定段末尾
  const seg = anthropic.buildRequest({ ...base, messages: [{ role: 'user', content: [
    { type: 'text', text: 'STABLE', cache: true }, { type: 'text', text: 'VOLATILE' }] }] }, 'claude-opus-5');
  eq(seg.messages[0].content[0].cache_control, { type: 'ephemeral' }, '稳定段带断点');
  assert(seg.messages[0].content[1].cache_control === undefined, '易变段不带断点');

  // 其余三家是自动缓存，canonical 的缓存意图对它们**无线格式影响**
  for (const [name, p, model] of [['openai-chat', openai, 'gpt-5.6-luna'],
    ['openai-responses', openaiResponses, 'gpt-5-pro'], ['gemini', gemini, 'gemini-3.6-flash']]) {
    const body = JSON.stringify(p.buildRequest({ ...base, cacheSystem: true }, model));
    assert(!/cache_control/.test(body), `${name}：自动缓存，不发 cache_control（发了是无效字段）`);
  }

  // OpenAI 的缓存路由键：两个协议都要，且默认不发
  assert(openai.buildRequest(base, 'm').prompt_cache_key === undefined
    && openaiResponses.buildRequest(base, 'm').prompt_cache_key === undefined,
    '未指定 cacheKey 时不发该字段');
  eq(openai.buildRequest({ ...base, cacheKey: 'orch-1' }, 'm').prompt_cache_key, 'orch-1',
    'openai-chat：cacheKey → prompt_cache_key');
  eq(openaiResponses.buildRequest({ ...base, cacheKey: 'orch-1' }, 'm').prompt_cache_key, 'orch-1',
    'openai-responses：同一字段名');

  // 缓存门槛作用于**被缓存的那一段**，不是整个提示词。
  // 断点打在门槛之下 = 静默失效（请求成功、无警告、缓存全无），这条只能靠约定防。
  assert(CACHE_FLOORS.anthropic > CACHE_FLOORS.deepseek * 8,
    `缓存门槛跨厂商差一个数量级（deepseek ${CACHE_FLOORS.deepseek} vs anthropic ${CACHE_FLOORS.anthropic}）——` +
    '"上下文小"在一家能缓存，在另一家完全无效');
}

// ═══════════════════════════════════════════════════════════════════════════
sect('6. record/replay：无 key 也能跑确定性回归');
// ═══════════════════════════════════════════════════════════════════════════

// 磁带写在临时目录（原来写进 fixtures/、靠 .gitignore 挡着不进库）
const CASSETTE_DIR = mkdtempSync(join(tmpdir(), 'si-llm-'));
const CASSETTE = join(CASSETTE_DIR, 'test-cassette.jsonl');
process.on('exit', () => { try { rmSync(CASSETTE_DIR, { recursive: true, force: true }); } catch { /* 尽力 */ } });
{
  // 按 client 内部相同的规则算 key，手工灌一条磁带
  const wireReq = anthropic.buildRequest(CANON_REQ, tierEntry('standard', SINGLE_VENDOR_BINDINGS.anthropic).model);
  const key = createHash('sha256').update(JSON.stringify({ p: 'anthropic', a: 'anthropic', r: wireReq })).digest('hex').slice(0, 16);
  writeFileSync(CASSETTE, JSON.stringify({ key, provider: 'anthropic', response: WIRE.anthropic }) + '\n');
}
const replayClient = new LlmClient({ binding: SINGLE_VENDOR_BINDINGS.anthropic, mode: 'replay', cassette: CASSETTE });
const replayed = await replayClient.complete(CANON_REQ);
eq(semanticShape(replayed), EXPECTED, 'replay 模式复现录制响应，零网络零 key');

let missThrew = '';
try {
  await replayClient.complete({ ...CANON_REQ, maxTokens: 999 });
} catch (e) { missThrew = e.message; }
assert(missThrew.includes('replay miss'), '请求变化导致 key 变化 → 明确报 replay miss，不静默返回旧响应');

// ═══════════════════════════════════════════════════════════════════════════
sect('7. 执行 loop：端到端跑通（fake provider，完全确定性）');
// ═══════════════════════════════════════════════════════════════════════════

const fake = makeFake([
  parsed.anthropic,                                    // 第一轮：两个并行工具调用
  { stopReason: 'end_turn',                            // 第二轮：拿到结果后收尾
    content: [{ type: 'text', text: '巴黎 18°C 晴，伦敦 14°C 阴。' }],
    usage: { inputTokens: 600, outputTokens: 40 } },
]);
const fakeClient = new LlmClient({ mode: 'fake', fake });

const called = [];
const { resp, messages, trace, stopped } = await runToolLoop(fakeClient, CANON_REQ, {
  get_weather: async ({ city }) => { called.push(city); return city === 'Paris' ? '18°C 晴' : '14°C 阴'; },
});

eq(called, ['Paris', 'London'], 'loop 并行执行了两个工具调用');
assert(stopped === 'end_turn', 'loop 在 end_turn 时正确终止');
assert(trace.length === 2, `loop 恰好两轮（实际 ${trace.length}）`);
const trMsg = messages.find((m) => m.role === 'tool_results');
assert(trMsg && trMsg.results.length === 2, '两个结果聚合进一条 tool_results 消息');
assert(resp.content[0].text.includes('18°C'), '最终响应包含工具结果');

const fake2 = makeFake([{ stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'x', name: 'nope', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } },
                        { stopReason: 'end_turn', content: [{ type: 'text', text: '好的' }], usage: { inputTokens: 1, outputTokens: 1 } }]);
const c2 = new LlmClient({ mode: 'fake', fake: fake2 });
const r2 = await runToolLoop(c2, CANON_REQ, {});
const errRes = r2.messages.find((m) => m.role === 'tool_results')?.results[0];
assert(errRes?.isError === true, '未知工具被转成 isError 结果回填，而不是抛异常中断 loop');

// stopReason 说要调工具但一个调用都没有 —— 实测 claude-opus-5 约 1/8 概率如此
{
  const empty = () => ({ stopReason: 'tool_call', content: [{ type: 'thinking', text: '…' }, { type: 'text', text: 'ok' }], usage: { inputTokens: 1, outputTokens: 1 } });
  // 重试一次后恢复正常
  const cA = new LlmClient({ mode: 'fake', fake: makeFake([empty(), parsed.anthropic,
    { stopReason: 'end_turn', content: [{ type: 'text', text: '完成' }], usage: { inputTokens: 1, outputTokens: 1 } }]) });
  const rA = await runToolLoop(cA, CANON_REQ, { get_weather: async () => 'ok' });
  assert(rA.stopped === 'end_turn' && !rA.messages.some((m) => m.role === 'tool_results' && !m.results.length),
    '空工具轮被重试掉，且**绝不**产生空的 tool_results 消息（厂商会在下一轮才 400）');
  // 连续为空则如实透出，不伪装成正常收尾
  const cB = new LlmClient({ mode: 'fake', fake: makeFake([empty(), empty(), empty()]) });
  const rB = await runToolLoop(cB, CANON_REQ, {});
  assert(rB.stopped === 'tool_call_without_calls',
    '连续空工具轮 → 返回独立的 stopped 码交给上层升级，而不是当成 end_turn');
}

// ═══════════════════════════════════════════════════════════════════════════
sect('8. 花费账本：按钱计，单价挂在型号上');
// ═══════════════════════════════════════════════════════════════════════════

{
  const p = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };   // opus-5
  eq(costMicroUsd({ inputTokens: 1e6, outputTokens: 1e5 }, p), 5_000_000 + 2_500_000,
    '计价 = Σ(各类 token × 该类单价)，单位微美元整数（无浮点漂移）');
  eq(costMicroUsd({ inputTokens: 1e6, cacheReadTokens: 1e6 }, p), 5_000_000 + 500_000,
    '缓存命中按 cacheRead 单价计（opus-5 是原价的 1/10）——旧口径完全看不见这笔');

  // 旧的"档位倍率"为何废弃：输出/输入价比各家不同，全局 k 表达不了
  // 价格会变（DeepSeek 调过一次价，原来写死的数字就过时了），所以从当前目录现算 —— 钉住的是"各家比值不同"这一结论
  const ratio = (k) => MODEL_CATALOG[k].pricing.output / MODEL_CATALOG[k].pricing.input;
  const ratios = Object.entries(SINGLE_VENDOR_BINDINGS).map(([v, b]) => [v, Math.round(ratio(b.heavy) * 100) / 100]);
  assert(new Set(ratios.map(([, r]) => r)).size > 1,
    `输出/输入价比各家不同（${ratios.map(([v, r]) => `${v} ${r}:1`).join('，')}）——单一全局 k 系数无法成立`);

  // 跨厂商绑定下"档位倍率"连定义都没有：从当前目录里找一对"低档比另一家的高档贵"的反例
  const price = (k) => costMicroUsd({ inputTokens: 1e6 }, MODEL_CATALOG[k].pricing);
  let inversion = null;
  for (const [va, ba] of Object.entries(SINGLE_VENDOR_BINDINGS)) for (const [vb, bb] of Object.entries(SINGLE_VENDOR_BINDINGS)) {
    if (va === vb) continue;
    for (const [i, lo] of TIERS.entries()) for (const hi of TIERS.slice(i + 1)) {
      if (!inversion && price(ba[lo]) > price(bb[hi])) inversion = { lo: `${ba[lo]}（${lo}）`, hi: `${bb[hi]}（${hi}）`, a: price(ba[lo]), b: price(bb[hi]) };
    }
  }
  assert(!!inversion, inversion
    ? `跨厂商绑定时低档可能比高档贵（${inversion.lo} ${fmtUsd(inversion.a)} > ${inversion.hi} ${fmtUsd(inversion.b)}）——"档位倍率"在此失去意义`
    : '跨厂商绑定时低档可能比高档贵（当前目录里没找到反例）');

  // 缺价格必须炸，不能按 0 入账
  let msg = '';
  try { costMicroUsd({ inputTokens: 1000 }, undefined); } catch (e) { msg = e.message; }
  assert(msg.includes('missing pricing'),
    '没有单价的型号直接抛错，绝不按 0 计——否则用户新增模型后预算闸门会静默失效');
}
assert(fakeClient.ledger.length === 2 && fakeClient.ledger.every((e) => 'microUsd' in e),
  `loop 全程记账：${fakeClient.ledger.length} 次调用，账本条目带 microUsd 字段`);

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
sect('9. 工具结果带图片（验收员看截图）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const IMG = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  const withImg = { ...withResults, messages: withResults.messages.map((m) => (m.role === 'tool_results'
    ? { ...m, results: [{ ...m.results[0], images: [IMG] }, m.results[1]] } : m)) };
  const a = anthropic.buildRequest(withImg, 'claude-sonnet-5').messages.find((m) => m.content?.[0]?.type === 'tool_result');
  eq([a.content[0].content.map((b) => b.type), a.content[0].content[1].source.media_type, typeof a.content[1].content],
    [['text', 'image'], 'image/png', 'string'], 'Anthropic：图放进同一个 tool_result 的内容数组；不带图的结果仍是字符串');
  const oaMsgs = openai.buildRequest({ ...withImg, messages: withImg.messages.map((m) => (m.role === 'assistant' ? { ...m, content: parsed.openai.content } : m)) }, 'gpt-5').messages;
  const iTool = oaMsgs.findIndex((m) => m.role === 'tool');
  eq([oaMsgs[iTool].content, oaMsgs[iTool + 1].role, oaMsgs[iTool + 2].role, oaMsgs[iTool + 2].content[1].image_url.url.slice(0, 22)],
    ['巴黎 18°C 晴', 'tool', 'user', 'data:image/png;base64,'], 'OpenAI chat：role:"tool" 只放文字，图在全部工具结果之后单独一条 user 消息（data URL）');
  const rs = openaiResponses.buildRequest(withImg, 'gpt-5.6-terra').input.filter((x) => x.type === 'function_call_output');
  eq([rs[0].output.map((o) => o.type), typeof rs[1].output], [['input_text', 'input_image'], 'string'], 'OpenAI responses：function_call_output 的 output 用内容数组');
  const g = gemini.buildRequest({ ...withImg, messages: withImg.messages.map((m) => (m.role === 'assistant' ? { ...m, content: parsed.gemini.content } : m)) }, 'gemini-3.6-flash')
    .contents.find((c) => c.parts.some((p) => p.functionResponse));
  eq(g.parts.map((p) => Object.keys(p)[0]), ['functionResponse', 'functionResponse', 'inlineData'], 'Gemini：图作为 inlineData 跟在函数结果后面');
  const stripped = withoutImages(withImg).messages.find((m) => m.role === 'tool_results').results[0];
  assert(!stripped.images && stripped.content.includes('1 张图片已略去'), '不收图片的模型：图换成一句说明，不静默丢');
  eq(withoutImages(withResults), withResults, '没有图片时原样返回');

  const fk = makeFake([parsed.anthropic, { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 1, outputTokens: 1 } }]);
  const lr = await runToolLoop(new LlmClient({ mode: 'fake', fake: fk }), CANON_REQ, { get_weather: async ({ city }) => (city === 'Paris' ? { text: '截图如下', images: [IMG] } : '14°C') });
  const tr = lr.messages.find((m) => m.role === 'tool_results').results;
  eq([tr[0].content, tr[0].images?.length, tr[1].content, 'images' in tr[1]], ['截图如下', 1, '14°C', false], '处理器返回 { text, images }：文字进 content、图进 images');
  assert(!JSON.stringify(lr.trace).includes(IMG.data), '图片不进 trace（trace 会落库 / 写叙事）');

  eq([tierEntry('standard', { standard: 'openrouter/kimi-k3@moonshotai' }).vision, tierEntry('standard', { standard: 'deepseek/deepseek-flash' }).vision,
    tierEntry('standard', { standard: 'deepseek/deepseek-v4-pro' }).vision],
    [true, true, false], '目录：Kimi K3、deepseek-flash 收图（2026-10-14 实测核实）；v4-pro 实测收不到图，不标');
}

console.log(`\n${'='.repeat(74)}\nPASS=${pass}  FAIL=${fail}\n${'='.repeat(74)}\n`);
process.exit(fail === 0 ? 0 : 1);
