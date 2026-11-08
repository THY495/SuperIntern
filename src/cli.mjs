// superintern CLI —— 人机接口。
//
// 它**故意很薄**：CLI 只是一条通道，不是链。
// 所有状态变更都发生在库里，CLI 只负责把人的意思翻译成一次写入，
// 再把库里的状态翻译回人能读的样子。任何"只有 CLI 知道"的状态都是 bug。

import './core/win-hide.mjs';   // Windows：子进程默认不弹控制台窗口（必须最先执行）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, ensureOwner, newId, now, audit, authenticate } from './db/db.mjs';
import { updateUser } from './db/users.mjs';
import { recordAnswer, sayWithClassifier } from './core/inbox.mjs';
import { orchestrate } from './core/orchestrator.mjs';
import { LlmClient, loadEnv } from './llm/client.mjs';
import { sweepTimeouts } from './core/timeouts.mjs';
import { createProject, advanceProject, deliverProject, projectTasks, createTaskFromSpec, acceptDeferredSignoffs, deliveryEvidence } from './core/project.mjs';
import { planProject, carrierTask, renderPlanOutcome } from './agent/project-planner.mjs';
import { deliverTask, signOff, signoffOf } from './core/deliver.mjs';
import { channelsFromEnv, outcomeNotice, INVARIANT_NAMES, INVARIANT_PROBLEMS } from './core/notify.mjs';
import { emitSignal, pushSignal, deliverSignals } from './core/signals.mjs';
import { startWeb } from './web/server.mjs';
import { makeLauncher } from './core/launcher.mjs';
import { startDaemon, dueTasks, daemonStatus, assessTask } from './core/daemon.mjs';
import { stalls, livelocks, sweepLiveness, STALL_KINDS } from './core/liveness.mjs';
import { sweepInvariants, invariantsView, invariantLine } from './core/invariants.mjs';
import { activeDecisions, renderDecisions, voidOne as voidDecision, revisionCheckText } from './core/decisions.mjs';
import { afterInput } from './core/decision-check.mjs';
import './core/scope-ask.mjs';   // 越界申请的答复钩子（批了就放宽范围）
import { checkRepoSource } from './core/repos.mjs';
import { requestAppend, reviewAgain } from './agent/project-append.mjs';
import { startProject } from './agent/project-start.mjs';
import { listMembers, setMember, removeMember, setVisibility, editProjectGoal, VISIBILITIES } from './core/project-members.mjs';
import { draft } from './agent/elicitor.mjs';
import { getParam as getTaskParam } from './core/params.mjs';
import { makeFake } from './llm/providers.mjs';
import { fmtUsd, toolCallsOf, TIERS, LLM_ROLES } from './llm/canonical.mjs';
import { registryFor, bindingOf, seedBinding, pickDefaultBinding, setBinding, setFallback, bindingProblems, endpointsOf, catalogOf, saveEndpoint, setEndpointEnabled, removeEndpoint,
  testEndpoint, listEndpointModels, keyPresence, bindable, saveModel, removeModel, checkableCatalog,
  rolesView, setRoleBinding, pickVerifierModel } from './llm/registry.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { listReports, markReportsRead } from './agent/reporter.mjs';
import { flushLedger, taskSpendMicroUsd } from './core/ledger.mjs';
import { plan, persistPlan } from './agent/planner.mjs';
import { ensureWorkspace } from './core/workspace.mjs';
import { LIMITS, limitOf, setLimit, checkLimits, raiseLimitQuestion, setProjectLimit, projectLimits, LAYER_NAMES } from './core/limits.mjs';
import { budgetState, setProjectBudget, projectVerifyCommand, setProjectVerify, gearOf, setGear, gearPrereqStatus, GEARS, deferredSignoffs, maxOpenOf, setMaxOpen, setParallel, fmtUsd as fmtBudget, sandboxFlavorOf, setSandboxFlavor, SANDBOX_FLAVORS, setupCommandsOf, setSetupCommands, detectSetupCommands } from './core/project-settings.mjs';
import { replay, renderReplay } from './core/replay.mjs';
import { pendingRevision, nodesForReplan, gateOf, renderDiff, applyRevision,
  rejectRevision } from './core/revision.mjs';
import { ContainerExecutor, makeSandbox, listSandboxes, detectRuntime, SANDBOX_IMAGE } from './core/container.mjs';
import { addSourceCredential, revokeSourceCredential, sourceCredentials } from './core/egress-creds.mjs';
import { egressGroupsOf, setEgressGroups, allowlistOf, sourceOf, sourceForHost, egressSources, addSource, removeSource, secretLike,
  projectEgressOf, setProjectEgress, openEgressQuestions, deniedHosts } from './core/egress.mjs';
import { DECISION_TYPES, loadTemplates, rulesOf, profileOf, knobsOf, setKnobs, applyTemplate, saveRules, diffFromTemplate, previewRouting,
  dutyCalendarOf, dutyView, setDutyCalendar, dutyStartAt, setDutyOverrides, transferQuestion, leadOfKey, validateRules } from './core/routing.mjs';
import { deployTz, calendarOf, viewerTz } from './core/calendar.mjs';
import { fmtAt, validDayKey, zonedTime, validTz, dayKey, addDaysKey, isBusinessDay, weekdayOfKey, systemTz } from './core/tz.mjs';
// 命令行里的时刻：按部署时区写、带 UTC+8 这样的标记（原来是不标时区的 UTC）
const when = (db, ms, o) => fmtAt(ms, deployTz(db), o);
import { addUser, usersView, setUserTags, setUserChannel, removeUserChannel, setUserRole, renameUser, setGitIdentity, reissueToken, notifyPendingQuestions } from './core/users.mjs';
import { issueToken, tokensOf, activeTokens, revokeTokenBy, revokeAllOf, createInvite, invitesList, revokeInviteBy, addServiceAccount } from './core/sessions.mjs';
import { spendByPerson, setPersonBudget } from './core/spend.mjs';
import { listCredentials, addCredential, revokeCredential, checkAccess, setAppOAuth } from './core/credentials.mjs';
import { githubLoginConfig, isOrgMember } from './core/github-login.mjs';
import { safePositional } from './core/git.mjs';
import { buildDigest, renderDigest, sendDigest, renderHandover, sendHandoverNotice } from './core/digest.mjs';
import { buildStatusReport, renderStatusReport, DETAILS as REPORT_DETAILS, parseSince } from './core/report.mjs';
import { canCreate, getSetting, setSetting, SETTINGS } from './core/settings.mjs';
import { listSkills, installSkill, removeSkill, setProjectSkill, LAYERS as SKILL_LAYERS } from './core/skills.mjs';
import { hostHooks, trustHostHooks, repoHooks, deployHooksFile, projectHooksFile } from './core/hooks.mjs';
import { mcpOverview, checkProject, approveServers, setToolMode, setServerOff, deployMcpFile, projectMcpFile } from './core/mcp.mjs';
import { sqliteAdvice } from './core/sqlite-check.mjs';
import { dbHealth } from './db/health.mjs';
import { healthView } from './llm/health.mjs';
import { backupNow, listBackups, checkDb, restoreFile } from './db/backup.mjs';
import { PROC_ENV } from './core/lifetimes.mjs';
import { installLogSink, setLogBase } from './core/log.mjs';
import { flushSpans } from './core/otel.mjs';
import { permissionsOf, renderPermissions } from './core/permissions.mjs';
import { reopenTask, redoProjectTask, abortProject, renameTask, renameProject, setTaskArchived, setProjectArchived } from './core/lifecycle.mjs';
import { rewindPlan, rewindTask, describeRewind } from './core/rewind.mjs';
import { previewHandover, executeHandover, requestHandover, listHandoverRequests, decideHandoverRequest, canDecideHandover, disableUser, enableUser } from './core/handover.mjs';
import { checkCatalog, renderCatalogCheck, recordCatalogCheck, lastCatalogCheck } from './llm/catalog-check.mjs';
import { tl, translateError, userLang, contentLang, normLang, CATALOGS } from './i18n/index.mjs';
import { parseTraceQuery, traceCommit, traceLine, renderTrace } from './core/trace.mjs';
import { transition } from './db/state.mjs';
import { useEnvProxy } from './core/net-proxy.mjs';
import { allowTestChanges, testsAllowedFor, latestTestChanges } from './core/test-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// SUPERINTERN_ENV_FILE：换一个环境文件；写 none 就不读（离线场景集的子进程：仓库里的 .env 是开发者自己的通知通道与 key，
// 测试读了就会往真的 ntfy / 邮箱发通知）。
const ENV_FILE = process.env.SUPERINTERN_ENV_FILE ?? join(ROOT, '.env');
if (ENV_FILE !== 'none') loadEnv(ENV_FILE);
// 出网走 HTTPS_PROXY / HTTP_PROXY（与 git 一致；.env 里写的也算，所以放在 loadEnv 之后）。见 core/net-proxy.mjs
const PROXY = useEnvProxy();
// 看板 / 守护进程启动时说一次的提示：出网代理、数据目录（看板带着守护进程时只说一次）
let proxySaid = false;
function sayStartupNotes() {
  if (proxySaid) return;
  proxySaid = true;
  const line = PROXY.enabled ? tl(lang(), '  出网走代理 {proxy}（HTTPS_PROXY / HTTP_PROXY；本机地址与 NO_PROXY 里的直连）', { proxy: PROXY.proxy })
    : PROXY.why === 'unsupported' ? tl(lang(), '  ⚠ 设了 HTTPS_PROXY，但这个 Node 不支持让 fetch 走代理：GitHub 登录、模型调用会直连。升级 Node，或启动时加 --use-env-proxy') : null;
  if (line) console.log(line);
  // --db 指到数据目录外、又没设 SUPERINTERN_HOME：心跳、日志、工作区仍写在默认数据目录（多半是另一个部署的）。
  // 2026-10-13 走查时测试看板就这样把守护进程心跳写进了真部署的目录
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  if (flags.db && !process.env.SUPERINTERN_HOME && norm(dirname(String(flags.db))) !== norm(HOME)) {
    console.log(tl(lang(), '  ⚠ 库在 {db}，但数据目录仍是 {home}（守护进程心跳、日志、任务工作区写在那里）。这是另一个部署的目录的话，请设 SUPERINTERN_HOME 指向自己的目录', { db: String(flags.db), home: HOME }));
  }
}

const HOME = process.env.SUPERINTERN_HOME ?? join(process.cwd(), '.superintern');
const TOKEN_FILE = join(HOME, 'cli-token');

// ── 参数解析（够用即可，不引依赖）─────────────────────────────────────────
function parseArgs(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) { push(flags, k, inline); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) push(flags, k, true);
    else { push(flags, k, next); i++; }
  }
  return { flags, positional };
}
const push = (o, k, v) => { if (k in o) o[k] = [].concat(o[k], v); else o[k] = v; };
const list = (v) => (v === undefined ? [] : [].concat(v));

// 输出语言（0.2.0）：环境变量 SI_LANG 优先；否则命令行身份（cli-token 对应的用户）的界面语言；拿不到身份用部署的内容语言。
// 库还没打开时（--version、用法、init 之前的报错）：SI_LANG，没有就中文。取到一次就缓存。
let cliLang = normLang(process.env.SI_LANG);
let langDb = null;   // 入口打开库后填上
function lang() {
  if (cliLang) return cliLang;
  if (!langDb) return 'zh';
  try {
    const tokenFile = flags['token-file'] ?? TOKEN_FILE;
    const plaintext = String(flags.token ?? (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : '')).trim();
    const auth = plaintext ? authenticate(langDb, plaintext) : null;
    cliLang = auth ? userLang(langDb, auth.user_id) : contentLang(langDb);
  } catch { cliLang = 'zh'; }
  return cliLang;
}
/** 别的模块给的固定词（挡位名、可见性、停等类别……）：目录里有就翻，没有照原样。键在那些模块里登记。 */
const dyn = (s) => (lang() === 'zh' || typeof s !== 'string' ? s : CATALOGS[lang()]?.[s] ?? s);

const die = (msg) => { console.error(tl(lang(), '错误：{msg}', { msg })); process.exit(1); };

// ── 命令 ────────────────────────────────────────────────────────────────────

function cmdInit(db, flags = {}) {
  // --name：负责人显示名。默认 local-owner 在看板上会被读成角色代号而不是人名，
  // 有名字就给名字；库已存在时 --name 改现有负责人的显示名。
  const name = flags.name ? String(flags.name).trim() : null;
  const { userId, plaintext } = ensureOwner(db, name ?? undefined);
  // 档位绑定进库。表空时把代码默认值显式写入；--bind tier=服务商/模型 覆盖（首装指定；默认 heavy 绑 anthropic，本机没 key 就换）。
  const overrides = {};
  for (const sp of list(flags.bind)) { const eq = String(sp).indexOf('='); if (eq <= 0) die(tl(lang(), '--bind 要写成 tier=服务商/模型，实得 {sp}', { sp })); overrides[String(sp).slice(0, eq)] = String(sp).slice(eq + 1); }
  // 没给 --bind、表又是空的：出厂默认里某档的服务商没填 key（典型：heavy 绑 anthropic，本机只有 DeepSeek 的 key）时，
  // 按 .env 里**已经有 key** 的那一家选三档。只看变量在不在，不读值。
  let picked = null;
  if (!Object.keys(overrides).length) {
    const p = pickDefaultBinding(db, { env: process.env });
    if (p) { picked = p.vendor; Object.assign(overrides, p.binding); }
  }
  let seeded;
  try { seeded = seedBinding(db, { overrides, userId }); } catch (e) { die(translateError(e, lang())); }
  const say = () => {
    if (picked) console.log(tl(lang(), '按 .env 里已有 key 的 {picked} 选了三档的默认绑定（出厂默认里有的档位那家没填 key）。以后改：node src/cli.mjs bind set 档位=服务商/模型，或看板"设置 → 模型分配"', { picked }));
    printBinding(db, seeded);
  };
  if (plaintext) {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(TOKEN_FILE, plaintext, { mode: 0o600 });
    console.log(tl(lang(), '已建库并创建管理员 {userId}{who}', { userId, who: name ? tl(lang(), '（{name}）', { name }) : tl(lang(), '（显示名 local-owner，可用 --name 改）') }));
    console.log(tl(lang(), 'CLI 令牌写入 {file}（库里只有哈希，此文件是唯一副本）', { file: TOKEN_FILE }));
    say();
  } else {
    if (name) {
      updateUser(db, userId, { displayName: name });
      audit(db, { actorKind: 'user', actorId: userId, action: 'user_renamed', targetType: 'user', targetId: userId, payload: { name } });
      console.log(tl(lang(), '库已就绪，管理员 {userId} 显示名改为 {name}', { userId, name }));
    } else {
      console.log(tl(lang(), '库已就绪，管理员 {userId}', { userId }));
    }
    if (seeded.seeded || Object.keys(overrides).length) say();   // 先说库的状态，再打绑定表
  }
}

function cmdNew(db, { flags, positional }) {
  // 创建者即负责人：有令牌就按令牌的身份（而不是一律记在最早的管理员名下）。还没 init 过的库照旧走 ensureOwner。
  const { userId } = (flags.token || existsSync(flags['token-file'] ?? TOKEN_FILE)) ? cliIdentity(db, flags) : ensureOwner(db);
  { const cc = canCreate(db, userId); if (!cc.ok) die(tl(lang(), '无法新建任务：{why}', { why: dyn(cc.why) })); }
  // 从模糊想法开始。不写宪法块 —— 那是追问器的产出；人只需要答它的问题、批准草案。
  // 项目是唯一容器，独立任务没有新建入口了。一次性的小活 = 只有一个任务的项目。
  if (flags.idea) die(tl(lang(), '独立任务已取消。请新建项目：node src/cli.mjs project new --goal <目标> --done <完成定义> (--source <仓库> | --empty)\n一次性的小活就是只有一个任务的项目；已有项目里加任务：project append <项目 id> --brief <文本或文件>'));
  let spec;
  if (flags.file) {
    spec = JSON.parse(readFileSync(flags.file, 'utf8'));
  } else {
    spec = {
      title: positional[0],
      goal: flags.goal,
      scope: flags.scope ?? tl(contentLang(db), '未限定'),   // 写进契约：按内容语言
      definition_of_done: flags.dod,
      constraints: list(flags.constraint),
    };
  }
  for (const f of ['title', 'goal', 'definition_of_done']) {
    if (!spec?.[f]) die(tl(lang(), '缺少 {f}（用 --file 给 JSON，或 --goal / --dod 等参数）', { f }));
  }

  // 任务级验收命令。**只能由人给**：从自然语言的完成定义里提取一条
  // 命令就是 LLM 验收员，而设计上明确把它排除在这一层之外。
  // 存进 params 且 governance_class='constitutional' —— 库层 CHECK 保证
  // agent 永远改不了它，这条路径 agent 结构上也够不着。
  const verifyRaw = spec.verify_command ?? flags.verify;
  const verifyArgv = typeof verifyRaw === 'string' ? verifyRaw.trim().split(/\s+/) : null;

  // 落库与项目层同一份函数（project.mjs createTaskFromSpec）：宪法块 v1 是"当时被要求什么"这一层出处的根，
  // 验收命令进 constitutional 参数 —— 库层 CHECK 保证 agent 永远改不了它。
  const { taskId, constId } = createTaskFromSpec(db, { ...spec, verify_command: verifyArgv ? verifyArgv.join(' ') : undefined }, { userId, approvedBy: userId });
  console.log(tl(lang(), '任务 {taskId}  宪法块 {constId}\n  {title}', { taskId, constId, title: spec.title }));
  if (verifyArgv?.length) console.log(tl(lang(), '  任务级验收命令：{cmd}（宪法层参数，agent 不可自改）', { cmd: verifyArgv.join(' ') }));
  else console.log(tl(lang(), '  ⚠️ 没给 --verify —— 全部节点完成后没有任务级机械判据，任务会直接置 done'));
  console.log(tl(lang(), '\n下一步：node src/cli.mjs plan {taskId}', { taskId }));
}

async function cmdPlan(db, taskId, flags) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId) ?? die(tl(lang(), '没有这个任务：{id}', { id: taskId }));
  const constitution = db.one(
    `SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`,
    taskId) ?? die(tl(lang(), '任务没有生效中的宪法块'));
  const existing = db.one(`SELECT count(*) AS n FROM nodes WHERE task_id=?`, taskId).n;
  if (existing && !flags.force) die(tl(lang(), '任务已有 {n} 个节点。重规划属五步流水线，不是 plan 的事；确要覆盖请加 --force', { n: existing }));
  // 草案没批准之前，规划器不许读它。批准是人的 Ⅲ 级答复，不是"库里有一行 constitutions"。
  const stage = getTaskParam(db, taskId, 'draft.stage');
  if (stage && stage !== 'approved') die(tl(lang(), '宪法块草案还没批准（draft.stage={stage}）。在看板答复批准问题，或 node src/cli.mjs draft {taskId}', { stage, taskId }));

  // 闸门必须挂在**每一条花钱的路径**上，不只是编排器。
  // 规划器是另一条：不在这里挡，它就完全不受任何上限约束，重规划几次就能把预算烧穿，
  // 而编排器那边的闸门一次都不会被问到。
  const pre = checkLimits(db, taskId, { startedAt: now(), idleCycles: 0 });
  if (pre) {
    const q = raiseLimitQuestion(db, { taskId, breach: pre });
    console.log(tl(lang(), '⛔ 规划前体检不过：{human}', { human: pre.human }));
    console.log(tl(lang(), '已生成 Ⅲ 级问题 {qid}（hard_rule），任务转入 waiting。', { qid: q.questionId }));
    console.log(tl(lang(), '  加额：node src/cli.mjs limit {taskId} --{key} <新值>', { taskId, key: pre.key.replace('limit.', '') }));
    process.exitCode = 1;
    return;
  }

  // fake 模式按脚本挨个吐响应（同 run / draft / say）；没给脚本以前是一个裸 TypeError
  if (flags.mode === 'fake' && !flags.script && !fakeProvider) die(tl(lang(), 'plan --mode fake 要配 --script <响应脚本.json>（fake 不调模型，按脚本挨个吐响应）'));
  const client = new LlmClient({
    mode: flags.mode ?? 'live',
    cassette: flags.cassette,
    ...clientOpts(db, flags),   // 规划器也要能换绑：厂商 403 时 plan 与 run 一样得有路可走
    ...fakeOpt(flags),
  });
  const tier = flags.tier ?? 'heavy';

  console.log(tl(lang(), '规划中（档位 {tier}）…', { tier }));
  let result;
  try {
    result = await plan(db, { client, taskId, constitution, tier, maxAttempts: Number(flags.attempts ?? 3) });
  } finally {
    // ⚠️ 无论成败都要落账：失败的尝试同样烧了钱，漏记等于把预算闸门捅个洞
    const { rows, microUsd } = flushLedger(db, client, { taskId, role: 'planner' });
    if (rows) console.log(tl(lang(), '记账 {rows} 次调用，{usd}', { rows, usd: fmtUsd(microUsd) }));
  }

  // 规划器停在提问上 —— 这是**正常出口之一**，不是失败。宪法块本身规划不动时，
  // 编一个形状合法的方案比停下来问坏得多。
  if (result.kind === 'question') {
    const q = result.question;
    console.log(tl(lang(), '\n规划器提出 Ⅰ/Ⅱ/Ⅲ 级中的第 {level} 级问题，任务转入 waiting：', { level: q.level }));
    console.log(`\n  ${q.text}\n`);
    if (q.blocked_by) console.log(tl(lang(), '  卡在这条约束上：{c}', { c: q.blocked_by }));
    // ⚠️ 措辞按**级别**分支，不按 default_action 是否为空。
    // 实测踩过：模型提了个没带默认动作的 Ⅱ 级问题，这里照 null 判就印成
    // "Ⅲ 级问题无默认动作"，把级别报错了。级别是级别，有没有默认是另一回事。
    console.log(q.default_action ? tl(lang(), '  无人回答时的默认动作：{a}', { a: q.default_action })
      : q.level === 3 ? tl(lang(), '  Ⅲ 级问题不得有默认动作，无限期等待（库层强制）')
        : tl(lang(), '  ⚠️ 第 {level} 级却没给默认动作 —— 行为上等同无限期阻塞', { level: q.level }));
    console.log(tl(lang(), '\n问题 {id}。回答后重跑 plan。', { id: q.id }));
    return;
  }

  let nodeIds;
  try {
    nodeIds = persistPlan(db, { taskId, constitutionId: constitution.id, nodes: result.nodes, rationale: result.rationale, expectNodes: existing });
  } catch (e) {
    // 规划期间别人先落了方案 / 契约改了：这一份作废，不落库
    // 再记一行退出（failed，可重试）：规划器那一行已经记成规划成功，不改的话守护进程以为规划完了、却没有节点，任务就停在这里。
    // 契约改了 → 守护进程按退避重新规划；已经有方案了 → 不再是规划阶段，不会再拉
    if (e.planRace) {
      audit(db, { actorKind: 'agent', actorId: 'planner', action: 'planner_exit', targetType: 'task', targetId: taskId, payload: { pid: process.pid, kind: 'failed', discarded: e.planRace } });
      console.error(translateError(e, lang())); process.exitCode = 1; return;
    }
    throw e;
  }
  transition(db, 'tasks', taskId, 'running');

  console.log(tl(lang(), '\n规划成功：{n} 个节点，第 {attempts} 次尝试通过', { n: nodeIds.length, attempts: result.attempts }));
  if (result.rejections.length) {
    console.log(tl(lang(), '前 {n} 次被护栏拒绝：', { n: result.rejections.length }));
    result.rejections.forEach((errs, i) => console.log(tl(lang(), '  第 {i} 次：{errs}', { i: i + 1, errs: errs.join(tl(lang(), '；')) })));
  }
  cmdShow(db, taskId);
}

/**
 * 看/改任务的硬上限。
 *
 * 上限是**宪法层参数**：库层 CHECK 保证 `governance_class='constitutional'` 只能由
 * `set_by_kind='user'` 写入，所以这条命令是 agent 结构上够不着的那一侧。
 * 不带任何 --xxx 就是只看不改。
 */
function cmdLimit(db, taskId, flags) {
  db.one(`SELECT id FROM tasks WHERE id=?`, taskId) ?? die(tl(lang(), '没有这个任务：{id}', { id: taskId }));
  // 谁在改由令牌说（--token-file 可指定别人的）；能不能改由路由表说（setLimit 里查）。
  const { userId } = Object.keys(LIMITS).some((k) => flags[k.replace('limit.', '')] !== undefined) ? cliIdentity(db, flags) : ensureOwner(db);

  let changed = 0;
  for (const key of Object.keys(LIMITS)) {
    const short = key.replace('limit.', '');
    if (flags[short] === undefined) continue;
    const v = Number(flags[short]);
    if (!Number.isFinite(v) || v < 0) die(tl(lang(), '--{flag} 要一个非负数字，实得 {v}', { flag: short, v: flags[short] }));
    try { setLimit(db, { taskId, key, value: v, userId }); } catch (e) { die(translateError(e, lang())); }
    changed += 1;
  }

  console.log(tl(lang(), '任务 {taskId} 的硬上限', { taskId }) + (changed ? tl(lang(), '　已改 {n} 项', { n: changed }) : ''));
  for (const [key, d] of Object.entries(LIMITS)) {
    const lim = limitOf(db, taskId, key);
    const set = db.one(`SELECT id FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL`, taskId, key);
    console.log(`  --${key.replace('limit.', '').padEnd(18)} ${d.fmt(lim, lang()).padEnd(14)} ${dyn(d.label)}`
      + `${set ? tl(lang(), '  [显式设置]') : tl(lang(), '  [内置天花板]')}`);
  }
  // 内置天花板不是"没设上限"：没设过就退化成无限，等于闸门不存在。
  const b = checkLimits(db, taskId, { startedAt: now(), idleCycles: 0 });
  console.log(b ? tl(lang(), '\n⛔ 当前已触顶：{human}', { human: b.human }) : tl(lang(), '\n当前未触顶'));
}

function cmdWorkspace(db, taskId, flags) {
  db.one(`SELECT id FROM tasks WHERE id=?`, taskId) ?? die(tl(lang(), '没有这个任务：{id}', { id: taskId }));
  const ws = ensureWorkspace(db, {
    taskId, source: flags.source ?? ROOT,
    dir: flags.dir ?? join(HOME, 'workspaces', taskId), force: !!flags.force,
    ref: flags.ref ?? null,
  });
  console.log(ws.created ? tl(lang(), '已创建工作区 {dir}', { dir: ws.dir }) : tl(lang(), '已存在工作区 {dir}', { dir: ws.dir }));
  console.log(tl(lang(), '  分支 {branch} @ {head}  ← agent 动这里，本进程加载的是 {root}', { branch: ws.branch, head: ws.head.slice(0, 8), root: ROOT }));
  if (ws.ref) console.log(tl(lang(), '  基线 {ref}（不是当前 HEAD）', { ref: ws.ref }));
}

/**
 * 跑任务。这条命令**就是编排器的一次寿命**：进程起来 → 读库 → 能推进多少推进
 * 多少 → 到了必须停的地方就退出。挂起时进程真的死，恢复靠再跑一次
 * 同样这条命令 —— "重生 = 恢复 = 冷启动 = 复工"在 CLI 层面就是
 * "同一条命令跑第二次"。
 */
/**
 * LlmClient 的构造参数 = 库里的生效注册表（每建一个客户端读一次库，改绑定跑完当前节点就换）
 * + `--bind tier=服务商/模型`（可重复）的**一次性覆盖**。
 *
 * 档位是抽象槽。例：跑到一半某个模型（如 `anthropic/claude-opus-5`）开始回
 * `403 forbidden: Request not allowed`，heavy 整档不可用；换一行绑定就接着跑。
 * 常态配置在库里（看板"绑定"页 / `cli bind set`），--bind 只管这一个进程、不落库、启动时打一行说明。
 *
 * **模型在生效目录里查一遍**：打错名字不该等到真发请求时才炸。
 */
/** fake 模式的回复从哪来：--fake-module 优先，其次 --script（顺序脚本，每建一个客户端从头吐）。都没有 → 不给。 */
function fakeOpt(flags) {
  if (fakeProvider) return { fake: fakeProvider };
  return flags.script ? { fake: makeFake(JSON.parse(readFileSync(flags.script, 'utf8'))) } : {};
}

let bindNoticePrinted = false;
function clientOpts(db, flags) {
  const reg = registryFor(db);
  const specs = list(flags.bind);
  if (!specs.length) return reg;
  const b = { ...reg.binding };
  for (const s of specs) {
    const eq = String(s).indexOf('=');
    const tier = eq > 0 ? String(s).slice(0, eq) : '', model = eq > 0 ? String(s).slice(eq + 1) : '';
    if (!TIERS.includes(tier)) die(tl(lang(), '--bind 的档位要是 {tiers}，实得 {tier}', { tiers: TIERS.join('/'), tier }));
    const why = bindable(reg.catalog[model], reg.vendors);
    if (why) die(tl(lang(), '--bind 的模型 {model}：{why}。可选：\n  {options}', { model, why: dyn(why), options: Object.keys(reg.catalog).filter((k) => !bindable(reg.catalog[k], reg.vendors)).join('\n  ') }));
    b[tier] = model;
  }
  if (!bindNoticePrinted) {
    bindNoticePrinted = true;
    console.log(tl(lang(), '--bind 只覆盖本次进程：{specs}（库里是 {db}；常态改用 node src/cli.mjs bind set）', { specs: specs.join(' '), db: TIERS.map((t) => `${t}=${reg.binding[t]}`).join(' ') }));
  }
  return { ...reg, binding: b };
}

/** 库里没有绑定行时，daemon / web 的 --bind 写入一次；有就拒绝（常态配置不该每次启动都带）。 */
async function bindForLongRunner(db, flags, who) {
  const specs = list(flags.bind);
  if (!specs.length) return;
  const cur = bindingOf(db);
  const overrides = {};
  for (const sp of specs) { const eq = String(sp).indexOf('='); if (eq <= 0) die(tl(lang(), '--bind 要写成 tier=服务商/模型，实得 {sp}', { sp })); overrides[String(sp).slice(0, eq)] = String(sp).slice(eq + 1); }
  if (cur.source === 'db') {
    // 升级后没重装计划任务 / systemd 单元的部署，启动参数里还带着旧的 --bind。与库里逐档一致 = 没有分歧，
    // 打一行提醒照常起；不一致才拒（拒绝发生在起任何东西之前）。
    const diff = Object.entries(overrides).filter(([t, k]) => cur.binding[t] !== k);
    if (!diff.length) { console.log(tl(lang(), '⚠ {who} 的 --bind 与库里的绑定一致，已忽略。常态绑定在库里，启动参数里的 --bind 可以删掉（重新 install 一次守护进程）。', { who })); return; }
    const diffText = diff.map(([t, k]) => `${t}=${k}`).join(' ');
    const msgIn = (L) => tl(L, '{who} 不接 --bind：库里已有绑定（{db}），与启动参数不一致（{diff}）。', { who, db: TIERS.map((t) => `${t}=${cur.binding[t]}`).join(' '), diff: diffText })
      + tl(L, '要改绑用 node src/cli.mjs bind set {diff}；要保留库里的就把启动参数里的 --bind 删掉（重新 install 一次守护进程）。--bind 只在 plan / run / draft 上是一次性覆盖', { diff: diffText });
    const msg = msgIn(lang());
    // 拒绝要有对外信号：计划任务每 5 分钟重拉一次，失败只在 daemon.log 里的话没人知道守护进程其实没起来。
    // 审计 + 部署级通知，6 小时内只发一次（否则一天 288 条）。
    const recent = db.one(`SELECT id FROM audit_log WHERE action='daemon_refused_bind' AND ts>?`, Date.now() - 6 * 3600_000);
    if (!recent) {
      audit(db, { actorKind: 'system', action: 'daemon_refused_bind', targetType: 'binding', targetId: 'all', payload: { who, db: cur.binding, flags: overrides } });
      try { await pushSignal(db, 'deploy.refused_bind', { to: ['admins'], title: tl(contentLang(db), '[SuperIntern] {who} 没起来：启动参数的 --bind 与库里不一致', { who }), text: msgIn(contentLang(db)), ref: 'binding' }, { env: process.env, extraCmd: flags.notify }); } catch { /* 尽力 */ }
    }
    die(msg);
  }
  const { userId } = cliIdentity(db, flags);
  let r;
  try { r = seedBinding(db, { overrides, userId }); } catch (e) { die(translateError(e, lang())); }
  console.log(tl(lang(), '库里没有绑定行，已按 --bind 写入（以后启动不用再带）：'));
  printBinding(db, r);
}

// 一个服务商（网关按模型）眼下的状况，一句话
const healthLine = (h) => [
  h.state === 'open' ? tl(lang(), '连着出错，系统暂时不调用它；{t} 之后第一个要用它的步骤会先试一次', { t: new Date(h.reopenAt).toLocaleTimeString() }) : h.state === 'half_open' ? tl(lang(), '连着出错，系统暂时不调用它；下一个要用它的步骤会先试一次') : null,
  h.backoffUntil ? tl(lang(), '被限流，所有进程一起等到 {t}', { t: new Date(h.backoffUntil).toLocaleTimeString() }) : null,
  h.recentFails ? tl(lang(), '最近 5 分钟 {f}/{n} 次出错', { f: h.recentFails, n: h.recentTotal }) : null,
  h.fallbackSince ? tl(lang(), '换用过备用模型') : null,
  h.lastStatus || h.lastError ? tl(lang(), '最近一次：{e}', { e: `${h.lastStatus ? `HTTP ${h.lastStatus} ` : ''}${String(h.lastError ?? '').slice(0, 80)}` }) : null,
].filter(Boolean).join(tl(lang(), '；'));

