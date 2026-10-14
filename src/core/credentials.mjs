// 连接（凭据）与按动作解析。
//
// 原来：整个部署一份 GITHUB_TOKEN（.env），不分人、不分仓库、长期有效；推非 GitHub 的远端走宿主机自己的 git 凭据。
// 现在：**凭据挂在"连接"上，不挂在项目上**。项目只记远端地址；每次动作（读 / 推送 / 开 PR）按"动作 + 远端 + 操作人"
// 现场挑一份，审计记下用的是哪一份、谁的。十个项目在同一个组织下零配置共用；换令牌只改一处。
//
// 三种连接：
//   token       个人令牌 / 通用 https 令牌（GitHub、GitLab、Gitea、内网都行）—— 走 http.extraheader，只进子进程环境变量
//   github_app  GitHub App：库里存私钥；每次动作现签 JWT 换一个只覆盖这一个仓库、按动作给权限、1 小时过期的安装令牌
//   ssh_key     SSH 私钥（不带口令）：动作期间写一个 600 的临时文件，GIT_SSH_COMMAND 指过去，用完删
//
// 存储：secret 列是 AES-256-GCM 密文，附加数据 = 行 id（把密文挪到别的行解不开）。主密钥**在库外**：
// 默认库文件旁的 master.key（第一次用到时生成，600），或环境变量 SUPERINTERN_MASTER_KEY（32 字节 base64）。
// 库备份里没有主密钥 —— 把 state.db 拷给别人排查问题不会连带交出凭据；反过来，换机器恢复时要把 master.key 一起带上，
// 否则连接解不开（会当场说清楚，重新录入即可）。只写不读：任何接口都不回显明文，界面只显示 hint。
//
// 解析顺序（deploy.credential_order）：
//   personal_first（默认）：操作人自己的 → 部署级令牌 → GitHub App → .env 里的 GITHUB_TOKEN（老部署）
//   app_first：GitHub App → 部署级令牌 → 操作人自己的 → .env
// **成员自己的连接只用于他本人发起的动作**（防混淆代理：甲的令牌不能被乙点的交付借用）。
// 系统自己发起的动作（没有操作人）只用部署级连接，而且只读。

import { createCipheriv, createDecipheriv, randomBytes, createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { audit, newId, now } from '../db/db.mjs';
import { I18nError, tl, contentLang } from '../i18n/index.mjs';
import { getSetting } from './settings.mjs';
import { HTTP_TIMEOUT_MS } from './http.mjs';
import { registerSecret } from './redact.mjs';
import { gitRaw } from './git.mjs';

export const KINDS = ['token', 'github_app', 'ssh_key'];
const GH_API = 'https://api.github.com';
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

// ── 主密钥 ────────────────────────────────────────────────────────────────
const KEYS = new Map();          // 文件路径 → 密钥
const MEM_KEYS = new WeakMap();  // :memory: 库 → 进程内临时密钥（测试用）

/** 主密钥文件的位置：SUPERINTERN_MASTER_KEY_FILE，否则库文件旁的 master.key；内存库没有文件。 */
export function masterKeyFile(db) {
  if (process.env.SUPERINTERN_MASTER_KEY_FILE) return process.env.SUPERINTERN_MASTER_KEY_FILE;
  return db.path && db.path !== ':memory:' ? join(dirname(db.path), 'master.key') : null;
}

/**
 * 取主密钥。`create` 时文件不存在就生成一个（独占创建：看板和守护进程同时第一次用到，也只会有一份）。
 * 不 create 且不存在 → null（还没有任何连接，解析时直接跳过）。
 */
export function masterKey(db, { create = false } = {}) {
  const fromEnv = process.env.SUPERINTERN_MASTER_KEY;
  if (fromEnv) {
    const k = Buffer.from(fromEnv.trim(), 'base64');
    if (k.length !== 32) throw new I18nError('环境变量 SUPERINTERN_MASTER_KEY 不对：应为 32 字节随机数的 base64');
    return k;
  }
  const file = masterKeyFile(db);
  if (!file) {
    if (!MEM_KEYS.has(db)) MEM_KEYS.set(db, randomBytes(32));
    return MEM_KEYS.get(db);
  }
  if (KEYS.has(file)) return KEYS.get(file);
  let txt;
  try { txt = readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (!create) return null;
    mkdirSync(dirname(file), { recursive: true });
    try { writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { flag: 'wx', mode: 0o600 }); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
    txt = readFileSync(file, 'utf8');
  }
  const k = Buffer.from(txt.trim(), 'base64');
  if (k.length !== 32) throw new I18nError('主密钥文件 {file} 内容不对：应为 32 字节随机数的 base64', { file });
  KEYS.set(file, k);
  return k;
}

const kidOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 8);

