// 注册表三层落库
//
// 跑：node tests/registry.test.mjs
//
// 断言的是：代码常量退为默认值、库行叠加（NULL = 继承）；服务商 / 模型 / 绑定的增删改校验（缺单价不能绑、绑着的不能停用 / 删、
// 停用的服务商建客户端就报）；init 把默认绑定显式写库、--bind 覆盖；.env 写 key 不进库不回显；看板 /api/llm 读写按角色；
// 客户端吃库里的推理强度与自定义鉴权头；目录检查读生效目录。

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, now } from '../src/db/db.mjs';
import { endpointsOf, endpointDiff, saveEndpoint, setEndpointEnabled, removeEndpoint, keyPresence, headersFor, modelsUrlOf, listEndpointModels, testEndpoint,
  catalogOf, bindable, saveModel, removeModel, bindingOf, setBinding, seedBinding, pickDefaultBinding, bindingProblems, registryFor, checkableCatalog, ADAPTER_DEFAULTS } from '../src/llm/registry.mjs';
import { VENDORS, MODEL_CATALOG, TIER_BINDING, tierEntry } from '../src/llm/canonical.mjs';
import { PROVIDERS, makeFake } from '../src/llm/providers.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { setEnvVar } from '../src/core/envfile.mjs';
import { checkCatalog } from '../src/llm/catalog-check.mjs';
import { startWeb, llmView } from '../src/web/server.mjs';
import { addUser } from '../src/core/users.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throws = (fn, re, m) => { try { fn(); bad(m, '没抛'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `抛了但文案不对：${e.message}`); } };

