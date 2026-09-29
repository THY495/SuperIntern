// 修正等裁定
//
// 跑：node tests/correction-hold.test.mjs
//
// 要防的情形：负责人对一条决定冲突判了"以旧为准"，结案几分钟后重规划器照样把那句话
// 做成了计划变更、挂了确认门，负责人再驳一次 —— 白问的一条。原因有两层：
//   ① 裁定钩子"以旧为准"时只记一条审计，重规划器根本不知道有过裁定；
//   ② 竞态：签收打回时修正消息**先**落库、比对**后**跑，守护进程可以在冲突事项挂出来之前就把它拉走。
// 这份测试把两层都钉死，外加一条边界：比对器出任何问题都不许把修正卡死。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, insertEdge } from '../src/db/db.mjs';
import { recordMessage, pendingMessages, heldSteering, holdForCheck, HOLD_FOR_CHECK_MS } from '../src/core/inbox.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { record } from '../src/core/decisions.mjs';
import { afterInput, verdictsOn } from '../src/core/decision-check.mjs';
import { renderVerdicts } from '../src/agent/replan.mjs';
import { assessTask } from '../src/core/daemon.mjs';
import { stallOf } from '../src/core/liveness.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import '../src/core/deliver.mjs';   // 签收的结论钩子在这里注册

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-hold-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const resp = (o) => ({ stopReason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(o) }], usage: { inputTokens: 10, outputTokens: 5 } });
const checker = (hits) => () => new LlmClient({ mode: 'fake', fake: makeFake([resp({ hits })]) });
const noModel = () => { throw new Error('这一轮不该调模型'); };

