// 模型目录漂移检查（配合档位换绑）。
//
// 为什么要进产品：独立脚本能抓到模型退役（例如 `deepseek-v4-flash`），但没人定期跑就等于没有。
// 检查本身全是**确定性查询**，不调模型：
//   A. 存在性 —— 目录里的模型还在厂商的 /models 里吗（要对应厂商的 key；没 key 跳过）
//   B. 可调用性 —— 列表里有 ≠ 能调用，可选地真打一次 16 token 的最小请求（--probe，花钱但极少）
//   C. 单价 —— 与 OpenRouter 公开挂牌价比（无需 key）。参照源不权威：各项差值一致是"档位不同"的指纹，不是目录过期
//   D. 窗口 —— 目录里填了 contextWindow 的与 OpenRouter 的 context_length / Gemini 的 inputTokenLimit 比；没填的给 INFO
// 结果只**报告**，永远不改目录：单价喂预算闸门、绑定决定跑什么，都是人改的配置。
// 触发：`cli catalog check`、守护进程按 --catalog-check 间隔（绑定里出现没查过的键时立刻查）。
// 调用时的零成本信号（厂商代答：响应 model ≠ 请求 model）在 client.mjs 的 servedModelDrift，不在这里。

import { MODEL_CATALOG, VENDORS } from './canonical.mjs';
import { PROVIDERS } from './providers.mjs';
import { headersFor, listEndpointModels, ADAPTER_DEFAULTS } from './registry.mjs';
import { audit, now } from '../db/db.mjs';
import { dueAfter, isValidAfter } from '../core/routing.mjs';
import { I18nError, tl, N_ } from '../i18n/index.mjs';

/** 归一化模型名用于跨表匹配：去掉日期后缀与 ./- 差异 */
export const normId = (s) => String(s).replace(/-?20\d{6}$/, '').replace(/[.-]/g, '').toLowerCase();

const jsonOf = async (res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); };

/** 某厂商的 /models：{ ids, limits(Map model→inputTokenLimit，只有 Gemini 给), error }。没 key → ids null。地址与鉴权头按服务商（用户加的服务商也能查）。 */
export async function listVendorModels(vendorId, { vendors = VENDORS, env = process.env, fetchFn = globalThis.fetch } = {}) {
  const v = vendors[vendorId];
  const key = env[v?.keyEnv];
  if (!v || !key) return { ids: null, limits: new Map(), error: null, noKey: true };
  const e = { ...v, id: vendorId, baseUrl: v.baseUrl ?? ADAPTER_DEFAULTS[v.adapter]?.baseUrl ?? null };
  const r = await listEndpointModels(e, { env, fetchFn });
  if (r.error) return { ids: null, limits: new Map(), error: r.error };
  return { ids: r.rows.map((m) => m.id), limits: new Map(r.rows.filter((m) => m.contextWindow && v.adapter === 'gemini').map((m) => [m.id, m.contextWindow])), error: null };
}

/** OpenRouter 公开表（无需 key）：normId → { id, input, output, cacheRead, cacheWrite（$/M token）, expires, efforts, context } */
export async function openRouterTable({ fetchFn = globalThis.fetch } = {}) {
  try {
    const j = await jsonOf(await fetchFn('https://openrouter.ai/api/v1/models'));
    const map = new Map();
    const per = (x) => (x == null ? null : Number(x) * 1e6);
    for (const m of j.data ?? []) {
      const p = m.pricing ?? {};
      map.set(normId(String(m.id).split('/').pop()), { id: m.id, input: per(p.prompt), output: per(p.completion), cacheRead: per(p.input_cache_read), cacheWrite: per(p.input_cache_write),
        expires: m.expiration_date ?? null, efforts: (m.supported_parameters ?? []).includes('reasoning_effort'), context: m.context_length ? Number(m.context_length) : null });
    }
    return { table: map, error: null };
  } catch (e) { return { table: null, error: e.message }; }
}

