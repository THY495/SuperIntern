// 离线回归：预算闸门 + 死人开关 + 审计可复盘
//
// 跑：node tests/budget-audit.test.mjs
//
// 预算闸门：`usage_ledger` 有非零花费，预算闸门在线 —— **把上限调到极低时能拦住**
// 可复盘：**仅凭审计轨 + 状态库**能复盘整个过程，不看进程日志
//
// ⚠️ "把上限调到极低时能拦住"是本文件的重点：闸门"存在"证明不了什么，
// 只有**真的拦住过一次**才算。第 2、3、4 节各拦一种。
//
// ⚠️ 可复盘的重点不是"能打印出一段时间线"——打印得再漂亮也可能整类事件都漏了。
// 真正的判据是第 7 节的完整性自检：**状态库说发生过 X，审计轨里找得到 X 吗**。
// 第 8 节反过来验它会不会说谎：人为在库里制造一个洞，自检必须报红。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LIMITS, limitOf, setLimit, checkLimits, raiseLimitQuestion, priorRuntimeMs, contextCapOf } from '../src/core/limits.mjs';
import { MODEL_CATALOG } from '../src/llm/canonical.mjs';
import { setEgressGroups } from '../src/core/egress.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { replay, renderReplay } from '../src/core/replay.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, m) => {
  try { fn(); bad(m, '期望被拒绝，但成功了'); }
  catch (e) { ok(`${m}\n         └ ${String(e.message).split('\n')[0]}`); }
};

const ROOT = resolve(import.meta.dirname, '..');
const TMP = mkdtempSync(join(tmpdir(), 'si-budget-'));
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

// ── fixture ───────────────────────────────────────────────────────────────
const SPEC = '在工作区新建 out.txt，内容为 ok。';
const ACC = '存在 out.txt 且内容为 ok。';

function fixture({ dbPath = ':memory:', nodes = 1 } = {}) {
  const db = openDb(dbPath);
  const { userId, plaintext } = ensureOwner(db);
  const taskId = newId('t'), constId = newId('c'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'budget fixture','running',?)`,
    taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,
            valid_from,recorded_at) VALUES (?,?,1,'写个文件','只动工作区','out.txt 存在','[]',?,?)`,
    constId, taskId, t, t);
  const ids = [];
  for (let i = 0; i < nodes; i++) {
    const n = newId('n');
    db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
            VALUES (?,?,?,?,?,'pending','normal','standard',?)`, n, taskId, `节点 ${i + 1}`, SPEC, ACC, t);
    ids.push(n);
  }
  return { db, taskId, constId, nodes: ids, userId, plaintext };
}

function makeWorkspace(name) {
  const ws = join(TMP, name);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'README.md'), '# fixture\n');
  git(ws, 'init', '-q');
  git(ws, 'config', 'user.email', 'test@local');
  git(ws, 'config', 'user.name', 'test');
  git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init');
  git(ws, 'checkout', '-q', '-b', 'v0/test');
  return ws;
}

const call = (name, args, usage = { inputTokens: 2000, outputTokens: 50 }) => ({
  stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${name}`, name, args }], usage,
});
const HANDOFF = {
  artifacts: [{ path: 'out.txt', kind: 'code' }],
  interface_contract: 'out.txt 里是 ok',
  acceptance_evidence: '跑了 cat out.txt，输出 ok',
};
const writeThenHandoff = () => [
  call('write_file', { path: 'out.txt', content: 'ok' }),
  call('submit_handoff', HANDOFF),
];
/** 永远只写文件、永不交接 —— 用来造"在花钱但不前进"的空转。 */
const spin = (n) => Array.from({ length: n }, (_, i) =>
  call('write_file', { path: `spin${i}.txt`, content: String(i) }));

