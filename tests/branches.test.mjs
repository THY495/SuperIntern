// 分支级挂起（非阻塞提问）
//
// 跑：node tests/branches.test.mjs
//
// 断言的是编排器的一条规则：一个分支等人（节点 blocked、问题 open）时，不依赖它的就绪节点接着跑；
// 一个就绪节点都没有了才 suspended 退出。依赖被挡节点的分支不会被跑到（依赖未 done 就不就绪）。

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, insertEdge } from '../src/db/db.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-branches-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const makeWorkspace = (name) => {
  const ws = join(TMP, name); mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'README.md'), '# fixture\n');
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@t'); git(ws, 'config', 'user.name', 't'); git(ws, 'add', '.'); git(ws, 'commit', '-q', '-m', 'init');
  return ws;
};
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${Math.random().toString(16).slice(2, 8)}`, name, args }], usage: { inputTokens: 100, outputTokens: 20 } });
const QUESTION = { level: 2, text: '解码器放哪一层？', blocked_by: '规格与验收矛盾', default_action: '独立模块', work_done: '读了源码', plan_after: '按答复落位' };
const HANDOFF = (path) => ({ artifacts: [{ path, kind: 'source' }], interface_contract: 'x', acceptance_evidence: `node -e 0 → exit 0，${path} 已写` });

/** 三个节点：A（会提问）、B（独立）、C（依赖 A）。 */
function fixture() {
  const db = openDb(':memory:');
  const { userId, plaintext } = ensureOwner(db);
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'分支测试','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), taskId, t, t);
  const mk = (title, priority) => { const id = newId('n'); db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,risk_tier,model_tier,created_at) VALUES (?,?,?,'写文件','文件存在','pending',?,'normal','standard',?)`, id, taskId, title, priority, t); return id; };
  const A = mk('A 会提问', 1), B = mk('B 独立', 5), C = mk('C 依赖 A', 9);
  insertEdge(db, C, A, 'depends_on', t);
  return { db, taskId, A, B, C, plaintext };
}

section('1. A 提问被挡 → B 照跑 → C 不跑（依赖 A）→ 最后 suspended');
{
  const { db, taskId, A, B, C } = fixture();
  const ws = makeWorkspace('ws1');
  const events = [];
  // 一份脚本跨节点顺序消费：makeClient 每个节点都会被调一次，所以共享同一个假客户端
  const client = new LlmClient({ mode: 'fake', fake: makeFake([
    call('raise_question', QUESTION),                                                   // A
    call('write_file', { path: 'b.txt', content: 'b\n' }), call('submit_handoff', HANDOFF('b.txt')),   // B
  ]) });
  const r = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'narr1'), verify: false,
    makeClient: () => client,
    onEvent: (e) => events.push(e),
  });
  eq(r.kind, 'suspended', '最后还是 suspended（A 的问题没人答）');
  eq(r.completed.map((c) => c.nodeId).join(','), B, 'B 在 A 被挡之后跑完了');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, A).status, 'blocked', 'A blocked');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, B).status, 'done', 'B done');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, C).status, 'pending', 'C 没动（依赖 A）');
  const bw = events.find((e) => e.type === 'branch_waiting');
  assert(bw && bw.questions.length === 1 && bw.ready.includes(B) && !bw.ready.includes(C), 'branch_waiting 事件：一个问题开着，就绪的只有 B');
  const order = events.filter((e) => e.type === 'node_start').map((e) => e.node.id);
  eq(order.join(','), `${A},${B}`, '执行顺序 A → B');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务状态 waiting（问题开着）');
  db.close();
}

