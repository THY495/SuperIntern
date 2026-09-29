// 离线回归：挂起 → 进程退出 → 回答 → 新进程恢复 → 完成
//
// 跑：node tests/suspend-resume.test.mjs
//
// 挂起即退出（Ⅱ 级问题 → 分支挂起 → **进程 exit 0 退出**）
// 答复挂上（`superintern answer` 写入答案，`answers` 边挂上）
// 新进程复工（**新进程**读库重建上下文完成挂起分支，装配可查）
// 任务完成（任务置 done，产物在 git 分支上，测试通过）
//
// ⚠️ 第 8 节是本文件的重点，也是最容易做假的一节：它**真的 spawn 子进程**。
// 在同一个进程里 await 一下然后声称"恢复了"，证明不了统一恢复语义——
// 内存里残留任何东西，恢复就是假的。所以"进程真的退出"是硬要求。

import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb, ensureOwner, newId, now, insertEdge, sha256 } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { assembleExecutor } from '../src/context/assemble.mjs';
import { executeNode } from '../src/agent/executor.mjs';
import { recordAnswer, openQuestions } from '../src/core/inbox.mjs';
import { orchestrate, getParam } from '../src/core/orchestrator.mjs';
import { workspaceStatus } from '../src/core/workspace.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';

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
const TMP = mkdtempSync(join(tmpdir(), 'si-resume-'));
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

// ═══════════════════════════════════════════════════════════════════════════
// fixture：一个任务、一个节点、一份工作区
// ═══════════════════════════════════════════════════════════════════════════

const CONSTITUTION = {
  goal: '让 src/llm/ 的流式路径能吃真实的 text/event-stream 字节流。现在四个 streamAccumulator '
    + '收的是**已解析好的事件对象**，也就是说从未有代码把 HTTP 响应体的原始字节变成那些对象。',
  scope: '只动 src/llm/ 与 spikes/02-llm/test.mjs。不改 adapter 的 canonical 输出形状。不引入任何第三方依赖。',
  dod: '`node spikes/02-llm/test.mjs` 全绿，且新增断言覆盖四家各自的原始 SSE 字节流→规范响应。',
  constraints: [
    '全程离线可验：不得调用任何厂商 API，不得读取或要求任何 API key。',
    '四家的线格式不同：Anthropic 是带 event: 行的具名事件流；OpenAI 只有 data: 行且以 [DONE] 收尾；'
      + 'Gemini 的 streamGenerateContent 返回的是一个 JSON 数组的流式切片，不是 SSE。',
    '必须处理跨 chunk 边界：一个 SSE 事件可能被 TCP 切成两半，逐 chunk 独立解析必然丢数据。',
  ],
};

const NODE_SPEC = '新建 src/llm/stream-wire.mjs，导出两个有状态解码器工厂：createSSEDecoder() 与 '
  + 'createJSONArrayDecoder()。要求：以空行分帧，同时接受 \\n\\n 与 \\r\\n\\r\\n；支持 event:/data:/id:/retry: '
  + '字段；多条 data: 行按 \\n 拼接；以 ":" 开头的注释行忽略；UTF-8 多字节字符被 chunk 切断不得损坏。'
  + '边界：本节点只做分帧与字节层，不含任何厂商语义，不改任何 adapter，不引入第三方依赖。';
const NODE_ACC = '存在文件 src/llm/stream-wire.mjs 且导出上述两个工厂。一条内联脚本 exit 0：对一个含 event: 行、'
  + '含注释行、含多行 data:、含 emoji 的 SSE 样本，遍历每一个切点把字节切成两段分别 push，产出事件序列与整段'
  + '一次 push 的结果 deepStrictEqual。';

function fixture({ dbPath = ':memory:' } = {}) {
  const db = openDb(dbPath);
  const { userId, plaintext } = ensureOwner(db);
  const taskId = newId('t'), constId = newId('c'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'补 SSE 解析','running',?)`,
    taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,4,?,?,?,?,?,?)`, constId, taskId,
    CONSTITUTION.goal, CONSTITUTION.scope, CONSTITUTION.dod, JSON.stringify(CONSTITUTION.constraints), t, t);
  const n1 = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写解码器',?,?,'pending','normal','standard',?)`, n1, taskId, NODE_SPEC, NODE_ACC, t);
  return { db, taskId, constId, n1, userId, plaintext };
}

/** 一份真 git 工作区 —— 产物要落在分支上，改动集也靠 git 判。 */
function makeWorkspace(name) {
  const ws = join(TMP, name);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'README.md'), '# fixture repo\n');
  git(ws, 'init', '-q');
  git(ws, 'config', 'user.email', 'test@local');
  git(ws, 'config', 'user.name', 'test');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'init');
  git(ws, 'checkout', '-q', '-b', 'v0/test');
  return ws;
}

const call = (name, args, usage = { inputTokens: 2000, outputTokens: 50 }) => ({
  stopReason: 'tool_call',
  content: [{ type: 'tool_call', id: `c_${name}`, name, args }],
  usage,
});