function printBinding(db, b = bindingOf(db)) {
  const reg = registryFor(db);
  console.log(b.source === 'db' ? tl(lang(), '档位绑定（库）：') : tl(lang(), '档位绑定（代码默认值，库里还没写）：'));
  for (const t of TIERS) {
    const m = reg.catalog[b.binding[t]];
    console.log(`  ${t.padEnd(8)} ${b.binding[t]}${b.efforts?.[t] ? tl(lang(), '  推理强度 {effort}', { effort: b.efforts[t] }) : ''}${m ? `  → ${m.vendor} · ${m.model}` : tl(lang(), '  （不在目录里）')}`
      + (b.fallbacks?.[t] ? tl(lang(), '  备用 {key}', { key: b.fallbacks[t] }) : ''));
  }
  // 没合上的熔断、正在退避的、换用过备用的
  for (const h of healthView(db)) console.log(tl(lang(), '  ⚠ {key}：{state}', { key: h.key, state: healthLine(h) }));
  for (const p of bindingProblems(db, { env: process.env })) console.log(tl(lang(), '  ⚠ {tier}：{why}', { tier: p.tier, why: dyn(p.why) }));
  // 各角色（单独绑了的标出来）与验收员的异厂商策略
  console.log(tl(lang(), '角色（没单独绑的跟着档位）：'));
  for (const r of rolesView(db)) {
    console.log(`  ${r.role.padEnd(16)} ${r.override ? `${r.override.key}${r.override.effort ? tl(lang(), '  推理强度 {effort}', { effort: r.override.effort }) : ''}${tl(lang(), '  （单独绑定）')}` : r.tier ? tl(lang(), '跟着 {tier} 档', { tier: r.tier }) : tl(lang(), '跟着各步骤的档位（规划器定）')}`);
  }
  const policy = getSetting(db, 'deploy.verifier_vendor');
  console.log(tl(lang(), '验收员：{policy}；高风险步骤会签：{cosign}', { policy: policy === 'different' ? tl(lang(), '与执行器落在同一家时换一家') : tl(lang(), '不强求换一家'), cosign: getSetting(db, 'deploy.verifier_cosign') === 'high_risk' ? tl(lang(), '两家各验一次') : tl(lang(), '不用') }));
  for (const k of [...new Set(TIERS.map((t) => reg.roleBinding.executor?.key ?? b.binding[t]))]) {
    const v = pickVerifierModel(reg, { executorKey: k, policy });
    console.log(tl(lang(), '  执行用 {exec} 时，验收用 {v}{note}', { exec: k, v: v.key, note: v.source === 'policy' ? tl(lang(), '（换了一家）') : v.note === 'only_maker' ? tl(lang(), '（同一家：没有第二家可用）') : v.sameMaker ? tl(lang(), '（同一家）') : '' }));
  }
}

