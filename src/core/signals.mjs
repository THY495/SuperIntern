// 信号分级与介入方式：系统里每一件"该让人知道 / 该让人拿主意"的事都是一个信号。
//
// 三档介入方式（human-in / on / out-of-the-loop）：
//   决策 decide —— 阻塞，等人拍板。它就是一条事项（questions），推送、超时、路由都走事项那一套。
//   通知 notify —— 不阻塞，推给人。
//   备案 record —— 不阻塞、不推，只留记录（看板上查得到）。
//
// 谁决定是哪一档：
//   ① 项目的监督模式（逐项审批 / 抽检 / 例外管理）给每一类信号一个默认档；没单独设的项目用部署默认（deploy.oversight_mode）。
//      会不会阻塞（决策 vs 不阻塞）只由这一层定 —— 那影响 AI 停不停、别人等不等，归项目负责人。
//   ② 个人偏好只能在"通知 ↔ 备案"之间调**自己**收不收推送，改不了别人要拍板的事。
//   ③ 底线：契约 / 签收 / 冲突 / 花钱 / 安全审批 / 交回给人的故障，以及一切 Ⅲ 级事项，底线是决策；
//      超时替人定了、以你的名义对外动作、安全边界被系统改了、部署出故障，底线是通知（不许静默）。偏好只能在底线之上调。
//
// 不成为事项的信号一律经 emitSignal 进发件箱（signals / signal_recipients），推送由 deliverSignals 认领后发 ——
// 守护进程每拍、cli tick、编排器收尾时都会调；认领在事务里，同一条至多推一次。
// 推送通道（notify.mjs 的 notify）只许这个模块调用（tests/signals.test.mjs 钉住）：每一次推送都说得出它是哪一类、按什么档推的。

import { mailReady } from './smtp.mjs';
import { itemLink } from './links.mjs';
import { newId, now, audit } from '../db/db.mjs';
import { updateUser } from '../db/users.mjs';
import { notify, channelsFromEnv } from './notify.mjs';
import { getSetting } from './settings.mjs';
import { getProjectParam, setProjectParam } from './params.mjs';
import { N_, I18nError, tl, contentLang } from '../i18n/index.mjs';
import { enqueuePush, deliverPushes, signalUrgency, reachable, revisePending } from './push-queue.mjs';

export const TIERS = { decide: N_('决策'), notify: N_('通知'), record: N_('备案') };
const RANK = { record: 0, notify: 1, decide: 2 };
const atLeast = (tier, floor) => (floor && RANK[floor] > RANK[tier] ? floor : tier);

export const MODES = {
  full: { label: N_('逐项审批'), blurb: N_('AI 自己定的做法、计划自己改的地方都要你点头；每一步的进展都推给你。适合想掌控每个细节的人。') },
  spot: { label: N_('抽检'), blurb: N_('该你拍板的事等你拍板；AI 自己定的做法、计划自己改的地方推给你看，不拦着它；每一步的进展只留记录。') },
  exception: { label: N_('例外管理'), blurb: N_('只在出了偏离常规的事时打扰你：不重要的规格取舍按 AI 提的默认直接走、事后告诉你；日常进展只留记录。') },
};
export const DEFAULT_MODE = 'spot';
export const OVERSIGHT_KEY = 'project.oversight_mode';

/**
 * 18 类信号。`full / spot / exception` 是三种监督模式下的默认档；`floor` 是底线（任何模式、任何个人偏好都不低于它）。
 * 进度一类按粒度再分（step 每步 / task 任务级 / attention 停滞与待交付），见 GRAIN。
 */
