// 破坏性操作的护栏：
// `workspace --dir <路径> --force` / 项目验收的强制重建，会把目标目录整个递归删掉。目标由人手输，写错一层就是整棵树
// （GitLab 2017 误删、Replit 2025 agent 删库那一类）。现在只删系统自己建的目录：空目录、带工作区标记的、
// 或标记出现之前建的（git 仓库里有 v0/ 任务分支）；其余拒绝，原样不动。
//
// 跑：node tests/destructive-guards.test.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { ensureWorkspace, isDeletableWorkspace, forceRemoveDir } from '../src/core/workspace.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const section = (s) => console.log(`\n── ${s}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-guard-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const db = openDb(':memory:');
const { userId } = ensureOwner(db);
const taskId = newId('t');
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,?,?,?)`, taskId, userId, 'x', 'running', now());
const src = join(TMP, 'src'); mkdirSync(src);
git(src, 'init', '-q', '-b', 'main'); writeFileSync(join(src, 'a.txt'), 'a\n'); git(src, 'add', '.'); git(src, 'commit', '-q', '-m', 'init');

const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

section('1. 手误指到一个普通目录：拒绝，里面的东西一样不少');
{
  const dir = join(TMP, 'my-documents'); mkdirSync(join(dir, 'deep'), { recursive: true });
  writeFileSync(join(dir, 'thesis.docx'), 'irreplaceable'); writeFileSync(join(dir, 'deep', 'notes.md'), 'x');
  const e = throws(() => ensureWorkspace(db, { taskId, source: src, dir, force: true }));
  assert(e && /拒绝删除/.test(e.message), `拒绝了（${e?.message?.slice(0, 40)}…）`);
  assert(readFileSync(join(dir, 'thesis.docx'), 'utf8') === 'irreplaceable' && existsSync(join(dir, 'deep', 'notes.md')), '文件都还在');
}

section('2. 指到别的 git 仓库（没有 v0/ 任务分支）：拒绝');
{
  const other = join(TMP, 'other-repo'); mkdirSync(other);
  git(other, 'init', '-q', '-b', 'main'); writeFileSync(join(other, 'b.txt'), 'b\n'); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'x');
  assert(!isDeletableWorkspace(other), '判定不可删');
  const e = throws(() => forceRemoveDir(other));
  assert(e && existsSync(join(other, 'b.txt')), '直接调 forceRemoveDir 也拒绝，仓库还在');
}

section('3. 系统建的工作区：--force 照常重建');
{
  const dir = join(TMP, 'workspaces', taskId);
  const w1 = ensureWorkspace(db, { taskId, source: src, dir });
  assert(w1.created && existsSync(join(dir, '.git', 'superintern-workspace')), '建工作区时写了标记（在 .git 里，不进仓库）');
  assert(git(dir, 'status', '--porcelain') === '', '标记不出现在改动里');
  writeFileSync(join(dir, 'scratch.txt'), 'leftover');
  const w2 = ensureWorkspace(db, { taskId, source: src, dir, force: true });
  assert(w2.created && !existsSync(join(dir, 'scratch.txt')), '强制重建：旧内容清掉了');
}

section('4. 标记出现之前建的工作区（有 v0/ 分支、没有标记）与空目录：可删');
{
  const legacy = join(TMP, 'legacy'); mkdirSync(legacy);
  git(legacy, 'init', '-q', '-b', `v0/${taskId}`); writeFileSync(join(legacy, 'c.txt'), 'c\n'); git(legacy, 'add', '.'); git(legacy, 'commit', '-q', '-m', 'x');
  assert(isDeletableWorkspace(legacy), '老工作区认得出来');
  const empty = join(TMP, 'empty'); mkdirSync(empty);
  assert(isDeletableWorkspace(empty), '空目录可删');
  const w = ensureWorkspace(db, { taskId, source: src, dir: empty, force: true });
  assert(w.created, '空目录上 --force 照常建');
  assert(!isDeletableWorkspace(join(TMP, 'does-not-exist')), '不存在的路径：不可删（也不会去删）');
}

section('5. git 参数注入：远端 / 源仓库地址以 - 开头会被当成选项，--upload-pack=<命令> 能在本机执行命令');
{
  const { safePositional } = await import('../src/core/git.mjs');
  const { initProjectRepo, deliverProject } = await import('../src/core/project.mjs');
  const { deliverTask } = await import('../src/core/deliver.mjs');
  const PWN = join(TMP, 'PWNED');
  const evil = `--upload-pack=node -e "require('fs').writeFileSync(${JSON.stringify(PWN)},'x')"`;
  assert(throws(() => safePositional(evil)) && throws(() => safePositional('')) && throws(() => safePositional('a\nb')), 'safePositional：- 开头、空、带换行都拒');
  assert(safePositional(' https://github.com/o/r.git ') === 'https://github.com/o/r.git', '正常地址原样（去掉首尾空白）');
  const e1 = throws(() => initProjectRepo({ home: join(TMP, 'h1'), projectId: 'pj_evil', source: evil }));
  assert(e1 && /源仓库地址不对/.test(e1.message) && !existsSync(PWN), `建项目时源仓库地址带选项 → 拒绝，命令没有执行（${e1?.message?.slice(0, 30)}…）`);
  // 交付：任务级与项目级都在推之前拒
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, taskId);
  const ws = join(TMP, 'workspaces', taskId);
  const e2 = await deliverTask(db, { taskId, remote: '--receive-pack=evil', workspace: ws }).then(() => null, (e) => e);
  assert(e2 && /远端地址不对/.test(e2.message), `任务交付：远端以 - 开头 → 拒绝（${e2?.message?.slice(0, 30)}…）`);
  const e3 = await deliverProject(db, { projectId: 'pj_nope', remote: '--receive-pack=evil' }).then(() => null, (e) => e);
  assert(e3, '项目交付：远端以 - 开头 → 拒绝（项目不存在时先报项目，存在时报地址；两种都不推）');
}

console.log(`\n${'═'.repeat(72)}\n破坏性操作护栏：${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
