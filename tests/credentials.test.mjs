// 连接（凭据）与推送护栏：
//   ① 加密：密文与行绑定（挪到别的行解不开）、主密钥不对说清楚、库文件里找不到明文；主密钥文件独占创建；
//   ② 远端地址解析与适用范围；
//   ③ 录入的规矩：部署级只有管理员能加、成员只能给自己加、旁观者不能有；令牌 / App 私钥 / SSH 密钥各自的校验（带口令的 SSH 密钥拒收）；
//   ④ 解析顺序：本人的 → 部署令牌 → App → .env；别人的连接不借用；过期 / 吊销 / 范围不含 / 协议不对的跳过并说清原因；
//      系统自己发起的动作只许读；app_first 口径；
//   ⑤ GitHub App：JWT 用私钥签、iss = App ID；按仓库查安装、只为这一个仓库按动作要权限；令牌缓存；没装 / 权限不够 → 跳过并说清楚；
//   ⑥ 推送护栏：不推别的分支、不推默认分支、不强推（远端被别人推过 → 拒、远端不动）、空仓库才许推起点；拒绝都有审计；
//      改了工作流被拒 → App 带上 workflows 权限重签一次再推；
//   ⑦ 端到端：库里的连接用于交付与开 PR，审计记连接名、全库没有明文；成员停用连带吊销；
//   ⑧ 预检：本机裸库能读能推、不存在的远端读不了；
//   ⑨ 棘轮：src/ 里只有 push.mjs（和预检的 --dry-run）调 git push。
//
// 跑：node tests/credentials.test.mjs

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { seal, unseal, masterKey, parseRemote, globMatch, addCredential, revokeCredential, revokeCredentialsOf, listCredentials, resolveCredential,
  appPermissions, clearAppCache, checkAccess, expiringCredentials } from '../src/core/credentials.mjs';
import { pushBranch, pushInitialDefault } from '../src/core/push.mjs';
import { deliverTask, connectAndPush } from '../src/core/deliver.mjs';
import { buildDigest, renderDigest } from '../src/core/digest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throwsLike = (fn, re, m) => { try { fn(); bad(m, '没有抛错'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, e.message); } };
const rejectsLike = async (p, re, m) => { try { await p; bad(m, '没有抛错'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, e.message); } };
const section = (s) => console.log(`\n── ${s}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-cred-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const FAKE_TOKEN = 'gh' + 'p_FAKEcredTEST0000000000000000zz91';   // 现拼：发布导出会扫描密钥形状

// ═══════════════════════════════════════════════════════════════════════════
section('① 加密与主密钥');
// ═══════════════════════════════════════════════════════════════════════════
{
  const k = Buffer.alloc(32, 7);
  const s = seal(k, 'hello', 'cr_a');
  eq(unseal(k, s, 'cr_a'), 'hello', '加解密往返');
  throwsLike(() => unseal(k, s, 'cr_b'), /校验不过/, '密文挪到别的行解不开（附加数据绑定行 id）');
  throwsLike(() => unseal(Buffer.alloc(32, 8), s, 'cr_a'), /主密钥不是现在这一份/, '主密钥不对：说清楚是换了机器 / 换了密钥');

  const dbFile = join(TMP, 'k', 'state.db');
  const db = openDb(dbFile);
  const lead = ensureOwner(db, '管理员');
  eq(masterKey(db), null, '没有任何连接时不生成主密钥');
  addCredential(db, { kind: 'token', name: '部署令牌', secret: FAKE_TOKEN, byUserId: lead.userId });
  const kf = join(dirname(dbFile), 'master.key');
  assert(existsSync(kf), '第一次录入时在库文件旁生成 master.key');
  if (process.platform !== 'win32') eq((statSync(kf).mode & 0o777).toString(8), '600', 'master.key 权限 600');
  db.close();
  const bytes = Buffer.concat(readdirSync(dirname(dbFile)).filter((f) => f.startsWith('state.db')).map((f) => readFileSync(join(dirname(dbFile), f))));
  assert(bytes.length > 0 && !bytes.includes(Buffer.from(FAKE_TOKEN)) && !bytes.includes(Buffer.from(FAKE_TOKEN.slice(4, 20))), '库文件（含 -wal）里找不到令牌明文');
  const db2 = openDb(dbFile);
  eq(masterKey(db2), masterKey(db2), '再打开读同一份主密钥');
  db2.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('② 远端地址与适用范围');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(parseRemote('https://github.com/Acme/Web.git'), { scheme: 'https', host: 'github.com', path: 'Acme/Web', origin: 'https://github.com' }, 'https');
  eq(parseRemote('https://user@git.corp.local:8443/team/sub/app'), { scheme: 'https', host: 'git.corp.local', path: 'team/sub/app', origin: 'https://git.corp.local:8443' }, 'https 带端口与用户名');
  eq(parseRemote('git@github.com:acme/web.git').scheme, 'ssh', 'scp 形式');
  eq(parseRemote('ssh://git@gitlab.example.com:2222/g/r.git').path, 'g/r', 'ssh://');
  eq(parseRemote('C:/work/repo').scheme, 'local', 'Windows 盘符是本机路径');
  eq(parseRemote('/srv/git/r.git').scheme, 'local', '本机路径');
  assert(globMatch('acme/*', 'ACME/web') && globMatch('*', 'x/y') && !globMatch('acme/*', 'other/web') && globMatch('acme/web', 'acme/web'), '适用范围：组织通配、全部、精确，大小写不敏感');
}

// ── 公用的库与成员 ──
const db = openDb(':memory:');
const lead = ensureOwner(db, '管理员');
const jia = addUser(db, { name: '甲', role: 'member', byUserId: lead.userId });
const yi = addUser(db, { name: '乙', role: 'member', byUserId: lead.userId });
const watcher = addUser(db, { name: '丙', role: 'observer', byUserId: lead.userId });
const { privateKey: appPem, publicKey: appPub } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
// OpenSSH 私钥（只要结构对：magic + 加密算法名 + kdf + 1 把 + 公钥）
const sshKey = (cipher) => {
  const s = (b) => { const x = Buffer.from(b); const n = Buffer.alloc(4); n.writeUInt32BE(x.length); return Buffer.concat([n, x]); };
  const pub = Buffer.concat([s('ssh-ed25519'), s(Buffer.alloc(32, 3))]);
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), s(cipher), s(cipher === 'none' ? 'none' : 'bcrypt'), s(''), Buffer.from([0, 0, 0, 1]), s(pub), s('rest')]);
  return { text: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.toString('base64').replace(/(.{70})/g, '$1\n')}\n-----END OPENSSH PRIVATE KEY-----\n`, fp: `SHA256:${createHash('sha256').update(pub).digest('base64').replace(/=+$/, '')}` };
};

