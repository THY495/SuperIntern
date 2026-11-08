// 入站触发：项目外面来的需求 → 「添加任务」的同一道门（project-append.mjs 的 requestAppend）。
//
// 看板按部署文档装在内网，GitHub 的 webhook 送不进来（2026-10-20 用户定）→ issue 由守护进程**轮询**：
//   负责人在「项目设置 → 入站」配一个仓库 + 一个标签 → 带这个标签、开着的 issue，每条起草一轮「添加任务」。
//   - 授权来自配它的负责人：入口关了、配的人没有添加权限了，排着的也不再起草（originProblem）。
//   - issue 正文是外部文本：给规划器时围起来、写明不是指令；批准事项开头写来源；**自动挡也要人批**。
//   - 需求出处：作者对得上这个项目的人（负责人 / 成员）就记在他名下（做完叫他签收），对不上记在配入口的人名下。
//   - 只读：不在 issue 上回帖、不改标签。处理过哪几条记在项目参数里，守护进程重启不重复起草。
//   - 一次最多排 ISSUE_BATCH 条（含正在起草 / 等批的那一条）：刚打开入口时仓库里可能已经有一堆带标签的，别一口气排满。
// 与 PR 轮询共用 ghGet（ETag 条件请求）、额度地板与退避（gate 由守护进程传进来，两边共用一个"额度不够就整体等"）。
// 定时任务在下面 schedules 一节。

import { createHash } from 'node:crypto';
import { audit, now } from '../db/db.mjs';
import { getProjectParam, writeParam, setParam } from './params.mjs';
import { resolveCredential } from './credentials.mjs';
import { ghGet, memberForGithub, BACKOFF, RATE_FLOOR } from './pr-watch.mjs';
import { requestAppend, appendStateOf } from '../agent/project-append.mjs';
import { ISSUES_KEY, issueConfigOf, SCHEDULES_KEY, schedulesOf } from './append-origins.mjs';
import { parseCron, nextRun } from './cron.mjs';
import { deployTz } from './calendar.mjs';
import { tl, contentLang, I18nError, N_ } from '../i18n/index.mjs';

