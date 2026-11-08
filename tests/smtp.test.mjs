// 邮件通道：零依赖 SMTP 发信。用一个本机的假 SMTP 服务器对话。
//
// ① SMTP_URL 解析：smtps 直接 TLS、smtp 走 STARTTLS、本机中继不升级；错误里不带密码
// ② 信的样子：标题 RFC 2047、正文 base64、Auto-Submitted、Reply-To；头注入挡掉
// ③ 对话：AUTH PLAIN / LOGIN、多行应答、收件人部分被拒、点填充
// ④ 不降级：服务器不给 STARTTLS 就不发；明文连接上不发密码（本机中继除外）
//
// 跑：node tests/smtp.test.mjs

import net from 'node:net';
import { parseSmtpUrl, buildMessage, sendMail, encodeHeader, addrOf } from '../src/core/smtp.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = async (p, re, m) => { try { await p; bad(m, '没有抛'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `抛了但不是预期：${e.message}`); } };

/** 假 SMTP 服务器：记下收到的命令与信；ext = EHLO 宣告的扩展；reject = 拒收的收件人。 */
function fakeSmtp({ ext = ['AUTH PLAIN LOGIN'], reject = [], authOk = true } = {}) {
  const log = [], mails = [];
  const server = net.createServer((sock) => {
    let buf = '', data = null, stage = null;
    const say = (s) => sock.write(`${s}\r\n`);
    say('220 fake ESMTP');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let k;
      while ((k = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 2);
        if (data !== null) {
          if (line === '.') { mails.push(data.join('\r\n')); data = null; say('250 queued'); } else data.push(line);
          continue;
        }
        log.push(line);
        if (stage === 'user') { stage = 'pass'; say('334 UGFzc3dvcmQ6'); continue; }
        if (stage === 'pass') { stage = null; say(authOk ? '235 ok' : '535 bad'); continue; }
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') { sock.write(['250-fake', ...ext.map((e) => `250-${e}`), '250 SIZE 1000000'].join('\r\n') + '\r\n'); }
        else if (cmd === 'AUTH' && /PLAIN/i.test(line)) say(authOk ? '235 ok' : '535 bad');
        else if (cmd === 'AUTH') { stage = 'user'; say('334 VXNlcm5hbWU6'); }
        else if (cmd === 'MAIL') say('250 ok');
        else if (cmd === 'RCPT') say(reject.some((r) => line.includes(r)) ? '550 no such user' : '250 ok');
        else if (cmd === 'DATA') { data = []; say('354 go'); }
        else if (cmd === 'QUIT') { say('221 bye'); sock.end(); }
        else if (cmd === 'STARTTLS') say('454 no tls here');
        else say('500 what');
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, log, mails, close: () => server.close() })));
}

section('① SMTP_URL');
{
  eq(parseSmtpUrl('smtps://si%40x.com:p%40ss@smtp.x.com'), { host: 'smtp.x.com', port: 465, secure: true, starttls: false, local: false, user: 'si@x.com', pass: 'p@ss' }, 'smtps：直接 TLS，默认 465，用户名密码解码');
  eq(parseSmtpUrl('smtp://u:p@smtp.x.com').starttls, true, 'smtp + 远端：必须 STARTTLS（默认 587）');
  eq(parseSmtpUrl('smtp://127.0.0.1:25').starttls, false, '本机中继：不升级');
  try { parseSmtpUrl('http://u:secret@x'); bad('别的协议要拒'); } catch (e) { assert(!/secret/.test(e.message), '写错了报错里不带密码', e.message); }
}

section('② 信的样子');
{
  eq(encodeHeader('hello'), 'hello', 'ASCII 原样');
  assert(/^=\?UTF-8\?B\?/.test(encodeHeader('[SuperIntern] 规格取舍：列表默认按什么排序？')), '中文标题 RFC 2047');
  const long = encodeHeader('中'.repeat(60));
  assert(long.split(' ').every((p) => p.length <= 75), '长标题分段，每段不超过 75 字符', long);
  const { raw } = buildMessage({ from: 'SuperIntern <si@x.com>', to: 'Lin <lin@x.com>', subject: '标题\r\nBcc: evil@x.com', text: '第一行\n第二行', replyTo: 'reply+abc@x.com', at: Date.parse('2026-11-11T10:00:00Z') });
  const [head, body] = raw.split('\r\n\r\n');
  assert(!/^Bcc:/m.test(head), '标题里的回车换行去掉（头注入挡掉）');
  assert(/^Auto-Submitted: auto-generated$/m.test(head) && /^Reply-To: reply\+abc@x\.com$/m.test(head) && /^Content-Transfer-Encoding: base64$/m.test(head), 'Auto-Submitted、Reply-To、base64 正文');
  eq(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), '第一行\r\n第二行', '正文解得回来，行尾是 CRLF');
  eq(addrOf('阿青 <Lin@X.com>'), 'lin@x.com', '取地址：去名字、转小写');
}

section('③ 对话');
{
  const s = await fakeSmtp();
  const r = await sendMail({ host: '127.0.0.1', port: s.port, secure: false, starttls: false, local: true, user: 'u', pass: 'p' },
    { from: 'si@x.com', to: ['a@x.com', 'b@x.com'], subject: 't', text: '.hidden\nok' });
  eq([r.ok, r.accepted], [true, ['a@x.com', 'b@x.com']], '投递成功，两个收件人都收');
  assert(s.log.some((l) => l === `AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`), 'AUTH PLAIN');
  eq(s.mails.length, 1, '服务器收到一封');
  s.close();
  const s2 = await fakeSmtp({ ext: ['AUTH LOGIN'], reject: ['b@x.com'] });
  const r2 = await sendMail({ host: '127.0.0.1', port: s2.port, local: true, user: 'u', pass: 'p' }, { from: 'si@x.com', to: ['a@x.com', 'b@x.com'], subject: 't', text: 'x' });
  eq(r2.accepted, ['a@x.com'], '只宣告 LOGIN：走 AUTH LOGIN；被拒的收件人不算');
  s2.close();
  const s3 = await fakeSmtp({ authOk: false });
  await rejects(sendMail({ host: '127.0.0.1', port: s3.port, local: true, user: 'u', pass: 'hunter2' }, { from: 'si@x.com', to: 'a@x.com', subject: 't', text: 'x' }), /^(?!.*hunter2).*535/, '登录失败：报 SMTP 应答码，报错里不带密码');
  s3.close();
}

section('④ 不降级');
{
  const s = await fakeSmtp({ ext: ['AUTH PLAIN'] });
  await rejects(sendMail({ host: '127.0.0.1', port: s.port, secure: false, starttls: true, local: false, user: 'u', pass: 'p' }, { from: 'si@x.com', to: 'a@x.com', subject: 't', text: 'x' }),
    /不支持 STARTTLS/, '要升级而服务器不给 STARTTLS：不发（不降级成明文）');
  await rejects(sendMail({ host: '127.0.0.1', port: s.port, secure: false, starttls: false, local: false, user: 'u', pass: 'p' }, { from: 'si@x.com', to: 'a@x.com', subject: 't', text: 'x' }),
    /明文连接上发送密码/, '非本机的明文连接：不发密码');
  assert(!s.log.some((l) => /^AUTH/i.test(l)), '两次都没把 AUTH 发出去');
  s.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
