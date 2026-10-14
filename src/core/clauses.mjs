// 契约条款（修改溯源）：把一版契约（constitutions 行）切成一条条有稳定编号的条款。
//
// 原来出处只到"步骤 → 整份契约"，说不出是哪一条条款促成了这处改动。现在每版契约落库时切条、编号（C1、C2……），
// 存在 constitutions.clauses；步骤用出处边指向 "<契约 id>#<编号>"（core/provenance.mjs）。
//
// 编号跨版本稳定：新版里与上一版**同类、同文字**（空白归一）的条款沿用旧编号；新增或改了字的拿新编号
// （本任务用过的最大号 + 1，退役的号不复用）—— 于是"连接"在 PR、提交 trailer、看板里始终指同一句话。
//
// 纯函数、不依赖库：迁移（db/db.mjs）回填老数据也用这一份。

/** 条款种类：目标 / 范围 / 完成定义的一行 / 约束一条。 */
export const CLAUSE_KINDS = ['goal', 'scope', 'done', 'constraint'];

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const BULLET = /^\s*(?:[-*•·]|\d{1,3}[.)、]|[（(]\d{1,3}[)）])\s+/;
const isHeading = (l) => /[:：]\s*$/.test(l) && norm(l).length <= 200;

/** 完成定义按行切：去掉列表符号；以冒号结尾、后面还有内容的行是小标题，不算条款。 */
export function doneLines(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.replace(BULLET, '').trim());
  const out = [];
  lines.forEach((l, i) => {
    if (!l) return;
    if (isHeading(l) && lines.slice(i + 1).some((x) => x)) return;
    out.push(l);
  });
  return out;
}

/** 一版契约 → 未编号的条款 [{kind, text}]。 */
export function splitClauses(c) {
  const out = [];
  if (norm(c.goal)) out.push({ kind: 'goal', text: String(c.goal).trim() });
  if (norm(c.scope)) out.push({ kind: 'scope', text: String(c.scope).trim() });
  for (const l of doneLines(c.definition_of_done)) out.push({ kind: 'done', text: l });
  const cons = Array.isArray(c.constraints) ? c.constraints : (() => { try { return JSON.parse(c.constraints || '[]'); } catch { return []; } })();
  for (const x of cons) if (norm(x)) out.push({ kind: 'constraint', text: String(x).trim() });
  return out;
}

const numOf = (key) => Number(/^C(\d+)$/.exec(key ?? '')?.[1] ?? 0);

/**
 * 编号。prev：上一版的条款（带 key）；maxUsed：本任务历来用过的最大号（退役的号不复用）。
 * 同类同文字的沿用旧号（一一对应，重复的句子各占一个）；其余按出现顺序拿新号。
 */
export function assignClauseKeys(raw, { prev = [], maxUsed = 0 } = {}) {
  const pool = prev.map((p) => ({ ...p, n: norm(p.text), taken: false }));
  let next = Math.max(maxUsed, ...prev.map((p) => numOf(p.key)), 0);
  return raw.map((r) => {
    const hit = pool.find((p) => !p.taken && p.kind === r.kind && p.n === norm(r.text));
    if (hit) { hit.taken = true; return { key: hit.key, kind: r.kind, text: r.text }; }
    return { key: `C${++next}`, kind: r.kind, text: r.text };
  });
}

/** 本任务历来用过的最大号。rows：该任务各版契约的 clauses JSON。 */
export const maxClauseNum = (rows) => Math.max(0, ...rows.flatMap((r) => { try { return JSON.parse(r || '[]'); } catch { return []; } }).map((c) => numOf(c.key)));

/** 引文（规则的 quote）落在哪几条条款里：去空白后是条款文字的子串。 */
export function clausesQuoted(clauses, quote) {
  const q = String(quote ?? '').replace(/\[C\d+\]/g, '').replace(/\s+/g, '');
  if (q.length < 4) return [];
  return clauses.filter((c) => c.text.replace(/\s+/g, '').includes(q)).map((c) => c.key);
}

/** 给模型看的契约：每条前面标上 [Cn]。完成定义保留原来的行与小标题，只在条款行前加编号。 */
export function annotateDone(text, clauses) {
  const pool = clauses.filter((c) => c.kind === 'done').map((c) => ({ ...c, n: norm(c.text), taken: false }));
  return String(text ?? '').split(/\r?\n/).map((line) => {
    const bare = line.replace(BULLET, '').trim();
    if (!bare) return line;
    const hit = pool.find((p) => !p.taken && p.n === norm(bare));
    if (!hit) return line;
    hit.taken = true;
    const m = BULLET.exec(line);
    return m ? `${m[0]}[${hit.key}] ${line.slice(m[0].length).trimStart()}` : `[${hit.key}] ${line.trimStart()}`;
  }).join('\n');
}
