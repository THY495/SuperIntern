// 节点产物基线落库（跨进程延续）
//
// 跑：node tests/baseline.test.mjs
//
// 曾出现过（复工时）：agent 挂起前自己 git commit 了工作，复工是新进程，
// 基线取"这一刻的 HEAD" = 那次提交 → 全部产物"相对基线没改动" → 交接被拒 →
// 它造了个 RESULTS.md 当产物混过校验。基线必须是**这一段工作的起点**，不是这段进程的起点。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { executeNode } from '../src/agent/executor.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { nodeBaseline, clearNodeBaseline, headOf } from '../src/core/workspace.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-base-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const WS = join(TMP, 'ws'); mkdirSync(WS);
const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: WS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
g('init', '-q'); writeFileSync(join(WS, 'README.md'), 'x\n'); g('add', '-A'); g('commit', '-q', '-m', 'init');
const BASE0 = headOf(WS);

function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'CSV 导出','.','toCsv 可用','[]',?,?)`, newId('c'), taskId, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写 toCsv','导出 toCsv(rows)','export.mjs 导出 toCsv','pending','normal','standard',?)`, nodeId, taskId, t);
  return { db, taskId, nodeId };
}
const call = (name, args) => ({ stopReason: 'tool_call', usage: { inputTokens: 10, outputTokens: 5 },
  content: [{ type: 'tool_call', id: `c_${Math.random().toString(36).slice(2, 8)}`, name, args }] });
const handoff = { artifacts: [{ path: 'export.mjs', kind: 'source' }], interface_contract: 'toCsv(rows)',
  acceptance_evidence: 'node -e 通过', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] };
const run = (db, taskId, nodeId, script) => executeNode(db, { client: new LlmClient({ mode: 'fake', fake: makeFake(script) }),
  taskId, nodeId, workspace: WS, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, 'nar'), exec: new LocalExecutor(), maxIterations: 6 });
const baseParam = (db, taskId, nodeId) => db.one(`SELECT value FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL`,
  taskId, `node.${nodeId}.base_ref`)?.value ?? null;

// ═══════════════════════════════════════════════════════════════════════════
section('1. 挂起前 agent 自己 commit 了，复工（新的 executeNode）仍按第一段的基线判产物');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId } = fixture();
  // 第一段：写文件 → 提问挂起
  const r1 = await run(db, taskId, nodeId, [
    call('write_file', { path: 'export.mjs', content: 'export const toCsv = (r) => r.join(",");\n' }),
    call('raise_question', { level: 2, text: '分隔符要不要可配？', blocked_by: '规格没说', work_done: '写了 export.mjs', plan_after_answer: '照答复改' }),
  ]);
  eq(r1.kind, 'question', '第一段以提问挂起');
  eq(JSON.parse(baseParam(db, taskId, nodeId)), BASE0, '基线落库 = 第一段开跑时的 HEAD');
  // agent 在挂起前把工作提交了
  g('add', '-A'); g('commit', '-q', '-m', 'agent: export.mjs');
  assert(headOf(WS) !== BASE0, 'HEAD 已经移动');

  // 第二段：新进程复工，直接交接。**没有落库基线的话这里会被拒**："相对基线没有任何改动"
  db.run(`UPDATE nodes SET status='pending' WHERE id=?`, nodeId);
  const r2 = await run(db, taskId, nodeId, [call('submit_handoff', handoff)]);
  eq(r2.kind, 'done', '复工后交接通过 —— 挂起前提交的产物仍算这一段的产物');
  eq(r2.rejections.length, 0, '零拒回（原来这里会拒"相对基线没有任何改动"）');
  eq(baseParam(db, taskId, nodeId), null, 'done 之后基线作废（下一段工作重取）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 基线语义：延续 / 作废 / 工作区重建后失效');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId } = fixture();
  const b1 = nodeBaseline(db, { taskId, nodeId, workspace: WS });
  eq(b1.resumed, false, '第一次：新取');
  eq(b1.base, headOf(WS), '取的是当前 HEAD');
  writeFileSync(join(WS, 'x.txt'), 'x'); g('add', '-A'); g('commit', '-q', '-m', 'move');
  const b2 = nodeBaseline(db, { taskId, nodeId, workspace: WS });
  eq(b2.resumed, true, '第二次：延续');
  eq(b2.base, b1.base, 'HEAD 动了，基线不动');
  clearNodeBaseline(db, { taskId, nodeId });
  const b3 = nodeBaseline(db, { taskId, nodeId, workspace: WS });
  eq(b3.resumed, false, '清掉之后重取');
  eq(b3.base, headOf(WS), '重取到新 HEAD');
  eq(db.one(`SELECT count(*) AS n FROM params WHERE task_id=? AND key=?`, taskId, `node.${nodeId}.base_ref`).n, 2, '历史行保留（supersede 不 delete）');
  // 记录的 sha 在库里不存在（工作区重建过）→ 当没记
  db.run(`UPDATE params SET value=? WHERE task_id=? AND key=? AND superseded_at IS NULL`, JSON.stringify('0'.repeat(40)), taskId, `node.${nodeId}.base_ref`);
  const b4 = nodeBaseline(db, { taskId, nodeId, workspace: WS });
  eq(b4.resumed, false, '记录的 sha 取不到 → 重取');
  eq(b4.base, headOf(WS), '重取到当前 HEAD');
  const row = db.one(`SELECT governance_class, set_by_kind FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL`, taskId, `node.${nodeId}.base_ref`);
  eq(`${row.governance_class}/${row.set_by_kind}`, 'execution/agent', '执行层参数，agent 写的（不是宪法层）');
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
