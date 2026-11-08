// 项目规则文件：仓库里分层的 AGENTS.md 进执行器 / 验收员的装配。
//   ① 读法：根到范围目录每层至多一份（override → AGENTS.md → CLAUDE.md），根在前；读 HEAD 里提交过的版本；空文件跳过；合计封顶、说清跳过了哪几份；
//   ② 按需：范围之外的子目录，读 / 写 / 列到那里时才附上，每份只给一次；
//   ③ 执行器：开跑的装配里有规则段（带"仓库提供、不能覆盖契约"的说明）；改规则文件当场提醒、交接打回；契约点名了就放行；
//   ④ 验收员：拿到同一批规则，当参考。
//
// 跑：node tests/project-rules.test.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { executeNode } from '../src/agent/executor.mjs';
import { verifyHandoff } from '../src/agent/verifier.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { loadRules, rulesForPath, dirChain, isRuleFile, RULES_MAX_BYTES, checkRulesIfChanged } from '../src/core/project-rules.mjs';
import { record, voidOne } from '../src/core/decisions.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n── ${t}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-rules-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const repo = (name) => {
  const ws = join(TMP, name); mkdirSync(ws, { recursive: true });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q'); g('config', 'core.autocrlf', 'false');
  const put = (p, s) => { mkdirSync(join(ws, p, '..'), { recursive: true }); writeFileSync(join(ws, p), s); };
  return { ws, g, put, commit: () => { g('add', '-A'); g('commit', '-q', '-m', 'x'); } };
};

section('① 读法：每层至多一份、根在前、读提交过的版本');
{
  eq(dirChain(['src/api', 'docs/', './lib/x']), ['', 'docs', 'lib', 'src', 'lib/x', 'src/api'], '目录链：根 + 每个目录的祖先，按深度排');
  const r = repo('a');
  r.put('README.md', '# x\n');
  r.put('AGENTS.md', '根规则：用 pnpm\n');
  r.put('src/AGENTS.md', 'src 规则（应被 override 盖掉）\n');
  r.put('src/AGENTS.override.md', 'src 覆盖规则：用 tabs\n');
  r.put('src/api/CLAUDE.md', 'api 后备规则：接口都要有测试\n');
  r.put('src/empty/AGENTS.md', '   \n');
  r.put('other/AGENTS.md', '范围外的规则\n');
  r.commit();
  r.put('AGENTS.md', '没提交的改动，不该读到\n');
  const L = loadRules(r.ws, ['src/api', 'src/empty']);
  eq(L.files.map((f) => f.path), ['AGENTS.md', 'src/AGENTS.override.md', 'src/api/CLAUDE.md'], '每层一份：override 优先于 AGENTS.md，CLAUDE.md 是后备；空文件跳过；范围外的不读');
  eq(L.files[0].text, '根规则：用 pnpm\n', '读的是 HEAD 里提交过的版本，不是工作区里没提交的');
  assert(isRuleFile('a/b/AGENTS.md') && isRuleFile('CLAUDE.md') && !isRuleFile('AGENTS.md.bak'), 'isRuleFile 认三个文件名');

  const big = repo('big');
  big.put('AGENTS.md', 'x'.repeat(RULES_MAX_BYTES - 10));
  big.put('pkg/AGENTS.md', 'y'.repeat(100));
  big.commit();
  const B = loadRules(big.ws, ['pkg']);
  eq([B.files.map((f) => f.path), B.skipped.map((s) => s.path)], [['pkg/AGENTS.md'], ['AGENTS.md']], '合计超过 32 KiB：先保住离要改的文件最近的那层（不像 Codex 截掉最具体的），记下跳过了哪几份');
  const three = repo('three');
  three.put('AGENTS.md', 'r'.repeat(100)); three.put('a/AGENTS.md', 'x'.repeat(RULES_MAX_BYTES - 80)); three.put('a/b/AGENTS.md', 'z'.repeat(40)); three.commit();
  const T3 = loadRules(three.ws, ['a/b']);
  eq([T3.files.map((f) => f.path), T3.skipped.map((s) => s.path)], [['a/AGENTS.md', 'a/b/AGENTS.md'], ['AGENTS.md']], '三层：从深往浅装，放进来的仍按根在前排');
  eq(loadRules(join(TMP, 'nope'), ['x']).files.length, 0, '工作区不存在：没有规则，不报错');
}