// ═══════════════════════════════════════════════════════════════════════════
section('③ 录入的规矩');
// ═══════════════════════════════════════════════════════════════════════════
{
  throwsLike(() => addCredential(db, { kind: 'token', name: 'x', secret: 'abc', byUserId: jia.userId }), /部署级连接只有管理员能加/, '成员加不了部署级连接');
  throwsLike(() => addCredential(db, { kind: 'token', name: 'x', ownerId: yi.userId, secret: 'abc', byUserId: jia.userId }), /只能给自己加/, '成员不能替别人加');
  throwsLike(() => addCredential(db, { kind: 'token', name: 'x', ownerId: watcher.userId, secret: 'abc', byUserId: lead.userId }), /旁观者/, '旁观者不能有连接');
  throwsLike(() => addCredential(db, { kind: 'token', name: 'x', ownerId: jia.userId, secret: 'ab c', byUserId: jia.userId }), /空格或换行/, '令牌里有空白：拒（粘多了）');
  throwsLike(() => addCredential(db, { kind: 'github_app', name: 'app', secret: appPem, byUserId: lead.userId }), /App ID/, 'App 没填 App ID：拒');
  throwsLike(() => addCredential(db, { kind: 'github_app', name: 'app', appId: '1', secret: 'not a key', byUserId: lead.userId }), /私钥读不出来/, 'App 私钥不对：拒');
  throwsLike(() => addCredential(db, { kind: 'ssh_key', name: 'k', secret: sshKey('aes256-ctr').text, byUserId: lead.userId }), /带口令/, '带口令的 SSH 密钥：拒（无人值守没法输口令）');
  const k = sshKey('none');
  const r = addCredential(db, { kind: 'ssh_key', name: '部署密钥', host: 'git.corp.local', secret: k.text, byUserId: lead.userId });
  assert(k.fp.startsWith(r.hint), `SSH 密钥的标识是公钥指纹（与 ssh-keygen -l 一致）：${r.hint}`);
  const t = addCredential(db, { kind: 'token', name: '甲的令牌', ownerId: jia.userId, secret: FAKE_TOKEN, pathGlob: 'acme/*', byUserId: jia.userId });
  eq(t.hint, '…zz91', '令牌只显示末 4 位');
  const au = db.all(`SELECT payload FROM audit_log WHERE action='credential_added'`).map((x) => x.payload).join('\n');
  assert(au.includes('甲的令牌') && !au.includes(FAKE_TOKEN), '审计记了录入，不含明文');
  const asYi = listCredentials(db, { viewerId: yi.userId, env: {} }).rows.map((x) => x.name);
  assert(asYi.includes('部署密钥') && !asYi.includes('甲的令牌'), '成员看得到部署级的、看不到别人的');
  assert(listCredentials(db, { viewerId: lead.userId, env: {} }).rows.some((x) => x.name === '甲的令牌'), '管理员看得到全部');
  assert(!JSON.stringify(listCredentials(db, { viewerId: lead.userId, env: { GITHUB_TOKEN: FAKE_TOKEN } })).includes(FAKE_TOKEN), '列表（含 .env 那一条）不含明文');
  throwsLike(() => revokeCredential(db, { id: t.id, byUserId: yi.userId }), /管理员或连接的主人/, '别人吊销不了');
  revokeCredential(db, { id: r.id, byUserId: lead.userId });
}

