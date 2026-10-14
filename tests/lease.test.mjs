// 租约与写入防护：
//   ① 租约本身：取得 / 别人持有被拒 / 同一进程可重入 / 过期后接管代数 +1 / 续约与核对在被接管后失败 / 交还；
//   ② 僵尸编排器：跑到一半被接管（另一个进程拿到了更新的代数），它之后的状态写入一律被挡，以 lease_lost 退出、不动任何状态；
//   ③ 守护进程按租约判"还在不在跑"：过期了即使 pid 还活着也当它死了（原来 pid 活着就永远不拉）；pid 复用不再卡住任务；
//   ④ 项目推进：别的进程正在推进同一个项目 → 这一轮让开（不两边同时合并）。
//
// 跑：node tests/lease.test.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { acquireLease, renewLease, assertLease, releaseLease, leaseOf, HOLDER } from '../src/db/lease.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { assessTask } from '../src/core/daemon.mjs';
import { advanceProject } from '../src/core/project.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);
const TMP = mkdtempSync(join(tmpdir(), 'si-lease-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const throwsWith = (fn, prop) => { try { fn(); return false; } catch (e) { return !!e[prop]; } };
/** 冒充另一个进程：直接改租约行（测试里没有第二个进程可用时） */
const stealAs = (db, resource, { expiresIn = 60_000 } = {}) => db.run(`UPDATE leases SET holder='other-host:999:1', pid=999, epoch=epoch+1, expires_at=? WHERE resource=?`, now() + expiresIn, resource);

section('① 租约本身');
{
  const db = openDb(':memory:');
  const r = 'task:t_x';
  const a = acquireLease(db, r);
  eq([a.epoch, a.takeover], [1, false], '第一次取得：代数 1');
  eq(acquireLease(db, r).epoch, 1, '同一进程再取：可重入，代数不变');
  stealAs(db, r);
  assert(throwsWith(() => acquireLease(db, r), 'leaseHeld'), '别人持有且没过期 → 拒绝');
  assert(throwsWith(() => renewLease(db, r, 1), 'leaseLost'), '我的旧代数续约 → 失败（已被接管）');
  assert(throwsWith(() => assertLease(db, r, 1), 'leaseLost'), '我的旧代数核对 → 失败');
  db.run(`UPDATE leases SET expires_at=? WHERE resource=?`, now() - 1, r);
  const b = acquireLease(db, r);
  eq([b.epoch, b.takeover], [3, true], '过期后接管：代数 +1，记下从谁手里接的');
  eq(b.previous.holder, 'other-host:999:1', '接管记录里有前一个持有者');
  releaseLease(db, r, b.epoch);
  eq(leaseOf(db, r).live, false, '交还 = 立即到期（行留着，代数单调）');
  db.close();
}

function taskFixture(db) {
  const { userId } = ensureOwner(db);
  const id = newId('t'), nid = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'租约测试','running',?)`, id, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), id, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES (?,?,'写文件','写 a.txt','a.txt 存在','pending','normal','standard',?)`, nid, id, t);
  const ws = join(TMP, id); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, 'README.md'), '# x\n');
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init');
  return { id, nid, ws };
}
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${Math.random()}`, name, args }], usage: { inputTokens: 1000, outputTokens: 20 } });

section('② 僵尸编排器：跑到一半被接管，之后的状态写入一律被挡');
{
  const db = openDb(join(TMP, 'zombie.db'));
  const { id, nid, ws } = taskFixture(db);
  let stolen = false;
  const r = await orchestrate(db, { taskId: id, workspace: ws, narrativeDir: join(TMP, 'narr'), verify: false, maxCycles: 2,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([call('list_dir', { path: '.' }), call('write_file', { path: 'a.txt', content: 'x' }), call('submit_handoff', { artifacts: [{ path: 'a.txt', kind: 'file' }], interface_contract: '无', known_issues: [], downstream_notes: '' })]) }),
    onEvent: (e) => { if (e.type === 'step' && !stolen) { stolen = true; stealAs(db, `task:${id}`); } } });
  eq(r.kind, 'lease_lost', '以 lease_lost 退出');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, nid).status, 'running', '步骤状态停在被接管那一刻（没有被它改成 done / pending —— 那是新主人的事）');
  const exit = db.one(`SELECT payload FROM audit_log WHERE action='orchestrator_exit' AND target_id=? ORDER BY id DESC LIMIT 1`, id);
  eq(JSON.parse(exit.payload).kind, 'lease_lost', '退出审计写明被接管');
  eq(leaseOf(db, `task:${id}`).holder, 'other-host:999:1', '租约仍在新主人手里（被接管的一方不交还别人的租约）');
  db.close();
}

section('③ 守护进程按租约判还在不在跑');
{
  const db = openDb(':memory:');
  const { id } = taskFixture(db);
  audit(db, { actorKind: 'system', action: 'orchestrator_started', targetType: 'task', targetId: id, payload: { pid: 999 } });
  acquireLease(db, `task:${id}`); stealAs(db, `task:${id}`);
  const assess = (alive) => assessTask(db, db.one(`SELECT id, status FROM tasks WHERE id=?`, id), { alive: () => alive });
  eq(assess(true).reason, 'live_foreign', '租约没过期 → 还在跑，不拉');
  db.run(`UPDATE leases SET expires_at=? WHERE resource=?`, now() - 1, `task:${id}`);
  const a = assess(true);
  assert(a.reason !== 'live_foreign', `租约过期、pid 却"还活着"（卡死的僵尸 / pid 被复用）→ 不再当它在跑（${a.reason}）`);
  db.close();
}

section('④ 项目推进：别人正在推进同一个项目 → 这一轮让开');
{
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const pj = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'P','/r','b','main','active',?)`, pj, userId, now());
  acquireLease(db, `project:${pj}`); stealAs(db, `project:${pj}`);
  const r = await advanceProject(db, { projectId: pj, home: TMP });
  eq([r.advanced, r.reason], [false, 'busy'], '让开，不报错（下一轮再来）');
  eq(leaseOf(db, `project:${pj}`).holder, 'other-host:999:1', '没动别人的租约');
  // 别的主机的持有者：pid 在这台机器上看不出死活，照旧按到期（哪怕 alive 说"不在"）
  const r1 = await advanceProject(db, { projectId: pj, home: TMP, alive: () => false });
  eq(r1.reason, 'busy', '别的主机上的持有者：不当场接管');
  // 本机、进程已经不在（推进到一半崩了）：不等 30 分钟，当场接管
  const host = HOLDER.split(':')[0];
  db.run(`UPDATE leases SET holder=?, pid=424242, expires_at=? WHERE resource=?`, `${host}:424242:1`, now() + 30 * 60_000, `project:${pj}`);
  const r2 = await advanceProject(db, { projectId: pj, home: TMP, alive: (pid) => pid !== 424242 });
  assert(r2.reason !== 'busy', `本机持有者已经不在：当场接管、照常推进（${r2.reason ?? r2.advanced}）`);
  // 本机、进程还活着（可能只是慢）：让开
  db.run(`UPDATE leases SET holder=?, pid=424243, expires_at=? WHERE resource=?`, `${host}:424243:1`, now() + 30 * 60_000, `project:${pj}`);
  const r3 = await advanceProject(db, { projectId: pj, home: TMP, alive: () => true });
  eq(r3.reason, 'busy', '本机持有者还活着：让开');
  // 任务租约不走这条（到期是崩溃扫描的判据）：acquireLease 不带 reclaimDead 时照旧拒
  const tr = `task:t_dead`;
  db.run(`INSERT INTO leases (resource, holder, pid, epoch, acquired_at, heartbeat_at, expires_at, meta) VALUES (?,?,424244,1,?,?,?,'{}')`, tr, `${host}:424244:1`, now(), now(), now() + 60_000);
  let held = false; try { acquireLease(db, tr); } catch (e) { held = !!e.leaseHeld; }
  assert(held, '任务租约：持有者死了也等到期（崩溃扫描靠到期补收尾、记崩溃）');
  db.close();
}
assert(/:\d+:\d+$/.test(HOLDER), `持有者标识带 pid 与进程起点（pid 复用也认得出）：${HOLDER}`);

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
