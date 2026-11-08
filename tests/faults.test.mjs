// 故障注入：错误路径。平时跑不到的失败逼出来，看状态是否仍然一致、去掉故障之后能否恢复。
//   ① 模型调用网络失败（厂商侧）：步骤退回 pending、不计重试、以 provider_error 退出；恢复后照常做完；
//   ② 进程在步骤中途崩了（非基础设施错误）：步骤不卡在 running、计一次重试；租约交还；恢复后照常做完；
//   ③ 步骤做完、提交时 git 失败：重跑后产物仍然落到分支上（不会出现"步骤 done 但产物没提交"）；
//   ④ 拿写锁时出错：事务没开成，库里没有半截写入；
//   ⑤ 注入点本身：不登记就不触发；after / times 计数准确；
//   ⑥–⑨ 六个关键流程里剩下的四个：拉起（子进程起不来）、交接（校验改动时 git 出错）、合并（快进失败 / 合并完没记下就崩）、交付（推送失败）。
//
// 跑：node tests/faults.test.mjs

import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { setFaults, clearFaults, faultHits, maybeFault } from '../src/core/faults.mjs';
import { ProviderError } from '../src/core/errors.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { leaseOf } from '../src/db/lease.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { createProject, advanceProject } from '../src/core/project.mjs';
import { signOff, deliverTask } from '../src/core/deliver.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);
const TMP = mkdtempSync(join(tmpdir(), 'si-faults-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

function fixture(name) {
  const db = openDb(join(TMP, `${name}.db`));
  const { userId } = ensureOwner(db);
  const id = newId('t'), nid = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'故障注入','running',?)`, id, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'写一个文件','.','out.txt 存在','[]',?,?)`, newId('c'), id, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES (?,?,'写 out.txt','写 out.txt','out.txt 存在','pending','normal','standard',?)`, nid, id, t);
  const ws = join(TMP, name); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, 'README.md'), '# x\n');
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init'); git(ws, 'checkout', '-q', '-b', 'v0/t');
  return { db, id, nid, ws };
}
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${Math.random()}`, name, args }], usage: { inputTokens: 1000, outputTokens: 20 } });
const work = () => [call('write_file', { path: 'out.txt', content: 'x\n' }), call('submit_handoff', { artifacts: [{ path: 'out.txt', kind: 'source' }], interface_contract: 'x', acceptance_evidence: 'y' })];
const run = (f, script, extra = {}) => orchestrate(f.db, { taskId: f.id, workspace: f.ws, narrativeDir: join(TMP, `narr-${Math.random()}`), verify: false, maxCycles: 3,
  makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(script) }), ...extra });
const node = (f) => f.db.one(`SELECT status, retry_count FROM nodes WHERE id=?`, f.nid);

section('① 模型调用网络失败：退回 pending、不计重试，恢复后做完');
{
  const f = fixture('llm');
  setFaults([{ point: 'llm', times: 1, error: () => new ProviderError('ECONNRESET（注入）', { retryable: true, vendor: 'fake', status: null }) }]);
  const r1 = await run(f, work());
  clearFaults();
  eq(r1.kind, 'provider_error', '以 provider_error 退出（守护进程据此退避重试）');
  eq([node(f).status, node(f).retry_count], ['pending', 0], '步骤退回 pending、不计重试（不是步骤自己的错）');
  const r2 = await run(f, work());
  eq([r2.kind, node(f).status], ['complete', 'done'], '去掉故障后照常做完');
  f.db.close();
}

section('② 进程在步骤中途崩了：不卡在 running、计一次重试、租约交还；恢复后做完');
{
  const f = fixture('crash');
  setFaults([{ point: 'llm', after: 1, times: 1, error: () => new TypeError('模拟一个真 bug（注入）') }]);
  let threw = null;
  try { await run(f, work()); } catch (e) { threw = e; }
  clearFaults();
  assert(threw instanceof TypeError, '真 bug 照样抛出去（不被"优雅处理"藏起来）');
  eq([node(f).status, node(f).retry_count], ['pending', 1], '步骤不卡在 running，计一次重试');
  eq(leaseOf(f.db, `task:${f.id}`).live, false, '租约交还了（下一个编排器不用等两分钟）');
  const r2 = await run(f, work());
  eq([r2.kind, node(f).status], ['complete', 'done'], '恢复后照常做完');
  f.db.close();
}