// ═══════════════════════════════════════════════════════════════════════════
section('④ 解析顺序');
// ═══════════════════════════════════════════════════════════════════════════
{
  const R = (o) => resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'push', env: {}, fetchFn: async () => { throw new Error('不该调'); }, ...o });
  let r = await R({ actorId: jia.userId });
  eq(r.credential?.name, '甲的令牌', '甲点的交付：用甲自己的');
  assert(/AUTHORIZATION: basic /.test(r.gitEnv.GIT_CONFIG_VALUE_0) && r.gitEnv.GIT_CONFIG_KEY_0 === 'http.https://github.com/.extraheader', '令牌只进子进程环境变量（http.extraheader）');
  eq(Buffer.from(r.gitEnv.GIT_CONFIG_VALUE_0.split(' ').pop(), 'base64').toString(), `x-access-token:${FAKE_TOKEN}`, 'GitHub 令牌按 x-access-token 发');
  eq(r.apiToken, FAKE_TOKEN, 'GitHub 上同一份令牌也用于开 PR');
  r = await R({ actorId: yi.userId });
  eq(r.credential, null, '乙点的交付：不借用甲的令牌');
  assert(r.tried.some((x) => x.name === '甲的令牌' && /别人的连接/.test(x.why)), '说清楚为什么没用甲的');
  r = await R({ actorId: yi.userId, env: { GITHUB_TOKEN: 'ghp_envtoken' } });
  eq([r.credential?.name, r.credential?.fromEnv], ['GITHUB_TOKEN（.env）', true], '老部署：.env 的 GITHUB_TOKEN 兜底');
  const dep = addCredential(db, { kind: 'token', name: '部署令牌', secret: 'ghp_deploy', byUserId: lead.userId });
  r = await R({ actorId: yi.userId, env: { GITHUB_TOKEN: 'ghp_envtoken' } });
  eq(r.credential?.name, '部署令牌', '库里的部署令牌排在 .env 前面');
  r = await resolveCredential(db, { remote: 'https://github.com/other/x.git', action: 'push', actorId: jia.userId, env: {} });
  eq(r.credential?.name, '部署令牌', '甲的令牌范围是 acme/*：other/x 用部署令牌');
  assert(r.tried.some((x) => x.name === '甲的令牌' && /适用范围/.test(x.why)), '范围不含：说清楚');
  r = await resolveCredential(db, { remote: 'git@github.com:acme/web.git', action: 'push', actorId: jia.userId, env: {} });
  eq(r.credential, null, 'ssh 地址不用令牌');
  assert(r.tried.every((x) => /https|别人/.test(x.why)), '说清楚令牌只用于 https');
  r = await resolveCredential(db, { remote: 'http://github.com/acme/web.git', action: 'push', actorId: jia.userId, env: {} });
  eq(r.credential, null, '明文 http 不发令牌');
  r = await resolveCredential(db, { remote: join(TMP, 'x.git'), action: 'push', actorId: null, env: {} });
  eq([r.target.scheme, r.credential], ['local', null], '本机路径：不用连接（系统动作也行）');
  await rejectsLike(resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'push', actorId: null, env: {} }), /只能读/, '系统自己发起的推送：拒');
  r = await resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'read', actorId: null, env: {} });
  eq(r.credential?.name, '部署令牌', '系统自己读：只用部署级的');
  db.run(`UPDATE credentials SET expires_at=? WHERE id=?`, now() - 1, dep.id);
  r = await R({ actorId: yi.userId });
  assert(r.credential === null && r.tried.some((x) => x.name === '部署令牌' && /过期/.test(x.why)), '过期的跳过并说明');
  eq(expiringCredentials(db, { userId: lead.userId }).map((x) => [x.name, x.expired]), [['部署令牌', true]], '管理员的到期提醒里有它');
  const dg = buildDigest(db, { userId: lead.userId });
  assert(dg.credentialsExpiring.length === 1 && dg.actionable >= 1 && /快到期的连接/.test(renderDigest(dg)), '进管理员的待办摘要（算一件要做的事）');
  eq(buildDigest(db, { userId: yi.userId }).credentialsExpiring, [], '成员的摘要里没有部署级连接的提醒');
  revokeCredential(db, { id: dep.id, byUserId: lead.userId });
  r = await R({ actorId: yi.userId });
  assert(!r.tried.some((x) => x.name === '部署令牌'), '吊销的不再参与');
}

