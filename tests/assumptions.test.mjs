// 假设的认识论轴：把"查得了"与"查不了"分开，把"选择"赶出假设表
//
// 跑：node tests/assumptions.test.mjs
//
// 依据：实测记录
// 5 次真实执行，提问 0 次、假设 21 条。人工标注这 21 条之后：
//   13 条本来就该去查证（其中 2 条 agent 已经知道答案）
//    4 条是验不了的披露
//    4 条才是真的"我替人做了个决定"
// 假设表被当成备注栏用，提问机制因为有这个免费出口从未被触发。
//
// ⚠️ 第 3 节把那 21 条真实假设连同人工标签当作回归夹具。它测的**不是**判据
// 能不能复现标签（两轴模型是看着这份数据拟合的，同数据上满分不算分），
// 而是：判据在这 21 条真实输入上不崩、不误伤、且拦住该拦的那几条。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { validateAssumptions, classifyAssumption, validateHandoff, persistHandoff } from '../src/agent/executor.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-as-'));
const one = (over) => validateAssumptions([{ subject_key: 'k', statement: 's', ...over }]);

// ═══════════════════════════════════════════════════════════════════════════
section('1. 三条出路：去验 / 合法假设 / 这是选择');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ① 查过之后没有出处 → 这是**选择**，照样记，但强制披露、不阻塞。
  //
  // ⚠️ 上一版这里是硬拒 + 强制路由去 raise_question。
  // 实测证明那条规则从未生效：模型不照做，而是换标签绕过
  // （拿"测试没覆盖 + 全绿"当 command 凭据）。它把双轴压成单轴——凡查不了的都得问人，
  // 不看后果——正是原判据判错四条的那个错，只是换了方向。
  eq(one({ verified_against: 'settled_by_me',
    verification: 'grep 过 policy.mjs / DECISIONS.md / README，均无规定；我选静默降级为 {}，'
      + '选错的代价是非法入参不报错、错误往下游传' }).length, 0,
  'settled_by_me 放行 —— 给"这是个选择"一个准确又不挨罚的格子，绕行就没有动机了');
  const choice = classifyAssumption({ verified_against: 'settled_by_me', verification: '查过，无出处' });
  eq(choice.status, 'active', 'settled_by_me 不是 confirmed —— 选择没有真值，谈不上"查证过"');
  eq(choice.mustDisclose, true, 'settled_by_me **强制披露且不由模型自选** —— 它最容易被写成"顺手就定了"');

  // 老取值：重定向，不静默收下一个语义已变的标签
  const legacy = one({ verified_against: 'none', verification: '这是个架构取舍' });
  assert(legacy.length === 1 && legacy[0].includes('settled_by_me'),
    'verified_against=none 已废弃 → 指向新落点 settled_by_me，而不是"你不该记这条"');
  assert(legacy[0].includes('raise_question'),
    '同时说清什么才该走 raise_question：不可逆、对外承诺、规格自相矛盾');

  // ② 有真相源但此刻够不着 → 正当假设
  eq(one({ verified_against: 'blocked',
    verification: '要真连一次 openai-responses 抓流才能确认，本任务禁网禁 key' }).length, 0,
  'blocked（缺 key / 禁网 / 太贵）是**正当**假设，放行');

  // ③ 只能对着自己造的东西验 → 循环论证，放行但后面会被强制披露
  eq(one({ verified_against: 'own_artifact',
    verification: '读 src/llm/_fixtures/stream/anthropic-messages.sse.txt 的字节' }).length, 0,
  'own_artifact 放行 —— 循环论证不是造假，但也不算查证过');

  // ④ 查得了 → 必须给出具体凭据
  eq(one({ verified_against: 'command', verification: '跑了 `git diff`，exit=0，只动两处 import' }).length, 0,
    '查得了且给出了具体凭据 → 放行');

  // 凭据弱**不阻塞** —— 它只是软信号，走披露通道不走阻塞通道。
  // 第一版把它做成拒绝，立刻误伤了一条正当的文档引用，而误伤方向正是本次最该避免的。
  const vague = { subject_key: 'k', statement: 's', verified_against: 'spec', verification: '规范里应该是这么写的' };
  eq(validateAssumptions([vague]).length, 0, '凭据弱**不拒绝** —— 启发式不该挂在阻塞路径上');
  const c1 = classifyAssumption(vague);
  eq(c1.status, 'active', '凭据弱 → 不认作 confirmed，仍是悬着的假设');
  eq(c1.mustDisclose, true, '凭据弱 → 强制披露："我觉得应该是"不能冒充"我查过"，但代价是被看见而不是被拦');
  const c2 = classifyAssumption({ verified_against: 'vendor_docs', verification: 'Anthropic 文档 streaming 一节：message_stop' });
  eq(c2.status, 'confirmed', '像样的文档引用被认作查证过 —— 这一条是上一版误伤的那种');

  // 缺字段
  assert(one({ verification: 'x' })[0].includes('缺 verified_against'), '缺 verified_against → 拒');
  assert(one({ verified_against: 'command' })[0].includes('缺 verification'), '缺 verification → 拒');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 落库：查证过的降级为 confirmed，循环验证的强制披露');
