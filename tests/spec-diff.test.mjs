// 新旧版机械比对 + 这一轮的全部来回
//
// 跑：node tests/spec-diff.test.mjs
//
// 起因：追加 / 复盘规划器每出一版若手里只有上一版和最新一条反馈，就可能退回成"已达成"、把某个任务丢了，
// 或把更早一版写死的约束丢了（上一版契约原文不在手头，只能重建）。人每一版都得从头读全文才发现少了东西。
// 断言：① 比对函数本身；② 规划器拿到的是人看到的上一版原文 + 这一轮每一条反馈；③ 批准事项开头写着和上一版比少了什么。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { diffSpecs, renderSpecDiff } from '../src/agent/spec-diff.mjs';
import { planProject, startProjectFromBrief } from '../src/agent/project-planner.mjs';
import { requestAppend } from '../src/agent/project-append.mjs';
import { startProject } from '../src/agent/project-start.mjs';
import { advanceProject } from '../src/core/project.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-specdiff-'));
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
const client = (script) => {
  const real = new LlmClient({ mode: 'fake', fake: makeFake(script) });
  const seen = [];
  return { seen, complete: async (req) => { seen.push(req.messages.map((m) => (m.content ?? []).map((c) => c.text ?? '').join('')).join('\n')); return real.complete(req); } };
};
const answer = (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: owner.plaintext });
const T = (title, { constraints = [], rules = null } = {}) => ({ title, goal: `g ${title}`, scope: 's', scope_paths: [`src/${title.replace(/\s/g, '')}/`], definition_of_done: `d ${title}`,
  rules: rules ?? [{ rule: `r ${title}`, assumption: '规格没写' }], constraints, verify_command: 'node --test tests/x.test.mjs' });
const qtext = (id) => db.one(`SELECT text FROM questions WHERE id=?`, id).text;

section('1. 比对函数：少了的任务、找不到原文的约束 / 规则、改判为已达成');
{
  const v1 = { tasks: [T('T1 后端列表', { constraints: ['不动 backend/app.py 以外的文件'] }), T('T2 前端列表', { constraints: ['high 标红只落在优先级文字上'] })] };
  let d = diffSpecs(v1, { tasks: [T('T1 后端列表', { constraints: ['不动 backend/app.py 以外的文件'] })] });
  eq(d.droppedTasks.join(','), 'T2 前端列表', '少了 T2 → 点名');
  d = diffSpecs(v1, { tasks: [T('T1 后端列表'), T('T2 前端列表', { constraints: ['high 标红只落在优先级文字上'] })] });
  eq(d.droppedItems.map((x) => x.text).join(','), '不动 backend/app.py 以外的文件', 'T1 的约束找不到原文 → 点名');
  d = diffSpecs(v1, { tasks: [T('3. 后端列表', { constraints: ['不动 backend/app.py 以外的文件'] }), T('T4 前端列表页', { constraints: ['high 标红只落在优先级文字上'] })] });
  eq([d.droppedTasks.length, d.addedTasks.length, d.droppedItems.filter((x) => x.kind === '约束').length].join('|'), '0|0|0', '编号变了、标题多一个字：认作同一个任务，约束原文都在，不误报');
  d = diffSpecs(v1, { tasks: [T('T1 后端列表'), T('T2 前端列表')], });
  eq(d.droppedItems.length, 2, '约束换了位置也算在（查全版）；两条都没了才报');
  d = diffSpecs(v1, { reached: { reason: '都做完了' } });
  assert(d.toReached && d.droppedTasks.length === 2, '上一版给任务、这一版改判已达成 → toReached，点名丢掉的任务');
  assert(/AI 这一版改判为"已经达成"/.test(renderSpecDiff(d, { prevVersion: 3 })) && /别确认达成/.test(renderSpecDiff(d, { prevVersion: 3 })), '渲染：提醒别确认达成');
  assert(/任务都在，上一版的约束与规则原文都还在/.test(renderSpecDiff(diffSpecs(v1, v1), { prevVersion: 1 })), '没少东西也明说（不是省略）');
  assert(/系统逐字比对，不经 AI/.test(renderSpecDiff(diffSpecs(v1, { tasks: [] }), { prevVersion: 1 })), '说明比对不经 AI');
}

