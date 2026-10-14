// 按人记账、月度预算、预占、公平调度：
//   ① 归属：默认记在发起人头上；口径改成项目负责人 / 批准契约的人照办；落账时写进 payer_id；
//   ② 旧账（没有归属）按发起人口径算进个人花费；
//   ③ 个人月度预算：撞上 → checkLimits 报 monthly_budget.person → 事项发给管理员、一个人一个月只一条；部署月度预算同理；
//   ④ 预占：两个任务同一个项目，各自判闸门都没撞、合起来会撞 —— 第一个预占之后第二个就判出来撞了；释放后又能占；
//      过期的预占不算；
//   ⑤ 公平调度：甲三个任务、乙一个任务 → 交错成 乙甲甲甲（在跑得少的先轮）……；在跑的数目从租约来；
//   ⑥ 最坏情况的估算；
//   ⑦ 接口：成员只看自己那一行、管理员看全员；设个人预算只有管理员能。
//
// 跑：node tests/spend.test.mjs

import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { flushLedger } from '../src/core/ledger.mjs';
import { payerOf, personSpend, setPersonBudget, spendBreach, reserveCall, releaseReservation, fairOrder, estimateCallMicro, monthStart, spendByPerson } from '../src/core/spend.mjs';
import { checkLimits, raiseLimitQuestion } from '../src/core/limits.mjs';
import { setProjectParam } from '../src/core/params.mjs';
import { acquireLease } from '../src/db/lease.mjs';
import { insertQuestion } from '../src/core/questions.mjs';
import { insertAnswer } from '../src/core/answers.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);

const db = openDb(':memory:');
const lead = ensureOwner(db, '负责人');
const a = addUser(db, { name: '甲', role: 'member', byUserId: lead.userId });
const b = addUser(db, { name: '乙', role: 'member', byUserId: lead.userId });
const t0 = now();
const pj = newId('pj');
db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'p','/r','b','main','active',?)`, pj, lead.userId, t0);
const task = (owner, project = pj) => { const id = newId('t'); db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id) VALUES (?,?,'x','running',?,?)`, id, owner, t0, project); return id; };
const spend = (taskId, microUsd, at = now()) => flushLedger(db, { ledger: [{ model: 'm/x', vendor: 'v', tier: 'standard', inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0, microUsd, billing: 'computed', at }] }, { taskId, role: 'executor' });
const M = 1_000_000;

section('① 归属');
{
  const ta = task(a.userId);
  eq(payerOf(db, ta), { payerId: a.userId, scope: 'user' }, '默认：发起人');
  setSetting(db, { key: 'deploy.cost_attribution', value: 'project_owner', userId: lead.userId });
  eq(payerOf(db, ta).payerId, lead.userId, '项目负责人口径：记到项目负责人');
  setSetting(db, { key: 'deploy.cost_attribution', value: 'approver', userId: lead.userId });
  const q = insertQuestion(db, { taskId: ta, level: 3, text: '批不批？' });
  db.run(`UPDATE questions SET decision_type='contract_approval' WHERE id=?`, q);
  insertAnswer(db, { questionId: q, userId: b.userId, body: 'A', stance: 'answer' });
  eq(payerOf(db, ta).payerId, b.userId, '批准人口径：记到批准契约的人（乙）');
  setSetting(db, { key: 'deploy.cost_attribution', value: 'requester', userId: lead.userId });
  spend(ta, 3 * M);
  eq(db.one(`SELECT payer_id, payer_scope FROM usage_ledger WHERE task_id=?`, ta), { payer_id: a.userId, payer_scope: 'user' }, '落账时写进归属');
}

section('② 旧账按发起人口径算');
{
  const tb = task(b.userId);
  db.run(`INSERT INTO usage_ledger (task_id,role,model_tier,provider,model_id,input_tokens,output_tokens,micro_usd,billing,ts) VALUES (?,'executor','standard','v','m',1,1,?,'computed',?)`, tb, 2 * M, now());
  eq(personSpend(db, b.userId), 2 * M, '没有归属的旧账算到发起人（乙）头上');
}

