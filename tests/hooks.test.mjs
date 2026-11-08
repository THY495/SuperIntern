// 策略钩子：配置解析、matcher、结论读法（exit 2 / JSON / 老写法）、deny > ask > allow、失败策略、宿主钩子按内容 hash 信任、
// 执行器 PreToolUse / PreHandoff、仓库钩子从基线读、钩子文件被改 → 不跑并当作拦下、要人确认 → 走提问、答「同意」放行。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { executeNode } from '../src/agent/executor.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { createProject, advanceProject, deliverProject } from '../src/core/project.mjs';
import { signOff, deliverTask } from '../src/core/deliver.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import { gateHit, setGates } from '../src/core/approval-gates.mjs';
import { parseHooksConfig, matches, readHookResult, mergeDecisions, hostHooks, trustHostHooks, makeHookSession, isHookPath, toolInputFor } from '../src/core/hooks.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, m, re) => { try { fn(); bad(m, '期望被拒绝，但成功了'); } catch (e) { (re && !re.test(e.message)) ? bad(m, `报错不对：${e.message}`) : ok(`${m}\n         └ ${String(e.message).split('\n')[0]}`); } };

const TMP = mkdtempSync(join(tmpdir(), 'si-hooks-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const HOME = join(TMP, 'home');
process.env.SUPERINTERN_HOME = HOME;
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const put = (root, rel, text) => { const p = join(root, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
function repo(name) {
  const ws = join(TMP, name);
  mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't'); git(ws, 'config', 'core.autocrlf', 'false');
  return { ws, put: (rel, text) => put(ws, rel, text), commit: () => { git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'c'); return git(ws, 'rev-parse', 'HEAD').stdout.trim(); } };
}
// 钩子脚本：读 stdin 的 JSON，按规则给结论（node 跑，Windows / Linux 都能用）
const SCRIPT = (body) => `let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>{const j=JSON.parse(s);${body}});\n`;

section('① 配置解析、matcher、结论读法、合并');
{
  const cfg = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|write_file', hooks: [{ type: 'command', command: 'node a.mjs', timeout: 5, onFailure: 'block' }, { type: 'prompt', prompt: 'x' }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }], PreHandoff: [{ hooks: [{ type: 'command', command: 'node b.mjs' }] }] } });
  const r = parseHooksConfig(cfg, { source: 'repo', file: '.superintern/hooks.json' });
  eq(r.entries.map((e) => [e.event, e.matcher, e.command, e.timeout, e.onFailure]), [['PreToolUse', 'Bash|write_file', 'node a.mjs', 5, 'block'], ['PreHandoff', '', 'node b.mjs', 30, 'allow']], '拆成平铺条目；超时默认 30 秒；onFailure 默认放行');
  eq(r.warnings.length, 2, '不是 command 类型的、这里不认的事件（PostToolUse）：只警告');
  eq(parseHooksConfig('{坏', { source: 'repo', file: 'x' }).warnings[0]?.msg.includes('不是合法的 JSON'), true, 'JSON 坏了：警告，不抛');
  eq([matches('Bash', 'run_command'), matches('run_command', 'run_command'), matches('Write|Edit', 'write_file'), matches('Read', 'write_file'), matches('', 'grep'), matches('^(Read|Grep)$', 'grep'), matches('mcp__.*', 'grep')],
    [true, true, true, false, true, true, false], 'matcher：我们的名字与 Claude 的别名都认；空 = 全部；含正则字符的按正则');
  eq(readHookResult({ code: 2, stderr: '不许删\n', stdout: '' }), { decision: 'deny', reason: '不许删' }, 'exit 2 = 拦下，理由取 stderr');
  eq(readHookResult({ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: '要确认' } }) }).decision, 'ask', 'JSON：permissionDecision');
  eq(readHookResult({ code: 0, stdout: '{"decision":"block","reason":"老写法"}' }), { decision: 'deny', reason: '老写法', context: null }, '老写法 decision: block');
  eq(readHookResult({ code: 0, stdout: '{"continue":false,"stopReason":"停"}' }).decision, 'deny', 'continue: false 当拦下');
  eq(readHookResult({ code: 0, stdout: '随便打印点东西' }).decision, 'allow', 'stdout 不是 JSON：放行');
  eq([readHookResult({ code: 1, stderr: 'boom' }).failed, readHookResult({ code: 0, timedOut: true }).failed, readHookResult({ code: 0, stdout: '{坏' }).failed], [true, true, true], '其它退出码 / 超时 / JSON 坏：算钩子出错（交给失败策略）');
  const m = mergeDecisions([{ hook: 'a', decision: 'allow', context: 'c1' }, { hook: 'b', decision: 'ask', reason: '问' }, { hook: 'c', decision: 'deny', reason: '不行' }, { hook: 'd', decision: 'deny', reason: '也不行' }]);
  eq([m.decision, m.reasons.map((x) => x.hook), m.context], ['deny', ['c', 'd'], 'c1'], 'deny > ask > allow；理由只拼最高那一级的');
  eq(mergeDecisions([{ hook: 'a', decision: 'ask', reason: 'x' }, { hook: 'b', decision: 'allow' }]).decision, 'ask', '没有 deny 时 ask 胜');
  eq([isHookPath('.superintern/hooks.json'), isHookPath('.claude/hooks/x.sh'), isHookPath('./.claude/settings.json'), isHookPath('src/hooks.json')], [true, true, true, false], 'isHookPath 认配置与钩子脚本目录');
  eq(toolInputFor('run_command', { file: 'git', args: ['commit', '-m', 'a b'] }).command, "git commit -m 'a b'", 'run_command 给 Claude 式的 command 字段（钩子按 Bash 写的能用）');
  eq(toolInputFor('write_file', { path: 'a.js', content: 'x' }).file_path, 'a.js', 'write_file 给 file_path');
}

