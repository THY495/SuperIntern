// 运行期不变量。
//
// 系统里有几条"任何时候都该成立"的事：没结束的任务说得出在等谁、状态列与审计轨对得上、执行器碰不到系统自己的数据、
// 花费没越过闸门、"正在处理"的标记有活着的持有者。原来它们要么散在各处顺带查（停等账本每拍扫一遍），
// 要么只有人想起来跑 `replay` 才查，要么根本没人查。这里把它们登记成一张表：每条有自己的周期、自己的查法，
// 守护进程到点就查，结果写进 invariant_state（v44），健康卡读它；从对到错、从错到对各写一条审计，守护进程据此告诉管理员。
//
// 约定：
//   - 查法只读库（停等那条借用 liveness 的判断，挂事项仍归 liveness 的扫描做）。
//   - 返回事实，不返回句子：{ checked, violations: [{ ref, ...事实 }] }。文字由看板 / 命令行按语言写。
//   - 一条查炸了不影响别的条；记下错误，健康卡显示"没查成"。

import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { now, audit, openDb } from '../db/db.mjs';
import { TRANSITIONS } from '../db/state.mjs';
import { LEASE_TTL_MS, LEASE_RENEW_MS } from '../db/lease.mjs';
import { pidAlive } from './proc.mjs';
import { stuckNow, openLivenessQuestions } from './liveness.mjs';
import { limitOf } from './limits.mjs';
import { deploymentSpend, deploymentBudget, personSpend, personBudget } from './spend.mjs';
import { deployTz } from './calendar.mjs';
import { monthKey } from './tz.mjs';
import { getSetting } from './settings.mjs';
import { managementPaths, exposedBy } from './mgmt-paths.mjs';
import { fmtUsd } from './project-settings.mjs';
import { tl } from '../i18n/index.mjs';
import { RECHECKS } from './rechecks.mjs';

const MIN = 60_000;
const SAMPLE = 20;   // 每条最多存几个违反的例子

// 预算闸门的容差：任务上限每轮判一次，一轮里并行的几次调用可以一起越过 —— 超出 50% 以上还没触发闸门才算失灵。
// 月度预算是每次调用前在写锁里预占的，几乎不会越过，留 20%。
export const BUDGET_SLACK = { task: 1.5, month: 1.2 };

/** 某张带状态的表：每行的状态与审计轨里最后一次记下的状态转换对得上吗（只看有过转换审计的行） */
function statusDrift(db, table) {
  const states = Object.keys(TRANSITIONS[table]);
  const inList = states.map(() => '?').join(',');
  const rows = db.all(`SELECT t.id, t.status, (SELECT json_extract(a.payload,'$.to') FROM audit_log a
      WHERE a.target_id=t.id AND json_extract(a.payload,'$.to') IN (${inList}) AND json_extract(a.payload,'$.from') IN (${inList})
      ORDER BY a.id DESC LIMIT 1) AS last_to FROM ${table} t`, ...states, ...states);
  return { checked: rows.length, bad: rows.filter((r) => r.last_to != null && r.last_to !== r.status).map((r) => ({ ref: r.id, table, status: r.status, audited: r.last_to })) };
}

// 库层护栏（状态迁移触发器、只增不改的审计 / 账本 / 参数……）：新建库里有的，这个库也得有。
// v16 迁移重建 params 时丢过 trg_params_no_delete，直到人工核对才发现 —— 这一条就是为那类事。新建库每个进程只建一次
let expectedTriggers = null;
function missingTriggers(db) {
  if (!expectedTriggers) {
    const fresh = openDb(':memory:');
    try { expectedTriggers = fresh.all(`SELECT name FROM sqlite_master WHERE type='trigger'`).map((r) => r.name); } finally { fresh.close(); }
  }
  const have = new Set(db.all(`SELECT name FROM sqlite_master WHERE type='trigger'`).map((r) => r.name));
  return { checked: expectedTriggers.length, missing: expectedTriggers.filter((n) => !have.has(n)) };
}

