// 硬上限与进度型死人开关。
//
// 三条设计约束，每条都不是随手定的：
//
// ① **触顶行为是"强制汇报 + 提问"，不是静默死掉也不是静默续跑**。
//    所以触顶要产出一条真的 `questions` 行，人能回答、能加额、能中止。
//
// ② **这条问题必须由编排器确定性地生成，不能让 LLM 去写。** 钱花光了还要再花一次
//    钱才能说出"钱花光了"，那闸门就有一个自指的洞：预算越紧，报告越可能失败。
//    这是"确定性状态机 / LLM 子程序"切分的直接体现 ——
//    "上限到了"这个判断既不该硬编码进提示词，也不该独立成一次 LLM 调用，
//    它就该是状态机的一次比较。
//
// ③ **level_source='hard_rule'**。触及安全边界的操作由 harness 强制归 Ⅲ 级，
//    不是提示词约定。这是全系统第一处用 hard_rule 的地方 —— 此前所有问题都是
//    `classifier`（模型自己定级）。库层 CHECK 会顺带保证 Ⅲ 级不带默认动作与超时。
//
// ── on_hit：两类上限 ────────────────────────────────────────────────────
// 每条目带 `on_hit`，标明撞顶时走哪条路：
//   'gate'       触顶类 —— 撞顶 = 记审计 + 生成 Ⅲ 级问题给人（raiseLimitQuestion），
//                按维度给 advice 说清"提高上限通常是不是对的答案"（该问就问）。
//   'hard_fail'  硬边界类 —— 撞顶 = 记一条审计事件后**硬失败**。它对应容器被
//                OOM / pids-limit kill：任务自身失控或泄漏，加额不是答案，
//                所以不给加额建议、不走提问/降级分支。
// 两类行为的执行在编排器/容器侧（它们按 on_hit 分流）；这张表只负责标类、给默认值
// 与给文案。判类：预算 / 时长 / 调用 / 上下文 / 空转 / 重试 / 出网（分组数、连续被拒）
// 是 gate；容器内存、容器进程数是 hard_fail。

import { routeQuestion, requireAuthorized } from './routing.mjs';
import { ANSWER_GUARDS } from './answers.mjs';
import { now, newId, audit, insertEdge } from '../db/db.mjs';
import { getParam, getProjectParam, setProjectParam } from './params.mjs';
import { budgetState, raiseProjectBudget, BUDGET_KEY } from './project-settings.mjs';
import { egressDenialStateOf } from './egress.mjs';
import { tl, contentLang, N_, I18nError } from '../i18n/index.mjs';
import { markOf } from '../i18n/marks.mjs';

// 用 N_ 登记过的原文（label / advice / 层级名）按变量查：抽取器只认字面量，所以不写成 tl(L, 变量)。
const tlN = tl;

// 各项的 fmt(值, lang = 'zh')：带单位的按语言写（看板的 valueText / deployText、事项正文都用它）。
const fmtUsd = (micro) => `$${(micro / 1e6).toFixed(4)}`;
const fmtMin = (ms, lang = 'zh') => tl(lang, '{n} 分钟', { n: (ms / 60000).toFixed(1) });
const fmtGiB = (n) => `${(n / 1024 ** 3).toFixed(2)} GiB`;

/**
 * 维度全上（最大轮数、工具调用数、挂钟时间、花费、单节点重试数）。
 *
 * ⚠️ 两处与上面这份清单的偏差，都是有意的，写在这里而不是藏起来：
 *
 * - **"最大轮数"不在这张表里**：它是 `maxIterations`，作用域是单个节点，
 *   由 runToolLoop 自己管，且模型看得见（iterationNote）。放进任务级闸门会重复执法。
 * - **"工具调用数"换成了 `llm_calls`**：`usage_ledger` 每行 = 一次 LLM 调用，
 *   已经在库里；而工具调用数没有任何表在存。本架构里每一轮都是"一次 LLM 调用 +
 *   若干工具调用"，两者近乎共线，为一个共线量新开一张计数表不值得。
 *   **代价**：一轮里塞 50 个工具调用的形态抓不住 —— 如实记在这里。
 */
