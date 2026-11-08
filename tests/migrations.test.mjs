// 迁移的升级等价与数据保全。
//
// schema.test 钉的是"新装库的形状"；这里钉"从任何一个历史版本升上来"：
//   ① 停在每一个历史版本 k（0…N-1）的库，重新打开升到最新 → 形状与金样完全一致、integrity / foreign_key 检查干净、
//      升级前自动备份了一份（备份能打开、版本号是 k）；
//   ② 一份按 v1（schema.sql）形状写的、各表都有行的库，升到最新 → 每张 v1 就有的表行数不变、关键字段原样
//      （被重建过的 users / params 逐字段核；users 的旧角色按迁移映射成新角色）。
// 真实数据的升级演练（本机的试跑库副本）不在这里 —— 那些库不进仓库，见 dev/upgrade-drill.mjs。
//
// 跑：node tests/migrations.test.mjs

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-mig-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const norm = (sql) => String(sql ?? '').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim();
const shapeOf = (raw) => raw.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all()
  .map((o) => `${o.type}|${o.name}|${o.tbl_name}|${norm(o.sql)}`).join('\n') + '\n';
const SNAPSHOT = readFileSync(join(ROOT, 'tests', 'fixtures', 'schema-snapshot.txt'), 'utf8').replace(/\r\n/g, '\n');
const checks = (raw) => ({
  integrity: raw.prepare('PRAGMA integrity_check').get().integrity_check,
  fk: raw.prepare('PRAGMA foreign_key_check').all().length,
});

// 新库从 schema.sql 起步时就已经是 base 版（schema.sql 自带版本号）；更早的 v0 只存在于迁移机制出现之前的老库 —— 那种由 ② 覆盖
const base = (() => { const p = join(TMP, 'base.db'); const d = openDb(p, { migrateTo: 0 }); const v = d.raw.prepare('PRAGMA user_version').get().user_version; d.close(); rmSync(p); return v; })();
const latest = (() => { const d = openDb(':memory:'); const v = d.raw.prepare('PRAGMA user_version').get().user_version; d.close(); return v; })();

section(`① 停在每一个历史版本（${base}…${latest - 1}）的库，升到最新都与金样一致`);
{
  const bad1 = [];
  for (let k = base; k < latest; k++) {
    const p = join(TMP, `v${k}.db`);
    openDb(p, { migrateTo: k }).close();                 // 一个"由第 k 版代码建的"库
    const d0 = new DatabaseSync(p);
    const vk = d0.prepare('PRAGMA user_version').get().user_version;
    d0.close();
    if (vk !== k) { bad1.push(`v${k}：造出来的库版本是 ${vk}`); continue; }
    const d = openDb(p);                                  // 新代码打开 → 自动升级
    const v = d.raw.prepare('PRAGMA user_version').get().user_version;
    const c = checks(d.raw);
    const same = shapeOf(d.raw) === SNAPSHOT;
    d.close();
    const backups = readdirSync(join(TMP, 'backups')).filter((f) => f.startsWith(`state-pre-v${k}-`) || f.includes(`pre-v${k}-`));
    if (v !== latest || c.integrity !== 'ok' || c.fk || !same) bad1.push(`v${k}：版本 ${v}、integrity ${c.integrity}、外键问题 ${c.fk}、形状${same ? '一致' : '不一致'}`);
    if (!backups.length) bad1.push(`v${k}：升级前没有备份`);
  }
  assert(bad1.length === 0, `${latest - base} 个历史版本逐个升级：版本到 ${latest}、integrity ok、外键干净、形状与金样一致、升级前有备份`, bad1.join('\n         '));
}

