// 签收以例外为中心。
//
// 签收人手里原来只有"产物 + 改动 + 截图"，过程里出过的岔子都埋在各步骤的详情、活动记录里 ——
// 人不会一步步点开看，于是签收退化成看一眼截图就点接受（自动化偏差：Bainbridge 1983，Parasuraman & Manzey 2010）。
// 这里把"不是一次就顺利过的地方"机械地捞出来，置顶在签收卡上：
//   defaulted     没人答、到点按默认走了的问题
//   self_decided  AI 替人定的事 / 凭据不实的假设（must_disclose）
//   rejections    被打回过的步骤：机械校验几次、AI 验收几次、最后第几次交才过
//   tests         改了任务开始前就有的测试，人放没放行
//   ui_unverified AI 验收放行了、但页面上没验成的界面条目
//   scope         越界改动被拒、撤回后才过的
// 纯查询、零模型调用。返回结构，文字由调用方按语言出（签收事项正文、看板、命令行）。

import { roundsOf } from './diagnose.mjs';
import { latestTestChanges, testsAllowedFor } from './test-guard.mjs';
import { hasMark } from '../i18n/marks.mjs';
import { tl } from '../i18n/index.mjs';

export const EXCEPTION_KINDS = ['self_decided', 'defaulted', 'tests', 'ui_unverified', 'scope', 'rejections'];
// 三档（认知走查：八条平铺、不分轻重，签收人分不清哪条要自己动手、哪条只是过程记录）：
//   decide 要你拍板 —— AI 替人定的、没人答按默认走的：不同意就打回写明要哪种
//   check  要你核对 —— 系统没能替人确认的：没人放行的原有测试改动、页面上没验成的条目、越界没撤回、最后也没过的步骤
//   info   仅告知   —— 过程中出过问题、最后已通过检查与 AI 验收的
export const EXCEPTION_TIERS = ['decide', 'check', 'info'];
export const tierOf = (e) => (e.kind === 'self_decided' || e.kind === 'defaulted' ? 'decide'
  : e.kind === 'tests' ? (e.allowed ? 'info' : 'check')
    : e.kind === 'ui_unverified' ? 'check'
      : e.kind === 'scope' ? (e.passed ? 'info' : 'check')
        : e.passedAt ? 'info' : 'check');

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** @returns [{ kind, nodeId?, title?, ...具体字段 }]，按 EXCEPTION_KINDS 的顺序 */
export function signoffExceptions(db, taskId) {
  const out = [];
  const nodes = db.all(`SELECT id, title, status FROM nodes WHERE task_id=? AND status<>'void' ORDER BY created_at, rowid`, taskId);

  // 没人答、按默认走了（AI 自选项过目事项另算：它们就是下面 self_decided 那一类，不重复）
  const nameOf = (id) => db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id;
  for (const q of db.all(`SELECT id, node_id, text, default_action, addressed_to, asked_at FROM questions WHERE task_id=? AND status='defaulted' ORDER BY asked_at`, taskId)) {
    if (hasMark(q.text, 'choices')) continue;
    // 问过谁：走查里签收人读到"没人答"先心虚是不是自己漏了
    out.push({ kind: 'defaulted', questionId: q.id, nodeId: q.node_id, text: clip(q.text, 160), defaultAction: clip(q.default_action, 160),
      askedOf: (json(q.addressed_to) ?? []).map(nameOf), askedAt: q.asked_at });
  }

  // AI 替人定的事 / 凭据不实：同一步只认最近一次交接里的说法（与过目事项同一口径）
  const as = db.all(`SELECT id, node_id, subject_key, statement, verified_against, verification, status, recorded_at FROM assumptions
    WHERE task_id=? AND superseded_at IS NULL AND status IN ('active','conflicted') AND (must_disclose=1 OR verified_against='settled_by_me')
    ORDER BY recorded_at, rowid`, taskId);
  const latest = new Map();
  for (const a of as) if (a.node_id) latest.set(a.node_id, Math.max(latest.get(a.node_id) ?? 0, a.recorded_at));
  for (const a of as.filter((x) => !x.node_id || x.recorded_at === latest.get(x.node_id))) {
    out.push({ kind: 'self_decided', nodeId: a.node_id, subject: a.subject_key, statement: clip(a.statement, 200),
      how: a.verified_against === 'settled_by_me' ? 'settled' : a.verified_against === 'own_artifact' ? 'circular' : 'weak', conflicted: a.status === 'conflicted' });
  }

  const titleOf = new Map(nodes.map((n) => [n.id, n.title]));
  for (const n of nodes) {
    const rounds = roundsOf(db, n.id);
    const mech = rounds.filter((r) => r.kind === 'mech'), ver = rounds.filter((r) => r.kind === 'verifier');
    // 被打回过：几次、最后第几次交才过；AI 验收打回的理由（去重）就是它与执行器的分歧
    if (mech.length || ver.length) {
      const passAt = rounds.findIndex((r) => r.kind === 'pass');
      // AI 验收的理由在前，机械检查的在后（只被机械检查打回过的步骤原来一条都没有，"当时的问题："后面是空的）
      const said = [...new Set([...ver, ...mech].flatMap((r) => r.defects.map((d) => clip(d.summary, 140))).filter(Boolean))].slice(0, 4);
      out.push({ kind: 'rejections', nodeId: n.id, title: n.title, mech: mech.length, verifier: ver.length,
        passedAt: passAt >= 0 ? rounds.slice(0, passAt + 1).filter((r) => r.kind !== 'env').length : null, said });
    }
    // 越界改动被拒、撤回后才过
    const scoped = [...new Set(rounds.flatMap((r) => r.defects.filter((d) => d.category === 'scope' || d.category === 'shared').flatMap((d) => d.locations ?? [])))];
    if (rounds.some((r) => r.defects.some((d) => d.category === 'scope' || d.category === 'shared'))) {
      out.push({ kind: 'scope', nodeId: n.id, title: n.title, paths: scoped.slice(0, 8), passed: rounds.at(-1)?.kind === 'pass' });
    }
    // 改了原有测试
    const tc = latestTestChanges(db, n.id).filter((c) => c.baseline);
    if (tc.length) {
      const allowed = testsAllowedFor(db, n.id);
      out.push({ kind: 'tests', nodeId: n.id, title: n.title, paths: tc.map((c) => c.path), kinds: [...new Set(tc.flatMap((c) => c.findings.map((f) => f.kind)))],
        allowed: tc.every((c) => allowed.has(c.path)) });
    }
    // 页面上没验成的界面条目：只看最近一次验收，而且它放行了（打回的会再验）
    const v = json(db.one(`SELECT payload FROM audit_log WHERE action='handoff_verified' AND target_id=? ORDER BY id DESC LIMIT 1`, n.id)?.payload);
    const nc = (v?.ui?.checks ?? []).filter((c) => c.result === 'not_checked');
    if (v?.verdict === 'accept' && nc.length) {
      out.push({ kind: 'ui_unverified', nodeId: n.id, title: n.title, total: v.ui.checks.length, items: nc.map((c) => clip(c.item, 140)),
        why: v.ui.live?.why ? clip(v.ui.live.why, 160) : null, appDown: ['none', 'failed'].includes(v.ui.live?.state),
        // 起服务的输出尾部：签收人据此分是环境的事还是代码的事
        log: json(db.one(`SELECT payload FROM audit_log WHERE action='live_app_session' AND target_id=? ORDER BY id DESC LIMIT 1`, n.id)?.payload)?.log?.slice(-800) ?? null });
    }
  }
  for (const e of out) { if (e.nodeId && !e.title) e.title = titleOf.get(e.nodeId) ?? null; e.tier = tierOf(e); }
  // 同一步要人拍板 / 核对时，它的打回经过是核对用的背景（走查：「期望值照实现抄过」收在"仅告知"里，核对测试时看不到）：
  // 挂到那一条上，不再单列
  const merged = out.filter((e) => {
    if (e.kind !== 'rejections' || e.tier !== 'info') return true;
    const host = out.find((x) => x !== e && x.nodeId === e.nodeId && x.tier !== 'info');
    if (!host) return true;
    host.history = { n: e.mech + e.verifier, said: e.said };
    return false;
  });
  // 应用起不来排在核对档最前：它不是"看一眼"，是这一步的界面一条都没验
  const rank = (e) => EXCEPTION_TIERS.indexOf(e.tier) * 10 + (e.appDown ? -1 : EXCEPTION_KINDS.indexOf(e.kind));
  return merged.sort((a, b) => rank(a) - rank(b));
}

