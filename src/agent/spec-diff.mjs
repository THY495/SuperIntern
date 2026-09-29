// 新旧两版方案的机械比对 + 这一轮的来回记录。
//
// 原来追加 / 复盘规划器每出一版，手里只有上一版和最新一条反馈。于是会出现 v4 退回成"已达成"、把 T2 整个丢了；
// v5 把 v3 写死的约束丢了（规划器自己在说明里写"上一版契约原文不在手头，是重建的"）。人每一版都得从头读一遍全文，
// 才发现少了东西 —— 没发现就批了。
//
// 两件事：
//   ① 规划器拿到这一轮的**全部**来回（每一版给人看的原文 + 人对每一版说的话），不只是最后一条；
//   ② 新版出来时，系统逐字比对上一版：少了哪个任务、哪条约束 / 规则找不到原文、从"给任务"变成了"已达成"，
//      写在批准事项的最前面。不经 AI —— 比对本身不能也是一次"重建"。

import { answerOf } from './elicitor.mjs';

const norm = (s) => String(s ?? '').replace(/\s+/g, '').replace(/[，。、；;,.!！:："“”'‘’（）()]/g, '').toLowerCase();
const titleKey = (t) => norm(String(t ?? '').replace(/^\s*(T|#)?\d+[\s.:：、-]*/i, ''));
const bigrams = (s) => { const x = norm(s); const out = new Set(); for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2)); return out; };
const similar = (a, b) => { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return false; let n = 0; for (const g of A) if (B.has(g)) n++; return n / Math.min(A.size, B.size) >= 0.6; };

/** 上一版的任务在新版里对应哪一个：先按去掉编号后的标题精确对，再按字面相似度对。 */
function matchTasks(prev, next) {
  const used = new Set(), pairs = [];
  for (const p of prev) {
    let j = next.findIndex((n, i) => !used.has(i) && titleKey(n.title) === titleKey(p.title));
    if (j < 0) j = next.findIndex((n, i) => !used.has(i) && similar(titleKey(n.title), titleKey(p.title)));
    if (j >= 0) used.add(j);
    pairs.push([p, j >= 0 ? next[j] : null]);
  }
  return { pairs, added: next.filter((_, i) => !used.has(i)) };
}

const itemsOf = (t, key) => (t?.[key] ?? []).map((x) => (typeof x === 'string' ? x : x?.rule ?? '')).filter(Boolean);

/**
 * prev / next：{ tasks: [...] } 或 { reached: { reason } }（复盘判"已达成"的那一版）。
 * 返回 { droppedTasks, addedTasks, droppedItems: [{ task, kind, text }], toReached, fromReached }。
 */
export function diffSpecs(prev, next) {
  const out = { droppedTasks: [], addedTasks: [], droppedItems: [], toReached: false, fromReached: false };
  if (!prev) return out;
  const pt = prev.tasks ?? [], nt = next?.tasks ?? [];
  if (prev.reached && !next?.reached) { out.fromReached = true; return out; }
  if (!prev.reached && next?.reached) { out.toReached = true; out.droppedTasks = pt.map((t) => t.title); return out; }
  const { pairs, added } = matchTasks(pt, nt);
  const allNext = new Set(nt.flatMap((t) => [...itemsOf(t, 'constraints'), ...itemsOf(t, 'rules')]).map(norm));
  for (const [p, n] of pairs) {
    if (!n) { out.droppedTasks.push(p.title); continue; }
    for (const [key, kind] of [['constraints', '约束'], ['rules', '规则']]) {
      for (const x of itemsOf(p, key)) if (!allNext.has(norm(x))) out.droppedItems.push({ task: n.title, kind, text: x });
    }
  }
  out.addedTasks = added.map((t) => t.title);
  return out;
}

/** 放在批准事项最前面的那一段；没有可说的返回 ''。 */
export function renderSpecDiff(d, { prevVersion }) {
  if (!d) return '';
  const L = [];
  if (d.toReached) {
    L.push(`⚠ 上一版（v${prevVersion}）给出的任务这一版都没有了：${d.droppedTasks.map((t) => `「${t}」`).join('、')} —— AI 这一版改判为"已经达成"。如果你没同意去掉它们：别确认达成，回复写明"还差这些"。`);
  } else if (d.fromReached) {
    L.push(`上一版（v${prevVersion}）判的是"已经达成"；这一版按你的反馈改为给出任务。`);
  } else {
    if (d.droppedTasks.length) L.push(`⚠ 上一版有、这一版没有的任务：${d.droppedTasks.map((t) => `「${t}」`).join('、')}`);
    if (d.droppedItems.length) {
      L.push(`⚠ 下面这些上一版的约束 / 规则，这一版里找不到一字不差的原文 —— 可能被删了，也可能只是改了措辞，请核对：`);
      for (const x of d.droppedItems.slice(0, 12)) L.push(`  - 「${x.task}」的${x.kind}：${x.text}`);
      if (d.droppedItems.length > 12) L.push(`  - ……另有 ${d.droppedItems.length - 12} 条`);
    }
    if (d.addedTasks.length) L.push(`新增的任务：${d.addedTasks.map((t) => `「${t}」`).join('、')}`);
  }
  if (!L.length) return `【和上一版（v${prevVersion}）比】任务都在，上一版的约束与规则原文都还在（系统逐字比对，不经 AI）。\n\n`;
  return `【和上一版（v${prevVersion}）比】（系统逐字比对，不经 AI）\n${L.join('\n')}\n\n`;
}

/**
 * 这一轮的来回：载体任务上、这一轮开始以后的方案批准事项，按先后，每条带人的答复。
 * 【先确认一下】那种不是新的一版，只带它的答复（并进前一版）。
 * 返回 { prevText, rounds: [{ version, answer }] }：prevText = 最近一版给人看的原文（规划器"上一版"就用它，不再自己重建）。
 */
export function roundHistory(db, { carrierId, sinceTs = 0 }) {
  const qs = db.all(`SELECT id, text, asked_at FROM questions WHERE task_id=? AND decision_type='contract_approval' AND asked_at>=? ORDER BY asked_at, rowid`, carrierId, sinceTs);
  const rounds = [];
  let prevText = null;
  for (const q of qs) {
    const a = answerOf(db, q.id);
    const isConfirm = String(q.text).startsWith('【先确认一下】');
    const v = Number(String(q.text).match(/v(\d+)】/)?.[1] ?? NaN);
    if (!isConfirm) { prevText = q.text; rounds.push({ version: Number.isFinite(v) ? v : rounds.length + 1, answers: [] }); }
    if (a && rounds.length) rounds.at(-1).answers.push(String(a.body).trim());
  }
  return { prevText, rounds: rounds.map((r) => ({ version: r.version, answer: r.answers.join('\n（确认时补充）') })) };
}

/** 给规划器的那一节："这一轮的全部来回"。只有一版、还没反馈时返回 ''。 */
export function renderRoundHistory(h) {
  const rs = (h?.rounds ?? []).filter((r) => r.answer);
  if (!rs.length) return '';
  return `## 这一轮到目前为止人的全部反馈（按先后；后面的覆盖前面的，**没被后面推翻的前面的要求仍然有效**）\n${rs.map((r) => `- 对 v${r.version}：${r.answer}`).join('\n')}\n\n`
    + '上一版里有的任务、约束、规则，人没要求去掉的，下一版**原文保留**（不要改写措辞、不要合并）；要去掉就在 notes 里说为什么。系统会逐字比对新旧两版，把少了的东西标给人看。';
}
