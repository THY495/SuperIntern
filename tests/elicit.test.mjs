// 追问器
//
// 跑：node tests/elicit.test.mjs
//
// 断言的是流程与护栏，不是模型：从想法建任务没有宪法块；追问 = Ⅱ 级带默认走超时链、任务级；答复带回下一次寿命；
// 草案 = constitutions 下一版 + Ⅲ 级批准问题；批准由正则判（短句全匹配，"好，但是…"不算）；批准后规划器才能读；
// 放弃 = aborted；守护进程按阶段拉 draft → plan → run；空工作区能建。

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { draft, startFromIdea, readVerdict, reservationOf, renderDraft, verifyCommandProblems } from '../src/agent/elicitor.mjs';
import { recordAnswer } from '../src/core/inbox.mjs';
import { getParam } from '../src/core/params.mjs';
import { assessTask } from '../src/core/daemon.mjs';
import { ensureWorkspace } from '../src/core/workspace.mjs';
import { LIMITS, limitOf } from '../src/core/limits.mjs';
import { priorAnswers } from '../src/agent/planner.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-elicit-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const db = openDb(':memory:');
const owner = ensureOwner(db);
const call = (name, args, id = 'c1') => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id, name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
const ask = (questions) => call('ask_user', { questions });
const propose = (over = {}) => call('propose_constitution', { title: '命令行番茄钟', goal: '一个终端里的番茄钟', scope: '只有一个 pomo.mjs；不做 GUI', scope_paths: ['pomo.mjs'],
  definition_of_done: 'node pomo.test.mjs 全过', constraints: ['零依赖'], verify_command: 'node pomo.test.mjs', notes: '默认 25 分钟', ...over });
const client = (script) => new LlmClient({ mode: 'fake', fake: makeFake(script) });
const task = (id) => db.one(`SELECT * FROM tasks WHERE id=?`, id);
const answer = (qid, body) => recordAnswer(db, { questionId: qid, body, plaintextToken: owner.plaintext });
const dead = () => false;

section('1. 从想法建任务：没有宪法块，只有 draft.*');
const { taskId } = startFromIdea(db, { userId: owner.userId, idea: '想要一个命令行番茄钟，能记录每天完成几个', title: null, source: null });
{
  eq(task(taskId).status, 'planning', '状态 planning');
  eq(task(taskId).title, '想要一个命令行番茄钟，能记录每天完成几个', '标题取想法第一行');
  eq(getParam(db, taskId, 'draft.stage'), 'asking', 'draft.stage=asking');
  eq(db.one(`SELECT count(*) n FROM constitutions WHERE task_id=?`, taskId).n, 0, '没有宪法块');
  assert(db.one(`SELECT payload FROM audit_log WHERE action='task_created' AND target_id=?`, taskId).payload.includes('"idea":true'), '审计标了 idea');
  let threw = null; try { startFromIdea(db, { userId: owner.userId, idea: '  ' }); } catch (e) { threw = e; }
  assert(threw, '空想法拒');
  eq(readVerdict('A'), 'approve', '"A" = 批准'); eq(readVerdict('批准。'), 'approve', '"批准。" = 批准'); eq(readVerdict('(C)'), 'abandon', '"(C)" = 放弃');
  // 达成确认页的 (A) 叫「确认达成」，人照选项名回答，曾被当成修改意见、白出一版
  { const L = { approve: ['确认达成', '确认', '达成'], abandon: ['先放着'] };
    eq(readVerdict('确认达成', L), 'approve', '照选项名回「确认达成」= 批准');
    eq(readVerdict('先放着。', L), 'abandon', '照选项名回「先放着」= 放下');
    eq(readVerdict('确认达成，但把输出改成 JSON', L), 'feedback', '选项名后面跟着要改的话，仍是反馈（只认整句恰好是选项名）');
    eq(readVerdict('确认达成'), 'feedback', '别的页面不认这个名字（选项名按页给，不是全局词表）'); }
  eq(readVerdict('好，但是把范围缩到 src/'), 'feedback', '"好，但是…" 不算批准，算反馈'); eq(readVerdict('A 然后把 X 改成 Y'), 'feedback', '"A 然后…" 不算批准');
}

