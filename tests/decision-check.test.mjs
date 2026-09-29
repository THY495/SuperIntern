// 新意见 vs 尚未作废的旧决定
//
// 跑：node tests/decision-check.test.mjs
//
// 三条原则在这份测试里各有对应的用例：
//   多数是正当演进 → 补充 / 细化 / 无关都不该命中，模型坏掉也不该命中；
//   "以新为准"必须一键 → 一句答复就把旧决定作废；
//   误报代价要低 → 编号不在清单里的、置信不足的、解析不出来的，一律丢掉而不是打断人。

import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { saveRules } from '../src/core/routing.mjs';
import { record, activeDecisions, renderDecisions } from '../src/core/decisions.mjs';
import { recordAnswer } from '../src/core/answers.mjs';
import {
  checkDecisions, checkAndRaise, raiseDecisionConflict, routeOf, verdictOf,
  HIT_CONFIDENCE_FLOOR,
} from '../src/core/decision-check.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const db = openDb(':memory:');
const owner = ensureOwner(db);       // 管理员 / 默认负责人
const T0 = now();

const mkUser = (name, { disabled = false } = {}) => {
  const id = newId('u');
  db.run(`INSERT INTO users (id,display_name,role,created_at${disabled ? ',disabled_at' : ''}) VALUES (?,?,'member',?${disabled ? ',?' : ''})`,
    ...(disabled ? [id, name, T0, T0] : [id, name, T0]));
  return id;
};
const lin = mkUser('阿青'), liu = mkUser('阿强'), gone = mkUser('已离职', { disabled: true });

const mkProject = () => {
  const id = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,goal,done_definition,created_at)
          VALUES (?,?,'订单服务','',?,?,'base','src','active','g','d',?)`, id, owner.userId, `/r/${id}`, `b/${id}`, T0);
  return id;
};
const mkTask = (projectId) => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'任务','running',?,?,1)`,
    id, owner.userId, T0, projectId);
  return id;
};
const resp = (o) => ({ stopReason: 'end_turn', content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }],
  usage: { inputTokens: 10, outputTokens: 5 } });
const client = (...script) => new LlmClient({ mode: 'fake', fake: makeFake(script) });

const errCode = (pj, t, by = lin) => record(db, { projectId: pj, taskId: t, subject: '错误码前缀',
  statement: '错误码一律用 ERR_ 前缀，见 shared/contract.mjs', sourceKind: 'question', sourceId: 'q_old', decidedBy: by, at: T0 });

// ════════════════════════════════════════════════════════════════════════
section('1 · 不调模型也能答的几种情形');

{
  const r = await checkDecisions('随便说点什么', { decisions: [], llmClient: client() });
  eq(r.skipped, 'no_decisions', '清单为空 → 一次模型都不调');
  eq(r.hits.length, 0, '自然也没有命中');
}
{
  const r = await checkDecisions('', { decisions: [{ id: 'dr_1', subject: 'x', statement: 'y', source_kind: 'question' }], llmClient: client() });
  eq(r.skipped, 'empty_text', '空文本 → 不调');
}
{
  const r = await checkDecisions('有话要说', { decisions: [{ id: 'dr_1', subject: 'x', statement: 'y', source_kind: 'question' }], llmClient: null });
  eq(r.skipped, 'no_client', '没有可用的模型 → 不调，也不报错：比对是附加的一道检查');
}

section('2 · 命中与不命中');

