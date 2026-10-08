// 并行开发：契约优先 + 行走骨架的规划形状、开关、规划器走并行出口。
//
// 跑：node tests/parallel.test.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner } from '../src/db/db.mjs';
import { validateParallelPlan, pathsOverlap, coveredBy, extraModuleDeps, sharedPathsOf, lockedPathsFor, grantedSharedFor } from '../src/core/parallel.mjs';
import { validateHandoff } from '../src/agent/executor.mjs';
import { scheduleOf, lettableNext } from '../src/core/project.mjs';
import { parallelOf, setParallel, setMaxOpen } from '../src/core/project-settings.mjs';
import { startProjectFromBrief, planProject, renderProposal } from '../src/agent/project-planner.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { getParam } from '../src/core/params.mjs';
import { previewStepsFor, seedPlacement } from '../src/core/orchestrator.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const T = (kind, title, scope_paths, depends_on) => ({ kind, title, goal: `g ${title}`, scope: 's', scope_paths, definition_of_done: `d ${title}`,
  rules: [{ rule: `r ${title}`, assumption: '规格没写' }], constraints: ['既有测试一行不许改'], verify_command: `node --test tests/${title}.test.mjs`, depends_on });
const GOOD = {
  title: 'demo', shared_paths: ['contract/', 'package.json', 'package-lock.json', 'verify.mjs', 'README.md'],
  tasks: [
    T('skeleton', 'skel', ['contract/', 'package.json', 'package-lock.json', 'verify.mjs', 'README.md', 'api/', 'web/', 'cli/'], []),
    T('module', 'api', ['api/'], [1]),
    T('module', 'web', ['web/'], [1]),
    T('module', 'cli', ['cli/'], [1]),
    T('integration', 'e2e', ['e2e/', 'verify.mjs', 'README.md'], [2, 3, 4]),
  ],
};
const clone = (o) => JSON.parse(JSON.stringify(o));

section('1. 形状校验：合规的骨架 / 模块 / 集成过关');
eq(validateParallelPlan(GOOD), [], '标准形状没有错误');
eq(extraModuleDeps(GOOD), [], '模块之间没有额外依赖');

