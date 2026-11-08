// 身份与会话。令牌的签发策略、浏览器会话、逐个 / 全部吊销、邀请链接、服务账户。
//
// 三种令牌（tokens.kind）：
//   cli      命令行与"切换身份"用的长期令牌。默认 deploy.cli_token_days 天过期（0 = 不过期），一人可以有多枚、各有名字。
//   session  浏览器会话：登录时由一枚 cli 令牌换来（parent_id 指着它），cookie 里只放会话令牌，不再放长期令牌本身。
//            闲置 deploy.session_idle_hours 小时失效、最长 deploy.session_max_days 天；退出即吊销；来源令牌被吊销 / 过期，会话跟着失效。
//   service  服务账户的令牌：不能登录看板（服务账户与人分开），替人做事时审计记 on_behalf_of。
// 两种作用域（tokens.scope）：write 读写（默认）/ read 只读 —— 只读令牌只能 GET（看板大屏、监控脚本），由 HTTP 分派器一处执行。
// 没做"管理"作用域：管理员权限的判断散在 21 处、跟着角色走，只在分派器那一层截不全；做一半等于给人一个不生效的开关。

import { randomBytes } from 'node:crypto';
import { newId, now, audit, sha256 } from '../db/db.mjs';
import { insertToken, revokeToken, revokeTokens, insertInvite, useInvite, revokeInvite, insertUser, touchTokens } from '../db/users.mjs';
import { getSetting } from './settings.mjs';
import { I18nError, N_ } from '../i18n/index.mjs';

const H = 3600_000, D = 24 * H;
const newSecret = () => randomBytes(24).toString('base64url');
export const SCOPES = ['read', 'write'];

/**
 * 签发一枚命令行令牌（或服务令牌）。days 不给就按部署设置；0 = 不过期。返回 { tokenId, plaintext, expiresAt }（明文只此一次）。
 */
export function issueToken(db, { userId, by, name = null, scope = 'write', days = undefined, kind = 'cli', at = now() }) {
  if (!SCOPES.includes(scope)) throw new I18nError('作用域只能是 read（只读）或 write（读写）');
  if (!['cli', 'service'].includes(kind)) throw new Error(`issueToken：kind 只能是 cli / service（会话由 createSession 签）`);
  const u = db.one(`SELECT kind FROM users WHERE id=?`, userId);
  if (!u) throw new I18nError('成员不存在：{id}', { id: userId });
  if ((u.kind === 'service') !== (kind === 'service')) throw new I18nError('服务账户只能签服务令牌，人只能签命令行令牌');
  const d = days === undefined ? Number(getSetting(db, 'deploy.cli_token_days')) : Number(days);
  if (!Number.isInteger(d) || d < 0) throw new I18nError('有效期要是不小于 0 的整数天（0 = 不过期）');
  const tokenId = newId('tk'), plaintext = newSecret();
  const expiresAt = d > 0 ? at + d * D : null;
  insertToken(db, { id: tokenId, userId, plaintext, issuedBy: by, issuedAt: at, name, kind, scope, expiresAt });
  return { tokenId, plaintext, expiresAt };
}

/**
 * 登录：用一枚 cli 令牌换一个浏览器会话。返回 { tokenId, plaintext, maxAgeMs }，失败抛 I18nError（status 401 / 403）。
 * 会话继承来源令牌的作用域（只读令牌登录，看板也只读）。
 */
