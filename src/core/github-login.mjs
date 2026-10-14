// 用 GitHub 登录 + 必须是组织成员（不做通用 OIDC，复用 连接的 GitHub App）。
//
// 流程（团队模式下才有）：
//   1. 看板 /api/auth/github → 302 到 GitHub 授权页（App 的 Client ID、回调地址、state、PKCE）。state 同时放进一个 Lax cookie，
//      回调时两边对上才算 —— 别人诱导你点一个他拿到的回调链接（登录 CSRF）对不上。
//   2. GitHub 带 code 回调 /api/auth/github/callback → 用 Client secret + code（+ PKCE verifier）换一个用户令牌 →
//      GET /user 拿到数字 id 与账号名 → **当场作废这个用户令牌**（只用来问"你是谁"，不落库、不留在进程里）。
//   3. 组织成员资格用 App 装在组织上的安装令牌查（只要 Members 读权限；不靠用户授权范围，私密成员也查得到）：
//      GET /orgs/{org}/memberships/{login}，state = active 才算（pending = 邀请还没接受）。
//   4. 认人：先按 users.github_id；没有就按成员资料里**管理员填的** GitHub 账号（还没绑过 id 的）对上并记下 id；
//      都没有时按 deploy.github_login_autocreate 决定拒绝（默认）还是自动建成员 / 旁观者。停用的、服务账户一律拒。
//      成员**自己填的**账号不拿来按名字绑定（否则：甲把还没人认领的 bob-gh 填在自己名下，bob 用 GitHub 登录就进了甲的账号）——
//      自己填的要本人先用令牌登录，再在「成员」里点「用 GitHub 验证并绑定」走一遍授权（关联账号：已登录时发起，回来按数字 id 绑到当前这个人）。
//   5. 开一个没有来源令牌的浏览器会话（core/sessions.mjs createGithubSession）。
// 离开组织：看板进程每小时复查用 GitHub 登录、会话还活着的人，查实不再是成员就吊销这些会话（查不通不动，只记日志）。
//
// 凭据：Client ID 不是秘密，记在 GitHub App 连接的 meta 里；Client secret 与私钥一样用主密钥加密（core/credentials.mjs setAppOAuth）。
// 不落盘、不进日志的：用户令牌、code、PKCE verifier；state 只在进程内存里放 10 分钟。

import { randomBytes, createHash } from 'node:crypto';
import { audit, newId, now } from '../db/db.mjs';
import { insertUser, updateUser, revokeToken } from '../db/users.mjs';
import { getSetting } from './settings.mjs';
import { tl, contentLang } from '../i18n/index.mjs';
import { HTTP_TIMEOUT_MS } from './http.mjs';
import { appJwt, loginAppRow, appOAuthSecret } from './credentials.mjs';
import { createGithubSession, GITHUB_SESSION_NAME } from './sessions.mjs';
import { githubLoginAdminSet } from './git-identity.mjs';

export const CALLBACK_PATH = '/api/auth/github/callback';
const STATE_TTL_MS = 10 * 60_000;
const ghHeaders = (auth) => ({ authorization: auth, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'superintern' });
const webBase = (row) => (row.host === 'github.com' ? 'https://github.com' : `https://${row.host}`);
const apiBase = (row) => JSON.parse(row.meta).apiBase;

