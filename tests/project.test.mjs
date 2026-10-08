// 项目层（project.mjs）：整批契约 → 串行链 → 签收后自动合并 → 下一个工作区 → 项目 done → 交付。
//
// 跑：node tests/project.test.mjs
//
// 断言的是串接机制，不是模型：这里没有模型，任务"完成"由测试直接落库（done + 签收），
// 看 advanceProject 会不会把它交付到项目仓库、ff 合进项目分支、给下一个任务建工作区，以及回归义务有没有被自动拼上。

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, now, audit } from '../src/db/db.mjs';
import { createProject, advanceProject, deliverProject, projectTasks, validateProjectSpec, createProjectTasks, chainGraph, scheduleOf, raiseIntegrateBlocked, blockedAtHead, signoffCoversDone, conflictSide, deliveryEvidence, runProjectVerify, PROJECT_TASK_RUNTIME_MS } from '../src/core/project.mjs';
import { limitOf } from '../src/core/limits.mjs';
import { getParam, setParam } from '../src/core/params.mjs';
import { signOff, pushEnv, raiseSignoffQuestion } from '../src/core/deliver.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { waitingOnHuman } from '../src/core/addressee.mjs';
import { maxOpenOf, setMaxOpen, setProjectVerify } from '../src/core/project-settings.mjs';
import { startDaemon } from '../src/core/daemon.mjs';
import { reopenTask, redoProjectTask, abortProject, renameTask, renameProject, setTaskArchived, setProjectArchived } from '../src/core/lifecycle.mjs';
import { addUser } from '../src/core/users.mjs';
import { buildDigest, renderDigest } from '../src/core/digest.mjs';
import { routeQuestion } from '../src/core/routing.mjs';
import { createTaskFromSpec } from '../src/core/project.mjs';
import { newId } from '../src/db/db.mjs';
import { sweepTimeouts } from '../src/core/timeouts.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throws = (fn, re, m) => { try { fn(); bad(m, '没有抛错'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `抛了别的：${e.message}`); } };

const TMP = mkdtempSync(join(tmpdir(), 'si-project-'));
const HOME = join(TMP, 'home');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitc = (cwd, ...a) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);

// 源仓库：一个提交
const SRC = join(TMP, 'src');
mkdirSync(SRC); git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'README.md'), '# demo\n'); gitc(SRC, 'add', '.'); gitc(SRC, 'commit', '-q', '-m', 'init');

const db = openDb(':memory:');
const owner = ensureOwner(db);
const spec = {
  title: '演示项目', brief: '两步',
  tasks: [
    { title: 'T1 库', goal: 'g1', definition_of_done: 'd1', verify_command: 'node --test tests/a.test.mjs' },
    { title: 'T2 CLI', goal: 'g2', definition_of_done: 'd2', constraints: ['c'], verify_command: 'node --test tests/b.test.mjs' },
  ],
};

section('1. 校验：契约要齐、验收命令要能不经 shell 跑');
{
  eq(validateProjectSpec({}).length > 0, true, '空对象不合规');
  const errs = validateProjectSpec({ title: 'x', tasks: [{ title: 't', goal: 'g', definition_of_done: 'd', verify_command: 'a && b' }] });
  assert(errs.some((e) => e.includes('verify_command')), '`&&` 串联被拒');
  eq(validateProjectSpec(spec).length, 0, '演示规格合规');
  const rl = (rules, brief) => validateProjectSpec({ title: 'x', tasks: [{ title: 't', goal: 'g', definition_of_done: 'd', verify_command: 'node a.mjs', rules }] }, { brief });
  eq(rl([{ rule: 'r' }]).length, 1, '规则没出处 → 拒');
  eq(rl([{ rule: 'r', quote: '太短' }]).length, 1, '引文太短 → 拒');
  eq(rl([{ rule: '正常转换', quote: '①正常转换' }], '测试须覆盖：①正常转换；②键排序').length, 0, '短引文在原文里恰好出现一次 → 收（拆条后的枚举项）');
  eq(rl([{ rule: '键排序', quote: '键排序' }], '①键排序；②嵌套也要键排序').length, 1, '短引文在原文里出现不止一次 → 拒');
  eq(rl([{ rule: '键排序', quote: '没这句' }], '①键排序').length, 1, '短引文不在原文里 → 拒');
  eq(rl([{ rule: 'r', quote: '这一句在规划里', assumption: '又是假设' }]).length, 1, 'quote 与 assumption 同给 → 拒');
  eq(rl([{ rule: 'r', quote: '这一句不在规划里面' }], '规划：这一句在规划里').length, 1, '引文不是规划子串 → 拒');
  eq(rl([{ rule: 'r', quote: '这一句  在规划里' }], '规划：这一句在规划里').length, 0, '引文空白归一后是子串 → 收');
  eq(rl([{ rule: 'r', quote: '这一句不在规划里面' }]).length, 0, '没给规划文本就不查子串');
  throws(() => createProject(db, { userId: owner.userId, spec: { title: 'x', tasks: [] }, source: SRC, home: HOME }), /tasks/, 'createProject 先校验');
}

section('2. 建项目：克隆 + 项目分支 + 全部任务 + 回归义务累加 + 第一个工作区');
let P;
{
  P = createProject(db, { userId: owner.userId, spec, source: SRC, home: HOME });
  const p = db.one(`SELECT * FROM projects WHERE id=?`, P.projectId);
  eq(p.status, 'active', '项目 active');
  eq(git(P.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), P.branch, '项目仓库停在项目分支');
  eq(P.taskIds.length, 2, '两个任务');
  eq(limitOf(db, P.taskIds[0], 'limit.runtime_ms'), PROJECT_TASK_RUNTIME_MS, '项目任务的时长上限默认 3 h（JMESPath T5 撞过 45 min 默认）');
  const ts = projectTasks(db, P.projectId);
  eq(ts.map((t) => t.project_order).join(','), '1,2', '顺序');
  eq(ts[0].status, 'planning', '任务是普通 planning 任务');
  eq(getParam(db, P.taskIds[0], 'task.verify_extra'), null, 'T1 没有回归义务');
  eq(JSON.stringify(getParam(db, P.taskIds[1], 'task.verify_extra')), JSON.stringify([['node', '--test', 'tests/a.test.mjs']]), 'T2 的回归义务 = T1 的验收命令');
  eq(db.one(`SELECT governance_class g FROM params WHERE task_id=? AND key='task.verify_extra'`, P.taskIds[1]).g, 'constitutional', '回归义务是宪法层参数');
  assert(existsSync(join(HOME, 'workspaces', P.taskIds[0])), 'T1 工作区已建');
  assert(!existsSync(join(HOME, 'workspaces', P.taskIds[1])), 'T2 工作区还没建（轮到它才建）');
  eq(git(join(HOME, 'workspaces', P.taskIds[0]), 'rev-parse', 'HEAD'), P.baseRef, 'T1 工作区从项目分支头起');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_created' AND target_id=?`, P.projectId).n, 1, '审计 project_created');
}

section('3. 推进：等 → 待签收 → 交付 + ff 合并 + 下一个工作区 → 项目 done');
{
  const [t1, t2] = P.taskIds;
  let r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'waiting:planning', 'T1 还在 planning → 没动');
  // 模拟 T1 做完：工作区里提交一个产物，任务置 done
  const ws1 = join(HOME, 'workspaces', t1);
  writeFileSync(join(ws1, 'lib.mjs'), 'export const x = 1;\n'); gitc(ws1, 'add', '.'); gitc(ws1, 'commit', '-q', '-m', 'T1 产物');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, t1);
  r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'needs_signoff', 'done 但没签收 → 等人');
  signOff(db, { taskId: t1, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'merged', '签收后 → 合并');
  eq(r.nextTaskId, t2, '下一个任务是 T2');
  const head1 = git(ws1, 'rev-parse', 'HEAD');
  eq(git(P.repo, 'rev-parse', P.branch), head1, '项目分支快进到 T1 的头');
  assert(db.one(`SELECT merged_at FROM tasks WHERE id=?`, t1).merged_at > 0, 'T1 merged_at');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='task_delivered' AND target_id=?`, t1).n, 1, '走的是 deliver（记 task_delivered）');
  assert(existsSync(join(HOME, 'workspaces', t2)), 'T2 工作区已建');
  eq(git(join(HOME, 'workspaces', t2), 'rev-parse', 'HEAD'), head1, 'T2 从含 T1 的项目分支起');
  assert(existsSync(join(HOME, 'workspaces', t2, 'lib.mjs')), 'T2 工作区里看得到 T1 的产物');
  eq(git(join(HOME, 'workspaces', t2), 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'), `v0/${t2}`, 'T2 工作区只有自己的分支（隔离照旧）');
  r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'waiting:planning', 'T2 还没跑 → 等');
  // 幂等：再推一次不会重复合并
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_task_merged' AND target_id=?`, P.projectId).n, 1, '合并只记一次');
  // T2 做完 + 签收 → 项目 done
  const ws2 = join(HOME, 'workspaces', t2);
  writeFileSync(join(ws2, 'cli.mjs'), 'import { x } from "./lib.mjs";\n'); gitc(ws2, 'add', '.'); gitc(ws2, 'commit', '-q', '-m', 'T2 产物');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, t2);
  signOff(db, { taskId: t2, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'merged_last', '最后一个合并');
  eq(r.done, true, '项目 done');
  eq(db.one(`SELECT status FROM projects WHERE id=?`, P.projectId).status, 'done', '项目状态 done');
  r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'status:done', 'done 之后不再推进');
  eq(git(P.repo, 'log', '--oneline', P.branch).split('\n').length, 3, '项目分支 3 个提交（init + T1 + T2）');
}

