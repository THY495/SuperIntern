// 越界写入走批准：执行器在交接里申请扩范围 → 一条方案批准事项 → 批准即把路径写进契约、原样重交就过；
// 不批 → 范围不动；申请没盖住全部越界 / 还有别的拒收理由 → 照常打回；同一条越界连续出现 → 系统替它申请；老契约（散文范围）授予时落成结构化。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { executeNode } from '../src/agent/executor.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { scopePathsOf } from '../src/core/routing.mjs';
import { checkScopeRequest, grantScope, scopeAskOf, currentScopePaths } from '../src/core/scope-ask.mjs';
import { approvalThreadOf, describeReading } from '../src/agent/approval.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-scope-ask-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
process.env.SUPERINTERN_HOME = join(TMP, 'home');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const put = (root, rel, text) => { const p = join(root, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
function repo(name) {
  const ws = join(TMP, name);
  mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't'); git(ws, 'config', 'core.autocrlf', 'false');
  put(ws, 'src/.keep', ''); put(ws, 'tests/old.test.js', 'test("old", () => {});\n');
  git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'c');
  return { ws, head: git(ws, 'rev-parse', 'HEAD').stdout.trim() };
}
function fixture(ws, head, { scopePaths = ['src/'], scope = '只动 src/' } = {}) {
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'加 add','running',?)`, taskId, owner.userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,scope_paths,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'加 add()',?,?,'测试通过','[]',?,?)`, newId('c'), taskId, scope, JSON.stringify(scopePaths), t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写 add','src/add.js 导出 add','node -e 能调用','pending','normal','standard',?)`, nodeId, taskId, t);
  audit(db, { actorKind: 'system', action: 'workspace_created', targetType: 'task', targetId: taskId, payload: { head } });
  return { db, taskId, nodeId, owner };
}
const call = (name, args) => ({ stopReason: 'tool_call', usage: { inputTokens: 10, outputTokens: 5 }, content: [{ type: 'tool_call', id: `c_${Math.random().toString(36).slice(2, 8)}`, name, args }] });
const lastResults = (canon) => (canon.messages.at(-1)?.results ?? []).map((x) => x.content).join('\n');
const HANDOFF = (paths, extra = {}) => ({ artifacts: paths.map((path) => ({ path, kind: 'code' })), interface_contract: 'add(a,b)', acceptance_evidence: 'node -e', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [], ...extra });
const run = (f, ws, script, name) => executeNode(f.db, { client: new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor: script }) }),
  taskId: f.taskId, nodeId: f.nodeId, workspace: ws, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, `nar-${name}`), exec: new LocalExecutor(), maxIterations: 10 });
const WHY = '用例要跟实现一起交：tests/ 是仓库唯一跑测试的地方，写进 src/ 不会被 npm test 跑到';
const writeBoth = (i) => (i === 0 ? call('write_file', { path: 'src/add.js', content: 'export const add = (a, b) => a + b;\n' })
  : call('write_file', { path: 'tests/add.test.js', content: 'test("add", () => {});\n' }));

section('① 申请能不能受理');
{
  eq(checkScopeRequest({ paths: ['tests/add.test.js'], why: WHY }, { out: ['tests/add.test.js'] }).errs, [], '盖住全部越界 + 有理由：受理');
  eq(checkScopeRequest({ paths: ['tests/'], why: WHY }, { out: ['tests/add.test.js', 'tests/x/y.js'] }).errs, [], '目录盖住其下的文件');
  const r = checkScopeRequest({ paths: ['tests/add.test.js'], why: WHY }, { out: ['tests/add.test.js', 'README.md'] });
  assert(r.errs.length === 1 && r.errs[0].includes('`README.md`') && /没有盖住/.test(r.errs[0]), '漏了一个越界路径：退回并点名', r.errs.join(' | '));
  assert(checkScopeRequest({ paths: ['*'], why: WHY }, { out: ['a'] }).errs.some((e) => /不能是 \*/.test(e)), '不许申请整个仓库');
  assert(checkScopeRequest({ paths: ['../x'], why: WHY }, { out: ['../x'] }).errs.some((e) => /\.\./.test(e)), '路径问题与契约里的范围同一套校验');
  assert(checkScopeRequest({ paths: ['tests/'], why: '要' }, { out: ['tests/a'] }).errs.some((e) => /why/.test(e)), '理由太短：退回');
  assert(checkScopeRequest({ why: WHY }, { out: ['tests/a'] }).errs.some((e) => /paths 为空/.test(e)), '没列路径：退回');
}

