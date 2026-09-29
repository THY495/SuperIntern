// 答复与冲突
//
// 跑：node tests/answers.test.mjs
//
// 断言的是多人答复的语义：法定人数数人头；够数且一致才生效；不一致 → 冲突事项（双方阶段 → 负责人）；
// 负责人覆盖介入者且异议留档；轮值后答生效并留痕；旁观者不能答只能留言；签收是决策事项、挂 commit；
// 路由行时限到期 next / default 各走各的。

import { openDb, ensureOwner, newId, now, insertEdge } from '../src/db/db.mjs';
import { recordAnswer, answersOf } from '../src/core/answers.mjs';
import { recordMessage } from '../src/core/inbox.mjs';
import { applyTemplate, saveRules, rulesOf, routeQuestion, setDutyCalendar } from '../src/core/routing.mjs';
import { sweepTimeouts } from '../src/core/timeouts.mjs';
import { signOff, signoffOf, signoffHeadOf, raiseSignoffQuestion, openSignoffQuestion, deliverTask } from '../src/core/deliver.mjs';
import { setLimit } from '../src/core/limits.mjs';
import { randomBytes } from 'node:crypto';
import { sha256 } from '../src/db/db.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throwsWith = (fn, re, m) => { try { fn(); bad(m, '没有抛'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `抛了但不是预期：${e.message}`); } };

const db = openDb(':memory:');
const owner = ensureOwner(db, 'lead');
const lead = owner.userId;
const t0 = now();
const addUser = (name, role, tags = []) => {
  const id = newId('u');
  const plaintext = randomBytes(12).toString('base64url');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,?,?,?)`, id, name, role, JSON.stringify(tags), t0);
  db.run(`INSERT INTO tokens (id,user_id,token_hash,issued_by,issued_at) VALUES (?,?,?,?,?)`, newId('tk'), id, sha256(plaintext), lead, t0);
  return { id, plaintext };
};
const alice = addUser('alice', 'member', ['reviewer']);
const bob = addUser('bob', 'member', ['reviewer']);
const carol = addUser('carol', 'observer');
const mkTask = (status = 'waiting') => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'t',?,?)`, id, lead, status, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), id, t0, t0);
  return id;
};
const mkNode = (taskId, status = 'blocked') => {
  const id = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,created_at) VALUES (?,?,'n','s','a',?,?)`, id, taskId, status, t0);
  return id;
};
const mkQ = (taskId, { type = 'spec_choice', nodeId = null, level = 2, at = t0 } = {}) => {
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
          VALUES (?,?,?,?,'classifier','要 A 还是 B？',?,?,NULL,'open')`, id, taskId, nodeId, level, level === 3 ? null : '按 A', at);
  db.tx(() => routeQuestion(db, { questionId: id, decisionType: type, typeSource: 'hard_rule', at }));
  return id;
};
const status = (qid) => db.one(`SELECT status FROM questions WHERE id=?`, qid).status;
const auditActions = (qid) => db.all(`SELECT action FROM audit_log WHERE target_id=? ORDER BY id`, qid).map((r) => r.action);

// 同行评审：规格取舍要 alice + bob 都答（quorum 2）；签收同样 quorum 2。
applyTemplate(db, { key: '', name: 'peer_review', userId: lead });
{
  const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  const sc = rules.find((r) => r.decision_type === 'spec_choice');
  sc.recipients = ['group:reviewer']; sc.quorum = '2';
  saveRules(db, { key: '', rules, template: 'peer_review', userId: lead });
}