export const INVARIANTS = [
  {
    // 停等账本：每个没结束的任务说得出在等谁。liveness 每拍扫、挂事项给负责人；这里看"现在有没有违反"：
    // 刚查出还没挂上的，加上挂了还没人处理的
    // 违反着时每分钟查（人答复、任务重起后违例又挂了 9 分钟 —— 恢复要等下一个 10 分钟）
    id: 'liveness', everyMs: 10 * MIN, recheckMs: MIN, level: 'warn',
    check(db, { at, assess, assessOpts = {} }) {
      if (getSetting(db, 'deploy.paused')) return { checked: 0, violations: [], skipped: 'paused' };   // 急停时所有任务都"静止"，那是管理员的意思
      if (typeof assess !== 'function') return { checked: 0, violations: [], skipped: 'no_assess' };
      const stuck = stuckNow(db, { at, assess, ...assessOpts });
      const open = openLivenessQuestions(db);
      const seen = new Set();
      const violations = [];
      for (const s of stuck) { seen.add(s.taskId); violations.push({ ref: s.taskId, title: s.title ?? null, idleMin: s.idleMin, state: 'unreported' }); }
      for (const q of open) if (!seen.has(q.task_id)) { seen.add(q.task_id); violations.push({ ref: q.task_id, questionId: q.id, state: 'reported' }); }
      return { checked: db.one(`SELECT count(*) n FROM tasks WHERE status NOT IN ('done','aborted')`).n, violations };
    },
  },
  {
    // 投影漂移：状态列是审计轨的投影。每次状态转换都经 transition() 写一行带 from/to 的审计（v25 起），
    // 状态列与最后一次转换对不上 = 有代码绕过了它。done 的步骤必须有交接记录（库层触发器也管，这里独立复核）。
    // 护栏本身也查：触发器少了，上面两条以后就拦不住了。
    // v25 以前状态可以裸写，老库里有历史漂移（试用库每个都有一两条）：第一次查时记作基线、之后不报；护栏缺失不进基线
    id: 'projection', everyMs: 60 * MIN, level: 'warn', baseline: (v) => v.kind !== 'missing_trigger',
    check(db) {
      const tr = missingTriggers(db);
      let checked = tr.checked; const violations = tr.missing.map((name) => ({ ref: name, kind: 'missing_trigger' }));
      for (const table of Object.keys(TRANSITIONS)) { const r = statusDrift(db, table); checked += r.checked; violations.push(...r.bad); }
      for (const n of db.all(`SELECT id FROM nodes n WHERE status='done' AND NOT EXISTS (SELECT 1 FROM handoffs h WHERE h.node_id=n.id)`)) violations.push({ ref: n.id, table: 'nodes', kind: 'done_without_handoff' });
      return { checked, violations };
    },
  },
  {
    // 执行器可达路径与管理状态不相交：没结束的任务的工作区不能罩住数据目录、状态库、主密钥
    id: 'executor_paths', everyMs: 10 * MIN, level: 'bad',
    check(db, { home }) {
      const paths = managementPaths(db, { home });
      const rows = db.all(`SELECT a.target_id AS task_id, json_extract(a.payload,'$.dir') AS dir FROM audit_log a JOIN tasks t ON t.id=a.target_id
        WHERE a.action='workspace_created' AND t.status<>'aborted'
          AND a.id=(SELECT MAX(b.id) FROM audit_log b WHERE b.action='workspace_created' AND b.target_id=a.target_id)`);
      const violations = [];
      let checked = 0;
      for (const r of rows) {
        if (!r.dir || !existsSync(r.dir)) continue;
        checked++;
        const hit = exposedBy(r.dir, paths);
        if (hit.length) violations.push({ ref: r.task_id, dir: r.dir, exposes: hit.map((m) => m.what) });
      }
      return { checked, violations };
    },
  },
  {
    // 预算一致性：花费越过上限（留容差）却没有闸门记录 = 闸门失灵。任务上限看最近一次改上限之后有没有 limit_breached；
    // 月度预算（部署 / 个人）看这个月有没有 monthly_budget_breached
    id: 'budget', everyMs: 10 * MIN, level: 'bad',
    check(db, { at }) {
      const violations = [];
      const spent = db.all(`SELECT task_id, SUM(micro_usd) AS m FROM usage_ledger WHERE task_id IS NOT NULL GROUP BY task_id`);
      // 还有运行进程占着（租约没到期）= 还在花钱；带上 pid，人好分辨、暂停不管用时也有后手
      const liveOf = (res) => { const l = db.one(`SELECT pid FROM leases WHERE resource=? AND expires_at>?`, res, at); return { live: !!l, pid: l?.pid ?? null }; };
      for (const s of spent) {
        const limit = limitOf(db, s.task_id, 'limit.budget_micro_usd');
        if (!(limit > 0) || s.m <= limit * BUDGET_SLACK.task) continue;
        const lastSet = db.one(`SELECT MAX(id) AS id FROM audit_log WHERE action='limit_set' AND target_id=? AND json_extract(payload,'$.key')='limit.budget_micro_usd'`, s.task_id)?.id ?? 0;
        const gated = db.one(`SELECT 1 FROM audit_log WHERE action='limit_breached' AND target_id=? AND json_extract(payload,'$.key')='limit.budget_micro_usd' AND id>? LIMIT 1`, s.task_id, lastSet);
        if (!gated) { const t = db.one(`SELECT title, status FROM tasks WHERE id=?`, s.task_id); violations.push({ ref: s.task_id, scope: 'task', spent: s.m, limit, title: t?.title ?? null, status: t?.status ?? null, ...liveOf(`task:${s.task_id}`) }); }
      }
      const tag = (t) => db.one(`SELECT 1 FROM audit_log WHERE action='monthly_budget_breached' AND json_extract(payload,'$.tag')=? LIMIT 1`, t);
      const month = monthKey(at, deployTz(db));
      const dep = deploymentBudget(db);
      if (dep) { const m = deploymentSpend(db); if (m > dep * BUDGET_SLACK.month && !tag(`deployment:${month}`)) violations.push({ ref: 'deployment', scope: 'deployment', spent: m, limit: dep, month }); }
      for (const u of db.all(`SELECT id, display_name FROM users`)) {
        const b = personBudget(db, u.id);
        if (!b) continue;
        const m = personSpend(db, u.id);
        if (m > b * BUDGET_SLACK.month && !tag(`person:${u.id}:${month}`)) violations.push({ ref: u.id, name: u.display_name ?? null, scope: 'person', spent: m, limit: b, month });
      }
      return { checked: spent.length, violations };
    },
  },
  {
    // 租约一致性：本机进程持有的、还没到期的租约，持有者得活着；已结束的任务不该还被谁占着（持有者也不续了）。
    // 任务租约两分钟就到期、崩溃扫描会接住 —— 只报会久挂着的：到期还早（项目租约 30 分钟）或心跳早就停了的
    id: 'leases', everyMs: 5 * MIN, level: 'warn',
    check(db, { at, alive = pidAlive }) {
      const host = hostname();
      const rows = db.all(`SELECT resource, holder, pid, heartbeat_at, expires_at FROM leases WHERE expires_at>?`, at);
      const violations = [];
      // 人认得的名字：任务 / 项目的标题
      const titleOf = (res) => { const m = /^(task|project):(.+)$/.exec(res); return m ? db.one(`SELECT title FROM ${m[1] === 'task' ? 'tasks' : 'projects'} WHERE id=?`, m[2])?.title ?? null : null; };
      for (const l of rows) {
        const local = String(l.holder).split(':')[0] === host;
        const stale = at - l.heartbeat_at > 2 * LEASE_RENEW_MS;
        if (local && l.pid && !alive(l.pid) && (l.expires_at - at > LEASE_TTL_MS || stale)) { violations.push({ ref: l.resource, title: titleOf(l.resource), kind: 'dead_holder', pid: l.pid, expiresAt: l.expires_at }); continue; }
        const m = /^task:(.+)$/.exec(l.resource);
        if (m && stale) {
          const st = db.one(`SELECT status FROM tasks WHERE id=?`, m[1])?.status;
          if (st === 'done' || st === 'aborted') violations.push({ ref: l.resource, title: titleOf(l.resource), kind: 'finished_task', status: st, pid: l.pid, expiresAt: l.expires_at });
        }
      }
      return { checked: rows.length, violations };
    },
  },
];

