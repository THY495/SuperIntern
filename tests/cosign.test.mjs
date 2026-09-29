// 方案会签 / 分段批准
//
// 跑：node tests/cosign.test.mjs
//
// 起因：方案原来全由负责人一个人批；团队分工成"一人管界面、一人管后端、负责人把最后一道"时，方案批准要能按段送人、
// 几个人一起批。路由表本来就支持范围前缀 + 法定人数 all，缺两样：① 批准事项的前缀取自方案里各任务的范围；
// ② 几个人的答复按判读方向归并 —— 原来按文字归并，一个回"A"、一个回"A 保留：…"就生成一条冲突事项。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { planProject, startProjectFromBrief } from '../src/agent/project-planner.mjs';
import { answerOf } from '../src/agent/elicitor.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import { addUser } from '../src/core/users.mjs';
import { rulesOf, saveRules, specPrefixes } from '../src/core/routing.mjs';
import { activeDecisions } from '../src/core/decisions.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-cosign-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitc = (cwd, ...a) => git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a);
const SRC = join(TMP, 'src');
mkdirSync(join(SRC, 'frontend'), { recursive: true }); mkdirSync(join(SRC, 'backend'));
git(SRC, 'init', '-q', '-b', 'main');
writeFileSync(join(SRC, 'frontend', 'README.md'), 'f\n'); writeFileSync(join(SRC, 'backend', 'README.md'), 'b\n');
gitc(SRC, 'add', '.'); gitc(SRC, 'commit', '-q', '-m', 'init');

const db = openDb(':memory:');
const owner = ensureOwner(db);
const lin = addUser(db, { name: '阿青', role: 'member', byUserId: owner.userId });
const zhou = addUser(db, { name: '阿明', role: 'member', byUserId: owner.userId });
const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'c1', name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
const client = (script) => {
  const real = new LlmClient({ mode: 'fake', fake: makeFake(script) });
  const seen = [];
  return { seen, complete: async (req) => { seen.push(req.messages.map((m) => (m.content ?? []).map((c) => c.text ?? '').join('')).join('\n')); return real.complete(req); } };
};
const as = (u) => (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: u.plaintext });
const T = (t, path) => ({ title: t, goal: `g ${t}`, scope: 's', scope_paths: [path], definition_of_done: `d ${t}`, rules: [{ rule: `r ${t}`, assumption: '规格没写' }], constraints: [], verify_command: 'node --test tests/x.test.mjs' });
const proposal = () => call('propose_project', { title: '工单', tasks: [T('T1 后端接口', 'backend/'), T('T2 前端列表', 'frontend/')], notes: '' });

/** 新项目 + 会签路由：方案批准 * → 负责人；frontend → 阿青 + 负责人（all）；backend → 阿明 + 负责人（all） */
function project(home) {
  const P = startProjectFromBrief(db, { userId: owner.userId, brief: '做一个工单系统\n前后端分开', source: SRC, home: join(TMP, home) });
  const rows = rulesOf(db, P.projectId).map(({ id, project_id, template, ...r }) => r);
  const base = rows.find((r) => r.decision_type === 'contract_approval' && r.scope === '*');
  rows.push({ ...base, scope: 'frontend', recipients: [`user:${lin.userId}`, 'user:lead'], quorum: 'all' });
  rows.push({ ...base, scope: 'backend', recipients: [`user:${zhou.userId}`, 'user:lead'], quorum: 'all' });
  saveRules(db, { key: P.projectId, rules: rows, userId: owner.userId });
  return P;
}

section('1. 方案按段送人：批准事项的前缀取自方案里各任务的范围');
let P, q1;
{
  eq(specPrefixes([T('a', 'backend/'), T('b', 'frontend/'), { scope_paths: ['package.json', '*'] }]).sort().join(','), 'backend,frontend', '前缀 = 各任务的目录（文件与 * 不算）');
  P = project('p1');
  const r = await planProject(db, { client: client([proposal()]), projectId: P.projectId });
  q1 = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  eq(JSON.parse(q1.addressed_to).sort().join(','), [owner.userId, lin.userId, zhou.userId].sort().join(','), '送负责人 + 阿青（frontend 那段）+ 阿明（backend 那段）');
}

