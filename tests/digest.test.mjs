// 待决事项打包摘要
//
// 跑：node tests/digest.test.mjs
//
// 断言的是：摘要按人分桶（等我答 / 等冲突结论 / 等别人 / 知会我 / 负责人独有的没人接、任务状态、未读汇报、异议）；
// 正文每条带命令；定时摘要按间隔且只在有东西时发；换班交接第一次只记不发、值班者变了才给接班人推；发送记进 digests 表与审计。

import { openDb, ensureOwner, newId, now, insertEdge, sha256, audit } from '../src/db/db.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { applyTemplate, saveRules, rulesOf, routeQuestion, setDutyCalendar } from '../src/core/routing.mjs';
import { buildDigest, renderDigest, sendDigest, scheduledDigests, handoverDigests } from '../src/core/digest.mjs';
import { setUserChannel } from '../src/core/users.mjs';
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
const mkTask = (title, status = 'waiting') => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,?,?,?)`, id, lead, title, status, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), id, t0, t0);
  return id;
};
const mkQ = (taskId, { type = 'spec_choice', text = '要 A 还是 B？', level = 2, at = t0, def = '按 A' } = {}) => {
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
          VALUES (?,?,NULL,?,'classifier',?,?,?,?,'open')`, id, taskId, level, text, level === 3 ? null : def, at, level === 3 ? null : at + 8 * 3600_000);
  db.tx(() => routeQuestion(db, { questionId: id, decisionType: type, typeSource: 'hard_rule', at }));
  return id;
};
// 通知：抓 fetch 调用，不真发
const sentFetch = [];
const fetchFn = async (url, init) => { sentFetch.push({ url, body: init?.body, title: decodeURIComponent(init?.headers?.title ?? '') }); return { ok: true, status: 200, text: async () => '' }; };

// 表：规格取舍 → reviewer 组 quorum 2；签收 → alice；预算 → 负责人并知会 bob
applyTemplate(db, { key: '', name: 'peer_review', userId: lead });
{
  const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  rules.find((r) => r.decision_type === 'spec_choice').recipients = ['group:reviewer'];
  rules.find((r) => r.decision_type === 'spec_choice').quorum = '2';
  rules.find((r) => r.decision_type === 'signoff' && r.position === 0).recipients = [`user:${alice.id}`];
  rules.find((r) => r.decision_type === 'signoff' && r.position === 0).quorum = '1';
  rules.find((r) => r.decision_type === 'budget').recipients = ['user:lead', `inform:user:${bob.id}`];
  saveRules(db, { key: '', rules, template: 'peer_review', userId: lead });
}

