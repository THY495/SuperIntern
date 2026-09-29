// 项目复盘与达成确认：有行为的几条回归
//
// 跑：node tests/project-review.test.mjs
//
// ① 达成确认覆盖整个项目：按"碰到了路由表里写过的每个目录"路由（只落到负责人的话，管各目录的成员的需求出不来）
// ③ 决定比对按 answers 表找"答的是哪道题"（会签事项的各人答复不连 answers 边）；批准只拿保留意见去比
// ④ 复盘看得到"签收打回已落实、已重新签收"（否则会按打回又提一个重复任务）
// ⑤ 复盘提的任务方案多一个出口 E「已经达成，这些都不需要」；C 如实说"项目停滞"；「C：说明」不再被读成要改；
//    停滞（复盘先放着）可以「重新复盘」，收件箱按停滞原因写

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { planProject, startProjectFromBrief } from '../src/agent/project-planner.mjs';
import { requestReview, reviewAgain, appendStateOf } from '../src/agent/project-append.mjs';
import { readVerdict, describeReading, REVIEW_LABELS } from '../src/agent/approval.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import { addUser } from '../src/core/users.mjs';
import { rulesOf, saveRules, wholeProjectPrefixes } from '../src/core/routing.mjs';
import { record } from '../src/core/decisions.mjs';
import { afterInput } from '../src/core/decision-check.mjs';
import { buildDigest } from '../src/core/digest.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-review-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitc = (cwd, ...a) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
const SRC = join(TMP, 'src');
mkdirSync(join(SRC, 'frontend'), { recursive: true }); mkdirSync(join(SRC, 'backend'));
git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'frontend', 'README.md'), 'f\n'); writeFileSync(join(SRC, 'backend', 'README.md'), 'b\n');
gitc(SRC, 'add', '.'); gitc(SRC, 'commit', '-q', '-m', 'init');

const db = openDb(':memory:');
const owner = ensureOwner(db);
const lin = addUser(db, { name: '阿青', role: 'member', byUserId: owner.userId });
const zhou = addUser(db, { name: '阿明', role: 'member', byUserId: owner.userId });
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'c1', name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
const client = (script) => {
  const real = new LlmClient({ mode: 'fake', fake: makeFake(script) });
  const seen = [];
  return { seen, complete: async (req) => { seen.push(req.messages.map((m) => (m.content ?? []).map((c) => c.text ?? '').join('')).join('\n')); return real.complete(req); } };
};
const as = (u) => (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: u.plaintext });
const T = (t, path) => ({ title: t, goal: `g ${t}`, scope: 's', scope_paths: [path], definition_of_done: `d ${t}`, rules: [{ rule: `r ${t}`, assumption: '规格没写' }], constraints: [], verify_command: 'node --test test/a.test.mjs', depends_on: [] });
const addressed = (qid) => JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, qid).addressed_to).sort().join(',');
const ALL3 = [owner.userId, lin.userId, zhou.userId].sort().join(',');

/** 一种常见的配法：方案批准 * → 负责人；frontend → 阿青 + 负责人（all）；backend → 阿明 + 负责人（all） */
function project(home) {
  const P = startProjectFromBrief(db, { userId: owner.userId, brief: '做一个待办清单\n前后端分开', source: SRC, home: join(TMP, home) });
  const rows = rulesOf(db, P.projectId).map(({ id, project_id, template, ...r }) => r);
  const base = rows.find((r) => r.decision_type === 'contract_approval' && r.scope === '*');
  rows.push({ ...base, scope: 'frontend', recipients: [`user:${lin.userId}`, 'user:lead'], quorum: 'all' });
  rows.push({ ...base, scope: 'backend', recipients: [`user:${zhou.userId}`, 'user:lead'], quorum: 'all' });
  saveRules(db, { key: P.projectId, rules: rows, userId: owner.userId });
  db.run(`UPDATE projects SET status='active' WHERE id=?`, P.projectId);
  return P;
}
const carrier = (pid) => db.one(`SELECT id FROM tasks WHERE project_id=? AND project_order=0`, pid).id;

