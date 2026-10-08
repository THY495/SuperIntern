// 工作区 —— agent 动的那份代码。
//
// ⚠️ 硬要求：**副本是必须的，不是讲究**。任务可能要改系统自己的代码（例如
// `src/llm/`），而系统自己的运行时正依赖这份代码。agent 动的必须是副本，
// 系统进程加载的必须是原件。同一份目录会让"改坏了"直接表现为编排器自己崩掉，
// 而且分不清是任务失败还是系统失败。
//
// 用 git clone 而不是拷目录：产物要落在一个 git 分支上，且 clone
// 天然带来"改了什么"的机械判据（git diff / git status --porcelain），
// 而验收标准必须是机械可判的。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { audit, newId } from '../db/db.mjs';
import { I18nError, tl } from '../i18n/index.mjs';

const gitRaw = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (cwd, ...args) => gitRaw(cwd, ...args).trim();

/** 当前 HEAD。每个节点开跑前取一次，作为该节点产物的基线。 */
export const headOf = (dir) => git(dir, 'rev-parse', 'HEAD');

const hasCommit = (dir, sha) => {
  try { gitRaw(dir, 'cat-file', '-e', `${sha}^{commit}`); return true; } catch { return false; }
};

const BASE_KEY = (nodeId) => `node.${nodeId}.base_ref`;

/**
 * 节点产物基线 —— **落库，跨进程延续**。
 *
 * 曾出现过：节点提问挂起前 agent 自己 `git commit` 了工作，答完复工是
 * 一个新进程，它取"开跑这一刻的 HEAD"当基线 —— 正好是那次提交。于是它的全部产物
 * 相对基线"没有任何改动"，交接被拒；它随即造了一个 RESULTS.md 当产物交上去过了校验。
 * 校验规则没错，错的是基线：**一个节点的基线是它这一段工作的起点，不是这一段进程的起点。**
 *
 * 同一节点的一段工作 = 从第一次开跑到 done；期间的挂起/复工/崩溃重试都延续这条基线。
 * 修正把它改了规格重做，是新的一段（applyRevision 里清）。
 * 记录的 sha 若在工作区里已不存在（工作区重建过），当作没记，重取。
 */
export function nodeBaseline(db, { taskId, nodeId, workspace, actorId = 'executor' }) {
  const key = BASE_KEY(nodeId);
  const row = db.one(`SELECT value FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL
                      ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, taskId, key);
  const stored = row ? JSON.parse(row.value) : null;
  if (stored && hasCommit(workspace, stored)) return { base: stored, resumed: true };
  const head = headOf(workspace);
  const t = Date.now();
  db.run(`UPDATE params SET superseded_at=?, valid_to=? WHERE task_id=? AND key=? AND superseded_at IS NULL`, t, t, taskId, key);
  db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
          VALUES (?,?,?,?,'task','execution','agent',?,?,?)`,
  newId('p'), taskId, key, JSON.stringify(head), actorId, t, t);
  return { base: head, resumed: false };
}

/** 这一段工作结束（done，或修正改了规格要重做）：基线作废，下一段重取。 */
export function clearNodeBaseline(db, { taskId, nodeId }) {
  const t = Date.now();
  db.run(`UPDATE params SET superseded_at=?, valid_to=? WHERE task_id=? AND key=? AND superseded_at IS NULL`,
    t, t, taskId, BASE_KEY(nodeId));
}

/** 任务工作区建立时的 commit（`workspace_created` 审计里的 head）—— 读的正是下面 `ensureWorkspace` 写的那条。 */
export function baseHeadOf(db, taskId) {
  const row = db.one(`SELECT payload FROM audit_log WHERE action='workspace_created' AND target_id=? ORDER BY id DESC LIMIT 1`, taskId);
  try { return row ? JSON.parse(row.payload).head ?? null : null; } catch { return null; }
}