/** 加密。aad = 行 id：密文与这一行绑定。 */
export function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, alg: 'A256GCM', kid: kidOf(key), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') });
}

export function unseal(key, sealed, aad) {
  const s = JSON.parse(sealed);
  if (!key || s.kid !== kidOf(key)) {
    throw new I18nError('这条连接解不开：加密它用的主密钥不是现在这一份（库是从别的机器搬来、或 master.key 换过）。在「设置 → 连接」把它吊销、重新录入即可');
  }
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  let plain;
  try { plain = Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf8'); } catch {
    throw new I18nError('这条连接的密文校验不过（被改过，或不属于这一行）。吊销后重新录入');
  }
  registerSecret(plain);   // 之后任何写入层见到这串都脱掉
  return plain;
}

// ── 远端地址 ──────────────────────────────────────────────────────────────
/**
 * 远端地址 → { scheme: 'https'|'http'|'ssh'|'local', host, path, origin }。
 * path 是去掉 .git 的仓库路径（GitHub 上就是 owner/repo）。本机路径、file:// → local（用不着凭据）。
 */
export function parseRemote(remote) {
  const s = String(remote ?? '').trim();
  let m = s.match(/^(https?):\/\/(?:[^@/]+@)?([^/:?#]+)(:\d+)?\/([^?#]+?)(?:\.git)?\/?$/i);
  if (m) return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), path: m[4], origin: `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3] ?? ''}` };
  m = s.match(/^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i);
  if (m) return { scheme: 'ssh', host: m[2].toLowerCase(), path: m[3], user: m[1] ?? null };
  // scp 形式 user@host:path。主机名至少两个字符：Windows 盘符（C:/x）是本机路径
  m = s.match(/^(?:([^@/\s]+)@)?([^/:\s\\]{2,}):(?!\/\/)(.+?)(?:\.git)?\/?$/);
  if (m && !/^[a-z]:[\\/]/i.test(s)) return { scheme: 'ssh', host: m[2].toLowerCase(), path: m[3].replace(/^\/+/, ''), user: m[1] ?? null };
  return { scheme: 'local', host: null, path: s };
}

/** 'acme/*' 匹配 acme 下的所有仓库；'*' 匹配全部；否则整串相等。大小写不敏感。 */
export function globMatch(glob, path) {
  const re = new RegExp(`^${String(glob).toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(String(path).toLowerCase());
}

// ── 录入、吊销、列表（credentials 表只在这里写）─────────────────────────────────
const isAdmin = (db, userId) => db.one(`SELECT role FROM users WHERE id=? AND disabled_at IS NULL`, userId)?.role === 'lead';

/** OpenSSH 私钥：取出公钥算指纹（和 GitHub / ssh-keygen -l 显示的一致），并拒绝带口令的（无人值守时没法输口令）。 */
function sshKeyInfo(text) {
  const t = String(text).trim();
  const m = t.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/);
  if (!m) {
    if (/-----BEGIN (RSA |EC |)PRIVATE KEY-----/.test(t)) {
      if (/ENCRYPTED/.test(t)) throw new I18nError('这把 SSH 密钥带口令：系统无人值守时没法输口令。用 ssh-keygen -p 去掉口令，或专门生成一把部署密钥');
      const pub = createPublicKey(createPrivateKey(t)).export({ type: 'spki', format: 'der' });
      return { fingerprint: `SHA256:${createHash('sha256').update(pub).digest('base64').replace(/=+$/, '')}` };
    }
    throw new I18nError('不像 SSH 私钥：要以 -----BEGIN OPENSSH PRIVATE KEY----- 开头的整段内容');
  }
  const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  const magic = 'openssh-key-v1\0';
  if (buf.subarray(0, magic.length).toString('latin1') !== magic) throw new I18nError('SSH 私钥格式不认识');
  let off = magic.length;
  const str = () => { const n = buf.readUInt32BE(off); off += 4; const v = buf.subarray(off, off + n); off += n; return v; };
  const cipher = str().toString();
  str(); str();                  // kdfname、kdfoptions
  off += 4;                      // 密钥个数
  const pub = str();
  if (cipher !== 'none') throw new I18nError('这把 SSH 密钥带口令：系统无人值守时没法输口令。用 ssh-keygen -p 去掉口令，或专门生成一把部署密钥');
  return { fingerprint: `SHA256:${createHash('sha256').update(pub).digest('base64').replace(/=+$/, '')}` };
}

/**
 * 录入一条连接。`ownerId` null = 部署级（只有管理员能加）；否则是某个成员自己的（本人或管理员能加）。
 * @returns {{id: string, hint: string}}
 */
export function addCredential(db, { kind, name, ownerId = null, host = 'github.com', pathGlob = '*', secret, appId = null, username = null, apiBase = null, expiresAt = null, byUserId, at = now() }) {
  if (!KINDS.includes(kind)) throw new I18nError('连接类型不对：{kind}（可选 token / github_app / ssh_key）', { kind });
  if (!isAdmin(db, byUserId)) {
    if (ownerId === null) throw new I18nError('部署级连接只有管理员能加；你可以加一条只给自己用的');
    if (ownerId !== byUserId) throw new I18nError('只能给自己加连接');
  }
  const u = db.one(`SELECT role, kind, disabled_at FROM users WHERE id=?`, ownerId ?? byUserId);
  if (!u || u.disabled_at || u.role === 'observer' || u.kind === 'service') throw new I18nError('旁观者、服务账户与已停用的成员不能有连接');
  name = String(name ?? '').trim();
  if (!name) throw new I18nError('给连接起个名字（例如「acme 组织 App」「我的 GitHub 令牌」）');
  host = String(host ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) throw new I18nError('主机名不对：{host}（例如 github.com、gitlab.example.com）', { host });
  pathGlob = String(pathGlob || '*').trim().replace(/^\/+|\.git$/g, '');
  secret = String(secret ?? '').replace(/\r\n/g, '\n');
  if (!secret.trim()) throw new I18nError('没有填凭据内容');
  const meta = {};
  let hint;
  if (kind === 'token') {
    secret = secret.trim();
    if (/\s/.test(secret)) throw new I18nError('令牌里不该有空格或换行：是不是粘多了？');
    hint = `…${secret.slice(-4)}`;
    if (username) meta.username = String(username).trim();
  } else if (kind === 'github_app') {
    if (!/^\d+$/.test(String(appId ?? '').trim())) throw new I18nError('GitHub App 要填 App ID（App 设置页上的一串数字）');
    meta.appId = String(appId).trim();
    let key;
    try { key = createPrivateKey(secret); } catch { throw new I18nError('私钥读不出来：要的是 GitHub App 页面上「Generate a private key」下载的那个 .pem 文件的整段内容'); }
    if (key.asymmetricKeyType !== 'rsa') throw new I18nError('GitHub App 的私钥应是 RSA 密钥');
    const pub = createPublicKey(key).export({ type: 'spki', format: 'der' });
    // 指纹按 SHA256:<base64> 写，和 App 设置页 Private keys 下列出的指纹开头对得上（认得出是哪一把）
    hint = `App ${meta.appId} · SHA256:${createHash('sha256').update(pub).digest('base64').slice(0, 12)}`;
    meta.apiBase = apiBase ? String(apiBase).replace(/\/+$/, '') : host === 'github.com' ? GH_API : `https://${host}/api/v3`;
  } else {
    hint = sshKeyInfo(secret).fingerprint.slice(0, 20);
    if (!secret.endsWith('\n')) secret += '\n';
  }
  if (expiresAt != null && !(Number.isFinite(expiresAt) && expiresAt > at)) throw new I18nError('到期时间要在将来');
  const id = newId('cr');
  const sealed = seal(masterKey(db, { create: true }), secret, id);
  registerSecret(secret);   // 录入这一刻起，本进程任何写入层见到都脱（检查失败的报错可能把它带出来）
  db.tx(() => {
    db.run(`INSERT INTO credentials (id,kind,name,owner_id,host,path_glob,secret,hint,meta,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, kind, name, ownerId, host, pathGlob, sealed, hint, JSON.stringify(meta), expiresAt, byUserId, at);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'credential_added', targetType: 'credential', targetId: id,
      payload: { kind, name, ownerId, host, pathGlob, hint, expiresAt, ...(meta.appId ? { appId: meta.appId } : {}) } });
  });
  return { id, hint };
}

// ── 用 GitHub 登录：App 的 OAuth Client ID / Client secret 挂在部署级 GitHub App 连接上 ──
/** 登录用哪份 App：部署级、没吊销的里面**最近一次填了 OAuth 的**（管理员在哪份上填，就切到哪份）；都没填就取最新一份部署级 App（好提示"还缺 Client ID"）。 */
export function loginAppRow(db) {
  const rows = db.all(`SELECT * FROM credentials WHERE kind='github_app' AND owner_id IS NULL AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC`);
  const set = rows.filter((r) => JSON.parse(r.meta).clientId).sort((a, b) => (JSON.parse(b.meta).oauthAt ?? 0) - (JSON.parse(a.meta).oauthAt ?? 0));
  return set[0] ?? rows[0] ?? null;
}

/** 解密：'pem' = App 私钥；'oauth' = Client secret（附加数据 = 行 id + '#oauth'，和私钥的密文互不能换）。 */
export function appOAuthSecret(db, row, which) {
  if (which === 'pem') return unseal(masterKey(db), row.secret, row.id);
  const o = JSON.parse(row.meta).oauth;
  if (!o) throw new I18nError('这份 GitHub App 连接还没填 Client secret');
  return unseal(masterKey(db), JSON.stringify(o), `${row.id}#oauth`);
}

/** 给部署级 GitHub App 连接填 / 换 OAuth 的 Client ID 与 Client secret（管理员）。secret 不给 = 只改 Client ID。 */
export function setAppOAuth(db, { id, clientId, clientSecret = undefined, byUserId, at = now() }) {
  if (!isAdmin(db, byUserId)) throw new I18nError('只有管理员能设 GitHub 登录');
  const row = db.one(`SELECT * FROM credentials WHERE id=? AND revoked_at IS NULL`, id);
  if (!row || row.kind !== 'github_app' || row.owner_id) throw new I18nError('要选一份部署级的 GitHub App 连接（{id} 不是）', { id });
  const cid = String(clientId ?? '').trim();
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(cid)) throw new I18nError('Client ID 不对：在 App 设置页 About 一栏，形如 Iv23li…');
  const meta = JSON.parse(row.meta);
  meta.clientId = cid;
  meta.oauthAt = at;
  if (clientSecret !== undefined) {
    const sec = String(clientSecret ?? '').trim();
    if (!sec || /\s/.test(sec)) throw new I18nError('Client secret 不对：在 App 设置页点「Generate a new client secret」，复制那一串（只显示一次）');
    meta.oauth = JSON.parse(seal(masterKey(db, { create: true }), sec, `${row.id}#oauth`));
    registerSecret(sec);
  }
  if (!meta.oauth) throw new I18nError('还要填 Client secret');
  db.tx(() => {
    db.run(`UPDATE credentials SET meta=? WHERE id=?`, JSON.stringify(meta), row.id);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'credential_oauth_set', targetType: 'credential', targetId: row.id, payload: { clientId: cid, secretChanged: clientSecret !== undefined } });
  });
  return { id: row.id, clientId: cid };
}

/** 吊销：本人或管理员。吊销即不再参与解析；行留着（审计里引用它）。 */
export function revokeCredential(db, { id, byUserId, at = now() }) {
  const row = db.one(`SELECT * FROM credentials WHERE id=?`, id);
  if (!row) throw new I18nError('没有这条连接：{id}', { id });
  if (!(isAdmin(db, byUserId) || (row.owner_id && row.owner_id === byUserId))) throw new I18nError('只有管理员或连接的主人能吊销它');
  return revokeRow(db, row, { byUserId, at });
}

function revokeRow(db, row, { byUserId = null, at = now(), why = null }) {
  if (row.revoked_at) return false;
  return db.tx(() => {
    db.run(`UPDATE credentials SET revoked_at=?, revoked_by=? WHERE id=? AND revoked_at IS NULL`, at, byUserId, row.id);
    audit(db, { actorKind: byUserId ? 'user' : 'system', actorId: byUserId, action: 'credential_revoked', targetType: 'credential', targetId: row.id,
      payload: { name: row.name, ownerId: row.owner_id, ...(why ? { why } : {}) } });
    for (const k of [...APP_CACHE.keys()]) if (k.startsWith(`${row.id}|`)) APP_CACHE.delete(k);
    return true;
  });
}

/** 成员停用时一并吊销他自己的连接（交接流程里调；权限由停用那一步判过）。 */
export function revokeCredentialsOf(db, { userId, at = now() }) {
  const rows = db.all(`SELECT * FROM credentials WHERE owner_id=? AND revoked_at IS NULL`, userId);
  for (const r of rows) revokeRow(db, r, { at, why: 'owner_disabled' });
  return rows.length;
}

const markUsed = (db, id, at = now()) => db.run(`UPDATE credentials SET last_used_at=? WHERE id=?`, at, id);
const recordCheck = (db, id, check) => db.run(`UPDATE credentials SET last_check=? WHERE id=?`, JSON.stringify(check), id);
const learnExpiry = (db, id, at) => db.run(`UPDATE credentials SET expires_at=? WHERE id=? AND expires_at IS NULL`, at, id);

/** .env 里的 GITHUB_TOKEN（老部署的那一份）：当作一条部署级、只对 github.com 的令牌连接。 */
const ENV_ID = 'env:GITHUB_TOKEN';
const envCandidate = (env) => (env?.GITHUB_TOKEN ? {
  id: ENV_ID, kind: 'token', name: 'GITHUB_TOKEN（.env）', owner_id: null, host: 'github.com', path_glob: '*',
  hint: `…${String(env.GITHUB_TOKEN).slice(-4)}`, meta: '{}', expires_at: null, fromEnv: true,
} : null);

/**
 * 看板与命令行的列表。管理员看全部；成员看部署级的与自己的。永不含明文。
 * @returns {{rows: object[], order: string}}
 */
export function listCredentials(db, { viewerId, env = process.env, at = now() }) {
  const admin = isAdmin(db, viewerId);
  const rows = db.all(`SELECT c.id, c.kind, c.name, c.owner_id, u.display_name AS owner_name, c.host, c.path_glob, c.hint, c.meta,
                              c.expires_at, c.created_at, c.revoked_at, c.last_used_at, c.last_check
                       FROM credentials c LEFT JOIN users u ON u.id=c.owner_id
                       WHERE c.revoked_at IS NULL AND (? OR c.owner_id IS NULL OR c.owner_id=?)
                       ORDER BY c.owner_id IS NOT NULL, c.created_at`, admin ? 1 : 0, viewerId)
    .map((r) => ({ id: r.id, kind: r.kind, name: r.name, ownerId: r.owner_id, ownerName: r.owner_name, host: r.host, pathGlob: r.path_glob,
      hint: r.hint, appId: JSON.parse(r.meta).appId ?? null, clientId: JSON.parse(r.meta).clientId ?? null, hasClientSecret: !!JSON.parse(r.meta).oauth, expiresAt: r.expires_at, expired: r.expires_at != null && r.expires_at <= at,
      createdAt: r.created_at, lastUsedAt: r.last_used_at, lastCheck: r.last_check ? JSON.parse(r.last_check) : null,
      mine: r.owner_id === viewerId, canRevoke: admin || r.owner_id === viewerId }));
  const e = envCandidate(env);
  if (e) rows.push({ id: e.id, kind: 'token', name: e.name, ownerId: null, ownerName: null, host: 'github.com', pathGlob: '*', hint: admin ? e.hint : null,
    appId: null, expiresAt: null, expired: false, createdAt: null, lastUsedAt: null, lastCheck: null, mine: false, canRevoke: admin, fromEnv: true });
  return { rows, order: getSetting(db, 'deploy.credential_order'), admin };
}

/** 7 天内到期的连接（摘要里提醒主人；部署级的提醒管理员）。 */
export function expiringCredentials(db, { userId, at = now(), withinMs = 7 * 86_400_000 }) {
  const admin = isAdmin(db, userId);
  return db.all(`SELECT id, name, owner_id, expires_at FROM credentials WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?
                 AND (owner_id=? OR (owner_id IS NULL AND ?)) ORDER BY expires_at`, at + withinMs, userId, admin ? 1 : 0)
    .map((r) => ({ id: r.id, name: r.name, expiresAt: r.expires_at, expired: r.expires_at <= at, deployment: r.owner_id === null }));
}

// ── GitHub App ────────────────────────────────────────────────────────────
/** App 身份的 JWT（RS256，iat 往前拨 60 秒抵时钟偏差，10 分钟内有效 —— GitHub 的上限）。 */
export function appJwt(appId, pem, at = now()) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = Math.floor(at / 1000);
  const body = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iat: t - 60, exp: t + 540, iss: String(appId) })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), pem).toString('base64url')}`;
}

// 进程内缓存：安装 id（按 连接|owner/repo）与安装令牌（按 连接|安装|仓库|权限，过期前 5 分钟作废）。**不落盘。**
const APP_CACHE = new Map();
export const clearAppCache = () => APP_CACHE.clear();

/** 这次动作要的最小权限。 */
export function appPermissions(action, { workflows = false } = {}) {
  if (action === 'read') return { contents: 'read', metadata: 'read' };
  return { contents: 'write', metadata: 'read', ...(action === 'pr' ? { pull_requests: 'write' } : {}), ...(workflows ? { workflows: 'write' } : {}) };
}

class Skip extends Error {}

async function appInstallationToken(db, row, target, { action, workflows, fetchFn, at }) {
  const meta = JSON.parse(row.meta);
  const [owner, ...rest] = target.path.split('/');
  const repo = rest.join('/');
  const pem = unseal(masterKey(db), row.secret, row.id);
  const headers = (auth) => ({ authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'superintern' });
  const L = contentLang(db);
  const instKey = `${row.id}|inst|${owner}/${repo}`.toLowerCase();
  let inst = APP_CACHE.get(instKey);
  if (!inst) {
    const res = await fetchFn(`${meta.apiBase}/repos/${owner}/${repo}/installation`, { headers: headers(appJwt(meta.appId, pem, at)), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (res.status === 404) throw new Skip(tl(L, 'App 没装在 {repo} 上（或安装时没勾这个仓库）：到 GitHub 组织设置 → GitHub Apps → 这个 App → Configure 里加上', { repo: `${owner}/${repo}` }));
    if (res.status === 401) throw new Skip(tl(L, 'GitHub 不认这个 App 的签名：App ID 填错了，或私钥已在 GitHub 上删除'));
    if (!res.ok) throw new Skip(tl(L, '查 App 安装失败：HTTP {status}', { status: res.status }));
    inst = (await res.json()).id;
    APP_CACHE.set(instKey, inst);
  }
  const perms = appPermissions(action, { workflows });
  const tokKey = `${row.id}|tok|${inst}|${repo}|${JSON.stringify(perms)}`.toLowerCase();
  const hit = APP_CACHE.get(tokKey);
  if (hit && hit.expiresAt - 5 * 60_000 > at) return hit;
  const res = await fetchFn(`${meta.apiBase}/app/installations/${inst}/access_tokens`, { method: 'POST', headers: { ...headers(appJwt(meta.appId, pem, at)), 'content-type': 'application/json' },
    body: JSON.stringify({ repositories: [repo], permissions: perms }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (res.status === 422 || res.status === 403) {
    const want = Object.entries(perms).map(([k, v]) => `${k}:${v}`).join(', ');
    throw new Skip(tl(L, 'App 的权限不够（这次要 {want}）：到 App 设置 → Permissions 加上，再到组织的安装页点「接受新权限」', { want }));
  }
  if (!res.ok) throw new Skip(tl(L, '换 App 安装令牌失败：HTTP {status}', { status: res.status }));
  const j = await res.json();
  const out = { token: j.token, expiresAt: Date.parse(j.expires_at) || at + 3_600_000, installationId: inst, permissions: perms };
  APP_CACHE.set(tokKey, out);
  return out;
}

// ── 解析 ──────────────────────────────────────────────────────────────────
const baseEnv = (env) => ({ ...env, ...NO_PROMPT });
function tokenEnv(env, target, username, token) {
  const basic = Buffer.from(`${username}:${token}`).toString('base64');
  return { ...baseEnv(env), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${target.origin}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}
const homeOf = (db) => (db.path && db.path !== ':memory:' ? dirname(db.path) : tmpdir());
const q = (p) => `'${String(p).replace(/\\/g, '/').replace(/'/g, `'\\''`)}'`;