export const CLASSES = {
  contract:          { label: N_('契约与方案批准'),     full: 'decide', spot: 'decide', exception: 'decide', floor: 'decide' },
  signoff:           { label: N_('签收'),               full: 'decide', spot: 'decide', exception: 'decide', floor: 'decide' },
  conflict:          { label: N_('意见冲突'),           full: 'decide', spot: 'decide', exception: 'decide', floor: 'decide' },
  budget:            { label: N_('花钱的闸'),           full: 'decide', spot: 'decide', exception: 'decide', floor: 'decide' },
  security_approval: { label: N_('安全审批'),           full: 'decide', spot: 'decide', exception: 'decide', floor: 'decide' },
  handback:          { label: N_('交回给人的故障'),     full: 'decide', spot: 'decide', exception: 'decide', floor: 'decide' },
  // 例外管理下 Ⅰ 级按默认直接走、事后通知；Ⅱ 级仍决策（tierOf 里按级别分）
  spec_choice:       { label: N_('规格取舍'),           full: 'decide', spot: 'decide', exception: 'notify', floor: null },
  ai_choices:        { label: N_('AI 自己定的做法'),    full: 'decide', spot: 'notify', exception: 'record', floor: null },
  timeout:           { label: N_('系统替人定了（超时、按默认直接走）'), full: 'notify', spot: 'notify', exception: 'notify', floor: 'notify' },
  plan_changed:      { label: N_('计划自己改了'),       full: 'decide', spot: 'notify', exception: 'record', floor: null },
  auto_task:         { label: N_('自动挡下 AI 加的任务'), full: 'notify', spot: 'notify', exception: 'record', floor: null },
  auto_escalate:     { label: N_('AI 多花钱（自动升档）'), full: 'notify', spot: 'notify', exception: 'record', floor: null },
  external_action:   { label: N_('以你的名义对外动作'), full: 'notify', spot: 'notify', exception: 'notify', floor: 'notify' },
  security_changed:  { label: N_('安全边界被系统改了'), full: 'notify', spot: 'notify', exception: 'notify', floor: 'notify' },
  others_changed:    { label: N_('别人动了你的事'),     full: 'notify', spot: 'notify', exception: 'notify', floor: null },
  progress:          { label: N_('进度'),               full: 'notify', spot: 'notify', exception: 'record', floor: null },
  deploy_health:     { label: N_('部署健康'),           full: 'notify', spot: 'notify', exception: 'notify', floor: 'notify' },
  housekeeping:      { label: N_('系统小修'),           full: 'notify', spot: 'record', exception: 'record', floor: null },
};
/** 进度按粒度的默认档（停滞、待交付在例外管理下也要通知：那正是"偏离常规"）。 */
const GRAIN = {
  step: { full: 'notify', spot: 'record', exception: 'record' },
  task: { full: 'notify', spot: 'notify', exception: 'record' },
  attention: { full: 'notify', spot: 'notify', exception: 'notify' },
};

/** 事项的决策类型 → 信号类。事项本身就是"决策"档；这张表给知会人的推送、给统计用。 */
export const QUESTION_CLASS = {
  spec_choice: 'spec_choice', structural: 'contract', contract_approval: 'contract', signoff: 'signoff', budget: 'budget',
  egress: 'security_approval', security: 'security_approval', delivery: 'handback', conflict: 'conflict', ops: 'handback',
};

/**
 * 信号登记表：每个产生点用的信号名 → 类（及粒度）。不在表里的名字 emitSignal 拒收。
 * class: null 的是汇总通道（摘要）：内容是别的信号与事项的汇总，各自已经分过级，这里不再分。
 */