// 重查提醒挂在同一套机制上：同一张状态表、同一个周期循环；成立 / 消失写 recheck_due / recheck_cleared，不推通知
const ALL = [...INVARIANTS, ...RECHECKS];
const byId = Object.fromEntries(ALL.map((i) => [i.id, i]));
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/**
 * 到点的查一遍（`force` 全查、`only` 只查某几条）。结果写 invariant_state；从对到错写 invariant_violated、从错到对写 invariant_restored。
 * @param ctx { home, assess, alive } —— assess 由守护进程传 assessTask（避免 invariants 与 daemon 互相 import）
 * @returns {{ ran: string[], transitions: Array<{id, to: 'violated'|'restored', n, sample, forMs?}> }}
 */
export function sweepInvariants(db, { at = now(), force = false, only = null, ...ctx } = {}) {
  const ran = [], transitions = [];
  for (const inv of ALL) {
    if (only && !only.includes(inv.id)) continue;
    const prev = db.one(`SELECT * FROM invariant_state WHERE id=?`, inv.id);
    // 正违反着、这一条又标了 recheckMs：按更短的周期查，恢复了当拍就消掉
    const every = prev?.violations > 0 && !prev?.skipped && inv.recheckMs ? Math.min(inv.everyMs, inv.recheckMs) : inv.everyMs;
    if (!force && prev && at - prev.checked_at < every) continue;
    const t0 = performance.now();
    let r, error = null;
    try { r = inv.check(db, { at, ...ctx }); } catch (e) { error = String(e?.message ?? e).slice(0, 300); }
    const elapsed = Math.round(performance.now() - t0);
    ran.push(inv.id);
    if (error) {
      db.run(`INSERT INTO invariant_state (id, checked_at, checked, violations, sample, since, error, elapsed_ms) VALUES (?,?,0,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at, error=excluded.error, elapsed_ms=excluded.elapsed_ms`,
        inv.id, at, prev?.violations ?? 0, prev?.sample ?? '[]', prev?.since ?? null, error, elapsed);
      continue;
    }
    if (r.skipped) {   // 这次不适用（急停中 / 没给判断函数）：只记查过了，不动违反状态
      db.run(`INSERT INTO invariant_state (id, checked_at, checked, violations, sample, since, error, elapsed_ms, skipped) VALUES (?,?,0,0,'[]',NULL,NULL,?,?)
        ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at, error=NULL, elapsed_ms=excluded.elapsed_ms, skipped=excluded.skipped`, inv.id, at, elapsed, r.skipped);
      continue;
    }
    // 基线：第一次查时就在的（且这一条允许记基线的），以后不报；行不再违反就自然从结果里消失
    const vkey = (v) => `${v.table ?? ''}:${v.ref}:${v.kind ?? ''}`;
    // "第一次"= 以前没有真正查到过东西（没查过、查炸了、跳过了都不算）
    const base = prev?.checked > 0 ? json(prev.baseline, []) : inv.baseline ? r.violations.filter(inv.baseline).map(vkey) : [];
    const baseSet = new Set(base);
    const fresh = r.violations.filter((v) => !baseSet.has(vkey(v)));
    const baselined = r.violations.length - fresh.length;
    r = { ...r, violations: fresh };
    const n = r.violations.length, sample = r.violations.slice(0, SAMPLE);
    const was = prev?.violations > 0 && !prev?.skipped;
    const since = n ? (was ? prev.since : at) : null;
    db.tx(() => {
      db.run(`INSERT INTO invariant_state (id, checked_at, checked, violations, sample, since, error, elapsed_ms, skipped, baseline, baselined) VALUES (?,?,?,?,?,?,NULL,?,NULL,?,?)
        ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at, checked=excluded.checked, violations=excluded.violations, sample=excluded.sample,
          since=excluded.since, error=NULL, elapsed_ms=excluded.elapsed_ms, skipped=NULL, baseline=excluded.baseline, baselined=excluded.baselined`,
        inv.id, at, r.checked ?? 0, n, JSON.stringify(sample), since, elapsed, JSON.stringify(base), baselined);
      const advice = !!inv.advice;
      if (n && !was) {
        audit(db, { actorKind: 'system', action: advice ? 'recheck_due' : 'invariant_violated', targetType: 'invariant', targetId: inv.id, payload: { n, level: inv.level ?? null, sample: sample.slice(0, 5) } });
        transitions.push({ id: inv.id, level: inv.level, to: 'violated', n, sample: sample.slice(0, 5), advice });
      } else if (!n && was) {
        audit(db, { actorKind: 'system', action: advice ? 'recheck_cleared' : 'invariant_restored', targetType: 'invariant', targetId: inv.id, payload: { forMs: prev.since ? at - prev.since : null } });
        transitions.push({ id: inv.id, level: inv.level, to: 'restored', n: 0, forMs: prev.since ? at - prev.since : null, advice });
      }
    });
  }
  return { ran, transitions };
}

