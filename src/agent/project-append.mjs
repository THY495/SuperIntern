// 给项目添加任务（项目是唯一容器，不再有独立任务可接续）。
//
// 项目只有**尾部可变**，而且这里只做最便宜的一种：追加。已合并、进行中、未开始的既有任务一概不动；
// 新任务接在最后，`verify_extra` = 此前全部任务的验收命令（串行链与累加回归本来就是这么拼的）。
// 插入 / 删除 / 重排（尾部重写）没做 —— 它们会改后续任务的回归义务，等第一个真实案例。
//
// 形状与项目规划器同一套：人写一段"还要加什么" → 规划器切成契约（同一个 `propose_project` 出口、同一道
// validateProjectSpec 护栏，引文可以出自原规划或这段追加说明）→ 一条方案批准事项挂在载体任务上 → 人回 A / 反馈 / C。
// 两处与首次规划不同：
//   - **批准前不建任务**。首次规划时项目还是 proposed，建好的任务没人会碰；追加时项目多半正 active，
//     提前建出来的任务会在前一个合并后被 advanceProject 直接拉起 —— 等于没批准就开工。草案存在载体任务的 params 里。
//   - 追加期间项目照常推进，不暂停。
// 状态存在载体任务的 params（`append.*`），不加列：stage = drafting（等规划器）/ proposed（等人批）/ approved / abandoned。
// JSON 直接建的项目没有载体任务，这里按需补一个（order 0）。
//
// 谁能加：负责人，或负责人在项目成员里勾了"可添加任务"的人（project-members.mjs）。加的人只描述；
// 草案的批准仍按路由表走（方案批准类，收件人必含负责人）—— 成员提、负责人批。

import { withOutputLang, contentLang, tl, I18nError } from '../i18n/index.mjs';
import { markOf } from '../i18n/marks.mjs';
import { newId, now, audit } from '../db/db.mjs';
import { getParam, setParam } from '../core/params.mjs';
import { routeQuestion, specPrefixes, wholeProjectPrefixes } from '../core/routing.mjs';
import { createProjectTasks, validateProjectSpec, projectTasks, chainGraph, renderRules, renderDeps, scopeOverlaps, renderScopeOverlaps, renderScopePaths, scopePathsNote, SCOPE_PATHS_NOTE, PROJECT_TASK_RUNTIME_MS } from '../core/project.mjs';
import { canAddTasks } from '../core/project-members.mjs';
import { projectVerifyCommand, gearOf, gearPrereqStatus, budgetState, maxOpenOf } from '../core/project-settings.mjs';
import { activeDecisions, recordReservation } from '../core/decisions.mjs';
import { checkDecisions } from '../core/decision-check.mjs';
import { decisionsSection } from '../core/decisions.mjs';
import { answerOf } from './elicitor.mjs';
import { reservationOf, readApproval, readVerdict, confirmBeforeRevising, feedbackOf, REACHED_LABELS, REVIEW_LABELS } from './approval.mjs';
import { schedLine } from './project-planner.mjs';
import { diffSpecs, renderSpecDiff, roundHistory, renderRoundHistory } from './spec-diff.mjs';
import { toolCallsOf, textOf, truncatedEmpty, TruncatedEmptyError } from '../llm/canonical.mjs';
import { PRE_HOOKS } from '../core/answers.mjs';
import { answerChoices } from '../core/choices.mjs';

export const MAX_APPEND_TASKS = 6;
const MAX_TOKENS = 24000;
const BY = (userId) => ({ kind: 'user', id: userId });

const carrierOf = (db, projectId) => db.one(`SELECT * FROM tasks WHERE project_id=? AND project_order=0`, projectId);

/** 追加的当前状态；没有进行中的追加 → null。 */
export function appendStateOf(db, projectId) {
  const c = carrierOf(db, projectId);
  if (!c) return null;
  const stage = getParam(db, c.id, 'append.stage');
  if (!stage) return null;
  return { stage, kind: getParam(db, c.id, 'append.kind') ?? 'append', carrierId: c.id, brief: getParam(db, c.id, 'append.brief'), version: getParam(db, c.id, 'append.version') ?? 0,
    questionId: getParam(db, c.id, 'append.question'), sinceAuditId: getParam(db, c.id, 'append.since') ?? 0, seed: getParam(db, c.id, 'append.seed') ?? [], continued: getParam(db, c.id, 'append.seed') !== null,
    requestedBy: getParam(db, c.id, 'append.requested_by') ?? null, queue: getParam(db, c.id, 'append.queue') ?? [] };
}
export const appendPending = (st) => !!st && ['drafting', 'proposed'].includes(st.stage);

// ── 复盘 ──────────────────────────────────────────────────────────────────
// **复盘就是一次特殊的追加**，不是第二套流程。项目的全部任务都合并之后，规划器对照项目目标
// 与完成定义回答一个问题：还差什么。答"还差这些" → 走追加那条路（草案 → 人批一次 → 建任务）；
// 答"已经达成" → 一条达成确认事项，人点头，项目 done。
//
// 为什么合并完才复盘，而不是"每次签收后"：串行调度下"这个任务签收了"与"整个项目
// 没事做了"之间隔着一堆还没开工的任务，在那之间每签收一次就拉一次重档规划器，花的钱与拿到的
// 信息不成比例。全部合并是**这个项目第一次真的没事做**的时刻 —— 复盘要么给出下一批，要么给出
// 达成，两条路都有出口。
//
// 为什么不让它自己 done：那正是"项目级完成定义"要管的事。全部任务合并只说明**契约**
// 都兑现了，不说明**目标**兑现了 —— 两者之间差的就是"当初切任务时想漏的那部分"，而那恰恰是
// 项目层唯一还没有人看过的地方。

export const REVIEW_BRIEF = '【复盘】项目的全部任务都已完成并合并。对照项目目标与完成定义判断：还差什么，或者已经达成。';

/**
 * 发起一次复盘。**系统发起，不是人发起** —— 所以这些流程状态记在 agent 名下、执行层，
 * 与规划器自己写的其余流程状态同一套（人的批准 / 放弃仍记人的名字、宪法层）。
 */