export function createSession(db, { login, ip = null, at = now() }) {
  if (login.kind !== 'cli') throw Object.assign(new I18nError(login.kind === 'service' ? '服务账户的令牌不能登录看板' : '请用命令行令牌登录'), { status: 403 });
  if (login.user_kind === 'service') throw Object.assign(new I18nError('服务账户的令牌不能登录看板'), { status: 403 });
  const idleMs = Number(getSetting(db, 'deploy.session_idle_hours')) * H;
  const maxAgeMs = Number(getSetting(db, 'deploy.session_max_days')) * D;
  const parent = db.one(`SELECT expires_at, scope FROM tokens WHERE id=?`, login.token_id);
  // 会话不能比来源令牌活得久
  const expiresAt = Math.min(at + maxAgeMs, parent?.expires_at ?? Infinity);
  const tokenId = newId('tk'), plaintext = newSecret();
  db.tx(() => {
    insertToken(db, { id: tokenId, userId: login.user_id, plaintext, issuedBy: login.user_id, issuedAt: at, name: N_('浏览器会话'), kind: 'session', scope: parent?.scope ?? 'write', expiresAt, idleMs, parentId: login.token_id });
    // 会话与它的来源令牌都记一次使用：接受邀请时是直接拿新签的令牌开会话，不记的话那枚会显示"没用过"、又标着"现在这次登录是用它登的"
    touchTokens(db, [tokenId, login.token_id], { at, ip });
    audit(db, { actorKind: 'user', actorId: login.user_id, action: 'user_login', targetType: 'user', targetId: login.user_id, payload: { ip, session: tokenId, via: login.token_id } });
  });
  return { tokenId, plaintext, maxAgeMs: expiresAt - at };
}

/** GitHub 登录的会话名（看板"我的会话"里显示；每小时复查组织成员资格时按它找）。 */
export const GITHUB_SESSION_NAME = N_('浏览器会话（GitHub 登录）');

/**
 * 用 GitHub 登录：身份已由 core/github-login.mjs 核过（GitHub 账号 → 成员、组织成员资格），直接开一个会话。
 * 没有来源令牌（parent_id 空）；作用域读写，能做什么照旧按角色。
 */
export function createGithubSession(db, { userId, githubLogin, ip = null, at = now() }) {
  const idleMs = Number(getSetting(db, 'deploy.session_idle_hours')) * H;
  const maxAgeMs = Number(getSetting(db, 'deploy.session_max_days')) * D;
  const tokenId = newId('tk'), plaintext = newSecret();
  db.tx(() => {
    insertToken(db, { id: tokenId, userId, plaintext, issuedBy: userId, issuedAt: at, name: GITHUB_SESSION_NAME, kind: 'session', scope: 'write', expiresAt: at + maxAgeMs, idleMs });
    touchTokens(db, [tokenId], { at, ip });
    audit(db, { actorKind: 'user', actorId: userId, action: 'user_login', targetType: 'user', targetId: userId, payload: { ip, session: tokenId, via: 'github', github: githubLogin } });
  });
  return { tokenId, plaintext, maxAgeMs };
}

/** 退出：吊销这个会话（只吊销会话本身；拿长期令牌直接调接口的，"退出"不吊销那枚长期令牌）。 */
export function endSession(db, { tokenId, userId, at = now() }) {
  const t = db.one(`SELECT kind FROM tokens WHERE id=? AND user_id=?`, tokenId, userId);
  if (t?.kind !== 'session') return false;
  db.tx(() => {
    revokeToken(db, tokenId, at);
    audit(db, { actorKind: 'user', actorId: userId, action: 'user_logout', targetType: 'user', targetId: userId, payload: { session: tokenId } });
  });
  return true;
}

const status = (t, at) => (t.revoked_at ? 'revoked' : t.expires_at != null && t.expires_at <= at ? 'expired'
  : t.idle_ms != null && (t.last_used_at ?? t.issued_at) + t.idle_ms <= at ? 'idle' : 'active');

/** 某人的令牌与会话（不含哈希）。current = 发请求用的那枚。默认只列还有效的。 */
export function tokensOf(db, userId, { at = now(), current = null, all = false } = {}) {
  // current：发这个请求用的那一枚（会话或长期令牌）；viaCurrent：当前会话是用它登录换来的
  const via = current ? db.one(`SELECT parent_id p FROM tokens WHERE id=?`, current)?.p ?? null : null;
  return db.all(`SELECT id, name, kind, scope, issued_at, issued_by, expires_at, idle_ms, last_used_at, last_ip, parent_id, revoked_at FROM tokens WHERE user_id=? AND kind<>'mail' ORDER BY issued_at DESC`, userId)
    .map((t) => ({ ...t, status: status(t, at), current: t.id === current, viaCurrent: t.id === via }))
    .filter((t) => all || t.status === 'active');
}

