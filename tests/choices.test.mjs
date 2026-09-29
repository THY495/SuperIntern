// AI 替人定的事按领域交给那个领域的人过目
//
// 跑：node tests/choices.test.mjs
//
// 起因：执行 AI 在规格没写的地方自己拍板，原来全都只进汇报的"强制披露"一节；
// 管界面的成员可能整场 0 条事项，路由给他的"规格取舍"一次都不出现。要让每个角色在自己的领域做过决定。
// 断言：做完时按领域各合成一条过目事项、按项目路由表送人、不挡签收；回 A → 进约定清单；写要改 → 替答复人「添加任务」
// （合没合并都一样、不重开任务、不要求添加权限）；「说明：」只记下；同一步重做过只摘最近一次的说法；幂等。假设原文取自一次实际运行。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { planProject } from '../src/agent/project-planner.mjs';
import { appendStateOf } from '../src/agent/project-append.mjs';
import { startProject } from '../src/agent/project-start.mjs';
import { projectTasks } from '../src/core/project.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import { addUser } from '../src/core/users.mjs';
import { setMember } from '../src/core/project-members.mjs';
import { rulesOf, saveRules } from '../src/core/routing.mjs';
import { raiseChoiceReviews, domainOf, CHOICES_MARK } from '../src/core/choices.mjs';
import { activeDecisions } from '../src/core/decisions.mjs';
import { buildDigest } from '../src/core/digest.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-choices-'));
const HOME = join(TMP, 'home');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitc = (cwd, ...a) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
const SRC = join(TMP, 'src');
mkdirSync(SRC); git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'README.md'), '# demo\n'); gitc(SRC, 'add', '.'); gitc(SRC, 'commit', '-q', '-m', 'init');

const db = openDb(':memory:');
const owner = ensureOwner(db);
const lin = addUser(db, { name: '阿青', role: 'member', byUserId: owner.userId });
const zhou = addUser(db, { name: '阿明', role: 'member', byUserId: owner.userId });
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'c1', name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
const client = (script) => new LlmClient({ mode: 'fake', fake: makeFake(script) });
const as = (u) => (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: u.plaintext });
const Q = '先做库 get 与 set，再做命令行 kv get 与 kv set';
const T = (t) => ({ title: t, goal: `g ${t}`, scope: 's', scope_paths: ['frontend/', 'backend/'], definition_of_done: `d ${t}`, rules: [{ rule: Q, quote: Q }], constraints: [], verify_command: 'node --test tests/x.test.mjs' });
const choose = (taskId, subject, statement) => db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at)
  VALUES (?,?,NULL,?,?,'active','settled_by_me','查过 spec 与仓库，都没写',1,?,?)`, newId('as'), taskId, subject, statement, now(), now());

// 项目：两个任务；路由按分工 ——规格取舍 → 阿青，结构矛盾 → 阿明 + 负责人
const S = startProject(db, { userId: owner.userId, goal: '工单系统', doneDefinition: 'd', plan: `# 规划\n${Q}`, source: SRC, home: HOME });
{ const r = await planProject(db, { client: client([call('propose_project', { title: '工单', tasks: [T('T1 后端'), T('T2 前端')], notes: '' })]), projectId: S.projectId });
  as(owner)(r.questionId, 'A'); await planProject(db, { client: client([]), projectId: S.projectId }); }
for (const u of [lin, zhou]) setMember(db, { projectId: S.projectId, userId: u.userId, canAddTasks: false, note: '', by: owner.userId });
{ const rows = rulesOf(db, S.projectId).map(({ id, project_id, template, ...r }) => r);
  rows.find((r) => r.decision_type === 'spec_choice' && r.scope === '*').recipients = [`user:${lin.userId}`];
  rows.find((r) => r.decision_type === 'structural' && r.scope === '*').recipients = [`user:${zhou.userId}`, 'user:lead'];
  saveRules(db, { key: S.projectId, rules: rows, userId: owner.userId }); }
