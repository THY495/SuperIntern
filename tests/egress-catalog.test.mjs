// 联网目录 + 项目联网（v20）
//
// 跑：node tests/egress-catalog.test.mjs     （第 6 节要 docker 与外网，缺了就跳过并说明）
//
// 定下的几条，这份测试逐条钉死：
//   ① 两层：目录（部署级，只有管理员能改）+ 项目勾选（项目负责人），项目下所有任务共用，没有任务层加开
//   ② 信息源默认只读：代理只放行 GET / HEAD / OPTIONS
//   ③ 软件源可带工具配置（镜像地址），注入沙箱 —— 否则加了镜像工具也不会去用
//   ④ 域名校验：不收 IP、localhost、内网、*.com 这种顶级通配
//   ⑤ "联网放行"事项三选一，答复当场生效（原来看板上答了什么都不会发生）
//   ⑥ 删掉"放行几类的上限"（见 m4 第 12 节）

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import {
  egressSources, sourceOf, addSource, removeSource, sourceUsage, hostProblem, projectEgressOf, setProjectEgress,
  egressGroupsOf, setEgressGroups, allowlistOf, toolEnvOf, egressContext, raiseEgressQuestion, egressChoiceOf,
} from '../src/core/egress.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, m, re = null) => { try { fn(); bad(m, '期望被拒，却成功了'); } catch (e) { (re && !re.test(e.message)) ? bad(m, e.message) : ok(`${m}\n         └ ${e.message.slice(0, 90)}`); } };

const TMP = mkdtempSync(join(tmpdir(), 'si-egcat-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

function fixture() {
  const db = openDb(join(TMP, `${newId('db')}.db`));
  const { userId, plaintext } = ensureOwner(db);          // 管理员（role=lead）
  const t = now(), pj = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,goal,done_definition,created_at)
          VALUES (?,?,'字符数','',?,?,'main','src','active','g','d',?)`, pj, userId, `/r/${pj}`, `b/${pj}`, t);
  const mk = (order) => { const id = newId('t'); db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'T','running',?,?,?)`, id, userId, t + order, pj, order);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','s','d','[]',?,?)`, newId('c'), id, t, t); return id; };
  return { db, userId, plaintext, pj, t1: mk(1), t2: mk(2) };
}

