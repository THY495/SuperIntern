// 多语言（0.2.0）：gettext 式 —— 中文原文就是键，英文目录按原文查；查不到回落中文。
//
// 两个层次：
//   - 界面语言：每人自选（users.lang；空 = 跟随部署的内容语言）。管看板界面、CLI 输出、通知外壳、报错。
//   - 内容语言：按部署统一（设置 deploy.content_lang，默认 zh）。管写进库里的文字（事项正文、系统代写的答复、
//     汇报、约定清单）和模型写给人的文字。同一条事项所有人看到同一份原文 —— 协作时说的是同一件事。
//
// 写法：
//   tl(lang, '已转交给 {name}', { name })         占位符写 {名字}，不要写 ${} —— 键必须是字面量，覆盖率测试才抽得出来
//   throw new I18nError('任务不存在：{id}', { id })  报错：message 仍是中文（日志、测试照旧），服务端按请求人的界面语言翻
// 目录在 ./en/*.mjs，按区域分文件（界面、核心、CLI……），合并时同一个键两份译文不一致就报错。

import ui from './en/ui.mjs';
import ui1 from './en/ui-1.mjs';
import ui2 from './en/ui-2.mjs';
import ui3 from './en/ui-3.mjs';
import ui4 from './en/ui-4.mjs';
import ui5 from './en/ui-5.mjs';
import ui6 from './en/ui-6.mjs';
import ui7 from './en/ui-7.mjs';
import uiShell from './en/ui-shell.mjs';
import content1 from './en/content-1.mjs';
import content2 from './en/content-2.mjs';
import content3 from './en/content-3.mjs';
import content4 from './en/content-4.mjs';
import content5 from './en/content-5.mjs';
import content6 from './en/content-6.mjs';
import content7 from './en/content-7.mjs';
import content8 from './en/content-8.mjs';
import core from './en/core.mjs';
import cli from './en/cli.mjs';

export const LANGS = ['zh', 'en'];
export const DEFAULT_LANG = 'zh';
export const normLang = (x) => (LANGS.includes(String(x ?? '').toLowerCase()) ? String(x).toLowerCase() : null);

// 同一原文在两份目录里译文不一致：不在加载时抛（一抛整个系统都起不来），先到先得，记进 CATALOG_CONFLICTS，
// 由 tests/i18n.test.mjs 报出来改。
export const CATALOG_CONFLICTS = [];
function merge(parts) {
  const out = Object.create(null), from = Object.create(null);
  for (const [name, part] of Object.entries(parts)) {
    for (const [k, v] of Object.entries(part)) {
      if (k in out) { if (out[k] !== v) CATALOG_CONFLICTS.push({ key: k, kept: [from[k], out[k]], dropped: [name, v] }); continue; }
      out[k] = v; from[k] = name;
    }
  }
  return out;
}
// 看板按段分文件（多人同时补译时互不冲突）：ui-1…7 是脚本各段，ui-shell 是静态 HTML
export const CATALOGS = { en: merge({ ui, ui1, ui2, ui3, ui4, ui5, ui6, ui7, uiShell, core, cli, content1, content2, content3, content4, content5, content6, content7, content8 }) };

/** 把 {名字} 换成参数；参数里没有的占位符原样留着（看得出漏传了什么）。 */
export const fmt = (s, params) => (params ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k] ?? '') : m)) : String(s));

/** 翻译一条原文。lang 不认识或是中文 → 原文；目录里没有 → 回落原文。 */
export function tl(lang, zh, params) {
  const l = normLang(lang) ?? DEFAULT_LANG;
  const hit = l === DEFAULT_LANG ? zh : (CATALOGS[l]?.[zh] ?? zh);
  return fmt(hit, params);
}

/**
 * 模型写给人的文字用内容语言（0.2.0）：提示词本身仍是中文，末尾追加一段输出语言说明。中文部署原样不动。
 * 引文（规则的 quote 要逐字引规格原文）、代码、路径、命令不翻 —— 机器会逐字核对它们。
 */
export function withOutputLang(system, lang) {
  const l = normLang(lang) ?? DEFAULT_LANG;
  if (l === DEFAULT_LANG) return system;
  return `${system}\n\n## Output language\nWrite everything a human will read — questions and their options, drafts, plans, task titles and specs, handoff notes, reports, reasons and summaries — in English. `
    + 'The instructions above are written in Chinese; that does not change the output language. '
    + 'Keep code, file paths, commands, identifiers and any text you quote verbatim from the spec or from people exactly as they are (do not translate quotes).';
}

/** 只做标记、原样返回（gettext 的 N_）：原文写在别处、翻译发生在别处时（例如 DECISION_TYPES 的 label 由看板翻），
 *  用它把原文登记给覆盖率测试。 */
