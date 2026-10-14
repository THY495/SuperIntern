// 修改溯源：契约条款编号、步骤 → 条款 / 指令 / 规则的出处边、契约版本的来源与批准、出处边只增。
//
// 跑：node tests/provenance.test.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, ensureOwner, newId, now, insertEdge, supersedeEdges } from '../src/db/db.mjs';
import { writeConstitution } from '../src/db/constitutions.mjs';
import { insertNode } from '../src/db/nodes.mjs';
import { splitClauses, assignClauseKeys, doneLines, annotateDone, clausesQuoted } from '../src/core/clauses.mjs';
import { clausesOf, recordCoverage, nodeProvenance, approvalOf, constitutionSources, linkSystemNode, linkInstruction, bindApproval } from '../src/core/provenance.mjs';
import { validatePlan, persistPlan, plan } from '../src/agent/planner.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { recordMessage, recordAnswer } from '../src/core/inbox.mjs';
import { insertQuestion } from '../src/core/questions.mjs';
import { createTaskFromSpec } from '../src/core/project.mjs';
import { proposeRevision, nodesForReplan } from '../src/core/revision.mjs';
import { addUser, setGitIdentity } from '../src/core/users.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { commitTrailers, nodeCommits, taskProvenanceMarkdown } from '../src/core/provenance-render.mjs';
import { commitWorkspace } from '../src/core/workspace.mjs';
import { parseTraceQuery, traceCommit, traceLine, renderTrace, noStepNote } from '../src/core/trace.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throwsLike = (fn, re, m) => { try { fn(); bad(m, '没有抛错'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, e.message); } };
const section = (s) => console.log(`\n── ${s}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-prov-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const fresh = () => {
  const db = openDb(join(TMP, `${newId('db')}.db`));
  const { userId, plaintext } = ensureOwner(db);
  const taskId = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','planning',?)`, taskId, userId, now());
  return { db, userId, plaintext, taskId };
};
const C = { goal: '给订单列表加 CSV 导出', scope: '只动 src/api/orders.mjs', definitionOfDone: '验收：\n- 导出的表头是 id,amount,created_at\n- node --test 全过', constraints: ['不引入新依赖', '金额保留两位小数'] };

section('① 条款切分与编号');
{
  eq(doneLines('验收：\n- a 行\n\n2. b 行\n结尾：'), ['a 行', 'b 行', '结尾：'], '完成定义按行切；"验收："这种后面还有内容的小标题不算条款，列表符号去掉；最后一行冒号结尾但后面没东西 → 照算');
  const v1 = assignClauseKeys(splitClauses({ goal: C.goal, scope: C.scope, definition_of_done: C.definitionOfDone, constraints: C.constraints }));
  eq(v1.map((c) => `${c.key}:${c.kind}`), ['C1:goal', 'C2:scope', 'C3:done', 'C4:done', 'C5:constraint', 'C6:constraint'], 'v1 —— 目标、范围、完成定义每行、约束每条，按出现顺序编号');
  const v2 = assignClauseKeys(splitClauses({ goal: C.goal, scope: C.scope, definition_of_done: '- node --test 全过\n- 导出的表头是 id,amount,created_at,status', constraints: ['金额保留两位小数', '不引入新依赖'] }), { prev: v1, maxUsed: 6 });
  eq(v2.map((c) => c.key), ['C1', 'C2', 'C4', 'C7', 'C6', 'C5'], 'v2：同文字的沿用旧号（顺序换了也认得），改了字的拿新号 C7，退役的 C3 不复用');
  eq(clausesQuoted(v1, '[C5] 不引入 新依赖'), ['C5'], '引文落在哪条：去掉编号与空白后是条款的子串');
  eq(clausesQuoted(v1, '订单'), [], '太短的引文不判');
  eq(annotateDone(C.definitionOfDone, v1), '验收：\n- [C3] 导出的表头是 id,amount,created_at\n- [C4] node --test 全过', '给模型看的完成定义：保留原行与小标题，只在条款行前加编号');
}

