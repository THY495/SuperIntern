// 几处易用性小修（0.1.1 那批，并进 0.2.0）
//
// 跑：node tests/usability.test.mjs
//
// ① 项目默认标题：目标原样贴进来、第一行是"目标："时，不把"目标："当标题
// ② 路由表：结构矛盾必须含负责人时，报错说清为什么，并指出「系统卡住」可以只派给别人
// ③ 转交可以附一句理由（审计里留着，活动记录显示"谁 把这条转交给 谁：理由"）
// ④ 达成确认的 (B) 明说"还想加新需求也写在这里"
// ⑤ 页面截图说明接了后端却没写 seed：系统补一步让执行器放样例数据（每个任务只补一次）
// ⑥ 同一条机械拒收连续出现：第三次系统替执行器把问题提给人（否则会重交到 20 轮上限）
// ⑦ 并行骨架的契约与规格对不上：补一步让骨架补上（否则契约漏的接口要到集成时才发现是 405）

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openDb, ensureOwner, newId, now, sha256 } from '../src/db/db.mjs';
import { titleFromText } from '../src/agent/project-planner.mjs';
import { applyTemplate, rulesOf, validateRules, routeQuestion, transferQuestion } from '../src/core/routing.mjs';
import { renderReached } from '../src/agent/project-append.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-usability-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const db = openDb(':memory:');
const owner = ensureOwner(db, 'lead');
const lead = owner.userId;
const t0 = now();
const addUser = (name) => {
  const id = newId('u');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,'member','["reviewer"]',?)`, id, name, t0);
  db.run(`INSERT INTO tokens (id,user_id,token_hash,issued_by,issued_at) VALUES (?,?,?,?,?)`, newId('tk'), id, sha256(randomBytes(12).toString('base64url')), lead, t0);
  return id;
};
const alice = addUser('alice');
addUser('bob');

section('① 项目默认标题');
eq(titleFromText('目标：\n做一个待办清单'), '做一个待办清单', '"目标："单独一行 → 取下一行');
eq(titleFromText('目标：做一个番茄钟'), '做一个番茄钟', '"目标：xxx" → 去掉标签');
eq(titleFromText('# 项目目标\n做一个 CLI'), '做一个 CLI', 'Markdown 标题行只有标签词 → 跳过');
eq(titleFromText('Goal: build a todo app'), 'build a todo app', '英文标签同样去掉');
eq(titleFromText('目标：\n\n'), '未命名项目', '什么都没有 → 占位名，不留"目标："');
const longEn = 'Build a recipe app for our family so everyone can keep track of dishes they want to cook, are cooking, and have cooked. Frontend: Vite + React.';
eq(titleFromText(longEn), 'Build a recipe app for our family so everyone can keep track of dishes they…', '太长、第一句也超 80 → 在词边界截，加省略号，不把单词切成两半');
eq(titleFromText('Build a recipe app for our family kitchen. Frontend: Vite + React. Backend: Python FastAPI with SQLite storage.'), 'Build a recipe app for our family kitchen', '太长但第一句放得下 → 用第一句');
eq(titleFromText('做一个家庭菜谱应用，让大家记下想做、在做、做过的菜。前端 Vite + React，后端 Python FastAPI，数据存 SQLite，界面用英文，接口字段固定不能改。'), '做一个家庭菜谱应用，让大家记下想做、在做、做过的菜', '中文同理：第一句');

section('② 路由表：结构矛盾必须含负责人，报错说清为什么');
applyTemplate(db, { key: '', name: 'peer_review', userId: lead });
{
  const base = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  const rows = base.map((r) => ({ ...r, recipients: [...r.recipients] }));
  rows.find((r) => r.decision_type === 'structural').recipients = [`user:${alice}`];
  const msgs = validateRules(db, '', rows).map((e) => e.msg);
  const m = msgs.find((x) => /必须包含负责人/.test(x)) ?? '';
  assert(/结构矛盾/.test(m) && /改项目的约定/.test(m) && /加上「负责人」再保存/.test(m), `报错写明是哪一类、为什么、怎么改：${m}`);
  assert(/系统卡住.*可以只填一个人/.test(m), '报错指出「系统卡住」那一行可以只填一个人');
  const rows2 = base.map((r) => ({ ...r, recipients: [...r.recipients] }));
  const ops = rows2.find((r) => r.decision_type === 'ops');
  if (ops) { ops.recipients = [`user:${alice}`]; ops.quorum = '1'; }
  else rows2.push({ ...base.find((r) => r.decision_type === 'structural'), decision_type: 'ops', recipients: [`user:${alice}`], quorum: '1', timeout_action: 'hang' });
  assert(!validateRules(db, '', rows2).some((e) => /系统卡住.*必须包含负责人/.test(e.msg)), '「系统卡住」只派给一位成员 → 校验通过');
}

section('③ 转交附理由');
{
  const t = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'t','waiting',?)`, t, lead, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), t, t0, t0);
  const mk = () => {
    const q = newId('q');
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,NULL,2,'classifier','要 A 还是 B？','按 A',?,NULL,'open')`, q, t, t0);
    db.tx(() => routeQuestion(db, { questionId: q, decisionType: 'spec_choice', typeSource: 'hard_rule', at: t0 }));
    return q;
  };
  const payloadOf = (q) => JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='question_transferred' AND target_id=? ORDER BY id DESC LIMIT 1`, q).payload);
  const q1 = mk();
  transferQuestion(db, { questionId: q1, to: [`user:${alice}`], byUserId: lead, reason: '  这是界面上的事，你来定  ' });
  eq(payloadOf(q1).reason, '这是界面上的事，你来定', '理由记进审计（去掉首尾空白）');
  eq(payloadOf(q1).to, [alice], '转给了谁也在');
  const q2 = mk();
  transferQuestion(db, { questionId: q2, to: [`user:${alice}`], byUserId: lead });
  eq(payloadOf(q2).reason, null, '不写理由 → null（可留空）');
}

