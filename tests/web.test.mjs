// Web 看板
//
// 跑：node tests/web.test.mjs
//
// 断言的是边界：只绑本机；视图只读真相源；控制杆只经已有入口（答复挂 answers 边、改向进 inbox、
// 暂停/恢复/中止改任务状态并记审计、优先级只改没开跑的节点、上限走 setLimit）；SSE 在审计轨变化时推。

import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit, insertEdge } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { startWeb, taskDetail } from '../src/web/server.mjs';
import { createTaskFromSpec } from '../src/core/project.mjs';
import { addUser } from '../src/core/users.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-web-'));
const HOME = join(TMP, 'home');
const db = openDb(':memory:');
const owner = ensureOwner(db);
const t0 = now();
const taskId = newId('t'), n1 = newId('n'), n2 = newId('n');
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'看板测试任务','running',?)`, taskId, owner.userId, t0);
db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','["c1"]',?,?)`, newId('c'), taskId, t0, t0);
db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'第一步','s','a','pending',5,?)`, n1, taskId, t0);
db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'第二步','s','a','blocked',5,?)`, n2, taskId, t0);
insertEdge(db, n2, n1, 'depends_on', t0);
const qId = newId('q');
db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
        VALUES (?,?,?,1,'classifier','要不要加引号？','不加',?,?,'open')`, qId, taskId, n2, t0, t0 + 30 * 60_000);
db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at)
        VALUES (?,?,?,'csv.quote','不加引号','confirmed','settled_by_me','查过规格，沉默',1,?,?)`, newId('a'), taskId, n1, t0, t0);

// 没给 kind 时，say 控制杆走分类器。测试注入 makeFake，不许打真实服务。
const classifierClient = () => new LlmClient({ mode: 'fake', fake: makeFake([{
  stopReason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify({ kind: 'answer', urgency: 'normal', confidence: 0.95, questionId: qId, why: '在回答要不要加引号' }) }],
  usage: { inputTokens: 10, outputTokens: 5 },
}]) });
const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100, makeClassifierClient: classifierClient });
const base = `http://127.0.0.1:${w.port}`;
const get = (p) => fetch(base + p).then((r) => r.json());
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

section('1. 只绑本机；页面与只读视图');
{
  eq(w.host, '127.0.0.1', '只绑 127.0.0.1');
  const html = await fetch(base + '/').then((r) => r.text());
  assert(html.includes('步骤') && html.includes('待决事项') && html.includes('消息') && html.includes('动态'), '页面含四视图（步骤 / 待决事项 / 动态 / 消息）');
  assert(html.includes('id="viewTask"') && html.includes('id="viewSettings"') && html.includes('data-pane="bind"'), '任务 / 设置两个视图；设置按分区（模型分配 / 服务商 / 模型列表 / 决策路由 / 成员）');
  assert(!/方言|力度|接入点|型号/.test(html), '界面不用自造词（API 格式 / 推理强度 / 服务商 / 模型）');
  assert(!/节点/.test(html.replace(/<script[\s\S]*<\/script>/, '')) , '页面静态文字里没有"节点"（界面统一叫"步骤"）');
  assert(html.includes('超限即终止') && !html.includes('🔒'), '硬边界用文字"超限即终止"，不用锁形图标');
  const { tasks } = await get('/api/tasks');
  eq(tasks[0]?.id, taskId, '任务列表');
  eq(tasks[0].openQuestions, 1, '开着的问题数');
  const d = await get(`/api/tasks/${taskId}`);
  eq(d.nodes.length, 2, '节点'); eq(d.edges.length, 1, '依赖边');
  assert(d.questions[0].remainingMs > 0 && d.questions[0].remainingMs <= 30 * 60_000, '问题带剩余超时');
  assert(d.assumptions[0].verified_against === 'settled_by_me', '自作主张的假设在视图里');
  eq(d.limits['limit.budget_micro_usd']?.label, '任务花费', '上限表');
  eq((await fetch(base + '/api/tasks/nope').then((r) => r.status)), 404, '不存在的任务 404');
}

section('2. SSE：审计轨变了就推');
{
  const ac = new AbortController();
  const res = await fetch(base + '/api/events', { signal: ac.signal });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = '';
  const readUntil = async (needle, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end && !buf.includes(needle)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } return buf.includes(needle); };
  assert(await readUntil('event: hello'), '连上先收 hello');
  audit(db, { actorKind: 'system', action: 'web_test_ping', targetType: 'task', targetId: taskId, payload: {} });
  assert(await readUntil('event: change'), '插一条审计 → 推 change');
  assert(buf.includes('web_test_ping'), 'change 里带新审计行的 action');
  ac.abort();
}

