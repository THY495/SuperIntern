// 出网代理（core/net-proxy.mjs）：按 HTTPS_PROXY / HTTP_PROXY / NO_PROXY 打开 Node 内置的代理支持。
// 用一个本机假代理证明：外部地址的请求真的走了代理；本机地址（NO_PROXY 没写也一样）直连；日志里的代理地址不带口令。
// 会改本进程的全局代理设置，所以单独一个测试文件。
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { redactProxy, useEnvProxy } from '../src/core/net-proxy.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e !== undefined ? `\n         ${typeof e === 'string' ? e : JSON.stringify(e)}` : ''}`); };
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const listen = (handler) => new Promise((r) => { const s = createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });

try {
  eq(redactProxy('http://user:secret@proxy.lan:3128'), 'http://proxy.lan:3128', '代理地址去掉用户名口令再显示');
  eq(useEnvProxy({}).enabled, false, '没设代理 → 不开');
  eq(useEnvProxy({ HTTPS_PROXY: 'http://p:1', SUPERINTERN_IGNORE_ENV_PROXY: '1' }), { enabled: false, proxy: 'http://p:1', why: 'ignored' }, 'SUPERINTERN_IGNORE_ENV_PROXY=1 → 不开');
  eq(useEnvProxy({ HTTPS_PROXY: 'http://p:1', NODE_USE_ENV_PROXY: '1' }).why, 'node', 'Node 自己的开关已开 → 不重复设');

  // 假代理：普通转发（请求行是完整 URL）直接回标记；CONNECT 隧道（Node 对 http 目标也可能这样走）接到一个回标记的本机服务上
  const seen = [];
  const behind = await listen((req, res) => res.end('via-proxy'));
  const proxy = await listen((req, res) => { seen.push(req.url); res.end('via-proxy'); });
  proxy.on('connect', (req, sock, head) => {
    seen.push(`CONNECT ${req.url}`);
    const up = connect(behind.address().port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  const target = await listen((req, res) => res.end('direct'));
  const get = async (u) => (await fetch(u, { signal: AbortSignal.timeout(5000) })).text();
  const P = `http://127.0.0.1:${proxy.address().port}`;
  const r = useEnvProxy({ HTTP_PROXY: P, HTTPS_PROXY: P, NO_PROXY: 'internal.lan' });
  eq([r.enabled, r.why], [true, 'env'], '设了 HTTP(S)_PROXY → 打开');
  const viaProxy = await get('http://example.invalid/ping');
  eq([viaProxy, seen.some((x) => x === 'http://example.invalid/ping' || x === 'CONNECT example.invalid:80')], ['via-proxy', true], '外部地址的请求经过代理（Node 的 fetch 原来不看这些环境变量）');
  const direct = await get(`http://127.0.0.1:${target.address().port}/`);
  eq(direct, 'direct', '本机地址直连（NO_PROXY 里没写 127.0.0.1 也一样）');
  const lh = await get(`http://localhost:${target.address().port}/`);
  eq(lh, 'direct', 'localhost 直连');
  for (const s of [proxy, target, behind]) { s.closeAllConnections(); s.close(); }
} catch (e) {
  bad('意外异常', e.stack);
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;   // 不用 process.exit：网络请求刚结束就退，Windows 上 libuv 会断言失败
