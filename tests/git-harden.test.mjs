// 宿主上的 git 不执行仓库里的命令。
//
// 工作区的 .git 原来在沙箱里可写：沙箱里的代码（执行器、依赖的安装脚本）往里写一个 pre-commit 钩子或 core.fsmonitor，
// 宿主上下一次系统提交 / git status 就在宿主上执行它，带着宿主的环境（模型 key、主密钥、库）—— 2026-10-14 在宿主上复现过。
// 第一道是沙箱里 .git 只读（tests/container.test.mjs 的「.git 只读」一节，要 docker）；这里验第二道：
// 就算 .git 被改过，系统经 core/git.mjs 跑的 git 也不执行钩子、不调 fsmonitor。
//
// 跑：node tests/git-harden.test.mjs

import { mkdtempSync, writeFileSync, existsSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { HostFileOps } from '../src/core/executor.mjs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitWorkspace } from '../src/core/workspace.mjs';
import { git, GIT_HARDEN } from '../src/core/git.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));

const ws = mkdtempSync(join(tmpdir(), 'si-harden-'));
process.on('exit', () => { try { rmSync(ws, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const raw = (...a) => execFileSync('git', a, { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
raw('init', '-q', '-b', 'main');
raw('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'init');

// 沙箱里的代码能写的两样：钩子、仓库配置里会执行命令的项
const hookMark = join(ws, 'HOOK_RAN').replace(/\\/g, '/'), fsmMark = join(ws, 'FSMONITOR_RAN').replace(/\\/g, '/');
writeFileSync(join(ws, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho ran > "${hookMark}"\n`);
try { chmodSync(join(ws, '.git', 'hooks', 'pre-commit'), 0o755); } catch { /* Windows 不看执行位 */ }
raw('config', 'core.fsmonitor', `echo ran > "${fsmMark}"; false`);

// 对照：不经 core/git.mjs 的裸 git 确实会执行它们（证明下面的"没执行"不是因为钩子写错了）
writeFileSync(join(ws, 'probe.txt'), '1');
raw('add', '-A');
raw('-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'probe');
assert(existsSync(hookMark) && existsSync(fsmMark), '对照：裸 git 提交会执行仓库里的钩子和 fsmonitor（这就是要防的）');
rmSync(hookMark, { force: true }); rmSync(fsmMark, { force: true });

// 系统的提交
writeFileSync(join(ws, 'a.txt'), 'hello');
const sha = commitWorkspace(ws, 'step');
assert(/^[0-9a-f]{40}$/.test(sha ?? ''), '系统提交照常成功');
assert(!existsSync(hookMark), '系统提交不执行仓库里的 pre-commit 钩子');
assert(!existsSync(fsmMark), '系统的 add / status / commit 不调仓库配置里的 fsmonitor');
git(ws, 'status', '--porcelain');
assert(!existsSync(fsmMark), 'git status 也不调');
assert(GIT_HARDEN.includes('core.hooksPath=/dev/null') && GIT_HARDEN.includes('core.fsmonitor=false'), 'GIT_HARDEN 两项都在');

// write_file 是宿主侧的写，沙箱的只读挂载管不到：在 HostFileOps 里拦（钩子之外，配置里还有过滤器驱动、credential.helper 等能执行命令）
const ops = new HostFileOps();
const denied = (p) => { try { ops.writeFile(ws, p, 'x'); return false; } catch (e) { return /\.git/.test(e.message); } };
assert(denied('.git/hooks/pre-commit'), 'write_file 写 .git/hooks 被拒');
assert(denied('.git/config'), 'write_file 写 .git/config 被拒');
assert(denied('./sub/../.git/info/attributes'), '绕一圈的相对路径也拒');
assert(denied('.GIT/config'), '大小写变体也拒（Windows / macOS 上是同一个目录）');
if (process.platform === 'win32' && existsSync(join(ws, 'GIT~1'))) assert(denied('GIT~1/config'), '8.3 短名 GIT~1 也拒');
const bare = mkdtempSync(join(tmpdir(), 'si-harden-nogit-'));
let madeRepo = true;
try { ops.writeFile(bare, '.git/config', '[core]'); } catch { madeRepo = false; }
assert(!madeRepo && !existsSync(join(bare, '.git')), '工作区还没有 .git 时也不许造一个（宿主会去信它）');
rmSync(bare, { recursive: true, force: true });
ops.writeFile(ws, 'src/ok.txt', 'fine');
assert(readFileSync(join(ws, 'src', 'ok.txt'), 'utf8') === 'fine', '普通文件照常能写');
ops.writeFile(ws, 'vendor/lib/.git/HEAD', 'x');
assert(existsSync(join(ws, 'vendor', 'lib', '.git', 'HEAD')), '子目录里的 .git（宿主不在那里跑 git）不拦');

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