section('2. 答复到达后重跑：A 复工、C 跟上 → 完成');
{
  const { db, taskId, A, B, C, plaintext } = fixture();
  const ws = makeWorkspace('ws2');
  const c1 = new LlmClient({ mode: 'fake', fake: makeFake([
    call('raise_question', QUESTION),
    call('write_file', { path: 'b.txt', content: 'b\n' }), call('submit_handoff', HANDOFF('b.txt')),
  ]) });
  await orchestrate(db, { taskId, workspace: ws, narrativeDir: join(TMP, 'narr2'), verify: false, makeClient: () => c1, onEvent: () => {} });
  const q = db.one(`SELECT id FROM questions WHERE task_id=? AND status='open'`, taskId);
  recordAnswer(db, { questionId: q.id, body: '独立模块', plaintextToken: plaintext });
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'running', '答完翻回 running');
  const c2 = new LlmClient({ mode: 'fake', fake: makeFake([
    call('write_file', { path: 'a.txt', content: 'a\n' }), call('submit_handoff', HANDOFF('a.txt')),   // A 复工
    call('write_file', { path: 'c.txt', content: 'c\n' }), call('submit_handoff', HANDOFF('c.txt')),   // C
  ]) });
  const r = await orchestrate(db, { taskId, workspace: ws, narrativeDir: join(TMP, 'narr2'), verify: false, makeClient: () => c2, onEvent: () => {} });
  eq(r.kind, 'complete', '第二次跑完');
  eq(['A', 'B', 'C'].map((k) => db.one(`SELECT status FROM nodes WHERE id=?`, { A, B, C }[k]).status).join(','), 'done,done,done', '三个都 done');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'done', '任务 done');
  db.close();
}

section('3. 只有一个分支且它被挡：行为与从前一样，立刻 suspended、不调模型');
{
  const { db, taskId, A, B, C } = fixture();
  db.run(`UPDATE nodes SET status='void' WHERE id IN (?,?)`, B, C);
  const ws = makeWorkspace('ws3');
  const r = await orchestrate(db, { taskId, workspace: ws, narrativeDir: join(TMP, 'narr3'), verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([call('raise_question', QUESTION)]) }), onEvent: () => {} });
  eq(r.kind, 'suspended', 'suspended');
  eq(r.completed.length, 0, '没别的可跑');
  let made = 0;
  const r2 = await orchestrate(db, { taskId, workspace: ws, narrativeDir: join(TMP, 'narr3'), verify: false,
    makeClient: () => { made++; throw new Error('不该造 client'); }, onEvent: () => {} });
  eq(r2.kind, 'suspended', '再跑一次仍 suspended'); eq(made, 0, '一次模型都不调'); eq(r2.cycles, 0, '第 0 轮就停');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('结构矛盾事项的系统附注：答复改不了契约，要改走计划变更');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 例：执行器给的选项之一是"授权我改 shared/"，负责人答"走 1"，执行器照做、验收全过，
  // 交接被机械越界校验驳回（答复不是契约），撤销后**又问同一个问题** —— 一个会无限循环的卡死。
  const { db, taskId, A } = fixture();
  const ws = makeWorkspace('ws-d11');
  await orchestrate(db, { taskId, workspace: ws, narrativeDir: join(TMP, 'narr-d11'), verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([
      call('raise_question', { ...QUESTION, kind: 'structural', text: '契约要求缺省值都从 contract 引用，但本节点不许动 shared/。要么授权我改 shared/，要么允许硬编码。' })]) }),
    onEvent: () => {} });
  const q = db.one(`SELECT text, decision_type FROM questions WHERE task_id=? ORDER BY asked_at DESC LIMIT 1`, taskId);
  eq(q.decision_type, 'structural', '结构矛盾');
  assert(q.text.includes('在这条事项里答复改不了契约'), '正文带系统附注：答复改不了契约');
  assert(q.text.includes('类别选「修正」'), '并且给出真正能改的那条路（计划变更）');
  assert(q.text.includes('会被判越界并撤销'), '说清照授权去做会发生什么 —— 否则人只会再授权一次');

  const { db: db2, taskId: t2 } = fixture();
  await orchestrate(db2, { taskId: t2, workspace: makeWorkspace('ws-d11b'), narrativeDir: join(TMP, 'narr-d11b'), verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([call('raise_question', { ...QUESTION, kind: 'spec', text: '分隔符用逗号还是分号？' })]) }),
    onEvent: () => {} });
  assert(!db2.one(`SELECT text FROM questions WHERE task_id=? ORDER BY asked_at DESC LIMIT 1`, t2).text.includes('在这条事项里答复改不了契约'),
    '规格取舍不带这段 —— 它本来就是一句答复就能定的事');
  db.close(); db2.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
