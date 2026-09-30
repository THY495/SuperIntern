// 停等账本：给"安静"装一个判据。
//
// 这个系统的正常态就是不动 —— 人不被打扰本来就是目标。代价是：**一个正在等人答题的任务，和一个被
// 调度器彻底遗忘的任务，长得一模一样**：都没报错、都没进程、都没人催。别的系统里漏接会自己暴露
// （队列堆积、请求超时、连接报错），这里不会。同一个形状的漏接会一再重演，
// 而如果每次修的都是调用方（把任务挪回白名单、把状态加进白名单、加一个特例），
// **没有一次修的是判据** —— 下一次就一定还会来，而且来的时候照样是静默的。
//
// 判据：**每一个没结束的东西，必须持有一个"可解引用的接收者"** —— 谁会让它动起来。只有四种合法：
//   self      它自己（有 pid，而且那个 pid 还活着）
//   clock     时钟（有一个具体的 readyAt）
//   human     某个人（有 userId，**而且他收件箱里真有一条对应的事项**；光写个 needs_human 不算）
//   upstream  另一件没完成的事（有它的 id）
// 持有 null、或者只持有一个"长得像理由的字符串"，就是 unknown。`status:waiting` 是最典型的一个：
// 它说了任务在什么状态，对"谁会把它弄出这个状态"只字未提 —— 这类漏接往往就藏在这个标签底下。
//
// 于是白名单发生了一次反转，这是本文件的全部价值：
//   `dueTasks` 的白名单决定"看哪些任务"，漏了 → 静默；
//   这里的白名单决定"哪些理由算合法的静止"，漏了 → 报警。
//
// 第二件事是空转（例如授权类答复→撤销→再问同一个问题；两条交接校验互相矛盾 → 节点反复失败）：
// 停摆是"该动没动"，空转是"动了但不前进"。空转不需要判据，只需要一个计数器：在没有新信息进来的
// 前提下，系统重复了自己 N 次。两者共用一个出口 —— 升成一条给负责人的事项。
//
// ⚠️ 报警本身也是"人做了正确动作之后谁来接"。所以报警必须落成**事项**（进收件箱、有收件人、
// 不能超时自动消失），不能只打一行日志 —— 否则就是在用漏接的机制去修漏接。

import { markLike, markOf } from '../i18n/marks.mjs';
import { tl, contentLang, N_ } from '../i18n/index.mjs';
import { newId, now, audit } from '../db/db.mjs';
import { routeQuestion } from './routing.mjs';
import { signoffOf } from './deliver.mjs';
import { chainGraph } from './project.mjs';
import { answerableQuestion, waitingOnHuman } from './addressee.mjs';
import { maxOpenOf } from './project-settings.mjs';
import { appendStateOf, appendPending } from '../agent/project-append.mjs';

/** 合法的"静止理由"就这四种；第五种 unknown 不是理由，是缺陷。 */
export const STALL_KINDS = {
  self: N_('它自己（在跑，或这一轮就会被拉起来）'),
  clock: N_('在等一个到点会自己动起来的时刻'),
  human: N_('在等某个人答一条事项'),
  upstream: N_('在等另一件没完成的事'),
  unknown: N_('说不出在等谁 —— 这是缺陷，不是理由'),
};
// 用 N_ 登记过的原文按变量查（抽取器只认字面量，所以不写成 tl(L, 变量)）。
const tlN = tl;

/** 停多久才算停：刚动过的不报，避免把"正常的一瞬间"当成缺陷。 */
export const UNKNOWN_GRACE_MS = 30 * 60_000;
/** 同一件事重复到第几次算空转。escalate.mjs 的升档阈值在它下面，所以升档没救回来才轮到这里。 */
export const REPEAT_THRESHOLD = 3;

export const STALL_MARK = '【停等】';
export const LOOP_MARK = '【空转】';

const parse = (s) => { try { return JSON.parse(s ?? '{}'); } catch { return {}; } };
/** 事项文本归一化：只用来判"是不是同一个问题又问了一遍"，不参与任何语义判断。 */
const norm = (s) => String(s ?? '').replace(/\s+/g, '').replace(/[，。；：、,.;:!?！？「」『』（）()]/g, '');

