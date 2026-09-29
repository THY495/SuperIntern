// Executor 接口 + 本地实现。容器实现在 `container.mjs`。
//
// ⚠️⚠️ 本文件里**没有沙箱**。`LocalExecutor` 直接在宿主机上跑命令，它的存在
// 只为两件事：离线测试，以及在没有容器运行时的机器上把话说清楚地拒绝。
// "未落地容器之前不得对任何真实用户任务运行"这条规矩仍然对 LocalExecutor 有效 ——
// 落地的是 `ContainerExecutor`，不是这个类。
//
// 接口在还没有容器时就定死，是因为 `limits` 里的写边界（只读免批 / 写命令过闸）
// 事后加会动到所有调用点。后来证明了这个判断：换成容器时接口一个字没动，
// 动的全是实现 —— 唯一的例外是 `mode` 从"收下就扔"变成了真的挂载视图。

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';

export const DEFAULT_LIMITS = {
  timeoutMs: 120_000,
  maxOutputBytes: 64 * 1024,
  // 命令分类。'read-only' 免批，'write' 过闸。
  // LocalExecutor 里它什么也不做（收下就扔）；容器实现里它是**挂载视图**：
  // read-only 的命令在 /workspace-ro 上跑，写进去由内核拒。见 container.mjs。
  mode: 'read-only',
};

/**
 * 真正只读的可执行文件。**这份名单短得刺眼，那是对的。**
 *
 * ⚠️ 原名单是 `/^(node|git|ls|cat|type)$/` —— 它把 `node` 和 `git` 判成只读，
 * 而这两个都是通用的：`node -e "fs.writeFileSync(...)"` 能写任何文件，
 * `git checkout` 能把工作区整个覆盖掉。没有容器时这条分类不接任何东西，所以错了也没人疼；
 * 一旦让它决定挂载视图，"给通用解释器发免批通行证"就成了一个真的洞。
 *
 * 按可执行文件名判定只读，只在这个文件**本身就干不了写**时才成立。
 * 通用解释器（node/python/sh）、通用版本控制（git）、包管理器（npm/pip）一律不在内 ——
 * 代价是 `git diff` 这类也走写视图，那是诚实的代价，不是缺陷。
 */
export const READ_ONLY_FILES = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'find',
  'file', 'stat', 'du', 'df', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp',
  'basename', 'dirname', 'realpath', 'pwd', 'echo', 'true', 'false', 'env',
]);

/** 一条命令该按哪种模式跑。默认 write —— 判不出来就当它会写。 */
export const classifyCommand = (file) =>
  (READ_ONLY_FILES.has(String(file).split(/[/\\]/).pop()) ? 'read-only' : 'write');

/**
 * 把相对路径解析到 workspace 内，并**拒绝逃出去**。
 *
 * ⚠️ 本函数原来的注释写着"`..`、绝对路径、符号链接指向外部——三种都拦"，
 * **第三种是假的**，实测：在工作区里建一个 junction
 * `escape -> ../outside`，`readFile('escape/secret.txt')` 直接读出了工作区外的内容。
 * 原因是 `resolve`/`relative` 是**纯词法**运算，不碰文件系统，符号链接对它不可见。
 * 三种里拦住了两种，注释却宣称三种 —— 而这是没有容器时唯一一道真实边界，
 * 一道被高估的边界比没有边界更危险。
 *
 * 所以现在查两遍：词法一遍（挡 `..`/绝对路径，且对不存在的路径也有效），
 * 真实路径一遍（挡符号链接/junction）。真实路径要从**最近的存在的祖先**开始查 ——
 * 写新文件时目标本身还不存在，直接 realpath 会抛 ENOENT。
 *
 * 换成容器之后这层仍然保留：容器管的是**执行的代码**，而 read_file/write_file
 * 是宿主侧的结构化调用（见 container.mjs 里的取舍记录），它们的边界就是这里。
 */
export function containedPath(workspace, p) {
  const root = realpathSync(resolve(workspace));
  const abs = resolve(root, p);
  const escapes = (target, allowRoot) => {
    const rel = relative(root, target);
    return (rel === '' && !allowRoot) || rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(rel) === rel;
  };
  if (escapes(abs, false)) throw new Error(`路径越界，workspace 之外不可访问：${p}`);
  // 词法上在里面 ≠ 落地也在里面。allowRoot=true：软链的真实目标解析到工作区根本身是合法的
  // （例如 `a/..` 这类），越界与否只看它有没有跑到根外面去。
  if (escapes(realOfNearestExisting(abs), true)) {
    throw new Error(`路径越界（符号链接指向 workspace 之外）：${p}`);
  }
  return abs;
}

/** 逐级向上找到第一个真实存在的祖先并解析它。全不存在时原样返回。 */
function realOfNearestExisting(abs) {
  for (let cur = abs; ;) {
    try { return realpathSync(cur); } catch { /* 不存在，继续往上 */ }
    const up = dirname(cur);
    if (up === cur) return abs;
    cur = up;
  }
}

