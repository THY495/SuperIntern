// 项目验收与几处零碎行为
//
// 跑：node tests/project-verify.test.mjs
//
// ① 项目验收没过：出路从命令行改成页面路径；回「再跑一次」→ 项目放回 active，下一拍按当前验收命令重新验收（清空了就直接宣布）。
//    原来改完验收命令之后，页面上没有路重新确认达成。
// ② 停滞的项目里批准了新任务 → 项目放回 active（原来停在 stalled，advanceProject 不看它，新任务永远不开工）。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { planProject } from '../src/agent/project-planner.mjs';
import { requestAppend, appendStateOf } from '../src/agent/project-append.mjs';
import { startProject } from '../src/agent/project-start.mjs';
import { advanceProject, raiseProjectVerifyFailed } from '../src/core/project.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import { stripTransferHint } from '../src/core/routing.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-pverify-'));
const HOME = join(TMP, 'home');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitc = (cwd, ...a) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
const SRC = join(TMP, 'src');
mkdirSync(SRC); git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'README.md'), '# demo\n'); gitc(SRC, 'add', '.'); gitc(SRC, 'commit', '-q', '-m', 'init');

const db = openDb(':memory:');
const owner = ensureOwner(db);
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'c1', name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
const client = (script) => new LlmClient({ mode: 'fake', fake: makeFake(script) });
const answer = (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: owner.plaintext });
const Q = '先做库 get 与 set，再做命令行 kv get 与 kv set';
const T = (t) => ({ title: t, goal: `g ${t}`, scope: 's', scope_paths: [`src/${t.replace(/\s/g, '')}/`], definition_of_done: `d ${t}`, rules: [{ rule: Q, quote: Q }], constraints: [], verify_command: 'node --test tests/x.test.mjs' });
const project = (id) => db.one(`SELECT * FROM projects WHERE id=?`, id);

/** 一个走到"负责人确认达成"的项目（全部合并、复盘判达成、人点头） */
async function reachedProject(home) {
  const S = startProject(db, { userId: owner.userId, goal: 'kv', doneDefinition: 'get/set', plan: `# 规划\n${Q}`, source: SRC, home: join(HOME, home) });
  let r = await planProject(db, { client: client([call('propose_project', { title: 'x', tasks: [T('T1 库'), T('T2 CLI')], notes: '' })]), projectId: S.projectId });
  answer(r.questionId, 'A'); await planProject(db, { client: client([]), projectId: S.projectId });
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  r = await planProject(db, { client: client([call('project_goal_reached', { reason: '都有了', unverified: [] })]), projectId: S.projectId });
  answer(r.questionId, '确认达成');
  await planProject(db, { client: client([]), projectId: S.projectId });
  return S;
}

section('① 项目验收没过：出路是页面路径；回「再跑一次」→ 项目放回 active，下一拍重新验收');
{
  const S = await reachedProject('a');
  const st = appendStateOf(db, S.projectId);
  // 模拟：验收命令跑挂了（真跑要起容器，这里直接挂事项、置停滞 —— 与 advanceProject 失败分支同一形状）
  const q = raiseProjectVerifyFailed(db, { projectId: S.projectId, carrierId: st.carrierId, result: { argv: ['npm', 'test'], code: 1, tail: '1 failing', timedOut: false } });
  db.run(`UPDATE projects SET status='stalled' WHERE id=?`, S.projectId);
  const text = stripTransferHint(db.one(`SELECT text FROM questions WHERE id=?`, q.questionId).text);   // 末尾的转交提示页面上会剥掉
  assert(!/node src\/cli\.mjs/.test(text) && /项目设置 → 自动化/.test(text) && /「再跑一次」/.test(text), '事项正文不再有命令行；指向项目设置，并说回「再跑一次」');
  let r = answer(q.questionId, '先加个任务吧');
  eq([r.hook?.handled, project(S.projectId).status].join('|'), 'false|stalled', '答的不是"再跑一次"：只记下，项目照旧停着');
  const q2 = raiseProjectVerifyFailed(db, { projectId: S.projectId, carrierId: st.carrierId, result: { argv: ['npm', 'test'], code: 1, tail: '1 failing', timedOut: false } });
  r = answer(q2.questionId, '再跑一次');
  eq([r.hook?.retry, project(S.projectId).status].join('|'), 'true|active', '回「再跑一次」→ 项目放回 active');
  const adv = await advanceProject(db, { projectId: S.projectId, home: HOME });
  eq([adv.reason, project(S.projectId).status].join('|'), 'goal_reached|done', '下一拍按当前的验收命令重新验收（这里没有命令 → 直接宣布完成）');
}

section('② 停滞的项目里批准了新任务 → 项目放回 active，新任务能开工');
{
  const S = await reachedProject('b');
  db.run(`UPDATE projects SET status='stalled' WHERE id=?`, S.projectId);
  requestAppend(db, { projectId: S.projectId, userId: owner.userId, brief: '加一个 kv del' });
  const r = await planProject(db, { client: client([call('propose_project', { title: 'x', tasks: [{ ...T('T3 删除'), rules: [{ rule: 'r', assumption: '没写' }] }], notes: '' })]), projectId: S.projectId });
  answer(r.questionId, 'A');
  await planProject(db, { client: client([]), projectId: S.projectId });
  eq(project(S.projectId).status, 'active', '批准后项目回到 active（原来停在 stalled）');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 100);
