// 耗时埋点：
//   ① 账本每行有开始时刻、耗时（含重试与退避等待）、尝试次数；
//   ② 每次工具调用一行 tool_calls（第几轮、什么工具、命令类别、耗时、退出码、成没成）；
//   ③ 环境准备每条命令、任务级验收命令带耗时；
//   ④ 验收记录带这次验收的模型时间与工具时间。
//
// 跑：node tests/timing.test.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient, runToolLoop, commandCategory } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { TIER_BINDING } from '../src/llm/canonical.mjs';
import { flushLedger } from '../src/core/ledger.mjs';
import { runSetupCommands } from '../src/core/project-settings.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { verifyHandoff } from '../src/agent/verifier.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-timing-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'计时','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'g','全仓库','d','[]',?,?)`, newId('c'), taskId, t, t);
  const nodeId = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES (?,?,'s','s','a','running','normal','standard',?)`, nodeId, taskId, t);
  return { db, taskId, nodeId };
}
const toolCall = (id, name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id, name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
const textReply = (text) => ({ stopReason: 'end', content: [{ type: 'text', text }], usage: { inputTokens: 10, outputTokens: 5 } });

section('① 命令类别');
{
  const cases = [
    [{ file: 'npm', args: ['ci'] }, 'install'], [{ file: 'pip', args: ['install', '-r', 'requirements.txt'] }, 'install'],
    [{ file: '.venv/bin/python', args: ['-m', 'pip', 'install', 'x'] }, 'install'], [{ file: 'uv', args: ['sync'] }, 'install'],
    [{ file: 'npm', args: ['test'] }, 'test'], [{ file: 'npm', args: ['run', 'test'] }, 'test'], [{ file: 'pytest', args: ['-q'] }, 'test'],
    [{ file: 'python', args: ['-m', 'pytest'] }, 'test'], [{ file: 'node', args: ['--test', 'tests/'] }, 'test'], [{ file: 'node', args: ['verify.mjs'] }, 'test'],
    [{ file: 'npm', args: ['run', 'build'] }, 'build'], [{ file: 'npx', args: ['vite', 'build'] }, 'build'],
    [{ file: 'git', args: ['status'] }, 'git'], [{ file: 'C:\\Program Files\\Git\\bin\\git.exe', args: ['diff'] }, 'git'],
    [{ file: 'ls', args: ['-la'] }, 'other'], [{ file: 'node', args: ['server.js'] }, 'other'], [null, 'other'],
  ];
  const wrong = cases.filter(([a, want]) => commandCategory(a) !== want).map(([a, want]) => `${JSON.stringify(a)} → ${commandCategory(a)}（应为 ${want}）`);
  eq(wrong, [], `${cases.length} 条命令分对类`);
}

section('② 工具循环：每次工具调用一行 tool_calls；账本带开始时刻与耗时');
{
  const { db, taskId, nodeId } = fixture();
  const fake = makeRoleFake({ executor: (canon, n) => (n === 0
    ? { stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'a', name: 'run_command', args: { file: 'npm', args: ['test'] } }, { type: 'tool_call', id: 'b', name: 'read_file', args: { path: 'x' } }], usage: { inputTokens: 10, outputTokens: 5 } }
    : n === 1 ? toolCall('c', 'grep', { pattern: 'x' }) : textReply('完')) });
  const client = new LlmClient({ mode: 'fake', fake });
  const t0 = Date.now();
  await runToolLoop(client, { role: 'executor', tier: 'standard', system: 's', tools: [{ name: 'run_command', parameters: {} }, { name: 'read_file', parameters: {} }, { name: 'grep', parameters: {} }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] }, {
    run_command: async () => { await new Promise((r) => setTimeout(r, 30)); return 'exit=1\n--- stdout ---\n1 failed'; },
    read_file: async () => 'hello',
    grep: async () => { throw new Error('普通报错'); },
  }, { maxIterations: 5 });
  flushLedger(db, client, { taskId, nodeId, role: 'executor' });
  const tc = db.all(`SELECT role, round, tool, category, started_at, duration_ms, exit_code, ok FROM tool_calls WHERE node_id=? ORDER BY round, tool DESC`, nodeId);   // 同一轮里并行，按做完的先后落 —— 比的时候不看顺序
  eq(tc.map((r) => [r.round, r.tool, r.category, r.exit_code, r.ok]), [[0, 'run_command', 'test', 1, 1], [0, 'read_file', null, null, 1], [1, 'grep', null, null, 0]],
    '每次一行：第几轮、工具、命令类别、退出码、成没成（抛错回给模型的算没成）');
  assert(tc[0].duration_ms >= 25 && tc[0].started_at >= t0 && tc.every((r) => r.role === 'executor'), `耗时与开始时刻（run_command ${tc[0].duration_ms} ms）`);
  const led = db.all(`SELECT started_at, duration_ms, attempts FROM usage_ledger WHERE node_id=? ORDER BY id`, nodeId);
  assert(led.length === 3 && led.every((r) => r.started_at >= t0 && r.duration_ms >= 0 && r.attempts === 1), `账本每行有开始时刻、耗时、尝试次数（${led.length} 行）`);
  eq(client.toolLog.length, 0, '落库后清空，下次不重复落');
}

section('③ 线上调用：耗时含重试，尝试次数如实');
{
  for (const k of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) process.env[k] ??= 'test-key-never-sent';
  const realFetch = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async () => {
    const status = [503, 200][i++] ?? 200;
    return { ok: status < 400, status, headers: { get: () => null }, json: async () => (status < 400
      ? { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
      : { error: { type: 'x', message: 'HTTP 503' } }) };
  };
  try {
    const client = new LlmClient({ mode: 'live', retryDelays: [0, 0, 0], binding: { ...TIER_BINDING, standard: 'anthropic/claude-sonnet-5' } });
    await client.complete({ tier: 'standard', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], maxTokens: 8 });
    const e = client.ledger.at(-1);
    assert(e.attempts === 2 && e.durationMs >= 0 && e.startedAt > 0, `503 之后成功：记 2 次尝试（${e.attempts}），耗时 ${e.durationMs} ms`);
  } finally { globalThis.fetch = realFetch; }
}

section('④ 环境准备每条命令带耗时');
{
  const dir = join(TMP, 'setup'); mkdirSync(dir, { recursive: true });
  const r = await runSetupCommands(new LocalExecutor(), dir, [[process.execPath, '-e', 'setTimeout(()=>{}, 50)'], [process.execPath, '-e', 'process.exit(0)']]);
  assert(r.ok && r.results.every((x) => Number.isFinite(x.elapsedMs)) && r.results[0].elapsedMs >= 40, `每条都有 elapsedMs（${r.results.map((x) => x.elapsedMs).join(' / ')} ms）`);
}

section('⑤ 验收记录带这次验收的模型时间与工具时间');
{
  const { db, taskId, nodeId } = fixture();
  const ws = join(TMP, 'ws'); mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'a.txt'), 'hello\n');
  spawnSync('git', ['init', '-q'], { cwd: ws }); spawnSync('git', ['-c', 'user.email=t@l', '-c', 'user.name=t', 'add', '-A'], { cwd: ws });
  spawnSync('git', ['-c', 'user.email=t@l', '-c', 'user.name=t', 'commit', '-q', '-m', 'i'], { cwd: ws });
  const fake = makeRoleFake({ verifier: (canon, n) => (n === 0 ? toolCall('v0', 'read_file', { path: 'a.txt' }) : toolCall('v1', 'submit_verdict', { verdict: 'accept', evidence_checked: ['a.txt'] })) });
  const client = new LlmClient({ mode: 'fake', fake });
  await verifyHandoff(db, { client, taskId, nodeId, workspace: ws, exec: new LocalExecutor(), args: { artifacts: [{ path: 'a.txt' }], interface_contract: '无', acceptance_evidence: '看过' } });
  const p = JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='handoff_verified' AND target_id=?`, nodeId).payload);
  assert(p.timing && Number.isFinite(p.timing.modelMs) && Number.isFinite(p.timing.toolMs) && p.timing.wallMs >= p.timing.toolMs, `timing：模型 ${p.timing?.modelMs} ms、工具 ${p.timing?.toolMs} ms、合计 ${p.timing?.wallMs} ms`);
  flushLedger(db, client, { taskId, nodeId, role: 'verifier' });
  assert(db.all(`SELECT role FROM tool_calls WHERE node_id=?`, nodeId).some((r) => r.role === 'verifier'), '验收员的工具调用也进 tool_calls（角色 verifier）');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
