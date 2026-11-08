// 状态报告：一段时间里发生了什么。
//
// 与摘要（digest.mjs）分工：摘要只管还开着、等人动手的事；状态报告管**已经发生的**。两样都从真相源现算、不存正文、不调模型。
// 四段，每段没内容就明说"没有"：
//   ① 出事了没有：部署健康、安全边界被系统改了、任务硬失败、项目停滞、超时链卡住、触到花费或次数上限（上限追加事项）。
//      四类都为零才写"这段时间没有出事"——没算到不能说成没出事，所以这句只由这里的计数决定。
//   ② 没等你拍板就定下的（系统替你定了 / 别人动了你的事 / AI 自己做的）：超时按默认走、别人覆盖或转交、AI 自己定的做法、计划自己改的、AI 加的任务、自动升档、
//      以你的名义对外动作、系统小修。**调成备案的那几类在这里汇总**（备案从此有一个固定的地方被看到）。
//   ③ 进展：合并的任务（tasks.merged_at）、任务做完 / 等交付（进度信号；每一步的进度不算）。
//   ④ 花费与还等你的：这段时间各项目花了多少、你本月花了多少 / 预算；还有几件等你（只给数，细节在摘要和收件箱）。
// 范围：mine = 发给你的信号 + 你参与的项目（involvedIn；独立任务看归属人）；all（只给管理员）= 全部。
// 详略：exceptions 只报异常（只有 ①，外加一句还有几件等你）/ summary 摘要（每段最多 5 条）/ full 详细（全列）。

import { now, newId } from '../db/db.mjs';
import { updateUser } from '../db/users.mjs';
import { getSetting } from './settings.mjs';
import { pushPrefsOf, enqueuePush } from './push-queue.mjs';
import { calendarOf } from './calendar.mjs';
import { partsAt, zonedTime, dayKey, isBusinessDay } from './tz.mjs';
import { tl, userLang, CATALOGS } from '../i18n/index.mjs';
import { CLASSES } from './signals.mjs';
import { involvedIn } from './project-members.mjs';
import { personSpend, personBudget } from './spend.mjs';
import { viewerTz } from './calendar.mjs';
import { fmtAt } from './tz.mjs';
import { itemLink } from './links.mjs';

export const DETAILS = ['exceptions', 'summary', 'full'];
export const SCOPES = ['mine', 'all'];
const EXCEPTION_CLASSES = new Set(['deploy_health', 'security_changed']);
const EXCEPTION_NAMES = new Set(['run.hard_failed', 'progress.project_stalled', 'timeout.stuck']);
/** ② 的类，按"替你定了 → 别人动了 → AI 自己做的 → 系统小修"排。 */
export const DECIDED_CLASSES = ['timeout', 'others_changed', 'ai_choices', 'plan_changed', 'auto_task', 'auto_escalate', 'external_action', 'housekeeping'];
const PROGRESS_NAMES = new Set(['run.complete', 'project.awaiting_delivery']);   // 合并另从 tasks.merged_at 取；每一步的 run.report 不算
const LIMIT = 5;

const byCatalog = (lang, zh) => (lang && lang !== 'zh' ? CATALOGS[lang]?.[zh] ?? zh : zh);
const strip = (s) => String(s ?? '').replace(/^\s*\[SuperIntern\]\s*/, '').split('\n')[0].slice(0, 140);
const usd = (micro) => `$${(Number(micro || 0) / 1e6).toFixed(2)}`;

/** "24h" / "7d" / "90m" / 日期（2026-11-01，按 UTC 零点）/ ISO 时刻 → 毫秒时刻；认不出返回 null。 */
export function parseSince(v, until = now()) {
  const m = String(v ?? '').trim().match(/^(\d+)\s*([mhdw])$/i);
  if (m) return until - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[m[2].toLowerCase()];
  const t = Date.parse(String(v ?? '').trim());
  return Number.isFinite(t) && t < until ? t : null;
}

/** 上 back 个自然月（按这个人的时区）：1 = 上个月。 */
export function monthSpan(db, userId, { at = now(), back = 1 } = {}) {
  const tz = viewerTz(db, userId), p = partsAt(at, tz);
  return { since: zonedTime(p.y, p.mo - back, 1, 0, 0, 0, tz), until: zonedTime(p.y, p.mo - back + 1, 1, 0, 0, 0, tz) };
}

