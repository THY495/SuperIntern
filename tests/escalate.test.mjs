// 自动升档
//
// 跑：node tests/escalate.test.mjs
//
// 断言的是闸门与记录：重试 <2 不升；≥2 升一档；heavy 不再升；花费 / 时长闸门拦住时走触顶路径（问人）而不是赌；
// 升档落库（model_tier 改、tier_escalated_at、审计）；编排器真的用了升过的档；--tier 覆盖时不升。

import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { escalationFor, recordEscalation, priceRatio, TIER_ORDER } from '../src/core/escalate.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { MODEL_CATALOG } from '../src/llm/canonical.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const BINDING = { light: 'deepseek/deepseek-v4-flash', standard: 'deepseek/deepseek-v4-pro', heavy: 'anthropic/claude-opus-5' };
function fixture({ retry = 2, tier = 'standard', budget = 5_000_000, spentNode = 100_000 } = {}) {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), taskId, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,model_tier,retry_count,started_at,created_at)
          VALUES (?,?,'难活','s','a','pending',?,?,?,?)`, nodeId, taskId, tier, retry, t - 10 * 60_000, t);
  db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
          VALUES (?,?,'limit.budget_micro_usd',?,'task','constitutional','user',?,?,?)`, newId('p'), taskId, JSON.stringify(budget), userId, t, t);
  if (spentNode) {
    db.run(`INSERT INTO usage_ledger (task_id,node_id,role,model_tier,provider,model_id,input_tokens,output_tokens,micro_usd,billing,ts)
            VALUES (?,?,'executor',?,'deepseek','deepseek/deepseek-v4-pro',1000,1000,?,'computed',?)`, taskId, nodeId, tier, spentNode, t);
  }
  const node = () => db.one(`SELECT * FROM nodes WHERE id=?`, nodeId);
  return { db, taskId, nodeId, node, t };
}

section('1. 什么时候升、升到哪');
{
  let f = fixture({ retry: 1 });
  eq(escalationFor(f.db, { taskId: f.taskId, node: f.node(), binding: BINDING, catalog: MODEL_CATALOG }).escalated, false, '重试 1 次：不升');
  f = fixture({ retry: 2 });
  let e = escalationFor(f.db, { taskId: f.taskId, node: f.node(), binding: BINDING, catalog: MODEL_CATALOG });
  assert(e.escalated && e.tier === 'heavy' && e.from === 'standard', '重试 2 次：standard → heavy');
  assert(e.estimateMicro >= 50_000, '预计花费有下限（$0.05）');
  f = fixture({ retry: 3, tier: 'heavy' });
  e = escalationFor(f.db, { taskId: f.taskId, node: f.node(), binding: BINDING, catalog: MODEL_CATALOG });
  assert(!e.escalated && e.tier === 'heavy', 'heavy 不再升');
  f = fixture({ retry: 2, tier: 'light' });
  eq(escalationFor(f.db, { taskId: f.taskId, node: f.node(), binding: BINDING, catalog: MODEL_CATALOG }).tier, 'standard', 'light → standard，只上一档');
  eq(TIER_ORDER.join(','), 'light,standard,heavy', '档位顺序');
  assert(priceRatio('standard', 'heavy', BINDING, MODEL_CATALOG) > 1, '单价比按目录算（heavy 比 standard 贵）');
  eq(priceRatio('standard', 'heavy', { standard: 'x', heavy: 'y' }, {}), 3, '目录查不到 → 3');
}

