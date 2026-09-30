// Web 看板 —— 零依赖：Node 内置 http + 一页静态 HTML + SSE。
//
// 设计原文：四视图 —— DAG 状态图、决策/活动流（自作主张显式标出）、待答问题（挂在谁身上、剩余超时）、
// Inbox（消息队列与消费状态）；控制杆全集 —— 暂停 / 恢复 / 中止 / 改向（经 inbox）/ 批准与否决 / 调整优先级。
//
// 三条边界：
//   - **看板不是第二个状态机**。它只读真相源（状态库 + 审计轨），写只经已有的入口（recordAnswer / recordMessage /
//     applyRevision / setLimit …）—— CLI 能做的它才能做，CLI 不能做的它也不能。
//   - **实时性靠轮询审计轨 + SSE**，不靠 WebSocket、不靠进程内事件：编排器是另一个进程，库就是总线。
//     每秒看一次 audit_log 的最大 rowid，变了就推一条 `change`，页面自己拉详情。
//   - **只绑 127.0.0.1，身份 = CLI 令牌**：默认是起看板那个人的令牌；每个请求可以带自己的令牌
//     （头 x-superintern-token 或 cookie si_token），介入者 / 旁观者各用各的。仍不开外网、不做登录 —— 远程走 SSH 隧道。
//   - **看板按角色**：负责人全视图 + 全控制杆；介入者全景只读 + 自己的待答事项 + 转交；旁观者全景只读 + 留言。
//     角色不是页面判的：写入口各自查路由表（setLimit / signOff / deliverTask / recordAnswer），页面只是把按钮藏起来。
//
// "运行"按钮起的是 `node src/cli.mjs run <task>` 子进程（恢复 = 再跑一次 run），日志落
// `.superintern/logs/`，页面能看尾巴。看板不 in-process 跑编排器：编排器该退出时就退出，看板不该拖着它。

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOwner, authenticate, audit, now } from '../db/db.mjs';
import { openQuestions, pendingMessages, recordAnswer, sayWithClassifier, heldSteering, markConsumed } from '../core/inbox.mjs';
import { answersOf, voteRulesOf } from '../core/answers.mjs';
import { DECISION_TYPES, loadTemplates, rulesOf, profileOf, knobsOf, setKnobs, applyTemplate, saveRules, diffFromTemplate, previewRouting,
  dutyCalendarOf, setDutyCalendar, transferQuestion, leadOf, leadOfKey, routingKeyOf, validateRules, authorize } from '../core/routing.mjs';
import { addUser, listUsers, usersView, setUserChannel, removeUserChannel, setUserTags, setUserRole, renameUser, reissueToken } from '../core/users.mjs';
import { canCreate, setSetting, settingsView, getSetting } from '../core/settings.mjs';
import { CATALOGS, normLang, contentLang, userLang, translateError, localizeHtml, tl, I18nError } from '../i18n/index.mjs';
import { permissionsOf } from '../core/permissions.mjs';
import { reopenTask, redoProjectTask, abortProject, renameTask, renameProject, setTaskArchived, setProjectArchived } from '../core/lifecycle.mjs';
import { daemonStatus, assessTask } from '../core/daemon.mjs';
import { knownRepos, checkRepoSource } from '../core/repos.mjs';
import { requestAppend, appendStateOf, appendPending, reviewAgain } from '../agent/project-append.mjs';
import { projectsToDeliver } from '../core/delivery-due.mjs';
import { approvalThreadOf, describeReading, readingsOf } from '../agent/approval.mjs';
import { startProject } from '../agent/project-start.mjs';
import { deliveryRange, viewOf, linesOf, rangeFor, roundSinceOf } from '../core/diffview.mjs';
import { makeRuntimeHealth } from '../core/health.mjs';
import { listMembers, setMember, removeMember, setVisibility, canAddTasks, involvedIn, canSeeProject, canSeeTask, editProjectGoal, VISIBILITIES } from '../core/project-members.mjs';
import { previewHandover, executeHandover, requestHandover, listHandoverRequests, decideHandoverRequest, canDecideHandover, disableUser, enableUser } from '../core/handover.mjs';
import { buildDigest, renderDigest, sendHandoverNotice, renderHandover } from '../core/digest.mjs';
import { pendingRevision, nodesForReplan, gateOf, renderDiff, applyRevision, rejectRevision } from '../core/revision.mjs';
import { LIMITS, limitOf, setLimit, setProjectLimit, projectLimits, LAYER_NAMES, limitChain } from '../core/limits.mjs';
import { listReports, markReportsRead } from '../agent/reporter.mjs';
import { signOff, signoffOf, deliverTask } from '../core/deliver.mjs';
import { timeoutFor } from '../core/timeouts.mjs';
import { makeLauncher } from '../core/launcher.mjs';
import { projectTasks, chainGraph, advanceProject, deliverProject, acceptDeferredSignoffs, deliveryEvidence } from '../core/project.mjs';
import { getParam } from '../core/params.mjs';
import { LlmClient } from '../llm/client.mjs';
import { afterInput } from '../core/decision-check.mjs';
import { activeDecisions, SOURCE_NAMES, sourceNamesOf, overruledContractRules } from '../core/decisions.mjs';
import { budgetState, setProjectBudget, projectVerifyCommand, setProjectVerify, gearOf, setGear, gearPrereqStatus, GEARS, deferredSignoffs, maxOpenOf, setMaxOpen, MAX_OPEN_CEILING, setupCommandsOf, setSetupCommands, detectSetupCommands } from '../core/project-settings.mjs';
import { TIERS, EFFORTS } from '../llm/canonical.mjs';
import { registryFor, endpointsOf, endpointDiff, keyPresence, catalogOf, bindable, bindingOf, bindingProblems, setBinding, saveEndpoint, setEndpointEnabled,
  removeEndpoint, testEndpoint, listEndpointModels, saveModel, removeModel, checkableCatalog, ADAPTERS, ADAPTER_DEFAULTS } from '../llm/registry.mjs';
import { checkCatalog, recordCatalogCheck, lastCatalogCheck } from '../llm/catalog-check.mjs';
import { setEnvVar } from '../core/envfile.mjs';
// 联网目录与项目联网（v20）。同时也注册了"联网放行"事项的答复钩子 —— 不 import 它，看板上的答复就不会生效
import { egressSources, addSource, removeSource, sourceUsage, projectEgressOf, setProjectEgress } from '../core/egress.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// 报错按请求人的界面语言翻（看板每次请求带 X-SI-Lang；见 src/i18n/index.mjs）。error 可以是字符串或异常本身：
// 传异常才翻得了带参数的 I18nError；字符串只能整句查目录。
const json = (res, status, body) => {
  if (status >= 400 && body?.error != null) body = { ...body, error: translateError(body.error instanceof Error ? body.error : { message: String(body.error) }, res.__lang) };
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((ok, bad) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  req.on('error', bad);
});

/**
 * 来源检查。不带令牌的请求按起看板的人执行（tokenPlain 兜底，默认负责人流程靠它），
 * 所以"请求是不是看板页面自己发的"必须另查，否则任意网页都能借浏览器替负责人发 POST ——
 * 有了注册表之后那意味着改服务商地址 + 测试连接 = 把真 key 发到任意地址。
 *   1. Host 必须是本机名（挡 DNS 重绑定：攻击页把自己的域名解析到 127.0.0.1 后 Origin 与 Host 会一致）
 *   2. POST 的 content-type 必须是 application/json（text/plain 是 CORS 简单请求，不预检）
 *   3. POST 的 Sec-Fetch-Site 为 same-origin / none，或 Origin 与 Host 一致；两个头都没有的
 *      （curl / 脚本 / 测试，不是浏览器）放行
 * @returns 拒绝理由（字符串，或带参数的 I18nError —— 出口 json() 按看的人的语言翻），或 null
 */
export function crossSiteReason(req, { host = '127.0.0.1', allowHosts = [] } = {}) {
  const h = String(req.headers.host ?? '');
  const hostname = h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  // 团队模式：另放行对外地址的主机名（--public-url）。只放这一个，不放"任意"——DNS 重绑定照样挡。
  if (!['127.0.0.1', 'localhost', '::1', String(host).toLowerCase(), ...allowHosts.map((x) => String(x).toLowerCase())].includes(hostname)) return new I18nError('跨站请求被拒：Host 不是本机（{host}）', { host: h.slice(0, 80) });
  if (req.method !== 'POST') return null;
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return '跨站请求被拒：POST 的 content-type 必须是 application/json';
  const sfs = req.headers['sec-fetch-site'], origin = req.headers.origin;
  if (sfs && !['same-origin', 'none'].includes(String(sfs).toLowerCase())) return '跨站请求被拒：请求来源不是看板页面';
  if (origin) {
    let oh = null; try { oh = new URL(origin).host.toLowerCase(); } catch { /* 'null' 之类 */ }
    if (oh !== h.toLowerCase()) return '跨站请求被拒：Origin 与看板地址不一致';
  }
  return null;
}