section('③ 步骤做完、提交时 git 失败：重跑后产物仍落到分支上');
{
  const f = fixture('commit');
  setFaults([{ point: 'git', times: 1, match: (ctx) => (ctx.args ?? []).includes('commit') }]);
  let threw = null;
  try { await run(f, work()); } catch (e) { threw = e; }
  clearFaults();
  assert(!!threw, `提交失败抛出来了（${String(threw?.message).slice(0, 60)}）`);
  const r2 = await run(f, []);
  const tracked = git(f.ws, 'ls-files', 'out.txt').stdout.trim();
  const dirty = git(f.ws, 'status', '--porcelain').stdout.trim();
  assert(tracked === 'out.txt' && !dirty, `重跑之后 out.txt 已提交、工作区干净（${r2.kind}；未提交：${dirty || '无'}）`);
  f.db.close();
}

section('④ 拿写锁时出错：事务没开成，没有半截写入');
{
  const db = openDb(':memory:');
  const before = db.one(`SELECT count(*) n FROM audit_log`).n;
  setFaults([{ point: 'db.tx', times: 1, message: 'SQLITE_IOERR（注入）' }]);
  let err = null;
  try { db.tx(() => { db.run(`INSERT INTO audit_log (ts, actor_kind, action) VALUES (?, 'system', 'half')`, now()); }); } catch (e) { err = e; }
  clearFaults();
  assert(/注入/.test(err?.message ?? ''), '错误抛给调用方');
  eq(db.one(`SELECT count(*) n FROM audit_log`).n, before, '库里没有半截写入');
  db.tx(() => db.run(`INSERT INTO audit_log (ts, actor_kind, action) VALUES (?, 'system', 'after')`, now()));
  ok('之后的事务照常（没有留下没提交的事务）');
  db.close();
}

// ── 六个关键流程（拉起、执行、交接、合并、交付、迁移）。执行 = ①②③；迁移 = schema-quality ⑤（坏数据整个回滚、
//    库停在原版本）与 migrations（迁移失败版本号不动）；下面补拉起、交接、合并、交付。

section('⑥ 拉起：子进程起不来（同步抛 / 异步 error），守护进程不能跟着崩，描述符不能漏');
{
  const home = join(TMP, 'launch');
  mkdirSync(home, { recursive: true });
  for (const mode of ['async', 'throw']) {
    const r = spawnSync(process.execPath, ['--no-warnings', join(dirname(fileURLToPath(import.meta.url)), '_launch_fault_worker.mjs'), home, mode], { encoding: 'utf8' });
    let o = null; try { o = JSON.parse(r.stdout); } catch { /* 崩了就没有输出 */ }
    eq([r.status, o?.alive, o?.fdOpen, o?.audit?.includes('launch_failed'), o?.running], [0, true, false, true, null],
      mode === 'async' ? '异步 error（ENOENT）：进程活着（原来未处理的 error 事件直接带走守护进程连同看板）、日志描述符已关、记了 launch_failed、不算在跑'
        : '同步抛（EMFILE）：抛给调用方、描述符已关（原来漏一个）、记了 launch_failed');
  }
}

section('⑦ 交接：校验改动时 git 出错，那次交接不被收下；再交一次照常做完');
{
  const f = fixture('handoff');
  setFaults([{ point: 'git', times: 1, match: (ctx) => (ctx.args ?? [])[0] === 'diff' && (ctx.args ?? []).includes('--name-only') }]);
  // 执行器第一次交接时 git 出错 → 被拒；它再交一次（故障已过）→ 收下
  const r1 = await run(f, [...work(), call('submit_handoff', { artifacts: [{ path: 'out.txt', kind: 'source' }], interface_contract: 'x', acceptance_evidence: 'y' })]);
  clearFaults();
  const rej = f.db.all(`SELECT payload FROM audit_log WHERE action='handoff_rejected' AND target_id=?`, f.nid);
  assert(rej.length === 1 && /改动/.test(rej[0].payload), `算不出改动的那次交接被拒、记了 handoff_rejected（${String(rej[0]?.payload).slice(0, 80)}）`);
  eq([r1.kind, node(f).status], ['complete', 'done'], '再交一次照常收下、步骤做完（没有因为一次 git 错误卡死）');
  f.db.close();
}

const gitx = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