section('② 落库与迁移');
{
  const { db, taskId } = fresh();
  const c1 = writeConstitution(db, { taskId, version: 1, ...C });
  const c2 = writeConstitution(db, { taskId, version: 2, ...C, constraints: ['不引入新依赖'], supersedes: c1 });
  const c3 = writeConstitution(db, { taskId, version: 3, ...C, supersedes: c2 });
  eq(clausesOf(db, c2).map((c) => c.key), ['C1', 'C2', 'C3', 'C4', 'C5'], '写一版契约时切好编号存进 clauses');
  eq(clausesOf(db, c3).at(-1), { key: 'C7', kind: 'constraint', text: '金额保留两位小数' }, 'v2 删掉、v3 又加回来的条款拿新号（v2 不认得它；C6 已退役）');
  db.close();

  // v35 的库（没有 clauses 列、edges 没有触发器）→ 升级回填
  const p = join(TMP, 'up.db');
  const old = openDb(p, { migrateTo: 35 });
  old.run(`INSERT INTO users (id, display_name, role, created_at) VALUES ('u_o', 'o', 'lead', 1)`);
  old.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES ('t_o','u_o','x','planning',1)`);
  old.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at,superseded_at) VALUES ('c_a','t_o',1,'g','s','d1\nd2','["k1"]',1,1,2)`);
  old.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES ('c_b','t_o',2,'g','s','d2\nd3','["k1"]',2,2)`);
  old.run(`INSERT INTO edges (from_id,to_id,relation,valid_from,recorded_at) VALUES ('x','y','depends_on',1,1)`);
  old.run(`DELETE FROM edges WHERE from_id='x'`);
  ok('v35 的库上还能删出处边（升级前的样子）');
  old.close();
  const d = openDb(p);
  eq(clausesOf(d, 'c_b').map((c) => `${c.key}=${c.text}`), ['C1=g', 'C2=s', 'C4=d2', 'C6=d3', 'C5=k1'], '升级回填：按版本顺序编号，v2 沿用 v1 的号（d1 退役的 C3 不复用）');
  insertEdge(d, 'a', 'b', 'depends_on');
  throwsLike(() => d.run(`DELETE FROM edges WHERE from_id='a'`), /append-only/, '升级后出处边删不掉');
  throwsLike(() => d.run(`UPDATE edges SET to_id='z' WHERE from_id='a'`), /append-only/, '端点改不了');
  throwsLike(() => d.run(`UPDATE edges SET relation='derived_from' WHERE from_id='a'`), /append-only/, '关系改不了');
  supersedeEdges(d, { from: 'a', relation: 'depends_on' });
  assert(d.one(`SELECT superseded_at FROM edges WHERE from_id='a'`).superseded_at, '"置为不算数"照常（superseded_at 由空变非空）');
  throwsLike(() => d.run(`UPDATE edges SET superseded_at=1 WHERE from_id='a'`), /append-only/, '不算数的时刻只能记一次，事后改不了');
  d.close();
}

section('③ 规划：covers 校验，步骤 → 条款的出处边');
{
  const { db, taskId } = fresh();
  const cid = writeConstitution(db, { taskId, version: 1, ...C });
  const cons = db.one(`SELECT * FROM constitutions WHERE id=?`, cid);
  const node = (key, extra = {}) => ({ key, title: `T-${key}`, spec: 'do it', acceptance: 'node --test 通过', rules: [], depends_on: [], risk_tier: 'normal', model_tier: 'standard', ...extra });
  const keys = clausesOf(db, cid).map((c) => c.key);
  const errs = validatePlan({ nodes: [node('n1', { covers: ['C3', 'C9'] }), node('n2')] }, { clauseKeys: keys });
  assert(errs.some((e) => /C9 不是宪法块里的条款编号/.test(e)), 'covers 编了不存在的编号 → 拒收（让规划器重来）', errs.join(' | '));
  eq(validatePlan({ nodes: [node('n1', { covers: ['C3'] }), node('n2')] }, { clauseKeys: keys }), [], '编号对得上 / 不填 → 通过');

  // 走一遍真规划器（假模型）：看它看到的宪法块带编号、方案落库后出处边齐全
  let seen = null;
  const fake = makeFake([{ stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'tool_call', id: 'c1', name: 'submit_plan', args: {
    rationale: 'r', nodes: [
      node('n1', { covers: ['C3'], rules: [{ rule: '金额两位小数', quote: '[C6] 金额保留两位小数' }] }),
      node('n2', { depends_on: ['n1'] }),
    ] } }] }]);
  const orig = fake.nextScripted; fake.nextScripted = function () { return orig.call(this); };
  const client = new LlmClient({ mode: 'fake', fake });
  const realComplete = client.complete.bind(client);
  client.complete = (canon) => { seen = canon.messages[0].content[0].text; return realComplete(canon); };
  const r = await plan(db, { client, taskId, constitution: cons });
  assert(/\[C1\] 给订单列表加 CSV 导出/.test(seen) && /- \[C6\] 金额保留两位小数/.test(seen), '规划器看到的宪法块每条前面标了编号');
  eq(r.kind, 'plan', '带编号的引文照样通过核对（编号不是原文，核对时去掉）');
  const ids = persistPlan(db, { taskId, constitutionId: cid, nodes: r.nodes, rationale: r.rationale });
  eq(nodeProvenance(db, ids[0]).clauses.map((c) => c.key), ['C3', 'C6'], 'n1 落实 C3（covers 明说）与 C6（规则引文落在这条，机械推出）');
  eq(nodeProvenance(db, ids[1]).clauses, [], 'n2 没说也没引 → 只挂整版契约');
  eq(nodeProvenance(db, ids[1]).constitution?.version, 1, '每一步都挂着依据的那一版契约');
}

section('④ 系统补的步骤、补充上下文、对某一步提问的答复');
{
  const { db, taskId, plaintext } = fresh();
  writeConstitution(db, { taskId, version: 1, ...C });
  const sys = newId('n');
  insertNode(db, { id: sys, taskId, title: '写截图说明', spec: 's', acceptance: 'a' });
  linkSystemNode(db, { nodeId: sys, taskId, policy: 'preview_spec' });
  const ps = nodeProvenance(db, sys);
  eq(ps.policy, { id: 'preview_spec' }, '系统补的步骤：出处是哪条内置规则');
  eq(ps.constitution?.version, 1, '……以及当时的那一版契约');

  const n = newId('n');
  insertNode(db, { id: n, taskId, title: '导出', spec: 's', acceptance: 'a' });
  const ctx = recordMessage(db, { taskId, body: '金额字段在 legacy 表里叫 amt', kind: 'context', plaintextToken: plaintext });
  linkInstruction(db, { nodeId: n, messageId: ctx.messageId });
  linkInstruction(db, { nodeId: n, messageId: ctx.messageId });
  eq(db.one(`SELECT count(*) n FROM edges WHERE from_id=? AND to_id=?`, n, ctx.messageId).n, 1, '同一对只记一次');
  const qid = newId('q');
  db.tx(() => insertQuestion(db, { id: qid, taskId, nodeId: n, level: 2, text: '日期用什么格式？', defaultAction: 'ISO 8601', askedAt: now() }));
  recordAnswer(db, { questionId: qid, body: '用 ISO 8601', plaintextToken: plaintext });
  const pn = nodeProvenance(db, n);
  eq(pn.instructions.map((m) => m.body), ['金额字段在 legacy 表里叫 amt', '用 ISO 8601'], '步骤的指令来源：读进的补充上下文 + 对本步提问的答复（按时间）');
  assert(pn.instructions.every((m) => m.senders[0]?.name), '每条都带发送人');
  assert(db.one(`SELECT 1 FROM edges WHERE from_id=? AND relation='derived_from' AND to_id IN (SELECT from_id FROM edges WHERE to_id=? AND relation='answers')`, n, qid), '答复落库时就写了 步骤 → 答复 的出处边');
}

section('⑤ 契约版本的来源与批准');
{
  const { db, userId } = fresh();
  // 命令行直接给契约：建任务的人就是批准人
  const a = createTaskFromSpec(db, { title: 'A', goal: 'g', scope: 's', definition_of_done: 'd', constraints: ['k'] }, { userId, approvedBy: userId });
  const ap = approvalOf(db, a.constId);
  eq([ap?.kind, ap?.by[0]?.id], ['direct', userId], '命令行直接给契约 → 批准人是建任务的人（direct）');
  // 重做：逐字相同 → 沿用原任务那一版的批准；改过字的不沿用
  const b = createTaskFromSpec(db, { title: 'A', goal: 'g', scope: 's', definition_of_done: 'd', constraints: ['k'] }, { userId, derivedFrom: a.constId });
  eq(approvalOf(db, b.constId)?.kind, 'inherited', '重做（契约逐字相同）→ 沿用原任务的批准，并标明是沿用的');
  const c = createTaskFromSpec(db, { title: 'A', goal: 'g2', scope: 's', definition_of_done: 'd', constraints: ['k'] }, { userId, derivedFrom: a.constId });
  eq(approvalOf(db, c.constId), null, '出处相同但契约改过字 → 不沿用批准');
  bindApproval(db, { constitutionId: c.constId, userId });
  const other = addUser(db, { name: 'bob', role: 'member', byUserId: userId });
  bindApproval(db, { constitutionId: c.constId, userId: other.userId ?? other.id });
  eq(approvalOf(db, c.constId)?.by[0]?.id, userId, '批准只绑一次：后来的不覆盖');
  // 项目里的任务：出处是项目
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,status,created_at) VALUES ('p_x',?,'P','brief','/r','main','main','active',?)`, userId, now());
  const d = createTaskFromSpec(db, { title: 'D', goal: 'g', scope: 's', definition_of_done: 'd' }, { userId, projectId: 'p_x', order: 1 });
  eq(constitutionSources(db, d.constId).projects.map((p) => p.id), ['p_x'], '项目里的任务：契约出自项目');
}

