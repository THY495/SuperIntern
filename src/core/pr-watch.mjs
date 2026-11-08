// 交付后回路：盯着已交付的 PR —— 状态（开着 / 合并 / 关了）、CI（检查与提交状态）、评审与评论。
//
// 看板装在内网、不上公网（2026-10-20 用户定），GitHub 的 webhook 送不进来，所以是守护进程**轮询**：
//   - 每个 PR 一份节奏：CI 还在跑 1 分钟一次，跑完了 5 分钟一次，关了的 30 分钟一次（关了 3 天以后不再看），合并了就停；
//   - 条件请求：每个地址记下 ETag，没变的回 304（不算 GitHub 的限额）；剩余额度不多时整体等到重置；
//   - 出错按 1 / 5 / 15 / 45 分钟退避，一直不好就停在 45 分钟（不刷屏、不打爆限额）。
// 轮询与退避这一层（ghGet、节奏）是给 issue 轮询共用的。
//
// 读用部署级的连接（GitHub App 优先：短期、按仓库收窄），**只读**：系统自己发起的动作不碰成员的连接（防混淆代理）。
// App 没给 checks / statuses / actions 的读权限时降级：PR 状态与评论照看，CI 那一块标"缺什么权限"。
//
// 记在哪：
//   delivery.pr        交付时记下的 PR（任务层或项目层参数）：{ host, owner, repo, number, url, base, branch, head, at, by, tokenId }
//   delivery.pr_state  最近一次看到的样子（只在变了的时候写一行，参数表是带历史的）
import { createHash } from 'node:crypto';
import { audit, now } from '../db/db.mjs';
import { getParam, getProjectParam, writeParam } from './params.mjs';
import { resolveCredential } from './credentials.mjs';
import { HTTP_TIMEOUT_MS } from './http.mjs';
import { githubLoginAdminSet } from './git-identity.mjs';
import { N_ } from '../i18n/index.mjs';

export const PR_KEY = 'delivery.pr';
export const PR_STATE_KEY = 'delivery.pr_state';
export const CI_FIX_KEY = 'delivery.ci_fix';   // 这个 PR 的 CI 修到第几次、这一轮由谁授权、推回去没有（pr-fix.mjs）
const SYS = { kind: 'agent', id: 'system' };
const MIN = 60_000;
export const CADENCE = { pending: 1 * MIN, settled: 5 * MIN, closed: 30 * MIN };
export const BACKOFF = [1 * MIN, 5 * MIN, 15 * MIN, 45 * MIN];
const CLOSED_WATCH_MS = 3 * 24 * 60 * MIN;
const PER_TICK = 6;              // 一拍最多看几个 PR：守护进程的一拍不该被轮询拖长
export const RATE_FLOOR = 50;           // 剩余额度低于这个就整体等到重置
const KEEP_COMMENTS = 60, BODY_MAX = 4000;

