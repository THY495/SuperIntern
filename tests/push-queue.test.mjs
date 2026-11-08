// 推送节奏：紧急程度、工作时间、汇总推送、推送限额。
//
// ① 紧急程度一处判定：信号按登记表 / 类，事项按级别、类型、升级、离时限；抄送的不紧急
// ② 工作时间：按本人时区、工作日按部署节假日表、跨午夜的班次、下一个工作时段
// ③ 汇总推送：第一件照原样推；间隔内攒着；到了间隔合成一条，按种类分组，同一项目的签收合成一项
// ④ 工作时间外：不紧急的攒着，紧急的照推；回到工作时间一起推
// ⑤ 推送限额：撞了限额的进下一次汇总最前面；推到限额那一条说一声；Ⅲ 级与部署健康不受限
// ⑥ 推之前再判：事项已经结了不推；快到时限的升成紧急；没有通道记 none；没有个人通道的管理员走部署级通道
// ⑦ 个人设置：覆盖部署默认、校验；两个进程同时推至多一次；pushSignal 当场推
// ⑧ 看板视图；汇总里一组跨几个项目时同一项目的挨着、带项目名
// ⑨ 事项链接：单条链到那件事（事项 → 快速答复，信号 → 任务 / 项目），汇总链到收件箱；没有基址不带
//
// 跑：node tests/push-queue.test.mjs

import { openDb, ensureOwner, newId } from '../src/db/db.mjs';
import { setUserChannel } from '../src/core/users.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { emitSignal, pushSignal, deliverSignals } from '../src/core/signals.mjs';
import { signalUrgency, questionUrgency, pushPrefsOf, setPushPrefs, inWorkingHours, nextWorkStart, enqueuePush, deliverPushes, pushStats, pushView, renderDigest } from '../src/core/push-queue.mjs';
import { updateUser } from '../src/db/users.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throwsWith = (fn, re, m) => { try { fn(); bad(m, '没有抛'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `抛了但不是预期：${e.message}`); } };

const H = 3_600_000, M = 60_000;
const WED10 = Date.parse('2026-11-11T10:00:00Z');   // 周三 10:00 UTC（部署时区默认 UTC）
const SAT10 = Date.parse('2026-11-14T10:00:00Z');

