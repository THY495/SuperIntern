// 独立验收员
//
// 跑：node tests/verifier.test.mjs
//
// 断言的是纪律，不是模型：只看交接记录与产物（上下文里没有执行器的东西）；
// 只有只读工具；没结论 = 打回；settled_by_me 的取舍型假设能被打回；
// 打回走与 schema 拒回同一条路，执行器改完再交能过。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, insertEdge } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { verifyHandoff } from '../src/agent/verifier.mjs';
import { executeNode } from '../src/agent/executor.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-ver-'));
const WS = join(TMP, 'ws'); mkdirSync(WS, { recursive: true });
writeFileSync(join(WS, 'export.mjs'), 'export const toCsv = (rows) => rows.map((r) => r.join(",")).join("\\n");\n');
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

function fixture() {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'CSV 导出','src/','toCsv 可用','["不得引入依赖"]',?,?)`, newId('c'), taskId, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写 toCsv','导出 toCsv(rows)','export.mjs 导出 toCsv 且逗号分隔','pending','normal','standard',?)`,
  nodeId, taskId, t);
  return { db, taskId, nodeId };
}
const handoffArgs = (over = {}) => ({
  artifacts: [{ path: 'export.mjs', kind: 'source' }], interface_contract: 'toCsv(rows) -> string',
  acceptance_evidence: 'node -e 通过', key_decisions: [], known_issues: [], downstream_notes: '',
  assumptions: [{ subject_key: 'csv.delimiter', statement: '逗号', verified_against: 'spec', verification: '规格第 1 条原文"逗号分隔"' }],
  ...over,
});
const call = (name, args) => ({ stopReason: 'tool_call', usage: { inputTokens: 10, outputTokens: 5 },
  content: [{ type: 'tool_call', id: `c_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args }] });
const verdict = (v, extra = {}) => call('submit_verdict', { verdict: v, evidence_checked: ['export.mjs'], ...extra });

// ═══════════════════════════════════════════════════════════════════════════
section('1. 验收员拿到的上下文里没有执行器的东西，工具只有只读三件');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId } = fixture();
  let seen = null;
  const fake = makeFake([verdict('accept')]);
  const orig = fake.nextScripted.bind(fake);
  const client = new LlmClient({ mode: 'fake', fake });
  // 截住发给模型的请求：LlmClient.complete(canon) 在 fake 模式下不经 buildRequest，
  // 所以从 runToolLoop 的入参截 —— 包一层 complete。
  const realComplete = client.complete.bind(client);
  client.complete = async (canon) => { seen ??= canon; return realComplete(canon); };
  const r = await verifyHandoff(db, { client, taskId, nodeId, workspace: WS, exec: new LocalExecutor(), args: handoffArgs() });
  eq(r.verdict, 'accept', 'accept 直通');
  const toolNames = seen.tools.map((t) => t.name).sort().join(',');
  eq(toolNames, 'grep,list_dir,read_file,submit_verdict', '工具集：三件只读 + 一个出口，没有 write_file / run_command');
  // runToolLoop 原地往 messages 里追加 tool_results（没有 content），所以只看 content 段
  const text = seen.messages.map((m) => (m.content ?? []).map((b) => b.text ?? '').join('')).join('\n');
  assert(text.includes('export.mjs 导出 toCsv 且逗号分隔'), '上下文含节点验收标准');
  assert(text.includes('它声称的验收证据'), '交接记录的证据被标为"它声称的"');
  assert(!text.includes('交接记录已受理') && !text.includes('[系统] 还剩'), '上下文里没有执行器循环的任何痕迹');
  eq(db.one(`SELECT count(*) AS n FROM audit_log WHERE action='handoff_verified' AND target_id=?`, nodeId).n, 1, 'handoff_verified 审计');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 没结论 = 打回；打回必须带理由；取舍型假设被打回');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId } = fixture();
  const exec = new LocalExecutor();
  // 只读了文件、一直不给结论 → 前 N-1 轮用完后，最后一轮工具只剩 submit_verdict；仍不给才打回
  const requests = [];
  const spy = (fake) => { const c = new LlmClient({ mode: 'fake', fake }); const real = c.complete.bind(c);
    // messages 是循环原地追加的同一个数组，要在请求那一刻快照
    c.complete = async (canon) => { requests.push({ ...canon, messages: [...canon.messages] }); return real(canon); }; return c; };
  let r = await verifyHandoff(db, { client: spy(makeFake([
    call('read_file', { path: 'export.mjs' }), call('read_file', { path: 'export.mjs' }),
    call('read_file', { path: 'export.mjs' }), call('read_file', { path: 'export.mjs' })])),
  taskId, nodeId, workspace: WS, exec, args: handoffArgs(), maxIterations: 3 });
  eq(r.verdict, 'reject', '没给结论 → reject（验收员挂了不是免检通道）');
  assert(r.reasons.some((x) => x.includes('没有给出结论')), '理由说清是没结论');
  eq(requests.length, 4, 'maxIterations=3 → 总共 4 次请求（2 轮只读 + 2 轮收窄）');
  eq(requests[0].tools.map((t) => t.name).sort().join(','), 'grep,list_dir,read_file,submit_verdict', '前几轮带只读工具');
  eq(requests[2].tools.map((t) => t.name).join(','), 'submit_verdict', '收窄段**只有** submit_verdict —— 护栏住在模型外，它想读也没得读');
  eq(requests[3].tools.map((t) => t.name).join(','), 'submit_verdict', '收窄段第二轮同样只有 submit_verdict（它在第一轮调了没提供的工具，看见 unknown tool 后再来一次）');
  const tr = requests[3].messages.filter((m) => m.role === 'tool_results').at(-1).results[0].content;
  assert(tr.startsWith('unknown tool'), '收窄后调只读工具得到的是 unknown tool，不是文件内容');
  const aud = JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='handoff_verified' AND target_id=? ORDER BY ts DESC LIMIT 1`, nodeId).payload);
  assert(typeof aud.lastTurn === 'string' && aud.lastTurn.includes('read_file'), '没结论时审计里留了最后一轮的响应（知道它在干什么）');
  const lastNote = requests[2].messages.filter((m) => m.role === 'tool_results').at(-1).results.at(-1).content;
  assert(lastNote.includes('只剩 submit_verdict'), '只读段最后一轮的报数说清下一轮工具会收窄');
  eq(requests[2].messages.length, requests[1].messages.length + 2, '收窄那一轮接着同一份历史（多了 assistant + tool_results 两条），不是重开上下文');

  // 假模型只在工具收窄后才给结论 → accept，且理由里没有"没结论"
  requests.length = 0;
  r = await verifyHandoff(db, { client: spy(makeFake([
    call('read_file', { path: 'export.mjs' }), call('grep', { pattern: 'toCsv', path: '.' }), verdict('accept')])),
  taskId, nodeId, workspace: WS, exec, args: handoffArgs(), maxIterations: 3 });
  eq(r.verdict, 'accept', '收窄后给出的结论照常生效 → accept');
  eq(requests.at(-1).tools.map((t) => t.name).join(','), 'submit_verdict', '结论是在只剩 submit_verdict 的那一轮给的');
  eq(r.llmCalls, 3, 'llmCalls 把两段加起来');
  eq(r.stopped, 'terminal_tool', 'stopped 取最后一段的');

  // 模型以纯文本收尾（没调工具）→ 补回 assistant 轮 + user 提示，再收窄
  requests.length = 0;
  r = await verifyHandoff(db, { client: spy(makeFake([
    { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, content: [{ type: 'text', text: '我觉得没问题。' }] },
    verdict('accept')])),
  taskId, nodeId, workspace: WS, exec, args: handoffArgs(), maxIterations: 3 });
  eq(r.verdict, 'accept', '纯文本收尾不算结论，收窄后再问一次拿到 accept');
  const roles = requests.at(-1).messages.map((m) => m.role).join(',');
  eq(roles, 'user,assistant,user', '收窄轮的历史：原提示 + 模型的文本 + 系统说明（没有 tool_results 后接 user 文本的可疑形状）');

  r = await verifyHandoff(db, { client: new LlmClient({ mode: 'fake', fake: makeFake([
    verdict('reject', { reasons: ['export.mjs 第 1 行用的是分号不是逗号'] })]) }),
  taskId, nodeId, workspace: WS, exec, args: handoffArgs() });
  eq(r.verdict, 'reject', '明确打回');
  eq(r.reasons[0], 'export.mjs 第 1 行用的是分号不是逗号', '理由原样带回');

  // 产物 accept，但 settled_by_me 的假设被打回 → 整体 reject
  r = await verifyHandoff(db, { client: new LlmClient({ mode: 'fake', fake: makeFake([
    verdict('accept', { assumption_pushbacks: [{ subject_key: 'csv.quote', why: '要不要给字段加引号是接口形状，人该拍板' }] })]) }),
  taskId, nodeId, workspace: WS, exec,
  args: handoffArgs({ assumptions: [{ subject_key: 'csv.quote', statement: '不加引号', verified_against: 'settled_by_me', verification: '我定的' }] }) });
  eq(r.verdict, 'reject', '产物过了但取舍型假设被打回 → 整体 reject（验收员打回取舍型假设）');
  assert(r.reasons.some((x) => x.includes('csv.quote') && x.includes('人该拍板')), '理由指向那条假设');
  eq(r.pushbacks.length, 1, 'pushbacks 带回');
  db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 接进执行器：打回走与 schema 拒回同一条路，改完再交能过');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId } = fixture();
  const exec = new LocalExecutor();
  const verdicts = ['reject', 'accept'];
  let calls = 0;
  const verifier = async ({ args }) => {
    calls++;
    const v = verdicts.shift();
    return v === 'accept' ? { verdict: 'accept', reasons: [], pushbacks: [] }
      : { verdict: 'reject', reasons: ['第一次交的分隔符不对'], pushbacks: [] };
  };
  const exClient = new LlmClient({ mode: 'fake', fake: makeFake([
    call('submit_handoff', handoffArgs()),
    call('submit_handoff', handoffArgs()),
  ]) });
  const r = await executeNode(db, { client: exClient, taskId, nodeId, workspace: WS, tier: 'standard',
    vendorId: 'fake', narrativeDir: join(TMP, 'nar'), exec, verifier, maxIterations: 4 });
  eq(r.kind, 'done', '第二次交接过了 → done');
  eq(calls, 2, '验收员被调了两次');
  eq(r.rejections.length, 1, '一次拒回');
  assert(r.rejections[0][0].startsWith('[验收员]'), '拒回理由标明来自验收员');
  const rej = db.all(`SELECT payload FROM audit_log WHERE action='handoff_rejected' AND target_id=?`, nodeId).map((x) => JSON.parse(x.payload));
  eq(rej.length, 1, 'handoff_rejected 审计一条');
  eq(rej[0].by, 'verifier', '审计标明 by=verifier —— 与 schema 拒回分得开');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, nodeId).status, 'done', '节点 done');

  // 不传 verifier → 不验（离线夹具默认）
  const { db: db2, taskId: t2, nodeId: n2 } = fixture();
  const r2 = await executeNode(db2, { client: new LlmClient({ mode: 'fake', fake: makeFake([call('submit_handoff', handoffArgs())]) }),
    taskId: t2, nodeId: n2, workspace: WS, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, 'nar'), exec });
  eq(r2.kind, 'done', 'verifier=null → 直接 done（默认关，测它的地方显式开）');
  db.close(); db2.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. 人的裁定进验收员的眼睛：本节点 / 任务级、经认证通道的答复列出；超时默认答复不列');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, nodeId } = fixture();
  const { userId } = ensureOwner(db);
  const tokenId = db.one(`SELECT id FROM tokens WHERE user_id=?`, userId).id;
  const t = now();
  const ask = (nid, text) => { const id = newId('q'); db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
      VALUES (?,?,?,2,'classifier',?,'默认',?,NULL,'answered')`, id, taskId, nid, text, t); return id; };
  const reply = (qid, body, trust) => { const mid = newId('m');
    db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
            VALUES (?,?,?,?,'answer','explicit','normal','explicit',?,?,?)`, mid, taskId, trust === 'user-authenticated' ? userId : null, body, trust, trust === 'user-authenticated' ? tokenId : null, t);
    insertEdge(db, mid, qid, 'answers', t); };
  reply(ask(nodeId, '改一条既有测试断言行不行？'), '行，只这一条', 'user-authenticated');
  reply(ask(null, '任务级：编码用 UTF-8 吗？'), 'UTF-8', 'user-authenticated');
  reply(ask(nodeId, '超时那条'), '[超时默认] 默认', 'agent-generated');
  const otherNode = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES (?,?,'别的节点','s','a','pending','normal','standard',?)`, otherNode, taskId, t);
  reply(ask(otherNode, '别的节点的问题'), '别的节点的答复', 'user-authenticated');
  let seen = null;
  const client = new LlmClient({ mode: 'fake', fake: makeFake([verdict('accept')]) });
  const real = client.complete.bind(client);
  client.complete = async (canon) => { seen ??= canon; return real(canon); };
  await verifyHandoff(db, { client, taskId, nodeId, workspace: WS, exec: new LocalExecutor(), args: handoffArgs() });
  const text = seen.messages[0].content[0].text;
  assert(text.includes('人的裁定') && text.includes('行，只这一条'), '本节点的人答进了提示词');
  assert(text.includes('UTF-8'), '任务级的人答也进');
  assert(!text.includes('[超时默认]'), '超时默认答复（系统写的）不算裁定');
  assert(text.includes('别的节点的答复'), '同一任务别的节点的裁定也进（裁定是任务范围的：放行的改动会留在工作区里，后面的节点被验收时改动集里仍有它）');
  assert(/人明确放行的事/.test(seen.system) && text.includes('不再按约束字面判违规'), '系统提示与正文都说明裁定压过约束字面');
  assert(text.includes('不是本节点的判据') && /任务级完成定义不是本节点的判据/.test(seen.system), '任务级完成定义标成"不是本节点判据"（例：README 没更新被拿来打回测试节点）');
  assert(/期望值要有出处/.test(seen.system) && /让实现给自己背书/.test(seen.system), '新写测试的期望值要有规格出处（例：实现有错，自写测试照样全绿）');
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
