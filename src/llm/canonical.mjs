// 规范化的（厂商中立的）请求/响应表示 —— 多厂商适配的核心。
//
// 设计要点：canonical 层的形状必须按"最严格的厂商"来定，而不是按最方便的厂商。
// 具体见 tool_results 的注释——选错方向会让 Anthropic 侧静默退化。

/**
 * 规范请求：
 * {
 *   tier: 'light'|'standard'|'heavy',   // 档位是抽象槽，不写死模型
 *   system?: string,
 *   messages: CanonMessage[],
 *   tools?: CanonTool[],
 *   maxTokens: number,
 *   effort?: 'low'|'medium'|'high'      // 各厂商语义不同，由 provider 翻译或丢弃
 * }
 *
 * CanonMessage:
 *   { role: 'user',      content: CanonBlock[] }
 *   { role: 'assistant', content: CanonBlock[] }
 *   { role: 'tool_results', results: CanonToolResult[] }
 *
 * CanonBlock:
 *   { type: 'text', text }
 *   { type: 'tool_call', id, name, args, opaque? }   // args 恒为已解析对象，永不是 JSON 字符串
 *   { type: 'thinking', text, opaque? }              // 推理内容；text 可能为空（各家默认不返回原文）
 *
 * CanonToolResult: { callId, name, content, isError? }
 *
 * ⚠️ `opaque`：厂商要求**原样回传**的不透明状态，canonical 只搬运不解读。
 * 实测：Gemini 3.x 的 functionCall 缺少 thought_signature 回传时**直接 HTTP 400**
 * （"required for tools to work correctly"）；Anthropic 丢弃 thinking 块不报错但
 * 可能损失推理连续性。硬失败与软退化都要靠这个字段承载 —— 没有它，多轮工具循环
 * 在 Gemini 上根本跑不起来。
 *
 * ⚠️ canonical **故意没有 temperature / top_p / top_k**。实测 claude-opus-5 与 gpt-5
 * 对这三个参数一律 400（"deprecated for this model" / "only the default value is
 * supported"）。前沿模型已把采样参数移除，改用 effort 控制。canonical 若提供该字段，
 * 就是在鼓励调用方写出只能在旧模型上跑的代码。
 *
 * ⚠️ 关键设计决策：一条 tool_results 消息承载**全部**并行工具结果。
 * Anthropic 要求同一轮的多个 tool_result 必须在**同一条** user 消息里，拆成多条会
 * 训练模型放弃并行调用；OpenAI 则要求**每个结果一条** role:'tool' 消息。
 * 若 canonical 按 OpenAI 的"一结果一消息"来设计，Anthropic 侧就会静默退化。
 * 故 canonical 取"聚合"形状，由 OpenAI adapter 负责扇出。
 */

import { ConfigError } from '../core/errors.mjs';   // 无依赖的叶子模块；tierEntry 用它报"绑定 / 目录配错了"

export const TIERS = ['light', 'standard', 'heavy'];

/**
 * 缓存最小长度（token）—— 实测值，非文档值。
 *
 * ⚠️ 门槛作用于**被缓存的那一段**，不是整个提示词：断点打在 3800 token 处而该模型
 * 门槛是 4096，则缓存静默失效——请求成功、无任何警告、命中恒为 0。装配层排段落
 * 顺序时必须拿这张表校验稳定段长度，否则会做出"看起来很合理但一点不省钱"的配方。
 *
 * ⚠️ 跨厂商差 30 倍，且**按模型不按厂商**（gemini 轻档实测到 16k 都不缓存，
 * 标准档约 1.2 万起）。"上下文要小"这条设计取向在 deepseek 上不影响缓存，
 * 在 anthropic/gemini 上等于放弃缓存。
 *
 * ⚠️ openai 记 Infinity 不是笔误：实测它**不做前缀复用**，6088 token 的共享前缀
 * 换个尾部即归零，只有完全相同的请求才命中（两个模型、三种长度、带/不带
 * prompt_cache_key 均复现）。对 agent 负载（每轮尾部必变）等同于没有缓存。
 */
