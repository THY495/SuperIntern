// 项目规划器（project-planner.mjs）：规划文本 → 整批契约 → Ⅲ 级批准 → 人回 A / 反馈 / C。
//
// 跑：node tests/project-planner.test.mjs
//
// 假模型（makeFake）只吐 propose_project 调用；断言的是护栏与状态机：契约不合规回灌、合规落库（无工作区）、
// 批准问题挂载体任务、反馈作废旧契约出下一版、批准后项目 active 且 advanceProject 建第一个工作区、放弃即 aborted、
// 守护进程只在该拉时拉。

import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, now } from '../src/db/db.mjs';
import { validateProjectSpec, scopeOverlaps, renderScopeOverlaps, renderScopePaths } from '../src/core/project.mjs';
import { activeDecisions } from '../src/core/decisions.mjs';
import { validateRules, quoteSim, clausesOf } from '../src/core/rules.mjs';
import { startProjectFromBrief, planProject, carrierTask, renderProposal, renderPlanOutcome } from '../src/agent/project-planner.mjs';
import { projectTasks, advanceProject } from '../src/core/project.mjs';
import { assessProjectPlan, startDaemon } from '../src/core/daemon.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import { getParam } from '../src/core/params.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { requestAppend, appendStateOf } from '../src/agent/project-append.mjs';
import { startProject } from '../src/agent/project-start.mjs';
import { draft } from '../src/agent/elicitor.mjs';
import { setMember, removeMember, setVisibility, canAddTasks, canSeeProject, canSeeTask, involvedIn, listMembers, editProjectGoal } from '../src/core/project-members.mjs';
import { setUserRole } from '../src/core/users.mjs';
import { createProject, deliverProject, createTaskFromSpec } from '../src/core/project.mjs';
import { signOff } from '../src/core/deliver.mjs';
import { ensureWorkspace } from '../src/core/workspace.mjs';
import { addUser } from '../src/core/users.mjs';
import { setProjectBudget, setProjectVerify, setGear, deferSignoff, deferredSignoffs } from '../src/core/project-settings.mjs';
import { acceptDeferredSignoffs } from '../src/core/project.mjs';
import { raiseSignoffQuestion } from '../src/core/deliver.mjs';
import { buildDigest, renderDigest } from '../src/core/digest.mjs';
import { record } from '../src/core/decisions.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-pplan-'));
const HOME = join(TMP, 'home');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitc = (cwd, ...a) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
const SRC = join(TMP, 'src');
mkdirSync(SRC); git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'README.md'), '# demo\n'); gitc(SRC, 'add', '.'); gitc(SRC, 'commit', '-q', '-m', 'init');

const db = openDb(':memory:');
const owner = ensureOwner(db);
const call = (name, args, id = 'c1') => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id, name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
const client = (script) => new LlmClient({ mode: 'fake', fake: makeFake(script) });
const task = (t) => ({ title: t, goal: `g ${t}`, scope: 's', scope_paths: [`src/${t}/`], definition_of_done: `d ${t}`, rules: [{ rule: `r ${t}`, assumption: '规格没写' }], constraints: ['既有测试一行不许改'], verify_command: `node --test tests/${t}.test.mjs` });
const propose = (tasks, over = {}) => call('propose_project', { title: '演示项目', tasks, notes: '拍了两个板', ...over });
const answer = (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: owner.plaintext });
const project = (id) => db.one(`SELECT * FROM projects WHERE id=?`, id);
const dead = () => false;

section('1. 从规划文本建 proposed 项目：仓库、分支、载体任务');
const P = startProjectFromBrief(db, { userId: owner.userId, brief: '做一个 KV 存储\n先库后 CLI', source: SRC, home: HOME });
{
  const p = project(P.projectId);
  eq(p.status, 'proposed', '状态 proposed');
  eq(p.title, '做一个 KV 存储', '标题取第一行');
  eq(p.draft_version, 0, '草案 v0');
  eq(git(P.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), P.branch, '仓库停在项目分支');
  const c = carrierTask(db, P.projectId);
  assert(c && c.project_order === 0 && c.status === 'planning', '载体任务 order 0');
  eq(projectTasks(db, P.projectId).length, 0, '契约任务 0 个（载体不算）');
  eq(assessProjectPlan(db, p, { alive: dead }).reason, 'project-plan:first', '守护进程：该拉规划器');
  let threw = null; try { startProjectFromBrief(db, { userId: owner.userId, brief: '  ', source: SRC, home: HOME }); } catch (e) { threw = e; }
  assert(threw, '空规划拒');
}

section('2. 护栏：不合规回灌，合规落库 + Ⅲ 级批准问题');
let Q1;
{
  const bad1 = propose([task('a'), { ...task('b'), verify_command: 'a && b' }]);
  const r = await planProject(db, { client: client([bad1, propose([task('a'), task('b')])]), projectId: P.projectId });
  eq(r.kind, 'proposed', '第二次合规 → proposed');
  eq(r.attempts, 2, '两次尝试');
  eq(r.version, 1, 'v1');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_plan_attempt' AND target_id=?`, P.projectId).n, 1, '被拒的一次进审计');
  const ts = projectTasks(db, P.projectId);
  eq(ts.length, 2, '两个契约任务');
  eq(ts.map((t) => t.status).join(','), 'planning,planning', '都是 planning');
  assert(!existsSync(join(HOME, 'workspaces', ts[0].id)), '批准前没有工作区');
  eq(JSON.stringify(getParam(db, ts[1].id, 'task.verify_extra')), JSON.stringify([['node', '--test', 'tests/a.test.mjs']]), '回归义务累加');
  const p = project(P.projectId);
  eq(p.title, '演示项目', '标题按草案更新');
  Q1 = p.draft_question;
  const q = db.one(`SELECT * FROM questions WHERE id=?`, Q1);
  assert(q.level === 3 && q.default_action === null && q.timeout_at === null && q.task_id === carrierTask(db, P.projectId).id, '批准问题 Ⅲ 级、无默认无超时、挂载体任务');
  assert(q.text.includes('项目契约草案 v1') && q.text.includes('(A) 批准') && q.text.includes('2. b'), '问题正文是草案全文');
  eq(carrierTask(db, P.projectId).status, 'waiting', '载体任务 waiting');
  eq(assessProjectPlan(db, p, { alive: dead }).reason, 'needs_human:proposed', '守护进程：等人批');
  const again = await planProject(db, { client: client([]), projectId: P.projectId });
  eq(again.kind, 'noop', '问题开着再起 → noop，不调模型');
  const adv = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(adv.reason, 'status:proposed', 'proposed 的项目不推进');
}

section('3. 反馈 → 作废旧契约、出 v2；批准 → active → advanceProject 建第一个工作区');
{
  answer(Q1, '拆成三个：库、CLI、TTL');
  eq(assessProjectPlan(db, project(P.projectId), { alive: dead }).reason, 'project-plan:trigger:question_answered', '答了 → 该拉');
  const oldIds = projectTasks(db, P.projectId).map((t) => t.id);
  const r = await planProject(db, { client: client([propose([task('lib'), task('cli'), task('ttl')])]), projectId: P.projectId });
  eq(r.kind, 'proposed', 'v2 出了'); eq(r.version, 2, 'v2');
  const ts = projectTasks(db, P.projectId);
  eq(ts.length, 3, '三个新契约');
  assert(oldIds.every((id) => { const t = db.one(`SELECT status, project_id FROM tasks WHERE id=?`, id); return t.status === 'aborted' && t.project_id === null; }), '旧契约作废并脱钩');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_tasks_voided' AND target_id=?`, P.projectId).n, 1, '作废进审计');
  const Q2 = project(P.projectId).draft_question;
  assert(Q2 !== Q1, '新的批准问题');
  // 批准时带一句保留意见 —— 照批，那句话进约定清单、标〔保留意见〕
  answer(Q2, 'A。\n保留：TTL 那条我不太认同，先这么做，等上线看了再说。');
  const ok2 = await planProject(db, { client: client([]), projectId: P.projectId });
  eq(ok2.kind, 'approved', '批准（不调模型）');
  {
    const resv = activeDecisions(db, { projectId: P.projectId }).filter((d) => d.reservation);
    eq(resv.length, 1, '保留意见落进约定清单');
    assert(/TTL 那条我不太认同/.test(resv[0].statement), '原话原样记下来');
    const qt = db.one(`SELECT text FROM questions WHERE id=?`, Q2).text;
    assert(/保留/.test(qt), '批准页上写明了有这个出路');
    // (D) 在这个场景下是个陷阱 —— 留一句话在心理上像"我表态反对了、这事算处理了"，
    // 而实际效果与 (A) 一模一样。所以那句警告必须**在最前面**，不能放在说明的最后一行。
    const dLine = qt.split('\n').find((x) => x.startsWith('(D)')) ?? '';
    assert(dLine.indexOf('**它不挡任何东西**') > 0 && dLine.indexOf('**它不挡任何东西**') < 26,
      '**"它不挡任何东西"要摆在 (D) 的开头** —— 放最后一行会被跳过，那正是这条修法唯一的陷阱');
    assert(dLine.includes('要**挡住**其中某一条'), '同时给出真想挡住时该走哪条路');
  }
  eq(project(P.projectId).status, 'active', '项目 active');
  eq(carrierTask(db, P.projectId).status, 'done', '载体任务 done');
  eq(assessProjectPlan(db, project(P.projectId), { alive: dead }).reason, 'status:active', '规划器不再拉');
  const adv = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(adv.reason, 'workspace_created', 'advanceProject 建第一个工作区');
  eq(adv.taskId, ts[0].id, '是 lib 那个');
  assert(existsSync(join(HOME, 'workspaces', ts[0].id, 'README.md')), '工作区从项目分支克隆');
}

