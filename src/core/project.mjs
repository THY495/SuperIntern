// 项目层：一批契约，按**依赖图**组织、串行调度（此前是 project_order 的线性链）。
//
// 依赖图：
//   - 任务之间的依赖记在任务的 `task.depends_on` 参数里，值是**任务编号**（project_order）的数组 —— 不是任务 id：
//     重做（lifecycle.redoProjectTask）沿用旧任务的编号，边不用改。没有这个参数的旧任务 = 依赖所有编号比它小的（等价于原来的线性链）。
//   - project_order 从此只是编号（显示与引用用），不再决定执行顺序。
//   - **调度仍是串行**：同一时间只有一个任务开着（有工作区、未合并、未中止）。开着的任务合并后，从"依赖都已合并"的任务里挑编号最小的开工。
//     被中止的任务只阻塞它的下游，别的任务照常推进；没有任何任务能推进时项目才 stalled。
//   - 回归义务在**开工那一刻**定：= 当时集成分支上所有已合并任务的验收命令（开工时覆盖建任务时按编号预填的那份）。
//   - 基线漂移提示：契约批准之后、开工之前，有**不在它依赖闭包里**的任务合并过 → 把那些任务与改动的文件记进 `task.drift_note`，任务规划器会读到。
//     纯机械、不调模型、不拦：矛盾由规划 / 执行时的"结构矛盾"提问兜底。
//   - "等人时让路"（同时开两个任务 + 集成）见下文「让路」一节。
//
// 结论来自先手工串一次：**先做串接机制，规划器后做**。三次串接 12 条手工命令全部一次过，
// 疼的是"该做的时候没人做"。所以这里做的就是那 4 条命令的自动化：
//   任务 N done + 人签收 → deliver 到项目仓库 → 项目分支 ff 合并 → 从项目分支建任务 N+1 的工作区（守护进程随后拉 plan）。
//
// 三条边界：
//   - **项目不是第二个状态机**。契约就是普通任务（宪法块 + 验收命令），执行器 / 验收员 / 汇报 / 看板对"项目"一无所知。
//     项目只多三列（project_id / project_order / merged_at）和一张 projects 表。
//   - **交接 = 仓库 + README + 契约里写死的接口名**，不传汇报。agent 一定会读前一任务的源码，
//     所以前一任务的代码必须在工作区里 —— 从项目分支克隆已经满足。
//   - **回归义务机械化**：任务 N 的验收 = 自己的 verify_command + 前面所有任务的 verify_command（`task.verify_extra`，
//     宪法层参数，由这里自动拼，不靠人记得写进契约）。
//
// 没做（有意）：模型写整批契约的项目规划器（`project new --file` 由人给 JSON，等于"整批批一次"）；任务 done 后的重规划
// （目前没有证据说它常被需要，留位）；并行任务。

import { applyEgressDefaults } from './egress.mjs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { newId, now, audit, insertEdge } from '../db/db.mjs';
import { ensureWorkspace, workspaceStatus, isBuildOutput, discardChanges, describeChanges } from './workspace.mjs';
import { handbackHook, openHandback, raiseDirtyWorkspace } from './handback.mjs';
import { deliverTask, signoffOf, finalReport, parseGithub, pushEnv, doneHeadOf, signoffHeadOf, raiseSignoffQuestion } from './deliver.mjs';
import { verifyCommandProblems } from '../agent/elicitor.mjs';
import { validateRules, renderRules, normalizeQuote, foldRules } from './rules.mjs';
import { setLimit } from './limits.mjs';
import { getParam, setParam } from './params.mjs';
import { recordFromContract, recordGoalChange } from './decisions.mjs';
import { budgetState, raiseProjectBudget, projectVerifyCommand, deferredSignoffs, maxOpenOf, effectiveSetupOf, runSetupCommands } from './project-settings.mjs';
import { routeQuestion, prefixesOfScope, filesOfScope, prefixesOfPaths, filesOfPaths, scopePathProblems, normScopePaths, renderScopePaths, SCOPE_PATHS_NOTE } from './routing.mjs';
import { waitingOnHuman } from './addressee.mjs';
import { RESOLUTION_HOOKS } from './answers.mjs';
export { validateRules, renderRules, normalizeQuote };
// 结构化范围的三个纯函数住在 routing.mjs（scope 那一族的家，且是叶子：elicitor 也要用，从这里取会成环）。
export { scopePathProblems, normScopePaths, renderScopePaths, SCOPE_PATHS_NOTE };

const gitEnv = (cwd, env, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, env,
}).trim();
const git = (cwd, ...args) => gitEnv(cwd, { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, ...args);
/** 原样的字节（取索引里的 blob 用）—— `git()` 会 trim，行尾一 trim 内容就变了。 */
const gitBuf = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
});

export const PROJECT_TASK_RUNTIME_MS = 3 * 60 * 60 * 1000;
export const projectDir = (home, projectId) => join(home, 'projects', projectId);
export const projectBranch = (projectId) => `superintern/${projectId}`;

/** 校验项目 JSON：{ title, brief?, tasks: [{ title, goal, scope?, definition_of_done, rules?, constraints?, verify_command }] } */
/**
 * `deps`：{ startOrder, existing: [{ order, started, dependsOn }] } —— 给了才校验 depends_on / blocks：
 *   depends_on 只能指向已有任务或本草案里**编号更小**的任务（构造上无环）；blocks（让某个已有任务等本任务）只能指向未开工的已有任务，且不能成环。
 */
export function validateProjectSpec(spec, { brief = null, requireRules = false, deps = null } = {}) {
  const errs = [];
  if (!spec || typeof spec !== 'object') return ['项目 JSON 不是对象'];
  if (!spec.title?.trim()) errs.push('缺 title');
  if (!Array.isArray(spec.tasks) || !spec.tasks.length) errs.push('tasks 要是非空数组');
  for (const [i, t] of (spec.tasks ?? []).entries()) {
    const at = `tasks[${i}]`;
    for (const f of ['title', 'goal', 'definition_of_done']) if (!t?.[f]?.trim?.()) errs.push(`${at} 缺 ${f}`);
    if (!t?.verify_command?.trim?.()) errs.push(`${at} 缺 verify_command（项目里每个任务都要有机械验收，后面的任务要把它累加进回归义务）`);
    else for (const p of verifyCommandProblems(t.verify_command)) errs.push(`${at} verify_command：${p}`);
    if (t?.constraints !== undefined && !Array.isArray(t.constraints)) errs.push(`${at} constraints 要是数组`);
    errs.push(...scopePathProblems(t?.scope_paths).map((p) => `${at}.scope_paths：${p}`));
    // 与 rules 同一道门槛：模型走的路要求给，人手写 JSON 建的项目不要求（回落到从散文里抽）。
    if (requireRules && !normScopePaths(t?.scope_paths).length) {
      errs.push(`${at} 缺 scope_paths：范围要用路径再写一遍（目录写成 src/a/，文件写全名），机器按这一份做越界校验；整个仓库都可能动就写 ["*"]`);
    }
    if (t?.rules !== undefined) errs.push(...validateRules(t.rules, { brief, at: `${at}.rules` }));
    else if (requireRules) errs.push(`${at} 缺 rules：完成定义里的每条行为规则都要单列进 rules，带 quote（逐字引规格）或 assumption`);
    if (requireRules && Array.isArray(t?.rules) && !t.rules.length) errs.push(`${at}.rules 为空：至少把完成定义里的行为规则列出来并给出处`);
  }
  if (deps && Array.isArray(spec.tasks)) errs.push(...validateDeps(spec.tasks, deps));
  return errs;
}

