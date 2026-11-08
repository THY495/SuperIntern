// 信号分级与介入方式。
//
// ① 登记表：每个产生点用的信号名都登记过、归到一类；推送通道只有 signals.mjs 调（每次推送说得出是哪一类、按什么档推的）
// ② 介入方式的解析：监督模式（部署默认 → 项目）、底线、Ⅲ 级、例外管理下的Ⅰ / Ⅱ 级、进度的粒度
// ③ 个人偏好：只能在通知 ↔ 备案之间调自己的；底线是通知的调不成备案
// ④ 发件箱：通知档推、备案档不推；没人收得到退到部署通道；两个进程同时推至多一次
// ⑤ 原来的假通知：迟到异议、负责人覆盖、后答取代、弃权 —— 真的进发件箱
// ⑥ 超时替人定了：按默认结案 / 升级 / 挂住 都告诉原收件人与任务负责人
// ⑦ 事项推送：知会人的标题写"通知："、可调成备案；部署告警给全体管理员
// ⑧ 默认能不能生效：类型 + 级别一处判定
// ⑨ 监督模式改变行为：逐项审批下 AI 自定的事要答了才合并、计划每处改动都要批；例外管理只留备案
// ⑩ 看板接口：我的通知、偏好、监督模式、审批门禁（只有负责人能改、看到的版本对不上 409）
// ⑪ 联网被拦 / 凭据注入：一个任务攒成一条，没推、没人看就改写同一条
//
// 跑：node tests/signals.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDb, ensureOwner, newId, now, sha256 } from '../src/db/db.mjs';
import { SIGNALS, CLASSES, QUESTION_CLASS, MODES, tierOf, oversightMode, setOversightMode, setSignalPref, personalTier, emitSignal, deliverSignals, signalsFor } from '../src/core/signals.mjs';
import { DECISION_TYPES, applyTemplate, rulesOf, saveRules, routeQuestion } from '../src/core/routing.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { setUserChannel, notifyPendingQuestions } from '../src/core/users.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { sweepTimeouts } from '../src/core/timeouts.mjs';
import { raiseChoiceReviews, choicesHolding } from '../src/core/choices.mjs';
import { gateOf } from '../src/core/revision.mjs';
import { gatesOf } from '../src/core/approval-gates.mjs';
import { startWeb } from '../src/web/server.mjs';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throwsWith = (fn, re, m) => { try { fn(); bad(m, '没有抛'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `抛了但不是预期：${e.message}`); } };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.mjs') ? [p] : []; });
const SRC = walk(join(ROOT, 'src'));