/** 给审计 / 界面的连接摘要（永不含明文）。 */
export const credSummary = (row, db) => (row ? { id: row.id, name: row.name, kind: row.kind, ownerId: row.owner_id ?? null,
  ownerName: row.owner_id ? db.one(`SELECT display_name FROM users WHERE id=?`, row.owner_id)?.display_name ?? null : null, hint: row.hint } : null);

/**
 * 按"动作 + 远端 + 操作人"挑一份连接，并把它变成这次动作能直接用的东西。
 * @param {object} o
 * @param {string} o.remote
 * @param {'read'|'push'|'pr'} [o.action]
 * @param {string|null} [o.actorId]  发起动作的人；null = 系统自己（只许读、只用部署级连接）
 * @param {boolean} [o.workflows]    这次推送改到了 .github/workflows/（GitHub App 要多要一项 workflows 权限）
 * @returns {Promise<{target, credential: object|null, gitEnv: object, apiToken: string|null, apiBase: string, tried: {name:string, why:string}[], cleanup: () => void}>}
 */
export async function resolveCredential(db, { remote, action = 'push', actorId = null, workflows = false, env = process.env, fetchFn = globalThis.fetch, at = now(), skip = [] }) {
  const target = parseRemote(remote);
  const L = contentLang(db);
  const out = { target, credential: null, gitEnv: baseEnv(env), apiToken: null, apiBase: GH_API, tried: [], cleanup: () => {} };
  if (target.scheme === 'local') return out;
  if (!actorId && action !== 'read') throw new I18nError('系统自己发起的动作只能读远端，不能推送');
  const order = getSetting(db, 'deploy.credential_order');
  const rows = masterKey(db) ? db.all(`SELECT * FROM credentials WHERE revoked_at IS NULL AND host=?`, target.host) : [];
  const live = rows.filter((r) => globMatch(r.path_glob, target.path));
  for (const r of rows) if (!live.includes(r)) out.tried.push({ name: r.name, why: tl(L, '适用范围是 {glob}，不含 {path}', { glob: r.path_glob, path: target.path }) });
  // 同一档里有几份都匹配：适用范围写得越具体越先（acme/web 先于 acme/* 先于 *），再按新加的先 —— 换新令牌时"先加新的、再吊销旧的"，中间这段用的就是新的
  const bySpecific = (a, b) => (String(b.path_glob).replace(/\*/g, '').length - String(a.path_glob).replace(/\*/g, '').length) || (b.created_at - a.created_at);
  const own = live.filter((r) => actorId && r.owner_id === actorId).sort(bySpecific);
  const depTok = live.filter((r) => r.owner_id === null && r.kind !== 'github_app').sort(bySpecific);
  const apps = live.filter((r) => r.owner_id === null && r.kind === 'github_app').sort(bySpecific);
  for (const r of live) if (r.owner_id && r.owner_id !== actorId) out.tried.push({ name: r.name, why: tl(L, '是别人的连接，只用于其主人本人发起的动作') });
  const env0 = envCandidate(env);
  const envList = env0 && target.host === 'github.com' ? [env0] : [];
  // App 排在部署级令牌前面：管理员两样都配了，用短期、按仓库收窄的那一个（原来 App 排最后，老部署 .env 里有令牌时 App 永远轮不到）
  const list = order === 'app_first' ? [...apps, ...own, ...depTok, ...envList] : [...own, ...apps, ...depTok, ...envList];
  for (const r of list) {
    if (skip.includes(r.id)) continue;   // 这一次已经试过、推不上去的（调用方在 tried 里说明原因）
    if (r.expires_at != null && r.expires_at <= at) { out.tried.push({ name: r.name, why: tl(L, '已过期') }); continue; }
    try {
      if (r.kind === 'ssh_key') {
        if (target.scheme !== 'ssh') throw new Skip(tl(L, 'SSH 密钥只用于 ssh 地址（git@… 或 ssh://…）'));
        const dir = mkdtempSync(join(homeOf(db), 'tmp-ssh-'));
        const keyFile = join(dir, 'id');
        writeFileSync(keyFile, unseal(masterKey(db), r.secret, r.id), { mode: 0o600 });
        const known = join(homeOf(db), 'known_hosts');
        out.gitEnv = { ...baseEnv(env), GIT_SSH_COMMAND: `ssh -i ${q(keyFile)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${q(known)}` };
        out.cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ } };
      } else {
        if (target.scheme === 'ssh') throw new Skip(tl(L, '令牌只用于 https 地址；这个远端是 ssh 地址'));
        if (target.scheme === 'http') throw new Skip(tl(L, '远端是明文 http：不在明文连接上发令牌'));
        let token, username;
        if (r.kind === 'github_app') {
          const t = await appInstallationToken(db, r, target, { action, workflows, fetchFn, at });
          token = t.token; username = 'x-access-token';
          out.app = { installationId: t.installationId, permissions: t.permissions, expiresAt: t.expiresAt };
          out.apiBase = JSON.parse(r.meta).apiBase;
        } else {
          token = r.fromEnv ? String(env.GITHUB_TOKEN) : unseal(masterKey(db), r.secret, r.id);
          const meta = JSON.parse(r.meta);
          username = meta.username ?? (target.host === 'github.com' ? 'x-access-token' : 'oauth2');
          if (target.host !== 'github.com') out.apiBase = `https://${target.host}/api/v3`;
        }
        out.gitEnv = tokenEnv(env, target, username, token);
        if (target.host === 'github.com' || r.kind === 'github_app') out.apiToken = token;
      }
      out.credential = r.fromEnv ? { id: ENV_ID, name: r.name, kind: 'token', ownerId: null, ownerName: null, hint: r.hint, fromEnv: true } : credSummary(r, db);
      if (!r.fromEnv) markUsed(db, r.id, at);
      // SSH 只管推送；开 PR 要调 GitHub 接口，另按同一仓库的 https 地址挑一份 App / 令牌（原来 SSH 远端开不了 PR，也没说为什么）
      if (r.kind === 'ssh_key' && action === 'pr' && target.host === 'github.com') {
        const api = await resolveCredential(db, { remote: `https://github.com/${target.path}.git`, action: 'pr', actorId, env, fetchFn, at });
        api.cleanup();
        Object.assign(out, { apiToken: api.apiToken, apiBase: api.apiBase, apiCredential: api.credential });
        if (!api.apiToken) out.tried.push(...api.tried, { name: r.name, why: tl(L, 'SSH 密钥只能推送；开 PR 还要一份能调 GitHub 接口的 App 或令牌') });
      }
      return out;
    } catch (e) {
      if (e instanceof Skip) { out.tried.push({ name: r.name, why: e.message }); continue; }
      throw e;
    }
  }
  return out;
}