// 页面「上限」区里每一行的叫法（src/web/index.html 的 LIM[…].name）。事项正文让人"到任务页把「X」调高"时用这个名字 ——
// 否则正文说「单步骤重试次数」、页面那一行叫「步骤重试」，人会在一排格子里填错行。两处改名要一起改。
export const UI_NAMES = { 'limit.budget_micro_usd': N_('预算'), 'limit.runtime_ms': N_('活动时长'), 'limit.llm_calls': N_('模型请求'), 'limit.node_retries': N_('步骤重试'),
  'limit.node_reclaims': N_('步骤异常恢复'), 'limit.draft_rounds': N_('澄清轮次'), 'limit.idle_cycles': N_('无进展轮次'), 'limit.context_tokens': N_('单次请求上下文'),
  'limit.egress.consecutive_denials': N_('联网连续拦截') };
const uiName = (key) => UI_NAMES[key] ?? LIMITS[key]?.label ?? key;

export const LIMITS = {
  'limit.budget_micro_usd': {
    on_hit: 'gate',
    def: 5_000_000, label: N_('任务花费'), fmt: fmtUsd,
    read: (db, taskId) => db.one(
      `SELECT COALESCE(SUM(micro_usd),0) AS v FROM usage_ledger WHERE task_id=?`, taskId).v,
  },
  'limit.runtime_ms': {
    on_hit: 'gate',
    def: 45 * 60 * 1000, label: N_('累计运行时长'), fmt: fmtMin,
    // ⚠️ 是**累计运行时长**，不是"建任务到现在"的挂钟。挂起等人是这个系统的正常
    // 状态，可能等三天；按墙上时钟算，每一个提过问题的任务最终都会被自己的闸门打死,
    // 而那是在惩罚人回得慢。所以只累加编排器真正在跑的那些区间。
    read: (db, taskId, ctx) => priorRuntimeMs(db, taskId) + (now() - (ctx?.startedAt ?? now())),
  },
  'limit.llm_calls': {
    on_hit: 'gate',
    def: 200, label: N_('LLM 调用次数'), fmt: String,
    read: (db, taskId) => db.one(
      `SELECT count(*) AS v FROM usage_ledger WHERE task_id=?`, taskId).v,
  },
  'limit.node_retries': {
    on_hit: 'gate',
    // 默认 3（重试阈值初始 3 次）。不用 2：自动升档在重试 ≥2 时发生，
    // 默认 2 意味着升档永远轮不到就先触顶 —— 闸门要比升档点高一格才有意义。
    def: 3, label: N_('单步骤重试次数'), fmt: String,
    read: (db, taskId) => db.one(
      `SELECT COALESCE(MAX(retry_count),0) AS v FROM nodes WHERE task_id=?`, taskId).v,
  },
  'limit.node_reclaims': {
    on_hit: 'gate',
    def: 3, label: N_('单步骤异常中断次数'), fmt: String,
    // ── 为什么这一维与 node_retries 分开 ──────────────────────────────────
    // 例如厂商连回两次 403，进程两次死在同一节点手里，启动时的认领各记一次重试，
    // 就会撞 node_retries=2 —— 闸门叫了人，但理由是错的：那不是节点难，是厂商挂了。
    // 重试是节点**自己**失败的预算；进程被外部打死是另一件事。分开数，叫人的理由才对。
    // 实测值按 node_reclaimed 审计行数算（每次启动认领一次就一行），取本任务各节点的最大值。
    read: (db, taskId) => db.one(
      `SELECT COALESCE(MAX(c),0) AS v FROM (
         SELECT count(*) AS c FROM audit_log a JOIN nodes n ON n.id=a.target_id
          WHERE a.action='node_reclaimed' AND n.task_id=? GROUP BY a.target_id)`, taskId).v,
    // advice 整段是一个字面量（N_ 登记给英文目录；写进事项正文时按内容语言取）
    advice: N_('建议：先检查宿主机与服务商，而不是步骤本身。\n该项统计进程在同一步骤上异常退出的次数（断电、OOM、Ctrl-C、服务商 5xx 重试耗尽均计入）；连续发生通常是环境问题（某条命令耗尽宿主机内存、服务商持续故障），而不是步骤规格有问题。\n请先查看 replay 中 node_crashed / provider_error 的 message，更换服务商（--bind）或修复环境后，再考虑调整此上限。'),
  },
  'limit.draft_rounds': {
    on_hit: 'gate',
    // 追问器的寿命次数：每次 `cli draft` 一次。想法追问不收敛（问了又问、改了又改）也是一种烧钱，
    // 触顶就问人 —— 要么加额，要么人自己把宪法块写出来。
    def: 6, label: N_('追问轮次'), fmt: String,
    read: (db, taskId) => db.one(
      `SELECT count(*) AS v FROM audit_log WHERE action='elicitor_started' AND target_id=?`, taskId).v,
  },
  'limit.idle_cycles': {
    on_hit: 'gate',
    def: 5, label: N_('连续无进展轮次'), fmt: String,
    // 资源上限抓不住"在花钱但不在前进"。这一维的实测值不在库里 ——
    // 它是本次编排器寿命内的计数，由调用方经 ctx 传入。
    read: (_db, _taskId, ctx) => ctx?.idleCycles ?? 0,
  },
  'limit.context_tokens': {
    on_hit: 'gate',
    def: 150_000, label: N_('单次请求上下文长度'), fmt: (n, lang = 'zh') => `${(n / 1000).toFixed(1)}k ${lang === 'en' ? 'tokens' : 'token'}`,
    // ── 为什么补这一维 ──────────────
    // 实测：节点上下文峰值 106k / 200k 窗口 = 53%，从没触发过 75% 驱逐阈值。
    // 也就是说**上下文压缩现在没有证据支撑**，不该做。
    //
    // 但同一组数照出了另一件事：现在挡住上下文爆掉的是 `maxIterations=20`——
    // 每次工具调用约涨 6.2k，17 次到 106k，20 次约 125k。把 maxIterations 调到 30
    // （对更难的任务是完全合理的动作）就是约 190k，直接撞窗口。
    // **那是一道意外的护栏：它挡住了一个它并不知道自己在挡的东西。**
    // 它没有名字、没有断言、不在这张表里，改它的人不会知道自己同时改掉了
    // 上下文天花板；撞上之后的表现是厂商 400 或 stopped='context_exceeded'，
    // 归因方向指向"请求构造错了"。这一维就是给那道无名护栏一个名字。
    //
    // 150k = 200k 窗口的 75%（驱逐阈值），是**没有模型信息时的保守常数**。
    // 按模型封顶：MODEL_CATALOG[key].contextWindow 填了（只填厂商文档核实过的）就取
    // 窗口 × 75% 与本值的较小者 —— 见 contextCapOf。没填的模型仍是这个常数，绑小窗口
    // 模型时要手动调低；别在这里猜数字填目录。
    //
    // 实测值是**本次编排器寿命内见过的峰值**，由调用方经 ctx 传入。
    // 不用"全任务历史峰值"：某个节点峰过一次不该永久毒化这个任务 ——
    // 那和 node_retries 不同，重试次数是节点的持久属性，上下文峰值是一个过去的瞬间。
    read: (_db, _taskId, ctx) => ctx?.peakContextTokens ?? 0,
    advice: N_('建议：上下文达到上限时，通常不应选择 (A) 提高上限。\n某类步骤频繁达到上下文上限，说明规划粒度过粗，应在细化步骤时将其拆小，而不是依赖压缩上下文。\n请先判断该步骤能否拆成两步；确实无法拆分时（例如必须一次读完一份大规格）再提高上限，并确认所分配模型的上下文窗口足够（本上限不随模型自动调整）。'),
  },
  // 不设 'limit.egress.groups'（放行几类软件源的上限）：它拦的是人自己的放行动作（名单只有人能改），
  // 再让同一个人确认一遍；数量也表达不了风险（npm+GitHub 与 PyPI+crates 都是 2 类）。放行哪些由项目联网的勾选表达。
  'limit.egress.consecutive_denials': {
    on_hit: 'gate',
    def: 3, label: N_('联网请求连续被拒次数'), fmt: String,
    // ── 为什么补这一维（宪法块：出网相关的两维接进触顶体系）───────────────────
    // egress.groups 抓的是**授权侧**：人把面开到了上限，该确认。这一维抓的是
    // **执行侧的同一条裂缝**：任务反复去撞白名单外的网络面（每次被拒都落一条
    // egress_denied 审计）。一次两次可能是工具链误探；**连续**被拒 N 次说明这个
    // 任务要去的网络面和计划放行的不一致 —— 处置是停下来问人（放行对应生态 /
    // 改计划），不是把次数上限调高让它在同一堵墙上多撞几遍。
    //
    // 比较语义与其他维同形：**连续被拒次数 ≥ 上限即触顶**。
    // 实测值**持久化于 params**（键 egress.consecutive_denials，
    // 值 {offset, streak, hosts}）：推进由 egress.mjs 的 advanceConsecutiveDenials 在编排器每次体检前做并写回，
    // 这里 read 直读 params，不经 ctx。**跨进程累计**：守护进程每次复工都是新进程，进程内计数会让
    // "每个进程各撞 N-1 次"永远不触顶；游标也在 params 里，旧行不重数。**一次成功出网归零**并写回。
    read: (db, taskId) => egressDenialStateOf(db, taskId).streak,
    advice: N_('建议：联网请求连续被拒时，通常不应提高此上限。\n连续被拒说明任务要访问的范围与已放行的范围不一致：要么缺少应放行的软件源分组（在 replay 中查看连续被拒的域名及其所属分组），要么任务在访问不应连接的域名（应暂停并由人判断其意图）。\n请由人查看记录后决定：放行对应分组，或修改计划使任务在已放行范围内完成；仅提高次数上限只会让同样的请求再被拒几次。'),
  },
  'limit.memory_bytes': {
    on_hit: 'hard_fail',
    def: 1024 ** 3, label: N_('容器内存上限'), fmt: fmtGiB,
    // ── 为什么这一维是**硬边界** ──
    // 最初的设想是"把它搬进预算体系，超限 = 触顶 = 强制升级"。搬进来之后
    // 撞出来的现实是：内存撞顶的表现是**容器被 OOM kill** —— 任务进程当场没了，
    // 没有什么"降级继续"可走。能把自己顶到 OOM 的任务已经失控或泄漏（死循环里
    // 累积状态、一次性把整个仓库读进内存、子进程不回收），给它加额只是在放大
    // 宿主上的爆炸半径。所以它归**硬边界类**：撞顶 = 记一条审计
    // 事件后硬失败，不给加额建议、不走提问/降级分支。
    //
    // 实测值是**本次编排器寿命内见过的容器内存峰值**，由调用方经 ctx 传入（与
    // idle_cycles / peakContextTokens 同一形态）—— 库里没有存实时用量的表，而峰值是
    // 编排器轮询容器状态能拿到的最接近"这一维"的数。强制逻辑在编排器/容器侧
    // （按 on_hit='hard_fail' 分流），这里只定义维度与类别。
    read: (_db, _taskId, ctx) => ctx?.peakMemoryBytes ?? 0,
    advice: N_('该项是硬边界，不支持追加：达到上限时容器已被 OOM kill，属于任务自身失控或泄漏，给失控的任务更多内存只会放大宿主机的内存风险。\n达到上限时编排器记录一条审计事件后直接失败，不提问，也不给出追加建议。\n请先检查最近几条命令与进程树，确认任务在做什么、为何耗尽内存，并修复任务本身。'),
  },
  'limit.pids': {
    on_hit: 'hard_fail',
    def: 512, label: N_('容器进程数上限'), fmt: String,
    // ── 为什么这一维是**硬边界**（同上）────────────
    // 与内存同一条道理：pids 撞顶的表现是容器被 pids-limit 掐死 —— 进程被内核杀掉，
    // 没有可降级的状态。能攒满 PID 槽的任务几乎总是失控（并发开得太狠、fork 循环、
    // 僵尸堆积），加进程槽不是答案。归**硬边界类**：撞顶 = 记一条审计事件后硬失败。
    // 实测值是本次编排器寿命内见过的容器内进程数峰值，由调用方经 ctx 传入。
    read: (_db, _taskId, ctx) => ctx?.peakPids ?? 0,
    advice: N_('该项是硬边界，不支持追加：达到上限时容器内进程已被 pids-limit 终止，属于任务自身失控或泄漏，常见原因是并发过高、fork 循环或僵尸进程堆积（超时命令遗留僵尸进程的问题已由 --init 修复，但并发失控仍会占满 PID）。\n达到上限时编排器记录一条审计事件后直接失败，不提问，也不给出追加建议。\n请先检查进程树，确认是哪个进程在 fork、为何失控，并修复任务本身。'),
  },
};

