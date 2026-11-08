// 邮件答复：把收到的一封信拆开 —— 信头、发件人、正文，再去掉引用的原文，只留回信人新写的那段。零依赖。
//
// 只做回信要用的那部分 RFC 5322 / MIME：
//   - 信头：折行还原，RFC 2047 编码词（=?gbk?B?…?= / =?utf-8?Q?…?=）解码，没编码的 8 位信头按 UTF-8 读；
//   - 正文：multipart 递归，取第一段不是附件的 text/plain，没有就取 text/html 去标签；
//   - 传输编码 base64 / quoted-printable / 7bit / 8bit；字符集交给 TextDecoder（gbk、gb18030、big5、iso-2022-jp 都认），
//     gb2312 按 gb18030 读（gb2312 是它的子集，很多客户端标 gb2312 实际发的是 gbk 字）。
// 去引用（replyText）认常见客户端的写法：Gmail / Apple Mail 的 "On … wrote:"、中文的 "在 … 写道："、
// Outlook 的分隔线和 "From: / 发件人：" 块、QQ / 163 的 "原始邮件"、每行 > 开头的引用、签名分隔 "-- "。

const CRLF2 = /\r?\n\r?\n/;
// 信头和 multipart 是按 latin1 读进来的字节：不能用 trim()，它会把 UTF-8 字的尾字节 0xA0（latin1 里是不换行空格）当空白削掉
const atrim = (s) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

/** 字符集名 → TextDecoder 认得的名字；认不得退到 UTF-8。 */
function decoder(charset) {
  let cs = String(charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  if (['gb2312', 'gbk', 'x-gbk', 'cp936', 'euc-cn'].includes(cs)) cs = 'gb18030';
  // us-ascii 是 UTF-8 的子集：标 us-ascii（或没写 Content-Type、按规范默认 us-ascii）却直接塞了 UTF-8 中文的信很常见
  if (['utf8', 'us-ascii', 'ascii', 'ansi_x3.4-1968'].includes(cs)) cs = 'utf-8';
  try { return new TextDecoder(cs); } catch { return new TextDecoder('utf-8'); }
}
const decodeBytes = (buf, charset) => decoder(charset).decode(buf);

/** quoted-printable → 字节。 */
export function decodeQP(s, { header = false } = {}) {
  const str = String(s);
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '=' ) {
      if (str[i + 1] === '\r' && str[i + 2] === '\n') { i += 2; continue; }   // 软换行
      if (str[i + 1] === '\n') { i += 1; continue; }
      const hex = str.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 2; continue; }
      out.push(0x3d); continue;
    }
    if (header && c === '_') { out.push(0x20); continue; }
    const code = c.charCodeAt(0);
    if (code < 256) out.push(code);
    else out.push(...Buffer.from(c, 'utf8'));
  }
  return Buffer.from(out);
}

/** RFC 2047：信头里的编码词解码；相邻两个编码词之间的空白去掉（规范要求）。 */
export function decodeWords(s) {
  return String(s ?? '')
    .replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?)/g, '$1')
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (all, cs, enc, txt) => {
      try {
        const bytes = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : decodeQP(txt, { header: true });
        return decodeBytes(bytes, cs.split('*')[0]);
      } catch { return all; }
    });
}

/** 信头一段（latin1 读进来的）→ [{ name, value }]，折行已还原，值已解码。 */
function parseHeaders(block) {
  const lines = block.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length) { out[out.length - 1].raw += ` ${atrim(line)}`; continue; }
    const k = line.indexOf(':');
    if (k <= 0) continue;
    out.push({ name: atrim(line.slice(0, k)).toLowerCase(), raw: atrim(line.slice(k + 1)) });
  }
  return out.map(({ name, raw }) => {
    // 没编码的 8 位信头（不少客户端直接塞 UTF-8）：latin1 读进来的字节按 UTF-8 还原
    const bytes = Buffer.from(raw, 'latin1');
    const asText = /[\x80-\xff]/.test(raw) ? bytes.toString('utf8') : raw;
    return { name, value: decodeWords(asText) };
  });
}