/** 这个人参与的项目 id（mine）；all = 全部。 */
function projectsIn(db, userId, scope) {
  const all = db.all(`SELECT id, title FROM projects ORDER BY created_at`);   // 归档了的也算：这段时间里它可能还在动
  return scope === 'all' ? all : all.filter((p) => involvedIn(db, p.id, userId));
}

/**
 * 算一份状态报告。
 * @param {{userId: string, since: number, until?: number, scope?: 'mine'|'all', detail?: 'exceptions'|'summary'|'full'}} o
 */
export function buildStatusReport(db, { userId, since, until = now(), scope = 'mine', detail = 'summary' }) {
  const isLead = db.one(`SELECT role FROM users WHERE id=?`, userId)?.role === 'lead';
  if (scope === 'all' && !isLead) scope = 'mine';
  const lang = userLang(db, userId);
  const projects = projectsIn(db, userId, scope);
  const pids = new Set(projects.map((p) => p.id));
  const inScopeTask = (t) => (t.project_id ? pids.has(t.project_id) : scope === 'all' || t.owner_id === userId);

  // 信号：mine = 发给你的（各档都算，备案的也在）；all = 这段时间所有的（一条信号只算一次）
  const sigs = scope === 'all'
    ? db.all(`SELECT s.*, NULL AS tier FROM signals s WHERE s.created_at >= ? AND s.created_at < ? ORDER BY s.created_at`, since, until)
    : db.all(`SELECT s.*, r.tier FROM signals s JOIN signal_recipients r ON r.signal_id=s.id AND r.user_id=?
              WHERE s.created_at >= ? AND s.created_at < ? ORDER BY s.created_at`, userId, since, until);
  const item = (s) => ({ id: s.id, name: s.name, title: strip(s.title), at: s.created_at, projectId: s.project_id, taskId: s.task_id, ref: s.ref, record: s.tier === 'record' });

  // ① 出事了没有
  const exceptions = sigs.filter((s) => EXCEPTION_CLASSES.has(s.class) || EXCEPTION_NAMES.has(s.name)).map(item);
  const limitHits = db.all(`SELECT q.id, q.text, q.asked_at, t.project_id, t.owner_id, q.task_id FROM questions q JOIN tasks t ON t.id=q.task_id
                            WHERE q.decision_type='budget' AND q.asked_at >= ? AND q.asked_at < ? ORDER BY q.asked_at`, since, until)
    .filter(inScopeTask).map((q) => ({ id: q.id, title: strip(q.text), at: q.asked_at, projectId: q.project_id, taskId: q.task_id, ref: q.id }));

  // ② 没等你拍板就定下的
  const decided = DECIDED_CLASSES.map((cls) => {
    const rows = sigs.filter((s) => s.class === cls && !EXCEPTION_NAMES.has(s.name)).map(item);
    return { cls, label: byCatalog(lang, CLASSES[cls]?.label ?? cls), n: rows.length, record: rows.filter((r) => r.record).length, items: rows };
  }).filter((g) => g.n);

  // ③ 进展
  const merged = db.all(`SELECT id, title, project_id, owner_id, merged_at FROM tasks WHERE merged_at >= ? AND merged_at < ? ORDER BY merged_at`, since, until)
    .filter(inScopeTask).map((t) => ({ id: t.id, title: t.title, at: t.merged_at, projectId: t.project_id, taskId: t.id }));
  const progress = sigs.filter((s) => PROGRESS_NAMES.has(s.name)).map(item);

  // ④ 花费与还等你的
  const spendRows = db.all(`SELECT t.project_id, t.owner_id, SUM(l.micro_usd) m FROM usage_ledger l JOIN tasks t ON t.id=l.task_id
                            WHERE l.ts >= ? AND l.ts < ? GROUP BY t.project_id, t.owner_id`, since, until).filter(inScopeTask);
  const titleOf = Object.fromEntries(projects.map((p) => [p.id, p.title]));
  const spendBy = new Map();
  for (const r of spendRows) { const k = r.project_id ?? ''; spendBy.set(k, (spendBy.get(k) ?? 0) + r.m); }
  const spend = {
    total: [...spendBy.values()].reduce((a, b) => a + b, 0),
    byProject: [...spendBy.entries()].map(([k, m]) => ({ projectId: k || null, title: k ? titleOf[k] ?? k : null, micro: m })).sort((a, b) => b.micro - a.micro),
    month: personSpend(db, userId), budget: personBudget(db, userId),
  };
  const waiting = db.one(`SELECT count(*) n FROM questions q WHERE q.status IN ('open','escalated')
                          AND EXISTS (SELECT 1 FROM json_each(q.addressed_to) j WHERE j.value=?)
                          AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id=q.id AND a.user_id=?)`, userId, userId).n;

  return { userId, lang, since, until, scope, detail, tz: viewerTz(db, userId),
    exceptions, limitHits, quiet: exceptions.length === 0 && limitHits.length === 0,
    decided, merged, progress, spend, waiting, inbox: itemLink(db) };
}

