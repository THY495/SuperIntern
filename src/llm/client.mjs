// 统一 LLM 客户端：档位路由 + record/replay + fake，四种模式同一接口。
// "多厂商适配"与"可测试性"是同一个接口的不同实现。

import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { PROVIDERS } from './providers.mjs';
import { costMicroUsd, EMPTY_USAGE, addUsage, tierEntry, clampEffort, TIER_BINDING, MODEL_CATALOG, VENDORS } from './canonical.mjs';
import { headersFor } from './registry.mjs';
import { ProviderError, ConfigError, isInfraError } from '../core/errors.mjs';
import { I18nError } from '../i18n/index.mjs';

// ── 厂商侧重试 ──────────────────────────────────────────────────────────────
// 曾出现过：anthropic/claude-opus-5 中途开始回 403，异常直接炸穿到 CLI。
// 403 确实不该重试（那是权限/配额，重试只是多撞几次），但 429 / 5xx / 网络抖动
// 该重试 —— 一个"长期运行"的 agent 不能因为一次瞬时抖动就把节点丢回 pending。
// 有界、退避、只重试可重试的；最终失败抛 ProviderError（带 infra 标记，见 errors.mjs）。
export const RETRY_DELAYS_MS = [1000, 3000, 9000];
export const isRetryableStatus = (s) => s === 429 || s === 408 || (s >= 500 && s < 600);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postWithRetry({ url, headers, body, vendor, model, tier, key }, delays) {
  for (let attempt = 0; ; attempt++) {
    let res, wire;
    try {
      res = await fetch(url, { method: 'POST', headers, body });
      wire = await res.json().catch(() => null);
    } catch (e) {
      if (attempt < delays.length) { await sleep(delays[attempt]); continue; }
      throw new ProviderError(`${key}: 网络失败（${e.message}），重试 ${attempt} 次仍失败`,
        { vendor, model, tier, status: null, retryable: true, attempts: attempt + 1 });
    }
    if (res.ok) return wire;
    const retryable = isRetryableStatus(res.status);
    if (retryable && attempt < delays.length) { await sleep(delays[attempt]); continue; }
    throw new ProviderError(`${key} HTTP ${res.status}: ${JSON.stringify(wire).slice(0, 400)}`,
      { vendor, model, tier, status: res.status, retryable, attempts: attempt + 1 });
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
    this.retryDelays = opts.retryDelays ?? RETRY_DELAYS_MS;   // 测试传 [0,0,0]，不真等
    this.catalog = opts.catalog ?? MODEL_CATALOG;
    this.fake = opts.fake;
    this.mode = opts.mode ?? 'replay';
    this.apiKeys = opts.apiKeys ?? {};
    this.cassette = opts.cassette;
    this.ledger = [];   // 花费账本，单位微美元
    // fake 模式下的单价。默认 0 —— 但**默认 0 会让预算闸门在离线测试里结构上碰不到**：
    // 不花钱就永远不触顶，闸门测试等于在测一个恒真命题。
    // 这与另一类盲区同源（离线测试全用新库，于是迁移路径结构上测不到）。
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

  /** 档位 → 完整解析（服务商 / 模型 / 协议 / 推理强度取值 / 单价 / 凭证） */
  _resolve(tier) {
    const e = tierEntry(tier, this.binding, this.catalog, this.vendors);
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

  /** 规范请求 → 规范响应。所有厂商差异已在 provider 内吸收。 */
  async complete(canon) {
    if (this.mode === 'fake') {
      const resp = this.fake.nextScripted();
      // 脚本里放一个 Error 就抛它 —— 离线测"厂商挂了"这条路的唯一办法。
      if (resp instanceof Error) throw resp;
      this._account(resp, canon.tier, { key: 'fake/fake', vendorId: 'fake',
        pricing: canon.fakePricing ?? this.fakePricing ?? { input: 0, output: 0 } });
      return resp;
    }

    const r = this._resolve(canon.tier);
    // 推理强度按模型 clamp 后才交给 adapter —— 不同模型的可用推理强度取值不同（见 clampEffort）
    // 档位级推理强度（库里的绑定行）非空时覆盖角色自己的默认；再按模型 clamp
    const effort = clampEffort(this.tierEfforts?.[canon.tier] ?? canon.effort, r.efforts);
    // 网关标志与上游偏好来自服务商/目录项，不由调用方传 —— 上层永远只谈档位
    const wireReq = r.adapter.buildRequest(
      { ...canon, effort, gateway: r.gateway, providerPrefs: r.providerPrefs }, r.model);
    // key 里带上 adapter：同一模型换协议后线请求不同，磁带必须区分
    const key = hashOf({ p: r.vendorId, a: r.adapter.id, r: wireReq });

    if (this.mode === 'replay') {
      const rec = this._loadCassette().get(key);
      if (!rec) throw new Error(`replay miss: ${r.key} key=${key}\n请用 mode:'record' 跑一次 live 录制`);
      const resp = r.adapter.parseResponse(rec.response);
      this._noteDrift(r, rec.response);
      this._account(resp, canon.tier, r);
      return resp;
    }

    // live / record
    if (!r.apiKey) throw new ConfigError(`${r.vendorId}: 缺少 API key（.env 里没填 ${r.keyEnv}）`, { tier: canon.tier, key: r.key, vendor: r.vendorId, model: r.model });
    const url = r.adapter.endpoint(r.model, r.baseUrl);
    const wire = await postWithRetry({
      url, headers: headersFor(r.adapter, r.endpoint, r.apiKey), body: JSON.stringify(wireReq),
      vendor: r.vendorId, model: r.model, tier: canon.tier, key: r.key,
    }, this.retryDelays);
    if (this.mode === 'record' && this.cassette) {
      appendFileSync(this.cassette, JSON.stringify({ key, provider: r.vendorId, adapter: r.adapter.id, model: r.model, request: wireReq, response: wire }) + '\n');
    }
    const resp = r.adapter.parseResponse(wire);
    this._noteDrift(r, wire);
    this._account(resp, canon.tier, r);
    return resp;
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
      model: r.key, vendor: r.vendorId, tier,
      ...usage,
      microUsd: useReported ? reported : costMicroUsd(usage, r.pricing),
      billing: useReported ? 'reported' : 'computed',
      ...(r.billing === 'reported' && reported == null ? { billingFallback: true } : {}),
      ...(resp.upstream ? { upstream: resp.upstream } : {}),
    });
  }

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
export async function runToolLoop(client, canon, handlers, opts = {}) {
  const maxIterations = opts.maxIterations ?? 8;
  const messages = [...canon.messages];
  const trace = [];
  let emptyToolTurns = 0;

  for (let i = 0; i < maxIterations; i++) {
    // ── 硬上限的最后一道闸 ────────────────────────────────────────────────
    // **在发请求之前**问一次，不是发完再看。放在循环末尾就变成"每次都必然超一轮"，
    // 而超出的那一轮正是最贵的一轮（上下文最长）。
    const abort = opts.abort?.(i);
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
      try {
        return { callId: c.id, name: c.name, content: await fn(c.args) };
      } catch (e) {
        // 基础设施错误**不回给模型**。容器 OOM、代理死了 —— 这些不是模型能修的，
        // 回给它只会让它把"硬失败"读成一句普通报错然后接着干（实际出现过）。
        // 穿出去，让编排器接住、干净地停。
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