section('1. 法定人数：一人答不生效；两人一致才生效');
{
  const task = mkTask();
  const node = mkNode(task);
  const q = mkQ(task, { nodeId: node });
  const r1 = recordAnswer(db, { questionId: q, body: 'A', plaintextToken: alice.plaintext });
  eq(r1.resolved, false, 'alice 一人答：未决');
  eq(r1.pending, [{ scope: '*', need: 2, have: 1 }], '差一人');
  eq(status(q), 'open', '问题仍 open');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, node).status, 'blocked', '节点仍挂起');
  const r2 = recordAnswer(db, { questionId: q, body: ' a ', plaintextToken: bob.plaintext });
  eq(r2.resolved, true, 'bob 答同样的（大小写空白不计）：生效');
  eq(r2.how, 'quorum', '按法定人数生效');
  eq(status(q), 'answered', '问题 answered');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, node).status, 'pending', '节点退回 pending');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, task).status, 'running', '任务转 running');
  eq(answersOf(db, q).map((a) => a.stance), ['answer', 'answer'], 'answers 表两行');
  assert(db.one(`SELECT 1 FROM edges WHERE to_id=? AND relation='answers'`, q), 'answers 边挂上了');
}

section('2. 不一致 → 冲突事项：双方阶段一致即了结，原事项按结论了结、输方标 dissent');
{
  const task = mkTask();
  const node = mkNode(task);
  const q = mkQ(task, { nodeId: node });
  recordAnswer(db, { questionId: q, body: 'A', plaintextToken: alice.plaintext });
  const r = recordAnswer(db, { questionId: q, body: 'B', plaintextToken: bob.plaintext });
  eq(r.resolved, false, '不一致：不生效');
  assert(r.conflictId, `生成冲突事项 ${r.conflictId}`);
  eq(status(q), 'escalated', '原事项置 escalated');
  const c = db.one(`SELECT * FROM questions WHERE id=?`, r.conflictId);
  eq(c.decision_type, 'conflict', '冲突类型');
  eq(c.origin_question_id, q, '指回原事项');
  eq(JSON.parse(c.addressed_to).sort(), [alice.id, bob.id].sort(), '双方阶段：收件人 = 双方');
  eq(JSON.parse(c.route).rows[0].quorum, 'all', 'quorum all');
  assert(c.route_due_at > t0, '有一个工作日的时限');
  assert(c.text.includes('（A）alice：A') && c.text.includes('（B）bob：B'), '正文两边等深并列');
  assert(!db.one(`SELECT 1 FROM edges WHERE to_id=? AND relation='answers'`, q), '原事项没有 answers 边');
  throwsWith(() => recordAnswer(db, { questionId: q, body: 'A', plaintextToken: alice.plaintext }), /冲突处理中/, '冲突中原事项不接受介入者再答');
  // 双方阶段：bob 改口同意 A
  const r2 = recordAnswer(db, { questionId: r.conflictId, body: 'A', plaintextToken: alice.plaintext });
  eq(r2.resolved, false, 'alice 重述：还等 bob');
  const r3 = recordAnswer(db, { questionId: r.conflictId, body: 'A', plaintextToken: bob.plaintext });
  eq(r3.resolved, true, 'bob 同意 A：达成');
  eq(r3.how, 'parties_agreed', '双方达成');
  eq(r3.originId, q, '回写了原事项');
  eq(status(q), 'answered', '原事项 answered');
  eq(answersOf(db, q).map((a) => [a.user_id === alice.id ? 'alice' : 'bob', a.stance]), [['alice', 'answer'], ['bob', 'dissent']], 'bob 原来的 B 标 dissent');
  assert(db.one(`SELECT 1 FROM edges WHERE to_id=? AND relation='answers' AND superseded_at IS NULL`, q), '原事项挂上 answers 边');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, node).status, 'pending', '节点解冻');
  assert(auditActions(q).includes('conflict_raised') && auditActions(q).includes('conflict_resolved'), '审计：conflict_raised / conflict_resolved');
}

