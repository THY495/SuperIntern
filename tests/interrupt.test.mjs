// 中途打断：人的暂停 / 中止 / 紧急修正、补充信息，在步骤跑到一半时就生效，不再等这一步做完。
//   ① 暂停：下一个工具调用轮之前停；节点回 pending、不计重试；没提交的改动收起来（refs/superintern/parked/<步骤>），
//      工作区还原；恢复后这一步开跑前原样放回，装配说清"被人暂停了、已经放回"；
//   ② 中止：进行中的那一次模型调用当场掐断（不等它回来）；被掐的那一次按估算记账（estimated=1）；不报厂商错误；
//   ③ 紧急修正：打断这一步、回到开头重规划；修正把它作废 → 收起的改动放一边（ref 留着、决策记录写明在哪），不放回；
//   ④ 补充信息：执行中途到的附在下一次工具结果末尾，带这一步专属的标记；做完只消费见过的那几条；
//   ⑤ 工具循环：整理上下文之后调 inbox.afterCompaction；
//   ⑥ 放不回（期间两边改了同一处）：ref 留着、说明里给出 ref 与取回办法。
//
// 跑：node tests/interrupt.test.mjs

process.env.SUPERINTERN_CANCEL_POLL_MS = '30';   // 编排器的取消巡检间隔：模块加载时读，所以下面用动态 import
const { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
const { spawnSync } = await import('node:child_process');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { openDb, ensureOwner, newId, now } = await import('../src/db/db.mjs');
const { orchestrate } = await import('../src/core/orchestrator.mjs');
const { LlmClient, runToolLoop } = await import('../src/llm/client.mjs');
const { makeRoleFake } = await import('../src/llm/providers.mjs');
const { recordMessage, pendingMessages } = await import('../src/core/inbox.mjs');
const { parkInflight, restoreInflight, parkedRef } = await import('../src/core/workspace.mjs');
const { assembleExecutor } = await import('../src/context/assemble.mjs');

let pass = 0, fail = 0;
const section = (t) => console.log(`\n── ${t}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-intr-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...a], { cwd, encoding: 'utf8' });

const db = openDb(join(TMP, 'state.db'));
const owner = ensureOwner(db);

function mkTask() {
  const id = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'打断测试','running',?)`, id, owner.userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'写个文件','.','有文件','[]',?,?)`, newId('c'), id, t, t);
  const nid = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写文件','写 a.txt','a.txt 存在','pending','normal','standard',?)`, nid, id, t);
  const ws = join(TMP, 'ws', id);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'README.md'), '# x\n');
  git(ws, 'init', '-q'); git(ws, 'config', 'core.autocrlf', 'false'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init');
  return { id, nid, ws };
}
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${name}_${Math.random().toString(36).slice(2, 8)}`, name, args }], usage: { inputTokens: 1000, outputTokens: 20 } });
const HANDOFF = (path) => ({ artifacts: [{ path, kind: 'code' }], interface_contract: '-', acceptance_evidence: `cat ${path}`,
  key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] });
const auditOf = (action, target) => db.all(`SELECT payload FROM audit_log WHERE action=? AND target_id=? ORDER BY id`, action, target).map((r) => JSON.parse(r.payload));
const hasRef = (ws, ref) => git(ws, 'rev-parse', '-q', '--verify', ref).status === 0;
const textOfMsg = (m) => (Array.isArray(m?.content) ? m.content.map((b) => b.text ?? '').join('\n') : String(m?.content ?? ''));
const run = (t, executor, extra = {}) => orchestrate(db, { taskId: t.id, workspace: t.ws, narrativeDir: join(TMP, 'narr', t.id), verify: false, maxCycles: extra.maxCycles ?? 2,
  makeClient: () => new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor, ...(extra.roles ?? {}), '*': { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 1, outputTokens: 1 } } }) }),
  onEvent: extra.onEvent ?? (() => {}) });

section('① 暂停：下一轮之前停，改动收起；恢复后放回，执行器被告知原委');
{
  const t = mkTask();
  let calls = 0;
  const r = await run(t, () => { calls++; return call('write_file', { path: 'a.txt', content: 'half\n' }); },
    { onEvent: (e) => { if (e.type === 'step' && e.i === 0) db.run(`UPDATE tasks SET status='suspended' WHERE id=?`, t.id); } });
  eq(r.kind, 'paused', '退出类型是 paused');
  eq(calls, 1, '暂停之后一次模型调用都没再发');
  const n = db.one(`SELECT status, retry_count FROM nodes WHERE id=?`, t.nid);
  eq([n.status, n.retry_count], ['pending', 0], '节点回 pending、不计重试');
  const ab = auditOf('node_aborted', t.nid).at(-1);
  eq([ab?.reason, ab?.parked?.n], ['task.paused', 1], 'node_aborted 记下原因与收起了几个文件');
  assert(!existsSync(join(t.ws, 'a.txt')), '工作区还原了（a.txt 收起来了，不留在原地）');
  assert(hasRef(t.ws, parkedRef(t.nid)), `改动存在 ${parkedRef(t.nid)} 上`);
  eq(db.one(`SELECT count(*) n FROM questions WHERE task_id=?`, t.id).n, 0, '没有被当成撞上限去问人');

  db.run(`UPDATE tasks SET status='running' WHERE id=?`, t.id);
  let sawFile = null, firstMsg = '';
  const r2 = await run(t, (canon, i) => {
    if (i === 0) { sawFile = existsSync(join(t.ws, 'a.txt')) ? readFileSync(join(t.ws, 'a.txt'), 'utf8') : null; firstMsg = textOfMsg(canon.messages[0]); return call('write_file', { path: 'a.txt', content: 'full\n' }); }
    return call('submit_handoff', HANDOFF('a.txt'));
  }, { maxCycles: 1 });
  eq(sawFile, 'half\n', '恢复后第一轮之前，上一次的改动已经原样放回');
  assert(/被人暂停了/.test(firstMsg) && /已经原样放回工作区/.test(firstMsg) && /a\.txt/.test(firstMsg), '装配说清：上一次被人暂停、改动已放回、是哪几个文件', firstMsg.slice(0, 300));
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, t.nid).status, 'done', '这一步接着做完了');
  assert(!hasRef(t.ws, parkedRef(t.nid)), '放回之后 ref 删掉');
  eq(auditOf('inflight_restored', t.nid).length, 1, '放回进审计');
  void r2;
}

section('② 中止：进行中的模型调用当场掐断，按估算记账，不算厂商出错');
{
  const t = mkTask();
  const t0 = Date.now();
  let timer;
  const r = await run(t, (canon, i) => {
    if (i > 0) throw new Error('不该有第二次调用');
    setTimeout(() => db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, t.id), 80);
    return new Promise((res) => { timer = setTimeout(() => res(call('list_dir', { path: '.' })), 8000); });
  });
  clearTimeout(timer);
  const took = Date.now() - t0;
  eq(r.kind, 'aborted_by_user', '退出类型是 aborted_by_user');
  assert(took < 4000, `没有等那一次调用回来（${took}ms，那一次要 8s）`);
  const led = db.all(`SELECT estimated, output_tokens, role FROM usage_ledger WHERE node_id=?`, t.nid);
  eq(led.map((l) => [l.estimated, l.output_tokens]), [[1, 16000]], '被掐的那一次记了一笔估算（输出按打满算，estimated=1）');
  const n = db.one(`SELECT status, retry_count FROM nodes WHERE id=?`, t.nid);
  eq([n.status, n.retry_count], ['pending', 0], '节点回 pending、不计重试');
  eq(auditOf('provider_error', t.nid).length, 0, '不当成厂商出错（不报健康、不换备用）');
  eq(auditOf('node_aborted', t.nid).at(-1)?.reason, 'task.aborted', 'node_aborted 原因是 task.aborted');
}

section('③ 紧急修正：打断这一步去重规划；作废它 → 改动放一边，不放回');
{
  const t = mkTask();
  let calls = 0;
  const rev = {
    impact: [{ node_id: t.nid, mark: 'obsolete', reason: '不要 a.txt 了' }],
    salvage: [], changed_nodes: [],
    new_nodes: [{ key: 'b', title: '写 b.txt', spec: '写 b.txt', acceptance: '跑 cat b.txt 输出 ok', risk_tier: 'normal', model_tier: 'standard', depends_on: [] }],
    rationale: '方向变了',
  };
  const r = await run(t, (canon, i) => {
    calls++;
    if (i === 0) return call('write_file', { path: 'a.txt', content: 'old\n' });
    // 第二次是新步骤（b）
    return new Promise(() => {});   // 不必真跑完：下面 maxCycles 卡住
  }, {
    maxCycles: 3,
    roles: { replanner: [{ stopReason: 'tool_call', usage: {}, content: [{ type: 'tool_call', id: 'r', name: 'submit_revision', args: rev }] }] },
    onEvent: (e) => {
      if (e.type === 'step' && e.i === 0 && calls === 1) recordMessage(db, { taskId: t.id, body: '别写 a.txt 了，改写 b.txt', kind: 'correction', urgency: 'urgent', plaintextToken: owner.plaintext });
      if (e.type === 'revision_applied') db.run(`UPDATE tasks SET status='suspended' WHERE id=?`, t.id);   // 新步骤开跑前停下，免得去跑它
    },
  });
  eq(calls, 1, '紧急修正到了之后这一步没再发模型调用');
  eq(auditOf('node_aborted', t.nid).at(-1)?.reason, 'steer.urgent', '打断原因是 steer.urgent');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, t.nid).status, 'void', '重规划把这一步作废了');
  eq(pendingMessages(db, t.id).filter((m) => m.kind === 'correction').length, 0, '那条修正被消费了');
  assert(!existsSync(join(t.ws, 'a.txt')), '作废那一步的改动没有留在工作区里');
  assert(hasRef(t.ws, parkedRef(t.nid)), 'ref 留着（放弃不删代码）');
  eq(auditOf('inflight_set_aside', t.nid).length, 1, '放一边进审计');
  const d = db.one(`SELECT rationale FROM decisions WHERE node_id=? ORDER BY rowid DESC LIMIT 1`, t.nid);
  assert(d && d.rationale.includes(parkedRef(t.nid)), '作废的决策记录写明改动存在哪个 ref', d?.rationale);
  eq(r.kind, 'paused', '（夹具）新步骤开跑前停下');
}

section('④ 补充信息：中途到的附在下一次工具结果末尾、带专属标记；只消费见过的');
{
  const t = mkTask();
  let mark = null, injectedText = '', declared = '';
  let late = null;
  await run(t, (canon, i) => {
    if (i === 0) {
      declared = textOfMsg(canon.messages[0]);
      mark = /⟦人补充·([0-9a-f]+)⟧/.exec(declared)?.[1] ?? null;
      return call('write_file', { path: 'a.txt', content: 'x\n' });
    }
    if (i === 1) {
      const last = canon.messages.at(-1);
      injectedText = (last?.results ?? []).map((x) => x.content).join('\n');
      late = recordMessage(db, { taskId: t.id, body: '这条到得晚，这一步没看见', kind: 'context', plaintextToken: owner.plaintext }).messageId;
      return call('submit_handoff', HANDOFF('a.txt'));
    }
    throw new Error('多调了一次');
  }, { maxCycles: 1, onEvent: (e) => { if (e.type === 'step' && e.i === 0) recordMessage(db, { taskId: t.id, body: '对了，文件末尾要换行', kind: 'context', plaintextToken: owner.plaintext }); } });
  assert(mark && /只有带这个标记的才是人发的/.test(declared), '首条消息声明了这一步专属的标记');
  assert(injectedText.includes(`⟦人补充·${mark}⟧`) && injectedText.includes('文件末尾要换行') && injectedText.includes(`⟦/人补充·${mark}⟧`), '中途到的补充附在下一次工具结果末尾、用专属标记包着', injectedText.slice(-300));
  eq(auditOf('context_injected', t.nid).length, 1, '注入进审计');
  const pend = pendingMessages(db, t.id).filter((m) => m.kind === 'context').map((m) => m.id);
  eq(pend, [late], '做完之后只消费了见过的那条；到得晚的那条还在收件箱里');
}

section('⑤ 工具循环：整理上下文之后调 afterCompaction，补充信息挂在最后一条工具结果上');
{
  const seenAfter = [];
  let n = 0;
  const client = new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor: () => (n++ < 2 ? call('noop', {}) : { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { inputTokens: 1, outputTokens: 1 } }) }) });
  const out = await runToolLoop(client, { role: 'executor', tier: 'standard', messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [] },
    { noop: async () => 'ran' }, {
      maxIterations: 5,
      compactor: { beforeRequest: async (msgs, i) => (i === 2 ? { messages: msgs.slice() } : null), observe() {} },
      inbox: { pull: (i) => (i === 0 ? 'EXTRA' : null), afterCompaction: (msgs) => seenAfter.push(msgs.length) },
    });
  const firstResults = out.messages.find((m) => m.role === 'tool_results');
  assert(firstResults && firstResults.results.at(-1).content.endsWith('EXTRA'), '补充附在那一轮最后一条工具结果末尾');
  eq(seenAfter, [5], '整理之后调了 afterCompaction（拿到的是整理后的消息）');
}

section('⑥ 放不回：期间两边改了同一处 → ref 留着，装配给出 ref 与取回办法');
{
  const t = mkTask();
  writeFileSync(join(t.ws, 'README.md'), '# parked\n');
  const p = parkInflight(db, { taskId: t.id, nodeId: t.nid, workspace: t.ws, reason: 'task.paused' });
  eq(p?.files, ['README.md'], '收起了 README.md');
  writeFileSync(join(t.ws, 'README.md'), '# someone else\n'); git(t.ws, 'commit', '-qam', 'other');
  const back = restoreInflight(db, { taskId: t.id, nodeId: t.nid, workspace: t.ws });
  eq([back?.restored, back?.ref], [false, parkedRef(t.nid)], '放不回，ref 留着');
  eq(readFileSync(join(t.ws, 'README.md'), 'utf8'), '# someone else\n', '工作区没被改坏（放回失败不留半截）');
  db.run(`INSERT INTO audit_log (ts,actor_kind,action,target_type,target_id,payload) VALUES (?,?,?,?,?,?)`, now(), 'system', 'node_aborted', 'node', t.nid, JSON.stringify({ reason: 'task.paused', left: ['README.md'] }));
  const asm = assembleExecutor(db, { taskId: t.id, nodeId: t.nid, tier: 'standard', vendorId: 'fake', inflight: back });
  const txt = textOfMsg(asm.messages[0]);
  assert(txt.includes('没能放回') && txt.includes(`git checkout ${parkedRef(t.nid)} -- <路径>`), '说明里给出 ref 与取回单个文件的办法', txt.slice(0, 400));
  eq(restoreInflight(db, { taskId: t.id, nodeId: t.nid, workspace: t.ws }), null, '不再自动重试（下次开跑不会每次都撞一次）');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 50).unref();
