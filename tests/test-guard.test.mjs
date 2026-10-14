// 测试改动检测
//
// 跑：node tests/test-guard.test.mjs
//
//   ① 认测试文件；比对一份测试改动前后：删文件、加跳过 / 只跑、用例与断言变少、改期望值（JS / Python / Go）；
//      新建的测试不比；注释掉的断言算变少；没变不报；
//   ② 接进执行器：交接时比对这一步改过的测试，写审计 handoff_test_changes、交给验收员当证据，分清原有测试与本任务写的；
//      默认只标注（照常交上去）；部署设成 reject 时原有测试被改弱按机械校验打回（结构化缺陷，类别 test）；
//   ③ 验收员的提示词里有"测试改动"一节。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { executeNode } from '../src/agent/executor.mjs';
import { verifyHandoff } from '../src/agent/verifier.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { isTestPath, compareTest, describeTestChanges, testsAllowedFor, allowTestChanges } from '../src/core/test-guard.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const kinds = (f) => f.map((x) => x.kind);

const TMP = mkdtempSync(join(tmpdir(), 'si-tguard-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

section('① 认测试文件、比对一份改动');
{
  eq(['test/a.test.mjs', 'tests/test_x.py', 'pkg/x_test.go', 'src/__tests__/y.js', 'app/spec/z.rb', 'test_api.py', 'conftest.py', 'src/foo.mjs', 'src/contest.py', 'latest/x.js'].map(isTestPath),
    [true, true, true, true, true, true, true, false, false, false], '按目录（test/ tests/ __tests__/ spec/）与文件名约定认；src/foo、contest.py、latest/ 不算');

  const js = `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('a', () => { assert.equal(f(1), 1); });\ntest('b', () => { assert.equal(f('a,b'), '"a,b"'); });\n`;
  eq(compareTest(js, js, 'test/a.test.mjs'), [], '没变：不报');
  eq(compareTest(null, js, 'test/a.test.mjs'), [], '新建的测试文件：没有"原来"，不比');
  eq(kinds(compareTest(js, null, 'test/a.test.mjs')), ['deleted'], '删了测试文件');
  const exp = compareTest(js, js.replace(`'"a,b"'`, `'a,b'`), 'test/a.test.mjs');
  eq([kinds(exp), exp[0].total, exp[0].pairs[0].to.includes(`'a,b'`)], [['expect_changed'], 1, true], '改了期望值：同一条断言只是字面量变了，带出改前改后');
  eq(kinds(compareTest(js, js.replace(`test('b'`, `test.skip('b'`), 'test/a.test.mjs')), ['skip_added'], 'test.skip：算加了跳过，不重复算成用例变少');
  eq(kinds(compareTest(js, js.replace(`test('a'`, `test.only('a'`), 'test/a.test.mjs')), ['focus_added'], 'test.only：同文件别的用例不再跑');
  eq(kinds(compareTest(js, js.replace(/test\('b'.*\n/, ''), 'test/a.test.mjs')), ['tests_down', 'asserts_down'], '删掉一个用例：用例与断言都变少');
  const commented = compareTest(js, js.replace(`assert.equal(f(1), 1);`, `// assert.equal(f(1), 1);`), 'test/a.test.mjs');
  eq([kinds(commented), commented[0]?.before, commented[0]?.after], [['asserts_down'], 2, 1], '注释掉断言：算断言变少（2 → 1）');
  assert(commented[0]?.lines?.[0]?.includes('assert.equal(f(1), 1)'), '带上没了的那一行原文（人要看少的是哪条）', JSON.stringify(commented));
  eq(kinds(compareTest(js, `${js}test('c', () => { assert.equal(f(2), 2); });\n`, 'test/a.test.mjs')), [], '追加用例：不报（给已有功能加测试是正常的）');

  const py = `import pytest\n\ndef test_a():\n    assert f(1) == 2\n\ndef test_b():\n    assert f(2) == 4\n`;
  eq(kinds(compareTest(py, py.replace('def test_b', '@pytest.mark.skip\ndef test_b'), 'tests/test_x.py')), ['skip_added'], 'Python：@pytest.mark.skip');
  eq(kinds(compareTest(py, py.replace('== 4', '== 5'), 'tests/test_x.py')), ['expect_changed'], 'Python：改期望值');
  const go = `package x\nimport "testing"\nfunc TestA(t *testing.T) {\n  if f(1) != 2 { t.Errorf("bad") }\n}\n`;
  eq(kinds(compareTest(go, go.replace('func TestA(t *testing.T) {', 'func TestA(t *testing.T) {\n  t.Skip("later")'), 'x_test.go')), ['skip_added'], 'Go：t.Skip');
  eq(compareTest('whatever', 'changed', 'test/data.json'), [], '认不出语言的测试文件：只报删除，其余不乱报');
}

// ── 带 git 的工作区：原有测试在任务工作区建立时就在 ─────────────────────────
const g = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const BASE_TEST = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { toCsv } from '../src/csv.mjs';\ntest('quotes', () => { assert.equal(toCsv([['a,b']]), '"a,b"'); });\ntest('plain', () => { assert.equal(toCsv([['a']]), 'a'); });\n`;
function fixture(name) {
  const ws = join(TMP, name); mkdirSync(join(ws, 'src'), { recursive: true }); mkdirSync(join(ws, 'test'));
  writeFileSync(join(ws, 'src', 'csv.mjs'), 'export const toCsv = (rows) => rows.map((r) => r.join(",")).join("\\n");\n');
  writeFileSync(join(ws, 'test', 'csv.test.mjs'), BASE_TEST);
  g(ws, 'init', '-q'); g(ws, 'config', 'user.email', 't@t'); g(ws, 'config', 'user.name', 't'); g(ws, 'add', '-A'); g(ws, 'commit', '-qm', 'base');
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'CSV 导出','整个仓库','测试全过','[]',?,?)`, newId('c'), taskId, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'字段转义','含逗号的字段加引号','test/csv.test.mjs 全过','pending','normal','standard',?)`, nodeId, taskId, t);
  audit(db, { actorKind: 'system', action: 'workspace_created', targetType: 'task', targetId: taskId, payload: { dir: ws, head: g(ws, 'rev-parse', 'HEAD') } });
  return { db, taskId, nodeId, userId, ws };
}
const call = (name, args) => ({ stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'tool_call', id: `c_${Math.random().toString(36).slice(2, 8)}`, name, args }] });
const handoffArgs = { artifacts: [{ path: 'src/csv.mjs', kind: 'source' }], interface_contract: 'toCsv(rows) -> string', acceptance_evidence: 'npm test', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] };
// 执行器：先改实现，再把原有测试的期望值改松（典型的"让测试迁就实现"），再交
const weakenThenSubmit = (n = 1) => [
  call('write_file', { path: 'src/csv.mjs', content: 'export const toCsv = (rows) => rows.map((r) => r.join(",")).join("\\n"); // v2\n' }),
  call('write_file', { path: 'test/csv.test.mjs', content: BASE_TEST.replace(`'"a,b"'`, `'a,b'`) }),
  ...Array(n).fill(0).map(() => call('submit_handoff', handoffArgs)),
];
const run = (f, script, verifier = null, maxIterations = script.length + 1) => executeNode(f.db, { client: new LlmClient({ mode: 'fake', fake: makeFake(script) }),
  taskId: f.taskId, nodeId: f.nodeId, workspace: f.ws, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, 'nar'), exec: new LocalExecutor(), verifier, maxIterations });

section('② 接进执行器');
{
  const f = fixture('ws-annotate');
  let seen = null;
  const r = await run(f, weakenThenSubmit(), async ({ testChanges }) => { seen = testChanges; return { verdict: 'accept', reasons: [], defects: [], pushbacks: [], noVerdict: false }; });
  eq(r.kind, 'done', '默认只标注：照常交上去（判断交给验收员）');
  eq(seen?.map((c) => [c.path, c.baseline, kinds(c.findings)]), [['test/csv.test.mjs', true, ['expect_changed']]], '验收员拿到证据：哪个文件、是原有测试、改了期望值');
  const a = f.db.one(`SELECT payload FROM audit_log WHERE action='handoff_test_changes' AND target_id=?`, f.nodeId);
  eq(JSON.parse(a?.payload ?? '{}').changes?.[0]?.path, 'test/csv.test.mjs', '审计 handoff_test_changes 记下了（看板与签收卡读它）');
  f.db.close();
}
{
  const f = fixture('ws-reject');
  setSetting(f.db, { key: 'deploy.test_guard', value: 'reject', userId: f.userId });
  let verifierCalls = 0;
  const r = await run(f, weakenThenSubmit(3), async () => { verifierCalls++; return { verdict: 'accept', reasons: [], defects: [], pushbacks: [], noVerdict: false }; }, 6);
  eq(r.kind, 'question', '部署设成 reject：原有测试被改弱交不上去；同一条拒收三次后照常转人（规格真要求改的由人放行）');
  eq(verifierCalls, 0, '机械校验就打回了，没轮到验收员');
  const rej = JSON.parse(f.db.one(`SELECT payload FROM audit_log WHERE action='handoff_rejected' AND target_id=? ORDER BY id LIMIT 1`, f.nodeId)?.payload ?? '{}');
  assert(rej.errs?.some((e) => /改弱了原有测试 `test\/csv\.test\.mjs`/.test(e) && /raise_question/.test(e)), '拒收理由点名文件，并说清规格真要求改时怎么办', JSON.stringify(rej.errs));
  eq(rej.defects?.find((d) => d.category === 'test')?.locations, ['test/csv.test.mjs'], '结构化缺陷：类别 test、位置是那个测试文件（诊断照常比）');
  f.db.close();
}
{
  // 本任务前一步写的测试再被改：照样报，但标"本任务写的"，reject 模式下也不拦
  const f = fixture('ws-own');
  writeFileSync(join(f.ws, 'test', 'own.test.mjs'), BASE_TEST.replace('quotes', 'own'));
  g(f.ws, 'add', '-A'); g(f.ws, 'commit', '-qm', 'earlier step');
  setSetting(f.db, { key: 'deploy.test_guard', value: 'reject', userId: f.userId });
  let seen = null;
  const script = [call('write_file', { path: 'src/csv.mjs', content: 'export const toCsv = () => ""; // v3\n' }), call('write_file', { path: 'test/own.test.mjs', content: BASE_TEST.replace('quotes', 'own').replace(`'"a,b"'`, `'a,b'`) }), call('submit_handoff', handoffArgs)];
  const r = await run(f, script, async ({ testChanges }) => { seen = testChanges; return { verdict: 'accept', reasons: [], defects: [], pushbacks: [], noVerdict: false }; });
  eq([r.kind, seen?.[0]?.baseline], ['done', false], '本任务写的测试被改：标"本任务写的"、照样给验收员看，不按原有测试拦');
  f.db.close();
}

section('③ 验收员的提示词里有"测试改动"一节');
{
  const f = fixture('ws-prompt');
  let prompt = '';
  const verdict = { stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'tool_call', id: 'v1', name: 'submit_verdict', args: { verdict: 'accept', evidence_checked: ['test/csv.test.mjs'] } }] };
  const client = new LlmClient({ mode: 'fake', fake: { respond: (canon) => { prompt = JSON.stringify(canon); return verdict; } } });
  const changes = [{ path: 'test/csv.test.mjs', baseline: true, findings: [{ kind: 'expect_changed', total: 1, pairs: [{ from: `assert.equal(x, '"a,b"')`, to: `assert.equal(x, 'a,b')` }] }] }];
  await verifyHandoff(f.db, { client, taskId: f.taskId, nodeId: f.nodeId, workspace: f.ws, exec: new LocalExecutor(), args: handoffArgs, changed: new Set(['test/csv.test.mjs']), testChanges: changes });
  assert(/测试改动（系统机械比对/.test(prompt) && /\[原有测试\] test\/csv\.test\.mjs/.test(prompt) && /改了期望值：/.test(prompt), '提示词带上比对结果（原有测试、改了期望值、改前改后）', prompt.slice(0, 300));
  eq(describeTestChanges([], 'zh'), '', '没有改动时那一节写"没有"（由调用方给）');
  f.db.close();
}

section('④ "做不到"出口：冲突原文 + 试过的路，按结构矛盾路由；同时改了原有测试的标出来');
{
  const f = fixture('ws-impossible');
  const conflict = [{ source: '验收标准第 1 条', quote: '输出必须是 RFC 4180 CSV' }, { source: 'test/csv.test.mjs:4', quote: `assert.equal(toCsv([['a,b']]), 'a,b')` }];
  const ask = (extra = {}) => call('raise_question', { level: 2, kind: 'impossible', text: '验收标准与原有测试冲突', blocked_by: '验收标准第 1 条', work_done: '读了测试与实现', plan_after_answer: '按答复改一方', ...extra });
  let sys = '';
  const replies = [];
  const script = [ask(), ask({ conflict, attempts: '按 RFC 加引号：测试 quotes 挂；不加：违反验收标准' })];
  let i = 0;
  const client = new LlmClient({ mode: 'fake', fake: { respond: (canon) => { sys ||= JSON.stringify(canon); const last = canon.messages?.at(-1); if (last) replies.push(JSON.stringify(last)); return script[i++]; } } });
  const r = await executeNode(f.db, { client, taskId: f.taskId, nodeId: f.nodeId, workspace: f.ws, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, 'nar'), exec: new LocalExecutor(), maxIterations: 4 });
  assert(/kind=impossible/.test(sys) && /不要改测试去迁就实现/.test(sys), '执行器提示词：冲突时用 kind=impossible 提问，不改测试', sys.slice(0, 200));
  assert(replies.some((x) => /要同时填 conflict/.test(x)), '缺冲突原文 / 试过的路：退回补一次', replies.join('\n').slice(0, 300));
  const q = f.db.one(`SELECT * FROM questions WHERE node_id=?`, f.nodeId);
  eq([r.kind, q?.decision_type], ['question', 'structural'], '补齐后挂起；按结构矛盾路由（出路是改规格 / 验收标准 / 测试中的一方）');
  assert(q.text.includes('〔验收标准第 1 条〕输出必须是 RFC 4180 CSV') && q.text.includes(`〔test/csv.test.mjs:4〕assert.equal`) && q.text.includes('按 RFC 加引号'), '事项正文机械附上冲突各方原文与试过的做法', q.text);
  assert(!q.text.includes('同时改了任务开始前就有的测试'), '没动原有测试：不标红');
  const p = JSON.parse(f.db.one(`SELECT payload FROM audit_log WHERE action='question_raised' AND target_id=?`, f.nodeId).payload);
  eq([p.impossible?.conflict?.length, p.impossible?.testsTouched], [2, []], '审计里留结构化的冲突与试过的路');
  f.db.close();
}
{
  // 改松了原有测试，再说做不到：事项里标出来；第二次还缺原文也照收（问题比假完成好）
  const f = fixture('ws-impossible-tests');
  const script = [...weakenThenSubmit(0), call('raise_question', { level: 2, kind: 'impossible', text: '做不到', blocked_by: 'x', work_done: 'x', plan_after_answer: 'x' }),
    call('raise_question', { level: 2, kind: 'impossible', text: '做不到', blocked_by: 'x', work_done: 'x', plan_after_answer: 'x' })];
  const r = await run(f, script);
  const q = f.db.one(`SELECT * FROM questions WHERE node_id=?`, f.nodeId);
  eq(r.kind, 'question', '第二次还缺：照收');
  assert(/同时改了任务开始前就有的测试/.test(q.text) && /test\/csv\.test\.mjs`：改了期望值：/.test(q.text), '说做不到却改了原有测试：事项里点名文件与改法', q.text);
  assert((q.text.match(/（没填）/g) ?? []).length === 2, '缺的两栏写"没填"');
  f.db.close();
}

