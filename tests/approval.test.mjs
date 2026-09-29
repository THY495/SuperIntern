// 方案批准的答复：回显 + 判读留痕 + 防循环
//
// 跑：node tests/approval.test.mjs
//
// 起因：有人连着两次写「A 保留：…」，两次都被读成"要改"，规划器又出一版、又来问他；
// 页面上那两条事项都标着"已决定"。同一行的写法另有专门的识别；这里管的是更一般的那一半 ——
// 人看得到系统怎么读自己的话（答之前、答之后、历史里），以及读岔了两次之后系统自己停下来问，而不是再出一版。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { draft, startFromIdea } from '../src/agent/elicitor.mjs';
import { readVerdict, describeReading, approvalThreadOf, CONFIRM_MARK, REACHED_LABELS } from '../src/agent/approval.mjs';
import { startProjectFromBrief, planProject, carrierTask } from '../src/agent/project-planner.mjs';
import { requestAppend, appendStateOf } from '../src/agent/project-append.mjs';
import { createProject } from '../src/core/project.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import { getParam } from '../src/core/params.mjs';
import { assessTask, assessProjectPlan } from '../src/core/daemon.mjs';
import { startWeb, taskDetail } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-approval-'));
const HOME = join(TMP, 'home');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SRC = join(TMP, 'src');
mkdirSync(SRC); git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'README.md'), '# demo\n'); git(SRC, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'); git(SRC, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');

const db = openDb(':memory:');
const owner = ensureOwner(db);
const call = (name, args, id = 'c1') => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id, name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
/** 假模型 + 记下每次请求的正文（看反馈有没有原样交给模型）。脚本用完再被调 = 测试失败（"不该花钱的地方花了"）。 */
const client = (script) => {
  const real = new LlmClient({ mode: 'fake', fake: makeFake(script) });
  const seen = [];
  return { seen, complete: async (req) => { seen.push(req.messages.map((m) => (m.content ?? []).map((c) => c.text ?? '').join('')).join('\n')); return real.complete(req); } };
};
const answer = (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: owner.plaintext });
const reads = (taskId) => db.all(`SELECT payload FROM audit_log WHERE action='approval_read' AND target_id=? ORDER BY id`, taskId).map((a) => JSON.parse(a.payload));
const dead = () => false;

section('1. 判读的人话：批准 / 放弃 / 要改，以「A」开头却要改时说清楚为什么');
{
  const r1 = describeReading({ body: 'A', tense: 'will' });
  eq(r1.verdict, 'approve', '「A」= 批准');
  assert(r1.text.startsWith('如果现在点「答复」，系统会理解为：批准'), '答之前：「系统会理解为：批准…」');
  const r2 = describeReading({ body: 'A 保留：签收时我会核对 package.json 只加了新东西' });
  assert(r2.verdict === 'approve' && /记成保留意见/.test(r2.text) && /签收时我会核对/.test(r2.text), '「A 保留：…」= 批准，并说那句话记成保留意见、不挡东西');
  const r3 = describeReading({ body: 'A，但把超范围改成截断' });
  assert(r3.verdict === 'feedback' && r3.lead === 'A' && /以「A」开头，但后面有「但」/.test(r3.text) && /只回「A」/.test(r3.text),
    '「A，但…」= 要改；点名是哪个词让它不算批准，并教怎么只批准 / 批准留话');
  const r4 = describeReading({ body: 'A 看着没问题，标题可以再短点' });
  assert(r4.verdict === 'feedback' && /分不清是批准还是要改/.test(r4.text), '「A 看着没问题…」（没有转折词）也说清按"要改"算');
  const r5 = describeReading({ body: '把验收命令改成 npm test' });
  assert(r5.verdict === 'feedback' && !r5.lead && !/开头/.test(r5.text), '普通的修改意见：只说"要改"，不多嘴');
  eq(describeReading({ body: 'C' }).label, '放弃', '「C」= 放弃');
  eq(describeReading({ body: '确认达成', labels: REACHED_LABELS, reached: true }).label, '确认达成', '达成确认页：选项名「确认达成」认');
  eq(describeReading({ body: '还差导出功能', labels: REACHED_LABELS, reached: true }).label, '还差东西', '达成确认页的反馈叫"还差东西"');
  // 顺手修的：选项名的全匹配原来在模板串里写了 \s，实际是字母 s —— 前后带空白就不认
  eq(readVerdict('  确认达成 ', REACHED_LABELS), 'approve', '选项名前后带空白也认（原来的正则把 \\s 写成了字母 s）');
}

