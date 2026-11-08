// 邮件通道：零依赖 SMTP 发信（node:net / node:tls）。
//
// 配置从 .env 读（与其余部署级通道同一个口径：用户自填，系统只查在不在、不回显）：
//   SMTP_URL   smtps://用户:密码@smtp.example.com:465   —— 直接 TLS
//              smtp://用户:密码@smtp.example.com:587    —— 先明文连、STARTTLS 升级（服务器不支持 STARTTLS 就拒绝发，不降级）
//              smtp://127.0.0.1:25                      —— 本机中继：不升级、不认证（只有本机地址允许明文）
//   MAIL_FROM  发件人，例 SuperIntern <si@example.com>
//
// 纪律：
//   - 证书照常校验；明文连接上不发密码（本机地址除外）。
//   - 头里的值去掉回车换行（防头注入：标题来自事项正文，事项正文来自模型）。
//   - 正文 UTF-8 + base64，标题按 RFC 2047 编码；带 Auto-Submitted: auto-generated（RFC 3834），对方的自动回复不该回给我们。
//   - 密码不进日志、不进审计、不进报错（报错里只有主机名和 SMTP 的应答码）。

import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

const LOCAL = new Set(['127.0.0.1', '::1', 'localhost']);

/** 部署配了发信服务器（SMTP_URL + MAIL_FROM）才有邮件通道：没配时个人登记的邮箱推不出去，不能当「推得到」。 */
export const mailReady = (env = process.env) => !!(String(env.SMTP_URL ?? '').trim() && String(env.MAIL_FROM ?? '').trim());

/** 解析 SMTP_URL。返回 { host, port, secure, starttls, user, pass } 或抛错（错误里不带密码）。 */
export function parseSmtpUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new Error('SMTP_URL 写法不对（例：smtps://用户:密码@smtp.example.com:465）'); }
  if (!['smtp:', 'smtps:'].includes(u.protocol)) throw new Error('SMTP_URL 要以 smtp:// 或 smtps:// 开头');
  const secure = u.protocol === 'smtps:';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local = LOCAL.has(host);
  return { host, port: Number(u.port) || (secure ? 465 : 587), secure, starttls: !secure && !local, local,
    user: u.username ? decodeURIComponent(u.username) : null, pass: u.password ? decodeURIComponent(u.password) : null };
}