async function cmdRun(db, taskId, flags) {
  db.one(`SELECT * FROM tasks WHERE id=?`, taskId) ?? die(tl(lang(), '没有这个任务：{id}', { id: taskId }));
  const wsDir = flags.dir ?? join(HOME, 'workspaces', taskId);
  if (!existsSync(wsDir)) die(tl(lang(), '工作区不存在。先跑 node src/cli.mjs workspace {taskId}', { taskId }));
  const stage = getTaskParam(db, taskId, 'draft.stage');
  if (stage && stage !== 'approved') die(tl(lang(), '宪法块草案还没批准（draft.stage={stage}），没有可执行的计划。先在看板答复批准问题。', { stage }));

  const mode = flags.mode ?? 'live';
  // 通知通道：.env 里填了哪个用哪个（只查在不在），--notify <cmd> 追加本地命令
  const channels = channelsFromEnv(process.env, flags.notify);
  // 旁路通知不挡编排器，但进程退出前要等它们落地：发完回来要写审计，库先关了就是 "database is not open" 崩在最后一行
  // （例：汇报通知还在路上，run 已经返回、主流程 db.close()）。
  const pendingNotices = new Set();
  const inflight = (p) => { const q = Promise.resolve(p).catch(() => {}); pendingNotices.add(q); q.finally(() => pendingNotices.delete(q)); };
  console.log(tl(lang(), '编排器 pid {pid} · 任务 {taskId} · 工作区 {dir}', { pid: process.pid, taskId, dir: wsDir })
    + (channels.length ? tl(lang(), ' · 通知 {kinds}', { kinds: channels.map((c) => c.kind).join('/') }) : ''));

  // ── 沙箱：**默认开** ────────────────────────────────────────────────────
  // 做成 opt-in 就等于把"命令直接跑在宿主机上"那笔债原样留着 ——一个要记得加的安全开关，
  // 就是一个迟早会忘记加的安全开关。所以退出得显式，而且要吵。
  let exec = null;
  if (flags['no-sandbox']) {
    console.log(tl(lang(), '⚠️ --no-sandbox：命令直接在**宿主机**上跑，这不是隔离。\n   只有离线自测才该这么用（不得对任何真实用户任务这样运行）。'));
    // 落审计的那一笔不在这里，在 orchestrate 里 —— 那是唯一所有调用方都必经的点。
  } else {
    exec = await makeSandbox(db, { taskId, home: HOME, onNote: (m) => console.log(`  ${m}`) });
    const info = await exec.start(wsDir);           // 起不来就抛，不静默退回宿主
    console.log(tl(lang(), '沙箱 {name}（{how}）· {cli} · {image} · 网络 {network} · 内存 {memory} · PID {pids}', {
      name: info.name, how: info.how, cli: info.cli, image: info.image, network: info.network,
      // 合并 agent 分支后内存上限从 params 取，是字节数 —— 给人看的时候换算回 GiB
      memory: /^\d+$/.test(String(info.memory)) ? `${(Number(info.memory) / 1024 ** 3).toFixed(2)} GiB` : info.memory, pids: info.pids }));
    console.log(info.egress
      ? tl(lang(), '  出口白名单：{groups} → {n} 个域，经代理 {proxy}，名单外在 CONNECT 阶段即拒', { groups: exec.egress.groups.join(' + '), n: info.egress.hosts.length, proxy: info.egress.proxy })
      : tl(lang(), '  出网：**完全断网**（没配 egress.groups）。要放行按生态加：node src/cli.mjs egress {taskId} --allow npm', { taskId }));
  }

  // ⚠️ fake 模式**完全无视装配出来的上下文**，按脚本挨个吐响应。它验的是
  // 状态机（挂起、退出、复工、置 done），不是 agent。fake 跑绿说明链是通的，
  // 不说明装配是对的 —— 后者只有真模型跑得出来。
  const script = flags.script ? JSON.parse(readFileSync(flags.script, 'utf8')) : null;
  // try/finally 而不是"跑完再删"：崩溃与触顶也要把容器收干净，否则每崩一次
  // 就在机器上留一个僵尸容器，而下一次 start 会把它 reuse 成"上一次崩溃的现场"。
  let r;
  try {
    r = await orchestrate(db, {
    taskId, workspace: wsDir,
    ...(exec ? { exec } : {}),
    // `--bind heavy=deepseek/deepseek-v4-pro`（可重复）——**档位是抽象槽**：
    // 例如跑到一半 anthropic/claude-opus-5 开始回
    // `403 forbidden: Request not allowed`（配额或权限，前几次调用都还正常），
    // heavy 挂了、standard 没事。写死模型的话这里只能停工等厂商；
    // 换个绑定就能接着跑，而这正是拒绝单厂商锁定要换来的东西。
    // 每个节点建客户端时重读库里的绑定 —— 改绑定跑完当前节点就换
    makeClient: () => new LlmClient({
      mode, cassette: flags.cassette, ...clientOpts(db, flags),
      ...fakeOpt(flags) }),
    narrativeDir: join(HOME, 'narratives', taskId),
    maxCycles: flags.once ? 1 : Number(flags.cycles ?? 12),
    maxIterations: Number(flags.iterations ?? 20),
    tierOverride: flags.tier ?? null,
    commit: !flags['no-commit'],
    verify: !flags['no-verify'],
    // 汇报器与 LLM 验收员：真跑默认开。`--no-report` / `--no-llm-verify` 关。
    // `--script`（脚本化假模型）时默认**关**：一卷脚本只够执行器一个角色消费，验收员
    // 和汇报器会把执行器的下一条响应吃掉。
    // 要在脚本模式下测它们，显式 `--report` / `--llm-verify`，并把脚本按角色顺序写好。
    report: flags.report ? true : flags['no-report'] ? false : !script,
    llmVerify: flags['llm-verify'] ? true : flags['no-llm-verify'] ? false : !script,
    onEvent: (e) => {
      switch (e.type) {
        case 'cycle':
          console.log(tl(lang(), '\n── 轮 {cycle} ── 任务 {status}｜节点 {counts}｜待答问题 {open}', { cycle: e.cycle, status: e.status, counts: JSON.stringify(e.counts), open: e.openQuestions }));
          break;
        case 'reclaimed':
          console.log(tl(lang(), '↻ 认领 {nodeId}：启动时它还停在 running —— 上一个进程死在它手里，退回 pending 重来', { nodeId: e.nodeId }));
          break;
        case 'question_defaulted':
          console.log(tl(lang(), '⏱ 超时走默认（{level} 级 {qid}）：无人答复，按登记的默认动作放行 —— {action}', { level: e.level === 1 ? 'Ⅰ' : 'Ⅱ', qid: e.questionId, action: String(e.defaultAction).slice(0, 120) }));
          break;
        case 'question_escalated':
          console.log(tl(lang(), '⏱ 超时升级（Ⅱ 级 {qid}）：第一段无人答复；再无人答将退保守默认。请尽快：node src/cli.mjs answer {qid} "..."', { qid: e.questionId }));
          // 推送：超时链已记信号（timeout.escalated），这里只把发件箱推出去
          inflight(deliverSignals(db, { env: process.env, extraCmd: flags.notify }));
          break;
        case 'question_stuck':
          console.log(tl(lang(), '⏱ 超时后仍挂起（{qid}）：升级后无人答，且没有默认可退 —— 分支继续等人', { qid: e.questionId }));
          break;
        case 'escalated':
          console.log(tl(lang(), '⬆ 升档 [{nodeId}] {from} → {to}：同一节点已失败 {n} 次，预计再花 {usd}，已过预算与时长闸门', { nodeId: e.node.id, from: e.from, to: e.to, n: e.node.retry_count, usd: `$${((e.estimateMicro ?? 0) / 1e6).toFixed(4)}` }));
          break;
        case 'node_start':
          console.log(tl(lang(), '执行 [{nodeId}] {title}（档位 {tier}）', { nodeId: e.node.id, title: e.node.title, tier: e.tier }));
          break;
        case 'branch_waiting':
          console.log(tl(lang(), '⏸ 分支等人（问题 {qs}）—— 转去跑不受牵连的就绪节点：{ready}。答复在下一个节点边界被消费。', { qs: e.questions.join(', '), ready: e.ready.join(', ') }));
          break;
        case 'step':
          console.log(tl(lang(), '  轮 {i}: {reason}', { i: e.i + 1, reason: e.resp.stopReason })
            + toolCallsOf(e.resp).map((c) => ` → ${c.name}(${JSON.stringify(c.args).slice(0, 70)})`).join(''));
          break;
        case 'billed':
          if (e.rows) console.log(tl(lang(), '  记账 {rows} 次调用，{usd}', { rows: e.rows, usd: fmtUsd(e.microUsd) }));
          break;
        case 'node_end': {
          const r2 = e.result;
          console.log(tl(lang(), '  装配 {id}（{recipe}）{tokens} token｜{cache}', { id: r2.assemblyId, recipe: r2.meta.recipe, tokens: r2.meta.tokenEstimate, cache: dyn(r2.meta.cacheNote) }));
          if (r2.meta.resume) {
            const m = r2.meta.resume;
            console.log(tl(lang(), '  复工：简报 {briefingId} + 答复 {answerId}', { briefingId: m.briefingId, answerId: m.answerId })
              + (m.retainedRatio !== null
                ? tl(lang(), '｜挂起时 {before} token → 重建 {after} token（保留 {pct}%）', { before: m.contextTokensAtSuspend, after: m.rebuiltTokens, pct: (m.retainedRatio * 100).toFixed(1) }) : ''));
          }
          console.log(tl(lang(), '  叙事 {ref}', { ref: r2.narrativeRef }));
          r2.rejections.forEach((x, i) => console.log(tl(lang(), '  交接被拒 {i}：{errs}', { i: i + 1, errs: x.join(tl(lang(), '；')) })));
          if (r2.kind === 'done') {
            console.log(tl(lang(), '  ✅ 交接记录 {id} 已过库层触发器', { id: r2.handoffId }));
            for (const c of r2.conflicts) console.log(tl(lang(), '  ⚠️ 假设冲突 {key}：与 {prior} 撞车', { key: c.subjectKey, prior: c.priorId }));
          }
          break;
        }
        // 修正流水线第 4 步："修正仅涉执行层 → **diff 推送后**直接继续。"
        //
        // ⚠️ 这个分支原来**不存在**。编排器一直在发 revision_applied 事件，
        // CLI 的 switch 里没有它 —— 于是门没触发的那条路上，计划被改了、
        // 节点被加了、规格被换了，屏幕上一个字都没有。
        // 确认门管的是"要不要人点头"，这一条管的是"人知不知道" —— 两件事。
        case 'revision_applied':
          console.log(`\n${'─'.repeat(72)}`);
          console.log(tl(lang(), '计划已按修正改动（未触发确认门，自动生效）　提案 {id}', { id: e.revisionId }));
          console.log(renderDiff(e.summary, e.rev, lang()));
          console.log(tl(lang(), '作废 {voided}｜改规格 {respecced}｜重挂依赖 {rewired}｜新增 {added}', { voided: e.voided.length, respecced: e.respecced.length, rewired: e.rewired.length, added: e.added.length }));
          console.log(tl(lang(), '要看全文/回溯：node src/cli.mjs revision {taskId} --history', { taskId: e.taskId ?? '' }).trimEnd());
          console.log('─'.repeat(72));
          break;
        case 'commit':
          console.log(tl(lang(), '  已提交 {sha}：{files}', { sha: String(e.sha?.slice(0, 8)), files: e.changed.join(', ') }));
          break;
        // 推送摘要、可拉细节。摘要打在这里；细节 `reports <taskId> --show <id>`。
        // 通道从 .env 来（ntfy / 飞书 / 钉钉 / 企微 / 本地命令），`--notify <cmd>` 追加一条。旁路，不等它。
        case 'report': {
          const r = e.report;
          if (!r) break;
          console.log(tl(lang(), '\n📣 汇报 {id}（{trigger}{tpl}）：{summary}', { id: r.id, trigger: r.trigger, tpl: r.generatedBy === 'template' ? tl(lang(), '，模板') : '', summary: r.summary }));
          if (r.selfDecidedCount) console.log(tl(lang(), '   自作主张 {n} 条 —— 看 node src/cli.mjs reports {taskId} --show {id}', { n: r.selfDecidedCount, taskId, id: r.id }));
          if (r.gaps?.length) console.log(tl(lang(), '   ⚠️ 持久化纪律审计：{n} 条 —— {first}…', { n: r.gaps.length, first: r.gaps[0].slice(0, 80) }));
          const CL = contentLang(db);   // 进库的文字用内容语言
          // 每步汇报是"进度（每步）"—— 抽检下只留记录，逐项审批下推给任务负责人；原来一律推部署通道
          try {
            emitSignal(db, 'run.report', { to: ['owner'], taskId, ref: r.id, title: tl(CL, '[SuperIntern] 汇报：{summary}', { summary: String(r.summary).slice(0, 80) }),
              text: `${r.summary}\n${tl(CL, '任务 {taskId}｜汇报 {id}（{trigger}）', { taskId, id: r.id, trigger: r.trigger })}${r.selfDecidedCount ? tl(CL, '｜自作主张 {n} 条', { n: r.selfDecidedCount }) : ''}` });
          } catch { /* 记信号失败不挡编排器 */ }
          inflight(deliverSignals(db, { env: process.env, extraCmd: flags.notify }));
          break;
        }
        case 'verify':
          console.log(tl(lang(), '\n任务级验收：{cmd}', { cmd: e.argv.join(' ') }));
          break;
        case 'verified':
          console.log(`  exit=${e.verification.code}\n  ${e.verification.tail.replace(/\n/g, '\n  ')}`);
          break;
      }
    },
    });
  } finally {
    // 每次退出都删容器，挂起等人时也删。
    //
    // 这不是省资源，是同一条道理换了个身：挂起分支之所以不冷冻上下文，
    // 是因为冷冻会复活一个过时的世界观。留着一个热容器等三天，留的也是一份
    // 过时的环境。所有该留下的东西都在 bind mount 的工作区里，容器里剩下的
    // 只有 /tmp —— 那本来就该是易逝的。复工时从镜像 + 工作区重建。
    if (exec) {
      const s = await exec.stop();
      if (s) console.log(tl(lang(), '沙箱 {name} 已删除（复工时从镜像重建，不留热容器）', { name: s.name }));
    }
  }

  console.log(`\n${'='.repeat(72)}`);
  if (r.kind === 'suspended') {
    const q = r.questions[0];
    console.log(tl(lang(), '分支挂起，编排器退出（pid {pid}）。完成 {n} 个节点。', { pid: r.pid, n: r.completed.length }));
    console.log(tl(lang(), '\n第 {level} 级问题 {id}：\n\n  {text}\n', { level: q.level, id: q.id, text: q.text }));
    if (q.contextTokens) console.log(tl(lang(), '  挂起时上下文 {tokens} token，已丢弃；复工简报 {briefingId} 留在库里', { tokens: q.contextTokens, briefingId: q.briefingId }));
    if (q.egress) {
      // 出口放行有一条更短的路：`egress --allow` 一条命令同时改白名单并答复。
      // 不指出来的话，人会照着通用提示只 answer 一次 —— 分支解冻了，白名单没变，
      // 复工的实例撞上同一堵墙再问一遍。
      console.log(tl(lang(), '  ⚠️ 这是**状态机强制定级**的 Ⅲ 级问题（level_source=hard_rule），不是模型自评'));
      console.log(tl(lang(), '  证据核对：{check}', { check: q.egress.corroborated ? tl(lang(), '请求与审计轨里的被拒记录对得上')
        : Object.keys(q.egress.deniedHosts).length ? tl(lang(), '**对不上** —— 它要的和它实际撞的墙不是一回事，看正文')
          : tl(lang(), '无被拒记录（此前完全断网，本就不产生）') }));
      console.log(tl(lang(), '\n同意放行（一条命令同时改白名单 + 答复 + 解冻）：'));
      console.log(`  node src/cli.mjs egress ${taskId} --allow ${q.egress.group}`);
      console.log(tl(lang(), '不同意：\n  node src/cli.mjs answer {id} "不放行，理由……"', { id: q.id }));
    } else {
      console.log(tl(lang(), '\n回答它：\n  node src/cli.mjs answer {id} "你的答复"', { id: q.id }));
    }
    console.log(tl(lang(), '然后重跑 run —— 那会是一个**新进程**，只能看见库里的东西。'));
  } else if (r.kind === 'complete' && r.already) {
    // 对已 done 的任务再 run：没有待消费的修正 / 指令，编排器什么都没做就退出（不单独说明的话会印出 "0 个节点 @ undefined"）。
    console.log(tl(lang(), '任务早已完成，也没有待处理的修正或新指令 —— 本次没有新工作。'));
    console.log(tl(lang(), '  要再改它：node src/cli.mjs say {taskId} "……" --kind correction   然后再 run', { taskId }));
    console.log(tl(lang(), '  看产物在哪：node src/cli.mjs show {taskId}', { taskId }));
  } else if (r.kind === 'complete') {
    console.log(tl(lang(), '任务完成。{n} 个节点，产物在分支 {branch} @ {head}', { n: r.completed.length, branch: String(r.workspace?.branch), head: String(r.workspace?.head?.slice(0, 8)) }));
    if (r.verification) console.log(tl(lang(), '任务级验收 {cmd} exit={code}', { cmd: r.verification.argv.join(' '), code: String(r.verification.code) }));
    else console.log(tl(lang(), '⚠️ 未配置任务级验收命令（建任务时的 --verify），完成判据只到节点层'));
  } else if (r.kind === 'limit_breached') {
    // 触顶行为是"强制汇报 + 提问"，绝不静默死掉也绝不静默续跑。
    // 这条问题是**状态机写的**，不是模型写的 —— 钱花光了还要再花钱才能说出
    // "钱花光了"，那闸门就有一个自指的洞。
    console.log(tl(lang(), '⛔ 硬上限触顶，编排器停止（pid {pid}）。完成 {n} 个节点。', { pid: r.pid, n: r.completed.length }));
    console.log(`  ${r.breach.human}`);
    console.log(tl(lang(), '\n已生成 Ⅲ 级问题 {qid}（定级来源 hard_rule，非模型自评），任务转入 waiting。', { qid: r.questionId }));
    console.log(tl(lang(), '  加额继续：node src/cli.mjs limit {taskId} --{key} <新值>', { taskId, key: r.breach.key.replace('limit.', '') }));
    console.log(tl(lang(), '  看发生了什么：node src/cli.mjs replay {taskId}', { taskId }));
    process.exitCode = 1;
  } else if (r.kind === 'limit_hard_failed') {
    // 硬边界类（on_hit='hard_fail'）：撞顶 = 容器被 OOM / pids-limit 掐死。不给加额建议、
    // 不进提问 —— 这一维加额只是放大宿主上的爆炸半径。
    console.log(tl(lang(), '⛔ 硬边界触顶，编排器停止（pid {pid}）。完成 {n} 个节点。', { pid: r.pid, n: r.completed.length }));
    console.log(`  ${r.breach.human}`);
    console.log(`\n${r.why}`);
    console.log(tl(lang(), '  这一维**不支持加额**。节点已退回 pending（计一次重试）。'));
    console.log(tl(lang(), '  先看它在干什么：node src/cli.mjs replay {taskId}', { taskId }));
    process.exitCode = 1;
  } else if (r.kind === 'sandbox_error') {
    // 沙箱侧：容器运行时的管理命令失败。**不是节点的错**，不计重试。
    console.log(tl(lang(), '⛔ 沙箱出了问题，编排器停止（pid {pid}）。完成 {n} 个节点。', { pid: r.pid, n: r.completed.length }));
    console.log(`  ${r.error?.message ?? ''}`);
    console.log(tl(lang(), '\n节点已退回 pending，**不计重试** —— 这不是节点的错。'));
    console.log(tl(lang(), '  看看容器运行时：docker info / docker images（镜像在不在、容器起不起得来），好了再跑：node src/cli.mjs run {taskId}', { taskId }));
    process.exitCode = 1;
  } else if (r.kind === 'provider_error') {
    // 厂商侧：403 / 重试耗尽的 5xx / 网络。**不是节点的错**，不计重试。
    // 档位是抽象槽 —— 换一家接着跑，业务代码一个字不用动。
    const e = r.error;
    const tier = e.tier ?? '<tier>';
    if (e.config) {
      // 配置侧：绑定的模型 / 服务商停用、键不在目录、.env 没填 key。没有发出任何请求，没花钱。
      console.log(tl(lang(), '⛔ 配置问题，编排器停止（pid {pid}）。完成 {n} 个节点。', { pid: r.pid, n: r.completed.length }));
      console.log(`  ${translateError(e, lang())}`);
      console.log(tl(lang(), '\n节点已退回 pending，**不计重试** —— 这不是节点的错，也没有发出请求。'));
      console.log(tl(lang(), '  看三档现在绑的什么、哪档用不了：node src/cli.mjs bind'));
      console.log(tl(lang(), '  改绑：node src/cli.mjs bind set {tier}=<服务商/模型>，或看板"设置 → 模型分配"；缺 key 的在"设置 → 服务商"里填', { tier }));
      console.log(tl(lang(), '  改完再跑：node src/cli.mjs run {taskId}（守护进程在跑的话，它看到改动会自己接着拉）', { taskId }));
    } else {
      console.log(tl(lang(), '⛔ 厂商侧错误，编排器停止（pid {pid}）。完成 {n} 个节点。', { pid: r.pid, n: r.completed.length }));
      console.log(`  ${e.vendor}/${e.model}${e.status ? ` HTTP ${e.status}` : tl(lang(), '（网络）')}`
        + `${e.retryable ? tl(lang(), '，重试 {n} 次仍失败', { n: e.attempts }) : tl(lang(), '，不可重试')}`);
      console.log(`  ${translateError(e, lang())}`);
      console.log(tl(lang(), '\n节点已退回 pending，**不计重试** —— 这不是节点的错。'));
      console.log(tl(lang(), '  换一家接着跑：node src/cli.mjs bind set {tier}=<服务商/模型>（常态，下个节点起生效）', { tier }));
      console.log(tl(lang(), '  只试这一次：node src/cli.mjs run {taskId} --bind {tier}=<服务商/模型>（模型名打错会列出可绑的）', { taskId, tier }));
    }
    process.exitCode = 1;
  } else if (r.kind === 'revision_pending') {
    console.log(tl(lang(), '⏸ 修正的重规划方案要你批准（pid {pid}）。完成 {n} 个节点。', { pid: r.pid, n: r.completed.length }));
    console.log(tl(lang(), '  为什么要批：{gate}', { gate: dyn(r.gate) }));
    console.log(tl(lang(), '\n看细节：node src/cli.mjs revision {taskId}', { taskId }));
    console.log(tl(lang(), '批准：  node src/cli.mjs revision {taskId} --approve', { taskId }));
    console.log(tl(lang(), '重出一版：node src/cli.mjs revision {taskId} --redo "要怎么改"（这一版不用，连同原修正重出一版）', { taskId }));
    console.log(tl(lang(), '不要这份变更：node src/cli.mjs revision {taskId} --reject', { taskId }));
    console.log(tl(lang(), '批了但有保留意见：在批准后面再加 --reservation "…" —— 照批，那句话进约定清单、标〔保留意见〕，不改变任何一条'));
    process.exitCode = 1;
  } else if (r.kind === 'replan_failed') {
    console.log(tl(lang(), '⚠️ 重规划器几次都产不出通过校验的方案（pid {pid}）：{why}', { pid: r.pid, why: dyn(r.why) }));
    r.rejections?.forEach((x, i) => console.log(tl(lang(), '  第 {i} 次被拒：{errs}', { i: i + 1, errs: x.join(tl(lang(), '；')) })));
    console.log(tl(lang(), '\n那条修正**没有被消费** —— 没处理成就不能标成处理过了，重跑 run 会再试一次。'));
    console.log(tl(lang(), '  修正太含糊的话，换一句更具体的说法：node src/cli.mjs say {taskId} "…" --kind correction', { taskId }));
    process.exitCode = 1;
  } else if (r.kind === 'verify_failed') {
    console.log(tl(lang(), '⚠️ 全部节点已完成，但任务级验收没过 —— **任务不置 done**'));
    console.log(`  ${r.verification.argv.join(' ')} exit=${r.verification.code}`);
    console.log(`  ${r.verification.tail.replace(/\n/g, '\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(tl(lang(), '⚠️ 停在 {kind}：{why}', { kind: r.kind, why: dyn(r.why ?? r.stopped ?? '') }));
    process.exitCode = 1;
  }
  // 进程退出的原因推给人 —— 无人值守时"编排器停了"这件事本身就是最该送达的通知。
  // 每类只有一个出口。停下来是因为挂了事项的（等人答、上限、修正、验收没过、等签收）由事项推送推给该答的人；
  // 其余按类记信号：沙箱 / 模型服务出错 → 部署健康（管理员 + 任务负责人），撞硬边界 → 进度（要注意），做完了且不用签收 → 进度（任务级）。
  await notifyPendingQuestions(db, { env: process.env, extraCmd: flags.notify }).catch(() => []);
  const notice = outcomeNotice(r, taskId, contentLang(db));
  const exitSignal = { sandbox_error: 'run.sandbox_error', provider_error: 'run.provider_error', limit_hard_failed: 'run.hard_failed',
    complete: db.one(`SELECT 1 FROM questions WHERE task_id=? AND decision_type='signoff' AND status IN ('open','escalated')`, taskId) ? null : 'run.complete' }[r.kind];
  if (notice && exitSignal) {
    try { emitSignal(db, exitSignal, { to: exitSignal.startsWith('run.s') || exitSignal === 'run.provider_error' ? ['admins', 'owner'] : ['owner'], taskId, title: notice.title, text: notice.text, ref: notice.ref }); }
    catch { /* 尽力 */ }
  }
  await deliverSignals(db, { env: process.env, extraCmd: flags.notify }).catch(() => []);
  await Promise.all([...pendingNotices]);
}

/**
 * 汇报：默认列未读；`--all` 全部；`--show <id>` 看全文；`--read` 把列出的标已读。
 * 这是"可拉取细节"那一半；"推送摘要"在 run 的 report 事件里。
 */
function cmdReports(db, taskId, flags) {
  db.one(`SELECT id FROM tasks WHERE id=?`, taskId) ?? die(tl(lang(), '没有这个任务：{id}', { id: taskId }));
  if (flags.show) {
    const r = db.one(`SELECT * FROM reports WHERE id=? AND task_id=?`, flags.show, taskId) ?? die(tl(lang(), '没有这份汇报：{id}', { id: flags.show }));
    console.log(r.body);
    console.log(tl(lang(), '\n—— {by}｜装配自 {n} 条真相源记录', { by: r.generated_by === 'llm' ? tl(lang(), '模型生成摘要') : tl(lang(), '模板'), n: Object.values(JSON.parse(r.facts)).flat().length })
      + `｜${when(db, r.created_at, { seconds: true })}${r.read_at ? tl(lang(), '｜已读') : ''}`);
    if (!r.read_at) markReportsRead(db, [r.id]);
    return;
  }
  const rows = listReports(db, taskId, { all: !!flags.all });
  if (!rows.length) { console.log(flags.all ? tl(lang(), '任务 {taskId} 没有任何汇报。', { taskId }) : tl(lang(), '任务 {taskId} 没有未读汇报。（--all 看全部）', { taskId })); return; }
  for (const r of rows) {
    const gaps = JSON.parse(r.gaps);
    console.log(`${r.read_at ? '  ' : '● '}${r.id}　${when(db, r.created_at)}　[${r.trigger}${r.generated_by === 'template' ? tl(lang(), '/模板') : ''}]　${r.summary}`
      + `${gaps.length ? `　⚠️${gaps.length}` : ''}`);
  }
  if (flags.read) { markReportsRead(db, rows.map((r) => r.id)); console.log(tl(lang(), '\n已标 {n} 份为已读。', { n: rows.length })); }
  else console.log(tl(lang(), '\n看全文：--show <id>　标已读：--read'));
}

/**
 * 出口白名单：看 / 改。**宪法层参数，只对人开** ——
 * agent 撞上被拒的域时该做的是 raise_question，不是自己加白名单。
 */
function cmdEgress(db, taskId, flags) {
  db.one(`SELECT id FROM tasks WHERE id=?`, taskId) ?? die(tl(lang(), '没有这个任务：{id}', { id: taskId }));
  const add = list(flags.allow).filter((x) => typeof x === 'string');
  const drop = list(flags.deny).filter((x) => typeof x === 'string');

  if (add.length || drop.length) {
    const cur = new Set(egressGroupsOf(db, taskId));
    add.forEach((g) => cur.add(g));
    drop.forEach((g) => cur.delete(g));
    const { userId } = cliIdentity(db, flags);
    try { setEgressGroups(db, { taskId, groups: [...cur], userId }); } catch (e) { die(translateError(e, lang())); }

    // 放行同时把对应的那条 Ⅲ 级问题答掉。**一次人的动作，两个效果。**
    //
    // 不这么做的话，人要先 `egress --allow npm` 再 `answer <qid> "放行了"` ——
    // 而中间那一步纯属仪式：白名单已经改了，分支却还冻着，忘了第二步就是一个
    // 永远醒不过来的任务。两步之间没有任何需要人再判断一次的东西。
    //
    // ⚠️ 仍然走 recordAnswer，不直接 UPDATE：答复的指令效力来自认证通道，
    // 而这条命令本来就要读 CLI 令牌才能代表人。省掉的是仪式，不是认证。
    for (const g of add) {
      for (const q of openEgressQuestions(db, { taskId, group: g })) {
        const tokenFile = flags['token-file'] ?? TOKEN_FILE;
        if (!existsSync(tokenFile)) {
          console.log(tl(lang(), '⚠️ 已放行 {g}，但找不到 CLI 令牌 {file}，问题 {qid} 没能自动答复。', { g, file: tokenFile, qid: q.id }));
          console.log(tl(lang(), '   手动答：node src/cli.mjs answer {qid} "已放行 {g}"', { qid: q.id, g }));
          continue;
        }
        try {
          // 答复正文写进库：按部署的内容语言
          const r = recordAnswer(db, { questionId: q.id, plaintextToken: readFileSync(tokenFile, 'utf8').trim(),
            body: tl(contentLang(db), '已放行生态 {g}（经 cli egress --allow）。沙箱重启后即可访问该生态的域，其余仍拒。', { g }) });
          console.log(tl(lang(), '  同时答复了 {qid}：分支解冻', { qid: q.id }) + (r.stillOpen ? tl(lang(), '，另有 {n} 个问题还开着', { n: r.stillOpen }) : tl(lang(), '，任务转 running')));
        } catch (e) { console.log(tl(lang(), '⚠️ 已放行 {g}，但答复 {qid} 失败：{err}', { g, qid: q.id, err: translateError(e, lang()) })); }
      }
    }
  }

  const groups = egressGroupsOf(db, taskId);
  const pidOfTask = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;
  console.log(tl(lang(), '任务 {taskId} 可访问的网络', { taskId }) + (pidOfTask ? tl(lang(), '（来自项目 {pid} 的联网设置，项目下所有任务共用）', { pid: pidOfTask }) : ''));
  if (!groups.length) {
    console.log(tl(lang(), '  （空）—— 沙箱**完全断网**，连代理容器都不起。'));
  } else {
    for (const g of groups) { const s = sourceOf(db, g); console.log(tl(lang(), '  {id}　{name}（{kind}{ro}）：{hosts}', { id: g, name: s.name, kind: dyn(s.kindName), ro: s.readOnly ? tl(lang(), '，只读') : '', hosts: s.hosts.join(', ') })); }
    console.log(tl(lang(), '  合计 {n} 个域，名单外的一律被拦', { n: allowlistOf(db, groups).length }));
  }
  // 被拦记录是"漏了哪个源"的唯一发现渠道，所以它该出现在人做放行决定的同一个屏幕上
  const denied = deniedHosts(db, { taskId });
  if (Object.keys(denied).length) {
    console.log(tl(lang(), '\n审计轨里被拦过的域：'));
    for (const [h, n] of Object.entries(denied).sort((a, b) => b[1] - a[1])) {
      const s = sourceForHost(db, h);
      console.log(`  ${h} ×${n}${s ? tl(lang(), '　←　属于「{name}」（{id}）', { name: s.name, id: s.id }) + (groups.includes(s.id) ? tl(lang(), '，已放行') : tl(lang(), '，未放行')) : tl(lang(), '　←　**不在联网目录里**')}`);
    }
  }
  const open = openEgressQuestions(db, { taskId });
  if (open.length) console.log(tl(lang(), '\n有 {n} 条联网请求在等你：{ids}（--allow 对应的源会同时答掉它）', { n: open.length, ids: open.map((q) => q.id).join(tl(lang(), '、')) }));
  console.log(tl(lang(), '\n联网目录：{ids}（node src/cli.mjs sources 看详情）', { ids: egressSources(db).map((s) => s.id).join(' / ') }));
  console.log(tl(lang(), '  加：node src/cli.mjs egress {taskId} --allow pypi', { taskId }));
  console.log(tl(lang(), '  减：node src/cli.mjs egress {taskId} --deny pypi', { taskId }));
}

/** 联网目录（部署级，管理员维护）：看 / 加 / 删。 */
function cmdSources(db, sub, args, flags) {
  if (!sub || sub === 'list') {
    const creds = sourceCredentials(db);
    for (const s of egressSources(db)) {
      console.log(`${s.id}　${s.name}　[${dyn(s.kindName)}${s.readOnly ? tl(lang(), '·只读') : ''}${s.builtin ? tl(lang(), '·内置') : ''}]`);
      // 带凭据的工具配置（最小权限注入以前录入的）不回显凭据：凭据部分不再注入沙箱，提示改用源的凭据
      const env = Object.entries(s.toolEnv).map(([k, v]) => (secretLike(k, v) ? tl(lang(), '{k}=（带着凭据，凭据部分没有注入沙箱：改用 sources cred add）', { k }) : `${k}=${v}`));
      const c = creds[s.id];
      console.log(`    ${s.hosts.join(', ')}${env.length ? `\n    ${tl(lang(), '工具配置：{env}', { env: env.join('  ') })}` : ''}${c ? `\n    ${tl(lang(), '凭据：{id}　出口代理替工具带上 {header}（{hint}），{scope}', { id: c.id, header: c.header, hint: c.hint, scope: c.allowWrite ? tl(lang(), '读写请求都带') : tl(lang(), '只在读取的请求上带（下载包、查元数据）') })}` : ''}${s.note ? `\n    ${dyn(s.note)}` : ''}`);
    }
    console.log(tl(lang(), '\n加：node src/cli.mjs sources add --name "清华 PyPI 镜像" --host pypi.tuna.tsinghua.edu.cn [--kind package|info] [--read-only|--writable] [--env PIP_INDEX_URL=https://…]'));
    console.log(tl(lang(), '删：node src/cli.mjs sources remove <id>'));
    console.log(tl(lang(), '凭据：node src/cli.mjs sources cred add <源 id> (--key-file <文件> | --stdin) [--basic] [--header Authorization] [--allow-write] | cred revoke <凭据 id>'));
    return;
  }
  const { userId } = cliIdentity(db, flags);
  try {
    if (sub === 'add') {
      const env = Object.fromEntries(list(flags.env).filter((x) => typeof x === 'string').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
      const s = addSource(db, { name: flags.name, kind: flags.kind ?? 'package', hosts: list(flags.host).filter((x) => typeof x === 'string'),
        readOnly: flags['read-only'] ? true : flags.writable ? false : null, toolEnv: env, note: flags.note ?? '', userId });
      console.log(tl(lang(), '已加入联网目录：{id}　{name}（{kind}{ro}）：{hosts}', { id: s.id, name: s.name, kind: dyn(s.kindName), ro: s.readOnly ? tl(lang(), '，只读') : '', hosts: s.hosts.join(', ') }));
      console.log(tl(lang(), '  项目要用它：node src/cli.mjs project egress <项目 id> --add {id}', { id: s.id }));
    } else if (sub === 'remove') {
      const r = removeSource(db, { id: args[0] ?? die('sources remove <id>'), userId });
      console.log(tl(lang(), '已从联网目录删掉：{name}', { name: r.removed.name }) + (r.usedBy.length ? tl(lang(), '\n  ⚠ 这些项目原来勾着它，现在访问不了了：{list}', { list: r.usedBy.map((p) => `${p.title}${tl(lang(), '（{name}）', { name: p.id })}`).join(tl(lang(), '、')) }) : ''));
    } else if (sub === 'cred') {
      // 源的凭据只进出口代理，沙箱里看不到。值从文件或标准输入读（不接受写在命令行上），内容是整个请求头的值，例如 Bearer xxx
      const L = lang();
      if (args[0] === 'revoke') {
        const done = revokeSourceCredential(db, { id: args[1] ?? die('sources cred revoke <凭据 id>'), byUserId: userId });
        console.log(done ? tl(L, '已吊销。之后起的沙箱不再带它（已经在跑的沙箱要等下一次起）') : tl(L, '这份凭据早就吊销了'));
        return;
      }
      if (args[0] !== 'add') die(tl(L, 'sources cred add <源 id> (--key-file <文件> | --stdin) [--basic] [--header Authorization] [--allow-write] | sources cred revoke <凭据 id>'));
      const sourceId = args[1] ?? die(tl(L, 'sources cred add <源 id> …：先用 sources 看源的 id'));
      const secret = typeof flags['key-file'] === 'string' ? readSecretFile(flags['key-file'], L) : flags.stdin ? readFileSync(0, 'utf8')
        : die(tl(L, '凭据从文件（--key-file <路径>）或标准输入（--stdin）读；不接受写在命令行上（会留在 shell 历史和进程列表里）'));
      // --basic：输入的是"用户名:密码"（私有镜像常见），这里拼成 Basic 认证头的值；不带就是整个请求头的值（例如 Bearer 加令牌）
      const value = flags.basic ? `Basic ${Buffer.from(String(secret).trim()).toString('base64')}` : secret;
      if (flags.basic && !/^[^:\s]+:\S+$/.test(String(secret).trim())) die(tl(L, '--basic 要的是 用户名:密码'));
      const r = addSourceCredential(db, { sourceId, header: typeof flags.header === 'string' ? flags.header : 'Authorization', secret: value, allowWrite: !!flags['allow-write'], byUserId: userId });
      console.log(tl(L, '已配好：{id}（{hint}）。之后起的沙箱经出口代理访问这个源时带上它；沙箱里的代码看不到值。', r));
      if (r.dropped.length) console.log(tl(L, '  工具配置 {keys} 里的凭据已清掉（不再注入沙箱，改由这份凭据代替）', { keys: r.dropped.join(', ') }));
      console.log(flags['allow-write'] ? tl(L, '  ⚠ 读写请求都带：沙箱里的代码能用它改这个源上的东西（例如发布）。这是你显式允许的，已记审计。')
        : tl(L, '  只在读请求（GET / HEAD）上带；用到这份凭据的沙箱里，其余地址也只能读 —— 防止拿它读到的东西被送出去改别处。'));
    } else die('sources [list] | add | remove <id> | cred add|revoke');
  } catch (e) { die(translateError(e, lang())); }
}

/**
 * 修正提案：看 / 批准 / 驳回（修正流水线第 5 步的确认门）。
 *
 * 与 `egress --allow` 同一个模式：**一次人的动作，两个效果** —— 改状态 +
 * 写一条经认证通道的答复并解冻分支。不合并的话，人批准了提案却忘了 answer，
 * 任务就冻在那里，而看上去一切正常。省掉的是仪式，不是认证。
 */
async function cmdRevision(db, taskId, flags) {
  db.one(`SELECT id FROM tasks WHERE id=?`, taskId) ?? die(tl(lang(), '没有这个任务：{id}', { id: taskId }));

  // `--history`：没触发门、自动生效过的那些提案。它们不在 pendingRevision 里
  // （只认 proposed），而人唯一见过它们的时刻是当时那一屏日志滚过去 ——
  // 没有这条，"不默默换计划"就只保到日志被清掉为止。
  if (flags.history) {
    const rows = db.all(`SELECT * FROM revisions WHERE task_id=? ORDER BY rowid`, taskId);
    if (!rows.length) { console.log(tl(lang(), '任务 {taskId} 没有任何修正提案。', { taskId })); return; }
    for (const r of rows) {
      const m = db.one(`SELECT body,kind FROM messages WHERE id=?`, r.message_id);
      console.log(`\n${r.id}　${r.status}　${when(db, r.proposed_at, { seconds: true })}`
        + `　${r.gate ? tl(lang(), '门：{gate}', { gate: dyn(r.gate) }) : tl(lang(), '门未触发（自动生效）')}`);
      console.log(tl(lang(), '  修正（{kind}）：{body}', { kind: String(m?.kind), body: String(m?.body ?? '').slice(0, 160) }));
      const imp = JSON.parse(r.impact);
      const c = imp.reduce((o, x) => ({ ...o, [x.mark]: (o[x.mark] ?? 0) + 1 }), {});
      console.log(tl(lang(), '  影响：{marks}', { marks: Object.entries(c).map(([k, v]) => `${k} ${v}`).join('｜') })
        + tl(lang(), '｜新增 {n}', { n: JSON.parse(r.new_nodes).length })
        + tl(lang(), '｜作废金额 {voided} / 已完成 {done}', { voided: `$${(r.discarded_micro_usd / 1e6).toFixed(4)}`, done: `$${(r.done_micro_usd / 1e6).toFixed(4)}` }));
    }
    return;
  }

  const rv = pendingRevision(db, taskId);
  if (!rv) {
    console.log(tl(lang(), '任务 {taskId} 没有待处理的修正提案。', { taskId }));
    console.log(tl(lang(), '（自动生效过的看 node src/cli.mjs revision {taskId} --history）', { taskId }));
    return;
  }

  const nodes = nodesForReplan(db, taskId);
  const rev = {
    impact: JSON.parse(rv.impact), salvage: JSON.parse(rv.salvage),
    changed_nodes: JSON.parse(rv.changed_nodes), new_nodes: JSON.parse(rv.new_nodes),
    constitution_patch: rv.constitution_patch ? JSON.parse(rv.constitution_patch) : null,
    rationale: rv.rationale,
  };
  const msg = db.one(`SELECT * FROM messages WHERE id=?`, rv.message_id);

  if (!flags.approve && !flags.reject && !flags.redo) {
    console.log(tl(lang(), '修正提案 {id}　状态 {status}', { id: rv.id, status: rv.status }));
    console.log(tl(lang(), '\n人发来的修正（{kind}{urgent}）：', { kind: msg.kind, urgent: msg.urgency === 'urgent' ? tl(lang(), '/紧急') : '' }));
    console.log('  ' + String(msg.body).split('\n').join('\n  '));
    console.log(`\n${renderDiff(gateOf(db, { taskId, rev, nodes }), rev, lang())}`);
    console.log(tl(lang(), '\n逐节点影响标记（这才是真护栏 —— 每一次作废都有出处、有理由、事后查得到）：'));
    for (const m of rev.impact) {
      const n = nodes.find((x) => x.id === m.node_id);
      console.log(`  [${m.mark.padEnd(12)}] ${String(n?.title ?? m.node_id).slice(0, 40)}`);
      console.log(`      ${m.reason}`);
    }
    if (rv.gate) {
      console.log(tl(lang(), '\n⚠️ 要你批准：{gate}', { gate: dyn(rv.gate) }));
      console.log(tl(lang(), '  批准：node src/cli.mjs revision {taskId} --approve', { taskId }));
      console.log(tl(lang(), '  重出一版：node src/cli.mjs revision {taskId} --redo "要怎么改"', { taskId }));
      console.log(tl(lang(), '  不要这份变更：node src/cli.mjs revision {taskId} --reject', { taskId }));
      console.log(`  ${tl(lang(), '批了但有保留意见：在批准后面再加 --reservation "…" —— 照批，那句话进约定清单、标〔保留意见〕，不改变任何一条')}`);
    }
    return;
  }

  const tokenFile = flags['token-file'] ?? TOKEN_FILE;
  if (!existsSync(tokenFile)) die(tl(lang(), '找不到 CLI 令牌 {file}。先跑 node src/cli.mjs init', { file: tokenFile }));
  const plaintext = (flags.token ?? readFileSync(tokenFile, 'utf8')).trim();
  const { userId } = ensureOwner(db);

  try {
    if (flags.approve) {
      const r = applyRevision(db, { taskId, revisionId: rv.id, by: 'user', userId, reservation: flags.reservation ?? null });
      console.log(tl(lang(), '已应用 {id}：作废 {voided}｜改规格 {respecced}｜新增 {added}', { id: rv.id, voided: r.voided.length, respecced: r.respecced.length, added: r.added.length }));
      if (r.newConstitution) console.log(tl(lang(), '  宪法块已修订 → {id}（agent 无权自改，这一步只能由人触发）', { id: r.newConstitution }));
      if (r.voided.length) console.log(tl(lang(), '  ⚠️ 作废的节点**产物没有被删**：git 历史里仍在，决策日志记了"因修正作废"'));
      if (flags.reservation) console.log(tl(lang(), '  保留意见已记进项目的约定清单（标〔保留意见〕）：它不改变这份变更里的任何一条，只是让下一个碰这一处的人看得到。'));
    } else {
      const redo = typeof flags.redo === 'string' ? flags.redo.trim() : '';
      rejectRevision(db, { taskId, revisionId: rv.id, userId, why: redo || tl(contentLang(db), '不要这份变更'), redo: redo ? { text: redo } : null });
      console.log(redo ? tl(lang(), '已驳回 {id}，并把你的意见连同原来那条修正交回去：下一轮 AI 重出一版，再来问你。', { id: rv.id })
        : tl(lang(), '已驳回 {id}（不要这份变更）。计划原样不动，那条修正作罢。', { id: rv.id }));
    }
  } catch (e) { die(translateError(e, lang())); }

  if (rv.question_id) {
    try {
      // 答复正文写进库：按部署的内容语言
      const a = recordAnswer(db, { questionId: rv.question_id, plaintextToken: plaintext,
        body: flags.approve ? tl(contentLang(db), '批准修正提案 {id}（经 cli revision --approve）', { id: rv.id })
          : typeof flags.redo === 'string' && flags.redo.trim() ? tl(contentLang(db), 'B：{why}', { why: flags.redo.trim() })
          : tl(contentLang(db), '驳回修正提案 {id}（经 cli revision --reject）', { id: rv.id }) });
      console.log(tl(lang(), '  同时答复了 {qid}', { qid: rv.question_id }) + (a.stillOpen ? tl(lang(), '，另有 {n} 个问题还开着', { n: a.stillOpen }) : tl(lang(), '，任务解冻')));
    } catch (e) { console.log(tl(lang(), '⚠️ 状态已改，但答复 {qid} 失败：{err}', { qid: rv.question_id, err: translateError(e, lang()) })); }
  }
  // 决定比对的第四个入口：**批准过的宪法补丁**也要对着有效清单比一次。
  // 前三个入口比的是"人说的话"，而人说的往往只是一阶要求；把二阶后果写死的是这份补丁。
  if (flags.approve) {
    const patch = rv.constitution_patch ? JSON.parse(rv.constitution_patch) : null;
    const msg = db.one(`SELECT body FROM messages WHERE id=?`, rv.message_id)?.body ?? rv.rationale;
    const text = revisionCheckText(db, { instruction: msg, patch });
    if (text) await reportDecisionHits(db, { taskId, text, entry: 'revision', by: userId, flags });
  }
  console.log(tl(lang(), '\n下一步：node src/cli.mjs run {taskId}', { taskId }));
}

/**
 * 沙箱容器的清扫口。
 *
 * 容器活得比进程长，这是编排器重生在沙箱里的新形态：进程被 kill -9
 * 之后 finally 不会跑，容器就留在机器上。留着不致命（下次 start 会 reuse），
 * 但**必须有一条命令能看见它们** —— 看不见的资源泄漏等于没有泄漏，直到磁盘满。
 */
async function cmdSandbox(db, flags) {
  const rt = detectRuntime();
  console.log(tl(lang(), '运行时 {cli} {version} · 镜像 {image}', { cli: rt.cli, version: rt.version, image: SANDBOX_IMAGE }));
  const all = listSandboxes(rt.cli).filter((s) => !flags.task || s.taskId === flags.task);
  // 出网代理的派生镜像 `superintern/sandbox:ca-<CA 指纹>-<基础镜像 id>`（egress.ensureCaImage）按 CA / 基础镜像累积，
  // 不随任务结束清理。--reap 顺手删；没 --task 过滤时才动镜像 —— 镜像不属于某个任务。
  const caImages = flags.task ? [] : listCaImages(rt.cli);
  // 没有容器挂着的 cage 网络（旧版本 stop 删序反了漏下的）。攒多了 Docker 地址池用尽，联网任务全部起不来。
  const nets = listOrphanCages(rt.cli).filter((n) => !flags.task || n.endsWith(flags.task));
  if (!all.length && !caImages.length && !nets.length) { console.log(tl(lang(), '没有遗留沙箱，也没有派生镜像与孤儿网络。')); return; }

  for (const s of all) {
    const t = db.one(`SELECT status FROM tasks WHERE id=?`, s.taskId);
    console.log(tl(lang(), '  {name}  [{state}] {status}  任务状态 {task}', { name: s.name, state: s.state, status: s.status, task: t?.status ?? tl(lang(), '（库里没有这个任务）') }));
  }
  if (nets.length) console.log(tl(lang(), '孤儿网络 {n} 张（没有容器挂着）：{list}', { n: nets.length, list: nets.join('  ') }));
  if (caImages.length) console.log(tl(lang(), '派生镜像 {n} 个：{list}', { n: caImages.length, list: caImages.map((i) => i.tag).join('  ') }));
  if (!flags.reap) { console.log(tl(lang(), '\n删掉它们：node src/cli.mjs sandbox --reap')); return; }

  for (const s of all) {
    await new ContainerExecutor({ taskId: s.taskId, db, cli: rt.cli }).stop();
    console.log(tl(lang(), '  已删除 {name}', { name: s.name }));
  }
  for (const n of nets) {
    try { execFileSync(rt.cli, ['network', 'rm', n], { stdio: ['ignore', 'pipe', 'pipe'] }); console.log(tl(lang(), '  已删网络 {n}', { n })); }
    catch (e) { console.log(tl(lang(), '  网络 {n} 没删掉：{err}', { n, err: String(e.stderr ?? e.message).trim().split('\n')[0] })); }
  }
  for (const i of caImages) {
    try { execFileSync(rt.cli, ['image', 'rm', i.tag], { stdio: ['ignore', 'pipe', 'pipe'] }); console.log(tl(lang(), '  已删镜像 {tag}', { tag: i.tag })); }
    catch (e) { console.log(tl(lang(), '  镜像 {tag} 没删掉（可能还有容器在用）：{err}', { tag: i.tag, err: String(e.stderr ?? e.message).trim().split('\n')[0] })); }
  }
}
/** cage 网络里没有任何容器挂着的那些（名字 superintern-cage-<任务 id>）。 */
function listOrphanCages(cli) {
  let out = '';
  try { out = execFileSync(cli, ['network', 'ls', '--filter', 'name=superintern-cage-', '--format', '{{.Name}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return []; }
  return out.split('\n').filter(Boolean).filter((n) => {
    try { return execFileSync(cli, ['network', 'inspect', '-f', '{{len .Containers}}', n], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === '0'; }
    catch { return false; }
  });
}
/** 列出出网代理派生镜像（tag 以 ca- 开头）。下次真跑需要时 ensureCaImage 会重建，删掉不损失什么。 */
function listCaImages(cli) {
  const repo = SANDBOX_IMAGE.split(':')[0];
  let out = '';
  try { out = execFileSync(cli, ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return []; }
  return out.split('\n').filter(Boolean).map((l) => { const [tag, id] = l.split('\t'); return { tag, id }; }).filter((i) => i.tag.startsWith(`${repo}:ca-`));
}

/**
 * 人主动说一句话 —— 不是回答 agent 的提问，是人**发起**。
 *
 * ⚠️ 与 `answer` 的分工：答复要挂 answers 边、要解冻分支、要匹配到具体问题，
 * 走 `cli answer`。这里发的是**没人问就说的话**。
 */
async function cmdSay(db, taskId, body, flags) {
  if (!body?.trim()) die(tl(lang(), '要给正文：node src/cli.mjs say <taskId> "<正文>" [--kind <类别>]'));
  const tokenFile = flags['token-file'] ?? TOKEN_FILE;
  if (!existsSync(tokenFile)) die(tl(lang(), '找不到 CLI 令牌 {file}。先跑 node src/cli.mjs init', { file: tokenFile }));
  const plaintextToken = (flags.token ?? readFileSync(tokenFile, 'utf8')).trim();

  // --kind 显式给：分类器不参与，值一个字不改。
  // 没给：按 cmdPlan 建 client 的写法创建 LlmClient（--bind 透传），交给
  // sayWithClassifier 分类后落库（kind_source=classifier）。fake 走 --script，
  // 与 run 同一条离线路，供离线回归与验收用。
  const kind = flags.kind;
  let llmClient = null;
  if (!kind) {
    llmClient = new LlmClient({
      mode: flags.mode ?? 'live',
      cassette: flags.cassette,
      ...clientOpts(db, flags),
      ...fakeOpt(flags),
    });
  }

  let r;
  try {
    r = await sayWithClassifier(db, {
      taskId, body, kind,
      urgency: flags.urgent ? 'urgent' : 'normal',
      aboutQuestionId: flags.about ? String(flags.about) : null,
      plaintextToken,
      holdForCheck: true,   // 下面要比对，比对完之前别让守护进程拉走
      ...(llmClient ? { llmClient } : {}),
    });
  } catch (e) { die(translateError(e, lang())); }

  if (r.kind === 'answer') {
    console.log(tl(lang(), '分类器认为这句话是在回答开着的问题 {qid}。', { qid: r.questionId }));
    console.log(tl(lang(), '它没有入 messages，也不会自动 recordAnswer —— 答复要挂 answers 边、解冻分支、签你的名字，必须由你显式做：'));
    console.log(`\n  node src/cli.mjs answer ${r.questionId} "${body}"\n`);
    return;
  }

  console.log(tl(lang(), '消息已入库：{id}', { id: r.messageId }));
  console.log(tl(lang(), '  类别 {kind}（kind_source={source}）｜紧急度 {urgency}', { kind: r.kind, source: r.kindSource, urgency: r.urgency }) + (r.aboutQuestionId ? tl(lang(), '｜附在事项 {qid} 上', { qid: r.aboutQuestionId }) : ''));
  console.log(`  trust_label=${r.trust}${r.trust === 'observed-untrusted' ? tl(lang(), ' —— 旁观者留言：会被看到，不进决策') : tl(lang(), ' —— 指令效力只授予认证通道（库层 CHECK 强制）')}`);
  if (r.trust === 'observed-untrusted') return;
  if (r.kind === 'context') {
    console.log(tl(lang(), '\n下一步：重跑 run。它会进执行器上下文的"收件箱"段（缓存断点**之后**，所以不会让已有缓存作废），节点做完即标记消费。'));
  } else {
    console.log(r.kind === 'correction' ? tl(lang(), '\n⚠️ 修正会改变"要做什么"，而那属宪法层，执行器无权自行处置。')
      : tl(lang(), '\n⚠️ 新指令会改变"要做什么"，而那属宪法层，执行器无权自行处置。'));
    console.log(tl(lang(), '   重跑 run 会先跑重规划流水线：逐节点影响评估 → 已完成工作分捡 →'));
    console.log(tl(lang(), '   计划 diff。若触及宪法层、或作废的已完成工作按**花费金额**超过阈值，'));
    console.log(tl(lang(), '   会转成一条要你批准的 Ⅲ 级问题，而不是默默换掉计划。'));
    // 5c 入口②：改变"要做什么"的消息才比对；补充信息不比。
    await reportDecisionHits(db, { taskId, text: body, entry: 'revision', by: r.userId ?? null, flags, sourceId: r.messageId });
  }
}
/**
 * 回答一个挂起分支提出的问题。
 *
 * 令牌明文从 `.superintern/cli-token` 读 —— 那是 `init` 时唯一一次写盘的副本，
 * 库里只有哈希。没有它就写不出一条具指令效力的消息。
 */
/** 开放 / 已升级的问题一览。每行：问题 id、级别、任务、问了多久、超时点、正文开头 —— 够决定要不要现在答。 */
export function cmdQuestions(db, flags = {}) {
  const rows = flags.all
    ? db.all(`SELECT q.*, t.title FROM questions q JOIN tasks t ON t.id=q.task_id ORDER BY (q.status IN ('open','escalated')) DESC, q.asked_at DESC LIMIT 20`)
    : db.all(`SELECT q.*, t.title FROM questions q JOIN tasks t ON t.id=q.task_id WHERE q.status IN ('open','escalated') ORDER BY q.asked_at`);
  if (!rows.length) { console.log(flags.all ? tl(lang(), '没有问题') : tl(lang(), '没有开放的问题')); return rows; }
  const age = (ms) => (ms < 3_600_000 ? tl(lang(), '{n} 分钟', { n: Math.round(ms / 60_000) }) : tl(lang(), '{n} 小时', { n: (ms / 3_600_000).toFixed(1) }));
  for (const q of rows) {
    const open = ['open', 'escalated'].includes(q.status);
    const t = now();
    console.log(`${open ? (q.status === 'escalated' ? '⏱' : '✋') : '✓'} ${q.id}  ${tl(lang(), '{level}级', { level: 'ⅠⅡⅢ'[q.level - 1] ?? q.level })}  ${q.task_id}「${String(q.title).slice(0, 24)}」${q.node_id ? tl(lang(), ' 节点 {id}', { id: q.node_id }) : ''}`
      + (open ? tl(lang(), '  已等 {age}', { age: age(t - q.asked_at) }) + (q.timeout_at ? (q.timeout_at > t ? tl(lang(), '，{age}后超时', { age: age(q.timeout_at - t) }) : tl(lang(), '，已超时')) : '') : `  ${q.status}`));
    console.log(`   ${String(q.text).replace(/\s+/g, ' ').slice(0, 160)}`);
    // 第二个及以后的答复者**先看得到已有答复的原文** —— 知道别人说了什么，才谈得上附议或提不同意见。
    const ans = db.all(`SELECT a.*, u.display_name FROM answers a LEFT JOIN users u ON u.id=a.user_id
                        WHERE a.question_id=? AND a.stance IN ('answer','agree','abstain') ORDER BY a.created_at, a.rowid`, q.id);
    for (const a of ans) {
      const label = { answer: tl(lang(), '答复'), agree: tl(lang(), '附议'), abstain: tl(lang(), '弃权') }[a.stance];
      console.log(`   · ${a.display_name ?? tl(lang(), '系统')} ${label}${a.stance === 'answer' ? tl(lang(), '（{name}）', { name: a.id }) : ''}${tl(lang(), '：')}${String(a.body).replace(/\s+/g, ' ').slice(0, 100)}`);
    }
    // 所在步骤改了任务开始前就有的测试、还没放行 —— 列出来，并说明怎么在答复时一并放行
    const tp = open && q.node_id ? (() => { const al = testsAllowedFor(db, q.node_id); return latestTestChanges(db, q.node_id).filter((c) => c.baseline && !al.has(c.path)).map((c) => c.path); })() : [];
    if (tp.length) console.log(tl(lang(), '   ⚠ 这一步改了任务开始前就有的测试：{paths}（答复时加 --allow-tests 一并放行）', { paths: tp.join(tl(lang(), '、')) }));
    if (open) console.log(`   → node src/cli.mjs answer ${q.id} "..."`
      + `${ans.some((a) => a.stance === 'answer') ? tl(lang(), '   ｜同意已有那条：--agree [答复 id]') : ''}${tl(lang(), '   ｜不归你：--abstain')}`
      + `${q.default_action ? tl(lang(), '   （默认：{a}）', { a: String(q.default_action).slice(0, 60) }) : ''}`);
  }
  return rows;
}

async function cmdAnswer(db, questionId, body, flags) {
  // 三个动作。--agree [答复 id] 附议已有的那条（不写新文本，计入法定人数）；
  // --abstain 弃权（这不归我：从收件人里去掉自己；冲突事项里是撤回自己的立场）。
  const stance = flags.agree ? 'agree' : flags.abstain ? 'abstain' : 'answer';
  if (stance === 'answer' && !body) die(tl(lang(), '要给答复正文：node src/cli.mjs answer <questionId> "你的答复"\n  同意别人已经写的那条：--agree [答复 id]；这条不归你：--abstain "可选的说明"'));
  const tokenFile = flags['token-file'] ?? TOKEN_FILE;
  if (!existsSync(tokenFile)) die(tl(lang(), '找不到 CLI 令牌 {file}。先跑 node src/cli.mjs init', { file: tokenFile }));
  const plaintext = (flags.token ?? readFileSync(tokenFile, 'utf8')).trim();

  const q = db.one(`SELECT * FROM questions WHERE id=? OR id LIKE ?`, questionId, `q_%${questionId}`)
    ?? die(tl(lang(), '没有这个问题：{id}', { id: questionId }));

  let r;
  try {
    r = recordAnswer(db, { questionId: q.id, body, stance,
      agreesWith: typeof flags.agree === 'string' ? flags.agree : null, plaintextToken: plaintext });
  } catch (e) { die(translateError(e, lang())); }
  // 答复时一并放行这一步对原有测试的改动（路径取系统比对出的那几个，见 questions 列表）
  if (flags['allow-tests'] && stance === 'answer') {
    const paths = allowTestChanges(db, { questionId: q.id, userId: r.userId ?? null, answerId: r.answerId ?? null });
    console.log(paths.length ? tl(lang(), '已放行这一步对原有测试的改动：{paths}', { paths: paths.join(tl(lang(), '、')) }) : tl(lang(), '这一步没有待放行的原有测试改动，--allow-tests 没起作用'));
  }

  const pendingText = () => (r.pending ?? []).map((p) => `${p.scope}${tl(lang(), '：')}${p.have}/${p.need}`).join(tl(lang(), '，'));
  if (stance === 'abstain') {
    console.log(tl(lang(), '已记：{what}（{id}）', { what: r.decisionType === 'conflict' ? tl(lang(), '撤回自己的立场') : tl(lang(), '弃权（这条不归你）'), id: r.answerId }));
    if (r.reassigned) console.log(tl(lang(), '  收件人已没有人，事项改派给 {names}', { names: r.reassigned.map((u) => db.one(`SELECT display_name FROM users WHERE id=?`, u)?.display_name ?? u).join(tl(lang(), '、')) }));
    else if (r.unassigned) console.log(tl(lang(), '  ⚠ 收件人全部弃权且没有下一顺位，事项挂起等人处理（会进摘要）'));
    else if (!r.resolved) console.log(tl(lang(), '  法定人数已按剩余人数重算') + ((r.pending ?? []).length ? `${tl(lang(), '：')}${pendingText()}` : ''));
    if (!r.resolved) return;
  }
  console.log(tl(lang(), '{what}已写入：{mid}（answers 表 {aid}）', { what: stance === 'agree' ? tl(lang(), '附议') : tl(lang(), '答复'), mid: r.messageId, aid: r.answerId }));
  if (r.conflictId) { console.log(tl(lang(), '  ⚠ 与他人的答复不一致：两边都没生效，已生成冲突事项 {id}（先双方在那里达成一致，一个工作日内没达成就转负责人）', { id: r.conflictId })); return; }
  if (r.escalated) { console.log(tl(lang(), '  ⚠ 双方再次不一致：冲突事项转给 {to} 裁定', { to: r.to.join(tl(lang(), '、')) })); return; }
  if (r.late) { console.log(`  ${r.stance === 'dissent' ? '⚠ ' : ''}${dyn(r.note)}${r.finalBody ? tl(lang(), '（已生效的结论：{body}）', { body: String(r.finalBody).slice(0, 120) }) : ''}`); return; }
  if (!r.resolved) { console.log(tl(lang(), '  还没生效：法定人数未够（{pending}）', { pending: pendingText() })); return; }
  console.log(tl(lang(), '  answers 边 {mid} → {qid}｜trust_label=user-authenticated｜生效方式 {how}', { mid: r.messageId, qid: r.questionId, how: r.how })
    + (r.superseded ? tl(lang(), '（覆盖了 {n} 条前任答复，已通知）', { n: r.superseded }) : '') + (r.originId ? tl(lang(), '；原事项 {id} 按此了结', { id: r.originId }) : ''));
  console.log(tl(lang(), '  问题置 answered') + (r.nodeId ? tl(lang(), '，节点 {id} 由 blocked 退回 pending', { id: r.nodeId }) : ''));
  const ts = db.one(`SELECT status FROM tasks WHERE id=?`, q.task_id)?.status;
  console.log(tl(lang(), '  该任务还开着 {n} 个问题', { n: r.stillOpen }) + (!r.stillOpen && ts === 'running' ? tl(lang(), '，任务由 waiting 转 running') : ts === 'done' ? tl(lang(), '（任务已完成，这是完成后的事项）') : ''));
  // 下一步提示要认任务的身份：项目载体任务（order 0）答的是批准问题，该拉的是 project plan；草案任务该拉 draft；
  // 其余由守护进程拉 run。否则批准后会提示"重跑 run t_载体"，照做会报"没有节点"。
  const tk = db.one(`SELECT project_id, project_order FROM tasks WHERE id=?`, q.task_id) ?? {};
  const stage = getTaskParam(db, q.task_id, 'draft.stage');
  const manual = tk.project_order === 0 ? `project plan ${tk.project_id}` : (stage && stage !== 'approved') ? `draft ${q.task_id}` : `run ${q.task_id}`;
  console.log(tl(lang(), '\n下一步：守护进程在跑的话会自动拉起；没开守护进程就手动：node src/cli.mjs {manual}  ← 新进程，读库重建上下文', { manual }));
  await reportDecisionHits(db, { taskId: q.task_id, text: body, entry: 'answer', by: r.userId ?? null, flags, sourceId: r.messageId });
}

/**
 * 三个入口共用的收尾：把这次说的话对着项目的有效决定清单过一遍，命中就挂事项。
 * **只报不拦** —— 上面该做的都已经做完了，这一步失败也不影响任何事。
 */
async function reportDecisionHits(db, { taskId, text, entry, by, flags, sourceId = null }) {
  const r = await afterInput(db, { taskId, text, entry, by, sourceId,
    makeClient: () => new LlmClient({ mode: flags.mode ?? 'live', cassette: flags.cassette, ...clientOpts(db, flags),
      ...fakeOpt(flags) }) });
  // 这一行原来印的是 `x.decisionId`，而 raiseDecisionConflict 归并成组之后
  // 返回的是 `decisionIds` 数组 —— 旧字段没人改，命令行上写的就成了"（undefined）"。
  // 归并改了返回值的形状，而这一行是唯一的读者，没有测试读它。现在直接把**主题**印出来：
  // 人要在命令行上一眼看见"撞的是哪条约定"，光有 id 也还是要再敲一条命令。
  for (const x of r.raised ?? []) {
    const subjects = (x.decisionIds ?? []).map((id) => db.one(`SELECT subject FROM decision_registry WHERE id=?`, id)?.subject).filter(Boolean);
    console.log(tl(lang(), '\n⚠ 这次说的和 {n} 条仍然有效的旧决定对不上', { n: subjects.length || 1 })
      + (subjects.length ? `${tl(lang(), '：')}${subjects.map((s) => tl(lang(), '「{s}」', { s: String(s).slice(0, 60) })).join(tl(lang(), '、'))}` : '')
      + tl(lang(), '\n  已挂事项 {qid}', { qid: x.questionId })
      + (x.mode === 'self' ? tl(lang(), '给你自己确认') : x.mode === 'lead' ? tl(lang(), '给项目负责人') : tl(lang(), '给双方商量'))
      + tl(lang(), '：node src/cli.mjs show {taskId}', { taskId }));
  }
}

// Web 看板：只绑 127.0.0.1，身份 = 本机 CLI 令牌。`--bind` 透传给从看板起的 run 子进程。
// `--daemon` 在同一进程里带上守护进程：两者共用一个启动器，看板上"在跑"
// 看得见守护进程起的，守护进程也不会和人按的那次撞车。
async function cmdWeb(db, flags) {
  const { plaintext } = cliIdentity(db, flags);
  await bindForLongRunner(db, flags, 'web');   // 常态绑定在库里，子进程自己读库；--bind 只在库空时写入一次
  const launcher = makeLauncher(db, { home: HOME });
  // 团队模式：多人从各自的电脑访问，看板在反向代理之后。必须给对外地址；监听地址默认仍是本机（代理和看板在同一台机器上）。
  const team = !!flags.team;
  if (team && (typeof flags['public-url'] !== 'string')) die(tl(lang(), '团队模式要给对外地址：web --team --public-url https://<看板的内网域名>  （见 docs/deploy-team.md）'));
  if (!team && flags.host && !['127.0.0.1', 'localhost', '::1'].includes(String(flags.host))) die(tl(lang(), '只有团队模式才能监听本机以外的地址（本机模式不带令牌 = 负责人）：加 --team --public-url …'));
  const w = await startWeb(db, { home: HOME, port: Number(flags.port ?? 7357), host: flags.host ? String(flags.host) : '127.0.0.1', tokenPlain: plaintext, launcher, daemon: !!flags.daemon, envFile: ENV_FILE === 'none' ? null : ENV_FILE,
    team, publicUrl: team ? flags['public-url'] : null });
  sayStartupNotes();
  console.log(team ? tl(lang(), '看板（团队模式）：监听 http://{host}:{port}/，对外地址 {url}；每个人用自己的令牌登录（Ctrl-C 停）', { host: w.host, port: w.port, url: flags['public-url'] })
    : tl(lang(), '看板：http://{host}:{port}/   （只绑本机；Ctrl-C 停）', { host: w.host, port: w.port }));
  for (const p of bindingProblems(db, { env: process.env })) console.log(tl(lang(), '  ⚠ 绑定 {tier}（{key}）：{why} —— 看板"设置"里改', { tier: p.tier, key: p.key, why: dyn(p.why) }));
  warnRuntime(db);
  const d = flags.daemon ? await runDaemon(db, flags, launcher) : null;
  guardLongRunner(db, () => { d?.stop(); w.close(); });
  await new Promise(() => {});   // 挂住进程
}

/**
 * 长寿进程（看板、守护进程）的进程级兜底。原来全仓库没有一个 process.on：
 * - 一个没接住的 Promise（某个请求处理里漏掉的 await）按 Node 默认会让整个看板退出 → 现在记下来、服务照常；
 * - 同步异常之后进程状态不可信 → 记下来再退出（非零），交给外层的进程管理重启；
 * - Ctrl-C / SIGTERM → 停守护进程的定时器、关看板、关库再退出。在跑的任务进程是脱离出去的，不受影响。
 * 编排器（run）不装这些：它崩了就该以非零退出码崩，那是守护进程判断"要不要重拉"的依据。
 */
function guardLongRunner(db, onStop) {
  const report = (kind, e) => {
    console.error(`${new Date().toISOString()} ${kind}: ${e?.stack ?? e}`);
    try { audit(db, { actorKind: 'system', action: 'process_error', payload: { kind, pid: process.pid, error: String(e?.message ?? e).slice(0, 500) } }); } catch { /* 库也坏了：只剩标准错误输出 */ }
  };
  process.on('unhandledRejection', (e) => report('unhandledRejection', e));
  process.on('uncaughtException', (e) => { report('uncaughtException', e); process.exit(1); });
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(tl(lang(), '收到 {sig}，正在停止（在跑的任务进程不受影响）…', { sig }));
    try { onStop(); } catch { /* 尽力 */ }
    // 推进 / 交付的 worker 先自己关（办完手头那件、关库）；强杀开着库的线程偶发进程级崩溃。最多等 5 秒，之后强杀
    import('./core/offthread.mjs').then((m) => m.closeOffThread()).catch(() => {}).finally(() => {
      try { db.close(); } catch { /* 已关 */ }
      process.exit(0);
    });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

// 项目层（project.mjs）：整批契约建项目，串接由守护进程做；这里只有建 / 看 / 手动推进 / 交付。
async function cmdProject(db, sub, args, flags) {
  const { userId, tokenId } = cliIdentity(db, flags);
  if (sub === 'new') { const cc = canCreate(db, userId); if (!cc.ok) die(tl(lang(), '无法新建项目：{why}', { why: dyn(cc.why) })); }
  const textOrFile = (v) => (v === undefined || v === true ? '' : existsSync(String(v)) ? readFileSync(String(v), 'utf8') : String(v));
  if (sub === 'new' && !flags.file) {
    // 新建的唯一入口。--goal / --done 必填；--plan（旧名 --brief）= 已写好的规划，给了就由规划器切成多个任务，
    // 没给就从目标起草第一个任务（追问器）。仓库当场克隆，路径不对当场报错。
    const planFlag = flags.plan ?? flags.brief;
    if (!flags.goal || !flags.done) die(tl(lang(), 'project new --goal <文本或文件> --done <文本或文件> (--source <仓库路径或 URL> | --empty) [--plan <规划文本或文件>] [--base <ref>] [--title <标题>] [--visibility all|members]'));
    let r;
    if (flags.parallel && planFlag === undefined) die(tl(lang(), '并行开发要配合一份已写好的规划（--plan）'));
    // 建的时候就定可见性：建好再改，这之间全员看得到标题与目标
    if (flags.visibility !== undefined && !VISIBILITIES[flags.visibility]) die(tl(lang(), '可见性只能是：{values}', { values: Object.keys(VISIBILITIES).join(' / ') }));
    try {
      if (!flags.empty) checkRepoSource(flags.source === true ? '' : flags.source, { required: true });
      r = startProject(db, { userId, goal: textOrFile(flags.goal), doneDefinition: textOrFile(flags.done), plan: planFlag === undefined ? null : textOrFile(planFlag),
        source: flags.empty ? null : flags.source, empty: !!flags.empty, base: flags.base ?? null, title: flags.title === true ? null : flags.title ?? null, home: HOME });
      if (flags.parallel) setParallel(db, { projectId: r.projectId, on: true, userId });
      if (flags.visibility === 'members') setVisibility(db, { projectId: r.projectId, visibility: 'members', by: userId });
    } catch (e) { die(translateError(e, lang())); }
    console.log(tl(lang(), '项目 {id}\n  仓库 {repo}\n  分支 {branch} @ {base}', { id: r.projectId, repo: r.repo, branch: r.branch, base: r.baseRef.slice(0, 8) }));
    if (r.planned) console.log(tl(lang(), '  方案待起草（载体任务 {carrier}）。守护进程会拉规划器；没开守护进程：node src/cli.mjs project plan {id}', { carrier: r.carrierId, id: r.projectId }));
    else console.log(tl(lang(), '  第一个任务 {taskId}（从项目目标起草，会先问你几个问题）。守护进程会自动追问；没开守护进程：node src/cli.mjs draft {taskId}', { taskId: r.firstTaskId }));
    return;
  }
  if (sub === 'plan') {
    const projectId = args[0] ?? die(tl(lang(), '要给项目 id'));
    const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId) ?? die(tl(lang(), '没有这个项目：{id}', { id: projectId }));
    const carrier = carrierTask(db, projectId) ?? die(tl(lang(), '这个项目不是从规划开始的，没有可规划的东西'));
    const client = new LlmClient({ mode: flags.mode ?? 'live', cassette: flags.cassette, ...clientOpts(db, flags), ...fakeOpt(flags) });
    console.log(tl(lang(), '项目规划中（档位 {tier}）… {id}「{title}」草案 v{version}', { tier: flags.tier ?? 'heavy', id: projectId, title: p.title, version: String(p.draft_version) }));
    let r;
    try {
      r = await planProject(db, { client, projectId, tier: flags.tier ?? 'heavy' });
    } finally {
      const { rows, microUsd } = flushLedger(db, client, { taskId: carrier.id, role: 'project_planner' });
      if (rows) console.log(tl(lang(), '记账 {rows} 次调用，{usd}（记在载体任务 {carrier}）', { rows, usd: fmtUsd(microUsd), carrier: carrier.id }));
    }
    // 渲染在 project-planner.mjs 里（被测），不在这里 —— 这几行曾经是那些返回形状的唯一读者，
    // 于是同一个坑踩了两次。
    for (const line of renderPlanOutcome(r, { projectId })) console.log(line);
    return;
  }
  if (sub === 'new') {
    if (!flags.file) die(tl(lang(), '要给 --file <项目.json>（整批契约）或 --brief <规划文本或文件>（让规划器切）'));
    const spec = JSON.parse(readFileSync(flags.file, 'utf8'));
    let r;
    try { r = createProject(db, { userId, spec, source: flags.source, home: HOME, base: flags.base ?? null }); } catch (e) { die(translateError(e, lang())); }
    console.log(tl(lang(), '项目 {id}  {title}\n  仓库 {repo}\n  分支 {branch} @ {base}', { id: r.projectId, title: spec.title, repo: r.repo, branch: r.branch, base: r.baseRef.slice(0, 8) }));
    r.taskIds.forEach((t, i) => console.log(`  ${i + 1}. ${t}  ${spec.tasks[i].title}`));
    console.log(tl(lang(), '\n第一个任务的工作区已建；守护进程会拉 plan → run。任务 done 后你签收（signoff --accept），守护进程自动合进项目分支并开下一个。'));
    console.log(tl(lang(), '看进度：node src/cli.mjs project show {id}', { id: r.projectId }));
    return;
  }
  const projectId = args[0] ?? die(tl(lang(), '要给项目 id'));
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId) ?? die(tl(lang(), '没有这个项目：{id}', { id: projectId }));
  if (sub === 'show') {
    console.log(tl(lang(), '项目 {id}  {title}  [{status}]\n  仓库 {repo}\n  分支 {branch}（起点 {base}）', { id: p.id, title: p.title, status: p.status, repo: p.repo, branch: p.branch, base: p.base_ref.slice(0, 8) }));
    if (p.status === 'proposed') console.log(tl(lang(), '  草案 v{version}', { version: String(p.draft_version) }) + (p.draft_question ? tl(lang(), '，批准问题 {qid}（answer <qid> "A" / 反馈 / "C"）', { qid: p.draft_question }) : tl(lang(), '，等规划器')));
    for (const t of projectTasks(db, projectId)) {
      const mark = t.merged_at ? tl(lang(), '✅ 已合并') : t.status === 'done' ? (t.signoff === 'accepted' ? tl(lang(), '⏳ 待合并') : tl(lang(), '✋ 待签收')) : t.status;
      console.log(`  ${t.project_order}. ${mark.padEnd(8)} ${t.id}  ${t.title}${t.dependsOn?.length ? tl(lang(), '  ← 依赖 {deps}', { deps: t.dependsOn.map((n) => `#${n}`).join(' ') }) : ''}`);
    }
    return;
  }
  // 给项目添加任务（负责人，或被授予"可添加任务"的项目成员）。只记下要加什么；规划器（守护进程拉，或手动 project plan）切契约，人批准一次。
  if (sub === 'append') {
    const id = args[0] ?? die(tl(lang(), 'project append <项目 id> --brief <文本或文件>'));
    if (!flags.brief || flags.brief === true) die(tl(lang(), '要给 --brief <文本或文件>：接下来要加什么'));
    const brief = existsSync(String(flags.brief)) ? readFileSync(String(flags.brief), 'utf8') : String(flags.brief);
    try {
      {
        const r = requestAppend(db, { projectId: id, userId, brief });
        console.log(r.queued
          ? (r.behind === 'review' ? tl(lang(), '已排队（第 {n} 位）：现在有一轮复盘在进行，它结束后这条单独起草、单独批准。', { n: r.position })
            : tl(lang(), '已排队（第 {n} 位）：现在有一轮追加在进行，它结束后这条单独起草、单独批准。', { n: r.position }))
          : tl(lang(), '已记下要追加的内容（载体任务 {carrier}）。守护进程会拉规划器出追加草案，批准前不会新建任何任务；没开守护进程：node src/cli.mjs project plan {id}', { carrier: r.carrierId, id }));
        // 新任务描述对着项目的有效决定清单过一遍。挂在载体任务上 —— 批准事项也在那儿。
        await reportDecisionHits(db, { taskId: r.carrierId, text: brief, entry: 'task', by: userId, flags });
      }
    } catch (e) { die(translateError(e, lang())); }
    return;
  }
  // 后置签收：自动挡下 AI 自己加的任务攒着的签收，一次点掉。
  if (sub === 'signoff') {
    const id = args[0] ?? die(tl(lang(), 'project signoff <项目 id> [--accept-all]'));
    const pj = db.one(`SELECT id, title, owner_id FROM projects WHERE id=?`, id) ?? die(tl(lang(), '没有这个项目：{id}', { id }));
    const pending = deferredSignoffs(db, id);
    if (!pending.length) { console.log(tl(lang(), '项目「{title}」没有被后置的签收。', { title: pj.title })); return; }
    if (!flags['accept-all']) {
      console.log(tl(lang(), '项目「{title}」有 {n} 个任务的签收被后置了（自动挡下 AI 自己加的，验收过了就合并）：', { title: pj.title, n: pending.length }));
      for (const t of pending) console.log(`  #${t.project_order} ${t.id}  ${t.title}${t.merged_at ? tl(lang(), '  已合并') : ''}`);
      console.log(tl(lang(), '  逐个看：node src/cli.mjs show <taskId>｜一次签掉：project signoff {id} --accept-all', { id }));
      return;
    }
    if (userId !== pj.owner_id) die(tl(lang(), '只有该项目的负责人能批量签收'));
    try { const r = acceptDeferredSignoffs(db, { projectId: id, userId }); console.log(tl(lang(), '已一次签收 {n} 个任务。', { n: r.accepted })); } catch (e) { die(translateError(e, lang())); }
    return;
  }
  // 入站：GitHub issue 入口、定时任务。改只有负责人（core 里查）
  if (sub === 'issues' || sub === 'schedule') {
    const id = args[0] ?? die(tl(lang(), 'project {sub} <项目 id>', { sub }));
    const pj = db.one(`SELECT id, title, owner_id FROM projects WHERE id=?`, id) ?? die(tl(lang(), '没有这个项目：{id}', { id }));
    const ib = await import('./core/inbound.mjs');
    const { describeCron } = await import('./core/cron.mjs');
    try {
      if (sub === 'issues') {
        if (flags.off) { ib.setIssueInbound(db, { projectId: id, userId, on: false }); console.log(tl(lang(), '已停用 issue 入口：排着还没起草的也不再起草')); return; }
        if (flags.repo !== undefined || flags.label !== undefined) {
          const c = ib.setIssueInbound(db, { projectId: id, userId, repo: flags.repo, label: flags.label, on: true });
          console.log(tl(lang(), '已打开：{repo} 上带「{label}」标签、开着的 issue，每条起草一轮添加任务（一律要负责人批）。守护进程每 5 分钟看一次。', { repo: c.repo, label: c.label }));
          const r = await ib.makeIssueWatcher(db, { env: process.env }).pollNow(id);
          if (r?.error) console.log(tl(lang(), '  ⚠ 刚看了一次：{msg}', { msg: tl(lang(), r.error.msg, r.error.params ?? {}) }));
          else if (r) console.log(tl(lang(), '  刚看了一次：开着、带这个标签的 {n} 条，这次起草 / 排队了 {k} 条', { n: r.open ?? 0, k: r.drafted?.length ?? 0 }));
          return;
        }
        const v = ib.inboundView(db, id);
        if (!v.issues?.on) { console.log(tl(lang(), '项目「{title}」的 issue 入口：没开。打开：--repo <owner/repo> --label <标签>', { title: pj.title })); return; }
        console.log(tl(lang(), '项目「{title}」的 issue 入口：{repo} 上带「{label}」标签的（{who}开的）', { title: pj.title, repo: v.issues.repo, label: v.issues.label, who: v.issues.byName ?? '' }));
        if (v.state?.error) console.log(tl(lang(), '  ⚠ {msg}', { msg: tl(lang(), v.state.error.msg, v.state.error.params ?? {}) }));
        else if (v.state) console.log(tl(lang(), '  {t} 看过：开着、带这个标签的 {n} 条；在起草或排队的 {k} / {max} 条', { t: when(db, v.state.at), n: v.state.open ?? 0, k: v.inFlight, max: v.batch }));
        for (const x of v.seen.slice(0, 10)) console.log(`  #${x.number} ${x.title ?? ''}  ${x.skipped ? tl(lang(), '没起草：{why}', { why: x.skipped }) : x.dropped ? tl(lang(), '排着的时候关了或摘了标签') : x.queued ? tl(lang(), '排着') : tl(lang(), '起草了')}`);
        return;
      }
      const [op, sid] = [args[1] ?? null, args[2] ?? null];
      if (op === 'add') {
        const s = ib.setSchedule(db, { projectId: id, userId, name: flags.name, cron: flags.cron, brief: flags.brief });
        const next = ib.scheduleView(db, id).find((x) => x.id === s.id)?.next;
        console.log(tl(lang(), '已加上定时任务「{name}」（{when}）：{id}；下一次 {next}', { name: s.name, when: describeCron(s.cron, lang()), id: s.id, next: next ? when(db, next) : '—' }));
        return;
      }
      if (op === 'on' || op === 'off') { ib.setSchedule(db, { projectId: id, userId, id: sid ?? die(tl(lang(), 'project schedule {id} {op} <定时任务 id>', { id, op })), on: op === 'on' }); console.log(op === 'on' ? tl(lang(), '已启用：从现在起算下一次') : tl(lang(), '已停用：排着还没起草的也不再起草')); return; }
      if (op === 'rm') { ib.removeSchedule(db, { projectId: id, userId, id: sid ?? die(tl(lang(), 'project schedule {id} rm <定时任务 id>', { id })) }); console.log(tl(lang(), '已删除')); return; }
      if (op) die(tl(lang(), '不认识的子命令：{op}（add / on / off / rm）', { op }));
      const list = ib.scheduleView(db, id);
      if (!list.length) { console.log(tl(lang(), '项目「{title}」没有定时任务。加一个：project schedule {id} add --name <名> --cron "0 9 * * 1" --brief "<要做什么>"', { title: pj.title, id })); return; }
      for (const s of list) {
        console.log(`${s.id}  ${s.name}  ${describeCron(s.cron, lang())}${s.on ? '' : tl(lang(), '（停用）')}`);
        console.log(tl(lang(), '  下一次：{next}｜上一次：{last}', { next: s.next ? when(db, s.next) : '—', last: s.last ? `${when(db, s.last.last)} ${s.last.result}${s.last.why ? ` — ${s.last.why}` : ''}` : '—' }));
      }
    } catch (e) { die(translateError(e, lang())); }
    return;
  }
  // 项目设置：预算闸 / 项目级验收命令 / 自动化挡位 / 项目默认上限。四个都是负责人的旋钮。
  if (['budget', 'verify', 'gear', 'limits', 'concurrency', 'sandbox', 'egress', 'setup'].includes(sub)) {
    const id = args[0] ?? die(tl(lang(), 'project {sub} <项目 id>', { sub }));
    const pj = db.one(`SELECT id, title, owner_id FROM projects WHERE id=?`, id) ?? die(tl(lang(), '没有这个项目：{id}', { id }));
    const lead = () => { if (userId !== pj.owner_id) die(tl(lang(), '只有该项目的负责人能改项目设置')); };
    try {
      if (sub === 'budget') {
        if (flags.usd === undefined && !flags.clear) {
          const b = budgetState(db, id);
          console.log(tl(lang(), '项目「{title}」的预算闸：{human}', { title: pj.title, human: dyn(b.human) }) + (b.gate === null ? '' : tl(lang(), '｜剩余 {left}', { left: fmtBudget(b.remaining) }) + (b.over ? tl(lang(), '　⚠ 已撞闸') : '')));
          console.log(tl(lang(), '  改：--usd <美元> ｜ 撤掉：--clear'));
          return;
        }
        lead();
        const micro = flags.clear ? null : Math.round(Number(flags.usd) * 1e6);
        setProjectBudget(db, { projectId: id, microUsd: micro, userId });
        console.log(micro === null ? tl(lang(), '预算闸已撤掉（自动挡会随之掉回提议挡）') : tl(lang(), '预算闸已设为 {usd}；{human}', { usd: fmtBudget(micro), human: dyn(budgetState(db, id).human) }));
      } else if (sub === 'verify') {
        if (flags.cmd === undefined && !flags.clear) {
          const v = projectVerifyCommand(db, id);
          console.log(tl(lang(), '项目「{title}」的验收命令：{cmd}', { title: pj.title, cmd: v ? v.join(' ') : tl(lang(), '（没填 —— "项目达成"只能由人宣布）') }));
          console.log(tl(lang(), '  改：--cmd "<一条命令>" ｜ 清空：--clear'));
          return;
        }
        lead();
        setProjectVerify(db, { projectId: id, command: flags.clear ? '' : String(flags.cmd), userId });
        const v = projectVerifyCommand(db, id);
        console.log(v ? tl(lang(), '项目级验收命令已设为：{cmd}', { cmd: v.join(' ') }) : tl(lang(), '项目级验收命令已清空（自动挡会随之掉回提议挡）'));
      } else if (sub === 'gear') {
        const target = args[1] ?? null;
        if (!target) {
          const g = gearOf(db, id);
          console.log(tl(lang(), '项目「{title}」的挡位：{label}\n  {blurb}', { title: pj.title, label: dyn(GEARS[g].label), blurb: dyn(GEARS[g].blurb) }));
          console.log(tl(lang(), '  四条前提：'));
          for (const p2 of gearPrereqStatus(db, id)) console.log(`    ${p2.ok ? '✅' : '❌'} ${tl(lang(), '{label}（{note}）—— {why}', { label: dyn(p2.label), note: dyn(p2.note), why: dyn(p2.why) })}`);
          console.log(tl(lang(), '  改：project gear {id} {gears}', { id, gears: Object.keys(GEARS).join('|') }));
          return;
        }
        lead();
        setGear(db, { projectId: id, gear: target, userId });
        console.log(tl(lang(), '挡位已设为：{label}', { label: dyn(GEARS[target].label) }));
      } else if (sub === 'setup') {
        const cmds = list(flags.cmd).filter((x) => typeof x === 'string');
        if (cmds.length || flags.clear) { lead(); setSetupCommands(db, { projectId: id, commands: flags.clear ? [] : cmds, userId }); }
        const cur = setupCommandsOf(db, id);
        if (cur.length) {
          console.log(tl(lang(), '项目「{title}」的环境准备命令（负责人填的；新工作区第一次开跑前、项目级验收之前自动跑）：', { title: pj.title }));
          cur.forEach((a, i) => console.log(`  ${i + 1}. ${a.join(' ')}`));
        } else {
          const auto = detectSetupCommands(pj.repo).argvs;
          console.log(tl(lang(), '项目「{title}」的环境准备：自动（按仓库里的依赖清单）。', { title: pj.title }) + (auto.length ? tl(lang(), '按现在的清单会跑：') : tl(lang(), '仓库里还没有依赖清单，暂时没有要装的。')));
          auto.forEach((a, i) => console.log(`  ${i + 1}. ${a.join(' ')}`));
        }
        console.log(tl(lang(), '  改：project setup {id} --cmd "python -m venv .venv" --cmd ".venv/bin/pip install -r requirements.txt"　清空：--clear', { id }));
      } else if (sub === 'egress') {
        const add = list(flags.add).filter((x) => typeof x === 'string'), rm = list(flags.remove).filter((x) => typeof x === 'string');
        if (add.length || rm.length) {
          lead();
          const cur = new Set(projectEgressOf(db, id)); add.forEach((x) => cur.add(x)); rm.forEach((x) => cur.delete(x));
          setProjectEgress(db, { projectId: id, sources: [...cur], userId });
        }
        const ids = projectEgressOf(db, id);
        console.log(tl(lang(), '项目「{title}」的联网（项目下所有任务共用）：', { title: pj.title }) + (ids.length ? '' : tl(lang(), '（空）—— 完全断网')));
        for (const x of ids) { const so = sourceOf(db, x); console.log(tl(lang(), '  {id}　{name}（{kind}{ro}）：{hosts}', { id: x, name: so.name, kind: dyn(so.kindName), ro: so.readOnly ? tl(lang(), '，只读') : '', hosts: so.hosts.join(', ') })); }
        console.log(tl(lang(), '  可选：{ids}　改：project egress {id} --add <源> --remove <源>', { ids: egressSources(db).map((so) => so.id).join(' / '), id }));
      } else if (sub === 'sandbox') {
        const target = args[1] ?? null;
        if (!target) {
          const f = sandboxFlavorOf(db, id);
          console.log(tl(lang(), '项目「{title}」的沙箱：{flavor}', { title: pj.title, flavor: dyn(SANDBOX_FLAVORS[f]) }));
          console.log(tl(lang(), '  改：project sandbox {id} {flavors}（下一次开工 / 跑验收时生效，已开着的容器不变）', { id, flavors: Object.keys(SANDBOX_FLAVORS).join('|') }));
          return;
        }
        lead();
        setSandboxFlavor(db, { projectId: id, flavor: target, userId });
        console.log(tl(lang(), '沙箱已设为：{flavor}（下一次开工 / 跑验收时生效）', { flavor: dyn(SANDBOX_FLAVORS[target]) }));
      } else if (sub === 'concurrency') {
        if (flags.max === undefined) {
          const n = maxOpenOf(db, id);
          console.log(tl(lang(), '项目「{title}」同时最多开 {n} 个任务', { title: pj.title, n }) + (n === 1 ? tl(lang(), '（串行）') : tl(lang(), '：只有开着的任务全都在等人时，才会让独立的下一个先跑起来')));
          console.log(tl(lang(), '  改：project concurrency {id} --max <1-4>', { id }));
          return;
        }
        lead();
        setMaxOpen(db, { projectId: id, n: Number(flags.max), userId });
        console.log(tl(lang(), '同时最多开 {n} 个任务', { n: maxOpenOf(db, id) }));
      } else {
        const key = flags.key ? (String(flags.key).startsWith('limit.') ? String(flags.key) : `limit.${flags.key}`) : null;
        if (!key) {
          console.log(tl(lang(), '项目「{title}」的默认上限（本项目新任务用；任务自己设过的压过它）：', { title: pj.title }));
          for (const r of projectLimits(db, id, lang())) console.log(`  ${r.key.replace('limit.', '').padEnd(26)} ${r.valueText.padEnd(14)} ${dyn(LAYER_NAMES[r.source])}${r.source === 'project' ? tl(lang(), '（部署默认 {v}）', { v: r.deployText }) : ''}`);
          console.log(tl(lang(), '  改：project limits {id} --key <项> --value <数> ｜ 清掉这一层：--key <项> --clear', { id }));
          return;
        }
        lead();
        setProjectLimit(db, { projectId: id, key, value: flags.clear ? null : Number(flags.value), userId });
        const r = projectLimits(db, id, lang()).find((x) => x.key === key);
        console.log(tl(lang(), '{label}：{value}（{layer}）', { label: dyn(r.label), value: r.valueText, layer: dyn(LAYER_NAMES[r.source]) }));
      }
    } catch (e) { die(translateError(e, lang())); }
    return;
  }
  // 项目权限：成员（可见 + 可选"能加任务" + 职能说明）、可见性、目标 / 完成定义。谁答哪类问题仍在 routing。
  if (sub === 'members' || sub === 'member' || sub === 'visibility' || sub === 'goal') {
    const id = args[0] ?? die(tl(lang(), '要给项目 id'));
    try {
      if (sub === 'members') {
        const p = db.one(`SELECT title, owner_id, visibility FROM projects WHERE id=?`, id) ?? die(tl(lang(), '没有这个项目：{id}', { id }));
        console.log(tl(lang(), '项目「{title}」 可见性：{v}\n  负责人 {owner}', { title: p.title, v: dyn(VISIBILITIES[p.visibility] ?? p.visibility), owner: p.owner_id }));
        for (const m of listMembers(db, id)) console.log(`  ${m.userId}  ${m.name}${m.canAddTasks ? tl(lang(), '  [可添加任务]') : ''}${m.disabled ? tl(lang(), '  [已停用]') : ''}${m.note ? `  —— ${m.note}` : ''}`);
      } else if (sub === 'member') {
        const target = args[1] ?? die(tl(lang(), 'project member <项目 id> <用户 id> [--add-tasks] [--note <职能说明>] | --remove'));
        const r = flags.remove ? removeMember(db, { projectId: id, userId: target, by: userId })
          : setMember(db, { projectId: id, userId: target, canAddTasks: !!flags['add-tasks'], note: flags.note === true ? '' : flags.note ?? '', by: userId });
        console.log(r.removed ? tl(lang(), '已移出项目成员：{id}', { id: target })
          : (r.created ? tl(lang(), '已加入项目成员：{id}', { id: target }) : tl(lang(), '已更新项目成员：{id}', { id: target })) + `${r.canAddTasks ? tl(lang(), '（可添加任务）') : ''}${r.note ? ` —— ${r.note}` : ''}`);
      } else if (sub === 'visibility') {
        const r = setVisibility(db, { projectId: id, visibility: args[1] ?? die(tl(lang(), 'project visibility <项目 id> {opts}', { opts: Object.keys(VISIBILITIES).join('|') })), by: userId });
        console.log(r.changed ? tl(lang(), '可见性已改为：{v}', { v: dyn(VISIBILITIES[r.visibility]) }) : tl(lang(), '可见性没有变化'));
      } else {
        if (flags.goal === undefined && flags.done === undefined) die(tl(lang(), 'project goal <项目 id> [--goal <文本或文件>] [--done <文本或文件>]'));
        const r = editProjectGoal(db, { projectId: id, goal: flags.goal === undefined ? null : textOrFile(flags.goal), doneDefinition: flags.done === undefined ? null : textOrFile(flags.done), by: userId });
        console.log(r.changed ? tl(lang(), '项目目标 / 完成定义已更新（任务的契约不受影响）') : tl(lang(), '没有变化'));
      }
    } catch (e) { die(translateError(e, lang())); }
    return;
  }
  // 复盘时选了「先放着」而停滞的项目：负责人让它重新复盘（结果照常进收件箱）
  if (sub === 'review') {
    const projectId = args[0] ?? die(tl(lang(), 'project review <项目 id>'));
    try { const r = reviewAgain(db, { projectId, userId }); console.log(tl(lang(), '已开始重新复盘（载体任务 {carrier}）：已经达成就请你确认，还差东西就提任务，结果进收件箱', { carrier: r.carrierId })); }
    catch (e) { die(translateError(e, lang())); }
    return;
  }
  // 生命周期：停滞的三个出口（reopen 恢复当前任务 / redo 重做 / abort 中止项目）、改标题、归档。权限与规则在 lifecycle.mjs。
  if (['reopen', 'redo', 'abort', 'rename', 'archive'].includes(sub)) {
    const projectId = args[0] ?? die(tl(lang(), 'project {sub} <项目 id>', { sub }));
    const { plaintext } = cliIdentity(db, flags);
    try {
      if (sub === 'reopen') {
        const cur = db.one(`SELECT id FROM tasks WHERE project_id=? AND project_order>0 AND merged_at IS NULL ORDER BY project_order LIMIT 1`, projectId) ?? die(tl(lang(), '项目没有未合并的任务'));
        const r = reopenTask(db, { taskId: cur.id, userId });
        console.log(tl(lang(), '已恢复任务 {id}（→ {to}）', { id: cur.id, to: r.to }) + (r.projectResumed ? tl(lang(), '，项目回到进行中') : '') + tl(lang(), '。想改契约：node src/cli.mjs say {id} "<要改什么>" --kind correction', { id: cur.id }));
      } else if (sub === 'redo') {
        const r = redoProjectTask(db, { projectId, userId, taskId: flags.task === true ? null : flags.task ?? null, note: flags.note === true ? null : flags.note ?? null, plaintextToken: plaintext });
        console.log(tl(lang(), '已重做第 {order} 个任务：新任务 {newId}（同一份契约），旧任务 {oldId} 退出链，其工作区与分支保留。守护进程会从项目分支建新工作区；没开守护进程：node src/cli.mjs project advance {pid}', { order: r.order, newId: r.newTaskId, oldId: r.oldTaskId, pid: projectId }));
      } else if (sub === 'abort') {
        const r = abortProject(db, { projectId, userId, why: flags.why === true ? null : flags.why ?? null });
        console.log(tl(lang(), '项目已中止：中止任务 {n} 个，撤回待决事项 {q} 条。', { n: r.tasksAborted.length, q: r.questionsWithdrawn })
          + (r.merged ? tl(lang(), '已合并的 {n} 个任务仍可交付：node src/cli.mjs project deliver {pid} --remote <url>', { n: r.merged, pid: projectId }) : tl(lang(), '没有已合并的任务')));
      } else if (sub === 'rename') {
        const r = renameProject(db, { projectId, title: args.slice(1).join(' '), userId });
        console.log(r.changed ? tl(lang(), '项目标题已改为 {title}', { title: r.title }) : tl(lang(), '标题没变'));
      } else {
        const r = setProjectArchived(db, { projectId, archived: !flags.undo, userId });
        console.log(r.changed ? (r.archived ? tl(lang(), '已归档（连同其任务从列表隐藏；状态不变）') : tl(lang(), '已取消归档')) : tl(lang(), '没有变化'));
      }
    } catch (e) { die(translateError(e, lang())); }
    return;
  }
  if (sub === 'advance') {
    const r = await advanceProject(db, { projectId, home: HOME, userId }).catch((e) => die(translateError(e, lang())));
    const tid = r.taskId ? tl(lang(), '（{name}）', { name: r.taskId }) : '';
    console.log(r.advanced ? tl(lang(), '推进：{reason}', { reason: dyn(r.reason) }) + tid + (r.nextTaskId ? tl(lang(), ' → 下一个 {id} 工作区已建', { id: r.nextTaskId }) : '') + (r.done ? tl(lang(), '；项目 done') : '')
      : tl(lang(), '没动：{reason}', { reason: dyn(r.reason) }) + tid);
    return;
  }
  if (sub === 'deliver') {
    // 推之前先把一手证据印出来。命令行没法弹确认框，但**印在滚屏上**至少让"没跑过验收"
    // 和"验收跑的是另一份代码"当场可见，而不是事后在 PR 里发现。看板那边是同一份数据。
    const ev = deliveryEvidence(db, { projectId });
    if (ev) {
      if (ev.stat) console.log(tl(lang(), '要推的范围：{range}  {n} 个提交，头 {head}', { range: ev.stat.range, n: ev.stat.commits, head: ev.stat.head.slice(0, 8) }) + `\n${ev.stat.diffstat || tl(lang(), '（没有差异）')}`);
      else console.log(tl(lang(), '⚠ 读不到项目仓库（路径不在、不是 git 仓库、或者权限不够），说不出这次要推什么'));
      if (!ev.command) console.log(tl(lang(), '⚠ 没有填项目级验收命令 —— "达成"完全是人宣布的，一条机械核实都没有'));
      else if (!ev.verify) console.log(tl(lang(), '⚠ 验收命令 {cmd} 一次都没跑过', { cmd: ev.command.join(' ') }));
      else {
        console.log(tl(lang(), '验收 {cmd}：{result}', { cmd: (ev.verify.argv ?? ev.command).join(' '), result: ev.verify.ok ? tl(lang(), '通过') : tl(lang(), '没过（退出码 {code}）', { code: ev.verify.code ?? tl(lang(), '没跑起来') }) })
          + `  ${when(db, ev.verify.at, { seconds: true })}`);
        console.log(ev.verify.ranAtHead ? tl(lang(), '  跑的就是要推的这一份（{head}）', { head: String(ev.verify.head ?? '').slice(0, 8) })
          : tl(lang(), '⚠ 那次跑的是 {ran}，和现在要推的 {head} 不是同一份代码 —— 这个"通过"对这次没有效力', { ran: String(ev.verify.head ?? tl(lang(), '未知')).slice(0, 8), head: String(ev.stat?.head ?? tl(lang(), '未知')).slice(0, 8) }));
        if (ev.verify.tail) console.log(tl(lang(), '  输出尾部：') + `\n${String(ev.verify.tail).split('\n').slice(-12).map((l) => `    ${l}`).join('\n')}`);
      }
      console.log('');
    }
    const r = await deliverProject(db, { projectId, remote: flags.remote ?? null, pr: !!flags.pr, base: flags.base ?? null, userId, tokenId,
      acceptDeferred: !!flags['accept-pending'], home: HOME, hookAck: hookAcks(flags) }).catch((e) => die(hookAskText(e)));
    console.log(tl(lang(), '已 push：{remote}  {branch} @ {head}', { remote: r.remote, branch: r.branch, head: r.head.slice(0, 8) }));
    if (r.pr) console.log(tl(lang(), 'PR：{url}（base {base}）', { url: r.pr.url, base: r.pr.base }));
    else if (r.prSkipped) console.log(tl(lang(), '未开 PR：{why}', { why: dyn(r.prSkipped) }));
    else console.log(tl(lang(), '未开 PR（没给 --pr）'));
    return;
  }
  die(tl(lang(), '不认识的子命令 {sub}：project new | show | advance | deliver', { sub }));
}

