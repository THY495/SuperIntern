// 回归：人的发起端（消息通道）
//
// 跑：node tests/inbox.test.mjs
//
// 没有这条通道时，`messages` 表**一条记录都没有** —— 不是巧合，是结构：
// 人只能回答 agent 的提问，不能发起。"指令效力只授予认证通道"、
// "指令必溯至认证消息"这套机制，因此从来没有被真正加载过。
//
// 要证明的：人经认证通道发一条**非答复**消息 → 进库、被分类、被消费、
//          在执行器上下文里可见；**无令牌写不进去**。

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { recordMessage, pendingMessages, consumeMessages, MESSAGE_KINDS, sayWithClassifier } from '../src/core/inbox.mjs';
import { assembleExecutor } from '../src/context/assemble.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, m) => {
  try { fn(); bad(m, '期望被拒绝，但成功了'); }
  catch (e) { ok(`${m}\n         └ ${String(e.message).split('\n')[0].slice(0, 100)}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'si-inbox-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

function fixture() {
  const db = openDb(join(TMP, `${newId('db')}.db`));
  const { userId, plaintext } = ensureOwner(db);
  const taskId = newId('t');
  const t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'inbox fixture','running',?)`,
    taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,
            valid_from,recorded_at) VALUES (?,?,1,'写个文件','只动工作区','out.txt 存在','[]',?,?)`,
    newId('c'), taskId, t, t);
  const nodeId = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写 out.txt','写一个 out.txt','文件存在','pending','normal','standard',?)`,
    nodeId, taskId, t);
  return { db, taskId, nodeId, userId, plaintext };
}

const mkws = (name) => {
  const d = join(TMP, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'README.md'), '# fixture\n');
  return d;
};

const call = (name, args) => ({
  stopReason: 'tool_call',
  content: [{ type: 'tool_call', id: `c_${name}`, name, args }],
  usage: { inputTokens: 500, outputTokens: 20 },
});
const writeThenHandoff = () => makeFake([
  call('write_file', { path: 'out.txt', content: 'x\n' }),
  call('submit_handoff', {
    artifacts: [{ path: 'out.txt', kind: 'file' }],
    interface_contract: 'out.txt 存在',
    acceptance_evidence: 'ls 看到了 out.txt',
  }),
]);