const MIN = 60_000;
export { ISSUES_KEY, issueConfigOf };
export const ISSUES_SEEN_KEY = 'inbound.issues_seen';   // { [number]: { at, title, queued?: id, carrier?: id, skipped?: why } }
export const ISSUES_STATE_KEY = 'inbound.issues_state'; // 最近一次看的结果 { at, error, credential, open, drafted }
export const ISSUE_CADENCE = 5 * MIN;
export const ISSUE_BATCH = 3;
export const ISSUE_BODY_MAX = 6000;
const PER_TICK = 3;
const PER_PAGE = 50;
const HEARTBEAT = 60 * MIN;     // 没变化也隔这么久写一次"刚看过"（看板上的"几分钟前看过"不至于一直停在一小时前）
const SYS = { kind: 'agent', id: 'system' };
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** 负责人开 / 关 / 改 issue 入口。repo 'owner/repo'；label 区分大小写照 GitHub */
export function setIssueInbound(db, { projectId, userId, repo, label, on = true, at = now() }) {
  const p = db.one(`SELECT owner_id FROM projects WHERE id=?`, projectId);
  if (!p) throw new I18nError('项目不存在：{id}', { id: projectId });
  if (p.owner_id !== userId) throw new I18nError('只有该项目的负责人能执行此操作');
  const cur = issueConfigOf(db, projectId);
  const r = String(repo ?? cur?.repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const l = String(label ?? cur?.label ?? '').trim();
  if (on && !REPO_RE.test(r)) throw new I18nError('仓库要写成 owner/repo（GitHub 上的那个）');
  if (on && !l) throw new I18nError('要写一个标签：带这个标签的 issue 才会变成草稿');
  if (l.length > 50) throw new I18nError('标签太长了（GitHub 上限 50 个字）');
  const value = { repo: r, label: l, on: !!on, by: on ? userId : cur?.by ?? userId, at };
  writeParam(db, { projectId, key: ISSUES_KEY, value, by: { kind: 'user', id: userId }, governance: 'constitutional', layer: 'project', at });
  audit(db, { actorKind: 'user', actorId: userId, action: on ? 'inbound_issues_on' : 'inbound_issues_off', targetType: 'project', targetId: projectId, payload: { repo: r, label: l } });
  return value;
}

/** issue → 起草用的需求原文（标题 + 正文，正文截断） */
export function issueBrief(issue) {
  const body = String(issue.body ?? '').replace(/\r\n/g, '\n').trim();
  const cut = body.length > ISSUE_BODY_MAX;
  return `${String(issue.title ?? '').trim()}\n\n${cut ? `${body.slice(0, ISSUE_BODY_MAX)}\n…（后面还有 ${body.length - ISSUE_BODY_MAX} 字没带上，见 issue 原文）` : body || '（issue 没写正文）'}`;
}

/** 正在起草 / 等批 / 排着的、来自 issue 的有几条 */
function issuesInFlight(db, projectId) {
  const st = appendStateOf(db, projectId);
  if (!st) return 0;
  const cur = st.origin?.kind === 'github_issue' && ['drafting', 'proposed'].includes(st.stage) ? 1 : 0;
  return cur + (st.queue ?? []).filter((x) => x.origin?.kind === 'github_issue').length;
}

/** 看一次的结果（不含网络）：把新 issue 送进添加任务的门。返回这一次起草 / 排队了哪几条 */
export function intakeIssues(db, { projectId, issues, complete = true, at = now() }) {
  const cfg = issueConfigOf(db, projectId);
  if (!cfg?.on) return { drafted: [], skipped: [] };
  const seen = { ...(getProjectParam(db, projectId, ISSUES_SEEN_KEY) ?? {}) };
  const L = contentLang(db);
  const drafted = [], skipped = [];
  let room = ISSUE_BATCH - issuesInFlight(db, projectId);
  for (const i of issues) {
    if (i.pull_request || seen[i.number]) continue;     // issues 接口把 PR 也列进来
    if (room <= 0) break;                                // 剩下的下一次再看（不记 seen）
    const author = { login: i.user?.login ?? null, id: i.user?.id ?? null, bot: i.user?.type === 'Bot', member: null };
    const m = author.bot ? null : memberForGithub(db, { id: author.id, login: author.login });
    // 作者是这个项目的人（负责人 / 成员）→ 需求记在他名下；别的（外部、只是部署里的成员但不在这个项目）记在开入口的人名下
    if (m && db.one(`SELECT 1 AS x FROM projects WHERE id=? AND (owner_id=? OR EXISTS (SELECT 1 FROM project_members WHERE project_id=? AND user_id=?))`, projectId, m, projectId, m)) author.member = m;
    const origin = { kind: 'github_issue', repo: cfg.repo, number: i.number, url: i.html_url ?? `https://github.com/${cfg.repo}/issues/${i.number}`, title: String(i.title ?? '').slice(0, 200), author };
    try {
      const r = requestAppend(db, { projectId, userId: author.member ?? cfg.by, brief: issueBrief(i), origin });
      seen[i.number] = { at, title: origin.title, ...(r.queued ? { queued: true } : { carrier: r.carrierId }) };
      drafted.push(i.number); room--;
    } catch (e) {
      // 项目不在能加任务的状态（还没批方案、归档了…）：这条先不记，状态好了再看；别的错记下来不再重试
      const why = e instanceof I18nError ? tl(L, e.message, e.params ?? {}) : String(e.message);
      if (/状态为|已归档/.test(e.message)) { skipped.push({ number: i.number, why, retry: true }); break; }
      seen[i.number] = { at, title: origin.title, skipped: why.slice(0, 200) };
      skipped.push({ number: i.number, why });
    }
  }
  // 排着、还没开始起草的：issue 关了或摘了标签（这次的清单里没有它了）→ 从队里拿掉。只在清单是全的时候做（超过一页就不知道没列出来的是不是还开着）。
  // 正在起草 / 等批的那一轮不动：它已经在负责人面前，要不要由负责人在批准事项里定。
  const dropped = [];
  if (complete) {
    const open = new Set(issues.filter((i) => !i.pull_request).map((i) => i.number));
    const st = appendStateOf(db, projectId);
    const keep = (st?.queue ?? []).filter((x) => !(x.origin?.kind === 'github_issue' && x.origin.repo === cfg.repo && !open.has(x.origin.number) && dropped.push(x.origin.number)));
    if (dropped.length) {
      setParam(db, { taskId: st.carrierId, key: 'append.queue', value: keep, by: SYS, governance: 'execution' });
      for (const n of dropped) if (seen[n]) seen[n] = { ...seen[n], queued: false, dropped: true, droppedAt: at };
      audit(db, { actorKind: 'system', action: 'inbound_issues_unqueued', targetType: 'project', targetId: projectId, payload: { repo: cfg.repo, issues: dropped } });
    }
  }
  if (drafted.length || dropped.length || skipped.some((s) => !s.retry)) {
    writeParam(db, { projectId, key: ISSUES_SEEN_KEY, value: seen, by: SYS, governance: 'execution', layer: 'project', at });
    audit(db, { actorKind: 'system', action: 'inbound_issues_intake', targetType: 'project', targetId: projectId, payload: { repo: cfg.repo, drafted, skipped: skipped.map((s) => s.number) } });
  }
  return { drafted, skipped, dropped };
}

/** 开着 issue 入口的项目 */
export function watchedIssueProjects(db) {
  return db.all(`SELECT id FROM projects WHERE archived_at IS NULL AND status IN ('active','stalled','done')`)
    .map((p) => ({ projectId: p.id, cfg: issueConfigOf(db, p.id) })).filter((x) => x.cfg?.on && REPO_RE.test(x.cfg.repo ?? ''));
}

const digest = (s) => createHash('sha1').update(JSON.stringify({ ...s, at: 0 })).digest('hex');

/**
 * 守护进程里的 issue 轮询器。gate：{ holdUntil } 与 PR 轮询器共用（额度不够两边一起等）。
 * 内存里记节奏、ETag、失败次数；处理过哪几条在库里（重启不重复起草）。
 */
export function makeIssueWatcher(db, { fetchFn = globalThis.fetch, env = process.env, gate = { holdUntil: 0 }, perTick = PER_TICK } = {}) {
  const etags = new Map(), due = new Map(), fails = new Map();
  async function pollOne({ projectId, cfg }, at) {
    const prev = getProjectParam(db, projectId, ISSUES_STATE_KEY) ?? null;
    let next, out = { drafted: [], skipped: [], dropped: [] };
    try {
      const conn = await resolveCredential(db, { remote: `https://github.com/${cfg.repo}.git`, action: 'poll_issues', actorId: null, env, fetchFn, at });
      conn.cleanup();
      if (!conn.apiToken) {
        next = { at, error: { msg: N_('没有能读 {repo} 的 issue 的连接：到「设置 → 连接」装 GitHub App（要给 Issues 读权限），或加一个部署级令牌'), params: { repo: cfg.repo } }, credential: null };
      } else {
        const url = `${conn.apiBase}/repos/${cfg.repo}/issues?state=open&labels=${encodeURIComponent(cfg.label)}&sort=created&direction=asc&per_page=${PER_PAGE}`;
        const r = await ghGet(url, { token: conn.apiToken, fetchFn, etags });
        if (r.rate?.remaining != null && r.rate.remaining < RATE_FLOOR && r.rate.reset) gate.holdUntil = Math.max(gate.holdUntil, r.rate.reset);
        if (r.status === 404) next = { at, error: { msg: N_('GitHub 上找不到 {repo}：仓库名写错了，或者连接看不到它（App 没装到这个仓库）'), params: { repo: cfg.repo } }, credential: conn.credential?.name ?? null };
        else if (r.status === 403 || r.status === 401) next = { at, error: { msg: N_('连接（{c}）没有读 {repo} 的 issue 的权限：GitHub App 要给 Issues 读权限'), params: { c: conn.credential?.name ?? '?', repo: cfg.repo } }, credential: conn.credential?.name ?? null };
        else if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`HTTP ${r.status}`);
        else {
          const issues = r.body.filter((i) => !i.pull_request);
          out = intakeIssues(db, { projectId, issues, complete: r.body.length < PER_PAGE, at });
          next = { at, error: null, credential: conn.credential?.name ?? null, open: issues.length, label: cfg.label, repo: cfg.repo };
        }
      }
      fails.set(projectId, next.error ? (fails.get(projectId) ?? 0) + 1 : 0);
    } catch (e) {
      const n = (fails.get(projectId) ?? 0) + 1;
      fails.set(projectId, n);
      if (e.rate?.remaining === 0 && e.rate.reset) gate.holdUntil = Math.max(gate.holdUntil, e.rate.reset);
      next = { at, error: { msg: N_('读 issue 失败：{why}（{n} 次了，按退避再试）'), params: { why: String(e.message).slice(0, 200), n } }, credential: prev?.credential ?? null };
    }
    if (!prev || digest(prev) !== digest(next) || at - (prev.at ?? 0) >= HEARTBEAT || out.drafted.length || out.dropped.length) {
      writeParam(db, { projectId, key: ISSUES_STATE_KEY, value: next, by: SYS, governance: 'execution', layer: 'project', at });
      if (!!prev?.error !== !!next.error) audit(db, { actorKind: 'system', action: next.error ? 'inbound_issues_failing' : 'inbound_issues_ok', targetType: 'project', targetId: projectId, payload: { repo: cfg.repo, error: next.error?.msg ?? null } });
    }
    const f = fails.get(projectId) ?? 0;
    due.set(projectId, at + (f ? BACKOFF[Math.min(f, BACKOFF.length) - 1] : ISSUE_CADENCE));
    return { ...next, ...out };
  }
  return {
    async tick(at = now()) {
      if (at < gate.holdUntil) return 0;
      const items = watchedIssueProjects(db).filter((x) => (due.get(x.projectId) ?? 0) <= at)
        .sort((a, b) => (due.get(a.projectId) ?? 0) - (due.get(b.projectId) ?? 0)).slice(0, perTick);
      for (const it of items) { await pollOne(it, at); if (at < gate.holdUntil) break; }
      return items.length;
    },
    /** 看板上点「立即看一次」、刚打开入口 */
    async pollNow(projectId, at = now()) {
      const it = watchedIssueProjects(db).find((x) => x.projectId === projectId);
      return it ? pollOne(it, at) : null;
    },
    _state: () => ({ due, fails, etags, gate }),
  };
}

