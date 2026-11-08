// 邮件答复：直接回推送邮件就算答复。
//
// ① 拆信：base64 / quoted-printable、GBK、multipart、RFC 2047 标题、只有 HTML 的信
// ② 去引用：Gmail（中英）、Outlook、QQ / 163 的"原始邮件"、> 引用、签名、"发自我的 iPhone"
// ③ IMAP：AUTHENTICATE PLAIN、UID SEARCH / FETCH（字面量按字节收）、处理完标已读、处理抛错也标；不降级、明文不发密码
// ④ 发信：能回信答的事项带答复令牌（Message-ID + Reply-To 加号别名 + 说明一句）；别的类、知会、汇总不带，但认得出
// ⑤ 收信：答复生效（消息挂的签发令牌就是答复令牌）；五种拒收各回一封说明（伪造发件人、转发后别人回、令牌用过、
//    事项已结、不能回信答的类），外加过期、发件人校验失败、空回信、自动回复、重复投递、陌生地址不回
// ⑥ 答复令牌调不了接口，也不出现在令牌列表里
// ⑦ 守护进程那一拍：pollMailReplies 收一轮
//
// 跑：node tests/mail-reply.test.mjs

import net from 'node:net';
import { openDb, ensureOwner, newId, authenticate } from '../src/db/db.mjs';
import { setUserChannel } from '../src/core/users.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { notify } from '../src/core/notify.mjs';
import { parseMail, replyText, decodeWords } from '../src/core/mime.mjs';
import { parseImapUrl, fetchUnseen } from '../src/core/imap.mjs';
import { mailReplyFor, handleInbound, pollMailReplies, mintReplyToken, replyByEmailReady } from '../src/core/mail-reply.mjs';
import { tokensOf } from '../src/core/sessions.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = async (p, re, m) => { try { await p; bad(m, '没有抛'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `抛了但不是预期：${e.message}`); } };

const CRLF = (s) => s.replace(/\r?\n/g, '\r\n');

section('① 拆信');
{
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);   // "你好" 的 GBK
  const m = parseMail(Buffer.concat([Buffer.from(CRLF(`From: =?gbk?B?${Buffer.from([0xd0, 0xa1, 0xc1, 0xd6]).toString('base64')}?= <Lin@Example.com>\nTo: si@x.com\nSubject: =?utf-8?Q?Re:_=E8=A7=84=E6=A0=BC?=\nMessage-ID: <abc@mail.example.com>\nIn-Reply-To: <si.r.x@x.com>\nContent-Type: text/plain; charset=gbk\nContent-Transfer-Encoding: quoted-printable\n\n`)),
    Buffer.from(`=${gbk.toString('hex').match(/../g).join('=').toUpperCase()}=\r\n\r\n`)]));
  eq([m.from, m.subject, m.messageId, m.inReplyTo], ['lin@example.com', 'Re: 规格', 'abc@mail.example.com', ['si.r.x@x.com']], '发件人（去名字、转小写）、Q 编码标题、Message-ID、In-Reply-To');
  eq(m.text.trim(), '你好', 'quoted-printable + GBK 正文（含软换行）');
  eq(decodeWords('=?gbk?B?xOM=?= =?gbk?B?usM=?='), '你好', '相邻两个编码词之间的空白去掉');
  const mp = parseMail(CRLF(`From: a@x.com\nSubject: hi\nContent-Type: multipart/alternative; boundary="BB"\n\npreamble\n--BB\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${Buffer.from('选 B 吧').toString('base64')}\n--BB\nContent-Type: text/html\n\n<p>选 B 吧</p>\n--BB--\nepilogue\n`));
  eq(mp.text.trim(), '选 B 吧', 'multipart/alternative：取 text/plain（base64）');
  const html = parseMail(CRLF(`From: a@x.com\nContent-Type: multipart/mixed; boundary=X\n\n--X\nContent-Type: text/html; charset=utf-8\n\n<div>按 A&amp;B 做</div><blockquote>原文</blockquote>\n--X\nContent-Type: text/plain\nContent-Disposition: attachment; filename=a.txt\n\n附件\n--X--\n`));
  eq(html.text.trim(), '按 A&B 做', '只有 HTML：去标签、实体还原、引用块去掉；附件里的文字不算');
  const raw8 = parseMail(Buffer.concat([Buffer.from('From: '), Buffer.from('阿青 <lin@x.com>', 'utf8'), Buffer.from('\r\nSubject: '), Buffer.from('没编码的标题等你', 'utf8'), Buffer.from('\r\n\r\n'), Buffer.from('放在输入框下面', 'utf8')]));
  eq([raw8.from, raw8.subject], ['lin@x.com', '没编码的标题等你'], '没编码的 8 位信头按 UTF-8 读（末字「你」的尾字节 0xA0 不被当空白削掉）');
  eq(raw8.text, '放在输入框下面', '没写 Content-Type（按规范默认 us-ascii）却塞了 UTF-8：按 UTF-8 读');
}

