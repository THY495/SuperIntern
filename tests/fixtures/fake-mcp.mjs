// 测试用的假 MCP server（stdio，换行分隔的 JSON-RPC）。
//   node fake-mcp.mjs new|old [工具清单文件]
//   new：2026-07-28 无状态版（认 server/discover，每个请求要带 _meta）；old：旧版（只认 initialize，server/discover 回 -32601）
// 工具：echo（回 msg 与有没有收到 _meta）、big（6 万字符）、fail（isError）、change（发 list_changed 再回）、crash（直接退出）、env（回环境变量）
import { readFileSync } from 'node:fs';
const [mode = 'new', toolsFile] = process.argv.slice(2);
const DEFAULT_TOOLS = [
  { name: 'echo', description: '原样回显', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } },
  { name: 'big', description: '很长的输出', inputSchema: { type: 'object', properties: {} } },
  { name: 'fail', description: '报错', inputSchema: { type: 'object', properties: {} } },
  { name: 'change', description: '中途改工具清单', inputSchema: { type: 'object', properties: {} } },
  { name: 'crash', description: '退出', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: '看环境变量', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
];
const tools = toolsFile ? JSON.parse(readFileSync(toolsFile, 'utf8')) : DEFAULT_TOOLS;
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
process.stdout.write('fake-mcp starting（这一行不是 JSON，客户端应当跳过）\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
});
process.stdin.on('end', () => process.exit(0));
function handle(m) {
  if (m.id == null) return;   // 通知
  const meta = !!m.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  const err = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  if (m.method === 'server/discover') return mode === 'new' ? ok({ serverInfo: { name: 'fake', version: '1' }, capabilities: { tools: {} } }) : err(-32601, 'Method not found');
  if (m.method === 'initialize') return mode === 'old' ? ok({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake-old', version: '1' }, capabilities: { tools: {} } }) : err(-32601, 'stateless server');
  if (mode === 'new' && !meta) return err(-32600, 'missing _meta');
  if (m.method === 'tools/list') {
    // 分两页
    const half = Math.ceil(tools.length / 2);
    return m.params?.cursor === 'p2' ? ok({ tools: tools.slice(half), ttlMs: 60000 }) : ok({ tools: tools.slice(0, half), nextCursor: 'p2', ttlMs: 60000 });
  }
  if (m.method === 'tools/call') {
    const { name, arguments: a = {} } = m.params;
    if (name === 'echo') return ok({ content: [{ type: 'text', text: `echo:${a.msg ?? ''} meta:${meta}` }] });
    if (name === 'big') return ok({ content: [{ type: 'text', text: 'x'.repeat(60_000) }] });
    if (name === 'fail') return ok({ content: [{ type: 'text', text: '出错了' }], isError: true });
    if (name === 'change') { send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); return ok({ content: [{ type: 'text', text: 'changed' }] }); }
    if (name === 'crash') process.exit(3);
    if (name === 'env') return ok({ content: [{ type: 'text', text: JSON.stringify({ FOO: process.env.FOO ?? null, API_TOKEN: process.env.API_TOKEN ?? null }) }], structuredContent: { ok: true } });
    return err(-32602, `unknown tool ${name}`);
  }
  return err(-32601, 'Method not found');
}