section('1. 分桶：等我答 / 等别人 / 知会 / 冲突 / 没人接 / 任务状态 / 未读汇报 / 异议');
const tA = mkTask('任务甲'), tB = mkTask('任务乙', 'done');
const q1 = mkQ(tA, { text: '分号还是逗号？' });                                  // alice+bob 都要答
const q2 = mkQ(tB, { type: 'signoff', text: '【签收】任务乙做完了', level: 3 });   // alice 签收
const q3 = mkQ(tA, { type: 'budget', text: '【硬上限触顶】预算', level: 3 });      // lead 答，bob 知会
const q4 = mkQ(tA, { text: '缩进两格还是四格？' });                              // 将进冲突
recordAnswer(db, { questionId: q4, body: '两格', plaintextToken: alice.plaintext });
recordAnswer(db, { questionId: q4, body: '四格', plaintextToken: bob.plaintext });   // → 冲突事项，q4 escalated
recordAnswer(db, { questionId: q1, body: '分号', plaintextToken: alice.plaintext });  // alice 答了 q1，等 bob
const q5 = newId('q');   // 没人接：收件人为空
db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status,addressed_to,route)
        VALUES (?,?,NULL,2,'classifier','没人接的问题','d',?,NULL,'open','[]','{"stage":0,"chains":[],"rows":[]}')`, q5, tA, t0);
db.run(`INSERT INTO reports (id,task_id,trigger,since_ts,summary,body,facts,generated_by,created_at) VALUES (?,?,'node_done',?,'s','b','{}','template',?)`, newId('r'), tA, t0, t0);
// 异议留痕：q1 已决之后……这里直接用一条 late_dissent_noted 审计
audit(db, { actorKind: 'user', actorId: bob.id, action: 'late_dissent_noted', targetType: 'question', targetId: q1, payload: { body: '我还是觉得逗号' } });
{
  const at = t0 + 3600_000;
  const a = buildDigest(db, { userId: alice.id, at });
  const conflictId = db.one(`SELECT id FROM questions WHERE origin_question_id=?`, q4).id;
  eq(a.waitingOnMe.map((x) => x.questionId).sort(), [q2, conflictId].sort(), 'alice：等我答 = 签收 + 冲突事项（q1 她答过了；冲突事项要她重述立场）');
  eq(a.waitingOnOthers.map((x) => [x.questionId, x.missing]), [[q1, ['bob']]], 'alice：q1 在等 bob');
  eq(a.inConflict.map((x) => x.questionId), [q4], 'alice：q4 在等冲突结论');
  eq(a.unaddressed.length + a.tasksWaiting.length + a.dissents.length + a.unreadReports, 0, 'alice 不是负责人：没有负责人那几栏');
  const b = buildDigest(db, { userId: bob.id, at });
  eq(b.waitingOnMe.map((x) => x.questionId).sort(), [q1, conflictId].sort(), 'bob：等我答 = q1 + 冲突事项');
  eq(b.informed.map((x) => x.questionId), [q3], 'bob：预算事项只是知会');
  const l = buildDigest(db, { userId: lead, at });
  eq(l.waitingOnMe.map((x) => x.questionId), [q3], '负责人：等我答 = 预算');
  eq(l.unaddressed.map((x) => x.questionId), [q5], '负责人：没人接的');
  eq(l.inConflict.map((x) => x.questionId), [q4], '负责人也看到在冲突中的原事项');
  eq(l.tasksWaiting.map((t) => [t.title, t.status]), [['任务甲', 'waiting'], ['任务乙', 'awaiting_signoff']], '负责人：任务状态（做完等签收单列）');
  eq(l.unreadReports, 1, '负责人：未读汇报');
  eq(l.dissents.map((d) => [d.by, d.questionId]), [['bob', q1]], '负责人：异议留痕');
  eq([l.total, l.actionable], [7, 3], 'total = 7 项；等负责人动手的 3 件（预算 + 冲突中的 + 没人接的）');
  const text = renderDigest(l, { at });
  assert(text.includes(`node src/cli.mjs answer ${q3} "..."`) && text.includes('没人接的 1 件') && text.includes('未读汇报 1 份') && text.includes('不同意见 1 条'), '正文各段齐全、带命令');
  assert(/1\.0 小时前提出，7\.0 小时后到期/.test(renderDigest(b, { at })),'等了多久、多久到期（bob 的 q1：Ⅱ 级 8h 超时）');
  const c = buildDigest(db, { userId: carol.id, at });
  eq(c.total, 0, '旁观者：空');
  eq(renderDigest(c), `carol 的待办（${new Date(c.at).toISOString().slice(0, 16).replace('T', ' ')} UTC）\n没有等你的事。`, '空摘要一句话');
}

section('2. 发送：按人的通道；负责人没通道退到部署级；记 digests 与审计');
{
  const at = t0 + 3600_000;
  setUserChannel(db, { userId: alice.id, kind: 'ntfy', target: 'https://ntfy.example/alice', byUserId: lead });
  const r = await sendDigest(db, { userId: alice.id, kind: 'manual', at, env: {}, fetchFn });
  eq([r.sent, r.receipts.length, r.receipts[0]?.ok], [true, 1, true], 'alice 有通道：发了一条');
  assert(sentFetch.at(-1).url.includes('ntfy.example/alice'), '发到她自己的通道');
  const row = db.one(`SELECT * FROM digests WHERE user_id=? ORDER BY rowid DESC LIMIT 1`, alice.id);
  eq([row.kind, row.sent, row.items > 0], ['manual', 1, true], 'digests 记了一行');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='digest_sent' AND target_id=?`, alice.id).n, 1, '审计 digest_sent');
  const r2 = await sendDigest(db, { userId: bob.id, kind: 'manual', at, env: {}, fetchFn });
  eq(r2.sent, false, 'bob 没通道：不发，正文照样返回');
  assert(r2.text.includes('bob 的待办'), '正文在');
  const r3 = await sendDigest(db, { userId: lead, kind: 'manual', at, env: { NTFY_URL: 'https://ntfy.example/deploy' }, fetchFn });
  eq(r3.sent, true, '负责人没个人通道：退到 .env 的部署级通道');
  const r4 = await sendDigest(db, { userId: carol.id, kind: 'manual', at, env: { NTFY_URL: 'https://ntfy.example/deploy' }, fetchFn, record: false });
  eq(r4.sent, false, '空摘要默认不发（onlyIfAny）');
}

