// SPDX-License-Identifier: MIT AND Apache-2.0
// 本文件的排序部分移植自 Aider（Apache-2.0），有改动；见 THIRD_PARTY_NOTICES.md。
// Repo map：给执行器一张"这个仓库里有什么"的地图 —— 哪些文件定义了哪些符号、谁引用谁，按当前这一步的范围排序，
// 装进一个 token 预算。没有它时，执行器每一步开头都要 list_dir / read_file 一层层摸。
//
// 排序移植自 Aider `aider/repomap.py` 的 get_ranked_tags（Apache-2.0，Copyright Paul Gauthier；见 THIRD_PARTY_NOTICES.md）：
//   - 定义 / 引用 → 文件之间的有向边（引用方 → 定义方），边权 = mul × √引用次数；
//     mul：这一步提到的标识符 ×10；长度 ≥ 8 的 snake / camel / kebab 名字 ×10；下划线开头 ×0.1；在 5 个以上文件里都有定义 ×0.1；引用方是焦点文件 ×50
//   - 带个性化向量的 PageRank（焦点文件均分）；每个文件的分数按出边权重分给它引用到的那些定义
//   - 按分数排定义，二分查找能装进预算的条数（误差 15% 以内即停）
// 改动：tree-sitter 换成零依赖的抽取 —— 定义用按语言的正则（主机上装了 Universal Ctags 就用它，覆盖的语言多得多）；
// 引用用标识符切词（不分"调用"与"定义处"，定义所在那一处从计数里扣掉）。渲染不画 Aider 的语法树上下文，每个定义给一行签名。
//
// 文件在主机上读（执行器的 read_file / grep 也在主机上读，见 core/executor.mjs HostFileOps），所以不用动沙箱镜像。

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const REPO_MAP_DEFAULT_TOKENS = 2048;   // 与 deploy.repo_map_tokens 的默认值一致
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 5_000;
const SIG_MAX = 120;
const estimateTokens = (s) => Math.ceil(s.length / 3.5);   // 与 context/assemble.mjs 同一个估法

// ── 哪些文件不进地图：依赖目录、构建产物、锁文件、压缩过的、二进制 ─────────────
const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|out|target|coverage|\.git|\.superintern|__pycache__|\.venv|venv|\.next|\.cache)\//;
const SKIP_FILE = /(\.min\.(js|css)$|\.map$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$)/;
export const mapCandidate = (p) => !SKIP_DIR.test(p) && !SKIP_FILE.test(p);

// ── 重要文件：没有定义、但摸仓库时几乎每次都先看的（移植自 Aider aider/special.py 的思路，清单有删减）──
// 这几类没有符号可排，按 PageRank 排不上来，但开工时几乎都要看：包清单、README、tsconfig、各种 *.config.*、入口文件。
const IMPORTANT = [
  /^readme(\.[a-z]+)?$/i, /^(package|composer|deno)\.json$/, /^tsconfig(\.[\w-]+)?\.json$/, /^jsconfig\.json$/,
  /^(pyproject\.toml|setup\.py|setup\.cfg|requirements[\w-]*\.txt|Pipfile|tox\.ini)$/, /^(Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|Gemfile|Makefile|CMakeLists\.txt|Dockerfile)$/,
  /^[\w.-]+\.config\.(js|mjs|cjs|ts|mts|json)$/, /^\.(eslintrc|prettierrc|babelrc|swcrc)(\.[a-z]+)?$/, /^(AGENTS|CLAUDE|CONTRIBUTING)\.md$/i,
];
const ENTRY = /^(src\/|lib\/)?(index|main|mod|__init__|app)\.(js|mjs|cjs|ts|mts|py|go|rs)$/;
/** 根目录（或子包根）的重要文件，以及入口文件 */
export const isImportant = (p) => { const parts = p.split('/'); const name = parts.at(-1); return (parts.length <= 2 && IMPORTANT.some((re) => re.test(name))) || ENTRY.test(p); };

