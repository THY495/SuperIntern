// 测试改动检测：交接时机械比对这一步对测试文件做了什么 ——
// 删了测试文件、加了 skip / only、用例数或断言数下降、改了期望值。
//
// 只做"看得出来的信号"，不判对错：重写测试有正当理由（规格改了、测试本来就写错了），
// 判断交给验收员与人。这里的产出是**结构化证据**：给验收员看、记进审计、在看板上置顶。
// 要不要"检出即打回"、基线测试默认只读，先用历史库回放量化误拦，再定默认值。
//
// 认得的写法：JS/TS（node:test、mocha、jest、vitest、ava、tap）、Python（pytest、unittest）、Go（testing）。
// 认不出语言的测试文件照样报"删了"，其余信号不报 —— 宁可漏，不乱报。

import { tl } from '../i18n/index.mjs';
import { audit } from '../db/db.mjs';

/** 测试文件：按目录或文件名约定认 */
const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs)\//i;
const TEST_FILE = /(^|\/)(test_[^/]+\.py|[^/]+_test\.(py|go)|[^/]+\.(test|spec)\.[cm]?[jt]sx?|conftest\.py)$/i;
export const isTestPath = (p) => TEST_DIR.test(p) || TEST_FILE.test(p);

const langOf = (p) => (/\.py$/i.test(p) ? 'py' : /\.go$/i.test(p) ? 'go' : /\.[cm]?[jt]sx?$/i.test(p) ? 'js' : null);