section('⑥ 修订：在事项里批准 → 新版契约绑到那条答复');
{
  const { db, taskId, plaintext } = fresh();
  writeConstitution(db, { taskId, version: 1, goal: '做一个 CSV 导出', scope: '只动 src/', definitionOfDone: '导出功能可用', constraints: [] });
  const n1 = newId('n');
  insertNode(db, { id: n1, taskId, title: '导出', spec: 's', acceptance: 'a' });
  db.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);
  const m = recordMessage(db, { taskId, body: '目标改成 JSON 导出', kind: 'correction', plaintextToken: plaintext });
  const msg = db.one(`SELECT * FROM messages WHERE id=?`, m.messageId);
  const prop = proposeRevision(db, { taskId, message: msg, nodes: nodesForReplan(db, taskId),
    rev: { impact: [{ node_id: n1, mark: 'unaffected', reason: 'x' }], constitution_patch: { goal: '做一个 JSON 导出' }, rationale: '目标变了' } });
  assert(prop.questionId, '改契约 → 触发批准门');
  const ans = recordAnswer(db, { questionId: prop.questionId, body: 'A', plaintextToken: plaintext });
  const v2 = db.one(`SELECT id, version FROM constitutions WHERE task_id=? AND superseded_at IS NULL`, taskId);
  eq(v2.version, 2, '批准后升到 v2');
  const apv = approvalOf(db, v2.id);
  eq([apv?.kind, apv?.messageId], ['approval', ans.messageId], 'v2 的批准 = 事项里那条批准答复');
  assert(constitutionSources(db, v2.id).messages.some((x) => x.id === m.messageId), 'v2 出自那条修正');
}

