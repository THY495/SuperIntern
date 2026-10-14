// 备份、恢复、完整性检查。
//
// 全部状态（审计轨、花费账本、交接记录、决定……）只在一个 state.db 里。原来只有"升级前自动备份"一种，
// 没有定期备份、没有恢复命令、没人验过备份能不能用（GitLab 2017 的教训：没验证过的备份等于没有）。
//   · backupNow：VACUUM INTO（不用 node:sqlite 的 backup()：别的连接一写它就从头再来，多进程下可能永远做不完）；
//     做完立刻以只读打开核一遍（integrity_check、版本号），核不过就删掉并报错 —— 不留一份坏备份冒充好的；
//   · prune：按保留策略删旧的（默认最近 7 份 daily + 4 份 weekly；升级前自动备份与手动备份不动）；
//   · restore：先确认没有进程在写这个库（租约 / 守护进程心跳），把当前库另存一份，再换上备份，最后用当前代码打开
//     （备份来自旧版本时顺带升级）；
//   · checkDb：quick_check / integrity_check + foreign_key_check。

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, unlinkSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { backupDb, now, audit } from './db.mjs';
import { I18nError } from '../i18n/index.mjs';

export const RETENTION = { daily: 7, weekly: 4 };

const backupsDir = (path) => join(dirname(path), 'backups');

/** 以只读打开一份库，核完整性与版本号。返回 { ok, version, integrity, fk }。 */
export function verifyBackup(file) {
  let d;
  try {
    d = new DatabaseSync(file, { readOnly: true });
    const integrity = d.prepare('PRAGMA integrity_check').get().integrity_check;
    const fk = d.prepare('PRAGMA foreign_key_check').all().length;
    const version = d.prepare('PRAGMA user_version').get().user_version;
    const hasTasks = !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'`).get();
    return { ok: integrity === 'ok' && fk === 0 && hasTasks, version, integrity, fk };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  } finally { try { d?.close(); } catch { /* 已关 */ } }
}

/** 做一份备份并核过。tag：daily / weekly / manual / pre-restore …。核不过就删掉并抛错。 */
export function backupNow(db, path, { tag = 'manual', at = now(), actorKind = 'system', actorId = null } = {}) {
  if (!path || path === ':memory:') throw new I18nError('内存库没有可备份的文件');
  const file = backupDb(db, path, tag);
  const v = verifyBackup(file);
  const bytes = (() => { try { return statSync(file).size; } catch { return 0; } })();
  if (!v.ok) {
    try { unlinkSync(file); } catch { /* 删不掉也照样报错 */ }
    audit(db, { actorKind, actorId, action: 'db_backup_failed', targetType: 'deployment', targetId: 'db', payload: { tag, verify: v } });
    throw new I18nError('备份做出来了但核不过（{why}），已删掉', { why: v.error ?? v.integrity ?? `外键问题 ${v.fk}` });
  }
  audit(db, { actorKind, actorId, action: 'db_backup', targetType: 'deployment', targetId: 'db', payload: { tag, file: basename(file), bytes, version: v.version } });
  return { file, bytes, version: v.version, at };
}

/** 备份目录里的文件：[{ file, tag, mtime }]，新的在前。 */
export function listBackups(path) {
  const dir = backupsDir(path);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^state-.*\.db$/.test(f))
    .map((f) => { const m = /^state-(.+?)-\d{4}-\d{2}-\d{2}T/.exec(f); return { file: join(dir, f), name: f, tag: m?.[1] ?? '?', mtime: statSync(join(dir, f)).mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime);
}

/** 按保留策略删旧的定期备份（daily / weekly）；其它种类（升级前、手动、恢复前）不动。返回删了哪些。 */
export function pruneBackups(path, retention = RETENTION) {
  const removed = [];
  for (const [tag, keep] of Object.entries(retention)) {
    for (const b of listBackups(path).filter((x) => x.tag === tag).slice(keep)) {
      try { unlinkSync(b.file); removed.push(b.name); } catch { /* 删不掉下次再删 */ }
    }
  }
  return removed;
}

/** 完整性检查：quick（O(N)，不核索引内容）或 full（integrity_check）+ foreign_key_check。结果进审计。 */
export function checkDb(db, { full = false, at = now() } = {}) {
  const pragma = full ? 'PRAGMA integrity_check' : 'PRAGMA quick_check';
  const rows = db.raw.prepare(pragma).all().map((r) => Object.values(r)[0]);
  const fk = db.raw.prepare('PRAGMA foreign_key_check').all();
  const ok = rows.length === 1 && rows[0] === 'ok' && fk.length === 0;
  audit(db, { actorKind: 'system', action: ok ? 'db_check_ok' : 'db_check_failed', targetType: 'deployment', targetId: 'db',
    payload: { kind: full ? 'integrity' : 'quick', problems: ok ? [] : rows.filter((x) => x !== 'ok').slice(0, 20), fk: fk.slice(0, 20), at } });
  return { ok, kind: full ? 'integrity' : 'quick', problems: rows.filter((x) => x !== 'ok'), fk };
}

/**
 * 用一份备份替换当前库。调用方保证当前库已经关掉（本函数只动文件）。
 * busy：一个返回"还有谁在写"的函数（租约 / 守护进程心跳）—— 有人在写就拒绝，除非 force。
 * 返回 { restoredFrom, savedCurrentAs }。
 */
export function restoreFile(path, backupFile, { busy = () => null, force = false } = {}) {
  const v = verifyBackup(backupFile);
  if (!v.ok) throw new I18nError('这份备份核不过（{why}），不恢复', { why: v.error ?? v.integrity ?? `外键问题 ${v.fk}` });
  const who = busy();
  if (who && !force) throw new I18nError('还有进程在用这个库（{who}）：先停掉看板 / 守护进程 / 在跑的任务，或加 --force', { who });
  mkdirSync(backupsDir(path), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const saved = join(backupsDir(path), `state-pre-restore-${stamp}.db`);
  if (existsSync(path)) {
    // 当前库另存一份：只拷主文件会丢掉还在 WAL 里、没检查点进主文件的提交 —— 用 VACUUM INTO 拿一致的快照；
    // 当前库已经坏到打不开时，退回原样拷文件（连 -wal / -shm 一起，留给人去救）
    try { const d = new DatabaseSync(path); d.exec(`VACUUM INTO '${saved.replace(/'/g, "''")}'`); d.close(); }
    catch { copyFileSync(path, saved); for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) copyFileSync(path + ext, saved + ext); }
  }
  for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) unlinkSync(path + ext);   // 旧库的 WAL 不能留给备份去"重放"
  copyFileSync(backupFile, path);
  return { restoredFrom: backupFile, savedCurrentAs: existsSync(saved) ? saved : null, version: v.version };
}
