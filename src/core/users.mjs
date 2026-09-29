// 用户与通知通道：负责人加人、发令牌；每人挂自己的通道；事项创建后按收件人各发各的。
//
// 令牌明文只在签发那一刻返回一次，库里只有哈希（与 ensureOwner 同一规矩）。CLI 把它写进文件不打印；看板把它显示一次。
// 通知按人：user_channels。旁观者不收通知 —— 解析器根本不把旁观者放进收件人。

import { randomBytes } from 'node:crypto';
import { newId, now, audit, sha256 } from '../db/db.mjs';
import { notify, channelsFromEnv } from './notify.mjs';
import { responsibilitiesOf, responsibilitiesText } from './handover.mjs';
import { DECISION_TYPES } from './routing.mjs';
import { projectsToDeliver } from './delivery-due.mjs';

export const ROLES = ['lead', 'member', 'observer'];
/** user_channels.channel 的 CHECK 值 → notify.mjs 的通道种类。 */
const CHANNEL_KIND = { ntfy: 'ntfy', lark: 'feishu', dingtalk: 'dingtalk', wecom: 'wecom' };
const KIND_CHANNEL = { ntfy: 'ntfy', feishu: 'lark', lark: 'lark', dingtalk: 'dingtalk', wecom: 'wecom' };

export function addUser(db, { name, role, tags = [], byUserId }) {
  const display = String(name ?? '').trim();
  if (!display) throw new Error('名称不能为空');
  if (!['member', 'observer'].includes(role)) throw new Error('角色只能是成员（member）或旁观者（observer）；管理员角色请在添加后由管理员授予');
  if (db.one(`SELECT id FROM users WHERE display_name=?`, display)) throw new Error(`名称 ${display} 已被使用`);
  const id = newId('u');
  const tokenId = newId('tk');
  const plaintext = randomBytes(24).toString('base64url');
  const t = now();
  db.tx(() => {
    db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,?,?,?)`, id, display, role, JSON.stringify([].concat(tags).map(String).filter(Boolean)), t);
    db.run(`INSERT INTO tokens (id,user_id,token_hash,issued_by,issued_at) VALUES (?,?,?,?,?)`, tokenId, id, sha256(plaintext), byUserId, t);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_added', targetType: 'user', targetId: id, payload: { name: display, role, tags, tokenId } });
  });
  return { userId: id, tokenId, plaintext };
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
    return { id: u.id, name: u.display_name, role: u.role, tags: u.domain_tags, createdAt: u.created_at, disabledAt: u.disabled_at ?? null,
      tokens: u.tokens, tokenIssuedAt: tk?.issued_at ?? null,
      channels: db.all(`SELECT channel, target FROM user_channels WHERE user_id=? AND enabled=1 ORDER BY priority, channel`, u.id).map((c) => ({ kind: KIND_LABEL[c.channel] ?? c.channel, host: channelHost(c.target) })),
      responsibilities: { projects: resp.projects.length, soloTasks: resp.soloTasks.length, routingRows: resp.routing.length, routingKeys: new Set(resp.routing.map((r) => r.project_id)).size,
        duty: resp.duty.length, questions: resp.questions.length, count: resp.count, text: responsibilitiesText(resp) } };
  });
}

const mustUser = (db, userId) => db.one(`SELECT id, display_name, role, disabled_at FROM users WHERE id=?`, userId) ?? (() => { throw new Error(`成员不存在：${userId}`); })();

/**
 * 改角色（调用方保证操作者是管理员）。角色是部署级的，与负责哪些项目 / 任务无关：
 * 管理员可直接授予与收回，只保"至少一位未停用的管理员"；**降为旁观者前不能有未结职责**
 * （旁观者不会被解析成接收人，也不能当负责人 —— 点名他的路由行会变成没人接）。
 */
export function setUserRole(db, { userId, role, byUserId }) {
  if (!ROLES.includes(role)) throw new Error(`角色无效：${role}（应为 ${ROLES.join(' / ')}）`);
  return db.tx(() => {
    const u = mustUser(db, userId);
    if (u.disabled_at) throw new Error(`${u.display_name} 已停用，请先启用再修改角色`);
    if (u.role === role) return { userId, role, changed: false };
    const resp = responsibilitiesOf(db, userId, { all: true });
    if (u.role === 'lead' && !db.one(`SELECT id FROM users WHERE role='lead' AND disabled_at IS NULL AND id<>?`, userId)) throw new Error('不能更改最后一位管理员的角色');
    if (role === 'observer' && resp.count) {
      const rows = resp.routing.map((r) => `${r.project_id ? `项目「${db.one(`SELECT title FROM projects WHERE id=?`, r.project_id)?.title ?? r.project_id}」` : '默认决策路由'} / ${DECISION_TYPES[r.decision_type]?.label ?? r.decision_type} / ${r.scope} 顺位 ${r.position}`);
      throw new Error(`旁观者不能作为接收人，而 ${u.display_name} ${responsibilitiesText(resp)}${rows.length ? `（${rows.slice(0, 6).join('；')}${rows.length > 6 ? ' …' : ''}）` : ''}。请先交接，或先调整决策路由`);
    }
    db.run(`UPDATE users SET role=? WHERE id=?`, role, userId);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_role_set', targetType: 'user', targetId: userId, payload: { from: u.role, to: role } });
    return { userId, role, changed: true };
  }, { immediate: true });
}

export function renameUser(db, { userId, name, byUserId }) {
  const display = String(name ?? '').trim();
  if (!display) throw new Error('名称不能为空');
  return db.tx(() => {
    const u = mustUser(db, userId);
    if (u.display_name === display) return { userId, name: display, changed: false };
    if (db.one(`SELECT id FROM users WHERE display_name=? AND id<>?`, display, userId)) throw new Error(`名称 ${display} 已被使用`);
    db.run(`UPDATE users SET display_name=? WHERE id=?`, display, userId);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_renamed', targetType: 'user', targetId: userId, payload: { from: u.display_name, to: display } });
    return { userId, name: display, changed: true };
  }, { immediate: true });
}

/** 重发令牌：旧的全部吊销、签发一枚新的。明文只在这里返回一次。 */
export function reissueToken(db, { userId, byUserId }) {
  const tokenId = newId('tk');
  const plaintext = randomBytes(24).toString('base64url');
  const t = now();
  return db.tx(() => {
    const u = mustUser(db, userId);
    if (u.disabled_at) throw new Error(`${u.display_name} 已停用，请先启用再重新生成令牌`);
    const revoked = Number(db.run(`UPDATE tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, t, userId).changes);
    db.run(`INSERT INTO tokens (id,user_id,token_hash,issued_by,issued_at) VALUES (?,?,?,?,?)`, tokenId, userId, sha256(plaintext), byUserId, t);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'token_reissued', targetType: 'user', targetId: userId, payload: { tokenId, revoked } });
    return { userId, tokenId, plaintext, revoked };
  }, { immediate: true });
}

