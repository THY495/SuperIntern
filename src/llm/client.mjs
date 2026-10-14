// 统一 LLM 客户端：档位路由 + record/replay + fake，四种模式同一接口。
// "多厂商适配"与"可测试性"是同一个接口的不同实现。

import { assertSessionTools } from '../core/capabilities.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { PROVIDERS } from './providers.mjs';
import { costMicroUsd, EMPTY_USAGE, addUsage, tierEntry, modelEntry, bindRoleOf, clampEffort, makerOf, TIER_BINDING, MODEL_CATALOG, VENDORS } from './canonical.mjs';
import { headersFor } from './registry.mjs';
import { ProviderError, ConfigError, isInfraError } from '../core/errors.mjs';
import { I18nError } from '../i18n/index.mjs';
import { withTimeout, llmTimeoutMs } from '../core/http.mjs';
import { maybeFault } from '../core/faults.mjs';
import { healthKey, retryAfterMs, BACKOFF } from './health.mjs';
import { redactDeep } from '../core/redact.mjs';
import { otelEnabled, withSpan } from '../core/otel.mjs';
import { performance } from 'node:perf_hooks';

// ── 厂商侧重试 ──────────────────────────────────────────────────────────────
// 曾出现过：anthropic/claude-opus-5 中途开始回 403，异常直接炸穿到 CLI。
// 403 确实不该重试（那是权限/配额，重试只是多撞几次），但 429 / 5xx / 网络抖动
// 该重试 —— 一个"长期运行"的 agent 不能因为一次瞬时抖动就把节点丢回 pending。
// 有界、退避、只重试可重试的；最终失败抛 ProviderError（带 infra 标记，见 errors.mjs）。
// 每次等待在 [0, 上限) 里均匀取（full jitter）—— 几个进程同时撞上限流时不再一起等同样的秒数、一起再撞；
// 服务商给了 Retry-After 就至少等那么久。"这家现在能不能打"放在库里所有进程共用（llm/health.mjs）：
// 熔断开着就不打（直接失败，调用方换备用档）；共享退避没到点，短的原地等、长的当这次失败。
// 超时只再试一次：单次时限 30 分钟（推理模型慢），卡死的服务商原来要耗 2 小时才放手。
export const RETRY_DELAYS_MS = [2000, 8000, 30000];   // 每次重试等待的上限（实际在 [0, 上限) 里取）
export const isRetryableStatus = (s) => s === 429 || s === 408 || (s >= 500 && s < 600);
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const TIMEOUT_RETRIES = 1;

async function postWithRetry({ url, headers, body, vendor, model, tier, key, hkey }, delays, health = null, rnd = Math.random, info = {}) {
  const fail = (msg, o) => new ProviderError(msg, { vendor, model, tier, ...o });
  let timeouts = 0;
  for (let attempt = 0; ; attempt++) {
    // 共享状态：熔断开着 / 有人在试探 → 不打；共享退避没到点 → 短的等，长的放手
    for (let g = health?.gate(hkey); g && !g.ok;) {
      if (g.reason === 'backoff' && g.wait <= BACKOFF.maxWaitMs) { await sleep(g.wait); g = health.gate(hkey); continue; }
      throw fail(g.reason === 'backoff' ? `${key}: 限流退避中，${Math.ceil(g.wait / 1000)} 秒后再试` : `${key}: 熔断中（近期连续失败），暂不调用`,
        { status: null, retryable: true, attempts: attempt, blocked: g.reason });
    }
    let res, wire;
    try {
      res = await fetch(url, withTimeout({ method: 'POST', headers, body }, llmTimeoutMs()));
      wire = await res.json().catch(() => null);
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      health?.report(hkey, { ok: false, status: null, error: e.message });
      if (timedOut) timeouts++;
      if (attempt < delays.length && (!timedOut || timeouts <= TIMEOUT_RETRIES)) { await sleep(Math.floor(rnd() * delays[attempt])); continue; }
      throw fail(`${key}: 网络失败（${e.message}），重试 ${attempt} 次仍失败`, { status: null, retryable: true, attempts: attempt + 1 });
    }
    // 2xx 也可能是坏回包（OpenRouter 上的 Kimi 回了 200 + 空体 `null`，解析器读 choices 抛 TypeError，
    // 编排器当成真 bug 整个崩掉、停了 33 分钟）。不是 JSON 对象、或只带 error 没有正文 = 上游这一次失败了，按状态码重试 / 退避 / 换备用
    const bad = res.ok ? badBody(wire) : null;
    if (res.ok && !bad) { health?.report(hkey, { ok: true }); info.attempts = attempt + 1; return wire; }
    const status = bad ? bad.status : res.status;
    const retryable = bad ? bad.retryable : isRetryableStatus(res.status);
    const after = retryAfterMs(res.headers?.get?.('retry-after'));
    if (retryable) health?.report(hkey, { ok: false, status, error: JSON.stringify(wire).slice(0, 300), retryAfter: after });
    if (retryable && attempt < delays.length) { await sleep(Math.max(Math.floor(rnd() * delays[attempt]), Math.min(after ?? 0, BACKOFF.maxWaitMs))); continue; }
    const what = bad ? `HTTP ${res.status}，${bad.why}` : `HTTP ${res.status}`;
    throw fail(`${key} ${what}: ${JSON.stringify(wire).slice(0, 400)}`, { status, retryable, attempts: attempt + 1, ...(bad ? { malformed: true } : {}) });
  }
}

