// 守护进程的状态库例行维护。每一拍调一次，到点的才做：
//   · 每小时：quick_check（O(N)，不核索引内容）、PRAGMA optimize（统计信息过时会让查询计划变差）；
//   · 每天：integrity_check + foreign_key_check；
//   · 每 backup_every_hours 小时（部署设置，默认 24，0 = 关）：做一份 daily 备份并核过；每 7 天另做一份 weekly；删超出保留数的旧备份；
//   · WAL 超过 64 MB：试一次 TRUNCATE 检查点（有长读者时会做不完，那就下一拍再试）。
// "上次做是什么时候"从审计里读，不放内存 —— 守护进程重启、两个守护进程同时在跑，都不会重复做或漏做。

import { statSync } from 'node:fs';
import { now } from '../db/db.mjs';
import { backupNow, pruneBackups, checkDb } from '../db/backup.mjs';
import { getSetting } from './settings.mjs';

const H = 3600_000;
export const WAL_CHECKPOINT_BYTES = 64 * 1024 * 1024;

const lastAudit = (db, action, where = '') => db.one(`SELECT ts FROM audit_log WHERE action=? ${where} ORDER BY id DESC LIMIT 1`, action)?.ts ?? 0;

export async function dbMaintenance(db, path, { at = now(), onEvent = () => {} } = {}) {
  if (!path || path === ':memory:') return { skipped: 'memory' };
  const done = [];
  const lastCheck = (kind) => Math.max(lastAudit(db, 'db_check_ok', `AND json_extract(payload,'$.kind')='${kind}'`), lastAudit(db, 'db_check_failed', `AND json_extract(payload,'$.kind')='${kind}'`));
  if (at - lastCheck('quick') >= H) {
    const r = checkDb(db, { full: false, at });
    done.push({ what: 'quick_check', ok: r.ok });
    try { db.raw.exec('PRAGMA optimize'); done.push({ what: 'optimize', ok: true }); } catch (e) { done.push({ what: 'optimize', ok: false, error: e.message }); }
  }
  if (at - lastCheck('integrity') >= 24 * H) { const r = checkDb(db, { full: true, at }); done.push({ what: 'integrity_check', ok: r.ok }); }
  const every = Number(getSetting(db, 'deploy.backup_every_hours'));
  if (every > 0) {
    const lastDaily = lastAudit(db, 'db_backup', `AND json_extract(payload,'$.tag')='daily'`);
    if (at - lastDaily >= every * H) {
      try { const b = backupNow(db, path, { tag: 'daily', at }); done.push({ what: 'backup', ok: true, file: b.file }); }
      catch (e) { done.push({ what: 'backup', ok: false, error: e.message }); }
      const lastWeekly = lastAudit(db, 'db_backup', `AND json_extract(payload,'$.tag')='weekly'`);
      if (at - lastWeekly >= 7 * 24 * H) {
        try { const b = backupNow(db, path, { tag: 'weekly', at }); done.push({ what: 'backup_weekly', ok: true, file: b.file }); }
        catch (e) { done.push({ what: 'backup_weekly', ok: false, error: e.message }); }
      }
      const removed = pruneBackups(path);
      if (removed.length) done.push({ what: 'prune', ok: true, removed });
    }
  }
  const wal = (() => { try { return statSync(`${path}-wal`).size; } catch { return 0; } })();
  if (wal > WAL_CHECKPOINT_BYTES) {
    try { const r = db.raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); done.push({ what: 'wal_checkpoint', ok: r.busy === 0, walBytes: wal }); }
    catch (e) { done.push({ what: 'wal_checkpoint', ok: false, error: e.message }); }
  }
  for (const d of done) onEvent({ type: 'db_maintenance', ...d });
  return { done };
}
