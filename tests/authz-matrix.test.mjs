// 授权矩阵：看板的每一条路由 × 每一种身份，粗粒度那一层该放的放、该挡的挡。
//
// 用例按 startWeb 返回的路由表逐条生成 —— 加了新路由而这里没给样例，测试直接失败（不会因为没人想到而漏测）。
// 打的是团队模式（真实对外的那种），用 authzProbe：过了粗粒度那一层就回 204、不执行处理函数，
// 所以逐条打 POST 不会真的中止项目、加成员。更细的权限（是不是负责人……）在各自的测试里。
// 策略挡下的响应带 x-si-deny 头，据此区分"粗粒度挡下"与"处理函数自己回的 4xx"。
// 另有一节不开探针、真打那三处原来泄露"仅成员可见"项目信息的读接口。
//
// 跑：node tests/authz-matrix.test.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { addUser, reissueToken } from '../src/core/users.mjs';
import { disableUser } from '../src/core/handover.mjs';
import { setMember, setVisibility } from '../src/core/project-members.mjs';
import { startWeb, checkRouteTable, TEAM_OPEN_PATHS, APP_SCRIPT_RE } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const section = (s) => console.log(`\n── ${s}`);

const HOME = mkdtempSync(join(tmpdir(), 'si-authz-'));
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const db = openDb(join(HOME, 'state.db'));
const owner = ensureOwner(db);                                                    // 管理员，也是项目负责人
const member = addUser(db, { name: '项目成员', role: 'member', byUserId: owner.userId });
const stranger = addUser(db, { name: '无关成员', role: 'member', byUserId: owner.userId });
const observer = addUser(db, { name: '旁观者', role: 'observer', byUserId: owner.userId });
const revokedU = addUser(db, { name: '令牌被重发', role: 'member', byUserId: owner.userId });
const disabledU = addUser(db, { name: '已停用', role: 'member', byUserId: owner.userId });
reissueToken(db, { userId: revokedU.userId, byUserId: owner.userId });
disableUser(db, { userId: disabledU.userId, byUserId: owner.userId });

// 一个"仅成员可见"的项目，带一个任务、一个事项、一个用过的仓库
const T0 = now(), P = newId('pj'), T = newId('t'), Q = newId('q');
db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at,source) VALUES (?,?,'秘密项目','/r','b','main','active',?,'/secret/repo-path')`, P, owner.userId, T0);
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id) VALUES (?,?,'秘密任务','running',?,?)`, T, owner.userId, T0, P);
db.run(`INSERT INTO questions (id,task_id,level,level_source,text,asked_at,status,decision_type,type_source) VALUES (?,?,3,'hard_rule','?',?,'open','spec_choice','hard_rule')`, Q, T, T0);
setMember(db, { projectId: P, userId: member.userId, canAddTasks: false, note: '', by: owner.userId });
setVisibility(db, { projectId: P, visibility: 'members', by: owner.userId });

const IDS = {
  anon: null, revoked: revokedU.plaintext, disabled: disabledU.plaintext,
  observer: observer.plaintext, stranger: stranger.plaintext, member: member.plaintext, admin: owner.plaintext,
};
const NO_IDENTITY = ['anon', 'revoked', 'disabled'];

