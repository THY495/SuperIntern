// 看板脚本里拼 HTML 的插值都要过转义。
//
// 看板用模板字符串拼 HTML 再塞进 innerHTML。任务标题、成员名、模型输出、仓库路径……都是外来的文字，
// 漏一处 esc() 就是一处存储型 XSS（团队模式下一个成员能在管理员的浏览器里以管理员身份做事）。CSP 挡住了内联脚本，
// 但挡不住注入一个伪造的「签收」按钮、伪造的登录表单、把页面改得面目全非，所以源头也要管住。
//
// 规则：凡是"像 HTML"的模板字符串（静态部分里有标签或属性），以及嵌在它插值里的模板字符串，每个 ${…} 都得是下面之一：
//   · 转义过的：esc(…)、encodeURIComponent(…)、CSS.escape(…)；
//   · T(…) / Tc(…) —— 原文是代码里写死的；但 T 的占位符参数照原样替换，所以参数值同样要满足这些规则；
//   · 字面量、数字运算（- * / % |）、.length、.toFixed(…)；三元 / || / ?? / && / + 的每一段都满足；
//   · xs.map(cb).join(sep)：cb 的结果、sep 满足；
//   · 变量 / 常量 / 本地函数：按作用域找到它的绑定，每一次赋值（函数则是每个 return）都满足 —— 拼好的片段放在变量里、
//     帮手函数返回片段的写法都认；函数参数、循环变量、解构出来的看不到来源，算不安全；
//   · 查表 NAME[k]：NAME 是对象字面量、每个值都满足；
//   · 逐条登记在 ALLOW 里、写明理由的。
// 新加一处没转义的插值 → 这里报出文件、行号、表达式。要么包 esc()，要么（确实安全）登记进 ALLOW 并写理由。
//
// 跑：node tests/web-html.test.mjs（WH_FULL=1 报出完整的追溯链；WH_TRACE=文件:行 列出那一行每处插值的判定）

import { readFileSync } from 'node:fs';
import { appScripts } from '../src/web/page-scripts.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };

// ── 词法：模板字符串（含嵌套）及每个插值的位置；哪些字符是代码（不在字符串 / 注释 / 正则 / 模板文字里）；括号的配对 ──
const REGEX_PREV = new Set([...'(,=:[!&|?{};+-*%<>~^', '', 'return', 'typeof', 'case', 'in', 'of', '=>']);
export function lex(src) {
  const templates = [], ranges = [];          // ranges：[开, 闭, 字符]，{ ( [ 都记
  const mask = new Uint8Array(src.length).fill(1);
  let i = 0, prev = '';
  const line = (k) => src.slice(0, k).split('\n').length;
  const word = (k) => { let j = k; while (j > 0 && /[\w$]/.test(src[j - 1])) j--; return src.slice(j, k); };
  function skipString(q) { const a = i; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } i++; mask.fill(0, a, i); }
  function skipRegex() { const a = i; i++; let cls = false; while (i < src.length) { const c = src[i]; if (c === '\\') { i += 2; continue; } if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break; else if (c === '\n') throw new Error(`正则没闭合：第 ${line(i)} 行`); i++; } i++; while (/[a-z]/.test(src[i] ?? '')) i++; mask.fill(0, a, i); }
  function readTemplate(parent) {
    const t = { start: i, line: line(i), quasis: [], exprs: [], parent }; templates.push(t);
    mask[i] = 0; i++; let q = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { q += src.slice(i, i + 2); mask.fill(0, i, i + 2); i += 2; continue; }
      if (c === '`') { mask[i] = 0; i++; t.quasis.push(q); t.end = i; return t; }
      if (c === '$' && src[i + 1] === '{') {
        t.quasis.push(q); q = ''; mask.fill(0, i, i + 2); i += 2;
        const s = i, inner = [];
        readCode('}', t, inner);
        mask[i - 1] = 0;
        t.exprs.push({ src: src.slice(s, i - 1), pos: s, line: line(s), inner });
        continue;
      }
      q += c; mask[i] = 0; i++;
    }
    throw new Error(`模板没闭合：第 ${t.line} 行`);
  }
  function readCode(close, parent, inner) {
    const stack = [];
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { const a = i; while (i < src.length && src[i] !== '\n') i++; mask.fill(0, a, i); continue; }
      if (c === '/' && src[i + 1] === '*') { const a = i; i = src.indexOf('*/', i + 2) + 2; mask.fill(0, a, i); continue; }
      if (c === '"' || c === "'") { skipString(c); prev = 'str'; continue; }
      if (c === '`') { const t = readTemplate(parent); inner?.push(t); prev = 'str'; continue; }
      if (c === '/') { if (REGEX_PREV.has(prev)) { skipRegex(); prev = 'str'; continue; } i++; prev = '/'; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if ('({['.includes(c)) stack.push(i);
      if (')}]'.includes(c)) { if (!stack.length && c === close) { i++; return; } const a = stack.pop(); ranges.push([a, i, src[a]]); }
      if (/[\w$]/.test(c)) { while (/[\w$]/.test(src[i] ?? '')) i++; const w = word(i); prev = /^\d/.test(w) || !REGEX_PREV.has(w) ? 'id' : w; continue; }
      if (c === '=' && src[i + 1] === '>') { i += 2; prev = '=>'; continue; }
      prev = c; i++;
    }
    if (close) throw new Error(`缺少 ${close}`);
  }
  readCode(null, null, null);
  return { templates, ranges, mask };
}

