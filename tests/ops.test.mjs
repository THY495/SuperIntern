// 决策类型「运维」
//
// 跑：node tests/ops.test.mjs
//
// 起因：合并卡住 / 合并出错 / 改计划没成 / 停等报警若都走"结构矛盾"，而结构矛盾必须送负责人 —— 每条停等报警都要发两个人。
// 分出"运维"一类（不要求含负责人），负责人可以只派给管代码的人。断言：迁移保住旧表的行、能存新类型；
// 旧表缺这一类时按"结构矛盾"那几行借用；卡住的几种改走运维（验收没过仍是结构矛盾）；运维可以不含负责人；答复照旧由交回钩子认领。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { rulesOf, saveRules, validateRules, DECISION_TYPES } from '../src/core/routing.mjs';
import { raiseDirtyWorkspace, raiseVerifyFailed } from '../src/core/handback.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import '../src/core/project.mjs';   // 注册 RESOLUTION_HOOKS（ops / structural）

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-ops-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

section('1. 迁移：旧库（v20，CHECK 里没有 ops）里的路由行原样保住，之后能存运维');
{
  const f = join(TMP, 'old.db');
  openDb(f).close();                                   // 先建成最新版
  const raw = new DatabaseSync(f);                      // 再把 routing_rules 退回旧形状、版本退回 20
  raw.exec(`PRAGMA foreign_keys=OFF; DROP TABLE routing_rules; CREATE TABLE routing_rules (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', decision_type TEXT NOT NULL CHECK (decision_type IN
      ('spec_choice','structural','contract_approval','signoff','budget','egress','delivery','conflict')),
    scope TEXT NOT NULL DEFAULT '*', position INTEGER NOT NULL DEFAULT 0, recipients TEXT NOT NULL DEFAULT '[]', quorum TEXT NOT NULL DEFAULT '1',
    conflict_policy TEXT NOT NULL DEFAULT 'block' CHECK (conflict_policy IN ('block','latest')),
    timeout_action TEXT NOT NULL DEFAULT 'hang' CHECK (timeout_action IN ('hang','next','default')), timeout_after TEXT, template TEXT, created_at INTEGER NOT NULL);
    INSERT INTO routing_rules (id,project_id,decision_type,recipients,created_at) VALUES ('rr_old','pj_x','structural','["user:lead"]',1);
    PRAGMA user_version = 20;`);
  let threw = null;
  try { raw.exec(`INSERT INTO routing_rules (id,decision_type,created_at) VALUES ('rr_bad','ops',1)`); } catch (e) { threw = e; }
  assert(threw, '旧形状确实存不了 ops（测试前提成立）');
  raw.close();
  const db = openDb(f);
  eq(db.one(`SELECT decision_type FROM routing_rules WHERE id='rr_old'`)?.decision_type, 'structural', '迁移后旧行还在');
  db.run(`INSERT INTO routing_rules (id,decision_type,created_at) VALUES ('rr_ops','ops',1)`);
  eq(db.one(`SELECT count(*) n FROM routing_rules WHERE decision_type='ops'`).n, 1, '能存运维');
  db.close();
}

const db = openDb(':memory:');
const owner = ensureOwner(db);
const zhou = addUser(db, { name: '阿明', role: 'member', byUserId: owner.userId });
const pid = newId('pj'), tid = newId('t'), t = now();
db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,?,?,?,?, 'active', ?)`, pid, owner.userId, 'p', '/tmp/r', 'b', 'main', t);
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'T1','done',?,?,1)`, tid, owner.userId, t, pid);

section('2. 旧表缺运维：借"结构矛盾"那几行（谁管结构，谁先管运维）；保存时同样补齐');
{
  const rows = rulesOf(db, pid).map(({ id, project_id, template, ...r }) => r).filter((r) => r.decision_type !== 'ops');
  rows.find((r) => r.decision_type === 'structural' && r.scope === '*').recipients = [`user:${zhou.userId}`, 'user:lead'];
  saveRules(db, { key: pid, rules: rows, userId: owner.userId });   // 交上来的表里没有 ops
  const ops = rulesOf(db, pid).filter((r) => r.decision_type === 'ops');
  eq(JSON.stringify(ops.map((r) => r.recipients)), JSON.stringify([[`user:${zhou.userId}`, 'user:lead']]), '保存时按结构矛盾那行补上了运维');
  db.run(`DELETE FROM routing_rules WHERE project_id=? AND decision_type='ops'`, pid);
  const borrowed = rulesOf(db, pid).filter((r) => r.decision_type === 'ops');
  assert(borrowed.length === 1 && borrowed[0].id.startsWith('derived:ops:'), '库里没有运维行时，读的时候借来（不落库）');
  eq(DECISION_TYPES.ops.level3, false, '运维不要求含负责人');
}

section('3. 卡住的几种走运维；验收没过（代码的事）仍是结构矛盾');
{
  const rows = rulesOf(db, pid).map(({ id, project_id, template, ...r }) => r);
  rows.find((r) => r.decision_type === 'ops' && r.scope === '*').recipients = [`user:${zhou.userId}`];
  eq(validateRules(db, pid, rows).length, 0, '运维只派给阿明（不含负责人）：校验通过');
  saveRules(db, { key: pid, rules: rows, userId: owner.userId });
  const d = raiseDirtyWorkspace(db, { taskId: tid, files: ['backend/app.db'] });
  const q = db.one(`SELECT decision_type, addressed_to FROM questions WHERE id=?`, d.questionId);
  eq([q.decision_type, JSON.parse(q.addressed_to).join(',')].join('|'), `ops|${zhou.userId}`, '合并卡住 → 运维，只送阿明');
  const tid2 = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'T2','done',?,?,2)`, tid2, owner.userId, t, pid);
  const v = raiseVerifyFailed(db, { taskId: tid2, verification: { argv: ['npm', 'test'], code: 1, tail: 'x' } });
  eq(db.one(`SELECT decision_type FROM questions WHERE id=?`, v.questionId).decision_type, 'structural', '验收没过 → 仍是结构矛盾（含负责人）');

  section('4. 运维事项的答复照旧由交回钩子认领（转成修正、任务回到 running）');
  const r = recordAnswer(db, { questionId: d.questionId, body: '把 backend/app.db 加进 .gitignore', plaintextToken: zhou.plaintext });
  assert(r.hook?.handled && r.hook?.messageId, '钩子认领：转成了修正');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, tid).status, 'running', '任务回到 running');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
