// schema 质量：
//   ① 每张表都是 STRICT（棘轮：以后新建的表也必须是）；类型不对的值当场被拒；
//   ② JSON 列：不合法 / 形状不对被拒；带 *_json 约束的列不少于 v29 那一批；
//   ③ 封闭枚举：清单外的值被拒；
//   ④ v28 → v29 重建：AUTOINCREMENT 计数器续上原值（删过尾部行的表不复用 id）、触发器 / 索引一个不少、死表与废弃列已删；
//   ⑤ 已有数据不满足新约束：迁移整个回滚、库停在 v28，报错里带表名 / 约束名 / 行号；
//   ⑥ 审计 payload_v：新行记当前版本、旧行是 NULL；auditPayload 按版本逐级升级、只升该升的。
//
// 跑：node tests/schema-quality.test.mjs

import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { AUDIT_PAYLOAD_V, UPGRADES, auditPayload } from '../src/db/audit-payload.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);
const TMP = mkdtempSync(join(tmpdir(), 'si-sq-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const rejects = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const db = openDb(':memory:');
const owner = ensureOwner(db);
const t = now();
const taskId = newId('t');
db.run(`INSERT INTO tasks (id, owner_id, title, status, created_at) VALUES (?, ?, 'x', 'planning', ?)`, taskId, owner.userId, t);
const qId = newId('q');
db.run(`INSERT INTO questions (id, task_id, level, level_source, text, asked_at, status) VALUES (?, ?, 2, 'hard_rule', '?', ?, 'open')`, qId, taskId, t);

section('① 全部 STRICT；类型不对被拒');
{
  const tables = db.all(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
  const loose = tables.filter((x) => !/\)\s*STRICT\s*$/i.test(x.sql)).map((x) => x.name);
  eq(loose, [], `${tables.length} 张表都是 STRICT（新表也得是：写迁移时末尾带 STRICT）`);
  assert(/cannot store TEXT value in INTEGER column/.test(rejects(() => db.run(`UPDATE tasks SET created_at='昨天' WHERE id=?`, taskId)) ?? ''), '整数列写文字：拒');
  assert(/cannot store REAL value in INTEGER column/.test(rejects(() => db.run(`UPDATE tasks SET created_at=? WHERE id=?`, t + 0.5, taskId)) ?? ''), '整数列写小数（比如秒表的读数）：拒');
  eq(rejects(() => db.run(`UPDATE tasks SET created_at=? WHERE id=?`, t + 1, taskId)), null, '整数照常（node:sqlite 把 JS 数按 double 绑，整数值无损转换）');
}

section('② JSON 列');
{
  const n = db.all(`SELECT sql FROM sqlite_master WHERE type='table'`).reduce((a, r) => a + (String(r.sql).match(/CONSTRAINT \w+_json CHECK/g) ?? []).length, 0);
  assert(n >= 29, `带 *_json 约束的列 ${n} 个（v29 那一批是 29 个，只增不减）`);
  for (const [sql, args, what] of [
    [`UPDATE questions SET route=? WHERE id=?`, ['{坏', qId], '不合法的 JSON'],
    [`UPDATE questions SET route=? WHERE id=?`, ['[1,2]', qId], '该是对象却给了数组'],
    [`UPDATE questions SET informed=? WHERE id=?`, ['{}', qId], '该是数组却给了对象'],
    [`UPDATE questions SET addressed_to=? WHERE id=?`, ['', qId], '空串（不是合法 JSON）'],
    [`INSERT INTO audit_log (ts, actor_kind, action, payload) VALUES (?, 'system', 'x', ?)`, [t, 'null'], '审计 payload 给 null'],
  ]) assert(/_json/.test(rejects(() => db.run(sql, ...args)) ?? ''), `${what}：拒（报错带约束名）`);
  eq(rejects(() => db.run(`UPDATE questions SET route=?, informed=? WHERE id=?`, '{"stage":0}', '["u1"]', qId)), null, '形状对的照常');
  eq(rejects(() => db.run(`UPDATE questions SET route=NULL WHERE id=?`, qId)), null, '可空的 JSON 列写 NULL 照常');
}

section('③ 封闭枚举');
{
  assert(/decision_type_enum/.test(rejects(() => db.run(`UPDATE questions SET decision_type='nope' WHERE id=?`, qId)) ?? ''), '问题类型清单外：拒');
  assert(/quorum_format/.test(rejects(() => db.run(`UPDATE questions SET quorum='0' WHERE id=?`, qId)) ?? ''), '法定人数 0：拒');
  assert(/quorum_format/.test(rejects(() => db.run(`UPDATE questions SET quorum='2x' WHERE id=?`, qId)) ?? ''), '法定人数 2x：拒');
  eq(['1', '12', 'all'].map((q) => rejects(() => db.run(`UPDATE questions SET quorum=? WHERE id=?`, q, qId))), [null, null, null], "法定人数 '1' / '12' / 'all' 照常");
  const pj = newId('pj');
  assert(/visibility_enum/.test(rejects(() => db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at,visibility) VALUES (?,?,'p','/r','b','main','active',?,'team')`, pj, owner.userId, t)) ?? ''), "项目可见性 'team'（代码只认 all / members）：拒");
}

section('④ v28 → v29 重建');
{
  const p = join(TMP, 'up', 'state.db');
  const old = openDb(p, { migrateTo: 28 });
  const o = { userId: 'u_old' }; // 旧版本的库不能用 ensureOwner（它经 audit() 写 payload_v，v29 才有这一列）
  old.run(`INSERT INTO users (id, display_name, role, created_at) VALUES ('u_old', 'o', 'lead', ?)`, t);
  const tk = newId('t');
  old.run(`INSERT INTO tasks (id, owner_id, title, status, created_at) VALUES (?, ?, 'x', 'planning', ?)`, tk, o.userId, t);
  for (let i = 0; i < 3; i++) old.run(`INSERT INTO edges (from_id, to_id, relation, valid_from, recorded_at) VALUES (?, ?, 'about_node', ?, ?)`, `a${i}`, 'b', t, t);
  old.run(`DELETE FROM edges WHERE id = (SELECT max(id) FROM edges)`);
  const seqBefore = old.one(`SELECT seq FROM sqlite_sequence WHERE name='edges'`).seq;
  old.run(`INSERT INTO audit_log (ts, actor_kind, action, payload) VALUES (?, 'system', 'legacy', '{"a":1}')`, t);
  const shape = (d, ty) => d.all(`SELECT name FROM sqlite_master WHERE type=? AND sql IS NOT NULL ORDER BY name`, ty).map((r) => r.name);
  const trgBefore = shape(old, 'trigger');
  const idxBefore = shape(old, 'index');
  old.close();
  const d = openDb(p);
  eq(d.raw.prepare('PRAGMA user_version').get().user_version >= 29, true, '升到 v29 及以后');
  // 原有的一个不少（之后的迁移可以再加，所以比"都还在"而不是"完全相等"）
  const lostOf = (ty, before) => before.filter((n) => !shape(d, ty).includes(n));
  eq(lostOf('trigger', trgBefore), [], `触发器 ${trgBefore.length} 条一个不少`);
  eq(lostOf('index', idxBefore), [], `索引 ${idxBefore.length} 条一个不少`);
  d.run(`INSERT INTO edges (from_id, to_id, relation, valid_from, recorded_at) VALUES ('n', 'b', 'about_node', ?, ?)`, t, t);
  eq(d.one(`SELECT max(id) m FROM edges`).m, seqBefore + 1, `AUTOINCREMENT 续上原计数（${seqBefore} 之后是 ${seqBefore + 1}，不复用删掉的 id）`);
  eq(d.all(`SELECT name FROM sqlite_master WHERE name IN ('impact_marks','meetings','notifications')`).length, 0, '三张死表已删');
  eq(!!d.one(`SELECT 1 x FROM pragma_table_info('users') WHERE name='can_answer'`), false, '废弃列 users.can_answer 已删');
  eq(d.raw.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', 'integrity_check ok');
  assert(/append-only|只增|not allowed|cannot/i.test(rejects(() => d.run(`DELETE FROM audit_log`)) ?? ''), '审计轨的只增触发器重建后照样生效');
  eq(d.one(`SELECT payload_v FROM audit_log WHERE action='legacy'`).payload_v, null, '迁移前的审计行 payload_v 是 NULL（不改写历史）');
  d.close();
}

section('⑤ 已有数据不满足新约束：整个回滚、库停在 v28、报错可读');
{
  const dir = join(TMP, 'badjson');
  const p = join(dir, 'state.db');
  const old = openDb(p, { migrateTo: 28 });
  const o = { userId: 'u_old' }; // 旧版本的库不能用 ensureOwner（它经 audit() 写 payload_v，v29 才有这一列）
  old.run(`INSERT INTO users (id, display_name, role, created_at) VALUES ('u_old', 'o', 'lead', ?)`, t);
  const tk = newId('t');
  old.run(`INSERT INTO tasks (id, owner_id, title, status, created_at) VALUES (?, ?, 'x', 'planning', ?)`, tk, o.userId, t);
  old.run(`INSERT INTO questions (id, task_id, level, level_source, text, asked_at, status, route) VALUES (?, ?, 2, 'hard_rule', '?', ?, 'open', '这不是 JSON')`, newId('q'), tk, t);
  old.close();
  const msg = rejects(() => openDb(p));
  assert(/questions/.test(msg ?? '') && /route_json/.test(msg ?? '') && /rowid \d/.test(msg ?? '') && /已回滚/.test(msg ?? ''), `报错带表名、约束名、行号（${String(msg).slice(0, 120)}）`);
  const raw = new DatabaseSync(p, { readOnly: true });
  eq(raw.prepare('PRAGMA user_version').get().user_version, 28, '库停在 v28');
  eq(raw.prepare(`SELECT count(*) n FROM sqlite_master WHERE name LIKE '%_v29'`).get().n, 0, '没留下重建的临时表');
  eq(raw.prepare(`SELECT count(*) n FROM sqlite_master WHERE type='trigger'`).get().n > 0, true, '触发器还在（拆触发器那一步也回滚了）');
  raw.close();
  assert(readdirSync(join(dir, 'backups')).some((f) => /pre-v28/.test(f)), '迁移前的备份在');
}

section('⑥ 审计 payload_v');
{
  eq(UPGRADES.length, AUDIT_PAYLOAD_V, `每一级都有升级表（${AUDIT_PAYLOAD_V} 级）`);
  audit(db, { actorKind: 'system', action: 'shape_probe', payload: { a: 1 } });
  eq(db.one(`SELECT payload_v FROM audit_log WHERE action='shape_probe'`).payload_v, AUDIT_PAYLOAD_V, 'audit() 写当前版本');
  UPGRADES[0].shape_probe = (p) => ({ ...p, upgraded: true });
  try {
    eq(auditPayload({ action: 'shape_probe', payload: '{"a":1}', payload_v: null }), { a: 1, upgraded: true }, '旧行（NULL）读时升级');
    eq(auditPayload({ action: 'shape_probe', payload: '{"a":1}', payload_v: AUDIT_PAYLOAD_V }), { a: 1 }, '当前版本的行不动');
    eq(auditPayload({ action: 'other', payload: '{"a":1}', payload_v: null }), { a: 1 }, '没列的动作原样通过');
  } finally { delete UPGRADES[0].shape_probe; }
  eq(auditPayload({ action: 'x', payload: '{坏', payload_v: null }), {}, '坏 JSON（v29 之前的库才可能有）给 {}');
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