export const SIGNALS = {
  // 事项（决策档）的推送：收件人那一份；知会人那一份按所属类、可被个人调成备案
  'question.addressed': { class: null, note: '事项本身（决策）：按决策类型归类，见 QUESTION_CLASS' },
  'question.informed': { class: null, note: '事项的知会人：按决策类型归类，见 QUESTION_CLASS' },
  // 9 超时替人定了
  'timeout.defaulted': { class: 'timeout' },
  'question.auto_defaulted': { class: 'timeout', note: '例外管理下Ⅰ级规格取舍按默认直接走：也是系统替人定了，底线通知（归规格取舍的话个人能静音）' },
  'timeout.escalated': { class: 'timeout', urgent: true },   // 现在轮到收件人答了：紧急
  'timeout.rerouted': { class: 'timeout' },
  'timeout.stuck': { class: 'timeout', urgent: true },
  // 15 别人动了你的事
  'answer.superseded': { class: 'others_changed' },
  'answer.overridden': { class: 'others_changed' },
  'answer.late_dissent': { class: 'others_changed' },
  'answer.abstained': { class: 'others_changed' },
  'handover.digest': { class: 'others_changed', note: '交接给你的清单：接手人推送（直推，不进发件箱）' },
  // 16 进度
  'run.report': { class: 'progress', grain: 'step' },
  'run.complete': { class: 'progress', grain: 'task' },
  'run.hard_failed': { class: 'progress', grain: 'attention' },
  'project.awaiting_delivery': { class: 'progress', grain: 'attention' },
  // 17 部署健康
  'deploy.catalog': { class: 'deploy_health' },
  'deploy.runtime_down': { class: 'deploy_health' },
  'deploy.llm_health': { class: 'deploy_health' },
  'deploy.invariants': { class: 'deploy_health' },
  'deploy.refused_bind': { class: 'deploy_health' },
  'deploy.mail_inbound': { class: 'deploy_health' },   // 邮件答复收不到信：从好到坏 / 从坏到好各告诉管理员一次
  'run.sandbox_error': { class: 'deploy_health' },
  'run.provider_error': { class: 'deploy_health' },
  // 8 AI 自己定的做法（例外管理：不挂过目事项，只留记录；其余模式是事项，见 choices.mjs）
  'choices.made': { class: 'ai_choices' },
  // 10 计划自己改了
  'plan.revised': { class: 'plan_changed' },
  // 系统自动补的步骤（契约覆盖、截图说明、截图样例数据）是批过的契约推出来的：拒了它契约就覆盖不全 / 截不了图，
  // 所以逐项审批下也只通知、不拦（cap）
  'plan.step_added': { class: 'plan_changed', cap: 'notify' },
  // 11 自动挡下 AI 加的任务
  // 定时任务、带标签的 issue 起草出来的也走这里（自动挡下落地时）；提议挡下它们成了批准事项，不另发
  'auto.tasks_added': { class: 'auto_task' },
  // 12 AI 多花钱
  'auto.escalated': { class: 'auto_escalate' },
  // 13 以你的名义对外动作（推给交付人）
  'external.ci_fix_started': { class: 'external_action' },
  'external.redelivered': { class: 'external_action' },
  'external.review_fix': { class: 'external_action' },
  // 14 安全边界被系统改了
  'security.mcp_changed': { class: 'security_changed' },
  'security.hook_failed_open': { class: 'security_changed' },
  'security.egress_defaults': { class: 'security_changed' },
  // 16 进度
  'progress.task_merged': { class: 'progress', grain: 'task' },
  'progress.project_stalled': { class: 'progress', grain: 'attention' },
  // 18 系统小修
  'fix.build_output_discarded': { class: 'housekeeping' },
  'fix.drift_noted': { class: 'housekeeping' },
  'fix.preview_skipped': { class: 'housekeeping' },
  'fix.egress_summary': { class: 'housekeeping' },   // 联网被拦 / 凭据注入：一个任务攒成一条
  // 汇总
  'push.digest': { class: null, note: '汇总推送：不紧急的攒成一条，内容各自已分级' },
  'digest.todo': { class: null, note: '待办摘要（定时 / 换班 / 手动）：汇总通道，内容各自已分级' },
  'report.status': { class: null, note: '状态报告：按人定期发，走推送队列、单条推；内容是已经发生的事，各自已分级' },
};

const known = (name) => SIGNALS[name] ?? (() => { throw new I18nError('没有登记的信号：{name}', { name }); })();

// ── 介入方式的解析 ──────────────────────────────────────────────────────

/** 某项目当前的监督模式（项目设过用项目的，否则部署默认）。projectId 为空 = 部署默认。 */
export function oversightMode(db, projectId = null) {
  const own = projectId ? getProjectParam(db, projectId, OVERSIGHT_KEY) : null;
  if (MODES[own]) return own;
  const dep = getSetting(db, 'deploy.oversight_mode');
  return MODES[dep] ? dep : DEFAULT_MODE;
}