/**
 * 本任务此前各次编排器寿命的运行时长之和。
 *
 * **数据源是审计轨**（`orchestrator_exit` 的 payload.elapsedMs），不是某张状态表。
 * 这是有意的：系统要求只凭审计轨 + 状态库就能复盘，那就该有东西真的依赖审计轨活着。
 * 一条只被人读、不被代码读的轨迹，烂掉了也没人会发现。
 */
export function priorRuntimeMs(db, taskId) {
  return db.all(`SELECT payload FROM audit_log WHERE target_id=?
                   AND action IN ('orchestrator_exit','planner_exit')`, taskId)
    .reduce((sum, r) => sum + (JSON.parse(r.payload || '{}').elapsedMs ?? 0), 0);
}

// ── 三层继承 ────────────────────────────────────────────────────────
// 部署默认（代码里的 LIMITS[key].def）→ 项目默认（params 项目层）→ 任务覆盖（params 任务层）。
// **部署这一层不可设**：它就是代码常数。三层里最上面一层不落库是有意的 —— 内置天花板是最后一道
// "绝不退化成无上限"的保障，它该随代码走版本、随代码被评审，而不是某次误点之后变成 10 倍。
// 想改部署默认就改代码并留下 diff。
//
// 每个旋钮都要能说清"当前值 + 来自哪一层"（照注册表三层的形态）。所以对外的主函数是 limitChain，
// 它返回三层的原始值；limitOf 只是取其中的 value。别在别处另写一遍这个回落顺序。

