// 验收员看运行中的应用：离线部分。
//   ① 界面条目：规划器校验、落库清洗、迁移
//   ② 页面概况 → 给模型看的文字；工具按模型能力给
//   ③ 验收员：条目清单进提示词、没给结果提醒一次、fail 一律打回、起不了时照实标
//   ④ 会话：按需起、命令走沙箱、收尾关服务并还原工作区（新冒出来的删掉、本来改着的按快照写回）
//   ⑤ 交接：有界面条目的步骤在沙箱里必须有 si-preview.json
// 真浏览器那一段（驱动脚本在容器里跑 chromium）不在这个测试里。
//
// 跑：node tests/live-app.test.mjs

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { registryFor } from '../src/llm/registry.mjs';
import { insertNode, uiChecksOf, cleanUiChecks, UI_CHECKS_MAX } from '../src/db/nodes.mjs';
import { validateNodeSet } from '../src/agent/planner.mjs';
import { verifyHandoff, verifierRounds } from '../src/agent/verifier.mjs';
import { liveTools, renderPage } from '../src/agent/live-tools.mjs';
import { LiveApp } from '../src/core/live-app.mjs';
import { previewOf, taskDetail } from '../src/web/server.mjs';
import { audit } from '../src/db/db.mjs';
import { snapshotWorkspace, restoreWorkspace } from '../src/core/preview.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-live-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const repo = (name, files = { 'README.md': '# x\n' }) => {
  const ws = join(TMP, name); mkdirSync(ws, { recursive: true });
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(ws, p, '..'), { recursive: true }); writeFileSync(join(ws, p), c); }
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init');
  return ws;
};
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${name}_${Math.random()}`, name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
const task = (db, { ui = null } = {}) => {
  const { userId } = ensureOwner(db);
  const id = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'live-app',?,?)`, id, userId, 'running', t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'待办页','.','能加待办','[]',?,?)`, newId('c'), id, t, t);
  const nid = insertNode(db, { taskId: id, title: '待办页', spec: '做 /todos 页', acceptance: 'npm test 通过', uiChecks: ui });
  return { id, nid, userId };
};
const PAGE = { ok: true, status: 200, page: { title: '待办', url: 'http://127.0.0.1:5173/todos', found: true, text: '待办\n买牛奶', truncated: false,
  controls: [{ n: 1, kind: 'text', label: '新待办', value: '' }, { n: 2, kind: 'button', label: '添加' }, { n: 3, kind: 'select', label: '', value: 'all', options: ['全部', '已完成'] }] },
  errors: [], failed: [{ request: 'GET http://127.0.0.1:8000/api/stats', status: 500 }] };
/** 同形的假会话：记下驱动命令，按脚本回页面 */
const fakeLive = ({ fail: failStart = false } = {}) => ({
  state: 'idle', actions: 0, shots: 0, why: null, cmds: [],
  url: (p) => `http://127.0.0.1:5173${p}`,
  async drive(cmd) { if (failStart) { this.state = 'failed'; this.why = '起不来'; return { ok: false, error: '起不来' }; } this.state = 'up'; this.actions++; this.cmds.push(cmd); return PAGE; },
  async screenshot() { this.shots++; return { ok: true, url: 'http://127.0.0.1:5173/todos', mediaType: 'image/png', data: 'iVBORw0KGgo=' }; },
});

