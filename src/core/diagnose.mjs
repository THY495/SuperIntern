// 诊断层：一个步骤每被打回一次，判一次它是在收敛、停滞、反复，还是卡在环境上。
//
// 一"轮" = 一次交接提交：机械校验打回、验收员打回，或通过。跨执行接着数（执行器一轮迭代用完、下次重试再来，
// 缺陷清单是连着的）；步骤被计划变更改了规格，从那之后重新数 —— 新规格是一件新活，与重试次数归零同理。
//
// 判据与默认值来自历史库回放（19 个实际运行库、235 个步骤）：
//   - 历史上到第 k 次打回仍没过的步骤，剔掉已修的根因后全部自己过了 —— 所以不加"第 k 次就转人"；
//   - 停滞（上一轮的缺陷全在、清单没变短）连续 STALL_ROUNDS 轮、反复（消失的缺陷又回来）OSC_RETURNS 次才转人，
//     两条在历史上都是 0 次触发：它们是护栏，没有真阳性样本，等实际运行数据再校；
//   - 环境问题（验收员没给出结论之类，不是执行器的改动造成的）单列：不算进停滞 / 反复，所在的那次停滞也不计重试。

import { contentLang, tl, N_ } from '../i18n/index.mjs';

const tlN = tl;   // 原文用 N_ 登记过的动态字符串走它（与 limits.mjs 同一个约定）

export const STALL_ROUNDS = 3;
export const OSC_RETURNS = 2;
/** 两条缺陷没有共同位置时，按一句话的词集合 Jaccard 判同一条；回放里 0.35 / 0.5 / 0.65 结论相同 */
export const SAME_DEFECT = 0.5;

/** 缺陷类别。机械校验与验收员各用一部分；environment 只由系统给 */
export const DEFECT_CATEGORIES = {
  // 验收员
  acceptance: N_('验收标准未满足'), spec: N_('偏离规格或契约'), decision: N_('该问人的事自己定了'), test: N_('测试问题'), quality: N_('其他问题'),
  // 机械校验
  scope: N_('越界改动'), shared: N_('改了共享路径'), rules: N_('改了项目规则或钩子文件'), artifact: N_('产物不对'), field: N_('交接记录缺项'), git: N_('算不出改动'),
  // 两边都有
  assumption: N_('假设'),
  environment: N_('环境问题'),
};
export const VERIFIER_CATEGORIES = ['acceptance', 'spec', 'decision', 'test', 'scope', 'quality'];