// ── 未结束的东西 ─────────────────────────────────────────────────────────
// "结束"要按任务的来路分别定义，否则会把两种正常状态误报成缺陷：
//   独立任务：done 且签收已接受 = 结束。
//   项目里的契约任务：合并进项目分支才算结束 —— **签收接受但一直没合并，本身就是一个该报的停等**。
//   载体任务（project_order = 0）：它不执行，只负责记账与挂批准事项。它的"结束"= 项目不再是
//     proposed，且没有待批准的追加；在那之前它等的是批准事项，解引用得到人。
export function unfinishedTasks(db) {
  const rows = db.all(`SELECT id, title, status, project_id, project_order, merged_at FROM tasks WHERE status <> 'aborted' ORDER BY created_at`);
  return rows.filter((t) => {
    if (t.project_id && t.project_order === 0) {
      const p = db.one(`SELECT status FROM projects WHERE id=?`, t.project_id);
      return !!p && (p.status === 'proposed' || appendPending(appendStateOf(db, t.project_id)));
    }
    if (t.project_id) return !t.merged_at;
    return !(t.status === 'done' && signoffOf(db, t.id) === 'accepted');
  });
}

// ── 解引用 ───────────────────────────────────────────────────────────────
// `answerableQuestion` 搬去了 `addressee.mjs`：让路调度也要用它，而 project 反着 import
// liveness 会成环。从这里 re-export，调用方与测试的 import 路径不变。
export { answerableQuestion } from './addressee.mjs';

/** 它在等项目里的另一件事吗？返回能指过去的 id，指不过去就返回 null（宁可报警也不编一个理由）。 */
export function upstreamOf(db, task) {
  if (!task.project_id) return null;
  const L = contentLang(db);
  const p = db.one(`SELECT status FROM projects WHERE id=?`, task.project_id);
  const carrier = db.one(`SELECT id FROM tasks WHERE project_id=? AND project_order=0`, task.project_id)?.id ?? null;
  // 方案还没批准：整批任务都还不该动，等的是载体任务上那条批准事项。
  if (p?.status === 'proposed' && carrier && carrier !== task.id) return { projectId: task.project_id, taskId: carrier, why: tl(L, '项目方案还没批准') };
  // 载体任务（#0）自己没有活 —— 它是项目的壳，规划器与复盘都挂在**项目 id** 上跑，`assessTask` 一辈子
  // 只会说 `status:waiting|planning`。若这里直接 return null，载体就永远落到 unknown：
  // 项目本身一直在正常干活，载体却静止上百分钟，账本照判据报警并给负责人提一条 Ⅲ 级事项。
  // **判据没错，是它指不过去** —— 载体在等的就是项目本身：这一批还没做完的任务，或者复盘/达成确认那一趟。
  // 项目还没批准时不走这一条：那时载体身上挂着批准事项，等的是人，`answerableQuestion` 已经先认出来了。
  if (task.project_order === 0 && p?.status !== 'proposed') {
    const rest = chainGraph(db, task.project_id).filter((g) => !g.merged_at && g.status !== 'aborted');
    if (rest.length) return { projectId: task.project_id, taskId: rest[0].id, why: tl(L, '项目这一批还没做完（{orders}）', { orders: rest.map((g) => `#${g.order}`).join(' ') }) };
    return { projectId: task.project_id, taskId: null, why: tl(L, '项目这一批都合并了，在等复盘 / 达成确认走完') };
  }
  const graph = chainGraph(db, task.project_id);
  const me = graph.find((g) => g.id === task.id);
  if (!me) return null;
  const mergedOrders = new Set(graph.filter((g) => g.merged_at).map((g) => g.order));
  const unmet = (me.dependsOn ?? []).filter((n) => !mergedOrders.has(n));
  if (unmet.length) {
    const ids = unmet.map((n) => graph.find((g) => g.order === n)?.id).filter(Boolean);
    return { projectId: task.project_id, taskId: ids[0] ?? null, orders: unmet, why: tl(L, '依赖的 {orders} 还没合并', { orders: unmet.map((n) => `#${n}`).join(' ') }) };
  }
  // 依赖都满足了，但同时开着的任务已经到上限，轮不到它。
  if (!me.started) {
    const open = graph.filter((g) => g.id !== task.id && g.started && !g.merged_at && g.status !== 'aborted');
    const cap = maxOpenOf(db, task.project_id);
    if (open.length >= cap) {
      return { projectId: task.project_id, taskId: open[0].id,
        why: cap === 1 ? tl(L, '#{n} 正开着，同一时间只执行一个', { n: open[0].order })
          : tl(L, '同时开着的任务已到上限 {cap}（{orders}）', { cap, orders: open.map((g) => `#${g.order}`).join(tl(L, '、')) }) };
    }
    // 没到上限却还没开工：那些开着的任务里有真的在跑的 —— 只有"全都在等人"才让路。
    if (open.length) {
      const busy = open.find((g) => !waitingOnHuman(db, g.id));
      if (busy) return { projectId: task.project_id, taskId: busy.id, why: tl(L, '#{n} 正在做（开着的任务全都在等人时，才会让路开下一个）', { n: busy.order }) };
    }
  }
  return null;
}