/**
 * 2xx 回包本身是不是一次失败。返回 null（正常）或 { status, retryable, why }：
 *   - 不是 JSON 对象（空体、`null`、截断的 JSON、纯文本）→ 当成上游 502，可重试；
 *   - 带 `error` 却没有任何一种协议的正文（choices / content / output / candidates）→ 网关把上游的错包在 200 里：
 *     error.code 是状态码就照它判能不能重试，没有就当可重试。
 */
export function badBody(wire) {
  if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) return { status: 502, retryable: true, why: '回包不是 JSON 对象' };
  if (wire.error && !('choices' in wire || 'content' in wire || 'output' in wire || 'candidates' in wire)) {
    const code = Number(wire.error.code);
    return Number.isInteger(code) && code >= 400 && code < 600
      ? { status: code, retryable: isRetryableStatus(code), why: '回包里是错误' }
      : { status: 502, retryable: true, why: '回包里是错误' };
  }
  return null;
}

/**
 * 回包 → 规范响应。2xx 回包形状不对（badBody 拦不住的那些：少了协议必有的字段）时 adapter 会抛 TypeError 之类 ——
 * 那是**上游这一次的回包坏了**，不是我们的 bug：转成可重试的 ProviderError，编排器按厂商错误停、节点不扣重试、守护进程退避再拉。
 */
function parseWire(r, wire, tier) {
  try { return r.adapter.parseResponse(wire); } catch (e) {
    throw new ProviderError(`${r.key}: 回包形状不对（${e.message}）: ${JSON.stringify(wire).slice(0, 300)}`,
      { vendor: r.vendorId, model: r.model, tier, status: null, retryable: true, attempts: 1, malformed: true });
  }
}

/** 从 .env 加载环境变量（Node 内置，无依赖）。文件不存在时静默跳过。 */
export function loadEnv(path) {
  try { process.loadEnvFile(path); return true; } catch { return false; }
}

export const hashOf = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);

/**
 * 厂商代答检测（零成本的目录漂移信号）：响应里的 model 与请求的不一致 → 请求的名字已经不是它自己了
 * （DeepSeek 退役 `deepseek-v4-flash` 后由 V4.1-Flash 代答就是这样）。带日期后缀的同名（claude-opus-5 → claude-opus-5-20260401）不算。
 * 返回 { requested, served } 或 null。
 */
export function servedModelDrift(requested, wire) {
  const served = wire?.model ?? wire?.modelVersion ?? null;
  if (!served || !requested) return null;
  const a = String(requested), b = String(served);
  if (a === b || b.startsWith(`${a}-`) || a.startsWith(`${b}-`) || b === `models/${a}`) return null;
  return { requested: a, served: b };
}