section('① 登记表与唯一出口');
{
  const bad1 = Object.entries(SIGNALS).filter(([, s]) => s.class !== null && !CLASSES[s.class]);
  eq(bad1.map(([n]) => n), [], '登记的信号都归到 18 类之一（或是注明了的汇总通道）');
  eq(Object.keys(CLASSES).length, 18, '18 类');
  eq(Object.keys(DECISION_TYPES).filter((t) => !QUESTION_CLASS[t]), [], '每种决策类型都有所属类');
  for (const [k, c] of Object.entries(CLASSES)) {
    const rank = { record: 0, notify: 1, decide: 2 };
    if (c.floor && Object.keys(MODES).some((m) => rank[c[m]] < rank[c.floor])) bad(`${k}：有模式的默认档低于底线`);
  }
  ok('没有哪一类的默认档低于自己的底线');
  // 推送通道只许 signals.mjs 调
  const importers = SRC.filter((f) => /import\s*\{[^}]*\bnotify\b[^}]*\}\s*from\s*'[^']*notify\.mjs'/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f).replaceAll('\\', '/'));
  eq(importers, ['src/core/signals.mjs'], '推送通道（notify）只有 signals.mjs 引用');
  // 源码里用到的信号名都登记过
  const used = new Set();
  for (const f of SRC) for (const m of readFileSync(f, 'utf8').matchAll(/(?:emitSignal|pushSignal|pushDirect|trySignal|trySignalOnce|trySignalCoalesced)\(db, '([a-z_.]+)'/g)) used.add(m[1]);
  for (const f of SRC) for (const m of readFileSync(f, 'utf8').matchAll(/(?:notifyAdmins|tellTimeout|tellOthers)\((?:db, )?'([a-z_.]+)'/g)) used.add(m[1]);
  for (const m of readFileSync(join(ROOT, 'src/cli.mjs'), 'utf8').matchAll(/'(run\.[a-z_]{3,})'/g)) used.add(m[1]);
  for (const m of readFileSync(join(ROOT, 'src/core/push-queue.mjs'), 'utf8').matchAll(/'(push\.[a-z_]{3,})'/g)) used.add(m[1]);   // 汇总推送
  for (const m of readFileSync(join(ROOT, 'src/core/report.mjs'), 'utf8').matchAll(/kind: '(report\.[a-z_]{3,})'/g)) used.add(m[1]);   // 状态报告：直接进推送队列
  const unknown = [...used].filter((n) => !SIGNALS[n]);
  eq(unknown, [], `源码里用到的 ${used.size} 个信号名都登记过`);
  const unused = Object.keys(SIGNALS).filter((n) => !used.has(n) && !n.startsWith('question.'));
  eq(unused, [], '登记了的信号都有产生点（没有死条目）');
}

// ── 库与人 ─────────────────────────────────────────────────────────────
const db = openDb(':memory:');
const owner = ensureOwner(db, 'lead');
// 这里测"推给谁"，不测"什么时候推"（推送节奏另有测试）：随时推、不攒、不限额
const anytime = (d, userId) => { for (const [key, value] of [['deploy.work_start_hour', 0], ['deploy.work_end_hour', 24], ['deploy.work_days_only', false], ['deploy.digest_every_min', 0], ['deploy.push_cap_per_hour', 0]]) setSetting(d, { key, value, userId }); };
anytime(db, owner.userId);
const lead = owner.userId;
const t0 = now();
const addUser = (name, role = 'member', tags = []) => {
  const id = newId('u');
  const plaintext = randomBytes(12).toString('base64url');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,?,?,?)`, id, name, role, JSON.stringify(tags), t0);
  db.run(`INSERT INTO tokens (id,user_id,token_hash,issued_by,issued_at) VALUES (?,?,?,?,?)`, newId('tk'), id, sha256(plaintext), lead, t0);
  setUserChannel(db, { userId: id, kind: 'ntfy', target: `https://ntfy.example/${name}`, byUserId: lead });
  return { id, plaintext };
};
setUserChannel(db, { userId: lead, kind: 'ntfy', target: 'https://ntfy.example/lead', byUserId: lead });
const alice = addUser('alice', 'member', ['reviewer']);
const bob = addUser('bob', 'member', ['reviewer']);
const admin2 = addUser('admin2', 'lead');
const P = newId('p');
db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'P','/r','b','main','active',?)`, P, lead, t0);
const mkTask = ({ project = P, status = 'waiting' } = {}) => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id) VALUES (?,?,'t',?,?,?)`, id, lead, status, t0, project);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), id, t0, t0);
  return id;
};
const pushed = [];
const fetchFn = async (url, init) => { pushed.push({ to: String(url).split('/').pop(), title: decodeURIComponent(init?.headers?.title ?? '') }); return { ok: true, status: 200, json: async () => ({}) }; };
const round = async (opts = {}) => { pushed.length = 0; await deliverSignals(db, { env: {}, fetchFn, ...opts }); return pushed.map((p) => p.to).sort(); };

section('② 介入方式的解析');
{
  eq(oversightMode(db, P), 'spot', '默认监督模式是抽检');
  eq(tierOf(db, 'ai_choices', { projectId: P }), 'notify', '抽检：AI 自己定的做法 → 通知');
  eq(tierOf(db, 'progress', { projectId: P, grain: 'step' }), 'record', '抽检：每步进度 → 备案');
  eq(tierOf(db, 'progress', { projectId: P, grain: 'task' }), 'notify', '抽检：任务级进度 → 通知');
  setSetting(db, { key: 'deploy.oversight_mode', value: 'exception', userId: lead });
  eq(oversightMode(db, P), 'exception', '项目没单独设：跟部署默认（改成例外管理）');
  eq(tierOf(db, 'spec_choice', { projectId: P, level: 1 }), 'notify', '例外管理：Ⅰ 级规格取舍 → 通知（按默认直接走）');
  eq(tierOf(db, 'spec_choice', { projectId: P, level: 2 }), 'decide', '例外管理：Ⅱ 级规格取舍仍是决策');
  eq(tierOf(db, 'spec_choice', { projectId: P, level: 3 }), 'decide', 'Ⅲ 级一律决策');
  eq(tierOf(db, 'progress', { projectId: P, grain: 'attention' }), 'notify', '例外管理：停滞 / 待交付仍通知');
  eq(tierOf(db, 'timeout', { projectId: P }), 'notify', '超时替人定了：底线通知');
  setOversightMode(db, { projectId: P, mode: 'full', userId: lead });
  eq(oversightMode(db, P), 'full', '项目单独设了逐项审批：用项目的');
  eq(tierOf(db, 'plan_changed', { projectId: P }), 'decide', '逐项审批：计划自己改了 → 决策');
  eq(tierOf(db, 'housekeeping', { projectId: P }), 'notify', '逐项审批：系统小修 → 通知');
  setOversightMode(db, { projectId: P, mode: null, userId: lead });
  eq(oversightMode(db, P), 'exception', '清掉项目设置：回到部署默认');
  throwsWith(() => setOversightMode(db, { projectId: P, mode: 'yolo', userId: lead }), /监督模式只有/, '不认识的模式拒收');
  setSetting(db, { key: 'deploy.oversight_mode', value: 'spot', userId: lead });
  for (const cls of ['contract', 'signoff', 'conflict', 'budget', 'security_approval', 'handback']) {
    if (Object.keys(MODES).some((m) => { setSetting(db, { key: 'deploy.oversight_mode', value: m, userId: lead }); return tierOf(db, cls, { projectId: P }) !== 'decide'; })) bad(`${cls}：某个模式下不是决策`);
  }
  setSetting(db, { key: 'deploy.oversight_mode', value: 'spot', userId: lead });
  ok('契约 / 签收 / 冲突 / 花钱 / 安全审批 / 交回的故障：三种模式下都是决策');
}

