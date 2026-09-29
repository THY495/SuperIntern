// 出网连续被拒次数 → 触顶路径（gate）：计数**持久化于 params**、跨进程累计。
//
// 跑：node tests/egress-consecutive.test.mjs（末尾以子进程再跑 m4 回归）。
//
// 观测源：出口代理写的审计 JSONL（guard.py 每一条出网尝试落一行 allowed 真假）。
// 编排器每次体检前把自 params 游标起新增的行喂给计数（denied +1 / allowed 归零），
// 结果**写回 params**（键 egress.consecutive_denials，值 {offset,streak,hosts}）；
// LIMITS['limit.egress.consecutive_denials'].read 直读 params。撞上限走 gate 触顶
// 路径（limit_breached 审计 + 该维 advice + Ⅲ 级提问）。模块内不留任何计数状态。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LIMITS } from '../src/core/limits.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { advanceConsecutiveDenials, egressDenialStateOf } from '../src/core/egress.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const ROOT = resolve(import.meta.dirname, '..');
const TMP = mkdtempSync(join(tmpdir(), 'si-egcon-'));
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

// ── fixture（与 budget-audit.test.mjs 同款；dbPath 用于跨进程落盘）────────────────────
const SPEC = '在工作区新建 out.txt，内容为 ok。';
const ACC = '存在 out.txt 且内容为 ok。';
function fixture({ dbPath = ':memory:' } = {}) {
  const db = openDb(dbPath);
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), constId = newId('c'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'fixture','running',?)`,
    taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,
            valid_from,recorded_at) VALUES (?,?,1,'写个文件','只动工作区','out.txt 存在','[]',?,?)`,
    constId, taskId, t, t);
  const n = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,?,?,?,'pending','normal','standard',?)`, n, taskId, '节点 1', SPEC, ACC, t);
  return { db, taskId };
}
function makeWorkspace(name) {
  const ws = join(TMP, name);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'README.md'), '# fixture\n');
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 'test@local');
  git(ws, 'config', 'user.name', 'test');
  git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init');
  git(ws, 'checkout', '-q', '-b', 'v0/test');
  return ws;
}
const call = (name, args, usage = { inputTokens: 2000, outputTokens: 50 }) => ({
  stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${name}`, name, args }], usage,
});
const HANDOFF = {
  artifacts: [{ path: 'out.txt', kind: 'code' }],
  interface_contract: 'out.txt 里是 ok',
  acceptance_evidence: '跑了 cat out.txt，输出 ok',
};
class EgressScriptExecutor extends LocalExecutor {
  constructor(auditFile, events) { super(); this.egress = { auditFile }; this.events = events ?? []; this.i = 0; }
  async execute(cmd, workspace, limits = {}) {
    if (this.i < this.events.length) {
      const ev = this.events[this.i++];
      writeFileSync(this.egress.auditFile,
        `${JSON.stringify({ ts: Date.now() / 1000, phase: 'request', host: ev.host, allowed: ev.allowed })}\n`,
        { flag: 'a' });
    }
    return { code: 0, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false, durationMs: 1 };
  }
}
const deniedEv = () => ({ host: 'registry.npmjs.org', allowed: false });
const allowedEv = () => ({ host: 'registry.npmjs.org', allowed: true });
/** 脚本：evs.length 条 run_command（每条触发一次 execute → 追加一条观测）+ 写产物 + 交接。 */
const runN = (evs) => [
  ...evs.map((_, i) => call('run_command', { file: 'true', args: [`#${i}`] })),
  call('write_file', { path: 'out.txt', content: 'ok' }),
  call('submit_handoff', HANDOFF),
];

