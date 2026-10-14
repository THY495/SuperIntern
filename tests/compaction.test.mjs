// 上下文整理（托底）：两级整理、整理线的生效值与校验、闸门看整理之后的体量、整理太多次转人。
//
// 假模型按请求现算 usage（= 这次请求的估算体量），所以"真实 / 估算"的校准比恒为 1，体量全由测试控制。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { LlmClient, runToolLoop, markRollingCache } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { executeNode, makeHandlers } from '../src/agent/executor.mjs';
import { verifyHandoff } from '../src/agent/verifier.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { flushLedger } from '../src/core/ledger.mjs';
import { DEP_EXCLUDES } from '../src/core/workspace.mjs';
import { clearOldToolResults, checkBrief, messageEstimate, fixedEstimate, makeCompactor, OUTPUTS_DIR, CLEAR_AT_LEAST, MODEL_COMPACTIONS_PER_STEP } from '../src/context/compact.mjs';
import { LIMITS, setLimit, setProjectLimit, compactThresholdOf, checkLimits, limitOf } from '../src/core/limits.mjs';
import { SESSIONS, assertSessionTools } from '../src/core/capabilities.mjs';
import { LLM_ROLES } from '../src/llm/canonical.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, m, re) => {
  try { fn(); bad(m, '期望被拒绝，但成功了'); }
  catch (e) { (re && !re.test(e.message)) ? bad(m, `报错不对：${e.message}`) : ok(`${m}\n         └ ${String(e.message).split('\n')[0]}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'si-a11-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'读大文件','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'把几个大文件读一遍','全仓库','读完','[]',?,?)`, newId('c'), taskId, t, t);
  const n1 = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'读文件','依次读 a–e 五个文件','读完','pending','normal','standard',?)`, n1, taskId, t);
  return { db, taskId, n1, userId };
}
/** 工作区：五个约 11k token 的文件（39,000 个 ASCII 字符，估算 = 39000 / 3.5） */
function makeWorkspace(name) {
  const ws = join(TMP, name);
  mkdirSync(ws, { recursive: true });
  for (const f of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(ws, `${f}.txt`), `${f}`.repeat(38_999) + '\n');
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't');
  git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init'); git(ws, 'checkout', '-q', '-b', 'v0/test');
  return ws;
}
const FILE_TOKENS = Math.ceil(39_000 / 3.5);

/** 假模型的 usage = 这次请求的估算体量（校准比恒为 1） */
const sizeOf = (canon) => fixedEstimate(canon.system, canon.tools) + canon.messages.reduce((s, m) => s + messageEstimate(m), 0);
const toolCall = (canon, id, name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id, name, args }], usage: { inputTokens: sizeOf(canon), outputTokens: 30 } });
const QUESTION = { level: 2, text: '读完了，下一步要人定', blocked_by: '无', default_action: '照做', work_done: '读了五个文件', plan_after_answer: '按答复' };
/** 执行器：第 k 轮读第 k 个文件，读满 reads 个之后提问收尾 */
const reader = (reads, seen) => (canon, n) => {
  seen?.push([...canon.messages]);   // 快照：循环之后还会往同一个数组里追加
  if (n < reads) return toolCall(canon, `c${n}`, 'read_file', { path: `${'abcde'[n]}.txt` });
  return toolCall(canon, `q${n}`, 'raise_question', QUESTION);
};
const BRIEF = `## 目标
把五个文件读一遍。
## 已做
读了 a.txt。
## 试过但不行的路
无
## 下一步
接着读后面的文件。
## 相关文件
a.txt
b.txt`;
const textReply = (text) => ({ stopReason: 'end', content: [{ type: 'text', text }], usage: { inputTokens: 1000, outputTokens: 200 } });
const auditsOf = (db, nodeId, action) => db.all(`SELECT payload FROM audit_log WHERE action=? AND target_id=? ORDER BY id`, action, nodeId).map((r) => JSON.parse(r.payload));
const pairsIntact = (messages) => {
  for (let k = 1; k < messages.length; k++) {
    if (messages[k].role !== 'assistant') continue;
    const ids = messages[k].content.filter((b) => b.type === 'tool_call').map((b) => b.id);
    const next = messages[k + 1];
    if (!next || next.role !== 'tool_results') return false;
    if (ids.join() !== next.results.map((r) => r.callId).join()) return false;
  }
  return true;
};

// ═══════════════════════════════════════════════════════════════════════════
section('1. 整理线的生效值、保存时校验、不进触顶体检');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, userId } = fixture();
  eq(LIMITS['limit.compact_tokens'].on_hit, 'compact', '整理线不是上限：on_hit=compact');
  let c = compactThresholdOf(db, taskId);
  eq(c.at, 120_000, '默认 120k（实际运行峰值 106k 之上、上下文上限 150k 之下）');
  eq(c.source, 'default', '来源：部署默认');
  c = compactThresholdOf(db, taskId, { contextWindow: 128_000 });
  eq(c.at, Math.floor(128_000 * 0.75 * 0.8), '绑了 128k 窗口的模型：上下文上限 96k → 整理线压到它的八成');
  eq(c.source, 'model', '来源说清是模型窗口压下来的');
  setLimit(db, { taskId, key: 'limit.context_tokens', value: 100_000, userId });
  c = compactThresholdOf(db, taskId);
  eq(c.at, 80_000, '调低上下文上限（100k）不被整理线拦，运行时整理线自动压到 80k');
  eq(c.source, 'context', '来源：上下文上限');
  rejects(() => setLimit(db, { taskId, key: 'limit.compact_tokens', value: 100_000, userId }), '整理线不低于上下文上限 → 拒，说明整理会轮不到', /要低于单次请求上下文上限/);
  rejects(() => setLimit(db, { taskId, key: 'limit.compact_tokens', value: -1, userId }), '任务层负数 → 拒（原来任务层不查值）', /非负/);
  setLimit(db, { taskId, key: 'limit.compact_tokens', value: 0, userId });
  c = compactThresholdOf(db, taskId);
  eq(c.at, null, '0 = 关闭');
  eq(c.source, 'off', '来源：关闭');
  // 项目层：整理线允许 0，别的项照旧不许
  const projectId = newId('p');
  db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'P','/r','b','main','active',?)`, projectId, userId, now());
  setProjectLimit(db, { projectId, key: 'limit.compact_tokens', value: 0, userId });
  ok('项目层：整理线可以设成 0（关闭）');
  rejects(() => setProjectLimit(db, { projectId, key: 'limit.budget_micro_usd', value: 0, userId }), '项目层：别的上限照旧不许 0', /正数/);
  rejects(() => setProjectLimit(db, { projectId, key: 'limit.compact_tokens', value: 200_000, userId }), '项目层：整理线高于上下文上限 → 拒', /要低于/);
  // 体检：整理线永远不会让任务触顶
  for (let i = 0; i < 3; i++) audit(db, { actorKind: 'system', action: 'context_compacted', targetType: 'node', targetId: db.one(`SELECT id FROM nodes WHERE task_id=?`, taskId).id, payload: { level: 1 } });
  setLimit(db, { taskId, key: 'limit.compact_tokens', value: 1, userId });
  eq(LIMITS['limit.compact_tokens'].read(db, taskId), 3, '"用量"读的是这个任务整理过几次');
  eq(checkLimits(db, taskId, {})?.key === 'limit.compact_tokens', false, '整理次数 3 ≥ 整理线 1 也不触顶（checkLimits 跳过 compact 类）');
  eq(LIMITS['limit.compact_tokens'].fmt(0), '关闭', '0 显示成「关闭」');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 第 1 级：机械清理（批量门槛、保护最近两轮、占位行、落盘、幂等）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const ws = makeWorkspace('ws-l1');
  const big = 'x'.repeat(30_000);   // 约 8.6k token
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '开工' }] }];
  for (let k = 0; k < 5; k++) {
    const name = k === 1 ? 'run_command' : 'read_file';
    msgs.push({ role: 'assistant', content: [{ type: 'tool_call', id: `c${k}`, name, args: name === 'run_command' ? { file: 'npm', args: ['test'] } : { path: `f${k}.txt` } }] });
    msgs.push({ role: 'tool_results', results: [{ callId: `c${k}`, name, content: name === 'run_command' ? `exit=1\n--- stdout ---\n${big}\nFAIL last line` : big }] });
  }
  const L = 'zh';
  const est = (m) => m.reduce((s, x) => s + messageEstimate(x), 0);
  // 只有最旧两轮能清（最近两轮受保护）：2 × 8.6k = 17k < 20k → 不动
  const small = clearOldToolResults(msgs.slice(0, 7), { fixed: 0, ratio: 1, target: 0, workspace: ws, L });
  eq(small.cleared, 0, `能清掉的不到 ${CLEAR_AT_LEAST / 1000}k → 不动（清一次要重写缓存，值不回来）`);
  const r = clearOldToolResults(msgs, { fixed: 0, ratio: 1, target: est(msgs) - 15_000, workspace: ws, L });
  eq(r.cleared, 2, '够门槛：从最旧的清起，降到目标就停（清了 2 条）');
  assert(r.messages[2].results[0].compacted && r.messages[4].results[0].compacted && !r.messages[6].results[0].compacted, '清的是最旧的两条，第三条没动');
  assert(!r.messages[8].results[0].compacted && !r.messages[10].results[0].compacted, '最近两轮原样');
  assert(r.messages[2].results[0].content.includes('read_file f0.txt'), `read_file 占位行写路径：${r.messages[2].results[0].content.slice(0, 80)}`);
  const cmd = r.messages[4].results[0].content;
  assert(cmd.includes('npm test') && cmd.includes('exit=1') && cmd.includes('FAIL last line'), 'run_command 占位行留命令、退出码、最后 20 行');
  const saved = join(ws, OUTPUTS_DIR, 'c1.log');
  assert(existsSync(saved) && readFileSync(saved, 'utf8').includes('FAIL last line') && cmd.includes(`${OUTPUTS_DIR}/c1.log`), '命令全文落到工作区 .si-outputs/，占位行写着路径（清掉的东西有地方接手）');
  assert(msgs[2].results[0].content === big, '不改原数组（runToolLoop 的历史由调用方替换）');
  assert(pairsIntact(r.messages), '工具调用与结果的配对完整');
  eq(r.messages.length, msgs.length, '不删消息，只换内容');
  const again = clearOldToolResults(r.messages, { fixed: 0, ratio: 1, target: 0, workspace: ws, L });
  assert(!again.messages.slice(0, 5).some((m, k) => m !== r.messages[k] && k < 5), '已清过的不会再清（幂等）');
  assert(DEP_EXCLUDES.includes(`${OUTPUTS_DIR}/`), '.si-outputs/ 写进 git 排除：不算这一步的改动、不进提交');
  // 缓存断点：清理之后仍只有一个，挂在最后一条工具结果上
  const marked = markRollingCache(r.messages.slice());
  eq(marked.filter((m) => m.cache).length, 1, '滚动缓存断点仍只有一个');
  assert(marked.at(-1).cache === true, '断点在最后一条工具结果上（改写点之前的前缀照旧命中）');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. read_file 分段读（落盘的长输出、被截断的文件读得到后半段）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const ws = join(TMP, 'ws-read'); mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'long.log'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'));
  const h = makeHandlers(new LocalExecutor(), ws, []);
  const part = await h.read_file({ path: 'long.log', offset: 10, limit: 3 });
  assert(part.startsWith('line 10\nline 11\nline 12') && part.includes('第 10–12 行（共 50 行）'), `offset / limit 读一段，并说明是哪一段：${part.replace(/\n/g, '⏎').slice(0, 90)}`);
  eq(await h.read_file({ path: 'long.log' }), readFileSync(join(ws, 'long.log'), 'utf8'), '不带参数照旧读全文、不加说明');
  writeFileSync(join(ws, 'huge.txt'), Array.from({ length: 3000 }, (_, i) => `row ${i + 1} ${'y'.repeat(20)}`).join('\n'));
  const cut = await h.read_file({ path: 'huge.txt' });
  const m = cut.match(/用 offset 从第 (\d+) 行接着读/);
  assert(m, '被截断时告诉它从第几行接着读');
  const next = await h.read_file({ path: 'huge.txt', offset: Number(m[1]), limit: 2 });
  assert(next.startsWith(`row ${m[1]} `), `按提示接着读，接得上（第 ${m?.[1]} 行）`);
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 执行器：第 1 级在真实循环里生效（审计、下一轮请求里是占位行）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, userId } = fixture();
  const ws = makeWorkspace('ws-e1');
  // 四个文件读完约 3k + 4 × 11k ≈ 48k；整理线 45k：第 5 轮发之前，最旧两条（约 22k）够门槛
  setLimit(db, { taskId, key: 'limit.compact_tokens', value: 45_000, userId });
  const seen = [];
  const fake = makeRoleFake({ executor: reader(4, seen) });
  const client = new LlmClient({ mode: 'fake', fake });
  const r = await executeNode(db, { client, taskId, nodeId: n1, workspace: ws, tier: 'standard', vendorId: 'deepseek', narrativeDir: join(TMP, 'n-e1'), maxIterations: 8 });
  eq(r.kind, 'question', '照常走到提问收尾');
  const a = auditsOf(db, n1, 'context_compacted');
  eq(a.length, 1, '整理了一次');
  eq(a[0]?.level, 1, '第 1 级（没调模型）');
  assert(a[0]?.before >= 45_000 && a[0]?.after <= 45_000 * 0.6 + FILE_TOKENS, `前后体量都记下：${a[0]?.before} → ${a[0]?.after}`);
  eq(fake.calls.filter((c) => c.role === 'compactor').length, 0, '第 1 级够了就不调整理模型');
  const last = seen.at(-1);
  assert(last[2].results[0].compacted && String(last[2].results[0].content).includes('read_file a.txt'), '最后一次请求里，最早读的 a.txt 已是占位行');
  assert(String(last.at(-1).results[0].content).length > 30_000, '最近一轮的原文还在');
  assert(pairsIntact(last), '发出去的历史里工具调用与结果仍然成对');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4b. 验收员：只做第 1 级，不调模型写简报（它只跑十来轮，判断要看原文）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, userId } = fixture();
  const ws = makeWorkspace('ws-v1');
  setLimit(db, { taskId, key: 'limit.compact_tokens', value: 30_000, userId });
  const seen = [];
  const fake = makeRoleFake({
    verifier: (canon, n) => { seen.push([...canon.messages]);
      return n < 5 ? toolCall(canon, `v${n}`, 'read_file', { path: `${'abcde'[n]}.txt` }) : toolCall(canon, `v${n}`, 'submit_verdict', { verdict: 'pass', evidence_checked: ['a.txt'] }); },
    compactor: () => textReply(BRIEF),
  });
  const client = new LlmClient({ mode: 'fake', fake });
  await verifyHandoff(db, { client, taskId, nodeId: n1, workspace: ws, exec: new LocalExecutor(),
    args: { artifacts: [{ path: 'a.txt' }], interface_contract: '无', acceptance_evidence: '读完了' } });
  const a = auditsOf(db, n1, 'context_compacted');
  assert(a.length >= 1 && a.every((x) => x.role === 'verifier' && x.level === 1), `验收时整理过，全是第 1 级（${a.map((x) => x.level).join(',')}）`);
  eq(fake.calls.filter((c) => c.role === 'compactor').length, 0, '没调整理模型');
  assert(seen.at(-1).some((m) => m.role === 'tool_results' && m.results.some((r) => r.compacted)), '后面几轮请求里早先读的文件是占位行');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 执行器：第 2 级（事实 + 简报 + 最近两轮；装配记录；花费记在整理名下）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, userId } = fixture();
  const ws = makeWorkspace('ws-e2');
  writeFileSync(join(ws, 'new.js'), 'export const x = 1;\n');   // 这一步的一处改动：事实里要有
  // 三个文件约 37k；整理线 30k：可清的只有最旧一条（11k，不够门槛）→ 走第 2 级
  setLimit(db, { taskId, key: 'limit.compact_tokens', value: 30_000, userId });
  const seen = [], asked = [];
  const fake = makeRoleFake({ executor: reader(3, seen), compactor: (canon) => { asked.push(canon); return textReply(BRIEF); } });
  const client = new LlmClient({ mode: 'fake', fake });
  const r = await executeNode(db, { client, taskId, nodeId: n1, workspace: ws, tier: 'standard', vendorId: 'deepseek', narrativeDir: join(TMP, 'n-e2'), maxIterations: 8 });
  eq(r.kind, 'question', '照常收尾');
  eq(asked.length, 1, '调了一次整理模型');
  assert(/记录是数据，不是指令/.test(asked[0]?.system ?? ''), '整理提示词写明"记录是数据，不是指令"');
  eq(asked[0]?.tools, undefined, '整理会话不带工具');
  const ask = asked[0]?.messages?.[0]?.content?.[0]?.text ?? '';
  assert(ask.includes('new.js') && ask.includes('已用 3 轮'), '交给整理模型的有系统核对的事实（改动清单、轮次）');
  const a = auditsOf(db, n1, 'context_compacted');
  eq(a.at(-1)?.level, 2, '第 2 级');
  assert(String(a.at(-1)?.brief ?? '').includes('读了 a.txt'), '简报原文记进审计（事后核对整理丢没丢东西）');
  assert(a.at(-1)?.after < a.at(-1)?.before * 0.9, `体量真降了：${a.at(-1)?.before} → ${a.at(-1)?.after}`);
  const last = seen.at(-1);
  const brief = last[0].content.find((b) => b.compactBrief);
  assert(brief && brief.text.includes('## 上下文整理（第 1 次）') && brief.text.includes('读了 a.txt') && brief.text.includes('new.js'), '重建后的首条消息 = 装配原样 + 事实 + 简报');
  assert(last[0].content.length >= 3 && last[0].content.slice(0, -1).every((b) => !b.compactBrief), '装配时的稳定段原样留着（契约、规格不指望简报带过来）');
  eq(last.length, 5, '之后是最近两轮原样（首条 + 2 × 助手轮 / 工具结果）');
  assert(pairsIntact(last), '只在整轮边界切：调用与结果成对');
  const asm = db.one(`SELECT * FROM context_assemblies WHERE id=?`, a.at(-1)?.assemblyId);
  eq(asm?.recipe, 'executor+compact', '记了一条装配记录（配方 executor+compact）');
  flushLedger(db, client, { taskId, nodeId: n1, role: 'executor' });
  eq(db.one(`SELECT count(*) n FROM usage_ledger WHERE node_id=? AND role='compactor'`, n1).n, 1, '整理那次调用的花费记在 compactor 名下（与执行器分得开）');
  assert(SESSIONS.compactor && SESSIONS.compactor.tools.length === 0 && 'compactor' in LLM_ROLES, '整理会话登记在能力表与角色表里（没工具、不碰凭据）');
  rejects(() => assertSessionTools('compactor', [{ name: 'run_command' }]), '给整理会话工具 → 拒');
  // 第二次整理时简报整体重写：上一份简报交给整理模型，首条消息里只有一份简报
  assert(db.one(`SELECT context_tokens FROM briefings WHERE node_id=? ORDER BY recorded_at DESC LIMIT 1`, n1)?.context_tokens > 0, '挂起时的上下文体量记下了（原来账本每轮被清空，这里是 null）');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 第 2 级失败：简报不合格、没效果 → 放弃，照原样接着做，不再试');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, userId } = fixture();
  const ws = makeWorkspace('ws-e3');
  setLimit(db, { taskId, key: 'limit.compact_tokens', value: 30_000, userId });
  const fake = makeRoleFake({ executor: reader(4), compactor: () => textReply('## 目标\n读文件\n## 相关文件\nnot/here.js') });
  const client = new LlmClient({ mode: 'fake', fake });
  const r = await executeNode(db, { client, taskId, nodeId: n1, workspace: ws, tier: 'standard', vendorId: 'deepseek', narrativeDir: join(TMP, 'n-e3'), maxIterations: 8 });
  eq(r.kind, 'question', '整理失败不打断这一步');
  eq(fake.calls.filter((c) => c.role === 'compactor').length, 2, '不合格时带着问题重写一次，一共两次');
  const f = auditsOf(db, n1, 'context_compaction_failed');
  eq(f[0]?.why, 'brief_invalid', '记下失败原因');
  assert(f[0]?.problems?.some((p) => p.includes('试过但不行的路')) && f[0]?.problems?.some((p) => p.includes('not/here.js')), '校验查出缺节、引用了不存在的文件');
  eq(auditsOf(db, n1, 'context_compacted').filter((x) => x.level === 2).length, 0, '没有算作整理过');
  // checkBrief 单独
  eq(checkBrief(BRIEF, { workspace: ws }).length, 0, '合格的简报过校验');
  eq(checkBrief(BRIEF.replace('b.txt', 'gone.txt'), { workspace: ws, changed: new Set(['gone.txt']) }).length, 0, '这一步删掉的文件（在改动清单里）不算编造');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. 同一步骤整理到顶 → 转成问题交人（不再无限整理）；答复之后重新计');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, userId } = fixture();
  const ws = makeWorkspace('ws-e4');
  setLimit(db, { taskId, key: 'limit.compact_tokens', value: 30_000, userId });
  for (let i = 0; i < MODEL_COMPACTIONS_PER_STEP; i++) audit(db, { actorKind: 'system', action: 'context_compacted', targetType: 'node', targetId: n1, payload: { level: 2 } });
  const fake = makeRoleFake({ executor: reader(4), compactor: () => textReply(BRIEF) });
  const client = new LlmClient({ mode: 'fake', fake });
  const r = await executeNode(db, { client, taskId, nodeId: n1, workspace: ws, tier: 'standard', vendorId: 'deepseek', narrativeDir: join(TMP, 'n-e4'), maxIterations: 8 });
  eq(r.kind, 'question', '转成问题');
  assert(/建议拆成两步/.test(r.question?.text ?? ''), `问题说清：这一步多半太大，建议拆（${(r.question?.text ?? '').slice(0, 60)}…）`);
  eq(r.question?.level, 2, 'Ⅱ 级');
  eq(fake.calls.filter((c) => c.role === 'compactor').length, 0, '到顶了就不再调整理模型');
  eq(auditsOf(db, n1, 'compaction_escalated').length, 1, '记审计 compaction_escalated');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'blocked', '节点挂起等人');
  // 答复之后再跑：次数从 compaction_escalated 之后重新计 → 又能整理
  const c2 = makeCompactor(db, { client, taskId, nodeId: n1, tier: 'standard', workspace: ws, at: 30_000, levels: [1, 2], escalate: () => 'x' });
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '开工' }] }];
  for (const k of [0, 1, 2]) { msgs.push({ role: 'assistant', content: [{ type: 'tool_call', id: `r${k}`, name: 'read_file', args: { path: `${'abc'[k]}.txt` } }] }); msgs.push({ role: 'tool_results', results: [{ callId: `r${k}`, name: 'read_file', content: 'z'.repeat(39_000) }] }); }
  const b = await c2.beforeRequest(msgs, 3);
  assert(!b.stop && b.messages?.[0]?.content?.some((x) => x.compactBrief), '人答复过之后（审计在 compaction_escalated 之后）重新计数，照常整理');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7b. 第 2 级的事实从库里补：这一步开工之后别处新登记的决定与假设');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1 } = fixture();
  const t0 = now() - 60_000;
  db.run(`UPDATE nodes SET started_at=? WHERE id=?`, t0, n1);
  const ins = (id, nodeId, summary, at) => db.run(`INSERT INTO decisions (id,task_id,node_id,summary,rationale,actor_kind,layer,valid_from,recorded_at) VALUES (?,?,?,?,'r','agent','execution',?,?)`, id, taskId, nodeId, summary, at, at);
  ins('d_old', null, '开工前就有的决定', t0 - 1000);        // 装配里已经给过
  ins('d_new', null, '导出时间一律用 UTC', t0 + 1000);      // 开工后别处登记的
  ins('d_mine', n1, '本步自己的决定', t0 + 2000);           // 本步自己的（不会出现：本步的要到交接才落库，这里只是兜底排除）
  db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,valid_from,recorded_at) VALUES ('as_new',?,NULL,'csv.delimiter','分隔符用逗号','active',?,?)`, taskId, t0 + 3000, t0 + 3000);
  const asked = [];
  const client = new LlmClient({ mode: 'fake', fake: makeRoleFake({ compactor: (canon) => { asked.push(canon); return textReply(BRIEF); } }) });
  const c = makeCompactor(db, { client, taskId, nodeId: n1, tier: 'standard', workspace: makeWorkspace('ws-e7b'), at: 30_000, levels: [2] });
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '开工' }] }];
  for (const k of [0, 1, 2]) { msgs.push({ role: 'assistant', content: [{ type: 'tool_call', id: `q${k}`, name: 'read_file', args: { path: `${'abc'[k]}.txt` } }] }); msgs.push({ role: 'tool_results', results: [{ callId: `q${k}`, name: 'read_file', content: 'z'.repeat(39_000) }] }); }
  const b = await c.beforeRequest(msgs, 3);
  const block = b.messages?.[0]?.content?.find((x) => x.compactBrief)?.text ?? '';
  const ask = asked[0]?.messages?.[0]?.content?.[0]?.text ?? '';
  assert(block.includes('导出时间一律用 UTC') && block.includes('csv.delimiter') && block.includes('分隔符用逗号'), '重建后的事实里有开工后别处新登记的决定与假设');
  assert(ask.includes('导出时间一律用 UTC'), '整理模型也看得到（写简报时不会和它矛盾）');
  assert(!block.includes('开工前就有的决定') && !block.includes('本步自己的决定'), '开工前的（装配里已有）和本步自己的不重复列');
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. 闸门看整理之后的体量；整理器可以叫停；软提醒只加在末尾、只加一次');
// ═══════════════════════════════════════════════════════════════════════════
{
  const seenInfo = [];
  const client = new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor: (canon, n) => (n < 3 ? toolCall(canon, `k${n}`, 'list_dir', {}) : textReply('完')) }) });
  const stub = { beforeRequest: async (_m, i) => ({ nextTokens: 1000 + i }), observe: () => {} };
  await runToolLoop(client, { role: 'executor', system: 's', tools: [{ name: 'list_dir', parameters: {} }], messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] },
    { list_dir: async () => 'x' }, { maxIterations: 5, compactor: stub, abort: (i, info) => { seenInfo.push(info.nextTokens); return null; } });
  eq(seenInfo.join(), '1000,1001,1002,1003', '闸门拿到的是整理之后这一轮要发出去的体量（nextTokens）');
  const stopper = { beforeRequest: async (_m, i) => (i === 1 ? { stop: 'compaction_escalated' } : {}), observe: () => {} };
  const client2 = new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor: (canon, n) => toolCall(canon, `s${n}`, 'list_dir', {}) }) });
  const lp = await runToolLoop(client2, { role: 'executor', system: 's', tools: [{ name: 'list_dir', parameters: {} }], messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }] },
    { list_dir: async () => 'x' }, { maxIterations: 5, compactor: stopper });
  eq(lp.stopped, 'terminal_tool', '整理器叫停 → 按终结性工具收尾（问题已由执行器挂出）');
  // 软提醒
  const { db, taskId, n1 } = fixture();
  const cz = makeCompactor(db, { client, taskId, nodeId: n1, tier: 'standard', at: 10_000, levels: [1] });
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }, { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'read_file', args: { path: 'x' } }] },
    { role: 'tool_results', results: [{ callId: 'a', name: 'read_file', content: 'q'.repeat(30_000) }] }];
  const b1 = await cz.beforeRequest(msgs, 1);
  assert(String(b1.messages?.at(-1)?.results[0].content).includes('接近自动整理线'), '到整理线的八成：在最后一条工具结果末尾提醒一句（不伤缓存）');
  assert(b1.messages?.[1] === msgs[1], '前面的消息原样（同一个对象）');
  const b2 = await cz.beforeRequest(b1.messages, 2);
  eq(b2.messages, undefined, '同一段里只提醒一次');
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. 关闭时：没有整理器，行为与以前一样');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, userId } = fixture();
  const ws = makeWorkspace('ws-off');
  setLimit(db, { taskId, key: 'limit.compact_tokens', value: 0, userId });
  const fake = makeRoleFake({ executor: reader(4) });
  const client = new LlmClient({ mode: 'fake', fake });
  const r = await executeNode(db, { client, taskId, nodeId: n1, workspace: ws, tier: 'standard', vendorId: 'deepseek', narrativeDir: join(TMP, 'n-off'), maxIterations: 8 });
  eq(r.kind, 'question', '照常收尾');
  eq(auditsOf(db, n1, 'context_compacted').length + auditsOf(db, n1, 'context_compaction_failed').length, 0, '关掉之后一次都不整理');
  eq(limitOf(db, taskId, 'limit.compact_tokens'), 0, '任务层设成 0');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