// ── 记下交付的 PR ─────────────────────────────────────────────────────────
/** 交付开了 PR 之后调：任务层（taskId）或项目层（projectId）。by / tokenId 是点交付的人与那次的令牌（代修的授权锚点） */
export function recordDeliveredPr(db, { taskId = null, projectId = null, gh, pr, branch, head, userId = null, tokenId = null, signed = false, autofix = true, at = now() }) {
  // signed：交付时这一版签过收。修 CI 之后推回去的关跟这次一样：签过的，新版本也要签
  const value = { host: 'github.com', owner: gh.owner, repo: gh.repo, number: pr.number, url: pr.url, base: pr.base, branch, head, at, by: userId, tokenId, signed: !!signed,
    // autofix：交付人授权了 AI 跟进这个 PR（CI 没过自动修、有权的成员要求修改直接转）。false = 都先问人（认知走查第三轮：开 PR 与授权要能分开选）
    autofix: autofix !== false };
  writeParam(db, { taskId, projectId, key: PR_KEY, value, by: userId ? { kind: 'user', id: userId } : SYS, governance: 'execution', layer: taskId ? 'task' : 'project' });
  return value;
}
/** 推送更新了 PR 的分支（再次交付）：记下新的头 —— CI 结果要按这个头读 */
export function notePrPushed(db, { taskId = null, projectId = null, head, at = now() }) {
  const cur = taskId ? getParam(db, taskId, PR_KEY) : getProjectParam(db, projectId, PR_KEY);
  if (!cur) return null;
  const value = { ...cur, head, pushedAt: at };
  writeParam(db, { taskId, projectId, key: PR_KEY, value, by: SYS, governance: 'execution', layer: taskId ? 'task' : 'project' });
  return value;
}
/** 人答了 CI 没过的事项、要 AI 修（handback.mjs 调）：这一轮由答复人授权，修好照样自动推回，推的人是他；算一次 */
export function noteAnsweredFix(db, { taskId, by, tokenId, messageId, at = now() }) {
  const fix = getParam(db, taskId, CI_FIX_KEY) ?? { attempts: 0 };
  writeParam(db, { taskId, key: CI_FIX_KEY, value: { ...fix, attempts: (fix.attempts ?? 0) + 1, mode: 'auto', by, tokenId, messageId, at, redelivered: null, redeliverError: null }, by: SYS, governance: 'execution', layer: 'task', at });
}
export const prOf = (db, { taskId = null, projectId = null }) => (taskId ? getParam(db, taskId, PR_KEY) : getProjectParam(db, projectId, PR_KEY));
export const prStateOf = (db, { taskId = null, projectId = null }) => (taskId ? getParam(db, taskId, PR_STATE_KEY) : getProjectParam(db, projectId, PR_STATE_KEY));

/** 要盯的 PR：记过 delivery.pr、还没合并、关了不到 3 天的 */
export function watchedPrs(db, { at = now() } = {}) {
  const rows = db.all(`SELECT task_id, project_id, value FROM params WHERE key=? AND superseded_at IS NULL`, PR_KEY);
  const out = [];
  for (const r of rows) {
    let pr; try { pr = JSON.parse(r.value); } catch { continue; }
    if (!pr?.number || !pr.owner) continue;
    const ref = r.task_id ? { taskId: r.task_id } : { projectId: r.project_id };
    const st = prStateOf(db, ref);
    if (st?.state === 'merged') continue;
    if (st?.state === 'closed' && st.closedAt && at - st.closedAt > CLOSED_WATCH_MS) continue;
    out.push({ key: r.task_id ? `t:${r.task_id}` : `p:${r.project_id}`, ...ref, pr, state: st });
  }
  return out;
}

// ── GitHub 读（条件请求 + 额度）──────────────────────────────────────────
/**
 * GET 一个 GitHub 接口。etags：Map(url → { etag, body })，命中时带 If-None-Match，304 就用缓存的。
 * 返回 { status, body, notModified, rate: { remaining, reset } }；网络错误抛出（调用方退避）。
 */
export async function ghGet(url, { token, fetchFn = globalThis.fetch, etags = null, accept = 'application/vnd.github+json', text = false }) {
  const hit = etags?.get(url);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'superintern', ...(hit?.etag ? { 'if-none-match': hit.etag } : {}) } });
  const h = (k) => res.headers?.get?.(k) ?? null;
  const rate = { remaining: h('x-ratelimit-remaining') == null ? null : Number(h('x-ratelimit-remaining')), reset: h('x-ratelimit-reset') == null ? null : Number(h('x-ratelimit-reset')) * 1000 };
  if (res.status === 304 && hit) return { status: 200, body: hit.body, notModified: true, rate };
  const body = text ? await res.text().catch(() => '') : await res.json().catch(() => null);
  const etag = h('etag');
  if (res.ok && etag && etags) etags.set(url, { etag, body });
  return { status: res.status, body, notModified: false, rate };
}

