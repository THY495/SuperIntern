// 会签、路由范围写法、交付提示
//
// 跑：node tests/cosign-delivery.test.mjs
//
// ⑤ 路由范围写成 frontend/** → 保存时换成 frontend/，旧库里的 glob 行匹配时也认。
// ⑥ 负责人不绕过会签：配了多人全签的签收 / 计划变更，负责人只算一票；计划变更够数后由事项钩子应用 / 驳回（原来只有卡片按钮会应用）。
// ① 项目达成、还没交付 → 负责人待办里有"等你交付"（计入要处理的），交付了才消失；守护进程给负责人发一次通知（只发一次）。
//    否则多人会签确认达成后负责人收件箱是空的，交付就没人点。

import { openDb, ensureOwner, now, audit } from '../src/db/db.mjs';
import { buildDigest, renderDigest } from '../src/core/digest.mjs';
import { notifyPendingDeliveries, addUser } from '../src/core/users.mjs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '../src/db/db.mjs';
import { startProjectFromBrief } from '../src/agent/project-planner.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import { rulesOf, saveRules, routeQuestion, normScope, matchChains } from '../src/core/routing.mjs';
import { proposeRevision, nodesForReplan } from '../src/core/revision.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const db = openDb(':memory:');
const owner = ensureOwner(db);

section('① 已达成、还没交付的项目进负责人的待办，并通知一次');
{
  const at = now();
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,status,draft_version,created_at,goal,done_definition,visibility)
          VALUES ('pj_d','${owner.userId}','待办清单','b','/r','superintern/pj_d','main','done',1,?,'g','d','team')`, at);
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,status,draft_version,created_at,goal,done_definition,visibility)
          VALUES ('pj_a','${owner.userId}','还在做','b','/r','superintern/pj_a','main','active',1,?,'g','d','team')`, at);
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order,merged_at) VALUES ('t_1',?,'T1','done',?,'pj_d',1,?)`, owner.userId, at, at);
  let d = buildDigest(db, { userId: owner.userId });
  eq(d.toDeliver.length, 1, '达成的那个在"等你交付"里，还在做的不在');
  eq(d.toDeliver[0].projectId, 'pj_d', '是达成的那个');
  assert(d.actionable >= 1, '计入要你处理的（收件箱的"N 项待你处理"会亮）');
  assert(/等你交付/.test(renderDigest(d)) && /交付项目/.test(renderDigest(d)), '摘要文字说了去哪点');

  const sent = [];
  const spawn = (cmd, args) => { sent.push(args.join(' ')); return { status: 0, stdout: '', stderr: '' }; };
  const r1 = await notifyPendingDeliveries(db, { env: {}, extraCmd: 'echo hi', spawn });
  eq(r1.length, 1, '通知发出一次');
  const r2 = await notifyPendingDeliveries(db, { env: {}, extraCmd: 'echo hi', spawn });
  eq(r2.length, 0, '同一个项目不重发');

  audit(db, { actorKind: 'user', actorId: owner.userId, action: 'project_delivered', targetType: 'project', targetId: 'pj_d', payload: {} });
  d = buildDigest(db, { userId: owner.userId });
  eq(d.toDeliver.length, 0, '交付之后从待办里消失');

  // ① 追加还在起草时不提示交付；② 交付之后又有新合并 → 再提示一次（原来按"交付过没有"判，新的那部分永远没交付）
  await new Promise((ok) => setTimeout(ok, 5));
  const later = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order,merged_at) VALUES ('t_c0',?,'项目规划','planning',?,'pj_d',0,NULL)`, owner.userId, later);
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order,merged_at) VALUES ('t_2',?,'T2 标签','done',?,'pj_d',2,?)`, owner.userId, later, later);
  eq(buildDigest(db, { userId: owner.userId }).toDeliver.length, 0, '追加还在起草（规划载体 planning）→ 不提示交付');
  db.run(`UPDATE tasks SET status='done' WHERE id='t_c0'`);
  d = buildDigest(db, { userId: owner.userId });
  eq(d.toDeliver.length, 1, '交付之后又合并了新任务 → 再提示交付');
  assert(d.toDeliver[0].again && d.toDeliver[0].sinceDelivery === 1 && /又合并了 1 个任务/.test(renderDigest(d)), '说明是"上次交付之后又合并了 1 个"');
  eq((await notifyPendingDeliveries(db, { env: {}, extraCmd: 'echo hi', spawn })).length, 1, '这一批新合并再通知一次');
  eq((await notifyPendingDeliveries(db, { env: {}, extraCmd: 'echo hi', spawn })).length, 0, '同一批不重发');
}

const TMP = mkdtempSync(join(tmpdir(), 'si-cosign-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SRC = join(TMP, 'src');
mkdirSync(join(SRC, 'frontend'), { recursive: true }); git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'frontend', 'a.js'), 'x\n'); git(SRC, 'add', '.'); git(SRC, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
const lin = addUser(db, { name: '阿青', role: 'member', byUserId: owner.userId });
const zhou = addUser(db, { name: '阿明', role: 'member', byUserId: owner.userId });
const as = (u) => (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: u.plaintext });

section('⑤ 路由范围的 glob 写法');
{
  eq(normScope('frontend/**'), 'frontend/', 'frontend/** → frontend/');
  eq(normScope('./backend/*'), 'backend/', './backend/* → backend/');
  eq(normScope('**'), '*', '** → *');
  eq(normScope('frontend'), 'frontend/', 'frontend → frontend/');
  const rows = [{ decision_type: 'spec_choice', scope: 'frontend/**', position: 0, recipients: ['user:x'], quorum: '1' }, { decision_type: 'spec_choice', scope: '*', position: 0, recipients: ['user:lead'], quorum: '1' }];
  eq(matchChains(rows, { decisionType: 'spec_choice', prefixes: ['frontend'] })[0]?.scope, 'frontend/**', '旧库里的 frontend/** 行也能匹配上 frontend 前缀');
}

const P = startProjectFromBrief(db, { userId: owner.userId, brief: '待办清单\n前后端', source: SRC, home: join(TMP, 'h') });
const carrier = db.one(`SELECT id FROM tasks WHERE project_id=? AND project_order=0`, P.projectId).id;
db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,scope_paths,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','s','["frontend/"]','d','[]',?,?)`, newId('c'), carrier, now(), now());
{
  const rows = rulesOf(db, P.projectId).map(({ id, project_id, template, ...r }) => r);
  for (const r of rows) {
    if (r.decision_type === 'contract_approval') { r.recipients = ['user:lead', `user:${lin.userId}`, `user:${zhou.userId}`]; r.quorum = 'all'; }
    if (r.decision_type === 'signoff') { r.recipients = ['user:lead', `user:${lin.userId}`]; r.quorum = 'all'; }
  }
  rows.push({ ...rows.find((r) => r.decision_type === 'spec_choice'), scope: 'frontend/**', recipients: [`user:${lin.userId}`], quorum: '1' });
  saveRules(db, { key: P.projectId, rules: rows, userId: owner.userId });
  assert(rulesOf(db, P.projectId).some((r) => r.decision_type === 'spec_choice' && r.scope === 'frontend/'), '保存时 frontend/** 存成了 frontend/');
}

