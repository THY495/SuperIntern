// 系统自己那几道关卡住时，不再静默、不再要人登上服务器手工处理。
//
// 跑：node tests/handback.test.mjs
//
// 要防的链条：T1 把 frontend/dist/ 提交进仓库 → T2 验收一跑 build 就改动已跟踪文件 → 判失败、30 分钟没人收到事项
// → 再跑"侥幸通过"（验收前就脏着）→ 留下的改动卡住合并，deliverTask 连拒、只进审计 → 退避表用完 `?? Infinity` 永不再试
// → 停等报警说不出原因，人把它判成"本来就该停" → 只能有人登上服务器 git checkout。
// 这里逐环断言每一处现在的样子。没有模型：节点执行用假模型，任务"完成 / 签收"由测试直接落库。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { isBuildOutput, discardChanges, writeDepExcludes, workspaceStatus } from '../src/core/workspace.mjs';
import { getParam } from '../src/core/params.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { createProject, advanceProject } from '../src/core/project.mjs';
import { signOff, raiseSignoffQuestion } from '../src/core/deliver.mjs';
import { HANDBACK_KEY } from '../src/core/handback.mjs';
import { startDaemon, RETRY_BACKOFF_MS } from '../src/core/daemon.mjs';
import { sweepLiveness, STALL_MARK } from '../src/core/liveness.mjs';
import { alwaysInScope } from '../src/agent/executor.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-handback-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitc = (cwd, ...a) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
/** 事项正文去掉路由统一追加的转交提示（看板的 webQText 同样剥掉它）。 */
const body = (t) => String(t).split('不该你答？')[0];
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${name}`, name, args }], usage: { inputTokens: 100, outputTokens: 10 } });

/** 一份真 git 工作区，已提交了 frontend/dist/index.html（上面链条里 T1 的样子）。 */
function makeWorkspace(name) {
  const ws = join(TMP, name);
  mkdirSync(join(ws, 'frontend', 'dist'), { recursive: true });
  writeFileSync(join(ws, 'README.md'), '# fixture\n');
  writeFileSync(join(ws, 'frontend', 'dist', 'index.html'), '<p>old build</p>\n');
  git(ws, 'init', '-q');
  gitc(ws, 'add', '-A'); gitc(ws, 'commit', '-q', '-m', 'init（含已提交的构建产物）');
  git(ws, 'checkout', '-q', '-b', 'v0/test');
  return ws;
}

/** 一个任务、一个节点、一条验收命令。 */
function taskFixture(verifyJs) {
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'报修单前端','running',?)`, taskId, owner.userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'g','只动 src/','d','[]',?,?)`, newId('c'), taskId, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写代码','s','a','pending','normal','standard',?)`, newId('n'), taskId, t);
  db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
          VALUES (?,?,'task.verify_command',?,'task','constitutional','user',?,?,?)`,
  newId('p'), taskId, JSON.stringify(['node', '-e', verifyJs]), owner.userId, t, t);
  return { db, owner, taskId };
}
const HANDOFF = { artifacts: [{ path: 'src/app.mjs', kind: 'source' }], interface_contract: 'x', acceptance_evidence: 'y' };
const runTask = (db, taskId, ws, name) => orchestrate(db, {
  taskId, workspace: ws, narrativeDir: join(TMP, `narr-${name}`),
  makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([
    call('write_file', { path: 'src/app.mjs', content: 'export const x = 1;\n' }), call('submit_handoff', HANDOFF)]) }),
  onEvent: () => {},
});

section('1. 工作区工具：构建产物的判断、撤掉没提交的改动、默认忽略 dist/');
{
  for (const p of ['dist/', 'frontend/dist/index.html', 'frontend/build/x.js', 'coverage/lcov.info', 'app/.next/cache', 'a/b.tsbuildinfo']) assert(isBuildOutput(p), `构建产物：${p}`);
  for (const p of ['src/app.mjs', 'README.md', 'distance.mjs', 'docs/distribution.md']) assert(!isBuildOutput(p), `不是构建产物：${p}`);
  const ws = makeWorkspace('ws-tools');
  writeFileSync(join(ws, 'README.md'), 'changed\n');
  writeFileSync(join(ws, 'notes.txt'), 'untracked\n');
  mkdirSync(join(ws, 'tmpdir')); writeFileSync(join(ws, 'tmpdir', 'a.txt'), 'x');
  const left = discardChanges(ws, workspaceStatus(ws).changed);
  eq(left.length, 0, '撤掉之后工作区干净（被跟踪的还原、未跟踪的文件与目录删掉）');
  eq(git(ws, 'show', 'HEAD:README.md'), '# fixture', '已提交的内容一个字没动');
  const ws2 = join(TMP, 'ws-excl'); mkdirSync(ws2); git(ws2, 'init', '-q'); gitc(ws2, 'commit', '-q', '--allow-empty', '-m', 'init');
  writeDepExcludes(ws2);
  mkdirSync(join(ws2, 'frontend', 'dist'), { recursive: true }); writeFileSync(join(ws2, 'frontend', 'dist', 'index.html'), 'x');
  eq(workspaceStatus(ws2).changed.length, 0, '新工作区里 build 出来的 frontend/dist/ 不算改动（默认忽略）→ 节点提交时不会被提交进仓库');
}

section('2. 验收重建了已提交的构建产物：不判失败、还原、照实记一行');
{
  const { db, taskId } = taskFixture('require("fs").writeFileSync("frontend/dist/index.html","<p>new build</p>")');
  const ws = makeWorkspace('ws-rebuilt');
  const r = await runTask(db, taskId, ws, 'rebuilt');
  eq(r.kind, 'complete', '构建产物被重建不算"改了工作区"（不判 verify_failed）→ 任务完成');
  eq((r.verification.rebuilt ?? []).join(','), 'frontend/dist/index.html', '记下被重建的构建产物');
  assert(/构建产物不该进仓库/.test(r.verification.tail), '输出尾部照实说了一句"构建产物不该进仓库"');
  eq(workspaceStatus(ws).changed.length, 0, '验收之后工作区干净 —— 合并与交付不会再被"未提交的改动"挡住');
  db.close();
}

section('3. 验收没过：当场挂一条事项；工作区照样还原（判定不再看运气）');
let F;
{
  F = taskFixture('require("fs").writeFileSync("README.md","hacked"); process.exit(2)');
  const ws = makeWorkspace('ws-fail');
  const r = await runTask(F.db, F.taskId, ws, 'fail');
  eq(r.kind, 'verify_failed', '验收 exit=2 → verify_failed');
  assert(!!r.questionId, '退出结果带着事项 id');
  const q = F.db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  eq(q?.status, 'open', '事项开着');
  eq(q?.decision_type, 'structural', '按结构矛盾路由（技术取舍的人 + 负责人）');
  assert(q.text.startsWith('【验收没过】') && /退出码：2/.test(q.text), '正文：标记 + 退出码');
  assert(!/node src\/cli\.mjs/.test(body(q.text)), '正文里没有命令行 —— 网页上的人照着做得了');
  eq(getParam(F.db, F.taskId, HANDBACK_KEY)?.questionId, r.questionId, '交回参数记着这条事项');
  eq(workspaceStatus(ws).changed.length, 0, '验收改动的 README.md 已撤掉 —— 下次验收的基准是干净的');
  eq(git(ws, 'show', 'HEAD:README.md'), '# fixture', '已提交的 README.md 没动');
  F.ws = ws; F.qid = r.questionId;
}

section('4. 答复这条事项 = 让 AI 带着失败输出接着修；写"中止"不代劳');
{
  const res = recordAnswer(F.db, { questionId: F.qid, body: '是测试写错了，别改业务代码', plaintextToken: F.owner.plaintext });
  eq(res.resolved, true, '答复了结事项');
  eq(res.hook?.handled, true, '交回钩子接住了');
  const m = F.db.one(`SELECT * FROM messages WHERE id=?`, res.hook.messageId);
  eq(m?.kind, 'correction', '生成一条修正（走重规划那条老路）');
  assert(m.body.startsWith('【验收没过】是测试写错了') && /系统附/.test(m.body) && /退出码：2/.test(m.body), '修正 = 人的原话 + 系统附的失败输出');
  eq(m.sender_id, F.owner.userId, '署名是答复的人');
  eq(getParam(F.db, F.taskId, HANDBACK_KEY), null, '交回参数清掉');
  assert(F.db.one(`SELECT 1 FROM audit_log WHERE action='message_received' AND target_id=? AND payload LIKE '%handback:verify_failed%'`, F.taskId), 'message_received 进审计 —— 守护进程认它是触发动作，会把任务拉起来');
  F.db.close();

  const G = taskFixture('process.exit(1)');
  const ws = makeWorkspace('ws-abort');
  const r = await runTask(G.db, G.taskId, ws, 'abort');
  const res2 = recordAnswer(G.db, { questionId: r.questionId, body: '中止吧', plaintextToken: G.owner.plaintext });
  eq(res2.hook?.abort, true, '答"中止" → 钩子只记下来');
  eq(G.db.one(`SELECT count(*) n FROM messages WHERE task_id=? AND kind<>'answer'`, G.taskId).n, 0, '不生成修正');
  eq(G.db.one(`SELECT status FROM tasks WHERE id=?`, G.taskId).status, 'running', '也不替人中止（不可逆的动作要人自己在任务页点）');
  G.db.close();
}

// ── 项目：合并卡住 ─────────────────────────────────────────────────────────
const SRC = join(TMP, 'src');
mkdirSync(SRC); git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'README.md'), '# demo\n'); gitc(SRC, 'add', '.'); gitc(SRC, 'commit', '-q', '-m', 'init');
const HOME = join(TMP, 'home');
const db = openDb(':memory:');
const owner = ensureOwner(db);
const spec = { title: '报修单', tasks: [
  { title: 'T1 应用', goal: 'g1', definition_of_done: 'd1', verify_command: 'node -e 0' },
  { title: 'T2 标红', goal: 'g2', definition_of_done: 'd2', verify_command: 'node -e 0' }] };
/** 建项目，T1 做完（提交一个产物 + 一份构建产物）并签收。 */
function doneAndSigned() {
  const P = createProject(db, { userId: owner.userId, spec, source: SRC, home: HOME });
  const [t1] = P.taskIds;
  const ws = join(HOME, 'workspaces', t1);
  mkdirSync(join(ws, 'frontend', 'dist'), { recursive: true });
  writeFileSync(join(ws, 'app.mjs'), 'export const x = 1;\n');
  writeFileSync(join(ws, 'frontend', 'dist', 'index.html'), 'old\n');
  gitc(ws, 'add', '-f', '.'); gitc(ws, 'commit', '-q', '-m', 'T1 产物（dist 被强行提交了）');
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, t1);
  audit(db, { actorKind: 'system', action: 'task_done', targetType: 'task', targetId: t1, payload: { head: git(ws, 'rev-parse', 'HEAD') } });
  signOff(db, { taskId: t1, accept: true, plaintextToken: owner.plaintext, userId: owner.userId });
  return { P, t1, ws };
}

section('5. 合并前工作区脏着：只剩构建产物 → 系统撤掉接着合');
{
  const { P, t1, ws } = doneAndSigned();
  writeFileSync(join(ws, 'frontend', 'dist', 'index.html'), 'rebuilt by verify\n');
  const r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'merged', '不再是 deliverTask 连拒；直接合并');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='workspace_build_output_discarded' AND target_id=? AND payload LIKE '%before_merge%'`, t1), '撤掉了什么进审计');
  eq(git(P.repo, 'show', `${P.branch}:frontend/dist/index.html`), 'old', '合进去的是签收过的那一版');
}

