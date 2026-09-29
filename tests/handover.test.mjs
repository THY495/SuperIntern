// 成员管理与交接
//
// 跑：node tests/handover.test.mjs
//
// 断言的是边界：交接只影响未来（已答 / 已签收 / 审计 / 已结束的归属不动）；冲突事项不转立场而是升级；
// 预览与执行一字不差且预览不落库；停用 = 令牌失效 + 不再被解析成收件人；成员只能申请、负责人批准；
// 底层四个动作各自的护栏。

import { openDb, ensureOwner, newId, now, sha256, authenticate } from '../src/db/db.mjs';
import { addUser, listUsers, usersView, setUserRole, renameUser, reissueToken, setUserChannel, removeUserChannel, channelsForUsers, channelHost } from '../src/core/users.mjs';
import { responsibilitiesOf, previewHandover, executeHandover, requestHandover, listHandoverRequests, decideHandoverRequest, canDecideHandover, disableUser, enableUser } from '../src/core/handover.mjs';
import { applyTemplate, saveRules, rulesOf, routeQuestion, leadOf, leadOfKey, validateRules, setDutyCalendar, dutyCalendarOf, resolveRecipients, authorize } from '../src/core/routing.mjs';
import { recordAnswer, answersOf } from '../src/core/answers.mjs';
import { permissionsOf, renderPermissions } from '../src/core/permissions.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { buildDigest, renderDigest, renderHandover, sendHandoverNotice, scheduledDigests } from '../src/core/digest.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throwsWith = (fn, re, m) => { try { fn(); bad(m, '没有抛'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `抛了但不是预期：${e.message}`); } };