/** 一条例外的一句话（签收事项正文、命令行用；看板自己按结构画）。所在的档由 renderExceptions 的小标题交代 */
export function describeException(e, L) {
  const h = !e.history ? '' : e.history.said.length ? tl(L, '；这一步之前被检查打回过 {n} 次，最后一次验收通过；当时的问题：{said}', { n: e.history.n, said: e.history.said.join(tl(L, '；')) })
    : tl(L, '；这一步之前被检查打回过 {n} 次，最后一次验收通过', { n: e.history.n });
  return describeOne(e, L) + h;
}
function describeOne(e, L) {
  const at = e.title ? tl(L, '「{title}」', { title: e.title }) : '';
  const list = (xs) => xs.join(tl(L, '、'));
  switch (e.kind) {
    case 'defaulted': return tl(L, '没人答、按默认走了：{text} → {action}', { text: e.text, action: e.defaultAction })
      + (e.askedOf?.length ? tl(L, '（问的是 {who}）', { who: list(e.askedOf) }) : '');
    case 'self_decided': return tl(L, '{at}AI 替人定的事（{how}）：{statement}', { at, statement: e.statement,
      how: e.how === 'settled' ? tl(L, '规格没写，它自己选的') : e.how === 'circular' ? tl(L, '拿自己的产物当依据') : tl(L, '依据不具体') });
    case 'rejections': return (e.passedAt ? tl(L, '{at}被打回 {n} 次，最后一次验收通过', { at, n: e.mech + e.verifier }) : tl(L, '{at}被打回 {n} 次，还没通过', { at, n: e.mech + e.verifier }))
      + (e.said.length ? tl(L, '；当时的问题：{said}', { said: e.said.join(tl(L, '；')) }) : '');
    case 'tests': return tl(L, '{at}改了任务开始前就有的测试：{paths}（{what}）{allowed}', { at, paths: list(e.paths), what: list(e.kinds.map((k) => testKindName(k, L))), allowed: e.allowed ? tl(L, '，人已放行') : '' });
    case 'ui_unverified': return e.appDown
      ? tl(L, '{at}应用在沙箱里没起来，这一步的页面检查一项都没做（{n} 项）：{items}', { at, n: e.items.length, items: e.items.join(tl(L, '；')) }) + (e.why ? tl(L, '。原因：{why}', { why: e.why }) : '')
      : tl(L, '{at}{total} 项页面检查里有 {n} 项没做成：{items}', { at, total: e.total ?? e.items.length, n: e.items.length, items: e.items.join(tl(L, '；')) });
    case 'scope': return tl(L, e.passed ? '{at}改了范围外的文件，被拒后撤回了：{paths}' : '{at}改了范围外的文件被拒，还没撤回：{paths}', { at, paths: list(e.paths) || tl(L, '（没记路径）') });
    default: return e.kind;
  }
}
const testKindName = (k, L) => ({ deleted: tl(L, '删了文件'), skip_added: tl(L, '加了跳过'), focus_added: tl(L, '加了只跑（only）'), tests_down: tl(L, '用例变少'), asserts_down: tl(L, '断言变少'), expect_changed: tl(L, '改了期望值') })[k] ?? k;