const db = openDb(':memory:');
const owner = ensureOwner(db, 'lead');
const lead = owner.userId;
const addUser = (name, role = 'member') => {
  const id = newId('u');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,?,'[]',?)`, id, name, role, WED10);
  setUserChannel(db, { userId: id, kind: 'ntfy', target: `https://ntfy.example/${name}`, byUserId: lead });
  return id;
};
const alice = addUser('alice'), bob = addUser('bob');
const P = newId('p');
db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'看板改版','/r','b','main','active',?)`, P, lead, WED10);
const task = (title = 't') => { const id = newId('t'); db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id) VALUES (?,?,?,'waiting',?,?)`, id, lead, title, WED10, P); return id; };
const question = (taskId, { level = 2, type = 'spec_choice', timeoutAt = null, status = 'open' } = {}) => {
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,timeout_at,status,decision_type) VALUES (?,?,?,'classifier','x',?,?,?,?,?)`,
    id, taskId, level, level === 3 ? null : 'd', WED10, level === 3 ? null : timeoutAt, status, type);
  return id;
};
const pushed = [];
const fetchFn = async (url, init) => { pushed.push({ to: String(url).split('/').pop(), title: decodeURIComponent(init?.headers?.title ?? init?.headers?.Title ?? ''), text: String(init?.body ?? '') }); return { ok: true, status: 200, json: async () => ({}) }; };
const round = async (at, opts = {}) => { pushed.length = 0; await deliverPushes(db, { env: {}, fetchFn, at, ...opts }); return pushed.map((p) => `${p.to}:${p.title.replace(/^\[SuperIntern\]\s*/, '')}`); };
const sig = (name, to, title, at = WED10, taskId = null) => emitSignal(db, name, { to, title: `[SuperIntern] ${title}`, text: 'x', taskId, projectId: P, at });
const reset = () => db.run(`UPDATE push_queue SET sent_at=0, sent_as='none' WHERE sent_at IS NULL`);

section('① 紧急程度一处判定');
{
  eq(signalUrgency('progress.task_merged'), { urgent: false, exempt: false }, '任务合并了：不紧急');
  eq(signalUrgency('external.ci_fix_started'), { urgent: true, exempt: false }, '以你的名义对外动作：紧急');
  eq(signalUrgency('deploy.runtime_down'), { urgent: true, exempt: true }, '部署健康：紧急、不受限额');
  eq(signalUrgency('timeout.escalated'), { urgent: true, exempt: false }, '已升级（现在轮到你答）：紧急');
  eq(signalUrgency('timeout.defaulted'), { urgent: false, exempt: false }, '超时按默认定了（事后告诉）：不紧急');
  const q = (o) => ({ level: 2, status: 'open', decision_type: 'spec_choice', timeout_at: WED10 + 8 * H, ...o });
  eq(questionUrgency(q({}), { at: WED10 }), { urgent: false, exempt: false }, 'Ⅱ 级规格取舍、离时限还远：不紧急');
  eq(questionUrgency(q({ level: 3, timeout_at: null }), { at: WED10 }), { urgent: true, exempt: true }, 'Ⅲ 级：紧急、不受限额');
  eq(questionUrgency(q({ decision_type: 'security' }), { at: WED10 }).urgent, true, '安全审批（命令停在门禁前）：紧急');
  eq(questionUrgency(q({ level: 3, decision_type: 'signoff' }), { at: WED10 }), { urgent: false, exempt: false }, '签收（Ⅲ 级）：活已做完只等合并，不紧急、攒着一起签');
  eq(questionUrgency(q({ level: 3, decision_type: 'signoff', timeout_at: WED10 + H }), { at: WED10 }).urgent, true, '签收快到时限：紧急');
  eq(questionUrgency(q({ status: 'escalated' }), { at: WED10 }).urgent, true, '已升级：紧急');
  eq(questionUrgency(q({ timeout_at: WED10 + 90 * M }), { at: WED10 }).urgent, true, '离时限不到 2 小时：紧急');
  eq(questionUrgency(q({ level: 3 }), { informed: true, at: WED10 }).urgent, false, '抄送的（不用你答）：一律不紧急');
}

section('② 工作时间');
{
  const p = pushPrefsOf(db, alice);
  eq([p.start, p.end, p.workdaysOnly, p.every, p.cap], [9, 18, true, 60, 4], '部署默认：工作日 9–18、汇总 60 分钟、限额 4');
  eq([inWorkingHours(db, p, WED10), inWorkingHours(db, p, WED10 + 9 * H), inWorkingHours(db, p, SAT10)], [true, false, false], '周三 10 点在、19 点不在、周六不在');
  setSetting(db, { key: 'deploy.holidays', value: '2026-11-11 节日', userId: lead });
  eq(inWorkingHours(db, pushPrefsOf(db, alice), WED10), false, '节假日表里的日子不算工作日');
  setSetting(db, { key: 'deploy.holidays', value: '', userId: lead });
  updateUser(db, bob, { tz: 'Asia/Shanghai' });
  eq(inWorkingHours(db, pushPrefsOf(db, bob), WED10), false, '按本人时区：UTC 10 点 = 上海 18 点，已经下班');
  eq(new Date(nextWorkStart(db, pushPrefsOf(db, bob), WED10)).toISOString(), '2026-11-12T01:00:00.000Z', '下一个工作时段：上海周四 9 点');
  updateUser(db, bob, { tz: null });
  eq(inWorkingHours(db, { ...p, start: 22, end: 6, workdaysOnly: false }, Date.parse('2026-11-11T23:30:00Z')), true, '跨午夜的班次（22–6）：23:30 在');
}

section('③ 汇总推送');
{
  const t1 = task('登录页'), t2 = task('列表页'), t3 = task('设置页');
  sig('progress.task_merged', [alice], '#1「登录页」合进项目分支了', WED10, t1);
  eq(await round(WED10), ['alice:#1「登录页」合进项目分支了'], '第一件：照原样推（没有攒的必要）');
  sig('progress.task_merged', [alice], '#2「列表页」合进项目分支了', WED10 + 5 * M, t2);
  for (const [t, title] of [[t1, '等你签收：登录页'], [t2, '等你签收：列表页'], [t3, '等你签收：设置页']]) {
    const q = question(t, { type: 'signoff', timeoutAt: WED10 + 24 * H });
    enqueuePush(db, { userId: alice, kind: 'question.addressed', source: 'question', sourceId: q, urgent: false, group: `sign:${P}`, projectId: P, taskId: t, title: `[SuperIntern] ${title}`, text: 'x', at: WED10 + 10 * M });
  }
  eq(await round(WED10 + 30 * M), [], '汇总间隔（60 分钟）没到：攒着');
  const r = await round(WED10 + 61 * M);
  eq(r.length, 1, '到了间隔：4 件合成一条');
  eq(r[0], 'alice:4 件新事，其中 3 件等你', '标题说几件、几件等你答');
  const body = pushed[0].text;
  assert(/等你签收（3）· 项目「看板改版」/.test(body) && /逐件签/.test(body) && !/一起签收/.test(body) && body.indexOf('等你签收') < body.indexOf('进度'), '同一项目的签收合成一组、排在通知前面；不说能一起签（平常的签收逐件签）', body.slice(0, 300));
  eq(pushStats(db, alice, { since: WED10 }), { pushes: 2, singles: 0, digests: 2, items: 5 }, '打断统计：推了 2 次、装了 5 件');
}

section('④ 工作时间外');
{
  reset();
  const t = task('夜里');
  sig('progress.task_merged', [bob], '#4「夜里」合进项目分支了', WED10 + 10 * H, t);
  sig('external.ci_fix_started', [bob], 'PR #7 的检查没过，AI 在修', WED10 + 10 * H, t);
  eq(await round(WED10 + 10 * H), ['bob:PR #7 的检查没过，AI 在修'], '晚上 20 点：紧急的照推，不紧急的攒着');
  eq(await round(WED10 + 23 * H), ['bob:#4「夜里」合进项目分支了'], '第二天 9 点：攒着的推出去');
}

section('⑤ 推送限额');
{
  reset();
  setPushPrefs(db, { userId: alice, prefs: { cap: 2 } });
  const t = task('限额');
  for (const n of [1, 2, 3]) sig('external.ci_fix_started', [alice], `PR #${n} 在修`, WED10 + 3 * H, t);
  const r = await round(WED10 + 3 * H);
  eq(r, ['alice:PR #1 在修', 'alice:PR #2 在修'], '限额 2：前两条即时推');
  assert(/之后的会合并进下一次汇总推送/.test(pushed[1].text), '推到限额那一条说一声"之后的会合并进汇总"', pushed[1].text.slice(-80));
  eq(db.one(`SELECT capped FROM push_queue WHERE title LIKE '%PR #3%'`).capped, 1, '第三条：撞了限额，标成排进汇总');
  const q3 = question(t, { level: 3 });
  enqueuePush(db, { userId: alice, kind: 'question.addressed', source: 'question', sourceId: q3, urgent: true, exempt: true, group: 'ask', projectId: P, taskId: t, title: '[SuperIntern] Ⅲ 级问题在等你：要不要删库', text: 'x', at: WED10 + 3 * H });
  eq(await round(WED10 + 3 * H + M), ['alice:Ⅲ 级问题在等你：要不要删库'], 'Ⅲ 级不受限额，照推；撞了限额的那条不跟着推（这一小时已经打断够了）');
  sig('progress.task_merged', [alice], '#5「限额」合进项目分支了', WED10 + 3 * H + 30 * M, t);
  eq(await round(WED10 + 3 * H + 40 * M), [], '一小时内已经推了 2 条（限额）：汇总也等窗口空出来');
  const r2 = await round(WED10 + 4 * H + 2 * M);
  assert(r2.length === 1 && /这一小时推得多，下面 1 件紧急的没有单独推/.test(pushed[0].text) && pushed[0].text.indexOf('PR #3') < 80, '下一次汇总：撞了限额的排在最前面', pushed[0]?.text.slice(0, 120));
  setPushPrefs(db, { userId: alice, prefs: { cap: null } });
}