// ═══════════════════════════════════════════════════════════════════════════
section('⑤ GitHub App');
// ═══════════════════════════════════════════════════════════════════════════
const app = addCredential(db, { kind: 'github_app', name: 'acme App', appId: '424242', secret: appPem, pathGlob: 'acme/*', byUserId: lead.userId });
const calls = [];
let installed = true;
const fakeApi = async (url, init = {}) => {
  calls.push({ url, init });
  const jwt = String(init.headers?.authorization ?? '').replace(/^Bearer /, '');
  if (url.endsWith('/installation')) return installed ? { ok: true, status: 200, json: async () => ({ id: 99 }) } : { ok: false, status: 404, json: async () => ({}) };
  if (/\/app\/installations\/99\/access_tokens$/.test(url)) {
    const body = JSON.parse(init.body);
    if (body.permissions.workflows && !fakeApi.allowWorkflows) return { ok: false, status: 422, json: async () => ({}) };
    return { ok: true, status: 201, json: async () => ({ token: `ghs_inst_${calls.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }), jwt };
  }
  if (url.endsWith('/pulls')) return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/acme/web/pull/1', number: 1 }) };
  return { ok: true, status: 200, json: async () => ({ default_branch: 'main' }) };
};
{
  eq(appPermissions('read'), { contents: 'read', metadata: 'read' }, '读：只要 contents:read');
  eq(appPermissions('pr'), { contents: 'write', metadata: 'read', pull_requests: 'write' }, '开 PR：contents + pull_requests 写');
  const r = await resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'pr', actorId: yi.userId, env: {}, fetchFn: fakeApi });
  eq([r.credential?.name, r.credential?.kind], ['acme App', 'github_app'], '乙没有自己的连接：用 App');
  const [inst, mint] = calls;
  assert(inst.url === 'https://api.github.com/repos/acme/web/installation', '按仓库查安装');
  const [h, p, sig] = String(inst.init.headers.authorization).replace('Bearer ', '').split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), appPub, Buffer.from(sig, 'base64url')), 'JWT 用 App 私钥签（RS256），公钥验得过');
  assert(payload.iss === '424242' && payload.exp - payload.iat <= 600, 'iss = App ID，有效期不超过 10 分钟');
  eq(JSON.parse(mint.init.body), { repositories: ['web'], permissions: { contents: 'write', metadata: 'read', pull_requests: 'write' } }, '安装令牌只覆盖这一个仓库、按动作要权限');
  assert(r.apiToken?.startsWith('ghs_inst_') && Buffer.from(r.gitEnv.GIT_CONFIG_VALUE_0.split(' ').pop(), 'base64').toString().startsWith('x-access-token:ghs_inst_'), '推送与 API 都用安装令牌');
  const n = calls.length;
  await resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'pr', actorId: yi.userId, env: {}, fetchFn: fakeApi });
  eq(calls.length, n, '一小时内同一仓库同一权限：用缓存的令牌，不再签');
  clearAppCache(); installed = false;
  const r2 = await resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'push', actorId: yi.userId, env: { GITHUB_TOKEN: 'ghp_envtoken' }, fetchFn: fakeApi });
  assert(r2.credential?.fromEnv && r2.tried.some((x) => x.name === 'acme App' && /没装在 acme\/web/.test(x.why)), 'App 没装在这个仓库上：跳过、说清楚去哪装，退到下一份');
  installed = true; clearAppCache();
  setSetting(db, { key: 'deploy.credential_order', value: 'app_first', userId: lead.userId });
  const r3 = await resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'push', actorId: jia.userId, env: {}, fetchFn: fakeApi });
  eq(r3.credential?.name, 'acme App', 'app_first：甲有自己的令牌也先用 App');
  setSetting(db, { key: 'deploy.credential_order', value: 'personal_first', userId: lead.userId });
  const r4 = await resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'push', actorId: yi.userId, workflows: true, env: {}, fetchFn: fakeApi });
  assert(r4.credential === null && r4.tried.some((x) => /Workflows|workflows:write/.test(x.why) && /接受新权限/.test(x.why)), 'App 没有 workflows 权限：说清楚去 App 设置里加、再到安装页接受');
  // App 排在部署级令牌前面（原来排最后，老部署 .env / 部署令牌在时 App 永远轮不到）
  clearAppCache();
  const dep2 = addCredential(db, { kind: 'token', name: '部署令牌二', secret: 'ghp_dep2', byUserId: lead.userId });
  eq((await resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'push', actorId: yi.userId, env: { GITHUB_TOKEN: 'ghp_envtoken' }, fetchFn: fakeApi })).credential?.name,
    'acme App', '本人没有连接：App 先于部署级令牌与 .env');
  // 同一档里几份都匹配：范围更具体的先，再新加的先
  const y1 = addCredential(db, { kind: 'token', name: '乙·全部', ownerId: yi.userId, secret: 'ghp_y1', byUserId: yi.userId, at: now() - 1000 });
  const y2 = addCredential(db, { kind: 'token', name: '乙·只 web', ownerId: yi.userId, secret: 'ghp_y2', pathGlob: 'acme/web', byUserId: yi.userId, at: now() - 2000 });
  eq((await resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'push', actorId: yi.userId, env: {}, fetchFn: fakeApi })).credential?.name, '乙·只 web', '同档：acme/web 先于 *（哪怕它更早加）');
  const y3 = addCredential(db, { kind: 'token', name: '乙·全部（新）', ownerId: yi.userId, secret: 'ghp_y3', byUserId: yi.userId });
  eq((await resolveCredential(db, { remote: 'https://github.com/acme/other.git', action: 'push', actorId: yi.userId, env: {}, fetchFn: fakeApi })).credential?.name, '乙·全部（新）', '范围一样：新加的先（换令牌时先加新的、再吊销旧的）');
  for (const c of [y1, y2, y3, dep2]) revokeCredential(db, { id: c.id, byUserId: lead.userId });
  // SSH 远端开 PR：SSH 管推送，开 PR 另按 https 地址取一份能调接口的（这里是 App）
  const sk = addCredential(db, { kind: 'ssh_key', name: '部署密钥', secret: sshKey('none').text, byUserId: lead.userId });
  const rs = await resolveCredential(db, { remote: 'git@github.com:acme/web.git', action: 'pr', actorId: yi.userId, env: {}, fetchFn: fakeApi });
  assert(rs.credential?.name === '部署密钥' && /GIT_SSH_COMMAND/.test(Object.keys(rs.gitEnv).join(',')) && rs.apiToken?.startsWith('ghs_inst_') && rs.apiCredential?.name === 'acme App', 'SSH 推送 + App 开 PR');
  rs.cleanup();
  revokeCredential(db, { id: sk.id, byUserId: lead.userId });
}

// ═══════════════════════════════════════════════════════════════════════════
section('⑥ 推送护栏');
// ═══════════════════════════════════════════════════════════════════════════
const repo = (name) => {
  const ws = join(TMP, `${name}-ws`);
  git(TMP, 'init', '-q', '-b', 'main', ws);
  writeFileSync(join(ws, 'a.txt'), '1\n'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'base');
  const bare = join(TMP, `${name}.git`); git(TMP, 'init', '-q', '--bare', '-b', 'main', bare);
  return { ws, bare };
};
const refusals = () => db.all(`SELECT json_extract(payload,'$.rule') r FROM audit_log WHERE action='push_refused' ORDER BY id`).map((x) => x.r);
{
  const { ws, bare } = repo('g1');
  const env = { ...process.env };
  throwsLike(() => pushBranch(db, { dir: ws, remote: bare, src: 'HEAD', branch: 'main', env, actorId: jia.userId }), /只往远端推它自己的分支/, '不推 main');
  throwsLike(() => pushBranch(db, { dir: ws, remote: bare, src: 'HEAD', branch: 'feature/x', env, actorId: jia.userId }), /只往远端推它自己的分支/, '不推别的分支名');
  throwsLike(() => pushBranch(db, { dir: ws, remote: bare, src: 'HEAD', branch: '+v0/x', env }), /分支名不对/, '分支名不许带 refspec 的 + :');
  eq(git(bare, 'for-each-ref').trim(), '', '远端没被碰过');
  pushInitialDefault(db, { dir: ws, remote: bare, src: 'HEAD', branch: 'main', env, actorId: jia.userId });
  eq(git(bare, 'rev-parse', 'refs/heads/main'), git(ws, 'rev-parse', 'HEAD'), '空仓库：允许把起点推成默认分支');
  throwsLike(() => pushInitialDefault(db, { dir: ws, remote: bare, src: 'HEAD', branch: 'main', env, actorId: jia.userId }), /已经有分支了/, '不空了就不再推默认分支');
  git(ws, 'checkout', '-q', '-b', 'v0/t1'); writeFileSync(join(ws, 'a.txt'), '2\n'); git(ws, 'commit', '-qam', 'work');
  pushBranch(db, { dir: ws, remote: bare, src: 'HEAD', branch: 'v0/t1', env, actorId: jia.userId });
  eq(git(bare, 'rev-parse', 'refs/heads/v0/t1'), git(ws, 'rev-parse', 'HEAD'), '自己的任务分支：推上去');
  // 别人往远端的 v0/t1 上推了一个提交；本地改写历史后再推 → 拒，远端不动
  const other = join(TMP, 'g1-other'); git(TMP, 'clone', '-q', '-b', 'v0/t1', bare, other);
  writeFileSync(join(other, 'b.txt'), 'x\n'); git(other, 'add', '-A'); git(other, 'commit', '-qm', 'someone else'); git(other, 'push', '-q', 'origin', 'v0/t1');
  const theirs = git(bare, 'rev-parse', 'refs/heads/v0/t1');
  git(ws, 'commit', '-q', '--amend', '-m', 'rewritten');
  throwsLike(() => pushBranch(db, { dir: ws, remote: bare, src: 'HEAD', branch: 'v0/t1', env, actorId: jia.userId }), /不强推/, '远端有这里没有的提交：不强推、说清楚');
  eq(git(bare, 'rev-parse', 'refs/heads/v0/t1'), theirs, '别人的提交还在');
  // 默认分支碰巧叫 v0/… 也不推
  git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/v0/t1');
  throwsLike(() => pushBranch(db, { dir: ws, remote: bare, src: 'HEAD', branch: 'v0/t1', env, actorId: jia.userId }), /默认分支/, '远端默认分支：不推（哪怕名字对得上前缀）');
  eq(refusals(), ['prefix', 'prefix', 'bootstrap_not_empty', 'non_fast_forward', 'default_branch'], '每次拒绝都有审计 push_refused（带规则）');
  // 系统自己的本机项目仓库：不受前缀 / 默认分支的约束（行为与改动前一致）
  const own = repo('g1-own');
  pushBranch(db, { dir: ws, remote: own.bare, src: 'HEAD', branch: 'main', env, internal: true });
  eq(git(own.bare, 'rev-parse', 'refs/heads/main'), git(ws, 'rev-parse', 'HEAD'), 'internal（本机项目仓库）不受前缀约束');
}
{
  // GitHub 拒绝"App 改工作流"：带上 workflows 权限重签一次再推。用 pre-receive 钩子模拟：第一次拒、之后放行
  const { ws, bare } = repo('g2');
  const marker = join(TMP, 'g2-once').replace(/\\/g, '/');
  writeFileSync(join(bare, 'hooks', 'pre-receive'), `#!/bin/sh\nif [ ! -f "${marker}" ]; then touch "${marker}"; echo "refusing to allow a GitHub App to create or update workflow .github/workflows/ci.yml without workflows permission" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
  git(ws, 'checkout', '-q', '-b', 'v0/wf');
  git(ws, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/acme/wf.git');
  calls.length = 0; clearAppCache(); fakeApi.allowWorkflows = true;
  const conn = await connectAndPush(db, { dir: ws, remote: 'https://github.com/acme/wf.git', src: 'HEAD', branch: 'v0/wf', action: 'push', actorId: yi.userId, env: process.env, fetchFn: fakeApi });
  const mints = calls.filter((c) => c.url.endsWith('/access_tokens')).map((c) => JSON.parse(c.init.body).permissions.workflows ?? null);
  eq(mints, [null, 'write'], '第一次不要 workflows；被拒后带上 workflows 权限重签');
  eq(git(bare, 'rev-parse', 'refs/heads/v0/wf'), git(ws, 'rev-parse', 'HEAD'), '重签后推上去了');
  conn.cleanup();
}
{
  // 挑中的连接推不上去（权限不够）：跳过它、换下一份（原来一份范围填宽了的个人令牌会把主人的交付全卡死）
  const { ws, bare } = repo('g3');
  const marker = join(TMP, 'g3-once').replace(/\\/g, '/');
  writeFileSync(join(bare, 'hooks', 'pre-receive'), `#!/bin/sh\nif [ ! -f "${marker}" ]; then touch "${marker}"; echo "Permission to acme/g3.git denied to yi-bot." >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
  git(ws, 'checkout', '-q', '-b', 'v0/g3');
  git(ws, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/acme/g3.git');
  const narrow = addCredential(db, { kind: 'token', name: '乙·只授权了别的仓库', ownerId: yi.userId, secret: 'ghp_narrow', byUserId: yi.userId });
  clearAppCache(); fakeApi.allowWorkflows = false;
  const conn = await connectAndPush(db, { dir: ws, remote: 'https://github.com/acme/g3.git', src: 'HEAD', branch: 'v0/g3', action: 'push', actorId: yi.userId, env: {}, fetchFn: fakeApi });
  eq(conn.credential?.name, 'acme App', '本人的令牌推不上去：换到下一份（App）推上去了');
  assert(conn.tried.some((x) => x.name === '乙·只授权了别的仓库' && /推不上去/.test(x.why)), '说清楚跳过了哪份、为什么');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='credential_push_failed' AND target_id=?`, narrow.id).n, 1, '审计 credential_push_failed');
  eq(git(bare, 'rev-parse', 'refs/heads/v0/g3'), git(ws, 'rev-parse', 'HEAD'), '分支到了远端');
  conn.cleanup();
  revokeCredential(db, { id: narrow.id, byUserId: yi.userId });
}

// ═══════════════════════════════════════════════════════════════════════════
section('⑦ 端到端：交付用库里的连接，全库没有明文');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { ws, bare } = repo('e2e');
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'改登录页','done',?)`, taskId, jia.userId, t);
  git(ws, 'checkout', '-q', '-b', `v0/${taskId}`); writeFileSync(join(ws, 'a.txt'), '3\n'); git(ws, 'commit', '-qam', 'agent');
  git(ws, 'config', `url.${bare.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/acme/web.git');
  calls.length = 0;
  const r = await deliverTask(db, { taskId, workspace: ws, remote: 'https://github.com/acme/web.git', pr: true, userId: jia.userId, env: {}, fetchFn: fakeApi });
  eq(r.credential?.name, '甲的令牌', '甲点交付：用甲自己的连接');
  eq(calls.find((c) => c.url.endsWith('/pulls'))?.init.headers.authorization, `Bearer ${FAKE_TOKEN}`, '开 PR 用同一份连接');
  eq(r.pr?.url, 'https://github.com/acme/web/pull/1', 'PR 开了');
  const pl = JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='task_delivered' AND target_id=?`, taskId).payload);
  eq(pl.credential?.name, '甲的令牌', '审计记下用的是哪一份连接、谁的');
  const dump = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map(({ name }) => JSON.stringify(db.all(`SELECT * FROM "${name}"`))).join('\n');
  assert(!dump.includes(FAKE_TOKEN) && !dump.includes('ghs_inst_') && !dump.includes('BEGIN PRIVATE KEY'), '全库（每张表）没有令牌、安装令牌、私钥的明文');
  // 成员停用 → 他自己的连接一并吊销
  eq(revokeCredentialsOf(db, { userId: jia.userId }), 1, '停用时吊销他自己的连接');
  const r2 = await resolveCredential(db, { remote: 'https://github.com/acme/web.git', action: 'push', actorId: jia.userId, env: {}, fetchFn: fakeApi });
  eq(r2.credential?.name, 'acme App', '之后退到部署级的 App');
}

// ═══════════════════════════════════════════════════════════════════════════
section('⑦′ 项目交付：空仓库起步只在 GitHub + 开 PR 时做');
// ═══════════════════════════════════════════════════════════════════════════
{
  const mk = (name) => {
    const { ws, bare } = repo(name);
    const pj = newId('pj');
    git(ws, 'checkout', '-q', '-b', `superintern/${pj}`); writeFileSync(join(ws, 'a.txt'), 'p\n'); git(ws, 'commit', '-qam', 'merged task');
    git(ws, 'checkout', '-q', 'main');
    db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'小项目',?,?,'main','done',?)`, pj, yi.userId, ws, `superintern/${pj}`, now());
    return { ws, bare, pj };
  };
  const { deliverProject } = await import('../src/core/project.mjs');
  const a = mk('pa');
  git(a.ws, 'config', `url.${a.bare.replace(/\\/g, '/')}.insteadOf`, 'https://github.com/acme/proj.git');
  calls.length = 0; clearAppCache();
  const r = await deliverProject(db, { projectId: a.pj, remote: 'https://github.com/acme/proj.git', pr: true, userId: yi.userId, env: {}, fetchFn: fakeApi });
  eq(r.basePushed, { branch: 'main', head: 'main' }, 'GitHub 空仓库 + 开 PR：先把起点推成默认分支');
  eq([git(a.bare, 'rev-parse', 'refs/heads/main'), git(a.bare, 'rev-parse', `refs/heads/superintern/${a.pj}`)], [git(a.ws, 'rev-parse', 'main'), git(a.ws, 'rev-parse', `superintern/${a.pj}`)], '起点与项目分支都到了远端');
  assert(r.pr?.url && r.credential?.name === 'acme App', '开了 PR，用的是 App');
  const b = mk('pb');
  const r2 = await deliverProject(db, { projectId: b.pj, remote: b.bare, pr: true, userId: yi.userId, env: {}, fetchFn: fakeApi });
  eq([r2.basePushed, git(b.bare, 'for-each-ref', '--format=%(refname)')], [null, `refs/heads/superintern/${b.pj}`], '非 GitHub 远端：开不了 PR，就不往默认分支推起点');
}

// ═══════════════════════════════════════════════════════════════════════════
section('⑧ 预检');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { bare } = repo('pf');
  const c = await checkAccess(db, { remote: bare, action: 'push', actorId: yi.userId, env: process.env });
  eq([c.local, c.canRead, c.canPush], [true, true, true], '本机裸库：能读、能推（dry-run，不碰真分支）');
  eq(git(bare, 'for-each-ref').trim(), '', 'dry-run 没在远端留下任何分支');
  const c2 = await checkAccess(db, { remote: join(TMP, 'nope.git'), action: 'push', actorId: yi.userId, env: process.env });
  eq(c2.canRead, false, '不存在的远端：读不了，带上 git 的原话');
}

// ═══════════════════════════════════════════════════════════════════════════
section('⑨ 棘轮：只有 push.mjs 调 git push');
// ═══════════════════════════════════════════════════════════════════════════
{
  const hits = [];
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) { if (e !== 'i18n') walk(p); continue; } if (!e.endsWith('.mjs')) continue;
    const rel = p.slice(ROOT.length + 1).split('\\').join('/');
    readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (/['"]push['"]\s*,\s*['"]--/.test(l) && rel !== 'src/core/push.mjs' && !(rel === 'src/core/credentials.mjs' && l.includes('--dry-run'))) hits.push(`${rel}:${i + 1}`); }); } };
  walk(join(ROOT, 'src'));
  eq(hits, [], 'src/ 里推送只走 core/push.mjs（预检的 --dry-run 除外）');
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
