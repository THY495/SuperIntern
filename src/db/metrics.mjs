// 状态库的可观测。看板、守护进程、每个编排器是不同进程，写同一个库 —— 等锁、慢语句、BUSY
// 原来全都看不见（9 次 database is locked 崩溃是翻日志才找到的）。这里在 db 句柄上计：
//   · 每条语句（按 SQL 文本归并，不记参数）的次数、总耗时、最长一次；
//   · 慢语句（默认 ≥100 ms）最近 50 条；
//   · 写事务拿写锁等了多久（BEGIN IMMEDIATE 的耗时）；SQLITE_BUSY 撞了几次。
// 每个进程每分钟把自己的那份写到 <库目录>/metrics/db-<进程种类>-<pid>.json，退出时再写一次；
// `cli db stats` 把各进程的合起来看（另带 WAL 大小、页数、空闲页）。
// 设了 SUPERINTERN_RECORD_SQL=<文件> 时，进程退出时把全部语句的计数追加进那个文件（开发用：找热查询定索引）。

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

export const SLOW_MS = 100;
/** timing() 的分桶上界（毫秒）；超过最后一个的落进末尾那一桶。 */
export const TIMING_BUCKETS = [5, 10, 20, 50, 100, 200, 500, 1000, 5000];
const MAX_DISTINCT = 2000;

const normSql = (sql) => String(sql).replace(/\s+/g, ' ').trim().slice(0, 400);

export function createMetrics({ path = null, procKind = () => 'cli', slowMs = SLOW_MS } = {}) {
  const stmts = new Map();     // sql → { n, ms, max }
  const slow = [];             // 最近 50 条 { sql, ms, at }
  const lock = { n: 0, totalMs: 0, maxMs: 0 };
  let busy = 0, txCount = 0;
  const timings = new Map();   // 名字 → { n, totalMs, maxMs, hist }（hist 按 TIMING_BUCKETS 分桶，最后一桶是更大的）
  const startedAt = Date.now();

  const m = {
    /** 包一次语句执行：计时、计数、BUSY 计数，异常原样抛。 */
    time(sql, fn) {
      const t0 = performance.now();
      try { return fn(); }
      catch (e) { if (e?.errcode === 5 || /SQLITE_BUSY|database is locked/i.test(String(e?.message))) busy++; throw e; }
      finally {
        const ms = performance.now() - t0;
        const k = normSql(sql);
        let s = stmts.get(k);
        if (!s && stmts.size < MAX_DISTINCT) { s = { n: 0, ms: 0, max: 0 }; stmts.set(k, s); }
        if (s) { s.n++; s.ms += ms; if (ms > s.max) s.max = ms; }
        if (ms >= slowMs) { slow.push({ sql: k, ms: Math.round(ms), at: Date.now() }); if (slow.length > 50) slow.shift(); }
      }
    },
    /** 一件事花了多久（例如守护进程每拍的自检）：按名字计，进 metrics 文件，事后能算中位数和最长。 */
    timing(name, ms) {
      let t = timings.get(name);
      if (!t) { if (timings.size >= 50) return; t = { n: 0, totalMs: 0, maxMs: 0, hist: Array(TIMING_BUCKETS.length + 1).fill(0) }; timings.set(name, t); }
      t.n++; t.totalMs += ms; if (ms > t.maxMs) t.maxMs = ms;
      const k = TIMING_BUCKETS.findIndex((b) => ms <= b);
      t.hist[k < 0 ? TIMING_BUCKETS.length : k]++;
    },
    /** 写事务拿锁的耗时。 */
    lockWait(ms) { txCount++; lock.n++; lock.totalMs += ms; if (ms > lock.maxMs) lock.maxMs = ms; },
    snapshot() {
      const top = [...stmts.entries()].map(([sql, s]) => ({ sql, n: s.n, ms: Math.round(s.ms), max: Math.round(s.max) }))
        .sort((a, b) => b.ms - a.ms).slice(0, 40);
      return { pid: process.pid, proc: procKind(), startedAt, at: Date.now(), txCount, busy,
        lock: { n: lock.n, totalMs: Math.round(lock.totalMs), maxMs: Math.round(lock.maxMs) }, slow: [...slow], top,
        timings: Object.fromEntries([...timings].map(([k, t]) => [k, { n: t.n, totalMs: Math.round(t.totalMs), maxMs: Math.round(t.maxMs), buckets: TIMING_BUCKETS, hist: [...t.hist] }])) };
    },
    /** 写到 <库目录>/metrics/；:memory: 不写。 */
    flush() {
      if (!path || path === ':memory:') return;
      try {
        const dir = join(dirname(path), 'metrics');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `db-${procKind().replace(/[^a-z0-9-]/gi, '_')}-${process.pid}.json`), JSON.stringify(m.snapshot()));
      } catch { /* 观测写不出来不该影响正事 */ }
    },
    /** 开发用：全部语句计数追加到文件（制表符分隔：次数、总毫秒、最长毫秒、SQL）。 */
    dumpCensus(file) {
      try { appendFileSync(file, [...stmts.entries()].map(([sql, s]) => `${s.n}\t${s.ms.toFixed(1)}\t${s.max.toFixed(1)}\t${sql}`).join('\n') + '\n'); } catch { /* 同上 */ }
    },
  };
  return m;
}