// ⚠️ `Number(null) === 0`。这一层没设过（getParam 给 null）和这一层设成了 0 必须分得开 ——
// 混在一起的表现是每个任务一开跑就报"花费已达上限：$0.0000，上限 $0.0000"。
const paramLimit = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/**
 * 某个上限项的三层。任务不在项目里时 project 恒为 null。
 * @returns {{value:number, source:'task'|'project'|'deploy', deploy:number, project:number|null, task:number|null}}
 */
export function limitChain(db, taskId, key) {
  const deploy = LIMITS[key].def;
  const task = paramLimit(getParam(db, taskId, key));
  const projectId = taskId ? db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null : null;
  const project = projectId ? paramLimit(getProjectParam(db, projectId, key)) : null;
  const value = task ?? project ?? deploy;
  return { value, source: task !== null ? 'task' : project !== null ? 'project' : 'deploy', deploy, project, task };
}

/** 当前生效的上限值。没设过就一层层回落到内置天花板 —— **绝不退化成"无上限"**。 */
export const limitOf = (db, taskId, key) => limitChain(db, taskId, key).value;

export const LAYER_NAMES = { deploy: N_('部署默认'), project: N_('项目默认'), task: N_('本任务') };

/** 某个项目的全部上限旋钮：每项给三层与生效值，给设置页直接用。label 是中文原文（看板 T(label) 翻）；数值文字按 lang 写。 */
export const projectLimits = (db, projectId, lang = 'zh') => Object.entries(LIMITS).map(([key, d]) => {
  const project = paramLimit(getProjectParam(db, projectId, key));
  return { key, label: d.label, onHit: d.on_hit, deploy: d.def, project,
    value: project ?? d.def, source: project !== null ? 'project' : 'deploy',
    deployText: d.fmt(d.def, lang), valueText: d.fmt(project ?? d.def, lang) };
});