export function requestReview(db, { projectId }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
  if (!p) throw new I18nError('项目不存在：{id}', { id: projectId });
  if (appendPending(appendStateOf(db, projectId))) throw new I18nError('已有一次追加 / 复盘在进行中');
  const L = contentLang(db);
  let carrier = carrierOf(db, projectId);
  const t = now();
  return db.tx(() => {
    if (!carrier) {
      const id = newId('t');
      db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,?,'planning',?,?,0)`, id, p.owner_id, tl(L, '项目规划：{title}', { title: p.title }), t, projectId);
      carrier = { id };
    } else db.run(`UPDATE tasks SET status='planning' WHERE id=?`, carrier.id);
    const since = db.one(`SELECT COALESCE(MAX(id),0) m FROM audit_log`).m;
    const set = (key, value) => setParam(db, { taskId: carrier.id, key, value, by: { kind: 'agent', id: 'project' }, governance: 'execution' });
    // 与 REVIEW_BRIEF 同一句（中文逐字相同），按内容语言写
    set('append.kind', 'review'); set('append.brief', `${markOf(L, 'review')}${tl(L, '项目的全部任务都已完成并合并。对照项目目标与完成定义判断：还差什么，或者已经达成。')}`); set('append.stage', 'drafting'); set('append.version', 0);
    set('append.question', null); set('append.spec', null); set('append.notes', null); set('append.since', since);
    set('append.reached', null); set('append.seed', null); set('append.requested_by', null);   // 复盘不是谁提的需求；上一轮的出处别带过来
    audit(db, { actorKind: 'system', action: 'project_review_requested', targetType: 'project', targetId: projectId, payload: { carrier: carrier.id } });
    return { projectId, carrierId: carrier.id };
  });
}

/**
 * 负责人让停滞的项目重新复盘（复盘时选了「先放着」→ 全部已合并、没宣布达成）。结果照常是一条事项：
 * 已经达成就请人确认达成，还差东西就提任务（带"已经达成、这些都不需要"的出口）。
 * 否则停滞原因写着"宣布达成"，页面上却没有入口，负责人只能借「添加任务」写"请重新判断"，又被切成一个干活的任务。
 */
export function reviewAgain(db, { projectId, userId }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
  if (!p) throw new I18nError('项目不存在：{id}', { id: projectId });
  if (p.owner_id !== userId) throw new I18nError('只有项目负责人能重新复盘');
  if (p.status !== 'stalled') throw new I18nError('项目状态为 {status}，不需要重新复盘', { status: p.status });
  if (db.one(`SELECT 1 FROM tasks WHERE project_id=? AND project_order>0 AND merged_at IS NULL AND status<>'aborted'`, projectId)) throw new I18nError('还有没合并的任务，先把它们做完');
  if (db.one(`SELECT 1 FROM tasks WHERE project_id=? AND project_order>0 AND merged_at IS NULL AND status='aborted'`, projectId)) throw new I18nError('有已中止的任务：先在项目页恢复或重做它');
  const r = requestReview(db, { projectId });
  db.run(`UPDATE projects SET status='active' WHERE id=?`, projectId);
  audit(db, { actorKind: 'user', actorId: userId, action: 'project_review_again', targetType: 'project', targetId: projectId, payload: { carrier: r.carrierId } });
  return r;
}

/**
 * 人发起追加：只记下要加什么，不调模型。守护进程随后拉 `project plan <id>`。
 *
 * 已有一次追加 / 复盘在进行 → **排队**，不再报错拒收。否则复盘期间项目页不给成员「添加任务」，
 * 成员只能在复盘任务上留言，靠负责人把它转成打回理由 —— 需求没有自己的出处，也没有人对它签收。
 * 排着的需求在当前这一轮结束后（批准 / 放弃 / 项目达成之后）按先后单独起草；当前这一轮若正等人批，
 * 这条需求会作为一条评论挂在那条批准事项下面，让批的人拍板前看得到。
 */
export function requestAppend(db, { projectId, userId, brief, seed = null, viaQuestion = null }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
  if (!p) throw new I18nError('项目不存在：{id}', { id: projectId });
  // viaQuestion：负责人的路由表把某条事项派给了这个人，这个人在答复里要求改 —— 答复本身就是授权入口
  if (!viaQuestion && !canAddTasks(db, projectId, userId)) throw new I18nError('你没有给这个项目添加任务的权限（需要是负责人，或由负责人在项目成员里授予）');
  const text = String(brief ?? '').trim();
  if (!text) throw new I18nError('要追加的内容不能为空');
  if (!['active', 'stalled', 'done'].includes(p.status)) {
    throw p.status === 'proposed'
      ? new I18nError('项目状态为 {status}，不能追加任务（方案还没批准：直接在方案的反馈里说）', { status: p.status })
      : new I18nError('项目状态为 {status}，不能追加任务', { status: p.status });
  }
  // 交付过的项目照样能追加（2026-09-25 用户拍板：初版交付之后应当允许持续维护迭代）。新合并的部分会在「等你交付」里再提示一次（delivery-due.mjs）。
  if (p.archived_at) throw new I18nError('项目已归档，请先取消归档');
  const cur = appendStateOf(db, projectId);
  if (appendPending(cur)) return enqueueAppend(db, { projectId, userId, brief: text, cur, viaQuestion });
  return beginAppend(db, { project: p, userId, brief: text, seed });
}

/** 真正开一轮追加（requestAppend 与排队出队共用）。每一轮开头把上一轮留下的流程状态清干净。 */
function beginAppend(db, { project: p, userId, brief: text, seed = null, fromQueue = null }) {
  const projectId = p.id;
  const L = contentLang(db);
  let carrier = carrierOf(db, projectId);
  const t = now();
  return db.tx(() => {
    if (!carrier) {
      const id = newId('t');
      db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,?,'planning',?,?,0)`, id, p.owner_id, tl(L, '项目规划：{title}', { title: p.title }), t, projectId);
      carrier = { id };
    } else db.run(`UPDATE tasks SET status='planning' WHERE id=?`, carrier.id);
    const since = db.one(`SELECT COALESCE(MAX(id),0) m FROM audit_log`).m;
    const set = (key, value) => setParam(db, { taskId: carrier.id, key, value, by: BY(userId), governance: 'constitutional' });
    set('append.brief', text); set('append.stage', 'drafting'); set('append.version', 0); set('append.question', null); set('append.spec', null); set('append.notes', null);
    set('append.since', since);
    // 上一轮若是复盘，kind / reached 会原样留着 —— 下一次人加的任务就被当成复盘走了 planReview。
    // seed 同理：不清掉，continued 永远为真。
    set('append.kind', 'append'); set('append.reached', null); set('append.seed', seed ?? null);
    set('append.requested_by', userId);          // 需求出处：这一轮建出来的任务记在提出人名下（task.requested_by）
    audit(db, { actorKind: 'user', actorId: userId, action: 'project_append_requested', targetType: 'project', targetId: projectId,
      payload: { carrier: carrier.id, briefBytes: text.length, ...(fromQueue ? { fromQueue } : {}) } });
    return { projectId, carrierId: carrier.id };
  });
}

/** 排队：记下来；当前这一轮正等人批的话，挂一条评论在那条批准事项下面。 */
function enqueueAppend(db, { projectId, userId, brief, cur, viaQuestion = null }) {
  const item = { id: newId('aq'), userId, brief, at: now(), ...(viaQuestion ? { viaQuestion } : {}) };
  const queue = [...(cur.queue ?? []), item];
  const L = contentLang(db);
  db.tx(() => {
    setParam(db, { taskId: cur.carrierId, key: 'append.queue', value: queue, by: BY(userId), governance: 'constitutional' });
    const q = cur.questionId ? db.one(`SELECT id, status FROM questions WHERE id=?`, cur.questionId) : null;
    if (q && ['open', 'escalated'].includes(q.status)) {
      db.run(`INSERT INTO answers (id,question_id,user_id,message_id,body,stance,created_at) VALUES (?,?,?,NULL,?,'comment',?)`,
        newId('a'), q.id, userId, `${tl(L, '（添加任务，已排队）')}${brief}\n${cur.kind === 'review' ? tl(L, '—— 这条会在这一轮复盘结束后单独起草、单独批准；不影响你现在这条怎么答。') : tl(L, '—— 这条会在这一轮添加结束后单独起草、单独批准；不影响你现在这条怎么答。')}${cur.kind === 'review' ? tl(L, '要是这条需求没做完就不该算达成，就别回「确认达成」，把它写进"还差什么"。') : ''}`, item.at);
    }
    audit(db, { actorKind: 'user', actorId: userId, action: 'project_append_queued', targetType: 'project', targetId: projectId,
      payload: { queueId: item.id, position: queue.length, behind: cur.kind, stage: cur.stage, human: brief.slice(0, 200) } });
  });
  return { projectId, carrierId: cur.carrierId, queued: true, position: queue.length, behind: cur.kind };
}

/**
 * 出队：当前没有进行中的追加 / 复盘时，把排在最前的那条需求开成一轮。提出人已经没有添加权限、项目已交付 / 归档 /
 * 不在可加的状态 → 这条丢掉并留痕（不静默吞），接着看下一条。返回开出来的那一轮，或 null。
 */
export function startQueuedAppend(db, { projectId }) {
  for (;;) {
    const st = appendStateOf(db, projectId);
    if (!st?.queue?.length || appendPending(st)) return null;
    const [head, ...rest] = st.queue;
    setParam(db, { taskId: st.carrierId, key: 'append.queue', value: rest, by: { kind: 'agent', id: 'project' }, governance: 'execution' });
    const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
    const L = contentLang(db);
    const why = !head.viaQuestion && !canAddTasks(db, projectId, head.userId) ? tl(L, '提出人已经没有添加任务的权限')
      : !['active', 'stalled', 'done'].includes(p.status) ? tl(L, '项目状态为 {status}', { status: p.status })
        : p.archived_at ? tl(L, '项目已归档') : null;
    if (why) {
      audit(db, { actorKind: 'system', action: 'project_append_queue_dropped', targetType: 'project', targetId: projectId,
        payload: { queueId: head.id, by: head.userId, why, human: tl(L, '排队的需求没有起草：{why}。还要做的话，请有添加权限的人重新「添加任务」（原话：{brief}）', { why, brief: String(head.brief).slice(0, 200) }) } });
      continue;
    }
    return beginAppend(db, { project: p, userId: head.userId, brief: head.brief, fromQueue: head.id });
  }
}

