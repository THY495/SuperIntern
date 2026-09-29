// 基础设施错误：不是节点的错，也不是模型能修的错
//
// 跑：node tests/infra.test.mjs
//
// 实际运行中撞出来的同一个形状的两端：
//   - 厂商 403 从 runToolLoop **炸穿**到 CLI，进程死、节点停在 running、
//     下次启动被认领记一次重试 —— 而那不是节点难，是厂商挂了
//   - 容器 OOM 抛 Error，runToolLoop 把它**吞成工具报错**回给模型，模型接着跑 ——
//     "硬失败"成了一句话
// 加上第三条：flushLedger 只在节点结束跑，进程没活到那里，烧掉的钱一分不进账本。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient, runToolLoop } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { ProviderError, HardLimitError, ConfigError, isInfraError } from '../src/core/errors.mjs';
import { setLimit } from '../src/core/limits.mjs';
import { TIER_BINDING, MODEL_CATALOG, VENDORS, tierEntry } from '../src/llm/canonical.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-infra-'));
const WS = join(TMP, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(join(WS, 'seed.txt'), 'hello\n');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

/** 一个任务 + 一个待办节点。 */
function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), constId = newId('c'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'g','s','d','[]',?,?)`, constId, taskId, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'n','做点事','有产物','pending','normal','standard',?)`, nodeId, taskId, t);
  return { db, taskId, nodeId, userId };
}
const toolCall = (name, args) => ({
  stopReason: 'tool_call',
  content: [{ type: 'tool_call', id: `c_${name}`, name, args }],
  usage: { inputTokens: 1000, outputTokens: 50 },
});
const run = (db, taskId, script, extra = {}) => orchestrate(db, {
  taskId, workspace: WS, narrativeDir: join(TMP, 'nar'), maxCycles: 2, commit: false, verify: false,
  exec: new LocalExecutor(),
  makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(script), fakePricing: { input: 1, output: 1 } }),
  ...extra,
});
const audits = (db, action, target) => db.all(
  `SELECT payload FROM audit_log WHERE action=? ${target ? 'AND target_id=?' : ''} ORDER BY id`,
  ...(target ? [action, target] : [action])).map((r) => JSON.parse(r.payload));

// ═══════════════════════════════════════════════════════════════════════════
section('1. 工具循环：基础设施错误穿出去，普通错误回给模型');
// ═══════════════════════════════════════════════════════════════════════════
{
  const client = new LlmClient({ mode: 'fake', fake: makeFake([toolCall('boom', {}), toolCall('boom', {})]) });
  const r1 = await runToolLoop(client, { tier: 'standard', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] },
    { boom: async () => { throw new Error('普通报错'); } }, { maxIterations: 1 });
  assert(r1.messages.some((m) => m.role === 'tool_results' && m.results?.[0]?.isError && m.results[0].content === '普通报错'),
    '普通异常 → 变成 isError 工具结果回给模型（原行为不变）');

  let caught = null;
  try {
    await runToolLoop(client, { tier: 'standard', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], tools: [] },
      { boom: async () => { throw new HardLimitError('OOM', { breach: { key: 'limit.memory_bytes' } }); } }, { maxIterations: 1 });
  } catch (e) { caught = e; }
  assert(caught instanceof HardLimitError, 'HardLimitError **穿出**工具循环 —— 不回给模型（否则它会被吞成一句话）');
  assert(isInfraError(caught) && caught.breach.key === 'limit.memory_bytes', '错误对象带着 breach，编排器能据此分流');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 厂商侧重试：只重试可重试的，有界，最终抛 ProviderError');