section('4. 交付：项目分支推到远端；不给 --remote 拒');
{
  const REMOTE = join(TMP, 'remote.git'); mkdirSync(REMOTE); git(REMOTE, 'init', '-q', '--bare');
  await deliverProject(db, { projectId: P.projectId, remote: null, userId: owner.userId }).then(() => bad('没 remote 应拒'), (e) => (/remote/.test(e.message) ? ok('没 --remote → 拒') : bad('拒的理由不对', e.message)));
  const r = await deliverProject(db, { projectId: P.projectId, remote: REMOTE, pr: false, userId: owner.userId });
  eq(git(REMOTE, 'rev-parse', P.branch), r.head, '远端拿到项目分支');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_delivered' AND target_id=?`, P.projectId).n, 1, '审计 project_delivered');
  const r2 = await deliverProject(db, { projectId: P.projectId, remote: 'https://github.com/o/r.git', pr: true, userId: owner.userId,
    fetchFn: async (url, init) => ({ ok: true, status: 201, json: async () => (init?.method === 'POST' ? { html_url: 'https://github.com/o/r/pull/7', number: 7 } : { default_branch: 'main' }) }),
  }).catch((e) => ({ err: e.message }));
  // push 到假 URL 会失败 —— 这里只验证 PR 正文与流程要素不在 push 之前：push 失败就停
  assert(r2.err && /push|github/i.test(r2.err) || r2.pr, 'push 失败先于 PR（假远端）或 PR 成功');
}

section('4b. push 认证：GitHub HTTPS + token → extraheader 只进环境变量；别的远端不动');
{
  const env = pushEnv('https://github.com/o/r.git', 'ghp_secret');
  eq(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader', 'GitHub HTTPS：extraheader 走 GIT_CONFIG_*');
  assert(env.GIT_CONFIG_VALUE_0.startsWith('AUTHORIZATION: basic ') && !env.GIT_CONFIG_VALUE_0.includes('ghp_secret'), 'token 以 basic 编码放进 header，明文不出现');
  eq(env.GIT_TERMINAL_PROMPT, '0', '禁交互');
  eq(pushEnv('git@github.com:o/r.git', 'ghp_secret').GIT_CONFIG_COUNT, undefined, 'SSH 远端不加 header');
  eq(pushEnv('D:/some/local/path', 'ghp_secret').GIT_CONFIG_COUNT, undefined, '本机路径不加 header');
  eq(pushEnv('https://github.com/o/r.git', undefined).GIT_CONFIG_COUNT, undefined, '没 token 不加 header');
}

section('5. 中止的任务让项目 stalled；守护进程 tick 会推进项目');
{
  const P2 = createProject(db, { userId: owner.userId, spec, source: SRC, home: HOME });
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, P2.taskIds[0]);
  const d = startDaemon(db, { home: HOME, launcher: { running: () => null, launch: () => { throw new Error('测试里不拉起'); } }, intervalMs: 3_600_000, runtime: null });
  const t = await d.tick();
  d.stop();
  eq(t.projects[0]?.reason, 'task_aborted', 'tick 推进了项目：任务中止');
  eq(db.one(`SELECT status FROM projects WHERE id=?`, P2.projectId).status, 'stalled', '项目 stalled 等人');
}

const adv = (projectId) => advanceProject(db, { projectId, home: HOME, userId: owner.userId });
const stall = async () => {           // 建一个项目并让它停滞在 T1（带中止原因，走看板同一条审计形状）
  const X = createProject(db, { userId: owner.userId, spec, source: SRC, home: HOME });
  const [t1] = X.taskIds;
  db.run(`UPDATE tasks SET status='running' WHERE id=?`, t1);
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, t1);
  db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,?,?,?,?,?,?)`, now(), 'user', owner.userId, 'task_aborted', 'task', t1, JSON.stringify({ from: 'running', to: 'aborted', why: '方向错了' }));
  await adv(X.projectId);
  return X;
};
const pst = (id) => db.one(`SELECT status FROM projects WHERE id=?`, id).status;
const tst = (id) => db.one(`SELECT status FROM tasks WHERE id=?`, id).status;

section('6. 停滞的出口 ①：恢复当前任务（中止可反悔）—— 状态放回去，项目回 active，其余一概不动');
{
  const X = await stall(); const [t1] = X.taskIds;
  eq(pst(X.projectId), 'stalled', '前提：项目已停滞');
  const dg = buildDigest(db, { userId: owner.userId });
  assert(dg.stalledProjects.some((p) => p.projectId === X.projectId && p.taskId === t1 && p.why === '方向错了'), '停滞的项目进负责人待办，带当前任务与中止原因');
  assert(/已停滞的项目/.test(renderDigest(dg)), '摘要文本里有');
  const mallory = addUser(db, { name: 'mallory', role: 'member', byUserId: owner.userId });
  throws(() => reopenTask(db, { taskId: t1, userId: mallory.userId }), /只有该任务的负责人/, '别人不能恢复');
  const before = db.one(`SELECT id, owner_id, project_order FROM tasks WHERE id=?`, t1);
  const r = reopenTask(db, { taskId: t1, userId: owner.userId });
  eq(r.to, 'running', '中止前在跑、没有开放事项 → 回 running');
  eq(r.projectResumed, true, '项目一并恢复');
  eq(pst(X.projectId), 'active', '项目 active');
  eq(JSON.stringify(db.one(`SELECT id, owner_id, project_order FROM tasks WHERE id=?`, t1)), JSON.stringify(before), 'task id / 归属 / 顺序不变');
  eq((await adv(X.projectId)).reason, 'waiting:running', '推进逻辑照常：等它跑完');
  throws(() => reopenTask(db, { taskId: t1, userId: owner.userId }), /只有已中止的任务能恢复/, '没中止的不能"恢复"');
  eq(buildDigest(db, { userId: owner.userId }).stalledProjects.some((p) => p.projectId === X.projectId), false, '恢复后不再列为停滞');
}

section('6b. 独立任务：中止也可反悔；中止期间它的事项不进待办，恢复后回来');
{
  const { taskId } = createTaskFromSpec(db, { title: '独立', goal: 'g', definition_of_done: 'd' }, { userId: owner.userId });
  db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
  const q = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,NULL,2,'classifier','A 还是 B？','A',?,NULL,'open')`, q, taskId, now());
  db.tx(() => routeQuestion(db, { questionId: q, decisionType: 'spec_choice', typeSource: 'self' }));
  const mine = () => buildDigest(db, { userId: owner.userId }).waitingOnMe.some((x) => x.questionId === q);
  eq(mine(), true, '前提：事项在待办里');
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, taskId);
  db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,?,?,?,?,?,?)`, now(), 'user', owner.userId, 'task_aborted', 'task', taskId, JSON.stringify({ from: 'waiting', to: 'aborted' }));
  eq(mine(), false, '中止期间：事项不进待办');
  db.run(`UPDATE questions SET timeout_at=? WHERE id=?`, now() - 1000, q);
  await sweepTimeouts(db, {});
  eq(db.one(`SELECT status FROM questions WHERE id=?`, q).status, 'open', '中止期间超时扫描不替人走默认');
  db.run(`UPDATE questions SET timeout_at=NULL WHERE id=?`, q);
  eq(db.one(`SELECT status FROM questions WHERE id=?`, q).status, 'open', '但事项本身没被撤回');
  eq(reopenTask(db, { taskId, userId: owner.userId }).to, 'waiting', '恢复：有开放事项 → waiting');
  eq(mine(), true, '恢复后事项回到待办');
  eq(db.one(`SELECT notified_at FROM questions WHERE id=?`, q).notified_at, null, '并会重新通知');
  // 中止前是暂停 → 恢复回暂停
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, taskId);
  db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,?,?,?,?,?,?)`, now(), 'user', owner.userId, 'task_aborted', 'task', taskId, JSON.stringify({ from: 'suspended', to: 'aborted' }));
  eq(reopenTask(db, { taskId, userId: owner.userId }).to, 'suspended', '中止前是暂停 → 回暂停');
}

section('7. 停滞的出口 ②：重做当前任务 —— 同一份契约新建，旧任务退出链，不再挡住推进');
{
  const X = await stall(); const [t1, t2] = X.taskIds;
  const oldC = db.one(`SELECT goal, scope, definition_of_done, constraints FROM constitutions WHERE task_id=?`, t1);
  const r = redoProjectTask(db, { projectId: X.projectId, userId: owner.userId, note: '先读 README 再动手', plaintextToken: owner.plaintext });
  eq(r.oldTaskId, t1, '旧任务是 T1');
  eq(db.one(`SELECT project_order FROM tasks WHERE id=?`, t1).project_order, null, '旧任务退出链（project_order 为空）');
  eq(tst(t1), 'aborted', '旧任务状态不动');
  const nt = db.one(`SELECT * FROM tasks WHERE id=?`, r.newTaskId);
  eq([nt.project_id, nt.project_order, nt.status, nt.title].join('|'), [X.projectId, 1, 'planning', 'T1 库'].join('|'), '新任务：同项目、同顺序、planning、同标题');
  eq(JSON.stringify(db.one(`SELECT goal, scope, definition_of_done, constraints FROM constitutions WHERE task_id=?`, r.newTaskId)), JSON.stringify(oldC), '契约逐字相同');
  eq(JSON.stringify(getParam(db, r.newTaskId, 'task.verify_command')), JSON.stringify(getParam(db, t1, 'task.verify_command')), '验收命令相同');
  eq(JSON.stringify(getParam(db, t2, 'task.verify_extra')), JSON.stringify([['node', '--test', 'tests/a.test.mjs']]), '后续任务的回归义务没被碰');
  assert(!!db.one(`SELECT 1 FROM edges WHERE from_id=? AND to_id=? AND relation='supersedes'`, r.newTaskId, t1), 'supersedes 边：新 → 旧');
  assert(db.one(`SELECT body FROM messages WHERE task_id=?`, r.newTaskId)?.body.includes('先读 README') && db.one(`SELECT body FROM messages WHERE task_id=?`, r.newTaskId).body.includes('方向错了'), '负责人的说明与上次的中止原因作为补充上下文带给新任务');
  eq(pst(X.projectId), 'active', '项目回 active');
  const a = await adv(X.projectId);
  eq([a.reason, a.taskId].join('|'), ['workspace_created', r.newTaskId].join('|'), '推进取到的是新任务（旧任务不再挡路），从项目分支建工作区');
  assert(existsSync(join(HOME, 'workspaces', t1)), '旧任务的工作区保留');
  throws(() => reopenTask(db, { taskId: t1, userId: owner.userId }), /已被重做的任务取代/, '被取代的旧任务不能再恢复');
  throws(() => redoProjectTask(db, { projectId: X.projectId, userId: owner.userId }), /项目里没有已中止的任务/, '没有已中止的任务 → 不能重做');
  eq(projectTasks(db, X.projectId).map((t) => t.project_order).join(','), '1,2', '链上仍是 1,2');
}

