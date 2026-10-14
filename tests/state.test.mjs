// 状态机：
//   ① 代码里的允许表（TRANSITIONS）与库层触发器（v25）一致 —— 两边各写一份，漂了就红；
//   ② 库层守卫：绕过 transition() 的裸 UPDATE 写出不允许的迁移，库直接拦；
//   ③ transition() 的语义：幂等、前置状态不符时抛 / 跳过、同状态照写其它列、每次变化一行审计（带 from / to）；
//   ④ 两个进程抢同一个事项（一个答复、一个撤回）：只有一个成，另一个明确知道被抢了；
//   ⑤ 收口：src/ 里除了 db/ 不许再有改状态的裸 UPDATE（只降不升）。
//
// 跑：node tests/state.test.mjs

import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { TRANSITIONS, transition, transitionWhere, transitionTriggerSql, StaleStateError } from '../src/db/state.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);
// SQLite 存进 sqlite_master 的建表语句会去掉 IF NOT EXISTS
const norm = (sql) => String(sql).replace(/IF NOT EXISTS /i, '').replace(/\s+/g, ' ').trim().replace(/;$/, '');
const TMP = mkdtempSync(join(tmpdir(), 'si-state-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

function fixture(path = ':memory:') {
  const db = openDb(path);
  const { userId } = ensureOwner(db);
  const t = newId('t'), q = newId('q'), T0 = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, t, userId, T0);
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,asked_at,status,decision_type,type_source) VALUES (?,?,3,'hard_rule','?',?,'open','spec_choice','hard_rule')`, q, t, T0);
  return { db, userId, t, q };
}

section('① 代码里的允许表与库层触发器一致');
{
  const { db } = fixture();
  const drift = [];
  for (const table of Object.keys(TRANSITIONS)) {
    const got = db.one(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`, `trg_${table}_transition`)?.sql;
    const want = transitionTriggerSql(table);
    if (!got) drift.push(`${table}：库里没有触发器`);
    else if (norm(got) !== norm(want)) drift.push(`${table}：库里的允许表与 TRANSITIONS 不一致（改了 TRANSITIONS 要配一条新迁移）`);
  }
  assert(drift.length === 0, `${Object.keys(TRANSITIONS).length} 张表的触发器与 TRANSITIONS 逐字一致`, drift.join('\n         '));
  db.close();
}

section('② 库层守卫：裸 UPDATE 写出不允许的迁移被拦');
{
  const { db, t, q } = fixture();
  db.run(`UPDATE questions SET status='answered' WHERE id=?`, q);
  let err = null; try { db.run(`UPDATE questions SET status='open' WHERE id=?`, q); } catch (e) { err = e; }
  assert(err && /illegal status transition/.test(err.message), `答复过的事项改回 open → 库拦下（${err?.message}）`);
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, t);
  err = null; try { db.run(`UPDATE tasks SET status='done' WHERE id=?`, t); } catch (e) { err = e; }
  assert(!!err, '中止的任务不恢复就直接算完成 → 库拦下');
  db.run(`UPDATE tasks SET status='running' WHERE id=?`, t);
  ok('中止 → 恢复（running）照常放行（中止可反悔）');
  db.close();
}