const t0 = now();
function world() {
  const db = openDb(':memory:');
  const owner = ensureOwner(db, 'lead');
  const lead = owner.userId;
  const mk = (name, role, tags = []) => { const r = addUser(db, { name, role, tags, byUserId: lead }); return { id: r.userId, plaintext: r.plaintext }; };
  const alice = mk('alice', 'member', ['reviewer']), bob = mk('bob', 'member', ['reviewer']), carol = mk('carol', 'observer');
  const mkProject = (title, ownerId = lead, status = 'active') => {
    const id = newId('p');
    db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,created_at) VALUES (?,?,?,'b','C:/r','si/x','main',NULL,?,?)`, id, ownerId, title, status, t0);
    return id;
  };
  const mkTask = ({ status = 'waiting', projectId = null, ownerId = lead, order = null } = {}) => {
    const id = newId('t');
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'t',?,?,?,?)`, id, ownerId, status, t0, projectId, order);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), id, t0, t0);
    return id;
  };
  const mkQ = (taskId, { type = 'spec_choice', level = 2, at = t0 } = {}) => {
    const id = newId('q');
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,?,'classifier','要 A 还是 B？',?,?,NULL,'open')`, id, taskId, level, level === 3 ? null : '按 A', at);
    db.tx(() => routeQuestion(db, { questionId: id, decisionType: type, typeSource: 'hard_rule', at }));
    return id;
  };
  const q = (id) => { const r = db.one(`SELECT * FROM questions WHERE id=?`, id); return { ...r, to: JSON.parse(r.addressed_to), inf: JSON.parse(r.informed), routeObj: JSON.parse(r.route || 'null') }; };
  const peer = (key, recips, quorum = '1') => {
    applyTemplate(db, { key, name: 'peer_review', userId: lead });
    const rules = rulesOf(db, key).map(({ id, project_id, template, created_at, ...r }) => r);
    const sc = rules.find((r) => r.decision_type === 'spec_choice'); sc.recipients = recips; sc.quorum = quorum;
    saveRules(db, { key, rules, template: 'peer_review', userId: lead });
  };
  return { db, owner, lead, alice, bob, carol, mkProject, mkTask, mkQ, q, peer };
}

section('1. 迁移 v11 与停用的基本效果');
{
  const { db, lead, alice, bob } = world();
  assert(db.all(`PRAGMA table_info(users)`).some((c) => c.name === 'disabled_at'), 'users 有 disabled_at 列');
  assert(!!db.one(`SELECT name FROM sqlite_master WHERE name='handover_requests'`), '有 handover_requests 表');
  assert(!!authenticate(db, alice.plaintext), '停用前令牌有效');
  const r = disableUser(db, { userId: alice.id, byUserId: lead });
  eq(r.tokensRevoked, 1, '名下没事 → 直接停用，吊销 1 枚令牌');
  eq(authenticate(db, alice.plaintext), null, '停用后令牌无效');
  eq(resolveRecipients(db, '', [`user:${alice.id}`, 'group:reviewer', 'group:*']).answerers.sort(), [lead, bob.id].sort(), '停用的人不再被 user: / group: 解析成收件人');
  throwsWith(() => reissueToken(db, { userId: alice.id, byUserId: lead }), /已停用/, '停用的人不能发令牌');
  throwsWith(() => disableUser(db, { userId: alice.id, byUserId: lead }), /已停用/, '重复停用报错');
  throwsWith(() => disableUser(db, { userId: bob.id, byUserId: bob.id }), /只有管理员/, '成员不能停用别人');
  throwsWith(() => disableUser(db, { userId: lead, byUserId: lead }), /最后一位管理员/, '最后一个管理员不能停用');
  enableUser(db, { userId: alice.id, byUserId: lead });
  eq(authenticate(db, alice.plaintext), null, '恢复后旧令牌仍然无效（停用时已吊销）');
  const again = reissueToken(db, { userId: alice.id, byUserId: lead });
  eq(authenticate(db, again.plaintext)?.user_id, alice.id, '恢复 + 重发后新令牌有效');
  eq(listUsers(db).find((u) => u.id === alice.id).disabled_at, null, 'listUsers 带停用标记（恢复后为空）');
  db.close();
}

section('2. 底层四个动作');
{
  const { db, lead, alice, bob, carol, peer } = world();
  // 改名
  throwsWith(() => renameUser(db, { userId: alice.id, name: 'bob', byUserId: lead }), /名称 bob 已被使用/, '改名撞名 → 拒');
  throwsWith(() => renameUser(db, { userId: alice.id, name: '  ', byUserId: lead }), /名称不能为空/, '空名字 → 拒');
  eq(renameUser(db, { userId: alice.id, name: 'alice2', byUserId: lead }).changed, true, '改名成功');
  eq(renameUser(db, { userId: alice.id, name: 'alice2', byUserId: lead }).changed, false, '同名 = 无变化，不写审计');
  eq(db.all(`SELECT 1 FROM audit_log WHERE action='user_renamed'`).length, 1, '审计 user_renamed 一条');
  // 令牌
  const r = reissueToken(db, { userId: alice.id, byUserId: lead });
  eq(authenticate(db, alice.plaintext), null, '重发后旧令牌失效');
  eq(authenticate(db, r.plaintext)?.user_id, alice.id, '新令牌有效');
  const a = db.one(`SELECT payload FROM audit_log WHERE action='token_reissued'`);
  assert(!a.payload.includes(r.plaintext), '审计里没有令牌明文');
  // 通道
  setUserChannel(db, { userId: alice.id, kind: 'feishu', target: 'https://open.feishu.cn/open-apis/bot/v2/hook/SECRET123', byUserId: lead });
  const view = usersView(db).find((u) => u.id === alice.id);
  eq(view.channels, [{ kind: 'feishu', host: 'open.feishu.cn' }], '成员视图里通道只有种类 + 主机名');
  assert(!JSON.stringify(usersView(db)).includes('SECRET123'), '成员视图不含通道地址');
  eq(channelHost('not a url'), null, '不是 URL 的地址 → 主机名为空');
  removeUserChannel(db, { userId: alice.id, kind: 'feishu', byUserId: lead });
  eq(channelsForUsers(db, [alice.id]).length, 0, '删通道后没有通道');
  throwsWith(() => removeUserChannel(db, { userId: alice.id, kind: 'feishu', byUserId: lead }), /未配置 feishu 通知通道/, '删不存在的通道 → 报错');
  // 角色
  eq(setUserRole(db, { userId: carol.id, role: 'member', byUserId: lead }).changed, true, '旁观者 → 成员');
  eq(setUserRole(db, { userId: bob.id, role: 'lead', byUserId: lead }).changed, true, '管理员角色可直接授予（与负责哪些项目无关）');
  eq(setUserRole(db, { userId: bob.id, role: 'member', byUserId: lead }).changed, true, '也可直接收回（还有另一位管理员）');
  throwsWith(() => addUser(db, { name: 'zed', role: 'lead', byUserId: lead }), /添加后由管理员授予/, '添加时不能直接是管理员');
  throwsWith(() => setUserRole(db, { userId: lead, role: 'member', byUserId: lead }), /最后一位管理员/, '最后一个管理员不能降');
  peer('', [`user:${bob.id}`, `user:${alice.id}`]);
  throwsWith(() => setUserRole(db, { userId: bob.id, role: 'observer', byUserId: lead }), /是 1 行决策路由的接收人[\s\S]*规格取舍/, '路由表点名的人不能降为旁观者，报出是哪一行');
  eq(setUserRole(db, { userId: carol.id, role: 'observer', byUserId: lead }).changed, true, '名下没事的成员 → 旁观者');
  db.close();
}

section('3. 按项目交接负责人：归属、角色、user:lead；历史不动');
{
  const { db, owner, lead, alice, bob, mkProject, mkTask, mkQ, q } = world();
  const p1 = mkProject('P1'), p2 = mkProject('P2'), pDone = mkProject('Pdone', lead, 'done');
  const tDone = mkTask({ status: 'done', projectId: p1, order: 1 }), tRun = mkTask({ status: 'waiting', projectId: p1, order: 2 });
  const tOther = mkTask({ projectId: p2, order: 1 }), tSolo = mkTask();
  const qOld = mkQ(tDone); recordAnswer(db, { questionId: qOld, body: '按 A', plaintextToken: owner.plaintext, at: t0 + 1 });
  const qOpen = mkQ(tRun, { type: 'structural', level: 3 });
  eq(q(qOpen).to, [lead], 'Ⅲ 级事项起初路由到原负责人');
  const before = db.one(`SELECT count(*) n FROM audit_log`).n;
  const snap = () => JSON.stringify([db.all(`SELECT id, owner_id FROM projects ORDER BY id`), db.all(`SELECT id, owner_id FROM tasks ORDER BY id`), db.all(`SELECT id, role FROM users ORDER BY id`), db.all(`SELECT id, addressed_to, route, notified_at FROM questions ORDER BY id`)]);
  const s0 = snap();
  const pv = previewHandover(db, { fromUserId: lead, toUserId: alice.id, scope: { project: p1 }, note: '周五前看一下 q', byUserId: lead });
  eq(snap(), s0, '预览不落库（归属 / 角色 / 事项都没变）');
  eq(db.one(`SELECT count(*) n FROM audit_log`).n, before, '预览不写审计');
  eq([pv.projects.map((p) => p.id), pv.transferred.map((x) => x.id), pv.needsApproval], [[p1], [qOpen], false], '预览：1 个项目、1 条事项转交、管理员无需批准');
  throwsWith(() => previewHandover(db, { fromUserId: lead, toUserId: alice.id, scope: { project: p1 }, byUserId: bob.id }), /只能预览自己/, '成员不能预览别人的交接');
  throwsWith(() => executeHandover(db, { fromUserId: lead, toUserId: alice.id, scope: { project: p1 }, byUserId: bob.id }), /只有该项目的负责人或管理员能直接执行/, '无关成员不能直接执行');
  db.run(`UPDATE questions SET notified_at=? WHERE id=?`, t0, qOpen);
  const ch = executeHandover(db, { fromUserId: lead, toUserId: alice.id, scope: { project: p1 }, note: '周五前看一下 q', byUserId: lead });
  { const { needsApproval, approver, ...pvRest } = pv; eq(ch, pvRest, '执行结果与预览逐项一致'); }
  eq(db.one(`SELECT owner_id FROM projects WHERE id=?`, p1).owner_id, alice.id, '项目归属改成接手人（守护进程按 projects.owner_id 推进）');
  eq(db.one(`SELECT owner_id FROM projects WHERE id=?`, p2).owner_id, lead, '范围外的项目不动');
  eq(db.one(`SELECT owner_id FROM projects WHERE id=?`, pDone).owner_id, lead, '已结束的项目不动');
  eq(db.one(`SELECT owner_id FROM tasks WHERE id=?`, tRun).owner_id, alice.id, '项目里还没结束的任务跟着改');
  eq(db.one(`SELECT owner_id FROM tasks WHERE id=?`, tDone).owner_id, lead, '项目里已结束的任务保留原归属');
  eq(db.one(`SELECT owner_id FROM tasks WHERE id=?`, tSolo).owner_id, lead, '不属于项目的任务不动');
  eq(db.one(`SELECT role FROM users WHERE id=?`, alice.id).role, 'member', '接手人的角色不变（负责人与管理员解耦）');
  eq(db.one(`SELECT role FROM users WHERE id=?`, lead).role, 'lead', '交出方角色不变');
  eq([leadOf(db, tRun), leadOfKey(db, p1), leadOf(db, tOther)], [alice.id, alice.id, lead], 'leadOf / leadOfKey 按项目解析到新人，别的项目还是原来的人');
  eq(q(qOpen).to, [alice.id], '还开着的 Ⅲ 级事项转给接手人');
  eq(q(qOpen).notified_at, null, '转交的事项清掉已通知标记（守护进程会通知接手人）');
  const qNew = mkQ(tRun, { type: 'structural', level: 3 });
  eq(q(qNew).to, [alice.id], '交接后新建事项的 user:lead 解析到新人');
  eq(answersOf(db, qOld).map((a) => a.user_id), [lead], '已答的答复仍挂原人');
  eq(q(qOld).to, [lead], '已关闭事项的收件人不动');
  eq(authorize(db, { taskId: tRun, decisionType: 'delivery', userId: alice.id }).why, 'lead', '新负责人对该项目的任务有负责人权限');
  const au = JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='handover_executed'`).payload);
  eq([au.from, au.to, au.projects, au.transferred, au.note], [lead, alice.id, [p1], [qOpen], '周五前看一下 q'], '审计 handover_executed 逐项列出');
  assert(/周五前看一下 q/.test(renderHandover(ch)) && /负责人变更 · 项目 1 个：P1/.test(renderHandover(ch)), '交接清单文本含项目与备注');
  throwsWith(() => executeHandover(db, { fromUserId: lead, toUserId: alice.id, scope: { project: p1 }, byUserId: lead }), /没有需要交接的内容/, '再交一次：没东西 → 拒，不写空审计');
  // 交出全部负责人身份后角色仍是 lead，可显式降级
  const ch2 = executeHandover(db, { fromUserId: lead, toUserId: alice.id, scope: { all: true }, byUserId: lead });
  eq([ch2.projects.map((p) => p.id), ch2.soloTasks.map((t) => t.id)], [[p2], [tSolo]], '范围"全部"：剩下的项目与独立任务');
  eq([db.one(`SELECT role FROM users WHERE id=?`, alice.id).role, db.one(`SELECT role FROM users WHERE id=?`, lead).role], ['member', 'lead'], '交接不动角色：接手全部后 alice 仍是成员，交出方仍是管理员');
  throwsWith(() => setUserRole(db, { userId: lead, role: 'member', byUserId: lead }), /最后一位管理员/, '交出全部后他仍是唯一的管理员，不能降');
  setUserRole(db, { userId: bob.id, role: 'lead', byUserId: lead });
  eq(setUserRole(db, { userId: lead, role: 'member', byUserId: bob.id }).changed, true, '另授一位管理员后可降');
  // 成员负责人：项目范围内有执行权，范围外没有；管理员对不是自己的项目只有强制交接，没有答复权
  eq([canDecideHandover(db, { byUserId: alice.id, scope: { project: p1 } }), canDecideHandover(db, { byUserId: alice.id, scope: { all: true } }), canDecideHandover(db, { byUserId: bob.id, scope: { project: p1 } })], [true, false, true], '执行权：项目负责人限本项目；管理员任意');
  eq([authorize(db, { taskId: tRun, decisionType: 'structural', userId: bob.id }).ok, authorize(db, { taskId: tRun, decisionType: 'structural', userId: alice.id }).ok], [false, true], '管理员不能替负责人答复；成员负责人有权');
  applyTemplate(db, { key: p1, name: 'solo', userId: alice.id });
  eq(validateRules(db, p1, rulesOf(db, p1).map(({ id, project_id, template, created_at, ...r }) => r)), [], '成员当负责人的项目，路由表校验通过');
  const chBack = executeHandover(db, { fromUserId: alice.id, toUserId: lead, scope: { project: p1 }, byUserId: alice.id });
  eq([chBack.projects.map((p) => p.id), db.one(`SELECT owner_id FROM projects WHERE id=?`, p1).owner_id], [[p1], lead], '成员负责人可直接交出自己的项目');
  db.close();
}

