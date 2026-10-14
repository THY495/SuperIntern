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
//   - **只绑 127.0.0.1，身份 = CLI 令牌**：默认是起看板那个人的令牌；每个请求也可以带自己的令牌
//     （头 x-superintern-token；团队模式是 cookie si_token[_端口]），介入者 / 旁观者各用各的。仍不开外网、不做登录 —— 远程走 SSH 隧道。
//   - **看板按角色**：负责人全视图 + 全控制杆；介入者全景只读 + 自己的待答事项 + 转交；旁观者全景只读 + 留言。
//     角色不是页面判的：写入口各自查路由表（setLimit / signOff / deliverTask / recordAnswer），页面只是把按钮藏起来。
//
// "运行"按钮起的是 `node src/cli.mjs run <task>` 子进程（恢复 = 再跑一次 run），日志落
// `.superintern/logs/`，页面能看尾巴。看板不 in-process 跑编排器：编排器该退出时就退出，看板不该拖着它。

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOwner, authenticate, audit, now, sha256 } from '../db/db.mjs';
import { idemGet, idemClaim, idemFinish, idemDrop } from '../db/idempotency.mjs';
import { setNodePriority, uiChecksOf } from '../db/nodes.mjs';
import { updateUser } from '../db/users.mjs';
import { runAs } from '../db/context.mjs';
import { spendByPerson, setPersonBudget } from '../core/spend.mjs';
import { createSession, endSession, issueToken, tokensOf, activeTokens, revokeTokenBy, revokeAllOf, createInvite, invitesList, inviteByCode, acceptInvite, revokeInviteBy } from '../core/sessions.mjs';
import { openQuestions, pendingMessages, recordAnswer, sayWithClassifier, heldSteering, markConsumed } from '../core/inbox.mjs';
import { answersOf, voteRulesOf, sideOnlyOf } from '../core/answers.mjs';
import { DECISION_TYPES, loadTemplates, rulesOf, profileOf, knobsOf, setKnobs, applyTemplate, saveRules, diffFromTemplate, previewRouting,
  dutyCalendarOf, dutyView, setDutyCalendar, dutyStartAt, setDutyOverrides, transferQuestion, leadOf, leadOfKey, routingKeyOf, validateRules, authorize, rerouteOpen } from '../core/routing.mjs';
import { addUser, listUsers, usersView, setUserChannel, setGitIdentity, removeUserChannel, setUserTags, setUserRole, renameUser, reissueToken } from '../core/users.mjs';
import { canCreate, setSetting, settingsView, getSetting, settingSetAt } from '../core/settings.mjs';
import { sqliteAdvice } from '../core/sqlite-check.mjs';
import { CATALOGS, normLang, contentLang, userLang, translateError, localizeHtml, tl, I18nError } from '../i18n/index.mjs';
import { permissionsOf } from '../core/permissions.mjs';
import { reopenTask, redoProjectTask, abortProject, renameTask, renameProject, setTaskArchived, setProjectArchived } from '../core/lifecycle.mjs';
import { daemonStatus, assessTask } from '../core/daemon.mjs';
import { knownRepos, checkRepoSource } from '../core/repos.mjs';
import { requestAppend, appendStateOf, appendPending, reviewAgain } from '../agent/project-append.mjs';
import { projectsToDeliver } from '../core/delivery-due.mjs';
import { approvalThreadOf, describeReading, readingsOf, readVerdict } from '../agent/approval.mjs';
import { startProject } from '../agent/project-start.mjs';
import { deliveryRange, viewOf, linesOf, rangeFor, roundSinceOf } from '../core/diffview.mjs';
import { makeRuntimeHealth } from '../core/health.mjs';
import { deploymentHealth, buildId, llmHealthCheck } from '../core/deploy-health.mjs';
import { healthKey } from '../llm/health.mjs';
import { calendarOf, viewerTz, calendarHealth } from '../core/calendar.mjs';
import { validTz, systemTz, dayKey, addDaysKey, isBusinessDay, weekdayOfKey, fmtAt } from '../core/tz.mjs';
import { listMembers, setMember, removeMember, setVisibility, canAddTasks, involvedIn, canSeeProject, canSeeTask, editProjectGoal, VISIBILITIES } from '../core/project-members.mjs';
import { previewHandover, executeHandover, requestHandover, listHandoverRequests, decideHandoverRequest, canDecideHandover, disableUser, enableUser } from '../core/handover.mjs';
import { buildDigest, renderDigest, sendHandoverNotice, renderHandover } from '../core/digest.mjs';
import { pendingRevision, nodesForReplan, gateOf, renderDiff, applyRevision, rejectRevision } from '../core/revision.mjs';
import { ackRecheck } from '../core/invariants.mjs';
import { LIMITS, limitOf, setLimit, setProjectLimit, projectLimits, LAYER_NAMES, limitChain, compactThresholdOf } from '../core/limits.mjs';
import { roundsOf, diagnose, sameDefect, STALL_ROUNDS, OSC_RETURNS } from '../core/diagnose.mjs';
import { signoffExceptions } from '../core/signoff-exceptions.mjs';
import { recordViews, approvalHabits, HABIT } from '../core/approval-habits.mjs';
import { readPreviewSpec } from '../core/preview.mjs';
import { testsAllowedFor, latestTestChanges, allowTestChanges } from '../core/test-guard.mjs';
import { listReports, markReportsRead } from '../agent/reporter.mjs';
import { signOff, signoffOf, deliverTask } from '../core/deliver.mjs';
import { listCredentials, addCredential, revokeCredential, checkAccess, setAppOAuth } from '../core/credentials.mjs';
import { PUSH_PREFIXES } from '../core/push.mjs';
import { safePositional } from '../core/git.mjs';
import { timeoutFor } from '../core/timeouts.mjs';
import { makeLauncher } from '../core/launcher.mjs';
import { projectTasks, chainGraph, advanceProject, deliverProject, acceptDeferredSignoffs, deliveryEvidence } from '../core/project.mjs';
import { getParam } from '../core/params.mjs';
import { LlmClient } from '../llm/client.mjs';
import { afterInput } from '../core/decision-check.mjs';
import { activeDecisions, SOURCE_NAMES, sourceNamesOf, overruledContractRules } from '../core/decisions.mjs';
import { budgetState, setProjectBudget, projectVerifyCommand, setProjectVerify, gearOf, setGear, gearPrereqStatus, GEARS, deferredSignoffs, maxOpenOf, setMaxOpen, MAX_OPEN_CEILING, parallelOf, setParallel, setupCommandsOf, setSetupCommands, detectSetupCommands } from '../core/project-settings.mjs';
import { sharedPathsOf } from '../core/parallel.mjs';
import { TIERS, EFFORTS, makerOf } from '../llm/canonical.mjs';
import { registryFor, endpointsOf, endpointDiff, keyPresence, catalogOf, bindable, bindingOf, bindingProblems, setBinding, setFallback, saveEndpoint, setEndpointEnabled,
  removeEndpoint, testEndpoint, listEndpointModels, saveModel, removeModel, checkableCatalog, ADAPTERS, ADAPTER_DEFAULTS,
  rolesView, setRoleBinding, pickVerifierModel } from '../llm/registry.mjs';
import { checkCatalog, recordCatalogCheck, lastCatalogCheck } from '../llm/catalog-check.mjs';
import { setEnvVar } from '../core/envfile.mjs';
// 联网目录与项目联网（v20）。同时也注册了"联网放行"事项的答复钩子 —— 不 import 它，看板上的答复就不会生效
import { egressSources, addSource, removeSource, sourceUsage, projectEgressOf, setProjectEgress, secretLike, scrubToolEnv } from '../core/egress.mjs';
import { sourceCredentials } from '../core/egress-creds.mjs';
import { nodeProvenance, POLICIES } from '../core/provenance.mjs';
import { nodeCommits } from '../core/provenance-render.mjs';
import { parseTraceQuery, traceCommit, traceLine, noStepNote } from '../core/trace.mjs';
import { appScripts } from './page-scripts.mjs';
import { CALLBACK_PATH, LOGIN_ERRORS, GH_LOGIN_RE, LoginError, githubLoginConfig, beginLogin, takeState, finishLogin, recheckMembers, loginErrorText, isOrgMember } from '../core/github-login.mjs';
import { transition } from '../db/state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// 报错按请求人的界面语言翻（看板每次请求带 X-SI-Lang；见 src/i18n/index.mjs）。error 可以是字符串或异常本身：
// 传异常才翻得了带参数的 I18nError；字符串只能整句查目录。
const json = (res, status, body) => {
  if (status >= 400 && body?.error != null) body = { ...body, error: translateError(body.error instanceof Error ? body.error : { message: String(body.error) }, res.__lang) };
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
};
/** 请求体上限。 */
export const MAX_BODY_BYTES = 1_000_000;
/**
 * 读 JSON 请求体。超过上限 → 413（原来只是 destroy 连接，promise 既不成也不败，那个请求就一直挂着）；
 * 不是合法 JSON → 400。
 */
/** 读请求体原文（超过上限 → 413）。 */
const rawBody = (req) => new Promise((ok, bad) => {
  let s = '', over = false;
  req.on('data', (c) => {
    if (over) return;
    s += c;
    if (s.length > MAX_BODY_BYTES) { over = true; s = ''; req.resume(); bad(Object.assign(new I18nError('请求体太大（上限 {n} 字节）', { n: MAX_BODY_BYTES }), { status: 413 })); }
  });
  req.on('end', () => { if (!over) ok(s); });
  req.on('error', bad);
});
const readBody = async (req) => {
  // 分派器为了幂等键已经读过一遍（算哈希要用原文）：直接用那一份
  const s = req.__bodyText !== undefined ? req.__bodyText : await rawBody(req);
  try { return s ? JSON.parse(s) : {}; } catch { throw Object.assign(new I18nError('请求体不是合法的 JSON'), { status: 400 }); }
};
/**
 * 处理函数抛出来的错误怎么回：业务上的（I18nError、写明了 status 的、普通 Error 带的说明）照旧 4xx 带原话；
 * 意料之外的（库错误、TypeError 之类的程序错）回 500 + 一句通用的话 —— 不把 SQL、堆栈之类的内部细节送给浏览器，细节进审计。
 */