/** 独立任务（没有项目）：两个已完成节点 + 一个待办；一条有效决定。 */
function fixture({ withDecision = true } = {}) {
  const db = openDb(join(TMP, `${newId('db')}.db`));
  const { userId, plaintext } = ensureOwner(db);
  const taskId = newId('t');
  const t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'分页接口','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'分页接口','只动 server/','size 非法返回 400','[]',?,?)`, newId('c'), taskId, t, t);
  const ids = [];
  for (const title of ['解析参数', '返回结果', '补文档']) {
    const id = newId('n');
    db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
            VALUES (?,?,?,'s','a','pending','normal','standard',?)`, id, taskId, title, t + ids.length);
    ids.push(id);
  }
  for (const id of ids.slice(0, 2)) {
    db.run(`INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,known_issues,downstream_notes,narrative_ref,validated_at,created_at)
            VALUES (?,?,1,'[]','c','[]','',?,?,?)`, newId('h'), id, `narratives/${id}.md`, t, t);
    db.run(`UPDATE nodes SET status='done', finished_at=? WHERE id=?`, t, id);
  }
  const did = withDecision ? record(db, { taskId, subject: 'size 越界', statement: 'size 超出 1..100 时返回 400 BAD_SIZE',
    sourceKind: 'question', sourceId: 'q_old', decidedBy: userId, at: t }) : null;
  return { db, taskId, ids, userId, plaintext, did };
}
const say = (f, body) => recordMessage(f.db, { taskId: f.taskId, body, kind: 'correction', plaintextToken: f.plaintext, holdForCheck: true }).messageId;
const run = (f, makeClient = noModel, onEvent = () => {}) => orchestrate(f.db, { taskId: f.taskId, workspace: TMP,
  narrativeDir: join(TMP, 'nar'), maxCycles: 1, commit: false, verify: false, makeClient, onEvent });

// ═══════════════════════════════════════════════════════════════════════════
section('1 · 竞态：修正落库的同一个事务里就标"待比对"，比对跑完之前谁也拉不走');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  const mid = say(f, 'size 越界改成截到 100，别报 400；另外把返回里的 total 补上');
  eq(pendingMessages(f.db, f.taskId).length, 0, '收件箱里看不到它 —— 重规划器和执行器读的都是这一个口');
  const h = heldSteering(f.db, f.taskId);
  eq(h.length === 1 && h[0].why, 'check', '被挡的理由是"待比对"');
  assert(h[0].until > now() && h[0].until <= now() + HOLD_FOR_CHECK_MS, '挡到一个钟点为止 —— 比对器死在半路也不会永远卡住');

  const task = f.db.one(`SELECT * FROM tasks WHERE id=?`, f.taskId);
  const a = assessTask(f.db, task, { at: now() });
  eq(a.due, false, '守护进程这时不拉它');
  eq(a.reason, 'backoff:held_check', '理由说得出来');
  eq(stallOf(f.db, task, a).kind, 'clock', '停等账本解引用得到一个钟点 —— 不是静默停摆');

  // 人手动 run 也一样：整个任务停下，不去跑旧计划的节点（那条修正多半要改计划）
  const r = await run(f);
  eq(r.kind, 'awaiting_check', '编排器不碰节点、不调模型，退出理由是"待比对"');
  eq(f.db.one(`SELECT status FROM nodes WHERE id=?`, f.ids[2]).status, 'pending', '待办节点没被拉起');

  // 比对跑完、没命中 → 放行，并留一条触发动作把任务叫醒
  const x = await afterInput(f.db, { taskId: f.taskId, text: '另外把返回里的 total 补上', entry: 'revision', by: f.userId,
    makeClient: checker([]), sourceId: mid });
  eq(x.raised.length, 0, '没命中');
  eq(pendingMessages(f.db, f.taskId).length, 1, '放行了：收件箱里又看得到它');
  assert(!!f.db.one(`SELECT 1 FROM audit_log WHERE action='message_released' AND target_id=?`, f.taskId),
    '记了 message_released —— 守护进程认它是触发动作，被挡那一轮退出之后靠它再拉');
  const a2 = assessTask(f.db, f.db.one(`SELECT * FROM tasks WHERE id=?`, f.taskId), { at: now() });
  eq(a2.due, true, `放行之后守护进程会拉它（${a2.reason}）`);
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · 比对器出任何问题都必须放行（afterInput "永远不抛"的规矩延伸到放行）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  const mid = say(f, '改成截断');
  await afterInput(f.db, { taskId: f.taskId, text: '改成截断', entry: 'revision', by: f.userId, makeClient: () => null, sourceId: mid });
  eq(pendingMessages(f.db, f.taskId).length, 1, '没配模型 → 放行');
  f.db.close();
}
{
  const f = fixture();
  const mid = say(f, '改成截断');
  const x = await afterInput(f.db, { taskId: f.taskId, text: '改成截断', entry: 'revision', by: f.userId,
    makeClient: () => { throw new Error('厂商挂了'); }, sourceId: mid });
  eq(x.skipped, 'failed', '比对器炸了（照旧只记审计）');
  eq(pendingMessages(f.db, f.taskId).length, 1, '…而修正照样放行');
  f.db.close();
}
{
  const f = fixture();
  say(f, '改成截断');
  eq(pendingMessages(f.db, f.taskId, { at: now() + HOLD_FOR_CHECK_MS + 1 }).length, 1,
    '比对器所在的进程死了、没人放行：到点自己放行');
  const a = assessTask(f.db, f.db.one(`SELECT * FROM tasks WHERE id=?`, f.taskId), { at: now() + HOLD_FOR_CHECK_MS + 1 });
  assert(a.reason !== 'backoff:held_check', `到点之后守护进程不再说"待比对"（${a.reason}）`);
  f.db.close();
}
{
  const f = fixture({ withDecision: false });
  say(f, '改成截断');
  eq(pendingMessages(f.db, f.taskId).length, 1, '没有任何可比的决定 → 根本不标（比对必然跳过，标了只会白等）');
  f.db.close();
}
{
  const f = fixture();
  const m = recordMessage(f.db, { taskId: f.taskId, body: '改成截断', kind: 'correction', plaintextToken: f.plaintext });
  eq(pendingMessages(f.db, f.taskId).length, 1, '调用方没说要比对（holdForCheck 缺省）→ 不标：不跑比对的路不许留一条等不来放行的修正');
  f.db.close(); void m;
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · 命中 → 冲突事项有出处边指向那条修正；修正等裁定，任务的接收者是事项的收件人');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  const mid = say(f, 'size 越界改成截到 100，别报 400；另外把返回里的 total 补上');
  const x = await afterInput(f.db, { taskId: f.taskId, text: 'size 越界改成截到 100，别报 400；另外把返回里的 total 补上',
    entry: 'revision', by: f.userId, sourceId: mid,
    makeClient: checker([{ id: f.did, quote: '改成截到 100，别报 400', why: '与"返回 400 BAD_SIZE"正面冲突', confidence: 0.95 }]) });
  eq(x.raised.length, 1, '挂了冲突事项');
  const qid = x.raised[0].questionId;
  assert(!!f.db.one(`SELECT 1 FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from'`, qid, mid),
    '事项的出处边指向那条修正（不只指向被撞的决定）—— 没有它，没人知道这条修正在等谁');
  const qt = f.db.one(`SELECT text FROM questions WHERE id=?`, qid).text;
  assert(/在你选定之前不会执行/.test(qt) && !/没有拦住任何事/.test(qt),
    '事项正文说实话：修正在裁定前不会执行（原来那句"没有拦住任何事、这次说的已经生效了"对修正已经不成立）');
  const h = heldSteering(f.db, f.taskId);
  eq(h[0]?.why, 'verdict', '"待比对"那一层放掉了，换成"等裁定"');
  eq(h[0]?.questionIds?.[0], qid, '等的正是那条事项');
  assert(!f.db.one(`SELECT 1 FROM audit_log WHERE action='message_released' AND target_id=?`, f.taskId),
    '没有记 message_released —— 它此刻并不能处理，记了只会把任务白叫醒一次');
  assert(!!f.db.one(`SELECT 1 FROM audit_log WHERE action='message_held_for_verdict' AND target_id=?`, f.taskId), '记的是 message_held_for_verdict');

  const task = f.db.one(`SELECT * FROM tasks WHERE id=?`, f.taskId);
  const a = assessTask(f.db, task, { at: now() });
  eq(a.reason, 'held:verdict', '守护进程不拉，理由是"等裁定"');
  const s = stallOf(f.db, task, a);
  eq(s.kind, 'human', '停等账本解引用到人');
  eq(s.ref?.questionId, qid, '…就是那条冲突事项');

  const r = await run(f);
  eq(r.kind, 'awaiting_verdict', '手动 run：不调模型、不碰节点，退出理由是"等裁定"');

  // 裁定：以旧为准
  recordAnswer(f.db, { questionId: qid, body: '以旧为准', plaintextToken: f.plaintext });
  eq(pendingMessages(f.db, f.taskId).length, 1, '裁定之后修正放行');
  const v = verdictsOn(f.db, mid);
  eq(v.length === 1 && v[0].verdict, 'old', '修正身上带着"以旧为准"的结论');
  eq(v[0].decisions[0]?.id, f.did, '…和被维持的那条决定');
  const a2 = assessTask(f.db, f.db.one(`SELECT * FROM tasks WHERE id=?`, f.taskId), { at: now() });
  eq(a2.due, true, `裁定一出守护进程就拉（${a2.reason}）`);

  // 重规划器真的拿到了结论 —— 走编排器，不是直接调 renderVerdicts（"注释说有、代码里没有"那一族）
  const seen = [];
  const rev = { impact: f.ids.map((id) => ({ node_id: id, mark: 'unaffected', reason: '照旧' })),
    new_nodes: [{ key: 'total', title: '返回 total', spec: 's', acceptance: 'a', risk_tier: 'low', model_tier: 'light', depends_on: [] }],
    rationale: '只补 total；截断那一句已判以旧为准，不做' };
  const fake = makeFake([{ stopReason: 'tool_call', usage: {}, content: [{ type: 'tool_call', id: 'r', name: 'submit_revision', args: rev }] }]);
  const events = [];
  await run(f, () => { const c = new LlmClient({ mode: 'fake', fake }); const orig = c.complete.bind(c); c.complete = (canon) => { seen.push(canon); return orig(canon); }; return c; },
    (e) => events.push(e.type));
  const prompt = JSON.stringify(seen[0] ?? {});
  assert(prompt.includes('以旧为准') && prompt.includes('不要执行'), '重规划器的输入里写着"以旧为准，相冲的那部分不要执行"');
  assert(prompt.includes('size 超出 1..100 时返回 400 BAD_SIZE'), '…并且列出了被维持的那条决定原文');
  assert(events.includes('revision_applied'), '修正里没冲突的那一点（补 total）照常生效 —— 不是整条驳回');
  eq(pendingMessages(f.db, f.taskId).length, 0, '修正被消费');
  f.db.close();
}
{
  // 以新为准：旧决定作废，修正照做，提示里不出现"不要执行"
  const f = fixture();
  const mid = say(f, '改成截断');
  const x = await afterInput(f.db, { taskId: f.taskId, text: '改成截断', entry: 'revision', by: f.userId, sourceId: mid,
    makeClient: checker([{ id: f.did, quote: '改成截断', why: '冲突', confidence: 0.9 }]) });
  recordAnswer(f.db, { questionId: x.raised[0].questionId, body: '以新为准', plaintextToken: f.plaintext });
  const v = verdictsOn(f.db, mid);
  eq(v[0]?.verdict, 'new', '带着"以新为准"');
  const txt = renderVerdicts(f.db, v);
  assert(/已作废/.test(txt) && !/不要执行/.test(txt), '提示说旧决定已作废、修正照做');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · 签收打回：比对的是答复原文，等的是钩子生成的那条修正（实际会走的那条路）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  const sq = newId('q');
  f.db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,addressed_to,asked_at,timeout_at,status,decision_type)
            VALUES (?,?,NULL,3,'hard_rule','签收',NULL,?,?,NULL,'open','signoff')`, sq, f.taskId, JSON.stringify([f.userId]), now());
  f.db.run(`UPDATE tasks SET status='done' WHERE id=?`, f.taskId);
  const r = recordAnswer(f.db, { questionId: sq, body: '打回：size 越界应该截到 100 而不是报 400；其余没问题', plaintextToken: f.plaintext });
  const m = f.db.one(`SELECT id FROM messages WHERE task_id=? AND kind='correction'`, f.taskId);
  assert(!!m, '钩子生成了修正');
  eq(pendingMessages(f.db, f.taskId).length, 0, '钩子生成的那一刻就标了"待比对" —— 守护进程抢不走');
  const x = await afterInput(f.db, { taskId: f.taskId, text: '打回：size 越界应该截到 100 而不是报 400；其余没问题', entry: 'answer',
    by: f.userId, sourceId: r.messageId,
    makeClient: checker([{ id: f.did, quote: '截到 100 而不是报 400', why: '冲突', confidence: 0.95 }]) });
  assert(!!f.db.one(`SELECT 1 FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from'`, x.raised[0].questionId, m.id),
    '冲突事项连到的是**那条修正**（经 答复 → 修正 的派生边找到的），不是答复本身');
  eq(heldSteering(f.db, f.taskId)[0]?.why, 'verdict', '修正在等裁定');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · 同一条决定已有冲突事项开着：新修正连到那一条，不另挂');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  const hit = [{ id: f.did, quote: '截断', why: '冲突', confidence: 0.9 }];
  const m1 = say(f, '改成截断');
  const x1 = await afterInput(f.db, { taskId: f.taskId, text: '改成截断', entry: 'revision', by: f.userId, sourceId: m1, makeClient: checker(hit) });
  const m2 = say(f, '截断吧，别报错');
  const x2 = await afterInput(f.db, { taskId: f.taskId, text: '截断吧，别报错', entry: 'revision', by: f.userId, sourceId: m2, makeClient: checker(hit) });
  eq(x2.raised[0]?.reused, true, '没有另挂');
  assert(!!f.db.one(`SELECT 1 FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from'`, x1.raised[0].questionId, m2),
    '第二条修正也连到了那条事项上 —— 它等的正是那一条的结论');
  eq(heldSteering(f.db, f.taskId).filter((h) => h.why === 'verdict').length, 2, '两条都在等');
  f.db.close();
}

