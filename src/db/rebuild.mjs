// 按 SQLite 官方的"12 步"重建表（sqlite.org/lang_altertable.html#otheralter）：SQLite 改不了已有表的约束、
// 也加不了 STRICT，只能"建新表 → 搬数据 → 删旧表 → 新表改名"。schema 质量第一次用它把全部表换成 STRICT；
// 以后要给已有表加 CHECK（比如枚举多一个值）也走这里。
//
// 调用方是迁移执行器（db.mjs 的 openDb）：它已在事务外关了外键、开了 BEGIN IMMEDIATE、提交前核 foreign_key_check。
// 这里负责其余几步里容易漏的：
//   - 触发器先全部拆掉、最后原样建回（v16 重建 params 时就丢过"只增不删"触发器；触发器正文可能引用别的表，
//     改名时 SQLite 会去解析它们，所以不只是被重建表自己的）；
//   - 索引随旧表一起删了，最后原样建回；
//   - AUTOINCREMENT 的计数器（sqlite_sequence）照原值续上：只按搬过来的最大 id 算，删过尾部行的表会复用 id；
//   - 新加的 CHECK 先拿旧数据试一遍，有违例就带着表名 / 约束名 / 行号报出来（而不是一句 "CHECK constraint failed"），
//     整个迁移回滚，库停在原版本；
//   - 搬完核行数。

const HEAD = /^\s*CREATE\s+TABLE\s+(?:"([^"]+)"|(\w+))\s*\(/i;

/**
 * @param {import('node:sqlite').DatabaseSync} raw  迁移执行器给的原始句柄（事务已开、外键已关）
 * @param {Array<{table: string, checks?: Array<{name: string, expr: string}>, strict?: boolean, rewrite?: (body: string) => string}>} plan
 *   rewrite：改已有的列定义 / 约束（例：枚举多一个值）。拿到括号里的整段，返回新的一段；没改动就抛（防着改了个寂寞）
 * @param {{suffix: string}} opts  临时表后缀，形如 '_v29'（tests/schema.test.mjs 认得这个形状）
 * @returns {{rebuilt: string[]}}
 */
export function rebuildTables(raw, plan, { suffix }) {
  if (!/^_v\d+$/.test(suffix)) throw new Error(`临时表后缀要形如 _v29：${suffix}`);
  const saved = raw.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type DESC, name`).all();
  for (const t of saved.filter((o) => o.type === 'trigger')) raw.exec(`DROP TRIGGER "${t.name}"`);
  const hasSeq = !!raw.prepare(`SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'`).get();
  const rebuilt = [];
  for (const { table, checks = [], strict = true, rewrite = null } of plan) {
    const row = raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    if (!row) throw new Error(`重建：没有表 ${table}`);
    const sql = row.sql;
    const m = HEAD.exec(sql);
    if (!m) throw new Error(`重建：认不出 ${table} 的建表语句开头`);
    const close = sql.lastIndexOf(')');
    const tail = sql.slice(close + 1).trim();
    if (tail && !/^STRICT$/i.test(tail)) throw new Error(`重建：${table} 的建表语句结尾有不认识的选项 "${tail}"`);
    // 先拿旧数据试新约束：违例的行带出来，人才知道改哪一行
    for (const c of checks) {
      const badRows = raw.prepare(`SELECT rowid AS r FROM "${table}" WHERE NOT (${c.expr}) LIMIT 5`).all();
      if (badRows.length) throw new Error(`重建 ${table}：已有数据不满足新约束 ${c.name}（${c.expr}），如 rowid ${badRows.map((x) => x.r).join('、')} —— 迁移已回滚，库没动`);
    }
    const tmp = `${table}${suffix}`;
    let body = sql.slice(m[0].length, close);
    if (rewrite) { const nb = rewrite(body); if (nb === body) throw new Error(`重建 ${table}：rewrite 没有改动任何东西`); body = nb; }
    const extra = checks.map((c) => `\n  , CONSTRAINT ${c.name} CHECK (${c.expr})`).join('');
    // 新约束另起一行接在后面：原语句最后一列后面可能跟着 -- 注释，接在同一行会被注释吞掉
    raw.exec(`CREATE TABLE "${tmp}" (${body}${extra}\n)${strict || /^STRICT$/i.test(tail) ? ' STRICT' : ''}`);
    const cols = raw.prepare(`PRAGMA table_xinfo("${table}")`).all().filter((c) => c.hidden === 0).map((c) => `"${c.name}"`).join(', ');
    const seq = hasSeq ? raw.prepare(`SELECT seq FROM sqlite_sequence WHERE name=?`).get(table)?.seq ?? null : null;
    const before = raw.prepare(`SELECT count(*) n FROM "${table}"`).get().n;
    raw.exec(`INSERT INTO "${tmp}" (${cols}) SELECT ${cols} FROM "${table}"`);
    const after = raw.prepare(`SELECT count(*) n FROM "${tmp}"`).get().n;
    if (after !== before) throw new Error(`重建 ${table}：搬过去 ${after} 行，原有 ${before} 行`);
    raw.exec(`DROP TABLE "${table}"`);
    raw.exec(`ALTER TABLE "${tmp}" RENAME TO "${table}"`);
    if (seq != null) {
      const cur = raw.prepare(`SELECT seq FROM sqlite_sequence WHERE name=?`).get(table)?.seq;
      if (cur == null) raw.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`).run(table, seq);
      else if (cur < seq) raw.prepare(`UPDATE sqlite_sequence SET seq=? WHERE name=?`).run(seq, table);
    }
    rebuilt.push(table);
  }
  // 索引（随旧表删了的）与触发器（开头全拆了的）原样建回；所属表已不在的（被同一迁移删掉的死表）跳过
  const tables = new Set(raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name));
  for (const o of saved) {
    if (!tables.has(o.tbl_name)) continue;
    if (o.type === 'index' && raw.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(o.name)) continue;
    raw.exec(o.sql);
  }
  return { rebuilt };
}