section('6. 合并前工作区有别的没提交的改动 → 一条【合并卡住】事项；答复交给 AI；同一提交不再重签');
{
  const { P, t1, ws } = doneAndSigned();
  writeFileSync(join(ws, 'NOTES.md'), '签收后有人留下的东西\n');
  let r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'dirty_workspace', '不猜、不合并，挂事项');
  const q = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  assert(q.text.startsWith('【合并卡住】') && q.text.includes('NOTES.md（新文件，从没提交过）'), '正文：标记 + 文件清单，每个标上是新文件还是改过（看不出来，人就不敢写"都不要"）');
  assert(!/node src\/cli\.mjs/.test(body(q.text)), '正文里没有命令行');
  r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'waiting:dirty_workspace', '事项开着时安静地等，不重挂');
  eq(db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND text LIKE '【合并卡住】%'`, t1).n, 1, '只有一条');
  const res = recordAnswer(db, { questionId: q.id, body: '都不要', plaintextToken: owner.plaintext });
  eq(res.hook?.kind, 'dirty_workspace', '交回钩子接住了');
  const m = db.one(`SELECT * FROM messages WHERE id=?`, res.hook.messageId);
  assert(m.body.startsWith('【合并卡住】都不要') && m.body.includes('NOTES.md'), '修正 = 人的原话 + 文件清单');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, t1).status, 'running', 'done + 已签收的任务放回 running，守护进程才会拉它');
  // AI 照做：只撤掉那个文件，提交没变 → 再次 done 时不该重新要签收
  rmSync(join(ws, 'NOTES.md'));
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, t1);
  const s = raiseSignoffQuestion(db, { taskId: t1, head: git(ws, 'rev-parse', 'HEAD'), dir: ws });
  eq(s.alreadySigned, true, '同一个提交已经签过收 → 不再弹签收（否则白添一条事项）');
  r = await advanceProject(db, { projectId: P.projectId, home: HOME, userId: owner.userId });
  eq(r.reason, 'merged', '然后照常合并');
}

section('7. 推进反复失败：退避表走完挂一条【合并出错】事项；答复后立刻再试；不再永远放弃');
{
  const { P, t1 } = doneAndSigned();
  // 让交付（push 到项目仓库）必然失败：项目仓库装一个拒收的钩子
  writeFileSync(join(P.repo, '.git', 'hooks', 'pre-receive'), '#!/bin/sh\necho "磁盘满了（测试）" >&2\nexit 1\n');
  try { execFileSync('chmod', ['+x', join(P.repo, '.git', 'hooks', 'pre-receive')]); } catch { /* Windows 上不需要 */ }
  let clock = now();
  const d = startDaemon(db, { home: HOME, launcher: { running: () => null, launch: () => ({ pid: 1 }) }, intervalMs: 3_600_000, runtime: null, clock: () => clock });
  const fails = () => db.all(`SELECT payload FROM audit_log WHERE action='project_advance_failed' AND target_id=?`, P.projectId).map((a) => JSON.parse(a.payload));
  const hb = () => db.one(`SELECT * FROM questions WHERE task_id=? AND text LIKE '【合并出错】%'`, t1);
  for (let i = 0; i < RETRY_BACKOFF_MS.length; i++) {
    await d.tick();
    clock += (RETRY_BACKOFF_MS[i] ?? 0) + 1000;
  }
  eq(fails().length, RETRY_BACKOFF_MS.length, `连失败 ${RETRY_BACKOFF_MS.length} 次`);
  eq(fails().at(-1).taskId, t1, '失败记着是哪个任务');
  const q = hb();
  assert(!!q, `第 ${RETRY_BACKOFF_MS.length} 次失败挂出事项，挂在卡住的任务上`);
  assert(q && /最近一次的错误：\S/.test(q.text), '正文带着错误原文');
  if (process.env.DEBUG) console.log(q?.text);
  await d.tick();
  eq(fails().length, RETRY_BACKOFF_MS.length + 1, '退避表用完之后按最长一档接着试（不是永远不再试）');
  eq(db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND text LIKE '【合并出错】%'`, t1).n, 1, '同一段连续失败里只挂一次');
  rmSync(join(P.repo, '.git', 'hooks', 'pre-receive'));
  recordAnswer(db, { questionId: q.id, body: '服务器清过了，再试', plaintextToken: owner.plaintext });
  await d.tick();   // 时钟没动：没有答复的话还在退避里
  d.stop();
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='project_task_merged' AND target_id=? AND payload LIKE ?`, P.projectId, `%${t1}%`), '答复之后这一拍立刻重试 → 合并成功');
}

section('8. 停等报警：带最近一次出错、没有命令行；回 B 之后同样的情况不再报，出错变了再报');
{
  const tId = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'卡住的任务','running',?)`, tId, owner.userId, now() - 3_600_000);
  audit(db, { actorKind: 'system', action: 'project_advance_failed', targetType: 'task', targetId: tId, payload: { error: '工作区有未提交的改动，请先处理后再交付' } });
  const assess = () => ({ due: false, reason: 'status:done' });
  const onlyMine = (r) => r.raised.filter((x) => x.taskId === tId);
  let r = sweepLiveness(db, { assess, graceMs: 0 });
  const raised = onlyMine(r);
  eq(raised.length, 1, '报了一条停等');
  const q = db.one(`SELECT text FROM questions WHERE id=?`, raised[0].questionId);
  assert(q.text.startsWith(STALL_MARK) && /最近一次出错.*合并 \/ 推进出错：工作区有未提交的改动/.test(q.text), '正文带着最近一次出错（人正是缺这一句才会误判）');
  assert(!/node src\/cli\.mjs/.test(body(q.text)), '正文里没有命令行');
  recordAnswer(db, { questionId: raised[0].questionId, body: '选B：已完成已签收，本来就该停', plaintextToken: owner.plaintext });
  r = sweepLiveness(db, { assess, graceMs: 0 });
  eq(onlyMine(r).length, 0, '回过 B、判断与出错都没变 → 不再报（正文说"下次不再报"，就真的不再报）');
  audit(db, { actorKind: 'system', action: 'task_verify_failed', targetType: 'task', targetId: tId, payload: { tail: '新的错' } });
  r = sweepLiveness(db, { assess, graceMs: 0 });
  eq(onlyMine(r).length, 1, '出错变了 → 照报');
}