section('② v1 形状、各表都有行的库，升上来数据一行不丢');
{
  const p = join(TMP, 'aged-data.db');
  const raw = new DatabaseSync(p);
  raw.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  raw.exec('PRAGMA user_version = 0');
  const T = 1_700_000_000_000;
  raw.exec(`
    INSERT INTO users VALUES ('u_own','负责人','owner','["backend"]','[]',${T}), ('u_con','贡献者','contributor','[]','[]',${T}), ('u_view','旁观','viewer','[]','[]',${T});
    INSERT INTO tokens VALUES ('k1','u_own','hash-own','u_own',${T},NULL), ('k2','u_con','hash-con','u_own',${T},${T + 5});
    INSERT INTO user_channels VALUES ('ch1','u_own','ntfy','topic-x',100,1);
    INSERT INTO tasks VALUES ('t1','u_own','老任务','running',${T});
    INSERT INTO constitutions VALUES ('c1','t1',1,'目标','.','完成定义','["约束一"]',${T},NULL,${T},NULL);
    INSERT INTO nodes (id,task_id,title,spec,acceptance,status,created_at) VALUES ('n1','t1','第一步','规格','验收','pending',${T}), ('n2','t1','第二步','规格','验收','blocked',${T});
    INSERT INTO edges (from_id,to_id,relation,valid_from,recorded_at) VALUES ('n2','n1','depends_on',${T},${T}), ('n1','c1','derived_from',${T},${T});
    INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at) VALUES ('m1','t1','u_own','改成蓝色','correction','explicit','normal','explicit','user-authenticated','k1',${T});
    INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES ('q1','t1','n2',2,'classifier','用哪个库？','用内置的',${T},${T + 60000},'open');
    INSERT INTO decisions VALUES ('d1','t1','n1','选了 A','因为 B','agent',NULL,'execution',NULL,${T},NULL,${T},NULL);
    INSERT INTO assumptions VALUES ('a1','t1','n1','db.engine','用 SQLite','active',${T},NULL,${T},NULL);
    INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,narrative_ref,created_at) VALUES ('h1','n1',1,'[]','无','narr.md',${T});
    INSERT INTO params VALUES ('p1','t1','limit.budget_micro_usd','500000','task','constitutional','user','u_own',${T},NULL,${T},NULL),
                              ('p2',NULL,'deploy.x','true','system','execution','user','u_own',${T},NULL,${T},NULL);
    INSERT INTO usage_ledger (task_id,node_id,role,model_tier,provider,model_id,input_tokens,output_tokens,micro_usd,billing,ts) VALUES ('t1','n1','executor','standard','deepseek','deepseek/deepseek-flash',1000,50,321,'computed',${T});
    INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (${T},'user','u_own','task_created','task','t1','{"a":1}'), (${T + 1},'system',NULL,'orchestrator_exit','task','t1','{"kind":"complete"}');
  `);
  const V1_TABLES = raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name);
  const countsBefore = Object.fromEntries(V1_TABLES.map((t) => [t, raw.prepare(`SELECT count(*) n FROM ${t}`).get().n]));
  raw.close();

  const d = openDb(p);
  // v29删掉的三张死表：从没有读者、v1 起就没写过一行 —— 升级前必须是空的（不空就是删了数据）
  const RETIRED = ['impact_marks', 'meetings', 'notifications'];
  eq(RETIRED.map((t) => countsBefore[t]), [0, 0, 0], 'v29 退役的三张表升级前本来就是空的');
  assert(RETIRED.every((t) => !d.one(`SELECT 1 x FROM sqlite_master WHERE name=?`, t)), '升级后这三张表已不在');
  const kept = V1_TABLES.filter((t) => !RETIRED.includes(t));
  const countsAfter = Object.fromEntries(kept.map((t) => [t, d.one(`SELECT count(*) n FROM ${t}`).n]));
  const lost = kept.filter((t) => countsAfter[t] !== countsBefore[t]).map((t) => `${t} ${countsBefore[t]}→${countsAfter[t]}`);
  assert(lost.length === 0, `v1 就有的其余 ${kept.length} 张表，升级后行数一行不差`, lost.join('、'));
  eq(d.all(`SELECT id, role, display_name, domain_tags FROM users ORDER BY id`).map((u) => [u.id, u.role, u.display_name, u.domain_tags]),
    [['u_con', 'member', '贡献者', '[]'], ['u_own', 'lead', '负责人', '["backend"]'], ['u_view', 'observer', '旁观', '[]']],
    'users（被重建过）：旧角色按迁移映射 owner→lead / contributor→member / viewer→observer，其余字段原样');
  eq(d.all(`SELECT id, task_id, project_id, key, value, layer, governance_class, set_by_id FROM params WHERE id IN ('p1','p2') ORDER BY id`).map((r) => Object.values(r)),
    [['p1', 't1', null, 'limit.budget_micro_usd', '500000', 'task', 'constitutional', 'u_own'], ['p2', null, null, 'deploy.x', 'true', 'system', 'execution', 'u_own']],
    'params（被重建过）：逐字段原样，新加的 project_id 为空');
  eq(d.one(`SELECT revoked_at FROM tokens WHERE id='k2'`).revoked_at, T + 5, 'tokens：吊销时间原样（升级不能把吊销过的令牌复活）');
  eq(d.one(`SELECT payload FROM audit_log WHERE action='orchestrator_exit'`).payload, '{"kind":"complete"}', 'audit_log：载荷原样');
  eq(d.one(`SELECT micro_usd FROM usage_ledger`).micro_usd, 321, 'usage_ledger：金额原样');
  eq(d.one(`SELECT trust_label, token_id, sender_id FROM messages WHERE id='m1'`), { trust_label: 'user-authenticated', token_id: 'k1', sender_id: 'u_own' }, 'messages：认证锚点（令牌、发送人）原样');
  const c = checks(d.raw);
  eq([c.integrity, c.fk], ['ok', 0], '升级后 integrity_check ok、foreign_key_check 干净');
  assert(shapeOf(d.raw) === SNAPSHOT, '带数据升上来的形状同样与金样一致');
  let err = null; try { d.run(`DELETE FROM params WHERE id='p1'`); } catch (e) { err = e; }
  assert(!!err, '升级后的老库同样有只增护栏（params 删不掉）');
  d.close();
}

