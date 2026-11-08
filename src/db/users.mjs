// 成员（users）与令牌（tokens）的写入。原来 users 由 4 个文件写（成员管理、交接停用 / 启用、
// CLI init 改显示名、看板改界面语言），tokens 由 2 个文件写（签发 / 重发、停用时吊销）。
// 权限检查、审计照旧在调用方（core/users.mjs、core/handover.mjs）—— 这里只管"怎么写"。

import { now, sha256 } from './db.mjs';

export function insertUser(db, { id, displayName, role, domainTags = [], createdAt = now(), kind = 'human' }) {
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at,kind) VALUES (?,?,?,?,?,?)`, id, displayName, role, JSON.stringify(domainTags), createdAt, kind);
  return id;
}

/** 能经这里改的列。 */
const FIELDS = { displayName: 'display_name', role: 'role', domainTags: 'domain_tags', lang: 'lang', disabledAt: 'disabled_at', budgetUsdMonth: 'budget_usd_month', githubLogin: 'github_login', commitEmail: 'commit_email', seenAt: 'seen_at', awayFrom: 'away_from', awayTo: 'away_to', githubId: 'github_id', tz: 'tz', signalPrefs: 'signal_prefs', pushPrefs: 'push_prefs' };

/** 改成员的若干列：只改给了的（undefined = 不动）。domainTags 给数组。 */
export function updateUser(db, userId, fields) {
  const cols = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (!FIELDS[k]) throw new Error(`updateUser：不能经这里改 ${k}`);
    cols.push(`${FIELDS[k]}=?`); vals.push(k === 'domainTags' ? JSON.stringify(v) : v);
  }
  if (cols.length) db.run(`UPDATE users SET ${cols.join(', ')} WHERE id=?`, ...vals, userId);
}

/**
 * 签发一枚令牌（库里只存哈希；明文由调用方交给人，只此一次）。
 * kind：cli / session / service / mail（邮件答复令牌，authenticate 默认不认）；scope：read / write；expiresAt：绝对过期（null = 不过期）；idleMs：闲置多久失效；parentId：会话的来源令牌。
 */
export function insertToken(db, { id, userId, plaintext, issuedBy, issuedAt = now(), name = null, kind = 'cli', scope = 'write', expiresAt = null, idleMs = null, parentId = null }) {
  db.run(`INSERT INTO tokens (id,user_id,token_hash,issued_by,issued_at,name,kind,scope,expires_at,idle_ms,parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, userId, sha256(plaintext), issuedBy, issuedAt, name, kind, scope, expiresAt, idleMs, parentId);
  return id;
}

/** 记"最后在何时何处用过"（几枚一起）。 */
export function touchTokens(db, ids, { at = now(), ip = null } = {}) {
  for (const id of ids) db.run(`UPDATE tokens SET last_used_at=?, last_ip=coalesce(?, last_ip) WHERE id=?`, at, ip, id);
}

/** 吊销某人所有还有效的令牌，返回吊销了几枚。 */
export const revokeTokens = (db, userId, at = now()) => Number(db.run(`UPDATE tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, at, userId).changes);

/** 吊销一枚令牌，连同用它登录换来的会话。返回吊销了几枚。 */
export const revokeToken = (db, tokenId, at = now()) =>
  Number(db.run(`UPDATE tokens SET revoked_at=? WHERE (id=? OR parent_id=?) AND revoked_at IS NULL`, at, tokenId, tokenId).changes);

// ── 邀请：一次性、短时效、库里只存哈希、绑定角色 ──
export function insertInvite(db, { id, plaintext, role, name = null, createdBy, createdAt = now(), expiresAt }) {
  db.run(`INSERT INTO invites (id,token_hash,role,name,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?)`, id, sha256(plaintext), role, name, createdBy, createdAt, expiresAt);
  return id;
}

/** 把邀请标成已用；只在它还可用时成功（返回 true）—— 两个人同时点同一个链接，只有一个能用上。 */
export const useInvite = (db, inviteId, { userId, at = now() }) =>
  Number(db.run(`UPDATE invites SET used_at=?, used_by=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`, at, userId, inviteId, at).changes) === 1;

export const revokeInvite = (db, inviteId, at = now()) => Number(db.run(`UPDATE invites SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL`, at, inviteId).changes) === 1;