section('2. 形状校验：每一种违规都拒，且说清是哪一条');
{
  const has = (spec, re, m) => { const e = validateParallelPlan(spec); assert(e.some((x) => re.test(x)), `${m}（${e.join(' | ') || '无错误'}）`); };
  let s = clone(GOOD); delete s.shared_paths; has(s, /shared_paths/, '缺 shared_paths');
  s = clone(GOOD); s.tasks[1].kind = 'feature'; has(s, /kind/, 'kind 取值不对');
  s = clone(GOOD); [s.tasks[0], s.tasks[1]] = [s.tasks[1], s.tasks[0]]; has(s, /第 1 个任务必须是骨架/, '骨架不在第一个');
  s = clone(GOOD); s.tasks[3].scope_paths = ['web/src/']; has(s, /#3 与 #4 的 scope_paths 相交/, '两个模块范围相交（目录嵌套）');
  s = clone(GOOD); s.tasks[1].scope_paths = ['api/', 'package.json']; has(s, /#2 的 scope_paths 与 shared_paths 相交/, '模块碰共享文件');
  s = clone(GOOD); s.tasks[2].depends_on = []; has(s, /#3 要依赖骨架/, '模块不依赖骨架');
  s = clone(GOOD); s.tasks[4].depends_on = [2, 3]; has(s, /缺 #4/, '集成没依赖全部模块');
  s = clone(GOOD); s.tasks[0].scope_paths = ['api/', 'web/', 'cli/']; has(s, /覆盖全部 shared_paths/, '骨架没覆盖共享路径');
  s = clone(GOOD); s.tasks = [s.tasks[0], s.tasks[1], s.tasks[4]]; s.tasks[2].depends_on = [2]; has(s, /至少要 2 个模块/, '只有一个模块');
  s = clone(GOOD); s.tasks.push(T('integration', 'e2e2', ['e2e2/'], [2, 3, 4])); has(s, /有且只有一个集成任务/, '两个集成任务');
  s = clone(GOOD); s.tasks[2].scope_paths = ['*']; has(s, /不能是 \*/, '模块范围是 *');
}

section('3. 路径相交 / 覆盖的判法');
eq(pathsOverlap(['api/'], ['api/models/']), ['api/models/'], '目录嵌套算相交');
eq(pathsOverlap(['api/'], ['apix/']), [], '前缀相同但不是同一目录：不相交');
eq(pathsOverlap(['package.json'], ['web/']), [], '根文件与模块目录不相交');
eq(pathsOverlap(['web/package.json'], ['web/']), ['web/package.json'], '文件落在对方目录下算相交');
assert(coveredBy('contract/openapi.yaml', ['contract/']) && coveredBy('verify.mjs', ['verify.mjs']) && !coveredBy('README.md', ['docs/']), 'coveredBy');
eq(extraModuleDeps({ tasks: [{ kind: 'skeleton' }, { kind: 'module', depends_on: [1] }, { kind: 'module', depends_on: [1, 2] }] }), [[3, 2]], '模块依赖模块被列出来');

section('4. 开关：默认关；开了之后规划器走并行出口、形状不合规会被拒回灌');
{
  const TMP = mkdtempSync(join(tmpdir(), 'si-par-'));
  process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
  const SRC = join(TMP, 'src'); mkdirSync(SRC);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: SRC, stdio: 'ignore' });
  git('init', '-q', '-b', 'main'); writeFileSync(join(SRC, 'README.md'), '# demo\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const P = startProjectFromBrief(db, { userId: owner.userId, brief: 'api、web、cli 三部分，按同一份接口', source: SRC, home: join(TMP, 'home') });
  eq(parallelOf(db, P.projectId), false, '默认关');
  setParallel(db, { projectId: P.projectId, on: true, userId: owner.userId });
  eq(parallelOf(db, P.projectId), true, '开了');
  const call = (args, id) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id, name: 'propose_project', args }], usage: { inputTokens: 10, outputTokens: 5 } });
  const seen = [];
  const badSpec = clone(GOOD); badSpec.tasks[3].scope_paths = ['web/'];
  const client = new LlmClient({ mode: 'fake', fake: makeFake([call(badSpec, 'c1'), call(GOOD, 'c2')]) });
  const orig = client.complete.bind(client);
  client.complete = (canon) => { seen.push(canon); return orig(canon); };
  const r = await planProject(db, { client, projectId: P.projectId });
  eq(r.kind, 'proposed', '第二次合规 → 落成草案');
  assert(/并行开发模式/.test(seen[0]?.system ?? '') && seen[0]?.tools?.[0]?.parameters?.properties?.shared_paths, '模型拿到并行段提示词与带 shared_paths 的出口');
  const rej = db.all(`SELECT payload FROM audit_log WHERE action='project_plan_attempt' AND target_id=?`, P.projectId).map((a) => JSON.parse(a.payload));
  assert(rej.length === 1 && rej[0].rejections.some((x) => /#3 与 #4 的 scope_paths 相交/.test(x)), '第一次因为模块范围相交被拒');
  const q = db.one(`SELECT text FROM questions WHERE id=?`, r.questionId);
  assert(/并行开发：#1 骨架/.test(q.text) && /共享路径/.test(q.text) && /〔骨架〕/.test(q.text) && /〔集成〕/.test(q.text), '批准页写明并行怎么跑、共享路径、每个任务的类别');
  const stored = getParam(db, db.one(`SELECT id FROM tasks WHERE project_id=? AND project_order=0`, P.projectId).id, 'plan.spec');
  eq(stored?.shared_paths ?? null, GOOD.shared_paths, '草案里的 shared_paths 存下来了');
  eq(sharedPathsOf(db, P.projectId), GOOD.shared_paths, '项目层记下共享路径');
  {
    // 规格写死了接口：骨架任务的契约文字没点名它 → 拒回草案（否则规划器没摘到的接口要到集成时才发现是 405）
    const P2 = startProjectFromBrief(db, { userId: owner.userId, brief: 'api、web、cli 三部分。\n- `GET /api/items` → 200 全部条目\n- `GET /api/items/{id}` → 200 或 404', source: SRC, home: join(TMP, 'home2') });
    setParallel(db, { projectId: P2.projectId, on: true, userId: owner.userId });
    const named = clone(GOOD); named.tasks[0].definition_of_done = 'contract 写 GET /api/items 与 GET /api/items/{item_id}';
    const r2 = await planProject(db, { client: new LlmClient({ mode: 'fake', fake: makeFake([call(GOOD, 'c3'), call(named, 'c4')]) }), projectId: P2.projectId });
    eq(r2.kind, 'proposed', '点名之后 → 落成草案');
    const rej2 = db.all(`SELECT payload FROM audit_log WHERE action='project_plan_attempt' AND target_id=?`, P2.projectId).map((a) => JSON.parse(a.payload));
    assert(rej2.length === 1 && rej2[0].rejections.some((x) => /缺：`GET \/api\/items`、`GET \/api\/items\/\{id\}`/.test(x)), '第一次骨架没点名规格里的两个接口 → 被拒，并说清缺哪几个');
  }
  const ids = db.all(`SELECT id FROM tasks WHERE project_id=? AND project_order>0 ORDER BY project_order`, P.projectId).map((r) => r.id);
  eq(ids.map((id) => getParam(db, id, 'task.kind')), ['skeleton', 'module', 'module', 'module', 'integration'], '每个任务记下 kind');

  const H0 = () => ({ artifacts: [{ path: 'api/x.py' }] });
  section('5. 执法：模块任务改共享路径被拒；骨架 / 集成 / 串行项目不受限');
  eq(lockedPathsFor(db, ids[1]), [...GOOD.shared_paths, 'si-preview.json'], '模块任务锁共享路径，外加截图说明（全项目一份，归骨架）');
  const vp = validateHandoff(H0(), { changed: new Set(['api/x.py', 'si-preview.json']), scopePrefixes: ['api'], scopeStructured: true, lockedPaths: lockedPathsFor(db, ids[1]) });
  assert(vp.some((e) => /改了共享路径：`si-preview\.json`/.test(e)), '模块写截图说明 → 拒（几个模块各写一份必然合并冲突）');

  section('5b. 截图那两步补给谁：系统补的步骤也守范围');
  eq(previewStepsFor(db, ids[0]), { preview: true, seed: false }, '骨架：写截图说明照补（这一步骨架做得到），不补样例数据（桩没有数据）');
  eq([1, 2, 3].map((i) => previewStepsFor(db, ids[i])), [0, 0, 0].map(() => ({ preview: false, seed: false })), '模块：两步都不补（文件对它只读）');
  eq(previewStepsFor(db, ids[4]), { preview: true, seed: true }, '集成：两步都照补（样例数据在这里才有真接口可调）');
  const sp = seedPlacement(db, ids[4]);
  assert(/只能.*放在本任务的可动目录里/.test(sp) && !/仓库根目录里/.test(sp.split('；')[0]), '样例脚本的位置写进那一步的规格：本任务的可动目录');
  setParallel(db, { projectId: P.projectId, on: false, userId: owner.userId });
  eq(previewStepsFor(db, ids[1]), { preview: true, seed: true }, '串行项目：与原来一样');
  setParallel(db, { projectId: P.projectId, on: true, userId: owner.userId });
  eq([lockedPathsFor(db, ids[0]), lockedPathsFor(db, ids[4])], [[], []], '骨架与集成不锁');
  const H = H0();
  const v1 = validateHandoff(H, { changed: new Set(['api/x.py', 'package-lock.json']), scopePrefixes: ['api'], scopeStructured: true, lockedPaths: lockedPathsFor(db, ids[1]) });
  assert(v1.some((e) => /改了共享路径：`package-lock\.json`/.test(e)), '模块改锁文件 → 拒，哪怕锁文件平时"不受范围限制"');
  const v2 = validateHandoff(H, { changed: new Set(['api/x.py', 'package-lock.json']), scopePrefixes: ['api'], scopeStructured: true, lockedPaths: [] });
  assert(!v2.some((e) => /共享路径|越界/.test(e)), '不锁时（串行 / 骨架）照旧放行锁文件');
  // 人批准的契约变更把锁文件写进了模块的 scope_paths → 放行这一处（不放行就只剩关掉并行）
  eq(grantedSharedFor(db, ids[1]), [], '规划时模块与共享路径不交 → 没有放行');
  const cur = db.one(`SELECT id, scope_paths FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, ids[1]);
  db.run(`UPDATE constitutions SET scope_paths=? WHERE id=?`, JSON.stringify([...JSON.parse(cur.scope_paths), 'package-lock.json']), cur.id);
  eq(grantedSharedFor(db, ids[1]), ['package-lock.json'], '契约变更点名锁文件 → 放行它');
  const v3 = validateHandoff(H, { changed: new Set(['api/x.py', 'package-lock.json', 'package.json']), scopePrefixes: ['api'], scopeStructured: true, lockedPaths: lockedPathsFor(db, ids[1]), grantedPaths: grantedSharedFor(db, ids[1]) });
  assert(!v3.some((e) => /package-lock\.json/.test(e)), '放行的锁文件不再拒');
  assert(v3.some((e) => /改了共享路径：`package\.json`/.test(e)), '没放行的共享路径照旧拒');
  db.run(`UPDATE constitutions SET scope_paths=? WHERE id=?`, cur.scope_paths, cur.id);
  setParallel(db, { projectId: P.projectId, on: false, userId: owner.userId });
  eq(lockedPathsFor(db, ids[1]), [], '开关关掉 → 不锁（与 0.2.0 一致）');
  setParallel(db, { projectId: P.projectId, on: true, userId: owner.userId });

  section('6. 调度：并行项目就绪就开；串行项目照旧只在都等人时让路');
  db.run(`UPDATE projects SET status='active' WHERE id=?`, P.projectId);
  db.run(`UPDATE tasks SET merged_at=? WHERE id=?`, Date.now(), ids[0]);
  const HOME = join(TMP, 'home');
  mkdirSync(join(HOME, 'workspaces', ids[1]), { recursive: true });
  db.run(`UPDATE tasks SET status='running' WHERE id=?`, ids[1]);
  setMaxOpen(db, { projectId: P.projectId, n: 4, userId: owner.userId });
  const proj = () => db.one(`SELECT * FROM projects WHERE id=?`, P.projectId);
  let nx = lettableNext(db, { project: proj(), sch: scheduleOf(db, { projectId: P.projectId, home: HOME }), home: HOME });
  eq([nx.taskId, nx.parallel], [ids[2], true], '#2 在跑（不在等人）时 #3 照样开');
  setParallel(db, { projectId: P.projectId, on: false, userId: owner.userId });
  nx = lettableNext(db, { project: proj(), sch: scheduleOf(db, { projectId: P.projectId, home: HOME }), home: HOME });
  eq(nx.taskId, null, '关掉并行 → 有一个真在跑就不加塞（0.2.0 的让路）');
  setParallel(db, { projectId: P.projectId, on: true, userId: owner.userId });
  for (const id of ids.slice(2, 4)) mkdirSync(join(HOME, 'workspaces', id), { recursive: true });
  nx = lettableNext(db, { project: proj(), sch: scheduleOf(db, { projectId: P.projectId, home: HOME }), home: HOME });
  eq(nx.taskId, null, '集成任务要等全部模块合并，不提前开');
  setMaxOpen(db, { projectId: P.projectId, n: 2, userId: owner.userId });
  rmSync(join(HOME, 'workspaces', ids[3]), { recursive: true });
  nx = lettableNext(db, { project: proj(), sch: scheduleOf(db, { projectId: P.projectId, home: HOME }), home: HOME });
  eq(nx.taskId, null, '到了并发上限不再开');
  db.close();
}

section('7. 关着时批准页与 0.2.0 一样（不出现并行字样）');
{
  const text = renderProposal(clone(GOOD), 1, '', { maxOpen: 2 });
  assert(!/并行开发/.test(text) && !/〔骨架〕/.test(text), '没有并行段');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
