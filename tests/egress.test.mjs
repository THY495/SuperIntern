// 回归：出口白名单代理
//
// 跑：node tests/egress.test.mjs
// 前置：docker/podman 在跑；`docker build -t superintern/sandbox:v0.1 sandbox/` 做过。
//       CA 与派生镜像本文件会自己准备（都是幂等的）。
// ⚠️ 本文件**需要真实外网**：白名单要拦住的东西必须是真拦得住，
//    在一台本来就没网的机器上跑，"被拒了"证明不了任何事。所以第 1 节先做对照。
//
// 同 container.test.mjs：**不允许"跳过即通过"**。
//
// 判据：
//   E1 对照     宿主能出网 —— 否则后面所有"拦住了"都是假的
//   E2 放行     白名单内的域连得上，且 TLS 被代理中间人之后**证书链仍然可信**
//   E3 拦截     白名单外的域在 CONNECT 阶段就被拒，TLS 都不建立
//   E4 链路     不是靠环境变量自觉：直连 IP、DNS 解析都出不去
//   E5 审计     被拒记录进 JSONL，并被搬进 audit_log（真相源）
//   E6 凭证     注入按 (host, path 前缀, method) 粒度；**审计记规则不记值**
//   E7 默认     没配 egress.groups 的任务连代理都不起，仍是彻底断网

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { ContainerExecutor, makeSandbox, detectRuntime, SANDBOX_IMAGE, ensureFlavorImage } from '../src/core/container.mjs';
import { EGRESS_GROUPS, setEgressGroups, egressGroupsOf, hostsOf, ensureCa, ensureCaImage,
  EgressProxy, ingestEgressAudit, raiseEgressQuestion, openEgressQuestions, deniedHosts } from '../src/core/egress.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, m) => {
  try { fn(); bad(m, '期望被拒绝，但成功了'); }
  catch (e) { ok(`${m}\n         └ ${String(e.message).split('\n')[0].slice(0, 110)}`); }
};

const ROOT = resolve(import.meta.dirname, '..');
const TMP = mkdtempSync(join(tmpdir(), 'si-eg-'));
const HOME = join(TMP, 'home');
mkdirSync(HOME, { recursive: true });
const execs = [];
// ⚠️ 'exit' 钩子里 await 不了，所以这里**不走 executor.stop()**（它是 async，
// 而且会去搬出网审计 —— 那时库多半已经关了）。直接按 label 硬删，收尾就该是收尾。
process.on('exit', () => {
  const rm = (args) => { try { execFileSync(rt?.cli ?? 'docker', args, { stdio: 'ignore' }); } catch { /* 尽力 */ } };
  for (const e of execs) { rm(['rm', '-f', e.name]); if (e.egress) rm(['rm', '-f', e.egress.name]); }
  for (const e of execs) { if (e.egress) rm(['network', 'rm', e.egress.network]); }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ }
});

const mkws = (name) => {
  const d = join(TMP, name); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, '.keep'), ''); return d;
};

function fixture(groups = null) {
  const db = openDb(join(TMP, `${newId('db')}.db`));
  // ⚠️ ensureOwner 只在**首次创建时**返回明文令牌。第二次调用拿不到 ——
  // 所以这里一次性取出来往下传，不要在用到的地方再调一次（第一版就是那么写的，当场炸）。
  const { userId, plaintext } = ensureOwner(db);
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'egress fixture','running',?)`,
    taskId, userId, t);
  // 真实任务永远有宪法块（`cli new` 建的）。夹具缺了它，出处边就没有落点，
  // 于是"没挂出处边"会被读成代码的问题 —— 实际上是夹具不像真任务。
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,
            valid_from,recorded_at) VALUES (?,?,1,'g','s','d','[]',?,?)`, newId('c'), taskId, t, t);
  if (groups) setEgressGroups(db, { taskId, groups, userId });
  return { db, taskId, userId, plaintext };
}

/** 容器里跑一段 node，回 stdout+stderr。 */
const nodeIn = async (ctr, ws, code, timeoutMs = 45_000) => {
  const r = await ctr.execute({ file: 'node', args: ['-e', code] }, ws, { timeoutMs });
  return `${r.stdout}${r.stderr}`.trim();
};

// ═══════════════════════════════════════════════════════════════════════════
section('0. 前置 + E1 对照：宿主真的能出网');
// ═══════════════════════════════════════════════════════════════════════════

