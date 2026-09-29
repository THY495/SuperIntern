// 模型目录漂移检查
//
// 跑：node tests/catalog-check.test.mjs
//
// 断言的是：存在性 / 单价（含"档位不同"指纹）/ 窗口 / 下线日期 / 拉取失败各走各的判定；实调 --probe；
// 结果落审计并能读回；守护进程的"该不该查"（没查过 / 到间隔 / 绑定里有新键）；
// 调用时的代答检测（servedModelDrift）与 flushLedger 落 model_drift；负责人摘要里带目录一栏。

import { openDb, ensureOwner, now } from '../src/db/db.mjs';
import { checkCatalog, renderCatalogCheck, recordCatalogCheck, lastCatalogCheck, catalogCheckDue, normId } from '../src/llm/catalog-check.mjs';
import { servedModelDrift, LlmClient } from '../src/llm/client.mjs';
import { flushLedger } from '../src/core/ledger.mjs';
import { buildDigest, renderDigest } from '../src/core/digest.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

// ── 夹具：一个小目录 + 假 fetch ──────────────────────────────────────────
const vendors = {
  deepseek: { adapter: 'openai-chat', keyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1' },
  gemini: { adapter: 'gemini', keyEnv: 'GEMINI_API_KEY' },
  openai: { adapter: 'openai-responses', keyEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1' },
  openrouter: { adapter: 'openai-chat', keyEnv: 'OPENROUTER_API_KEY', baseUrl: 'https://openrouter.ai/api/v1', gateway: true, billing: 'reported' },
};
const catalog = {
  'deepseek/deepseek-flash': { vendor: 'deepseek', model: 'deepseek-flash', contextWindow: 1_000_000, pricing: { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 } },
  'deepseek/deepseek-v4-flash': { vendor: 'deepseek', model: 'deepseek-v4-flash', contextWindow: 1_000_000, pricing: { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 } },
  'gemini/gemini-3.6-flash': { vendor: 'gemini', model: 'gemini-3.6-flash', pricing: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0.0833 } },
  'openai/gpt-5.6-terra': { vendor: 'openai', model: 'gpt-5.6-terra', contextWindow: 400_000, pricing: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 } },
  'openrouter/kimi': { vendor: 'openrouter', model: 'moonshotai/kimi-k3', pricing: { input: 1, output: 1 }, providerPrefs: { only: ['moonshotai'] } },
};
const per = (usd) => String(usd / 1e6);
const orRows = [
  { id: 'deepseek/deepseek-flash', pricing: { prompt: per(0.30), completion: per(1.20), input_cache_read: per(0.006) }, context_length: 1_000_000, supported_parameters: ['reasoning_effort'] },
  // v4-flash：网关挂的是另一档价（全部正好 0.5×）+ 标了下线日期
  { id: 'deepseek/deepseek-v4-flash', pricing: { prompt: per(0.60), completion: per(2.40), input_cache_read: per(0.012) }, context_length: 1_000_000, expiration_date: '2026-10-01', supported_parameters: ['reasoning_effort'] },
  { id: 'google/gemini-3.6-flash', pricing: { prompt: per(1.5), completion: per(7.5), input_cache_read: per(0.15), input_cache_write: per(0.0833) }, context_length: 1_048_576, supported_parameters: ['reasoning_effort'] },
  // terra：窗口目录写 400k，网关说 1M；单价只有 output 差
  { id: 'openai/gpt-5.6-terra', pricing: { prompt: per(2.5), completion: per(12), input_cache_read: per(0.25), input_cache_write: per(3.125) }, context_length: 1_000_000, supported_parameters: ['reasoning_effort'] },
];
const env = { DEEPSEEK_API_KEY: 'k1', GEMINI_API_KEY: 'k2' };   // openai 没 key
const calls = [];
const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
const fetchFn = async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET' });
  const u = String(url);
  if (u.startsWith('https://api.deepseek.com/v1/models')) return json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] });
  if (u.startsWith('https://generativelanguage.googleapis.com/v1beta/models?')) return json({ models: [{ name: 'models/gemini-3.6-flash', inputTokenLimit: 1_048_576 }] });
  if (u === 'https://openrouter.ai/api/v1/models') return json({ data: orRows });
  if (u.includes('chat/completions')) return init.body.includes('deepseek-v4-flash') ? json({ error: { message: 'Model Not Exist' } }, 400) : json({ id: 'x', choices: [] });
  if (u.includes(':generateContent')) return json({ candidates: [] });
  throw new Error(`fetch failed: ${u}`);
};