/** 真打一次最小请求。返回 'ok' | 'no-key' | 'HTTP xxx: …' */
export async function probeModel(entry, { vendors = VENDORS, env = process.env, fetchFn = globalThis.fetch } = {}) {
  const v = vendors[entry.vendor];
  const key = env[v?.keyEnv];
  if (!key) return 'no-key';
  const adapter = PROVIDERS[entry.adapter ?? v.adapter];
  const canon = { tier: 'x', maxTokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
  try {
    const res = await fetchFn(adapter.endpoint(entry.model, v.baseUrl), { method: 'POST', headers: headersFor(adapter, v, key), body: JSON.stringify(adapter.buildRequest(canon, entry.model)) });
    if (res.ok) return 'ok';
    const j = await res.json().catch(() => ({}));
    return `HTTP ${res.status}: ${String(j.error?.message ?? '').slice(0, 90)}`;
  } catch (e) { return `ERR: ${e.message}`; }
}

/**
 * 全目录检查。返回 { checkedAt, probe, keys, entries: [{ key, model, vendor, findings: [{ level, msg }] }], warnings, fetchErrors }。
 * level：OK / SKIP / INFO / WARN / FAIL；warnings 只数 WARN + FAIL。`only`：只查某个 vendor。
 */
// 发现写进审计、给所有人看：按部署的内容语言写（调用方传 contentLang(db)）
export async function checkCatalog({ catalog = MODEL_CATALOG, vendors = VENDORS, env = process.env, fetchFn = globalThis.fetch, probe = false, only = null, at = now(), lang = 'zh' } = {}) {
  const fetchErrors = [];
  const vendorIds = [...new Set(Object.values(catalog).map((e) => e.vendor))].filter((v) => !only || v === only);
  const lists = Object.fromEntries(await Promise.all(vendorIds.map(async (v) => {
    if (vendors[v]?.gateway) return [v, { ids: null, limits: new Map(), gateway: true }];
    const r = await listVendorModels(v, { vendors, env, fetchFn });
    if (r.error) fetchErrors.push(`${v} /models：${r.error}`);
    return [v, r];
  })));
  const or = await openRouterTable({ fetchFn });
  if (or.error) fetchErrors.push(tl(lang, 'OpenRouter 定价表：{error}', { error: or.error }));
  const entries = [];
  let warnings = 0;
  for (const [key, entry] of Object.entries(catalog)) {
    if (only && entry.vendor !== only) continue;
    const findings = [];
    const say = (level, tpl, params) => { const msg = tl(lang, tpl, params); if (level === 'WARN' || level === 'FAIL') warnings++; findings.push({ level, msg }); };
    const v = vendors[entry.vendor];
    if (v?.gateway) {
      say('SKIP', N_('网关服务商：按回报计费，不做模型级单价漂移检查'));
      if (entry.providerPrefs) say('OK', N_('已钉上游偏好 {prefs}'), { prefs: JSON.stringify(entry.providerPrefs) });
      else say('SKIP', N_('未钉上游：走网关默认路由（上游身份 / 量化 / 上下文上限随调用浮动，属用户选择）'));
      entries.push({ key, model: entry.model, vendor: entry.vendor, findings });
      continue;
    }
    // A. 存在性
    const list = lists[entry.vendor];
    if (!list?.ids) say('SKIP', list?.noKey ? N_('{vendor} 无 key，跳过 /models 存在性检查') : N_('{vendor} /models 没拉到，跳过存在性检查'), { vendor: entry.vendor });
    else if (list.ids.includes(entry.model)) say('OK', N_('在厂商 /models 列表中'));
    else say('WARN', N_('**不在** {vendor} 的 /models 列表中 —— 可能是废弃别名或已下线（旧名有时仍能调通、由别的模型代答）'), { vendor: entry.vendor });
    // B. 可调用性
    if (probe) {
      const r = await probeModel(entry, { vendors, env, fetchFn });
      if (r === 'ok') say('OK', N_('最小请求可调通'));
      else if (r === 'no-key') say('SKIP', N_('无 key，跳过实调'));
      else say('FAIL', N_('实调失败 —— {r}'), { r });
    }
    // D. 窗口（厂商 API 给的优先）
    const vendorLimit = list?.limits?.get(entry.model) ?? null;
    const orRow = or.table?.get(normId(entry.model)) ?? null;
    const refWindow = vendorLimit ?? orRow?.context ?? null;
    const refName = vendorLimit ? tl(lang, '厂商 API') : 'OpenRouter';
    if (entry.contextWindow && refWindow && Math.abs(entry.contextWindow - refWindow) / refWindow > 0.05) {
      say('WARN', N_('窗口不一致：目录 {mine} vs {ref} {theirs}'), { mine: entry.contextWindow, ref: refName, theirs: refWindow });
    } else if (entry.contextWindow && refWindow) say('OK', N_('窗口 {mine} 与 {ref} 一致'), { mine: entry.contextWindow, ref: refName });
    else if (!entry.contextWindow && refWindow) say('INFO', N_('目录未填 contextWindow；{ref} 称 {theirs}（核实厂商文档后再填，limits.context_tokens 会按它封顶）'), { ref: refName, theirs: refWindow });
    // C. 单价
    if (!orRow) { say('SKIP', N_('OpenRouter 无此模型，单价无法比对')); entries.push({ key, model: entry.model, vendor: entry.vendor, findings }); continue; }
    const ratios = [], diffs = [];
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const mine = entry.pricing?.[f], theirs = orRow[f];
      if (mine == null || theirs == null) continue;
      if (Math.abs(mine - theirs) / Math.max(theirs, 1e-9) > 0.02) {
        ratios.push(mine / theirs);
        diffs.push([N_('与网关挂牌价不一致 {field}: 目录 ${mine} vs OpenRouter ${theirs}（{ratio}×）'), { field: f, mine, theirs: theirs.toFixed(4), ratio: (mine / theirs).toFixed(2) }]);
      }
    }
    // 各项差值完全一致 = 两边报的不是同一个价格档（实测：OpenRouter 给 luna / terra 挂的是批量档价）。
    // 那不是目录过期，降为 INFO 不计入告警；只有比值不一致（某一项单独变了）才是漂移的指纹。
    const fingerprint = ratios.length >= 2 && Math.max(...ratios) - Math.min(...ratios) < 0.01;
    for (const [tpl, p] of diffs) say(fingerprint ? 'INFO' : 'WARN', tpl, p);
    if (fingerprint) say('SKIP', N_('↑ 上面 {n} 项差值完全一致（{ratio}×）—— 这是"两边报的不是同一个价格档"的指纹，不是目录过期。先去厂商官网核，别急着改目录'), { n: ratios.length, ratio: ratios[0].toFixed(2) });
    if (orRow.expires) say('WARN', N_('厂商已标注下线日期：{date}'), { date: orRow.expires });
    const declaredEfforts = (entry.efforts ?? ['low', 'medium', 'high']).length > 0;
    const yn = (b) => (b ? tl(lang, '支持') : tl(lang, '不支持'));
    if (declaredEfforts !== orRow.efforts) say('WARN', N_('推理强度支持声明不一致：目录={mine}，OpenRouter={theirs}'), { mine: yn(declaredEfforts), theirs: yn(orRow.efforts) });
    entries.push({ key, model: entry.model, vendor: entry.vendor, findings });
  }
  return { checkedAt: at, probe, keys: entries.map((e) => e.key), entries, warnings, fetchErrors };
}

