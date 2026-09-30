// 从源码里抽出所有要翻的原文（覆盖率测试用，也给补译的人列清单：node src/i18n/extract.mjs --missing en）。
//
// 认三种写法（第一个字符串参数必须是字面量；模板字符串里不许有 ${}，占位符写 {名字}）：
//   tl(<任意表达式>, '原文', …)     服务端 / CLI
//   new I18nError('原文', …)       报错
//   T('原文', …)                    看板（src/web/index.html）
//   N_('原文')                      只登记不翻（原文在别处翻，例如 DECISION_TYPES 的 label 由看板 T(label) 翻）
// 另外：看板页面 <script> / <style> 之外的静态 HTML 里的中文（文字与 title / placeholder 等属性），服务端出页面时替换。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { shellTexts } from './index.mjs';
import { fileURLToPath } from 'node:url';

export const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === 'i18n' ? [] : walk(p)) : [p]; });
export const sourceFiles = () => walk(SRC).filter((p) => /\.(mjs|html)$/.test(p));

/** 读一个字符串字面量（i 指向引号）。返回 { value, end, raw }；不是字面量返回 null。 */
function readLiteral(s, i) {
  const q = s[i];
  if (!`'"\``.includes(q)) return null;
  let v = '', j = i + 1;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { const n = s[++j]; v += n === 'n' ? '\n' : n === 't' ? '\t' : n; continue; }
    if (c === q) return { value: v, end: j + 1, template: q === '`' };
    v += c;
  }
  return null;
}

/** 从 i（左括号之后）跳过第一个参数，停在顶层逗号之后。 */
function skipFirstArg(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (`'"\``.includes(c)) { const lit = readLiteral(s, j); if (!lit) return -1; j = lit.end - 1; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) return -1; depth--; }
    else if (c === ',' && depth === 0) return j + 1;
  }
  return -1;
}

/** 抽出一个文件里的所有键：[{ key, file, line, problem? }] */
export function extractFrom(text, file) {
  const out = [];
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  const push = (i, lit) => {
    // 第一个参数不是字面量 = 有意的动态键（服务端发来的原文，例如 T(t.label)）：抽不出来，也不算错；它的原文要在别处用 N_ 登记
    if (!lit) { out.push({ key: null, file, line: lineOf(i), problem: null, dynamic: true }); return; }
    out.push({ key: lit.value, file, line: lineOf(i), problem: lit.template && lit.value.includes('${') ? '模板字符串里有 ${}，占位符请写 {名字}' : null });
  };
  const re = /(?<![\w$.])(tl|I18nError|T|Tc|N_)\(/g;
  let m;
  while ((m = re.exec(text))) {
    const fn = m[1], at = m.index + m[0].length;
    if ((fn === 'T' || fn === 'Tc') && !file.endsWith('.html')) continue;          // T() / Tc() 只在看板里用
    if (fn === 'Tc') {   // Tc('上下文', '原文')：键是"上下文|原文"
      let j = at; while (/\s/.test(text[j])) j++;
      const ctx = readLiteral(text, j); if (!ctx) { push(m.index, null); continue; }
      let k = ctx.end; while (/[\s,]/.test(text[k])) k++;
      const lit = readLiteral(text, k);
      push(m.index, lit ? { ...lit, value: `${ctx.value}|${lit.value}` } : null);
      continue;
    }
    if (fn === 'I18nError' && !/new\s+$/.test(text.slice(Math.max(0, m.index - 8), m.index))) continue;
    let i = fn === 'tl' ? skipFirstArg(text, at) : at;
    if (i < 0) { out.push({ key: null, file, line: lineOf(m.index), problem: '解析不了参数' }); continue; }
    while (/\s/.test(text[i])) i++;
    push(m.index, readLiteral(text, i));
  }
  if (file.endsWith('.html')) for (const k of shellTexts(text)) out.push({ key: k, file, line: 0, problem: null });
  return out;
}

export function extractAll() {
  const out = sourceFiles().flatMap((p) => extractFrom(readFileSync(p, 'utf8'), relative(SRC, p).replaceAll('\\', '/')));
  // 路由模板是数据文件（JSON 里放不了 N_）：名称、简介、占位说明由看板 T() 翻，这里按原文登记
  const tpl = JSON.parse(readFileSync(join(SRC, 'core', 'routing-templates.json'), 'utf8')).templates ?? {};
  for (const t of Object.values(tpl)) for (const k of [t.label, t.summary, ...Object.values(t.placeholders ?? {})]) if (k) out.push({ key: k, file: 'core/routing-templates.json', line: 0, problem: null });
  return out;
}

export const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { CATALOGS } = await import('./index.mjs');
  const lang = process.argv[process.argv.indexOf('--missing') + 1] || 'en';
  const seen = new Set();
  for (const e of extractAll()) if (e.key && !(e.key in CATALOGS[lang]) && !seen.has(e.key)) { seen.add(e.key); console.log(`${e.file}:${e.line}\t${JSON.stringify(e.key)}`); }
  console.error(`缺 ${seen.size} 条（${lang}）`);
}