const titleOf = (r) => (r.quiet ? tl(r.lang, '[SuperIntern] 状态报告：没有出事') : tl(r.lang, '[SuperIntern] 状态报告：出了 {n} 件事', { n: r.exceptions.length + r.limitHits.length }));

/** 渲染成推送 / 邮件 / CLI 的文字。返回 { title, text }。 */
export function renderStatusReport(r) {
  const L = r.lang;
  const at = (t) => fmtAt(t, r.tz, { zone: false });
  const cap = r.detail === 'full' ? Infinity : LIMIT;
  const list = (rows, fmt) => {
    const shown = rows.slice(0, cap).map((x) => `  - ${fmt(x)}`);
    if (rows.length > cap) shown.push(`  ${tl(L, '……另有 {n} 条（看板「状态报告」里有全部）', { n: rows.length - cap })}`);
    return shown;
  };
  const head = tl(L, '{from} 至 {to}（{zone}）', { from: at(r.since), to: at(r.until), zone: fmtAt(r.until, r.tz).split(' ').pop() });
  const out = [`${r.scope === 'all' ? tl(L, '全部项目') : tl(L, '与你有关的')} · ${head}`, ''];

  out.push(tl(L, '① 出事了没有'));
  if (r.quiet) out.push(`  ${tl(L, '这段时间没有出事。')}`);
  else {
    out.push(...list(r.exceptions, (x) => `${at(x.at)} ${x.title}`));
    if (r.limitHits.length) out.push(...list(r.limitHits, (x) => `${at(x.at)} ${tl(L, '触到上限：')}${x.title}`));
  }
  if (r.detail === 'exceptions') {
    out.push('', r.waiting ? tl(L, '还有 {n} 件等你答：{link}', { n: r.waiting, link: r.inbox ?? tl(L, '看板收件箱') }) : tl(L, '没有等你答的事。'));
    return { title: titleOf(r), text: out.join('\n') };
  }

  out.push('', r.scope === 'all' ? tl(L, '② 没等人拍板就定下的') : tl(L, '② 没等你拍板就定下的'));
  if (!r.decided.length) out.push(`  ${tl(L, '没有。')}`);
  for (const g of r.decided) {
    out.push(`  ${g.label}${tl(L, '：')}${tl(L, '{n} 条', { n: g.n })}${g.record ? tl(L, '（其中 {n} 条你调成了备案，没推送过）', { n: g.record }) : ''}`);
    out.push(...list(g.items, (x) => `${at(x.at)} ${x.title}`).map((l) => `  ${l}`));
  }

  out.push('', tl(L, '③ 进展'));
  if (!r.merged.length && !r.progress.length) out.push(`  ${tl(L, '没有。')}`);
  if (r.merged.length) { out.push(`  ${tl(L, '合并了 {n} 个任务', { n: r.merged.length })}`); out.push(...list(r.merged, (x) => `${at(x.at)} ${x.title}`).map((l) => `  ${l}`)); }
  if (r.progress.length) out.push(...list(r.progress, (x) => `${at(x.at)} ${x.title}`));

  out.push('', tl(L, '④ 花费与还等你的'));
  out.push(`  ${tl(L, '这段时间花了 {usd}', { usd: usd(r.spend.total) })}${r.spend.byProject.length ? `${tl(L, '：')}${r.spend.byProject.slice(0, cap).map((p) => `${p.title ?? tl(L, '独立任务')} ${usd(p.micro)}`).join(tl(L, '，'))}` : ''}`);
  out.push(`  ${r.spend.budget != null ? tl(L, '你本月花了 {usd}，预算 {budget}', { usd: usd(r.spend.month), budget: usd(r.spend.budget) }) : tl(L, '你本月花了 {usd}（没设预算）', { usd: usd(r.spend.month) })}`);
  out.push(`  ${r.waiting ? tl(L, '还有 {n} 件等你答：{link}', { n: r.waiting, link: r.inbox ?? tl(L, '看板收件箱') }) : tl(L, '没有等你答的事。')}`);
  return { title: titleOf(r), text: out.join('\n') };
}