// ── 判据本体 ─────────────────────────────────────────────────────────────
/**
 * 一个任务此刻在等谁。`a` 是 `assessTask` 的结果（调用方已经算过，不重复算）。
 * 顺序有讲究：先认那些**自带引用**的理由（pid / readyAt），再去解引用人，再解引用上游；
 * 都不成立才落到 unknown。这样新增一种状态时，默认后果是报警而不是静默。
 */
export function stallOf(db, task, a, { at = now() } = {}) {
  const L = contentLang(db);
  const taskId = task.id;
  const r = String(a?.reason ?? '');
  const mk = (kind, ref, why) => ({ taskId, title: task.title ?? null, kind, ref, why, assessed: r || null, at });
  if (a?.due) return mk('self', { verb: a.verb ?? 'run' }, tl(L, '该拉起了（{reason}）', { reason: r }));
  if (r === 'live' || r === 'live_foreign') return mk('self', { pid: a.pid ?? null }, tl(L, '子进程在跑'));
  if (r.startsWith('backoff:')) {
    // 退避是合法的静止，但只有带得出 readyAt 才算 —— 没有 readyAt 的"等一会"跟没说一样。
    if (a.readyAt) return mk('clock', { readyAt: a.readyAt }, tl(L, '退避中，{min} 分钟后自己重试', { min: Math.max(0, Math.round((a.readyAt - at) / 60_000)) }));
    return mk('unknown', null, tl(L, '说在退避（{reason}），但没有给出什么时候重试', { reason: r }));
  }
  const q = answerableQuestion(db, taskId);
  if (q && !q.orphan) {
    return mk('human', { questionId: q.q.id, to: q.to, broadcast: !!q.broadcast, decisionType: q.q.decision_type ?? null },
      q.broadcast ? tl(L, '在等人答一条事项（所有人都看得到）') : tl(L, '在等 {n} 个人答一条事项', { n: q.to.length }));
  }
  if (q && q.orphan) return mk('unknown', { questionId: q.q.id }, tl(L, '有一条开着的事项，但指定的答复人全都已停用或是旁观者 —— 没有人会看到它'));
  const up = upstreamOf(db, task);
  if (up) return mk('upstream', up, up.why);
  return mk('unknown', null, tl(L, '系统只知道它的状态是「{state}」，说不出谁会让它动起来', { state: r || tl(L, '无') }));
}

/** 所有没结束的任务，各带一条"在等谁"。纯读库。 */
export function stalls(db, { at = now(), assess, ...opts } = {}) {
  if (typeof assess !== 'function') throw new Error('stalls 需要 assess(db, task, opts)：由调用方传 assessTask，避免 liveness 与 daemon 互相 import');
  return unfinishedTasks(db).map((t) => stallOf(db, t, assess(db, t, { at, ...opts }), { at }));
}

/** 任务最近一次有动静是什么时候（审计轨）。宽限期用它，避免把刚发生的一瞬当成停摆。 */
export function lastActivityAt(db, taskId) {
  const a = db.one(`SELECT MAX(ts) AS ts FROM audit_log WHERE target_id=?`, taskId)?.ts ?? null;
  const n = db.one(`SELECT MAX(l.ts) AS ts FROM audit_log l JOIN nodes n ON n.id=l.target_id WHERE n.task_id=?`, taskId)?.ts ?? null;
  const c = db.one(`SELECT created_at AS ts FROM tasks WHERE id=?`, taskId)?.ts ?? null;
  return Math.max(a ?? 0, n ?? 0, c ?? 0) || null;
}

