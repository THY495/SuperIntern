// 用 GitHub 登录 + 必须是组织成员：
//   ① 配置：组织 / App / Client ID / Client secret 缺哪样说清楚；secret 加密进库、只有管理员能填、只认部署级 App；
//   ② 去 GitHub：授权地址带 client_id / 回调 / state / PKCE；state 要与 cookie 一致、只能用一次、10 分钟过期；
//   ③ 回来：换令牌 → 你是谁 → 当场作废用户令牌（不落库）；组织正式成员才放行（pending 不算）；查不通不当成"不是成员"；
//      认人：按数字 id → 按资料里填的账号绑定 → 按设置自动建或拒；GitHub 上改名跟着改；停用的拒；每次拒绝都有审计；
//   ④ 每小时复查：离开组织 → 吊销经 GitHub 开的会话（命令行令牌不动）；查不通不吊销；
//   ⑤ 管理员改了某人的 GitHub 账号 → 解绑（原账号不能再以他的身份登录）；
//   ⑤' 防冒领：成员自己填的账号不按名字绑定；本人登录后「用 GitHub 验证并绑定」（关联账号）；别人绑过的拒、别人自己占着没验证的让给正主；
//   ⑥ 看板：/api/auth/github 302 + state cookie；回调成功种会话 cookie 回首页；失败回首页带原因；本机模式 404。
//
// 跑：node tests/github-login.test.mjs