// ── 绑定：名字在某个位置指的是哪一处声明 ──
// 一个文件的信息：源码、代码掩码、括号；bindings 按名字缓存
function fileInfo(name, src) {
  const L = lex(src);
  const close = new Map(L.ranges.map(([a, b]) => [a, b]));
  return { name, src, ...L, close, cache: new Map() };
}
const span = (r) => r[1] - r[0];
const innermost = (F, pos, kinds = '{([') => { let best = null; for (const r of F.ranges) if (kinds.includes(r[2]) && r[0] < pos && pos < r[1] && (!best || span(r) < span(best))) best = r; return best; };
const nextNonSpace = (s, k) => { while (/\s/.test(s[k] ?? '')) k++; return k; };
/** 箭头函数 / function 的函数体范围：k 指向参数表之后（=> 或 { 之前） */
function bodyRange(F, k) {
  const s = F.src; let j = nextNonSpace(s, k);
  if (s.startsWith('=>', j)) j = nextNonSpace(s, j + 2);
  if (s[j] === '{' && F.close.has(j)) return [j, F.close.get(j)];
  return [j, j + readExpr(s, j).length + 1];
}
/** name 在 F 里的所有绑定：{ kind: 'decl' | 'fn' | 'opaque', scope: [开, 闭], at, init? }；以及所有赋值 { pos, text } */
function bindingsOf(F, name) {
  if (F.cache.has(name)) return F.cache.get(name);
  const s = F.src, out = { binds: [], assigns: [] };
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  const whole = [-1, s.length];
  for (const m of s.matchAll(re)) {
    const at = m.index; if (!F.mask[at]) continue;
    const before = s.slice(Math.max(0, at - 40), at), after = s.slice(at + name.length);
    const blockOf = (p) => innermost(F, p, '{') ?? whole;
    if (/\bfunction\s+$/.test(before)) { out.binds.push({ kind: 'fn', scope: blockOf(at), at }); continue; }
    if (/\b(?:const|let|var)\s+$/.test(before)) {
      if (/^\s+(?:of|in)\b/.test(after)) { const hdr = innermost(F, at, '('); out.binds.push({ kind: 'opaque', scope: hdr ? [hdr[0], bodyRange(F, hdr[1] + 1)[1]] : blockOf(at), at }); continue; }
      const eq = /^\s*=(?![=>])/.exec(after);
      out.binds.push({ kind: 'decl', scope: blockOf(at), at, init: eq ? { pos: at + name.length + eq[0].length, text: readExpr(s, at + name.length + eq[0].length) } : null });
      continue;
    }
    // 逗号连写的声明（let a = 0, b = 0 / let a, b;）：不在 ( [ 里
    if (/,\s*$/.test(before) && /^\s*=(?![=>])/.test(after) && (innermost(F, at, '{([')?.[2] ?? '{') === '{') { const eq = /^\s*=/.exec(after); out.binds.push({ kind: 'decl', scope: blockOf(at), at, init: { pos: at + name.length + eq[0].length, text: readExpr(s, at + name.length + eq[0].length) } }); continue; }
    if (/,\s*$/.test(before) && /^\s*[;,]/.test(after) && /\b(?:let|var)\s[^;]*$/.test(s.slice(s.lastIndexOf('\n', at), at)) && (innermost(F, at, '{([')?.[2] ?? '{') === '{') { out.binds.push({ kind: 'decl', scope: blockOf(at), at, init: null }); continue; }
    if (/^\s*=>/.test(after)) { out.binds.push({ kind: 'param', fn: fnNameBefore(s, at), fnAt: at, index: 0, dflt: null, scope: bodyRange(F, at + name.length), at }); continue; }   // x => …
    if (/\bcatch\s*\(\s*$/.test(before)) { const hdr = innermost(F, at, '('); out.binds.push({ kind: 'opaque', scope: hdr ? bodyRange(F, hdr[1] + 1) : blockOf(at), at }); continue; }
    // 参数表 / 解构：所在的最内层 ( 后面跟着 =>，或者前面是 function 名字；最内层 { [ 前面是 const / let / var
    const par = innermost(F, at, '(');
    const inPat = innermost(F, at, '{[');
    if (inPat && (!par || inPat[0] > par[0]) && /\b(?:const|let|var)\s*$/.test(s.slice(Math.max(0, inPat[0] - 12), inPat[0]))) { out.binds.push({ kind: 'opaque', scope: blockOf(inPat[0]), at }); continue; }
    if (par) {
      const after2 = s.slice(par[1] + 1);
      const isArrow = /^\s*=>/.test(after2), isFn = /\bfunction\s*[\w$]*\s*$/.test(s.slice(Math.max(0, par[0] - 40), par[0]));
      // 名字直接在参数表里（不是参数默认值里的调用）：参数表与名字之间没有更深的 (
      if ((isArrow || isFn) && !F.ranges.some((r) => r[2] === '(' && r[0] > par[0] && r[0] < at && at < r[1])) {
        const scope = bodyRange(F, par[1] + 1);
        // 解构出来的参数（({ a }) => …）看不到来源；普通参数记下函数名与位置，按调用点的实参判断
        if (F.ranges.some((r) => '{['.includes(r[2]) && r[0] > par[0] && r[0] < at && at < r[1])) { out.binds.push({ kind: 'opaque', scope, at }); continue; }
        const eq = /^\s*=(?![=>])/.exec(after);
        out.binds.push({ kind: 'param', fn: fnNameBefore(s, par[0]), fnAt: par[0], index: splitTop(s.slice(par[0] + 1, at), [',']).length - 1, dflt: eq ? readExpr(s, at + name.length + eq[0].length) : null, scope, at });
        continue;
      }
    }
    const as = /^\s*(\+=|=)(?![=>])/.exec(after);
    if (as) out.assigns.push({ pos: at + name.length + as[0].length, text: readExpr(s, at + name.length + as[0].length) });
  }
  F.cache.set(name, out);
  return out;
}
/** 参数表（或单参数）前面的函数名：const name = (…) => / name = (…) => / function name(…)；匿名的返回 null */
function fnNameBefore(s, k) {
  const pre = s.slice(Math.max(0, k - 80), k);
  return (/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?$/.exec(pre) ?? /\bfunction\s+([A-Za-z_$][\w$]*)\s*$/.exec(pre))?.[1] ?? null;
}
/** pos 处的 name：{ kind, defs: [{ F, pos, text, fn? }] } 或 null（本文件里没有，是别的文件的全局 / 内建） */
function resolveIn(F, name, pos) {
  const { binds, assigns } = bindingsOf(F, name);
  let best = null;
  for (const b of binds) if (b.scope[0] < pos && pos < b.scope[1] && (!best || span(b.scope) < span(best.scope))) best = b;
  if (!best) return null;
  if (best.kind === 'opaque') return { kind: 'opaque' };
  if (best.kind === 'param') return { ...best, F };
  if (best.kind === 'fn') { const p = F.src.indexOf('(', best.at), b = F.src.indexOf('{', F.close.get(p)); return { kind: 'fn', defs: [{ F, pos: p, text: `function ${F.src.slice(p, F.close.get(b) + 1)}` }] }; }
  const inScope = (a) => best.scope[0] < a.pos && a.pos < best.scope[1];
  return { kind: 'decl', defs: [...(best.init ? [best.init] : []), ...assigns.filter(inScope)].map((d) => ({ F, ...d })) };
}

// ── 表达式分类 ──
/** s[j] 是 ' " ` 之一：返回这个字面量收尾引号的下标；模板里的 ${…} 递归跳过 */
function skipLit(s, j) {
  const q = s[j];
  for (let k = j + 1; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === q) return k;
    if (q === '`' && c === '$' && s[k + 1] === '{') k = skipCode(s, k + 2, '}');
  }
  return s.length;
}
function skipCode(s, k, close) {
  let d = 0;
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'" || c === '`') { k = skipLit(s, k); continue; }
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (d === 0 && c === close) return k; d--; }
  }
  return k;
}
function splitTop(s, seps) {
  const parts = []; let depth = 0, last = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'" || c === '`') { k = skipLit(s, k); continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0) for (const sep of seps) if (s.startsWith(sep, k) && !(sep === '?' && (s[k + 1] === '?' || s[k + 1] === '.' || s[k - 1] === '?'))) { parts.push({ text: s.slice(last, k), sep }); last = k + sep.length; k += sep.length - 1; break; }
  }
  parts.push({ text: s.slice(last), sep: null });
  return parts;
}
function matchParen(s, k) { const e = skipCode(s, k + 1, { '(': ')', '[': ']', '{': '}' }[s[k]]); return e < s.length ? e : -1; }
const strip = (s) => { s = s.trim(); while (s.startsWith('(') && matchParen(s, 0) === s.length - 1) s = s.slice(1, -1).trim(); return s; };
function asCall(s) {
  const m = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(s); if (!m) return null;
  const open = m[0].length - 1, close = matchParen(s, open); if (close < 0) return null;
  return { name: m[1], args: splitTop(s.slice(open + 1, close), [',']).map((p) => p.text.trim()).filter(Boolean), rest: s.slice(close + 1).trim() };
}
/** 从 k 起读一个表达式：到同层的 ; 或 , 或右括号为止，或同层换行且下一行不是接着写的 */
function readExpr(src, k) {
  let d = 0, j = k;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = skipLit(src, j); continue; }
    if (c === '/' && src[j + 1] === '/') { const e = src.indexOf('\n', j); if (e < 0) break; j = e - 1; continue; }   // 注释：跳到行尾（换行照常判断）
    if (c === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2) + 1; continue; }
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (d === 0) break; d--; }
    else if (d === 0 && (c === ';' || c === ',')) break;
    else if (d === 0 && c === '\n') {
      const before = src.slice(k, j).trimEnd(), after = src.slice(j + 1).trimStart();
      if (before && !/(=>|[=?:+|&,(])$/.test(before) && !/^[?:.+|&]/.test(after)) break;
    }
  }
  return src.slice(k, j).trim();
}