section('4. 放弃；三次都不合规 → failed；守护进程 tick 只在该拉时拉');
{
  const P2 = startProjectFromBrief(db, { userId: owner.userId, brief: '另一个项目', source: SRC, home: HOME });
  const r = await planProject(db, { client: client([propose([task('x'), task('y')])]), projectId: P2.projectId });
  answer(project(P2.projectId).draft_question, 'C');
  const r2 = await planProject(db, { client: client([]), projectId: P2.projectId });
  eq(r2.kind, 'abandoned', '放弃');
  eq(project(P2.projectId).status, 'aborted', '项目 aborted');
  assert(db.all(`SELECT status FROM tasks WHERE project_id=?`, P2.projectId).every((t) => t.status === 'aborted'), '任务全 aborted');

  const P3 = startProjectFromBrief(db, { userId: owner.userId, brief: '第三个', source: SRC, home: HOME });
  const badOne = propose([task('only')]);
  let threw = null;
  try { await planProject(db, { client: client([badOne, badOne, badOne]), projectId: P3.projectId }); } catch (e) { threw = e; }
  assert(threw && /合规/.test(threw.message), '三次都只有一个任务 → 抛');
  eq(JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='project_planner_exit' AND target_id=? ORDER BY id DESC LIMIT 1`, P3.projectId).payload).kind, 'failed', 'exit kind=failed');
  const a = assessProjectPlan(db, project(P3.projectId), { alive: dead, at: now() });
  eq(a.reason, 'backoff:failed#1', '失败后退避');

  const launched = [];
  const P4 = startProjectFromBrief(db, { userId: owner.userId, brief: '第四个', source: SRC, home: HOME });
  const d = startDaemon(db, { home: HOME, launcher: { running: () => null, launch: (id, o) => { launched.push({ id, verb: o.verb }); return { pid: 1, logFile: 'x' }; } }, intervalMs: 3_600_000, runtime: null });
  const t = await d.tick();
  d.stop();
  assert(launched.some((l) => l.id === P4.projectId && l.verb === 'project-plan'), 'tick 拉起 project-plan');
  assert(!launched.some((l) => l.id === P3.projectId), '退避中的不拉');
  assert(!launched.some((l) => l.id === P.projectId), 'active 的不拉规划器');
  assert(t.launched.some((l) => l.verb === 'project-plan'), 'tick 返回里有它');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_plan_launched_by_daemon' AND target_id=?`, P4.projectId).n, 0, '审计由启动器写（这里是假启动器，不写）');
}

section('4b. 从零开始：--empty 建空仓库 + 空提交');
{
  const P5 = startProjectFromBrief(db, { userId: owner.userId, brief: '从零做一个东西', home: HOME, empty: true });
  eq(git(P5.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), P5.branch, '空仓库停在项目分支');
  eq(git(P5.repo, 'rev-list', '--count', 'HEAD'), '1', '一个空提交');
  eq(project(P5.projectId).source, null, 'source 为 null');
  let threw = null; try { startProjectFromBrief(db, { userId: owner.userId, brief: 'x', home: HOME, empty: true, source: SRC }); } catch (e) { threw = e; }
  assert(threw && /只能给一个/.test(threw.message), '--empty 与 --source 互斥');
  threw = null; try { startProjectFromBrief(db, { userId: owner.userId, brief: 'x', home: HOME }); } catch (e) { threw = e; }
  assert(threw && /--empty/.test(threw.message), '两个都不给 → 提示');
}

section('5. 渲染');
{
  const text = renderProposal({ title: 'X', tasks: [task('a'), task('b')] }, 3, '说明');
  assert(text.includes('v3') && text.includes('1. a') && text.includes('2. b') && text.includes('累加') && text.includes('说明'), '草案全文含版本、任务、累加提示、说明');
  assert(/硬上限：累计运行时长 3 h/.test(text), '页脚写明每任务时长上限');
}

section('6. 输出被 max_tokens 截断且没有可见内容 → 当基础设施错误抛出，不回填、不再要第二次');
{
  const P6 = startProjectFromBrief(db, { userId: owner.userId, brief: '截断演示', home: HOME, empty: true });
  const truncated = { stopReason: 'max_tokens', content: [{ type: 'thinking', text: '想了很久…' }], usage: { inputTokens: 10, outputTokens: 8000 } };
  const fake = makeFake([truncated, propose([task('a'), task('b')])]);
  let threw = null;
  try { await planProject(db, { client: new LlmClient({ mode: 'fake', fake }), projectId: P6.projectId }); } catch (e) { threw = e; }
  assert(threw && threw.kind === 'truncated_empty' && threw.infra === true, `抛 truncated_empty（infra）：${threw && threw.message}`);
  assert(/max_tokens/.test(threw.message) && /24000/.test(threw.message), '错误信息说明被谁截断、预算多少');
  eq(project(P6.projectId).draft_version, 0, '草案没动');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_plan_attempt' AND target_id=?`, P6.projectId).n, 0, '不算一次尝试');
  const ex = db.one(`SELECT payload FROM audit_log WHERE action='project_planner_exit' AND target_id=? ORDER BY id DESC LIMIT 1`, P6.projectId);
  assert(ex && JSON.parse(ex.payload).kind === 'failed', '退出记为 failed（守护进程按退避重拉）');
  let exhausted = null; try { fake.nextScripted(); fake.nextScripted(); } catch (e) { exhausted = e; }
  assert(exhausted, '脚本第二条没被消费：只调了一次模型');
}