export function classifyError(e) {
  if (e?.status) return { status: e.status, expose: true };
  const internal = /^ERR_SQLITE/.test(e?.code ?? '') || e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError;
  return internal ? { status: 500, expose: false } : { status: 400, expose: true };
}

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
    for (const t of tasks) { const rb = getParam(db, t.id, 'task.requested_by'); if (rb) t.requestedBy = (Array.isArray(rb) ? rb : [rb]).map(uname).join(tl(contentLang(db), '、')); }
    const budget = budgetState(db, p.id);
    const lastDel = db.one(`SELECT ts, payload FROM audit_log WHERE action='project_delivered' AND target_id=? ORDER BY id DESC LIMIT 1`, p.id);
    const delivered = !!lastDel;
    // 上一次交付推到了哪儿：页面上照实写出来，再交付时远端地址也预先填好（不用再从别处翻）
    const lastDelivery = lastDel ? (() => { const x = safeJson(lastDel.payload) ?? {}; return { at: lastDel.ts, remote: x.remote ?? null, branch: x.branch ?? null, pr: x.pr?.url ?? null }; })() : null;
    // 交付过之后又合并了新任务（持续维护迭代）：还要再交付 —— 与收件箱「等你交付」同一个口径
    const deliverDue = projectsToDeliver(db, { ownerId: p.owner_id }).some((x) => x.projectId === p.id);
    // 交付前的一手证据。只在**能交付**的项目上算 —— 它要读一次 git，不该每次轮询给每个项目都跑一遍。
    const evidence = (p.status === 'done' || p.status === 'aborted') ? deliveryEvidence(db, { projectId: p.id }) : null;
    return { ...p, tasks, carrier, superseded, spendMicro, planningMicro, append, appendQueue, delivered, deliverDue, lastDelivery, evidence, members: listMembers(db, p.id),
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
      parallel: parallelOf(db, p.id),
      sharedPaths: parallelOf(db, p.id) ? sharedPathsOf(db, p.id) : [],
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
  const rawNodes = db.all(`SELECT id,title,status,priority,risk_tier,model_tier,retry_count,started_at,finished_at,tier_escalated_at,spec,acceptance,ui_checks,created_at
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
      ...(({ mustSign, selfExcluded }) => ({ mustSign: mustSign.length ? mustSign.map((u) => ({ userId: u, name: names[u] ?? u })) : null, selfExcluded: selfExcluded && { userId: selfExcluded, name: names[selfExcluded] ?? selfExcluded } }))(voteRulesOf(db, q)),
      answers: answersOf(db, q.id).map((a) => ({ id: a.id, userId: a.user_id, name: a.user_id ? (names[a.user_id] ?? a.user_id) : '系统', body: a.body, stance: a.stance, agreesWith: a.agrees_with ?? null, at: a.created_at })),
      remainingMs: q.timeout_at && ['open', 'escalated'].includes(q.status) ? q.timeout_at - t : null,
      routeRemainingMs: q.route_due_at && ['open', 'escalated'].includes(q.status) ? q.route_due_at - t : null,
      briefing: db.one(`SELECT id, work_done, plan_after AS plan_after_answer FROM briefings WHERE question_id=? AND superseded_at IS NULL ORDER BY valid_from DESC LIMIT 1`, q.id) ?? null,
      // 生效的那条答复，带作者名（别人答掉之后，另一人要看得出是谁答的）
      answer: ((m) => m && { ...m, byName: m.sender_id ? (names[m.sender_id] ?? m.sender_id) : null })(db.one(`SELECT m.body, m.trust_label, m.received_at, m.sender_id FROM messages m JOIN edges e ON e.from_id=m.id AND e.to_id=? AND e.relation='answers' AND e.superseded_at IS NULL ORDER BY e.id DESC LIMIT 1`, q.id)) ?? null }));
  // 开着的事项所在步骤改了原有测试、还没被放行的 —— 答复框下给"允许这一步改这些原有测试"（放行入口，reject 模式的出路）
  for (const q of questions) {
    if (!q.node_id || !['open', 'escalated'].includes(q.status)) continue;
    const allowed = testsAllowedFor(db, q.node_id);
    const paths = latestTestChanges(db, q.node_id).filter((c) => c.baseline && !allowed.has(c.path)).map((c) => c.path);
    if (paths.length) { q.testPaths = paths; q.testGuard = getSetting(db, 'deploy.test_guard'); }
  }
  // 方案批准类事项的判读："已决定"说不出系统把那句话读成了什么（曾出现过标着已决定、实际被当成要改）。
  // 读过的以状态机留下的 approval_read 为准；答了还没轮到状态机读的，用同一个函数先算给人看；开着的标可预览。
  { const readings = readingsOf(db, taskId);
    for (const q of questions) {
      if (q.decision_type !== 'contract_approval') continue;
      if (readings[q.id]) { q.reading = { ...readings[q.id], final: true }; continue; }
      const th = approvalThreadOf(db, q.id);
      if (!th) continue;
      if (['open', 'escalated'].includes(q.status)) q.interpretable = true;
      else if (q.answer) q.reading = { ...describeReading({ body: q.answer.body, labels: th.labels, reached: th.reached, kind: th.kind, lang: contentLang(db) }), final: false };
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
    revision = { id: rv.id, status: rv.status, gate: rv.gate, questionId: rv.question_id ?? null, message: db.one(`SELECT body FROM messages WHERE id=?`, rv.message_id)?.body ?? '', diff, rationale: rv.rationale };
  }
  const limits = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, { label: LIMITS[k].label, value: limitOf(db, taskId, k), onHit: LIMITS[k].on_hit }]));
  // 整理线被上下文上限压低时，上限栏要说清实际按多少（窗口取执行器在标准档用的模型；单独绑了执行器就取它）
  { let win = null; try { const reg = registryFor(db); const key = reg.roleBinding?.executor?.key ?? reg.binding?.standard; win = reg.catalog?.[key]?.contextWindow ?? null; } catch { win = null; }
    const c = compactThresholdOf(db, taskId, { contextWindow: win });
    limits['limit.compact_tokens'].effective = { at: c.at, source: c.source, cap: c.context.cap };
    limits['limit.context_tokens'].effective = { cap: c.context.cap, source: c.context.source, window: c.context.window }; }
  const params = db.all(`SELECT key, value, layer, set_by_kind FROM params WHERE task_id=? AND superseded_at IS NULL ORDER BY key`, taskId);
  const spend = db.all(`SELECT role, count(*) n, SUM(micro_usd) m FROM usage_ledger WHERE task_id=? GROUP BY role`, taskId);
  const wsDir = join(process.env.SUPERINTERN_HOME ?? join(process.cwd(), '.superintern'), 'workspaces', taskId);
  const stage = getParam(db, taskId, 'draft.stage');
  const draft = stage ? { stage, idea: getParam(db, taskId, 'draft.idea'), source: getParam(db, taskId, 'draft.source'), title: getParam(db, taskId, 'draft.title'),
    verifyCommand: getParam(db, taskId, 'draft.verify_command'), notes: getParam(db, taskId, 'draft.notes'), approvalQuestion: getParam(db, taskId, 'draft.approval_question') } : null;
  const measured = Object.fromEntries(Object.keys(LIMITS).map((k) => { try { return [k, LIMITS[k].read(db, taskId, { startedAt: t })]; } catch { return [k, null]; } }));
  // 契约里已被判作废的条目。签收人对着契约原文看产物，看不到这一段就会以为执行器跑偏了。
  const overruled = overruledContractRules(db, taskId).map((d) => ({ statement: d.statement, by: d.by, at: d.at, viaQuestion: !!d.questionId, quote: d.quote }));
  // 诊断：被打回过的步骤带上判词与还剩的缺陷；文字由看板按查看者的语言出，这里只给结构
  // 每一步整理过几次上下文（第 1 级清掉旧的工具结果 / 第 2 级写简报）
  const compactions = new Map(db.all(`SELECT a.target_id id, count(*) n FROM audit_log a JOIN nodes x ON x.id=a.target_id
      WHERE a.action='context_compacted' AND a.target_type='node' AND x.task_id=? GROUP BY a.target_id`, taskId).map((r) => [r.id, r.n]));
  for (const n of nodes) {
    if (compactions.has(n.id)) n.compactions = compactions.get(n.id);
    // 这一步最近一次交接时比出来的测试改动（删了、跳过、变少、改期望值）；人放行过的标 allowed
    { const tc = latestTestChanges(db, n.id); if (tc.length) { const allowed = testsAllowedFor(db, n.id); n.testChanges = tc.map((c) => (c.baseline && allowed.has(c.path) ? { ...c, allowed: true } : c)); } }
    // 界面条目 + 最近一次验收逐条的结果（还没验收过只给条目）
    { const ui = uiChecksOf(n); if (ui.length) {
      const runs = db.all(`SELECT ts, payload FROM audit_log WHERE action='handoff_verified' AND target_id=? ORDER BY id`, n.id);
      const last = runs.at(-1);
      let p = null, verdict = null; try { const j = last ? JSON.parse(last.payload) : null; p = j?.ui ?? null; verdict = j?.verdict ?? null; } catch { /* 坏行当没验过 */ }
      n.uiChecks = p?.checks?.length ? p.checks : ui.map((item, i) => ({ n: i + 1, item, result: null }));
      n.uiLive = p?.live ?? null;
      n.uiScreens = p?.live?.screens ?? null;   // 这次验收存画面的目录 key（逐条引用的画面号在 checks[].screens）
      // 第几次验收、什么时候、结论（块头写后果：打回在改 / 放行了但有没验的）
      if (p) n.uiRun = { round: runs.length, at: last.ts, verdict };
    } }
    const rounds = roundsOf(db, n.id);
    if (!rounds.some((r) => r.kind !== 'pass')) continue;
    const d = diagnose(rounds);
    // 格子图：每一列是一次交，每一行是一条缺陷（跨次用 sameDefect 归并到它最近一次出现的那行）；
    // 列上标出中间有没有"一整轮用完、从头重来"（node_stalled），让"打回次数"和"重试次数"的关系看得见
    const restarts = db.all(`SELECT id FROM audit_log WHERE target_type='node' AND target_id=? AND action='node_stalled' ORDER BY id`, n.id).map((r) => r.id);
    const rows = [];
    const cols = rounds.map((r, i) => {
      const prevId = i ? rounds[i - 1].auditId : Infinity;
      if (r.kind === 'mech' || r.kind === 'verifier') {
        for (const x of r.defects) {
          let row = rows.find((w) => !w.cells[i] && sameDefect(w.last, x));
          if (!row) { row = { category: x.category, summary: String(x.summary ?? '').slice(0, 600), locations: (x.locations ?? []).slice(0, 5), by: r.kind, cells: [] }; rows.push(row); }
          row.cells[i] = true; row.last = x;
        }
      }
      return { kind: r.kind, n: r.defects.length, at: r.at, restart: restarts.some((id) => id > prevId && id < r.auditId) };
    });
    const lastDef = cols.map((c) => c.kind === 'mech' || c.kind === 'verifier').lastIndexOf(true);
    n.diagnosis = { state: d.state, rejections: d.rejections, streak: d.streak, returns: d.returns, resolved: d.resolved, escalate: d.escalate, stallAt: STALL_ROUNDS, oscAt: OSC_RETURNS,
      // 格子三态：true 这次有 / false 查了没有 / null 这次没查（环境出错；或机械校验打回、验收员没跑，验收员那几条就无从说起）
      cols, rows: rows.slice(0, 20).map(({ last, cells, ...w }) => {
        const seen = (i) => (cols[i].kind === 'env' || (cols[i].kind === 'mech' && w.by === 'verifier') ? null : !!cells[i]);
        const now = d.state === 'passed' ? 'fixed' : seen(lastDef) === null ? 'unknown' : seen(lastDef) ? 'open' : 'fixed';
        return { ...w, cells: cols.map((_, i) => seen(i)), now, open: now === 'open' };
      }) };
  }
  return { task, draft, constitution: c ? { ...c, constraints: safeJson(c.constraints), overruled } : null, nodes, edges, questions, messages, decisions, assumptions,
    audits, reports, revision, limits, measured, params, spend, signoff: signoffOf(db, taskId),
    // 项目预算闸：任务页原来只写任务自己的上限，项目设了 $7 / $3 的人看到"上限 $5"不知道是哪层
    projectBudget: (() => { if (!task.project_id) return null; const b = budgetState(db, task.project_id); return b.gate === null ? null : { gate: b.gate, spent: b.spent, remaining: b.remaining, over: b.over }; })(), workspace: existsSync(wsDir) ? wsDir : null, preview: previewOf(db, taskId),
    signoffExceptions: questions.some((q) => q.decision_type === 'signoff' && ['open', 'escalated'].includes(q.status)) ? exceptionsView(db, taskId, wsDir) : null,
    spendMicro: spend.reduce((a, r) => a + r.m, 0), now: t, users: names, lead: leadOf(db, taskId), routingKey: routingKeyOf(db, taskId), can };
}
const safeJson = (s) => { try { return JSON.parse(s ?? 'null'); } catch { return s; } };
/** 最近一次"看运行效果"的结论。没有 si-preview.json 的任务从来没截过 → null。 */
/** 签收卡置顶的例外。有页面上没验成的条目时，顺带给"自己跑起来看"的起法（取自工作区的 si-preview.json，与签收截图同一份） */
function exceptionsView(db, taskId, wsDir) {
  const list = signoffExceptions(db, taskId);
  let run = null;
  if (list.some((e) => e.kind === 'ui_unverified') && existsSync(wsDir)) {
    const r = readPreviewSpec(wsDir, contentLang(db));
    // 装依赖的命令：沙箱里最近一次装好时跑的那几条（任务或所在项目）
    const setup = safeJson(db.one(`SELECT payload FROM audit_log WHERE action='env_setup_done' AND target_id IN (?, (SELECT project_id FROM tasks WHERE id=?)) ORDER BY id DESC LIMIT 1`, taskId, taskId)?.payload);
    if (r?.spec) run = { dir: wsDir, setup: (setup?.results ?? []).map((x) => x.cmd).filter(Boolean), start: r.spec.start.map((a) => a.join(' ')), seed: r.spec.seed.map((a) => a.join(' ')), url: r.spec.url };
  }
  return { list, run };
}
// 每步最近一次验收的页面点验（逐条结果、AI 看到了什么、引用的画面）—— 签收的人在"看运行效果"里看
function liveChecksOf(db, taskId) {
  const out = [];
  for (const n of db.all(`SELECT id, title, ui_checks FROM nodes WHERE task_id=? AND ui_checks IS NOT NULL ORDER BY created_at, rowid`, taskId)) {
    if (!uiChecksOf(n).length) continue;
    const last = db.one(`SELECT payload FROM audit_log WHERE action='handoff_verified' AND target_id=? ORDER BY id DESC LIMIT 1`, n.id);
    const ui = safeJson(last?.payload)?.ui;
    if (!ui?.checks?.length) continue;
    out.push({ nodeId: n.id, title: n.title, key: ui.live?.screens ?? null,
      checks: ui.checks.map((c) => ({ n: c.n, item: c.item, result: c.result, evidence: c.evidence ?? null, screens: Array.isArray(c.screens) ? c.screens : [] })) });
  }
  return out;
}

export function previewOf(db, taskId) {
  const a = db.one(`SELECT action, ts, payload FROM audit_log WHERE target_id=? AND action IN ('preview_captured','preview_failed','preview_skipped') ORDER BY id DESC LIMIT 1`, taskId);
  if (!a) return null;
  const p = safeJson(a.payload) ?? {};
  // 这一轮没碰界面，系统没截（见 orchestrator finalize）：照实告诉签收的人，而不是说"仓库里没有截图说明"
  const live = liveChecksOf(db, taskId);
  if (a.action === 'preview_skipped') return { ok: false, skipped: true, at: a.ts, head: p.head ?? null, headKey: String(p.head ?? 'nohead').slice(0, 12), shots: [], why: p.why ?? null, log: null, warnings: [], live };
  return { ok: a.action === 'preview_captured', at: a.ts, head: p.head ?? null, headKey: String(p.head ?? 'nohead').slice(0, 12),
    shots: Array.isArray(p.shots) ? p.shots.map((s) => ({ title: s.title, path: s.path, file: s.file, warnings: s.warnings ?? [] })) : [], why: p.why ?? null, log: p.log ?? null,
    warnings: p.warnings ?? [], live };
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
      endpointEnabled: !!endpoints[m.vendor]?.enabled, keyPresent: !!keys[m.vendor]?.present,
      // 出品方与熔断键 —— 备用模型选择里标出"同一家""同一服务商（它停了备用也停）"
      maker: makerOf(m), hkey: m.vendor ? healthKey({ gateway: !!endpoints[m.vendor]?.gateway, vendorId: m.vendor, model: m.model }) : null })),
    health: llmHealthCheck(db).rows,
    binding: { ...b, problems: bindingProblems(db, { env, lang }) },
    // 每个角色实际用什么、来自哪一层；验收员的异厂商策略与它此刻的效果（按各档执行器分别算一次）
    roles: rolesView(db).map((r) => ({ ...r, cannotBind: r.override ? bindable(catalog[r.override.key], endpoints, lang) : null })),
    verifierPolicy: (() => {
      const reg = registryFor(db), policy = getSetting(db, 'deploy.verifier_vendor');
      const vendorOf = (k) => catalog[k]?.vendor ?? null;
      return { policy, cosign: getSetting(db, 'deploy.verifier_cosign'),
        // 执行器在某一档（或单独绑定）时，验收员会用谁
        byExecutor: [...new Set([...TIERS.map((t) => reg.roleBinding.executor?.key ?? b.binding[t])])].map((k) => ({ executorKey: k, executorVendor: vendorOf(k),
          verifier: pickVerifierModel(reg, { executorKey: k, policy, env }) })) };
    })(),
    adapters: ADAPTERS.map((a) => ({ id: a, ...ADAPTER_DEFAULTS[a] })), efforts: EFFORTS, tiers: TIERS,
    lastCheck: last ? { at: last.checkedAt ?? last.ts, warnings: last.warnings, fetchErrors: last.fetchErrors, probe: last.probe } : null,
  };
}

// ── 控制杆（写只经已有入口）────────────────────────────────────────────────
export function makeControls(db, { home, tokenPlain, launcher = makeLauncher(db, { home }), makeClassifierClient = null, env = process.env }) {
  // 身份按请求：带了自己的令牌就是自己，没带就是起看板那个人。
  const auth = (o = {}) => {
    const tok = o._token || tokenPlain;
    const a = authenticate(db, tok);
    if (!a) throw new Error(o._token ? '令牌无效或已吊销' : '看板的本机令牌无效或已吊销；请用命令行重新生成令牌后重启看板');
    return { plaintextToken: tok, userId: a.user_id, tokenId: a.token_id ?? null };
  };
  // 这个人只是顺带收到这条（不计数、不拍板）
  const sideOf = (qid) => { try { return sideOnlyOf(JSON.parse(db.one('SELECT route FROM questions WHERE id=?', qid)?.route ?? 'null')); } catch { return new Set(); } };
  const isSide = (qid, userId) => sideOf(qid).has(userId);
  // 顺带收到的人里已经写了"还差什么"的（拍板的人回批准 / 放弃会越过他们）
  const sideAsksOf = (qid, th) => { const side = sideOf(qid); if (!side.size) return [];
    return [...new Set(answersOf(db, qid).filter((a) => a.stance === 'answer' && side.has(a.user_id) && readVerdict(a.body, th.labels) === 'feedback')
      .map((a) => db.one('SELECT display_name FROM users WHERE id=?', a.user_id)?.display_name ?? a.user_id))]; };
  const requireLead = (o, taskId) => { const { userId } = auth(o); if (userId !== leadOf(db, taskId)) throw new Error('只有该任务的负责人能执行此操作'); return userId; };

  // 分类器 client：测试可注入 fake（makeClassifierClient）；默认按库里的生效注册表建 live client（每次现读）。
  const newClassifierClient = makeClassifierClient
    ?? (() => new LlmClient({ mode: 'live', ...registryFor(db) }));
  const say = async (o) => {
    const { taskId, body, kind, urgent, about } = o;
    const hasKind = !!kind;
    // 已合并的项目任务：它不会再跑了，发给它的修正 / 新指令没有人接 —— 消息被放行后就悬着，
    // 项目随即宣布达成，需求就丢了。这种话就是一条新需求：
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
    // 变更消息落地之后再比对（5c 入口②）：只比 correction / instruction —— 补充信息不改变要做什么。
    if (['correction', 'instruction'].includes(out.kind)) {
      await afterInput(db, { taskId, text: body, entry: 'revision', by: auth(o).userId, makeClient: newClassifierClient, sourceId: out.messageId });
    }
    // answer 场景：分类器判为"这是在回答某个开着的问题"，不入库也不自动答复。
    // 返回 questionId 与原文，供看板渲染"转为答复"按钮（走既有 answer 控制杆，签当前用户名）。
    return out.kind === 'answer' ? { ...out, body } : out;
  };
  return {
    // 答复落地之后再比对：比对不阻塞答复 —— 命中只是另外挂一条事项。
    // 附议 / 弃权不比对：它们不引入新说法。
    answer: async (o) => {
      const { userId, plaintextToken } = auth(o);
      const q = db.one(`SELECT task_id FROM questions WHERE id=?`, o.questionId);
      const r = recordAnswer(db, { questionId: o.questionId, body: o.body, stance: o.stance ?? 'answer',
        agreesWith: o.agreesWith ?? null, plaintextToken });
      // 答复同时作为计划变更提交：结构矛盾的出路常常就是改契约，而答复本身改不了契约 —— 原来要人答完再去任务页
      // 发一条内容一样的修正，两次动作之间执行器已经按答复复工、去改范围外的文件，被越界校验拒回又来问。
      // 这里同一次请求里紧接着记下修正（先暂扣，比对完才放行；编排器见到暂扣的修正就先停下等它），
      // 于是复工的那一轮先重规划、再按新契约做。比对只做一次（修正那一路做），同一段话不比两遍。
      let correction = null;
      if (o.alsoCorrection && (o.stance ?? 'answer') === 'answer' && q?.task_id) {
        correction = await say({ ...o, taskId: q.task_id, kind: 'correction', about: o.questionId, urgent: false });
      } else if ((o.stance ?? 'answer') === 'answer' && q?.task_id) {
        await afterInput(db, { taskId: q.task_id, text: o.body, entry: 'answer', by: userId, makeClient: newClassifierClient, sourceId: r?.messageId ?? null });
      }
      // 方案批准的答复：回显系统怎么读这句话。判读本身仍由状态机做，这里用的是同一个函数。
      const th = (o.stance ?? 'answer') === 'answer' ? approvalThreadOf(db, o.questionId) : null;
      // 答复时一并放行这一步对原有测试的改动（路径由系统比对给出，不收客户端传的）
      const allowedTests = o.allowTests && (o.stance ?? 'answer') === 'answer' ? allowTestChanges(db, { questionId: o.questionId, userId, answerId: r?.answerId ?? null }) : [];
      let out = correction ? { ...r, correction: { messageId: correction.messageId ?? null, appended: !!correction.appended } } : r;
      if (allowedTests.length) out = { ...out, allowedTests };
      return th ? { ...out, reading: describeReading({ body: o.body, labels: th.labels, reached: th.reached, kind: th.kind, tense: 'did', lang: contentLang(db), side: isSide(o.questionId, userId) }) } : out;
    },
    // 答之前的实时预览：只读，不落库。看不见这个任务的人拿不到（与任务详情同一道可见性）。
    // 顺带收到的人按他们自己的处境写后果
    interpret: (o) => {
      const { userId } = auth(o);
      if (!canSeeTask(db, o.taskId, userId)) throw new Error('任务不存在');
      const th = approvalThreadOf(db, o.questionId);
      if (!th || th.taskId !== o.taskId) return { reading: null };
      return { reading: describeReading({ body: String(o.body ?? ''), labels: th.labels, reached: th.reached, kind: th.kind, tense: 'will', lang: contentLang(db), side: isSide(o.questionId, userId), sideAsks: sideAsksOf(o.questionId, th) }) };
    },
    // 看板上第一次看到写给自己的事项（监测走过场的"打开到答复"）。只记第一次、只记还开着的、写给这个人的
    seen: (o) => {
      const { userId } = auth(o);
      if (!canSeeTask(db, o.taskId, userId)) throw new Error('任务不存在');
      // 只认地址里这个任务的事项（与其余写接口同一口径：别的任务的事项 id 一律当没有）
      const ids = [].concat(o.questionIds ?? []).map(String).filter((id) => db.one(`SELECT task_id FROM questions WHERE id=?`, id)?.task_id === o.taskId);
      return { recorded: recordViews(db, { userId, questionIds: ids }) };
    },
    transfer: (o) => transferQuestion(db, { questionId: o.questionId, to: [].concat(o.to ?? []), reason: o.reason ?? null, byUserId: auth(o).userId }),
    say,
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
        // 卡片三个按钮与事项三个选项一一对应：批准 = A；重出一版（写了怎么改）= B：…；不要这份变更 = C
        const redo = String(why ?? '').trim();
        const body = approve ? (reservation ? tl(L, 'A\n保留：{reservation}', { reservation }) : 'A') : redo ? tl(L, 'B：{why}', { why: redo }) : 'C';
        const r = recordAnswer(db, { questionId: rv.question_id, body, plaintextToken: auth(o).plaintextToken });
        return { ...r, viaQuestion: true, pending: !r.resolved };
      }
      if (approve) return applyRevision(db, { taskId, revisionId: rv.id, by: 'user', userId, reservation: reservation ?? null });
      const redo = String(why ?? '').trim();
      return rejectRevision(db, { taskId, revisionId: rv.id, userId, why: redo || tl(contentLang(db), '不要这份变更'), redo: redo ? { text: redo, tokenId: auth(o).tokenId ?? null } : null });
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
      setNodePriority(db, nodeId, p);
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
      return deliverTask(db, { taskId, workspace: ws, remote: remote || null, pr: !!pr, base: base || null, userId, env });
    },
    reportsRead: (o) => { auth(o); markReportsRead(db, [].concat(o.ids ?? []), { taskId: o.taskId }); return { ok: true }; },   // 只认这个任务的报告（原来任意 id 都标）
    // 起编排器子进程（经共用的启动器：守护进程起的和人按的在同一张表里，不会撞车）。
    // 手动"运行"按任务所处阶段拉对应的步骤：从想法起的任务先澄清（draft）、有契约没步骤的先规划（plan）、否则执行（run）。
    // 此前一律拉 run，自动运行关着时对还在澄清 / 规划阶段的任务是拉错了阶段。
    run: (o) => {
      const actorId = requireLead(o, o.taskId);
      const task = db.one(`SELECT id, status FROM tasks WHERE id=?`, o.taskId);
      const a = task ? assessTask(db, task, { hasWorkspace: (id) => existsSync(join(home, 'workspaces', id)), isLive: launcher.running }) : null;
      // 别的进程（另一个看板 / 独立守护进程 / 手动 run）正在跑它：当场说清，不再起一个注定被拒的子进程
      if (a?.reason === 'live_foreign') throw new I18nError('任务 {taskId} 已有编排器在跑（pid {pid}）：同一任务同时只能有一个，否则两边会抢同一个步骤。等它结束，或先在看板上暂停它', { taskId: o.taskId, pid: a.pid });
      const verb = a?.verb || 'run';
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
  transition(db, 'tasks', taskId, to, { from, audit: { action, actorKind: 'user', actorId: userId, payload: extra } });
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
/** 路由表认得的 auth 策略（含义见 startWeb 里路由表的注释）。 */
export const ROUTE_AUTH = new Set(['public', 'session', 'admin', 'project', 'task']);

/** 表本身的校验：每条都声明了认得的 auth；public 的正好是团队模式放行的那几条（加首页）；另外只许一条静态脚本路由（GET、只认 /app/<两位数>-<小写名>.js）。写错了启动即报错，而不是悄悄放行。 */
export function checkRouteTable(routes) {
  for (const r of routes) {
    if (!ROUTE_AUTH.has(r.auth)) throw new Error(`路由 ${r.method} ${r.path ?? r.re} 没有声明（或写错了）auth：${r.auth}`);
    if (!r.path === !r.re) throw new Error(`路由 ${r.method} ${r.path ?? r.re} 要么给 path 要么给 re`);
    if (typeof r.handler !== 'function') throw new Error(`路由 ${r.method} ${r.path ?? r.re} 没有处理函数`);
  }
  const statics = routes.filter((r) => r.static);
  if (statics.length > 1 || statics.some((r) => r.auth !== 'public' || r.method !== 'GET' || String(r.re) !== String(APP_SCRIPT_RE))) throw new Error('静态脚本路由只许一条：GET、public、只认 /app/<两位数>-<小写名>.js');
  const publicPaths = new Set(routes.filter((r) => r.auth === 'public' && !r.static).map((r) => r.path));
  if ([...TEAM_OPEN_PATHS, '/'].some((x) => !publicPaths.has(x)) || [...publicPaths].some((x) => x !== '/' && !TEAM_OPEN_PATHS.has(x))) {
    throw new Error('路由表里 public 的路由与 TEAM_OPEN_PATHS 对不上');
  }
}

export const APP_SCRIPT_RE = /^\/app\/([0-9]{2}-[a-z0-9-]+\.js)$/;
// 看板页面的安全策略：脚本只许本站的外置文件（index.html 里没有内联脚本，词表是 JSON 数据块）；不许插件、不许改 <base>；
// 请求只发本站；图片只许本站与 data:（预览截图走本站）。样式仍许内联（页面里大量 style="…"，样式注入的危害远小于脚本）。
// 支持 Trusted Types 的浏览器另启用它：innerHTML 等入口只收经 default 策略的值（01-core.js 里建），往后要收紧就在那一处。
export const PAGE_CSP = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "font-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "require-trusted-types-for 'script'", 'trusted-types default'].join('; ');
export const TEAM_OPEN_PATHS = new Set(['/healthz', '/api/login', '/api/logout', '/api/session', '/api/i18n', '/api/invites/peek', '/api/invites/accept', '/api/auth/github', '/api/auth/github/callback']);
export function startWeb(db, { home, port = 7357, host = '127.0.0.1', tokenPlain, launcher, daemon = false, pollMs = 1000, makeClassifierClient = null, envFile = null, env = process.env, fetchFn = globalThis.fetch, team = false, publicUrl = null, runtime = undefined, authzProbe = false } = {}) {
  ensureOwner(db);
  // 容器运行时健康：测试可注入；不给就真探（起看板时先探一次，之后按 30 秒缓存在后台刷新）
  const runtimeHealth = runtime === undefined ? makeRuntimeHealth({ lang: () => contentLang(db) }) : runtime;
  runtimeHealth?.current?.();
  let pub = null;
  if (team) {
    try { pub = new URL(publicUrl); } catch { throw new Error('团队模式要给对外地址：--public-url https://看板的内网域名'); }
  }
  const secureCookie = pub?.protocol === 'https:';
  const portTag = pub?.port ? `_${pub.port}` : '';   // 默认端口（80 / 443）不带，名字与升级前一样
  const TOKEN_COOKIE = `si_token${portTag}`, STATE_COOKIE = `si_gh_state${portTag}`;
  // 请求身份的兜底：本机模式 = 起看板的人；团队模式 = 没有
  const fallbackToken = team ? null : tokenPlain;
  const controls = makeControls(db, { home, tokenPlain: fallbackToken, makeClassifierClient, env, ...(launcher ? { launcher } : {}) });
  // 登录失败限速（按来源地址）：令牌是高熵随机串，爆破本来就不现实；这道闸主要是别让人把认证当压测打
  const loginFails = new Map();
  const LOGIN_WINDOW_MS = 10 * 60_000, LOGIN_MAX_FAILS = 20;
  // 轻档 client（决定比对用）：测试可注入 fake，默认按库里的生效注册表现建。
  const newLightClient = makeClassifierClient ?? (() => new LlmClient({ mode: 'live', ...registryFor(db) }));
  const html = readFileSync(join(HERE, 'index.html'), 'utf8');
  const appScriptBodies = new Map(appScripts(html).map((s) => { const text = readFileSync(s.path, 'utf8'); return [s.name, { text, etag: `"${sha256(text).slice(0, 16)}"` }]; }));
  // 构建号：版本 + 页面与脚本的内容摘要。页面里带一份（<meta name="si-build">），SSE 的 hello 再带一份 ——
  // 服务端换了代码、浏览器里还开着旧页面时，重连拿到的 hello 对不上，页面提示刷新
  const BUILD = buildId([html, ...[...appScriptBodies.values()].map((b) => b.text)]);
  const pageHtml = (lang) => localizeHtml(html, lang).replace('<head>', `<head>\n<meta name="si-build" content="${BUILD}">`);
  // 运行环境提示（只给管理员看，他才能动服务器）：SQLite 版本在进程生命周期内不变，算一次
  const sqliteNote = sqliteAdvice(db);
  const clients = new Set();
  /** 一条审计行属于哪个任务 / 项目（SSE 按可见性过滤用）；系统级的行两者都没有。 */
  const rowScope = (r) => {
    if (r.target_type === 'task') return { taskId: r.target_id };
    if (r.target_type === 'project') return { projectId: r.target_id };
    if (r.target_type === 'node') return { taskId: db.one(`SELECT task_id FROM nodes WHERE id=?`, r.target_id)?.task_id ?? null };
    if (r.target_type === 'question') return { taskId: db.one(`SELECT task_id FROM questions WHERE id=?`, r.target_id)?.task_id ?? null };
    return {};
  };
  let lastAuditId = db.one(`SELECT COALESCE(MAX(id),0) m FROM audit_log`).m;
  /**
   * 建连时认过身份的连接，每一轮都重新认一次（2026-10-12）：原来身份只在建连时定，令牌被吊销、
   * 人被停用之后，开着的页面照样一直收推送。吊销可能来自别的进程（CLI），所以靠轮询而不是靠"吊销时通知"。
   * 认不过 → 发一条 revoked 让页面回到登录、再断开。建连时就没身份的（本机模式未换身份）不在此列。
   */
  const dropRevoked = () => {
    const okByToken = new Map();
    for (const c of clients) {
      if (!c.__tok) continue;
      if (!okByToken.has(c.__tok)) okByToken.set(c.__tok, !!authenticate(db, c.__tok));
      if (okByToken.get(c.__tok)) continue;
      clients.delete(c);
      try { c.write(`event: revoked\ndata: {}\n\n`); c.end(); } catch { /* 对端已断 */ }
    }
  };
  // 用 GitHub 登录的人离开组织：每小时复查一次，查实不是成员就吊销他们经 GitHub 开的会话（core/github-login.mjs recheckMembers）
  const ghRecheck = team ? setInterval(() => { recheckMembers(db, { fetchFn }).then((r) => { if (r.errors.length) console.warn(`[github-login] 复查组织成员资格有 ${r.errors.length} 人没查通：${r.errors[0].error}`); }).catch((e) => console.warn(`[github-login] 复查失败：${e.message}`)); }, 3600_000) : null;
  ghRecheck?.unref?.();
  // 运行时的结论（可用 / 不可用）上一拍是什么；current() 带缓存、过期了在后台重探，这里只读结论
  let lastRtOk = runtimeHealth?.current?.()?.ok;
  const rtChanged = () => {
    const ok = runtimeHealth?.current?.()?.ok;
    if (ok === undefined || ok === lastRtOk) return false;
    const was = lastRtOk; lastRtOk = ok;
    return was !== undefined;
  };
  const ticker = setInterval(() => {
    dropRevoked();
    const m = db.one(`SELECT COALESCE(MAX(id),0) m FROM audit_log`).m;
    if (m !== lastAuditId) {
      const rows = db.all(`SELECT id, ts, action, target_type, target_id FROM audit_log WHERE id>? ORDER BY id`, lastAuditId);
      lastAuditId = m;
      // 按可见性过滤：原来每条审计行（动作 + 对象 id）广播给所有连着的人，
      // 看不见的成员项目也一样。行不多，逐行查归属、按人判可见；系统 / 用户类的行不涉及任务内容，照发。
      const scopeOf = new Map(rows.map((r) => [r.id, rowScope(r)]));
      for (const c of clients) {
        const seen = new Map();
        const mine = rows.filter((r) => {
          const sc = scopeOf.get(r.id);
          const key = sc.taskId ? `t:${sc.taskId}` : sc.projectId ? `p:${sc.projectId}` : null;
          if (!key) return true;
          if (!seen.has(key)) seen.set(key, sc.taskId ? canSeeTask(db, sc.taskId, c.__who) : canSeeProject(db, sc.projectId, c.__who));
          return seen.get(key);
        });
        c.write(`event: change\ndata: ${JSON.stringify({ rows: mine })}\n\n`);
      }
    } else if (rtChanged()) {
      // 容器运行时掉了 / 恢复了不写审计，原来页面要等别的事触发刷新才知道 —— 走查时横幅一直说"沙箱用不了"，
      // 实际早就好了。状态一变就推一次空的 change，页面照常重拉任务列表（横幅、运行状况的小圆点跟着变）
      for (const c of clients) c.write(`event: change\ndata: ${JSON.stringify({ rows: [] })}\n\n`);
    } else {
      for (const c of clients) c.write(': ping\n\n');
    }
  }, pollMs);

  // cookie 按主机名分、不按端口分：同一台机器上两个看板（例如 7357 的本机看板和 7560 的团队测试看板）会互相收到对方的
  // 会话 cookie —— 本机看板收到一枚认不得的就 401、弹出团队模式的登录页；团队看板之间还会把会话令牌送给另一个部署。
  // 所以：对外地址带端口时 cookie 名带上端口；本机模式从来不发 cookie，也就不读（它用页面存的令牌走请求头）
  const tokenOf = (req) => {
    const h = req.headers['x-superintern-token'];
    if (h) return String(h).trim();
    if (!team) return null;
    const m = new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
    return m ? decodeURIComponent(m[1]) : null;
  };
  // 来源地址。反向代理和看板在同一台机器上时 socket 地址永远是本机 —— 从本机代理来的请求取 X-Forwarded-For 的最后一段（代理自己追加的那段，客户端伪造不了）
  const clientIp = (req) => {
    const remote = req.socket.remoteAddress ?? '?';
    const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return /^(127\.|::1$|::ffff:127\.)/.test(remote) && xff.length ? xff[xff.length - 1] : remote;
  };
  // 身份：带上这枚令牌的 id、类型、作用域。同一个请求里多处调用只认证一次（顺带"最后使用"也只记一次）
  const identity = (req) => {
    if (req.__me) return req.__me;
    const t = tokenOf(req) || fallbackToken;
    const a = authenticate(db, t, { ip: clientIp(req) });
    if (!a) throw new Error('令牌无效或已吊销');
    req.__me = { userId: a.user_id, role: db.one(`SELECT role FROM users WHERE id=?`, a.user_id)?.role, token: t, tokenId: a.token_id, kind: a.kind, scope: a.scope, userKind: a.user_kind };
    return req.__me;
  };
  // 页面用哪种语言出：浏览器上选过的（cookie si_lang）→ 登录的人自己的 → 部署的内容语言
  const pageLang = (req) => {
    const c = /(?:^|;\s*)si_lang=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (normLang(c)) return normLang(c);
    const a = authenticate(db, tokenOf(req) || fallbackToken);
    return a ? userLang(db, a.user_id) : contentLang(db);
  };
  // ── 乐观并发：可编辑的配置带一个版本号（当前内容的哈希）；保存时带上打开时看到的版本，对不上就 409 ——
  //    原来两个人同时改决策路由，后保存的一方整表覆盖前一个人的改动，谁也不知道。不带版本（命令行、老页面）照旧不查。
  const verOf = (...parts) => sha256(JSON.stringify(parts)).slice(0, 16);
  const routingVersion = (key) => verOf(rulesOf(db, key), profileOf(db, key), dutyCalendarOf(db, key));
  const llmVersion = () => verOf(db.all(`SELECT * FROM llm_endpoints ORDER BY id`), db.all(`SELECT * FROM llm_models ORDER BY key`), db.all(`SELECT * FROM llm_bindings ORDER BY tier`), db.all(`SELECT * FROM llm_role_bindings ORDER BY role`));
  const egressVersion = () => verOf(db.all(`SELECT * FROM egress_sources ORDER BY id`));
  const requireVersion = (sent, current, what, lastSql, ...lastArgs) => {
    if (sent == null || sent === '' || sent === current) return;
    const L = contentLang(db);
    const last = db.one(`SELECT l.ts, u.display_name FROM audit_log l LEFT JOIN users u ON u.id=l.actor_id WHERE ${lastSql} ORDER BY l.id DESC LIMIT 1`, ...lastArgs);
    throw Object.assign(new I18nError('{what}在你打开之后被 {who} 于 {when} 改过；页面已载入最新的内容，请在它上面重做你的改动', {
      what: tl(L, what), who: last?.display_name ?? tl(L, '别人'), when: last ? `${new Date(last.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC` : tl(L, '刚才') }), { status: 409, conflict: true });
  };
  const cookie = (value, maxAge) =>`${TOKEN_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const ghStateCookie = (value, maxAge) => `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=/api/auth/github; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  // 失败回首页带原因与 GitHub 账号（让人知道是哪个号被拒；只带合法形状的账号名）
  const redirectLoginError = (res, code, login = null) => { res.writeHead(302, { location: `/?login_error=${encodeURIComponent(LOGIN_ERRORS.includes(code) ? code : 'github')}${login && GH_LOGIN_RE.test(login) ? `&gh=${encodeURIComponent(login)}` : ''}`, 'set-cookie': ghStateCookie('', 0), 'cache-control': 'no-store' }); return res.end(); };
  // ── 成员。读：所有人（没有令牌明文与通道地址）；写：负责人，本人可以管自己的通道与令牌。 ──
  const usersPayload = (me, lang) => ({ users: usersView(db).map((u) => (me.role === 'lead' || u.id === me.userId ? u : { ...u, commitEmail: null })), settings: settingsView(db), githubLogin: { enabled: team && githubLoginConfig(db).enabled }, local: authenticate(db, tokenPlain)?.user_id ?? null,
    // 签收例外批准习惯：只给管理员（看别人的批准节奏是负责人的事）
    habits: me.role === 'lead' ? { rows: approvalHabits(db), rule: HABIT } : null,
    requests: listHandoverRequests(db, { status: 'open' }).map((r) => ({ ...r, canDecide: canDecideHandover(db, { byUserId: me.userId, scope: r.scope }) })).filter((r) => r.canDecide || r.fromUserId === me.userId).map((r) => {
      try { const pv = previewHandover(db, { fromUserId: r.fromUserId, toUserId: r.toUserId, scope: r.scope, thenDisable: r.thenDisable, byUserId: me.userId }); return { ...r, text: renderHandover(pv, lang), needsQuorumConfirm: !!pv.needsQuorumConfirm }; }
      catch (e) { return { ...r, text: null, error: translateError(e, lang) }; }
    }) });
  // 追溯在哪个仓库里查：任务自己的工作区；没有（已清理）就退到项目仓库（合并进去的提交还在）
  const traceDirOf = (taskId) => {
    const ws = join(home, 'workspaces', taskId);
    if (existsSync(ws)) return ws;
    const p = db.one(`SELECT p.repo FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`, taskId);
    return p?.repo && existsSync(p.repo) ? p.repo : null;
  };
  const whoOf = (req) => { try { return identity(req).userId; } catch { return null; } };
  const localTokenOk = () => !!authenticate(db, tokenPlain);
  const LOCAL_TOKEN_BAD = '看板的本机令牌无效或已吊销；请用命令行重新生成令牌后重启看板';

  /**
   * 路由表（2026-10-12）。原来是 40 来个 if 依次判断，每个处理函数自己决定查不查身份、查不查可见性 ——
   * 写接口不过可见性、路由表 / 联网目录 / 仓库清单把"仅成员可见"项目的东西列给所有人（路由表补的三处）都出在这里。
   * 现在每条路由**必须**声明 auth，粗粒度那一层在分派处统一执行，没声明或写错的启动即报错；授权矩阵测试按这张表逐条生成。
   *   public   不要身份（页面、会话探测、登录 / 登出、词表）—— 必须正好是 TEAM_OPEN_PATHS ∪ {'/'}
   *   session  要有效身份：团队模式没有就 401；本机模式用本机令牌兜底
   *   admin    要管理员（role=lead），否则 403
   *   project  路径（或 projectFrom 指出的参数）里的项目对请求人可见，否则 404（不泄露存在）
   *   task     路径里的任务对请求人可见，否则 404
   * 更细的权限（是不是该项目负责人、能不能添加任务、路由表归谁……）仍在处理函数 / 领域函数里判。
   * 策略拒绝的响应带 x-si-deny 头（测试据此区分"粗粒度挡下"与"处理函数自己的 4xx"）。
   */
  const ROUTES = [
    // 不许被别的页面嵌进 iframe（点击劫持：团队模式下页面对内网可见，别的站可以把它叠在一个诱饵按钮下面）
    { method: 'GET', path: '/', auth: 'public', handler: (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY', 'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }); return res.end(pageHtml(pageLang(req))); } },
    // 存活探针：不鉴权、不看 Host（负载均衡 / 容器编排按 IP 探），只回答"进程在、库能读"，不带版本等任何信息
    { method: 'GET', path: '/healthz', auth: 'public', handler: (req, res) => {
      req.resume();
      let ok = false; try { ok = db.one(`SELECT 1 AS x`)?.x === 1; } catch { /* 库读不了 */ }
      return json(res, ok ? 200 : 503, { ok });
    } },
    // 部署健康：只给管理员（库路径、备份目录、版本号都在里面）
    { method: 'POST', path: '/api/health/recheck', auth: 'admin', denied: '只有管理员能处理运行状况里的提醒', handler: async (req, res) => {
      const body = await readBody(req);
      try { ackRecheck(db, { id: String(body.id ?? ''), userId: identity(req).userId }); } catch (e) { return json(res, 400, { error: e.message }); }
      return json(res, 200, { ok: true });
    } },
    { method: 'GET', path: '/api/health', auth: 'admin', denied: '只有管理员能看运行状况', handler: (req, res) => json(res, 200, deploymentHealth(db, { home, inProcessDaemon: !!daemon, runtime: runtimeHealth ? runtimeHealth.current() : undefined, build: BUILD })) },
    // 看板脚本：只发 index.html 引用的那几个（启动时读进内存，不按请求拼路径）；登录页也要用，所以 public。里面没有秘密（和页面一样是公开的代码）
    { method: 'GET', re: APP_SCRIPT_RE, auth: 'public', static: true, handler: (req, res, { params }) => {
      req.resume();
      const body = appScriptBodies.get(params[0]);
      if (!body) return json(res, 404, { error: '接口不存在' });
      // no-cache：每次都问一声（升级后不会跑旧脚本），没变就 304
      const fresh = req.headers['if-none-match'] === body.etag;
      res.writeHead(fresh ? 304 : 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag: body.etag });
      return res.end(fresh ? undefined : body.text);
    } },
    { method: 'GET', path: '/api/session', auth: 'public', handler: (req, res, { url }) => {
      const a = authenticate(db, tokenOf(req) || fallbackToken);
      const err = url.searchParams.get('login_error');
      const gcfg = team ? githubLoginConfig(db) : null;
      const gh = url.searchParams.get('gh');
      const github = team ? { enabled: gcfg.enabled, org: gcfg.enabled ? gcfg.org : null, error: LOGIN_ERRORS.includes(err) ? loginErrorText(res.__lang, err, { login: gh && GH_LOGIN_RE.test(gh) ? gh : null, org: gcfg.org }) : null,
        linked: a && gh && GH_LOGIN_RE.test(gh) && url.searchParams.get('github_linked') === '1' ? gh : null } : undefined;
      const limits = team && !a ? { idleHours: Number(getSetting(db, 'deploy.session_idle_hours')), maxDays: Number(getSetting(db, 'deploy.session_max_days')) } : undefined;
      // 没登录的新人得知道去找谁要令牌（只写"找本看板的管理员"不够，管理员是谁页面上没有）。只给管理员的显示名，别的一概不给。
      const admins = team && !a ? db.all(`SELECT display_name FROM users WHERE role='lead' AND disabled_at IS NULL ORDER BY created_at`).map((u) => u.display_name) : undefined;
      return json(res, 200, { team, loggedIn: !!a, admins, github, limits });
    } },
    // 用 GitHub 登录（core/github-login.mjs）：浏览器整页跳转，不是 fetch —— 成败都 302 回看板首页，失败带 ?login_error=<原因>
    { method: 'GET', path: '/api/auth/github', auth: 'public', handler: (req, res) => {
      req.resume();
      if (!team) return json(res, 404, { error: '本机模式不用登录' });
      try {
        // 已登录的人发起 = 把 GitHub 账号验证并绑到自己身上（关联账号）；没登录 = 用 GitHub 登录
        const cur = authenticate(db, tokenOf(req), { touch: false });
        const { url, state } = beginLogin(db, { redirectUri: new URL(CALLBACK_PATH, pub).toString(), linkUserId: cur && cur.user_kind !== 'service' ? cur.user_id : null });
        // state 另放一份在 cookie：回调时两边对上才算（防登录 CSRF）。Lax：从 github.com 跳回来的顶层 GET 要带上它
        res.writeHead(302, { location: url, 'set-cookie': ghStateCookie(state, 600), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      } catch (e) { return redirectLoginError(res, e instanceof LoginError ? e.code : 'github', e.login); }
    } },
    { method: 'GET', path: '/api/auth/github/callback', auth: 'public', handler: async (req, res, { url }) => {
      req.resume();
      if (!team) return json(res, 404, { error: '本机模式不用登录' });
      const ip = clientIp(req);
      const t0 = Date.now();
      const f = loginFails.get(ip);
      if (f && f.until > t0 && f.n >= LOGIN_MAX_FAILS) return redirectLoginError(res, 'github');
      const cookieState = new RegExp(`(?:^|;\\s*)${STATE_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] ?? null;
      try {
        if (url.searchParams.get('error')) throw new LoginError('github', url.searchParams.get('error'));   // 在 GitHub 上点了取消
        const { verifier, linkUserId } = takeState(url.searchParams.get('state'), cookieState ? decodeURIComponent(cookieState) : null);
        const r = await finishLogin(db, { code: url.searchParams.get('code'), verifier, linkUserId, redirectUri: new URL(CALLBACK_PATH, pub).toString(), ip, fetchFn });
        loginFails.delete(ip);
        if (r.linked) { res.writeHead(302, { location: `/?github_linked=1&gh=${encodeURIComponent(r.login)}`, 'set-cookie': ghStateCookie('', 0), 'cache-control': 'no-store' }); return res.end(); }
        res.writeHead(302, { location: '/', 'set-cookie': [cookie(r.session.plaintext, Math.floor(r.session.maxAgeMs / 1000)), ghStateCookie('', 0)], 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end();
      } catch (e) {
        const cur = f && f.until > t0 ? f : { n: 0, until: t0 + LOGIN_WINDOW_MS };
        cur.n++; loginFails.set(ip, cur);
        return redirectLoginError(res, e instanceof LoginError ? e.code : 'github', e.login);
      }
    } },
    { method: 'POST', path: '/api/login', auth: 'public', handler: async (req, res) => {
      if (!team) return json(res, 404, { error: '本机模式不用登录；换身份用「切换身份」' });
      // 限速按来源地址（clientIp：经本机反向代理来的取 X-Forwarded-For 最后一段 —— 不然所有人共用一个桶，一个人连错 20 次就把全员锁 10 分钟）
      const ip = clientIp(req);
      const t0 = Date.now();
      const f = loginFails.get(ip);
      if (f && f.until > t0 && f.n >= LOGIN_MAX_FAILS) { req.resume(); return json(res, 429, { error: '这台电脑登录失败次数太多，请 10 分钟后再试' }); }
      const body = await readBody(req);
      const tok = String(body.token ?? '').trim();
      const a = tok ? authenticate(db, tok, { ip }) : null;
      if (!a) {
        const cur = f && f.until > t0 ? f : { n: 0, until: t0 + LOGIN_WINDOW_MS };
        cur.n++; loginFails.set(ip, cur);
        return json(res, 401, { error: '令牌不对，或已被吊销。令牌由管理员在「设置 → 成员」里发给你' });
      }
      loginFails.delete(ip);
      // 用这枚令牌换一个浏览器会话：cookie 里只放会话令牌（闲置 / 绝对过期、退出即吊销），长期令牌不再进浏览器
      const s = createSession(db, { login: a, ip });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie(s.plaintext, Math.floor(s.maxAgeMs / 1000)) });
      return res.end(JSON.stringify({ ok: true }));
    } },
    { method: 'POST', path: '/api/logout', auth: 'public', handler: (req, res) => {
      req.resume();
      // 退出 = 服务端吊销这个会话（原来只清 cookie，拿到 cookie 的人照样能用）
      try { const me = identity(req); if (team || me.kind === 'session') endSession(db, { tokenId: me.tokenId, userId: me.userId }); } catch { /* 本来就无效 */ }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie('', 0) });
      return res.end(JSON.stringify({ ok: true }));
    } },
    // ── 邀请链接：看与接受不要身份（拿着链接的人还没有账号）；发、撤、列由管理员 ──
    { method: 'GET', path: '/api/invites/peek', auth: 'public', handler: (req, res, { url }) => {
      const i = inviteByCode(db, url.searchParams.get('code'));
      return i ? json(res, 200, { ok: true, role: i.role, name: i.name, expiresAt: i.expires_at, team }) : json(res, 410, { error: '邀请链接无效、已用过、已撤销或已过期；请找管理员重新发一个' });
    } },
    { method: 'POST', path: '/api/invites/accept', auth: 'public', handler: async (req, res) => {
      if (!team) { req.resume(); return json(res, 404, { error: '本机模式不用邀请；加人请在「设置 → 成员」里加' }); }
      const ip = clientIp(req);
      const t0 = Date.now();
      const f = loginFails.get(ip);
      if (f && f.until > t0 && f.n >= LOGIN_MAX_FAILS) { req.resume(); return json(res, 429, { error: '这台电脑登录失败次数太多，请 10 分钟后再试' }); }
      const body = await readBody(req);
      let r;
      try { r = acceptInvite(db, { code: String(body.code ?? ''), name: body.name, ip }); }
      catch (e) {
        if (e.status === 410) { const cur = f && f.until > t0 ? f : { n: 0, until: t0 + LOGIN_WINDOW_MS }; cur.n++; loginFails.set(ip, cur); }
        throw e;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie(r.session.plaintext, Math.floor(r.session.maxAgeMs / 1000)) });
      // 命令行令牌只此一次给出（要在命令行用 / 换电脑登录时用）；看板已经用会话登录上了
      return res.end(JSON.stringify({ ok: true, userId: r.userId, role: r.role, cliToken: r.cli.plaintext, cliExpiresAt: r.cli.expiresAt }));
    } },
    // 界面语言（0.2.0）：词表公开（登录页也要用，里面没有秘密）
    { method: 'GET', path: '/api/i18n', auth: 'public', handler: (req, res, { url }) => { const l = normLang(url.searchParams.get('lang')) ?? res.__lang; return json(res, 200, { lang: l, catalog: CATALOGS[l] ?? {} }); } },
    { method: 'GET', path: '/api/events', auth: 'session', handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ lastAuditId, build: BUILD })}\n\n`);
      try { const me = identity(req); res.__who = me.userId; res.__tok = me.token; } catch { res.__who = null; res.__tok = null; }
      clients.add(res); req.on('close', () => clients.delete(res));
    } },
    { method: 'GET', path: '/api/tasks', auth: 'session', handler: (req, res) => {
      // "与我有关"：我负责的，或有开放事项指到我 / 知会我的。纯查询，不落任何状态；侧栏的筛选用它。
      const who = whoOf(req);
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
      const isAdmin = !!who && db.one(`SELECT role FROM users WHERE id=?`, who)?.role === 'lead';
      return json(res, 200, { tasks, projects: projs, limits: Object.keys(LIMITS), daemon: daemon || daemonStatus(home).alive, daemonInfo: { ...daemonStatus(home), inProcess: !!daemon },
        // 容器运行时：上一次探测的结论（null = 还没探过）；不等探测，页面不会被卡住
        runtime: runtimeHealth ? runtimeHealth.current() : null,
        paused: !!getSetting(db, 'deploy.paused'), isAdmin,
        // 公告：所有人都看；at 区分"同一条"与"新的一条"（各人收起的是哪一条）
        announcement: (() => { const text = getSetting(db, 'deploy.announcement'); return text ? { text, at: settingSetAt(db, 'deploy.announcement')?.at ?? null } : null; })(),
        // 运行状况最坏的级别（只给管理员）：设置页「运行状况」上的小圆点
        health: isAdmin ? deploymentHealth(db, { home, inProcessDaemon: !!daemon, runtime: runtimeHealth ? runtimeHealth.current() : undefined }).worst : null,
        sqlite: sqliteNote && isAdmin ? sqliteNote : null });
    } },
    // 新建入口的"最近用过的仓库"：只列请求人看得见的项目 / 任务用过的（原来连仅成员可见项目的仓库地址也列给所有人）
    { method: 'GET', path: '/api/repos', auth: 'session', handler: (req, res) => { const who = whoOf(req); return json(res, 200, { repos: knownRepos(db, { canSeeProject: (id) => canSeeProject(db, id, who), canSeeTask: (id) => canSeeTask(db, id, who) }) }); } },
    { method: 'GET', path: '/api/me', auth: 'session', handler: (req, res) => { const me = controls.me({ _token: tokenOf(req) }); return json(res, 200, { ...me, canCreate: canCreate(db, me.id).ok, users: listUsers(db), lang: userLang(db, me.id), ownLang: db.one(`SELECT lang FROM users WHERE id=?`, me.id)?.lang ?? null, contentLang: contentLang(db),
      // 时刻按谁的时区显示：自己设的 → 部署的
      tz: viewerTz(db, me.id), ownTz: db.one(`SELECT tz FROM users WHERE id=?`, me.id)?.tz ?? null, deployTz: calendarOf(db).tz }); } },
    // 每人改自己的时区（只影响给自己看的时刻），空 = 跟部署时区
    { method: 'POST', path: '/api/me/tz', auth: 'session', handler: async (req, res) => {
      const me = identity(req); const body = await readBody(req);
      const z = body.tz == null ? '' : String(body.tz).trim();
      if (z && !validTz(z)) return json(res, 400, { error: new I18nError('不认识的时区：{tz}（应为 IANA 时区名，如 Asia/Shanghai）', { tz: z.slice(0, 64) }) });
      updateUser(db, me.userId, { tz: z || null });
      return json(res, 200, { ok: true, tz: viewerTz(db, me.userId), ownTz: z || null });
    } },
    // 部署日历：时区、节假日原文、接下来 120 天里与平常不同的日子（周中放假 / 周末补班）。所有登录的人能看，改在「设置」里由管理员
    { method: 'GET', path: '/api/calendar', auth: 'session', handler: (req, res) => {
      const cal = calendarOf(db), at = Date.now(), today = dayKey(at, cal.tz);
      const special = [];
      for (let i = 0, k = today; i < 120; i++, k = addDaysKey(k, 1)) {
        const wd = weekdayOfKey(k), weekend = wd === 0 || wd === 6, work = isBusinessDay(k, cal);
        if (weekend === work || cal.names.has(k)) special.push({ day: k, weekday: wd, work, name: cal.names.get(k) ?? null });
      }
      return json(res, 200, { tz: cal.tz, set: !!getSetting(db, 'deploy.timezone'), systemTz: systemTz(), now: fmtAt(at, cal.tz), today, ending: calendarHealth(db, at).ending, daysLeft: calendarHealth(db, at).daysLeft, holidays: getSetting(db, 'deploy.holidays'), holidaysUntil: cal.last, upcoming: special });
    } },
    // 每人改自己的界面语言，null = 跟随部署的内容语言
    { method: 'POST', path: '/api/me/lang', auth: 'session', handler: async (req, res) => {
      const me = identity(req); const body = await readBody(req);
      const l = body.lang == null || body.lang === '' ? null : normLang(body.lang);
      if (body.lang != null && body.lang !== '' && !l) return json(res, 400, { error: new I18nError('不认识的语言：{lang}', { lang: body.lang }) });
      updateUser(db, me.userId, { lang: l });
      return json(res, 200, { ok: true, lang: userLang(db, me.userId), ownLang: l });
    } },
    // 待决事项打包摘要：按请求身份现算，跨任务。旁观者也能调，结果是空的（解析器不把旁观者放进收件人）。
    { method: 'GET', path: '/api/digest', auth: 'session', handler: (req, res) => { const me = identity(req); const d = buildDigest(db, { userId: me.userId, daemonAlive: daemon || daemonStatus(home).alive }); return json(res, 200, { ...d, text: renderDigest(d) }); } },
    // ── 角色与路由。读：看得见那个项目的人（原来不看可见性，仅成员可见项目的路由表与人名谁都拉得到）；写：负责人。 ──
    { method: 'GET', path: '/api/routing', auth: 'project', projectFrom: ({ url }) => url.searchParams.get('project') || null, handler: (req, res, { url }) => {
      const key = url.searchParams.get('project') || '';
      const rules = rulesOf(db, key);
      const prof = profileOf(db, key);
      return json(res, 200, { key, template: prof.template ?? 'solo', persisted: !!prof.updated_at, bindings: safeJson(prof.bindings) ?? {}, rows: rules, knobs: knobsOf(db, key), diff: diffFromTemplate(db, key),
        templates: Object.fromEntries(Object.entries(loadTemplates()).map(([k, t]) => [k, { label: t.label, summary: t.summary, placeholders: t.placeholders ?? {}, mask: t.mask }])),
        types: Object.fromEntries(Object.entries(DECISION_TYPES).map(([k, t]) => [k, { label: t.label, desc: t.desc, level3: t.level3 }])),
        users: listUsers(db), duty: dutyCalendarOf(db, key), dutyView: dutyView(db, key), lead: leadOfKey(db, key), preview: previewRouting(db, { key, rules }), version: routingVersion(key) });
    } },
    { method: 'POST', path: '/api/routing', auth: 'session', handler: async (req, res) => {
      const body = await readBody(req);
      const me = identity(req);
      const key = body.project || '';
      // 项目的表：该项目的负责人；默认表（不属于项目的任务共用）：任何一个负责人 —— 按项目交接后负责人不止一个。
      if (key ? me.userId !== leadOfKey(db, key) : me.role !== 'lead') return json(res, 403, { error: key ? '只有该项目的负责人能修改其决策路由' : '只有管理员能修改默认决策路由' });
      let result;
      if (['template', 'rows', 'owner', 'remove', 'duty', 'dutyOverrides'].includes(body.action)) requireVersion(body.version, routingVersion(key), '决策路由', `l.action IN ('routing_saved','duty_calendar_set','duty_overrides_set') AND l.target_id IN (?, ?)`, key || '(default)', key);
      if (body.action === 'template') result = applyTemplate(db, { key, name: body.name, bindings: body.bindings ?? {}, userId: me.userId, lang: res.__lang });
      else if (body.action === 'rows') result = saveRules(db, { key, rules: body.rows, template: body.template ?? profileOf(db, key).template, bindings: body.bindings ?? safeJson(profileOf(db, key).bindings) ?? {}, userId: me.userId, lang: res.__lang });
      else if (body.action === 'validate') result = { errors: validateRules(db, key, body.rows, { lang: res.__lang }) };
      else if (body.action === 'owner') result = setKnobs(db, { key, ownership: { [body.type]: [].concat(body.recipients ?? []) }, userId: me.userId, lang: res.__lang });
      else if (body.action === 'remove') result = setKnobs(db, { key, removeInterveners: [body.userId], userId: me.userId, lang: res.__lang });
      // 起点：看板给部署时区的日期与墙上时刻（startDay / startTime）；老脚本给毫秒时刻（startAt）
      else if (body.action === 'duty') { setDutyCalendar(db, { key, users: body.users, startAt: body.startDay ? dutyStartAt(db, body.startDay, body.startTime) : Number(body.startAt), periodDays: Number(body.periodDays ?? 7), userId: me.userId }); result = dutyCalendarOf(db, key); }
      else if (body.action === 'dutyOverrides') { setDutyOverrides(db, { key, overrides: body.overrides, userId: me.userId }); result = dutyCalendarOf(db, key); }
      else if (body.action === 'preview') result = previewRouting(db, { key, rules: body.rows ?? rulesOf(db, key) });
      else return json(res, 400, { error: new I18nError('不支持的操作：{action}', { action: body.action }) });
      // 改了表 / 值班 → 已发出、还没人答的事项按新规则改发；改发了几条、哪几条没动，告诉改表的人
      const rerouted = ['template', 'rows', 'owner', 'remove', 'duty', 'dutyOverrides'].includes(body.action) ? rerouteOpen(db, { key, byUserId: me.userId }) : null;
      return json(res, 200, { ok: true, result, version: routingVersion(key), ...(rerouted ? { rerouted } : {}) });
    } },
    // ── 联网目录：读所有人；写只有管理员（addSource / removeSource 自己也查） ──
    // "被哪些项目用着"只列请求人看得见的项目（原来把仅成员可见项目的标题与状态也列给所有人）
    { method: 'GET', path: '/api/egress/sources', auth: 'session', handler: (req, res) => {
      const who = whoOf(req);
      const defaults = getSetting(db, 'deploy.egress_defaults') ?? [];
      const creds = sourceCredentials(db), admin = (() => { try { return identity(req).role === 'lead'; } catch { return false; } })();
      // 像凭据的工具配置（以前录入的）不回显值（null = 有这一项、值不给看）；凭据只给 header 与是否允许写，hint 只给管理员
      return json(res, 200, { sources: egressSources(db).map((x) => ({ ...x, toolEnv: Object.fromEntries(Object.entries(x.toolEnv).map(([k, v]) => [k, secretLike(k, v) ? scrubToolEnv(k, v) : v])),
        secretKeys: Object.entries(x.toolEnv).filter(([k, v]) => secretLike(k, v)).map(([k]) => k),
        credential: creds[x.id] ? { header: creds[x.id].header, allowWrite: creds[x.id].allowWrite, hint: admin ? creds[x.id].hint : null } : null,
        usedBy: sourceUsage(db, x.id).filter((u) => canSeeProject(db, u.id, who)), isDefault: defaults.includes(x.id) })) });
    } },
    { method: 'POST', path: '/api/egress/sources', auth: 'session', handler: async (req, res) => {
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
    } },
    // 连接：推送 / 开 PR 用的凭据。所有人都能看（部署级的与自己的）、能给自己加；部署级的只有管理员能加。
    // 明文只进不出：录入之后任何接口都不回显，列表只有 hint。老部署 .env 里的 GITHUB_TOKEN 作为一条"部署级 · 来自 .env"列出，管理员可清掉。
    { method: 'GET', path: '/api/connections', auth: 'session', handler: (req, res) => json(res, 200, { ...listCredentials(db, { viewerId: identity(req).userId, env }), prefixes: PUSH_PREFIXES,
      provenance: { boardUrl: getSetting(db, 'deploy.board_url'), coauthor: getSetting(db, 'deploy.commit_coauthor') },
      githubLogin: { ...githubLoginConfig(db), team, callbackUrl: pub ? new URL(CALLBACK_PATH, pub).toString() : null } }) },
    { method: 'POST', path: '/api/connections', auth: 'session', handler: async (req, res) => {
      const me = identity(req);
      const body = await readBody(req);
      try {
        if (body.action === 'add') {
          const expiresAt = body.expiresAt ? Number(body.expiresAt) : null;
          const r = addCredential(db, { kind: body.kind, name: body.name, ownerId: body.scope === 'mine' ? me.userId : null, host: body.host || 'github.com', pathGlob: body.pathGlob || '*',
            secret: body.secret, appId: body.appId ?? null, username: body.username || null, expiresAt, byUserId: me.userId });
          return json(res, 200, { ok: true, result: r });
        }
        if (body.action === 'revoke') {
          if (body.id === 'env:GITHUB_TOKEN') {
            if (me.role !== 'lead') return json(res, 403, { error: '只有管理员能清掉 .env 里的 GITHUB_TOKEN' });
            if (!envFile) return json(res, 400, { error: '看板启动时未指定 .env 文件，无法修改' });
            setEnvVar(envFile, 'GITHUB_TOKEN', '', { env });
            audit(db, { actorKind: 'user', actorId: me.userId, action: 'secret_set', targetType: 'secret', targetId: 'GITHUB_TOKEN', payload: { present: false } });
            return json(res, 200, { ok: true, result: true });
          }
          return json(res, 200, { ok: true, result: revokeCredential(db, { id: body.id, byUserId: me.userId }) });
        }
        if (body.action === 'oauth') return json(res, 200, { ok: true, result: setAppOAuth(db, { id: body.id, clientId: body.clientId, clientSecret: body.clientSecret ? body.clientSecret : undefined, byUserId: me.userId }) });
        if (body.action === 'member_check') {
          // 不开浏览器验证 GitHub 登录的配置：App 装没装在组织上、有没有 Members 权限、这个账号算不算成员（管理员）
          if (me.role !== 'lead') return json(res, 403, { error: '只有管理员能设 GitHub 登录' });
          const login = String(body.login ?? '').trim().replace(/^@/, '');
          const org = githubLoginConfig(db).org;
          if (!GH_LOGIN_RE.test(login) || !org) return json(res, 400, { error: '先填组织名，再填一个 GitHub 账号' });
          try { return json(res, 200, { ok: true, result: { member: await isOrgMember(db, { org, login, fetchFn }), login, org } }); }
          catch (e) { return json(res, 200, { ok: true, result: { member: null, login, org, error: e.message } }); }
        }
        if (body.action === 'check') {
          const remote = safePositional(body.remote);
          return json(res, 200, { ok: true, result: await checkAccess(db, { remote, action: ['read', 'push', 'pr'].includes(body.mode) ? body.mode : 'push', actorId: me.userId, env, fetchFn }) });
        }
        return json(res, 400, { error: '未知操作' });
      } catch (e) { return json(res, 400, { error: e }); }
    } },
    // ── 注册表三层：服务商 / 模型 / 绑定。读：所有人（key 只报填没填）；写：管理员。凭证只写 .env，不进库不回显。 ──
    { method: 'GET', path: '/api/llm', auth: 'session', handler: (req, res) => json(res, 200, { ...llmView(db, { env, lang: res.__lang }), version: llmVersion() }) },
    { method: 'POST', path: '/api/llm', auth: 'admin', denied: '只有管理员能修改服务商、模型与模型分配', handler: async (req, res) => {
      const body = await readBody(req);
      const userId = identity(req).userId;
      let result;
      if (['endpoint_save', 'endpoint_enable', 'endpoint_remove', 'model_save', 'model_remove', 'bind_set', 'role_bind_set'].includes(body.action)) {
        requireVersion(body.version, llmVersion(), '服务商、模型与模型分配', `l.target_type IN ('endpoint','model','binding')`);
      }
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
      // 角色单独绑定（key 空 = 回到档位）；验收员策略是两条部署设置，写入走设置的同一个入口（审计、校验都在那里）
      else if (body.action === 'fallback_set') result = setFallback(db, { tier: body.tier, modelKey: body.key || null, userId });
      else if (body.action === 'role_bind_set') result = setRoleBinding(db, { role: body.role, modelKey: body.key || null, effort: body.effort || null, userId });
      else if (body.action === 'verifier_policy') {
        if (body.vendor != null) setSetting(db, { key: 'deploy.verifier_vendor', value: body.vendor, userId });
        if (body.cosign != null) setSetting(db, { key: 'deploy.verifier_cosign', value: body.cosign, userId });
        result = { policy: getSetting(db, 'deploy.verifier_vendor'), cosign: getSetting(db, 'deploy.verifier_cosign') };
      }
      else if (body.action === 'catalog_check') {
        const reg = checkableCatalog(db);
        const r = await checkCatalog({ catalog: reg.catalog, vendors: reg.vendors, env, fetchFn, probe: !!body.probe, only: body.vendor || null, lang: contentLang(db) });
        recordCatalogCheck(db, r, { by: userId, actorKind: 'user', lang: contentLang(db) });
        result = { warnings: r.warnings, fetchErrors: r.fetchErrors, keys: r.keys };
      }
      else return json(res, 400, { error: new I18nError('不支持的操作：{action}', { action: body.action }) });
      return json(res, 200, { ok: true, result, view: { ...llmView(db, { env, lang: res.__lang }), version: llmVersion() } });
    } },
    // ── 我的会话与令牌：每人管自己的；管理员另能看、能吊销所有人的 ──
    { method: 'GET', path: '/api/me/tokens', auth: 'session', handler: (req, res, { url }) => { const me = identity(req); return json(res, 200, { tokens: tokensOf(db, me.userId, { current: me.tokenId, all: url.searchParams.get('all') === '1' }), current: me.tokenId, cliDays: Number(getSetting(db, 'deploy.cli_token_days')) }); } },
    { method: 'POST', path: '/api/me/tokens', auth: 'session', handler: async (req, res) => {
      const me = identity(req); const body = await readBody(req);
      const name = String(body.name ?? '').trim().slice(0, 60);
      if (!name) return json(res, 400, { error: '给这枚令牌起个名字（比如"笔记本命令行"），以后才认得出该吊销哪一枚' });
      const t = issueToken(db, { userId: me.userId, by: me.userId, name, scope: body.scope ?? 'write', days: body.days == null || body.days === '' ? undefined : Number(body.days), kind: me.userKind === 'service' ? 'service' : 'cli' });
      audit(db, { actorKind: 'user', actorId: me.userId, action: 'token_issued', targetType: 'user', targetId: me.userId, payload: { tokenId: t.tokenId, name, scope: body.scope ?? 'write', expiresAt: t.expiresAt } });
      return json(res, 200, { tokenId: t.tokenId, plaintext: t.plaintext, expiresAt: t.expiresAt });
    } },
    { method: 'POST', path: '/api/me/tokens/revoke', auth: 'session', handler: async (req, res) => {
      const me = identity(req); const body = await readBody(req);
      return json(res, 200, { revoked: revokeTokenBy(db, { tokenId: String(body.id ?? ''), byUserId: me.userId, isAdmin: false }) });
    } },
    { method: 'POST', path: '/api/me/tokens/revoke-others', auth: 'session', handler: (req, res) => {
      req.resume(); const me = identity(req);
      return json(res, 200, { revoked: revokeAllOf(db, { userId: me.userId, byUserId: me.userId, keep: me.tokenId }) });
    } },
    // ── 花费：每个人本月 / 上月 / 预算 / 近两周每天；管理员看全员，别人只看自己那一行 ──
    { method: 'GET', path: '/api/spend', auth: 'session', handler: (req, res) => {
      const me = identity(req);
      const s = spendByPerson(db);
      const admin = me.role === 'lead';
      return json(res, 200, { ...s, rows: admin ? s.rows : s.rows.filter((r) => r.userId === me.userId), admin,
        deployment: admin ? s.deployment : null, attribution: getSetting(db, 'deploy.cost_attribution'),
        personDefault: Number(getSetting(db, 'deploy.person_budget_usd_month')), perPersonCap: Number(getSetting(db, 'deploy.max_running_per_person')) });
    } },
    { method: 'POST', path: '/api/spend/budget', auth: 'admin', denied: '只有管理员能设个人月度预算', handler: async (req, res) => {
      const me = identity(req); const body = await readBody(req);
      if (!db.one(`SELECT 1 x FROM users WHERE id=?`, String(body.userId ?? ''))) return json(res, 400, { error: new I18nError('成员不存在：{id}', { id: body.userId }) });
      return json(res, 200, setPersonBudget(db, { userId: String(body.userId), usd: body.usd ?? null, byUserId: me.userId }));
    } },
    { method: 'GET', path: '/api/admin/tokens', auth: 'admin', handler: (req, res) => json(res, 200, { tokens: activeTokens(db) }) },
    { method: 'POST', path: '/api/admin/tokens/revoke', auth: 'admin', handler: async (req, res) => {
      const me = identity(req); const body = await readBody(req);
      if (body.userId) return json(res, 200, { revoked: revokeAllOf(db, { userId: String(body.userId), byUserId: me.userId }) });
      return json(res, 200, { revoked: revokeTokenBy(db, { tokenId: String(body.id ?? ''), byUserId: me.userId, isAdmin: true }) });
    } },
    { method: 'GET', path: '/api/invites', auth: 'admin', handler: (req, res) => json(res, 200, { invites: invitesList(db), team, hours: Number(getSetting(db, 'deploy.invite_hours')) }) },
    { method: 'POST', path: '/api/invites', auth: 'admin', handler: async (req, res) => {
      const me = identity(req); const body = await readBody(req);
      const r = createInvite(db, { byUserId: me.userId, role: body.role ?? 'member', name: body.name || null, hours: body.hours == null || body.hours === '' ? undefined : Number(body.hours) });
      // 链接用对外地址（团队模式的 --public-url）；没有就用这次请求的来源
      const origin = pub ? pub.origin : `http://${req.headers.host ?? `${host}:${port}`}`;
      return json(res, 200, { inviteId: r.inviteId, link: `${origin}/?invite=${encodeURIComponent(r.code)}`, expiresAt: r.expiresAt });
    } },
    { method: 'POST', path: '/api/invites/revoke', auth: 'admin', handler: async (req, res) => {
      const me = identity(req); const body = await readBody(req);
      return json(res, 200, { revoked: revokeInviteBy(db, { inviteId: String(body.id ?? ''), byUserId: me.userId }) });
    } },
    { method: 'GET', path: '/api/users', auth: 'session', handler: (req, res) => json(res, 200, usersPayload(identity(req), res.__lang)) },
    // 权限一览（只读）：所有成员都能看任何人的 —— 与"所有成员可读全部项目"同一条边界。
    { method: 'GET', path: '/api/permissions', auth: 'session', handler: (req, res, { url }) => { const me = identity(req); return json(res, 200, permissionsOf(db, url.searchParams.get('user') || me.userId)); } },
    // 写：管理员；成员本人只能改自己的通知通道与令牌（这一层在下面判，粗粒度只要求有身份）
    { method: 'POST', path: '/api/users', auth: 'session', handler: async (req, res) => {
      const body = await readBody(req);
      const me = identity(req);
      const self = body.userId && body.userId === me.userId;
      const selfOk = ['channel_set', 'channel_remove', 'token', 'git_identity'].includes(body.action) || (!body.action && body.channel);
      if (me.role !== 'lead' && !(self && selfOk)) return json(res, 403, { error: '只有管理员能管理成员；成员本人只能修改自己的通知通道、令牌与 GitHub 账号' });
      const by = { userId: body.userId, byUserId: me.userId };
      let result = null;
      if (!body.action && body.channel) setUserChannel(db, { ...by, kind: body.channel, target: body.target });
      else if (!body.action || body.action === 'add') result = addUser(db, { name: body.name, role: body.role, tags: body.tags ?? [], byUserId: me.userId });   // 令牌明文只在这一次响应里出现，库里只有哈希
      else if (body.action === 'rename') result = renameUser(db, { ...by, name: body.name });
      else if (body.action === 'role') result = setUserRole(db, { ...by, role: body.role });
      else if (body.action === 'tags') setUserTags(db, { ...by, tags: body.tags ?? [] });
      else if (body.action === 'channel_set') setUserChannel(db, { ...by, kind: body.kind, target: body.target });
      else if (body.action === 'channel_remove') result = removeUserChannel(db, { ...by, kind: body.kind });
      else if (body.action === 'git_identity') result = setGitIdentity(db, { ...by, github: body.github, email: body.email });
      else if (body.action === 'token') {
        // 看板不带令牌时的身份就是本机令牌文件；在这里重发它会让看板和守护进程一起失去身份。CLI 会同步改写令牌文件。
        if (body.userId === authenticate(db, tokenPlain)?.user_id) return json(res, 400, { error: '不能在看板中重新生成本机身份的令牌。请运行 node src/cli.mjs user token <id>，然后重启看板与守护进程' });
        result = reissueToken(db, by);                                                      // 明文同样只出现这一次
      }
      else if (body.action === 'disable') { try { result = disableUser(db, by); } catch (e) { return json(res, 400, { error: e, needsHandover: !!e.needsHandover }); } }
      else if (body.action === 'enable') result = enableUser(db, by);
      else if (body.action === 'setting') result = setSetting(db, { key: body.key, value: body.value, userId: me.userId });
      else return json(res, 400, { error: new I18nError('不支持的操作：{action}', { action: body.action }) });
      return json(res, 200, { ok: true, result, ...usersPayload(me, res.__lang) });
    } },
    // 交接：预览（真做一遍再回滚）/ 执行或批准（管理员；项目范围另加该项目负责人）/ 申请（其余人，只能交自己的）/ 撤回（申请人）。权限在 handover.mjs 里判。
    { method: 'POST', path: '/api/handover', auth: 'session', handler: async (req, res) => {
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
      return json(res, 200, { ok: true, result, ...usersPayload(me, res.__lang) });
    } },
    // 转交事项：事项所在的任务要看得见（controls.transfer 再判是不是能转）
    { method: 'POST', re: /^\/api\/questions\/([^/]+)\/transfer$/, auth: 'task', taskFrom: ({ params }) => db.one(`SELECT task_id FROM questions WHERE id=?`, params[0])?.task_id ?? null,
      handler: async (req, res, { params }) => { const body = await readBody(req); return json(res, 200, { ok: true, result: controls.transfer({ questionId: params[0], to: body.to, reason: body.reason, _token: tokenOf(req) }) }); } },
    // 决定登记：按需拉，不塞进项目列表 —— 列表每次刷新都要走，清单长了不该跟着走一遍。
    { method: 'GET', re: /^\/api\/projects\/([^/]+)\/decisions$/, auth: 'project', handler: (req, res, { params }) => {
      const pid = params[0];
      const active = activeDecisions(db, { projectId: pid });
      const voided = db.all(`SELECT * FROM decision_registry WHERE project_id=? AND status='void' ORDER BY decided_at DESC LIMIT 50`, pid)
        .map((d) => ({ ...d, scope: JSON.parse(d.scope || '[]') }));
      const names = Object.fromEntries(db.all(`SELECT id, display_name FROM users`).map((u) => [u.id, u.display_name]));
      const titles = Object.fromEntries(db.all(`SELECT id, title FROM tasks WHERE project_id=?`, pid).map((t) => [t.id, t.title]));
      // 带上来源任务：清单上每条都要能点回"它是在哪儿定的"，否则人只知道有这条约定、不知道去哪儿改。
      const who_ = (d) => ({ ...d, byName: d.decided_by ? names[d.decided_by] ?? d.decided_by : null,
        taskTitle: d.task_id ? titles[d.task_id] ?? null : null });
      // 作废的那些：把"被谁取代"解析成人话。页面上不该出现 dr_xxx 这种只有库里认识的编号。
      const withNext = (d) => {
        const n = db.one(`SELECT id, subject, decided_at, decided_by, statement FROM decision_registry WHERE supersedes=?`, d.id);
        return { ...who_(d), supersededBy: n ? { ...n, byName: n.decided_by ? names[n.decided_by] ?? n.decided_by : null } : null };
      };
      return json(res, 200, { active: active.map(who_), voided: voided.map(withNext), sources: sourceNamesOf(res.__lang) });
    } },
    // 项目层：列表、从规划文本新建（proposed，守护进程拉规划器）、手动推进、交付。写只经已有入口。
    { method: 'GET', path: '/api/projects', auth: 'session', handler: (req, res) => { const who = whoOf(req);
      return json(res, 200, { projects: projectList(db, res.__lang).filter((pj) => canSeeProject(db, pj.id, who)).map((pj) => ({ ...pj, mine: involvedIn(db, pj.id, who), canAdd: canAddTasks(db, pj.id, who) })), visibilities: VISIBILITIES }); } },
    { method: 'POST', path: '/api/projects', auth: 'session', handler: async (req, res) => {
      const body = await readBody(req);
      if (!localTokenOk()) return json(res, 400, { error: LOCAL_TOKEN_BAD });
      const me = identity(req);
      const cc = canCreate(db, me.userId);
      if (!cc.ok) return json(res, 403, { error: new I18nError('无法新建项目：{why}', { why: translateError({ message: cc.why }, res.__lang) }) });
      // 新建的唯一入口。目标 + 完成定义必填；plan 给了 = 已写好的规划（规划器切），没给 = 第一个任务从目标起草（追问器）。
      const empty = !!body.empty;
      if (!empty) checkRepoSource(body.source, { required: true });
      // 并行开发（0.3.0）：只在"已有规划"时可开 —— 规划器的切法取决于它，从目标起草的第一个任务没有可切的东西。
      if (body.parallel && !String(body.plan ?? '').trim()) return json(res, 400, { error: new I18nError('并行开发要配合一份已写好的规划（勾选"这是一份已写好的规划"并粘贴全文）') });
      if (body.visibility != null && !VISIBILITIES[body.visibility]) return json(res, 400, { error: new I18nError('可见性只能是：{values}', { values: Object.keys(VISIBILITIES).join(' / ') }) });
      const r = startProject(db, { userId: me.userId, goal: body.goal, doneDefinition: body.doneDefinition, plan: body.plan ?? null,
        source: empty ? null : body.source, empty, base: body.base || null, title: body.title || null, home });
      if (body.parallel) setParallel(db, { projectId: r.projectId, on: true, userId: me.userId });
      // 建的时候就定可见性（原来建好再改，这之间全员看得到标题与目标、收得到它的动态）。
      // 与建项目在同一段同步代码里，推送的轮询插不进来
      if (body.visibility === 'members') setVisibility(db, { projectId: r.projectId, visibility: 'members', by: me.userId });
      return json(res, 200, { ok: true, result: r });
    } },
    { method: 'POST', re: /^\/api\/projects\/([^/]+)\/(advance|deliver|abort|redo|rename|archive|append|review|member|visibility|goal|budget|verify|gear|limit|signoff_all|max_open|parallel|egress|setup)$/, auth: 'project', handler: async (req, res, { params }) => {
      const [projectId, action] = params;
      const body = await readBody(req);
      if (!localTokenOk()) return json(res, 400, { error: LOCAL_TOKEN_BAD });
      const me = identity(req);
      const owner = db.one(`SELECT owner_id FROM projects WHERE id=?`, projectId)?.owner_id;
      if (!owner) return json(res, 404, { error: new I18nError('项目不存在：{id}', { id: projectId }) });
      // 添加任务：负责人或被授予的成员（requestAppend 自己查）；其余一律只有负责人。
      if (action !== 'append' && me.userId !== owner) return json(res, 403, { error: '只有该项目的负责人能执行此操作' });
      if (action === 'append' && !canAddTasks(db, projectId, me.userId)) return json(res, 403, { error: '你没有给这个项目添加任务的权限（需要是负责人，或由负责人在项目成员里授予）' });
      // 5d 的四个旋钮 + 后置签收：一律只有负责人（上面那道 403 已经挡住别人了）。
      if (action === 'setup') {
        try { return json(res, 200, { ok: true, result: setSetupCommands(db, { projectId, commands: body.commands ?? '', userId: me.userId }) }); }
        catch (e) { return json(res, 400, { error: e }); }
      }
      if (action === 'parallel') {
        // 只许关：开不开要在规划前定（建项目时），批准之后再打开，已经切好的任务不是按并行的形状切的。
        if (body.on) return json(res, 400, { error: new I18nError('并行开发只能在新建项目时开启（规划器的切法取决于它）') });
        try { return json(res, 200, { ok: true, result: setParallel(db, { projectId, on: false, userId: me.userId }) }); }
        catch (e) { return json(res, 400, { error: e }); }
      }
      if (action === 'egress') {
        try { return json(res, 200, { ok: true, result: setProjectEgress(db, { projectId, sources: Array.isArray(body.sources) ? body.sources : [], userId: me.userId }) }); }
        catch (e) { return json(res, 400, { error: e }); }
      }
      if (['budget', 'verify', 'gear', 'limit', 'signoff_all', 'max_open'].includes(action)) {
        try {
          const usd = body.usd === null || body.usd === '' || body.usd === undefined ? null : Math.round(Number(body.usd) * 1e6);
          const r3 = action === 'budget' ? setProjectBudget(db, { projectId, microUsd: usd, userId: me.userId })
            : action === 'verify' ? setProjectVerify(db, { projectId, command: body.command ?? '', userId: me.userId })
              : action === 'gear' ? setGear(db, { projectId, gear: body.gear, userId: me.userId })
                : action === 'limit' ? setProjectLimit(db, { projectId, key: body.key, value: body.value === null || body.value === '' ? null : Number(body.value), userId: me.userId })
                  : action === 'max_open' ? setMaxOpen(db, { projectId, n: Number(body.n), userId: me.userId })
                    : acceptDeferredSignoffs(db, { projectId, userId: me.userId });
          return json(res, 200, { ok: true, result: r3 });
        } catch (e) { return json(res, 400, { error: e }); }
      }
      if (['abort', 'redo', 'rename', 'archive', 'append', 'member', 'visibility', 'goal', 'review'].includes(action)) {
        const r2 = action === 'member' ? (body.remove ? removeMember(db, { projectId, userId: body.userId, by: me.userId })
            : setMember(db, { projectId, userId: body.userId, canAddTasks: !!body.canAddTasks, note: body.note ?? '', by: me.userId }))
          : action === 'visibility' ? setVisibility(db, { projectId, visibility: body.visibility, by: me.userId })
          : action === 'goal' ? editProjectGoal(db, { projectId, goal: body.goal ?? null, doneDefinition: body.doneDefinition ?? null, by: me.userId })
          : action === 'append' ? requestAppend(db, { projectId, userId: me.userId, brief: body.brief })
          : action === 'review' ? reviewAgain(db, { projectId, userId: me.userId })
          : action === 'abort' ? abortProject(db, { projectId, userId: me.userId, why: body.why || null })
          : action === 'redo' ? redoProjectTask(db, { projectId, userId: me.userId, taskId: body.taskId || null, note: body.note || null, plaintextToken: me.token })
          : action === 'rename' ? renameProject(db, { projectId, title: body.title, userId: me.userId })
          : setProjectArchived(db, { projectId, archived: body.archived !== false, userId: me.userId });
        // 新任务描述落地之后再比对（5c 入口①）：挂在载体任务上 —— 批准事项也在那儿。
        if (action === 'append' && r2?.carrierId) {
          await afterInput(db, { taskId: r2.carrierId, text: body.brief, entry: 'task', by: me.userId, makeClient: newLightClient });
        }
        return json(res, 200, { ok: true, result: r2 });
      }
      const r = action === 'advance' ? await advanceProject(db, { projectId, home, userId: me.userId })
        : await deliverProject(db, { projectId, remote: body.remote || null, pr: !!body.pr, base: body.base || null, userId: me.userId, env, fetchFn });
      return json(res, 200, { ok: true, result: r });
    } },
    // 交付页的按任务改动：项目仓库里这个任务合并进来的那一段。
    { method: 'GET', re: /^\/api\/projects\/([^/]+)\/diff\/([^/]+)(\/lines)?$/, auth: 'project', handler: (req, res, { params, url }) => {
      const range = deliveryRange(db, { projectId: params[0], taskId: params[1] });
      return json(res, 200, params[2] ? linesOf(range, { path: url.searchParams.get('path') ?? '', from: url.searchParams.get('from'), to: url.searchParams.get('to') }) : viewOf(range));
    } },
    // "从想法新建独立任务"已取消，留一个说清去处的 410
    { method: 'POST', path: '/api/tasks', auth: 'session', handler: (req, res) => {
      req.resume();
      if (!localTokenOk()) return json(res, 400, { error: LOCAL_TOKEN_BAD });
      return json(res, 410, { error: '独立任务已取消：请新建项目（一次性的小活就是只有一个任务的项目），或在已有项目里添加任务' });
    } },
    // ── 任务：一律先过可见性（读写都过；原来只有详情过了，写接口是后来补上的）──
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)$/, auth: 'task', handler: (req, res, { params }) => {
      const taskId = params[0];
      const who = whoOf(req);
      const d = taskDetail(db, taskId, { userId: who });
      if (!d) return json(res, 404, { error: new I18nError('任务不存在：{taskId}', { taskId }) });
      // schedule：自动运行会不会拉它、拉哪一步、不拉的原因（纯读审计轨，与守护进程同一个判断）。页面据此显示"下一步"。
      const a = assessTask(db, d.task, { isLive: (id) => controls.running(id), hasWorkspace: (id) => existsSync(join(home, 'workspaces', id)) });
      return json(res, 200, { ...d, running: controls.running(taskId), schedule: { due: !!a.due, verb: a.verb ?? null, reason: a.reason ?? null, readyAt: a.readyAt ?? null, attempts: a.attempts ?? null } });
    } },
    // 改动对比（任务口径：接手时的代码 → 任务头）；diff_lines = "展开 N 行未改动"
    // scope：all = 全部（接手时的代码 → 现在）；round = 返工这一轮；node = 某一步（&node=）；不给 = 有返工那一轮就给这一轮
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)\/diff$/, auth: 'task', handler: (req, res, { params, url }) => {
      const taskId = params[0];
      const range = rangeFor(db, { taskId, home, scope: url.searchParams.get('scope'), node: url.searchParams.get('node') });
      return json(res, 200, { ...viewOf(range, { roundSince: roundSinceOf(db, taskId) }), scope: range.via === 'round' ? 'round' : range.via === 'node' ? 'node' : 'all' });
    } },
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)\/diff_lines$/, auth: 'task', handler: (req, res, { params, url }) => json(res, 200, linesOf(rangeFor(db, { taskId: params[0], home, scope: url.searchParams.get('scope'), node: url.searchParams.get('node') }), { path: url.searchParams.get('path') ?? '', from: url.searchParams.get('from'), to: url.searchParams.get('to') })) },
    // 修改溯源：某一步凭什么（契约版本与批准、条款、指令来源、系统规则、对应提交）；追溯一个提交号或 文件:行号
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)\/provenance$/, auth: 'task', handler: (req, res, { params, url }) => {
      const nodeId = url.searchParams.get('node') ?? '';
      const p = nodeProvenance(db, nodeId);
      if (!p || p.task.id !== params[0]) return json(res, 404, { error: '这个任务里没有这一步' });
      const dir = traceDirOf(params[0]);
      return json(res, 200, { ...p, commits: dir ? nodeCommits(dir, nodeId) : [], policyText: p.policy ? (POLICIES[p.policy.id]?.(res.__lang) ?? p.policy.id) : null });
    } },
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)\/trace$/, auth: 'task', handler: (req, res, { params, url }) => {
      const dir = traceDirOf(params[0]);
      if (!dir) return json(res, 400, { error: '这个任务还没有工作区（没开工，或已清理），没有代码可追溯' });
      const q = parseTraceQuery(url.searchParams.get('q'));
      const t = q.kind === 'commit' ? traceCommit(db, { dir, rev: q.rev }) : traceLine(db, { dir, file: q.file, line: q.line });
      // 项目仓库是多个任务共用的，GitHub 上 squash 出来的提交还可能并着几个任务的步骤：看的人看不到的任务，只说有这么一步、不给内容
      const who = whoOf(req);
      const nodes = t.nodes.map((p) => (p.missing ? p : !canSeeTask(db, p.task.id, who) ? { hidden: p.node.id } : { ...p, sameTask: p.task.id === params[0], policyText: p.policy ? (POLICIES[p.policy.id]?.(res.__lang) ?? p.policy.id) : null }));
      return json(res, 200, { ...t, nodes, note: t.commit && !t.nodes.length ? noStepNote(res.__lang, t.commit.kind) : null });
    } },
    // 看运行效果：最近一次截图的结论；preview_img 取某一张（只认固定形状的文件名与提交号，不拼任意路径）
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)\/preview$/, auth: 'task', handler: (req, res, { params }) => json(res, 200, previewOf(db, params[0])) },
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)\/preview_img$/, auth: 'task', handler: (req, res, { params, url }) => {
      const f = String(url.searchParams.get('file') ?? ''), h = String(url.searchParams.get('head') ?? '');
      if (!/^\d{2}\.png$/.test(f) || !/^([0-9a-f]{1,12}|nohead)$/.test(h)) return json(res, 400, { error: '截图参数不对' });
      const fp = join(home, 'previews', params[0], h, f);
      if (!existsSync(fp)) return json(res, 404, { error: '截图不在了' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
      return res.end(readFileSync(fp));
    } },
    // AI 验收点验时存的画面（key = 步骤 id + 会话时间，只认固定形状）
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)\/live_img$/, auth: 'task', handler: (req, res, { params, url }) => {
      const f = String(url.searchParams.get('file') ?? ''), k = String(url.searchParams.get('key') ?? '');
      if (!/^\d{2}\.png$/.test(f) || !/^n_[0-9a-f]{1,32}-[0-9a-z]{1,12}$/.test(k)) return json(res, 400, { error: '画面参数不对' });
      const fp = join(home, 'previews', params[0], 'live', k, f);
      if (!existsSync(fp)) return json(res, 404, { error: '画面不在了' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
      return res.end(readFileSync(fp));
    } },
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)\/log$/, auth: 'task', handler: (req, res, { params, url }) => json(res, 200, controls.logTail({ taskId: params[0], lines: Number(url.searchParams.get('lines') ?? 80) })) },
    { method: 'GET', re: /^\/api\/tasks\/([^/]+)\/report$/, auth: 'task', handler: (req, res, { params, url }) => {
      const r = db.one(`SELECT * FROM reports WHERE id=? AND task_id=?`, url.searchParams.get('id'), params[0]);
      return r ? json(res, 200, r) : json(res, 404, { error: '报告不存在' });
    } },
    // 控制杆（say / answer / pause / resume / signoff / run …）：controls 上的同名函数；谁能做什么在 controls 里判
    // 控制杆名有驼峰的（reportsRead）：原来只认小写，看板点开报告标已读一直 404，没人发现
    { method: 'POST', re: /^\/api\/tasks\/([^/]+)\/([A-Za-z_]+)$/, auth: 'task', handler: async (req, res, { params }) => {
      const [taskId, action] = params;
      if (!controls[action] || ['running', 'logTail', 'me'].includes(action)) { req.resume(); return json(res, 404, { error: '接口不存在' }); }
      const body = await readBody(req);
      // 请求体里点名的事项必须属于地址里的这个任务：粗粒度那一层只按地址里的任务判可见性，
      // 原来拿自己看得见的任务地址、带别的任务的事项 id，就能在看不见的项目的事项下留言（say 的 about）、
      // 答复不设接收人的事项，报错还会说出事项在不在、该谁答。对不上一律当"没有这个事项"
      for (const k of ['questionId', 'about']) {
        if (body[k] == null || body[k] === '') continue;
        if (db.one(`SELECT task_id FROM questions WHERE id=?`, String(body[k]))?.task_id !== taskId) return json(res, 404, { error: new I18nError('事项不存在：{id}', { id: String(body[k]).slice(0, 40) }) });
      }
      const out = await controls[action]({ taskId, ...body, _token: tokenOf(req), _lang: res.__lang });
      return json(res, 200, { ok: true, result: out });
    } },
  ];
  checkRouteTable(ROUTES);
  const matchRoute = (method, p) => {
    for (const r of ROUTES) {
      if (r.method !== method) continue;
      if (r.path && r.path === p) return { route: r, params: [] };
      const mm = r.re && r.re.exec(p);
      if (mm) return { route: r, params: mm.slice(1) };
    }
    return null;
  };
  const deny = (res, status, policy, error, extra = {}) => { res.setHeader('x-si-deny', policy); return json(res, status, { error, ...extra }); };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const p = url.pathname;
    res.__lang = normLang(req.headers['x-si-lang']) ?? contentLang(db);
    // 安全头：每个响应都带 —— 别的站开窗口拿不到我们的 window（COOP）；MIME 不许猜；走 HTTPS 时浏览器记住只用 HTTPS
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('x-content-type-options', 'nosniff');
    if (secureCookie) res.setHeader('strict-transport-security', 'max-age=31536000');
    const xs = p === '/healthz' && req.method === 'GET' ? null : crossSiteReason(req, { host, allowHosts: pub ? [pub.hostname] : [] });
    if (xs) { req.resume(); return json(res, 403, { error: xs }); }
    try {
      const hit = matchRoute(req.method, p);
      if (!hit) { req.resume(); return json(res, 404, { error: '接口不存在' }); }
      const { route, params } = hit;
      const ctx = { url, p, params };
      // ── 粗粒度那一层：按路由声明的 auth 统一执行 ──
      if (route.auth !== 'public') {
        // 团队模式的总闸：没有有效身份一律 401（本机模式由本机令牌兜底，identity 自己处理）
        if (team && !tokenOf(req)) { req.resume(); return deny(res, 401, 'session', '请先登录', { login: true }); }
        let me;
        try { me = identity(req); } catch { req.resume(); return team ? deny(res, 401, 'session', '登录已过期或已退出，请重新登录', { login: true }) : deny(res, 401, 'session', '令牌无效或已吊销（本机模式：右上角「切换身份」留空可回到本机身份）'); }
        // 只读令牌：只能看。在这一处执行到底 —— 处理函数里不用再各自判
        if (me.scope === 'read' && !['GET', 'HEAD'].includes(req.method)) { req.resume(); return deny(res, 403, 'scope', '这枚令牌是只读的，不能做改动'); }
        if (route.auth === 'admin' && me.role !== 'lead') { req.resume(); return deny(res, 403, 'admin', route.denied ?? '只有管理员能执行此操作'); }
        // 服务账户替人做事：带 x-si-on-behalf-of 头，这次请求写下的审计都记 on_behalf_of。只有服务账户能这么做
        const obo = req.headers['x-si-on-behalf-of'];
        if (obo) {
          if (me.userKind !== 'service') { req.resume(); return deny(res, 403, 'session', '只有服务账户能替人操作'); }
          if (!db.one(`SELECT 1 x FROM users WHERE id=? AND disabled_at IS NULL AND kind='human'`, String(obo))) { req.resume(); return deny(res, 400, 'session', '替谁操作：成员不存在或已停用'); }
          ctx.onBehalfOf = String(obo);
        }
        if (route.auth === 'project') {
          const pid = route.projectFrom ? route.projectFrom(ctx) : params[0];
          if (pid && !canSeeProject(db, pid, me.userId)) { req.resume(); return deny(res, 404, 'project', '项目不存在'); }
        }
        if (route.auth === 'task') {
          const tid = route.taskFrom ? route.taskFrom(ctx) : params[0];
          if (!tid || !canSeeTask(db, tid, me.userId)) { req.resume(); return deny(res, 404, 'task', new I18nError('任务不存在：{taskId}', { taskId: tid ?? params[0] })); }
        }
      }
      // 授权矩阵测试专用：过了粗粒度那一层就停，不执行处理函数（不然逐条打一遍会真的中止项目、加成员……）。只有测试会开。
      if (authzProbe && req.headers['x-si-authz-probe'] === '1') { req.resume(); res.writeHead(204); return res.end(); }
      // 幂等键：网络断了、浏览器重试，同一个"签收""答复"不会做两遍
      const idemKey = req.method === 'POST' && route.auth !== 'public' ? String(req.headers['idempotency-key'] ?? '').trim() : '';
      if (idemKey) {
        if (idemKey.length > 200) { req.resume(); return json(res, 400, { error: 'Idempotency-Key 太长（上限 200 字符）' }); }
        const me = identity(req);
        req.__bodyText = await rawBody(req);
        const reqHash = sha256(`${req.method} ${p}\n${req.__bodyText}`);
        const prev = idemGet(db, me.userId, idemKey);
        if (prev) {
          if (prev.req_hash !== reqHash) return json(res, 422, { error: '同一个 Idempotency-Key 用在了不同的请求上' });
          if (prev.state === 'pending') return json(res, 409, { error: '同一个请求还在处理，稍后再看结果' });
          res.writeHead(prev.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'idempotent-replayed': 'true' });
          return res.end(prev.body);
        }
        if (!idemClaim(db, { userId: me.userId, key: idemKey, method: req.method, path: p, reqHash })) return json(res, 409, { error: '同一个请求还在处理，稍后再看结果' });
        // 记下这次的结果：确定的（2xx / 4xx）缓存，服务端出错的（5xx）删掉让重试再跑
        const chunks = [];
        const { writeHead, end } = res;
        let status = 200;
        res.writeHead = function (s, ...rest) { status = s; return writeHead.call(this, s, ...rest); };
        res.end = function (chunk, ...rest) {
          if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          try { if (status >= 500) idemDrop(db, me.userId, idemKey); else idemFinish(db, { userId: me.userId, key: idemKey, status, body: Buffer.concat(chunks).toString('utf8') }); } catch { /* 记不上不影响这次的响应 */ }
          return end.call(this, chunk, ...rest);
        };
        // 处理函数抛出时交给下面的统一出错处理写响应 —— 也经过上面的 res.end，一样记下结果
        return await (ctx.onBehalfOf ? runAs({ onBehalfOf: ctx.onBehalfOf }, () => route.handler(req, res, ctx)) : route.handler(req, res, ctx));
      }
      return ctx.onBehalfOf ?await runAs({ onBehalfOf: ctx.onBehalfOf }, () => route.handler(req, res, ctx)) : await route.handler(req, res, ctx);
    } catch (e) {
      const c = classifyError(e);
      if (c.expose) return json(res, c.status, { error: e, ...(e?.conflict ? { conflict: true } : {}) });
      try { audit(db, { actorKind: 'system', action: 'http_error', targetType: 'route', targetId: `${req.method} ${p}`, payload: { error: String(e?.message).slice(0, 500), code: e?.code ?? null, stack: String(e?.stack ?? '').split('\n').slice(1, 6).map((l) => l.trim()) } }); } catch { /* 库本身出错：至少别把细节回给浏览器 */ }
      return json(res, 500, { error: '服务器内部错误（已记录）' });
    }
  });
  // 连接层的上限：慢速发头 / 发体的连接不能一直占着；同时连接数有上限（SSE 长连接也算在内，留足余量）
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.maxConnections = 512;
  return new Promise((ok) => server.listen(port, host, () => ok({
    server, port: server.address().port, host,
    // 授权矩阵测试按这张表逐条生成用例
    routes: ROUTES.map((r) => ({ method: r.method, path: r.path ?? null, re: r.re ?? null, auth: r.auth })),
    close: () => { clearInterval(ticker); clearInterval(ghRecheck); for (const c of clients) c.end(); server.close(); },
  })));
}
