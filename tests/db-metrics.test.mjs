// 状态库的可观测：语句计次计时、慢语句、等锁、BUSY、跨进程合并、过期观测清理。
//
// 跑：node tests/db-metrics.test.mjs

import { mkdtempSync, rmSync, readdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.mjs';
import { createMetrics } from '../src/db/metrics.mjs';
import { dbHealth, processMetrics } from '../src/db/health.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const section = (s) => console.log(`\n── ${s}`);
const TMP = mkdtempSync(join(tmpdir(), 'si-dbm-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

section('① 语句计次计时、写事务等锁');
{
  const db = openDb(join(TMP, 'a', 'state.db'));
  for (let i = 0; i < 5; i++) db.one(`SELECT count(*) n FROM tasks`);
  db.tx(() => db.run(`INSERT INTO audit_log (ts, actor_kind, action) VALUES (?, 'system', 'probe')`, Date.now()));
  const m = db.metrics();
  const s = m.top.find((x) => x.sql === 'SELECT count(*) n FROM tasks');
  assert(s && s.n === 5, `同一条语句归并计次：${s?.n} 次`);
  assert(m.lock.n >= 1 && m.txCount >= 1, `写事务的拿锁耗时记下了（${m.lock.n} 次，最长 ${m.lock.maxMs} ms）`);
  db.close();
  const files = readdirSync(join(TMP, 'a', 'metrics'));
  assert(files.some((f) => /^db-.*\.json$/.test(f)), `关库时落了一份观测：${files.join(', ')}`);
}

section('② 慢语句与 BUSY');
{
  const m = createMetrics({ slowMs: 0 });
  m.time('SELECT 1', () => 1);
  assert(m.snapshot().slow.length === 1, '超过阈值的进慢语句列表');
  let threw = false;
  try { m.time('UPDATE x', () => { const e = new Error('database is locked'); e.errcode = 5; throw e; }); } catch { threw = true; }
  assert(threw && m.snapshot().busy === 1, 'BUSY 照样抛出去，同时计数');
}

section('②b 按名字计的耗时（守护进程每拍的自检）');
{
  const m = createMetrics();
  for (const ms of [3, 8, 12, 15, 300]) m.timing('invariants_sweep', ms);
  const t = m.snapshot().timings.invariants_sweep;
  assert(t.n === 5 && t.maxMs === 300 && t.totalMs === 338, `次数、合计、最长：${t.n} / ${t.totalMs} / ${t.maxMs}`);
  const at = (le) => t.hist[t.buckets.indexOf(le)];
  assert(at(5) === 1 && at(10) === 1 && at(20) === 2 && at(500) === 1, `分桶（中位数据此估：第 3 个落在 ≤20 ms）：${t.hist.join(',')}`);
  const db = openDb(join(TMP, 'c', 'state.db'));
  db.timing('x', 1);
  assert(db.metrics().timings.x?.n === 1, '库句柄上直接可用（守护进程用它）');
  db.close();
}

section('③ 两个进程写同一个库：观测按进程落、合起来看');
{
  const p = join(TMP, 'b', 'state.db');
  openDb(p).close();
  const DB = new URL('../src/db/db.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `import { openDb } from ${JSON.stringify(DB)}; const db = openDb(${JSON.stringify(p)}); for (let i = 0; i < 3; i++) db.tx(() => db.run("INSERT INTO audit_log (ts, actor_kind, action) VALUES (?, 'system', 'child')", Date.now())); db.close();`],
  { encoding: 'utf8', env: { ...process.env, SUPERINTERN_PROC: 'daemon' } });
  assert(child.status === 0, '子进程正常写完', child.stderr);
  const db = openDb(p);
  db.tx(() => db.run(`INSERT INTO audit_log (ts, actor_kind, action) VALUES (?, 'system', 'parent')`, Date.now()));
  db.close();
  const h = processMetrics(p);
  assert(h.procs.some((x) => x.proc === 'daemon' && x.lock.n >= 3), `子进程那份按进程种类落了（daemon，写事务 ${h.procs.find((x) => x.proc === 'daemon')?.lock.n} 次）`);
  assert(h.lock.n >= 4, `合起来看：写事务 ${h.lock.n} 次`);
  const db2 = openDb(p);
  const full = dbHealth(db2, p);
  assert(full.file.pageCount > 0 && full.file.pageSize > 0, `库文件的页数 / 页大小（${full.file.pageCount} × ${full.file.pageSize}）`);
  db2.close();
}

section('④ 超过一天的观测文件顺手删掉');
{
  const dir = join(TMP, 'b', 'metrics');
  const old = join(dir, 'db-run-1.json');
  writeFileSync(old, JSON.stringify({ pid: 1, proc: 'run', at: 0, txCount: 0, busy: 0, lock: { n: 0, totalMs: 0, maxMs: 0 }, slow: [] }));
  const t = (Date.now() - 2 * 86400_000) / 1000;
  utimesSync(old, t, t);
  processMetrics(join(TMP, 'b', 'state.db'));
  assert(!existsSync(old), '两天前的那份被清掉了');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