section('③ 个人偏好');
{
  setSignalPref(db, { userId: alice.id, cls: 'others_changed', tier: 'record' });
  eq(personalTier(db, alice.id, 'others_changed', 'notify'), 'record', '别人动了你的事：自己调成备案');
  eq(personalTier(db, bob.id, 'others_changed', 'notify'), 'notify', '别人没调：照项目档');
  throwsWith(() => setSignalPref(db, { userId: alice.id, cls: 'timeout', tier: 'record' }), /不能调成备案/, '超时替人定了：调不成备案（不许静默）');
  throwsWith(() => setSignalPref(db, { userId: alice.id, cls: 'progress', tier: 'decide' }), /只能在「通知」和「备案」之间选/, '个人调不成决策');
  setSignalPref(db, { userId: bob.id, cls: 'progress', tier: 'notify' });
  eq(personalTier(db, bob.id, 'progress', 'record'), 'notify', '每步进度：项目是备案，自己要通知 → 通知');
  eq(personalTier(db, alice.id, 'signoff', 'decide'), 'decide', '决策档个人改不动');
  setSignalPref(db, { userId: bob.id, cls: 'progress', tier: 'record' });
  const stalled = emitSignal(db, 'progress.project_stalled', { to: [bob.id], projectId: P, title: 'stalled', text: 'x' });
  eq(db.one(`SELECT tier FROM signal_recipients WHERE signal_id=? AND user_id=?`, stalled?.id ?? stalled, bob.id)?.tier, 'notify', '进度调成只记录：项目停下来等人照样推（不受个人偏好影响）');
  db.run(`UPDATE signals SET pushed_at=? WHERE id=?`, t0, stalled.id);   // 不留给 ④ 的发件箱那一轮
  setSignalPref(db, { userId: bob.id, cls: 'progress', tier: null });
  eq(personalTier(db, bob.id, 'progress', 'record'), 'record', '清掉偏好：跟项目');
}

