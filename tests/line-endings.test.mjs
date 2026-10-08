// 工作区与项目仓库的行尾按仓库原样：
// 克隆时带的 `-c core.autocrlf=false` 只管克隆那一条命令；之后系统在宿主机上往工作区里合并，读的是 Git for Windows 的
// 系统级 core.autocrlf=true，签出成 CRLF，Linux 沙箱里逐字比对的测试就挂。
// 修法：建库 / 克隆后把 core.autocrlf=false 写进仓库自己的配置。
//
// 跑：node tests/line-endings.test.mjs
// 用一份临时的全局配置把 autocrlf 设成 true，模拟 Windows 宿主（在任何系统上都复现得出来）。

import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { ensureWorkspace } from '../src/core/workspace.mjs';
import { initProjectRepo } from '../src/core/project.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-eol-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// 模拟 Windows 宿主：全局 autocrlf=true
const globalCfg = join(TMP, 'gitconfig');
writeFileSync(globalCfg, '[core]\n\tautocrlf = true\n');
process.env.GIT_CONFIG_GLOBAL = globalCfg;

const SRC = join(TMP, 'src'); mkdirSync(SRC);
git(SRC, 'init', '-q', '-b', 'main'); git(SRC, 'config', 'core.autocrlf', 'false');
writeFileSync(join(SRC, 'a.txt'), 'x\ny\n'); git(SRC, 'add', '.'); git(SRC, 'commit', '-q', '-m', 'init');

const db = openDb(':memory:');
const owner = ensureOwner(db, 'lead');
const tid = newId('t');
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'t','running',?)`, tid, owner.userId, now());

console.log('\n工作区');
const ws = ensureWorkspace(db, { taskId: tid, source: SRC, dir: join(TMP, 'ws') }).dir;
eq(git(ws, 'config', '--local', 'core.autocrlf'), 'false', '克隆后把 autocrlf=false 写进工作区自己的配置');
// 源仓库上又有一个提交，系统在宿主机上把它合进工作区（并行开发里每次"合并最新项目分支"都是这一步）
writeFileSync(join(SRC, 'a.txt'), 'x\ny\nz\n'); git(SRC, 'commit', '-q', '-am', 'more');
git(ws, 'fetch', '-q', 'origin'); git(ws, 'merge', '-q', '--ff-only', 'origin/main');
assert(!readFileSync(join(ws, 'a.txt'), 'utf8').includes('\r'), '宿主机上合并进来的文件仍是 LF（Linux 沙箱里逐字比对不会挂）');

// 对照：只在克隆那一条命令上关 autocrlf（修之前的做法）—— 之后的合并照样写成 CRLF
const ctl = join(TMP, 'ctl');
git(TMP, '-c', 'core.autocrlf=false', 'clone', '-q', SRC, ctl);
git(ctl, 'reset', '-q', '--hard', 'HEAD~1');
git(ctl, 'merge', '-q', '--ff-only', 'origin/main');
assert(readFileSync(join(ctl, 'a.txt'), 'utf8').includes('\r\n'), '对照：只在克隆时关、不写进仓库配置 → 合并后变成 CRLF（修之前的行为）');

console.log('\n项目仓库');
const pr = initProjectRepo({ home: join(TMP, 'home'), projectId: 'pj_eol', source: SRC });
eq(git(pr.repo, 'config', '--local', 'core.autocrlf'), 'false', '克隆的项目仓库同样写进配置');
const pe = initProjectRepo({ home: join(TMP, 'home'), projectId: 'pj_eol_empty', empty: true });
eq(git(pe.repo, 'config', '--local', 'core.autocrlf'), 'false', '从零开始的项目仓库同样写进配置');

db.close();
console.log(`\n${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