/**
 * 「这个**任务**相对项目分支贡献了什么」—— 归属基线。
 *
 * 基线 = `git merge-base <项目分支此刻的头> <任务头>`，也就是 GitHub 看 PR diff 的口径。
 * 没有集成过的时候它与现状公式（工作区建立时的头）**一字不差** —— 所以这是严格泛化，不是行为变更；
 * 一旦任务分支把项目分支合进来过，现状公式就会把别人的产物算到这个任务头上。
 * 例如一次集成之后：现状公式算出 8 files/+502（混进了别的任务的三个 `client/` 文件），这条公式 5 files/+318。
 *
 * ⚠️ 别和 `nodeBaseline` 搞混，两者问的不是同一个问题：`nodeBaseline` 问"这个**节点**这一段工作改了什么"，
 * 而集成不发生在任何节点的生命周期里 —— 所以那一个**不能**跟着改，改了才会把集成算成某个节点的产物。
 *
 * 取不到项目分支（旧的独立任务 / 项目行没了 / 那个 commit 不在工作区的对象库里）→ 回落 `baseHeadOf`，
 * 行为与这次改动之前完全一致。**不为此去 fetch**：需要 fetch 的那几种情形下 merge-base 的答案
 * 恰好就等于回落值，白付一次副作用。
 */
export function contributionOf(db, { taskId, home = null, dir = null, head = null }) {
  const wsDir = dir ?? (home ? join(home, 'workspaces', taskId) : null);
  const tip = head ?? null;
  let base = null;
  let via = 'merge-base';
  if (wsDir && tip && existsSync(wsDir)) {
    const p = db.one(`SELECT p.repo AS repo, p.branch AS branch FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?`, taskId);
    if (p?.repo && p?.branch) {
      try {
        const sha = git(p.repo, 'rev-parse', p.branch);
        if (hasCommit(wsDir, sha) && hasCommit(wsDir, tip)) base = git(wsDir, 'merge-base', sha, tip);
      } catch { base = null; }
    }
  }
  if (!base) { base = baseHeadOf(db, taskId); via = 'workspace_created'; }
  let files = null;
  let stat = null;
  if (wsDir && tip && base && base !== tip) {
    try {
      files = git(wsDir, 'diff', '--name-only', `${base}..${tip}`).split('\n').filter(Boolean);
      stat = git(wsDir, 'diff', '--stat', `${base}..${tip}`);
    } catch { files = null; stat = null; }
  }
  return { base, head: tip, via, files, stat, dir: wsDir };
}

/**
 * 相对某个基线 commit **真正变过**的文件清单（不含目录）。
 *
 * ⚠️ 这是"产物"的机械定义，来自一次教训：曾有一条通过的交接记录里，
 * 第二条产物是 `早期验证脚本` —— 一个执行器越界建出来的**空目录**
 * （那是下游节点的活）。当时的校验只问"这个路径存在吗"，于是它过了。
 * "存在"和"是你产出的"是两回事，而工作区是 git repo 正是为了能问后一个问题。
 *
 * ⚠️ 基线必须是**该节点开跑时的 HEAD**，不能是工作区建立时的固定标记：
 * 每个节点完成后都会提交，用固定基线的话，第二个节点可以把第一个节点的产物
 * 算成自己的——那正是这条校验要防的事，只是换了个人骗。
 *
 * 用记录下来的 sha 而不是"工作区脏不脏"，是因为 agent 手里有 git：
 * 它自己 commit 一次工作区就干净了，按脏不脏判会把真产物判成没产出。
 */
export function changedSince(dir, base) {
  if (!base) throw new Error('changedSince 需要基线 commit —— 没有基线就没有"谁产出的"这个问题');
  const tracked = git(dir, 'diff', '--name-only', base);
  const untracked = git(dir, 'ls-files', '--others', '--exclude-standard');
  return new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean));
}

