// superintern CLI —— 人机接口。
//
// 它**故意很薄**：CLI 只是一条通道，不是链。
// 所有状态变更都发生在库里，CLI 只负责把人的意思翻译成一次写入，
// 再把库里的状态翻译回人能读的样子。任何"只有 CLI 知道"的状态都是 bug。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureOwner, newId, now, audit, authenticate } from './db/db.mjs';
import { recordAnswer, sayWithClassifier } from './core/inbox.mjs';
import { orchestrate, getParam } from './core/orchestrator.mjs';
import { LlmClient, loadEnv } from './llm/client.mjs';
import { sweepTimeouts } from './core/timeouts.mjs';
import { createProject, advanceProject, deliverProject, projectTasks, createTaskFromSpec, acceptDeferredSignoffs, deliveryEvidence } from './core/project.mjs';
import { planProject, carrierTask, renderPlanOutcome } from './agent/project-planner.mjs';
import { deliverTask, signOff, signoffOf } from './core/deliver.mjs';
import { notify, channelsFromEnv, outcomeNotice } from './core/notify.mjs';
import { startWeb } from './web/server.mjs';
import { makeLauncher } from './core/launcher.mjs';
import { startDaemon, dueTasks, daemonStatus, assessTask } from './core/daemon.mjs';
import { stalls, livelocks, sweepLiveness, STALL_KINDS } from './core/liveness.mjs';
import { activeDecisions, renderDecisions, voidOne as voidDecision, revisionCheckText } from './core/decisions.mjs';
import { afterInput } from './core/decision-check.mjs';
import { checkRepoSource } from './core/repos.mjs';
import { requestAppend, reviewAgain } from './agent/project-append.mjs';
import { startProject } from './agent/project-start.mjs';
import { listMembers, setMember, removeMember, setVisibility, editProjectGoal, VISIBILITIES } from './core/project-members.mjs';
import { draft } from './agent/elicitor.mjs';
import { getParam as getTaskParam } from './core/params.mjs';
import { makeFake } from './llm/providers.mjs';
import { fmtUsd, toolCallsOf, TIERS } from './llm/canonical.mjs';
import { registryFor, bindingOf, seedBinding, pickDefaultBinding, setBinding, bindingProblems, endpointsOf, catalogOf, saveEndpoint, setEndpointEnabled, removeEndpoint,
  testEndpoint, listEndpointModels, keyPresence, bindable, saveModel, removeModel, checkableCatalog } from './llm/registry.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { listReports, markReportsRead } from './agent/reporter.mjs';
import { flushLedger, taskSpendMicroUsd } from './core/ledger.mjs';
import { plan, persistPlan } from './agent/planner.mjs';
import { ensureWorkspace } from './core/workspace.mjs';
import { LIMITS, limitOf, setLimit, checkLimits, raiseLimitQuestion, setProjectLimit, projectLimits, LAYER_NAMES } from './core/limits.mjs';
import { budgetState, setProjectBudget, projectVerifyCommand, setProjectVerify, gearOf, setGear, gearPrereqStatus, GEARS, deferredSignoffs, maxOpenOf, setMaxOpen, fmtUsd as fmtBudget, sandboxFlavorOf, setSandboxFlavor, SANDBOX_FLAVORS, setupCommandsOf, setSetupCommands, detectSetupCommands } from './core/project-settings.mjs';
import { replay, renderReplay } from './core/replay.mjs';
import { pendingRevision, nodesForReplan, gateOf, renderDiff, applyRevision,
  rejectRevision } from './core/revision.mjs';
import { ContainerExecutor, makeSandbox, listSandboxes, detectRuntime, SANDBOX_IMAGE } from './core/container.mjs';
import { egressGroupsOf, setEgressGroups, allowlistOf, sourceOf, sourceForHost, egressSources, addSource, removeSource,
  projectEgressOf, setProjectEgress, openEgressQuestions, deniedHosts } from './core/egress.mjs';
import { DECISION_TYPES, loadTemplates, rulesOf, profileOf, knobsOf, setKnobs, applyTemplate, saveRules, diffFromTemplate, previewRouting,
  dutyCalendarOf, setDutyCalendar, transferQuestion, leadOfKey, validateRules } from './core/routing.mjs';