// ═══════════════════════════════════════════════════════════════════════════
{
  // fetch 被替换，不会真发 —— 但 _resolve 会查 key 在不在。standard 默认绑哪家不该
  // 由这个测试关心，四家都给个假值。
  for (const k of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
    process.env[k] ??= 'test-key-never-sent';
  }
  const realFetch = globalThis.fetch;
  const script = (codes) => {
    let i = 0;
    return async () => {
      const status = codes[i++] ?? 200;
      return { ok: status < 400, status, json: async () => (status < 400
        ? { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
        : { error: { type: 'x', message: `HTTP ${status}` } }) };
    };
  };
  const call = (client) => client.complete({ tier: 'standard', system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], maxTokens: 8 });
  // 假的线上响应写成 Anthropic 形状，所以把 standard 钉到 anthropic —— 默认绑的是
  // deepseek（OpenAI 形状），parseResponse 会在 choices[] 里找不到东西。
  const fast = { mode: 'live', retryDelays: [0, 0, 0],
    binding: { ...TIER_BINDING, standard: 'anthropic/claude-sonnet-5' } };
  try {
    globalThis.fetch = script([500, 503, 200]);
    const r = await call(new LlmClient(fast));
    assert(r?.content?.length, '500 → 503 → 200：两次重试后成功，调用方看不到抖动');

    globalThis.fetch = script([403]);
    let e = null; try { await call(new LlmClient(fast)); } catch (x) { e = x; }
    assert(e instanceof ProviderError, '403 → ProviderError');
    eq(e.retryable, false, '403 **不可重试** —— 权限/配额，重试只是多撞几次');
    eq(e.attempts, 1, '403 只试了 1 次');
    eq(e.status, 403, '状态码带在错误上');
    assert(e.tier === 'standard' && e.vendor && e.model, '档位 / 厂商 / 模型带在错误上 —— CLI 要靠它提示 --bind');

    globalThis.fetch = script([429, 429, 429, 429, 429]);
    e = null; try { await call(new LlmClient(fast)); } catch (x) { e = x; }
    assert(e instanceof ProviderError && e.retryable === true, '429 连续 → 可重试但耗尽 → ProviderError(retryable=true)');
    eq(e.attempts, 4, '1 次 + 3 次重试 = 4 次，有界');

    globalThis.fetch = async () => { throw new Error('fetch failed'); };
    e = null; try { await call(new LlmClient(fast)); } catch (x) { e = x; }
    assert(e instanceof ProviderError && e.status === null && e.retryable, '网络失败 → status=null、可重试、耗尽后抛');
  } finally { globalThis.fetch = realFetch; }
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 编排器：厂商错误 → 干净地停，节点退回 pending，**不计重试**');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId } = fixture();
  const boom = new ProviderError('anthropic/x HTTP 403: forbidden',
    { vendor: 'anthropic', model: 'x', tier: 'standard', status: 403, retryable: false, attempts: 1 });
  const r = await run(db, taskId, [toolCall('list_dir', { path: '.' }), boom]);
  eq(r.kind, 'provider_error', '结果 kind = provider_error（原来是进程直接炸）');
  eq(r.error?.status, 403, '结果里带状态码');
  const n = db.one(`SELECT status, retry_count FROM nodes WHERE id=?`, nodeId);
  eq(n.status, 'pending', '节点退回 pending —— 不再停在 running 等下次认领');
  eq(n.retry_count, 0, '**不计重试** —— 厂商挂了不是节点的错');
  eq(audits(db, 'provider_error', nodeId).length, 1, '一条 provider_error 审计挂在节点上');
  eq(audits(db, 'node_crashed', nodeId).length, 1, 'executeNode 的 node_crashed 审计照旧（叙事也写了）');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'running', '任务不冻结 —— 换一家就能接着跑');
  eq(db.one(`SELECT count(*) AS n FROM questions WHERE task_id=?`, taskId).n, 0, '不生成问题 —— 这不需要人拍板，需要人换绑定');
  // 一次普通 Error（真 bug）照旧炸出去，不被"优雅处理"藏起来
  const { db: db2, taskId: t2 } = fixture();
  let threw = null;
  try { await run(db2, t2, [new TypeError('真 bug')]); } catch (e) { threw = e; }
  assert(threw instanceof TypeError, '非基础设施异常照旧抛出 —— 真 bug 不该被藏进"优雅处理"');
  db.close(); db2.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3b. 配置问题：绑定停用 / 缺 key 走同一条通道 —— 不计重试、不发请求');