/**
 * 重查提醒的现状：只列成立的。管理员点过「知道了」（审计 recheck_acked 在这一段成立之后）的标 acked —— 条件消失再出现才重新提醒。
 */
export function rechecksView(db) {
  const rows = Object.fromEntries(db.all(`SELECT * FROM invariant_state`).map((r) => [r.id, r]));
  return RECHECKS.map((c) => {
    const r = rows[c.id];
    if (!r || r.skipped || !r.violations) return null;
    const ack = db.one(`SELECT ts, actor_id FROM audit_log WHERE action='recheck_acked' AND target_type='invariant' AND target_id=? AND ts>=? ORDER BY id DESC LIMIT 1`, c.id, r.since ?? 0);
    return { id: c.id, since: r.since, checkedAt: r.checked_at, sample: json(r.sample, []), acked: ack ? { at: ack.ts, by: ack.actor_id } : null };
  }).filter(Boolean);
}

/** 管理员：这条提醒知道了（收起；条件消失再出现会重新提醒）。调用方保证是管理员 */
export function ackRecheck(db, { id, userId }) {
  if (!RECHECKS.some((c) => c.id === id)) throw new Error(`unknown recheck: ${id}`);
  audit(db, { actorKind: 'user', actorId: userId, action: 'recheck_acked', targetType: 'invariant', targetId: id, payload: {} });
}

