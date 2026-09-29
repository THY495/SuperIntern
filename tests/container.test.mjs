// 回归：ContainerExecutor —— 容器沙箱的验收
//
// 跑：node tests/container.test.mjs
// 前置：装了 docker 或 podman 且 daemon 在跑；镜像 superintern/sandbox:v0.1 已构建
//       （docker build -t superintern/sandbox:v0.1 sandbox/）
//
// ⚠️ **这个文件不允许"跳过即通过"。** 没有容器运行时的话它以非零退出码失败，
// 而不是打一行 SKIP 然后绿灯 —— 因为它验的正是"沙箱在不在"。一个在没有沙箱的
// 机器上仍然全绿的沙箱测试，是这个项目反复撞到的那类假护栏。
//
// 判据（每条都要**真的发生过一次**，不是"接口存在"）：
//   C1 默认断网      容器内出不去网、DNS 也解析不了
//   C2 写边界        /workspace 可写；/etc、/usr/bin、/ 全部由内核拒
//   C3 路径逃逸      ..、绝对路径、**符号链接**三种都拦（第三种曾经是漏的）
//   C4 任务间零共享  两个任务两个容器，A 写的东西 B 看不见
//   C5 资源限额      内存/PID/能力集实测生效
//   C6 接口可替换    同一段调用代码换掉执行器就跑在沙箱里，签名零改动

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalExecutor, containedPath, classifyCommand, READ_ONLY_FILES } from '../src/core/executor.mjs';
import { ContainerExecutor, detectRuntime, listSandboxes, SANDBOX_IMAGE, hostUserArgs } from '../src/core/container.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const has = (s, sub, m) => (String(s).includes(sub) ? ok(m) : bad(m, `输出里没有 ${JSON.stringify(sub)}：${String(s).slice(0, 300)}`));
const rejects = (fn, m) => {
  try { fn(); bad(m, '期望被拒绝，但成功了'); }
  catch (e) { ok(`${m}\n         └ ${String(e.message).split('\n')[0].slice(0, 110)}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'si-ctr-'));
const mkws = (name) => { const d = join(TMP, name); mkdirSync(d, { recursive: true }); return d; };
const execs = [];
const cleanup = () => {
  for (const e of execs) { try { e.stop(); } catch { /* 尽力 */ } }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ }
};
process.on('exit', cleanup);

// ═══════════════════════════════════════════════════════════════════════════
section('0. 前置：容器运行时 —— 没有就失败，不跳过');
// ═══════════════════════════════════════════════════════════════════════════

let rt;
try {
  rt = detectRuntime();
  ok(`运行时 ${rt.cli} ${rt.version}`);
} catch (e) {
  console.log(`  [FAIL] 没有可用的容器运行时\n         ${e.message}`);
  console.log('\n沙箱测试在没有沙箱的机器上**不能算通过**。装好运行时再跑。');
  process.exit(1);
}
try {
  const id = execFileSync(rt.cli, ['image', 'inspect', '-f', '{{.Id}}', SANDBOX_IMAGE],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  ok(`镜像 ${SANDBOX_IMAGE} 在位（${id.slice(0, 19)}…）`);
} catch {
  console.log(`  [FAIL] 镜像 ${SANDBOX_IMAGE} 不存在。先跑：docker build -t ${SANDBOX_IMAGE} sandbox/`);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. C3 路径逃逸：三种都要拦 —— 第三种曾经是漏的');
// ═══════════════════════════════════════════════════════════════════════════

{
  const ws = mkws('guard-ws');
  const outside = mkws('guard-outside');
  writeFileSync(join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
  writeFileSync(join(ws, 'inside.txt'), 'INSIDE');

  const local = new LocalExecutor();
  eq(local.readFile(ws, 'inside.txt'), 'INSIDE', '工作区内的文件正常读得到');
  rejects(() => containedPath(ws, '../guard-outside/secret.txt'), '① `..` 越界被拦');
  rejects(() => containedPath(ws, resolve(outside, 'secret.txt')), '② 绝对路径越界被拦');

  // ③ 符号链接。**这一条是实测发现**：`resolve`/`relative` 是纯词法运算，
  // 不碰文件系统，所以符号链接对它完全不可见。早先的注释宣称"三种都拦"，
  // 实测只拦住两种 —— 一道被高估的边界比没有边界更危险。
  let linked = false;
  try { symlinkSync(outside, join(ws, 'escape'), 'junction'); linked = true; }
  catch { try { symlinkSync(outside, join(ws, 'escape'), 'dir'); linked = true; } catch { /* 权限不足 */ } }
  if (linked) {
    rejects(() => containedPath(ws, 'escape/secret.txt'), '③ 符号链接指向工作区外被拦');
    rejects(() => containedPath(ws, 'escape/nonexistent-new-file.txt'),
      '③b 经软链写**尚不存在**的新文件也被拦（要从最近的存在祖先解析）');
    assert(local.exists(ws, 'escape/secret.txt') === false,
      'exists() 对越界路径返回 false，不泄漏"外面有没有这个文件"');
  } else {
    bad('③ 符号链接逃逸', '建不出符号链接/junction（权限不足），这条没验到 —— 不当通过');
  }
  // 工作区根本身仍然可列（listDir('.') 走的是另一条路）
  assert(local.listDir(ws, '.').some((e) => e.startsWith('inside.txt')), '工作区根仍可正常列目录');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 命令分类：通用解释器不再拿只读免批通行证');
// ═══════════════════════════════════════════════════════════════════════════

{
  // 早先的名单是 /^(node|git|ls|cat|type)$/ —— node 和 git 什么都能写。
  eq(classifyCommand('node'), 'write', 'node 判为 write（`node -e fs.writeFileSync` 能写任何文件）');
  eq(classifyCommand('git'), 'write', 'git 判为 write（`git checkout` 能覆盖整个工作区）');
  eq(classifyCommand('npm'), 'write', 'npm 判为 write');
  eq(classifyCommand('python3'), 'write', 'python3 判为 write');
  eq(classifyCommand('sh'), 'write', 'sh 判为 write');
  eq(classifyCommand('ls'), 'read-only', 'ls 判为 read-only');
  eq(classifyCommand('grep'), 'read-only', 'grep 判为 read-only');
  eq(classifyCommand('/usr/bin/cat'), 'read-only', '带路径的也认（按 basename 判）');
  eq(classifyCommand('unknown-tool-xyz'), 'write', '不认识的一律判 write —— 判不出来就当它会写');
  assert(!READ_ONLY_FILES.has('node') && !READ_ONLY_FILES.has('git'),
    '只读名单里没有 node / git');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. C6 接口可替换：同一段调用代码，换执行器即入沙箱');
// ═══════════════════════════════════════════════════════════════════════════

const wsA = mkws('task-a');
writeFileSync(join(wsA, 'hello.mjs'), 'console.log("HELLO-FROM-SANDBOX")');
const ctr = new ContainerExecutor({ taskId: 't_ctrtest_a' });
execs.push(ctr);

{
  const info = await ctr.start(wsA);
  eq(info.how, 'created', '容器新建');
  eq(info.network, 'none', '默认断网');
  assert(info.imageId?.startsWith('sha256:'), `镜像摘要入审计载荷（${String(info.imageId).slice(0, 19)}…）`);

  // 与 LocalExecutor 逐字相同的调用形态 —— 这就是"执行器接口可替换"的兑现
  const call = (e) => e.execute({ file: 'node', args: ['hello.mjs'] }, wsA, {});
  const r = await call(ctr);
  eq(r.code, 0, 'node hello.mjs 在沙箱里退出码 0');
  has(r.stdout, 'HELLO-FROM-SANDBOX', '标准输出穿透回来了');
  eq(r.mode, 'write', 'node 走写视图');
  eq(r.cwd, '/workspace', '写视图的 cwd 是 /workspace');

  const rl = await call(new LocalExecutor());
  eq(rl.code, 0, '同一段调用换成 LocalExecutor 也跑得通（签名零改动）');

  const again = await new ContainerExecutor({ taskId: 't_ctrtest_a' }).start(wsA);
  eq(again.how, 'reused', '第二次 start 复用同一个容器（编排器重生时容器还活着）');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. C1 默认断网 —— 出不去，且连域名都解析不了');
// ═══════════════════════════════════════════════════════════════════════════

{
  const dns = await ctr.execute({ file: 'node', args: ['-e',
    'require("node:dns").lookup("registry.npmjs.org",(e)=>{console.log(e?"DNS-FAIL:"+e.code:"DNS-OK");process.exit(e?0:1)})'] },
  wsA, { timeoutMs: 20_000 });
  has(dns.stdout, 'DNS-FAIL', 'DNS 解析不了外部域名（纵深：DNS 隧道外传这条路也堵死）');

  const net = await ctr.execute({ file: 'node', args: ['-e',
    'require("node:http").get("http://1.1.1.1",()=>{console.log("NET-OK");process.exit(1)})'
    + '.on("error",(e)=>{console.log("NET-FAIL:"+e.code);process.exit(0)})'] },
  wsA, { timeoutMs: 20_000 });
  has(net.stdout, 'NET-FAIL', '绕过 DNS 直连 IP 也出不去');

  // 反面对照：宿主上同一段代码是通的。不做这个对照的话，上面两条也可能是
  // "这台机器本来就没网" —— 那测的就不是沙箱了。
  const hostNet = await new LocalExecutor().execute({ file: 'node', args: ['-e',
    'require("node:dns").lookup("registry.npmjs.org",(e)=>{console.log(e?"DNS-FAIL:"+e.code:"DNS-OK")})'] },
  wsA, { timeoutMs: 20_000 });
  has(hostNet.stdout, 'DNS-OK', '对照：宿主上同一段代码解析得到 —— 所以上面拦住的是沙箱，不是断网的机器');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. C2 写边界 —— 由内核拒，不由提示词拒');
// ═══════════════════════════════════════════════════════════════════════════

{
  const w = async (path) => (await ctr.execute({ file: 'node', args: ['-e',
    `try{require("node:fs").writeFileSync(${JSON.stringify(path)},"x");console.log("WROTE")}`
    + `catch(e){console.log("DENIED:"+e.code)}`] }, wsA, {})).stdout;

  has(await w('/workspace/probe.txt'), 'WROTE', '/workspace 可写');
  has(await w('/tmp/probe.txt'), 'WROTE', '/tmp 可写（编译与测试要落临时文件）');
  has(await w('/etc/probe.txt'), 'DENIED', '/etc 被拒');
  has(await w('/usr/bin/probe'), 'DENIED', '/usr/bin 被拒');
  has(await w('/probe.txt'), 'DENIED', '/ 被拒');
  // $HOME 必须可写且住在 /tmp 下：npm / corepack 要往里写缓存。否则 npm ci 会因 /root/.npm
  // 建不出来而失败（先报几十条 tarball corrupted，最后才 ENOENT）。
  const home = await ctr.execute({ file: 'node', args: ['-e',
    'const fs=require("node:fs");const h=process.env.HOME;fs.mkdirSync(h+"/.npm",{recursive:true});'
    + 'fs.writeFileSync(h+"/.npm/probe","x");console.log(h+" "+process.env.npm_config_cache)'] }, wsA, {});
  has(home.stdout, '/tmp/home /tmp/home/.npm', '$HOME=/tmp/home 且 npm 缓存指到它下面，可 mkdir 可写');
  assert(readFileSync(join(wsA, 'probe.txt'), 'utf8') === 'x',
    '容器里写进 /workspace 的文件，宿主侧在工作区里看得到（bind mount 双向可见）');

  // 只读视图：声明为 read-only 的命令拿到的是同一份工作区的 ro 挂载。
  const roRead = await ctr.execute({ file: 'cat', args: ['probe.txt'] }, wsA, {});
  eq(roRead.mode, 'read-only', 'cat 走只读视图');
  eq(roRead.cwd, '/workspace-ro', '只读视图的 cwd 是 /workspace-ro');
  eq(roRead.stdout, 'x', '只读视图里读得到同一份内容');

  // 显式传 mode 时，写操作在只读视图上必须失败 —— 这就是"misclassify 会当场炸"。
  const roWrite = await ctr.execute({ file: 'node', args: ['-e',
    'try{require("node:fs").writeFileSync("./ro-probe.txt","x");console.log("WROTE")}'
    + 'catch(e){console.log("DENIED:"+e.code)}'] }, wsA, { mode: 'read-only' });
  has(roWrite.stdout, 'DENIED', '被判为只读的命令写工作区时由内核拒（EROFS）—— 分类不再是装饰');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. C5 资源限额与能力集');
// ═══════════════════════════════════════════════════════════════════════════

{
  const caps = await ctr.execute({ file: 'cat', args: ['/proc/self/status'] }, wsA, {});
  const eff = /CapEff:\s*([0-9a-f]+)/.exec(caps.stdout)?.[1];
  eq(eff?.replace(/^0+/, '') || '0', '0', `有效能力集为空（CapEff=${eff}）—— cap_drop ALL 生效`);

  const mem = await ctr.execute({ file: 'cat', args: ['/sys/fs/cgroup/memory.max'] }, wsA, {});
  const bytes = Number(mem.stdout.trim());
  eq(bytes, 1024 * 1024 * 1024, `内存上限 1 GiB 写进了 cgroup（${bytes}）`);

  const pids = await ctr.execute({ file: 'cat', args: ['/sys/fs/cgroup/pids.max'] }, wsA, {});
  eq(pids.stdout.trim(), '512', 'PID 上限 512 写进了 cgroup');

  // 超时：上限跑在**容器内**，不靠杀宿主侧客户端。
  const t0 = Date.now();
  const slow = await ctr.execute({ file: 'node', args: ['-e', 'setTimeout(()=>{},60000)'] },
    wsA, { timeoutMs: 3000 });
  const elapsed = Date.now() - t0;
  assert(slow.timedOut, `超时被标记（exit=${slow.code}）`);
  assert(elapsed < 15_000, `在 3 s 上限后不久就返回了（实测 ${elapsed} ms），不是靠宿主兜底计时器`);

  // 超时杀掉的进程要**被回收**，不能变成僵尸。
  //
  // ⚠️ 这一条是实测撞出来的：PID 1 是 `sleep infinity`，而 sleep 从不 wait()，
  // 于是每次超时留一个 Z 状态进程，只增不减。它单独看是慢泄漏，配上 `--pids-limit`
  // 就是定时炸弹 —— 攒满 512 个槽位后容器里什么都 fork 不起来，报错却指不到超时。
  // 修法是 `--init`（tini 当 PID 1 负责收尸）。
  //
  // 断言直接数**僵尸**，不数 pid 总数：/proc 里还有 docker 自己的 exec 辅助进程，
  // 数总数会造出一个跟着时序翻面的用例（第一版就是这么写的，当场翻了）。
  const zombies = async () => {
    const r = await ctr.execute({ file: 'sh', args: ['-c',
      'ls /proc | grep -E "^[0-9]+$" | while read p; do awk "/^State:/{print \\$2}" /proc/$p/status 2>/dev/null; done | grep -c Z || true'] },
    wsA, {});
    return Number(r.stdout.trim() || 0);
  };
  eq(await zombies(), 0, '超时杀掉的进程被回收了，没有变成僵尸（--init 生效）');
  for (let i = 0; i < 3; i++) {
    await ctr.execute({ file: 'node', args: ['-e', 'setTimeout(()=>{},60000)'] }, wsA, { timeoutMs: 1000 });
  }
  eq(await zombies(), 0, '再超时 3 次，僵尸仍为 0 —— 是真回收，不是碰巧');

  // C7 宿主 uid 映射：容器里写下的文件，在宿主上要属于跑守护进程的用户。
  // Docker Desktop（Windows / macOS）的文件共享层伪装了所有权，这条在那里天然成立；
  // Linux 宿主上没有 --user 的话文件是 root:root，守护进程之后 git add / 清工作区全部 EACCES。
  const hu = hostUserArgs();
  if (typeof process.getuid === 'function') {
    eq(hu.join(' '), `--user ${process.getuid()}:${process.getgid()}`, '有 getuid 的宿主：run 参数带 --user uid:gid');
    const who = await ctr.execute({ file: 'id', args: ['-u'] }, wsA, {});
    eq(who.stdout.trim(), String(process.getuid()), `容器里的 uid = 宿主 uid（${who.stdout.trim()}）`);
    await ctr.execute({ file: 'sh', args: ['-c', 'echo owned > /workspace/owned.txt'] }, wsA, {});
    const st = statSync(join(wsA, 'owned.txt'));
    eq(st.uid, process.getuid(), `容器写下的文件在宿主上属于 uid ${process.getuid()}（实得 ${st.uid}）`);
  } else {
    eq(hu.length, 0, 'Windows 宿主没有 getuid：不加 --user，交给 Docker Desktop 的共享层');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. C4 任务间零共享');
// ═══════════════════════════════════════════════════════════════════════════

{
  const wsB = mkws('task-b');
  const ctrB = new ContainerExecutor({ taskId: 't_ctrtest_b' });
  execs.push(ctrB);
  await ctrB.start(wsB);
  assert(ctrB.name !== ctr.name, `两个任务两个容器（${ctr.name} / ${ctrB.name}）`);

  const seeA = await ctrB.execute({ file: 'ls', args: ['-1'] }, wsB, {});
  assert(!seeA.stdout.includes('hello.mjs'),
    'B 的容器里看不到 A 工作区的文件');
  const seeTmp = await ctrB.execute({ file: 'ls', args: ['/tmp'] }, wsB, {});
  assert(!seeTmp.stdout.includes('probe.txt'),
    'B 的 /tmp 里也看不到 A 写的东西（tmpfs 每容器独立）');

  // 挂错工作区要吵，不能默默在旧挂载上跑
  let threw = null;
  try { await ctrB.execute({ file: 'ls', args: [] }, wsA, {}); } catch (e) { threw = e; }
  assert(threw && /每任务一个容器一个工作区/.test(threw.message),
    '拿 A 的工作区去 B 的沙箱上执行会被拒');

  const listed = listSandboxes(rt.cli);
  assert(listed.some((s) => s.taskId === 't_ctrtest_a') && listed.some((s) => s.taskId === 't_ctrtest_b'),
    `按 label 列得出遗留沙箱（当前 ${listed.length} 个）—— 崩溃后能清扫`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. 拒绝静默降级：运行时缺失必须抛，不能退回宿主裸跑');
// ═══════════════════════════════════════════════════════════════════════════

{
  rejects(() => detectRuntime(['definitely-not-a-runtime-xyz']),
    '探测不到运行时时抛错，而不是返回 null 让调用方退回 LocalExecutor');
  rejects(() => new ContainerExecutor({}), 'ContainerExecutor 没有 taskId 时拒绝构造');
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. 收尾：容器能删干净');
// ═══════════════════════════════════════════════════════════════════════════

{
  const r = await ctr.stop();
  eq(r?.removed, true, '沙箱可删除');
  const still = listSandboxes(rt.cli).some((s) => s.name === ctr.name);
  assert(!still, '删除后不再出现在列表里');
  eq(await ctr.stop(), null, '重复 stop 是幂等的（返回 null，不抛）');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