export const CACHE_FLOORS = {
  deepseek: 400,
  openai: Infinity,
  anthropic: 4096,   // 实测落在 3243~4857 之间（claude-haiku-4-5）
  gemini: 12000,     // 实测落在 9318~12421 之间（gemini-3.6-flash）；轻档不缓存
};

/**
 * 注册表分三层 —— 因为"用户可跨厂商自选各档模型"这个需求，档位不能再嵌在厂商里。
 * 这三个常量都是**默认值**，生效值 = 默认值 ⊕ 库里的 llm_endpoints / llm_models / llm_bindings
 * （src/llm/registry.mjs）。改这里只改"新部署的出厂设置"，不改已有部署的行为。
 *
 *   ① VENDORS      服务商：协议 + 凭证 + 端点。加一家厂商 = 加一条。
 *   ② MODEL_CATALOG 模型目录：每条**自描述**（属于哪个服务商、协议覆盖、推理强度取值、单价）。
 *                   这一层是"添加新模型"界面写入的数据，用户可增删改。
 *   ③ TIER_BINDING  档位绑定：档位 → 目录键。**可跨厂商**，用户可改。
 *
 * 为什么必须拆成三层：档位若嵌在厂商下（旧结构），就只能"选一家的三档"，
 * 无法表达"light 用 DeepSeek、heavy 用 Anthropic"。而按角色/成本混搭恰恰是
 * 多厂商适配的主要收益——独立验收员用与执行器不同的厂商才是真正的独立评审。
 *
 * ⚠️ 目录项里 `adapter` 与 `efforts` 都是**按模型**声明的（同一厂商的不同模型可能走不同适配、支持不同推理档）：
 * 同一厂商内不同模型可能说不同协议（gpt-5-pro 只在 /v1/responses），
 * 推理强度取值也按模型不同（claude-haiku-4-5 完全不支持 effort）。省略则继承服务商默认。
 *
 * adapter 与厂商是多对一：所有"OpenAI 兼容"端点（DeepSeek / Moonshot / 通义 /
 * OpenRouter / 本地 vLLM）共用 'openai-chat'。注意"OpenAI 兼容"指的**永远是
 * chat/completions 这个旧协议**，没有第三方兼容 responses。一个反直觉的后果：
 * OpenAI 自己已经不走 'openai-chat' 了（新模型在该端点上不允许 tools+effort 共存），
 * 走那条路的全是第三方。**adapter 名描述协议，不描述厂商。**
 */
