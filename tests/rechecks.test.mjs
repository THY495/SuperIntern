// 重查哨兵重查提醒：挂在运行期自检同一套机制上；条件成立写 recheck_due、消失写 recheck_cleared，只提醒一次；
// 健康卡显示，管理员「知道了」收起，条件消失再出现才重新提醒；不推通知。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { sweepInvariants, rechecksView, ackRecheck } from '../src/core/invariants.mjs';
import { RECHECKS, RECHECK_T } from '../src/core/rechecks.mjs';
import { deploymentHealth } from '../src/core/deploy-health.mjs';
import { saveModel } from '../src/llm/registry.mjs';
import { setSetting } from '../src/core/settings.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-b10-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const H = 3600_000;
const only = RECHECKS.map((c) => c.id);
const due = (db, id) => db.all(`SELECT action FROM audit_log WHERE target_id=? AND action IN ('recheck_due','recheck_cleared') ORDER BY id`, id).map((r) => r.action);
const view = (db, id) => rechecksView(db).find((r) => r.id === id) ?? null;

function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'任务甲','running',?)`, taskId, userId, t);
  const nodeId = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES (?,?,'大步骤','s','a','pending','normal','standard',?)`, nodeId, taskId, t);
  return { db, userId, taskId, nodeId };
}

section('1. 新部署：一条都不亮（默认绑定里没登记窗口的模型不报）');
{
  const { db } = fixture();
  const s = sweepInvariants(db, { force: true, only, home: TMP });
  eq(s.ran.length, RECHECKS.length, '五条都查了');
  eq(rechecksView(db).length, 0, '没有成立的');
  assert(!deploymentHealth(db, { home: TMP }).checks.some((c) => c.key === 'recheck'), '健康卡上没有这一项（只有出现时才列）');
}

section('2. 小窗口的模型：只提醒一次；知道了就收起；条件消失再出现才重新提醒');
{
  const { db, userId } = fixture();
  saveModel(db, { key: 'deepseek/deepseek-flash', fields: { contextWindow: 64_000 }, userId });
  let at = now();
  let s = sweepInvariants(db, { at, force: true, only, home: TMP });
  const t = s.transitions.find((x) => x.id === 'recheck_small_window');
  assert(t && t.advice && t.to === 'violated', '成立：一条转换，标明是提醒（守护进程据此不推通知）');
  const v = view(db, 'recheck_small_window');
  eq(v?.sample?.[0]?.window, 64_000, '记下窗口');
  assert(v?.sample?.[0]?.uses.includes('light') && v?.sample?.[0]?.uses.includes('standard'), `记下用在哪几档：${v?.sample?.[0]?.uses}`);
  eq(v?.sample?.[0]?.compactAt, Math.floor(64_000 * 0.75 * 0.8), '记下整理线被压到多少');
  sweepInvariants(db, { at: at + 2 * H, force: true, only, home: TMP });
  eq(due(db, 'recheck_small_window'), ['recheck_due'], '还成立：不再写第二条（只提醒一次）');
  let hc = deploymentHealth(db, { home: TMP }).checks.find((c) => c.key === 'recheck');
  eq(hc?.level, 'warn', '健康卡：没点过「知道了」= 注意');
  ackRecheck(db, { id: 'recheck_small_window', userId });
  hc = deploymentHealth(db, { home: TMP }).checks.find((c) => c.key === 'recheck');
  eq(hc?.level, 'ok', '知道了：收起，不再算要注意');
  assert(hc?.rows?.[0]?.acked?.by === userId, '记下谁点的');
  // 换掉小窗口模型 → 消失
  saveModel(db, { key: 'deepseek/deepseek-flash', fields: { contextWindow: 1_000_000 }, userId });
  sweepInvariants(db, { at: at + 4 * H, force: true, only, home: TMP });
  eq(due(db, 'recheck_small_window'), ['recheck_due', 'recheck_cleared'], '条件消失：写 recheck_cleared');
  eq(view(db, 'recheck_small_window'), null, '健康卡上不再列');
  // 再出现 → 重新提醒（以前点过的「知道了」不算数）
  saveModel(db, { key: 'deepseek/deepseek-flash', fields: { contextWindow: 100_000 }, userId });
  sweepInvariants(db, { at: at + 6 * H, force: true, only, home: TMP });
  eq(due(db, 'recheck_small_window'), ['recheck_due', 'recheck_cleared', 'recheck_due'], '再出现：重新写 recheck_due');
  eq(view(db, 'recheck_small_window')?.acked, null, '以前的「知道了」不作数，重新提醒');
}

section('3. 同一步骤反复撞整理线');
{
  const { db, nodeId } = fixture();
  for (let i = 0; i < RECHECK_T.compactionsPerStep - 1; i++) audit(db, { actorKind: 'system', action: 'context_compacted', targetType: 'node', targetId: nodeId, payload: { level: 1 } });
  sweepInvariants(db, { force: true, only, home: TMP });
  eq(view(db, 'recheck_compaction'), null, `${RECHECK_T.compactionsPerStep - 1} 次：不报`);
  audit(db, { actorKind: 'system', action: 'context_compacted', targetType: 'node', targetId: nodeId, payload: { level: 2 } });
  sweepInvariants(db, { at: now() + H, force: true, only, home: TMP });
  const v = view(db, 'recheck_compaction');
  eq([v?.sample?.[0]?.ref, v?.sample?.[0]?.n, v?.sample?.[0]?.title], [nodeId, RECHECK_T.compactionsPerStep, '大步骤'], '够次数：报出是哪一步、整理了几次');
  const { db: db2, nodeId: n2 } = fixture();
  audit(db2, { actorKind: 'system', action: 'compaction_escalated', targetType: 'node', targetId: n2, payload: {} });
  sweepInvariants(db2, { force: true, only, home: TMP });
  eq(view(db2, 'recheck_compaction')?.sample?.[0]?.escalated, 1, '整理到顶转过人：一次就报');
}

