// 最小的 Chrome DevTools Protocol 客户端（零依赖：Node 自带的 WebSocket）+ 找本机的 Chromium 系浏览器、起无头实例。
// 给 tests/a11y.test.mjs 用：在真浏览器里算样式、按 Tab、调视口与配色。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 本机的 Chromium 系浏览器：SUPERINTERN_CHROME 优先，其次常见安装位置；找不到返回 null */
export function findBrowser(env = process.env) {
  if (env.SUPERINTERN_CHROME) return existsSync(env.SUPERINTERN_CHROME) ? env.SUPERINTERN_CHROME : null;
  const pf = env.ProgramFiles ?? 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', la = env.LOCALAPPDATA ?? '';
  const cands = process.platform === 'win32'
    ? [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${la}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/chromium', '/usr/local/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  return cands.find((p) => p && existsSync(p)) ?? null;
}

/** 起一个无头浏览器，返回 { port, close } */
export async function launch(exe) {
  const dir = mkdtempSync(join(tmpdir(), 'si-cdp-'));
  // Linux 的 CI 机器（Ubuntu 24.04 的 AppArmor 不许非特权用户建命名空间）上 Chrome 的沙箱起不来；测试只开本机的看板页面，关掉沙箱无妨
  const noSandbox = process.platform === 'linux' && (process.env.CI === 'true' || process.env.SUPERINTERN_CHROME_NO_SANDBOX === '1');
  const args = [...(noSandbox ? ['--no-sandbox'] : []), '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--hide-scrollbars', '--mute-audio', '--window-size=1280,900', 'about:blank'];
  // 端口先从 stderr 的 "DevTools listening on ws://127.0.0.1:<端口>/…" 读：snap 装的 Chromium 有自己私有的 /tmp，
  // 它写进数据目录的 DevToolsActivePort 这边看不到。读不到再退回读那个文件
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let port = null, errText = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => { if (port) return; errText = (errText + c).slice(-4000); const m = /DevTools listening on ws:\/\/[^:/]+:(\d+)\//.exec(errText); if (m) port = Number(m[1]); });
  const portFile = join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !port; i++) {
    if (existsSync(portFile)) { try { port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || null; } catch { /* 还在写 */ } }
    if (!port) await new Promise((r) => setTimeout(r, 50));
  }
  if (!port) { proc.kill(); throw new Error(`浏览器没起来：${exe}${errText.trim() ? `\n${errText.trim().slice(-800)}` : ''}`); }
  return {
    port,
    close: async () => { proc.kill(); await new Promise((r) => setTimeout(r, 300)); try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上进程刚退还占着 */ } },
  };
}

/** 开一个新标签页并连上，返回 { send(method, params), on(event, fn), close } */
export async function openPage(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('连不上 DevTools')); });
  let id = 0;
  const pending = new Map(), listeners = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result); }
    else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const on = (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, []); listeners.get(ev).push(fn); };
  /** 在页面里求值，返回值按 JSON 带回；页面里抛错就在这里抛 */
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面里出错：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  return { send, on, evaluate, close: () => { try { ws.close(); } catch { /* 已断 */ } } };
}