{
  const ds = [{ id: 'dr_a', subject: '错误码前缀', statement: '一律用 ERR_ 前缀', source_kind: 'question' }];
  const r = await checkDecisions('错误码改成数字', { decisions: ds, entry: 'answer',
    llmClient: client(resp({ hits: [{ id: 'dr_a', quote: '错误码改成数字', why: '两种编码不能同时是"一律"', confidence: 0.9 }] })) });
  eq(r.hits.length, 1, '真冲突报出来');
  eq(r.hits[0].id, 'dr_a', '带着决定编号');
  assert(/不能同时/.test(r.hits[0].why), '带着理由');
}
{
  const ds = [{ id: 'dr_a', subject: '错误码前缀', statement: '一律用 ERR_ 前缀', source_kind: 'question' }];
  const r = await checkDecisions('再加一个 ERR_TIMEOUT', { decisions: ds, llmClient: client(resp({ hits: [] })) });
  eq(r.hits.length, 0, '补充不算冲突');
}
{
  const ds = [{ id: 'dr_a', subject: 'x', statement: 'y', source_kind: 'question' }];
  const r = await checkDecisions('说点别的', { decisions: ds,
    llmClient: client(resp({ hits: [{ id: 'dr_不存在', quote: 'q', why: 'w', confidence: 0.99 }] })) });
  eq(r.hits.length, 0, '模型编了一个不在清单里的编号 → 丢掉');
  eq(r.dropped, 1, '丢掉的条数如实报出来');
}
{
  const ds = [{ id: 'dr_a', subject: 'x', statement: 'y', source_kind: 'question' }];
  const r = await checkDecisions('说点别的', { decisions: ds,
    llmClient: client(resp({ hits: [{ id: 'dr_a', quote: 'q', why: 'w', confidence: HIT_CONFIDENCE_FLOOR - 0.01 }] })) });
  eq(r.hits.length, 0, '置信不足 → 丢掉：宁可漏报，不拿没把握的冲突打断人');
}
{
  const ds = [{ id: 'dr_a', subject: 'x', statement: 'y', source_kind: 'question' }];
  const r = await checkDecisions('说点别的', { decisions: ds, llmClient: client(resp('我觉得吧……'), resp('还是不给 JSON')) });
  eq(r.skipped, 'unparsable', '模型两次都不给 JSON → 当作没冲突');
  eq(r.hits.length, 0, '比对器自己坏掉，不该变成一条打断人的事项');
}
{
  const ds = [{ id: 'dr_a', subject: 'x', statement: 'y', source_kind: 'question' }];
  const r = await checkDecisions('说点别的', { decisions: ds,
    llmClient: client(resp('前面一段废话 ```json\n{"hits":[]}\n``` 后面一段'), resp({ hits: [] })) });
  eq(r.skipped, null, '包在代码块里的 JSON 抠得出来');
}

section('3 · 命中之后找谁（三个特例）');

{
  const pj = mkProject(), t = mkTask(pj);
  const d = db.one(`SELECT * FROM decision_registry WHERE id=?`, errCode(pj, t, lin));
  eq(routeOf(db, { decision: d, by: lin }).mode, 'self', '新旧同一人 → 自己确认一下就行，不劳动别人');
  eq(routeOf(db, { decision: d, by: liu }).mode, 'parties', '两个人 → 冲突两段式');
  eq(routeOf(db, { decision: d, by: liu }).parties.length, 2, '双方都进 parties');
}
{
  const pj = mkProject(), t = mkTask(pj);
  const d = db.one(`SELECT * FROM decision_registry WHERE id=?`, record(db, { projectId: pj, taskId: t,
    subject: '行为规则', statement: 'page 非正整数返回 400', sourceKind: 'contract', decidedBy: lin, at: T0 }));
  eq(routeOf(db, { decision: d, by: liu }).mode, 'lead', '旧决定是契约条款 → 直接找负责人（改它等于改契约）');
}
{
  const pj = mkProject(), t = mkTask(pj);
  const d = db.one(`SELECT * FROM decision_registry WHERE id=?`, record(db, { projectId: pj, taskId: t,
    subject: '旧约定', statement: '照这样做', sourceKind: 'question', decidedBy: gone, at: T0 }));
  eq(routeOf(db, { decision: d, by: liu }).mode, 'lead', '定这条的人已停用 → 直接找负责人');
}

section('4 · 挂事项');