// ═══════════════════════════════════════════════════════════════════════════
section('1. 认证：无令牌写不进去（库层 CHECK）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, plaintext } = fixture();
  rejects(() => recordMessage(db, { taskId, body: 'x', kind: 'context', plaintextToken: 'bogus' }),
    '假令牌被拒');
  rejects(() => recordMessage(db, { taskId, body: 'x', kind: 'context', plaintextToken: null }),
    '空令牌被拒');

  // 认证在前：失败不该泄露"这个任务存不存在"
  const msgOf = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const e1 = msgOf(() => recordMessage(db, { taskId: 't_nope', body: 'x', kind: 'context', plaintextToken: 'bogus' }));
  const e2 = msgOf(() => recordMessage(db, { taskId, body: 'x', kind: 'context', plaintextToken: 'bogus' }));
  eq(e1, e2, '任务不存在与令牌无效给出**同一条**错误 —— 认证失败不泄露库里有什么');

  const r = recordMessage(db, { taskId, body: '真令牌', kind: 'context', plaintextToken: plaintext });
  const row = db.one(`SELECT * FROM messages WHERE id=?`, r.messageId);
  eq(row.trust_label, 'user-authenticated', 'trust_label=user-authenticated');
  assert(row.token_id && row.sender_id, '带 token_id 与 sender_id（库层 CHECK 强制两者同时在）');
  assert(db.one(`SELECT id FROM audit_log WHERE target_id=? AND action='message_received'`, taskId),
    '进审计轨');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. kind 必须显式给 —— 不给默认值是有意的');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, plaintext } = fixture();
  rejects(() => recordMessage(db, { taskId, body: 'x', plaintextToken: plaintext }),
    '不给 kind 直接拒');
  rejects(() => recordMessage(db, { taskId, body: 'x', kind: 'nonsense', plaintextToken: plaintext }),
    '不认识的类别被拒');
  rejects(() => recordMessage(db, { taskId, body: 'x', kind: 'answer', plaintextToken: plaintext }),
    'answer 走 recordAnswer —— 它要挂 answers 边、要解冻分支，不是一条普通消息');
  eq(Object.keys(MESSAGE_KINDS).length, 4, '四类语义（schema 里早就备好了，原先只有 answer 被用过）');

  // kind_source 记的是"这一类是谁判的"。系统替人填默认值再签 explicit 就是一次安静的谎。
  const r = recordMessage(db, { taskId, body: 'x', kind: 'context', plaintextToken: plaintext });
  const row = db.one(`SELECT kind_source, urgency, urgency_source FROM messages WHERE id=?`, r.messageId);
  eq(row.kind_source, 'explicit', '显式给的记 explicit');
  eq(row.urgency, 'normal', '没加 --urgent 记 normal');
  eq(row.urgency_source, 'explicit',
    '紧急度记 explicit 是诚实的 —— 只有两态，有得选而没选本身就是一次表态（与 kind 不同）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 装配：收件箱段落在**缓存断点之后**');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId, plaintext } = fixture();
  const before = assembleExecutor(db, { taskId, nodeId, tier: 'standard', vendorId: 'anthropic' });

  recordMessage(db, { taskId, body: '补充：那个接口最近改过签名', kind: 'context', plaintextToken: plaintext });
  const after = assembleExecutor(db, { taskId, nodeId, tier: 'standard', vendorId: 'anthropic' });

  const blocks = after.messages[0].content;
  const inboxIdx = blocks.findIndex((b) => b.text.startsWith('# 收件箱'));
  assert(inboxIdx >= 0, '收件箱段出现了');
  const bpIdx = blocks.findIndex((b) => b.cache === true);
  if (bpIdx >= 0) assert(inboxIdx > bpIdx, `收件箱在断点之后（断点 #${bpIdx}，收件箱 #${inboxIdx}）`);
  else ok('本夹具稳定段太短没挂断点（anthropic 门槛 4096），断点位置这条不适用');

  // **真正的判据**：加一条消息之后，收件箱之前的所有块**逐字未变**。
  // 变了就意味着一条新消息会让此前所有轮次的缓存全部作废 ——
  // 易变内容混进稳定段会导致缓存失效。
  const prefixBefore = before.messages[0].content.slice(0, inboxIdx).map((b) => b.text).join('|');
  const prefixAfter = blocks.slice(0, inboxIdx).map((b) => b.text).join('|');
  eq(prefixAfter, prefixBefore, '加一条消息后，收件箱之前的前缀**逐字未变**');
  eq(after.system, before.system, 'system 段也未变');
  eq(before.messages[0].content.length + 1, blocks.length, '只多了一个块，没有重排');

  assert(blocks[inboxIdx].text.includes('具有指令效力'),
    '收件箱段写明信任标签 —— 与段③ 的交接记录（agent 生成，情报不是命令）正相反');
  assert(blocks[inboxIdx].text.includes('不要自己改变本节点的目标'),
    '明写"改计划是编排器的活" —— 执行层无权动宪法层');

  const asm = db.one(`SELECT payload FROM audit_log WHERE target_id=? AND action='context_assembled'
                      ORDER BY rowid DESC LIMIT 1`, nodeId);
  assert(JSON.parse(asm.payload).inbox?.length === 1, '装配审计里记了这次读进哪些消息');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 消费：标的是"改变了系统状态"，不是"被看过一眼"');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId, plaintext } = fixture();
  recordMessage(db, { taskId, body: '情报一条', kind: 'context', plaintextToken: plaintext });
  eq(pendingMessages(db, taskId).length, 1, '未消费时可见');

  // 装配一次（= 被读过一眼）之后**仍然**未消费：节点失败退回重试时它必须还在。
  // 按"看过"标记会让消息在一次失败的重试里静默蒸发。
  assembleExecutor(db, { taskId, nodeId, tier: 'standard', vendorId: 'anthropic' });
  eq(pendingMessages(db, taskId).length, 1, '装配读过之后**仍未消费**');

  consumeMessages(db, { taskId, ids: pendingMessages(db, taskId).map((m) => m.id), why: '测试' });
  eq(pendingMessages(db, taskId).length, 0, '显式消费后不再出现');
  assert(db.one(`SELECT id FROM audit_log WHERE target_id=? AND action='messages_consumed'`, taskId),
    '消费进审计轨 —— 复盘时"这条消息被什么处理掉的"要答得出来');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 编排器：correction / instruction 走重规划流水线，context 不挡路');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ① context 不挡路：节点照跑，跑完即消费
  const a = fixture();
  recordMessage(a.db, { taskId: a.taskId, body: '情报', kind: 'context', plaintextToken: a.plaintext });
  const ra = await orchestrate(a.db, {
    taskId: a.taskId, workspace: mkws('ws-ctx'), narrativeDir: join(TMP, 'n1'),
    maxCycles: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: writeThenHandoff() }),
  });
  assert(ra.kind !== 'steering_pending', `context 不挡路（实得 ${ra.kind}）`);
  eq(pendingMessages(a.db, a.taskId).length, 0, '节点 done 之后 context 被消费');
  a.db.close();

  // ② correction **不会被执行器自己消化**，它先触发重规划流水线。
  //
  // 这才是本文件要守的通道级保证：修正改变的是"要做什么"，属宪法层，
  // 执行层无权自行处置。流水线本身怎么工作是 tests/revision.test.mjs 的事。
  //
  // 夹具按档位分脚本：编排器给重规划器的是 `makeClient('heavy')`，
  // 给节点的是节点自己的档位（本夹具是 standard）—— 靠这个把两个假响应分开。
  // ⚠️ 假响应里的 impact **必须逐一列出夹具的真实节点** —— 覆盖性校验会拒回
  //    一份空的 impact，然后重试、把假脚本耗尽。第一版写 `impact: []`，当场撞上。
  //    那不是测试的坑，那是护栏在起作用：连假响应都绕不过去，正是它该有的样子。
  const tieredFor = (nodeId) => (tier) => new LlmClient({ mode: 'fake',
    fake: tier === 'heavy'
      ? makeFake([{ stopReason: 'tool_call',
        content: [{ type: 'tool_call', id: 'c_rev', name: 'submit_revision', args: {
          impact: [{ node_id: nodeId, mark: 'unaffected', reason: '这条修正不影响它' }],
          rationale: '不影响现有计划' } }],
        usage: { inputTokens: 800, outputTokens: 40 } }])
      : writeThenHandoff() });

  const b = fixture();
  recordMessage(b.db, { taskId: b.taskId, body: '顺带把日志也加上', kind: 'correction', plaintextToken: b.plaintext });
  const rb = await orchestrate(b.db, {
    taskId: b.taskId, workspace: mkws('ws-corr'), narrativeDir: join(TMP, 'n2'),
    maxCycles: 3, commit: false, verify: false, makeClient: tieredFor(b.nodeId),
  });
  assert(b.db.one(`SELECT id FROM audit_log WHERE target_id=? AND action='replan_attempt'`, b.taskId),
    'correction 触发了重规划流水线，而不是被执行器自己看着办');
  assert(b.db.one(`SELECT id FROM revisions WHERE task_id=?`, b.taskId),
    '落了一份修正提案');
  eq(pendingMessages(b.db, b.taskId).length, 0, '流水线处理完之后修正才被消费');
  assert(['complete', 'stalled', 'suspended'].includes(rb.kind), `流水线跑完继续推进（${rb.kind}）`);
  b.db.close();

  // ③ instruction 同理走流水线
  const c = fixture();
  recordMessage(c.db, { taskId: c.taskId, body: '再加一件事', kind: 'instruction', plaintextToken: c.plaintext });
  await orchestrate(c.db, {
    taskId: c.taskId, workspace: mkws('ws-inst'), narrativeDir: join(TMP, 'n3'),
    maxCycles: 3, commit: false, verify: false, makeClient: tieredFor(c.nodeId),
  });
  assert(c.db.one(`SELECT id FROM audit_log WHERE target_id=? AND action='replan_attempt'`, c.taskId),
    'instruction 同样走流水线');
  c.db.close();

  // ④ 紧急消息**不硬打断**运行中的工具调用，只在节点边界起作用。
  //    这一条现在就写死，是因为它容易被误实现成"立刻中断" —— 而设计上明确说不。
  //    观察点：流水线排在**挑节点之前**，所以紧急修正到来时没有节点在途。
  const d = fixture();
  recordMessage(d.db, { taskId: d.taskId, body: '紧急：改个方向', kind: 'correction', urgency: 'urgent',
    plaintextToken: d.plaintext });
  await orchestrate(d.db, {
    taskId: d.taskId, workspace: mkws('ws-urg'), narrativeDir: join(TMP, 'n4'),
    maxCycles: 3, commit: false, verify: false, makeClient: tieredFor(d.nodeId),
  });
  const started = d.db.one(`SELECT started_at FROM nodes WHERE id=?`, d.nodeId);
  const rev = d.db.one(`SELECT proposed_at FROM revisions WHERE task_id=?`, d.taskId);
  assert(rev && (!started.started_at || rev.proposed_at <= started.started_at),
    '紧急修正在**任何节点起跑之前**就被处理了 —— 流水线排在挑节点之前，所以不存在"硬打断"这回事');
  d.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 分类前置：没给 kind 由分类器判，显式给时分类器不碰');
