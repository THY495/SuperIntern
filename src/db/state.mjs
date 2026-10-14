// 状态机：带状态的七张表，所有状态变化都从这里走。
//
// 原来 95 处 `UPDATE … SET status=` 散在 20 个文件里：大多是盲写（不看当前是什么），多进程并发时后写的覆盖先写的；
// 有的有审计、有的没有 —— 拿本机真实库跑复盘，21 个任务"置 done 却没有 task_done"（20 个是规划载体）就出在这里。
// 现在：
//   · 允许的迁移在 TRANSITIONS 里（按全套测试的普查 + 每处调用点声明的前置状态定，见 transition-recorder.mjs）；
//     库层另有 BEFORE UPDATE 触发器按同一张表兜底（v25 迁移，值是写死的字面量；改表要配新迁移，测试钉住两边一致）；
//   · transition() 在一个事务里：读当前状态 → 校验 → 条件更新 → 写审计。每一次状态变化都有一行审计（默认 status_changed，
//     调用方可以换成自己的动作名，例如 task_done），from / to 一并记下；
//   · 当前状态已经是目标 → 什么都不做（幂等，不写审计）；
//   · 调用方声明了前置状态（from）而当前不在其中 → 默认抛 StaleStateError（别人先改了），
//     onMismatch: 'skip' 时静默跳过（原来那些 `WHERE status='blocked'` 的条件写法就是这个意思）。

import { audit as writeAudit } from './db.mjs';
import { I18nError } from '../i18n/index.mjs';
import { checkFence } from './lease.mjs';

/** 每张表：当前状态 → 允许去的状态。没列的都不许（库层触发器同样拦）。 */
export const TRANSITIONS = {
  // 任务的生命周期本来就宽：中止可反悔（回到中止前的去处）、done 之后收到修正会重开、规划载体从 planning 直接 done。
  // 只禁两条说不通的：没恢复就从中止 / 暂停直接算完成。
  tasks: {
    planning: ['running', 'waiting', 'suspended', 'done', 'aborted'],
    running: ['planning', 'waiting', 'suspended', 'done', 'aborted'],
    waiting: ['planning', 'running', 'suspended', 'done', 'aborted'],
    suspended: ['planning', 'running', 'waiting', 'aborted'],
    done: ['planning', 'running', 'waiting', 'suspended', 'aborted'],
    aborted: ['planning', 'running', 'waiting', 'suspended'],
  },
  // 步骤：void 是终点（被修正作废的不复活）；done 只能回 pending（修正标了影响、重做）或作废。
  nodes: {
    pending: ['ready', 'running', 'blocked', 'review', 'done', 'void', 'failed'],
    ready: ['pending', 'running', 'blocked', 'review', 'done', 'void', 'failed'],
    running: ['pending', 'blocked', 'review', 'done', 'void', 'failed'],
    blocked: ['pending', 'ready', 'running', 'void', 'failed'],
    review: ['pending', 'running', 'done', 'void', 'failed'],
    done: ['pending', 'void'],
    failed: ['pending', 'void'],
    void: [],
  },
  // 事项：答复 / 按默认处理 / 撤回都是终点。
  questions: {
    open: ['escalated', 'answered', 'defaulted', 'withdrawn'],
    escalated: ['answered', 'defaulted', 'withdrawn'],
    answered: [],
    defaulted: [],
    withdrawn: [],
  },
  // 项目：做完之后追加任务会重新 active；中止可反悔。
  projects: {
    proposed: ['active', 'done', 'aborted'],
    active: ['proposed', 'done', 'stalled', 'aborted'],
    stalled: ['active', 'done', 'aborted'],
    done: ['active', 'stalled', 'aborted'],
    aborted: ['proposed', 'active'],
  },
  revisions: { proposed: ['applied', 'rejected'], applied: [], rejected: [] },
  handover_requests: { open: ['approved', 'rejected', 'withdrawn'], approved: [], rejected: [], withdrawn: [] },
  decision_registry: { active: ['void'], void: [] },
};

/** 审计里的 target_type（单数）。 */
const TARGET = { tasks: 'task', nodes: 'node', questions: 'question', projects: 'project', revisions: 'revision', handover_requests: 'handover_request', decision_registry: 'decision' };

export const canTransition = (table, from, to) => !!TRANSITIONS[table]?.[from]?.includes(to);

