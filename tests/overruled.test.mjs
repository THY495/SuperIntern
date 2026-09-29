// 裁定"以新为准"之后，作废的契约条款要让那个任务的执行方知道
//
// 跑：node tests/overruled.test.mjs
//
// 病：裁定若只改登记表，作废之后旧条款从执行器的"已定的约定"清单里**消失**，可它还写在那个任务的
// 契约里（规则经 foldRules 折进了完成定义），而契约优先 —— 执行器看到的是一份没有异议的契约，
// 照着作废的规则做（静默误读），签收时才发现、打回返工。
//
// 修法：契约原文**不改**；把"此条已由某人在事项 Q（某日）判作废，以新的说法为准，
// 不必再问"挂在执行器 / 规划器 / 重规划器的上下文里；**不给人另挂任何事项**。只追契约来源的决定。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { record, recordFromContract, activeDecisions, overruledContractRules, renderOverruled, voidOne } from '../src/core/decisions.mjs';
import { raiseDecisionConflict } from '../src/core/decision-check.mjs';
import { assembleExecutor } from '../src/context/assemble.mjs';
import { plan } from '../src/agent/planner.mjs';
import { replan } from '../src/agent/replan.mjs';
import { nodesForReplan } from '../src/core/revision.mjs';
import { taskDetail } from '../src/web/server.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-ovr-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const RULE = 'size 超出 1..100 时返回 400 BAD_SIZE';
/** 一个项目，#1 分页接口（契约里有 size 那条规则、未合并），#2 前端列表。 */
function fixture() {
  const db = openDb(join(TMP, `${newId('db')}.db`));
  const { userId, plaintext } = ensureOwner(db);
  const t = now();
  const pj = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,goal,done_definition,created_at)
          VALUES (?,?,'订单服务','',?,?,'base','src','active','g','d',?)`, pj, userId, `/r/${pj}`, `b/${pj}`, t);
  const mk = (order, title) => {
    const id = newId('t');
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,?,'running',?,?,?)`, id, userId, title, t, pj, order);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
            VALUES (?,?,1,?,'只动 server/',?,'[]',?,?)`, newId('c'), id, title, `接口可用；${RULE}`, t, t);
    return id;
  };
  const t1 = mk(1, '分页接口'), t2 = mk(2, '前端列表');
  const n1 = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'参数校验',?,'node --test','pending','normal','standard',?)`, n1, t1, `校验 size；${RULE}`, t);
  const ids = recordFromContract(db, { taskId: t1, spec: { title: '分页接口', rules: [{ rule: RULE, quote: 'size 越界要报错' }] }, userId, at: t });
  return { db, userId, plaintext, pj, t1, t2, n1, did: ids[0] };
}
/** 从 #2 的一句话撞上 #1 契约里的那条，走真的冲突事项 + 真的答复。 */
function overrule(f, verdict = '以新为准') {
  const d = f.db.one(`SELECT * FROM decision_registry WHERE id=?`, f.did);
  const r = raiseDecisionConflict(f.db, { taskId: f.t2, entry: 'revision', by: f.userId, at: now(),
    group: [{ decision: d, hit: { quote: 'size 越界一律截到 100，不报错', why: '与返回 400 正面冲突', confidence: 0.95 } }] });
  recordAnswer(f.db, { questionId: r.questionId, body: verdict, plaintextToken: f.plaintext });
  return r.questionId;
}
const capture = () => {
  const seen = [];
  const c = new LlmClient({ mode: 'fake', fake: makeFake([new Error('测试到此为止')]) });
  const orig = c.complete.bind(c);
  c.complete = (canon) => { seen.push(canon); return orig(canon); };
  return { c, seen, text: () => JSON.stringify(seen[0] ?? {}) };
};

