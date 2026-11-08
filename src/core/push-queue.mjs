// 推送节奏：紧急程度、工作时间、汇总推送、推送限额。
//
// 定了"推不推"（决策 / 通知 / 备案）；这里定"什么时候推、几条并成一条"。原来每个产生点各推各的、马上推、一条一推：
// 场景集完整预设里负责人一天 37 条（任务合并了 ×28）、评审各 30 条签收、1 小时内最多 10 条。
//
// 一件要推给某人的事 → push_queue 一行（通知档信号的每个收件人、事项的每个答复人 / 抄送人各一行）。之后由 deliverPushes 按人决定：
//   - 紧急：马上单条推。受推送限额（每人每小时即时几条）；撞了限额排进下一次汇总的最前面。Ⅲ 级与部署健康不受限额。
//   - 不紧急：只在本人的工作时间里推，按汇总间隔攒成一条（按种类分组；同一项目的签收合成一项）。攒到只有一件时照原样推那一件。
// 紧急程度在这一处判定（类 + 级别 + 时限），不让各产生点自己定；推之前再判一次（事项快到时限了就升成紧急，已经结了就不推）。
// 通道：本人的个人通道；没有个人通道的管理员退到部署级通道（.env）；都没有就不推（看板收件箱里照样看得到）。

import { itemLink, linkForPush } from './links.mjs';
import { newId, now, audit } from '../db/db.mjs';
import { updateUser } from '../db/users.mjs';
import { getSetting } from './settings.mjs';
import { SIGNALS, CLASSES, channelsFor, pushDirect } from './signals.mjs';
import { channelsFromEnv } from './notify.mjs';
import { viewerTz, calendarOf } from './calendar.mjs';
import { partsAt, dayKey, isBusinessDay, zonedTime } from './tz.mjs';
import { tl, userLang, I18nError, N_, CATALOGS } from '../i18n/index.mjs';

const H = 3_600_000;
/** 事项离时限不到这么久就算紧急（工作时间外也推）。 */
export const NEAR_DUE_MS = 2 * H;

// ── 紧急程度 ─────────────────────────────────────────────────────────────

/** 信号的紧急程度：登记表上标了的按标的，否则按类。部署健康不受限额。 */
const URGENT_CLASSES = new Set(['external_action', 'security_changed', 'deploy_health']);
export function signalUrgency(name) {
  const s = SIGNALS[name];
  const urgent = s?.urgent ?? URGENT_CLASSES.has(s?.class);
  return { urgent: !!urgent, exempt: s?.class === 'deploy_health' };
}

/** 事项的紧急程度（推之前再判一次）：Ⅲ 级、安全审批、已升级、离时限不到 2 小时 = 紧急；Ⅲ 级不受限额。抄送的一律不紧急。 */
export function questionUrgency(q, { informed = false, at = now() } = {}) {
  if (informed) return { urgent: false, exempt: false };
  const near = q.timeout_at != null && q.timeout_at - at < NEAR_DUE_MS;
  // 签收虽然是 Ⅲ 级，但活已经做完、只是等着合并，不是"AI 停着等不起"：攒着一起签正合适（基线里评审的推送全是它）
  const signoff = q.decision_type === 'signoff';
  const urgent = (q.level === 3 && !signoff) || q.decision_type === 'security' || q.status === 'escalated' || near;
  return { urgent, exempt: q.level === 3 && !signoff };
}

// ── 个人设置 ─────────────────────────────────────────────────────────────

/** 部署默认 ⊕ 个人设置。start / end 是本人时区的整点；workdaysOnly 按部署节假日表算工作日；every 分钟（0 = 不攒）；cap 每小时（0 = 不限）。 */
export function pushPrefsOf(db, userId) {
  let own = {};
  try { own = JSON.parse(db.one(`SELECT push_prefs FROM users WHERE id=?`, userId)?.push_prefs ?? '{}') ?? {}; } catch { own = {}; }
  const pick = (k, setting) => (own[k] ?? getSetting(db, setting));
  return {
    start: pick('start', 'deploy.work_start_hour'), end: pick('end', 'deploy.work_end_hour'), workdaysOnly: pick('workdaysOnly', 'deploy.work_days_only'),
    every: pick('every', 'deploy.digest_every_min'), cap: pick('cap', 'deploy.push_cap_per_hour'), tz: viewerTz(db, userId), own,
  };
}