// ── 看一次 ────────────────────────────────────────────────────────────────
/** GitHub 账号 → 成员：按绑定的数字 id；没绑的按管理员填的账号名（自己填的不认，防冒领）。停用的不算 */
export function memberForGithub(db, { id = null, login = null }) {
  let u = id != null ? db.one(`SELECT id, disabled_at FROM users WHERE github_id=?`, id) : null;
  if (!u && login) {
    const c = db.one(`SELECT id, disabled_at FROM users WHERE lower(github_login)=lower(?) AND github_id IS NULL`, login);
    if (c && githubLoginAdminSet(db, c.id, login)) u = c;
  }
  return u && !u.disabled_at ? u.id : null;
}

const CI_FAIL = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
/** 检查（check runs）+ 提交状态（statuses）→ 一个总状态：failure 只要有一条失败；pending 有没跑完的；success 全过；none 什么都没有 */
export function ciSummary(checks, statuses) {
  const items = [
    ...checks.map((c) => ({ kind: 'check', id: c.id, name: c.name, app: c.app?.slug ?? null, url: c.html_url ?? c.details_url ?? null, detailsUrl: c.details_url ?? null,
      state: c.status !== 'completed' ? 'pending' : CI_FAIL.has(c.conclusion) ? 'failure' : 'success', conclusion: c.conclusion ?? null,
      title: c.output?.title ?? null, summary: String(c.output?.summary ?? '').slice(0, 2000) || null })),
    ...statuses.map((s) => ({ kind: 'status', id: null, name: s.context, app: null, url: s.target_url ?? null, detailsUrl: s.target_url ?? null,
      state: s.state === 'pending' ? 'pending' : s.state === 'success' ? 'success' : 'failure', conclusion: s.state, title: s.description ?? null, summary: null })),
  ];
  const state = !items.length ? 'none' : items.some((x) => x.state === 'failure') ? 'failure' : items.some((x) => x.state === 'pending') ? 'pending' : 'success';
  return { state, items };
}

const isBot = (u) => u?.type === 'Bot' || /\[bot\]$/i.test(String(u?.login ?? ''));
const person = (db, u) => ({ login: u?.login ?? null, id: u?.id ?? null, bot: isBot(u), member: isBot(u) ? null : memberForGithub(db, { id: u?.id ?? null, login: u?.login ?? null }) });

/**
 * 看一个 PR 一次：PR 本身、头提交的检查与状态、评审、两种评论。返回新的 state（没写库）。
 * 缺权限的那一块不算错：记进 missing，别的照看。
 */