/**
 * 依赖目录不算"这一步改了什么"。
 *
 * 越界校验与节点提交都靠 git 看改动（changedSince = diff + 未跟踪且没被忽略的文件）。新建的空仓库没有 .gitignore，
 * agent 一 `npm install` / 建 `.venv`，成千上万个文件全算成本节点的改动 —— 要么被判越界撤销，要么被提交进仓库。
 * 写进 `.git/info/exclude` 而不是 .gitignore：它不进仓库、不改任何人的文件，只影响这份工作区里 git 怎么看。
 * 幂等：已经写过就不再写。
 */
//
// 构建产物同理：早先的任务把 `frontend/dist/` 提交进了仓库（写 .gitignore 的那一步排在它后面），
// 之后每个任务的验收一跑 `npm run build` 就改动这些已跟踪的文件，撞"验收不许留下改动"—— 引出一连串停摆。
// 不放 `build/`、`out/`：有些项目拿它们放源码（vue-cli 2 的 `build/` 是 webpack 配置），排除了 agent 新写的文件就静默进不了仓库。
/**
 * 行尾按仓库原样，**写进这个仓库自己的配置**。克隆时带的 `-c core.autocrlf=false` 只管克隆那一条命令；之后系统在宿主机上
 * 往工作区里合并、检出、解冲突，读的是 Git for Windows 的系统级 core.autocrlf=true，照样签出成 CRLF —— Linux 沙箱里
 * 逐字比对的测试就挂（合并后契约测试成片失败，执行器修来修去一直修到撞调用上限）。
 * 仓库级配置压过系统级。
 */
export const pinLineEndings = (dir) => git(dir, 'config', 'core.autocrlf', 'false');

export const DEP_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.npm/', '.cache/', 'dist-newstyle/', '.si-preview/', '*.db', '*.sqlite', '*.sqlite3', '*.db-journal', '*.db-wal', '*.db-shm',
  'dist/', 'coverage/', '.next/', '.nuxt/', '.vite/', '.turbo/', '.parcel-cache/', '*.tsbuildinfo',
  // 测试工具跑一遍就会写出来的产物（比如 Playwright 失败时往 frontend/test-results/ 写 .last-run.json、error-context.md，
  // 交接次次被范围校验判越界，直到撞重试上限）。它们与 coverage/ 同类：跑测试的副产物，不是谁的改动。
  'test-results/', 'playwright-report/', 'blob-report/', '.nyc_output/', 'htmlcov/', '.coverage',
  // pip install -e 留下的包元数据（比如 UNKNOWN.egg-info/，不排除就会让交接被判越界）
  '*.egg-info/'];

/**
 * 这条路径是不是构建产物（能从源码重新生成、丢了不损失任何人的工作）。
 * 比上面的排除清单宽（含 `build/`、`out/`）：这里只用来判断"一处**没提交**的改动能不能由系统自己撤掉"，
 * 撤的是签收之后 / 验收之后多出来的东西，撤掉之后工作区回到**已提交的那一版** —— 不会丢掉任何提交过的内容。
 */
const BUILD_DIRS = new Set(['dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.vite', '.turbo', '.parcel-cache', 'test-results', 'playwright-report', 'blob-report', '.nyc_output', 'htmlcov']);
export const isBuildOutput = (p) => {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/$/, '');
  return s.endsWith('.tsbuildinfo') || s.split('/').some((seg) => BUILD_DIRS.has(seg) || seg.endsWith('.egg-info'));
};

/**
 * 撤掉工作区里这些路径上**没提交**的改动：被跟踪的还原到 HEAD，未跟踪（且没被忽略）的删掉。只动传进来的路径。
 * 路径取自 `workspaceStatus().changed`（porcelain 会把整个未跟踪目录折成一行 `dir/`，照样认）。
 */
