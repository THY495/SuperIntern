// 部署健康、存活探针、公告、构建号。
//
// 跑：node tests/health.test.mjs
//
// 要证明的：
//   ① 健康清单的每一项按事实判级别 —— 尤其"守护进程不在 → 备份与完整性检查也不做"这一条原来哪儿都看不到；
//   ② /healthz 不鉴权、不看 Host，但只说 ok，不带版本或任何别的东西；
//   ③ /api/health 只给管理员；任务列表里给管理员一个最坏级别，给成员的是 null；
//   ④ 公告：所有人都拿得到，按原文（不当 HTML）；换一条内容 at 就变（各人收起的是哪一条）；
//   ⑤ 页面里的构建号与 SSE hello 里的一致（页面据此判断"服务端换了代码"）。

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, audit, newId, now } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { setSetting, getSetting } from '../src/core/settings.mjs';
import { backupNow, checkDb } from '../src/db/backup.mjs';
import { deploymentHealth, buildId, VERSION } from '../src/core/deploy-health.mjs';
import { startWeb } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e !== undefined ? `\n         ${typeof e === 'string' ? e : JSON.stringify(e)}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (t) => console.log(`\n── ${t}`);

const TMP = mkdtempSync(join(tmpdir(), 'si-health-'));
const HOME = join(TMP, 'home'); mkdirSync(HOME);
const DBF = join(HOME, 'state.db');
const db = openDb(DBF);
const owner = ensureOwner(db, '负责人');
const mem = addUser(db, { name: '成员', role: 'member', byUserId: owner.userId });
const H = 3600_000;
const lv = (h, key) => h.checks.find((c) => c.key === key)?.level;
const chk = (h, key) => h.checks.find((c) => c.key === key);

try {
  section('① 健康清单：按事实判级别');
  {
    let h = deploymentHealth(db, { home: HOME });
    eq([lv(h, 'daemon'), chk(h, 'daemon').unfinished], ['warn', 0], '没有守护进程心跳、也没有未结束的任务 → 注意（不是有问题）');
    eq(lv(h, 'backup'), 'warn', '还没有定期备份 → 注意');
    eq(lv(h, 'integrity'), 'warn', '还没做过完整性检查 → 注意');
    eq(h.checks.some((c) => c.key === 'runtime'), false, '没给容器运行时的结论 → 不列这一项（不瞎报）');
    eq([h.version, h.schema > 30, chk(h, 'db').file === DBF, chk(h, 'db').bytes > 0], [VERSION, true, true, true], '版本、库结构、库文件路径与体积');
    eq(h.worst, 'warn', '最坏级别：注意');

    // 有未结束的任务、守护进程不在 → 有问题
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'x','running',?)`, newId('t'), owner.userId, now());
    h = deploymentHealth(db, { home: HOME });
    eq([lv(h, 'daemon'), chk(h, 'daemon').unfinished], ['bad', 1], '守护进程不在、有 1 个未结束的任务 → 有问题');
    // 看板自带守护进程
    eq(lv(deploymentHealth(db, { home: HOME, inProcessDaemon: true }), 'daemon'), 'ok', '看板带着守护进程 → 正常');
    // 心跳文件（独立进程）
    writeFileSync(join(HOME, 'daemon.heartbeat'), JSON.stringify({ at: Date.now(), pid: 1, intervalMs: 15000 }));
    const hb = deploymentHealth(db, { home: HOME });
    eq([lv(hb, 'daemon'), chk(hb, 'daemon').inProcess, chk(hb, 'daemon').lastBeatAt > 0], ['ok', false, true], '独立的守护进程有新鲜心跳 → 正常，带最近心跳时刻');
    rmSync(join(HOME, 'daemon.heartbeat'));

    // 备份与检查做过了 → 正常
    backupNow(db, DBF, { tag: 'daily' });
    checkDb(db, { full: false }); checkDb(db, { full: true });
    h = deploymentHealth(db, { home: HOME, inProcessDaemon: true });
    eq([lv(h, 'backup'), chk(h, 'backup').count >= 1, chk(h, 'backup').last.tag, lv(h, 'integrity')], ['ok', true, 'daily', 'ok'], '做过一份定期备份、两种检查都过了 → 正常');

    // 定期备份太久没做（超过两倍间隔 + 1 小时）
    h = deploymentHealth(db, { home: HOME, inProcessDaemon: true, at: Date.now() + 49 * H + 1 });
    eq(lv(h, 'backup'), 'warn', '最近一次定期备份超过两倍间隔 → 注意');
    eq(lv(h, 'integrity'), 'warn', '两种检查都太久没做 → 注意');

    // 关掉定期备份
    setSetting(db, { key: 'deploy.backup_every_hours', value: 0, userId: owner.userId });
    eq([lv(deploymentHealth(db, { home: HOME, inProcessDaemon: true }), 'backup'), chk(deploymentHealth(db, { home: HOME }), 'backup').everyHours], ['warn', 0], '定期备份关着 → 注意');
    setSetting(db, { key: 'deploy.backup_every_hours', value: 24, userId: owner.userId });

    // 最近一次备份失败（比最近一次成功更新）
    audit(db, { actorKind: 'system', action: 'db_backup_failed', targetType: 'deployment', targetId: 'db', payload: { tag: 'daily', verify: { error: '盘满了' } } });
    h = deploymentHealth(db, { home: HOME, inProcessDaemon: true });
    eq([lv(h, 'backup'), chk(h, 'backup').lastFailure?.why], ['bad', '盘满了'], '最近一次备份失败 → 有问题，带原因');
    backupNow(db, DBF, { tag: 'daily' });
    eq(lv(deploymentHealth(db, { home: HOME, inProcessDaemon: true }), 'backup'), 'ok', '之后又成功了一次 → 回到正常');

    // 完整性检查失败
    audit(db, { actorKind: 'system', action: 'db_check_failed', targetType: 'deployment', targetId: 'db', payload: { kind: 'quick', problems: ['*** in database main ***'], fk: [] } });
    h = deploymentHealth(db, { home: HOME, inProcessDaemon: true });
    eq([lv(h, 'integrity'), chk(h, 'integrity').quick.ok, chk(h, 'integrity').quick.problems.length, h.worst], ['bad', false, 1, 'bad'], '最近一次快速检查没通过 → 有问题，最坏级别跟着变');
    checkDb(db, { full: false });
    eq(lv(deploymentHealth(db, { home: HOME, inProcessDaemon: true }), 'integrity'), 'ok', '再查一次通过了 → 回到正常');

    // 容器运行时
    eq(lv(deploymentHealth(db, { home: HOME, runtime: null }), 'runtime'), 'unknown', '还没探测完 → 还不知道');
    const down = chk(deploymentHealth(db, { home: HOME, runtime: { ok: false, cli: 'docker', why: 'daemon not running', downSince: 5, checkedAt: 6 } }), 'runtime');
    eq([down.level, down.why, down.downSince], ['bad', 'daemon not running', 5], '运行时不在 → 有问题，带原因与发现时刻');
    eq(lv(deploymentHealth(db, { home: HOME, runtime: { ok: true, cli: 'docker', version: '29.1' } }), 'runtime'), 'ok', '运行时在 → 正常');

    // 内存库：备份与检查无从谈起
    const mdb = openDb(':memory:');
    const mh = deploymentHealth(mdb, {});
    eq([lv(mh, 'backup'), lv(mh, 'integrity'), chk(mh, 'db').file], ['unknown', 'unknown', null], '内存库：备份与检查为"还不知道"，没有文件路径');
    mdb.close();

    // 构建号：内容变了就变
    assert(buildId(['a']) !== buildId(['b']) && buildId(['a']) === buildId(['a']) && buildId(['a']).startsWith(`${VERSION}+`), '构建号：同内容同号、内容变了号就变、带版本号');
  }

  section('② 公告设置：按原文存，限长，去掉控制字符');
  {
    setSetting(db, { key: 'deploy.announcement', value: '  今晚\r\n升级\u0007  ', userId: owner.userId });
    eq(getSetting(db, 'deploy.announcement'), '今晚\n升级', '统一换行、去掉控制字符与首尾空白');
    let err = null; try { setSetting(db, { key: 'deploy.announcement', value: 'x'.repeat(501), userId: owner.userId }); } catch (e) { err = e.message; }
    assert(/太长/.test(err ?? ''), '超过 500 字 → 拒收', err);
    err = null; try { setSetting(db, { key: 'deploy.announcement', value: 3, userId: owner.userId }); } catch (e) { err = e.message; }
    assert(/文字/.test(err ?? ''), '不是文字 → 拒收', err);
    setSetting(db, { key: 'deploy.announcement', value: '', userId: owner.userId });
  }

  section('③ 看板接口：/healthz、/api/health、任务列表里的公告与级别、构建号');
  const PUB = 'si.health.lan';
  const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100, team: true, publicUrl: `https://${PUB}`, runtime: { current: () => null } });
  const call = (method, path, { host = PUB, headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const data = body === null ? null : JSON.stringify(body);
    const r = request({ host: '127.0.0.1', port: w.port, method, path, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; if (path === '/api/events' && s.includes('\n\n')) { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: s }); } });
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: res.statusCode, headers: res.headers, body: j }); });
      res.on('error', () => {});
    });
    r.on('error', (e) => (path === '/api/events' ? null : reject(e)));
    if (data) r.write(data);
    r.end();
  });
  const as = (tok) => ({ 'x-superintern-token': tok });
  try {
    let r = await call('GET', '/healthz');
    eq([r.status, r.body], [200, { ok: true }], '/healthz：不带凭证 200，只有 { ok: true }');
    r = await call('GET', '/healthz', { host: '10.1.2.3:7357' });
    eq([r.status, r.body], [200, { ok: true }], '/healthz：Host 是别的地址（负载均衡按 IP 探）也回答');
    r = await call('GET', '/api/session', { host: '10.1.2.3:7357' });
    eq(r.status, 403, '别的接口照样按 Host 拒（只放开了 /healthz）');
    eq((await call('POST', '/healthz', { body: {} })).status, 404, '/healthz 只认 GET');

    r = await call('GET', '/api/health');
    eq(r.status, 401, '/api/health：不带凭证 401');
    r = await call('GET', '/api/health', { headers: as(mem.plaintext) });
    eq(r.status, 403, '/api/health：成员 403');
    r = await call('GET', '/api/health', { headers: as(owner.plaintext) });
    eq([r.status, r.body.checks.map((c) => c.key).slice(0, 2), lv(r.body, 'runtime'), typeof r.body.build], [200, ['daemon', 'runtime'], 'unknown', 'string'], '/api/health：管理员拿到清单（运行时还没探测完 = 还不知道）与构建号');
    eq([r.body.home, r.body.logFile], [HOME, join(HOME, 'logs', 'daemon.log')], '/api/health：带数据目录与守护进程日志的路径（看板据此写出 SUPERINTERN_HOME 与日志位置）');
    eq([r.body.dbFile, r.body.dbInHome], [DBF, true], '/api/health：库文件就在数据目录里 → 只提 SUPERINTERN_HOME');
    const elsewhere = openDb(join(TMP, 'other.db'));
    eq(deploymentHealth(elsewhere, { home: HOME }).dbInHome, false, '库文件不在数据目录里（--db 指到别处）→ 看板会要求命令行带 --db');
    elsewhere.close();

    r = await call('GET', '/api/tasks', { headers: as(owner.plaintext) });
    eq([r.body.announcement, ['ok', 'warn', 'bad', 'unknown'].includes(r.body.health)], [null, true], '任务列表：没有公告；管理员拿到最坏级别');
    r = await call('GET', '/api/tasks', { headers: as(mem.plaintext) });
    eq(r.body.health, null, '任务列表：成员拿不到运行状况');

    r = await call('POST', '/api/users', { headers: { ...as(owner.plaintext), origin: `https://${PUB}` }, body: { action: 'setting', key: 'deploy.announcement', value: '<b>今晚</b> 升级' } });
    eq(r.status, 200, '管理员发公告');
    r = await call('GET', '/api/tasks', { headers: as(mem.plaintext) });
    const a1 = r.body.announcement;
    eq(a1?.text, '<b>今晚</b> 升级', '成员拿到公告原文（页面按文字显示，不当 HTML —— 扫描测试另核）');
    await new Promise((res) => setTimeout(res, 5));
    await call('POST', '/api/users', { headers: { ...as(owner.plaintext), origin: `https://${PUB}` }, body: { action: 'setting', key: 'deploy.announcement', value: '改期到明晚' } });
    const a2 = (await call('GET', '/api/tasks', { headers: as(mem.plaintext) })).body.announcement;
    assert(a2?.text === '改期到明晚' && a2.at !== a1.at, '改了内容 → at 变了（各人收起的旧那条不挡新的）', [a1, a2]);
    r = await call('POST', '/api/users', { headers: { ...as(mem.plaintext), origin: `https://${PUB}` }, body: { action: 'setting', key: 'deploy.announcement', value: '成员乱发' } });
    assert(r.status >= 400, `成员不能发公告：${r.status}`);

    r = await call('GET', '/');
    const metaBuild = /<meta name="si-build" content="([^"]+)">/.exec(String(r.body))?.[1];
    r = await call('GET', '/api/events', { headers: as(owner.plaintext) });
    const hello = /event: hello\ndata: (.+)\n/.exec(String(r.body))?.[1];
    const helloBuild = hello ? JSON.parse(hello).build : null;
    assert(metaBuild && metaBuild === helloBuild, `页面里的构建号与 SSE hello 的一致：${metaBuild} / ${helloBuild}`);
  } finally { await w.close(); }

  section('④ 容器运行时掉了 / 恢复了：推一次 change（不写审计也要让页面刷新横幅）');
  {
    const rt = { now: { ok: false, cli: 'docker', why: 'down', checkedAt: Date.now() } };
    const w2 = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 50, runtime: { current: () => rt.now } });
    try {
      const events = [];
      const req = request({ host: '127.0.0.1', port: w2.port, path: '/api/events', headers: { host: `127.0.0.1:${w2.port}` } }, (res) => res.on('data', (c) => events.push(String(c))));
      req.on('error', () => {});
      req.end();
      await new Promise((r) => setTimeout(r, 300));
      const before = events.join('').split('event: change').length - 1;
      rt.now = { ok: true, cli: 'docker', version: '29', checkedAt: Date.now() };
      await new Promise((r) => setTimeout(r, 300));
      const after = events.join('').split('event: change').length - 1;
      eq([before, after - before], [0, 1], '运行时没变时只有心跳；从不可用变可用 → 推一次 change（rows 为空）');
      assert(events.join('').includes('data: {"rows":[]}'), '这次 change 不带任何审计行');
      req.destroy();
    } finally { await w2.close(); }
  }
} finally {
  db.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上偶尔占着 */ }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