section('8. 停滞的出口 ③ / 叫停：中止项目 —— 终点；已合并的前缀仍可交付');
{
  const X = createProject(db, { userId: owner.userId, spec, source: SRC, home: HOME });
  const [t1, t2] = X.taskIds;
  throws(() => abortProject(db, { projectId: X.projectId, userId: 'u_nobody' }), /只有该项目的负责人/, '别人不能中止项目');
  const ws1 = join(HOME, 'workspaces', t1);
  writeFileSync(join(ws1, 'lib.mjs'), 'export const x = 1;\n'); gitc(ws1, 'add', '.'); gitc(ws1, 'commit', '-q', '-m', 'T1');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, t1);
  signOff(db, { taskId: t1, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  await adv(X.projectId);                                   // T1 合并，T2 建工作区
  db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, t2);
  const q = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,NULL,2,'classifier','?','A',?,NULL,'open')`, q, t2, now());
  const r = abortProject(db, { projectId: X.projectId, userId: owner.userId, why: '需求取消' });
  eq([pst(X.projectId), tst(t2), tst(t1)].join('|'), 'aborted|aborted|done', '项目与未结束的任务中止；已完成的不动');
  eq([r.merged, r.questionsWithdrawn].join('|'), '1|1', '报告：已合并 1 个、撤回事项 1 条');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, q).status, 'withdrawn', '开放事项撤回');
  throws(() => reopenTask(db, { taskId: t2, userId: owner.userId }), /所属项目已中止/, '项目中止是终点：其任务不能恢复');
  throws(() => abortProject(db, { projectId: X.projectId, userId: owner.userId }), /无法中止/, '不能重复中止');
  eq((await adv(X.projectId)).reason, 'status:aborted', '不再推进');
  const REMOTE2 = join(TMP, 'remote2.git'); git(TMP, 'init', '-q', '--bare', REMOTE2);
  const d = await deliverProject(db, { projectId: X.projectId, remote: REMOTE2, userId: owner.userId });
  eq(JSON.stringify(d.partial), JSON.stringify({ merged: 1, total: 2 }), '中止后可交付已合并的部分，并标明 1 / 2');
  eq(git(REMOTE2, 'rev-parse', X.branch), git(ws1, 'rev-parse', 'HEAD'), '推上去的是含 T1 的项目分支');
  const Y = createProject(db, { userId: owner.userId, spec, source: SRC, home: HOME });
  abortProject(db, { projectId: Y.projectId, userId: owner.userId });
  let err = null; try { await deliverProject(db, { projectId: Y.projectId, remote: REMOTE2, userId: owner.userId }); } catch (e) { err = e.message; }
  assert(/没有可交付的内容/.test(err ?? ''), '一个都没合并的已中止项目：拒绝交付');
}

section('9. 改标题与归档：只碰元数据；归档只许已结束的，项目内任务不单独归档');
{
  const X = createProject(db, { userId: owner.userId, spec, source: SRC, home: HOME });
  const [t1] = X.taskIds;
  const cBefore = JSON.stringify(db.all(`SELECT * FROM constitutions WHERE task_id=?`, t1));
  eq(renameTask(db, { taskId: t1, title: '  T1  新名字 ', userId: owner.userId }).title, 'T1 新名字', '改任务标题（空白归一）');
  eq(renameTask(db, { taskId: t1, title: 'T1 新名字', userId: owner.userId }).changed, false, '同名 = 无变化');
  throws(() => renameTask(db, { taskId: t1, title: '   ', userId: owner.userId }), /标题不能为空/, '空标题拒');
  eq(JSON.stringify(db.all(`SELECT * FROM constitutions WHERE task_id=?`, t1)), cBefore, '契约一字不动');
  eq(renameProject(db, { projectId: X.projectId, title: '新项目名', userId: owner.userId }).changed, true, '改项目标题');
  eq(db.one(`SELECT branch FROM projects WHERE id=?`, X.projectId).branch, X.branch, '分支名不动');
  throws(() => setProjectArchived(db, { projectId: X.projectId, archived: true, userId: owner.userId }), /只有已结束/, '进行中的项目不能归档');
  throws(() => setTaskArchived(db, { taskId: t1, archived: true, userId: owner.userId }), /项目内的任务不能单独归档/, '项目内的任务不单独归档');
  abortProject(db, { projectId: X.projectId, userId: owner.userId });
  eq(setProjectArchived(db, { projectId: X.projectId, archived: true, userId: owner.userId }).changed, true, '已中止的项目可归档');
  eq([pst(X.projectId), db.one(`SELECT archived_at FROM projects WHERE id=?`, X.projectId).archived_at > 0].join('|'), 'aborted|true', '归档不改状态');
  eq(setProjectArchived(db, { projectId: X.projectId, archived: false, userId: owner.userId }).changed, true, '可取消归档');
  const { taskId } = createTaskFromSpec(db, { title: '独立 2', goal: 'g', definition_of_done: 'd' }, { userId: owner.userId });
  throws(() => setTaskArchived(db, { taskId, archived: true, userId: owner.userId }), /请先中止/, '进行中的独立任务不能归档');
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, taskId);
  eq(setTaskArchived(db, { taskId, archived: true, userId: owner.userId }).changed, true, '已中止的独立任务可归档');
  throws(() => reopenTask(db, { taskId, userId: owner.userId }), /请先取消归档/, '已归档的任务要先取消归档才能恢复');
  const acts = db.all(`SELECT action FROM audit_log WHERE target_id IN (?,?) AND action LIKE '%archived' ORDER BY id`, X.projectId, taskId).map((a) => a.action).join(',');
  eq(acts, 'project_archived,project_unarchived,task_archived', '审计只有元数据动作');
}

section('10. 依赖图：菱形 —— 串行调度、汇合点等全部上游、回归义务在开工时定');
{
  const T = (t, depends_on) => ({ title: t, goal: `g ${t}`, definition_of_done: `d ${t}`, verify_command: `node --test tests/${t}.test.mjs`, ...(depends_on ? { depends_on } : {}) });
  const dspec = { title: '菱形', tasks: [T('A'), T('B', [1]), T('C', [1]), T('D', [2, 3])] };
  eq(validateProjectSpec(dspec, { deps: { startOrder: 1, existing: [] } }).length, 0, '菱形规格合规');
  assert(validateProjectSpec({ title: 'x', tasks: [T('A', [2]), T('B')] }, { deps: { startOrder: 1, existing: [] } }).some((e) => /只能依赖已有任务或本草案里排在前面的/.test(e)), '依赖编号更大的任务 → 拒（构造上无环）');
  assert(validateProjectSpec({ title: 'x', tasks: [T('A', [1])] }, { deps: { startOrder: 1, existing: [] } }).some((e) => /不能包含自己/.test(e)), '依赖自己 → 拒');
  assert(validateProjectSpec({ title: 'x', tasks: [T('A', [7])] }, { deps: { startOrder: 3, existing: [{ order: 1, started: true, dependsOn: [] }] } }).some((e) => /编号不小于本任务|不存在/.test(e)), '依赖不存在的编号 → 拒');
  assert(validateProjectSpec({ title: 'x', tasks: [T('A', 'x')] }, { deps: { startOrder: 1, existing: [] } }).some((e) => /depends_on 要是任务编号/.test(e)), 'depends_on 形状不对 → 拒');

  const D = createProject(db, { userId: owner.userId, spec: dspec, source: SRC, home: HOME });
  const [a, b, c, d] = D.taskIds;
  eq(JSON.stringify(projectTasks(db, D.projectId).map((t) => t.dependsOn)), JSON.stringify([[], [1], [1], [2, 3]]), '依赖按编号落库；没写的第一个任务 = 不依赖');
  const ws = (id) => join(HOME, 'workspaces', id);
  const finish = (id, file) => { writeFileSync(join(ws(id), file), file); gitc(ws(id), 'add', '.'); gitc(ws(id), 'commit', '-q', '-m', file);
    db.run(`UPDATE tasks SET status='done' WHERE id=?`, id); signOff(db, { taskId: id, accept: true, plaintextToken: owner.plaintext, userId: owner.userId }); };
  eq([existsSync(ws(a)), existsSync(ws(b)), existsSync(ws(c))].join(','), 'true,false,false', '建项目时只开第一个 ready 的（A）');
  finish(a, 'a.txt');
  let r = await advanceProject(db, { projectId: D.projectId, home: HOME });
  eq([r.reason, r.nextTaskId].join('|'), ['merged', b].join('|'), 'A 合并后：B、C 都 ready，先开编号小的 B');
  eq(existsSync(ws(c)), false, '串行：C 不同时开工');
  const sch = scheduleOf(db, { projectId: D.projectId, home: HOME });
  eq([sch.open.map((t) => t.project_order).join(','), sch.ready.map((t) => t.project_order).join(',')].join('|'), '2|3', '调度视图：开着 #2，#3 排队');
  finish(b, 'b.txt');
  r = await advanceProject(db, { projectId: D.projectId, home: HOME });
  eq(r.nextTaskId, c, 'B 合并后开 C；D 还在等 #3');
  eq(JSON.stringify(getParam(db, c, 'task.verify_extra')), JSON.stringify([['node', '--test', 'tests/A.test.mjs'], ['node', '--test', 'tests/B.test.mjs']]),
    'C 的回归义务 = 开工那一刻已合并的全部任务（含它并不依赖的 B）');
  assert(existsSync(join(ws(c), 'b.txt')), 'C 的工作区从项目分支当时的头起：看得到 B 的产物');
  eq(getParam(db, c, 'task.drift_note') ?? null, null, 'C 与 B 同一批定稿：B 先合并不算漂移（规划器写 C 的契约时看得到 B 的契约）');
  finish(c, 'c.txt');
  r = await advanceProject(db, { projectId: D.projectId, home: HOME });
  eq(r.nextTaskId, d, '汇合点 D 等 B、C 都合并后才开工');
  finish(d, 'd.txt');
  r = await advanceProject(db, { projectId: D.projectId, home: HOME });
  eq([r.done, db.one(`SELECT status FROM projects WHERE id=?`, D.projectId).status].join('|'), 'true|done', '全部合并 → 项目 done');
}

section('10b. 依赖图：中止的任务只卡下游；恢复的约束（只剩并发上限）；重做沿用编号与依赖');
{
  const T = (t, depends_on) => ({ title: t, goal: `g ${t}`, definition_of_done: `d ${t}`, verify_command: `node --test tests/${t}.test.mjs`, depends_on });
  const E = createProject(db, { userId: owner.userId, spec: { title: '两条线', tasks: [T('A', []), T('B', []), T('C', [1])] }, source: SRC, home: HOME });
  const [a, b, c] = E.taskIds;
  const ws = (id) => join(HOME, 'workspaces', id);
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, a);   // A 开工后被中止
  let r = await advanceProject(db, { projectId: E.projectId, home: HOME });
  eq([r.reason, r.taskId, db.one(`SELECT status FROM projects WHERE id=?`, E.projectId).status].join('|'), ['workspace_created', b, 'active'].join('|'), 'A 中止：不依赖它的 B 照常开工，项目不停滞');
  // 若只串行 + 只快进，这里得拒绝恢复（A 的半成品之后合不进去）。合并前会先机械集成（把项目分支合进来），
  // 所以那条前提不成立 —— 只剩"并发上限"这一条真约束。
  setMaxOpen(db, { projectId: E.projectId, n: 1, userId: owner.userId });
  throws(() => reopenTask(db, { taskId: a, userId: owner.userId }), /已到上限 1/, '上限 1（串行）时 B 开着 → 恢复 A 会超并发，拒，并说清怎么办');
  setMaxOpen(db, { projectId: E.projectId, n: 2, userId: owner.userId });
  reopenTask(db, { taskId: a, userId: owner.userId });
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, a).status !== 'aborted', true, '上限 2 时可以恢复：轮到它合并时走集成那条路');
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, a);   // 恢复这一条验完，放回中止，继续走下面的重做用例
  writeFileSync(join(ws(b), 'b.txt'), 'b'); gitc(ws(b), 'add', '.'); gitc(ws(b), 'commit', '-q', '-m', 'b');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, b); signOff(db, { taskId: b, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  r = await advanceProject(db, { projectId: E.projectId, home: HOME });
  eq([r.reason, r.nextTaskId].join('|'), 'merged|', 'B 合并后：C 在等被中止的 A，没有可开的');
  r = await advanceProject(db, { projectId: E.projectId, home: HOME });
  eq([r.reason, db.one(`SELECT status FROM projects WHERE id=?`, E.projectId).status].join('|'), 'task_aborted|stalled', '剩下的都被 A 卡住 → 这时项目才停滞');
  // 项目分支前进过也可以恢复；这个用例接着走"重做"，因为下面要断言重做的行为。
  reopenTask(db, { taskId: a, userId: owner.userId });
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, a).status !== 'aborted', true, '项目分支前进过也能恢复了 —— 半成品靠集成接上，接不上再提事项');
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, a);
  db.run(`UPDATE projects SET status='stalled' WHERE id=?`, E.projectId);
  const rd = redoProjectTask(db, { projectId: E.projectId, userId: owner.userId, taskId: a });
  eq(JSON.stringify([db.one(`SELECT project_order FROM tasks WHERE id=?`, rd.newTaskId).project_order, getParam(db, rd.newTaskId, 'task.depends_on'), projectTasks(db, E.projectId).find((t) => t.id === c).dependsOn]),
    JSON.stringify([1, [], [1]]), '重做：新任务沿用编号 #1 与依赖；下游 C 的依赖（按编号）不用改');
  r = await advanceProject(db, { projectId: E.projectId, home: HOME });
  eq([r.reason, r.taskId].join('|'), ['workspace_created', rd.newTaskId].join('|'), '项目回 active，新的 #1 开工');
  assert(existsSync(join(ws(rd.newTaskId), 'b.txt')), '重做的任务从项目分支当前状态起（看得到已合并的 B）');
  eq(JSON.stringify(getParam(db, rd.newTaskId, 'task.verify_extra')), JSON.stringify([['node', '--test', 'tests/B.test.mjs']]), '回归义务按开工时重算：含先合并的 B');
}

section('10c. 依赖图：插入（不依赖的新任务不用等）、blocks（让未开工的任务等新任务）、漂移提示');
{
  const T = (t, extra = {}) => ({ title: t, goal: `g ${t}`, definition_of_done: `d ${t}`, verify_command: `node --test tests/${t}.test.mjs`, ...extra });
  const F = createProject(db, { userId: owner.userId, spec: { title: '插入', tasks: [T('A'), T('B'), T('C')] }, source: SRC, home: HOME });   // 没写依赖 = 线性
  const [a, b, c] = F.taskIds;
  eq(JSON.stringify(projectTasks(db, F.projectId).map((t) => t.dependsOn)), JSON.stringify([[], [1], [2]]), '不写 depends_on = 依赖前一个编号（线性）');
  const ws = (id) => join(HOME, 'workspaces', id);
  const finish = (id, file) => { writeFileSync(join(ws(id), file), file); gitc(ws(id), 'add', '.'); gitc(ws(id), 'commit', '-q', '-m', file);
    db.run(`UPDATE tasks SET status='done' WHERE id=?`, id); signOff(db, { taskId: id, accept: true, plaintextToken: owner.plaintext, userId: owner.userId }); };
  const existing = () => chainGraph(db, F.projectId).map((t) => ({ order: t.order, started: t.started, dependsOn: t.dependsOn }));
  assert(validateProjectSpec({ title: 'x', tasks: [T('X', { depends_on: [], blocks: [1] })] }, { deps: { startOrder: 4, existing: existing() } }).some((e) => /已经开工或已结束/.test(e)), 'blocks 指向已开工的任务 → 拒');
  assert(validateProjectSpec({ title: 'x', tasks: [T('X', { depends_on: [3], blocks: [2] })] }, { deps: { startOrder: 4, existing: existing() } }).some((e) => /成环/.test(e)), 'blocks 会成环（新任务依赖 #3，#3 依赖 #2）→ 拒');
  finish(a, 'a.txt');
  let r = await advanceProject(db, { projectId: F.projectId, home: HOME });
  eq(r.nextTaskId, b, 'A 合并 → 开 #2');
  await new Promise((ok) => setTimeout(ok, 5));   // 批次用毫秒时间戳：保证新批次严格晚于第一批
  // 插入一个独立的小模块 #4：不依赖任何任务
  const [x] = createProjectTasks(db, { projectId: F.projectId, userId: owner.userId, tasks: [T('X', { depends_on: [] })], startOrder: 4 });
  eq(JSON.stringify(projectTasks(db, F.projectId).find((t) => t.id === x).dependsOn), '[]', '#4 不依赖任何任务');
  db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, b);   // #2 卡住了
  r = await advanceProject(db, { projectId: F.projectId, home: HOME });
  eq([r.reason, r.taskId].join('|'), ['workspace_created', x].join('|'), '#2 中止、#3 在等 #2：独立的 #4 不用等，直接开工');
  eq(getParam(db, x, 'task.drift_note') ?? null, null, '#4 定稿时 #1 已在仓库里、#2 #3 的契约它也看得到：没有漂移');
  finish(x, 'x.txt');
  await advanceProject(db, { projectId: F.projectId, home: HOME });
  await advanceProject(db, { projectId: F.projectId, home: HOME });
  eq(db.one(`SELECT status FROM projects WHERE id=?`, F.projectId).status, 'stalled', '#4 合并后只剩被 #2 卡住的 → 停滞');
  const rd = redoProjectTask(db, { projectId: F.projectId, userId: owner.userId });
  r = await advanceProject(db, { projectId: F.projectId, home: HOME });
  eq(r.taskId, rd.newTaskId, '重做的 #2 开工');
  const note = getParam(db, rd.newTaskId, 'task.drift_note') ?? '';
  assert(/#4「X」/.test(note) && /x.txt/.test(note) && !/#1「A」/.test(note), '漂移提示：#2 的契约定稿之后才添加、不在它依赖关系里、却先合并了的 #4 被点名，连同改动的文件');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_task_drift' AND target_id=?`, F.projectId).n, 1, '漂移记审计');
  // blocks：再加一个 #5，要求未开工的 #3 等它
  eq(validateProjectSpec({ title: 'x', tasks: [T('Y', { depends_on: [], blocks: [3] })] }, { deps: { startOrder: 5, existing: existing() } }).length, 0, '独立的新任务 + 让未开工的 #3 等它 → 合规');
  const [y] = createProjectTasks(db, { projectId: F.projectId, userId: owner.userId, tasks: [T('Y', { depends_on: [], blocks: [3] })], startOrder: 5 });
  eq(JSON.stringify(projectTasks(db, F.projectId).find((t) => t.id === c).dependsOn), '[2,5]', '#3 现在还要等 #5（只改先后）');
  eq(db.one(`SELECT count(*) n FROM constitutions WHERE task_id=?`, c).n, 1, '#3 的契约没有新版本');
  finish(rd.newTaskId, 'b.txt');
  r = await advanceProject(db, { projectId: F.projectId, home: HOME });
  eq(r.nextTaskId, y, '#2 合并后：#3 还要等 #5，先开 #5');
  finish(y, 'y.txt');
  r = await advanceProject(db, { projectId: F.projectId, home: HOME });
  eq(r.nextTaskId, c, '#5 合并后 #3 才开工');
  const n3 = getParam(db, c, 'task.drift_note') ?? '';
  assert(/#4「X」/.test(n3) && !/#5「Y」/.test(n3), '#3 的漂移提示点名 #4（陌生任务），不点名 #5（已在它的依赖关系里）');
}