section('4. 路由表 / 值班表 / 模板绑定的替换与合并');
{
  const { db, lead, alice, bob, carol, mkTask, mkQ, q, peer } = world();
  peer('', [`user:${bob.id}`, `inform:user:${alice.id}`]);
  setDutyCalendar(db, { key: '', users: [bob.id, lead], startAt: t0, periodDays: 7, userId: lead });
  const t = mkTask(); const q1 = mkQ(t);
  eq([q(q1).to, q(q1).inf], [[bob.id], [alice.id]], '起初：bob 答，alice 知会');
  throwsWith(() => previewHandover(db, { fromUserId: bob.id, toUserId: carol.id, scope: { all: true }, byUserId: lead }), /旁观者，不能接手/, '旁观者不能接手');
  throwsWith(() => previewHandover(db, { fromUserId: bob.id, toUserId: bob.id, scope: { all: true }, byUserId: lead }), /不能是同一人/, '不能交给自己');
  const ch = executeHandover(db, { fromUserId: bob.id, toUserId: alice.id, scope: { soloTasks: true }, byUserId: lead });
  const row = rulesOf(db, '').find((r) => r.decision_type === 'spec_choice');
  eq(row.recipients, [`user:${alice.id}`], '路由行：user:bob → user:alice，原有的 inform:user:alice 并掉');
  assert(ch.routing[0].merged, '清单标出"合并"');
  assert(/接收人：bob、知会 alice → alice（接手人已在该行，已合并）/.test(renderHandover(ch)) && !renderHandover(ch).includes(bob.id), '清单文本里是人名不是 user id');
  eq(dutyCalendarOf(db, '').users, [alice.id, lead], '值班表换人');
  eq([q(q1).to, q(q1).inf], [[alice.id], []], '开放事项：收件人换成 alice，她不再同时出现在知会里');
  eq(db.one(`SELECT role FROM users WHERE id=?`, alice.id).role, 'member', 'alice 仍是成员');
  eq(responsibilitiesOf(db, bob.id).count, 0, '交接后 bob 名下没有未了结的责任');
  eq(setUserRole(db, { userId: bob.id, role: 'observer', byUserId: lead }).changed, true, '现在可以把 bob 降为旁观者');
  // 换人后路由校验不过 → 整体回滚
  const w = world();
  w.peer('', [`user:${w.bob.id}`, `user:${w.alice.id}`], '2');
  throwsWith(() => executeHandover(w.db, { fromUserId: w.bob.id, toUserId: w.alice.id, scope: { all: true }, byUserId: w.lead }), /决策路由无法通过校验[\s\S]*法定人数 2 大于/, '合并后人数少于表里的法定人数 → 拒，要求先改表');
  eq(rulesOf(w.db, '').find((r) => r.decision_type === 'spec_choice').recipients, [`user:${w.bob.id}`, `user:${w.alice.id}`], '被拒后路由表原样（事务回滚）');
  w.db.close(); db.close();
}