/** 健康卡 / 命令行：每条的现状（没查过的也列，checkedAt 为 null） */
export function invariantsView(db) {
  const rows = Object.fromEntries(db.all(`SELECT * FROM invariant_state`).map((r) => [r.id, r]));
  return INVARIANTS.map((inv) => {
    const r = rows[inv.id];
    return { id: inv.id, level: inv.level, everyMs: inv.everyMs, checkedAt: r?.checked_at ?? null, checked: r?.checked ?? null,
      violations: r?.skipped ? 0 : (r?.violations ?? 0), sample: r ? json(r.sample, []) : [], since: r?.since ?? null,
      error: r?.error ?? null, skipped: r?.skipped ?? null, elapsedMs: r?.elapsed_ms ?? null, baselined: r?.baselined ?? 0 };
  });
}

export const invariantOf = (id) => byId[id] ?? null;

/** 命令行：一个违反的例子 → 一行（看板按界面语言另写） */
export function invariantLine(id, v, L = 'zh') {
  const usd = (m) => fmtUsd(m ?? 0);
  switch (id) {
    case 'liveness': return v.state === 'reported'
      ? tl(L, '任务 {ref}：已挂事项 {q} 给负责人，还没处理', { ref: v.ref, q: v.questionId })
      : tl(L, '任务 {ref}：{min} 分钟没动静，说不出在等谁（守护进程下一拍挂事项给负责人）', { ref: v.ref, min: v.idleMin });
    case 'projection': return v.kind === 'missing_trigger' ? tl(L, '库层护栏 {ref} 不见了', { ref: v.ref })
      : v.kind === 'done_without_handoff' ? tl(L, '步骤 {ref} 是 done，却没有交接记录', { ref: v.ref })
      : tl(L, '{table} {ref}：状态是 {status}，审计轨最后记的是 {audited}', { table: v.table, ref: v.ref, status: v.status, audited: v.audited });
    case 'executor_paths': return tl(L, '任务 {ref} 的工作区 {dir} 罩住了 {what}', { ref: v.ref, dir: v.dir, what: (v.exposes ?? []).join(' / ') });
    case 'budget': return v.scope === 'task' ? tl(L, '任务 {ref} 花了 {spent}，上限 {limit}，却没被拦下', { ref: v.ref, spent: usd(v.spent), limit: usd(v.limit) })
      : v.scope === 'person' ? tl(L, '{ref} 本月（{month}）花了 {spent}，个人预算 {limit}，却没被拦下', { ref: v.ref, month: v.month, spent: usd(v.spent), limit: usd(v.limit) })
      : tl(L, '整个部署本月（{month}）花了 {spent}，预算 {limit}，却没被拦下', { month: v.month, spent: usd(v.spent), limit: usd(v.limit) });
    case 'leases': return v.kind === 'dead_holder' ? tl(L, '{ref}：占着它的进程 {pid} 已经不在了', { ref: v.ref, pid: v.pid })
      : tl(L, '{ref}：任务已经 {status}，持有进程 {pid} 还占着、也不续约', { ref: v.ref, status: v.status, pid: v.pid });
    default: return JSON.stringify(v);
  }
}
