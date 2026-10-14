// 统一脱敏：规则、库写入层、日志、模型调用录制、通知；最后注入假令牌走一遍，扫描所有落盘文件。
//
// 跑：node tests/redact.test.mjs
//
// 假令牌一律现拼（不写成字面量）：发布导出会扫描密钥形状，字面量会让测试文件本身被拦下。

import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { REDACTED, SECRET_PATTERNS, redact, redactDeep, redactParams, registerSecret, findSecrets } from '../src/core/redact.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);

const rnd = (n) => randomBytes(n).toString('hex').slice(0, n);
const GH = 'gh' + 'p_' + rnd(36);
const SK = 's' + 'k-ant-' + rnd(40);
const AWS = 'AK' + 'IA' + rnd(16).toUpperCase().replace(/[^0-9A-Z]/g, 'Q');
// 形状认不出的：自建网关的 key、内网令牌 —— 只能靠"已知值"
const KNOWN = 'corp-gw-' + rnd(28);
const CRED = 'gitea-' + rnd(30);
const CRED2 = 'gitea-' + rnd(30);   // 只经连接录入 / 解密进入本进程，证明那条登记路径本身有效
process.env.ACME_GATEWAY_TOKEN = KNOWN;   // 名字像密钥 → 已知值

const TMP = mkdtempSync(join(tmpdir(), 'si-redact-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

section('① 规则');
{
  for (const [name, v] of [['GitHub 令牌', GH], ['Anthropic key', SK], ['AWS key', AWS]]) {
    const r = redact(`报错：${v} 无效`);
    assert(!r.includes(v) && r.includes(REDACTED), `${name}：按形状去掉`);
  }
  const pem = `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH ${'PRIVATE'} KEY-----`;
  eq(redact(`key:\n${pem}\ndone`), `key:\n${REDACTED}\ndone`, '私钥 PEM 整块去掉，前后文字保留');
  const hintText = `不像 SSH 私钥：要以 -----BEGIN OPENSSH ${'PRIVATE'} KEY----- 开头的整段内容`;
  eq(redact(hintText), hintText, '只有头、没有密钥体的（界面提示、报错文字）不动');
  const cut = `-----BEGIN RSA ${'PRIVATE'} KEY-----\nMIIEowIBAAKCAQEAx1y2z3`;
  eq(redact(`日志：${cut}`), `日志：${REDACTED}`, '截断的私钥（没有结尾）也去掉');
  eq(redact('Authorization: Bearer abcdefgh12345678'), `Authorization: Bearer ${REDACTED}`, 'Authorization 头：只去值、留下前缀');
  eq(redact('{"authorization":"token abcdefgh12345678"}'), `{"authorization":"token ${REDACTED}"}`, 'JSON 里的 authorization 也认');
  eq(redact('x-api-key: abcdefghijklmnop'), `x-api-key: ${REDACTED}`, 'x-api-key 头');
  eq(redact('https://bot:s3cretpass@git.example.com/o/r.git'), `https://bot:${REDACTED}@git.example.com/o/r.git`, 'URL 里的口令去掉，用户名与地址保留');
  eq(redact(`用的是 ${KNOWN}`), `用的是 ${REDACTED}`, '环境变量里名字像密钥的值（形状认不出）按已知值去掉');
  assert(redact(CRED) === CRED, '没登记过的、形状认不出的不动（对照）');
  registerSecret(CRED);
  eq(redact(`push ${CRED}@x`), `push ${REDACTED}@x`, '登记过的连接明文（解密时登记）按已知值去掉');
  registerSecret('short');
  eq(redact('a short story'), 'a short story', '太短的值不登记（会误伤正常文字）');
  for (const s of ['task-123456789012345678901234', 'risk-assessment-for-the-new-module', 'see https://example.com/path:8080/x', 'Authorization required', '版本 sha256:abcdef0123456789']) {
    eq(redact(s), s, `正常文字不误伤：${s}`);
  }
  const deep = redactDeep({ a: [`x ${GH}`, 3, null], b: { c: `y ${KNOWN}` }, n: 1 });
  eq(deep, { a: [`x ${REDACTED}`, 3, null], b: { c: `y ${REDACTED}` }, n: 1 }, 'redactDeep：逐层去掉，结构与非字符串不动');
  eq(findSecrets(`a ${GH}`), ['疑似 GitHub 令牌'], 'findSecrets 报命中的说明');
  assert(SECRET_PATTERNS.every(([re]) => !re.global), '形状规则不带 g（导出扫描用 .test 逐行判，带 g 会有 lastIndex 残留）');
}

section('② 库写入层（db.run）');
{
  eq(redactParams('INSERT INTO messages (body) VALUES (?)', [`x ${GH}`, 3]), [`x ${REDACTED}`, 3], 'INSERT 的字符串参数脱敏，数字不动');
  eq(redactParams('  update tasks set title=? where id=?', [`t ${SK}`, 't_1']), [`t ${REDACTED}`, 't_1'], 'UPDATE（小写、前导空白）同样');
  eq(redactParams('INSERT OR REPLACE INTO params (k,v) VALUES (?,?)', ['k', KNOWN]), ['k', REDACTED], 'INSERT OR REPLACE');
  eq(redactParams('INSERT INTO credentials (secret) VALUES (?)', [GH]), [GH], '连接表（密文）除外');
  eq(redactParams('SELECT * FROM messages WHERE body=?', [GH]), [GH], '读语句不动');
  const same = ['a', 'b'];
  assert(redactParams('INSERT INTO x VALUES (?,?)', same) === same, '没有命中时原样返回同一个数组（不多分配）');
}

section('③ 假令牌走一遍：库、日志、模型调用录制、通知，扫描所有落盘文件');
{
  const { openDb, ensureOwner, newId, now, audit } = await import('../src/db/db.mjs');
  const { insertUserMessage } = await import('../src/db/messages.mjs');
  const { addCredential, resolveCredential } = await import('../src/core/credentials.mjs');
  const { installLogSink } = await import('../src/core/log.mjs');
  const { LlmClient } = await import('../src/llm/client.mjs');
  const { TIER_BINDING } = await import('../src/llm/canonical.mjs');
  const { notify } = await import('../src/core/notify.mjs');

  const home = join(TMP, 'home');
  const db = openDb(join(home, 'state.db'));
  const { userId, tokenId } = ensureOwner(db);
  const taskId = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,?,'planning',?)`, taskId, userId, `接 API（key 是 ${SK}）`, now());

  // 人把 key 贴进对话
  const mid = newId('m');
  insertUserMessage(db, { id: mid, taskId, senderId: userId, tokenId, body: `用这个令牌推：${GH}，网关 key ${KNOWN}`, kind: 'instruction', receivedAt: now() });
  eq(db.one(`SELECT body FROM messages WHERE id=?`, mid).body, `用这个令牌推：${REDACTED}，网关 key ${REDACTED}`, '人贴进来的消息：落库前去掉（之后进模型上下文的也是去掉后的）');

  // 连接：录入 → 解析（解密时登记明文）→ 之后哪里见到都脱
  assert(redact(CRED2) === CRED2, '录入之前：形状认不出的令牌不认识（对照）');
  const cred = addCredential(db, { kind: 'token', name: '自建 Gitea', host: 'git.example.com', secret: CRED2, byUserId: userId });
  assert(cred && redact(CRED2) === REDACTED, '录入一条形状认不出的令牌 → 本进程从此认得它');
  const conn = await resolveCredential(db, { remote: 'https://git.example.com/o/r.git', action: 'read', actorId: userId, env: {}, fetchFn: async () => { throw new Error('不该联网'); } });
  conn.cleanup?.();
  audit(db, { actorKind: 'system', action: 'test_push_failed', targetType: 'task', targetId: taskId,
    payload: { error: `fatal: unable to access 'https://git.example.com/o/r.git/': token ${CRED2} rejected`, nested: { header: `Authorization: token ${GH}` } } });
  const p = db.one(`SELECT payload FROM audit_log WHERE action='test_push_failed'`).payload;
  assert(!p.includes(CRED2) && !p.includes(GH) && JSON.parse(p).nested.header === `Authorization: token ${REDACTED}`, '审计 payload：嵌套字段、报错里带出来的连接明文都去掉，JSON 结构完好');

  // 节点产出、报告之类：任何写语句都过
  db.run(`UPDATE tasks SET title=? WHERE id=?`, `完成；顺手把 ${AWS} 写进了 README`, taskId);
  assert(!db.one(`SELECT title FROM tasks WHERE id=?`, taskId).title.includes(AWS), '任意表的 UPDATE 也过一遍');

  // 日志：JSON 行 + 给人看的那份（重定向进文件的）
  const human = join(home, 'logs', 'daemon.log');
  const target = {};
  for (const m of ['log', 'info', 'warn', 'error']) target[m] = (...a) => { try { writeFileSync(human, a.join(' ') + '\n', { flag: 'a' }); } catch { /* 目录还没建 */ } };
  const sink = installLogSink({ home, target });
  target.log(`推送用 ${CRED} 失败`);
  target.error(new Error(`provider said: invalid key ${KNOWN}`).message);
  target.warn('无关的一行');
  sink.uninstall();
  const jsonl = readdirSync(join(home, 'logs', 'jsonl')).map((n) => readFileSync(join(home, 'logs', 'jsonl', n), 'utf8')).join('');
  assert(jsonl.includes('无关的一行') && jsonl.includes(REDACTED), 'JSON 行日志照常写，命中的换成 [redacted]');
  const humanText = readFileSync(human, 'utf8');
  assert(humanText.includes('推送用 [redacted] 失败') && !humanText.includes(KNOWN), '给人看的 console 输出也脱（它被重定向进 logs/ 下的文件）');

  // 模型调用录制：请求里带着人贴的 key、响应里模型把它复述了一遍
  const cassette = join(home, 'cassette.jsonl');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'm', type: 'message', role: 'assistant', model: 'x',
    content: [{ type: 'text', text: `好的，我会用 ${GH} 推送` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) });
  try {
    const client = new LlmClient({ mode: 'record', cassette, retryDelays: [0], apiKeys: { anthropic: KNOWN },
      binding: { ...TIER_BINDING, standard: 'anthropic/claude-sonnet-5' } });
    const r = await client.complete({ tier: 'standard', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: `key=${SK}` }] }], maxTokens: 8 });
    assert(r.content?.[0]?.text?.includes(GH), '返回给调用方的响应不改（只改落盘的录制）');
  } finally { globalThis.fetch = realFetch; }
  const rec = readFileSync(cassette, 'utf8');
  assert(rec.includes('"key"') && !rec.includes(SK) && !rec.includes(GH), '录制文件：请求与响应里的 key 都去掉（录制会被拷来拷去、进夹具）');

  // 通知：发到第三方
  let sent = null;
  await notify(db, { taskId, kind: 'question', title: `要你拿主意：${GH}`, text: `正文里带了 ${KNOWN}`,
    channels: [{ kind: 'ntfy', target: 'https://ntfy.example/x' }], fetchFn: async (url, init) => { sent = init; return { ok: true, status: 200, json: async () => ({}) }; } });
  assert(sent && !String(sent.body).includes(KNOWN) && !decodeURIComponent(sent.headers.title).includes(GH), '通知标题与正文：发出去之前去掉');

  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();

  // 扫描 home 下每一个文件（库、WAL、日志、录制、指标……），以二进制读，任何一个假值都不许出现
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f) : files.push(f); } };
  walk(home);
  const leaks = [];
  for (const f of files) {
    const buf = readFileSync(f);
    for (const [what, v] of [['GH', GH], ['SK', SK], ['AWS', AWS], ['KNOWN', KNOWN], ['CRED', CRED], ['CRED2', CRED2]]) if (buf.includes(Buffer.from(v))) leaks.push(`${f.slice(home.length + 1)}: ${what}`);
  }
  assert(files.length >= 4, `扫了 ${files.length} 个落盘文件（库、日志、录制……）`);
  eq(leaks, [], '假令牌全流程不落盘：home 下任何文件里都找不到');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
