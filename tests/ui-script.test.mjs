// 看板页面的脚本能编译、能按顺序加载（身份与会话撞出来的，严格 CSP 拆成外置脚本后扩充）：
//   index.html 的 <script> 里同名的 const 声明了两次（KIND_NAME），整段脚本解析失败，页面不进登录页、什么都不渲染 ——
//   而服务端的全部测试照样绿，因为没有哪条测试解析页面脚本。
//   脚本按视图拆到 src/web/app/，按页面里的顺序作为经典脚本执行（共用顶层词法环境）。拆开以后多了一种坏法：
//   某个文件在加载时（顶层，不是在函数里）就用到了后面文件才声明的东西 —— 单文件时函数声明会整体提升，拆开就不提升了。
//   所以这里不止编译，还在一个桩 DOM 里按顺序真跑一遍加载期代码；跑到启动那一步（等 fetch）为止。
//
// 跑：node tests/ui-script.test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';
import { appScripts, appFiles } from '../src/web/page-scripts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };

const html = readFileSync(join(ROOT, 'src', 'web', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/type="application\/json"/.test(m[1]));
inline.length === 0 ? ok('页面里没有可执行的内联脚本（CSP script-src \'self\' 的前提）') : bad(`页面里还有 ${inline.length} 段内联脚本`);

const list = appScripts(html);
list.length ? ok(`页面按顺序引用 ${list.length} 个脚本`) : bad('页面没有引用任何脚本？');
const files = appFiles();
const orphan = files.filter((f) => !list.some((s) => s.name === f));
orphan.length ? bad('app/ 里有页面没引用的脚本', orphan.join(', ')) : ok('app/ 里的脚本都被页面引用了');
const texts = list.map((s) => ({ ...s, text: readFileSync(s.path, 'utf8') }));

// ① 同一页面里的经典脚本共用一个全局词法环境：拼起来编译，跨文件重复声明也能抓到
try {
  new Script(texts.map((t) => t.text).join('\n;\n'), { filename: 'app/*.js' });
  ok('脚本拼起来编译通过（没有语法错误、没有跨文件重复的 const / let 声明）');
} catch (e) {
  bad('脚本编译失败 —— 页面在浏览器里会整段不运行', `${e.name}: ${e.message}`);
}

// ② 按顺序在桩 DOM 里跑加载期代码。桩：任何属性、调用、new 都返回它自己；转字符串是空串；fetch 永远不回（停在启动那一步）
const any = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? function* () {} : k === 'then' ? undefined : any),
  set: () => true, apply: () => any, construct: () => any, has: () => true,
});
const store = new Map();
const ctx = createContext({
  console, URL, URLSearchParams, Date, Math, JSON, Promise, Map, Set, WeakMap, Symbol, Intl, Number, String, Array, Object, RegExp, Error, encodeURIComponent, decodeURIComponent,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, queueMicrotask: () => {},
  document: any, navigator: any, history: any, EventSource: any, matchMedia: () => any, getComputedStyle: () => any, ResizeObserver: any, MutationObserver: any, IntersectionObserver: any,
  location: { search: '', hash: '', pathname: '/', href: 'http://localhost/', reload() {} },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  crypto: { randomUUID: () => '00000000-0000-0000-0000-000000000000' },
  fetch: () => new Promise(() => {}),
});
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.addEventListener = () => {}; ctx.removeEventListener = () => {}; ctx.dispatchEvent = () => true;
const rejected = [];
process.on('unhandledRejection', (e) => rejected.push(e));
let loadErr = null;
for (const t of texts) {
  try { new Script(t.text, { filename: t.url }).runInContext(ctx); }
  catch (e) { loadErr = `${t.name}: ${e.name}: ${e.message}`; break; }
}
loadErr ? bad('按顺序加载时出错（多半是前面的文件在加载时就用到了后面文件才声明的东西）', loadErr) : ok('按页面顺序加载每个脚本，加载期代码都跑得通');
await new Promise((r) => setTimeout(r, 50));
rejected.length ? bad('启动时有未处理的异常', String(rejected[0]?.stack ?? rejected[0]).split('\n').slice(0, 3).join(' | ')) : ok('启动那一步（等第一个请求之前）没有异常');

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
