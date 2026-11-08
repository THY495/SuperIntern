// 邮件答复：直接回推送邮件就算答复。
//
// 发：推给某个人、等他答（question.addressed）、而且是能回信答的类（规格取舍 / 结构 / 运维）的事项，
//     邮件带一枚只属于"这个人 × 这件事"的答复令牌：
//       - Message-ID 是 <si.r.<令牌>@域名> —— 回信的 In-Reply-To / References 带着它，哪种邮箱都认得出；
//       - MAIL_REPLY_TO 里写了 {token}（支持加号别名的邮箱：reply+{token}@example.com）就再放进 Reply-To，
//         不带 In-Reply-To 的客户端也认得出。没写就 Reply-To 原样（或不设，回到 MAIL_FROM）。
//     不带令牌的个人邮件也编个认得出的 Message-ID（这件事 si.q.<事项 id>、汇总 si.d），回了能告诉人为什么不算。
// 收：守护进程每分钟用 IMAP 收一次没读过的信（IMAP_URL）。一封信要过这几关才算答复：
//       令牌认得、没过期（72 小时）、没用过；发件人是这个人登记的邮箱；收信服务器的发件人校验（DMARC / SPF）没判失败；
//       事项还开着；这类事能回信答；去掉引用原文后还有字。
//     哪关没过都回一封说明（带这件事的链接）；只回给登记过的邮箱、或者持有效令牌的发件人（转发后别人回的），
//     别的地址一概不回（不给伪造发件人的垃圾信当回音壁），说明信同一个地址一小时最多回 10 封。
//     自动回复、退信、群发不处理（RFC 3834：Auto-Submitted / Precedence），防两边的机器人来回打。
// 答复走 recordAnswer（法定人数、冲突、附议规则照旧），消息挂的签发令牌就是这枚答复令牌（指令溯源）。
// 答复令牌是 tokens 里 kind='mail' 的一种：authenticate 默认不认它，只有这里认 —— 随邮件转发出去也调不了接口。

import { randomBytes } from 'node:crypto';
import { newId, now, audit, sha256 } from '../db/db.mjs';
import { insertToken, revokeToken } from '../db/users.mjs';
import { tl, userLang, contentLang, translateError } from '../i18n/index.mjs';
import { mailReady, sendMail, parseSmtpUrl, addrOf } from './smtp.mjs';
import { parseImapUrl, fetchUnseen } from './imap.mjs';
import { parseMail, replyText } from './mime.mjs';
import { itemLink } from './links.mjs';
import { recordAnswer, waitingOn } from './answers.mjs';
import { resolutionOf } from './questions.mjs';
import { DECISION_TYPES } from './routing.mjs';
import { viewerTz } from './calendar.mjs';
import { fmtAt } from './tz.mjs';

const typeLabel = (L, t) => (DECISION_TYPES[t] ? tl(L, DECISION_TYPES[t].label) : t);

/** 能回信答的类：本来就是一段文字的答复。意见冲突要看清双方说了什么（快速答复页能答，回信不能），其余后果大或要看的东西多。 */
export const MAIL_OK = new Set(['spec_choice', 'structural', 'ops']);
export const REPLY_TTL_H = 72;
const H = 3600_000;
const REPLY_CAP_PER_HOUR = 10;   // 说明信（拒收）给同一个地址一小时最多回几封；答复生效的确认信不算
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const b32 = (buf) => { let bits = 0, v = 0, out = ''; for (const x of buf) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } return bits ? out + B32[(v << (5 - bits)) & 31] : out; };
const TOKEN_RE = '[a-z2-7]{32}';

/** 邮件答复要发信（SMTP_URL + MAIL_FROM）和收信（IMAP_URL）都配了。 */
export const replyByEmailReady = (env = process.env) => mailReady(env) && !!String(env.IMAP_URL ?? '').trim();
const domainOf = (env) => addrOf(env.MAIL_FROM).split('@')[1] || 'localhost';

/** 答复地址：MAIL_REPLY_TO 里的 {token} 换成令牌；没写 {token} 就原样；没配就不设（回到 MAIL_FROM）。 */
function replyAddress(env, token) {
  const t = String(env.MAIL_REPLY_TO ?? '').trim();
  if (!t) return null;
  return t.includes('{token}') ? t.replace('{token}', token) : t;
}

