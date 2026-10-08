// 契约覆盖核对：并行开发里模块只对着骨架的接口契约写，契约漏一个接口，
// 两个模块就各按各的理解做，到集成时才撞上。比如骨架契约漏了单个资源的 GET、
// 或某个接口的分页参数 —— 项目规划器写骨架任务时就没摘到，契约测试只验几个正常路径，
// 链条上没有一处发现（规划器逐条列全了端点时才不漏）。写全与否不能靠运气，所以机械核对两处：
//   - 规划时：骨架任务的契约文字要逐条点名规格里的每个 `METHOD /path`（不点名就拒回草案，与 node --test 目录写法同一个口径）；
//   - 骨架做完时：契约文件里要有每个接口，以及规格同一处写明的查询参数、请求 / 响应字段名（缺了就补一步让骨架补上）。
// 只认规格里写成 `METHOD /path` 的接口；规格里没有这种写法 = 不核对（不是 HTTP 项目，或者接口没写死）。
// 纯函数、零模型、零依赖：YAML 不解析，只按缩进切出每个路径的那一段。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const METHODS = 'GET|POST|PUT|PATCH|DELETE';
const EP_RE = new RegExp(`\\b(${METHODS})\\s+\`?(\\/[A-Za-z0-9_\\-./{}:]*)(\\?[^\\s\`]*)?`, 'g');

/** 路径参数名不比（`{key}` 与 `{issue_key}` 是同一个接口）；句末的标点、结尾斜杠不算路径。 */
export const normPath = (p) => String(p).replace(/[.:]+$/, '').replace(/\{[^}]*\}/g, '{}').replace(/\/+$/, '') || '/';
const epKey = (m, p) => `${m.toUpperCase()} ${normPath(p)}`;
/** 模板接口（`/api/issues/{}/transitions`）是否覆盖一个写出来的接口：`{}` 对得上任何一段（契约文字里常写具体样例 `/api/issues/WEB-1/transitions`）。 */
const keyMatches = (template, named) => {
  const [m1, p1] = template.split(' '), [m2, p2] = named.split(' ');
  if (m1 !== m2) return false;
  const a = p1.split('/'), b = p2.split('/');
  return a.length === b.length && a.every((s, i) => s === b[i] || s === '{}' || b[i] === '{}');
};

