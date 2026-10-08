// 回归：修正指令与 DAG 重规划
//
// 跑：node tests/revision.test.mjs
//
// **押注的假设**：模型产出的不是一份新 DAG，而是一份对既有 DAG 的
// 修正，且要同时满足库层护栏与"不把已完成工作无差别作废"。
//
// 破的样子：重规划器把大部分已完成节点标成"作废重做" —— 那等于退化成
// 从零规划，而那是它**已经会做的事**。给一个便宜的出口，
// 就会走那个出口。本文件测的正是堵它的那三道东西：
//
//   ① impact 必须逐一覆盖每个现存节点（作废要一个个说出口）
//   ② 非作废节点不得依赖已作废节点（作废一个就得处理它的下游）
//   ③ 确认门按**花费金额**算作废比例，超阈值转 Ⅲ 级 hard_rule 问题
//   另外：全程只凭审计轨可复盘

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, insertEdge } from '../src/db/db.mjs';
import { recordMessage, pendingMessages } from '../src/core/inbox.mjs';
import { validateRevision } from '../src/agent/replan.mjs';
import {
  nodesForReplan, gateOf, proposeRevision, applyRevision, rejectRevision,
  pendingRevision, thresholdOf, DEFAULT_DISCARD_THRESHOLD, renderDiff,
  floorMicroOf, DEFAULT_DISCARD_FLOOR_USD, DISCARD_FLOOR_KEY,
} from '../src/core/revision.mjs';
import { activeDecisions } from '../src/core/decisions.mjs';
import { setParam } from '../src/core/params.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const hasErr = (errs, sub, m) => (errs.some((e) => e.includes(sub))
  ? ok(`${m}\n         └ ${errs.find((e) => e.includes(sub)).slice(0, 100)}`)
  : bad(m, `错误里没有 ${JSON.stringify(sub)}：${JSON.stringify(errs)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-rev-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

/**
 * 三节点任务：n1 已完成（贵，$3）、n2 已完成（便宜，$0.2，依赖 n1）、n3 待办（依赖 n2）。
 * 花费差异是刻意的：确认门按**金额**算，节点数口径会把"作废一个跑了三小时的
 * 重档节点"和"作废一个五分钟的轻活"算成等重。
 */
function fixture({ money = [3_000_000, 200_000, 0] } = {}) {
  const db = openDb(join(TMP, `${newId('db')}.db`));
  const { userId, plaintext } = ensureOwner(db);
  const taskId = newId('t');
  const t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'M3C fixture','running',?)`,
    taskId, userId, t);
  const constId = newId('c');
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,
            valid_from,recorded_at) VALUES (?,?,1,'做一个 CSV 导出','只动 src/','导出功能可用','[]',?,?)`,
    constId, taskId, t, t);

  const ids = [];
  const specs = [
    ['解析层', 'done'], ['格式化层', 'done'], ['接进 CLI', 'pending'],
  ];
  // ⚠️ 一律先建成 pending —— 库层触发器 `trg_node_done_requires_handoff` 不许
  // "没有已校验交接记录的节点"置 done。夹具必须走真实顺序：先落交接、再置 done。
  // （第一版直接 INSERT status='done'，当场被拦。拦得对：一个能绕过它的夹具，
  //   测出来的东西也就不是真系统的行为。）
  for (const [title] of specs) {
    const id = newId('n');
    db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
            VALUES (?,?,?,?,?,'pending','normal','standard',?)`,
    id, taskId, title, `${title}的规格`, `${title}的验收`, t + ids.length);
    ids.push(id);
  }
  insertEdge(db, ids[1], ids[0], 'depends_on', t);
  insertEdge(db, ids[2], ids[1], 'depends_on', t);

  for (const [i, m] of money.entries()) {
    if (!m) continue;
    db.run(`INSERT INTO usage_ledger (task_id,node_id,role,model_tier,provider,model_id,input_tokens,
              cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,micro_usd,billing,ts)
            VALUES (?,?,'executor','standard','x','x/y',100,0,0,10,0,?,'computed',?)`, taskId, ids[i], m, t);
    db.run(`INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,
              known_issues,downstream_notes,narrative_ref,validated_at,created_at)
            VALUES (?,?,1,?,'契约','[]','',?,?,?)`,
    newId('h'), ids[i], JSON.stringify([{ path: `src/${i}.mjs`, kind: 'source' }]),
    `narratives/${ids[i]}.md`, t, t);
  }
  for (const [i, [, status]] of specs.entries()) {
    if (status === 'done') db.run(`UPDATE nodes SET status='done', finished_at=? WHERE id=?`, t, ids[i]);
  }
  return { db, taskId, ids, userId, plaintext, constId };
}

const mark = (id, m, reason = '理由') => ({ node_id: id, mark: m, reason });

