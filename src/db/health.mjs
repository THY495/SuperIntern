// 状态库的健康概况：各进程落的观测合起来 + 库文件本身的几个数。
// `cli db stats` 打出来；以后看板的健康卡与守护进程的定期检查用同一份。

import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';

const RECENT_MS = 15 * 60_000;
const KEEP_MS = 24 * 3600_000;   // 每个进程一份文件，编排器一次一个 —— 超过一天的顺手删掉，不然越堆越多

/** 库文件：页数、页大小、空闲页、WAL 文件大小。 */
export function fileStats(db, path) {
  const one = (sql) => Object.values(db.raw.prepare(sql).get() ?? {})[0];
  const size = (p) => { try { return statSync(p).size; } catch { return 0; } };
  return {
    pageCount: one('PRAGMA page_count'), pageSize: one('PRAGMA page_size'), freelist: one('PRAGMA freelist_count'),
    dbBytes: path && path !== ':memory:' ? size(path) : 0, walBytes: path && path !== ':memory:' ? size(`${path}-wal`) : 0,
  };
}

/** 各进程最近一刻钟内落的观测，合起来。 */
export function processMetrics(path, at = Date.now()) {
  const dir = join(dirname(path), 'metrics');
  if (!existsSync(dir)) return { procs: [], lock: { n: 0, totalMs: 0, maxMs: 0 }, busy: 0, slow: [] };
  const procs = [];
  for (const f of readdirSync(dir)) {
    if (!/^db-.*\.json$/.test(f)) continue;
    const p = join(dir, f);
    try { if (at - statSync(p).mtimeMs > KEEP_MS) { unlinkSync(p); continue; } } catch { continue; }
    try { const m = JSON.parse(readFileSync(p, 'utf8')); if (at - m.at <= RECENT_MS) procs.push(m); } catch { /* 写到一半的 */ }
  }
  const lock = procs.reduce((s, m) => ({ n: s.n + m.lock.n, totalMs: s.totalMs + m.lock.totalMs, maxMs: Math.max(s.maxMs, m.lock.maxMs) }), { n: 0, totalMs: 0, maxMs: 0 });
  const busy = procs.reduce((s, m) => s + m.busy, 0);
  const slow = procs.flatMap((m) => m.slow.map((x) => ({ ...x, proc: m.proc, pid: m.pid }))).sort((a, b) => b.ms - a.ms).slice(0, 15);
  return { procs: procs.map((m) => ({ proc: m.proc, pid: m.pid, at: m.at, txCount: m.txCount, busy: m.busy, lock: m.lock })), lock, busy, slow };
}

export function dbHealth(db, path) {
  return { file: fileStats(db, path), processes: processMetrics(path), self: db.metrics?.() ?? null };
}