/** 一行里反引号括起来的 `{...}`：JSON 写法取带引号的键，简写（`{key, name?}`）取逗号分开的名字。 */
function braceNames(line) {
  const names = new Set();
  for (const [, raw] of line.matchAll(/`([^`]*\{[^`]*\}[^`]*)`/g)) {
    const span = raw.replace(/\/[A-Za-z0-9_\-./{}:]*/g, ' ');   // 路径里的 `{issue_key}` 是路径参数，不是字段
    const quoted = [...span.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]);
    if (quoted.length) { quoted.forEach((n) => names.add(n)); continue; }
    for (const [, inner] of span.matchAll(/\{([^{}]*)\}/g)) {
      for (const part of inner.split(',')) {
        const n = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\??(\s*\(.*\))?$/);
        if (n) names.add(n[1]);
      }
    }
  }
  return [...names];
}

/**
 * 规格里的接口：[{ method, path, key, params, fields }]。
 * params = 写在 `?a=<..>&b=<..>` 里的查询参数；fields = 只提到这一个接口的那一行里 `{...}` 写出的字段名
 * （一行提到几个接口时字段归不了属，不算进任何一个 —— 宁可漏查，不冤枉）。
 */
export function specEndpoints(text) {
  const out = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const hits = [...line.matchAll(EP_RE)];
    if (!hits.length) continue;
    const fields = hits.length === 1 ? braceNames(line) : [];
    for (const [, method, path, query] of hits) {
      if (path === '/') continue;
      const key = epKey(method, path);
      const e = out.get(key) ?? { method: method.toUpperCase(), path, key, params: new Set(), fields: new Set() };
      for (const [, n] of String(query ?? '').matchAll(/[?&]([A-Za-z_][A-Za-z0-9_]*)=/g)) e.params.add(n);
      fields.forEach((f) => e.fields.add(f));
      out.set(key, e);
    }
  }
  return [...out.values()].map((e) => ({ ...e, params: [...e.params], fields: [...e.fields] }));
}

/** 文字里点名了哪些接口（METHOD + 路径）。规划时对骨架任务的契约文字用。 */
export const namedEndpoints = (text) => new Set([...String(text ?? '').matchAll(EP_RE)].map(([, m, p]) => epKey(m, p)));

/**
 * 规划时：骨架任务的契约文字（目标、范围、完成定义、规则）要点名规格里的每个接口。返回错误列表（给规划器看，中文）。
 */
export function skeletonCoverageProblems(spec, brief) {
  const eps = specEndpoints(brief);
  const skel = spec?.tasks?.[0];
  if (!eps.length || skel?.kind !== 'skeleton') return [];
  const text = [skel.goal, skel.scope, skel.definition_of_done,
    ...(Array.isArray(skel.rules) ? skel.rules.map((r) => `${r?.rule ?? ''} ${r?.quote ?? ''}`) : [])].join('\n');
  const named = [...namedEndpoints(text)];
  const missing = eps.filter((e) => !named.some((n) => keyMatches(e.key, n)));
  if (!missing.length) return [];
  return [`骨架任务的完成定义要逐条点名规格里的每个接口（写成 \`METHOD /path\`）：模块任务只对着骨架定下的契约写，漏一个，两个模块就各按各的理解做、到集成时才撞上。`
    + `缺：${missing.map((e) => `\`${e.method} ${e.path}\``).join('、')}。查询参数与请求 / 响应字段也照规格写进契约`];
}

// ── 骨架做完时：对着契约文件核对 ─────────────────────────────────────────

const TEXT_EXT = /\.(ya?ml|json)$/i;
const SKIP_FILE = /(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|[^/]*\.lock)$/i;

function walk(dir, root, acc, depth = 0) {
  if (depth > 6 || acc.length > 200) return acc;
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const d of ents) {
    if (d.name.startsWith('.') || d.name === 'node_modules' || d.name === 'dist' || d.name === '__pycache__') continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, root, acc, depth + 1);
    else acc.push(relative(root, p).replace(/\\/g, '/'));
  }
  return acc;
}

/** 契约文件：共享路径下的 YAML / JSON，内容里有 `paths` 且至少提到规格里的一个接口路径（漏掉的正是要查的，不能要求"都提到"）。 */
export function contractFiles(workspace, sharedPaths, eps) {
  const files = [];
  for (const sp of sharedPaths ?? []) {
    const abs = join(workspace, sp);
    if (!existsSync(abs)) continue;
    const list = statSync(abs).isDirectory() ? walk(abs, workspace, []) : [sp.replace(/\/+$/, '')];
    for (const f of list) if (TEXT_EXT.test(f) && !SKIP_FILE.test(f)) files.push(f);
  }
  const paths = [...new Set(eps.map((e) => e.path))];
  return [...new Set(files)].map((f) => ({ file: f, text: (() => { try { return readFileSync(join(workspace, f), 'utf8'); } catch { return ''; } })() }))
    .filter(({ text }) => /\bpaths\b/.test(text) && paths.some((p) => text.includes(p.replace(/\{[^}]*\}.*$/, ''))));
}

/**
 * OpenAPI 的 paths 切成 { 归一路径 → { methods:Set, text } }，text 含它引用的组件（两层 $ref）。
 * JSON 直接解析；YAML 不解析，按缩进切 —— 路径行是 `  /api/x:`，它下面缩进更深的行都归它。
 */
function pathBlocks(file, text) {
  const blocks = new Map();
  if (/\.json$/i.test(file)) {
    let j; try { j = JSON.parse(text); } catch { return blocks; }
    const comp = j?.components ?? {};
    const deref = (s, depth = 0) => {
      if (depth > 2) return s;
      const refs = [...s.matchAll(/#\/components\/([A-Za-z]+)\/([A-Za-z0-9_.-]+)/g)];
      return s + refs.map(([, kind, name]) => deref(JSON.stringify(comp?.[kind]?.[name] ?? ''), depth + 1)).join('\n');
    };
    for (const [p, ops] of Object.entries(j?.paths ?? {})) {
      const methods = new Set(Object.keys(ops ?? {}).map((m) => m.toUpperCase()));
      blocks.set(normPath(p), { methods, text: deref(JSON.stringify(ops)) });
    }
    return blocks;
  }
  const lines = text.split('\n');
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  const blockAt = (i) => { const ind = indentOf(lines[i]); const out = [];
    for (let k = i + 1; k < lines.length; k++) { if (lines[k].trim() && indentOf(lines[k]) <= ind) break; out.push(lines[k]); }
    return out.join('\n'); };
  const compBlock = (name) => { const i = lines.findIndex((l) => new RegExp(`^\\s+['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*:\\s*$`).test(l)); return i >= 0 ? blockAt(i) : ''; };
  const deref = (s, depth = 0) => {
    if (depth > 2) return s;
    const refs = [...s.matchAll(/#\/components\/[A-Za-z]+\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
    return s + [...new Set(refs)].map((n) => `\n${deref(compBlock(n), depth + 1)}`).join('');
  };
  lines.forEach((l, i) => {
    const m = l.match(/^(\s*)['"]?(\/[^'":\s]*)['"]?\s*:\s*$/);
    if (!m) return;
    const body = blockAt(i);
    const methods = new Set([...body.matchAll(/^\s+(get|post|put|patch|delete)\s*:/gim)].map((x) => x[1].toUpperCase()));
    blocks.set(normPath(m[2]), { methods, text: deref(body) });
  });
  return blocks;
}

const hasWord = (text, w) => new RegExp(`(^|[^A-Za-z0-9_])${w}([^A-Za-z0-9_]|$)`).test(text);

/**
 * 契约文件缺什么：返回 { files, gaps:[人看得懂的一句] }。规格里没有接口、或者找不到契约文件 → gaps 为空（不核对）。
 */
export function contractGaps(workspace, { brief, sharedPaths }) {
  const eps = specEndpoints(brief);
  if (!eps.length) return { files: [], gaps: [] };
  const files = contractFiles(workspace, sharedPaths, eps);
  if (!files.length) return { files: [], gaps: [] };
  const blocks = new Map();
  for (const { file, text } of files) for (const [p, b] of pathBlocks(file, text)) {
    const cur = blocks.get(p);
    blocks.set(p, cur ? { methods: new Set([...cur.methods, ...b.methods]), text: `${cur.text}\n${b.text}` } : b);
  }
  const gaps = [];
  for (const e of eps) {
    const b = blocks.get(normPath(e.path));
    if (!b || !b.methods.has(e.method)) { gaps.push(`缺接口 \`${e.method} ${e.path}\``); continue; }
    const params = e.params.filter((n) => !hasWord(b.text, n));
    if (params.length) gaps.push(`\`${e.method} ${e.path}\` 缺查询参数 ${params.map((n) => `\`${n}\``).join('、')}`);
    const fields = e.fields.filter((n) => !hasWord(b.text, n));
    if (fields.length) gaps.push(`\`${e.method} ${e.path}\` 的请求 / 响应里缺字段 ${fields.map((n) => `\`${n}\``).join('、')}`);
  }
  return { files: files.map((f) => f.file), gaps };
}
