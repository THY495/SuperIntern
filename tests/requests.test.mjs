// 需求有出处、有人收
//
// 跑：node tests/requests.test.mjs
//
// 要防的情形：复盘期间项目页不给成员「添加任务」（追加 / 复盘同时只能有一轮，第二条直接报错），
// 成员只能在复盘任务上留言，靠负责人把它转成打回理由；需求合并了提出人也无从得知，签收也跟提出人无关。
// 这里断言：进行中时再加 → 排队（不拒收）、正等批的那条事项下挂评论；这一轮结束 / 项目达成后按先后出队；
// 建出来的任务记在提出人名下（task.requested_by）；路由表里的「需求提出人」解析成这个人；合并后摘要告诉这个人；
// 这一轮期间成员留的话与排着的需求进规划器的输入。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { planProject } from '../src/agent/project-planner.mjs';
import { requestAppend, appendStateOf } from '../src/agent/project-append.mjs';
import { startProject } from '../src/agent/project-start.mjs';
import { projectTasks, advanceProject } from '../src/core/project.mjs';
import { recordAnswer, recordMessage } from '../src/core/inbox.mjs';
import { getParam } from '../src/core/params.mjs';
import { addUser } from '../src/core/users.mjs';
import { setMember } from '../src/core/project-members.mjs';
import { routeQuestion, validateRules, rulesOf, saveRules } from '../src/core/routing.mjs';
import { buildDigest, renderDigest } from '../src/core/digest.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-requests-'));
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
const call = (name, args, id = 'c1') => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id, name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
/** 假模型 + 记下每次请求的正文。 */
const client = (script) => {
  const real = new LlmClient({ mode: 'fake', fake: makeFake(script) });
  const seen = [];
  return { seen, complete: async (req) => { seen.push(req.messages.map((m) => (m.content ?? []).map((c) => c.text ?? '').join('')).join('\n')); return real.complete(req); } };
};
const Q = '先做库 get 与 set，再做命令行 kv get 与 kv set';
const task = (t) => ({ title: t, goal: `g ${t}`, scope: 's', scope_paths: [`src/${t.replace(/\s/g, '')}/`], definition_of_done: `d ${t}`, rules: [{ rule: Q, quote: Q }], constraints: ['既有测试一行不许改'], verify_command: `node --test tests/${t.replace(/\s/g, '')}.test.mjs` });
const loose = (t) => ({ ...task(t), rules: [{ rule: `r ${t}`, assumption: '规格没写' }] });
const propose = (tasks) => call('propose_project', { title: 'x', tasks, notes: '' });
const answer = (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: owner.plaintext });
const project = (id) => db.one(`SELECT * FROM projects WHERE id=?`, id);

// 一个跑起来的项目：两个任务批准了；阿青、阿明都能添加任务
const S = startProject(db, { userId: owner.userId, goal: '做一个 kv 库并带上命令行', doneDefinition: '库有 get/set，CLI 有 kv get 与 kv set', plan: `# 规划\n${Q}`, source: SRC, home: HOME });
{ const r = await planProject(db, { client: client([propose([task('T1 库'), task('T2 CLI')])]), projectId: S.projectId });
  answer(r.questionId, 'A'); await planProject(db, { client: client([]), projectId: S.projectId }); }
setMember(db, { projectId: S.projectId, userId: lin.userId, canAddTasks: true, note: '界面', by: owner.userId });
setMember(db, { projectId: S.projectId, userId: zhou.userId, canAddTasks: true, note: '后端', by: owner.userId });