const [t1, t2] = projectTasks(db, S.projectId);

section('1. 按主题分两堆：依赖 / 构建 / 仓库结构 → 结构；界面 / 接口行为 → 规格');
{
  const cases = [
    ['frontend.priority.label.zh', '优先级的中文显示文案定为 低/中/高（low/medium/high）。', 'spec_choice'],
    ['backend.post.success_status', 'POST /api/tickets 成功返回 201（非 200）。', 'spec_choice'],
    ['ticketUtils.unknown_priority_sort_position', '未知/缺失的 priority 排在所有已知优先级之后', 'spec_choice'],
    ['preview.uvicorn.dependency', 'si-preview.json 的后端启动命令依赖 uvicorn，而 uvicorn 不在 backend/requirements.txt', 'structural'],
    ['gitignore.dist.tracked', 'frontend/dist/** 已被跟踪，根 .gitignore 的 dist/ 规则对已跟踪文件无效', 'structural'],
  ];
  for (const [k, s, want] of cases) eq(domainOf({ subject_key: k, statement: s }), want, `${k} → ${want === 'structural' ? '结构' : '规格'}`);
}

section('2. 做完时：每个领域合成一条过目事项，按路由送人；Ⅱ 级带默认、不挡签收；幂等');
let specQ, structQ;
{
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, t2.id);
  choose(t2.id, 'frontend.priority.label.zh', '优先级的中文显示文案定为 低/中/高（low/medium/high）。');
  choose(t2.id, 'frontend.description.empty.value', '描述留空时 POST body 的 description 发送 null 而不是空字符串。');
  choose(t2.id, 'preview.uvicorn.dependency', 'si-preview.json 的后端启动命令依赖 uvicorn，而 uvicorn 不在 backend/requirements.txt、也不在任何依赖清单里；我选择不改清单');
  const r = raiseChoiceReviews(db, { taskId: t2.id });
  eq(r.map((x) => `${x.domain}:${x.count}`).sort().join(','), 'spec_choice:2,structural:1', '三件事 → 两条事项（不是三条）');
  specQ = db.one(`SELECT * FROM questions WHERE id=?`, r.find((x) => x.domain === 'spec_choice').questionId);
  structQ = db.one(`SELECT * FROM questions WHERE id=?`, r.find((x) => x.domain === 'structural').questionId);
  eq(JSON.parse(specQ.addressed_to).join(','), lin.userId, '规格那条送阿青');
  eq(JSON.parse(structQ.addressed_to).join(','), zhou.userId, '结构那条送阿明（那一行是阿明 + 负责人、任一人答即算：过目事项负责人只知会，不跟成员抢答）');
  assert(JSON.parse(structQ.informed || '[]').includes(owner.userId), '负责人在知会里（仍然可以答）');
  assert(specQ.text.startsWith(CHOICES_MARK) && /低\/中\/高/.test(specQ.text) && /它的依据：/.test(specQ.text) && /不影响任务照常签收、合并/.test(specQ.text), '正文：原话 + 它查过什么 + 不挡签收 + 三种答法');
  eq([specQ.level, specQ.default_action].join('|'), '2|沿用 AI 的选择，不改', 'Ⅱ 级、默认沿用 AI 的选择');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, t2.id).status, 'done', '任务状态不变（不挡签收）');
  eq(raiseChoiceReviews(db, { taskId: t2.id }).length, 0, '再调一次：挂过的不再挂');
  const d = buildDigest(db, { userId: lin.userId });
  assert(d.waitingOnMe.some((x) => x.questionId === specQ.id), '阿青的收件箱里有这条（待你处理）');
}

