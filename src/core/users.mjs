// 用户与通知通道：负责人加人、发令牌；每人挂自己的通道；事项创建后按收件人各发各的。
//
// 令牌明文只在签发那一刻返回一次，库里只有哈希（与 ensureOwner 同一规矩）。CLI 把它写进文件不打印；看板把它显示一次。
// 通知按人：user_channels。旁观者不收通知 —— 解析器根本不把旁观者放进收件人。

import { newId, now, audit, sha256 } from '../db/db.mjs';
import { insertUser, updateUser, revokeTokens } from '../db/users.mjs';
import { issueToken } from './sessions.mjs';
import { notify, channelsFromEnv } from './notify.mjs';
import { responsibilitiesOf, responsibilitiesText } from './handover.mjs';
import { DECISION_TYPES } from './routing.mjs';
import { questionsToNotify, markNotified } from './questions.mjs';
import { projectsToDeliver } from './delivery-due.mjs';
import { tl, contentLang, I18nError, CATALOGS, N_ } from '../i18n/index.mjs';

export const ROLES = ['lead', 'member', 'observer'];
/** user_channels.channel 的 CHECK 值 → notify.mjs 的通道种类。 */
const CHANNEL_KIND = { ntfy: 'ntfy', lark: 'feishu', dingtalk: 'dingtalk', wecom: 'wecom' };
const KIND_CHANNEL = { ntfy: 'ntfy', feishu: 'lark', lark: 'lark', dingtalk: 'dingtalk', wecom: 'wecom' };

export function addUser(db, { name, role, tags = [], byUserId }) {
  const display = String(name ?? '').trim();
  if (!display) throw new I18nError('名称不能为空');
  if (!['member', 'observer'].includes(role)) throw new I18nError('角色只能是成员（member）或旁观者（observer）；管理员角色请在添加后由管理员授予');
  if (db.one(`SELECT id FROM users WHERE display_name=?`, display)) throw new I18nError('名称 {name} 已被使用', { name: display });
  const id = newId('u');
  const t = now();
  return db.tx(() => {
    insertUser(db, { id, displayName: display, role, domainTags: [].concat(tags).map(String).filter(Boolean), createdAt: t });
    const { tokenId, plaintext, expiresAt } = issueToken(db, { userId: id, by: byUserId, name: N_('管理员添加时签发'), at: t });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_added', targetType: 'user', targetId: id, payload: { name: display, role, tags, tokenId, expiresAt } });
    return { userId: id, tokenId, plaintext, expiresAt };
  });
}

export function listUsers(db) {
  return db.all(`SELECT u.id, u.display_name, u.role, u.domain_tags, u.created_at, u.disabled_at,
                        (SELECT count(*) FROM user_channels c WHERE c.user_id=u.id AND c.enabled=1) AS channels,
                        (SELECT count(*) FROM tokens t WHERE t.user_id=u.id AND t.revoked_at IS NULL) AS tokens
                 FROM users u ORDER BY (u.disabled_at IS NOT NULL), CASE u.role WHEN 'lead' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, u.created_at`)
    .map((u) => ({ ...u, domain_tags: JSON.parse(u.domain_tags || '[]') }));
}

/** 通道地址可能带密钥（webhook URL）：对外只给种类与主机名，与审计同一规矩。 */
export function channelHost(target) {
  try { return new URL(String(target)).host || null; } catch { return null; }
}
const KIND_LABEL = { ntfy: 'ntfy', lark: 'feishu', dingtalk: 'dingtalk', wecom: 'wecom' };

/**
 * 成员设置页 / `user list` 用的完整视图：每人的通道（种类 + 主机名）、令牌状态、名下还没了结的责任。
 * 没有任何明文令牌或通道地址。
 */
export function usersView(db) {
  return listUsers(db).map((u) => {
    const resp = responsibilitiesOf(db, u.id, { all: true });
    const tk = db.one(`SELECT max(issued_at) AS issued_at FROM tokens WHERE user_id=? AND revoked_at IS NULL`, u.id);
    const gi = db.one(`SELECT github_login, commit_email, github_id FROM users WHERE id=?`, u.id);
    return { id: u.id, name: u.display_name, role: u.role, tags: u.domain_tags, createdAt: u.created_at, disabledAt: u.disabled_at ?? null,
      github: gi?.github_login ?? null, commitEmail: gi?.commit_email ?? null, githubBound: gi?.github_id != null,
      tokens: u.tokens, tokenIssuedAt: tk?.issued_at ?? null,
      channels: db.all(`SELECT channel, target FROM user_channels WHERE user_id=? AND enabled=1 ORDER BY priority, channel`, u.id).map((c) => ({ kind: KIND_LABEL[c.channel] ?? c.channel, host: channelHost(c.target) })),
      responsibilities: { projects: resp.projects.length, soloTasks: resp.soloTasks.length, routingRows: resp.routing.length, routingKeys: new Set(resp.routing.map((r) => r.project_id)).size,
        duty: resp.duty.length, questions: resp.questions.length, count: resp.count, text: responsibilitiesText(resp, contentLang(db)) } };
  });
}

