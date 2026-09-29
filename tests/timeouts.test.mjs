// 提问超时链
//
// 跑：node tests/timeouts.test.mjs
//
// 断言的是状态机，不是模型：Ⅰ 级到期走默认、Ⅱ 级到期先升级再退默认、没默认的挂着、Ⅲ 级永远不动；
// 超时答复是系统写的（trust_label 不是 user-authenticated）；汇报里标注；编排器每轮开头扫。

import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { sweepTimeouts, timeoutFor, TIMEOUT_DEFAULTS_MS, TIMEOUT_KEYS } from '../src/core/timeouts.mjs';
import { gatherSince, renderSelfDecided } from '../src/agent/reporter.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const H = 3600_000, MIN = 60_000;
function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','waiting',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), taskId, t, t);
  const node = (title = 'n') => {
    const id = newId('n');
    db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,created_at) VALUES (?,?,?,'s','a','blocked',?)`, id, taskId, title, t);
    return id;
  };
  const ask = ({ level, nodeId, def = null, askedAt = t, ttl = null }) => {
    const id = newId('q');
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,?,?,'classifier',?,?,?,?,'open')`, id, taskId, nodeId, level, `问题 ${level} 级`, def, askedAt, ttl ? askedAt + ttl : null);
    return id;
  };
  return { db, taskId, userId, t, node, ask };
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. 默认时长与参数覆盖');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, userId, t } = fixture();
  eq(timeoutFor(db, taskId, 1), 30 * MIN, 'Ⅰ 级默认 30 分钟');
  eq(timeoutFor(db, taskId, 2), 2 * H, 'Ⅱ 级默认 2 小时');
  eq(timeoutFor(db, taskId, 3), null, 'Ⅲ 级无超时');
  eq(TIMEOUT_DEFAULTS_MS.l2 + TIMEOUT_DEFAULTS_MS.l2_fallback, 8 * H, 'Ⅱ 级升级 + 退默认合计 8 小时');
  db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
          VALUES (?,?,?,?,'task','constitutional','user',?,?,?)`, newId('p'), taskId, TIMEOUT_KEYS.l1, JSON.stringify(5 * MIN), userId, t, t);
  eq(timeoutFor(db, taskId, 1), 5 * MIN, '参数可覆盖（宪法层，人设）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. Ⅰ 级到期 → 默认动作 → 分支解冻；未到期不动');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, t, node, ask } = fixture();
  const n1 = node('a'), n2 = node('b');
  const q1 = ask({ level: 1, nodeId: n1, def: '按文档字面实现', askedAt: t, ttl: 30 * MIN });
  const q2 = ask({ level: 1, nodeId: n2, def: '略过', askedAt: t + 20 * MIN, ttl: 30 * MIN });
  let r = sweepTimeouts(db, { taskId, at: t + 10 * MIN });
  eq(r.defaulted.length, 0, '10 分钟：都没到期，什么都不做');
  r = sweepTimeouts(db, { taskId, at: t + 31 * MIN });
  eq(r.defaulted.length, 1, '31 分钟：q1 到期');
  eq(r.defaulted[0].questionId, q1, '到期的是 q1');
  const q = db.one(`SELECT * FROM questions WHERE id=?`, q1);
  eq(q.status, 'defaulted', '状态 defaulted（不是 answered —— 没有人答过）');
  const m = db.one(`SELECT m.* FROM messages m JOIN edges e ON e.from_id=m.id AND e.to_id=? AND e.relation='answers'`, q1);
  assert(m && m.trust_label === 'agent-generated' && m.sender_id === null, '答复由系统写：trust_label 不是 user-authenticated，没有 sender');
  assert(m.body.startsWith('[超时默认]') && m.body.includes('按文档字面实现'), '正文带 [超时默认] 前缀 + 默认动作原文');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'pending', '分支解冻：blocked → pending');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', 'q2 还开着 → 任务仍 waiting');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='question_defaulted' AND target_id=?`, q1).n, 1, '审计 question_defaulted');
  r = sweepTimeouts(db, { taskId, at: t + 31 * MIN });
  eq(r.defaulted.length, 0, '再扫一次幂等');
  r = sweepTimeouts(db, { taskId, at: t + 51 * MIN });
  eq(r.defaulted[0]?.questionId, q2, 'q2 到期');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'running', '没有开着的问题了 → 任务 running');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. Ⅱ 级：到期先升级，再到期退保守默认；没默认的挂着；Ⅲ 级永远不动');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, t, node, ask } = fixture();
  const n1 = node('a'), n2 = node('b'), n3 = node('c');
  const q2 = ask({ level: 2, nodeId: n1, def: '保守：不改接口', askedAt: t, ttl: 2 * H });
  const q2nd = ask({ level: 2, nodeId: n2, def: null, askedAt: t, ttl: 2 * H });
  const q3 = ask({ level: 3, nodeId: n3, def: null, askedAt: t, ttl: null });
  let r = sweepTimeouts(db, { taskId, at: t + 2 * H + 1 });
  eq(r.escalated.length, 2, '两个 Ⅱ 级到期 → 升级');
  eq(r.defaulted.length, 0, '升级那一刻不走默认');
  let q = db.one(`SELECT * FROM questions WHERE id=?`, q2);
  eq(q.status, 'escalated', '状态 escalated');
  eq(q.timeout_at, t + 2 * H + 1 + 6 * H, '重新计时：再等 6 小时（合计 8）');
  assert(q.escalated_at === t + 2 * H + 1, 'escalated_at 记下');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='question_escalated'`).n, 2, '审计 question_escalated ×2');
  r = sweepTimeouts(db, { taskId, at: t + 8 * H + 2 });
  eq(r.defaulted.map((x) => x.questionId).join(','), q2, '有默认的那条退默认');
  eq(r.stuck.map((x) => x.questionId).join(','), q2nd, '没默认的那条记 stuck');
  q = db.one(`SELECT * FROM questions WHERE id=?`, q2nd);
  eq(q.status, 'escalated', '没默认的仍 escalated（继续挂着，人还能答）');
  eq(q.timeout_at, null, 'timeout_at 清掉，不会每轮都记一次');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n2).status, 'blocked', '它的分支仍 blocked');
  r = sweepTimeouts(db, { taskId, at: t + 100 * H });
  eq(r.defaulted.length + r.escalated.length + r.stuck.length, 0, '再扫：q2nd 不再触发，Ⅲ 级永远不动');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, q3).status, 'open', 'Ⅲ 级仍 open');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '还有开着的 → 任务 waiting');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 汇报里标注：超时走默认进"自作主张"');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, t, node, ask } = fixture();
  const n1 = node('a');
  ask({ level: 1, nodeId: n1, def: '用逗号', askedAt: t, ttl: 30 * MIN });
  sweepTimeouts(db, { taskId, at: t + 31 * MIN });
  const f = gatherSince(db, taskId, t - 1);
  eq(f.timeouts?.length, 1, 'gatherSince 取到超时事件');
  const text = renderSelfDecided(f);
  assert(text.includes('超时走默认') && text.includes('用逗号'), '渲染进自作主张段，带默认动作原文');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 编排器每轮开头扫：cron 起一个 run 就等于有人来看了一眼');
// ═══════════════════════════════════════════════════════════════════════════
{
  const TMP = mkdtempSync(join(tmpdir(), 'si-to-'));
  const ws = join(TMP, 'ws'); mkdirSync(ws);
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, stdio: 'ignore' });
  g('init', '-q'); writeFileSync(join(ws, 'README.md'), 'x\n'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const { db, taskId, t, node, ask } = fixture();
  const n1 = node('a');
  // 到期的 Ⅰ 级问题挂在唯一节点上；扫完它就 pending，执行器接着做（假模型直接交接）
  ask({ level: 1, nodeId: n1, def: '照默认做', askedAt: t - 40 * MIN, ttl: 30 * MIN });
  const events = [];
  const client = new LlmClient({ mode: 'fake', fake: makeFake([
    { stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'tool_call', id: 'c1', name: 'write_file', args: { path: 'out.txt', content: 'x' } }] },
    { stopReason: 'tool_call', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'tool_call', id: 'c2', name: 'submit_handoff',
      args: { artifacts: [{ path: 'out.txt', kind: 'source' }], interface_contract: 'x', acceptance_evidence: 'y' } }] },
  ]) });
  const r = await orchestrate(db, { taskId, workspace: ws, narrativeDir: join(TMP, 'nar'), makeClient: () => client,
    onEvent: (e) => events.push(e), verify: false });
  assert(events.some((e) => e.type === 'question_defaulted'), '编排器开头扫到并走了默认（事件可见）');
  eq(r.kind, 'complete', '分支解冻后接着跑到完成');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'done', '节点 done');
  db.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
