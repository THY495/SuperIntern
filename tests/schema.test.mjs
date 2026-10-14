// 状态库的形状：声明过的东西迁移完都还在、只增表真删不掉、整库形状与金样一致。
//
// 为什么要有这一份（2026-10-12）：v16 重建 params 表时 DROP TABLE 把"只增不删"触发器一起删了、
// 没重建，从那以后每个库都缺这条护栏 —— m3 第 10 节比的是"新建 vs 从 v1 升级"两条路径的形状，两条路都走
// 同一串迁移，一起丢就一起相等，比不出来。这里换三个不依赖迁移自身的尺子：
//   ① schema.sql 与迁移里 CREATE 过的每个表 / 索引 / 触发器，迁移完必须还在（重建时的临时表 *_vN 除外，
//      有意退役的写进 RETIRED 并说明是哪一级迁移、为什么）；
//   ② 只增表：真去删 / 改一行，必须被拒（行为，不看名字）；
//   ③ 金样：规范化后的整库形状与 tests/fixtures/schema-snapshot.txt 一致。形状变了要有意识地更新金样
//      （node tests/schema.test.mjs --update），diff 会出现在提交里 —— 漏掉的触发器 / 索引在评审时看得见。
//
// 跑：node tests/schema.test.mjs [--update]

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'tests', 'fixtures', 'schema-snapshot.txt');
const UPDATE = process.argv.includes('--update');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const section = (s) => console.log(`\n── ${s}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-schema-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

/** 有意退役的对象：名字 → 哪一级迁移、为什么。 */
const RETIRED = new Map([
  ['impact_marks', 'v29：修正流水线的影响标记最后落在 revisions.impact（JSON），这张表从没有读者、实际运行 23 个库里 0 行'],
  ['meetings', 'v29：会议没有做成独立实体（冲突走事项与路由），从没有读者、0 行'],
  ['notifications', 'v29：送达回执改记在 digests.receipts 与审计里，从没有读者、0 行'],
]);

/** SQL 去注释、压空白：公开版导出会改写注释，形状比较只认语句本身。 */
const norm = (sql) => String(sql ?? '').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();

const declaredIn = (text) => [...text.matchAll(/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi)]
  .map((m) => ({ type: m[1].toLowerCase(), name: m[2] }));

const fresh = openDb(join(TMP, 'fresh.db'));
const objects = fresh.all(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`);
const have = new Set(objects.map((o) => `${o.type}:${o.name}`));