section('3. 定时摘要：按间隔；没东西不发也不记；有东西才记');
{
  const before = sentFetch.length;
  const at1 = t0 + 2 * 3600_000;
  const s1 = await scheduledDigests(db, { every: '8h', at: at1, env: {}, fetchFn });
  eq(s1.map((x) => x.userId), [alice.id], '只有 alice 有通道且有待办：发她');
  const s2 = await scheduledDigests(db, { every: '8h', at: at1 + 3600_000, env: {}, fetchFn });
  eq(s2.length, 0, '一小时后：没到间隔，不发');
  const s3 = await scheduledDigests(db, { every: '8h', at: at1 + 9 * 3600_000, env: {}, fetchFn });
  eq(s3.map((x) => x.userId), [alice.id], '九小时后：再发');
  eq(db.one(`SELECT count(*) n FROM digests WHERE user_id=? AND kind='scheduled'`, alice.id).n, 2, 'scheduled 记了两行');
  eq(sentFetch.length - before, 2, '真发了两次');
  let threw = null; try { await scheduledDigests(db, { every: 'soon', at: at1 }); } catch (e) { threw = e.message; }
  assert(/间隔写法不对/.test(threw ?? ''), '间隔写法校验');
}

section('4. 换班交接：第一次只记不发；值班者变了才给接班人推他范围内的开放事项');
{
  setUserChannel(db, { userId: bob.id, kind: 'ntfy', target: 'https://ntfy.example/bob', byUserId: lead });
  setDutyCalendar(db, { key: '', users: [alice.id, bob.id], startAt: t0, periodDays: 7, userId: lead });
  const before = sentFetch.length;
  const h1 = await handoverDigests(db, { at: t0 + 86400_000, env: {}, fetchFn });
  eq(h1.length, 0, '第一次看到日历：只记，不发');
  eq(db.one(`SELECT user_id FROM digests WHERE kind='handover' ORDER BY rowid DESC LIMIT 1`).user_id, alice.id, '记下了当班的是 alice');
  const h1b = await handoverDigests(db, { at: t0 + 2 * 86400_000, env: {}, fetchFn });
  eq(h1b.length, 0, '还是 alice 当班：不动');
  const h2 = await handoverDigests(db, { at: t0 + 8 * 86400_000, env: {}, fetchFn });
  eq(h2.map((h) => [h.from, h.to, h.sent]), [[alice.id, bob.id, true]], '第二周换 bob：给 bob 推');
  assert(sentFetch.at(-1).url.includes('ntfy.example/bob') && sentFetch.at(-1).title.includes('接班'), '发到 bob 的通道，标题带"接班"');
  eq(sentFetch.length - before, 1, '只发了一次');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='duty_handover'`).n, 1, '审计 duty_handover');
  const h3 = await handoverDigests(db, { at: t0 + 9 * 86400_000, env: {}, fetchFn });
  eq(h3.length, 0, '同一班内不重复');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
