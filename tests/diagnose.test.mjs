// 诊断层与收敛判据
//
// 跑：node tests/diagnose.test.mjs
//
//   ① 判据本身（纯函数）：第一次 / 收敛 / 停滞（连续几轮上一轮的缺陷全在、清单没变短）/ 反复（改好的又回来）/ 环境问题 / 通过；
//      门槛 STALL_ROUNDS、OSC_RETURNS 处才转人；环境那几轮不进判断；
//   ② "同一条缺陷"：类别 + 位置；没位置看一句话；旧审计行（只有文字）也能还原；
//   ③ 机械校验在源头给结构化缺陷（类别 + 路径），验收员按 defects 交、旧格式照收、没结论 = 环境问题；
//   ④ 接进执行器：每次打回写 node_diagnosed；停滞到门槛替执行器把问题提给人（附还剩的缺陷）；收敛的不转人；
//      验收员没给结论 → 不算一轮缺陷，那次停滞不计重试；
//   ⑤ 单步骤重试撞顶的事项里附诊断；任务详情给每个被打回过的步骤带上诊断；
//   ⑥ 被计划变更改了规格 → 从那之后重新数。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit, insertEdge } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { verifyHandoff } from '../src/agent/verifier.mjs';
import { executeNode, validateHandoffDetailed, validateHandoff } from '../src/agent/executor.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { diagnose, sameDefect, defectsFromErrs, roundsOf, nodeDiagnosis, describeDiagnosis, STALL_ROUNDS, OSC_RETURNS } from '../src/core/diagnose.mjs';
import { raiseLimitQuestion } from '../src/core/limits.mjs';
import { taskDetail } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-diag-'));
const WS = join(TMP, 'ws'); mkdirSync(WS, { recursive: true });
writeFileSync(join(WS, 'export.mjs'), 'export const toCsv = (rows) => rows.map((r) => r.join(",")).join("\\n");\n');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const D = (category, location, summary = `${category} 的问题 ${location}`) => ({ category, summary, locations: location ? [location] : [] });
const R = (kind, ...defects) => ({ kind, defects });

