// 按人记账、预占与月度预算。
//
// 原来花费只记到任务上，闸门只有任务预算与项目预算两层；项目预算只在步骤边界查，一个步骤跑到一半能越过去整整一个步骤的钱；
// 几个编排器并行（并行开发、多人各跑各的）时各自判闸门，可以一起越过。这里补三件事：
//   ① 归属：每笔花费记在一个人头上（deploy.cost_attribution：发起人 / 项目负责人 / 批准契约的人，默认发起人）；
//   ② 月度预算：按人（users.budget_usd_month，空 = 部署默认 deploy.person_budget_usd_month）、按部署（deploy.budget_usd_month），
//      撞上照旧"停下来问"（各自一条事项，发给管理员）；
//   ③ 预占：每次模型调用前，在一个事务里按最坏情况的花费预占，连同项目 / 按人 / 部署三层闸门一起判；调用落账后释放。
//      进程死了留下的预占到期就不算（默认 30 分钟）。
// 月份按部署时区切（没设部署时区 = UTC）。

import { now, newId, audit } from '../db/db.mjs';
import { updateUser } from '../db/users.mjs';
import { getSetting } from './settings.mjs';
import { deployTz } from './calendar.mjs';
import { monthStart as tzMonthStart, monthKey, addCalendarDays, startOfDay } from './tz.mjs';
import { tl, contentLang, I18nError } from '../i18n/index.mjs';
import { markOf } from '../i18n/marks.mjs';
import { budgetState, fmtUsd } from './project-settings.mjs';
import { insertQuestion, setRecipients } from './questions.mjs';
import { routeQuestion } from './routing.mjs';

export const RESERVATION_TTL_MS = 30 * 60_000;
const M = 1_000_000;

/** 这一刻所在月的起点（毫秒）：按部署时区（tz 不给 = UTC）。 */
export const monthStart = (at = now(), back = 0, tz = 'UTC') => tzMonthStart(at, tz, back);

/**
 * 这个任务的花费记在谁头上。返回 { payerId, scope }（scope：'user' 记到人 / 'project' 记到项目，找不到人时）。
 */
export function payerOf(db, taskId) {
  const t = db.one(`SELECT t.owner_id, t.project_id, p.owner_id AS project_owner FROM tasks t LEFT JOIN projects p ON p.id=t.project_id WHERE t.id=?`, taskId);
  if (!t) return { payerId: null, scope: 'project' };
  const policy = getSetting(db, 'deploy.cost_attribution');
  let who = t.owner_id;
  if (policy === 'project_owner') who = t.project_owner ?? t.owner_id;
  else if (policy === 'approver') {
    // 批准这个任务契约的人：任务自己的契约批准事项；项目任务没有的话，看项目规划草案的批准事项（挂在规划载体上）
    const a = db.one(`SELECT a.user_id FROM answers a JOIN questions q ON q.id=a.question_id
                      WHERE q.decision_type='contract_approval' AND a.stance='answer' AND a.user_id IS NOT NULL
                        AND (q.task_id=? OR q.task_id IN (SELECT id FROM tasks WHERE project_id=? AND project_order=0))
                      ORDER BY (q.task_id=?) DESC, a.created_at DESC LIMIT 1`, taskId, t.project_id ?? '', taskId);
    who = a?.user_id ?? t.owner_id;
  }
  return who ? { payerId: who, scope: 'user' } : { payerId: null, scope: 'project' };
}

// ── 花费 ──
/** 某人从 from 起的花费（旧账没有归属的按发起人口径算）。 */
export const personSpend = (db, userId, { from = monthStart(now(), 0, deployTz(db)), to = Infinity } = {}) => db.one(
  `SELECT COALESCE(SUM(l.micro_usd),0) m FROM usage_ledger l JOIN tasks t ON t.id=l.task_id
   WHERE COALESCE(l.payer_id, CASE WHEN l.payer_scope IS NULL THEN t.owner_id END)=? AND l.ts>=? AND l.ts<?`, userId, from, to === Infinity ? Number.MAX_SAFE_INTEGER : to).m;
export const deploymentSpend = (db, { from = monthStart(now(), 0, deployTz(db)), to = Infinity } = {}) => db.one(
  `SELECT COALESCE(SUM(micro_usd),0) m FROM usage_ledger WHERE ts>=? AND ts<?`, from, to === Infinity ? Number.MAX_SAFE_INTEGER : to).m;

/** 月度预算（微美元）；null = 没设。 */
export function personBudget(db, userId) {
  const own = db.one(`SELECT budget_usd_month b FROM users WHERE id=?`, userId)?.b;
  const usd = own ?? Number(getSetting(db, 'deploy.person_budget_usd_month'));
  return usd > 0 ? usd * M : null;
}
export const deploymentBudget = (db) => { const usd = Number(getSetting(db, 'deploy.budget_usd_month')); return usd > 0 ? usd * M : null; };

// ── 预占 ──
const activeReserved = (db, where, args, { at, exceptHolder }) => db.one(
  `SELECT COALESCE(SUM(micro_usd),0) m FROM budget_reservations WHERE expires_at>? AND holder<>? AND ${where}`, at, exceptHolder ?? '', ...args).m;

