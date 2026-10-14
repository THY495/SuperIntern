// 单调时钟与墙钟回拨：
//   ① 秒表单调、带小数；
//   ② 汇报窗口按游标切：墙钟回拨后写进来的事件（时刻比上一份汇报还早）照样进下一份汇报 —— 原来按时刻切就漏了；
//   ③ 时长上限：起点时刻比"现在"还晚（墙钟往回拨了）也不会算出负的时长。
//
// 跑：node tests/clock.test.mjs

import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { stopwatch } from '../src/core/clock.mjs';
import { makeReport, gatherSince } from '../src/agent/reporter.mjs';
import { LIMITS } from '../src/core/limits.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const section = (s) => console.log(`\n── ${s}`);

section('① 秒表');
{
  const sw = stopwatch();
  const a = sw(); const t = Date.now(); while (Date.now() - t < 3) { /* 忙等 3ms */ }
  const b = sw();
  assert(b > a && b >= 2, `单调递增（${a.toFixed(3)} → ${b.toFixed(3)} ms）`);
  assert(!Number.isInteger(b) || b > 0, '带小数（做比较不丢精度）');
}

section('② 汇报窗口按游标切：墙钟回拨也不漏');
{
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), T = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, T - 60_000);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,created_at) VALUES (?,?,'第一步','s','a','pending',?)`, nodeId, taskId, T - 60_000);
  await makeReport(db, { taskId, trigger: 'node_done', triggerRef: nodeId });
  const r1 = db.one(`SELECT created_at, cursor FROM reports WHERE task_id=? ORDER BY rowid DESC LIMIT 1`, taskId);
  assert(r1.cursor && JSON.parse(r1.cursor).audit_log >= 0, '汇报记下了生成那一刻各表的游标');
  // 墙钟往回拨了 30 秒：这之后写进来的事件，时刻比上一份汇报还早
  audit(db, { actorKind: 'system', action: 'node_stalled', targetType: 'node', targetId: nodeId, payload: { why: '回拨之后发生的事' } });
  db.raw.exec('DROP TRIGGER IF EXISTS trg_audit_no_update');   // 仅测试：拨时刻
  db.run(`UPDATE audit_log SET ts=? WHERE id=(SELECT max(id) FROM audit_log)`, r1.created_at - 30_000);
  const byTime = gatherSince(db, taskId, r1.created_at);
  assert(!byTime.nodeTrouble.some((x) => x.action === 'node_stalled'), '（对照）按时刻切：这件事被漏掉了');
  const byCursor = gatherSince(db, taskId, { sinceTs: r1.created_at, cursor: JSON.parse(r1.cursor) });
  assert(byCursor.nodeTrouble.some((x) => x.action === 'node_stalled'), '按游标切：照样进下一份汇报');
  await makeReport(db, { taskId, trigger: 'node_done', triggerRef: nodeId });
  const r2 = db.one(`SELECT body FROM reports WHERE task_id=? ORDER BY rowid DESC LIMIT 1`, taskId);
  assert(/回拨之后发生的事|node_stalled|停滞|卡/.test(r2.body), '第二份汇报正文里提到了它');
  db.close();
}

section('③ 时长上限不会因为墙钟回拨算出负数');
{
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, now());
  const v = LIMITS['limit.runtime_ms'].read(db, taskId, { startedAt: now() + 60_000 });   // 起点在"未来"：墙钟刚往回拨了一分钟
  assert(v >= 0, `不是负数（${v}）`);
  const sw = stopwatch();
  const w = LIMITS['limit.runtime_ms'].read(db, taskId, { elapsed: sw });
  assert(w >= 0 && w < 1000, `编排器传秒表时按秒表算（${w.toFixed(3)} ms）`);
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