section('② 宿主钩子：按内容 hash 信任；没信任过 / 内容变了就不跑');
{
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  put(HOME, 'hooks/guard.mjs', SCRIPT(`process.stderr.write('宿主拦下 '+j.tool_name);process.exit(2);`));
  put(HOME, 'hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: `node ${join(HOME, 'hooks', 'guard.mjs')}` }] }] } }));
  let h = hostHooks(db);
  eq([h.entries.length, h.entries[0]?.trusted], [1, false], '读到一条，还没信任');
  const r = repo('h2'); r.put('a.txt', 'x'); r.commit();
  const taskId = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'t','running',?)`, taskId, userId, Date.now());
  let s = makeHookSession(db, { taskId, workspace: r.ws, exec: new LocalExecutor(), baseRef: null });
  let m = await s.run('PreToolUse', { tool_name: 'run_command', tool_input: {} }, { tool: 'run_command' });
  eq(m.decision, 'allow', '没信任：不跑，按工具前的失败策略放行');
  eq(db.all(`SELECT 1 FROM audit_log WHERE action='hook_untrusted'`).length, 1, '记一条"没信任"');
  eq(db.all(`SELECT 1 FROM signals WHERE name='security.hook_failed_open' AND task_id=?`, taskId).length, 1, '没跑成、按设置放行：告诉任务负责人（安全边界被系统改了）');
  trustHostHooks(db, { userId });
  s = makeHookSession(db, { taskId, workspace: r.ws, exec: new LocalExecutor(), baseRef: null });
  m = await s.run('PreToolUse', { tool_name: 'run_command', tool_input: {} }, { tool: 'run_command' });
  eq([m.decision, m.reasons[0]?.reason], ['deny', '宿主拦下 run_command'], '信任之后照跑：拦下，理由来自 stderr');
  eq((await s.run('PreToolUse', { tool_name: 'read_file' }, { tool: 'read_file' })).ran, 0, 'matcher 对不上的工具不跑');
  put(HOME, 'hooks/guard.mjs', SCRIPT(`process.exit(0);`));
  h = hostHooks(db);
  eq(h.entries[0].trusted, false, '脚本内容变了：信任失效（要操作人重新 hook trust）');
  rejects(() => trustHostHooks(db, { projectId: null, ids: ['nope'], userId }), '核准不存在的条目 → 拒', /没有要核准/);
  rmSync(join(HOME, 'hooks.json'));
}

// ── 执行器夹具 ──
const call = (name, args) => ({ stopReason: 'tool_call', usage: { inputTokens: 10, outputTokens: 5 }, content: [{ type: 'tool_call', id: `c_${Math.random().toString(36).slice(2, 8)}`, name, args }] });
const lastResults = (canon) => (canon.messages.at(-1)?.results ?? []).map((x) => x.content).join('\n');
const HANDOFF = (paths) => ({ artifacts: paths.map((path) => ({ path, kind: 'code' })), interface_contract: 'add(a,b)', acceptance_evidence: 'node -e', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] });
function fixture(ws, head) {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'加 add()','只动 src/','测试通过','[]',?,?)`, newId('c'), taskId, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写 add','src/add.js 导出 add','node -e 能调用','pending','normal','standard',?)`, nodeId, taskId, t);
  audit(db, { actorKind: 'system', action: 'workspace_created', targetType: 'task', targetId: taskId, payload: { head } });   // 任务开工时的基线
  return { db, taskId, nodeId, userId };
}
const run = (db, taskId, nodeId, ws, script, name) => executeNode(db, { client: new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor: script }) }),
  taskId, nodeId, workspace: ws, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, `nar-${name}`), exec: new LocalExecutor(), maxIterations: 10 });