/**
 * 设一个**项目默认**上限。`value === null` = 清掉，回落到部署默认。
 * 与 setLimit 一样是宪法层参数（库层 CHECK 只许人写）；权限是项目负责人 —— 调用方保证。
 */
export function setProjectLimit(db, { projectId, key, value, userId }) {
  if (!LIMITS[key]) throw new I18nError('上限项无效：{key}（应为 {keys}）', { key, keys: Object.keys(LIMITS).join(' / ') });
  if (value !== null && !(Number.isFinite(Number(value)) && Number(value) > 0)) throw new I18nError('{label}：值要是正数（清空则回落到部署默认）', { label: tlN(contentLang(db), LIMITS[key].label) });
  const v = value === null ? null : Number(value);
  return db.tx(() => {
    const id = setProjectParam(db, { projectId, key, value: v, by: { kind: 'user', id: userId }, governance: 'constitutional' });
    audit(db, { actorKind: 'user', actorId: userId, action: 'project_limit_set', targetType: 'project', targetId: projectId,
      payload: { key, value: v, cleared: v === null } });
    return id;
  });
}

/** 窗口的多少作为上限：75% 驱逐阈值。 */
export const CONTEXT_WINDOW_RATIO = 0.75;
/**
 * `limit.context_tokens` 的**生效值**：人设的 / 默认的上限，再按所绑模型的窗口封顶。
 * 模型窗口来自 MODEL_CATALOG[key].contextWindow（只填厂商文档核实过的；没填 = 不封顶，退回常数）。
 * 返回 { cap, source, window }：source = 'param' | 'default' | 'model'，给触顶文案说清是哪道墙。
 */