section('① 达成确认覆盖整个项目：管各目录的人都收得到（不只落到负责人）');
{
  const P = project('p1');
  eq(wholeProjectPrefixes(db, carrier(P.projectId), 'contract_approval').sort().join(','), 'backend,frontend', '整个项目 = 路由表里为方案批准写过的每个目录');
  requestReview(db, { projectId: P.projectId });
  const c = client([call('project_goal_reached', { reason: '完成定义四条都有契约兑现', unverified: [] })]);
  const r = await planProject(db, { client: c, projectId: P.projectId });
  assert(r.reached && r.questionId, '复盘判已达成 → 出达成确认');
  eq(addressed(r.questionId), ALL3, '达成确认送负责人 + 阿青 + 阿明（只送负责人的话，提需求的成员没机会说还差什么）');
}

section('⑤ 复盘提的任务方案：E「已经达成」出口、C 如实说停滞、「C：说明」认作放弃');
{
  eq(readVerdict('E', REVIEW_LABELS), 'reached', '「E」→ 已经达成');
  eq(readVerdict('已达成', REVIEW_LABELS), 'reached', '「已达成」→ 已经达成');
  eq(readVerdict('E：这些都是重复的，T2 里已经改过了', REVIEW_LABELS), 'reached', '「E：说明」→ 已经达成');
  eq(readVerdict('E', {}), 'feedback', '别的方案页不认 E（只有复盘提的任务方案有这个出口）');
  eq(readVerdict('C：这个不需要了，理由是它已经在 T2 里改过了', {}), 'abandon', '「C：理由」→ 放弃（不被 hedgeRe 读成要改）');
  eq(readVerdict('C：改成只做前端', {}), 'feedback', '「C：改成……」仍按要改');
  eq(readVerdict('A\n保留：以后再看看并发', {}), 'approve', '「A + 保留」仍是批准');
  const d = describeReading({ body: 'C', labels: REVIEW_LABELS, reached: false, tense: 'will' });
  assert(d.text.includes('停滞') && d.text.includes('「E」'), '复盘方案回 C 的预览：说清项目会停滞，并指出"项目其实已达成就回 E"');

  const P = project('p5');
  requestReview(db, { projectId: P.projectId });
  const c = client([call('propose_project', { title: '待办清单', tasks: [T('T9 重复的活', 'frontend/')], notes: '' })]);
  const r = await planProject(db, { client: c, projectId: P.projectId });
  const qt = db.one(`SELECT text FROM questions WHERE id=?`, r.questionId).text;
  assert(qt.includes('(E) 项目其实已经做完了') && qt.includes('转为停滞') && qt.indexOf('(D)') < qt.indexOf('(E)'), '复盘提的任务方案页上有 E（排在 D 后面），C 写明"转为停滞"');
  eq(addressed(r.questionId), ALL3, '复盘提的任务方案与达成确认同一批人');
  for (const u of [owner, lin, zhou]) as(u)(r.questionId, 'E');
  const r2 = await planProject(db, { client: client([]), projectId: P.projectId });
  eq(r2.kind, 'reached', '三人都回 E → 项目按已达成处理（不停滞、不再出方案）');
  eq(appendStateOf(db, P.projectId).stage, 'reached', '复盘状态 = reached（advanceProject 随后跑项目级验收、收尾）');
  eq(db.one(`SELECT count(*) n FROM tasks WHERE project_id=? AND project_order>0`, P.projectId).n, 0, '没建任何任务');
}