// ── 视图数据（只读）──────────────────────────────────────────────────────
/** 项目列表：契约任务顺序、合并 / 签收进度、草案状态。看板用它给任务选择器分组、画项目行。 */
export function projectList(db, lang = 'zh') {   // lang：上限数值按看的人的界面语言格式化（"45 分钟" / "45 min"）
  return db.all(`SELECT * FROM projects ORDER BY created_at DESC`).map((p) => {
    const graph = chainGraph(db, p.id);
    const startedIds = new Set(graph.filter((g) => g.started).map((g) => g.id));
    const mergedOrders = new Set(graph.filter((g) => g.merged_at).map((g) => g.order));
    const began = (id) => !!db.one(`SELECT 1 FROM audit_log WHERE action='workspace_created' AND target_id=? LIMIT 1`, id);   // 真的开过工（有过工作区）；started 把已中止的也算进去了
    const tasks = projectTasks(db, p.id).map((t) => ({ ...t, started: startedIds.has(t.id), began: began(t.id), waitsFor: t.merged_at ? [] : t.dependsOn.filter((n) => !mergedOrders.has(n)) }));
    const carrier = db.one(`SELECT id FROM tasks WHERE project_id=? AND project_order=0`, p.id)?.id ?? null;
    const superseded = db.all(`SELECT id, title, status FROM tasks WHERE project_id=? AND project_order IS NULL ORDER BY created_at`, p.id);
    const spendMicro = db.one(`SELECT COALESCE(SUM(l.micro_usd),0) m FROM usage_ledger l JOIN tasks t ON t.id=l.task_id WHERE t.project_id=?`, p.id).m;
    // 其中起草方案（项目规划 / 添加任务 / 复盘，都记在载体任务上）花的那部分，单列 —— 否则"含方案规划"修饰谁读不出来，也没处对账。
    const planningMicro = carrier ? db.one(`SELECT COALESCE(SUM(micro_usd),0) m FROM usage_ledger WHERE task_id=?`, carrier).m : 0;
    const ap = appendStateOf(db, p.id);
    // 复盘用的是同一套 append.* 状态：界面要分得清"你要加的东西在起草"与"系统在复盘"，
    // 否则人会看着"追加中"发呆 —— 他并没有要求加任何东西。
    const append = appendPending(ap) ? { stage: ap.stage, version: ap.version, questionId: ap.questionId, kind: ap.kind } : null;
    // 排着队的需求：这一轮结束后按先后单独起草
    const uname = (id) => db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id;
    const appendQueue = (ap?.queue ?? []).map((q) => ({ by: uname(q.userId), brief: q.brief, at: q.at }));
    for (const t of tasks) { const rb = getParam(db, t.id, 'task.requested_by'); if (rb) t.requestedBy = uname(rb); }
    const budget = budgetState(db, p.id);
    const delivered = !!db.one(`SELECT 1 FROM audit_log WHERE action='project_delivered' AND target_id=? LIMIT 1`, p.id);
    // 交付过之后又合并了新任务（持续维护迭代）：还要再交付 —— 与收件箱「等你交付」同一个口径
    const deliverDue = projectsToDeliver(db, { ownerId: p.owner_id }).some((x) => x.projectId === p.id);
    // 交付前的一手证据。只在**能交付**的项目上算 —— 它要读一次 git，不该每次轮询给每个项目都跑一遍。
    const evidence = (p.status === 'done' || p.status === 'aborted') ? deliveryEvidence(db, { projectId: p.id }) : null;
    return { ...p, tasks, carrier, superseded, spendMicro, planningMicro, append, appendQueue, delivered, deliverDue, evidence, members: listMembers(db, p.id),
      gear: gearOf(db, p.id), gears: GEARS, gearPrereqs: gearPrereqStatus(db, p.id),
      budget: { gate: budget.gate, spent: budget.spent, remaining: budget.remaining, over: budget.over },
      verifyCommand: projectVerifyCommand(db, p.id), limits: projectLimits(db, p.id, lang), layerNames: LAYER_NAMES,
      deferredSignoffs: deferredSignoffs(db, p.id).map((t) => ({ id: t.id, order: t.project_order, title: t.title })),
      merged: tasks.filter((t) => t.merged_at).length,
      awaitingSignoff: tasks.find((t) => t.status === 'done' && !t.merged_at && t.signoff !== 'accepted')?.id ?? null,
      // current = 开着的任务（已开工、未合并、未中止；串行下至多一个）。每个任务带 waitsFor = 它还在等的任务编号。
      // 可能同时开着多个（"等人时让路"）。`current` 留着不动（老的调用方在读），
      // `openIds` 是全集 —— 界面要把"执行到此"那个标记打在每一个开着的任务上，不是只打第一个。
      current: tasks.find((t) => !t.merged_at && t.status !== 'aborted' && startedIds.has(t.id))?.id ?? null,
      openIds: tasks.filter((t) => !t.merged_at && t.status !== 'aborted' && startedIds.has(t.id)).map((t) => t.id),
      maxOpen: maxOpenOf(db, p.id),
      egress: projectEgressOf(db, p.id),
      setupCommands: setupCommandsOf(db, p.id).map((a) => a.join(' ')),
      // 不填时自动识别出的那几条（按项目仓库当前的依赖清单）：页面上给人看"系统会替你跑什么"
      setupAuto: detectSetupCommands(p.repo).argvs.map((a) => a.join(' ')),
      abortedTasks: tasks.filter((t) => !t.merged_at && t.status === 'aborted').map((t) => t.id) };
  });
}

