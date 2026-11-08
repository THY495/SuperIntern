// 通知适配器
//
// 跑：node tests/notify.test.mjs
//
// 断言的是纪律：通道从 env 读、空值跳过；各家请求形状对；回执进审计但**不记 URL**；失败不抛。

import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { channelsFromEnv, buildRequest, notify, CHANNEL_ENV } from '../src/core/notify.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, now());
  return { db, taskId };
}

section('1. 通道从 env 读；空值跳过；--notify 追加');
{
  eq(channelsFromEnv({}).length, 0, '什么都没配 → 没有通道');
  const ch = channelsFromEnv({ NTFY_URL: 'https://ntfy.sh/t1', FEISHU_WEBHOOK: '  ', DINGTALK_WEBHOOK: 'https://oapi.dingtalk.com/robot/send?access_token=SECRET' }, 'notify-send');
  eq(ch.map((c) => c.kind).join(','), 'ntfy,dingtalk,cmd', '空白的飞书跳过；--notify 变成 cmd 通道');
  eq(Object.keys(CHANNEL_ENV).length, 6, '六种通道（含邮件）');
}

section('2. 各家请求形状');
{
  const n = buildRequest({ kind: 'ntfy', target: 'https://ntfy.sh/t' }, { title: '标题', text: '正文' });
  eq(n.init.body, '正文', 'ntfy：正文即 body');
  assert(n.init.headers.title === encodeURIComponent('标题'), 'ntfy：Title 头（非 ASCII 要编码）');
  const f = JSON.parse(buildRequest({ kind: 'feishu', target: 'x' }, { title: 'a', text: 'b' }).init.body);
  eq(f.msg_type, 'text', '飞书 msg_type=text'); eq(f.content.text, 'a\nb', '飞书正文 = 标题 + 换行 + 正文');
  const d = JSON.parse(buildRequest({ kind: 'dingtalk', target: 'x' }, { title: 'a', text: 'b' }).init.body);
  eq(d.msgtype, 'text', '钉钉 msgtype=text'); eq(d.text.content, 'a\nb', '钉钉正文');
  const w = JSON.parse(buildRequest({ kind: 'wecom', target: 'x' }, { title: 'a', text: 'b' }).init.body);
  eq(w.msgtype, 'text', '企微 msgtype=text');
  try { buildRequest({ kind: 'sms', target: 'x' }, { title: 'a', text: 'b' }); bad('未知通道要抛'); } catch { ok('未知通道要抛'); }
  // 事项链接：正文末尾单独一行；ntfy 另设点通知就打开
  const nl = buildRequest({ kind: 'ntfy', target: 'https://ntfy.sh/t' }, { title: 't', text: '正文', link: 'https://si.lan/#q/q_1' });
  eq(nl.init.headers.click, 'https://si.lan/#q/q_1', 'ntfy：Click 头 = 事项链接（点通知直接打开）');
  eq(nl.init.body, '正文\n\nhttps://si.lan/#q/q_1', 'ntfy：正文末尾带链接');
  eq(JSON.parse(buildRequest({ kind: 'feishu', target: 'x' }, { title: 'a', text: 'b', link: 'https://si.lan/#inbox' }).init.body).content.text, 'a\nb\n\nhttps://si.lan/#inbox', '飞书：链接单独一行（会被变成可点的）');
  eq(buildRequest({ kind: 'ntfy', target: 'https://ntfy.sh/t' }, { title: 't', text: 'x' }).init.headers.click, undefined, '没有链接：不带 Click 头');
}

