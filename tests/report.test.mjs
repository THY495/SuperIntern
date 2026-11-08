// 状态报告：一段时间里发生了什么。
//
// 每段造一条应该出现的、一条不该出现的（时间段外的、别人项目里的、你不参与的项目里的）。
// ① 出事了没有：没出事才说"没有出事"；部署健康只给管理员；触到上限按参与的项目算
// ② 没等你拍板就定下的：超时按默认走、AI 自己定的做法；调成备案的也汇总进来，并写明"没推送过"
// ③ 进展：合并按 tasks.merged_at；每一步的进度不算
// ④ 花费按项目、本月 / 预算；还等你的只给数
// ⑤ 详略：只报异常 / 摘要（每段最多 5 条）/ 详细；范围：全部项目只给管理员
// ⑥ --since 的写法
// ⑦ 定期发；⑧ 你不在时（离开 8 小时以上才算；没关掉的接着往前算）
//
// 跑：node tests/report.test.mjs

import { openDb, ensureOwner, newId } from '../src/db/db.mjs';
import { emitSignal, setSignalPref } from '../src/core/signals.mjs';
import { setMember } from '../src/core/project-members.mjs';
import { buildStatusReport, renderStatusReport, parseSince } from '../src/core/report.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const H = 3_600_000, D = 24 * H;
const T0 = Date.parse('2026-11-04T00:00:00Z'), T1 = T0 + 7 * D;   // 报告时段 [T0, T1)
const IN = T0 + 2 * D, BEFORE = T0 - D;
const db = openDb(':memory:');
const { userId: lead } = ensureOwner(db, '负责人');
const addUser = (name) => { const id = newId('u'); db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,'member','[]',?)`, id, name, BEFORE); return id; };
const lin = addUser('阿青');
const project = (title, visibility = 'all') => { const id = newId('p'); db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at,visibility) VALUES (?,?,?,'/r','b','main','active',?,?)`, id, lead, title, BEFORE, visibility); return id; };
const P1 = project('看板改版'), P2 = project('计费系统', 'members');
setMember(db, { projectId: P1, userId: lin, by: lead });
const task = (pid, title, mergedAt = null) => { const id = newId('t'); db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,merged_at) VALUES (?,?,?,'done',?,?,?)`, id, lead, title, BEFORE, pid, mergedAt); return id; };
const spend = (taskId, micro, ts) => db.run(`INSERT INTO usage_ledger (task_id,role,model_tier,provider,model_id,input_tokens,output_tokens,micro_usd,billing,ts,payer_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, taskId, 'executor', 'standard', 'x', 'm', 1, 1, micro, 'computed', ts, lin);
const sig = (name, to, title, at = IN, taskId = null, projectId = null) => emitSignal(db, name, { to, title: `[SuperIntern] ${title}`, text: 'x', taskId, projectId, at });
const report = (userId, o = {}) => buildStatusReport(db, { userId, since: T0, until: T1, ...o });
const text = (userId, o = {}) => { const r = renderStatusReport(report(userId, o)); return `${r.title}\n${r.text}`; };

const tA = task(P1, '列表按更新时间排序', IN), tOld = task(P1, '上周的活', BEFORE), tB = task(P2, '对账单导出', IN);

section('① 出事了没有');
{
  eq(report(lin).quiet, true, '什么都没发生：quiet');
  assert(/状态报告：没有出事/.test(text(lin)) && /这段时间没有出事/.test(text(lin)), '标题和第一段都明说"没有出事"');
  sig('deploy.runtime_down', ['admins'], '沙箱运行时停了', IN);
  sig('deploy.runtime_down', ['admins'], '上周的停机', BEFORE);
  eq(report(lead).exceptions.map((x) => x.title), ['沙箱运行时停了'], '管理员：这段时间的部署健康事件（时段外的不算）');
  eq(report(lin).quiet, true, '成员：部署健康不发给他，照样没出事');
  const qb = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,asked_at,status,decision_type) VALUES (?,?,3,'classifier','花费到了任务上限 $5',?,'open','budget')`, qb, tA, IN);
  const qb2 = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,asked_at,status,decision_type) VALUES (?,?,3,'classifier','计费系统的上限',?,'open','budget')`, qb2, tB, IN);
  eq(report(lin).limitHits.map((x) => x.title), ['花费到了任务上限 $5'], '触到上限：只算你参与的项目（计费系统你不在里面）');
  assert(/状态报告：出了 1 件事/.test(text(lin)) && !/没有出事/.test(text(lin)), '有一件就不说"没有出事"');
  sig('run.hard_failed', [lin], '「列表按更新时间排序」硬失败', IN, tA);
  eq(report(lin).exceptions.map((x) => x.title), ['「列表按更新时间排序」硬失败'], '任务硬失败算出事');
}