export function taskList(db) {
  return db.all(`SELECT * FROM tasks ORDER BY created_at DESC`).map((t) => ({
    ...t,
    counts: Object.fromEntries(db.all(`SELECT status, count(*) n FROM nodes WHERE task_id=? GROUP BY status`, t.id).map((r) => [r.status, r.n])),
    openQuestions: db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND status IN ('open','escalated')`, t.id).n,
    spendMicro: db.one(`SELECT COALESCE(SUM(micro_usd),0) m FROM usage_ledger WHERE task_id=?`, t.id).m,
    budgetMicro: limitOf(db, t.id, 'limit.budget_micro_usd'),
    unreadReports: db.one(`SELECT count(*) n FROM reports WHERE task_id=? AND read_at IS NULL`, t.id).n,
  }));
}

/** 任务详情。`userId` 给了就附 `can`：这个人对这个任务能做哪几类决策（按路由表 authorize 算，不看 role）。 */
export function taskDetail(db, taskId, { userId = null } = {}) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
  if (!task) return null;
  const can = userId ? Object.fromEntries(['budget', 'egress', 'signoff', 'delivery'].map((k) => [k, authorize(db, { taskId, decisionType: k, userId }).ok])) : null;
  const c = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);
  const rawNodes = db.all(`SELECT id,title,status,priority,risk_tier,model_tier,retry_count,started_at,finished_at,tier_escalated_at,spec,acceptance,created_at
                        FROM nodes WHERE task_id=? ORDER BY created_at, rowid`, taskId);
  const edges = db.all(`SELECT from_id, to_id FROM edges WHERE relation='depends_on' AND superseded_at IS NULL
                        AND from_id IN (SELECT id FROM nodes WHERE task_id=?)`, taskId);
  // "步骤 N"= 串行执行时的先后。推演规则与编排器挑就绪节点的一模一样（assemble.readyNodes）：
  // 依赖都完成的里面，优先级数值小的先，平手按规划器给的顺序（落库顺序）。编排器一次只做一步，所以只要没有失败 / 卡住，
  // 这个编号就是真实的执行次序。原来按 created_at,id 排 —— 同一次规划时间戳相同，实际按随机 id，最先执行的标成了"步骤 3"。
  const nodes = (() => {
    const deps = new Map(rawNodes.map((n) => [n.id, edges.filter((e) => e.from_id === n.id).map((e) => e.to_id)]));
    const idx = new Map(rawNodes.map((n, i) => [n.id, i]));
    const done = new Set(), out = [];
    while (out.length < rawNodes.length) {
      const ready = rawNodes.filter((n) => !done.has(n.id) && (deps.get(n.id) ?? []).every((d) => done.has(d) || !idx.has(d)));
      const pick = (ready.length ? ready : rawNodes.filter((n) => !done.has(n.id)))   // 成环兜底：照落库顺序接着排
        .sort((a, b) => (a.priority - b.priority) || (idx.get(a.id) - idx.get(b.id)))[0];
      done.add(pick.id); out.push(pick);
    }
    return out;
  })();

  const t = now();
  const names = Object.fromEntries(db.all(`SELECT id, display_name FROM users`).map((u) => [u.id, u.display_name]));
  const questions = db.all(`SELECT * FROM questions WHERE task_id=? ORDER BY asked_at DESC LIMIT 50`, taskId)
    .map((q) => ({ ...q, addressed_to: JSON.parse(q.addressed_to || '[]'), informed: JSON.parse(q.informed || '[]'),
      route: safeJson(q.route), decisionLabel: DECISION_TYPES[q.decision_type]?.label ?? null,
      ...(({ mustSign, selfExcluded }) => ({ mustSign: mustSign && { userId: mustSign, name: names[mustSign] ?? mustSign }, selfExcluded: selfExcluded && { userId: selfExcluded, name: names[selfExcluded] ?? selfExcluded } }))(voteRulesOf(db, q)),
      answers: answersOf(db, q.id).map((a) => ({ id: a.id, userId: a.user_id, name: a.user_id ? (names[a.user_id] ?? a.user_id) : '系统', body: a.body, stance: a.stance, agreesWith: a.agrees_with ?? null, at: a.created_at })),
      remainingMs: q.timeout_at && ['open', 'escalated'].includes(q.status) ? q.timeout_at - t : null,
      routeRemainingMs: q.route_due_at && ['open', 'escalated'].includes(q.status) ? q.route_due_at - t : null,
      briefing: db.one(`SELECT id, work_done, plan_after AS plan_after_answer FROM briefings WHERE question_id=? AND superseded_at IS NULL ORDER BY valid_from DESC LIMIT 1`, q.id) ?? null,
      answer: db.one(`SELECT m.body, m.trust_label, m.received_at FROM messages m JOIN edges e ON e.from_id=m.id AND e.to_id=? AND e.relation='answers' AND e.superseded_at IS NULL ORDER BY e.id DESC LIMIT 1`, q.id) ?? null }));
  // 方案批准类事项的判读："已决定"说不出系统把那句话读成了什么（曾出现过标着已决定、实际被当成要改）。
  // 读过的以状态机留下的 approval_read 为准；答了还没轮到状态机读的，用同一个函数先算给人看；开着的标可预览。
  { const readings = readingsOf(db, taskId);
    for (const q of questions) {
      if (q.decision_type !== 'contract_approval') continue;
      if (readings[q.id]) { q.reading = { ...readings[q.id], final: true }; continue; }
      const th = approvalThreadOf(db, q.id);
      if (!th) continue;
      if (['open', 'escalated'].includes(q.status)) q.interpretable = true;
      else if (q.answer) q.reading = { ...describeReading({ body: q.answer.body, labels: th.labels, reached: th.reached, lang: contentLang(db) }), final: false };
    } }
  const messages = db.all(`SELECT id,kind,kind_source,urgency,trust_label,body,received_at,consumed_at,sender_id FROM messages
                           WHERE task_id=? ORDER BY received_at DESC LIMIT 100`, taskId);
  // 被挡着的修正要在页面上说得出为什么没动 —— 否则人看到的是一条"待处理"放着不动。
  { const held = new Map(heldSteering(db, taskId).map((h) => [h.message.id, h]));
    for (const m of messages) { const h = held.get(m.id); if (h) m.held = { why: h.why, questionIds: h.questionIds ?? [] }; } }
  const decisions = db.all(`SELECT * FROM decisions WHERE task_id=? ORDER BY recorded_at DESC LIMIT 100`, taskId);
  const assumptions = db.all(`SELECT * FROM assumptions WHERE task_id=? ORDER BY recorded_at DESC LIMIT 200`, taskId);
  const audits = db.all(`SELECT id, ts, actor_kind, actor_id, action, target_type, target_id, payload FROM audit_log
                         WHERE target_id=? OR target_id IN (SELECT id FROM nodes WHERE task_id=?)
                            OR target_id IN (SELECT id FROM questions WHERE task_id=?)
                         ORDER BY id DESC LIMIT 200`, taskId, taskId, taskId)
    .map((a) => ({ ...a, payload: safeJson(a.payload) }));
  const reports = listReports(db, taskId, { all: true }).slice(0, 30);
  const rv = pendingRevision(db, taskId);
  let revision = null;
  if (rv) {
    const rev = { impact: JSON.parse(rv.impact), salvage: JSON.parse(rv.salvage), changed_nodes: JSON.parse(rv.changed_nodes),
      new_nodes: JSON.parse(rv.new_nodes), constitution_patch: rv.constitution_patch ? JSON.parse(rv.constitution_patch) : null, rationale: rv.rationale };
    let diff = '';
    try { diff = renderDiff(gateOf(db, { taskId, rev, nodes: nodesForReplan(db, taskId) }), rev); } catch (e) { diff = tl(contentLang(db), '（无法生成变更对比：{msg}）', { msg: e.message }); }
    revision = { id: rv.id, status: rv.status, gate: rv.gate, message: db.one(`SELECT body FROM messages WHERE id=?`, rv.message_id)?.body ?? '', diff, rationale: rv.rationale };
  }
  const limits = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, { label: LIMITS[k].label, value: limitOf(db, taskId, k), onHit: LIMITS[k].on_hit }]));
  const params = db.all(`SELECT key, value, layer, set_by_kind FROM params WHERE task_id=? AND superseded_at IS NULL ORDER BY key`, taskId);
  const spend = db.all(`SELECT role, count(*) n, SUM(micro_usd) m FROM usage_ledger WHERE task_id=? GROUP BY role`, taskId);
  const wsDir = join(process.env.SUPERINTERN_HOME ?? join(process.cwd(), '.superintern'), 'workspaces', taskId);
  const stage = getParam(db, taskId, 'draft.stage');
  const draft = stage ? { stage, idea: getParam(db, taskId, 'draft.idea'), source: getParam(db, taskId, 'draft.source'), title: getParam(db, taskId, 'draft.title'),
    verifyCommand: getParam(db, taskId, 'draft.verify_command'), notes: getParam(db, taskId, 'draft.notes'), approvalQuestion: getParam(db, taskId, 'draft.approval_question') } : null;
  const measured = Object.fromEntries(Object.keys(LIMITS).map((k) => { try { return [k, LIMITS[k].read(db, taskId, { startedAt: t })]; } catch { return [k, null]; } }));
  // 契约里已被判作废的条目。签收人对着契约原文看产物，看不到这一段就会以为执行器跑偏了。
  const overruled = overruledContractRules(db, taskId).map((d) => ({ statement: d.statement, by: d.by, at: d.at, viaQuestion: !!d.questionId, quote: d.quote }));
  return { task, draft, constitution: c ? { ...c, constraints: safeJson(c.constraints), overruled } : null, nodes, edges, questions, messages, decisions, assumptions,
    audits, reports, revision, limits, measured, params, spend, signoff: signoffOf(db, taskId), workspace: existsSync(wsDir) ? wsDir : null, preview: previewOf(db, taskId),
    spendMicro: spend.reduce((a, r) => a + r.m, 0), now: t, users: names, lead: leadOf(db, taskId), routingKey: routingKeyOf(db, taskId), can };
}
const safeJson = (s) => { try { return JSON.parse(s ?? 'null'); } catch { return s; } };
/** 最近一次"看运行效果"的结论。没有 si-preview.json 的任务从来没截过 → null。 */
export function previewOf(db, taskId) {
  const a = db.one(`SELECT action, ts, payload FROM audit_log WHERE target_id=? AND action IN ('preview_captured','preview_failed') ORDER BY id DESC LIMIT 1`, taskId);
  if (!a) return null;
  const p = safeJson(a.payload) ?? {};
  return { ok: a.action === 'preview_captured', at: a.ts, head: p.head ?? null, headKey: String(p.head ?? 'nohead').slice(0, 12),
    shots: Array.isArray(p.shots) ? p.shots.map((s) => ({ title: s.title, path: s.path, file: s.file, warnings: s.warnings ?? [] })) : [], why: p.why ?? null, log: p.log ?? null,
    warnings: p.warnings ?? [] };
}
/** 服务商表单：字段没给（undefined）= 保留现值；给空串 = 清成继承 / 无。 */
function pickEndpointFields(b) {
  const str = (v) => (v === undefined ? undefined : (v === '' || v === null ? null : String(v)));
  const base = str(b.baseUrl);
  return { id: String(b.id ?? '').trim().toLowerCase(), label: str(b.label), adapter: str(b.adapter), baseUrl: base ? base.replace(/\/+$/, '') : base, keyEnv: str(b.keyEnv)?.toUpperCase(),
    authHeader: str(b.authHeader), authPrefix: b.authPrefix === undefined ? undefined : (b.authPrefix === null ? null : String(b.authPrefix)), modelsPath: str(b.modelsPath),
    gateway: b.gateway === undefined ? undefined : !!b.gateway, billing: str(b.billing), enabled: b.enabled === undefined ? undefined : !!b.enabled };
}

/**
 * 注册表三层的视图：服务商（key 只报"填没填"）/ 模型（生效目录 + 能不能绑 + 上次漂移检查的发现）/ 绑定（三档 + 推理强度 + 问题）。
 * 全部按生效值现算，与代码默认值的差异标在行上。
 */
// lang：给人看的原因（不能分配的原因、绑定问题）用哪种语言写 —— 看板传请求人的界面语言
export function llmView(db, { env = process.env, lang = 'zh' } = {}) {
  const endpoints = endpointsOf(db);
  const keys = keyPresence(endpoints, env);
  const catalog = catalogOf(db);
  const b = bindingOf(db);
  const last = lastCatalogCheck(db);
  const findings = {};
  for (const l of last?.lines ?? []) { const i = l.indexOf('：'); if (i > 0) (findings[l.slice(0, i)] ??= []).push(l.slice(i + 1)); }
  return {
    endpoints: Object.values(endpoints).map((e) => ({ ...e, keyPresent: keys[e.id].present, diff: endpointDiff(e), adapterLabel: ADAPTER_DEFAULTS[e.adapter]?.label ?? e.adapter,
      models: Object.values(catalog).filter((m) => m.vendor === e.id).length, boundTiers: TIERS.filter((t) => catalog[b.binding[t]]?.vendor === e.id) })),
    models: Object.values(catalog).map((m) => ({ ...m, cannotBind: bindable(m, endpoints, lang), boundTiers: TIERS.filter((t) => b.binding[t] === m.key), findings: findings[m.key] ?? [],
      endpointEnabled: !!endpoints[m.vendor]?.enabled, keyPresent: !!keys[m.vendor]?.present })),
    binding: { ...b, problems: bindingProblems(db, { env, lang }) },
    adapters: ADAPTERS.map((a) => ({ id: a, ...ADAPTER_DEFAULTS[a] })), efforts: EFFORTS, tiers: TIERS,
    lastCheck: last ? { at: last.checkedAt ?? last.ts, warnings: last.warnings, fetchErrors: last.fetchErrors, probe: last.probe } : null,
  };
}

// ── 控制杆（写只经已有入口）────────────────────────────────────────────────
export function makeControls(db, { home, tokenPlain, launcher = makeLauncher(db, { home }), makeClassifierClient = null }) {
  // 身份按请求：带了自己的令牌就是自己，没带就是起看板那个人。
  const auth = (o = {}) => {
    const tok = o._token || tokenPlain;
    const a = authenticate(db, tok);
    if (!a) throw new Error(o._token ? '令牌无效或已吊销' : '看板的本机令牌无效或已吊销；请用命令行重新生成令牌后重启看板');
    return { plaintextToken: tok, userId: a.user_id };
  };
  const requireLead = (o, taskId) => { const { userId } = auth(o); if (userId !== leadOf(db, taskId)) throw new Error('只有该任务的负责人能执行此操作'); return userId; };

  // 分类器 client：测试可注入 fake（makeClassifierClient）；默认按库里的生效注册表建 live client（每次现读）。
  const newClassifierClient = makeClassifierClient
    ?? (() => new LlmClient({ mode: 'live', ...registryFor(db) }));
  return {
    // 答复落地之后再比对：比对不阻塞答复 —— 命中只是另外挂一条事项。
    // 附议 / 弃权不比对：它们不引入新说法。
    answer: async (o) => {
      const { userId, plaintextToken } = auth(o);
      const q = db.one(`SELECT task_id FROM questions WHERE id=?`, o.questionId);
      const r = recordAnswer(db, { questionId: o.questionId, body: o.body, stance: o.stance ?? 'answer',
        agreesWith: o.agreesWith ?? null, plaintextToken });
      if ((o.stance ?? 'answer') === 'answer' && q?.task_id) {
        await afterInput(db, { taskId: q.task_id, text: o.body, entry: 'answer', by: userId, makeClient: newClassifierClient, sourceId: r?.messageId ?? null });
      }
      // 方案批准的答复：回显系统怎么读这句话。判读本身仍由状态机做，这里用的是同一个函数。
      const th = (o.stance ?? 'answer') === 'answer' ? approvalThreadOf(db, o.questionId) : null;
      return th ? { ...r, reading: describeReading({ body: o.body, labels: th.labels, reached: th.reached, tense: 'did', lang: contentLang(db) }) } : r;
    },
    // 答之前的实时预览：只读，不落库。看不见这个任务的人拿不到（与任务详情同一道可见性）。
    interpret: (o) => {
      const { userId } = auth(o);
      if (!canSeeTask(db, o.taskId, userId)) throw new Error('任务不存在');
      const th = approvalThreadOf(db, o.questionId);
      if (!th || th.taskId !== o.taskId) return { reading: null };
      return { reading: describeReading({ body: String(o.body ?? ''), labels: th.labels, reached: th.reached, tense: 'will', lang: contentLang(db) }) };
    },
    transfer: (o) => transferQuestion(db, { questionId: o.questionId, to: [].concat(o.to ?? []), reason: o.reason ?? null, byUserId: auth(o).userId }),
    say: async (o) => {
      const { taskId, body, kind, urgent, about } = o;
      const hasKind = !!kind;
      // 已合并的项目任务：它不会再跑了，发给它的修正 / 新指令没有人接（否则消息被放行后就悬着，
      // 项目随即宣布达成，这条需求就丢了）。这种话就是一条新需求：
      // 转成项目的「添加任务」，记在说话的人名下（与项目页入口同一条路，权限也一样查）。
      const tk = db.one(`SELECT project_id, project_order, merged_at FROM tasks WHERE id=?`, taskId);
      const merged = !!(tk?.project_id && tk.project_order > 0 && tk.merged_at);
      if (merged && ['correction', 'instruction'].includes(kind)) {
        return { kind, appended: true, append: requestAppend(db, { projectId: tk.project_id, userId: auth(o).userId, brief: body }) };
      }
      const out = await sayWithClassifier(db, {
        taskId, body,
        kind: hasKind ? kind : null,
        urgency: urgent ? 'urgent' : 'normal',
        aboutQuestionId: about || null,
        plaintextToken: auth(o).plaintextToken,
        holdForCheck: true,   // 下面要比对，比对完之前别让守护进程拉走
        ...(hasKind ? {} : { llmClient: newClassifierClient() }),
      });
      if (merged && ['correction', 'instruction'].includes(out.kind)) {
        markConsumed(db, { taskId, ids: [out.messageId], why: tl(contentLang(db), '任务已合并：这句话转成了项目的「添加任务」') });
        try { return { ...out, appended: true, append: requestAppend(db, { projectId: tk.project_id, userId: auth(o).userId, brief: body }) }; }
        catch (e) { return { ...out, appended: false, appendError: tl(o._lang, '这个任务已经合并，改不了了；这句话读着像新需求，但没能转成「添加任务」：{msg}', { msg: translateError(e, o._lang) }) }; }
      }
      // 变更消息落地之后再比对：只比 correction / instruction —— 补充信息不改变要做什么。
      if (['correction', 'instruction'].includes(out.kind)) {
        await afterInput(db, { taskId, text: body, entry: 'revision', by: auth(o).userId, makeClient: newClassifierClient, sourceId: out.messageId });
      }
      // answer 场景：分类器判为"这是在回答某个开着的问题"，不入库也不自动答复。
      // 返回 questionId 与原文，供看板渲染"转为答复"按钮（走既有 answer 控制杆，签当前用户名）。
      return out.kind === 'answer' ? { ...out, body } : out;
    },
    revision: (o) => {
      const { taskId, approve, why, reservation } = o;
      const userId = requireLead(o, taskId);
      const rv = pendingRevision(db, taskId);
      if (!rv) throw new Error('没有待处理的计划变更');
      // 有批准事项开着：卡片按钮 = 负责人在那条事项上答一次（配了会签就只算一票，够数才生效 —— 否则
      // 卡片一点就生效，绕过了其他会签人；事项还挂着等他再答一遍）
      const rq = rv.question_id ? db.one(`SELECT status FROM questions WHERE id=?`, rv.question_id) : null;
      if (rq && ['open', 'escalated'].includes(rq.status)) {
        const L = contentLang(db);
        const body = approve ? (reservation ? tl(L, 'A\n保留：{reservation}', { reservation }) : 'A') : tl(L, 'B：{why}', { why: why || tl(L, '在看板上驳回（未填理由）') });
        const r = recordAnswer(db, { questionId: rv.question_id, body, plaintextToken: auth(o).plaintextToken });
        return { ...r, viaQuestion: true, pending: !r.resolved };
      }
      return approve ? applyRevision(db, { taskId, revisionId: rv.id, by: 'user', userId, reservation: reservation ?? null })
        : rejectRevision(db, { taskId, revisionId: rv.id, userId, why: why || tl(contentLang(db), '在看板上驳回（未填理由）') });
    },
    limit: (o) => setLimit(db, { taskId: o.taskId, key: o.key, value: Number(o.value), userId: auth(o).userId }),
    priority: (o) => {
      const { taskId, nodeId, priority } = o;
      const userId = requireLead(o, taskId);
      const p = Number(priority);
      if (!Number.isFinite(p)) throw new Error('优先级必须是数字');
      const n = db.one(`SELECT id, priority, status FROM nodes WHERE id=? AND task_id=?`, nodeId, taskId);
      if (!n) throw new I18nError('步骤不存在：{nodeId}', { nodeId });
      if (!['pending', 'ready', 'blocked'].includes(n.status)) throw new I18nError('步骤状态为 {status}，只能调整尚未开始的步骤', { status: n.status });
      db.run(`UPDATE nodes SET priority=? WHERE id=?`, p, nodeId);
      audit(db, { actorKind: 'user', actorId: userId, action: 'node_priority_set', targetType: 'node', targetId: nodeId, payload: { from: n.priority, to: p } });
      return { nodeId, priority: p };
    },
    // 暂停 / 恢复 / 中止：任务状态直改，编排器每轮开头读状态，suspended 就退出、aborted 就退出。
    // 都记审计 —— 这三个是人对任务最重的三个动作。
    pause: (o) => setTaskStatus(db, o.taskId, 'suspended', ['running', 'waiting'], requireLead(o, o.taskId), 'task_paused'),
    resume: (o) => {
      const stillOpen = db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND status IN ('open','escalated')`, o.taskId).n;
      return setTaskStatus(db, o.taskId, stillOpen ? 'waiting' : 'running', ['suspended'], requireLead(o, o.taskId), 'task_resumed');
    },
    abort: (o) => setTaskStatus(db, o.taskId, 'aborted', ['planning', 'running', 'waiting', 'suspended'], requireLead(o, o.taskId), 'task_aborted', { why: o.why }),
    // 中止可反悔；改标题 / 归档只碰元数据。权限在 lifecycle.mjs 里判（任务负责人）。
    reopen: (o) => reopenTask(db, { taskId: o.taskId, userId: auth(o).userId }),
    rename: (o) => renameTask(db, { taskId: o.taskId, title: o.title, userId: auth(o).userId }),
    archive: (o) => setTaskArchived(db, { taskId: o.taskId, archived: o.archived !== false, userId: auth(o).userId }),
    signoff: (o) => signOff(db, { taskId: o.taskId, accept: !!o.accept, reason: o.reason, ...auth(o) }),
    deliver: (o) => {
      const { taskId, remote, pr, base } = o;
      const { userId } = auth(o);
      const ws = join(home, 'workspaces', taskId);
      if (!existsSync(ws)) throw new Error('任务工作区不存在，无法交付');
      return deliverTask(db, { taskId, workspace: ws, remote: remote || null, pr: !!pr, base: base || null, userId });
    },
    reportsRead: (o) => { auth(o); markReportsRead(db, o.ids); return { ok: true }; },
    // 起编排器子进程（经共用的启动器：守护进程起的和人按的在同一张表里，不会撞车）。
    // 手动"运行"按任务所处阶段拉对应的步骤：从想法起的任务先澄清（draft）、有契约没步骤的先规划（plan）、否则执行（run）。
    // 此前一律拉 run，自动运行关着时对还在澄清 / 规划阶段的任务是拉错了阶段。
    run: (o) => {
      const actorId = requireLead(o, o.taskId);
      const task = db.one(`SELECT id, status FROM tasks WHERE id=?`, o.taskId);
      const verb = (task && assessTask(db, task, { hasWorkspace: (id) => existsSync(join(home, 'workspaces', id)) }).verb) || 'run';
      return launcher.launch(o.taskId, { verb, iterations: o.iterations, actorKind: 'user', actorId, action: 'run_launched_from_web' });
    },
    // 身份与角色：页面据此决定显示哪些控制杆；真正的权限检查在各写入口。
    me: (o) => { const { userId } = auth(o); const u = db.one(`SELECT id, display_name, role FROM users WHERE id=?`, userId); return { ...u, viaOwnToken: !!o._token }; },
    running: (taskId) => launcher.running(taskId),
    logTail: ({ taskId, lines = 80 }) => launcher.logTail({ taskId, lines }),
  };
}

