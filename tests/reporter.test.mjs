// 主动汇报
//
// 跑：node tests/reporter.test.mjs
//
// 三条硬要求各自的断言：仅从真相源装配（facts 只含库里的 id）；自作主张那一节
// 由代码生成、模型写不写都在；持久化纪律审计（done 了却重建不出来 → gaps）。
// 外加：模型挂了汇报照样产生（模板）；窗口是"自上次汇报以来"。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, insertEdge } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { ProviderError } from '../src/core/errors.mjs';
import { makeReport, gatherSince, listReports, markReportsRead, renderFacts } from '../src/agent/reporter.mjs';
import { recordMessage } from '../src/core/inbox.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-rep-'));
mkdirSync(join(TMP, 'nar'), { recursive: true });
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

function fixture() {
  const db = openDb(':memory:');
  const { userId, plaintext } = ensureOwner(db);
  const taskId = newId('t'), t = now() - 10_000;
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'做一个 CSV 导出','src/','能导出','[]',?,?)`, newId('c'), taskId, t, t);
  const ids = ['解析层', '格式化层'].map((title, i) => {
    const id = newId('n');
    db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
            VALUES (?,?,?,'s','a','pending','normal','standard',?)`, id, taskId, title, t + i);
    return id;
  });
  return { db, taskId, ids, userId, plaintext };
}
/** 让一个节点"真的"完成：交接记录 + 叙事文件 + 决策 + 假设 + node_done 审计。 */
function finishNode(db, taskId, nodeId, { narrative = true, settled = false } = {}) {
  const t = now();
  const hid = newId('h');
  const nref = join(TMP, 'nar', `${nodeId}.md`);
  if (narrative) writeFileSync(nref, '# 叙事\n');
  db.run(`INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,known_issues,
            downstream_notes,narrative_ref,validated_at,created_at) VALUES (?,?,1,'[{"path":"a.mjs","kind":"source"}]','c','[]','',?,?,?)`,
  hid, nodeId, nref, t, t);
  const did = newId('d');
  db.run(`INSERT INTO decisions (id,task_id,node_id,summary,rationale,actor_kind,actor_id,layer,valid_from,recorded_at)
          VALUES (?,?,?,'用流式解析','文件可能很大','agent','executor','execution',?,?)`, did, taskId, nodeId, t, t);
  const aid = newId('as');
  db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at)
          VALUES (?,?,?,'csv.delimiter',?,?,?,?,?,?,?)`,
  aid, taskId, nodeId, settled ? '分隔符定为逗号，人没说' : '分隔符按 RFC 4180 是逗号',
  settled ? 'active' : 'confirmed', settled ? 'settled_by_me' : 'spec',
  settled ? '规格没写，我定的' : '规格 §2 原文"逗号分隔"', settled ? 1 : 0, t, t);
  db.run(`UPDATE nodes SET status='done', finished_at=? WHERE id=?`, t, nodeId);
  db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,?,?,?,?,?,?)`,
    t, 'agent', 'executor', 'node_done', 'node', nodeId,
    JSON.stringify({ handoffId: hid, artifacts: ['a.mjs'], narrativeRef: nref }));
  return { hid, did, aid, nref };
}
const reportCall = (summary) => ({
  stopReason: 'tool_call',
  content: [{ type: 'tool_call', id: 'r', name: 'submit_report',
    args: { summary, next_steps: '接着做格式化层', uncertainties: '分隔符没定' } }],
  usage: { inputTokens: 100, outputTokens: 30 },
});