import { addUser, usersView, setUserTags, setUserChannel, removeUserChannel, setUserRole, renameUser, reissueToken, notifyPendingQuestions } from './core/users.mjs';
import { buildDigest, renderDigest, sendDigest, renderHandover, sendHandoverNotice } from './core/digest.mjs';
import { canCreate, getSetting, setSetting, SETTINGS } from './core/settings.mjs';
import { permissionsOf, renderPermissions } from './core/permissions.mjs';
import { reopenTask, redoProjectTask, abortProject, renameTask, renameProject, setTaskArchived, setProjectArchived } from './core/lifecycle.mjs';
import { previewHandover, executeHandover, requestHandover, listHandoverRequests, decideHandoverRequest, canDecideHandover, disableUser, enableUser } from './core/handover.mjs';
import { checkCatalog, renderCatalogCheck, recordCatalogCheck, lastCatalogCheck } from './llm/catalog-check.mjs';
import { tl, translateError, userLang, contentLang, normLang, CATALOGS } from './i18n/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(ROOT, '.env'));

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
      db.run(`UPDATE users SET display_name=? WHERE id=?`, name, userId);
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
  const { taskId, constId } = createTaskFromSpec(db, { ...spec, verify_command: verifyArgv ? verifyArgv.join(' ') : undefined }, { userId });
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
  if (flags.mode === 'fake' && !flags.script) die(tl(lang(), 'plan --mode fake 要配 --script <响应脚本.json>（fake 不调模型，按脚本挨个吐响应）'));
  const planScript = flags.script ? JSON.parse(readFileSync(flags.script, 'utf8')) : null;
  const client = new LlmClient({
    mode: flags.mode ?? 'live',
    cassette: flags.cassette,
    ...clientOpts(db, flags),   // 规划器也要能换绑：厂商 403 时 plan 与 run 一样得有路可走
    ...(planScript ? { fake: makeFake(planScript) } : {}),
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

  const nodeIds = persistPlan(db, {
    taskId, constitutionId: constitution.id, nodes: result.nodes, rationale: result.rationale,
  });
  db.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);

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
      const channels = channelsFromEnv(process.env, flags.notify);
      if (channels.length) { try { await notify(db, { taskId: null, kind: 'daemon_refused_bind', title: tl(contentLang(db), '[SuperIntern] {who} 没起来：启动参数的 --bind 与库里不一致', { who }), text: msgIn(contentLang(db)), ref: 'binding', channels }); } catch { /* 尽力 */ } }
    }
    die(msg);
  }
  const { userId } = cliIdentity(db, flags);
  let r;
  try { r = seedBinding(db, { overrides, userId }); } catch (e) { die(translateError(e, lang())); }
  console.log(tl(lang(), '库里没有绑定行，已按 --bind 写入（以后启动不用再带）：'));
  printBinding(db, r);
}