function setTaskStatus(db, taskId, to, from, userId, action, extra = {}) {
  const task = db.one(`SELECT status FROM tasks WHERE id=?`, taskId);
  if (!task) throw new I18nError('任务不存在：{taskId}', { taskId });
  const verb = { task_paused: '暂停', task_resumed: '恢复', task_aborted: '中止' }[action] ?? action;
  const status = task.status;
  const cannot = { task_paused: () => new I18nError('任务状态为 {status}，无法暂停', { status }), task_resumed: () => new I18nError('任务状态为 {status}，无法恢复', { status }),
    task_aborted: () => new I18nError('任务状态为 {status}，无法中止', { status }) }[action] ?? (() => new Error(`任务状态为 ${status}，无法${verb}`));
  if (!from.includes(task.status)) throw cannot();
  db.run(`UPDATE tasks SET status=? WHERE id=?`, to, taskId);
  audit(db, { actorKind: 'user', actorId: userId, action, targetType: 'task', targetId: taskId, payload: { from: task.status, to, ...extra } });
  return { from: task.status, to };
}

// ── 服务器 ─────────────────────────────────────────────────────────────────
/**
 * 团队模式：多人各自从自己的电脑访问，看板在内网服务器上、HTTPS 反向代理之后。
 * 与本机单人模式只差三件事，其余一行不变：
 *   1. **没有兜底身份**。本机模式下不带令牌 = 起看板的人（负责人流程靠它）；团队模式下那等于把负责人让给任何
 *      摸得到这个地址的人。所以 /api/* 在路由之前统一过一道：没有有效身份就 401（登录接口本身除外）。
 *      只在路由里判不够：很多读接口把"令牌无效"当匿名处理（who=null），而"所有人可见"的项目对匿名是可见的。
 *   2. **登录 = 贴一次管理员发的令牌 → 服务端种 HttpOnly cookie**（SameSite=Strict；对外地址是 https 就加 Secure）。
 *      令牌不再放在页面脚本读得到的 localStorage 里。服务端认证照旧按令牌 —— 答复、消息的认证链（token_id）一处不改。
 *   3. **Host 放行对外地址**（--public-url 的主机名）。反向代理要原样转 Host（nginx：proxy_set_header Host $host）。
 */
