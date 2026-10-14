// 进程非正常退出：查出来、补收尾、让人看得见，退避重试的口径不变。
//
// 跑：node tests/crashes.test.mjs

import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { acquireLease } from '../src/db/lease.mjs';
import { findCrashed, sweepCrashes } from '../src/core/crashes.mjs';
import { assessTask } from '../src/core/daemon.mjs';
import { replay } from '../src/core/replay.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);

const db = openDb(':memory:');
const { userId } = ensureOwner(db);
const mkTask = () => { const id = newId('t'); db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, id, userId, now()); return id; };
const start = (action, taskId, pid) => audit(db, { actorKind: 'system', action, targetType: 'task', targetId: taskId, payload: { pid } });

section('① 编排器：租约过期 = 死了；租约还在 = 还活着');
{
  const dead = mkTask(), live = mkTask();
  start('orchestrator_started', dead, 111); acquireLease(db, `task:${dead}`);
  db.run(`UPDATE leases SET expires_at=? WHERE resource=?`, now() - 1, `task:${dead}`);
  start('orchestrator_started', live, 222); acquireLease(db, `task:${live}`);
  const found = findCrashed(db, { alive: () => true });   // pid 都"活着"（被复用了）：编排器看租约，不看 pid
  eq(found.map((c) => c.targetId), [dead], '只有租约过期的那个算崩了（pid 活着也不算数）');
  sweepCrashes(db, { alive: () => true });
  const exit = db.one(`SELECT actor_id, payload FROM audit_log WHERE action='orchestrator_exit' AND target_id=?`, dead);
  const p = JSON.parse(exit.payload);
  eq([exit.actor_id, p.kind, p.detectedBy, p.synthetic], ['daemon', 'crashed', 'daemon', true], '补了一行收尾：kind=crashed，写明是守护进程查出来的（不冒充进程自己）');
  assert(!!db.one(`SELECT 1 x FROM audit_log WHERE action='process_crashed' AND target_id=?`, dead), '另记一条 process_crashed（看板活动流显示）');
  assert(!db.one(`SELECT 1 x FROM audit_log WHERE action='orchestrator_exit' AND target_id=?`, live), '还活着的那个不动');
}

section('② 别的进程（追问器 / 规划器）看 pid');
{
  const t = mkTask();
  start('elicitor_started', t, 333);
  eq(findCrashed(db, { alive: (pid) => pid !== 333 }).filter((c) => c.targetId === t).length, 1, 'pid 不在了 → 算崩了');
  eq(findCrashed(db, { alive: () => true }).filter((c) => c.targetId === t).length, 0, 'pid 还在 → 不算');
}

section('③ 只补一次；复盘不再报"没有收尾"；守护进程的重试口径不变');
{
  const t = mkTask();
  start('orchestrator_started', t, 444);    // 没有租约行（老版本起的）→ 看 pid
  sweepCrashes(db, { alive: () => false });
  const n1 = db.one(`SELECT count(*) n FROM audit_log WHERE action='orchestrator_exit' AND target_id=?`, t).n;
  sweepCrashes(db, { alive: () => false });
  eq([n1, db.one(`SELECT count(*) n FROM audit_log WHERE action='orchestrator_exit' AND target_id=?`, t).n], [1, 1], '再扫一遍不重复补');
  eq(replay(db, t).checks.find((c) => c.name === '进程寿命都有收尾').ok, true, '复盘：寿命都有收尾');
  const a = assessTask(db, db.one(`SELECT id, status FROM tasks WHERE id=?`, t), { alive: () => false, hasWorkspace: () => true });
  assert(/crashed/.test(a.reason ?? ''), `守护进程照旧按 crashed 退避重试（${a.reason}）`);
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