section('2. 追问器：连着两次以「A」开头却读成要改 → 第二次不出新版，先挂确认；回 A 按当前版批准');
{
  const propose = (title) => call('propose_constitution', { title, goal: 'g', scope: 's', scope_paths: ['a.mjs'], definition_of_done: 'd', constraints: [], verify_command: 'node a.test.mjs', notes: '' });
  const { taskId } = startFromIdea(db, { userId: owner.userId, idea: '一个小工具' });
  let r = await draft(db, { client: client([propose('v1')]), taskId });
  eq(r.kind, 'proposed', 'v1 出来了');
  const q1 = r.questionId;
  eq(approvalThreadOf(db, q1)?.kind, 'draft', '批准事项认得出是追问器那条线');
  answer(q1, 'A，但把标题改成「小工具 v2」');
  r = await draft(db, { client: client([propose('v2')]), taskId });
  eq([r.kind, r.version].join('|'), 'proposed|2', '第一次「A，但…」：照常按反馈出 v2（页面上已经提示过"会理解为要改"）');
  eq(reads(taskId).at(-1)?.verdict, 'feedback', '判读留痕：approval_read 记下 feedback');
  const q2 = r.questionId;
  answer(q2, 'A 不过标题再短一点');
  const c = client([]);          // 脚本是空的：再调模型就是在不该花钱的地方花了钱
  r = await draft(db, { client: c, taskId });
  assert(r.kind === 'proposed' && r.confirm === true, '第二次还是「A…」却要改 → 按 proposed 退出，但是 confirm');
  eq(c.seen.length, 0, '**没有调模型**（只花一条事项，不花一次重档调用）');
  const cq = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  assert(cq.text.startsWith(CONFIRM_MARK) && /A 不过标题再短一点/.test(cq.text) && /只回「A」/.test(cq.text) && /只问一次/.test(cq.text), '确认事项：引了这次写的原话，给出三条答法');
  eq([cq.decision_type, cq.level, cq.status].join('|'), 'contract_approval|3|open', '同一类事项（方案批准、Ⅲ 级）：走同一张路由表');
  eq(getParam(db, taskId, 'draft.approval_question'), r.questionId, '指针改指确认事项 —— 它的答复由同一台状态机读');
  eq(db.one(`SELECT max(version) v FROM constitutions WHERE task_id=?`, taskId).v, 2, '宪法块还停在 v2（没出新版）');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务等人');
  eq(assessTask(db, db.one(`SELECT * FROM tasks WHERE id=?`, taskId), { alive: dead }).due, false, '守护进程：确认事项开着，不拉');
  answer(r.questionId, 'A');
  assert(assessTask(db, db.one(`SELECT * FROM tasks WHERE id=?`, taskId), { alive: dead }).due, '答了确认事项 → 守护进程拉追问器');
  r = await draft(db, { client: client([]), taskId });
  eq([r.kind, r.version].join('|'), 'approved|2', '回 A → 按 v2 批准（没花钱）');
}