section('11. 等人时让路：开着的任务全在等人 → 独立的下一个先跑起来');
{
  // 三个互不依赖的任务。串行时 B、C 要一直排队；让路之后，A 在等人签收的那段时间 B 可以开工。
  const mk = (t, f) => ({ title: t, goal: `g ${t}`, definition_of_done: `d ${t}`, depends_on: [],
    verify_command: `node --test tests/${f}.test.mjs` });
  const Q = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '三件独立的活', brief: '互不相干', tasks: [mk('A', 'a'), mk('B', 'b'), mk('C', 'c')] } });
  const [a, b, c] = Q.taskIds;
  const ws = (id) => join(HOME, 'workspaces', id);
  const produce = (id, file, body) => { writeFileSync(join(ws(id), file), body); gitc(ws(id), 'add', '.'); gitc(ws(id), 'commit', '-q', '-m', `产物 ${file}`); };
  const adv = (o = {}) => advanceProject(db, { projectId: Q.projectId, home: HOME, userId: owner.userId, ...o });
  // 重跑用的假执行器：只记下跑了哪些命令，一律算过。真容器在测试里起不来，而这里要断言的是
  // "集成之后**有没有**重跑、重跑了几条"，不是命令本身。
  let ran = [];
  const okExec = async () => ({ execute: async (cmd, dir) => { ran.push({ argv: [cmd.file, ...cmd.args], dir }); return { code: 0, stdout: '', stderr: '', timedOut: false }; } });
  const failExec = async () => ({ execute: async (cmd) => { ran.push({ argv: [cmd.file, ...cmd.args] }); return { code: 1, stdout: 'FAIL: 回归挂了', stderr: '', timedOut: false }; } });

  assert(existsSync(ws(a)) && !existsSync(ws(b)), '只有 A 开了工 —— 让路不是"一上来就全开"');
  let r = await adv();
  eq(r.reason, 'waiting:planning', 'A 还在 planning（真的在做）→ 不开新的：那不是让路，是加塞');
  eq(existsSync(ws(b)), false, 'B 仍然没开工');

  // A 做完 → 一条签收事项挂上 → A 在等人
  produce(a, 'a.mjs', 'export const a = 1;\n');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, a);
  raiseSignoffQuestion(db, { taskId: a, head: git(ws(a), 'rev-parse', 'HEAD'), branch: `v0/${a}` });
  eq(waitingOnHuman(db, a), true, '判据：A 在等人（用的就是停等账本那个函数）');
  r = await adv();
  eq(r.reason, 'workspace_created:letting_through', 'A 在等人 → 让路，B 开工');
  eq(r.taskId, b, '开的是 ready 里编号最小的那个');
  eq(r.concurrent, 2, '同时开着两个');
  assert(existsSync(ws(b)), 'B 的工作区建出来了');
  eq(git(ws(b), 'rev-parse', 'HEAD'), Q.baseRef, 'B 从项目分支当前头起（A 还没合并，头没动）');

  // 上限默认 2：C 不许再开
  r = await adv();
  eq(r.reason, 'needs_signoff', '到上限了 → 不再开第三个，理由仍是 A 在等签收');
  eq(existsSync(ws(c)), false, 'C 还排着');
  eq(maxOpenOf(db, Q.projectId), 2, '同时开着的任务上限默认 2');

  // A 签收 → 合并（此时 A 还是快进，不用集成）
  signOff(db, { taskId: a, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  r = await adv({ makeExec: okExec });
  eq(r.reason, 'merged', 'A 合并');
  eq(r.integrated, false, 'A 是快进，没有走集成');
  eq(ran.length, 0, '快进就不重跑 —— 不花那份钱');
  eq(existsSync(ws(c)), false, 'B 正在做（不在等人）→ 合并完也不顺手再开一个');

  // B 做完 → 它的分支落后于项目分支头了 → 走集成 + 重跑
  produce(b, 'b.mjs', 'export const b = 2;\n');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, b);
  const bSigned = git(ws(b), 'rev-parse', 'HEAD');       // 人签的就是这一个
  signOff(db, { taskId: b, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  ran = [];
  r = await adv({ makeExec: okExec });
  eq(r.reason, 'merged', 'B 也合并了');
  eq(r.integrated, true, 'B 不是快进 → 机械集成（merge）');
  eq(ran.length, 2, '集成之后重跑了 2 条：它自己的验收 + 1 条回归义务');
  eq(ran[0].argv.join(' '), 'node --test tests/b.test.mjs', '第一条是它自己的');
  eq(ran[1].argv.join(' '), 'node --test tests/a.test.mjs', '第二条是 A 的验收命令（回归义务）');
  assert(existsSync(join(Q.repo, 'a.mjs')) && existsSync(join(Q.repo, 'b.mjs')), '两个任务的产物都在项目分支上');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_task_integrated' AND target_id=?`, b).n, 1, '集成进审计');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_task_integrate_verified' AND target_id=?`, b).n, 1, '重跑通过也进审计');

  // ── ①：用 merge（不用 rebase）集成必须成立的三件事 ─────────────────────────────────
  const reachable = (dir, sha, from) => { try { git(dir, 'merge-base', '--is-ancestor', sha, from); return true; } catch { return false; } };
  const bHead = git(ws(b), 'rev-parse', 'HEAD');
  assert(reachable(ws(b), bSigned, bHead), '**签收记下的那个头仍在分支上** —— merge 不改写历史（rebase 会把签收记的那个头抹掉）');
  eq(Number(git(ws(b), 'rev-list', '--count', '--merges', `${Q.baseRef}..${bHead}`)), 1, '集成产生的是一个合并提交，不是一串被重写的提交');
  const allCommits = Number(git(Q.repo, 'rev-list', '--count', `${Q.baseRef}..${Q.branch}`));
  const ev11 = deliveryEvidence(db, { projectId: Q.projectId });
  eq(allCommits - ev11.stat.commits, 1, '交付页的提交数刨掉了那 1 个集成提交（--no-merges）—— 它不是任何人写的代码');

  // ── ① 顺带的那道闸：mergeable 不能只看签收状态，还要看**签的是哪一份** ────────
  // 用 rebase 时这条松得无害（rebase 会重写历史，签的那个头本来就对不上）；用 merge 时它承重了：
  // 集成会正大光明地让工作区的头往前走，"头动过"不再等价于"没签过"。
  {
    eq(signoffCoversDone(db, b), true, '正常路径：签的就是 task_done 那一份');
    audit(db, { actorKind: 'agent', action: 'task_done', targetType: 'task', targetId: c, payload: { head: 'f'.repeat(40) } });
    db.run(`UPDATE tasks SET status='done' WHERE id=?`, c);
    eq(signoffCoversDone(db, c), true, '从来没签过（拿不到签收头）→ 放行，这条是补闸不是加门槛');
    raiseSignoffQuestion(db, { taskId: c, head: 'f'.repeat(40) });
    signOff(db, { taskId: c, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
    eq(signoffCoversDone(db, c), true, '签的正是现在这一份 → 可以合并');
    audit(db, { actorKind: 'agent', action: 'task_done', targetType: 'task', targetId: c, payload: { head: 'e'.repeat(40) } });
    eq(signoffCoversDone(db, c), false, '**产物在签收之后又变过 → 不许合并**：签的那一份不是现在要推的这一份');
  }
}

section('11b. 集成之后重跑没过 / 集成有冲突：任务原样留着，一条结构矛盾事项');
{
  const mk = (t, f, extra = {}) => ({ title: t, goal: `g ${t}`, definition_of_done: `d ${t}`, depends_on: [],
    verify_command: `node --test tests/${f}.test.mjs`, ...extra });
  const Q = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '会撞上的两件活', brief: '两个人改同一个文件', tasks: [mk('D', 'd'), mk('E', 'e')] } });
  const [d, e] = Q.taskIds;
  const ws = (id) => join(HOME, 'workspaces', id);
  const produce = (id, file, body) => { writeFileSync(join(ws(id), file), body); gitc(ws(id), 'add', '.'); gitc(ws(id), 'commit', '-q', '-m', `产物 ${file}`); };
  const adv = (o = {}) => advanceProject(db, { projectId: Q.projectId, home: HOME, userId: owner.userId, ...o });
  let ran = [];
  const okExec = async () => ({ execute: async (cmd) => { ran.push([cmd.file, ...cmd.args].join(' ')); return { code: 0, stdout: '', stderr: '', timedOut: false }; } });
  const failExec = async () => ({ execute: async (cmd) => { ran.push([cmd.file, ...cmd.args].join(' ')); return { code: 1, stdout: 'FAIL: 回归挂了\n断言 3 不通过', stderr: '', timedOut: false }; } });

  // D 与 E 都改 shared.mjs 的同一行 —— 先让 D 合并，E 集成时必冲突
  produce(d, 'shared.mjs', 'export const V = "D";\n');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, d);
  raiseSignoffQuestion(db, { taskId: d, head: git(ws(d), 'rev-parse', 'HEAD'), branch: `v0/${d}` });
  await adv();                       // D 在等签收 → 让路开 E
  assert(existsSync(ws(e)), 'E 让路开工');
  produce(e, 'shared.mjs', 'export const V = "E";\n');
  signOff(db, { taskId: d, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  let r = await adv({ makeExec: okExec });
  eq(r.reason, 'merged', 'D 先合并');

  // E 现在要把含 shared.mjs="D" 的项目分支头合进自己的分支 —— 冲突
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, e);
  audit(db, { actorKind: 'agent', action: 'task_done', targetType: 'task', targetId: e, payload: { head: git(ws(e), 'rev-parse', 'HEAD') } });
  signOff(db, { taskId: e, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  ran = [];
  r = await adv({ makeExec: okExec });
  eq(r.reason, 'integrate_conflict', '集成冲突');
  eq(ran.length, 0, '冲突就不重跑了 —— 树还没合上去，跑什么都不说明问题');
  eq(projectTasks(db, Q.projectId).find((t) => t.id === e).merged_at, null, 'E 没有合并');
  eq(git(ws(e), 'rev-parse', '--abbrev-ref', 'HEAD'), `v0/${e}`, '合并已回滚：工作区还在自己的分支上，不是半截的 detached');
  assert(existsSync(join(ws(e), 'shared.mjs')), 'E 的产物原样留着');
  const q = db.one(`SELECT text, level, decision_type FROM questions WHERE task_id=? AND status='open' ORDER BY asked_at DESC LIMIT 1`, e);
  eq(q.level, 3, 'Ⅲ 级');
  eq(q.decision_type, 'structural', '归结构矛盾');
  assert(/合并有冲突/.test(q.text) && /shared\.mjs/.test(q.text), '正文说清是冲突、冲突在哪个文件');
  // ③：冲突的答案空间是**封闭的三选一**。不给"打回让它自己改"这条出路 ——
  // 它容易白烧一整轮（角色看懂了冲突，却没法把结论表达成一侧，于是说"你重新变基一次"）。
  assert(/\(A\) \*\*取任务 #2 这一侧\*\*/.test(q.text) && /\(B\) \*\*取项目分支这一侧\*\*/.test(q.text) && /\(C\) \*\*两边都不对\*\*/.test(q.text), '答案空间封闭成三选一');
  // 写「我这侧」时读者要读两遍才确定"我"不是他自己 —— 而读错就会把 A/B 选反。
  assert(!/我这侧/.test(q.text), '两侧一律按名字叫，不用"我"这个会被读成"读者自己"的字');
  assert(!new RegExp(`signoff ${e} --reject`).test(q.text), '冲突那一档不再给"打回让它自己改"这条出路');
  // ①：merge 的两侧是"我这侧 = 任务自己的产物"，与 rebase 正好相反。
  // **署名恰恰是判断的全部依据** —— 两侧各是谁的活、谁签的字，机器手里全有，必须摆在正文里。
  assert(/\*\*任务 #2 这一侧\*\*（`<<<<<<< HEAD` 那一段）= 「E」/.test(q.text), '正文点名 HEAD 那一段是这个任务自己的');
  assert(/\*\*项目分支这一侧\*\*/.test(q.text) && /任务 #1「D」（shared\.mjs/.test(q.text), '正文点名另一侧是哪个任务带进来的、动的哪个文件');
  assert(/由local-owner签收/.test(q.text), '连谁签的字都写出来了');
  assert(/拦不住这一侧在语义上选错了/.test(q.text) && /粒度是"全部冲突文件一起取一侧"/.test(q.text), '两条已知限制当场说破，不藏');
  assert(!/\(D\)/.test(q.text), '两边各自新建同名文件（add/add）不算"两边都新增" → 不给 (D)：两份不同的新文件拼起来多半是坏的');

  // 同一个项目分支头不再试第二次 —— 集成 + 重跑要起一次容器，每拍重试一遍就是在烧钱
  ran = [];
  r = await adv({ makeExec: okExec });
  assert(r.reason !== 'integrate_conflict', '不再重复集成');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_task_integrate_conflict' AND target_id=?`, e).n, 1, '冲突只记了一次');

  // 闸的第二把钥匙。blockedAtHead 读 b.taskHead，raiseIntegrateBlocked 必须写这个字段 ——
  // 否则"它自己改完再交"这条路走到底是死的：它改完再 done 一次，
  // 还是合不进来，只有项目分支恰好又动过才解得开。
  {
    const b0 = getParam(db, e, 'task.rebase_blocked');
    eq(b0.taskHead, git(ws(e), 'rev-parse', 'HEAD'), '卡住时记下了它当时交的那一版');
    eq(blockedAtHead(db, e, b0.onto), true, '项目分支没动、它也没再交 → 还卡着');
    produce(e, 'shared.mjs', 'export const V = "E 改过了";\n');
    audit(db, { actorKind: 'agent', action: 'task_done', targetType: 'task', targetId: e, payload: { head: git(ws(e), 'rev-parse', 'HEAD') } });
    eq(blockedAtHead(db, e, b0.onto), false, '它又交了一版 → 闸开，下一拍重新试（这才是"打回让它改"能走通的前提）');
    // 上面那条 task_done 是手写的（实际由执行器写），所以这里把签收也按实际流程补齐：
    // 产物变了 → 重新进签收 → 人再签一次。不补的话 ① 那道 signoffCoversDone 会**正确地**拦住它。
    eq(signoffCoversDone(db, e, git(ws(e), 'rev-parse', 'HEAD')), false, '产物在签收之后变过 → ① 那道闸先拦一道');
    raiseSignoffQuestion(db, { taskId: e, head: git(ws(e), 'rev-parse', 'HEAD'), branch: `v0/${e}`, dir: ws(e) });
    signOff(db, { taskId: e, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  }

  // 封闭答案空间的口径：认前缀，不猜语义。认不出来就是 (C)，宁可停在那儿被停等账本报出来。
  eq(conflictSide('A'), 'ours', '"A" → 取我这侧');
  eq(conflictSide('(B) 取项目分支那侧'), 'theirs', '"(B) …" → 取项目分支那侧');
  eq(conflictSide('取我这侧，这个任务的写法是对的'), 'ours', '写汉字也认');
  eq(conflictSide('C'), 'other', '"C" → 两边都不对');
  eq(conflictSide('你把 scripts 三项都保留一下'), 'other', '**不在答案空间里的自由文本不猜一侧** —— 这种写法会白白烧掉一整轮');
  eq(conflictSide('D'), 'union', '"D" → 两边都保留新增内容');
  eq(conflictSide('(D) keep both'), 'union', '英文写法也认');

  // (D) 两边都保留新增内容：两边各自往同一个测试文件末尾追加用例时，取任何一侧都丢掉另一侧的用例。
  // 新增块两边都留（项目分支的在前），其余冲突块取项目分支一侧。
  {
    const { countConflictBlocks, resolveConflictWith } = await import('../src/core/project.mjs');
    const R = join(TMP, 'union'); mkdirSync(R);
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { cwd: R, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g('init', '-q', '-b', 'main');
    writeFileSync(join(R, 'cases.test.mjs'), "test('base');\n"); writeFileSync(join(R, 'cfg.json'), '{"seed": "old"}\n');
    g('add', '.'); g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'task');
    writeFileSync(join(R, 'cases.test.mjs'), "test('base');\ntest('task case');\n"); writeFileSync(join(R, 'cfg.json'), '{"seed": "task"}\n');
    g('commit', '-q', '-am', 'task');
    g('checkout', '-q', 'main');
    writeFileSync(join(R, 'cases.test.mjs'), "test('base');\ntest('project case');\n"); writeFileSync(join(R, 'cfg.json'), '{"seed": "project"}\n');
    g('commit', '-q', '-am', 'project');
    g('checkout', '-q', 'task');
    try { g('merge', '--no-edit', 'main'); } catch { /* 预期冲突 */ }
    const files = g('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean).sort();
    eq(files.join(), 'cases.test.mjs,cfg.json', '两个文件都冲突');
    eq(JSON.stringify(countConflictBlocks(R, files)), JSON.stringify({ additive: 1, total: 2 }), '一处是两边都新增，一处是改同一行');
    resolveConflictWith(R, 'union');
    eq(readFileSync(join(R, 'cases.test.mjs'), 'utf8'), "test('base');\ntest('project case');\ntest('task case');\n", '新增块两边都留，项目分支的在前');
    eq(readFileSync(join(R, 'cfg.json'), 'utf8'), '{"seed": "project"}\n', '改同一行的那处取项目分支一侧');
    eq(g('diff', '--name-only', '--diff-filter=U'), '', '没有残留冲突');
  }

  // 事项底下就是答复框，人在里面写下处置 —— 那就**是**一次动作，不是一条被记下来然后没人管的留言。
  // 那个动作是"取哪一侧"：系统只记下选择，真正的合并在下一拍由 integrateProjectBranch 机械执行，
  // 于是解冲突、重跑验收、写审计全都还在那条唯一的路上。
  const qid = db.one(`SELECT id FROM questions WHERE task_id=? AND status='open' AND decision_type='structural' ORDER BY asked_at DESC LIMIT 1`, e).id;
  const ansRes = recordAnswer(db, { questionId: qid, body: 'A', plaintextToken: owner.plaintext });
  eq(ansRes.hook?.side, 'ours', '答复触发了"取我这侧"，而不是"记下来就完了"');
  eq(getParam(db, e, 'task.integrate_resolution').side, 'ours', '选择落库，等下一拍执行');
  eq(getParam(db, e, 'task.rebase_blocked'), null, '集成闸解开：人给了处置，下一拍该重新试');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, e).status, 'done', '任务不回 running —— 没有人要它再改什么，要动手的是系统');

  // 下一拍：机械解冲突 → 重跑 → **签收作废，重新找人签**
  ran = [];
  r = await adv({ makeExec: okExec });
  eq(r.reason, 'integrate_resolved', '解完冲突不直接合并');
  eq(r.side, 'ours', '取的是人选的那一侧');
  eq(readFileSync(join(ws(e), 'shared.mjs'), 'utf8').replace(/\r/g, ''), 'export const V = "E 改过了";\n', '冲突处按"我这侧"定了，一字不改');
  assert(!readFileSync(join(ws(e), 'shared.mjs'), 'utf8').includes('<<<<<<<'), '工作区里没有残留冲突标记');
  eq(ran.length, 2, '解完还是要重跑：它自己的验收 + 回归义务');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_task_conflict_resolved' AND target_id=?`, e).n, 1, '解冲突进审计（记了取哪一侧、谁选的）');
  eq(projectTasks(db, Q.projectId).find((t) => t.id === e).merged_at, null, '还没合并 —— 先得有人对这个新状态签字');
  // 拍定的边界：**干净集成不作废签收；解过冲突的集成作废、重新签收。**
  eq(getParam(db, e, 'signoff.status'), 'pending', '解过冲突 → 签收作废，重新进签收');
  eq(JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='signoff_voided' AND target_id=? ORDER BY id DESC LIMIT 1`, e).payload).newHead,
    git(ws(e), 'rev-parse', 'HEAD'), '作废这件事记在审计里，指向的正是集成之后那个新头');
  const reQ = db.one(`SELECT text FROM questions WHERE task_id=? AND decision_type='signoff' AND status='open' ORDER BY asked_at DESC LIMIT 1`, e);
  assert(reQ && /本轮（上次签收/.test(reQ.text), '新的签收事项只给人看"这一轮真正变了什么"');

  // 签了字才合并；这一次项目头已经在它的历史里了，所以是快进，不再集成一遍
  signOff(db, { taskId: e, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  ran = [];
  r = await adv({ makeExec: okExec });
  eq(r.reason, 'merged_last', '签了字就合并（E 是最后一个，所以这一拍顺带做了项目层收口）');
  eq(r.integrated, false, '项目头已经在它的历史里 → 快进，不再多花一次集成 + 重跑');
  eq(readFileSync(join(Q.repo, 'shared.mjs'), 'utf8').replace(/\r/g, ''), 'export const V = "E 改过了";\n', '项目分支上是人选的那一侧');

  // (C)「两边都不对」/ 看不懂的自由文本：系统不动手，闸原样留着
  const R0 = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '答复写中止', brief: 'x', tasks: [mk('H', 'h')] } });
  const hAb = R0.taskIds[0];
  const qh = raiseIntegrateBlocked(db, { project: db.one(`SELECT * FROM projects WHERE id=?`, R0.projectId), task: db.one(`SELECT * FROM tasks WHERE id=?`, hAb), result: { kind: 'conflict', target: 'deadbeef', files: ['x.mjs'], tail: '' } }).questionId;
  const ab = recordAnswer(db, { questionId: qh, body: '中止，这个任务不要了', plaintextToken: owner.plaintext });
  eq(ab.hook?.handled, false, '答复写"中止"不算数 —— 不可逆的动作留给人自己去点');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, hAb).status !== 'running', true, '没有被放回去做');
  assert(getParam(db, hAb, 'task.rebase_blocked'), '闸原样留着 —— 系统不猜一侧，任务停在那儿等人去项目页动手');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_task_conflict_declined' AND target_id=?`, hAb).n, 1, '"没选侧"这件事本身进审计（停等账本随后会把它报成缺陷形状的停摆）');

  // 换一个项目：集成干净，但重跑没过
  const R = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '集成干净但回归挂了', brief: '各改各的', tasks: [mk('F', 'f'), mk('G', 'g')] } });
  const [f, g] = R.taskIds;
  const adv2 = (o = {}) => advanceProject(db, { projectId: R.projectId, home: HOME, userId: owner.userId, ...o });
  writeFileSync(join(HOME, 'workspaces', f, 'f.mjs'), 'export const f = 1;\n'); gitc(join(HOME, 'workspaces', f), 'add', '.'); gitc(join(HOME, 'workspaces', f), 'commit', '-q', '-m', 'F');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, f);
  raiseSignoffQuestion(db, { taskId: f, head: git(join(HOME, 'workspaces', f), 'rev-parse', 'HEAD'), branch: `v0/${f}` });
  await adv2();
  writeFileSync(join(HOME, 'workspaces', g, 'g.mjs'), 'export const g = 1;\n'); gitc(join(HOME, 'workspaces', g), 'add', '.'); gitc(join(HOME, 'workspaces', g), 'commit', '-q', '-m', 'G');
  signOff(db, { taskId: f, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  await adv2({ makeExec: okExec });
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, g);
  signOff(db, { taskId: g, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  ran = [];
  r = await adv2({ makeExec: failExec });
  eq(r.reason, 'integrate_verify_failed', '集成干净但重跑没过');
  eq(ran.length, 1, '第一条不过就停，不接着跑剩下的');
  eq(projectTasks(db, R.projectId).find((t) => t.id === g).merged_at, null, 'G 没有合并');
  const q2 = db.one(`SELECT text FROM questions WHERE task_id=? AND status='open' ORDER BY asked_at DESC LIMIT 1`, g);
  assert(/合并之后重跑验收没过/.test(q2.text) && /断言 3 不通过/.test(q2.text), '正文带上失败输出的尾巴');

  // 跑不起来（没有容器运行时）算不过，不算通过
  const R2 = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '沙箱起不来', brief: 'x', tasks: [mk('H', 'h'), mk('I', 'i')] } });
  const [h, i2] = R2.taskIds;
  const adv3 = (o = {}) => advanceProject(db, { projectId: R2.projectId, home: HOME, userId: owner.userId, ...o });
  writeFileSync(join(HOME, 'workspaces', h, 'h.mjs'), 'x\n'); gitc(join(HOME, 'workspaces', h), 'add', '.'); gitc(join(HOME, 'workspaces', h), 'commit', '-q', '-m', 'H');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, h);
  raiseSignoffQuestion(db, { taskId: h, head: git(join(HOME, 'workspaces', h), 'rev-parse', 'HEAD'), branch: `v0/${h}` });
  await adv3();
  writeFileSync(join(HOME, 'workspaces', i2, 'i.mjs'), 'x\n'); gitc(join(HOME, 'workspaces', i2), 'add', '.'); gitc(join(HOME, 'workspaces', i2), 'commit', '-q', '-m', 'I');
  signOff(db, { taskId: h, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  await adv3({ makeExec: okExec });
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, i2);
  signOff(db, { taskId: i2, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  r = await adv3({ makeExec: async () => { throw new Error('没有找到容器运行时'); } });
  eq(r.reason, 'integrate_verify_failed', '沙箱起不来 = 没过，不是"就当过了"');
  assert(/没能跑起来/.test(db.one(`SELECT text FROM questions WHERE task_id=? AND status='open' ORDER BY asked_at DESC LIMIT 1`, i2).text), '正文说清是没跑起来，不是断言挂了');
}

section("11g. 解冲突的原语必须是 merge-file，不是 checkout --ours");
// 这一节只证一件事，而它是选这个原语的全部理由：
// `git checkout --ours <file>` 是"整份文件取这一侧"，会把**同一个文件里已经干净合并的部分**一起扔掉；
// `git merge-file --ours` 是逐冲突块取，干净的部分原样保留。两个候选的差别就在这里。
{
  const mk = (t, f) => ({ title: t, goal: `g ${t}`, definition_of_done: `d ${t}`, depends_on: [],
    verify_command: `node --test tests/${f}.test.mjs` });
  // 十行的 cfg.mjs：一个任务改第 1 行，另一个改第 10 行 —— 中间隔得够开，git 会当成两个独立的 hunk
  writeFileSync(join(SRC, 'cfg.mjs'), [...Array(10)].map((_, i) => `line${i + 1}`).join('\n') + '\n');
  gitc(SRC, 'add', '.'); gitc(SRC, 'commit', '-q', '-m', 'cfg');
  const Q = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '同一文件里一处干净一处冲突', brief: 'x', tasks: [mk('P', 'p'), mk('R', 'r')] } });
  const [p1, r1] = Q.taskIds;
  const ws = (id) => join(HOME, 'workspaces', id);
  const lines = (dir) => readFileSync(join(dir, 'cfg.mjs'), 'utf8').replace(/\r/g, '').split('\n');
  const put = (id, n, v) => { const L = lines(ws(id)); L[n - 1] = v; writeFileSync(join(ws(id), 'cfg.mjs'), L.join('\n'));
    gitc(ws(id), 'add', '.'); gitc(ws(id), 'commit', '-q', '-m', `改第 ${n} 行`); };
  const adv = (o = {}) => advanceProject(db, { projectId: Q.projectId, home: HOME, userId: owner.userId, ...o });
  const okExec = async () => ({ execute: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) });

  // P 改第 1 行**和**第 10 行；R 只改第 10 行 → 合并时第 1 行干净、第 10 行冲突
  put(p1, 1, 'line1 —— P 改的');
  put(p1, 10, 'line10 —— P 改的');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, p1);
  raiseSignoffQuestion(db, { taskId: p1, head: git(ws(p1), 'rev-parse', 'HEAD'), branch: `v0/${p1}`, dir: ws(p1) });
  await adv();                                  // P 在等签收 → 让路开 R
  put(r1, 10, 'line10 —— R 改的');
  signOff(db, { taskId: p1, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  await adv({ makeExec: okExec });               // P 合并

  db.run(`UPDATE tasks SET status='done' WHERE id=?`, r1);
  audit(db, { actorKind: 'agent', action: 'task_done', targetType: 'task', targetId: r1, payload: { head: git(ws(r1), 'rev-parse', 'HEAD') } });
  raiseSignoffQuestion(db, { taskId: r1, head: git(ws(r1), 'rev-parse', 'HEAD'), branch: `v0/${r1}`, dir: ws(r1) });
  signOff(db, { taskId: r1, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  let r = await adv({ makeExec: okExec });
  eq(r.reason, 'integrate_conflict', 'R 集成时第 10 行冲突');

  const qid = db.one(`SELECT id FROM questions WHERE task_id=? AND status='open' AND decision_type='structural' ORDER BY asked_at DESC LIMIT 1`, r1).id;
  recordAnswer(db, { questionId: qid, body: '(A) 取我这侧', plaintextToken: owner.plaintext });
  r = await adv({ makeExec: okExec });
  eq(r.reason, 'integrate_resolved', '按"取我这侧"解掉');

  const L = lines(ws(r1));
  eq(L[9], 'line10 —— R 改的', '冲突那一处取了我这侧 —— 这是人选的');
  eq(L[0], 'line1 —— P 改的', '**同一个文件里干净合并的那一处原样保留** —— 换成 git checkout --ours 这一行会退回 "line1"');
  assert(!L.some((x) => x.startsWith('<<<<<<<') || x.startsWith('>>>>>>>')), '没有残留冲突标记');
}

section('11d. 交付前的一手证据：这次要推什么 + 验收命令最近一次真跑出来什么');
{
  const P = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '要交付的', brief: 'x', tasks: [{ title: 'J', goal: 'g', definition_of_done: 'd', depends_on: [], verify_command: 'node --test tests/j.test.mjs' }] } });
  const j = P.taskIds[0];
  const ws = join(HOME, 'workspaces', j);
  writeFileSync(join(ws, 'j.mjs'), 'export const J = 1;\n'); gitc(ws, 'add', '.'); gitc(ws, 'commit', '-q', '-m', 'J 的产物');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, j);
  raiseSignoffQuestion(db, { taskId: j, head: git(ws, 'rev-parse', 'HEAD'), branch: `v0/${j}` });
  signOff(db, { taskId: j, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  const okExec2 = async () => ({ execute: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) });
  await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId, makeExec: okExec2 });

  let e = deliveryEvidence(db, { projectId: P.projectId });
  assert(e.stat && e.stat.commits >= 1, '说得出这次要推几个提交');
  assert(/j\.mjs/.test(e.stat.diffstat), '说得出改了哪些文件');
  eq(e.command, null, '没填验收命令时如实是 null');
  eq(e.verify, null, '没跑过就是没跑过，不编一个"通过"出来');
  // 说得出'哪个文件 / 提交是哪个任务的' —— 顺着合并记录里的头连成的链算，不猜
  eq(e.byTask?.tasks?.length, 1, '按任务分：一个已合并任务一段');
  assert(e.byTask.tasks[0].files.includes('j.mjs') && e.byTask.tasks[0].commits >= 1, '那一段里有它自己的文件和提交');
  assert(!!e.byTask.tasks[0].signer, '带着谁签的收');
  eq(e.byTask.tail, null, '分支头就是最后一次合并的头：没有来路不明的提交');

  // 填上命令、跑一次（假执行器），证据就该带上那次的真实输出
  setProjectVerify(db, { projectId: P.projectId, command: 'node --test', userId: owner.userId });
  await runProjectVerify(db, { projectId: P.projectId, home: HOME,
    makeExec: async () => ({ execute: async () => ({ code: 0, stdout: '# pass 7\n# fail 0', stderr: '', timedOut: false }) }) });
  e = deliveryEvidence(db, { projectId: P.projectId });
  eq(e.verify.ok, true, '跑过并通过');
  assert(/# pass 7/.test(e.verify.tail), '输出原文在证据里 —— 交付可能发生在几小时后、另一个进程里，不存下来这一页就只剩状态栏文字');
  eq(e.verify.ranAtHead, true, '跑的就是现在要推的这个头');

  // 验收之后项目分支又动了：那一次的"通过"不能再算数，页面必须说出来
  gitc(join(HOME, 'projects', P.projectId, 'repo'), 'commit', '-q', '--allow-empty', '-m', '验收之后又动了一下');
  e = deliveryEvidence(db, { projectId: P.projectId });
  eq(e.verify.ok, true, '那一次确实通过了（不改写历史）');
  eq(e.verify.ranAtHead, false, '但跑的不是现在要推的这份代码 —— 这正是最该说出来的一句');
  eq(e.byTask.tail?.commits, 1, '最后一次合并之后有人直接往项目分支上提交：那 1 个提交不属于任何任务，单独说出来');
}


