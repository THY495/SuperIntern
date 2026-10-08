// 并行开发：契约优先 + 行走骨架的规划形状，纯函数、零模型。
//
// 形状：#1 骨架（kind = skeleton，不依赖谁）→ 若干模块任务（kind = module，只依赖骨架，范围两两不相交）
// → 最后一个集成任务（kind = integration，依赖全部模块）。顶层 shared_paths = 骨架定下、之后对模块任务只读的路径。
//
// 为什么在这里机械地卡，而不只写在提示词里：范围相交 = 两个同时开着的任务改同一处 = 合并时回头问人取哪一侧。
// 这正是"并行"把串行时不存在的代价带回来的地方；它能在批准之前、零成本地被判出来，就不该留到合并时才发现。
import { normScopePaths, prefixesOfPaths, filesOfPaths, scopePathProblems, scopePathsOf } from './routing.mjs';
import { getParam, getProjectParam, setProjectParam } from './params.mjs';
import { parallelOf } from './project-settings.mjs';
import { PREVIEW_FILE } from './preview.mjs';

export const TASK_KINDS = ['skeleton', 'module', 'integration'];

/** 两组结构化路径是否相交（目录前缀互为前缀，或文件落在对方目录下，或点名同一个文件）。返回相交处。 */
export function pathsOverlap(a, b) {
  const A = normScopePaths(a), B = normScopePaths(b);
  if (A.includes('*') || B.includes('*')) return ['*'];
  const pa = prefixesOfPaths(A), pb = prefixesOfPaths(B), fa = filesOfPaths(A), fb = filesOfPaths(B);
  const under = (f, pre) => pre.some((q) => f === q || f.startsWith(`${q}/`));
  const out = new Set();
  for (const p of pa) for (const q of pb) if (p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)) out.add(`${p.length >= q.length ? p : q}/`);
  for (const f of fa) if (fb.includes(f) || under(f, pb)) out.add(f);
  for (const f of fb) if (under(f, pa)) out.add(f);
  return [...out];
}

/** 一条路径是否被一组路径覆盖（等于其中某个文件，或落在其中某个目录下）。 */
export function coveredBy(path, paths) {
  const P = normScopePaths(paths);
  if (P.includes('*')) return true;
  const p = path.replace(/\/+$/, '');
  return filesOfPaths(P).includes(path) || prefixesOfPaths(P).some((q) => p === q || p.startsWith(`${q}/`));
}

/**
 * 并行规划的形状校验。返回错误列表（给模型看的，中文，与 validateProjectSpec 同一个口径）。
 * `spec` = propose_project 的参数（tasks、shared_paths）。
 */