section('② 没等你拍板就定下的（含备案）');
{
  sig('timeout.defaulted', [lin], '规格取舍超时，按默认走了：列表默认排序', IN, tA);
  setSignalPref(db, { userId: lin, cls: 'ai_choices', tier: 'record' });
  sig('choices.made', [lin], 'AI 定了：分页每页 20 条', IN, tA);
  sig('choices.made', [lin], 'AI 定了：日期格式 YYYY-MM-DD', IN + H, tA);
  const r = report(lin);
  eq(r.decided.map((g) => [g.cls, g.n, g.record]), [['timeout', 1, 0], ['ai_choices', 2, 2]], '按类分组：超时 1 条；AI 自己定的做法 2 条（都是备案）');
  const t = text(lin);
  assert(/AI 自己定的做法：2 条（其中 2 条你调成了备案，没推送过）/.test(t), '写明调成了备案、没推送过', t);
  assert(t.indexOf('超时') < t.indexOf('AI 自己定的做法'), '替你定的排在 AI 自己做的前面');
  sig('run.report', [lin], '第 3 步做完了', IN, tA);
  assert(!/第 3 步做完了/.test(text(lin)), '每一步的进度不算（太碎）');
}

section('③ 进展');
{
  eq(report(lin).merged.map((x) => x.title), ['列表按更新时间排序'], '合并：这段时间、你参与的项目（上周的、计费系统的都不算）');
  eq(report(lead, { scope: 'all' }).merged.map((x) => x.title).sort(), ['列表按更新时间排序', '对账单导出'].sort(), '管理员看全部项目：两个都在');
  assert(/合并了 1 个任务/.test(text(lin)), '写合并了几个');
}