section('11h. 逐任务重跑：项目级验收之外，每个已合并任务自己那条也各跑一遍');
// 负责人点交付前会问的那一句：「其余那些条测的是啥，它没给我看」。
// 只给输出尾巴只能回答"这里是最后 120 行，不是全部"—— 那是说清楚它不证明什么，答不了他真正问的。
// 逐任务重跑答得了，而且**精确、零启发式**：每个任务自己那条命令的退出码，按任务列出来。
{
  const mk = (t, f) => ({ title: t, goal: `g ${t}`, definition_of_done: `d ${t}`, depends_on: [],
    verify_command: `node --test tests/${f}.test.mjs` });
  const P = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '两个任务都合并了', brief: 'x', tasks: [mk('K', 'k'), mk('L', 'l')] } });
  const [k, l] = P.taskIds;
  const adv = (o = {}) => advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId, ...o });
  const okExec = async () => ({ execute: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) });
  const land = (id, file) => {
    const w = join(HOME, 'workspaces', id);
    writeFileSync(join(w, file), 'x\n'); gitc(w, 'add', '.'); gitc(w, 'commit', '-q', '-m', file);
    db.run(`UPDATE tasks SET status='done' WHERE id=?`, id);
    raiseSignoffQuestion(db, { taskId: id, head: git(w, 'rev-parse', 'HEAD'), branch: `v0/${id}`, dir: w });
    signOff(db, { taskId: id, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  };
  land(k, 'k.mjs'); await adv({ makeExec: okExec });
  land(l, 'l.mjs'); await adv({ makeExec: okExec });
  setProjectVerify(db, { projectId: P.projectId, command: 'node --test', userId: owner.userId });

  // 项目级那条过，两个任务自己的也都过
  const ran = [];
  await runProjectVerify(db, { projectId: P.projectId, home: HOME, makeExec: async () => ({
    execute: async (cmd) => { ran.push([cmd.file, ...cmd.args].join(' ')); return { code: 0, stdout: '# pass 39', stderr: '', timedOut: false }; } }) });
  eq(ran.length, 3, '同一个容器里一共跑了 3 条：项目级那条 + 两个任务各自那条');
  eq(ran[0], 'node --test', '第一条是项目级的（它才是闸门）');
  eq(ran.slice(1).sort().join('｜'), 'node --test tests/k.test.mjs｜node --test tests/l.test.mjs', '后两条是各任务自己的');
  let e = deliveryEvidence(db, { projectId: P.projectId });
  eq(e.verify.perTask.length, 2, '逐任务的结果进了交付证据');
  eq(e.verify.perTask.every((x) => x.ok === true), true, '都过');
  assert(e.verify.perTask.every((x) => x.title && x.order), '**按任务列出来** —— 人要看的是"T5 的验收：过"，不是一堆退出码');

  // 某个任务自己的挂了：**不改 ok**（闸门仍是项目级那条），但要作为证据如实记下来
  await runProjectVerify(db, { projectId: P.projectId, home: HOME, makeExec: async () => ({
    execute: async (cmd) => (cmd.args.join(' ').includes('k.test')
      ? { code: 1, stdout: 'not ok 3 分页边界', stderr: '', timedOut: false }
      : { code: 0, stdout: '# pass 39', stderr: '', timedOut: false }) }) });
  e = deliveryEvidence(db, { projectId: P.projectId });
  eq(e.verify.ok, true, '**闸门没变** —— ok 仍然只由项目级那条决定，不偷偷并进逐任务的结果');
  const badOne = e.verify.perTask.find((x) => x.ok === false);
  assert(badOne && badOne.order === 1, '挂的那个被逐条点名');
  assert(/not ok 3 分页边界/.test(badOne.tail), '挂的那条带上输出尾巴 —— 这正是"其余那些条测的是啥"要的东西');
  eq(e.verify.perTask.find((x) => x.order === 2).ok, true, '没挂的照旧是过');

  // 没有验收命令的老任务：如实说"没跑"，不算过也不算挂
  setParam(db, { taskId: l, key: 'task.verify_command', value: null, by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  await runProjectVerify(db, { projectId: P.projectId, home: HOME, makeExec: okExec });
  e = deliveryEvidence(db, { projectId: P.projectId });
  eq(e.verify.perTask.find((x) => x.order === 2).ok, null, '没有验收命令 → ok 是 null');
  eq(e.verify.perTask.find((x) => x.order === 2).why, 'no_command', '而且说得出为什么没跑');
}


section('11f. 沙箱收尾调的那个方法得真的存在');
{
  // 写成 `exec?.dispose?.()` 的话，ContainerExecutor 上那个方法叫 stop，
  // 可选调用碰上不存在的方法**静默什么也不做** —— 容器永远不会被删。
  // 项目级验收会踩中它：每次 ensureWorkspace(force:true) 把验收目录删掉重新克隆，
  // 上一次留下的容器还把旧目录 bind 挂着，第二次 exec 进去 docker 报
  // "possible container breakout detected"、退出码 128 —— 验收判没过，项目转 stalled，
  // 人收到的事项正文里就写着那句吓人的话；把容器删掉，同一条命令立刻通过。
  const P = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '收沙箱', brief: 'x', tasks: [{ title: 'K', goal: 'g', definition_of_done: 'd', depends_on: [], verify_command: 'node --test tests/k.test.mjs' }] } });
  setProjectVerify(db, { projectId: P.projectId, command: 'node --test', userId: owner.userId });
  const calls = [];
  // 只有 stop 的（真沙箱的形状）
  const stopOnly = async () => ({ execute: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }),
    stop: async (o) => calls.push(['stop', o?.remove]) });
  await runProjectVerify(db, { projectId: P.projectId, home: HOME, makeExec: stopOnly });
  assert(calls.some((c) => c[0] === 'stop' && c[1] === true), '真沙箱的形状：调的是 stop({remove:true})，不是一个不存在的 dispose');
  assert(calls.filter((c) => c[0] === 'stop').length >= 2, '跑之前先收一次旧的，跑完再收一次 —— 验收目录刚被 force 重新克隆过');
  // 只有 dispose 的（测试里的假执行器）也得照收，别把老测试打死
  const dispOnly = [];
  await runProjectVerify(db, { projectId: P.projectId, home: HOME,
    makeExec: async () => ({ execute: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }), dispose: async () => dispOnly.push(1) }) });
  assert(dispOnly.length >= 1, '只有 dispose 的假执行器仍然被收');
  // 两个都没有的也不能炸
  const r = await runProjectVerify(db, { projectId: P.projectId, home: HOME,
    makeExec: async () => ({ execute: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false }) }) });
  eq(r.ok, true, '既没 stop 也没 dispose：不收也不炸，结论照出');
}