export class LlmClient {
  /**
   * 客户端是"**一套档位绑定**的客户端"，不是"某一家厂商的客户端" ——
   * 档位可以跨厂商绑定（light 走 DeepSeek、heavy 走 Anthropic），所以厂商、
   * 协议、凭证、单价全部在**每次请求时**按档位解析，构造时无从确定。
   *
   * @param {object} opts
   *  - binding / catalog / vendors: 档位绑定、模型目录、服务商（默认取代码常量；生效值由 registry.registryFor(db) 注入 —— 每建一个客户端读一次库）
   *  - tierEfforts: { tier: effort|null }，档位级推理强度；非空时**覆盖**调用方请求的推理强度（绑定页可选）
   *  - mode: 'live'|'record'|'replay'|'fake'
   *  - cassette（replay/record 用）, fake（fake 用）, apiKeys（覆盖环境变量）
   */
  constructor(opts = {}) {
    this.binding = opts.binding ?? TIER_BINDING;
    this.vendors = opts.vendors ?? VENDORS;
    this.tierEfforts = opts.tierEfforts ?? {};
    // 角色单独绑定 { role: { key, effort } }。请求带 role、这个角色单独绑了，就用那个模型、不看档位
    this.roleBinding = opts.roleBinding ?? {};
    this.retryDelays = opts.retryDelays ?? RETRY_DELAYS_MS;   // 测试传 [0,0,0]，不真等
    // 每档的备用模型、共享的熔断 / 退避（registryFor(db) 带上；不带 = 不回落、只在本进程里重试）
    this.fallbacks = opts.fallbacks ?? {};
    this.health = opts.health ?? null;
    this.catalog = opts.catalog ?? MODEL_CATALOG;
    this.fake = opts.fake;
    this.mode = opts.mode ?? 'replay';
    this.apiKeys = opts.apiKeys ?? {};
    this.cassette = opts.cassette;
    this.ledger = [];   // 花费账本，单位微美元
    this.toolLog = [];  // 工具调用的耗时（runToolLoop 记，flushLedger 落 tool_calls 后清空）
    // fake 模式下的单价。默认 0 —— 但**默认 0 会让预算闸门在离线测试里结构上碰不到**：
    // 不花钱就永远不触顶，闸门测试等于在测一个恒真命题。
    // 这与迁移撞出来的那类盲区同源（离线测试全用新库，于是迁移路径结构上测不到）。
    this.fakePricing = opts.fakePricing ?? null;
    this._cache = null;
    this.drifts = [];   // 代答检测（servedModelDrift），flushLedger 落审计后清空；同一 (key, served) 只记一次
  }

  _noteDrift(r, wire) {
    const d = servedModelDrift(r.model, wire);
    if (!d) return;
    if (this.drifts.some((x) => x.key === r.key && x.served === d.served)) return;
    this.drifts.push({ key: r.key, vendor: r.vendorId, ...d });
  }

  /** 某个角色在某一档时用的模型收不收图片（决定给不给验收员截图工具）。解析失败按不收 */
  visionFor(tier, role = null) {
    try { return this.entryFor(tier, role).vision === true; } catch { return false; }
  }

  /** 某个角色在某一档时实际用哪个模型（不解析 adapter / 凭证）：编排器取执行器的服务商、估价用 */
  entryFor(tier, role = null) {
    const own = role ? this.roleBinding?.[bindRoleOf(role)] : null;
    return own ? modelEntry(own.key, this.catalog, this.vendors, { tier, role, label: `角色 ${bindRoleOf(role)} ` })
      : tierEntry(tier, this.binding, this.catalog, this.vendors);
  }

  /** 请求（或只给档位）→ 完整解析（服务商 / 模型 / 协议 / 推理强度取值 / 单价 / 凭证）。角色单独绑了优先于档位 */
  _resolve(req) {
    const { tier, role } = typeof req === 'string' ? { tier: req, role: null } : req;
    const own = role ? this.roleBinding?.[bindRoleOf(role)] : null;
    const e = own ? { ...modelEntry(own.key, this.catalog, this.vendors, { tier, role, label: `角色 ${bindRoleOf(role)} ` }), roleEffort: own.effort ?? null }
      : tierEntry(tier, this.binding, this.catalog, this.vendors);
    const adapter = this.fake ?? PROVIDERS[e.adapter];
    if (!adapter) throw new Error(`${e.key} references unimplemented adapter '${e.adapter}'`);
    return { ...e, adapter, apiKey: this.apiKeys[e.vendorId] ?? process.env[e.keyEnv] };
  }

  _loadCassette() {
    if (this._cache) return this._cache;
    this._cache = new Map();
    if (this.cassette && existsSync(this.cassette)) {
      for (const line of readFileSync(this.cassette, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line);
        this._cache.set(rec.key, rec);
      }
    }
    return this._cache;
  }