section('① 判据：第一次 / 收敛 / 停滞 / 反复 / 环境 / 通过');
{
  eq(diagnose([]).state, 'none', '还没交过');
  eq(diagnose([R('pass')]).state, 'passed', '一次就过');
  eq(diagnose([R('verifier', D('acceptance', 'a.mjs'), D('test', 'a.test.mjs'))]).state, 'first', '第一次被打回');
  let d = diagnose([R('verifier', D('acceptance', 'a.mjs'), D('test', 'a.test.mjs')), R('verifier', D('test', 'a.test.mjs'))]);
  eq([d.state, d.resolved, d.added, d.open.length, d.escalate], ['converging', 1, 0, 1, false], '收敛：解决 1 条、没新冒、还剩 1 条');
  d = diagnose([R('verifier', D('acceptance', 'a.mjs')), R('verifier', D('test', 'b.test.mjs'))]);
  eq(d.state, 'converging', '缺陷换了一条（旧的解决了）= 收敛，不是停滞');

  const same = () => R('verifier', D('acceptance', 'a.mjs'));
  const seq = (n) => Array.from({ length: n }, same);
  eq([diagnose(seq(2)).state, diagnose(seq(2)).streak], ['stalled', 1], '同一条缺陷连续两轮：停滞 1 轮');
  eq(diagnose(seq(STALL_ROUNDS)).escalate, false, `停滞 ${STALL_ROUNDS - 1} 轮：还不转人`);
  d = diagnose(seq(STALL_ROUNDS + 1));
  eq([d.state, d.streak, d.escalate], ['stalled', STALL_ROUNDS, true], `停滞 ${STALL_ROUNDS} 轮：转人`);
  d = diagnose([...seq(STALL_ROUNDS), R('verifier', D('acceptance', 'a.mjs')), R('verifier', D('test', 'z.mjs'))]);
  eq([d.state, d.escalate], ['converging', false], '停滞之后改好了：回到收敛，不转人');
  d = diagnose([R('mech', D('scope', 'x/a')), R('mech', D('scope', 'x/a'), D('field', 'interface_contract'))]);
  eq(d.state, 'stalled', '旧缺陷全在、还多了一条：也是停滞（清单没变短）');

  // 反复：a → b → a → b → a
  const A = () => R('verifier', D('spec', 'a.mjs')), B = () => R('verifier', D('test', 'b.mjs'));
  d = diagnose([A(), B(), A()]);
  eq([d.state, d.returns, d.escalate], ['oscillating', 1, false], '改好的又回来 1 次：反复，还不转人');
  d = diagnose([A(), B(), A(), B()]);
  eq([d.state, d.returns, d.escalate], ['oscillating', OSC_RETURNS, true], `又回来 ${OSC_RETURNS} 次：转人`);

  // 只拿同一个检查方的相邻两轮比：机械校验打回那次验收员没跑，验收员那几条"没出现"是没查
  d = diagnose([A(), R('mech', D('scope', 'x/a')), A()]);
  eq([d.state, d.returns, d.streak], ['stalled', 0, 1], '验收员 A → 机械打回 → 验收员 A：是停滞，不是复发');
  d = diagnose([A(), R('mech', D('scope', 'x/a'))]);
  eq([d.state, d.resolved, d.added], ['converging', null, null], '验收员 → 机械：验收员那几条这次没查，说不出改掉几条');
  d = diagnose([R('mech', D('scope', 'x/a')), A()]);
  eq([d.state, d.resolved, d.added], ['converging', 1, 1], '机械 → 验收员：机械那条过了（算改掉），验收员的算新冒出');

  // 环境：不进判断
  d = diagnose([same(), R('env', D('environment', null, '验收员没给出结论')), same()]);
  eq([d.state, d.streak, d.rejections], ['stalled', 1, 2], '中间夹一轮环境问题：不算一轮缺陷，前后照常比');
  d = diagnose([same(), R('env', D('environment', null, '验收员没给出结论'))]);
  eq(d.state, 'environment', '最近一轮是环境问题 → 判"环境问题"');
  assert(/环境问题/.test(describeDiagnosis(d, 'zh')) && /不计入停滞与重试/.test(describeDiagnosis(d, 'zh')), '给人看的一句话说清不计入停滞与重试');
  assert(/Stalled|stalled/i.test(describeDiagnosis(diagnose(seq(3)), 'en')), '英文内容语言下判词是英文', describeDiagnosis(diagnose(seq(3)), 'en'));
}

section('② 同一条缺陷');
{
  assert(sameDefect(D('acceptance', 'src/a.mjs:12'), D('acceptance', './src/a.mjs:40')), '同类别、同文件（行号不同）= 同一条');
  assert(!sameDefect(D('acceptance', 'src/a.mjs'), D('test', 'src/a.mjs')), '同文件不同类别 = 不同的缺陷');
  assert(sameDefect(D('quality', 'src/a.mjs'), D('spec', 'src/a.mjs')), '"其他问题"不挡类别（旧格式都记 quality）');
  assert(sameDefect({ category: 'acceptance', summary: 'toCsv 没有处理字段里的逗号，要加引号', locations: [] },
    { category: 'acceptance', summary: 'toCsv 还是没有处理字段里的逗号，要加引号转义', locations: [] }), '都没位置：一句话像就算同一条');
  assert(!sameDefect({ category: 'acceptance', summary: 'toCsv 没有处理字段里的逗号', locations: [] },
    { category: 'acceptance', summary: 'README 缺少用法示例', locations: [] }), '一句话不像 = 不同');
  const legacy = defectsFromErrs(['越界改动：`seed.py`、`x/y.sh` 不在宪法块 scope 划定的范围（api/）里 —— 撤销', '[验收员] contracts/openapi.yaml:333 adds a constraint', '[验收员] 假设 cli.show：不该自己定'], 'verifier');
  eq(legacy.map((x) => x.category), ['scope', 'quality', 'assumption'], '旧审计行按文字还原类别');
  eq(legacy[0].locations, ['seed.py', 'x/y.sh'], '旧审计行：反引号里的路径当位置');
  eq(legacy[1].locations, ['contracts/openapi.yaml'], '旧审计行：文件:行 当位置');
}