/** 纯文本报告。`onlyProblems`：只列有 WARN / FAIL 的模型（通知与摘要用）。 */
export function renderCatalogCheck(r, { onlyProblems = false, lang = 'zh' } = {}) {
  const L = [r.probe ? tl(lang, '模型目录漂移检查 —— {n} 条（含实调）', { n: r.entries.length }) : tl(lang, '模型目录漂移检查 —— {n} 条', { n: r.entries.length })];
  for (const e of r.fetchErrors) L.push(`  [WARN] ${e}`);
  for (const e of r.entries) {
    const bad = e.findings.filter((f) => f.level === 'WARN' || f.level === 'FAIL');
    if (onlyProblems && !bad.length) continue;
    L.push(`\n${e.key}  (${e.model})`);
    for (const f of (onlyProblems ? e.findings.filter((x) => x.level !== 'OK') : e.findings)) L.push(`  [${f.level}] ${f.msg}`);
  }
  L.push(`\n${r.warnings === 0 ? tl(lang, '目录无漂移。') : tl(lang, '{n} 项需要人看一眼。目录只由人改：看板"设置 → 模型列表"或 node src/cli.mjs catalog set。', { n: r.warnings })}`);
  return L.join('\n');
}

/** 落审计：catalog_checked。正文不存全文，只存有问题的行（封顶 60 行）。 */
export function recordCatalogCheck(db, r, { by = 'daemon', actorKind = 'system', lang = 'zh' } = {}) {
  const lines = [];
  for (const e of r.entries) for (const f of e.findings) if (f.level === 'WARN' || f.level === 'FAIL') lines.push(`${e.key}：${f.msg}`);
  for (const e of r.fetchErrors) lines.push(tl(lang, '拉取失败：{e}', { e }));   // 排最后：摘要只截前几行，真发现要在前面
  audit(db, { actorKind, actorId: by, action: 'catalog_checked', targetType: 'catalog', targetId: 'model_catalog',
    payload: { checkedAt: r.checkedAt, probe: r.probe, keys: r.keys, warnings: r.warnings, fetchErrors: r.fetchErrors.length, lines: lines.slice(0, 60) } });
}
export function lastCatalogCheck(db) {
  const row = db.one(`SELECT ts, payload FROM audit_log WHERE action='catalog_checked' ORDER BY id DESC LIMIT 1`);
  return row ? { ts: row.ts, ...JSON.parse(row.payload || '{}') } : null;
}
/** 该不该查：没查过；或过了间隔；或绑定里出现了上次没查过的键。 */
export function catalogCheckDue(db, { every, at = now(), keysInUse = [] }) {
  if (!isValidAfter(every)) throw new I18nError('检查间隔写法不对：{every}（可用 30m / 8h / 1d / 1bd）', { every });
  const last = lastCatalogCheck(db);
  if (!last) return { due: true, why: 'never' };
  if (keysInUse.some((k) => !(last.keys ?? []).includes(k))) return { due: true, why: 'new_key' };
  if (at >= dueAfter(last.checkedAt ?? last.ts, every)) return { due: true, why: 'interval' };
  return { due: false, why: 'fresh' };
}
