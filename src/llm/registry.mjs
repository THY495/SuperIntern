// 注册表三层的**生效值**：服务商 / 模型目录 / 档位绑定 = 代码默认值 ⊕ 库里的部署级配置。
//
// 模型目录由用户经界面增删、档位绑定由用户经界面改，不只靠代码常量 + `--bind` 旗标。
// 做法：
//   - 代码里的 VENDORS / MODEL_CATALOG / TIER_BINDING 是**默认值**，不再是真相；
//   - 库里的 llm_endpoints / llm_models / llm_bindings 叠加在默认值上（默认项的行里 NULL 字段 = 继承）；
//   - 所有花钱的路径（run / plan / draft / 看板分类器 / 守护进程目录检查）都从这里取生效值，每次建客户端重读一次；
//   - `--bind` 降为一次性覆盖（cli.mjs），不再是常态配置。
// 凭证**不进库、不回显**：服务商只记 .env 变量名，这里只回答"填了没有"。
// 改动全部记审计（endpoint_saved / model_saved / binding_set …）：同一份代码在不同部署上跑的模型不同，复现要连这些一起看。

import { VENDORS, MODEL_CATALOG, TIER_BINDING, SINGLE_VENDOR_BINDINGS, TIERS, EFFORTS } from './canonical.mjs';
import { PROVIDERS } from './providers.mjs';
import { audit, now } from '../db/db.mjs';
import { tl, contentLang, I18nError } from '../i18n/index.mjs';

export const ADAPTERS = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];

