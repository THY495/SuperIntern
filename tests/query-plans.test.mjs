// 查询计划回归：会一直长大的表（审计轨、账本、出处边……）上的查询不许整表扫。
//
// 不靠人记哪些是热查询：从 src/ 的源码里把读这些表的 SQL 字面量全抠出来，在新库上逐条 EXPLAIN QUERY PLAN，
// 出现"SCAN <表>"（没走索引）就红 —— 以后新写的查询自动在网里。确实要整表读的（复盘逐行读审计轨）登记在 ALLOW 并写明原因。
// 带 ${} 插值的拼接 SQL 拿不到完整文本，跳过并报个数。
//
// 跑：node tests/query-plans.test.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/db.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };

/** 只增、会一直长的表 */
const GROWING = ['audit_log', 'usage_ledger', 'edges', 'context_assemblies', 'messages'];
/** 有意整表读的：SQL 片段 → 原因 */
const ALLOW = [
  ['SELECT * FROM audit_log ORDER BY id', '复盘：按序读全部审计（离线工具，不在常驻路径上）'],
  ['SELECT COALESCE(MAX(id),0) m FROM audit_log', 'MAX(id) 走主键末端，SQLite 显示为 SEARCH/优化，不是整表'],
];

const BT = String.fromCharCode(96);
const files = [];
const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (/\.mjs$/.test(e)) files.push(p); } };
walk(join(ROOT, 'src'));
const sqls = [];
let skipped = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(new RegExp(`${BT}([^${BT}]*?)${BT}`, 'g'))) {
    const s = m[1];
    if (!/^\s*(SELECT|UPDATE|DELETE)\b/i.test(s) || !GROWING.some((t) => new RegExp(`\\b(FROM|JOIN|UPDATE)\\s+${t}\\b`, 'i').test(s))) continue;
    if (s.includes('${')) { skipped++; continue; }
    sqls.push({ sql: s.replace(/\s+/g, ' ').trim(), at: relative(ROOT, f).split('\\').join('/') });
  }
}

const db = openDb(':memory:');
const scans = [];
let checked = 0;
for (const { sql, at } of sqls) {
  let plan;
  try { plan = db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(); } catch { continue; }   // 引用了运行时才有的东西（临时表等）
  checked++;
  const hit = plan.find((p) => GROWING.some((t) => new RegExp(`^SCAN ${t}\\b`).test(p.detail)) && !/INDEX/.test(p.detail));
  if (hit && !ALLOW.some(([frag]) => sql.includes(frag))) scans.push(`${at}：${hit.detail} ← ${sql.slice(0, 120)}`);
}
console.log('\n── 会一直长大的表上的查询都走索引');
ok(`从源码抠出 ${sqls.length} 条读 ${GROWING.join(' / ')} 的 SQL，可 EXPLAIN 的 ${checked} 条（带插值跳过 ${skipped} 条）`);
scans.length ? bad(`${scans.length} 条整表扫（加索引，或确有必要就登记进 ALLOW 并写明原因）`, scans.join('\n         ')) : ok('没有整表扫（登记过的除外）');
db.close();

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
