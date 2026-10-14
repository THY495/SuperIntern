// 联网源的凭据，由出口代理替沙箱里的工具带上（最小权限注入）。
//
// 原来要访问私有镜像 / 私有包仓库，只能把令牌写进源的 tool_env：它进沙箱的环境变量（沙箱里任何代码都读得到、能带出去），
// 还原样印进执行器的提示词（送到模型服务商）。现在：
//   · 值用主密钥加密存库（v45 egress_credentials），只在起出口代理时解开，放进**代理容器**的环境变量；
//   · 代理按规则给发往这个源的域名的请求加上请求头（guard.py 的 cred_rule_for，规则里只有变量名）；
//   · 沙箱里的代码用得了它（经代理）、读不到它；默认只在 GET / HEAD / OPTIONS 上带 —— 用它也改不了东西。
//     要在写请求上也带（例如往私有仓库发布），管理员显式打开 allow_write，那是一次"人在环"的决定，记审计。
//
// Rule of Two（Meta）：一个会话同时「读不可信输入」「持有敏感凭据」「能对外改变状态」就要人在环。沙箱里的代码总是
// 读不可信输入的；注入了凭据，就把对外改变状态这一样拿掉 —— 见 core/capabilities.mjs 的 narrowForCredentials。

import { audit, newId, now } from '../db/db.mjs';
import { I18nError } from '../i18n/index.mjs';
import { masterKey, seal, unseal } from './credentials.mjs';
import { registerSecret } from './redact.mjs';
import { sourceOf, dropSecretToolEnv } from './egress.mjs';

// 这些头代理自己要管，或者带上会改请求的去向 / 长度，不许当凭据头
const BAD_HEADERS = /^(host|content-length|transfer-encoding|connection|upgrade|te|trailer|proxy-.*|x-forwarded-.*|forwarded)$/i;

const isAdmin = (db, userId) => db.one(`SELECT role FROM users WHERE id=? AND disabled_at IS NULL`, userId)?.role === 'lead';

/** 给联网目录里的一个源加凭据（管理员）。一个源同时只有一份在用的：要换先吊销。 */
export function addSourceCredential(db, { sourceId, header = 'Authorization', secret, allowWrite = false, byUserId, at = now() }) {
  if (!isAdmin(db, byUserId)) throw new I18nError('只有管理员能给联网源配凭据：它会被带到这个源的每一个请求上');
  const s = sourceOf(db, sourceId);
  if (!s) throw new I18nError('联网目录里没有这个源：{id}', { id: sourceId });
  header = String(header ?? '').trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(header) || BAD_HEADERS.test(header)) throw new I18nError('请求头名字不对：{h}（常见的是 Authorization；不能是 Host、Content-Length、Proxy-* 这类代理自己要管的头）', { h: header });
  secret = String(secret ?? '').trim();
  if (!secret) throw new I18nError('没有填凭据内容');
  if (/[\r\n]/.test(secret)) throw new I18nError('请求头的值里不能有换行：是不是粘多了？');
  if (db.one(`SELECT 1 FROM egress_credentials WHERE source_id=? AND revoked_at IS NULL`, sourceId)) {
    throw new I18nError('这个源已经有一份凭据在用：先吊销它（sources cred revoke <id>），再加新的');
  }
  const id = newId('ec');
  const sealed = seal(masterKey(db, { create: true }), secret, id);
  registerSecret(secret);
  const hint = `…${secret.slice(-4)}`;
  let dropped = [];
  db.tx(() => {
    db.run(`INSERT INTO egress_credentials (id,source_id,header,secret,hint,allow_write,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, sourceId, header, sealed, hint, allowWrite ? 1 : 0, byUserId, at);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'egress_credential_added', targetType: 'egress_source', targetId: sourceId,
      payload: { credentialId: id, header, hint, allowWrite: !!allowWrite, hosts: s.hosts } });
    // 以前只能写进工具配置的凭据：现在有了正经的地方，那几项删掉（早就不注入了）
    dropped = dropSecretToolEnv(db, sourceId, { userId: byUserId, at });
  });
  return { id, hint, dropped };
}

/** 吊销（管理员）。行留着，审计里引用它。 */
export function revokeSourceCredential(db, { id, byUserId, at = now() }) {
  if (!isAdmin(db, byUserId)) throw new I18nError('只有管理员能吊销联网源的凭据');
  const row = db.one(`SELECT * FROM egress_credentials WHERE id=?`, id);
  if (!row) throw new I18nError('没有这份联网源凭据：{id}', { id });
  if (row.revoked_at) return false;
  db.tx(() => {
    db.run(`UPDATE egress_credentials SET revoked_at=?, revoked_by=? WHERE id=? AND revoked_at IS NULL`, at, byUserId, id);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'egress_credential_revoked', targetType: 'egress_source', targetId: row.source_id, payload: { credentialId: id } });
  });
  return true;
}

/** 在用的凭据（不含值）：sourceId → { id, header, hint, allowWrite, createdAt } */
export function sourceCredentials(db) {
  return Object.fromEntries(db.all(`SELECT id, source_id, header, hint, allow_write, created_at FROM egress_credentials WHERE revoked_at IS NULL`)
    .map((r) => [r.source_id, { id: r.id, header: r.header, hint: r.hint, allowWrite: !!r.allow_write, createdAt: r.created_at }]));
}

/**
 * 这次起的沙箱要注入哪些凭据：喂给出口代理的 { credRules, credEnv }，以及给审计 / 能力检查用的摘要（不含值）。
 * 规则只有变量名（SI_CRED_<n>）；值只进代理容器。解不开的（主密钥换过）抛 —— 宁可起不来，也不静默少带一份凭据让上游 401。
 */
export function credentialInjection(db, groups) {
  const live = sourceCredentials(db);
  const credRules = [], credEnv = {}, injected = [];
  let n = 0;
  for (const sid of groups) {
    const c = live[sid];
    const s = c && sourceOf(db, sid);
    if (!s) continue;
    const row = db.one(`SELECT secret FROM egress_credentials WHERE id=?`, c.id);
    const env = `SI_CRED_${n++}`;
    credEnv[env] = unseal(masterKey(db), row.secret, c.id);
    // 只读 = guard.py 的 is_read：GET / HEAD / OPTIONS，加上 git 拉取（POST …/git-upload-pack）；推送、发布不带
    for (const host of s.hosts) credRules.push({ host, path_prefix: '/', header: c.header, env, ...(c.allowWrite ? {} : { readOnly: true }) });
    injected.push({ sourceId: sid, credentialId: c.id, header: c.header, hosts: s.hosts, allowWrite: c.allowWrite });
  }
  return { credRules, credEnv, injected };
}