section('3. 双方阶段再不一致 → 转负责人；负责人裁定回写；一方撤回也算达成');
{
  const task = mkTask();
  const q = mkQ(task);
  recordAnswer(db, { questionId: q, body: 'A', plaintextToken: alice.plaintext });
  const { conflictId } = recordAnswer(db, { questionId: q, body: 'B', plaintextToken: bob.plaintext });
  recordAnswer(db, { questionId: conflictId, body: 'A', plaintextToken: alice.plaintext });
  const r = recordAnswer(db, { questionId: conflictId, body: 'B', plaintextToken: bob.plaintext });
  eq(r.escalated, true, '再不一致：升级');
  eq(r.to, [lead], '转给负责人');
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, conflictId).addressed_to), [lead], '冲突事项收件人 = 负责人');
  throwsWith(() => recordAnswer(db, { questionId: conflictId, body: 'A', plaintextToken: alice.plaintext }), /不是该事项的接收人/, '升级后 alice 不能再答冲突事项');
  const r2 = recordAnswer(db, { questionId: conflictId, body: '按 B，理由略', plaintextToken: owner.plaintext });
  eq(r2.resolved, true, '负责人裁定');
  eq(status(q), 'answered', '原事项 answered');
  const st = Object.fromEntries(answersOf(db, q).filter((a) => a.user_id).map((a) => [a.user_id === alice.id ? 'alice' : a.user_id === bob.id ? 'bob' : 'lead', a.stance]));
  eq(st, { alice: 'dissent', bob: 'dissent', lead: 'answer' }, '负责人的新答案生效，双方原答复都是 dissent');
  // 撤回
  const q2 = mkQ(task);
  recordAnswer(db, { questionId: q2, body: 'A', plaintextToken: alice.plaintext });
  const { conflictId: c2 } = recordAnswer(db, { questionId: q2, body: 'B', plaintextToken: bob.plaintext });
  recordAnswer(db, { questionId: c2, body: '撤回', plaintextToken: bob.plaintext });
  const r3 = recordAnswer(db, { questionId: c2, body: 'A', plaintextToken: alice.plaintext });
  eq(r3.resolved, true, 'bob 撤回 + alice 重述 = 达成');
  eq(status(q2), 'answered', '原事项按 A 了结');
}

section('4. 负责人覆盖介入者：立即生效，被覆盖的立场留档');
{
  const task = mkTask();
  const q = mkQ(task);
  recordAnswer(db, { questionId: q, body: 'A', plaintextToken: alice.plaintext });
  const r = recordAnswer(db, { questionId: q, body: 'B', plaintextToken: owner.plaintext });
  eq(r.resolved, true, '负责人一人答即生效（不等 quorum）');
  eq(r.how, 'lead_override', '标为覆盖');
  eq(answersOf(db, q).find((a) => a.user_id === alice.id).stance, 'dissent', 'alice 的 A 标 dissent');
  const ov = db.one(`SELECT payload FROM audit_log WHERE action='answer_overridden' AND target_id=?`, q);
  assert(ov && JSON.parse(ov.payload).notify.includes(alice.id), '审计 answer_overridden，通知名单含 alice');
  const q2 = mkQ(task);
  recordAnswer(db, { questionId: q2, body: 'A', plaintextToken: alice.plaintext });
  const r2 = recordAnswer(db, { questionId: q2, body: 'A', plaintextToken: owner.plaintext });
  eq(r2.how, 'lead', '负责人与介入者一致：不算覆盖');
  eq(answersOf(db, q2).find((a) => a.user_id === alice.id).stance, 'answer', '一致时不标 dissent');
}

