// ContainerExecutor —— 把 agent 的"手"关进容器。
//
// 不走容器时 agent 的"手"直接落在宿主机上：`run_command` 起的是宿主进程，argv 不受
// 任何路径约束（`containedPath` 只管 read/write 那几个工具，管不到命令行）。
// 沙箱是底线而非选项：**没有容器就不得对真实用户任务运行**。
//
// ── 实现取向 ────────────────────────────────────────────────────────────
// 这里要的是**编排器能按任务生命周期驱动的一个类**，所以不用 docker-compose，
// 只沿用三条实现规范（工具链构建期烘焙、CA 装系统信任库、白名单按生态成组）。
//
// ── 做到哪、没做哪（不含糊其辞）──────────────────────────────────────────
//   ✅ 隔离     每任务独立容器 + 独立 workspace，任务间零共享
//   ✅ 资源限额 内存 / PID / CPU + cap_drop ALL + 只读 rootfs
//   ✅ 写边界   只有 /workspace 与 /tmp 可写，越界写由**内核**拒，不靠提示词
//   ✅ 凭证隔离 `docker exec` 不继承宿主环境，宿主的 key 结构上进不去
//   ✅ 出口     默认断网（`--network none`）+ 白名单出口代理（见 egress.mjs）。
//               ⚠️ 出网是**按任务显式开的**：没配 `egress.groups` 的任务连代理容器
//               都不起，仍然是彻底的 `--network none`。默认方向指向安全的一侧。
//
// ── 运行时不绑单一厂商 ──────────────────────────────────────────────────
// `docker` 与 `podman` 在 run/exec/inspect/rm 这几条上 CLI 兼容，所以走 CLI 而不是
// Docker 的 HTTP API / dockerode —— 后者会把实现钉死在一家。未来换微 VM
// （Firecracker/gVisor）或托管沙箱（E2B）时换的也应该只是这个类。

import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostFileOps, spawnCapped, DEFAULT_LIMITS, classifyCommand } from './executor.mjs';
import { ingestEgressAudit, egressGroupsOf, ensureCa, ensureCaImage, EgressProxy, allowlistOf, toolEnvOf } from './egress.mjs';
import { LIMITS, limitOf } from './limits.mjs';
import { audit } from '../db/db.mjs';
import { HardLimitError } from './errors.mjs';
import { sandboxFlavorOf } from './project-settings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SANDBOX_IMAGE = 'superintern/sandbox:v0.1';

/** 容器里工作区的两个视图。read-only 模式的命令跑在 ro 那个上，写进去由内核拒。 */
const MOUNT_RW = '/workspace';
const MOUNT_RO = '/workspace-ro';

// 内存 / PID 上限不再写死在这里：从宪法层 params（limits 解析后的有效上限）取值。
// 只有 CPU 这一维不在 LIMITS 表里，仍留一个常量。
const CPU_LIMIT = '2.0';

/**
 * 容器进程以宿主当前用户的 uid:gid 跑（见 #runArgs 里的注释）。
 * Windows 没有 getuid，Docker Desktop 也不需要 —— 返回空。可注入以便测试。
 */
export function hostUserArgs(proc = process) {
  if (typeof proc.getuid !== 'function' || typeof proc.getgid !== 'function') return [];
  return ['--user', `${proc.getuid()}:${proc.getgid()}`];
}

/**
 * 找一个可用的容器运行时。**找不到就抛**，不静默退回 LocalExecutor ——
 * "沙箱起不来于是在宿主上裸跑"是这类系统里最坏的失败模式：它把一次明确的
 * 环境缺失，变成了一次静悄悄的安全降级。
 */