section('2. 第一次寿命：追问 → Ⅱ 级、带默认、走超时链、任务级');
{
  const r = await draft(db, { client: client([ask([
    { text: '每天的完成数记在哪？', default_action: '记在 ~/.pomo/stats.json', why: '决定要不要动文件系统' },
    { text: '要不要声音提醒？', default_action: '不要', why: '决定依赖' },
  ])]), taskId });
  eq(r.kind, 'asking', '停在提问上');
  eq(r.questions.length, 2, '两个问题');
  const qs = db.all(`SELECT * FROM questions WHERE task_id=? ORDER BY asked_at`, taskId);
  assert(qs.every((q) => q.level === 2 && q.node_id === null && q.default_action && q.timeout_at > now()), '都是 Ⅱ 级、任务级、带默认、有超时');
  assert(qs[0].text.includes('为什么问'), '问题正文带"为什么问"');
  eq(task(taskId).status, 'waiting', '任务 waiting');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='elicitor_started' AND target_id=?`, taskId).n, 1, 'elicitor_started');
  eq(JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='elicitor_exit' AND target_id=?`, taskId).payload).kind, 'asking', 'elicitor_exit kind=asking');
  eq(assessTask(db, task(taskId), { alive: dead }).due, false, '守护进程：waiting 不拉');
  const again = await draft(db, { client: client([]), taskId });
  eq(again.kind, 'noop', '有问题没答就再起一次 → noop，不调模型');
}

