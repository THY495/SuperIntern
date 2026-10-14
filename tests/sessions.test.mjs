// 身份与会话：
//   ① 签发：命令行令牌按部署设置过期（0 = 不过期）；作用域只认 read / write；服务账户只能签服务令牌；
//   ② 有效性：过期、闲置超时、来源令牌被吊销 —— 一律认不出；"最后使用"一分钟内只记一次；
//   ③ 登录：cookie 里是新开的会话令牌、不是长期令牌本身；退出 = 服务端吊销会话（拿着旧 cookie 再来是 401）；
//      吊销长期令牌 → 用它登录的会话跟着失效；服务账户的令牌不能登录；
//   ④ 只读令牌：GET 可以、任何改动 403（在分派器一处执行）；
//   ⑤ 服务账户替人做事：x-si-on-behalf-of → 这次请求的审计都记 on_behalf_of；人带这个头 → 403；
//   ⑥ 我的令牌：列出（标出当前这枚）、新签（明文只给一次）、逐个吊销、"吊销其它全部"留下当前会话与它的来源；
//      管理员看全员、能吊销任何人的；成员碰管理员接口 403、吊销别人的 403；
//   ⑦ 邀请：管理员发 → 链接能看（角色）→ 接受 = 建成员 + 会话 cookie + 一次性命令行令牌；用过、撤销、过期一律 410；
//      本机模式不收邀请；
//   ⑧ 升级前签发的令牌：kind=cli、不过期、名字标"升级前签发"。
//
// 跑：node tests/sessions.test.mjs

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, authenticate, now, TOKEN_TOUCH_MS } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { issueToken, addServiceAccount, createInvite, revokeInviteBy } from '../src/core/sessions.mjs';
import { startWeb } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e !== undefined ? `\n         ${typeof e === 'string' ? e : JSON.stringify(e)}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (t) => console.log(`\n── ${t}`);
const rejects = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const D = 86400_000;

const TMP = mkdtempSync(join(tmpdir(), 'si-sess-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const HOME = join(TMP, 'home'); mkdirSync(HOME);
const db = openDb(join(HOME, 'state.db'));
const owner = ensureOwner(db, '负责人');
const fe = addUser(db, { name: '前端', role: 'member', byUserId: owner.userId });

section('① 签发');
{
  const t0 = now();
  eq(Math.round((db.one(`SELECT expires_at FROM tokens WHERE id=?`, fe.tokenId).expires_at - t0) / D), 90, '加人时签的命令行令牌默认 90 天过期');
  setSetting(db, { key: 'deploy.cli_token_days', value: 0, userId: owner.userId });
  const forever = issueToken(db, { userId: fe.userId, by: fe.userId, name: '不过期' });
  eq(forever.expiresAt, null, 'deploy.cli_token_days = 0：不过期');
  setSetting(db, { key: 'deploy.cli_token_days', value: 90, userId: owner.userId });
  assert(/read|write/.test(rejects(() => issueToken(db, { userId: fe.userId, by: fe.userId, scope: 'admin' })) ?? ''), '作用域只认 read / write');
  const svc = addServiceAccount(db, { name: '构建机器人', byUserId: owner.userId });
  assert(/服务账户/.test(rejects(() => issueToken(db, { userId: svc.userId, by: owner.userId, kind: 'cli' })) ?? ''), '服务账户只能签服务令牌');
  assert(/服务账户/.test(rejects(() => issueToken(db, { userId: fe.userId, by: owner.userId, kind: 'service' })) ?? ''), '人不能签服务令牌');
}

section('② 有效性');
{
  const at = now();
  const short = issueToken(db, { userId: fe.userId, by: fe.userId, name: '一天', days: 1 });
  eq(!!authenticate(db, short.plaintext, { at }), true, '没过期：认得');
  eq(authenticate(db, short.plaintext, { at: at + 2 * D }), null, '过了绝对期限：认不出');
  const before = db.one(`SELECT last_used_at FROM tokens WHERE id=?`, short.tokenId).last_used_at;
  authenticate(db, short.plaintext, { at: at + 1000 });
  eq(db.one(`SELECT last_used_at FROM tokens WHERE id=?`, short.tokenId).last_used_at, before, `"最后使用"一分钟（${TOKEN_TOUCH_MS / 1000} s）内不重复写`);
  authenticate(db, short.plaintext, { at: at + TOKEN_TOUCH_MS + 1, ip: '10.0.0.9' });
  eq(db.one(`SELECT last_ip FROM tokens WHERE id=?`, short.tokenId).last_ip, '10.0.0.9', '过了一分钟再用：记下时刻与来源地址');
}

const PUB = 'si.team.lan';
let port;
const call = (method, path, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const data = body === null ? null : JSON.stringify(body);
  const r = request({ host: '127.0.0.1', port, method, path, headers: { host: PUB, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: res.statusCode, headers: res.headers, body: j }); });
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});
const cookieOf = (r) => String([].concat(r.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];
const as = (cookie) => ({ headers: { cookie } });
const tok = (t) => ({ headers: { 'x-superintern-token': t } });
const login = async (token) => cookieOf(await call('POST', '/api/login', { body: { token } }));

const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100, team: true, publicUrl: `https://${PUB}` });
port = w.port;
try {
  section('③ 登录换会话、退出即吊销、来源令牌一吊销会话就失效');
  const c1 = await login(fe.plaintext);
  assert(c1.startsWith('si_token=') && !c1.includes(encodeURIComponent(fe.plaintext)), 'cookie 里是新开的会话令牌，不是长期令牌本身');
  eq((await call('GET', '/api/me', as(c1))).status, 200, '会话能用');
  const sess = db.one(`SELECT kind, parent_id, idle_ms, expires_at - issued_at life FROM tokens WHERE user_id=? AND kind='session' ORDER BY issued_at DESC LIMIT 1`, fe.userId);
  eq([sess.kind, sess.parent_id, sess.idle_ms, Math.round(sess.life / D)], ['session', fe.tokenId, 12 * 3600_000, 7], '会话：指着来源令牌、闲置 12 h、最长 7 天');
  await call('POST', '/api/logout', { ...as(c1), body: {} });
  const after = await call('GET', '/api/me', as(c1));
  eq([after.status, after.body.login], [401, true], '退出之后拿旧 cookie 再来：401（原来只清 cookie，令牌照样有效）');
  const extra = issueToken(db, { userId: fe.userId, by: fe.userId, name: '临时' });
  const c2 = await login(extra.plaintext);
  eq((await call('GET', '/api/me', as(c2))).status, 200, '用另一枚令牌登录');
  await call('POST', '/api/me/tokens/revoke', { ...as(c2), body: { id: extra.tokenId } });
  eq((await call('GET', '/api/me', as(c2))).status, 401, '吊销来源令牌 → 用它登录的会话跟着失效');
  const svc = db.one(`SELECT k.id FROM tokens k JOIN users u ON u.id=k.user_id WHERE u.kind='service'`);
  const svcTok = issueToken(db, { userId: db.one(`SELECT id FROM users WHERE kind='service'`).id, by: owner.userId, kind: 'service', name: 's' });
  const r = await call('POST', '/api/login', { body: { token: svcTok.plaintext } });
  eq([r.status, /服务账户/.test(JSON.stringify(r.body))], [403, true], '服务账户的令牌不能登录看板');
  void svc;

  section('④ 只读令牌');
  const ro = issueToken(db, { userId: fe.userId, by: fe.userId, name: '大屏', scope: 'read' });
  eq((await call('GET', '/api/tasks', tok(ro.plaintext))).status, 200, '只读：GET 可以');
  const w1 = await call('POST', '/api/me/lang', { ...tok(ro.plaintext), body: { lang: 'en' } });
  eq([w1.status, w1.headers['x-si-deny']], [403, 'scope'], '只读：任何改动 403（分派器一处执行）');
  const roCookie = await login(ro.plaintext);
  eq((await call('POST', '/api/me/lang', { ...as(roCookie), body: { lang: 'en' } })).status, 403, '只读令牌登录的会话同样只读');

  section('⑤ 服务账户替人做事');
  const obo = await call('POST', '/api/me/lang', { headers: { 'x-superintern-token': svcTok.plaintext, 'x-si-on-behalf-of': fe.userId }, body: { lang: 'zh' } });
  eq(obo.status, 200, '服务账户带 on_behalf_of 头：照常执行');
  const before = db.one(`SELECT max(id) m FROM audit_log`).m;
  await call('POST', '/api/me/tokens', { headers: { 'x-superintern-token': svcTok.plaintext, 'x-si-on-behalf-of': fe.userId }, body: { name: '机器人自己的' } });
  const rows = db.all(`SELECT action, actor_id, on_behalf_of FROM audit_log WHERE id>?`, before);
  assert(rows.length > 0 && rows.every((x) => x.on_behalf_of === fe.userId), `这次请求写下的审计都记了 on_behalf_of（${rows.map((x) => x.action).join('、')}）`);
  const human = await call('POST', '/api/me/lang', { headers: { 'x-superintern-token': fe.plaintext, 'x-si-on-behalf-of': owner.userId }, body: { lang: 'zh' } });
  eq(human.status, 403, '人带这个头：403（只有服务账户能替人操作）');

  section('⑥ 我的令牌 / 全员令牌');
  const c3 = await login(fe.plaintext);
  const mine = (await call('GET', '/api/me/tokens', as(c3))).body;
  const cur = mine.tokens.find((t) => t.current);
  eq([cur?.kind, mine.tokens.find((t) => t.viaCurrent)?.id], ['session', fe.tokenId], '列出自己的：标出当前会话、以及它是用哪枚登录的');
  assert(mine.tokens.every((t) => !('token_hash' in t)), '不带哈希');
  const made = await call('POST', '/api/me/tokens', { ...as(c3), body: { name: '笔记本命令行', days: 30 } });
  assert(made.status === 200 && typeof made.body.plaintext === 'string' && Math.round((made.body.expiresAt - now()) / D) === 30, '新签：给明文一次、30 天');
  eq((await call('POST', '/api/me/tokens', { ...as(c3), body: { name: '' } })).status, 400, '不起名字不签（以后认不出该吊销哪一枚）');
  const others = await call('POST', '/api/me/tokens/revoke-others', { ...as(c3), body: {} });
  assert(others.body.revoked >= 2, `吊销其它全部：${others.body.revoked} 枚`);
  eq((await call('GET', '/api/me', as(c3))).status, 200, '当前会话留着');
  eq(!!authenticate(db, fe.plaintext, { touch: false }), true, '当前会话的来源令牌也留着（不然当前会话跟着死）');
  eq(authenticate(db, made.body.plaintext, { touch: false }), null, '刚签的那枚没了');
  eq((await call('GET', '/api/admin/tokens', as(c3))).status, 403, '成员碰管理员接口：403');
  const ownerCookie = await login(owner.plaintext);
  const all = (await call('GET', '/api/admin/tokens', as(ownerCookie))).body.tokens;
  assert(all.some((t) => t.user_id === fe.userId) && all.some((t) => t.user_id === owner.userId), '管理员看得到全员还有效的令牌与会话');
  const feOther = issueToken(db, { userId: fe.userId, by: fe.userId, name: '要被管理员吊销的' });
  eq((await call('POST', '/api/me/tokens/revoke', { ...as(ownerCookie), body: { id: feOther.tokenId } })).status, 403, '"我的令牌"接口吊销不了别人的（管理员也一样，要走管理员接口）');
  eq((await call('POST', '/api/admin/tokens/revoke', { ...as(ownerCookie), body: { id: feOther.tokenId } })).body.revoked, 1, '管理员接口能吊销任何人的');

  section('⑦ 邀请');
  const inv = await call('POST', '/api/invites', { ...as(ownerCookie), body: { role: 'observer', name: '新同事' } });
  assert(inv.status === 200 && inv.body.link.startsWith(`https://${PUB}/?invite=`), `链接用对外地址（${String(inv.body.link).slice(0, 40)}…）`);
  const code = decodeURIComponent(inv.body.link.split('invite=')[1]);
  eq((await call('GET', `/api/invites/peek?code=${encodeURIComponent(code)}`)).body.role, 'observer', '没登录也能看邀请：以什么角色加入');
  const acc = await call('POST', '/api/invites/accept', { body: { code, name: '新同事' } });
  assert(acc.status === 200 && typeof acc.body.cliToken === 'string' && cookieOf(acc).startsWith('si_token='), '接受：建成员 + 会话 cookie + 一次性命令行令牌');
  eq(db.one(`SELECT role FROM users WHERE display_name='新同事'`).role, 'observer', '角色按邀请');
  eq((await call('GET', '/api/me', as(cookieOf(acc)))).status, 200, '接受完直接是登录状态');
  eq((await call('POST', '/api/invites/accept', { body: { code, name: '又一个' } })).status, 410, '用过的再用：410');
  const inv2 = createInvite(db, { byUserId: owner.userId, role: 'member' });
  revokeInviteBy(db, { inviteId: inv2.inviteId, byUserId: owner.userId });
  eq((await call('POST', '/api/invites/accept', { body: { code: inv2.code, name: 'x1' } })).status, 410, '撤销的：410');
  const inv3 = createInvite(db, { byUserId: owner.userId, role: 'member', hours: 1, at: now() - 2 * 3600_000 });
  eq((await call('POST', '/api/invites/accept', { body: { code: inv3.code, name: 'x2' } })).status, 410, '过期的：410');
  eq((await call('POST', '/api/invites', { ...as(c3), body: {} })).status, 403, '成员不能发邀请');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action IN ('invite_created','invite_accepted','invite_revoked')`).n, 5, '发 / 接受 / 撤销都进审计');
} finally {
  w.close();
}

section('⑦b 本机模式不收邀请');
{
  const w2 = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100 });
  port = w2.port;
  const i = createInvite(db, { byUserId: owner.userId, role: 'member' });
  const r = await new Promise((resolve) => {
    const data = JSON.stringify({ code: i.code, name: 'y' });
    const q = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/invites/accept', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    q.write(data); q.end();
  });
  eq(r, 404, '本机模式：404（加人在「设置 → 成员」里加）');
  w2.close();
}

section('⑧ 升级前签发的令牌');
{
  const p = join(TMP, 'old', 'state.db');
  const old = openDb(p, { migrateTo: 31 });
  old.run(`INSERT INTO users (id, display_name, role, created_at) VALUES ('u_o', 'o', 'lead', 1)`);
  old.run(`INSERT INTO tokens (id, user_id, token_hash, issued_by, issued_at) VALUES ('tk_o', 'u_o', 'h', 'u_o', 1)`);
  old.close();
  const d = openDb(p);
  eq(d.one(`SELECT kind, scope, expires_at, name FROM tokens WHERE id='tk_o'`), { kind: 'cli', scope: 'write', expires_at: null, name: '（升级前签发）' }, 'kind=cli、读写、不过期（升级不把正在用的部署锁在门外）、名字标出来');
  d.close();
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