export function detectRuntime(candidates = ['docker', 'podman']) {
  const tried = [];
  for (const cli of candidates) {
    try {
      const v = execFileSync(cli, ['version', '--format', '{{.Server.Version}}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (v) return { cli, version: v };
      tried.push(`${cli}: 装了但 daemon 没应答`);
    } catch (e) {
      tried.push(`${cli}: ${String(e.stderr || e.message).trim().split('\n')[0].slice(0, 160)}`);
    }
  }
  throw new Error(`没有可用的容器运行时，沙箱起不来：\n  ${tried.join('\n  ')}\n`
    + `装上 Docker Desktop 或 Podman 并确认 daemon 在跑。**不要**改用 LocalExecutor 绕过 ——`
    + `那是在宿主机上裸跑 agent 生成的代码。`);
}

export class ContainerExecutor extends HostFileOps {
  /**
   * 编排器凭这个字段判断"这次算不算隔离"，不认 `instanceof` —— 将来换微 VM 或
   * 托管沙箱时，那些实现也应该只声明这一个字段就能被认。声明得起就要担得住：
   * 谁把它设成 true，谁就得保证命令真的不落在宿主机上。
   */
  isolated = true;

  /**
   * @param {object} o
   * @param {string} o.taskId       容器按任务命名，"每任务一个容器"的落点
   * @param {object} [o.db]         传了就把容器生命周期写进审计轨
   * @param {string} [o.image]
   * @param {string} [o.cli]        不传就自动探测
   */
  constructor({ taskId, db = null, image = SANDBOX_IMAGE, cli = null, limits = {}, containerLimits = {},
    egress = null } = {}) {
    super();
    if (!taskId) throw new Error('ContainerExecutor 需要 taskId —— 容器是按任务隔离的');
    this.taskId = taskId;
    this.db = db;
    this.image = image;
    this.cli = cli;
    this.name = `superintern-${taskId}`;
    this.defaults = { ...DEFAULT_LIMITS, ...limits };
    // 内存 / PID 从宪法层 params 读有效上限；没有 db（纯测试装配）时退回 LIMITS 内置
    // 天花板，绝不退化成"无上限"。容器参数是给 docker 的字符串/数字，不在这里写死数值。
    this.cLimits = {
      memory: String(db ? limitOf(db, taskId, 'limit.memory_bytes')
        : containerLimits.memory ?? LIMITS['limit.memory_bytes'].def),
      pids: Number(db ? limitOf(db, taskId, 'limit.pids')
        : containerLimits.pids ?? LIMITS['limit.pids'].def),
      cpus: containerLimits.cpus ?? CPU_LIMIT,
    };
    // 出口代理侧车。null = 彻底断网，这也是默认。
    this.egress = egress;
    this.started = null;
  }

  /** 同步跑一条运行时管理命令（inspect/run/rm 这类，都是毫秒级且必须有序）。 */
  #cli(args, { allowFail = false } = {}) {
    try {
      return execFileSync(this.cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      if (allowFail) return null;
      throw new Error(`${this.cli} ${args.slice(0, 2).join(' ')} 失败：`
        + String(e.stderr || e.message).trim().split('\n').slice(0, 3).join(' / '));
    }
  }

  /**
   * 读容器当前是否撞上内存/pids 硬边界。撞上返回 breach（含维度名、上限值、实测值），
   * 否则返回 null。这里只做**检测**，不写审计也不抛 —— 硬边界类撞顶 = 记审计 + 硬失败，
   * 由 #hardFailIfBreached 统一执行。
   */
  #hardFailureState() {
    if (!this.cli) return null;
    const oom = this.#cli(['inspect', '-f', '{{.State.OOMKilled}}', this.name], { allowFail: true });
    if (oom === 'true') {
      return { key: 'limit.memory_bytes', label: '容器内存上限',
        limit: this.cLimits.memory, actual: this.cLimits.memory,
        human: `容器内存上限触顶：容器已被 OOM kill（上限 ${this.cLimits.memory}）` };
    }
    const pidsRaw = this.#cli(['inspect', '-f', '{{.State.Pids}}', this.name], { allowFail: true });
    const pids = Number(pidsRaw);
    const pidsLimit = Number(this.cLimits.pids);
    if (Number.isFinite(pids) && pidsLimit > 0 && pids >= pidsLimit) {
      return { key: 'limit.pids', label: '容器进程数上限',
        limit: pidsLimit, actual: pids,
        human: `容器进程数上限触顶：当前 ${pids} 个进程，已达上限 ${pidsLimit}` };
    }
    return null;
  }

  /**
   * 硬边界类撞顶的统一收口：先落一条与预算/时长同形的审计事件，随后硬失败向上抛。
   * **不调用 advice 生成加额建议、不进入提问/降级分支** —— OOM / pids 撞顶是任务
   * 自身失控或泄漏，加额只会放大宿主上的爆炸半径。
   */
  #hardFailIfBreached() {
    const b = this.#hardFailureState();
    if (!b) return;
    // ⚠️ 这里**只抛，不记审计**。原来这里写了一条 limit_breached，然后抛一个普通
    // Error —— 而 runToolLoop 把普通 Error 吞成工具报错回给模型，模型接着跑，
    // "硬失败"成了一句话。现在抛 HardLimitError（infra 标记）：穿过工具循环，
    // 编排器接住后走 breachOut 的 hard_fail 分支 —— 审计在那里记，一处记一次。
    throw new HardLimitError(`容器 ${this.name} 撞上硬边界 ${b.label}：${b.human}。`
      + `这是任务自身失控或泄漏（OOM / 进程数达上限），提高上限不是解法。`, { breach: b });
  }

  /**
   * 保证容器在跑。幂等，可以被重生的编排器重复调用。
   *
   * ⚠️ **容器活得比进程长**，这是编排器崩溃重生时的一种形态：
   * 进程崩了，容器还在，里面可能还留着上一轮装的依赖、跑了一半的进程。
   * 三种情况分别处理并各自入审计 —— 复盘时"这一步是在哪个容器里跑的、
   * 那个容器是新建的还是捡来的"必须答得出来。
   */
  async start(workspace) {
    if (!this.cli) {
      const rt = detectRuntime();
      this.cli = rt.cli;
      this.runtimeVersion = rt.version;
    }
    const ws = resolve(workspace);

    // 代理先起，沙箱后起：沙箱要挂到代理所在的那张 cage 网上，网还不存在就起不来。
    // 而且要**等它真的在监听** —— mitmdump 有几百毫秒的启动窗口，
    // 那段时间里沙箱发的请求会得到 connection refused，长得和"被白名单拒了"很像，
    // 但两种失败的处置完全不同。
    let egressInfo = null;
    if (this.egress) {
      egressInfo = this.egress.start();
      await this.egress.waitReady();
    }

    const state = this.#cli(['inspect', '-f', '{{.State.Status}}', this.name], { allowFail: true });

    let how;
    if (state === 'running') {
      how = 'reused';
    } else if (state) {
      // 存在但停了：起回来。**不重建** —— 重建会悄悄丢掉上一轮在容器内的改动，
      // 而那些改动可能正是崩溃现场。
      this.#cli(['start', this.name]);
      how = 'restarted';
    } else {
      this.#cli(this.#runArgs(ws));
      this.#hardFailIfBreached();   // 启动即撞顶（如 OOM 立刻 kill）按硬边界处理
      how = 'created';
    }

    this.started = { how, workspace: ws };
    const digest = this.#cli(['image', 'inspect', '-f', '{{.Id}}', this.image], { allowFail: true });
    const info = { name: this.name, how, cli: this.cli, runtimeVersion: this.runtimeVersion ?? null,
      image: this.image, imageId: digest, workspace: ws,
      network: egressInfo ? egressInfo.network : 'none',
      // 放行了什么必须进审计载荷。复盘时"这次能连哪里"要答得出来 ——
      // 那是数据外传这件事的**事前**边界，被拒记录是事后证据，两个都要有。
      egress: egressInfo ? { proxy: egressInfo.name, groups: this.egress.groups,
        hosts: egressInfo.hosts.map((h) => h.host) } : null,
      ...this.cLimits };
    if (this.db) {
      audit(this.db, { actorKind: 'system', action: 'sandbox_started', targetType: 'task',
        targetId: this.taskId, payload: { ...info, pid: process.pid } });
    }
    return info;
  }

  #runArgs(ws) {
    // 断网有两种形态，**不是一种加一个开关**：
    //   无代理 → `--network none`，链路层就没有网络设备，最彻底
    //   有代理 → 挂在 internal 的 cage 网上，**没有网关**，唯一出路是代理
    // 后者仍然出不去：不是靠环境变量里的 HTTP_PROXY 自觉，那只是让工具知道往哪送。
    // 真正拦住它的是那张网没有网关，且外部域名在 cage 里解析不了。
    const net = this.egress
      ? ['--network', this.egress.network,
        ...Object.entries(this.egress.sandboxEnv()).flatMap(([k, v]) => ['-e', `${k}=${v}`])]
      : ['--network', 'none'];
    return [
      'run', '-d', '--name', this.name,
      '--label', 'superintern.task=' + this.taskId,       // 供 `cli sandbox` 清扫遗留容器
      // ⚠️ `--init` 不是可选项。没有它，PID 1 是 `sleep infinity`，而 sleep 从不
      // 调 wait() —— 每一条被超时杀掉的命令都会在容器里留下一个**永久僵尸**
      // （实测：4 次超时 = 4 个 Z 状态进程，只增不减）。
      // 更坏的是它与下面的 `--pids-limit` 相互作用：僵尸占着 PID 槽位，
      // 攒够 512 个之后容器里**什么都跑不起来**，而报错会是 fork 失败，
      // 指不到"超时太多次"这个真实原因。一道资源护栏把一个慢泄漏变成了一次总停摆。
      '--init',
      // ── 网络 ──────────────────────────────────────────────────────────────
      ...net,
      // ── 写边界：rootfs 只读，只有下面两处可写 ────────────────────────────
      '--read-only',
      '--tmpfs', '/tmp:size=512m,exec',   // 编译/测试要落临时文件；exec 是给 node 的 v8 缓存留的
      // ⚠️ rootfs 只读意味着 `$HOME` 也只读。在沙箱里 `npm ci` 时
      // npm 建不出 /root/.npm，先是几十条 "tarball seems to be corrupted"（缓存写不进去
      // 被当成校验失败），最后 ENOENT mkdir /root/.npm 退出 —— 报错离成因隔了两层。
      // 工具的缓存 / 配置全部指到 /tmp 下。
      '-e', 'HOME=/tmp/home',
      '-e', 'npm_config_cache=/tmp/home/.npm',
      // npm 装包时顺手 POST 一份安全审计、查一下自己有没有新版。
      // 沙箱里这些都没用，只会在出网记录里留一串拒绝 —— 关掉，装包本身不受影响。
      '-e', 'npm_config_audit=false', '-e', 'npm_config_fund=false', '-e', 'npm_config_update_notifier=false',
      '-e', 'XDG_CACHE_HOME=/tmp/home/.cache',   // corepack / pnpm / yarn
      '-e', 'COREPACK_HOME=/tmp/home/.corepack',
      // 工作区的依赖环境**自动激活**：验收命令是规划器写的裸 `pytest` /
      // `python -m pytest`，agent 装进 .venv 的包对裸命令不可见 —— 它曾因此花掉整整一个窗口（20 轮）
      // 去改造系统 Python（ensurepip --user、往 /tmp 写 pip 配置 break-system-packages），
      // 验收照样 127。人手工做是先 activate；这里把 .venv/bin 与 node_modules/.bin 放到 PATH 最前，
      // 目录还不存在时多一项无害，建好之后裸 python / pip / pytest / 本地 CLI 就是工作区里那一份。
      '-e', `PATH=${MOUNT_RW}/.venv/bin:${MOUNT_RW}/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      // git 身份。容器里没有 gitconfig，`git commit` 直接 "Author identity unknown" 退出 ——
      // 不少仓库的集成测试都在临时 repo 里 commit，
      // 于是任务级验收全挂在 "ambiguous argument 'HEAD'" 上，离成因隔了一层。
      '-e', 'GIT_AUTHOR_NAME=superintern-sandbox', '-e', 'GIT_AUTHOR_EMAIL=sandbox@superintern.local',
      '-e', 'GIT_COMMITTER_NAME=superintern-sandbox', '-e', 'GIT_COMMITTER_EMAIL=sandbox@superintern.local',
      '-v', `${ws}:${MOUNT_RW}`,
      // 同一份工作区的只读视图。声明为 read-only 的命令跑在这上面，
      // **misclassify 会当场 EROFS 报错，而不是安静地写下去**。
      '-v', `${ws}:${MOUNT_RO}:ro`,
      // ── 资源限额 ──────────────────────────────────────────────────────────
      '--memory', this.cLimits.memory,
      '--pids-limit', String(this.cLimits.pids),
      '--cpus', this.cLimits.cpus,
      // ── Linux 宿主：容器里的 uid 要等于宿主上跑守护进程的 uid ─────────────
      // 没有 --user 时容器以 root 跑，bind mount 的工作区里它写下的每个文件在宿主上都是
      // root:root —— 守护进程（普通用户）之后 git add / 删分支 / 清工作区全部 EACCES。
      // Docker Desktop（Windows / macOS）的 bind mount 经文件共享层做了所有权伪装，
      // 所以这个问题在那两个平台上不会露面。rootfs 只读 + $HOME 指到 /tmp（上面），
      // 所以非 root 也不需要镜像里有对应的 passwd 行；git 身份走环境变量。
      ...hostUserArgs(),
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '-w', MOUNT_RW,
      this.image,
      'sleep', 'infinity',
    ];
  }

  /**
   * 在沙箱里跑一条命令。签名与 `LocalExecutor.execute` 完全一致 ——
   * `execute(cmd, workspace, limits)` 定死在接口层，两种执行器可以互换。
   *
   * `workspace` 参数在这里**只用于校验**：容器的挂载在 start 时就定了，
   * 换一个工作区意味着换一个容器。传错了要吵，不能默默在旧挂载上跑。
   */
  async execute(cmd, workspace, limits = {}) {
    const lim = { ...this.defaults, ...limits };
    const { file, args = [] } = cmd;
    if (!file) throw new Error('execute: cmd.file 必填');
    if (!this.started) await this.start(workspace);
    if (resolve(workspace) !== this.started.workspace) {
      throw new Error(`沙箱 ${this.name} 挂的是 ${this.started.workspace}，`
        + `却被要求在 ${resolve(workspace)} 上执行 —— 每任务一个容器一个工作区`);
    }

    // 调用方没显式给 mode 就按可执行文件名判，判不出来当写（见 classifyCommand）。
    const mode = limits.mode ?? classifyCommand(file);
    const cwd = mode === 'read-only' ? MOUNT_RO : MOUNT_RW;

    // ⚠️ 超时用**容器内的** `timeout` 执行，不靠杀宿主侧的 `docker exec` 客户端：
    // 杀客户端只断了 I/O 管道，容器里那个进程照跑不误，还会带着 CPU 和内存
    // 一路影响后面每一条命令。把上限放进笼子里才是真的上限。
    const secs = Math.max(1, Math.ceil(lim.timeoutMs / 1000));
    const argv = ['exec', '-w', cwd, this.name,
      'timeout', '--signal=KILL', String(secs), file, ...args];

    const r = await spawnCapped(this.cli, argv, {
      cwd: undefined,
      // 宿主环境**不透传**。凭证隔离在这里是结构性的：容器里根本没有
      // ANTHROPIC_API_KEY 这类变量可读，不需要靠白名单一个个挡。
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
      timeoutMs: lim.timeoutMs, maxOutputBytes: lim.maxOutputBytes,
      // 宿主侧只做兜底：容器内的 timeout 该在 secs 秒后动手，多给 15 秒是留给
      // docker 客户端自己卡住的情况。两层都有，因为它们失效的原因不一样。
      killAfterMs: lim.timeoutMs + 15_000,
    });

    // 命令非零退出时，先确认是不是撞上了 OOM / pids 硬边界；是就记审计 + 硬失败。
    // 超时（137/124）不会误报：它既不置 OOMKilled，也不把进程数顶到上限。
    if (r.code !== 0) this.#hardFailIfBreached();

    // `timeout --signal=KILL` 杀掉子进程后自己返回 137（128+9）。
    // 宿主兜底计时器触发时 spawnCapped 已经把 timedOut 置上了，两条路合并。
    const timedOut = r.timedOut || r.code === 137 || r.code === 124;
    return { ...r, timedOut, mode, cwd };
  }

  /** 停并删。任务收尾时调；不调也不会泄漏太久 —— `cli sandbox --reap` 按 label 清。 */
  async stop({ remove = true } = {}) {
    if (!this.cli) return null;
    const existed = this.#cli(['inspect', '-f', '{{.State.Status}}', this.name], { allowFail: true });
    // 沙箱和代理都已经不在 = 之前停过了。**必须早退**，否则重复 stop 会再搬一次
    // 出网审计（重复计数），而且在库已经关掉的收尾路径上会直接抛。
    // 幂等不是锦上添花：stop 天然会被 finally、进程退出钩子、显式调用各来一次。
    const proxyLeft = this.egress
      && this.#cli(['inspect', '-f', '{{.State.Status}}', this.egress.name], { allowFail: true });
    if (!existed && !proxyLeft) {
      // 容器都不在了，网络可能还在（旧版本删序反了留下的，或进程死在两步之间）—— 顺手补删，否则永远没人删。
      if (this.egress && remove) this.#cli(['network', 'rm', this.egress.network], { allowFail: true });
      return null;
    }

    // ⚠️ 出网审计要在**删代理之前**搬进 audit_log。删了容器 JSONL 还在（挂的是宿主目录），
    // 但顺序反了就多一次"如果这中间崩了就丢"的窗口，而丢掉的恰恰是数据外传的证据。
    let egressStats = null;
    if (this.egress && this.db) {
      egressStats = ingestEgressAudit(this.db, { taskId: this.taskId, auditFile: this.egress.auditFile });
    }
    // ⚠️ 先删沙箱、再停代理（代理那边会删 cage 网络）。顺序反了的话沙箱还挂在网上，`network rm` 报
    // "has active endpoints"，allowFail 把它吞了 —— 每跑一次漏一张网。漏上几十张，
    // Docker 的默认地址池随之用尽（"all predefined address pools have been fully subnetted"），
    // 之后**任何**联网任务都起不来沙箱，报错离成因隔了几十次运行。
    if (existed) this.#cli([remove ? 'rm' : 'stop', ...(remove ? ['-f'] : []), this.name], { allowFail: true });
    if (this.egress) this.egress.stop({ remove });
    this.started = null;
    if (this.db) {
      audit(this.db, { actorKind: 'system', action: 'sandbox_stopped', targetType: 'task',
        targetId: this.taskId, payload: { name: this.name, removed: remove, pid: process.pid, egress: egressStats } });
    }
    return { name: this.name, removed: remove, egress: egressStats };
  }
}

/**
 * 从库里的状态装配出一个执行器。**这是 CLI 唯一该调的入口。**
 *
 * 装配顺序本身带着一条设计判断：`egress.groups` 为空 → 连代理都不起，
 * 沙箱是彻底的 `--network none`。**默认不出网，按生态放行**，而不是
 * "默认能出网、靠白名单收窄" —— 后者一旦配错就是全开，前者配错只是不通。
 * 失败方向要指向安全的那一侧。
 *
 * @param {string} home  `.superintern/` 目录：CA 与出网审计都落在这下面
 */
export async function makeSandbox(db, { taskId, home, cli = null, onNote = () => {} }) {
  const rt = cli ? { cli } : detectRuntime();
  const pid = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;
  const base = ensureFlavorImage(rt.cli, sandboxFlavorOf(db, pid), onNote);
  const groups = egressGroupsOf(db, taskId);
  if (!groups.length) {
    return new ContainerExecutor({ taskId, db, cli: rt.cli, image: base });
  }

  // 出网开着 → CA 必须就位，且必须**烘焙进镜像**。
  // 两步都是幂等的：CA 已有就不重生成，派生镜像按 CA 指纹打 tag，已有就不重构建。
  const caDir = join(home, 'ca');
  const ca = ensureCa(rt.cli, caDir);
  if (ca.created) onNote(`已生成出口代理 CA（指纹 ${ca.fingerprint}）→ ${caDir}`);
  const img = ensureCaImage(rt.cli, { baseImage: base, caDir,
    dockerfile: join(HERE, '..', '..', 'sandbox', 'Dockerfile.ca') });
  if (img.built) onNote(`已构建含 CA 的派生镜像 ${img.tag}`);

  const egress = new EgressProxy({
    taskId, cli: rt.cli, caDir,
    addonPath: join(HERE, '..', '..', 'sandbox', 'proxy', 'guard.py'),
    auditDir: join(home, 'egress', taskId),
    groups,
    allow: allowlistOf(db, groups),        // 联网目录解析出的域名（带只读标记，v20）
    toolEnv: toolEnvOf(db, groups),        // 软件源的工具配置（镜像地址等）注入沙箱
    // 凭证注入规则：机制在 guard.py 里，**默认为空**。
    // 填它意味着往代理容器里塞真令牌，那是一次涉凭证的动作，该由人显式配置，
    // 不该由这个装配函数替人决定。规则里只存环境变量名，值另走 credEnv。
    credRules: [], credEnv: {},
  });
  return new ContainerExecutor({ taskId, db, cli: rt.cli, image: img.tag, egress });
}

/**
 * 项目选的沙箱口味 → 镜像 tag。默认镜像原样返回；python 变体不存在就当场构建（幂等，构建期能联网，
 * 运行期照旧 `--network none`）。构建失败就抛 —— 沙箱起不来宁可报错，也不静默退回没有 python 的镜像。
 */
// v0.2：加了 chromium + 中文字体（截图用）。v0.3：chromium 默认参数 + 策略，谁起的都不走出网代理。换 tag 才会真的用上新 Dockerfile —— 镜像是"没有才建"的
export const SANDBOX_IMAGE_PYTHON = 'superintern/sandbox:v0.3-python';
export function ensureFlavorImage(cli, flavor, onNote = () => {}) {
  if (flavor !== 'python') return SANDBOX_IMAGE;
  try { execFileSync(cli, ['image', 'inspect', '-f', '{{.Id}}', SANDBOX_IMAGE_PYTHON], { stdio: ['ignore', 'pipe', 'pipe'] }); return SANDBOX_IMAGE_PYTHON; }
  catch { /* 没有就建 */ }
  const dir = join(HERE, '..', '..', 'sandbox');
  execFileSync(cli, ['build', '-q', '--build-arg', `BASE=${SANDBOX_IMAGE}`, '-f', join(dir, 'Dockerfile.python'), '-t', SANDBOX_IMAGE_PYTHON, dir],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  onNote(`已构建 Python 沙箱镜像 ${SANDBOX_IMAGE_PYTHON}`);
  return SANDBOX_IMAGE_PYTHON;
}

/** 列出本系统留下的所有沙箱容器。给 `cli sandbox` 用。 */
export function listSandboxes(cli = null) {
  const runtime = cli ?? detectRuntime().cli;
  const out = execFileSync(runtime,
    ['ps', '-a', '--filter', 'label=superintern.task',
      '--format', '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Label "superintern.task"}}'],
    { encoding: 'utf8' }).trim();
  return !out ? [] : out.split('\n').map((l) => {
    const [name, state, status, taskId] = l.split('\t');
    return { name, state, status, taskId };
  });
}