section('② 去引用');
{
  const cases = [
    ['选 A，列表按创建时间倒序。\n\nOn Sun, Nov 8, 2026 at 10:00 AM SuperIntern <si@x.com> wrote:\n> 原文', 'Gmail 英文'],
    ['选 A，列表按创建时间倒序。\n\nOn Sun, Nov 8, 2026 at 10:00 AM SuperIntern <\nsi@x.com> wrote:\n> 原文', 'Gmail 英文（折成两行）'],
    ['选 A，列表按创建时间倒序。\n\n在 2026年11月8日周日 10:00，SuperIntern <si@x.com> 写道：\n> 原文', 'Gmail 中文 / 163'],
    ['选 A，列表按创建时间倒序。\n\n________________________________\nFrom: SuperIntern <si@x.com>\nSent: Sunday, November 8, 2026 10:00\n原文', 'Outlook'],
    ['选 A，列表按创建时间倒序。\n\n发件人: SuperIntern <si@x.com>\n发送时间: 2026年11月8日 10:00\n收件人: lin\n原文', 'Outlook 中文（没有下划线行）'],
    ['选 A，列表按创建时间倒序。\n\n------------------ 原始邮件 ------------------\n发件人: "SuperIntern"\n原文', 'QQ 邮箱'],
    ['选 A，列表按创建时间倒序。\n> 原文一行\n> 原文二行\n\n-- \n阿青 · 产品\n电话 123', '> 引用 + 签名'],
    ['选 A，列表按创建时间倒序。\n\n发自我的iPhone', '"发自我的 iPhone"'],
  ];
  for (const [t, name] of cases) eq(replyText(t), '选 A，列表按创建时间倒序。', `${name}：只留新写的那段`);
  eq(replyText('> 全是引用\n> 没写新的'), '', '只有引用 → 空');
}