import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, ensureOwner, now, authenticate } from '../src/db/db.mjs';
import { addUser, setGitIdentity } from '../src/core/users.mjs';
import { disableUser } from '../src/core/handover.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { addCredential, setAppOAuth, appOAuthSecret, loginAppRow, clearAppCache } from '../src/core/credentials.mjs';
import { githubLoginConfig, beginLogin, takeState, finishLogin, recheckMembers, isOrgMember, clearOrgCache, loginErrorText, LOGIN_ERRORS } from '../src/core/github-login.mjs';
import { issueToken, createSession } from '../src/core/sessions.mjs';
import { startWeb } from '../src/web/server.mjs';
import { verifiedGit } from '../src/core/git-identity.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throwsLike = (fn, re, m) => { try { fn(); bad(m, '没有抛错'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, e.message); } };
const rejectsCode = async (p, code, m) => { try { await p; bad(m, '没有抛错'); } catch (e) { e.code === code ? ok(m) : bad(m, `${e.code ?? ''} ${e.message}`); } };
const section = (s) => console.log(`\n── ${s}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-ghlogin-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const { privateKey: appPem } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const CLIENT_SECRET = ['cs', 'ecret', '0123456789abcdef0123456789abcdef'].join('_');
const USER_TOKEN = ['ghu', 'U5ERt0kenU5ERt0kenU5ERt0kenU5ERt0ken'].join('_');
const REDIRECT = 'https://si.example.com/api/auth/github/callback';

// ── 假 GitHub：账号表、组织成员表；记下每个请求 ──
function fakeGithub() {
  const g = { accounts: { 'code-alice': { id: 101, login: 'alice-gh' }, 'code-bob': { id: 202, login: 'bob-gh' }, 'code-carol': { id: 303, login: 'carol-gh' }, 'code-dave': { id: 404, login: 'dave-gh' } },
    members: { 'alice-gh': 'active', 'bob-gh': 'pending', 'carol-gh': 'active', 'dave-gh': 'active', 'alice-renamed': 'active' }, calls: [], down: false, installed: true, lastCode: null };
  g.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const body = opts.body ? JSON.parse(opts.body) : null;
    g.calls.push({ method: opts.method ?? 'GET', path: u.pathname, body, auth: opts.headers?.authorization ?? null });
    const res = (status, j) => ({ status, ok: status >= 200 && status < 300, json: async () => j });
    if (g.down) throw new Error('getaddrinfo ENOTFOUND api.github.com');
    if (u.pathname === '/login/oauth/access_token') {
      if (body.client_secret !== CLIENT_SECRET || !g.accounts[body.code]) return res(200, { error: 'bad_verification_code' });
      g.lastCode = body.code;
      return res(200, { access_token: USER_TOKEN, token_type: 'bearer' });
    }
    if (u.pathname === '/user') return opts.headers.authorization === `Bearer ${USER_TOKEN}` ? res(200, g.accounts[g.lastCode]) : res(401, {});
    if (/^\/applications\/.+\/token$/.test(u.pathname)) return res(204, null);
    if (/^\/orgs\/[^/]+\/installation$/.test(u.pathname)) return g.installed ? res(200, { id: 77 }) : res(404, {});
    if (u.pathname === '/app/installations/77/access_tokens') return res(201, { token: 'ghs_inst', expires_at: new Date(Date.now() + 3600_000).toISOString(), _perms: body.permissions });
    const m = /^\/orgs\/([^/]+)\/memberships\/([^/]+)$/.exec(u.pathname);
    if (m) { const st = g.members[decodeURIComponent(m[2])]; return st ? res(200, { state: st }) : res(404, {}); }
    return res(404, {});
  };
  return g;
}

const db = openDb(join(TMP, 'state.db'));
const lead = ensureOwner(db);
const alice = addUser(db, { name: 'alice', role: 'member', byUserId: lead.userId });

section('① 配置');
eq(githubLoginConfig(db).missing, ['org', 'app'], '什么都没设：缺组织、缺 App');
throwsLike(() => setSetting(db, { key: 'deploy.github_login_org', value: 'bad org!', userId: lead.userId }), /值无效/, '组织名格式不对：拒');
eq(setSetting(db, { key: 'deploy.github_login_org', value: ' https://github.com/THY-test-org/ ', userId: lead.userId }).value, 'THY-test-org', '贴组织主页地址也认，存组织名');
const app = addCredential(db, { kind: 'github_app', name: 'acme App', appId: '5280813', secret: appPem, pathGlob: 'THY-test-org/*', byUserId: lead.userId });
eq(githubLoginConfig(db).missing, ['client_id', 'client_secret'], '有 App 没填 OAuth：缺 Client ID 与 secret');
throwsLike(() => setAppOAuth(db, { id: app.id, clientId: 'Iv23liABCDEFGH', clientSecret: CLIENT_SECRET, byUserId: alice.userId }), /只有管理员/, '成员不能设');
throwsLike(() => setAppOAuth(db, { id: app.id, clientId: 'x', clientSecret: CLIENT_SECRET, byUserId: lead.userId }), /Client ID 不对/, 'Client ID 形状不对：拒');
throwsLike(() => setAppOAuth(db, { id: app.id, clientId: 'Iv23liABCDEFGH', byUserId: lead.userId }), /还要填 Client secret/, '第一次只填 Client ID：要 secret');
const mine = addCredential(db, { kind: 'github_app', name: 'my App', appId: '9', secret: appPem, ownerId: alice.userId, byUserId: alice.userId });
throwsLike(() => setAppOAuth(db, { id: mine.id, clientId: 'Iv23liABCDEFGH', clientSecret: CLIENT_SECRET, byUserId: lead.userId }), /部署级的 GitHub App/, '成员自己的 App 不能拿来做登录');
setAppOAuth(db, { id: app.id, clientId: 'Iv23liABCDEFGH', clientSecret: CLIENT_SECRET, byUserId: lead.userId });
const cfg = githubLoginConfig(db);
eq([cfg.enabled, cfg.app.clientId, cfg.app.hasSecret], [true, 'Iv23liABCDEFGH', true], '填齐：开启');
const row = loginAppRow(db);
assert(!row.meta.includes(CLIENT_SECRET) && appOAuthSecret(db, row, 'oauth') === CLIENT_SECRET, 'Client secret 加密进库，解得回来');
assert(appOAuthSecret(db, row, 'pem').includes('PRIVATE KEY'), '私钥与 secret 各解各的（附加数据不同）');
setAppOAuth(db, { id: app.id, clientId: 'Iv23liZZZZZZZZ', byUserId: lead.userId });
assert(githubLoginConfig(db).app.clientId === 'Iv23liZZZZZZZZ' && appOAuthSecret(db, loginAppRow(db), 'oauth') === CLIENT_SECRET, '只改 Client ID：secret 留着');
const app2 = addCredential(db, { kind: 'github_app', name: 'another App', appId: '777', secret: appPem, byUserId: lead.userId });
eq(loginAppRow(db).id, app.id, '新加一份 App、没填 OAuth：登录仍用填过的那份');
setAppOAuth(db, { id: app2.id, clientId: 'Iv23liOTHER000', clientSecret: CLIENT_SECRET, byUserId: lead.userId });
eq(loginAppRow(db).id, app2.id, '在另一份上填了 OAuth：登录改用它');
setAppOAuth(db, { id: app.id, clientId: 'Iv23liABCDEFGH', byUserId: lead.userId, at: now() + 1000 });
eq(loginAppRow(db).id, app.id, '回到原来那份上再保存一次：切回来');

section('② 去 GitHub：state 与 PKCE');
const b = beginLogin(db, { redirectUri: REDIRECT });
const au = new URL(b.url);
eq([au.origin + au.pathname, au.searchParams.get('client_id'), au.searchParams.get('redirect_uri'), au.searchParams.get('state'), au.searchParams.get('code_challenge_method')],
  ['https://github.com/login/oauth/authorize', 'Iv23liABCDEFGH', REDIRECT, b.state, 'S256'], '授权地址：client_id、回调、state、PKCE');
throwsLike(() => takeState(b.state, 'other'), /state/, 'cookie 里的 state 对不上：拒（登录 CSRF）');
throwsLike(() => takeState(b.state, b.state), /state/, '对不上那一次已经把它作废：再用也不行');
const b2 = beginLogin(db, { redirectUri: REDIRECT });
const { verifier } = takeState(b2.state, b2.state);
eq(createHash('sha256').update(verifier).digest('base64url'), new URL(b2.url).searchParams.get('code_challenge'), 'verifier 与 code_challenge 对得上');
const b3 = beginLogin(db, { redirectUri: REDIRECT, at: now() - 11 * 60_000 });
throwsLike(() => takeState(b3.state, b3.state), /state/, '10 分钟过期');

section('③ 回来：认人、查组织');
const gh = fakeGithub();
const login = (code, extra = {}) => finishLogin(db, { code, verifier: 'v', redirectUri: REDIRECT, fetchFn: gh.fetch, ...extra });
await rejectsCode(login('code-alice'), 'no_user', '账号对不上任何成员、没开自动建：拒');
setGitIdentity(db, { userId: alice.userId, github: 'Alice-GH', byUserId: alice.userId });
await rejectsCode(login('code-alice'), 'unverified', '资料里的账号是本人自己填的：不按名字绑定（防冒领），要本人验证');
eq(db.one(`SELECT github_id FROM users WHERE id=?`, alice.userId).github_id, null, '没绑上');
setGitIdentity(db, { userId: alice.userId, github: 'Alice-GH', byUserId: lead.userId });
let r = await login('code-alice');
const arow = db.one(`SELECT github_id, github_login FROM users WHERE id=?`, alice.userId);
eq([r.userId, r.created, arow.github_id], [alice.userId, false, 101], '管理员填的账号（不分大小写）对上 alice，记下数字 id');
assert(authenticate(db, r.session.plaintext)?.user_id === alice.userId, '开出的会话能用');
const tk = db.one(`SELECT kind, parent_id, name FROM tokens WHERE id=?`, r.session.tokenId);
eq([tk.kind, tk.parent_id], ['session', null], '会话没有来源令牌');
const tokCall = gh.calls.find((c) => c.path === '/login/oauth/access_token');
eq([tokCall.body.client_id, tokCall.body.redirect_uri, tokCall.body.code_verifier], ['Iv23liABCDEFGH', REDIRECT, 'v'], '换令牌带 client_id、回调、PKCE verifier');
await new Promise((res) => setTimeout(res, 10));
assert(gh.calls.some((c) => c.method === 'DELETE' && /\/applications\/Iv23liABCDEFGH\/token$/.test(c.path) && c.body.access_token === USER_TOKEN), '问完"你是谁"当场作废用户令牌');
const instTok = gh.calls.find((c) => c.path === '/app/installations/77/access_tokens');
eq(instTok.body.permissions, { members: 'read' }, '查组织用安装令牌，只要 members:read');
assert(!readFileSync(join(TMP, 'state.db')).includes(Buffer.from(USER_TOKEN)) && !readFileSync(join(TMP, 'state.db')).includes(Buffer.from(CLIENT_SECRET)), '库文件里没有用户令牌、没有 Client secret 明文');
assert(db.one(`SELECT 1 FROM audit_log WHERE action='github_login_bound' AND target_id=?`, alice.userId) && db.one(`SELECT 1 FROM audit_log WHERE action='user_login' AND payload LIKE '%"via":"github"%'`), '审计：绑定、登录（via github）');

// GitHub 上改了名：按 id 认人，跟着改
gh.accounts['code-alice'] = { id: 101, login: 'alice-renamed' };
r = await login('code-alice');
eq([r.userId, db.one(`SELECT github_login FROM users WHERE id=?`, alice.userId).github_login], [alice.userId, 'alice-renamed'], 'GitHub 上改了名：按数字 id 还是 alice，资料里的账号跟着改');
// 冒名：有人注册了 alice 原来的账号名 —— id 不同，不会被认成 alice
gh.accounts['code-dave'] = { id: 404, login: 'Alice-GH' }; gh.members['Alice-GH'] = 'active';
await rejectsCode(login('code-dave'), 'no_user', '别人拿到 alice 的旧账号名：id 不同、alice 已绑过，不认');

await rejectsCode(login('code-bob'), 'not_member', '受邀还没接受（pending）：不算成员');
gh.members['zed'] = undefined; gh.accounts['code-zed'] = { id: 909, login: 'zed' };
await rejectsCode(login('code-zed'), 'not_member', '不在组织里：拒');
assert(db.one(`SELECT 1 FROM audit_log WHERE action='github_login_refused' AND payload LIKE '%not_member%'`), '拒绝有审计（原因、账号）');
await rejectsCode(login('code-nope'), 'github', 'code 无效：GitHub 那边没完成');
await rejectsCode(login('bad code!'), 'github', 'code 形状不对：不发请求直接拒');

clearOrgCache(); gh.installed = false;
await rejectsCode(login('code-carol'), 'membership_check', 'App 没装在组织上：说"查不了"，不说"不是成员"');
gh.installed = true; clearOrgCache();

setSetting(db, { key: 'deploy.github_login_autocreate', value: 'observer', userId: lead.userId });
r = await login('code-carol');
const carol = db.one(`SELECT display_name, role, github_login, github_id FROM users WHERE id=?`, r.userId);
eq([r.created, carol.display_name, carol.role, carol.github_login, carol.github_id], [true, 'carol-gh', 'observer', 'carol-gh', 303], '自动建为旁观者：名字用 GitHub 账号，绑好 id');
assert(!db.one(`SELECT 1 FROM tokens WHERE user_id=? AND kind='cli'`, r.userId), '自动建的账号不发命令行令牌');
setSetting(db, { key: 'deploy.github_login_autocreate', value: 'off', userId: lead.userId });

const bob = addUser(db, { name: 'bob', role: 'member', byUserId: lead.userId });
setGitIdentity(db, { userId: bob.userId, github: 'bob-gh', byUserId: lead.userId });
gh.members['bob-gh'] = 'active';
disableUser(db, { userId: bob.userId, byUserId: lead.userId });
await rejectsCode(login('code-bob'), 'disabled', '停用的成员：拒');

section('④ 每小时复查');
const aliceCli = issueToken(db, { userId: alice.userId, by: lead.userId });
const s1 = (await login('code-alice')).session;
gh.down = true;
let rc = await recheckMembers(db, { fetchFn: gh.fetch });
assert(rc.errors.length > 0 && rc.revoked.length === 0 && authenticate(db, s1.plaintext), 'GitHub 不通：不吊销，记下没查通');
gh.down = false;
rc = await recheckMembers(db, { fetchFn: gh.fetch });
eq(rc.revoked, [], '还是成员：不动');
delete gh.members['alice-renamed'];
rc = await recheckMembers(db, { fetchFn: gh.fetch });
assert(rc.revoked.includes(alice.userId) && !authenticate(db, s1.plaintext) && !db.one(`SELECT 1 FROM tokens WHERE user_id=? AND kind='session' AND revoked_at IS NULL`, alice.userId), '离开组织：经 GitHub 开的会话全部吊销');
assert(authenticate(db, aliceCli.plaintext)?.user_id === alice.userId, '管理员另发的命令行令牌不动');
assert(db.one(`SELECT 1 FROM audit_log WHERE action='github_membership_lost' AND target_id=?`, alice.userId), '审计：github_membership_lost');

section('⑤ 管理员改 GitHub 账号 → 解绑');
setGitIdentity(db, { userId: alice.userId, github: 'someone-else', byUserId: lead.userId });
eq(db.one(`SELECT github_id FROM users WHERE id=?`, alice.userId).github_id, null, '换了账号：解绑数字 id');
gh.members['alice-renamed'] = 'active';
await rejectsCode(login('code-alice'), 'no_user', '原来那个 GitHub 账号不能再以 alice 登录');
setGitIdentity(db, { userId: alice.userId, email: '1+a@users.noreply.github.com', byUserId: alice.userId });
eq(db.one(`SELECT github_login FROM users WHERE id=?`, alice.userId).github_login, 'someone-else', '只改提交邮箱：账号与绑定不动');

section("⑤' 关联账号与防冒领");
{
  const eve = addUser(db, { name: 'eve', role: 'member', byUserId: lead.userId });
  const fay = addUser(db, { name: 'fay', role: 'member', byUserId: lead.userId });
  gh.accounts['code-fay'] = { id: 606, login: 'fay-gh' }; gh.members['fay-gh'] = 'active';
  // eve 把 fay 的账号填在自己名下（自己填的）
  setGitIdentity(db, { userId: eve.userId, github: 'fay-gh', byUserId: eve.userId });
  await rejectsCode(login('code-fay'), 'unverified', 'fay 用 GitHub 登录：不会进 eve 的账号');
  // fay 用令牌登录后点「用 GitHub 验证并绑定」
  const bl = beginLogin(db, { redirectUri: REDIRECT, linkUserId: fay.userId });
  const st = takeState(bl.state, bl.state);
  eq(st.linkUserId, fay.userId, 'state 记着是谁发起的绑定');
  const lr = await finishLogin(db, { code: 'code-fay', verifier: st.verifier, linkUserId: fay.userId, redirectUri: REDIRECT, fetchFn: gh.fetch });
  eq([lr.linked, lr.userId, lr.login], [true, fay.userId, 'fay-gh'], '绑到发起的人（fay）身上');
  eq([db.one(`SELECT github_id, github_login FROM users WHERE id=?`, fay.userId).github_id, db.one(`SELECT github_login FROM users WHERE id=?`, eve.userId).github_login], [606, null], 'eve 自己占着、没验证的那份让给正主、清掉');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='github_login_claim_cleared' AND target_id=?`, eve.userId), '审计：github_login_claim_cleared');
  r = await login('code-fay');
  eq(r.userId, fay.userId, '之后 fay 用 GitHub 登录进的是自己');
  // eve 也想绑 fay 的 GitHub：已经绑在 fay 名下 → 拒
  await rejectsCode(finishLogin(db, { code: 'code-fay', verifier: 'v', linkUserId: eve.userId, redirectUri: REDIRECT, fetchFn: gh.fetch }), 'taken', '别人已绑定的 GitHub 账号：不能再绑');
  // 管理员替 gus 填的账号，别人来认领 → 拒
  const gus = addUser(db, { name: 'gus', role: 'member', byUserId: lead.userId });
  setGitIdentity(db, { userId: gus.userId, github: 'gus-gh', byUserId: lead.userId });
  gh.accounts['code-gus'] = { id: 707, login: 'gus-gh' }; gh.members['gus-gh'] = 'active';
  await rejectsCode(finishLogin(db, { code: 'code-gus', verifier: 'v', linkUserId: eve.userId, redirectUri: REDIRECT, fetchFn: gh.fetch }), 'taken', '管理员替别人填的账号：不能被认领');
  const t1 = loginErrorText('zh', 'not_member', { login: 'zed', org: 'THY-test-org' });
  assert(t1.includes('@zed') && t1.includes('github.com/orgs/THY-test-org/invitation') && t1.includes('先到 github.com 退出'), '出错提示带 GitHub 账号、接受邀请的地址、换账号的办法', t1);
  assert(!loginErrorText('zh', 'not_member', { login: '<b>x', org: 'o' }).includes('<b>'), '账号形状不对：不回显');
}