section('③ v55：升级前就开着的禁默认事项去掉默认（不然到期照样替人定）');
{
  const { ensureOwner, newId } = await import('../src/db/db.mjs');
  const p = join(TMP, 'v54-open-defaults.db');
  const d0 = openDb(p);
  const owner = ensureOwner(d0, '负责人'), t0 = 1_800_000_000_000;
  const tid = newId('t'), nid = newId('n');
  d0.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'x','running',?)`, tid, owner.userId, t0);
  d0.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'n','s','a','running',5,?)`, nid, tid, t0);
  const q = (id, type, status, level = 2) => d0.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status,decision_type)
    VALUES (?,?,?,?,'classifier','?','撤销改动',?,?,?,?)`, id, tid, nid, level, t0, t0 + 3_600_000, status, type);
  q('q_struct', 'structural', 'open'); q('q_ops1', 'ops', 'escalated', 1); q('q_spec', 'spec_choice', 'open', 1); q('q_done', 'structural', 'answered');
  d0.raw.exec(`PRAGMA user_version = 54`);
  d0.close();
  const d = openDb(p);
  const row = (id) => { const r = d.one(`SELECT default_action, level FROM questions WHERE id=?`, id); return [r.default_action, r.level]; };
  eq(row('q_struct'), [null, 2], '开着的结构矛盾：默认去掉');
  eq(row('q_ops1'), [null, 2], '升级过的系统卡住：默认去掉，Ⅰ 级抬成 Ⅱ 级（和路由时的处理一样）');
  eq(row('q_spec'), ['撤销改动', 1], '规格取舍可以有默认：不动');
  eq(row('q_done'), ['撤销改动', 2], '已经结了的不动（留着当时的记录）');
  d.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