  /**
   * 规范请求 → 规范响应。开了 OTLP 导出（core/otel.mjs）时包一个 GenAI 语义约定的 span：模型、用量、花费，**不带提示词与回复内容**。
   */
  complete(canon) {
    // 最小权限注入会话能力表：没登记的角色、没登记的工具，在这里拒（异步拒，调用方照常 await / catch）
    try { assertSessionTools(canon.role, canon.tools); } catch (e) { return Promise.reject(e); }
    if (!otelEnabled()) return this._complete(canon);
    let r = null;
    try { r = this._resolve(canon); } catch { /* 解析失败由 _complete 照常报 */ }
    const n0 = this.ledger.length;
    return withSpan(`chat ${r?.model ?? canon.tier}`, {
      kind: 'CLIENT',
      attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': r?.vendorId, 'gen_ai.request.model': r?.model, 'superintern.tier': canon.tier, 'superintern.role': canon.role },
      onEnd: () => {
        const e = this.ledger.length > n0 ? this.ledger[this.ledger.length - 1] : null;
        if (!e) return {};
        return { 'gen_ai.usage.input_tokens': e.inputTokens + e.cacheReadTokens + e.cacheWriteTokens, 'gen_ai.usage.output_tokens': e.outputTokens,
          'gen_ai.usage.cache_read.input_tokens': e.cacheReadTokens, 'gen_ai.usage.cache_creation.input_tokens': e.cacheWriteTokens,
          'superintern.cost_micro_usd': e.microUsd, 'superintern.billing': e.billing, 'superintern.upstream': e.upstream };
      },
    }, () => this._complete(canon));
  }

  async _complete(canon) {
    maybeFault('llm', { tier: canon.tier });   // 故障注入点
    if (this.mode === 'fake') {
      // 按请求特征取回复的假模型（makeRoleFake）优先；否则按顺序脚本取
      const startedAt = Date.now(), t0 = performance.now();
      const resp = this.fake.respond ? this.fake.respond(canon) : this.fake.nextScripted();
      // 脚本里放一个 Error 就抛它 —— 离线测"厂商挂了"这条路的唯一办法。
      if (resp instanceof Error) throw resp;
      this._account(resp, canon.tier, { role: canon.role, key: 'fake/fake', vendorId: 'fake',
        pricing: canon.fakePricing ?? this.fakePricing ?? { input: 0, output: 0 },
        timing: { startedAt, durationMs: Math.round(performance.now() - t0), attempts: 1 } });
      return resp;
    }

    const primary = this._resolve(canon);
    if (this.mode === 'replay') {
      const { r, canon: c, wireReq, key } = this._wire(canon, primary);
      const rec = this._loadCassette().get(key);
      if (!rec) throw new Error(`replay miss: ${r.key} key=${key}\n请用 mode:'record' 跑一次 live 录制`);
      const resp = r.adapter.parseResponse(rec.response);
      this._noteDrift(r, rec.response);
      this._account(resp, c.tier, { ...r, role: canon.role });
      return resp;
    }
    // live / record。主模型熔断 / 重试用尽（可重试的失败）且这一档配了备用：换备用打一次
    try { return await this._live(canon, primary); } catch (e) {
      const fb = e instanceof ProviderError && e.retryable ? this._fallbackFor(canon, primary) : null;
      if (!fb) throw e;
      this.health?.noteFallback(healthKey(primary), { from: primary.key, to: fb.key, tier: canon.tier, reason: e.blocked ?? (e.status != null ? `HTTP ${e.status}` : 'network') });
      try { return await this._live(canon, fb); } catch (e2) {
        if (e2 instanceof ProviderError) e2.fallback = { from: primary.key, to: fb.key };
        throw e2;
      }
    }
  }

  /** 一次调用的线上请求：按模型去图、clamp 推理强度、交给 adapter 建请求；key 给磁带用 */
  _wire(canon, r) {
    // 不收图片的模型：工具结果里的图换成一句说明。工具层本该只把截图工具给收图的模型，这里是兜底
    if (!r.vision) canon = withoutImages(canon);
    canon = withNonEmptyAssistant(canon);
    // 推理强度按模型 clamp 后才交给 adapter —— 不同模型的可用推理强度取值不同（见 clampEffort）
    // 优先级：角色单独绑定的推理强度 → 档位级（库里的绑定行；角色单独绑了就不看档位）→ 角色自己的默认；再按模型 clamp
    const effort = clampEffort(r.roleEffort ?? (r.roleEffort === undefined ? this.tierEfforts?.[canon.tier] : null) ?? canon.effort, r.efforts);
    // 网关标志与上游偏好来自服务商/目录项，不由调用方传 —— 上层永远只谈档位
    const wireReq = r.adapter.buildRequest(
      { ...canon, effort, gateway: r.gateway, providerPrefs: r.providerPrefs }, r.model);
    // key 里带上 adapter：同一模型换协议后线请求不同，磁带必须区分
    return { r, canon, wireReq, key: hashOf({ p: r.vendorId, a: r.adapter.id, r: wireReq }) };
  }