section('⑤″ 拿来当身份用的只认验证过的（提交 trailer、Co-authored-by）');
{
  const ivy = addUser(db, { name: 'ivy', role: 'member', byUserId: lead.userId });
  setGitIdentity(db, { userId: ivy.userId, github: 'alice-renamed-x', email: '101+alice-renamed@users.noreply.github.com', byUserId: ivy.userId });
  eq(verifiedGit(db, ivy.userId), { github: null, email: null, bound: false }, '自己填的账号与邮箱（可能是别人的）：都不当身份用');
  setGitIdentity(db, { userId: ivy.userId, github: 'ivy-gh', email: 'ivy@example.com', byUserId: lead.userId });
  eq(verifiedGit(db, ivy.userId), { github: 'ivy-gh', email: 'ivy@example.com', bound: false }, '管理员替她填的：算数');
  setGitIdentity(db, { userId: ivy.userId, email: 'other@example.com', byUserId: ivy.userId });
  eq(verifiedGit(db, ivy.userId).email, null, '她自己再改邮箱：又不算了（账号还算）');
  const bd = db.one(`SELECT id, github_id, github_login FROM users WHERE github_id IS NOT NULL ORDER BY rowid LIMIT 1`);
  eq(verifiedGit(db, bd.id), { github: bd.github_login, email: `${bd.github_id}+${bd.github_login}@users.noreply.github.com`, bound: true }, '已绑定的：账号算数，邮箱用 GitHub 按数字 id 生成的 noreply 地址（伪造不了）');
}