section('5. 已答的不转；法定人数会降要确认；冲突事项升级而不是转立场');
{
  const { db, owner, lead, alice, bob, mkTask, mkQ, q, peer } = world();
  const dave = addUser(db, { name: 'dave', role: 'member', byUserId: lead });
  peer('', ['group:reviewer'], '2');
  const t = mkTask();
  const qAnswered = mkQ(t); recordAnswer(db, { questionId: qAnswered, body: '按 A', plaintextToken: bob.plaintext, at: t0 + 1 });
  const qBoth = mkQ(t);                                               // bob + alice，quorum 2
  let ch = previewHandover(db, { fromUserId: bob.id, toUserId: alice.id, scope: { all: true }, byUserId: lead });
  eq([ch.kept.map((x) => x.id), ch.transferred.map((x) => x.id), ch.quorumDrops.map((x) => [x.from, x.to]), ch.needsQuorumConfirm], [[qAnswered], [qBoth], [[2, 1]], true], '预览：已答的保持、另一条转交且法定人数 2→1、要确认');
  throwsWith(() => executeHandover(db, { fromUserId: bob.id, toUserId: alice.id, scope: { all: true }, byUserId: lead }), /法定人数将因接收人合并而降低/, '没确认 → 拒');
  eq(q(qBoth).to.sort(), [alice.id, bob.id].sort(), '被拒后事项原样');
  // 交给不在收件人里的 dave：一换一，法定人数不变
  ch = executeHandover(db, { fromUserId: bob.id, toUserId: dave.userId, scope: { all: true }, byUserId: lead });
  eq(ch.quorumDrops.length, 0, '一换一：法定人数不变');
  eq(q(qBoth).to.sort(), [alice.id, dave.userId].sort(), '收件人 bob → dave');
  eq(q(qBoth).routeObj.rows[0].quorum, '2', '路由快照里的法定人数仍是 2');
  eq(q(qAnswered).to.includes(bob.id), true, 'bob 已答过的那条仍算他一票');
  recordAnswer(db, { questionId: qAnswered, body: '按 A', plaintextToken: alice.plaintext, at: t0 + 2 });
  eq(q(qAnswered).status, 'answered', 'bob 的旧答复 + alice 的答复凑够 2 人，事项了结（交接没有抹掉已投的票）');

  // 冲突：alice 与 dave 意见不一 → 冲突事项（双方阶段）；dave 交接给 bob → 不转给 bob，直接到负责人
  const daveTok = reissueToken(db, { userId: dave.userId, byUserId: lead }).plaintext;
  recordAnswer(db, { questionId: qBoth, body: '按 A', plaintextToken: alice.plaintext, at: t0 + 3 });
  const r = recordAnswer(db, { questionId: qBoth, body: '按 B', plaintextToken: daveTok, at: t0 + 4 });
  assert(!!r.conflictId, '两人答复不一致 → 生成冲突事项');
  eq(q(r.conflictId).to.sort(), [alice.id, dave.userId].sort(), '冲突事项先到当事双方');
  ch = executeHandover(db, { fromUserId: dave.userId, toUserId: bob.id, scope: { all: true }, byUserId: lead, thenDisable: true });
  eq(ch.escalated.map((x) => x.id), [r.conflictId], '清单：冲突事项列在"转负责人裁定"');
  eq(q(r.conflictId).to, [lead], '冲突事项转到负责人，而不是接手人');
  assert(!q(r.conflictId).to.includes(bob.id), '接手人没有继承冲突立场');
  eq(ch.kept.map((x) => x.id), [qBoth], 'dave 已答过的原事项保持原样');
  eq([ch.disabled, ch.tokensRevoked], [true, 1], '交接后停用：吊销令牌');
  eq(authenticate(db, daveTok), null, 'dave 的令牌失效');
  eq(answersOf(db, qBoth).filter((a) => a.user_id === dave.userId).length, 1, 'dave 的答复记录还在');
  db.close();
}