/** 假 IMAP 服务器：mails = [{ uid, raw: Buffer, seen }]；记下收到的命令。 */
function fakeImap({ mails = [], caps = 'IMAP4rev1 AUTH=PLAIN', starttls = false, user = 'u', pass = 'p' } = {}) {
  const log = [];
  const server = net.createServer((sock) => {
    let buf = '', auth = null;
    sock.write(`* OK [CAPABILITY ${caps}${starttls ? ' STARTTLS' : ''}] fake ready\r\n`);
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let k;
      while ((k = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 2);
        if (auth) { const [, u, p] = Buffer.from(line, 'base64').toString('utf8').split('\0'); sock.write(u === user && p === pass ? `${auth} OK logged in\r\n` : `${auth} NO bad\r\n`); auth = null; continue; }
        log.push(line);
        const [tag, ...rest] = line.split(' ');
        const cmd = rest.join(' ');
        if (/^AUTHENTICATE PLAIN$/i.test(cmd)) { auth = tag; sock.write('+ \r\n'); }
        else if (/^LOGIN /i.test(cmd)) sock.write(`${tag} OK\r\n`);
        else if (/^CAPABILITY$/i.test(cmd)) sock.write(`* CAPABILITY ${caps}\r\n${tag} OK\r\n`);
        else if (/^SELECT /i.test(cmd)) sock.write(`* ${mails.length} EXISTS\r\n${tag} OK [READ-WRITE]\r\n`);
        else if (/^UID SEARCH UNSEEN$/i.test(cmd)) sock.write(`* SEARCH ${mails.filter((x) => !x.seen).map((x) => x.uid).join(' ')}\r\n${tag} OK\r\n`);
        else if (/^UID FETCH (\d+) \(BODY\.PEEK\[\]\)$/i.test(cmd)) {
          const uid = Number(cmd.match(/\d+/)[0]); const mm = mails.find((x) => x.uid === uid);
          if (mm) { sock.write(`* ${mails.indexOf(mm) + 1} FETCH (UID ${uid} BODY[] {${mm.raw.length}}\r\n`); sock.write(mm.raw); sock.write(')\r\n'); }
          sock.write(`${tag} OK\r\n`);
        } else if (/^UID STORE (\d+) \+FLAGS\.SILENT \(\\Seen\)$/i.test(cmd)) { const uid = Number(cmd.match(/\d+/)[0]); const mm = mails.find((x) => x.uid === uid); if (mm) mm.seen = true; sock.write(`${tag} OK\r\n`); }
        else if (/^STARTTLS$/i.test(cmd)) sock.write(`${tag} NO not here\r\n`);
        else if (/^LOGOUT$/i.test(cmd)) { sock.write(`* BYE\r\n${tag} OK\r\n`); sock.end(); }
        else sock.write(`${tag} BAD what\r\n`);
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, log, mails, close: () => server.close() })));
}

section('③ IMAP');
{
  eq(parseImapUrl('imaps://si%40x.com:p%40ss@imap.x.com/Replies'), { host: 'imap.x.com', port: 993, secure: true, starttls: false, local: false, user: 'si@x.com', pass: 'p@ss', mailbox: 'Replies' }, 'imaps：直接 TLS，默认 993，文件夹写在路径上');
  eq(parseImapUrl('imap://u:p@imap.x.com').starttls, true, 'imap + 远端：必须 STARTTLS');
  const body = Buffer.from(CRLF('From: a@x.com\nSubject: t\n\n第一行\n第二行 ) {12}\n'), 'utf8');
  const s = await fakeImap({ mails: [{ uid: 7, raw: body, seen: false }, { uid: 9, raw: Buffer.from('From: b@x.com\r\n\r\nboom'), seen: false }, { uid: 3, raw: Buffer.from('x'), seen: true }] });
  const got = [];
  const r = await fetchUnseen({ host: '127.0.0.1', port: s.port, local: true, user: 'u', pass: 'p', mailbox: 'INBOX' }, async (raw, { uid }) => { got.push([uid, raw]); if (uid === 9) throw new Error('坏信'); });
  eq(got.map((g) => g[0]), [7, 9], '只取没读过的，按 UID 顺序');
  assert(got[0][1].equals(body), '字面量按字节收（含中文、行里的 ) 和 {12}）');
  eq([r.fetched, r.errors.map((e) => e.uid)], [2, [9]], '处理抛错收进 errors');
  eq(s.mails.map((x) => x.seen), [true, true, true], '处理完都标已读（坏信也标，不每拍重来）');
  assert(s.log.some((l) => /AUTHENTICATE PLAIN/.test(l)) && s.log.some((l) => /BODY\.PEEK/.test(l)), 'AUTHENTICATE PLAIN；取信用 BODY.PEEK（标已读另发 STORE）');
  s.close();
  const s2 = await fakeImap({ pass: 'right' });
  await rejects(fetchUnseen({ host: '127.0.0.1', port: s2.port, local: true, user: 'u', pass: 'wrong-SECRET', mailbox: 'INBOX' }, async () => {}), /^(?!.*SECRET).*登录/, '登录失败：报错里不带密码');
  s2.close();
  const s3 = await fakeImap();
  await rejects(fetchUnseen({ host: '127.0.0.1', port: s3.port, starttls: true, local: false, user: 'u', pass: 'p', mailbox: 'INBOX' }, async () => {}), /不支持 STARTTLS/, '要升级而服务器不给 STARTTLS：不收');
  await rejects(fetchUnseen({ host: '127.0.0.1', port: s3.port, starttls: false, local: false, user: 'u', pass: 'p', mailbox: 'INBOX' }, async () => {}), /明文连接上发送密码/, '非本机的明文连接：不发密码');
  assert(!s3.log.some((l) => /AUTHENTICATE|LOGIN/i.test(l)), '两次都没把登录发出去');
  s3.close();
}