/**
 * 这一轮期间别人说了什么：规划器原来只看"人要追加的内容"与负责人的反馈。复盘期间成员在复盘任务上留的话，
 * 规划器看不到，只能靠负责人转述才进得了下一版。这里把两样东西带上：
 *   ① 这一轮开始以后，发在载体任务上的消息、挂在这一轮批准事项下的评论 —— 供参考，采纳与否仍以负责人的答复为准；
 *   ② 排着队、之后会单独起草的需求 —— 让规划器别把它们重复切进这一版（它们有自己的出处、自己的批准）。
 */
/** 这一轮从什么时候开始（requestAppend / requestReview 记下的审计行号 → 时间）。 */
const roundSinceTs = (db, st) => (st.sinceAuditId ? (db.one(`SELECT ts FROM audit_log WHERE id=?`, st.sinceAuditId)?.ts ?? 0) : 0);

/** 新版正文的标题行之后插一段"和上一版比"。第一版没有上一版，原样返回。 */
function withDiff(text, prevVer, next, lang = 'zh') {
  if (!prevVer) return text;
  const prev = prevVer.reached ? { reached: prevVer.reached } : prevVer.spec ? { tasks: prevVer.spec.tasks ?? [] } : null;
  if (!prev) return text;
  const d = renderSpecDiff(diffSpecs(prev, next), { prevVersion: prevVer.version, lang });
  const i = text.indexOf('\n');
  return i < 0 ? `${text}\n${d}` : `${text.slice(0, i + 1)}${d}${text.slice(i + 1)}`;
}

function sideInput(db, { st, carrierId }) {
  const names = Object.fromEntries(db.all(`SELECT id, display_name FROM users`).map((u) => [u.id, u.display_name]));
  const sinceTs = roundSinceTs(db, st);
  const said = [
    ...db.all(`SELECT sender_id AS who, body, received_at AS at FROM messages WHERE task_id=? AND received_at>=? AND kind<>'answer' AND trust_label='user-authenticated'`, carrierId, sinceTs),
    ...db.all(`SELECT a.user_id AS who, a.body, a.created_at AS at FROM answers a JOIN questions q ON q.id=a.question_id
               WHERE q.task_id=? AND q.asked_at>=? AND a.stance='comment' AND a.user_id IS NOT NULL`, carrierId, sinceTs)
      .filter((c) => !['（添加任务，已排队）', tl('en', '（添加任务，已排队）')].some((pre) => String(c.body).startsWith(pre))),   // 排队评论（enqueueAppend 写的）中英都认
  ].sort((x, y) => x.at - y.at);
  const out = [];
  if (said.length) out.push(`## 这一轮期间项目成员留的话（经认证通道；**供参考** —— 采纳与否以负责人的答复为准，没被负责人提到的不要当成已批准的要求；与目标 / 完成定义相关的，在 notes 里说你怎么处理的）\n${said.map((m) => `- ${names[m.who] ?? m.who}：${String(m.body).trim()}`).join('\n')}`);
  if (st.queue?.length) out.push(`## 已排队、这一轮之后会单独起草的需求（**不要**把它们切进这一版：它们会各自起草、各自批准、记在提出人名下）\n${st.queue.map((q) => `- ${names[q.userId] ?? q.userId}：${String(q.brief).trim()}`).join('\n')}`);
  return out;
}

const chainVerify = (db, projectId) => projectTasks(db, projectId)
  .map((t) => getParam(db, t.id, 'task.verify_command')).filter((v) => Array.isArray(v) && v.length);

function existingContracts(db, projectId) {
  return db.all(`SELECT t.id, t.title, t.status, t.project_order, t.merged_at, c.goal, c.scope, c.definition_of_done FROM tasks t
    JOIN constitutions c ON c.task_id=t.id AND c.superseded_at IS NULL WHERE t.project_id=? AND t.project_order>0 ORDER BY t.project_order`, projectId)
    .map((t) => ({ ...t, verify: (getParam(db, t.id, 'task.verify_command') ?? []).join(' ') }));
}

export function renderAppendProposal(db, { project, spec, version, notes, startOrder, seedCount, continued = false, review = false }) {
  const lg = contentLang(db);
  const L = [markOf(lg, 'appendDraft', { version }), tl(lg, '项目：{title}（现有任务编号到 #{last}，以下从 #{first} 起；已有任务的契约不变）', { title: project.title, last: startOrder - 1, first: startOrder }), ''];
  spec.tasks.forEach((t, i) => {
    // 行首的几个键与项目契约草案（project-planner renderProposal）共用，译文在 content-5
    L.push(`${startOrder + i}. ${t.title}`, tl(lg, '   依赖：{v}', { v: renderDeps(t, startOrder + i, startOrder, lg) }), tl(lg, '   目标：{v}', { v: t.goal }), tl(lg, '   范围：{v}', { v: t.scope }), tl(lg, '   可动路径（判据）：{v}', { v: renderScopePaths(t.scope_paths, lg) }), tl(lg, '   完成定义：{v}', { v: t.definition_of_done }));
    if (t.rules?.length) L.push(tl(lg, '   规则：{v}', { v: renderRules(t.rules, lg).map((r) => `\n     - ${r}`).join('') }));
    if (t.constraints?.length) L.push(tl(lg, '   约束：{v}', { v: t.constraints.map((c) => `\n     - ${c}`).join('') }));
    L.push(tl(lg, '   验收命令：{v}{extra}', { v: t.verify_command, extra: tl(lg, '（开工时系统会再累加当时已合并的全部任务的验收命令）') }), '');
  });
  L.push(scopePathsNote(lg), '');
  const assumptions = spec.tasks.flatMap((t, i) => (t.rules ?? []).filter((r) => !String(r.quote ?? '').trim()).map((r) => tl(lg, '第 {n} 个 · {rule}（{assumption}）', { n: startOrder + i, rule: r.rule, assumption: r.assumption })));
  L.push(assumptions.length ? tl(lg, '⚠ 规划器假设（你没写、规划器定的，共 {n} 条；批准即认可，不同意就在反馈里改）：{list}', { n: assumptions.length, list: assumptions.map((a) => `\n  - ${a}`).join('') }) : tl(lg, '规划器假设：无（每条规则都引了你的原文）'), '');
  if (!seedCount && startOrder > 1) L.push(tl(lg, '注意：此前的任务没有机械验收命令，回归义务从本次追加的第一个任务起算。'), '');
  if (!seedCount && continued && startOrder === 1) L.push(tl(lg, '注意：本项目接续自一个已签收的任务，而原任务没有机械验收命令 —— 回归义务从本项目第一个任务起算，原任务的行为不在自动回归之内。'), '');
  // 范围重叠预警。只看这一批自己 —— 不同批次之间不可能同时开着（前一批定稿时早合并了）。
  const maxOpen = maxOpenOf(db, project.id);
  const overlaps = maxOpen > 1 ? renderScopeOverlaps(scopeOverlaps(spec, { startAt: startOrder }), lg) : null;
  if (overlaps) L.push(overlaps, '');
  if (notes) L.push(tl(lg, '规划器说明：{v}', { v: notes }), '');
  L.push(tl(lg, '每个任务的硬上限：累计运行时长 {h} h（其余按默认）。', { h: Math.round(PROJECT_TASK_RUNTIME_MS / 3600000) }), '');
  L.push(tl(lg, '批准后新任务按上面的依赖关系排进项目：依赖的任务都签收并合并后才开工；已有任务的契约不受影响。{sched}依赖关系不对，直接在反馈里说。请回复：', { sched: schedLine(maxOpen, lg) }), tl(lg, '(A) 批准 —— 回 "A" 或 "批准"'), tl(lg, '(B) 要改 —— 直接写要改什么，会出下一版'), review ? tl(lg, '(C) 先放着（还没想好） —— 回 "C" 或 "先放着"：这批任务不加，项目也不算做完，转为停滞，以后再添加任务、重新复盘或中止') : tl(lg, '(C) 放弃 —— 回 "C" 或 "放弃"（不追加，项目其余照旧）'), tl(lg, '(D) 批准，但留一句保留意见 —— **它不挡任何东西**：这一批照样全部生效，效果与 (A) 一模一样。它只把你那句话留在项目的约定清单上、标成〔保留意见〕，让下一个碰这一处的人看得到。要**挡住**其中某一条，只能 (B) 说清哪一条不要、让它重出一版。写法：先回 A，**另起一行**写「保留：…」。'), ...(review ? [tl(lg, '(E) 项目其实已经做完了，这些任务都不需要 —— 回 "E" 或 "已达成"：这批任务不加，项目算做完（之后可以交付）')] : []));
  return L.join('\n');
}