section('1. 四类判定各走各的');
const r = await checkCatalog({ catalog, vendors, env, fetchFn, at: 1_000 });
const F = (key) => r.entries.find((e) => e.key === key).findings;
const has = (key, level, re, m) => assert(F(key).some((f) => f.level === level && re.test(f.msg)), `${m}\n         └ ${F(key).map((f) => `[${f.level}] ${f.msg}`).join(' | ').slice(0, 300)}`);
{
  has('deepseek/deepseek-flash', 'OK', /在厂商 \/models 列表中/, 'flash：在列表里');
  has('deepseek/deepseek-flash', 'OK', /窗口 1000000 与 OpenRouter一致/, 'flash：窗口一致');
  eq(F('deepseek/deepseek-flash').filter((f) => f.level === 'WARN').length, 0, 'flash：零告警');
  has('deepseek/deepseek-v4-flash', 'WARN', /\*\*不在\*\* deepseek 的 \/models 列表中/, 'v4-flash：退役 → 不在列表');
  has('deepseek/deepseek-v4-flash', 'SKIP', /差值完全一致（0\.50×）/, 'v4-flash：三项单价同一比值 → 档位指纹，不当漂移');
  has('deepseek/deepseek-v4-flash', 'WARN', /下线日期：2026-10-01/, 'v4-flash：下线日期');
  has('gemini/gemini-3.6-flash', 'INFO', /目录未填 contextWindow；厂商 API 称 1048576/, 'gemini：没填窗口 → INFO 给厂商 API 的数（优先于 OpenRouter）');
  eq(F('gemini/gemini-3.6-flash').filter((f) => f.level === 'WARN').length, 0, 'gemini：单价全对，零告警');
  has('openai/gpt-5.6-terra', 'SKIP', /openai 无 key，跳过/, 'terra：没 key 跳过存在性');
  has('openai/gpt-5.6-terra', 'WARN', /窗口不一致：目录 400000 vs OpenRouter 1000000/, 'terra：窗口不一致');
  has('openai/gpt-5.6-terra', 'WARN', /output: 目录 \$15 vs OpenRouter \$12\.0000/, 'terra：只有 output 一项不一致');
  assert(!F('openai/gpt-5.6-terra').some((f) => /差值完全一致/.test(f.msg)), 'terra：单项差不是档位指纹');
  has('openrouter/kimi', 'SKIP', /网关服务商/, '网关：不比单价');
  has('openrouter/kimi', 'OK', /已钉上游偏好/, '网关：钉了上游');
  eq([r.warnings, r.fetchErrors, r.keys.length], [4, [], 5], '合计 4 项告警、无拉取失败、5 个键');
  assert(!calls.some((c) => c.method === 'POST'), '不带 --probe 不发任何实调');
  const text = renderCatalogCheck(r);
  assert(text.includes('4 项需要人看一眼') && text.includes('目录只由人改'), '文本报告结尾');
  const brief = renderCatalogCheck(r, { onlyProblems: true });
  assert(brief.includes('deepseek-v4-flash') && !brief.includes('deepseek/deepseek-flash  (') && !brief.includes('gemini/gemini-3.6-flash  ('), 'onlyProblems 只列有告警的模型');
}

section('2. --probe 实调；拉取失败进 fetchErrors 而不是炸');
{
  const rp = await checkCatalog({ catalog, vendors, env, fetchFn, probe: true, only: 'deepseek', at: 2_000 });
  assert(rp.entries.every((e) => e.vendor === 'deepseek'), 'only 只查 deepseek');
  assert(F.call && rp.entries.find((e) => e.key === 'deepseek/deepseek-flash').findings.some((f) => f.level === 'OK' && /可调通/.test(f.msg)), 'flash 实调通');
  assert(rp.entries.find((e) => e.key === 'deepseek/deepseek-v4-flash').findings.some((f) => f.level === 'FAIL' && /HTTP 400: Model Not Exist/.test(f.msg)), 'v4-flash 实调 400 → FAIL');
  eq(calls.filter((c) => c.method === 'POST').length, 2, '两次实调');
  const broken = async (url) => { if (String(url).includes('openrouter')) throw new Error('ECONNRESET'); return fetchFn(url); };
  const rb = await checkCatalog({ catalog, vendors, env, fetchFn: broken, only: 'deepseek', at: 3_000 });
  eq(rb.fetchErrors, ['OpenRouter 定价表：ECONNRESET'], '定价表拉不到 → fetchErrors');
  assert(rb.entries.find((e) => e.key === 'deepseek/deepseek-flash').findings.some((f) => f.level === 'SKIP' && /单价无法比对/.test(f.msg)), '单价比对退化为 SKIP');
  const noenv = await checkCatalog({ catalog, vendors, env: {}, fetchFn, only: 'deepseek', at: 3_500 });
  assert(noenv.entries.find((e) => e.key === 'deepseek/deepseek-v4-flash').findings.some((f) => f.level === 'SKIP' && /无 key/.test(f.msg)), '没 key：存在性 SKIP，不报"不在列表"');
}