section('③ 月度预算');
{
  setPersonBudget(db, { userId: a.userId, usd: 3, byUserId: lead.userId });
  const ta2 = task(a.userId, null);
  const br = checkLimits(db, ta2);
  eq([br?.key, br?.scope, br?.payerId], ['monthly_budget.person', 'person', a.userId], '甲本月已花 $3、预算 $3 → 撞个人月度预算');
  const q1 = raiseLimitQuestion(db, { taskId: ta2, breach: br });
  const q2 = raiseLimitQuestion(db, { taskId: task(a.userId, null), breach: checkLimits(db, ta2) });
  eq(q2.questionId, q1.questionId, '一个人一个月只一条事项');
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, q1.questionId).addressed_to), [lead.userId], '发给管理员（钱的口子只有管理员能开）');
  eq(checkLimits(db, task(b.userId, null)), null, '乙没设个人预算：不受影响');
  setPersonBudget(db, { userId: a.userId, usd: null, byUserId: lead.userId });
  setSetting(db, { key: 'deploy.budget_usd_month', value: 5, userId: lead.userId });
  eq(checkLimits(db, task(b.userId, null))?.scope, 'deployment', '部署本月已花 $5、预算 $5 → 撞部署月度预算');
  setSetting(db, { key: 'deploy.budget_usd_month', value: 0, userId: lead.userId });
}

section('④ 预占');
{
  const pj2 = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'p2','/r2','b','main','active',?)`, pj2, lead.userId, t0);
  setProjectParam(db, { projectId: pj2, key: 'project.budget_micro_usd', value: 10 * M, by: { kind: 'user', id: lead.userId }, governance: 'constitutional' });
  const x = task(a.userId, pj2), y = task(b.userId, pj2);
  eq(spendBreach(db, x, { extraMicro: 6 * M }), null, '任务 x 单看：预占 $6 不撞 $10 的项目闸');
  eq(reserveCall(db, { taskId: x, holder: 'orch-x', microUsd: 6 * M }).ok, true, 'x 预占 $6');
  const ry = reserveCall(db, { taskId: y, holder: 'orch-y', microUsd: 6 * M });
  eq([ry.ok, ry.breach?.scope], [false, 'project'], 'y 再占 $6：算上 x 的预占就撞了（原来各判各的，两个都放行、合起来花 $12）');
  releaseReservation(db, { taskId: x, holder: 'orch-x' });
  eq(reserveCall(db, { taskId: y, holder: 'orch-y', microUsd: 6 * M }).ok, true, 'x 结算释放之后 y 能占');
  db.run(`UPDATE budget_reservations SET expires_at=? WHERE task_id=?`, now() - 1, y);
  eq(reserveCall(db, { taskId: x, holder: 'orch-x', microUsd: 6 * M }).ok, true, '过期的预占（进程死了留下的）不算');
}

section('⑤ 公平调度');
{
  const ts = [task(a.userId, null), task(a.userId, null), task(a.userId, null), task(b.userId, null)];
  acquireLease(db, `task:${task(a.userId, null)}`, { meta: {} });   // 甲已经有一个在跑
  const f = fairOrder(db, ts.map((taskId) => ({ taskId })));
  eq(f.ordered.map((d) => (d.payerId === a.userId ? '甲' : '乙')), ['乙', '甲', '甲', '甲'], '交错排开、在跑得少的先轮：乙排在甲前面');
  eq(f.running.get(a.userId), 1, '在跑的数目从租约来');
}

section('⑥ 最坏情况的估算');
eq(estimateCallMicro({ input: 1, output: 4 }, { inputTokens: 100_000, maxTokens: 10_000 }), Math.round((100_000 * 1 + 10_000 * 4) / 1e6 * M), '输入按给的体量、输出打满');
eq(estimateCallMicro(null, {}), 0, '没有单价按 0（没单价的模型本来就绑不上）');

section('⑦ 汇总（看板用）');
{
  const s = spendByPerson(db);
  const ra = s.rows.find((r) => r.userId === a.userId);
  assert(ra.month >= 3 * M && ra.daily.length === 14 && s.month === new Date(monthStart()).toISOString().slice(0, 7), `甲本月 ${ra.month / M} 美元、近 14 天每天一格、月份按 UTC`);
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
