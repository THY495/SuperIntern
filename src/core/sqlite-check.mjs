// 运行时自带的 SQLite 版本自检。
//
// SQLite 3.7.0–3.51.2 有一个 WAL 重置的数据竞争（sqlite.org/wal.html "the WAL-reset bug"）：WAL 模式下两个以上
// 连接分属不同线程 / 进程、同一瞬间写入或做检查点，极小概率把库写坏。我们的看板、守护进程、每个任务的编排器
// 正是多个进程写同一个库。修复在 3.51.3；3.50.7 与 3.44.6 有回补。node:sqlite 用的是 Node 自带的那份
// SQLite，所以"该不该升级"取决于 Node 的版本 —— 这里只负责说清楚现状，不替人升级。

const FIXED_IN = '3.51.3';
/** 带回补的旧系列：这些系列从给出的补丁号起也算修好了。 */
const BACKPORTS = { '3.50': 7, '3.44': 6 };

const parse = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
const cmp = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };

/** 这个版本是否落在 WAL 重置缺陷的范围内。 */
export function walResetAffected(version) {
  if (cmp(version, '3.7.0') < 0) return false;
  if (cmp(version, FIXED_IN) >= 0) return false;
  const [maj, min, patch] = parse(version);
  const back = BACKPORTS[`${maj}.${min}`];
  return !(back !== undefined && patch >= back);
}

/** 读库句柄上的 SQLite 版本，给出建议；没问题时返回 null。 */
export function sqliteAdvice(db) {
  const version = (db.raw ?? db).prepare('SELECT sqlite_version() AS v').get().v;
  if (!walResetAffected(version)) return null;
  return { version, fixedIn: FIXED_IN, node: process.version, issue: 'wal_reset' };
}