section('③ 执行器 PreToolUse：仓库钩子（我们的格式 + .claude/settings.json）从基线读；拦下的不执行；补充附在结果后');
{
  const r = repo('e3');
  r.put('src/.keep', '');
  r.put('.superintern/hooks/no-rm.mjs', SCRIPT(`const a=j.tool_input||{};if(j.tool_name==='run_command'&&(a.args||[]).includes('-rf')){process.stderr.write('不许 rm -rf');process.exit(2)}
if(j.tool_name==='read_file')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',additionalContext:'读 '+a.file_path+' 时注意：这是生成的文件'}}));`));
  r.put('.superintern/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'run_command|read_file', hooks: [{ type: 'command', command: 'node .superintern/hooks/no-rm.mjs' }] }] } }));
  r.put('.claude/hooks/no-env.mjs', SCRIPT(`if(String((j.tool_input||{}).file_path||'').endsWith('.env')){console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'别写 .env'}}))}`));
  r.put('.claude/settings.json', JSON.stringify({ permissions: {}, hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node .claude/hooks/no-env.mjs' }] }], Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }));
  r.put('gen.txt', '生成的\n');
  const head = r.commit();
  const { db, taskId, nodeId } = fixture(r.ws, head);
  const seen = [];
  const res = await run(db, taskId, nodeId, r.ws, (canon, i) => {
    if (i > 0) seen.push(lastResults(canon));
    if (i === 0) return call('run_command', { file: 'rm', args: ['-rf', 'src'] });
    if (i === 1) return call('read_file', { path: 'gen.txt' });
    if (i === 2) return call('write_file', { path: 'src/.env', content: 'K=1' });
    if (i === 3) return call('write_file', { path: 'src/add.js', content: 'export const add = (a, b) => a + b;\n' });
    return call('submit_handoff', HANDOFF(['src/add.js']));
  }, 'e3');
  assert(/\[钩子\] 这次调用被拦下，没执行/.test(seen[0]) && seen[0].includes('不许 rm -rf'), 'rm -rf 被仓库钩子拦下，理由回给模型', seen[0]);
  assert(seen[1].includes('生成的') && seen[1].includes('[钩子补充]') && seen[1].includes('读 gen.txt 时注意'), 'read_file 照常执行，钩子的补充附在后面');
  assert(seen[2].includes('别写 .env'), '.claude/settings.json 里按 Claude 工具名（Write）写的钩子也生效');
  eq(res.kind, 'done', '其余照常，交接通过');
  eq(db.all(`SELECT payload FROM audit_log WHERE action='hook_decision'`).length, 2, '拦下的两次记审计');
}

section('④ 钩子文件被改：仓库钩子不跑、当作拦下；交接打回（同规则文件）');
{
  const r = repo('e4');
  r.put('src/.keep', '');
  r.put('.superintern/hooks/no-rm.mjs', SCRIPT(`if(j.tool_name==='run_command'){process.stderr.write('拦');process.exit(2)}`));
  r.put('.superintern/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node .superintern/hooks/no-rm.mjs' }] }] } }));
  const head = r.commit();
  const { db, taskId, nodeId } = fixture(r.ws, head);
  const seen = [];
  await run(db, taskId, nodeId, r.ws, (canon, i) => {
    if (i > 0) seen.push(lastResults(canon));
    if (i === 0) return call('write_file', { path: '.superintern/hooks/no-rm.mjs', content: 'process.exit(0)\n' });
    if (i === 1) return call('run_command', { file: 'node', args: ['-e', '1'] });
    if (i === 2) return call('write_file', { path: 'src/add.js', content: 'x\n' });
    if (i === 3) return call('submit_handoff', HANDOFF(['src/add.js']));
    return call('raise_question', { level: 2, text: '卡住', blocked_by: 'x', work_done: 'x', plan_after_answer: 'x' });
  }, 'e4');
  assert(/钩子文件被改过（\.superintern\/hooks\/no-rm\.mjs）/.test(seen[1]) && /没执行/.test(seen[1]), '改了钩子脚本：下一次调用不执行，说清要先撤销', seen[1]);
  assert(/改了策略钩子文件：`?\.superintern\/hooks\/no-rm\.mjs/.test(seen[3]), '交接打回：改了钩子文件', seen[3]);
}

section('⑤ PreHandoff：拦下并进拒收（连续三次一样 → 转成问题）；要人确认 → 挂事项，答「同意」放行');
{
  const r = repo('e5');
  r.put('src/.keep', '');
  r.put('.superintern/hooks/handoff.mjs', SCRIPT(`const n=(j.changed_files||[]).length;if(!(j.handoff&&j.handoff.known_issues&&j.handoff.known_issues.length)){process.stderr.write('交接要写 known_issues（'+n+' 个改动）');process.exit(2)}`));
  r.put('.superintern/hooks.json', JSON.stringify({ hooks: { PreHandoff: [{ hooks: [{ type: 'command', command: 'node .superintern/hooks/handoff.mjs' }] }] } }));
  const head = r.commit();
  const { db, taskId, nodeId } = fixture(r.ws, head);
  const seen = [];
  const res = await run(db, taskId, nodeId, r.ws, (canon, i) => {
    if (i > 0) seen.push(lastResults(canon));
    if (i === 0) return call('write_file', { path: 'src/add.js', content: 'x\n' });
    return call('submit_handoff', HANDOFF(['src/add.js']));
  }, 'e5');
  assert(seen[1]?.includes('[钩子]') && seen[1].includes('交接要写 known_issues（1 个改动）'), '交接被钩子拦下：理由回给模型（钩子拿到了改动清单）', seen[1]);
  eq(res.kind, 'question', '同一条拦下连续三次：转成问题交人（不无限重试）');

  // 要人确认
  const r2 = repo('e5b');
  r2.put('src/.keep', '');
  r2.put('.superintern/hooks/ask.mjs', SCRIPT(`if(j.tool_name==='run_command'&&(j.tool_input.args||[])[0]==='publish')console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'发布要人点头'}}))`));
  r2.put('.superintern/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .superintern/hooks/ask.mjs' }] }] } }));
  const head2 = r2.commit();
  const f = fixture(r2.ws, head2);
  const script = (canon, i) => {
    if (i === 0) return call('run_command', { file: 'npm', args: ['publish'] });
    if (i === 1) { seen.push(lastResults(canon)); return call('write_file', { path: 'src/add.js', content: 'x\n' }); }
    return call('submit_handoff', HANDOFF(['src/add.js']));
  };
  const a1 = await run(f.db, f.taskId, f.nodeId, r2.ws, script, 'e5b1');
  eq(a1.kind, 'question', '钩子说要人确认：挂事项，本节点挂起');
  const q = f.db.one(`SELECT * FROM questions WHERE id=?`, a1.question?.id ?? '');
  assert(q && /策略钩子要人确认/.test(q.text) && q.text.includes('发布要人点头') && q.text.includes('npm'), '事项正文：哪个操作、钩子怎么说、答「同意」放行', q?.text?.slice(0, 200));
  f.db.run(`INSERT INTO answers (id,question_id,user_id,body,stance,created_at) VALUES (?,?,?,?,?,?)`, newId('a'), q.id, f.userId, '同意，发吧', 'answer', now());
  f.db.run(`UPDATE nodes SET status='pending' WHERE id=?`, f.nodeId); f.db.run(`UPDATE tasks SET status='running' WHERE id=?`, f.taskId);
  const a2 = await run(f.db, f.taskId, f.nodeId, r2.ws, script, 'e5b2');
  assert(!/要人确认/.test(seen.at(-1) ?? '') && /exit=/.test(seen.at(-1) ?? ''), '答了「同意」：同一条调用放行、照常执行', seen.at(-1)?.slice(0, 200));
  eq(a2.kind, 'done', '之后照常交接');
  eq(q.decision_type, 'security', '钩子要确认的事项是「安全审批」（原来按规格取舍派人）');
  eq(q.default_action, null, '安全审批不带默认：不会 8 小时后被超时替人"不同意"');
}

section('③′ 审批门禁：负责人列的命令模式，命中就停下挂安全审批；答「同意」放行这一条；包一层 sh -c 也拦得住');
{
  eq(gateHit(['git push*'], 'git', ['push', 'origin', 'main']), 'git push*', '整行命中');
  eq(gateHit(['*migrate*'], 'npx', ['prisma', 'migrate', 'deploy']), '*migrate*', '通配');
  eq(gateHit(['git push*'], 'sh', ['-c', 'npm test && git push origin main']), 'git push*', 'sh -c 里用 && 连起来的那一段也比');
  eq(gateHit(['git push*'], 'git', ['status']), null, '没命中');
  eq(gateHit([], 'git', ['push']), null, '清单为空：什么都不拦');
  const r = repo('gate');
  r.put('src/.keep', '');
  const head = r.commit();
  const f = fixture(r.ws, head);
  const P = newId('p');
  f.db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'P','/r','b','main','active',?)`, P, f.userId, now());
  f.db.run(`UPDATE tasks SET project_id=? WHERE id=?`, P, f.taskId);
  rejects(() => setGates(f.db, { projectId: P, commands: ['*'], userId: f.userId }), '只写「*」：拒（AI 会什么都做不了）', /会拦下每一条命令/);
  setGates(f.db, { projectId: P, commands: ['node -e *exit*'], userId: f.userId });
  rejects(() => setGates(f.db, { projectId: P, commands: ['x*'], userId: f.userId, expect: [] }), '打开页面后别人改过：409 说清', /没有保存：.*审批门禁/);
  const seen = [];
  const script = (canon, i) => {
    if (i === 0) return call('run_command', { file: 'node', args: ['-e', 'process.exit(0)'] });
    if (i === 1) { seen.push(lastResults(canon)); return call('run_command', { file: 'node', args: ['-e', '1'] }); }
    if (i === 2) { seen.push(lastResults(canon)); return call('write_file', { path: 'src/add.js', content: 'x\n' }); }
    return call('submit_handoff', HANDOFF(['src/add.js']));
  };
  const a1 = await run(f.db, f.taskId, f.nodeId, r.ws, script, 'gate1');
  eq(a1.kind, 'question', '命中门禁：挂事项，本节点挂起，命令没跑');
  const q = f.db.one(`SELECT * FROM questions WHERE id=?`, a1.question?.id ?? '');
  eq([q?.decision_type, q?.default_action, q?.level], ['security', null, 2], '安全审批、没有默认、Ⅱ 级（到期升级再喊一次，不替人定）');
  assert(/命中审批门禁/.test(q?.text ?? '') && q.text.includes('node -e *exit*') && q.text.includes('process.exit(0)'), '正文：哪条命令、命中哪条门禁、答「同意」放行', q?.text?.slice(0, 200));
  f.db.run(`INSERT INTO answers (id,question_id,user_id,body,stance,created_at) VALUES (?,?,?,?,?,?)`, newId('a'), q.id, f.userId, '同意', 'answer', now());
  f.db.run(`UPDATE nodes SET status='pending' WHERE id=?`, f.nodeId); f.db.run(`UPDATE tasks SET status='running' WHERE id=?`, f.taskId);
  const a2 = await run(f.db, f.taskId, f.nodeId, r.ws, script, 'gate2');
  assert(/exit=0/.test(seen.at(-2) ?? ''), '答了「同意」：这条命令放行、照常执行', seen.at(-2)?.slice(0, 120));
  assert(/exit=0/.test(seen.at(-1) ?? ''), '没命中门禁的命令照常跑', seen.at(-1)?.slice(0, 120));
  eq(a2.kind, 'done', '之后照常交接');
}