export async function readPr(db, { pr, token, apiBase = 'https://api.github.com', fetchFn = globalThis.fetch, etags = null, prev = null, at = now() }) {
  const repo = `${apiBase}/repos/${pr.owner}/${pr.repo}`;
  const missing = [];
  let minRate = null;
  const get = async (path, need) => {
    const r = await ghGet(`${repo}${path}`, { token, fetchFn, etags });
    if (r.rate.remaining != null && (minRate == null || r.rate.remaining < minRate.remaining)) minRate = r.rate;
    if (r.status === 403 || r.status === 404) {
      if (need) missing.push(need);
      return null;
    }
    if (r.status >= 400) throw Object.assign(new Error(`GitHub ${path}: HTTP ${r.status}`), { status: r.status, rate: r.rate });
    return r.body;
  };
  const p = await get(`/pulls/${pr.number}`, null);
  if (!p) throw Object.assign(new Error(`GitHub /pulls/${pr.number}: not found`), { status: 404, gone: true });
  const head = p.head?.sha ?? pr.head;
  const runs = await get(`/commits/${head}/check-runs?per_page=100`, 'checks:read');
  const st = await get(`/commits/${head}/status`, 'statuses:read');
  const reviews = (await get(`/pulls/${pr.number}/reviews?per_page=100`, 'pull_requests:read')) ?? [];
  const issueComments = (await get(`/issues/${pr.number}/comments?per_page=100`, 'pull_requests:read')) ?? [];
  const lineComments = (await get(`/pulls/${pr.number}/comments?per_page=100`, 'pull_requests:read')) ?? [];
  const ci = ciSummary(runs?.check_runs ?? [], st?.statuses ?? []);
  const state = p.merged || p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open';
  const body = (s) => String(s ?? '').slice(0, BODY_MAX);
  const comments = [
    ...reviews.filter((r) => r.state !== 'PENDING' && (r.body || r.state === 'CHANGES_REQUESTED' || r.state === 'APPROVED'))
      .map((r) => ({ id: `review:${r.id}`, kind: 'review', reviewState: r.state, author: person(db, r.user), body: body(r.body), url: r.html_url ?? null, at: Date.parse(r.submitted_at) || null, commit: r.commit_id ?? null })),
    ...issueComments.map((c) => ({ id: `issue:${c.id}`, kind: 'comment', author: person(db, c.user), body: body(c.body), url: c.html_url ?? null, at: Date.parse(c.created_at) || null })),
    ...lineComments.map((c) => ({ id: `line:${c.id}`, kind: 'line', review: c.pull_request_review_id ?? null, path: c.path ?? null, line: c.line ?? c.original_line ?? null,
      author: person(db, c.user), body: body(c.body), url: c.html_url ?? null, at: Date.parse(c.created_at) || null })),
  ].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).slice(-KEEP_COMMENTS);
  return {
    at, state, head, title: p.title ?? null, mergeable: p.mergeable ?? null,
    closedAt: state === 'closed' ? (Date.parse(p.closed_at) || prev?.closedAt || at) : null,
    ci: { state: missing.includes('checks:read') && missing.includes('statuses:read') ? 'unknown' : ci.state, items: ci.items, head },
    comments, missing: [...new Set(missing)], rate: minRate, error: null,
  };
}

/** 变没变（决定写不写一行参数）：时间、额度不算 */
export const stateDigest = (s) => createHash('sha1').update(JSON.stringify({ ...s, at: 0, rate: null, errorAt: null })).digest('hex');

// ── 节奏 ──────────────────────────────────────────────────────────────────
export function nextDelay(state, fails = 0) {
  if (fails > 0) return BACKOFF[Math.min(fails, BACKOFF.length) - 1];
  if (!state || state.state === 'open') return state?.ci?.state === 'pending' || !state ? CADENCE.pending : CADENCE.settled;
  if (state.state === 'closed') return CADENCE.closed;
  return null;   // merged：不再看
}

/**
 * 守护进程里的轮询器。tick(at) 看到期的那几个 PR；onChange(item, prev, next) 给代修与评审跟进接（CI 失败、新评审）。
 * 内存里记节奏、ETag、失败次数 —— 守护进程重启就从头来一遍（多看一次，不会漏）。
 */