section('④ 达成确认的 (B) 明说可以提新需求');
{
  const p = { id: newId('p'), title: '待办', goal: 'g', done_definition: 'd' };
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,draft_version,created_at) VALUES (?,?,?,?,?,?,?,?,'active',0,?)`, p.id, lead, p.title, 'b', '/r', 'b', 'base', null, t0);
  const text = renderReached(db, { project: p, reason: '都做完了', unverified: [], version: 1 });
  assert(/\(B\) 还差东西，或者还想加新需求/.test(text), '(B) 写明"还想加新需求"');
  assert(/记在你名下/.test(text), '写明这样提的需求记在提的人名下');
}

section('⑤ 截图说明接了后端却没写 seed → 补一步放样例数据（只补一次）');
{
  const { orchestrate, PREVIEW_SEED_NODE_KEY } = await import('../src/core/orchestrator.mjs');
  const { LocalExecutor } = await import('../src/core/executor.mjs');
  const { LlmClient } = await import('../src/llm/client.mjs');
  const { makeFake } = await import('../src/llm/providers.mjs');
  class FakeSandbox extends LocalExecutor {
    isolated = true;
    execute(cmd, ws, lim) { return ['curl', 'sh', 'setsid', 'timeout', 'chromium', 'kill'].includes(cmd.file) ? Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false }) : super.execute(cmd, ws, lim); }
  }
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${Math.random().toString(16).slice(2, 8)}`, name, args }], usage: { inputTokens: 100, outputTokens: 20 } });
  const H = (path) => ({ artifacts: [{ path, kind: 'source' }], interface_contract: 'x', acceptance_evidence: `node -e 0 → exit 0，${path} 已写` });
  const spec = (seed) => JSON.stringify({ start: ['python backend/app.py', 'npm run dev --prefix frontend'], url: 'http://127.0.0.1:5173', ready: ['http://127.0.0.1:8000/api/health'], ...(seed ? { seed } : {}), pages: [{ path: '/', title: '首页' }] });
  const { setParam } = await import('../src/core/params.mjs');
  const run = async (name, calls, preview, kind, setup) => {
    const ws = join(TMP, name); mkdirSync(join(ws, 'frontend'), { recursive: true });
    writeFileSync(join(ws, 'frontend', 'package.json'), JSON.stringify({ name: 'f', devDependencies: { vite: '^5' } }));
    if (preview !== undefined) writeFileSync(join(ws, 'si-preview.json'), preview);
    git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@t'); git(ws, 'config', 'user.name', 't'); git(ws, 'add', '.'); git(ws, 'commit', '-q', '-m', 'init');
    const tid = newId('t');
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,?,'running',?)`, tid, lead, name, t0);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), tid, t0, t0);
    db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,risk_tier,model_tier,created_at) VALUES (?,?,'页面','写页面','文件存在','pending',1,'normal','standard',?)`, newId('n'), tid, t0);
    if (kind) setParam(db, { taskId: tid, key: 'task.kind', value: kind, by: { kind: 'agent', id: 'test' }, governance: 'execution' });
    if (setup) setup(tid, ws);
    const client = new LlmClient({ mode: 'fake', fake: makeFake(calls) });
    const r = await orchestrate(db, { taskId: tid, workspace: ws, narrativeDir: join(TMP, `narr-${name}`), verify: false, exec: new FakeSandbox(), makeClient: () => client, onEvent: () => {} });
    return { r, tid };
  };
  const a = await run('noseed', [
    call('write_file', { path: 'frontend/index.html', content: '<h1>待办</h1>\n' }), call('submit_handoff', H('frontend/index.html')),
    call('write_file', { path: 'si-preview.json', content: spec(['python backend/seed.py']) }), call('write_file', { path: 'backend/seed.py', content: 'print(1)\n' }), call('submit_handoff', H('si-preview.json')),
  ], spec(null));
  eq(a.r.kind, 'complete', '任务照常做完');
  assert(!!db.one(`SELECT 1 FROM audit_log WHERE action='preview_seed_node_added' AND target_id=?`, a.tid), '接了后端、没写 seed → 系统补了一步"给截图放样例数据"');
  eq(db.all(`SELECT status FROM nodes WHERE task_id=?`, a.tid).map((n) => n.status).join(','), 'done,done', '两步都做完（原来那步 + 补的那步）');
  assert(!!db.one(`SELECT value FROM params WHERE task_id=? AND key=?`, a.tid, PREVIEW_SEED_NODE_KEY), '记下补过了（每个任务只补一次）');
  const b = await run('withseed', [
    call('write_file', { path: 'frontend/index.html', content: '<h1>待办</h1>\n' }), call('submit_handoff', H('frontend/index.html')),
  ], spec(['python backend/seed.py']));
  eq(b.r.kind, 'complete', '写了 seed 的照常做完');
  assert(!db.one(`SELECT 1 FROM audit_log WHERE action='preview_seed_node_added' AND target_id=?`, b.tid), '写了 seed → 不补');
  // 并行开发的骨架任务只有桩，列表接口没数据：不补 seed 那步（桩接口给不出数据，那步验收不可能过）
  const c = await run('skeleton', [
    call('write_file', { path: 'frontend/index.html', content: '<h1>stub</h1>\n' }), call('submit_handoff', H('frontend/index.html')),
  ], spec(null), 'skeleton');
  eq(c.r.kind, 'complete', '骨架任务照常做完');
  assert(!db.one(`SELECT 1 FROM audit_log WHERE action IN ('preview_seed_node_added','preview_node_added') AND target_id=?`, c.tid), '骨架任务 → 不补截图那两步');
  // 骨架还没写截图说明：照补"写截图说明"这一步（这一步骨架做得到；它写的那份让所有模块免补），只不补样例数据。
  // 两步都挡掉的话，骨架不写这份文件，每个模块各补一遍。
  const d = await run('skeleton-nofile', [
    call('write_file', { path: 'frontend/index.html', content: '<h1>stub</h1>\n' }), call('submit_handoff', H('frontend/index.html')),
    call('write_file', { path: 'si-preview.json', content: spec(null) }), call('submit_handoff', H('si-preview.json')),
  ], undefined, 'skeleton');
  eq(d.r.kind, 'complete', '骨架任务做完');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='preview_node_added' AND target_id=?`, d.tid), '骨架没写截图说明 → 补"写截图说明"一步');
  assert(!db.one(`SELECT 1 FROM audit_log WHERE action='preview_seed_node_added' AND target_id=?`, d.tid), '骨架接了后端也不补样例数据');

  section('⑥ 同一条机械拒收连续出现：第二次说清只剩两条路，第三次系统替执行器提问（不再重交到 20 轮）');
  const e = await run('repeat-reject', [
    call('submit_handoff', H('nope.txt')), call('submit_handoff', H('nope.txt')), call('submit_handoff', H('nope.txt')),
    call('submit_handoff', H('nope.txt')),   // 不该被用到：第三次就停了
  ], spec(['python backend/seed.py']));
  eq(e.r.kind, 'suspended', '第三次同样的拒收 → 节点挂起等人');
  const rej = db.all(`SELECT a.payload FROM audit_log a JOIN nodes n ON n.id=a.target_id WHERE a.action='handoff_rejected' AND n.task_id=?`, e.tid);
  eq(rej.length, 3, '只拒了三次，没有重交到上限');
  const q = db.one(`SELECT level, text, default_action FROM questions WHERE task_id=?`, e.tid);
  assert(q && /连续 3 次交了同样的改动/.test(q.text) && q.level === 2 && q.default_action, '问题是系统代填的：说清重交不会改判、给出默认动作');
  const narr = db.one(`SELECT 1 FROM audit_log a JOIN nodes n ON n.id=a.target_id WHERE a.action='question_raised' AND n.task_id=?`, e.tid);
  assert(narr, '照常记 question_raised（复工简报照留）');

  section('⑦ 并行骨架做完、契约与规格对不上 → 补一步让骨架补上（只补一次），不提事项给人');
  const { setParallel } = await import('../src/core/project-settings.mjs');
  const { recordSharedPaths } = await import('../src/core/parallel.mjs');
  const { CONTRACT_NODE_KEY } = await import('../src/core/orchestrator.mjs');
  const brief = '- `GET /api/items` → 200 `{"items": [...], "total": <n>}`.\n- `GET /api/items/{id}` → 200 or 404.\n';
  const yaml = (withOne) => `openapi: 3.0.3\npaths:\n  /api/items:\n    get:\n      responses:\n        '200':\n          content:\n            application/json:\n              schema:\n                properties:\n                  items: { type: array }\n                  total: { type: integer }\n${withOne ? '  /api/items/{id}:\n    get:\n      responses: { \'200\': { description: ok } }\n' : ''}`;
  const parallelSkeleton = (tid, ws) => {
    const pid = newId('p');
    db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,status,created_at) VALUES (?,?,'p',?,?,'main','HEAD','active',?)`, pid, lead, brief, ws, t0);
    db.run(`UPDATE tasks SET project_id=?, project_order=1 WHERE id=?`, pid, tid);
    setParallel(db, { projectId: pid, on: true, userId: lead });
    recordSharedPaths(db, { projectId: pid, paths: ['contracts/'], userId: lead });
    mkdirSync(join(ws, 'contracts'), { recursive: true }); writeFileSync(join(ws, 'contracts', 'openapi.yaml'), yaml(false));
  };
  const f = await run('contract-gap', [
    call('write_file', { path: 'frontend/index.html', content: '<h1>stub</h1>\n' }), call('submit_handoff', H('frontend/index.html')),
    call('write_file', { path: 'contracts/openapi.yaml', content: yaml(true) }), call('submit_handoff', H('contracts/openapi.yaml')),
  ], spec(null), 'skeleton', parallelSkeleton);
  eq(f.r.kind, 'complete', '骨架任务做完');
  const added = db.one(`SELECT payload FROM audit_log WHERE action='contract_node_added' AND target_id=?`, f.tid);
  assert(added && JSON.parse(added.payload).gaps.join() === '缺接口 `GET /api/items/{id}`', '契约少了单个 item 的 GET → 系统补一步，规格里写着缺哪一处');
  assert(!db.one(`SELECT 1 FROM audit_log WHERE action='contract_gaps_remain' AND target_id=?`, f.tid), '补上之后不再有缺口');
  eq(db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND decision_type!='signoff'`, f.tid).n, 0, '不提事项给人（签收照常）');
  const g = await run('contract-gap-stays', [
    call('write_file', { path: 'frontend/index.html', content: '<h1>stub</h1>\n' }), call('submit_handoff', H('frontend/index.html')),
    call('write_file', { path: 'contracts/notes.md', content: 'todo\n' }), call('submit_handoff', H('contracts/notes.md')),
  ], spec(null), 'skeleton', parallelSkeleton);
  eq(g.r.kind, 'complete', '补了一次还对不上：照常做完、请签收');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='contract_node_added' AND target_id=?`, g.tid).n, 1, '只补一次');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='contract_gaps_remain' AND target_id=?`, g.tid) && db.one(`SELECT 1 FROM params WHERE task_id=? AND key=?`, g.tid, CONTRACT_NODE_KEY), '照实记下还缺什么');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
