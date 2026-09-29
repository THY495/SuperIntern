// 上限事项、空转报警、过目归并、决定比对、汇报状态这几处行为的回归
//
// 跑：node tests/limits-review.test.mjs
//
// ① 测试工具的输出目录（test-results/ 等）默认忽略，不算改动、不会被判越界
// ② 上限事项：只收"调高并保存之后的 A"（B / C / 没调高的 A 当场拒收）；同一上限已有开着的事项时不重复挂；
//    空转报警：上一条之后没有新的失败就不再挂，任务停在开着的上限事项上时也不挂
// ③ 过目事项几个人一起答：「A」与「A + 说明」按方向归并，不判不一致
// ④ 决定比对：方案批准的纯裁决（只回「A」）不拿去比
// ⑥ 汇报：做没做完只以任务状态为准（汇报可能把"约定已登记"说成"T2、T3 已完成"），摘要说错了当场更正

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit, insertEdge } from '../src/db/db.mjs';
import { isBuildOutput, writeDepExcludes, workspaceStatus } from '../src/core/workspace.mjs';
import { raiseLimitQuestion, setLimit } from '../src/core/limits.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import { sweepLiveness } from '../src/core/liveness.mjs';
import { choicesSide } from '../src/core/choices.mjs';
import { afterInput } from '../src/core/decision-check.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-limits-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

section('① 测试工具的输出目录默认忽略');
{
  const ws = join(TMP, 'ws'); mkdirSync(join(ws, 'frontend', 'test-results'), { recursive: true });
  writeFileSync(join(ws, 'a.txt'), 'a\n'); git(ws, 'init', '-q'); git(ws, 'add', '.'); git(ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'i');
  writeDepExcludes(ws);
  writeFileSync(join(ws, 'frontend', 'test-results', '.last-run.json'), '{}');
  mkdirSync(join(ws, 'frontend', 'playwright-report'), { recursive: true }); writeFileSync(join(ws, 'frontend', 'playwright-report', 'index.html'), 'x');
  eq(workspaceStatus(ws).changed.length, 0, 'Playwright 写出的 test-results/、playwright-report/ 不算改动（否则次次被判越界）');
  assert(isBuildOutput('frontend/test-results/x/error-context.md'), '也算构建产物（撤得掉）');
}

const db = openDb(':memory:');
const owner = ensureOwner(db);
const answer = (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: owner.plaintext });
const task = () => {
  const id = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, id, owner.userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), id, t, t);
  return id;
};
/** 模拟编排器撞顶：挂事项 + 记 limit_breached（与 orchestrator 同一个形状） */
const breach = (taskId) => {
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,retry_count,created_at) VALUES (?,?,'n','s','a','pending',3,?)`, newId('n'), taskId, now());
  const b = { key: 'limit.node_retries', label: '单步骤重试次数', limit: 3, actual: 3, human: '单步骤重试次数已达上限：当前 3，上限 3' };
  const q = raiseLimitQuestion(db, { taskId, breach: b });
  audit(db, { actorKind: 'system', action: 'limit_breached', targetType: 'task', targetId: taskId, payload: { questionId: q.questionId, key: b.key } });
  return q;
};

section('② 上限事项：只收调高并保存之后的 A；不重复挂');
{
  const t = task();
  const q = breach(t);
  const err = (body) => { try { answer(q.questionId, body); return null; } catch (e) { return e.message; } };
  assert(/还没调高/.test(err('A：已经调到 10 了') ?? ''), '没保存就回 A → 拒收（说"还没调高"）');
  assert(/步骤重试/.test(err('A') ?? ''), '拒收时用页面上那一行的叫法（「步骤重试」）');
  assert(/中止不能靠答复/.test(err('B') ?? ''), '回 B → 拒收：中止要到任务页点');
  assert(/不是结论/.test(err('C') ?? ''), '回 C → 拒收：先看看经过不是结论');
  assert(/只收「A」/.test(err('我觉得可以继续') ?? ''), '别的话 → 拒收');
  const again = breach(t);
  eq(again.questionId, q.questionId, '同一上限再撞一次：沿用那条开着的事项，不再挂第二条');
  eq(db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND decision_type='budget'`, t).n, 1, '只有一条');
  setLimit(db, { taskId: t, key: 'limit.node_retries', value: 10, userId: owner.userId });
  const r = answer(q.questionId, 'A');
  eq(r.resolved, true, '调高并保存之后回 A → 收下');
}