const SYSTEM_APPEND = (max) => `你是一个长期运行的自主 agent 的"项目规划器"。这个项目已经有一批任务契约，按依赖关系组织、一次执行一个（有的已完成并合进项目分支，有的在做，有的还没开工）。
人现在要**添加**一些工作。你的任务是把人写的说明切成 1 到 ${max} 个新的任务契约，编号接在现有任务之后，并用 depends_on 写明它们依赖哪些任务。

规矩：
- **不要改动、重述或替换任何已有任务**。只输出新增的任务。新任务等它依赖的任务都合并后开工，从项目分支当时的头起，实现方看得到当时已合并的全部代码。
- **依赖要如实写**（depends_on，用清单上的任务编号）：新任务用到哪个任务的产物就依赖哪个；一个独立的小模块、不碰别的任务的东西 → 写 []，它不用等任何任务。
  不确定就写上依赖。只有人明确要求"先做这个"、或某个**还没开工**的已有任务不先有新任务就做不成时，才用 blocks 让那个任务等新任务。
- 每个任务是几小时内能做完、能用一条命令验收的单位；按"消费方"切，先做被依赖的。能用一个任务做完就只出一个，不要为了凑数而拆。
- **接口名写死**：文件名、导出名、子命令名、字段名、退出码都写进完成定义；引用前面任务的产物时用它们契约里写死的名字。
- verify_command 只写本任务新增的测试；任务开工时，系统会把当时已合并的全部任务的验收命令累加成回归义务。
- 每个新任务的约束里必须有这一条（原文照抄）："既有测试文件只许追加用例；唯一例外是断言了被本契约明确取代的中间行为的用例，可以改那一条并在交接记录里说明；其余一行不许改、不许删"。
- 不要把"尚未实现的行为"写进完成定义。完成定义里的行为样例带精确的期望输出，每个任务 3 到 8 个，不要穷举。
- **每条行为规则要有出处**（rules 字段）：quote 逐字引人的原文（原规划或这次的追加说明都行，系统会机械核对是子串）；人没写的，用 assumption 说明你怎么定的。不要把推断写成规格口吻的硬规则。
- **一条规则只讲一件事**：分号连起来的多个断言会被拒，拆开写、各带各的出处；规则用原文的说法写，别改写关键词。
- 拿不准的写进 notes，让人在反馈里定。
- 只调用 propose_project（title 填项目现有标题即可），不要输出别的文字。人对上一版的反馈会以"人的反馈"出现，按反馈出下一版。`;

/**
 * 追加规划的一次寿命（由 planProject 在项目不是 proposed 时转过来）。返回 { kind: 'proposed'|'approved'|'abandoned'|'noop', ... }。
 * `tool`：propose_project 的工具定义（由 project-planner 传入，避免循环 import）；`repoGlance(repo)` 同理。
 */