section('3. 答完 → 守护进程拉 draft → 答复带回 → 出草案 v1 + Ⅲ 级批准问题');
{
  const qs = db.all(`SELECT id FROM questions WHERE task_id=? AND status='open'`, taskId);
  answer(qs[0].id, '记在当前目录的 .pomo.json'); answer(qs[1].id, '不要');
  eq(task(taskId).status, 'running', '答完任务翻成 running（inbox 的规矩）');
  const a = assessTask(db, task(taskId), { alive: dead });
  eq(a.verb, 'draft', '守护进程：阶段是 draft'); eq(a.reason, 'draft:trigger:question_answered', '理由是答题');
  assert(priorAnswers(db, taskId).includes('.pomo.json'), '答复经 priorAnswers 带回（规划器后来也看得到）');
  const r = await draft(db, { client: client([propose()]), taskId });
  eq(r.kind, 'proposed', '出了草案'); eq(r.version, 1, 'v1');
  eq(task(taskId).status, 'waiting', '等批准 → waiting');
  eq(getParam(db, taskId, 'draft.stage'), 'proposed', 'stage=proposed');
  const c = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL`, taskId);
  eq(c.version, 1, 'constitutions v1'); eq(c.goal, '一个终端里的番茄钟', '目标落库');
  const q = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  assert(q.level === 3 && q.default_action === null && q.timeout_at === null && q.level_source === 'hard_rule', '批准问题是 Ⅲ 级：无默认无超时');
  assert(q.text.includes('宪法块草案 v1') && q.text.includes('(A) 批准'), '批准问题正文是草案全文 + 三个选项');
  eq(getParam(db, taskId, 'draft.verify_command'), 'node pomo.test.mjs', '验收命令先存草案参数');
  eq(getParam(db, taskId, 'draft.approval_question'), q.id, '记住了批准问题');
}

section('4. 反馈 → v2；批准 → 宪法块生效、verify_command 落宪法层、守护进程转 plan');
{
  answer(getParam(db, taskId, 'draft.approval_question'), '好，但是把范围缩到只有一个文件，不要测试文件之外的东西');
  eq(assessTask(db, task(taskId), { alive: dead }).reason, 'draft:trigger:question_answered', '反馈也是触发');
  const r = await draft(db, { client: client([propose({ scope: '只有 pomo.mjs 与 pomo.test.mjs' })]), taskId });
  eq(r.kind, 'proposed', '按反馈出下一版'); eq(r.version, 2, 'v2');
  eq(db.one(`SELECT count(*) n FROM constitutions WHERE task_id=? AND superseded_at IS NOT NULL`, taskId).n, 1, 'v1 作废');
  const v2 = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL`, taskId);
  eq(v2.scope, '只有 pomo.mjs 与 pomo.test.mjs', 'v2 是新范围');

  answer(getParam(db, taskId, 'draft.approval_question'), 'A');
  const ap = await draft(db, { client: client([]), taskId });
  eq(ap.kind, 'approved', '批准：不调模型'); eq(ap.version, 2, '批准的是 v2');
  eq(getParam(db, taskId, 'draft.stage'), 'approved', 'stage=approved');
  eq(JSON.stringify(getParam(db, taskId, 'task.verify_command')), '["node","pomo.test.mjs"]', 'verify_command 进宪法层参数（argv）');
  eq(task(taskId).title, '命令行番茄钟', '标题换成草案标题');
  eq(task(taskId).status, 'planning', '状态 planning');
  assert(db.one(`SELECT set_by_kind, governance_class FROM params WHERE task_id=? AND key='draft.stage' AND superseded_at IS NULL`, taskId).set_by_kind === 'user', '批准是人签的（set_by_kind=user）');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='draft_approved' AND target_id=?`, taskId).n, 1, '审计 draft_approved');
  // 这条入口批准的契约曾经一条都不进决定登记，决定比对对它完全看不见
  const reg = db.all(`SELECT subject, statement FROM decision_registry WHERE task_id=? AND source_kind='contract' AND status='active'`, taskId);
  const cons = JSON.parse(v2.constraints || '[]');
  assert(reg.some((d) => /改动范围/.test(d.subject)) && reg.some((d) => /验收命令/.test(d.subject)), '批准的契约进了决定登记（范围 / 验收命令）');
  eq(reg.filter((d) => /行为规则/.test(d.subject)).length, cons.length, `约束逐条作为行为规则登记（${cons.length} 条）`);
  assert(reg.filter((d) => /行为规则/.test(d.subject)).every((d) => d.statement.includes('批准过的草案约束')), '出处标成"批准过的草案约束"，不是规划器假设');
  const a = assessTask(db, task(taskId), { alive: dead });
  eq(a.verb, 'plan', '守护进程：转 plan 阶段'); eq(a.reason, 'plan:first', '第一次规划');
  eq((await draft(db, { client: client([]), taskId })).kind, 'noop', '批准后再 draft → noop');

  // 规划器跑过、节点落库 → run 阶段
  audit(db, { actorKind: 'agent', actorId: 'planner', action: 'planner_started', targetType: 'task', targetId: taskId, payload: { pid: 1 } });
  audit(db, { actorKind: 'agent', actorId: 'planner', action: 'planner_exit', targetType: 'task', targetId: taskId, payload: { pid: 1, kind: 'question' } });
  eq(assessTask(db, task(taskId), { alive: dead }).reason, 'needs_human:question', '规划器停在提问 → 等人');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'n','s','a','pending',5,?)`, newId('n'), taskId, now());
  db.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);
  const run = assessTask(db, task(taskId), { alive: dead, hasWorkspace: () => true });
  eq(run.verb, 'run', '有节点 → run 阶段'); eq(run.reason, 'run:first', 'run 首跑');
}