/** 管理员看全员：所有还有效的令牌与会话，带成员名。 */
export function activeTokens(db, { at = now() } = {}) {
  return db.all(`SELECT k.id, k.user_id, u.display_name, u.kind AS user_kind, k.name, k.kind, k.scope, k.issued_at, k.expires_at, k.idle_ms, k.last_used_at, k.last_ip, k.parent_id, k.revoked_at
                 FROM tokens k JOIN users u ON u.id=k.user_id WHERE k.revoked_at IS NULL AND u.disabled_at IS NULL AND k.kind<>'mail' ORDER BY u.display_name, k.issued_at DESC`)
    .map((t) => ({ ...t, status: status(t, at) })).filter((t) => t.status === 'active');
}

/**
 * 吊销一枚令牌（连同用它登录的会话）。本人可以吊销自己的；管理员可以吊销任何人的。
 * @returns {number} 吊销了几枚
 */
export function revokeTokenBy(db, { tokenId, byUserId, isAdmin = false, at = now() }) {
  const t = db.one(`SELECT id, user_id, kind, revoked_at FROM tokens WHERE id=?`, tokenId);
  if (!t) throw Object.assign(new I18nError('令牌不存在'), { status: 404 });
  if (t.user_id !== byUserId && !isAdmin) throw Object.assign(new I18nError('只能吊销自己的令牌（管理员可以吊销任何人的）'), { status: 403 });
  if (t.revoked_at) return 0;
  return db.tx(() => {
    const n = revokeToken(db, tokenId, at);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'token_revoked', targetType: 'user', targetId: t.user_id, payload: { tokenId, kind: t.kind, cascaded: n - 1 } });
    return n;
  });
}

/** 一键吊销某人的全部令牌与会话，可留下当前这一枚（及换出它的那枚）。 */
export function revokeAllOf(db, { userId, byUserId, keep = null, at = now() }) {
  const keepIds = new Set([keep, keep && db.one(`SELECT parent_id p FROM tokens WHERE id=?`, keep)?.p].filter(Boolean));
  return db.tx(() => {
    const ids = db.all(`SELECT id FROM tokens WHERE user_id=? AND revoked_at IS NULL`, userId).map((r) => r.id).filter((id) => !keepIds.has(id));
    for (const id of ids) revokeToken(db, id, at);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'tokens_revoked_all', targetType: 'user', targetId: userId, payload: { count: ids.length, kept: [...keepIds] } });
    return ids.length;
  });
}

// ── 邀请 ──

/** 管理员发一个邀请链接：一次性、短时效、绑定角色。返回 { inviteId, code, expiresAt }（code 只此一次）。 */
export function createInvite(db, { byUserId, role = 'member', name = null, hours = undefined, at = now() }) {
  if (!['member', 'observer'].includes(role)) throw new I18nError('邀请只能是成员（member）或旁观者（observer）；管理员角色请在加入后由管理员授予');
  const h = hours === undefined ? Number(getSetting(db, 'deploy.invite_hours')) : Number(hours);
  if (!Number.isInteger(h) || h < 1 || h > 24 * 7) throw new I18nError('邀请有效期要在 1–168 小时之间');
  const inviteId = newId('iv'), code = newSecret();
  const expiresAt = at + h * H;
  db.tx(() => {
    insertInvite(db, { id: inviteId, plaintext: code, role, name: name ? String(name).trim() : null, createdBy: byUserId, createdAt: at, expiresAt });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'invite_created', targetType: 'user', targetId: null, payload: { inviteId, role, name, expiresAt } });
  });
  return { inviteId, code, expiresAt };
}

