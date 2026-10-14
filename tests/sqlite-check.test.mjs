// SQLite 版本自检：WAL 重置缺陷的范围判断要准（含回补系列），并在库句柄上读到真实版本。
//
// 跑：node tests/sqlite-check.test.mjs

import { openDb } from '../src/db/db.mjs';
import { walResetAffected, sqliteAdvice } from '../src/core/sqlite-check.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

console.log('\n── 范围判断（sqlite.org/wal.html：3.7.0–3.51.2 受影响，3.51.3 修复，3.50.7 / 3.44.6 有回补）');
for (const [v, want] of [
  ['3.6.23', false], ['3.7.0', true], ['3.45.1', true], ['3.51.2', true], ['3.51.3', false], ['3.52.0', false], ['3.53.4', false],
  ['3.50.6', true], ['3.50.7', false], ['3.44.5', true], ['3.44.6', false], ['3.44.10', false],
]) eq(walResetAffected(v), want, `${v} → ${want ? '受影响' : '不受影响'}`);

console.log('\n── 在真实库句柄上读版本');
{
  const db = openDb(':memory:');
  const v = db.raw.prepare('SELECT sqlite_version() AS v').get().v;
  const a = sqliteAdvice(db);
  eq(!!a, walResetAffected(v), `本机 Node ${process.version} 自带 SQLite ${v}：${a ? '给出升级建议' : '无需建议'}`);
  if (a) eq(a.fixedIn, '3.51.3', '建议里写明修复版本');
  db.close();
}

console.log('\n── 看板：只给管理员看（他才能动服务器）');
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ensureOwner } = await import('../src/db/db.mjs');
  const { addUser } = await import('../src/core/users.mjs');
  const { startWeb } = await import('../src/web/server.mjs');
  const HOME = mkdtempSync(join(tmpdir(), 'si-sqlchk-'));
  const db = openDb(join(HOME, 'state.db'));
  const owner = ensureOwner(db);
  const member = addUser(db, { name: '成员', role: 'member', byUserId: owner.userId });
  const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100 });
  try {
    const get = (tok) => fetch(`http://127.0.0.1:${w.port}/api/tasks`, { headers: { 'x-superintern-token': tok } }).then((r) => r.json());
    const expect = !!sqliteAdvice(db);
    eq(!!(await get(owner.plaintext)).sqlite, expect, `管理员：${expect ? '带提示' : '本机版本没问题，不带'}`);
    eq((await get(member.plaintext)).sqlite, null, '普通成员：不带（处理不了，只会添乱）');
  } finally { await w.close?.(); db.close(); rmSync(HOME, { recursive: true, force: true }); }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