/** 此刻在不在这个人的工作时间里。 */
export function inWorkingHours(db, prefs, at = now()) {
  if (prefs.start === 0 && prefs.end === 24 && !prefs.workdaysOnly) return true;
  const p = partsAt(at, prefs.tz);
  if (prefs.workdaysOnly && !isBusinessDay(dayKey(at, prefs.tz), calendarOf(db))) return false;
  const h = p.h + p.mi / 60;
  return prefs.start < prefs.end ? h >= prefs.start && h < prefs.end : h >= prefs.start || h < prefs.end;   // 跨午夜的班次也认
}

/** 下一个工作时段从什么时候开始（给看板说"攒到 X 推"）；7 天内找不到返回 null。 */
export function nextWorkStart(db, prefs, at = now()) {
  for (let i = 0; i <= 7; i++) {
    const p = partsAt(at + i * 24 * H, prefs.tz);
    const t = zonedTime(p.y, p.mo, p.d, prefs.start, 0, 0, prefs.tz);
    if (t > at && inWorkingHours(db, prefs, t)) return t;
  }
  return null;
}

const PREF_KEYS = { start: [0, 23], end: [1, 24], every: [0, 1440], cap: [0, 60], reportDay: [1, 7], reportHour: [0, 23] };
// 状态报告的几项也放在这里：同一份个人推送设置
const PREF_ENUMS = { reportEvery: ['off', 'day', 'week'], reportDetail: ['exceptions', 'summary', 'full'], reportScope: ['mine', 'all'] };
/** 改自己的推送设置。值为 null = 跟部署默认。 */
export function setPushPrefs(db, { userId, prefs }) {
  const cur = pushPrefsOf(db, userId).own;
  const next = { ...cur };
  for (const [k, v] of Object.entries(prefs ?? {})) {
    if (v === null || v === undefined) { delete next[k]; continue; }
    if (k === 'workdaysOnly') { next[k] = !!v; continue; }
    if (PREF_ENUMS[k]) {
      if (!PREF_ENUMS[k].includes(v)) throw new I18nError('推送设置「{k}」的值无效（应为 {list} 之一）', { k, list: PREF_ENUMS[k].join(' / ') });
      next[k] = v; continue;
    }
    const range = PREF_KEYS[k];
    if (!range) throw new I18nError('推送设置没有这一项：{k}', { k });
    if (!(Number.isInteger(v) && v >= range[0] && v <= range[1])) throw new I18nError('推送设置「{k}」的值无效（应为 {min}–{max} 的整数）', { k, min: range[0], max: range[1] });
    next[k] = v;
  }
  const eff = (k, s) => next[k] ?? getSetting(db, s);
  if (eff('start', 'deploy.work_start_hour') === eff('end', 'deploy.work_end_hour')) throw new I18nError('工作时间的开始和结束不能是同一个钟点（全天都推：0 点到 24 点）');
  updateUser(db, userId, { pushPrefs: JSON.stringify(next) });
  audit(db, { actorKind: 'user', actorId: userId, action: 'push_prefs_set', targetType: 'user', targetId: userId, payload: { from: cur, to: next } });
  return pushPrefsOf(db, userId);
}

// ── 入队 ─────────────────────────────────────────────────────────────────

/** 进队列（调用方在自己的事务里）。group：汇总里归哪一组。 */
export function enqueuePush(db, { userId, kind, source, sourceId, urgent, exempt = false, group, projectId = null, taskId = null, title, text, at = now() }) {
  const id = newId('pq');
  db.run(`INSERT INTO push_queue (id,user_id,kind,source,source_id,urgent,exempt,group_key,project_id,task_id,title,text,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, userId, kind, source, sourceId, urgent ? 1 : 0, exempt ? 1 : 0, group, projectId, taskId, String(title), String(text ?? ''), at);
  return id;
}

/** 这个人有没有推得到的通道（个人通道，或没有个人通道的管理员退到部署级通道）。 */
export function reachable(db, userId, { env = process.env, extraCmd = null } = {}) {
  if (channelsFor(db, [userId], { env }).length) return true;
  return db.one(`SELECT role FROM users WHERE id=? AND disabled_at IS NULL`, userId)?.role === 'lead' && channelsFromEnv(env, extraCmd).length > 0;
}
const channelsOf = (db, userId, env, extraCmd) => {
  const own = channelsFor(db, [userId], { env });
  if (own.length) return own;
  return db.one(`SELECT role FROM users WHERE id=? AND disabled_at IS NULL`, userId)?.role === 'lead' ? channelsFromEnv(env, extraCmd) : [];
};

// ── 推送 ─────────────────────────────────────────────────────────────────

/**
 * 按人推队列里该推的。守护进程每一拍、tick、编排器退出前都会调；认领在事务里（sent_at），同时调也至多推一次。**不抛**。
 * force：这几行（ids）不管工作时间、限额、汇总间隔，马上单条推（进程马上要退、要回执的调用方）。
 */
export async function deliverPushes(db, { env = process.env, extraCmd = null, fetchFn = globalThis.fetch, spawn, sendMailFn, at = now(), ids = null, force = false } = {}) {
  const users = ids
    ? db.all(`SELECT DISTINCT user_id FROM push_queue WHERE sent_at IS NULL AND id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).map((r) => r.user_id)
    : db.all(`SELECT DISTINCT user_id FROM push_queue WHERE sent_at IS NULL`).map((r) => r.user_id);
  const out = [];
  for (const userId of users) {
    try { out.push(...await deliverFor(db, userId, { env, extraCmd, fetchFn, spawn, sendMailFn, at, ids, force })); }
    catch (e) { try { audit(db, { actorKind: 'system', action: 'push_failed', targetType: 'user', targetId: userId, payload: { error: String(e?.message ?? e).slice(0, 300) } }); } catch { /* 库本身出错 */ } }
  }
  return out;
}