/** 登录失败的几种原因：页面按 code 显示人话（code 进 URL，不带任何别的信息）。 */
export class LoginError extends Error { constructor(code, detail = '', login = null) { super(detail || code); this.code = code; this.login = login; } }
export const LOGIN_ERRORS = ['not_configured', 'state', 'github', 'not_member', 'no_user', 'unverified', 'taken', 'disabled', 'membership_check'];
export const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** 当前配置：组织、用哪份 App 连接、还缺什么。enabled = 组织填了、App 有 Client ID 与 secret。 */
export function githubLoginConfig(db) {
  const org = String(getSetting(db, 'deploy.github_login_org') ?? '').trim();
  const row = loginAppRow(db);
  const meta = row ? JSON.parse(row.meta) : {};
  const missing = [];
  if (!org) missing.push('org');
  if (!row) missing.push('app');
  else { if (!meta.clientId) missing.push('client_id'); if (!meta.oauth) missing.push('client_secret'); }
  // 还登不进来的人：在岗的人类成员里，既没绑过、也没有管理员填的 GitHub 账号的（自动建关着时，他们用 GitHub 登录会被拒）
  const unlinkedRows = db.all(`SELECT id, display_name, github_login FROM users WHERE kind='human' AND disabled_at IS NULL AND github_id IS NULL ORDER BY created_at`).filter((u) => !(u.github_login && githubLoginAdminSet(db, u.id, u.github_login)));
  const unlinked = unlinkedRows.length, unlinkedNames = unlinkedRows.slice(0, 8).map((u) => u.display_name);
  return { enabled: missing.length === 0, org, missing, app: row ? { id: row.id, name: row.name, appId: meta.appId, clientId: meta.clientId ?? null, hasSecret: !!meta.oauth, host: row.host } : null,
    autocreate: getSetting(db, 'deploy.github_login_autocreate'), unlinked, unlinkedNames };
}


// ── 第 1 步：去 GitHub ────────────────────────────────────────────────────
const STATES = new Map();   // state → { verifier, at, linkUserId }（只在进程内存；看板重启了重新点一次登录就行）