section('11e. 上限可调；调成 1 就是回到串行');
{
  const mk = (t, f) => ({ title: t, goal: `g ${t}`, definition_of_done: `d ${t}`, depends_on: [], verify_command: `node --test tests/${f}.test.mjs` });
  const Q = createProject(db, { userId: owner.userId, source: SRC, home: HOME,
    spec: { title: '串行回退', brief: 'x', tasks: [mk('J', 'j'), mk('K', 'k')] } });
  const [j, k] = Q.taskIds;
  setMaxOpen(db, { projectId: Q.projectId, n: 1, userId: owner.userId });
  eq(maxOpenOf(db, Q.projectId), 1, '上限设成 1');
  const wsj = join(HOME, 'workspaces', j);
  writeFileSync(join(wsj, 'j.mjs'), 'x\n'); gitc(wsj, 'add', '.'); gitc(wsj, 'commit', '-q', '-m', 'J');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, j);
  raiseSignoffQuestion(db, { taskId: j, head: git(wsj, 'rev-parse', 'HEAD'), branch: `v0/${j}` });
  const r = await advanceProject(db, { projectId: Q.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'needs_signoff', 'J 在等人，但上限 1 → 不让路，行为与纯串行一字不差');
  eq(existsSync(join(HOME, 'workspaces', k)), false, 'K 没开工');
  throws(() => setMaxOpen(db, { projectId: Q.projectId, n: 0, userId: owner.userId }), /1 到 4/, '0 不合法');
  throws(() => setMaxOpen(db, { projectId: Q.projectId, n: 9, userId: owner.userId }), /1 到 4/, '9 超过上限');
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