/** 看板「项目设置 → 入站」要的 */
export function inboundView(db, projectId) {
  const cfg = issueConfigOf(db, projectId);
  const seen = getProjectParam(db, projectId, ISSUES_SEEN_KEY) ?? {};
  const st = getProjectParam(db, projectId, ISSUES_STATE_KEY);
  const byName = (id) => (id ? db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id : null);
  return {
    issues: cfg ? { ...cfg, byName: byName(cfg.by) } : null,
    state: st ?? null,
    seen: Object.entries(seen).map(([n, v]) => ({ number: Number(n), ...v })).sort((a, b) => b.at - a.at).slice(0, 30),
    inFlight: issuesInFlight(db, projectId), batch: ISSUE_BATCH,
    schedules: scheduleView(db, projectId),
  };
}

// ── 定时任务──────────────────────────────────────────────────────────
// 负责人写一段需求 + 一个 cron（部署时区）→ 到点起草一轮「添加任务」。需求是负责人自己写的，所以跟人敲的一样走挡位
// （提议挡等人批；自动挡且前提都满足就直接开工）—— 只有 issue 那种外部文本才强制人批。
//   - 守护进程没开着错过了几次：补一次，不连补。
//   - 上一次起草的还没批 / 还排着：这一次跳过（记下来），不往队里越堆越多。
//   - 项目这会儿不能加任务（方案还没批、归档了）：这一次跳过，记下原因。
export { SCHEDULES_KEY, schedulesOf };
export const SCHEDULE_RUNS_KEY = 'inbound.schedule_runs';   // { [id]: { last, result: 'drafted'|'queued'|'skipped', why? } }
export const SCHEDULE_MAX = 10;

