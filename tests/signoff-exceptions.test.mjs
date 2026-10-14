// 签收以例外为中心、监测走过场。
//   ① 例外：六类各自捞得到；分三档（要你拍板 / 要你核对 / 仅告知）；同一步的打回经过挂到要处理的那条下面
//   ② 正文：签收事项里那一节的形状（有 / 没有例外），看板与收件箱按同一形状去掉它
//   ③ 签收事项：raiseSignoffQuestion 的正文带这一节，排在产物之前
//   ④ 打开记录：只记写给这个人、还开着的事项，只记第一次
//   ⑤ 批准习惯：批准率、时长、"很快批、从不打回"才挂提醒；批量签收不算打开时间；摘要只给管理员
//
// 跑：node tests/signoff-exceptions.test.mjs

import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { insertNode } from '../src/db/nodes.mjs';
import { insertQuestion } from '../src/core/questions.mjs';
import { signoffExceptions, renderExceptions, stripExceptions, tierOf, describeException } from '../src/core/signoff-exceptions.mjs';
import { recordViews, approvalHabits, decisionsOf, HABIT } from '../src/core/approval-habits.mjs';
import { buildDigest } from '../src/core/digest.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const fresh = () => {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const id = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'signoff',?,?)`, id, userId, 'done', t);
  return { db, taskId: id, userId };
};
const node = (db, taskId, title) => insertNode(db, { taskId, title, spec: title, acceptance: 'ok' });
const reject = (db, nodeId, by, defects) => audit(db, { actorKind: by === 'verifier' ? 'agent' : 'system', actorId: by === 'verifier' ? 'verifier' : null, action: 'handoff_rejected', targetType: 'node', targetId: nodeId, payload: { by, defects } });
const done = (db, nodeId) => audit(db, { actorKind: 'system', action: 'node_done', targetType: 'node', targetId: nodeId, payload: {} });