section('3. 控制杆只经已有入口');
{
  let r = await post(`/api/tasks/${taskId}/say`, { body: '改成分号', kind: 'correction', urgent: true });
  eq(r.status, 200, '改向：say 入库');
  const m = db.one(`SELECT * FROM messages WHERE id=?`, r.result.messageId);
  assert(m.kind === 'correction' && m.urgency === 'urgent' && m.trust_label === 'user-authenticated', '消息是认证的紧急修正');
  const beforeSay = db.one(`SELECT count(*) n FROM messages WHERE task_id=?`, taskId).n;
  r = await post(`/api/tasks/${taskId}/say`, { body: '加引号' });
  eq(r.status, 200, '没给 kind 不再 400：分类器判为在回答开着的问题，不入库，返回 questionId');
  eq(r.result.kind, 'answer', 'answer 场景返回 kind=answer');
  eq(r.result.questionId, qId, '返回 questionId');
  eq(r.result.body, '加引号', 'answer 场景返回原文（供看板渲染"转为答复"）');
  eq(db.one(`SELECT count(*) n FROM messages WHERE task_id=?`, taskId).n, beforeSay, 'answer 场景 messages 没有新行');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, qId).status, 'open', '不自动 recordAnswer（问题仍 open）');

  r = await post(`/api/tasks/${taskId}/answer`, { questionId: qId, body: '加引号' });
  eq(r.status, 200, '答复');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, qId).status, 'answered', '问题 answered');
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, n2).status, 'pending', '分支解冻');

  r = await post(`/api/tasks/${taskId}/priority`, { nodeId: n1, priority: 1 });
  eq(db.one(`SELECT priority FROM nodes WHERE id=?`, n1).priority, 1, '优先级改了');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='node_priority_set' AND target_id=?`, n1).n, 1, '优先级改动进审计');
  db.run(`UPDATE nodes SET status='running' WHERE id=?`, n1);   // 开跑中的节点不能改优先级
  r = await post(`/api/tasks/${taskId}/priority`, { nodeId: n1, priority: 2 });
  eq(r.status, 400, '已开跑/完成的节点不能改优先级');
  db.run(`UPDATE nodes SET status='pending' WHERE id=?`, n1);

  r = await post(`/api/tasks/${taskId}/limit`, { key: 'limit.llm_calls', value: 777 });
  eq(r.status, 200, '改上限');
  eq((await get(`/api/tasks/${taskId}`)).limits['limit.llm_calls'].value, 777, '上限生效（走 setLimit）');
  r = await post(`/api/tasks/${taskId}/limit`, { key: 'limit.nope', value: 1 });
  eq(r.status, 400, '不认识的维度 400');

  r = await post(`/api/tasks/${taskId}/pause`);
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'suspended', '暂停 → suspended');
  r = await post(`/api/tasks/${taskId}/pause`);
  eq(r.status, 400, '已暂停的不能再暂停');
  r = await post(`/api/tasks/${taskId}/resume`);
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'running', '恢复 → running（没有开着的问题）');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action IN ('task_paused','task_resumed') AND target_id=?`, taskId).n, 2, '暂停/恢复各一条审计');
  r = await post(`/api/tasks/${taskId}/revision`, { approve: true });
  eq(r.status, 400, '没有待批提案 → 400');
  r = await post(`/api/tasks/${taskId}/signoff`, { accept: true });
  eq(r.status, 400, '非 done 不能签收');
  r = await post(`/api/tasks/${taskId}/abort`, { why: '测试中止' });
  eq(db.one(`SELECT status FROM tasks WHERE id=?`, taskId).status, 'aborted', '中止 → aborted');
  eq(JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='task_abborted' OR action='task_aborted' ORDER BY id DESC LIMIT 1`).payload).why, '测试中止', '中止理由进审计');
  r = await post(`/api/tasks/${taskId}/running`);
  eq(r.status, 404, '内部查询函数不暴露为控制杆');
}

section('3b. 项目层：列表、从规划新建、推进 / 交付只经已有入口');
{
  const { execFileSync } = await import('node:child_process');
  const SRC = join(TMP, 'src'); mkdirSync(SRC, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: SRC, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main'); writeFileSync(join(SRC, 'README.md'), '# x\n'); g('add', '.'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  let r = await post('/api/projects', { goal: '做三件事', doneDefinition: '三件都合并', plan: '做三件事\n1 2 3', source: SRC, title: '看板项目' });
  eq(r.status, 200, '从规划新建项目');
  const pid = r.result.projectId;
  const { projects } = await get('/api/projects');
  const p = projects.find((x) => x.id === pid);
  assert(p && p.status === 'proposed' && p.carrier === r.result.carrierId && p.tasks.length === 0, '列表里是 proposed，带载体任务，契约 0 个');
  const tl = await get('/api/tasks');
  assert(Array.isArray(tl.projects) && tl.tasks.some((t) => t.id === r.result.carrierId), '/api/tasks 也带项目列表，载体任务在任务列表里');
  r = await post(`/api/projects/${pid}/advance`, {});
  eq(r.status, 200, '推进走 advanceProject'); eq(r.result.reason, 'status:proposed', 'proposed 的项目推不动');
  r = await post(`/api/projects/${pid}/deliver`, { remote: null });
  eq(r.status, 400, '没 done 不能交付（deliverProject 的规矩原样透出）');
  r = await post('/api/projects', { goal: 'g', doneDefinition: 'd', plan: '', source: SRC });
  eq(r.status, 400, '勾了规划却是空的 400');
  r = await post('/api/projects', { goal: '', doneDefinition: 'd', source: SRC });
  assert(r.status === 400 && /项目目标不能为空/.test(r.error), '没写目标 400');
  r = await post(`/api/projects/${pid}/nope`, {});
  eq(r.status, 404, '不认识的项目动作 404');
  const html = await fetch(base + '/').then((x) => x.text());
  assert(html.includes('id="btnCreate"') && html.includes('id="newIsPlan"') && html.includes('id="viewProject"') && html.includes('id="projRouting"'), '页面含单入口的新建（规划勾选 = 建项目）与项目页（项目页里有本项目的决策路由）');
  assert(['id="side"', 'id="sideNav"', 'id="viewInbox"', 'data-go="settings"'].every((x) => html.includes(x)) && !html.includes('id="taskSel"'), '侧栏导航（收件箱 / 项目 → 任务 / 独立任务 / 已结束）取代了顶栏的任务下拉框');
}

section('3c. 角色与路由：按请求识别身份；旁观者只读；路由表只有负责人能改；转交');
{
  const postAs = (tok, p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-superintern-token': tok }, body: JSON.stringify(b ?? {}) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const getAs = (tok, p) => fetch(base + p, { headers: { 'x-superintern-token': tok } }).then((r) => r.json());
  let r = await post('/api/users', { name: 'alice', role: 'member', tags: ['reviewer'] });
  eq(r.status, 200, '负责人加人');
  const alice = r.result;
  assert(alice.plaintext && alice.userId, '返回一次令牌明文');
  const carol = (await post('/api/users', { name: 'carol', role: 'observer' })).result;
  r = await postAs(alice.plaintext, '/api/users', { name: 'dave', role: 'member' });
  eq(r.status, 403, '介入者不能加人');
  const me = await getAs(alice.plaintext, '/api/me');
  eq(JSON.stringify([me.role, me.viaOwnToken]), JSON.stringify(['member', true]), '/api/me 按请求头识别身份');
  eq((await get('/api/me')).role, 'lead', '不带头 = 起看板那个人');
  eq((await fetch(base + '/api/me', { headers: { 'x-superintern-token': 'nope' } })).status, 400, '坏令牌 400');

  const t2 = newId('t'), n3 = newId('n');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'角色测试','waiting',?)`, t2, owner.userId, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), t2, t0, t0);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'步','s','a','blocked',5,?)`, n3, t2, t0);
  r = await postAs(alice.plaintext, `/api/tasks/${t2}/pause`);
  eq(r.status, 400, '介入者不能暂停');
  assert(/负责人能执行此操作/.test(r.error), '拒绝理由');
  r = await postAs(alice.plaintext, `/api/tasks/${t2}/limit`, { key: 'limit.llm_calls', value: 5 });
  eq(r.status, 400, '介入者不在预算行：改不了上限');
  r = await postAs(alice.plaintext, '/api/routing', { action: 'template', name: 'solo' });
  eq(r.status, 403, '介入者不能改路由表');
  r = await post('/api/routing', { action: 'owner', type: 'spec_choice', recipients: ['group:reviewer'] });
  eq(r.status, 200, '负责人改归属旋钮');
  eq(JSON.stringify(r.result.interveners), JSON.stringify([alice.userId]), '介入者名单是投影');
  const rt = await get('/api/routing');
  assert(rt.rows.length >= 9 && rt.templates.solo && rt.types.spec_choice && rt.knobs.ownership.spec_choice[0] === 'group:reviewer', '/api/routing 给全表、模板、类型、旋钮');
  assert(rt.preview && typeof rt.preview.questions === 'number', '带历史预演');
  r = await post('/api/routing', { action: 'validate', rows: rt.rows.map((x) => ({ ...x, recipients: x.decision_type === 'structural' ? ['group:reviewer'] : x.recipients })) });
  assert(r.result.errors.some((e) => /必须包含负责人/.test(e.msg)), '校验端点逐行报错');

  // 规格取舍现在路由到 reviewer 组：alice 能答，carol 不能，转交后 dave 能
  const q2 = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,?,2,'classifier','分号还是逗号？','逗号',?,NULL,'open')`, q2, t2, n3, t0);
  const { routeQuestion } = await import('../src/core/routing.mjs');
  db.tx(() => routeQuestion(db, { questionId: q2, decisionType: 'spec_choice', typeSource: 'self' }));
  const d2 = await get(`/api/tasks/${t2}`);
  const qq = d2.questions.find((x) => x.id === q2);
  eq(JSON.stringify([qq.addressed_to, qq.decisionLabel, qq.answers.length]), JSON.stringify([[alice.userId], '规格取舍', 0]), '事项带收件人、类型名、答复列表');
  eq(d2.lead, owner.userId, '详情带负责人');
  eq(JSON.stringify(d2.can), JSON.stringify({ budget: true, egress: true, signoff: true, delivery: true }), '负责人：can 四类全真');
  eq((await getAs(alice.plaintext, `/api/tasks/${t2}`)).can.budget, false, 'alice 不在预算行：can.budget 假（看板据此禁用上限输入）');
  await post('/api/routing', { action: 'owner', type: 'budget', recipients: ['group:reviewer'] });
  eq((await getAs(alice.plaintext, `/api/tasks/${t2}`)).can.budget, true, '预算归属改到 reviewer 组后：alice 的 can.budget 真');
  r = await postAs(alice.plaintext, `/api/tasks/${t2}/limit`, { key: 'limit.llm_calls', value: 7 });
  eq(r.status, 200, '此时 alice 改上限成功（写入口同样查表）');
  await post('/api/routing', { action: 'owner', type: 'budget', recipients: ['user:lead'] });
  r = await postAs(carol.plaintext, `/api/tasks/${t2}/answer`, { questionId: q2, body: '分号' });
  eq(r.status, 400, '旁观者不能答');
  r = await postAs(carol.plaintext, `/api/tasks/${t2}/say`, { body: '我觉得逗号', kind: 'instruction' });
  eq(r.status, 400, '旁观者不能发指令');
  r = await postAs(carol.plaintext, `/api/tasks/${t2}/say`, { body: '我觉得逗号', kind: 'context', about: q2 });
  eq(r.status, 200, '旁观者能留言');
  eq(r.result.trust, 'observed-untrusted', '留言 observed-untrusted');
  const dave = (await post('/api/users', { name: 'dave', role: 'member' })).result;
  r = await postAs(dave.plaintext, `/api/questions/${q2}/transfer`, { to: [`user:${dave.userId}`] });
  eq(r.status, 400, '不是收件人不能转交给自己');
  r = await postAs(alice.plaintext, `/api/questions/${q2}/transfer`, { to: [`user:${dave.userId}`] });
  eq(r.status, 200, '收件人转交');
  eq(JSON.stringify(r.result.to), JSON.stringify([dave.userId]), '转给 dave');
  // 我的待办：按请求身份现算，跨任务
  const dg = await getAs(dave.plaintext, '/api/digest');
  eq(JSON.stringify([dg.name, dg.waitingOnMe.map((x) => x.questionId), dg.actionable]), JSON.stringify(['dave', [q2], 1]), '/api/digest：dave 的等我答 = 转交来的 q2');
  assert(typeof dg.text === 'string' && dg.text.includes(`answer ${q2}`), '带纯文本版，含命令');
  eq((await getAs(carol.plaintext, '/api/digest')).total, 0, '旁观者的待办为空');
  assert(/收件箱/.test(await (await fetch(base + '/')).text()), '页面有"收件箱"（跨任务的待办）');
  r = await postAs(dave.plaintext, `/api/tasks/${t2}/answer`, { questionId: q2, body: '分号' });
  eq(r.status, 200, 'dave 答');
  eq(db.one(`SELECT status FROM questions WHERE id=?`, q2).status, 'answered', '生效');
  const d3 = await get(`/api/tasks/${t2}`);
  eq(JSON.stringify(d3.questions.find((x) => x.id === q2).answers.map((a) => [a.name, a.stance])), JSON.stringify([['carol', 'comment'], ['dave', 'answer']]), '答复列表含留言与生效答复');
  assert(d3.measured && 'limit.llm_calls' in d3.measured, '详情带各维实测值');
}