/**
 * 起一个子进程并按上限收集输出。`LocalExecutor` 与 `ContainerExecutor` 共用 ——
 * 后者跑的是 `docker exec`，但"截断怎么判、超时怎么收口、spawn 失败怎么办"
 * 三件事一模一样，抄一遍就等于埋两份会分叉的边界逻辑。
 *
 * @returns {Promise<{code, stdout, stderr, truncated, timedOut, durationMs}>}
 */
export function spawnCapped(file, args, { cwd, env, timeoutMs, maxOutputBytes, killAfterMs = null }) {
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, env, shell: false });

    let out = '', err = '', truncated = false, timedOut = false;
    // ⚠️ 截断标记要看**这一块有没有被切**，不能只看"已经满了没有"：
    // 一次 50 KB 的 chunk 打进 1 KB 的上限，第一次调用时 s 还是空的，
    // 按"满了没有"判会得出未截断——输出被砍掉 98% 却报告一切正常。
    const cap = (s, chunk) => {
      const room = maxOutputBytes - s.length;
      if (chunk.length > room) truncated = true;
      return room <= 0 ? s : s + chunk.slice(0, room);
    };
    child.stdout.on('data', (d) => { out = cap(out, String(d)); });
    child.stderr.on('data', (d) => { err = cap(err, String(d)); });

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); },
      killAfterMs ?? timeoutMs);
    const finish = (code) => {
      clearTimeout(timer);
      done({ code, stdout: out, stderr: err, truncated, timedOut, durationMs: Date.now() - started });
    };
    // spawn 失败（命令不存在等）走 'error' 而非 'close'，两条路都要收口，
    // 否则 Promise 永不 settle，整个执行 loop 静默挂死
    child.on('error', (e) => { err += `\nspawn failed: ${e.message}`; finish(-1); });
    child.on('close', finish);
  });
}

/**
 * 文件操作：**两种执行器都走宿主侧**，边界是 `containedPath`。
 *
 * 这是一处有意取舍，理由是实测出来的：Windows/WSL2 上一次
 * `docker exec` 往返**中位 226 ms**（n=12，最小 213、最大 237），而宿主
 * `readFileSync` 是 0 ms。`grep` 工具是逐文件读的，一个 200 文件的工作区
 * 走容器就是 45 秒一次 grep —— 那不是变慢，那是这个工具不能用了。
 *
 * 为什么这样仍然站得住：沙箱要关的是**被执行的代码**（`run_command`），
 * 而 read_file / write_file 是 harness 自己发起的结构化调用，路径由 harness 检查，
 * 内容不经过任何解释器。**前提是那道检查是真的** —— 而它在今天之前不是
 * （符号链接盲区，见 `containedPath` 的注释）。先补洞，再谈这个取舍成不成立。
 *
 * 已知的分叉风险：工作区内的符号链接在宿主与容器里解析结果不同（`/etc` 在
 * 容器里存在、在宿主上不存在）。宿主侧现在会拒掉逃逸，容器侧由容器本身兜底，
 * 两边都不放行；但"同一个路径两边看到不同东西"这件事本身仍是真的，记在这里。
 */
export class HostFileOps {
  readFile(workspace, p) { return readFileSync(containedPath(workspace, p), 'utf8'); }

  writeFile(workspace, p, content) {
    const abs = containedPath(workspace, p);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }

  exists(workspace, p) { try { return existsSync(containedPath(workspace, p)); } catch { return false; } }

  isDir(workspace, p) { try { return statSync(containedPath(workspace, p)).isDirectory(); } catch { return false; } }

  listDir(workspace, p = '.') {
    const abs = p === '.' ? realpathSync(resolve(workspace)) : containedPath(workspace, p);
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
      .map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name}  ${statSync(resolve(abs, e.name)).size}B`));
  }
}

/**
 * 命令执行。
 *
 * ⚠️ `cmd` 是 `{file, args}` 而**不是 shell 字符串**，这是对
 * `execute(cmd, workspace, limits)` 签名的一处有意收窄：shell 字符串意味着
 * 引号转义地狱 + 注入面 + 跨平台不一致（win32 上根本没有可依赖的 sh），
 * 而容器实现最终也是 exec argv。现在就按 argv 走，换实现时零改动。
 */
export class LocalExecutor extends HostFileOps {
  constructor(opts = {}) { super(); this.defaults = { ...DEFAULT_LIMITS, ...opts }; }

  /** @returns {Promise<{code, stdout, stderr, truncated, timedOut, durationMs}>} */
  execute(cmd, workspace, limits = {}) {
    const lim = { ...this.defaults, ...limits };
    const { file, args = [] } = cmd;
    if (!file) throw new Error('execute: cmd.file 必填');
    return spawnCapped(file, args, {
      cwd: resolve(workspace),
      // ⚠️ 环境变量白名单：agent 不该看见宿主机的凭证。凭证隔离（窄凭证代理）
      // 不在本地执行器里；
      // 这里做的是"至少别主动递给它"，不等于隔离。
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP },
      timeoutMs: lim.timeoutMs, maxOutputBytes: lim.maxOutputBytes,
    });
  }
}