section('⑥ 计划变更：三人全签，负责人只算一票；够数后事项钩子应用变更');
const revision = (tag) => {
  const mid = newId('m');
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
          VALUES (?,?,?,?,'correction','explicit','normal','explicit','user-authenticated',?,?)`, mid, carrier, owner.userId, `把截图目录加进范围 ${tag}`,
    db.one(`SELECT id FROM tokens WHERE user_id=? LIMIT 1`, owner.userId)?.id ?? 'tk', now());
  const message = db.one(`SELECT * FROM messages WHERE id=?`, mid);
  return proposeRevision(db, { taskId: carrier, message, nodes: nodesForReplan(db, carrier),
    rev: { impact: [], salvage: [], changed_nodes: [], new_nodes: [], constitution_patch: { scope: `s ${tag}` }, rationale: 'r' } });
};
{
  const r = revision('1');
  assert(!!r.questionId, '触及宪法层 → 挂了批准事项');
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, r.questionId).addressed_to).length, 3, '送三个人');
  let a = as(owner)(r.questionId, 'A');
  eq(a.resolved, false, '负责人批了只算一票（原来：负责人一答就定案）');
  eq(db.one(`SELECT status FROM revisions WHERE id=?`, r.revisionId).status, 'proposed', '变更还没生效');
  as(lin)(r.questionId, '批准');
  a = as(zhou)(r.questionId, 'A');
  eq(a.resolved, true, '三人都批了 → 定案（"A" 与 "批准" 按方向归并，不算冲突）');
  eq(db.one(`SELECT status FROM revisions WHERE id=?`, r.revisionId).status, 'applied', '事项钩子应用了变更（原来：只有卡片按钮会应用）');
}
{
  const r = revision('2');
  as(owner)(r.questionId, 'B：范围别动');
  as(lin)(r.questionId, 'B：同意负责人');
  as(zhou)(r.questionId, '驳回，不需要');
  eq(db.one(`SELECT status FROM revisions WHERE id=?`, r.revisionId).status, 'rejected', '都驳回 → 驳回');
}

section('⑥ 签收：配了"负责人 + 阿青，都要签"，负责人一答不定案');
{
  const qid = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,NULL,3,'hard_rule','【签收】x',NULL,?,NULL,'open')`, qid, carrier, now());
  routeQuestion(db, { questionId: qid, decisionType: 'signoff', typeSource: 'hard_rule' });
  const a = as(owner)(qid, '接受');
  eq(a.resolved, false, '负责人签了，还等阿青（原来：负责人一答即定案，提需求的人的那一票没用上）');
}