{
  const pj = mkProject(), t = mkTask(pj);
  const did = errCode(pj, t, lin);
  const d = db.one(`SELECT * FROM decision_registry WHERE id=?`, did);
  const r = raiseDecisionConflict(db, { taskId: t, group: [{ decision: d, hit: { quote: '错误码改成数字', why: '两种编码不能同时是"一律"', confidence: 0.9 } }], entry: 'answer', by: liu, at: T0 });
  const q = db.one(`SELECT * FROM questions WHERE id=?`, r.questionId);
  eq(q.level, 3, 'Ⅲ 级');
  eq(q.timeout_at, null, '不会超时自己消失');
  eq(q.default_action, null, '没有默认动作：不替人决定"以谁为准"');
  assert(/以新为准/.test(q.text) && q.text.indexOf('以新为准') < q.text.indexOf('以旧为准'), '"以新为准"排第一 —— 多数是正当演进');
  assert(/阿青/.test(q.text) && /错误码一律用 ERR_/.test(q.text), '正文里有旧决定的原文与它是谁定的');
  assert(/错误码改成数字/.test(q.text), '正文里有这次说的那句');
  assert(!!db.one(`SELECT 1 FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from'`, r.questionId, did),
    '出处边指向那条旧决定 —— 结论钩子靠边认，不靠正文里的字样');
  const again = raiseDecisionConflict(db, { taskId: t, group: [{ decision: d, hit: { quote: 'x', why: 'y', confidence: 0.9 } }], entry: 'answer', by: liu, at: T0 });
  eq(again.reused, true, '同一条决定已经有开着的冲突事项就不重复挂');
  eq(again.questionId, r.questionId, '复用的是同一条');
}
{
  const pj = mkProject(), t = mkTask(pj);
  const d = db.one(`SELECT * FROM decision_registry WHERE id=?`, errCode(pj, t, lin));
  const r = raiseDecisionConflict(db, { taskId: t, group: [{ decision: d, hit: { quote: 'q', why: 'w', confidence: 0.9 } }], entry: 'answer', by: lin, at: T0 });
  eq(r.mode, 'self', '同一人走单行确认');
  assert(/推翻你自己/.test(db.one(`SELECT text FROM questions WHERE id=?`, r.questionId).text), '正文是对着本人说的');
}