section('④ 花费与还等你的');
{
  spend(tA, 1_500_000, IN); spend(tA, 9_000_000, BEFORE); spend(tB, 2_000_000, IN);
  const r = report(lin);
  eq([r.spend.total, r.spend.byProject.map((p) => p.title)], [1_500_000, ['看板改版']], '这段时间、你参与的项目花了多少（时段外的、别的项目的不算）');
  assert(/这段时间花了 \$1\.50：看板改版 \$1\.50/.test(text(lin)), '按项目写出来');
  assert(/你本月花了 .*（没设预算）/.test(text(lin)), '本月花了多少；没设预算就说没设');
  const q = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,status,decision_type,addressed_to) VALUES (?,?,2,'classifier','x','d',?,'open','spec_choice',?)`, q, tA, IN, JSON.stringify([lin]));
  eq(report(lin).waiting, 1, '还有 1 件等你答');
  db.run(`INSERT INTO answers (id,question_id,user_id,body,stance,created_at) VALUES (?,?,?,?,?,?)`, newId('a'), q, lin, 'B', 'answer', IN);
  eq(report(lin).waiting, 0, '答过了（还在等别人）就不算等你');
}

section('⑤ 详略与范围');
{
  const ex = text(lin, { detail: 'exceptions' });
  assert(/① 出事了没有/.test(ex) && !/②|③|④/.test(ex) && /没有等你答的事/.test(ex), '只报异常：只有第一段，外加还等你几件');
  for (let i = 0; i < 7; i++) sig('timeout.defaulted', [lin], `超时第 ${i} 条`, IN + i * 60_000, tA);
  const sum = text(lin);
  assert(/另有 3 条/.test(sum), '摘要：每段最多 5 条，其余写另有几条', sum.match(/超时[\s\S]{0,400}/)?.[0]);
  const full = text(lin, { detail: 'full' });
  assert(/超时第 6 条/.test(full) && !/另有/.test(full), '详细：全列');
  eq(report(lin, { scope: 'all' }).scope, 'mine', '成员要全部项目：退回只看与自己有关的');
  assert(/^.*\n全部项目 · /.test(text(lead, { scope: 'all' })), '管理员全部项目：报告头写明范围');
}

section('⑥ --since');
{
  const u = Date.parse('2026-11-11T12:00:00Z');
  eq(parseSince('24h', u), u - 24 * H, '24h');
  eq(parseSince('7d', u), u - 7 * D, '7d');
  eq(parseSince('2026-11-01', u), Date.parse('2026-11-01'), '日期');
  eq(parseSince('明天', u), null, '认不出 → null');
  eq(parseSince('2027-01-01', u), null, '在结束时刻之后 → null');
}

section('⑦ 定期发：什么时候、发哪一段、怎么推');
{
  const { reportPrefsOf, lastSlot, queueDueReports } = await import('../src/core/report.mjs');
  const { setPushPrefs, deliverPushes } = await import('../src/core/push-queue.mjs');
  const { setSetting } = await import('../src/core/settings.mjs');
  const { setUserChannel } = await import('../src/core/users.mjs');
  const at = (s) => Date.parse(s);
  // 默认：按部署的监督模式
  eq([reportPrefsOf(db, lin).every, reportPrefsOf(db, lin).detail, reportPrefsOf(db, lin).scope], ['week', 'summary', 'mine'], '默认（抽检）：每周一份摘要，成员只看与自己有关的');
  eq(reportPrefsOf(db, lead).scope, 'all', '管理员默认看全部项目');
  setSetting(db, { key: 'deploy.oversight_mode', value: 'exception', userId: lead });
  eq([reportPrefsOf(db, lin).every, reportPrefsOf(db, lin).detail], ['week', 'exceptions'], '例外管理：每周只报异常');
  setSetting(db, { key: 'deploy.oversight_mode', value: 'full', userId: lead });
  eq(reportPrefsOf(db, lin).every, 'day', '逐项审批：每天');
  setSetting(db, { key: 'deploy.oversight_mode', value: 'spot', userId: lead });
  // 时刻点（2026-11-11 是周三；部署时区 UTC；周末不是工作日）
  const day = { every: 'day', day: 1, hour: 9, tz: 'UTC' }, week = { ...day, every: 'week' };
  eq(lastSlot(db, day, at('2026-11-11T10:00:00Z')), at('2026-11-11T09:00:00Z'), '每天 9 点：周三 10 点 → 当天 9 点');
  eq(lastSlot(db, day, at('2026-11-11T08:00:00Z')), at('2026-11-10T09:00:00Z'), '还没到 9 点 → 前一天 9 点');
  eq(lastSlot(db, week, at('2026-11-11T10:00:00Z')), at('2026-11-09T09:00:00Z'), '每周一 9 点：周三 → 本周一');
  eq(lastSlot(db, day, at('2026-11-14T10:00:00Z')), at('2026-11-13T09:00:00Z'), '周六：周六的那份顺延到周一，此刻最近的是周五');
  eq(lastSlot(db, day, at('2026-11-16T10:00:00Z')), at('2026-11-16T09:00:00Z'), '周一：周六、周日、周一三份落在同一个时刻，合成一份');
  eq(lastSlot(db, { ...day, tz: 'Asia/Shanghai' }, at('2026-11-11T02:00:00Z')), at('2026-11-11T01:00:00Z'), '按本人时区：东八区 9 点 = UTC 1 点');
  eq(lastSlot(db, { ...day, every: 'off' }, at('2026-11-11T10:00:00Z')), null, '关了：没有');

  // 排进队列：第一份往前算一个周期；同一个时刻点只排一次；下一份接着上一份
  setUserChannel(db, { userId: lin, kind: 'ntfy', target: 'https://ntfy.example/lin', byUserId: lead });
  setPushPrefs(db, { userId: lin, prefs: { reportEvery: 'day', reportHour: 9 } });
  setPushPrefs(db, { userId: lead, prefs: { reportEvery: 'off' } });
  const W10 = at('2026-11-11T10:00:00Z');
  const q1 = queueDueReports(db, { at: W10 });
  eq(q1.map((x) => [x.userId === lin, x.slot, x.since]), [[true, at('2026-11-11T09:00:00Z'), at('2026-11-10T09:00:00Z')]], '第一份：到点的只有阿青（管理员关了），覆盖前一天 9 点到今天 9 点');
  eq(queueDueReports(db, { at: W10 + 60_000 }).length, 0, '同一个时刻点不重排');
  const q2 = queueDueReports(db, { at: at('2026-11-12T09:30:00Z') });
  eq(q2.map((x) => x.since), [at('2026-11-11T09:00:00Z')], '下一份接着上一份的结束');
  const rows = db.all(`SELECT source, kind, urgent, title FROM push_queue WHERE source='report' ORDER BY created_at`);
  eq(rows.map((r) => [r.source, r.kind, r.urgent]), [['report', 'report.status', 0], ['report', 'report.status', 0]], '进推送队列：不紧急');
  // 推：单条推、不并进汇总；工作时间外不推
  const sent = [];
  const fetchFn = async (url, init) => { sent.push({ to: String(url).split('/').pop(), title: decodeURIComponent(init?.headers?.title ?? ''), body: String(init?.body ?? ''), click: init?.headers?.click }); return { ok: true, status: 200, json: async () => ({}) }; };
  sig('timeout.defaulted', [lin], '另一条不紧急的', at('2026-11-12T09:31:00Z'), tA);
  await deliverPushes(db, { env: {}, fetchFn, at: at('2026-11-12T20:00:00Z') });
  eq(sent.length, 0, '晚上 8 点（工作时间外）：不推');
  await deliverPushes(db, { env: {}, fetchFn, at: at('2026-11-13T09:40:00Z') });
  const reps = sent.filter((x) => /状态报告/.test(x.title));
  eq(reps.length, 2, '工作时间里：两份报告各推一条（不并成一条）');
  assert(sent.some((x) => !/状态报告/.test(x.title)) && !reps.some((x) => /另一条不紧急的/.test(x.body)), '别的不紧急的另走汇总，不混进报告');
  setPushPrefs(db, { userId: lin, prefs: { reportEvery: 'off' } });
  eq(queueDueReports(db, { at: at('2026-11-20T10:00:00Z') }).length, 0, '改成关：不再排');
  let threw = false; try { setPushPrefs(db, { userId: lin, prefs: { reportEvery: 'hourly' } }); } catch { threw = true; }
  eq(threw, true, '设置值不对要拒');
}

section('⑧ 你不在时：离开 8 小时以上，回来给这段的摘要');
{
  const { noteSeen, dismissAway, awaySummary, reportView, AWAY_MS } = await import('../src/core/report.mjs');
  const S0 = T0 + 2 * D - 3 * H;   // 在 IN 之前三小时还在看
  eq(noteSeen(db, lin, { at: S0 }), null, '第一次报"在看"：没有离开');
  eq(noteSeen(db, lin, { at: S0 + 2 * H }), null, '隔两小时：不算离开');
  const back = S0 + 2 * H + AWAY_MS + H;   // 隔了 9 小时回来，中间有 IN 那批事
  const away = noteSeen(db, lin, { at: back });
  eq(away, { from: S0 + 2 * H, to: back }, '隔 9 小时：记一段离开，从上次在看到这次');
  const sum = awaySummary(db, lin, away);
  const full = buildStatusReport(db, { userId: lin, since: away.from, until: away.to, scope: 'mine', detail: 'summary' });
  eq([sum.quiet, sum.exceptions, sum.merged, sum.waiting], [full.quiet, full.exceptions.length + full.limitHits.length, full.merged.length, full.waiting], '摘要的数和那段时间的状态报告一致');
  eq(noteSeen(db, lin, { at: back + 10 * 60_000 }), away, '没关掉之前：再报"在看"仍给同一段');
  const again = noteSeen(db, lin, { at: back + 10 * 60_000 + AWAY_MS + H });
  eq(again.from, away.from, '没关掉又离开一次：接着从上一段的开头算');
  dismissAway(db, lin);
  eq(noteSeen(db, lin, { at: again.to + 60_000 }), null, '关掉以后：不再显示');
  eq(awaySummary(db, lin, null), null, '没有离开：没有摘要');
  const rv = reportView(db, lin);
  eq([rv.isLead, rv.prefs.scope, rv.own.every, rv.deploy.auto.every], [false, 'mine', 'off', 'week'], '设置页那一行：自己的设置、部署默认 auto 落到哪');
  assert(rv.last && rv.last.slot_at === Date.parse('2026-11-12T09:00:00Z'), '设置页那一行：给出上一份');
  const { monthSpan } = await import('../src/core/report.mjs');
  db.run(`UPDATE users SET tz='Asia/Shanghai' WHERE id=?`, lin);
  eq(monthSpan(db, lin, { at: Date.parse('2026-01-15T00:00:00Z') }), { since: Date.parse('2025-11-30T16:00:00Z'), until: Date.parse('2025-12-31T16:00:00Z') }, '「上个月」按这个人的时区算自然月（跨年）');
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