// ── 合并前 / 交付前：真项目、真合并、真推送；仓库钩子用宿主执行器代替沙箱 ──
const PHOME = join(TMP, 'phome');
const pdb = openDb(':memory:');
const powner = ensureOwner(pdb);
const LOCAL = async () => new LocalExecutor();
const gitOut = (cwd, ...a) => git(cwd, ...a).stdout.trim();
/** 源仓库（带 files 里的钩子配置 / 脚本）→ 建项目 → T1 在工作区提交 change 里的文件 → done + 签收。 */
let nProj = 0;
function signedProject(files, change) {
  const src = repo(`psrc${++nProj}`);
  src.put('README.md', '# demo\n');
  for (const [k, v] of Object.entries(files)) src.put(k, v);
  src.commit();
  const P = createProject(pdb, { userId: powner.userId, spec: { title: `钩子项目${nProj}`, tasks: [{ title: 'T1', goal: 'g', definition_of_done: 'd', verify_command: 'node -e 0' }] }, source: src.ws, home: PHOME });
  const t1 = P.taskIds[0];
  const ws = join(PHOME, 'workspaces', t1);
  for (const [k, v] of Object.entries(change)) put(ws, k, v);
  git(ws, 'add', '-A'); git(ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'T1');
  pdb.run(`UPDATE tasks SET status='done' WHERE id=?`, t1);
  audit(pdb, { actorKind: 'system', action: 'task_done', targetType: 'task', targetId: t1, payload: { head: gitOut(ws, 'rev-parse', 'HEAD') } });
  signOff(pdb, { taskId: t1, accept: true, plaintextToken: powner.plaintext, userId: powner.userId });
  return { P, t1, ws };
}
const advance = (P) => advanceProject(pdb, { projectId: P.projectId, home: PHOME, userId: powner.userId, makeExec: LOCAL });
const answer = (qid, text) => recordAnswer(pdb, { questionId: qid, body: text, plaintextToken: powner.plaintext });
// 钩子脚本：changed_files 里有 secret.txt 就拦；有 publish.txt 就要人确认
const MERGE_GUARD = SCRIPT(`const f=j.changed_files||[];if(f.includes('secret.txt')){process.stderr.write('不许提交 secret.txt');process.exit(2)}if(f.includes('publish.txt'))console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'要发布，先看一眼'}}))`);
const REPO_HOOKS = (event) => ({ '.superintern/hooks/guard.mjs': MERGE_GUARD, '.superintern/hooks.json': JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: 'command', command: 'node .superintern/hooks/guard.mjs' }] }] } }) });

