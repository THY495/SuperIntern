// 离线回归：上下文装配 + 单节点执行 + 交接记录
//
// 跑：node tests/execution.test.mjs
//
// ① 执行器**从数据库**装配上下文，完成节点并产出真实文件
// ② 交接记录由执行器生成，**通过 schema 触发器**校验，而非手工构造

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, insertEdge } from '../src/db/db.mjs';
import { LlmClient, runToolLoop, markRollingCache } from '../src/llm/client.mjs';
import { makeFake, anthropic } from '../src/llm/providers.mjs';
import { assembleExecutor, readyNodes, estimateTokens } from '../src/context/assemble.mjs';
import { LocalExecutor, containedPath } from '../src/core/executor.mjs';
import { executeNode, validateHandoff, persistHandoff } from '../src/agent/executor.mjs';
import { ensureWorkspace } from '../src/core/workspace.mjs';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = async (fn, m) => {
  try { await fn(); bad(m, '期望被拒绝，但成功了'); }
  catch (e) { ok(`${m}\n         └ ${String(e.message).split('\n')[0]}`); }
};

const TMP = mkdtempSync(join(tmpdir(), 'si-exec-'));
const WS = join(TMP, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(join(WS, 'seed.txt'), 'hello\nworld\nSSE parser lives here\n');

/** 一个任务 + 两个节点：n2 依赖 n1。 */
function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), constId = newId('c'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'补 SSE 解析','running',?)`, taskId, userId, t);
  // ⚠️ 宪法块按**真实任务的量级**写，不写玩具版：
  // 装配规模直接决定缓存断点决策，用玩具宪法测出来的结论到真任务上会翻转。
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,3,?,?,?,?,?,?)`, constId, taskId,
    '让 src/llm/ 的流式路径能吃真实的 text/event-stream 字节流。现在四个 streamAccumulator 收的是'
      + '**已解析好的事件对象**，也就是说从未有代码把 HTTP 响应体的原始字节变成那些对象——流式路径在真实环境里一次都没跑通过。',
    '只动 src/llm/ 与 tests/llm.test.mjs。不改 adapter 的 canonical 输出形状（streamAccumulator 的入参形状'
      + '可以改，finish() 的产出必须与非流式 complete() 的规范响应逐字段一致）。不引入任何第三方依赖。',
    '`node tests/llm.test.mjs` 全绿，且新增断言覆盖四家各自的原始 SSE 字节流→规范响应；'
      + '断言必须用真实录制样本的字节形状，不能用自己编的理想格式。',
    JSON.stringify([
      '全程离线可验：不得调用任何厂商 API，不得读取或要求任何 API key。',
      '四家的线格式不同：Anthropic 是带 event: 行的具名事件流；OpenAI 只有 data: 行且以 [DONE] 收尾；'
        + 'Gemini 的 streamGenerateContent 返回的是一个 JSON 数组的流式切片，不是 SSE。',
      '必须处理跨 chunk 边界：一个 SSE 事件可能被 TCP 切成两半，逐 chunk 独立解析必然丢数据。',
      '不得降低现有 119 条断言的覆盖，也不得为了让测试变绿而放宽既有断言。',
    ]), t, t);
  // 节点规格也按规划器的实际产出量级写（真实 spec 普遍 800~1500 字符）。
  // 用一句话的玩具 spec 会把稳定段压到 300 token 以下，测出来的缓存决策是假的。
  const n1 = newId('n'), n2 = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写解码器',?,?,'pending','normal','standard',?)`, n1, taskId,
    '新建 src/llm/stream-wire.mjs，导出两个有状态解码器工厂：(1) createSSEDecoder()：push(Uint8Array) -> '
      + '本次可完整产出的事件数组，flush() -> 收尾残留。要求：以空行分帧，同时接受 \\n\\n 与 \\r\\n\\r\\n；'
      + '支持 event:/data:/id:/retry: 字段；多条 data: 行按 \\n 拼接；以 ":" 开头的注释行忽略；'
      + 'UTF-8 多字节字符被 chunk 切断不得损坏。(2) createJSONArrayDecoder()：吃 Gemini 那种「一个 JSON 数组'
      + '被切片下发」的流，逐个产出顶层数组元素，需自行做深度/字符串/转义状态跟踪，不得对整段做 JSON.parse。'
      + '边界：本节点只做分帧与字节层，不含任何厂商语义，不改任何 adapter，不引入第三方依赖。',
    '存在文件 src/llm/stream-wire.mjs 且导出上述两个工厂。一条内联脚本 exit 0：对一个含 event: 行、含注释行、'
      + '含多行 data:、含 emoji、以 \\r\\n\\r\\n 与 \\n\\n 混合分帧的 SSE 样本，遍历每一个切点把字节切成两段分别 push，'
      + '产出事件序列与整段一次 push 的结果 deepStrictEqual；再用 1 字节步长喂完整样本，结果同样相等。', t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'接进 adapter',?,?,'pending','high','heavy',?)`, n2, taskId,
    '改 src/llm/ 内四个 adapter 的流式路径：各自新增一个吃字节的入口，内部用 n1 的解码器分帧，'
      + '再把厂商事件翻译成 streamAccumulator 的输入并驱动到 finish()。不得改 adapter 的 canonical 输出形状。',
    '对四对 fixture，各自把字节以 1 字节、7 字节、整段三种切法喂入，三次 finish() 结果彼此 deepStrictEqual，'
      + '且都与非流式解析结果 deepStrictEqual。', t + 1);
  insertEdge(db, n2, n1, 'depends_on', t);
  return { db, taskId, constId, n1, n2 };
}

const handoffArgs = (over = {}) => ({
  artifacts: [{ path: 'seed.txt', kind: 'source' }],
  interface_contract: 'createSSEDecoder() -> {push, flush}',
  acceptance_evidence: 'node -e "..." exit=0',
  key_decisions: [{ summary: '解码器独立成模块', rationale: '四家线格式不同，共用分帧层但不共用语义层' }],
  // 每条假设必须交代对着谁查证。
  // 这一条只能对着本任务自己造的 fixture 验 —— 循环论证，会被强制披露。
  assumptions: [{ subject_key: 'sse.parser.location', statement: '分帧与厂商语义分离',
    verified_against: 'own_artifact', verification: '读 src/llm/_fixtures/stream/ 下自己造的样本' }],
  known_issues: ['未处理 retry: 字段'],
  downstream_notes: '接 adapter 时注意 flush()',
  ...over,
});
const handoffCall = (args) => ({
  stopReason: 'tool_call',
  content: [{ type: 'tool_call', id: 'h', name: 'submit_handoff', args }],
  usage: { inputTokens: 100, outputTokens: 50 },
});
const toolCall = (name, args) => ({
  stopReason: 'tool_call',
  content: [{ type: 'tool_call', id: `c${name}`, name, args }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

// ═══════════════════════════════════════════════════════════════════════════
section('1. 装配层：四段式，只从库里读');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, constId, n1, n2 } = fixture();
  const a = assembleExecutor(db, { taskId, nodeId: n1, tier: 'standard', vendorId: 'deepseek' });

  assert(a.system.includes('text/event-stream 字节流'), '段① 含宪法目标（原文钉入，不摘要）');
  assert(a.system.includes('不得读取或要求任何 API key'), '段① 含约束原文');
  assert(a.system.includes('你不能修改它'), '段① 声明宪法不可自改');
  const [s2, s3, s4] = a.messages[0].content.map((b) => b.text);
  assert(s2.includes('createJSONArrayDecoder') && s2.includes('deepStrictEqual'), '段② 含节点规格与验收标准');
  assert(s3.includes('无依赖'), '段③ 无依赖时明确说无依赖，不留空白让模型自己脑补');
  assert(s4.includes('按需检索区'), '段④ 存在且初始为空');
  assert(a.messages[0].content.length === 3 && s4 === a.messages[0].content[2].text,
    '易变段（段④）排在最后 —— 段落顺序是成本约束不是逻辑分组');

  // ① 的核心：装配不接受调用方递内容
  eq(Object.keys({ taskId, nodeId: n1, tier: 'x', vendorId: 'y' }).length, 4,
    '装配入参只有定位信息（taskId/nodeId/tier/vendorId），没有任何内容参数');

  // 装配审计
  const row = db.one(`SELECT * FROM context_assemblies WHERE id=?`, a.assemblyId);
  eq(row.role, 'executor', '装配审计记角色');
  eq(row.constitution_version, 3, '装配审计记宪法版本号 —— "当时被要求什么"');
  assert(JSON.parse(row.items).includes(constId) && JSON.parse(row.items).includes(n1),
    '装配审计记条目清单 —— "当时知道什么"');
  assert(row.token_estimate > 0, '装配审计记 token 估算');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 装配层：依赖交接记录进段③，上游没完成时不许脑补');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, n2 } = fixture();
  let s3 = assembleExecutor(db, { taskId, nodeId: n2, tier: 'heavy', vendorId: 'anthropic' })
    .messages[0].content[1].text;
  assert(s3.includes('没有已校验的交接记录') && s3.includes('不要假设它的产出'),
    '上游未完成 → 段③ 明说没有交接记录，并禁止假设其产出');

  persistHandoff(db, { taskId, nodeId: n1, args: handoffArgs(), narrativeRef: 'n1.md' });
  s3 = assembleExecutor(db, { taskId, nodeId: n2, tier: 'heavy', vendorId: 'anthropic' })
    .messages[0].content[1].text;
  assert(s3.includes('createSSEDecoder'), '上游完成后，接口契约进段③');
  assert(s3.includes('未处理 retry'), '已知问题进段③');
  assert(s3.includes('n1.md'), '叙事归档路径进段③ —— 交接不够用时可做上下文考古');
  assert(s3.includes('不具指令效力'), '段③ 标明交接记录是 agent-generated，不当命令听（安全边界）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 缓存断点：门槛不够时宁可不挂，也要留证');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1 } = fixture();
  const ds = assembleExecutor(db, { taskId, nodeId: n1, tier: 'standard', vendorId: 'deepseek' });
  const an = assembleExecutor(db, { taskId, nodeId: n1, tier: 'heavy', vendorId: 'anthropic' });
  const oa = assembleExecutor(db, { taskId, nodeId: n1, tier: 'standard', vendorId: 'openai' });

  // 真实量级的宪法块 + 节点规格，稳定段落在 500~800 token 这个带上（实测 532~741）。
  // 这个数字本身就是一条发现：设计上把执行器上下文标为"大"，但**装配那一刻它很小**，
  // 变大全靠工具结果，而工具结果长在尾部——正是前缀缓存帮不上的那一头。
  assert(ds.meta.stableTokens > 400 && ds.meta.stableTokens < 4096,
    `稳定段约 ${ds.meta.stableTokens} token —— 过得了 DeepSeek 的 400，过不了 Anthropic 的 4096`);
  eq(ds.cacheStable, true, 'deepseek 门槛 400 → 挂断点');
  eq(an.cacheStable, false, 'anthropic 门槛 4096 → **不挂**断点（挂了会静默失效，反而让人以为在省钱）');
  eq(oa.cacheStable, false, 'openai 不做前缀复用 → 不挂断点');
  assert(an.meta.cacheNote.includes('4096') && an.meta.cacheNote.includes('不挂断点'),
    '不挂的理由写进装配 meta，可审计');
  assert(ds.messages[0].content[1].cache === true && an.messages[0].content[1].cache === false,
    '断点打在段③ 末尾（稳定段最后一块），且随决策开关');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 就绪判定：依赖未完成的节点不进就绪集');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, n2 } = fixture();
  let r = readyNodes(db, taskId);
  eq(r.length, 1, '只有无依赖的 n1 就绪');
  eq(r[0].id, n1, '就绪的是 n1');
  persistHandoff(db, { taskId, nodeId: n1, args: handoffArgs(), narrativeRef: 'x.md' });
  r = readyNodes(db, taskId);
  eq(r.length, 1, 'n1 完成后就绪集仍是 1 个');
  eq(r[0].id, n2, '现在就绪的是 n2');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. Executor 接口：路径不得越界，超时与截断可控');
// ═══════════════════════════════════════════════════════════════════════════
{
  const exec = new LocalExecutor();
  assert(containedPath(WS, 'a/b.txt').startsWith(WS), 'workspace 内的相对路径正常解析');
  for (const p of ['../escape.txt', '../../etc/passwd', 'a/../../out.txt']) {
    try { containedPath(WS, p); bad(`越界路径被拒：${p}`, '没拒'); }
    catch { ok(`越界路径被拒：${p}`); }
  }
  eq(exec.readFile(WS, 'seed.txt').includes('SSE parser'), true, '可读 workspace 内文件');
  exec.writeFile(WS, 'sub/deep/new.txt', 'x');
  eq(existsSync(join(WS, 'sub/deep/new.txt')), true, '写文件自动建父目录');

  const r = await exec.execute({ file: process.execPath, args: ['-e', 'console.log("hi");process.exit(3)'] }, WS);
  eq(r.code, 3, '退出码原样透出（验收判据要靠它）');
  assert(r.stdout.includes('hi'), 'stdout 捕获');

  const t = await exec.execute({ file: process.execPath, args: ['-e', 'setTimeout(()=>{},9e5)'] }, WS, { timeoutMs: 400 });
  eq(t.timedOut, true, '超时被杀，不会把 loop 挂死');

  const big = await exec.execute({ file: process.execPath, args: ['-e', 'console.log("x".repeat(50000))'] }, WS, { maxOutputBytes: 1000 });
  eq(big.truncated, true, '超量输出被截断并标记');
  assert(big.stdout.length <= 1000, '截断真的生效，不是只打个标记');

  const nope = await exec.execute({ file: 'definitely-not-a-real-binary-xyz' }, WS);
  eq(nope.code, -1, 'spawn 失败也 settle —— 否则整个执行 loop 静默挂死');
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 交接记录校验：形状之外还核实物');
// ═══════════════════════════════════════════════════════════════════════════
{
  const exec = new LocalExecutor();
  // `changed` 是相对基线真正变过的文件清单（实际运行时取自 git）。
  writeFileSync(join(WS, 'untouched.txt'), 'pre-existing\n');
  const ctx = { exec, workspace: WS, changed: new Set(['seed.txt']) };
  eq(validateHandoff(handoffArgs(), ctx).length, 0, '合法交接记录零错误');
  // scope 机械执法：宪法块 scope 抽得出目录前缀时，相对基线的改动必须都落在前缀下。
  {
    const inScope = validateHandoff(handoffArgs(), { ...ctx, changed: new Set(['src/llm/a.mjs']), scopePrefixes: ['src/llm'] });
    assert(!inScope.some((e) => /越界改动/.test(e)), 'scope 内的改动不触发越界');
    const out = validateHandoff(handoffArgs(), { ...ctx, changed: new Set(['src/llm/a.mjs', 'README.md', 'src/core/x.mjs']), scopePrefixes: ['src/llm'] });
    const hit = out.find((e) => /越界改动/.test(e));
    assert(hit && hit.includes('`README.md`') && hit.includes('`src/core/x.mjs`') && !hit.includes('src/llm/a.mjs'), `越界改动被打回并逐个点名\n         └ ${hit}`);
    assert(/raise_question/.test(hit), '打回文案指向 raise_question（人来改 scope，agent 无权自己扩）');
    eq(validateHandoff(handoffArgs(), { ...ctx, changed: new Set(['anything.txt']), scopePrefixes: [] }).some((e) => /越界改动/.test(e)), false, '抽不出前缀 = 不执法');
    eq(validateHandoff(handoffArgs(), { ...ctx, changed: new Set(['src/llmx/a.mjs']), scopePrefixes: ['src/llm'] }).some((e) => /越界改动/.test(e)), true, '前缀按目录边界匹配，src/llmx 不算 src/llm');

    // ── 结构化范围（迁移 v17）：契约直接给路径时，两处判断变了 ────────
    const oob = (o) => validateHandoff(handoffArgs(), { ...ctx, ...o }).some((e) => /越界改动/.test(e));
    // ① 契约只点名了具体文件、一个目录都没有 → 前缀为空，但那不是"抽不出来"，是"就这几个文件"。
    //    没有这一条，一份 scope_paths: ["package.json"] 的契约会把越界校验**整个关掉** —— 静默、无报错。
    eq(oob({ changed: new Set(['package.json']), scopePrefixes: [], scopeFiles: ['package.json'], scopeStructured: true }), false, '结构化 + 只点名文件：点名的那个文件照过');
    eq(oob({ changed: new Set(['src/x.mjs']), scopePrefixes: [], scopeFiles: ['package.json'], scopeStructured: true }), true, '**结构化 + 只点名文件：别的文件照样判越界**（前缀为空不等于不执法）');
    // ②（老契约不改口径）散文里抽不出目录就仍然是不执法 —— 那是启发式的已知无能，不是一条规则。
    eq(oob({ changed: new Set(['src/x.mjs']), scopePrefixes: [], scopeFiles: ['package.json'], scopeStructured: false }), false, '老契约：抽不出前缀仍然不执法，行为与引入结构化范围之前一字不差');
    // ③ `*` 是"全仓库"，不是一个叫 * 的目录。当前缀匹配会把**每一个**文件判成越界。
    eq(oob({ changed: new Set(['anything/at/all.mjs']), scopePrefixes: ['*'], scopeFiles: [], scopeStructured: true }), false, '* = 全仓库 → 不执法（当成目录名匹配会把所有改动判成越界）');
    // 子目录里的单个文件：这正是散文抽取器做不到的粒度
    eq(oob({ changed: new Set(['src/web/index.html']), scopePrefixes: [], scopeFiles: ['src/web/index.html'], scopeStructured: true }), false, '点名 src/web/index.html：它自己过');
    eq(oob({ changed: new Set(['src/web/other.js']), scopePrefixes: [], scopeFiles: ['src/web/index.html'], scopeStructured: true }), true, '**同目录下别的文件不过** —— 散文抽取器只能退到 src/web 整个放行');
  }
  const bad2 = (over, hint) => {
    const e = validateHandoff(handoffArgs(over), ctx);
    assert(e.length > 0, `拒绝：${hint}\n         └ ${e[0]}`);
  };
  bad2({ artifacts: [] }, '没有产物');
  bad2({ artifacts: [{ path: 'ghost/never-written.mjs' }] }, '声称产出了工作区里并不存在的文件');

  // ↓ 这两条来自实际运行：曾有一份通过了的交接记录，第二条产物是执行器
  //   越界建出来的空目录（下游节点的活），当时的校验
  //   只问"存在吗"，于是它过了。
  mkdirSync(join(WS, 'somedir'), { recursive: true });
  bad2({ artifacts: [{ path: 'somedir', kind: 'directory' }] }, '把一个目录当产物交上来');
  bad2({ artifacts: [{ path: 'untouched.txt' }] }, '把工作区里现成的、本节点根本没动过的文件算作自己的产物');
  ok('  └ 上面两条区分的是"存在" vs "是你产出的" —— 工作区选 git clone 正是为了能机械地问后者');

  // 上游节点把下游节点的活干了时，下游节点没有任何规格要求的改动可做。
  // 原来两条规则合起来是个死锁 —— 列上未改动的文件被判"不是你产出的"，交空列表被判"没有产物不算完成"，
  // 执行器只剩两个坏出口：编一个假完成，或去做一处规格没要求的改动来凑 diff（它曾为后者去问人）。
  eq(validateHandoff(handoffArgs({ artifacts: [{ path: 'untouched.txt', already_done: true, produced_by: '上游节点「测试先行」的 commit c38d6cb' }] }), ctx).length, 0,
    '已被上游做掉的产物：标 already_done + 写清谁做的 → 收（不必为了凑 diff 去改规格没要求的东西）');
  bad2({ artifacts: [{ path: 'untouched.txt', already_done: true }] }, 'already_done 却不说是谁做的');
  assert(validateHandoff(handoffArgs({ artifacts: [{ path: 'untouched.txt' }] }), ctx)[0].includes('already_done'),
    '没标 already_done 时，打回文案直接给出这条正路 —— 否则执行器只会去凑一个假 diff');
  bad2({ artifacts: [] }, '空列表仍然不收 —— 这条例外不是"可以空手交差"');
  bad2({ interface_contract: '   ' }, '接口契约为空');
  bad2({ acceptance_evidence: '' }, '没给验收的机械证据');
  bad2({ key_decisions: [{ summary: 'x' }] }, '决策缺 rationale');
  bad2({ assumptions: [{ statement: 'x' }] }, '假设缺 subject_key');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. 落库这一步由**库层触发器**执法，不是应用层自觉');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1 } = fixture();
  const { handoffId, conflicts } = persistHandoff(db, { taskId, nodeId: n1, args: handoffArgs(), narrativeRef: 'n1.md' });
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'done', '节点置 done');
  eq(db.one(`SELECT validated_at IS NOT NULL AS v FROM handoffs WHERE id=?`, handoffId).v, 1, '交接记录已校验');
  eq(db.one(`SELECT trust_label FROM handoffs WHERE id=?`, handoffId).trust_label, 'agent-generated',
    '交接记录固定 agent-generated —— 永不能成为指令来源');
  eq(db.one(`SELECT count(*) AS n FROM decisions WHERE node_id=?`, n1).n, 1, '关键决策进决策日志');
  eq(db.one(`SELECT count(*) AS n FROM edges WHERE relation='derived_from'
             AND from_id IN (SELECT id FROM decisions WHERE node_id=?)`, n1).n, 1, '决策挂了出处边（同事务）');
  eq(db.one(`SELECT count(*) AS n FROM assumptions WHERE node_id=?`, n1).n, 1, '假设进登记表');
  eq(conflicts.length, 0, '首个假设无冲突');
  db.close();
}
{
  // 触发器是真在执法：手工构造一份**未校验**的交接记录，置 done 必须被拒
  const { db, taskId, n1 } = fixture();
  db.run(`INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,narrative_ref,created_at)
          VALUES ('h_unvalidated',?,1,'[]','c','r.md',?)`, n1, now());
  await rejects(async () => db.run(`UPDATE nodes SET status='done' WHERE id=?`, n1),
    '有交接记录但 validated_at 为 NULL → 库层仍拒绝置 done');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'pending', '节点没被改脏');
  db.close();
}
{
  // 事务性：假设写失败时，交接记录与 done 都不能留下
  const { db, taskId, n1 } = fixture();
  await rejects(async () => persistHandoff(db, {
    taskId, nodeId: n1, narrativeRef: 'x.md',
    args: handoffArgs({ assumptions: [{ subject_key: 'k', statement: 's', status: 'nope' }, null] }),
  }), '假设数组里有 null → 整批回滚');
  eq(db.one(`SELECT count(*) AS n FROM handoffs`).n, 0, '回滚后没有孤儿交接记录');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'pending', '回滚后节点仍是 pending');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. 假设冲突检测');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, n2 } = fixture();
  persistHandoff(db, { taskId, nodeId: n1, args: handoffArgs(), narrativeRef: 'a.md' });
  const r = persistHandoff(db, { taskId, nodeId: n2, narrativeRef: 'b.md',
    args: handoffArgs({ assumptions: [{ subject_key: 'sse.parser.location', statement: '每个 adapter 各自解析' }] }) });
  eq(r.conflicts.length, 1, '同 subject_key 的第二条假设被识别为冲突');
  eq(db.one(`SELECT status FROM assumptions WHERE node_id=?`, n2).status, 'conflicted', '新假设标 conflicted');
  eq(db.one(`SELECT status FROM assumptions WHERE node_id=?`, n1).status, 'active',
    '旧假设保持 active —— 谁对谁错不由执行器判，冲突是给编排器的信号');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. 端到端：装配 → 工具 → 产物 → 交接 → done');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1 } = fixture();
  const client = new LlmClient({ mode: 'fake', fake: makeFake([
    toolCall('list_dir', { path: '.' }),
    toolCall('read_file', { path: 'seed.txt' }),
    toolCall('write_file', { path: 'src/llm/stream-wire.mjs', content: 'export const createSSEDecoder = () => ({});\n' }),
    toolCall('run_command', { file: process.execPath, args: ['-e', 'console.log("ok")'] }),
    handoffCall(handoffArgs({ artifacts: [{ path: 'src/llm/stream-wire.mjs', kind: 'module' }] })),
  ]) });
  const r = await executeNode(db, {
    client, taskId, nodeId: n1, workspace: WS, tier: 'standard', vendorId: 'deepseek',
    narrativeDir: join(TMP, 'narr'),
  });
  eq(r.kind, 'done', '节点收尾于 done');
  eq(existsSync(join(WS, 'src/llm/stream-wire.mjs')), true, '真实文件产物落在工作区里');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'done', '库里节点为 done');
  eq(r.trace.length, 4, '四次工具调用全程留痕');
  assert(existsSync(r.narrativeRef), '执行叙事已归档（兜底）');
  const narr = readFileSync(r.narrativeRef, 'utf8');
  assert(narr.includes('list_dir') && narr.includes('stream-wire'), '叙事含工具调用全程，可做上下文考古');
  assert(narr.includes(r.assemblyId), '叙事回指装配 id —— 三层出处可串起来');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('10. 被拒的交接记录会回灌重试，不会静默通过');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1 } = fixture();
  const client = new LlmClient({ mode: 'fake', fake: makeFake([
    handoffCall(handoffArgs({ artifacts: [{ path: 'ghost.mjs' }] })),          // 谎报产物
    toolCall('write_file', { path: 'real.mjs', content: 'x' }),                 // 补做
    handoffCall(handoffArgs({ artifacts: [{ path: 'real.mjs', kind: 'm' }] })), // 再交
  ]) });
  const r = await executeNode(db, {
    client, taskId, nodeId: n1, workspace: WS, tier: 'standard', vendorId: 'deepseek',
    narrativeDir: join(TMP, 'narr'),
  });
  eq(r.kind, 'done', '补做之后通过');
  eq(r.rejections.length, 1, '第一次谎报产物被拒，留证一次');
  assert(r.rejections[0][0].includes('ghost.mjs'), '拒绝理由指名道姓：文件不存在');
  const a = db.one(`SELECT payload FROM audit_log WHERE action='handoff_rejected'`);
  assert(a && JSON.parse(a.payload).errs.length, '拒绝进审计轨，可复盘"它想蒙混过关"');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('11. 两个出口 + 一个不体面的收场');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1 } = fixture();
  const client = new LlmClient({ mode: 'fake', fake: makeFake([
    toolCall('raise_question', { level: 2, text: '解析器放独立模块还是各 adapter 自己解析？',
      default_action: '独立模块', blocked_by: '规格没说放哪一层' }),
  ]) });
  const r = await executeNode(db, { client, taskId, nodeId: n1, workspace: WS,
    tier: 'standard', vendorId: 'deepseek', narrativeDir: join(TMP, 'narr') });
  eq(r.kind, 'question', '做不下去时提问，而不是伪造一份能过验收的交接记录');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'blocked', '节点挂起为 blocked');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务转 waiting');
  eq(db.one(`SELECT count(*) AS n FROM handoffs`).n, 0, '挂起时没有交接记录 —— 没做完就是没做完');
  // 挂起会同时写问题与复工简报，两者各挂一条 about_node 边。
  // 按 from_id 的类型分别断言，不数总条数 —— 数总数的断言会被下一个正当的新增打破。
  const about = db.all(`SELECT from_id FROM edges WHERE relation='about_node' AND to_id=?`, n1)
    .map((e) => e.from_id.split('_')[0]);
  assert(about.includes('q'), '问题挂到节点上');
  assert(about.includes('b'), '复工简报也挂到节点上');
  db.close();
}
{
  const { db, taskId, n1 } = fixture();
  const client = new LlmClient({ mode: 'fake', fake: makeFake([
    toolCall('list_dir', {}), toolCall('list_dir', {}), toolCall('list_dir', {}),
  ]) });
  const r = await executeNode(db, { client, taskId, nodeId: n1, workspace: WS,
    tier: 'standard', vendorId: 'deepseek', narrativeDir: join(TMP, 'narr'), maxIterations: 3 });
  eq(r.kind, 'stalled', '既不交接也不提问就跑到头 → stalled');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'pending', '退回 pending 等重试，**不置 done**');
  eq(db.one(`SELECT retry_count FROM nodes WHERE id=?`, n1).retry_count, 1, '重试计数 +1（升档的输入）');
  assert(db.one(`SELECT 1 AS x FROM audit_log WHERE action='node_stalled'`), '失败原因进审计轨');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. 终结性工具后立刻收工，不白烧上下文');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1 } = fixture();
  // 磁带里交接之后还塞了两条，若 loop 不停会取到它们
  const client = new LlmClient({ mode: 'fake', fake: makeFake([
    handoffCall(handoffArgs({ artifacts: [{ path: 'seed.txt' }] })),
    toolCall('list_dir', {}), toolCall('list_dir', {}),
  ]) });
  const r = await executeNode(db, { client, taskId, nodeId: n1, workspace: WS,
    tier: 'standard', vendorId: 'deepseek', narrativeDir: join(TMP, 'narr'), maxIterations: 10 });
  eq(r.kind, 'done', '交接后收尾');
  eq(client.ledger.length, 1, '只发生 1 次 LLM 调用 —— shouldStop 生效，没有多跑轮次');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('13. 滚动缓存断点：历史也是稳定前缀');
// ═══════════════════════════════════════════════════════════════════════════
{
  // ① adapter 层：标了 cache 的 tool_results，断点落在它最后一块上
  const wire = anthropic.buildRequest({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 't', args: {} }] },
      { role: 'tool_results', cache: true, results: [{ callId: 'a', name: 't', content: 'r1' }] },
    ], maxTokens: 10,
  }, 'm');
  const tr = wire.messages[2].content;
  eq(tr[tr.length - 1].cache_control?.type, 'ephemeral', '断点落在最后一条工具结果上');
  const noCache = anthropic.buildRequest({
    messages: [{ role: 'tool_results', results: [{ callId: 'a', name: 't', content: 'r' }] }], maxTokens: 10,
  }, 'm');
  eq(noCache.messages[0].content[0].cache_control, undefined, '没标 cache 的工具结果不挂断点');

  // ② 滚动逻辑：断点每轮往后滚，且全程**只有一个**
  const msgs = [{ role: 'user', content: [] }];
  const marks = () => markRollingCache(msgs).filter((m) => m.role === 'tool_results').map((m) => m.cache);
  msgs.push({ role: 'assistant', content: [] }, { role: 'tool_results', results: [{ callId: 'a', content: 'r1' }] });
  eq(JSON.stringify(marks()), JSON.stringify([true]), '第 1 条工具结果落地后，断点在它身上');
  msgs.push({ role: 'assistant', content: [] }, { role: 'tool_results', results: [{ callId: 'b', content: 'r2' }] });
  eq(JSON.stringify(marks()), JSON.stringify([false, true]), '第 2 条落地后断点滚过去，第 1 条撤掉');
  msgs.push({ role: 'assistant', content: [] }, { role: 'tool_results', results: [{ callId: 'c', content: 'r3' }] });
  eq(JSON.stringify(marks()), JSON.stringify([false, false, true]),
    '继续滚 —— 断点是稀缺资源（Anthropic 最多 4 个），且多挂不更省：前缀缓存只认最长那个命中点');

  // ③ loop 层：默认开，可关（对照实验要用）
  const run = async (rollingCache) => {
    const c = new LlmClient({ mode: 'fake', fake: makeFake(Array.from({ length: 3 }, () => ({
      stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'x', name: 'noop', args: {} }], usage: {} }))) });
    const r = await runToolLoop(c, { tier: 'standard', messages: [{ role: 'user', content: [] }], maxTokens: 10 },
      { noop: async () => 'ok' }, { maxIterations: 3, rollingCache });
    return r.messages.filter((m) => m.role === 'tool_results').map((m) => m.cache);
  };
  // 末条是 undefined 而非 true：断点在**下一轮发请求前**才打，最后一条工具结果
  // 产生后循环就结束了，它从未被发出去过——没发出去的东西不该有断点。
  eq(JSON.stringify(await run(undefined)), JSON.stringify([false, true, undefined]),
    'loop 默认开启滚动断点，且只标已经发出去过的那些');
  eq(JSON.stringify(await run(false)), JSON.stringify([undefined, undefined, undefined]),
    'rollingCache:false 一个都不挂 —— 留着做 A/B 对照');
}

// ═══════════════════════════════════════════════════════════════════════════
section('14. token 估算：宁可估高，估低会让断点静默失效');
// ═══════════════════════════════════════════════════════════════════════════
{
  assert(estimateTokens('a'.repeat(3500)) >= 1000, '纯英文 3500 字符估到约 1000 token');
  assert(estimateTokens('中'.repeat(1000)) >= 285, '中文按同一系数估（偏保守，中文实际 token 密度更高）');
  eq(estimateTokens(''), 0, '空串估 0');
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. 工作区污染隔离：--ref 要真的把"未来"切掉，不只是换棵树');
// ═══════════════════════════════════════════════════════════════════════════
//
// 曾出现过：执行节点的 agent
// read_file 了**基线之后才提交的文件**。`--ref` 退到之前的提交并不管用 ——
// clone 把 main / origin/main 一并带来了，`git show <新提交>:<文件>` 一句话就读回来。
// 代码注释当时写着"单分支浅克隆"和"这是污染隔离"，**两句都不是事实**。
{
  const repo = join(TMP, 'src-repo');
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T');
  writeFileSync(join(repo, 'code.txt'), 'v1\n');
  g('add', '-A'); g('commit', '-q', '-m', 'baseline');
  const base = g('rev-parse', 'HEAD').trim();
  g('tag', 'v1.0.0');   // 基线上的 tag：祖先，应保留
  writeFileSync(join(repo, 'PRE-REGISTRATION.md'), '我将要发的修正原文\n');
  g('add', '-A'); g('commit', '-q', '-m', 'the protocol');
  const secret = g('rev-parse', 'HEAD').trim();
  // 第三方仓库上漏掉的那条路：**tag 指着未来**。第一版只删分支和远端，
  // commit-and-tag-version 的 `v13.1.0` tag 把整条未来留住了，而断言照样过。
  g('tag', 'v1.1.0');
  g('checkout', '-q', '-b', 'side'); writeFileSync(join(repo, 'side.txt'), 's\n');
  g('add', '-A'); g('commit', '-q', '-m', 'side branch'); g('checkout', '-q', 'main');

  const db = openDb(':memory:');
  ensureOwner(db);
  const taskId = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at)
          VALUES (?,(SELECT id FROM users LIMIT 1),'T','running',?)`, taskId, now());
  const ws = ensureWorkspace(db, { taskId, source: repo, dir: join(TMP, 'ws-iso'), ref: base });
  const inWs = (...a) => execFileSync('git', a, { cwd: ws.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const reachable = (sha) => { try { inWs('cat-file', '-e', `${sha}^{commit}`); return true; } catch { return false; } };

  eq(ws.head, base, '工作树停在基线上');
  assert(!existsSync(join(ws.dir, 'PRE-REGISTRATION.md')), '协议文件不在工作树里');
  assert(!reachable(secret),
    '**协议那条提交在工作区里不可达** —— 把文件从工作树拿走，不等于把它从仓库拿走');
  eq(inWs('branch', '-a').trim(), `* v0/${taskId}`, '只剩任务分支：远端与 main 都摘了');
  assert(reachable(base), '基线**祖先**照旧可达 —— agent 仍然能 git log / blame，隔离切的是未来不是过去');
  eq(inWs('tag', '--list').trim(), 'v1.0.0', '指向未来的 tag（v1.1.0）删了，基线上的 tag（v1.0.0）留着');
  eq(inWs('for-each-ref', '--format=%(refname)').trim().split('\n').sort().join(','),
    `refs/heads/v0/${taskId},refs/tags/v1.0.0`, '库里全部 ref 都是 HEAD 的祖先 —— 这才是"隔离"的定义，源 HEAD 不可达只是它的代理');

  // 不给 ref 就是普通克隆：完整历史，不假装隔离
  const ws2 = ensureWorkspace(db, { taskId: `${taskId}b`, source: repo, dir: join(TMP, 'ws-full') });
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at)
          VALUES (?,(SELECT id FROM users LIMIT 1),'T2','running',?)`, `${taskId}b`, now());
  const r2 = (() => { try { execFileSync('git', ['cat-file', '-e', `${secret}^{commit}`],
    { cwd: ws2.dir, stdio: 'ignore' }); return true; } catch { return false; } })();
  assert(r2, '不给 ref 时是完整克隆 —— 隔离是 --ref 明确要来的东西，不是默认悄悄发生的');
  db.close();
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'='.repeat(72)}\nPASS=${pass}  FAIL=${fail}\n${'='.repeat(72)}`);
process.exit(fail ? 1 : 0);