// ── 空转 ─────────────────────────────────────────────────────────────────
/**
 * 系统在重复自己：
 *   ① 同一个任务上，同一条（归一化后）事项文本被提出了 N 次 —— 例如：人答"授权你改 scope"，
 *      可答复改不了契约，执行器照做必被越界校验驳回，于是又问同一个问题。
 *   ② 同一个节点 node_stalled 了 N 次，且最后一次的停因跟上一次一样 —— 例如：两条校验规则
 *      合起来无解，执行器怎么交都不对。升档（escalate.mjs）解决不了逻辑矛盾，只会更贵。
 */
export function livelocks(db, { threshold = REPEAT_THRESHOLD, at = now() } = {}) {
  const L = contentLang(db);
  const out = [];
  for (const t of unfinishedTasks(db)) {
    const LL = markLike('text', 'loop');
    const qs = db.all(`SELECT id, text, asked_at FROM questions WHERE task_id=? AND NOT ${LL.sql} ORDER BY asked_at`, t.id, ...LL.params);
    const byText = new Map();
    for (const q of qs) { const k = norm(q.text).slice(0, 400); if (!byText.has(k)) byText.set(k, []); byText.get(k).push(q); }
    for (const [, group] of byText) {
      if (group.length < threshold) continue;
      out.push({ taskId: t.id, title: t.title, kind: 'question', n: group.length,
        ref: { questionIds: group.map((g) => g.id), firstAt: group[0].asked_at, lastAt: group[group.length - 1].asked_at },
        why: tl(L, '同一条事项被提出了 {n} 次', { n: group.length }), sample: group[0].text, at });
    }
    for (const n of db.all(`SELECT id, title FROM nodes WHERE task_id=? AND status<>'done' AND status<>'void'`, t.id)) {
      const fails = db.all(`SELECT ts, payload FROM audit_log WHERE target_id=? AND action='node_stalled' ORDER BY id`, n.id);
      if (fails.length < threshold) continue;
      const why = (p) => String(parse(p).stopped ?? '');
      const last = why(fails[fails.length - 1].payload);
      if (!last || why(fails[fails.length - 2].payload) !== last) continue;   // 停因变了 = 还在往前走，不算空转
      out.push({ taskId: t.id, title: t.title, kind: 'node', n: fails.length,
        ref: { nodeId: n.id, nodeTitle: n.title, stopped: last, lastAt: fails[fails.length - 1].ts }, why: tl(L, '节点「{node}」以同一个原因失败了 {n} 次', { node: n.title, n: fails.length }), sample: last, at });
    }
  }
  return out;
}

// ── 出口：升成一条给负责人的事项 ─────────────────────────────────────────
function raise(db, { taskId, text, at }) {
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
          VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, id, taskId, text, at);
  // 借用 structural 这一类：它是 level3（解析后必含负责人）且禁 default（不会到期自己消失）—— 正是
  // 报警需要的两条性质。不新开第九种决策类型：那要动 routing-templates 与所有已存的路由表，代价远大于收益。
  const r = routeQuestion(db, { questionId: id, decisionType: 'ops', typeSource: 'hard_rule', at });
  return { questionId: id, addressedTo: r.answerers };
}