// ═══════════════════════════════════════════════════════════════════════════
section('1. 覆盖性：impact 必须逐一交代每个节点，"没提到"不等于"无关"');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids } = fixture();
  const nodes = nodesForReplan(db, taskId);

  hasErr(validateRevision({ impact: [mark(ids[0], 'unaffected')], rationale: 'x' }, { nodes }),
    'impact 漏了 2 个节点', '漏了节点被拒');
  hasErr(validateRevision({
    impact: [mark(ids[0], 'unaffected'), mark(ids[0], 'obsolete'), mark(ids[1], 'unaffected'),
      mark(ids[2], 'unaffected')], rationale: 'x' }, { nodes }),
  '被标了两次', '同一个节点标两次被拒 —— 两条互相矛盾的交代');
  hasErr(validateRevision({ impact: [mark('n_bogus', 'unaffected')], rationale: 'x' }, { nodes }),
    '不是本任务的节点', '标了不存在的节点被拒');
  hasErr(validateRevision({
    impact: ids.map((i) => ({ node_id: i, mark: 'unaffected', reason: '' })), rationale: 'x' }, { nodes }),
  '缺 reason', '缺理由被拒 —— 每一条影响判断都要说出口');
  hasErr(validateRevision({ impact: ids.map((i) => mark(i, 'unaffected')) }, { nodes }),
    '缺 rationale', '缺整体理由被拒');

  eq(validateRevision({ impact: ids.map((i) => mark(i, 'unaffected')), rationale: 'x' }, { nodes }).length,
    0, '全标无关、理由齐全 → 通过');
  // 新增节点的 rules 与规划器同一条判据 —— quote 必须逐字出现在宪法块里（传 constitution 才核）。
  const constitution = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);
  const withRule = (quote) => ({ impact: ids.map((i) => mark(i, 'unaffected')), rationale: 'x',
    new_nodes: [{ key: 'k', title: '新节点', spec: 's', acceptance: 'a', risk_tier: 'normal', depends_on: [], rules: [{ rule: '按规格做', quote }] }] });
  hasErr(validateRevision(withRule('这一句在宪法块里根本找不到吧'), { nodes, constitution }), '在规划文本里找不到', '新增节点的 rules 引了宪法块里没有的话被拒');
  eq(validateRevision(withRule('这一句在宪法块里根本找不到吧'), { nodes }).filter((e) => /找不到/.test(e)).length, 0, '不传 constitution 就不核（旧调用方式不受影响）');
  const real = String(constitution.goal).slice(0, 12);
  eq(validateRevision(withRule(real), { nodes, constitution }).filter((e) => /找不到/.test(e)).length, 0, '逐字引宪法块原文 → 通过');

  // 修正点名了范围外的路径（更正要测试先行节点改测试文件，重规划只改节点规格 → 越界拒收死循环，人得一轮轮地答）。
  // 只在提示里说"要扩就填 scope_paths"不够；这里改成机械的：每条范围外路径要么进 scope_paths，要么明说不需要改。
  const scoped = { ...constitution, scope: '只改 web/src/App.jsx', scope_paths: JSON.stringify(['web/src/App.jsx']) };
  const all = { impact: ids.map((i) => mark(i, 'unaffected')), rationale: 'x' };
  const t12 = 'Please write the failing test in web/src/App.test.jsx first, then change web/src/App.jsx. App.test.jsx is new.';
  hasErr(validateRevision(all, { nodes, constitution: scoped, messageBody: t12 }), '`web/src/App.test.jsx`', '更正要改范围外的测试文件、修订只改节点 → 拒回，点名那个文件（只写文件名的同一文件不重复点名）');
  eq(validateRevision({ ...all, constitution_patch: { scope_paths: ['web/src/App.jsx', 'web/src/App.test.jsx'] } }, { nodes, constitution: scoped, messageBody: t12 }).length, 0, '扩进 scope_paths → 通过（交人批准由门禁管）');
  eq(validateRevision({ ...all, scope_not_needed: ['web/src/App.test.jsx'] }, { nodes, constitution: scoped, messageBody: t12 }).length, 0, '明说不需要改 → 通过');
  eq(validateRevision(all, { nodes, constitution: scoped, messageBody: 'In verify.mjs run node --test web/ instead.' }).filter((e) => /范围（scope_paths）之外/.test(e)).length, 1, '"In verify.mjs" 是在说要改它 → 照样核');
  eq(validateRevision(all, { nodes, constitution: scoped, messageBody: 'Use node --test importer/*.test.mjs and python worker/notifier.py --once; add @testing-library/react; see https://example.com/a.js; Node.js 22.' }).length, 0, '命令参数、npm 包名、网址、Node.js 都不算路径');
  eq(validateRevision(all, { nodes, constitution: scoped, messageBody: 'Fix web/src/App.jsx.\n\n —— 系统附（不由模型生成）——\n验收命令：node verify.mjs\n失败于 contracts/check.mjs' }).length, 0, '系统附在后面的验收输出不算人点名');
  eq(validateRevision(all, { nodes, constitution: scoped, messageBody: 'also update si-preview.json and package.json' }).length, 0, '本来就不受范围限制的文件（截图说明、依赖清单）不核');
  eq(validateRevision(all, { nodes, constitution: { ...scoped, scope: '.', scope_paths: '[]' }, messageBody: t12 }).length, 0, '范围不执法（抽不出路径）→ 不核');
  eq(validateRevision(all, { nodes, constitution: scoped }).length, 0, '不传修正正文（旧调用方式）→ 不核');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 结构：非作废节点不得依赖已作废节点');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids } = fixture();
  const nodes = nodesForReplan(db, taskId);

  // 作废 n1，却把依赖它的 n2 标成无关 —— 这是"作废一个节点却不管下游"的形状
  hasErr(validateRevision({
    impact: [mark(ids[0], 'obsolete'), mark(ids[1], 'unaffected'), mark(ids[2], 'unaffected')],
    salvage: [{ node_id: ids[0], disposition: 'discard', note: 'x' }], rationale: 'x' }, { nodes }),
  '却依赖已作废的', '作废上游却不管下游 → 被拒');

  // 连坐作废就合法
  eq(validateRevision({
    impact: [mark(ids[0], 'obsolete'), mark(ids[1], 'obsolete'), mark(ids[2], 'obsolete')],
    salvage: [{ node_id: ids[0], disposition: 'discard', note: 'x' },
      { node_id: ids[1], disposition: 'discard', note: 'x' }], rationale: 'x' }, { nodes }).length,
  0, '把下游一起作废 → 通过（要作废就得付连带工作的代价）');

  // 新增节点也不许依赖作废的
  hasErr(validateRevision({
    impact: [mark(ids[0], 'obsolete'), mark(ids[1], 'obsolete'), mark(ids[2], 'obsolete')],
    salvage: [{ node_id: ids[0], disposition: 'discard', note: 'x' },
      { node_id: ids[1], disposition: 'discard', note: 'x' }],
    new_nodes: [{ key: 'k1', title: 'a', spec: 'b', acceptance: 'c', risk_tier: 'normal',
      model_tier: 'standard', depends_on: [ids[0]] }], rationale: 'x' }, { nodes }),
  '依赖了已作废的', '新增节点依赖已作废节点 → 被拒');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 已完成工作的处置必须逐个交代');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids } = fixture();
  const nodes = nodesForReplan(db, taskId);

  hasErr(validateRevision({
    impact: [mark(ids[0], 'unaffected'), mark(ids[1], 'needs_change'), mark(ids[2], 'unaffected')],
    changed_nodes: [{ node_id: ids[1], spec: '新规格' }], rationale: 'x' }, { nodes }),
  'salvage 里没有它', '已完成且受影响，却没交代产物怎么处置 → 被拒');

  hasErr(validateRevision({
    impact: [mark(ids[0], 'unaffected'), mark(ids[1], 'needs_change'), mark(ids[2], 'unaffected')],
    salvage: [{ node_id: ids[1], disposition: 'partial', note: '' }],
    changed_nodes: [{ node_id: ids[1], spec: '新规格' }], rationale: 'x' }, { nodes }),
  '哪部分留', 'partial 却没说清留哪部分 → 被拒');

  hasErr(validateRevision({
    impact: [mark(ids[0], 'unaffected'), mark(ids[1], 'needs_change'), mark(ids[2], 'unaffected')],
    salvage: [{ node_id: ids[1], disposition: 'keep_all', note: 'x' }], rationale: 'x' }, { nodes }),
  'changed_nodes 里没有它', '标了需修改却不说改成什么样 → 被拒（那不叫"需修改"）');

  // 未完成的节点不用填 salvage —— 它没有产物可抢救
  eq(validateRevision({
    impact: [mark(ids[0], 'unaffected'), mark(ids[1], 'unaffected'), mark(ids[2], 'obsolete')],
    rationale: 'x' }, { nodes }).length,
  0, '作废一个**未完成**的节点不需要 salvage');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 确认门：按**花费金额**算，不按节点数');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(DEFAULT_DISCARD_THRESHOLD, 0.30, '默认阈值 30%');
  const { db, taskId, ids } = fixture();          // n1 $3、n2 $0.2
  const nodes = nodesForReplan(db, taskId);
  eq(thresholdOf(db, taskId), 0.30, '没设过就用默认');

  // 作废便宜的那个（$0.2 / $3.2 = 6.3%）→ 不触发
  const cheap = gateOf(db, { taskId, nodes, rev: {
    impact: [mark(ids[0], 'unaffected'), mark(ids[1], 'obsolete'), mark(ids[2], 'obsolete')],
    salvage: [{ node_id: ids[1], disposition: 'discard', note: 'x' }] } });
  eq(cheap.gate, null, `作废便宜节点（${(cheap.ratio * 100).toFixed(1)}%）→ 门不触发，方案直接生效`);

  // 作废贵的那个（$3 / $3.2 = 93.8%）→ 触发。**节点数一样都是 1 个**。
  const pricey = gateOf(db, { taskId, nodes, rev: {
    impact: [mark(ids[0], 'obsolete'), mark(ids[1], 'obsolete'), mark(ids[2], 'obsolete')],
    salvage: [{ node_id: ids[0], disposition: 'discard', note: 'x' },
      { node_id: ids[1], disposition: 'discard', note: 'x' }] } });
  assert(pricey.gate?.includes('要重来的已完成工作占比'),
    `作废贵节点（${(pricey.ratio * 100).toFixed(1)}%）→ 门触发`);
  ok('两次作废的**节点数相同**，结果不同 —— 口径确实是金额不是个数');

  // ⚠️ 曾出现过的洞：模型把 3 个已完成节点
  //    **全标 needs_change**、salvage 全是 keep_all，于是它们统统退回 pending 重做
  //    （$4.22 的活），而当时的门报"作废 0.0%" —— 一份提议重做全部已完成工作的方案，
  //    在门这里看起来毫无风险。**重做和作废花的是同样的钱**，只数作废等于给
  //    "全标 needs_change" 留了一条比"全标 obsolete"更划算的绕行路。
  const redo = gateOf(db, { taskId, nodes, rev: {
    impact: [mark(ids[0], 'needs_change'), mark(ids[1], 'needs_change'), mark(ids[2], 'unaffected')],
    salvage: [{ node_id: ids[0], disposition: 'keep_all', note: 'x' },
      { node_id: ids[1], disposition: 'keep_all', note: 'x' }],
    changed_nodes: [{ node_id: ids[0], spec: '新' }, { node_id: ids[1], spec: '新' }] } });
  eq(redo.discardedMicro, 0, '全标 needs_change → 作废确实是 0');
  eq(redo.redoneMicro, 3_200_000, '但**重做**是 $3.2 —— 已完成节点改了规格就得退回重做');
  assert(redo.gate?.includes('要重来'),
    `门照样触发（${(redo.ratio * 100).toFixed(1)}%）—— 换个标签绕不过去`);
  eq(gateOf(db, { taskId, nodes, rev: { impact: ids.map((i) => mark(i, 'unaffected')) } }).ratio, 0,
    '全标 unaffected 时比例是 0，门不误伤');

  // partial 不计入分子：留了多少没法机械判定，两边算都是编数字
  const part = gateOf(db, { taskId, nodes, rev: {
    impact: [mark(ids[0], 'needs_change'), mark(ids[1], 'unaffected'), mark(ids[2], 'unaffected')],
    salvage: [{ node_id: ids[0], disposition: 'partial', note: '留解析、丢格式化' }] } });
  eq(part.discardedMicro, 0, 'partial 不计入分子');
  eq(part.partialNodes.length, 1, '但 partial 的条数照报 —— 让人自己看，不替人估');

  // 带宪法补丁一律触发，与金额无关
  const consti = gateOf(db, { taskId, nodes, rev: {
    impact: ids.map((i) => mark(i, 'unaffected')),
    constitution_patch: { goal: '改成 JSON 导出' } } });
  assert(consti.gate?.includes('触及宪法层'), '带 constitution_patch → 一律触发门（agent 无权自改宪法块）');
  eq(consti.ratio, 0, '此时作废比例是 0 —— 两个触发器互相独立');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4b. 确认门的金额下限：小任务里比例必然过阈值，钱却不值得打断人');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(DEFAULT_DISCARD_FLOOR_USD, 0.20, '默认下限 $0.20');
  // 典型的形状：一个总花费不到 $1 的任务，同一个文档节点返工两次，
  // 每次占比都过阈值、各触发一次确认门 —— 每次让负责人批的都是几分钱的活。
  const { db, taskId, ids } = fixture({ money: [60_000, 40_000, 0] });   // 已完成共 $0.10
  const nodes = nodesForReplan(db, taskId);
  eq(floorMicroOf(db, taskId), 200_000, '没设过就用默认下限');

  const small = gateOf(db, { taskId, nodes, rev: {
    impact: [mark(ids[0], 'needs_change'), mark(ids[1], 'unaffected'), mark(ids[2], 'unaffected')],
    salvage: [{ node_id: ids[0], disposition: 'keep_all', note: 'x' }],
    changed_nodes: [{ node_id: ids[0], spec: '新' }] } });
  assert(small.ratio > small.threshold, `占比 ${(small.ratio * 100).toFixed(1)}% 照样过阈值`);
  eq(small.gate, null, '但受影响的只有 $0.06，不到下限 → 门不触发，方案直接生效');
  eq(small.belowFloor, true, 'belowFloor 标出来 —— 事后查审计能解释"为什么这次没问我"');
  assert(renderDiff(small, { impact: [], changed_nodes: [{ node_id: ids[0], spec: '新' }] }).includes('不到下限'),
    'diff 里写明"占比过了阈值但金额不到下限" —— 人仍然知情，只是不用批');

  // 下限只管比例这一路：宪法补丁在同样的小金额下照样触发
  const tiny = gateOf(db, { taskId, nodes, rev: {
    impact: ids.map((i) => mark(i, 'unaffected')), constitution_patch: { goal: '改成 JSON' } } });
  assert(tiny.gate?.includes('触及宪法层'), '金额再小，改宪法块也要人批 —— 那是范围问题不是金额问题');

  // 下限可配：设成 0 就是旧行为
  const ownerId = db.one(`SELECT id FROM users ORDER BY created_at LIMIT 1`).id;
  setParam(db, { taskId, key: DISCARD_FLOOR_KEY, value: 0, by: { kind: 'user', id: ownerId }, governance: 'constitutional' });
  eq(floorMicroOf(db, taskId), 0, '下限可按任务改');
  const off = gateOf(db, { taskId, nodes, rev: {
    impact: [mark(ids[0], 'needs_change'), mark(ids[1], 'unaffected'), mark(ids[2], 'unaffected')],
    salvage: [{ node_id: ids[0], disposition: 'keep_all', note: 'x' }],
    changed_nodes: [{ node_id: ids[0], spec: '新' }] } });
  assert(off.gate?.includes('要重来'), '下限设 0 → 回到只看比例的旧行为');

  // 大任务不受影响：金额够得上下限时，比例仍然说了算
  const big = fixture();
  const bigGate = gateOf(big.db, { taskId: big.taskId, nodes: nodesForReplan(big.db, big.taskId), rev: {
    impact: [mark(big.ids[0], 'obsolete'), mark(big.ids[1], 'unaffected'), mark(big.ids[2], 'unaffected')],
    salvage: [{ node_id: big.ids[0], disposition: 'discard', note: 'x' }] } });
  assert(bigGate.gate?.includes('≥ 下限'), '$3 的作废照样触发，理由里写明金额够得上下限');
  big.db.close();
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 应用：作废不删产物、改规格重试归零、新增溯源到那条消息');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids, plaintext, userId } = fixture();
  const m = recordMessage(db, { taskId, body: '导出改成 JSON，不要 CSV', kind: 'correction',
    plaintextToken: plaintext });
  const msg = db.one(`SELECT * FROM messages WHERE id=?`, m.messageId);
  const nodes = nodesForReplan(db, taskId);

  const rev = {
    impact: [mark(ids[0], 'unaffected', '解析层与格式无关'),
      mark(ids[1], 'needs_change', '格式化层要改成 JSON'),
      mark(ids[2], 'unaffected', '接进 CLI 不受影响')],
    salvage: [{ node_id: ids[1], disposition: 'partial', note: '骨架留，序列化部分重写' }],
    changed_nodes: [{ node_id: ids[1], title: 'JSON 格式化层', spec: '输出 JSON' }],
    new_nodes: [{ key: 'k1', title: 'JSON schema 校验', spec: 'x', acceptance: 'y',
      risk_tier: 'normal', model_tier: 'light', depends_on: [ids[1]] }],
    rationale: '格式变了，解析不变',
  };
  eq(validateRevision(rev, { nodes }).length, 0, '这份方案通过校验');

  const prop = proposeRevision(db, { taskId, message: msg, rev, nodes });
  eq(prop.gate, null, '没触发门（partial 不计入，也没带宪法补丁）');
  const r = applyRevision(db, { taskId, revisionId: prop.revisionId, by: 'auto' });

  eq(db.one(`SELECT status FROM nodes WHERE id=?`, ids[1]).status, 'pending',
    '已完成的节点改了规格 → 退回 pending 重做');
  eq(db.one(`SELECT retry_count FROM nodes WHERE id=?`, ids[1]).retry_count, 0,
    '重试次数归零 —— 新规格是一件新活，旧规格下的失败不该算在它头上');
  eq(db.one(`SELECT title FROM nodes WHERE id=?`, ids[1]).title, 'JSON 格式化层', '标题改了');
  assert(db.one(`SELECT id FROM handoffs WHERE node_id=?`, ids[1]),
    '**交接记录还在** —— 产物不删，git 历史保底');

  eq(r.added.length, 1, '新增了 1 个节点');
  const src = db.one(`SELECT to_id FROM edges WHERE from_id=? AND relation='derived_from'`, r.added[0]);
  eq(src.to_id, m.messageId,
    '新节点的出处边指向**那条认证消息** ——"指令必溯至认证消息"');
  eq(pendingMessages(db, taskId).length, 0, '修正被消费');
  eq(db.one(`SELECT status FROM revisions WHERE id=?`, prop.revisionId).status, 'applied', '提案置 applied');

  // 只凭审计轨答得出"这条修正改了什么"
  const a = db.one(`SELECT payload FROM audit_log WHERE target_id=? AND action='revision_applied'`, taskId);
  const p = JSON.parse(a.payload);
  assert(p.added.length === 1 && p.respecced.length === 1 && p.messageId === m.messageId,
    '审计轨里记全了：谁被改、谁被加、因哪条消息');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 作废：节点转 void，产物留着，决策日志记一笔');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids, plaintext } = fixture();
  const m = recordMessage(db, { taskId, body: '不做格式化了', kind: 'correction', plaintextToken: plaintext });
  const msg = db.one(`SELECT * FROM messages WHERE id=?`, m.messageId);
  const nodes = nodesForReplan(db, taskId);
  const rev = {
    impact: [mark(ids[0], 'unaffected', 'x'), mark(ids[1], 'obsolete', '不再需要格式化层'),
      mark(ids[2], 'obsolete', '它依赖格式化层')],
    salvage: [{ node_id: ids[1], disposition: 'discard', note: '整层不要了' }],
    rationale: '砍掉格式化',
  };
  const prop = proposeRevision(db, { taskId, message: msg, rev, nodes });
  // 作废的是便宜那个（$0.2 / $3.2 = 6.3% < 30%）→ **门不触发，方案直接生效**。
  // 这正是"修正仅涉执行层 → diff 推送后直接继续"：
  // 不是所有作废都要惊动人，只有扔掉的**钱**够多才要。
  eq(prop.gate, null, `作废便宜节点（${(prop.summary.ratio * 100).toFixed(1)}%）→ 门不触发，直接生效`);
  applyRevision(db, { taskId, revisionId: prop.revisionId, by: 'auto' });

  eq(db.one(`SELECT status FROM nodes WHERE id=?`, ids[1]).status, 'void', '节点转 void');
  assert(db.one(`SELECT id FROM handoffs WHERE node_id=?`, ids[1]),
    '**产物没删**：交接记录还在，git 历史保底');
  const d = db.one(`SELECT * FROM decisions WHERE node_id=?`, ids[1]);
  assert(d && /因修正/.test(d.summary), '决策日志记了"此路径因修正作废"—— 那就是工程笔记');
  assert(/没有被删除/.test(d.rationale), '理由里写明产物没被删');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. void 的连带影响：任务完成判定不能被作废卡死');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 引入 void 之后，"全做完了吗"若还问 done === total，任何一次作废都会让任务
  // 永远卡在 stalled，而报出来的理由是"依赖成环或有节点停在非终态"——指不到真实原因。
  const { db, taskId, ids } = fixture({ money: [1000, 1000, 0] });
  db.run(`UPDATE nodes SET status='void' WHERE id=?`, ids[2]);
  const r = await orchestrate(db, {
    taskId, workspace: (() => { const d = join(TMP, 'ws1'); mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'R.md'), 'x'); return d; })(),
    narrativeDir: join(TMP, 'nr1'), maxCycles: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([]) }),
  });
  eq(r.kind, 'complete', '2 个 done + 1 个 void → 任务算完成');

  // 全 void 不算完成 —— 那是"这个任务被改没了"
  const b = fixture({ money: [1000, 1000, 0] });
  b.db.run(`UPDATE nodes SET status='void' WHERE task_id=?`, b.taskId);
  const rb = await orchestrate(b.db, {
    taskId: b.taskId, workspace: (() => { const d = join(TMP, 'ws2'); mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'R.md'), 'x'); return d; })(),
    narrativeDir: join(TMP, 'nr2'), maxCycles: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([]) }),
  });
  eq(rb.kind, 'stalled', '全部作废 → stalled，不是 complete');
  assert(/改没了/.test(rb.why), `理由说清了：${rb.why}`);
  db.close(); b.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. 门触发时：Ⅲ 级 hard_rule 问题 + 任务冻结 + 可批可驳');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids, plaintext } = fixture();
  const m = recordMessage(db, { taskId, body: '目标改成 JSON 导出', kind: 'correction', plaintextToken: plaintext });
  const msg = db.one(`SELECT * FROM messages WHERE id=?`, m.messageId);
  const nodes = nodesForReplan(db, taskId);
  const rev = {
    impact: ids.map((i) => mark(i, 'unaffected', 'x')),
    constitution_patch: { goal: '做一个 JSON 导出' },
    rationale: '目标变了',
  };
  const prop = proposeRevision(db, { taskId, message: msg, rev, nodes });
  assert(prop.gate?.includes('触及宪法层'), '触发门');
  const q = db.one(`SELECT * FROM questions WHERE id=?`, prop.questionId);
  eq(q.level, 3, 'Ⅲ 级');
  eq(q.level_source, 'hard_rule', 'level_source=hard_rule —— 状态机定级，不是模型自评');
  eq(q.default_action, null, '无默认动作');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务冻结');
  assert(db.one(`SELECT id FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from'`,
    prop.questionId, m.messageId), '问题的出处边指向那条认证消息');
  assert(/宪法块改动/.test(q.text) && /做一个 JSON 导出/.test(q.text),
    '问题正文里**展示了 diff** ——"不默默换计划"');

  // 编排器见到 proposed 就不往下走
  const r = await orchestrate(db, {
    taskId, workspace: (() => { const d = join(TMP, 'ws3'); mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'R.md'), 'x'); return d; })(),
    narrativeDir: join(TMP, 'nr3'), maxCycles: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([]) }),
  });
  eq(r.kind, 'revision_pending', '编排器停在 revision_pending，不去跑节点');

  // 批准 → 宪法块升版
  const before = db.one(`SELECT version FROM constitutions WHERE task_id=? AND superseded_at IS NULL`, taskId);
  applyRevision(db, { taskId, revisionId: prop.revisionId, by: 'user', userId: 'u' });
  const after = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL`, taskId);
  eq(after.version, before.version + 1, '宪法块升到 v2');
  eq(after.goal, '做一个 JSON 导出', '目标改了');
  const cd = db.one(`SELECT * FROM decisions WHERE task_id=? AND layer='constitutional'`, taskId);
  assert(cd, '记了一条**宪法层**决策 —— layer 这一列的意义就是让"谁动了目标"事后分得开');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. 驳回：计划不动，但修正算处理过了');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids, plaintext } = fixture();
  const m = recordMessage(db, { taskId, body: '全推倒重来', kind: 'correction', plaintextToken: plaintext });
  const msg = db.one(`SELECT * FROM messages WHERE id=?`, m.messageId);
  const nodes = nodesForReplan(db, taskId);
  const prop = proposeRevision(db, { taskId, message: msg, nodes, rev: {
    impact: ids.map((i) => mark(i, 'obsolete', '推倒')),
    salvage: [{ node_id: ids[0], disposition: 'discard', note: 'x' },
      { node_id: ids[1], disposition: 'discard', note: 'x' }],
    rationale: '全推倒' } });
  assert(prop.gate, '推倒重来必然触发门（这正是那个便宜的作弊出口该有的代价）');

  rejectRevision(db, { taskId, revisionId: prop.revisionId, userId: 'u', why: '不同意' });
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, ids[0]).status, 'done', '节点原样不动');
  eq(pendingMessages(db, taskId).length, 0,
    '修正仍被消费 —— 否则下一轮又停在同一处，人得驳回无数次');
  eq(pendingRevision(db, taskId), undefined, '没有待处理提案了');
  eq(db.one(`SELECT status FROM revisions WHERE id=?`, prop.revisionId).status, 'rejected', '提案置 rejected');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('10. 改依赖：护栏②原来只有一个出口，模型曾把它绕了过去');
// ═══════════════════════════════════════════════════════════════════════════
//
// 原来 `changed_nodes` 里没有 `depends_on`，
// 于是"这个节点还要做，只是别再依赖那个被作废的"在 schema 里无法表达。
// 模型把 3 个 pending 节点标 obsolete、再建 3 个一模一样的替身绕了过去，
// 决策日志因此多了三条"此路径因修正作废"的**假记录**。
// 护栏没被违反，它被绕过了 —— 代价记在审计轨上。
{
  const { db, taskId, ids } = fixture();
  const nodes = nodesForReplan(db, taskId);
  const [n1, n2, n3] = ids;

  // 老形状：作废 n1，n2 还想做 → 除了跟着一起作废，无路可走
  hasErr(validateRevision({
    impact: [mark(n1, 'obsolete'), mark(n2, 'needs_change'), mark(n3, 'unaffected')],
    salvage: [{ node_id: n1, disposition: 'discard', note: 'x' },
      { node_id: n2, disposition: 'keep_all', note: 'x' }],
    changed_nodes: [{ node_id: n2, spec: '新规格' }], rationale: 'x' }, { nodes }),
  '却依赖已作废的', '不改依赖 → 照旧被拒（口径没被放宽）');

  // 新出口：把依赖改掉就合法
  eq(validateRevision({
    impact: [mark(n1, 'obsolete'), mark(n2, 'needs_change'), mark(n3, 'unaffected')],
    salvage: [{ node_id: n1, disposition: 'discard', note: 'x' },
      { node_id: n2, disposition: 'keep_all', note: 'x' }],
    changed_nodes: [{ node_id: n2, depends_on: [] }], rationale: 'x' }, { nodes }).length,
  0, '用 changed_nodes.depends_on 把依赖摘掉 → 通过');

  eq(validateRevision({
    impact: [mark(n1, 'unaffected'), mark(n2, 'needs_change'), mark(n3, 'unaffected')],
    salvage: [{ node_id: n2, disposition: 'keep_all', note: 'x' }],
    changed_nodes: [{ node_id: n2, depends_on: [] }], rationale: 'x' }, { nodes }).length,
  0, '只给 depends_on、一个字都不改 → 也算"新内容"（不再把它逼回作废重建）');

  hasErr(validateRevision({
    impact: [mark(n1, 'obsolete'), mark(n2, 'needs_change'), mark(n3, 'unaffected')],
    salvage: [{ node_id: n1, disposition: 'discard', note: 'x' },
      { node_id: n2, disposition: 'keep_all', note: 'x' }],
    changed_nodes: [{ node_id: n2, depends_on: [n1] }], rationale: 'x' }, { nodes }),
  '却依赖已作废的', '改成还是指向作废节点 → 拒（②认的是修正**之后**的依赖）');

  hasErr(validateRevision({
    impact: ids.map((i) => mark(i, i === n2 ? 'needs_change' : 'unaffected')),
    changed_nodes: [{ node_id: n2, depends_on: ['n_不存在'] }], rationale: 'x' }, { nodes }),
  '既不是存活的现存节点', '依赖指向不存在的东西 → 拒');

  hasErr(validateRevision({
    impact: ids.map((i) => mark(i, i === n2 ? 'needs_change' : 'unaffected')),
    changed_nodes: [{ node_id: n2, depends_on: [n2] }], rationale: 'x' }, { nodes }),
  '里有它自己', '依赖自己 → 拒');

  hasErr(validateRevision({
    impact: ids.map((i) => mark(i, 'unaffected')),
    changed_nodes: [{ node_id: n2, spec: '偷偷改' }], rationale: 'x' }, { nodes }),
  '不会出现在给人看的 diff 里', 'changed_nodes 写给一个标了 unaffected 的节点 → 拒（静默改动）');

  // 环：n1 依赖 n3，而 n3 本来就依赖 n2 依赖 n1
  hasErr(validateRevision({
    impact: ids.map((i) => mark(i, i === n1 ? 'needs_change' : 'unaffected')),
    salvage: [{ node_id: n1, disposition: 'keep_all', note: 'x' }],
    changed_nodes: [{ node_id: n1, depends_on: [n3] }], rationale: 'x' }, { nodes }),
  '有环', '改依赖改出一个环 → 拒（允许改依赖却不查环，比不许改更糟）');

  // 依赖可以指向本次新增的节点
  eq(validateRevision({
    impact: ids.map((i) => mark(i, i === n3 ? 'needs_change' : 'unaffected')),
    changed_nodes: [{ node_id: n3, depends_on: ['k_new'] }],
    new_nodes: [{ key: 'k_new', title: 'T', spec: 'S', acceptance: 'A',
      risk_tier: 'normal', model_tier: 'standard', depends_on: [] }],
    rationale: 'x' }, { nodes }).length,
  0, '依赖指向本次新增节点的 key → 通过');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('11. 落库：依赖边是 supersede 不是 delete');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, ids, plaintext } = fixture();
  const [n1, n2, n3] = ids;
  const m = recordMessage(db, { taskId, body: '解析层不做了，格式化层直接读现成文件',
    kind: 'correction', plaintextToken: plaintext });
  const msg = db.one(`SELECT * FROM messages WHERE id=?`, m.messageId);
  const nodes = nodesForReplan(db, taskId);
  const prop = proposeRevision(db, { taskId, message: msg, nodes, rev: {
    impact: [mark(n1, 'obsolete', '不做了'), mark(n2, 'needs_change', '改成读现成文件'),
      mark(n3, 'unaffected', '照旧')],
    salvage: [{ node_id: n1, disposition: 'discard', note: '路径作废' },
      { node_id: n2, disposition: 'partial', note: '格式化逻辑留着，输入源换掉' }],
    changed_nodes: [{ node_id: n2, spec: '从现成文件读', depends_on: [] }],
    rationale: '砍掉解析层' } });
  const r = applyRevision(db, { taskId, revisionId: prop.revisionId,
    by: prop.gate ? 'user' : 'auto', userId: 'u' });

  eq(r.rewired.length, 1, '返回值里报了重挂了几处依赖');
  const after = nodesForReplan(db, taskId).find((n) => n.id === n2);
  eq(after.deps.length, 0, 'n2 现在不依赖任何节点');
  const old = db.all(`SELECT * FROM edges WHERE from_id=? AND relation='depends_on'`, n2);
  eq(old.length, 1, '旧边**还在库里**（只有一条，因为新依赖是空集）');
  assert(old[0].superseded_at !== null,
    '旧边被 supersede、没被 delete —— "这个节点当初依赖谁、什么时候改的"要答得出来');
  eq(db.one(`SELECT count(*) AS n FROM decisions WHERE task_id=? AND summary LIKE '%作废%'`, taskId).n, 1,
    '只有真作废的那一个进了决策日志 —— 改依赖不该被记成"此路径已作废"');

  // 被改规格的节点也要溯到那条消息。原来只有新增节点和作废节点有出处，
  // 被改规格的什么都没有 —— 而重写一个节点的规格**就是一条指令**。
  eq(db.one(`SELECT count(*) AS n FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from'`,
    n2, msg.id).n, 1, '被改规格的节点挂上了 derived_from → 那条认证消息');
  eq(db.one(`SELECT count(*) AS n FROM edges WHERE from_id=? AND relation='derived_from'`, n3).n, 0,
    '没被改的节点不挂 —— 出处边只记真发生过的因果');

  const g = gateOf(db, { taskId, rev: {
    impact: [mark(n1, 'unaffected'), mark(n2, 'needs_change'), mark(n3, 'needs_change')],
    changed_nodes: [{ node_id: n3, spec: '新的' }],
    new_nodes: [{ key: 'k', title: '一个新节点', spec: 's', acceptance: 'a',
      risk_tier: 'normal', model_tier: 'standard', depends_on: [] }],
  }, nodes });
  const diff = renderDiff(g, { impact: g.byId && [mark(n1, 'unaffected'), mark(n2, 'needs_change'),
    mark(n3, 'needs_change')],
  changed_nodes: [{ node_id: n3, spec: '新的' }],
  new_nodes: [{ key: 'k', title: '一个新节点', spec: 's', acceptance: 'a',
    risk_tier: 'normal', model_tier: 'standard', depends_on: [] }],
  rationale: 'x' });
  assert(diff.includes('一个新节点'),
    'diff 里出现新增节点的**标题** —— "新增 1 个"答不了"加了什么"');
  assert(diff.includes('改了规格的未完成节点'),
    'diff 里列出改了规格的未完成节点 —— 它们没花过钱，但计划确实变了');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. 宪法补丁的形状：最危险的一格，原来一条校验都没有');