section('3. 回 A → 这几件进项目的约定清单（署答复人的名），不把"A"登记成约定');
{
  const before = activeDecisions(db, { projectId: S.projectId }).length;
  const r = as(lin)(specQ.id, 'A');
  eq(r.hook?.kept, 2, '钩子认领：同意了 2 件');
  const after = activeDecisions(db, { projectId: S.projectId });
  eq(after.length - before, 2, '约定清单多了 2 条');
  assert(after.some((d) => /低\/中\/高/.test(d.statement) && /阿青过目同意/.test(d.statement)), '约定原文 = AI 当时的原话 + 谁过目同意');
  assert(!after.some((d) => d.statement === 'A'), '没有把一个"A"登记成约定');
}

section('4. 写要改、任务还没合并 → 也是替答复人「添加任务」，不重开这个任务（重开会导致签收死锁）');
{
  const r = as(zhou)(structQ.id, '把 uvicorn 加进 backend/requirements.txt');
  assert(r.hook?.appended && !r.hook?.correction, '替阿明添加了任务，没有转成修正');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, t2.id).status, 'done', '任务还是 done（照常签收、合并），改动排在后面单独做');
  const st = appendStateOf(db, S.projectId);
  assert(st.requestedBy === zhou.userId && /把 uvicorn 加进/.test(st.brief) && /uvicorn 不在/.test(st.brief), '这一轮记在阿明名下，带上当时 AI 的原话');
  db.run(`UPDATE params SET superseded_at=? WHERE task_id=? AND key LIKE 'append.%' AND superseded_at IS NULL`, now(), st.carrierId);   // 收掉这一轮，给第 5 节腾位置
}

section('4b. 以「说明：」开头 → 只记下来，不引出任何改动；同一步重做过只摘最近一次交接的说法');
{
  const tid3 = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'T3','done',?,?,3)`, tid3, owner.userId, now(), S.projectId);
  const nid = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'步骤','s','a','pending',5,?)`, nid, tid3, now());
  const early = now() - 60_000;
  db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at) VALUES (?,?,?,'verify.smoke.cleanup','冒烟测试完成后不清理 books.db','active','settled_by_me','x',1,?,?)`, newId('as'), tid3, nid, early, early);
  db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at) VALUES (?,?,?,'verify.backup','验收前备份 books.db、结束后还原','active','settled_by_me','x',1,?,?)`, newId('as'), tid3, nid, now(), now());
  const [x] = raiseChoiceReviews(db, { taskId: tid3 });
  const text = db.one(`SELECT text FROM questions WHERE id=?`, x.questionId).text;
  assert(x.count === 1 && /备份 books.db/.test(text) && !/不清理/.test(text), '同一步重做过：只摘最近一次交接的说法（旧的"不清理"不再出现）');
  const r = as(zhou)(x.questionId, '说明：备份还原那条是返工后定的，挺好');
  assert(r.hook?.noted && !r.hook?.appended, '「说明：」只记下来');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, tid3).status, 'done', '任务不动');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='choices_noted' AND target_id=?`, tid3), '说明进了活动流');
}

section('5. 写要改、任务已经合并 → 替答复人「添加任务」（阿明没有添加权限也行：这条是路由表派给他的）');
{
  db.run(`UPDATE tasks SET status='done', merged_at=? WHERE id=?`, now(), t1.id);
  choose(t1.id, 'gitignore.dist.tracked', 'frontend/dist/** 已被跟踪，根 .gitignore 的 dist/ 规则对已跟踪文件无效，我没有执行 git rm');
  const [x] = raiseChoiceReviews(db, { taskId: t1.id });
  const r = as(zhou)(x.questionId, '把 frontend/dist 从仓库里拿掉');
  assert(r.hook?.appended, '替阿明添加了任务');
  const st = appendStateOf(db, S.projectId);
  assert(st.requestedBy === zhou.userId && /把 frontend\/dist 从仓库里拿掉/.test(st.brief) && /当时 AI 定的/.test(st.brief), '这一轮记在阿明名下，说明里带着要改什么 + 当时 AI 的原话');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 100);