section('⑦ 提交 trailer、PR 溯源表、成员的 GitHub 账号');
{
  const { db, userId, plaintext } = fresh();
  const bob = addUser(db, { name: 'bob', role: 'member', byUserId: userId });
  const bobId = bob.userId ?? bob.id;
  // 成员的 GitHub 账号：本人或管理员改；格式核对；同一个账号不能对应两个人
  throwsLike(() => setGitIdentity(db, { userId, github: 'bad name', byUserId: userId }), /格式不对/, 'GitHub 账号格式不对 → 拒');
  throwsLike(() => setGitIdentity(db, { userId, github: 'a--b', byUserId: userId }), /格式不对/, '连续连字符 → 拒（GitHub 不允许）');
  throwsLike(() => setGitIdentity(db, { userId, byUserId: bobId, github: 'x' }), /只能改自己的/, '成员改别人的 → 拒');
  setGitIdentity(db, { userId, github: '@Alice-Dev', email: '1+alice@users.noreply.github.com', byUserId: userId });
  eq(db.one(`SELECT github_login, commit_email FROM users WHERE id=?`, userId), { github_login: 'Alice-Dev', commit_email: '1+alice@users.noreply.github.com' }, '本人改自己的：去掉开头的 @ 后存下');
  throwsLike(() => setGitIdentity(db, { userId: bobId, github: 'alice-dev', byUserId: bobId }), /已经对应了另一位成员/, '同一个 GitHub 账号（不分大小写）不能对应两个人');
  setGitIdentity(db, { userId: bobId, github: 'bob', email: '', byUserId: bobId });
  // 看板地址设置：只收 http(s)、不带口令与查询串
  throwsLike(() => setSetting(db, { key: 'deploy.board_url', value: 'ftp://x', userId }), /值无效/, '看板地址不是 http(s) → 拒');
  throwsLike(() => setSetting(db, { key: 'deploy.board_url', value: 'https://u:p@x.example', userId }), /值无效/, '带用户名口令 → 拒');
  eq(setSetting(db, { key: 'deploy.board_url', value: ' https://si.example.com/ ', userId }).value, 'https://si.example.com', '去掉首尾空白与结尾斜杠');

  // 一个任务：命令行直接给契约（alice 批准）→ 一步落实 C3，bob 对这一步答过问
  const t = createTaskFromSpec(db, { title: 'CSV', goal: '导出 CSV', scope: '只动 src/', definition_of_done: '- 表头是 id,amount\n- 测试全过' }, { userId, approvedBy: userId });
  const n = newId('n');
  insertNode(db, { id: n, taskId: t.taskId, title: '导出 | 表头', spec: 's', acceptance: 'a' });
  insertEdge(db, n, t.constId, 'derived_from');
  recordCoverage(db, { nodeId: n, constitutionId: t.constId, covers: ['C3'] });
  const qid = newId('q');
  db.tx(() => insertQuestion(db, { id: qid, taskId: t.taskId, nodeId: n, level: 2, text: '金额几位小数？', defaultAction: '两位', askedAt: now() }));
  const bobTok = db.one(`SELECT 1 FROM tokens WHERE user_id=?`, bobId) ? (bob.plaintext ?? null) : null;
  recordAnswer(db, { questionId: qid, body: '两位小数', plaintextToken: bobTok ?? plaintext });
  // bob 的 GitHub 账号是他自己填的、没验证：不写进 trailer（防冒名，core/git-identity.mjs）
  const who = bobTok ? 'bob' : db.one(`SELECT display_name FROM users WHERE id=?`, userId).display_name + ' (@Alice-Dev)';

  let tr = commitTrailers(db, n, { handoffId: 'h_1' });
  eq(tr.slice(0, 2), [`node: ${n}`, 'handoff: h_1'], '保留原来的 node: / handoff: 两行（按步骤找提交认它们）');
  assert(tr.includes(`SuperIntern-Task: ${t.taskId}`) && tr.includes(`SuperIntern-Node: ${n}`) && tr.includes('SuperIntern-Handoff: h_1'), 'SuperIntern-Task / -Node / -Handoff');
  assert(tr.some((l) => /^Contract: v1 \(approved-by .+ \(@Alice-Dev\), direct; \d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/.test(l)), 'Contract：第几版、谁批准（名字后跟 GitHub 账号）、怎么批的、何时', tr.join(' | '));
  assert(tr.includes('Clauses: C3'), 'Clauses：落实的条款编号');
  assert(tr.includes(`Instructed-by: ${who}`), 'Instructed-by：对这一步答过问的人（自己填、没验证的 GitHub 账号不写）', tr.join(' | '));
  setGitIdentity(db, { userId: bobId, github: 'bob', byUserId: userId });
  assert(commitTrailers(db, n, { handoffId: 'h_1' }).includes(bobTok ? 'Instructed-by: bob (@bob)' : `Instructed-by: ${who}`), '管理员替他填过：写成 名字 (@账号)');
  assert(tr.includes('Trace: https://si.example.com/#' + t.taskId + '/node/' + n), 'Trace：看板上这一步的链接（看板路由 #<任务>/node/<步骤>）');
  assert(!tr.some((l) => l.startsWith('Co-authored-by')), 'Co-authored-by 默认不加');
  setSetting(db, { key: 'deploy.commit_coauthor', value: true, userId });
  tr = commitTrailers(db, n, { handoffId: 'h_1' });
  assert(tr.some((l) => l === `Co-authored-by: ${db.one(`SELECT display_name FROM users WHERE id=?`, userId).display_name} <1+alice@users.noreply.github.com>`), '打开后：给填了提交邮箱的批准人加 Co-authored-by');
  assert(!tr.some((l) => /<>|bob </.test(l)), '没填提交邮箱的人不加');

  // 真的提交一次：git 自己能把这些认成 trailer
  const repo = join(TMP, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x');
  const sha = commitWorkspace(repo, `导出 | 表头\n\n${tr.join('\n')}`);
  const parsed = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%(trailers:key=Clauses,valueonly)%(trailers:key=SuperIntern-Node,valueonly)'], { encoding: 'utf8' }).trim().split('\n');
  eq(parsed, ['C3', n], 'git log 的 %(trailers) 认得出这些行（GitHub、git interpret-trailers 同理）');
  eq(nodeCommits(repo, n), [sha.slice(0, 7)], '按 node: 行找回这一步的提交');

  // PR 溯源表
  const md = taskProvenanceMarkdown(db, t.taskId, { L: 'zh', dir: repo, delivery: { by: 'alice', credential: 'GitHub App' } });
  assert(/契约 v1[：].+（`@Alice-Dev`） ?于 .+ 直接批准/.test(md), '批准行：GitHub 账号写成代码样式（PR 正文里裸的 @ 会通知人）', md.split('\n')[0]);
  assert(/交付：alice，所用连接：GitHub App/.test(md), '交付行：谁、用的哪份连接');
  assert(/签收：没有签收记录/.test(md), '没签收就照实写没签收');
  assert(md.includes('| 导出 \\| 表头 |') && md.includes('C3 表头是 id,amount') && md.includes('“两位小数”') && md.includes(`\`${sha.slice(0, 7)}\``), '表格一行：步骤（| 转义）→ 条款 → 指令来源 → 提交', md);

  section('⑧ 追溯：提交号 / 文件:行号 → 步骤 → 条款、指令、批准');
  eq(parseTraceQuery(' 3f2a9c1 '), { kind: 'commit', rev: '3f2a9c1' }, '十六进制 → 提交');
  eq(parseTraceQuery('HEAD~2'), { kind: 'commit', rev: 'HEAD~2' }, 'HEAD~n → 提交');
  eq(parseTraceQuery('src\\api\\orders.mjs:42'), { kind: 'line', file: 'src/api/orders.mjs', line: 42 }, '文件:行号（反斜杠换成 /）');
  for (const q of ['--output=/tmp/x:1', '-L1,2:3', 'HEAD^', 'main', '', 'a.txt:0x1']) throwsLike(() => parseTraceQuery(q), /看不懂要追溯什么/, `拒：${JSON.stringify(q)}（不会被 git 当成选项或任意引用）`);
  throwsLike(() => traceCommit(db, { dir: repo, rev: '--all' }), /提交号不对/, 'traceCommit 自己也只收提交号形状');
  throwsLike(() => traceCommit(db, { dir: repo, rev: 'deadbeef' }), /找不到提交 deadbeef/, '仓库里没有的提交');

  let r = traceCommit(db, { dir: repo, rev: sha });
  eq([r.commit.kind, r.commit.subject, r.nodes.length, r.nodes[0].node.id, r.nodes[0].clauses.map((c) => c.key)], ['step', '导出 | 表头', 1, n, ['C3']], '提交 → 这一步，带条款');
  r = traceLine(db, { dir: repo, file: 'a.txt', line: 1 });
  eq([r.text, r.commit.sha.slice(0, 7), r.nodes[0]?.node.id], ['x', sha.slice(0, 7), n], '文件:行号 → blame → 同一个提交与步骤');
  const txt = renderTrace(r, 'zh');
  assert(txt.includes('a.txt 第 1 行：x') && txt.includes('C3  表头是 id,amount') && txt.includes('bob (@bob)（答“金额几位小数？”）两位小数') && /契约 v1[：].+ \(@Alice-Dev\) 于/.test(txt), '命令行文字版：行、条款、指令来源（带 GitHub 账号）、批准', txt);
  writeFileSync(join(repo, 'a.txt'), 'y\n');
  r = traceLine(db, { dir: repo, file: 'a.txt', line: 1 });
  assert(r.uncommitted && /还没提交/.test(renderTrace(r, 'zh')), '工作区里改了还没提交的行：照实说没有出处（行号按磁盘上的文件对）');
  throwsLike(() => traceLine(db, { dir: repo, file: 'nope.txt', line: 1 }), /git blame 失败/, '没有这个文件');
  throwsLike(() => traceLine(db, { dir: repo, file: '--output=x', line: 1 }), /要给 文件:行号/, '文件名像选项 → 拒');
  execFileSync('git', ['-C', repo, 'checkout', '-q', '--', 'a.txt']);

  // squash：一个提交里并着几步的 node: 行；其中一步不在这个库里
  const n2 = newId('n');
  insertNode(db, { id: n2, taskId: t.taskId, title: '第二步', spec: 's', acceptance: 'a' });
  writeFileSync(join(repo, 'b.txt'), 'b');
  const sq = commitWorkspace(repo, `导出 CSV (#12)\n\n* 导出 | 表头\n\nnode: ${n}\n\n* 第二步\n\nnode: ${n2}\nnode: n_0123456789ab`);
  r = traceCommit(db, { dir: repo, rev: sq });
  eq(r.nodes.map((p) => p.missing ?? p.node.id), [n, n2, 'n_0123456789ab'], 'squash 合并出来的提交：几步都认出来，库里没有的照实标出');
  assert(/步骤 n_0123456789ab 不在这个库里/.test(renderTrace(r, 'zh')), '库里没有的那步：说清楚');

  // 不属于哪一步的提交：起点 / 合并 / 别处来的
  const r2 = join(TMP, 'repo2');
  execFileSync('git', ['init', '-q', '-b', 'main', r2]);
  const g2 = (...a) => execFileSync('git', ['-C', r2, '-c', 'user.name=superintern', '-c', 'user.email=s@l', ...a], { encoding: 'utf8' }).trim();
  g2('commit', '-q', '--allow-empty', '-m', 'init: t_0123abcd');
  eq(traceCommit(db, { dir: r2, rev: 'HEAD' }).commit.kind, 'init', 'SuperIntern 建仓库的空起点提交');
  g2('checkout', '-q', '-b', 'side'); writeFileSync(join(r2, 's.txt'), 's'); g2('add', '-A'); g2('commit', '-q', '-m', '人改的');
  eq(traceCommit(db, { dir: r2, rev: 'HEAD' }).commit.kind, 'other', '没有 node: 行的普通提交');
  g2('checkout', '-q', 'main'); writeFileSync(join(r2, 'm.txt'), 'm'); g2('add', '-A'); g2('commit', '-q', '-m', 'main 上的');
  g2('merge', '-q', '--no-ff', '--no-edit', 'side');
  eq(traceCommit(db, { dir: r2, rev: 'HEAD' }).commit.kind, 'merge', '合并提交');
  eq(new Set(['init', 'merge', 'other'].map((k) => noStepNote('zh', k))).size, 3, '三种各有说法');
  assert(/建仓库时的空起点提交/.test(renderTrace(traceCommit(db, { dir: r2, rev: 'HEAD~1' }), 'zh')) === false, '（HEAD~1 是 main 上的普通提交，不误报成起点）');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