/** 三档的小标题：这一档是什么、签收人该怎么办 */
export const tierHead = (t, L) => ({
  decide: tl(L, '要你拍板：规格没写或没人答，AI 替你定了；不同意就打回，写明你要哪种'),
  check: tl(L, '要你核对：系统没能替你确认，接受前自己看一眼'),
  info: tl(L, '仅告知：过程中出过问题，最后已通过检查与 AI 验收，不用你处理'),
})[t];

/** 正文去掉那一节（收件箱摘要只有一行，例外另起一行显示；看板 webQText 用同一个形状） */
export const stripExceptions = (text) => String(text ?? '').replace(/(^|\n)## (签收前先看这些|Look at these before signing off)[^\n]*(\n[^\n]+)*\n*/, '$1');

/** 签收事项正文里的那一节（一整块、中间没有空行，看板与收件箱按这个形状把它去掉）。没有例外时也说一句（"没有"本身是签收人要知道的事） */
export function renderExceptions(list, L) {
  if (!list.length) return `${tl(L, '## 签收前先看这些')}\n${tl(L, '没有例外：每一步都一次过了检查与 AI 验收，没有替人定的事，没动原有测试，没有页面上没验成的条目。')}`;
  const todo = list.filter((e) => e.tier !== 'info').length;
  const out = [todo ? tl(L, '## 签收前先看这些（{n} 项要你处理）', { n: todo }) : tl(L, '## 签收前先看这些（没有要你处理的）')];
  for (const t of EXCEPTION_TIERS) {
    const xs = list.filter((e) => e.tier === t);
    if (xs.length) out.push(`**${tierHead(t, L)}**`, ...xs.map((e) => `- ${describeException(e, L)}`));
  }
  return out.join('\n');
}