export function contextCapOf(db, taskId, { contextWindow = null } = {}) {
  const chain = limitChain(db, taskId, 'limit.context_tokens');
  const byModel = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow * CONTEXT_WINDOW_RATIO) : null;
  if (byModel !== null && byModel < chain.value) return { cap: byModel, source: 'model', window: contextWindow };
  // 'param' 含项目默认：对触顶文案来说"人设过的"与"内置常数"才是要分开的两件事。
  return { cap: chain.value, source: chain.source === 'deploy' ? 'default' : 'param', window: contextWindow, layer: chain.source };
}

/**
 * 全维度体检。
 * @returns {null | {key, label, limit, actual, human}}  第一个触顶的维度
 */
export function checkLimits(db, taskId, ctx = {}) {
  for (const [key, d] of Object.entries(LIMITS)) {
    const limit = limitOf(db, taskId, key);
    const actual = d.read(db, taskId, ctx);
    if (actual >= limit) {
      const L = contentLang(db);
      return { key, label: d.label, limit, actual,
        human: tl(L, '{label}已达上限：当前 {actual}，上限 {limit}', { label: tlN(L, d.label), actual: d.fmt(actual, L), limit: d.fmt(limit, L) }) };
    }
  }
  // 项目预算闸：**跨任务累计**，所以它不在 LIMITS 表里（那张表每一维都按任务算）。
  // 排在最后：任务自己的闸门先说话，说不出问题再看项目总账 —— 触顶文案里"该改哪个旋钮"才不会指错。
  const projectId = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;
  if (projectId) {
    const b = budgetState(db, projectId);
    if (b.over) {
      return { key: BUDGET_KEY, scope: 'project', projectId, label: N_('项目累计花费'), limit: b.gate, actual: b.spent,
        human: tl(contentLang(db), '项目累计花费已达预算闸：{state}', { state: b.human }) };
    }
  }
  return null;
}

/**
 * 设一个上限。宪法层参数 —— 库层 CHECK 保证 `set_by_kind='user'`，agent 结构上改不了。
 */
