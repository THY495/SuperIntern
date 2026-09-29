// 看运行效果：si-preview.json 的读取与"截到了但页面可能有问题"的识别（离线部分；真沙箱里的截图不在这里测）
//
// 跑：node tests/preview.test.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPreviewSpec, pageTrouble, previewTroubles, CHROMIUM_FLAGS } from '../src/core/preview.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const D = mkdtempSync(join(tmpdir(), 'si-preview-t-'));
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const spec = (j) => { writeFileSync(join(D, 'si-preview.json'), typeof j === 'string' ? j : JSON.stringify(j)); return readPreviewSpec(D); };
const base = { start: ['node backend/server.js', 'npm run dev --prefix frontend'], url: 'http://127.0.0.1:5173', pages: ['/'] };

section('1. ready / seed');
{
  let r = spec(base);
  eq(JSON.stringify(r.spec.ready), JSON.stringify(['http://127.0.0.1:5173/']), '没写 ready：只等前端首页');
  eq(r.spec.seed.length, 0, '没写 seed：不放样例数据');
  r = spec({ ...base, ready: ['http://127.0.0.1:8000/api/health'], seed: ['python backend/seed.py', ['curl', '-X', 'POST', 'http://127.0.0.1:8000/api/items']] });
  eq(JSON.stringify(r.spec.ready), JSON.stringify(['http://127.0.0.1:5173/', 'http://127.0.0.1:8000/api/health']), '写了 ready：前端首页 + 后端健康地址都要等');
  eq(JSON.stringify(r.spec.seed), JSON.stringify([['python', 'backend/seed.py'], ['curl', '-X', 'POST', 'http://127.0.0.1:8000/api/items']]), 'seed 按空白切成 argv（不经 shell），也收数组写法');
  assert(/ready 里「http:\/\/example.com\/x」不是本机地址/.test(spec({ ...base, ready: ['http://example.com/x'] }).error ?? ''), 'ready 只许本机');
  assert(/ready 最多 4 个/.test(spec({ ...base, ready: ['http://127.0.0.1:1/', 'http://127.0.0.1:2/', 'http://127.0.0.1:3/', 'http://127.0.0.1:4/', 'http://127.0.0.1:5/'] }).error ?? ''), 'ready 有上限');
  assert(/seed 最多 3 条/.test(spec({ ...base, seed: ['a', 'b', 'c', 'd'] }).error ?? ''), 'seed 有上限');
}

section('2. 截到了 ≠ 页面是好的：常见报错字样与空白页');
{
  assert(pageTrouble('<ul><li>加载失败：Failed to fetch</li></ul>').some((w) => /连不上/.test(w)), 'Failed to fetch → 连不上');
  assert(pageTrouble('<h1>Internal Server Error</h1><p>The server encountered an internal error</p>').some((w) => /服务器出错/.test(w)), 'Internal Server Error → 服务器出错');
  assert(pageTrouble('<pre>Traceback (most recent call last):\n  File "app.py"</pre>').some((w) => /程序报错的原文/.test(w)), 'Python Traceback → 程序报错原文');
  assert(pageTrouble('<pre>Cannot GET /tickets</pre>').some((w) => /Cannot GET/.test(w)), 'Cannot GET → 前端没有这一页');
  assert(pageTrouble('<html><body><div id="root"></div><script>x()</script></body></html>').some((w) => /空白/.test(w)), '只有空壳 → 几乎是空白');
  eq(pageTrouble('<h1>工单列表</h1><ul><li>修打印机</li><li>换键盘</li></ul>').length, 0, '正常页面：没有提示');
  eq(pageTrouble('<p>优先级 500 以内的工单</p><h1>工单列表</h1>').length, 0, '正文里出现 500 这个数字不算报错');
  eq(JSON.stringify(previewTroubles({ warnings: ['样例数据没放成'], shots: [{ title: '首页', warnings: ['页面几乎是空白（渲染后没有文字）'] }, { title: '详情' }] })),
    JSON.stringify(['样例数据没放成', '「首页」页面几乎是空白（渲染后没有文字）']), '整体问题 + 每张图的问题合成一张清单');
}

section('3. chromium 关掉后台联网');
{
  for (const f of ['--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync']) assert(CHROMIUM_FLAGS.includes(f), f);
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