async function deliverFor(db, userId, { env, extraCmd, fetchFn, spawn, sendMailFn, at, ids, force }) {
  const prefs = pushPrefsOf(db, userId);
  let rows = db.all(`SELECT * FROM push_queue WHERE user_id=? AND sent_at IS NULL ORDER BY created_at`, userId);
  if (ids) { const want = new Set(ids); rows = rows.filter((r) => want.has(r.id)); }
  if (!rows.length) return [];
  const channels = channelsOf(db, userId, env, extraCmd);
  // 没有通道：记成 none（看板里照样看得到），不占限额
  if (!channels.length) { claim(db, rows.map((r) => r.id), at, 'none', null); return []; }

  // 推之前再判一次：事项已经结了的不推；快到时限的升成紧急
  const live = [];
  for (const r of rows) {
    if (r.source !== 'question') { live.push(r); continue; }
    const q = db.one(`SELECT id, level, status, decision_type, timeout_at FROM questions WHERE id=?`, r.source_id);
    if (!q || !['open', 'escalated'].includes(q.status)) { claim(db, [r.id], at, 'moot', null); continue; }
    const u = questionUrgency(q, { informed: r.kind === 'question.informed', at });
    live.push({ ...r, urgent: r.urgent || u.urgent ? 1 : 0, exempt: r.exempt || u.exempt ? 1 : 0 });
  }
  const sent = [];
  let capNotice = null;   // 推到限额那一条时附一句"之后的会合并进汇总"
  const send = async (items, as) => {
    const batch = newId('pb');
    const got = claim(db, items.map((r) => r.id), at, as, batch);
    const mine = items.filter((r) => got.has(r.id));
    if (!mine.length) return;
    const msg = mine.length === 1 ? { name: mine[0].kind, title: mine[0].title, text: mine[0].text, taskId: mine[0].task_id, ref: mine[0].source_id, link: linkForPush(db, mine[0]) }
      : { name: 'push.digest', ...renderDigest(db, userId, mine, { at }), taskId: null, ref: batch, link: itemLink(db) };   // 汇总链到收件箱
    if (as === 'single' && mine.length === 1 && capNotice) msg.text = `${msg.text}\n\n${capNotice}`;
    const receipts = await pushDirect(db, msg.name, { channels, taskId: msg.taskId, title: msg.title, text: msg.text, ref: msg.ref, link: msg.link, env, sendMailFn, fetchFn, spawn });
    sent.push({ userId, as, items: mine.length, kinds: [...new Set(mine.map((r) => r.kind))], refs: mine.map((r) => r.source_id), receipts });
  };


  if (force) { for (const r of live) await send([r], 'single'); return sent; }

  // 紧急：限额之内单条推；撞了限额的标 capped，进下一次汇总的最前面
  const L = userLang(db, userId);
  // 限额数的是"这一小时打断了这个人几次"：即时单条（不受限的除外）+ 汇总各算一次 —— 不然撞了限额的转进汇总、一分钟后又推一次，限额形同虚设
  let used = db.one(`SELECT count(DISTINCT CASE WHEN sent_as='digest' THEN batch_id ELSE id END) n FROM push_queue WHERE user_id=? AND sent_at > ? AND (sent_as='digest' OR (sent_as='single' AND exempt=0))`, userId, at - H).n;
  for (const r of live.filter((x) => x.urgent)) {
    if (r.exempt || !prefs.cap || used < prefs.cap) {
      if (!r.exempt) used++;
      capNotice = !r.exempt && prefs.cap && used === prefs.cap ? tl(L, '（这一小时已经推了 {n} 条，之后的会合并进下一次汇总推送）', { n: prefs.cap }) : null;
      await send([r], 'single');
      capNotice = null;
    } else {
      db.run(`UPDATE push_queue SET capped=1, urgent=0 WHERE id=? AND sent_at IS NULL`, r.id);   // 之后按不紧急的走（排在汇总最前面）
      r.capped = 1; r.urgent = 0;
    }
  }
  // 状态报告：不紧急，但单条推、不并进汇总（一份报告本身就是汇总）；照样只在工作时间里推、受限额管
  const reports = live.filter((x) => x.source === 'report' && !x.urgent);
  if (reports.length && inWorkingHours(db, prefs, at)) {
    for (const r of reports) { if (prefs.cap && used >= prefs.cap) break; used++; await send([r], 'single'); }
  }
  // 不紧急（含撞了限额的）：工作时间里、到了汇总间隔才推
  const rest = live.filter((x) => !x.urgent && x.source !== 'report');
  if (!rest.length || !inWorkingHours(db, prefs, at)) return sent;
  const last = db.one(`SELECT max(sent_at) t FROM push_queue WHERE user_id=? AND sent_as='digest'`, userId)?.t ?? null;
  if (prefs.every && last != null && at - last < prefs.every * 60_000) return sent;
  if (prefs.cap && used >= prefs.cap) return sent;   // 这一小时已经打断够了：等窗口空出来
  await send(rest.sort((a, b) => b.capped - a.capped || a.created_at - b.created_at), 'digest');
  return sent;
}