/** 签一枚答复令牌（明文只在这里出现一次，写进邮件）。 */
export function mintReplyToken(db, { userId, questionId, at = now() }) {
  const token = b32(randomBytes(20));
  const tokenId = newId('tk');
  db.tx(() => {
    insertToken(db, { id: tokenId, userId, plaintext: token, issuedBy: userId, issuedAt: at, name: `reply:${questionId}`, kind: 'mail', expiresAt: at + REPLY_TTL_H * H });
    db.run(`INSERT INTO mail_reply_tokens (token_id, user_id, question_id, created_at) VALUES (?,?,?,?)`, tokenId, userId, questionId, at);
  });
  return { token, tokenId };
}

/**
 * 发邮件前问一句：这封要不要带答复令牌。notify 的邮件分支调。
 * @returns {null | { replyTo: string|null, messageId: string, footer: string|null }}
 */
export function mailReplyFor(db, { ch, kind, ref, env = process.env, at = now() }) {
  if (!ch?.userId || !replyByEmailReady(env)) return null;
  const dom = domainOf(env);
  const tail = () => b32(randomBytes(5));
  const L = userLang(db, ch.userId);
  // 认知走查：开了邮件答复以后，人会去回每一封推送邮件 —— 不能回信答的那几种要在信里先说清楚（否则回一句"接受"就以为签了）
  if (kind === 'push.digest') return { replyTo: null, messageId: `si.d.${tail()}@${dom}`, footer: tl(L, '汇总里有好几件事，直接回复这封邮件不算答复；请点上面的链接逐件处理（单条推送的邮件可以直接回信答）。') };
  if (!['question.addressed', 'question.informed'].includes(kind) || !ref) return null;
  const q = db.one(`SELECT id, status, decision_type, addressed_to FROM questions WHERE id=?`, ref);
  if (!q) return null;
  const addressed = JSON.parse(q.addressed_to || '[]').includes(ch.userId);
  const mid = `si.q.${q.id}.${tail()}@${dom}`;
  if (kind !== 'question.addressed' || !addressed) return { replyTo: null, messageId: mid, footer: tl(L, '你在这件事上是知会，不用答；直接回复这封邮件不算答复。') };
  if (!MAIL_OK.has(q.decision_type)) return { replyTo: null, messageId: mid, footer: tl(L, '{what}只能在看板上处理，直接回复这封邮件没有用；请点上面的链接。', { what: typeLabel(L, q.decision_type) }) };
  if (!['open', 'escalated'].includes(q.status)) return { replyTo: null, messageId: mid, footer: null };
  const { token } = mintReplyToken(db, { userId: ch.userId, questionId: q.id, at });
  return { replyTo: replyAddress(env, token), messageId: `si.r.${token}@${dom}`,
    footer: tl(L, '想好了可以直接回复这封邮件：在最上面写一句，例如“选 B”或者你的说明（下面引用的原文不用删）。请用收到这封信的这个邮箱回。邮件答复只算第一次，最长 {h} 小时有效；这件事要是先到期按默认走了，回信就不算了。之后要改，点上面的链接到看板上改。', { h: REPLY_TTL_H }) };
}

/** 从一封回信里认出它回的是什么：答复令牌 / 某件事 / 汇总 / 认不出。 */
function whatItAnswers(m, env) {
  const ids = [...m.inReplyTo, ...m.references];
  const tpl = String(env.MAIL_REPLY_TO ?? '').trim();
  if (tpl.includes('{token}')) {
    // "SuperIntern <reply+{token}@x.com>" → 只看地址部分：占位先换成一个认得出的串，取出地址再切开
    const [pre, post] = addrOf(tpl.replace('{token}', 'zz9tokenzz9')).split('zz9tokenzz9').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`^${pre}(${TOKEN_RE})${post}$`);
    for (const a of m.to) { const x = a.match(re); if (x) return { token: x[1] }; }
  }
  for (const id of ids) { const x = id.toLowerCase().match(new RegExp(`^si\\.r\\.(${TOKEN_RE})@`)); if (x) return { token: x[1] }; }
  for (const id of ids) { const x = id.match(/^si\.q\.([^.@]+)\.[a-z2-7]+@/i); if (x) return { questionId: x[1] }; }
  if (ids.some((id) => /^si\.d\.[a-z2-7]+@/i.test(id))) return { digest: true };
  return {};
}