section('⑥ PreMerge：仓库钩子从项目分支读；拦下 / 要人确认 → 【合并卡住】事项；同意放行这一版；改了钩子文件先问；fail-closed');
{
  // 放行
  let { P, t1 } = signedProject(REPO_HOOKS('PreMerge'), { 'app.mjs': 'export const x = 1;\n' });
  let r = await advance(P);
  assert(/^merged/.test(r.reason), '钩子放行：照常合并', r.reason);
  eq(pdb.one(`SELECT payload FROM audit_log WHERE action='hook_decision' AND target_id=?`, t1), undefined, '放行不记 hook_decision（只记拦下 / 要确认）');

  // 拦下
  ({ P, t1 } = signedProject(REPO_HOOKS('PreMerge'), { 'secret.txt': 'k\n' }));
  r = await advance(P);
  eq(r.reason, 'merge_hook_deny', '钩子拦下：不合并');
  eq(pdb.one(`SELECT merged_at FROM tasks WHERE id=?`, t1).merged_at, null, '项目分支没动');
  let q = pdb.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  assert(q && q.text.startsWith('【合并卡住】') && q.text.includes('不许提交 secret.txt') && !q.text.includes('回「同意」'), '事项：标记 + 钩子的理由；拦下的不给"同意"这条路', q?.text?.slice(0, 300));
  eq((await advance(P)).reason, 'waiting:merge_hook', '事项开着时安静地等，不每拍重跑');
  let res = answer(q.id, '按钩子改');
  eq(res.hook?.kind, 'merge_hook', '答复交回钩子接住');
  assert(pdb.one(`SELECT 1 FROM messages WHERE task_id=? AND kind='correction' AND body LIKE '%不许提交 secret.txt%'`, t1), '修正交给 AI，带上钩子的输出');

  // 要人确认 → 同意 → 合并
  ({ P, t1 } = signedProject(REPO_HOOKS('PreMerge'), { 'publish.txt': 'v1\n' }));
  r = await advance(P);
  eq(r.reason, 'merge_hook_ask', '要人确认：先不合并');
  q = pdb.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  assert(q.text.includes('要发布，先看一眼') && q.text.includes('回「同意」'), '事项：钩子的话 + 回「同意」放行', q.text.slice(0, 300));
  res = answer(q.id, '同意');
  eq([res.hook?.approved, pdb.one(`SELECT 1 x FROM messages WHERE task_id=? AND kind='correction'`, t1)], [true, undefined], '「同意」：记下放行，不生成修正');
  assert(/^merged/.test((await advance(P)).reason), '下一拍：这一版放行，合并');

  // 任务改了钩子文件 → 不跑仓库钩子、先问；同意后照改过的版本跑（新版本说拦就拦）
  const files = REPO_HOOKS('PreMerge');
  ({ P, t1 } = signedProject(files, { '.superintern/hooks/guard.mjs': SCRIPT(`process.stderr.write('新版本：一律不许');process.exit(2)`) }));
  r = await advance(P);
  eq(r.reason, 'merge_hook_ask', '改了钩子文件：要人确认');
  q = pdb.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  assert(q.text.includes('改了策略钩子文件') && q.text.includes('.superintern/hooks/guard.mjs'), '事项点名改了哪个钩子文件', q.text.slice(0, 300));
  answer(q.id, '同意');
  r = await advance(P);
  eq(r.reason, 'merge_hook_deny', '同意之后照任务里的新版本跑：新版本拦下');

  // fail-closed：宿主上的项目钩子没信任 / 出错 → 拦
  ({ P, t1 } = signedProject({}, { 'app.mjs': 'x\n' }));
  const pfile = join(PHOME, 'projects', P.projectId, 'hooks.json');
  put(PHOME, `projects/${P.projectId}/boom.mjs`, 'process.exit(1)\n');
  writeFileSync(pfile, JSON.stringify({ hooks: { PreMerge: [{ hooks: [{ type: 'command', command: `node ${join(PHOME, 'projects', P.projectId, 'boom.mjs')}` }] }] } }));
  r = await advance(P);
  eq(r.reason, 'merge_hook_failed', '宿主钩子没核准：合并前一律拦（fail-closed），不像工具前那样放行；记成"钩子自己没跑成"');
  q = pdb.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  assert(q.text.includes('hook trust') && q.text.includes('自己没跑成') && !q.text.includes('让 AI 按钩子说的改'), '事项：说清是钩子坏了、怎么核准；不给"让 AI 改"这条路（AI 改不了钩子）', q.text.slice(0, 300));
  trustHostHooks(pdb, { projectId: P.projectId, userId: powner.userId });
  res = answer(q.id, '重试');
  eq([res.hook?.retry, pdb.one(`SELECT 1 x FROM messages WHERE task_id=? AND kind='correction'`, t1)], [true, undefined], '答一句：重新检查，不生成修正');
  r = await advance(P);
  eq(r.reason, 'merge_hook_failed', '核准了但脚本退出码 1：还是"钩子自己出错"，不是拦下');
  writeFileSync(join(PHOME, 'projects', P.projectId, 'boom.mjs'), 'process.exit(0)\n');
  trustHostHooks(pdb, { projectId: P.projectId, userId: powner.userId });
  answer(r.questionId, '修好了');
  assert(/^merged/.test((await advance(P)).reason), '修好钩子、重新核准、答一句：合并');
}