// ═══════════════════════════════════════════════════════════════════════════
//
// 曾出现过：模型把 constitution_patch
// 交成一个**字符串**，内容是一段 `<parameter name="goal">…</parameter>` 原始文本。
// 三个后果连成一串：门用 Object.keys(字符串).length=402 判非空（凑巧触发，
// 理由是错的）→ renderDiff 打出 402 行每行一个字 → applyRevision 取 patch.goal
// 得 undefined、全部退回旧值，于是**宪法升到 v2 而一字未改**，审计轨还记着改过。
{
  const { db, taskId, ids } = fixture();
  const nodes = nodesForReplan(db, taskId);
  const base = { impact: ids.map((i) => mark(i, 'unaffected')), rationale: 'x' };

  hasErr(validateRevision({ ...base,
    constitution_patch: '\n<parameter name="goal">把四样东西接进来</parameter>' }, { nodes }),
  'constitution_patch 必须是对象',
  '字符串补丁被拒 —— 实际出现过的就是这一份，此前一路畅通到落库');
  hasErr(validateRevision({ ...base, constitution_patch: ['goal'] }, { nodes }),
    'constitution_patch 必须是对象', '数组补丁被拒');
  hasErr(validateRevision({ ...base, constitution_patch: {} }, { nodes }),
    '空对象', '空对象被拒 —— 填了空对象只会白白触发一次门，让人白等一轮');
  hasErr(validateRevision({ ...base, constitution_patch: { goals: '打错字了' } }, { nodes }),
    '不认识的字段', '字段名打错被拒 —— 只有认识的字段会被应用，写别的等于什么都没改');
  hasErr(validateRevision({ ...base, constitution_patch: { goal: '   ' } }, { nodes }),
    '类型不对', '空白字符串被拒');
  hasErr(validateRevision({ ...base, constitution_patch: { constraints: 'a,b' } }, { nodes }),
    '类型不对', 'constraints 给成字符串被拒（应为字符串数组）');
  eq(validateRevision({ ...base,
    constitution_patch: { goal: '新目标', constraints: ['c1'] } }, { nodes }).length, 0,
  '形状正确的补丁通过');
  eq(validateRevision(base, { nodes }).length, 0, '不填补丁当然也通过');

  // 门：形状不对但非空 → 照样触发。校验器该先拦住，万一漏过来宁可多问一次人。
  const gBad = gateOf(db, { taskId, nodes, rev: { ...base, constitution_patch: '一段文本' } });
  assert(gBad.gate?.includes('形状不对'), '形状不对的补丁仍然触发门，且理由说清了是形状不对');
  const gOk = gateOf(db, { taskId, nodes, rev: { ...base, constitution_patch: { goal: 'g' } } });
  assert(gOk.gate?.includes('要改 goal'), '正常补丁的门理由**点名了要改哪个字段**');

  // applyRevision：宁可响亮地失败，也不要静默地什么都没改
  const { db: db2, taskId: t2, ids: i2, plaintext } = fixture();
  const m = recordMessage(db2, { taskId: t2, body: '改目标', kind: 'correction', plaintextToken: plaintext });
  const msg = db2.one(`SELECT * FROM messages WHERE id=?`, m.messageId);
  const n2s = nodesForReplan(db2, t2);
  const prop = proposeRevision(db2, { taskId: t2, message: msg, nodes: n2s, rev: {
    impact: i2.map((i) => mark(i, 'unaffected')), rationale: 'x',
    constitution_patch: '<parameter name="goal">坏形状</parameter>' } });
  assert(prop.gate, '坏补丁进到落库这一步时，门至少是开着的');
  let threw = null;
  try { applyRevision(db2, { taskId: t2, revisionId: prop.revisionId, by: 'user', userId: 'u' }); }
  catch (e) { threw = e; }
  assert(threw && /没有任何会被应用的字段/.test(threw.message),
    'applyRevision 抛错 —— 静默的无操作比报错坏得多：人以为批准的改动生效了，其实什么都没发生');
  eq(db2.one(`SELECT version FROM constitutions WHERE task_id=? AND superseded_at IS NULL`, t2).version, 1,
    '宪法**没有**被升版（事务回滚，不留一个"改了但没改"的 v2）');

  // ── scope_paths 必须跟着契约走（迁移 v17）─────────────────────────────────
  // 漏掉它的下场：改一次 scope 散文就把越界校验的判据悄悄清空，表现是那个任务从此不执法 ——
  // 一个只在"改过契约的任务"上出现、且没有任何报错的洞。所以这里钉两下。
  {
    const f = fixture();
    f.db.run(`UPDATE constitutions SET scope_paths=? WHERE task_id=? AND superseded_at IS NULL`, JSON.stringify(['src/a/']), f.taskId);
    const paths = () => JSON.parse(f.db.one(`SELECT scope_paths FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, f.taskId).scope_paths);
    const apply = (patch) => {
      const mm = recordMessage(f.db, { taskId: f.taskId, body: '改契约', kind: 'correction', plaintextToken: f.plaintext });
      const mg = f.db.one(`SELECT * FROM messages WHERE id=?`, mm.messageId);
      const pr = proposeRevision(f.db, { taskId: f.taskId, message: mg, nodes: nodesForReplan(f.db, f.taskId),
        rev: { impact: f.ids.map((i) => mark(i, 'unaffected')), rationale: 'x', constitution_patch: patch } });
      applyRevision(f.db, { taskId: f.taskId, revisionId: pr.revisionId, by: 'user', userId: 'u' });
    };
    apply({ scope: '换一段散文' });
    eq(JSON.stringify(paths()), JSON.stringify(['src/a/']), '**只改 scope 散文 → 判据原样沿用**（漏了这一条，越界校验会被静默关掉）');
    apply({ scope_paths: [' src//b/ ', 'src/b/'] });
    eq(JSON.stringify(paths()), JSON.stringify(['src/b/']), '显式改 scope_paths → 换成新的，并且归一化过');
    f.db.close();
  }
  // ── 批准计划变更时留一句保留意见 ──────────────────────────────────────────
  // 负责人想留一句「下限截到 1 那条……这条先别当硬规则写进宪法」，而页面只有批 / 驳两个按钮，
  // 他只能改口「不值得为这一条卡住正题 —— 批」。
  // **那不是他改主意，是没地方放那句话。**
  {
    const f = fixture();
    const mm = recordMessage(f.db, { taskId: f.taskId, body: 'size 超上限时截到上限返回 200', kind: 'correction', plaintextToken: f.plaintext });
    const mg = f.db.one(`SELECT * FROM messages WHERE id=?`, mm.messageId);
    const pr = proposeRevision(f.db, { taskId: f.taskId, message: mg, nodes: nodesForReplan(f.db, f.taskId),
      rev: { impact: f.ids.map((i) => mark(i, 'unaffected')), rationale: 'x', constitution_patch: { definition_of_done: '超上限截断；小于 1 按 1 处理' } } });
    assert(pr.gate, '改宪法 → 触发确认门');
    assert(/保留：/.test(f.db.one(`SELECT text FROM questions WHERE id=?`, pr.questionId).text), '事项正文上写明了有这个出路');
    const resv = '下限截到 1 那条是重规划器自己推的，不是产品原话；他没明说之前别当硬规则。';
    applyRevision(f.db, { taskId: f.taskId, revisionId: pr.revisionId, by: 'user', userId: f.userId ?? 'u', reservation: resv });

    const list = activeDecisions(f.db, { projectId: null, taskId: f.taskId });
    const got = list.filter((d) => d.reservation);
    eq(got.length, 1, '保留意见进了约定清单');
    assert(got[0].statement.includes('不是产品原话'), '原话原样记下来');
    // **这条修法诚实的限度**：那份变更照样生效了，保留意见挡不住这一轮
    eq(f.db.one(`SELECT status FROM revisions WHERE id=?`, pr.revisionId).status, 'applied', '**变更照样应用了** —— 保留意见买不到"挡住"');
    assert(f.db.one(`SELECT definition_of_done FROM constitutions WHERE task_id=? AND superseded_at IS NULL`, f.taskId).definition_of_done.includes('小于 1 按 1'),
      '**他明说"先别写进宪法"的那一条，还是写进宪法了** —— 保留意见只记录、不拦截，将来要不要做成能拦的，看这个数字');
    assert(JSON.parse(f.db.one(`SELECT payload FROM audit_log WHERE action='revision_applied' AND target_id=? ORDER BY id DESC LIMIT 1`, f.taskId).payload).reservation,
      '审计里数得出来（"记了几条保留意见、其中几条后来真被回头改了"是将来要量的数）');

    // 清单里原来只有"人写的那条指令"，**契约被改成了什么没有条目** ——
    // 于是"它自己顺手加的那一条"已经生效，后来的人却只能从一条明确标着"不是约定"的保留意见里
    // 间接得知它存在。
    const byPatch = list.filter((d) => /本任务契约的完成定义/.test(d.subject));
    eq(byPatch.length, 1, '补丁的**实际内容**也进了清单，不只是人写的那句指令');
    assert(byPatch[0].statement.includes('小于 1 按 1'), '**那条它自己顺手加的规则，在清单上查得到**');
    eq(byPatch[0].reservation, false, '它是一条真约定，不是保留意见');
    f.db.close();
  }
  db.close(); db2.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('13. 已完成的任务仍然接受修正：不消费的消息不该悄悄躺着');
// ═══════════════════════════════════════════════════════════════════════════
//
// 原来 orchestrate 的 done 检查排在 ⓪′ 之前：say 把修正写进库、run 看到 done 直接
// 退出，消息永远不被消费，没有任何报错。同一个"每一步都成功、整体什么都没发生"的形状。
{
  const { db, taskId, ids, plaintext } = fixture();
  // 把第三个节点也做完，任务置 done
  db.run(`INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,known_issues,
            downstream_notes,narrative_ref,validated_at,created_at) VALUES (?,?,1,'[]','c','[]','',?,?,?)`,
  newId('h'), ids[2], `narratives/${ids[2]}.md`, now(), now());
  db.run(`UPDATE nodes SET status='done', finished_at=? WHERE id=?`, now(), ids[2]);
  db.run(`UPDATE tasks SET status='done' WHERE id=?`, taskId);

  // 没有修正 → 照旧"已完成"，一次模型都不调
  const r0 = await orchestrate(db, { taskId, workspace: TMP, narrativeDir: join(TMP, 'nar13'),
    maxCycles: 1, commit: false, verify: false,
    makeClient: () => { throw new Error('done 任务无修正时不该调模型'); } });
  eq(r0.kind, 'complete', 'done 且无修正 → complete');
  eq(r0.already, true, '…而且标明是"本来就完成了"');

  // 发一条修正：只加一个新节点，不动已完成的 → 门不开 → 自动生效 → 任务重开
  const m = recordMessage(db, { taskId, body: '再加一步：把导出结果压成 zip', kind: 'correction', plaintextToken: plaintext });
  const rev = {
    impact: ids.map((i) => mark(i, 'unaffected', '照旧')),
    new_nodes: [{ key: 'zip', title: '压 zip', spec: 's', acceptance: 'a',
      risk_tier: 'low', model_tier: 'light', depends_on: [] }],
    rationale: '纯加一步',
  };
  const script = [{ stopReason: 'tool_call', usage: {},
    content: [{ type: 'tool_call', id: 'r', name: 'submit_revision', args: rev }] }];
  const events = [];
  const r1 = await orchestrate(db, { taskId, workspace: TMP, narrativeDir: join(TMP, 'nar13'),
    maxCycles: 1, commit: false, verify: false, onEvent: (e) => events.push(e.type),
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(script) }) });
  assert(events.includes('revision_applied'), 'done 任务上的修正被消费并自动生效（revision_applied 事件发出）');
  eq(db.one(`SELECT count(*) AS n FROM nodes WHERE task_id=?`, taskId).n, 4, '新节点落库');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'running', '任务从 done 重开为 running');
  eq(pendingMessages(db, taskId).length, 0, '那条修正被消费了 —— 不再悄悄躺在收件箱里');
  assert(r1.kind !== 'complete' || !r1.already, '这一轮不再是"本来就完成了"');
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