section('⑤ 放行：答复时一并允许这一步改原有测试（reject 模式的出路）');
{
  const f = fixture('ws-allow');
  setSetting(f.db, { key: 'deploy.test_guard', value: 'reject', userId: f.userId });
  const r1 = await run(f, weakenThenSubmit(3), null, 6);
  const q = f.db.one(`SELECT id FROM questions WHERE node_id=?`, f.nodeId);
  eq([r1.kind, testsAllowedFor(f.db, f.nodeId).size], ['question', 0], '先被拦下、转人；还没放行');
  eq(allowTestChanges(f.db, { questionId: q.id, userId: f.userId }), ['test/csv.test.mjs'], '放行的路径取自系统比对，不收调用方传的');
  eq(allowTestChanges(f.db, { questionId: q.id, userId: f.userId }), [], '放行过的不重复记');
  f.db.run(`UPDATE nodes SET status='pending' WHERE id=?`, f.nodeId);
  let seen = null, ctx = '';
  const r2 = await executeNode(f.db, { client: new LlmClient({ mode: 'fake', fake: { respond: (canon) => { ctx ||= JSON.stringify(canon); return call('submit_handoff', handoffArgs); } } }),
    taskId: f.taskId, nodeId: f.nodeId, workspace: f.ws, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, 'nar'), exec: new LocalExecutor(), maxIterations: 2,
    verifier: async ({ testChanges }) => { seen = testChanges; return { verdict: 'accept', reasons: [], defects: [], pushbacks: [], noVerdict: false }; } });
  assert(/人已放行的测试改动/.test(ctx) && /只限这几个文件/.test(ctx), '复工上下文里明说放行了哪几个测试（只限这几个）', ctx.slice(0, 200));
  eq([r2.kind, seen?.[0]?.allowed], ['done', true], '放行后：reject 模式不再打回；验收员拿到的证据标着"人已允许"');
  assert(/人已允许改/.test(describeTestChanges(seen, 'zh')), '验收员提示词里写明人已允许');
  f.db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