// 守护进程：答完题任务自己接着跑。每 --interval 秒扫一次超时链 + 拉起该接着跑的任务。
// 判断规则在 src/core/daemon.mjs 开头，一句话：状态 running、没在跑、上次退出后有人动过（或到点下班 / 厂商错误按退避重试）。
/** 状态库健康：`db stats` = 库文件 + 各进程最近一刻钟的等锁 / BUSY / 慢语句。 */
function cmdDb(db, sub, dbPath, args = [], flags = {}) {
  const mbOf = (b) => (b / 1048576).toFixed(1);
  if (sub === 'backup') {
    try { const b = backupNow(db, dbPath, { tag: flags.tag ? String(flags.tag) : 'manual', actorKind: 'user' }); console.log(tl(lang(), '已备份并核过：{file}（{mb} MB，版本 v{v}）', { file: b.file, mb: mbOf(b.bytes), v: b.version })); }
    catch (e) { die(translateError(e, lang())); }
    return;
  }
  if (sub === 'backups') {
    const list = listBackups(dbPath);
    if (!list.length) { console.log(tl(lang(), '还没有备份')); return; }
    for (const b of list) console.log(`  ${when(db, b.mtime, { seconds: true })}  ${b.tag.padEnd(16)} ${b.file}`);
    return;
  }
  if (sub === 'check') {
    const r = checkDb(db, { full: !!flags.full });
    console.log(r.ok ? tl(lang(), '{kind} 检查通过；外键无违例', { kind: r.kind }) : tl(lang(), '{kind} 检查发现问题：{problems}；外键违例 {fk} 条', { kind: r.kind, problems: r.problems.slice(0, 5).join(' / ') || '—', fk: r.fk.length }));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'restore') {
    const file = args[0] ?? die(tl(lang(), 'db restore <备份文件> [--force]'));
    // 还有谁在写这个库：活着的租约（编排器 / 项目推进）或守护进程心跳。看板进程没有可查的标记 —— 文档里写明恢复前先停看板。
    const busy = () => {
      const l = db.one(`SELECT resource, pid FROM leases WHERE expires_at > ? LIMIT 1`, Date.now());
      if (l) return `${l.resource}（pid ${l.pid}）`;
      return daemonStatus(HOME).alive ? tl(lang(), '守护进程') : null;
    };
    const who = busy();
    db.close();
    try {
      const r = restoreFile(dbPath, file, { busy: () => who, force: !!flags.force });
      const d2 = openDb(dbPath);   // 用当前代码打开：备份来自旧版本时顺带升级
      const v = d2.raw.prepare('PRAGMA user_version').get().user_version;
      audit(d2, { actorKind: 'user', action: 'db_restored', targetType: 'deployment', targetId: 'db', payload: { from: file, savedCurrentAs: r.savedCurrentAs, backupVersion: r.version, nowVersion: v } });
      d2.close();
      console.log(tl(lang(), '已从 {file} 恢复（备份是 v{from}，现在 v{to}）；恢复前的库另存为 {saved}', { file, from: r.version, to: v, saved: r.savedCurrentAs ?? '—' }));
    } catch (e) { die(translateError(e, lang())); }
    process.exit(0);
  }
  if (sub !== 'stats') die(tl(lang(), 'db 子命令：stats | backup [--tag] | backups | check [--full] | restore <备份文件> [--force]'));
  const h = dbHealth(db, dbPath);
  const mb = (b) => (b / 1048576).toFixed(1);
  console.log(tl(lang(), '库文件：{db} MB（{pages} 页 × {size} 字节，空闲 {free} 页）；WAL：{wal} MB', { db: mb(h.file.dbBytes), pages: h.file.pageCount, size: h.file.pageSize, free: h.file.freelist, wal: mb(h.file.walBytes) }));
  const p = h.processes;
  console.log(tl(lang(), '最近一刻钟有观测的进程：{n} 个；写事务 {tx} 次，拿锁平均 {avg} ms、最长 {max} ms；撞 BUSY {busy} 次', {
    n: p.procs.length, tx: p.lock.n, avg: p.lock.n ? (p.lock.totalMs / p.lock.n).toFixed(1) : '0', max: p.lock.maxMs, busy: p.busy }));
  for (const x of p.procs) console.log(`  ${x.proc.padEnd(14)} pid ${String(x.pid).padEnd(7)} tx ${String(x.txCount).padEnd(6)} lock-max ${x.lock.maxMs} ms  busy ${x.busy}`);
  if (p.slow.length) { console.log(tl(lang(), '慢语句（≥100 ms，最近的）：')); for (const s of p.slow) console.log(`  ${String(s.ms).padStart(6)} ms  ${s.proc}  ${s.sql.slice(0, 110)}`); }
}