section('7. 规则出处：没出处 / 引文不在规划里 → 拒；逐字引文 → 收；假设单列；落进宪法带标记');
{
  const brief = '存储层：put(key, value) 覆盖写；get 缺键返回 undefined；先库后 CLI';
  const P7 = startProjectFromBrief(db, { userId: owner.userId, brief, home: HOME, empty: true });
  const noBasis = propose([{ ...task('a'), rules: [{ rule: 'get 缺键返回 undefined' }] }, task('b')]);
  const badQuote = propose([{ ...task('a'), rules: [{ rule: 'get 缺键返回 undefined', quote: 'get 缺键时返回 undefined 值' }] }, task('b')]);
  const good = propose([
    { ...task('a'), rules: [{ rule: 'get 缺键返回 undefined', quote: 'get   缺键返回 undefined' }, { rule: 'key 只许字符串', assumption: '规格没说类型，按最窄取' }] },
    { ...task('b'), rules: [{ rule: 'CLI 退出码 0', quote: 'undefined；先库后 CLI' }] },
  ]);
  const r = await planProject(db, { client: client([noBasis, badQuote, good]), projectId: P7.projectId });
  eq(r.kind, 'proposed', '第三次才合规');
  eq(r.attempts, 3, '前两次被拒');
  const rej = db.all(`SELECT payload FROM audit_log WHERE action='project_plan_attempt' AND target_id=? ORDER BY id`, P7.projectId).map((x) => JSON.parse(x.payload).rejections.join('|'));
  assert(/没有出处/.test(rej[0]), `第一次：没出处 → ${rej[0].slice(0, 80)}`);
  assert(/找不到/.test(rej[1]), `第二次：引文不是子串 → ${rej[1].slice(0, 80)}`);
  const q = db.one(`SELECT text FROM questions WHERE id=(SELECT draft_question FROM projects WHERE id=?)`, P7.projectId).text;
  assert(q.includes('〔规格〕get 缺键返回 undefined ← “get 缺键返回 undefined”'), '批准问题里规则带引文（空白已归一）');
  assert(/规划器假设（[^）]*共 1 条/.test(q) && q.includes('T1 · key 只许字符串'), '假设单列一节，带任务号');
  const c = db.one(`SELECT c.definition_of_done d FROM constitutions c JOIN tasks t ON t.id=c.task_id WHERE t.project_id=? AND t.project_order=1`, P7.projectId).d;
  assert(c.includes('行为规则') && c.includes('〔规格〕get 缺键返回 undefined') && c.includes('〔规划器假设〕key 只许字符串'), '宪法块完成定义带规则与标记');
  eq(validateProjectSpec({ title: 'x', tasks: [task('a'), { ...task('b'), rules: undefined }] }).length, 0, '--file 路径：rules 可省（不 requireRules）');
  eq(validateProjectSpec({ title: 'x', tasks: [{ ...task('a'), rules: [] }] }, { requireRules: true }).length, 1, '规划器路径：rules 为空 → 拒');
}
section('7b. 规则护栏：一条规则只讲一件事 + 规则与引文要有共同字眼');
{
  // 规划原文里这三句是分开的：
  const brief = 'page 缺省为 1，size 缺省为 DEFAULT_PAGE_SIZE；page 不是正整数：HTTP 400，JSON 体 {"code":"BAD_PAGE"}；'
    + '超出末页：items 为空数组，total 照常返回总数';
  const errsOf = (rules) => validateRules(rules, { brief });

  // ① 模式一：一条规则讲四件事，引文只支撑第一件 —— 子串核对轻松过关，拆条护栏拦下
  const multi = [{ rule: 'docs/API.md 说明 page 缺省 1、size 缺省 10；page 非正整数返回 400 BAD_PAGE；超末页返回空数组',
    quote: 'page 缺省为 1，size 缺省为 DEFAULT_PAGE_SIZE' }];
  const e1 = errsOf(multi);
  assert(e1.some((e) => /讲了 3 件事/.test(e)), `多子句规则被拒 → ${(e1[0] ?? '').slice(0, 70)}`);
  assert(e1.some((e) => /拆成 3 条/.test(e)), '错误里直接说怎么改（拆成几条、各带各的出处）');
  eq(errsOf([{ rule: 'page 不是正整数时返回 HTTP 400', quote: 'page 不是正整数：HTTP 400，JSON 体' }]).length, 0,
    '拆开之后：引文自己把"不是正整数"带到了下游眼前');
  eq(errsOf([{ rule: '超出末页时 items 为空数组，total 照常返回总数', quote: '超出末页：items 为空数组，total 照常返回总数' }]).length, 0,
    '"total 照常"那半句也跟着引文一起到场 —— 这正是不拆条时容易被删掉的那句');

  // 分号在成对符号里不算第二条断言（JSON 体、代码片段）
  eq(errsOf([{ rule: 'page 不是正整数时返回 400，体为 {"code":"BAD_PAGE";"msg":"x"}', quote: 'page 不是正整数：HTTP 400，JSON 体' }]).length, 0,
    'JSON / 代码里的分号不算断言分隔');

  // ② 引文与规则几乎没有共同字眼 → 拒
  const alien = errsOf([{ rule: '响应头要带 X-Total-Count', quote: 'page 不是正整数：HTTP 400，JSON 体' }]);
  assert(alien.some((e) => /几乎没有共同字眼/.test(e)), `臆造规则挂无关引文被拒 → ${(alien[0] ?? '').slice(0, 70)}`);
  assert(quoteSim('超出末页时 items 为空数组，total 照常返回', '超出末页：items 为空数组，total 照常返回总数') > 0.8
    && quoteSim('响应头要带 X-Total-Count', 'page 不是正整数：HTTP 400') < 0.2, '重叠率本身分得开好引文与无关引文');
  eq(clausesOf('只有一件事').length, 1, 'clausesOf：单断言');
  eq(clausesOf('page 缺省为 1；size 缺省为 10；……').length, 2, 'clausesOf：太短的尾巴（……、等）不算一条断言');
  // 诚实记一笔：那条挂错引文的规则重叠率 0.188，只比阈值低一点点 —— ② 不是稳健判别器，承重的是 ①
  assert(quoteSim('page 非正整数返回 400 BAD_PAGE', 'page 缺省为 1，size 缺省为 DEFAULT_PAGE_SIZE') < 0.20,
    '挂错引文的那条规则（拆条之后）也落在阈值之下');
}
section('8. 追加：给在跑的项目加尾部任务 —— 批准前不建任务、已有任务不动、回归义务接着累加');
{
  const spec2 = { title: '追加演示', brief: '原规划：做一个库和一个 CLI', tasks: [
    { title: 'T1 库', goal: 'g1', definition_of_done: 'd1', verify_command: 'node --test tests/a.test.mjs' },
    { title: 'T2 CLI', goal: 'g2', definition_of_done: 'd2', verify_command: 'node --test tests/b.test.mjs' }] };
  const X = createProject(db, { userId: owner.userId, spec: spec2, source: SRC, home: HOME });
  const before = JSON.stringify(db.all(`SELECT * FROM constitutions WHERE task_id IN (?,?) ORDER BY id`, ...X.taskIds));
  const mallory = addUser(db, { name: 'mallory8', role: 'member', byUserId: owner.userId });
  let err = null; try { requestAppend(db, { projectId: X.projectId, userId: mallory.userId, brief: 'x' }); } catch (e) { err = e.message; }
  assert(/没有给这个项目添加任务的权限/.test(err ?? ''), '别人不能追加');
  eq(assessProjectPlan(db, project(X.projectId)).reason, 'status:active', '没有追加时：规划器不该拉（与以前一样）');
  const APPEND = '再加一个导出子命令：export --format csv，输出到标准输出';
  const r0 = requestAppend(db, { projectId: X.projectId, userId: owner.userId, brief: APPEND });
  assert(!!r0.carrierId && db.one(`SELECT project_order FROM tasks WHERE id=?`, r0.carrierId).project_order === 0, 'JSON 直接建的项目没有载体任务 → 按需补一个（order 0）');
  eq(appendStateOf(db, X.projectId).stage, 'drafting', '状态：drafting');
  eq(assessProjectPlan(db, project(X.projectId)).reason, 'project-plan:append', '守护进程该拉规划器了');
  // 同一时间仍只有一轮，但第二条不报错拒收 —— 排队，这一轮结束后单独起草
  const rq = requestAppend(db, { projectId: X.projectId, userId: owner.userId, brief: '再来一个没想好的东西，先写着' });
  assert(rq.queued && rq.position === 1 && appendStateOf(db, X.projectId).brief === APPEND, '同一时间只有一轮：第二条排队（第 1 位），当前这一轮不受影响');
  // 第一次不合规（引文不在原文里）→ 回灌；第二次合规（引文出自追加说明）
  const bad = { ...task('T3 导出'), rules: [{ rule: '输出 csv', quote: '这句话哪里都没有出现过' }] };
  const good = { ...task('T3 导出'), rules: [{ rule: '输出到标准输出', quote: 'export --format csv，输出到标准输出' }] };
  let r = await planProject(db, { client: client([propose([bad]), propose([good])]), projectId: X.projectId });
  eq([r.kind, r.attempts, r.version].join('|'), 'proposed|2|1', '不合规回灌一次后出草案 v1（只有一个任务也行：追加不要求 ≥2）');
  eq(projectTasks(db, X.projectId).length, 2, '**批准前不建任务**：链上还是 2 个');
  const q = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  eq([q.task_id, q.decision_type, q.level].join('|'), [r0.carrierId, 'contract_approval', 3].join('|'), '批准事项挂载体任务，方案批准类型，Ⅲ 级');
  assert(/追加 v1/.test(q.text) && /3\. T3 导出/.test(q.text) && /已有任务的契约不变/.test(q.text) && /依赖：#2/.test(q.text) && /规划器假设：无/.test(q.text), '草案正文：编号接着排、写明依赖（缺省 = 前一个）、说明已有任务的契约不变、假设单列');
  eq(assessProjectPlan(db, project(X.projectId)).reason, 'needs_human:proposed', '等人批：不拉');
  eq((await advanceProject(db, { projectId: X.projectId, home: HOME, userId: owner.userId })).reason, 'waiting:planning', '追加期间项目照常推进（不暂停）');
  // 反馈 → v2
  answer(r.questionId, '命令名改成 dump');
  eq(assessProjectPlan(db, project(X.projectId)).reason, 'project-plan:trigger:question_answered', '人答了 → 再拉');
  const good2 = { ...good, title: 'T3 dump' };
  r = await planProject(db, { client: client([propose([good2])]), projectId: X.projectId });
  eq([r.kind, r.version].join('|'), 'proposed|2', '按反馈出 v2');
  // 批准 → 建任务
  answer(r.questionId, 'A');
  r = await planProject(db, { client: client([]), projectId: X.projectId });
  eq(r.kind, 'approved', '批准不调模型');
  const chain = projectTasks(db, X.projectId);
  eq(chain.map((t) => `${t.project_order}:${t.title}`).join(','), '1:T1 库,2:T2 CLI,3:T3 dump', '新任务接在末尾');
  eq(JSON.stringify(getParam(db, chain[2].id, 'task.verify_extra')), JSON.stringify([['node', '--test', 'tests/a.test.mjs'], ['node', '--test', 'tests/b.test.mjs']]), '新任务的回归义务 = 此前全部任务的验收命令，按序');
  eq(JSON.stringify(db.all(`SELECT * FROM constitutions WHERE task_id IN (?,?) ORDER BY id`, ...X.taskIds)), before, '已有任务的契约逐字节不变');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_appended' AND target_id=?`, X.projectId).n >= 1, true, '这一轮批准了');
  const nx = appendStateOf(db, X.projectId);
  eq([nx.stage, nx.brief, nx.queue.length, nx.kind].join('|'), 'drafting|再来一个没想好的东西，先写着|0|append', '批准之后，排着的那条自动开成下一轮（出队）');
  assert(project(X.projectId).brief.includes(APPEND), '追加说明并入项目规划原文（之后的引文核对与 PR 正文都看得到）');
  eq(assessProjectPlan(db, project(X.projectId)).reason, 'project-plan:append', '下一轮等规划器');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_appended' AND target_id=?`, X.projectId).n, 1, '审计 project_appended');
  // 放弃：什么都不加（这一轮就是刚出队的那条）
  r = await planProject(db, { client: client([propose([{ ...task('T4'), rules: [{ rule: 'x', assumption: '没写' }] }])]), projectId: X.projectId });
  answer(r.questionId, 'C');
  r = await planProject(db, { client: client([]), projectId: X.projectId });
  eq([r.kind, projectTasks(db, X.projectId).length].join('|'), 'abandoned|3', '放弃：不追加，链不变');
  eq(assessProjectPlan(db, project(X.projectId)).reason, 'status:active', '队列空了、追加结束：规划器不再拉');
}

section('8b. 追加：全部合并完的项目追加后回到 active；已交付的不再追加');
{
  const X = createProject(db, { userId: owner.userId, spec: { title: '已完成的', brief: '只有一步：做一个库', tasks: [{ title: 'T1', goal: 'g', definition_of_done: 'd', verify_command: 'node --test tests/a.test.mjs' }] }, source: SRC, home: HOME });
  const [t1] = X.taskIds; const ws = join(HOME, 'workspaces', t1);
  writeFileSync(join(ws, 'a.mjs'), 'export const a = 1;\n'); gitc(ws, 'add', '.'); gitc(ws, 'commit', '-q', '-m', 'T1');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, t1);
  signOff(db, { taskId: t1, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  await advanceProject(db, { projectId: X.projectId, home: HOME, userId: owner.userId });
  eq(project(X.projectId).status, 'done', '前提：项目已完成');
  requestAppend(db, { projectId: X.projectId, userId: owner.userId, brief: '再做一个库的命令行包装' });
  let r = await planProject(db, { client: client([propose([{ ...task('T2 包装'), rules: [{ rule: '包装', quote: '再做一个库的命令行包装' }] }])]), projectId: X.projectId });
  eq(project(X.projectId).status, 'done', '批准前项目状态不变');
  answer(r.questionId, '批准');
  await planProject(db, { client: client([]), projectId: X.projectId });
  eq(project(X.projectId).status, 'active', '批准后回到 active');
  const a = await advanceProject(db, { projectId: X.projectId, home: HOME, userId: owner.userId });
  eq(a.reason, 'workspace_created', '推进：给新任务建工作区（从含 T1 的项目分支起）');
  assert(existsSync(join(HOME, 'workspaces', a.taskId, 'a.mjs')), '新任务看得到 T1 的产物');
  // 已交付的项目照样能追加（初版交付之后应当允许持续维护迭代，而不是彻底结束、让人新建项目）
  const Y = createProject(db, { userId: owner.userId, spec: { title: '已交付的', tasks: [{ title: 'T1', goal: 'g', definition_of_done: 'd', verify_command: 'node --test tests/a.test.mjs' }] }, source: SRC, home: HOME });
  db.run(`UPDATE projects SET status='done' WHERE id=?`, Y.projectId);
  db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,?,?,?,?,?,?)`, now(), 'user', owner.userId, 'project_delivered', 'project', Y.projectId, '{}');
  let err = null; try { requestAppend(db, { projectId: Y.projectId, userId: owner.userId, brief: '交付之后的第一个维护需求' }); } catch (e) { err = e.message; }
  eq(err, null, '已交付的项目：照样能添加任务（持续维护迭代）');
  eq(appendStateOf(db, Y.projectId).brief, '交付之后的第一个维护需求', '开了一轮追加');
}

section('9. 新建项目：目标 + 完成定义必填；没有规划 → 第一个任务从目标起草，出生就在项目里');
{
  let err = null; try { startProject(db, { userId: owner.userId, goal: ' ', doneDefinition: 'x', source: SRC, home: HOME }); } catch (e) { err = e.message; }
  assert(/项目目标不能为空/.test(err ?? ''), '没写目标 → 拒');
  err = null; try { startProject(db, { userId: owner.userId, goal: 'x', doneDefinition: '', source: SRC, home: HOME }); } catch (e) { err = e.message; }
  assert(/完成定义不能为空/.test(err ?? ''), '没写完成定义 → 拒');
  err = null; try { startProject(db, { userId: owner.userId, goal: 'x', doneDefinition: 'y', source: join(TMP, 'nope'), home: HOME }); } catch (e) { err = e.message; }
  assert(!!err, '仓库克隆不了 → 当场报错（不是等到契约批准后）');
  eq(db.one(`SELECT count(*) n FROM projects WHERE goal='x'`).n, 0, '报错时不留半截项目');

  const S = startProject(db, { userId: owner.userId, goal: '给 demo 加一个 slugify 函数', doneDefinition: 'node --test 全过', source: SRC, home: HOME });
  const p = project(S.projectId);
  eq([p.status, p.goal, p.done_definition, p.visibility].join('|'), 'active|给 demo 加一个 slugify 函数|node --test 全过|all', '项目 active；目标 / 完成定义落库；默认所有成员可见');
  assert(p.brief.includes('给 demo 加一个 slugify 函数') && p.brief.includes('node --test 全过'), 'brief = 目标 + 完成定义（之后添加任务时规划器引文核对的原文）');
  assert(existsSync(join(S.repo, 'README.md')), '仓库当场克隆');
  const t1 = db.one(`SELECT * FROM tasks WHERE id=?`, S.firstTaskId);
  eq([t1.project_id, t1.project_order, t1.status].join('|'), [S.projectId, 1, 'planning'].join('|'), '第一个任务出生就在项目里（order 1）');
  eq(getParam(db, t1.id, 'draft.stage'), 'asking', '走追问器');
  eq(getParam(db, t1.id, 'draft.source') ?? null, null, '仓库住在项目上，任务不记 draft.source');
  const elicit = (args) => call('propose_constitution', { title: 'slugify', goal: 'g', scope: 's', scope_paths: ['src/slug.mjs'], definition_of_done: 'd', constraints: [], verify_command: 'node --test tests/slug.test.mjs', notes: '', ...args });
  let r = await draft(db, { client: client([elicit({})]), taskId: t1.id });
  eq(r.kind, 'proposed', '追问器出契约草案');
  answer(r.questionId, 'A');
  r = await draft(db, { client: client([]), taskId: t1.id });
  eq(r.kind, 'approved', '批准一次');
  const adv = await advanceProject(db, { projectId: S.projectId, home: HOME });
  eq(adv.reason, 'workspace_created', 'advanceProject 从项目分支建工作区');
  eq(git(join(HOME, 'workspaces', t1.id), 'rev-parse', 'HEAD'), p.base_ref, '工作区起点 = 项目分支头');

  // 规划模式：目标照样落库，走原来的 proposed 流程
  const S2 = startProject(db, { userId: owner.userId, goal: '两步走', doneDefinition: '两个任务都合并', plan: '# 规划\n先做 A，再做 B', source: SRC, home: HOME });
  eq([project(S2.projectId).status, project(S2.projectId).goal, S2.planned].join('|'), 'proposed|两步走|true', '有规划 → proposed + 载体任务，目标落库');
  err = null; try { startProject(db, { userId: owner.userId, goal: 'g', doneDefinition: 'd', plan: '  ', source: SRC, home: HOME }); } catch (e) { err = e.message; }
  assert(/规划全文为空/.test(err ?? ''), '勾了规划却没写 → 拒');

  // 唯一的任务在草案阶段被放弃 → 项目直接中止（没有可重做的契约）
  const S3 = startProject(db, { userId: owner.userId, goal: '会被放弃的', doneDefinition: 'd', empty: true, home: HOME });
  r = await draft(db, { client: client([elicit({})]), taskId: S3.firstTaskId });
  answer(r.questionId, 'C');
  await draft(db, { client: client([]), taskId: S3.firstTaskId });
  const adv3 = await advanceProject(db, { projectId: S3.projectId, home: HOME });
  eq([adv3.reason, project(S3.projectId).status].join('|'), 'draft_abandoned|aborted', '草案被放弃 → 项目 aborted，不进"停滞"');
}

section('9b. 项目权限：成员名单、"可添加任务"、可见性、改目标');
{
  const S = startProject(db, { userId: owner.userId, goal: '权限演示', doneDefinition: 'd', source: SRC, home: HOME });
  const pm = addUser(db, { name: '产品', role: 'member', byUserId: owner.userId });
  const fe = addUser(db, { name: '前端', role: 'member', byUserId: owner.userId });
  const ob = addUser(db, { name: '旁观', role: 'observer', byUserId: owner.userId });
  eq(canAddTasks(db, S.projectId, pm.userId), false, '默认：成员不能加任务');
  let err = null; try { requestAppend(db, { projectId: S.projectId, userId: pm.userId, brief: '加个导出' }); } catch (e) { err = e.message; }
  assert(/没有给这个项目添加任务的权限/.test(err ?? ''), '没授权的人加任务 → 拒');
  err = null; try { setMember(db, { projectId: S.projectId, userId: pm.userId, canAddTasks: true, by: pm.userId }); } catch (e) { err = e.message; }
  assert(/只有该项目的负责人/.test(err ?? ''), '成员不能给自己授权');
  setMember(db, { projectId: S.projectId, userId: pm.userId, canAddTasks: true, note: '产品：提需求、验收面向用户的行为', by: owner.userId });
  eq(canAddTasks(db, S.projectId, pm.userId), true, '负责人授予后能加');
  eq(listMembers(db, S.projectId).map((m) => [m.name, m.canAddTasks, m.note].join(':')).join(','), '产品:true:产品：提需求、验收面向用户的行为', '成员名单带职能说明');
  const A = requestAppend(db, { projectId: S.projectId, userId: pm.userId, brief: '再加一个导出函数 kebab' });
  assert(!!A.carrierId, '被授权的成员只描述，就能提交添加任务');
  let r = await planProject(db, { client: client([propose([{ ...task('T kebab'), rules: [{ rule: 'kebab', quote: '再加一个导出函数 kebab' }] }])]), projectId: S.projectId });
  eq(r.kind, 'proposed', '规划器出草案');
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, r.questionId).addressed_to).join(','), owner.userId, '草案的批准仍送负责人：成员提、负责人批');
  err = null; try { setMember(db, { projectId: S.projectId, userId: ob.userId, canAddTasks: true, by: owner.userId }); } catch (e) { err = e.message; }
  assert(/旁观者不能添加任务/.test(err ?? ''), '旁观者不能被授予加任务');
  err = null; try { setMember(db, { projectId: S.projectId, userId: owner.userId, by: owner.userId }); } catch (e) { err = e.message; }
  assert(/负责人不需要加入/.test(err ?? ''), '负责人不进成员名单');

  // 可见性
  eq([canSeeProject(db, S.projectId, fe.userId), canSeeProject(db, S.projectId, null)].join(','), 'true,true', "默认 'all'：谁都看得见");
  setVisibility(db, { projectId: S.projectId, visibility: 'members', by: owner.userId });
  eq([canSeeProject(db, S.projectId, owner.userId), canSeeProject(db, S.projectId, pm.userId), canSeeProject(db, S.projectId, fe.userId), canSeeProject(db, S.projectId, null)].join(','),
    'true,true,false,false', "'members'：负责人、成员看得见；无关的人与匿名看不见");
  eq(canSeeTask(db, S.firstTaskId, fe.userId), false, '任务的可见性跟随项目');
  setMember(db, { projectId: S.projectId, userId: ob.userId, by: owner.userId });
  eq(canSeeProject(db, S.projectId, ob.userId), true, '旁观者可以被加为成员（只为看得见）');
  setUserRole(db, { userId: fe.userId, role: 'lead', byUserId: owner.userId });
  eq([canSeeProject(db, S.projectId, fe.userId), canAddTasks(db, S.projectId, fe.userId)].join(','), 'true,false', '管理员看得见所有项目，但对不属于自己的项目没有写权限');
  // 被待决事项点到的人看得见（否则事项送到了人却打不开）
  const be = addUser(db, { name: '后端', role: 'member', byUserId: owner.userId });
  eq(involvedIn(db, S.projectId, be.userId), false, '无关');
  db.run(`UPDATE questions SET addressed_to=? WHERE id=?`, JSON.stringify([owner.userId, be.userId]), r.questionId);
  eq([involvedIn(db, S.projectId, be.userId), canSeeProject(db, S.projectId, be.userId)].join(','), 'true,true', '被事项点到 → 有关、看得见');
  removeMember(db, { projectId: S.projectId, userId: pm.userId, by: owner.userId });
  eq([canAddTasks(db, S.projectId, pm.userId), canSeeProject(db, S.projectId, pm.userId)].join(','), 'false,false', '移出成员 → 权限与可见性一起收回');
  err = null; try { setVisibility(db, { projectId: S.projectId, visibility: 'secret', by: owner.userId }); } catch (e) { err = e.message; }
  assert(/可见性只能是/.test(err ?? ''), '非法可见性 → 拒');

  // 改目标：只改文字、留前后全文、不动契约
  err = null; try { editProjectGoal(db, { projectId: S.projectId, goal: '', by: owner.userId }); } catch (e) { err = e.message; }
  assert(/项目目标不能为空/.test(err ?? ''), '目标不能改成空');
  const g = editProjectGoal(db, { projectId: S.projectId, doneDefinition: '两个导出都有测试', by: owner.userId });
  const au = db.one(`SELECT payload FROM audit_log WHERE action='project_goal_changed' AND target_id=? ORDER BY id DESC LIMIT 1`, S.projectId);
  eq([g.changed, project(S.projectId).done_definition, JSON.parse(au.payload).before.doneDefinition].join('|'), 'true|两个导出都有测试|d', '完成定义已改，审计留前后全文');
}

section('10. 依赖关系：规划器写 depends_on，草案写明，护栏拒掉不成立的边');
{
  const S = startProject(db, { userId: owner.userId, goal: '前后端', doneDefinition: '端到端通过', plan: '# 规划：接口约定、后端、前端、端到端', source: SRC, home: HOME });
  const mk = (t, extra) => ({ ...task(t), rules: [{ rule: t, quote: '接口约定、后端、前端、端到端' }], ...extra });
  // 第一次：后端依赖了编号更大的任务 + 用了 blocks → 回灌；第二次合规
  let r = await planProject(db, { client: client([
    propose([mk('A 约定', { depends_on: [] }), mk('B 后端', { depends_on: [3] }), mk('C 前端', { depends_on: [1], blocks: [2] }), mk('D 端到端', { depends_on: [2, 3] })]),
    propose([mk('A 约定', { depends_on: [] }), mk('B 后端', { depends_on: [1] }), mk('C 前端', { depends_on: [1] }), mk('D 端到端', { depends_on: [2, 3] })], { }),
  ]), projectId: S.projectId });
  eq(r.kind, 'proposed', '不成立的边被护栏回灌后，第二次合规');
  const rej = JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action LIKE 'project_plan%' AND target_id=? AND payload LIKE '%rejections%' ORDER BY id DESC LIMIT 1`, S.projectId)?.payload ?? '{}').rejections ?? [];
  assert(rej.some((e) => /只能依赖已有任务或本草案里排在前面的/.test(e)) && rej.some((e) => /首次规划不要用 blocks/.test(e)), '拒因写明：依赖了后面的任务；首次规划不用 blocks');
  const NL = String.fromCharCode(10);
  assert(r.text.includes(`2. B 后端${NL}   依赖：#1`) && r.text.includes(`4. D 端到端${NL}   依赖：#2、#3`) && r.text.includes(`1. A 约定${NL}   依赖：无`), '草案正文逐个写明依赖');
  assert(/依赖关系不对，直接在反馈里说/.test(r.text), '草案告诉人：依赖不对就在反馈里说');
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  eq(JSON.stringify(projectTasks(db, S.projectId).map((t) => t.dependsOn)), JSON.stringify([[], [1], [1], [2, 3]]), '批准后依赖落库（菱形）');
  // 添加任务：依赖已有任务的编号；独立模块写 []
  requestAppend(db, { projectId: S.projectId, userId: owner.userId, brief: '再加一个独立的健康检查接口 /healthz' });
  r = await planProject(db, { client: client([propose([{ ...task('E 健康检查'), rules: [{ rule: 'healthz', quote: '再加一个独立的健康检查接口 /healthz' }], depends_on: [] }])]), projectId: S.projectId });
  assert(r.text.includes(`5. E 健康检查${NL}   依赖：无（不等其他任务）`), '添加的独立任务：依赖 = 无');
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  eq(JSON.stringify(projectTasks(db, S.projectId).find((t) => t.project_order === 5).dependsOn), '[]', '#5 不依赖任何任务：不用等前面四个做完');
}