// ⚠️ 规则：**VENDORS 的 id 与 MODEL_CATALOG 的键只增不删**。部署的库里可能存着对它们的覆盖行（只存改过的字段，
// 其余继承这里），键一删，那些行就成了没有 adapter / vendor 的孤儿 —— registry.mjs 会把它们标成 orphan、不许用、只许删，
// 但绑着它的档位当场失效。模型退役：保留键，在 notes 里写明，必要时把默认绑定换走。
export const VENDORS = {
  anthropic: { adapter: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', baseUrl: 'https://api.anthropic.com/v1' },
  // ⚠️ 默认协议是 responses 而非 chat —— 实测 gpt-5.4 及以后的模型在
  // /v1/chat/completions 上**不允许 tools 与 reasoning_effort 同时出现**：
  //   400 "Function tools with reasoning_effort are not supported for gpt-5.5
  //        in /v1/chat/completions. To use function tools, use /v1/responses"
  openai: { adapter: 'openai-responses', keyEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1' },
  deepseek: { adapter: 'openai-chat', keyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1' },
  gemini: { adapter: 'gemini', keyEnv: 'GEMINI_API_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  // 聚合网关。实测验证后**不再是"退化通道"**：tools+effort 与 Gemini 的
  // thought_signature 都由它在服务端兜住，钉住上游后缓存分解也完整可见。
  //
  // ⚠️ gateway:true 有两个实际后果，见 openai-chat adapter：
  //   ① 请求带 `usage:{include:true}` + `provider` 偏好
  //   ② 记账走 billing:'reported' —— 用它回报的**实际计费**，不用我们的单价表
  // 为什么记账必须换口径：同一个模型 ID 背后有 20 家上游，单价差 1.6 倍、缓存价差
  // 35 倍、还有的根本没有缓存。"一个模型一份单价"在网关上不成立，算不准；而它
  // 每次都回报 usage.cost，那是真金白银的数，比我们自己的表更准。
  openrouter: {
    adapter: 'openai-chat', keyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    gateway: true, billing: 'reported',
  },
};

/**
 * 推理强度档（effort）—— 与档位（tier）**正交**的第二个旋钮。
 * 各家参数名与取值域完全不同，由 adapter 翻译：
 *   anthropic       → output_config.effort
 *   openai-chat     → reasoning_effort（DeepSeek 同样认）
 *   openai-responses→ reasoning.effort
 *   gemini          → generationConfig.thinkingConfig.thinkingBudget（**数值**，不是枚举）
 */
export const EFFORTS = ['low', 'medium', 'high'];
export const GEMINI_THINKING_BUDGET = { low: 512, medium: 4096, high: 16384 };

/**
 * 模型目录。`pricing` 单位是 **USD / 百万 token**，四项与 canonical usage 的四个
 * 计费字段一一对应（reasoningTokens 不单独计价，已含在 output 里）。
 * 价格取自 OpenRouter 公开 models API（无需 key），与各家官网口径一致。
 *
 * ⚠️ 定价与模型 ID 一样会过期，且过期方式更隐蔽（不会报错，只是账算错）。
 * `scripts/check-models.mjs` 同时核对两者。
 */
export const MODEL_CATALOG = {
  // ── Anthropic ────────────────────────────────────────────────────────────
  'anthropic/claude-haiku-4-5': {
    vendor: 'anthropic',
    // 用带日期的钉死版本：`claude-haiku-4-5` 是能调通但**不在 /models 列表里**的
    // 别名（check-models.mjs 首次运行即抓到）。opus-5 / sonnet-5 的无日期名是列出的，
    // 只有 haiku 这一档不是——同一厂商内的命名约定都不统一，只能逐个核。
    model: 'claude-haiku-4-5-20251001',
    // 实测 400 "This model does not support the effort parameter."
    efforts: [],
    pricing: { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
    notes: ['2025-10 发布，暂无后继的轻量模型；不支持 effort 参数，无法通过提高推理强度升档'],
  },
  'anthropic/claude-sonnet-5': {
    vendor: 'anthropic', model: 'claude-sonnet-5',
    pricing: { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
  },
  'anthropic/claude-opus-5': {
    vendor: 'anthropic', model: 'claude-opus-5',
    pricing: { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
    notes: ['启用 thinking 时约 1/8 的响应为 stop_reason=tool_use 但不含 tool_use 块；系统按空工具调用自动重试'],
  },
  'anthropic/claude-fable-5': {
    vendor: 'anthropic', model: 'claude-fable-5',
    pricing: { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
    notes: ['定位高于 opus-5；默认未分配到任何档位'],
  },
  // ── OpenAI（gpt-5.6 三档族：Sol 旗舰 / Terra 均衡 / Luna 高性价比）─────────
  'openai/gpt-5.6-luna': {
    vendor: 'openai', model: 'gpt-5.6-luna',
    pricing: { input: 1.00, output: 6.00, cacheRead: 0.10, cacheWrite: 1.25 },
  },
  'openai/gpt-5.6-terra': {
    vendor: 'openai', model: 'gpt-5.6-terra',
    pricing: { input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 3.125 },
  },
  'openai/gpt-5.6-sol': {
    vendor: 'openai', model: 'gpt-5.6-sol',
    pricing: { input: 5.00, output: 30.00, cacheRead: 0.50, cacheWrite: 6.25 },
  },
  // ── DeepSeek ─────────────────────────────────────────────────────────────
  // contextWindow：厂商文档核实过的窗口（token）。没核实过的模型**不填**，limits.context_tokens 退回保守常数。
  // DeepSeek：api-docs.deepseek.com/quick_start/pricing，2026-09-19 抓取：
  //   - 两档 CONTEXT LENGTH 1M、MAX OUTPUT 384K；
  //   - 标价分峰时（UTC 01:00–04:00、06:00–10:00 工作日）/ 谷时两档，谷时是峰时的一半。**目录记峰时**（上界：账本宁可算多不算少），
  //     所以谷时跑的任务账本会高估约一倍；按时段计价尚未实现；
  //   - `deepseek-v4-flash` 已退役：请求由 DeepSeek-V4.1-Flash 代答、按 Flash 计价，正式名 `deepseek-flash`。旧键保留（绑定 /
  //     旧账本 / 测试还在引用），价格与新键相同；默认绑定改用新键。
  //   此前的价格（flash 0.14/0.28、pro 0.435/0.87）是 2026-07 的旧价，2026-09 之前的账本按旧价算，**偏低**，见 docs/known-limits.md。
  'deepseek/deepseek-flash': {
    vendor: 'deepseek', model: 'deepseek-flash', contextWindow: 1_000_000,
    pricing: { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 },
    notes: ['DeepSeek-V4.1-Flash；所列为峰时单价，谷时减半', '输出与输入单价比为 4:1'],
  },
  'deepseek/deepseek-v4-flash': {
    vendor: 'deepseek', model: 'deepseek-v4-flash', contextWindow: 1_000_000,
    pricing: { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 },
    notes: ['已退役（2026-09）：请求由 DeepSeek-V4.1-Flash 响应并按其单价计费；新配置请使用 deepseek/deepseek-flash'],
  },
  'deepseek/deepseek-v4-pro': {
    vendor: 'deepseek', model: 'deepseek-v4-pro', contextWindow: 1_000_000,
    pricing: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
    notes: ['DeepSeek-V4-Pro-0813；所列为峰时单价，谷时减半；2026-09-14 后继续提供 API'],
  },
  // ── Gemini ───────────────────────────────────────────────────────────────
  'gemini/gemini-3.5-flash-lite': {
    vendor: 'gemini', model: 'gemini-3.5-flash-lite',
    pricing: { input: 0.30, output: 2.50, cacheRead: 0.03, cacheWrite: 0.0833 },
  },
  'gemini/gemini-3.6-flash': {
    vendor: 'gemini', model: 'gemini-3.6-flash',
    pricing: { input: 1.50, output: 7.50, cacheRead: 0.15, cacheWrite: 0.0833 },
    notes: ['Gemini 3.x 的多轮工具调用必须原样回传 thought_signature，否则返回 HTTP 400'],
  },
  'gemini/gemini-3.1-pro-preview': {
    vendor: 'gemini', model: 'gemini-3.1-pro-preview',
    pricing: { input: 2.00, output: 12.00, cacheRead: 0.20, cacheWrite: 0.375 },
    notes: ['preview 模型，可能下线（gemini-3-pro-preview 已返回 404）', 'thinking 占用 maxOutputTokens；额度不足时返回 MALFORMED_FUNCTION_CALL 而非 MAX_TOKENS'],
  },
  // ── 网关（示例项，展示"用户添加模型"这条路径长什么样）─────────────────────
  // 这两条不是推荐配置，是**两种合法选择各一个样本**：钉死上游 vs 用默认路由。
  // 走哪条由用户在界面上选，代码不做限制——只负责把差异如实呈现出来。
  // 适用于 Anthropic / OpenAI / Gemini 直连与经网关都被地区拦截的部署：能通的高端模型里 Kimi K3 是一个选择。
  // 钉死 Moonshot 官方上游（它自己的 mxfp4 量化版；第三方有 bf16 但最大输出只有 16384，装不下我们的推理预算）。
  // 实测：推理算在 max_tokens 内、超了按 length 截断（与 DeepSeek 不同，DeepSeek 不受预算限制）；reasoning_effort 认。
  'openrouter/kimi-k3@moonshotai': {
    vendor: 'openrouter', model: 'moonshotai/kimi-k3',
    providerPrefs: { only: ['moonshotai'] },
    pricing: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 0 },   // 兜底；记账走网关回报
    notes: ['输出单价约为直连 DeepSeek-pro 的 17 倍；推理 token 计入输出 token，需预留足够的 maxTokens'],
  },
  'openrouter/claude-opus-5@anthropic': {
    vendor: 'openrouter', model: 'anthropic/claude-opus-5',
    providerPrefs: { only: ['anthropic'] },     // 钉死厂商官方：与直连同一上游
    pricing: { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },  // 仅作回报缺失时的兜底
    notes: ['固定上游为 Anthropic，行为与直连一致，多经过一层网关；计费与余额在网关侧'],
  },
  'openrouter/claude-opus-5': {
    vendor: 'openrouter', model: 'anthropic/claude-opus-5',
    // 不填 providerPrefs = 用网关默认路由。代价（上游身份/量化/上下文上限浮动）
    // 由界面披露，不由代码禁止——这是用户的选择，不是我们的规矩。
    pricing: { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
    notes: ['默认路由：实测由 Amazon Bedrock / Azure / Google Vertex 等 7 个上游之一响应',
      '上游与直连不同，直连不可用时可作为备用通路'],
  },
};

/**
 * 档位绑定 —— **可跨厂商**。这是部署级配置，由有权限的用户改。
 * 默认落位体现角色分工：执行器（调用量最大）走最便宜的一档。
 * 这只是**默认值**：生效绑定在库里（llm_bindings，registry.mjs 叠加），init 会把默认值显式写进去。
 */
export const TIER_BINDING = {
  light: 'deepseek/deepseek-flash',
  standard: 'deepseek/deepseek-flash',
  heavy: 'anthropic/claude-opus-5',
};

/**
 * 单厂商绑定 —— 用于"只配了一家 key"的场景与逐厂商实测矩阵。
 * 显式声明而非按目录顺序取：DeepSeek 只有两个模型，位置取值会得出 flash/pro/pro，
 * 而正确落位是 flash/flash/pro（light 与 standard 塌缩）。
 */
export const SINGLE_VENDOR_BINDINGS = {
  anthropic: { light: 'anthropic/claude-haiku-4-5', standard: 'anthropic/claude-sonnet-5', heavy: 'anthropic/claude-opus-5' },
  openai: { light: 'openai/gpt-5.6-luna', standard: 'openai/gpt-5.6-terra', heavy: 'openai/gpt-5.6-sol' },
  deepseek: { light: 'deepseek/deepseek-flash', standard: 'deepseek/deepseek-flash', heavy: 'deepseek/deepseek-v4-pro' },
  gemini: { light: 'gemini/gemini-3.5-flash-lite', standard: 'gemini/gemini-3.6-flash', heavy: 'gemini/gemini-3.1-pro-preview' },
};

/**
 * 档位 → 完整解析结果。这是"档位 → (服务商, 模型, 协议, 推理强度取值, 单价)"的唯一入口。
 * 绑定与目录都可由调用方替换，因此用户改配置不需要改代码。
 */
export function tierEntry(tier, binding = TIER_BINDING, catalog = MODEL_CATALOG, vendors = VENDORS) {
  // 这里抛的都是 ConfigError：绑定 / 目录 / 服务商配错了，不是节点的错 —— 编排器据此退回 pending 且不计重试。
  const key = binding?.[tier];
  if (!key) throw new ConfigError(`${tier} 档没有绑模型`, { tier });
  const entry = catalog[key];
  if (!entry) throw new ConfigError(`${tier} 档绑的 ${key} 不在模型目录里`, { tier, key });
  if (entry.orphan) throw new ConfigError(`${tier} 档绑的 ${key} 在升级后的系统里已经没有了 —— 改绑定`, { tier, key });
  const vendor = vendors[entry.vendor];
  if (!vendor) throw new ConfigError(`${tier} 档绑的 ${key} 指向的服务商 ${entry.vendor} 不存在`, { tier, key, vendor: entry.vendor, model: entry.model });
  // 库里停用的服务商 / 模型不静默换厂商，建客户端时就报（绑定页会提前标出来）
  if (vendor.enabled === false) throw new ConfigError(`${tier} 档绑的 ${key} 所在服务商 ${entry.vendor} 已停用 —— 改绑定或重新启用`, { tier, key, vendor: entry.vendor, model: entry.model });
  if (entry.enabled === false) throw new ConfigError(`${tier} 档绑的 ${key} 已停用 —— 改绑定或重新启用`, { tier, key, vendor: entry.vendor, model: entry.model });
  return {
    key,
    vendorId: entry.vendor,
    model: entry.model,
    adapter: entry.adapter ?? vendor.adapter,
    efforts: entry.efforts ?? EFFORTS,
    pricing: entry.pricing,
    keyEnv: vendor.keyEnv,
    baseUrl: vendor.baseUrl,
    notes: entry.notes ?? [],
    endpoint: vendor,   // 整个服务商（自定义鉴权头 / 列表路径都在上面）
    gateway: vendor.gateway ?? false,
    // 记账口径：'computed' 用目录单价算，'reported' 用厂商回报的实际计费
    billing: entry.billing ?? vendor.billing ?? 'computed',
    // ⚠️ 网关的上游偏好（钉厂商、排量化、拒留存…）。**故意是可选的**：
    // 用哪家上游是用户的选择，不是我们的规矩。不填就走网关的默认路由，
    // 代价（量化/上下文/缓存能力随上游浮动）由界面披露，不由代码禁止。
    providerPrefs: entry.providerPrefs,
  };
}

/**
 * 推理强度可用性也是**按模型**的（与 adapter 同构的第二个实例）：
 * claude-haiku-4-5 完全不支持 effort，gpt-5-pro 只接受 high —— 两者都实测 400。
 * 故请求的推理强度必须先经档位项 clamp，再交给 adapter。
 * @returns 该模型能接受的推理强度；`undefined` 表示该档不发推理强度参数。
 */
export function clampEffort(requested, allowed = EFFORTS) {
  if (!requested) return undefined;
  if (!allowed.length) return undefined;                 // 该模型不认这个参数，直接不发
  if (allowed.includes(requested)) return requested;
  // 取最接近的可用档（按 low<medium<high 的序）
  const rank = (e) => EFFORTS.indexOf(e);
  return allowed.slice().sort((a, b) => Math.abs(rank(a) - rank(requested)) - Math.abs(rank(b) - rank(requested)))[0];
}

/**
 * 规范 usage —— 五个字段，**两两互斥、可直接相加**：
 *   { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens }
 *
 * inputTokens      未命中缓存的输入
 * cacheReadTokens  命中缓存的输入（约 0.1x 计价）
 * cacheWriteTokens 写入缓存的输入（约 1.25x 计价）
 * outputTokens     **全部**输出，已含推理
 * reasoningTokens  上面那笔里属于推理的部分，仅供观测，**不再单独计费**
 *
 * ⚠️ 归一到这个形状是本层最容易出错的地方，因为三家的包含关系互不相同（实测）：
 *   Gemini    thoughtsTokenCount 与 candidatesTokenCount **互斥**，prompt+candidates+thoughts = total
 *             → 推理 token 必须**加进** outputTokens，否则少算（实测 32 可见 vs 292 推理，差 9 倍）
 *   OpenAI    reasoning_tokens ⊂ completion_tokens，cached_tokens ⊂ prompt_tokens
 *             → 必须**减去** cached 才能得到互斥的 inputTokens，推理**不能再加**
 *   Anthropic input_tokens 与 cache_* 互斥；output_tokens_details.thinking_tokens ⊂ output_tokens
 *   DeepSeek  prompt_cache_hit + miss = prompt_tokens（子集关系，同 OpenAI）
 *
 * 只读 input/output 两个字段会漏掉缓存与推理两大项。实测一次带缓存的 Anthropic 调用
 * 报 input_tokens=14，而真实处理量是 3617（3603 走了缓存）—— 少算 250 倍。
 */
export const EMPTY_USAGE = {
  inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0,
};

/**
 * 计价：**直接按钱算**，单位微美元（整数，避免浮点累加漂移）。
 *
 * 曾经的口径是"加权 token = (input + k×output) × 档位倍率"，已废弃。两个原因：
 *
 * 1. **倍率与真实价差对不上**。原倍率 1:3:15，而实测各家轻/标/重的真实价比是
 *    1:2~2.5:5 —— 重档被高估了 3 倍。既然口径已定为按费用计，就没有中间变量的位置。
 * 2. **全局 k 系数根本无法成立**。输出/输入价比各家不同：Anthropic 5:1、
 *    OpenAI 6:1、Gemini 5:1，而 **DeepSeek 只有 2:1**。更要命的是档位一旦可以
 *    跨厂商绑定（light 走 DeepSeek、heavy 走 Anthropic），"档位倍率"连定义都没有了。
 *
 * 结论：单价挂在**模型**上，账本记的是钱。预算上限随之从 token 数改为金额，
 * 这也更好向人解释——"这个任务花了 $0.42"比"花了 12800 加权 token"可核对得多。
 */
const PER_MILLION = 1_000_000;

/** @returns 微美元（整数）。缺价格时抛错——见下方说明。 */
export function costMicroUsd(usage, pricing) {
  if (!pricing) {
    // ⚠️ 绝不能默默按 0 计。预算闸门是安全机制，一个没有价格的模型
    // 若按免费入账，等于把上限关掉了——而这恰恰会发生在"用户刚添加了新模型"之后。
    throw new Error('missing pricing for model — 新增模型必须同时提供单价，否则预算闸门失效');
  }
  const u = { ...EMPTY_USAGE, ...usage };
  const usd = (u.inputTokens * (pricing.input ?? 0)
    + u.cacheReadTokens * (pricing.cacheRead ?? pricing.input ?? 0)
    + u.cacheWriteTokens * (pricing.cacheWrite ?? pricing.input ?? 0)
    + u.outputTokens * (pricing.output ?? 0)) / PER_MILLION;
  return Math.round(usd * 1e6);
}

export const fmtUsd = (microUsd) => `$${(microUsd / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

/** 账本条目相加（跨调用累计），字段级求和，避免调用方手写漏项 */
export function addUsage(a, b) {
  const x = { ...EMPTY_USAGE, ...a }, y = { ...EMPTY_USAGE, ...b };
  return Object.fromEntries(Object.keys(EMPTY_USAGE).map((k) => [k, x[k] + y[k]]));
}

/** 从规范响应中取出工具调用 */
export const toolCallsOf = (resp) => resp.content.filter((b) => b.type === 'tool_call');
/** 从规范响应中取出纯文本 */
export const textOf = (resp) => resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
/**
 * 输出被 max_tokens 截断且**一个可见块都没有**（只有 thinking 或全空）。
 * 例：DeepSeek-v4-pro 做规划时，effort=high 的推理把 8000 完成 token 全吃光，回来的是空消息；
 * 循环把它当"没调工具"回填成一条空 assistant 消息，厂商下一轮才 400（"content or tool_calls must be set"）——
 * 故障点比成因晚一轮。这种响应不能回填，也不值得再要一次（同样的预算还是同样的下场），要当基础设施错误抛出去。
 */
export const truncatedEmpty = (resp) => resp.stopReason === 'max_tokens' && !resp.content.some((b) => b.type === 'text' || b.type === 'tool_call');
export class TruncatedEmptyError extends Error {
  constructor(who, maxTokens) { super(`${who}：输出被 max_tokens（${maxTokens}）截断且没有任何可见内容（推理占满预算）`); this.infra = true; this.kind = 'truncated_empty'; }
}

/** 规范化的比较用形态，用于跨厂商一致性断言（丢弃 id 等厂商特有细节） */
export function semanticShape(resp) {
  return {
    stopReason: resp.stopReason,
    text: textOf(resp).trim(),
    calls: toolCallsOf(resp).map((c) => ({ name: c.name, args: c.args })),
  };
}