/** 常驻进程启动时的运行环境自检：只提示，不拦（SQLite 版本见 core/sqlite-check.mjs）。 */
function warnRuntime(db) {
  const a = sqliteAdvice(db);
  if (a) console.log(tl(lang(), '  ⚠ Node {node} 自带的 SQLite {version} 有一个已知缺陷：多个进程同时写同一个库时，有极小概率把库写坏。建议把 Node 升级到自带 SQLite {fixed} 或更新版本的发行版', { node: a.node, version: a.version, fixed: a.fixedIn }));
}

async function cmdDaemon(db, flags) {
  cliIdentity(db, flags);   // 令牌得有效 —— 守护进程起的 run 与人起的走同一条路
  await bindForLongRunner(db, flags, 'daemon');
  const launcher = makeLauncher(db, { home: HOME });
  warnRuntime(db);
  const d = await runDaemon(db, flags, launcher);
  guardLongRunner(db, () => d.stop());
  await new Promise(() => {});
}

async function runDaemon(db, flags, launcher) {
  if (flags['digest-every']) console.log(tl(lang(), '提示：--digest-every 已不用，忽略。不紧急的新事项现在按人攒成「汇总推送」（间隔见部署设置 deploy.digest_every_min，各人可在看板「我的通知」里改）；全量待办清单看看板收件箱或 `digest` 命令。'));
  const intervalMs = Math.max(5, Number(flags.interval ?? 15)) * 1000;
  const channels = channelsFromEnv(process.env, flags.notify);
  const d = startDaemon(db, { home: HOME, dbPath, launcher, intervalMs, iterations: flags.iterations ? Number(flags.iterations) : null,
    notifyOpts: { env: process.env, extraCmd: flags.notify,
      catalogCheckEvery: flags['no-catalog-check'] ? null : String(flags['catalog-check'] ?? '7d') },   // 目录与在用的键：守护进程每轮从库读（checkableCatalog）
    onEvent: (e) => {
      const stamp = new Date().toISOString().slice(11, 19);
      if (e.type === 'sweep') printSweepEvent(db, e.event);
      else if (e.type === 'notified') console.log(`${stamp} ${tl(lang(), '✉ 事项 {qid} 已通知 {n} 人（{ok}/{all} 条送达）', { qid: e.questionId, n: e.to.length, ok: e.receipts.filter((r) => r.ok).length, all: e.receipts.length })}`);
      else if (e.type === 'notify_failed') console.log(`${stamp} ${tl(lang(), '✗ 通知失败：{err}', { err: e.error })}`);
      else if (e.type === 'catalog') console.log(`${stamp} ${e.warnings ? '⚠' : '✓'} ${tl(lang(), '模型目录检查（{why}）：', { why: { never: tl(lang(), '首次'), new_key: tl(lang(), '绑定里有没查过的模型'), interval: tl(lang(), '到间隔') }[e.why] ?? e.why })}${e.warnings ? tl(lang(), '{n} 项要看一眼', { n: e.warnings }) + (e.sent ? tl(lang(), '，已通知管理员') : '') : tl(lang(), '无漂移')}${e.fetchErrors ? tl(lang(), '；{n} 处拉取失败', { n: e.fetchErrors }) : ''}`);
      else if (e.type === 'handover') console.log(`${stamp} ${tl(lang(), '⇄ 换班（{key}）：{from} → {to}，', { key: e.projectId || tl(lang(), '默认表'), from: e.from, to: e.to })}${e.sent ? tl(lang(), '已推 {n} 项待办', { n: e.items }) : tl(lang(), '没有待办，未发')}`);
      else if (e.type === 'stall') console.log(`${stamp} ${tl(lang(), '⚠ 停等 {taskId}：静止 {min} 分钟，而系统说不出它在等谁（{why}）。已提事项 {qid} 给负责人', { taskId: e.taskId, min: e.idleMin, why: dyn(e.why), qid: e.questionId })}`);
      else if (e.type === 'livelock') console.log(`${stamp} ${tl(lang(), '⚠ 空转 {taskId}：{why}，期间没有新信息。已提事项 {qid} 给负责人', { taskId: e.taskId, why: dyn(e.why), qid: e.questionId })}`);
      else if (e.type === 'launched') console.log(`${stamp} ${tl(lang(), '▶ 拉起 {taskId}（{reason}）pid {pid} · 日志 {log}', { taskId: e.taskId, reason: dyn(e.reason), pid: e.pid, log: e.logFile })}`);
      else if (e.type === 'launch_failed') console.log(`${stamp} ${tl(lang(), '✗ 拉不起 {taskId}（{reason}）：{err}', { taskId: e.taskId, reason: dyn(e.reason), err: e.error })}`);
      else if (e.type === 'project') {
        console.log(`${stamp} ${tl(lang(), '⛓ 项目 {pid}：{reason}', { pid: e.projectId, reason: dyn(e.reason) })}${e.taskId ? ` ${e.taskId}` : ''}${e.nextTaskId ? tl(lang(), ' → 下一个 {id} 工作区已建', { id: e.nextTaskId }) : ''}${e.done ? tl(lang(), '；项目 done') : ''}`);
        // 项目达成的推送只有一个出口：守护进程的"等你交付"（信号 project.awaiting_delivery，推给负责人）
      } else if (e.type === 'project_error') console.log(`${stamp} ${tl(lang(), '✗ 项目 {pid} 推进失败（第 {n} 次，按退避等）：{err}', { pid: e.projectId, n: e.attempt, err: e.error })}`);
      else if (e.type === 'llm_health') for (const l of e.lines) console.log(`${stamp} ⚡ ${l}`);
      else if (e.type === 'invariants') for (const l of e.lines) console.log(`${stamp} ⚑ ${l}`);
      else if (e.type === 'tick_failed') console.log(`${stamp} ${tl(lang(), '✗ 守护进程这一轮出错（已记入审计，下一轮照常）：{err}', { err: e.error })}`);
    } });
  sayStartupNotes();
  console.log(tl(lang(), '守护进程 pid {pid}：每 {sec}s 扫一次；状态 running 且没在跑、且上次退出后有人动过的任务会被拉起', { pid: process.pid, sec: intervalMs / 1000 })
    + (channels.length ? tl(lang(), '；通知 {kinds}', { kinds: channels.map((c) => c.kind).join('/') }) : ''));
  const first = await d.tick();
  // 首轮把每个 running 任务的判断打出来：守护进程只按规则动手，人得看得见"它为什么没拉 / 为什么拉了"。
  const seen = new Set(first?.launched.map((x) => x.taskId) ?? []);
  for (const a of dueTasks(db, { isLive: launcher.running, hasWorkspace: (t) => existsSync(join(HOME, 'workspaces', t)) })) {
    if (seen.has(a.taskId)) continue;
    console.log(tl(lang(), '  {taskId}：{due}（{reason}）', { taskId: a.taskId, due: a.due ? tl(lang(), '该拉起') : tl(lang(), '不拉'), reason: dyn(a.reason) }));
  }
  if (first) console.log(tl(lang(), '  首轮：拉起 {n}', { n: first.launched.length }) + (first.skipped.length ? tl(lang(), '，退避中 {n}', { n: first.skipped.length }) : ''));
  return d;
}

function printSweepEvent(db, e) {
  if (e.type === 'question_defaulted') {
    console.log(tl(lang(), '⏱ {taskId} 超时走默认（{level} 级 {qid}）：{action}', { taskId: e.taskId, level: e.level === 1 ? 'Ⅰ' : 'Ⅱ', qid: e.questionId, action: String(e.defaultAction).slice(0, 120) }));
  } else if (e.type === 'question_escalated') {
    console.log(tl(lang(), '⏱ {taskId} 超时升级（Ⅱ 级 {qid}）：再无人答将退保守默认。node src/cli.mjs answer {qid} "..."', { taskId: e.taskId, qid: e.questionId }));
  } else if (e.type === 'question_stuck') {
    console.log(tl(lang(), '⏱ {taskId} 超时后仍挂起（{qid}）：没有默认可退，继续等人', { taskId: e.taskId, qid: e.questionId }));
  } else if (e.type === 'question_rerouted') {
    console.log(tl(lang(), '⏱ {taskId} 路由行时限到（{qid}）：转给 {to}', { taskId: e.taskId, qid: e.questionId, to: e.to.join(tl(lang(), '、')) || tl(lang(), '（空）') }));
  }
}

// 追问器的一次寿命。与 plan 同形：闸门在前、记账在后、停在提问上就退出。
// 批准那一刻由这里建工作区（现有仓库克隆 / 新项目空仓库），之后守护进程接 plan → run。
async function cmdDraft(db, taskId, flags) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId) ?? die(tl(lang(), '没有这个任务：{id}', { id: taskId }));
  if (!getTaskParam(db, taskId, 'draft.idea')) die(tl(lang(), '这个任务不是从想法开始的，没有可追问的东西。直接 node src/cli.mjs plan {taskId}', { taskId }));
  const pre = checkLimits(db, taskId, { startedAt: now(), idleCycles: 0 });
  if (pre) {
    const q = raiseLimitQuestion(db, { taskId, breach: pre });
    console.log(tl(lang(), '⛔ 追问前体检不过：{human}\n已生成 Ⅲ 级问题 {qid}（hard_rule），任务转入 waiting。', { human: pre.human, qid: q.questionId }));
    console.log(tl(lang(), '  加额：node src/cli.mjs limit {taskId} --{key} <新值>', { taskId, key: pre.key.replace('limit.', '') }));
    process.exitCode = 1;
    return;
  }
  const client = new LlmClient({ mode: flags.mode ?? 'live', cassette: flags.cassette, ...clientOpts(db, flags), ...fakeOpt(flags) });
  console.log(tl(lang(), '追问中（档位 {tier}）… 任务 {taskId}「{title}」', { tier: flags.tier ?? 'heavy', taskId, title: task.title }));
  let r;
  try {
    r = await draft(db, { client, taskId, tier: flags.tier ?? 'heavy' });
  } finally {
    const { rows, microUsd } = flushLedger(db, client, { taskId, role: 'elicitor' });
    if (rows) console.log(tl(lang(), '记账 {rows} 次调用，{usd}', { rows, usd: fmtUsd(microUsd) }));
  }
  if (r.kind === 'asking') {
    console.log(tl(lang(), '\n追问器提了 {n} 个 Ⅱ 级问题（带默认，超时链生效），任务转入 waiting：', { n: r.questions.length }));
    for (const id of r.questions) {
      const q = db.one(`SELECT text, default_action FROM questions WHERE id=?`, id);
      console.log(`\n  [${id}] ${q.text.split('\n')[0]}\n    ${tl(lang(), '默认：{a}', { a: String(q.default_action) })}`);
    }
    console.log(tl(lang(), '\n在看板答，或：node src/cli.mjs answer <qid> "..."。答完守护进程会自动接着追问。'));
  } else if (r.kind === 'proposed' && r.confirm) {
    console.log(tl(lang(), '\n没出新版：连着两次以「A」开头却读成"要改"，先挂了一条确认事项 {qid}：\n', { qid: r.questionId }));
    console.log(String(r.text ?? '').split('\n').map((l) => `  ${l}`).join('\n'));
  } else if (r.kind === 'proposed') {
    console.log(tl(lang(), '\n宪法块草案 v{version} 已出（Ⅲ 级批准问题 {qid}）：\n', { version: r.version, qid: r.questionId }));
    console.log(r.text.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log(tl(lang(), '\n回复：node src/cli.mjs answer {qid} "A"   （或直接写要改什么 / "C" 放弃）', { qid: r.questionId }));
  } else if (r.kind === 'approved') {
    // 项目里的任务从项目分支起工作区（多半 advanceProject 已经建好了，这里幂等）；旧的独立任务照旧用 draft.source。
    const pj = db.one(`SELECT p.repo, p.branch FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`, taskId);
    const source = pj?.repo ? pj.repo : getTaskParam(db, taskId, 'draft.source');
    const ws = ensureWorkspace(db, { taskId, source: source ?? null, empty: !source, dir: join(HOME, 'workspaces', taskId), ref: pj?.repo ? pj.branch : null });
    console.log(tl(lang(), '\n✅ 草案 v{version} 已批准，宪法块生效。工作区 {dir}（{from}）分支 {branch}', { version: r.version, dir: ws.dir, from: source ? tl(lang(), '克隆自 {source}', { source }) : tl(lang(), '新建空仓库'), branch: ws.branch }));
    console.log(tl(lang(), '守护进程会自动规划并开跑；没开守护进程就手动：node src/cli.mjs plan {taskId}', { taskId }));
  } else if (r.kind === 'abandoned') {
    console.log(tl(lang(), '\n已按你的答复放弃：任务 aborted。'));
  } else {
    console.log(tl(lang(), '\n没事可做：{why}', { why: dyn(r.why ?? r.kind) }));
  }
}

// 超时链的外部触发。编排器每轮开头也会扫，但它挂起时进程已退出 —— 30 分钟后得有人来。
// 没开守护进程时 cron 里放这一条：到期的问题处置完、任务从 waiting 回 running，再跑 run 就接上了。
async function cmdTick(db, taskId, flags) {
  const r = sweepTimeouts(db, { taskId, onEvent: (e) => printSweepEvent(db, e) });
  const sent = await notifyPendingQuestions(db, { env: process.env, extraCmd: flags.notify });
  if (sent.length) console.log(tl(lang(), '通知了 {n} 条事项的收件人', { n: sent.length }));
  // 发件箱：超时替人定了之类的不阻塞信号
  const pushed = (await deliverSignals(db, { env: process.env, extraCmd: flags.notify })).filter((s) => s.receipts.length);
  if (pushed.length) console.log(tl(lang(), '推了 {n} 条通知', { n: pushed.length }));
  const n = r.defaulted.length + r.escalated.length + r.stuck.length;
  console.log(n ? tl(lang(), '处置 {n} 个到期问题：默认 {d}｜升级 {e}｜挂起 {s}', { n, d: r.defaulted.length, e: r.escalated.length, s: r.stuck.length }) : tl(lang(), '没有到期的问题'));
  for (const t of new Set(r.defaulted.map((x) => x.taskId))) console.log(tl(lang(), '  任务 {t} 有分支解冻了：node src/cli.mjs run {t}', { t }));
}

/**
 * 决定登记：这个项目此刻仍然有效的约定清单。`--all` 连作废的一起列，`--void <id> "理由"` 手工作废一条。
 * 清单里的每条都是人拍过板的（有结论的事项 / 批准过的契约 / 批准过的变更 / 改过的项目目标）。
 */
function cmdDecisions(db, id, flags) {
  const projectId = db.one(`SELECT id FROM projects WHERE id=?`, id)?.id
    ?? db.one(`SELECT project_id FROM tasks WHERE id=?`, id)?.project_id ?? null;
  const taskId = projectId ? null : id;
  if (flags.void) {
    const { userId } = cliIdentity(db, flags);
    voidDecision(db, { id: String(flags.void), by: userId, reason: flags._?.join(' ') || tl(contentLang(db), '人工作废') });
    console.log(tl(lang(), '已作废 {id}', { id: flags.void }));
    return;
  }
  const live = activeDecisions(db, { projectId, taskId });
  console.log(tl(lang(), '有效的决定 {n} 条', { n: live.length }) + (projectId ? tl(lang(), '（项目 {id}）', { id: projectId }) : tl(lang(), '（独立任务 {id}）', { id: taskId })));
  console.log(live.length ? renderDecisions(live) : tl(lang(), '  （还没有）'));
  if (!flags.all) { console.log(tl(lang(), '\n加 --all 连已作废的一起看；--void <决定 id> "理由" 手工作废一条。')); return; }
  const dead = projectId
    ? db.all(`SELECT * FROM decision_registry WHERE project_id=? AND status='void' ORDER BY decided_at`, projectId)
    : db.all(`SELECT * FROM decision_registry WHERE project_id IS NULL AND task_id=? AND status='void' ORDER BY decided_at`, taskId);
  if (!dead.length) { console.log(tl(lang(), '\n没有已作废的决定')); return; }
  console.log(tl(lang(), '\n已作废 {n} 条', { n: dead.length }));
  for (const d of dead) {
    const by = db.one(`SELECT supersedes FROM decision_registry WHERE supersedes=? LIMIT 1`, d.id);
    console.log(`  [${d.id}] ${d.subject}${tl(lang(), '：')}${String(d.statement).split('\n')[0].slice(0, 100)}\n    ${tl(lang(), '作废原因：{why}', { why: d.void_reason || '—' })}${by ? tl(lang(), '（已被新的决定取代）') : ''}`);
  }
}

/**
 * 停等账本：每个没结束的任务此刻在等谁。`⚠` 那几行是缺陷 —— 系统说不出它在等谁。
 * 只读，不提事项（提事项是守护进程每轮做的事，见 core/liveness.mjs）；`--raise` 才真的报。
 */
function cmdStalls(db, flags) {
  const opts = { assess: (d, t, o) => assessTask(d, t, o), hasWorkspace: (t) => existsSync(join(HOME, 'workspaces', t)) };
  const rows = flags.raise ? sweepLiveness(db, opts).stalls : stalls(db, opts);
  const by = { self: [], clock: [], human: [], upstream: [], unknown: [] };
  for (const s of rows) by[s.kind].push(s);
  console.log(tl(lang(), '没结束的任务 {n} 个：在跑 {self}｜等时钟 {clock}｜等人 {human}｜等上游 {upstream}｜', { n: rows.length, self: by.self.length, clock: by.clock.length, human: by.human.length, upstream: by.upstream.length })
    + (by.unknown.length ? tl(lang(), '⚠ 说不出在等谁 {n}', { n: by.unknown.length }) : tl(lang(), '说不出在等谁 0')));
  for (const k of ['unknown', 'human', 'upstream', 'clock', 'self']) {
    if (!by[k].length) continue;
    console.log(`\n${k === 'unknown' ? '⚠ ' : ''}${dyn(STALL_KINDS[k])}`);
    for (const s of by[k]) console.log(`  ${s.taskId} ${s.title ?? ''}\n    ${dyn(s.why)}${s.assessed ? tl(lang(), '　〔守护进程原话：{words}〕', { words: dyn(s.assessed) }) : ''}`);
  }
  if (by.unknown.length && !flags.raise) console.log(tl(lang(), '\n加 --raise 把这 {n} 条升成给负责人的事项（守护进程在跑时每轮自动做）。', { n: by.unknown.length }));
  const loops = livelocks(db, {});
  if (loops.length) { console.log(tl(lang(), '\n⚠ 空转 {n} 处（系统在没有新信息时重复自己）', { n: loops.length })); for (const l of loops) console.log(`  ${l.taskId} ${l.title ?? ''}${tl(lang(), '：')}${dyn(l.why)}`); }
}

/** 运行期不变量：现状；--run 立刻全查一遍（不等守护进程的周期） */
function cmdInvariants(db, flags) {
  if (flags.run) sweepInvariants(db, { force: true, home: HOME, assess: (d, t, o) => assessTask(d, t, o), assessOpts: { hasWorkspace: (t) => existsSync(join(HOME, 'workspaces', t)) } });
  const rows = invariantsView(db);
  const when = (ts) => (ts ? new Date(ts).toLocaleString() : tl(lang(), '还没查过'));
  for (const r of rows) {
    // 0 个对象的"都对"什么都没证明（复盘的约定）：打 ·，不打 ✓
    const mark = r.checkedAt == null || (!r.violations && !r.checked) ? '·' : r.error ? '?' : r.violations ? (r.level === 'bad' ? '✗' : '⚠') : '✓';
    console.log(`${mark} ${tl(lang(), (r.violations ? INVARIANT_PROBLEMS : INVARIANT_NAMES)[r.id] ?? r.id)}  ${tl(lang(), '（{id}，最近一次 {t}）', { id: r.id, t: when(r.checkedAt) })}`);
    if (r.error) console.log(tl(lang(), '    没查成：{err}', { err: r.error }));
    else if (r.checkedAt != null && !r.checked && !r.skipped) console.log(tl(lang(), '    没有可查的对象'));
    else if (r.skipped) console.log(tl(lang(), '    这次跳过：{why}', { why: r.skipped === 'paused' ? tl(lang(), '全部自动运行暂停着') : r.skipped }));
    else if (r.violations) {
      console.log(tl(lang(), '    {n} 处，{t} 发现：', { n: r.violations, t: when(r.since) }));
      for (const v of r.sample) console.log(`      ${invariantLine(r.id, v, lang())}`);
      if (r.violations > r.sample.length) console.log(tl(lang(), '      ……还有 {n} 处', { n: r.violations - r.sample.length }));
    }
    if (r.baselined) console.log(tl(lang(), '    另有 {n} 处是启用这项检查之前就有的，不计', { n: r.baselined }));
  }
  if (!flags.run) console.log(tl(lang(), '\n守护进程按各条的周期自动查；要马上全查一遍：node src/cli.mjs invariants --run'));
}

/**
 * 待决事项打包摘要：默认是"我"的（按令牌）；负责人可 --user <id> 看别人的。--send 按此人的通道真发一份并记 digests。
 * 换班交接自动发（值班者变了就给接班人推）。不再定时推全量清单：不紧急的新事项由推送队列攒成汇总推送（core/push-queue.mjs）。
 */
async function cmdDigest(db, flags) {
  const me = cliIdentity(db, flags);
  let userId = me.userId;
  if (flags.user) {
    const target = db.one(`SELECT id FROM users WHERE id=? OR display_name=?`, String(flags.user), String(flags.user)) ?? die(tl(lang(), '没有这个用户：{id}', { id: flags.user }));
    if (target.id !== me.userId && db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role !== 'lead') die(tl(lang(), '只有管理员能看别人的待办'));
    userId = target.id;
  }
  if (flags.send) {
    const r = await sendDigest(db, { userId, kind: 'manual', env: process.env, extraCmd: flags.notify, onlyIfAny: false });
    console.log(r.text);
    console.log(r.sent ? tl(lang(), '\n已发到 {n} 条通道（{ok} 条送达）', { n: r.receipts.length, ok: r.receipts.filter((x) => x.ok).length }) : tl(lang(), '\n没有可用的通知通道（成员用 user channel 挂一条；管理员也可用 .env 的部署级通道），只打印了'));
    return;
  }
  const d = buildDigest(db, { userId, daemonAlive: daemonStatus(HOME).alive });
  console.log(renderDigest(d));
  if (d.total) console.log(tl(lang(), '\n发到通知通道：node src/cli.mjs digest --send') + (flags.user ? ` --user ${flags.user}` : ''));
}

/** 状态报告：这段时间发生了什么。默认最近 7 天、与你有关的、摘要。 */
function cmdReport(db, flags) {
  const me = cliIdentity(db, flags);
  let userId = me.userId;
  const isLead = db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role === 'lead';
  if (flags.user) {
    const target = db.one(`SELECT id FROM users WHERE id=? OR display_name=?`, String(flags.user), String(flags.user)) ?? die(tl(lang(), '没有这个用户：{id}', { id: flags.user }));
    if (target.id !== me.userId && !isLead) die(tl(lang(), '只有管理员能看别人的状态报告'));
    userId = target.id;
  }
  if (flags.all && !isLead) die(tl(lang(), '全部项目的状态报告只有管理员能看'));
  const detail = flags.detail ? String(flags.detail) : 'summary';
  if (!REPORT_DETAILS.includes(detail)) die(tl(lang(), '--detail 只能是 {list}', { list: REPORT_DETAILS.join(' / ') }));
  const until = Date.now();
  const since = flags.since ? parseSince(String(flags.since), until) : until - 7 * 86_400_000;
  if (since == null) die(tl(lang(), '--since 写法不对：{v}（例：24h、7d、2026-11-01）', { v: flags.since }));
  const r = renderStatusReport(buildStatusReport(db, { userId, since, until, scope: flags.all ? 'all' : 'mine', detail }));
  console.log(`${r.title}\n\n${r.text}`);
}

/**
 * 模型目录漂移检查（确定性，不调模型）：存在性（各家 /models）、可选实调（--probe，每模型一次 16 token 请求；--vision，每模型一次带图请求，看收不收截图）、
 * 单价与窗口（OpenRouter 公开表 / Gemini API）。只报告，目录由人改。结果落审计 catalog_checked，进负责人的待办摘要。
 */