/**
 * 加上 extraMicro 之后会不会撞闸（项目 / 按人 / 部署三层；任务自己的上限由编排器另判）。别人的预占也算进去。
 * @returns {null | {scope: 'project'|'person'|'deployment', limit, actual, projectId?, payerId?}}
 */
export function spendBreach(db, taskId, { at = now(), extraMicro = 0, holder = null } = {}) {
  const t = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId);
  const { payerId } = payerOf(db, taskId);
  const opt = { at, exceptHolder: holder };
  if (t?.project_id) {
    const b = budgetState(db, t.project_id);
    if (b.gate !== null) {
      const actual = b.spent + activeReserved(db, `project_id=?`, [t.project_id], opt) + extraMicro;
      if (actual >= b.gate || b.spent >= b.gate) return { scope: 'project', projectId: t.project_id, limit: b.gate, actual };
    }
  }
  if (payerId) {
    const cap = personBudget(db, payerId);
    if (cap !== null) {
      const spent = personSpend(db, payerId, { from: monthStart(at, 0, deployTz(db)) });
      const actual = spent + activeReserved(db, `payer_id=?`, [payerId], opt) + extraMicro;
      if (actual >= cap || spent >= cap) return { scope: 'person', payerId, limit: cap, actual };
    }
  }
  const dcap = deploymentBudget(db);
  if (dcap !== null) {
    const spent = deploymentSpend(db, { from: monthStart(at, 0, deployTz(db)) });
    const actual = spent + activeReserved(db, `1=1`, [], opt) + extraMicro;
    if (actual >= dcap || spent >= dcap) return { scope: 'deployment', limit: dcap, actual };
  }
  return null;
}

/**
 * 模型调用前预占：在写锁里判闸门（含别人的预占），没撞就记下这一笔（替换本持有者在这个任务上的上一笔）。
 * @returns {{ok: true} | {ok: false, breach}}
 */
export function reserveCall(db, { taskId, holder, microUsd, at = now(), ttlMs = RESERVATION_TTL_MS }) {
  return db.tx(() => {
    const breach = spendBreach(db, taskId, { at, extraMicro: microUsd, holder });
    db.run(`DELETE FROM budget_reservations WHERE task_id=? AND holder=?`, taskId, holder);
    if (breach) return { ok: false, breach };
    const t = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId);
    db.run(`INSERT INTO budget_reservations (id,task_id,project_id,payer_id,micro_usd,holder,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)`,
      newId('rv'), taskId, t?.project_id ?? null, payerOf(db, taskId).payerId, Math.max(0, Math.round(microUsd)), holder, at, at + ttlMs);
    return { ok: true };
  });
}

/** 调用结算后释放（落账由 flushLedger 做）。 */
export const releaseReservation = (db, { taskId, holder }) => db.run(`DELETE FROM budget_reservations WHERE task_id=? AND holder=?`, taskId, holder);

/** 删掉过期的预占（日常清理）。 */
export const pruneReservations = (db, { at = now() } = {}) => Number(db.run(`DELETE FROM budget_reservations WHERE expires_at<=?`, at).changes);

/**
 * 一次调用最坏情况的花费（微美元）：输入按给的体量、输出按 maxTokens 打满。没有单价（不该发生：没单价的模型绑不上）按 0。
 */
export function estimateCallMicro(pricing, { inputTokens = 0, maxTokens = 16000 } = {}) {
  if (!pricing) return 0;
  return Math.round((inputTokens * (pricing.input ?? 0) + maxTokens * (pricing.output ?? 0)) / 1e6 * M);
}