section('③ transition() 的语义');
{
  const { db, userId, t, q } = fixture();
  const audits = () => db.all(`SELECT action, payload FROM audit_log WHERE target_id IN (?, ?) AND action IN ('status_changed','task_done','question_answered_probe') ORDER BY id`, t, q);
  let r = transition(db, 'tasks', t, 'waiting', { reason: '测试' });
  eq([r.changed, r.from], [true, 'running'], '改了、报出原状态');
  let a = audits().at(-1);
  eq([a.action, JSON.parse(a.payload).from, JSON.parse(a.payload).to, JSON.parse(a.payload).reason], ['status_changed', 'running', 'waiting', '测试'], '同事务写一行审计：status_changed，带 from / to / 理由');
  r = transition(db, 'tasks', t, 'waiting');
  eq(r.changed, false, '已经是目标状态 → 什么都不做（幂等）');
  eq(audits().length, 1, '幂等那一次不写审计');
  r = transition(db, 'tasks', t, 'done', { audit: { action: 'task_done', actorKind: 'system', payload: { note: 'x' } } });
  a = audits().at(-1);
  eq([a.action, JSON.parse(a.payload).note, JSON.parse(a.payload).from], ['task_done', 'x', 'waiting'], '调用方可以换审计动作名（例：task_done），from / to 照样并进去');
  let err = null; try { transition(db, 'questions', q, 'answered', { from: ['escalated'] }); } catch (e) { err = e; }
  assert(err instanceof StaleStateError && err.current === 'open', '声明的前置状态不成立 → StaleStateError（别人先改了）');
  r = transition(db, 'questions', q, 'answered', { from: ['escalated'], onMismatch: 'skip' });
  eq([r.changed, r.skipped], [false, true], "onMismatch:'skip' → 静默跳过（原来的 WHERE status=? 条件写法）");
  transition(db, 'questions', q, 'answered', { set: { resolved_at: 123 } });
  eq(db.one(`SELECT status, resolved_at FROM questions WHERE id=?`, q), { status: 'answered', resolved_at: 123 }, '状态与其它列同时写');
  transition(db, 'questions', q, 'answered', { set: { resolved_at: 456 } });
  eq(db.one(`SELECT resolved_at FROM questions WHERE id=?`, q).resolved_at, 456, '状态已经是目标时，其它列照写（与原来的盲写一致）');
  err = null; try { transition(db, 'questions', q, 'open'); } catch (e) { err = e; }
  assert(!!err && !(err instanceof StaleStateError), '不在允许表里的迁移 → 代码层先拦（库层另有一道）');
  // 批量：逐行走、各一条审计
  const t2 = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T2','planning',?)`, t2, userId, now());
  const n = transitionWhere(db, 'tasks', 'id IN (?, ?)', [t, t2], 'aborted');
  eq(n, 2, 'transitionWhere：两行都中止');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='status_changed' AND target_id IN (?, ?) AND payload LIKE '%"to":"aborted"%'`, t, t2).n, 2, '各留一条审计');
  db.close();
}

section('④ 两个进程抢同一个事项：只有一个成');
{
  const p = join(TMP, 'race.db');
  const { db, q } = fixture(p);
  db.close();
  const STATE = new URL('../src/db/state.mjs', import.meta.url).href, DB = new URL('../src/db/db.mjs', import.meta.url).href;
  const race = (to) => `import { openDb } from ${JSON.stringify(DB)}; import { transition } from ${JSON.stringify(STATE)};
    const db = openDb(${JSON.stringify(p)});
    try { const r = transition(db, 'questions', ${JSON.stringify(q)}, '${to}', { from: ['open', 'escalated'] }); console.log(r.changed ? 'WON' : 'NOOP'); }
    catch (e) { console.log(e.stale ? 'STALE' : 'ERR ' + e.message); } db.close();`;
  const a = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', race('answered')], { encoding: 'utf8' });
  const b = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', race('withdrawn')], { encoding: 'utf8' });
  eq([a.stdout.trim(), b.stdout.trim()], ['WON', 'STALE'], '先到的赢；后到的拿到 StaleStateError（不会把"已答复"盖成"已撤回"）');
  const d = openDb(p);
  eq(d.one(`SELECT status FROM questions WHERE id=?`, q).status, 'answered', '库里是先到的那个结论');
  d.close();
}

section('⑤ 收口：src/ 里除了 db/ 没有改状态的裸 UPDATE');
{
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const pth = join(dir, e);
      if (statSync(pth).isDirectory()) { if (e !== 'db') walk(pth); continue; }
      if (!/\.mjs$/.test(e)) continue;
      readFileSync(pth, 'utf8').split('\n').forEach((l, i) => {
        if (/UPDATE (tasks|nodes|questions|projects|revisions|handover_requests|decision_registry) SET [^`]*\bstatus\s*=/.test(l)) offenders.push(`${relative(ROOT, pth)}:${i + 1}`);
      });
    }
  };
  walk(join(ROOT, 'src'));
  assert(offenders.length === 0, '状态只经 db/state.mjs 的 transition() 改', offenders.join('、'));
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