section('① 界面条目：校验、清洗、落库');
{
  const n = { key: 'n1', title: 't', spec: 's', acceptance: 'npm test 通过 3 个用例', depends_on: [], risk_tier: 'normal', model_tier: 'standard' };
  eq(validateNodeSet([{ ...n, ui_checks: ['在 / 点添加，列表多一条'] }]), [], '字符串数组：合法');
  assert(validateNodeSet([{ ...n, ui_checks: 'x' }]).some((e) => e.includes('ui_checks 要是字符串数组')), '不是数组：拒');
  assert(validateNodeSet([{ ...n, ui_checks: Array.from({ length: UI_CHECKS_MAX + 1 }, (_, i) => `第 ${i} 条`) }]).some((e) => e.includes(`至多 ${UI_CHECKS_MAX} 条`)), '超过上限：拒，并说怎么办');
  eq(validateNodeSet([n]), [], '不填：合法（没有界面的节点）');
  eq(cleanUiChecks([' 点  添加 ', '', '点 添加', null, '看列表']), ['点 添加', '看列表'], '去空白、去空、去重');
  const db = openDb(join(TMP, 'a.db'));
  const t1 = task(db, { ui: ['在 /todos 填标题点添加，列表多出这一条'] }), t2 = task(db);
  eq([uiChecksOf(db.one(`SELECT * FROM nodes WHERE id=?`, t1.nid)), db.one(`SELECT ui_checks FROM nodes WHERE id=?`, t2.nid).ui_checks],
    [['在 /todos 填标题点添加，列表多出这一条'], null], '落库：有就存 JSON 数组，没有存 NULL');
  let err = null;
  try { db.run(`UPDATE nodes SET ui_checks='{"a":1}' WHERE id=?`, t2.nid); } catch (e) { err = e.message; }
  assert(err && /CHECK/.test(err), '库层 CHECK：只收 JSON 数组', err);
  db.close();
}

section('② 页面概况与工具');
{
  const s = renderPage(PAGE, { action: '点了「添加」。' });
  for (const want of ['点了「添加」。', '当前页面：「待办」 http://127.0.0.1:5173/todos（HTTP 200）', '1 输入框(text)「新待办」 = ""', '2 按钮「添加」', '3 下拉框 = all（可选：全部 / 已完成）',
    '失败的请求：\n  GET http://127.0.0.1:8000/api/stats → 500', '页面文字：\n待办\n买牛奶']) assert(s.includes(want), `概况里有：${want.split('\n')[0]}`, s);
  eq(renderPage({ ok: false, error: '找不到控件「9」' }), '没做成：找不到控件「9」', '没做成：照实说');
  eq([liveTools().map((t) => t.name).includes('screenshot'), liveTools({ vision: true }).map((t) => t.name).includes('screenshot')], [false, true], '截图工具只给收图的模型');
}