/** 负责人加 / 改（带 id）一个定时任务 */
export function setSchedule(db, { projectId, userId, id = null, name, cron, brief, on = undefined, at = now() }) {
  const p = db.one(`SELECT owner_id FROM projects WHERE id=?`, projectId);
  if (!p) throw new I18nError('项目不存在：{id}', { id: projectId });
  if (p.owner_id !== userId) throw new I18nError('只有该项目的负责人能执行此操作');
  const list = schedulesOf(db, projectId);
  const cur = id ? list.find((s) => s.id === id) : null;
  if (id && !cur) throw new I18nError('没有这个定时任务：{id}', { id });
  const n = String(name ?? cur?.name ?? '').trim(), b = String(brief ?? cur?.brief ?? '').trim(), c = String(cron ?? cur?.cron ?? '').trim();
  if (!n) throw new I18nError('定时任务要有个名字（比如「每周依赖升级」）');
  if (!b) throw new I18nError('要写清每次让 AI 做什么（会像「添加任务」那样起草）');
  parseCron(c);
  if (!cur && list.length >= SCHEDULE_MAX) throw new I18nError('一个项目最多 {n} 个定时任务', { n: SCHEDULE_MAX });
  const item = { id: cur?.id ?? `sc_${createHash('sha1').update(`${projectId}|${n}|${at}|${Math.random()}`).digest('hex').slice(0, 10)}`,
    name: n.slice(0, 80), cron: c, brief: b.slice(0, 4000), on: on === undefined ? cur?.on ?? true : !!on, by: userId, at: cur?.at ?? at };
  const next = cur ? list.map((s) => (s.id === cur.id ? item : s)) : [...list, item];
  writeParam(db, { projectId, key: SCHEDULES_KEY, value: next, by: { kind: 'user', id: userId }, governance: 'constitutional', layer: 'project', at });
  // 改了 cron 或重新打开：从现在起算下一次（不把停着期间错过的补上）
  if (!cur || cur.cron !== c || (!cur.on && item.on)) markRun(db, projectId, item.id, { last: at, result: 'set' }, at);
  audit(db, { actorKind: 'user', actorId: userId, action: cur ? 'inbound_schedule_changed' : 'inbound_schedule_added', targetType: 'project', targetId: projectId, payload: { id: item.id, name: item.name, cron: c, on: item.on } });
  return item;
}

