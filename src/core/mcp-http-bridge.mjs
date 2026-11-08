// 远程 MCP server 的桥：在任务的沙箱里跑，一头是 stdio（换行分隔的 JSON-RPC，McpConnection 照常说话），
// 一头是 Streamable HTTP（每条消息 POST 到 url；回 JSON 或 text/event-stream）。
//
// 为什么在沙箱里、而不是在宿主上直接发 HTTP：宿主上发出去的请求绕过出口代理 —— 放行表、凭据注入、只读收窄全都管不到。
// 桥在沙箱里，fetch 经 NODE_USE_ENV_PROXY 走代理，远程 server 和沙箱里别的出网一视同仁。
//
// 由 mcp.mjs 用 `node --input-type=module -e <本文件源码> <url> <headers JSON>` 起：不往工作区落文件（AI 改不到它）。
// 只依赖 Node 内置；旧版 server 回的 Mcp-Session-Id 记下来、之后每条都带上。
// 桥自己的报错带 error.data.si = { tpl, params }，宿主按看的人的语言翻（N_ 只为登记进目录；server 回的同名字段一律剥掉，冒充不了）。
const N_ = (s) => s;
const [url, headerJson] = process.argv.slice(1);
const headers = JSON.parse(headerJson || '{}');
const host = (() => { try { return new URL(url).host; } catch { return url; } })();
let session = null;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const fmt = (tpl, p) => tpl.replace(/{(w+)}/g, (m, k) => (k in p ? String(p[k]) : m));
const fail = (id, tpl, params = {}) => { if (id != null) out({ jsonrpc: '2.0', id, error: { code: -32000, message: fmt(tpl, params), data: { si: { tpl, params } } } }); };
const pass = (x) => { if (x?.error?.data && typeof x.error.data === 'object') delete x.error.data.si; out(x); };

async function handle(m) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', body: JSON.stringify(m),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...headers } });
  } catch (e) {
    const loop = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(host);
    return fail(m.id, loop
      ? N_('连不上 {host}（{why}）：在沙箱里 {host} 是沙箱自己，不是服务器 —— url 多半写错了')
      : N_('连不上 {host}（{why}）：地址写错了，或者没在「联网」里放行（沙箱只能连放行的地址）'), { host, why: String(e.cause?.code || e.cause?.message || e.message) });
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  if (m.id == null || res.status === 202) { try { await res.arrayBuffer(); } catch { /* 丢掉 */ } return; }
  if (!res.ok) {
    const p = { status: res.status, host, body: (await res.text().catch(() => '')).slice(0, 300) };
    return fail(m.id, res.status === 403 || res.status === 407 ? N_('HTTP {status}（出口代理拦下了：{host} 没在「联网」里放行，或者带着凭据时没允许写 —— MCP 的请求都是 POST）：{body}') : N_('HTTP {status}：{body}'), p);
  }
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    const j = await res.json().catch(() => null);
    if (j == null) return fail(m.id, N_('{host} 回的不是 JSON'), { host });
    for (const x of Array.isArray(j) ? j : [j]) pass(x);
    return;
  }
  // SSE：事件之间空行分隔，data: 行拼起来是一条 JSON-RPC 消息
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    let x;
    try { x = JSON.parse(data); } catch { return; /* 不是 JSON 的事件跳过 */ }
    pass(x);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(buf.slice(i).match(/^\r?\n\r?\n/)[0].length + i); }
  }
  if (buf.trim()) flush(buf);
}

// 按到达顺序一条一条发：旧版 server 要先收到 notifications/initialized 再收别的（执行器本来也是一次一个工具调用）
let chain = Promise.resolve();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    chain = chain.then(() => handle(m)).catch((e) => fail(m.id, N_('桥出错：{why}'), { why: String(e.message) }));
  }
});
process.stdin.on('end', () => { chain.finally(() => process.exit(0)); });
