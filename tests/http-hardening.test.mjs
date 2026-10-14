// HTTP 加固：
//   ① 请求体超限 → 及时回 413（原来只 destroy 连接，处理函数里等请求体的 promise 永远挂着）；
//   ② 请求体不是合法 JSON → 400；
//   ③ 意料之外的错误（库错误、程序错）→ 500 + 一句通用的话，不把 SQL / 堆栈回给浏览器，细节进审计（http_error）；
//      业务错误照旧 4xx 带原话；
//   ④ 连接层上限设上了（requestTimeout / headersTimeout / maxConnections）。
//
// 跑：node tests/http-hardening.test.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { openDb, ensureOwner } from '../src/db/db.mjs';
import { startWeb, classifyError, MAX_BODY_BYTES } from '../src/web/server.mjs';
import { I18nError } from '../src/i18n/index.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);
const TMP = mkdtempSync(join(tmpdir(), 'si-http-'));

const real = openDb(':memory:');
const owner = ensureOwner(real);
// 让某个读查询按需抛一个"库错误"，模拟意料之外的内部故障；其余方法原样转给真库
let boom = false;
const db = new Proxy(real, {
  get(t, k) {
    if (k === 'all' && boom) return () => { throw Object.assign(new Error('no such column: secret_internal_col IN tasks'), { code: 'ERR_SQLITE_ERROR' }); };
    const v = t[k];
    return typeof v === 'function' ? v.bind(t) : v;
  },
});
const w = await startWeb(db, { home: join(TMP, 'home'), port: 0, tokenPlain: owner.plaintext, pollMs: 1000 });

/** 发一个请求；body 可以是字符串或 Buffer。返回 { status, json, ms }。 */
function send(method, path, body = null, headers = {}) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const r = request({ host: '127.0.0.1', port: w.port, method, path, headers: { 'content-type': 'application/json', ...headers } }, (resp) => {
      let s = '';
      resp.on('data', (c) => { s += c; });
      resp.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { /* 非 JSON */ } res({ status: resp.statusCode, json: j, text: s, ms: Date.now() - t0 }); });
    });
    r.on('error', (e) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? null : rej(e)));
    r.setTimeout(10_000, () => { r.destroy(); rej(new Error('请求 10 秒没回 —— 挂住了')); });
    if (body != null) r.write(body);
    r.end();
  });
}

try {
  section('① 请求体超限 → 413，不挂');
  {
    const big = JSON.stringify({ lang: 'x'.repeat(MAX_BODY_BYTES + 10) });
    const r = await send('POST', '/api/me/lang', big);
    eq(r.status, 413, `超过 ${MAX_BODY_BYTES} 字节回 413`);
    assert(r.ms < 5000, `及时回（${r.ms} ms）`);
    assert(/1000000/.test(String(r.json?.error)), `说明里带上限（${r.json?.error}）`);
    const after = await send('GET', '/api/me');
    eq(after.status, 200, '之后的请求照常');
  }

  section('② 请求体不是合法 JSON → 400');
  {
    const r = await send('POST', '/api/me/lang', '{"lang": ');
    eq(r.status, 400, '回 400');
    assert(/JSON/.test(String(r.json?.error)), `说明是 JSON 不合法（${r.json?.error}）`);
    const en = await send('POST', '/api/me/lang', 'nope', { 'accept-language': 'en' });
    eq(en.status, 400, '英文界面同样 400');
  }

  section('③ 意料之外的错误 → 500，细节不出门，进审计');
  {
    boom = true;
    const r = await send('GET', '/api/tasks');
    boom = false;
    eq(r.status, 500, '回 500');
    assert(!/secret_internal_col|ERR_SQLITE|at .*\.mjs/.test(r.text), `响应里没有 SQL / 错误码 / 堆栈（${r.text}）`);
    const a = real.one(`SELECT target_id, payload FROM audit_log WHERE action='http_error' ORDER BY id DESC LIMIT 1`);
    assert(!!a, '记了一条 http_error');
    const p = JSON.parse(a?.payload ?? '{}');
    eq([a?.target_id, /secret_internal_col/.test(p.error), p.code, Array.isArray(p.stack) && p.stack.length > 0], ['GET /api/tasks', true, 'ERR_SQLITE_ERROR', true], '审计里有路由、原话、错误码、堆栈前几行');
    const again = await send('GET', '/api/tasks');
    eq(again.status, 200, '故障过去后同一路由照常');
  }

  section('③b 错误分类');
  {
    eq(classifyError(Object.assign(new Error('x'), { status: 413 })), { status: 413, expose: true }, '写明 status 的照用');
    eq(classifyError(new I18nError('不认识的语言：{lang}', { lang: 'q' })), { status: 400, expose: true }, '业务错误（I18nError）400 带原话');
    eq(classifyError(new Error('任务不存在')), { status: 400, expose: true }, '普通 Error 400 带原话');
    eq(classifyError(new TypeError("Cannot read properties of undefined (reading 'id')")), { status: 500, expose: false }, 'TypeError → 500 不带原话');
    eq(classifyError(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' })), { status: 500, expose: false }, '库错误 → 500 不带原话');
  }

  section('④ 连接层上限');
  eq([w.server.requestTimeout, w.server.headersTimeout, w.server.maxConnections], [120_000, 30_000, 512], 'requestTimeout / headersTimeout / maxConnections 都设了');
} catch (e) {
  bad('测试本身出错', e?.stack ?? e);
} finally {
  w.close();
  real.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