export const TEAM_OPEN_PATHS = new Set(['/api/login', '/api/logout', '/api/session', '/api/i18n']);
export function startWeb(db, { home, port = 7357, host = '127.0.0.1', tokenPlain, launcher, daemon = false, pollMs = 1000, makeClassifierClient = null, envFile = null, env = process.env, fetchFn = globalThis.fetch, team = false, publicUrl = null, runtime = undefined } = {}) {
  ensureOwner(db);
  // 容器运行时健康：测试可注入；不给就真探（起看板时先探一次，之后按 30 秒缓存在后台刷新）
  const runtimeHealth = runtime === undefined ? makeRuntimeHealth({ lang: () => contentLang(db) }) : runtime;
  runtimeHealth?.current?.();
  let pub = null;
  if (team) {
    try { pub = new URL(publicUrl); } catch { throw new Error('团队模式要给对外地址：--public-url https://看板的内网域名'); }
  }
  const secureCookie = pub?.protocol === 'https:';
  // 请求身份的兜底：本机模式 = 起看板的人；团队模式 = 没有
  const fallbackToken = team ? null : tokenPlain;
  const controls = makeControls(db, { home, tokenPlain: fallbackToken, makeClassifierClient, ...(launcher ? { launcher } : {}) });
  // 登录失败限速（按来源地址）：令牌是高熵随机串，爆破本来就不现实；这道闸主要是别让人把认证当压测打
  const loginFails = new Map();
  const LOGIN_WINDOW_MS = 10 * 60_000, LOGIN_MAX_FAILS = 20;
  // 轻档 client（决定比对用）：测试可注入 fake，默认按库里的生效注册表现建。
  const newLightClient = makeClassifierClient ?? (() => new LlmClient({ mode: 'live', ...registryFor(db) }));
  const html = readFileSync(join(HERE, 'index.html'), 'utf8');
  const clients = new Set();
  let lastAuditId = db.one(`SELECT COALESCE(MAX(id),0) m FROM audit_log`).m;
  const ticker = setInterval(() => {
    const m = db.one(`SELECT COALESCE(MAX(id),0) m FROM audit_log`).m;
    if (m !== lastAuditId) {
      const rows = db.all(`SELECT id, ts, action, target_type, target_id FROM audit_log WHERE id>? ORDER BY id`, lastAuditId);
      lastAuditId = m;
      const payload = `event: change\ndata: ${JSON.stringify({ rows })}\n\n`;
      for (const c of clients) c.write(payload);
    } else {
      for (const c of clients) c.write(': ping\n\n');
    }
  }, pollMs);

  const tokenOf = (req) => {
    const h = req.headers['x-superintern-token'];
    if (h) return String(h).trim();
    const m = /(?:^|;\s*)si_token=([^;]+)/.exec(req.headers.cookie ?? '');
    return m ? decodeURIComponent(m[1]) : null;
  };
  const identity = (req) => { const t = tokenOf(req) || fallbackToken; const a = authenticate(db, t); if (!a) throw new Error('令牌无效或已吊销'); return { userId: a.user_id, role: db.one(`SELECT role FROM users WHERE id=?`, a.user_id)?.role, token: t }; };
  // 页面用哪种语言出：浏览器上选过的（cookie si_lang）→ 登录的人自己的 → 部署的内容语言
  const pageLang = (req) => {
    const c = /(?:^|;\s*)si_lang=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (normLang(c)) return normLang(c);
    const a = authenticate(db, tokenOf(req) || fallbackToken);
    return a ? userLang(db, a.user_id) : contentLang(db);
  };
  const cookie = (value, maxAge) => `si_token=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;
    res.__lang = normLang(req.headers['x-si-lang']) ?? contentLang(db);
    const xs = crossSiteReason(req, { host, allowHosts: pub ? [pub.hostname] : [] });
    if (xs) { req.resume(); return json(res, 403, { error: xs }); }
    // 团队模式的总闸：路由之前，/api/* 一律要有效身份
    if (team && p.startsWith('/api/') && !TEAM_OPEN_PATHS.has(p) && !authenticate(db, tokenOf(req))) {
      req.resume(); return json(res, 401, { error: '请先登录', login: true });
    }
    try {
      // 不许被别的页面嵌进 iframe（点击劫持：团队模式下页面对内网可见，别的站可以把它叠在一个诱饵按钮下面）
      if (req.method === 'GET' && p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }); return res.end(localizeHtml(html, pageLang(req))); }
      if (req.method === 'GET' && p === '/api/session') {
        const a = authenticate(db, tokenOf(req) || fallbackToken);
        // 没登录的新人得知道去找谁要令牌（只写"找本看板的管理员"不够：管理员是谁页面上没有）。只给管理员的显示名，别的一概不给。
        const admins = team && !a ? db.all(`SELECT display_name FROM users WHERE role='lead' AND disabled_at IS NULL ORDER BY created_at`).map((u) => u.display_name) : undefined;
        return json(res, 200, { team, loggedIn: !!a, admins });
      }
      if (req.method === 'POST' && p === '/api/login') {
        if (!team) return json(res, 404, { error: '本机模式不用登录；换身份用「切换身份」' });
        // 限速按来源地址。反向代理和看板在同一台机器上时，socket 地址永远是本机 —— 那样所有人共用一个桶，
        // 任何一个人连错 20 次就把全员锁 10 分钟。所以从本机代理来的请求取 X-Forwarded-For 的最后一段（代理自己追加的那段，客户端伪造不了）。
        const remote = req.socket.remoteAddress ?? '?';
        const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        const ip = /^(127\.|::1$|::ffff:127\.)/.test(remote) && xff.length ? xff[xff.length - 1] : remote;
        const t0 = Date.now();
        const f = loginFails.get(ip);
        if (f && f.until > t0 && f.n >= LOGIN_MAX_FAILS) { req.resume(); return json(res, 429, { error: '这台电脑登录失败次数太多，请 10 分钟后再试' }); }
        const body = await readBody(req);
        const tok = String(body.token ?? '').trim();
        const a = tok ? authenticate(db, tok) : null;
        if (!a) {
          const cur = f && f.until > t0 ? f : { n: 0, until: t0 + LOGIN_WINDOW_MS };
          cur.n++; loginFails.set(ip, cur);
          return json(res, 401, { error: '令牌不对，或已被吊销。令牌由管理员在「设置 → 成员」里发给你' });
        }
        loginFails.delete(ip);
        audit(db, { actorKind: 'user', actorId: a.user_id, action: 'user_login', targetType: 'user', targetId: a.user_id, payload: { ip } });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie(tok, 30 * 86400) });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === 'POST' && p === '/api/logout') {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie('', 0) });
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify({ lastAuditId })}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && p === '/api/tasks') {
        // "与我有关"：我负责的，或有开放事项指到我 / 知会我的。纯查询，不落任何状态；侧栏的筛选用它。
        let who = null; try { who = identity(req).userId; } catch { /* 无效令牌：列表照给，mine 全 false */ }
        const touching = new Set();
        if (who) for (const q of db.all(`SELECT task_id, addressed_to, informed FROM questions WHERE status IN ('open','escalated')`)) {
          if (JSON.parse(q.addressed_to || '[]').includes(who) || JSON.parse(q.informed || '[]').includes(who)) touching.add(q.task_id);
        }
        // 可见性：'members' 的项目及其任务，只给管理员与 involvedIn 的人；旧的独立任务一律可见。
        const projs = projectList(db, res.__lang).filter((pj) => canSeeProject(db, pj.id, who))
          .map((pj) => ({ ...pj, mine: involvedIn(db, pj.id, who), canAdd: canAddTasks(db, pj.id, who) }));
        const seen = new Set(projs.map((pj) => pj.id));
        const mineProj = new Set(projs.filter((pj) => pj.mine).map((pj) => pj.id));
        const tasks = taskList(db).filter((t) => !t.project_id || seen.has(t.project_id))
          .map((t) => ({ ...t, mine: !!who && (t.project_id ? mineProj.has(t.project_id) : (leadOf(db, t.id) === who || touching.has(t.id))) }));
        return json(res, 200, { tasks, projects: projs, limits: Object.keys(LIMITS), daemon: daemon || daemonStatus(home).alive, daemonInfo: { ...daemonStatus(home), inProcess: !!daemon },
          // 容器运行时：上一次探测的结论（null = 还没探过）；不等探测，页面不会被卡住
          runtime: runtimeHealth ? runtimeHealth.current() : null });
      }
      if (req.method === 'GET' && p === '/api/repos') return json(res, 200, { repos: knownRepos(db) });
      if (req.method === 'GET' && p === '/api/me') { const me = controls.me({ _token: tokenOf(req) }); return json(res, 200, { ...me, canCreate: canCreate(db, me.id).ok, users: listUsers(db), lang: userLang(db, me.id), ownLang: db.one(`SELECT lang FROM users WHERE id=?`, me.id)?.lang ?? null, contentLang: contentLang(db) }); }
      // 界面语言（0.2.0）：词表公开（登录页也要用，里面没有秘密）；每人改自己的界面语言，null = 跟随部署的内容语言
      if (req.method === 'GET' && p === '/api/i18n') { const l = normLang(url.searchParams.get('lang')) ?? res.__lang; return json(res, 200, { lang: l, catalog: CATALOGS[l] ?? {} }); }
      if (req.method === 'POST' && p === '/api/me/lang') {
        const me = identity(req); const body = await readBody(req);
        const l = body.lang == null || body.lang === '' ? null : normLang(body.lang);
        if (body.lang != null && body.lang !== '' && !l) return json(res, 400, { error: new I18nError('不认识的语言：{lang}', { lang: body.lang }) });
        db.run(`UPDATE users SET lang=? WHERE id=?`, l, me.userId);
        return json(res, 200, { ok: true, lang: userLang(db, me.userId), ownLang: l });
      }
      // 待决事项打包摘要（A6）：按请求身份现算，跨任务。旁观者也能调，结果是空的（解析器不把旁观者放进收件人）。
      if (req.method === 'GET' && p === '/api/digest') { const me = identity(req); const d = buildDigest(db, { userId: me.userId, daemonAlive: daemon || daemonStatus(home).alive }); return json(res, 200, { ...d, text: renderDigest(d) }); }
      // ── 角色与路由。读：所有人；写：负责人。 ──
      if (req.method === 'GET' && p === '/api/routing') {
        const key = url.searchParams.get('project') || '';
        const rules = rulesOf(db, key);
        const prof = profileOf(db, key);
        return json(res, 200, { key, template: prof.template ?? 'solo', persisted: !!prof.updated_at, bindings: safeJson(prof.bindings) ?? {}, rows: rules, knobs: knobsOf(db, key), diff: diffFromTemplate(db, key),
          templates: Object.fromEntries(Object.entries(loadTemplates()).map(([k, t]) => [k, { label: t.label, summary: t.summary, placeholders: t.placeholders ?? {}, mask: t.mask }])),
          types: Object.fromEntries(Object.entries(DECISION_TYPES).map(([k, t]) => [k, { label: t.label, desc: t.desc, level3: t.level3 }])),
          users: listUsers(db), duty: dutyCalendarOf(db, key), lead: leadOfKey(db, key), preview: previewRouting(db, { key, rules }) });
      }
      if (req.method === 'POST' && p === '/api/routing') {
        const body = await readBody(req);
        const me = identity(req);
        const key = body.project || '';
        // 项目的表：该项目的负责人；默认表（不属于项目的任务共用）：任何一个负责人 —— 按项目交接后负责人不止一个。
        if (key ? me.userId !== leadOfKey(db, key) : me.role !== 'lead') return json(res, 403, { error: key ? '只有该项目的负责人能修改其决策路由' : '只有管理员能修改默认决策路由' });
        let result;
        if (body.action === 'template') result = applyTemplate(db, { key, name: body.name, bindings: body.bindings ?? {}, userId: me.userId, lang: res.__lang });
        else if (body.action === 'rows') result = saveRules(db, { key, rules: body.rows, template: body.template ?? profileOf(db, key).template, bindings: body.bindings ?? safeJson(profileOf(db, key).bindings) ?? {}, userId: me.userId, lang: res.__lang });
        else if (body.action === 'validate') result = { errors: validateRules(db, key, body.rows, { lang: res.__lang }) };
        else if (body.action === 'owner') result = setKnobs(db, { key, ownership: { [body.type]: [].concat(body.recipients ?? []) }, userId: me.userId, lang: res.__lang });
        else if (body.action === 'remove') result = setKnobs(db, { key, removeInterveners: [body.userId], userId: me.userId, lang: res.__lang });
        else if (body.action === 'duty') { setDutyCalendar(db, { key, users: body.users, startAt: Number(body.startAt), periodDays: Number(body.periodDays ?? 7), userId: me.userId }); result = dutyCalendarOf(db, key); }
        else if (body.action === 'preview') result = previewRouting(db, { key, rules: body.rows ?? rulesOf(db, key) });
        else return json(res, 400, { error: new I18nError('不支持的操作：{action}', { action: body.action }) });
        return json(res, 200, { ok: true, result });
      }
      // ── 注册表三层：服务商 / 模型 / 绑定。读：所有人（key 只报填没填）；写：负责人。凭证只写 .env，不进库不回显。 ──
      // ── 联网目录：读所有人；写只有管理员（addSource / removeSource 自己也查） ──
      if (req.method === 'GET' && p === '/api/egress/sources') {
        const defaults = getSetting(db, 'deploy.egress_defaults') ?? [];
        return json(res, 200, { sources: egressSources(db).map((x) => ({ ...x, usedBy: sourceUsage(db, x.id), isDefault: defaults.includes(x.id) })) });
      }
      if (req.method === 'POST' && p === '/api/egress/sources') {
        const body = await readBody(req);
        const me = identity(req);
        try {
          // 「新项目默认放行」—— 部署级设置，只有管理员能改（与往目录里加源同一个理由）
          if (body.action === 'default') {
            if (me.role !== 'lead') return json(res, 403, { error: '只有管理员能设新项目默认放行哪些源' });
            if (!egressSources(db).some((x) => x.id === body.id)) return json(res, 400, { error: new I18nError('联网目录里没有：{id}', { id: body.id }) });
            const cur = new Set(getSetting(db, 'deploy.egress_defaults') ?? []);
            if (body.on) cur.add(body.id); else cur.delete(body.id);
            return json(res, 200, { ok: true, result: setSetting(db, { key: 'deploy.egress_defaults', value: [...cur], userId: me.userId }) });
          }
          const r = body.action === 'remove' ? removeSource(db, { id: body.id, userId: me.userId })
            : addSource(db, { name: body.name, kind: body.kind, hosts: body.hosts, readOnly: body.readOnly ?? null, toolEnv: body.toolEnv ?? {}, note: body.note ?? '', userId: me.userId });
          return json(res, 200, { ok: true, result: r });
        } catch (e) { return json(res, 400, { error: e }); }
      }
      // 交付凭证：原来只能在服务器上改 .env。与模型 key 同一条规矩：只报"填没填"、写 .env、不进库、不回显。
      if (p === '/api/secrets') {
        const me = identity(req);
        if (me.role !== 'lead') return json(res, 403, { error: '只有管理员能看、能改交付凭证' });
        if (req.method === 'GET') return json(res, 200, { GITHUB_TOKEN: !!env.GITHUB_TOKEN });
        if (req.method === 'POST') {
          const body = await readBody(req);
          if (body.name !== 'GITHUB_TOKEN') return json(res, 400, { error: '只能设 GITHUB_TOKEN' });
          if (!envFile) return json(res, 400, { error: '看板启动时未指定 .env 文件，无法保存' });
          const r = setEnvVar(envFile, 'GITHUB_TOKEN', String(body.value ?? '').trim(), { env });
          audit(db, { actorKind: 'user', actorId: me.userId, action: 'secret_set', targetType: 'secret', targetId: 'GITHUB_TOKEN', payload: { present: r.present } });
          return json(res, 200, { ok: true, result: { GITHUB_TOKEN: r.present } });
        }
      }
      if (req.method === 'GET' && p === '/api/llm') return json(res, 200, llmView(db, { env, lang: res.__lang }));
      if (req.method === 'POST' && p === '/api/llm') {
        const body = await readBody(req);
        const me = identity(req);
        if (me.role !== 'lead') return json(res, 403, { error: '只有管理员能修改服务商、模型与模型分配' });
        const userId = me.userId;
        let result;
        if (body.action === 'endpoint_save') result = saveEndpoint(db, { ...pickEndpointFields(body), userId });
        else if (body.action === 'endpoint_enable') result = setEndpointEnabled(db, { id: body.id, enabled: !!body.enabled, userId });
        else if (body.action === 'endpoint_remove') result = removeEndpoint(db, { id: body.id, userId });
        else if (body.action === 'endpoint_test') result = await testEndpoint(db, { id: body.id, model: body.model || null, env, fetchFn, lang: res.__lang });
        else if (body.action === 'endpoint_models') {
          const e = endpointsOf(db)[body.id];
          if (!e) return json(res, 400, { error: new I18nError('服务商不存在：{id}', { id: body.id }) });
          const r = await listEndpointModels(e, { env, fetchFn, lang: res.__lang });
          const cat = catalogOf(db);
          result = { ...r, rows: r.rows.map((m) => ({ ...m, key: `${e.id}/${m.id}`, inCatalog: !!cat[`${e.id}/${m.id}`] })) };
        } else if (body.action === 'key_set') {
          // 值只经这里写进 .env（600），不进库、不进审计正文、不回显；审计只记变量名。
          const e = endpointsOf(db)[body.id];
          if (!e) return json(res, 400, { error: new I18nError('服务商不存在：{id}', { id: body.id }) });
          if (!envFile) return json(res, 400, { error: '看板启动时未指定 .env 文件，无法保存 API 密钥' });
          const r = setEnvVar(envFile, e.keyEnv, String(body.value ?? ''), { env });
          audit(db, { actorKind: 'user', actorId: userId, action: 'key_set', targetType: 'endpoint', targetId: e.id, payload: { keyEnv: e.keyEnv, present: r.present } });
          result = { keyEnv: e.keyEnv, present: r.present };
        }
        else if (body.action === 'model_save') result = saveModel(db, { key: body.key, fields: body.fields ?? {}, origin: body.origin === 'listed' ? 'listed' : 'user', userId });
        else if (body.action === 'model_remove') result = removeModel(db, { key: body.key, userId });
        else if (body.action === 'bind_set') result = setBinding(db, { tier: body.tier, modelKey: body.key, effort: body.effort === undefined ? undefined : (body.effort || null), userId });
        else if (body.action === 'catalog_check') {
          const reg = checkableCatalog(db);
          const r = await checkCatalog({ catalog: reg.catalog, vendors: reg.vendors, env, fetchFn, probe: !!body.probe, only: body.vendor || null, lang: contentLang(db) });
          recordCatalogCheck(db, r, { by: userId, actorKind: 'user', lang: contentLang(db) });
          result = { warnings: r.warnings, fetchErrors: r.fetchErrors, keys: r.keys };
        }
        else return json(res, 400, { error: new I18nError('不支持的操作：{action}', { action: body.action }) });
        return json(res, 200, { ok: true, result, view: llmView(db, { env, lang: res.__lang }) });
      }
      // ── 成员。读：所有人（没有令牌明文与通道地址）；写：负责人，本人可以管自己的通道与令牌。 ──
      const usersPayload = (me) => ({ users: usersView(db), settings: settingsView(db), local: authenticate(db, tokenPlain)?.user_id ?? null,
        requests: listHandoverRequests(db, { status: 'open' }).map((r) => ({ ...r, canDecide: canDecideHandover(db, { byUserId: me.userId, scope: r.scope }) })).filter((r) => r.canDecide || r.fromUserId === me.userId).map((r) => {
          try { const pv = previewHandover(db, { fromUserId: r.fromUserId, toUserId: r.toUserId, scope: r.scope, thenDisable: r.thenDisable, byUserId: me.userId }); return { ...r, text: renderHandover(pv, res.__lang), needsQuorumConfirm: !!pv.needsQuorumConfirm }; }
          catch (e) { return { ...r, text: null, error: translateError(e, res.__lang) }; }
        }) });
      if (req.method === 'GET' && p === '/api/users') return json(res, 200, usersPayload(identity(req)));
      // 权限一览（只读）：所有成员都能看任何人的 —— 与"所有成员可读全部项目"同一条边界。
      if (req.method === 'GET' && p === '/api/permissions') { const me = identity(req); return json(res, 200, permissionsOf(db, url.searchParams.get('user') || me.userId)); }
      if (req.method === 'POST' && p === '/api/users') {
        const body = await readBody(req);
        const me = identity(req);
        const self = body.userId && body.userId === me.userId;
        const selfOk = ['channel_set', 'channel_remove', 'token'].includes(body.action) || (!body.action && body.channel);
        if (me.role !== 'lead' && !(self && selfOk)) return json(res, 403, { error: '只有管理员能管理成员；成员本人只能修改自己的通知通道与令牌' });
        const by = { userId: body.userId, byUserId: me.userId };
        let result = null;
        if (!body.action && body.channel) setUserChannel(db, { ...by, kind: body.channel, target: body.target });
        else if (!body.action || body.action === 'add') result = addUser(db, { name: body.name, role: body.role, tags: body.tags ?? [], byUserId: me.userId });   // 令牌明文只在这一次响应里出现，库里只有哈希
        else if (body.action === 'rename') result = renameUser(db, { ...by, name: body.name });
        else if (body.action === 'role') result = setUserRole(db, { ...by, role: body.role });
        else if (body.action === 'tags') setUserTags(db, { ...by, tags: body.tags ?? [] });
        else if (body.action === 'channel_set') setUserChannel(db, { ...by, kind: body.kind, target: body.target });
        else if (body.action === 'channel_remove') result = removeUserChannel(db, { ...by, kind: body.kind });
        else if (body.action === 'token') {
          // 看板不带令牌时的身份就是本机令牌文件；在这里重发它会让看板和守护进程一起失去身份。CLI 会同步改写令牌文件。
          if (body.userId === authenticate(db, tokenPlain)?.user_id) return json(res, 400, { error: '不能在看板中重新生成本机身份的令牌。请运行 node src/cli.mjs user token <id>，然后重启看板与守护进程' });
          result = reissueToken(db, by);                                                      // 明文同样只出现这一次
        }
        else if (body.action === 'disable') { try { result = disableUser(db, by); } catch (e) { return json(res, 400, { error: e, needsHandover: !!e.needsHandover }); } }
        else if (body.action === 'enable') result = enableUser(db, by);
        else if (body.action === 'setting') result = setSetting(db, { key: body.key, value: body.value, userId: me.userId });
        else return json(res, 400, { error: new I18nError('不支持的操作：{action}', { action: body.action }) });
        return json(res, 200, { ok: true, result, ...usersPayload(me) });
      }
      // 交接：预览（真做一遍再回滚）/ 执行或批准（管理员；项目范围另加该项目负责人）/ 申请（其余人，只能交自己的）/ 撤回（申请人）。权限在 handover.mjs 里判。
      if (req.method === 'POST' && p === '/api/handover') {
        const body = await readBody(req);
        const me = identity(req);
        const o = { fromUserId: body.from || me.userId, toUserId: body.to, scope: body.scope, note: body.note || null, thenDisable: !!body.thenDisable, byUserId: me.userId };
        let result;
        if (body.action === 'preview') result = { changes: previewHandover(db, o) };
        else if (body.action === 'run') {
          if (canDecideHandover(db, { byUserId: me.userId, scope: o.scope })) result = { changes: executeHandover(db, { ...o, allowQuorumDrop: !!body.allowQuorumDrop }) };
          else { const r = requestHandover(db, o); result = { requestId: r.requestId, changes: r.preview, requested: true }; }
        }
        else if (['approve', 'reject', 'withdraw'].includes(body.action)) { const r = decideHandoverRequest(db, { requestId: body.requestId, decision: body.action, byUserId: me.userId, note: body.note || null, allowQuorumDrop: !!body.allowQuorumDrop }); result = { status: r.status, changes: r.changes }; }
        else return json(res, 400, { error: new I18nError('不支持的操作：{action}', { action: body.action }) });
        if (result.changes) result.text = renderHandover(result.changes, res.__lang);
        if (result.changes && !result.requested && body.action !== 'preview') result.notified = (await sendHandoverNotice(db, { changes: result.changes, env, fetchFn })).sent;
        return json(res, 200, { ok: true, result, ...usersPayload(me) });
      }
      const qm = p.match(/^\/api\/questions\/([^/]+)\/transfer$/);
      if (qm && req.method === 'POST') { const body = await readBody(req); return json(res, 200, { ok: true, result: controls.transfer({ questionId: qm[1], to: body.to, reason: body.reason, _token: tokenOf(req) }) }); }
      // 决定登记：按需拉，不塞进项目列表 —— 列表每次刷新都要走，清单长了不该跟着走一遍。
      const dm = p.match(/^\/api\/projects\/([^/]+)\/decisions$/);
      if (dm && req.method === 'GET') {
        let who = null; try { who = identity(req).userId; } catch { /* 同上 */ }
        if (!canSeeProject(db, dm[1], who)) return json(res, 404, { error: '项目不存在' });
        const active = activeDecisions(db, { projectId: dm[1] });
        const voided = db.all(`SELECT * FROM decision_registry WHERE project_id=? AND status='void' ORDER BY decided_at DESC LIMIT 50`, dm[1])
          .map((d) => ({ ...d, scope: JSON.parse(d.scope || '[]') }));
        const names = Object.fromEntries(db.all(`SELECT id, display_name FROM users`).map((u) => [u.id, u.display_name]));
        const titles = Object.fromEntries(db.all(`SELECT id, title FROM tasks WHERE project_id=?`, dm[1]).map((t) => [t.id, t.title]));
        // 带上来源任务：清单上每条都要能点回"它是在哪儿定的"，否则人只知道有这条约定、不知道去哪儿改。
        const who_ = (d) => ({ ...d, byName: d.decided_by ? names[d.decided_by] ?? d.decided_by : null,
          taskTitle: d.task_id ? titles[d.task_id] ?? null : null });
        // 作废的那些：把"被谁取代"解析成人话。页面上不该出现 dr_xxx 这种只有库里认识的编号。
        const withNext = (d) => {
          const n = db.one(`SELECT id, subject, decided_at, decided_by, statement FROM decision_registry WHERE supersedes=?`, d.id);
          return { ...who_(d), supersededBy: n ? { ...n, byName: n.decided_by ? names[n.decided_by] ?? n.decided_by : null } : null };
        };
        return json(res, 200, { active: active.map(who_), voided: voided.map(withNext), sources: sourceNamesOf(res.__lang) });
      }
      // 项目层：列表、从规划文本新建（proposed，守护进程拉规划器）、手动推进、交付。写只经已有入口。
      if (req.method === 'GET' && p === '/api/projects') { let who = null; try { who = identity(req).userId; } catch { /* 同上 */ }
        return json(res, 200, { projects: projectList(db, res.__lang).filter((pj) => canSeeProject(db, pj.id, who)).map((pj) => ({ ...pj, mine: involvedIn(db, pj.id, who), canAdd: canAddTasks(db, pj.id, who) })), visibilities: VISIBILITIES }); }
      if (req.method === 'POST' && p === '/api/projects') {
        const body = await readBody(req);
        const a = authenticate(db, tokenPlain);
        if (!a) return json(res, 400, { error: '看板的本机令牌无效或已吊销；请用命令行重新生成令牌后重启看板' });
        const me = identity(req);
        const cc = canCreate(db, me.userId);
        if (!cc.ok) return json(res, 403, { error: new I18nError('无法新建项目：{why}', { why: translateError({ message: cc.why }, res.__lang) }) });
        // 新建的唯一入口。目标 + 完成定义必填；plan 给了 = 已写好的规划（规划器切），没给 = 第一个任务从目标起草（追问器）。
        const empty = !!body.empty;
        if (!empty) checkRepoSource(body.source, { required: true });
        const r = startProject(db, { userId: me.userId, goal: body.goal, doneDefinition: body.doneDefinition, plan: body.plan ?? null,
          source: empty ? null : body.source, empty, base: body.base || null, title: body.title || null, home });
        return json(res, 200, { ok: true, result: r });
      }
      const pm = p.match(/^\/api\/projects\/([^/]+)\/(advance|deliver|abort|redo|rename|archive|append|review|member|visibility|goal|budget|verify|gear|limit|signoff_all|max_open|egress|setup)$/);
      if (pm && req.method === 'POST') {
        const body = await readBody(req);
        const a = authenticate(db, tokenPlain);
        if (!a) return json(res, 400, { error: '看板的本机令牌无效或已吊销；请用命令行重新生成令牌后重启看板' });
        const me = identity(req);
        const owner = db.one(`SELECT owner_id FROM projects WHERE id=?`, pm[1])?.owner_id;
        if (!owner) return json(res, 404, { error: new I18nError('项目不存在：{id}', { id: pm[1] }) });
        // 添加任务：负责人或被授予的成员（requestAppend 自己查）；其余一律只有负责人。
        if (pm[2] !== 'append' && me.userId !== owner) return json(res, 403, { error: '只有该项目的负责人能执行此操作' });
        if (pm[2] === 'append' && !canAddTasks(db, pm[1], me.userId)) return json(res, 403, { error: '你没有给这个项目添加任务的权限（需要是负责人，或由负责人在项目成员里授予）' });
        // 项目的旋钮 + 后置签收：一律只有负责人（上面那道 403 已经挡住别人了）。
        if (pm[2] === 'setup') {
          try { return json(res, 200, { ok: true, result: setSetupCommands(db, { projectId: pm[1], commands: body.commands ?? '', userId: me.userId }) }); }
          catch (e) { return json(res, 400, { error: e }); }
        }
        if (pm[2] === 'egress') {
          try { return json(res, 200, { ok: true, result: setProjectEgress(db, { projectId: pm[1], sources: Array.isArray(body.sources) ? body.sources : [], userId: me.userId }) }); }
          catch (e) { return json(res, 400, { error: e }); }
        }
        if (['budget', 'verify', 'gear', 'limit', 'signoff_all', 'max_open'].includes(pm[2])) {
          try {
            const usd = body.usd === null || body.usd === '' || body.usd === undefined ? null : Math.round(Number(body.usd) * 1e6);
            const r3 = pm[2] === 'budget' ? setProjectBudget(db, { projectId: pm[1], microUsd: usd, userId: me.userId })
              : pm[2] === 'verify' ? setProjectVerify(db, { projectId: pm[1], command: body.command ?? '', userId: me.userId })
                : pm[2] === 'gear' ? setGear(db, { projectId: pm[1], gear: body.gear, userId: me.userId })
                  : pm[2] === 'limit' ? setProjectLimit(db, { projectId: pm[1], key: body.key, value: body.value === null || body.value === '' ? null : Number(body.value), userId: me.userId })
                    : pm[2] === 'max_open' ? setMaxOpen(db, { projectId: pm[1], n: Number(body.n), userId: me.userId })
                      : acceptDeferredSignoffs(db, { projectId: pm[1], userId: me.userId });
            return json(res, 200, { ok: true, result: r3 });
          } catch (e) { return json(res, 400, { error: e }); }
        }
        if (['abort', 'redo', 'rename', 'archive', 'append', 'member', 'visibility', 'goal', 'review'].includes(pm[2])) {
          const r2 = pm[2] === 'member' ? (body.remove ? removeMember(db, { projectId: pm[1], userId: body.userId, by: me.userId })
              : setMember(db, { projectId: pm[1], userId: body.userId, canAddTasks: !!body.canAddTasks, note: body.note ?? '', by: me.userId }))
            : pm[2] === 'visibility' ? setVisibility(db, { projectId: pm[1], visibility: body.visibility, by: me.userId })
            : pm[2] === 'goal' ? editProjectGoal(db, { projectId: pm[1], goal: body.goal ?? null, doneDefinition: body.doneDefinition ?? null, by: me.userId })
            : pm[2] === 'append' ? requestAppend(db, { projectId: pm[1], userId: me.userId, brief: body.brief })
            : pm[2] === 'review' ? reviewAgain(db, { projectId: pm[1], userId: me.userId })
            : pm[2] === 'abort' ? abortProject(db, { projectId: pm[1], userId: me.userId, why: body.why || null })
            : pm[2] === 'redo' ? redoProjectTask(db, { projectId: pm[1], userId: me.userId, taskId: body.taskId || null, note: body.note || null, plaintextToken: me.token })
            : pm[2] === 'rename' ? renameProject(db, { projectId: pm[1], title: body.title, userId: me.userId })
            : setProjectArchived(db, { projectId: pm[1], archived: body.archived !== false, userId: me.userId });
          // 新任务描述落地之后再比对：挂在载体任务上 —— 批准事项也在那儿。
          if (pm[2] === 'append' && r2?.carrierId) {
            await afterInput(db, { taskId: r2.carrierId, text: body.brief, entry: 'task', by: me.userId, makeClient: newLightClient });
          }
          return json(res, 200, { ok: true, result: r2 });
        }
        const r = pm[2] === 'advance' ? await advanceProject(db, { projectId: pm[1], home, userId: me.userId })
          : await deliverProject(db, { projectId: pm[1], remote: body.remote || null, pr: !!body.pr, base: body.base || null, userId: me.userId });
        return json(res, 200, { ok: true, result: r });
      }
      // 从想法新建任务。身份 = 看板持有的本机令牌（与控制杆同一条规矩）。
      if (req.method === 'POST' && p === '/api/tasks') {
        const body = await readBody(req);
        const a = authenticate(db, tokenPlain);
        if (!a) return json(res, 400, { error: '看板的本机令牌无效或已吊销；请用命令行重新生成令牌后重启看板' });
        const me = identity(req);
        void a; void me;
        return json(res, 410, { error: '独立任务已取消：请新建项目（一次性的小活就是只有一个任务的项目），或在已有项目里添加任务' });
      }
      // 交付页的按任务改动：项目仓库里这个任务合并进来的那一段。
      const pdm = p.match(/^\/api\/projects\/([^/]+)\/diff\/([^/]+)(\/lines)?$/);
      if (pdm && req.method === 'GET') {
        let who = null; try { who = identity(req).userId; } catch { /* 同上 */ }
        if (!canSeeProject(db, pdm[1], who)) return json(res, 404, { error: '项目不存在' });
        const range = deliveryRange(db, { projectId: pdm[1], taskId: pdm[2] });
        return json(res, 200, pdm[3] ? linesOf(range, { path: url.searchParams.get('path') ?? '', from: url.searchParams.get('from'), to: url.searchParams.get('to') }) : viewOf(range));
      }
      const m = p.match(/^\/api\/tasks\/([^/]+)(?:\/([a-z_]+))?$/);
      if (!m) return json(res, 404, { error: '接口不存在' });
      const [, taskId, action] = m;
      // 读接口一律先过可见性。原来只有详情过了，log / report 看不见任务的人也拉得到。
      if (req.method === 'GET' && action) {
        let who = null; try { who = identity(req).userId; } catch { /* 同上 */ }
        if (!canSeeTask(db, taskId, who)) return json(res, 404, { error: new I18nError('任务不存在：{taskId}', { taskId }) });
      }
      // 改动对比（任务口径：接手时的代码 → 任务头）；diff_lines = "展开 N 行未改动"
      // scope：all = 全部（接手时的代码 → 现在）；round = 返工这一轮；node = 某一步（&node=）；不给 = 有返工那一轮就给这一轮
      const dscope = () => ({ taskId, home, scope: url.searchParams.get('scope'), node: url.searchParams.get('node') });
      if (req.method === 'GET' && action === 'diff') {
        const range = rangeFor(db, dscope());
        return json(res, 200, { ...viewOf(range, { roundSince: roundSinceOf(db, taskId) }), scope: range.via === 'round' ? 'round' : range.via === 'node' ? 'node' : 'all' });
      }
      // 看运行效果：最近一次截图的结论；preview_img 取某一张（只认固定形状的文件名与提交号，不拼任意路径）
      if (req.method === 'GET' && action === 'preview') return json(res, 200, previewOf(db, taskId));
      if (req.method === 'GET' && action === 'preview_img') {
        const f = String(url.searchParams.get('file') ?? ''), h = String(url.searchParams.get('head') ?? '');
        if (!/^\d{2}\.png$/.test(f) || !/^([0-9a-f]{1,12}|nohead)$/.test(h)) return json(res, 400, { error: '截图参数不对' });
        const fp = join(home, 'previews', taskId, h, f);
        if (!existsSync(fp)) return json(res, 404, { error: '截图不在了' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(readFileSync(fp));
      }
      if (req.method === 'GET' && action === 'diff_lines') {
        return json(res, 200, linesOf(rangeFor(db, dscope()), { path: url.searchParams.get('path') ?? '', from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
      }
      if (req.method === 'GET' && !action) {
        let who = null; try { who = identity(req).userId; } catch { /* 无效令牌：详情照常给，can 为空 */ }
        const d = canSeeTask(db, taskId, who) ? taskDetail(db, taskId, { userId: who }) : null;
        if (!d) return json(res, 404, { error: new I18nError('任务不存在：{taskId}', { taskId }) });
        // schedule：自动运行会不会拉它、拉哪一步、不拉的原因（纯读审计轨，与守护进程同一个判断）。页面据此显示"下一步"。
        const a = assessTask(db, d.task, { isLive: (id) => controls.running(id), hasWorkspace: (id) => existsSync(join(home, 'workspaces', id)) });
        return json(res, 200, { ...d, running: controls.running(taskId), schedule: { due: !!a.due, verb: a.verb ?? null, reason: a.reason ?? null, readyAt: a.readyAt ?? null, attempts: a.attempts ?? null } });
      }
      if (req.method === 'GET' && action === 'log') return json(res, 200, controls.logTail({ taskId, lines: Number(url.searchParams.get('lines') ?? 80) }));
      if (req.method === 'GET' && action === 'report') {
        const r = db.one(`SELECT * FROM reports WHERE id=? AND task_id=?`, url.searchParams.get('id'), taskId);
        return r ? json(res, 200, r) : json(res, 404, { error: '报告不存在' });
      }
      if (req.method === 'POST' && action && controls[action] && !['running', 'logTail', 'me'].includes(action)) {
        const body = await readBody(req);
        const out = await controls[action]({ taskId, ...body, _token: tokenOf(req), _lang: res.__lang });
        return json(res, 200, { ok: true, result: out });
      }
      return json(res, 404, { error: '接口不存在' });
    } catch (e) {
      return json(res, 400, { error: e });
    }
  });
  return new Promise((ok) => server.listen(port, host, () => ok({
    server, port: server.address().port, host,
    close: () => { clearInterval(ticker); for (const c of clients) c.end(); server.close(); },
  })));
}