section('② 按需：范围外的子目录读 / 列到时才附上，每份只给一次');
{
  const r = repo('b');
  r.put('AGENTS.md', '根\n'); r.put('lib/AGENTS.md', 'lib 规则\n'); r.put('lib/x.js', '1\n'); r.commit();
  const seen = new Set(['AGENTS.md']);
  eq(rulesForPath(r.ws, 'lib/x.js', seen).map((f) => f.path), ['lib/AGENTS.md'], '读 lib/x.js：附上 lib/AGENTS.md（根那份已给过，不再给）');
  eq(rulesForPath(r.ws, 'lib', seen).length, 0, '再碰 lib：不重复给');
  eq(rulesForPath(r.ws, '../etc/passwd', seen).length, 0, '越出工作区的路径不处理');
}

// ── 执行器夹具 ──
function fixture(ws, scope) {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'加 add()',?,'npm test 通过','[]',?,?)`, newId('c'), taskId, scope, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写 add','src/add.js 导出 add','node -e 能调用','pending','normal','standard',?)`, nodeId, taskId, t);
  return { db, taskId, nodeId };
}
const call = (name, args) => ({ stopReason: 'tool_call', usage: { inputTokens: 10, outputTokens: 5 },
  content: [{ type: 'tool_call', id: `c_${Math.random().toString(36).slice(2, 8)}`, name, args }] });
const HANDOFF = (paths) => ({ artifacts: paths.map((path) => ({ path, kind: 'code' })), interface_contract: 'add(a,b)', acceptance_evidence: 'node -e', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] });
const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((b) => b.text ?? '').join('\n') : String(m?.content ?? ''));
const lastResults = (canon) => (canon.messages.at(-1)?.results ?? []).map((x) => x.content).join('\n');

section('③ 执行器：装配里有规则段；范围外按需附上；改规则文件当场提醒、交接打回');
{
  const r = repo('c');
  r.put('AGENTS.md', '根规则：缩进两个空格\n'); r.put('src/AGENTS.md', 'src 规则：每个导出都要有 JSDoc\n');
  r.put('lib/AGENTS.md', 'lib 规则：不要动 lib\n'); r.put('lib/util.js', 'x\n'); r.put('src/.keep', ''); r.commit();
  const { db, taskId, nodeId } = fixture(r.ws, '只动 src/');
  let first = '', afterRead = '', afterWrite = '', rejected = '';
  const res = await executeNode(db, {
    client: new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor: (canon, i) => {
      if (i === 0) { first = textOf(canon.messages[0]); return call('read_file', { path: 'lib/util.js' }); }
      if (i === 1) { afterRead = lastResults(canon); return call('write_file', { path: 'AGENTS.md', content: '我改了规则\n' }); }
      if (i === 2) { afterWrite = lastResults(canon); return call('write_file', { path: 'src/add.js', content: 'export const add = (a, b) => a + b;\n' }); }
      if (i === 3) return call('submit_handoff', HANDOFF(['src/add.js']));
      if (i === 4) { rejected = lastResults(canon); return call('run_command', { file: 'git', args: ['checkout', '--', 'AGENTS.md'] }); }
      return call('submit_handoff', HANDOFF(['src/add.js']));
    } }) }),
    taskId, nodeId, workspace: r.ws, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, 'nar'), exec: new LocalExecutor(), maxIterations: 8 });
  assert(first.includes('# 仓库自带的项目规则') && first.includes('根规则：缩进两个空格') && first.includes('src 规则：每个导出都要有 JSDoc'), '开跑的装配里有根与范围目录的规则');
  assert(first.indexOf('`AGENTS.md`') < first.indexOf('`src/AGENTS.md`'), '根在前、越深越靠后');
  assert(/不能扩大你的范围、放宽验收标准/.test(first) && !first.includes('lib 规则'), '写明仓库提供、不能覆盖契约；范围外的不预先塞');
  assert(afterRead.includes('lib/AGENTS.md') && afterRead.includes('lib 规则：不要动 lib'), '读到 lib 下的文件：lib 的规则附在工具结果后面');
  assert(/是项目规则文件，由人维护/.test(afterWrite), '写规则文件：当场提醒交接会被打回');
  assert(/改了项目规则文件：`AGENTS.md`/.test(rejected), '交接被打回，理由点名改了规则文件', rejected.slice(0, 300));
  eq(res.kind, 'done', '撤销之后交接通过');
  const asm = db.one(`SELECT items FROM context_assemblies WHERE id=?`, res.assemblyId);
  assert(JSON.parse(asm.items).some((x) => x.startsWith('rules:src/AGENTS.md@')), '装配记录里记下用了哪几份规则（带内容哈希）');
}