export const N_ = (s) => s;

// ── 看板页面的静态部分（<script> / <style> 之外的 HTML）：服务端出页面时按词表替换 ──
const CJK = /[\u4e00-\u9fff]/;
const SHELL_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
/** 把 html 切成 [是否可翻, 片段]：<script> 与 <style> 里的不动（脚本里的文字走 T()）。 */
const shellParts = (html) => String(html).split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/i).map((s, i) => [i % 2 === 0, s]);
/** 静态部分里要翻的原文：文字节点（去首尾空白）与几种给人看的属性。覆盖率测试据此要求目录里都有。 */
export function shellTexts(html) {
  const out = [];
  for (const [open, s] of shellParts(html)) {
    if (!open) continue;
    for (const m of s.matchAll(/>([^<>]*)</g)) { const t = m[1].trim(); if (CJK.test(t)) out.push(t); }
    for (const m of s.matchAll(new RegExp(`\\b(?:${SHELL_ATTRS.join('|')})="([^"]*)"`, 'g'))) if (CJK.test(m[1])) out.push(m[1]);
  }
  return out;
}
/** 出页面：静态部分按词表替换、<html lang> 改对、把词表塞进页面（脚本里的 T() 同步可用，常量表在加载时就翻好）。 */
export function localizeHtml(html, lang) {
  const l = normLang(lang) ?? DEFAULT_LANG;
  const cat = CATALOGS[l] ?? {};
  const tr = (t) => cat[t] ?? t;
  let out = shellParts(html).map(([open, s]) => (!open || l === DEFAULT_LANG ? s : s
    .replace(/>([^<>]*)</g, (m, t) => { const k = t.trim(); return CJK.test(k) ? `>${t.replace(k, tr(k))}<` : m; })
    .replace(new RegExp(`\\b(${SHELL_ATTRS.join('|')})="([^"]*)"`, 'g'), (m, a, v) => (CJK.test(v) ? `${a}="${tr(v)}"` : m)))).join('');
  out = out.replace(/<html lang="[^"]*">/, `<html lang="${l === 'zh' ? 'zh' : l}">`);
  const boot = `<script>window.SI_I18N=${JSON.stringify({ lang: l, catalog: l === DEFAULT_LANG ? {} : cat }).replace(/</g, '\\u003c')};</script>`;
  return out.replace(/<script>/, `${boot}\n<script>`);
}

/** 带模板的报错：message 是中文（照旧能被日志、测试读），服务端据 tpl / params 翻成请求人的语言。 */
export class I18nError extends Error {
  constructor(tpl, params = null) {
    super(fmt(tpl, params));
    this.tpl = tpl;
    this.params = params;
  }
}

/** 把一个异常翻成给某人看的话：I18nError 按模板翻；普通 Error 整句查目录（固定文字的报错也能翻）；都没有就原样。 */
export function translateError(e, lang) {
  const l = normLang(lang) ?? DEFAULT_LANG;
  if (l === DEFAULT_LANG) return String(e?.message ?? e);
  // 参数里恰好是目录原文的（决策类型名、模板名这类 N_ 登记过的）顺带翻掉，免得英文句子里夹一个中文词
  if (e?.tpl) return tl(l, e.tpl, e.params && Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, typeof v === 'string' ? (CATALOGS[l]?.[v] ?? v) : v])));
  const msg = String(e?.message ?? e);
  return CATALOGS[l]?.[msg] ?? msg;
}

// ── 语言从哪来 ─────────────────────────────────────────────────────────
// 这两个函数只读库，不 import settings.mjs（它依赖 db.mjs）以免循环：设置项的键与读法在这里写死一份，
// 与 settings.mjs 的 SETTINGS['deploy.content_lang'] 同一个口径（tests/i18n.test.mjs 钉住两边一致）。
export const CONTENT_LANG_KEY = 'deploy.content_lang';

/** 部署的内容语言：写进库里的文字、模型写给人的文字用它。 */
export function contentLang(db) {
  const row = db.one(`SELECT value FROM params WHERE task_id IS NULL AND project_id IS NULL AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, CONTENT_LANG_KEY);
  try { return normLang(JSON.parse(row?.value ?? 'null')) ?? DEFAULT_LANG; } catch { return DEFAULT_LANG; }
}

/** 某人的界面语言：自己选过就用自己的，没选过跟随部署的内容语言。 */
export function userLang(db, userId) {
  const own = userId ? db.one(`SELECT lang FROM users WHERE id=?`, userId)?.lang : null;
  return normLang(own) ?? contentLang(db);
}