async function cmdCatalog(db, sub, flags) {
  if (sub === 'last') {
    const last = lastCatalogCheck(db);
    if (!last) { console.log(tl(lang(), '还没查过：node src/cli.mjs catalog check')); return; }
    console.log(tl(lang(), '上次检查 {at}：{n} 项要看一眼', { at: when(db, last.checkedAt ?? last.ts, { seconds: true }), n: last.warnings }) + (last.probe ? tl(lang(), '（含实调）') : '') + (last.fetchErrors ? tl(lang(), '，{n} 处拉取失败', { n: last.fetchErrors }) : ''));
    for (const l of last.lines ?? []) console.log(`  - ${l}`);
    return;
  }
  if (!sub || sub === 'list') {
    const reg = registryFor(db);
    const keys = keyPresence(reg.vendors, process.env);
    console.log(tl(lang(), '模型目录（{n} 条；★ = 绑着；○ = 停用）：', { n: Object.keys(reg.catalog).length }));
    for (const m of Object.values(reg.catalog)) {
      const why = bindable(m, reg.vendors);
      const tiers = TIERS.filter((t) => reg.binding[t] === m.key);
      const p = m.pricing;
      console.log(`  ${tiers.length ? '★' : m.enabled ? ' ' : '○'} ${m.key.padEnd(36)} ${p ? `${p.input}/${p.output}`.padEnd(14) : tl(lang(), '缺单价').padEnd(12)} ${m.contextWindow ? tl(lang(), '窗口 {n}', { n: m.contextWindow }) : tl(lang(), '窗口未核实')}  ${tl(lang(), '推理强度 {efforts}', { efforts: (m.efforts ?? ['low', 'medium', 'high']).join('/') || tl(lang(), '不支持') })}`
        + `${tiers.length ? `  ← ${tiers.join('/')}` : ''}${m.orphan ? tl(lang(), '  （只能删：node src/cli.mjs catalog remove {key}）', { key: m.key }) : m.source === 'user' ? tl(lang(), '  （用户新增）') : m.overridden ? tl(lang(), '  （改过默认值）') : ''}${why ? `  ⚠ ${dyn(why)}` : ''}${keys[m.vendor] && !keys[m.vendor].present ? tl(lang(), '  （{env} 未填）', { env: keys[m.vendor].keyEnv }) : ''}`);
    }
    return;
  }
  if (['add', 'set', 'remove', 'enable', 'disable'].includes(sub)) {
    const key = flags._key ?? die(tl(lang(), '要给模型键（服务商/模型）'));
    const { userId } = cliIdentity(db, flags);
    try {
      if (sub === 'remove') { const r = removeModel(db, { key, userId }); console.log(r.reverted ? tl(lang(), '{key} 已回到代码默认值', { key }) : tl(lang(), '{key} 已从目录删除', { key })); return; }
      if (sub === 'enable' || sub === 'disable') { saveModel(db, { key, fields: { enabled: sub === 'enable' }, userId }); console.log(sub === 'enable' ? tl(lang(), '{key} 已启用', { key }) : tl(lang(), '{key} 已停用', { key })); return; }
      const f = {};
      if (flags.model !== undefined) f.model = String(flags.model);
      if (flags.adapter !== undefined) f.adapter = String(flags.adapter);
      if (flags.window !== undefined) f.contextWindow = Number(flags.window);
      if (flags.efforts !== undefined) f.efforts = String(flags.efforts) === 'none' ? [] : String(flags.efforts).split(',').map((x) => x.trim()).filter(Boolean);
      if ([flags.input, flags.output, flags['cache-read'], flags['cache-write']].some((x) => x !== undefined)) f.pricing = { input: flags.input, output: flags.output, cacheRead: flags['cache-read'], cacheWrite: flags['cache-write'] };
      if (flags.note !== undefined) f.notes = list(flags.note).map(String);
      if (sub === 'add' && catalogOf(db)[key]) die(tl(lang(), '{key} 已在目录里；改用 catalog set', { key }));
      const m = saveModel(db, { key, fields: f, userId });
      const why = bindable(m, endpointsOf(db));
      console.log(tl(lang(), '已保存 {key}（{vendor} · {model}{price}）', { key, vendor: m.vendor, model: m.model, price: m.pricing ? tl(lang(), '，{input}/{output} 每百万 token', { input: m.pricing.input, output: m.pricing.output }) : tl(lang(), '，缺单价') })
        + (why ? tl(lang(), '\n  ⚠ 还不能用：{why}', { why: dyn(why) }) : ''));
    } catch (e) { die(translateError(e, lang())); }
    return;
  }
  if (sub !== 'check') die(tl(lang(), '用法：node src/cli.mjs catalog [list] | check [--probe] [--vision] [--vendor <id>] | last | add|set <服务商/模型> --input <$/M> --output <$/M> [--cache-read] [--cache-write] [--window N] [--efforts low,medium,high|none] [--model <发给厂商的名>] | remove|enable|disable <键>'));
  const { userId } = cliIdentity(db, flags);
  const reg = checkableCatalog(db);
  const r = await checkCatalog({ catalog: reg.catalog, vendors: reg.vendors, env: process.env, probe: !!flags.probe, vision: !!flags.vision, only: flags.vendor ? String(flags.vendor) : null, lang: contentLang(db) });
  console.log(renderCatalogCheck(r, { lang: lang() }));
  recordCatalogCheck(db, r, { by: userId, actorKind: 'user', lang: contentLang(db) });
  process.exitCode = r.warnings ? 1 : 0;
}

// ── 档位绑定与服务商的 CLI 面（看板是主界面；这里保证"全部动作都有 CLI"）─────────────────────────
function cmdBind(db, sub, args, flags) {
  if (!sub || sub === 'show') { printBinding(db); return; }
  // bind role <角色> <服务商/模型 | tier>（tier = 取消单独绑定，回到档位）
  if (sub === 'role') {
    const [role, key] = args;
    if (!role || !key) die(tl(lang(), '用法：node src/cli.mjs bind role <角色> <服务商/模型> [--effort low|medium|high] ｜ bind role <角色> tier（回到档位）。角色：{roles}', { roles: Object.keys(LLM_ROLES).join(' ') }));
    const { userId } = cliIdentity(db, flags);
    try { setRoleBinding(db, { role, modelKey: key === 'tier' ? null : key, effort: flags.effort ? String(flags.effort) : null, userId }); } catch (e) { die(translateError(e, lang())); }
    console.log(key === 'tier' ? tl(lang(), '{role} 回到档位', { role }) : tl(lang(), '{role} → {key}', { role, key }));
    printBinding(db); return;
  }
  // bind fallback <tier>=<服务商/模型|none>：主模型那家熔断 / 重试用尽时自动换用
  if (sub === 'fallback') {
    if (!args.length) die(tl(lang(), '用法：node src/cli.mjs bind fallback <tier>=<服务商/模型>（none = 去掉备用）'));
    const { userId } = cliIdentity(db, flags);
    for (const sp of args) {
      const eq = String(sp).indexOf('='); if (eq <= 0) die(tl(lang(), '要写成 tier=服务商/模型，实得 {sp}', { sp }));
      const tier = String(sp).slice(0, eq), key = String(sp).slice(eq + 1);
      try { setFallback(db, { tier, modelKey: key === 'none' ? null : key, userId }); } catch (e) { die(translateError(e, lang())); }
      console.log(key === 'none' ? tl(lang(), '{tier} 档不再配备用模型', { tier }) : tl(lang(), '{tier} 档备用 → {key}（主模型那家连着出错、或重试几次还失败时自动换用）', { tier, key }));
    }
    printBinding(db); return;
  }
  if (sub !== 'set') die(tl(lang(), '用法：node src/cli.mjs bind [show] | bind set <tier>=<服务商/模型>... [--effort low|medium|high|none] | bind fallback <tier>=<服务商/模型|none> | bind role <角色> <服务商/模型|tier>'));
  if (!args.length) die(tl(lang(), '要给 tier=服务商/模型（可多个）'));
  const { userId } = cliIdentity(db, flags);
  const effort = flags.effort === undefined ? undefined : (String(flags.effort) === 'none' ? null : String(flags.effort));
  for (const sp of args) {
    const eq = String(sp).indexOf('='); if (eq <= 0) die(tl(lang(), '要写成 tier=服务商/模型，实得 {sp}', { sp }));
    const tier = String(sp).slice(0, eq), key = String(sp).slice(eq + 1);
    try { setBinding(db, { tier, modelKey: key, effort, userId }); } catch (e) { die(translateError(e, lang())); }
    console.log(`${tier} → ${key}${effort ? tl(lang(), '，推理强度 {effort}', { effort }) : effort === null ? tl(lang(), '，推理强度清空（各角色自己的默认）') : ''}${tl(lang(), '  （下一个节点起生效；正在跑的节点跑完才换）')}`);
  }
  printBinding(db);
}

async function cmdEndpoint(db, sub, args, flags) {
  if (!sub || sub === 'list') {
    const eps = endpointsOf(db); const keys = keyPresence(eps, process.env);
    console.log(tl(lang(), '服务商（● 启用 ○ 停用；key 只看填没填）：'));
    for (const e of Object.values(eps)) {
      if (e.orphan) { console.log(`  ○ ${e.id.padEnd(12)} ${tl(lang(), '⚠ 升级后系统里已经没有这个服务商了（只剩以前改过的几项设置）；只能删：node src/cli.mjs endpoint remove {id}', { id: e.id })}`); continue; }
      console.log(`  ${e.enabled ? '●' : '○'} ${e.id.padEnd(12)} ${String(e.adapter).padEnd(17)} ${(e.baseUrl ?? '').padEnd(44)} ${e.keyEnv}=${keys[e.id].present ? tl(lang(), '已填') : tl(lang(), '未填')}`
        + `${e.gateway ? tl(lang(), '  聚合平台') : ''}${e.billing === 'reported' ? tl(lang(), '  按回报计费') : ''}${e.authHeader ? tl(lang(), '  鉴权头 {h}', { h: e.authHeader }) : ''}${e.label && e.label !== e.id ? `  「${e.label}」` : ''}${e.source === 'user' ? tl(lang(), '  （用户新增）') : e.overridden ? tl(lang(), '  （改过默认值）') : ''}`);
    }
    console.log(tl(lang(), '\n新增：node src/cli.mjs endpoint set <id> --adapter openai-chat|openai-responses|anthropic|gemini --base-url <URL> --key-env <变量名> [--auth-header X --auth-prefix "Bearer "] [--models-path /models] [--gateway] [--billing reported] [--label 名]'));
    return;
  }
  const id = args[0] ?? die(tl(lang(), '要给服务商 id'));
  if (sub === 'test') {
    const r = await testEndpoint(db, { id, model: flags.model ? String(flags.model) : null });
    console.log(`${r.ok ? '✅' : '✗'} ${id}${r.model ? tl(lang(), '（{name}）', { name: r.model }) : ''}${tl(lang(), '：')}${dyn(r.message)}`);
    process.exitCode = r.ok ? 0 : 1; return;
  }
  if (sub === 'models') {
    const e = endpointsOf(db)[id] ?? die(tl(lang(), '没有这个服务商：{id}', { id }));
    const r = await listEndpointModels(e, { env: process.env });
    if (r.error) die(tl(lang(), '拉取失败：{err}', { err: r.error }));
    const cat = catalogOf(db);
    for (const m of r.rows) console.log(`  ${cat[`${id}/${m.id}`] ? '✓' : ' '} ${m.id}${m.pricing ? `  ${m.pricing.input}/${m.pricing.output}` : ''}${m.contextWindow ? `  ${tl(lang(), '窗口 {n}', { n: m.contextWindow })}` : ''}${m.efforts && !m.efforts.length ? tl(lang(), '  不支持推理强度') : ''}`);
    console.log(tl(lang(), '\n{n} 个（✓ = 已在目录）。加入：node src/cli.mjs catalog add {id}/<模型> --input <$/M> --output <$/M>', { n: r.rows.length, id })
      + (r.rows.some((m) => m.pricing) ? tl(lang(), '（这个平台的列表带价格，看板上一键加入会带上）') : tl(lang(), '（这个平台的列表不带价格，要自己填）')));
    return;
  }
  const { userId } = cliIdentity(db, flags);
  try {
    if (sub === 'set') {
      const e = saveEndpoint(db, { id, label: flags.label === undefined ? undefined : String(flags.label), adapter: flags.adapter === undefined ? undefined : String(flags.adapter),
        baseUrl: flags['base-url'] === undefined ? undefined : String(flags['base-url']), keyEnv: flags['key-env'] === undefined ? undefined : String(flags['key-env']),
        authHeader: flags['auth-header'] === undefined ? undefined : String(flags['auth-header']), authPrefix: flags['auth-prefix'] === undefined ? undefined : String(flags['auth-prefix']),
        modelsPath: flags['models-path'] === undefined ? undefined : String(flags['models-path']), gateway: flags.gateway === undefined ? undefined : !!flags.gateway,
        billing: flags.billing === undefined ? undefined : String(flags.billing), userId });
      console.log(tl(lang(), '已保存服务商 {id}（{adapter} · {url}；key 在 .env 的 {env}', { id: e.id, adapter: e.adapter, url: String(e.baseUrl), env: e.keyEnv })
        + (process.env[e.keyEnv] ? tl(lang(), '，已填') : tl(lang(), '，还没填')) + tl(lang(), '）'));
      return;
    }
    if (sub === 'enable' || sub === 'disable') { setEndpointEnabled(db, { id, enabled: sub === 'enable', userId }); console.log(sub === 'enable' ? tl(lang(), '{key} 已启用', { key: id }) : tl(lang(), '{key} 已停用', { key: id })); return; }
    if (sub === 'remove') { const r = removeEndpoint(db, { id, userId }); console.log(r.reverted ? tl(lang(), '{key} 已回到代码默认值', { key: id }) : tl(lang(), '{id} 及其模型已删除', { id })); return; }
  } catch (e) { die(translateError(e, lang())); }
  die(tl(lang(), '用法：node src/cli.mjs endpoint [list] | set <id> … | enable|disable|remove|test|models <id>'));
}

const cliIdentity = (db, flags) => {
  const tokenFile = flags['token-file'] ?? TOKEN_FILE;
  if (!existsSync(tokenFile)) die(tl(lang(), '找不到 CLI 令牌 {file}。先跑 node src/cli.mjs init', { file: tokenFile }));
  const plaintext = (flags.token ?? readFileSync(tokenFile, 'utf8')).trim();
  const auth = authenticate(db, plaintext) ?? die(tl(lang(), '令牌无效、已过期或已吊销'));
  return { plaintext, userId: auth.user_id, tokenId: auth.token_id, kind: auth.kind, userKind: auth.user_kind };
};

// 自己的令牌（list / new / revoke），管理员另能看全员（list --everyone）、吊销任何人的
function cmdToken(db, sub, args, flags) {
  const me = cliIdentity(db, flags);
  const isLead = db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role === 'lead';
  const day = (ts) => (ts ? when(db, ts, { zone: false }).slice(0, 10) : tl(lang(), '不过期'));
  if (!sub || sub === 'list') {
    const rows = flags.everyone ? (isLead ? activeTokens(db) : die(tl(lang(), '只有管理员能看全员的令牌'))) : tokensOf(db, me.userId, { current: me.tokenId, all: !!flags.all });
    for (const t of rows) console.log(`  ${t.id}  ${(t.display_name ? `${t.display_name} ` : '')}${dyn(t.name ?? '-')}  ${t.kind}/${t.scope}  ${tl(lang(), '到期 {d}', { d: day(t.expires_at) })}  ${t.last_used_at ? tl(lang(), '最后使用 {d}{ip}', { d: new Date(t.last_used_at).toISOString().slice(0, 16).replace('T', ' '), ip: t.last_ip ? ` ${t.last_ip}` : '' }) : tl(lang(), '没用过')}${t.id === me.tokenId ? tl(lang(), '  ← 现在用的') : ''}${t.status && t.status !== 'active' ? `  [${t.status}]` : ''}`);
    return;
  }
  if (sub === 'new') {
    const name = args[0] ?? die(tl(lang(), 'token new <名字> [--scope read|write] [--days N] [--out <文件>]'));
    const t = issueToken(db, { userId: me.userId, by: me.userId, name, scope: flags.scope ?? 'write', days: flags.days === undefined ? undefined : Number(flags.days), kind: me.userKind === 'service' ? 'service' : 'cli' });
    audit(db, { actorKind: 'user', actorId: me.userId, action: 'token_issued', targetType: 'user', targetId: me.userId, payload: { tokenId: t.tokenId, name, scope: flags.scope ?? 'write', expiresAt: t.expiresAt, via: 'cli' } });
    const out = flags.out ?? join(HOME, 'tokens', `${me.userId}-${t.tokenId}.token`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, t.plaintext, { mode: 0o600 });
    console.log(tl(lang(), '已签发 {id}（{scope}，到期 {d}）；令牌写入 {file}（库里只有哈希，这是唯一副本）', { id: t.tokenId, scope: flags.scope ?? 'write', d: day(t.expiresAt), file: out }));
    return;
  }
  if (sub === 'revoke') {
    if (flags['all-others']) { console.log(tl(lang(), '已吊销 {n} 个（保留现在用的这枚）', { n: revokeAllOf(db, { userId: me.userId, byUserId: me.userId, keep: me.tokenId }) })); return; }
    const id = args[0] ?? die(tl(lang(), 'token revoke <令牌 id> | token revoke --all-others'));
    try { console.log(tl(lang(), '已吊销 {n} 个（含用它登录的浏览器会话）', { n: revokeTokenBy(db, { tokenId: id, byUserId: me.userId, isAdmin: isLead }) })); } catch (e) { die(translateError(e, lang())); }
    return;
  }
  die(tl(lang(), '未知子命令：token {sub}（可选 list / new / revoke）', { sub }));
}

// 邀请链接（管理员）。链接 = 看板对外地址 + /?invite=<码>
function cmdInvite(db, sub, args, flags) {
  const me = cliIdentity(db, flags);
  if (db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role !== 'lead') die(tl(lang(), '只有管理员能发邀请'));
  if (!sub || sub === 'list') { for (const i of invitesList(db)) console.log(`  ${i.id}  ${i.role.padEnd(8)} ${(i.used_by_name ?? i.name ?? '-').padEnd(12)} ${i.status}  ${when(db, i.created_at)}`); return; }
  if (sub === 'new') {
    try {
      const r = createInvite(db, { byUserId: me.userId, role: flags.role ?? 'member', name: flags.name ?? null, hours: flags.hours === undefined ? undefined : Number(flags.hours) });
      const base = String(flags['public-url'] ?? 'https://<看板地址>').replace(/\/+$/, '');
      console.log(tl(lang(), '邀请链接（只显示这一次，{date} 前有效、只能用一次；私下发给对方）：', { date: when(db, r.expiresAt) }));
      console.log(`  ${base}/?invite=${encodeURIComponent(r.code)}`);
    } catch (e) { die(translateError(e, lang())); }
    return;
  }
  if (sub === 'revoke') { console.log(revokeInviteBy(db, { inviteId: args[0] ?? die(tl(lang(), 'invite revoke <邀请 id>')), byUserId: me.userId }) ? tl(lang(), '已撤销') : tl(lang(), '没有可撤销的（已用过、已撤销或已过期）')); return; }
  die(tl(lang(), '未知子命令：invite {sub}（可选 list / new / revoke）', { sub }));
}

// 连接（推送 / 开 PR 用的凭据）。凭据从文件或标准输入读，不接受写在命令行上（会留在 shell 历史和进程列表里）。
// 凭据文件读不到：说哪个文件、为什么（原来直接甩 Node 的堆栈；用户实际运行上把文件名记错时撞上）
function readSecretFile(path, L) {
  try { return readFileSync(path, 'utf8'); }
  catch (e) { die(e.code === 'ENOENT' ? tl(L, '找不到文件：{path}（检查文件名与路径；记事本另存时可能多了 .txt 后缀）', { path }) : tl(L, '读不了文件 {path}：{why}', { path, why: e.code ?? e.message })); }
}
async function cmdCred(db, sub, args, flags) {
  const me = cliIdentity(db, flags);
  const L = lang();
  const day = (ts) => when(db, ts, { zone: false }).slice(0, 10);
  if (!sub || sub === 'list') {
    const { rows, order } = listCredentials(db, { viewerId: me.userId });
    if (!rows.length) console.log(tl(L, '（还没有任何连接：交付到 GitHub 时推不上去、也开不了 PR）'));
    for (const c of rows) {
      console.log(`  ${c.id}  ${c.name}  ${c.kind}  ${c.host}/${c.pathGlob}  ${c.hint ?? ''}  ${c.ownerId ? tl(L, '归 {name}', { name: c.ownerName ?? c.ownerId }) : tl(L, '部署级')}`
        + `${c.expiresAt ? `  ${tl(L, '到期 {d}', { d: day(c.expiresAt) })}` : ''}${c.expired ? `  [${tl(L, '已过期')}]` : ''}`);
    }
    console.log(tl(L, '挑选顺序：{order}（改：node src/cli.mjs user setting deploy.credential_order personal_first|app_first）', { order }));
    return;
  }
  if (sub === 'add') {
    const kind = { token: 'token', 'github-app': 'github_app', ssh: 'ssh_key' }[args[0]]
      ?? die(tl(L, 'cred add token|github-app|ssh --name <名字> (--key-file <文件> | --stdin) [--host github.com] [--repos acme/*] [--mine] [--app-id N] [--username U] [--expires YYYY-MM-DD]'));
    const name = flags.name ?? die(tl(L, '要给 --name <名字>'));
    const secret = typeof flags['key-file'] === 'string' ? readSecretFile(flags['key-file'], L) : flags.stdin ? readFileSync(0, 'utf8')
      : die(tl(L, '凭据从文件（--key-file <路径>）或标准输入（--stdin）读；不接受写在命令行上（会留在 shell 历史和进程列表里）'));
    try {
      const r = addCredential(db, { kind, name: String(name), ownerId: flags.mine ? me.userId : null, host: flags.host ?? 'github.com', pathGlob: flags.repos ?? '*', secret,
        appId: flags['app-id'] ?? null, username: flags.username ?? null, apiBase: flags['api-base'] ?? null,
        expiresAt: flags.expires ? (validDayKey(String(flags.expires)) ? zonedTime(...String(flags.expires).split('-').map(Number), 23, 59, 59, deployTz(db)) : NaN) : null, byUserId: me.userId });
      console.log(tl(L, '已添加 {id}（{hint}）。值已加密存进状态库，之后谁都看不到；原文件可以删了', { id: r.id, hint: r.hint }));
    } catch (e) { die(translateError(e, L)); }
    return;
  }
  if (sub === 'revoke') {
    try { console.log(revokeCredential(db, { id: args[0] ?? die(tl(L, 'cred revoke <连接 id>')), byUserId: me.userId }) ? tl(L, '已吊销') : tl(L, '已经吊销过了')); } catch (e) { die(translateError(e, L)); }
    return;
  }
  if (sub === 'check') {
    const remote = args[0] ?? die(tl(L, 'cred check <远端地址> [--action read|push|pr]'));
    let c;
    try { c = await checkAccess(db, { remote: safePositional(remote), action: ['read', 'push', 'pr'].includes(flags.action) ? flags.action : 'push', actorId: me.userId }); } catch (e) { die(translateError(e, L)); }
    console.log(c.credential ? tl(L, '会用「{name}」（{owner}）', { name: c.credential.name, owner: c.credential.ownerName ? tl(L, '{name} 自己的连接', { name: c.credential.ownerName }) : tl(L, '部署级连接') })
      : c.local ? tl(L, '这是本机路径：用服务器上 git 自己的权限，不需要连接') : tl(L, '没有匹配的连接：会试服务器上 git 自己配的凭据（一般没有，多半会失败）'));
    console.log(`  ${tl(L, '能读')}: ${c.canRead}  ${tl(L, '能推送')}: ${c.canPush ?? '-'}${c.defaultBranch ? `  ${tl(L, '（默认分支 {b}）', { b: c.defaultBranch })}` : ''}`);
    if (c.detail) console.log(`  ${c.detail}`);
    for (const x of c.tried) console.log(`  ${tl(L, '没用上的：')}${x.name} —— ${x.why}`);
    process.exitCode = c.canRead === false || c.canPush === false ? 1 : 0;
    return;
  }
  if (sub === 'oauth') {
    // 用 GitHub 登录：给部署级 GitHub App 连接填 Client ID 与 Client secret（secret 只从文件或标准输入读）
    const id = args[0] ?? die(tl(L, 'cred oauth <App 连接 id> --client-id <Client ID> [--secret-file <文件> | --stdin]   给 GitHub App 连接填登录用的 Client ID / Client secret'));
    const secret = typeof flags['secret-file'] === 'string' ? readSecretFile(flags['secret-file'], L) : flags.stdin ? readFileSync(0, 'utf8') : undefined;
    try { const r = setAppOAuth(db, { id, clientId: flags['client-id'], clientSecret: secret, byUserId: me.userId }); console.log(tl(L, '已保存：{id} 的 Client ID {cid}', { id: r.id, cid: r.clientId })); } catch (e) { die(translateError(e, L)); }
    const g = githubLoginConfig(db);
    console.log(g.enabled ? tl(L, 'GitHub 登录已就绪：只放行 {org} 的正式成员', { org: g.org }) : tl(L, 'GitHub 登录还缺：{what}（组织名用 user setting deploy.github_login_org <组织> 设）', { what: g.missing.join(', ') }));
    return;
  }
  if (sub === 'member') {
    // 不开浏览器验证 GitHub 登录的配置：App 装没装在组织上、有没有 Members 读权限、这个账号算不算正式成员
    const login = args[0] ?? die(tl(L, 'cred member <GitHub 账号>   查这个账号是不是登录组织的正式成员（验证 GitHub 登录的配置）'));
    const g = githubLoginConfig(db);
    if (!g.org) die(tl(L, '还没设登录组织：user setting deploy.github_login_org <组织>'));
    // 不用 die：网络请求刚结束就 process.exit，Windows 上 libuv 会断言失败（handle 还在关）
    try { const m = await isOrgMember(db, { org: g.org, login }); console.log(m ? tl(L, '{login} 是 {org} 的正式成员', { login, org: g.org }) : tl(L, '{login} 不是 {org} 的正式成员（受邀还没接受也不算）', { login, org: g.org })); process.exitCode = m ? 0 : 1; }
    catch (e) { console.error(tl(L, '查不了：{why}', { why: e.message })); process.exitCode = 1; }
    return;
  }
  die(tl(L, '未知子命令：cred {sub}（可选 list / add / revoke / check / oauth / member）', { sub }));
}

