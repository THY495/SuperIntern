// 验收员看运行中的应用：在沙箱里驱动 headless chromium 的小脚本。
//
// 这个文件**不在宿主上跑**：live-app.mjs 每次会话把它原样拷进工作区的 .si-preview/，在容器里用 `node` 执行，
// 一条命令一个进程：连上已经起着的 chromium（远程调试口只听 127.0.0.1）、做一件事、打印一行 JSON、退出。
// 页面状态留在 chromium 里，所以"打开 → 点 → 再看"是连着的。
//
// 自包含：不 import 我们自己的任何代码（容器里只有工作区，没有 SuperIntern 的源码）。
// 只用 node 自带的 fetch 与 WebSocket（node 22 起默认有），零依赖 —— 与截图只用 chromium 自带开关同一条路。
//
// 用法：node drive.mjs '<json>'    json = { cmd, port, ...参数 }
//   open       { url }                 打开地址，等加载与请求停下来，返回页面概况
//   read       { selector? }           页面概况（可只看某个元素里的文字）
//   click      { target, dialog? }     点一个控件（target = 概况里的编号，或控件上的文字）
//   type       { target, text, enter?, dialog? } 在输入框里填字（先清空），可选回车
//   select     { target, value, dialog? } 下拉框选一项（值或显示文字）
//
// 页面弹框（alert / confirm / prompt / 离开页面确认）：动作期间弹的按 dialog 处理（'accept' 点确定，默认；'dismiss' 点取消），
// 结果里 dialogs 照实列出。弹框若在两条命令之间弹出（定时器之类，当时没有客户端接），页面会永久卡住 ——
// 连上时发现卡住就关掉这个标签页、在原地址重开，结果里 reopened 写明（页面上没提交的输入会丢）。
//   screenshot { file, full? }         截当前页面，写到 file（工作区里的路径）
// open / read / click / type / select 带 shot（工作区里的路径）时，做完再截一屏写到那里（给签收的人看 AI 点完看到了什么）。

import { writeFileSync } from 'node:fs';

const MAX_TEXT = 6000, MAX_CONTROLS = 60, SETTLE_MS = 500, MAX_WAIT_MS = 8000, ATTACH_MS = 3000;
const args = JSON.parse(process.argv[2] ?? '{}');
// 结果只写一次；进程等它写完再退（Windows 上管道写是异步的，先 exit 会把输出截掉）
let result = null;
const out = (o) => { result ??= o; };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = []; }
  open() {
    return new Promise((ok, ko) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => ok();
      this.ws.onerror = () => ko(new Error('连不上浏览器的调试口'));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          if (m.error) p.ko(new Error(m.error.message)); else p.ok(m.result);
        } else if (m.method) for (const h of this.handlers) h(m);
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, ko) => this.pending.set(id, { ok, ko }));
  }
  on(fn) { this.handlers.push(fn); }
  close() { try { this.ws.close(); } catch { /* 进程马上退出 */ } }
}

async function pageTarget(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.find((x) => x.type === 'page') ?? (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json());
}