/** 每条路由一个具体的请求地址。新路由没对上任何一条 → 返回 null，测试失败。 */
function sampleOf(r) {
  if (r.path) return r.path === '/api/routing' ? `/api/routing?project=${P}` : r.path;
  const src = r.re.source;
  const table = [
    [/questions.*where/, `/api/questions/${Q}/where`],
    [/questions/, `/api/questions/${Q}/transfer`],
    [/decisions/, `/api/projects/${P}/decisions`],
    [/projects.*rules\$/, `/api/projects/${P}/rules`],
    [/projects.*skills\$/, `/api/projects/${P}/skills`],
    [/projects.*hooks\$/, `/api/projects/${P}/hooks`],
    [/projects.*mcp\$/, `/api/projects/${P}/mcp`],
    [/projects.*inbound\$/, `/api/projects/${P}/inbound`],
    [/projects.*diff/, `/api/projects/${P}/diff/${T}`],
    [/projects.*advance/, `/api/projects/${P}/abort`],
    [/tasks\\\/\(\[\^\/\]\+\)\$/, `/api/tasks/${T}`],
    [/tasks.*\\\/diff\$/, `/api/tasks/${T}/diff`],
    [/diff_lines/, `/api/tasks/${T}/diff_lines`],
    [/live_img/, `/api/tasks/${T}/live_img`],
    [/preview_img/, `/api/tasks/${T}/preview_img`],
    [/preview\$/, `/api/tasks/${T}/preview`],
    [/log\$/, `/api/tasks/${T}/log`],
    [/report\$/, `/api/tasks/${T}/report`],
    [/provenance\$/, `/api/tasks/${T}/provenance?node=n_000000000000`],
    [/trace\$/, `/api/tasks/${T}/trace?q=HEAD`],
    [/\(\[A-Za-z_\]\+\)\$/, `/api/tasks/${T}/say`],
    [/app/, '/app/01-core.js'],
  ];
  for (const [k, v] of table) if (k.test(src) && r.re.test(v.split('?')[0])) return v;
  return null;
}

/** 这种身份在这种策略下，粗粒度那一层该怎样：'allow' 或挡下时的状态码 */
function expected(auth, who) {
  if (auth === 'public') return 'allow';
  if (NO_IDENTITY.includes(who)) return 401;
  if (auth === 'session') return 'allow';
  if (auth === 'admin') return who === 'admin' ? 'allow' : 403;
  // project / task：秘密项目只给管理员与项目成员
  return ['admin', 'member'].includes(who) ? 'allow' : 404;
}