section('1. 进行中再加 → 排队（不拒收）；正等批的那条事项下挂评论，批的人看得到');
let firstRound;
{
  const r1 = requestAppend(db, { projectId: S.projectId, userId: lin.userId, brief: '列表里 high 优先级标红' });
  assert(!r1.queued, '没有进行中的：直接开一轮');
  firstRound = appendStateOf(db, S.projectId);
  eq([firstRound.kind, firstRound.stage, firstRound.requestedBy].join('|'), ['append', 'drafting', lin.userId].join('|'), '这一轮记下是阿青提的');
  const r2 = requestAppend(db, { projectId: S.projectId, userId: owner.userId, brief: '加一个 kv del' });
  eq([r2.queued, r2.position].join('|'), 'true|1', '进行中（还在起草）再加 → 排第 1 位，不报错');
  eq(appendStateOf(db, S.projectId).brief, '列表里 high 优先级标红', '当前这一轮不受影响');
  const r = await planProject(db, { client: client([propose([loose('T3 标红')])]), projectId: S.projectId });
  eq(r.kind, 'proposed', '这一轮出了草案，等负责人批');
  const r3 = requestAppend(db, { projectId: S.projectId, userId: zhou.userId, brief: '后端加分页参数 page' });
  eq(r3.position, 2, '阿明的排第 2 位');
  const cm = db.one(`SELECT * FROM answers WHERE question_id=? AND stance='comment'`, r.questionId);
  assert(cm && cm.user_id === zhou.userId && /（添加任务，已排队）后端加分页参数 page/.test(cm.body) && /不影响你现在这条怎么答/.test(cm.body),
    '正等批的那条事项下挂了阿明的评论（署阿明的名），并说明不影响现在怎么答');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, r.questionId).status, 'open', '评论不改变事项状态');
  firstRound.questionId = r.questionId;
}