section('④ 发件箱');
{
  const task = mkTask();
  const s1 = emitSignal(db, 'answer.overridden', { to: [alice.id, bob.id], taskId: task, title: 't1', text: 'x' });
  eq(s1.recipients.map((r) => r.tier).sort(), ['notify', 'record'], 'alice 调成了备案、bob 通知');
  eq(await round(), ['bob'], '只推 bob（alice 只留记录）');
  eq(await round(), [], '再推一轮：不重复');
  eq(signalsFor(db, alice.id).map((s) => [s.title, s.tier]), [['t1', 'record']], 'alice 的通知列表里查得到（备案）');
  const s2 = emitSignal(db, 'answer.overridden', { to: [alice.id], taskId: task, title: 't2', text: 'x' });
  eq(db.one(`SELECT pushed_at IS NOT NULL AS p FROM signals WHERE id=?`, s2.id).p, 1, '全员备案：当场标为不用推');
  // 没人有个人通道 → 部署通道
  const noCh = newId('u');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,'member','[]',?)`, noCh, 'nochan', t0);
  emitSignal(db, 'deploy.catalog', { to: [noCh], title: 't3', text: 'x' });
  eq(await round({ env: { NTFY_URL: 'https://ntfy.example/deploy' } }), ['deploy'], '收件人没配个人通道：退到部署通道');
  emitSignal(db, 'deploy.invariants', { to: ['admins'], title: 't4', text: 'x' });
  eq(await round(), ['admin2', 'lead'], '部署健康推给全体管理员（原来只推最早的一位）');
  // 两个进程同时推：至多一次
  emitSignal(db, 'answer.superseded', { to: [bob.id], taskId: task, title: 't5', text: 'x' });
  pushed.length = 0;
  await Promise.all([deliverSignals(db, { env: {}, fetchFn }), deliverSignals(db, { env: {}, fetchFn })]);
  eq(pushed.map((p) => p.to), ['bob'], '两路同时推：bob 只收到一次');
  // 停用的人不收
  db.run(`UPDATE users SET disabled_at=? WHERE id=?`, t0, noCh);
  eq(emitSignal(db, 'answer.superseded', { to: [noCh], taskId: task, title: 't6', text: 'x' }).recipients, [], '停用的人不在收件人里');
  await round();
  throwsWith(() => emitSignal(db, 'no.such', { to: [bob.id], title: 'x', text: 'x' }), /没有登记的信号/, '没登记的信号名拒收');
}

section('⑤ 原来的假通知');
{
  applyTemplate(db, { key: '', name: 'peer_review', userId: lead });
  {
    const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
    for (const r of rules) if (r.decision_type === 'spec_choice') Object.assign(r, { recipients: [`user:${alice.id}`, `user:${bob.id}`], quorum: '1', conflict_policy: 'block' });
    saveRules(db, { key: '', rules, userId: lead });
  }
  const task = mkTask({ project: null });   // 独立任务走默认路由表
  const mkQ = (type = 'spec_choice') => {
    const id = newId('q');
    db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,status) VALUES (?,?,2,'classifier','要 A 还是 B？','按 A',?,'open')`, id, task, t0);
    db.tx(() => routeQuestion(db, { questionId: id, decisionType: type, typeSource: 'hard_rule', at: t0 }));
    return id;
  };
  const q = mkQ();
  const to = JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, q).addressed_to);
  const answerer = [alice, bob].find((u) => to.includes(u.id));
  if (!answerer) bad('路由没有把 alice / bob 列为收件人', JSON.stringify(to));
  else {
    // 负责人与答复人答得不一样：负责人当场定案，答复人被覆盖
    recordAnswer(db, { questionId: q, body: 'A', plaintextToken: answerer.plaintext });
    const st = db.one(`SELECT status FROM questions WHERE id=?`, q).status;
    if (st === 'open') {
      recordAnswer(db, { questionId: q, body: '用 B', plaintextToken: owner.plaintext });
      const s = db.one(`SELECT * FROM signals WHERE name='answer.overridden' AND ref=?`, q);
      assert(!!s, '负责人覆盖：进了发件箱');
      eq(db.all(`SELECT user_id FROM signal_recipients WHERE signal_id=?`, s?.id).map((r) => r.user_id), [answerer.id], '覆盖的通知给被覆盖的人');
    } else {
      // 先答生效：迟到的不同意见
      const late = [alice, bob].find((u) => u.id !== answerer.id && to.includes(u.id));
      if (late) {
        const r = recordAnswer(db, { questionId: q, body: '我觉得 B', plaintextToken: late.plaintext });
        assert(r.late, '已决之后再答：记为迟到意见');
        const s = db.one(`SELECT * FROM signals WHERE name='answer.late_dissent' AND ref=?`, q);
        assert(!!s, '迟到异议：进了发件箱（原来只写了审计里的 notify 名单）');
        eq(db.all(`SELECT user_id FROM signal_recipients WHERE signal_id=? ORDER BY user_id`, s?.id).map((r) => r.user_id).sort(), [lead, answerer.id].sort(), '推给负责人与生效答复的作者');
      } else ok('（路由只有一位收件人：迟到异议这条跳过）');
    }
  }
  // 要两人都答（quorum all）：alice 答了、还开着，负责人答了不一样的 → 当场定案、alice 被覆盖
  {
    const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
    for (const r of rules) if (r.decision_type === 'spec_choice') r.quorum = 'all';
    saveRules(db, { key: '', rules, userId: lead });
  }
  const q2 = mkQ();
  recordAnswer(db, { questionId: q2, body: 'A', plaintextToken: alice.plaintext });
  recordAnswer(db, { questionId: q2, body: '用 B', plaintextToken: owner.plaintext });
  const so = db.one(`SELECT * FROM signals WHERE name='answer.overridden' AND ref=?`, q2);
  assert(!!so, '负责人覆盖：进了发件箱');
  eq(db.all(`SELECT user_id FROM signal_recipients WHERE signal_id=?`, so?.id).map((r) => r.user_id), [alice.id], '覆盖的通知给被覆盖的 alice');
}

