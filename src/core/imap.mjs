// 邮件答复：零依赖 IMAP 收信（node:net / node:tls），只做轮询收件箱要用的几条命令。
//
// 配置从 .env 读：
//   IMAP_URL   imaps://用户:密码@imap.example.com:993   —— 直接 TLS
//              imap://用户:密码@imap.example.com:143    —— 先明文连、STARTTLS 升级（服务器不支持就不收，不降级）
//              imap://用户:密码@127.0.0.1:1143          —— 本机（只有本机地址允许明文，测试与本机桥接用）
//   邮箱文件夹默认 INBOX；要换写在路径上：imaps://…/Replies
//
// 一次轮询：登录 → SELECT → UID SEARCH UNSEEN → 逐封 UID FETCH (BODY.PEEK[])（不改已读）→ 交给 handle →
// 处理完 UID STORE +FLAGS.SILENT (\Seen) → LOGOUT。信不删：留在邮箱里，人能翻得到。
// 纪律与 smtp.mjs 一样：证书照常校验；明文连接上不发密码（本机除外）；密码不进报错。

import net from 'node:net';
import tls from 'node:tls';

const LOCAL = new Set(['127.0.0.1', '::1', 'localhost']);

/** 解析 IMAP_URL。返回 { host, port, secure, starttls, local, user, pass, mailbox } 或抛错（错误里不带密码）。 */
export function parseImapUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { throw new Error('IMAP_URL 写法不对（例：imaps://用户:密码@imap.example.com:993）'); }
  if (!['imap:', 'imaps:'].includes(u.protocol)) throw new Error('IMAP_URL 要以 imap:// 或 imaps:// 开头');
  const secure = u.protocol === 'imaps:';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local = LOCAL.has(host);
  const mailbox = decodeURIComponent(u.pathname.replace(/^\/+/, '')) || 'INBOX';
  return { host, port: Number(u.port) || (secure ? 993 : 143), secure, starttls: !secure && !local, local,
    user: u.username ? decodeURIComponent(u.username) : null, pass: u.password ? decodeURIComponent(u.password) : null, mailbox };
}

/** IMAP 的带引号字符串（只用于 ASCII 可见字符；别的走 AUTHENTICATE PLAIN）。 */
const quote = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

/**
 * 一条 IMAP 会话：按行读应答，行尾 {n} 的字面量按字节数原样收（信的正文就在字面量里）。
 * 每条应答 = { text: 这一行（字面量处只留 {n}），lits: [Buffer…] }。
 */
function session(sock, timeoutMs) {
  let buf = Buffer.alloc(0), closed = null, waiting = null;
  const queue = [];
  const tryParse = () => {
    let pos = 0; const parts = [], lits = [];
    for (;;) {
      const k = buf.indexOf('\r\n', pos);
      if (k < 0) return null;
      const seg = buf.subarray(pos, k).toString('utf8');
      const m = seg.match(/\{(\d+)\}$/);
      if (!m) { parts.push(seg); buf = buf.subarray(k + 2); return { text: parts.join(''), lits }; }
      const n = Number(m[1]), start = k + 2;
      if (buf.length < start + n) return null;
      parts.push(seg); lits.push(Buffer.from(buf.subarray(start, start + n))); pos = start + n;
    }
  };
  const pump = () => {
    for (let r; (r = tryParse());) queue.push(r);
    if (waiting && queue.length) { const w = waiting; waiting = null; clearTimeout(w.t); w.ok(queue.shift()); }
  };
  const onData = (d) => { buf = Buffer.concat([buf, d]); pump(); };
  const onEnd = (e) => { closed = e ?? new Error('连接被对方关闭'); if (waiting) { const w = waiting; waiting = null; clearTimeout(w.t); w.no(closed); } };
  const attach = (s) => { s.on('data', onData); s.on('error', onEnd); s.on('close', () => onEnd()); };
  attach(sock);
  const next = () => new Promise((ok, no) => {
    if (queue.length) return ok(queue.shift());
    if (closed) return no(closed);
    waiting = { ok, no, t: setTimeout(() => { waiting = null; no(new Error('IMAP 服务器没有应答（超时）')); }, timeoutMs) };
  });
  let seq = 0;
  /** 发一条带标签的命令，收齐到同标签的完成应答。onCont：服务器要后续数据（+ 开头）时调，返回要发的那一行。 */
  const cmd = async (line, { onCont } = {}) => {
    const tag = `a${++seq}`;
    sock.write(`${tag} ${line}\r\n`);
    const untagged = [];
    for (;;) {
      const r = await next();
      if (r.text.startsWith('+')) { if (!onCont) throw new Error(`IMAP 服务器要后续数据，但这条命令没有：${line.split(' ')[0]}`); sock.write(`${onCont(r)}\r\n`); continue; }
      if (r.text.startsWith(`${tag} `)) {
        const status = r.text.slice(tag.length + 1).split(' ')[0].toUpperCase();
        if (status !== 'OK') throw Object.assign(new Error(`${line.split(' ')[0]}：IMAP ${status} ${r.text.slice(tag.length + 1 + status.length).trim().slice(0, 160)}`), { imapStatus: status });
        return untagged;
      }
      untagged.push(r);
    }
  };
  return {
    next, cmd,
    swap: (s) => { sock.removeAllListeners('data'); sock = s; attach(s); },
    get sock() { return sock; },
  };
}