const isAutomated = (m) => {
  const as = m.header('auto-submitted').trim().toLowerCase();
  if (as && as !== 'no') return true;
  if (/^(bulk|junk|list|auto_reply)$/i.test(m.header('precedence').trim())) return true;
  if (m.header('x-autoreply') || m.header('x-autorespond') || m.header('list-id')) return true;
  return /^(mailer-daemon|postmaster|no-?reply|bounces?)@/i.test(m.from ?? '');
};
/** 收信服务器写的发件人校验（最上面那条 Authentication-Results 是我们的收信服务器加的）：判了失败才拒，没写不算。 */
const authFailed = (m) => {
  const ar = m.header('authentication-results');
  if (!ar) return false;
  if (/\bdmarc=(fail|reject)\b/i.test(ar)) return true;
  return !/\bdmarc=/i.test(ar) && /\bspf=fail\b/i.test(ar);
};
/** 登记过这个邮箱的、没停用的成员。 */
const userByEmail = (db, addr) => {
  if (!addr) return null;
  for (const c of db.all(`SELECT c.user_id, c.target FROM user_channels c JOIN users u ON u.id=c.user_id WHERE c.channel='email' AND c.enabled=1 AND u.disabled_at IS NULL`)) {
    if (addrOf(c.target) === addr) return c.user_id;
  }
  return null;
};
const emailOf = (db, userId) => addrOf(db.one(`SELECT target FROM user_channels WHERE user_id=? AND channel='email' AND enabled=1`, userId)?.target ?? '') || null;

/**
 * 处理收到的一封信。返回 { outcome, replied, questionId? }。同一封（按 Message-ID）只处理一次。
 * outcome：answered / duplicate / automated / no_token / digest / not_allowed / unknown_token / sender_mismatch /
 *          auth_failed / token_used / expired / resolved / empty / rejected
 */