section('③ 结构化缺陷的来源');
{
  const ctx = { exec: new LocalExecutor(), workspace: WS, changed: new Set(['export.mjs', 'seed.py']), scopePrefixes: ['src'], scopeFiles: ['export.mjs'], scopeStructured: true };
  const args = { artifacts: [{ path: 'export.mjs' }], interface_contract: '', acceptance_evidence: 'ok', key_decisions: [], assumptions: [] };
  const r = validateHandoffDetailed(args, ctx);
  eq(r.errs, validateHandoff(args, ctx), 'validateHandoff 仍只返回文字，与详细版一致');
  eq(r.defects.map((x) => [x.category, x.locations]), [['scope', ['seed.py']], ['field', ['interface_contract']]], '机械校验：越界给路径、缺项给字段名');

  const { db, taskId, nodeId } = fixture();
  const call = (name, a) => ({ stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'tool_call', id: `c_${Math.random().toString(36).slice(2, 8)}`, name, args: a }] });
  let v = await verifyHandoff(db, { client: new LlmClient({ mode: 'fake', fake: makeFake([call('submit_verdict', { verdict: 'reject', evidence_checked: ['export.mjs'],
    defects: [{ category: 'acceptance', summary: '字段里的逗号没转义', location: 'export.mjs:1' }, { category: 'nonsense', summary: '类别乱填的' }] })]) }),
  taskId, nodeId, workspace: WS, exec: new LocalExecutor(), args: handoffArgs() });
  eq(v.defects.map((x) => x.category), ['acceptance', 'quality'], '验收员按 defects 交；类别不认识的记 quality');
  assert(v.reasons[0].includes('export.mjs:1') && v.noVerdict === false, '理由文字带上位置；有结论');
  v = await verifyHandoff(db, { client: new LlmClient({ mode: 'fake', fake: makeFake([call('submit_verdict', { verdict: 'reject', evidence_checked: [], reasons: ['旧格式的一条理由'] })]) }),
    taskId, nodeId, workspace: WS, exec: new LocalExecutor(), args: handoffArgs() });
  eq([v.defects.length, v.defects[0].category, v.reasons[0]], [1, 'quality', '旧格式的一条理由'], '旧格式（只给 reasons）照收');
  const silent = { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'text', text: '我想想' }] };
  v = await verifyHandoff(db, { client: new LlmClient({ mode: 'fake', fake: makeFake(Array(12).fill(silent)) }), taskId, nodeId, workspace: WS, exec: new LocalExecutor(), args: handoffArgs() });
  eq([v.verdict, v.noVerdict], ['reject', true], '没给结论：照样不放行，但标 noVerdict（环境问题）');
  db.close();
}

function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'CSV 导出','src/','toCsv 可用','[]',?,?)`, newId('c'), taskId, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写 toCsv','导出 toCsv(rows)','export.mjs 导出 toCsv','pending','normal','standard',?)`, nodeId, taskId, t);
  return { db, taskId, nodeId, userId };
}
function handoffArgs() {
  return { artifacts: [{ path: 'export.mjs', kind: 'source' }], interface_contract: 'toCsv(rows) -> string', acceptance_evidence: 'node -e 通过',
    key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] };
}
const handoff = () => ({ stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'tool_call', id: `c_${Math.random().toString(36).slice(2, 8)}`, name: 'submit_handoff', args: handoffArgs() }] });
const run = (db, taskId, nodeId, verifier, n, maxIterations = n + 1) => executeNode(db, { client: new LlmClient({ mode: 'fake', fake: makeFake(Array(n).fill(0).map(handoff)) }),
  taskId, nodeId, workspace: WS, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, 'nar'), exec: new LocalExecutor(), verifier, maxIterations });