section('4. 写入竞争（各进程的库计数）');
{
  const { db } = fixture();
  const home = join(TMP, 'home-c'); mkdirSync(join(home, 'metrics'), { recursive: true });
  writeFileSync(join(home, 'metrics', 'db-web-1.json'), JSON.stringify({ busy: 1, lock: { maxMs: 200 } }));
  sweepInvariants(db, { force: true, only, home });
  eq(view(db, 'recheck_contention'), null, '偶尔一次：不报');
  writeFileSync(join(home, 'metrics', 'db-daemon-2.json'), JSON.stringify({ busy: 2, lock: { maxMs: 6_000 } }));
  writeFileSync(join(home, 'metrics', 'db-x-3.json'), '{"busy": 写到一半');
  sweepInvariants(db, { at: now() + H, force: true, only, home });
  eq(view(db, 'recheck_contention')?.sample?.[0], { ref: 'db', busy: 3, maxWaitMs: 6_000 }, '累计 3 次 / 最长 6 秒：报出（写到一半的文件跳过）');
}

section('5. 原有测试被改弱：攒够了样本才报；已经设成打回的不报');
{
  const { db, nodeId, userId } = fixture();
  const changes = (k) => ({ changes: [{ path: `t${k}.test.js`, baseline: true, findings: [{ kind: 'skip_added' }] }, { path: 'own.test.js', baseline: false, findings: [{ kind: 'skip_added' }] }, { path: `ok${k}.test.js`, baseline: true, allowed: true, findings: [{ kind: 'skip_added' }] }] });
  for (let k = 0; k < RECHECK_T.weakenedTests - 1; k++) audit(db, { actorKind: 'system', action: 'handoff_test_changes', targetType: 'node', targetId: nodeId, payload: changes(k) });
  sweepInvariants(db, { force: true, only, home: TMP });
  eq(view(db, 'recheck_weakened_tests'), null, '本任务写的、人放行过的都不算；不够数不报');
  audit(db, { actorKind: 'system', action: 'handoff_test_changes', targetType: 'node', targetId: nodeId, payload: changes(9) });
  sweepInvariants(db, { at: now() + 7 * H, force: true, only, home: TMP });
  eq(view(db, 'recheck_weakened_tests')?.sample?.[0], { ref: 'tests', n: RECHECK_T.weakenedTests, tasks: 1 }, '够数：报出次数与涉及几个任务');
  setSetting(db, { key: 'deploy.test_guard', value: 'reject', userId });
  sweepInvariants(db, { at: now() + 14 * H, force: true, only, home: TMP });
  eq(view(db, 'recheck_weakened_tests'), null, '已经设成直接打回：不再建议');
}

section('5b. 状态库变大：库文件或审计行数越过阈值才报');
{
  const saved = { ...RECHECK_T };
  try {
    const { db } = fixture();
    sweepInvariants(db, { force: true, only, home: TMP });
    eq(view(db, 'recheck_db_size'), null, '小库：不报');
    RECHECK_T.auditRows = db.one(`SELECT max(id) n FROM audit_log`).n + 1;
    for (let k = 0; k < 3; k++) audit(db, { actorKind: 'system', action: 'noise', payload: {} });
    sweepInvariants(db, { at: now() + 7 * H, force: true, only, home: TMP });
    assert(view(db, 'recheck_db_size')?.sample?.[0]?.auditRows >= RECHECK_T.auditRows, '审计行数越线：报出（带行数）');
    // 库文件大小：内存库量不到，换文件库
    Object.assign(RECHECK_T, saved);
    const fdb = openDb(join(TMP, 'size.db'));
    ensureOwner(fdb);
    sweepInvariants(fdb, { force: true, only, home: TMP });
    eq(view(fdb, 'recheck_db_size'), null, '文件库没越线：不报');
    RECHECK_T.dbBytes = 1024;
    sweepInvariants(fdb, { at: now() + 7 * H, force: true, only, home: TMP });
    assert(view(fdb, 'recheck_db_size')?.sample?.[0]?.bytes > 1024, '库文件越线：报出（带大小）');
    fdb.close();
  } finally { Object.assign(RECHECK_T, saved); }
}

section('6. 与不变量分开：不进「运行期自检」，不推通知');
{
  const { db, userId } = fixture();
  saveModel(db, { key: 'deepseek/deepseek-flash', fields: { contextWindow: 64_000 }, userId });
  sweepInvariants(db, { force: true, home: TMP });
  const h = deploymentHealth(db, { home: TMP });
  const inv = h.checks.find((c) => c.key === 'invariants');
  assert(!inv.rows.some((r) => String(r.id).startsWith('recheck_')), '「运行期自检」里不列提醒（那里不成立 = 系统缺陷）');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='invariant_violated'`).n, 0, '不写 invariant_violated');
  let threw = false; try { ackRecheck(db, { id: 'liveness', userId }); } catch { threw = true; }
  assert(threw, '「知道了」只认提醒，不能拿来压掉不变量');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
