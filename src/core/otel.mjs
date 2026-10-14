// 可选的 OTLP 追踪导出。零依赖：攒一批 span，用 fetch 按 OTLP/HTTP JSON POST 出去。
//
// 开关用 OpenTelemetry 的标准环境变量，不另起名字（运维已经会配的那一套）：
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT（完整地址）或 OTEL_EXPORTER_OTLP_ENDPOINT（拼上 /v1/traces）—— 都没设就完全不做；
//   OTEL_EXPORTER_OTLP_HEADERS（"k=v,k2=v2"，比如收集端的认证头）；OTEL_SERVICE_NAME（默认 superintern）；OTEL_SDK_DISABLED=true 关掉。
//
// 导出什么：每一步执行一个 span（execute_step），步骤里的每次模型调用一个子 span。模型调用的属性沿用
// OTel GenAI 语义约定（gen_ai.*；该约定仍是 Development 状态，字段名以后可能变）。**不采集提示词与回复内容** ——
// 那会把代码、规格、对话原文送到另一个系统去；要看内容，看本机的叙事归档与上下文装配记录。
// trace id 与日志（core/log.mjs）同一个，span id 也写进日志上下文：收集端的一条 span 能对回本机日志的那几行。
//
// 导出失败只记一次警告、不重试、不阻塞：观测不能拖垮被观测的东西。

import { randomBytes } from 'node:crypto';
import { traceId, logContext, withLogContext } from './log.mjs';
import { procKind } from './lifetimes.mjs';

const SPAN_KIND = { INTERNAL: 1, CLIENT: 3 };
const STATUS = { OK: 1, ERROR: 2 };
const MAX_BATCH = 64;
const FLUSH_MS = 5000;

let buf = [];
let timer = null;
let warned = false;
let fetchImpl = (...a) => globalThis.fetch(...a);

/** 测试用：换掉 fetch。 */
export function setOtelFetch(fn) { fetchImpl = fn ?? ((...a) => globalThis.fetch(...a)); }

export function otelEndpoint(env = process.env) {
  if (String(env.OTEL_SDK_DISABLED).toLowerCase() === 'true') return null;
  if (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) return `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, '')}/v1/traces`;
  return null;
}
export const otelEnabled = () => otelEndpoint() != null;

const headersFrom = (s) => Object.fromEntries(String(s ?? '').split(',').map((kv) => kv.trim()).filter(Boolean)
  .map((kv) => { const i = kv.indexOf('='); return i > 0 ? [decodeURIComponent(kv.slice(0, i).trim()), decodeURIComponent(kv.slice(i + 1).trim())] : null; })
  .filter(Boolean));

const anyValue = (v) => (typeof v === 'boolean' ? { boolValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
    : { stringValue: String(v) });
const attrs = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([key, v]) => ({ key, value: anyValue(v) }));
const nanos = (ms) => `${BigInt(Math.round(ms * 1000)) * 1000n}`;

/**
 * 在一个 span 里跑 fn：fn 及其异步续体里的日志带上这个 span id，里面再起的 span 以它为父。
 * 没开导出时直接跑 fn（零开销，只多一次判断）。fn 可以返回 { result, attrs } 之外的任何东西；结束时的属性用 onEnd 补。
 * @param {string} name
 * @param {{kind?: 'INTERNAL'|'CLIENT', attributes?: object, onEnd?: (result: any) => object}} opts
 */
export async function withSpan(name, { kind = 'INTERNAL', attributes = {}, onEnd = null } = {}, fn) {
  if (!otelEnabled()) return fn();
  const spanId = randomBytes(8).toString('hex');
  const parent = logContext().span ?? null;
  const t0 = performance.timeOrigin + performance.now();
  const ctx = logContext();
  const base = { 'superintern.task_id': ctx.task, 'superintern.node_id': ctx.node, ...attributes };
  let status = { code: STATUS.OK }, extra = {};
  try {
    const r = await withLogContext({ span: spanId }, fn);
    if (onEnd) { try { extra = onEnd(r) ?? {}; } catch { /* 取属性出错不影响结果 */ } }
    return r;
  } catch (e) {
    status = { code: STATUS.ERROR, message: String(e?.message ?? e).slice(0, 300) };
    extra = { 'error.type': e?.name === 'Error' ? (e?.code ?? 'Error') : (e?.name ?? 'Error') };
    if (onEnd) { try { Object.assign(extra, onEnd(null, e) ?? {}); } catch { /* 同上 */ } }
    throw e;
  } finally {
    buf.push({ traceId: traceId(), spanId, ...(parent ? { parentSpanId: parent } : {}), name, kind: SPAN_KIND[kind] ?? 1,
      startTimeUnixNano: nanos(t0), endTimeUnixNano: nanos(performance.timeOrigin + performance.now()),
      attributes: attrs({ ...base, ...extra }), status });
    if (buf.length >= MAX_BATCH) void flushSpans();
    else if (!timer) { timer = setTimeout(() => { timer = null; void flushSpans(); }, FLUSH_MS); timer.unref?.(); }
  }
}

/** 把攒着的 span 发出去。进程退出前要 await 一次（cli 已在收尾时调）。 */
export async function flushSpans() {
  if (timer) { clearTimeout(timer); timer = null; }
  const url = otelEndpoint();
  if (!url || !buf.length) { buf = []; return { sent: 0 }; }
  const spans = buf; buf = [];
  const body = { resourceSpans: [{
    resource: { attributes: attrs({ 'service.name': process.env.OTEL_SERVICE_NAME || 'superintern', 'process.pid': process.pid, 'superintern.proc': procKind() }) },
    scopeSpans: [{ scope: { name: 'superintern' }, spans }],
  }] };
  try {
    const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headersFrom(process.env.OTEL_EXPORTER_OTLP_HEADERS) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { sent: spans.length };
  } catch (e) {
    if (!warned) { warned = true; console.warn(`[otel] 追踪导出失败（之后不再提示）：${e.message}`); }
    return { sent: 0, error: e.message };
  }
}