const mustUser = (db, userId) => db.one(`SELECT id, display_name, role, kind, disabled_at FROM users WHERE id=?`, userId) ?? (() => { throw new I18nError('成员不存在：{id}', { id: userId }); })();
// 决策类型名（DECISION_TYPES 的 label 是中文原文）按语言取；目录里没有就原样
const labelIn = (lang, s) => CATALOGS[lang]?.[s] ?? s;

/**
 * 改角色（调用方保证操作者是管理员）。角色是部署级的，与负责哪些项目 / 任务无关：
 * 管理员可直接授予与收回，只保"至少一位未停用的管理员"；**降为旁观者前不能有未结职责**
 * （旁观者不会被解析成接收人，也不能当负责人 —— 点名他的路由行会变成没人接）。
 */
export function setUserRole(db, { userId, role, byUserId }) {
  if (!ROLES.includes(role)) throw new I18nError('角色无效：{role}（应为 {roles}）', { role, roles: ROLES.join(' / ') });
  return db.tx(() => {
    const u = mustUser(db, userId);
    if (u.disabled_at) throw new I18nError('{name} 已停用，请先启用再修改角色', { name: u.display_name });
    if (u.role === role) return { userId, role, changed: false };
    // 服务账户与人分开：它不能登录看板，当管理员（负责人）就成了一个没人能替它拍板的负责人
    if (u.kind === 'service' && role === 'lead') throw new I18nError('服务账户不能当管理员');
    const resp = responsibilitiesOf(db, userId, { all: true });
    if (u.role === 'lead' && !db.one(`SELECT id FROM users WHERE role='lead' AND disabled_at IS NULL AND id<>?`, userId)) throw new I18nError('不能更改最后一位管理员的角色');
    if (role === 'observer' && resp.count) {
      const L = contentLang(db);
      const rows = resp.routing.map((r) => `${r.project_id ? tl(L, '项目「{title}」', { title: db.one(`SELECT title FROM projects WHERE id=?`, r.project_id)?.title ?? r.project_id }) : tl(L, '默认决策路由')} / ${labelIn(L, DECISION_TYPES[r.decision_type]?.label ?? r.decision_type)} / ${tl(L, '{scope} 顺位 {position}', { scope: r.scope, position: r.position })}`);
      throw new I18nError('旁观者不能作为接收人，而 {name} {what}{rows}。请先交接，或先调整决策路由', { name: u.display_name, what: responsibilitiesText(resp, L),
        rows: rows.length ? tl(L, '（{list}{more}）', { list: rows.slice(0, 6).join(tl(L, '；')), more: rows.length > 6 ? ' …' : '' }) : '' });
    }
    updateUser(db, userId, { role });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_role_set', targetType: 'user', targetId: userId, payload: { from: u.role, to: role } });
    return { userId, role, changed: true };
  }, { immediate: true });
}

export function renameUser(db, { userId, name, byUserId }) {
  const display = String(name ?? '').trim();
  if (!display) throw new I18nError('名称不能为空');
  return db.tx(() => {
    const u = mustUser(db, userId);
    if (u.display_name === display) return { userId, name: display, changed: false };
    if (db.one(`SELECT id FROM users WHERE display_name=? AND id<>?`, display, userId)) throw new I18nError('名称 {name} 已被使用', { name: display });
    updateUser(db, userId, { displayName: display });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_renamed', targetType: 'user', targetId: userId, payload: { from: u.display_name, to: display } });
    return { userId, name: display, changed: true };
  }, { immediate: true });
}

/** 重发令牌：旧的全部吊销、签发一枚新的。明文只在这里返回一次。 */
export function reissueToken(db, { userId, byUserId }) {
  const t = now();
  return db.tx(() => {
    const u = mustUser(db, userId);
    if (u.disabled_at) throw new I18nError('{name} 已停用，请先启用再重新生成令牌', { name: u.display_name });
    const revoked = revokeTokens(db, userId, t);
    const { tokenId, plaintext, expiresAt } = issueToken(db, { userId, by: byUserId, name: N_('管理员重发'), kind: u.kind === 'service' ? 'service' : 'cli', at: t });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'token_reissued', targetType: 'user', targetId: userId, payload: { tokenId, revoked, expiresAt } });
    return { userId, tokenId, plaintext, revoked, expiresAt };
  }, { immediate: true });
}