section('3. 落审计、读回、该不该查');
const db = openDb(':memory:');
const lead = ensureOwner(db, 'lead').userId;
{
  eq(catalogCheckDue(db, { every: '7d', at: 10_000, keysInUse: ['deepseek/deepseek-flash'] }), { due: true, why: 'never' }, '没查过 → 查');
  recordCatalogCheck(db, r, { by: 'daemon' });
  const last = lastCatalogCheck(db);
  eq([last.warnings, last.keys.length, last.lines.length, last.checkedAt], [4, 5, 4, 1_000], '读回：告警数、键、有问题的行、时间');
  eq(catalogCheckDue(db, { every: '7d', at: 1_000 + 86_400_000, keysInUse: ['deepseek/deepseek-flash'] }).due, false, '一天后、键都查过 → 不查');
  eq(catalogCheckDue(db, { every: '7d', at: 1_000 + 8 * 86_400_000, keysInUse: [] }), { due: true, why: 'interval' }, '八天后 → 到间隔');
  eq(catalogCheckDue(db, { every: '7d', at: 1_000 + 3600_000, keysInUse: ['anthropic/claude-opus-5'] }), { due: true, why: 'new_key' }, '绑定里有没查过的键 → 立刻查');
  let threw = null; try { catalogCheckDue(db, { every: 'weekly', at: 0 }); } catch (e) { threw = e.message; }
  assert(/间隔写法不对/.test(threw ?? ''), '间隔写法校验');
}

section('4. 代答检测：servedModelDrift 与 flushLedger 落 model_drift');
{
  eq(servedModelDrift('deepseek-v4-flash', { model: 'deepseek-v4.1-flash' }), { requested: 'deepseek-v4-flash', served: 'deepseek-v4.1-flash' }, '不同名 → 漂移');
  eq(servedModelDrift('claude-opus-5', { model: 'claude-opus-5-20260401' }), null, '带日期后缀的同名不算');
  eq(servedModelDrift('gemini-3.6-flash', { modelVersion: 'gemini-3.6-flash-001' }), null, 'Gemini 的 modelVersion 带版本尾也不算');
  eq(servedModelDrift('gpt-5.6-terra', {}), null, '响应没有 model 字段 → 不判');
  eq(servedModelDrift('gpt-5.6-terra', { model: 'gpt-5.6-terra' }), null, '同名 → 无');
  // 走 replay 路径：磁带里的响应 model 与请求不同
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { hashOf } = await import('../src/llm/client.mjs').then((m) => ({ hashOf: m.hashOf })).catch(() => ({ hashOf: null }));
  const dir = mkdtempSync(join(tmpdir(), 'si-drift-'));
  const cassette = join(dir, 'c.jsonl');
  const client = new LlmClient({ mode: 'replay', cassette, catalog, binding: { light: 'deepseek/deepseek-v4-flash', standard: 'deepseek/deepseek-v4-flash', heavy: 'deepseek/deepseek-v4-flash' }, apiKeys: { deepseek: 'k' } });
  // 先算出 replay 键：用 client 自己的解析 + 同一份 wireReq
  const rr = client._resolve('light');
  const { clampEffort } = await import('../src/llm/canonical.mjs');
  const canon = { tier: 'light', maxTokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], effort: 'high' };
  const wireReq = rr.adapter.buildRequest({ ...canon, effort: clampEffort(canon.effort, rr.efforts), gateway: rr.gateway, providerPrefs: rr.providerPrefs }, rr.model);
  if (hashOf) {
    const key = hashOf({ p: rr.vendorId, a: rr.adapter.id, r: wireReq });
    writeFileSync(cassette, JSON.stringify({ key, provider: 'deepseek', adapter: rr.adapter.id, model: rr.model,
      request: wireReq, response: { id: 'x', model: 'deepseek-v4.1-flash', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } } }) + '\n');
    await client.complete(canon);
    eq(client.drifts.map((d) => [d.key, d.served]), [['deepseek/deepseek-v4-flash', 'deepseek-v4.1-flash']], 'replay 响应里的 model 不同 → 记一条');
    await client.complete(canon);
    eq(client.drifts.length, 1, '同一 (键, 代答) 只记一次');
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES ('t_d',?,'t','running',?)`, lead, now());
    flushLedger(db, client, { taskId: 't_d', role: 'executor' });
    const a = db.one(`SELECT payload FROM audit_log WHERE action='model_drift' AND target_id='t_d'`);
    assert(a && JSON.parse(a.payload).served === 'deepseek-v4.1-flash' && /catalog check/.test(JSON.parse(a.payload).hint), 'flushLedger 落 model_drift 审计，带提示');
    eq(client.drifts.length, 0, '落库后清空');
  } else {
    bad('hashOf 未导出，replay 路径的代答检测没测到');
  }
}

section('5. 负责人摘要带"模型目录"一栏');
{
  const at = now();
  const d = buildDigest(db, { userId: lead, at });
  assert(d.catalog && d.catalog.warnings === 4 && d.catalog.drifts.length === 1, `摘要里：4 项告警 + 1 处代答\n         └ ${JSON.stringify(d.catalog).slice(0, 200)}`);
  const text = renderDigest(d, { at });
  assert(/模型目录（上次检查 .*前）：4 项要看一眼；调用时发现 1 处厂商代答/.test(text) && text.includes('catalog check'), '文本一栏');
  const carolId = 'u_obs';
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,'observer','[]',?)`, carolId, 'carol', at);
  eq(buildDigest(db, { userId: carolId, at }).catalog, null, '非负责人没有这一栏');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