/** 各API 格式的默认：鉴权头、前缀、列表路径、官方地址。新增服务商只填与此不同的部分。 */
export const ADAPTER_DEFAULTS = {
  'openai-chat': { authHeader: 'authorization', authPrefix: 'Bearer ', modelsPath: '/models', baseUrl: 'https://api.openai.com/v1', label: 'OpenAI Chat Completions（OpenAI 兼容）' },
  'openai-responses': { authHeader: 'authorization', authPrefix: 'Bearer ', modelsPath: '/models', baseUrl: 'https://api.openai.com/v1', label: 'OpenAI Responses' },
  anthropic: { authHeader: 'x-api-key', authPrefix: '', modelsPath: '/models?limit=100', baseUrl: 'https://api.anthropic.com/v1', label: 'Anthropic Messages' },
  gemini: { authHeader: 'x-goog-api-key', authPrefix: '', modelsPath: '/models?pageSize=1000', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', label: 'Gemini' },
};

const j = (s, fallback = null) => { if (s == null) return fallback; try { return JSON.parse(s); } catch { return fallback; } };
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEY_RE = /^[a-z0-9][a-z0-9_-]*\/\S+$/;

// ── 服务商 ────────────────────────────────────────────────────────────────

/** 生效的服务商表：{ id → { id, label, adapter, baseUrl, keyEnv, authHeader, authPrefix, modelsPath, gateway, billing, enabled, source, overridden } } */
export function endpointsOf(db, { vendors = VENDORS } = {}) {
  const out = {};
  for (const [id, v] of Object.entries(vendors)) {
    out[id] = { id, label: id, adapter: v.adapter, baseUrl: v.baseUrl ?? ADAPTER_DEFAULTS[v.adapter]?.baseUrl ?? null, keyEnv: v.keyEnv,
      authHeader: null, authPrefix: null, modelsPath: null, gateway: !!v.gateway, billing: v.billing ?? 'computed', enabled: true, source: 'default', overridden: false };
  }
  for (const r of db.all(`SELECT * FROM llm_endpoints`)) {
    const base = out[r.id];
    out[r.id] = { id: r.id, label: r.label ?? base?.label ?? r.id, adapter: r.adapter ?? base?.adapter ?? null, baseUrl: r.base_url ?? base?.baseUrl ?? null,
      keyEnv: r.key_env ?? base?.keyEnv ?? null, authHeader: r.auth_header ?? null, authPrefix: r.auth_prefix ?? null, modelsPath: r.models_path ?? null,
      gateway: r.gateway == null ? (base?.gateway ?? false) : !!r.gateway, billing: r.billing ?? base?.billing ?? 'computed', enabled: !!r.enabled,
      source: base ? 'default' : 'user', overridden: !!base, updatedAt: r.updated_at };
    // 孤儿：这行是对某个默认服务商的覆盖（adapter 继承所以是 NULL），而那个默认项在这一版代码里没了。
    // 规则是 VENDORS 的 id 只增不删（canonical.mjs），这里是规则被破坏时的兜底：标出来、不许用、只许删。
    if (!base && r.adapter == null) Object.assign(out[r.id], { orphan: true, enabled: false });
  }
  return out;
}

/** 与代码默认值的差异（看板"与默认值不同"栏）。用户新增的返回 null（没有可比的默认）。 */
export function endpointDiff(e, { vendors = VENDORS } = {}) {
  const v = vendors[e.id];
  if (!v) return null;
  const d = [];
  const def = { adapter: v.adapter, baseUrl: v.baseUrl ?? ADAPTER_DEFAULTS[v.adapter]?.baseUrl ?? null, keyEnv: v.keyEnv, gateway: !!v.gateway, billing: v.billing ?? 'computed', enabled: true, authHeader: null, authPrefix: null, modelsPath: null };
  for (const k of Object.keys(def)) if ((e[k] ?? null) !== (def[k] ?? null)) d.push({ field: k, from: def[k], to: e[k] });
  return d;
}

function validateEndpoint(e, lang = 'zh') {
  const errs = [];
  if (!ID_RE.test(e.id ?? '')) errs.push(tl(lang, 'id 无效：只能包含小写字母、数字、- 和 _，长度 1–32（用作模型键前缀）'));
  if (!ADAPTERS.includes(e.adapter)) errs.push(tl(lang, 'API 格式无效：{adapter}（应为 {adapters}）；其他格式需要新增适配器', { adapter: e.adapter, adapters: ADAPTERS.join(' / ') }));
  if (!e.baseUrl || !/^https?:\/\/\S+$/.test(e.baseUrl)) errs.push(tl(lang, '地址无效：应为 http(s) URL，写到版本前缀为止（例如 https://api.deepseek.com/v1）'));
  if (!ENV_RE.test(e.keyEnv ?? '')) errs.push(tl(lang, 'API 密钥的变量名无效：只能包含大写字母、数字和下划线（即写入 .env 的变量名）'));
  if (e.authHeader != null && !/^[A-Za-z][A-Za-z0-9-]*$/.test(e.authHeader)) errs.push(tl(lang, '鉴权头名称无效：{header}（只能包含字母、数字和 -，以字母开头）', { header: e.authHeader }));
  if (e.billing && !['computed', 'reported'].includes(e.billing)) errs.push(tl(lang, '计费方式无效：{billing}（应为 computed 按目录单价计算，或 reported 按响应计费）', { billing: e.billing }));
  // 回报花费靠请求里的 usage:{include:true}，那只在 gateway 为真时才发（providers.mjs）；不是聚合平台却选 reported = 保证拿不到花费，
  // 而 reported 又免掉"缺单价不能用" —— 要到第一次记账才炸。在入口拦。
  if (e.billing === 'reported' && !e.gateway) errs.push(tl(lang, '按响应计费仅适用于聚合网关，请先勾选「聚合网关」'));
  return errs;
}

/**
 * 新增或修改服务商。默认服务商只存与默认值不同的字段（NULL = 继承），用户新增的存全部。
 * 返回生效行。
 */
export function saveEndpoint(db, { id, label, adapter, baseUrl, keyEnv, authHeader, authPrefix, modelsPath, gateway, billing, enabled, userId, vendors = VENDORS }) {
  return db.tx(() => {
  const def = vendors[id] ?? null;
  const before = endpointsOf(db, { vendors })[id] ?? null;   // 没给的字段保留现值（改一项不必重填全部）
  if (before?.orphan) throw new I18nError('新版本已不再内置服务商 {id}（仅剩本地覆盖项），不能修改，只能删除', { id });
  const keep = (v, prev) => (v === undefined ? (prev ?? null) : v);
  label = keep(label, before?.label === before?.id ? null : before?.label); adapter = keep(adapter, before?.adapter); baseUrl = keep(baseUrl, before?.baseUrl); keyEnv = keep(keyEnv, before?.keyEnv);
  authHeader = keep(authHeader, before?.authHeader); authPrefix = keep(authPrefix, before?.authPrefix); modelsPath = keep(modelsPath, before?.modelsPath);
  gateway = gateway === undefined ? (before ? before.gateway : null) : gateway; billing = keep(billing, before?.billing); enabled = enabled === undefined ? (before?.enabled ?? true) : !!enabled;
  if (typeof baseUrl === 'string') baseUrl = baseUrl.trim().replace(/\/+$/, '');   // 尾斜杠统一去掉：adapter.endpoint 是 base + '/chat/completions'
  const full = { id, adapter: adapter ?? def?.adapter, baseUrl: baseUrl ?? def?.baseUrl ?? ADAPTER_DEFAULTS[adapter ?? def?.adapter]?.baseUrl, keyEnv: keyEnv ?? def?.keyEnv, authHeader, authPrefix, modelsPath,
    gateway: !!(gateway ?? def?.gateway), billing: billing ?? def?.billing ?? 'computed' };
  // 可能一次报好几条：按内容语言拼（只有一条固定文字时，出口还能按整句再翻成看的人的语言）
  const L = contentLang(db);
  const errs = validateEndpoint(full, L);
  if (errs.length) throw new Error(errs.join(tl(L, '；')));
  // 停用检查放在这里而不是 setEndpointEnabled：带 enabled:false 的保存（API / 脚本）是同一件事，不能是旁路
  if (before?.enabled && !enabled) {
    const bound = boundTiersOfEndpoint(db, id, { vendors });
    if (bound.length) throw boundErr(bound, L);
  }
  const t = now();
  const inherit = (v, d) => (def && v === d ? null : v);   // 默认项：与默认值相同的字段不存
  {
// 出厂项只存与出厂值不同的字段。全都相同且启用 = 这行没有内容了 → 删掉而不是留一条全 NULL 的行，
    // 保住"库里有行 ⇔ 与出厂值不同"（overridden / "恢复出厂值"按钮 / removeEndpoint 的"没有可删的覆盖"都靠它）。
    // 典型来路：停用再启用。审计照记。
    const stored = [label, inherit(full.adapter, def?.adapter), inherit(full.baseUrl, def?.baseUrl ?? ADAPTER_DEFAULTS[def?.adapter]?.baseUrl), inherit(full.keyEnv, def?.keyEnv),
      authHeader, authPrefix, modelsPath, gateway == null ? null : (def && !!gateway === !!def.gateway ? null : (gateway ? 1 : 0)), inherit(full.billing, def?.billing ?? 'computed')];
    if (def && enabled && stored.every((v) => v == null)) db.run(`DELETE FROM llm_endpoints WHERE id=?`, id);
    else db.run(`INSERT INTO llm_endpoints (id,label,adapter,base_url,key_env,auth_header,auth_prefix,models_path,gateway,billing,enabled,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET label=excluded.label, adapter=excluded.adapter, base_url=excluded.base_url, key_env=excluded.key_env,
              auth_header=excluded.auth_header, auth_prefix=excluded.auth_prefix, models_path=excluded.models_path, gateway=excluded.gateway,
              billing=excluded.billing, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      id, ...stored, enabled ? 1 : 0, t, t);
    audit(db, { actorKind: 'user', actorId: userId, action: 'endpoint_saved', targetType: 'endpoint', targetId: id,
      payload: { before: before ? pick(before) : null, after: pick({ ...full, label, enabled }) } });
  }
  return endpointsOf(db, { vendors })[id];
  }, { immediate: true });
}
const pick = (e) => ({ label: e.label ?? null, adapter: e.adapter, baseUrl: e.baseUrl, keyEnv: e.keyEnv, authHeader: e.authHeader ?? null, authPrefix: e.authPrefix ?? null, modelsPath: e.modelsPath ?? null, gateway: !!e.gateway, billing: e.billing, enabled: !!e.enabled });

/** 启停服务商。停用的服务商：绑定不许指向它的模型；已绑定的在下一个节点建客户端时报错（不静默换厂商）。 */
export function setEndpointEnabled(db, { id, enabled, userId, vendors = VENDORS }) {
  if (!endpointsOf(db, { vendors })[id]) throw new I18nError('服务商不存在：{id}', { id });
  return saveEndpoint(db, { id, enabled: !!enabled, userId, vendors });   // 绑定检查、写锁、审计都在 saveEndpoint 里，只有一份
}

/** 删除：用户新增的整行删掉；默认服务商只删覆盖行（回到代码默认值）。有模型绑着的不许删。 */
export function removeEndpoint(db, { id, userId, vendors = VENDORS }) {
  const e = endpointsOf(db, { vendors })[id];
  if (!e) throw new I18nError('服务商不存在：{id}', { id });
  const bound = boundTiersOfEndpoint(db, id, { vendors });
  if (bound.length) throw new I18nError('{list}，请先修改模型分配再删除', { list: boundList(bound, contentLang(db)) });
  const row = db.one(`SELECT id FROM llm_endpoints WHERE id=?`, id);
  if (!row) throw new I18nError('{id} 是内置默认值，没有可删除的本地修改；如不再使用，请停用', { id });
  db.tx(() => {
    db.run(`DELETE FROM llm_endpoints WHERE id=?`, id);
    if (e.source === 'user') db.run(`DELETE FROM llm_models WHERE vendor=?`, id);
    audit(db, { actorKind: 'user', actorId: userId, action: 'endpoint_removed', targetType: 'endpoint', targetId: id, payload: { reverted: e.source === 'default' } });
  });
  return { id, reverted: e.source === 'default' };
}

function boundTiersOfEndpoint(db, id, { vendors, catalog = MODEL_CATALOG } = {}) {
  const cat = catalogOf(db, { catalog, vendors });
  const b = bindingOf(db).binding;
  return TIERS.filter((t) => cat[b[t]]?.vendor === id).map((t) => ({ tier: t, key: b[t] }));
}

/** key 填没填（只看在不在，值不出这个函数）。 */
export function keyPresence(endpoints, env = process.env) {
  return Object.fromEntries(Object.values(endpoints).map((e) => [e.id, { keyEnv: e.keyEnv, present: !!(e.keyEnv && env[e.keyEnv]) }]));
}

/** 按服务商组请求头：API 格式默认 + 用户改的鉴权头（Azure 的 api-key 之类）。 */
export function headersFor(adapter, endpoint, key) {
  const h = adapter.headers(key);
  if (endpoint?.authHeader) {
    for (const k of ['authorization', 'x-api-key', 'x-goog-api-key']) delete h[k];
    h[endpoint.authHeader.toLowerCase()] = `${endpoint.authPrefix ?? ''}${key}`;
  }
  return h;
}

/** 模型列表的 URL：base + API 格式默认路径（或用户填的）。 */
export const modelsUrlOf = (e) => `${String(e.baseUrl ?? '').replace(/\/+$/, '')}${e.modelsPath ?? ADAPTER_DEFAULTS[e.adapter]?.modelsPath ?? '/models'}`;

/**
 * 从服务商拉模型列表。返回 { rows: [{ id, pricing?, contextWindow?, efforts?, expires? }], error, noKey }。
 * 只有 OpenRouter 的表带价格 / 窗口 / supported_parameters；其它平台的列表只有 id。没 key 也试一次（OpenRouter 的表是公开的）。
 */
// lang：给人看的 error 用哪种语言（看板传请求人的界面语言；默认中文）
export async function listEndpointModels(e, { env = process.env, fetchFn = globalThis.fetch, lang = 'zh' } = {}) {
  const key = e.keyEnv ? env[e.keyEnv] : null;
  const adapter = PROVIDERS[e.adapter];
  if (!adapter) return { rows: [], error: tl(lang, '没有 {adapter} API 格式的适配器', { adapter: e.adapter }), noKey: !key };
  const headers = key ? headersFor(adapter, e, key) : {};
  delete headers['content-type'];
  try {
    const res = await fetchFn(modelsUrlOf(e), { headers });
    if (!res.ok) return { rows: [], error: `HTTP ${res.status}${!key ? tl(lang, '（未配置 API 密钥）') : ''}`, noKey: !key };
    const body = await res.json();
    const per = (x) => (x == null ? null : Math.round(Number(x) * 1e6 * 1e4) / 1e4);   // $/token → $/M token，四位小数够了，去掉浮点尾巴
    if (e.adapter === 'gemini') {
      return { rows: (body.models ?? []).map((m) => ({ id: String(m.name).replace(/^models\//, ''), contextWindow: m.inputTokenLimit ? Number(m.inputTokenLimit) : null })), error: null, noKey: !key };
    }
    const rows = (body.data ?? body.models ?? []).map((m) => {
      const p = m.pricing ?? null;
      const pricing = p && (p.prompt != null || p.completion != null) ? { input: per(p.prompt) ?? 0, output: per(p.completion) ?? 0, cacheRead: per(p.input_cache_read) ?? undefined, cacheWrite: per(p.input_cache_write) ?? undefined } : null;
      return { id: String(m.id ?? m.name), pricing, contextWindow: m.context_length ? Number(m.context_length) : null,
        efforts: Array.isArray(m.supported_parameters) ? ((m.supported_parameters.includes('reasoning_effort') || m.supported_parameters.includes('reasoning')) ? EFFORTS : []) : null,
        expires: m.expiration_date ?? null };
    });
    return { rows, error: null, noKey: !key };
  } catch (err) { return { rows: [], error: err.message, noKey: !key }; }
}

/** "测试连接"：发一次 16 token 的最小请求。model 不给就取该服务商目录里第一个启用的模型。返回 { ok, status, message, model }。 */
export async function testEndpoint(db, { id, model = null, env = process.env, fetchFn = globalThis.fetch, vendors = VENDORS, catalog = MODEL_CATALOG, lang = 'zh' }) {
  const e = endpointsOf(db, { vendors })[id];
  if (!e) throw new I18nError('服务商不存在：{id}', { id });
  const key = e.keyEnv ? env[e.keyEnv] : null;
  if (!key) return { ok: false, status: null, message: tl(lang, '.env 中未设置 {keyEnv}', { keyEnv: e.keyEnv }), model: null };
  const cat = catalogOf(db, { catalog, vendors });
  const entry = model ? { model, adapter: e.adapter } : Object.values(cat).find((m) => m.vendor === id && m.enabled) ?? null;
  if (!entry) return { ok: false, status: null, message: tl(lang, '该服务商下还没有模型，请先在模型列表中添加'), model: null };
  const adapter = PROVIDERS[entry.adapter ?? e.adapter];
  const canon = { tier: 'x', maxTokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  try {
    const res = await fetchFn(adapter.endpoint(entry.model, e.baseUrl), { method: 'POST', headers: headersFor(adapter, e, key),
      body: JSON.stringify(adapter.buildRequest({ ...canon, gateway: e.gateway, providerPrefs: entry.providerPrefs }, entry.model)) });
    if (res.ok) return { ok: true, status: res.status, message: tl(lang, '连接成功'), model: entry.model };
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, message: `HTTP ${res.status}: ${String(body.error?.message ?? body.message ?? '').slice(0, 160)}`, model: entry.model };
  } catch (err) { return { ok: false, status: null, message: tl(lang, '请求失败：{msg}', { msg: err.message }), model: entry.model }; }
}

// ── 模型目录 ──────────────────────────────────────────────────────────────

/** 生效目录：{ key → { key, vendor, model, adapter?, efforts?, pricing?, contextWindow?, providerPrefs?, notes, enabled, source, overridden, origin } } */
export function catalogOf(db, { catalog = MODEL_CATALOG, vendors = VENDORS } = {}) {
  const out = {};
  for (const [key, e] of Object.entries(catalog)) out[key] = { ...e, key, notes: e.notes ?? [], enabled: true, source: 'default', overridden: false, origin: null };
  for (const r of db.all(`SELECT * FROM llm_models`)) {
    const base = out[r.key];
    out[r.key] = {
      key: r.key, vendor: r.vendor ?? base?.vendor ?? null, model: r.model ?? base?.model ?? null,
      adapter: r.adapter ?? base?.adapter, efforts: r.efforts != null ? j(r.efforts, base?.efforts) : base?.efforts,
      pricing: r.pricing != null ? j(r.pricing, base?.pricing ?? null) : (base?.pricing ?? null),
      contextWindow: r.context_window ?? base?.contextWindow, providerPrefs: r.provider_prefs != null ? j(r.provider_prefs, base?.providerPrefs) : base?.providerPrefs,
      notes: r.notes != null ? j(r.notes, base?.notes ?? []) : (base?.notes ?? []),
      enabled: !!r.enabled, source: base ? 'default' : 'user', overridden: !!base, origin: r.origin, updatedAt: r.updated_at,
    };
    for (const k of ['adapter', 'efforts', 'contextWindow', 'providerPrefs']) if (out[r.key][k] === undefined) delete out[r.key][k];
    // 孤儿（同服务商）：对默认模型的覆盖行，默认项在这一版代码里没了。MODEL_CATALOG 的键只增不删是规则，这里是兜底。
    if (!base && r.vendor == null) Object.assign(out[r.key], { orphan: true, enabled: false });
  }
  return out;
}

/** 不能绑定的原因；能绑返回 null。价格是预算闸门的依据，缺了不许绑（走回报计费的平台可免）。lang：原因用哪种语言写（默认中文）。 */
export function bindable(entry, endpoints, lang = 'zh') {
  if (!entry) return tl(lang, '模型不在目录中');
  if (entry.orphan) return tl(lang, '新版本已不再内置该模型（仅剩本地覆盖项），不可用；先改模型分配，再删除这条');
  const e = endpoints[entry.vendor];
  if (!e) return tl(lang, '服务商 {vendor} 不存在', { vendor: entry.vendor });
  if (e.orphan) return tl(lang, '新版本已不再内置服务商 {vendor}，其模型不可用；先改模型分配，再删除该服务商', { vendor: entry.vendor });
  if (!e.enabled) return tl(lang, '服务商 {vendor} 已停用', { vendor: entry.vendor });
  if (!entry.enabled) return tl(lang, '模型已停用');
  if (!e.keyEnv) return tl(lang, '服务商 {vendor} 未设置 API 密钥变量名', { vendor: entry.vendor });
  const p = entry.pricing;
  if (e.billing !== 'reported' && !(p && Number.isFinite(p.input) && Number.isFinite(p.output))) return tl(lang, '未填写单价，无法计入预算上限，不能分配');
  return null;
}

// "x 档正在使用 y" 的清单（嵌在报错里，按内容语言写）
const boundList = (bound, L) => bound.map((b) => tl(L, '{tier} 档正在使用 {key}', { tier: b.tier, key: b.key })).join(tl(L, '，'));
const boundErr = (bound, L) => new I18nError('{list}，请先修改模型分配再停用', { list: boundList(bound, L) });

function validatePricing(p) {
  if (p == null) return null;
  const out = {};
  for (const f of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (p[f] == null || p[f] === '') continue;
    const n = Number(p[f]);
    if (!Number.isFinite(n) || n < 0) throw new I18nError('单价 {field} 无效：必须是 ≥ 0 的数字（USD / 百万 token）', { field: f });
    out[f] = n;
  }
  if (out.input == null || out.output == null) throw new I18nError('单价至少需要填写 input 与 output');
  return out;
}

/**
 * 新增或修改模型。默认目录里的键只存改过的字段（其余 NULL = 继承）；新键存全部。
 * `fields` 里给 undefined 的字段不动，给 null 的字段清成继承 / 缺。
 */
export function saveModel(db, { key, fields = {}, origin = 'user', userId, actorKind = 'user', catalog = MODEL_CATALOG, vendors = VENDORS }) {
  if (!KEY_RE.test(key ?? '')) throw new I18nError('模型键无效：格式应为「服务商/模型名」（例如 deepseek/deepseek-flash）');
  return db.tx(() => {
  const endpoints = endpointsOf(db, { vendors });
  const cat = catalogOf(db, { catalog, vendors });
  const before = cat[key] ?? null;
  if (before?.orphan) throw new I18nError('{key}：新版本已不再内置该模型（仅剩本地覆盖项），不可用；先改模型分配，再删除这条', { key });
  const def = catalog[key] ?? null;
  const vendor = fields.vendor !== undefined ? fields.vendor : (before?.vendor ?? key.split('/')[0]);
  if (!endpoints[vendor]) throw new I18nError('服务商 {vendor} 不存在，请先添加该服务商', { vendor });
  const model = fields.model !== undefined ? fields.model : (before?.model ?? key.split('/').slice(1).join('/'));
  if (!model || /\s/.test(model)) throw new I18nError('模型名不能为空或含空白');
  const adapter = fields.adapter !== undefined ? fields.adapter : (before?.adapter ?? null);
  if (adapter != null && !ADAPTERS.includes(adapter)) throw new I18nError('API 格式无效：{adapter}（应为 {adapters}）', { adapter, adapters: ADAPTERS.join(' / ') });
  const efforts = fields.efforts !== undefined ? fields.efforts : (before?.efforts ?? null);
  if (efforts != null && (!Array.isArray(efforts) || efforts.some((x) => !EFFORTS.includes(x)))) throw new I18nError('推理强度取值无效（只能包含 {efforts}）', { efforts: EFFORTS.join(' / ') });
  const strip = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
  const pricing = fields.pricing !== undefined ? validatePricing(fields.pricing === null ? null : { ...(before?.pricing ?? {}), ...strip(fields.pricing) }) : (before?.pricing ?? null);
  const contextWindow = fields.contextWindow !== undefined ? fields.contextWindow : (before?.contextWindow ?? null);
  if (contextWindow != null && !(Number.isInteger(Number(contextWindow)) && Number(contextWindow) > 0)) throw new I18nError('上下文窗口必须是正整数（单位：token）');
  const providerPrefs = fields.providerPrefs !== undefined ? fields.providerPrefs : (before?.providerPrefs ?? null);
  const notes = fields.notes !== undefined ? fields.notes : (before?.notes ?? []);
  const enabled = fields.enabled !== undefined ? !!fields.enabled : (before?.enabled ?? true);
  if (before?.enabled && !enabled) {   // 与服务商同一条规则：有档位在用就停不了（否则一点"停用"某档当场失效）
    const b = bindingOf(db).binding;
    const tiers = TIERS.filter((t) => b[t] === key);
    if (tiers.length) throw boundErr(tiers.map((t) => ({ tier: t, key })), contentLang(db));
  }
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const inherit = (v, d) => (def && same(v, d) ? null : v);
  const t = now();
  {
// 同服务商：出厂项改回与出厂值全同且启用 → 删行，不留全 NULL 的覆盖（否则永久显示"改过出厂值"）
    const js = (v, d) => (inherit(v, d) == null ? null : JSON.stringify(v));
    const stored = [inherit(vendor, def?.vendor), inherit(model, def?.model), inherit(adapter, def?.adapter ?? null), js(efforts, def?.efforts ?? null), js(pricing, def?.pricing ?? null),
      inherit(contextWindow, def?.contextWindow ?? null) == null ? null : Number(contextWindow), js(providerPrefs, def?.providerPrefs ?? null), js(notes, def?.notes ?? [])];
    if (def && enabled && stored.every((v) => v == null)) db.run(`DELETE FROM llm_models WHERE key=?`, key);
    else db.run(`INSERT INTO llm_models (key,vendor,model,adapter,efforts,pricing,context_window,provider_prefs,notes,enabled,origin,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET vendor=excluded.vendor, model=excluded.model, adapter=excluded.adapter, efforts=excluded.efforts, pricing=excluded.pricing,
              context_window=excluded.context_window, provider_prefs=excluded.provider_prefs, notes=excluded.notes, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      key, ...stored, enabled ? 1 : 0, before?.origin ?? origin, t);
    audit(db, { actorKind, actorId: userId, action: 'model_saved', targetType: 'model', targetId: key,
      payload: { before: before ? pickModel(before) : null, after: pickModel({ vendor, model, adapter, efforts, pricing, contextWindow, providerPrefs, enabled }) } });
  }
  return catalogOf(db, { catalog, vendors })[key];
  }, { immediate: true });
}
const pickModel = (m) => ({ vendor: m.vendor, model: m.model, adapter: m.adapter ?? null, efforts: m.efforts ?? null, pricing: m.pricing ?? null, contextWindow: m.contextWindow ?? null, providerPrefs: m.providerPrefs ?? null, enabled: !!m.enabled });

/** 删除：用户加的整行删掉；默认目录里的只删覆盖行（回到代码默认值）。绑着的不许删。 */
export function removeModel(db, { key, userId, catalog = MODEL_CATALOG, vendors = VENDORS }) {
  const cat = catalogOf(db, { catalog, vendors });
  if (!cat[key]) throw new I18nError('模型不在目录中：{key}', { key });
  const b = bindingOf(db).binding;
  const tiers = TIERS.filter((t) => b[t] === key);
  if (tiers.length) throw new I18nError('{tiers} 档正在使用 {key}，请先修改模型分配再删除', { tiers: tiers.join(' / '), key });
  if (!db.one(`SELECT key FROM llm_models WHERE key=?`, key)) throw new I18nError('{id} 是内置默认值，没有可删除的本地修改；如不再使用，请停用', { id: key });
  db.tx(() => {
    db.run(`DELETE FROM llm_models WHERE key=?`, key);
    audit(db, { actorKind: 'user', actorId: userId, action: 'model_removed', targetType: 'model', targetId: key, payload: { reverted: cat[key].source === 'default' } });
  });
  return { key, reverted: cat[key].source === 'default' };
}

// ── 档位绑定 ──────────────────────────────────────────────────────────────

/** 生效绑定：{ binding: {light,standard,heavy}, efforts: {tier: effort|null}, source: 'db'|'default', missing: [tier…] } */
export function bindingOf(db, { defaults = TIER_BINDING } = {}) {
  const rows = db.all(`SELECT * FROM llm_bindings`);
  const binding = { ...defaults }, efforts = { light: null, standard: null, heavy: null }, missing = [];
  for (const r of rows) { binding[r.tier] = r.model_key; efforts[r.tier] = r.effort ?? null; }
  for (const t of TIERS) if (!rows.some((r) => r.tier === t)) missing.push(t);
  return { binding, efforts, source: rows.length ? 'db' : 'default', missing, updatedAt: rows.length ? Math.max(...rows.map((r) => r.updated_at)) : null };
}

/** 改一档。校验：模型在生效目录里、能绑（见 bindable）、推理强度在模型推理强度取值内。记审计 binding_set。 */
export function setBinding(db, { tier, modelKey, effort = undefined, userId, actorKind = 'user', catalog = MODEL_CATALOG, vendors = VENDORS }) {
  if (!TIERS.includes(tier)) throw new I18nError('档位无效：{tier}（应为 {tiers}）', { tier, tiers: TIERS.join(' / ') });
  return db.tx(() => {
  const cat = catalogOf(db, { catalog, vendors });
  const endpoints = endpointsOf(db, { vendors });
  const entry = cat[modelKey];
  const why = bindable(entry, endpoints, contentLang(db));
  if (why) throw new I18nError('无法分配 {key}：{why}', { key: modelKey, why });
  const cur = bindingOf(db);
  // 推理强度没给：同一个模型 = 保留；换了模型 = 清空（上一个模型的推理强度带过来，新模型不支持时会被莫名拒掉）
  const eff = effort === undefined ? (cur.binding[tier] === modelKey && cur.source === 'db' ? cur.efforts[tier] : null) : effort;
  if (eff != null) {
    const allowed = entry.efforts ?? EFFORTS;
    if (!EFFORTS.includes(eff)) throw new I18nError('推理强度无效：{effort}（应为 {efforts}）', { effort: eff, efforts: EFFORTS.join(' / ') });
    if (!allowed.length) throw new I18nError('{key} 不支持推理强度参数，请将推理强度留空', { key: modelKey });
    if (!allowed.includes(eff)) throw new I18nError('{key} 的推理强度只能是 {efforts}', { key: modelKey, efforts: allowed.join(' / ') });
  }
  const t = now();
  {
    db.run(`INSERT INTO llm_bindings (tier,model_key,effort,updated_at,updated_by) VALUES (?,?,?,?,?)
            ON CONFLICT(tier) DO UPDATE SET model_key=excluded.model_key, effort=excluded.effort, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      tier, modelKey, eff, t, userId);
    audit(db, { actorKind, actorId: userId, action: 'binding_set', targetType: 'binding', targetId: tier,
      payload: { from: cur.binding[tier] ?? null, to: modelKey, effortFrom: cur.efforts[tier], effort: eff, fromSource: cur.source } });
  }
  return bindingOf(db);
  }, { immediate: true });
}

/**
 * 表空时把默认绑定显式写库（init 用）。`overrides` 先叠在默认值上。不校验 bindable —— 默认绑定里 heavy 是 anthropic，
 * 本机没 key 也允许存在（那是"没配"不是"配错"）；但 overrides 走 setBinding 的校验。
 */
export function seedBinding(db, { overrides = {}, userId, defaults = TIER_BINDING }) {
  const cur = bindingOf(db, { defaults });
  if (cur.source === 'db' && !Object.keys(overrides).length) return { seeded: false, ...cur };
  const t = now();
  db.tx(() => {
    if (cur.source !== 'db') {
      for (const tier of TIERS) db.run(`INSERT OR IGNORE INTO llm_bindings (tier,model_key,effort,updated_at,updated_by) VALUES (?,?,NULL,?,?)`, tier, defaults[tier], t, userId);
      audit(db, { actorKind: 'user', actorId: userId, action: 'binding_seeded', targetType: 'binding', targetId: 'all', payload: { binding: { ...defaults } } });
    }
  });
  for (const [tier, key] of Object.entries(overrides)) setBinding(db, { tier, modelKey: key, userId });
  return { seeded: cur.source !== 'db', ...bindingOf(db, { defaults }) };
}

/**
 * init 用：表空、又没给 --bind 时，出厂默认里某档的服务商没填 key（典型：heavy 绑 anthropic，本机只有 DeepSeek 的 key），
 * 就按 env 里**已经有 key** 的那一家选三档。只看变量在不在，不读值。
 * 返回 { vendor, binding } 或 null（库里已有绑定 / 默认绑定的 key 都在 / 一家 key 都没有）。
 */
export function pickDefaultBinding(db, { env = process.env, defaults = TIER_BINDING, singles = SINGLE_VENDOR_BINDINGS, order = ['deepseek', 'anthropic', 'openai', 'gemini'], catalog = MODEL_CATALOG, vendors = VENDORS } = {}) {
  if (bindingOf(db, { defaults }).source === 'db') return null;
  const eps = endpointsOf(db, { vendors }), cat = catalogOf(db, { catalog, vendors });
  const has = (id) => !!(eps[id]?.enabled && eps[id]?.keyEnv && env[eps[id].keyEnv]);
  if (TIERS.every((t) => has(cat[defaults[t]]?.vendor))) return null;
  const vendor = order.find((v) => has(v) && singles[v]) ?? null;
  return vendor ? { vendor, binding: { ...singles[vendor] } } : null;
}

/** 生效绑定里的问题（看板与启动时提示）：模型 / 服务商停用、缺价格、key 没填。 */
// lang：why 用哪种语言写（看板传请求人的界面语言；默认中文）
export function bindingProblems(db, { env = process.env, catalog = MODEL_CATALOG, vendors = VENDORS, lang = 'zh' } = {}) {
  const cat = catalogOf(db, { catalog, vendors }), endpoints = endpointsOf(db, { vendors });
  const b = bindingOf(db);
  const out = [];
  for (const tier of TIERS) {
    const entry = cat[b.binding[tier]];
    const why = bindable(entry, endpoints, lang);
    if (why) { out.push({ tier, key: b.binding[tier], why }); continue; }
    const e = endpoints[entry.vendor];
    if (!env[e.keyEnv]) out.push({ tier, key: b.binding[tier], why: tl(lang, '.env 中未设置 {keyEnv}', { keyEnv: e.keyEnv }) });
  }
  return out;
}

// ── 给客户端 / 目录检查用的一揽子 ──────────────────────────────────────────

/** LlmClient 的构造参数：{ vendors, catalog, binding, tierEfforts }。每次建客户端调一次 = 每个节点重读库。 */
export function registryFor(db, { catalog = MODEL_CATALOG, vendors = VENDORS, defaults = TIER_BINDING } = {}) {
  const b = bindingOf(db, { defaults });
  return { vendors: endpointsOf(db, { vendors }), catalog: catalogOf(db, { catalog, vendors }), binding: b.binding, tierEfforts: b.efforts, bindingSource: b.source };
}

/** 目录检查用：只查启用的模型、启用的服务商。 */
export function checkableCatalog(db, opts = {}) {
  const reg = registryFor(db, opts);
  const catalog = Object.fromEntries(Object.entries(reg.catalog).filter(([, m]) => m.enabled && reg.vendors[m.vendor]?.enabled));
  return { catalog, vendors: reg.vendors, keysInUse: Object.values(reg.binding) };
}