const QUESTION_ARGS = {
  level: 2,
  text: 'SSE 解析该放在哪一层：独立模块供四家共用，还是各 adapter 自己解析？',
  blocked_by: '规格说"不含任何厂商语义"，但验收标准要求覆盖四家各自的线格式',
  default_action: '按独立模块做，只分帧不含厂商语义',
  work_done: '读了 providers.mjs 的四个 streamAccumulator，确认它们收的是已解析对象；'
    + '已写出 src/llm/stream-wire.mjs 的分帧骨架（createSSEDecoder 的 push/flush 已能跑通 \\n\\n 分帧）。',
  plan_after_answer: '若选独立模块：补 \\r\\n\\r\\n 与 UTF-8 跨 chunk，再写 createJSONArrayDecoder。'
    + '若选各 adapter 自解析：把已写的 stream-wire.mjs 删掉，改在四个 adapter 里各加一份分帧。',
};

// ═══════════════════════════════════════════════════════════════════════════
section('1. 挂起：问题与复工简报同事务落库');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1 } = fixture();
  const ws = makeWorkspace('ws1');
  const client = new LlmClient({ mode: 'fake', fake: makeFake([call('raise_question', QUESTION_ARGS)]) });
  const r = await executeNode(db, {
    client, taskId, nodeId: n1, workspace: ws, tier: 'standard', vendorId: 'deepseek',
    narrativeDir: join(TMP, 'narr1'), maxIterations: 3,
  });

  eq(r.kind, 'question', '执行器走提问出口');
  const q = db.one(`SELECT * FROM questions WHERE task_id=?`, taskId);
  eq(q.level, 2, '问题落库，级别 Ⅱ');
  eq(q.status, 'open', '问题状态 open');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'blocked', '节点转 blocked');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'waiting', '任务转 waiting');

  const b = db.one(`SELECT * FROM briefings WHERE question_id=?`, q.id);
  assert(b, '复工简报与问题同事务落库 —— 只有问题没有简报 = 回答完了没人知道下一步干什么');
  assert(b.work_done.includes('src/llm/stream-wire.mjs'), '简报记下"做到哪一步"，含已落盘产物路径');
  assert(b.plan_after.includes('若选各 adapter'), '简报按答案的每种可能分别写行动计划');
  eq(b.trust_label, 'agent-generated', '简报是 agent-generated —— 复工时读回来是情报不是指令');
  assert(b.context_tokens > 0, `简报记下挂起时的上下文体量（${b.context_tokens} token），供丈量丢弃了多少`);
  assert(b.narrative_ref && existsSync(b.narrative_ref), '简报指向执行叙事归档，供复工时上下文考古');

  // 库层护栏：简报的信任标签不可改写
  rejects(() => db.run(`INSERT INTO briefings (id,task_id,node_id,work_done,blocked_by,plan_after,
                          trust_label,valid_from,recorded_at) VALUES (?,?,?,'x','y','z','user-authenticated',?,?)`,
    newId('b'), taskId, n1, now(), now()),
  '简报冒充 user-authenticated 被库层 CHECK 拒绝（与交接记录同款安全边界）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 认证通道：没有有效令牌就写不出一条具指令效力的答复');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, plaintext } = fixture();
  const ws = makeWorkspace('ws2');
  const client = new LlmClient({ mode: 'fake', fake: makeFake([call('raise_question', QUESTION_ARGS)]) });
  await executeNode(db, { client, taskId, nodeId: n1, workspace: ws, tier: 'standard',
    vendorId: 'deepseek', narrativeDir: join(TMP, 'narr2'), maxIterations: 3 });
  const q = db.one(`SELECT * FROM questions WHERE task_id=?`, taskId);

  rejects(() => recordAnswer(db, { questionId: q.id, body: '走独立模块', plaintextToken: 'not-a-token' }),
    '伪造令牌 → 拒绝');
  rejects(() => recordAnswer(db, { questionId: q.id, body: '走独立模块', plaintextToken: null }),
    '不带令牌 → 拒绝');
  rejects(() => recordAnswer(db, { questionId: q.id, body: '   ', plaintextToken: plaintext }),
    '空答复 → 拒绝');

  // 绕过应用层直接写库也不行 —— 护栏住在库层，不是住在 recordAnswer 里
  rejects(() => db.run(`INSERT INTO messages (id,task_id,body,kind,kind_source,urgency_source,trust_label,received_at)
                        VALUES (?,?,'走独立模块','answer','explicit','explicit','user-authenticated',?)`,
    newId('m'), taskId, now()),
  '绕过应用层直接 INSERT 一条无令牌的 user-authenticated 消息 → 库层 CHECK 拒绝');

  eq(db.one(`SELECT count(*) AS n FROM messages WHERE task_id=?`, taskId).n, 0,
    '三次拒绝之后 inbox 里一条消息都没有');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, q.id).status, 'open', '问题仍然 open');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 回答：answers 边挂上，分支解冻');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, plaintext, userId } = fixture();
  const ws = makeWorkspace('ws3');
  const client = new LlmClient({ mode: 'fake', fake: makeFake([call('raise_question', QUESTION_ARGS)]) });
  await executeNode(db, { client, taskId, nodeId: n1, workspace: ws, tier: 'standard',
    vendorId: 'deepseek', narrativeDir: join(TMP, 'narr3'), maxIterations: 3 });
  const q = db.one(`SELECT * FROM questions WHERE task_id=?`, taskId);

  const ANSWER = '独立模块。分帧层四家共用（stream-wire.mjs），厂商语义留在各 adapter 里。'
    + '理由：跨 chunk 边界处理是纯字节层的事，写四遍必然有三份写错。';
  const r = recordAnswer(db, { questionId: q.id, body: ANSWER, plaintextToken: plaintext });

  const m = db.one(`SELECT * FROM messages WHERE id=?`, r.messageId);
  eq(m.kind, 'answer', '答复入 inbox，kind=answer');
  eq(m.trust_label, 'user-authenticated', '信任标签 user-authenticated —— 唯一具指令效力的一类');
  eq(m.sender_id, userId, '发送人是 owner');
  assert(m.token_id, '带签发令牌 id —— 指令溯源的锚点');

  const e = db.one(`SELECT * FROM edges WHERE from_id=? AND to_id=? AND relation='answers'`, m.id, q.id);
  assert(e, 'answers 边挂上（message → question）');

  eq(db.one(`SELECT status FROM questions WHERE id=?`, q.id).status, 'answered', '问题置 answered');
  assert(db.one(`SELECT resolved_at FROM questions WHERE id=?`, q.id).resolved_at, '记 resolved_at');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'pending',
    '节点由 blocked 退回 pending —— 不直接置 ready，就绪与否由依赖现算');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'running', '任务由 waiting 转 running');
  eq(openQuestions(db, taskId).length, 0, '没有待答问题了');

  rejects(() => recordAnswer(db, { questionId: q.id, body: '改主意了', plaintextToken: plaintext }),
    '同一个问题回答两次 → 拒绝（改主意要走修正流程）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 复工装配：段③′ 出现，两类数据的信任标签分开写明');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, plaintext } = fixture();
  const ws = makeWorkspace('ws4');

  // 挂起前先装配一次，作为对照
  const before = assembleExecutor(db, { taskId, nodeId: n1, tier: 'standard', vendorId: 'deepseek' });
  eq(before.meta.recipe, 'executor/v0-four-part', '首次执行用四段式配方');
  eq(before.meta.resume, null, '首次执行没有复工段');
  eq(before.messages[0].content.length, 3, '首次执行三块：段②、段③、段④');

  const client = new LlmClient({ mode: 'fake', fake: makeFake([call('raise_question', QUESTION_ARGS)]) });
  await executeNode(db, { client, taskId, nodeId: n1, workspace: ws, tier: 'standard',
    vendorId: 'deepseek', narrativeDir: join(TMP, 'narr4'), maxIterations: 3 });
  const q = db.one(`SELECT * FROM questions WHERE task_id=?`, taskId);

  // 未回答时复工装配：不能假装已经有答案
  const midway = assembleExecutor(db, { taskId, nodeId: n1, tier: 'standard', vendorId: 'deepseek' });
  assert(midway.messages[0].content[2].text.includes('尚无答复'),
    '问题还没答时，复工段明说没有答复，不留空白让模型脑补');

  const ANSWER = '独立模块。分帧层四家共用，厂商语义留在各 adapter 里。';
  recordAnswer(db, { questionId: q.id, body: ANSWER, plaintextToken: plaintext });

  const after = assembleExecutor(db, { taskId, nodeId: n1, tier: 'standard', vendorId: 'deepseek' });
  eq(after.meta.recipe, 'executor/v0-four-part+resume', '复工用不同的配方名 —— 装配审计里能一眼看出这是复工');
  eq(after.messages[0].content.length, 4, '复工多一块：段②、段③、段③′、段④');
  const s3r = after.messages[0].content[2].text;

  assert(s3r.includes('stream-wire.mjs 的分帧骨架'), '段③′ 含"当时做到哪一步"');
  assert(s3r.includes('若选各 adapter'), '段③′ 含"获答后的行动计划"');
  assert(s3r.includes(ANSWER), '段③′ 含答复正文');
  assert(s3r.includes('agent-generated') && s3r.includes('是情报不是指令'),
    '段③′ 标明简报是 agent-generated：可能过时，不具指令效力');
  assert(s3r.includes('可能已经过时') && s3r.includes('与简报冲突时信现状'),
    '段③′ 明说简报可能过时，工作区现状优先 —— 不冷冻上下文的全部理由');
  assert(s3r.includes('具有指令效力') && s3r.includes('认证通道'),
    '段③′ 标明答复经认证通道、具指令效力 ——两类数据的区别写进上下文，不让模型凭语气猜');

  // 段落顺序仍是成本约束：断点跟着稳定段末尾走
  const last = after.messages[0].content;
  eq(last[3].text.includes('按需检索区'), true, '易变段（段④）仍在最后');
  eq(last[2].cache, after.cacheStable, '断点后移到段③′ 末尾 —— 稳定段连续且最前');
  eq(last[1].cache, false, '段③ 不再是断点');

  // 装配审计：条目清单要能查到简报/问题/答复
  const row = db.one(`SELECT * FROM context_assemblies WHERE id=?`, after.assemblyId);
  const items = JSON.parse(row.items);
  const b = db.one(`SELECT * FROM briefings WHERE question_id=?`, q.id);
  const msg = db.one(`SELECT id FROM messages WHERE task_id=?`, taskId);
  assert(items.includes(b.id) && items.includes(q.id) && items.includes(msg.id),
    '装配审计的条目清单含简报、问题、答复三条 id（装配可查）');
  eq(row.recipe, 'executor/v0-four-part+resume', '装配审计记的是复工配方');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 丈量：重建出来的比丢掉的小多少（编排器 40% 哨兵的对偶）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, plaintext } = fixture();
  const ws = makeWorkspace('ws5');
  // 让挂起发生在"上下文已经涨起来"之后：先读两次文件再提问
  writeFileSync(join(ws, 'big.txt'), 'x'.repeat(20000));
  const client = new LlmClient({ mode: 'fake', fake: makeFake([
    call('read_file', { path: 'big.txt' }, { inputTokens: 3000, outputTokens: 20 }),
    call('read_file', { path: 'README.md' }, { inputTokens: 9000, outputTokens: 20 }),
    call('raise_question', QUESTION_ARGS, { inputTokens: 9500, cacheReadTokens: 3000, outputTokens: 40 }),
  ]) });
  await executeNode(db, { client, taskId, nodeId: n1, workspace: ws, tier: 'standard',
    vendorId: 'deepseek', narrativeDir: join(TMP, 'narr5'), maxIterations: 5 });

  const q = db.one(`SELECT * FROM questions WHERE task_id=?`, taskId);
  const b = db.one(`SELECT * FROM briefings WHERE question_id=?`, q.id);
  eq(b.context_tokens, 12500, '挂起时的上下文体量 = 最后一次调用的提示词体量（原价 + 缓存读）');

  recordAnswer(db, { questionId: q.id, body: '独立模块。', plaintextToken: plaintext });
  const after = assembleExecutor(db, { taskId, nodeId: n1, tier: 'standard', vendorId: 'deepseek' });
  const m = after.meta.resume;
  eq(m.contextTokensAtSuspend, 12500, '复工装配读到挂起时的体量');
  eq(m.rebuiltTokens, after.meta.tokenEstimate, '复工装配记下重建后的体量');
  assert(m.retainedRatio > 0 && m.retainedRatio < 1,
    `保留率 ${(m.retainedRatio * 100).toFixed(1)}% —— 丢掉的那部分是**必须能重新取回**的，否则"丢弃后能无损重建"就破了`);
  assert(m.answered === true && m.answerId, '复工元数据记下答复 id');

  const aud = db.all(`SELECT payload FROM audit_log WHERE action='context_assembled' AND target_id=?`, n1)
    .map((r) => JSON.parse(r.payload));
  assert(aud.at(-1).resume?.retainedRatio === m.retainedRatio,
    '保留率进装配审计 —— 它是唯一能让人注意到"有东西没入库"的机械信号，所以不进日志');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 编排器：每轮从库重读，循环体之间不传任何东西（重生）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1 } = fixture();
  const ws = makeWorkspace('ws6');
  const seen = [];
  const r = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'narr6'), verify: false,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([call('raise_question', QUESTION_ARGS)]) }),
    onEvent: (e) => { if (e.type === 'cycle') seen.push(e); },
  });
  eq(r.kind, 'suspended', '遇到挂起，编排器返回 suspended');
  eq(r.questions[0].level, 2, '带回第 Ⅱ 级问题');
  assert(r.questions[0].briefingId, '带回复工简报 id');
  eq(r.pid, process.pid, '返回值里带 pid —— "新进程"这件事要能机械核对，不能靠自称');

  // 挂起之后再跑一次：**同一个进程内**也不会偷偷继续
  const r2 = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'narr6'), verify: false,
    makeClient: () => { throw new Error('不该再造 client —— 有问题没答就不该动 LLM'); },
    onEvent: () => {},
  });
  eq(r2.kind, 'suspended', '问题还开着 → 第二次 orchestrate 直接 suspended，一次 LLM 都不调');
  eq(r2.cycles, 0, '第 0 轮就停 —— 检查 inbox 在选节点之前（循环骨架）');

  const audits = db.all(`SELECT action, payload FROM audit_log WHERE target_id=? ORDER BY id`, taskId);
  const starts = audits.filter((a) => a.action === 'orchestrator_started');
  const exits = audits.filter((a) => a.action === 'orchestrator_exit');
  eq(starts.length, 2, '每次编排器启动都留一条审计');
  eq(exits.length, 2, '每次退出都留一条审计');
  assert(JSON.parse(starts[0].payload).pid === process.pid, '启动审计带 pid');
  eq(JSON.parse(exits[1].payload).kind, 'suspended', '退出审计记退出原因');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. 任务级验收：节点全完成也不等于任务完成');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, userId } = fixture();
  const ws = makeWorkspace('ws7');
  const t = now();
  // 一条**必然失败**的验收命令
  db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
          VALUES (?,?,'task.verify_command',?,'task','constitutional','user',?,?,?)`,
    newId('p'), taskId, JSON.stringify(['node', '-e', 'process.exit(3)']), userId, t, t);

  const HANDOFF = {
    artifacts: [{ path: 'src/llm/out.txt', kind: 'source' }],
    interface_contract: 'createSSEDecoder() -> {push, flush}',
    acceptance_evidence: 'node -e "..." exit=0',
  };
  const r = await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'narr7'),
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([
      call('write_file', { path: 'src/llm/out.txt', content: 'export const createSSEDecoder = () => {};\n' }),
      call('submit_handoff', HANDOFF),
    ]) }),
    onEvent: () => {},
  });

  eq(r.kind, 'verify_failed', '节点交接合格，但任务级验收 exit=3 → verify_failed');
  eq(r.verification.code, 3, '记下验收命令的退出码');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'done', '节点确实是 done');
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'running',
    '任务**不置 done** —— 交接记录管"这一步做完了"，任务级判据管"合起来还成立"');
  assert(db.one(`SELECT count(*) AS n FROM audit_log WHERE action='task_verify_failed'`).n === 1,
    '验收失败进审计轨');

  // 宪法层参数 agent 不可自改（硬规则，库层 CHECK）
  rejects(() => db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,valid_from,recorded_at)
                        VALUES (?,?,'task.verify_command','["true"]','task','constitutional','agent',?,?)`,
    newId('p'), taskId, now(), now()),
  'agent 想自己改任务级验收命令 → 库层 CHECK 拒绝');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('7b. 任务级验收跑在可写视图上，但不许留下改动（例：vitest 要写 node_modules/.vite-temp）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const HANDOFF = { artifacts: [{ path: 'src/llm/out.txt', kind: 'source' }], interface_contract: 'x', acceptance_evidence: 'y' };
  const runWith = async (name, verifyJs, gitignore = null) => {
    const { db, taskId, userId } = fixture();
    const ws = makeWorkspace(name);
    if (gitignore) { writeFileSync(join(ws, '.gitignore'), gitignore); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'ignore'); }
    db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
            VALUES (?,?,'task.verify_command',?,'task','constitutional','user',?,?,?)`,
    newId('p'), taskId, JSON.stringify(['node', '-e', verifyJs]), userId, now(), now());
    const r = await orchestrate(db, {
      taskId, workspace: ws, narrativeDir: join(TMP, `narr-${name}`),
      makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([
        call('write_file', { path: 'src/llm/out.txt', content: 'x\n' }), call('submit_handoff', HANDOFF)]) }),
      onEvent: () => {},
    });
    db.close();
    return r;
  };
  // 验收命令往树里落了一个**未忽略**的文件 → 即便 exit=0 也判失败，并列出改动
  let r = await runWith('ws7b1', 'require("fs").writeFileSync("leftover.txt","x")');
  eq(r.kind, 'verify_failed', '验收命令 exit=0 但留下 leftover.txt → verify_failed');
  eq((r.verification.mutated ?? []).join(','), 'leftover.txt', '改动清单指名道姓');
  // 写进 .gitignore 里的路径（工具缓存）→ 不算改动，照常通过
  r = await runWith('ws7b2', 'require("fs").mkdirSync("node_modules/.vite-temp",{recursive:true});require("fs").writeFileSync("node_modules/.vite-temp/c.mjs","x")', 'node_modules/\n');
  eq(r.kind, 'complete', '写进被忽略的 node_modules/ → 是工具缓存不是改动，任务 done');
  eq((r.verification.mutated ?? []).length, 0, 'mutated 为空');
  // 改了被跟踪的文件 → 失败
  r = await runWith('ws7b3', 'require("fs").writeFileSync("README.md","hacked")');
  eq(r.kind, 'verify_failed', '验收命令改写了被跟踪的 README.md → verify_failed');
  eq((r.verification.mutated ?? []).join(','), 'README.md', '清单里是 README.md');
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. 硬要求：进程**真的**退出，恢复发生在**新进程**里');
// ═══════════════════════════════════════════════════════════════════════════
// 这一节不在本进程里 await 任何东西 —— 全部经 spawnSync 跑真 CLI。
// 在同一个进程里模拟"恢复"是最容易做假的一步：内存里残留任何东西，
// 统一恢复语义就没被证明。
{
  const home = join(TMP, 'home8');
  const dbPath = join(home, 'state.db');
  const ws = makeWorkspace('ws8');
  const env = { ...process.env, SUPERINTERN_HOME: home };
  // ⚠️ `--no-sandbox` 在这里是**显式**的，不是默认捡来的。`run` 默认
  // 起容器沙箱；这一节验的是编排器重生（两个进程、两次寿命），不是沙箱，
  // 而且离线回归不该要求装了 Docker 才能跑。例外写在调用点上才看得见 ——
  // 一个"记得加"的安全开关就是一个迟早忘记加的安全开关，反过来也一样：
  // 一个隐式的例外就是一个没人知道存在的例外。
  const cli = (...args) => spawnSync(process.execPath,
    [join(ROOT, 'src', 'cli.mjs'), ...args, '--no-sandbox'],
    { cwd: ROOT, env, encoding: 'utf8' });

  // 脚本：第一次跑到提问就停；第二次（新进程）读一次文件后交接
  const scriptA = join(TMP, 'script-a.json');
  const scriptB = join(TMP, 'script-b.json');
  writeFileSync(scriptA, JSON.stringify([call('raise_question', QUESTION_ARGS)]));
  writeFileSync(scriptB, JSON.stringify([
    call('write_file', { path: 'src/llm/stream-wire.mjs', content: 'export const createSSEDecoder = () => ({push(){},flush(){}});\n' }),
    call('submit_handoff', {
      artifacts: [{ path: 'src/llm/stream-wire.mjs', kind: 'source' }],
      interface_contract: 'createSSEDecoder() -> {push, flush}',
      acceptance_evidence: 'node -e "import(\'./stream-wire.mjs\')" exit=0',
      key_decisions: [{ summary: '分帧层独立成模块', rationale: '按人的答复：跨 chunk 边界是纯字节层的事' }],
    }),
  ]));

  const init = cli('init');
  eq(init.status, 0, 'init exit 0');

  // 建任务时给任务级验收命令（宪法层参数，只能人给）
  const newTask = cli('new', '补 SSE 解析', '--goal', CONSTITUTION.goal, '--dod', CONSTITUTION.dod,
    '--scope', CONSTITUTION.scope, '--verify', 'node -e process.exit(0)');
  eq(newTask.status, 0, 'new exit 0');
  const taskId = newTask.stdout.match(/任务 (t_\w+)/)[1];
  assert(newTask.stdout.includes('宪法层参数，agent 不可自改'), '验收命令记为宪法层参数');

  // 手工塞一个节点（这里不重跑规划器，那由 planning.test.mjs 验）
  const db0 = openDb(dbPath);
  const n1 = newId('n');
  db0.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
           VALUES (?,?,'写解码器',?,?,'pending','normal','standard',?)`, n1, taskId, NODE_SPEC, NODE_ACC, now());
  db0.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);
  db0.close();

  // ── 进程 A：跑到挂起就退出 ────────────────────────────────────────────
  const runA = cli('run', taskId, '--dir', ws, '--mode', 'fake', '--script', scriptA);
  eq(runA.status, 0, '挂起即退出：挂起时进程 **exit 0** 退出（不是崩溃，是正常收尾）');
  assert(runA.stdout.includes('分支挂起，编排器退出'), '进程 A 明说自己退出了');
  const pidA = Number(runA.stdout.match(/编排器 pid (\d+)/)[1]);
  assert(pidA !== process.pid, '进程 A 的 pid 与测试进程不同 —— 它是真子进程');

  const db1 = openDb(dbPath);
  const q = db1.one(`SELECT * FROM questions WHERE task_id=?`, taskId);
  eq(q.status, 'open', '进程死后，问题留在库里');
  eq(db1.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'blocked', '节点留在 blocked');
  const brief = db1.one(`SELECT * FROM briefings WHERE question_id=?`, q.id);
  assert(brief, '复工简报留在库里 —— 进程死了，工作状态没死');
  db1.close();

  // ── 进程 B：回答（另一个进程，走认证通道）─────────────────────────────
  const ans = cli('answer', q.id, '独立模块。分帧层四家共用，厂商语义留在各 adapter 里。');
  eq(ans.status, 0, 'answer exit 0');
  assert(ans.stdout.includes('trust_label=user-authenticated'), '答复经认证通道写入');
  assert(ans.stdout.includes('由 blocked 退回 pending'), '分支解冻');

  // ── 进程 C：新进程恢复 ────────────────────────────────────────────────
  const runC = cli('run', taskId, '--dir', ws, '--mode', 'fake', '--script', scriptB);
  const pidC = Number(runC.stdout.match(/编排器 pid (\d+)/)[1]);
  eq(runC.status, 0, '新进程复工：新进程跑完，exit 0');
  assert(pidC !== pidA, `挂起即退出 + 新进程复工的机械证据：恢复发生在**另一个 pid** 上（${pidA} → ${pidC}）`);
  assert(runC.stdout.includes('+resume'), '进程 C 用的是复工配方');
  assert(runC.stdout.includes('复工：简报'), '进程 C 读到了简报与答复');
  assert(runC.stdout.includes('任务完成'), '任务完成：任务置 done');

  // ── 只凭真相源核对 ────────────────────────────────────────────────────
  const db2 = openDb(dbPath);
  eq(db2.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'done', '任务 status=done');
  eq(db2.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'done', '节点 status=done');

  const asms = db2.all(`SELECT * FROM context_assemblies ORDER BY ts`);
  eq(asms.length, 2, '两次装配：挂起前一次、复工一次');
  eq(asms[0].recipe, 'executor/v0-four-part', '第一次是四段式');
  eq(asms[1].recipe, 'executor/v0-four-part+resume', '第二次是复工配方（装配可查）');
  const items = JSON.parse(asms[1].items);
  assert(items.includes(brief.id) && items.includes(q.id), '复工装配的条目清单含简报与问题');

  // "进程真的退出"的核心证据：整条链上有几个不同的 pid
  const pids = new Set(db2.all(`SELECT payload FROM audit_log WHERE payload LIKE '%"pid"%'`)
    .map((r) => JSON.parse(r.payload).pid).filter(Boolean));
  assert(pids.size >= 3, `审计轨里记着 ${pids.size} 个不同的 pid —— "进程真的退出"是可查的事实，不是措辞`);

  const acts = db2.all(`SELECT action FROM audit_log ORDER BY id`).map((r) => r.action);
  for (const a of ['task_created', 'context_assembled', 'question_raised', 'question_answered',
    'orchestrator_exit', 'node_done', 'task_done']) {
    assert(acts.includes(a), `审计轨含 ${a}`);
  }
  assert(acts.indexOf('question_answered') > acts.indexOf('question_raised')
    && acts.lastIndexOf('context_assembled') > acts.indexOf('question_answered'),
  '只凭真相源复盘：审计轨的先后顺序自证了"提问 → 回答 → 重新装配"这条链，不需要看进程日志');

  // 产物在 git 分支上
  const log = git(ws, 'log', '--oneline', '-1');
  const files = git(ws, 'show', '--stat', '--format=', 'HEAD');
  assert(log.stdout.includes('写解码器'), '产物提交在工作区分支上，commit message 带节点标题');
  assert(files.stdout.includes('src/llm/stream-wire.mjs'), 'commit 里是本节点真正改动的文件');
  const branch = git(ws, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const doneAudit = JSON.parse(db2.one(`SELECT payload FROM audit_log WHERE action='task_done'`).payload);
  eq(doneAudit.branch, branch, '任务完成审计记下产物所在分支（机械取数口）');
  assert(doneAudit.verification.code === 0, '任务级验收命令通过才置 done');
  db2.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. "丢弃后能无损重建"的一条反面：简报缺失时复工装配不能装作没事');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, n1, plaintext, userId } = fixture();
  const t = now();
  // 手工造一个"有问题、有答复、但没有简报"的状态 —— 老版本的挂起路径就长这样
  const qid = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,status)
          VALUES (?,?,?,2,'classifier','放哪一层？','独立模块',?,'open')`, qid, taskId, n1, t);
  db.run(`UPDATE nodes SET status='blocked' WHERE id=?`, n1);
  recordAnswer(db, { questionId: qid, body: '独立模块。', plaintextToken: plaintext });

  const a = assembleExecutor(db, { taskId, nodeId: n1, tier: 'standard', vendorId: 'deepseek' });
  eq(a.meta.resume, null, '没有简报 → 没有复工段');
  eq(a.messages[0].content.length, 3, '退化成普通四段式');
  // ⚠️ 这正是**该被记为缺口**的地方：答复在库里，但因为没有简报，装配读不到它。
  assert(!a.messages[0].content.some((b) => b.text.includes('独立模块。')),
    '⚠️ 已知缺口：答复挂在问题上，而装配是**从简报**找到问题的 —— 没有简报，答复就进不了上下文');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. workspaceStatus：porcelain 的第一行有个吃字符的坑');
// ═══════════════════════════════════════════════════════════════════════════
// 曾印出过 `rc/llm/providers.mjs` 这样的路径 —— 少一个字符。
// 成因：porcelain 行是 `XY <path>`，未暂存修改的 X 是**空格**；整体 trim 把第一行
// 那个空格吃掉，slice(3) 就多切一位。只有第一行会错，看着像随机错字。
{
  const ws = makeWorkspace('ws12');
  writeFileSync(join(ws, 'alpha.txt'), 'a\n');
  writeFileSync(join(ws, 'beta.txt'), 'b\n');
  git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'two files');

  writeFileSync(join(ws, 'alpha.txt'), 'a2\n');      // ` M` 未暂存修改 → 首行以空格开头
  writeFileSync(join(ws, 'gamma.txt'), 'g\n');       // `??` 未跟踪
  const st = workspaceStatus(ws);
  assert(st.changed.includes('alpha.txt'), '首行（未暂存修改）路径完整，没被吃掉首字符');
  assert(st.changed.includes('gamma.txt'), '未跟踪文件也在清单里');
  eq(st.changed.length, 2, '清单条数正确');

  git(ws, 'add', 'alpha.txt');                        // `M ` 已暂存 → 首行以 M 开头
  assert(workspaceStatus(ws).changed.includes('alpha.txt'), '已暂存的首行同样完整');
  eq(workspaceStatus(ws).dirty, true, '有改动即 dirty');
  git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'clean');
  eq(workspaceStatus(ws).dirty, false, '提交后不再 dirty');
  eq(workspaceStatus(ws).changed.length, 0, '干净工作区的改动清单为空，不是一个空字符串元素');
}

// ═══════════════════════════════════════════════════════════════════════════
section('11. 崩溃恢复："重生 = 崩溃恢复"不能只对优雅退出成立');
// ═══════════════════════════════════════════════════════════════════════════
// 曾出现过：厂商余额耗尽 → 异常穿出 runToolLoop → 节点永远停在 running。
// 而 readyNodes 只看 pending/ready，于是任务谁也捡不起来：**不报错，只是不动**。
{
  const { db, taskId, n1 } = fixture();
  const ws = makeWorkspace('ws11');
  const boom = { ...makeFake([]), nextScripted() { throw new Error('HTTP 400: credit balance too low'); } };

  let threw = null;
  try {
    await executeNode(db, {
      client: new LlmClient({ mode: 'fake', fake: boom }),
      taskId, nodeId: n1, workspace: ws, tier: 'standard', vendorId: 'deepseek',
      narrativeDir: join(TMP, 'narr11'), maxIterations: 3,
    });
  } catch (e) { threw = e; }

  assert(threw, '崩溃原样抛给上层 —— 不伪装成正常收尾，进程该以非零码退出');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n1).status, 'pending', '节点退回 pending，不留在 running');
  eq(db.one(`SELECT retry_count FROM nodes WHERE id=?`, n1).retry_count, 1, '计一次重试');
  const c = db.one(`SELECT payload FROM audit_log WHERE action='node_crashed'`);
  assert(c && JSON.parse(c.payload).error.includes('credit balance'), '崩溃原因进审计轨');
  assert(existsSync(join(TMP, 'narr11', `${n1}.md`)),
    '崩溃也留下执行叙事 —— 复盘只凭真相源，跑过的活不能随异常一起消失');
  assert(readFileSync(join(TMP, 'narr11', `${n1}.md`), 'utf8').includes('**崩溃**'),
    '叙事里写明这一次是崩溃，不是做完了');

  // 硬杀（SIGKILL / 断电）时上面那段 catch 一行都不会跑 —— 编排器启动时兜底
  db.run(`UPDATE nodes SET status='running' WHERE id=?`, n1);
  const events = [];
  await orchestrate(db, {
    taskId, workspace: ws, narrativeDir: join(TMP, 'narr11'), verify: false, maxCycles: 1,
    makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([call('raise_question', QUESTION_ARGS)]) }),
    onEvent: (e) => events.push(e),
  });
  assert(events.some((e) => e.type === 'reclaimed'),
    '编排器启动时认领停在 running 的节点 —— 硬杀时没有任何代码来得及跑，只能靠这一步');
  assert(db.one(`SELECT count(*) AS n FROM audit_log WHERE action='node_reclaimed'`).n === 1,
    '认领进审计轨（谁、为什么、第几次重试）');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('10. 迁移：加一张表不能毁掉已有库里的历史');
// ═══════════════════════════════════════════════════════════════════════════
// 曾出现过：`openDb` 只在库文件不存在时跑 schema.sql，于是新表
// 永远到不了已有的库。而全部离线测试都用新建的 :memory:，所以测试全绿。
// 这一节就是补上那个盲区——它测的正是"测试碰不到的那条路径"。
{
  const fresh = join(TMP, 'fresh.db');
  const aged = join(TMP, 'aged.db');
  const shape = (p) => {
    const d = openDb(p);
    const rows = d.all(`SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'
                        ORDER BY type,name`);
    const v = d.raw.prepare('PRAGMA user_version').get().user_version;
    d.close();
    return { v, sig: rows.map((r) => `${r.type}:${r.name}`).join('|'), rows };
  };

  const f = shape(fresh);
  assert(f.v >= 2, `新建的库直接是最新版（user_version=${f.v}）`);

  assert(f.rows.some((r) => r.name === 'briefings'),
    '新库也走了一遍迁移 —— v1 之后的 DDL 只有一份副本，且迁移路径每次建库都被跑到');

  // 造一个"早期版本的库"：**只跑 schema.sql**（v1 基线）再把版本抹成 0。
  // ⚠️ 不要靠手工拆掉新迁移加的东西来模拟老库 —— 每加一条迁移都得同步改这里，
  //    忘一次这个测试就变成"测最后一条迁移能不能重复跑"（实测：第二次加迁移
  //    时它就炸成 duplicate column）。从 schema.sql 造，才永远是真正的 v1。
  const d0 = new DatabaseSync(aged);
  d0.exec(readFileSync(join(ROOT, 'src', 'db', 'schema.sql'), 'utf8'));
  d0.exec('PRAGMA user_version = 0');
  d0.close();
  const a = shape(aged);   // ← 再次 openDb 应当自动迁移

  eq(a.v, f.v, '老库打开后被带到同一个版本');
  eq(a.sig, f.sig, '迁移路径与建库路径落到**同一个形状**（表/索引/触发器逐个对齐）');
  eq(a.rows.find((r) => r.name === 'briefings').sql,
    f.rows.find((r) => r.name === 'briefings').sql,
    'briefings 的 DDL 逐字相同（同一条语句，不是两份抄写）');

  // 比代码新的库必须拒绝打开，而不是当作旧库去"迁移"
  const future = join(TMP, 'future.db');
  openDb(future).close();
  const d2 = openDb(future); d2.raw.exec('PRAGMA user_version = 99'); d2.close();
  rejects(() => openDb(future), '库版本比代码新 → 拒绝打开，不静默写坏数据');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
console.log(`挂起 / 恢复回归：${pass} 通过，${fail} 失败`);
console.log('═'.repeat(72));
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