// 交付前钩子要人确认：报错后面接上怎么确认（看板上是弹窗）
const hookAcks = (flags) => String(flags['hook-ack'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const hookAskText = (e) => translateError(e, lang()) + (e?.hookAsk ? `\n${tl(lang(), '看过没问题：同一条命令加 --hook-ack {key} 再交付一次', { key: e.hookAsk })}` : '');

// 交付：push + PR。PR 正文取真相源里最近一份 task_done 汇报，不另调模型。
async function cmdDeliver(db, taskId, flags) {
  const { userId, tokenId } = cliIdentity(db, flags);
  const wsDir = flags.dir ?? join(HOME, 'workspaces', taskId);
  if (!existsSync(wsDir)) die(tl(lang(), '工作区不存在：{dir}', { dir: wsDir }));
  let r;
  try {
    r = await deliverTask(db, { taskId, workspace: wsDir, remote: flags.remote ?? null, branch: flags.branch ?? null,
      pr: !!flags.pr, base: flags.base ?? null, userId, tokenId, autofix: flags.autofix !== 'off', home: HOME, hookAck: hookAcks(flags) });
  } catch (e) { die(hookAskText(e)); }
  console.log(tl(lang(), '已 push：{remote}  {branch} @ {head}', { remote: r.remote, branch: r.branch, head: r.head.slice(0, 8) }));
  if (r.pr) {
    console.log(tl(lang(), '已开 PR：{url}（base {base}）', { url: r.pr.url, base: r.pr.base }));
    if (!r.pr.updated) console.log(flags.autofix === 'off' ? tl(lang(), '没授权 AI 跟进（--autofix off）：CI 没过、成员要求修改，都先挂事项问你；要授权，在看板任务页「交付的 PR」里点')
      : tl(lang(), '由你授权 AI 跟进这个 PR：CI 没过自动修，最多 2 轮，还没过就问你（不会合并）；有权交付的成员要求修改也直接交给 AI；随时可以在看板任务页「交付的 PR」里收回'));
  }
  else if (r.prSkipped) console.log(tl(lang(), '未开 PR：{why}', { why: dyn(r.prSkipped) }));
  else console.log(tl(lang(), '未开 PR（没给 --pr）。开：node src/cli.mjs deliver {taskId} --pr', { taskId }));
  const so = signoffOf(db, taskId);
  console.log(tl(lang(), '签收：{so}', { so: so ?? tl(lang(), '未签收') }) + (so ? '' : tl(lang(), '  → node src/cli.mjs signoff {taskId} --accept | --reject "<理由>"', { taskId })));
}

function cmdSignoff(db, taskId, flags) {
  const { plaintext, userId } = cliIdentity(db, flags);
  if (!flags.accept && !flags.reject) die(tl(lang(), '要给 --accept 或 --reject "<理由>"'));
  let r;
  try {
    r = signOff(db, { taskId, accept: !!flags.accept, reason: flags.reject === true ? null : flags.reject, plaintextToken: plaintext, userId });
  } catch (e) { die(translateError(e, lang())); }
  if (r.accepted === null) { console.log(tl(lang(), '已记下你的签收意见（事项 {qid}）：{note}', { qid: r.questionId, note: dyn(r.note) })); return; }
  if (r.accepted) console.log(tl(lang(), '已签收 {taskId}（{how}）。高风险任务现在可以开 PR：node src/cli.mjs deliver {taskId} --pr', { taskId, how: dyn(r.how) }));
  else console.log(tl(lang(), '已打回 {taskId}：修正 {mid} 已入 inbox（紧急）。重跑 run 走重规划：node src/cli.mjs run {taskId}', { taskId, mid: r.messageId }));
}

// ── 用户与角色 ────────────────────────────────────────────────────────
// 部署日历：时区、节假日表、接下来与平常不同的日子
function cmdCalendar(db, sub, args, flags) {
  if (!sub || sub === 'show') {
    const cal = calendarOf(db), at = Date.now(), today = dayKey(at, cal.tz);
    const set = !!getSetting(db, 'deploy.timezone');
    console.log(tl(lang(), '部署时区：{tz}{note}；现在 {now}', { tz: cal.tz, note: set ? '' : tl(lang(), '（没设，按 UTC；服务器本机是 {sys}）', { sys: systemTz() }), now: fmtAt(at, cal.tz) }));
    console.log(cal.last ? tl(lang(), '节假日表：{off} 天放假、{on} 天补班，排到 {last}', { off: cal.off.size, on: cal.on.size, last: cal.last }) : tl(lang(), '节假日表：没有（只跳过周末）'));
    const days = Number(flags.days ?? 60);
    for (let i = 0, k = today; i < days; i++, k = addDaysKey(k, 1)) {
      const wd = weekdayOfKey(k), weekend = wd === 0 || wd === 6, work = isBusinessDay(k, cal);
      if (weekend !== work && !cal.names.has(k)) continue;
      console.log(`  ${k}  ${work ? tl(lang(), '上班') : tl(lang(), '放假')}${cal.names.get(k) ? `  ${cal.names.get(k)}` : ''}`);
    }
    return;
  }
  const me = cliIdentity(db, flags);
  if (db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role !== 'lead') die(tl(lang(), '只有管理员能改部署日历'));
  try {
    if (sub === 'tz') { const r = setSetting(db, { key: 'deploy.timezone', value: args[0] === '-' ? '' : String(args[0] ?? die('calendar tz <IANA 时区名 | ->')), userId: me.userId }); console.log(tl(lang(), '部署时区：{tz}', { tz: r.value || 'UTC' })); return; }
    if (sub === 'holidays') {
      const text = typeof flags.file === 'string' ? readFileSync(flags.file, 'utf8') : flags.clear ? '' : die(tl(lang(), 'calendar holidays --file <文件> | --clear   文件一行一条：2026-10-01..2026-10-07 国庆；补班写 2026-10-11 班'));
      setSetting(db, { key: 'deploy.holidays', value: text, userId: me.userId });
      const cal = calendarOf(db);
      console.log(tl(lang(), '节假日表已存：{off} 天放假、{on} 天补班，排到 {last}', { off: cal.off.size, on: cal.on.size, last: cal.last ?? '-' }));
      return;
    }
  } catch (e) { die(translateError(e, lang())); }
  die('calendar [show] [--days 60] | tz <时区 | -> | holidays --file <文件> | --clear');
}

function cmdUser(db, sub, args, flags) {
  if (sub === 'list' || !sub) {
    const cal = dutyCalendarOf(db, '');
    for (const u of usersView(db)) {
      console.log(`  ${u.id}  ${(u.disabledAt ? tl(lang(), '已停用') : u.role).padEnd(8)} ${u.name.padEnd(14)} ${tl(lang(), '标签 {tags}  通道 {channels}  令牌 {token}', { tags: u.tags.join(',') || '-', channels: u.channels.map((c) => `${c.kind}${c.host ? `@${c.host}` : ''}`).join(',') || '-', token: u.tokens ? tl(lang(), '有效') : tl(lang(), '无') })}`);
      if (u.responsibilities.count) console.log(tl(lang(), '      名下：{text}', { text: dyn(u.responsibilities.text) }));
    }
    if (cal) console.log(tl(lang(), '  值班：{users}，起 {start}，每 {days} 天换', { users: cal.users.join(' → '), start: fmtAt(cal.start_at, cal.tz), days: cal.period_days }));
    if (cal?.overrides?.length) for (const o of cal.overrides) console.log(tl(lang(), '    代班：{from} – {to} 由 {user} 值班{note}', { from: o.from, to: o.to, user: o.user, note: o.note ? `（${o.note}）` : '' }));
    return;
  }
  const me = cliIdentity(db, flags);
  const requireLead = () => { if (db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role !== 'lead') die(tl(lang(), '只有管理员能管理成员')); };
  if (sub === 'add') {
    requireLead();
    const name = args[0] ?? die(tl(lang(), 'user add <名字> --role member|observer [--tags a,b] [--out <令牌文件>] | user add <名字> --service [--scope read|write] [--days N]'));
    // 服务账户：不能登录看板、不能当管理员；替人做事时带 x-si-on-behalf-of 头，审计记 on_behalf_of
    const r = flags.service
      ? (() => { try { return addServiceAccount(db, { name, byUserId: me.userId, scope: flags.scope ?? 'write', days: flags.days === undefined ? undefined : Number(flags.days) }); } catch (e) { die(translateError(e, lang())); } })()
      : addUser(db, { name, role: flags.role ?? 'member', tags: String(flags.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean), byUserId: me.userId });
    const out = flags.out ?? join(HOME, 'tokens', `${name}.token`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, r.plaintext, { mode: 0o600 });
    console.log(tl(lang(), '已加用户 {id}（{role}）', { id: r.userId, role: flags.service ? tl(lang(), '服务账户') : (flags.role ?? 'member') }));
    console.log(tl(lang(), '令牌写入 {file}（库里只有哈希，这个文件是唯一副本；交给本人，本人用 --token-file 指向它）', { file: out }));
    return;
  }
  // 每人花费 / 月度预算
  if (sub === 'spend') {
    const s = spendByPerson(db);
    const usd = (m) => `$${(m / 1e6).toFixed(2)}`;
    console.log(tl(lang(), '本月（{month}，{tz}）', { month: s.month, tz: s.tz }));
    const lead = db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role === 'lead';   // 与看板一致：别人只看自己那一行
    for (const r of s.rows.filter((x) => lead || x.userId === me.userId)) console.log(`  ${r.userId}  ${r.name.padEnd(12)} ${usd(r.month).padStart(10)}  ${tl(lang(), '上月 {last}  预算 {budget}', { last: usd(r.lastMonth), budget: r.budget === null ? '-' : usd(r.budget) })}`);
    if (lead) console.log(tl(lang(), '  部署合计 {total}  预算 {budget}', { total: usd(s.deployment.month), budget: s.deployment.budget === null ? '-' : usd(s.deployment.budget) }));
    return;
  }
  if (sub === 'budget') {
    requireLead();
    const id = args[0] ?? die(tl(lang(), 'user budget <id> --usd <每月美元> | --clear（用部署默认）'));
    try { setPersonBudget(db, { userId: id, usd: flags.clear ? null : (flags.usd ?? die(tl(lang(), 'user budget <id> --usd <每月美元> | --clear（用部署默认）'))), byUserId: me.userId }); } catch (e) { die(translateError(e, lang())); }
    console.log(tl(lang(), '已设'));
    return;
  }
  if (sub === 'tags') { requireLead();setUserTags(db, { userId: args[0] ?? die(tl(lang(), '要给用户 id')), tags: String(flags.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean), byUserId: me.userId }); console.log(tl(lang(), '标签已改')); return; }
  if (sub === 'perms') { try { console.log(renderPermissions(permissionsOf(db, args[0] ?? me.userId))); } catch (e) { die(translateError(e, lang())); } return; }
  if (sub === 'setting') {
    // 部署级开关：看 = 所有人；改 = 管理员。
    if (!args[0]) { for (const [k, d] of Object.entries(SETTINGS)) console.log(`${k} = ${getSetting(db, k)}   ${dyn(d.label)}`); return; }
    requireLead();
    // 按设置项的类型解析（原来只认 true / false，枚举和列表类的设置在命令行上改不了）
    const def = SETTINGS[args[0]];
    if (!def || args[1] === undefined) die(tl(lang(), 'user setting <键> <值>（布尔：true / false；整数；枚举取可选值之一；列表用逗号分隔）'));
    const raw = String(args[1]);
    const value = def.type === 'boolean' ? (raw === 'true' ? true : raw === 'false' ? false : raw)
      : def.type === 'int' ? (/^-?\d+$/.test(raw) ? Number(raw) : raw)
        : def.type === 'list' ? raw.split(',').map((x) => x.trim()).filter(Boolean)
          : raw;
    try { const r = setSetting(db, { key: args[0], value, userId: me.userId }); console.log(`${r.key} = ${JSON.stringify(r.value)}`); } catch (e) { die(translateError(e, lang())); }
    return;
  }
  // 自己的时区（只影响给自己看的时刻：看板、摘要）；- 清掉 = 跟部署时区
  if (sub === 'tz') {
    const z = args[0];
    if (z === undefined) { console.log(tl(lang(), '你的时区：{tz}{own}', { tz: viewerTz(db, me.userId), own: db.one(`SELECT tz FROM users WHERE id=?`, me.userId)?.tz ? '' : tl(lang(), '（跟部署时区）') })); return; }
    if (z !== '-' && !validTz(z)) die(tl(lang(), '不认识的时区：{tz}（应为 IANA 时区名，如 Asia/Shanghai）', { tz: z }));
    updateUser(db, me.userId, { tz: z === '-' ? null : z });
    console.log(tl(lang(), '你的时区：{tz}{own}', { tz: viewerTz(db, me.userId), own: z === '-' ? tl(lang(), '（跟部署时区）') : '' }));
    return;
  }
  if (sub === 'channel') {
    const uid = args[0] ?? die(tl(lang(), 'user channel <用户 id> --ntfy <url> | --feishu <url> | --dingtalk <url> | --wecom <url> | --email <邮箱> | --remove <种类>'));
    if (uid !== me.userId) requireLead();
    try {
      if (flags.remove) { removeUserChannel(db, { userId: uid, kind: String(flags.remove), byUserId: me.userId }); console.log(tl(lang(), '已删 {kind} 通道', { kind: flags.remove })); return; }
      let n = 0;
      for (const k of ['ntfy', 'feishu', 'dingtalk', 'wecom', 'email']) if (flags[k]) { setUserChannel(db, { userId: uid, kind: k, target: String(flags[k]), byUserId: me.userId }); n++; }
      console.log(n ? tl(lang(), '已挂 {n} 条通道（审计只记种类，不记地址）', { n }) : tl(lang(), '没给通道（--ntfy / --feishu / --dingtalk / --wecom / --email；删除用 --remove <种类>）'));
    } catch (e) { die(translateError(e, lang())); }
    return;
  }
  try {
    if (sub === 'role') { requireLead(); const r = setUserRole(db, { userId: args[0] ?? die('user role <id> lead|member|observer'), role: args[1] ?? die(tl(lang(), 'user role <id> lead|member|observer（lead = 管理员）')), byUserId: me.userId }); console.log(r.changed ? tl(lang(), '角色已改为 {role}', { role: r.role }) : tl(lang(), '角色没变')); return; }
    if (sub === 'git') {
      const uid = args[0] ?? die(tl(lang(), 'user git <id> [--github <账号>] [--email <提交邮箱>]   写进提交 trailer 与 PR 溯源表；给 - 清掉'));
      const val = (v) => (v === undefined ? undefined : v === '-' || v === true ? null : String(v));
      if (flags.github === undefined && flags.email === undefined) die(tl(lang(), '要给 --github 或 --email（给 - 清掉）'));
      const r = setGitIdentity(db, { userId: uid, github: val(flags.github), email: val(flags.email), byUserId: me.userId });
      console.log(tl(lang(), '已保存 {name}：GitHub {gh}，提交邮箱 {em}', { name: r.name, gh: r.github ?? (flags.github === undefined ? tl(lang(), '（没改）') : tl(lang(), '（无）')), em: r.email ?? (flags.email === undefined ? tl(lang(), '（没改）') : tl(lang(), '（无）')) }));
      return;
    }
    if (sub === 'rename') { requireLead(); const r = renameUser(db, { userId: args[0] ?? die(tl(lang(), 'user rename <id> <新名字>')), name: args.slice(1).join(' '), byUserId: me.userId }); console.log(r.changed ? tl(lang(), '已改名为 {name}', { name: r.name }) : tl(lang(), '名字没变')); return; }
    if (sub === 'token') {
      const uid = args[0] ?? die(tl(lang(), 'user token <id> [--out <令牌文件>]   重发令牌：旧的立刻失效'));
      if (uid !== me.userId) requireLead();
      const name = db.one(`SELECT display_name FROM users WHERE id=?`, uid)?.display_name ?? die(tl(lang(), '没有这个用户：{id}', { id: uid }));
      // 重发自己的：写回正在用的令牌文件，否则下一条命令就认证不过了
      const out = flags.out ?? (uid === me.userId ? (flags['token-file'] ?? TOKEN_FILE) : join(HOME, 'tokens', `${name}.token`));
      const r = reissueToken(db, { userId: uid, byUserId: me.userId });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, r.plaintext, { mode: 0o600 });
      console.log(tl(lang(), '已重发 {name} 的令牌：吊销旧令牌 {n} 枚，新令牌写入 {file}（库里只有哈希，这个文件是唯一副本）', { name, n: r.revoked, file: out }));
      if (uid === me.userId) console.log(tl(lang(), '这是你自己的令牌：正在运行的看板 / 守护进程还拿着旧的，要重启它们'));
      return;
    }
    if (sub === 'disable') { const r = disableUser(db, { userId: args[0] ?? die('user disable <id>'), byUserId: me.userId }); console.log(tl(lang(), '已停用，吊销令牌 {n} 枚。恢复：user enable <id>，再 user token <id> 重发令牌', { n: r.tokensRevoked })); return; }
    if (sub === 'enable') { enableUser(db, { userId: args[0] ?? die('user enable <id>'), byUserId: me.userId }); console.log(tl(lang(), '已恢复。令牌在停用时已吊销：user token <id> 重发')); return; }
  } catch (e) { die(e.needsHandover ? `${translateError(e, lang())}\n  → node src/cli.mjs handover preview --from ${args[0]} --to ${tl(lang(), '<接手人 id>')} --all --disable` : translateError(e, lang())); }
  die(tl(lang(), 'user 子命令：list | add | tags | perms | setting | channel | git | role | rename | token | disable | enable'));
}

// ── 交接 ────────────────────────────────────────────────────────────────────
async function cmdHandover(db, sub, args, flags) {
  const me = cliIdentity(db, flags);
  const usage = tl(lang(), `handover preview|run --from <id> --to <id> (--project <项目 id> | --solo | --all) [--note "<备注>"] [--disable] [--allow-quorum-drop]
  handover requests | approve <申请 id> [--allow-quorum-drop] | reject <申请 id> [--note] | withdraw <申请 id>
  管理员可直接执行任意交接；项目负责人可直接执行本项目范围内的交接；其余情况 run = 提交申请（项目范围由该项目负责人或管理员批准，其余由管理员批准）；--from 省略 = 自己`);
  try {
    if (sub === 'requests') {
      const rows = listHandoverRequests(db, { status: flags.all ? null : 'open' }).filter((r) => canDecideHandover(db, { byUserId: me.userId, scope: r.scope }) || r.fromUserId === me.userId);
      if (!rows.length) { console.log(tl(lang(), '没有等批准的交接申请')); return; }
      for (const r of rows) {
        console.log(`${r.id}  ${r.status}  ${r.fromName} → ${r.toName}${tl(lang(), '（{scope}{disable}）', { scope: dyn(r.scopeText), disable: r.thenDisable ? tl(lang(), '，交接后停用') : '' })}${r.note ? tl(lang(), '  备注：{note}', { note: r.note }) : ''}`);
        if (r.status === 'open') { try { console.log(renderHandover(previewHandover(db, { fromUserId: r.fromUserId, toUserId: r.toUserId, scope: r.scope, note: null, thenDisable: r.thenDisable, byUserId: me.userId }), lang()).split('\n').map((l) => `    ${l}`).join('\n')); } catch (e) { console.log(tl(lang(), '    现在执行会失败：{err}', { err: translateError(e, lang()) })); } }
      }
      return;
    }
    if (['approve', 'reject', 'withdraw'].includes(sub)) {
      const r = decideHandoverRequest(db, { requestId: args[0] ?? die(usage), decision: sub, byUserId: me.userId, note: flags.note === true ? null : flags.note ?? null, allowQuorumDrop: !!flags['allow-quorum-drop'] });
      console.log({ approved: tl(lang(), '已批准并执行'), rejected: tl(lang(), '已驳回'), withdrawn: tl(lang(), '已撤回') }[r.status]);
      if (r.changes) { console.log(renderHandover(r.changes, lang())); const n = await sendHandoverNotice(db, { changes: r.changes }); console.log(n.sent ? tl(lang(), '已通知接手人') : tl(lang(), '接手人没有配通知通道，请当面告知')); }
      return;
    }
    if (sub !== 'preview' && sub !== 'run') die(usage);
    const scope = flags.project ? { project: String(flags.project) } : flags.solo ? { soloTasks: true } : flags.all ? { all: true } : die(`${tl(lang(), '要给范围：--project <项目 id> | --solo | --all')}\n${usage}`);
    const o = { fromUserId: flags.from ? String(flags.from) : me.userId, toUserId: flags.to ? String(flags.to) : die(usage), scope, note: flags.note === true ? null : flags.note ?? null, thenDisable: !!flags.disable, byUserId: me.userId };
    if (sub === 'preview') {
      const pv = previewHandover(db, o);
      console.log(renderHandover(pv, lang()));
      console.log(pv.empty ? '' : tl(lang(), '\n（预览，什么都没改）执行：同样的参数把 preview 换成 run') + (pv.needsQuorumConfirm ? ' --allow-quorum-drop' : '') + (pv.needsApproval ? tl(lang(), '；run 会提交申请，等{approver}批准', { approver: dyn(pv.approver) }) : ''));
      return;
    }
    if (!canDecideHandover(db, { byUserId: me.userId, scope })) {
      const r = requestHandover(db, o);
      console.log(renderHandover(r.preview, lang()));
      console.log(tl(lang(), '\n已提交交接申请 {id}，等{approver}批准（批准前什么都不会改）。撤回：node src/cli.mjs handover withdraw {id}', { id: r.requestId, approver: dyn(r.preview.approver) }));
      return;
    }
    const ch = executeHandover(db, { ...o, allowQuorumDrop: !!flags['allow-quorum-drop'] });
    console.log(renderHandover(ch, lang()));
    const n = await sendHandoverNotice(db, { changes: ch });
    console.log(tl(lang(), '\n已执行。') + (n.sent ? tl(lang(), '已通知接手人') : tl(lang(), '接手人没有配通知通道，请当面告知')));
  } catch (e) { die(translateError(e, lang())); }
}

// ── 路由表：看 / 选模板 / 两旋钮 / 值班 / 预演 / 整表导入导出 ─────────
/**
 * skill。部署级：管理员装 / 卸 / 停（对所有项目）；项目级：该项目的负责人（或管理员）装 / 卸 / 停 / 开。
 * 宿主上的 skill 只能经命令行装（看板只能看与开关）：装 = 把含 SKILL.md 的目录复制进数据目录，装之前先校验。
 */
function cmdSkill(db, sub, args, flags) {
  const pid = flags.project ? String(flags.project) : null;
  if (pid && !db.one(`SELECT 1 FROM projects WHERE id=?`, pid)) die(tl(lang(), '项目不存在：{id}', { id: pid }));
  const LAYER = { deploy: tl(lang(), '部署'), project: tl(lang(), '项目'), repo: tl(lang(), '仓库') };
  const msg = (w) => tl(lang(), w.msg, w.params);
  if (!sub || sub === 'list') {
    const rows = listSkills(db, { projectId: pid });
    if (!rows.length) { console.log(tl(lang(), '（还没有 skill）')); return; }
    for (const r of rows) {
      const state = r.error ? tl(lang(), '用不了') : r.shadowedBy ? tl(lang(), '被 {id} 顶掉', { id: r.shadowedBy }) : r.offBy === 'deploy' ? tl(lang(), '管理员停用') : r.offBy === 'project' ? tl(lang(), '本项目停用') : tl(lang(), '可用');
      console.log(`  ${r.id.padEnd(28)} ${LAYER[r.layer].padEnd(4)} ${state}  ${(r.description || '').slice(0, 70)}`);
      for (const w of [...(r.error ? [r.error] : []), ...r.warnings]) console.log(`      ⚠ ${msg(w)}`);
    }
    if (!pid) console.log(tl(lang(), '  （仓库里的 skill 按项目列：加 --project <id>）'));
    return;
  }
  const me = cliIdentity(db, flags);
  const admin = db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role === 'lead';
  const owner = pid ? db.one(`SELECT owner_id FROM projects WHERE id=?`, pid)?.owner_id === me.userId : false;
  if (pid ? !(owner || admin) : !admin) die(pid ? tl(lang(), '只有这个项目的负责人或管理员能改它的 skill') : tl(lang(), '只有管理员能改部署级的 skill'));
  try {
    if (sub === 'add') {
      const r = installSkill(db, { src: args[0] ?? die(tl(lang(), '要给含 SKILL.md 的目录')), projectId: pid, userId: me.userId });
      console.log(tl(lang(), '装好了 {name} → {where}', { name: r.name, where: r.where }));
      for (const w of r.warnings) console.log(`  ⚠ ${msg(w)}`);
      return;
    }
    if (sub === 'remove') { removeSkill(db, { name: args[0], projectId: pid, userId: me.userId }); console.log(tl(lang(), '卸掉了 {name}', { name: args[0] })); return; }
    if (sub === 'off' || sub === 'on') {
      const id = String(args[0] ?? die(tl(lang(), '要给 <层>:<名字>（层：{layers}；名字可以是 * 表示整层）', { layers: SKILL_LAYERS.join(' / ') })));
      if (pid) setProjectSkill(db, { projectId: pid, id, enabled: sub === 'on', userId: me.userId });
      else {
        const cur = new Set(getSetting(db, 'deploy.skills_off') ?? []);
        if (!/^(deploy|project|repo):[A-Za-z0-9._*-]{1,64}$/.test(id)) die(tl(lang(), 'skill 标识不对：{id}', { id }));
        if (sub === 'on') cur.delete(id); else cur.add(id);
        setSetting(db, { key: 'deploy.skills_off', value: [...cur].sort(), userId: me.userId });
      }
      console.log(sub === 'on' ? tl(lang(), '已启用 {id}', { id }) : tl(lang(), '已停用 {id}', { id }));
      return;
    }
  } catch (e) { die(e.message); }
  die('skill list | add <目录> | remove <名字> | off|on <层>:<名字>   [--project <id>]');
}

/**
 * 策略钩子。宿主钩子写在 <数据目录>/hooks.json（部署）与 <数据目录>/projects/<id>/hooks.json（项目），只有操作人改得了；
 * 按内容 hash 信任：list 看哪些还没信任 / 内容变了，trust 记下当前内容（部署：管理员；项目：负责人或管理员）。
 * 仓库钩子（.superintern/hooks.json、.claude/settings.json）不用信任：只在沙箱里跑。list --project 一并列出来。
 */
function cmdHook(db, sub, args, flags) {
  const pid = flags.project ? String(flags.project) : null;
  const p = pid ? db.one(`SELECT id, repo, branch, owner_id FROM projects WHERE id=?`, pid) : null;
  if (pid && !p) die(tl(lang(), '项目不存在：{id}', { id: pid }));
  const msg = (w) => tl(lang(), w.msg, w.params);
  if (!sub || sub === 'list') {
    const h = hostHooks(db, { projectId: pid });
    console.log(tl(lang(), '宿主钩子：{file}', { file: deployHooksFile() }) + (pid ? `、${projectHooksFile(db, pid)}` : ''));
    if (!h.entries.length) console.log(tl(lang(), '  （没有）'));
    for (const e of h.entries) console.log(`  ${e.trusted ? '✓' : '✗'} ${e.id}\n      ${e.event}${e.matcher ? ` [${e.matcher}]` : ''}  ${e.command}${e.trusted ? '' : `\n      ${tl(lang(), '没核准过或核准后内容变了：不会跑。看过没问题再 hook trust 核准')}`}`);
    if (p) {
      const r = repoHooks(p.repo, p.branch);
      console.log(tl(lang(), '仓库钩子（项目分支 {branch}，只在沙箱里跑）：', { branch: p.branch }));
      if (!r.entries.length) console.log(tl(lang(), '  （没有）'));
      for (const e of r.entries) console.log(`  · ${e.id}\n      ${e.event}${e.matcher ? ` [${e.matcher}]` : ''}  ${e.command}`);
      for (const w of r.warnings) console.log(`  ⚠ ${msg(w)}`);
    }
    for (const w of h.warnings) console.log(`  ⚠ ${msg(w)}`);
    return;
  }
  if (sub === 'trust') {
    const me = cliIdentity(db, flags);
    const admin = db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role === 'lead';
    if (pid ? !(admin || p.owner_id === me.userId) : !admin) die(pid ? tl(lang(), '只有这个项目的负责人或管理员能核准它的宿主钩子') : tl(lang(), '只有管理员能核准部署级的宿主钩子'));
    const ids = [].concat(flags.id ?? []).map(String);
    try {
      const done = trustHostHooks(db, { projectId: pid, ids: ids.length ? ids : null, userId: me.userId });
      for (const id of done) console.log(tl(lang(), '已核准 {id}', { id }));
    } catch (e) { die(e.message); }
    return;
  }
  die('hook list | trust [--id <钩子 id>]...   [--project <id>]');
}

/**
 * MCP。server 配置在 <数据目录>/mcp.json（部署）、<数据目录>/projects/<id>/mcp.json（项目）与仓库的 .mcp.json；
 * 批准按项目：check 在沙箱里把 server 起一遍、记下工具清单 → 负责人看过 → approve 记下指纹。之后命令或工具清单一变就不给 AI 用，要重新 check + approve。
 * 每个工具的用法：ask（默认，每次调用问人）/ auto（直接用）/ off（不给 AI）。
 */
async function cmdMcp(db, sub, args, flags) {
  const pid = flags.project ? String(flags.project) : null;
  if (!pid) die(tl(lang(), 'MCP 按项目批准：要给 --project <id>'));
  const p = db.one(`SELECT id, owner_id FROM projects WHERE id=?`, pid);
  if (!p) die(tl(lang(), '项目不存在：{id}', { id: pid }));
  const msg = (w) => tl(lang(), w.msg, w.params);
  const STATUS = { approved: () => tl(lang(), '已批准'), changed: () => tl(lang(), '批准之后变了，没给 AI 用：重新 check 看过再 approve'), new: () => tl(lang(), '看过、还没批准'),
    unchecked: () => tl(lang(), '还没看过：先 mcp check'), error: () => tl(lang(), '看的时候起不来'), off: () => tl(lang(), '负责人停用了（mcp on 重新启用）') };
  const lead = () => {
    const me = cliIdentity(db, flags);
    const admin = db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role === 'lead';
    if (!(admin || p.owner_id === me.userId)) die(tl(lang(), '只有这个项目的负责人或管理员能批准 MCP server、改工具用法'));
    return me;
  };
  const show = () => {
    const o = mcpOverview(db, { projectId: pid });
    if (!o.servers.length) console.log(tl(lang(), '没有配置 MCP server（{a}、{b}、仓库的 .mcp.json）', { a: deployMcpFile(), b: projectMcpFile(db, pid) }));
    for (const s of o.servers) {
      console.log(`${s.status === 'approved' ? '✓' : '✗'} ${s.id}  ${s.url ?? s.command}\n    ${STATUS[s.status]()}${s.status === 'error' && s.error ? `${tl(lang(), '：')}${typeof s.error === 'string' ? s.error : msg(s.error)}` : ''}${s.checkedAt ? `  ${tl(lang(), '（{at} 看过，协议 {p}）', { at: s.checkedAt, p: s.protocol ?? '?' })}` : ''}`);
      for (const w of s.warnings) console.log(`    ⚠ ${msg(w)}`);
      for (const c of s.changes) console.log(`    ~ ${c.kind} ${c.name}${c.before ? `\n        ${tl(lang(), '批准时：')}${String(c.before.description ?? '').replace(/\s+/g, ' ').slice(0, 300)}` : ''}${c.after ? `\n        ${tl(lang(), '现在：')}${String(c.after.description ?? '').replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
      for (const t of s.tools) console.log(`    [${t.mode}] ${t.full}\n        ${String(t.description ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    for (const x of o.sources) for (const w of x.warnings) console.log(`  ⚠ ${msg(w)}`);
  };
  if (!sub || sub === 'list') return show();
  if (sub === 'check') {
    const me = lead();
    try { await checkProject(db, { projectId: pid, home: HOME, userId: me.userId }); } catch (e) { die(translateError(e, lang())); }
    show();
    console.log(tl(lang(), '看过工具说明没问题，用 mcp approve --project {id} 批准（可加 --server <名字> 只批一个）', { id: pid }));
    return;
  }
  if (sub === 'approve') {
    const me = lead();
    const ids = [].concat(flags.server ?? []).map(String);
    try { for (const id of approveServers(db, { projectId: pid, ids: ids.length ? ids : null, userId: me.userId })) console.log(tl(lang(), '已批准 {id}', { id })); } catch (e) { die(translateError(e, lang())); }
    return;
  }
  if (sub === 'off' || sub === 'on') {
    const me = lead();
    const ids = [].concat(flags.server ?? []).map(String);
    if (ids.length !== 1) die(tl(lang(), '要给一个 --server <server id>（形如 repo:docs，见 mcp list）'));
    setServerOff(db, { projectId: pid, id: ids[0], off: sub === 'off', userId: me.userId });
    console.log(sub === 'off' ? tl(lang(), '已停用 {id}：AI 拿不到它的工具', { id: ids[0] }) : tl(lang(), '已重新启用 {id}：还要是批准过的那一版才给 AI', { id: ids[0] }));
    return;
  }
  if (sub === 'tool') {
    const me = lead();
    const [tool, mode] = args;
    try { setToolMode(db, { projectId: pid, tool, mode, userId: me.userId }); } catch (e) { die(translateError(e, lang())); }
    console.log(tl(lang(), '{tool} → {mode}（之后开始的步骤生效）', { tool, mode }));
    return;
  }
  die('mcp list | check | approve [--server <名字>]... | off|on --server <id> | tool <mcp__…> auto|ask|off   --project <id>');
}

function cmdRouting(db, sub, args, flags) {
  const key = flags.project ? String(flags.project) : '';
  const label = key || tl(lang(), '（默认表：不属于项目的任务）');
  const none = () => tl(lang(), '（无）');
  const renderRows = (rows) => {
    console.log(`  ${tl(lang(), '类型').padEnd(6)} ${tl(lang(), '范围').padEnd(12)} # ${tl(lang(), '收件人').padEnd(34)} ${tl(lang(), '人数  冲突    超时')}`);
    for (const r of rows) console.log(`  ${dyn(DECISION_TYPES[r.decision_type]?.label ?? r.decision_type).padEnd(6)} ${r.scope.padEnd(12)} ${r.position} ${r.recipients.join(' ').padEnd(34)} ${String(r.quorum).padEnd(5)} ${r.conflict_policy.padEnd(7)} ${r.timeout_action}${r.timeout_after ? ` ${r.timeout_after}` : ''}`);
  };
  if (sub === 'show' || !sub) {
    const prof = profileOf(db, key);
    const k = knobsOf(db, key);
    console.log(tl(lang(), '路由表 {label}：模板 {tpl}', { label, tpl: prof.template ?? 'solo' }) + (prof.updated_at ? '' : tl(lang(), '（未保存过，按 solo 即时解析）')) + tl(lang(), '；负责人 {lead}', { lead: k.lead }));
    renderRows(rulesOf(db, key));
    console.log(tl(lang(), '  介入者：{list}', { list: k.interveners.join(tl(lang(), '、')) || none() }));
    const d = diffFromTemplate(db, key);
    if (d.added.length || d.removed.length || d.changed.length) console.log(tl(lang(), '  与模板 {tpl} 的差异：新增 {a} 行，删去 {r} 行，改动 {c} 行（routing reset 可回到模板）', { tpl: d.template, a: d.added.length, r: d.removed.length, c: d.changed.length }));
    return;
  }
  if (sub === 'templates') { for (const [n, t] of Object.entries(loadTemplates())) console.log(`  ${n.padEnd(12)} ${dyn(t.label).padEnd(8)} ${dyn(t.summary)}${Object.keys(t.placeholders ?? {}).length ? tl(lang(), '  需指定：{list}', { list: Object.entries(t.placeholders).map(([p, d]) => `${p}=${dyn(d)}`).join(' ') }) : ''}`); return; }
  if (sub === 'preview') {
    const rules = flags.template ? loadTemplates()[String(flags.template)]?.rows ?? die(tl(lang(), '没有这个模板')) : rulesOf(db, key);
    const pv = previewRouting(db, { key, rules });
    console.log(tl(lang(), '按{what}回放 {n} 条历史事项：', { what: flags.template ? tl(lang(), '模板 {name}', { name: flags.template }) : tl(lang(), '当前表'), n: pv.questions }));
    for (const [u, n] of Object.entries(pv.interruptions)) console.log(tl(lang(), '  {u} 会被打断 {n} 次', { u, n }) + (pv.level3To[u] ? tl(lang(), '（其中 Ⅲ 级 {n} 次）', { n: pv.level3To[u] }) : ''));
    console.log(tl(lang(), '  落空（没人接）：{n} 条', { n: pv.unaddressed.length }) + (pv.unaddressed.length ? tl(lang(), '：') + pv.unaddressed.map((q) => q.id).join(tl(lang(), '、')) : '') + tl(lang(), '；会成为冲突事项：{n} 条', { n: pv.conflicts }));
    return;
  }
  const me = cliIdentity(db, flags);
  // 项目的表：该项目的负责人；默认表：任何一个负责人（与看板同一条规矩；按项目交接后负责人不止一个）
  if (key ? me.userId !== leadOfKey(db, key) : db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role !== 'lead') die(key ? tl(lang(), '只有这个项目的负责人能改它的路由表') : tl(lang(), '只有管理员能改默认路由表'));
  try {
    if (sub === 'template' || sub === 'reset') {
      const name = sub === 'reset' ? (profileOf(db, key).template ?? 'solo') : (args[0] ?? die(tl(lang(), 'routing template <名字> [--set pm=u_x --set tl=u_y]')));
      const bindings = sub === 'reset' ? JSON.parse(profileOf(db, key).bindings || '{}') : Object.fromEntries(list(flags.set).map((s) => String(s).split('=')));
      applyTemplate(db, { key, name, bindings, userId: me.userId });
      console.log(tl(lang(), '已按模板 {name} 写入 {label}', { name, label })); renderRows(rulesOf(db, key)); return;
    }
    if (sub === 'owner') {
      const type = args[0]; const recips = args.slice(1);
      if (!DECISION_TYPES[type] || !recips.length) die(tl(lang(), 'routing owner <类型> <解析器>...   类型：{types}；解析器：user:<id> user:lead group:<标签> group:* on_duty inform:<解析器>', { types: Object.keys(DECISION_TYPES).join(' / ') }));
      const k = setKnobs(db, { key, ownership: { [type]: recips }, userId: me.userId });
      console.log(tl(lang(), '{type} 归属改为 {recips}；介入者现为 {list}', { type: dyn(DECISION_TYPES[type].label), recips: recips.join(' '), list: k.interveners.join(tl(lang(), '、')) || none() })); return;
    }
    if (sub === 'remove') { const k = setKnobs(db, { key, removeInterveners: [args[0] ?? die(tl(lang(), '要给用户 id'))], userId: me.userId }); console.log(tl(lang(), '已从所有行去掉；介入者现为 {list}', { list: k.interveners.join(tl(lang(), '、')) || none() })); return; }
    if (sub === 'duty') {
      const users = String(flags.users ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      // 起点按部署时区读：2026-09-21（当天 0 点）或 2026-09-21T09:00（那天 9 点换班）
      const m = flags.start ? /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}))?$/.exec(String(flags.start).trim()) : null;
      if (!users.length || (flags.start && !m)) die('routing duty --users u_a,u_b --start 2026-09-21[T09:00] [--period 7]');
      let start; try { start = m ? dutyStartAt(db, m[1], m[2] ?? '00:00') : Date.now(); } catch (e) { die(translateError(e, lang())); }
      setDutyCalendar(db, { key, users, startAt: start, periodDays: Number(flags.period ?? 7), userId: me.userId });
      console.log(tl(lang(), '值班日历已存：{users}，每 {days} 天换', { users: users.join(' → '), days: flags.period ?? 7 }));
      console.log(tl(lang(), '  起点 {start}（部署时区 {tz}）', { start: fmtAt(start, deployTz(db)), tz: deployTz(db) })); return;
    }
    // 换班：routing swap list | add <日期>[..<日期>] <成员 id> [--note 说明] | remove <序号> | clear
    if (sub === 'swap') {
      const cal = dutyCalendarOf(db, key) ?? die(tl(lang(), '还没有值班表：先设轮换名单与起点，再加代班'));
      // 每条写出替的是谁（那几天按轮换本来该谁）：只列规则看不出"写着张三出差、其实那几天轮到李四"
      const nameOf = (id) => db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id;
      const show = () => {
        const xs = dutyCalendarOf(db, key).overrides, v = dutyView(db, key);
        if (!xs.length) console.log(tl(lang(), '  没有代班'));
        xs.forEach((o, i) => {
          const was = (v.covers[i] ?? []).filter((u) => u !== o.user);
          console.log(`  ${i + 1}. ${o.from} – ${o.to}  ${nameOf(o.user)} (${o.user})${was.length ? tl(lang(), '，替 {names}', { names: was.map(nameOf).join(tl(lang(), '、')) }) : tl(lang(), '，那几天本来就轮到他')}${o.note ? `  ${o.note}` : ''}`);
        });
        console.log(tl(lang(), '  此刻值班：{name}', { name: nameOf(v.now.user) }));
      };
      const act = args[0] ?? 'list';
      let next = cal.overrides;
      if (act === 'list') { show(); return; }
      if (act === 'add') {
        const r = /^(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/.exec(String(args[1] ?? ''));
        if (!r || !args[2]) die('routing swap add 2026-10-03[..2026-10-04] <成员 id> [--note 说明]');
        next = [...next, { from: r[1], to: r[2] ?? r[1], user: args[2], ...(flags.note ? { note: String(flags.note) } : {}) }];
      } else if (act === 'remove') {
        const i = Number(args[1]) - 1;
        if (!(i >= 0 && i < next.length)) die(tl(lang(), '没有第 {n} 条代班', { n: args[1] ?? '?' }));
        next = next.filter((_, j) => j !== i);
      } else if (act === 'clear') next = [];
      else die('routing swap list | add <日期>[..<日期>] <成员 id> [--note 说明] | remove <序号> | clear');
      try { setDutyOverrides(db, { key, overrides: next, userId: me.userId }); show(); } catch (e) { die(translateError(e, lang())); }
      return;
    }
    if (sub === 'export') { const f = flags.file ?? die(tl(lang(), '--file <路径>')); writeFileSync(f, JSON.stringify(rulesOf(db, key).map(({ id, project_id, template, created_at, ...r }) => r), null, 2)); console.log(tl(lang(), '已导出 {f}', { f })); return; }
    if (sub === 'import') {
      const f = flags.file ?? die(tl(lang(), '--file <路径>'));
      const rows = JSON.parse(readFileSync(f, 'utf8'));
      const errs = validateRules(db, key, rows);
      if (errs.length) die(tl(lang(), '路由表没存：\n{errs}', { errs: errs.map((e) => `  - ${dyn(e.msg)}`).join('\n') }));
      const pv = previewRouting(db, { key, rules: rows });
      saveRules(db, { key, rules: rows, template: profileOf(db, key).template, bindings: JSON.parse(profileOf(db, key).bindings || '{}'), userId: me.userId });
      console.log(tl(lang(), '已存 {n} 行；按它回放 {q} 条历史事项：落空 {u} 条，打断 {i}', { n: rows.length, q: pv.questions, u: pv.unaddressed.length, i: Object.entries(pv.interruptions).map(([u, n]) => `${u}×${n}`).join(' ') || tl(lang(), '无') })); return;
    }
  } catch (e) { die(translateError(e, lang())); }
  die(tl(lang(), 'routing 子命令：show | templates | template <名> | reset | owner <类型> <解析器>... | remove <用户> | duty | swap | preview [--template 名] | export --file | import --file'));
}

function cmdQuestion(db, sub, args, flags) {
  if (sub !== 'transfer') die(tl(lang(), 'question 子命令：transfer <问题 id> --to user:<id> [--to group:<标签>]'));
  const me = cliIdentity(db, flags);
  const to = list(flags.to).map(String);
  if (!to.length) die(tl(lang(), '要给 --to'));
  try {
    const r = transferQuestion(db, { questionId: args[0] ?? die(tl(lang(), '要给问题 id')), to, reason: flags.reason ?? null, byUserId: me.userId });
    console.log(tl(lang(), '已转交：{from} → {to}', { from: r.from.join(tl(lang(), '、')) || tl(lang(), '（无）'), to: r.to.join(tl(lang(), '、')) }));
  } catch (e) { die(translateError(e, lang())); }
}

function cmdShow(db, taskId) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId) ?? die(tl(lang(), '没有这个任务：{id}', { id: taskId }));
  const c = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL
                    ORDER BY version DESC LIMIT 1`, taskId);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${task.title}\n${task.id}  status=${task.status}  ${tl(lang(), '宪法块 v{version}', { version: String(c?.version) })}`);
  console.log('='.repeat(72));

  const nodes = db.all(`SELECT * FROM nodes WHERE task_id=? ORDER BY created_at, id`, taskId);
  const deps = db.all(`SELECT from_id, to_id FROM edges WHERE relation='depends_on'
                       AND from_id IN (SELECT id FROM nodes WHERE task_id=?)`, taskId);
  const short = new Map(nodes.map((n, i) => [n.id, `n${i + 1}`]));
  for (const n of nodes) {
    const d = deps.filter((e) => e.from_id === n.id).map((e) => short.get(e.to_id));
    console.log(`\n[${short.get(n.id)}] ${n.title}`);
    console.log(`     ${n.status} · risk=${n.risk_tier} · tier=${n.model_tier}` +
      (d.length ? tl(lang(), ' · 依赖 {deps}', { deps: d.join(', ') }) : tl(lang(), ' · 无依赖')));
    console.log(`     spec: ${n.spec.replace(/\n/g, '\n           ')}`);
    console.log(`     ${tl(lang(), '验收: {a}', { a: n.acceptance.replace(/\n/g, '\n           ') })}`);
    const h = db.one(`SELECT * FROM handoffs WHERE node_id=? AND validated_at IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`, n.id);
    if (h) {
      console.log(`     ${tl(lang(), '交接 {id}：{files}', { id: h.id, files: JSON.parse(h.artifacts).map((a) => a.path).join(tl(lang(), '、')) })}`);
      console.log(`           ${tl(lang(), '契约 {c}', { c: h.interface_contract.slice(0, 120) })}`);
      console.log(`           ${tl(lang(), '叙事 {ref}', { ref: h.narrative_ref })}`);
    }
  }

  // 三层出处闭合的第一层：当时**知道**什么
  const asms = db.all(`SELECT * FROM context_assemblies WHERE id IN (
                         SELECT json_extract(payload,'$.assemblyId') FROM audit_log
                          WHERE action='context_assembled' AND target_id IN
                                (SELECT id FROM nodes WHERE task_id=?)) ORDER BY ts`, taskId);
  if (asms.length) {
    console.log(tl(lang(), '\n上下文装配 {n} 次：', { n: asms.length }));
    for (const a of asms) {
      console.log(`  ${a.id} role=${a.role} recipe=${a.recipe} ${tl(lang(), '宪法v{v}', { v: String(a.constitution_version) })} ` +
        `${a.model_tier} ~${a.token_estimate}tok  ${tl(lang(), '条目 {n} 条', { n: JSON.parse(a.items).length })}`);
    }
  }

  const asm2 = db.all(`SELECT subject_key, statement, status FROM assumptions WHERE task_id=? AND superseded_at IS NULL`, taskId);
  if (asm2.length) {
    console.log(tl(lang(), '\n假设登记表：'));
    for (const a of asm2) console.log(`  [${a.status}] ${a.subject_key}${tl(lang(), '：')}${a.statement.slice(0, 100)}`);
  }

  // 提问与复工。开着的、答过的都列 —— 要能只凭真相源复盘，
  // 只显示"还开着的"等于把已经发生过的挂起从历史里抹掉。
  const qs = db.all(`SELECT * FROM questions WHERE task_id=? ORDER BY asked_at`, taskId);
  for (const q of qs) {
    console.log(tl(lang(), '\n[?] 第 {level} 级问题 {id}  status={status}', { level: q.level, id: q.id, status: q.status }));
    console.log(`     ${q.text.replace(/\n/g, '\n     ')}`);
    console.log(`     ${q.default_action ? tl(lang(), '默认动作：{a}', { a: q.default_action }) : tl(lang(), '无默认动作（Ⅲ 级则为库层强制）')}`);
    const b = db.one(`SELECT * FROM briefings WHERE question_id=? AND superseded_at IS NULL`, q.id);
    if (b) {
      console.log(`     ${tl(lang(), '复工简报 {id}', { id: b.id })}${b.context_tokens ? tl(lang(), '（挂起时上下文 {n} token，已丢弃）', { n: b.context_tokens }) : ''}`);
      console.log(`       ${tl(lang(), '做到哪：{s}', { s: b.work_done.replace(/\n/g, ' ').slice(0, 160) })}`);
      console.log(`       ${tl(lang(), '获答计划：{s}', { s: b.plan_after.replace(/\n/g, ' ').slice(0, 160) })}`);
    }
    const a = db.one(`SELECT m.*, u.display_name FROM edges e JOIN messages m ON m.id=e.from_id
                      LEFT JOIN users u ON u.id=m.sender_id
                      WHERE e.to_id=? AND e.relation='answers'`, q.id);
    if (a) {
      console.log(`     ${tl(lang(), '答复 {id} by {who}', { id: a.id, who: a.display_name ?? a.sender_id })}｜${a.trust_label}｜token ${a.token_id}`);
      console.log(`       ${a.body.replace(/\n/g, '\n       ').slice(0, 400)}`);
    }
  }

  const ps = db.all(`SELECT * FROM params WHERE task_id=? AND superseded_at IS NULL`, taskId);
  if (ps.length) {
    console.log(tl(lang(), '\n任务参数：'));
    for (const p of ps) console.log(`  ${p.key} = ${p.value}  [${p.governance_class}/${tl(lang(), '由 {kind} 设置', { kind: p.set_by_kind })}]`);
  }

  const spend = taskSpendMicroUsd(db, taskId);
  const calls = db.all(`SELECT role, model_id, model_tier, input_tokens, cache_read_tokens,
                               cache_write_tokens, output_tokens, reasoning_tokens, micro_usd, billing
                        FROM usage_ledger WHERE task_id=? ORDER BY ts`, taskId);
  console.log(tl(lang(), '\n花费 {usd}（{n} 次调用）', { usd: fmtUsd(spend), n: calls.length }));
  for (const r of calls) {
    console.log(`  ${r.role.padEnd(9)} ${r.model_id.padEnd(30)} in=${r.input_tokens} ` +
      `cr=${r.cache_read_tokens} cw=${r.cache_write_tokens} out=${r.output_tokens} ` +
      `think=${r.reasoning_tokens} ${fmtUsd(r.micro_usd)} [${r.billing}]`);
  }

  const audits = db.all(`SELECT ts,actor_kind,actor_id,action,payload FROM audit_log
                         WHERE target_id=? OR target_id IN (SELECT id FROM nodes WHERE task_id=?)
                         ORDER BY id`, taskId, taskId);
  console.log(tl(lang(), '\n审计轨 {n} 条：', { n: audits.length }));
  for (const a of audits) {
    const p = JSON.parse(a.payload);
    const note = a.action === 'plan_attempt'
      ? ` attempt=${p.attempt} accepted=${p.accepted}${p.accepted ? '' : ` ← ${p.rejections.join(tl(lang(), '；'))}`}`
      : '';
    console.log(`  ${when(db, a.ts, { seconds: true })} ${a.actor_kind}/${a.actor_id ?? '-'} ${a.action}${note}`);
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return 'dev'; } })();
// 用法说明整段一个键（英文在 i18n/en/cli.mjs）。库还没打开时 lang() 只看 SI_LANG。
const usage = () => tl(lang(), `superintern {version} —— 服务端长期运行的自主编码 agent（人只答题 / 取舍 / 提变更 / 叫停）

  node src/cli.mjs decisions <项目 id|任务 id> [--all] [--void <决定 id> "理由"]   # 决定登记：此刻仍然有效的约定清单（有结论的事项 / 批准过的契约与变更 / 改过的目标）
  node src/cli.mjs stalls [--raise]                          # 停等账本：每个没结束的任务在等谁（自己 / 时钟 / 某个人 / 上游）；⚠ 那几行是说不出在等谁的缺陷，--raise 升成事项
  node src/cli.mjs digest [--user <id|名字>] [--send]        # 我的待办打包：等我答的 / 等冲突结论的 / 等别人的 / 知会我的；负责人另见没人接的、任务状态、未读汇报、异议
  node src/cli.mjs report [--since 24h|7d|<日期>] [--detail exceptions|summary|full] [--all] [--user <id|名字>]   # 状态报告：这段时间出事了没有、系统替你定了什么、进展、花费
  node src/cli.mjs catalog check [--probe] [--vision] [--vendor <id>] | last # 模型目录漂移：还在不在、能不能调（--probe 花极少的钱）、单价与窗口对不对；只报告，目录由人改
  node src/cli.mjs endpoint [list] | set <id> --adapter … --base-url … --key-env … | enable|disable|remove|test|models <id>   # 服务商（直连厂商 / 聚合平台）；key 只在 .env
  node src/cli.mjs catalog [list] | add|set <服务商/模型> --input <$/M> --output <$/M> [--window N] [--efforts …] | remove|enable|disable <键>   # 模型目录（缺单价不能绑）
  node src/cli.mjs bind [show] | bind set <tier>=<服务商/模型>... [--effort low|medium|high|none]   # 档位绑定（进库、记审计；下一个节点起生效）
  node src/cli.mjs bind role <角色> <服务商/模型 | tier> [--effort low|medium|high] | bind fallback <tier>=<服务商/模型 | none>   # 某个角色单独绑模型（tier = 回到档位）；档位的备用模型（那家出故障时自动换过去）
  node src/cli.mjs init [--name <管理员显示名>] [--bind <tier>=<服务商/模型>]...     # 库已存在时 --name 改显示名；首装时 --bind 写默认绑定
  node src/cli.mjs new "<标题>" --goal <目标> --dod <完成定义> [--scope <范围>]
                                [--constraint <约束>]... [--verify "<任务级验收命令>"]
  node src/cli.mjs new --file <task.json>
  node src/cli.mjs plan <taskId> [--tier light|standard|heavy] [--attempts N] [--force] [--bind <tier>=<服务商/模型>]...   # --bind 只覆盖本次进程；常态用 bind set
  node src/cli.mjs workspace <taskId> [--source <repo>] [--dir <路径>] [--ref <commit>] [--force]
  node src/cli.mjs run <taskId> [--cycles N] [--once] [--tier ...] [--iterations N]
                                [--no-commit] [--no-verify] [--no-sandbox]
  node src/cli.mjs revision <taskId> [--approve | --redo "要怎么改" | --reject] [--reservation "批了，但这一条我保留意见：…"]
  node src/cli.mjs rewind <taskId> <步骤 id> [--note "这次要注意什么"] [--yes]   从做完的某一步重来：先看会退回哪些步骤，加 --yes 才生效
  node src/cli.mjs sandbox [--reap] [--task <taskId>]
  node src/cli.mjs sources [add|remove]                      联网目录（管理员）：内置 5 个软件源，可加镜像 / 私有仓库 / 可信的信息源
  node src/cli.mjs sources cred add <源 id> (--key-file <文件> | --stdin) [--basic] [--allow-write] | revoke <凭据 id>   联网源的凭据：只进出网代理、沙箱看不到，默认只在读请求上带
  node src/cli.mjs project setup <projectId> [--cmd "<命令>"]... [--clear]   环境准备命令：新工作区与项目级验收前自动先跑（装依赖用）
  node src/cli.mjs project egress <projectId> [--add <源>]... [--remove <源>]...   项目联网：从联网目录里勾选，项目下所有任务共用
  node src/cli.mjs egress <taskId> [--allow <源>]... [--deny <源>]...
  node src/cli.mjs new --idea "<一段话>" [<标题>] [--source <现有仓库路径>]   从模糊想法开始：追问器先问、出草案、你批准后自动规划开跑（要开守护进程）
  node src/cli.mjs draft <taskId> [--bind ...]   追问器的一次寿命（守护进程会自动跑；手动也可）
  node src/cli.mjs say <taskId> "<正文>" [--kind instruction|correction|context] [--urgent] [--about <questionId>] [--mode fake --script <响应脚本.json>]
      # 不给 --kind：系统读正文判断是修正（改要做的事）/ 新指令（加一件事）/ 补充信息（不改要做的事），落库标 kind_source=classifier；给了就一字不改
      # --urgent：修正 / 新指令打断正在执行的步骤、马上重规划（不加就等这一步做完）；补充信息加不加都在执行中途送到
  node src/cli.mjs answer <questionId> "<答复>" [--token-file <路径>]   多人时按路由表数人头；立场不同会生成冲突事项
  node src/cli.mjs answer <questionId> --agree [答复 id]                 附议已有的那条（不写新文本，计入法定人数）
  node src/cli.mjs answer <questionId> --abstain ["说明"]                弃权：这条不归我（从收件人里去掉自己，人数重算）
  node src/cli.mjs answer <questionId> "..." --allow-tests              答复并放行这一步对任务开始前就有的测试的改动（questions 里会列出是哪几个）
  node src/cli.mjs question transfer <questionId> --to user:<id> [--reason "..."]   把一条事项转给别人（事项级，不改表；理由会显示给对方）
  node src/cli.mjs user list | add <名字> --role member|observer [--tags a,b] | tags <id> --tags a,b | channel <id> --ntfy <url> | --remove <种类>
  node src/cli.mjs user role <id> lead|member|observer（lead = 管理员）| perms [<id>]（权限一览）| setting [<键> <值>] | rename <id> <新名字> | token <id>（重发令牌）| disable <id> | enable <id>
  node src/cli.mjs user add <名字> --service [--scope read|write] [--days N]   服务账户：不能登录看板，替人做事时审计记 on_behalf_of
  node src/cli.mjs token list [--all] [--everyone] | new <名字> [--scope read|write] [--days N] | revoke <令牌 id> | revoke --all-others   自己的令牌与登录
  node src/cli.mjs invite list | new [--role member|observer] [--name <名字>] [--hours N] [--public-url <看板地址>] | revoke <邀请 id>   邀请链接（管理员）
  node src/cli.mjs cred list | add token|github-app|ssh --name <名字> (--key-file <文件> | --stdin) [--host github.com] [--repos acme/*] [--mine] [--app-id N] | revoke <id> | check <远端>   连接（交付用的凭据）
  node src/cli.mjs user git <id> [--github <账号>] [--email <提交邮箱>]   成员的 GitHub 账号与提交邮箱（写进提交与 PR 的出处；- 清空）
  node src/cli.mjs cred oauth <GitHub App 连接 id> --client-id <id> (--secret-file <文件> | --stdin) | member <GitHub 账号>   用 GitHub 登录
  node src/cli.mjs user spend | budget <id> --usd <美元> | budget <id> --clear   每个人本月 / 上月的花费；单人月度预算
  node src/cli.mjs calendar [--days 60] | tz <时区 | -> | holidays --file <文件> | --clear   部署日历：时区（业务日 / 值班交接 / 月度预算按它算）、节假日与调休
  node src/cli.mjs user tz [<时区> | -]   自己的时区（给你看的时刻、你的工作时间与状态报告的钟点；- = 跟部署时区）
  node src/cli.mjs routing swap list | add <日期>[..<日期>] <成员 id> [--note 说明] | remove <序号> | clear [--project <id>]   值班代班（那几天整天由他值，不管轮换轮到谁）
  node src/cli.mjs trace <文件:行号 | 提交号> [--repo <仓库目录>] [--task <任务 id>]   修改溯源：这行代码 / 这个提交是哪一步做的、依据契约哪几条、谁的指令、谁批准
  node src/cli.mjs handover preview|run --from <id> --to <id> (--project <id> | --solo | --all) [--note ".."] [--disable]   交接；成员 run = 申请
  node src/cli.mjs handover requests | approve|reject|withdraw <申请 id>
  node src/cli.mjs skill list | add <目录> | remove <名字> | off|on <层>:<名字>   [--project <id>]   skill（上下文包）：不带 --project 是部署级（管理员）
  node src/cli.mjs hook list | trust [--id <钩子 id>]...   [--project <id>]   策略钩子：宿主上的（<数据目录>/hooks.json）按内容核准，改了要重新 trust
  node src/cli.mjs mcp list | check | approve [--server <名字>]... | off|on --server <id> | tool <mcp__…> auto|ask|off   --project <id>   MCP server：check 在沙箱里看工具清单，负责人看过再 approve；变了要重新批准
  node src/cli.mjs routing show | templates | template <名> [--set pm=u_x] | reset | owner <类型> <解析器>... | remove <用户> |
                           duty --users u_a,u_b --start 日期[T09:00] | preview [--template 名] | export --file f | import --file f   [--project <id>]
  node src/cli.mjs tick [taskId] [--notify <cmd>]   扫到期的问题：Ⅰ 级走默认 / Ⅱ 级升级或退默认（给 cron 用）
  node src/cli.mjs deliver <taskId> [--remote <url>] [--branch <名>] [--pr] [--base <分支>] [--autofix off] [--hook-ack <确认码>]
  node src/cli.mjs project new --file <项目.json> --source <仓库路径或URL> [--base <ref>]   整批契约建项目（守护进程串着跑）
  node src/cli.mjs project new --brief <规划文本或文件> (--source <仓库> | --empty) [--title <名>] [--visibility all|members]   让规划器切整批契约，人批一次
  node src/cli.mjs project plan <projectId> [--bind …]  规划器的一次寿命（守护进程会自动拉）
  node src/cli.mjs project show <projectId>            各任务状态 / 签收 / 合并
  node src/cli.mjs project advance <projectId>         手动推进一步（没开守护进程时用）
  node src/cli.mjs project budget <projectId> [--usd <美元> | --clear]    项目预算闸（默认不设；撞闸 = 不再开新任务 + 一条 Ⅲ 级事项）
  node src/cli.mjs project verify <projectId> [--cmd "<一条命令>" | --clear]   项目级验收命令（选填；没填时"项目达成"只能由人宣布）
  node src/cli.mjs project gear <projectId> [propose|auto]    自动化挡位；不带参数看当前挡与四条前提各自成不成立
  node src/cli.mjs project limits <projectId> [--key <项> --value <数> | --key <项> --clear]   项目默认上限（部署默认 → 项目默认 → 任务覆盖）
  node src/cli.mjs project sandbox <projectId> [node|python]      沙箱镜像（默认 python = Node + Python 3，带页面点验用的 Chromium；node = 只有 Node，镜像小一些）
  node src/cli.mjs project concurrency <projectId> [--max <1-4>]   同时最多开几个任务（默认 2；只有开着的任务全都在等人时才让路）
  node src/cli.mjs project deliver <projectId> --remote <url> [--pr] [--base <分支>] [--accept-pending] [--hook-ack <确认码>]
  node src/cli.mjs project signoff <projectId> [--accept-all]   后置签收：自动挡下 AI 自己加的任务攒着的签收，看清单 / 一次点掉（交付前必须清掉）
  node src/cli.mjs project issues <projectId> [--repo <owner/repo> --label <标签> | --off]   带这个标签的 GitHub issue 每条起草一轮添加任务（一律要负责人批）；不带参数看现状
  node src/cli.mjs project schedule <projectId> [add --name <名> --cron "<分 时 日 月 星期>" --brief "<要做什么>" | on|off|rm <定时任务 id>]   定时任务：到点起草一轮添加任务（部署时区）；不带参数列出
                                    push 工作区分支；--pr 在 GitHub 开 PR（凭据见 cred；高风险任务先签收）
  node src/cli.mjs signoff <taskId> --accept | --reject "<理由>"   人工签收；打回 = 一条紧急修正
  node src/cli.mjs web [--port 7357] [--daemon]   看板（只绑 127.0.0.1；--daemon 同时带守护进程；不接 --bind —— 子进程自己读库里的绑定，库空时 --bind 写入一次）
  node src/cli.mjs web --team --public-url https://<内网域名> [--host 127.0.0.1] [--daemon]   团队模式：多人各自登录，放在 HTTPS 反向代理之后（docs/deploy-team.md）
  node src/cli.mjs daemon [--interval 15] [--notify <cmd>] [--catalog-check 7d|--no-catalog-check]   守护进程：答完题 / 加额 / 批准后自动拉起 run；含 tick；推送按人排队（工作时间、汇总推送、推送限额见看板「我的通知」），换班时自动给接班人推；--catalog-check 按间隔查模型目录漂移（默认 7d，绑定里出现没查过的模型立刻查）
  node src/cli.mjs show <taskId>
  node src/cli.mjs questions [--all]      列开放 / 已升级的问题（--all 含已答复的最近 20 条）；一眼看有没有人要答
  node src/cli.mjs limit <taskId> [--budget_micro_usd N] [--runtime_ms N] [--llm_calls N]
                                  [--node_retries N] [--idle_cycles N] [--context_tokens N] [--compact_tokens N]
  node src/cli.mjs replay <taskId>
  node src/cli.mjs db backup [--tag <名>] | backups | check [--full] | restore <文件> | stats   备份、恢复、完整性检查、状态库体量
  node src/cli.mjs invariants [--run]   运行期自检：各条最近一次的结果（--run 当场查一遍）

全局：--db <路径>（默认 .superintern/state.db）
      --mode live|record|replay  --cassette <路径>（录制/回放 LLM 调用）
      --mode fake --script <响应脚本.json>（离线跑状态机；**无视上下文**，不验 agent）

run 一次 = 编排器的一次寿命：能推进多少推进多少，遇到挂起就**退出进程**。
恢复不是另一条路径，就是再跑一次 run（统一恢复语义）。

limit 不带参数只看不改。上限是宪法层参数，agent 结构上改不了（库层 CHECK）。
触顶不会静默死掉：状态机会**不调用任何模型**地生成一条 Ⅲ 级问题，任务转 waiting。

replay 只读 audit_log + 状态库重建全过程，不看进程日志、不读叙事正文，
末尾的完整性自检才是判据 —— 能打印出时间线证明不了什么。

run **默认在容器沙箱里**跑命令。
沙箱起不来就报错退出，不会静默退回宿主机裸跑。--no-sandbox 是给离线自测的，
它会打一行警告：那条路上 agent 生成的代码直接落在你的机器上。

出网默认**完全关闭**（--network none，连代理容器都不起）。要放行就按生态加
（egress --allow npm），名单外的域在 CONNECT 阶段即拒、TLS 都不建立，
每一次出网尝试含被拒的都进审计轨。白名单是宪法层参数，agent 结构上改不了。
`, { version: VERSION });