// ═══════════════════════════════════════════════════════════════════════════
{
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), n1 = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'x','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,created_at)
          VALUES (?,?,'n','s','a','pending',?)`, n1, taskId, t);

  persistHandoff(db, { taskId, nodeId: n1, narrativeRef: 'n.md', args: {
    artifacts: [{ path: 'a.mjs' }], interface_contract: 'c', acceptance_evidence: 'e',
    assumptions: [
      { subject_key: 'sse.unknown.field', statement: '未知字段忽略',
        verified_against: 'spec', verification: 'SSE 规范 §9.2.6 原文：ignore the field' },
      { subject_key: 'wire.lineending.gemini', statement: 'Gemini 用 CRLF',
        verified_against: 'own_artifact', verification: '读自己造的 gemini-streamgenerate.txt' },
      { subject_key: 'wire.responses.event', statement: '真实接口上还会多发 event: 行',
        verified_against: 'blocked', verification: '禁网禁 key，抓不到真流' },
    ],
  } });

  const rows = Object.fromEntries(db.all(`SELECT * FROM assumptions WHERE task_id=?`, taskId)
    .map((r) => [r.subject_key, r]));
  eq(rows['sse.unknown.field'].status, 'confirmed',
    '对着规范查证过的入表即 confirmed —— 它不再是一条悬着的假设');
  eq(rows['wire.lineending.gemini'].status, 'active', '循环验证的仍是 active');
  eq(rows['wire.responses.event'].status, 'active', '够不着的仍是 active');
  eq(rows['wire.lineending.gemini'].must_disclose, 1,
    '循环验证**强制**披露，不由模型自选 —— 对着自己的构造物验出来的结论，人必须看见');
  eq(rows['sse.unknown.field'].must_disclose, 0, '真查证过的不强制披露');
  assert(rows['sse.unknown.field'].verification.includes('§9.2.6'), '凭据原样入库，可复盘');

  // 活跃假设摘要瘦身：这正是改动的意义
  eq(db.one(`SELECT count(*) AS n FROM assumptions WHERE task_id=? AND status='active'`, taskId).n, 2,
    '3 条里只有 2 条留在活跃集 —— 登记表不再是备注栏');

  // 冲突优先于 confirmed
  persistHandoff(db, { taskId, nodeId: n1, narrativeRef: 'n2.md', args: {
    artifacts: [{ path: 'a.mjs' }], interface_contract: 'c', acceptance_evidence: 'e',
    assumptions: [{ subject_key: 'wire.responses.event', statement: '真实接口上不会多发',
      verified_against: 'spec', verification: '文档第4.1节明写不发' }],
  } });
  // ⚠️ 按 rowid 取最新，**不能**按 recorded_at：两次写入常落在同一毫秒，
  //    同值排序在 SQLite 里顺序不定，断言会随机翻面。同一个坑别处也踩过
  //    （readyNodes 排序、规划器同批节点的 created_at）。
  //    结论：`recorded_at` 是时间不是顺序，凡要"最新一条"都得带一个唯一列兜底。
  eq(db.one(`SELECT status FROM assumptions WHERE subject_key=? ORDER BY rowid DESC LIMIT 1`,
    'wire.responses.event').status, 'conflicted',
  '撞车就是 conflicted，哪怕新的一条自称查证过 —— 两条互相矛盾的"已验证"更值得看');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 回归夹具：21 条真实假设 + 人工标签');
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 这不是在证明判据准。两轴模型是看着这份数据拟合出来的，同数据上满分是必然的。
// 这里只钉三件事：判据在真实输入上不崩、该进活跃集的进、该被看见的被看见。
//
// ⚠️ 本节在 settled_by_me 落地后**换了断言对象**。上一版断言的是"人标 A 的被拦下、
// 指向 raise_question"。那个契约已经作废：轴 1 现在**一条都不拦**，它只决定
// 进不进活跃集、要不要强制披露；问不问是轴 2 的事，由执行器按后果自己判
// （实测：P0~P2 不问、P3 自己提 Ⅲ 级问题）。
{
  // subject_key → [人标, 判据该给的 verified_against]
  const LABELED = [
    ['assertion.counting', 'C', 'command'],
    ['client.stream.wiring', 'A', 'settled_by_me'],
    ['fixture.dir.location', 'B', 'settled_by_me'],   // 是选择，但爆炸半径低
    ['fixture.path.resolution', 'C', 'command'],
    ['fixture.provenance', 'B!', 'blocked'],
    ['fixture.scenario', 'B!', 'command'],
    ['json.array.top_level', 'C', 'command'],
    ['sse.line.terminator', 'C', 'spec'],
    ['sse.unknown.field', 'C', 'spec'],
    ['stream.accumulator.input_shape', 'A', 'settled_by_me'],
    ['stream.error.taxonomy', 'A', 'settled_by_me'],
    ['stream.termination.anthropic', 'C', 'vendor_docs'],
    ['test.mjs.imports.unchanged', 'C', 'command'],
    ['wire.gemini.toolargs.fragmentation', 'C', 'repo_findings'],
    ['wire.lineending.gemini', 'B!', 'own_artifact'],
  ];
  const EVIDENCE = { command: '跑了 `node spikes/02-llm/test.mjs`，exit=0，PASS=160',
    spec: 'SSE 规范 §9.2.6 原文', vendor_docs: '厂商文档 streaming 一节',
    repo_findings: 'spikes/02-llm/FINDINGS.md:65 已有实测结论',
    own_artifact: '读 src/llm/_fixtures/stream/ 下自己造的样本',
    blocked: '本任务禁网禁 key，抓不到真流',
    settled_by_me: 'grep 过 spikes/02-llm/ 与 FINDINGS.md，无任何规定；我选了 X，选错的代价是 Y' };

  const built = LABELED.map(([k, , src]) => ({
    subject_key: k, statement: `（${k} 的陈述）`, verified_against: src, verification: EVIDENCE[src] }));

  eq(validateAssumptions(built).length, 0,
    '15 条真实假设**一条都不被拦** —— 轴 1 是分类器不是闸门，字段齐了就放行');

  const cls = Object.fromEntries(LABELED.map(([k], i) => [k, classifyAssumption(built[i])]));

  // ⚠️ 断言按 **verified_against（轴 1）** 分组，不按人标分组。人标是"该不该问人"，
  // 那是轴 2；本函数只管轴 1。头一版按人标断言，立刻在两条上翻车：
  // `fixture.scenario` 人标 B! 但源是 command 且凭据具体 —— 轴 1 上它就该是 confirmed，
  // B! 那层意思住在轴 2。**混着断言等于又把两个轴压回一个。**
  const bySource = (s) => LABELED.filter(([, , src]) => src === s).map(([k]) => k);

  for (const k of [...bySource('command'), ...bySource('spec'),
    ...bySource('vendor_docs'), ...bySource('repo_findings')]) {
    eq(cls[k].status, 'confirmed', `查得了且凭据具体的 \`${k}\` → confirmed，不占活跃集`);
  }
  for (const k of [...bySource('blocked'), ...bySource('own_artifact'), ...bySource('settled_by_me')]) {
    eq(cls[k].status, 'active', `查不动的 \`${k}\` → active`);
  }
  // 强制披露只给"标签本身会误导人"的两种；blocked 已如实说了够不着，交给模型自选，
  // 否则 must_disclose 就退化成 status==='active' 的同义词，白占一个字段。
  for (const k of [...bySource('own_artifact'), ...bySource('settled_by_me')]) {
    eq(cls[k].mustDisclose, true, `\`${k}\` 强制披露（循环论证 / 替人做了决定）`);
  }
  for (const k of bySource('blocked')) {
    eq(cls[k].mustDisclose, false, `\`${k}\`（blocked）不强制披露 —— 进活跃集本身就是信号，`
      + `must_disclose 要与 status 保持正交`);
  }
  eq(Object.values(cls).filter((c) => c.status === 'active').length, 6,
    '21 条原始假设里，落到活跃集的只有这 6 条 —— 登记表不再是备注栏');

  // ⚠️ 上一版这里挂着一条 KNOWN_OVERASK：`fixture.dir.location`（人标 B，是选择但
  // 爆炸半径低）会被轴 1 拦下并逼去提问，当时如实记为"已知的滥问"。
  // settled_by_me 落地后它不再被拦，而是进活跃集 + 强制披露 —— 正是它该待的地方。
  eq(cls['fixture.dir.location'].status, 'active',
    '`fixture.dir.location` 不再是已知滥问：低爆炸半径的选择进活跃集 + 披露，不再逼人回答');
  assert(!validateAssumptions(built).some((e) => e.includes('fixture.dir.location')),
    '上一版唯一那条已知滥问，随 none 一起消失了');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 与交接校验接在一起');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 假设校验确实挂在 validateHandoff 上：字段不齐的一条能把整份交接拦下来
  const missing = validateHandoff({
    artifacts: [{ path: 'a.mjs' }], interface_contract: 'c', acceptance_evidence: 'e',
    assumptions: [{ subject_key: 'x.y', statement: 's', verified_against: 'command' }],
  }, {});
  assert(missing.some((e) => e.includes('缺 verification')),
    '假设校验挂在 validateHandoff 上 —— 一条假设缺凭据，整份交接过不了');

  // 老取值走到交接层同样被重定向，而不是静默收下一个语义已变的标签
  const legacy = validateHandoff({
    artifacts: [{ path: 'a.mjs' }], interface_contract: 'c', acceptance_evidence: 'e',
    assumptions: [{ subject_key: 'x.y', statement: 's', verified_against: 'none', verification: '取舍' }],
  }, {});
  assert(legacy.some((e) => e.includes('settled_by_me')), '交接层同样把废弃的 none 指向 settled_by_me');

  // 而合规的一份（含 settled_by_me）能过
  eq(validateHandoff({
    artifacts: [{ path: 'a.mjs' }], interface_contract: 'c', acceptance_evidence: 'e',
    assumptions: [{ subject_key: 'x.y', statement: 's', verified_against: 'settled_by_me',
      verification: '查过 README/DECISIONS 均无规定；选了严格模式，代价是老调用方会报错' }],
  }, {}).length, 0, '带一条 settled_by_me 的交接**能过** —— 拍板不再需要伪装成查证过');
}

console.log(`\n${'═'.repeat(72)}`);
console.log(`假设认识论轴：${pass} 通过，${fail} 失败`);
console.log('═'.repeat(72));
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