section('2. 批准 → 新任务记在提出人名下；排着的第一条自动开成下一轮');
{
  answer(firstRound.questionId, 'A');
  const r = await planProject(db, { client: client([]), projectId: S.projectId });
  eq(r.kind, 'approved', '批准');
  const t3 = projectTasks(db, S.projectId).find((t) => t.title === 'T3 标红');
  eq(getParam(db, t3.id, 'task.requested_by'), lin.userId, 'T3 记在阿青名下（task.requested_by）');
  const t1 = projectTasks(db, S.projectId).find((t) => t.title === 'T1 库');
  eq(getParam(db, t1.id, 'task.requested_by'), null, '首批规划的任务没有出处（不是谁"添加"的）');
  const st = appendStateOf(db, S.projectId);
  eq([st.stage, st.brief, st.requestedBy, st.queue.length].join('|'), ['drafting', '加一个 kv del', owner.userId, 1].join('|'), '排第 1 位的出队、开成下一轮，记在负责人名下；队里还剩 1 条');
  assert(r.nextQueued?.carrierId, '返回里带上出队开的那一轮');
  // 规划器这一轮的输入里有"排着的需求"，并被告知别重复切进来
  const c = client([propose([loose('T4 删除')])]);
  const r2 = await planProject(db, { client: c, projectId: S.projectId });
  assert(/已排队、这一轮之后会单独起草的需求/.test(c.seen[0]) && /阿明：后端加分页参数 page/.test(c.seen[0]) && /不要\*\*把它们切进这一版/.test(c.seen[0]), '规划器看得到排着的需求，并被告知别重复切进这一版');
  answer(r2.questionId, 'C');
  const r3 = await planProject(db, { client: client([]), projectId: S.projectId });
  eq(r3.kind, 'abandoned', '负责人放弃这一轮');
  const st3 = appendStateOf(db, S.projectId);
  eq([st3.stage, st3.requestedBy, st3.queue.length].join('|'), ['drafting', zhou.userId, 0].join('|'), '放弃之后同样出队：阿明那条开成下一轮');
  const r4 = await planProject(db, { client: client([propose([loose('T5 分页')])]), projectId: S.projectId });
  answer(r4.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  eq(getParam(db, projectTasks(db, S.projectId).find((t) => t.title === 'T5 分页').id, 'task.requested_by'), zhou.userId, 'T5 记在阿明名下');
}

section('3. 路由表里的「需求提出人」：签收送提出人 + 负责人（all）；没有出处的任务只送负责人');
{
  const key = S.projectId;
  const rows = rulesOf(db, key).map(({ id, project_id, template, ...r }) => r);
  const sig = rows.find((r) => r.decision_type === 'signoff' && r.scope === '*');
  sig.recipients = ['requester', 'user:lead']; sig.quorum = 'all';
  eq(validateRules(db, key, rows).length, 0, '「需求提出人」是合法写法（校验按一个人算）');
  const badRows = rows.map((r) => (r.decision_type === 'conflict' ? { ...r, recipients: ['requester', ...r.recipients] } : r));
  assert(validateRules(db, key, badRows).some((e) => /需求提出人不能用于/.test(e.msg)), '「意见不一致」类型不许用');
  saveRules(db, { key, rules: rows, userId: owner.userId });
  const route = (title) => {
    const tid = projectTasks(db, S.projectId).find((t) => t.title === title).id;
    const qid = newId('q');
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,NULL,3,'hard_rule','【签收】x',NULL,?,NULL,'open')`, qid, tid, now());
    return routeQuestion(db, { questionId: qid, decisionType: 'signoff', typeSource: 'hard_rule' });
  };
  const a = route('T3 标红');
  eq([...a.answerers].sort().join(','), [lin.userId, owner.userId].sort().join(','), '阿青提的 T3：签收送阿青 + 负责人');
  eq(db.one(`SELECT quorum FROM questions ORDER BY rowid DESC LIMIT 1`).quorum, 'all', '法定人数 all：两个人都要签');
  eq(route('T1 库').answerers.join(','), owner.userId, '没有出处的 T1：只送负责人（all 跟着少一个人）');
}

section('4. 合并之后，摘要告诉提需求的人');
{
  const t3 = projectTasks(db, S.projectId).find((t) => t.title === 'T3 标红');
  db.run(`UPDATE tasks SET merged_at=? WHERE id=?`, now(), t3.id);
  const d = buildDigest(db, { userId: lin.userId });
  eq(d.requestsDone.map((x) => x.title).join(','), 'T3 标红', '阿青的摘要里有"你提的需求做完了：T3 标红"');
  assert(/你提的需求做完并合并了 1 个/.test(renderDigest(d)), '文字摘要里也有');
  eq(buildDigest(db, { userId: zhou.userId }).requestsDone.length, 0, '阿明提的还没合并：没有');
  eq(buildDigest(db, { userId: owner.userId }).requestsDone.length, 0, '负责人不收这一条（合并本来就经负责人手）');
}

section('5. 复盘期间：成员可以加（排队）；留的话进复盘规划器；确认达成之后排着的才出队');
{
  const S2 = startProject(db, { userId: owner.userId, goal: '做一个 kv 库', doneDefinition: '库有 get/set', plan: `# 规划\n${Q}`, source: SRC, home: join(HOME, 's2') });
  { const r = await planProject(db, { client: client([propose([task('T1 库'), task('T2 CLI')])]), projectId: S2.projectId });
    answer(r.questionId, 'A'); await planProject(db, { client: client([]), projectId: S2.projectId }); }
  setMember(db, { projectId: S2.projectId, userId: lin.userId, canAddTasks: true, note: '', by: owner.userId });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S2.projectId);
  eq((await advanceProject(db, { projectId: S2.projectId, home: HOME })).reason, 'review_requested', '全部合并 → 复盘');
  const st = appendStateOf(db, S2.projectId);
  eq([st.kind, st.requestedBy].join('|'), 'review|', '复盘不记出处');
  const q1 = requestAppend(db, { projectId: S2.projectId, userId: lin.userId, brief: '空列表时显示"还没有工单"' });
  eq([q1.queued, q1.behind].join('|'), 'true|review', '复盘期间阿青也能加：排队（原来直接报错，入口也藏着）');
  recordMessage(db, { taskId: st.carrierId, body: '我看了一下，列表页的空状态还没做', kind: 'context', plaintextToken: lin.plaintext });
  const c = client([call('project_goal_reached', { reason: 'T1、T2 兑现了 get/set', unverified: [] })]);
  const r = await planProject(db, { client: c, projectId: S2.projectId });
  eq(r.reached, true, '复盘结论：已达成');
  assert(/这一轮期间项目成员留的话/.test(c.seen[0]) && /阿青：我看了一下，列表页的空状态还没做/.test(c.seen[0]) && /供参考/.test(c.seen[0]), '复盘规划器看得到阿青留的话（供参考）');
  assert(/阿青：空列表时显示"还没有工单"/.test(c.seen[0]), '也看得到排着的需求');
  const q2 = requestAppend(db, { projectId: S2.projectId, userId: lin.userId, brief: '顶部加搜索框' });
  eq(q2.position, 2, '达成确认等批时再加：排第 2');
  const cm = db.one(`SELECT body FROM answers WHERE question_id=? AND stance='comment'`, r.questionId);
  assert(/别回「确认达成」/.test(cm?.body ?? ''), '挂在达成确认下的评论提醒负责人：没做完就别确认达成');
  answer(r.questionId, '确认达成');
  eq((await planProject(db, { client: client([]), projectId: S2.projectId })).kind, 'reached', '负责人确认达成');
  eq(appendStateOf(db, S2.projectId).queue.length, 2, '达成这一步不出队（先让 advanceProject 宣布完成，别把"达成"盖掉）');
  const adv = await advanceProject(db, { projectId: S2.projectId, home: HOME });
  eq([adv.reason, project(S2.projectId).status].join('|'), 'goal_reached|done', '宣布完成');
  const nx = appendStateOf(db, S2.projectId);
  eq([nx.kind, nx.stage, nx.requestedBy, nx.brief, nx.queue.length].join('|'), ['append', 'drafting', lin.userId, '空列表时显示"还没有工单"', 1].join('|'),
    '完成之后排第 1 的出队：kind 回到 append（不再被当成复盘），记在阿青名下');
  const r3 = await planProject(db, { client: client([propose([loose('T3 空状态')])]), projectId: S2.projectId });
  answer(r3.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S2.projectId });
  eq(project(S2.projectId).status, 'active', '批准后项目回到 active —— 需求没有因为"已达成"被吞掉');
}