section('⑧ 合并：快进失败 / 合并完还没记下就崩了 —— 不丢、不重、重跑补齐');
{
  const home = join(TMP, 'merge-home');
  const src = join(TMP, 'merge-src');
  mkdirSync(src, { recursive: true });
  gitx(src, 'init', '-q', '-b', 'main'); writeFileSync(join(src, 'README.md'), '# m\n'); gitx(src, 'add', '.'); gitx(src, 'commit', '-q', '-m', 'init');
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const P = createProject(db, { userId: owner.userId, source: src, home, spec: { title: '合并注入', brief: 'b', tasks: [
    { title: 'T1', goal: 'g1', definition_of_done: 'd1', verify_command: 'node -e 0' }, { title: 'T2', goal: 'g2', definition_of_done: 'd2', verify_command: 'node -e 0' }] } });
  const [t1] = P.taskIds;
  const ws1 = join(home, 'workspaces', t1);
  writeFileSync(join(ws1, 'lib.mjs'), 'export const x = 1;\n'); gitx(ws1, 'add', '.'); gitx(ws1, 'commit', '-q', '-m', 'T1');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, t1);
  signOff(db, { taskId: t1, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  const adv = () => advanceProject(db, { projectId: P.projectId, home, userId: owner.userId });
  const merged = () => [db.one(`SELECT merged_at FROM tasks WHERE id=?`, t1).merged_at != null, db.one(`SELECT count(*) n FROM audit_log WHERE action='project_task_merged' AND target_id=?`, P.projectId).n];
  const head1 = gitx(ws1, 'rev-parse', 'HEAD');

  setFaults([{ point: 'git', times: 1, match: (ctx) => (ctx.args ?? [])[0] === 'merge' && (ctx.args ?? []).includes('--ff-only') }]);
  let e1 = null; try { await adv(); } catch (e) { e1 = e; }
  clearFaults();
  eq([!!e1, ...merged(), gitx(P.repo, 'rev-parse', P.branch) === head1], [true, false, 0, false], '快进失败：抛出、merged_at 没记、没有合并审计、项目分支没动');

  // 合并已经做了（项目分支已快进）、记 merged_at 之前进程没了：用"项目分支已到位之后的那次 rev-parse HEAD"模拟
  setFaults([{ point: 'git', times: 1, match: (ctx) => (ctx.args ?? []).join(' ') === 'rev-parse HEAD' && gitx(P.repo, 'rev-parse', P.branch) === head1 }]);
  let e2 = null; try { await adv(); } catch (e) { e2 = e; }
  clearFaults();
  // 认领（merged_at）挪到快进之前做提交点 —— 认领之后人的修正 / 中止看到的就是"已合并"；崩了由下一拍照认领补齐
  eq([!!e2, ...merged(), gitx(P.repo, 'rev-parse', P.branch) === head1], [true, true, 0, true], '合并做了、记下之前崩了：认领已记、项目分支已到位，合并审计还没有');
  const r = await adv();
  eq([r.reason, r.recovered, ...merged()], ['merged', true, true, 1], '重跑一遍：照认领补齐，合并审计恰好一条（快进是幂等的）');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_merge_claim_undone' AND target_id=?`, t1).n, 1, '前面那次快进失败撤过一次认领，留了审计');
  db.close();
}

section('⑨ 交付：推送失败，不记已交付、远端不动；恢复后交付成功');
{
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'交付注入','done',?)`, taskId, owner.userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), taskId, t, t);
  const ws = join(TMP, 'deliver-ws'); mkdirSync(ws);
  gitx(ws, 'init', '-q', '-b', 'main'); writeFileSync(join(ws, 'a.txt'), '1\n'); gitx(ws, 'add', '-A'); gitx(ws, 'commit', '-q', '-m', 'base');
  gitx(ws, 'checkout', '-q', '-b', `v0/${taskId}`); writeFileSync(join(ws, 'a.txt'), '2\n'); gitx(ws, 'add', '-A'); gitx(ws, 'commit', '-q', '-m', 'work');
  const bare = join(TMP, 'deliver-remote.git'); gitx(TMP, 'init', '-q', '--bare', bare);
  const delivered = () => db.one(`SELECT count(*) n FROM audit_log WHERE action='task_delivered' AND target_id=?`, taskId).n;
  const remoteHas = () => spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/v0/${taskId}`], { cwd: bare, encoding: 'utf8' }).status === 0;
  setFaults([{ point: 'git', times: 1, match: (ctx) => (ctx.args ?? []).includes('push') }]);
  let e = null; try { await deliverTask(db, { taskId, workspace: ws, remote: bare, userId: owner.userId, token: null }); } catch (x) { e = x; }
  clearFaults();
  eq([!!e, delivered(), remoteHas()], [true, 0, false], '推送失败：抛出、不记已交付、远端没有分支');
  await deliverTask(db, { taskId, workspace: ws, remote: bare, userId: owner.userId, token: null });
  eq([delivered(), remoteHas()], [1, true], '恢复后交付成功、记一次');
  db.close();
}

section('⑤ 注入点本身');
{
  clearFaults();
  maybeFault('git', { args: ['status'] });
  ok('不登记就不触发');
  setFaults([{ point: 'git', after: 2, times: 1 }]);
  let thrownAt = -1;
  for (let i = 0; i < 5; i++) { try { maybeFault('git', {}); } catch { thrownAt = i; } }
  eq([thrownAt, faultHits('git')], [2, 1], 'after=2, times=1：放过两次、第三次抛、之后不再抛');
  clearFaults();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