section('8b. 改计划没成：挂事项；换个说法 = 原话作废换新的；"算了" = 原话作废、照原计划做');
{
  const { recordMessage } = await import('../src/core/inbox.mjs');
  const mkMsg = (tId, body) => recordMessage(db, { taskId: tId, body, kind: 'correction', plaintextToken: owner.plaintext }).messageId;
  const tId = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T2 标红','running',?)`, tId, owner.userId, now());
  const m1 = mkMsg(tId, '整行都标红');
  const { raiseReplanFailed } = await import('../src/core/handback.mjs');
  const q1 = raiseReplanFailed(db, { taskId: tId, messageId: m1, why: '新计划与契约规则"只在优先级文字上标红"冲突' });
  const t1 = db.one(`SELECT text FROM questions WHERE id=?`, q1.questionId).text;
  assert(t1.startsWith('【改计划没成】') && t1.includes('整行都标红') && t1.includes('冲突'), '正文：原话 + 没改成的原因');
  const res = recordAnswer(db, { questionId: q1.questionId, body: '只把优先级那一格标红，别的不动', plaintextToken: owner.plaintext });
  assert(!!db.one(`SELECT consumed_at FROM messages WHERE id=?`, m1).consumed_at, '原话作废（标消费，不删）');
  const nm = db.one(`SELECT body, kind FROM messages WHERE id=?`, res.hook.messageId);
  assert(nm.kind === 'correction' && nm.body.startsWith('【改计划没成】只把优先级那一格标红') && nm.body.includes('整行都标红'), '新修正 = 这次的说法 + 附原话');
  const m2 = mkMsg(tId, '再加一个导出按钮');
  const q2 = raiseReplanFailed(db, { taskId: tId, messageId: m2, why: 'x' });
  const res2 = recordAnswer(db, { questionId: q2.questionId, body: '算了', plaintextToken: owner.plaintext });
  eq(res2.hook?.dropped, true, '"算了" → 撤回');
  assert(!!db.one(`SELECT consumed_at FROM messages WHERE id=?`, m2).consumed_at, '原话作废');
  eq(db.one(`SELECT count(*) n FROM messages WHERE task_id=? AND kind='correction' AND consumed_at IS NULL`, tId).n, 1, '没有新修正（只剩上一轮换说法的那条）');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='task_resumed' AND target_id=? AND payload LIKE '%replan_failed%'`, tId), '记一条 task_resumed —— 守护进程据此把任务拉起来照原计划做');
}

section('9. 依赖清单、.gitignore、构建产物不受任务范围限制');
{
  for (const p of ['backend/requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'frontend/package.json', 'frontend/package-lock.json', '.gitignore', 'frontend/.gitignore', 'frontend/dist/index.html', 'si-preview.json']) assert(alwaysInScope(p), `放行：${p}`);
  for (const p of ['backend/main.py', 'frontend/src/App.jsx', 'package.json.bak', 'docs/requirements.md']) assert(!alwaysInScope(p), `照旧受范围限制：${p}`);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