export function validateParallelPlan(spec) {
  const errs = [];
  const tasks = Array.isArray(spec?.tasks) ? spec.tasks : [];
  const shared = spec?.shared_paths;
  const sp = scopePathProblems(shared);
  if (!Array.isArray(shared) || !normScopePaths(shared).length) errs.push('并行模式要给顶层 shared_paths：骨架定下、之后对模块任务只读的路径（接口契约、根依赖清单与锁文件、根验收脚本、README、.gitignore、共享的类型 / 常量）');
  else if (sp.length) errs.push(...sp.map((p) => `shared_paths：${p}`));
  else if (normScopePaths(shared).includes('*')) errs.push('shared_paths 不能是 *（那等于整个仓库对模块任务只读）');
  tasks.forEach((t, i) => { if (!TASK_KINDS.includes(t?.kind)) errs.push(`tasks[${i}] 缺 kind 或取值不对：要是 ${TASK_KINDS.join(' / ')} 之一`); });
  if (errs.length) return errs;

  const kinds = tasks.map((t) => t.kind);
  if (kinds[0] !== 'skeleton') errs.push('第 1 个任务必须是骨架任务（kind = "skeleton"）');
  if (kinds.filter((k) => k === 'skeleton').length > 1) errs.push('只能有一个骨架任务');
  const skel = tasks[0];
  if (kinds[0] === 'skeleton' && Array.isArray(skel.depends_on) && skel.depends_on.length) errs.push('骨架任务不依赖任何任务：depends_on 写 []');
  const mods = tasks.map((t, i) => ({ t, n: i + 1 })).filter(({ t }) => t.kind === 'module');
  if (mods.length < 2) errs.push(`至少要 2 个模块任务（kind = "module"），现在 ${mods.length} 个；规格里只有一个能独立开发的部分，就不要开并行模式`);
  const integ = tasks.map((t, i) => ({ t, n: i + 1 })).filter(({ t }) => t.kind === 'integration');
  if (integ.length !== 1) errs.push(`要有且只有一个集成任务（kind = "integration"），现在 ${integ.length} 个`);
  else if (integ[0].n !== tasks.length) errs.push('集成任务要排在最后');
  else {
    const d = integ[0].t.depends_on;
    const missing = mods.map((m) => m.n).filter((n) => !(Array.isArray(d) && d.includes(n)));
    if (missing.length) errs.push(`集成任务要依赖全部模块任务：depends_on 缺 ${missing.map((n) => `#${n}`).join('、')}`);
  }
  if (kinds[0] === 'skeleton') {
    const notCovered = normScopePaths(shared).filter((p) => !coveredBy(p, skel.scope_paths));
    if (notCovered.length) errs.push(`骨架任务的 scope_paths 要覆盖全部 shared_paths（它负责把这些定下来），缺：${notCovered.join('、')}`);
  }
  for (const { t, n } of mods) {
    const d = t.depends_on;
    if (!Array.isArray(d) || !d.includes(1)) errs.push(`模块任务 #${n} 要依赖骨架：depends_on 写 [1]（真要用到别的模块的实现才再加上它）`);
    if (normScopePaths(t.scope_paths).includes('*')) errs.push(`模块任务 #${n} 的 scope_paths 不能是 *：只写自己模块的目录`);
    const hit = pathsOverlap(t.scope_paths, shared);
    if (hit.length) errs.push(`模块任务 #${n} 的 scope_paths 与 shared_paths 相交（${hit.join('、')}）：共享的路径由骨架定下、对模块任务只读`);
  }
  for (let i = 0; i < mods.length; i++) for (let j = i + 1; j < mods.length; j++) {
    const hit = pathsOverlap(mods[i].t.scope_paths, mods[j].t.scope_paths);
    if (hit.length) errs.push(`模块任务 #${mods[i].n} 与 #${mods[j].n} 的 scope_paths 相交（${hit.join('、')}）：模块之间范围要两两不相交 —— 它们会同时开着，改同一处合并时就要回头问人`);
  }
  return errs;
}

/** 模块任务之间额外的依赖边（除了骨架）—— 每多一条，就少一份并行。批准页与比较报告用。 */
export function extraModuleDeps(spec) {
  const tasks = spec?.tasks ?? [];
  const isMod = (n) => tasks[n - 1]?.kind === 'module';
  return tasks.flatMap((t, i) => (t.kind === 'module' ? (t.depends_on ?? []).filter((n) => n !== 1 && isMod(n)).map((n) => [i + 1, n]) : []));
}

// ── 落库与执法 ───────────────────────────────────────────────────────────

export const SHARED_PATHS_KEY = 'project.shared_paths';

/** 草案定稿时记下共享路径（项目层；新一版草案覆盖旧的）。 */
export function recordSharedPaths(db, { projectId, paths, userId }) {
  setProjectParam(db, { projectId, key: SHARED_PATHS_KEY, value: normScopePaths(paths), by: { kind: 'user', id: userId }, governance: 'constitutional' });
}
export const sharedPathsOf = (db, projectId) => normScopePaths(getProjectParam(db, projectId, SHARED_PATHS_KEY) ?? []);

/**
 * 这个任务改不得的路径：并行项目里的模块任务 → 共享路径 + 截图说明；其余（骨架、集成、串行项目）→ 无。
 * 截图说明（si-preview.json）全项目只有一份，并行时由骨架写、集成任务补样例数据 —— 不进 shared_paths 是因为
 * 它不归规划器管（规划器不知道有这份文件），但对模块同样只读（否则几个模块各写一份，合并必然冲突）。
 */
export function lockedPathsFor(db, taskId) {
  const t = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId);
  if (!t?.project_id || !parallelOf(db, t.project_id)) return [];
  if (getParam(db, taskId, 'task.kind') !== 'module') return [];
  const shared = sharedPathsOf(db, t.project_id);
  return coveredBy(PREVIEW_FILE, shared) ? shared : [...shared, PREVIEW_FILE];
}