section('4b · 范围所有者要被知会：不按"谁批的契约"路由，按"这条决定落在谁的地盘上"知会');
// 例：size 越界的口径由产品提出、负责人裁定、两次计划变更落地，**全程没有一条事项到过后端** ——
// 而 server/ 正是他的地盘，路由表里明明写着 spec_choice/server → 阿强。
// 他到签收时才知道，第一句话就会是"这个变更是谁批的？没在我这走过"。
{
  const pj = mkProject(), t = mkTask(pj);
  // 路由表：server/ 这一片归阿强
  saveRules(db, { key: pj, userId: owner.userId, rules: [
    { decision_type: 'spec_choice', scope: '*', position: 0, recipients: ['user:lead'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null },
    { decision_type: 'spec_choice', scope: 'server', position: 0, recipients: [`user:${liu}`], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null },
    ...['structural', 'contract_approval', 'signoff', 'budget', 'egress', 'delivery', 'conflict'].map((dt) => (
      { decision_type: dt, scope: '*', position: 0, recipients: ['user:lead'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null })),
  ] });

  const did = record(db, { projectId: pj, taskId: t, subject: 'size 越界', statement: 'size 超上限返回 400',
    scope: ['server/app.mjs'], sourceKind: 'contract', sourceId: 'c_1', decidedBy: owner.userId, at: T0 });
  const d = db.one(`SELECT * FROM decision_registry WHERE id=?`, did);
  const r = raiseDecisionConflict(db, { taskId: t, group: [{ decision: d, hit: { quote: '改成截断返回 200', why: 'x', confidence: 0.9 } }], entry: 'revision', by: lin, at: T0 });
  const q = db.one(`SELECT addressed_to, informed FROM questions WHERE id=?`, r.questionId);
  const answering = JSON.parse(q.addressed_to), informed = JSON.parse(q.informed);
  eq(answering.includes(liu), false, '**不加进收件人** —— 多一个人要点头会把一次裁定变成一场会，而范围所有者要的不是"让我批"');
  eq(informed.includes(liu), true, '**加进知会** —— 这条决定落在 server/ 上，那是他的地盘');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='question_informed_added' AND target_id=?`, r.questionId), '这一步进审计，事后查得出来为什么他在名单上');

  // 决定没写范围 → 不猜
  const pj2 = mkProject(), t2 = mkTask(pj2);
  const d2 = db.one(`SELECT * FROM decision_registry WHERE id=?`, record(db, { projectId: pj2, taskId: t2,
    subject: '通则', statement: '不引入第三方依赖', scope: [], sourceKind: 'question', sourceId: 'q_2', decidedBy: lin, at: T0 }));
  const r2 = raiseDecisionConflict(db, { taskId: t2, group: [{ decision: d2, hit: { quote: 'y', why: 'z', confidence: 0.9 } }], entry: 'answer', by: liu, at: T0 });
  eq(JSON.parse(db.one(`SELECT informed FROM questions WHERE id=?`, r2.questionId).informed).includes(liu), false, '决定没写范围 → 不猜，不硬塞人进知会');
}


section('5 · 结论：以新为准是一句话的事');

{
  eq(verdictOf('以新为准'), 'new', '读得出 A');
  eq(verdictOf('A'), 'new', '只回一个字母也行');
  eq(verdictOf('以旧为准'), 'old', '读得出 B');
  eq(verdictOf('不冲突：两条管的是不同的接口'), 'none', '读得出 C');
  eq(verdictOf('呃我再想想'), 'none', '读不出来当作不冲突 —— 最保守：不作废任何东西');
}
{
  const pj = mkProject(), t = mkTask(pj);
  const did = errCode(pj, t, lin);
  const d = db.one(`SELECT * FROM decision_registry WHERE id=?`, did);
  const r = raiseDecisionConflict(db, { taskId: t, group: [{ decision: d, hit: { quote: 'q', why: 'w', confidence: 0.9 } }], entry: 'answer', by: owner.userId, at: T0 });
  recordAnswer(db, { questionId: r.questionId, body: '以新为准', plaintextToken: owner.plaintext });
  eq(db.one(`SELECT status FROM decision_registry WHERE id=?`, did).status, 'void', '答一句"以新为准"，旧决定当场作废');
  eq(activeDecisions(db, { projectId: pj }).length, 0, '清单里不再有它');
  assert(!!db.one(`SELECT 1 FROM audit_log WHERE action='decision_conflict_resolved' AND target_id=?`, r.questionId), '记了审计');
}
{
  const pj = mkProject(), t = mkTask(pj);
  const did = errCode(pj, t, lin);
  const d = db.one(`SELECT * FROM decision_registry WHERE id=?`, did);
  const r = raiseDecisionConflict(db, { taskId: t, group: [{ decision: d, hit: { quote: 'q', why: 'w', confidence: 0.9 } }], entry: 'answer', by: owner.userId, at: T0 });
  recordAnswer(db, { questionId: r.questionId, body: '以旧为准', plaintextToken: owner.plaintext });
  eq(db.one(`SELECT status FROM decision_registry WHERE id=?`, did).status, 'active', '"以旧为准"不作废任何东西');
}
{
  // 普通的答复冲突（有 origin_question_id）不该被这条钩子碰到。
  const pj = mkProject(), t = mkTask(pj);
  const oq = newId('q'), cq = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status,decision_type)
          VALUES (?,?,NULL,2,'classifier','原事项',NULL,?,NULL,'escalated','spec_choice')`, oq, t, T0);
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status,decision_type,origin_question_id)
          VALUES (?,?,NULL,3,'hard_rule','冲突事项',NULL,?,NULL,'open','conflict',?)`, cq, t, T0, oq);
  db.run(`UPDATE questions SET addressed_to=? WHERE id=?`, JSON.stringify([owner.userId]), cq);
  recordAnswer(db, { questionId: cq, body: '就按 A 来', plaintextToken: owner.plaintext });
  ok('普通冲突事项的结论没有被决定钩子拦下（没有抛错、没有作废任何决定）');
}

section('6 · 一整趟：取清单 → 预筛 → 问模型 → 挂事项');

{
  const pj = mkProject(), t = mkTask(pj);
  const did = errCode(pj, t, lin);
  record(db, { projectId: pj, taskId: t, subject: '按钮文案', statement: '导出按钮写"导出 CSV"',
    scope: ['web/ui.mjs'], sourceKind: 'question', decidedBy: lin, at: T0 });
  const r = await checkAndRaise(db, { taskId: t, text: '错误码改成数字，见 shared/contract.mjs', entry: 'revision', by: liu,
    llmClient: client(resp({ hits: [{ id: did, quote: '错误码改成数字', why: '不能同时"一律 ERR_"又"数字"', confidence: 0.9 }] })) });
  // 默认**不按范围预筛**：
  // scopeHints 会把 URL 路径当成文件路径，预筛可能因此把最该比的那条滤掉；而全量比一次只要半分钱。
  eq(r.considered, 2, '两条都拿给模型看了 —— 不按范围先砍');
  eq(r.prefiltered, false, '清单没长到要预筛的量级');
  eq(r.raised.length, 1, '挂了一条事项');
  assert(!!db.one(`SELECT 1 FROM questions WHERE id=? AND status='open'`, r.raised[0].questionId), '事项真的在库里开着');
  assert(!!db.one(`SELECT 1 FROM audit_log WHERE action='decision_check_done' AND target_id=?`, t), '这一趟记了审计（查过几条、命中几条、丢掉几条）');
}
{
  // 一次输入命中一组 → **一条**事项，不是一条一个（例如"把 DEFAULT_PAGE_SIZE 改成 20"一句话
  // 可能同时推翻 4 条已登记的规则；按每条一事项，一句话会变成四条待办）。
  const pj = mkProject(), t = mkTask(pj);
  const a = record(db, { projectId: pj, taskId: t, subject: '缺省页大小', statement: 'DEFAULT_PAGE_SIZE = 10', sourceKind: 'contract', decidedBy: owner.userId, at: T0 });
  const b = record(db, { projectId: pj, taskId: t, subject: '行为样例', statement: '不带查询时 size===10、items.length===10', sourceKind: 'contract', decidedBy: owner.userId, at: T0 });
  const r = await checkAndRaise(db, { taskId: t, text: '把 DEFAULT_PAGE_SIZE 改成 20', entry: 'revision', by: lin,
    llmClient: client(resp({ hits: [
      { id: a, quote: '改成 20', why: '同一常量不能既是 10 又是 20', confidence: 0.95 },
      { id: b, quote: '改成 20', why: 'size===10 的断言不再成立', confidence: 0.85 }] })) });
  eq(r.raised.length, 1, '两条命中只挂了一条事项');
  const q = db.one(`SELECT text FROM questions WHERE id=?`, r.raised[0].questionId);
  assert(/被推翻的 2 条旧决定/.test(q.text), '正文里把两条都列出来了');
  assert(/一次选定，上面 2 条一起处理/.test(q.text), '说明白了是一次选定、一起处理');
  eq(db.all(`SELECT 1 FROM edges WHERE from_id=? AND relation='derived_from'`, r.raised[0].questionId).length, 2, '两条出处边都挂上了');
  recordAnswer(db, { questionId: r.raised[0].questionId, body: '以新为准', plaintextToken: owner.plaintext });
  eq(activeDecisions(db, { projectId: pj }).length, 0, '答一句"以新为准"，两条一起作废');
}

section('7 · 争议未决的那段时间：清单要说实话');
// 比对不阻塞，所以"新说法已经生效"和"旧决定还在清单上"会同时为真一段时间。
// 不把这段时间标出来，别人和执行器读到的是一份看起来毫无争议的清单，会照着那条正在被推翻的约定继续做。

{
  const pj = mkProject(), t = mkTask(pj);
  const did = errCode(pj, t, lin);
  eq(activeDecisions(db, { projectId: pj })[0].disputed, false, '平时不标争议');
  const r = raiseDecisionConflict(db, { taskId: t, entry: 'answer', by: owner.userId, at: T0,
    group: [{ decision: db.one(`SELECT * FROM decision_registry WHERE id=?`, did), hit: { quote: '错误码改成数字', why: 'w', confidence: 0.9 } }] });
  const d = activeDecisions(db, { projectId: pj })[0];
  eq(d.id, did, '争议期间它**仍然在有效清单里** —— 系统不替人把一边撤下来');
  eq(d.disputed, true, '但标了"正在被争议"');
  assert(/正在被争议/.test(renderDecisions([d])), '给模型的那份文本里也说清楚了，不只是页面上好看');
  recordAnswer(db, { questionId: r.questionId, body: '以旧为准', plaintextToken: owner.plaintext });
  eq(activeDecisions(db, { projectId: pj })[0].disputed, false, '冲突有了结论，争议标记消失');
}

section('8 · 接线：走真的控制杆，不是直接调 checkAndRaise');
// 这一节是按"人做了正确的动作之后谁来接"那条判据写的：库里的函数对不对是一回事，
// 人在看板上点下去之后它会不会被调用是另一回事 —— 后者只有走控制杆才测得到。

{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { makeControls } = await import('../src/web/server.mjs');
  const TMP = mkdtempSync(join(tmpdir(), 'si-dc-'));
  const pj = mkProject(), t = mkTask(pj);
  const did = errCode(pj, t, lin);
  const qid = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,addressed_to,asked_at,timeout_at,status,decision_type)
          VALUES (?,?,NULL,2,'classifier','错误码怎么定？',NULL,?,?,NULL,'open','spec_choice')`, qid, t, JSON.stringify([owner.userId]), T0);
  const controls = makeControls(db, { home: TMP, tokenPlain: owner.plaintext,
    makeClassifierClient: () => client(resp({ hits: [{ id: did, quote: '错误码改成数字', why: '不能同时"一律 ERR_"又"数字"', confidence: 0.9 }] })) });
  await controls.answer({ questionId: qid, body: '错误码改成数字', _token: owner.plaintext });
  const raised = db.one(`SELECT q.id FROM questions q JOIN edges e ON e.from_id=q.id
                         WHERE e.relation='derived_from' AND e.to_id=? AND q.status='open'`, did);
  assert(!!raised, '在看板上答完一条事项，比对真的被调用了，冲突事项挂上了');
  assert(!!db.one(`SELECT 1 FROM decision_registry WHERE source_id=? AND source_kind='question'`, qid),
    '同一趟里，这条答复本身也进了决定登记');
  rmSync(TMP, { recursive: true, force: true });
}