let rt;
try { rt = detectRuntime(); ok(`运行时 ${rt.cli} ${rt.version}`); }
catch (e) { console.log(`  [FAIL] 没有容器运行时\n         ${e.message}`); process.exit(1); }

{
  // ⚠️ 这条对照不是仪式。没有它，"白名单外被拒"和"这台机器根本没网"在输出上
  // 一模一样 —— 而那意味着整个文件可以在一台断网的机器上全绿，什么也没验。
  const r = await new LocalExecutor().execute({ file: 'node', args: ['-e',
    'fetch("https://example.com").then(r=>console.log("HOST-NET-OK",r.status)).catch(e=>console.log("HOST-NET-FAIL",e.message))'] },
  ROOT, { timeoutMs: 30_000 });
  if (!/HOST-NET-OK/.test(r.stdout)) {
    console.log(`  [FAIL] 宿主连不上外网，本文件后面的"拦住了"都不成立：${r.stdout}${r.stderr}`);
    process.exit(1);
  }
  ok('宿主能出网 —— 后面的拦截结论才有意义');
}

let CA_IMAGE;
{
  const ca = ensureCa(rt.cli, join(HOME, 'ca'));
  assert(existsSync(ca.cert), `CA 就位（指纹 ${ca.fingerprint}${ca.created ? '，本次新生成' : ''}）`);
  assert(!existsSync(join(HOME, 'ca', 'x')) && existsSync(join(HOME, 'ca', 'mitmproxy-ca.pem')),
    'CA **私钥**留在本机目录里，不进任何镜像构建上下文');
  // 底座按默认口味取（默认带 Python），与 makeSandbox 实际用的一致
  const img = ensureCaImage(rt.cli, { baseImage: ensureFlavorImage(rt.cli, 'python'), caDir: join(HOME, 'ca'),
    dockerfile: join(ROOT, 'sandbox', 'Dockerfile.ca') });
  CA_IMAGE = img.tag;
  ok(`派生镜像 ${img.tag}${img.built ? '（新构建）' : '（复用）'}`);
  // tag 必须同时含 CA 指纹与基础镜像 id：若只含前者，基础镜像加了 curl 重建后
  // 这里会报"复用"，复用的是建在旧基础上的陈镜像 —— 不报错，只是东西不在。
  assert(/:ca-[0-9a-f]{12}-[0-9a-f]{10}$/.test(img.tag),
    'tag 同时含 CA 指纹与基础镜像 id —— 基础镜像变了不会误复用');
  const again = ensureCaImage(rt.cli, { baseImage: ensureFlavorImage(rt.cli, 'python'), caDir: join(HOME, 'ca'),
    dockerfile: join(ROOT, 'sandbox', 'Dockerfile.ca') });
  assert(!again.built, '第二次调用复用，不重复构建');
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. 白名单按生态成组');
// ═══════════════════════════════════════════════════════════════════════════

{
  assert(EGRESS_GROUPS.pypi.includes('pypi.org') && EGRESS_GROUPS.pypi.includes('files.pythonhosted.org'),
    'pypi 组含两个域 —— 实测 `pip install` 元数据与下载分属不同域，只放行前者会在下载阶段失败');
  assert(EGRESS_GROUPS.github.length >= 3, 'github 组含 git 传输、API、代码下载多个域');
  eq(hostsOf(['npm']).length, 1, 'hostsOf 展开成 {group, host} 列表');
  eq(hostsOf(['npm'])[0].group, 'npm', '展开后保留生态名 —— 被拒记录才能说出"你要的域属于哪个未放行的生态"');

  const { db, taskId, userId } = fixture();
  eq(egressGroupsOf(db, taskId).length, 0, '默认不放行任何生态');
  rejects(() => setEgressGroups(db, { taskId, groups: ['npmm'], userId }), '不认识的生态名被拒');
  setEgressGroups(db, { taskId, groups: ['npm', 'pypi'], userId });
  eq(egressGroupsOf(db, taskId).join(','), 'npm,pypi', '设过之后读得回来');
  const row = db.one(`SELECT governance_class, set_by_kind FROM params WHERE task_id=? AND key='egress.groups'
                      AND superseded_at IS NULL`, taskId);
  eq(row.governance_class, 'constitutional', '白名单是**宪法层**参数');
  eq(row.set_by_kind, 'user', 'set_by_kind=user —— 库层 CHECK 保证 agent 结构上改不了');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. E7 默认断网：没配生态的任务连代理都不起');
// ═══════════════════════════════════════════════════════════════════════════

{
  const { db, taskId } = fixture();
  const ws = mkws('ws-noegress');
  const ctr = await makeSandbox(db, { taskId, home: HOME, cli: rt.cli });
  execs.push(ctr);
  eq(ctr.egress, null, '没配 egress.groups → 执行器不带代理');
  const info = await ctr.start(ws);
  eq(info.network, 'none', '网络是 none，不是"挂在 cage 上但白名单为空"');
  eq(info.egress, null, '审计载荷里 egress 为 null');
  const out = await nodeIn(ctr, ws,
    'fetch("https://example.com").then(r=>console.log("OK")).catch(e=>console.log("FAIL",e.cause?.message))');
  assert(/FAIL/.test(out), `彻底断网（${out.slice(0, 80)}）`);
  await ctr.stop();
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. E2/E3/E4 放行、拦截、链路');
// ═══════════════════════════════════════════════════════════════════════════

const { db: dbG, taskId: taskG } = fixture(['github']);
const wsG = mkws('ws-github');
const ctrG = await makeSandbox(dbG, { taskId: taskG, home: HOME, cli: rt.cli });
execs.push(ctrG);

{
  const info = await ctrG.start(wsG);
  eq(info.network, `superintern-cage-${taskG}`, '沙箱挂在本任务专属的 cage 网上');
  assert(info.egress.hosts.includes('api.github.com'), `放行清单进审计载荷（${info.egress.hosts.length} 个域）`);
  eq(info.image, CA_IMAGE, '用的是烘焙了 CA 的派生镜像');

  // E2：白名单内 + TLS 被中间人之后证书链仍可信（CA 装进了系统信任库）
  const allowed = await nodeIn(ctrG, wsG,
    'fetch("https://api.github.com/zen").then(async r=>console.log("ALLOW-OK",r.status,(await r.text()).slice(0,30)))'
    + '.catch(e=>console.log("ALLOW-FAIL",e.message,"|",e.cause?.message))');
  assert(/ALLOW-OK 200/.test(allowed), `白名单内的 HTTPS 通了：${allowed.slice(0, 120)}`);
  assert(!/self.signed|unable to verify|UNABLE_TO_/i.test(allowed),
    '证书链可信 —— CA 烘焙进系统信任库那一步真的生效了');

  // 同一件事换个工具再验一次。全靠 node 的话，一个 undici 特有的坑就会被读成"没网"。
  const viaCurl = await ctrG.execute({ file: 'curl', args: ['-sS', '-o', '/dev/null',
    '-w', 'CURL-%{http_code}', 'https://api.github.com/zen'] }, wsG, { timeoutMs: 45_000 });
  assert(/CURL-200/.test(viaCurl.stdout), `curl 也通（${viaCurl.stdout.trim()}）—— 换一套 CA 机制仍成立`);

  // E3：白名单外，CONNECT 阶段就拒
  const denied = await nodeIn(ctrG, wsG,
    'fetch("https://example.com").then(r=>console.log("DENY-LEAK",r.status)).catch(e=>console.log("DENY-OK",e.cause?.message))');
  assert(/DENY-OK/.test(denied) && !/DENY-LEAK/.test(denied), `白名单外被拒：${denied.slice(0, 120)}`);
  const deniedCurl = await ctrG.execute({ file: 'curl', args: ['-sS', 'https://example.com'] },
    wsG, { timeoutMs: 45_000 });
  assert(/CONNECT tunnel failed|403/.test(deniedCurl.stderr + deniedCurl.stdout),
    `curl 看到的是 CONNECT 阶段失败而非 HTTP 状态码：`
    + `${(deniedCurl.stderr || deniedCurl.stdout).trim().slice(0, 100)}`);

  // E4：拦住它的是**链路**，不是环境变量里的 HTTP_PROXY 自觉
  const direct = await nodeIn(ctrG, wsG,
    'const s=require("node:net").connect({host:"1.1.1.1",port:443,timeout:6000});'
    + 's.on("connect",()=>console.log("RAW-LEAK"));s.on("error",e=>console.log("RAW-BLOCKED",e.code));'
    + 's.on("timeout",()=>console.log("RAW-BLOCKED timeout"))');
  assert(/RAW-BLOCKED/.test(direct), `绕过代理直连 IP 出不去（${direct.slice(0, 60)}）—— cage 网没有网关`);
  const dns = await nodeIn(ctrG, wsG,
    'require("node:dns").lookup("example.com",(e)=>console.log(e?"DNS-BLOCKED "+e.code:"DNS-LEAK"))');
  assert(/DNS-BLOCKED/.test(dns), `外部域名在 cage 里解析不了（${dns.slice(0, 50)}）—— DNS 隧道外传顺带堵死`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. E5 审计：被拒记录进 JSONL，并搬进 audit_log');
// ═══════════════════════════════════════════════════════════════════════════

{
  const jsonl = ctrG.egress.auditFile;
  const raw = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert(raw.some((r) => r.allowed === false && r.host === 'example.com'), 'JSONL 里有 example.com 的被拒记录');
  assert(raw.some((r) => r.allowed === false && r.phase === 'connect'),
    '被拒发生在 connect 阶段 —— TLS 没建立');
  assert(raw.some((r) => r.allowed === true && r.group === 'github'),
    '放行记录带生态名');
  assert(raw.every((r) => !/ghp_|Bearer |Authorization/i.test(JSON.stringify(r))),
    'JSONL 里没有任何形似凭证的东西');
  assert(raw.every((r) => !String(r.path ?? '').includes('?')),
    'path 不含 query string —— 审计要答的是"漏了哪个域"，不是留存请求内容');

  const st = await ctrG.stop();
  assert(st.egress.denied >= 2, `stop 时把出网审计搬进了 audit_log（被拒 ${st.egress.denied} 条）`);
  const row = dbG.one(`SELECT payload FROM audit_log WHERE target_id=? AND action='egress_denied'`, taskG);
  assert(row, 'audit_log 里有 egress_denied —— 只躺在磁盘上的 JSONL 不在真相源里');
  const p = JSON.parse(row.payload);
  assert(p.hosts['example.com'] >= 1, `被拒的域按 host 归并（${JSON.stringify(p.hosts)}）—— 反复出现的域才是"漏了一个生态"的信号`);
  dbG.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. E6 凭证注入：粒度是 (host, path 前缀, method)，审计记规则不记值');
// ═══════════════════════════════════════════════════════════════════════════

{
  // ⚠️ 全程用**假令牌**。注入成功的证据是上游回 `Bad credentials`（而非匿名响应），
  // 这就足以证明机制穿透了 TLS，不需要一把真钥匙。
  const FAKE = 'Bearer ghp_FAKE_TOKEN_FOR_TEST_ONLY_00000000';
  const { db, taskId } = fixture(['github']);
  const ws = mkws('ws-cred');
  const proxy = new EgressProxy({
    taskId, cli: rt.cli, caDir: join(HOME, 'ca'),
    addonPath: join(ROOT, 'sandbox', 'proxy', 'guard.py'),
    auditDir: join(HOME, 'egress', taskId), groups: ['github'],
    // 规则里只有环境变量**名**，值另走 credEnv。所以规则本身可以入库、可以打印。
    credRules: [{ host: 'api.github.com', path_prefix: '/user', methods: ['GET'],
      header: 'Authorization', env: 'SI_CRED_GH' }],
    credEnv: { SI_CRED_GH: FAKE },
  });
  const ctr = new ContainerExecutor({ taskId, db, cli: rt.cli, image: CA_IMAGE, egress: proxy });
  execs.push(ctr);
  await ctr.start(ws);

  // /user 命中规则 → 注入假令牌 → 上游拒（证明真送到了）
  const hit = await nodeIn(ctr, ws,
    'fetch("https://api.github.com/user").then(async r=>console.log("HIT",r.status,(await r.text()).slice(0,40)))'
    + '.catch(e=>console.log("ERR",e.cause?.message))');
  assert(/HIT 401/.test(hit) && /Bad credentials/i.test(hit),
    `命中规则的路径注入了令牌，上游回 Bad credentials —— 注入穿透 TLS 送达：${hit.slice(0, 90)}`);

  // /zen 不匹配 path_prefix → **不注入** → 匿名可访问，照常 200
  //
  // 这一条防的是：按整个 host 无条件注入会破坏无需认证的路径，
  // 而失败信息完全指不到真实原因。粒度必须是 (host, path 前缀, method)。
  const miss = await nodeIn(ctr, ws,
    'fetch("https://api.github.com/zen").then(async r=>console.log("MISS",r.status))'
    + '.catch(e=>console.log("ERR",e.cause?.message))');
  assert(/MISS 200/.test(miss), `不匹配 path 前缀的请求**不注入**，匿名访问照常成功：${miss.slice(0, 60)}`);

  const st = await ctr.stop();
  eq(st.egress.injected, 1, '只注入了一次 —— 粒度真的按 path 前缀区分了');
  const row = db.one(`SELECT payload FROM audit_log WHERE target_id=? AND action='egress_credential_injected'`, taskId);
  assert(row, 'audit_log 里有 egress_credential_injected');
  assert(!/ghp_FAKE|Bearer/.test(row.payload), `审计载荷里**没有令牌值**：${row.payload}`);
  assert(/api\.github\.com/.test(row.payload), '审计载荷里有规则标识（host + path 前缀）');

  const jsonl = readFileSync(proxy.auditFile, 'utf8');
  assert(!/ghp_FAKE/.test(jsonl), 'JSONL 里也没有令牌值 —— 会把令牌写进日志的凭证隔离，隔离的只是沙箱不是磁盘');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 空输入的边界');
// ═══════════════════════════════════════════════════════════════════════════

{
  const { db, taskId } = fixture();
  eq(ingestEgressAudit(db, { taskId, auditFile: join(TMP, 'nope.jsonl') }).lines, 0,
    'JSONL 不存在时 ingest 返回零，不抛');
  assert(!db.one(`SELECT id FROM audit_log WHERE target_id=? AND action='egress_denied'`, taskId),
    '没有被拒记录时不写空的 egress_denied 条目 —— 空集不是事件');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. 临时放行：撞上被拒的域 → 状态机强制 Ⅲ 级提问');
// ═══════════════════════════════════════════════════════════════════════════

{
  const { db, taskId } = fixture();

  // ① 定级不是模型的活
  const q1 = raiseEgressQuestion(db, { taskId, group: 'npm', why: '装依赖' });
  const row = db.one(`SELECT * FROM questions WHERE id=?`, q1.questionId);
  eq(row.level, 3, '强制 Ⅲ 级');
  eq(row.level_source, 'hard_rule', 'level_source=hard_rule —— 由 harness 定级，不是模型自评');
  eq(row.default_action, null, 'Ⅲ 级无默认动作');
  eq(row.timeout_at, null, 'Ⅲ 级无超时 —— 无限期等人');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务转 waiting');
  assert(db.one(`SELECT id FROM edges WHERE from_id=? AND relation='derived_from'`, q1.questionId),
    '挂了出处边 —— 这条问题因为"当前白名单"而存在');

  // ② v20 起可以报一个被拦的具体域名（可信的信息源也允许访问），但要不要加进目录由管理员决定；
  //    不是合法域名的东西（IP、内网、胡写）照旧被拒
  rejects(() => raiseEgressQuestion(db, { taskId, group: '10.0.0.8', why: 'x' }), 'IP 地址被拒');
  rejects(() => raiseEgressQuestion(db, { taskId, group: 'intranet.local', why: 'x' }), '内网地址被拒');
  const qh = raiseEgressQuestion(db, { taskId, group: 'docs.python.org', why: '查标准库文档' });
  assert(qh.text.includes('(B) 把 docs.python.org 加进联网目录') && !qh.text.includes('(A)'),
    '目录里没有的域名：只给 (B) 加进目录（管理员）与 (C) 不放行，没有 (A)');

  // ③ 证据取自审计轨，不取自模型的说法。三种情形都要在正文里说清。
  assert(/没有被拦记录/.test(q1.text) && q1.corroborated === false,
    '没有被拒记录时明说"没有" —— 完全断网的任务本来就不产生被拒记录');

  const { db: db2, taskId: t2 } = fixture();
  const { audit: auditFn } = await import('../src/db/db.mjs');
  auditFn(db2, { actorKind: 'system', action: 'egress_denied', targetType: 'task', targetId: t2,
    payload: { hosts: { 'registry.npmjs.org': 3 } } });
  const q2 = raiseEgressQuestion(db2, { taskId: t2, group: 'npm', why: 'npm install 失败' });
  assert(q2.corroborated && /对得上/.test(q2.text),
    `请求与被拒记录对得上时标为 corroborated（registry.npmjs.org×3）`);

  // ④ **最该被人看见的那种**：要的和撞的不是一回事
  const { db: db3, taskId: t3 } = fixture();
  auditFn(db3, { actorKind: 'system', action: 'egress_denied', targetType: 'task', targetId: t3,
    payload: { hosts: { 'paste.example.net': 7 } } });
  const q3 = raiseEgressQuestion(db3, { taskId: t3, group: 'npm', why: '要装个包' });
  eq(q3.corroborated, false, '请求 npm 但撞的是 paste.example.net → corroborated=false');
  assert(/对不上/.test(q3.text) && /paste\.example\.net×7/.test(q3.text),
    '正文明写"对不上"并列出实际被拒的域 —— 它要的和它撞的墙不是一回事');
  const ar = JSON.parse(db3.one(`SELECT payload FROM audit_log WHERE target_id=? AND action='egress_requested'`, t3).payload);
  eq(ar.corroborated, false, '审计载荷里也记了没对上');
  assert(ar.unrelatedDenials.includes('paste.example.net'), '审计载荷里列出无关的被拒域');

  // ⑤ 放行 = 一次人的动作，两个效果
  eq(openEgressQuestions(db2, { taskId: t2, group: 'npm' }).length, 1, '按生态找得到待答的放行请求');
  eq(openEgressQuestions(db2, { taskId: t2, group: 'pypi' }).length, 0, '不匹配的生态找不到');

  db.close(); db2.close(); db3.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. 放行请求走完整条链：提问 → 放行 → 解冻 → 复工能出网');
// ═══════════════════════════════════════════════════════════════════════════

{
  const { db, taskId, userId, plaintext } = fixture();   // 起手完全断网
  const nodeId = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'装依赖','x','y','running','normal','light',?)`, nodeId, taskId, now());

  const q = raiseEgressQuestion(db, { taskId, nodeId, group: 'npm', why: 'npm install 出不去' });
  db.run(`UPDATE nodes SET status='blocked' WHERE id=?`, nodeId);
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, nodeId).status, 'blocked', '节点冻住');

  // 人放行 → 同时答复（走 recordAnswer，认证通道）
  setEgressGroups(db, { taskId, groups: ['npm'], userId });
  const { recordAnswer } = await import('../src/core/inbox.mjs');
  const r = recordAnswer(db, { questionId: q.questionId, plaintextToken: plaintext,
    body: '已放行生态 npm（经 cli egress --allow）。' });
  eq(r.stillOpen, 0, '答复之后没有别的问题开着');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, nodeId).status, 'pending', '分支解冻回 pending');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'running', '任务由 waiting 转 running');
  const msg = db.one(`SELECT trust_label, token_id FROM messages WHERE id=?`, r.messageId);
  eq(msg.trust_label, 'user-authenticated', '答复走认证通道 —— 省掉的是仪式，不是认证');
  assert(msg.token_id, '答复带 token_id');

  // 复工时装配出来的执行器，网络确实变了 —— 这才是闭环合上的证据
  const ws = mkws('ws-loop');
  const ctr = await makeSandbox(db, { taskId, home: HOME, cli: rt.cli });
  execs.push(ctr);
  assert(ctr.egress !== null, '复工装配出的执行器带上了代理（放行前是 null）');
  const info = await ctr.start(ws);
  assert(info.egress.hosts.includes('registry.npmjs.org'), '沙箱真的能连 npm 了');
  const got = await ctr.execute({ file: 'curl', args: ['-sS', '-o', '/dev/null', '-w', 'NPM=%{http_code}',
    'https://registry.npmjs.org/left-pad'] }, ws, { timeoutMs: 45_000 });
  assert(/NPM=200/.test(got.stdout), `复工后真的出得去（${got.stdout.trim()}）`);
  const still = await ctr.execute({ file: 'curl', args: ['-sS', 'https://example.com'] }, ws, { timeoutMs: 45_000 });
  assert(/403|CONNECT tunnel failed/.test(still.stderr + still.stdout),
    '而没放行的域**仍然**被拒 —— 放行的是一个生态，不是开了个口子');
  await ctr.stop();
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
