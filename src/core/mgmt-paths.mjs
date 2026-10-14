// 系统自己的管理状态在哪：数据目录、状态库、主密钥。执行器能碰到的只有工作区 ——
// 工作区要是恰好是它们的上级目录（`workspace --dir` 指到了数据目录的上一层），任务里的 AI 就能读库、读密钥、改自己的审计。
// 建工作区时拒（workspace.mjs），守护进程定期再核一遍在用的工作区（invariants.mjs 的 executor_paths）。

import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { masterKeyFile } from './credentials.mjs';

/** 规范化：存在的取真实路径（符号链接 / 大小写），Windows 上不分大小写 */
export function normPath(p) {
  let r = resolve(p);
  try { if (existsSync(r)) r = realpathSync.native(r); } catch { /* 取不到就用 resolve 的 */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** 管理状态的几处路径：{ what: 'home'|'db'|'master_key', path } */
export function managementPaths(db, { home = null } = {}) {
  const out = [];
  if (home) out.push({ what: 'home', path: home });
  if (db?.path && db.path !== ':memory:') out.push({ what: 'db', path: db.path });
  const mk = db ? masterKeyFile(db) : null;
  if (mk) out.push({ what: 'master_key', path: mk });
  return out;
}

/** 工作区 ws 罩住了哪几处管理状态（ws 等于它、或是它的上级目录）。空数组 = 没有 */
export function exposedBy(ws, paths) {
  const w = normPath(ws);
  const under = (p) => { const q = normPath(p); return q === w || q.startsWith(w.endsWith(sep) ? w : w + sep); };
  return paths.filter((m) => under(m.path));
}