export function discardChanges(dir, paths) {
  for (const raw of paths) {
    const p = String(raw).replace(/\/$/, '');
    if (!p || p.includes('..')) continue;
    if (git(dir, 'ls-files', '--', p)) { try { git(dir, 'checkout', '-q', 'HEAD', '--', p); } catch { /* 已删掉的整目录：下面 clean 兜 */ } }
    git(dir, 'clean', '-fdq', '--', p);
  }
  return workspaceStatus(dir).changed;
}
const EXCLUDE_MARK = '# superintern: 依赖与缓存目录（系统写入，不进仓库）';
export function writeDepExcludes(ws) {
  try {
    const f = join(ws, '.git', 'info', 'exclude');
    mkdirSync(join(ws, '.git', 'info'), { recursive: true });
    const cur = existsSync(f) ? readFileSync(f, 'utf8') : '';
    const sep = cur && !cur.endsWith('\n') ? '\n' : '';
    // 已经写过的工作区：只补缺的那几行（清单会长：例如截图的临时目录 .si-preview/ 就是后加的）
    if (cur.includes(EXCLUDE_MARK)) {
      const have = new Set(cur.split('\n').map((l) => l.trim()));
      const miss = DEP_EXCLUDES.filter((x) => !have.has(x));
      if (!miss.length) return false;
      writeFileSync(f, `${cur}${sep}${miss.join('\n')}\n`);
      return true;
    }
    writeFileSync(f, `${cur}${sep}${EXCLUDE_MARK}\n${DEP_EXCLUDES.join('\n')}\n`);
    return true;
  } catch { return false; }   // 写不进去不连累开工作区：代价是依赖目录会被当成改动，越界校验会说出来
}

/**
 * 删一份工作区目录，包括容器在里面建的符号链接（Windows 宿主上会撞到）。
 *
 * venv 的 bin/python、npm 的 node_modules/.bin/* 都是容器里建的 Linux 符号链接；Docker Desktop 把它们落到 NTFS 上之后，
 * Windows 这一侧**既读不了也删不掉**（"The file cannot be accessed by the system"）。于是一份装过依赖的工作区，
 * 下一次要强制重建（项目级验收每次都重新克隆、重做 / 恢复任务）就直接失败。WSL / Linux 宿主上不会出现。
 * 普通删除失败时，起一个一次性容器从 Linux 那一侧把内容删掉，再删目录本身。没有容器运行时就把原来的错误抛出去。
 */