section('⑥ 推之前再判');
{
  reset();
  const t = task('再判');
  const done = question(t), near = question(t, { timeoutAt: WED10 + 5 * H + 30 * M });
  for (const q of [done, near]) enqueuePush(db, { userId: bob, kind: 'question.addressed', source: 'question', sourceId: q, urgent: false, group: 'ask', projectId: P, taskId: t, title: `[SuperIntern] Ⅱ 级问题在等你：${q === done ? '已经答了' : '快到时限'}`, text: 'x', at: WED10 });
  db.run(`UPDATE questions SET status='answered' WHERE id=?`, done);
  setPushPrefs(db, { userId: bob, prefs: { start: 0, end: 1 } });   // 此刻不在工作时间：只有紧急的推得出去
  eq(await round(WED10 + 5 * H), ['bob:Ⅱ 级问题在等你：快到时限'], '离时限不到 2 小时：升成紧急、工作时间外也推；已经答了的不推');
  eq(db.one(`SELECT sent_as FROM push_queue WHERE source_id=?`, done).sent_as, 'moot', '已经结了的记 moot');
  setPushPrefs(db, { userId: bob, prefs: { start: null, end: null } });
  const carol = newId('u');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,'carol','member','[]',?)`, carol, WED10);
  sig('progress.task_merged', [carol], '没有通道', WED10 + 6 * H);
  await round(WED10 + 6 * H);
  eq(db.one(`SELECT sent_as FROM push_queue WHERE user_id=?`, carol).sent_as, 'none', '没有通道的成员：记 none，不推（看板里看得到）');
  sig('external.ci_fix_started', [lead], '管理员没配个人通道', WED10 + 6 * H);
  const r = await round(WED10 + 6 * H, { env: { NTFY_URL: 'https://ntfy.example/deploy' } });
  eq(r, ['deploy:管理员没配个人通道'], '没有个人通道的管理员：走部署级通道');
}

section('⑦ 个人设置、并发、当场推');
{
  reset();
  throwsWith(() => setPushPrefs(db, { userId: alice, prefs: { cap: 99 } }), /值无效/, '限额超出范围拒收');
  throwsWith(() => setPushPrefs(db, { userId: alice, prefs: { loud: 1 } }), /没有这一项/, '不认识的设置拒收');
  setPushPrefs(db, { userId: alice, prefs: { every: 15 } });
  eq([pushPrefsOf(db, alice).every, pushPrefsOf(db, bob).every], [15, 60], '个人设置只影响自己');
  setPushPrefs(db, { userId: alice, prefs: { every: null } });
  for (let i = 0; i < 5; i++) sig('external.ci_fix_started', [bob], `并发 ${i}`, WED10 + 28 * H);
  pushed.length = 0;
  await Promise.all([deliverPushes(db, { env: {}, fetchFn, at: WED10 + 28 * H }), deliverPushes(db, { env: {}, fetchFn, at: WED10 + 28 * H })]);
  eq(pushed.length, 4, '两个进程同时推：限额 4 之内各推一次，没有重复');
  pushed.length = 0;
  const r = await pushSignal(db, 'deploy.catalog', { to: [alice], title: '[SuperIntern] 模型目录有变化', text: 'x', at: SAT10 }, { env: {}, fetchFn, at: SAT10 });
  eq([pushed.map((p) => p.to), r.receipts.length], [['alice'], 1], 'pushSignal：周六也当场推、带回执（进程马上要退的调用方）');
  pushed.length = 0;
  await deliverSignals(db, { env: {}, fetchFn, at: WED10 + 30 * H });   // 周四 16 点：撞了限额的第 5 条随汇总推出
  assert(pushed.length >= 1, 'deliverSignals 顺带推队列（守护进程每一拍调它）');
}

section('⑧ 看板视图：生效的设置、时区是谁的、此刻在不在工作时间');
{
  setPushPrefs(db, { userId: alice, prefs: { start: 22, end: 2 } });
  let v = pushView(db, alice, WED10);
  eq([v.prefs.start, v.prefs.end, v.own, v.tz, v.tzOwn, v.working], [22, 2, { start: 22, end: 2 }, 'UTC', false, false], '跨午夜的班：周三 10 点不在；时区跟部署（没单独设）');
  eq(new Date(v.nextStart).toISOString(), '2026-11-11T22:00:00.000Z', '下一个工作时段：当天 22 点');
  updateUser(db, alice, { tz: 'Asia/Shanghai' });
  v = pushView(db, alice, WED10);
  eq([v.tz, v.tzOwn, v.working], ['Asia/Shanghai', true, false], '自己设了时区：按它算（上海 18 点，不在 22–2 点）');
  eq(pushView(db, alice, Date.parse('2026-11-11T15:00:00Z')).working, true, '上海 23 点：在跨午夜的班里');
  updateUser(db, alice, { tz: null });
  const team = pushView(db, lead, WED10 + 40 * H).team;
  assert(Array.isArray(team) && team.some((u) => u.name === 'alice' && u.pushes > 0) && team.every((u, i) => !i || team[i - 1].pushes >= u.pushes), '管理员看得到全员最近 7 天被打断几次（多的在前）', JSON.stringify(team));
  eq(pushView(db, alice, WED10).team, null, '成员看不到别人的');
  setPushPrefs(db, { userId: alice, prefs: { start: null, end: null } });
  throwsWith(() => setPushPrefs(db, { userId: alice, prefs: { start: 9, end: 9 } }), /同一个钟点/, '开始和结束同一个钟点拒收');
  const P2 = newId('p');
  db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'支付','/r2','b','main','active',?)`, P2, lead, WED10);
  const row = (title, project_id, created_at) => ({ kind: 'question.addressed', group_key: 'ask', project_id, title: `[SuperIntern] ${title}`, created_at, capped: 0 });
  const t = renderDigest(db, alice, [row('甲1', P, WED10), row('乙1', P2, WED10 + M), row('甲2', P, WED10 + 2 * M)], { at: WED10 }).text;
  const ls = t.split('\n').filter((l) => l.startsWith('· '));
  eq(ls, ['· 「看板改版」 甲1', '· 「看板改版」 甲2', '· 「支付」 乙1'], '一组跨两个项目：同一项目的挨着（按项目里最早的那件排），每条带项目名');
  const one = renderDigest(db, alice, [row('甲1', P, WED10), row('甲2', P, WED10 + M)], { at: WED10 }).text;
  assert(!/「看板改版」/.test(one), '只有一个项目：不带项目名', one);
}