// ── 定义：按语言的正则 ───────────────────────────────────────────────────────
// 每条：[正则（全局、按行）, 名字在第几组, kind]。只抓行首附近的定义，宁漏不错 —— 错抓的名字会凭空长出引用边。
const JS_KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'do', 'try', 'with', 'new', 'typeof', 'await', 'super']);
const LANGS = [
  { ext: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'], kw: JS_KW, rules: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 1, 'function'],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 1, 'class'],
    [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, 1, 'type'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|class\b)/, 1, 'function'],
    [/^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=/, 1, 'const'],
    [/^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, 1, 'method'],
    [/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/, 1, 'function'],
  ] },
  { ext: ['.py'], kw: new Set(), rules: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 1, 'function'],
    [/^\s*class\s+([A-Za-z_]\w*)/, 1, 'class'],
    [/^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/, 1, 'const'],
  ] },
  { ext: ['.go'], kw: new Set(), rules: [
    [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 1, 'function'],
    [/^type\s+([A-Za-z_]\w*)/, 1, 'type'],
  ] },
  { ext: ['.rs'], kw: new Set(), rules: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, 1, 'function'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|union|mod)\s+([A-Za-z_]\w*)/, 1, 'type'],
  ] },
  { ext: ['.java', '.kt', '.cs', '.scala', '.swift'], kw: new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'synchronized']), rules: [
    [/^\s*(?:[\w@]+\s+)*(?:class|interface|enum|record|struct|object|protocol)\s+([A-Za-z_]\w*)/, 1, 'class'],
    [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|open|suspend)\s+)+(?:fun\s+|func\s+)?[\w<>\[\],.?\s]*?\b([A-Za-z_]\w*)\s*\(/, 1, 'method'],
    [/^\s*(?:fun|func)\s+([A-Za-z_]\w*)/, 1, 'function'],
  ] },
  { ext: ['.rb'], kw: new Set(), rules: [
    [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, 1, 'function'],
    [/^\s*(?:class|module)\s+([A-Z]\w*)/, 1, 'class'],
  ] },
  { ext: ['.php'], kw: new Set(), rules: [
    [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?([A-Za-z_]\w*)/, 1, 'function'],
    [/^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, 1, 'class'],
  ] },
  { ext: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'], kw: new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'else']), rules: [
    [/^(?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|signed\s+|struct\s+)*[A-Za-z_][\w:<>]*[\s*&]+([A-Za-z_][\w:]*)\s*\([^;]*$/, 1, 'function'],
    [/^\s*(?:typedef\s+)?(?:struct|class|enum|union)\s+([A-Za-z_]\w*)\s*(?:\{|:|$)/, 1, 'type'],
    [/^\s*#\s*define\s+([A-Za-z_]\w*)/, 1, 'macro'],
  ] },
];
const LANG_OF = new Map(LANGS.flatMap((l) => l.ext.map((e) => [e, l])));
export const mapLanguage = (path) => LANG_OF.get(extname(path).toLowerCase()) ?? null;

/** 一个文件里的定义（正则版） */
export function regexDefs(path, text) {
  const lang = mapLanguage(path);
  if (!lang) return [];
  const out = [], lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const [re, g, kind] of lang.rules) {
      const m = re.exec(line);
      if (!m || lang.kw.has(m[g])) continue;
      out.push({ name: m[g], line: i + 1, kind, sig: line.trim().slice(0, SIG_MAX) });
      break;
    }
  }
  return out;
}