section('3d. 成员管理与交接：只给种类 + 主机名；本人可管自己的通道；交接预览不落库、成员只能申请');
{
  const postAs = (tok, p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-superintern-token': tok }, body: JSON.stringify(b ?? {}) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const erin = (await post('/api/users', { action: 'add', name: 'erin', role: 'member' })).result;
  const frank = (await post('/api/users', { action: 'add', name: 'frank', role: 'member' })).result;
  let r = await post('/api/users', { action: 'channel_set', userId: erin.userId, kind: 'feishu', target: 'https://open.feishu.cn/hook/TOPSECRET' });
  const row = r.users.find((u) => u.id === erin.userId);
  eq(JSON.stringify(row.channels), JSON.stringify([{ kind: 'feishu', host: 'open.feishu.cn' }]), '成员视图：通道 = 种类 + 主机名');
  assert(!JSON.stringify(await get('/api/users')).includes('TOPSECRET'), 'GET /api/users 不含通道地址');
  eq((await postAs(erin.plaintext, '/api/users', { action: 'channel_remove', userId: erin.userId, kind: 'feishu' })).status, 200, '成员能删自己的通道');
  eq((await postAs(erin.plaintext, '/api/users', { action: 'channel_set', userId: frank.userId, kind: 'ntfy', target: 'https://x.example/t' })).status, 403, '成员不能动别人的通道');
  eq((await postAs(erin.plaintext, '/api/users', { action: 'rename', userId: erin.userId, name: 'erin2' })).status, 403, '成员不能改名');
  eq((await post('/api/users', { action: 'rename', userId: erin.userId, name: 'erin2' })).users.find((u) => u.id === erin.userId).name, 'erin2', '负责人改名');
  eq((await post('/api/users', { action: 'role', userId: frank.userId, role: 'lead' })).users.find((u) => u.id === frank.userId).role, 'lead', '管理员角色可直接授予');
  eq((await post('/api/users', { action: 'role', userId: frank.userId, role: 'member' })).users.find((u) => u.id === frank.userId).role, 'member', '也可直接收回');
  // 创建权：默认成员可建，创建者即负责人；开关打开后仅管理员
  const meOf = (tok) => fetch(base + '/api/me', { headers: { 'x-superintern-token': tok } }).then((x) => x.json());
  eq((await meOf(erin.plaintext)).canCreate, true, '/api/me：成员默认可新建');
  r = await postAs(erin.plaintext, '/api/projects', { goal: '给 README 加一节安装说明', doneDefinition: 'README 里有"安装"一节', source: join(TMP, 'src') });
  eq(JSON.stringify([r.status, db.one(`SELECT owner_id FROM projects WHERE id=?`, r.result?.projectId)?.owner_id, db.one(`SELECT owner_id, project_order FROM tasks WHERE id=?`, r.result?.firstTaskId)?.project_order]),
    JSON.stringify([200, erin.userId, 1]), '成员新建项目：负责人是他自己，第一个任务出生就在项目里');
  eq((await post('/api/tasks', { idea: '独立任务' })).status, 410, '独立任务的新建入口已取消（410，说明去哪）');
  eq((await postAs(erin.plaintext, '/api/users', { action: 'setting', key: 'deploy.create_admin_only', value: true })).status, 403, '成员不能改部署级设置');
  r = await post('/api/users', { action: 'setting', key: 'deploy.create_admin_only', value: true });
  eq(JSON.stringify([r.status, r.settings['deploy.create_admin_only']]), JSON.stringify([200, true]), '管理员打开"仅管理员可创建"');
  r = await postAs(erin.plaintext, '/api/projects', { goal: '再来一个', doneDefinition: 'd', source: join(TMP, 'src') });
  assert(r.status === 403 && /仅管理员可新建/.test(r.error), '打开后成员新建被拒，说明原因');
  eq((await meOf(erin.plaintext)).canCreate, false, '/api/me 同步');
  eq((await post('/api/users', { action: 'setting', key: 'no.such', value: true })).status, 400, '不认识的设置键拒收');
  await post('/api/users', { action: 'setting', key: 'deploy.create_admin_only', value: false });
  r = await post('/api/users', { action: 'token', userId: owner.userId });
  assert(r.status === 400 && /本机身份/.test(r.error), '本机身份的令牌不能在看板里重发（会让看板自己失去身份）');
  r = await post('/api/users', { action: 'token', userId: erin.userId });
  assert(r.status === 200 && r.result.plaintext && r.result.plaintext !== erin.plaintext, '重发令牌：明文只在这次响应里');
  eq((await fetch(base + '/api/me', { headers: { 'x-superintern-token': erin.plaintext } })).status, 400, '旧令牌立刻失效');
  const erinTok = r.result.plaintext;

  // 交接：给 erin 一条路由点名，再由她申请交给 frank
  const rules = (await get('/api/routing')).rows.map(({ id, project_id, template, created_at, ...x }) => x);
  const sc = rules.find((x) => x.decision_type === 'spec_choice' && x.scope === '*' && x.position === 0);
  const keep = sc.recipients; sc.recipients = [...keep, `user:${erin.userId}`];
  eq((await post('/api/routing', { action: 'rows', rows: rules })).status, 200, '（夹具）路由表点名 erin');
  const before = db.one(`SELECT count(*) n FROM audit_log`).n;
  r = await postAs(erinTok, '/api/handover', { action: 'preview', to: frank.userId, scope: { all: true } });
  assert(r.status === 200 && r.result.changes.routing.length === 1 && r.result.changes.needsApproval && /决策路由 1 行/.test(r.result.text), '成员预览自己的交接：清单 + 文本 + 标明要批准');
  eq(db.one(`SELECT count(*) n FROM audit_log`).n, before, '预览不写审计');
  eq((await postAs(erinTok, '/api/handover', { action: 'preview', from: frank.userId, to: erin.userId, scope: { all: true } })).status, 400, '成员不能预览别人的');
  r = await postAs(erinTok, '/api/handover', { action: 'run', to: frank.userId, scope: { all: true }, note: '转组' });
  assert(r.status === 200 && r.result.requested && r.requests.length === 1, '成员 run = 提交申请');
  assert((await get('/api/routing')).rows.some((x) => x.recipients.includes(`user:${erin.userId}`)), '申请不改路由表');
  eq((await get('/api/digest')).handoverRequests.length, 1, '负责人的收件箱数据里有这条申请');
  eq((await postAs(erinTok, '/api/handover', { action: 'approve', requestId: r.result.requestId })).status, 400, '申请人不能自己批');
  const ap = await post('/api/handover', { action: 'approve', requestId: r.result.requestId });
  assert(ap.status === 200 && ap.result.status === 'approved' && ap.result.notified === false, '负责人批准 = 执行；接手人没通道 → notified=false');
  const rows2 = (await get('/api/routing')).rows;
  assert(rows2.some((x) => x.recipients.includes(`user:${frank.userId}`)) && !rows2.some((x) => x.recipients.includes(`user:${erin.userId}`)), '路由表里 erin → frank');
  r = await post('/api/users', { action: 'disable', userId: frank.userId });
  assert(r.status === 400 && r.needsHandover, '名下有事的人不能直接停用，响应标 needsHandover');
  r = await post('/api/users', { action: 'disable', userId: erin.userId });
  assert(r.status === 200 && r.users.find((u) => u.id === erin.userId).disabledAt, '名下没事 → 停用');
  eq((await fetch(base + '/api/me', { headers: { 'x-superintern-token': erinTok } })).status, 400, '停用后令牌失效');
  // 收尾：路由表还原，免得影响后面的段
  const back = (await get('/api/routing')).rows.map(({ id, project_id, template, created_at, ...x }) => x);
  back.find((x) => x.decision_type === 'spec_choice' && x.scope === '*' && x.position === 0).recipients = keep;
  eq((await post('/api/routing', { action: 'rows', rows: back })).status, 200, '（收尾）路由表还原');
  const html = await (await fetch(base + '/')).text();
  assert(['id="users"', 'renderHandoverPanel', 'btnProjHandover', 'task-lead-only'].every((x) => html.includes(x)), '页面含成员面板、交接流程、项目页的移交入口、按任务负责人显隐的控制杆');
  assert(html.includes('function recPicker') && !html.includes('RESOLVER_HELP') && !/<input class="c-rec"/.test(html), '决策路由的接收人用选人控件，不再手写 user:<id>');
}

section('3e. 生命周期：中止可反悔、改标题、归档；"与我有关"标记；权限按任务负责人');
{
  const postAs = (tok, p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-superintern-token': tok }, body: JSON.stringify(b ?? {}) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const getAs = (tok, p) => fetch(base + p, { headers: { 'x-superintern-token': tok } }).then((r) => r.json());
  const gina = addUser(db, { name: 'gina', role: 'member', byUserId: owner.userId });
  const { taskId } = createTaskFromSpec(db, { title: '生命周期', goal: 'g', definition_of_done: 'd' }, { userId: owner.userId });
  db.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);
  eq((await postAs(gina.plaintext, `/api/tasks/${taskId}/rename`, { title: 'x' })).status, 400, '不是负责人不能改标题');
  eq((await post(`/api/tasks/${taskId}/rename`, { title: '生命周期 · 新' })).result.title, '生命周期 · 新', '负责人改标题');
  eq((await post(`/api/tasks/${taskId}/archive`, {})).status, 400, '进行中的任务不能归档');
  eq((await post(`/api/tasks/${taskId}/reopen`, {})).status, 400, '没中止的任务不能恢复');
  eq((await post(`/api/tasks/${taskId}/abort`, { why: '先停一下' })).status, 200, '中止');
  eq((await postAs(gina.plaintext, `/api/tasks/${taskId}/reopen`, {})).status, 400, '不是负责人不能恢复');
  let r = await post(`/api/tasks/${taskId}/archive`, {});
  eq(r.result.archived, true, '已中止 → 可归档');
  assert((await get('/api/tasks')).tasks.find((t) => t.id === taskId).archived_at > 0, '列表带 archived_at（界面据此移入"已归档"）');
  eq((await post(`/api/tasks/${taskId}/reopen`, {})).status, 400, '已归档的先取消归档');
  await post(`/api/tasks/${taskId}/archive`, { archived: false });
  r = await post(`/api/tasks/${taskId}/reopen`, {});
  eq(JSON.stringify([r.status, r.result.to]), JSON.stringify([200, 'running']), '恢复：回到中止前的 running');
  const mineOf = async (tok) => (await getAs(tok, '/api/tasks')).tasks.find((t) => t.id === taskId).mine;
  eq(JSON.stringify([await mineOf(owner.plaintext), await mineOf(gina.plaintext)]), JSON.stringify([true, false]), '"与我有关"：负责人 true，无关成员 false');
  eq((await postAs(gina.plaintext, '/api/projects/pj_nope/abort', {})).status, 404, '项目动作：不存在的项目 404');
  const page = await (await fetch(base + '/')).text();
  assert(/只看与我有关/.test(page) && /data-stall-reopen/.test(page) && /中止项目/.test(page) && /已归档/.test(page), '页面有：只看与我有关 / 恢复当前任务 / 中止项目 / 已归档');
}

section('3f. 统一入口：最近用过的仓库、提交前校验、任务详情带"下一步"、自动运行关进管理员待办');
{
  const notRepo = mkdtempSync(join(tmpdir(), 'si-notrepo-'));
  const G = { goal: '随便做点什么', doneDefinition: '做完' };
  let r = await post('/api/projects', { ...G, source: join(notRepo, 'nope') });
  assert(r.status === 400 && /仓库路径不存在/.test(r.error), '路径不存在 → 当场拒');
  r = await post('/api/projects', { ...G, source: notRepo });
  assert(r.status === 400 && /不是 git 仓库/.test(r.error), '不是 git 仓库 → 当场拒');
  const before = db.one(`SELECT count(*) n FROM tasks`).n;
  r = await post('/api/projects', { ...G, plan: '一份规划', source: '' });
  assert(r.status === 400 && /目标仓库不能为空/.test(r.error) && db.one(`SELECT count(*) n FROM tasks`).n === before, '项目没给仓库 → 拒，什么都没建');
  r = await post('/api/projects', { ...G, source: 'file:///' + join(notRepo, 'nope.git').split('\\').join('/') });
  assert(r.status === 400 && db.one(`SELECT count(*) n FROM tasks`).n === before, 'URL 形状放行，但仓库当场克隆：克隆不了当场报错，什么都没建');
  r = await post('/api/projects', { ...G, empty: true });
  eq(r.status, 200, '从零开始：不要仓库');
  const SRC3 = join(TMP, 'src');
  r = await post('/api/projects', { goal: '给 README 加徽章', doneDefinition: 'README 顶部有徽章', source: SRC3 });
  eq(r.status, 200, '本机仓库：建项目 + 第一个任务');
  const tid = r.result.firstTaskId;
  const repos = (await get('/api/repos')).repos;
  assert(repos.some((x) => x.kind === 'path' && x.ok && x.source.endsWith('/src')), '/api/repos：刚用过的仓库在列表里');
  const d = await get(`/api/tasks/${tid}`);
  eq(JSON.stringify([d.schedule.due, d.schedule.verb, d.schedule.reason]), JSON.stringify([true, 'draft', 'draft:first']), '任务详情带 schedule：该澄清了（与守护进程同一个判断）');
  const dg = await get('/api/digest');
  assert(dg.daemonOff && dg.daemonOff.unfinished > 0 && /自动运行未开启/.test(dg.text), '看板没带 --daemon、没有心跳、有未结束任务 → 管理员待办里有"自动运行未开启"');
  const page = await (await fetch(base + '/')).text();
  assert(/这是一份已写好的规划/.test(page) && /id="newRepo"/.test(page) && !/id="ideaText"/.test(page), '页面：单入口 + 规划勾选 + 仓库下拉，旧的两个表单没了');
  assert(/id="newGoal"/.test(page) && /id="newDone"/.test(page) && /完成定义/.test(page), '页面：新建项目要填目标与完成定义');
}

section('3g. 添加任务：看板接口只记下要加什么，不建任务；权限 = 负责人或被授予的成员；项目成员 / 可见性 / 目标');
{
  const postAs = (tok, p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-superintern-token': tok }, body: JSON.stringify(b ?? {}) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const pid = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,created_at) VALUES (?,?,?,'原规划','C:/r','superintern/x','main',NULL,'active',?)`, pid, owner.userId, '追加用', now());
  const { taskId: pt } = createTaskFromSpec(db, { title: 'T1', goal: 'g', definition_of_done: 'd', verify_command: 'node --test a.test.mjs' }, { userId: owner.userId, projectId: pid, order: 1 });
  const hank = addUser(db, { name: 'hank', role: 'member', byUserId: owner.userId });
  eq((await postAs(hank.plaintext, `/api/projects/${pid}/append`, { brief: 'x' })).status, 403, '没被授权的成员不能添加任务');
  eq((await post(`/api/projects/${pid}/append`, { brief: '  ' })).status, 400, '空说明拒');
  const nBefore = db.one(`SELECT count(*) n FROM tasks WHERE project_id=? AND project_order>0`, pid).n;
  let r = await post(`/api/projects/${pid}/append`, { brief: '再加一个导出命令' });
  eq(r.status, 200, '负责人提交追加说明');
  eq(db.one(`SELECT count(*) n FROM tasks WHERE project_id=? AND project_order>0`, pid).n, nBefore, '只记下说明，不建任务');
  const pj = (await get('/api/tasks')).projects.find((x) => x.id === pid);
  eq(JSON.stringify([pj.append?.stage, pj.delivered]), JSON.stringify(['drafting', false]), '项目列表带追加状态');
  { const q = await post(`/api/projects/${pid}/append`, { brief: '又一个' });   // 同时仍只有一轮，第二条排队
    const pj2 = (await get('/api/tasks')).projects.find((x) => x.id === pid);
    assert(q.status === 200 && q.result.queued && pj2.appendQueue.length === 1 && pj2.appendQueue[0].brief === '又一个', '同时只有一轮：第二条排队，项目列表带排队的需求'); }
  void pt;
  // 项目权限
  eq((await postAs(hank.plaintext, `/api/projects/${pid}/member`, { userId: hank.userId, canAddTasks: true })).status, 403, '成员不能给自己授权');
  r = await post(`/api/projects/${pid}/member`, { userId: hank.userId, canAddTasks: true, note: '产品：提需求' });
  eq(r.status, 200, '负责人加成员并授予"可添加任务"');
  let lp = (await fetch(base + '/api/tasks', { headers: { 'x-superintern-token': hank.plaintext } }).then((x) => x.json())).projects.find((x) => x.id === pid);
  eq(JSON.stringify([lp.canAdd, lp.mine, lp.members.map((m) => m.note)]), JSON.stringify([true, true, ['产品：提需求']]), '成员视角：canAdd、与我有关、成员名单带职能说明');
  const ivy = addUser(db, { name: 'ivy', role: 'member', byUserId: owner.userId });
  const asIvy = () => fetch(base + '/api/tasks', { headers: { 'x-superintern-token': ivy.plaintext } }).then((x) => x.json());
  assert((await asIvy()).projects.some((x) => x.id === pid), "默认 'all'：无关的成员也看得见");
  eq((await post(`/api/projects/${pid}/visibility`, { visibility: 'members' })).status, 200, '负责人改为仅项目成员可见');
  const iv = await asIvy();
  assert(!iv.projects.some((x) => x.id === pid) && !iv.tasks.some((t) => t.project_id === pid), '无关的成员：项目与它的任务都从列表里消失');
  eq((await fetch(base + `/api/tasks/${pt}`, { headers: { 'x-superintern-token': ivy.plaintext } })).status, 404, '直接打开任务详情也是 404');
  eq((await fetch(base + `/api/tasks/${pt}`, { headers: { 'x-superintern-token': hank.plaintext } })).status, 200, '项目成员打得开');
  r = await post(`/api/projects/${pid}/goal`, { goal: '新的目标', doneDefinition: '新的完成定义' });
  eq(JSON.stringify([r.status, db.one(`SELECT goal FROM projects WHERE id=?`, pid).goal]), JSON.stringify([200, '新的目标']), '负责人改目标 / 完成定义');
  eq((await postAs(hank.plaintext, `/api/projects/${pid}/goal`, { goal: 'x' })).status, 403, '成员不能改目标');
  eq((await post(`/api/projects/${pid}/member`, { userId: hank.userId, remove: true })).status, 200, '移出成员');
  await post(`/api/projects/${pid}/visibility`, { visibility: 'all' });
  const page = await (await fetch(base + '/')).text();
  assert(/添加任务…/.test(page) && !/接续为项目…/.test(page), '页面有"添加任务…"；"接续为项目…"已退役');
  assert(/项目成员/.test(page) && /仅本项目成员可见/.test(page) && /职能说明/.test(page), '页面有项目成员 / 可见性 / 职能说明');
}

section('4. 起 run 子进程：记审计、写日志文件');
{
  const t2 = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'run 测试','running',?)`, t2, owner.userId, now());
  const r = await post(`/api/tasks/${t2}/run`, {});
  eq(r.status, 200, 'run 返回');
  assert(r.result.pid > 0 && r.result.logFile.includes(t2), '有 pid 和日志文件路径');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='run_launched_from_web' AND target_id=?`, t2).n, 1, '审计 run_launched_from_web');
  await new Promise((ok) => setTimeout(ok, 2500));   // 子进程会因为 HOME 下没有这个任务而很快退出
  const log = await get(`/api/tasks/${t2}/log`);
  assert(existsSync(r.result.logFile) && typeof log.tail === 'string', '日志能拉到');
}