/** 项目负责人改监督模式。调用方核过权限（负责人或管理员）。null = 回到部署默认。 */
export function setOversightMode(db, { projectId, mode, userId }) {
  if (mode !== null && !MODES[mode]) throw new I18nError('监督模式只有这几种：{list}', { list: Object.keys(MODES).join(' / ') });
  return db.tx(() => {
    const before = getProjectParam(db, projectId, OVERSIGHT_KEY);
    setProjectParam(db, { projectId, key: OVERSIGHT_KEY, value: mode, by: { kind: 'user', id: userId }, governance: 'constitutional' });
    audit(db, { actorKind: 'user', actorId: userId, action: 'oversight_mode_set', targetType: 'project', targetId: projectId, payload: { from: before ?? null, to: mode } });
    return { mode: oversightMode(db, projectId), own: mode };
  });
}

/** 类在某监督模式下的默认档（未套底线）。 */
function defaultTier(cls, mode, { grain = null, level = null } = {}) {
  const c = CLASSES[cls];
  if (!c) throw new I18nError('没有这一类信号：{cls}', { cls });
  if (cls === 'progress' && grain) return GRAIN[grain][mode];
  if (cls === 'spec_choice' && mode === 'exception') return level === 1 ? 'notify' : 'decide';
  return c[mode];
}

/**
 * 项目层面的介入方式：这一类信号在这个项目里是决策（要成为事项、阻塞）还是通知 / 备案。
 * Ⅲ 级事项的底线是决策（level === 3）。
 */
export function tierOf(db, cls, { projectId = null, grain = null, level = null } = {}) {
  const mode = oversightMode(db, projectId);
  let t = atLeast(defaultTier(cls, mode, { grain, level }), CLASSES[cls].floor);
  if (level === 3) t = 'decide';
  return t;
}

/** 某人对各类信号的偏好（{类: 'notify'|'record'}）。 */
export function signalPrefsOf(db, userId) {
  try { const p = JSON.parse(db.one(`SELECT signal_prefs FROM users WHERE id=?`, userId)?.signal_prefs ?? '{}'); return p && typeof p === 'object' ? p : {}; } catch { return {}; }
}

/** 改自己的偏好：tier 为 null = 跟随项目。底线是通知的类调不成备案；决策档调不动（那不是个人的事）。 */
export function setSignalPref(db, { userId, cls, tier }) {
  const c = CLASSES[cls];
  if (!c) throw new I18nError('没有这一类信号：{cls}', { cls });
  if (tier !== null && tier !== 'notify' && tier !== 'record') throw new I18nError('个人只能在「通知」和「备案」之间选');
  if (tier === 'record' && c.floor) throw new I18nError('「{label}」不能调成备案：这一类不许静默', { label: tl(contentLang(db), c.label) });
  return db.tx(() => {
    const prefs = signalPrefsOf(db, userId);
    const from = prefs[cls] ?? null;
    if (tier === null) delete prefs[cls]; else prefs[cls] = tier;
    updateUser(db, userId, { signalPrefs: JSON.stringify(prefs) });
    audit(db, { actorKind: 'user', actorId: userId, action: 'signal_pref_set', targetType: 'user', targetId: userId, payload: { class: cls, from, to: tier } });
    return prefs;
  });
}

/** 某人收这一类不阻塞信号的方式：项目档之上套个人偏好，再套底线。项目档是决策时调用方不该走到这里（那是事项）。 */
export function personalTier(db, userId, cls, base) {
  if (base === 'decide') return 'decide';
  const pref = signalPrefsOf(db, userId)[cls];
  const t = pref === 'notify' || pref === 'record' ? pref : base;
  return atLeast(t, CLASSES[cls].floor);
}

/** 事项的知会人：不用答，按"通知"推；个人可调成备案（底线是通知的类除外）。 */
export function informedTier(db, userId, decisionType) {
  const cls = QUESTION_CLASS[decisionType] ?? 'spec_choice';
  const pref = signalPrefsOf(db, userId)[cls];
  return pref === 'record' && CLASSES[cls].floor !== 'notify' ? 'record' : 'notify';
}