// ── 页面里跑的函数（序列化后送进去，只能用页面自己的东西）──────────────────
// 概况：标题、地址、文字、可操作的控件。控件编上号（data-si-n），后面的 click / type 按号找。
function pageSummary(selector, maxText, maxControls) {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  // 下拉框的 innerText 是全部选项连在一起，不当标签用（选项另列）
  const label = (el) => (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || (el.tagName === 'SELECT' ? '' : el.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  for (const el of document.querySelectorAll('[data-si-n]')) el.removeAttribute('data-si-n');
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[onclick],[contenteditable=true]';
  const controls = [];
  for (const el of document.querySelectorAll(sel)) {
    if (controls.length >= maxControls || !visible(el)) continue;
    const n = controls.length + 1;
    el.setAttribute('data-si-n', String(n));
    const tag = el.tagName.toLowerCase();
    const c = { n, kind: tag === 'a' ? 'link' : tag === 'input' ? (el.type || 'text') : tag === 'button' || el.getAttribute('role') === 'button' ? 'button' : tag, label: label(el) };
    if ('value' in el && tag !== 'button' && el.type !== 'submit') c.value = String(el.value ?? '').slice(0, 80);
    if (el.type === 'checkbox' || el.type === 'radio') c.checked = el.checked;
    if (tag === 'select') c.options = [...el.options].slice(0, 12).map((o) => o.text.trim());
    if (el.disabled) c.disabled = true;
    controls.push(c);
  }
  const root = selector ? document.querySelector(selector) : document.body;
  const text = root ? String(root.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim() : null;
  return { title: document.title, url: location.href, found: !!root, text: text == null ? null : text.slice(0, maxText), truncated: !!text && text.length > maxText, controls };
}

// 按编号或文字找控件，滚到可见处，返回中心点坐标
function locate(target) {
  let el = null;
  if (/^\d+$/.test(String(target))) el = document.querySelector(`[data-si-n="${target}"]`);
  else {
    const want = String(target).replace(/\s+/g, ' ').trim().toLowerCase();
    const all = [...document.querySelectorAll('[data-si-n]')];
    const text = (e) => (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.getAttribute('value') || '').replace(/\s+/g, ' ').trim().toLowerCase();
    el = all.find((e) => text(e) === want) || all.find((e) => text(e).includes(want)) || null;
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), n: el.getAttribute('data-si-n') };
}

function focusAndSelect(n) {
  const el = document.querySelector(`[data-si-n="${n}"]`);
  if (!el) return false;
  el.focus();
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) document.execCommand('selectAll');
  return true;
}

function chooseOption(n, value) {
  const el = document.querySelector(`[data-si-n="${n}"]`);
  if (!el || el.tagName !== 'SELECT') return 'not_select';
  const want = String(value).trim();
  const opt = [...el.options].find((o) => o.value === want) || [...el.options].find((o) => o.text.trim() === want);
  if (!opt) return 'no_option';
  // React 之类受控组件只认原生 setter + 事件
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
async function main() {
  if (typeof WebSocket === 'undefined') return out({ ok: false, error: '这个 node 没有内置 WebSocket（需要 22 及以上）' });
  const port = args.port ?? 9333;
  // 动作期间发生的事：页面报错、控制台 error、失败的请求、弹框。只记这一条命令期间的
  const errors = [], failed = [], reqs = new Map(), dialogs = [];
  let inflight = 0, lastNet = Date.now(), reopened = null;
  const noise = (url) => /\/favicon\.ico(\?|$)/.test(url);   // 浏览器自己要的图标，页面没写也不算问题
  const accept = args.dialog !== 'dismiss';
  const watch = (cdp) => cdp.on((m) => {
    // 弹框不接，页面就停在那里，之后的取值一直等到超时（删除前的确认框，四组都没验成）
    if (m.method === 'Page.javascriptDialogOpening') {
      const type = m.params.type;
      dialogs.push({ type, message: String(m.params.message ?? '').slice(0, 200), answered: accept ? 'accept' : 'dismiss' });
      cdp.send('Page.handleJavaScriptDialog', { accept, ...(type === 'prompt' && accept ? { promptText: String(m.params.defaultPrompt ?? '') } : {}) }).catch(() => {});
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').split('\n')[0].slice(0, 200));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    else if (m.method === 'Network.requestWillBeSent') { inflight++; lastNet = Date.now(); reqs.set(m.params.requestId, `${m.params.request.method} ${m.params.request.url.slice(0, 160)}`); }
    else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
      inflight = Math.max(0, inflight - 1); lastNet = Date.now();
      const what = reqs.get(m.params.requestId) ?? '?';
      if (m.method === 'Network.loadingFailed' && !m.params.canceled && !noise(what)) failed.push({ request: what, error: m.params.errorText });
    } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400 && !noise(m.params.response.url)) {
      failed.push({ request: reqs.get(m.params.requestId) ?? m.params.response.url.slice(0, 160), status: m.params.response.status });
    }
  });
  // 连上、开三个域；页面被没人接的弹框卡住时 Page.enable 不回话 → 返回 null
  const attach = async (target) => {
    const c = new Cdp(target.webSocketDebuggerUrl);
    await c.open();
    watch(c);
    const up = await Promise.race([Promise.all([c.send('Runtime.enable'), c.send('Network.enable'), c.send('Page.enable')]).then(() => true), sleep(ATTACH_MS).then(() => false)]);
    if (up) return c;
    c.close();
    return null;
  };
  const target = await pageTarget(port);
  let cdp = await attach(target);
  if (!cdp) {
    // 命令之间弹出的框没人接（实验：之后 handleJavaScriptDialog 也说"没有弹框"，只能换标签页）：开新页、关旧页、回原地址
    const fresh = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    cdp = await attach(fresh);
    if (!cdp) return out({ ok: false, error: '浏览器的页面卡住了，重开也没恢复' });
    if (target.url && target.url !== 'about:blank') {
      const loaded = new Promise((ok) => cdp.on((m) => { if (m.method === 'Page.loadEventFired') ok(); }));
      await cdp.send('Page.navigate', { url: target.url });
      await Promise.race([loaded, sleep(MAX_WAIT_MS)]);
    }
    reopened = { url: target.url };
  }
  // 请求停下来 SETTLE_MS 毫秒才算稳（单页应用点一下常常再发几个请求）；最多等 MAX_WAIT_MS
  const settle = async () => {
    const t0 = Date.now();
    await sleep(150);
    while (Date.now() - t0 < MAX_WAIT_MS && (inflight > 0 || Date.now() - lastNet < SETTLE_MS)) await sleep(100);
  };
  const evalIn = async (fn, ...a) => {
    const r = await cdp.send('Runtime.evaluate', { expression: `(${fn.toString()})(${a.map((x) => JSON.stringify(x)).join(',')})`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0]);
    return r.result.value;
  };
  const summary = async (selector = null) => evalIn(pageSummary, selector, MAX_TEXT, MAX_CONTROLS);
  const finish = async (extra = {}) => {
    const page = await summary(args.selector ?? null);
    if (args.shot) {
      try { writeFileSync(args.shot, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); }
      catch { /* 截不到不影响这一步的结果 */ }
    }
    return out({ ok: true, ...extra, ...(dialogs.length ? { dialogs } : {}), ...(reopened ? { reopened } : {}),
      page, errors: [...new Set(errors)].slice(0, 10), failed: failed.slice(0, 10) });
  };
  const click = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const find = async () => {
    // 编号是上一次概况编的；页面重画过就找不到 —— 先重新编一次号再按文字找
    let at = await evalIn(locate, args.target);
    if (!at && !/^\d+$/.test(String(args.target))) { await summary(); at = await evalIn(locate, args.target); }
    return at;
  };

  // 每个分支都 return 一个还没完成的 promise：必须 await 完再关连接（不然 finally 先关、请求永远等不到回音、进程空着退出）
  const act = async () => {
    switch (args.cmd) {
      case 'open': {
        let status = null;
        cdp.on((m) => { if (m.method === 'Network.responseReceived' && m.params.type === 'Document' && status === null) status = m.params.response.status; });
        const loaded = new Promise((ok) => cdp.on((m) => { if (m.method === 'Page.loadEventFired') ok(); }));
        const nav = await cdp.send('Page.navigate', { url: args.url });
        if (nav.errorText) return out({ ok: false, error: `打不开 ${args.url}：${nav.errorText}` });
        await Promise.race([loaded, sleep(MAX_WAIT_MS)]);
        await settle();
        return finish({ status });
      }
      case 'read': return finish();
      case 'click': {
        const at = await find();
        if (!at) return out({ ok: false, error: `找不到控件「${args.target}」（页面可能变了：先 read_page 看现在的编号）` });
        const before = (await evalIn(() => location.href));
        await click(at.x, at.y);
        await settle();
        const after = await evalIn(() => location.href);
        return finish({ clicked: at.n, navigated: after !== before ? after : null });
      }
      case 'type': {
        const at = await find();
        if (!at) return out({ ok: false, error: `找不到控件「${args.target}」（先 read_page 看现在的编号）` });
        await evalIn(focusAndSelect, at.n);
        await cdp.send('Input.insertText', { text: String(args.text ?? '') });
        if (args.enter) {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        }
        await settle();
        return finish({ typed: at.n });
      }
      case 'select': {
        const at = await find();
        if (!at) return out({ ok: false, error: `找不到控件「${args.target}」（先 read_page 看现在的编号）` });
        const r = await evalIn(chooseOption, at.n, args.value);
        if (r !== 'ok') return out({ ok: false, error: r === 'not_select' ? `控件「${args.target}」不是下拉框` : `下拉框里没有「${args.value}」这一项` });
        await settle();
        return finish({ selected: at.n });
      }
      case 'screenshot': {
        const params = { format: 'png' };
        if (args.full) {
          const m = await cdp.send('Page.getLayoutMetrics');
          const w = Math.ceil(m.cssContentSize?.width ?? m.contentSize.width), h = Math.min(3000, Math.ceil(m.cssContentSize?.height ?? m.contentSize.height));
          Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
        }
        const r = await cdp.send('Page.captureScreenshot', params);
        writeFileSync(args.file, Buffer.from(r.data, 'base64'));
        return out({ ok: true, file: args.file, url: await evalIn(() => location.href) });
      }
      default: return out({ ok: false, error: `不认识的命令 ${args.cmd}` });
    }
  };
  try { await act(); } finally { cdp.close(); }
}

main().catch((e) => out({ ok: false, error: String(e?.message ?? e).slice(0, 300) }))
  .finally(() => process.stdout.write(JSON.stringify(result ?? { ok: false, error: '没有结果' }) + '\n', () => process.exit(0)));