const TMP = mkdtempSync(join(tmpdir(), 'si-reg-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const db = openDb(':memory:');
const owner = ensureOwner(db, '负责人');
const U = owner.userId;
const audits = (action) => db.all(`SELECT * FROM audit_log WHERE action=? ORDER BY id`, action);

section('1. 默认值叠加：库空时生效值 = 代码常量');
{
  const eps = endpointsOf(db);
  eq(Object.keys(eps).sort(), Object.keys(VENDORS).sort(), '服务商 = VENDORS');
  eq(eps.deepseek.baseUrl, VENDORS.deepseek.baseUrl, 'deepseek 地址继承');
  eq(eps.anthropic.baseUrl, ADAPTER_DEFAULTS.anthropic.baseUrl, 'anthropic 地址有默认');
  assert(eps.openrouter.gateway && eps.openrouter.billing === 'reported', 'openrouter 聚合平台 + 按回报计费');
  assert(Object.values(eps).every((e) => e.enabled && e.source === 'default' && !e.overridden), '全部启用、来源 default、未覆盖');
  eq(endpointDiff(eps.deepseek), [], '与默认值无差异');
  const cat = catalogOf(db);
  eq(Object.keys(cat).length, Object.keys(MODEL_CATALOG).length, '目录条数 = MODEL_CATALOG');
  eq(cat['deepseek/deepseek-flash'].pricing, MODEL_CATALOG['deepseek/deepseek-flash'].pricing, '单价继承');
  const b = bindingOf(db);
  eq(b.binding, TIER_BINDING, '绑定 = TIER_BINDING');
  eq(b.source, 'default', '来源 default');
  eq(b.missing, ['light', 'standard', 'heavy'], '三档都没写库');
  eq(bindable(cat['deepseek/deepseek-flash'], eps), null, '默认目录里的模型可绑');
  const reg = registryFor(db);
  eq(Object.keys(reg).sort(), ['binding', 'bindingSource', 'catalog', 'tierEfforts', 'vendors'], 'registryFor 给客户端的五样');
}

section('2. init：默认绑定显式写库；--bind 覆盖；第二次不重写');
{
  const r = seedBinding(db, { overrides: { heavy: 'deepseek/deepseek-v4-pro' }, userId: U });
  assert(r.seeded, '首次 seed');
  eq(bindingOf(db).source, 'db', '来源变 db');
  eq(bindingOf(db).binding, { light: 'deepseek/deepseek-flash', standard: 'deepseek/deepseek-flash', heavy: 'deepseek/deepseek-v4-pro' }, 'heavy 按 --bind 覆盖，其余默认');
  eq(audits('binding_seeded').length, 1, '审计 binding_seeded');
  eq(audits('binding_set').length, 1, '覆盖走 binding_set');
  eq(audits('binding_set')[0].payload.includes('"from":"anthropic/claude-opus-5"'), true, '审计记 from');
  const r2 = seedBinding(db, { overrides: {}, userId: U });
  assert(!r2.seeded, '第二次不重写');
  throws(() => seedBinding(db, { overrides: { heavy: 'nope/x' }, userId: U }), /模型不在目录中/, '覆盖成不存在的模型：拒');
}

section('3. 绑定校验：缺单价 / 停用 / 推理强度取值');
{
  throws(() => setBinding(db, { tier: 'x', modelKey: 'deepseek/deepseek-flash', userId: U }), /档位无效/, '档位名');
  throws(() => setBinding(db, { tier: 'light', modelKey: 'deepseek/none', userId: U }), /模型不在目录中/, '模型不在目录');
  throws(() => setBinding(db, { tier: 'light', modelKey: 'anthropic/claude-haiku-4-5', effort: 'high', userId: U }), /不支持推理强度/, 'haiku 推理强度取值为空：给推理强度拒');
  throws(() => setBinding(db, { tier: 'light', modelKey: 'deepseek/deepseek-flash', effort: 'ultra', userId: U }), /推理强度无效/, '推理强度枚举');
  const b = setBinding(db, { tier: 'standard', modelKey: 'deepseek/deepseek-v4-pro', effort: 'medium', userId: U });
  eq(b.efforts.standard, 'medium', '推理强度写入');
  eq(setBinding(db, { tier: 'standard', modelKey: 'deepseek/deepseek-v4-pro', userId: U }).efforts.standard, 'medium', 'effort 不给、模型没变 = 保留');
  eq(setBinding(db, { tier: 'standard', modelKey: 'deepseek/deepseek-flash', userId: U }).efforts.standard, null, 'effort 不给、换了模型 = 清空（不把上一个模型的推理强度带过去）');
  setBinding(db, { tier: 'standard', modelKey: 'deepseek/deepseek-flash', effort: 'high', userId: U });
  // 换到不支持推理强度的模型：以前会因为带过来的 high 被拒。用临时 key 环境无关 —— bindable 不看 key 在不在
  eq(setBinding(db, { tier: 'standard', modelKey: 'anthropic/claude-haiku-4-5', userId: U }).efforts.standard, null, '带着 high 换到推理强度取值为空的模型：不再被拒');
  setBinding(db, { tier: 'standard', modelKey: 'deepseek/deepseek-flash', effort: 'medium', userId: U });
  eq(setBinding(db, { tier: 'standard', modelKey: 'deepseek/deepseek-flash', effort: null, userId: U }).efforts.standard, null, 'effort null = 清空');
  const probs = bindingProblems(db, { env: {} });
  eq(probs.map((p) => p.tier), ['light', 'standard', 'heavy'], '没 key：三档都报');
  assert(probs[0].why.includes('DEEPSEEK_API_KEY'), '问题写明变量名');
  eq(bindingProblems(db, { env: { DEEPSEEK_API_KEY: 'x' } }), [], '有 key 就没问题');
}

section('4. 服务商：新增 / 校验 / 覆盖默认 / 启停 / 删除');
{
  throws(() => saveEndpoint(db, { id: 'Bad Id', adapter: 'openai-chat', baseUrl: 'https://x/v1', keyEnv: 'X_KEY', userId: U }), /id 无效/, 'id 格式');
  throws(() => saveEndpoint(db, { id: 'x', adapter: 'bedrock', baseUrl: 'https://x/v1', keyEnv: 'X_KEY', userId: U }), /API 格式无效.*需要新增适配器/, 'API 格式只有四种，其它要写适配器');
  throws(() => saveEndpoint(db, { id: 'x', adapter: 'openai-chat', baseUrl: 'ftp://x', keyEnv: 'X_KEY', userId: U }), /http\(s\)/, '地址格式');
  throws(() => saveEndpoint(db, { id: 'x', adapter: 'openai-chat', baseUrl: 'https://x/v1', keyEnv: 'lower', userId: U }), /变量名/, 'key 变量名格式');
  const e = saveEndpoint(db, { id: 'siliconflow', label: '硅基流动', adapter: 'openai-chat', baseUrl: 'https://api.siliconflow.cn/v1/', keyEnv: 'SILICONFLOW_API_KEY', userId: U });
  eq([e.source, e.enabled, e.gateway, e.billing, e.label], ['user', true, false, 'computed', '硅基流动'], '用户新增的服务商');
  eq(endpointDiff(e), null, '用户新增的没有可比的默认');
  eq(audits('endpoint_saved').length, 1, '审计 endpoint_saved');
  assert(!JSON.stringify(audits('endpoint_saved')[0]).includes('sk-'), '审计里没有凭证（本来就没经手）');
  // 只改一项：其它保留
  const e2 = saveEndpoint(db, { id: 'siliconflow', authHeader: 'X-Token', authPrefix: '', userId: U });
  eq([e2.baseUrl, e2.keyEnv, e2.authHeader, e2.label], ['https://api.siliconflow.cn/v1', 'SILICONFLOW_API_KEY', 'X-Token', '硅基流动'], '没给的字段保留；地址尾斜杠已去');
  // 覆盖默认服务商：只存差异
  const d = saveEndpoint(db, { id: 'deepseek', baseUrl: 'https://proxy.example/v1', userId: U });
  eq([d.source, d.overridden, d.baseUrl, d.adapter, d.keyEnv], ['default', true, 'https://proxy.example/v1', 'openai-chat', 'DEEPSEEK_API_KEY'], '默认服务商改地址，其余继承');
  eq(endpointDiff(d).map((x) => x.field), ['baseUrl'], '差异只有地址');
  const row = db.one(`SELECT * FROM llm_endpoints WHERE id='deepseek'`);
  eq([row.adapter, row.key_env, row.base_url], [null, null, 'https://proxy.example/v1'], '库行里与默认相同的字段是 NULL（继承）');
  throws(() => removeEndpoint(db, { id: 'deepseek', userId: U }), /正在使用/, '绑着 deepseek 的模型：连覆盖行都不许删');
}
section('4b. 绑着的服务商不能停用 / 删；停用后不能绑它的模型；建客户端就报');
{
  // 带 enabled:false 的保存是同一件事，不能是旁路
  throws(() => saveEndpoint(db, { id: 'deepseek', enabled: false, userId: U }), /正在使用.*先修改模型分配再停用/, 'saveEndpoint 带 enabled:false 也拦');
  eq(endpointsOf(db).deepseek.enabled, true, '被拒后仍启用');
  // reported 计费只有聚合平台能选
  throws(() => saveEndpoint(db, { id: 'plainco', adapter: 'openai-chat', baseUrl: 'https://api.plain.example/v1', keyEnv: 'PLAINCO_API_KEY', billing: 'reported', userId: U }), /仅适用于聚合网关/, 'reported 且不是聚合平台：拒');
  eq(endpointsOf(db).plainco, undefined, '被拒的没落库');
  const gw = saveEndpoint(db, { id: 'plainco', adapter: 'openai-chat', baseUrl: 'https://api.plain.example/v1', keyEnv: 'PLAINCO_API_KEY', gateway: true, billing: 'reported', userId: U });
  eq([gw.gateway, gw.billing], [true, 'reported'], '勾了聚合平台就能选 reported');
  throws(() => saveEndpoint(db, { id: 'plainco', gateway: false, userId: U }), /仅适用于聚合网关/, '之后单独取消"聚合平台"也拦（现值是 reported）');
  throws(() => saveEndpoint(db, { id: 'openrouter', gateway: false, userId: U }), /仅适用于聚合网关/, '默认的 openrouter 同理');
  removeEndpoint(db, { id: 'plainco', userId: U });
  throws(() => setEndpointEnabled(db, { id: 'deepseek', enabled: false, userId: U }), /正在使用.*先修改模型分配/, '绑着的不能停用');
  throws(() => removeEndpoint(db, { id: 'anthropic', userId: U }), /是内置默认值/, '没覆盖行的默认服务商无可删');
  setEndpointEnabled(db, { id: 'anthropic', enabled: false, userId: U });
  eq(endpointsOf(db).anthropic.enabled, false, 'anthropic 停用');
  eq(bindable(catalogOf(db)['anthropic/claude-opus-5'], endpointsOf(db)), '服务商 anthropic 已停用', '停用服务商的模型不能绑');
  throws(() => setBinding(db, { tier: 'heavy', modelKey: 'anthropic/claude-opus-5', userId: U }), /已停用/, '绑定拒');
  const reg = registryFor(db);
  throws(() => tierEntry('heavy', { heavy: 'anthropic/claude-opus-5' }, reg.catalog, reg.vendors), /已停用/, 'tierEntry 对停用服务商报错而不是静默换厂商');
  setEndpointEnabled(db, { id: 'anthropic', enabled: true, userId: U });
  eq(endpointsOf(db).anthropic.enabled, true, '重新启用');
  // 停用再启用 = 回到与出厂值全同：覆盖行自动删掉，不留一条全 NULL 的行（否则"改过出厂值 / 恢复出厂值"永久挂着）
  eq(db.one(`SELECT count(*) n FROM llm_endpoints WHERE id='anthropic'`).n, 0, '启停一圈后没有覆盖行');
  eq(endpointsOf(db).anthropic.overridden, false, 'overridden 回到 false');
  throws(() => removeEndpoint(db, { id: 'anthropic', userId: U }), /是内置默认值/, '因此也没有可"恢复出厂值"的东西');
  eq(db.all(`SELECT id FROM audit_log WHERE action='endpoint_saved' AND target_id='anthropic'`).length, 2, '停用、启用两次改动照记审计');
  // 模型同理
  const hk = 'anthropic/claude-haiku-4-5';
  saveModel(db, { key: hk, fields: { enabled: false }, userId: U });
  eq([catalogOf(db)[hk].enabled, catalogOf(db)[hk].overridden], [false, true], '停用的出厂模型：有覆盖行');
  saveModel(db, { key: hk, fields: { enabled: true }, userId: U });
  eq([catalogOf(db)[hk].overridden, db.one(`SELECT count(*) n FROM llm_models WHERE key=?`, hk).n], [false, 0], '再启用：覆盖行删掉，不再显示"改过出厂值"');
  saveModel(db, { key: hk, fields: { contextWindow: 123456 }, userId: U });
  saveModel(db, { key: hk, fields: { contextWindow: MODEL_CATALOG[hk].contextWindow ?? null }, userId: U });
  eq(db.one(`SELECT count(*) n FROM llm_models WHERE key=?`, hk).n, 0, '字段改回出厂值：同样删行');
  // 用户自己加的服务商 / 模型没有出厂值可回，永远留行
  saveEndpoint(db, { id: 'siliconflow', enabled: true, userId: U });
  eq(db.one(`SELECT count(*) n FROM llm_endpoints WHERE id='siliconflow'`).n, 1, '用户新增的不受影响');
}

section('5. 模型：新增 / 缺单价不能绑 / 覆盖默认 / 删除');
{
  throws(() => saveModel(db, { key: 'nope/x', fields: {}, userId: U }), /服务商 nope 不存在/, '服务商得存在');
  throws(() => saveModel(db, { key: 'bad key', fields: {}, userId: U }), /模型键无效/, '键格式');
  const m = saveModel(db, { key: 'siliconflow/deepseek-ai/DeepSeek-V4', fields: {}, userId: U });
  eq([m.vendor, m.model, m.source, m.enabled, m.pricing], ['siliconflow', 'deepseek-ai/DeepSeek-V4', 'user', true, null], '键拆成服务商 + 模型名；没单价');
  eq(bindable(m, endpointsOf(db)), '未填写单价，无法计入预算上限，不能分配', '缺单价不能绑');
  throws(() => setBinding(db, { tier: 'light', modelKey: m.key, userId: U }), /未填写单价/, '绑定拒');
  throws(() => saveModel(db, { key: m.key, fields: { pricing: { input: -1, output: 2 } }, userId: U }), /≥ 0/, '负单价拒');
  throws(() => saveModel(db, { key: m.key, fields: { pricing: { input: 1 } }, userId: U }), /至少需要填写 input 与 output/, '只给一半拒');
  const m2 = saveModel(db, { key: m.key, fields: { pricing: { input: 0.5, output: 2 }, contextWindow: 128000, efforts: ['low', 'high'] }, userId: U });
  eq([m2.pricing, m2.contextWindow, m2.efforts], [{ input: 0.5, output: 2 }, 128000, ['low', 'high']], '填上单价 / 窗口 / 推理强度取值');
  eq(bindable(m2, endpointsOf(db)), null, '可绑了');
  const m3 = saveModel(db, { key: m.key, fields: { pricing: { cacheRead: 0.05 } }, userId: U });
  eq(m3.pricing, { input: 0.5, output: 2, cacheRead: 0.05 }, '部分单价与现值合并');
  throws(() => setBinding(db, { tier: 'light', modelKey: m.key, effort: 'medium', userId: U }), /只能是 low \/ high/, '推理强度取值外拒');
  setBinding(db, { tier: 'light', modelKey: m.key, effort: 'low', userId: U });
  throws(() => removeModel(db, { key: m.key, userId: U }), /档正在使用/, '绑着的不能删');
  // 停用正被绑着的模型要拦（服务商 / 删除都拦，这里以前是缺口 —— 看板上点一下"停用"某档当场失效）
  throws(() => saveModel(db, { key: m.key, fields: { enabled: false }, userId: U }), /light 档正在使用.*先修改模型分配再停用/, '绑着的模型不能停用');
  eq(catalogOf(db)[m.key].enabled, true, '被拒后仍是启用（事务回滚）');
  saveModel(db, { key: m.key, fields: { notes: ['改别的字段不受影响'] }, userId: U });
  setBinding(db, { tier: 'light', modelKey: 'deepseek/deepseek-flash', userId: U });
  saveModel(db, { key: m.key, fields: { enabled: false }, userId: U });
  throws(() => setBinding(db, { tier: 'standard', modelKey: m.key, userId: U }), /已停用/, '停用后不能再绑');
  saveModel(db, { key: m.key, fields: { enabled: true }, userId: U });
  setBinding(db, { tier: 'light', modelKey: m.key, effort: 'low', userId: U });
  // 走回报计费的平台可免单价
  const g = saveModel(db, { key: 'openrouter/some/new-model', fields: { pricing: null }, userId: U });
  eq(bindable(g, endpointsOf(db)), null, 'openrouter（reported）不要求单价');
  // 覆盖默认目录项：只存改的字段
  const o = saveModel(db, { key: 'deepseek/deepseek-flash', fields: { contextWindow: 900000 }, userId: U });
  eq([o.source, o.overridden, o.contextWindow, o.pricing], ['default', true, 900000, MODEL_CATALOG['deepseek/deepseek-flash'].pricing], '默认项改窗口，单价继承');
  const row = db.one(`SELECT * FROM llm_models WHERE key='deepseek/deepseek-flash'`);
  eq([row.pricing, row.model, row.context_window], [null, null, 900000], '库行只存差异');
}
section('5b. 删覆盖 = 回默认；没覆盖的默认项无可删');
{
  throws(() => removeModel(db, { key: 'deepseek/deepseek-v4-pro', userId: U }), /档正在使用/, '绑着的默认项：先拒绑定');
  throws(() => removeModel(db, { key: 'anthropic/claude-fable-5', userId: U }), /是内置默认值/, '没覆盖行：无可删');
  setBinding(db, { tier: 'light', modelKey: 'deepseek/deepseek-v4-pro', userId: U });
  setBinding(db, { tier: 'standard', modelKey: 'deepseek/deepseek-v4-pro', userId: U });
  eq(removeModel(db, { key: 'deepseek/deepseek-flash', userId: U }).reverted, true, '删覆盖 = 回默认');
  eq(catalogOf(db)['deepseek/deepseek-flash'].contextWindow, 1_000_000, '窗口回到默认');
  eq(audits('model_removed').length, 1, '审计 model_removed');
  // 用户加的整行删
  setBinding(db, { tier: 'light', modelKey: 'deepseek/deepseek-flash', userId: U });
  setBinding(db, { tier: 'standard', modelKey: 'deepseek/deepseek-flash', userId: U });
  eq(removeModel(db, { key: 'siliconflow/deepseek-ai/DeepSeek-V4', userId: U }).reverted, false, '用户加的：删');
  assert(!catalogOf(db)['siliconflow/deepseek-ai/DeepSeek-V4'], '目录里没了');
}

section('6. 请求头 / 列表 URL / 拉列表 / 测试连接（假 fetch）');
{
  const eps = endpointsOf(db);
  eq(headersFor(PROVIDERS['openai-chat'], eps.deepseek, 'K')['authorization'], 'Bearer K', 'API 格式默认鉴权头');
  const h = headersFor(PROVIDERS['openai-chat'], eps.siliconflow, 'K');
  eq([h['x-token'], h.authorization], ['K', undefined], '自定义鉴权头替换默认的，前缀为空');
  eq(modelsUrlOf(eps.siliconflow), 'https://api.siliconflow.cn/v1/models', '列表 URL = 地址去尾斜杠 + /models');
  eq(modelsUrlOf(eps.anthropic), 'https://api.anthropic.com/v1/models?limit=100', 'anthropic 列表路径');
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, method: init?.method ?? 'GET' });
    if (url.includes('openrouter.ai') && url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'moonshotai/kimi-k3', pricing: { prompt: '0.000003', completion: '0.000015' }, context_length: 262144, supported_parameters: ['reasoning_effort'] }, { id: 'x/no-price', pricing: {}, supported_parameters: [] }] }) };
    if (url.includes('siliconflow') && url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-ai/DeepSeek-V4' }] }) };
    if (url.includes('chat/completions')) return { ok: init.headers.authorization === 'Bearer good', status: init.headers.authorization === 'Bearer good' ? 200 : 401, json: async () => ({ error: { message: 'bad key' } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const or = await listEndpointModels(eps.openrouter, { env: {}, fetchFn });
  eq(or.rows.length, 2, 'OpenRouter 没 key 也拉得到');
  eq(or.rows[0], { id: 'moonshotai/kimi-k3', pricing: { input: 3, output: 15 }, contextWindow: 262144, efforts: ['low', 'medium', 'high'], expires: null }, '带单价（换算成 $/M）/ 窗口 / 推理强度');
  eq(or.rows[1].efforts, [], 'supported_parameters 没 reasoning → 推理强度取值空');
  eq(or.rows[1].pricing, null, '没价格 → null');
  const sf = await listEndpointModels(eps.siliconflow, { env: { SILICONFLOW_API_KEY: 'k' }, fetchFn });
  eq(sf.rows, [{ id: 'deepseek-ai/DeepSeek-V4', pricing: null, contextWindow: null, efforts: null, expires: null }], '只有 id 的列表');
  eq(calls.find((c) => c.url.includes('siliconflow')).headers['x-token'], 'k', '拉列表用服务商的鉴权头');
  const t1 = await testEndpoint(db, { id: 'deepseek', env: {}, fetchFn });
  eq([t1.ok, t1.message], [false, '.env 中未设置 DEEPSEEK_API_KEY'], '没 key：不发请求');
  const t2 = await testEndpoint(db, { id: 'deepseek', env: { DEEPSEEK_API_KEY: 'bad' }, fetchFn });
  eq([t2.ok, t2.status], [false, 401], '401 原样报');
  const t3 = await testEndpoint(db, { id: 'deepseek', env: { DEEPSEEK_API_KEY: 'good' }, fetchFn });
  eq([t3.ok, t3.model], [true, 'deepseek-flash'], '通了；试的是目录里第一个启用的模型');
  const t4 = await testEndpoint(db, { id: 'siliconflow', env: { SILICONFLOW_API_KEY: 'good' }, fetchFn });
  eq(t4.ok, false, '服务商没模型：报"先加一个"');
  assert(t4.message.includes('还没有模型'), t4.message);
}

section('7. .env 写 key：文件 600、进程 env 更新、不回显');
{
  const envPath = join(TMP, '.env');
  const env = {};
  const r = setEnvVar(envPath, 'DEEPSEEK_API_KEY', 'sk-test-1', { env });
  eq([r.existed, r.present], [false, true], '新增');
  eq(readFileSync(envPath, 'utf8'), 'DEEPSEEK_API_KEY=sk-test-1\n', '文件内容');
  eq(env.DEEPSEEK_API_KEY, 'sk-test-1', '进程 env 更新');
  setEnvVar(envPath, 'OTHER', 'x', { env });
  const r2 = setEnvVar(envPath, 'DEEPSEEK_API_KEY', 'sk-test-2', { env });
  eq(r2.existed, true, '替换已有行');
  eq(readFileSync(envPath, 'utf8'), 'DEEPSEEK_API_KEY=sk-test-2\nOTHER=x\n', '替换不重复、不动别的行');
  setEnvVar(envPath, 'DEEPSEEK_API_KEY', '', { env });
  eq(env.DEEPSEEK_API_KEY, undefined, '清空 = 删掉进程变量');
  throws(() => setEnvVar(envPath, 'bad', 'x', { env }), /变量名/, '变量名校验');
  throws(() => setEnvVar(envPath, 'A_B', 'x\ny', { env }), /换行/, '值不能含换行');
  if (process.platform !== 'win32') { const { statSync } = await import('node:fs'); eq(statSync(envPath).mode & 0o777, 0o600, '权限 600'); }
}

section('8. 客户端吃库：档位推理强度覆盖、自定义鉴权头、每次建客户端重读');
{
  const seen = [];
  const fetchFn = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ id: 'x', model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }; };
  try {
    setBinding(db, { tier: 'light', modelKey: 'deepseek/deepseek-flash', effort: 'low', userId: U });
    const c = new LlmClient({ mode: 'live', ...registryFor(db), apiKeys: { deepseek: 'K' }, retryDelays: [0] });
    await c.complete({ tier: 'light', maxTokens: 10, effort: 'high', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    eq(seen[0].body.reasoning_effort, 'low', '库里的档位推理强度覆盖角色请求的 high');
    setBinding(db, { tier: 'light', modelKey: 'deepseek/deepseek-flash', effort: null, userId: U });
    const c2 = new LlmClient({ mode: 'live', ...registryFor(db), apiKeys: { deepseek: 'K' }, retryDelays: [0] });
    await c2.complete({ tier: 'light', maxTokens: 10, effort: 'high', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    eq(seen[1].body.reasoning_effort, 'high', '推理强度清空后角色默认生效（新客户端重读了库）');
    // 自定义鉴权头 + 自定义地址
    saveModel(db, { key: 'siliconflow/m', fields: { pricing: { input: 1, output: 1 } }, userId: U });
    setBinding(db, { tier: 'standard', modelKey: 'siliconflow/m', userId: U });
    const c3 = new LlmClient({ mode: 'live', ...registryFor(db), apiKeys: { siliconflow: 'TOK' }, retryDelays: [0] });
    await c3.complete({ tier: 'standard', maxTokens: 10, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    eq(seen[2].url, 'https://api.siliconflow.cn/v1/chat/completions', '地址来自库里的服务商');
    eq([seen[2].headers['x-token'], seen[2].headers.authorization], ['TOK', undefined], '自定义鉴权头');
    eq(c3.ledger[0].model, 'siliconflow/m', '账本记目录键');
  } finally { globalThis.fetch = fetchFn; }
  setBinding(db, { tier: 'standard', modelKey: 'deepseek/deepseek-flash', userId: U });
}

section('9. 目录检查读生效目录：停用的不查、用户加的查、在用的键从库读');
{
  saveModel(db, { key: 'deepseek/deepseek-v4-flash', fields: { enabled: false }, userId: U });
  const reg = checkableCatalog(db);
  assert(!reg.catalog['deepseek/deepseek-v4-flash'], '停用的模型不在待查目录');
  assert(reg.catalog['siliconflow/m'], '用户加的在');
  eq(reg.keysInUse.sort(), ['deepseek/deepseek-flash', 'deepseek/deepseek-flash', 'deepseek/deepseek-v4-pro'].sort(), '在用的键 = 库里的绑定');
  const urls = [];
  const fetchFn = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
  const r = await checkCatalog({ catalog: reg.catalog, vendors: reg.vendors, env: { SILICONFLOW_API_KEY: 'k' }, fetchFn, only: 'siliconflow' });
  assert(urls.includes('https://api.siliconflow.cn/v1/models'), '用户加的服务商按它的地址查 /models');
  assert(r.entries.some((e) => e.key === 'siliconflow/m' && e.findings.some((f) => f.level === 'WARN' && f.msg.includes('不在'))), '不在列表里 → WARN');
  removeModel(db, { key: 'deepseek/deepseek-v4-flash', userId: U });
}

section('10. 看板 /api/llm：读所有人、写只负责人、key 不回显、动作串起来');
{
  const envPath = join(TMP, 'web.env');
  const env = { DEEPSEEK_API_KEY: 'present' };
  const fetchFn = async (url, init) => {
    if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-ai/DeepSeek-V4' }] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const w = await startWeb(db, { home: join(TMP, 'home'), port: 0, tokenPlain: owner.plaintext, pollMs: 100, envFile: envPath, env, fetchFn });
  const base = `http://127.0.0.1:${w.port}`;
  const member = addUser(db, { name: '成员', role: 'member', byUserId: U });
  const get = (p, tok) => fetch(base + p, { headers: tok ? { 'x-superintern-token': tok } : {} }).then((r) => r.json());
  const post = (p, b, tok) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { 'x-superintern-token': tok } : {}) }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const v = await get('/api/llm');
  assert(v.endpoints.length >= 6 && v.models.length >= 16 && v.binding.binding.light, '视图三层都有');
  const ds = v.endpoints.find((e) => e.id === 'deepseek');
  eq([ds.keyPresent, ds.keyEnv], [true, 'DEEPSEEK_API_KEY'], 'key 只报填没填');
  assert(!JSON.stringify(v).includes('present'), '视图里没有 key 的值');
  eq((await post('/api/llm', { action: 'bind_set', tier: 'light', key: 'deepseek/deepseek-v4-pro' }, member.plaintext)).status, 403, '成员不能写');
  eq(v.models.find((m) => m.key === 'deepseek/deepseek-v4-pro').boundTiers, ['standard', 'heavy'].filter((t) => bindingOf(db).binding[t] === 'deepseek/deepseek-v4-pro'), '模型行标在用档位');
  // 加服务商 → 写 key → 拉列表 → 加模型（缺价）→ 填价 → 绑定 → 推理强度
  let r = await post('/api/llm', { action: 'endpoint_save', id: 'Ark', label: '火山方舟', adapter: 'openai-chat', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/', keyEnv: 'ark_api_key' });
  eq([r.status, r.result.id, r.result.baseUrl, r.result.keyEnv], [200, 'ark', 'https://ark.cn-beijing.volces.com/api/v3', 'ARK_API_KEY'], '服务商表单：id 小写、地址去尾斜杠、变量名大写');
  r = await post('/api/llm', { action: 'key_set', id: 'ark', value: 'sk-ark-secret' });
  eq([r.status, r.result], [200, { keyEnv: 'ARK_API_KEY', present: true }], '写 key 只回"已填"');
  assert(!JSON.stringify(r).includes('sk-ark'), '响应不回显 key');
  eq(readFileSync(envPath, 'utf8').includes('ARK_API_KEY=sk-ark-secret'), true, '.env 里有');
  eq(env.ARK_API_KEY, 'sk-ark-secret', '看板进程 env 更新（子进程继承）');
  const ka = audits('key_set');
  eq(ka.length, 1, '审计 key_set');
  assert(!ka[0].payload.includes('sk-ark'), '审计不含值');
  eq(r.view.endpoints.find((e) => e.id === 'ark').keyPresent, true, '视图随响应更新');
  r = await post('/api/llm', { action: 'endpoint_models', id: 'ark' });
  eq(r.result.rows, [{ id: 'deepseek-ai/DeepSeek-V4', pricing: null, contextWindow: null, efforts: null, expires: null, key: 'ark/deepseek-ai/DeepSeek-V4', inCatalog: false }], '拉列表');
  r = await post('/api/llm', { action: 'model_save', key: 'ark/deepseek-ai/DeepSeek-V4', origin: 'listed', fields: { model: 'deepseek-ai/DeepSeek-V4' } });
  eq([r.status, r.result.cannotBind ?? r.view.models.find((m) => m.key === 'ark/deepseek-ai/DeepSeek-V4').cannotBind], [200, '未填写单价，无法计入预算上限，不能分配'], '加入后缺价标出');
  r = await post('/api/llm', { action: 'bind_set', tier: 'light', key: 'ark/deepseek-ai/DeepSeek-V4' });
  eq(r.status, 400, '缺价不能绑（400）');
  // 看板表单四个单价框都空时发 pricing:null：能存（口径同 CLI catalog add），能不能用由 bindable 说
  r = await post('/api/llm', { action: 'model_save', key: 'ark/deepseek-ai/DeepSeek-V4', fields: { model: 'deepseek-ai/DeepSeek-V4', pricing: null, contextWindow: 128000, efforts: null } });
  eq([r.status, r.view.models.find((m) => m.key === 'ark/deepseek-ai/DeepSeek-V4').contextWindow], [200, 128000], '不带单价也能保存别的字段');
  r = await post('/api/llm', { action: 'model_save', key: 'ark/deepseek-ai/DeepSeek-V4', fields: { pricing: { input: 0.3 } } });
  eq(r.status, 400, '只填一半单价是填错，仍拒');
  // 按平台回报记账的服务商：不带单价能存、能用
  r = await post('/api/llm', { action: 'model_save', key: 'openrouter/vendor-x/model-y', fields: { model: 'vendor-x/model-y', pricing: null, contextWindow: null, efforts: null } });
  eq([r.status, r.view.models.find((m) => m.key === 'openrouter/vendor-x/model-y').cannotBind], [200, null], '回报记账的平台：没单价也可选');
  r = await post('/api/llm', { action: 'model_save', key: 'ark/deepseek-ai/DeepSeek-V4', fields: { pricing: { input: 0.3, output: 1.2 } } });
  eq(r.view.models.find((m) => m.key === 'ark/deepseek-ai/DeepSeek-V4').cannotBind, null, '填价后可绑');
  r = await post('/api/llm', { action: 'bind_set', tier: 'light', key: 'ark/deepseek-ai/DeepSeek-V4', effort: 'medium' });
  eq([r.status, r.view.binding.binding.light, r.view.binding.efforts.light], [200, 'ark/deepseek-ai/DeepSeek-V4', 'medium'], '绑定 + 推理强度');
  r = await post('/api/llm', { action: 'endpoint_enable', id: 'ark', enabled: false });
  eq(r.status, 400, '绑着的服务商不能停用');
  r = await post('/api/llm', { action: 'endpoint_test', id: 'ark' });
  eq([r.status, r.result.ok, r.result.model], [200, true, 'deepseek-ai/DeepSeek-V4'], '测试连接走假 fetch');
  r = await post('/api/llm', { action: 'catalog_check', vendor: 'ark' });
  eq(r.status, 200, '看板触发目录检查');
  assert(r.view.lastCheck && r.view.models.find((m) => m.key === 'ark/deepseek-ai/DeepSeek-V4').findings.length === 0, '在列表里：行上没有发现');
  r = await post('/api/llm', { action: 'bind_set', tier: 'light', key: 'deepseek/deepseek-flash' });
  r = await post('/api/llm', { action: 'endpoint_remove', id: 'ark' });
  eq([r.status, r.result.reverted], [200, false], '删用户服务商');
  assert(!r.view.models.some((m) => m.vendor === 'ark'), '它的模型一起删');
  const html = await fetch(base + '/').then((x) => x.text());
  assert(['id="bindCard"', 'id="epCard"', 'id="modelCard"', '模型分配', '服务商', '模型列表'].every((x) => html.includes(x)) && html.includes('不写入数据库，不回显'), '设置页有模型分配 / 服务商 / 模型列表三个分区；密钥不入库不回显写在界面上');
  w.close();
}

section('10b. init 的默认绑定按已有的 key 挑：只看变量在不在');
{
  const d3 = openDb(':memory:'); const u3 = ensureOwner(d3, 'o').userId;
  eq(pickDefaultBinding(d3, { env: { DEEPSEEK_API_KEY: 'x' } }), { vendor: 'deepseek', binding: { light: 'deepseek/deepseek-flash', standard: 'deepseek/deepseek-flash', heavy: 'deepseek/deepseek-v4-pro' } }, '只有 DeepSeek 的 key：三档都用它（出厂默认的 heavy 是 anthropic）');
  eq(pickDefaultBinding(d3, { env: { DEEPSEEK_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' } }), null, '出厂默认要的两家 key 都在：不动');
  eq(pickDefaultBinding(d3, { env: {} }), null, '一家 key 都没有：不动（init 照旧打 ⚠）');
  eq(pickDefaultBinding(d3, { env: { OPENAI_API_KEY: 'x', GEMINI_API_KEY: 'y' } })?.vendor, 'openai', '多家有 key：按 deepseek / anthropic / openai / gemini 的顺序取第一家');
  eq(pickDefaultBinding(d3, { env: { OPENROUTER_API_KEY: 'x' } }), null, '只有聚合平台的 key：没有现成的三档落位，不猜');
  const p = pickDefaultBinding(d3, { env: { DEEPSEEK_API_KEY: 'x' } });
  eq(seedBinding(d3, { overrides: p.binding, userId: u3 }).binding.heavy, 'deepseek/deepseek-v4-pro', '挑出来的能过 setBinding 的校验、写进库');
  eq(pickDefaultBinding(d3, { env: { DEEPSEEK_API_KEY: 'x' } }), null, '库里已有绑定：不再挑（不覆盖人定的）');
  d3.close();
}

section('11. 孤儿：库里留着对默认项的覆盖，而这一版代码里那个默认项没了');
{
  const d2 = openDb(':memory:');
  const u2 = ensureOwner(d2, 'o').userId;
  // 用一份"旧版代码"的目录 / 服务商建覆盖行，再换成"新版"（少了那两项）读
  const oldCat = { ...MODEL_CATALOG, 'deepseek/retired-x': { vendor: 'deepseek', model: 'retired-x', pricing: { input: 1, output: 2 } } };
  const oldVen = { ...VENDORS, goneco: { adapter: 'openai-chat', keyEnv: 'GONECO_API_KEY', baseUrl: 'https://api.gone.example/v1' } };
  saveModel(d2, { key: 'deepseek/retired-x', fields: { contextWindow: 64000 }, userId: u2, catalog: oldCat, vendors: oldVen });
  saveEndpoint(d2, { id: 'goneco', baseUrl: 'https://proxy.gone.example/v1', userId: u2, vendors: oldVen });
  saveModel(d2, { key: 'goneco/some-model', fields: { pricing: { input: 1, output: 1 } }, userId: u2, catalog: oldCat, vendors: oldVen });
  const cat = catalogOf(d2), eps = endpointsOf(d2);
  eq([cat['deepseek/retired-x'].orphan, cat['deepseek/retired-x'].enabled, cat['deepseek/retired-x'].vendor], [true, false, null], '模型覆盖行标成孤儿、视为停用');
  eq([eps.goneco.orphan, eps.goneco.enabled, eps.goneco.adapter], [true, false, null], '服务商覆盖行同理');
  assert(/新版本已不再内置该模型/.test(bindable(cat['deepseek/retired-x'], eps)), 'bindable 说清原因');
  assert(/新版本已不再内置服务商 goneco/.test(bindable(cat['goneco/some-model'], eps)), '孤儿服务商下的模型也说清');
  throws(() => setBinding(d2, { tier: 'light', modelKey: 'deepseek/retired-x', userId: u2 }), /不再内置该模型/, '孤儿不能绑');
  throws(() => saveModel(d2, { key: 'deepseek/retired-x', fields: { contextWindow: 1 }, userId: u2 }), /不再内置该模型/, '孤儿模型改不了，只能删');
  throws(() => saveEndpoint(d2, { id: 'goneco', enabled: true, userId: u2 }), /不再内置服务商 goneco.*只能删除/, '孤儿服务商改不了，只能删');
  assert(!Object.keys(checkableCatalog(d2).catalog).some((k) => k === 'deepseek/retired-x' || k.startsWith('goneco/')), '目录检查不去查孤儿');
  eq(removeModel(d2, { key: 'deepseek/retired-x', userId: u2 }).key, 'deepseek/retired-x', '孤儿模型可删');
  removeEndpoint(d2, { id: 'goneco', userId: u2 });
  eq([endpointsOf(d2).goneco, catalogOf(d2)['goneco/some-model']], [undefined, undefined], '删孤儿服务商连它的模型一起走');
  // 用户自己加的（行里有自己的 adapter / vendor）不是孤儿
  saveEndpoint(d2, { id: 'mine', adapter: 'openai-chat', baseUrl: 'https://api.mine.example/v1', keyEnv: 'MINE_API_KEY', userId: u2 });
  eq(endpointsOf(d2).mine.orphan, undefined, '用户新增的服务商不是孤儿');
  d2.close();
}

db.close();
console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 200);   // 同 web.test：关了库再退，否则 Windows 上 node:sqlite 在退出时崩（0xC0000409）