// —— 有事项、有人的库 ——
const ENV = { SMTP_URL: 'smtp://127.0.0.1:2525', MAIL_FROM: 'SuperIntern <si@x.com>', IMAP_URL: 'imap://u:p@127.0.0.1:1143', MAIL_REPLY_TO: 'reply+{token}@x.com' };
const T0 = Date.parse('2026-11-11T10:00:00Z');
const db = openDb(':memory:');
const { userId: lead } = ensureOwner(db, 'lead');
setSetting(db, { key: 'deploy.board_url', value: 'https://si.example', userId: lead });
const addUser = (name, email) => {
  const id = newId('u');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,'member','[]',?)`, id, name, T0);
  if (email) setUserChannel(db, { userId: id, kind: 'email', target: email, byUserId: lead });
  return id;
};
const lin = addUser('阿青', 'Lin@Example.com'), zhou = addUser('阿明', 'zhou@example.com');
const taskId = newId('t');
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','waiting',?)`, taskId, lead, T0);
const question = (type = 'spec_choice', to = [lin]) => {
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,status,decision_type,addressed_to) VALUES (?,?,2,'classifier','列表默认按什么排序？',?,?,'open',?,?)`,
    id, taskId, type === 'signoff' ? null : 'd', T0, type, JSON.stringify(to));
  return id;
};
const sent = [];
const sendMailFn = async (conn, m) => { sent.push(m); return { ok: true, messageId: m.messageId }; };
const mailTo = async (userId, kind, ref, email) => {
  sent.length = 0;
  await notify(db, { taskId, kind, title: '[SuperIntern] 规格取舍', text: '正文', ref, link: 'https://si.example/#q/x', channels: [{ kind: 'email', target: email, userId }], env: ENV, sendMailFn });
  return sent[0];
};
const tokenOf = (m) => m.messageId.match(/si\.r\.([a-z2-7]{32})@/)?.[1];
const reply = ({ from = 'lin@example.com', to = null, inReplyTo, body = '选 B：按更新时间倒序。', headers = '', id = newId('m') }) => Buffer.from(CRLF(
  `From: 阿青 <${from}>\nTo: ${to ?? 'si@x.com'}\nSubject: Re: [SuperIntern] 规格取舍\nMessage-ID: <${id}@mail.example.com>\n${inReplyTo ? `In-Reply-To: <${inReplyTo}>\nReferences: <${inReplyTo}>\n` : ''}${headers}Content-Type: text/plain; charset=utf-8\n\n${body}\n\n在 2026年11月11日 10:00，SuperIntern <si@x.com> 写道：\n> 列表默认按什么排序？\n`), 'utf8');
const handle = async (raw, at = T0 + 60_000) => { sent.length = 0; return handleInbound(db, raw, { env: ENV, sendMailFn, at }); };

section('④ 发信：哪些带答复令牌');
{
  eq(replyByEmailReady({ SMTP_URL: 'x', MAIL_FROM: 'y' }), false, '没配 IMAP_URL：邮件答复不开');
  const q1 = question();
  const m = await mailTo(lin, 'question.addressed', q1, 'Lin@Example.com');
  assert(!!tokenOf(m), 'Message-ID 带答复令牌（si.r.<32 位>）', m?.messageId);
  eq(m.replyTo, `reply+${tokenOf(m)}@x.com`, 'Reply-To：MAIL_REPLY_TO 的 {token} 换成令牌');
  assert(/可以直接回复这封邮件/.test(m.text) && /“选 B”/.test(m.text) && /72 小时/.test(m.text) && /到看板上改/.test(m.text) && m.text.indexOf('https://si.example/#q/x') < m.text.indexOf('直接回复'), '正文：链接之后一句怎么回（带例子）、多久有效、答错了去哪改');
  const so = await mailTo(lin, 'question.addressed', question('signoff'), 'Lin@Example.com');
  assert(/^si\.q\.q_[^.]+\.[a-z2-7]+@x\.com$/.test(so.messageId) && !so.replyTo, '签收：不带令牌，Message-ID 认得出是哪件事');
  assert(/签收只能在看板上处理，直接回复这封邮件没有用/.test(so.text), '签收邮件里先说清回信没用（不然回一句「接受」就以为签了）', so.text);
  const inf = await mailTo(zhou, 'question.informed', q1, 'zhou@example.com');
  assert(/^si\.q\./.test(inf.messageId) && !inf.replyTo && /是知会，不用答/.test(inf.text), '知会：不带令牌，信里说不用答');
  const dg = await mailTo(lin, 'push.digest', 'pb_1', 'Lin@Example.com');
  assert(/^si\.d\./.test(dg.messageId) && !dg.replyTo && /不算答复/.test(dg.text), '汇总：不带令牌，认得出是汇总，信里说回信不算');
  sent.length = 0;
  await notify(db, { taskId, kind: 'question.addressed', title: 't', text: 'x', ref: q1, channels: [{ kind: 'email', target: 'ops@x.com' }], env: ENV, sendMailFn });
  assert(!sent[0].messageId && !sent[0].replyTo, '部署级邮箱（不是某个人）：不带令牌');
  eq(db.one(`SELECT count(*) n FROM tokens WHERE kind='mail'`).n, 1, '只签了一枚');
}

section('⑤ 收信：生效与拒收');
{
  const q = question();
  const m = await mailTo(lin, 'question.addressed', q, 'Lin@Example.com');
  const tk = tokenOf(m);
  // 伪造发件人：令牌是真的，发件地址不是阿青登记的
  let r = await handle(reply({ from: 'mallory@evil.example', inReplyTo: `si.r.${tk}@x.com` }));
  eq([r.outcome, r.replied, sent[0]?.to], ['sender_mismatch', true, 'mallory@evil.example'], '① 伪造发件人：拒收，回发件人一封说明');
  assert(/只收指定答复人从他自己登记的邮箱发来的回信/.test(sent[0]?.text ?? '') && /#q\//.test(sent[0]?.text ?? ''), '说明里带这件事的链接');
  // 转发后别人回：阿明登记过邮箱，但令牌是阿青的
  r = await handle(reply({ from: 'zhou@example.com', inReplyTo: `si.r.${tk}@x.com` }));
  eq([r.outcome, sent[0]?.to], ['sender_mismatch', 'zhou@example.com'], '② 转发后别人回：拒收，回一封说明');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, q).status, 'open', '前两封都没动事项');
  // 发件人校验失败（收信服务器判 DMARC fail）
  r = await handle(reply({ inReplyTo: `si.r.${tk}@x.com`, headers: 'Authentication-Results: mx.x.com; spf=pass; dmarc=fail header.from=example.com\n' }));
  eq([r.outcome, sent[0]?.to], ['auth_failed', 'lin@example.com'], '收信服务器判发件人校验失败：拒收，告诉登记的邮箱');
  // 空回信
  r = await handle(reply({ inReplyTo: `si.r.${tk}@x.com`, body: '' }));
  eq(r.outcome, 'empty', '只有引用、没写新的：拒收（令牌不作废）');
  // 正常：只靠 Reply-To 的加号别名认（客户端没带 In-Reply-To）
  r = await handle(reply({ to: `reply+${tk}@x.com` }));
  eq(r.outcome, 'answered', '从登记的邮箱回、令牌对：答复生效');
  const msg = db.one(`SELECT m.body, m.trust_label, m.token_id, m.sender_id FROM messages m WHERE m.task_id=? AND m.kind='answer' ORDER BY m.received_at DESC LIMIT 1`, taskId);
  eq([msg.body, msg.trust_label, msg.sender_id], ['选 B：按更新时间倒序。', 'user-authenticated', lin], '记下的答复：去掉引用后的正文、已认证、署阿青');
  eq(db.one(`SELECT kind FROM tokens WHERE id=?`, msg.token_id).kind, 'mail', '消息挂的签发令牌就是这枚答复令牌（指令溯源）');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, q).status, 'answered', '事项了结');
  assert(/已收到你的答复/.test(sent[0]?.text ?? '') && /已生效/.test(sent[0]?.text ?? ''), '回一封确认：答了什么、生效没有');
  // 同一个令牌再回一次
  r = await handle(reply({ inReplyTo: `si.r.${tk}@x.com`, body: '改成 A' }));
  eq(r.outcome, 'token_used', '③ 同一个令牌回两次：拒收');
  assert(/已经回信答复过一次/.test(sent[0]?.text ?? '') && (sent[0]?.text ?? '').includes('现在记着的是你的这条答复：\n\n选 B：按更新时间倒序。'), '说明：每封只能回一次、现在记着的是哪条、要改去看板', sent[0]?.text);
  // 事项已结后回（另一枚令牌，事项被别人在看板上答掉了）
  const q2 = question('spec_choice', [lin, zhou]);
  const m2 = await mailTo(lin, 'question.addressed', q2, 'Lin@Example.com');
  db.run(`UPDATE questions SET status='answered', resolved_at=? WHERE id=?`, T0, q2);
  db.run(`INSERT INTO answers (id,question_id,user_id,body,stance,created_at) VALUES (?,?,?,?,?,?)`, newId('a'), q2, zhou, '按创建时间', 'answer', T0);
  r = await handle(reply({ inReplyTo: `si.r.${tokenOf(m2)}@x.com` }));
  eq(r.outcome, 'resolved', '④ 事项已结后回：拒收');
  assert(/由 阿明 于 2026-11-11 10:00 UTC 作答，不再收答复/.test(sent[0]?.text ?? '') && (sent[0]?.text ?? '').includes('结论：\n\n按创建时间'), '说明：谁、什么时候（按收件人时区）了结的、结论是什么', sent[0]?.text);
  // 回了不能回信答的类（签收邮件没有令牌，Message-ID 认得出是哪件）
  const so = question('signoff');
  const ms = await mailTo(lin, 'question.addressed', so, 'Lin@Example.com');
  r = await handle(reply({ inReplyTo: ms.messageId }));
  eq([r.outcome, r.questionId], ['not_allowed', so], '⑤ 回了签收邮件：拒收');
  assert(/签收只能在看板上处理/.test(sent[0]?.text ?? '') && sent[0].text.includes(`#q/${so}`), '说明：这类要在看板上处理 + 这件事的链接', sent[0]?.text);
  // 过期
  const q3 = question();
  const m3 = await mailTo(lin, 'question.addressed', q3, 'Lin@Example.com');
  r = await handle(reply({ inReplyTo: `si.r.${tokenOf(m3)}@x.com` }), Date.now() + 73 * 3600_000);
  eq(r.outcome, 'expired', '72 小时后回：拒收');
  // 汇总
  r = await handle(reply({ inReplyTo: 'si.d.abcde@x.com' }));
  eq(r.outcome, 'digest', '回了汇总邮件：认不出答哪件，拒收并说明');
  // 自动回复、重复投递、陌生地址
  r = await handle(reply({ inReplyTo: `si.r.${tokenOf(m3)}@x.com`, headers: 'Auto-Submitted: auto-replied\n' }));
  eq([r.outcome, r.replied], ['automated', false], '自动回复（休假回复之类）：不处理、不回');
  const same = reply({ inReplyTo: 'si.d.abcde@x.com', id: 'dup1' });
  await handle(same);
  r = await handle(same);
  eq(r.outcome, 'duplicate', '同一封投递两次：只处理一次');
  r = await handle(reply({ from: 'stranger@spam.example', body: 'buy now' }));
  eq([r.outcome, r.replied], ['no_token', false], '陌生地址、没令牌：不回（不给伪造发件人的垃圾信当回音壁）');
  // 要两个人都答的：确认信写还在等谁（名字，不是路由范围）
  const qa = question('spec_choice', [lin, zhou]);
  db.run(`UPDATE questions SET route=? WHERE id=?`, JSON.stringify({ rows: [{ scope: '*', recipients: [lin, zhou], quorum: 'all', conflict_policy: 'block' }] }), qa);
  const ma = await mailTo(lin, 'question.addressed', qa, 'Lin@Example.com');
  r = await handle(reply({ inReplyTo: ma.messageId }));
  eq([r.outcome, db.one(`SELECT status FROM questions WHERE id=?`, qa).status], ['answered', 'open'], '法定人数没够：答复记下，事项还开着');
  assert(/已经记下，不会丢.*还在等 阿明.*自动生效/.test(sent[0]?.text ?? ''), '确认信：还在等谁（写名字）', sent[0]?.text);
  const fromZhou = [];
  for (let i = 0; i < 12; i++) fromZhou.push((await handle(reply({ from: 'zhou@example.com', body: `第 ${i} 封` }))).replied);
  eq(fromZhou.filter(Boolean).length, 9, '说明信给同一个地址一小时最多 10 封（前面「转发后别人回」已回过他一封；两边都有机器人时的后备闸）');
  const audits = db.all(`SELECT payload FROM audit_log WHERE action='mail_reply_received'`).map((x) => x.payload);
  assert(audits.length >= 10 && !audits.some((p) => /lin@|zhou@|mallory@|stranger@/i.test(p)), '每封都进审计，只记域名不记地址');
}