section('11. 复盘：全部合并 → 规划器对照目标 → 下一批 / 已达成 → 人点头');
{
  const S = startProject(db, { userId: owner.userId, goal: '做一个 kv 库并带上命令行', doneDefinition: '库有 get/set，CLI 有 kv get 与 kv set', plan: '# 规划\n先做库 get 与 set，再做命令行 kv get 与 kv set', source: SRC, home: HOME });
  const mk = (t) => ({ ...task(t), rules: [{ rule: '先做库 get 与 set，再做命令行 kv get 与 kv set', quote: '先做库 get 与 set，再做命令行 kv get 与 kv set' }] });
  let r = await planProject(db, { client: client([propose([mk('T1 库'), mk('T2 CLI')])]), projectId: S.projectId });
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  const merged = () => db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);
  merged();

  // ① 全部合并 ≠ 项目完成。**契约兑现**与**目标兑现**是两件事，中间差的就是当初切任务时想漏的那部分。
  let adv = await advanceProject(db, { projectId: S.projectId, home: HOME });
  eq(adv.reason, 'review_requested', '全部合并 → 发起复盘，不是直接 done');
  eq(project(S.projectId).status, 'active', '项目还没 done');
  const st0 = appendStateOf(db, S.projectId);
  eq(`${st0.kind}|${st0.stage}`, 'review|drafting', '复盘就是一次特殊的追加：同一套 append.* 状态，kind=review');
  eq(assessProjectPlan(db, project(S.projectId), { alive: dead }).reason, 'project-plan:append', '守护进程：该拉规划器了');
  adv = await advanceProject(db, { projectId: S.projectId, home: HOME });
  eq(adv.reason, 'review:drafting', '复盘在跑时 advanceProject 不再重复发起');

  // ② 规划器说"还差一块" → 走添加任务那条路（草案 → 人批 → 建任务）
  r = await planProject(db, { client: client([propose([{ ...task('T3 文档'), rules: [{ rule: '先做库 get 与 set，再做命令行 kv get 与 kv set', quote: '先做库 get 与 set，再做命令行 kv get 与 kv set' }] }])]), projectId: S.projectId });
  eq(r.kind, 'proposed', '复盘给出下一批 → 一条方案批准事项');
  eq(r.reached, false, '这一版不是"已达成"');
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, r.questionId).addressed_to).join(','), owner.userId, '送负责人');
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  eq(projectTasks(db, S.projectId).length, 3, '批准后新任务落库');
  eq(projectTasks(db, S.projectId).find((t) => t.project_order === 3).merged_at, null, '新任务还没合并 —— 项目又有事做了');

  // ③ 再次全部合并 → 再复盘；这次规划器说"已达成"
  merged();
  adv = await advanceProject(db, { projectId: S.projectId, home: HOME });
  eq(adv.reason, 'review_requested', '又没事做了 → 再复盘一次');
  r = await planProject(db, { client: client([call('project_goal_reached', { reason: 'T1 给了 get/set，T2 给了 kv get 与 kv set，T3 写了用法', unverified: ['get 在键不存在时返回什么，契约里没写死'] })]), projectId: S.projectId });
  eq(r.kind, 'proposed', '达成也要人点头 —— 它是一条事项，不是一个状态转换');
  eq(r.reached, true, '这一版是"已达成"');
  assert(/【项目达成确认 v\d+】/.test(r.text), '正文标题写明是达成确认');
  assert(/规划器无法确认的（1 条；/.test(r.text) && /键不存在时返回什么/.test(r.text), '说不准的那条单列出来 —— 别让"已达成"三个字把它盖住');
  assert(/没有填项目级验收命令/.test(r.text) && /完全由你这一下决定/.test(r.text), '没有机械验收时把这件事说穿');

  // ④ 人回 B（还差东西）→ 旧的达成结论作废，按反馈重来
  answer(r.questionId, '还差一个 kv del');
  r = await planProject(db, { client: client([propose([{ ...task('T4 删除'), rules: [{ rule: '先做库 get 与 set，再做命令行 kv get 与 kv set', quote: '先做库 get 与 set，再做命令行 kv get 与 kv set' }] }])]), projectId: S.projectId });
  eq(r.reached, false, '人说还差东西 → 下一版是任务，不再是达成');
  eq(getParam(db, st0.carrierId, 'append.reached'), null, '旧的达成结论被清掉，不会被后来的 A 误认');
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  merged();

  // ⑤ 再来一次：达成 + 人点头 → 项目 done
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  r = await planProject(db, { client: client([call('project_goal_reached', { reason: '四个任务覆盖了完成定义的每一条', unverified: [] })]), projectId: S.projectId });
  assert(/规划器无法确认的：无/.test(r.text), '没有说不准的也要明说"无"，不是省略');
  answer(r.questionId, 'A');
  const rr = await planProject(db, { client: client([]), projectId: S.projectId });
  eq(rr.kind, 'reached', '人点头 → 记结论；跑验收命令归 advanceProject（它才有仓库与沙箱）');
  eq(project(S.projectId).status, 'active', '这一刻还没 done —— 结论与机械核实分两处，各留一条痕迹');
  adv = await advanceProject(db, { projectId: S.projectId, home: HOME });
  eq(adv.reason, 'goal_reached', '没有项目级验收命令 → 直接收口');
  eq(project(S.projectId).status, 'done', '项目 done');
  eq(adv.verify.skipped, true, '如实记：这次没有机械核实');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_goal_declared' AND target_id=?`, S.projectId).n, 1, '"达成由谁宣布"进审计');
}