export function forceRemoveDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); return; } catch (e) {
    try {
      execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', `${dir}:/x`, 'superintern/sandbox:v0.1',
        'sh', '-c', 'find /x -mindepth 1 -delete'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { throw e; }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 为任务开一份工作区：源仓库的 clone + 独立分支。
 *
 * @param {string} source  源仓库路径（必须是 git repo，且**不是**工作区本身）
 * @param {string} dir     工作区路径
 * @returns {{dir, branch, head, created}}
 */
export function ensureWorkspace(db, { taskId, source, dir, force = false, ref = null, empty = false }) {
  const ws = resolve(dir);
  const branch = `v0/${taskId}`;

  // 新项目（从想法开始）：没有源仓库，起一个空仓库 + 一个空提交，让后面所有"基线 = HEAD"的
  // 逻辑（节点基线、净改动守卫、交付）照常成立。
  if (empty) {
    if (existsSync(ws)) {
      if (!force) { writeDepExcludes(ws); return { dir: ws, branch: git(ws, 'rev-parse', '--abbrev-ref', 'HEAD'), head: git(ws, 'rev-parse', 'HEAD'), created: false }; }
      forceRemoveDir(ws);
    }
    mkdirSync(ws, { recursive: true });
    git(ws, 'init', '-q', '-b', branch);
    pinLineEndings(ws);
    git(ws, '-c', 'user.name=superintern', '-c', 'user.email=superintern@local', 'commit', '-q', '--allow-empty', '-m', `init: ${taskId}`);
    const head = git(ws, 'rev-parse', 'HEAD');
    writeDepExcludes(ws);
    audit(db, { actorKind: 'system', action: 'workspace_created', targetType: 'task', targetId: taskId,
      payload: { dir: ws, branch, source: null, ref: null, head, empty: true } });
    return { dir: ws, branch, head, ref: null, created: true };
  }

  const src = resolve(source);
  if (ws === src) throw new I18nError('工作区不能是源仓库本身——agent 会改到系统自己正在加载的代码');
  if (!existsSync(join(src, '.git'))) throw new I18nError('源不是 git 仓库：{path}', { path: src });

  if (existsSync(ws)) {
    if (!force) {
      writeDepExcludes(ws);
      return { dir: ws, branch: git(ws, 'rev-parse', '--abbrev-ref', 'HEAD'),
        head: git(ws, 'rev-parse', 'HEAD'), created: false };
    }
    forceRemoveDir(ws);
  }

  mkdirSync(ws, { recursive: true });
  // ⚠️ 这里原来的注释写着"单分支浅克隆"，而命令是 `git clone --no-hardlinks` ——
  // **既没有 --depth 也没有 --single-branch**。注释声称的属性，代码没有提供。
  // （与当年 `containedPath` 那句"已挡住符号链接"是同一类错误：把意图写成了事实。）
  // autocrlf 关掉：Windows 上默认 true，克隆把文件写成 CRLF，容器（Linux）里的 git 一开始就报 ' M'，
  // agent 得花两条假设去证明"不是我改的"。工作区只给容器用，行尾按仓库原样。
  git(src, '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-hardlinks', src, ws);
  pinLineEndings(ws);

  // `ref` 让工作区落在某个历史提交上，而不是当前 HEAD。
  //
  // 源仓库可能含有比 ref 更新的文件。只签出旧提交，仍能通过其它引用读取这些文件。
  // 指定 ref 时需要隔离后续历史，保证工作区只包含该提交及其祖先。
  //
  // ⚠️ 光签出旧提交**不是隔离**，只是换了个签出的树：`--ref` 之后 `main` 与 `origin/main`
  // 照旧指向 HEAD，`git show <新提交>:<文件路径>` 一句话就读回来了。
  // 换句话说：**把文件从工作树里拿走，不等于把它从仓库里拿走。**
  //
  // 所以给了 ref 就把未来真的切掉：摘远端、删掉别的分支、过期 reflog、gc。
  // 之后比 ref 新的对象全部不可达并被物理清除；ref 的**祖先**保留 ——
  // 那正是"一个停在基线上的正常仓库"该有的样子，agent 仍然能 git log / blame。
  if (ref) {
    git(ws, 'checkout', '-q', '--detach', ref);
    git(ws, 'checkout', '-q', '-b', branch);
    git(ws, 'remote', 'remove', 'origin');
    for (const b of git(ws, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n')) {
      if (b && b !== branch) git(ws, 'branch', '-q', '-D', b);
    }
    // ⚠️ **tag 也是 ref。** 第一版只删分支和远端，在我们自己的仓库上断言通过了 ——
    // 因为它没有 tag。换到第三方仓库（commit-and-tag-version，73 个 tag）当场漏：
    // `v13.1.0` 这个 tag 把"未来"整条留住了，而"源 HEAD 不可达"的断言照样通过
    // （源 HEAD 是 master，没有 tag 指着它）。断言量的不是隔离本身，只是它的一个代理。
    // 所以：不是 HEAD 祖先的 tag 全删；断言改成**剩下的每个 ref 都是 HEAD 的祖先**。
    const isAncestor = (sha) => {
      try { gitRaw(ws, 'merge-base', '--is-ancestor', sha, 'HEAD'); return true; } catch { return false; }
    };
    for (const t of git(ws, 'tag', '--list').split('\n').filter(Boolean)) {
      if (!isAncestor(`${t}^{commit}`)) git(ws, 'tag', '-d', t);
    }
    git(ws, 'reflog', 'expire', '--expire=now', '--all');
    git(ws, 'gc', '--prune=now', '--quiet');
    // 断言，不是祈祷：隔离做没做成是个**可判定的事实**，不该靠读代码相信。
    // 库里所有 ref 都必须是 HEAD 的祖先（含 HEAD 自己）—— 否则就有一条通往未来的路。
    const stray = git(ws, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter(Boolean)
      .filter((l) => !isAncestor(`${l.split(' ')[1]}^{commit}`));
    if (stray.length) {
      throw new Error(`污染隔离失败：工作区里还有指向基线之后的 ref：${stray.map((l) => l.split(' ')[0]).join(' ')}。`
        + `\n\`--ref\` 的意思是"agent 看不到基线之后的东西"，而它现在看得到 ——`
        + `\n宁可开不出工作区，也不要开出一个自称隔离、实际没隔离的工作区。`);
    }
    // 第二道：源仓库 HEAD 若本身在基线之后，它必须已经取不到（gc 真的清了对象，不只是删了 ref）。
    const srcHead = git(src, 'rev-parse', 'HEAD');
    let reachable = true;
    try { gitRaw(ws, 'cat-file', '-e', `${srcHead}^{commit}`); } catch { reachable = false; }
    if (reachable && !isAncestor(srcHead)) {
      throw new Error(`污染隔离失败：ref 都清了，源仓库 HEAD ${srcHead.slice(0, 8)} 的对象却还在 —— gc 没清干净。`);
    }
  } else {
    git(ws, 'checkout', '-q', '-b', branch);
  }
  const head = git(ws, 'rev-parse', 'HEAD');
  writeDepExcludes(ws);

  audit(db, {
    actorKind: 'system', action: 'workspace_created', targetType: 'task', targetId: taskId,
    payload: { dir: ws, branch, source: src, ref, head },
  });
  return { dir: ws, branch, head, ref, created: true };
}

/**
 * 工作区当前状态。机械判据的取数口：改了哪些文件、有没有提交。
 *
 * ⚠️ 这里**不能**用 trim 过的输出。porcelain 每行是 `XY <path>`，X 是暂存区状态、
 * Y 是工作区状态；未暂存的修改 X 是**空格**（` M path`）。整体 trim 会把第一行
 * 那个空格吃掉，于是 slice(3) 多切一个字符——`src/llm/providers.mjs` 就印成了
 * `rc/llm/providers.mjs`。只有第一行会错，所以看起来像随机的偶发错字。
 */
export function workspaceStatus(dir) {
  const porcelain = gitRaw(dir, 'status', '--porcelain').replace(/\n$/, '');
  return {
    branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    head: git(dir, 'rev-parse', 'HEAD'),
    dirty: porcelain.length > 0,
    changed: porcelain.split('\n').filter(Boolean).map((l) => l.slice(3)),
  };
}

/** 没提交的改动各是什么样子（给人看的一行字）：新文件 / 改过 / 删了。 */
export function describeChanges(dir, lang = 'zh') {
  const porcelain = gitRaw(dir, 'status', '--porcelain').replace(/\n$/, '');
  return porcelain.split('\n').filter(Boolean).map((l) => {
    const xy = l.slice(0, 2), path = l.slice(3);
    const how = xy === '??' ? (path.endsWith('/') ? tl(lang, '新目录，从没提交过') : tl(lang, '新文件，从没提交过'))
      : xy.includes('D') ? tl(lang, '删了（仓库里有）') : tl(lang, '改过（仓库里有旧版）');
    return { path, how };
  });
}

/** 提交工作区当前改动。作者署名 agent —— 谁改的必须在 git 历史里可见。 */
export function commitWorkspace(dir, message) {
  git(dir, 'add', '-A');
  if (!git(dir, 'status', '--porcelain')) return null;
  git(dir, '-c', 'user.name=SuperIntern', '-c', 'user.email=agent@superintern.local',
    'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