section('3. 发送：回执进审计、不记 URL；HTTP 200 但 code≠0 算失败；网络错不抛；cmd 通道走 spawn');
{
  const { db, taskId } = fixture();
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push(url);
    if (url.includes('ntfy')) return { ok: true, status: 200, json: async () => ({}) };
    if (url.includes('feishu')) return { ok: true, status: 200, json: async () => ({ code: 19001, msg: 'param invalid' }) };
    if (url.includes('dingtalk')) throw new Error('ECONNRESET');
    return { ok: true, status: 200, json: async () => ({ errcode: 0 }) };
  };
  const spawned = [];
  const spawn = (cmd, args) => { spawned.push({ cmd, args }); return { status: 0 }; };
  const channels = [
    { kind: 'ntfy', target: 'https://ntfy.sh/topic-SECRET' },
    { kind: 'feishu', target: 'https://open.feishu.cn/open-apis/bot/v2/hook/SECRET' },
    { kind: 'dingtalk', target: 'https://oapi.dingtalk.com/robot/send?access_token=SECRET' },
    { kind: 'wecom', target: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRET' },
    { kind: 'cmd', target: 'node "C:/my dir/sink.cjs" --quiet' },
  ];
  const rs = await notify(db, { taskId, kind: 'report', title: 'T', text: 'X', ref: 'rp_1', channels, fetchFn, spawn });
  eq(rs.length, 5, '五条回执');
  eq(rs.map((r) => `${r.kind}:${r.ok}`).join(','), 'ntfy:true,feishu:false,dingtalk:false,wecom:true,cmd:true', '成败判定：ntfy 过，飞书 code≠0 败，钉钉网络错败，企微 errcode=0 过，cmd 退出 0 过');
  assert(rs[1].error.includes('param invalid'), '失败原因带回');
  eq(spawned[0].cmd, 'node', 'cmd 通道：命令行拆成 argv，第一个是可执行文件');
  eq(spawned[0].args.join('|'), `C:/my dir/sink.cjs|--quiet|T|${taskId}|rp_1`, 'cmd 参数：命令自带的参数（引号内空白保留）+ <title> <taskId> <ref>');
  const rows = db.all(`SELECT payload FROM audit_log WHERE action='notification_sent' AND target_id=?`, taskId).map((r) => r.payload);
  eq(rows.length, 5, '每条通道一行回执审计');
  assert(rows.every((p) => !p.includes('SECRET')), '审计里没有 webhook URL / 密钥');
  assert(rows.some((p) => p.includes('"host":"ntfy.sh"')), '只记主机名');
  assert(rows.every((p) => JSON.parse(p).notifyKind === 'report' && JSON.parse(p).ref === 'rp_1'), '回执带通知种类与引用');
  const empty = await notify(db, { taskId, kind: 'x', title: 't', text: 'x', channels: [], fetchFn });
  eq(empty.length, 0, '没有通道 → 什么都不发，不报错');
  db.close();
}

section('3b. 邮件通道：要配了发信服务器才算通道；发信走 SMTP，审计只记域名');
{
  const SMTP = { SMTP_URL: 'smtps://u:pw-SECRET@smtp.x.com', MAIL_FROM: 'SuperIntern <si@x.com>' };
  eq(channelsFromEnv({ MAIL_TO: 'ops@x.com' }).length, 0, '只填 MAIL_TO、没配发信服务器 → 不算通道');
  eq(channelsFromEnv({ MAIL_TO: 'ops@x.com', ...SMTP }).map((c) => c.kind).join(','), 'email', 'SMTP_URL + MAIL_FROM + MAIL_TO → 一条邮件通道');
  const { db, taskId } = fixture();
  const sent = [];
  const sendMailFn = async (conn, m) => { sent.push({ conn, m }); return { ok: true }; };
  const rs = await notify(db, { taskId, kind: 'question.addressed', title: '[SuperIntern] 规格取舍', text: '正文', ref: 'q_9', link: 'https://si.lan/#q/q_9',
    channels: [{ kind: 'email', target: 'Lin@Example.com' }], env: SMTP, sendMailFn });
  eq(rs.map((r) => `${r.kind}:${r.ok}`).join(','), 'email:true', '投递成功');
  eq(sent[0].conn.host, 'smtp.x.com', '发信服务器从 env 的 SMTP_URL 解析');
  eq(sent[0].m.from, SMTP.MAIL_FROM, '发件人 = MAIL_FROM');
  eq(sent[0].m.text, '正文\n\nhttps://si.lan/#q/q_9', '正文末尾带事项链接');
  eq(sent[0].m.headers['X-SuperIntern-Ref'], 'q_9', '信头带事项引用');
  const audit = db.all(`SELECT payload FROM audit_log WHERE action='notification_sent' AND target_id=?`, taskId).map((r) => r.payload);
  assert(audit.some((p) => p.includes('"host":"example.com"')) && !audit.some((p) => /lin@|SECRET/i.test(p)), '审计只记收件域名，不记地址和密码');
  const failing = await notify(db, { taskId, kind: 'x', title: 't', text: 'x', channels: [{ kind: 'email', target: 'a@x.com' }], env: SMTP,
    sendMailFn: async () => { throw Object.assign(new Error('MAIL FROM：SMTP 550 rejected'), { smtpCode: 550 }); } });
  eq(`${failing[0].ok}:${failing[0].status}`, 'false:550', '发信失败：不抛，回执带 SMTP 应答码');
  db.close();
}
{
  // 个人登记的邮箱：没配发信服务器时不算「推得到」
  const { channelsFor, mailReady } = await import('../src/core/signals.mjs');
  const { setUserChannel, channelHost } = await import('../src/core/users.mjs');
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  setUserChannel(db, { userId, kind: 'email', target: 'lin@example.com', byUserId: userId });
  eq(mailReady({}), false, 'mailReady：没配 → false');
  eq(channelsFor(db, [userId], { env: {} }).length, 0, '没配发信服务器：登记的邮箱不算通道');
  eq(channelsFor(db, [userId], { env: { SMTP_URL: 'smtp://127.0.0.1:25', MAIL_FROM: 'si@x.com' } }).map((c) => c.kind).join(','), 'email', '配了：算一条邮件通道');
  eq(channelHost('lin@Example.com'), 'example.com', '成员页只显示邮箱的域名');
  try { setUserChannel(db, { userId, kind: 'email', target: 'not-an-address', byUserId: userId }); bad('写错的邮箱要拒'); } catch { ok('写错的邮箱要拒'); }
  db.close();
}