section('5. 放弃；模型不合规的重试；追问轮次上限已登记');
{
  const t2 = startFromIdea(db, { userId: owner.userId, idea: '随便做点什么' }).taskId;
  const r = await draft(db, { client: client([propose()]), taskId: t2 });
  answer(r.questionId, '放弃');
  eq((await draft(db, { client: client([]), taskId: t2 })).kind, 'abandoned', '"放弃" → abandoned');
  eq(task(t2).status, 'aborted', '任务 aborted');

  const t3 = startFromIdea(db, { userId: owner.userId, idea: '一个只输出文字的模型会遇到什么' }).taskId;
  const r3 = await draft(db, { client: client([
    { stopReason: 'end_turn', content: [{ type: 'text', text: '我觉得先聊聊' }], usage: {} },
    call('ask_user', { questions: [{ text: '缺默认', why: 'x' }] }),
    ask([{ text: '合规了吗？', default_action: '是', why: 'y' }]),
  ]), taskId: t3 });
  eq(r3.kind, 'asking', '两次不合规后第三次合规');
  eq(r3.attempts, 3, '记了 3 次尝试');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='draft_attempt' AND target_id=?`, t3).n, 2, '两次被拒进审计');
  let threw = null;
  const t4 = startFromIdea(db, { userId: owner.userId, idea: 'x' }).taskId;
  try { await draft(db, { client: client([{ stopReason: 'end_turn', content: [], usage: {} }, { stopReason: 'end_turn', content: [], usage: {} }, { stopReason: 'end_turn', content: [], usage: {} }]), taskId: t4 }); } catch (e) { threw = e; }
  assert(threw && /3 次/.test(threw.message), '三次都不合规 → 抛');
  eq(JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='elicitor_exit' AND target_id=? ORDER BY id DESC LIMIT 1`, t4).payload).kind, 'failed', 'elicitor_exit kind=failed');
  eq(assessTask(db, task(t4), { alive: dead, at: now() }).reason, 'backoff:failed#1', '守护进程：失败按退避');

  // 模型曾给出一段 20 行 bash 当验收命令：形状合法、跑不起来。护栏在模型外。
  eq(verifyCommandProblems('node x.test.mjs').length, 0, '一条命令：通过');
  eq(verifyCommandProblems('').length, 0, '留空：通过（notes 里说明）');
  assert(verifyCommandProblems('set -e\ntmp=$(mktemp -d)\nnode x.js').length >= 1, '多行脚本：拒');
  assert(verifyCommandProblems('node x.js | grep ok').some((e) => e.includes('|')), '管道：拒');
  assert(verifyCommandProblems('npm test && node y.js').some((e) => e.includes('&&')), '串联：拒');
  const t5 = startFromIdea(db, { userId: owner.userId, idea: 'y' }).taskId;
  const r5 = await draft(db, { client: client([propose({ verify_command: 'node a.js | grep ok' }), propose({ verify_command: 'node a.test.mjs' })]), taskId: t5 });
  eq(r5.kind, 'proposed', '含管道的草案被拒后第二次合规'); eq(r5.attempts, 2, '记了 2 次');
  assert(JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='draft_attempt' AND target_id=?`, t5).payload).rejections[0].includes('|'), '拒绝理由进审计');
  assert(LIMITS['limit.draft_rounds'], 'limit.draft_rounds 已登记');
  eq(limitOf(db, taskId, 'limit.draft_rounds'), 6, '默认 6 轮');
  eq(LIMITS['limit.draft_rounds'].read(db, taskId), 4, '实测 = elicitor_started 次数（noop 不算：没起模型就不算一轮）');
}

section('6. 空工作区（新项目）');
{
  const dir = join(TMP, 'ws-empty');
  const ws = ensureWorkspace(db, { taskId, dir, empty: true });
  assert(ws.created && existsSync(join(dir, '.git')), '建了 git 仓库');
  eq(ws.branch, `v0/${taskId}`, '分支名同形');
  eq(execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), `v0/${taskId}`, 'HEAD 在任务分支');
  eq(ensureWorkspace(db, { taskId, dir, empty: true }).created, false, '再建一次 = 已存在');
  assert(renderDraft({ title: 't', goal: 'g', scope: 's', definition_of_done: 'd', constraints: [], verify_command: '' }, 1, '').includes('（没给 —— 见说明）'), '没给验收命令时草案正文说明');
}

section('带说明的批准 / 放弃：选项字母 + 说明 → 认；有转折或要求改 → 仍当反馈');
{
  const V = (t) => readVerdict(t);
  eq(V('A。规划器假设都是合理的工程约定，可以放行。依赖关系也对，任务数 4 个也合适。\n\n那几个拿不准的点先按当前 assumption 走，等产品有意见再改。'), 'approve', '真实答复原文："A。" + 两段说明 → 批准');
  eq(V('(A) 没问题'), 'approve', '"(A) 没问题" → 批准');
  eq(V('A，但把 size 超范围改成截断'), 'feedback', '"A，但……" → 反馈（不替人做决定）');
  eq(V('A。不过 T3 要改成依赖 T2'), 'feedback', '"A。不过……要改" → 反馈');
  eq(V('A, if you drop the footer rule'), 'feedback', '带条件的英文 → 反馈');
  eq(V('C，这个方向不做了'), 'abandon', '"C，说明" → 放弃');
  eq(V('API 文档要补一节鉴权'), 'feedback', '以 A 开头的普通句子（A 后面不是标点）→ 反馈');
  eq(V('A'), 'approve', '裸 "A" 照旧');
}

section('批准时带一句保留意见：认显式标记，不从语气里猜');
{
  // 一条真实答复的原话。没有"保留意见"这一格时它会被 hedgeRe 判成反馈 —— 问题在于：
  // 人有一个具体的、说得出口的保留意见，而系统只提供两个出口，于是只能把那句话删了才批得进去。
  const real = 'A。\n保留：下限截到 1 那条，是重规划器自己拿"别给用户报错"的原则往下限推的，不是阿青原话里说的。这种面向用户的行为判断我不替产品拍 —— 他没明确说之前，这条先别当硬规则写进宪法。';
  eq(readVerdict(real), 'approve', '**「A」+「保留：…」= 批准** —— 保留意见那一段里几乎一定有"但 / 别当"这类词，先摘掉再判，不然人的批准反而不算数');
  assert(reservationOf(real).startsWith('下限截到 1 那条'), '把那句话原样取出来');
  eq(reservationOf(real).includes('A。'), false, '只取保留意见那一段，不带上"A。"');

  eq(reservationOf('A'), null, '没写就是没有');
  eq(reservationOf('A。假设都合理'), null, '**不从语气里猜** —— 认标记，与"封闭答案空间"同一条规矩');
  eq(readVerdict('A\n保留意见：这条我有不同看法'), 'approve', '"保留意见：" 也认');
  eq(readVerdict('保留：这条我有不同看法'), 'feedback', '**只写保留、没写 A → 不算批准**（宁可多出一版草案，不替人批）');
  eq(readVerdict('A，但把 size 超范围改成截断\n保留：另外那条也不太对'), 'feedback',
    '**摘掉保留意见之后仍然有转折 → 照旧按反馈走** —— 这条修法不放宽批准的判据，只给保留意见一个落脚处');
  // 真实答复的原话：写在同一行，曾一再被当成"要改"，规划器又出一版 —— 不会自己停的循环
  const inline = 'A 保留：签收时我会核对 frontend/package.json 里是不是只加了新东西，没有顺手动已有的脚本/配置；另外 ticket-high 的红色样式确认只落在 high 那一行的优先级文字上，别把别的优先级或别的地方带红了。';
  eq(readVerdict(inline), 'approve', '**同一行的「A 保留：…」也是批准**（页面教的是另起一行，可人顺手就写一行里）');
  assert(reservationOf(inline)?.startsWith('签收时我会核对'), '保留意见照样取出来');
  eq(readVerdict('批准，保留意见：那条假设我不太认'), 'approve', '「批准，保留意见：…」同理');
  eq(readVerdict('B 保留：这条不行'), 'feedback', '同一行写的是 B：不是批准');
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