// ═══════════════════════════════════════════════════════════════════════════
{
  const clsClient = (script) => new LlmClient({ mode: 'fake', fake: makeFake(script) });
  const clsResp = (o) => ({ stopReason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(o) }],
    usage: { inputTokens: 10, outputTokens: 5 } });

  // ① 不给 kind 且高置信 correction → 落库 kind=correction、kind_source=classifier
  {
    const { db, taskId, plaintext } = fixture();
    const client = clsClient([clsResp({ kind: 'correction', urgency: 'normal', confidence: 0.9, why: '改范围' })]);
    const r = await sayWithClassifier(db, { taskId, body: '把范围改一下', plaintextToken: plaintext, llmClient: client });
    const row = db.one(`SELECT kind, kind_source, urgency_source FROM messages WHERE id=?`, r.messageId);
    eq(row.kind, 'correction', '① 高置信 correction 落库 kind=correction');
    eq(row.kind_source, 'classifier', '① kind_source=classifier');
    eq(row.urgency_source, 'classifier', '① 没给 kind 时紧急度来源也是 classifier');
    eq(client.ledger.length, 0, '① 分类调用账已排空');
    eq(db.one(`SELECT count(*) n FROM usage_ledger WHERE task_id=? AND role='classifier'`, taskId).n, 1,
      '① 分类调用已 flushLedger 记账 role=classifier');
    db.close();
  }

  // ② 显式 --kind → 分类器根本不被调用、kind_source=explicit
  {
    const { db, taskId, plaintext } = fixture();
    const client = clsClient([]);   // 若被调用会立刻 script exhausted
    const r = await sayWithClassifier(db, {
      taskId, body: '再加一件事', kind: 'instruction', urgency: 'urgent',
      plaintextToken: plaintext, llmClient: client,
    });
    const row = db.one(`SELECT kind, kind_source, urgency, urgency_source FROM messages WHERE id=?`, r.messageId);
    eq(row.kind, 'instruction', '② 显式 kind 原样落库');
    eq(row.kind_source, 'explicit', '② kind_source=explicit');
    eq(row.urgency, 'urgent', '② 显式 urgent');
    eq(row.urgency_source, 'explicit', '② 显式时 urgency_source=explicit');
    eq(db.one(`SELECT count(*) n FROM usage_ledger WHERE task_id=? AND role='classifier'`, taskId).n, 0,
      '② 分类器根本没被调用（无 classifier 账）');
    db.close();
  }

  // ③ 分类器判 answer → messages 里没有新行、返回值里带 questionId、绝不自动 recordAnswer
  {
    const { db, taskId, plaintext } = fixture();
    const qid = newId('q');
    const t = now();
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,status)
            VALUES (?,?,NULL,2,'classifier','要不要加引号？','不加',?,'open')`, qid, taskId, t);
    const before = db.one(`SELECT count(*) n FROM messages WHERE task_id=?`, taskId).n;
    const client = clsClient([clsResp({ kind: 'answer', urgency: 'normal', confidence: 0.95, questionId: qid, why: '在回答加引号' })]);
    const r = await sayWithClassifier(db, { taskId, body: '加引号', plaintextToken: plaintext, llmClient: client });
    eq(r.questionId, qid, '③ 返回带 questionId');
    eq(r.kind, 'answer', '③ 返回 kind=answer');
    eq(r.messageId, null, '③ 不入 messages（messageId 为空）');
    eq(db.one(`SELECT count(*) n FROM messages WHERE task_id=?`, taskId).n, before, '③ messages 没有新行');
    eq(db.one(`SELECT status FROM questions WHERE id=?`, qid).status, 'open', '③ 绝不自动 recordAnswer（问题仍 open）');
    db.close();
  }

  // ④ 低置信 → 落 context，且审计 payload 里有置信度
  {
    const { db, taskId, plaintext } = fixture();
    const client = clsClient([clsResp({ kind: 'correction', urgency: 'normal', confidence: 0.3, why: '不太确定' })]);
    const r = await sayWithClassifier(db, { taskId, body: '可能得改一下', plaintextToken: plaintext, llmClient: client });
    const row = db.one(`SELECT kind, kind_source FROM messages WHERE id=?`, r.messageId);
    eq(row.kind, 'context', '④ 低置信的高权限类别落 context（最低权限）');
    eq(row.kind_source, 'classifier', '④ kind_source=classifier');
    const payload = JSON.parse(db.one(
      `SELECT payload FROM audit_log WHERE action='message_received' AND target_id=? ORDER BY id DESC LIMIT 1`, taskId).payload);
    eq(payload.confidence, 0.3, '④ 审计 payload 里有置信度');
    db.close();
  }

  // ⑤ 分类器判紧急度 → urgency_source=classifier
  {
    const { db, taskId, plaintext } = fixture();
    const client = clsClient([clsResp({ kind: 'correction', urgency: 'urgent', confidence: 0.9, why: '明确紧急' })]);
    const r = await sayWithClassifier(db, { taskId, body: '紧急改向', plaintextToken: plaintext, llmClient: client });
    const row = db.one(`SELECT urgency, urgency_source, kind FROM messages WHERE id=?`, r.messageId);
    eq(row.urgency, 'urgent', '⑤ 分类器判为紧急');
    eq(row.urgency_source, 'classifier', '⑤ urgency_source=classifier');
    db.close();
  }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