section('5. 来源检查：别的网页借浏览器发的 POST 一律 403');
{
  const { request } = await import('node:http');
  // fetch 不让改 Host / Origin，用裸 http 发
  const raw = (method, path, headers, body = '{}') => new Promise((ok, bad) => {
    const r = request({ host: '127.0.0.1', port: w.port, method, path, headers }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => ok({ status: res.statusCode, body: t }));
    });
    r.on('error', bad); if (method === 'POST') r.write(body); r.end();
  });
  const J = { 'content-type': 'application/json' };
  const before = db.one(`SELECT count(*) n FROM audit_log`).n;
  const evil = await raw('POST', '/api/llm', { ...J, origin: 'https://evil.example' }, JSON.stringify({ action: 'endpoint_save', id: 'deepseek', baseUrl: 'https://evil.example/v1' }));
  eq(evil.status, 403, '别的 Origin 的 POST → 403');
  assert(/跨站请求被拒/.test(evil.body), '403 说了原因');
  eq(db.one(`SELECT count(*) n FROM audit_log`).n, before, '被拒的请求什么都没写');
  eq((await raw('POST', '/api/llm', { 'content-type': 'text/plain' }, JSON.stringify({ action: 'catalog_check' }))).status, 403, 'text/plain（CORS 简单请求）→ 403');
  eq((await raw('POST', '/api/llm', {}, '{}')).status, 403, '没有 content-type → 403');
  eq((await raw('POST', '/api/llm', { ...J, 'sec-fetch-site': 'cross-site' })).status, 403, 'Sec-Fetch-Site: cross-site → 403');
  eq((await raw('POST', '/api/llm', { ...J, 'sec-fetch-site': 'same-site' })).status, 403, 'same-site 也不算（别的端口上的页面）');
  eq((await raw('POST', '/api/llm', { ...J, origin: 'null' })).status, 403, 'Origin: null（沙箱 iframe / file://）→ 403');
  eq((await raw('GET', '/api/tasks', { host: 'evil.example:' + w.port })).status, 403, 'Host 不是本机（DNS 重绑定）→ GET 也 403');
  eq((await raw('POST', '/api/llm', { ...J, host: 'evil.example:' + w.port, origin: 'http://evil.example:' + w.port })).status, 403, '重绑定后 Origin 与 Host 一致也不放');
  // 放行的三种：同源 Origin、Sec-Fetch-Site same-origin、两个头都没有（curl / 脚本）
  const okBody = JSON.stringify({ action: 'nope' });   // 未知动作 → 400，但过了来源检查
  eq((await raw('POST', '/api/llm', { ...J, origin: `http://127.0.0.1:${w.port}` }, okBody)).status, 400, '同源 Origin 放行（到了动作分发）');
  eq((await raw('POST', '/api/llm', { ...J, host: 'localhost:' + w.port, origin: `http://localhost:${w.port}`, 'sec-fetch-site': 'same-origin' }, okBody)).status, 400, 'localhost + same-origin 放行');
  eq((await raw('POST', '/api/llm', { 'content-type': 'application/json; charset=utf-8' }, okBody)).status, 400, '无 Origin 的脚本放行；content-type 带 charset 也认');
  eq((await raw('GET', '/api/tasks', {})).status, 200, 'GET 不受 content-type 约束');
}