/** 生成授权地址。返回 { url, state }（state 由调用方另放进 cookie）。linkUserId：已登录的人发起 = 把 GitHub 账号绑到自己身上。 */
export function beginLogin(db, { redirectUri, linkUserId = null, at = now() }) {
  const cfg = githubLoginConfig(db);
  if (!cfg.enabled) throw new LoginError('not_configured');
  for (const [k, v] of STATES) if (at - v.at > STATE_TTL_MS) STATES.delete(k);
  if (STATES.size > 1000) STATES.delete(STATES.keys().next().value);
  const state = randomBytes(18).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  STATES.set(state, { verifier, at, linkUserId });
  const row = loginAppRow(db);
  const u = new URL('/login/oauth/authorize', webBase(row));
  u.searchParams.set('client_id', cfg.app.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('allow_signup', 'false');
  return { url: u.toString(), state };
}

/** 回调里的 state：URL 上的与 cookie 里的一致、是本进程发出去的、没过期；用一次就作废。返回 { verifier, linkUserId }。 */
export function takeState(state, cookieState, { at = now() } = {}) {
  const s = String(state ?? '');
  const v = s && s === String(cookieState ?? '') ? STATES.get(s) : null;
  if (s) STATES.delete(s);
  if (!v || at - v.at > STATE_TTL_MS) throw new LoginError('state');
  return { verifier: v.verifier, linkUserId: v.linkUserId ?? null };
}

// ── 第 2–5 步：回来以后 ──────────────────────────────────────────────────
/** code → 用户令牌 → 你是谁（随后作废令牌）。返回 { id, login }。 */
async function whoIsCode(row, { clientId, secret, code, verifier, redirectUri, fetchFn }) {
  let r;
  try {
    r = await fetchFn(new URL('/login/oauth/access_token', webBase(row)), { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'superintern' },
      body: JSON.stringify({ client_id: clientId, client_secret: secret, code, redirect_uri: redirectUri, code_verifier: verifier }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (e) { throw new LoginError('github', `token exchange: ${e.message}`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new LoginError('github', `token exchange: ${r.status} ${j.error ?? ''}`);
  const tok = j.access_token;
  try {
    const u = await fetchFn(`${apiBase(row)}/user`, { headers: ghHeaders(`Bearer ${tok}`), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const me = await u.json().catch(() => ({}));
    if (!u.ok || !Number.isInteger(me.id) || typeof me.login !== 'string') throw new LoginError('github', `user: ${u.status}`);
    return { id: me.id, login: me.login };
  } finally {
    // 作废：用户令牌只用来问这一句（尽力；作废失败它也只是一个 8 小时后过期、只有本 App 权限交集的令牌）
    const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');
    fetchFn(`${apiBase(row)}/applications/${encodeURIComponent(clientId)}/token`, { method: 'DELETE', headers: { ...ghHeaders(`Basic ${basic}`), 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: tok }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }).catch(() => {});
  }
}

// 组织上的安装令牌（只要 members:read），进程内缓存到过期前 5 分钟
const ORG_CACHE = new Map();
export const clearOrgCache = () => ORG_CACHE.clear();

/** login 是不是 org 的正式成员（active）。查不通抛 LoginError('membership_check')，不当成"不是成员"。 */
export async function isOrgMember(db, opts) {
  try { return await orgMember(db, opts); }
  catch (e) { if (e instanceof LoginError) throw e; throw new LoginError('membership_check', tl(contentLang(db), '连不上 GitHub：{why}', { why: e.message })); }
}
async function orgMember(db, { org, login, fetchFn = globalThis.fetch, at = now() }) {
  const row = loginAppRow(db);
  if (!row) throw new LoginError('not_configured');
  const pem = appOAuthSecret(db, row, 'pem');
  const appId = JSON.parse(row.meta).appId;
  const L = contentLang(db);
  // 查不通的原因写成人话（命令行 cred member 与看板日志直接显示）；登录页只按 code 显示一句概括
  const fail = (why) => new LoginError('membership_check', why);
  const key = `${row.id}|${org}`.toLowerCase();
  let hit = ORG_CACHE.get(key);
  if (!hit || hit.expiresAt - 5 * 60_000 <= at) {
    const ir = await fetchFn(`${apiBase(row)}/orgs/${encodeURIComponent(org)}/installation`, { headers: ghHeaders(`Bearer ${appJwt(appId, pem, at)}`), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (ir.status === 404) throw fail(tl(L, 'App 没装在组织 {org} 上：App 设置 → Install App → 选这个组织安装', { org }));
    if (ir.status === 401) throw fail(tl(L, 'GitHub 不认这个 App 的签名：App ID 填错了，或私钥已在 GitHub 上删除'));
    if (!ir.ok) throw fail(tl(L, '查 App 安装失败：HTTP {status}', { status: ir.status }));
    const inst = (await ir.json()).id;
    const tr = await fetchFn(`${apiBase(row)}/app/installations/${inst}/access_tokens`, { method: 'POST', headers: { ...ghHeaders(`Bearer ${appJwt(appId, pem, at)}`), 'content-type': 'application/json' },
      body: JSON.stringify({ permissions: { members: 'read' } }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (tr.status === 422 || tr.status === 403) throw fail(tl(L, 'App 缺组织权限 Members: Read-only：到 App 设置 → Permissions & events → Organization permissions 加上，再到组织的安装页接受新权限'));
    if (!tr.ok) throw fail(tl(L, '换 App 安装令牌失败：HTTP {status}', { status: tr.status }));
    const j = await tr.json();
    hit = { token: j.token, expiresAt: Date.parse(j.expires_at) || at + 3_600_000 };
    ORG_CACHE.set(key, hit);
  }
  const mr = await fetchFn(`${apiBase(row)}/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`, { headers: ghHeaders(`Bearer ${hit.token}`), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (mr.status === 404) return false;
  if (!mr.ok) { if (mr.status === 401) ORG_CACHE.delete(key); throw fail(tl(L, '查组织成员资格失败：HTTP {status}', { status: mr.status })); }
  return (await mr.json()).state === 'active';
}

/** GitHub 账号 → 成员：按数字 id；没有就按资料里管理员填的账号（还没绑过）对上并绑定；再没有按设置自动建或拒绝。 */
function userFor(db, { id, login, at }) {
  let u = db.one(`SELECT id, display_name, role, kind, disabled_at, github_login, github_id FROM users WHERE github_id=?`, id);
  if (!u) {
    u = db.one(`SELECT id, display_name, role, kind, disabled_at, github_login, github_id FROM users WHERE lower(github_login)=lower(?) AND github_id IS NULL`, login);
    // 自己填的不认（防冒领）：要本人先用令牌登录、在「成员」里用 GitHub 验证绑定
    if (u && !githubLoginAdminSet(db, u.id, login)) throw new LoginError('unverified', '', login);
    if (u && !u.disabled_at && u.kind !== 'service') {
      db.tx(() => {
        updateUser(db, u.id, { githubId: id });
        audit(db, { actorKind: 'user', actorId: u.id, action: 'github_login_bound', targetType: 'user', targetId: u.id, payload: { github: login, githubId: id } });
      });
    }
  }
  if (!u) {
    const role = getSetting(db, 'deploy.github_login_autocreate');
    if (role === 'off') throw new LoginError('no_user', '', login);
    let name = login, i = 2;
    while (db.one(`SELECT 1 FROM users WHERE display_name=?`, name)) name = `${login}-${i++}`;
    const uid = newId('u');
    db.tx(() => {
      insertUser(db, { id: uid, displayName: name, role, createdAt: at });
      updateUser(db, uid, { githubLogin: login, githubId: id });
      audit(db, { actorKind: 'system', actorId: null, action: 'user_added', targetType: 'user', targetId: uid, payload: { name, role, via: 'github', github: login, githubId: id } });
    });
    return { id: uid, created: true };
  }
  if (u.disabled_at || u.kind === 'service') throw new LoginError('disabled', '', login);
  if (u.github_login !== login) updateUser(db, u.id, { githubLogin: login });   // GitHub 上改了名：跟着改（按 id 认人）
  return { id: u.id, created: false };
}

/** 回调：换身份、查组织、认人、开会话。返回 { userId, created, session }；失败抛 LoginError（审计记 github_login_refused）。 */
export async function finishLogin(db, { code, verifier, redirectUri, linkUserId = null, ip = null, fetchFn = globalThis.fetch, at = now() }) {
  const cfg = githubLoginConfig(db);
  if (!cfg.enabled) throw new LoginError('not_configured');
  const row = loginAppRow(db);
  let who = null;
  try {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(String(code ?? ''))) throw new LoginError('github', 'bad code');
    who = await whoIsCode(row, { clientId: cfg.app.clientId, secret: appOAuthSecret(db, row, 'oauth'), code, verifier, redirectUri, fetchFn });
    if (!(await isOrgMember(db, { org: cfg.org, login: who.login, fetchFn, at }))) throw new LoginError('not_member', '', who.login);
    if (linkUserId) return { userId: linkAccount(db, { userId: linkUserId, id: who.id, login: who.login }), linked: true, login: who.login };
    const u = userFor(db, { id: who.id, login: who.login, at });
    const session = createGithubSession(db, { userId: u.id, githubLogin: who.login, ip, at });
    return { userId: u.id, created: u.created, session };
  } catch (e) {
    const code2 = e instanceof LoginError ? e.code : 'github';
    audit(db, { actorKind: 'system', actorId: null, action: 'github_login_refused', targetType: 'user', targetId: null,
      payload: { reason: code2, github: who?.login ?? null, ip, ...(linkUserId ? { linkUserId } : {}), detail: String(e.message).slice(0, 200) } });
    if (e instanceof LoginError) { e.login ??= who?.login ?? null; throw e; }
    throw new LoginError('github', e.message, who?.login ?? null);
  }
}

/** 关联账号：已登录的人走一遍 GitHub 授权，把回来的数字 id 与账号绑到自己身上（别人绑过的、别人资料里占着的都拒）。 */
function linkAccount(db, { userId, id, login }) {
  const u = db.one(`SELECT id, disabled_at, kind, github_id FROM users WHERE id=?`, userId);
  if (!u || u.disabled_at || u.kind === 'service') throw new LoginError('disabled', '', login);
  // 别人绑过（数字 id）或管理员替别人填的：拒。别人自己填、没验证过的：正主来验证就让给正主，清掉那份（不然占坑的人能挡住正主）
  const other = db.one(`SELECT id, github_id, github_login FROM users WHERE id<>? AND (github_id=? OR lower(github_login)=lower(?))`, userId, id, login);
  if (other && (other.github_id != null || githubLoginAdminSet(db, other.id, login))) throw new LoginError('taken', '', login);
  db.tx(() => {
    if (other) {
      updateUser(db, other.id, { githubLogin: null });
      audit(db, { actorKind: 'user', actorId: userId, action: 'github_login_claim_cleared', targetType: 'user', targetId: other.id, payload: { github: login, claimedBy: userId } });
    }
    updateUser(db, userId, { githubId: id, githubLogin: login });
    audit(db, { actorKind: 'user', actorId: userId, action: 'github_login_bound', targetType: 'user', targetId: userId, payload: { github: login, githubId: id, via: 'link' } });
  });
  return userId;
}

/**
 * 复查（看板进程每小时）：会话还活着、经 GitHub 登录的人，查实不再是组织正式成员 → 吊销他们经 GitHub 开的会话。
 * 查不通（GitHub 不可达、App 权限被收）不吊销，返回 errors 由调用方记日志。命令行令牌不动（那是管理员另发的）。
 */
export async function recheckMembers(db, { fetchFn = globalThis.fetch, at = now() } = {}) {
  const cfg = githubLoginConfig(db);
  if (!cfg.enabled) return { checked: 0, revoked: [], errors: [] };
  const rows = db.all(`SELECT DISTINCT u.id, u.github_login FROM tokens k JOIN users u ON u.id=k.user_id
                       WHERE k.kind='session' AND k.name=? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?) AND u.github_login IS NOT NULL`, GITHUB_SESSION_NAME, at);
  const revoked = [], errors = [];
  for (const r of rows) {
    let ok;
    try { ok = await isOrgMember(db, { org: cfg.org, login: r.github_login, fetchFn, at }); } catch (e) { errors.push({ userId: r.id, error: e.message }); continue; }
    if (ok) continue;
    const ids = db.all(`SELECT id FROM tokens WHERE user_id=? AND kind='session' AND name=? AND revoked_at IS NULL`, r.id, GITHUB_SESSION_NAME).map((t) => t.id);
    db.tx(() => {
      for (const id of ids) revokeToken(db, id, at);
      audit(db, { actorKind: 'system', actorId: null, action: 'github_membership_lost', targetType: 'user', targetId: r.id, payload: { github: r.github_login, org: cfg.org, sessions: ids } });
    });
    revoked.push(r.id);
  }
  return { checked: rows.length, revoked, errors };
}

/** 登录页上的人话（code 与 GitHub 账号来自 URL：code 只认这几个，账号只认合法形状）。 */
export function loginErrorText(L, code, { login = null, org = '' } = {}) {
  const who = login && GH_LOGIN_RE.test(login) ? `@${login}` : tl(L, '你的 GitHub 账号');
  const notMe = login && GH_LOGIN_RE.test(login) ? tl(L, '（不是这个账号？先到 github.com 退出，再点「用 GitHub 登录」）') : '';
  const t = {
    not_configured: tl(L, '这个看板的 GitHub 登录已关闭，请用令牌登录'),
    state: tl(L, '登录链接过期或不是从这个页面发起的，请重新点「用 GitHub 登录」'),
    github: tl(L, 'GitHub 那边没有完成授权（可能点了取消，或网络不通），请重试'),
    not_member: tl(L, '{who} 不是 GitHub 组织 {org} 的正式成员。请该组织的管理员邀请你；已经收到邀请的，到 github.com/orgs/{org}/invitation 接受后再登录', { who, org }),
    no_user: tl(L, '{who} 还没对应到看板成员。已有看板账号的：先用令牌登录，在「设置 → 成员」里点「用 GitHub 验证并绑定」；还没有账号的：请看板管理员发邀请链接，或替你在成员资料里填上这个 GitHub 账号', { who }),
    unverified: tl(L, '{who} 是成员资料里自己填的，还没验证。请先用令牌登录，在「设置 → 成员」里点「用 GitHub 验证并绑定」；或请看板管理员替你填一次', { who }),
    taken: tl(L, '{who} 已经绑在另一位看板成员名下了，不能再绑给你。请找看板管理员', { who }),
    disabled: tl(L, '你的看板账号已停用，请找看板管理员'),
    membership_check: tl(L, '暂时查不了组织成员资格，请稍后重试；还不行，把这行字发给看板管理员'),
  }[code];
  return t ? t + (['not_member', 'no_user', 'unverified', 'taken'].includes(code) ? notMe : '') : null;
}