section('⑥ 答复令牌调不了接口');
{
  const q = question();
  const { token, tokenId } = mintReplyToken(db, { userId: lin, questionId: q, at: Date.now() });
  eq(authenticate(db, token), null, '看板 / CLI 的认证不认答复令牌');
  eq(authenticate(db, token, { mail: true })?.token_id, tokenId, '邮件答复那条路认');
  assert(!tokensOf(db, lin, { all: true }).some((t) => t.kind === 'mail'), '「我的会话与令牌」里不出现答复令牌');
  eq(mailReplyFor(db, { ch: { kind: 'email', target: 'x', userId: lin }, kind: 'question.addressed', ref: q, env: { ...ENV, IMAP_URL: '' } }), null, '没配收信：不签令牌');
}

section('⑦ 守护进程那一拍');
{
  const q = question();
  const m = await mailTo(lin, 'question.addressed', q, 'Lin@Example.com');
  const s = await fakeImap({ mails: [{ uid: 1, raw: reply({ inReplyTo: `si.r.${tokenOf(m)}@x.com`, body: '按创建时间' }), seen: false }] });
  sent.length = 0;
  const r = await pollMailReplies(db, { env: { ...ENV, IMAP_URL: `imap://u:p@127.0.0.1:${s.port}` }, sendMailFn });
  eq([r.fetched, r.results.map((x) => x.outcome), s.mails[0].seen], [1, ['answered'], true], '收一轮：答复生效，信标已读');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, q).status, 'answered', '事项了结');
  s.close();
  eq(await pollMailReplies(db, { env: { SMTP_URL: 'x', MAIL_FROM: 'y' } }), null, '没配 IMAP_URL：不收');
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