section('2. 都批准 → 批准；各人的保留意见合在一起，一条都不丢（原来：措辞不同 → 冲突事项）');
{
  let r = as(owner)(q1.id, 'A');
  eq(r.resolved, false, '负责人批了，还差阿青、阿明（all）');
  r = as(lin)(q1.id, 'A\n保留：高优先级的红色我还想再看看');
  eq(r.resolved, false, '阿青批了，还差阿明');
  r = as(zhou)(q1.id, '批准');
  assert(r.resolved && !r.conflictId, '三人都批 → 结了，没有冲突事项（三条答复措辞各不相同）');
  const a = answerOf(db, q1.id);
  assert(/^A\n保留：阿青：高优先级的红色我还想再看看$/.test(a.body), `状态机读到的是合并后的一条：${JSON.stringify(a.body)}`);
  const out = await planProject(db, { client: client([]), projectId: P.projectId });
  eq(out.kind, 'approved', '规划器按批准处理');
  assert(activeDecisions(db, { projectId: P.projectId }).some((d) => /阿青：高优先级的红色我还想再看看/.test(d.statement)), '阿青的保留意见进了约定清单（署名）');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='cosign_merged' AND target_id=?`, q1.id), '合并留痕（cosign_merged）');
}

section('3. 有人要改 → 出下一版；要改的话署名合在一起交给规划器；批准的人下一版照样要再看');
{
  const P2 = project('p2');
  let r = await planProject(db, { client: client([proposal()]), projectId: P2.projectId });
  const q = r.questionId;
  as(lin)(q, 'A');
  as(zhou)(q, '接口路径改成 /api/v1/tickets');
  r = as(owner)(q, 'A，没意见');
  assert(r.resolved && !r.conflictId, '一人要改、两人批准 → 结了（不是冲突）');
  assert(/^会签：阿明要改（阿青、local-owner批准了这一版）\n阿明：接口路径改成 \/api\/v1\/tickets$/.test(answerOf(db, q).body), '合并后的正文：谁要改、谁批了、要改的原话');
  const c = client([proposal()]);
  r = await planProject(db, { client: c, projectId: P2.projectId });
  eq([r.kind, r.version].join('|'), 'proposed|2', '出了 v2');
  assert(/阿明：接口路径改成 \/api\/v1\/tickets/.test(c.seen[0]), '规划器收到阿明署名的要改');
  eq(JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, r.questionId).addressed_to).length, 3, 'v2 照样送三个人');
}

section('4. 有人放弃、有人批准 → 真分歧，照旧走冲突事项');
{
  const P3 = project('p3');
  const r = await planProject(db, { client: client([proposal()]), projectId: P3.projectId });
  as(owner)(r.questionId, 'A');
  as(lin)(r.questionId, 'A');
  const x = as(zhou)(r.questionId, 'C');
  assert(x.conflictId, '放弃 vs 批准 → 冲突事项');
}

section('5. 法定人数写成数字（3）也算会签：负责人先答不直接定案');
{
  const P4 = startProjectFromBrief(db, { userId: owner.userId, brief: '做一个工单系统\n前后端分开', source: SRC, home: join(TMP, 'p4') });
  const rows = rulesOf(db, P4.projectId).map(({ id, project_id, template, ...r }) => r);
  const row = rows.find((r) => r.decision_type === 'contract_approval' && r.scope === '*');
  row.recipients = ['user:lead', `user:${lin.userId}`, `user:${zhou.userId}`]; row.quorum = '3';
  saveRules(db, { key: P4.projectId, rules: rows, userId: owner.userId });
  const r = await planProject(db, { client: client([proposal()]), projectId: P4.projectId });
  eq(as(owner)(r.questionId, 'A').resolved, false, '负责人先答：不定案，还差两人');
  eq(as(zhou)(r.questionId, 'A').resolved, false, '阿明答了：还差阿青');
  eq(as(lin)(r.questionId, 'A').resolved, true, '三人都答 → 结');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 100);