  async _live(canon0, r0) {
    const { r, canon, wireReq, key } = this._wire(canon0, r0);
    if (!r.apiKey) throw new ConfigError(`${r.vendorId}: 缺少 API key（.env 里没填 ${r.keyEnv}）`, { tier: canon.tier, key: r.key, vendor: r.vendorId, model: r.model });
    const url = r.adapter.endpoint(r.model, r.baseUrl);
    // 耗时埋点（perf-g4）：从发出到拿到回包，含重试与共享退避的等待；尝试次数另记
    const info = {}, startedAt = Date.now(), t0 = performance.now();
    const wire = await postWithRetry({
      url, headers: headersFor(r.adapter, r.endpoint, r.apiKey), body: JSON.stringify(wireReq),
      vendor: r.vendorId, model: r.model, tier: canon.tier, key: r.key, hkey: healthKey(r),
    }, this.retryDelays, this.health, Math.random, info);
    const timing = { startedAt, durationMs: Math.round(performance.now() - t0), attempts: info.attempts ?? null };
    if (this.mode === 'record' && this.cassette) {
      appendFileSync(this.cassette, JSON.stringify(redactDeep({ key, provider: r.vendorId, adapter: r.adapter.id, model: r.model, request: wireReq, response: wire })) + '\n');   // 录制文件会被拷来拷去
    }
    const resp = parseWire(r, wire, canon.tier);
    this._noteDrift(r, wire);
    this._account(resp, canon.tier, { ...r, role: canon.role, timing });
    return resp;
  }

  /** 这一档的备用模型：没配、就是主模型本身、解析不了（被停用 / 删了）、没 key → null。角色单独绑的模型出事也回落到所在档的备用 */
  _fallbackFor(canon, primary) {
    const key = this.fallbacks?.[canon.tier];
    if (!key || key === primary.key) return null;
    // 验收员按"换一家"挑过模型的：备用若与执行器同一出品方，换过去就等于自己验自己 —— 宁可不换（任务级退避再拉）
    if (this.fallbackAvoidMakers?.length && this.fallbackAvoidMakers.includes(makerOf(this.catalog?.[key], this.vendors))) return null;
    try {
      const e = modelEntry(key, this.catalog, this.vendors, { tier: canon.tier, label: `${canon.tier} 档备用 ` });
      const adapter = PROVIDERS[e.adapter];
      const apiKey = this.apiKeys[e.vendorId] ?? process.env[e.keyEnv];
      return adapter && apiKey ? { ...e, adapter, apiKey } : null;
    } catch { return null; }
  }

  /** 流式事件序列 → 规范响应（用于验证流式与非流式产出一致） */
  accumulate(events, tier = 'standard') {
    const acc = this._resolve(tier).adapter.streamAccumulator();
    for (const ev of events) acc.push(ev);
    return acc.finish();
  }