/** 从邮箱地址里取出 addr-spec（"名字 <a@b>" → a@b）。 */
export function addrOf(s) {
  const m = String(s ?? '').match(/<([^<>\s]+@[^<>\s]+)>/);
  return (m ? m[1] : String(s ?? '').trim()).toLowerCase();
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
/** RFC 2047：非 ASCII 的头值按 UTF-8 base64 编码（每段不超过 75 字符）。 */
export function encodeHeader(s) {
  s = oneLine(s);
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const out = []; let cur = '';
  for (const ch of s) {
    const next = cur + ch;
    if (Buffer.byteLength(next) > 45) { out.push(cur); cur = ch; } else cur = next;   // 45 字节 → base64 60 字符，加上 =?UTF-8?B??= 在 75 以内
  }
  if (cur) out.push(cur);
  return out.map((p) => `=?UTF-8?B?${Buffer.from(p).toString('base64')}?=`).join(' ');
}
const encodeName = (s) => { const m = String(s ?? '').match(/^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/); return m && m[1] ? `${encodeHeader(m[1])} <${m[2]}>` : oneLine(s); };

/** 拼一封信（CRLF 行尾，正文 base64）。返回 { raw, messageId }。 */
export function buildMessage({ from, to, subject, text, replyTo = null, inReplyTo = null, headers = {}, messageId = null, autoSubmitted = 'auto-generated', at = Date.now() }) {
  const domain = addrOf(from).split('@')[1] || 'localhost';
  messageId = messageId ? `<${oneLine(messageId).replace(/^<|>$/g, '')}>` : `<${randomBytes(12).toString('hex')}@${domain}>`;
  const h = [
    `From: ${encodeName(from)}`, `To: ${[].concat(to).map(encodeName).join(', ')}`, `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date(at).toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', `Auto-Submitted: ${autoSubmitted === 'auto-replied' ? 'auto-replied' : 'auto-generated'}`,
    ...(replyTo ? [`Reply-To: ${encodeName(replyTo)}`] : []),
    ...(inReplyTo ? [`In-Reply-To: ${oneLine(inReplyTo)}`, `References: ${oneLine(inReplyTo)}`] : []),
    ...Object.entries(headers).map(([k, v]) => `${k.replace(/[^A-Za-z0-9-]/g, '')}: ${oneLine(v)}`),
  ];
  const body = Buffer.from(String(text ?? '').replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return { raw: `${h.join('\r\n')}\r\n\r\n${body}`, messageId };
}

/** 一条 SMTP 会话：逐条命令、读多行应答。 */
function session(sock, timeoutMs) {
  let buf = '', waiting = null, closed = null;
  const lines = [];
  const pump = () => {
    // 多行应答：250-xxx … 250 xxx（第 4 个字符是空格才算完）
    const i = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
    if (i < 0 || !waiting) return;
    const got = lines.splice(0, i + 1);
    const w = waiting; waiting = null; clearTimeout(w.t);
    w.ok({ code: Number(got[i].slice(0, 3)), lines: got.map((l) => l.slice(4)) });
  };
  const onData = (d) => { buf += d.toString('utf8'); let k; while ((k = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, k).replace(/\r$/, '')); buf = buf.slice(k + 1); } pump(); };
  const onEnd = (e) => { closed = e ?? new Error('连接被对方关闭'); if (waiting) { const w = waiting; waiting = null; clearTimeout(w.t); w.no(closed); } };
  const attach = (s) => { s.on('data', onData); s.on('error', onEnd); s.on('close', () => onEnd()); };
  attach(sock);
  const read = () => new Promise((ok, no) => {
    if (closed) return no(closed);
    waiting = { ok, no, t: setTimeout(() => { waiting = null; no(new Error('SMTP 服务器没有应答（超时）')); }, timeoutMs) };
    pump();
  });
  return {
    read,
    send: async (line) => { sock.write(`${line}\r\n`); return read(); },
    write: (raw) => sock.write(raw),
    swap: (s) => { sock.removeAllListeners('data'); sock = s; attach(s); },
    get sock() { return sock; },
  };
}

const expect = (r, codes, what) => {
  if (!codes.includes(r.code)) throw Object.assign(new Error(`${what}：SMTP ${r.code} ${String(r.lines.join(' ')).slice(0, 160)}`), { smtpCode: r.code });
  return r;
};

/**
 * 发一封信。成功返回 { ok: true, messageId, accepted }；失败抛错（错误里没有密码）。
 * conn = parseSmtpUrl 的结果；tlsOptions 只给测试用（自签证书的假服务器）。
 */
export async function sendMail(conn, { from, to, subject, text, replyTo = null, inReplyTo = null, headers = {}, messageId = null, autoSubmitted, timeoutMs = 20_000, tlsOptions = {}, at } ) {
  const rcpts = [].concat(to).map(addrOf).filter(Boolean);
  if (!rcpts.length) throw new Error('没有收件人');
  const built = buildMessage({ from, to, subject, text, replyTo, inReplyTo, headers, messageId, autoSubmitted, at });
  const { raw } = built;
  const sock = conn.secure
    ? tls.connect({ host: conn.host, port: conn.port, servername: net.isIP(conn.host) ? undefined : conn.host, ...tlsOptions })
    : net.connect({ host: conn.host, port: conn.port });
  sock.setTimeout(timeoutMs, () => sock.destroy(new Error('SMTP 连接超时')));
  const s = session(sock, timeoutMs);
  const me = oneLine(hostname()).replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  try {
    expect(await s.read(), [220], '连接');
    let ehlo = expect(await s.send(`EHLO ${me}`), [250], 'EHLO');
    let encrypted = conn.secure;
    if (conn.starttls) {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new Error(`${conn.host} 不支持 STARTTLS：不在明文连接上发信（要明文请用本机中继 smtp://127.0.0.1）`);
      expect(await s.send('STARTTLS'), [220], 'STARTTLS');
      const up = tls.connect({ socket: s.sock, servername: net.isIP(conn.host) ? undefined : conn.host, ...tlsOptions });
      await new Promise((ok, no) => { up.once('secureConnect', ok); up.once('error', no); });
      s.swap(up); encrypted = true;
      ehlo = expect(await s.send(`EHLO ${me}`), [250], 'EHLO');
    }
    if (conn.user) {
      if (!encrypted && !conn.local) throw new Error('不在明文连接上发送密码');
      const mech = ehlo.lines.find((l) => /^AUTH\b/i.test(l))?.toUpperCase() ?? '';
      if (/\bPLAIN\b/.test(mech) || !/\bLOGIN\b/.test(mech)) {
        expect(await s.send(`AUTH PLAIN ${Buffer.from(`\0${conn.user}\0${conn.pass ?? ''}`).toString('base64')}`), [235], '登录（AUTH PLAIN）');
      } else {
        expect(await s.send('AUTH LOGIN'), [334], '登录（AUTH LOGIN）');
        expect(await s.send(Buffer.from(conn.user).toString('base64')), [334], '登录（用户名）');
        expect(await s.send(Buffer.from(conn.pass ?? '').toString('base64')), [235], '登录（密码）');
      }
    }
    expect(await s.send(`MAIL FROM:<${addrOf(from)}>`), [250], 'MAIL FROM');
    const accepted = [];
    for (const r of rcpts) { const x = await s.send(`RCPT TO:<${r}>`); if ([250, 251].includes(x.code)) accepted.push(r); }
    if (!accepted.length) throw new Error('收件人全部被服务器拒收');
    expect(await s.send('DATA'), [354], 'DATA');
    // 点填充：以 . 开头的行前面再加一个 .（base64 正文不会有，头里理论上也不会，照规矩做）
    s.write(`${raw.replace(/\r\n\./g, '\r\n..')}\r\n.\r\n`);
    expect(await s.read(), [250], '投递');
    try { await s.send('QUIT'); } catch { /* 对方先关也行 */ }
    return { ok: true, messageId: built.messageId, accepted };
  } finally { s.sock.destroy(); }
}