section('5. 旁观者与非收件人');
{
  const task = mkTask();
  const q = mkQ(task);
  throwsWith(() => recordAnswer(db, { questionId: q, body: 'A', plaintextToken: carol.plaintext }), /旁观者不能答复/, '旁观者不能答');
  const dave = addUser('dave', 'member');
  throwsWith(() => recordAnswer(db, { questionId: q, body: 'A', plaintextToken: dave.plaintext }), /不是该事项的接收人/, '不在收件人里的 member 不能答');
  throwsWith(() => recordMessage(db, { taskId: task, body: '我觉得该 B', kind: 'instruction', plaintextToken: carol.plaintext }), /旁观者只能留言/, '旁观者不能发指令');
  const m = recordMessage(db, { taskId: task, body: '我觉得该 B', kind: 'context', aboutQuestionId: q, plaintextToken: carol.plaintext });
  eq(m.trust, 'observed-untrusted', '旁观者留言 trust_label = observed-untrusted');
  eq(answersOf(db, q).map((a) => a.stance), ['comment'], '留言附在事项上，不进决策');
  assert(auditActions(q).includes('comment_noted'), '开着的事项上留言：comment_noted');
  recordAnswer(db, { questionId: q, body: 'A', plaintextToken: owner.plaintext });
  recordMessage(db, { taskId: task, body: '还是不同意', kind: 'context', aboutQuestionId: q, plaintextToken: carol.plaintext });
  assert(auditActions(q).includes('dissent_noted'), '已决事项上留言：dissent_noted');
  const m2 = recordMessage(db, { taskId: task, body: '补充：见文档', kind: 'context', plaintextToken: alice.plaintext });
  eq(m2.trust, 'user-authenticated', 'member 的留言仍是 user-authenticated');
}

section('6. 轮值（latest）：任一收件人答即生效；已决事项被当班者再答 = 后答生效并留痕');
{
  setDutyCalendar(db, { key: '', users: [alice.id, bob.id], startAt: t0 - 86400_000, periodDays: 7, userId: lead });
  applyTemplate(db, { key: '', name: 'rotation', userId: lead });
  const task = mkTask();
  const q = mkQ(task);
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, q).addressed_to), [alice.id], '本周当班 alice');
  eq(db.one(`SELECT conflict_policy FROM questions WHERE id=?`, q).conflict_policy, 'latest', '策略 latest');
  const r = recordAnswer(db, { questionId: q, body: 'A', plaintextToken: alice.plaintext });
  eq(r.resolved && r.how, 'latest', '当班者一人答即生效');
  const r2 = recordAnswer(db, { questionId: q, body: 'B', plaintextToken: alice.plaintext });
  eq(r2.superseded, 1, '再答：后答生效，前一条 superseded');
  eq(answersOf(db, q).map((a) => a.stance), ['superseded', 'answer'], 'answers 表立场');
  eq(db.one(`SELECT m.body FROM messages m JOIN edges e ON e.from_id=m.id AND e.to_id=? AND e.relation='answers' AND e.superseded_at IS NULL`, q).body, 'B', '生效的 answers 边指向 B');
  const sup = db.one(`SELECT payload FROM audit_log WHERE action='answer_superseded' AND target_id=?`, q);
  assert(sup && JSON.parse(sup.payload).notify.includes(lead), '审计 answer_superseded，通知负责人');
  throwsWith(() => recordAnswer(db, { questionId: q, body: 'C', plaintextToken: bob.plaintext }), /不接受答复/, '不当班的不能改');
  applyTemplate(db, { key: '', name: 'peer_review', userId: lead });
}