  /**
   * 记账。两种口径：
   *  - 'computed'（厂商直连）：用目录单价算。厂商不回报花费，只能算。
   *  - 'reported'（网关）：用它回报的**实际计费**。必须如此——网关同一个模型 ID
   *    背后挂着 20 家上游，单价差 1.6 倍、缓存读价差 35 倍、有的根本没有缓存，
   *    "一个模型一份单价"在这里不成立。实测：同一长提示第二次调用因缓存命中
   *    2048 token，实际计费从 $0.000292 降到 $0.000063，只有回报值抓得住这个。
   *
   * ⚠️ 预算闸门是安全机制，账本不准 = 闸门不准。故 'reported' 口径下
   * 若厂商没回报花费，**回落到算的并标记**，绝不静默按 0 记。
   */
  _account(resp, tier, r) {
    const usage = { ...EMPTY_USAGE, ...resp.usage };
    const reported = resp.reportedMicroUsd;
    const useReported = r.billing === 'reported' && reported != null;
    if (r.billing === 'reported' && reported == null && !r.pricing) {
      throw new I18nError('{key}：服务商声明按回报计费，但本次响应无 usage.cost，且目录项没有兜底单价 —— 拒绝按 0 入账（预算闸门会因此失效）', { key: r.key });
    }
    this.ledger.push({
      model: r.key, vendor: r.vendorId, tier, ...(r.role === 'compactor' ? { role: 'compactor' } : {}),
      ...usage,
      microUsd: useReported ? reported : costMicroUsd(usage, r.pricing),
      billing: useReported ? 'reported' : 'computed',
      ...(r.billing === 'reported' && reported == null ? { billingFallback: true } : {}),
      ...(resp.upstream ? { upstream: resp.upstream } : {}),
      // 调用发生的时刻。落库可能晚得多（规划器 / 追问器整段跑完才落），用落库时刻当花费时刻，
      // 那几笔钱就落到了进程寿命之后（复盘对不上寿命，2026-10-12 真实库里查出来的）
      at: Date.now(),
      ...(r.timing ? { startedAt: r.timing.startedAt, durationMs: r.timing.durationMs, attempts: r.timing.attempts } : {}),
    });
  }

  /** 一次工具调用做完（runToolLoop 调）：进 toolLog，flushLedger 落 tool_calls。 */
  _toolDone(e) { this.toolLog.push(e); }

  /** 本客户端累计花费（微美元整数，无浮点漂移） */
  totalMicroUsd() { return this.ledger.reduce((s, e) => s + e.microUsd, 0); }

  /** 五个 usage 字段跨调用累计（缓存与推理不会因为只看 in/out 而漏掉） */
  totalUsage() { return this.ledger.reduce((s, e) => addUsage(s, e), EMPTY_USAGE); }
}

// ═══════════════════════════════════════════════════════════════════════════
// 执行 loop —— 自建的部分。全部跑在 canonical 层，厂商无关。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 把缓存断点移到**最后一条**工具结果上，并撤掉之前的。
 *
 * 断点是稀缺资源（Anthropic 最多 4 个），而且多挂几个并不更省——前缀缓存只认
 * 最长的那个命中点。所以全程只保持一个，让它跟着历史往后滚。
 * 原地改数组，因为 runToolLoop 的 messages 是逐轮追加的同一个数组。
 */
export function markRollingCache(messages) {
  let last = -1;
  for (let k = 0; k < messages.length; k++) if (messages[k].role === 'tool_results') last = k;
  for (let k = 0; k < messages.length; k++) {
    if (messages[k].role === 'tool_results') messages[k].cache = (k === last);
  }
  return messages;
}

/**
 * @param {LlmClient} client
 * @param {object} canon    初始规范请求（含 tools）
 * @param {object} handlers { toolName: async (args) => string }
 * @param {object} opts     { maxIterations, onStep }
 */
/** 去掉工具结果里的图片，换成一句说明（给不收图片的模型） */
export function withoutImages(canon) {
  if (!canon.messages?.some((m) => m.role === 'tool_results' && m.results.some((r) => r.images?.length))) return canon;
  return { ...canon, messages: canon.messages.map((m) => (m.role !== 'tool_results' ? m : { ...m, results: m.results.map((r) => (!r.images?.length ? r
    : { ...r, images: undefined, content: `${r.content}
（附带的 ${r.images.length} 张图片已略去：当前模型不收图片）` })) })) };
}

/** 空的 assistant 轮换成的占位文字（发给模型的，不给人看） */
export const EMPTY_TURN_TEXT = '（上一轮没有输出任何内容）';

/**
 * 历史里既没文字也没工具调用的 assistant 轮（推理把输出上限吃光、正文为空）补一句占位。
 * 调用方常把"回复不合规"的那一轮原样塞回去再追问（规划器、追问器、分类器、决定核对……八处），
 * 空的那一轮各家处理不一：OpenAI 收 `content: null`，Moonshot 回 400"assistant 消息不能为空"
 * Anthropic / Gemini 也拒空内容。在这里统一补，不靠每个调用方记得。
 */