section('④ 接进执行器');
{
  // 停滞：验收员每次都打回同一条 → 第 STALL_ROUNDS+1 次打回时转人
  const { db, taskId, nodeId } = fixture();
  let calls = 0;
  const stuckVerifier = async () => { calls++; return { verdict: 'reject', reasons: ['逗号没转义（export.mjs）'], defects: [{ category: 'acceptance', summary: '逗号没转义', locations: ['export.mjs'] }], pushbacks: [], noVerdict: false }; };
  const r = await run(db, taskId, nodeId, stuckVerifier, 8);
  eq([r.kind, calls], ['question', STALL_ROUNDS + 1], `连续打回同一条：第 ${STALL_ROUNDS + 1} 次打回时转成事项，不再耗到迭代上限`);
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, nodeId).status, 'blocked', '节点挂起等人');
  const q = db.one(`SELECT q.text, b.blocked_by FROM questions q LEFT JOIN briefings b ON b.question_id=q.id WHERE q.task_id=? ORDER BY q.asked_at DESC LIMIT 1`, taskId);
  assert(/没有在收敛/.test(q.text) && /停滞/.test(q.text), '事项正文：没有在收敛 + 判词', q.text);
  assert(/逗号没转义/.test(q.blocked_by ?? '') && /验收标准未满足/.test(q.blocked_by ?? ''), '卡在哪：列出还剩的缺陷（带类别）', q.blocked_by);
  const diags = db.all(`SELECT payload FROM audit_log WHERE action='node_diagnosed' AND target_id=? ORDER BY id`, nodeId).map((x) => JSON.parse(x.payload));
  eq(diags.map((x) => x.state), ['first', 'stalled', 'stalled', 'stalled'], '每次打回写一条 node_diagnosed');
  eq(diags.at(-1).escalate, true, '最后一条标了转人');
  const rej = JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='handoff_rejected' AND target_id=? ORDER BY id LIMIT 1`, nodeId).payload);
  eq(rej.defects?.[0]?.category, 'acceptance', 'handoff_rejected 审计里带结构化缺陷');
  db.close();
}
{
  // 收敛：每次打回的缺陷都不一样（上一条修好了）→ 不转人，最后过了
  const { db, taskId, nodeId } = fixture();
  let i = 0;
  const verifier = async () => (++i <= 4 ? { verdict: 'reject', reasons: [`第 ${i} 处问题`], defects: [{ category: 'acceptance', summary: `第 ${i} 处问题`, locations: [`f${i}.mjs`] }], pushbacks: [], noVerdict: false }
    : { verdict: 'accept', reasons: [], defects: [], pushbacks: [], noVerdict: false });
  const r = await run(db, taskId, nodeId, verifier, 6);
  eq(r.kind, 'done', '缺陷一直在换（在收敛）：打回 4 次也不转人，第 5 次过了');
  eq(nodeDiagnosis(db, nodeId).state, 'passed', '诊断：已通过');
  db.close();
}
{
  // 环境：验收员一直没结论 → 每轮都是环境问题；迭代用完的那次停滞不计重试
  const { db, taskId, nodeId } = fixture();
  const verifier = async () => ({ verdict: 'reject', reasons: ['验收员没有给出结论'], defects: [], pushbacks: [], noVerdict: true, stopped: 'max_iterations' });
  const r = await run(db, taskId, nodeId, verifier, 3, 3);
  eq(r.kind, 'stalled', '一直没结论：执行器把迭代用完');
  eq(db.one(`SELECT retry_count FROM nodes WHERE id=?`, nodeId).retry_count, 0, '环境问题那次停滞：不计重试');
  const st = JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='node_stalled' AND target_id=?`, nodeId).payload);
  eq(st.environment, true, 'node_stalled 审计标明 environment');
  eq(nodeDiagnosis(db, nodeId).state, 'environment', '诊断：环境问题');
  const rej = db.all(`SELECT payload FROM audit_log WHERE action='handoff_rejected' AND target_id=?`, nodeId).map((x) => JSON.parse(x.payload));
  assert(rej.length === 3 && rej.every((x) => x.env === true), '三次都记成环境问题（env: true）');
  db.close();
}
{
  // 对照：真打回 + 迭代用完 → 照常计重试
  const { db, taskId, nodeId } = fixture();
  let i = 0;
  const verifier = async () => ({ verdict: 'reject', reasons: [`问题 ${++i}`], defects: [{ category: 'acceptance', summary: `问题 ${i}`, locations: [`g${i}.mjs`] }], pushbacks: [], noVerdict: false });
  await run(db, taskId, nodeId, verifier, 2, 2);
  eq(db.one(`SELECT retry_count FROM nodes WHERE id=?`, nodeId).retry_count, 1, '对照：真缺陷的停滞照常计一次重试');
  db.close();
}