// ── 收件人 ───────────────────────────────────────────────────────────────

const activeAdmins = (db) => db.all(`SELECT id FROM users WHERE role='lead' AND disabled_at IS NULL ORDER BY created_at`).map((r) => r.id);
const isActive = (db, uid) => !!db.one(`SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL`, uid);

/** 'admins' = 全体在用的管理员；'owner' = 任务负责人（没有任务时取项目负责人）；其余按用户 id。 */
function resolveRecipients(db, to, { taskId, projectId }) {
  const out = new Set();
  for (const r of [].concat(to ?? [])) {
    if (!r) continue;
    if (r === 'admins') for (const a of activeAdmins(db)) out.add(a);
    else if (r === 'owner') {
      const o = (taskId && db.one(`SELECT owner_id FROM tasks WHERE id=?`, taskId)?.owner_id) || (projectId && db.one(`SELECT owner_id FROM projects WHERE id=?`, projectId)?.owner_id);
      if (o) out.add(o);
    } else out.add(r);
  }
  return [...out].filter((u) => isActive(db, u));
}

// ── 发件箱 ───────────────────────────────────────────────────────────────

/**
 * 记一个不阻塞的信号（同步，可在事务里调）。按项目监督模式 + 个人偏好给每个收件人定"通知 / 备案"。
 * 项目档解析成"决策"的类不该走这里（那要成为事项）：照"通知"记，并留一条审计让它被看见。
 * @param {object} o { to: 用户 id | 'admins' | 'owner' 的数组, title, text, taskId?, projectId?, ref?, level?, at? }
 * @returns {{id, recipients: Array<{userId, tier}>}}
 */