export function withNonEmptyAssistant(canon) {
  const empty = (m) => m.role === 'assistant' && !m.content?.some((b) => (b.type === 'text' && String(b.text ?? '').trim()) || b.type === 'tool_call');
  if (!canon.messages?.some(empty)) return canon;
  return { ...canon, messages: canon.messages.map((m) => (empty(m) ? { ...m, content: [...(m.content ?? []), { type: 'text', text: EMPTY_TURN_TEXT }] } : m)) };
}

/**
 * run_command 的命令类别（耗时埋点用，粗分）：跑测试 / 装依赖 / 构建 / git / 其他。
 * 按可执行文件与前几个参数认；认不出的算 other。
 */
export function commandCategory(a) {
  const file = String(a?.file ?? '').split(/[\\/]/).pop().replace(/\.(exe|cmd)$/i, '').toLowerCase();
  const args = (Array.isArray(a?.args) ? a.args : []).map(String);
  const line = [file, ...args].join(' ').toLowerCase();
  if (file === 'git') return 'git';
  if (/\b(pip3?|uv|poetry|pipenv)\b.*\b(install|sync|add)\b|\b(npm|pnpm|yarn)\s+(install|ci|i|add)\b|^yarn$/.test(line) || /-m pip install/.test(line)) return 'install';
  if (/\b(pytest|vitest|jest|mocha)\b|\b(npm|pnpm|yarn)\s+(run\s+)?test\b|node\s+--test\b|\bgo\s+test\b|-m (pytest|unittest)\b|verify\.mjs/.test(line)) return 'test';
  if (/\b(npm|pnpm|yarn)\s+run\s+build\b|\bvite\s+build\b|\btsc\b|\bgo\s+build\b/.test(line)) return 'build';
  return 'other';
}