section('11b. 复盘的两条边界：没有目标的项目走老路；人回 C 就停在那儿等人');
{
  // 没有目标 = 没有判据。JSON 建的项目（project new --file）与没有目标字段时建的老项目都在此列：
  // 复盘的判据就是"对照目标与完成定义"，拿什么去复盘都是编的 —— 退回老口径：全部合并 = 完成。
  const J = createProject(db, { userId: owner.userId, home: HOME, source: SRC,
    spec: { title: '无目标项目', tasks: [task('J1')] } });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), J.projectId);
  const adv = await advanceProject(db, { projectId: J.projectId, home: HOME });
  eq(adv.reason, 'all_merged', '没有项目目标 → 全部合并就是完成，不拉规划器');
  eq(project(J.projectId).status, 'done', '项目 done');

  // 人回 C：不是完成，也不是失败 —— 它在等人。
  const S = startProject(db, { userId: owner.userId, goal: '会被搁置的', doneDefinition: 'd', plan: '# 规划\n这个项目只做一件事，做完就收工', source: SRC, home: HOME });
  let r = await planProject(db, { client: client([propose([{ ...task('K1'), rules: [{ rule: '这个项目只做一件事，做完就收工', quote: '这个项目只做一件事，做完就收工' }] }, { ...task('K2'), rules: [{ rule: '这个项目只做一件事，做完就收工', quote: '这个项目只做一件事，做完就收工' }] }])]), projectId: S.projectId });
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  r = await planProject(db, { client: client([call('project_goal_reached', { reason: '做完了', unverified: [] })]), projectId: S.projectId });
  answer(r.questionId, 'C');
  const rr = await planProject(db, { client: client([]), projectId: S.projectId });
  eq(rr.kind, 'abandoned', '回 C = 先放着');
  const adv2 = await advanceProject(db, { projectId: S.projectId, home: HOME });
  eq(adv2.reason, 'review_abandoned', 'advanceProject 认这个结论');
  eq(project(S.projectId).status, 'stalled', '项目停滞等人：添加任务 / 宣布达成 / 中止项目');
  assert(/复盘被搁置/.test(JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='project_stalled' AND target_id=? ORDER BY id DESC LIMIT 1`, S.projectId).payload).why), '停滞的理由说清了');
}

section('11c. 复盘时规划器只有两个出口，两个都选或一个都不选都回灌');
{
  const S = startProject(db, { userId: owner.userId, goal: '两个出口', doneDefinition: 'd', plan: '# 规划\n这个项目只做一件事，做完就收工', source: SRC, home: HOME });
  let r = await planProject(db, { client: client([propose([{ ...task('M1'), rules: [{ rule: '这个项目只做一件事，做完就收工', quote: '这个项目只做一件事，做完就收工' }] }, { ...task('M2'), rules: [{ rule: '这个项目只做一件事，做完就收工', quote: '这个项目只做一件事，做完就收工' }] }])]), projectId: S.projectId });
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  const both = { stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 },
    content: [{ type: 'tool_call', id: 'a', name: 'propose_project', args: { title: 't', tasks: [task('X')], notes: '' } },
      { type: 'tool_call', id: 'b', name: 'project_goal_reached', args: { reason: '也达成了', unverified: [] } }] };
  const noReason = call('project_goal_reached', { reason: '   ', unverified: [] });
  r = await planProject(db, { client: client([both, noReason, call('project_goal_reached', { reason: '两个任务覆盖了完成定义', unverified: [] })]), projectId: S.projectId });
  eq(r.reached, true, '回灌两次后给出合规的达成结论');
  const rej = db.all(`SELECT payload FROM audit_log WHERE action='project_plan_attempt' AND target_id=? ORDER BY id`, S.projectId).map((x) => JSON.parse(x.payload).rejections.join('｜'));
  assert(rej.some((e) => /两个出口只能选一个/.test(e)), '两个都调 → 拒');
  assert(rej.some((e) => /缺 reason/.test(e)), '声明达成却不说理由 → 拒');
}

section('11d. 自动挡：草案直接开工、事后通知、签收后置；与已定约定冲突就退回提议挡');
{
  const S = startProject(db, { userId: owner.userId, goal: '自动挡演示', doneDefinition: 'd', plan: '# 规划\n这个项目只做一件事，做完就收工', source: SRC, home: HOME });
  const mk = (t) => ({ ...task(t), rules: [{ rule: '这个项目只做一件事，做完就收工', quote: '这个项目只做一件事，做完就收工' }] });
  // 契约批准会把规则写进决定登记表，所以自动挡每落一批都要先比对一次 —— 脚本里配一条"没命中"。
  const noHit = { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'text', text: '{"hits":[]}' }] };
  let r = await planProject(db, { client: client([propose([mk('A1'), mk('A2')])]), projectId: S.projectId });
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  // 首次规划永远要人批：那是人自己新建的项目，挡位是之后才设的。
  setProjectBudget(db, { projectId: S.projectId, microUsd: 5_000_000, userId: owner.userId });
  setProjectVerify(db, { projectId: S.projectId, command: 'node tests/run.mjs --all', userId: owner.userId });
  setGear(db, { projectId: S.projectId, gear: 'auto', userId: owner.userId });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);

  // ① 复盘给出下一批 → 自动挡直接建任务，不建批准事项
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  r = await planProject(db, { client: client([propose([mk('A3')]), noHit]), projectId: S.projectId });
  eq(r.kind, 'approved', '自动挡：草案直接落地，不进"等人批"');
  eq(r.auto, true, '标明是自动挡落的');
  eq(projectTasks(db, S.projectId).length, 3, '新任务建出来了');
  eq(db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND status='open'`, appendStateOf(db, S.projectId).carrierId).n, 0, '没有开着的批准事项');
  const t3 = projectTasks(db, S.projectId).find((t) => t.project_order === 3);
  eq(getParam(db, t3.id, 'task.auto_added'), true, '打上"AI 自己加的"标记 —— 后置签收凭它区分人加的与 AI 加的');
  eq(JSON.stringify(getParam(db, appendStateOf(db, S.projectId).carrierId, 'append.spec')?.tasks?.length), '1', '草案原文仍存着：没有批准事项就没有那份正文');
  const au = db.one(`SELECT payload FROM audit_log WHERE action='project_auto_batch' AND target_id=? ORDER BY id DESC LIMIT 1`, S.projectId);
  assert(!!au && JSON.parse(au.payload).review === true, '留一条审计，标明是复盘给出的');

  // ② 事后通知：摘要里看得见
  const d = buildDigest(db, { userId: owner.userId });
  eq(d.autoBatches.length, 1, '摘要里有一条"自动挡替你开工了"');
  eq(d.autoBatches[0].count, 1, '数目对');
  const txt = renderDigest(d);
  assert(/自动挡替你开工了 1 个任务/.test(txt) && /随时可中止/.test(txt), '正文说清了：不用你批，但你现在知道了');
  assert(new RegExp(`project gear ${S.projectId} propose`).test(txt), '给出叫停的那条命令');

  // ③ 后置签收：AI 加的任务签收被后置，人加的不受影响
  eq(deferSignoff(db, t3.id), true, 'AI 自己加的 → 后置');
  eq(deferSignoff(db, projectTasks(db, S.projectId)[0].id), false, '人批过的那两个 → 照旧逐个签收');
  raiseSignoffQuestion(db, { taskId: t3.id, head: 'deadbeef', branch: 'b' });
  eq(db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND decision_type='signoff'`, t3.id).n, 0, '不弹签收事项');
  eq(getParam(db, t3.id, 'signoff.status'), 'deferred', '记成 deferred');
  eq(deferredSignoffs(db, S.projectId).map((t) => t.project_order).join(','), '3', '攒在项目的后置签收清单里');
  // 挡位掉回提议 → 下一个完成的任务立刻恢复逐个签收（自动挡不是一个库里的开关，是四条前提的合取）
  setGear(db, { projectId: S.projectId, gear: 'propose', userId: owner.userId });
  eq(deferSignoff(db, t3.id), false, '挡位一掉回来，后置就不成立了');
  setGear(db, { projectId: S.projectId, gear: 'auto', userId: owner.userId });

  // ④ 交付前必须一次签掉 —— 交付是爆炸半径的真正边界
  db.run(`UPDATE tasks SET merged_at=? WHERE id=?`, now(), t3.id);
  db.run(`UPDATE projects SET status='done' WHERE id=?`, S.projectId);
  let err = null;
  try { await deliverProject(db, { projectId: S.projectId, remote: join(TMP, 'nope'), userId: owner.userId }); } catch (e) { err = e.message; }
  assert(/还有 1 个任务的签收被后置了/.test(err ?? '') && /--accept-pending/.test(err ?? ''), '不清掉就拒绝交付，并说清是哪几个、怎么清');
  const acc = acceptDeferredSignoffs(db, { projectId: S.projectId, userId: owner.userId });
  eq(acc.accepted, 1, '一次签掉');
  eq(getParam(db, t3.id, 'signoff.status'), 'accepted', '状态变成 accepted');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='task_signed_off' AND target_id=?`, t3.id).n, 1, '每个任务各留一条 task_signed_off —— 批量与逐个必须一样查得到');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_signoff_batch' AND target_id=?`, S.projectId).n, 1, '另有一条标明它们是一次点掉的');
  eq(deferredSignoffs(db, S.projectId).length, 0, '清单空了');
  db.run(`UPDATE projects SET status='active' WHERE id=?`, S.projectId);
}