section('5b. 在达成确认里回"还差东西"并写了要什么的人 = 新任务的提出人（这样提的需求也要记在提出人名下）');
{
  const S = startProject(db, { userId: owner.userId, goal: '做一个 kv 库', doneDefinition: '库有 get/set', plan: `# 规划\n${Q}`, source: SRC, home: join(HOME, 's5b') });
  { const r = await planProject(db, { client: client([propose([task('T1 库'), task('T2 CLI')])]), projectId: S.projectId });
    answer(r.questionId, 'A'); await planProject(db, { client: client([]), projectId: S.projectId }); }
  // 方案批准：负责人 + 阿青，都要批（会签合并出来的答复署最后一个答复人的名 —— 这里是负责人）
  const rows = rulesOf(db, S.projectId).map(({ id, project_id, template, ...r }) => r);
  for (const r of rows) if (r.decision_type === 'contract_approval') { r.recipients = ['user:lead', `user:${lin.userId}`]; r.quorum = 'all'; }
  saveRules(db, { key: S.projectId, rules: rows, userId: owner.userId });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  const r = await planProject(db, { client: client([call('project_goal_reached', { reason: '都有了', unverified: [] })]), projectId: S.projectId });
  recordAnswer(db, { questionId: r.questionId, body: 'B\n还差一个：每条待办显示优先级标签', plaintextToken: lin.plaintext });
  answer(r.questionId, 'B 同意阿青，加上标签');
  const r2 = await planProject(db, { client: client([propose([loose('T3 标签')])]), projectId: S.projectId });
  eq(appendStateOf(db, S.projectId).requestedBy, lin.userId, '这一轮记在阿青名下（不是会签合并那条的署名人）');
  recordAnswer(db, { questionId: r2.questionId, body: 'A', plaintextToken: lin.plaintext });
  answer(r2.questionId, 'A');
  const done = await planProject(db, { client: client([]), projectId: S.projectId });
  eq(done.kind, 'approved', '追加方案批准');
  eq(getParam(db, done.tasks[0], 'task.requested_by'), lin.userId, '新任务的 task.requested_by = 阿青 → "你提的需求做完了"会发给她');
}