section('⑦ PreDeliver：拦下 → 报错不推；要人确认 → 带确认码再交付；理由变了确认码作废；项目交付在干净克隆上跑');
{
  const bare = (name) => { const d = join(TMP, name); mkdirSync(d); git(d, 'init', '-q', '--bare'); return d.split('\\').join('/'); };
  const branches = (d) => gitOut(d, 'branch', '--list');
  const tryDeliver = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  // 任务交付：仓库钩子从任务开工时的基线读
  let { P, t1, ws } = signedProject(REPO_HOOKS('PreDeliver'), { 'publish.txt': 'v1\n' });
  let remote = bare('remote-t');
  const dt = (hookAck) => deliverTask(pdb, { taskId: t1, workspace: ws, remote, userId: powner.userId, makeExec: LOCAL, hookAck });
  let err = await tryDeliver(() => dt([]));
  assert(err?.hookAsk && /要发布，先看一眼/.test(err.message), '要人确认：报错带确认码与钩子的话', err?.message);
  eq(branches(remote), '', '没有推送');
  eq(!!(await tryDeliver(() => dt(['不对的码'])))?.hookAsk, true, '确认码对不上：照样要确认');
  const d = await dt([err.hookAsk]);
  eq(gitOut(remote, 'rev-parse', d.branch), d.head, '带上确认码：推送成功');
  assert(pdb.one(`SELECT 1 FROM audit_log WHERE action='deliver_hook_acked' AND target_id=?`, t1), '确认进审计');
  assert(/^merged/.test((await advance(P)).reason), '合并（推到本机项目仓库，internal）不过交付前钩子');

  // 拦下：确认码不放行拦下的
  ({ P, t1, ws } = signedProject(REPO_HOOKS('PreDeliver'), { 'secret.txt': 'k\n' }));
  remote = bare('remote-t2');
  err = await tryDeliver(() => dt([]));
  assert(err?.hookDeny && /不许提交 secret\.txt/.test(err.message) && !err.hookAsk, '拦下：报错，没有确认码可给', err?.message);
  eq(branches(remote), '', '没有推送');

  // 任务改了钩子文件：先问"改了钩子文件"，确认后照新版本跑（新版本又要确认 → 再问一次，码不同）
  ({ P, t1, ws } = signedProject(REPO_HOOKS('PreDeliver'), { '.superintern/hooks/guard.mjs': SCRIPT(`console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'新版本也要问'}}))`) }));
  remote = bare('remote-t3');
  const e1 = await tryDeliver(() => dt([]));
  assert(e1?.hookAsk && /改了策略钩子文件/.test(e1.message), '第一问：改了钩子文件', e1?.message);
  const e2 = await tryDeliver(() => dt([e1.hookAsk]));
  assert(e2?.hookAsk && e2.hookAsk !== e1.hookAsk && /新版本也要问/.test(e2.message), '确认后照新版本跑：新版本要确认 → 第二问，码不同', e2?.message);
  await dt([e1.hookAsk, e2.hookAsk]);
  assert(branches(remote).length > 0, '两条都确认：推送');

  // 项目交付 ①：仓库钩子在项目分支的干净克隆上跑（secret.txt 合进项目分支之后，交付前拦下）
  ({ P, t1, ws } = signedProject(REPO_HOOKS('PreDeliver'), { 'secret.txt': 'k\n' }));
  const done = async () => { for (let i = 0; i < 3 && pdb.one(`SELECT status FROM projects WHERE id=?`, P.projectId).status !== 'done'; i++) await advance(P); return pdb.one(`SELECT status FROM projects WHERE id=?`, P.projectId).status; };
  eq(await done(), 'done', '（合并照常，项目完成）');
  let premote = bare('remote-p1');
  const dp = (hookAck) => deliverProject(pdb, { projectId: P.projectId, remote: premote, userId: powner.userId, home: PHOME, makeExec: LOCAL, hookAck });
  err = await tryDeliver(() => dp([]));
  assert(err?.hookDeny && /不许提交 secret\.txt/.test(err.message), '项目交付：仓库钩子拦下', err?.message);
  eq(existsSync(join(PHOME, 'hookrun', P.projectId)), false, '克隆跑完删掉');
  eq(branches(premote), '', '没有推送');

  // 项目交付 ②：宿主上的项目钩子（信任过）要人确认；钩子说的变了，旧确认码作废
  ({ P, t1, ws } = signedProject({}, { 'app.mjs': 'x\n' }));
  eq(await done(), 'done', '（项目完成）');
  premote = bare('remote-p2');
  const dir = join(PHOME, 'projects', P.projectId);
  put(PHOME, `projects/${P.projectId}/note.txt`, '第一版说法');
  put(PHOME, `projects/${P.projectId}/ask.mjs`, SCRIPT(`const n=require('fs').readFileSync(${JSON.stringify(join(dir, 'note.txt'))},'utf8');console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:j.target+'：'+n}}))`).replace('let s', 'const require=process.getBuiltinModule;let s'));
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PreDeliver: [{ hooks: [{ type: 'command', command: `node ${join(dir, 'ask.mjs')}` }] }] } }));
  trustHostHooks(pdb, { projectId: P.projectId, userId: powner.userId });
  err = await tryDeliver(() => dp([]));
  assert(err?.hookAsk && /project：第一版说法/.test(err.message), '宿主钩子要人确认（钩子拿到了 target=project）', err?.message);
  writeFileSync(join(dir, 'note.txt'), '第二版说法');
  const err2 = await tryDeliver(() => dp([err.hookAsk]));
  assert(err2?.hookAsk && err2.hookAsk !== err.hookAsk, '钩子说的变了：旧确认码作废，再问', err2?.message);
  const r = await dp([err2.hookAsk]);
  eq(gitOut(premote, 'rev-parse', r.branch), r.head, '确认这一版：推送成功');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
