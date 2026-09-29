// 团队模式：多人各自从自己的电脑登录看板。
//
// 跑：node tests/team.test.mjs
//
// 要证明的是"没有兜底身份"：本机模式下不带令牌 = 起看板的负责人；团队模式下那等于把负责人让给任何摸得到地址的人。
// 所以每一条都从"不带凭证 / 带别人的凭证 / 带伪造的来源"去打，看它是不是真的拒。

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { startWeb } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e !== undefined ? `\n         ${typeof e === 'string' ? e : JSON.stringify(e)}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (t) => console.log(`\n── ${t}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-team-'));
const HOME = join(TMP, 'home'); mkdirSync(HOME);
const db = openDb(join(HOME, 'state.db'));
const owner = ensureOwner(db, '负责人');
const fe = addUser(db, { name: '前端', role: 'member', byUserId: owner.userId });
const ob = addUser(db, { name: '旁观', role: 'observer', byUserId: owner.userId });

const PUB = 'si.team.lan';
let port;
/** 原样控制 Host / Origin / Cookie 的请求（fetch 不让改 Host） */
const call = (method, path, { host = `${PUB}`, headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const data = body === null ? null : JSON.stringify(body);
  const r = request({ host: '127.0.0.1', port, method, path, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: res.statusCode, headers: res.headers, body: j }); });
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});
const cookieOf = (r) => String([].concat(r.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];

section('0 · 启动：团队模式必须给对外地址');
{
  let err = null; try { startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, team: true }); } catch (e) { err = e.message; }
  assert(/public-url/.test(err ?? ''), '没给对外地址 → 拒绝启动', err);
}