// ═══════════════════════════════════════════════════════════════════════════
{
  // tierEntry 的几种配错都是 ConfigError（以前是普通 Error → 被当成真 bug 扣重试）
  const off = { ...MODEL_CATALOG, 'deepseek/deepseek-flash': { ...MODEL_CATALOG['deepseek/deepseek-flash'], enabled: false } };
  const cases = [
    ['模型停用', () => tierEntry('standard', { standard: 'deepseek/deepseek-flash' }, off, VENDORS), /已停用/],
    ['服务商停用', () => tierEntry('standard', { standard: 'deepseek/deepseek-flash' }, MODEL_CATALOG, { ...VENDORS, deepseek: { ...VENDORS.deepseek, enabled: false } }), /服务商 deepseek 已停用/],
    ['键不在目录', () => tierEntry('standard', { standard: 'deepseek/nope' }, MODEL_CATALOG, VENDORS), /不在模型目录里/],
    ['没绑', () => tierEntry('standard', {}, MODEL_CATALOG, VENDORS), /没有绑模型/],
    ['孤儿', () => tierEntry('standard', { standard: 'x/y' }, { 'x/y': { key: 'x/y', vendor: null, orphan: true, enabled: false } }, VENDORS), /升级后的系统里已经没有了/],
  ];
  for (const [name, fn, re] of cases) {
    let e = null; try { fn(); } catch (x) { e = x; }
    assert(e instanceof ConfigError && isInfraError(e) && re.test(e.message) && e.tier === 'standard', `tierEntry：${name} → ConfigError（带 tier）`);
  }
  // live 客户端、服务商的 key 变量在环境里不存在：抛 ConfigError，且一个请求都没发
  const vendors = { ...VENDORS, deepseek: { ...VENDORS.deepseek, keyEnv: 'SI_TEST_NO_SUCH_KEY_VAR' } };
  const realFetch = globalThis.fetch; let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('不该发请求'); };
  try {
    const { db, taskId, nodeId } = fixture();
    const r = await orchestrate(db, { taskId, workspace: WS, narrativeDir: join(TMP, 'nar'), maxCycles: 2, commit: false, verify: false, exec: new LocalExecutor(),
      makeClient: () => new LlmClient({ mode: 'live', vendors, binding: { light: 'deepseek/deepseek-flash', standard: 'deepseek/deepseek-flash', heavy: 'deepseek/deepseek-flash' } }) });
    eq(r.kind, 'provider_error', '缺 key：退出原因仍是 provider_error（汇报 / 通知 / 守护进程退避都认它）');
    eq(r.error?.config, true, '结果里标了 config:true');
    eq(r.error?.tier, 'standard', '带档位 —— CLI 据此给出 bind set standard=…');
    assert(/SI_TEST_NO_SUCH_KEY_VAR/.test(r.error?.message ?? ''), '说清是哪个变量没填');
    const n = db.one(`SELECT status, retry_count FROM nodes WHERE id=?`, nodeId);
    eq(n.status, 'pending', '节点退回 pending');
    eq(n.retry_count, 0, '**不计重试** —— 以前这里会 +1，守护进程几轮就把 node_retries 耗光');
    eq(fetched, 0, '没有发出任何请求');
    eq(audits(db, 'provider_error', nodeId)[0]?.config, true, '审计 provider_error 带 config:true');
    eq(db.one(`SELECT count(*) AS n FROM questions WHERE task_id=?`, taskId).n, 0, '不生成问题');
    // 模型被停用：同一条路
    const { db: db3, taskId: t3, nodeId: n3 } = fixture();
    const r3 = await orchestrate(db3, { taskId: t3, workspace: WS, narrativeDir: join(TMP, 'nar'), maxCycles: 2, commit: false, verify: false, exec: new LocalExecutor(),
      makeClient: () => new LlmClient({ mode: 'live', catalog: off, binding: { light: 'deepseek/deepseek-flash', standard: 'deepseek/deepseek-flash', heavy: 'deepseek/deepseek-flash' }, apiKeys: { deepseek: 'k' } }) });
    eq([r3.kind, r3.error?.config, db3.one(`SELECT retry_count FROM nodes WHERE id=?`, n3).retry_count, fetched].join(), 'provider_error,true,0,0', '绑的模型被停用：同样不计重试、不发请求');
    db.close(); db3.close();
  } finally { globalThis.fetch = realFetch; }
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 编排器：硬边界 → limit_hard_failed，计一次重试，审计只记一次');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId } = fixture();
  const breach = { key: 'limit.memory_bytes', label: '容器内存上限', limit: 1024 ** 3, actual: 1024 ** 3,
    human: '容器内存上限触顶：容器已被 OOM kill' };
  // 硬边界从**工具处理器里**抛出（实际的形状：run_command → 容器 → OOM）
  const r = await run(db, taskId, [toolCall('list_dir', { path: '.' })], {
    exec: new (class extends LocalExecutor {
      listDir() { throw new HardLimitError('OOM', { breach }); }
    })(),
  });
  eq(r.kind, 'limit_hard_failed', 'kind = limit_hard_failed（原来这个 throw 被吞成工具报错，模型接着跑）');
  eq(r.breach?.key, 'limit.memory_bytes', '带着触顶维度');
  const n = db.one(`SELECT status, retry_count FROM nodes WHERE id=?`, nodeId);
  eq(n.status, 'pending', '节点退回 pending');
  eq(n.retry_count, 1, '**计一次重试** —— OOM 是节点自己的错');
  const lb = audits(db, 'limit_breached', taskId);
  eq(lb.length, 1, 'limit_breached 审计恰好一条 —— 容器侧只抛不记，编排器记（原来两边各记一条）');
  eq(lb[0].on_hit, 'hard_fail', '审计标明 hard_fail');
  eq(db.one(`SELECT count(*) AS n FROM questions WHERE task_id=?`, taskId).n, 0, '不生成问题 —— 硬边界不进提问分支');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 账每一轮就落，崩溃最多丢最后一轮');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId } = fixture();
  const boom = new ProviderError('x HTTP 503', { vendor: 'v', model: 'm', tier: 'standard', status: 503, retryable: true, attempts: 4 });
  await run(db, taskId, [toolCall('list_dir', { path: '.' }), toolCall('list_dir', { path: '.' }), boom]);
  const rows = db.one(`SELECT count(*) AS n, COALESCE(SUM(micro_usd),0) AS m FROM usage_ledger WHERE node_id=?`, nodeId);
  eq(rows.n, 2, '崩溃前的 2 轮调用**都在账本里** —— 原来 flushLedger 只在节点结束跑，一分都不会进');
  assert(rows.m > 0, '金额非零，预算闸门看得见');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 认领不计重试；连死三次走它自己的维度 limit.node_reclaims');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId, userId } = fixture();
  const dead = () => db.run(`UPDATE nodes SET status='running' WHERE id=?`, nodeId);   // 模拟进程死在它手里
  const boom = () => new ProviderError('x', { vendor: 'v', model: 'm', tier: 'standard', status: 403, retryable: false, attempts: 1 });

  dead(); await run(db, taskId, [boom()]);
  eq(db.one(`SELECT retry_count FROM nodes WHERE id=?`, nodeId).retry_count, 0, '认领一次：retry_count 仍是 0（原来 +1）');
  eq(audits(db, 'node_reclaimed', nodeId).at(-1)?.reclaims, 1, '审计记 reclaims=1');

  dead(); await run(db, taskId, [boom()]);
  dead();
  const r = await run(db, taskId, [boom()]);
  eq(audits(db, 'node_reclaimed', nodeId).length, 3, '三次认领');
  eq(r.kind, 'limit_breached', '第三次认领后**开跑前**就触顶（闸门排在挑节点之前）');
  eq(r.breach?.key, 'limit.node_reclaims', '触顶的是 node_reclaims，不是 node_retries —— 叫人的理由说对了');
  eq(db.one(`SELECT retry_count FROM nodes WHERE id=?`, nodeId).retry_count, 0, '全程 retry_count 没动');
  const q = db.one(`SELECT text FROM questions WHERE id=?`, r.questionId);
  assert(q?.text.includes('先检查宿主机与服务商'), '问题正文带这一维自己的 advice');

  // 上限可调：调到 10 就不再拦
  setLimit(db, { taskId, key: 'limit.node_reclaims', value: 10, userId });
  db.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);
  db.run(`UPDATE questions SET status='answered' WHERE task_id=?`, taskId);
  const r2 = await run(db, taskId, [boom()]);
  eq(r2.kind, 'provider_error', '加额后继续走到节点（然后被脚本里的 403 停下）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. 模型写坏了工具参数 JSON → 回给模型，不炸编排器');