section('5c. 排着需求的人又在达成确认里回"还差东西" → 她排着的那条并进这一轮，不再单独起草一遍');
{
  const S = startProject(db, { userId: owner.userId, goal: '做一个 kv 库', doneDefinition: '库有 get/set', plan: `# 规划\n${Q}`, source: SRC, home: join(HOME, 's5c') });
  { const r = await planProject(db, { client: client([propose([task('T1 库'), task('T2 CLI')])]), projectId: S.projectId });
    answer(r.questionId, 'A'); await planProject(db, { client: client([]), projectId: S.projectId }); }
  setMember(db, { projectId: S.projectId, userId: lin.userId, canAddTasks: true, note: '', by: owner.userId });
  const rows = rulesOf(db, S.projectId).map(({ id, project_id, template, ...r }) => r);
  for (const r of rows) if (r.decision_type === 'contract_approval') { r.recipients = ['user:lead', `user:${lin.userId}`]; r.quorum = 'all'; }
  saveRules(db, { key: S.projectId, rules: rows, userId: owner.userId });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  const r = await planProject(db, { client: client([call('project_goal_reached', { reason: '都有了', unverified: [] })]), projectId: S.projectId });
  const q1 = requestAppend(db, { projectId: S.projectId, userId: lin.userId, brief: '每条待办显示优先级标签' });
  eq(q1.queued, true, '复盘期间阿青加的需求：排队');
  recordAnswer(db, { questionId: r.questionId, body: 'B\n还差：优先级标签', plaintextToken: lin.plaintext });
  answer(r.questionId, 'B 同意阿青');
  const c = client([propose([loose('T3 标签')])]);
  await planProject(db, { client: c, projectId: S.projectId });
  eq(appendStateOf(db, S.projectId).queue.length, 0, '她排着的那条从队里拿掉了（原来批准后会出队、再起草一轮）');
  assert(/同一个人之前排着的需求/.test(c.seen[0]) && /每条待办显示优先级标签/.test(c.seen[0]), '并进了这一版交给规划器的反馈里，内容不丢');
}

section('6. 排着的人后来没权限了 → 出队时丢掉并留痕，不静默吞');
{
  const S3 = startProject(db, { userId: owner.userId, goal: 'g', doneDefinition: 'd', plan: `# 规划\n${Q}`, source: SRC, home: join(HOME, 's3') });
  { const r = await planProject(db, { client: client([propose([task('T1 库'), task('T2 CLI')])]), projectId: S3.projectId });
    answer(r.questionId, 'A'); await planProject(db, { client: client([]), projectId: S3.projectId }); }
  setMember(db, { projectId: S3.projectId, userId: zhou.userId, canAddTasks: true, note: '', by: owner.userId });
  requestAppend(db, { projectId: S3.projectId, userId: owner.userId, brief: '第一条' });
  requestAppend(db, { projectId: S3.projectId, userId: zhou.userId, brief: '阿明的一条' });
  setMember(db, { projectId: S3.projectId, userId: zhou.userId, canAddTasks: false, note: '', by: owner.userId });
  const r = await planProject(db, { client: client([propose([loose('T3')])]), projectId: S3.projectId });
  answer(r.questionId, 'C');
  await planProject(db, { client: client([]), projectId: S3.projectId });
  const st = appendStateOf(db, S3.projectId);
  eq([st.stage, st.queue.length].join('|'), 'abandoned|0', '阿明那条没开成（队空了，这一轮停在放弃）');
  const drop = db.one(`SELECT payload FROM audit_log WHERE action='project_append_queue_dropped' AND target_id=?`, S3.projectId);
  assert(drop && /没有添加任务的权限/.test(drop.payload) && /阿明的一条/.test(drop.payload), '丢掉的理由和原话进审计（活动流看得到）');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 100);