// fmtWhen（01-core.js）：只返回 Date 的 toLocaleString 结果（数字、字母、标点与时区缩写），和上面的日期规则同一个理由
const SAFE_CALLS = new Set(['esc', 'encodeURIComponent', 'CSS.escape', 'Number', 'Math.round', 'Math.max', 'Math.min', 'Math.floor', 'Math.ceil', 'Math.abs', 'fmtWhen']);
// 数字：.length、.toFixed(n)、数字字面量、x++，以及只含标识符 / 括号和 - * / % | 运算的式子（这些运算的结果必是数字；+ 可能是拼字符串，另行按段判）
const NUMERIC = /^[\w$.]+\.(length|size)$|^[\w$.]+\.toFixed\(\d*\)$|^-?\d+(\.\d+)?$|^[\w$.]+(\+\+|--)$|^(?=[^'"`[]*[-*/%|])[\w$.()\s*/%|-]+$/;

/** 安全吗？返回 null（安全）或者不安全的那一截源码。ctx：{ ok(x), F, pos, globals, opaque:Set, visiting:Set } */
export function unsafe(expr, ctx) {
  const s = strip(expr);
  if (!s) return null;
  if (ctx.ok(s)) return null;
  const q = splitTop(s, ['?']);
  if (q.length > 1) { const rest = q.slice(1).map((p) => p.text).join('?'); const br = splitTop(rest, [':']); if (br.length >= 2) return unsafe(br[0].text, ctx) ?? unsafe(br.slice(1).map((p) => p.text).join(':'), ctx); }
  for (const op of ['||', '??']) { const ps = splitTop(s, [op]); if (ps.length > 1) { for (const p of ps) { const u = unsafe(p.text, ctx); if (u) return u; } return null; } }
  { const ps = splitTop(s, ['&&']); if (ps.length > 1) return unsafe(ps[ps.length - 1].text, ctx); }
  if (/^['"`]/.test(s) && skipLit(s, 0) === s.length - 1) return null;   // 字面量；整个是一个模板时它自己另行扫描
  if (/^(true|false|null|undefined)$/.test(s) || NUMERIC.test(s)) return null;
  // - * / % 的结果必是数字；末尾是 .length 的也是
  if (splitTop(s, [' - ', ' * ', ' / ', ' % ']).length > 1) return null;
  if (/\.length$/.test(s) && splitTop(s, [' + ', '?', '||', '&&', '??']).length === 1) return null;
  if (/\.toFixed\(\d*\)$/.test(s) && splitTop(s, [' + ', '?', '||', '&&', '??']).length === 1) return null;
  // 日期：new Date(…).toISOString() / toLocale…String(…)（只会有数字、字母和标点）
  if (/^new Date\((?:[^()]|\([^()]*\))*\)\.(toISOString|toLocaleString|toLocaleDateString|toLocaleTimeString)\((?:[^()]|\([^()]*\))*\)(\.slice\([^()]*\))?$/.test(s)) return null;
  if (/^(['"])[^'"]*\1\[[^\]]+\]$/.test(s)) return null;   // '▁▂▃'[i]：字面量里取一个字符
  { const ps = splitTop(s, [' + ']); if (ps.length > 1) { for (const p of ps) { const u = unsafe(p.text, ctx); if (u) return u; } return null; } }
  if (/^[A-Za-z_$][\w$]*$/.test(s)) return viaDefs(s, ctx, (d, c2) => unsafe(d.text, c2));
  { const m = /^([A-Za-z_$][\w$]*)\[[^\]]+\]$/.exec(s); if (m) { const u = viaDefs(m[1], ctx, (d, c2) => (/^\{[\s\S]*\}$/.test(d.text.trim()) ? objValues(d.text, c2) : d.text)); return u ? `${s} → ${u}` : null; } }
  // 就地查表：{ a: …, b: … }[k]
  if (s.startsWith('{')) { const e = matchParen(s, 0); if (e > 0 && /^\[[^\]]+\]$/.test(s.slice(e + 1))) { const u = objValues(s.slice(0, e + 1), ctx); return u ? `${s.slice(0, 40)}… → ${u}` : null; } }
  // 数组变量 / 数组字面量（可带 .filter(…)）.join(sep)：每一项（字面量的每个元素、每次 push 的参数）与 sep 都安全
  { const m = /\.join\(([^()]*|T\('[^']*'\))\)$/.exec(s);
    if (m) {
      const recv = s.slice(0, m.index); let r0 = recv;
      for (;;) { const f = /\.filter\((?:[^()]|\([^()]*\))*\)$/.exec(r0); if (!f) break; r0 = r0.slice(0, f.index); }
      if (/^[A-Za-z_$][\w$]*$/.test(r0) || (r0.startsWith('[') && matchParen(r0, 0) === r0.length - 1)) { const u = itemsOf(recv, ctx) ?? unsafe(m[1] || "''", ctx); return u ? `${s} → ${u}` : null; }
    } }
  const mj = mapJoin(s);
  if (mj) { const itemsOk = !itemsOf(mj.recv, ctx); return (mj.cb === 'esc' ? null : fnResults(mj.cb, { ...ctx, mapCb: { itemsOk } })) ?? unsafe(mj.sep || "''", ctx); }
  if (/^\(\s*(?:async\s*)?\(\)\s*=>/.test(s) && /\)\s*\(\)$/.test(s)) return fnResults(s.slice(1, s.lastIndexOf(')', s.lastIndexOf('(') - 1)), ctx);
  const c = asCall(s);
  if (c) {
    // 截断 / 补齐 / 改大小写不会造出标签（esc 过的截断最多截坏一个实体，不会多出 <）
    if (c.rest && !/^(\.(trim|padStart|padEnd|toUpperCase|toLowerCase|slice)\([^()]*\))+$/.test(c.rest)) return s;
    if (c.name === 'T' || c.name === 'Tc') { const p = c.args[c.name === 'T' ? 1 : 2]; return p ? (strip(p).startsWith('{') ? objValues(strip(p), ctx) : p) : null; }
    if (SAFE_CALLS.has(c.name)) return null;
    if (/^[A-Za-z_$][\w$]*$/.test(c.name)) { const u = viaDefs(c.name, ctx, (d, c2) => fnResults(d.text, c2)); return u ? `${s} → ${u}` : null; }
    return s;
  }
  return s;
}
/** 按作用域找 name 的定义，逐个用 check 判。看不到来源（参数 / 循环变量 / 解构 / 没有定义）→ 不安全 */
function viaDefs(name, ctx, check) {
  if (ctx.safeNames?.has(name)) return null;
  if (ctx.opaque?.has(name)) return `${name}（参数）`;
  if (!ctx.F) return name;
  let r = resolveIn(ctx.F, name, ctx.pos);
  if (!r) r = ctx.globals?.(name) ?? null;
  if (!r) return `${name}（找不到定义）`;
  if (r.kind === 'opaque') return `${name}（循环变量 / 解构）`;
  if (r.kind === 'param') return viaCalls(name, r, ctx);
  if (!r.defs.length) return `${name}（只声明没赋值）`;
  const key = `${name}@${r.defs[0].F.name}:${r.defs[0].pos}`;
  ctx.visiting ??= new Set();
  if (ctx.visiting.has(key)) return null;   // 递归 / 自引用（html += …html…）：按其余定义判断
  ctx.visiting.add(key);
  try {
    for (const d of r.defs) { const u = check(d, { ...ctx, F: d.F, pos: d.pos, opaque: null, safeNames: null }); if (u) return `${name} = ${String(u).slice(0, process.env.WH_FULL ? 1e9 : 70)}`; }
    return null;
  } finally { ctx.visiting.delete(key); }
}
/** 具名函数的参数：每个调用点传的实参（没传就看默认值）都安全才算安全；函数被当作值传走（回调）就看不到实参 */
function viaCalls(name, r, ctx) {
  if (!r.fn) {
    // 匿名的 .map / .flatMap 回调：第 2 个参数是下标，第 1 个按数组来源判
    const asMap = /\.(?:map|flatMap)\(\s*(?:async\s*)?$/.exec(r.F.src.slice(Math.max(0, r.fnAt - 16), r.fnAt));
    if (asMap && r.index === 1) return null;
    if (asMap && r.index === 0) { const recv = receiverBefore(r.F.src, r.fnAt - asMap[0].length); const u = recv ? itemsOf(recv, { ...ctx, F: r.F, pos: r.fnAt, opaque: null, safeNames: null }) : 'map 的数组'; return u ? `${name}（map 的元素：${String(u).slice(0, process.env.WH_FULL ? 1e9 : 60)}）` : null; }
    return `${name}（匿名函数的参数）`;
  }
  const key = `param:${r.fn}#${r.index}@${r.F.name}:${r.at}`;
  ctx.visiting ??= new Set();
  if (ctx.visiting.has(key)) return null;
  ctx.visiting.add(key);
  try {
    const top = bindingsOf(r.F, r.fn).binds.some((b) => b.scope[0] === -1);
    for (const G of top ? (ctx.files ?? [r.F]) : [r.F]) {
      for (const m of G.src.matchAll(new RegExp(`(?<![\\w$.])${r.fn.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))) {
        if (!G.mask[m.index]) continue;
        const k = m.index + r.fn.length, before = G.src.slice(Math.max(0, m.index - 12), m.index), after = G.src.slice(k);
        if (/\b(?:const|let|var|function)\s+$/.test(before) || /^\s*=(?![=>])/.test(after)) continue;   // 定义处
        const call = /^\s*\(/.exec(after);
        if (!call) {
          // 当作 .map 的回调：第 2 个参数是下标（数字），第 1 个是数组元素 —— 按数组来源判
          const asMap = /\.map\(\s*$/.exec(G.src.slice(Math.max(0, m.index - 8), m.index));
          if (asMap && r.index === 1) continue;
          if (asMap && r.index === 0) { const recv = receiverBefore(G.src, m.index - asMap[0].length); const u = recv ? itemsOf(recv, { ...ctx, F: G, pos: m.index, opaque: null }) : 'map 的数组'; if (u) return `${name} ← ${r.fn} 当作 map 回调，数组里有 ${u}`; continue; }
          return `${name}（${r.fn} 被当作值传走，看不到实参）`;
        }
        const open = k + call[0].length - 1, close = matchParen(G.src, open);
        const args = splitTop(G.src.slice(open + 1, close), [',']).map((p) => p.text.trim());
        const a = args[r.index];
        const u = a ? unsafe(a, { ...ctx, F: G, pos: open + 1, opaque: null, mapItemOk: null }) : r.dflt ? unsafe(r.dflt, { ...ctx, F: r.F, pos: r.at, opaque: null }) : null;
        if (u) return `${name} ← ${G.name}:${G.src.slice(0, m.index).split('\n').length} ${r.fn}(…${String(u).slice(0, process.env.WH_FULL ? 1e9 : 50)})`;
      }
    }
    return null;
  } finally { ctx.visiting.delete(key); }
}
/** k 处是 .map 的点：往回取接收者（xs、[…]、[…].filter(…)） */
function receiverBefore(src, k) {
  let j = k;
  for (;;) {
    if (src[j - 1] === ')' || src[j - 1] === ']') { const close = j - 1; let open = -1; for (let q = close - 1; q >= 0; q--) if (src[q] === { ')': '(', ']': '[' }[src[close]] && matchParen(src, q) === close) { open = q; break; } if (open < 0) return null; j = open; const w = /[\w$.]*$/.exec(src.slice(0, j))[0]; j -= w.length; if (!w && src[close] === ']') break; if (!w) return null; continue; }
    const w = /[\w$.]*$/.exec(src.slice(0, j))[0]; j -= w.length; break;
  }
  return src.slice(j, k).trim() || null;
}
/** 数组（字面量 / 变量，可带 .filter(…)）里的每一项都安全吗 */
function itemsOf(recv, ctx) {
  let t = strip(recv);
  for (;;) { const f = /\.filter\((?:[^()]|\([^()]*\))*\)$/.exec(t); if (!f) break; t = t.slice(0, f.index); }
  if (/^[A-Za-z_$][\w$]*$/.test(t)) return viaDefs(t, ctx, (d, c2) => arrayItems(d.text, c2)) ?? pushes(t, ctx);
  if (t.startsWith('[')) return arrayItems(t, ctx);
  return t;
}
/** 函数（箭头 / function）的每个返回值都安全吗；不是函数就按表达式判 */
function fnResults(fn, ctx) {
  const f = fn.trim();
  const arrow = /^(?:async\s*)?(\([^()]*(?:\{[^}]*\}[^()]*)?\)|[\w$]+)\s*=>\s*/.exec(f);
  const decl = /^(?:async\s+)?function\b\s*[\w$]*\s*(\([^)]*\))/.exec(f);
  if (!arrow && !decl) {
    if (SAFE_CALLS.has(f)) return null;                                                          // map(esc)
    if (/^[A-Za-z_$][\w$]*$/.test(f)) return viaDefs(f, ctx, (d, c2) => fnResults(d.text, c2));  // map(projRow)：看 projRow 的返回值
    return unsafe(f, ctx);
  }
  const plist = (arrow ?? decl)[1].replace(/^\(|\)$/g, '');
  const params = new Set(plist.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const safe = new Set(ctx.safeNames ?? []);
  if (ctx.mapCb) {   // .map(cb)：第 1 个参数是数组元素（数组里的每项都安全才算），第 2 个是下标
    const ps = splitTop(plist, [',']).map((p) => p.text.trim());
    if (ctx.mapCb.itemsOk && /^[A-Za-z_$][\w$]*$/.test(ps[0] ?? '')) { safe.add(ps[0]); params.delete(ps[0]); }
    if (/^[A-Za-z_$][\w$]*$/.test(ps[1] ?? '')) { safe.add(ps[1]); params.delete(ps[1]); }
  }
  const sub = { ...ctx, mapCb: null, safeNames: safe, opaque: new Set([...(ctx.opaque ?? []), ...params]) };
  const body = arrow ? f.slice(arrow[0].length).trim() : f.slice(f.indexOf('{', decl[0].length - 1));
  // 函数体里的名字按函数体里的位置找绑定（在源文件里定位这段函数体）
  const at = ctx.F ? ctx.F.src.indexOf(body, Math.max(0, ctx.pos - 2)) : -1;
  const posOf = (k) => (at >= 0 ? at + k : ctx.pos);
  if (arrow && !body.startsWith('{')) return unsafe(body, { ...sub, pos: posOf(0) });
  // 嵌套函数（=> { … } / function … { … }）里的 return 是它们自己的，不算
  const nested = [];
  for (const m of body.matchAll(/=>\s*\{|\bfunction\b[^{(]*\([^)]*\)\s*\{/g)) { const b = m.index + m[0].length - 1; nested.push([b, matchParen(body, b)]); }
  for (const m of body.matchAll(/(?<![\w$.])return\b/g)) {
    if (nested.some(([a, b]) => a < m.index && m.index < b)) continue;
    const r = readExpr(body, m.index + 6);
    const u = unsafe(r || "''", { ...sub, pos: posOf(m.index + 6) });
    if (u) return u;
  }
  return null;
}
/** 数组的来源：字面量 [a, b] 逐项；xs.map(cb) 看 cb；其余按表达式 */
function arrayItems(text, ctx) {
  let t = text.trim();
  for (;;) { const f = /\.filter\((?:[^()]|\([^()]*\))*\)$/.exec(t); if (!f) break; t = t.slice(0, f.index); }   // 过滤不会造出新项
  if (t.startsWith('[') && matchParen(t, 0) === t.length - 1) {
    for (const p of splitTop(t.slice(1, -1), [','])) {
      const raw = p.text.trim(); if (!raw) continue;
      const spread = raw.startsWith('...'), x = spread ? raw.slice(3) : raw;   // ...xs：xs 的每一项
      const u = spread ? (/^[A-Za-z_$][\w$]*$/.test(x) ? viaDefs(x, ctx, (d, c2) => arrayItems(d.text, c2)) ?? pushes(x, ctx) : arrayItems(x, ctx)) : unsafe(x, ctx);
      if (u) return u;
    }
    return null;
  }
  const mm = /\.map\(/.exec(t); if (mm && t.endsWith(')') && matchParen(t, mm.index + 4) === t.length - 1) return fnResults(t.slice(mm.index + 5, -1), ctx);
  return unsafe(t, ctx);
}
/** name.push(…) 的每个参数（本文件里的，宁多勿少） */
function pushes(name, ctx) {
  if (!ctx.F) return null;
  const src = ctx.F.src;
  for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\.(?:push|unshift)\\(`, 'g'))) {
    if (!ctx.F.mask[m.index]) continue;
    const open = m.index + m[0].length - 1, close = matchParen(src, open);
    for (const p of splitTop(src.slice(open + 1, close), [','])) { const u = unsafe(p.text.replace(/^\s*\.\.\./, ''), { ...ctx, pos: open + 1, opaque: null }); if (u) return `${name}.push(${u})`; }
  }
  return null;
}
function objValues(obj, ctx) {
  for (const p of splitTop(obj.trim().slice(1, -1), [','])) {
    const t = p.text.trim(); if (!t || t.startsWith('...')) { if (t) { const u = unsafe(t.slice(3), ctx); if (u) return u; } continue; }
    const m = /^([\w$]+|'[^']*'|"[^"]*"|\[[^\]]+\])\s*:\s*([\s\S]+)$/.exec(t);
    const u = m ? unsafe(m[2], ctx) : unsafe(t, ctx);   // 简写 { n } 等于 n: n
    if (u) return u;
  }
  return null;
}
/** a.b.map(cb)[.filter(…)].join(sep) → { cb, sep } */
function mapJoin(s) {
  const m = /\.join\(([^()]*|T\('[^']*'\))\)$/.exec(s); if (!m) return null;
  let head = s.slice(0, m.index);
  for (;;) { const f = /\.filter\([^()]*(?:\([^()]*\)[^()]*)*\)$/.exec(head); if (!f) break; head = head.slice(0, f.index); }
  if (!head.endsWith(')')) return null;
  let open = -1;
  for (let k = 0; k < head.length; k++) { if ('"\'`'.includes(head[k])) { k = skipLit(head, k); continue; } if (head[k] === '(' && matchParen(head, k) === head.length - 1) { open = k; break; } }
  if (open < 0 || !head.slice(0, open).endsWith('.map')) return null;
  return { cb: head.slice(open + 1, -1).trim(), sep: m[1], recv: head.slice(0, open - 4) };
}

// "像 HTML"：静态部分里有标签开头、或者以 属性=" 结尾（插值落在属性值里）
const looksHtml = (t) => t.quasis.some((q) => /<[a-z\/!]/i.test(q) || /[\w-]+="[^"]*$/.test(q));
// 选择器（$(`[data-q="${id}"]`)、querySelector、closest）不是注入点：拼坏了只是选不中
const isSelector = (F, t) => !t.parent && /(?:\$\$?|querySelector(?:All)?|closest|matches)\(\s*$/.test(F.src.slice(Math.max(0, t.start - 30), t.start));

// ── 登记：确实安全、但扫描看不出来的插值。键："文件|表达式"（表达式去掉首尾空白）。理由写在值里 ──
const ALLOW = new Map(Object.entries({
  // 05 项目设置 → Skill：每组的「怎么装」是 T(…) 拼的 HTML 片段（<code> 包命令 / 路径，项目 id 已 esc）
  '05-settings-network.js|how': '每组的安装说明由 GROUPS 里拼好（<code> 片段，插值已转义）',
  // 05 项目设置 → 钩子：每个时机的「要人确认 / 出错」两行与来源名是 WHEN / SRC 里 T(…) 拼好的（<code> 片段经 code() 转义）
  '05-settings-network.js|ask': '钩子页 WHEN 里拼好的说明（code() 已转义）',
  '05-settings-network.js|failed': '钩子页 WHEN 里拼好的说明（code() 已转义）',
  '05-settings-network.js|name': '钩子页 SRC 里拼好的来源名（code() 已转义）',
  // 05 项目设置 → MCP：状态行（statusLine 里插的 server id、报错、变更原文都已 esc）与来源两行（SRC 里 T(…) + code() 拼好）
  '05-settings-network.js|statusLine(s)': 'MCP 页的状态行在 statusLine 里拼好（插值已转义）',
  '05-settings-network.js|SRC[x.kind][0]': 'MCP 页 SRC 里拼好的来源名（code() 已转义）',
  '05-settings-network.js|SRC[x.kind][1]': 'MCP 页 SRC 里拼好的来源说明（纯文案）',
  // 竖向分层图的节点：line1 / line2 约定是调用方拼好的 HTML 片段（03-project.js 的 esc(state) 与 T('依赖 {deps}', …#数字)、
  // 09-graph.js 步骤图的 T('步骤 {n}') · esc(stName(…)) 与 T('风险 {level}', …esc)），title 才是原文、这里 esc
  '09-graph.js|x.line1': '节点的 line1 由调用方拼好（已转义）',
  '09-graph.js|x.line2': '节点的 line2 由调用方拼好（已转义）',
  // 08-diff.js 的 qBodyHtml：先 esc 整段，再把 **x** 换成 <b>x</b>（转义后的文本里没有 < >，换进去的只有 <b>）
  "07-inbox.js|qBodyHtml(x.text, x.decisionType, 'inbox')": '先整段 esc，再只换出 <b>',
  "12-preview.js|qBodyHtml(q.text, q.decision_type, 'task')": '先整段 esc，再只换出 <b>',
  '12-preview.js|mdBold(r.diff)': '同上（08-diff.js 的 mdBold，qBodyHtml 也是它）：先整段 esc，再只换出 <b>',
  // 签收例外签收卡：G 里每类例外一个行渲染函数，函数体本身就是 HTML 模板、照样逐处扫描
  '12-preview.js|head': '签收卡正文第一段：qBodySplit 在 qBodyHtml（整段 esc）的结果上按空行切',
  '12-preview.js|rest': '签收卡正文其余部分：同上',
  "21-health.js|TODO[r.id] ?? ''": 'INV_TODO 每条都是不带参数的 T() 字面量，没有外来内容',
  // 重查哨兵重查提醒：recheckText 返回的 title / todo 是不带参数的 T() 字面量；body 每条是 T() 模板，参数全部 esc / kTok / fmtBytes / invTask（已转义）
  '14-task-panels.js|p.head': 'renderLimits 的 parts()：名称/提示/用量逐个 esc 后拼成',
  '14-task-panels.js|p.edit': 'renderLimits 的 parts()：键、值、单位、名称逐个 esc 后拼成',
  '21-health.js|x.title': 'recheckText 的标题都是不带参数的 T() 字面量（default 分支 esc）',
  '21-health.js|x.todo': 'recheckText 的建议都是不带参数的 T() 字面量',
  '21-health.js|b': 'recheckText 的 body：T() 模板，参数逐个 esc / kTok / fmtBytes / invTask',
  '12-preview.js|signoffBodyHtml(q)': '签收卡正文：各段都在函数里转义 / 受检',
  '12-preview.js|script': '签收卡"自己把应用跑起来看"的命令：每一行在拼进数组时已 esc',
  '12-preview.js|ROW[e.kind](e)': 'excHtml 各类例外的行渲染函数（函数里的模板同样受检）',
}));
const used = new Set();

const scripts = appScripts();
const files = [];
for (const s of scripts) {
  try { files.push(fileInfo(s.name, readFileSync(s.path, 'utf8'))); } catch (e) { bad(`${s.name}：词法读不通`, e.message); }
}
// 全局名字：某个文件顶层的声明（经典脚本之间共用）；赋值算上所有文件里没被局部遮住的
const globals = (name) => {
  const defs = []; let found = null;
  for (const F of files) {
    const top = bindingsOf(F, name).binds.find((b) => b.scope[0] === -1);
    if (top) { const r = resolveIn(F, name, F.src.length - 1); if (r?.kind === 'opaque') return r; found = r; defs.push(...(r?.defs ?? [])); }
  }
  if (!found) return null;
  for (const F of files) for (const a of bindingsOf(F, name).assigns) if (!resolveIn(F, name, a.pos) && !defs.some((d) => d.F === F && d.pos === a.pos)) defs.push({ F, ...a });
  return { kind: found.kind, defs };
};
const findings = [];
let tplCount = 0, exprCount = 0;
for (const F of files) {
  const html = new Set(F.templates.filter((t) => looksHtml(t) && !isSelector(F, t)));
  // 嵌在 HTML 模板插值里的模板也按 HTML 看 —— 除非它整个包在 esc(…) / encodeURIComponent(…) 里（结果反正会被转义）
  const escapedIn = (t, p) => F.ranges.some((r) => r[2] === '(' && r[0] > p.start && r[0] < t.start && t.end <= r[1] && /(?:^|[^\w$.])(?:esc|encodeURIComponent|CSS\.escape)\s*$/.test(F.src.slice(Math.max(0, r[0] - 24), r[0])));
  for (const t of F.templates) { let p = t.parent; while (p) { if (html.has(p)) { if (!escapedIn(t, p)) html.add(t); break; } p = p.parent; } }
  for (const t of html) {
    tplCount++;
    for (const e of t.exprs) {
      exprCount++;
      const okFn = (x) => { const k = `${F.name}|${x}`; if (ALLOW.has(k)) { used.add(k); return true; } return false; };
      const u = unsafe(e.src, { ok: okFn, F, pos: e.pos, globals, files });
      if (process.env.WH_TRACE === `${F.name}:${e.line}`) console.log(`  [trace] \${${e.src.trim().slice(0, 80)}} → ${u ?? '安全'}`);   // 调试：WH_TRACE=文件:行 看某一行每处插值的判定
      if (u) findings.push(`${F.name}:${e.line}  \${${e.src.trim().replace(/\s+/g, ' ').slice(0, 100)}}${u !== e.src.trim() ? `   ← ${u.replace(/\s+/g, ' ').slice(0, process.env.WH_FULL ? 1e9 : 90)}` : ''}`);
    }
  }
}
ok(`扫描 ${scripts.length} 个脚本、${tplCount} 个拼 HTML 的模板、${exprCount} 处插值`);
findings.length ? bad(`${findings.length} 处插值没经过转义（包 esc()，或确实安全就登记进 ALLOW 写理由）`, findings.join('\n         ')) : ok('每处插值都经过转义 / 是安全帮手 / 已登记');
const stale = [...ALLOW.keys()].filter((k) => !used.has(k));
stale.length ? bad('ALLOW 里有用不上的登记（代码改了，删掉它）', stale.join(' | ')) : ok('ALLOW 里的登记都还用得上');

// 扫描器自己：故意写错的样例要报出来，写对的不报
{
  const probe = (code) => {
    const F = fileInfo('probe.js', code);
    return F.templates.filter(looksHtml).flatMap((t) => t.exprs.map((e) => unsafe(e.src, { ok: () => false, F, pos: e.pos, globals: () => null }))).filter(Boolean);
  };
  const cases = [
    ['`<b>${name}</b>`', 1], ['`<b>${esc(name)}</b>`', 0], ["`<b>${T('{n} 条', { n: x.title })}</b>`", 1], ["`<b>${T('{n} 条', { n: esc(x.title) })}</b>`", 0],
    ['`<i title="${t}">`', 1], ["`<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>`", 1], ["`<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`", 0],
    ["`<b>${ok ? esc(a) : b}</b>`", 1], ["`<b>${ok ? esc(a) : '-'}</b>`", 0], ['`<b>${xs.length}</b>`', 0], ['const r = /`/; `<b>${y}</b>`', 1],
    // 变量：本作用域里赋的是安全的放过；同名的别处变量不算；参数报出
    ["function f(u) { const rows = `<i>${esc(u)}</i>`; return `<b>${rows}</b>`; }", 0],
    ["function f(u) { let rows = ''; rows += `<i>${esc(u)}</i>`; rows += u.name; return `<b>${rows}</b>`; }", 1],
    ["function g() { const rows = '<i>x</i>'; } function f(rows) { return `<b>${rows}</b>`; } f(x.name);", 1],
    // 参数：按每个调用点的实参判；当作回调传走就看不到实参
    ["const row = (t, label = '') => `<a>${label}${esc(t.title)}</a>`; row(a); row(b, `<i>${esc(b.n)}</i>`);", 0],
    ["const row = (t, label = '') => `<a>${label}</a>`; row(a, b.name);", 1],
    ["const row = (t, label) => `<a>${label}</a>`; xs.forEach(row);", 1],
    ["const bar = (inner) => `<div>${inner}</div>`; [esc(a), T('甲')].filter(Boolean).map(bar).join('');", 0],
    ["`<ul>${[esc(a), b.c].filter(Boolean).map((x) => `<li>${x}</li>`).join('')}</ul>`", 1],
    ["`<ul>${[esc(a), T('乙')].filter(Boolean).map((x, i) => `<li data-i=\"${i}\">${x}</li>`).join('')}</ul>`", 0],
    ["const row = (u) => `<i>${esc(u.name)}</i>`; const h = (xs) => `<b>${xs.map(row).join('')}</b>`;", 0],
    ["const row = (u) => u.name; const h = (xs) => `<b>${xs.map(row).join('')}</b>`;", 1],
    ["function lab(c) { if (c) return T('甲'); return c.name; } `<b>${lab(1)}</b>`", 1],
    ["const NAME = { a: T('甲'), b: T('乙') }; const h = (k) => `<b>${NAME[k]}</b>`;", 0],
    ["const NAME = { a: T('甲'), b: k2 }; const h = (k) => `<b>${NAME[k]}</b>`;", 1],
    ["for (const t of ts) out += `<b>${t}</b>`;", 1],
    ["const { title } = x; `<b>${title}</b>`", 1],
  ];
  const wrong = cases.filter(([code, n]) => probe(code).length !== n).map(([code, n]) => `${code} 期望 ${n} 处，实得 ${probe(code).length}`);
  wrong.length ? bad('扫描器自检', wrong.join('\n         ')) : ok(`扫描器自检：${cases.length} 个样例（漏转义的报出、转义过的放过）`);
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