const PAT = {
  js: {
    comment: /^\s*(\/\/|\*|\/\*)/,
    // test.skip / it.only 也是一个用例：跳过算 skip_added，不再重复算成"用例变少"
    test: /^\s*(it|test|xit|fit)(\.(skip|only|todo|concurrent|serial|failing)|\.each\s*\(.*?\))*\s*\(/,
    assert: /\bassert(\.\w+)*\s*\(|\bexpect\s*\(|\.should\.|\bt\.(is|not|deepEqual|equal|true|false|ok|throws|rejects|assert|match)\w*\s*\(/,
    skip: /\b(it|test|describe|suite)\.(skip|todo)\b|\bx(it|test|describe)\s*\(|\{\s*(skip|todo)\s*:\s*(true|['"`])|\bt\.(skip|todo)\s*\(/,
    focus: /\b(it|test|describe|suite)\.only\b|\bf(it|describe)\s*\(|\{\s*only\s*:\s*true/,
  },
  py: {
    comment: /^\s*#/,
    test: /^\s*(async\s+)?def\s+test\w*\s*\(/,
    assert: /^\s*assert\b|\bself\.assert\w+\s*\(|\bpytest\.raises\s*\(|\bpytest\.approx\s*\(/,
    skip: /@pytest\.mark\.(skip|skipif|xfail)\b|@unittest\.(skip|skipIf|skipUnless|expectedFailure)\b|\bpytest\.(skip|xfail)\s*\(|\bself\.skipTest\s*\(/,
    focus: null,
  },
  go: {
    comment: /^\s*\/\//,
    test: /^func\s+Test\w*\s*\(/,
    assert: /\bt\.(Error|Errorf|Fatal|Fatalf)\s*\(|\b(assert|require)\.\w+\s*\(/,
    skip: /\bt\.(Skip|Skipf|SkipNow)\s*\(/,
    focus: null,
  },
};

// 行尾注释也剥掉（一行写完的用例里注释掉断言，`test('a', () => { // assert…` 也是断言变少）。
// 只认前面是空白或 ; { } 的 // 与 #，免得把字符串里的 http:// 、'#1' 当成注释
const stripTail = (l, pat) => (pat === PAT.py ? l.replace(/(^|\s)#.*$/, '$1') : l.replace(/(^|[\s;{}])\/\/.*$/, '$1'));
const codeLines = (text, pat) => String(text ?? '').split(/\r?\n/).filter((l) => l.trim() && !pat.comment.test(l)).map((l) => stripTail(l, pat)).filter((l) => l.trim());
const count = (lines, re) => (re ? lines.filter((l) => re.test(l)).length : 0);

/** 一份测试文件里的信号：用例数、断言数、skip / only 行 */
export function testSignals(text, path) {
  const pat = PAT[langOf(path)];
  if (!pat) return null;
  const lines = codeLines(text, pat);
  return { tests: count(lines, pat.test), asserts: count(lines, pat.assert), skips: lines.filter((l) => pat.skip.test(l)).map((l) => l.trim()),
    focus: pat.focus ? lines.filter((l) => pat.focus.test(l)).map((l) => l.trim()) : [] };
}

// 期望值改了：删掉的断言行与新加的断言行，把字面量换成占位符以后一模一样 —— 只是"答案"变了
const LITERAL = /(["'`])(?:\\.|(?!\1).)*\1|\b\d+(\.\d+)?\b|\b(true|false|True|False|None|null|undefined)\b/g;
const shape = (l) => l.trim().replace(LITERAL, '§');
const multisetMinus = (a, b) => { const m = new Map(); for (const x of b) m.set(x, (m.get(x) ?? 0) + 1); return a.filter((x) => { const n = m.get(x) ?? 0; if (n) { m.set(x, n - 1); return false; } return true; }); };

/**
 * 一个测试文件改动前后比一次。before = null 表示新建，after = null 表示删了。
 * @returns [{ kind, ... }]，kind ∈ deleted / skip_added / focus_added / tests_down / asserts_down / expect_changed
 */
export function compareTest(before, after, path) {
  if (before == null) return [];                       // 新建的测试文件：没有"原来"，不比
  if (after == null) return [{ kind: 'deleted' }];
  const pat = PAT[langOf(path)];
  if (!pat) return [];
  const b = testSignals(before, path), a = testSignals(after, path);
  const out = [];
  const newSkips = multisetMinus(a.skips, b.skips), newFocus = multisetMinus(a.focus, b.focus);
  if (newSkips.length) out.push({ kind: 'skip_added', lines: newSkips.slice(0, 5) });
  if (newFocus.length) out.push({ kind: 'focus_added', lines: newFocus.slice(0, 5) });
  const bl = codeLines(before, pat).filter((l) => pat.assert.test(l)), al = codeLines(after, pat).filter((l) => pat.assert.test(l));
  const removed = multisetMinus(bl, al), added = multisetMinus(al, bl);
  const pairs = [], gone = [];
  const pool = [...added];
  for (const r of removed) {
    const i = pool.findIndex((x) => shape(x) === shape(r));
    if (i >= 0) { pairs.push({ from: r.trim(), to: pool[i].trim() }); pool.splice(i, 1); } else gone.push(r.trim());
  }
  // 变少的带上没了的那几行原文（看板走查：只给 6 → 4，人看不到少的是哪两条）
  if (a.tests < b.tests) out.push({ kind: 'tests_down', before: b.tests, after: a.tests, lines: multisetMinus(codeLines(before, pat).filter((l) => pat.test.test(l)), codeLines(after, pat).filter((l) => pat.test.test(l))).map((l) => l.trim()).slice(0, 5) });
  if (a.asserts < b.asserts) out.push({ kind: 'asserts_down', before: b.asserts, after: a.asserts, lines: gone.slice(0, 5) });
  if (pairs.length) out.push({ kind: 'expect_changed', pairs: pairs.slice(0, 5), total: pairs.length });
  return out;
}

/**
 * 这一步改过的测试文件逐个比一遍。
 * @param read(path, ref) → 文本或 null（ref = null 表示工作区现状）
 * @param baselineHas(path) → 这个文件在任务开工时就有（"基线测试"，别人写的 / 原有的）
 * @returns [{ path, baseline, findings }]，只列有信号的
 */
export function testChanges({ changed, base, read, baselineHas }) {
  const out = [];
  for (const p of [...(changed ?? [])].filter(isTestPath).sort()) {
    let before = null, after = null;
    try { before = read(p, base); } catch { before = null; }
    try { after = read(p, null); } catch { after = null; }
    const findings = compareTest(before, after, p);
    if (findings.length) out.push({ path: p, baseline: !!baselineHas(p), findings });
  }
  return out;
}

/**
 * 人放行过的测试改动：答复这一步的事项时勾了"允许这一步改这些原有测试"。按步骤、按路径记在审计里。
 * reject 模式下放行过的不再打回；标注模式下照样比对，只是带上 allowed，验收员与看板都看得见"人允许过"。
 */
export function testsAllowedFor(db, nodeId) {
  const out = new Set();
  for (const r of db.all(`SELECT payload FROM audit_log WHERE action='test_change_allowed' AND target_type='node' AND target_id=?`, nodeId)) {
    try { for (const p of JSON.parse(r.payload).paths ?? []) out.add(p); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/**
 * 放行（答复事项时一并做）：把这条事项所在步骤此刻改了、还没放行的原有测试路径记下来。
 * 路径取自系统自己的比对，不收调用方传的路径 —— 人勾的是"上面列出的这些"，不能借这个口子放行别的文件。
 * @returns 放行了的路径（没有可放行的返回 []，不报错）
 */
export function allowTestChanges(db, { questionId, userId, answerId = null, at = Date.now() }) {
  const q = db.one(`SELECT node_id FROM questions WHERE id=?`, questionId);
  if (!q?.node_id) return [];
  const allowed = testsAllowedFor(db, q.node_id);
  const paths = latestTestChanges(db, q.node_id).filter((c) => c.baseline && !allowed.has(c.path)).map((c) => c.path);
  if (!paths.length) return [];
  audit(db, { actorKind: 'user', actorId: userId, action: 'test_change_allowed', targetType: 'node', targetId: q.node_id,
    payload: { questionId, answerId, paths, at } });
  return paths;
}

/** 这一步最近一次比出来的测试改动（handoff_test_changes）；放行的路径以它为准，不信客户端传来的路径 */
export function latestTestChanges(db, nodeId) {
  const r = db.one(`SELECT payload FROM audit_log WHERE action='handoff_test_changes' AND target_type='node' AND target_id=? ORDER BY id DESC LIMIT 1`, nodeId);
  try { return r ? JSON.parse(r.payload).changes ?? [] : []; } catch { return []; }
}

/** 一条信号的一句话（给验收员、事项正文、执行器的拒收理由用；看板自己按结构画） */
export function describeFinding(f, lang) {
  const L = lang, cut = (s) => String(s).slice(0, 160);
  switch (f.kind) {
    case 'deleted': return tl(L, '删了这个测试文件');
    case 'skip_added': return tl(L, '加了跳过：{lines}', { lines: f.lines.map(cut).join(' / ') });
    case 'focus_added': return tl(L, '加了只跑（only），同文件别的用例不再跑：{lines}', { lines: f.lines.map(cut).join(' / ') });
    case 'tests_down': return tl(L, '用例从 {b} 个变成 {a} 个', { b: f.before, a: f.after });
    case 'asserts_down': return tl(L, '断言从 {b} 处变成 {a} 处', { b: f.before, a: f.after });
    case 'expect_changed': return f.total === 1
      ? tl(L, '改了期望值：{from} → {to}', { from: cut(f.pairs[0].from), to: cut(f.pairs[0].to) })
      : tl(L, '改了 {n} 处期望值，例如 {from} → {to}', { n: f.total, from: cut(f.pairs[0].from), to: cut(f.pairs[0].to) });
    default: return f.kind;
  }
}

/** 整段文字：每个文件一行，标出是基线测试还是本任务写的 */
export function describeTestChanges(changes, lang) {
  return changes.map((c) => `- ${c.baseline ? (c.allowed ? tl(lang, '[原有测试，人已允许改]') : tl(lang, '[原有测试]')) : tl(lang, '[本任务写的测试]')} ${c.path}：${c.findings.map((f) => describeFinding(f, lang)).join(tl(lang, '；'))}`).join('\n');
}
