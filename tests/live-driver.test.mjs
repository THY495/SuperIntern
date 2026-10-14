// @needs: browser
// 验收员的浏览器驱动（core/live-app-driver.mjs）在真浏览器里跑：弹框。
//   ① 动作期间弹的确认框：默认点确定、on_dialog=dismiss 点取消，结果里照实写弹了什么
//   ② 两条命令之间弹出、当时没人接的框：页面会永久卡住 → 下一条命令连上时关掉标签页、在原地址重开，并说明
// 删除前的 window.confirm 把驱动卡死，「删除后从列表消失」四组都没验成。
// 容器里的那一段（chromium + 沙箱）不在这个测试里。
//
// 跑：node tests/live-driver.test.mjs（要本机有 Chrome / Edge / Chromium；SUPERINTERN_CHROME 可指定）

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch } from './lib/cdp.mjs';
import { renderPage } from '../src/agent/live-tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(HERE, '..', 'src', 'core', 'live-app-driver.mjs');
let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e !== undefined ? `\n         ${String(e).split('\n').join('\n         ')}` : ''}`); };
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}\n实际 ${JSON.stringify(a)}`));
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const textOf = (r) => r?.page?.text ?? '';

const exe = findBrowser();
if (!exe) {
  console.log('  [FAIL] 找不到 Chrome / Edge / Chromium（设 SUPERINTERN_CHROME 指向浏览器，或 node tests/run.mjs --all --without browser 跳过本套）');
  console.log(`\n${'═'.repeat(72)}\n❌ 0 通过，1 失败\n${'═'.repeat(72)}`);
  process.exit(1);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>藏书</title>
<ul id="list"><li data-n="A">书 A <button onclick="del('A')">删除 A</button></li><li data-n="B">书 B <button onclick="del('B')">删除 B</button></li></ul>
<button onclick="setTimeout(() => alert('稍后的提示'), 1500)">稍后提示</button>
<script>function del(n) { if (confirm('确定删除 ' + n + ' 吗？')) document.querySelector('[data-n=' + n + ']').remove(); }</script>`;
const server = createServer((req, res) => { res.writeHead(req.url === '/' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }); res.end(req.url === '/' ? PAGE : ''); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const URL0 = `http://127.0.0.1:${server.address().port}/`;
const browser = await launch(exe);
// 一条命令一个进程（与容器里一样）；子进程要 await，不然同一进程里的 HTTP 服务被 spawnSync 堵住、页面加载不出来
const drive = (cmd) => new Promise((res) => {
  execFile(process.execPath, [DRIVER, JSON.stringify({ port: browser.port, ...cmd })], { timeout: 60_000 }, (err, stdout) => {
    try { res(JSON.parse(String(stdout).trim().split('\n').pop())); } catch { res({ ok: false, error: `驱动没给结果：${err?.message ?? stdout}` }); }
  });
});

try {
  section('① 动作期间弹的确认框');
  {
    const o = await drive({ cmd: 'open', url: URL0 });
    eq([o.ok, o.status, o.dialogs ?? null], [true, 200, null], '打开：没有弹框就不带 dialogs');
    const a = await drive({ cmd: 'click', target: '删除 A' });
    eq([a.ok, a.dialogs], [true, [{ type: 'confirm', message: '确定删除 A 吗？', answered: 'accept' }]], '点「删除 A」：确认框照实回报，默认点确定');
    const at = a.page?.text ?? '';
    assert(!at.includes('书 A') && at.includes('书 B'), '点了确定 → 书 A 从列表消失（驱动没被弹框卡住）', at);
    const b = await drive({ cmd: 'click', target: '删除 B', dialog: 'dismiss' });
    eq(b.dialogs?.map((d) => d.answered), ['dismiss'], 'dialog=dismiss：点取消');
    assert(textOf(b).includes('书 B'), '点了取消 → 书 B 还在', textOf(b));
    const txt = renderPage(b, { action: '点了「删除 B」。' });
    assert(txt.includes('页面弹出了确认框「确定删除 B 吗？」，点了「取消」。'), '给模型看的文字写明弹了什么、点了哪个', txt);
  }

  section('② 命令之间弹出、没人接的框：重开这一页');
  {
    const c = await drive({ cmd: 'click', target: '稍后提示' });
    assert(c.ok && !c.dialogs, '点「稍后提示」：命令结束时还没弹', JSON.stringify(c).slice(0, 200));
    await new Promise((r) => setTimeout(r, 2500));   // 1.5 秒后弹出，这时没有客户端连着
    const r = await drive({ cmd: 'read' });
    eq([r.ok, r.reopened?.url], [true, URL0], '下一条命令：发现页面卡住 → 重开原地址，结果里带 reopened');
    assert(textOf(r).includes('书 A') && textOf(r).includes('书 B'), '重开后是新加载的页面（只在页面里删掉的书 A 回来了）', textOf(r));
    const txt = renderPage(r);
    assert(txt.includes('当时没人接') && txt.includes(URL0), '给模型看的文字说明重开过、在哪一页', txt);
    const again = await drive({ cmd: 'read' });
    assert(again.ok && !again.reopened, '之后的命令照常，不再重开', JSON.stringify(again).slice(0, 200));
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