export function setLimit(db, { taskId, key, value, userId }) {
  if (!LIMITS[key]) throw new I18nError('上限项无效：{key}（应为 {keys}）', { key, keys: Object.keys(LIMITS).join(' / ') });
  // 上限是"预算上限"决策类型：谁能改查路由表，不查 role —— 否则旋钮可调但不生效。
  if (userId) requireAuthorized(db, { taskId, decisionType: 'budget', userId });
  const t = now();
  return db.tx(() => {
    db.run(`UPDATE params SET superseded_at=?, valid_to=? WHERE task_id=? AND key=? AND superseded_at IS NULL`,
      t, t, taskId, key);
    const id = newId('p');
    db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,
              valid_from,recorded_at) VALUES (?,?,?,?,'task','constitutional','user',?,?,?)`,
      id, taskId, key, JSON.stringify(value), userId, t, t);
    audit(db, { actorKind: 'user', actorId: userId, action: 'limit_set',
      targetType: 'task', targetId: taskId, payload: { key, value } });
    return id;
  });
}

/**
 * 触顶 → 一条 Ⅲ 级问题 + 任务冻结。**全程零 LLM 调用。**
 *
 * 问题正文由模板拼出来，因为它必须在"预算已经花光"的前提下仍然能产生 ——
 * 见本文件头 ②。正文写清三条出路（加额 / 中止 / 改上限），让人一句话能答。
 *
 * ⚠️ 只接 **on_hit='gate'**（触顶类）的维度。硬边界类（on_hit='hard_fail'，
 * 容器内存 / 进程数）撞顶 = 容器被 OOM / pids-limit kill，任务已经失控，走的是
 * "记一条审计事件后硬失败"，**不进这条提问路径** —— 分流由编排器/容器侧按 on_hit 做。
 */
/** 这条上限事项是为哪一项上限挂的（limit_breached 审计里记着事项 id 与上限项）。项目预算闸那种没有 → null。 */
const limitKeyOf = (db, questionId) => {
  const a = db.one(`SELECT payload FROM audit_log WHERE action='limit_breached' AND json_extract(payload, '$.questionId')=? ORDER BY id DESC LIMIT 1`, questionId);
  return a ? JSON.parse(a.payload).key ?? null : null;
};

// 上限事项的收件前检查：负责人在上限格里填了数却没点保存，就回"已经调高了"；任务照样被拉起、
// 一起来就又撞同一个上限、再挂一条一样的事项 —— 人每答一次多一条，很快就涨成十几条。
// 所以这条事项只收"调高并保存之后的 A"：上限还超着就当场拒收、说清楚去哪儿改；中止 / 先看看都不是答复能做的事。
ANSWER_GUARDS.budget = (db, { question, body }) => {
  const key = limitKeyOf(db, question.id);
  const d = key ? LIMITS[key] : null;
  if (!d) return;                                          // 项目预算闸那条走它自己的规矩
  const s = String(body ?? '').trim();
  const pick = /^[（(]?\s*([ABCabc])(?![A-Za-z])/.exec(s)?.[1]?.toUpperCase() ?? null;
  if (pick === 'B' || /^(中止|不跑|abort|stop|cancel)/i.test(s)) throw new I18nError('中止不能靠答复：到任务页点「中止」（产物与记录都保留）。中止之后这条事项自动了结，不用再答');
  if (pick === 'C') throw new I18nError('(C) 是"先看看经过"，不是结论：看完「活动」「日志」再回来 —— 调高上限并保存后回 A，或者到任务页点「中止」');
  if (pick !== 'A') throw new I18nError('上限事项只收「A」：先到任务页最下面的「上限」里把它调高、点那一行的「保存」，再回 A；不跑了就到任务页点「中止」');
  const limit = limitOf(db, question.task_id, key);
  const actual = d.read(db, question.task_id, { startedAt: now() });
  if (actual >= limit) {
    // 参数（上限名、数值）按内容语言填：报错模板由服务端按看的人的语言翻，参数翻不了
    const L = contentLang(db);
    throw new I18nError('「{label}」还没调高：现在是 {actual}，上限还是 {limit}。先到任务页最下面的「上限」里把「{name}」那一行改大、点那一行的保存按钮，再回 A —— 不然任务一接着跑就又停在这里',
      { label: tlN(L, d.label), actual: d.fmt(actual, L), limit: d.fmt(limit, L), name: tlN(L, uiName(key)) });
  }
};

export function raiseLimitQuestion(db, { taskId, nodeId = null, breach }) {
  // 同一任务、同一项上限已经有一条开着的事项：不再挂第二条（否则同一条"单步骤重试次数已达上限"会挂出好几条）
  if (breach.scope !== 'project') {
    const open = db.all(`SELECT id, text FROM questions WHERE task_id=? AND decision_type='budget' AND status IN ('open','escalated') ORDER BY asked_at`, taskId)
      .find((q) => limitKeyOf(db, q.id) === breach.key);
    if (open) {
      db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
      return { questionId: open.id, text: open.text, reused: true };
    }
  }
  // 项目预算闸走它自己的那一条（正文说的是项目，出路是改闸门 / 中止项目 / 撤闸门，
  // 而且一个项目只报一次 —— 每个任务各报一条会把收件箱刷满）。冻住任务这一步在下面统一做。
  if (breach.scope === 'project') {
    const q = raiseProjectBudget(db, { projectId: breach.projectId, taskId });
    db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
    return { questionId: q.questionId, text: q.text ?? null };
  }
  const t = now();
  const id = newId('q');
  // ⚠️ 建议按维度给，不给统一模板。对花费/时长来说"加额继续"通常是对的；
  // 对上下文体量来说它通常是**错的** —— 某类节点频繁触及阈值应视为
  // 规划粒度过粗，该在节点细化时拆小，"用结构解决的问题不用压缩解决"。
  // 把两者写成同一句"提高上限继续"，等于把一个信号翻译成了一个旋钮。
  const L = contentLang(db);
  const advice = LIMITS[breach.key]?.advice ? tlN(L, LIMITS[breach.key].advice) : undefined;
  const name = tlN(L, uiName(breach.key));
  // 来自哪一层要写在正文里：撞的是项目默认还是这个任务自己设的，处置完全不同
  // （项目默认 = 这个项目的每个任务都会撞，该去改项目设置；任务覆盖 = 只有它特殊）。
  const chain = limitChain(db, taskId, breach.key);
  const from = chain.source === 'task' ? tl(L, '本任务单独设过')
    : chain.source === 'project' ? tl(L, '本项目的默认值（部署默认是 {deploy}）', { deploy: LIMITS[breach.key].fmt(chain.deploy, L) })
      : tl(L, '部署默认（本项目与本任务都没有单独设过）');
  const text = `${markOf(L, 'limit')}${breach.human}\n\n`
    + `${tl(L, '这个上限来自：{from}。', { from })}\n`
    + `${tl(L, '任务已暂停，不再消耗资源。本事项由系统直接生成，未调用模型。')}\n\n`
    + (advice ? `${advice}\n\n` : '')
    // 选项并列摆着，人会以为"回个字母"就是完成了操作 —— 把"操作在任务页上"放到选项前面
    + `${tl(L, '**在这里回复只是确认，真正的操作在任务页上**：要继续，先去任务页最下面的「上限」把「{name}」那一行调高并保存，再回 A；不跑了，就去任务页点「中止」。', { name })}\n\n`
    + `${tl(L, '请选一条：')}\n`
    + `(A) ${tl(L, '提高上限后继续：到任务页最下面的「上限」里把「{name}」那一行调高、点那一行的保存按钮，再回这条「A」—— 任务接着跑。只回 A 不调高，任务会马上又停在这里', { name })}\n`
    // 答复里写"中止"不算数（与"交回给人"那几种同一条规矩）：中止不可逆，要人自己在任务页点。
    // （例：负责人回了 B（中止），任务却照常又起了一轮 —— 旧措辞让人以为回 B 就会中止。）
    + `(B) ${tl(L, '不跑了：到任务页点「中止」（产物与记录都保留）。答复里写"中止"不算数 —— 这一步不可逆，得你自己去点')}\n`
    + `(C) ${tl(L, '先看看经过：到任务页看「活动」和「日志」，看完再回来在 A / B 里选')}`;

  // 出处边：这条问题**因为哪条上限**而存在。显式设过就指向那条 params 行
  // （连带指向设它的人），没设过就指向宪法块 —— 内置天花板的权威根只能是宪法层。
  // 没有 `about_task` 这种关系，也不该为此新加一个：`derived_from` 正是出处边。
  // 三层之后这条边要指对那一层：任务层指任务的 params 行，项目层指项目的 params 行，
  // 部署层没有行可指 —— 仍指宪法块。指错了等于把"谁定的这个数"说错。
  const origin = (chain.source === 'task'
    ? db.one(`SELECT id FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL
              ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, taskId, breach.key)?.id
    : chain.source === 'project'
      ? db.one(`SELECT id FROM params WHERE project_id=(SELECT project_id FROM tasks WHERE id=?) AND task_id IS NULL
                AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, taskId, breach.key)?.id
      : null)
    ?? db.one(`SELECT id FROM constitutions WHERE task_id=? AND superseded_at IS NULL
               ORDER BY version DESC LIMIT 1`, taskId)?.id;

  return db.tx(() => {
    // Ⅲ 级：无默认动作、无超时。库层 CHECK 也会这么要求 —— 这里写死是为了
    // 让"硬规则定级"这件事在代码里看得见，不是靠 CHECK 兜底才碰巧对。
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,
              asked_at,timeout_at,status) VALUES (?,?,?,3,'hard_rule',?,NULL,?,NULL,'open')`,
      id, taskId, nodeId, text, t);
    if (origin) insertEdge(db, id, origin, 'derived_from', t);
    if (nodeId) insertEdge(db, id, nodeId, 'about_node', t);
    routeQuestion(db, { questionId: id, decisionType: 'budget', typeSource: 'hard_rule', at: t });
    db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
    audit(db, { actorKind: 'system', action: 'limit_breached', targetType: 'task', targetId: taskId,
      payload: { pid: process.pid, questionId: id, nodeId, ...breach } });
    return { questionId: id, text };
  });
}
