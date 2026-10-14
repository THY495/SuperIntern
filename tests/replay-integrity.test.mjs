// 复盘完整性自检的口径。拿本机 23 个真实试跑库跑复盘，157 条"对不上"里大半是尺子本身的问题：
//   · 只认编排器与规划器两种进程寿命 —— 追问器、项目规划器花的钱全成了"落在寿命之外"；
//   · 账本记的是落库时刻，规划器 / 追问器整段跑完才落库 → 时间戳落在寿命结束之后；
//   · 看板 / 守护进程直接发的调用（分类、决定比对……）本来就没有寿命括号；
//   · 追问器 / 规划器的 question_raised 也被当成"执行"，去问它跑在哪个沙箱里。
// 这里钉住改过的口径；真正的洞（没写 task_done 的状态迁移、被硬杀的进程）照旧报红。
//
// 跑：node tests/replay-integrity.test.mjs

import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { replay } from '../src/core/replay.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);

function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const pj = newId('pj'), t = newId('t'), T = now();
  db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'P','/r','b','main','active',?)`, pj, userId, T);
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id) VALUES (?,?,'T','running',?,?)`, t, userId, T, pj);
  const life = (start, exit, target, pid, a, b) => {
    db.raw.exec('SELECT 1');
    audit(db, { actorKind: 'system', action: start, targetType: target === pj ? 'project' : 'task', targetId: target, payload: { pid } });
    db.run(`UPDATE audit_log SET ts=? WHERE id=(SELECT max(id) FROM audit_log)`, a);   // 仅测试：把时刻拨到指定值
    if (exit) { audit(db, { actorKind: 'system', action: exit, targetType: target === pj ? 'project' : 'task', targetId: target, payload: { pid, kind: 'ok' } });
      db.run(`UPDATE audit_log SET ts=? WHERE id=(SELECT max(id) FROM audit_log)`, b); }
  };
  const spend = (ts, role, procKind = null, procPid = null) => db.run(`INSERT INTO usage_ledger (task_id,role,model_tier,provider,model_id,input_tokens,output_tokens,micro_usd,billing,ts,proc_kind,proc_pid)
    VALUES (?,?,'standard','p','m',1,1,1,'computed',?,?,?)`, t, role, ts, procKind, procPid);
  return { db, pj, t, T, life, spend };
}
const check = (db, t, name) => replay(db, t).checks.find((c) => c.name === name);

// audit_log 有"不许改"的触发器 —— 测试里拨时刻要先拿掉（只在这个内存库里）
const unlock = (db) => db.raw.exec('DROP TRIGGER IF EXISTS trg_audit_no_update');

section('① 四种进程的寿命都认（原来只认编排器与规划器）');
{
  const f = fixture(); unlock(f.db);
  f.life('elicitor_started', 'elicitor_exit', f.t, 11, f.T + 1000, f.T + 2000);
  f.life('project_planner_started', 'project_planner_exit', f.pj, 12, f.T + 3000, f.T + 4000);   // 挂在项目上
  f.spend(f.T + 1500, 'elicitor');
  f.spend(f.T + 3500, 'project_planner');
  const c = check(f.db, f.t, '花费都落在某次进程寿命内');
  eq(c.ok, true, `追问器、项目规划器（寿命挂在项目上）的花费都对得上：${c.detail}`);
  eq(check(f.db, f.t, '进程寿命都有收尾').ok, true, '两段寿命都有收尾');
}

section('② 账本记了进程：按 pid 对到自己那段寿命；看板 / 守护进程花的单列；对不上的照样红');
{
  const f = fixture(); unlock(f.db);
  f.life('orchestrator_started', 'orchestrator_exit', f.t, 21, f.T + 1000, f.T + 5000);
  f.life('orchestrator_started', 'orchestrator_exit', f.t, 22, f.T + 6000, f.T + 9000);
  f.spend(f.T + 2000, 'executor', 'run', 21);
  f.spend(f.T + 7000, 'executor', 'run', 22);
  f.spend(f.T + 7500, 'decision-check', 'web', 999);
  let c = check(f.db, f.t, '花费都落在某次进程寿命内');
  eq(c.ok, true, `各自对上自己那段，看板花的单列：${c.detail}`);
  f.spend(f.T + 7200, 'executor', 'run', 21);   // pid 21 的寿命早结束了，时刻却落在 22 的寿命里
  c = check(f.db, f.t, '花费都落在某次进程寿命内');
  eq(c.ok, false, `时刻落在别人的寿命里不算数（按 pid 对，不按时间窗口凑）：${c.detail}`);
}

section('③ 老账（没记进程）退回按时间窗口判');
{
  const f = fixture(); unlock(f.db);
  f.life('planner_started', 'planner_exit', f.t, 31, f.T + 1000, f.T + 2000);
  f.spend(f.T + 1500, 'planner');
  eq(check(f.db, f.t, '花费都落在某次进程寿命内').ok, true, '窗口内的老账对得上');
  f.spend(f.T + 9000, 'planner');
  eq(check(f.db, f.t, '花费都落在某次进程寿命内').ok, false, '窗口外的老账照样红（不做追溯粉饰）');
}

section('④ "执行跑在哪"只问执行器：追问器 / 规划器的提问本来就在宿主上');
{
  const f = fixture(); unlock(f.db);
  const q = newId('q');
  f.db.run(`INSERT INTO questions (id,task_id,level,level_source,text,asked_at,status,decision_type,type_source) VALUES (?,?,3,'hard_rule','?',?,'open','spec_choice','hard_rule')`, q, f.t, f.T);
  audit(f.db, { actorKind: 'agent', actorId: 'planner', action: 'question_raised', targetType: 'question', targetId: q, payload: { taskId: f.t } });
  const c = check(f.db, f.t, '每次执行都答得出跑在哪');
  eq(c.ok, true, `规划器的提问不算执行：${c.detail}`);
  audit(f.db, { actorKind: 'agent', actorId: 'executor', action: 'question_raised', targetType: 'question', targetId: q, payload: { taskId: f.t } });
  eq(check(f.db, f.t, '每次执行都答得出跑在哪').ok, false, '执行器的提问不在任何沙箱寿命里 → 照样红');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