const { flags, positional } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = positional;
if (flags.version || cmd === 'version') { console.log(VERSION); process.exit(0); }
if (!cmd || flags.help) { console.log(usage()); process.exit(0); }
// 这个进程是哪一种（记进花费账本，复盘据此把每笔钱对到进程寿命上；见 core/lifetimes.mjs）。启动器拉起的子进程已经带着
const PROC_OF = { web: 'web', daemon: 'daemon', run: 'run', draft: 'draft', plan: 'plan' };
process.env[PROC_ENV] ||= cmd === 'project' && rest[0] === 'plan' ? 'project-plan' : (PROC_OF[cmd] ?? `cli:${cmd}`);
// 长期运行的进程另写一份 JSON 行日志（见 core/log.mjs）；一次性命令的输出就是给人看的结果，不写
if (['web', 'daemon', 'run', 'draft', 'plan', 'project-plan'].includes(process.env[PROC_ENV])) {
  if (['run', 'draft', 'plan'].includes(cmd) && rest[0]) setLogBase({ task: rest[0] });
  if (cmd === 'project' && rest[1]) setLogBase({ project: rest[1] });
  installLogSink({ home: HOME });
}

const dbPath = flags.db ?? join(HOME, 'state.db');
if (cmd !== 'init' && !existsSync(dbPath) && dbPath !== ':memory:') {
  die(tl(lang(), '状态库不存在：{path}\n先跑 node src/cli.mjs init', { path: dbPath }));
}
const db = openDb(dbPath);
langDb = db;   // 从这里起 lang() 能按令牌身份取界面语言
// 离线场景集：`--mode fake --fake-module <文件>` 载入一个按请求现算回复的假模型。模块默认导出
// ({ db, verb, id, home }) => provider（带 respond，如 makeRoleFake 的返回值）。顺序脚本只够一个进程里的一个角色；
// 场景集要守护进程拉起的每个真 CLI 子进程都按任务、按角色自己出回复 —— 模型之外全走真路径。
const fakeProvider = flags.mode === 'fake' && flags['fake-module']
  ? (await import(pathToFileURL(resolve(String(flags['fake-module']))).href)).default({ db, verb: process.env[PROC_ENV], id: cmd === 'project' ? rest[1] : rest[0], home: HOME })
  : null;

const noTask = () => die(tl(lang(), '要给任务 id'));
try {
  switch (cmd) {
    case 'init': cmdInit(db, flags); break;
    case 'new': cmdNew(db, { flags, positional: rest }); break;
    case 'plan': await cmdPlan(db, rest[0] ?? noTask(), flags); break;
    case 'workspace': cmdWorkspace(db, rest[0] ?? noTask(), flags); break;
    case 'run': await cmdRun(db, rest[0] ?? noTask(), flags); break;
    case 'say': await cmdSay(db, rest[0] ?? noTask(), rest.slice(1).join(' '), flags); break;
    // --allow-tests 是开关：写在正文前面时解析器会把正文当成它的值，这里还回去
    case 'answer': { const at = flags['allow-tests']; if (typeof at === 'string') flags['allow-tests'] = true;
      await cmdAnswer(db, rest[0] ?? die(tl(lang(), '要给问题 id')), [...rest.slice(1), ...(typeof at === 'string' ? [at] : [])].join(' '), flags); break; }
    case 'show': cmdShow(db, rest[0] ?? noTask()); break;
    case 'calendar': cmdCalendar(db, rest[0], rest.slice(1), flags); break;
    case 'trace': {
      // 修改溯源：从代码倒查回人。默认在当前目录的仓库里查（交付出去的仓库的克隆也行，提交信息里带着步骤 id）
      const q = rest[0] ?? die(tl(lang(), 'trace <文件:行号 | 提交号> [--repo <仓库目录>] [--task <任务 id>]   从一行代码 / 一个提交查回：哪一步、依据契约哪几条、谁的指令、谁批准。默认查当前目录的仓库；--task 查某个任务的工作区，--repo 查别的目录'));
      const dir = flags.repo ? String(flags.repo) : flags.task ? join(HOME, 'workspaces', String(flags.task)) : process.cwd();
      try {
        const t = parseTraceQuery(q);
        const r = t.kind === 'commit' ? traceCommit(db, { dir, rev: t.rev }) : traceLine(db, { dir, file: t.file, line: t.line });
        console.log(renderTrace(r, lang()));
      } catch (e) { die(translateError(e, lang())); }
      break;
    }
    case 'user': cmdUser(db, rest[0], rest.slice(1), flags); break;
    case 'token': cmdToken(db, rest[0], rest.slice(1), flags); break;
    case 'invite': cmdInvite(db, rest[0], rest.slice(1), flags); break;
    case 'cred': await cmdCred(db, rest[0], rest.slice(1), flags); break;
    case 'routing': cmdRouting(db, rest[0], rest.slice(1), flags); break;
    case 'skill': cmdSkill(db, rest[0], rest.slice(1), flags); break;
    case 'hook': cmdHook(db, rest[0], rest.slice(1), flags); break;
    case 'mcp': await cmdMcp(db, rest[0], rest.slice(1), flags); break;
    case 'handover': await cmdHandover(db, rest[0], rest.slice(1), flags); break;
    case 'question': cmdQuestion(db, rest[0], rest.slice(1), flags); break;
    case 'questions': cmdQuestions(db, flags); break;
    case 'digest': await cmdDigest(db, flags); break;
    case 'report': cmdReport(db, flags); break;
    case 'catalog': await cmdCatalog(db, rest[0], { ...flags, _key: rest[1] }); break;
    case 'bind': cmdBind(db, rest[0], rest.slice(1), flags); break;
    case 'endpoint': await cmdEndpoint(db, rest[0], rest.slice(1), flags); break;
    case 'limit': cmdLimit(db, rest[0] ?? noTask(), flags); break;
    case 'replay': console.log(renderReplay(replay(db, rest[0] ?? noTask()))); break;
    case 'tick': await cmdTick(db, rest[0] ?? null, flags); break;
    case 'stalls': cmdStalls(db, flags); break;
    case 'invariants': cmdInvariants(db, flags); break;
    case 'db': cmdDb(db, rest[0], dbPath, rest.slice(1), flags); break;
    case 'decisions': cmdDecisions(db, rest[0] ?? die(tl(lang(), '要给项目 id 或任务 id')), flags); break;
    case 'web': await cmdWeb(db, flags); break;
    case 'project': await cmdProject(db, rest[0] ?? die('project new | show | plan | advance | deliver | append | members | member | visibility | goal | budget | verify | gear | limits | concurrency | sandbox | egress | setup | signoff | review | reopen | redo | abort | rename | archive'), rest.slice(1), flags); break;
    case 'reopen': case 'rename': case 'archive': {
      // 任务级：恢复已中止的任务 / 改标题 / 归档（--undo 取消）。
      const taskId = rest[0] ?? die(tl(lang(), '{cmd} <任务 id>', { cmd }) + (cmd === 'rename' ? tl(lang(), ' <新标题>') : cmd === 'archive' ? ' [--undo]' : ''));
      const { userId } = cliIdentity(db, flags);
      try {
        if (cmd === 'reopen') { const r = reopenTask(db, { taskId, userId }); console.log(tl(lang(), '已恢复（→ {to}）', { to: r.to }) + (r.projectResumed ? tl(lang(), '，所属项目回到进行中') : '')); }
        else if (cmd === 'rename') { const r = renameTask(db, { taskId, title: rest.slice(1).join(' '), userId }); console.log(r.changed ? tl(lang(), '标题已改为 {title}', { title: r.title }) : tl(lang(), '标题没变')); }
        else { const r = setTaskArchived(db, { taskId, archived: !flags.undo, userId }); console.log(r.changed ? (r.archived ? tl(lang(), '已归档（从列表隐藏；状态不变）') : tl(lang(), '已取消归档')) : tl(lang(), '没有变化')); }
      } catch (e) { die(translateError(e, lang())); }
      break;
    }
    case 'rewind': {
      // 从某一步重来。不带 --yes 只看会怎样
      const taskId = rest[0] ?? noTask();
      const nodeId = rest[1] ?? die(tl(lang(), 'rewind <任务 id> <步骤 id> [--note "<这次要注意什么>"] [--yes]'));
      const me = cliIdentity(db, flags);
      const ws = join(HOME, 'workspaces', taskId);
      const plan = rewindPlan(db, { taskId, nodeId, workspace: ws });
      if (!plan.ok) die(tl(lang(), plan.why, plan.params));
      console.log(describeRewind(plan, lang()));
      if (!flags.yes) { console.log(`\n${tl(lang(), '确认就加 --yes 再跑一次（可以加 --note 写这次要注意什么，原样给 AI）。')}`); break; }
      try {
        const r = rewindTask(db, { taskId, nodeId, workspace: ws, userId: me.userId, note: typeof flags.note === 'string' ? flags.note : null, expectHead: plan.head, plaintextToken: me.plaintext });
        console.log(`\n${tl(lang(), '已退回 {n} 个步骤。回退前的代码在 {ref}。', { n: r.plan.nodes.length, ref: r.ref })}`);
        if (r.taskStatus === 'suspended') console.log(tl(lang(), '任务还在暂停：恢复之后才会接着做。'));
      } catch (e) { die(translateError(e, lang())); }
      break;
    }
    case 'daemon': await cmdDaemon(db, flags); break;
    case 'draft': await cmdDraft(db, rest[0] ?? noTask(), flags); break;
    case 'deliver': await cmdDeliver(db, rest[0] ?? noTask(), flags); break;
    case 'signoff': cmdSignoff(db, rest[0] ?? noTask(), flags); break;
    case 'sandbox': await cmdSandbox(db, flags); break;
    case 'revision': await cmdRevision(db, rest[0] ?? noTask(), flags); break;
    case 'egress': cmdEgress(db, rest[0] ?? noTask(), flags); break;
    case 'sources': cmdSources(db, rest[0] ?? null, rest.slice(1), flags); break;
    case 'reports': cmdReports(db, rest[0] ?? noTask(), flags); break;
    default: die(`${tl(lang(), "未知命令 '{cmd}'", { cmd })}\n\n${usage()}`);
  }
} finally {
  await flushSpans().catch(() => {});   // 可选的追踪导出：攒着的 span 在退出前发出去
  db.close();
}