section('⑥ 超时替人定了');
{
  const task = mkTask();
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,timeout_at,status,addressed_to) VALUES (?,?,1,'classifier','用哪个端口？','用 3000',?,?,'open',?)`, id, task, t0, t0 + 1000, JSON.stringify([bob.id]));
  const id2 = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,timeout_at,status,addressed_to) VALUES (?,?,2,'classifier','用哪个库？','用 x',?,?,'open',?)`, id2, task, t0, t0 + 1000, JSON.stringify([alice.id]));
  sweepTimeouts(db, { at: t0 + 2000 });
  const d = db.one(`SELECT * FROM signals WHERE name='timeout.defaulted' AND ref=?`, id);
  assert(!!d, 'Ⅰ 级按默认结案：进了发件箱（原来完全不推）');
  eq(db.all(`SELECT user_id, tier FROM signal_recipients WHERE signal_id=? ORDER BY user_id`, d?.id).map((r) => [r.user_id, r.tier]).sort(), [[bob.id, 'notify'], [lead, 'notify']].sort(), '推给原来该答的人 + 任务负责人');
  assert(/用 3000/.test(d?.text ?? ''), '正文说了按什么默认定的');
  const e = db.one(`SELECT * FROM signals WHERE name='timeout.escalated' AND ref=?`, id2);
  assert(!!e, 'Ⅱ 级升级：进了发件箱（原来只推部署通道）');
  sweepTimeouts(db, { at: t0 + 2000 });
  eq(db.one(`SELECT count(*) n FROM signals WHERE ref IN (?,?)`, id, id2).n, 2, '再扫一遍：不重复记');
  // 例外管理 + 个人偏好也调不掉
  setSetting(db, { key: 'deploy.oversight_mode', value: 'exception', userId: lead });
  db.run(`UPDATE users SET signal_prefs='{"timeout":"record"}' WHERE id=?`, bob.id);   // 绕过校验硬写：解析时底线照样兜住
  const id3 = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,timeout_at,status,addressed_to) VALUES (?,?,1,'classifier','q3','d3',?,?,'open',?)`, id3, task, t0, t0 + 1000, JSON.stringify([bob.id]));
  sweepTimeouts(db, { at: t0 + 3000 });
  eq(db.one(`SELECT r.tier FROM signal_recipients r JOIN signals s ON s.id=r.signal_id WHERE s.ref=? AND r.user_id=?`, id3, bob.id)?.tier, 'notify', '例外管理 + 个人硬写成备案：底线仍是通知');
  db.run(`UPDATE users SET signal_prefs='{}' WHERE id=?`, bob.id);
  setSetting(db, { key: 'deploy.oversight_mode', value: 'spot', userId: lead });
  await round();
}

section('⑦ 事项推送：知会人');
{
  const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  for (const r of rules) if (r.decision_type === 'spec_choice') r.recipients = [`user:${bob.id}`, `inform:user:${alice.id}`];
  saveRules(db, { key: '', rules, userId: lead });
  db.run(`UPDATE users SET signal_prefs='{}' WHERE id=?`, alice.id);
  const task = mkTask({ project: null });
  const q = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,status) VALUES (?,?,2,'classifier','选哪个？','A',?,'open')`, q, task, t0);
  db.tx(() => routeQuestion(db, { questionId: q, decisionType: 'spec_choice', typeSource: 'hard_rule', at: t0 }));
  eq(JSON.parse(db.one(`SELECT informed FROM questions WHERE id=?`, q).informed), [alice.id], 'alice 是知会人');
  pushed.length = 0;
  await notifyPendingQuestions(db, { env: {}, fetchFn });
  const byWho = Object.fromEntries(pushed.map((p) => [p.to, p.title]));
  assert(/在等你/.test(byWho.bob ?? ''), '收件人的标题：在等你', byWho.bob);
  assert(/^\[SuperIntern\] 通知：.*不用你答/.test(byWho.alice ?? ''), '知会人的标题：通知……不用你答（原来也写"在等你"）', byWho.alice);
  setSignalPref(db, { userId: alice.id, cls: 'spec_choice', tier: 'record' });
  const q2 = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,status) VALUES (?,?,2,'classifier','再选？','A',?,'open')`, q2, task, t0);
  db.tx(() => routeQuestion(db, { questionId: q2, decisionType: 'spec_choice', typeSource: 'hard_rule', at: t0 }));
  pushed.length = 0;
  await notifyPendingQuestions(db, { env: {}, fetchFn });
  eq(pushed.map((p) => p.to).sort(), ['bob'], '知会人把这一类调成备案：不推 alice，收件人照推');
  pushed.length = 0;
  await Promise.all([notifyPendingQuestions(db, { env: {}, fetchFn }), notifyPendingQuestions(db, { env: {}, fetchFn })]);
  eq(pushed.length, 0, '已推过的：两路同时扫也不重推');
}

section('⑧ 默认能不能生效：类型 + 级别一处判定');
{
  const task = mkTask({ project: null });
  const mk = (level, type, def) => {
    const id = newId('q');
    db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,?,'classifier','x',?,?,?,'open')`, id, task, level, def, t0, t0 + 1000);
    db.tx(() => routeQuestion(db, { questionId: id, decisionType: type, typeSource: 'hard_rule', at: t0 }));
    return db.one(`SELECT level, default_action FROM questions WHERE id=?`, id);
  };
  eq(mk(2, 'structural', '撤销改动后重交'), { level: 2, default_action: null }, '结构矛盾（系统代填的也一样）：默认被清掉，不会 8 小时后替人撤销改动');
  eq(mk(1, 'security', '不同意'), { level: 2, default_action: null }, '安全审批给了 Ⅰ 级 + 默认：清掉默认、升成 Ⅱ 级（Ⅰ 级必须有默认）');
  eq(mk(2, 'spec_choice', '按 A'), { level: 2, default_action: '按 A' }, '规格取舍：默认照留');
  // 旧库存的路由表没有 security 的行：借"系统卡住"那几行
  const saved = rulesOf(db, '').filter((r) => !String(r.id).startsWith('derived:')).map(({ id, project_id, template, created_at, ...r }) => r).filter((r) => r.decision_type !== 'security');
  db.run(`DELETE FROM routing_rules WHERE project_id=''`);
  for (const r of saved) db.run(`INSERT INTO routing_rules (id,project_id,decision_type,scope,position,recipients,quorum,conflict_policy,timeout_action,timeout_after,created_at) VALUES (?,'',?,?,?,?,?,?,?,?,?)`,
    newId('rr'), r.decision_type, r.scope, r.position, JSON.stringify(r.recipients), r.quorum, r.conflict_policy, r.timeout_action, r.timeout_after, t0);
  const sec = rulesOf(db, '').filter((r) => r.decision_type === 'security');
  eq(sec.map((r) => r.recipients), rulesOf(db, '').filter((r) => r.decision_type === 'ops').map((r) => r.recipients), '旧表缺安全审批：按"系统卡住"的行派人');
}