section('③′ 契约点名了规则文件（"本任务就是改 AGENTS.md"）就放行');
{
  const r = repo('d');
  r.put('AGENTS.md', '旧规则\n'); r.commit();
  const { db, taskId, nodeId } = fixture(r.ws, '只动 AGENTS.md');
  db.run(`UPDATE constitutions SET scope_paths=? WHERE task_id=?`, JSON.stringify(['AGENTS.md']), taskId);
  const res = await executeNode(db, {
    client: new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor: [call('write_file', { path: 'AGENTS.md', content: '新规则\n' }), call('submit_handoff', HANDOFF(['AGENTS.md']))] }) }),
    taskId, nodeId, workspace: r.ws, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, 'nar2'), exec: new LocalExecutor(), maxIterations: 4 });
  eq([res.kind, res.rejections.length], ['done', 0], '结构化范围点名了 AGENTS.md：不打回');
}

section('④ 验收员：拿到同一批规则，当参考');
{
  const r = repo('e');
  r.put('AGENTS.md', '根规则：测试用 node --test\n'); r.put('src/add.js', 'x\n'); r.commit();
  const { db, taskId, nodeId } = fixture(r.ws, '只动 src/');
  let seen = '';
  await verifyHandoff(db, {
    client: new LlmClient({ mode: 'fake', fake: makeRoleFake({ verifier: (canon) => { seen = textOf(canon.messages[0]); return call('submit_verdict', { verdict: 'pass', reasons: ['ok'], defects: [] }); } }) }),
    taskId, nodeId, workspace: r.ws, exec: new LocalExecutor(), args: HANDOFF(['src/add.js']), changed: new Set(['src/add.js']) });
  assert(seen.includes('# 仓库自带的项目规则（参考）') && seen.includes('根规则：测试用 node --test'), '验收员的提示里有规则段');
  assert(/以节点规格、验收标准和人的裁定为准/.test(seen), '写明以规格为准，规则只作参考');
}

section('⑤ 与已定的约定比对：变了才比；冲突交负责人；同一项目只比一次');
{
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const T0 = now();
  const pj = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,goal,done_definition,created_at)
          VALUES (?,?,'订单服务','',?,?,'base','src','active','g','d',?)`, pj, owner.userId, `/r/${pj}`, `b/${pj}`, T0);
  const mkT = () => {
    const id = newId('t');
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'任务','running',?,?,1)`, id, owner.userId, T0, pj);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), id, T0, T0);
    return id;
  };
  const t1 = mkT(), t2 = mkT();
  const dr = record(db, { projectId: pj, taskId: t1, subject: '错误码前缀', statement: '错误码一律用 ERR_ 前缀', sourceKind: 'question', decidedBy: owner.userId, at: T0 });
  const r = repo('f');
  r.put('AGENTS.md', '错误码一律用数字，不要前缀\n'); r.commit();
  const calls = [];
  const hitResp = { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, content: [{ type: 'text', text: JSON.stringify({ hits: [{ id: dr, quote: '错误码一律用数字', why: '与 ERR_ 前缀不能同时成立', confidence: 0.9 }] }) }] };
  const noneResp = { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, content: [{ type: 'text', text: '{"hits":[]}' }] };
  const mk = (reply) => () => new LlmClient({ mode: 'fake', fake: makeRoleFake({ 'decision-check': (canon) => { calls.push(canon.messages[0].content[0].text); return reply; } }) });

  const a = await checkRulesIfChanged(db, { taskId: t1, workspace: r.ws, makeClient: mk(hitResp) });
  eq(calls.length, 1, '第一次：比了一次');
  assert(/仓库里的项目规则文件/.test(calls[0]) && calls[0].includes('错误码一律用数字'), '比对器拿到的是规则文件原文，并知道它来自仓库');
  const q = db.one(`SELECT * FROM questions WHERE id=?`, a?.raised?.[0]?.questionId ?? '');
  assert(q && JSON.parse(q.addressed_to).includes(owner.userId), '冲突事项交给负责人');
  assert(q && /规则文件里写的/.test(q.text) && /项目设置 → 项目规则/.test(q.text), '正文写明是规则文件、选 (B) 之后怎么办', q?.text?.slice(0, 300));

  await checkRulesIfChanged(db, { taskId: t1, workspace: r.ws, makeClient: mk(noneResp) });
  await checkRulesIfChanged(db, { taskId: t2, workspace: r.ws, makeClient: mk(noneResp) });
  eq(calls.length, 1, '规则与约定都没变：同一任务、同一项目的另一个任务都不再比');

  r.put('AGENTS.md', '错误码一律用数字，不要前缀；日志用 JSON\n'); r.commit();
  await checkRulesIfChanged(db, { taskId: t2, workspace: r.ws, makeClient: mk(noneResp) });
  eq(calls.length, 2, '规则文件改过（新提交）：再比一次');

  record(db, { projectId: pj, taskId: t1, subject: '日志格式', statement: '日志一律纯文本', sourceKind: 'question', decidedBy: owner.userId, at: T0 });
  await checkRulesIfChanged(db, { taskId: t2, workspace: r.ws, makeClient: mk(noneResp) });
  eq(calls.length, 3, '有了新约定：规则再比一次（新约定的比对只看别的约定，不看规则文件）');

  r.put('AGENTS.md', '又改了\n'); r.commit();
  const broke = await checkRulesIfChanged(db, { taskId: t2, workspace: r.ws, makeClient: () => new LlmClient({ mode: 'fake', fake: makeRoleFake({ 'decision-check': () => new Error('厂商挂了') }) }) });
  eq(broke?.skipped, 'failed', '比对器出错：不抛、不拦');
  await checkRulesIfChanged(db, { taskId: t2, workspace: r.ws, makeClient: mk(noneResp) });
  eq(calls.length, 4, '出错那次不记"比过了"，下一步再比');
  voidOne(db, { id: dr, by: owner.userId, reason: 'x' });
  const none = repo('g');
  eq(await checkRulesIfChanged(db, { taskId: t2, workspace: none.ws, makeClient: mk(noneResp) }), null, '仓库没有规则文件：什么都不做');
}