const IDENT = /[A-Za-z_$][\w$]*/g;
/** 一个文件里出现过的标识符与次数（引用的近似） */
export function identCounts(text) {
  const m = new Map();
  for (const t of text.match(IDENT) ?? []) if (t.length > 1) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

// ── Universal Ctags（可选）：主机上有就用它抽定义 ───────────────────────────
let CTAGS = undefined;
export function ctagsAvailable(run = spawnSync) {
  if (CTAGS !== undefined) return CTAGS;
  try { const r = run('ctags', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); CTAGS = r.status === 0 && /Universal Ctags/i.test(r.stdout ?? ''); }
  catch { CTAGS = false; }
  return CTAGS;
}
export const _resetCtags = () => { CTAGS = undefined; };
const CTAGS_KINDS = new Set(['function', 'method', 'class', 'struct', 'interface', 'enum', 'type', 'typedef', 'trait', 'module', 'macro', 'constant', 'func', 'member']);
/** ctags 一次抽整批文件的定义 → Map(path → defs)。失败返回 null（退回正则） */
export function ctagsDefs(root, paths, run = spawnSync) {
  const r = run('ctags', ['--output-format=json', '--fields=+nK', '-f', '-', '-L', '-'], { cwd: root, input: paths.join('\n'), encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  const out = new Map();
  for (const ln of r.stdout.split('\n')) {
    if (!ln.startsWith('{')) continue;
    let t; try { t = JSON.parse(ln); } catch { continue; }
    if (t._type !== 'tag' || !t.name || !t.path || !CTAGS_KINDS.has(String(t.kind))) continue;
    const sig = String(t.pattern ?? '').replace(/^\/\^|\$\/$/g, '').trim().slice(0, SIG_MAX);
    const p = t.path.replace(/\\/g, '/');
    if (!out.has(p)) out.set(p, []);
    out.get(p).push({ name: t.name, line: t.line ?? 0, kind: String(t.kind), sig });
  }
  return out;
}

// ── 标签缓存：按文件内容的哈希（git 的 blob id）记，没改过的文件不重读 ──────────
function cacheIO(dir) {
  if (!dir) return { get: () => null, put: () => {} };
  return {
    get(key) { try { return JSON.parse(readFileSync(join(dir, key.slice(0, 2), `${key}.json`), 'utf8')); } catch { return null; } },
    put(key, v) { try { mkdirSync(join(dir, key.slice(0, 2)), { recursive: true }); writeFileSync(join(dir, key.slice(0, 2), `${key}.json`), JSON.stringify(v)); } catch { /* 缓存坏了只是慢 */ } },
  };
}

/** 工作区里 git 管着的文件与它们的 blob id（git ls-files -s）；不是 git 仓库就返回 null */
export function trackedFiles(root, run = spawnSync) {
  const r = run('git', ['-C', root, 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) return null;
  // 工作区里改过、还没进暂存区的文件：读到的是磁盘上的新内容，不能记在暂存区那个 blob 名下（不然下一次按 blob 命中的是这次的半成品）
  const d = run('git', ['-C', root, 'diff', '--name-only', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const dirty = new Set(d.status === 0 ? d.stdout.split('\0').filter(Boolean) : []);
  return r.stdout.split('\0').filter(Boolean).map((l) => { const m = /^\d+ ([0-9a-f]+) \d+\t(.*)$/.exec(l); return m ? { path: m[2], blob: d.status === 0 && !dirty.has(m[2]) ? m[1] : null } : null; }).filter(Boolean);
}

/**
 * 抽全仓的标签：{ defs: Map(path → [{name,line,kind,sig}]), refs: Map(path → Map(ident → n)), files: [path] }。
 * files：[{ path, blob? }]；readFile(path) → 文本。ctags：true / false / 'auto'
 */
export function collectTags({ root, files, readFile = (p) => readFileSync(join(root, p), 'utf8'), cacheDir = null, ctags = 'auto', run = spawnSync }) {
  const cache = cacheIO(cacheDir);
  const list = files.filter((f) => mapCandidate(f.path)).slice(0, MAX_FILES);
  const defs = new Map(), refs = new Map(), kept = [];
  const useCtags = ctags === true || (ctags === 'auto' && ctagsAvailable(run));
  const fresh = [];
  for (const f of list) {
    const key = f.blob ? `${useCtags ? 'c' : 'r'}1-${f.blob}` : null;
    const hit = key ? cache.get(key) : null;
    if (hit) { defs.set(f.path, hit.d); refs.set(f.path, new Map(hit.r)); kept.push(f.path); continue; }
    let text;
    try { text = readFile(f.path); } catch { continue; }
    if (typeof text !== 'string' || text.length > MAX_FILE_BYTES || text.includes('\0')) continue;   // 太大、二进制
    kept.push(f.path);
    refs.set(f.path, mapLanguage(f.path) ? identCounts(text) : new Map());
    if (!useCtags) defs.set(f.path, regexDefs(f.path, text));
    fresh.push({ ...f, text, key });
  }
  if (useCtags && fresh.length) {
    const got = ctagsDefs(root, fresh.map((f) => f.path), run);
    for (const f of fresh) defs.set(f.path, got ? got.get(f.path) ?? [] : regexDefs(f.path, f.text));
  }
  for (const f of fresh) if (f.key) cache.put(f.key, { d: defs.get(f.path) ?? [], r: [...refs.get(f.path)] });
  return { defs, refs, files: kept, ctags: useCtags };
}

// ── 排序（Aider get_ranked_tags 的打分规则 + PageRank）─────────────────────────
const isLongName = (s) => s.length >= 8 && (/_/.test(s) || /-/.test(s) || /[a-z][A-Z]/.test(s));

/** 带个性化向量的 PageRank（幂迭代）。nodes：[id]；edges：Map(src → Map(dst → w)) */
export function pagerank(nodes, edges, { personalization = null, damping = 0.85, iters = 60, tol = 1e-9 } = {}) {
  const N = nodes.length;
  if (!N) return new Map();
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const p = new Float64Array(N);
  if (personalization && personalization.size) { let s = 0; for (const [n, v] of personalization) if (idx.has(n)) { p[idx.get(n)] = v; s += v; } if (s > 0) for (let i = 0; i < N; i++) p[i] /= s; else p.fill(1 / N); }
  else p.fill(1 / N);
  const out = nodes.map((n) => { const m = edges.get(n); if (!m) return null; let t = 0; for (const w of m.values()) t += w; return t > 0 ? [...m].map(([d, w]) => [idx.get(d), w / t]) : null; });
  let r = Float64Array.from(p);
  for (let k = 0; k < iters; k++) {
    const nx = new Float64Array(N);
    let dangling = 0;
    for (let i = 0; i < N; i++) { if (!out[i]) { dangling += r[i]; continue; } for (const [j, w] of out[i]) nx[j] += damping * r[i] * w; }
    let diff = 0;
    for (let i = 0; i < N; i++) { nx[i] += (damping * dangling + (1 - damping)) * p[i]; diff += Math.abs(nx[i] - r[i]); }
    r = nx;
    if (diff < tol * N) break;
  }
  return new Map(nodes.map((n, i) => [n, r[i]]));
}

/**
 * 排好序的定义：[{ path, name, line, kind, sig, rank }]，以及没有定义、但排得上的文件。
 * focusFiles：这一步范围里的文件（个性化 + 引用方 ×50）；focusIdents：这一步规格里提到的标识符（×10）
 */
export function rankTags({ defs, refs, files }, { focusFiles = [], focusIdents = [] } = {}) {
  const fset = new Set(focusFiles.filter((f) => files.includes(f)));
  const iset = new Set(focusIdents);
  const definers = new Map();   // ident → Set(path)
  for (const [p, ds] of defs) for (const d of ds) { if (!definers.has(d.name)) definers.set(d.name, new Set()); definers.get(d.name).add(p); }
  const edges = new Map(), edgeIdents = new Map();   // src → Map(dst → w)；(src→dst) → Map(ident → w)
  const add = (src, dst, ident, w) => {
    if (!edges.has(src)) edges.set(src, new Map());
    edges.get(src).set(dst, (edges.get(src).get(dst) ?? 0) + w);
    const k = `${src}\0${dst}`;
    if (!edgeIdents.has(k)) edgeIdents.set(k, new Map());
    edgeIdents.get(k).set(ident, (edgeIdents.get(k).get(ident) ?? 0) + w);
  };
  const mulOf = new Map();
  for (const [ident, ds] of definers) {
    let mul = 1;
    if (iset.has(ident)) mul *= 10;
    if (isLongName(ident)) mul *= 10;
    if (ident.startsWith('_')) mul *= 0.1;
    if (ds.size > 5) mul *= 0.1;
    mulOf.set(ident, mul);
  }
  // 按每个文件出现过的标识符反查定义方（不是"定义 × 文件"两重循环：几千个文件的仓库那是上亿次查找）
  for (const [ref, counts] of refs) {
    for (const [ident, c] of counts) {
      const ds = definers.get(ident);
      if (!ds) continue;
      const n = ds.has(ref) ? c - defs.get(ref).filter((d) => d.name === ident).length : c;   // 定义所在那一处不算引用
      if (n <= 0) continue;
      const m = fset.has(ref) ? mulOf.get(ident) * 50 : mulOf.get(ident);
      for (const def of ds) add(ref, def, ident, m * Math.sqrt(n));
    }
  }
  const nodes = files;
  const pers = fset.size ? new Map([...fset].map((f) => [f, 1 / fset.size])) : null;
  const pr = pagerank(nodes, edges, { personalization: pers });
  // 每个文件的分数按出边权重分给它引用到的定义
  const rankedDef = new Map();   // `${path}\0${ident}` → rank
  for (const [src, m] of edges) {
    let total = 0; for (const w of m.values()) total += w;
    for (const [dst, w] of m) {
      const share = (pr.get(src) ?? 0) * w / total;
      const im = edgeIdents.get(`${src}\0${dst}`); let it = 0; for (const x of im.values()) it += x;
      for (const [ident, iw] of im) { const k = `${dst}\0${ident}`; rankedDef.set(k, (rankedDef.get(k) ?? 0) + share * iw / it); }
    }
  }
  const out = [];
  for (const [p, ds] of defs) for (const d of ds) out.push({ path: p, ...d, rank: (rankedDef.get(`${p}\0${d.name}`) ?? 0) + (fset.has(p) ? 1e-6 : 0) + (pr.get(p) ?? 0) * 1e-3 });
  out.sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path) || a.line - b.line);
  const withDefs = new Set(out.map((d) => d.path));
  // 没有定义的文件：这一步范围里的排前面，其余按 PageRank
  const bare = files.filter((f) => !withDefs.has(f) && !isImportant(f)).sort((a, b) => (fset.has(b) - fset.has(a)) || (pr.get(b) ?? 0) - (pr.get(a) ?? 0));
  const important = files.filter(isImportant).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return { tags: out, bare, important, pagerank: pr };
}

/** 渲染：按文件分组，文件按它第一条入选定义的名次排；每条一行"行号│签名" */
export function renderMap(tags, bare = []) {
  const byFile = new Map();
  for (const t of tags) { if (!byFile.has(t.path)) byFile.set(t.path, []); byFile.get(t.path).push(t); }
  const parts = [];
  for (const [p, ts] of byFile) parts.push(`${p}:\n${ts.sort((a, b) => a.line - b.line).map((t) => `  ${String(t.line).padStart(4)}│ ${t.sig}`).join('\n')}`);
  for (const p of bare) parts.push(p);
  return parts.join('\n');
}

/** 二分查找能装进预算的条数（Aider 的做法：误差 15% 以内即停）。没有定义的文件名排在后面补 */
export function fitMap(ranked, budgetTokens) {
  const { tags, bare, important = [] } = ranked;
  if (budgetTokens <= 0) return { text: '', tags: 0, files: 0, tokens: 0 };
  // 重要文件的名字总放在最前（只是名字，便宜）；剩下的预算给定义
  const head = important.length ? `${important.slice(0, 20).join('\n')}\n` : '';
  budgetTokens = Math.max(0, budgetTokens - estimateTokens(head));
  const total = tags.length + bare.length;
  const textFor = (n) => renderMap(tags.slice(0, Math.min(n, tags.length)), n > tags.length ? bare.slice(0, n - tags.length) : []);
  let lo = 0, hi = total, best = { n: 0, text: '', tok: 0 };
  let mid = Math.min(hi, Math.max(1, Math.floor(budgetTokens / 25)));
  while (lo <= hi) {
    const text = textFor(mid), tok = estimateTokens(text);
    if (tok <= budgetTokens && tok > best.tok) best = { n: mid, text, tok };
    if (Math.abs(tok - budgetTokens) / budgetTokens < 0.15 && tok <= budgetTokens) break;
    if (tok < budgetTokens) lo = mid + 1; else hi = mid - 1;
    mid = Math.floor((lo + hi) / 2);
  }
  const shown = tags.slice(0, Math.min(best.n, tags.length));
  const text = head + best.text;
  return { text, tags: shown.length, files: new Set([...important.slice(0, 20), ...shown.map((t) => t.path), ...(best.n > tags.length ? bare.slice(0, best.n - tags.length) : [])]).size, tokens: estimateTokens(text) };
}

/** 规格文本里的标识符（这一步提到的名字 ×10）：反引号里的、驼峰 / 下划线的、带括号调用的 */
export function identsFromText(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const m of s.matchAll(/`([^`\n]{1,80})`/g)) for (const t of m[1].match(IDENT) ?? []) if (t.length > 2) out.add(t);
  for (const t of s.match(/\b[A-Za-z_$][\w$]*(?=\()/g) ?? []) if (t.length > 2) out.add(t);
  for (const t of s.match(/\b[a-z]+[A-Z][\w$]*|\b[A-Za-z]+_[\w$]+/g) ?? []) out.add(t);
  return [...out];
}

/**
 * 一步要的地图。root：工作区；scopePaths：这一步可动的路径（文件或目录前缀）；mention：规格 / 验收等文本（抽标识符与提到的文件）。
 * 返回 { text, tokens, tags, files, total, ctags } —— text 为空表示没东西可画（不是代码仓库、预算 0）。
 */
export function buildRepoMap({ root, scopePaths = [], mention = '', budgetTokens = REPO_MAP_DEFAULT_TOKENS, cacheDir = null, ctags = 'auto', run = spawnSync, files = null, readFile = undefined }) {
  if (!budgetTokens || budgetTokens <= 0 || !existsSync(root)) return { text: '', tokens: 0, tags: 0, files: 0, total: 0, ctags: false };
  const list = files ?? trackedFiles(root, run);
  if (!list?.length) return { text: '', tokens: 0, tags: 0, files: 0, total: 0, ctags: false };
  const t = collectTags({ root, files: list, cacheDir, ctags, run, ...(readFile ? { readFile } : {}) });
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
  const prefixes = scopePaths.map(norm).filter(Boolean);
  const mentioned = new Set(t.files.filter((f) => mention.includes(f) || (basename(f).length > 4 && new RegExp(`\\b${basename(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(mention))));
  const focusFiles = t.files.filter((f) => mentioned.has(f) || prefixes.some((p) => f === p || f.startsWith(p.endsWith('/') ? p : `${p}/`) || dirname(f) === p.replace(/\/$/, '')));
  const ranked = rankTags(t, { focusFiles, focusIdents: identsFromText(mention) });
  const fit = fitMap(ranked, budgetTokens);
  return { ...fit, total: t.files.length, ctags: t.ctags, focus: focusFiles.length };
}

export const _test = { isLongName, estimateTokens, hash: (s) => createHash('sha1').update(s).digest('hex') };