section('⑨ 监督模式改变行为：AI 自己定的做法、计划自己改了');
{
  const choose = (taskId, subject, statement) => db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at)
    VALUES (?,?,NULL,?,?,'active','settled_by_me','查过 spec 与仓库，都没写',1,?,?)`, newId('as'), taskId, subject, statement, t0, t0);
  const withMode = (mode) => { setOversightMode(db, { projectId: P, mode, userId: lead }); const t = mkTask(); choose(t, 'frontend.priority.label', '优先级显示为 低/中/高'); return t; };

  let t = withMode('full');
  let r = raiseChoiceReviews(db, { taskId: t });
  const q = db.one(`SELECT id, default_action FROM questions WHERE id=?`, r[0]?.questionId);
  eq([r.length, r[0]?.blocking, q?.default_action], [1, true, null], '逐项审批：挂一条过目事项，不带默认（不会到期替人"沿用"）');
  eq(choicesHolding(db, t), true, '逐项审批：没答之前这个任务不合并');
  db.run(`UPDATE questions SET status='answered' WHERE id=?`, q.id);
  eq(choicesHolding(db, t), false, '答了就放行合并');

  t = withMode('spot');
  r = raiseChoiceReviews(db, { taskId: t });
  eq([r.length, r[0]?.blocking, !!db.one(`SELECT default_action FROM questions WHERE id=?`, r[0]?.questionId)?.default_action, choicesHolding(db, t)], [1, false, true, false], '抽检：不挡路的过目事项，到期按默认了结');

  t = withMode('exception');
  r = raiseChoiceReviews(db, { taskId: t });
  const sig = db.one(`SELECT s.id, r.tier FROM signals s JOIN signal_recipients r ON r.signal_id=s.id WHERE s.name='choices.made' AND s.task_id=?`, t);
  eq([r.length, db.one(`SELECT count(*) n FROM questions WHERE task_id=?`, t).n, sig?.tier], [0, 0, 'record'], '例外管理：不挂事项，只留一条备案');
  eq(raiseChoiceReviews(db, { taskId: t }).length + db.one(`SELECT count(*) n FROM signals WHERE name='choices.made' AND task_id=?`, t).n, 1, '幂等：同一批选择不重复记');

  // 例外管理：Ⅰ 级规格取舍按默认直接走（下一轮超时扫描结案），事后告诉人；Ⅱ 级照常等人；抽检下 Ⅰ 级照常等时限
  const ask = (taskId, level, def) => {
    const id = newId('q');
    db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,?,'classifier','用 A 还是 B',?,?,?,'open')`, id, taskId, level, def, t0, t0 + 1800_000);
    db.tx(() => routeQuestion(db, { questionId: id, decisionType: 'spec_choice', typeSource: 'hard_rule', at: t0 }));
    return id;
  };
  setOversightMode(db, { projectId: P, mode: 'exception', userId: lead });
  const ft = mkTask();
  const q1 = ask(ft, 1, '用 A'), q2 = ask(ft, 2, '用 A');
  eq(db.one(`SELECT timeout_at FROM questions WHERE id=?`, q1).timeout_at, t0, '例外管理：Ⅰ 级规格取舍不等人（到期时刻 = 提出时刻）');
  eq(db.one(`SELECT timeout_at FROM questions WHERE id=?`, q2).timeout_at, t0 + 1800_000, '例外管理：Ⅱ 级照常等人');
  const sw = sweepTimeouts(db, { taskId: ft, at: t0 + 1000 });
  eq([sw.defaulted.map((d) => d.questionId), db.one(`SELECT status FROM questions WHERE id=?`, q1).status], [[q1], 'defaulted'], '下一轮扫描按默认结案');
  const body = db.one(`SELECT m.body FROM messages m JOIN edges e ON e.from_id=m.id WHERE e.to_id=? AND e.relation='answers'`, q1)?.body ?? '';
  assert(body.startsWith('[按默认直接走]'), '系统写的答复说清楚是按默认直接走、不是超时', body.slice(0, 60));
  eq(db.one(`SELECT s.class, r.tier FROM signals s JOIN signal_recipients r ON r.signal_id=s.id WHERE s.name='question.auto_defaulted' AND s.ref=?`, q1), { class: 'timeout', tier: 'notify' }, '事后通知（系统替人定了：底线通知，个人静音不了）');
  eq(db.one(`SELECT count(*) n FROM signals WHERE name='timeout.defaulted' AND ref=?`, q1).n, 0, '不再发"没人答"');
  setOversightMode(db, { projectId: P, mode: 'spot', userId: lead });
  eq(db.one(`SELECT timeout_at FROM questions WHERE id=?`, ask(mkTask(), 1, '用 A')).timeout_at, t0 + 1800_000, '抽检：Ⅰ 级照常等时限');

  const gt = mkTask();
  setOversightMode(db, { projectId: P, mode: 'spot', userId: lead });
  eq(gateOf(db, { taskId: gt, rev: { impact: [], salvage: [] }, nodes: [] }).gate, null, '抽检：不碰契约、没过线的计划改动直接生效');
  setOversightMode(db, { projectId: P, mode: 'full', userId: lead });
  assert(/逐项审批/.test(gateOf(db, { taskId: gt, rev: { impact: [], salvage: [] }, nodes: [] }).gate ?? ''), '逐项审批：同一处改动也要人批');
  setOversightMode(db, { projectId: P, mode: null, userId: lead });
}