section('2b. 确认事项里写要改：前后两段一起交给模型；确认事项自己的「A…」不再触发确认');
{
  const propose = (title) => call('propose_constitution', { title, goal: 'g', scope: 's', scope_paths: ['a.mjs'], definition_of_done: 'd', constraints: [], verify_command: 'node a.test.mjs', notes: '' });
  const { taskId } = startFromIdea(db, { userId: owner.userId, idea: '另一个小工具' });
  let r = await draft(db, { client: client([propose('v1')]), taskId });
  answer(r.questionId, 'A 但是加一个 --json');
  r = await draft(db, { client: client([propose('v2')]), taskId });
  answer(r.questionId, '批准，不过输出别带颜色');
  r = await draft(db, { client: client([]), taskId });
  assert(r.confirm, '挂了确认');
  answer(r.questionId, 'A 还是要改：输出别带颜色');
  const c = client([propose('v3')]);
  r = await draft(db, { client: c, taskId });
  eq([r.kind, r.version, r.confirm ?? false].join('|'), 'proposed|3|false', '确认事项的答复又是「A…」却要改 → 不再问第二遍，按反馈出 v3');
  assert(/批准，不过输出别带颜色/.test(c.seen[0]) && /确认时补充/.test(c.seen[0]) && /A 还是要改/.test(c.seen[0]), '模型收到的反馈 = 被拦下的那段 + 确认时补的那句');
}

section('3. 项目规划：同一条规矩；确认事项挂载体任务，项目的批准指针改指它');
{
  const task = (t) => ({ title: t, goal: `g ${t}`, scope: 's', scope_paths: [`src/${t}/`], definition_of_done: `d ${t}`, rules: [{ rule: `r ${t}`, assumption: '规格没写' }], constraints: ['既有测试一行不许改'], verify_command: `node --test tests/${t}.test.mjs` });
  const propose = (n) => call('propose_project', { title: '演示项目', tasks: [task(`A${n}`), task(`B${n}`)], notes: '' });
  const P = startProjectFromBrief(db, { userId: owner.userId, brief: '做一个 KV 存储\n先库后 CLI', source: SRC, home: join(HOME, 'p3') });
  let r = await planProject(db, { client: client([propose(1)]), projectId: P.projectId });
  answer(r.questionId, 'A，但 CLI 要支持 --json');
  r = await planProject(db, { client: client([propose(2)]), projectId: P.projectId });
  eq(r.version, 2, 'v2');
  answer(r.questionId, '同意，CLI 名字再想想');
  r = await planProject(db, { client: client([]), projectId: P.projectId });
  assert(r.kind === 'proposed' && r.confirm, '第二次 → 确认事项，没调模型');
  const p = db.one(`SELECT * FROM projects WHERE id=?`, P.projectId);
  eq([p.draft_question, p.draft_version, p.status].join('|'), [r.questionId, 2, 'proposed'].join('|'), '项目的批准指针改指确认事项，草案还是 v2');
  eq(db.one(`SELECT task_id FROM questions WHERE id=?`, r.questionId).task_id, carrierTask(db, P.projectId).id, '确认事项挂载体任务');
  eq(assessProjectPlan(db, p, { alive: dead }).reason, 'needs_human:proposed', '守护进程：等人');
  answer(r.questionId, 'A');
  eq(assessProjectPlan(db, db.one(`SELECT * FROM projects WHERE id=?`, P.projectId), { alive: dead }).reason, 'project-plan:trigger:question_answered', '答了 → 拉规划器');
  r = await planProject(db, { client: client([]), projectId: P.projectId });
  eq(r.kind, 'approved', '回 A → 按 v2 批准');
  eq(db.one(`SELECT status FROM projects WHERE id=?`, P.projectId).status, 'active', '项目 active');
}