const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 60_000, team: true, publicUrl: 'http://localhost', authzProbe: true, runtime: null });
const base = `http://127.0.0.1:${w.port}`;
const send = async (method, path, tok, { probe = true } = {}) => {
  const headers = { 'sec-fetch-site': 'same-origin', ...(tok ? { 'x-superintern-token': tok } : {}), ...(probe ? { 'x-si-authz-probe': '1' } : {}) };
  const ac = new AbortController();
  const r = await fetch(base + path, { method, headers: method === 'POST' ? { ...headers, 'content-type': 'application/json' } : headers, body: method === 'POST' ? '{}' : undefined, signal: ac.signal });
  const out = { status: r.status, deny: r.headers.get('x-si-deny'), body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
  ac.abort();   // SSE 之类的长连接：拿到头就断
  return out;
};

try {
  section('① 路由表本身：每条都声明了策略，写错或漏写启动即报错');
  assert(w.routes.length >= 30, `路由表 ${w.routes.length} 条`);
  const routeNames = (rs) => rs.map((r) => `${r.method} ${r.path ?? r.re}`);
  let err = null; try { checkRouteTable([{ method: 'GET', path: '/api/x', handler() {} }]); } catch (e) { err = e; }
  assert(err && /auth/.test(err.message), '没声明 auth 的路由 → 启动报错');
  err = null; try { checkRouteTable([...['/', ...TEAM_OPEN_PATHS].map((p) => ({ method: 'GET', path: p, auth: 'public', handler() {} })), { method: 'GET', path: '/api/secret', auth: 'public', handler() {} }]); } catch (e) { err = e; }
  assert(err && /TEAM_OPEN_PATHS/.test(err.message), '多出一条 public（团队模式下会被免登录访问）→ 启动报错');
  const base0 = ['/', ...TEAM_OPEN_PATHS].map((p) => ({ method: 'GET', path: p, auth: 'public', handler() {} }));
  err = null; try { checkRouteTable([...base0, { method: 'GET', re: /^\/app\/(.+)$/, auth: 'public', static: true, handler() {} }]); } catch (e) { err = e; }
  assert(err && /静态脚本/.test(err.message), '静态脚本路由放宽了匹配（能拼出任意路径）→ 启动报错');
  err = null; try { checkRouteTable([...base0, { method: 'GET', re: APP_SCRIPT_RE, auth: 'public', static: true, handler() {} }, { method: 'GET', re: APP_SCRIPT_RE, auth: 'public', static: true, handler() {} }]); } catch (e) { err = e; }
  assert(err && /静态脚本/.test(err.message), '静态脚本路由多出一条 → 启动报错');
  err = null; try { checkRouteTable([...base0, { method: 'GET', re: APP_SCRIPT_RE, auth: 'public', handler() {} }]); } catch (e) { err = e; }
  assert(err && /public|TEAM_OPEN_PATHS/.test(err.message), '不标 static 的 public 正则路由 → 启动报错');
  const missing = w.routes.filter((r) => !sampleOf(r));
  assert(missing.length === 0, '每条路由都有矩阵样例（新加的路由要在 sampleOf 里补一条）', routeNames(missing).join('、'));

  section(`② ${w.routes.length} 条路由 × ${Object.keys(IDS).length} 种身份（团队模式，探针）`);
  const wrong = [];
  let cells = 0;
  for (const r of w.routes) {
    const path = sampleOf(r);
    if (!path) continue;
    for (const [who, tok] of Object.entries(IDS)) {
      cells++;
      const want = expected(r.auth, who);
      const got = await send(r.method, path, tok);
      const okCell = want === 'allow' ? (got.status === 204 && !got.deny) : (got.status === want && !!got.deny);
      if (!okCell) wrong.push(`${r.method} ${path} [${r.auth}] × ${who}：期望 ${want}，实得 ${got.status}${got.deny ? `（x-si-deny: ${got.deny}）` : ''}`);
    }
  }
  assert(wrong.length === 0, `${cells} 个格子全部符合策略`, wrong.slice(0, 15).join('\n         '));

  section('③ 原来泄露"仅成员可见"项目信息的三处（不开探针，真打）');
  let r = await send('GET', `/api/routing?project=${P}`, stranger.plaintext, { probe: false });
  assert(r.status === 404, `无关成员拉秘密项目的决策路由 → 404（原来照给，含成员名单）：${r.status}`);
  r = await send('GET', `/api/routing?project=${P}`, member.plaintext, { probe: false });
  assert(r.status === 200, `项目成员照常拿到：${r.status}`);
  r = await send('GET', '/api/routing', stranger.plaintext, { probe: false });
  assert(r.status === 200, `不带项目（部署默认表）照常给所有成员：${r.status}`);
  // 联网目录：让秘密项目用上一个源，看"被哪些项目用着"
  db.run(`INSERT INTO params (id,task_id,project_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at) VALUES (?,NULL,?,'egress.sources','["npm"]','project','constitutional','user',?,?,?)`, newId('p'), P, owner.userId, T0, T0);
  r = await send('GET', '/api/egress/sources', stranger.plaintext, { probe: false });
  const npmS = r.body?.sources?.find((s) => s.id === 'npm');
  assert(npmS && !npmS.usedBy.some((u) => u.id === P), '无关成员看联网目录：看不到秘密项目在用（原来列出标题与状态）');
  r = await send('GET', '/api/egress/sources', owner.plaintext, { probe: false });
  assert(r.body?.sources?.find((s) => s.id === 'npm')?.usedBy.some((u) => u.id === P), '管理员照常看得到');
  r = await send('GET', '/api/repos', stranger.plaintext, { probe: false });
  assert(!JSON.stringify(r.body).includes('secret/repo-path'), '无关成员的"最近用过的仓库"里没有秘密项目的仓库地址（原来有）');
  r = await send('GET', '/api/repos', member.plaintext, { probe: false });
  assert(JSON.stringify(r.body).includes('secret/repo-path'), '项目成员照常看得到');
} finally {
  await w.close();
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