section('① 声明过的表 / 索引 / 触发器，迁移完都还在');
{
  const declared = [
    ...declaredIn(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8')),
    ...declaredIn(readFileSync(join(ROOT, 'src', 'db', 'db.mjs'), 'utf8')),
  ];
  const isRebuildTemp = (d) => d.type === 'table' && /_v\d+$/.test(d.name);
  const missing = declared.filter((d) => !isRebuildTemp(d) && !RETIRED.has(d.name) && !have.has(`${d.type}:${d.name}`));
  assert(declared.length > 30, `从 schema.sql 与迁移里读到 ${declared.length} 个声明`);
  assert(missing.length === 0, '没有被迁移悄悄弄丢的对象（重建表时要把触发器 / 索引一起建回来）',
    missing.map((d) => `${d.type} ${d.name}`).join('、'));
  const leftover = objects.filter((o) => o.type === 'table' && /_v\d+$/.test(o.name));
  assert(leftover.length === 0, '重建用的临时表都已改名或清掉', leftover.map((o) => o.name).join('、'));
  for (const name of RETIRED.keys()) assert(!have.has(`table:${name}`) && !have.has(`trigger:${name}`) && !have.has(`index:${name}`), `登记为退役的 ${name} 确实不在了`);
}

section('② 只增表：真去删 / 改，必须被拒');
{
  const t = now();
  ensureOwner(fresh);
  const owner = fresh.one(`SELECT id FROM users LIMIT 1`).id;
  const taskId = newId('t');
  fresh.run(`INSERT INTO tasks (id, owner_id, title, status, created_at) VALUES (?, ?, 'x', 'planning', ?)`, taskId, owner, t);
  const seed = {
    audit_log: () => fresh.run(`INSERT INTO audit_log (ts, actor_kind, action, target_type, target_id) VALUES (?, 'system', 'probe', 'task', ?)`, t, taskId),
    usage_ledger: () => fresh.run(`INSERT INTO usage_ledger (task_id, role, model_tier, provider, model_id, input_tokens, output_tokens, micro_usd, billing, ts)
                                   VALUES (?, 'executor', 'standard', 'p', 'm', 1, 1, 1, 'computed', ?)`, taskId, t),
    params: () => fresh.run(`INSERT INTO params (id, task_id, key, value, layer, governance_class, set_by_kind, valid_from, recorded_at)
                             VALUES (?, ?, 'probe.key', '1', 'task', 'execution', 'user', ?, ?)`, newId('p'), taskId, t, t),
    messages: () => fresh.run(`INSERT INTO messages (id, task_id, body, kind, kind_source, urgency, urgency_source, trust_label, received_at)
                               VALUES (?, ?, 'hi', 'context', 'explicit', 'normal', 'explicit', 'agent-generated', ?)`, newId('m'), taskId, t),
  };
  const GUARDS = [
    ['audit_log', ['DELETE', 'UPDATE']], ['usage_ledger', ['DELETE', 'UPDATE']],
    ['params', ['DELETE']], ['messages', ['DELETE']], ['decisions', ['DELETE']], ['assumptions', ['DELETE']],
  ];
  for (const [table, ops] of GUARDS) {
    let seeded = false;
    try { if (seed[table]) { seed[table](); seeded = true; } } catch (e) { bad(`${table}：造一行测试数据`, e.message); continue; }
    for (const op of ops) {
      // 表空时 DELETE 不会触发行级触发器 —— 没造数据的表退回到"触发器在不在"
      if (!seeded) {
        const kind = op === 'DELETE' ? 'DELETE' : 'UPDATE';
        const trg = fresh.one(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql LIKE ?`, table, `%BEFORE ${kind}%`);
        assert(!!trg, `${table}：有 BEFORE ${kind} 触发器（${trg?.name ?? '无'}）`);
        continue;
      }
      let err = null;
      try { fresh.run(op === 'DELETE' ? `DELETE FROM ${table}` : `UPDATE ${table} SET rowid = rowid`); } catch (e) { err = e; }
      assert(err && /RAISE|append-only|supersede|immutable/i.test(err.message), `${table}：${op} 被拒`, err?.message ?? '没有报错 —— 护栏不在');
    }
  }
}

section('③ 整库形状与金样一致');
{
  const lines = objects.map((o) => `${o.type}|${o.name}|${o.tbl_name}|${norm(o.sql)}`).join('\n') + '\n';
  if (!UPDATE && !existsSync(SNAPSHOT)) bad(`没有金样 ${SNAPSHOT.slice(ROOT.length + 1)} —— 跑一次 --update 生成并提交`);
  else if (UPDATE) {
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, lines);
    ok(`金样已写入 ${SNAPSHOT.slice(ROOT.length + 1)}（${objects.length} 个对象）—— 提交前看一眼 diff`);
  } else {
    const want = readFileSync(SNAPSHOT, 'utf8').replace(/\r\n/g, '\n');
    if (want === lines) ok(`形状与金样一致（${objects.length} 个对象）`);
    else {
      const a = new Set(want.split('\n')), b = new Set(lines.split('\n'));
      const gone = [...a].filter((l) => l && !b.has(l)), added = [...b].filter((l) => l && !a.has(l));
      bad('形状与金样不一致 —— 有意改的就跑 `node tests/schema.test.mjs --update` 并在提交里写明原因',
        [...gone.map((l) => `- ${l.slice(0, 160)}`), ...added.map((l) => `+ ${l.slice(0, 160)}`)].join('\n         '));
    }
  }
}

section('④ 缺触发器的旧库（v22）升上来就补齐');
{
  const p = join(TMP, 'aged.db');
  const d = openDb(p);
  d.raw.exec(`DROP TRIGGER IF EXISTS trg_params_no_delete; PRAGMA user_version = 22;`);
  d.close();
  const d2 = openDb(p);
  assert(!!d2.one(`SELECT 1 AS x FROM sqlite_master WHERE type='trigger' AND name='trg_params_no_delete'`), 'v23 迁移把 params 的触发器建回来了');
  d2.close();
}

fresh.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
