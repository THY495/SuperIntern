// 首次安装 / First-time setup —— Windows 与 Linux 通用（scripts/setup.ps1、scripts/setup.sh 只是先查 Node 版本再调它）。
//
//   node scripts/setup.mjs                 检查前置、准备 .env、构建沙箱镜像
//   node scripts/setup.mjs --name 老王      顺手建库、签发管理员令牌（等于 node src/cli.mjs init --name 老王）
//
// 只做可重复的事：跑第二遍不会覆盖 .env、不会重建已有镜像、不会动已有的库。

import { execFileSync } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const nameAt = args.indexOf('--name');
const adminName = nameAt >= 0 ? args[nameAt + 1] : null;

let problems = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ⚠ ${m}`);
const bad = (m) => { problems++; console.log(`  ✗ ${m}`); };
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, ...opts }).trim();
const has = (cmd, a) => { try { return run(cmd, a); } catch { return null; } };

console.log('\nSuperIntern 安装检查 / setup check\n');

// 1. Node
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj > 22 || (maj === 22 && min >= 13)) ok(`Node ${process.versions.node}`);
else bad(`Node ${process.versions.node} 太旧，需要 ≥ 22.13（内置 node:sqlite）/ Node ≥ 22.13 required`);

// 2. git
const gitV = has('git', ['--version']);
if (gitV) ok(gitV); else bad('没有 git / git not found');

// 3. 容器运行时（沙箱）
let cli = null;
for (const c of ['docker', 'podman']) {
  const v = has(c, ['version', '--format', '{{.Server.Version}}']);
  if (v) { cli = c; ok(`${c} ${v}（daemon 在跑 / running）`); break; }
}
if (!cli) {
  bad('没有在跑的 docker / podman：沙箱起不来。Windows 装 Docker Desktop 并打开；Linux 装 docker-ce 并把当前用户加进 docker 组\n'
    + '    No running docker/podman: install Docker Desktop (Windows) or docker-ce (Linux) and make sure the daemon is running.');
}

// 4. .env
const envFile = join(ROOT, '.env');
if (!existsSync(envFile)) {
  copyFileSync(join(ROOT, '.env.example'), envFile);
  try { chmodSync(envFile, 0o600); } catch { /* Windows 上无所谓 */ }
  warn('已从 .env.example 复制出 .env —— 至少填一家模型厂商的 key（也可以稍后在看板「设置 → 服务商」里填）\n'
    + '    Created .env from .env.example — fill in at least one model vendor key (or later in the web UI: Settings → Providers).');
} else {
  const keys = readFileSync(envFile, 'utf8').split('\n').filter((l) => /^[A-Z_]+_API_KEY=.+/.test(l.trim())).map((l) => l.split('=')[0]);
  if (keys.length) ok(`.env 里已填：${keys.join('、')}（只看在不在，不显示值）`);
  else warn('.env 在，但还没有任何 *_API_KEY —— 至少填一家 / .env exists but no *_API_KEY is set yet');
}

// 5. 沙箱镜像（构建需要联网；只建缺的）
if (cli) {
  const image = (tag) => has(cli, ['image', 'inspect', '-f', '{{.Id}}', tag]);
  const build = (tag, argv, what) => {
    if (image(tag)) { ok(`镜像 ${tag} 已有`); return; }
    console.log(`  … 构建 ${what}（${tag}），第一次要几分钟 / building, may take a few minutes`);
    try { execFileSync(cli, argv, { cwd: ROOT, stdio: 'inherit' }); ok(`镜像 ${tag} 建好了`); }
    catch { bad(`镜像 ${tag} 构建失败（多半是网络：够不着 Docker Hub / apt 源）/ image build failed (network?)`); }
  };
  build('superintern/sandbox:v0.1', ['build', '-t', 'superintern/sandbox:v0.1', 'sandbox/'], '基础沙箱镜像');
  build('superintern/sandbox:v0.3-python', ['build', '--build-arg', 'BASE=superintern/sandbox:v0.1', '-f', 'sandbox/Dockerfile.python',
    '-t', 'superintern/sandbox:v0.3-python', 'sandbox/'], 'Python + 截图用浏览器的沙箱镜像');
  if (!image('mitmproxy/mitmproxy:latest')) {
    console.log('  … 拉取出网代理镜像 mitmproxy/mitmproxy / pulling egress proxy image');
    try { execFileSync(cli, ['pull', 'mitmproxy/mitmproxy:latest'], { cwd: ROOT, stdio: 'inherit' }); ok('出网代理镜像就绪'); }
    catch { bad('出网代理镜像拉取失败 / failed to pull mitmproxy image'); }
  } else ok('出网代理镜像已有');
}

// 6. 建库（可选）
if (adminName) {
  if (problems) { console.log('\n  前面有 ✗，先不建库 / fix the ✗ items first, not initializing'); }
  else {
    try { execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.mjs', 'init', '--name', adminName], { cwd: ROOT, stdio: 'inherit' }); }
    catch { bad('init 失败 / init failed'); }
  }
}

console.log(problems
  ? `\n还有 ${problems} 项要处理（上面的 ✗）。处理完再跑一次 / ${problems} item(s) to fix, then run again.\n`
  : `\n都就绪 / all set.${adminName ? '' : '\n下一步 / next:  node src/cli.mjs init --name <你的名字 / your name>'}
然后启动看板 / then start:  Windows: scripts\\start.ps1    Linux: scripts/start.sh
管理员令牌在 .superintern/cli-token（只看，不要贴到聊天里）/ admin token: .superintern/cli-token\n`);
process.exit(problems ? 1 : 0);