section('⑩ 看板接口：我的通知、偏好、监督模式、审批门禁');
{
  const HOME = mkdtempSync(join(tmpdir(), 'si-signals-'));
  const PUB = 'si.sig.lan';
  const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100, team: true, publicUrl: `https://${PUB}`, runtime: { current: () => null } });
  const call = (method, path, tok, body = null) => new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const r = request({ host: '127.0.0.1', port: w.port, method, path, headers: { host: PUB, origin: `https://${PUB}`, 'x-superintern-token': tok, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  try {
    emitSignal(db, 'answer.overridden', { to: [alice.id], title: 'x', text: 'y' });
    let r = await call('GET', '/api/me/signals', alice.plaintext);
    assert(r.status === 200 && r.body.items.length > 0 && r.body.unread > 0, '我的通知：列得出、带未读数');
    r = await call('POST', '/api/me/signals/read', alice.plaintext, { all: true });
    eq([r.status, (await call('GET', '/api/me/signals', alice.plaintext)).body.unread], [200, 0], '全部标为已读');
    eq((await call('GET', '/api/me/signals', bob.plaintext)).body.items.some((s) => s.title === 'x'), false, '别人的通知看不到');
    eq((await call('POST', '/api/me/signal-prefs', alice.plaintext, { cls: 'timeout', tier: 'record' })).status, 400, '偏好：底线是通知的调不成备案（400）');
    r = await call('POST', '/api/me/signal-prefs', alice.plaintext, { cls: 'progress', tier: 'notify' });
    eq([r.status, personalTier(db, alice.id, 'progress', 'record')], [200, 'notify'], '偏好：调自己的');
    eq((await call('POST', `/api/projects/${P}/oversight`, alice.plaintext, { mode: 'full' })).status, 403, '监督模式：只有项目负责人能改');
    eq([(await call('POST', `/api/projects/${P}/oversight`, owner.plaintext, { mode: 'full' })).status, oversightMode(db, P)], [200, 'full'], '监督模式：负责人改');
    eq((await call('POST', `/api/projects/${P}/oversight`, owner.plaintext, { mode: null })).status, 200, '监督模式：改回跟部署默认');
    eq((await call('POST', `/api/projects/${P}/gates`, alice.plaintext, { commands: [] })).status, 403, '审批门禁：只有项目负责人能改');
    eq((await call('POST', `/api/projects/${P}/gates`, owner.plaintext, { commands: ['git push*'], expect: [] })).status, 200, '审批门禁：负责人保存');
    r = await call('POST', `/api/projects/${P}/gates`, owner.plaintext, { commands: ['npm publish*'], expect: [] });
    eq([r.status, r.body.conflict, gatesOf(db, P).commands], [409, true, ['git push*']], '审批门禁：打开页面后别人改过 → 409，不覆盖');
    eq((await call('POST', `/api/projects/${P}/gates`, owner.plaintext, { commands: ['*'] })).status, 400, '审批门禁：单独一个 * 拒收');
    r = await call('POST', `/api/projects/${P}/gates`, owner.plaintext, { test: `sh -c "npm i && psql -c 'ALTER TABLE t ADD x int'"`, commands: ['psql*'] });
    eq([r.status, r.body.hit, gatesOf(db, P).commands], [200, 'psql*', ['git push*']], '试一条命令：拿没保存的清单比（包在 sh -c 里、&& 后面的也认得出），不保存');
    eq((await call('POST', `/api/projects/${P}/gates`, owner.plaintext, { test: 'git status' })).body.hit, null, '试一条命令：没命中');
    for (const test of [`PGPASSWORD=x psql -c 'ALTER TABLE t ADD x int'`, '/usr/bin/psql -f m.sql', 'env PGHOST=db psql', `sh -c "cd db && PGUSER='a b' /opt/pg/bin/psql"`]) {
      eq((await call('POST', `/api/projects/${P}/gates`, owner.plaintext, { test, commands: ['psql*'] })).body.hit, 'psql*', `换个写法也拦得住：${test}`);
    }
    const pv = (await call('GET', '/api/projects', owner.plaintext)).body;
    const proj = (pv.projects ?? pv).find((x) => x.id === P);
    eq(proj?.gateRoute?.who?.[0]?.k, 'lead', '门禁命中派给谁：项目里没配安全审批的行 → 负责人');
    r = await call('GET', '/api/me/signals', alice.plaintext);
    eq([r.body.items.find((s) => s.name === 'answer.overridden')?.classLabel, typeof r.body.prefs], ['别人动了你的事', 'object'], '每条通知带上它归哪一类（看板上给"这一类以后不推送给我"）');
    setOversightMode(db, { projectId: P, mode: 'full', userId: lead });
    eq((await call('GET', '/api/me/signal-prefs', owner.plaintext)).body.projects?.map((p) => [p.id, p.mode]), [[P, 'full']], '我的通知：列出没跟部署默认走的项目（表里那一列在那里不准）');
    setOversightMode(db, { projectId: P, mode: null, userId: lead });
    r = await call('POST', '/api/me/push-prefs', alice.plaintext, { prefs: { start: 20, end: 24, every: 30 } });
    const pv2 = (await call('GET', '/api/me/signal-prefs', alice.plaintext)).body.push;
    eq([r.status, pv2.own, pv2.prefs.start, pv2.prefs.cap, typeof pv2.week.pushes], [200, { start: 20, end: 24, every: 30 }, 20, pv2.deploy.cap, 'number'], '推送节奏：存自己的，没设的跟部署默认，带最近 7 天统计');
    eq((await call('GET', '/api/me/signal-prefs', bob.plaintext)).body.push.own, {}, '推送节奏：别人的设置不受影响');
    r = await call('POST', '/api/me/push-prefs', alice.plaintext, { prefs: { start: 9, end: 9 } });
    eq([r.status, /同一个钟点/.test(r.body?.error ?? '')], [400, true], '推送节奏：开始和结束同一个钟点拒收（400）');
    r = await call('POST', '/api/me/push-prefs', alice.plaintext, { prefs: { start: null, end: null, every: null } });
    eq((await call('GET', '/api/me/signal-prefs', alice.plaintext)).body.push.own, {}, '推送节奏：改回跟部署默认');
  } finally { await w.close?.(); try { rmSync(HOME, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } }
}

section('⑪ 联网被拦 / 凭据注入：一个任务攒成一条「系统小修」');
{
  const { ingestEgressAudit } = await import('../src/core/egress.mjs');
  const { mkdtempSync, writeFileSync, rmSync: rm } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'si-egress-'));
  setOversightMode(db, { projectId: P, mode: 'full', userId: lead });   // 逐项审批：系统小修是通知档，进推送队列
  const task = mkTask();
  const run = (n, rows) => { const file = join(dir, `a${n}.jsonl`); writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n')); return ingestEgressAudit(db, { taskId: task, auditFile: file }); };
  const mine = () => db.all(`SELECT * FROM signals WHERE name='fix.egress_summary' AND task_id=? ORDER BY created_at, rowid`, task);
  run(1, [{ allowed: false, host: 'evil.example' }, { allowed: false, host: 'registry.npmjs.org' }, { allowed: true, host: 'x' }]);
  eq(mine().length, 1, '第一次沙箱收工：一条');
  run(2, [{ allowed: false, host: 'registry.npmjs.org' }, { allowed: true, action: 'injected', cred_rule: 'github' }]);
  const s1 = mine();
  eq(s1.length, 1, '第二次：还没推、没人看 → 改写同一条，不另起');
  assert(/被拦 3 次/.test(s1[0].title) && /替它带凭据 1 次/.test(s1[0].title) && /registry\.npmjs\.org ×2/.test(s1[0].text) && /github ×1/.test(s1[0].text), '正文是到现在为止的累计（按域、按规则）', s1[0].title + ' / ' + s1[0].text);
  const q = db.all(`SELECT title, sent_at FROM push_queue WHERE source='signal' AND source_id=?`, s1[0].id);
  assert(q.length > 0 && q.every((r) => r.sent_at === null && /被拦 3 次/.test(r.title)), '推送队列里没推的那几行一起改了', JSON.stringify(q));
  db.run(`UPDATE signal_recipients SET read_at=? WHERE signal_id=?`, t0, s1[0].id);
  run(3, [{ allowed: false, host: 'evil.example' }]);
  eq(mine().length, 2, '上一条有人看过了 → 另起一条');
  assert(/被拦 4 次/.test(mine()[1].title), '新的一条照样写累计', mine()[1].title);
  setOversightMode(db, { projectId: P, mode: null, userId: lead });
  try { rm(dir, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
