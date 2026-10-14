// 统一脱敏：凡是要落盘、要发出去的文字，经这里去掉密钥。
//
// 两类规则：
//   ① 形状：常见厂商密钥前缀（sk- / gh*_ / github_pat_ / AKIA / xox*- / AIza）、私钥 PEM 块、Authorization 头、URL 里的口令、JWT。
//      发布导出时的密钥扫描（release/export.mjs）用的是同一份 SECRET_PATTERNS。
//   ② 已知值：环境变量里名字像密钥的（*_KEY / *_TOKEN / *SECRET* / *PASSWORD* / *_PAT）、本进程用过的连接明文
//      （core/credentials.mjs 解密时登记）—— 形状认不出的自建网关 key、内网令牌靠这一条。
//
// 接在写入层，而不是指望每个调用点记得：
//   · 库：db.run 的写语句（INSERT / UPDATE / REPLACE）字符串参数一律过一遍（db/db.mjs wrap）—— 审计 payload、消息与答复
//     （人把 key 贴进对话，原来原样进库、再进模型上下文，等于把 key 发给了模型厂商）、节点产出、报告、上下文装配记录都在内；
//     连接表（credentials，存的是密文）除外。
//   · JSON 行日志与 console 输出（core/log.mjs）、模型调用录制（llm/client.mjs record）、通知标题与正文（core/notify.mjs，发往第三方）。
// 不动发给模型的请求本身：代理改代码时读到的测试夹具里的假 key 被换掉，会把 [redacted] 写回文件。

export const REDACTED = '[redacted]';

/** 形状规则（导出扫描与脱敏共用）。[正则（不带 g）, 说明] */
export const SECRET_PATTERNS = [
  // 要带上密钥体才算：界面提示里"以 -----BEGIN OPENSSH PRIVATE KEY----- 开头"这种只有头的文字不动。没有结尾（截断的）一直去到末尾
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\s+[A-Za-z0-9+/=]{20,}[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/, '私钥'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, '疑似 API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, '疑似 GitHub 令牌'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/, '疑似 GitHub 令牌'],
  [/\bAKIA[0-9A-Z]{16}\b/, '疑似 AWS key'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, '疑似 Slack 令牌'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, '疑似 Google API key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, '疑似 JWT'],
];
// 只脱值、保留前缀的（看得出"这里原来有个什么"）：Authorization 头、URL 里的用户名:口令
const KEEP_PREFIX = [
  /(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[A-Za-z0-9+/=._~-]{8,}/gi,
  /(\b(?:x-api-key|api[-_]?key|x-goog-api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{12,}/gi,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{4,}(?=@)/gi,
];
const GLOBAL = SECRET_PATTERNS.map(([re]) => new RegExp(re.source, 'g'));

const SECRET_ENV_NAME = /(?:_KEY|_TOKEN|SECRET|PASSWORD|_PAT|_PASS)$|^(?:GITHUB_TOKEN|SUPERINTERN_MASTER_KEY)$/i;
const MIN_KNOWN = 12;   // 太短的值不登记：会误伤正常文字
const known = new Set();

/** 登记一个已知密钥值（解密出来的连接明文等）。 */
export function registerSecret(value) {
  const v = String(value ?? '').trim();
  if (v.length >= MIN_KNOWN) known.add(v);
}

/** 当前要按值去掉的：登记过的 + 环境变量里名字像密钥的。环境可能在运行中改（看板上填 key）：对 process.env 缓存 1 秒，别的现算。 */
let cache = null;
function knownValues(env) {
  if (env === process.env) {
    const t = Date.now();
    if (cache && cache.size === known.size && t - cache.at < 1000) return cache.values;
    cache = { at: t, size: known.size, values: computeKnown(env) };
    return cache.values;
  }
  return computeKnown(env);
}
function computeKnown(env) {
  const out = new Set(known);
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!v || !SECRET_ENV_NAME.test(k)) continue;
    const s = String(v).trim();
    if (s.length >= MIN_KNOWN) out.add(s);
  }
  // OTLP 收集端的认证头（k=v,k=v）：值部分也算
  for (const part of String(env?.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',')) {
    const v = part.split('=').slice(1).join('=').trim();
    if (v.length >= MIN_KNOWN) out.add(decodeURIComponent(v));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** 文字脱敏。不是字符串原样返回。 */
export function redact(text, { env = process.env, values = null } = {}) {
  if (typeof text !== 'string' || !text) return text;
  let s = text;
  for (const v of values ?? knownValues(env)) if (s.includes(v)) s = s.split(v).join(REDACTED);
  for (const re of GLOBAL) s = s.replace(re, REDACTED);
  for (const re of KEEP_PREFIX) s = s.replace(re, (_, keep) => `${keep}${REDACTED}`);
  return s;
}

/** 对象逐层脱敏（审计 payload、日志字段）：字符串值脱，结构不动。 */
export function redactDeep(value, opts = {}, depth = 0) {
  if (depth === 0 && !opts.values) opts = { ...opts, values: knownValues(opts.env ?? process.env) };   // 已知值整棵树只算一次
  if (typeof value === 'string') return redact(value, opts);
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map((x) => redactDeep(x, opts, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, opts, depth + 1);
  return out;
}

/** 库写语句的参数：INSERT / UPDATE / REPLACE 的字符串参数脱敏；读语句与连接表原样。 */
const WRITE_SQL = /^\s*(?:INSERT|UPDATE|REPLACE)\s+(?:OR\s+\w+\s+)?(?:INTO\s+)?["`]?(\w+)/i;
const EXEMPT_TABLES = new Set(['credentials']);
export function redactParams(sql, params) {
  const m = WRITE_SQL.exec(sql);
  if (!m || EXEMPT_TABLES.has(m[1].toLowerCase())) return params;
  let values = null, out = params;
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (typeof p !== 'string' || p.length < 8) continue;
    values ??= knownValues(process.env);
    const r = redact(p, { values });
    if (r !== p) { if (out === params) out = [...params]; out[i] = r; }
  }
  return out;
}

/** 有没有命中（测试与导出扫描用）：返回命中的说明列表。 */
export function findSecrets(text, { env = process.env } = {}) {
  const hits = [];
  for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) hits.push(what);
  if (knownValues(env).some((v) => text.includes(v))) hits.push('已知密钥值');
  return hits;
}