section('2. 闸门：花费不够 / 时长不够 → 不升档，走触顶路径问人');
{
  // 花费：预算 $0.30，已花 $0.28，升档预计 ≥ $0.05 → 拦
  let f = fixture({ retry: 2, budget: 300_000, spentNode: 280_000 });
  let e = escalationFor(f.db, { taskId: f.taskId, node: f.node(), binding: BINDING, catalog: MODEL_CATALOG });
  assert(e.blocked && e.breach.key === 'limit.budget_micro_usd', '花费闸门拦住，维度是 budget');
  assert(e.breach.human.includes('升档前预算闸门') && e.breach.human.includes('heavy'), '正文说清是升档前闸门拦的、要升到哪');
  // 时长：上次尝试 10 分钟（started_at 十分钟前，刚刚 stalled），运行时长上限 12 分钟，需要 15 → 拦
  f = fixture({ retry: 2 });
  audit(f.db, { actorKind: 'agent', action: 'node_stalled', targetType: 'node', targetId: f.nodeId, payload: {} });
  f.db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
            VALUES (?,?,'limit.runtime_ms',?,'task','constitutional','user',NULL,?,?)`, newId('p'), f.taskId, JSON.stringify(12 * 60_000), f.t, f.t);
  e = escalationFor(f.db, { taskId: f.taskId, node: f.node(), binding: BINDING, catalog: MODEL_CATALOG, ctx: { startedAt: now() } });
  assert(e.blocked && e.breach.key === 'limit.runtime_ms', '时长闸门拦住，维度是 runtime');
  // 上限够 → 放行
  f.db.run(`UPDATE params SET value=? WHERE task_id=? AND key='limit.runtime_ms'`, JSON.stringify(60 * 60_000), f.taskId);
  e = escalationFor(f.db, { taskId: f.taskId, node: f.node(), binding: BINDING, catalog: MODEL_CATALOG, ctx: { startedAt: now() } });
  assert(e.escalated, '时长够 → 升');
}

section('3. 落库与编排器接线');
{
  const f = fixture({ retry: 2 });
  const e = escalationFor(f.db, { taskId: f.taskId, node: f.node(), binding: BINDING, catalog: MODEL_CATALOG });
  recordEscalation(f.db, { taskId: f.taskId, node: f.node(), esc: e });
  const n = f.node();
  eq(n.model_tier, 'heavy', '节点档位改成 heavy（下次重试沿用）');
  assert(n.tier_escalated_at > 0, 'tier_escalated_at 记下');
  const a = JSON.parse(f.db.one(`SELECT payload FROM audit_log WHERE action='node_escalated' AND target_id=?`, f.nodeId).payload);
  eq(`${a.from}->${a.to}`, 'standard->heavy', '审计 node_escalated 记 from/to');

  // 编排器：重试 2 的节点开跑时用 heavy；--tier 覆盖时不升
  const TMP = mkdtempSync(join(tmpdir(), 'si-esc-'));
  // 每次 orchestrate 用一个新工作区：上一跑提交过的 out.txt 会让下一跑的 write_file 变成"相对基线没改动"
  const mkWs = (name) => {
    const ws = join(TMP, name); mkdirSync(ws);
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, stdio: 'ignore' });
    g('init', '-q'); writeFileSync(join(ws, 'README.md'), 'x\n'); g('add', '-A'); g('commit', '-q', '-m', 'init');
    return ws;
  };
  const script = () => makeFake([
    { stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'tool_call', id: 'c1', name: 'write_file', args: { path: 'out.txt', content: 'x' } }] },
    { stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'tool_call', id: 'c2', name: 'submit_handoff',
      args: { artifacts: [{ path: 'out.txt', kind: 'source' }], interface_contract: 'x', acceptance_evidence: 'y' } }] },
  ]);
  const g2 = fixture({ retry: 2 });
  const events = [];
  const r = await orchestrate(g2.db, { taskId: g2.taskId, workspace: mkWs('ws2'), narrativeDir: join(TMP, 'nar'), verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: script(), binding: BINDING }), onEvent: (e) => events.push(e) });
  eq(r.kind, 'complete', '跑完');
  assert(events.some((e) => e.type === 'escalated' && e.to === 'heavy'), '编排器发出 escalated 事件');
  eq(events.find((e) => e.type === 'node_start')?.tier, 'heavy', '节点实际以 heavy 档开跑');
  eq(g2.db.one(`SELECT model_tier FROM nodes WHERE id=?`, g2.nodeId).model_tier, 'heavy', '库里档位是 heavy');

  const g3 = fixture({ retry: 2 });
  const ev3 = [];
  await orchestrate(g3.db, { taskId: g3.taskId, workspace: mkWs('ws3'), narrativeDir: join(TMP, 'nar3'), verify: false, tierOverride: 'light',
    makeClient: () => new LlmClient({ mode: 'fake', fake: script(), binding: BINDING }), onEvent: (e) => ev3.push(e) });
  assert(!ev3.some((e) => e.type === 'escalated') && ev3.find((e) => e.type === 'node_start')?.tier === 'light', '--tier 显式覆盖：不升档，按人说的档跑');

  // 闸门拦住 → 编排器走触顶路径：Ⅲ 级问题 + waiting，没有开跑
  const g4 = fixture({ retry: 2, budget: 300_000, spentNode: 280_000 });
  const ev4 = [];
  const r4 = await orchestrate(g4.db, { taskId: g4.taskId, workspace: mkWs('ws4'), narrativeDir: join(TMP, 'nar4'), verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: script(), binding: BINDING }), onEvent: (e) => ev4.push(e) });
  eq(r4.kind, 'limit_breached', '闸门拦住 → limit_breached 出口（问人，不赌）');
  assert(!ev4.some((e) => e.type === 'node_start'), '没有开跑');
  const q = g4.db.one(`SELECT * FROM questions WHERE task_id=?`, g4.taskId);
  assert(q && q.level === 3 && q.text.includes('升档前预算闸门'), 'Ⅲ 级问题正文说清是升档前闸门');
  eq(g4.db.one(`SELECT status FROM tasks WHERE id=?`, g4.taskId).status, 'waiting', '任务 waiting');
  f.db.close(); g2.db.close(); g3.db.close(); g4.db.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