// ═══════════════════════════════════════════════════════════════════════════
// 曾出现过（DeepSeek-pro）：node -e 的参数里塞了 `\*`，JSON.parse 抛
// "Bad escaped character"，从 adapter 一路穿到进程顶上。模型的错要回给模型。
{
  const { openaiChat, openaiResponses, toolArgs } = await import('../src/llm/providers.mjs');
  const badRaw = '{"file":"node","args":["-e","const re=/\\*x/"]}';   // \* 不是合法 JSON 转义
  const wire = { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [
    { id: 'c1', function: { name: 'run_command', arguments: badRaw } },
    { id: 'c2', function: { name: 'list_dir', arguments: '{"path":"."}' } }] } }], usage: {} };
  let resp;
  try { resp = openaiChat.parseResponse(wire); ok('parseResponse 不再抛'); } catch (e) { bad('parseResponse 不再抛', e.message); }
  const [c1, c2] = resp.content.filter((b) => b.type === 'tool_call');
  assert(c1.argsError && c1.argsRaw === badRaw, '坏块带 argsError + 原文');
  eq(JSON.stringify(c1.args), '{}', '坏块的 args 是空对象，不是 undefined');
  eq(c2.args.path, '.', '同一轮里的好块照常解析');
  // 回填给厂商时用原文，不用 JSON.stringify({})
  const req = openaiChat.buildRequest({ tier: 'standard', messages: [{ role: 'assistant', content: [c1] }], tools: [], maxTokens: 10 }, 'deepseek-v4-pro');
  const sent = JSON.stringify(req);
  assert(sent.includes(JSON.stringify(badRaw).slice(1, -1)), '回填 assistant 轮时 arguments 是模型的原文');
  eq(JSON.stringify(toolArgs('')), '{"args":{}}', '空串 → 空对象，不算错');
  const r2 = openaiResponses.parseResponse({ output: [{ type: 'function_call', call_id: 'x', name: 'grep', arguments: '{bad' }], usage: {} });
  assert(r2.content.find((b) => b.type === 'tool_call')?.argsError, 'Responses 形状同样不抛');

  // runToolLoop：坏块不执行 handler，回一条 isError 的工具结果，下一轮模型能重发
  let ran = 0;
  const fake = makeFake([
    { stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [c1] },
    { stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 },
      content: [{ type: 'tool_call', id: 'c3', name: 'run_command', args: { file: 'node', args: ['-v'] } }] },
    { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'text', text: '好了' }] },
  ]);
  const client = new LlmClient({ mode: 'fake', fake });
  const loop = await runToolLoop(client, { tier: 'standard', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [], maxTokens: 10 },
    { run_command: async () => { ran++; return 'exit=0'; } }, { maxIterations: 5 });
  eq(ran, 1, '坏块没执行 handler，重发的那次执行了');
  const tr = loop.messages.find((m) => m.role === 'tool_results').results[0];
  assert(tr.isError && tr.content.includes('不是合法 JSON') && tr.content.includes('Bad escaped'), '回给模型的是"参数不是合法 JSON"+ 原因');
  eq(loop.stopped, 'end_turn', '循环正常收尾');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