section('7. 签收是决策事项：同行评审要两人；挂 commit，产物变了作废');
{
  const task = mkTask('done');
  const at = t0;
  db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,'system',NULL,'task_done','task',?,?)`, at, task, JSON.stringify({ head: 'aaaa1111', branch: 'si/x' }));
  const rq = raiseSignoffQuestion(db, { taskId: task, head: 'aaaa1111', branch: 'si/x' });
  eq(rq.addressedTo.sort(), [alice.id, bob.id].sort(), 'peer_review：签收到 reviewer 组');
  eq(signoffOf(db, task), 'pending', 'signoff.status = pending');
  eq(signoffHeadOf(db, task), 'aaaa1111', 'signoff.head 记下 commit');
  eq(raiseSignoffQuestion(db, { taskId: task, head: 'aaaa1111' }).reused, true, '同一 head 幂等');
  throwsWith(() => signOff(db, { taskId: task, accept: true, plaintextToken: carol.plaintext, userId: carol.id }), /无权/, '旁观者不能签收');
  const s1 = signOff(db, { taskId: task, accept: true, plaintextToken: alice.plaintext, userId: alice.id });
  eq(s1.accepted, null, 'alice 一人：未决');
  eq(signoffOf(db, task), 'pending', '仍 pending');
  const s2 = signOff(db, { taskId: task, accept: false, reason: '文档没更新', plaintextToken: bob.plaintext, userId: bob.id });
  assert(s2.conflictId, '一接受一打回 → 冲突事项');
  const s3 = recordAnswer(db, { questionId: s2.conflictId, body: '打回：文档没更新', plaintextToken: owner.plaintext });
  eq(s3.resolved, true, '负责人裁定打回');
  eq(signoffOf(db, task), 'rejected', 'signoff.status = rejected');
  const corr = db.one(`SELECT * FROM messages WHERE task_id=? AND kind='correction'`, task);
  assert(corr && corr.urgency === 'urgent' && corr.trust_label === 'user-authenticated' && corr.body.includes('文档没更新'), '打回落成一条认证的紧急修正');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, task).status, 'running', '打回 → 任务从 done 放回 running（守护进程只拉 running 的；不放回去修正就没人处理）');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, task);   // 模拟按修正返工后再次完成
  // 再 done 一次（新 head）：新签收事项；接受后 head 记录更新
  db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,'system',NULL,'task_done','task',?,?)`, at + 1, task, JSON.stringify({ head: 'bbbb2222', branch: 'si/x' }));
  const rq2 = raiseSignoffQuestion(db, { taskId: task, head: 'bbbb2222', branch: 'si/x' });
  eq(rq2.reused, false, '新 head 新事项');
  signOff(db, { taskId: task, accept: true, plaintextToken: alice.plaintext, userId: alice.id });
  const s4 = signOff(db, { taskId: task, accept: true, plaintextToken: bob.plaintext, userId: bob.id });
  eq(s4.accepted, true, '两人都接受');
  eq([signoffOf(db, task), signoffHeadOf(db, task)], ['accepted', 'bbbb2222'], 'accepted @ bbbb2222');
  // 产物再变 → 作废
  const rq3 = raiseSignoffQuestion(db, { taskId: task, head: 'cccc3333', branch: 'si/x' });
  eq(signoffOf(db, task), 'pending', '产物变了：签收作废、重新 pending');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='signoff_voided' AND target_id=?`, task), '审计 signoff_voided');
  assert(db.one(`SELECT text FROM questions WHERE id=?`, rq3.questionId).text.includes('已作废'), '新事项正文说明了作废');
}

section('8. 上限 / 白名单授权查路由表');
{
  const task = mkTask('running');
  throwsWith(() => setLimit(db, { taskId: task, key: 'limit.llm_calls', value: 10, userId: alice.id }), /无权/, 'alice 不在预算行：改不了上限');
  setLimit(db, { taskId: task, key: 'limit.llm_calls', value: 10, userId: lead });
  ok('负责人能改上限');
}

section('9. 路由行时限：next 转下一行；default 走默认动作');
{
  const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  const sc = rules.find((r) => r.decision_type === 'spec_choice');
  sc.recipients = [`user:${alice.id}`]; sc.quorum = '1'; sc.timeout_action = 'next'; sc.timeout_after = '8h';
  rules.push({ decision_type: 'spec_choice', scope: '*', position: 1, recipients: [], quorum: '1', conflict_policy: 'block', timeout_action: 'default', timeout_after: '30m' });
  saveRules(db, { key: '', rules, template: 'peer_review', userId: lead });
  const task = mkTask();
  const node = mkNode(task);
  const q = mkQ(task, { nodeId: node });
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, q).addressed_to), [alice.id], '先到 alice');
  const s1 = sweepTimeouts(db, { taskId: task, at: t0 + 8 * 3600_000 + 1 });
  eq(s1.rerouted.length, 1, '8h 到：转下一行');
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, q).addressed_to), [], '下一行收件人为空');
  eq(status(q), 'open', '仍 open');
  const s2 = sweepTimeouts(db, { taskId: task, at: t0 + 8 * 3600_000 + 30 * 60_000 + 2 });
  eq(s2.defaulted.length, 1, '再 30m：按默认动作');
  eq(status(q), 'defaulted', 'defaulted');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, node).status, 'pending', '节点解冻');
  assert(db.one(`SELECT 1 FROM answers WHERE question_id=? AND user_id IS NULL`, q), '系统默认答复也进 answers 表');
  assert(auditActions(q).includes('question_rerouted'), '审计 question_rerouted');
  // Ⅲ 级事项 default 兜底：没有默认动作 → 只能挂
  const q3 = mkQ(task, { level: 3 });
  const s3 = sweepTimeouts(db, { taskId: task, at: t0 + 9 * 3600_000 });
  assert(s3.rerouted.some((e) => e.questionId === q3), 'Ⅲ 级也转下一行');
  const s4 = sweepTimeouts(db, { taskId: task, at: t0 + 10 * 3600_000 });
  assert(s4.stuck.some((e) => e.questionId === q3), 'Ⅲ 级没有默认动作：挂起');
  eq(status(q3), 'open', '仍 open');
}

section('10. 先答生效，迟到的异议留痕；冲突正文的影响段是机械算的');
{
  const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r).filter((r) => r.decision_type !== 'spec_choice');
  rules.push({ decision_type: 'spec_choice', scope: '*', position: 0, recipients: ['group:reviewer'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null });
  saveRules(db, { key: '', rules, template: 'peer_review', userId: lead });
  const task = mkTask();
  const n1 = mkNode(task);
  const n2 = mkNode(task, 'pending'); insertEdge(db, n2, n1, 'depends_on', t0);   // n2 依赖 n1
  const n3 = mkNode(task, 'pending'); insertEdge(db, n3, n2, 'depends_on', t0);   // n3 依赖 n2（传递下游）
  const q = mkQ(task, { nodeId: n1 });
  eq(recordAnswer(db, { questionId: q, body: 'A', plaintextToken: alice.plaintext }).resolved, true, 'quorum 1：alice 先答即生效');
  const late = recordAnswer(db, { questionId: q, body: 'B', plaintextToken: bob.plaintext });
  eq([late.late, late.stance, late.resolved, late.finalBody], [true, 'dissent', false, 'A'], 'bob 迟到且不同：记 dissent，不抛错，结论仍是 A');
  eq(status(q), 'answered', '状态不变');
  eq(answersOf(db, q).map((a) => a.stance), ['answer', 'dissent'], 'answers 表：answer + dissent');
  const ld = db.one(`SELECT payload FROM audit_log WHERE action='late_dissent_noted' AND target_id=?`, q);
  assert(ld && JSON.parse(ld.payload).notify.includes(lead) && JSON.parse(ld.payload).notify.includes(alice.id), '审计 late_dissent_noted，通知负责人与答复人');
  eq(db.one(`SELECT count(*) n FROM edges WHERE to_id=? AND relation='answers' AND superseded_at IS NULL`, q).n, 1, '生效的 answers 边只有一条');
  const agree = recordAnswer(db, { questionId: q, body: ' a ', plaintextToken: bob.plaintext });
  eq(agree.stance, 'comment', '迟到但一致：记附议');
  throwsWith(() => recordAnswer(db, { questionId: q, body: 'C', plaintextToken: owner.plaintext }), /不接受答复.*修正流程/, '负责人要改结论走修正流程，不是迟到答复');
  throwsWith(() => recordAnswer(db, { questionId: q, body: 'C', plaintextToken: carol.plaintext }), /旁观者不能答复/, '旁观者仍不能答');

  // 冲突正文：卡住的步骤、传递下游、任务状态
  const rules2 = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  rules2.find((r) => r.decision_type === 'spec_choice').quorum = '2';
  saveRules(db, { key: '', rules: rules2, template: 'peer_review', userId: lead });
  const q2 = mkQ(task, { nodeId: n1 });
  recordAnswer(db, { questionId: q2, body: 'A', plaintextToken: alice.plaintext });
  const c = recordAnswer(db, { questionId: q2, body: 'B', plaintextToken: bob.plaintext });
  const text = db.one(`SELECT text FROM questions WHERE id=?`, c.conflictId).text;
  assert(/卡住的步骤：「n」（[a-z]+，风险 normal）/.test(text), '正文写明卡住的步骤与风险级');
  assert(/等它的下游步骤 2 个/.test(text), '下游按依赖边传递算出 2 个');
  assert(new RegExp(`任务 ${task} 挂起等结论`).test(text), '任务挂起');
  assert(!/采纳任何一边，受影响的步骤都会按那一边的答复继续/.test(text), '删掉了那句空话');
  const qt = mkQ(task);   // 不挂步骤的事项
  recordAnswer(db, { questionId: qt, body: 'A', plaintextToken: alice.plaintext });
  const c2 = recordAnswer(db, { questionId: qt, body: 'B', plaintextToken: bob.plaintext });
  assert(/不挂在某个步骤上：整个任务等结论/.test(db.one(`SELECT text FROM questions WHERE id=?`, c2.conflictId).text), '任务级事项的影响段');
}

section('11. 附议 / 弃权：系统不猜"这两段话是不是一个意思"，人显式表态');
{
  // ① 附议：同义不同字不再被判成冲突（例：「按 A 处理，判据换成…」vs「听后端同事的，按 A」）
  const task = mkTask(); const node = mkNode(task); const q = mkQ(task, { nodeId: node });
  const a1 = recordAnswer(db, { questionId: q, body: '按 A 处理，判据换成 total 照常返回', plaintextToken: alice.plaintext });
  eq(a1.resolved, false, '第一条答复：法定人数 2，未够数');
  const ag = recordAnswer(db, { questionId: q, stance: 'agree', plaintextToken: bob.plaintext });
  eq(ag.resolved, true, '第二人附议 → 够数即生效，不生成冲突事项');
  eq(ag.finalBody, '按 A 处理，判据换成 total 照常返回', '生效的是被附议的那条原文，不是附议这句话');
  eq(answersOf(db, q).map((a) => a.stance), ['answer', 'agree'], 'answers 表：一条答复 + 一条附议');
  eq(db.one(`SELECT agrees_with FROM answers WHERE id=?`, ag.answerId).agrees_with, a1.answerId, 'agrees_with 记下附议的是哪一条 —— 不必再靠文字去猜');
  eq(status(q), 'answered', '事项已决');

  // 只有一条答复时不必指名；一条都没有时不能附议
  const q2 = mkQ(mkTask());
  throwsWith(() => recordAnswer(db, { questionId: q2, stance: 'agree', plaintextToken: alice.plaintext }), /还没有别人的答复可附议/, '没有可附议的对象 → 拒（要写自己的意见）');

  // 两条答复并存时，附议必须指名
  const q3 = mkQ(mkTask());
  const x1 = recordAnswer(db, { questionId: q3, body: '甲方案', plaintextToken: alice.plaintext });
  recordAnswer(db, { questionId: q3, body: '乙方案', plaintextToken: bob.plaintext });   // 够数 → 冲突事项
  const c = db.one(`SELECT id FROM questions WHERE origin_question_id=?`, q3);
  assert(c, '两条不同立场仍然生成冲突事项 —— 附议解决的是误报，不是取消冲突');
  assert(db.one(`SELECT text FROM questions WHERE id=?`, c.id).text.includes('附议'), '冲突正文写明三条出路（附议 / 撤回 / 重申）');

  // ② 冲突事项里：一方重申、另一方附议 → 当场结案，不惊动负责人
  recordAnswer(db, { questionId: c.id, body: '仍然按甲方案，理由是接口已经这么约定了', plaintextToken: alice.plaintext, at: t0 + 10 });
  const cr = recordAnswer(db, { questionId: c.id, stance: 'agree', plaintextToken: bob.plaintext, at: t0 + 11 });
  eq(cr.resolved, true, '冲突事项：一方重申、一方附议 → 达成');
  eq(cr.how, 'parties_agreed', '按"双方达成"结案，没有转负责人');
  eq(status(q3), 'answered', '结论回写原事项');
  eq(db.one(`SELECT stance FROM answers WHERE id=?`, x1.answerId).stance, 'answer', '赢的那条仍是 answer');
  eq(answersOf(db, q3).find((a) => a.user_id === bob.id && a.body === '乙方案').stance, 'withdrawn',
    '自己让步的一方标 withdrawn 而不是 dissent —— dissent 是"被否决"，会在摘要里冤枉人');

  // ③ 弃权：这不归我 —— 从收件人里去掉自己，人数按剩余人数重算，事项当场结算
  const q4 = mkQ(mkTask(), { nodeId: null });
  const w = recordAnswer(db, { questionId: q4, body: '按 A，理由略', plaintextToken: alice.plaintext });
  eq(w.resolved, false, '一人答复，等第二人');
  const ab = recordAnswer(db, { questionId: q4, stance: 'abstain', body: '不是 client/ 的地盘', plaintextToken: bob.plaintext });
  eq(ab.resolved, true, '第二人弃权 → 人数按剩下的 1 人重算，alice 那条当场生效');
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, q4).addressed_to), [alice.id], '弃权的人从收件人里去掉了');
  assert(auditActions(q4).includes('answer_abstained'), '弃权记审计（给收件人一个"这不归我"的出口）');
  assert(answersOf(db, q4).some((a) => a.stance === 'abstain' && a.body.includes('不是 client/ 的地盘')), '说明留档');

  // ④ 全员弃权：没有下一顺位就挂给负责人，不是无人认领
  const q5 = mkQ(mkTask());
  recordAnswer(db, { questionId: q5, stance: 'abstain', plaintextToken: alice.plaintext });
  const last = recordAnswer(db, { questionId: q5, stance: 'abstain', plaintextToken: bob.plaintext });
  eq(last.reassigned, [lead], '收件人全部弃权 → 挂给负责人');
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, q5).addressed_to), [lead], '收件人换成负责人');
  eq(status(q5), 'open', '仍然开着等人 —— 不能因为没人认领就悄悄消失');

  // ⑤ 不在收件人里的人无从弃权
  throwsWith(() => recordAnswer(db, { questionId: mkQ(mkTask()), stance: 'abstain', plaintextToken: owner.plaintext }), /不在这条事项的接收人里/, '负责人不在收件人里时，弃权无意义 → 拒');

  // ⑥ 签收按**方向**归并：两人都写"接受"不是两个立场（这是对上面附议形状的有意偏离，见 positionsOf 注释）
  const sq = mkQ(mkTask('done'), { type: 'signoff', level: 3 });
  recordAnswer(db, { questionId: sq, body: '接受', plaintextToken: alice.plaintext });
  const s2 = recordAnswer(db, { questionId: sq, body: '接受，辛苦了', plaintextToken: bob.plaintext });
  eq(s2.resolved, true, '签收：两人都是"接受"方向 → 达成，不生成冲突事项');
  const sq2 = mkQ(mkTask('done'), { type: 'signoff', level: 3 });
  recordAnswer(db, { questionId: sq2, body: '打回：page 口径不对', plaintextToken: alice.plaintext });
  const s4 = recordAnswer(db, { questionId: sq2, body: '打回：文档没更新', plaintextToken: bob.plaintext });
  eq(s4.resolved, true, '两条打回也是同一方向 → 达成');
  assert(s4.finalBody.includes('page 口径不对') && s4.finalBody.includes('文档没更新'), '两个人的打回理由都带给修正流水线，不丢话');
  const sq3 = mkQ(mkTask('done'), { type: 'signoff', level: 3 });
  recordAnswer(db, { questionId: sq3, body: '接受', plaintextToken: alice.plaintext });
  const s6 = recordAnswer(db, { questionId: sq3, body: '打回：还差文档', plaintextToken: bob.plaintext });
  assert(s6.conflictId, '一人接受一人打回 → 方向不同，仍然是冲突');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
