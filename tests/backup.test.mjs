// 备份、恢复、完整性检查：
//   ① 备份做完当场核过，核不过的不留；坏文件认得出；
//   ② 保留策略：定期备份按数量删旧的，升级前 / 手动的不动；
//   ③ 恢复演练：备份 → 改动 → 恢复 → 数据回到备份那一刻；恢复前的库另存了且能打开；有进程在写就拒绝；
//   ④ 旧版本的备份恢复回来，用当前代码打开即升级；
//   ⑤ 守护进程的例行维护：到点才做（检查、备份），做过的记进审计，马上再来一拍什么都不做；
//   ⑥ 命令行走一遍：db backup → db restore → db check。
//
// 跑：node tests/backup.test.mjs

import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureOwner, now, backupDb } from '../src/db/db.mjs';
import { backupNow, verifyBackup, listBackups, pruneBackups, restoreFile, checkDb } from '../src/db/backup.mjs';
import { dbMaintenance } from '../src/core/db-maintenance.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);
const TMP = mkdtempSync(join(tmpdir(), 'si-backup-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const marker = (db, v) => db.run(`INSERT INTO audit_log (ts, actor_kind, action, payload) VALUES (?, 'system', 'marker', ?)`, now(), JSON.stringify({ v }));
const markers = (db) => db.all(`SELECT payload FROM audit_log WHERE action='marker' ORDER BY id`).map((r) => JSON.parse(r.payload).v);

section('① 备份当场核过；坏文件认得出');
{
  const p = join(TMP, 'a', 'state.db');
  const db = openDb(p); ensureOwner(db); marker(db, 'x');
  const b = backupNow(db, p, { tag: 'manual' });
  assert(existsSync(b.file) && b.bytes > 0, `备份文件在（${b.bytes} 字节）`);
  eq(verifyBackup(b.file).ok, true, '能以只读打开、integrity_check ok、外键干净');
  assert(!!db.one(`SELECT 1 x FROM audit_log WHERE action='db_backup'`), '记进审计（db_backup）');
  const junk = join(TMP, 'junk.db'); writeFileSync(junk, 'not a database');
  eq(verifyBackup(junk).ok, false, '坏文件：核不过');
  db.close();
}

section('② 保留策略');
{
  const p = join(TMP, 'b', 'state.db');
  const db = openDb(p);
  for (let i = 0; i < 9; i++) {
    const f = backupDb(db, p, 'daily');
    const t = (Date.now() - (9 - i) * 86400_000) / 1000;
    utimesSync(f, t, t);
  }
  backupDb(db, p, 'manual');
  const removed = pruneBackups(p, { daily: 7, weekly: 4 });
  eq(removed.length, 2, '9 份 daily 删掉最旧的 2 份');
  eq(listBackups(p).filter((b) => b.tag === 'daily').length, 7, '留 7 份 daily');
  eq(listBackups(p).filter((b) => b.tag === 'manual').length, 1, '手动备份不动');
  db.close();
}

section('③ 恢复演练');
{
  const p = join(TMP, 'c', 'state.db');
  let db = openDb(p); ensureOwner(db); marker(db, 'before');
  const b = backupNow(db, p, { tag: 'manual' });
  marker(db, 'after');
  db.close();
  let err = null;
  try { restoreFile(p, b.file, { busy: () => '守护进程' }); } catch (e) { err = e; }
  assert(err && /还有进程在用/.test(err.message), '有进程在写就拒绝');
  const r = restoreFile(p, b.file, { busy: () => null });
  db = openDb(p);
  eq(markers(db), ['before'], '数据回到备份那一刻');
  eq(checkDb(db, { full: true }).ok, true, '恢复后 integrity_check 通过');
  db.close();
  const saved = openDb(r.savedCurrentAs);
  eq(markers(saved), ['before', 'after'], '恢复前的库另存了一份、能打开、内容完整（含还在 WAL 里的那一笔）');
  saved.close();
}

section('④ 旧版本的备份恢复回来即升级');
{
  const p = join(TMP, 'd', 'state.db');
  const latest = (() => { const d = openDb(':memory:'); const v = d.raw.prepare('PRAGMA user_version').get().user_version; d.close(); return v; })();
  const old = openDb(join(TMP, 'd-old', 'state.db'), { migrateTo: 20 });
  marker(old, 'old');
  const f = backupDb(old, join(TMP, 'd-old', 'state.db'), 'manual');
  old.close();
  openDb(p).close();
  restoreFile(p, f);
  const db = openDb(p);
  eq([db.raw.prepare('PRAGMA user_version').get().user_version, markers(db)], [latest, ['old']], `v20 的备份恢复后升到 v${latest}，数据还在`);
  db.close();
}

section('⑤ 守护进程的例行维护');
{
  const p = join(TMP, 'e', 'state.db');
  const db = openDb(p); ensureOwner(db);
  const r1 = await dbMaintenance(db, p);
  const what = r1.done.map((d) => d.what);
  assert(['quick_check', 'optimize', 'integrity_check', 'backup', 'backup_weekly'].every((w) => what.includes(w)), `第一拍：检查、优化、备份都做了（${what.join(', ')}）`);
  assert(r1.done.every((d) => d.ok), '都成功');
  const r2 = await dbMaintenance(db, p);
  eq(r2.done.length, 0, '马上再来一拍：都没到点，什么都不做（"上次做是什么时候"从审计里读，重启也不会重做）');
  db.close();
}

section('⑥ 命令行：db backup → db restore → db check');
{
  const p = join(TMP, 'f', 'state.db');
  const db = openDb(p); ensureOwner(db); marker(db, 'cli-before'); db.close();
  const cli = (...a) => spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'src', 'cli.mjs'), ...a, '--db', p], { encoding: 'utf8', env: { ...process.env, SUPERINTERN_HOME: join(TMP, 'f') } });
  const b = cli('db', 'backup');
  assert(b.status === 0, `db backup 成功（${b.stdout.trim().slice(0, 80)}）`, b.stderr);
  const file = listBackups(p).find((x) => x.tag === 'manual')?.file;
  const d2 = openDb(p); marker(d2, 'cli-after'); d2.close();
  const r = cli('db', 'restore', file);
  assert(r.status === 0, `db restore 成功（${r.stdout.trim().slice(0, 80)}）`, r.stderr);
  const d3 = openDb(p);
  eq(markers(d3), ['cli-before'], '恢复回到备份那一刻');
  assert(!!d3.one(`SELECT 1 x FROM audit_log WHERE action='db_restored'`), '恢复记进审计');
  d3.close();
  const c = cli('db', 'check', '--full');
  assert(c.status === 0, `db check --full 通过（${c.stdout.trim()}）`, c.stderr);
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