export function makePrWatcher(db, { fetchFn = globalThis.fetch, env = process.env, onChange = async () => {}, perTick = PER_TICK, gate = { holdUntil: 0 } } = {}) {
  const etags = new Map(), due = new Map(), fails = new Map();
  // gate：额度不够就整体等到重置 —— 与 issue 轮询器共用一个，两边用的是同一份 App 额度
  async function pollOne(item, at) {
    const remote = `https://${item.pr.host ?? 'github.com'}/${item.pr.owner}/${item.pr.repo}.git`;
    const prev = item.state ?? null;
    let next, get = null;
    try {
      let conn = await resolveCredential(db, { remote, action: 'poll', actorId: null, env, fetchFn, at });
      let degraded = false;
      if (!conn.apiToken) {
        // App 没给 checks / statuses / actions 的读权限：换一份只要 PR 读权限的令牌，CI 那一块标缺
        conn.cleanup();
        const basic = await resolveCredential(db, { remote, action: 'poll_basic', actorId: null, env, fetchFn, at });
        if (basic.apiToken) { conn = basic; degraded = true; } else { basic.cleanup(); }
      }
      conn.cleanup();
      if (!conn.apiToken) {
        next = { ...(prev ?? {}), at, error: { msg: N_('没有能读 {repo} 的连接：到「设置 → 连接」装 GitHub App（或加一个部署级令牌），PR 的状态、CI 与评论才看得到'), params: { repo: `${item.pr.owner}/${item.pr.repo}` } } };
      } else {
        const token = conn.apiToken, base = `${conn.apiBase}/repos/${item.pr.owner}/${item.pr.repo}`;
        get = (path, o = {}) => ghGet(`${base}${path}`, { token, fetchFn, ...o });
        next = await readPr(db, { pr: item.pr, token, apiBase: conn.apiBase, fetchFn, etags, prev, at });
        if (degraded) next.missing = [...new Set([...next.missing, 'checks:read', 'statuses:read', 'actions:read'])], next.ci.state = 'unknown';
        next.credential = conn.credential?.name ?? null;
        if (next.rate?.remaining != null && next.rate.remaining < RATE_FLOOR && next.rate.reset) gate.holdUntil = Math.max(gate.holdUntil, next.rate.reset);
      }
      fails.set(item.key, next.error ? (fails.get(item.key) ?? 0) + 1 : 0);
    } catch (e) {
      const n = (fails.get(item.key) ?? 0) + 1;
      fails.set(item.key, n);
      if (e.rate?.remaining === 0 && e.rate.reset) gate.holdUntil = Math.max(gate.holdUntil, e.rate.reset);
      next = { ...(prev ?? {}), at, error: e.gone
        ? { msg: N_('GitHub 上找不到这个 PR（#{n}）：可能被删了，或者连接看不到这个仓库'), params: { n: item.pr.number } }
        : { msg: N_('读 PR 失败：{why}（{n} 次了，按退避再试）'), params: { why: String(e.message).slice(0, 200), n } } };
    }
    const changed = !prev || stateDigest(prev) !== stateDigest(next);
    if (changed) {
      const ref = item.taskId ? { taskId: item.taskId } : { projectId: item.projectId };
      writeParam(db, { ...ref, key: PR_STATE_KEY, value: next, by: SYS, governance: 'execution', layer: item.taskId ? 'task' : 'project', at });
      if (!prev || prev.state !== next.state || prev.ci?.state !== next.ci?.state || prev.head !== next.head || !!prev.error !== !!next.error) {
        audit(db, { actorKind: 'system', action: 'pr_state_changed', targetType: item.taskId ? 'task' : 'project', targetId: item.taskId ?? item.projectId,
          payload: { pr: item.pr.number, repo: `${item.pr.owner}/${item.pr.repo}`, state: next.state ?? null, ci: next.ci?.state ?? null, head: next.head ?? null, missing: next.missing ?? [], error: next.error?.msg ?? null } });
      }
      await onChange({ ...item, state: next }, prev, next, { get, at });
    }
    const d = nextDelay(next.state ? next : null, fails.get(item.key) ?? 0);
    if (d == null) due.delete(item.key); else due.set(item.key, at + d);
    return next;
  }
  return {
    /** 到期的看一遍。返回这一拍看了几个 */
    async tick(at = now()) {
      if (at < gate.holdUntil) return 0;
      const items = watchedPrs(db, { at }).filter((x) => (due.get(x.key) ?? 0) <= at)
        .sort((a, b) => (due.get(a.key) ?? 0) - (due.get(b.key) ?? 0)).slice(0, perTick);
      for (const it of items) { await pollOne(it, at); if (at < gate.holdUntil) break; }
      return items.length;
    },
    /** 马上看这一个（再次交付之后、人在看板上点"刷新"） */
    async pollNow(ref, at = now()) {
      const it = watchedPrs(db, { at }).find((x) => (ref.taskId && x.taskId === ref.taskId) || (ref.projectId && x.projectId === ref.projectId));
      return it ? pollOne(it, at) : null;
    },
    _state: () => ({ due, fails, holdUntil: gate.holdUntil, etags }),
  };
}