export async function planAppend(db, { client, project, tier = 'heavy', maxAttempts = 3, tool, doneTool = null, repoGlance }) {
  const st = appendStateOf(db, project.id);
  if (!appendPending(st)) return { kind: 'noop', why: `项目 ${project.status}，没有进行中的追加` };
  const review = st.kind === 'review';
  const carrierId = st.carrierId;
  const lg = contentLang(db);
  // 与追问器同一条规矩：规划器写的流程状态记 agent / execution；人的批准 / 放弃记人的名字。
  const set = (key, value, userId = null) => setParam(db, { taskId: carrierId, key, value, ...(userId ? { by: BY(userId), governance: 'constitutional' } : { by: { kind: 'agent', id: 'project_planner' }, governance: 'execution' }) });
  if (db.one(`SELECT status FROM tasks WHERE id=?`, carrierId).status === 'running') db.run(`UPDATE tasks SET status='planning' WHERE id=?`, carrierId);
  // 上一版：下面判读答复时 append.reached 会被清掉，先把上一版原样留一份 —— 出新版时逐字比对要用它
  const prevVer = st.version > 0 ? { version: st.version, spec: getParam(db, carrierId, 'append.spec'), reached: getParam(db, carrierId, 'append.reached') } : null;

  let feedback = null;
  let mergedQueue = [];
  if (st.stage === 'proposed' && st.questionId) {
    const q = db.one(`SELECT status FROM questions WHERE id=?`, st.questionId);
    if (q && ['open', 'escalated'].includes(q.status)) return { kind: 'noop', why: review ? '复盘结论等人批' : '追加草案等人批' };
    const a = answerOf(db, st.questionId);
    if (!a) return { kind: 'noop', why: (review ? '复盘结论' : '追加草案') + '等人批，但找不到答复' };
    // 达成确认页的选项名（renderReached）：(A) 确认达成 / (C) 先放着 —— 照选项名回答也要认。
    const reachedNow = !!getParam(db, carrierId, 'append.reached');
    const verdict = readApproval(db, { taskId: carrierId, questionId: st.questionId, body: a.body, labels: reachedNow ? REACHED_LABELS : review ? REVIEW_LABELS : {}, reached: reachedNow, userId: a.sender_id, version: st.version });
    // 复盘提的任务方案回 E（已经达成，这些都不需要）：与达成确认回 A 同一个结局 —— 记人的判断，项目级验收归 advanceProject
    if (review && !reachedNow && verdict === 'reached') {
      db.tx(() => {
        set('append.reached', { reason: tl(lg, '人判定已达成：复盘提出的任务都不需要'), unverified: [] });
        set('append.stage', 'reached', a.sender_id);
        db.run(`UPDATE tasks SET status='done' WHERE id=?`, carrierId);
        audit(db, { actorKind: 'user', actorId: a.sender_id, action: 'project_goal_declared', targetType: 'project', targetId: project.id,
          payload: { version: st.version, questionId: st.questionId, unverified: [], via: 'review_tasks_declined' } });
      });
      return { kind: 'reached', version: st.version };
    }
    // 复盘那一支：上一版规划器答的是"已经达成"，人这一下点的就是**项目达成**。
    // 这里只记结论，不跑项目级验收命令 —— 那要仓库、要沙箱，归 advanceProject（它才有 home）。
    // 分成两处不是麻烦，是让"谁决定"与"怎么机械核实"各自留一条可复盘的痕迹。
    const reached = getParam(db, carrierId, 'append.reached');
    if (reached) {
      if (verdict === 'approve') {
        db.tx(() => {
          set('append.stage', 'reached', a.sender_id);
          db.run(`UPDATE tasks SET status='done' WHERE id=?`, carrierId);
          audit(db, { actorKind: 'user', actorId: a.sender_id, action: 'project_goal_declared', targetType: 'project', targetId: project.id,
            payload: { version: st.version, questionId: st.questionId, unverified: reached.unverified ?? [] } });
        });
        return { kind: 'reached', version: st.version };
      }
      if (verdict === 'abandon') {
        db.tx(() => {
          set('append.stage', 'abandoned', a.sender_id);
          db.run(`UPDATE tasks SET status='done' WHERE id=?`, carrierId);
          audit(db, { actorKind: 'user', actorId: a.sender_id, action: 'project_review_abandoned', targetType: 'project', targetId: project.id, payload: { version: st.version, questionId: st.questionId } });
        });
        return { kind: 'abandoned' };
      }
    }
    // 防循环：连着两次以「A」开头却读成"要改" → 先问清楚，不出新版。放在清 append.reached 之前：回 A 仍按这一版（含达成结论）走。
    if (verdict === 'feedback') {
      const cf = confirmBeforeRevising(db, { taskId: carrierId, questionId: st.questionId, body: a.body, version: st.version, reached: reachedNow });
      if (cf) {
        db.tx(() => { set('append.question', cf.questionId); db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, carrierId); });
        return { kind: 'proposed', confirm: true, reached: reachedNow, questionId: cf.questionId, version: st.version, text: cf.text };
      }
    }
    if (reached) set('append.reached', null);     // 人说"还差东西" → 下一版按反馈重来，别再拿着旧的达成结论
    // 需求出处：在达成确认里回"还差东西"并写了要什么的那个人，就是这一轮建出来的任务的提出人 ——
    // 否则建出来的任务不记在提需求的人名下，"你提的需求做完了"就发不到他。
    // 会签合并出来的那条答复署的是最后一个答复人，所以按各人自己写的答复找第一个"还差东西"的。
    if (reached && verdict === 'feedback' && !st.requestedBy) {
      const who = db.all(`SELECT user_id, body FROM answers WHERE question_id=? AND stance='answer' ORDER BY created_at, rowid`, st.questionId)
        .find((x) => readVerdict(x.body, REACHED_LABELS) === 'feedback')?.user_id ?? a.sender_id;
      set('append.requested_by', who);
      // 同一条需求可能走两条路 —— 发到已合并任务上的那句进了队列，提需求的人又在达成确认里回"还差这个"；
      // 这一版按他的反馈切进了新任务，批准后队里那条再出队、又会起草一轮。所以他自己排着的需求并进这一轮，一起交给规划器，从队里拿掉。
      const q = st.queue ?? [];
      mergedQueue = q.filter((x) => x.userId === who);
      if (mergedQueue.length) {
        setParam(db, { taskId: carrierId, key: 'append.queue', value: q.filter((x) => x.userId !== who), by: { kind: 'agent', id: 'project' }, governance: 'execution' });
        audit(db, { actorKind: 'system', action: 'project_append_queue_merged', targetType: 'project', targetId: project.id,
          payload: { by: who, items: mergedQueue.map((x) => x.id), human: tl(lg, '{n} 条排着的需求并进这一轮（提需求的人在达成确认里回了"还差东西"）', { n: mergedQueue.length }) } });
      }
    }
    if (verdict === 'approve') {
      const spec = getParam(db, carrierId, 'append.spec');
      const p = db.one(`SELECT * FROM projects WHERE id=?`, project.id);
      if (!['active', 'stalled', 'done'].includes(p.status)) { set('append.stage', 'abandoned', a.sender_id); db.run(`UPDATE tasks SET status='done' WHERE id=?`, carrierId); return { kind: 'abandoned', why: `项目已 ${p.status}` }; }
      const chain = projectTasks(db, project.id);
      const startOrder = (chain.at(-1)?.project_order ?? 0) + 1;
      const seedExtra = [...(st.seed ?? []), ...chainVerify(db, project.id)];
      const taskIds = createProjectTasks(db, { projectId: project.id, userId: p.owner_id, tasks: spec.tasks, startOrder, seedExtra });
      db.tx(() => {
        // 需求出处：谁提的 → 签收路由里的「需求提出人」、合并后的完成通知都认它
        if (st.requestedBy) for (const id of taskIds) setParam(db, { taskId: id, key: 'task.requested_by', value: st.requestedBy, by: BY(st.requestedBy), governance: 'constitutional' });
        set('append.stage', 'approved', a.sender_id);
        db.run(`UPDATE tasks SET status='done' WHERE id=?`, carrierId);
        // 批准时带的保留意见单独记下
        const resv = reservationOf(a.body);
        if (resv) recordReservation(db, { projectId: project.id, subject: tl(lg, '批准追加草案 v{version} 时的保留意见', { version: st.version }), text: resv, sourceKind: 'contract', sourceId: st.questionId, by: a.sender_id });
        if (['done', 'stalled'].includes(p.status)) db.run(`UPDATE projects SET status='active' WHERE id=?`, project.id);     // 全部合并完 / 停滞的项目：追加后重新有事可做（停滞的原来不放回 active，新任务永远不开工）
        db.run(`UPDATE projects SET brief=? WHERE id=?`, `${p.brief ?? ''}\n\n${tl(lg, '---- 追加（{date}）----', { date: new Date(now()).toISOString().slice(0, 10) })}\n${st.brief}`, project.id);
        audit(db, { actorKind: 'user', actorId: a.sender_id, action: 'project_appended', targetType: 'project', targetId: project.id,
          payload: { version: st.version, questionId: st.questionId, startOrder, tasks: taskIds, reopened: p.status === 'done' } });
      });
      return { kind: 'approved', version: st.version, tasks: taskIds, startOrder };
    }
    if (verdict === 'abandon') {
      db.tx(() => {
        set('append.stage', 'abandoned', a.sender_id);
        db.run(`UPDATE tasks SET status='done' WHERE id=?`, carrierId);
        audit(db, { actorKind: 'user', actorId: a.sender_id, action: 'project_append_abandoned', targetType: 'project', targetId: project.id, payload: { version: st.version, questionId: st.questionId } });
      });
      return { kind: 'abandoned' };
    }
    feedback = feedbackOf(db, { taskId: carrierId, questionId: st.questionId, body: a.body });
    if (mergedQueue.length) feedback = `${feedback ?? ''}\n\n同一个人之前排着的需求（并进这一版一起做，不会再单独起草）：\n${mergedQueue.map((x) => `- ${x.brief}`).join('\n')}`;
  }

  if (review) return await planReview(db, { client, project, tier, maxAttempts, tool, doneTool, repoGlance, st, set, carrierId, feedback, prevVer });

  const existing = existingContracts(db, project.id);
  const graph = chainGraph(db, project.id);
  // 编号接在链上最大的之后 —— 含还在起草、没有契约的任务（existing 只列有契约的）。
  const startOrder = Math.max(0, ...graph.map((t) => t.order)) + 1;
  const depsOf = (order) => { const g = graph.find((x) => x.order === order); return g ? `依赖 ${g.dependsOn.length ? g.dependsOn.map((n) => `#${n}`).join('、') : '无'}；${g.merged_at ? '已合并' : g.started ? '已开工' : '未开工'}` : ''; };
  const parts = [`## 项目原规划（原文）\n${project.brief || '（无）'}`,
    `## 现有任务（不要改动；行首是任务编号。新任务的起始编号 = ${startOrder}）\n${existing.map((t) => `${t.project_order}. ${t.title}［${depsOf(t.project_order)}］\n   目标：${t.goal}\n   完成定义：${t.definition_of_done}\n   验收命令：${t.verify || '（无）'}${appliedFixes(db, t.id)}`).join('\n') || '（无）'}`,
    `## 人要追加的内容（原文）\n${st.brief}`, repoGlance(project.repo)];
  // 上一版 = 人当时看到的原文（批准事项正文），不再由规划器"重建"；这一轮人说过的每一句都带上
  const hist = roundHistory(db, { carrierId, sinceTs: roundSinceTs(db, st) });
  if (st.version > 0) {
    const prev = getParam(db, carrierId, 'append.spec');
    const prevText = hist.prevText ?? (prev ? renderAppendProposal(db, { project, spec: prev, version: st.version, notes: getParam(db, carrierId, 'append.notes'), startOrder, seedCount: 1 }) : null);
    if (prevText) parts.push(`## 上一版追加草案（v${st.version}，人看到的原文）\n${prevText}`);
  }
  // 决定登记：追加的规划器同样拿**完整**清单 —— 新加的任务最容易和几周前定下的约定打架。
  const dsec = decisionsSection(db, { projectId: project.id });
  if (dsec) parts.push(`## 已经定下的约定\n${dsec}`);
  parts.push(...sideInput(db, { st, carrierId }));
  { const h = renderRoundHistory(hist); if (h) parts.push(h); }
  if (feedback) parts.push(`## 人对上一版草案的反馈（经认证通道，具指令效力）\n${feedback}\n\n按反馈出下一版。`);
  const messages = [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] }];
  const quoteSource = `${project.brief ?? ''}\n${st.brief}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await client.complete({ tier, system: withOutputLang(SYSTEM_APPEND(MAX_APPEND_TASKS), contentLang(db)), messages, tools: [tool], maxTokens: MAX_TOKENS, effort: 'high' });
    if (truncatedEmpty(resp)) throw new TruncatedEmptyError('项目规划器（追加）', MAX_TOKENS);
    const call = toolCallsOf(resp).find((c) => c.name === 'propose_project');
    const errs = [];
    let spec = null;
    if (!call) errs.push(`没有调用 propose_project（stopReason=${resp.stopReason}）。只输出工具调用，不要只输出文字。`);
    else {
      spec = { title: project.title, tasks: Array.isArray(call.args?.tasks) ? call.args.tasks : [] };
      errs.push(...validateProjectSpec(spec, { brief: quoteSource, requireRules: true,
        deps: { startOrder, existing: chainGraph(db, project.id).map((t) => ({ order: t.order, started: t.started, dependsOn: t.dependsOn })) } }));
      if (spec.tasks.length > MAX_APPEND_TASKS) errs.push(`任务数 ${spec.tasks.length} 超过 ${MAX_APPEND_TASKS}`);
    }
    if (!errs.length) {
      const version = st.version + 1, qid = newId('q'), t = now(), notes = String(call.args?.notes ?? '');
      const seedCount = (st.seed ?? []).length + chainVerify(db, project.id).length;
      const gate = await autoGearGate(db, { project, spec, client });
      if (gate.auto) return landAuto(db, { project, spec, startOrder, seedExtra: [...(st.seed ?? []), ...chainVerify(db, project.id)],
        set, carrierId, version, notes, gate, attempt, review: false });
      const text = autoFallbackNote(gate, lg) + withDiff(renderAppendProposal(db, { project, spec, version, notes, startOrder, seedCount, continued: st.continued }), prevVer, { tasks: spec.tasks }, lg);
      db.tx(() => {
        db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
                VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, qid, carrierId, text, t);
        routeQuestion(db, { questionId: qid, decisionType: 'contract_approval', typeSource: 'hard_rule', prefixes: specPrefixes(spec.tasks).length ? specPrefixes(spec.tasks) : null, at: t });
        db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, carrierId);
        set('append.spec', spec); set('append.notes', notes); set('append.version', version); set('append.question', qid); set('append.stage', 'proposed');
        audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_append_proposed', targetType: 'project', targetId: project.id,
          // 报过哪几对范围重叠也进审计：预警不是闸门，"有没有被略过"只能事后拿它对着批准答复查。
          payload: { version, questionId: qid, startOrder, tasks: spec.tasks.map((x) => String(x.title).slice(0, 80)),
            overlapsWarned: scopeOverlaps(spec, { startAt: startOrder }) } });
      });
      return { kind: 'proposed', version, questionId: qid, text, attempts: attempt };
    }
    audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_plan_attempt', targetType: 'project', targetId: project.id,
      payload: { append: true, attempt, rejections: errs, say: textOf(resp).slice(0, 600) || null, stopReason: resp.stopReason } });
    if (attempt === maxAttempts) throw new I18nError('项目规划器 {n} 次都没给出合规的追加契约：{errs}', { n: maxAttempts, errs: errs.join('；') });
    messages.push({ role: 'assistant', content: resp.content });
    if (call) messages.push({ role: 'tool_results', results: [{ callId: call.id, name: call.name, isError: true, content: `被拒：\n- ${errs.join('\n- ')}` }] });
    else messages.push({ role: 'user', content: [{ type: 'text', text: errs[0] }] });
  }
  throw new Error('unreachable');
}

// ── 复盘的一次寿命 ────────────────────────────────────────────────────────
// 与追加共用 stage / question / version 那一套状态，只有三处不同：给模型的材料是**项目目标 +
// 完成定义 + 已交付的契约**（而不是人写的一段追加说明）；多一个出口 `project_goal_reached`；
// 走那个出口时落的是一条"达成确认"事项而不是契约草案。

const SYSTEM_REVIEW = (max) => `你是一个长期运行的自主 agent 的"项目规划器"。这个项目的全部任务都已经完成、经人签收、合并进项目分支了。
现在要做一次复盘，只回答一个问题：**对照项目目标与完成定义，还差什么。**