export function removeUserChannel(db, { userId, kind, byUserId }) {
  const ch = KIND_CHANNEL[kind];
  if (!ch) throw new Error(`通知通道无效：${kind}（应为 ntfy / feishu / dingtalk / wecom）`);
  mustUser(db, userId);
  return db.tx(() => {
    const n = Number(db.run(`DELETE FROM user_channels WHERE user_id=? AND channel=?`, userId, ch).changes);
    if (!n) throw new Error(`该成员未配置 ${kind} 通知通道`);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_channel_removed', targetType: 'user', targetId: userId, payload: { channel: ch } });
    return { removed: n };
  });
}

export function setUserTags(db, { userId, tags, byUserId }) {
  if (!db.one(`SELECT id FROM users WHERE id=?`, userId)) throw new Error(`成员不存在：${userId}`);
  db.run(`UPDATE users SET domain_tags=? WHERE id=?`, JSON.stringify([].concat(tags).map(String).filter(Boolean)), userId);
  audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_tags_set', targetType: 'user', targetId: userId, payload: { tags } });
}

/** 挂一条通道。同种通道覆盖（一人一种一条）。URL 里可能带密钥：审计只记种类。 */
export function setUserChannel(db, { userId, kind, target, byUserId }) {
  const ch = KIND_CHANNEL[kind];
  if (!ch) throw new Error(`通知通道无效：${kind}（应为 ntfy / feishu / dingtalk / wecom）`);
  if (!db.one(`SELECT id FROM users WHERE id=?`, userId)) throw new Error(`成员不存在：${userId}`);
  if (!String(target ?? '').trim()) throw new Error('通道地址不能为空');
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
  for (const p of due) {
    const channels = [...channelsForUsers(db, [p.owner_id]), ...channelsFromEnv(env, extraCmd)];
    let receipts = [];
    if (channels.length) {
      receipts = await notify(db, { taskId: null, kind: 'delivery', title: `[SuperIntern] 项目已达成，等你交付：${String(p.title).slice(0, 40)}`,
        text: `项目「${p.title}」已确认达成，所有任务都已合进项目分支（还只在这套系统里）。\n到看板的项目页点「交付项目」，才会推到你们的代码仓库 —— 只能你亲自点，推出去收不回。`, ref: `deliver:${p.id}`, channels, fetchFn, ...(spawn ? { spawn } : {}) });
      sent.push({ projectId: p.id, to: [p.owner_id], receipts });
    }
    audit(db, { actorKind: 'system', action: 'delivery_notified', targetType: 'project', targetId: p.id, payload: { to: p.owner_id, channels: channels.map((c) => c.kind) } });
  }
  return sent;
}

export async function notifyPendingQuestions(db, { env = process.env, extraCmd = null, fetchFn = globalThis.fetch, spawn } = {}) {
  const due = db.all(`SELECT q.*, t.title FROM questions q JOIN tasks t ON t.id=q.task_id WHERE q.status IN ('open','escalated') AND q.notified_at IS NULL ORDER BY q.asked_at LIMIT 50`);
  const sent = [];
  for (const q of due) {
    const to = [...JSON.parse(q.addressed_to || '[]'), ...JSON.parse(q.informed || '[]')];
    const channels = [...channelsForUsers(db, to), ...channelsFromEnv(env, extraCmd)];
    const lvl = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ'][q.level] ?? q.level;
    const title = `[SuperIntern] ${q.decision_type === 'conflict' ? '冲突事项' : q.decision_type === 'signoff' ? '等你签收' : `${lvl} 级问题在等你`}：${String(q.title).slice(0, 40)}`;
    const text = `${String(q.text).slice(0, 400)}\n\n回答：node src/cli.mjs answer ${q.id} "..."（任务 ${q.task_id}）`;
    if (channels.length) {
      const receipts = await notify(db, { taskId: q.task_id, kind: 'question', title, text, ref: q.id, channels, fetchFn, ...(spawn ? { spawn } : {}) });
      sent.push({ questionId: q.id, to, receipts });
    }
    db.run(`UPDATE questions SET notified_at=? WHERE id=?`, now(), q.id);
  }
  return sent;
}