section('11e. 自动挡的第四条前提：与有效决定清单冲突 → 这一批退回提议挡');
{
  const S = startProject(db, { userId: owner.userId, goal: '第四条前提', doneDefinition: 'd', plan: '# 规划\n这个项目只做一件事，做完就收工', source: SRC, home: HOME });
  const mk = (t) => ({ ...task(t), rules: [{ rule: '这个项目只做一件事，做完就收工', quote: '这个项目只做一件事，做完就收工' }] });
  let r = await planProject(db, { client: client([propose([mk('B1'), mk('B2')])]), projectId: S.projectId });
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  setProjectBudget(db, { projectId: S.projectId, microUsd: 5_000_000, userId: owner.userId });
  setProjectVerify(db, { projectId: S.projectId, command: 'npm test', userId: owner.userId });
  setGear(db, { projectId: S.projectId, gear: 'auto', userId: owner.userId });
  // 清单里放一条人拍过板的约定
  const decId = record(db, { projectId: S.projectId, subject: '缺省每页条数', statement: 'DEFAULT_PAGE_SIZE = 10，不许改', sourceKind: 'question', decidedBy: owner.userId });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  // 假模型两次调用：① 规划器出草案（重档）② 比对器回一条命中（轻档）
  const hit = { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 },
    content: [{ type: 'text', text: JSON.stringify({ hits: [{ id: decId, confidence: 0.9, why: '新任务要把缺省页大小改成 20' }] }) }] };
  r = await planProject(db, { client: client([propose([mk('B3')]), hit]), projectId: S.projectId });
  eq(r.kind, 'proposed', '命中 → 这一批退回提议挡，等人批');
  eq(r.auto, undefined, '不是自动落的');
  assert(/【本该自动开工，但退回给你批】/.test(r.text), '正文开头就说清为什么没自动开工');
  assert(/缺省每页条数/.test(r.text) && /新任务要把缺省页大小改成 20/.test(r.text), '把撞上的那条约定与理由列出来');
  assert(/不由系统替你拍板/.test(r.text), '说清系统的立场：有争议的东西不由自动挡替人拍');
  eq(projectTasks(db, S.projectId).length, 2, '没有建任务 —— 等人批');

  // 比对跑不成 → 也退回提议挡（多问一次是一条待办，少问一次是一批没人看过的任务直接开工）
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  const garbage = { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'text', text: '我不知道' }] };
  r = await planProject(db, { client: client([propose([mk('B4')]), garbage, garbage]), projectId: S.projectId });
  eq(r.kind, 'proposed', '比对解析不出来 → 不自动开工');
  assert(/比对这次没跑成/.test(r.text) && /不等于没有冲突/.test(r.text), '说清这不是"没有冲突"');
}

