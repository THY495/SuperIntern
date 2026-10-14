// 参数写入收口：
//   ① 作废旧值 + 写新值是一个事务：新值写不进去（这里用非法的治理类别逼 CHECK 失败），旧值原样还是现值 ——
//      原来这两句散在 8 个文件、一半没包事务，中途出错这个键就一行现值都没有，读的人悄悄退回默认值；
//   ② 库层唯一索引（v31）：同一作用域 + 键不可能出现第二行现值，绕过 writeParam 直接插也不行；
//   ③ 三个作用域互不干扰：任务层、项目层、部署层同名键各有各的现值；清掉一层只作废不写新值。
//
// 跑：node tests/param-writes.test.mjs

import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { writeParam, clearParam, getParam, getProjectParam } from '../src/core/params.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const db = openDb(':memory:');
const o = ensureOwner(db);
const taskId = newId('t'), projectId = newId('pj');
db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'p','/r','b','main','active',?)`, projectId, o.userId, now());
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id) VALUES (?,?,'t','running',?,?)`, taskId, o.userId, now(), projectId);
const by = { kind: 'user', id: o.userId };
const current = (key) => db.all(`SELECT task_id, project_id, value FROM params WHERE key=? AND superseded_at IS NULL ORDER BY rowid`, key);

console.log('\n── ① 原子');
writeParam(db, { taskId, key: 'limit.budget_micro_usd', value: 500000, by, governance: 'constitutional' });
const err = rejects(() => writeParam(db, { taskId, key: 'limit.budget_micro_usd', value: 900000, by, governance: '乱写的' }));
eq([!!err, getParam(db, taskId, 'limit.budget_micro_usd')], [true, 500000], '新值写不进去：整笔回滚，旧值 500000 还是现值（原来会变成"没有现值"、退回默认）');

console.log('\n── ② 库层：同一作用域 + 键只有一行现值');
const dup = rejects(() => db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
  VALUES (?,?,'limit.budget_micro_usd','1','task','constitutional','user',?,?,?)`, newId('p'), taskId, o.userId, now(), now()));
eq(/UNIQUE constraint failed/.test(dup ?? ''), true, '绕过 writeParam 直接插第二行现值：库层拒绝');

console.log('\n── ③ 三个作用域互不干扰');
writeParam(db, { projectId, key: 'x.k', value: 'project', by, governance: 'execution' });
writeParam(db, { taskId, key: 'x.k', value: 'task', by, governance: 'execution' });
writeParam(db, { key: 'x.k', value: 'deploy', by, governance: 'constitutional' });
writeParam(db, { taskId, key: 'x.k', value: 'task2', by, governance: 'execution' });
eq(current('x.k').map((r) => [r.task_id ? 'task' : r.project_id ? 'project' : 'deploy', JSON.parse(r.value)]), [['project', 'project'], ['deploy', 'deploy'], ['task', 'task2']],
  '三层各一行现值；改任务层只作废任务层的旧值');
clearParam(db, { projectId, key: 'x.k', by });
eq([getProjectParam(db, projectId, 'x.k'), current('x.k').length], [null, 2], '清掉项目层：只作废、不写新值，另两层不动');

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
