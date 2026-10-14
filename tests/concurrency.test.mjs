// 幂等与并发：
//   ① 幂等键：同人同键同请求 → 重放上次的结果（带 idempotent-replayed 头），副作用只发生一次；同键不同请求 → 422；
//      还在处理 → 409；服务端出错（5xx）不缓存，同一个键重试真的再跑一次；不带键照旧；
//   ② 一次性动作输掉竞争：再答已结的事项 → 409，报错写明已由谁、何时；同一轮 done 签收两次 → 第二次 409（原来会现建一条
//      新的签收事项再签一次 —— 第二个人点"打回"就把已签收的任务打回去了）；转交已结的事项 → 409 写明谁、何时。
//
// 跑：node tests/concurrency.test.mjs

import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { idemClaim } from '../src/db/idempotency.mjs';
import { startWeb } from '../src/web/server.mjs';
import { signOff } from '../src/core/deliver.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { transferQuestion } from '../src/core/routing.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);
const TMP = mkdtempSync(join(tmpdir(), 'si-conc-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const real = openDb(join(TMP, 'state.db'));
const owner = ensureOwner(real, '负责人');
let failNextLang = false;
const db = new Proxy(real, { get(t, k) {
  if (k === 'run' && failNextLang) return (sql, ...a) => { if (/UPDATE users SET lang/.test(sql)) { failNextLang = false; throw Object.assign(new Error('disk I/O error（注入）'), { code: 'ERR_SQLITE_ERROR' }); } return t.run(sql, ...a); };
  const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
} });
const w = await startWeb(db, { home: join(TMP, 'home'), port: 0, tokenPlain: owner.plaintext, pollMs: 1000 });
const post = (path, body, key) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const r = request({ host: '127.0.0.1', port: w.port, method: 'POST', path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-superintern-token': owner.plaintext, ...(key ? { 'idempotency-key': key } : {}) } }, (res) => {
    let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: res.statusCode, headers: res.headers, body: j }); });
  });
  r.on('error', reject); r.write(data); r.end();
});
const tokens = () => real.one(`SELECT count(*) n FROM tokens WHERE user_id=?`, owner.userId).n;