/** 在事务里认领（只认领还没推的）；返回认领到的 id 集合。 */
function claim(db, ids, at, as, batch) {
  return db.tx(() => {
    const got = new Set();
    for (const id of ids) if (Number(db.run(`UPDATE push_queue SET sent_at=?, sent_as=?, batch_id=? WHERE id=? AND sent_at IS NULL`, at, as, batch, id).changes) === 1) got.add(id);
    return got;
  });
}

// ── 汇总的样子 ───────────────────────────────────────────────────────────

const strip = (t) => String(t ?? '').replace(/^\[SuperIntern\]\s*/, '');
const byCatalog = (lang, zh) => (lang && lang !== 'zh' ? CATALOGS[lang]?.[zh] ?? zh : zh);
const GROUP_LABEL = {
  sign: N_('等你签收'), ask: N_('等你答'), cc: N_('抄送给你（不用你答）'),
};
/** 组的先后：撞了限额的紧急事项 → 等你签收 / 答 → 抄送 → 各类通知（按登记表里类的顺序）。 */
// 不在模块顶层读 CLASSES：signals.mjs 与这里互相引用，顶层读会撞上还没初始化
const groupRank = (g) => (g.startsWith('sign') ? 1 : g === 'ask' ? 0 : g === 'cc' ? 2 : 3 + Math.max(0, Object.keys(CLASSES).indexOf(g.slice(4))));