/** "没有可用连接"时给人的一段话：都试了哪些、为什么没用上、去哪里加。 */
export function noCredentialText(db, res, { lang = contentLang(db) } = {}) {
  const t = res.target;
  const head = tl(lang, '没有能用在 {host}/{path} 上的连接', { host: t.host, path: t.path });
  const tried = res.tried.length ? `${tl(lang, '（试过：')}${res.tried.map((x) => `${x.name} —— ${x.why}`).join(lang === 'en' ? '; ' : '；')}${tl(lang, '）')}` : '';
  return `${head}${tried}${tl(lang, '。到「设置 → 连接」加一个（GitHub 推荐装 GitHub App），或用命令行 node src/cli.mjs cred add')}`;
}

/**
 * 预检：这个远端、这个动作，会用哪一份连接，能不能读、能不能推。
 * 能不能推用 `git push --dry-run` 实测（它会走推送的鉴权握手，但不送任何东西）；从一个临时空仓库推一个不存在的分支名，不碰任何真分支。
 */
export async function checkAccess(db, { remote, action = 'push', actorId, env = process.env, fetchFn = globalThis.fetch, at = now() }) {
  const L = contentLang(db);
  const res = await resolveCredential(db, { remote, action: action === 'read' ? 'read' : action, actorId, env, fetchFn, at });
  const out = { remote, local: res.target.scheme === 'local', credential: res.credential, tried: res.tried, canRead: null, canPush: null, defaultBranch: null, detail: null };
  const tmp = mkdtempSync(join(tmpdir(), 'si-preflight-'));
  const g = (args, cwd = tmp) => gitRaw(cwd, args, { env: res.gitEnv, timeout: 30_000 });
  try {
    try {
      const sym = g(['ls-remote', '--symref', '--', remote, 'HEAD']);
      out.canRead = true;
      out.defaultBranch = sym.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1] ?? null;
    } catch (e) { out.canRead = false; out.detail = lastLine(e); }
    if (out.canRead && action !== 'read') {
      try {
        g(['init', '-q']);
        g(['-c', 'user.name=superintern', '-c', 'user.email=superintern@localhost', 'commit', '-q', '--allow-empty', '-m', 'preflight']);
        g(['push', '--dry-run', '--', remote, `HEAD:refs/heads/superintern/preflight-${Date.now().toString(36)}`]);
        out.canPush = true;
      } catch (e) { out.canPush = false; out.detail = lastLine(e); }
    }
  } finally {
    res.cleanup();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
  // GitHub 的个人令牌：响应头里带到期时间（fine-grained / classic 设了到期的都有），没填到期就记下来，到时候摘要里提醒
  if (res.credential && !res.credential.fromEnv && res.apiToken && res.credential.kind === 'token' && res.target.host === 'github.com') {
    try {
      const r = await fetchFn(`${GH_API}/repos/${res.target.path}`, { headers: { authorization: `Bearer ${res.apiToken}`, accept: 'application/vnd.github+json', 'user-agent': 'superintern' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const exp = Date.parse(String(r.headers?.get?.('github-authentication-token-expiration') ?? '').replace(' UTC', 'Z').replace(' ', 'T'));
      if (Number.isFinite(exp)) learnExpiry(db, res.credential.id, exp);
    } catch { /* 拿不到就算了：只是提醒用 */ }
  }
  if (res.credential && !res.credential.fromEnv) recordCheck(db, res.credential.id, { at, remote, action, canRead: out.canRead, canPush: out.canPush, detail: out.detail });
  if (!res.credential && !out.local && !out.detail) out.detail = noCredentialText(db, res, { lang: L });
  return out;
}

const lastLine = (e) => String(e.stderr ?? e.message ?? '').trim().split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 300);