{
  // 对照：没有修正被挡着的入口（新任务描述），事项正文照旧是'没有拦住任何事'
  const f = fixture();
  const x = await afterInput(f.db, { taskId: f.taskId, text: '新任务：截断', entry: 'task', by: f.userId,
    makeClient: checker([{ id: f.did, quote: '截断', why: '冲突', confidence: 0.9 }]) });
  assert(/没有拦住任何事/.test(f.db.one('SELECT text FROM questions WHERE id=?', x.raised[0].questionId).text), '没有修正在等时，正文照旧说"没有拦住任何事"');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
section('6 · 别的事项从消息派生不算"等裁定"（重规划器的提问照旧）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  const m = recordMessage(f.db, { taskId: f.taskId, body: '改成截断', kind: 'correction', plaintextToken: f.plaintext });
  const q = newId('q');
  f.db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,2,'classifier','这句话指哪个接口？',NULL,?,NULL,'open')`, q, f.taskId, now());
  insertEdge(f.db, q, m.messageId, 'derived_from', now());
  eq(pendingMessages(f.db, f.taskId).length, 1, '只认决定冲突事项（另有出处边指向 dr_*）—— 普通事项开着时消息照常出现');
  f.db.close();
}
{
  // holdForCheck 只标修正 / 新指令：补充上下文不改变要做什么，不挡
  const f = fixture();
  const m = recordMessage(f.db, { taskId: f.taskId, body: '顺便说一下，前端用的是 axios', kind: 'context', plaintextToken: f.plaintext, holdForCheck: true });
  holdForCheck(f.db, [m.messageId]);
  eq(pendingMessages(f.db, f.taskId).length, 1, '补充上下文从来不被挡');
  f.db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