section('9 · 答复要带着题目一起比（否则第二题回"a"会被读成在改第一题的口径 b）');
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { makeControls } = await import('../src/web/server.mjs');
  const TMP = mkdtempSync(join(tmpdir(), 'si-dc9-'));
  const pj = mkProject(), t = mkTask(pj);
  const ask = (text) => { const id = newId('q'); db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,addressed_to,asked_at,timeout_at,status,decision_type)
    VALUES (?,?,NULL,2,'classifier',?,NULL,?,?,NULL,'open','spec_choice')`, id, t, text, JSON.stringify([owner.userId]), T0); return id; };
  const q1 = ask('「字符数」按什么口径统计？(a) 全部字符 (b) 只统计非空白字符');
  const q2 = ask('输入 txt 文件的方式用哪种？(a) 命令行参数传路径 (b) 固定文件 (c) 标准输入');
  const seen = [];
  const mk = () => { const c = client(resp({ hits: [] })); const o = c.complete.bind(c); c.complete = (canon) => { seen.push(JSON.stringify(canon)); return o(canon); }; return c; };
  const controls = makeControls(db, { home: TMP, tokenPlain: owner.plaintext, makeClassifierClient: mk });
  await controls.answer({ questionId: q1, body: 'b', _token: owner.plaintext });
  await controls.answer({ questionId: q2, body: 'a', _token: owner.plaintext });
  const last = seen.at(-1) ?? '';
  assert(last.includes('输入 txt 文件的方式用哪种'), '比对器拿到的是"第二题 + 答复 a"，不是孤零零一个字母');
  assert(!/题目：「字符数」/.test(last), '…题目取的是这条答复真正回答的那一道');

  // 第二处：答复登记成决定时，范围从事项全文里抽路径 —— 连同正文末尾那行转交提示
  // （node src/cli.mjs question transfer …），于是 Python 项目的约定范围里会冒出 src/cli.mjs。
  const { recordFromQuestion } = await import('../src/core/decisions.mjs');
  const { TRANSFER_HINT_MARK } = await import('../src/core/routing.mjs');
  const hinted = { id: newId('q'), task_id: t, decision_type: 'spec_choice',
    text: `输入方式用哪种？(a) 命令行参数 (b) 标准输入\n${TRANSFER_HINT_MARK}转给知道的人：node src/cli.mjs question transfer q_x --to user:<成员id>` };
  const did = recordFromQuestion(db, { question: hinted, finalBody: 'a', by: owner.userId });
  const sc = JSON.parse(db.one(`SELECT scope FROM decision_registry WHERE id=?`, did).scope);
  assert(!sc.some((x) => /cli\.mjs/.test(x)), `登记的范围里没有转交提示带进来的 src/cli.mjs（${JSON.stringify(sc)}）`);
  rmSync(TMP, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);
console.log(fail ? `❌ ${pass} 通过，${fail} 失败` : `✅ ${pass} 通过，0 失败`);
console.log('═'.repeat(72));
process.exit(fail ? 1 : 0);