export function removeUserChannel(db, { userId, kind, byUserId }) {
  const ch = KIND_CHANNEL[kind];
  if (!ch) throw new I18nError('通知通道无效：{kind}（应为 ntfy / feishu / dingtalk / wecom）', { kind });
  mustUser(db, userId);
  return db.tx(() => {
    const n = Number(db.run(`DELETE FROM user_channels WHERE user_id=? AND channel=?`, userId, ch).changes);
    if (!n) throw new I18nError('该成员未配置 {kind} 通知通道', { kind });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_channel_removed', targetType: 'user', targetId: userId, payload: { channel: ch } });
    return { removed: n };
  });
}

export function setUserTags(db, { userId, tags, byUserId }) {
  if (!db.one(`SELECT id FROM users WHERE id=?`, userId)) throw new I18nError('成员不存在：{id}', { id: userId });
  updateUser(db, userId, { domainTags: [].concat(tags).map(String).filter(Boolean) });
  audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_tags_set', targetType: 'user', targetId: userId, payload: { tags } });
}

/**
 * 成员的 GitHub 账号与提交邮箱（提交 trailer、PR 溯源表、可选的 Co-authored-by）。本人或管理员可改；给 null / 空串 = 清掉。
 * 只核格式，不联网核账号是否存在（GitHub 登录做好之后由登录那一步写入核过的账号）。
 */
export function setGitIdentity(db, { userId, github = undefined, email = undefined, byUserId }) {
  const u = mustUser(db, userId);
  const by = db.one(`SELECT role FROM users WHERE id=? AND disabled_at IS NULL`, byUserId);
  if (byUserId !== userId && by?.role !== 'lead') throw new I18nError('只能改自己的 GitHub 账号；改别人的要管理员');
  const gh = github === undefined ? undefined : (String(github ?? '').trim().replace(/^@/, '') || null);
  if (gh && !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(gh)) throw new I18nError('GitHub 账号格式不对：只能是字母、数字和单个连字符，最长 39 个字符（{v}）', { v: gh });
  const em = email === undefined ? undefined : (String(email ?? '').trim() || null);
  if (em && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(em)) throw new I18nError('提交邮箱格式不对：{v}', { v: em });
  if (gh && db.one(`SELECT id FROM users WHERE lower(github_login)=lower(?) AND id<>?`, gh, userId)) throw new I18nError('GitHub 账号 {v} 已经对应了另一位成员', { v: gh });
  // 换了账号就解绑 GitHub 登录（按数字 id 认人）：不然原来那个账号照样能以这个人的身份登录
  const old = db.one(`SELECT github_login, github_id FROM users WHERE id=?`, userId);
  const unbind = gh !== undefined && old?.github_id != null && (gh ?? '').toLowerCase() !== (old.github_login ?? '').toLowerCase();
  db.tx(() => {
    updateUser(db, userId, { githubLogin: gh, commitEmail: em, githubId: unbind ? null : undefined });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_git_identity_set', targetType: 'user', targetId: userId, payload: { github: gh === undefined ? undefined : gh ?? null, email: em === undefined ? undefined : !!em, byAdmin: by?.role === 'lead', ...(unbind ? { githubLoginUnbound: true } : {}) } });
  });
  return { userId, name: u.display_name, github: gh, email: em };
}

/** 挂一条通道。同种通道覆盖（一人一种一条）。URL 里可能带密钥：审计只记种类。 */
export function setUserChannel(db, { userId, kind, target, byUserId }) {
  const ch = KIND_CHANNEL[kind];
  if (!ch) throw new I18nError('通知通道无效：{kind}（应为 ntfy / feishu / dingtalk / wecom）', { kind });
  if (!db.one(`SELECT id FROM users WHERE id=?`, userId)) throw new I18nError('成员不存在：{id}', { id: userId });
  if (!String(target ?? '').trim()) throw new I18nError('通道地址不能为空');
  db.tx(() => {
    db.run(`DELETE FROM user_channels WHERE user_id=? AND channel=?`, userId, ch);
    db.run(`INSERT INTO user_channels (id,user_id,channel,target,priority,enabled) VALUES (?,?,?,?,100,1)`, newId('ch'), userId, ch, String(target).trim());
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_channel_set', targetType: 'user', targetId: userId, payload: { channel: ch } });
  });
}