section('⑦ 上限事项只能转给能改上限的人');
{
  const { transferQuestion } = await import('../src/core/routing.mjs');
  const qid = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,NULL,3,'hard_rule','【硬上限触顶】x',NULL,?,NULL,'open')`, qid, carrier, now());
  routeQuestion(db, { questionId: qid, decisionType: 'budget', typeSource: 'hard_rule' });
  let err = null;
  try { transferQuestion(db, { questionId: qid, to: [`user:${zhou.userId}`], byUserId: owner.userId }); } catch (e) { err = e.message; }
  assert(err && /只能转给能改上限的人/.test(err) && /阿明/.test(err), `转给改不了上限的阿明被拒，并说明为什么（${String(err).slice(0, 60)}…）`);
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, qid).addressed_to).join(), owner.userId, '事项还在负责人手上');
}

section('③ 有界面却没写 si-preview.json → 系统补一步让执行器写，写完再截图、再请签收（不交给人打回）');
{
  const { orchestrate, PREVIEW_NODE_KEY } = await import('../src/core/orchestrator.mjs');
  const { LocalExecutor } = await import('../src/core/executor.mjs');
  const { LlmClient } = await import('../src/llm/client.mjs');
  const { makeFake } = await import('../src/llm/providers.mjs');
  const { hasUi } = await import('../src/core/preview.mjs');
  // 真沙箱才截图；这里让"起服务 / 探活 / 截图"那几条命令直接成功，其余照常在本机跑
  class FakeSandbox extends LocalExecutor {
    isolated = true;
    execute(cmd, ws, lim) { return ['curl', 'sh', 'setsid', 'timeout', 'chromium', 'kill'].includes(cmd.file) ? Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }) : super.execute(cmd, ws, lim); }
  }
  const ws = join(TMP, 'ui'); mkdirSync(join(ws, 'frontend'), { recursive: true });
  writeFileSync(join(ws, 'frontend', 'package.json'), JSON.stringify({ name: 'f', devDependencies: { vite: '^5' } }));
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@t'); git(ws, 'config', 'user.name', 't'); git(ws, 'add', '.'); git(ws, 'commit', '-q', '-m', 'init');
  assert(hasUi(ws), 'frontend/package.json 依赖了 vite → 认作有界面');
  const tid = newId('t'), t0 = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'有界面','running',?)`, tid, owner.userId, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), tid, t0, t0);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,risk_tier,model_tier,created_at) VALUES (?,?,'页面','写页面','文件存在','pending',1,'normal','standard',?)`, newId('n'), tid, t0);
  const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${Math.random().toString(16).slice(2, 8)}`, name, args }], usage: { inputTokens: 100, outputTokens: 20 } });
  const H = (path) => ({ artifacts: [{ path, kind: 'source' }], interface_contract: 'x', acceptance_evidence: `node -e 0 → exit 0，${path} 已写` });
  const client = new LlmClient({ mode: 'fake', fake: makeFake([
    call('write_file', { path: 'frontend/index.html', content: '<h1>待办清单</h1>\n' }), call('submit_handoff', H('frontend/index.html')),
    call('write_file', { path: 'si-preview.json', content: JSON.stringify({ start: ['node frontend/s.js'], url: 'http://127.0.0.1:5173', pages: [{ path: '/', title: '首页' }] }) }), call('submit_handoff', H('si-preview.json')),
  ]) });
  const r = await orchestrate(db, { taskId: tid, workspace: ws, narrativeDir: join(TMP, 'narr-ui'), verify: false, exec: new FakeSandbox(), makeClient: () => client, onEvent: () => {} });
  eq(r.kind, 'complete', '任务照常做完');
  const added = db.one(`SELECT payload FROM audit_log WHERE action='preview_node_added' AND target_id=?`, tid);
  assert(!!added, '系统补了一步"写页面截图说明"');
  eq(db.all(`SELECT status FROM nodes WHERE task_id=?`, tid).map((n) => n.status).join(','), 'done,done', '两步都做完（原来那步 + 补的那步）');
  assert(!!db.one(`SELECT 1 FROM audit_log WHERE action IN ('preview_captured','preview_failed') AND target_id=?`, tid), '写完之后照 si-preview.json 截图了');
  assert(!!db.one(`SELECT 1 FROM questions WHERE task_id=? AND decision_type='signoff'`, tid), '然后才请签收');
  assert(!!db.one(`SELECT value FROM params WHERE task_id=? AND key=?`, tid, PREVIEW_NODE_KEY), '记下补过了（每个任务只补一次）');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