section('② 交接越界 → 打回里说清可以申请 → 申请 → 一条方案批准事项，这一步挂起');
let F, R;
{
  R = repo('r2');
  F = fixture(R.ws, R.head);
  const seen = [];
  const res = await run(F, R.ws, (canon, i) => {
    if (i > 0) seen.push(lastResults(canon));
    if (i < 2) return writeBoth(i);
    if (i === 2) return call('submit_handoff', HANDOFF(['src/add.js', 'tests/add.test.js']));
    return call('submit_handoff', HANDOFF(['src/add.js', 'tests/add.test.js'], { scope_request: { paths: ['tests/add.test.js'], why: WHY } }));
  }, 'r2');
  assert(/越界改动/.test(seen[2]) && /scope_request/.test(seen[2]), '第一次交：越界打回，提示里有 scope_request 这条路', seen[2]?.slice(0, 200));
  eq(res.kind, 'question', '第二次带申请交：这一步挂起等人');
  const q = F.db.one(`SELECT * FROM questions WHERE id=?`, res.question.id);
  eq([q.decision_type, q.level, q.default_action, q.timeout_at], ['contract_approval', 3, null, null], '方案批准类、Ⅲ 级（动契约：无默认、无限期）');
  assert(q.text.startsWith('【扩大范围要你批准】') && q.text.includes('tests/add.test.js') && q.text.includes(WHY), '正文：标记、要放进的路径、AI 的原话', q.text.slice(0, 300));
  assert(q.text.includes('```diff') && q.text.includes('test("add"'), '正文贴了范围外文件的改动（新文件也看得到）');
  assert(q.text.includes('现在的可动路径：src/') && /\(A\) 批准/.test(q.text) && /\(B\) 不批/.test(q.text), '正文：现在的范围、A / B 两条出路说清后果');
  eq(JSON.parse(q.addressed_to), [F.owner.userId], '派给负责人（没配表 = solo 模板）');
  const ask = scopeAskOf(F.db, q.id);
  eq([ask?.paths, ask?.out, ask?.why], [['tests/add.test.js'], ['tests/add.test.js'], WHY], '审计记下申请（事项上可查）');
  eq([F.db.one(`SELECT status FROM nodes WHERE id=?`, F.nodeId).status, F.db.one(`SELECT status FROM tasks WHERE id=?`, F.taskId).status], ['blocked', 'waiting'], '步骤 blocked、任务 waiting');
  const b = F.db.one(`SELECT * FROM briefings WHERE question_id=?`, q.id);
  assert(b && /不用再填 scope_request/.test(b.plan_after) && /src\/add\.js/.test(b.work_done), '复工简报：批了怎么做 / 不批怎么做；上次的产物', b?.plan_after);
  eq([approvalThreadOf(F.db, q.id)?.kind, approvalThreadOf(F.db, q.id)?.scopeNow], ['scope', ['src/']], '看板判读：这是越界申请（批 / 不批两态），带上现在的范围');
  const far = describeReading({ body: '别动 tests/，用例另建 web/priority.test.jsx', kind: 'scope', scopeNow: ['src/'] }).text;
  assert(far.includes('web/priority.test.jsx') && /再申请一次/.test(far),'不批时写到的做法也在范围外：预览点名、说清还得再申请', far);
  assert(!/再申请一次/.test(describeReading({ body: '用例写进 src/add.check.js', kind: 'scope', scopeNow: ['src/'] }).text), '写的做法在范围里：不提示');
  assert(/放进任务的范围/.test(describeReading({ body: 'A', kind: 'scope' }).text), '预览：回 A = 放进范围');
  assert(/不批/.test(describeReading({ body: '别动测试', kind: 'scope' }).text) && /原样交给它/.test(describeReading({ body: '别动测试', kind: 'scope' }).text), '预览：写别的 = 不批，话交给 AI');
}