section('⑥ 看板编辑：提交到项目分支、防覆盖、限路径与大小、合并时让开；看得见的人能看，只有负责人能改');
{
  const { initProjectRepo } = await import('../src/core/project.mjs');
  const { listProjectRules, writeProjectRule } = await import('../src/core/project-rules.mjs');
  const { acquireLease, releaseLease } = await import('../src/db/lease.mjs');
  const { addUser } = await import('../src/core/users.mjs');
  const { startWeb } = await import('../src/web/server.mjs');
  const HOME = join(TMP, 'home6');
  const db = openDb(join(TMP, 'six.db'));
  const owner = ensureOwner(db);
  db.run(`UPDATE users SET display_name='负责人' WHERE id=?`, owner.userId);
  const pid = newId('pj');
  const { repo: prepo, branch, baseRef } = initProjectRepo({ home: HOME, projectId: pid, empty: true });
  db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at,source) VALUES (?,?,'P',?,?,?,'active',?,NULL)`, pid, owner.userId, prepo, branch, baseRef, now());

  eq(listProjectRules(db, { projectId: pid }).length, 0, '新项目：还没有规则文件');
  const w1 = writeProjectRule(db, { projectId: pid, path: 'AGENTS.md', text: '用 pnpm\r\n', base: null, userId: owner.userId });
  let files = listProjectRules(db, { projectId: pid });
  eq([files.length, files[0]?.path, files[0]?.text, files[0]?.author], [1, 'AGENTS.md', '用 pnpm\n', '负责人'], '新建：提交到项目分支，作者是改的人，行尾统一成 LF');
  eq(execFileSync('git', ['log', '-1', '--format=%s', branch], { cwd: prepo, encoding: 'utf8' }).trim(), '新建项目规则文件 AGENTS.md（看板）', '提交说明写清做了什么');
  assert(w1.commit && execFileSync('git', ['status', '--porcelain'], { cwd: prepo, encoding: 'utf8' }).trim() === '', '项目仓库提交后是干净的');

  const stale = files[0].sha;
  writeProjectRule(db, { projectId: pid, path: 'AGENTS.md', text: '用 pnpm；测试 node --test\n', base: stale, userId: owner.userId });
  let err = null; try { writeProjectRule(db, { projectId: pid, path: 'AGENTS.md', text: '我的版本\n', base: stale, userId: owner.userId }); } catch (e) { err = e; }
  assert(err && /被改过/.test(err.message), '打开之后别人改过：拒绝保存，不悄悄盖掉', err?.message);

  writeProjectRule(db, { projectId: pid, path: 'api/AGENTS.md', text: 'api 规则\n', base: null, userId: owner.userId });
  writeProjectRule(db, { projectId: pid, path: 'api/CLAUDE.md', text: 'api 后备\n', base: null, userId: owner.userId });
  files = listProjectRules(db, { projectId: pid });
  eq(files.map((f) => [f.path, f.shadowedBy]), [['AGENTS.md', null], ['api/AGENTS.md', null], ['api/CLAUDE.md', 'api/AGENTS.md']], '按深度排；同一目录里只读优先的那份，另一份标出来');
  let dup = null; try { writeProjectRule(db, { projectId: pid, path: 'api/AGENTS.md', text: '重复新建\n', base: null, userId: owner.userId }); } catch (e) { dup = e; }
  assert(dup && /已经有了/.test(dup.message), '新建一份已经有的：说"已经有了、去点编辑"，不说"被改过"', dup?.message);

  const bads = [['src/x.md', '只能编辑项目规则文件'], ['../AGENTS.md', '只能编辑项目规则文件'], ['.git/AGENTS.md', '只能编辑项目规则文件']];
  for (const [p, re] of bads) { let e2 = null; try { writeProjectRule(db, { projectId: pid, path: p, text: 'x', base: null, userId: owner.userId }); } catch (e) { e2 = e; } assert(e2 && e2.message.includes(re), `拒绝路径 ${p}`, e2?.message); }
  let big = null; try { writeProjectRule(db, { projectId: pid, path: 'lib/AGENTS.md', text: 'x'.repeat(RULES_MAX_BYTES + 1), base: null, userId: owner.userId }); } catch (e) { big = e; }
  assert(big && /KiB/.test(big.message), '超过 32 KiB 拒绝（AI 读不到那么多）');

  const l = acquireLease(db, `project:${pid}`, { ttlMs: 60_000, meta: { pid: 1, op: 'advance' } });
  db.run(`UPDATE leases SET holder='someone-else' WHERE resource=?`, `project:${pid}`);
  let busy = null; try { writeProjectRule(db, { projectId: pid, path: 'api/CLAUDE.md', text: 'y\n', base: files[2].sha, userId: owner.userId }); } catch (e) { busy = e; }
  assert(busy && /正在把任务合进/.test(busy.message), '推进正持有项目租约：让开，说清稍后再存', busy?.message);
  db.run(`DELETE FROM leases WHERE resource=?`, `project:${pid}`); void l; void releaseLease;

  writeProjectRule(db, { projectId: pid, path: 'api/CLAUDE.md', text: null, base: files[2].sha, userId: owner.userId });
  eq(listProjectRules(db, { projectId: pid }).map((f) => f.path), ['AGENTS.md', 'api/AGENTS.md'], '删除：提交一次删除');
  eq(loadRules(prepo, ['api']).files.map((f) => f.path), ['AGENTS.md', 'api/AGENTS.md'], '从项目分支起的工作区读到的就是这些');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_rules_edited' AND target_id=?`, pid).n, 5, '每次改动进审计');

  const member = addUser(db, { name: '阿青', role: 'member', byUserId: owner.userId });
  const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 1000 });
  try {
    const base = `http://127.0.0.1:${w.port}`;
    const g = await fetch(`${base}/api/projects/${pid}/rules`, { headers: { 'x-superintern-token': owner.plaintext } }).then((r) => r.json());
    eq([g.files?.length, g.canEdit], [2, true], 'GET：负责人看到两份、可以改');
    const gm = await fetch(`${base}/api/projects/${pid}/rules`, { headers: { 'x-superintern-token': member.plaintext } }).then((r) => r.json());
    eq(gm.canEdit, false, 'GET：成员能看、不能改');
    const pm = await fetch(`${base}/api/projects/${pid}/rules`, { method: 'POST', headers: { 'x-superintern-token': member.plaintext, 'content-type': 'application/json' }, body: JSON.stringify({ path: 'AGENTS.md', text: 'hack', base: g.files[0].sha }) });
    eq(pm.status, 403, 'POST：成员改不了');
  } finally { await w.close(); }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