const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100, team: true, publicUrl: `https://${PUB}` });
port = w.port;
try {
  section('1 · 没有兜底身份：不带凭证什么都拿不到');
  let r = await call('GET', '/api/session');
  eq([r.status, r.body.team, r.body.loggedIn], [200, true, false], '会话状态：团队模式、未登录');
  eq(r.body.admins, ['负责人'], '没登录时只告诉你管理员是谁（去找他要令牌），别的一概不给');
  eq(Object.keys(r.body).sort(), ['admins', 'loggedIn', 'team'], '会话状态接口没有多余字段');
  r = await call('GET', '/');
  eq(r.status, 200, '页面本身能打开（里面没有数据，只有登录框）');
  for (const p of ['/api/tasks', '/api/me', '/api/digest', '/api/projects', '/api/users', '/api/events']) {
    r = await call('GET', p);
    eq([r.status, r.body?.login], [401, true], `未登录 GET ${p} → 401（本机模式下这里是负责人）`);
  }
  r = await call('POST', '/api/projects', { body: { goal: 'g', doneDefinition: 'd', empty: true } });
  eq(r.status, 401, '未登录不能建项目');

  section('2 · 登录：换成 HttpOnly cookie，身份是自己的，不是负责人的');
  r = await call('POST', '/api/login', { body: { token: 'not-a-token' } });
  eq(r.status, 401, '错令牌 → 401');
  r = await call('POST', '/api/login', { body: { token: fe.plaintext } });
  eq(r.status, 200, '成员用自己的令牌登录');
  const sc = String([].concat(r.headers['set-cookie'] ?? [])[0] ?? '');
  assert(/HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Secure/.test(sc) && /Max-Age=\d+/.test(sc), `cookie 带 HttpOnly / SameSite=Strict / Secure（对外是 https）：${sc.replace(/si_token=[^;]+/, 'si_token=…')}`);
  const feCookie = cookieOf(r);
  r = await call('GET', '/api/me', { headers: { cookie: feCookie } });
  eq([r.status, r.body.id, r.body.role], [200, fe.userId, 'member'], '带 cookie：身份是前端（成员），不是负责人');
  r = await call('GET', '/api/me', { headers: { 'x-superintern-token': ob.plaintext } });
  eq([r.status, r.body.id], [200, ob.userId], '脚本用请求头带令牌也行（角色 agent / 工具）');
  r = await call('GET', '/api/session', { headers: { cookie: feCookie } });
  eq(r.body.loggedIn, true, '会话状态：已登录');

  section('3 · 登录之后，权限仍按人算');
  r = await call('POST', '/api/llm', { headers: { cookie: feCookie }, body: { action: 'binding', tier: 'light', model: 'x/y' } });
  eq(r.status, 403, '成员改不了模型分配（管理员才行）');
  r = await call('POST', '/api/users', { headers: { cookie: feCookie }, body: { action: 'add', name: '冒充', role: 'member' } });
  eq(r.status, 403, '成员加不了人');
  const oc = cookieOf(await call('POST', '/api/login', { body: { token: owner.plaintext } }));
  r = await call('POST', '/api/projects', { headers: { cookie: oc }, body: { goal: '做一个待办清单', doneDefinition: '测试全过', empty: true } });
  eq(r.status, 200, '负责人登录后能建项目');
  const pid = r.body?.result?.projectId;
  r = await call('POST', `/api/projects/${pid}/budget`, { headers: { cookie: feCookie }, body: { usd: 1 } });
  eq(r.status, 403, '成员改不了别人项目的预算（原来不带令牌时这一下是负责人做的）');

  section('4 · 来源：只认本机名和对外地址，跨站 POST 照样拒');
  r = await call('GET', '/api/session', { host: 'evil.example.com' });
  eq(r.status, 403, 'Host 是别的域名 → 拒（DNS 重绑定）');
  r = await call('GET', '/api/session', { host: '10.0.0.5:7357' });
  eq(r.status, 403, '直连内网 IP（绕过代理）→ 拒：只认配置的对外地址');
  r = await call('POST', '/api/logout', { headers: { cookie: feCookie, origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' }, body: {} });
  eq(r.status, 403, '别的网站借浏览器发 POST → 拒');
  r = await call('POST', '/api/login', { headers: { origin: `https://${PUB}`, 'sec-fetch-site': 'same-origin' }, body: { token: fe.plaintext } });
  eq(r.status, 200, '看板页面自己发的 POST 照常');

  section('5 · 退出与吊销');
  r = await call('POST', '/api/logout', { headers: { cookie: feCookie }, body: {} });
  const out = String([].concat(r.headers['set-cookie'] ?? [])[0] ?? '');
  assert(/si_token=;/.test(out) && /Max-Age=0/.test(out), '退出：cookie 清掉');
  db.run(`UPDATE tokens SET revoked_at=? WHERE user_id=?`, Date.now(), ob.userId);
  r = await call('GET', '/api/me', { headers: { 'x-superintern-token': ob.plaintext } });
  eq(r.status, 401, '令牌被吊销 → 立刻进不来（会话就是令牌，不另存一份活得更久的）');

  section('6 · 登录限速');
  let last = null;
  for (let i = 0; i < 21; i++) last = await call('POST', '/api/login', { body: { token: `wrong-${i}` } });
  eq(last.status, 429, '连续 20 次错令牌之后 → 429');
  r = await call('POST', '/api/login', { body: { token: fe.plaintext } });
  eq(r.status, 429, '限速期间对的令牌也先挡住（否则限速等于没有）');
  r = await call('POST', '/api/login', { headers: { 'x-forwarded-for': '10.0.0.8' }, body: { token: fe.plaintext } });
  eq(r.status, 200, '经本机反向代理来的另一个人（X-Forwarded-For 不同）不受牵连 —— 否则一个人连错就锁全员');
  r = await call('GET', '/');
  assert(r.headers['x-frame-options'] === 'DENY' && /frame-ancestors 'none'/.test(r.headers['content-security-policy'] ?? ''), '页面不许被别的站嵌进 iframe（点击劫持）');
} finally { await w.close?.(); }

section('7 · 本机模式不变');
{
  const w2 = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100 });
  port = w2.port;
  try {
    let r = await call('GET', '/api/me', { host: '127.0.0.1' });
    eq([r.status, r.body.id], [200, owner.userId], '本机模式：不带令牌 = 起看板的人（原行为）');
    r = await call('GET', '/api/session', { host: '127.0.0.1' });
    eq([r.body.team, r.body.loggedIn], [false, true], '会话状态：本机模式');
    r = await call('POST', '/api/login', { host: '127.0.0.1', body: { token: fe.plaintext } });
    eq(r.status, 404, '本机模式没有登录接口');
    r = await call('GET', '/api/session', { host: PUB });
    eq(r.status, 403, '本机模式不认对外域名');
  } finally { await w2.close?.(); }
}

section('7b · 交付凭证与新项目默认放行，都能在页面上做（原来只能改服务器上的 .env / 每个项目各勾一次）');
{
  const { writeFileSync: wf, readFileSync: rf } = await import('node:fs');
  const envFile = join(TMP, 'test.env'); wf(envFile, 'OTHER=1\n');
  const fakeEnv = {};
  const w4 = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100, team: true, publicUrl: `https://${PUB}`, envFile, env: fakeEnv });
  port = w4.port;
  try {
    const oc = cookieOf(await call('POST', '/api/login', { body: { token: owner.plaintext } }));
    const fc = cookieOf(await call('POST', '/api/login', { body: { token: fe.plaintext } }));
    let r = await call('GET', '/api/secrets', { headers: { cookie: fc } });
    eq(r.status, 403, '成员看不了交付凭证');
    r = await call('GET', '/api/secrets', { headers: { cookie: oc } });
    eq([r.status, r.body.GITHUB_TOKEN], [200, false], '管理员：未填');
    r = await call('POST', '/api/secrets', { headers: { cookie: oc }, body: { name: 'GITHUB_TOKEN', value: 'ghp_fake_for_test' } });
    eq([r.status, r.body.result?.GITHUB_TOKEN], [200, true], '管理员填了 → 已填');
    assert(!JSON.stringify(r.body).includes('ghp_fake'), '响应里没有回显值');
    assert(/^GITHUB_TOKEN=ghp_fake_for_test$/m.test(rf(envFile, 'utf8')) && /^OTHER=1$/m.test(rf(envFile, 'utf8')), '写进 .env，别的行不动');
    eq(fakeEnv.GITHUB_TOKEN, 'ghp_fake_for_test', '当前进程立即生效（交付时读得到）');
    const au = db.one(`SELECT payload FROM audit_log WHERE action='secret_set' ORDER BY id DESC LIMIT 1`);
    assert(au && !au.payload.includes('ghp_fake'), '审计只记"填了"，不记值');
    r = await call('POST', '/api/secrets', { headers: { cookie: oc }, body: { name: 'DEEPSEEK_API_KEY', value: 'x' } });
    eq(r.status, 400, '只能设 GITHUB_TOKEN（模型 key 走模型设置那一页）');

    const { addSource } = await import('../src/core/egress.mjs');
    const src = addSource(db, { name: '清华 PyPI', hosts: ['pypi.tuna.tsinghua.edu.cn'], userId: owner.userId });
    r = await call('POST', '/api/egress/sources', { headers: { cookie: fc }, body: { action: 'default', id: src.id, on: true } });
    eq(r.status, 403, '成员设不了新项目默认放行');
    r = await call('POST', '/api/egress/sources', { headers: { cookie: oc }, body: { action: 'default', id: src.id, on: true } });
    eq(r.status, 200, '管理员勾上「新项目默认放行」');
    r = await call('GET', '/api/egress/sources', { headers: { cookie: oc } });
    eq(r.body.sources.find((x) => x.id === src.id)?.isDefault, true, '目录里标着默认放行');
    r = await call('POST', '/api/projects', { headers: { cookie: oc }, body: { goal: '做一个待办清单', doneDefinition: '测试全过', empty: true } });
    const { projectEgressOf } = await import('../src/core/egress.mjs');
    eq(JSON.stringify(projectEgressOf(db, r.body.result.projectId)), JSON.stringify([src.id]), '新建的项目一建好就放行它（不用负责人再勾、第一次装依赖不多一条事项）');
  } finally { await w4.close?.(); }
}

section('8 · 运行健康：容器运行时不在，看板说出来');
{
  const w3 = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100, runtime: { current: () => ({ ok: false, cli: 'docker', why: 'failed to connect to the docker API' }) } });
  port = w3.port;
  try {
    const r = await call('GET', '/api/tasks', { host: '127.0.0.1' });
    eq([r.status, r.body.runtime?.ok, r.body.runtime?.why], [200, false, 'failed to connect to the docker API'], '任务列表带上运行时状态（页面据此在顶部报警）');
  } finally { await w3.close?.(); }
}

db.close();
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 偶尔还占着 */ }
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