function printBinding(db, b = bindingOf(db)) {
  const reg = registryFor(db);
  console.log(b.source === 'db' ? tl(lang(), '档位绑定（库）：') : tl(lang(), '档位绑定（代码默认值，库里还没写）：'));
  for (const t of TIERS) {
    const m = reg.catalog[b.binding[t]];
    console.log(`  ${t.padEnd(8)} ${b.binding[t]}${b.efforts?.[t] ? tl(lang(), '  推理强度 {effort}', { effort: b.efforts[t] }) : ''}${m ? `  → ${m.vendor} · ${m.model}` : tl(lang(), '  （不在目录里）')}`);
  }
  for (const p of bindingProblems(db, { env: process.env })) console.log(tl(lang(), '  ⚠ {tier}：{why}', { tier: p.tier, why: dyn(p.why) }));
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
      ...(script ? { fake: makeFake(script) } : {}) }),
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
          // 通知是部署级广播：用内容语言
          inflight(notify(db, { taskId, kind: 'question_escalated', title: tl(contentLang(db), '[SuperIntern] Ⅱ 级问题超时升级'),
            text: `${String(e.text).slice(0, 300)}\n\n${tl(contentLang(db), '再无人答将退保守默认。回答：node src/cli.mjs answer {qid} "..."', { qid: e.questionId })}`, ref: e.questionId, channels }));
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
          const CL = contentLang(db);   // 通知是部署级广播：用内容语言
          inflight(notify(db, { taskId, kind: 'report', title: tl(CL, '[SuperIntern] 汇报：{summary}', { summary: String(r.summary).slice(0, 80) }),
            text: `${r.summary}\n${tl(CL, '任务 {taskId}｜汇报 {id}（{trigger}）', { taskId, id: r.id, trigger: r.trigger })}${r.selfDecidedCount ? tl(CL, '｜自作主张 {n} 条', { n: r.selfDecidedCount }) : ''}`,
            ref: r.id, channels }));
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
    console.log(tl(lang(), '驳回：  node src/cli.mjs revision {taskId} --reject', { taskId }));
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
  const notice = outcomeNotice(r, taskId, contentLang(db));
  if (notice && channels.length) await notify(db, { taskId, kind: `exit:${r.kind}`, ...notice, channels });
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
      + `｜${new Date(r.created_at).toISOString().slice(0, 19)}${r.read_at ? tl(lang(), '｜已读') : ''}`);
    if (!r.read_at) markReportsRead(db, [r.id]);
    return;
  }
  const rows = listReports(db, taskId, { all: !!flags.all });
  if (!rows.length) { console.log(flags.all ? tl(lang(), '任务 {taskId} 没有任何汇报。', { taskId }) : tl(lang(), '任务 {taskId} 没有未读汇报。（--all 看全部）', { taskId })); return; }
  for (const r of rows) {
    const gaps = JSON.parse(r.gaps);
    console.log(`${r.read_at ? '  ' : '● '}${r.id}　${new Date(r.created_at).toISOString().slice(5, 16)}　[${r.trigger}${r.generated_by === 'template' ? tl(lang(), '/模板') : ''}]　${r.summary}`
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
    for (const s of egressSources(db)) {
      console.log(`${s.id}　${s.name}　[${dyn(s.kindName)}${s.readOnly ? tl(lang(), '·只读') : ''}${s.builtin ? tl(lang(), '·内置') : ''}]`);
      console.log(`    ${s.hosts.join(', ')}${Object.keys(s.toolEnv).length ? `\n    ${tl(lang(), '工具配置：{env}', { env: Object.entries(s.toolEnv).map(([k, v]) => `${k}=${v}`).join('  ') })}` : ''}${s.note ? `\n    ${dyn(s.note)}` : ''}`);
    }
    console.log(tl(lang(), '\n加：node src/cli.mjs sources add --name "清华 PyPI 镜像" --host pypi.tuna.tsinghua.edu.cn [--kind package|info] [--read-only|--writable] [--env PIP_INDEX_URL=https://…]'));
    console.log(tl(lang(), '删：node src/cli.mjs sources remove <id>'));
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
    } else die('sources [list] | add | remove <id>');
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
      console.log(`\n${r.id}　${r.status}　${new Date(r.proposed_at).toISOString().slice(0, 19)}`
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

  if (!flags.approve && !flags.reject) {
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
      console.log(tl(lang(), '  驳回：node src/cli.mjs revision {taskId} --reject', { taskId }));
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
      rejectRevision(db, { taskId, revisionId: rv.id, userId, why: tl(contentLang(db), '人驳回') });
      console.log(tl(lang(), '已驳回 {id}。计划原样不动，那条修正记为已处理 —— 否则下一轮又会停在同一处。', { id: rv.id }));
    }
  } catch (e) { die(translateError(e, lang())); }

  if (rv.question_id) {
    try {
      // 答复正文写进库：按部署的内容语言
      const a = recordAnswer(db, { questionId: rv.question_id, plaintextToken: plaintext,
        body: flags.approve ? tl(contentLang(db), '批准修正提案 {id}（经 cli revision --approve）', { id: rv.id })
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
    const script = flags.script ? JSON.parse(readFileSync(flags.script, 'utf8')) : null;
    llmClient = new LlmClient({
      mode: flags.mode ?? 'live',
      cassette: flags.cassette,
      ...clientOpts(db, flags),
      ...(script ? { fake: makeFake(script) } : {}),
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
      ...(flags.script ? { fake: makeFake(JSON.parse(readFileSync(flags.script, 'utf8'))) } : {}) }) });
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
  const w = await startWeb(db, { home: HOME, port: Number(flags.port ?? 7357), host: flags.host ? String(flags.host) : '127.0.0.1', tokenPlain: plaintext, launcher, daemon: !!flags.daemon, envFile: join(ROOT, '.env'),
    team, publicUrl: team ? flags['public-url'] : null });
  console.log(team ? tl(lang(), '看板（团队模式）：监听 http://{host}:{port}/，对外地址 {url}；每个人用自己的令牌登录（Ctrl-C 停）', { host: w.host, port: w.port, url: flags['public-url'] })
    : tl(lang(), '看板：http://{host}:{port}/   （只绑本机；Ctrl-C 停）', { host: w.host, port: w.port }));
  for (const p of bindingProblems(db, { env: process.env })) console.log(tl(lang(), '  ⚠ 绑定 {tier}（{key}）：{why} —— 看板"设置"里改', { tier: p.tier, key: p.key, why: dyn(p.why) }));
  if (flags.daemon) await runDaemon(db, flags, launcher);
  await new Promise(() => {});   // 挂住进程
}

// 项目层（project.mjs）：整批契约建项目，串接由守护进程做；这里只有建 / 看 / 手动推进 / 交付。
async function cmdProject(db, sub, args, flags) {
  const { userId } = cliIdentity(db, flags);
  if (sub === 'new') { const cc = canCreate(db, userId); if (!cc.ok) die(tl(lang(), '无法新建项目：{why}', { why: dyn(cc.why) })); }
  const textOrFile = (v) => (v === undefined || v === true ? '' : existsSync(String(v)) ? readFileSync(String(v), 'utf8') : String(v));
  if (sub === 'new' && !flags.file) {
    // 新建的唯一入口。--goal / --done 必填；--plan（旧名 --brief）= 已写好的规划，给了就由规划器切成多个任务，
    // 没给就从目标起草第一个任务（追问器）。仓库当场克隆，路径不对当场报错。
    const planFlag = flags.plan ?? flags.brief;
    if (!flags.goal || !flags.done) die(tl(lang(), 'project new --goal <文本或文件> --done <文本或文件> (--source <仓库路径或 URL> | --empty) [--plan <规划文本或文件>] [--base <ref>] [--title <标题>]'));
    let r;
    try {
      if (!flags.empty) checkRepoSource(flags.source === true ? '' : flags.source, { required: true });
      r = startProject(db, { userId, goal: textOrFile(flags.goal), doneDefinition: textOrFile(flags.done), plan: planFlag === undefined ? null : textOrFile(planFlag),
        source: flags.empty ? null : flags.source, empty: !!flags.empty, base: flags.base ?? null, title: flags.title === true ? null : flags.title ?? null, home: HOME });
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
    const script = flags.script ? JSON.parse(readFileSync(flags.script, 'utf8')) : null;
    const client = new LlmClient({ mode: flags.mode ?? 'live', cassette: flags.cassette, ...clientOpts(db, flags), ...(script ? { fake: makeFake(script) } : {}) });
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
          + `  ${new Date(ev.verify.at).toISOString().replace('T', ' ').slice(0, 19)}`);
        console.log(ev.verify.ranAtHead ? tl(lang(), '  跑的就是要推的这一份（{head}）', { head: String(ev.verify.head ?? '').slice(0, 8) })
          : tl(lang(), '⚠ 那次跑的是 {ran}，和现在要推的 {head} 不是同一份代码 —— 这个"通过"对这次没有效力', { ran: String(ev.verify.head ?? tl(lang(), '未知')).slice(0, 8), head: String(ev.stat?.head ?? tl(lang(), '未知')).slice(0, 8) }));
        if (ev.verify.tail) console.log(tl(lang(), '  输出尾部：') + `\n${String(ev.verify.tail).split('\n').slice(-12).map((l) => `    ${l}`).join('\n')}`);
      }
      console.log('');
    }
    const r = await deliverProject(db, { projectId, remote: flags.remote ?? null, pr: !!flags.pr, base: flags.base ?? null, userId,
      acceptDeferred: !!flags['accept-pending'] }).catch((e) => die(translateError(e, lang())));
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
async function cmdDaemon(db, flags) {
  cliIdentity(db, flags);   // 令牌得有效 —— 守护进程起的 run 与人起的走同一条路
  await bindForLongRunner(db, flags, 'daemon');
  const launcher = makeLauncher(db, { home: HOME });
  await runDaemon(db, flags, launcher);
  await new Promise(() => {});
}

async function runDaemon(db, flags, launcher) {
  const intervalMs = Math.max(5, Number(flags.interval ?? 15)) * 1000;
  const channels = channelsFromEnv(process.env, flags.notify);
  const d = startDaemon(db, { home: HOME, launcher, intervalMs, iterations: flags.iterations ? Number(flags.iterations) : null,
    notifyOpts: { env: process.env, extraCmd: flags.notify, digestEvery: flags['digest-every'] ? String(flags['digest-every']) : null,
      catalogCheckEvery: flags['no-catalog-check'] ? null : String(flags['catalog-check'] ?? '7d') },   // 目录与在用的键：守护进程每轮从库读（checkableCatalog）
    onEvent: (e) => {
      const stamp = new Date().toISOString().slice(11, 19);
      if (e.type === 'sweep') printSweepEvent(db, e.event, channels);
      else if (e.type === 'notified') console.log(`${stamp} ${tl(lang(), '✉ 事项 {qid} 已通知 {n} 人（{ok}/{all} 条送达）', { qid: e.questionId, n: e.to.length, ok: e.receipts.filter((r) => r.ok).length, all: e.receipts.length })}`);
      else if (e.type === 'notify_failed') console.log(`${stamp} ${tl(lang(), '✗ 通知失败：{err}', { err: e.error })}`);
      else if (e.type === 'catalog') console.log(`${stamp} ${e.warnings ? '⚠' : '✓'} ${tl(lang(), '模型目录检查（{why}）：', { why: { never: tl(lang(), '首次'), new_key: tl(lang(), '绑定里有没查过的模型'), interval: tl(lang(), '到间隔') }[e.why] ?? e.why })}${e.warnings ? tl(lang(), '{n} 项要看一眼', { n: e.warnings }) + (e.sent ? tl(lang(), '，已通知管理员') : '') : tl(lang(), '无漂移')}${e.fetchErrors ? tl(lang(), '；{n} 处拉取失败', { n: e.fetchErrors }) : ''}`);
      else if (e.type === 'digest') console.log(`${stamp} ${tl(lang(), '✉ 定时待办摘要 → {user}（{items} 项，{ok}/{all} 条送达）', { user: e.userId, items: e.items, ok: e.receipts.filter((r) => r.ok).length, all: e.receipts.length })}`);
      else if (e.type === 'handover') console.log(`${stamp} ${tl(lang(), '⇄ 换班（{key}）：{from} → {to}，', { key: e.projectId || tl(lang(), '默认表'), from: e.from, to: e.to })}${e.sent ? tl(lang(), '已推 {n} 项待办', { n: e.items }) : tl(lang(), '没有待办，未发')}`);
      else if (e.type === 'stall') console.log(`${stamp} ${tl(lang(), '⚠ 停等 {taskId}：静止 {min} 分钟，而系统说不出它在等谁（{why}）。已提事项 {qid} 给负责人', { taskId: e.taskId, min: e.idleMin, why: dyn(e.why), qid: e.questionId })}`);
      else if (e.type === 'livelock') console.log(`${stamp} ${tl(lang(), '⚠ 空转 {taskId}：{why}，期间没有新信息。已提事项 {qid} 给负责人', { taskId: e.taskId, why: dyn(e.why), qid: e.questionId })}`);
      else if (e.type === 'launched') console.log(`${stamp} ${tl(lang(), '▶ 拉起 {taskId}（{reason}）pid {pid} · 日志 {log}', { taskId: e.taskId, reason: dyn(e.reason), pid: e.pid, log: e.logFile })}`);
      else if (e.type === 'launch_failed') console.log(`${stamp} ${tl(lang(), '✗ 拉不起 {taskId}（{reason}）：{err}', { taskId: e.taskId, reason: dyn(e.reason), err: e.error })}`);
      else if (e.type === 'project') {
        console.log(`${stamp} ${tl(lang(), '⛓ 项目 {pid}：{reason}', { pid: e.projectId, reason: dyn(e.reason) })}${e.taskId ? ` ${e.taskId}` : ''}${e.nextTaskId ? tl(lang(), ' → 下一个 {id} 工作区已建', { id: e.nextTaskId }) : ''}${e.done ? tl(lang(), '；项目 done') : ''}`);
        if (e.done && channels.length) void notify(db, { taskId: e.taskId ?? null, kind: 'project_done', title: tl(contentLang(db), '[SuperIntern] 项目完成 {pid}', { pid: e.projectId }),
          text: tl(contentLang(db), '全部任务已合进项目分支。交付：node src/cli.mjs project deliver {pid} --remote <url> --pr', { pid: e.projectId }), ref: e.projectId, channels });
      } else if (e.type === 'project_error') console.log(`${stamp} ${tl(lang(), '✗ 项目 {pid} 推进失败（第 {n} 次，按退避等）：{err}', { pid: e.projectId, n: e.attempt, err: e.error })}`);
    } });
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

function printSweepEvent(db, e, channels) {
  if (e.type === 'question_defaulted') {
    console.log(tl(lang(), '⏱ {taskId} 超时走默认（{level} 级 {qid}）：{action}', { taskId: e.taskId, level: e.level === 1 ? 'Ⅰ' : 'Ⅱ', qid: e.questionId, action: String(e.defaultAction).slice(0, 120) }));
  } else if (e.type === 'question_escalated') {
    console.log(tl(lang(), '⏱ {taskId} 超时升级（Ⅱ 级 {qid}）：再无人答将退保守默认。node src/cli.mjs answer {qid} "..."', { taskId: e.taskId, qid: e.questionId }));
    void notify(db, { taskId: e.taskId, kind: 'question_escalated', title: tl(contentLang(db), '[SuperIntern] Ⅱ 级问题超时升级'),
      text: `${String(e.text).slice(0, 300)}\n\n${tl(contentLang(db), '再无人答将退保守默认。回答：node src/cli.mjs answer {qid} "..."', { qid: e.questionId })}`,
      ref: e.questionId, channels });
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
  const script = flags.script ? JSON.parse(readFileSync(flags.script, 'utf8')) : null;
  const client = new LlmClient({ mode: flags.mode ?? 'live', cassette: flags.cassette, ...clientOpts(db, flags), ...(script ? { fake: makeFake(script) } : {}) });
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
  const channels = channelsFromEnv(process.env, flags.notify);
  const r = sweepTimeouts(db, { taskId, onEvent: (e) => printSweepEvent(db, e, channels) });
  const sent = await notifyPendingQuestions(db, { env: process.env, extraCmd: flags.notify });
  if (sent.length) console.log(tl(lang(), '通知了 {n} 条事项的收件人', { n: sent.length }));
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

/**
 * 待决事项打包摘要：默认是"我"的（按令牌）；负责人可 --user <id> 看别人的。--send 按此人的通道真发一份并记 digests。
 * 守护进程按 --digest-every 定时发；换班交接自动发（值班者变了就给接班人推）。
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

/**
 * 模型目录漂移检查（确定性，不调模型）：存在性（各家 /models）、可选实调（--probe，每模型一次 16 token 请求）、
 * 单价与窗口（OpenRouter 公开表 / Gemini API）。只报告，目录由人改。结果落审计 catalog_checked，进负责人的待办摘要。
 */
async function cmdCatalog(db, sub, flags) {
  if (sub === 'last') {
    const last = lastCatalogCheck(db);
    if (!last) { console.log(tl(lang(), '还没查过：node src/cli.mjs catalog check')); return; }
    console.log(tl(lang(), '上次检查 {at}：{n} 项要看一眼', { at: new Date(last.checkedAt ?? last.ts).toISOString(), n: last.warnings }) + (last.probe ? tl(lang(), '（含实调）') : '') + (last.fetchErrors ? tl(lang(), '，{n} 处拉取失败', { n: last.fetchErrors }) : ''));
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
  if (sub !== 'check') die(tl(lang(), '用法：node src/cli.mjs catalog [list] | check [--probe] [--vendor <id>] | last | add|set <服务商/模型> --input <$/M> --output <$/M> [--cache-read] [--cache-write] [--window N] [--efforts low,medium,high|none] [--model <发给厂商的名>] | remove|enable|disable <键>'));
  const { userId } = cliIdentity(db, flags);
  const reg = checkableCatalog(db);
  const r = await checkCatalog({ catalog: reg.catalog, vendors: reg.vendors, env: process.env, probe: !!flags.probe, only: flags.vendor ? String(flags.vendor) : null, lang: contentLang(db) });
  console.log(renderCatalogCheck(r, { lang: lang() }));
  recordCatalogCheck(db, r, { by: userId, actorKind: 'user', lang: contentLang(db) });
  process.exitCode = r.warnings ? 1 : 0;
}

// ── 档位绑定与服务商的 CLI 面（看板是主界面；这里保证"全部动作都有 CLI"）─────────────────────────
function cmdBind(db, sub, args, flags) {
  if (!sub || sub === 'show') { printBinding(db); return; }
  if (sub !== 'set') die(tl(lang(), '用法：node src/cli.mjs bind [show] | bind set <tier>=<服务商/模型>... [--effort low|medium|high|none]'));
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
  const auth = authenticate(db, plaintext) ?? die(tl(lang(), '令牌无效或已吊销'));
  return { plaintext, userId: auth.user_id };
};

// 交付：push + PR。PR 正文取真相源里最近一份 task_done 汇报，不另调模型。
async function cmdDeliver(db, taskId, flags) {
  const { userId } = cliIdentity(db, flags);
  const wsDir = flags.dir ?? join(HOME, 'workspaces', taskId);
  if (!existsSync(wsDir)) die(tl(lang(), '工作区不存在：{dir}', { dir: wsDir }));
  let r;
  try {
    r = await deliverTask(db, { taskId, workspace: wsDir, remote: flags.remote ?? null, branch: flags.branch ?? null,
      pr: !!flags.pr, base: flags.base ?? null, userId });
  } catch (e) { die(translateError(e, lang())); }
  console.log(tl(lang(), '已 push：{remote}  {branch} @ {head}', { remote: r.remote, branch: r.branch, head: r.head.slice(0, 8) }));
  if (r.pr) console.log(tl(lang(), '已开 PR：{url}（base {base}）', { url: r.pr.url, base: r.pr.base }));
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
function cmdUser(db, sub, args, flags) {
  if (sub === 'list' || !sub) {
    const cal = dutyCalendarOf(db, '');
    for (const u of usersView(db)) {
      console.log(`  ${u.id}  ${(u.disabledAt ? tl(lang(), '已停用') : u.role).padEnd(8)} ${u.name.padEnd(14)} ${tl(lang(), '标签 {tags}  通道 {channels}  令牌 {token}', { tags: u.tags.join(',') || '-', channels: u.channels.map((c) => `${c.kind}${c.host ? `@${c.host}` : ''}`).join(',') || '-', token: u.tokens ? tl(lang(), '有效') : tl(lang(), '无') })}`);
      if (u.responsibilities.count) console.log(tl(lang(), '      名下：{text}', { text: dyn(u.responsibilities.text) }));
    }
    if (cal) console.log(tl(lang(), '  值班：{users}，起 {start}，每 {days} 天换', { users: cal.users.join(' → '), start: new Date(cal.start_at).toISOString().slice(0, 10), days: cal.period_days }));
    return;
  }
  const me = cliIdentity(db, flags);
  const requireLead = () => { if (db.one(`SELECT role FROM users WHERE id=?`, me.userId)?.role !== 'lead') die(tl(lang(), '只有管理员能管理成员')); };
  if (sub === 'add') {
    requireLead();
    const name = args[0] ?? die(tl(lang(), 'user add <名字> --role member|observer [--tags a,b] [--out <令牌文件>]'));
    const r = addUser(db, { name, role: flags.role ?? 'member', tags: String(flags.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean), byUserId: me.userId });
    const out = flags.out ?? join(HOME, 'tokens', `${name}.token`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, r.plaintext, { mode: 0o600 });
    console.log(tl(lang(), '已加用户 {id}（{role}）', { id: r.userId, role: flags.role ?? 'member' }));
    console.log(tl(lang(), '令牌写入 {file}（库里只有哈希，这个文件是唯一副本；交给本人，本人用 --token-file 指向它）', { file: out }));
    return;
  }
  if (sub === 'tags') { requireLead(); setUserTags(db, { userId: args[0] ?? die(tl(lang(), '要给用户 id')), tags: String(flags.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean), byUserId: me.userId }); console.log(tl(lang(), '标签已改')); return; }
  if (sub === 'perms') { try { console.log(renderPermissions(permissionsOf(db, args[0] ?? me.userId))); } catch (e) { die(translateError(e, lang())); } return; }
  if (sub === 'setting') {
    // 部署级开关：看 = 所有人；改 = 管理员。
    if (!args[0]) { for (const [k, d] of Object.entries(SETTINGS)) console.log(`${k} = ${getSetting(db, k)}   ${dyn(d.label)}`); return; }
    requireLead();
    if (!['true', 'false'].includes(args[1])) die(tl(lang(), 'user setting <键> true|false'));
    try { const r = setSetting(db, { key: args[0], value: args[1] === 'true', userId: me.userId }); console.log(`${r.key} = ${r.value}`); } catch (e) { die(translateError(e, lang())); }
    return;
  }
  if (sub === 'channel') {
    const uid = args[0] ?? die(tl(lang(), 'user channel <用户 id> --ntfy <url> | --feishu <url> | --dingtalk <url> | --wecom <url> | --remove <种类>'));
    if (uid !== me.userId) requireLead();
    try {
      if (flags.remove) { removeUserChannel(db, { userId: uid, kind: String(flags.remove), byUserId: me.userId }); console.log(tl(lang(), '已删 {kind} 通道', { kind: flags.remove })); return; }
      let n = 0;
      for (const k of ['ntfy', 'feishu', 'dingtalk', 'wecom']) if (flags[k]) { setUserChannel(db, { userId: uid, kind: k, target: String(flags[k]), byUserId: me.userId }); n++; }
      console.log(n ? tl(lang(), '已挂 {n} 条通道（审计只记种类，不记地址）', { n }) : tl(lang(), '没给通道（--ntfy / --feishu / --dingtalk / --wecom；删除用 --remove <种类>）'));
    } catch (e) { die(translateError(e, lang())); }
    return;
  }
  try {
    if (sub === 'role') { requireLead(); const r = setUserRole(db, { userId: args[0] ?? die('user role <id> lead|member|observer'), role: args[1] ?? die(tl(lang(), 'user role <id> lead|member|observer（lead = 管理员）')), byUserId: me.userId }); console.log(r.changed ? tl(lang(), '角色已改为 {role}', { role: r.role }) : tl(lang(), '角色没变')); return; }
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
  die(tl(lang(), 'user 子命令：list | add | tags | perms | setting | channel | role | rename | token | disable | enable'));
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
      const start = flags.start ? Date.parse(String(flags.start)) : Date.now();
      if (!users.length || !Number.isFinite(start)) die('routing duty --users u_a,u_b --start 2026-09-21 [--period 7]');
      setDutyCalendar(db, { key, users, startAt: start, periodDays: Number(flags.period ?? 7), userId: me.userId });
      console.log(tl(lang(), '值班日历已存：{users}，每 {days} 天换', { users: users.join(' → '), days: flags.period ?? 7 })); return;
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
  die(tl(lang(), 'routing 子命令：show | templates | template <名> | reset | owner <类型> <解析器>... | remove <用户> | duty | preview [--template 名] | export --file | import --file'));
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
    const h = db.one(`SELECT * FROM handoffs WHERE node_id=? AND validated_at IS NOT NULL`, n.id);
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
    console.log(`  ${new Date(a.ts).toISOString()} ${a.actor_kind}/${a.actor_id ?? '-'} ${a.action}${note}`);
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

const VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return 'dev'; } })();
// 用法说明整段一个键（英文在 i18n/en/cli.mjs）。库还没打开时 lang() 只看 SI_LANG。
const usage = () => tl(lang(), `superintern {version} —— 服务端长期运行的自主编码 agent（人只答题 / 取舍 / 提变更 / 叫停）

  node src/cli.mjs decisions <项目 id|任务 id> [--all] [--void <决定 id> "理由"]   # 决定登记：此刻仍然有效的约定清单（有结论的事项 / 批准过的契约与变更 / 改过的目标）
  node src/cli.mjs stalls [--raise]                          # 停等账本：每个没结束的任务在等谁（自己 / 时钟 / 某个人 / 上游）；⚠ 那几行是说不出在等谁的缺陷，--raise 升成事项
  node src/cli.mjs digest [--user <id|名字>] [--send]        # 我的待办打包：等我答的 / 等冲突结论的 / 等别人的 / 知会我的；负责人另见没人接的、任务状态、未读汇报、异议
  node src/cli.mjs catalog check [--probe] [--vendor <id>] | last   # 模型目录漂移：还在不在、能不能调（--probe 花极少的钱）、单价与窗口对不对；只报告，目录由人改
  node src/cli.mjs endpoint [list] | set <id> --adapter … --base-url … --key-env … | enable|disable|remove|test|models <id>   # 服务商（直连厂商 / 聚合平台）；key 只在 .env
  node src/cli.mjs catalog [list] | add|set <服务商/模型> --input <$/M> --output <$/M> [--window N] [--efforts …] | remove|enable|disable <键>   # 模型目录（缺单价不能绑）
  node src/cli.mjs bind [show] | bind set <tier>=<服务商/模型>... [--effort low|medium|high|none]   # 档位绑定（进库、记审计；下一个节点起生效）
  node src/cli.mjs init [--name <管理员显示名>] [--bind <tier>=<服务商/模型>]...     # 库已存在时 --name 改显示名；首装时 --bind 写默认绑定
  node src/cli.mjs new "<标题>" --goal <目标> --dod <完成定义> [--scope <范围>]
                                [--constraint <约束>]... [--verify "<任务级验收命令>"]
  node src/cli.mjs new --file <task.json>
  node src/cli.mjs plan <taskId> [--tier light|standard|heavy] [--attempts N] [--force] [--bind <tier>=<服务商/模型>]...   # --bind 只覆盖本次进程；常态用 bind set
  node src/cli.mjs workspace <taskId> [--source <repo>] [--dir <路径>] [--ref <commit>] [--force]
  node src/cli.mjs run <taskId> [--cycles N] [--once] [--tier ...] [--iterations N]
                                [--no-commit] [--no-verify] [--no-sandbox]
  node src/cli.mjs revision <taskId> [--approve | --reject] [--reservation "批了，但这一条我保留意见：…"]
  node src/cli.mjs sandbox [--reap] [--task <taskId>]
  node src/cli.mjs sources [add|remove]                      联网目录（管理员）：内置 5 个软件源，可加镜像 / 私有仓库 / 可信的信息源
  node src/cli.mjs project setup <projectId> [--cmd "<命令>"]... [--clear]   环境准备命令：新工作区与项目级验收前自动先跑（装依赖用）
  node src/cli.mjs project egress <projectId> [--add <源>]... [--remove <源>]...   项目联网：从联网目录里勾选，项目下所有任务共用
  node src/cli.mjs egress <taskId> [--allow <源>]... [--deny <源>]...
  node src/cli.mjs new --idea "<一段话>" [<标题>] [--source <现有仓库路径>]   从模糊想法开始：追问器先问、出草案、你批准后自动规划开跑（要开守护进程）
  node src/cli.mjs draft <taskId> [--bind ...]   追问器的一次寿命（守护进程会自动跑；手动也可）
  node src/cli.mjs say <taskId> "<正文>" [--kind instruction|correction|context] [--urgent] [--about <questionId>] [--mode fake --script <响应脚本.json>]
      # 不给 --kind：系统读正文判断是修正（改要做的事）/ 新指令（加一件事）/ 补充信息（不改要做的事），落库标 kind_source=classifier；给了就一字不改
  node src/cli.mjs answer <questionId> "<答复>" [--token-file <路径>]   多人时按路由表数人头；立场不同会生成冲突事项
  node src/cli.mjs answer <questionId> --agree [答复 id]                 附议已有的那条（不写新文本，计入法定人数）
  node src/cli.mjs answer <questionId> --abstain ["说明"]                弃权：这条不归我（从收件人里去掉自己，人数重算）
  node src/cli.mjs question transfer <questionId> --to user:<id> [--reason "..."]   把一条事项转给别人（事项级，不改表；理由会显示给对方）
  node src/cli.mjs user list | add <名字> --role member|observer [--tags a,b] | tags <id> --tags a,b | channel <id> --ntfy <url> | --remove <种类>
  node src/cli.mjs user role <id> lead|member|observer（lead = 管理员）| perms [<id>]（权限一览）| setting [<键> true|false] | rename <id> <新名字> | token <id>（重发令牌）| disable <id> | enable <id>
  node src/cli.mjs handover preview|run --from <id> --to <id> (--project <id> | --solo | --all) [--note ".."] [--disable]   交接；成员 run = 申请
  node src/cli.mjs handover requests | approve|reject|withdraw <申请 id>
  node src/cli.mjs routing show | templates | template <名> [--set pm=u_x] | reset | owner <类型> <解析器>... | remove <用户> |
                           duty --users u_a,u_b --start 日期 | preview [--template 名] | export --file f | import --file f   [--project <id>]
  node src/cli.mjs tick [taskId] [--notify <cmd>]   扫到期的问题：Ⅰ 级走默认 / Ⅱ 级升级或退默认（给 cron 用）
  node src/cli.mjs deliver <taskId> [--remote <url>] [--branch <名>] [--pr] [--base <分支>]
  node src/cli.mjs project new --file <项目.json> --source <仓库路径或URL> [--base <ref>]   整批契约建项目（守护进程串着跑）
  node src/cli.mjs project new --brief <规划文本或文件> (--source <仓库> | --empty) [--title <名>]   让规划器切整批契约，人批一次
  node src/cli.mjs project plan <projectId> [--bind …]  规划器的一次寿命（守护进程会自动拉）
  node src/cli.mjs project show <projectId>            各任务状态 / 签收 / 合并
  node src/cli.mjs project advance <projectId>         手动推进一步（没开守护进程时用）
  node src/cli.mjs project budget <projectId> [--usd <美元> | --clear]    项目预算闸（默认不设；撞闸 = 不再开新任务 + 一条 Ⅲ 级事项）
  node src/cli.mjs project verify <projectId> [--cmd "<一条命令>" | --clear]   项目级验收命令（选填；没填时"项目达成"只能由人宣布）
  node src/cli.mjs project gear <projectId> [propose|auto]    自动化挡位；不带参数看当前挡与四条前提各自成不成立
  node src/cli.mjs project limits <projectId> [--key <项> --value <数> | --key <项> --clear]   项目默认上限（部署默认 → 项目默认 → 任务覆盖）
  node src/cli.mjs project sandbox <projectId> [node|python]      沙箱镜像（默认只有 Node；python = 在它之上加 Python 3）
  node src/cli.mjs project concurrency <projectId> [--max <1-4>]   同时最多开几个任务（默认 2；只有开着的任务全都在等人时才让路）
  node src/cli.mjs project deliver <projectId> --remote <url> [--pr] [--base <分支>] [--accept-pending]
  node src/cli.mjs project signoff <projectId> [--accept-all]   后置签收：自动挡下 AI 自己加的任务攒着的签收，看清单 / 一次点掉（交付前必须清掉）
                                    push 工作区分支；--pr 在 GitHub 开 PR（要 .env 里的 GITHUB_TOKEN；高风险任务先签收）
  node src/cli.mjs signoff <taskId> --accept | --reject "<理由>"   人工签收；打回 = 一条紧急修正
  node src/cli.mjs web [--port 7357] [--daemon]   看板（只绑 127.0.0.1；--daemon 同时带守护进程；不接 --bind —— 子进程自己读库里的绑定，库空时 --bind 写入一次）
  node src/cli.mjs web --team --public-url https://<内网域名> [--host 127.0.0.1] [--daemon]   团队模式：多人各自登录，放在 HTTPS 反向代理之后（docs/deploy-team.md）
  node src/cli.mjs daemon [--interval 15] [--notify <cmd>] [--digest-every 8h] [--catalog-check 7d|--no-catalog-check]   守护进程：答完题 / 加额 / 批准后自动拉起 run；含 tick；--digest-every 按间隔给每人推待办摘要，换班时自动给接班人推；--catalog-check 按间隔查模型目录漂移（默认 7d，绑定里出现没查过的模型立刻查）
  node src/cli.mjs show <taskId>
  node src/cli.mjs questions [--all]      列开放 / 已升级的问题（--all 含已答复的最近 20 条）；一眼看有没有人要答
  node src/cli.mjs limit <taskId> [--budget_micro_usd N] [--runtime_ms N] [--llm_calls N]
                                  [--node_retries N] [--idle_cycles N] [--context_tokens N]
  node src/cli.mjs replay <taskId>

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

const dbPath = flags.db ?? join(HOME, 'state.db');
if (cmd !== 'init' && !existsSync(dbPath) && dbPath !== ':memory:') {
  die(tl(lang(), '状态库不存在：{path}\n先跑 node src/cli.mjs init', { path: dbPath }));
}
const db = openDb(dbPath);
langDb = db;   // 从这里起 lang() 能按令牌身份取界面语言

const noTask = () => die(tl(lang(), '要给任务 id'));
try {
  switch (cmd) {
    case 'init': cmdInit(db, flags); break;
    case 'new': cmdNew(db, { flags, positional: rest }); break;
    case 'plan': await cmdPlan(db, rest[0] ?? noTask(), flags); break;
    case 'workspace': cmdWorkspace(db, rest[0] ?? noTask(), flags); break;
    case 'run': await cmdRun(db, rest[0] ?? noTask(), flags); break;
    case 'say': await cmdSay(db, rest[0] ?? noTask(), rest.slice(1).join(' '), flags); break;
    case 'answer': await cmdAnswer(db, rest[0] ?? die(tl(lang(), '要给问题 id')), rest.slice(1).join(' '), flags); break;
    case 'show': cmdShow(db, rest[0] ?? noTask()); break;
    case 'user': cmdUser(db, rest[0], rest.slice(1), flags); break;
    case 'routing': cmdRouting(db, rest[0], rest.slice(1), flags); break;
    case 'handover': await cmdHandover(db, rest[0], rest.slice(1), flags); break;
    case 'question': cmdQuestion(db, rest[0], rest.slice(1), flags); break;
    case 'questions': cmdQuestions(db, flags); break;
    case 'digest': await cmdDigest(db, flags); break;
    case 'catalog': await cmdCatalog(db, rest[0], { ...flags, _key: rest[1] }); break;
    case 'bind': cmdBind(db, rest[0], rest.slice(1), flags); break;
    case 'endpoint': await cmdEndpoint(db, rest[0], rest.slice(1), flags); break;
    case 'limit': cmdLimit(db, rest[0] ?? noTask(), flags); break;
    case 'replay': console.log(renderReplay(replay(db, rest[0] ?? noTask()))); break;
    case 'tick': await cmdTick(db, rest[0] ?? null, flags); break;
    case 'stalls': cmdStalls(db, flags); break;
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
  db.close();
}