// ── 定期发────────────────────────────────────────────────────────

const H = 3_600_000, D = 24 * H;
const MAX_PUSH_CHARS = 3500;   // ntfy 一条 4 KB；太长的截断，完整的在看板上
/** 部署默认是 auto 时按默认监督模式给：逐项审批的人想天天看，抽检每周，例外管理每周只报异常。 */
const AUTO = { full: { every: 'day', detail: 'summary' }, spot: { every: 'week', detail: 'summary' }, exception: { every: 'week', detail: 'exceptions' } };

/** 这个人的状态报告设置（个人的 → 部署默认 → auto 按监督模式）。管理员默认看全部项目。 */
export function reportPrefsOf(db, userId) {
  const p = pushPrefsOf(db, userId), own = p.own;
  const auto = AUTO[getSetting(db, 'deploy.oversight_mode')] ?? AUTO.spot;
  const dep = { every: getSetting(db, 'deploy.report_every'), detail: getSetting(db, 'deploy.report_detail') };
  const isLead = db.one(`SELECT role FROM users WHERE id=?`, userId)?.role === 'lead';
  return {
    every: own.reportEvery ?? (dep.every === 'auto' ? auto.every : dep.every),
    day: own.reportDay ?? getSetting(db, 'deploy.report_day'),
    hour: own.reportHour ?? getSetting(db, 'deploy.report_hour'),
    detail: own.reportDetail ?? (dep.detail === 'auto' ? auto.detail : dep.detail),
    scope: isLead ? own.reportScope ?? 'all' : 'mine',
    tz: p.tz, own, isLead,
  };
}

/**
 * 最近一个到点的时刻点（≤ at）；关了返回 null。每天 / 每周（星期几）的几点，按本人时区；
 * 那天不是工作日（部署的节假日表）就顺延到下一个工作日的同一钟点（周末两天的日报都落到周一，合成一份）。
 */
export function lastSlot(db, rp, at = now()) {
  if (!rp || rp.every === 'off') return null;
  const cal = calendarOf(db);
  let best = null;
  for (let k = 0; k <= 21; k++) {
    const p = partsAt(at - k * D, rp.tz);
    const wd = partsAt(zonedTime(p.y, p.mo, p.d, 12, 0, 0, rp.tz), rp.tz).wd;
    if (rp.every === 'week' && (wd === 0 ? 7 : wd) !== rp.day) continue;
    let t = zonedTime(p.y, p.mo, p.d, rp.hour, 0, 0, rp.tz);
    for (let j = 0; j < 14 && !isBusinessDay(dayKey(t, rp.tz), cal); j++) { const q = partsAt(t, rp.tz); t = zonedTime(q.y, q.mo, q.d + 1, rp.hour, 0, 0, rp.tz); }
    if (t <= at && (best == null || t > best)) best = t;
  }
  return best;
}

/**
 * 守护进程每拍调：到点的人各排一份进推送队列。一个时刻点只排一次（status_reports 的 UNIQUE）；
 * 覆盖的时段接着上一份的结束（中间改过频率、守护进程停过几天也不漏不重）；第一份往前算一个周期。
 * @returns {Array<{userId, slot, since, quiet}>}
 */