/** "text/plain; charset=gbk; name=\"a.txt\"" → { type, params }。 */
export function parseParams(v) {
  const parts = String(v ?? '').split(';');
  const type = (parts.shift() ?? '').trim().toLowerCase();
  const params = {};
  for (const p of parts) {
    const k = p.indexOf('=');
    if (k < 0) continue;
    params[p.slice(0, k).trim().toLowerCase()] = p.slice(k + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return { type, params };
}

function decodeBody(buf, cte) {
  const e = String(cte ?? '7bit').trim().toLowerCase();
  if (e === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') return decodeQP(buf.toString('latin1'));
  return buf;
}

const htmlToText = (h) => String(h)
  .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, '\n')
  .replace(/<blockquote[\s\S]*$/i, '')            // 引用块（Gmail 的 gmail_quote 也在 blockquote 里）往后都不要
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** 一段（信本身或 multipart 的一部分）→ { text, html }（各取第一个）。 */
function walk(buf, headers, depth = 0) {
  const h = (n) => headers.find((x) => x.name === n)?.value ?? '';
  const ct = parseParams(h('content-type') || 'text/plain; charset=us-ascii');
  const disp = parseParams(h('content-disposition'));
  if (ct.type.startsWith('multipart/') && ct.params.boundary && depth < 8) {
    const b = `--${ct.params.boundary}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const s = buf.toString('latin1');
    // 分隔行把正文切成段：第一个分隔行之前是序言，结束分隔行（--b--）之后是尾声，两样都不要
    const marks = [...s.matchAll(new RegExp(`(?:^|\\r?\\n)${b}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g'))];
    const chunks = [];
    for (let i = 0; i < marks.length && !marks[i][1]; i++) chunks.push(s.slice(marks[i].index + marks[i][0].length, marks[i + 1]?.index ?? s.length));
    let text = null, html = null;
    for (const c of chunks) {
      const part = c.replace(/^\r?\n/, '');
      if (!atrim(part)) continue;
      const m = CRLF2.exec(part);
      const head = m ? part.slice(0, m.index) : part;
      const body = m ? part.slice(m.index + m[0].length) : '';
      const r = walk(Buffer.from(body, 'latin1'), parseHeaders(head), depth + 1);
      text ??= r.text; html ??= r.html;
    }
    return { text, html };
  }
  if (disp.type === 'attachment') return { text: null, html: null };
  const decoded = decodeBody(buf, h('content-transfer-encoding'));
  if (ct.type === 'text/plain' || ct.type === '') return { text: decodeBytes(decoded, ct.params.charset), html: null };
  if (ct.type === 'text/html') return { text: null, html: decodeBytes(decoded, ct.params.charset) };
  return { text: null, html: null };
}

/** 地址列表 → 小写的 addr-spec 数组（"阿青 <Lin@X.com>, b@y" → ['lin@x.com','b@y']）。 */
export function addresses(v) {
  const out = [];
  for (const m of String(v ?? '').matchAll(/<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/g)) out.push((m[1] ?? m[2]).toLowerCase());
  return out;
}

/**
 * 拆一封信。
 * @param {Buffer|string} raw
 * @returns {{ header: (n: string) => string, headers: (n: string) => string[], from: string|null, to: string[], subject: string,
 *   messageId: string|null, inReplyTo: string[], references: string[], text: string }}
 */
export function parseMail(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  const s = buf.toString('latin1');
  const m = CRLF2.exec(s);
  const headBlock = m ? s.slice(0, m.index) : s;
  const body = m ? buf.subarray(Buffer.byteLength(s.slice(0, m.index + m[0].length), 'latin1')) : Buffer.alloc(0);
  const headers = parseHeaders(headBlock);
  const all = (n) => headers.filter((x) => x.name === n).map((x) => x.value);
  const one = (n) => all(n)[0] ?? '';
  const r = walk(body, headers);
  const ids = (v) => [...String(v ?? '').matchAll(/<([^<>\s]+)>/g)].map((x) => x[1]);
  return {
    header: one, headers: all,
    from: addresses(one('from'))[0] ?? null,
    to: [...addresses(all('to').join(',')), ...addresses(all('cc').join(',')), ...addresses(all('delivered-to').join(',')), ...addresses(all('x-original-to').join(','))],
    subject: one('subject'),
    messageId: ids(one('message-id'))[0] ?? null,
    inReplyTo: ids(one('in-reply-to')),
    references: ids(all('references').join(' ')),
    text: (r.text ?? (r.html != null ? htmlToText(r.html) : '')).replace(/\r\n/g, '\n'),
  };
}

// 引用原文从哪一行开始：命中的那一行连同之后全部去掉
const QUOTE_HEADS = [
  /^\s*On\b[^\n]{0,300}?(?:\n[^\n]{0,200}?)?\bwrote:\s*$/m,                     // Gmail / Apple Mail（长的会折成两行）
  /^\s*在[^\n]{0,300}?写道\s*[:：]\s*$/m,                                         // Gmail 中文、163、Foxmail
  /^\s*[-_=]{2,}\s*(?:Original Message|原始邮件|原始郵件|Forwarded message|转发邮件|轉寄郵件)\s*[-_=]{2,}/mi,   // Outlook 老版、QQ、163
  /^\s*_{10,}\s*$/m,                                                                // Outlook：一整行下划线，下面是 From: 块
  /^\s*(?:From|发件人|寄件者|發件人)\s*[:：][^\n]*\n(?:[^\n]*\n){0,2}\s*(?:Sent|Date|发送时间|日期|寄件日期|時間)\s*[:：]/mi,
];
const TRAILERS = /^\s*(?:Sent from my \w+|发自我的\s*\S+|从我的\s*\S+发送|Get Outlook for \w+)\s*$/i;

/** 回信正文 → 回信人新写的那段（去掉引用原文、签名、"发自我的 iPhone"）。 */
export function replyText(text) {
  let t = String(text ?? '').replace(/\r\n/g, '\n');
  let cut = t.length;
  for (const re of QUOTE_HEADS) { const m = re.exec(t); if (m && m.index < cut) cut = m.index; }
  t = t.slice(0, cut);
  const lines = [];
  for (const line of t.split('\n')) {
    if (/^-- ?$/.test(line)) break;          // 签名分隔（RFC 3676 是 "-- "，不少客户端吃掉了尾空格）
    if (/^\s*>/.test(line)) continue;        // 每行 > 开头的引用
    lines.push(line);
  }
  while (lines.length && (!lines.at(-1).trim() || TRAILERS.test(lines.at(-1)))) lines.pop();
  return lines.join('\n').trim();
}