/**
 * 人批准放行的共享路径：模块任务当前契约的 scope_paths 里与共享路径重叠的那几条。
 * 规划时模块的 scope_paths 与共享路径两两不交（validateParallelPlan），所以重叠只可能来自之后**人批准过的契约变更**
 * （更正 → 重规划改了 scope_paths → 负责人批准）。比如网页任务要加测试依赖，负责人批准了"为此更新根锁文件"，
 * 重规划也把 package-lock.json 写进了 scope_paths；锁若照旧拒收 —— 人批准过也解不开，只剩关掉并行一条路。
 */
export function grantedSharedFor(db, taskId) {
  const shared = lockedPathsFor(db, taskId);
  if (!shared.length) return [];
  return scopePathsOf(db, taskId).filter((p) => pathsOverlap([p], shared).length > 0);
}

/**
 * 给规划器 / 执行器看的那一段（context/assemble.mjs 挂在宪法块后面）。不是新规则 —— 执法在 executor 的 lockedPaths；
 * 这一段让模型**事先**知道自己处在什么位置，不必撞了"改了共享路径"的拒收才明白。
 */
export function parallelText(db, taskId) {
  const t = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId);
  if (!t?.project_id || !parallelOf(db, t.project_id)) return '';
  const kind = getParam(db, taskId, 'task.kind');
  const granted = grantedSharedFor(db, taskId);
  const shared = sharedPathsOf(db, t.project_id).join('、') || '（无）';
  const locked = lockedPathsFor(db, taskId).join('、') || '（无）';
  if (kind === 'skeleton') return '\n\n## 并行开发：你是骨架任务\n'
    + `你合并之后，本项目的各模块会由几个实现方**同时**开发，每个只能改自己的目录、改不得共享路径（${shared}）。`
    + '所以要在你这里一次定下它们需要的东西：接口契约写死名字（路径、字段、状态码、导出名、命令行参数与退出码）；两个模块都要遵守的内部约定（共用的表结构、活动 / 事件的格式、环境变量）写进契约文件；'
    + '每个模块要用的第三方依赖现在就装好、写进依赖清单（之后锁文件对模块只读）—— **包括各模块的测试运行器与测试库**（例如前端的组件测试框架与 DOM 环境），并给每个模块在它自己的清单里留好 test 脚本；'
    + '几个模块共用的数据库：把表结构（表名、列名与类型）写进契约文件，写明哪个模块写、哪个模块读；根验收脚本留好各模块的位置。桩实现只要让契约测试与串通跑过，**不要实现业务**。';
  if (kind === 'module') return '\n\n## 并行开发：你是模块任务\n'
    + '别的模块正由别人**同时**开发，你看不到它们的进展，也不要去改它们的目录。只按骨架定下的接口契约写；需要别的模块配合的地方，对着它的桩 / 契约写。'
    + `共享路径对你**只读**：${locked}。缺依赖、契约少一个字段、契约有错 —— 不要自己改，用 raise_question 说明要改什么、为什么（那是计划变更，由人批准）。`
    + '装依赖不要改动锁文件（锁文件也是共享路径）：骨架已经装好你要用的依赖。'
    + (granted.length ? `例外：人批准过的契约变更放行了 ${granted.join('、')} —— 这几处你可以改，只为契约里写明的那个目的。` : '')
    // 模块任务容易把"测试先行"的验收写成"目标文件不存在 → Cannot find module"，撞上骨架放好的桩，就各提一条结构问题
    + '你的目录里**已经有骨架放的桩**（能跑，按契约报"未实现"或返回占位结果）。测试先行时，实现前的失败基线是"桩的行为不合测试"，不是"文件不存在"；实现时直接改写桩的内容，不必删它。';
  if (kind === 'integration') return '\n\n## 并行开发：你是集成任务\n'
    + '各模块是对着同一份契约分别开发、分别合并的；你要把它们真接起来跑端到端，补齐根验收脚本里的端到端检查。'
    + '发现某个模块与契约对不上：模块里明显的接线问题可以修；改契约本身要用 raise_question。';
  return '';
}
