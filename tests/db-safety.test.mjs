// 状态库的并发与升级安全：
//   ① 多进程写同一库：撞上别人的写锁要等，不能当场 `database is locked` 崩掉（0.3.0 四跑与 v9 日志里 9 个编排器进程这样崩过）；
//   ② tx 默认先拿写锁：两个进程同时"读 → 改 → 写"同一行，结果不丢更新；
//   ③ 已有的库升级前自动备份，备份能直接打开；
//   ④ 迁移失败：版本号不动（与迁移同一事务），库还能用旧代码打开；新库不备份。
//
// 跑：node tests/db-safety.test.mjs

import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, ensureOwner, newId, now, MIGRATIONS } from '../src/db/db.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-dbsafe-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const DBMOD = new URL('../src/db/db.mjs', import.meta.url).href;

/** 另起一个进程跑一段脚本（拿到 db 句柄），返回 { done: Promise<{code, out}> , ready: Promise } —— 打印 READY 即就绪。 */
function child(dbPath, body) {
  const src = `import { openDb } from ${JSON.stringify(DBMOD)};
const db = openDb(${JSON.stringify(dbPath)});
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
${body}
db.close();`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let readyRes; const ready = new Promise((r) => { readyRes = r; });
  p.stdout.on('data', (d) => { out += d; if (out.includes('READY')) readyRes(); });
  p.stderr.on('data', (d) => { out += d; });
  const done = new Promise((r) => p.on('exit', (code) => { readyRes(); r({ code, out }); }));
  return { ready, done };
}