// ── ① ─────────────────────────────────────────────────────────────────────
section('① 例外：捞得到、分档、打回经过挂到要处理的那条下面');
{
  const { db, taskId } = fresh();
  eq(signoffExceptions(db, taskId), [], '一帆风顺的任务：没有例外');

  const a = node(db, taskId, '表头'), b = node(db, taskId, '转义'), c = node(db, taskId, '筛选'), d = node(db, taskId, 'README');
  // 表头：验收员打回一次（说期望值照抄），机械校验打回一次（越界），最后过；改了原有测试、没人放行
  reject(db, a, 'verifier', [{ category: 'spec', summary: '期望值照着实现抄的' }]);
  reject(db, a, 'mech', [{ category: 'scope', summary: '越界', locations: ['scripts/gen.mjs'] }]);
  done(db, a);
  audit(db, { actorKind: 'system', action: 'handoff_test_changes', targetType: 'node', targetId: a, payload: { changes: [{ path: 'test/csv.test.mjs', baseline: true, findings: [{ kind: 'expect_changed' }] }, { path: 'test/new.test.mjs', baseline: false, findings: [] }] } });
  // 转义：打回两次后过 → 仅告知
  reject(db, b, 'verifier', [{ category: 'spec', summary: '逗号没加引号' }]); reject(db, b, 'verifier', [{ category: 'spec', summary: '逗号没加引号' }]); done(db, b);
  // 筛选：验收放行，但应用没起来、两条界面条目没验成
  audit(db, { actorKind: 'agent', actorId: 'verifier', action: 'handoff_verified', targetType: 'node', targetId: c,
    payload: { verdict: 'accept', ui: { checks: [{ n: 1, item: '选已完成', result: 'not_checked' }, { n: 2, item: '选全部', result: 'not_checked' }], live: { state: 'failed', why: '5173 打不开' } } } });
  audit(db, { actorKind: 'system', action: 'live_app_session', targetType: 'node', targetId: c, payload: { used: true, up: false, log: 'Cannot find module vite' } });
  // README：AI 替人定的事
  const t = now();
  db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,valid_from,recorded_at,verified_against,must_disclose) VALUES (?,?,?,?,?,?,?,?,?,1)`,
    newId('as'), taskId, d, 'tz', '时间一律 UTC', 'active', t, t, 'settled_by_me');
  // 没人答、按默认走了；另一条是 AI 自选项过目（带 choices 标记，不重复算）
  insertQuestion(db, { taskId, level: 1, text: '金额要不要带符号？', defaultAction: '不带', status: 'defaulted' });

  const ex = signoffExceptions(db, taskId);
  const by = (k) => ex.filter((e) => e.kind === k);
  eq(by('defaulted').map((e) => e.text), ['金额要不要带符号？'], 'defaulted：没人答的那条');
  eq(by('self_decided').map((e) => [e.title, e.how]), [['README', 'settled']], 'self_decided：AI 替人定的，带所在步骤');
  eq(by('tests').map((e) => [e.paths, e.kinds, e.allowed]), [[['test/csv.test.mjs'], ['expect_changed'], false]], 'tests：只算任务开始前就有的测试');
  eq(by('scope').map((e) => [e.paths, e.passed]), [[['scripts/gen.mjs'], true]], 'scope：越界被拒、最后过了');
  eq(by('ui_unverified').map((e) => [e.items.length, e.total, e.appDown, e.log]), [[2, 2, true, 'Cannot find module vite']], 'ui_unverified：没验成的条目、应用没起来、起服务的输出');
  eq(ex.map((e) => e.tier), ['decide', 'decide', 'check', 'check', 'info', 'info'], '按档排：拍板 → 核对（应用没起来在最前）→ 仅告知');
  eq(ex.find((e) => e.kind === 'ui_unverified') === ex[2], true, '核对档里应用没起来排第一');
  // 表头的打回经过挂到它的测试改动上，不再单列；转义没别的事，留在仅告知
  const host = by('tests')[0];
  eq([host.history?.n, host.history?.said], [2, ['期望值照着实现抄的', '越界']], '同一步要核对时，打回经过挂在那条下面（机械检查的理由也收：只被机械检查打回过的，原来"当时的问题："后面是空的）');
  eq(by('rejections').map((e) => [e.title, e.passedAt, e.tier]), [['转义', 3, 'info']], '别的步骤的打回留在仅告知（第 3 次交才过）');
  const noSaid = describeException({ ...host, history: { n: 2, said: [] } }, 'zh');
  assert(/打回过 2 次/.test(noSaid) && !/当时的问题/.test(noSaid), '没有可摘的理由时不拼"当时的问题："（冒号后面是空的）', noSaid);

  // 放行过的测试改动、撤回了的越界 → 仅告知；没撤回 → 核对；没过的打回 → 核对
  eq([tierOf({ kind: 'tests', allowed: true }), tierOf({ kind: 'scope', passed: false }), tierOf({ kind: 'rejections', passedAt: null })], ['info', 'check', 'check'], 'tierOf 的边界');
}

// ── ② ─────────────────────────────────────────────────────────────────────
section('② 正文那一节：形状、去掉它');
{
  const none = renderExceptions([], 'zh');
  assert(none.startsWith('## 签收前先看这些\n没有例外'), '没有例外时也说一句', none);
  const list = [{ kind: 'self_decided', tier: 'decide', title: 'R', statement: 'UTC', how: 'settled' }, { kind: 'rejections', tier: 'info', title: 'Z', mech: 0, verifier: 2, passedAt: 3, said: ['x'] }];
  const text = renderExceptions(list, 'zh');
  assert(text.startsWith('## 签收前先看这些（1 项要你处理）'), '标题数的是要人处理的条数（仅告知不算）', text.split('\n')[0]);
  assert(!text.includes('\n\n'), '整节中间没有空行（去掉它靠的是"到第一个空行为止"）');
  assert(/\*\*要你拍板：/.test(text) && /\*\*仅告知：/.test(text) && !/要你核对/.test(text), '只出现有内容的档');
  const body = `【签收】任务完成。\n\n${text}\n\n## 产物\nfoo\n\n请选一条：\n(A) 接受`;
  eq(stripExceptions(body), '【签收】任务完成。\n\n## 产物\nfoo\n\n请选一条：\n(A) 接受', '去掉那一节，其余原样');
  eq(stripExceptions(`x\n\n${none}\n\n请选一条：\n(A) 接受`), 'x\n\n请选一条：\n(A) 接受', '后面没有 ## 段时也只去掉那一节（不吃掉选项）');
  const en = renderExceptions(list, 'en');
  assert(en.startsWith('## Look at these before signing off (1 need you)'), '英文标题', en.split('\n')[0]);
  eq(stripExceptions(`x\n\n${en}\n\n## Output`), 'x\n\n## Output', '英文那一节同样去得掉');
}