try {
  section('① 幂等键');
  const n0 = tokens();
  const a = await post('/api/me/tokens', { name: '重试测试' }, 'k-1');
  const b = await post('/api/me/tokens', { name: '重试测试' }, 'k-1');
  eq([a.status, b.status, b.body.tokenId === a.body.tokenId, b.headers['idempotent-replayed']], [200, 200, true, 'true'], '同键同请求：重放上次的结果（同一枚令牌）');
  eq(tokens() - n0, 1, '副作用只发生一次（只签了一枚）');
  const c = await post('/api/me/tokens', { name: '别的' }, 'k-1');
  eq(c.status, 422, '同键不同请求：422');
  idemClaim(real, { userId: owner.userId, key: 'k-busy', method: 'POST', path: '/api/me/tokens', reqHash: 'x' });
  eq((await post('/api/me/tokens', { name: 'y' }, 'k-busy')).status, 422, '（不同请求先于"处理中"判：422）');
  const { sha256 } = await import('../src/db/db.mjs');
  idemClaim(real, { userId: owner.userId, key: 'k-busy2', method: 'POST', path: '/api/me/tokens', reqHash: sha256(`POST /api/me/tokens\n${JSON.stringify({ name: 'z' })}`) });
  eq((await post('/api/me/tokens', { name: 'z' }, 'k-busy2')).status, 409, '同一个请求还在处理：409');
  failNextLang = true;
  const e1 = await post('/api/me/lang', { lang: 'en' }, 'k-500');
  const e2 = await post('/api/me/lang', { lang: 'en' }, 'k-500');
  eq([e1.status, e2.status, e2.headers['idempotent-replayed'] ?? null], [500, 200, null], '服务端出错不缓存：同一个键重试真的再跑一次、这次成功');
  const n1 = tokens();
  await post('/api/me/tokens', { name: '无键' }); await post('/api/me/tokens', { name: '无键' });
  eq(tokens() - n1, 2, '不带键照旧（两次就是两次）');

  section('③ 乐观并发：版本对不上 409');
  const get = (path) => new Promise((resolve) => { request({ host: '127.0.0.1', port: w.port, path, headers: { 'x-superintern-token': owner.plaintext } }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(JSON.parse(s))); }).end(); });
  const r0 = await get('/api/routing?project=');
  assert(/^[0-9a-f]{16}$/.test(r0.version), `决策路由带版本（${r0.version}）`);
  const save1 = await post('/api/routing', { project: '', version: r0.version, action: 'template', name: 'solo', bindings: {} });
  eq(save1.status, 200, '带着打开时的版本保存：成功');
  const stale = await post('/api/routing', { project: '', version: r0.version, action: 'template', name: 'solo', bindings: {} });
  eq([stale.status, stale.body.conflict, /在你打开之后被 负责人 于 .+ 改过/.test(stale.body.error)], [409, true, true], '拿旧版本再存：409，写明谁、何时改过（原来后存的整表覆盖前一个人的改动）');
  eq((await post('/api/routing', { project: '', version: save1.body.version, action: 'template', name: 'solo', bindings: {} })).status, 200, '拿保存后返回的新版本接着存：成功');
  eq((await post('/api/routing', { project: '', action: 'template', name: 'solo', bindings: {} })).status, 200, '不带版本（命令行、老页面）照旧不查');
  const l0 = await get('/api/llm');
  const lc = await post('/api/llm', { version: l0.version, action: 'endpoint_enable', id: 'gemini', enabled: false });
  eq(lc.status, 200, '模型设置：带当前版本改一处（停用一个服务商）');
  const ls = await post('/api/llm', { version: l0.version, action: 'endpoint_enable', id: 'gemini', enabled: true });
  eq([ls.status, ls.body.conflict], [409, true], '模型设置同样：别人改过之后拿旧版本存 → 409');
} finally { w.close(); }

section('② 一次性动作输掉竞争');
{
  const taskId = newId('t'), t0 = now();
  real.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'x','running',?)`, taskId, owner.userId, t0);
  real.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), taskId, t0, t0);
  const qid = newId('q');
  real.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,status,addressed_to) VALUES (?,?,2,'classifier','用哪个？','A',?,'open',?)`, qid, taskId, t0, JSON.stringify([owner.userId]));
  recordAnswer(real, { questionId: qid, body: 'A', plaintextToken: owner.plaintext });
  let err = null; try { recordAnswer(real, { questionId: qid, body: 'B', plaintextToken: owner.plaintext }); } catch (e) { err = e; }
  assert(err?.status === 409 && /已由 负责人 于 .+ 答复/.test(err.message), `再答已结的事项：409，写明已由谁、何时（${err?.message?.slice(0, 50)}）`);
  let e2 = null; try { transferQuestion(real, { questionId: qid, to: [`user:${owner.userId}`], byUserId: owner.userId }); } catch (e) { e2 = e; }
  assert(e2?.status === 409 && /已由 负责人 于/.test(e2.message), `转交已结的事项：409，写明谁、何时（${e2?.message?.slice(0, 40)}）`);
  const done = newId('t');
  real.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'y','done',?)`, done, owner.userId, t0);
  real.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), done, t0, t0);
  signOff(real, { taskId: done, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  let e3 = null; try { signOff(real, { taskId: done, accept: false, reason: '晚到的打回', plaintextToken: owner.plaintext, userId: owner.userId }); } catch (e) { e3 = e; }
  assert(e3?.status === 409 && /这一轮已由 负责人 于 .+ 签收/.test(e3.message), `同一轮 done 第二次签收（这里是晚到的"打回"）：409（${e3?.message?.slice(0, 50)}）`);
  eq([real.one(`SELECT count(*) n FROM questions WHERE task_id=? AND decision_type='signoff'`, done).n, real.one(`SELECT count(*) n FROM messages WHERE task_id=? AND kind='correction'`, done).n], [1, 0], '没有现建第二条签收事项、也没有生成打回的修正');
}

real.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
