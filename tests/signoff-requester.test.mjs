// 签收与计划变更批准里"提出人"的规则
//
// 跑：node tests/signoff-requester.test.mjs
//
// ① 谁提的需求谁签收：提出人在签收人里时必须有他那一票（否则签收发给"负责人 + 提需求的人"、法定人数 1 时，负责人先签就替提需求的人签掉了）
// ③ 计划变更（宪法层）的提出人不能独自批准自己的改动（否则成员发一条改完成定义的修正，自己一个人就能批掉）
// ② 法定人数的提示只是界面文字，这里只测旋钮（ownershipQuorum）

import { openDb, ensureOwner, newId, now, sha256 } from '../src/db/db.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { applyTemplate, saveRules, rulesOf, routeQuestion, knobsOf } from '../src/core/routing.mjs';
import { setParam } from '../src/core/params.mjs';
import { signoffOf } from '../src/core/deliver.mjs';
import { randomBytes } from 'node:crypto';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const db = openDb(':memory:');
const owner = ensureOwner(db, 'lead');
const lead = owner.userId;
const t0 = now();
const addUser = (name) => {
  const id = newId('u');
  const plaintext = randomBytes(12).toString('base64url');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,'member','["reviewer"]',?)`, id, name, t0);
  db.run(`INSERT INTO tokens (id,user_id,token_hash,issued_by,issued_at) VALUES (?,?,?,?,?)`, newId('tk'), id, sha256(plaintext), lead, t0);
  return { id, plaintext };
};
const lin = addUser('阿青');
const zhou = addUser('阿明');
const mkTask = (status = 'done') => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'t',?,?)`, id, lead, status, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), id, t0, t0);
  return id;
};
const mkQ = (taskId, type, level = 3) => {
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
          VALUES (?,?,NULL,?,'hard_rule','【签收】',NULL,?,NULL,'open')`, id, taskId, level, t0);
  db.tx(() => routeQuestion(db, { questionId: id, decisionType: type, typeSource: 'hard_rule', at: t0 }));
  return id;
};
const status = (qid) => db.one(`SELECT status FROM questions WHERE id=?`, qid).status;
const to = (qid) => JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, qid).addressed_to);
const requested = (taskId, userId) => setParam(db, { taskId, key: 'task.requested_by', value: userId, by: { kind: 'user', id: userId }, governance: 'constitutional' });

// 配法：签收、方案批准都发"负责人 + 阿青 + 阿明"，法定人数 1（任一人答即算）。
applyTemplate(db, { key: '', name: 'peer_review', userId: lead });
{
  const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  for (const r of rules) if (['signoff', 'contract_approval'].includes(r.decision_type)) { r.recipients = ['user:lead', `user:${lin.id}`, `user:${zhou.id}`]; r.quorum = '1'; }
  saveRules(db, { key: '', rules, template: 'peer_review', userId: lead });
}

section('① 谁提的需求谁签收：提出人在签收人里时，负责人替不了');
{
  const t = mkTask(); requested(t, lin.id);
  const q = mkQ(t, 'signoff');
  assert(to(q).includes(lin.id) && to(q).includes(lead), '签收发给了负责人和阿青');
  const r1 = recordAnswer(db, { questionId: q, body: '接受', plaintextToken: owner.plaintext });
  eq([r1.resolved, status(q)], [false, 'open'], '负责人先签 → 不结（否则这一下就把阿青的需求签掉了）');
  assert(r1.pending?.some((p) => p.scope === '需求提出人' && p.requester === lin.id), '还差的那一票写明是需求提出人');
  const r2 = recordAnswer(db, { questionId: q, body: '接受', plaintextToken: lin.plaintext });
  eq([r2.resolved, signoffOf(db, t)], [true, 'accepted'], '阿青签了 → 结，签收记为 accepted');
}
{
  const t = mkTask(); requested(t, lin.id);
  const q = mkQ(t, 'signoff');
  const r = recordAnswer(db, { questionId: q, body: '接受', plaintextToken: lin.plaintext });
  eq(r.resolved, true, '提出人自己先签 → 法定人数 1 已够，当场结');
}
{
  const t = mkTask();
  const q = mkQ(t, 'signoff');
  eq(recordAnswer(db, { questionId: q, body: '接受', plaintextToken: owner.plaintext }).resolved, true, '没有需求提出人的任务（规划出来的）→ 负责人一人签即结，照旧');
}
{
  const t = mkTask(); requested(t, lin.id);
  const q = mkQ(t, 'signoff');
  recordAnswer(db, { questionId: q, stance: 'abstain', body: '让负责人定', plaintextToken: lin.plaintext });
  assert(!to(q).includes(lin.id), '阿青点了"不归我" → 不在收件人里了');
  eq(recordAnswer(db, { questionId: q, body: '接受', plaintextToken: owner.plaintext }).resolved, true, '提出人弃权之后，负责人一人签即结（不卡死）');
}
{
  const t = mkTask(); requested(t, lead);
  const q = mkQ(t, 'signoff');
  eq(recordAnswer(db, { questionId: q, body: '接受', plaintextToken: owner.plaintext }).resolved, true, '负责人自己提的需求 → 自己签即结');
}
{
  const t = mkTask(); requested(t, lin.id);
  const q = mkQ(t, 'signoff');
  recordAnswer(db, { questionId: q, body: '接受', plaintextToken: owner.plaintext });
  const r = recordAnswer(db, { questionId: q, body: '打回：标签点了没反应', plaintextToken: lin.plaintext });
  assert(r.conflictId || (r.resolved && signoffOf(db, t) === 'rejected'), '负责人接受、提出人打回 → 不按负责人那票结成接受');
  assert(signoffOf(db, t) !== 'accepted', '签收没有被记成 accepted');
}

section('③ 计划变更的提出人不能独自批准自己的宪法层改动');
const mkRevisionQ = (taskId, proposer) => {
  const mid = newId('m');
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at) VALUES (?,?,?,?,'correction','explicit','normal','explicit','user-authenticated',?,?)`,
    mid, taskId, proposer, 'CORS 要把 methods / headers 也配上', db.one(`SELECT id FROM tokens WHERE user_id=?`, proposer).id, t0);
  const q = mkQ(taskId, 'contract_approval', 2);
  db.run(`INSERT INTO revisions (id,task_id,message_id,status,impact,salvage,changed_nodes,new_nodes,constitution_patch,rationale,done_micro_usd,discarded_micro_usd,proposed_at,question_id)
          VALUES (?,?,?,'proposed','[]','[]','[]','[]','{"definition_of_done":"d2"}','改完成定义',0,0,?,?)`, newId('rv'), taskId, mid, t0, q);
  return q;
};
{
  const q = mkRevisionQ(mkTask('running'), zhou.id);
  const r1 = recordAnswer(db, { questionId: q, body: 'A', plaintextToken: zhou.plaintext });
  eq([r1.resolved, status(q)], [false, 'open'], '阿明批自己提的修正 → 不算数');
  const r2 = recordAnswer(db, { questionId: q, body: 'A', plaintextToken: lin.plaintext });
  eq(r2.resolved, true, '别人批了 → 结');
}
{
  const q = mkRevisionQ(mkTask('running'), lead);
  eq(recordAnswer(db, { questionId: q, body: 'A', plaintextToken: owner.plaintext }).resolved, false, '负责人提的修正也一样，自己批不算');
  eq(recordAnswer(db, { questionId: q, body: 'A', plaintextToken: zhou.plaintext }).resolved, true, '另一人批 → 结');
}
{
  const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  for (const r of rules) if (r.decision_type === 'contract_approval') r.quorum = 'all';
  saveRules(db, { key: '', rules, template: 'peer_review', userId: lead });
  const q = mkRevisionQ(mkTask('running'), zhou.id);
  recordAnswer(db, { questionId: q, body: 'A', plaintextToken: zhou.plaintext });
  eq(recordAnswer(db, { questionId: q, body: 'A', plaintextToken: lin.plaintext }).resolved, false, '都要签（all）：阿明自批 + 阿青批 → 还差负责人');
  eq(recordAnswer(db, { questionId: q, body: 'A', plaintextToken: owner.plaintext }).resolved, true, '其余两人都批了 → 结（提出人的席位不算，不会永远差他那一个）');
}
{
  const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  for (const r of rules) if (r.decision_type === 'contract_approval') { r.recipients = ['user:lead']; r.quorum = '1'; }
  saveRules(db, { key: '', rules, template: 'peer_review', userId: lead });
  const q = mkRevisionQ(mkTask('running'), lead);
  eq(recordAnswer(db, { questionId: q, body: 'A', plaintextToken: owner.plaintext }).resolved, true, '名单里只有提出人自己 → 他那票照算（否则永远结不了）');
}

section('② 旋钮：法定人数读得出来，界面据此提示"任一人答即算"');
eq(knobsOf(db, '').ownershipQuorum.signoff, '1', 'ownershipQuorum 按决策类型给出默认那一行的法定人数');

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