section('CLI 打印那几行：不同来路的 outcome 形状不一样，打印不能假设字段都在');
{
  // `kind:'proposed'` 从新建项目那条路来时带 tasks，从追加 / 复盘那条路来时不带。
  // cli 无条件读 `r.tasks.length` → 追加与复盘每出一版草案，`project plan` 必崩，
  // 而且崩得看不出来：库里该写的都写完了、事项也发出去了，只有那一行打印炸掉。
  const P = 'pj_x';
  const fresh = renderPlanOutcome({ kind: 'proposed', version: 1, questionId: 'q_1', text: '草案正文', tasks: ['t_a', 't_b'] }, { projectId: P }).join('\n');
  assert(/2 个任务/.test(fresh) && /q_1/.test(fresh), '新建项目那条路：说得出几个任务');
  const appended = renderPlanOutcome({ kind: 'proposed', version: 2, questionId: 'q_2', text: '追加草案正文' }, { projectId: P }).join('\n');
  assert(/q_2/.test(appended) && /追加草案正文/.test(appended), '追加那条路没有 tasks 也照样印得出来（不再崩）');
  assert(!/undefined|NaN/.test(appended), '不能印出 undefined / NaN');
  const reached = renderPlanOutcome({ kind: 'proposed', reached: true, version: 1, questionId: 'q_3', text: '达成确认正文' }, { projectId: P }).join('\n');
  assert(/达成确认/.test(reached), '达成确认与契约草案不是同一句话');
  assert(!/个任务/.test(reached), '达成确认里本来就没有任务，别印"0 个任务"');
  const auto = renderPlanOutcome({ kind: 'approved', auto: true, review: true, version: 2, tasks: ['t_a', 't_b', 't_c'], startOrder: 5 }, { projectId: P }).join('\n');
  assert(/没经人手/.test(auto) && /3 个/.test(auto) && /#5/.test(auto), '自动挡批准要说清"没经人手"和开了几个');
  for (const r of [{ kind: 'noop', why: '项目 done' }, { kind: 'abandoned' }, { kind: 'reached', version: 1 }]) {
    const s = renderPlanOutcome(r, { projectId: P }).join('\n');
    assert(s.trim().length > 0 && !/undefined/.test(s), `${r.kind} 也印得出一句人话`);
  }
}


section('12. 范围重叠预警：可能同时开着 + 声明要动同一处 → 报，但不拦');
{
  const T = (n, scope, deps) => ({ title: `T${n}`, goal: 'g', scope, definition_of_done: 'd', depends_on: deps,
    rules: [], constraints: [], verify_command: 'node --test' });

  // 典型的一对：两个互不依赖的任务都要写根 package.json 的 scripts
  const real = { tasks: [
    T(1, 'src/storage/ 目录；不改根 package.json', []),
    T(2, 'server/ 目录与根 package.json 的 scripts', []),
    T(3, 'client/ 目录与根 package.json 的 scripts', []),
  ] };
  let ov = scopeOverlaps(real);
  eq(ov.length, 1, '三对里只报该报的那一对');
  eq(`${ov[0].a}-${ov[0].b}`, '2-3', '报的是 #2 与 #3');
  eq(JSON.stringify(ov[0].where), JSON.stringify(['package.json']), '说得出撞在哪儿');
  assert(!ov.some((x) => x.a === 1 || x.b === 1), '**"不改根 package.json" 这种否定从句没有被算成声明** —— 精度上限就在这句话上（见 prefixesOfScope）');

  // 三条不报的理由，各一例
  eq(scopeOverlaps({ tasks: [T(1, 'src/a/ 与 package.json', []), T(2, 'src/b/ 与 package.json', [1])] }).length, 0,
    '有依赖关系 → 一定有先后，不可能同时开着，不报');
  eq(scopeOverlaps({ tasks: [T(1, 'src/a/ 目录', []), T(2, 'src/b/ 目录', [])] }).length, 0, '范围不相交 → 不报');
  eq(scopeOverlaps({ tasks: [T(1, 'src/a/ 目录', []), T(2, 'src/a/sub/ 目录', [])] }).length, 1, '目录互为前缀也算相交');
  // 不写 depends_on = 线性（与 renderDeps / defaultDeps 同一个缺省），所以整条链互相可达
  eq(scopeOverlaps({ tasks: [T(1, 'src/a/ 与 package.json'), T(2, 'src/b/ 与 package.json'), T(3, 'src/c/ 与 package.json')] }).length, 0,
    '没写 depends_on 的缺省是线性链 —— 缺省口径必须和 defaultDeps 一致，不然这条预警会满屏误报');
  // 追加：编号从 startOrder 起
  const app = scopeOverlaps({ tasks: [T(4, 'docs/ 与 README.md', []), T(5, 'docs/api/ 目录', [])] }, { startAt: 4 });
  eq(`${app[0].a}-${app[0].b}`, '4-5', '追加那一批的编号从 startOrder 起算');

  // 渲染：**带动作的问句**，不是一行灰字。批准页已经是注意力过载的页面。
  const txt = renderScopeOverlaps(ov);
  assert(/#2「T2」与 #3「T3」都声明要动：package\.json/.test(txt), '点名是哪两个、撞在哪儿');
  assert(/要不要现在就处理？\*\*在反馈里回一句就行\*\*/.test(txt), '是个要求人做动作的问句');
  assert(/把 #3 对 package\.json 的改动并进 #2/.test(txt), '第一条建议是可以照抄回去的原话，不是"请注意"');
  assert(/「知道了，就这样」/.test(txt), '**接受这个风险也是一条明写的选项** —— 这是预警不是闸门');
  eq(renderScopeOverlaps([]), null, '没有重叠就什么也不加');

  // 上线到批准页：上限 > 1 才给（串行下这条提示是噪声）
  assert(renderProposal({ title: 'x', tasks: real.tasks }, 1, '', { maxOpen: 2 }).includes('范围重叠（机械检查'), '上限 2：批准页上有这一段');
  assert(!renderProposal({ title: 'x', tasks: real.tasks }, 1, '', { maxOpen: 1 }).includes('范围重叠（机械检查'), '上限 1（串行）：不给，它不可能发生');
}


section('13. 结构化范围接进批准页与重叠预警');
{
  const T = (n, scope, paths, deps) => ({ title: `T${n}`, goal: 'g', scope, scope_paths: paths, definition_of_done: 'd',
    depends_on: deps, rules: [{ rule: 'r', assumption: 'x' }], constraints: [], verify_command: 'node --test' });

  // 护栏：走模型那条路必须给（requireRules 打开时）；人手写 JSON 建的项目不要求
  const noPaths = { title: 'x', tasks: [{ ...T(1, 's', [], []), scope_paths: undefined }] };
  assert(validateProjectSpec(noPaths, { requireRules: true }).some((e) => /缺 scope_paths/.test(e)), '规划器不给 scope_paths → 回灌重来');
  assert(!validateProjectSpec(noPaths, { requireRules: false }).some((e) => /scope_paths/.test(e)), '人手写 JSON 不强制 —— 回落到从散文里抽');
  assert(validateProjectSpec({ title: 'x', tasks: [T(1, 's', ['/abs/x'], [])] }, { requireRules: true }).some((e) => /绝对路径/.test(e)), '形状不对逐条报错');

  // ④ 的预警走结构化：这正是散文抽取器抽不出来的那一类 —— 两个任务各自点名同一个**子目录里的文件**
  const fine = { tasks: [T(1, '改前端', ['src/web/a.js'], []), T(2, '改前端', ['src/web/b.js'], [])] };
  eq(scopeOverlaps(fine).length, 0, '**同目录下的不同文件不算重叠** —— 散文口径下两个都退成 src/web，会误报一次');
  eq(scopeOverlaps({ tasks: [T(1, '改前端', ['src/web/'], []), T(2, '改前端', ['src/web/b.js'], [])] }).length, 1, '一个要整个目录、一个要目录里的文件 → 真重叠，报');
  const same = { tasks: [T(1, 'a', ['package.json'], []), T(2, 'b', ['package.json'], [])] };
  eq(JSON.stringify(scopeOverlaps(same)[0].where), JSON.stringify(['package.json']), '点名同一个文件照报');
  // 散文口径下的同一组任务：用来对照"结构化之后精确在哪"
  eq(scopeOverlaps({ tasks: [{ ...T(1, '只改 src/web/a.js', [], []) }, { ...T(2, '只改 src/web/b.js', [], []) }] }).length, 1,
    '（对照）没给路径时回落散文抽取器，两个都退成 src/web → **误报一次**，这就是结构化范围买到的精度');

  // 批准页要把判据露出来：人批准的是"机器按这一份撤销越界改动"，不是那段散文
  const txt = renderProposal({ title: 'x', tasks: same.tasks }, 1, '', { maxOpen: 2 });
  assert(/可动路径（判据）：package\.json/.test(txt), '批准页列出结构化范围');
  // 判据是**文件粒度**，而散文里常带字段级要求（"只加一条 script、不改已有的"）。
  // 措辞不能暗示机器拦得住，读者自己就推得出那个缺口 —— 那就必须明说它不证明什么。
  assert(/机器管不了/.test(txt) && txt.includes('只判**能不能动这个文件**'), '**说清判据不证明什么**：它只判能不能动这个文件，更细的要求靠人签收时看');
  eq(renderScopePaths([]), '（这份契约没给路径，判据回落到从上面那段话里抽 —— 精度差，容易漏也容易多）', '没给路径时如实说，不留白');
  assert(/等于不设范围/.test(renderScopePaths(['*'])), '* 要明说它等于不设范围');
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