两个出口，必须选一个：
- 还差东西 → 调用 propose_project，把还要做的切成 1 到 ${max} 个新任务契约（编号接在现有任务之后，规矩与平常添加任务完全一样）。
- 已经达成 → 调用 project_goal_reached，逐条对照完成定义说明它为什么已经兑现。

判断的规矩：
- **只依据已交付契约的完成定义与产物**。你看不到代码，不要假装读过；从契约的"完成定义"推不出来的事，写进 unverified，不要当成已兑现。
- **不要为了显得勤奋而加任务**。项目目标已经兑现就说已兑现 —— 多切一批任务要花人的钱和时间，而"再润色一轮"永远有得做。
- **也不要为了收工而漏掉**。完成定义里明写、而现有契约里一条都没对应上的，就是还差的那部分，必须提出来。
- 加任务时与平常同一套规矩：依赖如实写、接口名写死、一条规则只讲一件事、每条规则带出处、验收命令不经 shell。
- 拿不准的写进 notes（提任务时）或 unverified（声明达成时），让人来定。
- 只调用工具，不要输出别的文字。人对上一版的反馈会以"人的反馈"出现，按反馈重来。`;

export function renderReached(db, { project, reason, unverified, version }) {
  const merged = projectTasks(db, project.id).filter((t) => t.merged_at);
  const lg = contentLang(db);
  const L = [markOf(lg, 'reached', { version }), tl(lg, '项目：{v}', { v: project.title }), '',
    tl(lg, '目标：{v}', { v: project.goal || tl(lg, '（没写）') }), tl(lg, '完成定义：{v}', { v: project.done_definition || tl(lg, '（没写）') }), '',
    tl(lg, '已完成并合并的任务（{n} 个）：', { n: merged.length }),
    ...merged.map((t) => `  ${t.project_order}. ${t.title}`), '',
    tl(lg, '规划器的判断：{reason}', { reason }), ''];
  // 这一节是人点头前唯一该逐条核的地方：规划器看不到代码，只看得到契约的完成定义。
  // 它说不准的每一条都单列出来，别让"已达成"这三个字把它们盖住。
  L.push(unverified?.length
    ? tl(lg, '⚠ 规划器无法确认的（{n} 条；它只看得到契约，看不到代码 —— 这几条要你自己判断）：{list}', { n: unverified.length, list: unverified.map((u) => `\n  - ${u}`).join('') })
    : tl(lg, '规划器无法确认的：无（每条完成定义都能对上某个任务的契约）'), '');
  const vc = projectVerifyCommand(db, project.id);
  L.push(vc ? tl(lg, '确认之后系统会先跑项目级验收命令「{cmd}」（在项目分支的一个干净克隆里），过了才宣布达成。', { cmd: vc.join(' ') })
    : tl(lg, '这个项目没有填项目级验收命令 —— **"达成"完全由你这一下决定**，没有机械核实。要加就先到「项目设置 → 自动化」填上项目级验收命令再来。'), '');
  L.push(tl(lg, '请回复：'), tl(lg, '(A) 确认达成 —— 回 "A" 或 "批准"；项目转为已完成，随后可以交付'),
    // 明说"想加的需求也写在这里"（否则达成确认容易被读成"项目算不算做完"：人回了 A，本想提的需求就没提出来）
    tl(lg, '(B) 还差东西，或者还想加新需求 —— 直接写还差什么 / 想加什么（例如"还想加：列表能按优先级排序"），系统按你说的拆成新任务、再给你看一版（已经做好的部分保留）；这样提的需求记在你名下'),
    tl(lg, '(C) 先放着 —— 回 "C" 或 "放弃"；项目转为停滞，等你添加任务、或中止项目'));
  return L.join('\n');
}

/**
 * 这个任务签收前后按人的修正改过什么（已生效的计划变更）。复盘规划器只看契约原文的话，打回过的要求像是"还没做"——
 * 例：某个任务的签收被打回、重做后重新签收合并；复盘若看不到，就会按那条打回又提一个重复的任务。
 */
function appliedFixes(db, taskId) {
  const revs = db.all(`SELECT m.body FROM revisions r JOIN messages m ON m.id=r.message_id WHERE r.task_id=? AND r.status='applied' ORDER BY r.proposed_at`, taskId);
  if (!revs.length) return '';
  return `\n   签收前后按人的修正改过（**都已落实，并随这个任务重新签收、合并了 —— 不要再为它们开任务**）：\n${revs.map((r) => `     - ${String(r.body).replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')}`;
}

async function planReview(db, { client, project, tier, maxAttempts, tool, doneTool, repoGlance, st, set, carrierId, feedback, prevVer = null }) {
  const existing = existingContracts(db, project.id);
  const graph = chainGraph(db, project.id);
  const startOrder = Math.max(0, ...graph.map((t) => t.order)) + 1;
  const parts = [
    `## 项目目标\n${project.goal || '（没写）'}`,
    `## 完成定义（人写的，这就是判据）\n${project.done_definition || '（没写）'}`,
    `## 原规划（原文）\n${project.brief || '（无）'}`,
    `## 已完成并合并的任务契约（新任务的起始编号 = ${startOrder}）\n${existing.map((t) => `${t.project_order}. ${t.title}［${t.merged_at ? '已合并' : t.status}］\n   目标：${t.goal}\n   完成定义：${t.definition_of_done}\n   验收命令：${t.verify || '（无）'}${appliedFixes(db, t.id)}`).join('\n') || '（无）'}`,
    repoGlance(project.repo),
  ];
  const dsec = decisionsSection(db, { projectId: project.id });
  if (dsec) parts.push(`## 已经定下的约定\n${dsec}`);
  // 上一版 = 人当时看到的原文：否则上一版若是"已达成"，规划器手里什么都没有；若是任务，拿到的是重建的
  const hist = roundHistory(db, { carrierId, sinceTs: roundSinceTs(db, st) });
  if (st.version > 0) {
    const prev = getParam(db, carrierId, 'append.spec');
    const prevText = hist.prevText ?? (prev ? renderAppendProposal(db, { project, spec: prev, version: st.version, notes: getParam(db, carrierId, 'append.notes'), startOrder, seedCount: 1 }) : null);
    if (prevText) parts.push(`## 上一版复盘结论（v${st.version}，人看到的原文）\n${prevText}`);
  }
  parts.push(...sideInput(db, { st, carrierId }));
  { const h = renderRoundHistory(hist); if (h) parts.push(h); }
  if (feedback) parts.push(`## 人对上一版的反馈（经认证通道，具指令效力）\n${feedback}\n\n按反馈重来。`);
  const messages = [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] }];
  const tools = doneTool ? [tool, doneTool] : [tool];
  const quoteSource = `${project.brief ?? ''}\n${project.goal ?? ''}\n${project.done_definition ?? ''}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await client.complete({ tier, system: withOutputLang(SYSTEM_REVIEW(MAX_APPEND_TASKS), contentLang(db)), messages, tools, maxTokens: MAX_TOKENS, effort: 'high' });
    if (truncatedEmpty(resp)) throw new TruncatedEmptyError('项目规划器（复盘）', MAX_TOKENS);
    const calls = toolCallsOf(resp);
    const done = doneTool ? calls.find((c) => c.name === doneTool.name) : null;
    const call = calls.find((c) => c.name === 'propose_project');
    const errs = [];
    let spec = null;
    if (done && call) errs.push('两个出口只能选一个：要么 propose_project，要么 project_goal_reached。');
    else if (done) {
      if (!String(done.args?.reason ?? '').trim()) errs.push('project_goal_reached 缺 reason：逐条对照完成定义说明它为什么已经兑现。');
      if (done.args?.unverified !== undefined && !Array.isArray(done.args.unverified)) errs.push('unverified 要是数组（没有就写 []）。');
    } else if (!call) errs.push(`没有调用任何工具（stopReason=${resp.stopReason}）。必须二选一：propose_project 或 project_goal_reached。`);
    else {
      spec = { title: project.title, tasks: Array.isArray(call.args?.tasks) ? call.args.tasks : [] };
      errs.push(...validateProjectSpec(spec, { brief: quoteSource, requireRules: true,
        deps: { startOrder, existing: graph.map((t) => ({ order: t.order, started: t.started, dependsOn: t.dependsOn })) } }));
      if (spec.tasks.length > MAX_APPEND_TASKS) errs.push(`任务数 ${spec.tasks.length} 超过 ${MAX_APPEND_TASKS}`);
    }
    if (!errs.length) {
      const version = st.version + 1, qid = newId('q'), t = now();
      if (done) {
        const reached = { reason: String(done.args.reason).trim(), unverified: (done.args.unverified ?? []).map(String) };
        const text = withDiff(renderReached(db, { project, ...reached, version }), prevVer, { reached }, contentLang(db));
        db.tx(() => {
          db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
                  VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, qid, carrierId, text, t);
          // 与"下一批任务"同一条路由（方案批准类，收件人必含负责人）：复盘的两条出路该落在同一张桌上，
          // 人才能在同一个地方决定"收工"还是"再加一批"。达成确认覆盖整个项目 → 按"碰到了每个目录"路由，
          // 管各目录的人都能说"还差什么"（只落到负责人的话，成员的需求出不来）。
          const whole = wholeProjectPrefixes(db, carrierId, 'contract_approval');
          routeQuestion(db, { questionId: qid, decisionType: 'contract_approval', typeSource: 'hard_rule', prefixes: whole.length ? whole : null, at: t });
          db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, carrierId);
          set('append.reached', reached); set('append.spec', null); set('append.version', version); set('append.question', qid); set('append.stage', 'proposed');
          audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_goal_reached_proposed', targetType: 'project', targetId: project.id,
            payload: { version, questionId: qid, unverified: reached.unverified.length } });
        });
        return { kind: 'proposed', reached: true, version, questionId: qid, text, attempts: attempt };
      }
      const notes = String(call.args?.notes ?? '');
      const seedCount = chainVerify(db, project.id).length;
      const gate = await autoGearGate(db, { project, spec, client });
      if (gate.auto) return landAuto(db, { project, spec, startOrder, seedExtra: chainVerify(db, project.id),
        set, carrierId, version, notes, gate, attempt, review: true });
      const text = autoFallbackNote(gate, contentLang(db)) + withDiff(renderAppendProposal(db, { project, spec, version, notes, startOrder, seedCount, continued: false, review: true }), prevVer, { tasks: spec.tasks }, contentLang(db));
      db.tx(() => {
        db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
                VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, qid, carrierId, text, t);
        // 复盘的这条出路（还差这些）与达成确认同一张桌：碰到的目录 ∪ 整个项目
        const pf = [...new Set([...specPrefixes(spec.tasks), ...wholeProjectPrefixes(db, carrierId, 'contract_approval')])];
        routeQuestion(db, { questionId: qid, decisionType: 'contract_approval', typeSource: 'hard_rule', prefixes: pf.length ? pf : null, at: t });
        db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, carrierId);
        set('append.reached', null); set('append.spec', spec); set('append.notes', notes); set('append.version', version); set('append.question', qid); set('append.stage', 'proposed');
        audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_review_proposed', targetType: 'project', targetId: project.id,
          payload: { version, questionId: qid, startOrder, tasks: spec.tasks.map((x) => String(x.title).slice(0, 80)) } });
      });
      return { kind: 'proposed', reached: false, version, questionId: qid, text, attempts: attempt };
    }
    audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_plan_attempt', targetType: 'project', targetId: project.id,
      payload: { review: true, attempt, rejections: errs, say: textOf(resp).slice(0, 600) || null, stopReason: resp.stopReason } });
    if (attempt === maxAttempts) throw new I18nError('项目规划器 {n} 次都没给出合规的复盘结论：{errs}', { n: maxAttempts, errs: errs.join('；') });
    messages.push({ role: 'assistant', content: resp.content });
    const bad = done ?? call;
    if (bad) messages.push({ role: 'tool_results', results: [{ callId: bad.id, name: bad.name, isError: true, content: `被拒：\n- ${errs.join('\n- ')}` }] });
    else messages.push({ role: 'user', content: [{ type: 'text', text: errs[0] }] });
  }
  throw new Error('unreachable');
}

// ── 自动挡──────────────────────────────────────────────────────────
// 预算内自动 = 草案**直接开工**、事后通知、人随时可中止。四条前提写死在 project-settings 的
// GEAR_PREREQS 里，其中前两条（预算闸 / 项目级验收命令）挂挡时就判过；第三条（草案过现有全部
// 护栏）就是上面那一整套 validateProjectSpec —— 走到这里说明已经过了；第四条在这里判。
//
// **第四条：与有效决定清单冲突时退回提议挡。** 比的是规划器刚写出来的这一批任务（标题 / 目标 /
// 范围 / 完成定义），对着这个项目此刻仍然有效的约定清单。命中就把这一批退回提议挡等人批 ——
// 不是拦住、不是作废旧决定，是**降一挡**：有争议的东西不该由自动挡替人拍板。
//
// ⚠️ 比对自己坏掉（解析不出、没客户端）不等于"没有冲突"，但也不该让它把自动挡卡死。
// 取的口径是：**比对跑不成就退回提议挡**。这条路上"多问人一次"的代价是一条待办，
// "少问人一次"的代价是一批没人看过的任务直接开工 —— 两边不对称，就按贵的那边定。

async function autoGearGate(db, { project, spec, client }) {
  if (gearOf(db, project.id) !== 'auto') return { auto: false, why: 'gear:propose' };
  const miss = gearPrereqStatus(db, project.id).filter((p) => !p.ok);
  if (miss.length) return { auto: false, why: 'prereq', missing: miss };
  const b = budgetState(db, project.id);
  if (b.over) return { auto: false, why: 'budget_over', budget: b };
  const list = activeDecisions(db, { projectId: project.id });
  if (!list.length) return { auto: true, considered: 0 };
  const text = spec.tasks.map((t, i) => `任务 ${i + 1}「${t.title}」：${t.goal}｜范围：${t.scope}｜完成定义：${t.definition_of_done}`).join('\n');
  let r;
  try { r = await checkDecisions(text, { decisions: list, llmClient: client, entry: 'task', lang: contentLang(db) }); }
  catch (e) { return { auto: false, why: 'check_failed', error: String(e.message).slice(0, 200) }; }
  if (r.skipped && r.skipped !== 'no_decisions') return { auto: false, why: `check_${r.skipped}` };
  if (r.hits.length) {
    const byId = new Map(list.map((d) => [d.id, d]));
    return { auto: false, why: 'decision_conflict', hits: r.hits.map((h) => ({ ...h, decision: byId.get(h.id) })), considered: r.considered };
  }
  return { auto: true, considered: r.considered };
}

/** 退回提议挡时，把"为什么没自动开工"写进批准事项的开头 —— 人要看到的是判断，不是一条日志。 */
export function autoFallbackNote(gate, lang = 'zh') {
  if (!gate || gate.auto) return '';
  const mark = markOf(lang, 'autoGateBack');
  if (gate.why === 'decision_conflict') {
    return `${mark}${tl(lang, '这一批任务里有 {n} 处与这个项目已经定下的约定对不上，按自动挡的第四条前提退回提议挡：', { n: gate.hits.length })}`
      + `\n${gate.hits.map((h) => tl(lang, '  - 与「{subject}」：{why}', { subject: h.decision?.subject ?? h.id, why: h.why ?? tl(lang, '（没说理由）') })).join('\n')}\n`
      + `${tl(lang, '照做会推翻那条约定，所以不由系统替你拍板。批准即认可这一批；不同意就在反馈里说清以哪条为准。')}\n\n`;
  }
  if (gate.why === 'budget_over') return `${mark}${tl(lang, '项目已达预算闸（{budget}），自动挡不再自己开工。', { budget: gate.budget.human })}\n\n`;
  if (gate.why === 'prereq') return `${mark}${tl(lang, '自动挡的前提此刻不成立：{list}。', { list: gate.missing.map((m) => m.label).join(tl(lang, '；')) })}\n\n`;
  if (String(gate.why).startsWith('check_')) {
    return `${mark}${tl(lang, '与已定约定的比对这次没跑成（{why}）。比对跑不成不等于没有冲突，所以按提议挡走 —— 多问你一次是一条待办，少问一次是一批没人看过的任务直接开工。', { why: gate.why })}\n\n`;
  }
  return '';
}

/**
 * 自动挡落地：**不建批准事项，直接建任务**。人不批，但三件事必须留下：
 *   ① 每个任务打上 `task.auto_added` —— 后置签收凭它区分"AI 自己加的"与"人加的"；
 *   ② 一条 `project_auto_batch` 审计 —— 摘要靠它做事后通知；
 *   ③ 草案原文仍存在 `append.spec` 里 —— 没有批准事项就没有那份正文，事后想看"它当时打算做什么"只剩这一份。
 */
function landAuto(db, { project, spec, startOrder, seedExtra, set, carrierId, version, notes, gate, attempt, review }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, project.id);
  const taskIds = createProjectTasks(db, { projectId: project.id, userId: p.owner_id, tasks: spec.tasks, startOrder, seedExtra });
  db.tx(() => {
    for (const id of taskIds) setParam(db, { taskId: id, key: 'task.auto_added', value: true, by: { kind: 'agent', id: 'project_planner' }, governance: 'execution' });
    const requestedBy = getParam(db, carrierId, 'append.requested_by');
    if (requestedBy) for (const id of taskIds) setParam(db, { taskId: id, key: 'task.requested_by', value: requestedBy, by: BY(requestedBy), governance: 'constitutional' });
    set('append.spec', spec); set('append.notes', notes); set('append.version', version); set('append.question', null); set('append.stage', 'approved'); set('append.reached', null);
    db.run(`UPDATE tasks SET status='done' WHERE id=?`, carrierId);
    if (['done', 'stalled'].includes(p.status)) db.run(`UPDATE projects SET status='active' WHERE id=?`, project.id);
    audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_auto_batch', targetType: 'project', targetId: project.id,
      payload: { version, startOrder, tasks: taskIds, titles: spec.tasks.map((x) => String(x.title).slice(0, 80)), review, considered: gate.considered ?? 0 } });
  });
  return { kind: 'approved', auto: true, review, version, tasks: taskIds, startOrder, attempts: attempt };
}

// 「AI 替你定了几件事」的答复（core/choices.mjs）：已合并的任务要改，就替答复人「添加任务」——
// 那一步在 agent 层，所以钩子注册在这里（守护进程、看板、CLI 都会加载本模块）。
PRE_HOOKS.push((db, o) => answerChoices(db, { ...o, append: (brief) => {
  const t = db.one(`SELECT project_id FROM tasks WHERE id=?`, o.question.task_id);
  return requestAppend(db, { projectId: t.project_id, userId: o.by, brief, viaQuestion: o.question.id });
} }));