export function emitSignal(db, name, { to, title, text, taskId = null, projectId = null, ref = null, level = null, at = now() }) {
  const s = known(name);
  if (!s.class) throw new I18nError('汇总通道不经 emitSignal：{name}', { name });
  if (!projectId && taskId) projectId = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;
  let base = tierOf(db, s.class, { projectId, grain: s.grain ?? null, level });
  if (base === 'decide' && s.cap) base = s.cap;
  if (base === 'decide') {
    audit(db, { actorKind: 'system', action: 'signal_tier_mismatch', targetType: 'signal', targetId: name, payload: { class: s.class, projectId, taskId } });
    base = 'notify';
  }
  const users = resolveRecipients(db, to, { taskId, projectId });
  // 要注意的进度（项目停下来等人、等交付）不受个人偏好影响：把「进度」调成只记录的人，不该连「项目在等你」也收不到
  const recipients = users.map((u) => ({ userId: u, tier: s.grain === 'attention' ? base : personalTier(db, u, s.class, base) }));
  const id = newId('sg');
  // 通知档的每个收件人进推送队列（什么时候推、并不并成汇总由 push-queue 定）。
  // 部署级通道（.env）只兜"一个都推不到"的：没有收件人，或通知档的人都没有通道（没有个人通道的管理员算推得到，走 .env）
  const pushTo = recipients.filter((r) => r.tier === 'notify').map((r) => r.userId);
  const fallback = !recipients.length || (pushTo.length > 0 && !pushTo.some((u) => reachable(db, u)));
  const { urgent, exempt } = signalUrgency(name);
  const queued = [];
  db.tx(() => {
    db.run(`INSERT INTO signals (id,name,class,project_id,task_id,ref,title,text,fallback,created_at,pushed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, name, s.class, projectId, taskId, ref, String(title), String(text ?? ''), fallback ? 1 : 0, at, fallback ? null : at);
    for (const r of recipients) db.run(`INSERT INTO signal_recipients (signal_id,user_id,tier) VALUES (?,?,?)`, id, r.userId, r.tier);
    for (const u of pushTo) queued.push(enqueuePush(db, { userId: u, kind: name, source: 'signal', sourceId: id, urgent, exempt, group: `sig:${s.class}`, projectId, taskId, title, text, at }));
  });
  return { id, recipients, queued };
}

/** 旁路记信号：失败只记一行审计，不连累产生它的那件事（合并、升档、建项目……）。 */
export function trySignal(db, name, o) {
  try { return emitSignal(db, name, o); }
  catch (e) {
    console.error(`[signals] ${name} 没记上：${String(e?.message ?? e).slice(0, 300)}`);   // 审计之外也打一行：只进审计的话，测试和守护进程日志里都看不见
    try { audit(db, { actorKind: 'system', action: 'signal_emit_failed', targetType: 'signal', targetId: name, payload: { error: String(e?.message ?? e).slice(0, 300) } }); } catch { /* 库本身出错 */ }
    return null;
  }
}

/** 同一件事只记一次（按信号名 + ref）：每次运行都会再看到的状况（MCP server 变了、钩子坏了放行），第一次说就够了。 */
export function trySignalOnce(db, name, o) {
  if (o.ref && db.one(`SELECT 1 FROM signals WHERE name=? AND ref=? LIMIT 1`, name, o.ref)) return null;
  return trySignal(db, name, o);
}

/**
 * 同一件事攒成一条（按信号名 + ref）：上一条还没推出去、也还没人点开看过，就地改写它的标题与正文（推送队列里没推的那几行一起改），不另起一条。
 * 已经推出去或有人看过了 → 另起一条。给一个任务反复跑出来的同类小事用（每次沙箱收工都会再报一次联网情况）：
 * 汇总里一个任务一项、收件箱里一条，而不是每跑一步一条。正文由调用方写成"到现在为止"的累计，改写后仍然成立。
 */
export function trySignalCoalesced(db, name, o) {
  try {
    const prev = o.ref ? db.one(`SELECT * FROM signals WHERE name=? AND ref=? ORDER BY created_at DESC LIMIT 1`, name, o.ref) : null;
    const open = prev && !(prev.fallback && prev.pushed_at)
      && !db.one(`SELECT 1 FROM signal_recipients WHERE signal_id=? AND read_at IS NOT NULL`, prev.id)
      && !db.one(`SELECT 1 FROM push_queue WHERE source='signal' AND source_id=? AND sent_at IS NOT NULL`, prev.id);
    if (!open) return emitSignal(db, name, o);
    db.tx(() => {
      db.run(`UPDATE signals SET title=?, text=? WHERE id=?`, String(o.title), String(o.text ?? ''), prev.id);
      revisePending(db, { source: 'signal', sourceId: prev.id, title: o.title, text: o.text });
    });
    return { id: prev.id, revised: true };
  } catch (e) {
    console.error(`[signals] ${name} 没记上：${String(e?.message ?? e).slice(0, 300)}`);
    try { audit(db, { actorKind: 'system', action: 'signal_emit_failed', targetType: 'signal', targetId: name, payload: { error: String(e?.message ?? e).slice(0, 300) } }); } catch { /* 库本身出错 */ }
    return null;
  }
}

/**
 * 推还没推的信号。每条先在事务里认领（pushed_at），认领到的才发 —— 守护进程、tick、编排器同时调也至多推一次。
 * 通道：通知档收件人各自的个人通道；一个都没有（或没有收件人）就退到部署级通道（.env）。**不抛**。
 */
export async function deliverSignals(db, { env = process.env, extraCmd = null, fetchFn = globalThis.fetch, spawn, at = now(), limit = 100, ids = null } = {}) {
  const rows = ids
    ? db.all(`SELECT * FROM signals WHERE pushed_at IS NULL AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at`, JSON.stringify(ids))
    : db.all(`SELECT * FROM signals WHERE pushed_at IS NULL ORDER BY created_at LIMIT ?`, limit);
  const sent = [];
  // 只剩兜底：一个都推不到的信号推到部署级通道（推给人的走推送队列，见下）
  for (const s of rows) {
    const claimed = db.tx(() => Number(db.run(`UPDATE signals SET pushed_at=? WHERE id=? AND pushed_at IS NULL`, at, s.id).changes) === 1);
    if (!claimed) continue;
    // 产生时判的"推不到"按的是那个进程的环境；推的时候用这次的通道配置再判一次（没有个人通道的管理员这次走得通 .env，就交给队列）
    const to = db.all(`SELECT user_id FROM signal_recipients WHERE signal_id=? AND tier='notify'`, s.id).map((r) => r.user_id);
    const channels = s.fallback && !to.some((u) => reachable(db, u, { env, extraCmd })) ? channelsFromEnv(env, extraCmd) : [];
    let receipts = [];
    if (channels.length) {
      try { receipts = await notify(db, { taskId: s.task_id, kind: s.name, title: s.title, text: s.text, ref: s.ref, link: itemLink(db, { taskId: s.task_id, projectId: s.project_id }), channels, fetchFn, ...(spawn ? { spawn } : {}) }); }
      catch { /* notify 不抛；防御 */ }
    }
    sent.push({ signalId: s.id, name: s.name, to: [], receipts });
  }
  // 推送队列：信号与事项推给人的都在这里，按紧急程度、工作时间、汇总间隔、推送限额
  if (!ids) for (const p of await deliverPushes(db, { env, extraCmd, fetchFn, spawn, at })) sent.push({ signalId: null, name: p.kinds.join(','), to: [p.userId], receipts: p.receipts, as: p.as, items: p.items });
  return sent;
}

/** 记一条并当场推（要回执的调用方：启动失败、目录检查这种进程马上要退的）：不攒、不受限额。 */
export async function pushSignal(db, name, o, deliverOpts = {}) {
  const r = emitSignal(db, name, o);
  const [d] = await deliverSignals(db, { ...deliverOpts, ids: [r.id] });
  const p = r.queued.length ? await deliverPushes(db, { ...deliverOpts, ids: r.queued, force: true }) : [];
  return { ...r, receipts: [...(d?.receipts ?? []), ...p.flatMap((x) => x.receipts)] };
}

/**
 * 汇总通道与事项的推送（不进发件箱：摘要有自己的 digests 表，事项有自己的 notified_to）。
 * 仍经这里调通道，好让"推送只出自这个模块"成立；name 必须登记过。
 */
export async function pushDirect(db, name, { channels, taskId = null, title, text, ref = null, link = null, env = process.env, sendMailFn, fetchFn = globalThis.fetch, spawn }) {
  known(name);
  if (!channels?.length) return [];
  return notify(db, { taskId, kind: name, title, text, ref, link, env, channels, fetchFn, ...(spawn ? { spawn } : {}), ...(sendMailFn ? { sendMailFn } : {}) });
}

/** 个人通道（已停用的人不收）。与 users.mjs 的 channelsForUsers 同一口径；放这里免得循环引用。 */
const CHANNEL_KIND = { ntfy: 'ntfy', lark: 'feishu', dingtalk: 'dingtalk', wecom: 'wecom', email: 'email' };
// 邮件要部署配了发信服务器才算一条通道（判定在 smtp.mjs）
export { mailReady };
export function channelsFor(db, userIds, { env = process.env } = {}) {
  const out = []; const seen = new Set();
  for (const uid of userIds) {
    for (const c of db.all(`SELECT c.channel, c.target FROM user_channels c JOIN users u ON u.id=c.user_id WHERE c.user_id=? AND c.enabled=1 AND u.disabled_at IS NULL ORDER BY c.priority`, uid)) {
      const kind = CHANNEL_KIND[c.channel]; if (!kind || (kind === 'email' && !mailReady(env))) continue;
      const k = `${kind}:${c.target}`; if (seen.has(k)) continue; seen.add(k);
      out.push({ kind, target: c.target, userId: uid });
    }
  }
  return out;
}

/** 某人收到过的信号（看板"通知"列表）：最近的在前。 */
export function signalsFor(db, userId, { limit = 50, before = null } = {}) {
  // 每条带上它归哪一类（看板上写出来，并给"这一类以后不推送给我"：人是从一条具体的通知想到要关的，不是从设置表）
  return db.all(`SELECT s.id, s.name, s.class, s.project_id, s.task_id, s.ref, s.title, s.text, s.created_at, r.tier, r.read_at
    FROM signal_recipients r JOIN signals s ON s.id=r.signal_id WHERE r.user_id=? ${before ? 'AND s.created_at < ?' : ''}
    ORDER BY s.created_at DESC LIMIT ?`, ...(before ? [userId, before, limit] : [userId, limit]))
    .map((s) => ({ ...s, classLabel: CLASSES[s.class]?.label ?? null, floor: CLASSES[s.class]?.floor ?? null }));
}

export function markSignalsRead(db, userId, ids, at = now()) {
  return db.tx(() => {
    let n = 0;
    for (const id of ids) n += Number(db.run(`UPDATE signal_recipients SET read_at=? WHERE signal_id=? AND user_id=? AND read_at IS NULL`, at, id, userId).changes);
    return n;
  });
}

// ── 给看板的视图 ─────────────────────────────────────────────────────────

/** 表里不是单一档位的格子：按粒度 / 级别分开说 */
const CELL_NOTES = {
  spec_choice: { exception: N_('不要紧的（Ⅰ 级）通知：按 AI 提的默认直接走、事后告诉你；要紧的（Ⅱ / Ⅲ 级）决策') },
  progress: { full: N_('通知（每一步都推）'), spot: N_('任务级通知；每一步只备案'), exception: N_('备案；项目停下来等人、等你交付仍通知') },
  plan_changed: { full: N_('决策（系统按规矩补的步骤只通知）') },
};

/** 项目设置「监督与审批」用：当前模式、来源、三种模式、每一类在三种模式下怎么处理。 */
export function oversightView(db, projectId) {
  const own = projectId ? getProjectParam(db, projectId, OVERSIGHT_KEY) : null;
  return {
    mode: oversightMode(db, projectId), own: MODES[own] ? own : null, deployDefault: oversightMode(db, null),
    modes: Object.entries(MODES).map(([id, m]) => ({ id, label: m.label, blurb: m.blurb })),
    classes: Object.entries(CLASSES).map(([id, c]) => ({ id, label: c.label, floor: c.floor,
      cells: Object.fromEntries(Object.keys(MODES).map((m) => [m, { tier: c[m], note: CELL_NOTES[id]?.[m] ?? null }])) })),
  };
}

/** 「我的通知偏好」用：不阻塞的各类，自己的偏好、底线。决策档（要你拍板的）不在这里调 —— 那是事项，总会推给该答的人。 */
export function prefsView(db, userId) {
  const prefs = signalPrefsOf(db, userId);
  const mode = oversightMode(db, null);
  return {
    classes: Object.entries(CLASSES).filter(([, c]) => c.floor !== 'decide')
      // 决策档的类：个人设置管不到"要不要你答"，只管抄送给你、不用你答的那几条 —— 写明，免得以为调成备案就不用答了
      .map(([id, c]) => ({ id, label: c.label, floor: c.floor, pref: prefs[id] ?? null, deployTier: c[mode],
        note: CELL_NOTES[id]?.[mode] ?? (c[mode] === 'decide' ? N_('决策：要你答的照样要你答；这里只管抄送给你、不用你答的那几条') : null),
        always: id === 'progress' ? N_('项目停下来等你、等你交付：总会推送，不受这里影响') : null })),
    deployMode: mode, deployModeLabel: MODES[mode].label,
    // 我参与的、没跟部署默认走的项目：表里那一列只是部署默认下的做法，在这些项目里不准（走查：会据此误判自己收到什么）
    projects: db.all(`SELECT id, title FROM projects WHERE status IN ('active','stalled') AND (owner_id=? OR id IN (SELECT project_id FROM project_members WHERE user_id=?)) ORDER BY created_at`, userId, userId)
      .map((p) => ({ id: p.id, title: p.title, mode: oversightMode(db, p.id) })).filter((p) => p.mode !== mode)
      .map((p) => ({ ...p, modeLabel: MODES[p.mode].label })),
  };
}