section('⑨ 事项链接');
{
  const { registerBoardBase, itemLink } = await import('../src/core/links.mjs');
  reset();
  registerBoardBase(null);
  eq(itemLink(db, { questionId: 'q_x' }), null, '没有基址（没填看板地址、看板也没登记）：不带链接');
  registerBoardBase('http://127.0.0.1:7357/');
  eq(itemLink(db, { questionId: 'q_x' }), 'http://127.0.0.1:7357/#q/q_x', '看板登记的地址：事项 → 快速答复');
  setSetting(db, { key: 'deploy.board_url', value: 'https://si.example.lan', userId: lead });
  eq(itemLink(db, { taskId: 't_1' }), 'https://si.example.lan/#t_1', '管理员填的看板地址优先');
  const t = task('链接');
  const q = question(t, { level: 3, type: 'structural' });
  enqueuePush(db, { userId: alice, kind: 'question.addressed', source: 'question', sourceId: q, urgent: true, exempt: true, group: 'ask', projectId: P, taskId: t, title: '[SuperIntern] 结构矛盾', text: '正文', at: WED10 + 50 * H });
  await round(WED10 + 50 * H);
  assert(pushed.length === 1 && pushed[0].text.endsWith(`https://si.example.lan/#q/${q}`), '单条事项推送：正文末尾是快速答复链接', JSON.stringify(pushed));
  sig('progress.task_merged', [bob], '#9 合并了', WED10 + 51 * H, t);
  sig('progress.task_merged', [bob], '#10 合并了', WED10 + 51 * H, t);
  await round(WED10 + 53 * H);
  assert(pushed.some((p) => p.text.endsWith('https://si.example.lan/#inbox')), '汇总推送：链到收件箱', JSON.stringify(pushed.map((p) => p.text.slice(-40))));
  setSetting(db, { key: 'deploy.board_url', value: '', userId: lead });
  registerBoardBase(null);
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