// ── 撞了按人 / 部署月度预算：停下来问管理员（一个人一个月一条、部署一个月一条） ──
const leads = (db) => db.all(`SELECT id FROM users WHERE role='lead' AND disabled_at IS NULL AND kind='human'`).map((r) => r.id);
export function raiseMonthlyBudget(db, { taskId, breach, at = now() }) {
  const L = contentLang(db);
  const tz = deployTz(db);
  const month = monthKey(at, tz);
  const tag = breach.scope === 'person' ? `person:${breach.payerId}:${month}` : `deployment:${month}`;
  const exist = db.one(`SELECT q.id FROM questions q JOIN audit_log a ON a.target_id=q.id AND a.action='monthly_budget_breached'
                        WHERE q.status IN ('open','escalated') AND json_extract(a.payload,'$.tag')=? LIMIT 1`, tag);
  if (exist) return { questionId: exist.id, existed: true };
  const who = breach.scope === 'person' ? db.one(`SELECT display_name FROM users WHERE id=?`, breach.payerId)?.display_name ?? breach.payerId : null;
  const head = breach.scope === 'person'
    ? tl(L, '{who} 本月（{month}，{tz}）的花费已达个人预算：已花 {spent} / 预算 {cap}。', { who, month, tz, spent: fmtUsd(breach.actual), cap: fmtUsd(breach.limit) })
    : tl(L, '整个部署本月（{month}，{tz}）的花费已达预算：已花 {spent} / 预算 {cap}。', { month, tz, spent: fmtUsd(breach.actual), cap: fmtUsd(breach.limit) });
  const text = `${markOf(L, 'limit')}${head}\n\n`
    + `${breach.scope === 'person' ? tl(L, '记在这个人头上的任务会在下一轮停下来；别人的任务不受影响。') : tl(L, '所有任务都会在下一轮停下来。')}${tl(L, '本事项由系统直接生成，未调用模型。')}\n\n`
    + `${tl(L, '请选一条：')}\n`
    + `(A) ${breach.scope === 'person'
      ? tl(L, '提高这个人的月度预算后继续：设置 → 花费 里改，或 node src/cli.mjs user budget {id} --usd <新值>', { id: breach.payerId })
      : tl(L, '提高部署月度预算后继续：node src/cli.mjs user setting deploy.budget_usd_month <新值>')}\n`
    + `(B) ${tl(L, '这个月不再跑：不用做什么，下个月 1 日（{tz}）自动恢复', { tz })}`;
  return db.tx(() => {
    const id = insertQuestion(db, { taskId, level: 3, text, askedAt: at });
    routeQuestion(db, { questionId: id, decisionType: 'budget', typeSource: 'hard_rule', at });
    // 月度预算是管理员设的，钱的口子也只有管理员能开：发给管理员，不按任务的路由表
    const ls = leads(db);
    if (ls.length) setRecipients(db, id, { addressedTo: ls });
    audit(db, { actorKind: 'system', action: 'monthly_budget_breached', targetType: 'question', targetId: id, payload: { tag, taskId, ...breach } });
    return { questionId: id, existed: false, text };
  });
}

// ── 公平调度：守护进程拉起任务时在归属人之间轮转，每人同时在跑的任务数可设上限 ──
/**
 * 把该拉起的任务按归属人交错排开（甲乙丙甲乙丙……，各人内部保持原顺序），并给出每个人当前在跑的数目。
 * 原来按任务列表的顺序拉，一个人一口气提了十个任务，别人的任务就排在后面等。
 * @param {Array<{taskId: string}>} due
 * @returns {{ordered: Array<{taskId, payerId}>, running: Map<string, number>}}
 */
export function fairOrder(db, due, { at = now(), isLive = () => null } = {}) {
  const running = new Map();
  for (const r of db.all(`SELECT substr(resource, 6) AS task_id FROM leases WHERE resource LIKE 'task:%' AND expires_at>?`, at)) {
    const p = payerOf(db, r.task_id).payerId ?? '(project)';
    running.set(p, (running.get(p) ?? 0) + 1);
  }
  const groups = new Map();
  for (const d of due) {
    const p = payerOf(db, d.taskId).payerId ?? '(project)';
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push({ ...d, payerId: p });
  }
  // 在跑得少的人先轮
  const order = [...groups.keys()].sort((a, b) => (running.get(a) ?? 0) - (running.get(b) ?? 0));
  const ordered = [];
  for (let k = 0; ordered.length < due.length; k++) for (const p of order) { const g = groups.get(p); if (g[k]) ordered.push(g[k]); }
  void isLive;
  return { ordered, running };
}

// ── 看板：每个人的花费与趋势 ──
export function spendByPerson(db, { at = now(), days = 14 } = {}) {
  const tz = deployTz(db);
  const from = monthStart(at, 0, tz), last = monthStart(at, 1, tz);
  // 某一天（往前 k 天）的 0 点，按部署时区（夏令时那天不是 24 小时）
  const dayStart = (k) => addCalendarDays(startOfDay(at, tz), -k, tz);
  const users = db.all(`SELECT id, display_name, role, kind, budget_usd_month FROM users WHERE disabled_at IS NULL ORDER BY display_name`);
  const rows = users.map((u) => ({
    userId: u.id, name: u.display_name, kind: u.kind,
    month: personSpend(db, u.id, { from }), lastMonth: personSpend(db, u.id, { from: last, to: from }),
    budget: personBudget(db, u.id), ownBudget: u.budget_usd_month,
    daily: Array.from({ length: days }, (_, i) => personSpend(db, u.id, { from: dayStart(days - 1 - i), to: dayStart(days - 2 - i) })),
  }));
  return { month: monthKey(at, tz), tz, rows, deployment: { month: deploymentSpend(db, { from }), budget: deploymentBudget(db) } };
}

/** 设某人的月度预算（美元整数；null = 用部署默认）。 */
export function setPersonBudget(db, { userId, usd, byUserId }) {
  const v = usd === null || usd === '' ? null : Number(usd);
  if (v !== null && !(Number.isInteger(v) && v >= 0)) throw new I18nError('月度预算要是不小于 0 的整数美元，或者留空（用部署默认）');
  return db.tx(() => {
    updateUser(db, userId, { budgetUsdMonth: v });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'person_budget_set', targetType: 'user', targetId: userId, payload: { usd: v } });
    return { userId, usd: v };
  });
}
