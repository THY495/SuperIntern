// 成员的 GitHub 身份，哪些算数（防冒名）。
//
// 成员资料里的 GitHub 账号与提交邮箱本人就能填，而且只核格式：要是照填照用，乙把甲的账号填在自己名下，
// 提交 trailer 与 PR 溯源表里就写成"乙 (@甲)"；把甲的 noreply 邮箱填进来，Co-authored-by 就让 GitHub 在提交上显示甲的头像；
// 开了 GitHub 登录时，甲用 GitHub 一登录就进了乙的账号。所以凡是"拿它当身份用"的地方，只认：
//   - 已绑定（users.github_id）：本人走过一遍 GitHub 授权（登录或「用 GitHub 验证并绑定」），按数字 id 认的；
//   - 管理员替人填的（最近一次设置它的审计带 byAdmin）。
// 提交邮箱：已绑定的人用 GitHub 按数字 id 生成的 noreply 地址（GitHub 认它、别人伪造不了）；没绑定的只认管理员填的。

/** 最近一次设置这个字段（'github' / 'email'）的审计是不是管理员做的、值是不是还是这个。 */
function adminSet(db, userId, field, check) {
  const a = db.one(`SELECT payload FROM audit_log WHERE action='user_git_identity_set' AND target_id=? AND payload LIKE ? ORDER BY id DESC LIMIT 1`, userId, `%"${field}":%`);
  let p = null; try { p = a ? JSON.parse(a.payload) : null; } catch { /* 坏行当没填 */ }
  return !!(p && p.byAdmin === true && check(p[field]));
}

/** 资料里这个 GitHub 账号是不是管理员填的。 */
export const githubLoginAdminSet = (db, userId, login) => adminSet(db, userId, 'github', (v) => typeof v === 'string' && v.toLowerCase() === String(login).toLowerCase());

/**
 * 能当身份用的 GitHub 账号与提交邮箱：{ github: string|null, email: string|null, bound: boolean }。
 * 没验证的一律当没有（提交 trailer、PR 溯源表、Co-authored-by、按账号名绑定 GitHub 登录都按这个）。
 */
export function verifiedGit(db, userId) {
  const u = userId ? db.one(`SELECT github_login, github_id, commit_email FROM users WHERE id=?`, userId) : null;
  if (!u) return { github: null, email: null, bound: false };
  const bound = u.github_id != null && !!u.github_login;
  const github = bound || (u.github_login && githubLoginAdminSet(db, userId, u.github_login)) ? u.github_login : null;
  const email = bound ? `${u.github_id}+${u.github_login}@users.noreply.github.com`
    : u.commit_email && adminSet(db, userId, 'email', (v) => v === true) ? u.commit_email : null;
  return { github, email, bound };
}