section('步骤按执行顺序编号（同一次规划的节点时间戳相同，按随机 id 排会把最先执行的标成"步骤 3"）');
{
  const tid = newId('t'), T = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'排序','running',?)`, tid, ensureOwner(db).userId, T);
  const mk = (id, title, prio = 100) => db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at,priority) VALUES (?,?,?,'s','a','pending','normal','standard',?,?)`, id, tid, title, T, prio);
  // id 故意取得与执行顺序相反：按 id 排就会把最后一步排到最前
  mk('n_zzz_first', '先做'); mk('n_mmm_second', '再做'); mk('n_aaa_third', '最后');
  insertEdge(db, 'n_mmm_second', 'n_zzz_first', 'depends_on', T); insertEdge(db, 'n_aaa_third', 'n_mmm_second', 'depends_on', T);
  eq(taskDetail(db, tid).nodes.map((n) => n.title).join('→'), '先做→再做→最后', '按依赖深度排：页面上的"步骤 1/2/3"就是执行顺序');
}

section('看板页面的内联脚本至少要能被解析');
// 用脚本改 index.html 时，模板串里的 `\n` 容易被 heredoc / 替换吃成真换行 —— 整页脚本
// 当场语法错误、看板一片空白，而不解析页面脚本的测试会全绿照样通过。
{
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert(scripts.length > 0, '页面里有内联脚本');
  for (const [i, s] of scripts.entries()) {
    let err = null;
    try { new Function(s); } catch (e) { err = e.message; }
    assert(!err, `第 ${i + 1} 段内联脚本能被解析${err ? `（${err}）` : ''}`);
  }
}