section('4. 追加：同一条规矩（指针是载体任务的 append.question）');
{
  const task = (t) => ({ title: t, goal: `g ${t}`, scope: 's', scope_paths: [`src/${t}/`], definition_of_done: `d ${t}`, rules: [{ rule: '输出到标准输出', quote: 'export --format csv，输出到标准输出' }], constraints: [], verify_command: `node --test tests/${t}.test.mjs` });
  const X = createProject(db, { userId: owner.userId, spec: { title: '追加演示', brief: '原规划', tasks: [
    { title: 'T1', goal: 'g1', definition_of_done: 'd1', verify_command: 'node --test tests/a.test.mjs' },
    { title: 'T2', goal: 'g2', definition_of_done: 'd2', verify_command: 'node --test tests/b.test.mjs' }] }, source: SRC, home: join(HOME, 'p4') });
  const { carrierId } = requestAppend(db, { projectId: X.projectId, userId: owner.userId, brief: '再加一个导出子命令：export --format csv，输出到标准输出' });
  const propose = () => call('propose_project', { title: 'x', tasks: [task('T3')], notes: '' });
  let r = await planProject(db, { client: client([propose()]), projectId: X.projectId });
  eq(approvalThreadOf(db, r.questionId)?.kind, 'append', '认得出是追加那条线');
  answer(r.questionId, 'A 但是 csv 要带表头');
  r = await planProject(db, { client: client([propose()]), projectId: X.projectId });
  answer(r.questionId, 'A 表头用中文');
  r = await planProject(db, { client: client([]), projectId: X.projectId });
  assert(r.kind === 'proposed' && r.confirm, '第二次 → 确认事项');
  eq(appendStateOf(db, X.projectId).questionId, r.questionId, 'append.question 改指确认事项');
  eq(appendStateOf(db, X.projectId).stage, 'proposed', '追加还在 proposed');
  answer(r.questionId, '放弃');
  r = await planProject(db, { client: client([]), projectId: X.projectId });
  eq(r.kind, 'abandoned', '确认事项里回「放弃」→ 这次追加放弃');
  eq(reads(carrierId).map((x) => x.verdict).join(','), 'feedback,feedback,abandon', '这条线的判读留痕：要改、要改、放弃');
}

section('5. 看板：答之前实时预览、答之后回显、历史按判读标（不再一律"已决定"）');
{
  const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 1000, makeClassifierClient: () => ({ complete: async () => { throw new Error('不该调分类器'); } }) });
  const base = `http://127.0.0.1:${w.port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  try {
    const propose = (title) => call('propose_constitution', { title, goal: 'g', scope: 's', scope_paths: ['a.mjs'], definition_of_done: 'd', constraints: [], verify_command: 'node a.test.mjs', notes: '' });
    const { taskId } = startFromIdea(db, { userId: owner.userId, idea: '看板上的小工具' });
    let r = await draft(db, { client: client([propose('v1')]), taskId });
    const q1 = r.questionId;
    let d = taskDetail(db, taskId, { userId: owner.userId });
    eq(d.questions.find((q) => q.id === q1)?.interpretable, true, '开着的方案批准事项标了"可预览"');
    const pv = await post(`/api/tasks/${taskId}/interpret`, { questionId: q1, body: 'A 保留：先这样' });
    assert(pv.ok && pv.result.reading.verdict === 'approve' && pv.result.reading.text.startsWith('如果现在点「答复」，系统会理解为：批准'), '预览接口：「A 保留：…」→ 系统会理解为：批准');
    const pv2 = await post(`/api/tasks/${taskId}/interpret`, { questionId: q1, body: 'A，但是换个名字' });
    eq(pv2.result.reading.verdict, 'feedback', '预览接口：「A，但…」→ 要改');
    eq(db.one(`SELECT count(*) n FROM messages WHERE task_id=?`, taskId).n, 0, '预览不落库（没有任何消息）');
    const other = await post(`/api/tasks/${taskId}/interpret`, { questionId: 'q_nope', body: 'A' });
    eq(other.result.reading, null, '不是方案批准事项：没有预览');
    const an = await post(`/api/tasks/${taskId}/answer`, { questionId: q1, body: 'A，但是换个名字' });
    assert(an.ok && an.result.reading?.text.startsWith('已提交，系统理解为：要改'), '答复接口的返回里带回显：系统理解为：要改');
    d = taskDetail(db, taskId, { userId: owner.userId });
    const h1 = d.questions.find((q) => q.id === q1);
    assert(h1.reading && h1.reading.label === '要改' && h1.reading.final === false, '答了、状态机还没读：历史先按同一个函数标"要改"（final=false）');
    r = await draft(db, { client: client([propose('v2')]), taskId });
    d = taskDetail(db, taskId, { userId: owner.userId });
    const h2 = d.questions.find((q) => q.id === q1);
    assert(h2.reading.label === '要改' && h2.reading.final === true, '状态机读过之后：以 approval_read 为准（final=true）');
  } finally { w.close(); }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 200);   // 与 web.test 同：等看板的连接关干净，Windows 上立即 exit 会撞 libuv 断言