export function renderDigest(db, userId, items, { at = now(), max = 5 } = {}) {
  const L = userLang(db, userId);
  const groups = new Map();
  for (const r of items) { const g = groups.get(r.group_key) ?? []; g.push(r); groups.set(r.group_key, g); }
  const waiting = items.filter((r) => r.kind === 'question.addressed').length;
  const lines = [];
  const capped = items.filter((r) => r.capped);
  if (capped.length) lines.push(tl(L, '这一小时推得多，下面 {n} 件紧急的没有单独推：', { n: capped.length }), ...capped.map((r) => `· ${strip(r.title)}`), '');
  for (const [g, rs] of [...groups].sort((a, b) => groupRank(a[0]) - groupRank(b[0]))) {
    // 组内同一项目的挨着（项目按组里最早的那件排，项目内按先后）；一组跨几个项目时每条带上项目名
    const first = new Map();
    for (const r of rs) if (!first.has(r.project_id ?? '')) first.set(r.project_id ?? '', r.created_at);
    const rest = rs.filter((r) => !r.capped).sort((a, b) => (first.get(a.project_id ?? '') - first.get(b.project_id ?? '')) || String(a.project_id ?? '').localeCompare(String(b.project_id ?? '')) || a.created_at - b.created_at);
    if (!rest.length) continue;
    const multi = !g.startsWith('sign:') && new Set(rest.map((r) => r.project_id ?? '')).size > 1;
    const ptitle = (id) => (id ? db.one(`SELECT title FROM projects WHERE id=?`, id)?.title ?? null : null);
    const label = g.startsWith('sign') ? GROUP_LABEL.sign : GROUP_LABEL[g] ?? CLASSES[g.slice(4)]?.label ?? g;
    const proj = g.startsWith('sign:') ? db.one(`SELECT title FROM projects WHERE id=?`, g.slice(5))?.title : null;
    lines.push(proj ? tl(L, '{label}（{n}）· 项目「{p}」', { label: byCatalog(L, label), n: rest.length, p: proj }) : tl(L, '{label}（{n}）', { label: byCatalog(L, label), n: rest.length }));
    for (const r of rest.slice(0, max)) { const p = multi ? ptitle(r.project_id) : null; lines.push(p ? `· ${tl(L, '「{p}」', { p })} ${strip(r.title)}` : `· ${strip(r.title)}`); }
    if (rest.length > max) lines.push(tl(L, '· ……另 {n} 件', { n: rest.length - max }));
    if (g.startsWith('sign:') && rest.length > 1) lines.push(tl(L, '  收件箱「待签收」里这几件排在一起，逐件签。'));
    lines.push('');
  }
  lines.push(tl(L, '全部在看板收件箱里。'));
  const title = `[SuperIntern] ${waiting ? tl(L, '{n} 件新事，其中 {k} 件等你', { n: items.length, k: waiting }) : tl(L, '{n} 件新事', { n: items.length })}`;
  return { title, text: lines.join('\n').trim() };
}

/** 还没推的那几行改成新的标题与正文（同一件事攒成一条的信号就地更新时用）。返回改了几行。 */
export function revisePending(db, { source, sourceId, title, text }) {
  return Number(db.run(`UPDATE push_queue SET title=?, text=? WHERE source=? AND source_id=? AND sent_at IS NULL`, String(title), String(text ?? ''), source, sourceId).changes);
}

/** 某人最近的推送统计（「我的通知」页显示；管理员看全员）：since 起推了几条、其中即时几条、汇总几次。 */
export function pushStats(db, userId, { since }) {
  const r = db.one(`SELECT count(DISTINCT CASE WHEN sent_as='single' THEN id END) singles, count(DISTINCT CASE WHEN sent_as='digest' THEN batch_id END) digests,
                    count(CASE WHEN sent_as IN ('single','digest') THEN 1 END) items FROM push_queue WHERE user_id=? AND sent_at >= ?`, userId, since);
  return { pushes: (r.singles ?? 0) + (r.digests ?? 0), singles: r.singles ?? 0, digests: r.digests ?? 0, items: r.items ?? 0 };
}

/** 看板「我的通知」的推送节奏一节：生效的设置、自己设过哪几项、部署默认、此刻在不在工作时间、最近 7 天推了几次、还攒着几件。 */
export function pushView(db, userId, at = now()) {
  const p = pushPrefsOf(db, userId);
  const deploy = { start: getSetting(db, 'deploy.work_start_hour'), end: getSetting(db, 'deploy.work_end_hour'), workdaysOnly: getSetting(db, 'deploy.work_days_only'),
    every: getSetting(db, 'deploy.digest_every_min'), cap: getSetting(db, 'deploy.push_cap_per_hour') };
  const working = inWorkingHours(db, p, at);
  const ownTz = db.one(`SELECT tz FROM users WHERE id=?`, userId)?.tz;
  return { prefs: { start: p.start, end: p.end, workdaysOnly: p.workdaysOnly, every: p.every, cap: p.cap }, own: p.own, deploy, tz: p.tz, tzOwn: !!ownTz && ownTz === p.tz,
    working, nextStart: working ? null : nextWorkStart(db, p, at),
    week: pushStats(db, userId, { since: at - 7 * 24 * H }),
    pending: db.one(`SELECT count(*) n FROM push_queue WHERE user_id=? AND sent_at IS NULL`, userId).n,
    // 管理员看全员（打断得多的排前面）：谁被推得最多、是不是该帮他调一调
    team: db.one(`SELECT role FROM users WHERE id=?`, userId)?.role === 'lead'
      ? db.all(`SELECT id, display_name FROM users WHERE role IN ('lead','member') AND disabled_at IS NULL`).map((u) => ({ name: u.display_name, me: u.id === userId, ...pushStats(db, u.id, { since: at - 7 * 24 * H }) }))
        .sort((a, b) => b.pushes - a.pushes || b.items - a.items)
      : null };
}