const capsOf = (lines) => {
  const l = lines.map((r) => r.text).find((t) => /^\*\s+(OK\s+\[)?CAPABILITY\b/i.test(t)) ?? '';
  return new Set(l.replace(/^\*\s+(OK\s+\[)?CAPABILITY\s*/i, '').replace(/\].*$/, '').toUpperCase().split(/\s+/).filter(Boolean));
};

/**
 * 收一轮：没读过的信逐封交给 handle(raw: Buffer, { uid })；handle 正常返回（不管处理结果是什么）就标已读。
 * handle 抛错：这封也标已读（坏信不能每一拍都重来一遍），错误收进 errors。
 * @returns {{ fetched: number, errors: Array<{uid, error}> }}
 */
export async function fetchUnseen(conn, handle, { max = 20, timeoutMs = 20_000, tlsOptions = {} } = {}) {
  const sock = conn.secure
    ? tls.connect({ host: conn.host, port: conn.port, servername: net.isIP(conn.host) ? undefined : conn.host, ...tlsOptions })
    : net.connect({ host: conn.host, port: conn.port });
  sock.setTimeout(timeoutMs, () => sock.destroy(new Error('IMAP 连接超时')));
  const s = session(sock, timeoutMs);
  const errors = [];
  let fetched = 0;
  try {
    const hello = await s.next();
    if (!/^\*\s+(OK|PREAUTH)\b/i.test(hello.text)) throw new Error(`连接：IMAP ${hello.text.slice(0, 120)}`);
    let caps = capsOf([hello]);
    if (!caps.size) caps = capsOf(await s.cmd('CAPABILITY'));
    let encrypted = conn.secure;
    if (conn.starttls) {
      if (!caps.has('STARTTLS')) throw new Error(`${conn.host} 不支持 STARTTLS：不在明文连接上收信（要明文只能连本机地址）`);
      await s.cmd('STARTTLS');
      const up = tls.connect({ socket: s.sock, servername: net.isIP(conn.host) ? undefined : conn.host, ...tlsOptions });
      await new Promise((ok, no) => { up.once('secureConnect', ok); up.once('error', no); });
      s.swap(up); encrypted = true;
      caps = capsOf(await s.cmd('CAPABILITY'));
    }
    if (!/^\*\s+PREAUTH\b/i.test(hello.text)) {
      if (!conn.user) throw new Error('IMAP_URL 里没有用户名和密码');
      if (!encrypted && !conn.local) throw new Error('不在明文连接上发送密码');
      const asciiSafe = /^[\x21-\x7e ]*$/.test(`${conn.user}${conn.pass ?? ''}`);
      if (caps.has('AUTH=PLAIN') || !asciiSafe) {
        const payload = Buffer.from(`\0${conn.user}\0${conn.pass ?? ''}`).toString('base64');
        await s.cmd('AUTHENTICATE PLAIN', { onCont: () => payload }).catch((e) => { throw new Error(`登录（AUTHENTICATE PLAIN）：IMAP ${e.imapStatus ?? ''}`.trim()); });
      } else {
        await s.cmd(`LOGIN ${quote(conn.user)} ${quote(conn.pass ?? '')}`).catch((e) => { throw new Error(`登录（LOGIN）：IMAP ${e.imapStatus ?? ''}`.trim()); });
      }
    }
    await s.cmd(`SELECT ${quote(conn.mailbox ?? 'INBOX')}`);
    const found = await s.cmd('UID SEARCH UNSEEN');
    const uids = found.map((r) => r.text).filter((t) => /^\*\s+SEARCH\b/i.test(t))
      .flatMap((t) => t.replace(/^\*\s+SEARCH\s*/i, '').split(/\s+/).filter((x) => /^\d+$/.test(x))).map(Number).sort((a, b) => a - b).slice(0, max);
    for (const uid of uids) {
      const got = await s.cmd(`UID FETCH ${uid} (BODY.PEEK[])`);
      const r = got.find((x) => /^\*\s+\d+\s+FETCH\b/i.test(x.text) && x.lits.length);
      if (!r) continue;
      fetched++;
      try { await handle(r.lits[0], { uid }); } catch (e) { errors.push({ uid, error: String(e?.message ?? e).slice(0, 200) }); }
      await s.cmd(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`);
    }
    try { await s.cmd('LOGOUT'); } catch { /* 对方先关也行 */ }
    return { fetched, errors };
  } finally { s.sock.destroy(); }
}