// 最近一次出错：报警若只说"判断是 status:done"，人看不出任务其实是合并一直失败，
// 就会把它判成"本来就该停"。系统手里有错误原文 —— 这条警本来就该带着它。
const ERROR_NAMES = {
  project_advance_failed: N_('合并 / 推进出错'), task_verify_failed: N_('验收没过'), env_setup_failed: N_('自动装依赖失败'),
  preview_failed: N_('页面截图没截出来'), replan_failed: N_('重新规划失败'), project_verify_failed: N_('项目验收没过'),
  project_task_integrate_verify_failed: N_('合进项目分支后重跑验收没过'), handback_raise_failed: N_('挂事项失败'),
};
const ERROR_WINDOW_MS = 6 * 60 * 60_000;
export function lastErrorOf(db, task, { at = now() } = {}) {
  const row = db.one(`SELECT action, ts, payload FROM audit_log
    WHERE target_id IN (?, ?) AND (action LIKE '%\\_failed' ESCAPE '\\' OR action LIKE '%\\_error' ESCAPE '\\') AND ts >= ?
    ORDER BY id DESC LIMIT 1`, task.id, task.project_id ?? task.id, at - ERROR_WINDOW_MS);
  if (!row) return null;
  const p = parse(row.payload);
  const msg = String(p.error ?? p.why ?? p.tail ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
  const L = contentLang(db);
  return { action: row.action, at: row.ts, name: ERROR_NAMES[row.action] ? tlN(L, ERROR_NAMES[row.action]) : tl(L, '出错'), msg, sig: `${row.action}:${msg.slice(0, 120)}` };
}

const stallText = (s, idleMin, err, L) => {
  const state = s.assessed ?? tl(L, '无');
  const ago = err ? Math.max(0, Math.round((s.at - err.at) / 60_000)) : 0;
  return `${markOf(L, 'stall')}${tl(L, '任务「{title}」已经 {min} 分钟没有任何动静，而系统说不出它在等谁。', { title: s.title ?? s.taskId, min: idleMin })}\n\n`
    + `${String(s.why).includes(tl(L, '「{state}」', { state })) ? tl(L, '{why}。', { why: s.why }) : tl(L, '系统对它的判断是「{state}」——{why}。', { state, why: s.why })}\n`
    + (err ? `${err.msg ? tl(L, '最近一次出错（{min} 分钟前）：{name}：{msg}', { min: ago, name: err.name, msg: err.msg }) : tl(L, '最近一次出错（{min} 分钟前）：{name}', { min: ago, name: err.name })}\n` : '')
    + `${tl(L, '按规则，一个没结束的任务必须在等四样东西之一：它自己（有活着的进程）、一个到点的时刻、某个人（而且\n那条事项真在那个人的收件箱里）、或者另一件没完成的事。这个任务四样都不占。')}\n\n`
    + `${tl(L, '这多半是系统的缺陷而不是你的疏忽。请选一条：')}\n`
    + `(A) ${tl(L, '这里确实该有人做点什么 —— 回 A，写下你看到的情况，系统会据此重新看一遍这个任务。（要改它的做法，别写在这里，到任务页给它发消息。）')}\n`
    + `(B) ${tl(L, '它本来就该停在这里 —— 回 B，说一句为什么。同样的判断、同样的出错信息，以后不再报')}\n`
    + `(C) ${tl(L, '不要它了 —— 到任务页点「中止」')}`;
};

/** 这条停等以前被人回过 B（本来就该停），而且判断与最近一次出错都没变 —— 不再报。 */
const isB = (body) => /^[\s（(]*(选)?\s*[（(]?\s*B(?![a-z])/i.test(String(body ?? ''));
function acknowledged(db, s, err) {
  for (const a of db.all(`SELECT payload FROM audit_log WHERE action='stall_detected' AND target_id=? ORDER BY id DESC LIMIT 10`, s.taskId)) {
    const p = parse(a.payload);
    if (p.assessed !== s.assessed || (p.errSig ?? null) !== (err?.sig ?? null) || !p.questionId) continue;
    const q = db.one(`SELECT status FROM questions WHERE id=?`, p.questionId);
    if (q?.status !== 'answered') continue;
    const ans = db.one(`SELECT body FROM answers WHERE question_id=? AND stance='answer' ORDER BY created_at DESC, rowid DESC LIMIT 1`, p.questionId);
    if (isB(ans?.body)) return true;
  }
  return false;
}

const loopText = (l, L) => `${markOf(L, 'loop')}${tl(L, '任务「{title}」在原地打转：{why}，期间没有新的信息进来。', { title: l.title ?? l.taskId, why: l.why })}\n\n`
  + `${l.kind === 'question' ? `${tl(L, '重复的是这条事项：')}\n${String(l.sample).split('\n').slice(0, 4).join('\n')}` : tl(L, '节点「{node}」每次都停在同一处：{sample}', { node: l.ref.nodeTitle, sample: l.sample })}\n\n`
  + `${tl(L, '同一件事重复到第 {n} 次，几乎一定不是"再试一次就好"：多半是**人能给的答复根本改不了挡住它的那个东西**\n（答复改不了契约，scope / 规则 / 验收只能走计划变更），或者两条机械校验合起来无解。\n再让它转下去只是烧钱。请选一条：', { n: l.n })}\n`
  + `(A) ${tl(L, '提一条计划变更，改掉挡住它的那条约定')}\n`
  + `(B) ${tl(L, '告诉我到底是什么挡住了它 —— 回一句，我据此重新规划')}\n`
  + `(C) ${tl(L, '中止这个任务：到任务页点「中止」')}`;

/**
 * 扫一遍，把 unknown 的停摆与到阈值的空转升成事项。返回 { stalls, livelocks, raised }。
 * 去重靠判据本身：报警事项一挂上去，这个任务下一轮就解引用得到人，kind 从 unknown 变成 human，不会再报。
 * 空转那条得自己去重（任务上本来就有开着的事项），用 LOOP_MARK 前缀认。
 */
export function sweepLiveness(db, { at = now(), graceMs = UNKNOWN_GRACE_MS, threshold = REPEAT_THRESHOLD, assess, onEvent = () => {}, ...opts } = {}) {
  const L = contentLang(db);
  const all = stalls(db, { at, assess, ...opts });
  const raised = [], stuck = [];
  for (const s of all) {
    if (s.kind !== 'unknown') continue;
    const last = lastActivityAt(db, s.taskId);
    if (last && at - last < graceMs) continue;
    const idleMin = last ? Math.round((at - last) / 60_000) : 0;
    const task = db.one(`SELECT id, project_id FROM tasks WHERE id=?`, s.taskId);
    const err = task ? lastErrorOf(db, task, { at }) : null;
    if (acknowledged(db, s, err)) continue;
    stuck.push({ ...s, idleMin });
    const r = raise(db, { taskId: s.taskId, text: stallText(s, idleMin, err, L), at });
    audit(db, { actorKind: 'system', actorId: 'liveness', action: 'stall_detected', targetType: 'task', targetId: s.taskId,
      payload: { assessed: s.assessed, why: s.why, idleMin, questionId: r.questionId, addressedTo: r.addressedTo, errSig: err?.sig ?? null, lastError: err ? tl(L, '{name}：{msg}', { name: err.name, msg: err.msg }) : null } });
    raised.push({ ...r, taskId: s.taskId, kind: 'stall' });
    onEvent({ type: 'stall', taskId: s.taskId, why: s.why, idleMin, questionId: r.questionId });
  }
  const loops = livelocks(db, { threshold, at });
  for (const l of loops) {
    const LL = markLike('text', 'loop');
    if (db.one(`SELECT 1 FROM questions WHERE task_id=? AND status IN ('open','escalated') AND ${LL.sql}`, l.taskId, ...LL.params)) continue;
    // 答掉一条空转之后，下一轮会按同一段历史再挂一条（历史里失败次数一直 ≥ 3），人每答一次就多一条。
    // 上一条空转之后没有新的失败 / 新的重复事项 = 没有新证据，不再挂。
    const lastLoop = db.one(`SELECT MAX(asked_at) AS m FROM questions WHERE task_id=? AND ${LL.sql}`, l.taskId, ...LL.params)?.m ?? 0;
    if (lastLoop && (l.ref.lastAt ?? 0) <= lastLoop) continue;
    // 任务已经停在一条开着的上限事项上（有人接着）：那条就是出口，不再叠一条空转
    if (db.one(`SELECT 1 FROM questions WHERE task_id=? AND decision_type='budget' AND status IN ('open','escalated')`, l.taskId)) continue;
    const r = raise(db, { taskId: l.taskId, text: loopText(l, L), at });
    audit(db, { actorKind: 'system', actorId: 'liveness', action: 'livelock_detected', targetType: 'task', targetId: l.taskId,
      payload: { kind: l.kind, n: l.n, ref: l.ref, questionId: r.questionId, addressedTo: r.addressedTo } });
    raised.push({ ...r, taskId: l.taskId, kind: 'livelock' });
    onEvent({ type: 'livelock', taskId: l.taskId, why: l.why, n: l.n, questionId: r.questionId });
  }
  return { stalls: all, stuck, livelocks: loops, raised };
}

/** 一行人话，给 CLI 与看板共用。 */
export const renderStall = (s, lang = 'zh') => `${s.kind === 'unknown' ? '⚠ ' : ''}${tl(lang, '{title}：{why}', { title: s.title ?? s.taskId, why: s.why })}`;