section('已合并的项目任务上发修正 / 新指令 → 转成项目的「添加任务」，记在说话的人名下（否则发到已合并任务上的新指令会悬空、需求丢了）');
{
  const { appendStateOf } = await import('../src/agent/project-append.mjs');
  const pj = newId('pj'), tm = newId('t'), at = now();
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,status,draft_version,created_at,goal,done_definition,visibility)
          VALUES (?,?,'待办清单','b','/r','superintern/x','main','done',1,?,'g','d','team')`, pj, owner.userId, at);
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order,merged_at) VALUES (?,?,'T1','done',?,?,1,?)`, tm, owner.userId, at, pj, at);
  const r = await post(`/api/tasks/${tm}/say`, { body: '每条待办显示优先级标签，按优先级从高到低排', kind: 'instruction' });
  eq(r.result?.appended, true, '转成了添加任务');
  const st = appendStateOf(db, pj);
  eq([st.brief, st.requestedBy].join('|'), ['每条待办显示优先级标签，按优先级从高到低排', owner.userId].join('|'), '需求原文、记在说话的人名下');
  eq(db.one(`SELECT count(*) n FROM messages WHERE task_id=? AND kind='instruction'`, tm).n, 0, '没有在已合并的任务上留一条没人接的消息');
}

w.close(); db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 200);