section('③ 验收员');
eq([0, 3, 7, 8, 20].map((n) => verifierRounds({ live: true, uiCount: n })), [16, 16, 24, 26, 30], '轮数随界面条目加：每条两轮，至少 16、至多 30（7 条的会话撞到 16 轮，末尾几条没验成）');
eq(verifierRounds({ live: false, uiCount: 5 }), 10, '应用没起来：不用点验，轮数照旧');
{
  const db = openDb(join(TMP, 'v.db'));
  const t = task(db, { ui: ['在 /todos 填标题点添加，列表多出这一条', '已完成的待办显示删除线'] });
  const ws = repo('v');
  const handoff = { artifacts: [{ path: 'README.md', kind: 'doc' }], interface_contract: '-', acceptance_evidence: '-', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] };
  const run = async (script, opts = {}) => {
    let i = 0;
    const calls = [];   // 每次请求的工具与当时的消息（消息数组之后还会长，存一份快照）
    const fake = makeRoleFake({ verifier: (canon) => { calls.push({ tools: canon.tools, messages: [...canon.messages] }); return script[i++]?.(canon) ?? call('submit_verdict', { verdict: 'accept', evidence_checked: [] }); } });
    const client = new LlmClient({ mode: 'fake', fake, ...registryFor(db) });
    const v = await verifyHandoff(db, { client, taskId: t.id, nodeId: t.nid, workspace: ws, exec: new LocalExecutor(), args: handoff, ...opts });
    return { v, calls };
  };
  const lastAudit = () => JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='handoff_verified' ORDER BY id DESC LIMIT 1`).payload);

  // 应用能起：工具在、清单进提示词；第一次没给条目结果、也没打开过 → 提醒一次；第二次照收，缺的记"没点验"
  const live = fakeLive();
  const r1 = await run([
    () => call('submit_verdict', { verdict: 'accept', evidence_checked: ['README.md'] }),
    () => call('open_page', { path: '/todos' }),
    () => call('type_text', { target: '新待办', text: '写周报', press_enter: true }),
    () => call('submit_verdict', { verdict: 'accept', evidence_checked: ['页面'], ui_checks: [{ n: 1, result: 'pass', evidence: '填了写周报回车，列表多了一条' }] }),
  ], { live });
  const c0 = r1.calls[0];
  assert(c0.tools.some((x) => x.name === 'open_page') && !c0.tools.some((x) => x.name === 'screenshot'), '应用能起：给浏览器工具；模型不收图就不给截图');
  assert(c0.messages[0].content[0].text.includes('1. 在 /todos 填标题点添加，列表多出这一条'), '界面条目清单进提示词');
  assert(c0.tools.find((x) => x.name === 'submit_verdict').parameters.required.includes('ui_checks'), '有界面条目时 submit_verdict 要求 ui_checks');
  const nag = r1.calls[1].messages.at(-1).results[0].content;
  assert(nag.includes('第 1、2 条没给结果') && nag.includes('一次都没打开过'), '第一次交：提醒缺哪几条、还没打开过应用', nag);
  eq(live.cmds.map((c) => c.cmd), ['open', 'type'], '工具命令照传给会话（打开、填字回车）');
  eq(live.cmds[0].url, 'http://127.0.0.1:5173/todos', '路径拼成应用地址');
  eq([r1.v.verdict, r1.v.uiChecks.map((c) => [c.result, c.by])], ['accept', [['pass', 'verifier'], ['not_checked', 'system']]], '第二次照收：没给的记成"没点验"（系统代填），不拦结论');
  eq(lastAudit().ui.live, { state: 'up', why: null, actions: 2, shots: 0, vision: false }, '审计记下：应用起来了、操作了两次');

  // fail 却给了 accept：按打回，缺陷位置是"界面条目 n"（诊断层按它判同一条缺陷）
  const r2 = await run([() => call('open_page', { path: '/' }),
    () => call('submit_verdict', { verdict: 'accept', evidence_checked: [], ui_checks: [{ n: 1, result: 'pass', evidence: 'ok' }, { n: 2, result: 'fail', evidence: '勾了已完成，文字没有删除线' }] })], { live: fakeLive() });
  eq([r2.v.verdict, r2.v.defects.map((d) => [d.category, d.locations[0]])], ['reject', [['acceptance', '界面条目 2']]], '有一条 fail：打回，缺陷指向界面条目 2');
  assert(r2.v.reasons[0].includes('文字没有删除线'), '打回理由带上看到了什么');

  // 收图的模型：有截图工具，截图作为图片回到工具结果里
  const r3 = await run([() => call('open_page', { path: '/' }), () => call('screenshot', {}),
    () => call('submit_verdict', { verdict: 'accept', evidence_checked: [], ui_checks: [{ n: 1, result: 'pass', evidence: 'a' }, { n: 2, result: 'pass', evidence: 'b' }] })], { live: fakeLive(), vision: true });
  const shot = r3.calls[2].messages.at(-1).results[0];
  eq([shot.images?.length, shot.images?.[0].mediaType], [1, 'image/png'], '收图的模型：截图以图片回到工具结果里');

  // 起不了：没有浏览器工具，提示词说清原因，条目全记"没点验"带原因
  const r4 = await run([() => call('submit_verdict', { verdict: 'accept', evidence_checked: [], ui_checks: [{ n: 1, result: 'not_checked', evidence: '应用起不来' }, { n: 2, result: 'not_checked', evidence: '同上' }] })],
    { live: null, liveWhy: '仓库根没有 si-preview.json' });
  assert(!r4.calls[0].tools.some((x) => x.name === 'open_page') && r4.calls[0].messages[0].content[0].text.includes('应用这次起不来（仓库根没有 si-preview.json）'), '起不了：不给浏览器工具，提示词说清原因');
  eq([r4.v.verdict, lastAudit().ui.live], ['accept', { state: 'none', why: '仓库根没有 si-preview.json' }], '起不了不拦结论；审计记下原因（签收时看得到哪些没点验）');

  // 存了画面的会话 —— 提示词说清怎么引用；只认这次真存下来的画面号；审计带上存画面的目录 key
  const lv = Object.assign(fakeLive(), { key: 'n_abc123-k1', keepDir: join(TMP, 'kd'), saved: new Set([1, 2]),
    cite(list) { return [...new Set((list ?? []).map(Number).filter((x) => this.saved.has(x)))].slice(0, 3); } });
  const r5 = await run([() => call('open_page', { path: '/' }),
    () => call('submit_verdict', { verdict: 'accept', evidence_checked: [], ui_checks: [{ n: 1, result: 'pass', evidence: 'a', screens: [1, 9] }, { n: 2, result: 'pass', evidence: 'b' }] })], { live: lv });
  assert(r5.calls[0].messages[0].content[0].text.includes('[画面 #n]'), '存画面的会话：提示词说清画面号从哪来、填在 screens 里');
  eq(r5.v.uiChecks.map((c) => c.screens ?? null), [[1], null], '只认这次真存下来的画面号（9 不存在，丢掉）；没引用的条目不带');
  eq(lastAudit().ui.live.screens, 'n_abc123-k1', '审计记下存画面的目录 key（看板按它取图）');
  assert(!r1.calls[0].messages[0].content[0].text.includes('[画面 #n]'), '没存画面的会话：提示词不提画面');
  // 看板：任务详情的步骤带 key 与逐条画面；签收看的 previewOf 带上逐步的点验（截图那条审计在不在都带）
  audit(db, { actorKind: 'system', action: 'preview_captured', targetType: 'task', targetId: t.id, payload: { head: 'abc', shots: [] } });
  const pv = previewOf(db, t.id);
  eq([pv.live.length, pv.live[0].key, pv.live[0].checks.map((c) => c.screens)], [1, 'n_abc123-k1', [[1], []]], 'previewOf：逐步的点验结果与画面');
  const dn = taskDetail(db, t.id).nodes.find((x) => x.id === t.nid);
  eq([dn.uiScreens, dn.uiChecks[0].screens], ['n_abc123-k1', [1]], '任务详情的步骤：画面 key 与逐条引用');

  // 没有界面条目、也没有应用：提示词里没有这一节，工具照旧
  const t2 = task(db);
  let c = null;
  const fake = makeRoleFake({ verifier: (canon) => { c = canon; return call('submit_verdict', { verdict: 'accept', evidence_checked: [] }); } });
  await verifyHandoff(db, { client: new LlmClient({ mode: 'fake', fake, ...registryFor(db) }), taskId: t2.id, nodeId: t2.nid, workspace: ws, exec: new LocalExecutor(), args: handoff });
  assert(!c.messages[0].content[0].text.includes('界面条目') && !c.tools.find((x) => x.name === 'submit_verdict').parameters.properties.ui_checks, '与界面无关的步骤：没有这一节，结论里也不要 ui_checks');
  db.close();
}

section('④ 会话：按需起、收尾还原');
{
  const ws = repo('s', { 'data.json': '[]\n', 'src/app.js': 'x\n' });
  writeFileSync(join(ws, 'data.json'), '["执行器交的"]\n');   // 这一步的改动（还没提交）
  const ran = [];
  const exec = {
    isolated: true,
    async execute(cmd) {
      const argv = [cmd.file, ...cmd.args]; ran.push(argv.join(' '));
      if (cmd.file === 'node') {   // 驱动：模拟应用被点了以后往工作区写东西
        writeFileSync(join(ws, 'data.json'), '["执行器交的","验收员点出来的"]\n');
        writeFileSync(join(ws, 'app.sqlite'), 'db');
        return { code: 0, stdout: `${JSON.stringify({ ok: true, page: { title: 't', url: 'u', text: '', controls: [] }, errors: [], failed: [] })}\n` };
      }
      return { code: 0, stdout: '' };
    },
  };
  const spec = { start: [['node', 'server.js']], url: 'http://127.0.0.1:5173', ready: ['http://127.0.0.1:5173/'], seed: [], pages: [{ path: '/', title: '首页' }], waitMs: 1000 };
  const app = new LiveApp(exec, ws, spec, { readyTimeoutMs: 2000 });
  eq((await app.close()).used, false, '没用到就关：什么都没起');
  const app2 = new LiveApp(exec, ws, spec, { readyTimeoutMs: 2000 });
  const r = await app2.drive({ cmd: 'open', url: app2.url('/') });
  eq([r.ok, app2.state, existsSync(join(ws, '.si-preview', 'drive.mjs'))], [true, 'up', true], '第一次用到才起：服务、浏览器、驱动脚本就位');
  assert(ran.some((x) => x.includes('setsid') && x.includes('server.js')) && ran.some((x) => x.includes('--remote-debugging-port=9333') && x.includes('--remote-debugging-address=127.0.0.1')),
    '起服务与浏览器都走沙箱；调试口只听 127.0.0.1');
  const s = await app2.close();
  eq([readFileSync(join(ws, 'data.json'), 'utf8'), existsSync(join(ws, 'app.sqlite')), existsSync(join(ws, '.si-preview'))], ['["执行器交的"]\n', false, false],
    '收尾：执行器改着的文件按快照写回、新冒出来的删掉、驱动目录清掉');
  eq([s.used, s.restored.rewritten, s.restored.removed], [true, ['data.json'], ['app.sqlite']], '会话小结记下还原了什么（进审计）');
  assert(ran.some((x) => x.includes('si-preview.pids') && x.includes('kill')), '收尾关掉服务与浏览器（整组杀）');

  // 系统起服务、跑 seed 都带 SI_PREVIEW=1（样例数据脚本据此拒绝在别处运行，免得写进真库）
  ran.length = 0;
  const app6 = new LiveApp(exec, ws, { ...spec, seed: [['python', 'seed.py']] }, { readyTimeoutMs: 2000 });
  await app6.drive({ cmd: 'read' });
  await app6.close();
  assert(ran.some((x) => x.includes('setsid env SI_PREVIEW=1 ') && x.includes('server.js')) && ran.includes('env SI_PREVIEW=1 python seed.py'), '起服务与跑样例数据都带 SI_PREVIEW=1', ran.join(' | '));

  const failExec = { isolated: true, async execute(cmd) { return { code: cmd.file === 'curl' ? 7 : 0, stdout: '' }; } };
  const app3 = new LiveApp(failExec, ws, spec, { readyTimeoutMs: 100 });
  const f1 = await app3.drive({ cmd: 'open', url: 'x' }), f2 = await app3.drive({ cmd: 'read' });
  eq([f1.ok, app3.state, f2.error === f1.error, /打不开/.test(f1.error)], [false, 'failed', true, true], '起不来：说清哪些地址打不开；记住失败，不反复重起');
  await app3.close();

  // 画面 —— 打开 / 点之后各存一张到 keepDir（读不存）；收尾只留验收员引用了的；一张没引用就整个目录删掉
  const shotExec = {
    isolated: true,
    async execute(cmd) {
      if (cmd.file === 'node') {
        const a = JSON.parse(cmd.args[1]);
        if (a.shot) writeFileSync(join(ws, a.shot), 'png');
        return { code: 0, stdout: `${JSON.stringify({ ok: true, page: { title: 't', url: 'u', text: '', controls: [] }, errors: [], failed: [] })}\n` };
      }
      return { code: 0, stdout: '' };
    },
  };
  const kd = join(TMP, 'keep-1');
  const app4 = new LiveApp(shotExec, ws, spec, { readyTimeoutMs: 2000, keepDir: kd, key: 'n_x-1' });
  const s1 = await app4.drive({ cmd: 'open', url: app4.url('/') }), s2 = await app4.drive({ cmd: 'click', target: '添加' }), s3 = await app4.drive({ cmd: 'read' });
  eq([s1.screen, s2.screen, s3.screen ?? null, existsSync(join(kd, '01.png')), existsSync(join(kd, '02.png'))], [1, 2, null, true, true], '打开、点之后各存一张（编号进结果）；read 不存');
  eq(app4.cite([2, 2, 5]), [2], '引用：去重、只认存下来的');
  const s4 = await app4.close();
  eq([existsSync(join(kd, '01.png')), existsSync(join(kd, '02.png')), s4.screens], [false, true, { taken: 2, kept: [2] }], '收尾只留引用了的；小结记下存了几张、留了哪几张');
  const kd2 = join(TMP, 'keep-2');
  const app5 = new LiveApp(shotExec, ws, spec, { readyTimeoutMs: 2000, keepDir: kd2, key: 'n_x-2' });
  await app5.drive({ cmd: 'open', url: app5.url('/') });
  await app5.close();
  eq(existsSync(kd2), false, '一张都没引用：整个目录删掉');

  // 快照只比内容：没被动过的不重写
  const ws2 = repo('s2', { 'a.txt': '1\n' });
  writeFileSync(join(ws2, 'a.txt'), '2\n');
  const snap = snapshotWorkspace(ws2);
  eq(restoreWorkspace(ws2, snap), { removed: [], rewritten: [], kept: [] }, '没被动过：什么都不做');
}

section('⑤ 交接：有界面条目的步骤要有 si-preview.json');
{
  class Sandboxed extends LocalExecutor { isolated = true; }
  const db = openDb(join(TMP, 'h.db'));
  const t = task(db, { ui: ['在 / 看到标题'] });
  const ws = repo('h');
  git(ws, 'checkout', '-q', '-b', 'v0/t');
  const handoff = { artifacts: [{ path: 'index.html' }], interface_contract: '-', acceptance_evidence: 'cat index.html', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] };
  let n = 0;
  const fake = makeRoleFake({
    executor: () => [call('write_file', { path: 'index.html', content: '<h1>x</h1>\n' }), call('submit_handoff', handoff),
      call('write_file', { path: 'si-preview.json', content: JSON.stringify({ start: ['node server.js'], url: 'http://127.0.0.1:5173', pages: ['/'] }) }),
      call('submit_handoff', { ...handoff, artifacts: [{ path: 'index.html' }, { path: 'si-preview.json' }] })][n++] ?? call('submit_handoff', handoff),
  });
  await orchestrate(db, { taskId: t.id, workspace: ws, narrativeDir: join(TMP, 'narr'), verify: false, llmVerify: false, maxCycles: 1, maxIterations: 6, exec: new Sandboxed(),
    makeClient: () => new LlmClient({ mode: 'fake', fake, ...registryFor(db) }) });
  const rej = db.all(`SELECT payload FROM audit_log WHERE action='handoff_rejected' AND target_id=?`, t.nid).map((r) => JSON.parse(r.payload));
  assert(rej.length === 1 && rej[0].errs.some((e) => e.includes('si-preview.json') && e.includes('逐条点验')), '没有 si-preview.json：拒收，并说清要写什么', JSON.stringify(rej));
  eq(db.one(`SELECT status FROM nodes WHERE id=?`, t.nid).status, 'done', '补上之后交接受理');
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