const intList = (v) => Array.isArray(v) && v.every((n) => Number.isInteger(n) && n > 0);
/** 依赖闭包：`graph` = Map(order → [order])。返回 order 的全部上游（不含自己）。 */
export function closureOf(graph, order) {
  const seen = new Set(); const stack = [...(graph.get(order) ?? [])];
  while (stack.length) { const n = stack.pop(); if (seen.has(n)) continue; seen.add(n); stack.push(...(graph.get(n) ?? [])); }
  return seen;
}
function validateDeps(tasks, { startOrder = 1, existing = [] }) {
  const errs = [];
  const exist = new Map(existing.map((e) => [e.order, e]));
  const graph = new Map(existing.map((e) => [e.order, e.dependsOn ?? []]));
  tasks.forEach((t, i) => {
    const at = `tasks[${i}]`, me = startOrder + i;
    const d = t?.depends_on;
    if (d !== undefined && !intList(d)) errs.push(`${at}.depends_on 要是任务编号（正整数）的数组；不依赖任何任务写 []`);
    else for (const n of d ?? []) {
      if (n === me) errs.push(`${at}.depends_on 不能包含自己（#${me}）`);
      else if (n > me) errs.push(`${at}.depends_on 的 #${n} 编号不小于本任务（#${me}）：只能依赖已有任务或本草案里排在前面的任务`);
      else if (n < startOrder && !exist.has(n)) errs.push(`${at}.depends_on 的 #${n} 不存在`);
    }
    graph.set(me, intList(d) ? d : defaultDeps(me, startOrder, existing));
    const b = t?.blocks;
    if (b !== undefined && !intList(b)) errs.push(`${at}.blocks 要是已有任务编号的数组`);
    else for (const n of b ?? []) {
      const e = exist.get(n);
      if (!e) errs.push(`${at}.blocks 的 #${n} 不是已有任务（blocks 只用于让**已有的、还没开工的**任务等本任务）`);
      else if (e.started) errs.push(`${at}.blocks 的 #${n} 已经开工或已结束，不能再让它等别的任务`);
      else if (closureOf(graph, me).has(n)) errs.push(`${at}.blocks 的 #${n} 是本任务的上游（本任务依赖它），再让它等本任务就成环了`);
      else graph.set(n, [...(graph.get(n) ?? []), me]);
    }
  });
  return errs;
}
/** 依赖一行：给人看的。`order` = 本任务编号，`startOrder` = 本草案第一个任务的编号。 */
export function renderDeps(t, order, startOrder) {
  const d = Array.isArray(t.depends_on) ? t.depends_on : (order > startOrder || order > 1 ? [order - 1] : []);
  const s = d.length ? d.map((n) => `#${n}`).join('、') : '无（不等其他任务）';
  return s + (Array.isArray(t.blocks) && t.blocks.length ? `；并让 ${t.blocks.map((n) => `#${n}`).join('、')} 等本任务完成后再开工` : '');
}

/**
 * 「可能同时开着、而且声明要动同一处」—— 批准页上的预警。
 *
 * **不是闸门，是预警。** 做成闸门会把让路的收益整个清零：让路本来就只在互相独立的任务之间发生，
 * 而互相独立又恰好是这条检查报出来的前提。人接受这个风险是正当的选择，系统的职责是让他知道有这回事。
 *
 * 判据全是现成数据、零模型：
 *   - **同一批**：这一版草案里的任务。不同批次之间不看 —— 后一批定稿时前一批早合并了，不可能同时开着。
 *   - **依赖图上互不可达**：谁也不是谁的（间接）依赖。有依赖关系就一定有先后，不可能同时开着。
 *   - **声明的范围相交**：目录前缀互为前缀，或点名了同一个根目录文件。
 *
 * ⚠️ 精度上限来自 `prefixesOfScope` —— 它是一个**跑在自由文本上的正则抽取器**，出过事。
 * 在一份真实项目上这条检查 21 对里报 2 对、0 误报、两对都是真争用，
 * 但那个数字是那一份 scope 写法给的，不是这条规则给的。有了结构化 scope（`scope_paths`），
 * 这条预警与越界校验会**同时**变精确。
 */
export function scopeOverlaps(spec, { startAt = 1 } = {}) {
  const tasks = (spec?.tasks ?? []).map((t, i) => {
    // 结构化范围（v17）优先；没给就回落到从散文里抽 —— 那一层才是精度上限的来源。
    const structured = normScopePaths(t.scope_paths);
    return {
      n: startAt + i, title: t.title,
      deps: Array.isArray(t.depends_on) ? t.depends_on.map(Number) : null,
      pre: structured.length ? prefixesOfPaths(structured) : prefixesOfScope(t.scope),
      files: structured.length ? filesOfPaths(structured) : filesOfScope(t.scope),
    };
  });
  const byN = new Map(tasks.map((t) => [t.n, t]));
  const depsOf = (t) => t.deps ?? defaultDeps(t.n, startAt, []);
  const reaches = (a, b, seen = new Set()) => {
    if (seen.has(b)) return false;
    seen.add(b);
    const d = byN.has(b) ? depsOf(byN.get(b)) : [];
    return d.includes(a) || d.some((x) => reaches(a, x, seen));
  };
  const out = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const [a, b] = [tasks[i], tasks[j]];
      if (reaches(a.n, b.n) || reaches(b.n, a.n)) continue;
      const where = new Set();
      const under = (f, pre) => pre.some((q) => q === '*' || f === q || f.startsWith(`${q}/`));
      for (const p of a.pre) if (b.pre.some((q) => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`))) where.add(`${p}/`);
      for (const f of a.files) if (b.files.includes(f)) where.add(f);
      // 一侧要整个目录、另一侧点名了那个目录里的文件 —— 也是真争用。
      // 结构化之前这一档几乎不会发生（散文抽出来的"文件"只有根目录那几个），结构化之后它是常态。
      for (const f of a.files) if (under(f, b.pre)) where.add(f);
      for (const f of b.files) if (under(f, a.pre)) where.add(f);
      if (where.size) out.push({ a: a.n, b: b.n, aTitle: a.title, bTitle: b.title, where: [...where] });
    }
  }
  return out;
}

/**
 * 预警那一段的正文。**做成带动作的问句，不是一行灰字** —— 批准页已经是注意力过载的页面，
 * 而"摆在那儿但没要求做什么"的提示会被整段略过。
 */
export function renderScopeOverlaps(pairs) {
  if (!pairs?.length) return null;
  const L = [`⚠ 范围重叠（机械检查，零模型）：下面 ${pairs.length} 对任务在依赖图上互不可达 —— 按上面那条调度规则，它们**可能同时开着**，而它们声明要动同一处。`];
  for (const p of pairs) L.push(`  - #${p.a}「${p.aTitle}」与 #${p.b}「${p.bTitle}」都声明要动：${p.where.join('、')}`);
  L.push('  同时改同一处 = 合并时大概率冲突，而解冲突要回头问你取哪一侧。要不要现在就处理？**在反馈里回一句就行**：');
  L.push(`    · 「把 #${pairs[0].b} 对 ${pairs[0].where[0]} 的改动并进 #${pairs[0].a}」—— 让一个任务负责那一处（最常用）`);
  L.push(`    · 「#${pairs[0].b} 依赖 #${pairs[0].a}」—— 排成先后，就不会同时开着（代价：不能让路了）`);
  L.push('    · 「知道了，就这样」—— 接受这个风险；真撞上了会按冲突那条路来问你取哪一侧');
  return L.join('\n');
}

/** 没写 depends_on 时的缺省：依赖前一个编号（线性，与引入依赖图之前一致）；没有前一个就不依赖。 */
function defaultDeps(order, startOrder, existing) {
  if (order > startOrder) return [order - 1];
  const prev = existing.map((e) => e.order).filter((n) => n < order);
  return prev.length ? [Math.max(...prev)] : [];
}

/**
 * 从契约建一个任务（与 cli new --file 同一份落库逻辑；多了 project 三列、verify_extra、depends_on）。
 * ⚠️ cli.mjs 的 cmdNew 里还有一份同样的 INSERT —— 改这里要同步改那里（记在 开发计划 债里）。
 */
export function createTaskFromSpec(db, spec, { userId, projectId = null, order = null, verifyExtra = [], dependsOn = null, batch = null }) {
  const verifyArgv = typeof spec.verify_command === 'string' ? spec.verify_command.trim().split(/\s+/) : null;
  // 规则连同出处落进完成定义：宪法块是规划器 / 执行器 / 验收员都读的那份文本，不另开字段。
  const dod = foldRules(spec.definition_of_done, spec.rules);
  const taskId = newId('t');
  const constId = newId('c');
  const t = now();
  db.tx(() => {
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,?,'planning',?,?,?)`,
      taskId, userId, spec.title, t, projectId, order);
    const param = (key, value) => db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
              VALUES (?,?,?,?,'task','constitutional','user',?,?,?)`, newId('p'), taskId, key, JSON.stringify(value), userId, t, t);
    if (verifyArgv?.length) param('task.verify_command', verifyArgv);
    if (verifyExtra.length) param('task.verify_extra', verifyExtra);
    if (projectId && Array.isArray(dependsOn)) param('task.depends_on', dependsOn);
    // 批次：同一次规划 / 添加里定稿的任务共用一个值。漂移提示靠它判断"这份契约定稿时，规划器知不知道那个任务"。
    if (projectId && batch !== null) param('task.batch', batch);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,scope_paths,definition_of_done,constraints,valid_from,recorded_at)
            VALUES (?,?,1,?,?,?,?,?,?,?)`,
      constId, taskId, spec.goal, spec.scope ?? '未限定', JSON.stringify(normScopePaths(spec.scope_paths)), dod, JSON.stringify(spec.constraints ?? []), t, t);
    audit(db, { actorKind: 'user', actorId: userId, action: 'task_created', targetType: 'task', targetId: taskId,
      payload: { title: spec.title, constitution: constId, ...(projectId ? { projectId, order } : {}) } });
    // 决定登记：契约是人批准过的，逐条进项目的约定清单（每条行为规则、范围、验收命令）。
    // 记在这里而不是"批准的那一刻"：项目里的任务本来就只在批准之后才被建出来，这就是契约生效的瞬间。
    recordFromContract(db, { taskId, spec, constitutionId: constId, userId, at: t });
  });
  // 项目里的任务比单任务大（JMESPath T5：两段累计 46.5 min 撞了 45 min 的默认时长上限，人来改上限）。
  // 项目层给 3 h；批准问题的页脚会写明，人在批准时看得到、可以事后 cli limit 改。
  if (projectId) setLimit(db, { taskId, key: 'limit.runtime_ms', value: PROJECT_TASK_RUNTIME_MS, userId });
  return { taskId, constId, verifyArgv };
}

/**
 * 建项目：克隆源仓库到 `<home>/projects/<id>/repo`，开项目分支，按顺序建全部任务（契约），给第一个任务建工作区。
 * 后面的每一步都是守护进程调 advanceProject 做的。
 */
/** 克隆源仓库到 `<home>/projects/<id>/repo` 并开项目分支。autocrlf 关掉（Windows 克隆写成 CRLF，容器里 git 一开始就报改动）。 */
export function initProjectRepo({ home, projectId, source, base = null, empty = false }) {
  const dir = projectDir(home, projectId);
  const repo = join(dir, 'repo');
  const branch = projectBranch(projectId);
  mkdirSync(dir, { recursive: true });
  // 从零开始（复现实验 / 新项目）：空仓库 + 一个空提交，后面"基线 = HEAD"、ff 合并、交付都照常成立。
  if (empty) {
    if (source) throw new Error('--empty 与 --source 只能给一个');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', branch);
    git(repo, '-c', 'user.name=superintern', '-c', 'user.email=superintern@local', 'commit', '-q', '--allow-empty', '-m', `init: ${projectId}`);
    return { repo, branch, baseRef: git(repo, 'rev-parse', 'HEAD'), source: null };
  }
  if (!source) throw new Error('要给 --source（项目仓库：本机路径或 URL）或 --empty（从零开始）');
  const src = existsSync(source) ? resolve(source) : source;
  // 克隆 / 检出失败不留半截目录（新建项目时当场克隆，路径或 URL 不对是常见的人为错误）。
  try {
    git(dir, '-c', 'core.autocrlf=false', 'clone', '--quiet', src, repo);
    if (base) git(repo, 'checkout', '-q', '--detach', base);
    git(repo, 'checkout', '-q', '-b', branch);
  } catch (e) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ }
    throw new Error(`仓库克隆失败：${String(e.stderr ?? e.message).trim().split('\n').at(-1)}`);
  }
  return { repo, branch, baseRef: git(repo, 'rev-parse', 'HEAD'), source: String(source) };
}

/**
 * 按顺序建整批契约任务，回归义务（前面任务的验收命令）自动累加。不套外层事务（db.tx 不支持嵌套）。
 * `seedExtra`（追加 / 接续）：这批任务之前已经存在的验收命令 —— 追加到在跑的项目时 = 链上此前全部任务的，接续时 = 原任务的。
 */
export function createProjectTasks(db, { projectId, userId, tasks, startOrder = 1, seedExtra = [] }) {
  const taskIds = [];
  const extra = [...seedExtra];
  const existing = chainGraph(db, projectId);
  const batch = now();
  for (const [i, ts] of tasks.entries()) {
    const order = startOrder + i;
    const dependsOn = intList(ts.depends_on) ? [...new Set(ts.depends_on)] : defaultDeps(order, startOrder, existing);
    const r = createTaskFromSpec(db, ts, { userId, projectId, order, verifyExtra: [...extra], dependsOn, batch });
    taskIds.push(r.taskId);
    if (r.verifyArgv) extra.push(r.verifyArgv);
    // blocks：让已有的、还没开工的任务等本任务 —— 只改调度边，不碰它的契约。
    for (const n of intList(ts.blocks) ? ts.blocks : []) {
      const target = existing.find((e) => e.order === n);
      if (!target || target.started) continue;   // 草案定稿后它已经开工了：不再让它等
      const next = [...new Set([...target.dependsOn, order])];
      db.run(`UPDATE params SET superseded_at=?, valid_to=? WHERE task_id=? AND key='task.depends_on' AND superseded_at IS NULL`, now(), now(), target.id);
      db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at) VALUES (?,?,?,?,'task','constitutional','user',?,?,?)`,
        newId('p'), target.id, 'task.depends_on', JSON.stringify(next), userId, now(), now());
      target.dependsOn = next;
      audit(db, { actorKind: 'user', actorId: userId, action: 'project_task_blocked', targetType: 'project', targetId: projectId, payload: { order: n, taskId: target.id, waitsFor: order } });
    }
  }
  return taskIds;
}

/** 链上任务的依赖图（按编号）：[{ id, order, status, merged_at, dependsOn, started }]。没有 depends_on 参数的旧任务 = 依赖所有编号更小的。 */
export function chainGraph(db, projectId, { home = null } = {}) {
  const rows = db.all(`SELECT id, title, status, project_order, merged_at FROM tasks WHERE project_id=? AND project_order > 0 ORDER BY project_order`, projectId);
  return rows.map((t) => {
    const d = getParam(db, t.id, 'task.depends_on');
    const dependsOn = Array.isArray(d) ? d.filter((n) => rows.some((r) => r.project_order === n)) : rows.filter((r) => r.project_order < t.project_order).map((r) => r.project_order);
    const started = !!t.merged_at || ['done', 'aborted'].includes(t.status) || (home ? existsSync(join(home, 'workspaces', t.id)) : !!db.one(`SELECT 1 FROM audit_log WHERE action='workspace_created' AND target_id=? LIMIT 1`, t.id));
    return { id: t.id, title: t.title, order: t.project_order, status: t.status, merged_at: t.merged_at, dependsOn, started };
  });
}