section('6. 停用前必须交接；一步做完');
{
  const { db, lead, alice, bob, mkTask, mkQ, peer } = world();
  peer('', [`user:${bob.id}`]);
  const t = mkTask(); mkQ(t);
  let err = null; try { disableUser(db, { userId: bob.id, byUserId: lead }); } catch (e) { err = e; }
  assert(err?.needsHandover && /是 1 行决策路由的接收人、有 1 条相关待决事项/.test(err.message), '名下有事 → 拒绝停用，列出清点，标 needsHandover');
  throwsWith(() => executeHandover(db, { fromUserId: bob.id, toUserId: alice.id, scope: { soloTasks: true }, byUserId: lead, thenDisable: true }), /范围必须为「全部」/, '交接后停用要求范围 = 全部');
  const ch = executeHandover(db, { fromUserId: bob.id, toUserId: alice.id, scope: { all: true }, byUserId: lead, thenDisable: true });
  assert(ch.disabled && !!db.one(`SELECT disabled_at FROM users WHERE id=?`, bob.id).disabled_at, '交接 + 停用一步做完');
  assert(usersView(db).find((u) => u.id === bob.id).disabledAt, '成员视图标出已停用');
  eq((await scheduledDigests(db, { every: '30m', env: {}, fetchFn: async () => ({ ok: true, status: 200 }) })).some((d) => d.userId === bob.id), false, '停用的人不收定时摘要');
  db.close();
}