section('2. 追加：规划器拿到人看到的上一版原文 + 这一轮每一条反馈；新版开头写和上一版比少了什么');
{
  const S = startProject(db, { userId: owner.userId, goal: '工单系统', doneDefinition: 'd', plan: '# 规划\n先做库 get 与 set，再做命令行 kv get 与 kv set', source: SRC, home: HOME });
  const Q = '先做库 get 与 set，再做命令行 kv get 与 kv set';
  const q0 = { rules: [{ rule: Q, quote: Q }] };
  { const r = await planProject(db, { client: client([call('propose_project', { title: 'x', tasks: [T('T1 库', q0), T('T2 CLI', q0)], notes: '' })]), projectId: S.projectId });
    answer(r.questionId, 'A'); await planProject(db, { client: client([]), projectId: S.projectId }); }
  requestAppend(db, { projectId: S.projectId, userId: owner.userId, brief: '加前端工单列表' });
  let r = await planProject(db, { client: client([call('propose_project', { title: 'x', tasks: [T('T3 列表页', { constraints: ['high 标红只落在优先级文字上'] }), T('T4 详情页')], notes: '' })]), projectId: S.projectId });
  const v1q = r.questionId;
  assert(!/和上一版/.test(qtext(v1q)), '第一版没有"和上一版比"');
  answer(v1q, '列表页要能按优先级排序');
  const c2 = client([call('propose_project', { title: 'x', tasks: [T('T3 列表页', { constraints: ['按优先级排序'] })], notes: '' })]);
  r = await planProject(db, { client: c2, projectId: S.projectId });
  assert(/上一版追加草案（v1，人看到的原文）/.test(c2.seen[0]) && /high 标红只落在优先级文字上/.test(c2.seen[0]), '规划器拿到的上一版是人看到的原文（带着 v1 的约束）');
  assert(/这一轮到目前为止人的全部反馈/.test(c2.seen[0]) && /对 v1：列表页要能按优先级排序/.test(c2.seen[0]) && /原文保留/.test(c2.seen[0]), '以及这一轮的反馈清单 + "没要求去掉的原文保留"');
  const t2 = qtext(r.questionId);
  assert(/^【项目契约草案 · 追加 v2】\n【和上一版（v1）比】/.test(t2), '和上一版比的那段紧跟在标题行后面（标题仍在第一行，收件箱摘要照旧）');
  assert(/⚠ 上一版有、这一版没有的任务：「T4 详情页」/.test(t2), 'v2 丢了 T4 → 标出来');
  assert(/「T3 列表页」的约束：high 标红只落在优先级文字上/.test(t2), 'v2 丢了 v1 的约束 → 标出来');
  answer(r.questionId, '详情页也要');
  const c3 = client([call('propose_project', { title: 'x', tasks: [T('T3 列表页', { constraints: ['按优先级排序', 'high 标红只落在优先级文字上'] }), T('T4 详情页')], notes: '' })]);
  r = await planProject(db, { client: c3, projectId: S.projectId });
  assert(/对 v1：列表页要能按优先级排序/.test(c3.seen[0]) && /对 v2：详情页也要/.test(c3.seen[0]), 'v3 的规划器看得到 v1、v2 两条反馈（不只是最新一条）');
  if (process.env.DEBUG_DIFF) console.log(qtext(r.questionId).split('\n').slice(0, 8).join('\n'));
  assert(/新增的任务：「T4 详情页」/.test(qtext(r.questionId)) && !/⚠ 上一版/.test(qtext(r.questionId)), 'v3 比 v2：只多不少，没有"上一版有、这一版没有"的 ⚠');
}

section('3. 复盘：上一版给了任务、这一版改判"已达成" → 事项开头提醒别确认达成');
{
  const S = startProject(db, { userId: owner.userId, goal: 'kv', doneDefinition: 'get/set', plan: '# 规划\n先做库 get 与 set，再做命令行 kv get 与 kv set', source: SRC, home: join(HOME, 'b') });
  const Q = '先做库 get 与 set，再做命令行 kv get 与 kv set';
  { const r = await planProject(db, { client: client([call('propose_project', { title: 'x', tasks: [T('T1 库', { rules: [{ rule: Q, quote: Q }] }), T('T2 CLI', { rules: [{ rule: Q, quote: Q }] })], notes: '' })]), projectId: S.projectId });
    answer(r.questionId, 'A'); await planProject(db, { client: client([]), projectId: S.projectId }); }
  db.run(`UPDATE tasks SET merged_at=? WHERE project_id=? AND project_order>0`, now(), S.projectId);
  await advanceProject(db, { projectId: S.projectId, home: HOME });
  let r = await planProject(db, { client: client([call('propose_project', { title: 'x', tasks: [T('T3 删除', { rules: [{ rule: Q, quote: Q }] })], notes: '' })]), projectId: S.projectId });
  answer(r.questionId, '删除先不急，把 T3 的说明写清楚');
  const c = client([call('project_goal_reached', { reason: '都有了', unverified: [] })]);
  r = await planProject(db, { client: c, projectId: S.projectId });
  eq(r.reached, true, '这一版改判已达成');
  assert(/上一版复盘结论（v1，人看到的原文）/.test(c.seen[0]), '复盘规划器拿到上一版原文（不论上一版是达成还是任务，都不靠重建）');
  const t = qtext(r.questionId);
  assert(/^【项目达成确认 v2】\n【和上一版（v1）比】/.test(t) && /给出的任务这一版都没有了：「T3 删除」/.test(t) && /别确认达成/.test(t), '达成确认的开头：上一版的 T3 没了，没同意去掉就别确认达成');
}

section('4. 首次规划改版：同样比对（上一版的整份方案存在载体任务上）');
{
  const P = startProjectFromBrief(db, { userId: owner.userId, brief: '做一个 KV 存储\n先库后 CLI', source: SRC, home: join(HOME, 'c') });
  let r = await planProject(db, { client: client([call('propose_project', { title: 'KV', tasks: [T('T1 库', { constraints: ['零依赖'] }), T('T2 CLI')], notes: '' })]), projectId: P.projectId });
  answer(r.questionId, 'CLI 换个名字');
  const c = client([call('propose_project', { title: 'KV', tasks: [T('T1 库'), T('T2 kvctl')], notes: '' })]);
  r = await planProject(db, { client: c, projectId: P.projectId });
  assert(/上一版草案（v1，人看到的原文）/.test(c.seen[0]) && /对 v1：CLI 换个名字/.test(c.seen[0]), '规划器拿到上一版原文 + 反馈清单');
  const t = qtext(r.questionId);
  assert(/「T1 库」的约束：零依赖/.test(t), 'v2 丢了"零依赖" → 标出来');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 100);