// ═══════════════════════════════════════════════════════════════════════════
section('1. 连续被拒达上限（默认 3）→ gate 触顶：审计 + advice + 提问分支，与预算同形');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId } = fixture();
  const ws = makeWorkspace('ws-trig');
  const auditFile = join(TMP, `egress-${taskId}.jsonl`);
  writeFileSync(auditFile, '');
  eq(LIMITS['limit.egress.consecutive_denials'].def, 3, '上限默认值来自 LIMITS 键（def=3），非代码字面量');
  const evs = [deniedEv(), deniedEv(), deniedEv()];
  const exec = new EgressScriptExecutor(auditFile, evs);
  const r = await orchestrate(db, {
    taskId, workspace: ws, exec,
    narrativeDir: join(TMP, 'nar-trig'), maxCycles: 3, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(runN(evs)),
      fakePricing: { input: 1, output: 1 } }),
  });
  eq(r.kind, 'limit_breached', '连续被拒达上限 → limit_breached（gate 触顶，不是硬失败）');
  eq(r.breach.key, 'limit.egress.consecutive_denials', '触顶维度是出网连续被拒次数');
  eq(r.breach.actual, 3, '实测连续被拒 3 次');
  const q = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  assert(q, '生成了 Ⅲ 级提问 —— 与预算触顶同一分支（raiseLimitQuestion）');
  eq(q.level, 3, '硬上限一律 Ⅲ 级');
  eq(q.level_source, 'hard_rule', '状态机定级，非模型自评');
  assert(q.text.includes(LIMITS['limit.egress.consecutive_denials'].advice.slice(0, 20)),
    '问题正文带上了该维度的专属 advice（提高上限通常不是对的答案）');
  assert(q.text.includes('registry.npmjs.org'), '问题正文含被拒目标集合摘要');
  const row = db.one(`SELECT payload FROM audit_log WHERE target_id=? AND action='limit_breached'`, taskId);
  assert(row, '写入了 limit_breached 审计事件（与 budget/runtime 同形）');
  const p = JSON.parse(row.payload);
  eq(p.key, 'limit.egress.consecutive_denials', '审计事件含维度名');
  assert('limit' in p && 'actual' in p && p.human, '审计事件含上限/实测/正文（与 budget/runtime 同形）');
  eq(p.questionId, r.questionId, '审计事件挂在提问上（gate 分支同形）');
  eq(p.on_hit, undefined, 'gate 类审计不带 hard_fail 类别标记 —— 没走硬失败那条路');
  eq(p.deniedHosts?.['registry.npmjs.org'], 3, '审计事件含被拒目标集合摘要（host × 次数）');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务冻结 waiting');
  // 计数持久化在 params；撞顶已报给人 → 持久化计数归零（游标保留）
  const st = egressDenialStateOf(db, taskId);
  eq(st.offset, 3, '游标持久化：已消费 3 行');
  eq(st.streak, 0, '撞顶报出后计数归零（游标保留）—— 复工不会把同一批旧事实再问一遍');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 连续语义：被拒 2 次 → 成功归零并写回 → 再被拒 2 次，不到 3，不触顶');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId } = fixture();
  const ws = makeWorkspace('ws-reset');
  const auditFile = join(TMP, `egress-${taskId}.jsonl`);
  writeFileSync(auditFile, '');
  const evs = [deniedEv(), deniedEv(), allowedEv(), deniedEv(), deniedEv()];
  const exec = new EgressScriptExecutor(auditFile, evs);
  const r = await orchestrate(db, {
    taskId, workspace: ws, exec,
    narrativeDir: join(TMP, 'nar-reset'), maxCycles: 3, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(runN(evs)),
      fakePricing: { input: 1, output: 1 } }),
  });
  eq(r.kind, 'complete', '成功出网把连续计数归零 → 2+2 到不了上限 3，任务正常完成');
  assert(!db.one(`SELECT id FROM questions WHERE task_id=? AND decision_type<>'signoff'`, taskId), '没有生成任何提问（签收事项除外）');
  const st = egressDenialStateOf(db, taskId);
  eq(st.streak, 2, '连续语义：成功那次断开后 2+2 → 持久化计数 = 2');
  eq(st.offset, 5, '游标推进到 5 行');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2b. 成功出网后归零已写回 params（验收 3）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId } = fixture();
  const ws = makeWorkspace('ws-zero');
  const auditFile = join(TMP, `egress-${taskId}.jsonl`);
  writeFileSync(auditFile, '');
  const evs = [deniedEv(), deniedEv(), allowedEv()];
  const exec = new EgressScriptExecutor(auditFile, evs);
  const r = await orchestrate(db, {
    taskId, workspace: ws, exec,
    narrativeDir: join(TMP, 'nar-zero'), maxCycles: 3, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(runN(evs)),
      fakePricing: { input: 1, output: 1 } }),
  });
  eq(r.kind, 'complete', '2 次被拒 + 1 次成功 → 归零，任务完成');
  const st = egressDenialStateOf(db, taskId);
  eq(st.streak, 0, '成功出网把持久化计数归零（已写回 params）');
  eq(st.offset, 3, '归零后游标仍在（不重数旧行）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 跨进程：params 里已有 N-1 次，全新 node 进程再被拒 1 次即触顶（验收 4）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const ws = makeWorkspace('ws-xproc');
  const dbPath = join(TMP, `xproc-${Date.now()}.db`);
  const auditFile = join(TMP, `xproc-${Date.now()}.jsonl`);
  const { db, taskId } = fixture({ dbPath });
  // 模拟「上一进程」：2 条被拒已发生、计数已持久化进 params（跨进程累计的中间态）。
  writeFileSync(auditFile, [1, 2].map(() => JSON.stringify(deniedEv())).join('\n') + '\n');
  advanceConsecutiveDenials(db, taskId, auditFile);
  eq(egressDenialStateOf(db, taskId).streak, 2, '（前置）params 里已有 N-1=2 次连续被拒');
  db.close();

  // 全新 node 进程（模块状态必然全新）：读同一 params，本次再被拒 1 次 → 触顶。
  const w = spawnSync(process.execPath, [join(ROOT, 'tests', '_egden_worker.mjs'), dbPath, auditFile, ws],
    { encoding: 'utf8' });
  eq(w.status, 0, `worker 正常退出（${String(w.stderr).trim().slice(0, 160)}）`);
  eq(String(w.stdout).trim(), 'limit_breached limit.egress.consecutive_denials',
    '新实例读同一 params 里的 2 次 → 再被拒 1 次即触顶（跨进程累计）');
  // 若把计数改回模块内变量 / 进程内存，新进程从 0 起算 → 本次 1 次到不了默认上限 3 →
  // 上面这条会打成 complete → 本用例失败。计数只在 params，才能跨进程续上。
  const db2 = openDb(dbPath);
  const st = egressDenialStateOf(db2, db2.one(`SELECT id FROM tasks ORDER BY created_at LIMIT 1`).id);
  eq(st.streak, 0, '触顶报出后持久化计数归零');
  db2.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. advance 无模块级状态：两次推进之间不传对象，计数与游标都在 params');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId } = fixture();
  const auditFile = join(TMP, 'unit.jsonl');
  writeFileSync(auditFile, '');
  advanceConsecutiveDenials(db, taskId, auditFile);                 // 第一次推进（无行）
  eq(egressDenialStateOf(db, taskId).streak, 0, '空文件推进后仍为 0');
  writeFileSync(auditFile, [deniedEv(), deniedEv()].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const s1 = advanceConsecutiveDenials(db, taskId, auditFile);      // 第二次推进
  eq(s1.streak, 2, '两条被拒 → 连续 2');
  eq(s1.offset, 2, '游标 = 2');
  writeFileSync(auditFile,
    readFileSync(auditFile, 'utf8') + JSON.stringify(allowedEv()) + '\n');
  const s2 = advanceConsecutiveDenials(db, taskId, auditFile);      // 第三次推进（模拟下一轮）
  eq(s2.streak, 0, '成功 → 归零');
  eq(s2.offset, 3, '游标推进到 3');
  const again = advanceConsecutiveDenials(db, taskId, auditFile);
  eq(again.streak, 0, '无新行 → 幂等，不再写回');
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'═'.repeat(72)}\n出网连续被拒计数测试：${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);

console.log('\n── 回归：node tests/budget-audit.test.mjs ──');
const m4 = spawnSync(process.execPath, [join(ROOT, 'tests', 'budget-audit.test.mjs')], { encoding: 'utf8' });
console.log(m4.stdout.slice(-1400));
if (m4.status !== 0) console.error(m4.stderr);
console.log(`m4 退出码：${m4.status}`);
process.exit(fail || m4.status ? 1 : 0);