// ── ④ ─────────────────────────────────────────────────────────────────────
section('④ 打开记录');
const addUser = (db, name, role = 'member') => { const id = newId('u'); db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,?,'[]',?)`, id, name, role, now()); return id; };
{
  const { db, taskId, userId } = fresh();
  const other = addUser(db, '阿青');
  const q1 = insertQuestion(db, { taskId, level: 3, text: 'q1' });
  db.run(`UPDATE questions SET decision_type='signoff', addressed_to=? WHERE id=?`, JSON.stringify([userId]), q1);
  const q2 = insertQuestion(db, { taskId, level: 3, text: 'q2' });
  db.run(`UPDATE questions SET addressed_to=? WHERE id=?`, JSON.stringify([other]), q2);
  eq(recordViews(db, { userId, questionIds: [q1, q2], at: 1000 }), 1, '只记写给自己的那条');
  eq(recordViews(db, { userId, questionIds: [q1], at: 2000 }), 0, '第二次不再记');
  eq(db.one(`SELECT first_at FROM question_views WHERE question_id=? AND user_id=?`, q1, userId).first_at, 1000, '留的是第一次');
  db.run(`UPDATE questions SET status='answered' WHERE id=?`, q2);
  eq(recordViews(db, { userId: other, questionIds: [q2] }), 0, '已经定案的不记');
}

// ── ⑤ ─────────────────────────────────────────────────────────────────────
section('⑤ 批准习惯');
{
  const { db, taskId, userId } = fresh();
  const fast = addUser(db, '快手'), careful = addUser(db, '细看');
  const T0 = Date.now() - 86_400_000;
  // 每人 5 次签收：快手每次打开 20 秒就接受（其中 2 次摆着例外）；细看打开 10 分钟，有一次打回
  const sign = (uid, i, { accepted = true, openMs = 20_000, viewed = true, exceptions = 0, batch = false } = {}) => {
    const at = T0 + i * 3_600_000;
    const q = insertQuestion(db, { taskId, level: 3, text: exceptions ? `## 签收前先看这些（${exceptions} 项要你处理）\n- x` : '## 签收前先看这些\n没有例外', askedAt: at - 600_000 });
    db.run(`UPDATE questions SET decision_type='signoff', addressed_to=? WHERE id=?`, JSON.stringify([uid]), q);
    if (viewed) db.run(`INSERT INTO question_views (question_id,user_id,first_at) VALUES (?,?,?)`, q, uid, at - openMs);
    db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,?,?,?,?,?,?)`,
      at, 'user', uid, 'task_signed_off', 'task', taskId, JSON.stringify({ accepted, questionId: batch ? undefined : q, batch }));
  };
  for (let i = 0; i < 5; i++) sign(fast, i, { exceptions: i < 2 ? 3 : 0 });
  for (let i = 0; i < 5; i++) sign(careful, i, { accepted: i !== 2, openMs: 600_000 });
  const h = Object.fromEntries(approvalHabits(db).map((r) => [r.name, r]));
  eq([h['快手'].decisions, h['快手'].approvals, h['快手'].measured, h['快手'].medianOpenMs, h['快手'].medianResponseMs], [5, 5, 5, 20_000, 600_000], '快手：5 次全批，打开到答复 20 秒，提出到答复 10 分钟');
  eq([h['快手'].flagged, h['快手'].fastWithExceptions], [true, 2], '快手挂提醒，且 2 次摆着例外就接受了');
  eq([h['细看'].flagged, h['细看'].approvals], [false, 4], '细看：打回过、看得久 → 不挂');
  eq(h['快手'].recent.map((d) => [d.taskId, d.title, d.openMs, d.exceptions]).at(-1), [taskId, 'signoff', 20_000, 3], '最近几次逐条（新的在前），带任务、打开时长、当时的例外数');
  assert(!(userId in h) && !Object.values(h).some((r) => r.userId === userId), '没做过批准式决定的人不出现');

  // 打开时间不够（命令行里答的）：不判"很快"
  const cli = addUser(db, '命令行');
  for (let i = 0; i < 5; i++) sign(cli, i, { viewed: false });
  const c = approvalHabits(db, { userId: cli })[0];
  eq([c.measured, c.flagged], [0, false], '没有打开记录的不挂提醒');
  // 批量签收：算批准、不算打开时间
  const batcher = addUser(db, '批量');
  for (let i = 0; i < 5; i++) sign(batcher, i, { batch: true });
  const bt = approvalHabits(db, { userId: batcher })[0];
  eq([bt.batch, bt.measured, bt.flagged], [5, 0, false], '批量签收记成"一次签掉多个"，不进打开时长');
  // 只看窗口内
  eq(decisionsOf(db, fast, { since: Date.now() }).length, 0, '窗口外的不算');
  assert(HABIT.streak === 5 && HABIT.fastMs === 60_000, '阈值是登记过的初值（实际运行后按数据定）');

  // 摘要：管理员的总摘要里有，成员没有
  const d = buildDigest(db, { userId });
  eq((d.rubberStamps ?? []).map((x) => x.name), ['快手'], '管理员的摘要里列出可能在走过场的人');
  eq((buildDigest(db, { userId: careful }).rubberStamps ?? []).length, 0, '成员的摘要里没有这一项');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