export async function handleInbound(db, raw, { env = process.env, sendMailFn = sendMail, at = now() } = {}) {
  const m = parseMail(raw);
  const key = m.messageId ? `id:${m.messageId.toLowerCase()}` : `sha:${sha256(Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw))}`;
  const from = m.from;
  const fromHash = from ? sha256(from) : null, fromDomain = from?.split('@')[1] ?? null;
  const rowId = newId('mi');
  const fresh = db.tx(() => {
    if (db.one(`SELECT 1 FROM mail_inbound WHERE msg_key=?`, key)) return false;
    db.run(`INSERT INTO mail_inbound (id, msg_key, from_hash, from_domain, outcome, received_at) VALUES (?,?,?,?,'pending',?)`, rowId, key, fromHash, fromDomain, at);
    return true;
  });
  if (!fresh) return { outcome: 'duplicate', replied: false };

  const done = async (outcome, { tokenId = null, questionId = null, userId = null, replyTo = null, lang = null, text = null, link = null } = {}) => {
    let replied = false;
    if (replyTo && text && !isAutomated(m)) {
      const recent = outcome === 'answered' ? 0 : db.one(`SELECT count(*) n FROM mail_inbound WHERE from_hash=? AND replied=1 AND outcome<>'answered' AND received_at > ?`, sha256(replyTo), at - H).n;
      if (recent < REPLY_CAP_PER_HOUR) {
        try {
          await sendMailFn(parseSmtpUrl(env.SMTP_URL), { from: env.MAIL_FROM, to: replyTo, subject: `Re: ${String(m.subject || 'SuperIntern').replace(/^\s*(re|回复|答复)\s*[:：]\s*/i, '')}`,
            text: [text, link].filter(Boolean).join('\n\n'), inReplyTo: m.messageId ? `<${m.messageId}>` : null, autoSubmitted: 'auto-replied' });
          replied = true;
        } catch { /* 说明信发不出去不影响结果；审计里有 outcome */ }
      }
    }
    db.run(`UPDATE mail_inbound SET outcome=?, token_id=?, question_id=?, user_id=?, replied=?, from_hash=coalesce(?, from_hash) WHERE id=?`,
      outcome, tokenId, questionId, userId, replied ? 1 : 0, replyTo ? sha256(replyTo) : null, rowId);
    audit(db, { actorKind: 'system', action: 'mail_reply_received', targetType: questionId ? 'question' : null, targetId: questionId,
      payload: { outcome, fromDomain, tokenId, userId, replied } });
    return { outcome, replied, questionId };
  };

  if (isAutomated(m)) return done('automated');
  const L0 = contentLang(db);
  const what = whatItAnswers(m, env);
  const known = userByEmail(db, from);
  const langOf = (uid) => (uid ? userLang(db, uid) : L0);

  if (!what.token) {
    // 没有令牌：只回给登记过的邮箱（不认识的地址一概不回）
    const L = langOf(known);
    if (what.questionId) {
      const q = db.one(`SELECT id, decision_type FROM questions WHERE id=?`, what.questionId);
      if (q && !MAIL_OK.has(q.decision_type)) {
        return done('not_allowed', { questionId: q.id, userId: known, replyTo: known ? from : null, lang: L,
          text: tl(L, '这封信没被当成答复：{what}只能在看板上处理，邮件里答不了。请打开这件事：', { what: typeLabel(L, q.decision_type) }), link: itemLink(db, { questionId: q.id }) });
      }
      return done('no_token', { questionId: q?.id ?? null, userId: known, replyTo: known ? from : null, lang: L,
        text: tl(L, '这封信没被当成答复：它回的那封推送不带答复地址（你在这件事上是知会而不是答复人，或者推送时邮件答复还没开）。请打开这件事在看板上答：'), link: q ? itemLink(db, { questionId: q.id }) : itemLink(db) });
    }
    if (what.digest) {
      return done('digest', { userId: known, replyTo: known ? from : null, lang: L,
        text: tl(L, '这封信没被当成答复：汇总推送里有好几件事，回信认不出答的是哪一件。请打开收件箱逐件处理（单条推送的邮件可以直接回信答）：'), link: itemLink(db) });
    }
    return done('no_token', { userId: known, replyTo: known ? from : null, lang: L,
      text: tl(L, '这封信没被当成答复：认不出它答的是哪件事。邮件答复要直接回某一件事的推送邮件；也可以打开看板答：'), link: itemLink(db) });
  }

  const t = db.one(`SELECT k.id, k.user_id, k.revoked_at, k.expires_at, r.question_id, r.used_at FROM tokens k JOIN mail_reply_tokens r ON r.token_id=k.id
                    WHERE k.token_hash=? AND k.kind='mail'`, sha256(what.token));
  if (!t) {
    const L = langOf(known);
    return done('unknown_token', { userId: known, replyTo: known ? from : null, lang: L,
      text: tl(L, '这封信没被当成答复：这个答复地址不存在（可能抄错了）。请打开看板答：'), link: itemLink(db) });
  }
  const link = itemLink(db, { questionId: t.question_id });
  const base = { tokenId: t.id, questionId: t.question_id };
  const owner = emailOf(db, t.user_id);
  // 发件人对不上：转发出去后别人回的，或者伪造的。令牌是真的（这封信确实是从我们的推送来的），回给发件人说明
  if (!from || from !== owner) {
    const L = langOf(known);
    return done('sender_mismatch', { ...base, userId: known, replyTo: from, lang: L,
      text: tl(L, '这封信没被当成答复：这件事只收指定答复人从他自己登记的邮箱发来的回信，转发出去的邮件别人回了不算数。如果这件事该你答，请登录看板：'), link });
  }
  const L = userLang(db, t.user_id);
  const mine = { ...base, userId: t.user_id, replyTo: owner, lang: L, link };
  if (authFailed(m)) return done('auth_failed', { ...mine, text: tl(L, '收到一封用你的邮箱发来的回信，但收信服务器没能确认它是你本人发的（发件人校验没通过），所以没有采用，这件事的状态没有变化。如果确实是你回的，请打开这件事在看板上答；如果不是你发的，不用做任何事，也可以告诉管理员：') });
  // 认知走查：只说"不算"不够，人要知道现在记着的是什么（答过的那条 / 定下的结论），不然会重复回信或误以为按自己的走了
  const lastAnswer = (uid) => db.one(`SELECT body FROM answers WHERE question_id=? AND stance='answer'${uid ? ' AND user_id=?' : ''} ORDER BY created_at DESC, rowid DESC LIMIT 1`, ...[t.question_id, ...(uid ? [uid] : [])])?.body ?? null;
  const clip = (s) => (String(s).length > 300 ? `${String(s).slice(0, 300)}…` : String(s));
  if (t.used_at || t.revoked_at) {
    const mineNow = lastAnswer(t.user_id);
    return done('token_used', { ...mine, text: tl(L, '这封信没被当成答复：这封推送邮件已经回信答复过一次（每封只能回一次）。') + (mineNow ? `${tl(L, '现在记着的是你的这条答复：')}\n\n${clip(mineNow)}\n\n` : '') + tl(L, '要改答复，请打开这件事在看板上改：') });
  }
  const q = db.one(`SELECT * FROM questions WHERE id=?`, t.question_id);
  if (!q || !['open', 'escalated'].includes(q.status)) {
    const r = q ? resolutionOf(db, q) : null;
    const tz = viewerTz(db, t.user_id);
    const concl = q?.status === 'answered' ? lastAnswer(null) : null;
    return done('resolved', { ...mine, text: r ? tl(L, '这封信没被当成答复：这件事已经由 {who} 于 {when} {how}，不再收答复，你这次的回信没有采用。', { who: r.who, when: r.at ? fmtAt(r.at, tz) : r.when, how: r.how })
      + (concl ? `${tl(L, '结论：')}\n\n${clip(concl)}\n\n` : '') + tl(L, '对结论有不同意见，请打开这件事：') : tl(L, '这封信没被当成答复：这件事已经不在了。'), link: q ? link : itemLink(db) });
  }
  if (t.expires_at != null && t.expires_at <= at) return done('expired', { ...mine, text: tl(L, '这封信没被当成答复：邮件答复在推送后 {h} 小时内有效，这封已经过期。这件事还开着、还在等答复，请打开它在看板上答：', { h: REPLY_TTL_H }) });
  if (!MAIL_OK.has(q.decision_type)) return done('not_allowed', { ...mine, text: tl(L, '这封信没被当成答复：{what}只能在看板上处理，邮件里答不了。请打开这件事：', { what: typeLabel(L, q.decision_type) }) });
  const body = replyText(m.text);
  if (!body) return done('empty', { ...mine, text: tl(L, '这封信没被当成答复：回信里没找到新写的内容（只有引用的原文）。把答复写在回信的最上面、引用的原文之上，再回一次；或者打开看板答：') });

  let r;
  try {
    r = recordAnswer(db, { questionId: q.id, body, plaintextToken: what.token, mailToken: true, at });
  } catch (e) {
    return done('rejected', { ...mine, text: `${tl(L, '这封信没被当成答复：')}${translateError(e, L)}` });
  }
  // 用掉：这枚和同一个人 × 同一件事的其它答复令牌（之前的提醒邮件）一起作废
  db.tx(() => {
    db.run(`UPDATE mail_reply_tokens SET used_at=? WHERE question_id=? AND user_id=? AND used_at IS NULL`, at, q.id, t.user_id);
    for (const { token_id } of db.all(`SELECT token_id FROM mail_reply_tokens WHERE question_id=? AND user_id=?`, q.id, t.user_id)) revokeToken(db, token_id, at);
  });
  const quote = body.length > 600 ? `${body.slice(0, 600)}…` : body;
  // 还差谁：用看板「在等谁签」同一个口径（waitingOn），写名字，不写路由范围
  const w = !r.conflictId && !r.resolved ? waitingOn(db, q.id) : null;
  const names = (w?.left ?? []).map((u) => db.one(`SELECT display_name FROM users WHERE id=?`, u)?.display_name ?? u).join(tl(L, '、'));
  const status = r.conflictId ? tl(L, '和别人的答复不一致：两边都没生效，已经另起一件「意见不一致」，要在看板上处理。')
    : r.resolved ? tl(L, '已生效，这件事按你的答复了结。')
    : w?.left.length ? (w.need < w.left.length ? tl(L, '你的答复已经记下，不会丢。这件事要几个人答：{who} 中再有 {n} 位答了就自动生效，你不用再做什么。', { who: names, n: w.need }) : tl(L, '你的答复已经记下，不会丢。这件事要几个人都答：还在等 {who} 答，等齐了就自动生效，你不用再做什么。', { who: names }))
    : tl(L, '已记下。');
  return done('answered', { ...mine, text: `${tl(L, '已收到你的答复：')}\n\n${quote}\n\n${status}` });
}

/** 守护进程每拍调：配了 IMAP_URL 就收一轮。返回 null（没配）或 { fetched, errors, results }。 */
export async function pollMailReplies(db, { env = process.env, fetchFn = fetchUnseen, sendMailFn = sendMail } = {}) {
  if (!replyByEmailReady(env)) return null;
  const results = [];
  const r = await fetchFn(parseImapUrl(env.IMAP_URL), async (raw) => { results.push(await handleInbound(db, raw, { env, sendMailFn, at: now() })); });
  return { ...r, results };
}