export function queueDueReports(db, { at = now() } = {}) {
  const out = [];
  for (const u of db.all(`SELECT id, created_at FROM users WHERE disabled_at IS NULL AND kind='human'`)) {
    const rp = reportPrefsOf(db, u.id);
    const slot = lastSlot(db, rp, at);
    if (slot == null || slot <= u.created_at) continue;
    const last = db.one(`SELECT max(slot_at) s, max(until) u FROM status_reports WHERE user_id=?`, u.id);
    if (last.s != null && last.s >= slot) continue;
    const since = last.u ?? slot - (rp.every === 'day' ? D : 7 * D);
    const r = buildStatusReport(db, { userId: u.id, since, until: slot, scope: rp.scope, detail: rp.detail });
    const m = renderStatusReport(r);
    const text = m.text.length > MAX_PUSH_CHARS ? `${m.text.slice(0, MAX_PUSH_CHARS)}\n${tl(r.lang, '……太长了，完整的在看板「状态报告」里')}` : m.text;
    const id = newId('sr');
    const queued = db.tx(() => {
      const ins = db.run(`INSERT OR IGNORE INTO status_reports (id,user_id,slot_at,since,until,detail,scope,quiet,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, u.id, slot, since, slot, r.detail, r.scope, r.quiet ? 1 : 0, at);
      if (!Number(ins.changes)) return false;   // 别的进程刚排过
      enqueuePush(db, { userId: u.id, kind: 'report.status', source: 'report', sourceId: id, urgent: false, group: 'report', title: m.title, text, at });
      return true;
    });
    if (queued) out.push({ userId: u.id, slot, since, quiet: r.quiet });
  }
  return out;
}

// ── 看板：「你不在时」与设置页 ─────────────────────────────────────

export const AWAY_MS = 8 * H;   // 离开多久算"不在"：一个晚上 / 一个工作日
const SEEN_EVERY_MS = 60_000;

/**
 * 看板报上来"人在看"（页面可见、有过操作）。距上次超过 AWAY_MS 就记一段离开；没关掉的旧一段接着往前算。
 * @returns {null | {from: number, to: number}} 现在挂着的那段离开
 */
export function noteSeen(db, userId, { at = now() } = {}) {
  const u = db.one(`SELECT seen_at, away_from, away_to FROM users WHERE id=?`, userId);
  if (!u) return null;
  if (u.seen_at != null && at - u.seen_at >= AWAY_MS) {
    const from = u.away_from ?? u.seen_at;
    updateUser(db, userId, { seenAt: at, awayFrom: from, awayTo: at });
    return { from, to: at };
  }
  if (u.seen_at == null || at - u.seen_at >= SEEN_EVERY_MS) updateUser(db, userId, { seenAt: at });
  return u.away_from != null ? { from: u.away_from, to: u.away_to } : null;
}
/** 关掉「你不在时」那一条。 */
export const dismissAway = (db, userId) => updateUser(db, userId, { awayFrom: null, awayTo: null });

/** 「你不在时」那一条要的几个数（就是那段时间的状态报告，只取各段条数）。 */
export function awaySummary(db, userId, away) {
  if (!away) return null;
  const r = buildStatusReport(db, { userId, since: away.from, until: away.to, scope: 'mine', detail: 'summary' });
  return { from: away.from, to: away.to, quiet: r.quiet, exceptions: r.exceptions.length + r.limitHits.length,
    decided: r.decided.reduce((n, g) => n + g.n, 0), record: r.decided.reduce((n, g) => n + g.record, 0), merged: r.merged.length, waiting: r.waiting };
}

/** 「我的通知」里状态报告那一行要的：自己的设置、部署默认（含 auto 落到了什么）、上一份。 */
export function reportView(db, userId) {
  const p = reportPrefsOf(db, userId);
  const auto = AUTO[getSetting(db, 'deploy.oversight_mode')] ?? AUTO.spot;
  const last = db.one(`SELECT slot_at, since, until, detail, scope, quiet FROM status_reports WHERE user_id=? ORDER BY slot_at DESC LIMIT 1`, userId) ?? null;
  const pick = (k) => p.own[k];
  return {
    prefs: { every: p.every, day: p.day, hour: p.hour, detail: p.detail, scope: p.scope }, isLead: p.isLead, tz: p.tz,
    own: { every: pick('reportEvery'), day: pick('reportDay'), hour: pick('reportHour'), detail: pick('reportDetail'), scope: pick('reportScope') },
    deploy: { every: getSetting(db, 'deploy.report_every'), day: getSetting(db, 'deploy.report_day'), hour: getSetting(db, 'deploy.report_hour'), detail: getSetting(db, 'deploy.report_detail'), mode: getSetting(db, 'deploy.oversight_mode'), auto },
    last,
  };
}