export function removeSchedule(db, { projectId, userId, id, at = now() }) {
  const p = db.one(`SELECT owner_id FROM projects WHERE id=?`, projectId);
  if (!p || p.owner_id !== userId) throw new I18nError('只有该项目的负责人能执行此操作');
  const list = schedulesOf(db, projectId);
  const cur = list.find((s) => s.id === id);
  if (!cur) throw new I18nError('没有这个定时任务：{id}', { id });
  writeParam(db, { projectId, key: SCHEDULES_KEY, value: list.filter((s) => s.id !== id), by: { kind: 'user', id: userId }, governance: 'constitutional', layer: 'project', at });
  audit(db, { actorKind: 'user', actorId: userId, action: 'inbound_schedule_removed', targetType: 'project', targetId: projectId, payload: { id, name: cur.name } });
  return { removed: id };
}

function markRun(db, projectId, id, v, at) {
  const runs = { ...(getProjectParam(db, projectId, SCHEDULE_RUNS_KEY) ?? {}), [id]: v };
  writeParam(db, { projectId, key: SCHEDULE_RUNS_KEY, value: runs, by: SYS, governance: 'execution', layer: 'project', at });
}

/** 上一次起草的这个定时任务还没走完（在起草 / 等批 / 排着） */
function scheduleInFlight(db, projectId, id) {
  const st = appendStateOf(db, projectId);
  if (!st) return false;
  if (st.origin?.kind === 'schedule' && st.origin.id === id && ['drafting', 'proposed'].includes(st.stage)) return true;
  return (st.queue ?? []).some((x) => x.origin?.kind === 'schedule' && x.origin.id === id);
}

/** 守护进程每拍调：到点的起草一轮。返回这一拍起草 / 跳过了哪些 */
export function fireSchedules(db, { at = now() } = {}) {
  const tz = deployTz(db);
  const out = [];
  for (const { id: projectId } of db.all(`SELECT id FROM projects WHERE archived_at IS NULL`)) {
    const list = schedulesOf(db, projectId).filter((s) => s.on);
    if (!list.length) continue;
    const runs = getProjectParam(db, projectId, SCHEDULE_RUNS_KEY) ?? {};
    for (const s of list) {
      let due;
      try { due = nextRun(s.cron, runs[s.id]?.last ?? s.at, tz); } catch { continue; }
      if (due == null || due > at) continue;
      const L = contentLang(db);
      let v;
      if (scheduleInFlight(db, projectId, s.id)) v = { last: at, due, result: 'skipped', why: tl(L, '上一次起草的还没批完，这一次不再起草') };
      else {
        try {
          const r = requestAppend(db, { projectId, userId: s.by, brief: s.brief, origin: { kind: 'schedule', id: s.id, name: s.name, cron: s.cron, by: s.by } });
          v = { last: at, due, result: r.queued ? 'queued' : 'drafted' };
        } catch (e) {
          v = { last: at, due, result: 'skipped', why: (e instanceof I18nError ? tl(L, e.message, e.params ?? {}) : String(e.message)).slice(0, 200) };
        }
      }
      markRun(db, projectId, s.id, v, at);
      audit(db, { actorKind: 'system', action: 'inbound_schedule_fired', targetType: 'project', targetId: projectId, payload: { id: s.id, name: s.name, ...v } });
      out.push({ projectId, id: s.id, ...v });
    }
  }
  return out;
}

/** 看板用：每个定时任务的下一次、上一次 */
export function scheduleView(db, projectId, at = now()) {
  const tz = deployTz(db);
  const runs = getProjectParam(db, projectId, SCHEDULE_RUNS_KEY) ?? {};
  return schedulesOf(db, projectId).map((s) => {
    let next = null; try { next = s.on ? nextRun(s.cron, Math.max(runs[s.id]?.last ?? s.at, at - 1), tz) : null; } catch { /* 存进去时校验过 */ }
    return { ...s, byName: db.one(`SELECT display_name FROM users WHERE id=?`, s.by)?.display_name ?? s.by, next, last: runs[s.id]?.result === 'set' ? null : runs[s.id] ?? null, tz };
  });
}