export function createProject(db, { userId, spec, source, home, base = null }) {
  const errs = validateProjectSpec(spec);
  if (errs.length) throw new Error(`项目 JSON 不合规：\n  - ${errs.join('\n  - ')}`);
  const projectId = newId('pj');
  const { repo, branch, baseRef } = initProjectRepo({ home, projectId, source, base });
  const t = now();
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,created_at) VALUES (?,?,?,?,?,?,?,?,'active',?)`,
    projectId, userId, spec.title.trim(), spec.brief ?? '', repo, branch, baseRef, String(source), t);
  const taskIds = createProjectTasks(db, { projectId, userId, tasks: spec.tasks });
  audit(db, { actorKind: 'user', actorId: userId, action: 'project_created', targetType: 'project', targetId: projectId,
    payload: { title: spec.title, repo, branch, baseRef, source: String(source), tasks: taskIds } });
  applyEgressDefaults(db, { projectId, userId });   // 管理员勾过的默认放行源
  const sch = scheduleOf(db, { projectId, home });
  if (sch.ready[0]) startTask(db, { project: { id: projectId, repo, branch, base_ref: baseRef, owner_id: userId }, task: sch.ready[0], tasks: sch.tasks, home });
  return { projectId, taskIds, repo, branch, baseRef };
}

/** 项目的契约任务，按编号。order 0 是项目规划器的载体任务（记账、挂批准问题），不算契约。`dependsOn` = 依赖的任务编号（见 chainGraph）。 */
export const projectTasks = (db, projectId) => {
  const g = new Map(chainGraph(db, projectId).map((t) => [t.id, t.dependsOn]));
  return db.all(`SELECT id, title, status, project_order, merged_at FROM tasks WHERE project_id=? AND project_order > 0 ORDER BY project_order`, projectId)
    .map((t) => ({ ...t, signoff: signoffOf(db, t.id), dependsOn: g.get(t.id) ?? [] }));
};

/**
 * 调度视图（纯读）：open = 开着的任务（有工作区、未合并、未中止；串行下至多一个，取编号最小的）；
 * ready = 依赖都已合并、还没开工、没中止的；blockedBy = 每个等着的任务在等谁；aborted = 已中止未合并的。
 */
export function scheduleOf(db, { projectId, home }) {
  const tasks = projectTasks(db, projectId);
  const byOrder = new Map(tasks.map((t) => [t.project_order, t]));
  const unmerged = tasks.filter((t) => !t.merged_at);
  const hasWs = (t) => existsSync(join(home, 'workspaces', t.id));
  const unmet = (t) => t.dependsOn.filter((n) => !byOrder.get(n)?.merged_at);
  const open = unmerged.filter((t) => t.status !== 'aborted' && hasWs(t));
  const ready = unmerged.filter((t) => t.status !== 'aborted' && !hasWs(t) && !unmet(t).length);
  const aborted = unmerged.filter((t) => t.status === 'aborted');
  return { tasks, unmerged, open, ready, aborted, unmet };
}

/** 开工：回归义务 = 此刻已合并的全部任务的验收命令；记漂移提示；从项目分支建工作区。 */
function startTask(db, { project, task, tasks, home }) {
  const merged = tasks.filter((t) => t.merged_at).sort((a, b) => a.merged_at - b.merged_at);
  const extra = merged.map((t) => getParam(db, t.id, 'task.verify_command')).filter((v) => Array.isArray(v) && v.length);
  // 回归义务是宪法层参数，库的约束只许人写：与建任务时一样记在项目负责人名下（每条命令都出自他批准过的契约，这里只是机械汇总）。
  // 漂移提示是执行层的，记在 agent 名下。
  const owner = { kind: 'user', id: project.owner_id };
  const sys = { kind: 'agent', id: 'project' };
  const before = JSON.stringify(getParam(db, task.id, 'task.verify_extra') ?? []);
  if (JSON.stringify(extra) !== before) setParam(db, { taskId: task.id, key: 'task.verify_extra', value: extra, by: owner, governance: 'constitutional' });
  // 基线漂移：比本任务**晚一个批次**才定稿（本任务的契约写的时候还不存在）、又不在它依赖闭包里、却先合并了的任务 —— 契约没把它们算进去。
  // 同一批或更早的任务，规划器写这份契约时看得到它们的契约，不算。
  const batchOf = (id) => Number(getParam(db, id, 'task.batch') ?? 0);
  const mine = batchOf(task.id);
  const graph = new Map(tasks.map((t) => [t.project_order, t.dependsOn]));
  const up = closureOf(graph, task.project_order);
  const strangers = merged.filter((t) => batchOf(t.id) > mine && !up.has(t.project_order));
  if (strangers.length) {
    let files = [];
    // 起点 = 第一个"陌生"任务合并之前的项目分支头（合并审计里记着每次合并后的 head）。
    const merges = db.all(`SELECT payload FROM audit_log WHERE action='project_task_merged' AND target_id=? ORDER BY id`, project.id).map((r) => JSON.parse(r.payload));
    const k = merges.findIndex((m) => strangers.some((t) => t.id === m.taskId));
    const from = k > 0 ? merges[k - 1].head : project.base_ref;
    try { files = from ? git(project.repo, 'diff', '--name-only', from, project.branch).split('\n').filter(Boolean) : []; } catch { files = []; }
    const note = `本任务的契约定稿之后，项目里又添加了不在它依赖关系里的任务，并且已经先合并了：${strangers.map((t) => `#${t.project_order}「${t.title}」`).join('、')}。`
      + (files.length ? `期间改动的文件（${files.length} 个${files.length > 40 ? '，列前 40' : ''}）：${files.slice(0, 40).join('、')}。` : '')
      + '契约没有把这些改动算进去：规划前先读相关文件；若与契约的范围 / 完成定义矛盾，按"结构矛盾"提问，不要自行取舍。';
    setParam(db, { taskId: task.id, key: 'task.drift_note', value: note, by: sys, governance: 'execution' });
    audit(db, { actorKind: 'system', action: 'project_task_drift', targetType: 'project', targetId: project.id,
      payload: { taskId: task.id, order: task.project_order, mergedMeanwhile: strangers.map((t) => t.project_order), files: files.length } });
  }
  const ws = ensureWorkspace(db, { taskId: task.id, source: project.repo, dir: join(home, 'workspaces', task.id), ref: project.branch });
  audit(db, { actorKind: 'system', action: 'project_task_started', targetType: 'project', targetId: project.id,
    payload: { taskId: task.id, order: task.project_order, head: ws.head, regression: extra.length } });
  return ws;
}

/**
 * 推进一步（守护进程每拍调一次；幂等，没事做就返回 reason）。串行调度：
 *   有开着的任务 → planning/running/waiting 等；done 没签收 → 等人；done + accepted → deliver 到项目仓库 → ff 合并 → merged_at，随即开下一个 ready 的。
 *   没有开着的 → 开 ready 里编号最小的；没有 ready 的：全合并了 → 项目 done；剩下的都被中止的任务卡着 → 项目 stalled 等人。
 */
export async function advanceProject(db, { projectId, home, userId = null, makeExec = null, onEvent = () => {} }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
  if (!p) throw new Error(`没有这个项目：${projectId}`);
  if (p.status !== 'active') return { advanced: false, reason: `status:${p.status}` };
  // 预算闸：撞闸之后**不再开新任务**。正在跑的那个不掐 —— 它会在自己的下一轮体检停下来
  // （走 checkLimits 同一条路），半路 kill 容器留下的是一个说不清状态的工作区，比超支几分钱贵。
  // 合并与"项目达成"照常：那两步不花钱，而且撞闸时把已完成的东西卡在半路才是真的损失。
  const budget = budgetState(db, projectId);
  const budgetStop = () => {
    const q = raiseProjectBudget(db, { projectId, taskId: sch.open[0]?.id ?? null });
    return { advanced: false, reason: 'budget_exhausted', questionId: q.questionId, spent: budget.spent, gate: budget.gate };
  };
  let sch = scheduleOf(db, { projectId, home });
  const finish = (extra = {}) => {
    db.run(`UPDATE projects SET status='done' WHERE id=?`, projectId);
    audit(db, { actorKind: 'system', action: 'project_done', targetType: 'project', targetId: projectId, payload: { tasks: sch.tasks.map((t) => t.id), ...extra } });
  };

  /**
   * 全部任务都合并了 —— 这是这个项目**第一次真的没事做**的时刻，也是
   * "项目级完成定义"的落点。全部契约兑现只说明契约兑现了，不说明**目标**兑现了；
   * 两者之间差的就是当初切任务时想漏的那部分，而那恰恰是项目层唯一还没有人看过的地方。
   *
   * ⚠️ **没有项目目标的项目走老路**（`project new --file` 的 JSON 项目、引入项目目标之前建的）：
   * 复盘的判据就是"对照目标与完成定义"，没有目标就没有判据，拿什么去复盘都是编的。
   * 退回原来的机械口径：全部合并 = 项目完成。
   */
  async function allMerged(extra = {}) {
    if (!String(p.goal ?? '').trim()) { finish(extra); return { advanced: true, reason: 'all_merged', done: true }; }
    // 动态 import：project-append 正着 import 本模块（createProjectTasks / validateProjectSpec…），
    // 静态反向 import 会成环。环在 ESM 里多半能跑，但"多半"不是一个该留在调度路径上的词。
    const { appendStateOf, appendPending, requestReview, startQueuedAppend } = await import('../agent/project-append.mjs');
    const st = appendStateOf(db, projectId);
    if (appendPending(st)) return { advanced: false, reason: `review:${st.stage}` };
    if (st?.kind === 'review' && st.stage === 'reached') {
      const v = await runProjectVerify(db, { projectId, home });
      if (v.ok === false) {
        const q = raiseProjectVerifyFailed(db, { projectId, carrierId: st.carrierId, result: v });
        db.run(`UPDATE projects SET status='stalled' WHERE id=?`, projectId);
        audit(db, { actorKind: 'system', action: 'project_verify_failed', targetType: 'project', targetId: projectId, payload: { questionId: q.questionId, argv: v.argv, code: v.code } });
        return { advanced: true, reason: 'project_verify_failed', questionId: q.questionId };
      }
      finish({ ...extra, verify: v.argv ?? null, verified: v.ok === true });
      // 复盘期间有人排了需求：负责人确认达成时在批准事项下看得到它；达成宣布完，再把它开成一轮 ——
      // 项目回到 active（追加批准时 done → active），需求不会因为"已达成"被吞掉。
      const next = startQueuedAppend(db, { projectId });
      return { advanced: true, reason: 'goal_reached', done: true, verify: v, ...(next ? { nextQueued: next } : {}) };
    }
    if (st?.kind === 'review' && st.stage === 'abandoned') {
      // 人回了 C（先放着）。项目不是完成，也不是失败 —— 它在等人：添加任务、或中止。
      db.run(`UPDATE projects SET status='stalled' WHERE id=?`, projectId);
      audit(db, { actorKind: 'system', action: 'project_stalled', targetType: 'project', targetId: projectId,
        payload: { why: '复盘被搁置：全部任务已合并，但没有宣布达成。项目等人：添加任务 / 宣布达成 / 中止项目' } });
      return { advanced: true, reason: 'review_abandoned' };
    }
    // 还有排着队的需求就先做它们：复盘要回答"还差什么"，人明确提了的那几条不该让规划器再猜一遍。
    const next = startQueuedAppend(db, { projectId });
    if (next) return { advanced: true, reason: 'queued_append_started', ...next, ...extra };
    requestReview(db, { projectId });
    return { advanced: true, reason: 'review_requested', ...extra };
  }
  if (!sch.unmerged.length) return await allMerged();

  // ── 挑这一拍要动的那个任务────────────────────────────────────────
  // 合并永远排在开工前面：项目分支往前挪一步，才谈得上下一个任务从哪儿起。
  // 可合并 = done + 签过收（或后置签收）+ **签的就是现在这一份** + 没有被集成卡住。
  const mergeable = sch.open.filter((t) => t.status === 'done' && ['accepted', 'deferred'].includes(t.signoff)
    && signoffCoversDone(db, t.id, wsHeadOf(home, t.id)) && !blockedAtHead(db, t.id, projectHead(p)));
  const cur = mergeable[0] ?? null;
  if (!cur) {
    // 没有可合并的。看能不能**让路**：开着的任务全都在等人时，独立的下一个可以先跑起来。
    const next = lettableNext(db, { project: p, sch, home });
    if (next.taskId) {
      if (budget.over) return budgetStop();
      const task = sch.ready.find((t) => t.id === next.taskId);
      startTask(db, { project: p, task, tasks: sch.tasks, home });
      return { advanced: true, reason: sch.open.length ? 'workspace_created:letting_through' : 'workspace_created', taskId: task.id, concurrent: sch.open.length + 1 };
    }
    if (sch.open.length) return { advanced: false, reason: next.why ?? `waiting:${sch.open[0].status}`, taskId: sch.open[0].id, open: sch.open.map((t) => t.id) };
    // 没有能推进的：剩下的任务要么自己被中止，要么在等被中止的任务。
    const blocker = sch.aborted[0] ?? null;
    if (!blocker) return { advanced: false, reason: 'blocked', waiting: sch.unmerged.map((t) => t.id) };
    // 唯一的任务在草案阶段就被放弃（契约从未批准过）—— 没有可"重做"的契约，停滞的出口不成立，直接中止项目。
    const stage = getParam(db, blocker.id, 'draft.stage');
    if (stage && stage !== 'approved' && sch.tasks.length === 1) {
      db.run(`UPDATE projects SET status='aborted' WHERE id=?`, projectId);
      audit(db, { actorKind: 'system', action: 'project_aborted', targetType: 'project', targetId: projectId,
        payload: { taskId: blocker.id, why: '唯一的任务在草案阶段被放弃' } });
      return { advanced: true, reason: 'draft_abandoned', taskId: blocker.id };
    }
    db.run(`UPDATE projects SET status='stalled' WHERE id=?`, projectId);
    audit(db, { actorKind: 'system', action: 'project_stalled', targetType: 'project', targetId: projectId,
      payload: { taskId: blocker.id, aborted: sch.aborted.map((t) => t.id), why: '剩下的任务都被已中止的任务卡住；项目等人：恢复 / 重做该任务，或中止项目' } });
    return { advanced: true, reason: 'task_aborted', taskId: blocker.id };
  }
  // 集成（原语是 merge）：并发之后，后完成的那个的分支不再是项目分支的快进。
  // 先机械把项目分支合进来 + 重跑，过了才走下面那条老路；不过就挂一条事项，任务原样留着等人。
  // 串行时这一步恒是 'ff'，什么也不做。
  const rb = await integrateProjectBranch(db, { project: p, task: cur, home, makeExec, onEvent });
  if (rb.kind === 'conflict' || rb.kind === 'verify_failed' || rb.kind === 'error') {
    const q = raiseIntegrateBlocked(db, { project: p, task: cur, result: rb });
    return { advanced: true, reason: `integrate_${rb.kind}`, taskId: cur.id, questionId: q.questionId };
  }
  // 签收作废的边界：
  // **干净集成不作废签收；解过冲突的集成作废、重新签收。** 判据机械可判 —— `git merge` 的退出码。
  // 理由：前者没有任何人做过内容决定（两侧都是各自签过收的东西自动合上的）；后者的合并结果是一个
  // **谁都还没签过字的新状态** —— 人在事项里选的是"取哪一侧"，不是"合起来长什么样"，而后者才是签收看的东西。
  if (rb.resolved) {
    const wsDir = join(home, 'workspaces', cur.id);
    const sr = raiseSignoffQuestion(db, { taskId: cur.id, head: rb.head, branch: `v0/${cur.id}`, dir: wsDir });
    audit(db, { actorKind: 'system', action: 'project_task_resigned_after_resolve', targetType: 'task', targetId: cur.id,
      payload: { projectId, onto: rb.target, side: rb.resolved, head: rb.head, questionId: sr.questionId } });
    return { advanced: true, reason: 'integrate_resolved', taskId: cur.id, side: rb.resolved, questionId: sr.questionId };
  }

  // 交付到项目仓库（记 task_delivered，与手工 deliver 同一条路），再 ff 合进项目分支。
  const wsDir = join(home, 'workspaces', cur.id);
  // 签收之后工作区里还有没提交的改动（例如验收重建的 dist/ 留在那儿，deliverTask 会一直拒、只进审计）。
  // 签收的是提交过的那一版，没提交的改动本来就不在里面：只剩构建产物 → 系统撤掉接着合；别的 → 一条事项交给人，
  // 人的答复转给 AI 处理（handback.mjs）。事项开着时这里安静地等，不每拍重挂。
  const dirty = (() => { try { return workspaceStatus(wsDir).changed; } catch { return []; } })();
  if (dirty.length) {
    const junk = dirty.filter(isBuildOutput);
    if (junk.length) {
      discardChanges(wsDir, junk);
      audit(db, { actorKind: 'system', action: 'workspace_build_output_discarded', targetType: 'task', targetId: cur.id,
        payload: { when: 'before_merge', paths: junk } });
    }
    const rest = dirty.filter((f) => !isBuildOutput(f));
    if (rest.length) {
      const open = openHandback(db, cur.id, 'dirty_workspace');
      if (open) return { advanced: false, reason: 'waiting:dirty_workspace', taskId: cur.id, questionId: open.questionId };
      // 只给文件名的话，人看不出 tickets.db 是新生成的还是仓库里本来就有的 —— 写"都不要"之前得知道这个。
      const how = new Map((() => { try { return describeChanges(wsDir); } catch { return []; } })().map((c) => [c.path, c.how]));
      const q = raiseDirtyWorkspace(db, { taskId: cur.id, files: rest.map((f) => (how.get(f) ? `${f}（${how.get(f)}）` : f)) });
      return { advanced: true, reason: 'dirty_workspace', taskId: cur.id, questionId: q.questionId, files: rest };
    }
  }
  let d;
  try {
    d = await deliverTask(db, { taskId: cur.id, workspace: wsDir, remote: p.repo, pr: false, userId });
    git(p.repo, 'checkout', '-q', p.branch);
    try {
      git(p.repo, 'merge', '--ff-only', d.branch);
    } catch (e) {
      throw new Error(`项目分支 ${p.branch} 无法快进到 ${d.branch}（${String(e.stderr ?? e.message).trim().split('\n').at(-1)}）—— 任务分支不是从项目分支当前头起的？`);
    }
  } catch (e) {
    e.taskId = cur.id;   // 守护进程挂"推进反复失败"事项时要知道挂在哪个任务上
    throw e;
  }
  const head = git(p.repo, 'rev-parse', 'HEAD');
  db.run(`UPDATE tasks SET merged_at=? WHERE id=?`, now(), cur.id);
  audit(db, { actorKind: 'system', action: 'project_task_merged', targetType: 'project', targetId: projectId,
    payload: { taskId: cur.id, order: cur.project_order, branch: d.branch, head } });
  sch = scheduleOf(db, { projectId, home });
  if (!sch.unmerged.length) {
    const r = await allMerged({ head });
    // 这一步同时做了两件事（合并最后一个 + 项目层收口），reason 报后者，除非后者就是老口径的"全合并即完成"。
    return { ...r, reason: r.reason === 'all_merged' ? 'merged_last' : r.reason, taskId: cur.id, head, integrated: rb.kind === 'integrated' };
  }
  const pick = budget.over ? { taskId: null } : lettableNext(db, { project: p, sch, home });
  const next = pick.taskId ? sch.ready.find((t) => t.id === pick.taskId) : null;
  if (next) startTask(db, { project: p, task: next, tasks: sch.tasks, home });
  if (!next && budget.over) { const q = raiseProjectBudget(db, { projectId, taskId: cur.id }); return { advanced: true, reason: 'merged_budget_exhausted', taskId: cur.id, head, questionId: q.questionId }; }
  return { advanced: true, reason: 'merged', taskId: cur.id, head, nextTaskId: next?.id ?? null, integrated: rb.kind === 'integrated' };
}

/**
 * 交付前的一手证据。**纯读，不推任何东西。**
 *
 * 负责人不该只看状态栏文字就点交付，他要先看到测试的实际输出；签收时也一样 —— 只贴代码、不贴跑起来到底几条过几条挂，
 * 人只能看代码字面猜它是绿的。**最不可逆的那个动作，页面上不能一条一手证据都没有。**
 *
 * 两样东西，都不调模型：
 *   - `stat`：这一次要推出去的**范围**（`git diff --stat base_ref..分支` + 提交条数）。
 *   - `verify`：项目级验收命令**最近一次的真实输出**（从 `project_verified` / `project_verify_error` 审计里取，
 *     `tail` 是那次跑的输出尾巴）。没设验收命令时 `verify` 为 null —— 那本身就是要在页面上说清的事。
 */
export function deliveryEvidence(db, { projectId }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
  if (!p) return null;
  let stat = null;
  try {
    const range = `${p.base_ref}..${p.branch}`;
    // `--no-merges`：换成 merge 之后，任务分支上会多出"把项目分支合进来"的集成提交，
    // 它们不是任何人写的代码。数进去会让这一页的提交数无端变大，而这一页的全部用处是让人敢点交付。
    stat = { range, diffstat: git(p.repo, 'diff', '--stat', range), commits: Number(git(p.repo, 'rev-list', '--count', '--no-merges', range)) || 0, head: git(p.repo, 'rev-parse', p.branch) };
  } catch { stat = null; }                       // 仓库读不了就如实说读不了，别编一个空 diff 出来
  const row = db.one(`SELECT ts, action, payload FROM audit_log WHERE target_id=? AND action IN ('project_verified','project_verify_error') ORDER BY id DESC LIMIT 1`, projectId);
  let verify = null;
  if (row) {
    let pl = {};
    try { pl = JSON.parse(row.payload || '{}'); } catch { /* 坏 payload 不该连累这一页 */ }
    verify = { at: row.ts, ok: row.action === 'project_verified' ? !!pl.ok : false, argv: pl.argv ?? null,
      code: pl.code ?? null, timedOut: !!pl.timedOut, head: pl.head ?? null, tail: pl.tail ?? pl.error ?? null,
      ranAtHead: !!(pl.head && stat?.head && pl.head === stat.head),
      // 逐任务的那一份。**证据，不是闸门** —— 它不进 `ok`，但交付页要把失败的那几条说响。
      perTask: Array.isArray(pl.perTask) ? pl.perTask : null };
  }
  // 哪个文件 / 提交是哪个任务的（交付页要用）：只在仓库读得到时算。
  let byTask = null;
  if (stat) { try { byTask = mergeChainOf(db, p); } catch { byTask = null; } }
  return { stat, verify, byTask, command: projectVerifyCommand(db, projectId) };
}

/**
 * 项目交付：把项目分支推到远端；`pr` 时开一个 PR，正文 = 各任务终版汇报摘要。
 * 项目要 done；或已中止但至少合并过一个任务 —— 已合并的前缀逐个经人签收、各带累加的回归验收，是可以交付的成果。
 */
export async function deliverProject(db, { projectId, remote, pr = false, base = null, token = process.env.GITHUB_TOKEN, fetchFn = globalThis.fetch, userId = null, acceptDeferred = false }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
  if (!p) throw new Error(`没有这个项目：${projectId}`);
  const allTasks = projectTasks(db, projectId);
  const mergedTasks = allTasks.filter((t) => t.merged_at);
  const partial = p.status === 'aborted';
  if (p.status !== 'done' && !(partial && mergedTasks.length)) {
    throw new Error(partial ? '项目已中止且没有任何已合并的任务，没有可交付的内容' : `项目状态是 ${p.status}，只交付已完成的项目，或已中止但有已合并任务的项目`);
  }
  if (!remote) throw new Error('要给 --remote <url>：项目分支推到哪里。不默认取源仓库 —— 那可能是别人的仓库');
  // 后置签收：自动挡下 AI 自己加的任务是"验收过了就合并、签收攒着"。攒到这里必须清掉 ——
  // **交付是爆炸半径的真正边界**，草案里那句"交付永远要人点"，具体就是这一下。
  // 清掉的方式是显式的 acceptDeferred，不是看见有就自动过：一次点掉 N 个任务是一次真实的决定，
  // 要人在知道 N 是几、都是哪些的前提下做。
  const deferred = deferredSignoffs(db, projectId);
  if (deferred.length && !acceptDeferred) {
    throw new Error(`还有 ${deferred.length} 个任务的签收被后置了（自动挡下 AI 自己加的）：`
      + `${deferred.map((t) => `#${t.project_order}「${t.title}」`).join('、')}。`
      + `交付前要一次签掉：命令行加 --accept-pending，或先 node src/cli.mjs project signoff ${projectId} --accept-all`);
  }
  if (deferred.length) acceptDeferredSignoffs(db, { projectId, userId, tasks: deferred });
  const gh = parseGithub(remote);
  const env = pushEnv(remote, token);
  const out = { remote, branch: p.branch, head: null, pr: null, prSkipped: null, basePushed: null, partial: partial ? { merged: mergedTasks.length, total: allTasks.length } : null };
  // 空仓库（零分支）没有 PR 的 base：先把项目起点推成默认分支。只在要开 PR、远端是 GitHub、有 token 时查；
  // 查不到分支列表就当不空，push 照常。
  if (pr && gh && token) {
    const branches = await fetchFn(`https://api.github.com/repos/${gh.owner}/${gh.repo}/branches?per_page=1`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'superintern' } })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (Array.isArray(branches) && branches.length === 0) {
      const def = base ?? await defaultBranch(gh, token, fetchFn);
      gitEnv(p.repo, env, 'push', remote, `${p.base_ref}:refs/heads/${def}`);
      out.basePushed = { branch: def, head: p.base_ref };
      base = def;
    }
  }
  gitEnv(p.repo, env, 'push', '--force-with-lease', remote, `${p.branch}:refs/heads/${p.branch}`);
  const head = git(p.repo, 'rev-parse', p.branch);
  out.head = head;
  if (pr) {
    if (!gh) out.prSkipped = `远端不是 GitHub（${remote}），已推送，未创建 PR`;
    else if (!token) out.prSkipped = '未设置 GITHUB_TOKEN：已推送，未创建 PR。在 .env 中设置后重新交付即可';
    else {
      const tasks = mergedTasks;
      const lines = tasks.map((t) => { const r = finalReport(db, t.id); return `${t.project_order}. **${t.title}**（\`${t.id}\`）\n   ${r.summary}`; });
      const baseBranch = base ?? await defaultBranch(gh, token, fetchFn);
      const res = await fetchFn(`https://api.github.com/repos/${gh.owner}/${gh.repo}/pulls`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'superintern' },
        body: JSON.stringify({ title: p.title, head: p.branch, base: baseBranch,
          body: `${partial ? `> 项目已中止：本次只交付已签收并合并的第 1–${mergedTasks.length} 个任务（共 ${allTasks.length} 个）。\n\n` : ''}${p.brief ? `${p.brief}\n\n` : ''}## 任务\n\n${lines.join('\n')}\n\n---\n由 SuperIntern 交付：项目 \`${projectId}\`，分支 \`${p.branch}\` @ ${head.slice(0, 8)}。摘要取自各任务真相源里的终版汇报。` }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`开 PR 失败：HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
      out.pr = { url: json.html_url, number: json.number, base: baseBranch };
    }
  }
  audit(db, { actorKind: 'user', actorId: userId, action: 'project_delivered', targetType: 'project', targetId: projectId, payload: out });
  return out;
}

async function defaultBranch(gh, token, fetchFn) {
  const res = await fetchFn(`https://api.github.com/repos/${gh.owner}/${gh.repo}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'superintern' } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`读仓库信息失败：HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json.default_branch ?? 'main';
}

// ── 项目级验收 ──────────────────────────────────────────────────────────
// 任务级验收跑在那个任务的工作区里；项目级验收跑在**项目分支的一个干净克隆**里。
// 这不是省事，是判据本身：它要证明的是"合并之后的那棵树成立"，不是"某个任务的工作区成立"。
// 任务的工作区里有它自己跑测试留下的缓存、有它自己那一半的 node_modules，拿它当证据，
// 证的就不是项目分支。
//
// 容器与任务级同一套（makeSandbox → ContainerExecutor），因为这条命令与任务里跑的是同一类
// 东西：人填的、可能任意的一条命令。项目仓库克隆是宿主机上的真实目录，在它里面直接跑
// 等于把沙箱这道边界在最后一步拆掉。
//
// ⚠️ **动态 import**：容器那一套很重，而绝大多数项目没填项目级验收命令（选填）。没填就一次
// 都不该加载它。

export async function runProjectVerify(db, { projectId, home, makeExec = null, onEvent = () => {} }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
  if (!p) throw new Error(`没有这个项目：${projectId}`);
  const argv = projectVerifyCommand(db, projectId);
  // 没填不是失败，是"没有机械核实这一说"——ok 为 null，调用方据此决定文案（"人宣布的"而不是"验过的"）。
  if (!argv) return { ok: null, skipped: true, why: 'no_command' };
  const carrier = db.one(`SELECT id FROM tasks WHERE project_id=? AND project_order=0`, projectId)
    ?? db.one(`SELECT id FROM tasks WHERE project_id=? ORDER BY project_order DESC LIMIT 1`, projectId);
  if (!carrier) return { ok: false, argv, code: null, tail: '项目里没有任何任务，无处建验收工作区', timedOut: false };
  const dir = join(home, 'verify', projectId);
  const t0 = now();
  let exec = null;
  try {
    // force：每次都从项目分支当前头重新克隆。上一次验收留下的东西不许影响这一次。
    const ws = ensureWorkspace(db, { taskId: carrier.id, source: p.repo, dir, ref: p.branch, force: true });
    onEvent({ type: 'project_verify_start', argv, head: ws.head });
    const mk = makeExec ?? (async () => {
      const { makeSandbox } = await import('./container.mjs');
      return makeSandbox(db, { taskId: carrier.id, home });
    });
    exec = await mk();
    // 先把上一次留下的同名容器收掉再跑：验收目录刚被 force 重新克隆过，
    // 上一轮那个容器还挂着已经不存在的旧目录。上一个进程崩了没清理时也是这条兜住。
    // 容器是懒起的，所以这一下只删旧的，不会影响紧接着这次 execute 自己起的那个。
    await disposeExec(exec).catch(() => { /* 没有旧容器是常态 */ });
    // 环境准备：这份干净克隆里没有依赖（依赖目录不进仓库）。项目配了环境准备命令就先跑；
    // 失败就不跑验收命令，直接报失败并说清是环境准备那一步 —— 否则人看到的是"找不到模块"，要自己倒推原因。
    // 人填了用人填的；没填就按这份干净克隆里的依赖清单自动识别
    const { argvs: setupArgvs, source: setupSource } = effectiveSetupOf(db, projectId, dir);
    if (setupArgvs.length) {
      const su = await runSetupCommands(exec, dir, setupArgvs);
      audit(db, { actorKind: 'system', action: su.ok ? 'env_setup_done' : 'env_setup_failed', targetType: 'project', targetId: projectId,
        payload: { for: 'project_verify', source: setupSource, results: su.results.map((x) => ({ cmd: x.argv.join(' '), code: x.code, timedOut: x.timedOut, tail: x.tail.slice(-600) })) } });
      if (!su.ok) {
        const bad = su.results.at(-1);
        const r = { ok: false, argv, code: bad.code, timedOut: bad.timedOut, head: ws.head, setupFailed: true,
          tail: `环境准备命令失败，验收命令没有跑：\n$ ${bad.argv.join(' ')}\n${bad.tail}` };
        audit(db, { actorKind: 'system', action: 'project_verified', targetType: 'project', targetId: projectId,
          payload: { ok: false, argv, code: bad.code, timedOut: bad.timedOut, head: ws.head, tail: r.tail, setupFailed: true, elapsedMs: now() - t0 } });
        return r;
      }
    }
    const out = await exec.execute({ file: argv[0], args: argv.slice(1) }, dir, { mode: 'write', timeoutMs: 600_000 });
    // 原来只留最后 40 行。曾出现过：尾部恰好是五条配置自检（MAX_PAGE_SIZE 等于 50、
    // package.json 的 type 是 module…），负责人看不到另外那几十条测的是啥 —— 项目真正会出幺蛾子的
    // 分页边界与渲染正确性，一条都没露出来。**任何固定切片都答不了"测的是不是要紧的东西"**，
    // 所以这里做两件事：留多一点（最后 120 行），以及在正文里如实说这是"最后 N 行，不是全部"。
    // 不做的：解析 TAP 去挑失败用例 —— 验收命令是任意一条命令，按某种输出格式去猜就是
    // 又一处"同一段启发式喂给两个判断"的坑。
    const lines = (out.stdout + out.stderr).trim().split('\n');
    const kept = lines.slice(-120);
    const tail = (kept.length < lines.length ? `（输出共 ${lines.length} 行，这里是最后 ${kept.length} 行，不是全部）\n` : '') + kept.join('\n');
    const ok = out.code === 0 && !out.timedOut;
    // **在同一个容器、同一份代码上，把每个已合并任务自己的验收命令也各跑一遍。**
    //
    // 负责人点交付前真正想问的是："另外那些测试测的是啥？"
    // 上面的输出尾巴只能回答"这里是最后 120 行，不是全部"—— 那是**说清楚它不证明什么**，
    // 答不了他真正问的。这一半答得了，而且**精确、零启发式**：每个任务自己那条命令的退出码，
    // 按任务列出来。不解析任何输出格式。
    //
    // ⚠️ 它是**证据，不是闸门**：`ok` 仍然只由项目级验收命令决定。
    // 某个任务自己的命令在这里挂了，说明项目级那条没覆盖到它 —— 那是要摆给人看的事实，
    // 但把它偷偷并进 `ok` 会让这道闸的含义在没人注意时变了。交付页会把它显著地说出来。
    const perTask = await runMergedTaskVerifies(db, { projectId, exec, dir, onEvent });
    audit(db, { actorKind: 'system', action: 'project_verified', targetType: 'project', targetId: projectId,
      // `tail` 也进审计：交付那一页要摆的一手证据就是这段输出，而交付可能发生在几小时之后、
      // 另一个进程里。不存下来，那一页就只剩"状态栏文字"—— 人不该只看状态栏就点交付。
      payload: { argv, code: out.code, timedOut: out.timedOut, ok, head: ws.head, elapsedMs: now() - t0, tail: tail.slice(0, 12000), perTask } });
    onEvent({ type: 'project_verify_done', ok, code: out.code });
    return { ok, argv, code: out.code, timedOut: out.timedOut, tail, head: ws.head, perTask };
  } catch (e) {
    // 跑不起来（没有容器运行时、克隆失败、镜像缺失）**算不过**，不算通过：
    // "验收命令没能跑起来"与"验收命令跑过了"之间的距离，正是这道闸门存在的全部理由。
    audit(db, { actorKind: 'system', action: 'project_verify_error', targetType: 'project', targetId: projectId,
      payload: { argv, error: String(e.message).slice(0, 400) } });
    return { ok: false, argv, code: null, timedOut: false, tail: `验收没能跑起来：${String(e.message).slice(0, 400)}` };
  } finally {
    try { await disposeExec(exec); } catch { /* 清理失败不改结论 */ }
  }
}

/** 逐任务重跑的总预算：超了就停，剩下的如实标成"没跑"，不硬撑也不假装跑过。 */
const PER_TASK_VERIFY_BUDGET_MS = 10 * 60 * 1000;
const PER_TASK_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 逐个已合并任务，跑它自己那条验收命令。**在调用方已经起好的那个容器里跑** ——
 * 同一份代码、同一个环境，不另起一次沙箱（起容器才是贵的那一步，命令本身单条 0.15 秒量级）。
 *
 * 只读、只产出证据：不改任何状态、不写参数、不挂事项。跑不起来就如实记 `error`。
 */
async function runMergedTaskVerifies(db, { projectId, exec, dir, onEvent = () => {} }) {
  const tasks = projectTasks(db, projectId).filter((t) => t.merged_at).sort((a, b) => a.merged_at - b.merged_at);
  const out = [];
  const t0 = now();
  for (const t of tasks) {
    const argv = getParam(db, t.id, 'task.verify_command');
    const base = { taskId: t.id, order: t.project_order, title: t.title, argv: Array.isArray(argv) ? argv : null };
    if (!base.argv?.length) { out.push({ ...base, ok: null, why: 'no_command' }); continue; }
    if (now() - t0 > PER_TASK_VERIFY_BUDGET_MS) { out.push({ ...base, ok: null, why: 'budget' }); continue; }
    onEvent({ type: 'task_verify_start', taskId: t.id, argv: base.argv });
    const at = now();
    try {
      const r = await exec.execute({ file: base.argv[0], args: base.argv.slice(1) }, dir, { mode: 'write', timeoutMs: PER_TASK_VERIFY_TIMEOUT_MS });
      out.push({ ...base, ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: !!r.timedOut, elapsedMs: now() - at,
        tail: (r.code === 0 && !r.timedOut) ? null : (r.stdout + r.stderr).trim().split('\n').slice(-20).join('\n').slice(0, 1200) });
    } catch (e) {
      out.push({ ...base, ok: null, why: 'error', error: String(e.message).slice(0, 200), elapsedMs: now() - at });
    }
  }
  return out;
}

/** 项目级验收没过 → 一条 Ⅲ 级事项给负责人。零模型调用：失败输出的尾巴就是全部材料。 */
export function raiseProjectVerifyFailed(db, { projectId, carrierId = null, result }) {
  const p = db.one(`SELECT title FROM projects WHERE id=?`, projectId);
  const host = carrierId ?? db.one(`SELECT id FROM tasks WHERE project_id=? ORDER BY COALESCE(project_order,0) DESC LIMIT 1`, projectId)?.id;
  const t = now();
  const id = newId('q');
  const text = `【项目验收没过】项目「${p?.title ?? projectId}」的全部任务都已合并，你也确认了达成，但项目级验收命令没过。\n\n`
    + `命令：${result.argv.join(' ')}（在项目分支的一个干净克隆里跑）\n`
    + `退出码：${result.code === null ? '（没跑起来）' : result.code}${result.timedOut ? '（超时）' : ''}\n\n`
    + `输出尾部：\n${result.tail || '（空）'}\n\n`
    + `项目**没有**转为已完成。这条事项是系统按规则直接生成的，没有经过 AI。\n\n`
    + `请选一条：\n`
    + `(A) 加一个任务把它修好：到项目页「添加任务」，把上面的输出尾部贴进去（在这条里回复不会替你加任务）；新任务合并之后系统会再复盘、再跑这条验收\n`
    + `(B) 验收命令本身不对：到「项目设置 → 自动化」改项目级验收命令，然后回这条「再跑一次」—— 系统用新命令重新验收，过了就宣布完成\n`
    + `(C) 这条验收不该拦：到「项目设置 → 自动化」清空项目级验收命令，然后回「再跑一次」（清空后"达成"就完全由人宣布，没有机械核实）`;
  return db.tx(() => {
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, id, host, text, t);
    routeQuestion(db, { questionId: id, decisionType: 'structural', typeSource: 'hard_rule', at: t });
    return { questionId: id, text };
  });
}

/**
 * 后置签收的批量了结。一次点掉 N 个任务是一次真实的决定，所以：
 *   - 它只由人触发（`project signoff --accept-all`，或交付时的 --accept-pending），系统不会自己做；
 *   - 每个任务各留一条 `task_signed_off`（与逐个签收同一条审计动作），不合成一条大的 ——
 *     日后追"这个 commit 谁签的"时，批量与逐个必须一样查得到；
 *   - 另有一条 `project_signoff_batch` 记下它们是**一次**点掉的，别让审计轨看起来像人逐个看过。
 */
export function acceptDeferredSignoffs(db, { projectId, userId, tasks = null }) {
  const list = tasks ?? deferredSignoffs(db, projectId);
  if (!list.length) return { accepted: 0, tasks: [] };
  if (!userId) throw new Error('批量签收要说明是谁签的');
  return db.tx(() => {
    for (const t of list) {
      setParam(db, { taskId: t.id, key: 'signoff.status', value: 'accepted', by: { kind: 'user', id: userId }, governance: 'constitutional' });
      audit(db, { actorKind: 'user', actorId: userId, action: 'task_signed_off', targetType: 'task', targetId: t.id,
        payload: { accepted: true, head: getParam(db, t.id, 'signoff.head'), batch: true, projectId } });
    }
    audit(db, { actorKind: 'user', actorId: userId, action: 'project_signoff_batch', targetType: 'project', targetId: projectId,
      payload: { tasks: list.map((t) => t.id), orders: list.map((t) => t.project_order) } });
    return { accepted: list.length, tasks: list.map((t) => t.id) };
  });
}

// ── 集成（原语是 merge）───────────────────────────────────────────────────
// 并发之后，后完成的那个任务的分支不再是项目分支的快进。最初的设计是"机械变基到集成分支头
// → 重跑自己的验收 + 全部回归义务（只跑命令）"。**原语已从 rebase 换成 merge**（
// 理由见 `integrateProjectBranch` 的注释：冲突的形状不同，rebase 呈现成一道正确答案不在
// 任何一侧的二选一）。三条边界不变：
//
// ① **集成是机械的，零模型**。冲突了不去猜怎么解 —— 解冲突要读懂两边的意图，那是执行器的活，
//    而执行器要动起来得有人把任务放回去做（签收打回那条路），所以这里只负责**把话说清楚**。
// ② **集成之后必须重跑**。文本不冲突不等于语义相容：两个任务各自改了不同的文件，合起来照样
//    能让对方的测试挂。重跑的是"自己的验收 + 当时的全部回归义务"，一条都不减。
// ③ **同一个项目分支头只试一次**。集成 + 重跑要起一次容器，每拍重试一遍就是在烧钱烧时间。
//    失败时把失败对着的那个头记下来，项目分支不前进就不再试。
//    ⚠️ 那个参数的键仍然叫 `task.rebase_blocked`：它是**落库的状态**，改名要配一次迁移，
//    而它从不露给人看。名字旧了，读的时候当"集成卡住"理解。

/**
 * 收掉一个执行器。
 *
 * 这里原来写的是 `await exec?.dispose?.()` —— 而 `ContainerExecutor` 上那个方法叫 **`stop`**。
 * 可选调用（`?.`）碰上不存在的方法就**静默什么也不做**，于是容器从来没被删过。
 * 平时看不出来（`sandbox --reap` 会按 label 兜底清），但项目级验收踩中了它：
 * `runProjectVerify` 每次都 `ensureWorkspace(force: true)` 把验收目录**删掉重新克隆**，
 * 而上一次留下的那个容器还把旧目录 bind 挂着 —— 第二次跑 exec 进去，docker 报
 *
 *   OCI runtime exec failed: ... current working directory is outside of container
 *   mount namespace root -- possible container breakout detected
 *
 * 退出码 128，验收判"没过"，项目转 stalled，人收到一条 Ⅲ 级事项，正文里赫然写着
 * "possible container breakout detected"。**项目级验收第二次跑必失败，而且失败信息最吓人、
 * 最误导。** 把那个容器 `docker rm -f` 掉，同一条命令、同一个头，立刻全部通过。
 */
async function disposeExec(exec) {
  if (!exec) return;
  if (typeof exec.stop === 'function') return await exec.stop({ remove: true });   // 真沙箱
  if (typeof exec.dispose === 'function') return await exec.dispose();             // 测试里的假执行器
}

/** 起一次沙箱，跑完必清理。跑不起来就抛 —— 调用方一律把"没能跑起来"算作不过。 */
async function withSandbox(db, { taskId, home, makeExec }, fn) {
  const mk = makeExec ?? (async () => {
    const { makeSandbox } = await import('./container.mjs');
    return makeSandbox(db, { taskId, home });
  });
  const exec = await mk();
  try { return await fn(exec); } finally { try { await disposeExec(exec); } catch { /* 清理失败不改结论 */ } }
}


/** 冲突文件里带 <<<<<<< 标记的那几段（最多两个文件、每段 40 行）—— 给人看的一手证据。 */
function conflictHunks(wsDir, files) {
  const out = [];
  for (const cf of files.slice(0, 2)) {
    let text = '';
    try { text = readFileSync(join(wsDir, cf), 'utf8'); } catch { continue; }
    const L = text.split('\n');
    const a = L.findIndex((x) => x.startsWith('<<<<<<<'));
    const b = L.findIndex((x) => x.startsWith('>>>>>>>'));
    if (a < 0 || b < a) continue;
    out.push(`--- ${cf} ---\n${L.slice(Math.max(0, a - 3), Math.min(L.length, b + 4)).slice(0, 40).join('\n')}`);
  }
  return out.join('\n\n');
}

export const SIDE_NAME = { ours: '这个任务这一侧', theirs: '项目分支那一侧' };

/**
 * 按人选定的一侧，机械地解掉这一趟合并的全部冲突。**零模型、零判断**：
 * 系统只执行"取哪一侧"，永远不决定合并后长什么样。
 *
 * 原语是 `git merge-file --ours|--theirs`：**逐冲突块**取那一侧，同一个文件里已经干净合并的部分
 * 原样保留。⚠️ **不要用 `git checkout --ours`** —— 那是"整份文件取这一侧"，会把那些干净合并的部分
 * 一起扔掉。两个候选都实际跑过，差别就在这里。
 *
 * 三方 blob 从索引的三个 stage 取：`:1:` 共同祖先、`:2:` ours（**任务分支这一侧**）、`:3:` theirs（项目分支）。
 * 两边各自新建同名文件（add/add）时没有 stage 1 —— 用空文件当祖先，这正是 merge-file 对那种情形的正确处理。
 * 选中的那一侧**没有**这个文件（一侧删了、另一侧改了）→ 就删掉它：merge-file 在那种情形下没有意义。
 */
function resolveConflictWith(wsDir, side) {
  const files = git(wsDir, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  const mine = side === 'ours' ? 2 : 3;
  const dir = mkdtempSync(join(tmpdir(), 'si-merge-'));
  try {
    for (const f of files) {
      const blob = {};
      for (const st of [1, 2, 3]) {
        const p = join(dir, `stage${st}`);
        try { writeFileSync(p, gitBuf(wsDir, 'show', `:${st}:${f}`)); blob[st] = p; }
        catch { writeFileSync(p, ''); blob[st] = st === 1 ? p : null; }   // 祖先缺失 = 空；一侧缺失 = 那一侧删了它
      }
      if (!blob[mine]) { git(wsDir, 'rm', '-q', '-f', '--', f); continue; }
      const three = [join(dir, 'stage2'), join(dir, 'stage1'), join(dir, 'stage3')];
      try { execFileSync('git', ['merge-file', `--${side}`, ...three], { cwd: wsDir, stdio: 'ignore' }); }
      catch { /* merge-file 的退出码是残留冲突数；--ours/--theirs 之下恒为 0，这里只是不让非零把流程掀翻 */ }
      writeFileSync(join(wsDir, f), readFileSync(three[0]));
      git(wsDir, 'add', '--', f);
    }
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  return files;
}

/**
 * 项目分支当前头是不是已经在这个任务的历史里（是 → 不用集成，老路照走）。
 *
 * 这一个判断同时是合并那一端 `git merge --ff-only` 的前提 —— 所以任务分支只要把项目头
 * 合进来过，这两件事就一起成立，合并那一端一行都不用改。
 */
function alreadyIntegrated(wsDir, projectRepo, branch) {
  try {
    gitEnv(wsDir, { ...process.env, GIT_TERMINAL_PROMPT: '0' }, 'fetch', '-q', projectRepo, branch);
    const target = git(wsDir, 'rev-parse', 'FETCH_HEAD');
    try { git(wsDir, 'merge-base', '--is-ancestor', target, 'HEAD'); return { ff: true, target }; }
    catch { return { ff: false, target }; }
  } catch (e) {
    // 取不到项目分支（工作区没了 / 仓库路径变了）：当成"不是快进"，让上层走集成那条路并如实报错。
    return { ff: false, target: null, error: String(e.message).slice(0, 300) };
  }
}

/**
 * 把项目分支当前头**合进**任务分支，然后重跑它的验收命令与全部回归义务。
 *
 * ⚠️ 这里原来是 `git rebase`。换成 `git merge`，
 * 理由全部来自重放同一次冲突 —— 两种都冲突，但**冲突的形状不同**：
 *
 *   rebase：停在 4 个提交里的第 3 个，把冲突呈现成 `demo` **对** `start` —— 二选一，
 *           而正确答案（两个都要）**不在任何一侧**；任务自己的第 4 个提交恰好就是解法，rebase 到不了那里。
 *   merge ：`{demo, start}` **对** `{demo}` —— `ours ⊇ theirs`，正确答案就是 ours，一字不改。
 *
 * 这直接解释了曾出现过的三轮循环：人看着 rebase 的 hunk 正确判断出"三者应并存"，
 * 却没法把它表达成"取某一侧"，于是说了"你重新变基一次"，执行器照做、被 scope 判越界、烧掉一整轮。
 * 另外三条：不改写历史（rebase 把签收记下的那个头从分支上抹掉了）；原子（rebase 会停在 3/4 留半截
 * detached，merge 只有一个失败点）；事项正文引的是项目分支头，而不是"你自己的第 3 个提交"。
 * 代价：项目分支历史不再线性（`deliveryEvidence` 的提交数因此加 `--no-merges`）。
 *
 * @returns {{kind:'ff'|'integrated'|'conflict'|'verify_failed'|'error', ...}}
 */
export async function integrateProjectBranch(db, { project, task, home, makeExec = null, onEvent = () => {} }) {
  const wsDir = join(home, 'workspaces', task.id);
  if (!existsSync(wsDir)) return { kind: 'error', why: '工作区不在了，没法集成' };
  const { ff, target, error } = alreadyIntegrated(wsDir, project.repo, project.branch);
  if (error) return { kind: 'error', why: `取项目分支失败：${error}` };
  if (ff) return { kind: 'ff', target };

  const before = git(wsDir, 'rev-parse', 'HEAD');
  onEvent({ type: 'integrate_start', taskId: task.id, from: before, onto: target });
  let resolved = null;
  try {
    git(wsDir, '-c', 'user.name=superintern', '-c', 'user.email=superintern@local',
      'merge', '--no-edit', '-m', `集成项目分支 ${String(target).slice(0, 8)}`, target);
  } catch (e) {
    const msg = String(e.stderr ?? e.message ?? '').trim().split('\n').slice(-12).join('\n');
    let files = [];
    try { files = git(wsDir, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean); } catch { /* 拿不到就不列 */ }
    // **回滚之前**把带冲突标记的那几段抠出来。
    // 最要紧的一手证据（到底哪两行撞了）机器手里有，而事项里原来只给 git 的提示文本。
    // 负责人的第一反应会是"先看一眼冲突内容，不能凭猜测下结论"—— 那一眼本该在这一页上就给他。
    const hunks = conflictHunks(wsDir, files);
    // 人已经在事项里选过一侧（而且选的就是对着**这个**项目分支头的那一次）→ 这一趟机械解掉。
    // 选择是在上一拍记下的，不是在这里判的：系统只执行"取哪一侧"。
    const pick = getParam(db, task.id, 'task.integrate_resolution');
    let resolveError = null;
    if (pick && pick.onto === target && ['ours', 'theirs'].includes(pick.side)) {
      try {
        resolveConflictWith(wsDir, pick.side);
        git(wsDir, '-c', 'user.name=superintern', '-c', 'user.email=superintern@local', 'commit', '--no-edit');
        resolved = pick.side;
      } catch (err) { resolveError = String(err.stderr ?? err.message ?? '').trim().slice(-300); }
    }
    if (!resolved) {
      try { git(wsDir, 'merge', '--abort'); } catch { /* 已经不在合并中 */ }
      audit(db, { actorKind: 'system', action: 'project_task_integrate_conflict', targetType: 'task', targetId: task.id,
        payload: { projectId: project.id, onto: target, files, hunks: String(hunks).slice(0, 400), message: msg.slice(0, 600),
          resolveError, triedSide: resolveError ? pick.side : null } });
      return { kind: 'conflict', target, files, hunks,
        tail: resolveError ? `${msg}\n\n（按你选的「${SIDE_NAME[pick.side]}」机械解冲突没成功：${resolveError}）` : msg };
    }
    setParam(db, { taskId: task.id, key: 'task.integrate_resolution', value: null, by: { kind: 'agent', id: 'project' }, governance: 'execution' });
    audit(db, { actorKind: 'system', action: 'project_task_conflict_resolved', targetType: 'task', targetId: task.id,
      payload: { projectId: project.id, onto: target, side: resolved, files, by: pick.by ?? null, questionId: pick.questionId ?? null } });
  }
  const after = git(wsDir, 'rev-parse', 'HEAD');
  audit(db, { actorKind: 'system', action: 'project_task_integrated', targetType: 'task', targetId: task.id,
    payload: { projectId: project.id, from: before, onto: target, head: after } });

  // 重跑：自己的验收命令 + **此刻**的全部回归义务。一条都不减，第一条不过就停。
  //
  // ⚠️ 这里必须重算，不能用开工时定下的那份 `task.verify_extra`。依赖图的规矩是"回归义务在开工
  // 那一刻定 = 当时已合并的全部任务的验收命令"；而让路恰恰让 B 在 A 合并**之前**就开了工，
  // 于是 B 的那份快照里没有 A。集成把 A 的代码搬进了 B 的树，却不跑 A 的验收 —— 那就漏掉了
  // 正好是它刚合进来的那个任务，这道闸门的意义就没了。重算的结果也写回参数：从此它的义务就是这个。
  const own = getParam(db, task.id, 'task.verify_command');
  const merged = projectTasks(db, project.id).filter((t) => t.merged_at && t.id !== task.id).sort((a, b) => a.merged_at - b.merged_at);
  const extra = merged.map((t) => getParam(db, t.id, 'task.verify_command')).filter((v) => Array.isArray(v) && v.length);
  if (JSON.stringify(extra) !== JSON.stringify(getParam(db, task.id, 'task.verify_extra') ?? [])) {
    setParam(db, { taskId: task.id, key: 'task.verify_extra', value: extra, by: { kind: 'user', id: project.owner_id }, governance: 'constitutional' });
    audit(db, { actorKind: 'system', action: 'project_task_regression_refreshed', targetType: 'task', targetId: task.id,
      payload: { projectId: project.id, onto: target, commands: extra.length, why: '集成之后按此刻已合并的任务重算回归义务' } });
  }
  const argvs = [...(Array.isArray(own) && own.length ? [own] : []), ...extra].filter((a) => Array.isArray(a) && a.length);
  if (!argvs.length) {
    // 没有任何机械验收可跑（老任务）。集成本身成功了就放行，并如实记一笔：这一次合并没有机械证据。
    audit(db, { actorKind: 'system', action: 'project_task_integrate_unverified', targetType: 'task', targetId: task.id,
      payload: { projectId: project.id, onto: target, why: '这个任务没有验收命令，集成后无从重跑' } });
    return { kind: 'integrated', target, head: after, verified: false, ran: 0, resolved };
  }
  try {
    const bad = await withSandbox(db, { taskId: task.id, home, makeExec }, async (exec) => {
      for (const [i, argv] of argvs.entries()) {
        onEvent({ type: 'integrate_verify', taskId: task.id, argv, index: i, total: argvs.length });
        const out = await exec.execute({ file: argv[0], args: argv.slice(1) }, wsDir, { mode: 'write', timeoutMs: 600_000 });
        if (out.code !== 0 || out.timedOut) {
          return { argv, code: out.code, timedOut: out.timedOut, regression: i > 0,
            tail: (out.stdout + out.stderr).trim().split('\n').slice(-40).join('\n') };
        }
      }
      return null;
    });
    if (bad) {
      audit(db, { actorKind: 'system', action: 'project_task_integrate_verify_failed', targetType: 'task', targetId: task.id,
        payload: { projectId: project.id, onto: target, ...bad, tail: String(bad.tail).slice(0, 600) } });
      return { kind: 'verify_failed', target, head: after, resolved, ...bad };
    }
  } catch (e) {
    // 跑不起来（没有容器运行时、镜像缺失）**算不过** —— 与项目级验收同一条道理。
    audit(db, { actorKind: 'system', action: 'project_task_integrate_verify_failed', targetType: 'task', targetId: task.id,
      payload: { projectId: project.id, onto: target, error: String(e.message).slice(0, 400) } });
    return { kind: 'verify_failed', target, head: after, code: null, tail: `集成后的重跑没能跑起来：${String(e.message).slice(0, 400)}` };
  }
  audit(db, { actorKind: 'system', action: 'project_task_integrate_verified', targetType: 'task', targetId: task.id,
    payload: { projectId: project.id, onto: target, head: after, ran: argvs.length } });
  return { kind: 'integrated', target, head: after, verified: true, ran: argvs.length, resolved };
}

/**
 * 冲突事项的封闭答案空间：`ours` / `theirs` / `other`。
 * 口径与 `answers.mjs` 里"签收的答案空间是封闭的：接受 / 打回"一致 —— 认前缀，不猜语义。
 * **认不出来就是 `other`**：宁可让它停在那儿被停等账本报出来，也不替人猜一侧。
 */
export function conflictSide(body) {
  const s = String(body ?? '').trim();
  if (/^[（(]?\s*A[）)]?([\s，,。.:：]|$)/i.test(s) || /^取?(我|这个?任务|任务\s*#?\d+)这一?侧/.test(s) || /^按\s*HEAD/i.test(s)) return 'ours';
  if (/^[（(]?\s*B[）)]?([\s，,。.:：]|$)/i.test(s) || /^取?项目分支(这|那)?一?侧/.test(s)) return 'theirs';
  return 'other';
}

/** 接受过这个任务签收的那个人（显示名）；没有就 null。 */
function signerOf(db, taskId) {
  const rows = db.all(`SELECT actor_id, payload FROM audit_log WHERE action='task_signed_off' AND target_id=? ORDER BY id DESC`, taskId);
  for (const r of rows) {
    try { if (JSON.parse(r.payload || '{}').accepted) return db.one(`SELECT display_name FROM users WHERE id=?`, r.actor_id)?.display_name ?? r.actor_id; }
    catch { /* 坏 payload 不该连累这一页 */ }
  }
  return null;
}

/**
 * 冲突的另一侧（项目分支那侧）是谁的活、谁签的字 —— **署名恰恰是判断的全部依据**。
 *
 * 机械可算，零模型：`project_task_merged` 审计里有每个任务合并之后的项目分支头，
 * 相邻两个头之间的 diff 就是那个任务带进来的文件。拿它和冲突文件求交，就知道这几处撞的是谁。
 * 算不出来（仓库读不了、审计缺失）就如实说算不出来，不编。
 */
/**
 * 项目分支上**每个已合并任务各带进来了什么**：顺着 `project_task_merged` 审计里记下的头连成一条链，
 * 相邻两个头之间（`上一个头..这一个头`）就是那一次合并带进来的全部东西。合并是 ff-only，任务分支上
 * "把项目分支合进来"的集成提交带进来的都是上一个头已有的东西，所以这段 diff 恰好是那个任务自己的。
 *
 * 两个用户：集成冲突事项的署名（theirSideOwners）与交付页的"哪个文件 / 提交是哪个任务的"。
 * 一处算，两处读 —— 与 addressee.mjs 那条注释同一个理由。
 *
 * 链断了（老项目、手工改过库、上一个头不是这一个头的祖先）就停在那里，`broken` 说明断在哪 —— 不猜。
 * @returns {{ tasks: Array<{taskId, order, title, signer, from, head, files, commits}>, broken: string|null, tail: {from, head, commits}|null }}
 */
export function mergeChainOf(db, project) {
  const rows = db.all(`SELECT payload FROM audit_log WHERE action='project_task_merged' AND target_id=? ORDER BY id`, project.id);
  const tasks = [];
  let prev = project.base_ref, broken = null;
  for (const r of rows) {
    let pl = {};
    try { pl = JSON.parse(r.payload || '{}'); } catch { continue; }
    if (!pl.head) continue;
    try { git(project.repo, 'merge-base', '--is-ancestor', prev, pl.head); }
    catch { broken = `#${pl.order ?? '?'} 合并时记下的头接不上前一个（老项目或手工改过）`; break; }
    let files = [], commits = null;
    try {
      files = git(project.repo, 'diff', '--name-only', `${prev}..${pl.head}`).split('\n').filter(Boolean);
      commits = Number(git(project.repo, 'rev-list', '--count', '--no-merges', `${prev}..${pl.head}`)) || 0;
    } catch { broken = `读不到 #${pl.order ?? '?'} 那一段的提交`; break; }
    const task = db.one(`SELECT title, project_order FROM tasks WHERE id=?`, pl.taskId);
    tasks.push({ taskId: pl.taskId, order: task?.project_order ?? pl.order ?? null, title: task?.title ?? pl.taskId,
      signer: signerOf(db, pl.taskId), from: prev, head: pl.head, files, commits });
    prev = pl.head;
  }
  // 分支头比最后一次合并还往前走了（有人手工往项目分支上提交过）：那一段不属于任何任务，单独说。
  let tail = null;
  if (!broken) {
    try {
      const head = git(project.repo, 'rev-parse', project.branch);
      if (head !== prev) {
        // 连带谁提交的、写了什么（只给一条 git log 命令的话，等于把"安不安全"整个甩给人去查）
        const log = git(project.repo, 'log', '--no-merges', '--format=%h %an：%s', '-n', '5', `${prev}..${head}`).split('\n').filter(Boolean);
        tail = { from: prev, head, commits: Number(git(project.repo, 'rev-list', '--count', '--no-merges', `${prev}..${head}`)) || 0, log };
      }
    } catch { /* 分支读不到：交付页上面那一段已经会说 */ }
  }
  return { tasks, broken, tail };
}

function theirSideOwners(db, { project, files }) {
  const want = new Set(files);
  const hits = [];
  for (const t of mergeChainOf(db, project).tasks) {
    const inter = t.files.filter((f) => want.has(f));
    if (!inter.length) continue;
    hits.push(`任务 #${t.order ?? '?'}「${t.title}」（${inter.join('、')}${t.signer ? `，由${t.signer}签收` : ''}）`);
  }
  return hits.length ? hits.join('；') : '项目分支上已经合并、已经各自签过收的那些任务（算不出具体是哪一个）';
}

/**
 * 集成卡住 → 一条 Ⅲ 级「结构矛盾」事项给负责人。**零模型调用**：冲突文件名与失败输出的尾巴就是全部材料。
 *
 * ⚠️ 这里**不自动把任务放回去做**。最初的设计是"拉执行器做解决冲突步骤，解决不了再提事项"，
 * 实现只做了后半截，理由写在这里而不是藏起来：把一条"去解冲突"的指令塞进任务，要么伪造一个
 * 认证通道（系统替人签名），要么给执行器一条没有指令效力的消息让它自己判断要不要听 —— 两条都比
 * "让人点一下打回"更糟。而"打回签收"这条路本来就在。
 *
 * (A)的措辞：原来三条出路全是命令行命令，而事项底下就摆着答复框 ——
 * 人把完全正确的处置写进答复框，系统记下、关掉事项、什么也不做。现在答复框本身就是(A)，
 * 认证通道没有伪造 —— 走的还是那个人亲自签的那条 message（见下面的 RESOLUTION_HOOKS.structural）。
 */
export function raiseIntegrateBlocked(db, { project, task, result }) {
  const t = now();
  const id = newId('q');
  const conflict = result.kind === 'conflict';
  const head = String(result.target ?? '').slice(0, 8);
  const theirs = conflict ? theirSideOwners(db, { project, files: result.files ?? [] }) : '';
  const mineSigner = signerOf(db, task.id);
  const text = `【结构矛盾】任务 #${task.project_order}「${task.title}」合不进项目分支：${conflict ? '合并有冲突' : '合并之后重跑验收没过'}。\n\n`
    + `原因：这个任务开工之后，项目分支上又合并了别的任务（现在是 ${head}）。系统已经机械地把项目分支合进它的分支`
    + (conflict ? `，但有冲突，已回滚到合并前的状态：\n冲突文件：${(result.files ?? []).join('、') || '（拿不到清单）'}\n`
      + (result.hunks ? `\n撞在一起的是这几行：\n${result.hunks}\n` : '')
      // **署名恰恰是判断的全部依据**。两侧各是谁的活、谁签过字，机器手里全有。
      + `\n两侧分别是谁的：\n`
      // 「我这侧」的"我"容易被读者当成他自己，而不是那个任务。
      // 这个误读会直接把 A/B 选反 —— 全事项里最不能含糊的就是这一处，所以两侧一律按名字叫。
      + `　　**任务 #${task.project_order} 这一侧**（\`<<<<<<< HEAD\` 那一段）= 「${task.title}」${mineSigner ? `，由${mineSigner}签收` : '，还没有人签收过'}\n`
      + `　　**项目分支这一侧**（\`>>>>>>> ${head}…\` 那一段）= ${theirs}\n`
      : `并重跑了它的验收命令与全部回归义务，其中一条没过：\n命令：${(result.argv ?? []).join(' ') || '（没能跑起来）'}${result.regression ? '（这是回归义务里的，不是它自己那条）' : ''}\n退出码：${result.code === null ? '（没跑起来）' : result.code}${result.timedOut ? '（超时）' : ''}\n`)
    // 尾巴是空的就整段不给 —— 一个空的「输出尾部：」看起来像是这一页坏了。
    + (String(result.tail ?? '').trim() ? `\n输出尾部：\n${String(result.tail).split('\n').slice(-20).join('\n')}\n\n` : '\n')
    + `任务没有合并，产物原样留着；项目分支不前进就不会再试一次。本事项由系统直接生成，未调用模型。\n\n`
    // 冲突的答案空间是**封闭的三选一**，系统永远不让 agent 决定合并后长什么样。
    // 先例：answers.mjs 里"签收的答案空间是封闭的：接受 / 打回"，以及会签的 附议/弃权/重申。
    // 曾经有第四条"打回让它自己改"，它曾烧掉一整轮（人看懂了冲突却没法把结论表达成一侧），
    // 换成 merge 之后正确答案基本都落在某一侧上，那条出路的价值没了、代价还在。
    + (conflict
      ? `请选一条（答复里写 A、B 或 C 就行）：\n`
      + `(A) **取任务 #${task.project_order} 这一侧** —— 冲突的每一处都按它的写法定。系统会重做一次合并、只在冲突处取这一侧\n`
      + `　　（同一个文件里没冲突的部分照常合并，不受影响），然后重跑它自己的验收命令与全部回归义务。\n`
      + `(B) **取项目分支这一侧** —— 冲突的每一处都按项目分支上已有的写法定。其余同 (A)。\n`
      + `(C) **两边都不对** —— 系统不动手。出路是在项目页加一个任务去修这一处，或者中止这个任务（都得你自己去点）。\n\n`
      + `⚠ 选 A 或 B 之后，合并出来的是一份**谁都还没签过字的新状态**，所以会重新找你签收一次；\n`
      + `　那一次只给你看这一轮真正变了什么，集成带进来的别人的产物会单独列出来、不混在里面。\n`
      + `⚠ 重跑验收拦得住"合起来跑不起来"，**拦不住这一侧在语义上选错了** —— A/B 是一次取舍，不是一道审批。\n`
      + `⚠ 粒度是"全部冲突文件一起取一侧"，没有逐块挑。如果两处冲突要往不同方向定，那就是 (C)。`
      : `请选一条：\n`
      + `(A) 让它自己改：**直接在下面写下要它怎么改**。你写的那段会原样当成打回理由发给它，\n`
      + `　　任务重新开工，改完再签收 —— 和手敲 node src/cli.mjs signoff ${task.id} --reject "…" 是同一条路，不用再去敲命令。\n`
      + `(B) 先看清楚：到任务页看「改动」「活动」和「日志」，看完再回来选\n`
      + `(C) 这个任务不要了：在项目页中止它（它的下游会跟着停，项目会转停滞等你处理）。这一步不可逆，答复里写"中止"不算数，得你自己去点。`);
  return db.tx(() => {
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, id, task.id, text, t);
    routeQuestion(db, { questionId: id, decisionType: 'structural', typeSource: 'hard_rule', at: t });
    // 同一个项目分支头只试一次：集成 + 重跑要起一次容器，每拍重试一遍就是在烧钱。
    // `taskHead` 是闸的第二把钥匙（见 blockedAtHead）：人打回、它改完、又 done 了一次 → 新的
    // done head ≠ 这一把 → 重新试。这个字段必须写：不写的话
    // blockedAtHead 那一行读的是 undefined，于是"打回让它改"这条路走到底是死的 —— 只有项目分支
    // 恰好又动过才解得开。
    setParam(db, { taskId: task.id, key: 'task.rebase_blocked',
      value: { onto: result.target ?? null, taskHead: doneHeadOf(db, task.id), kind: result.kind, at: t, questionId: id },
      by: { kind: 'agent', id: 'project' }, governance: 'execution' });
    audit(db, { actorKind: 'system', action: 'project_task_integrate_blocked', targetType: 'project', targetId: project.id,
      payload: { taskId: task.id, order: task.project_order, kind: result.kind, onto: result.target ?? null, questionId: id } });
    return { questionId: id, text };
  });
}


/**
 * 集成卡住那条事项答完之后。
 *
 * 事项给的出路若都是**命令行命令**（`signoff --reject` / `replay` / 中止），而事项本身
 * 底下就是一个答复框，负责人会在答复框里写下完全正确的处置（例如"冲突处把 scripts 合并成
 * {test, demo, start} 三项都保留后再提交签收"）—— 系统若只把它记成一条答复、把事项关掉，
 * 就**什么也没发生**：任务仍然 done + 已签收 +
 * 卡在 `task.rebase_blocked` 上，`advanceProject` 每拍回一句没有人看得见的 `rebase_blocked`。
 *
 * 停等账本会把它报成 `unknown`（"这句话没有说谁会让它动起来"）——
 * 但报警不等于修好：人已经做了正确的动作，系统该在那一刻就接住。
 *
 * 所以：**答复这条事项 = 打回签收**。答复正文原样当作打回理由，走既有的修正指令那条路
 * （任务回 running、挂一条紧急 correction、签收作废），与人手敲 `signoff --reject` 一模一样。
 * 唯一的例外是答复明说"中止/不要了"——那要人自己去项目页做，这里不替他做不可逆的动作。
 */
// 运维类只有"交回给人"那几种与停等报警；前者由 handbackHook 认领，后者没有钩子（答复本身就是确认）
RESOLUTION_HOOKS.ops = (db, o) => handbackHook(db, o);
RESOLUTION_HOOKS.structural = (db, o) => projectVerifyHook(db, o) ?? structuralHook(db, o);
/**
 * 项目验收没过之后的"再跑一次"（原来出路是命令行，而且改完验收命令之后页面上没有路重新确认达成）。
 * 项目放回 active：advanceProject 下一拍走 allMerged → 复盘停在 reached → 按当前的验收命令再跑（清空了就直接宣布）。
 */
function projectVerifyHook(db, { question, finalBody, by, at }) {
  if (!String(question.text ?? '').startsWith('【项目验收没过】')) return null;
  const pid = db.one(`SELECT project_id FROM tasks WHERE id=?`, question.task_id)?.project_id;
  if (!pid) return null;
  if (!/^\s*(再跑一次|再跑|重跑|重新验收|再试一次|再试|retry)/i.test(String(finalBody ?? ''))) {
    audit(db, { actorKind: 'user', actorId: by, action: 'project_verify_answer_noted', targetType: 'project', targetId: pid,
      payload: { questionId: question.id, why: '答复不是"再跑一次"：加任务要到项目页「添加任务」，改 / 清验收命令要到项目设置', body: String(finalBody ?? '').slice(0, 200) } });
    return { handled: false };
  }
  db.run(`UPDATE projects SET status='active' WHERE id=? AND status='stalled'`, pid);
  audit(db, { actorKind: 'user', actorId: by, action: 'project_verify_retry_requested', targetType: 'project', targetId: pid, payload: { questionId: question.id, at } });
  return { handled: true, retry: true };
}
function structuralHook(db, { question, finalBody, by, messageId, at }) {
  // 验收没过 / 合并卡住（handback.mjs）先认：同一个类型槽只有一个钩子，按参数里记的事项 id 分派。
  const hb = handbackHook(db, { question, finalBody, by, messageId, at });
  if (hb) return hb;
  const taskId = question.task_id;
  const blocked = getParam(db, taskId, 'task.rebase_blocked');
  if (!blocked || blocked.questionId !== question.id) return null;   // 别的结构矛盾照旧，不插手
  const body = String(finalBody ?? '').trim();
  // ── 冲突那一档：答案空间是封闭的三选一 ───────────────────────────────────────
  // 系统只记下"取哪一侧"，真正的合并在下一拍由 integrateProjectBranch 机械执行 ——
  // 这样解冲突、重跑验收、写审计全都还在那条唯一的路上，不在这里另起一套。
  if (blocked.kind === 'conflict') {
    const side = conflictSide(body);
    if (side === 'ours' || side === 'theirs') {
      setParam(db, { taskId, key: 'task.integrate_resolution',
        value: { side, onto: blocked.onto ?? null, by, at, questionId: question.id },
        by: { kind: 'user', id: by }, governance: 'constitutional' });
      setParam(db, { taskId, key: 'task.rebase_blocked', value: null, by: { kind: 'agent', id: 'project' }, governance: 'execution' });
      audit(db, { actorKind: 'user', actorId: by, action: 'project_task_conflict_side_chosen', targetType: 'task', targetId: taskId,
        payload: { questionId: question.id, side, onto: blocked.onto ?? null, messageId } });
      return { handled: true, side };
    }
    // (C)「两边都不对」/ 看不懂的自由文本：**系统不动手**，闸原样留着。
    // 出路（加任务去修 / 中止）都是人在项目页上的动作，不是一条答复能完成的事。
    // 任务因此停在"说不出在等谁"上 —— 那正是停等账本会报警的形状，它会挂一条报警事项把接收者补回来。
    audit(db, { actorKind: 'user', actorId: by, action: 'project_task_conflict_declined', targetType: 'task', targetId: taskId,
      payload: { questionId: question.id, body: body.slice(0, 300),
        why: side === 'other' ? '答复是(C)两边都不对：出路是加任务去修或中止，都要人自己去点' : '答复不是 A/B/C 里的任何一条，系统不猜一侧' } });
    return { handled: false, declined: true };
  }
  if (/^(中止|放弃|不要了|abort)/.test(body)) {
    audit(db, { actorKind: 'user', actorId: by, action: 'project_task_integrate_answer_abort', targetType: 'task', targetId: taskId,
      payload: { questionId: question.id, why: '答复要求中止，这一步不可逆，留给人在项目页做' } });
    return { handled: false, abort: true };
  }
  // 与 signoff --reject 同一条路：复用那条答复的令牌（同一人、同一决策、系统代拟），
  // 与 RESOLUTION_HOOKS.signoff 的边界说明同理 —— 别把这个模式推广到别处。
  const tok = messageId ? db.one(`SELECT token_id FROM messages WHERE id=?`, messageId)?.token_id ?? null : null;
  const mid = newId('m');
  const reason = `【集成冲突】${body}`;
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
          VALUES (?,?,?,?,'correction','explicit','urgent','explicit','user-authenticated',?,?)`, mid, taskId, by, reason, tok, at);
  if (messageId) insertEdge(db, mid, messageId, 'derived_from', at);
  setParam(db, { taskId, key: 'signoff.status', value: 'rejected', by: { kind: 'user', id: by }, governance: 'constitutional' });
  // 解开集成闸：人已经给了处置，下一轮该重新试，而不是继续"同一个头不再试"。
  setParam(db, { taskId, key: 'task.rebase_blocked', value: null, by: { kind: 'agent', id: 'project' }, governance: 'execution' });
  if (db.one(`SELECT status FROM tasks WHERE id=?`, taskId)?.status === 'done') {
    db.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);
    audit(db, { actorKind: 'user', actorId: by, action: 'task_resumed', targetType: 'task', targetId: taskId,
      payload: { from: 'done', to: 'running', via: 'integrate_conflict_answered' } });
  }
  audit(db, { actorKind: 'user', actorId: by, action: 'message_received', targetType: 'task', targetId: taskId,
    payload: { messageId: mid, kind: 'correction', kindSource: 'explicit', urgency: 'urgent', urgencySource: 'explicit', via: 'integrate_conflict' } });
  return { handled: true, messageId: mid };
};
// ── 让路 ──────────────────────────────────────────────────────────────────
// 并发在这里不是"吞吐旋钮"，是一条很窄的规则：**开着的任务全都在等人的时候，独立的下一个
// 可以先跑起来**。串行时 B 在等人答题，C 就干等着；那段时间是白白浪费的墙钟，而不是安全余量。
//
// 判据直接复用停等账本的 `answerableQuestion`：它已经定义过"这条事项真的
// 有人会看到"，而"有人会看到"正是"在等人"的全部含义。**不另写一个近似的判断** —— 两处各写
// 一遍的下场就是某天一处认得、另一处不认得，而那种不一致没有任何测试会自己发现。
//
// 三条边界：
//   - 上限默认 2（`project.max_open`，最高 4）。每多开一个就多一份集成 + 重跑全部回归义务的代价。
//   - **只在开着的任务全都在等人时才让路**。有一个真的在跑，就不开新的 —— 那不是让路，是加塞。
//   - 让路开的是 `ready` 里编号最小的那个，它的依赖必须**都已合并**（不是"都开着"）。
//     所以"让路"永远只发生在互相独立的任务之间，这是依赖图自己保证的，不用额外判断。

/** 项目分支当前头；取不到就 null（调用方一律按"不确定"处理）。 */
const projectHead = (p) => { try { return git(p.repo, 'rev-parse', p.branch); } catch { return null; } };

/**
 * 签收签的是不是**现在这一份产物**。
 *
 * 换成 merge 之前这条是松的，而且无害：rebase 会重写整条历史，签收记下的那个头连分支上都不在了，
 * 真正把关的是 `raiseSignoffQuestion` 里那条"产物变了就作废、重新签"。
 * 换成 merge 之后它变成**承重的**：集成会正大光明地让工作区的头往前走一个合并提交，而按签收作废的边界
 * **干净集成不作废签收**（没有任何人在那一刻做过内容决定）—— 于是"头动过"不再等价于"没签过"，
 * 得有一条显式的判断。用 `task_done` 的头比，而不是工作区 HEAD：集成不改前者，正好把两件事分开。
 *
 * 拿不到（老任务、审计缺失）→ 放行，与这次改动之前一致：这条是补一道闸，不是新加一道门槛。
 */
export function signoffCoversDone(db, taskId, wsHead = null) {
  const signed = signoffHeadOf(db, taskId);
  const done = doneHeadOf(db, taskId);
  if (!signed || !done) return true;
  // 第二种合法情形：解过冲突的集成作废了签收、人对着**集成之后那个头**重新签了一次。
  // 那时候 `task_done` 的头还停在集成之前 —— 它记的是"任务做完那一刻"，集成不改它，本来就该不改。
  return signed === done || (!!wsHead && signed === wsHead);
}

/** 任务工作区当前的 HEAD；取不到就 null。 */
const wsHeadOf = (home, taskId) => { try { return git(join(home, 'workspaces', taskId), 'rev-parse', 'HEAD'); } catch { return null; } };

/**
 * 这个任务是不是"被集成卡在当前这个项目分支头上"。项目分支动过、或它自己又产出过新东西，
 * 都算情况变了，再试一次。—— 不这样的话，人打回让它改完、改好了也再也合不进来。
 */
export function blockedAtHead(db, taskId, head) {
  const b = getParam(db, taskId, 'task.rebase_blocked');
  if (!b) return false;
  if (head && b.onto && b.onto !== head) return false;
  const doneHead = doneHeadOf(db, taskId);
  if (doneHead && b.taskHead && b.taskHead !== doneHead) return false;
  return true;
}

/** 开着的任务里第一个说得出理由的那个 —— 沿用引入让路之前的那几句话，界面与测试都在读它们。 */
function openWhy(db, list, head) {
  const t = list[0];
  if (!t) return null;
  if (blockedAtHead(db, t.id, head)) return 'integrate_blocked';
  if (t.status !== 'done') return `waiting:${t.status}`;
  return 'needs_signoff';
}

/**
 * 这一拍能不能开一个新任务。返回 `{ taskId, why }`：`taskId` 非空就开它，否则 `why` 是不开的理由。
 */
export function lettableNext(db, { project, sch, home }) {
  void home;
  const head = projectHead(project);
  const ready = sch.ready[0] ?? null;
  if (!ready) return { taskId: null, why: openWhy(db, sch.open, head) };
  if (!sch.open.length) return { taskId: ready.id };                       // 没人开着：照旧，这不是并发
  const maxOpen = maxOpenOf(db, project.id);
  if (sch.open.length >= maxOpen) return { taskId: null, why: openWhy(db, sch.open, head) ?? `at_capacity:${maxOpen}` };
  const busy = sch.open.filter((t) => !waitingOnHuman(db, t.id));
  if (busy.length) return { taskId: null, why: openWhy(db, busy, head) };  // 有一个真的在跑 → 不加塞
  return { taskId: ready.id, lettingThrough: true };
}