const normLoc = (l) => String(l ?? '').trim().replace(/\\/g, '/').replace(/:\d+(-\d+)?$/, '').replace(/^\.\//, '');

/** 一句话 → 可比较的词集合：去掉前缀、行号与标点；中文不分词，按相邻两字切（换个说法也认得出是同一条） */
export function defectTokens(s) {
  const out = new Set();
  const runs = String(s ?? '').replace(/^\[验收员\]\s*/, '').replace(/^假设 [^：]+：/, '').toLowerCase()
    .replace(/:\d+(-\d+)?/g, '').split(/[^\p{L}\p{N}_./-]+/u);
  for (const w of runs) {
    for (const part of w.split(/([\p{Script=Han}]+)/u)) {
      if (!part) continue;
      if (/\p{Script=Han}/u.test(part)) { if (part.length === 1) continue; for (let i = 0; i + 1 < part.length; i++) out.add(part.slice(i, i + 2)); }
      else if (part.length >= 2) out.add(part);
    }
  }
  return out;
}
const jaccard = (a, b) => { if (!a.size && !b.size) return 1; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

/** 两条缺陷是不是同一条：类别相同且位置有交集；都没有位置时看一句话像不像 */
export function sameDefect(a, b) {
  if (a.category && b.category && a.category !== b.category && a.category !== 'quality' && b.category !== 'quality') return false;
  const la = [].concat(a.locations ?? (a.location ? [a.location] : [])).map(normLoc).filter(Boolean);
  const lb = [].concat(b.locations ?? (b.location ? [b.location] : [])).map(normLoc).filter(Boolean);
  if (la.length && lb.length) return la.some((x) => lb.includes(x));
  return jaccard(defectTokens(a.summary), defectTokens(b.summary)) >= SAME_DEFECT;
}

/** 旧审计行（没有 defects 字段）：从文字里尽量还原。位置取反引号里的路径或 文件:行 */
export function defectsFromErrs(errs, by) {
  return (errs ?? []).map((e) => {
    const s = String(e);
    const locs = [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const fl = s.match(/([\w./-]+\.[a-z]{1,5}):\d+/i);
    if (fl) locs.push(fl[1]);
    let category = by === 'verifier' ? 'quality' : 'field';
    if (/^\[验收员\] 假设 |assumption/i.test(s)) category = 'assumption';
    else if (/^越界改动|out of scope/i.test(s)) category = 'scope';
    else if (/^改了共享路径|shared path/i.test(s)) category = 'shared';
    else if (/^artifacts/i.test(s)) category = 'artifact';
    else if (/验收员没有给出结论/.test(s)) category = 'environment';
    return { category, summary: s.replace(/^\[验收员\]\s*/, ''), locations: [...new Set(locs)] };
  });
}

/**
 * 这个步骤从最近一次被改规格（或建出来）以来的每一轮。
 * @returns [{ kind: 'mech'|'verifier'|'env'|'pass', defects, auditId, at }]
 */
export function roundsOf(db, nodeId) {
  const since = db.one(`SELECT MAX(recorded_at) t FROM edges WHERE from_id=? AND relation='derived_from'`, nodeId)?.t ?? 0;
  const rows = db.all(`SELECT id, ts, actor_id, action, payload FROM audit_log
    WHERE target_type='node' AND target_id=? AND action IN ('handoff_rejected','node_done') AND ts>=? ORDER BY id`, nodeId, since);
  return rows.map((r) => {
    if (r.action === 'node_done') return { kind: 'pass', defects: [], auditId: r.id, at: r.ts };
    let p = {}; try { p = JSON.parse(r.payload); } catch { /* 坏行当空 */ }
    const by = p.by === 'verifier' || r.actor_id === 'verifier' ? 'verifier' : 'mech';
    const defects = Array.isArray(p.defects) ? p.defects : defectsFromErrs(p.errs, by);
    const env = p.env === true || (defects.length > 0 && defects.every((d) => d.category === 'environment'));
    return { kind: env ? 'env' : by, defects, auditId: r.id, at: r.ts };
  });
}

/**
 * 判一次。只看缺陷轮（环境那几轮跳过），而且**只拿同一个检查方的相邻两轮比**：
 * 机械校验打回的那次，验收员根本没跑 —— 验收员那几条缺陷"这次没出现"是没查，不是改好了；
 * 混在一起比，"验收员打回 A → 机械打回 → 验收员又打回 A"会被误判成复发。
 * 机械校验在前：它过了验收员才跑，所以验收员那一轮里机械那几条确实是没有了。
 * @returns {{ state: 'none'|'first'|'converging'|'stalled'|'oscillating'|'environment'|'passed',
 *   round, rejections, streak, returns, open, resolved, added, escalate }}
 *   - resolved / added：比同一检查方的上一次；说不出时为 null
 *   - streak：最近一次打回的检查方，末尾连续几轮"上一轮的缺陷全在、清单没变短"
 *   - returns：一共几次"上一轮没有、更早出现过"的缺陷又回来了（两个检查方各自数，相加）
 *   - escalate：该转人了（停滞到 STALL_ROUNDS 轮，或复发到 OSC_RETURNS 次）
 */
export function diagnose(rounds) {
  const all = rounds ?? [];
  const last = all.at(-1);
  const rej = all.filter((r) => r.kind === 'mech' || r.kind === 'verifier');
  const base = { round: all.length, rejections: rej.length, streak: 0, returns: 0, open: last?.defects ?? [], resolved: 0, added: 0, escalate: false };
  if (!last) return { ...base, state: 'none' };
  if (last.kind === 'pass') return { ...base, state: 'passed', open: [] };
  const walk = (seq) => {
    let streak = 0, returns = 0, resolved = 0, added = 0;
    for (let i = 1; i < seq.length; i++) {
      const prev = seq[i - 1].defects, cur = seq[i].defects;
      const kept = prev.filter((a) => cur.some((b) => sameDefect(a, b))).length;
      const older = seq.slice(0, i - 1).flatMap((r) => r.defects);
      const back = cur.filter((b) => !prev.some((a) => sameDefect(a, b)) && older.some((a) => sameDefect(a, b))).length;
      const stuck = prev.length > 0 && kept === prev.length && cur.length >= prev.length;
      streak = stuck ? streak + 1 : 0;
      if (back) returns++;
      if (i === seq.length - 1) { resolved = prev.length - kept; added = cur.filter((b) => !prev.some((a) => sameDefect(a, b))).length; }
    }
    return { streak, returns, resolved, added, n: seq.length };
  };
  const lastRej = rej.at(-1);
  const mine = walk(rej.filter((r) => r.kind === lastRej?.kind));
  const other = walk(rej.filter((r) => r.kind !== lastRej?.kind));
  const returns = mine.returns + other.returns;
  // 这个检查方头一回打回、上一次是另一方：机械 → 验收员，说明机械那几条都过了；验收员 → 机械，验收员那几条这次没查，说不出改没改
  let { resolved, added } = mine;
  if (mine.n === 1 && rej.length > 1) [resolved, added] = lastRej.kind === 'verifier' ? [rej.at(-2).defects.length, lastRej.defects.length] : [null, null];
  const out = { ...base, streak: mine.streak, returns, resolved, added };
  if (last.kind === 'env') return { ...out, state: 'environment' };
  if (rej.length <= 1) return { ...out, state: 'first' };
  const state = returns >= 1 && returns >= mine.streak ? 'oscillating' : mine.streak >= 1 ? 'stalled' : 'converging';
  return { ...out, state, escalate: (state === 'oscillating' && returns >= OSC_RETURNS) || (state === 'stalled' && mine.streak >= STALL_ROUNDS) };
}

export const DIAG_NAMES = { none: N_('还没交过'), first: N_('第一次被打回'), converging: N_('有进展'), stalled: N_('停滞'), oscillating: N_('复发'), environment: N_('环境问题'), passed: N_('已通过') };

/** 给人看的一句话（看板、上限事项、转人的事项里用同一句） */
export function describeDiagnosis(d, lang) {
  const L = lang;
  switch (d.state) {
    case 'first': return tl(L, '第一次被打回（{n} 条缺陷）', { n: d.open.length });
    case 'converging': return d.resolved == null ? tl(L, '有进展：被打回 {r} 次，还剩 {n} 条', { r: d.rejections, n: d.open.length })
      : tl(L, '有进展：被打回 {r} 次；比上一次交，解决了 {fixed} 条、新冒出 {added} 条，还剩 {n} 条', { r: d.rejections, fixed: d.resolved, added: d.added, n: d.open.length });
    case 'stalled': return tl(L, '停滞：最近 {m} 次交都卡在同样的缺陷上，一条没少（被打回 {r} 次，还剩 {n} 条）', { m: d.streak + 1, r: d.rejections, n: d.open.length });
    case 'oscillating': return tl(L, '复发：改好的缺陷又回来了 {k} 次（被打回 {r} 次，还剩 {n} 条）', { k: d.returns, r: d.rejections, n: d.open.length });
    case 'environment': return tl(L, '环境问题：最近一轮不是改动本身的问题（{why}），不计入停滞与重试', { why: d.open[0]?.summary?.slice(0, 120) ?? '' });
    case 'passed': return tl(L, '已通过（之前被打回 {r} 次）', { r: d.rejections });
    default: return tl(L, '还没交过');
  }
}

/** 缺陷清单的文字版（转人的事项、上限事项里列出来） */
export function listDefects(defects, lang, { max = 8 } = {}) {
  const L = lang;
  const lines = defects.slice(0, max).map((d) => {
    const cat = DEFECT_CATEGORIES[d.category] ? tlN(L, DEFECT_CATEGORIES[d.category]) : d.category;
    const loc = [].concat(d.locations ?? (d.location ? [d.location] : [])).filter(Boolean);
    return `- [${cat}] ${String(d.summary ?? '').slice(0, 300)}${loc.length ? tl(L, '（{loc}）', { loc: loc.slice(0, 3).join(tl(L, '、')) }) : ''}`;
  });
  if (defects.length > max) lines.push(tl(L, '……另有 {n} 条', { n: defects.length - max }));
  return lines.join('\n');
}

/** 这个步骤此刻的诊断（读库） */
export function nodeDiagnosis(db, nodeId) { return diagnose(roundsOf(db, nodeId)); }

/** 上限事项、转人事项里附的一段：诊断 + 还剩的缺陷 */
export function diagnosisBlock(db, nodeId, lang = contentLang(db)) {
  const d = nodeDiagnosis(db, nodeId);
  if (['none', 'passed'].includes(d.state)) return '';
  return `${tl(lang, '**诊断**：{what}', { what: describeDiagnosis(d, lang) })}${d.open.length ? `\n${listDefects(d.open, lang)}` : ''}`;
}