/** 别人先改了状态：调用方声明的前置状态不成立。 */
export class StaleStateError extends I18nError {
  constructor(table, id, current, to) {
    super('{table} {id} 当前是 {current}，不能改成 {to}（可能已被别人处理）', { table, id, current, to });
    this.stale = true; this.current = current;
  }
}

/**
 * 改一行的状态。
 * @param {object} opts
 *   from        允许的前置状态（不给 = 只看 TRANSITIONS）
 *   onMismatch  'throw'（默认）| 'skip'：前置状态不符时
 *   set         同时写的其它列 { 列名: 值 }
 *   setSql      同时写的表达式（只给代码里的常量，例如 'retry_count=retry_count+1'；不接受外部输入）
 *   audit       { action, actorKind, actorId, payload } —— 换掉默认的 status_changed；from / to 并进 payload
 *   reason      写进默认审计的一句话
 * @returns {{changed: boolean, from: string|null, skipped?: boolean}}
 */
export function transition(db, table, id, to, { from = null, onMismatch = 'throw', set = {}, setSql = null, audit = null, reason = null } = {}) {
  if (!TRANSITIONS[table]) throw new Error(`不是带状态的表：${table}`);
  return db.tx(() => {
    const row = db.one(`SELECT status FROM ${table} WHERE id=?`, id);
    if (!row) throw new I18nError('{table} 里没有 {id}', { table, id });
    const cur = row.status;
    const cols = Object.keys(set);
    if (cur === to) {
      // 状态已经是目标：状态不动、不写审计；但同时要写的其它列照写（原来的盲写也会写它们）
      if (cols.length || setSql) db.run(`UPDATE ${table} SET ${[...cols.map((c) => `${c}=?`), ...(setSql ? [setSql] : [])].join(', ')} WHERE id=?`, ...cols.map((c) => set[c]), id);
      return { changed: false, from: cur };
    }
    if (from && !from.includes(cur)) {
      if (onMismatch === 'skip') return { changed: false, from: cur, skipped: true };
      throw new StaleStateError(table, id, cur, to);
    }
    if (!canTransition(table, cur, to)) throw new I18nError('{table} {id}：不允许从 {from} 改成 {to}', { table, id, from: cur, to });
    // 写入防护：本进程持有某任务的租约时，对它的任务 / 步骤状态写入先核对代数 —— 被接管了就不许再写
    checkFence(db, table, id);
    const assigns = ['status=?', ...cols.map((c) => `${c}=?`), ...(setSql ? [setSql] : [])].join(', ');
    const r = db.run(`UPDATE ${table} SET ${assigns} WHERE id=? AND status=?`, to, ...cols.map((c) => set[c]), id, cur);
    if (Number(r.changes) !== 1) throw new StaleStateError(table, id, cur, to);   // 事务里先拿了写锁，到这里不该发生；防御
    const a = audit ?? {};
    writeAudit(db, { actorKind: a.actorKind ?? 'system', actorId: a.actorId ?? null, action: a.action ?? 'status_changed',
      targetType: TARGET[table], targetId: id, payload: { ...(a.payload ?? {}), from: cur, to, ...(reason && !a.payload?.reason ? { reason } : {}) } });
    return { changed: true, from: cur };
  });
}

/** 按条件找出一批行，逐行 transition（每行各一条审计）。where 只给代码里的常量 SQL。返回改了几行。 */
export function transitionWhere(db, table, where, params, to, opts = {}) {
  return db.tx(() => {
    let n = 0;
    for (const { id } of db.all(`SELECT id FROM ${table} WHERE ${where}`, ...params)) {
      if (transition(db, table, id, to, { onMismatch: 'skip', ...opts }).changed) n++;
    }
    return n;
  });
}

/** 库层触发器的 SQL（v25 迁移里写死了同样的内容；测试比对两边一致）。 */
export function transitionTriggerSql(table, graph = TRANSITIONS[table]) {
  const pairs = Object.entries(graph).flatMap(([f, tos]) => tos.map((t) => `'${f}>${t}'`)).join(',');
  return `CREATE TRIGGER IF NOT EXISTS trg_${table}_transition BEFORE UPDATE OF status ON ${table}
  WHEN NEW.status IS NOT OLD.status AND (OLD.status || '>' || NEW.status) NOT IN (${pairs || "''"})
  BEGIN SELECT RAISE(ABORT, '${table}: illegal status transition'); END;`;
}