section('⑤ 上限事项与任务详情');
{
  const { db, taskId, nodeId } = fixture();
  for (let i = 0; i < 3; i++) {
    audit(db, { actorKind: 'agent', actorId: 'verifier', action: 'handoff_rejected', targetType: 'node', targetId: nodeId,
      payload: { errs: ['[验收员] 逗号没转义'], defects: [{ category: 'acceptance', summary: '逗号没转义', locations: ['export.mjs'] }], by: 'verifier' } });
    if (i === 0) audit(db, { actorKind: 'agent', actorId: 'executor', action: 'node_stalled', targetType: 'node', targetId: nodeId, payload: {} });
  }
  db.run(`UPDATE nodes SET retry_count=3 WHERE id=?`, nodeId);
  const q = raiseLimitQuestion(db, { taskId, nodeId: null, breach: { key: 'limit.node_retries', limit: 3, actual: 3, human: '单步骤重试次数已达上限：当前 3，上限 3' } });
  assert(/\*\*诊断\*\*：停滞/.test(q.text) && /逗号没转义/.test(q.text), '单步骤重试撞顶：事项里附诊断与还剩的缺陷（没给步骤时取重试最多的那一步）', q.text);
  const d = taskDetail(db, taskId).nodes.find((n) => n.id === nodeId).diagnosis;
  eq([d.state, d.rejections, d.streak, d.cols.length, d.stallAt], ['stalled', 3, 2, 3, STALL_ROUNDS], '任务详情：被打回过的步骤带上诊断（结构，不带文字）');
  eq(d.rows.map((w) => [w.summary, w.cells, w.open]), [['逗号没转义', [true, true, true], true]], '格子图：同一条缺陷三次交都在 → 一行三格');
  eq(d.cols.map((c) => c.restart), [false, true, false], '格子图：第 1、2 次交之间从头重来过一次');
  db.close();
}
{
  const { db, taskId, nodeId } = fixture();
  const A = { category: 'acceptance', summary: '逗号没转义', locations: ['export.mjs'] }, B = { category: 'test', summary: '测试抄了实现', locations: ['test.mjs'] };
  for (const ds of [[A], [B], [A]]) audit(db, { actorKind: 'agent', actorId: 'verifier', action: 'handoff_rejected', targetType: 'node', targetId: nodeId,
    payload: { errs: ds.map((x) => x.summary), defects: ds, by: 'verifier' } });
  const d = taskDetail(db, taskId).nodes.find((n) => n.id === nodeId).diagnosis;
  eq(d.rows.map((w) => [w.summary, w.cells, w.open]), [['逗号没转义', [true, false, true], true], ['测试抄了实现', [false, true, false], false]],
    '格子图：改好又回来的缺陷留在原行、中间空一格；改掉的那条不算还剩');
  db.close();
}
{
  const { db, taskId, nodeId } = fixture();
  const A = { category: 'acceptance', summary: '逗号没转义', locations: ['export.mjs'] }, S = { category: 'scope', summary: '越界改动', locations: ['x/a.mjs'] };
  audit(db, { actorKind: 'agent', actorId: 'verifier', action: 'handoff_rejected', targetType: 'node', targetId: nodeId, payload: { errs: ['x'], defects: [A], by: 'verifier' } });
  audit(db, { actorKind: 'agent', actorId: 'executor', action: 'handoff_rejected', targetType: 'node', targetId: nodeId, payload: { errs: ['越界改动'], defects: [S] } });
  const d = taskDetail(db, taskId).nodes.find((n) => n.id === nodeId).diagnosis;
  eq(d.rows.map((w) => [w.summary, w.cells, w.now]), [['逗号没转义', [true, null], 'unknown'], ['越界改动', [false, true], 'open']],
    '格子图：系统检查打回那次 AI 验收没跑 → 验收员那条记"没查"、最近一次"这次没查"；系统检查那条在验收员那次确实没有');
  db.close();
}

section('⑥ 改了规格从头数');
{
  const { db, nodeId } = fixture();
  for (let i = 0; i < 3; i++) audit(db, { actorKind: 'agent', actorId: 'verifier', action: 'handoff_rejected', targetType: 'node', targetId: nodeId,
    payload: { errs: ['x'], defects: [{ category: 'acceptance', summary: 'x', locations: ['a.mjs'] }], by: 'verifier' } });
  eq(roundsOf(db, nodeId).length, 3, '改规格之前：3 轮');
  await new Promise((res) => setTimeout(res, 5));
  insertEdge(db, nodeId, newId('m'), 'derived_from', now());
  eq([roundsOf(db, nodeId).length, nodeDiagnosis(db, nodeId).state], [0, 'none'], '计划变更改了规格（新的出处边）之后：从头数');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