export async function runToolLoop(client, canon, handlers, opts = {}) {
  const maxIterations = opts.maxIterations ?? 8;
  const messages = [...canon.messages];
  const trace = [];
  let emptyToolTurns = 0;

  for (let i = 0; i < maxIterations; i++) {
    // ── 上下文整理（托底）：**先整理、再过闸门** ──────────────────────
    // 闸门看的是整理之后这一轮要发出去的体量（nextTokens）；整理过之后，上一轮的峰值不再是下界。
    // 整理器可以叫停（同一步骤整理太多次 → 已转成问题交人）：按终结性工具收尾。
    let nextTokens = null;
    if (opts.compactor) {
      const b = await opts.compactor.beforeRequest(messages, i);
      if (b?.messages) messages.splice(0, messages.length, ...b.messages);
      nextTokens = b?.nextTokens ?? null;
      if (b?.stop) return { resp: null, messages, trace, stopped: 'terminal_tool' };
    }
    // ── 硬上限的最后一道闸 ────────────────────────────────────────────────
    // **在发请求之前**问一次，不是发完再看。放在循环末尾就变成"每次都必然超一轮"，
    // 而超出的那一轮正是最贵的一轮（上下文最长）。
    const abort = opts.abort?.(i, { nextTokens });
    if (abort) return { resp: null, messages, trace, stopped: `aborted: ${abort}` };

    // ── 滚动缓存断点 ────────────────────────────────────────────────────
    // 只缓存静态段落会漏掉累积的工具调用历史，也可能达不到厂商的最小缓存长度。
    //
    // 错在把"稳定"理解成"静态"。工具循环里**已经发生过的轮次也不会再变**——
    // 第 5 轮时前 4 轮的 40k token 是货真价实的稳定前缀，只是它不在装配配方里。
    // 所以断点要**跟着历史往后滚**，钉在最后一条已完成的工具结果上。
    //
    // 只看编排器看不见这一条——编排器重生，历史从不累积。
    // 执行器恰恰相反：它一次性活到底，历史就是它的全部体量。
    if (opts.rollingCache !== false) markRollingCache(messages);
    const resp = await client.complete({ ...canon, messages });
    trace.push({ iteration: i, stopReason: resp.stopReason, content: resp.content });
    opts.compactor?.observe(resp);
    opts.onStep?.(i, resp);

    if (resp.stopReason !== 'tool_call') {
      return { resp, messages, trace, stopped: resp.stopReason };
    }

    const calls = resp.content.filter((b) => b.type === 'tool_call');

    // ⚠️ stopReason 说"要调工具"，但一个调用块都没有。协议上不该发生，**实测会**
    // （claude-opus-5 带 thinking 时约 1/8 概率返回 stop_reason=tool_use + 零个 tool_use 块）。
    // 若照常回填，会构造出一条空的 tool_results 消息，厂商在**下一轮**才拒
    // （400 "user messages must have non-empty content"）——故障点比成因晚一轮，极难归因。
    // 处理：不回填空消息，原样重试一次；仍为空则把异常状态透给上层，不伪装成正常收尾。
    if (!calls.length) {
      if (emptyToolTurns++ < (opts.maxEmptyToolTurns ?? 1)) {
        trace.push({ iteration: i, stopReason: resp.stopReason, note: 'empty_tool_turn_retry' });
        continue;
      }
      return { resp, messages, trace, stopped: 'tool_call_without_calls' };
    }

    // 把助手轮（含工具调用、thinking）原样回填
    messages.push({ role: 'assistant', content: resp.content });

    // 并行执行全部工具调用，结果聚合进**一条** tool_results 消息
    const results = await Promise.all(calls.map(async (c) => {
      const fn = handlers[c.name];
      if (!fn) return { callId: c.id, name: c.name, content: `unknown tool: ${c.name}`, isError: true };
      // 参数不是合法 JSON（OpenAI 形状的 arguments 是模型逐字写的字符串）：回给模型让它重发，
      // 不执行、不猜。原来这里在 adapter 里就 JSON.parse 抛了，编排器整个炸掉。
      if (c.argsError) {
        return { callId: c.id, name: c.name, isError: true,
          content: `工具参数不是合法 JSON（${c.argsError}）。原文开头：${String(c.argsRaw ?? '').slice(0, 300)}\n`
            + `请重新发起这次调用。JSON 字符串里的反斜杠要写成 \\\\，引号要写成 \\"；把大段代码放进 write_file 而不是塞进 -e 参数。` };
      }
      const startedAt = Date.now(), t0 = performance.now();
      const done = (ok, content) => client._toolDone?.({ role: canon.role ?? null, round: i, tool: c.name, startedAt, durationMs: Math.round(performance.now() - t0), ok,
        category: c.name === 'run_command' ? commandCategory(c.args) : null,
        exitCode: c.name === 'run_command' ? (/^exit=(-?\d+)/.exec(typeof content === 'string' ? content : '')?.[1] ?? null) : null });
      try {
        const v = await fn(c.args);
        done(true, v);
        // 处理器可以连图带字返回（应用验收截图）：{ text, images: [{ mediaType, data(base64) }] }。图只在内存里的 messages 上，不进 trace
        if (v && typeof v === 'object' && Array.isArray(v.images)) return { callId: c.id, name: c.name, content: String(v.text ?? ''), ...(v.images.length ? { images: v.images } : {}) };
        return { callId: c.id, name: c.name, content: v };
      } catch (e) {
        // 基础设施错误**不回给模型**。容器 OOM、代理死了 —— 这些不是模型能修的，
        // 回给它只会让它把"硬失败"读成一句普通报错然后接着干（实际出现过）。
        // 穿出去，让编排器接住、干净地停。
        done(false, null);
        if (isInfraError(e)) throw e;
        return { callId: c.id, name: c.name, content: String(e.message), isError: true };
      }
    }));
    // 轮次预算提示。**实测倒逼出来的**：一个执行器把活干完了、测试也跑绿了，
    // 却在最后两轮跑去做下一个节点的事，然后撞上 maxIterations 收不了尾——
    // 它从头到尾不知道自己还剩几轮。循环有预算而模型看不见预算，是循环的问题。
    //
    // ⚠️ 提示挂在**最后一条工具结果的正文里**，不另发一条消息：tool_results 之后
    // 紧跟一条 user 文本消息在 Anthropic 上是可疑形状，而工具结果的正文四家都照收。
    const note = opts.iterationNote?.(i, maxIterations);
    if (note && results.length) results[results.length - 1].content += `\n\n${note}`;

    messages.push({ role: 'tool_results', results });

    // 终结性工具（提交交接记录、提问挂起…）：调到它就该收工。没有这个钩子，
    // 上层只能靠"回一句'别再调工具了'然后祈祷模型听话"，多烧的是整轮上下文的钱，
    // 而且模型完全可能继续调下去直到 maxIterations。
    if (opts.shouldStop?.(results)) return { resp, messages, trace, stopped: 'terminal_tool' };
  }

  return { resp: null, messages, trace, stopped: 'max_iterations' };
}
