// 守护进程的日常清理。每天一次（"上次做是何时"从审计读，重启 / 两个守护进程都不重做）：
//   · 日志：`.superintern/logs/` 下的任务日志（<task>-<时刻>.log）与 JSON 行日志（jsonl/）超过 deploy.log_keep_days 天的删掉；
//     daemon.log 是计划任务 / systemd 重定向进来的，进程拿着它改不了名 —— 超过 10 MB 就"复制一份再截断"
//     （写入方是追加模式打开的，截断后接着写在新的末尾，不会出现空洞）；
//   · 工作区依赖目录：已合并或已归档、没有进程在跑的任务，删掉工作区里的 node_modules / .venv 等（一份装过依赖的工作区
//     可达几个 GB，绝大部分是依赖）。依赖能由锁文件重建：任务被重新打开时执行器会重新安装。删了什么、腾出多少，记审计。

import { readdirSync, statSync, rmSync, existsSync, copyFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { now, audit } from '../db/db.mjs';
import { leaseOf } from '../db/lease.mjs';
import { idemPrune } from '../db/idempotency.mjs';
import { pruneReservations } from './spend.mjs';
import { getSetting } from './settings.mjs';
import { findDepDirs, removeDepDir } from './workspace.mjs';

const DAY = 24 * 3600_000;
export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** 删超过 keepDays 天没动过的日志文件。返回删掉的文件名。 */
export function pruneLogs(home, { keepDays = 14, at = Date.now() } = {}) {
  const removed = [];
  const logs = join(home, 'logs');
  for (const [dir, re] of [[logs, /^.+-\d{4}-\d{2}-\d{2}T[\d-]+Z\.log$/], [join(logs, 'jsonl'), /\.jsonl$/]]) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!re.test(n)) continue;
      const p = join(dir, n);
      try { if (at - statSync(p).mtimeMs > keepDays * DAY) { rmSync(p, { force: true }); removed.push(n); } } catch { /* 正在被删 / 没权限：下次再说 */ }
    }
  }
  return removed;
}

/** daemon.log 超过上限：复制成 daemon.log.1（覆盖上一份），原文件截断为 0。 */
export function rotateDaemonLog(home, { maxBytes = DAEMON_LOG_MAX_BYTES } = {}) {
  const p = join(home, 'logs', 'daemon.log');
  let size;
  try { size = statSync(p).size; } catch { return null; }
  if (size <= maxBytes) return null;
  copyFileSync(p, `${p}.1`);
  truncateSync(p, 0);
  return { bytes: size };
}

const sizeOf = (p) => {
  let n = 0;
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const q = join(d, e.name);
      if (e.isDirectory()) walk(q);
      else { try { n += statSync(q).size; } catch { /* 读不了的符号链接 */ } }
    }
  };
  walk(p);
  return n;
};

/** 已合并 / 已归档、没有活着的编排器的任务：删工作区里的依赖目录。 */
export function cleanMergedDeps(db, home, { at = now() } = {}) {
  const root = join(home, 'workspaces');
  if (!existsSync(root)) return [];
  const out = [];
  for (const taskId of readdirSync(root)) {
    const t = db.one(`SELECT merged_at, archived_at FROM tasks WHERE id=?`, taskId);
    if (!t || (t.merged_at == null && t.archived_at == null)) continue;
    if (leaseOf(db, `task:${taskId}`, at)?.live) continue;   // 有进程在跑（被重新打开了）：不动
    const ws = join(root, taskId);
    const dirs = findDepDirs(ws);
    if (!dirs.length) continue;
    const done = [], failed = [];
    let bytes = 0;
    for (const rel of dirs) {
      const b = sizeOf(join(ws, rel));
      try { removeDepDir(ws, rel); done.push(rel); bytes += b; } catch (e) { failed.push({ dir: rel, error: String(e.message).slice(0, 200) }); }
    }
    audit(db, { actorKind: 'system', actorId: 'daemon', action: 'workspace_deps_cleaned', targetType: 'task', targetId: taskId,
      payload: { dirs: done, bytes, failed, why: t.merged_at != null ? 'merged' : 'archived' } });
    out.push({ taskId, dirs: done, bytes, failed });
  }
  return out;
}

/** 每天一次。返回做了什么（没到点就是 { skipped: 'not_due' }）。 */
export function housekeeping(db, home, { at = now(), onEvent = () => {} } = {}) {
  if (!home) return { skipped: 'no_home' };
  const last = db.one(`SELECT ts FROM audit_log WHERE action='housekeeping_done' ORDER BY id DESC LIMIT 1`)?.ts ?? 0;
  if (at - last < DAY) return { skipped: 'not_due' };
  const r = { logsRemoved: [], daemonLog: null, deps: [], errors: [] };
  try { r.logsRemoved = pruneLogs(home, { keepDays: Number(getSetting(db, 'deploy.log_keep_days')), at }); } catch (e) { r.errors.push(`logs: ${e.message}`); }
  try { r.daemonLog = rotateDaemonLog(home); } catch (e) { r.errors.push(`daemon.log: ${e.message}`); }
  try { r.idempotencyPruned = idemPrune(db, { at }); } catch (e) { r.errors.push(`idempotency: ${e.message}`); }   // 一天前的幂等键
  try { r.reservationsPruned = pruneReservations(db, { at }); } catch (e) { r.errors.push(`reservations: ${e.message}`); }   // 过期的预占（进程死了留下的）
  if (getSetting(db, 'deploy.clean_merged_deps')) {
    try { r.deps = cleanMergedDeps(db, home, { at }); } catch (e) { r.errors.push(`deps: ${e.message}`); }
  }
  audit(db, { actorKind: 'system', actorId: 'daemon', action: 'housekeeping_done', targetType: 'deployment',
    payload: { logsRemoved: r.logsRemoved.length, daemonLogRotated: r.daemonLog?.bytes ?? null, idempotencyPruned: r.idempotencyPruned ?? 0,
      depsTasks: r.deps.length, depsBytes: r.deps.reduce((a, d) => a + d.bytes, 0), errors: r.errors } });
  onEvent({ type: 'housekeeping', ...r });
  return r;
}