function taskFixture(db) {
  const { userId } = ensureOwner(db);
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,?,?,?)`, id, userId, 'x', 'running', now());
  return { userId, taskId: id };
}

section('1. 别的进程拿着写锁时，这边的写要等，不当场崩');
{
  const path = join(TMP, 'lock.db');
  const db = openDb(path);
  const { taskId } = taskFixture(db);
  // 子进程开写事务、拿着锁睡 1.5 s 再提交
  const c = child(path, `db.raw.exec('BEGIN IMMEDIATE'); db.run("UPDATE tasks SET title='child' WHERE id=?", ${JSON.stringify(taskId)}); console.log('READY'); sleep(1500); db.raw.exec('COMMIT');`);
  await c.ready;
  const t0 = Date.now();
  let err = null;
  try { db.tx(() => db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId)); } catch (e) { err = e; }
  const waited = Date.now() - t0;
  assert(!err, `等到锁释放后写成功（${err ? err.message : `等了 ${waited} ms`}）`);
  assert(waited >= 800, '确实等了（不是没撞上锁）');
  // 事务外的单条写同样要等
  const c2 = child(path, `db.raw.exec('BEGIN IMMEDIATE'); console.log('READY'); sleep(1000); db.raw.exec('COMMIT');`);
  await c2.ready;
  err = null;
  try { db.run(`UPDATE tasks SET title='parent' WHERE id=?`, taskId); } catch (e) { err = e; }
  assert(!err, `事务外的单条写也等到了（${err?.message ?? 'ok'}）`);
  const r = await c.done; await c2.done;
  eq(r.code, 0, '子进程正常退出');
  eq(db.one(`SELECT title, status FROM tasks WHERE id=?`, taskId), { title: 'parent', status: 'waiting' }, '两边的写都在');
  db.close();
}

section('2. tx 默认先拿写锁：两个进程同时"读 → 加一 → 写"，不丢更新');
{
  const path = join(TMP, 'counter.db');
  const db = openDb(path);
  ensureOwner(db);
  db.raw.exec("CREATE TABLE ctr (id TEXT PRIMARY KEY, value TEXT); INSERT INTO ctr VALUES ('p_ctr', '0')");
  db.close();
  const N = 40;
  const body = `for (let i = 0; i < ${N}; i++) db.tx(() => { const v = Number(db.one("SELECT value FROM ctr WHERE id='p_ctr'").value); sleep(2); db.run("UPDATE ctr SET value=? WHERE id='p_ctr'", String(v + 1)); }); console.log('READY');`;
  const a = child(path, body), b = child(path, body);
  const [ra, rb] = await Promise.all([a.done, b.done]);
  eq([ra.code, rb.code], [0, 0], `两个进程都跑完（${(ra.out + rb.out).match(/Error[^\n]*/)?.[0] ?? '无报错'}）`);
  const db2 = openDb(path);
  eq(db2.one(`SELECT value FROM ctr WHERE id='p_ctr'`).value, String(2 * N), `计数 = ${2 * N}（没有丢更新）`);
  db2.close();
}

section('3. 已有的库升级前自动备份；备份能直接打开');
{
  const path = join(TMP, 'old.db');
  const db = openDb(path);
  const { taskId } = taskFixture(db);
  const latest = db.raw.prepare('PRAGMA user_version').get().user_version;
  db.raw.exec(`PRAGMA user_version = ${latest - 1}`);   // 假装是上一版建的库（最后一条迁移是幂等的）
  db.close();
  const db2 = openDb(path);
  eq(db2.raw.prepare('PRAGMA user_version').get().user_version, latest, '迁到了最新版');
  db2.close();
  const backups = existsSync(join(TMP, 'backups')) ? readdirSync(join(TMP, 'backups')) : [];
  eq(backups.length, 1, `备份了一份（${backups.join(', ')}）`);
  assert(/^state-pre-v\d+-.+\.db$/.test(backups[0] ?? ''), '文件名写明是哪一版升级前的');
  const bk = new DatabaseSync(join(TMP, 'backups', backups[0]), { readOnly: true });
  eq(bk.prepare('SELECT count(*) n FROM tasks WHERE id=?').get(taskId).n, 1, '备份里有原来的数据');
  eq(bk.prepare('PRAGMA user_version').get().user_version, latest - 1, '备份是升级前的版本');
  bk.close();
  // 新库：不备份（没有要保护的东西）
  const fresh = join(TMP, 'fresh', 'state.db');
  openDb(fresh).close();
  assert(!existsSync(join(TMP, 'fresh', 'backups')), '新建的库不产生备份');
}

section('4. 迁移失败：版本号不动、半截改动回滚');
{
  const path = join(TMP, 'broken.db');
  openDb(path).close();
  // 把版本拨回 1 → 第 1→2 条迁移会 CREATE TABLE briefings，而表已经在 → 失败
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 1');
  raw.exec('CREATE TABLE marker_should_survive (x)');
  raw.close();
  let err = null;
  try { openDb(path); } catch (e) { err = e; }
  assert(err && /already exists/.test(err.message), `迁移报错抛出来了（${err?.message}）`);
  const raw2 = new DatabaseSync(path, { readOnly: true });
  eq(raw2.prepare('PRAGMA user_version').get().user_version, 1, '版本号仍是 1（没有被单独写上去）');
  eq(raw2.prepare(`SELECT count(*) n FROM sqlite_master WHERE name='marker_should_survive'`).get().n, 1, '原有内容没被动');
  raw2.close();
  const bk = readdirSync(join(TMP, 'backups')).filter((f) => f.startsWith('state-pre-v1-'));
  eq(bk.length, 1, '失败前已经备份过');
}

section('4b. 迁移写出外键违例：整步回滚，版本号不动（迁移期间外键是关着的，不核就会悄悄写坏引用）');
{
  const path = join(TMP, 'fk.db');
  const d0 = openDb(path);
  const { userId } = ensureOwner(d0);
  d0.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES ('t_fk',?,'x','running',?)`, userId, now());
  // 老库里原本就有一条违例（直接写进去的）：它不该让以后的升级卡死
  d0.raw.exec(`PRAGMA foreign_keys = OFF; INSERT INTO nodes (id,task_id,title,spec,acceptance,status,created_at) VALUES ('n_orphan','t_missing','x','s','a','pending',1); PRAGMA foreign_keys = ON;`);
  const v0 = d0.raw.prepare('PRAGMA user_version').get().user_version;
  d0.close();
  MIGRATIONS.push((raw) => raw.exec(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,created_at) VALUES ('n_bad','t_nowhere','x','s','a','pending',1)`));
  let err = null;
  try { openDb(path).close(); } catch (e) { err = e; }
  MIGRATIONS.pop();
  assert(err && /外键违例/.test(err.message), `迁移新写出的违例被拦下（${String(err?.message).slice(0, 60)}…）`);
  const raw = new DatabaseSync(path, { readOnly: true });
  eq(raw.prepare('PRAGMA user_version').get().user_version, v0, '版本号没动');
  eq(raw.prepare(`SELECT count(*) n FROM nodes WHERE id='n_bad'`).get().n, 0, '那一行回滚掉了');
  raw.close();
  // 只有老违例、迁移本身干净 → 照常升级
  MIGRATIONS.push((raw) => raw.exec(`CREATE TABLE IF NOT EXISTS probe_fk_ok (x)`));
  let ok2 = true; try { openDb(path).close(); } catch { ok2 = false; }
  MIGRATIONS.pop();
  assert(ok2, '库里原本就有的违例不挡升级（那要人去看，不是迁移能修的）');
}

section('5. 同一任务同时只能有一个编排器');
{
  const { orchestrate } = await import('../src/core/orchestrator.mjs');
  const { audit } = await import('../src/db/db.mjs');
  const db = openDb(join(TMP, 'orch.db'));
  const { taskId } = taskFixture(db);
  const nodeId = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES (?,?,'s','s','a','running','normal','standard',?)`, nodeId, taskId, now());
  // 另一个活着的进程"正在跑"这个任务：起了、没退
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  audit(db, { actorKind: 'system', action: 'orchestrator_started', targetType: 'task', targetId: taskId, payload: { pid: other.pid } });
  const starts = () => db.one(`SELECT count(*) n FROM audit_log WHERE action='orchestrator_started' AND target_id=?`, taskId).n;
  const call = () => orchestrate(db, { taskId, workspace: TMP, narrativeDir: join(TMP, 'nar'), makeClient: () => { throw new Error('不该走到要模型这一步'); }, maxCycles: 1, commit: false, verify: false }).then(() => null, (e) => e);
  let e = await call();
  assert(e && /已有编排器在跑/.test(e.message), `别人还活着 → 拒绝开跑（${e?.message?.slice(0, 40)}…）`);
  eq(starts(), 1, '没有记第二条开跑');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, nodeId).status, 'running', '别人正在干的节点没被认领走');
  other.kill();
  await new Promise((r) => other.on('exit', r));
  e = await call();
  assert(!e || !/已有编排器在跑/.test(e.message), '那个进程死了 → 不再拦（照常认领、开跑）');
  eq(starts(), 2, '这次记了开跑');
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n状态库并发与升级安全：${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