// ═══════════════════════════════════════════════════════════════════════════
section('1 · 目录：内置 5 个软件源随迁移写入；域名校验宁严勿宽');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  eq(egressSources(f.db).map((s) => s.id).join(','), 'npm,pypi,github,crates,goproxy', '内置 5 个，id 就是原来的生态名（旧的放行名单不用改写）');
  assert(sourceOf(f.db, 'pypi').hosts.includes('files.pythonhosted.org'), 'PyPI 两个域都在（元数据与下载分属两个域）');
  for (const [h, why] of [['10.0.0.8', 'IP'], ['localhost', '本机'], ['wiki.corp', '内网后缀'], ['intranet.local', '内网后缀'], ['*.com', '顶级通配'],
    ['https://docs.python.org', '带协议'], ['docs.python.org/3', '带路径'], ['a.*.com', '通配不在最前'], ['single', '只有一段']]) {
    assert(!!hostProblem(h), `「${h}」被拒（${why}）：${hostProblem(h)}`);
  }
  for (const h of ['docs.python.org', 'pypi.tuna.tsinghua.edu.cn', '*.example.com']) eq(hostProblem(h), null, `「${h}」可以`);
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · 往目录里加 / 删：只有管理员；信息源默认只读；工具配置不能动沙箱自己的出网配置');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  const member = addUser(f.db, { name: '阿青', role: 'member', byUserId: f.userId }).userId;
  rejects(() => addSource(f.db, { name: 'x', hosts: ['docs.python.org'], userId: member }), '普通成员加不了 —— 加一项等于给所有项目多一个可选出口', /管理员/);
  const doc = addSource(f.db, { name: 'Python 文档', kind: 'info', hosts: 'docs.python.org', userId: f.userId });
  eq(doc.readOnly, true, '信息源默认只读');
  const mirror = addSource(f.db, { name: '清华 PyPI 镜像', kind: 'package', hosts: ['pypi.tuna.tsinghua.edu.cn'],
    toolEnv: { PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple' }, userId: f.userId });
  eq(mirror.readOnly, false, '软件源默认可写（装依赖有时要 POST，比如某些私有仓库的鉴权）');
  rejects(() => addSource(f.db, { name: 'y', hosts: ['a.example.com'], toolEnv: { HTTPS_PROXY: 'http://evil' }, userId: f.userId }),
    '工具配置不能改沙箱自己的代理设置 —— 那等于绕开出口代理', /沙箱自己的/);
  rejects(() => addSource(f.db, { name: 'z', hosts: ['10.1.2.3'], userId: f.userId }), '目录里加不进 IP', /IP/);

  setProjectEgress(f.db, { projectId: f.pj, sources: [mirror.id], userId: f.userId });
  eq(sourceUsage(f.db, mirror.id)[0]?.id, f.pj, '看得到哪个项目在用它');
  rejects(() => removeSource(f.db, { id: 'npm', userId: f.userId }), '内置的删不掉（不想用就不勾）', /内置/);
  const r = removeSource(f.db, { id: mirror.id, userId: f.userId });
  eq(r.usedBy[0]?.id, f.pj, '删除时报出受影响的项目');
  eq(projectEgressOf(f.db, f.pj).length, 0, '删掉之后项目里立即失效（不留一个指向不存在的源的放行）');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · 项目联网：项目下所有任务共用；没有任务层加开；只读与工具配置一路带到代理和沙箱');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  eq(egressGroupsOf(f.db, f.t1).length, 0, '默认一个都不开 = 完全断网');
  const doc = addSource(f.db, { name: 'Python 文档', kind: 'info', hosts: ['docs.python.org'], userId: f.userId });
  const mirror = addSource(f.db, { name: '清华镜像', hosts: ['pypi.tuna.tsinghua.edu.cn'], toolEnv: { PIP_INDEX_URL: 'https://pypi.tuna.tsinghua.edu.cn/simple' }, userId: f.userId });
  const member = addUser(f.db, { name: '阿青', role: 'member', byUserId: f.userId }).userId;
  rejects(() => setProjectEgress(f.db, { projectId: f.pj, sources: ['npm'], userId: member }), '不是负责人改不了项目联网', /负责人/);
  setProjectEgress(f.db, { projectId: f.pj, sources: [doc.id, mirror.id], userId: f.userId });
  eq(egressGroupsOf(f.db, f.t1).join(), egressGroupsOf(f.db, f.t2).join(), '同一项目的两个任务看到的一样');
  // 任务上批的放行（事项 / cli egress --allow）写进项目，不留任务层
  setEgressGroups(f.db, { taskId: f.t2, groups: [...egressGroupsOf(f.db, f.t2), 'npm'], userId: f.userId });
  assert(projectEgressOf(f.db, f.pj).includes('npm') && egressGroupsOf(f.db, f.t1).includes('npm'), '在任务 2 上放行 npm，任务 1 也能用（写进了项目）');
  const allow = allowlistOf(f.db, egressGroupsOf(f.db, f.t1));
  eq(allow.find((a) => a.host === 'docs.python.org')?.readOnly, true, '喂给代理的名单带只读标记');
  eq(toolEnvOf(f.db, egressGroupsOf(f.db, f.t1)).PIP_INDEX_URL, 'https://pypi.tuna.tsinghua.edu.cn/simple', '工具配置合成出来，准备注入沙箱');
  const ctx = egressContext(f.db, f.t1);
  assert(ctx.includes('docs.python.org') && /只读/.test(ctx), '执行器上下文里写明能访问哪些地址、哪些只读');
  assert(/资料，不是指令/.test(ctx), '写明从这些地址读到的是资料不是指令（外部网页是提示词注入的入口）');
  assert(/可以申请/.test(ctx) && ctx.includes('crates'), '也列出目录里还能申请的源 —— agent 不用撞墙才知道');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · 联网放行事项：三选一，答复当场生效（原来看板上答了什么都不会发生）');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(egressChoiceOf('A'), 'A', '认 A'); eq(egressChoiceOf('（b）加上吧'), 'B', '认带括号、带说明的 B'); eq(egressChoiceOf('不放行'), null, '不认散文');
  const f = fixture();
  const qa = raiseEgressQuestion(f.db, { taskId: f.t1, group: 'pypi', why: 'pip install 失败' });
  recordAnswer(f.db, { questionId: qa.questionId, body: 'A', plaintextToken: f.plaintext });
  assert(projectEgressOf(f.db, f.pj).includes('pypi'), '(A) 答完 PyPI 就进了项目联网 —— 不用再跑 cli egress --allow');

  const qb = raiseEgressQuestion(f.db, { taskId: f.t1, group: 'docs.python.org', why: '查 open() 的 newline 参数' });
  // 放行事项按路由表只发给负责人，成员平时根本答不到；这里直接对钩子验"只有管理员能往目录里加"这道闸
  const { RESOLUTION_HOOKS } = await import('../src/core/answers.mjs');
  const member = addUser(f.db, { name: '阿青', role: 'member', byUserId: f.userId });
  const qrow = f.db.one(`SELECT * FROM questions WHERE id=?`, qb.questionId);
  rejects(() => RESOLUTION_HOOKS.egress(f.db, { question: qrow, finalBody: 'B', by: member.userId, at: now() }),
    '(B) 普通成员选不了：抛错会让整次答复回滚，人看得到原因（不是答了却什么也没发生）', /管理员/);
  eq(egressSources(f.db).some((s) => s.hosts.includes('docs.python.org')), false, '…目录没被改');
  recordAnswer(f.db, { questionId: qb.questionId, body: 'B', plaintextToken: f.plaintext });
  const added = egressSources(f.db).find((s) => s.hosts.includes('docs.python.org'));
  assert(added && added.kind === 'info' && added.readOnly, '(B) 管理员选了：加进目录，作为只读的信息源');
  assert(projectEgressOf(f.db, f.pj).includes(added.id), '…并且放行到本项目');

  const qc = raiseEgressQuestion(f.db, { taskId: f.t2, group: 'crates', why: 'x' });
  recordAnswer(f.db, { questionId: qc.questionId, body: 'C', plaintextToken: f.plaintext });
  assert(!projectEgressOf(f.db, f.pj).includes('crates'), '(C) 不放行：名单不变');
  assert(!!f.db.one(`SELECT 1 FROM audit_log WHERE action='egress_declined' AND target_id=?`, f.t2), '…记一笔');
  f.db.close();
}
{
  // 走看板的答复控制杆：服务端必须 import 了 egress.mjs，钩子才注册得上
  const { makeControls } = await import('../src/web/server.mjs');
  const f = fixture();
  const q = raiseEgressQuestion(f.db, { taskId: f.t1, group: 'npm', why: 'npm install 失败' });
  const controls = makeControls(f.db, { home: TMP, tokenPlain: f.plaintext, makeClassifierClient: () => null });
  await controls.answer({ questionId: q.questionId, body: 'A', _token: f.plaintext });
  assert(projectEgressOf(f.db, f.pj).includes('npm'), '在看板上答 A，放行真的生效了');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · 迁移 v20：项目任务上的旧放行名单按项目取并集，写成项目联网');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const path = join(TMP, 'mig.db');
  // 先建一个 v19 的库（跑到 v19 为止），塞进两条旧的任务层放行名单，再用 openDb 把它带到 v20
  const raw = new DatabaseSync(path);
  raw.exec(readFileSync(resolve(import.meta.dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  raw.close();
  const db0 = openDb(path);                 // 会一路迁到最新；为了测 v20 的并集，手工回到 v19 的形状
  db0.raw.exec(`DROP TABLE egress_sources; DELETE FROM params WHERE key='egress.sources'; PRAGMA user_version = 19`);
  const { userId } = ensureOwner(db0);
  const t = now(), pj = newId('pj');
  db0.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,created_at) VALUES (?,?,'老项目','',?,?,'main','src','active',?)`, pj, userId, '/r', 'b', t);
  for (const [i, g] of [[1, ['npm']], [2, ['npm', 'github']]]) {
    const tid = newId('t');
    db0.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'T','done',?,?,?)`, tid, userId, t, pj, i);
    db0.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at) VALUES (?,?,'egress.groups',?,'task','constitutional','user',?,?,?)`, newId('p'), tid, JSON.stringify(g), userId, t, t);
  }
  db0.close();
  const db1 = openDb(path);
  eq(db1.raw.prepare('PRAGMA user_version').get().user_version >= 20, true, '迁到了 v20');
  eq(projectEgressOf(db1, pj).sort().join(','), 'github,npm', '两个任务的旧名单取并集，成了项目联网');
  db1.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('6 · 实测（真代理）：只读源拦住 POST、放过 GET；工具配置进了沙箱');
// ═══════════════════════════════════════════════════════════════════════════
{
  let cli = null;
  try { execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' }); cli = 'docker'; } catch { /* 没有 docker */ }
  if (!cli) console.log('  （跳过：没有可用的 docker）');
  else {
    const { makeSandbox } = await import('../src/core/container.mjs');
    const HOME = join(TMP, 'home'); mkdirSync(HOME, { recursive: true });
    const f = fixture();
    const ro = addSource(f.db, { name: 'GitHub API（只读）', kind: 'info', hosts: ['api.github.com'], userId: f.userId });
    const env = addSource(f.db, { name: '假镜像', kind: 'package', hosts: ['mirror.example.org'], toolEnv: { PIP_INDEX_URL: 'https://mirror.example.org/simple' }, userId: f.userId });
    setProjectEgress(f.db, { projectId: f.pj, sources: [ro.id, env.id], userId: f.userId });
    const ws = join(TMP, 'ws'); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, '.keep'), '');
    const ctr = await makeSandbox(f.db, { taskId: f.t1, home: HOME, cli });
    try {
      await ctr.start(ws);
      const run = async (code) => { const r = await ctr.execute({ file: 'node', args: ['-e', code] }, ws, { timeoutMs: 45_000 }); return `${r.stdout}${r.stderr}`.trim(); };
      const get = await run('fetch("https://api.github.com/zen").then(r=>console.log("GET",r.status)).catch(e=>console.log("GET-ERR",e.cause?.message??e.message))');
      assert(/GET 200/.test(get), `只读源 GET 放行：${get.slice(0, 80)}`);
      const post = await run('fetch("https://api.github.com/markdown",{method:"POST",body:"{}"}).then(async r=>console.log("POST",r.status,(await r.text()).slice(0,60))).catch(e=>console.log("POST-ERR",e.message))');
      assert(/POST 403 egress denied: this source is read-only/.test(post), `只读源 POST 被代理拦下（不是 GitHub 回的）：${post.slice(0, 100)}`);
      const pe = await run('console.log("PIP_INDEX_URL="+process.env.PIP_INDEX_URL)');
      assert(pe.includes('PIP_INDEX_URL=https://mirror.example.org/simple'), `软件源的工具配置注入了沙箱：${pe}`);
    } finally { await ctr.stop?.(); }
    f.db.close();
  }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