/** 若干用户的通道（notify.mjs 形状），去重。 */
export function channelsForUsers(db, userIds) {
  const out = []; const seen = new Set();
  for (const uid of userIds) {
    // 已停用的人不收通知（他可能还留在某条已答过的开放事项的收件人里）
    for (const c of db.all(`SELECT c.channel, c.target FROM user_channels c JOIN users u ON u.id=c.user_id WHERE c.user_id=? AND c.enabled=1 AND u.disabled_at IS NULL ORDER BY c.priority`, uid)) {
      const kind = CHANNEL_KIND[c.channel]; if (!kind) continue;
      const k = `${kind}:${c.target}`; if (seen.has(k)) continue; seen.add(k);
      out.push({ kind, target: c.target, userId: uid });
    }
  }
  return out;
}

/**
 * 给还没通知过的开放事项发通知：收件人与知会人各自的通道 + 部署级通道（.env）。发过就标 notified_at。
 * 守护进程每轮调一次；没通道也标（不然每轮都重发到 .env 通道）。**不抛**。
 */
/**
 * 已达成、还没交付的项目：给负责人发一次通知（每个项目只发一次，审计 delivery_notified 去重）。
 * 交付不是事项（按钮动作），不走 notifyPendingQuestions；不单独通知的话，达成后负责人既没待办也没通知，交付就没人点。**不抛**。
 */
export async function notifyPendingDeliveries(db, { env = process.env, extraCmd = null, fetchFn = globalThis.fetch, spawn } = {}) {
  // 每有一批新合并只通知一次：这批合并之后已经通知过的不再发
  const due = projectsToDeliver(db).filter((p) => !db.one(`SELECT 1 FROM audit_log WHERE action='delivery_notified' AND target_id=? AND ts >= ?`, p.projectId, p.mergedMax))
    .map((p) => ({ id: p.projectId, title: p.title, owner_id: p.ownerId, again: p.again }));
  const sent = [];
  const L = contentLang(db);
  for (const p of due) {
    const channels = [...channelsForUsers(db, [p.owner_id]), ...channelsFromEnv(env, extraCmd)];
    let receipts = [];
    if (channels.length) {
      receipts = await notify(db, { taskId: null, kind: 'delivery', title: `[SuperIntern] ${tl(L, '项目已达成，等你交付：{title}', { title: String(p.title).slice(0, 40) })}`,
        text: tl(L, '项目「{title}」已确认达成，所有任务都已合进项目分支（还只在这套系统里）。\n到看板的项目页点「交付项目」，才会推到你们的代码仓库 —— 只能你亲自点，推出去收不回。', { title: p.title }), ref: `deliver:${p.id}`, channels, fetchFn, ...(spawn ? { spawn } : {}) });
      sent.push({ projectId: p.id, to: [p.owner_id], receipts });
    }
    audit(db, { actorKind: 'system', action: 'delivery_notified', targetType: 'project', targetId: p.id, payload: { to: p.owner_id, channels: channels.map((c) => c.kind) } });
  }
  return sent;
}

export async function notifyPendingQuestions(db, { env = process.env, extraCmd = null, fetchFn = globalThis.fetch, spawn } = {}) {
  // 只推还没推过的人：第一次推给全部收件人与知会人；之后换了人（转交、超时转下一行、全员弃权转负责人、交接），只补推新加进来的
  const due = questionsToNotify(db);
  const sent = [];
  const L = contentLang(db);
  for (const q of due) {
    const to = q.fresh;
    const personal = channelsForUsers(db, to);
    // 部署级通道（.env）：第一次推照旧带上；之后只在新加的人里有没配个人通道的时才带（不然那个人就谁也通知不到）
    const fallback = q.first || to.some((u) => !channelsForUsers(db, [u]).length);
    const channels = [...personal, ...(fallback ? channelsFromEnv(env, extraCmd) : [])];
    const lvl = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ'][q.level] ?? q.level;
    const title = `[SuperIntern] ${tl(L, '{what}：{title}', { what: q.decision_type === 'conflict' ? tl(L, '冲突事项') : q.decision_type === 'signoff' ? tl(L, '等你签收') : tl(L, '{lvl} 级问题在等你', { lvl }), title: String(q.title).slice(0, 40) })}`;
    const text = `${String(q.text).slice(0, 400)}\n\n${tl(L, '回答：node src/cli.mjs answer {id} "..."（任务 {taskId}）', { id: q.id, taskId: q.task_id })}`;
    if (channels.length) {
      const receipts = await notify(db, { taskId: q.task_id, kind: 'question', title, text, ref: q.id, channels, fetchFn, ...(spawn ? { spawn } : {}) });
      sent.push({ questionId: q.id, to, receipts });
    }
    markNotified(db, q.id, { to: q.all, at: now() });
  }
  return sent;
}