section('⑤ 停滞（复盘先放着）：收件箱按原因写，负责人可以「重新复盘」');
{
  const P = project('p6');
  db.run(`UPDATE projects SET status='stalled' WHERE id=?`, P.projectId);
  const d = buildDigest(db, { userId: owner.userId });
  const s = d.stalledProjects.find((x) => x.projectId === P.projectId);
  eq(s?.kind, 'review_shelved', '没有已中止的任务 → 停滞原因 = 复盘先放着（不套"任务「」已中止"）');
  let err = null; try { reviewAgain(db, { projectId: P.projectId, userId: lin.userId }); } catch (e) { err = e.message; }
  assert(err?.includes('负责人'), '只有负责人能重新复盘');
  const r = reviewAgain(db, { projectId: P.projectId, userId: owner.userId });
  assert(r.carrierId, '重新复盘 → 复盘起草');
  eq(db.one(`SELECT status FROM projects WHERE id=?`, P.projectId).status, 'active', '项目回到进行中');
  eq(appendStateOf(db, P.projectId).stage, 'drafting', '等规划器（守护进程随后拉）');
  err = null; try { reviewAgain(db, { projectId: P.projectId, userId: owner.userId }); } catch (e) { err = e.message; }
  assert(err, '不是停滞的项目不能再点');

  // 页面上的按钮走的是 HTTP 路由 —— 路由正则若漏了 review，页面会报"接口不存在"
  const P2 = project('p7');
  db.run(`UPDATE projects SET status='stalled' WHERE id=?`, P2.projectId);
  const { startWeb } = await import('../src/web/server.mjs');
  const w = await startWeb(db, { home: join(TMP, 'web'), port: 0, tokenPlain: owner.plaintext, pollMs: 100 });
  try {
    const r = await fetch(`http://127.0.0.1:${w.port}/api/projects/${P2.projectId}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await r.json();
    eq(r.status, 200, `页面「重新复盘」按钮的接口可用（${body.error ?? 'ok'}）`);
    eq(db.one(`SELECT status FROM projects WHERE id=?`, P2.projectId).status, 'active', '经页面重新复盘 → 项目回到进行中');
  } finally { w.close(); }
}

section('④ 复盘看得到"签收打回已落实、已重新签收"');
{
  const P = project('p4');
  const t = newId('t'), at = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order,merged_at) VALUES (?,?,'T2 人工点验','done',?,?,1,?)`, t, owner.userId, at, P.projectId, at);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'点验','MANUAL_QA.md','写结果','[]',?,?)`, newId('c'), t, at, at);
  const mid = newId('m');
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at) VALUES (?,?,?,?,'correction','explicit','normal','explicit','user-authenticated',?,?)`,
    mid, t, owner.userId, '【签收打回】第 6 项要写未通过', db.one(`SELECT id FROM tokens LIMIT 1`).id, at);
  db.run(`INSERT INTO revisions (id,task_id,message_id,status,impact,salvage,changed_nodes,new_nodes,rationale,done_micro_usd,discarded_micro_usd,proposed_at,resolved_at)
          VALUES (?,?,?,'applied','[]','[]','[]','[]','改两行',0,0,?,?)`, newId('rv'), t, mid, at, at);
  requestReview(db, { projectId: P.projectId });
  const c = client([call('project_goal_reached', { reason: '都兑现了', unverified: [] })]);
  await planProject(db, { client: c, projectId: P.projectId });
  const prompt = c.seen.join('\n');
  assert(prompt.includes('第 6 项要写未通过') && prompt.includes('都已落实'), '复盘输入里：T2 被打回过什么、已落实并重新签收（否则会按那条打回又提一个重复任务）');
}

section('③ 决定比对：会签事项里各人的答复按 answers 表找题；批准只拿保留意见去比');
{
  const P = project('p3');
  db.run(`UPDATE projects SET status='proposed' WHERE id=?`, P.projectId);
  const c = client([call('propose_project', { title: '待办清单', tasks: [T('T1 后端', 'backend/'), T('T2 前端', 'frontend/')], notes: '' })]);
  const r = await planProject(db, { client: c, projectId: P.projectId });
  const q = r.questionId;
  const a1 = as(lin)(q, 'A');
  eq(db.one(`SELECT count(*) n FROM edges WHERE from_id=? AND relation='answers'`, a1.messageId).n, 0, '（前提）会签没够数时，各人的答复消息不连 answers 边');
  const x1 = await afterInput(db, { taskId: carrier(P.projectId), text: 'A', entry: 'answer', by: lin.userId, sourceId: a1.messageId, makeClient: () => { throw new Error('不该调模型'); } });
  eq(x1.skipped, 'verdict_only', '光秃秃的「A」→ 不比（找不到题时，阿青的 A 会被读成"前端范围选 A"）');

  record(db, { projectId: P.projectId, subject: '前端做到什么程度', statement: '选 B：接真实后端', sourceKind: 'question' });
  const seen = [];
  const stub = { complete: async (req) => { seen.push(JSON.stringify(req.messages)); throw new Error('stub'); } };
  const a2 = as(zhou)(q, 'A\n保留：多人同时写 SQLite 以后要看');
  await afterInput(db, { taskId: carrier(P.projectId), text: 'A\n保留：多人同时写 SQLite 以后要看', entry: 'answer', by: zhou.userId, sourceId: a2.messageId, makeClient: () => stub });
  assert(seen.length === 1 && seen[0].includes('保留意见') && seen[0].includes('多人同时写 SQLite') && !seen[0].includes('答复：A'),
    '「A + 保留」只拿保留意见那段去比，不再带着"A"（否则 A + 保留会被读成推翻 B）');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