section('4. 退出原因 → 通知：只覆盖要人动手的几种；正文里带下一步命令');
{
  const { outcomeNotice } = await import('../src/core/notify.mjs');
  const s = outcomeNotice({ kind: 'suspended', questions: [{ id: 'q_1', level: 2, text: '要不要改接口？' }] }, 't_1');
  assert(s.title.includes('第 2 级') && s.text.includes('answer q_1') && s.ref === 'q_1', 'suspended：级别 + 问题正文 + answer 命令');
  const b = outcomeNotice({ kind: 'limit_breached', questionId: 'q_2', breach: { key: 'limit.llm_calls', human: '调用次数触顶' } }, 't_1');
  assert(b.text.includes('--llm_calls') && b.ref === 'q_2', 'limit_breached：加额命令用维度名');
  const c = outcomeNotice({ kind: 'complete', completed: [1, 2], workspace: { branch: 'v0/t', head: 'abcdef1234' } }, 't_1');
  assert(c.title.includes('等签收') && c.text.includes('signoff t_1') && c.text.includes('deliver t_1'), 'complete：签收与交付命令');
  // 厂商错误：建议进库的 bind set，不建议一次性的 run --bind（守护进程下次拉起用的还是库里的绑定）
  const pe = (o) => outcomeNotice({ kind: 'provider_error', error: { vendor: 'deepseek', model: 'deepseek-flash', tier: 'standard', message: 'boom', ...o } }, 't_1');
  const p403 = pe({ status: 403, retryable: false }), p503 = pe({ status: 503, retryable: true, attempts: 4 });
  assert(p403.title.includes('需换绑或检查 key') && p403.text.includes('HTTP 403') && p403.text.includes('bind set standard='), '403：要人来，给 bind set');
  assert(p503.title.includes('暂时不可用') && p503.text.includes('自动再拉') && p503.text.includes('bind set standard='), '503：说明会自动再拉，一直不好再换');
  assert(![p403, p503].some((n) => n.text.includes('--bind')), '两种都不再建议 run --bind');
  const pc = outcomeNotice({ kind: 'provider_error', error: { config: true, tier: 'heavy', message: 'heavy 档绑的 x 已停用' } }, 't_1');
  assert(pc.title.includes('配置有问题') && pc.text.includes('bind set heavy='), '配置问题：单独的标题与建议');
  eq(outcomeNotice({ kind: 'stalled' }, 't_1'), null, 'stalled 等其它退出不推（终端已有提示，无人值守下也没有"该做的动作"）');
  eq(outcomeNotice({ kind: 'verify_failed', verification: { argv: ['npm', 'test'], code: 1, tail: 'x\ny' } }, 't_1').title, '[SuperIntern] 任务级验收没过', 'verify_failed');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