section('⑥ 看板');
eq(LOGIN_ERRORS.every((c) => !!loginErrorText('zh', c)), true, '每种原因都有人话');
{
  clearOrgCache(); clearAppCache();
  gh.calls.length = 0;
  setGitIdentity(db, { userId: alice.userId, github: 'alice-renamed', byUserId: lead.userId });
  const w = await startWeb(db, { home: TMP, port: 0, team: true, publicUrl: 'https://si.example.com', fetchFn: gh.fetch, runtime: null });
  const base = `http://127.0.0.1:${w.port}`;
  let res = await fetch(`${base}/api/auth/github`, { redirect: 'manual', headers: { host: 'si.example.com' } });
  const loc = new URL(res.headers.get('location'));
  const setc = res.headers.get('set-cookie') ?? '';
  const st = /si_gh_state=([^;]+)/.exec(setc)?.[1];
  assert(res.status === 302 && loc.host === 'github.com' && loc.searchParams.get('redirect_uri') === REDIRECT && st === loc.searchParams.get('state') && /SameSite=Lax/.test(setc) && /HttpOnly/.test(setc) && /Secure/.test(setc),
    '302 到 GitHub；state 另放进 HttpOnly、Lax、Secure 的 cookie', `${res.status} ${setc}`);
  res = await fetch(`${base}/api/auth/github/callback?code=code-alice&state=${st}`, { redirect: 'manual', headers: { host: 'si.example.com', cookie: 'si_gh_state=forged' } });
  eq([res.status, res.headers.get('location')], [302, '/?login_error=state'], 'cookie 对不上：回首页，带原因');
  res = await fetch(`${base}/api/auth/github`, { redirect: 'manual', headers: { host: 'si.example.com' } });
  const st2 = /si_gh_state=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
  res = await fetch(`${base}/api/auth/github/callback?code=code-alice&state=${st2}`, { redirect: 'manual', headers: { host: 'si.example.com', cookie: `si_gh_state=${st2}` } });
  const sess = /si_token=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  eq([res.status, res.headers.get('location'), !!sess], [302, '/', true], '成功：种会话 cookie、回首页');
  const me = await fetch(`${base}/api/session`, { headers: { host: 'si.example.com', cookie: `si_token=${sess}` } }).then((x) => x.json());
  eq(me.loggedIn, true, '带着会话 cookie 已登录');
  const anon = await fetch(`${base}/api/session?login_error=not_member`, { headers: { host: 'si.example.com' } }).then((x) => x.json());
  assert(anon.github?.enabled === true && /不是 GitHub 组织 THY-test-org 的正式成员/.test(anon.github.error ?? ''), '没登录：告诉页面能用 GitHub 登录，原因翻成人话', JSON.stringify(anon));
  const weird = await fetch(`${base}/api/session?login_error=<script>`, { headers: { host: 'si.example.com' } }).then((x) => x.json());
  eq(weird.github?.error, null, '不认识的原因：不显示（不把 URL 里的字回显到页面）');
  res = await fetch(`${base}/api/auth/github/callback?error=access_denied&state=x`, { redirect: 'manual', headers: { host: 'si.example.com' } });
  eq(res.headers.get('location'), '/?login_error=github', '在 GitHub 上点了取消');
  // 已登录的人（hal，自己填过账号）点「用 GitHub 验证并绑定」
  const hal = addUser(db, { name: 'hal', role: 'member', byUserId: lead.userId });
  gh.accounts['code-hal'] = { id: 808, login: 'hal-gh' }; gh.members['hal-gh'] = 'active';
  const hc = createSession(db, { login: authenticate(db, hal.plaintext) }).plaintext;
  res = await fetch(`${base}/api/auth/github`, { redirect: 'manual', headers: { host: 'si.example.com', cookie: `si_token=${hc}` } });
  const st3 = /si_gh_state=([^;]+)/.exec(res.headers.get('set-cookie'))[1];
  res = await fetch(`${base}/api/auth/github/callback?code=code-hal&state=${st3}`, { redirect: 'manual', headers: { host: 'si.example.com', cookie: `si_gh_state=${st3}; si_token=${hc}` } });
  eq([res.status, res.headers.get('location'), /si_token=/.test(res.headers.get('set-cookie') ?? '')], [302, '/?github_linked=1&gh=hal-gh', false], '已登录时走一遍 = 绑定：回首页报结果，不换会话');
  eq(db.one(`SELECT github_id FROM users WHERE id=?`, hal.userId).github_id, 808, 'hal 绑上了');
  const linked = await fetch(`${base}/api/session?github_linked=1&gh=hal-gh`, { headers: { host: 'si.example.com', cookie: `si_token=${hc}` } }).then((x) => x.json());
  eq(linked.github?.linked, 'hal-gh', '页面拿得到“已绑定 @hal-gh”');
  res = await fetch(`${base}/api/auth/github/callback?code=code-zed&state=bad`, { redirect: 'manual', headers: { host: 'si.example.com', cookie: 'si_gh_state=bad' } });
  eq(res.headers.get('location'), '/?login_error=state', 'state 不对：不带账号（还没问 GitHub）');
  w.close();
  const wl = await startWeb(db, { home: TMP, port: 0, fetchFn: gh.fetch, runtime: null, tokenPlain: lead.plaintext });
  eq((await fetch(`http://127.0.0.1:${wl.port}/api/auth/github`, { redirect: 'manual' })).status, 404, '本机模式：404');
  wl.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 200);