// ═══════════════════════════════════════════════════════════════════════════
section('1 · 以新为准 → 那个任务的契约旁边挂上带效力的标注；契约原文一字不改');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  const before = f.db.one(`SELECT * FROM constitutions WHERE task_id=?`, f.t1);
  const qBefore = f.db.one(`SELECT count(*) n FROM questions WHERE task_id=?`, f.t1).n;
  const qid = overrule(f);

  eq(activeDecisions(f.db, { projectId: f.pj }).some((d) => d.id === f.did), false, '（前提）那条规则从有效清单里消失了 —— 病就在这里');
  const ov = overruledContractRules(f.db, f.t1);
  eq(ov.length, 1, '#1 的契约里有 1 条被判作废');
  eq(ov[0].questionId, qid, '出处指向那个人亲手答的事项');
  eq(ov[0].by, f.userId, '记得是谁判的');
  assert(/截到 100/.test(ov[0].quote ?? ''), '记得新的说法是什么');
  eq(overruledContractRules(f.db, f.t2).length, 0, '只挂在契约里真写着这条的任务上（#2 没有）');

  const after = f.db.one(`SELECT * FROM constitutions WHERE task_id=?`, f.t1);
  eq(after.id, before.id, '契约没有出新版本');
  eq(after.definition_of_done, before.definition_of_done, '契约原文一字不改 —— "以新为准"授权的是作废旧的，不是替人改契约');
  eq(f.db.one(`SELECT count(*) n FROM questions WHERE task_id=?`, f.t1).n, qBefore, '**#1 上没有多出任何事项** —— 人对这一条已经表过态了');
  const a = f.db.one(`SELECT payload FROM audit_log WHERE action='contract_rule_overruled' AND target_id=?`, f.t1);
  assert(!!a && JSON.parse(a.payload).merged === false, '记了一笔"哪个任务受了影响、当时没合并" —— 下一跑数得出这条修法碰过几个任务');

  const txt = renderOverruled(f.db, ov);
  assert(txt.includes(RULE), '标注里有被作废的原文');
  assert(/判作废/.test(txt) && /不必再问/.test(txt), '标注带裁定的效力："判作废……不必再问"');
  assert(/结构矛盾/.test(txt) && /说不清该怎么做/.test(txt), '也写明了唯一该问的情形：新说法落到这一步上说不清怎么做');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2 · 接线：执行器、规划器、重规划器的输入里真的有这一段（走真函数，不是只测渲染）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  const sysBefore = assembleExecutor(f.db, { taskId: f.t1, nodeId: f.n1, tier: 'standard', vendorId: 'fake' }).system;
  assert(!/判作废/.test(sysBefore), '（对照）裁定之前执行器上下文里没有这一段');
  overrule(f);
  const sys = assembleExecutor(f.db, { taskId: f.t1, nodeId: f.n1, tier: 'standard', vendorId: 'fake' }).system;
  assert(/契约里已被人判作废的条目/.test(sys) && sys.includes(RULE), '执行器：系统提示里挂着那条被判作废的条款');
  assert(/截到 100/.test(sys), '…以及新的说法');

  const constitution = f.db.one(`SELECT * FROM constitutions WHERE task_id=?`, f.t1);
  const p = capture();
  try { await plan(f.db, { client: p.c, taskId: f.t1, constitution, maxAttempts: 1 }); } catch { /* 脚本只放了一个错误，到这里就够了 */ }
  assert(/契约里已被人判作废的条目/.test(p.text()), '规划器：输入里有这一段 —— 否则它会把作废的规则原样切进节点规格');

  const r = capture();
  const msg = { id: 'm_x', body: '补一个 total 字段', trust_label: 'user-authenticated' };
  try { await replan(f.db, { client: r.c, taskId: f.t1, constitution, message: msg, nodes: nodesForReplan(f.db, f.t1), maxAttempts: 1 }); } catch { /* 同上 */ }
  assert(/契约里已被人判作废的条目/.test(r.text()), '重规划器：输入里也有');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3 · 不该挂的情形');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  overrule(f, '以旧为准');
  eq(overruledContractRules(f.db, f.t1).length, 0, '以旧为准：什么都不挂');
  f.db.close();
}
{
  // 契约本身改过（新条目 supersedes 旧条目）：新条目就在契约里，不是"写着但作废了"
  const f = fixture();
  record(f.db, { projectId: f.pj, taskId: f.t1, subject: '分页接口｜行为规则', statement: 'size 越界截到 100',
    sourceKind: 'contract', decidedBy: f.userId, supersedes: f.did });
  eq(overruledContractRules(f.db, f.t1).length, 0, '被新条目取代的不算');
  f.db.close();
}
{
  // 答复来源的决定被作废：它可能被别的契约抄过，但抄没抄只能从散文里猜 —— 明说不追
  const f = fixture();
  const ans = record(f.db, { projectId: f.pj, taskId: f.t1, subject: '错误码', statement: '错误码用 ERR_ 前缀', sourceKind: 'question', decidedBy: f.userId });
  voidOne(f.db, { id: ans, by: f.userId, reason: '手工' });
  eq(overruledContractRules(f.db, f.t1).length, 0, '只追契约来源的');
  f.db.close();
}
{
  // 人手工作废契约条款（cli decisions void）：也是人拍的板，照样挂，只是没有事项可指
  const f = fixture();
  voidOne(f.db, { id: f.did, by: f.userId, reason: '人工作废' });
  const ov = overruledContractRules(f.db, f.t1);
  eq(ov.length === 1 && ov[0].questionId, null, '手工作废的也挂，出处写"手工"');
  assert(/手工/.test(renderOverruled(f.db, ov)), '标注说得出来是手工作废的');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3b · 重做：契约条款的登记与作废标注跟着契约走；scope_paths 不丢');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { redoProjectTask } = await import('../src/core/lifecycle.mjs');
  const f = fixture();
  f.db.run(`UPDATE constitutions SET scope_paths=? WHERE task_id=?`, JSON.stringify(['server/', 'shared/contract.mjs']), f.t1);
  recordFromContract(f.db, { taskId: f.t1, spec: { title: '分页接口', scope: '只动 server/' }, userId: f.userId });   // 范围那一行
  overrule(f);
  f.db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, f.t1);
  const r = redoProjectTask(f.db, { projectId: f.pj, userId: f.userId, taskId: f.t1 });
  const nt = r.newTaskId;
  eq(f.db.one(`SELECT scope_paths FROM constitutions WHERE task_id=?`, nt).scope_paths, JSON.stringify(['server/', 'shared/contract.mjs']),
    '新任务的可动路径（判据）原样带过去 —— 漏了它越界判据就是空的，悄悄退回散文启发式');
  const ov = overruledContractRules(f.db, nt);
  eq(ov.length, 1, '被判作废的那条条款跟到了新任务上，标注照挂');
  eq(ov[0]?.questionId != null, true, '…裁定出处原样保留');
  eq(overruledContractRules(f.db, f.t1).length, 0, '旧任务页上不会冒出"手工作废"的假标注（旧的范围行是被新任务那一行取代的）');
  const act = activeDecisions(f.db, { projectId: f.pj }).filter((d) => /改动范围/.test(d.subject));
  eq(act.length, 1, '范围那一行在有效清单里只剩新任务的，不再与旧任务的并存成重复');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4 · 任务页：签收人对着契约原文看产物，看得到这一段');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture();
  eq(taskDetail(f.db, f.t1).constitution.overruled.length, 0, '裁定之前没有');
  overrule(f);
  const o = taskDetail(f.db, f.t1).constitution.overruled;
  eq(o.length, 1, '任务详情里带着被判作废的那一条');
  eq(o[0].viaQuestion, true, '…标明是在冲突事项里判的');
  assert(!('questionId' in o[0]), '不把内部编号送到页面上');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5 · 执行器看得到任务级验收命令（原样），含回归义务');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 例：契约是裸 `pytest`，执行器自测用 `python -m pytest`，两边导入路径不同 —— 它绿、门挂。
  const { setParam } = await import('../src/core/params.mjs');
  const f = fixture();
  const sys0 = assembleExecutor(f.db, { taskId: f.t1, nodeId: f.n1, tier: 'standard', vendorId: 'fake' }).system;
  assert(!sys0.includes('## 任务级验收'), '没有验收命令就不写这一段');
  setParam(f.db, { taskId: f.t1, key: 'task.verify_command', value: ['pytest'], by: { kind: 'user', id: f.userId }, governance: 'constitutional' });
  setParam(f.db, { taskId: f.t1, key: 'task.verify_extra', value: [['node', 'a.test.mjs']], by: { kind: 'user', id: f.userId }, governance: 'constitutional' });
  const sys = assembleExecutor(f.db, { taskId: f.t1, nodeId: f.n1, tier: 'standard', vendorId: 'fake' }).system;
  assert(sys.includes('## 任务级验收') && sys.includes('- `pytest`'), '原样命令写进了执行器的稳定段');
  assert(sys.includes('- `node a.test.mjs`'), '前面任务的回归命令也在');
  assert(/别换成自以为等价的写法/.test(sys), '说清要跑原样命令');
  f.db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
