// faults.test.mjs ⑥ 的子进程：用一个"起不来"的 spawnFn 拉起任务，看本进程（= 守护进程）活不活得下来、描述符关没关。
// 输出一行 JSON：{ alive, fdOpen, audit }。
import { fstatSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { makeLauncher } from '../src/core/launcher.mjs';

const [home, mode] = process.argv.slice(2);
const db = openDb(':memory:');
const { userId } = ensureOwner(db);
const taskId = newId('t');
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'x','running',?)`, taskId, userId, now());
let fd = null;
const spawnFn = (exe, args, opts) => {
  fd = opts.stdio[1];
  if (mode === 'throw') throw Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
  return spawn('si-definitely-not-a-binary', args, opts);   // 异步发 'error'（ENOENT）
};
const launcher = makeLauncher(db, { home, spawnFn });
let threw = null;
try { launcher.launch(taskId, { verb: 'run' }); } catch (e) { threw = e.message; }
setTimeout(() => {
  let fdOpen = false;
  try { fstatSync(fd); fdOpen = true; } catch { /* EBADF：已关 */ }
  const audit = db.all(`SELECT action FROM audit_log WHERE target_id=? ORDER BY id`, taskId).map((r) => r.action);
  process.stdout.write(JSON.stringify({ alive: true, fdOpen, threw, audit, running: launcher.running(taskId) }));
}, 500);