// ═══════════════════════════════════════════════════════════════════════════
section('1. 上限是宪法层参数：agent 结构上改不了');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, userId } = fixture();

  // 没设过 ≠ 无上限。**内置天花板必须存在** —— 退化成无限就等于闸门不存在，
  // 而那恰好会发生在"用户还没来得及配"的时候。
  for (const [k, d] of Object.entries(LIMITS)) {
    eq(limitOf(db, taskId, k), d.def, `${k} 没设过时退到内置天花板 ${d.def}，不是无限`);
  }

  setLimit(db, { taskId, key: 'limit.budget_micro_usd', value: 123, userId });
  eq(limitOf(db, taskId, 'limit.budget_micro_usd'), 123, '设过之后读到新值');
  const row = db.one(`SELECT governance_class, set_by_kind FROM params
                      WHERE task_id=? AND key='limit.budget_micro_usd' AND superseded_at IS NULL`, taskId);
  eq(row.governance_class, 'constitutional', '上限落在宪法层 —— 硬规则，agent 不可自改');
  eq(row.set_by_kind, 'user', '设置者是 user');

  // 库层 CHECK 才是执法者（护栏住在模型外）。
  // 应用层不写 agent 那条路径不算数 —— 绕过应用层也必须绕不过去。
  rejects(() => db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,
                          set_by_id,valid_from,recorded_at)
                        VALUES (?,?,'limit.budget_micro_usd','999999','task','constitutional','agent',
                          'executor',?,?)`, newId('p'), taskId, now(), now()),
  'agent 直接往库里写宪法层参数 → 被库层 CHECK 拒');

  // 覆盖是 supersede 不是 delete（失效不删除）
  setLimit(db, { taskId, key: 'limit.budget_micro_usd', value: 456, userId });
  eq(db.one(`SELECT count(*) AS n FROM params WHERE task_id=? AND key='limit.budget_micro_usd'`, taskId).n, 2,
    '改上限是新增一行 + 旧行 superseded，不是原地改 —— 改过什么、谁改的都留痕');
  eq(limitOf(db, taskId, 'limit.budget_micro_usd'), 456, '取当前生效的那条');

  rejects(() => setLimit(db, { taskId, key: 'limit.nonsense', value: 1, userId }),
    '不认识的维度直接拒，不静默吞掉');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 预算闸门：把上限调到极低，真的拦住');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, userId, nodes } = fixture({ nodes: 2 });
  const ws = makeWorkspace('ws-budget');
  // 卡在"第一个节点跑得完、第二个开不了张"的位置：单次调用约 11250 微美元，
  // 一个节点两次调用约 22500。这样测的是**轮边界**那道闸；
  // 轮级那道（节点跑到一半掐停）在第 3 节单独测。
  setLimit(db, { taskId, key: 'limit.budget_micro_usd', value: 20_000, userId });

  const r = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-budget'), maxCycles: 4, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(writeThenHandoff()),
      fakePricing: { input: 5, output: 25 } }),
  });

  eq(r.kind, 'limit_breached', '编排器停在 limit_breached');
  eq(r.breach.key, 'limit.budget_micro_usd', '触顶维度是花费');
  assert(r.breach.actual >= r.breach.limit, '实测值确实 ≥ 上限，不是凭空报警');

  // 触顶行为是"强制汇报 + 提问"，绝不静默死掉也绝不静默续跑。
  const q = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  assert(q, '触顶生成了一条真的 questions 行 —— 不是打印一句话就退出');
  eq(q.level, 3, '硬上限一律 Ⅲ 级（触及安全边界的由 harness 强制归 Ⅲ）');
  eq(q.level_source, 'hard_rule',
    '定级来源是 hard_rule 而非 classifier —— **全系统第一处**由状态机而非模型定级');
  eq(q.default_action, null, 'Ⅲ 级无默认动作（库层 CHECK 也这么要求）');
  eq(q.timeout_at, null, 'Ⅲ 级无超时：无限期等人');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务冻结在 waiting');
  assert(q.text.includes('未调用模型'), '问题正文写明它是状态机生成的');

  // ⚠️ 这一条是闸门设计的核心：**报告"钱花光了"不能再花钱**。
  // 否则预算越紧，报告越可能失败 —— 闸门有一个自指的洞。
  const spendBefore = db.one(`SELECT count(*) AS n FROM usage_ledger WHERE task_id=?`, taskId).n;
  raiseLimitQuestion(db, { taskId, breach: r.breach });
  eq(db.one(`SELECT count(*) AS n FROM usage_ledger WHERE task_id=?`, taskId).n, spendBefore,
    '再生成一条触顶问题，账本一行都没增 —— 生成触顶问题**零 LLM 调用**');

  // 出处边：这条问题因为**哪条上限**而存在，可机械追溯
  const pid = db.one(`SELECT id FROM params WHERE task_id=? AND key='limit.budget_micro_usd'
                      AND superseded_at IS NULL`, taskId).id;
  assert(db.one(`SELECT 1 AS x FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from'`,
    r.questionId, pid), '问题有一条 derived_from 指向那条 params 行 —— 出处链没断');

  // 另一个节点一步都没跑：闸门排在挑节点之前，不是花完了再记账。
  // ⚠️ 不假定"先跑 nodes[0]"：readyNodes 的排序末位是 `n.id`（随机 UUID 前缀），
  //    先跑哪个与插入顺序无关。按 id 断言会造出一个跟着随机数翻面的测试。
  eq(db.one(`SELECT count(*) AS n FROM nodes WHERE task_id=? AND status='done'`, taskId).n, 1,
    '两个节点里跑完了一个（预算够一个）');
  const idle = db.one(`SELECT id FROM nodes WHERE task_id=? AND status='pending'`, taskId);
  assert(idle, '另一个仍停在 pending —— 闸门拦在花下一笔钱之前，不是事后报账');
  eq(db.one(`SELECT count(*) AS n FROM usage_ledger WHERE task_id=? AND node_id=?`, taskId, idle.id).n, 0,
    '它的账本上一分钱都没有：拦住 = 真的没花，不是花了再说');
  assert(nodes.length === 2, '（fixture 确实建了 2 个节点）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 轮级闸门：单个节点跑到一半也能掐停，且**不计重试**');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 单个 heavy 节点能一口气烧掉好几美元。只在节点边界检查，
  // 等于给每个节点发一张"最多再超一个节点"的免死金牌。
  const { db, taskId, userId } = fixture();
  const ws = makeWorkspace('ws-midnode');
  // 上限设在"跑了几轮之后才会超"的位置：第一轮先放行（否则连叙事都没有），
  // 之后每轮体检，攒够就掐。
  setLimit(db, { taskId, key: 'limit.budget_micro_usd', value: 30_000, userId });

  const r = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-mid'), maxCycles: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(spin(12)),
      fakePricing: { input: 5, output: 25 } }),
  });

  eq(r.kind, 'limit_breached', '节点跑到一半被掐停，编排器报 limit_breached');
  const n = db.one(`SELECT status, retry_count FROM nodes WHERE task_id=?`, taskId);
  eq(n.status, 'pending', '节点退回 pending，等加额后重来');
  eq(n.retry_count, 0,
    '**不计重试** —— 重试次数是"这个节点自己搞不定"的度量；被闸门掐停不是它的问题，'
    + '记在它头上会让加额重跑的人凭空少一次机会');
  assert(db.all(`SELECT action FROM audit_log WHERE target_id=?`, n.id ?? '')
    .concat(db.all(`SELECT action FROM audit_log`))
    .some((e) => e.action === 'node_aborted'), '审计轨里有 node_aborted，与 node_stalled 分得开');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3b. limit.context_tokens：给那道无名护栏一个名字');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 补这一维的理由：实测峰值 106k/200k，
  // 从没触发过压缩阈值 —— 但现在挡住上下文爆掉的是 `maxIterations=20`，
  // 一道**没有名字、不在 LIMITS 里**的意外护栏。把它调到 30 就是约 190k 撞窗口，
  // 而没有任何东西会拦或提醒。
  eq(LIMITS['limit.context_tokens'].def, 150_000,
    '默认 150k = 200k 窗口的 75%（驱逐阈值）');
  assert(/规划粒度过粗/.test(LIMITS['limit.context_tokens'].advice),
    '这一维带专属建议：触顶时"提高上限"通常是错答案 —— 用结构解决的问题不用压缩解决');

  const { db, taskId, userId } = fixture();
  // 按所绑模型封顶。目录里核实过 contextWindow 的模型取窗口 × 75% 与设定值的较小者；没填的退回设定值。
  eq(JSON.stringify(contextCapOf(db, taskId, { contextWindow: null })), JSON.stringify({ cap: 150_000, source: 'default', window: null, layer: 'deploy' }), '没有模型窗口 → 默认常数');
  eq(JSON.stringify(contextCapOf(db, taskId, { contextWindow: 128_000 })), JSON.stringify({ cap: 96_000, source: 'model', window: 128_000 }), '128k 模型 → 96k（窗口 75%），比常数小就用它');
  eq(JSON.stringify(contextCapOf(db, taskId, { contextWindow: 1_000_000 })), JSON.stringify({ cap: 150_000, source: 'default', window: 1_000_000, layer: 'deploy' }), '1M 模型 → 仍是常数（模型封顶只会往小走）');
  eq(MODEL_CATALOG['deepseek/deepseek-v4-pro'].contextWindow, 1_000_000, '目录里 DeepSeek 两档记了核实过的 1M 窗口');
  assert(Object.entries(MODEL_CATALOG).filter(([k]) => !k.startsWith('deepseek/')).every(([, v]) => v.contextWindow == null), '没核实过的模型不填（退回常数，不猜）');
  const ws = makeWorkspace('ws-ctx');
  // fake 脚本每轮报 inputTokens=2000。上限设 1000 → 第 2 轮开头就该掐。
  setLimit(db, { taskId, key: 'limit.context_tokens', value: 1000, userId });
  const r = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-ctx'), maxCycles: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(spin(12)) }),
  });
  eq(r.kind, 'limit_breached', '上下文超限 → 轮级闸门掐停');
  const n = db.one(`SELECT status, retry_count FROM nodes WHERE task_id=?`, taskId);
  eq(n.retry_count, 0, '同样**不计重试** —— 被闸门掐停不是这个节点自己搞不定');

  // 峰值必须在 flushLedger **之前**取。顺序反了这一维永远读到 0 ——
  // 一道恒不触发的闸门，比没有闸门更坏，因为它会让人以为查过了。
  const b = checkLimits(db, taskId, { startedAt: now(), idleCycles: 0, peakContextTokens: 2000 });
  eq(b?.key, 'limit.context_tokens', '循环开头的体检也认这一维');
  assert(/通常不应选择 \(A\) 提高上限/.test(
    db.one(`SELECT text FROM questions WHERE task_id=? ORDER BY rowid DESC LIMIT 1`, taskId).text),
  '触顶问题正文里带上了这一维的专属建议，而不是统一模板的"加额继续"');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3c. 厂商报 context_exceeded：不当成普通 stalled');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 走到这里说明本系统的上限没拦住（默认 150k 对小窗口模型形同虚设）。
  // 重试一次只会构造出同样大的上下文、撞同一堵墙、白烧一次钱，
  // 最后被 node_retries 判死 —— 而人拿到的结论会是"这个节点搞不定"，指不到真实原因。
  const { db, taskId } = fixture();
  const ws = makeWorkspace('ws-ctxexc');
  const r = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-ctxexc'), maxCycles: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake',
      fake: makeFake([{ stopReason: 'context_exceeded', content: [{ type: 'text', text: '' }],
        usage: { inputTokens: 190_000, outputTokens: 0 } }]) }),
  });
  eq(r.kind, 'limit_breached', 'context_exceeded 走触顶路径，不是 stalled');
  eq(r.breach.key, 'limit.context_tokens', '触顶维度指名是上下文，不是含糊的"节点没收尾"');
  assert(/模型窗口/.test(r.breach.human),
    `正文说清撞的是**模型窗口**而非本系统上限：${r.breach.human.slice(0, 60)}`);
  eq(db.one(`SELECT level_source FROM questions WHERE task_id=?`, taskId).level_source, 'hard_rule',
    '仍是状态机定级');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 死人开关：在花钱但不在前进');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 资源上限抓不住空转：每轮都在正常调用工具、正常记账，只是没有一个节点走到 done。
  const { db, taskId, userId } = fixture();
  const ws = makeWorkspace('ws-idle');
  setLimit(db, { taskId, key: 'limit.idle_cycles', value: 2, userId });
  setLimit(db, { taskId, key: 'limit.node_retries', value: 99, userId });     // 让死人开关先响
  setLimit(db, { taskId, key: 'limit.budget_micro_usd', value: 10_000_000, userId });

  // 每次执行都在 4 轮内跑完却从不交接 → 节点回 pending → 下一轮再来 → 空转
  const r = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-idle'), maxCycles: 8,
    maxIterations: 3, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(spin(40)),
      fakePricing: { input: 1, output: 1 } }),
  });

  eq(r.kind, 'limit_breached', '空转被死人开关拦下');
  eq(r.breach.key, 'limit.idle_cycles', '触顶维度是 idle_cycles，不是花费 —— 这正是资源上限抓不住的那一类');
  eq(db.one(`SELECT count(*) AS n FROM usage_ledger WHERE task_id=?`, taskId).n > 0, true,
    '账本非零：它确实在花钱，只是不在前进');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务冻结');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 单节点重试上限');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, userId } = fixture();
  const ws = makeWorkspace('ws-retry');
  setLimit(db, { taskId, key: 'limit.node_retries', value: 2, userId });
  setLimit(db, { taskId, key: 'limit.idle_cycles', value: 99, userId });      // 让重试上限先响

  const r = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-retry'), maxCycles: 8,
    maxIterations: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(spin(40)),
      fakePricing: { input: 1, output: 1 } }),
  });

  eq(r.kind, 'limit_breached', '重试撞顶');
  eq(r.breach.key, 'limit.node_retries', '触顶维度是 node_retries');
  eq(db.one(`SELECT retry_count FROM nodes WHERE task_id=?`, taskId).retry_count, 2,
    '重试计到上限就停 —— 自动重试且封了顶');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 加额之后能接着跑（触顶不是终局）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, userId, plaintext } = fixture();
  const ws = makeWorkspace('ws-resume');
  setLimit(db, { taskId, key: 'limit.budget_micro_usd', value: 1, userId });

  const r1 = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-res'), maxCycles: 3, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(writeThenHandoff()),
      fakePricing: { input: 5, output: 25 } }),
  });
  eq(r1.kind, 'limit_breached', '先撞顶');

  // 上限还没调高就回 A → 拒收（否则没保存就回"已调高"，任务一接着跑又停在这里，人每答一次多一条事项）
  let early = null; try { recordAnswer(db, { questionId: r1.questionId, body: 'A 加到 $10 继续', plaintextToken: plaintext }); } catch (e) { early = e.message; }
  assert(/还没调高/.test(early ?? ''), '上限还没调高就回 A：当场拒收，说清楚去哪儿改');
  // 先加额，再回答那条 Ⅲ 级问题（走认证通道）
  setLimit(db, { taskId, key: 'limit.budget_micro_usd', value: 10_000_000, userId });
  recordAnswer(db, { questionId: r1.questionId, body: 'A 加到 $10 继续', plaintextToken: plaintext });

  const r2 = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-res'), maxCycles: 3, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(writeThenHandoff()),
      fakePricing: { input: 5, output: 25 } }),
  });
  eq(r2.kind, 'complete', '加额之后同一条 run 命令接着跑到完成 —— 恢复不是另一条路径');
  eq(db.one(`SELECT status FROM nodes WHERE task_id=?`, taskId).status, 'done', '节点最终 done');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. 仅凭审计轨 + 状态库复盘');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, plaintext, userId } = fixture({ nodes: 2 });
  const ws = makeWorkspace('ws-replay');

  // 走一条有代表性的路：完成一个节点 → 第二个节点提问挂起 → 人回答 → 复工完成
  await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-rp'), maxCycles: 1, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(writeThenHandoff()) }),
  });
  const r2 = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-rp'), maxCycles: 1, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([call('raise_question', {
      level: 2, text: '第二个节点该写 out2.txt 还是覆盖 out.txt？',
      blocked_by: '规格只说 out.txt', default_action: '写 out2.txt',
      work_done: '读了工作区，out.txt 已存在', plan_after_answer: '按答复写文件后交接',
    })]) }),
  });
  recordAnswer(db, { questionId: r2.questions[0].id, body: '写 out2.txt', plaintextToken: plaintext });
  await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-rp'), maxCycles: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([
      call('write_file', { path: 'out2.txt', content: 'ok' }),
      call('submit_handoff', { ...HANDOFF, artifacts: [{ path: 'out2.txt', kind: 'code' }] }),
    ]) }),
  });

  const r = replay(db, taskId);
  eq(r.checks.filter((c) => !c.ok).length, 0,
    `完整性自检全绿：${r.checks.map((c) => c.name).join(' / ')}`);
  eq(r.task.status, 'done', '复盘出来的终态与状态库一致');
  eq(r.lives.length, 3, '三次进程寿命，全部 started…exit 配对');
  eq(new Set(r.lives.map((l) => l.kind)).size >= 2, true, '三次寿命的结局不全相同（complete / suspended）');
  eq(r.questions.filter((q) => q.decision_type !== 'signoff').length, 1, '复盘看得到那一次提问（done 时另有一条签收事项）');
  eq(r.questions.filter((q) => q.decision_type === 'signoff').length, 1, 'done 生成了签收事项');
  eq(r.questions[0].answer?.trust_label, 'user-authenticated',
    '答复的信任标签可复盘 —— 指令效力在事后也查得出来');
  assert(r.questions[0].answer?.token_id, '答复带 token_id：哪把钥匙签发的这条指令，留痕');

  // 渲染出来的东西要真的含关键事实，而不是一堆好看的框
  const text = renderReplay(r);
  for (const must of [taskId, 'question_answered', 'node_done', '复盘成立']) {
    assert(text.includes(must), `复盘文本里含 \`${must}\``);
  }
  assert(!text.includes('narratives'), '复盘正文不引用叙事内容 —— 那是 agent-generated，不是真相源');

  // 空集不是通过：在一个问题都没提的前提下记成通过，是虚的。
  // 一份 0 节点 0 问题的复盘会让六条检查全部"通过"，那读起来是绿灯，实际什么都没验。
  const { db: dbv, taskId: tv } = fixture({ nodes: 0 });
  const rv = replay(dbv, tv);
  eq(rv.checks.every((c) => c.vacuous), true, '空任务的每一条检查都被标为空集');
  eq(rv.checks.filter((c) => !c.ok).length, 0, '空集在 ok 上不算失败……');
  assert(renderReplay(rv).includes('什么都没验到'),
    '……但渲染必须明说"什么都没验到" —— 空集打成绿勾会读成绿灯');
  dbv.close();
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. 自检必须会报红：人为制造一个洞');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ⚠️ 这一节才是第 7 节有意义的前提。一个永远返回"全绿"的自检等于没有自检，
  // 而且比没有更坏 —— 它会让人以为查过了。
  const { db, taskId } = fixture();
  const ws = makeWorkspace('ws-hole');
  await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'nar-hole'), maxCycles: 2, commit: false, verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(writeThenHandoff()) }),
  });
  eq(replay(db, taskId).checks.filter((c) => !c.ok).length, 0, '基线全绿');

  // ① 洞：有人绕过编排器把任务改成 done
  const { db: db2, taskId: t2 } = fixture();
  db2.run(`UPDATE tasks SET status='done' WHERE id=?`, t2);
  const c1 = replay(db2, t2).checks.find((c) => c.name === '置 done 有对应审计');
  eq(c1.ok, false, '绕过编排器置 done → 自检报红（状态列可被任何 UPDATE 写，审计轨不能）');
  db2.close();

  // ② 洞：花费落在所有进程寿命之外
  db.run(`INSERT INTO usage_ledger (task_id,role,model_tier,provider,model_id,input_tokens,
            cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,micro_usd,billing,ts)
          VALUES (?,'ghost','standard','x','x/y',1,0,0,1,0,999,'computed',?)`, taskId, now() + 3_600_000);
  const c2 = replay(db, taskId).checks.find((c) => c.name === '花费都落在某次进程寿命内');
  eq(c2.ok, false, '有一笔钱花在所有寿命区间之外 → 自检报红（说明有代码在没有括号的地方调 LLM）');

  // ③ 洞：跑过的节点在审计轨里没有终局
  const { db: db3, taskId: t3, nodes } = fixture();
  db3.run(`UPDATE nodes SET status='running', started_at=? WHERE id=?`, now(), nodes[0]);
  const c3 = replay(db3, t3).checks.find((c) => c.name === '跑过的节点都在审计轨里有终局');
  eq(c3.ok, false, '节点有 started_at 却没有终局条目 → 自检报红（这正是进程被硬杀的形状）');
  db3.close();

  // ④ 洞：标为 answered 的问题没有经认证的答复
  const { db: db4, taskId: t4 } = fixture();
  const qid = newId('q');
  db4.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,
             asked_at,status) VALUES (?,?,NULL,2,'classifier','x','d',?, 'answered')`, qid, t4, now());
  const c4 = replay(db4, t4).checks.find((c) => c.name === '答复都经过认证通道');
  eq(c4.ok, false, '问题标为 answered 却查不到认证答复 → 自检报红（认证答复的事后可查性）');
  db4.close();

  // ⑤ 洞：审计轨答不出这次执行跑在哪
  //
  // 这条检查有两层，两层都要验，否则很容易写成一条只会打绿灯的装饰：
  //   - 有 sandbox_skipped 认领 → ✓，但详情里必须**明说**有几次跑在宿主机上
  //   - 什么都没有             → ⚠️，那才是审计洞
  // 上面那个基线跑（orchestrate 默认 LocalExecutor）走的正是第一层。
  const c5 = replay(db, taskId).checks.find((c) => c.name === '每次执行都答得出跑在哪');
  assert(c5.ok, '默认 LocalExecutor 跑的任务：有 sandbox_skipped 认领 → 不算审计洞');
  assert(/在宿主机上/.test(c5.detail),
    `✓ 的情况下详情仍写明宿主机次数，不藏：${c5.detail}`);

  // 红的那一层要另造一个夹具，而不是把认领条目删掉 ——
  // **删不掉**：`audit_log is append-only` 是库层触发器，第一版测试就是想这么写，
  // 当场被拦。拦得对，顺手也证明了这条自检读的是一张改不了的表。
  // 所以直接造一个"有执行终局、但从没经过 orchestrate"的任务，
  // 那正是沙箱记录出现之前的任务在库里的形状。
  const { db: db5, taskId: t5, nodes: n5 } = fixture();
  db5.run(`UPDATE nodes SET started_at=? WHERE id=?`, now(), n5[0]);
  audit(db5, { actorKind: 'agent', actorId: 'executor', action: 'node_stalled',
    targetType: 'node', targetId: n5[0], payload: {} });
  const c5b = replay(db5, t5).checks.find((c) => c.name === '每次执行都答得出跑在哪');
  eq(c5b.ok, false, '没有 sandbox_skipped 也没有沙箱寿命 → 自检报红（审计轨答不出跑在哪）');
  db5.close();
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. 累计运行时长：挂起等人的时间不算');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ⚠️ 这一条不是优化，是正确性。按墙上时钟（建任务到现在）算的话，
  // **每一个提过问题的任务最终都会被自己的闸门打死** —— 而那是在惩罚人回得慢。
  const { db, taskId } = fixture();
  const t0 = now();
  audit(db, { actorKind: 'system', action: 'orchestrator_exit', targetType: 'task', targetId: taskId,
    payload: { pid: 1, kind: 'suspended', elapsedMs: 5_000 } });
  audit(db, { actorKind: 'system', action: 'planner_exit', targetType: 'task', targetId: taskId,
    payload: { pid: 2, kind: 'plan', elapsedMs: 3_000 } });
  eq(priorRuntimeMs(db, taskId), 8_000,
    '累计运行时长 = 各次进程寿命之和（编排器 5s + 规划器 3s），中间等人的时间不计入');

  // 规划器也算一段：复盘自检会照出来 —— 规划器若没有括号，
  // 于是 planner 那笔钱落在所有区间之外。
  const cap = limitOf(db, taskId, 'limit.runtime_ms');
  assert(cap > 8_000, '（8s 远在内置天花板之下，下面这条才有意义）');
  const b = checkLimits(db, taskId, { startedAt: t0, idleCycles: 0 });
  assert(!b || b.key !== 'limit.runtime_ms', '8 秒不触顶');

  const { db: db2, taskId: t2, userId } = fixture();
  setLimit(db2, { taskId: t2, key: 'limit.runtime_ms', value: 1, userId });
  const b2 = checkLimits(db2, t2, { startedAt: t0 - 10_000, idleCycles: 0 });
  assert(b2 && ['limit.budget_micro_usd', 'limit.runtime_ms'].includes(b2.key),
    '把时长上限调到 1ms → 立刻触顶（"调到极低时能拦住"，时间维同样成立）');
  db2.close();
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('10. 全触顶类维度都真的接在闸门上（按 on_hit 类别筛选遍历）');
// ═══════════════════════════════════════════════════════════════════════════
{
  // 一维一维地把上限压到 0，逐个走**整条触顶路径**，确认撞顶处置与预算/时长
  // **同形**：limit_breached 审计 + 该维度自己的 advice + Ⅲ 级 hard_rule 提问 ——
  // 而不是硬失败。少接一维不会有任何报错，只会静默地少一道闸 —— 必须逐维点名。
  // ⚠️ 覆盖方式按 LIMITS 条目的 on_hit 类别字段筛选遍历，不硬编码维度名；
  //    硬边界类（内存/pids）走的是"审计+硬失败"，在第 11 节单独断言，不在此列。
  const ws = makeWorkspace('ws-gate-all');
  for (const [key, d] of Object.entries(LIMITS).filter(([, d]) => d.on_hit === 'gate')) {
    const { db, taskId, userId } = fixture();
    setLimit(db, { taskId, key, value: 0, userId });
    const r = await orchestrate(db, {
      taskId, workspace: ws, narrativeDir: join(TMP, 'nar-gate-all'),
      maxCycles: 2, commit: false, verify: false,
      makeClient: () => { throw new Error(`${key} 触顶路径不应调用模型（闸门排在挑节点与记审计之前）`); },
    });
    eq(r.kind, 'limit_breached', `${key} 压到 0 → 撞顶走与预算/时长同一条触顶路径（limit_breached，不是硬失败）`);
    eq(r.breach.key, key, `${key} 触顶维度正是这一维（${r.breach.key ?? '没报'}）`);
    assert(r.breach.human.includes(d.label), `${key} 的报警文案里含维度名"${d.label}"`);
    assert(r.breach.actual >= r.breach.limit, `${key} 实测值确实 ≥ 上限，不是凭空报警`);

    // 审计记录：与 budget/runtime 同形 —— limit_breached、挂在提问上、无 hard_fail 标记
    const row = db.one(`SELECT payload FROM audit_log WHERE target_id=? AND action='limit_breached'`, taskId);
    assert(row, `${key} 撞顶产生了一条 limit_breached 审计记录`);
    const p = JSON.parse(row.payload);
    eq(p.key, key, `${key} 审计记录里维度名一致`);
    assert('limit' in p && 'actual' in p && p.human, `${key} 审计记录含上限/实测/正文（与预算/时长同形）`);
    assert(p.questionId === r.questionId, `${key} 审计记录挂在提问上（gate 分支同形）`);
    eq(p.on_hit, undefined, `${key} 审计记录不带 hard_fail 标记 —— 没走硬失败那条路`);

    // 提问分支：与预算触顶同一 raiseLimitQuestion —— Ⅲ 级、hard_rule、状态机生成
    const q = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
    assert(q, `${key} 撞顶生成了一条真的 questions 行（与预算同一提问分支）`);
    eq(q.level, 3, `${key} 硬上限一律 Ⅲ 级`);
    eq(q.level_source, 'hard_rule', `${key} 状态机定级而非 classifier`);
    eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', `${key} 任务冻结 waiting`);

    // 建议文本取自该维度自己的 advice 字段：带 advice 的维度 → 提问正文必须带上它
    // （取自该维，不是统一模板）；不带 advice 的维度（预算/时长等）本就与预算/时长
    // 同一模板，正文不出现任何 advice 段落。无论哪种，正文都不得混入**其它维度**
    // 的 advice —— 建议按维度取，不串维。
    for (const [k2, d2] of Object.entries(LIMITS).filter(([, x]) => x.on_hit === 'gate' && x.advice)) {
      const slice = d2.advice.slice(0, 20);
      if (k2 === key) {
        assert(q.text.includes(slice), `${key} 问题正文带该维度自己的 advice（${d2.advice.slice(0, 26)}…）`);
      } else {
        assert(!q.text.includes(slice), `${key} 问题正文不含其它维度（${k2}）的 advice —— 建议不串维`);
      }
    }
    db.close();
  }
}
// ═══════════════════════════════════════════════════════════════════════════
section('11. 内存/pids 撞顶：硬边界 = 审计 + 硬失败，无 advice、无提问');
// ═══════════════════════════════════════════════════════════════════════════
{
  for (const key of ['limit.memory_bytes', 'limit.pids']) {
    const { db, taskId, userId } = fixture();
    const ws = makeWorkspace(`ws-hard-${key.replace('limit.', '')}`);
    setLimit(db, { taskId, key, value: 0, userId });

    const r = await orchestrate(db, {
      taskId, workspace: ws, narrativeDir: join(TMP, `nar-hard-${key.replace('limit.', '')}`),
      maxCycles: 2, commit: false, verify: false,
      makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(writeThenHandoff()) }),
    });

    eq(r.kind, 'limit_hard_failed', `${key} 撞顶 → 硬失败 kind（进程以非零码失败的分支）`);
    eq(r.breach.key, key, `${key} 触顶维度正确`);
    assert(!db.one(`SELECT id FROM questions WHERE task_id=?`, taskId),
      `${key} 撞顶**没有**生成提问 —— 不进提问/降级分支`);
    const row = db.one(`SELECT payload FROM audit_log WHERE target_id=? AND action='limit_breached'`, taskId);
    assert(row, `${key} 撞顶写入了一条与预算/时长同形的审计事件`);
    const p = JSON.parse(row.payload);
    eq(p.key, key, '审计事件里含维度名');
    assert('limit' in p && 'actual' in p, '审计事件里含上限值与实测值');
    eq(p.on_hit, 'hard_fail', '审计事件标明 hard_fail 类别');
    assert(!/advice|提高上限|加额/.test(p.human ?? ''), '审计事件里不含加额建议文案');
    assert(!/加额|提高上限继续/.test(r.why ?? ''), `失败信息不含加额/提高上限继续（${r.why}）`);
    assert(/提高上限不是解法/.test(r.why ?? ''), '失败信息明说提高上限不是解法');
    db.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. 不设放行几类软件源的上限：它拦的是人自己的放行动作，再让同一个人确认一遍');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, userId } = fixture();
  eq(LIMITS['limit.egress.groups'], undefined, '这一维不在了');
  setEgressGroups(db, { taskId, groups: ['npm', 'pypi', 'github', 'crates', 'goproxy'], userId });
  eq(checkLimits(db, taskId, { startedAt: now(), idleCycles: 0 }), null, '五类全开也不再触顶 —— 放行哪几类由人勾选本身表达，不再二次确认');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('13. 出网连续被拒计数（行为级）：连续达上限提问；成功一次即归零、不触发');
// ═══════════════════════════════════════════════════════════════════════════
//
// 观测源：出口代理写的审计 JSONL（guard.py 每一条出网尝试落一行 allowed 真假）。
// 编排器每次体检前把自上次采样以来新增的行喂给连续计数（denied +1 / allowed 归零），
// 计数与游标持久化于 params（limits 的 read 直读；跨进程用例在 tests/egress-consecutive.test.mjs 第 3 节）；
// 撞上限走与 budget/runtime 同一条 gate 触顶路径。离线测试用 EgressScriptExecutor 模拟"命令引发了出网事件"。
{
  class EgressScriptExecutor extends LocalExecutor {
    constructor(auditFile, events) {
      super();
      this.egress = { auditFile };
      this.events = events ?? [];
      this.i = 0;
    }
    async execute(cmd, workspace, limits = {}) {
      if (this.i < this.events.length) {
        const ev = this.events[this.i++];
        writeFileSync(this.egress.auditFile,
          `${JSON.stringify({ ts: Date.now() / 1000, phase: 'request', host: ev.host, allowed: ev.allowed })}\n`,
          { flag: 'a' });
      }
      return { code: 0, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false, durationMs: 1 };
    }
  }
  const deniedEv = () => ({ host: 'registry.npmjs.org', allowed: false });
  const allowedEv = () => ({ host: 'registry.npmjs.org', allowed: true });
  /** 脚本：evs.length 条 run_command（每条触发一次 execute → 追加一条观测）+ 写产物 + 交接。 */
  const runN = (evs) => [
    ...evs.map((_, i) => call('run_command', { file: 'true', args: [`#${i}`] })),
    call('write_file', { path: 'out.txt', content: 'ok' }),
    call('submit_handoff', HANDOFF),
  ];

  // ── 连续被拒达上限（默认 3）→ gate 触顶：提问 + 该维 advice + 审计，与预算同形 ──
  {
    const { db, taskId } = fixture();
    const ws = makeWorkspace('ws-egden-trig');
    const auditFile = join(TMP, `egden-trig-${taskId}.jsonl`);
    writeFileSync(auditFile, '');                      // 本进程启动时为空 → 从 0 起算
    eq(LIMITS['limit.egress.consecutive_denials'].def, 3, '上限默认值来自 LIMITS 键（def=3）');
    const evs = [deniedEv(), deniedEv(), deniedEv()];
    const exec = new EgressScriptExecutor(auditFile, evs);
    const r = await orchestrate(db, {
      taskId, workspace: ws, exec,
      narrativeDir: join(TMP, 'nar-egden-trig'), maxCycles: 3, commit: false, verify: false,
      makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(runN(evs)),
        fakePricing: { input: 1, output: 1 } }),
    });
    eq(r.kind, 'limit_breached', '连续被拒 3 次（默认上限 3）→ gate 触顶（limit_breached，不是硬失败）');
    eq(r.breach.key, 'limit.egress.consecutive_denials', '触顶维度是出网连续被拒次数');
    eq(r.breach.actual, 3, '实测连续被拒 3 次');
    const q = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
    assert(q, '生成了 Ⅲ 级提问 —— 与预算同一 raiseLimitQuestion 分支');
    eq(q.level_source, 'hard_rule', '状态机定级而非 classifier');
    assert(q.text.includes(LIMITS['limit.egress.consecutive_denials'].advice.slice(0, 20)),
      '问题正文带上了该维度的专属 advice（提高上限通常不是对的答案）');
    assert(q.text.includes('registry.npmjs.org'), '问题正文含被拒目标集合摘要');
    const p = JSON.parse(db.one(
      `SELECT payload FROM audit_log WHERE target_id=? AND action='limit_breached'`, taskId).payload);
    eq(p.key, 'limit.egress.consecutive_denials', '审计事件里维度名一致');
    eq(p.questionId, r.questionId, '审计事件挂在提问上（gate 分支同形）');
    eq(p.deniedHosts?.['registry.npmjs.org'], 3, '审计事件含被拒目标集合摘要（host×次数）');
    eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务冻结 waiting');
    db.close();
  }

  // ── 连续语义：被拒 2 次 → 成功出网归零 → 再被拒 2 次，到不了 3 → 不触发 ──
  {
    const { db, taskId } = fixture();
    const ws = makeWorkspace('ws-egden-reset');
    const auditFile = join(TMP, `egden-reset-${taskId}.jsonl`);
    writeFileSync(auditFile, '');
    const evs = [deniedEv(), deniedEv(), allowedEv(), deniedEv(), deniedEv()];
    const exec = new EgressScriptExecutor(auditFile, evs);
    const r = await orchestrate(db, {
      taskId, workspace: ws, exec,
      narrativeDir: join(TMP, 'nar-egden-reset'), maxCycles: 3, commit: false, verify: false,
      makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake(runN(evs)),
        fakePricing: { input: 1, output: 1 } }),
    });
    eq(r.kind, 'complete', '中途一次成功出网把连续计数归零 → 2+2 到不了上限 3，任务正常完成');
    assert(!db.one(`SELECT id FROM questions WHERE task_id=? AND decision_type<>'signoff'`, taskId), '没有生成任何提问（签收事项除外）');
    assert(!db.one(`SELECT id FROM audit_log WHERE target_id=? AND action='limit_breached'`, taskId),
      '没有 limit_breached 审计 —— 计数按「连续」语义、会归零');
    db.close();
  }
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'═'.repeat(72)}`);
console.log(`预算 / 审计回归：${pass} 通过，${fail} 失败`);
console.log('═'.repeat(72));
process.exit(fail ? 1 : 0);