section('③ 批准 → 契约升一版、可动路径加上申请的路径；原样重交就过');
{
  const q = F.db.one(`SELECT id FROM questions WHERE task_id=? AND decision_type='contract_approval'`, F.taskId);
  const a = recordAnswer(F.db, { questionId: q.id, body: 'A', plaintextToken: F.owner.plaintext });
  eq(a.hook?.scope, 'granted', '答复落地即授予');
  const c = F.db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL`, F.taskId);
  eq([c.version, JSON.parse(c.scope_paths)], [2, ['src/', 'tests/add.test.js']], '宪法块 v2：可动路径 = 原来的 + 申请的');
  assert(c.scope.includes('批准放进范围') && c.goal === '加 add()' && c.definition_of_done === '测试通过', '散文范围补一句；目标、完成定义一字不动');
  assert(F.db.one(`SELECT 1 FROM edges WHERE from_id=? AND relation='derived_from' AND to_id=?`, c.id, a.messageId), '新契约的出处 = 那条答复（I9）');
  assert(F.db.one(`SELECT 1 FROM edges WHERE from_id=? AND relation='concluded_by'`, c.id), '批准绑到新契约上');
  assert(F.db.one(`SELECT 1 FROM decisions WHERE task_id=? AND layer='constitutional'`, F.taskId), '记一条宪法层决策');
  assert(F.db.one(`SELECT 1 FROM audit_log WHERE action='scope_granted' AND target_id=?`, F.taskId), '审计 scope_granted');
  eq(F.db.one(`SELECT status FROM nodes WHERE id=?`, F.nodeId).status, 'pending', '步骤解冻（pending）');
  const res = await run(F, R.ws, () => call('submit_handoff', HANDOFF(['src/add.js', 'tests/add.test.js'])), 'r3');
  eq(res.kind, 'done', '复工后原样重交（不带申请）：通过');
}

section('④ 不批 → 范围不动，答复交给 AI');
{
  const r = repo('r4');
  const f = fixture(r.ws, r.head);
  const res = await run(f, r.ws, (canon, i) => (i < 2 ? writeBoth(i)
    : call('submit_handoff', HANDOFF(['src/add.js', 'tests/add.test.js'], { scope_request: { paths: ['tests/'], why: WHY } }))), 'r4');
  eq(res.kind, 'question', '申请 → 事项');
  const a = recordAnswer(f.db, { questionId: res.question.id, body: 'B：别动 tests/，用例写在 src/add.check.js', plaintextToken: f.owner.plaintext });
  eq(a.hook?.scope, 'declined', '不批');
  eq([f.db.one(`SELECT version FROM constitutions WHERE task_id=? AND superseded_at IS NULL`, f.taskId).version, scopePathsOf(f.db, f.taskId)], [1, ['src/']], '契约不动');
  assert(f.db.one(`SELECT 1 FROM audit_log WHERE action='scope_declined' AND target_id=?`, f.taskId), '审计 scope_declined');
  eq(f.db.one(`SELECT status FROM nodes WHERE id=?`, f.nodeId).status, 'pending', '步骤照样解冻：答复进复工上下文');
  assert(!f.db.one(`SELECT 1 FROM decision_registry WHERE source_kind='question' AND source_id=?`, res.question.id), '"不批"不登记成一条答复约定（事项由钩子认领）');
}

section('⑤ 申请没盖住 / 还有别的拒收理由：照常打回，不挂事项');
{
  const r = repo('r5');
  const f = fixture(r.ws, r.head);
  const seen = [];
  const res = await run(f, r.ws, (canon, i) => {
    if (i > 0) seen.push(lastResults(canon));
    if (i === 0) return call('write_file', { path: 'tests/add.test.js', content: 'x\n' });
    if (i === 1) return call('write_file', { path: 'README.md', content: 'x\n' });
    if (i === 2) return call('write_file', { path: 'src/add.js', content: 'x\n' });
    if (i === 3) return call('submit_handoff', HANDOFF(['src/add.js'], { scope_request: { paths: ['tests/'], why: WHY } }));
    if (i === 4) return call('submit_handoff', HANDOFF(['src/add.js'], { interface_contract: '', scope_request: { paths: ['tests/', 'README.md'], why: WHY } }));
    return call('submit_handoff', HANDOFF(['src/add.js'], { scope_request: { paths: ['tests/', 'README.md'], why: WHY } }));
  }, 'r5');
  assert(/没有盖住/.test(seen[3]) && seen[3].includes('`README.md`'), '申请漏了 README.md：打回并点名', seen[3]?.slice(0, 300));
  assert(/interface_contract 为空/.test(seen[4]) && !/已申请/.test(seen[4]), '还有别的拒收理由：先修那些，申请不受理');
  eq(res.kind, 'question', '都修好、申请盖全：挂事项');
  eq(scopeAskOf(f.db, res.question.id)?.paths, ['tests/', 'README.md'], '申请的路径原样记下');
}

section('⑥ 同一条越界连续交三次（没申请）：系统替它申请，正文说清 AI 没给理由');
{
  const r = repo('r6');
  const f = fixture(r.ws, r.head);
  const res = await run(f, r.ws, (canon, i) => (i < 2 ? writeBoth(i) : call('submit_handoff', HANDOFF(['src/add.js', 'tests/add.test.js']))), 'r6');
  eq(res.kind, 'question', '第三次一样 → 挂事项');
  const q = f.db.one(`SELECT * FROM questions WHERE id=?`, res.question.id);
  assert(q.decision_type === 'contract_approval' && /AI 没有说理由/.test(q.text), '是越界申请（方案批准类），不是"结构矛盾"；说清没理由', q.text.slice(0, 200));
  eq(scopeAskOf(f.db, q.id)?.paths, ['tests/add.test.js'], '申请的就是越界的那几个路径');
}

section('⑦ 老契约（散文范围、没有结构化路径）：授予时把抽出来的范围落成结构化，不丢原范围');
{
  const r = repo('r7');
  const f = fixture(r.ws, r.head, { scopePaths: [], scope: '只动 src/ 目录' });
  eq(currentScopePaths(f.db, f.taskId), ['src/'], '散文里抽出 src/');
  const g = grantScope(f.db, { taskId: f.taskId, paths: ['tests/add.test.js'], questionId: 'q_x', userId: f.owner.userId });
  eq(g.scopePaths, ['src/', 'tests/add.test.js'], '授予之后：原来的 src/ 还在');
  eq(scopePathsOf(f.db, f.taskId), ['src/', 'tests/add.test.js'], '库里的契约同样');
  const g2 = grantScope(f.db, { taskId: f.taskId, paths: ['src/x.js'], questionId: 'q_y', userId: f.owner.userId });
  eq([g2.added, g2.scopePaths], [[], ['src/', 'tests/add.test.js']], '已经在范围内的路径：不重复加');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