/** 邀请的状态（不含哈希）。 */
export function invitesList(db, { at = now() } = {}) {
  return db.all(`SELECT i.id, i.role, i.name, i.created_by, c.display_name AS created_by_name, i.created_at, i.expires_at, i.used_at, i.used_by, u.display_name AS used_by_name, i.revoked_at
                 FROM invites i JOIN users c ON c.id=i.created_by LEFT JOIN users u ON u.id=i.used_by ORDER BY i.created_at DESC LIMIT 50`)
    .map((i) => ({ ...i, status: i.used_at ? 'used' : i.revoked_at ? 'revoked' : i.expires_at <= at ? 'expired' : 'open' }));
}

/** 用邀请码查邀请（接受页先给人看"你将以什么角色加入"）。无效返回 null。 */
export function inviteByCode(db, code, { at = now() } = {}) {
  if (!code) return null;
  const i = db.one(`SELECT id, role, name, expires_at, used_at, revoked_at FROM invites WHERE token_hash=?`, sha256(code));
  if (!i || i.used_at || i.revoked_at || i.expires_at <= at) return null;
  return i;
}

/**
 * 接受邀请：建成员 + 签一枚 cli 令牌 + 开一个浏览器会话。邀请当场作废（并发点同一个链接只有一个能用上）。
 * 返回 { userId, session: {tokenId, plaintext, maxAgeMs}, cli: {tokenId, plaintext} }。
 */
export function acceptInvite(db, { code, name, ip = null, at = now() }) {
  const inv = inviteByCode(db, code, { at });
  if (!inv) throw Object.assign(new I18nError('邀请链接无效、已用过、已撤销或已过期；请找管理员重新发一个'), { status: 410 });
  const display = String(name ?? inv.name ?? '').trim();
  if (!display) throw new I18nError('名称不能为空');
  if (db.one(`SELECT id FROM users WHERE display_name=?`, display)) throw new I18nError('名称 {name} 已被使用', { name: display });
  return db.tx(() => {
    const userId = newId('u');
    insertUser(db, { id: userId, displayName: display, role: inv.role, createdAt: at });
    if (!useInvite(db, inv.id, { userId, at })) throw Object.assign(new I18nError('邀请链接无效、已用过、已撤销或已过期；请找管理员重新发一个'), { status: 410 });
    const cli = issueToken(db, { userId, by: userId, name: N_('接受邀请时签发'), at });
    audit(db, { actorKind: 'user', actorId: userId, action: 'invite_accepted', targetType: 'user', targetId: userId, payload: { inviteId: inv.id, role: inv.role, ip } });
    const login = { token_id: cli.tokenId, user_id: userId, kind: 'cli', user_kind: 'human' };
    const session = createSession(db, { login, ip, at });
    return { userId, role: inv.role, session, cli: { tokenId: cli.tokenId, plaintext: cli.plaintext, expiresAt: cli.expiresAt } };
  });
}

export function revokeInviteBy(db, { inviteId, byUserId, at = now() }) {
  return db.tx(() => {
    const ok = revokeInvite(db, inviteId, at);
    if (ok) audit(db, { actorKind: 'user', actorId: byUserId, action: 'invite_revoked', targetType: 'user', targetId: null, payload: { inviteId } });
    return ok;
  });
}

// ── 服务账户 ──

/** 建一个服务账户（不能登录看板、不能当负责人），并签一枚服务令牌。返回 { userId, tokenId, plaintext, expiresAt }。 */
export function addServiceAccount(db, { name, byUserId, scope = 'write', days = undefined, at = now() }) {
  const display = String(name ?? '').trim();
  if (!display) throw new I18nError('名称不能为空');
  if (db.one(`SELECT id FROM users WHERE display_name=?`, display)) throw new I18nError('名称 {name} 已被使用', { name: display });
  return db.tx(() => {
    const userId = newId('u');
    insertUser(db, { id: userId, displayName: display, role: 'member', kind: 'service', createdAt: at });
    const t = issueToken(db, { userId, by: byUserId, name: N_('服务令牌'), scope, days, kind: 'service', at });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'service_account_added', targetType: 'user', targetId: userId, payload: { name: display, scope, tokenId: t.tokenId, expiresAt: t.expiresAt } });
    return { userId, ...t };
  });
}

export { revokeTokens };
