// 守护进程：把"答完题任务自己接着跑"落实。
//
// 编排器的设计是"挂起就退出"，恢复 = 再跑一次 run。没有守护进程时这一下是人按的：答完题还得
// 回到 CLI / 看板按"运行"。这与"用户只需要答题、做取舍、纠偏"直接矛盾。守护进程的工作只有一件：
// 每隔一会看一遍库，**该接着跑的任务没在跑** → 起一个子进程。外加把超时链（`cli tick`）并进来。
//
// 一个任务有三个阶段，各对应一个子进程动词：
//   draft（追问：params draft.stage 不是 approved）→ plan（草案已批、还没有节点）→ run（有节点）
// 每个阶段的"该不该拉起"都是同一条能解释的规则，不是猜：
//   1. 状态对（run 阶段要 running；draft / plan 阶段要 planning 或 running —— 答题会把 waiting 翻成 running）；
//   2. 没有活着的子进程（自己起的看子进程表；别处起的看最近一条 *_started 的 pid 还活不活）；
//   3. 上次退出之后**发生过让它能接着跑的事**（答题、留言、加额、批准、恢复、放行、超时走默认），
//      或者从没跑过；或者上次退出是"到达 maxCycles"这种没出错的到点下班；
//      或者上次是厂商错误 / 崩溃 / 追问器与规划器自己失败 —— 按退避重试几次，超过就等人；
//      其余退出（验收没过、重规划失败、卡死、被作废光）都是**要人来**的，没有新的人为动作就不动。
// 第 3 条是防空转的：一进去就退出的任务（验收永远不过、依赖成环）若无脑重拉，每 15 秒烧一次钱。

import { existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { audit, now } from '../db/db.mjs';
import { pidAlive } from './proc.mjs';
import { sweepTimeouts } from './timeouts.mjs';
import { notifyPendingQuestions, notifyPendingDeliveries } from './users.mjs';
import { handoverDigests } from './digest.mjs';
import { checkCatalog, renderCatalogCheck, recordCatalogCheck, catalogCheckDue } from '../llm/catalog-check.mjs';
import { checkableCatalog } from '../llm/registry.mjs';
import { readyNodes } from '../context/assemble.mjs';
import { heldSteering, hasSteering } from './inbox.mjs';
import { llmHealthNotice, invariantNotice } from './notify.mjs';
import { emitSignal, pushSignal, deliverSignals } from './signals.mjs';
import { pollMailReplies } from './mail-reply.mjs';
import { queueDueReports } from './report.mjs';
import { getParam } from './params.mjs';
import { offThread } from './offthread.mjs';
import { appendStateOf, appendPending } from '../agent/project-append.mjs';
import { sweepLiveness, UNKNOWN_GRACE_MS, REPEAT_THRESHOLD } from './liveness.mjs';
import { sweepInvariants } from './invariants.mjs';
import { makeRuntimeHealth } from './health.mjs';
import { raiseAdvanceFailed } from './handback.mjs';
import { tl, contentLang } from '../i18n/index.mjs';
import { getSetting } from './settings.mjs';
import { LIFECYCLE } from './lifetimes.mjs';
import { leaseOf } from '../db/lease.mjs';
import { sweepCrashes } from './crashes.mjs';
import { dbMaintenance } from './db-maintenance.mjs';
import { newTrace } from './log.mjs';
import { housekeeping } from './housekeeping.mjs';
import { fairOrder } from './spend.mjs';
import { makePrWatcher } from './pr-watch.mjs';
import { makeIssueWatcher, fireSchedules } from './inbound.mjs';
import { onCiChange, redeliverFixes, redeliverSignoffOk } from './pr-fix.mjs';
import { onReviewChange } from './pr-review.mjs';
import { doneHeadOf } from './deliver.mjs';

/** 上次退出之后出现其中任一审计动作 → 任务可以接着跑。question_* 挂在问题上，其余挂在任务上。 */
export const RESUME_ACTIONS = ['question_answered', 'question_defaulted', 'message_received', 'message_released', 'limit_set',
  'revision_applied', 'revision_rejected', 'task_resumed', 'egress_allowlist_set', 'plan_persisted', 'draft_approved'];

/** 厂商错误 / 崩溃 / 起不来的退避：第 n 次连续失败后等这么久再拉；超过表长就等人。 */
export const RETRY_BACKOFF_MS = [5, 15, 45, 90].map((m) => m * 60_000);

/** 三个阶段的子进程各自在审计轨上留的起止行。 */
/** 能修好"配置问题"的注册表动作（部署级审计）。 */
const CONFIG_FIX_ACTIONS = ['binding_set', 'binding_seeded', 'endpoint_saved', 'model_saved', 'key_set'];

// 起止审计动作的表在 lifetimes.mjs（复盘也用它）；这里照旧导出，原有的引用不用改
export { LIFECYCLE };

/**
 * 项目规划器该不该拉：项目 proposed；批准问题没开着（没提过 / 已答）；没在跑；上次是 proposed 则要有人答过；
 * failed / crashed 按退避表重试。纯读库，好测。
 */
export function assessProjectPlan(db, project, { at = now(), isLive = () => null, alive = pidAlive } = {}) {
  const id = project.id;
  const mine = isLive(id);
  if (mine) return { due: false, verb: 'project-plan', reason: 'live', pid: mine.pid };
  // 两种要拉规划器的情形：首次规划（proposed）；给在跑的项目追加任务（状态在载体任务的 append.* 参数里）。
  // 追加只看它发起之后的起止行（sinceId）：项目早先那次规划的 approved 退出不算数。
  const ap = project.status !== 'proposed' ? appendStateOf(db, id) : null;
  if (project.status !== 'proposed' && !appendPending(ap)) return { due: false, verb: 'project-plan', reason: `status:${project.status}` };
  const sinceId = ap ? ap.sinceAuditId : 0;
  const qid = ap ? ap.questionId : project.draft_question;
  const q = qid ? db.one(`SELECT status FROM questions WHERE id=?`, qid) : null;
  if (q && ['open', 'escalated'].includes(q.status)) return { due: false, verb: 'project-plan', reason: 'needs_human:proposed' };
  const { start, exit } = LIFECYCLE['project-plan'];
  const lastStart = db.one(`SELECT id, ts, payload FROM audit_log WHERE action=? AND target_id=? AND id>? ORDER BY id DESC LIMIT 1`, start, id, sinceId) ?? null;
  const lastExit = db.one(`SELECT id, ts, payload FROM audit_log WHERE action=? AND target_id=? AND id>? ORDER BY id DESC LIMIT 1`, exit, id, sinceId) ?? null;
  if (!lastStart) return { due: true, verb: 'project-plan', reason: ap ? 'project-plan:append' : 'project-plan:first' };
  let kind, failedAt;
  if (!lastExit || lastStart.id > lastExit.id) {
    const pid = parse(lastStart.payload).pid;
    if (alive(pid)) return { due: false, verb: 'project-plan', reason: 'live_foreign', pid };
    kind = 'crashed'; failedAt = lastStart.ts;
  } else { kind = parse(lastExit.payload).kind; failedAt = lastExit.ts; }
  if (kind === 'proposed' || kind === 'noop') {
    // 人答了（批准问题 answered）→ 再起一次，规划器自己读答复决定批准 / 改版 / 放弃。
    // noop（起了但问题还开着就退了）与 proposed 同一条规则。
    return q?.status === 'answered' ? { due: true, verb: 'project-plan', reason: 'project-plan:trigger:question_answered' }
      : { due: false, verb: 'project-plan', reason: 'needs_human:proposed' };
  }
  if (['failed', 'crashed'].includes(kind)) {
    // 连续失败次数：最近一次非失败退出之后的失败退出数（crashed 没有退出行，算 1）
    const okId = Math.max(sinceId, db.one(`SELECT max(id) id FROM audit_log WHERE action=? AND target_id=? AND payload NOT LIKE '%"kind":"failed"%'`, exit, id)?.id ?? 0);
    const n = Math.max(1, db.one(`SELECT count(*) n FROM audit_log WHERE action=? AND target_id=? AND id>? AND payload LIKE '%"kind":"failed"%'`, exit, id, okId).n + (kind === 'crashed' ? 1 : 0));
    const wait = RETRY_BACKOFF_MS[n - 1];
    if (wait === undefined) return { due: false, verb: 'project-plan', reason: `gave_up:${kind}` };
    return at < failedAt + wait ? { due: false, verb: 'project-plan', reason: `backoff:${kind}#${n}` }
      : { due: true, verb: 'project-plan', reason: `project-plan:retry:${kind}#${n}` };
  }
  return { due: false, verb: 'project-plan', reason: `needs_human:${kind}` };
}

const parse = (s) => { try { return JSON.parse(s ?? '{}'); } catch { return {}; } };

export { pidAlive };

const marks = () => RESUME_ACTIONS.map(() => '?').join(',');

/** 上次退出之后、这个任务上最近一条"能接着跑"的动作。 */
function lastTrigger(db, taskId, afterId) {
  return db.one(`SELECT a.id, a.action, a.ts FROM audit_log a
                 LEFT JOIN questions q ON a.target_type='question' AND q.id=a.target_id
                 WHERE a.id>? AND a.action IN (${marks()})
                   AND COALESCE(q.task_id, CASE WHEN a.target_type='task' THEN a.target_id END)=?
                 ORDER BY a.id DESC LIMIT 1`, afterId, ...RESUME_ACTIONS, taskId) ?? null;
}

/** 最近一次触发动作的审计 id（没有就 0）—— 退避计数从这里往后数。 */
const lastTriggerId = (db, taskId) => db.one(
  `SELECT max(a.id) id FROM audit_log a LEFT JOIN questions q ON a.target_type='question' AND q.id=a.target_id
    WHERE a.action IN (${marks()}) AND COALESCE(q.task_id, CASE WHEN a.target_type='task' THEN a.target_id END)=?`,
  ...RESUME_ACTIONS, taskId)?.id ?? 0;

/**
 * 一个阶段的通用判断：起止行 + 触发 + 退避。
 *   retryKinds  哪些退出原因算"不是人该来处理、可以退避重试"
 *   continueIf  (kind, payload) → 退出后无需触发也可续跑（run 阶段的 maxCycles）
 */
function assessPhase(db, taskId, verb, { at, alive, retryKinds, continueIf = () => false }) {
  const { start, exit } = LIFECYCLE[verb];
  const lastStart = db.one(`SELECT id, ts, payload FROM audit_log WHERE action=? AND target_id=? ORDER BY id DESC LIMIT 1`, start, taskId) ?? null;
  let lastExit = db.one(`SELECT id, ts, payload FROM audit_log WHERE action=? AND target_id=? ORDER BY id DESC LIMIT 1`, exit, taskId) ?? null;
  if (!lastStart) return { due: true, verb, reason: `${verb}:first` };
  let kind = lastExit ? parse(lastExit.payload).kind : null;
  if (!lastExit || lastStart.id > lastExit.id) {
    // 起了没退：要么还在跑，要么死在半路（断电 / Ctrl-C / OOM）—— 没有 *_exit 这一行
    const pid = parse(lastStart.payload).pid;
    // 编排器有租约：按租约判 —— 没过期 = 还在跑；过期了 = 当它死了（哪怕 pid 还在：卡死的僵尸，接替者拉起来后它写不进去）。
    // 没有租约行（老版本起的）或别的阶段，照旧看 pid。
    const lease = verb === 'run' ? leaseOf(db, `task:${taskId}`, at) : null;
    if (lease ? lease.live : alive(pid)) return { due: false, verb, reason: 'live_foreign', pid: lease?.pid ?? pid };
    lastExit = { id: lastStart.id, ts: lastStart.ts, payload: lastStart.payload };
    kind = 'crashed';
  }

  // 因部署级急停退出的：急停一解除（走到这里说明守护进程已经不在暂停态）就接着拉，不算失败、不走退避
  if (kind === 'deploy_paused') return { due: true, verb, reason: `${verb}:resume_after_deploy_pause`, kind };
  // 被接管而退出的：接替它的那个还持有租约就不拉（上面已经按 live_foreign 挡了）；没人持有 = 接替者也没了，接着拉
  if (kind === 'lease_lost') {
    const l = leaseOf(db, `task:${taskId}`, at);
    return l?.live ? { due: false, verb, reason: 'live_foreign', pid: l.pid, kind } : { due: true, verb, reason: `${verb}:resume_after_lease_lost`, kind };
  }
  const trig = lastTrigger(db, taskId, lastExit.id);
  if (trig) return { due: true, verb, reason: `${verb}:trigger:${trig.action}`, kind };

  const payload = parse(lastExit.payload);
  if (continueIf(kind, payload)) return { due: true, verb, reason: `${verb}:continue`, kind };
  // 配置问题退出的（ConfigError）：注册表在那之后改过（改绑 / 启用 / 填 key）就立刻再拉，不等退避、也不受"放弃"限制 ——
  // 那几条审计是部署级的，不挂在任务上，lastTrigger 看不到。手改 .env 没有审计，仍靠下面的退避兜。
  const rejected = payload.error?.retryable === false && !payload.error?.config;   // 401 / 403 这类：厂商明确拒绝，重试不会好
  // 厂商暂时不可用（重试用尽 / 熔断开着）退出的，人在那之后给这一档配了备用或改了绑定：也立刻再拉，不等退避
  const unavailable = kind === 'provider_error' && payload.error?.retryable === true;
  if (unavailable) {
    const fix = db.one(`SELECT id, action FROM audit_log WHERE id>? AND action IN ('binding_fallback_set','binding_set') ORDER BY id DESC LIMIT 1`, lastExit.id);
    if (fix) return { due: true, verb, reason: `${verb}:config_fixed:${fix.action}`, kind };
  }
  if (payload.error?.config || rejected) {
    const fix = db.one(`SELECT id, action FROM audit_log WHERE id>? AND action IN (${CONFIG_FIX_ACTIONS.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, lastExit.id, ...CONFIG_FIX_ACTIONS);
    if (fix) return { due: true, verb, reason: `${verb}:config_fixed:${fix.action}`, kind };
  }
  // 不可重试的厂商错误直接等人，不走退避：四次退避要两个半小时才"放弃"，期间人以为它还在自己想办法。
  // 出路是改绑 / 换 key（上面那条会立刻再拉）或对任务说句话。配置问题不在此列 —— 手改 .env 没有审计，只能靠退避发现。
  if (rejected) return { due: false, verb, reason: 'needs_human:provider_rejected', kind };
  if (retryKinds.includes(kind)) {
    // 连续几次了：从最近一次触发动作（或开天辟地）以来，这个阶段起了几次
    const n = db.one(`SELECT count(*) n FROM audit_log WHERE action=? AND target_id=? AND id>?`, start, taskId, lastTriggerId(db, taskId)).n;
    const wait = RETRY_BACKOFF_MS[n - 1];
    if (wait === undefined) return { due: false, verb, reason: `gave_up:${kind}`, kind, attempts: n };
    const readyAt = lastExit.ts + wait;
    return at >= readyAt ? { due: true, verb, reason: `${verb}:retry:${kind}#${n}`, kind, attempts: n }
      : { due: false, verb, reason: `backoff:${kind}#${n}`, kind, attempts: n, readyAt };
  }
  return { due: false, verb, reason: `needs_human:${kind}`, kind };
}

/**
 * 单个任务的判断。返回 { due, verb, reason, ... }，due=true 表示该拉起 `cli <verb> <task>`。纯读库，好测。
 *   isLive(taskId)   → 自己起的子进程还在跑就给 {pid}
 *   hasWorkspace(id) → 工作区建了没有（run 阶段没建 run 一进去就 die，拉了也白拉）
 *   alive(pid)       → 别处起的子进程还活不活
 */
export function assessTask(db, task, { at = now(), isLive = () => null, hasWorkspace = () => true, alive = pidAlive } = {}) {
  const taskId = task.id;
  const mine = isLive(taskId);
  if (mine) return { due: false, reason: 'live', pid: mine.pid };

  const stage = getParam(db, taskId, 'draft.stage');   // 只有从想法开始的任务才有
  const phaseOk = ['planning', 'running'].includes(task.status);
  if (stage && stage !== 'approved') {
    if (!phaseOk) return { due: false, verb: 'draft', reason: `status:${task.status}` };
    return assessPhase(db, taskId, 'draft', { at, alive, retryKinds: ['failed', 'crashed'] });
  }
  // plan 阶段：有宪法块、还没有节点。两条来路 —— 从想法来的（草案已批）与 `new --file` / `new --goal` 直接给宪法块的。
  // 后一条容易漏（漏了的话任务建好之后一直没人拉 plan）。
  // 对直接给宪法块的任务，把"工作区建好"当作人的开工信号：new → limit → egress → workspace 是设置顺序，
  // 工作区是最后一步；在那之前拉 plan 会在人还在填上限时先把规划器的钱花掉。
  const hasConstitution = !!db.one(`SELECT id FROM constitutions WHERE task_id=? ORDER BY version DESC LIMIT 1`, taskId);
  const noNodes = !db.one(`SELECT count(*) n FROM nodes WHERE task_id=?`, taskId).n;
  if ((stage === 'approved' || (!stage && hasConstitution)) && noNodes) {
    if (!phaseOk) return { due: false, verb: 'plan', reason: `status:${task.status}` };
    if (!stage && !hasWorkspace(taskId)) return { due: false, verb: 'plan', reason: 'no_workspace' };
    return assessPhase(db, taskId, 'plan', { at, alive, retryKinds: ['failed', 'crashed'] });
  }

  // waiting = 在等人答某条事项。但人还有另一种"答"：**发一条计划变更** ——
  // 结构矛盾的出路常常正是改契约，而改契约只能走修正，不能靠答复（见 executor.mjs 的系统附注）。
  // 修正到了却不拉起，人就做了正确的动作而系统零反应：无报错、无待办、不动。
  // 编排器每轮开头就处理未消费的修正，排在挑节点之前，所以事项还开着也无妨：重规划照跑，
  // 跑完若仍被那条事项挡住，它会照常回到 suspended。消费之后 steering 为空，不会反复拉。
  //
  // 同一条边界还有第二种形状：**waiting 不等于没活可干**。分支级挂起的全部意义就是
  // "A 在等人答题，独立的 B 照跑"；可一旦那一轮退出，任务停在 waiting，守护进程就再也不看它了。
  // 平时不出事（退出时该跑的分支已经跑完），但计划变更**新增节点**之后就出事：新节点就绪、
  // 任务却是 waiting，谁也不拉 —— 又是一次无报错、无待办、不动。
  // 所以口径改成：waiting 的任务，只要有**能跑的活**（未消费的修正，或不被那条事项挡住的就绪节点）就拉。
  //
  // 被挡着的修正（待比对 / 等裁定）**不算**能跑的活，而且挡着的时候整个任务都不拉 ——
  // 编排器那边同一条口径（⓪″）：修正多半要改计划，这时接着跑旧计划是白干。
  // 两种挡法各带一个可解引用的接收者：待比对是一个钟点（readyAt），等裁定是那条冲突事项。
  // done 也一样：done 的任务在等签收 / 等合并时人发来修正，编排器那头会重开它（orchestrator ⓪′），
  // 但守护进程原来只看 planning / running / waiting —— 修正落了库就悬着，签收、合并照常走，人要的改动悄悄丢了。
  // 已合并的不拉：发给它的修正在看板入口就转成了「添加任务」。
  const doneWork = task.status === 'done' && !task.merged_at;
  if (['running', 'waiting'].includes(task.status) || doneWork) {
    const held = heldSteering(db, taskId, { at });
    const verdict = held.filter((h) => h.why === 'verdict');
    if (verdict.length) return { due: false, verb: 'run', reason: 'held:verdict', questionIds: [...new Set(verdict.flatMap((h) => h.questionIds))] };
    if (held.length) return { due: false, verb: 'run', reason: 'backoff:held_check', readyAt: Math.max(...held.map((h) => h.until ?? at)) };
  }
  const waitingWork = (task.status === 'waiting' && (hasSteering(db, taskId, { at }) || readyNodes(db, taskId).length > 0))
    || (doneWork && hasSteering(db, taskId, { at }));
  if (task.status !== 'running' && !waitingWork) return { due: false, verb: 'run', reason: `status:${task.status}` };
  if (!hasWorkspace(taskId)) return { due: false, verb: 'run', reason: 'no_workspace' };
  return assessPhase(db, taskId, 'run', { at, alive, retryKinds: ['provider_error', 'sandbox_error', 'crashed'],
    // 上一轮因为修正被挡着而退出、现在已经不挡了：放行时如果没有触发动作（待比对到点自己放行、
    // 冲突事项被撤回），不在这里认它，这个任务就再也没人拉 —— 正是停等账本抓的那一族。
    // 编排器的 why 按内容语言写（orchestrator.mjs 的「到达 maxCycles={n}」）：中英两种开头都认
    continueIf: (kind, p) => (kind === 'stalled' && /^(到达|Reached) maxCycles/.test(String(p.why ?? '')))
      || kind === 'awaiting_check' || kind === 'awaiting_verdict' });
}

/** 所有该拉起的任务（含"为什么不拉"）。 */
export function dueTasks(db, opts = {}) {
  const out = [];
  // waiting 也要过一遍 assessTask：它可能有一条未消费的计划变更在等着被处理。
  // done 且没合并、有没消费的修正 / 新指令的也过一遍（见 assessTask 里 doneWork）
  for (const t of db.all(`SELECT id, status, merged_at FROM tasks WHERE status IN ('planning','running','waiting')
      OR (status='done' AND merged_at IS NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.task_id=tasks.id AND m.consumed_at IS NULL AND m.kind IN ('correction','instruction')))
      ORDER BY created_at`)) {
    out.push({ taskId: t.id, ...assessTask(db, t, opts) });
  }
  return out;
}

// ── 心跳 ─────────────────────────────────────────────────────────────────
// 守护进程可能跑在看板进程里（web --daemon），也可能是独立进程（cli daemon / 计划任务）。看板要如实显示"自动运行"开没开，
// 不能只看自己启动时带没带 --daemon：每轮往 <home>/daemon.heartbeat 写一行 { pid, at, intervalMs }，看板读它。
// 用墙上时钟而不是注入的 clock（测试会拨 clock；心跳是给另一个进程比对"现在"用的）。写失败不影响守护循环。
const heartbeatFile = (home) => join(home, 'daemon.heartbeat');
function beat(home, intervalMs) {
  try { writeFileSync(heartbeatFile(home), JSON.stringify({ pid: process.pid, at: Date.now(), intervalMs })); } catch { /* 只读盘等：不报 */ }
}
/** 看板用：最近有没有心跳。超过 max(3 个间隔, 60 秒) 没更新算停了（进程被杀不会清文件）。 */
export function daemonStatus(home, { at = Date.now() } = {}) {
  try {
    const h = JSON.parse(readFileSync(heartbeatFile(home), 'utf8'));
    const age = at - Number(h.at);
    const alive = age >= 0 && age <= Math.max(3 * Number(h.intervalMs || 15_000), 60_000);
    return { alive, pid: h.pid ?? null, lastBeatAt: Number(h.at), intervalMs: Number(h.intervalMs || 0) };
  } catch { return { alive: false, pid: null, lastBeatAt: null, intervalMs: 0 }; }
}

/**
 * 轮询循环：每 intervalMs 扫一次超时链，再把该拉的拉起来。返回 { tick, stop }。
 * 通知与打印都交给 onEvent，守护进程本身不知道通道。
 * makeExec：项目推进里变基验收 / 项目级验收用的执行器工厂；不给 = 按项目配置起沙箱（离线场景集给宿主执行器）。
 */
export function startDaemon(db, { home, launcher, intervalMs = 15_000, iterations = null, onEvent = () => {}, alive = pidAlive, clock = now, notifyOpts = null, liveness = null, runtime = makeRuntimeHealth({ lang: () => contentLang(db) }), dbPath = null, invariants = true,
  prWatcher = undefined, issueWatcher = undefined, makeExec = null }) {
  const ghGate = { holdUntil: 0 };   // GitHub 额度不够就整体等：PR 与 issue 两个轮询器共用
  // 交付后回路：盯已交付的 PR。只读（部署级连接），所以放在急停判断之前；它触发的修复自己看急停
  const prw = prWatcher === undefined ? makePrWatcher(db, { fetchFn: notifyOpts?.fetchFn ?? globalThis.fetch, env: notifyOpts?.env ?? process.env, onChange: async (item, prev, next, ctx) => {
      onEvent({ type: 'pr_changed', ref: item.taskId ?? item.projectId, state: next.state, ci: next.ci?.state ?? null });
      const r = await onCiChange(db, item, prev, next, ctx);
      if (r?.started || r?.asked) onEvent({ type: r.started ? 'ci_fix_started' : 'ci_failed_asked', ref: item.taskId ?? item.projectId, why: r.why ?? null });
      const rv = onReviewChange(db, item, prev, next, ctx);
      if (rv.auto.length || rv.blocked.length) onEvent({ type: 'pr_review', ref: item.taskId, auto: rv.auto, blocked: rv.blocked.map((x) => x.id) });
    }, gate: ghGate }) : prWatcher;
  // 入站：带标签的 GitHub issue → 添加任务的草稿。只读；起草本身（花模型钱）在急停之后的 assessProjectPlan 里
  const isw = issueWatcher === undefined ? makeIssueWatcher(db, { fetchFn: notifyOpts?.fetchFn ?? globalThis.fetch, env: notifyOpts?.env ?? process.env, gate: ghGate }) : issueWatcher;
  // 修好了的推回 PR：推送是对外动作，放在急停判断之后；推的人是授权修这一轮的那个人
  const redeliver = (at) => redeliverFixes(db, { at, doneHeadOf,
    workspaceOf: (id) => join(home, 'workspaces', id),
    signoffOk: redeliverSignoffOk,
    deliver: (o) => offThread(db, 'deliverTask', { ...o, home, env: { ...(notifyOpts?.env ?? process.env) }, fetchFn: notifyOpts?.fetchFn ?? globalThis.fetch }) });
  // 容器运行时的状态：不在的时候不拉要用沙箱的那几步（run、项目推进里的变基验收 / 项目级验收），
  // 不烧退避表的重试次数；起草、规划照常。状态变化各记一条审计，看板与活动流据此说话。
  let runtimeWasOk = true;
  let pausedWas = false;
  let mailPolledAt = -Infinity;   // 邮件答复：上次收信的时刻（每分钟最多收一轮）
  let mailFailing = false;        // 收信连不上：回信会一直躺在邮箱里没人处理，从好到坏 / 从坏到好各告诉管理员一次
  // 熔断 / 换用备用 / 恢复审计的水位，启动时取当前最大 id —— 守护进程重启不把旧事再报一遍
  const HEALTH_ACTIONS = ['llm_breaker_opened', 'llm_breaker_closed', 'llm_fallback_used'];
  const healthSql = `action IN (${HEALTH_ACTIONS.map(() => '?').join(',')})`;
  // 部署级的事告诉全体管理员（原来只告诉最早的那一位）：进发件箱，这一拍末尾统一推（个人通道，没有就退到部署级 .env）。
  const notifyAdmins = (name, { title, text, ref }) => { try { emitSignal(db, name, { to: ['admins'], title, text, ref }); } catch (e) { onEvent({ type: 'notify_failed', error: e.message }); } };
  let healthSeen = db.one(`SELECT COALESCE(MAX(id), 0) AS m FROM audit_log WHERE ${healthSql}`, ...HEALTH_ACTIONS).m;
  const hasWorkspace = (taskId) => existsSync(join(home, 'workspaces', taskId));
  audit(db, { actorKind: 'system', action: 'daemon_started', targetType: 'daemon', targetId: String(process.pid),
    payload: { pid: process.pid, intervalMs } });
  // 拉起了但子进程根本没起来（Docker 没开、工作区坏了、令牌失效）：子进程 die 在写 *_started 之前，
  // 库里连起始行都没有 —— 上面按审计轨的判断看不见这次失败，会每一轮都再拉一次。
  // 所以自己记：每次拉起时记下当时的审计轨末尾，子进程退了却没有新的起始行 → 算一次
  // 启动失败，按同一张退避表等；连续超过表长就不再拉，等人修。
  beat(home, intervalMs);
  const launches = new Map();   // taskId -> { auditId, verb, failures, failedAt }
  const maxAuditId = () => db.one(`SELECT max(id) id FROM audit_log`)?.id ?? 0;
  const launchGate = (taskId, at) => {
    const l = launches.get(taskId);
    if (!l || launcher.running(taskId)) return null;
    if (l.auditId !== null) {
      const started = db.one(`SELECT count(*) n FROM audit_log WHERE action=? AND target_id=? AND id>?`, LIFECYCLE[l.verb].start, taskId, l.auditId).n;
      l.failures = started ? 0 : l.failures + 1;
      l.failedAt = started ? null : at;
      l.auditId = null;   // 每次退出只结算一次
    }
    if (!l.failures) return null;
    const wait = RETRY_BACKOFF_MS[l.failures - 1];
    if (wait === undefined) return `gave_up:launch_failed#${l.failures}`;
    return at < l.failedAt + wait ? `backoff:launch_failed#${l.failures}` : null;
  };
  // 子进程当场就没起来（spawn 同步抛 EMFILE / EAGAIN 之类的系统错误）：同样计一次失败、进退避 ——
  // 原来只有"起了但没活"才进退避，当场起不来的每一拍都重试一次（故障注入查出）。暂停、已有子进程这类不算。
  const spawnFailed = (taskId, verb, e, at) => {
    if (!/^E[A-Z]+$/.test(String(e?.code ?? ''))) return;
    const prev = launches.get(taskId);
    launches.set(taskId, { auditId: null, verb, failures: (prev?.failures ?? 0) + 1, failedAt: at });
  };
  // 项目推进（project.mjs）：每拍先推进一步再看该拉谁。推进失败（deliver 推不上去、ff 合不了）按同一张退避表等，
  // 不然每 15 s 往审计轨写一条一样的错。
  const projectFails = new Map();   // projectId -> { n, at }
  const advanceProjects = async (at) => {
    const out = [];
    for (const p of db.all(`SELECT id, owner_id FROM projects WHERE status='active'`)) {
      let f = projectFails.get(p.id);
      // 挂过"合并出错"事项、人已经答了 → 清掉退避，这一拍就再试。
      if (f?.questionId && db.one(`SELECT status FROM questions WHERE id=?`, f.questionId)?.status === 'answered') {
        projectFails.delete(p.id); f = null;
      }
      // 退避表用完之后按最长的那一档继续试（不能是 `?? Infinity`：那样永远不再试、也不告诉任何人）。
      if (f && at < f.at + (RETRY_BACKOFF_MS[f.n - 1] ?? RETRY_BACKOFF_MS.at(-1))) continue;
      try {
        // onEvent 透传：变基与"变基之后重跑"都发生在这条路上，而它们会起容器、花时间 ——
        // 守护进程的事件流里看不见它们，人就只能从审计轨里事后考古。
        // 放到 worker 线程（offthread.mjs）：推进要跑几十条同步 git，与看板同进程时会把看板卡住几秒
        const r = await offThread(db, 'advanceProject', { projectId: p.id, home, userId: p.owner_id, makeExec, onEvent: (e) => onEvent({ projectId: p.id, ...e }) });
        projectFails.delete(p.id);
        if (r.advanced) { out.push({ projectId: p.id, ...r }); onEvent({ type: 'project', projectId: p.id, ...r }); }
      } catch (e) {
        const n = (f?.n ?? 0) + 1;
        let questionId = f?.questionId ?? null;
        // 退避表走完一遍还不行 → 挂一条事项。只挂一次（同一段连续失败里），答了才会清。
        if (n >= RETRY_BACKOFF_MS.length && !questionId) {
          try { questionId = raiseAdvanceFailed(db, { projectId: p.id, taskId: e.taskId ?? null, error: e.message, attempts: n, at }).questionId; }
          catch (e2) { audit(db, { actorKind: 'system', action: 'handback_raise_failed', targetType: 'project', targetId: p.id, payload: { error: e2.message } }); }
        }
        projectFails.set(p.id, { n, at, questionId });
        audit(db, { actorKind: 'system', action: 'project_advance_failed', targetType: 'project', targetId: p.id, payload: { error: e.message, attempt: n, taskId: e.taskId ?? null, questionId } });
        onEvent({ type: 'project_error', projectId: p.id, error: e.message, attempt: n });
      }
    }
    return out;
  };
  let busy = false;
  const tick = async () => {
    if (busy) return null;
    busy = true;
    beat(home, intervalMs);
    newTrace();   // 每一拍一条新的因果链：这一拍拉起的子进程经环境变量继承它，两边日志按 trace 对得上
    try {
      const at = clock();
      const swept = sweepTimeouts(db, { onEvent: (e) => onEvent({ type: 'sweep', event: e }) });
      // 被硬杀的进程：起了没退、进程已经不在 → 补收尾（kind=crashed，写明是守护进程查出来的）+ 一条给人看的 process_crashed
      sweepCrashes(db, { at, alive, onEvent });
      // 通知按人：事项创建时解析出的收件人各发各的；没配通道的人只能看看板 / CLI。
      const notified = notifyOpts ? await notifyPendingQuestions(db, notifyOpts).catch((e) => { onEvent({ type: 'notify_failed', error: e.message }); return []; }) : [];
      for (const n of notified) onEvent({ type: 'notified', ...n });
      if (notifyOpts) for (const n of await notifyPendingDeliveries(db, notifyOpts).catch((e) => { onEvent({ type: 'notify_failed', error: e.message }); return []; })) onEvent({ type: 'notified', ...n });
      // 换班交接每轮都看（值班者变了就给接班人推一份）。定时的全量待办摘要已由推送队列的汇总推送取代。
      if (notifyOpts) {
        for (const h of await handoverDigests(db, { at, ...notifyOpts }).catch((e) => { onEvent({ type: 'notify_failed', error: e.message }); return []; })) onEvent({ type: 'handover', ...h });
      }
      // 模型目录漂移检查：按间隔，或绑定里出现没查过的键。只报告不改目录；有问题就通知管理员（个人通道，退到部署级）。
      if (notifyOpts?.catalogCheckEvery) {
        // 目录与在用的键每轮从库读：绑定 / 目录改了不用重启守护进程。测试可用 notifyOpts.catalogKeys / catalog / vendors 覆盖。
        const { catalogCheckEvery, env = process.env, extraCmd = null, fetchFn = globalThis.fetch } = notifyOpts;
        const reg = checkableCatalog(db);
        const due = catalogCheckDue(db, { every: catalogCheckEvery, at, keysInUse: notifyOpts.catalogKeys ?? reg.keysInUse });
        if (due.due) {
          try {
            const r = await checkCatalog({ catalog: notifyOpts.catalog ?? reg.catalog, vendors: notifyOpts.vendors ?? reg.vendors, env, fetchFn, at, lang: contentLang(db) });
            recordCatalogCheck(db, r, { by: 'daemon', lang: contentLang(db) });
            let sent = 0;
            if (r.warnings > 0) {
              const s = await pushSignal(db, 'deploy.catalog', { to: ['admins'], title: `[SuperIntern] ${tl(contentLang(db), '模型目录有 {n} 项要看一眼', { n: r.warnings })}`, text: renderCatalogCheck(r, { onlyProblems: true, lang: contentLang(db) }), ref: 'catalog' }, { env, extraCmd, fetchFn });
              sent = s.receipts.filter((x) => x.ok).length;
            }
            onEvent({ type: 'catalog', why: due.why, warnings: r.warnings, fetchErrors: r.fetchErrors.length, sent });
          } catch (e) { onEvent({ type: 'notify_failed', error: tl(contentLang(db), '目录检查：{msg}', { msg: e.message }) }); }
        }
      }
      const rt = runtime ? await runtime.fresh() : { ok: true };
      if (rt && rt.ok !== runtimeWasOk) {
        runtimeWasOk = !!rt.ok;
        audit(db, { actorKind: 'system', action: rt.ok ? 'runtime_up' : 'runtime_down', targetType: 'deployment', targetId: 'runtime', payload: { cli: rt.cli ?? null, why: rt.why ?? null, version: rt.version ?? null } });
        onEvent({ type: rt.ok ? 'runtime_up' : 'runtime_down', why: rt.why ?? null });
        // 掉了就告诉管理员（个人通道，退到部署级；与模型目录检查同一套）。恢复不另发 —— 看板那一条自己会消失
        if (!rt.ok && notifyOpts) {
          const L = contentLang(db);
          notifyAdmins('deploy.runtime_down', { title: `[SuperIntern] ${tl(L, '沙箱用不了：{cli} 没在运行', { cli: rt.cli ?? 'Docker' })}`,
            text: `${tl(L, '要改代码、跑测试的步骤已暂停（不算失败、不耗重试次数）。在服务器上把 {cli} 启动起来，系统会自己接着跑。', { cli: rt.cli ?? 'Docker' })}

${rt.why ?? ''}`, ref: 'runtime' });
        }
      }
      // 模型服务商熔断：编排器子进程写的审计，守护进程按水位捡起来告诉管理员（个人通道，退到部署级）
      {
        const rows = db.all(`SELECT id, action, target_id, payload FROM audit_log WHERE id > ? AND ${healthSql} ORDER BY id`, healthSeen, ...HEALTH_ACTIONS);
        if (rows.length) {
          healthSeen = rows.at(-1).id;
          const L = contentLang(db);
          const n = llmHealthNotice(rows.map((r) => ({ action: r.action, targetId: r.target_id, payload: (() => { try { return JSON.parse(r.payload); } catch { return {}; } })() })), L);
          onEvent({ type: 'llm_health', events: rows.length, lines: n?.lines ?? [] });
          if (n && notifyOpts) notifyAdmins('deploy.llm_health', n);
        }
      }
      // 运行期不变量：各条按自己的周期查，结果进 invariant_state（健康卡读）；从对到错 / 从错到对告诉管理员。
      // 放在急停判断之前：急停时别的几条照查（停等那条自己会跳过）。出错不连累这一拍
      if (invariants !== false) {
        try {
          const t0 = performance.now();
          const inv = sweepInvariants(db, { at, home, alive, assess: (d2, t, o) => assessTask(d2, t, o), assessOpts: { isLive: launcher.running, hasWorkspace, alive } });
          db.timing?.('invariants_sweep', performance.now() - t0);
          const tr = inv.transitions.filter((t) => !t.advice);   // 重查提醒只在健康卡上显示，不推通知
          if (tr.length) {
            const n = invariantNotice(tr, contentLang(db));
            onEvent({ type: 'invariants', transitions: tr, lines: n?.lines ?? [] });
            if (n && notifyOpts) notifyAdmins('deploy.invariants', n);
          }
        } catch (e) { onEvent({ type: 'notify_failed', error: tl(contentLang(db), '运行期自检：{msg}', { msg: e.message }) }); }
      }
      // 邮件答复：配了 IMAP_URL 就收一轮回信（每分钟最多一次）。急停时照收：答复是人给的，不花模型钱。
      // 放在发件箱之前：收信连不上 / 恢复的告警当拍就推出去
      if (notifyOpts && at - mailPolledAt >= 60_000) {
        mailPolledAt = at;
        const { env, mailFetchFn, sendMailFn } = notifyOpts;
        try {
          const mr = await pollMailReplies(db, { env, ...(mailFetchFn ? { fetchFn: mailFetchFn } : {}), ...(sendMailFn ? { sendMailFn } : {}) });
          if (mr && (mr.results.length || mr.errors.length)) onEvent({ type: 'mail_replies', outcomes: mr.results.map((r) => r.outcome), errors: mr.errors });
          if (mr && mailFailing) { mailFailing = false; const L = contentLang(db); notifyAdmins('deploy.mail_inbound', { title: tl(L, '[SuperIntern] 邮件答复恢复了'), text: tl(L, '守护进程又能收到回信了；之前积着的回信这一轮已经处理。'), ref: 'mail_inbound' }); }
        } catch (e) {
          onEvent({ type: 'notify_failed', error: tl(contentLang(db), '收邮件答复：{msg}', { msg: e.message }) });
          if (!mailFailing) {
            mailFailing = true;
            const L = contentLang(db);
            notifyAdmins('deploy.mail_inbound', { title: tl(L, '[SuperIntern] 邮件答复收不到信'), ref: 'mail_inbound',
              text: tl(L, '守护进程连不上收信服务器（.env 的 IMAP_URL）：{msg}\n修好之前，大家回的邮件会一直躺在邮箱里、不算答复，请提醒他们到看板上答。修好后积着的回信会补处理。', { msg: String(e.message).slice(0, 200) }) });
          }
        }
      }
      // 状态报告：到点的人各排一份进推送队列（一个时刻点只排一次），下面的发件箱按工作时间与限额推
      try { const due = queueDueReports(db, { at }); if (due.length) onEvent({ type: 'reports_queued', reports: due }); }
      catch (e) { onEvent({ type: 'notify_failed', error: tl(contentLang(db), '状态报告：{msg}', { msg: e.message }) }); }
      // 发件箱：这一拍以及别的进程（编排器、看板）记下的不阻塞信号，统一在这里推；认领在事务里，至多推一次
      if (notifyOpts) {
        const { env, extraCmd, fetchFn, spawn } = notifyOpts;
        for (const n of await deliverSignals(db, { env, extraCmd, fetchFn, spawn }).catch((e) => { onEvent({ type: 'notify_failed', error: e.message }); return []; })) onEvent({ type: 'signal_sent', ...n });
      }
      if (prw) {
        try { await prw.tick(at); } catch (e) { onEvent({ type: 'notify_failed', error: tl(contentLang(db), '盯 PR：{msg}', { msg: e.message }) }); }
      }
      if (isw) {
        try { await isw.tick(at); } catch (e) { onEvent({ type: 'notify_failed', error: tl(contentLang(db), '看 GitHub issue：{msg}', { msg: e.message }) }); }
      }
      // 定时任务：到点起草一轮添加任务（只写库；起草本身在急停之后）
      try { const fired = fireSchedules(db, { at }); if (fired.length) onEvent({ type: 'schedules_fired', fired }); }
      catch (e) { onEvent({ type: 'notify_failed', error: tl(contentLang(db), '定时任务：{msg}', { msg: e.message }) }); }
      // 部署级急停：不推进项目、不拉起任何进程；停等账本也不扫 —— 那时所有任务都"静止"，
      // 扫了会把管理员的暂停误判成停摆、给负责人挂报警事项。超时、通知、摘要照常（那些是给人的，不花模型钱）。
      const paused = !!getSetting(db, 'deploy.paused');
      if (paused !== pausedWas) { pausedWas = paused; onEvent({ type: paused ? 'deploy_paused' : 'deploy_resumed' }); }
      if (paused) return { swept, projects: [], launched: [], skipped: [], liveness: null, paused: true };
      try { const pushed = await redeliver(at); if (pushed.length) { onEvent({ type: 'ci_fix_redelivered', tasks: pushed }); for (const id of pushed) await prw?.pollNow({ taskId: id }, at).catch(() => {}); } }
      catch (e) { onEvent({ type: 'notify_failed', error: tl(contentLang(db), '把修好的推回 PR：{msg}', { msg: e.message }) }); }
      const sandboxOk = !rt || rt.ok !== false;
      const projects = sandboxOk ? await advanceProjects(at) : [];
      // 项目规划器：proposed 的项目按 assessProjectPlan 拉 `project plan <id>`；起不来走同一张退避表。
      const launched = [], skipped = [];
      for (const p of db.all(`SELECT id, status, draft_question FROM projects WHERE status IN ('proposed','active','stalled','done')`)) {
        const a = assessProjectPlan(db, p, { at, isLive: launcher.running, alive });
        if (!a.due) continue;
        const gate = launchGate(p.id, at);
        if (gate) { skipped.push({ taskId: p.id, reason: gate }); continue; }
        try {
          const auditId = maxAuditId();
          const r = launcher.launch(p.id, { verb: 'project-plan', actorKind: 'system', actorId: 'daemon', action: 'project_plan_launched_by_daemon', reason: a.reason });
          const prev = launches.get(p.id);
          launches.set(p.id, { auditId, verb: 'project-plan', failures: prev?.failures ?? 0, failedAt: prev?.failedAt ?? null });
          launched.push({ taskId: p.id, verb: 'project-plan', reason: a.reason, ...r });
          onEvent({ type: 'launched', taskId: p.id, verb: 'project-plan', reason: a.reason, ...r });
        } catch (e) {
          spawnFailed(p.id, 'project-plan', e, at);
          onEvent({ type: 'launch_failed', taskId: p.id, reason: a.reason, error: e.message });
        }
      }
      // 公平调度：按归属人交错拉起；每人同时在跑的任务数到上限的，这一拍不拉
      const perPersonCap = Number(getSetting(db, 'deploy.max_running_per_person'));
      const fair = fairOrder(db, dueTasks(db, { at, isLive: launcher.running, hasWorkspace, alive }).filter((d) => d.due), { at });
      for (const d of fair.ordered) {
        if (perPersonCap > 0 && d.payerId !== '(project)' && (fair.running.get(d.payerId) ?? 0) >= perPersonCap) { skipped.push({ taskId: d.taskId, reason: `fair_share:${perPersonCap}` }); continue; }
        if (!sandboxOk && (d.verb ?? 'run') === 'run') { skipped.push({ taskId: d.taskId, reason: 'runtime_down' }); continue; }
        const gate = launchGate(d.taskId, at);
        if (gate) { skipped.push({ taskId: d.taskId, reason: gate }); continue; }
        try {
          const auditId = maxAuditId();
          const verb = d.verb ?? 'run';
          const r = launcher.launch(d.taskId, { verb, iterations, actorKind: 'system', actorId: 'daemon', action: `${verb}_launched_by_daemon`, reason: d.reason });
          const prev = launches.get(d.taskId);
          launches.set(d.taskId, { auditId, verb, failures: prev?.failures ?? 0, failedAt: prev?.failedAt ?? null });
          launched.push({ taskId: d.taskId, verb, reason: d.reason, ...r });
          fair.running.set(d.payerId, (fair.running.get(d.payerId) ?? 0) + 1);   // 这一拍刚拉起的也算在跑
          onEvent({ type: 'launched', taskId: d.taskId, verb, reason: d.reason, ...r });
        } catch (e) {
          spawnFailed(d.taskId, d.verb ?? 'run', e, at);
          onEvent({ type: 'launch_failed', taskId: d.taskId, reason: d.reason, error: e.message });
        }
      }
      // 停等账本（liveness.mjs）：扫完该拉的之后，看一眼**没被拉、也说不出在等谁**的任务。
      // 放在最后是故意的 —— 这一轮该拉起的都已经拉了，剩下还静止的才是真静止。
      const live = liveness === false ? null
        : sweepLiveness(db, { at, assess: (d2, t, o) => assessTask(d2, t, o), isLive: launcher.running, hasWorkspace, alive,
          graceMs: liveness?.graceMs ?? UNKNOWN_GRACE_MS, threshold: liveness?.threshold ?? REPEAT_THRESHOLD,
          onEvent: (e) => onEvent(e) });
      // 状态库例行维护：到点的检查 / 备份 / 检查点。放在最后：该拉的都拉了再做；出错不连累这一拍
      const maintenance = dbPath ? await dbMaintenance(db, dbPath, { at, onEvent }).catch((e) => ({ error: e.message })) : null;
      // 日常清理：旧日志、daemon.log 截断、已合并任务的依赖目录。每天一次
      let housework = null;
      try { housework = housekeeping(db, home, { at, onEvent }); } catch (e) { housework = { error: e.message }; }
      return { swept, projects, launched, skipped, liveness: live, maintenance, housework };
    } catch (e) {
      // 一拍出错不能带走整个进程：tick 由 setInterval 调、没有人 await 它，
      // 这里抛出去就是未处理的 rejection —— Node 默认直接退出，`web --daemon` 时看板也跟着没了。
      // 记进审计（看板与复盘看得见）、报给事件流，下一拍照常再来；同一个错连着出也只是每拍一行，不会刷爆。
      try { audit(db, { actorKind: 'system', action: 'daemon_tick_failed', payload: { error: String(e?.message ?? e).slice(0, 500), stack: String(e?.stack ?? '').split('\n').slice(1, 6).map((l) => l.trim()) } }); } catch { /* 库本身出错时只剩事件流 */ }
      onEvent({ type: 'tick_failed', error: String(e?.message ?? e) });
      return null;
    } finally { busy = false; }
  };
  const timer = setInterval(tick, intervalMs);
  return { tick, stop: () => { clearInterval(timer); try { rmSync(heartbeatFile(home), { force: true }); } catch { /* 无所谓 */ } } };
}