section('7. 成员发起：申请 → 负责人批准 / 驳回 / 本人撤回');
{
  const { db, lead, alice, bob, mkTask, mkQ, q, peer } = world();
  peer('', [`user:${bob.id}`]);
  const t = mkTask(); const q1 = mkQ(t);
  throwsWith(() => requestHandover(db, { fromUserId: alice.id, toUserId: bob.id, scope: { all: true }, byUserId: bob.id }), /只能申请交接自己的职责/, '不能替别人申请');
  throwsWith(() => requestHandover(db, { fromUserId: alice.id, toUserId: bob.id, scope: { all: true }, byUserId: alice.id }), /没有需要交接的内容/, '名下没事 → 不收申请');
  const rq = requestHandover(db, { fromUserId: bob.id, toUserId: alice.id, scope: { all: true }, note: '我下周转组', byUserId: bob.id });
  assert(rq.preview.needsApproval && rq.preview.transferred.length === 1, '申请返回预览，标明要批准');
  eq(q(q1).to, [bob.id], '申请本身不改任何东西');
  throwsWith(() => requestHandover(db, { fromUserId: bob.id, toUserId: alice.id, scope: { all: true }, byUserId: bob.id }), /已有一条待批准的交接申请/, '同一人同时只有一条申请');
  const dl = buildDigest(db, { userId: lead }), dbob = buildDigest(db, { userId: bob.id }), dal = buildDigest(db, { userId: alice.id });
  eq([dl.handoverRequests.length, dl.handoverRequests[0].canDecide, dbob.handoverRequests.length, dbob.handoverRequests[0]?.canDecide, dal.handoverRequests.length], [1, true, 1, false, 0], '负责人的摘要里有这条申请（可批）；申请人看到自己的（不可批）；别人看不到');
  assert(/交接申请 1 条/.test(renderDigest(dl)) && /我下周转组/.test(renderDigest(dl)), '摘要文本含申请与备注');
  throwsWith(() => decideHandoverRequest(db, { requestId: rq.requestId, decision: 'approve', byUserId: bob.id }), /只有管理员能批准或驳回/, '申请人不能自己批（范围"全部"由管理员批）');
  throwsWith(() => decideHandoverRequest(db, { requestId: rq.requestId, decision: 'withdraw', byUserId: lead }), /只有申请人能撤回/, '别人不能替他撤回');
  const r = decideHandoverRequest(db, { requestId: rq.requestId, decision: 'approve', byUserId: lead });
  eq([r.status, q(q1).to], ['approved', [alice.id]], '批准 = 立刻执行');
  eq(JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='handover_executed'`).payload).requestId, rq.requestId, '审计里挂着申请 id');
  throwsWith(() => decideHandoverRequest(db, { requestId: rq.requestId, decision: 'reject', byUserId: lead }), /该交接申请已批准/, '已决的申请不能再决');
  eq(listHandoverRequests(db).length, 0, '没有开放的申请了');
  // 驳回 / 撤回
  const rq2 = requestHandover(db, { fromUserId: alice.id, toUserId: bob.id, scope: { all: true }, byUserId: alice.id });
  eq(decideHandoverRequest(db, { requestId: rq2.requestId, decision: 'reject', byUserId: lead, note: '先别' }).status, 'rejected', '驳回');
  eq(q(q1).to, [alice.id], '驳回不改任何东西');
  const rq3 = requestHandover(db, { fromUserId: alice.id, toUserId: bob.id, scope: { all: true }, byUserId: alice.id });
  eq(decideHandoverRequest(db, { requestId: rq3.requestId, decision: 'withdraw', byUserId: alice.id }).status, 'withdrawn', '本人撤回');
  db.close();
}

section('7b. 批准人按范围分：项目范围 = 该项目负责人（成员也行）或管理员');
{
  const { db, lead, alice, bob, mkProject, mkTask, mkQ, q, peer } = world();
  const dave = addUser(db, { name: 'dave', role: 'member', byUserId: lead }).userId;
  const p = mkProject('PX', alice.id);                         // alice 是成员，负责 PX
  peer(p, [`user:${bob.id}`]);
  const t = mkTask({ projectId: p, ownerId: alice.id, order: 1 }); const q1 = mkQ(t);
  eq(q(q1).to, [bob.id], 'bob 是 PX 的规格取舍接收人');
  const rq = requestHandover(db, { fromUserId: bob.id, toUserId: dave, scope: { project: p }, byUserId: bob.id });
  eq([rq.preview.needsApproval, rq.preview.approver], [true, '该项目的负责人或管理员'], '预览说明由谁批准');
  const d = (u) => buildDigest(db, { userId: u }).handoverRequests.map((r) => r.canDecide);
  eq([d(alice.id), d(lead), d(bob.id), d(dave)], [[true], [true], [false], []], '摘要：项目负责人与管理员可批；申请人只看；无关成员看不到');
  throwsWith(() => decideHandoverRequest(db, { requestId: rq.requestId, decision: 'approve', byUserId: dave }), /只有该项目的负责人或管理员能批准或驳回/, '无关成员不能批');
  eq(decideHandoverRequest(db, { requestId: rq.requestId, decision: 'approve', byUserId: alice.id }).status, 'approved', '成员身份的项目负责人批准 = 执行');
  eq([q(q1).to, db.one(`SELECT role FROM users WHERE id=?`, alice.id).role], [[dave], 'member'], '事项转给接手人；批准人仍是成员');
  // 范围"全部" / "不属于项目的任务"仍只有管理员能批
  peer('', [`user:${dave}`]);
  const rq2 = requestHandover(db, { fromUserId: dave, toUserId: bob.id, scope: { soloTasks: true }, byUserId: dave });
  throwsWith(() => decideHandoverRequest(db, { requestId: rq2.requestId, decision: 'approve', byUserId: alice.id }), /只有管理员能批准或驳回/, '默认表范围：项目负责人不能批');
  eq(decideHandoverRequest(db, { requestId: rq2.requestId, decision: 'approve', byUserId: lead }).status, 'approved', '管理员批');
  db.close();
}

section('7c. 权限一览：角色 + 负责 + 路由（含经由标签 / 所有成员 / 值班 / 负责人间接指到的）');
{
  const { db, lead, alice, bob, carol, mkProject, mkTask, peer } = world();
  const p = mkProject('PX', alice.id);
  peer(p, ['group:reviewer', `inform:user:${bob.id}`]);              // 规格取舍：按标签；bob 同时被点名知会
  setDutyCalendar(db, { key: p, users: [bob.id, alice.id], startAt: t0 - 1000, periodDays: 7, userId: alice.id });
  const pa = permissionsOf(db, alice.id, { at: t0 }), pb = permissionsOf(db, bob.id, { at: t0 }), pl = permissionsOf(db, lead, { at: t0 }), pc = permissionsOf(db, carol.id, { at: t0 });
  eq([pa.role, pa.owns.projects.map((x) => x.id), pa.canCreate.ok], ['member', [p], true], 'alice：成员、负责 PX、可新建');
  const rowA = pa.routing.find((r) => r.key === p);
  assert(rowA.isOwner && rowA.types.find((t) => t.type === 'structural')?.via.includes('作为负责人'), 'Ⅲ 级类型经由"作为负责人"指到 alice');
  const scB = pb.routing.find((r) => r.key === p).types.find((t) => t.type === 'spec_choice');
  eq([scB.mode, scB.via], ['answer', ['标签 reviewer']], 'bob：规格取舍经标签需答复（同时被点名知会：结论是需答复，来源只列需答复的那条）；responsibilitiesOf 看不到标签这一条');
  eq(responsibilitiesOf(db, bob.id).routing.length, 1, '对照：交接清点只认点名的那一行');
  eq([pb.duty.map((d) => [d.key, d.onDutyNow]), pa.duty.map((d) => d.onDutyNow)], [[[p, true]], [false]], '值班表：bob 当前值班，alice 在表里但不当班');
  assert(!pl.routing.some((r) => r.key === p && r.types.some((t) => t.type === 'structural')), '管理员不是 PX 的负责人：Ⅲ 级事项不到他');
  assert(pl.roleCaps.some((c) => /强制交接/.test(c)), '管理员的角色权限含强制交接');
  eq([pc.role, pc.routing.length, pc.canCreate.ok], ['observer', 0, false], '旁观者：不在任何路由里，不能新建');
  setSetting(db, { key: 'deploy.create_admin_only', value: true, userId: lead });
  eq([permissionsOf(db, alice.id).canCreate.ok, permissionsOf(db, lead).canCreate.ok], [false, true], '开关打开后：成员不可新建，管理员可');
  assert(/负责：项目「PX」/.test(renderPermissions(pa)) && /作为负责人：结构矛盾/.test(renderPermissions(pa)) && /规格取舍：需答复　经由/.test(renderPermissions(pb)), '文本版含负责与路由');
  disableUser(db, { userId: carol.id, byUserId: lead });
  assert(/已停用/.test(renderPermissions(permissionsOf(db, carol.id))), '已停用成员：只说已停用');
  db.close();
}

section('8. 通知接手人：交接清单 + 他的待办；不泄露通道地址');
{
  const { db, lead, alice, bob, mkTask, mkQ, peer } = world();
  peer('', [`user:${bob.id}`]);
  mkQ(mkTask());
  setUserChannel(db, { userId: alice.id, kind: 'ntfy', target: 'https://ntfy.example/SECRET-TOPIC', byUserId: lead });
  const ch = executeHandover(db, { fromUserId: bob.id, toUserId: alice.id, scope: { all: true }, note: '交给你了', byUserId: lead });
  const sent = [];
  const r = await sendHandoverNotice(db, { changes: ch, fetchFn: async (url, init) => { sent.push({ url, body: String(init.body) }); return { ok: true, status: 200 }; } });
  eq([r.sent, sent.length], [true, 1], '发到接手人自己的通道');
  assert(/bob → alice/.test(sent[0].body) && /交给你了/.test(sent[0].body) && /等你决定 1 件/.test(sent[0].body), '正文 = 交接清单 + 备注 + 他此刻的待办');
  assert(!db.all(`SELECT payload FROM audit_log`).some((a) => a.payload.includes('SECRET-TOPIC')), '审计里没有通道地址');
  const none = await sendHandoverNotice(db, { changes: { ...ch, to: { id: bob.id, name: 'bob' } }, fetchFn: async () => { throw new Error('x'); } });
  eq(none.sent, false, '接手人没配通道 → 不发、不抛');
  db.close();
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