// ═══════════════════════════════════════════════════════════════════════════
section('1. 仅从真相源装配：facts 里只有库里的 id，模型只写散文');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids, plaintext } = fixture();
  const { hid, did, aid } = finishNode(db, taskId, ids[0]);
  recordMessage(db, { taskId, body: '记得处理 BOM', kind: 'context', plaintextToken: plaintext });

  const client = new LlmClient({ mode: 'fake', fake: makeFake([reportCall('解析层做完了，正在做格式化层')]) });
  const r = await makeReport(db, { taskId, trigger: 'node_done', triggerRef: ids[0], client });
  eq(r.generatedBy, 'llm', '模型给了摘要 → generated_by=llm');
  eq(r.summary, '解析层做完了，正在做格式化层', '摘要来自模型');
  assert(r.facts.handoffs.includes(hid) && r.facts.decisions.includes(did) && r.facts.assumptions.includes(aid),
    'facts 记下了装配用到的交接/决策/假设 id（装配审计）');
  eq(r.facts.messages.length, 1, '人发来的消息也在 facts 里');
  assert(r.body.includes('记得处理 BOM'), '正文含人发来的消息 —— 汇报要能回答"人说过什么"');
  assert(r.body.includes('用流式解析'), '正文含 agent 的决策');
  const row = db.one(`SELECT * FROM reports WHERE id=?`, r.id);
  assert(row && row.read_at === null, '落库、未读');
  eq(db.one(`SELECT count(*) AS n FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from'`, r.id, ids[0]).n, 1,
    '出处边：这份汇报因为那个节点而存在');
  eq(db.one(`SELECT count(*) AS n FROM audit_log WHERE action='report_generated'`).n, 1, 'report_generated 审计');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 自作主张那一节由代码生成 —— 模型写不写都在');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids } = fixture();
  finishNode(db, taskId, ids[0], { settled: true });
  // 模型的摘要故意只字不提那条替人做的决定
  const client = new LlmClient({ mode: 'fake', fake: makeFake([reportCall('一切顺利')]) });
  const r = await makeReport(db, { taskId, trigger: 'node_done', triggerRef: ids[0], client });
  assert(r.body.includes('替人做了个决定') && r.body.includes('分隔符定为逗号，人没说'),
    'settled_by_me 的假设出现在正文里，尽管模型的摘要是"一切顺利"');
  assert(r.body.includes('用流式解析'), 'agent 的执行层决策也在那一节里');
  eq(r.selfDecidedCount, 2, '计数：1 条强制披露假设 + 1 条 agent 决策');
  assert(r.body.indexOf('自作主张') < r.body.indexOf('自上次汇报以来'), '自作主张排在 diff 之前 —— 人监督价值最高的部分先看');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 持久化纪律审计：done 了却重建不出来 → gaps');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids } = fixture();
  finishNode(db, taskId, ids[0], { narrative: false });          // 叙事文件没写
  const r = await makeReport(db, { taskId, trigger: 'node_done', triggerRef: ids[0], client: null });
  assert(r.gaps.some((g) => g.includes('叙事文件不在')), '叙事文件缺失被记为 gap（上下文考古断线）');
  assert(r.body.includes('持久化纪律审计'), '正文里有审计一节');

  const { db: db2, taskId: t2, ids: i2 } = fixture();
  // node_done 审计有、交接记录没有 —— 不可能经 persistHandoff 产生，只能是绕过了它
  db2.run(`UPDATE nodes SET status='pending' WHERE id=?`, i2[0]);
  db2.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,?,?,?,?,?,?)`,
    now(), 'agent', 'executor', 'node_done', 'node', i2[0], JSON.stringify({ handoffId: 'h_ghost', artifacts: [] }));
  const r2 = await makeReport(db2, { taskId: t2, trigger: 'node_done', client: null });
  assert(r2.gaps.some((g) => g.includes('没有它的交接记录')), '有 node_done 无交接记录 → gap（只凭真相源重建不出这一步）');
  db.close(); db2.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 模型挂了汇报照样产生；预算触顶时一次都不调');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids } = fixture();
  finishNode(db, taskId, ids[0]);
  const boom = new ProviderError('x HTTP 503', { vendor: 'v', model: 'm', tier: 'light', status: 503, retryable: true, attempts: 4 });
  const r = await makeReport(db, { taskId, trigger: 'node_done', triggerRef: ids[0],
    client: new LlmClient({ mode: 'fake', fake: makeFake([boom]) }) });
  eq(r.generatedBy, 'template', '厂商挂了 → 模板汇报');
  assert(r.gaps.some((g) => g.includes('调用失败')), '失败原因写进 gaps，不是吞掉');
  assert(r.summary.includes('node_done') && r.body.includes('解析层'), '模板摘要与正文仍然说清了发生了什么');

  const r2 = await makeReport(db, { taskId, trigger: 'limit_breached', client: null });
  eq(r2.generatedBy, 'template', 'client=null → 模板，一次模型都不调（钱花光了也说得出口）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 窗口：自上次汇报以来，不重复');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids } = fixture();
  finishNode(db, taskId, ids[0]);
  const r1 = await makeReport(db, { taskId, trigger: 'node_done', triggerRef: ids[0], client: null });
  eq(r1.facts.nodes.length, 1, '第一份：1 个节点');
  await new Promise((res) => setTimeout(res, 5));
  finishNode(db, taskId, ids[1]);
  const r2 = await makeReport(db, { taskId, trigger: 'node_done', triggerRef: ids[1], client: null });
  eq(r2.facts.nodes.length, 1, '第二份：只有新完成的那 1 个，第一个不再出现');
  eq(db.one(`SELECT since_report_id FROM reports WHERE id=?`, r2.id).since_report_id, r1.id, 'since_report_id 指向上一份');
  eq(listReports(db, taskId).length, 2, '两份未读');
  markReportsRead(db, [r1.id]);
  eq(listReports(db, taskId).length, 1, '标一份已读后剩一份');
  eq(listReports(db, taskId, { all: true }).length, 2, '--all 仍是两份');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 编排器：report 默认关；开了就在节点完成 / 任务完成时各来一份');
// ═══════════════════════════════════════════════════════════════════════════
{
  const WS = join(TMP, 'ws'); mkdirSync(WS, { recursive: true }); writeFileSync(join(WS, 'seed.txt'), 'x\n');
  const handoff = {
    stopReason: 'tool_call', usage: { inputTokens: 10, outputTokens: 5 },
    content: [{ type: 'tool_call', id: 'h', name: 'submit_handoff', args: {
      artifacts: [{ path: 'seed.txt', kind: 'source' }], interface_contract: 'c', acceptance_evidence: 'e',
      key_decisions: [], assumptions: [], known_issues: [], downstream_notes: '' } }],
  };
  // **一个**共享的假厂商：执行器、汇报器各自 makeClient() 拿到的是同一卷脚本，按顺序消费 ——
  // 每次 new 一个新 fake 的话，汇报器会从头重放执行器那一条（submit_handoff 对它是 unknown tool）。
  const mk = (script) => { const fake = makeFake(script); return () => new LlmClient({ mode: 'fake', fake }); };
  const base = { workspace: WS, narrativeDir: join(TMP, 'nar6'), maxCycles: 4, commit: false, verify: false, exec: new LocalExecutor() };

  const { db, taskId } = fixture();
  db.run(`DELETE FROM nodes WHERE task_id=? AND title='格式化层'`, taskId);
  await orchestrate(db, { taskId, ...base, makeClient: mk([handoff]) });
  eq(db.one(`SELECT count(*) AS n FROM reports WHERE task_id=?`, taskId).n, 0, '默认关：一份汇报都没有');

  const { db: db2, taskId: t2 } = fixture();
  db2.run(`DELETE FROM nodes WHERE task_id=? AND title='格式化层'`, t2);
  const events = [];
  // 脚本：执行器 handoff → 汇报器(node_done) → 汇报器(task_done)
  const r = await orchestrate(db2, { taskId: t2, ...base, report: true, onEvent: (e) => events.push(e),
    makeClient: mk([handoff, reportCall('节点完成'), reportCall('任务完成')]) });
  eq(r.kind, 'complete', '任务完成');
  const reps = db2.all(`SELECT trigger, generated_by FROM reports WHERE task_id=? ORDER BY rowid`, t2);
  eq(reps.map((x) => x.trigger).join(','), 'node_done,task_done', '节点完成一份、任务完成一份');
  eq(events.filter((e) => e.type === 'report').length, 2, '两次 report 事件推出去了（推送摘要）');
  const led = db2.all(`SELECT role, count(*) n FROM usage_ledger WHERE task_id=? GROUP BY role`, t2);
  assert(led.some((x) => x.role === 'reporter' && x.n === 2), '汇报器的账记在 reporter 角色下，与执行器分开');
  db.close(); db2.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. 分类器判定过的消息在汇报里带标注，人显式给的不带');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, userId, plaintext } = fixture();
  // 分类器判的这条直接按 messages 两列的语义落库：标注只看 kind_source / urgency_source，
  // 不看消息是从哪条路径写进来的 —— 这正是这两列存在的意义。
  const tokenId = db.one(`SELECT id FROM tokens LIMIT 1`).id;
  const mid = newId('m'), t = now();
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,
            trust_label,token_id,received_at)
          VALUES (?,?,?,?,'correction','classifier','urgent','classifier','user-authenticated',?,?)`,
  mid, taskId, userId, '别用流式解析了，改成一次性读', tokenId, t);
  // 人显式给的（给了 --kind，分类器根本不参与）
  recordMessage(db, { taskId, body: '记得处理 BOM', kind: 'context', plaintextToken: plaintext });
  // 人显式给的、而且是显式标的紧急 —— 也不算"系统替人判的"
  recordMessage(db, { taskId, body: '这条我看过了，不急', kind: 'context', urgency: 'urgent', plaintextToken: plaintext });

  const client = new LlmClient({ mode: 'fake', fake: makeFake([reportCall('窗口里收到了三条人话')]) });
  const r = await makeReport(db, { taskId, trigger: 'node_done', client });
  const lineOf = (text) => r.body.split('\n').find((l) => l.includes(text)) ?? '';

  const classified = lineOf('别用流式解析了');
  assert(classified.includes('[分类器判定]'),
    'kind_source=classifier 的消息，汇报输出里出现标注（分类器判定需在汇报中标注）');
  assert(classified.includes('类别') && classified.includes('紧急度'),
    '标注说清是哪一项由分类器判的（类别 + 紧急度）');
  assert(classified.includes('（correction）') && classified.includes('别用流式解析了'),
    '标注是加在原有的消息行上的，别的照旧（类别、正文都还在）');
  assert(!lineOf('记得处理 BOM').includes('[分类器判定]'), 'kind_source=explicit 的消息不带这个标注');
  assert(!lineOf('这条我看过了').includes('[分类器判定]'), '人显式标的紧急度也不算分类器判的 —— 标注只跟着两列的来源走');
  assert(r.body.split('\n').filter((l) => l.includes('[分类器判定]')).length === 1, '整个汇报里只有那一条带标注');
  assert(db.one(`SELECT body FROM reports WHERE id=?`, r.id).body.includes('[分类器判定]'),
    '标注进了落库的正文，不只在返回值里（人读到的是 reports.body）');
  eq(r.facts.messages.length, 3, '三条都在窗口内（标注不改变装配口径）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. 现状与历史分开：返工后新旧口径不再混排');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids } = fixture();
  finishNode(db, taskId, ids[0]);
  const t = now();
  // 返工的形状：同一主题先有旧口径，被修正取代，再登记新口径
  db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at,superseded_at)
          VALUES (?,?,NULL,'docs.api.page','page 非正整数返回 400','void','spec','旧口径',0,?,?,?)`, newId('as'), taskId, t, t, t);
  db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at)
          VALUES (?,?,NULL,'docs.api.page','page 不是正整数（含 1.5 / abc）返回 400','active','spec','规格原文',0,?,?)`, newId('as'), taskId, t, t);

  const f = gatherSince(db, taskId, 0);
  const txt = renderFacts(f);
  const nowPart = txt.slice(txt.indexOf('## 现状'), txt.indexOf('## 历史'));
  const histPart = txt.slice(txt.indexOf('## 历史'));
  assert(txt.indexOf('## 现状') === 0 && txt.includes('## 历史'), '正文分两段，现状在前');
  assert(nowPart.includes('page 不是正整数（含 1.5 / abc）'), '现状只给此刻有效的那条口径');
  assert(!nowPart.includes('page 非正整数返回 400'), '被取代的旧口径不出现在现状里 —— 否则读的人判断不出"改没改"');
  assert(histPart.includes('page 非正整数返回 400') && histPart.includes('已被取代，不是现状'), '历史里照列旧口径，但标明它不是现状');
  assert(histPart.includes('本窗口的假设变动'), '窗口内的假设变动归到历史一节');

  // 同一主题有两条并存 → 明说"还没收敛"，不替人挑一条
  db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at)
          VALUES (?,?,NULL,'docs.api.page','page 非正整数返回 400','conflicted','spec','旧口径',0,?,?)`, newId('as'), taskId, t, t);
  assert(renderFacts(gatherSince(db, taskId, 0)).includes('这个口径还没收敛'), '同一主题多条并存 → 现状里点名，让签收人自己看');
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