section('② 空转报警：没有新证据不再挂；停在开着的上限事项上不挂');
{
  const t = task();
  const nid = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,retry_count,created_at) VALUES (?,?,'写测试','s','a','pending',3,?)`, nid, t, now());
  for (let i = 0; i < 3; i++) audit(db, { actorKind: 'system', action: 'node_stalled', targetType: 'node', targetId: nid, payload: { stopped: 'max_iterations' } });
  const sweep = () => sweepLiveness(db, { assess: () => ({ kind: 'self', why: 'x' }), graceMs: 0 });
  const r1 = sweep();
  eq(r1.raised.filter((x) => x.kind === 'livelock').length, 1, '三次同因失败 → 挂一条空转');
  const loopQ = r1.raised.find((x) => x.kind === 'livelock').questionId;
  db.run(`UPDATE questions SET status='answered' WHERE id=?`, loopQ);
  eq(sweep().raised.filter((x) => x.kind === 'livelock').length, 0, '答掉之后没有新的失败 → 不再挂（否则答一条冒一条）');
  breach(t);
  await new Promise((ok2) => setTimeout(ok2, 5));
  audit(db, { actorKind: 'system', action: 'node_stalled', targetType: 'node', targetId: nid, payload: { stopped: 'max_iterations' } });
  eq(sweep().raised.filter((x) => x.kind === 'livelock').length, 0, '有新的失败，但任务停在开着的上限事项上 → 那条就是出口，不叠空转');
}

section('③ 过目事项按方向归并');
{
  eq(choicesSide('A'), 'keep', '「A」= 同意');
  eq(choicesSide('A\n说明：?status= 拼错最好报错'), 'keep', '「A + 说明」= 同意');
  eq(choicesSide('说明：这条摘的是旧说法'), 'keep', '只是说明 = 不要求改');
  assert(choicesSide('2 改成：高中低倒过来').startsWith('change:'), '写要改什么 = 要改');
}

section('④ 决定比对：方案批准的纯裁决不拿去比');
{
  const t = task();
  const qid = newId('q'), mid = newId('m');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status,decision_type) VALUES (?,?,NULL,3,'hard_rule','【宪法块草案 v1】…',NULL,?,NULL,'answered','contract_approval')`, qid, t, now());
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at) VALUES (?,?,?,'A','answer','explicit','normal','explicit','user-authenticated',?,?)`,
    mid, t, owner.userId, db.one(`SELECT id FROM tokens LIMIT 1`).id, now());
  insertEdge(db, mid, qid, 'answers', now());
  const r = await afterInput(db, { taskId: t, text: 'A', entry: 'answer', by: owner.userId, sourceId: mid, makeClient: () => { throw new Error('不该调模型'); } });
  eq(r.skipped, 'verdict_only', '只回「A」→ 不比（否则会被读成推翻另一道题的 B，挂出假冲突）');
}

section('⑥ 汇报：做没做完只以任务状态为准，摘要说错了当场更正');
{
  const pj = newId('pj'), t0 = now();
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,goal,done_definition,created_at)
          VALUES (?,?,'团队待办','',?,?,'base','src','active','g','d',?)`, pj, owner.userId, `/r/${pj}`, `superintern/${pj}`, t0);
  const mk = (order, title, status, merged) => {
    const id = task();
    db.run(`UPDATE tasks SET title=?, status=?, project_id=?, project_order=?, merged_at=? WHERE id=?`, title, status, pj, order, merged ? t0 : null, id);
    return id;
  };
  mk(1, '团队待办应用：FastAPI+SQLite 后端与 Vite+React 前端', 'done', true);
  const t2 = mk(2, 'T2 待办清单列表标签显示与按优先级排序', 'waiting', false);
  mk(3, 'T3 复盘回归：把优先级标签与排序纳入一键验收', 'planning', false);

  const { renderFacts, gatherSince, makeReport, falseDoneClaims } = await import('../src/agent/reporter.mjs');
  const facts = renderFacts(gatherSince(db, t2, 0));
  assert(/任务状态（做没做完只以这一行为准）：#1「[^」]+」已合并；#2「T2[^」]*」（本任务）等人处理；#3「T3[^」]*」未开工/.test(facts),
    '现状第一行写明各任务状态：#1 已合并、#2（本任务）等人处理、#3 未开工');

  // 一句典型的说错了的摘要
  const said = '团队待办项目已完成 T2（优先级标签与按优先级排序）与 T3（把优先级/排序冒烟并入 node verify.mjs 一键验收）两块工作并沉淀为现行约定；但本窗口因某单步重试次数触顶触发硬上限，任务已暂停。';
  const standing = gatherSince(db, t2, 0).standing;
  eq(falseDoneClaims(said, standing).map((t) => t.project_order).join(','), '2,3', '上面那句 → 认出 T2、T3 都被说成了完成');
  eq(falseDoneClaims('#1 已完成，T2 进行中，T3 还没开工', standing).length, 0, '「#1 已完成，T2 进行中」不误报（完成的是 #1）');
  eq(falseDoneClaims('T2 尚未完成，卡在重试上限', standing).length, 0, '「尚未完成」不算说完成');

  const { LlmClient } = await import('../src/llm/client.mjs');
  const { makeFake } = await import('../src/llm/providers.mjs');
  const client = new LlmClient({ mode: 'fake', fake: makeFake([{ stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 },
    content: [{ type: 'tool_call', id: 'r', name: 'submit_report', args: { summary: said, current_state: 'x', next_steps: 'y', uncertainties: 'z' } }] }]) });
  const r = await makeReport(db, { taskId: t2, trigger: 'limit_breached', client });
  assert(r.summary.startsWith('〔此刻：T2等人处理、T3未开工 / 规划中〕'), '摘要前补上此刻的状态（只陈述、不判"说错了"；模型原话保留）');
  assert(r.gaps.some((g) => g.includes('T2、T3 旁边提到')), 'gaps 记下这次补充');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
