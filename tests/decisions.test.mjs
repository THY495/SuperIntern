// 决定登记
//
// 跑：node tests/decisions.test.mjs
//
// 断言两件事：**什么进清单、什么不进**（"聊天不算"这条原则的机械落点），
// 以及作废 / 取代的链条。比对（三入口 + 轻档模型）不在这一份里。

import { openDb, ensureOwner, newId, now, audit } from '../src/db/db.mjs';
import {
  record, voidOne, activeDecisions, chainOf, renderDecisions, scopeHints, scopeOverlap,
  recordFromQuestion, recordFromContract, recordFromRevision, recordGoalChange,
  DECIDING_TYPES, relevantDecisions, decisionsSection, recordReservation,
} from '../src/core/decisions.mjs';
import { assembleExecutor } from '../src/context/assemble.mjs';
import { gatherSince, renderFacts } from '../src/agent/reporter.mjs';
import { createTaskFromSpec } from '../src/core/project.mjs';
import { editProjectGoal } from '../src/core/project-members.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const db = openDb(':memory:');
const owner = ensureOwner(db);
const T0 = now();

const mkProject = () => {
  const id = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,goal,done_definition,created_at)
          VALUES (?,?,'订单服务','',?,?,'base','src','active','把订单查询做出来','接口跑通且 npm test 全绿',?)`,
    id, owner.userId, `/r/${id}`, `superintern/${id}`, T0);
  return id;
};
const mkTask = (projectId = null, order = null) => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'任务','running',?,?,?)`,
    id, owner.userId, T0, projectId, order);
  return id;
};
const mkQuestion = (taskId, { text = '规格没写 size 超范围怎么办？', type = 'spec_choice' } = {}) => {
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status,decision_type)
          VALUES (?,?,NULL,2,'classifier',?,NULL,?,NULL,'answered',?)`, id, taskId, text, T0, type);
  return db.one(`SELECT * FROM questions WHERE id=?`, id);
};

// ════════════════════════════════════════════════════════════════════════
section('1 · 记、查、作废、取代');

{
  const pj = mkProject(), t = mkTask(pj, 1);
  const a = record(db, { projectId: pj, taskId: t, subject: '错误码前缀', statement: '一律用 ERR_ 前缀',
    sourceKind: 'question', sourceId: 'q_x', decidedBy: owner.userId, at: T0 });
  eq(activeDecisions(db, { projectId: pj }).length, 1, '记完就能查到');
  const b = record(db, { projectId: pj, taskId: t, subject: '错误码前缀', statement: '改用数字码',
    sourceKind: 'question', sourceId: 'q_y', decidedBy: owner.userId, supersedes: a, at: T0 + 10 });
  const live = activeDecisions(db, { projectId: pj });
  eq(live.length, 1, '取代之后清单里只剩新的那条');
  eq(live[0].id, b, '留下的是新的');
  eq(db.one(`SELECT status FROM decision_registry WHERE id=?`, a).status, 'void', '旧的被置为作废');
  const ch = chainOf(db, b);
  eq(ch.supersedes.length, 1, '链条往回查得到它取代了谁');
  eq(ch.supersedes[0].id, a, '查到的就是旧那条');
  eq(chainOf(db, a).supersededBy[0].id, b, '从旧那条也查得到是被谁取代的');
  assert(!!db.one(`SELECT 1 FROM audit_log WHERE action='decision_voided' AND json_extract(payload,'$.decisionId')=?`, a), '作废记了审计');
  eq(voidOne(db, { id: a }).changed, false, '重复作废是空操作');
}
{
  const pj = mkProject();
  let threw = null;
  try { record(db, { projectId: pj, subject: '', statement: 'x', sourceKind: 'question' }); } catch (e) { threw = e.message; }
  assert(/subject/.test(threw ?? ''), '没有主题的决定进不去');
  threw = null;
  try { record(db, { projectId: pj, subject: 'x', statement: 'y', sourceKind: '聊天' }); } catch (e) { threw = e.message; }
  assert(/来源只能是/.test(threw ?? ''), '来源不在四种之内的进不去 ——「聊天不算」的机械落点');
}

section('2 · 预筛是召回式的：只做加法');

{
  assert(scopeHints('改 src/api/orders.mjs 和 shared/contract.mjs').includes('src/api/orders.mjs'), '捞得到路径');
  assert(scopeHints('docs/API.md 里写了分页').includes('docs/API.md'), '捞得到文档路径');
  eq(scopeHints('把错误码统一一下').length, 0, '没有路径就是空，不硬凑');
  assert(scopeOverlap([], ['src/a.mjs']), '一侧为空 → 算命中（宁可多读）');
  assert(scopeOverlap(['src/a.mjs'], []), '另一侧为空也算命中');
  assert(scopeOverlap(['src/api/'], ['src/api/orders.mjs']), '前缀相交算命中');
  assert(!scopeOverlap(['src/api/x.mjs'], ['web/y.mjs']), '两边都写了路径且不沾边才过滤掉');
}
{
  const pj = mkProject(), t = mkTask(pj, 1);
  record(db, { projectId: pj, taskId: t, subject: '没写路径的决定', statement: '错误码统一', sourceKind: 'question', at: T0 });
  record(db, { projectId: pj, taskId: t, subject: '写了路径的决定', statement: '改 web/ui.mjs 的按钮文案', sourceKind: 'question', at: T0 });
  const got = activeDecisions(db, { projectId: pj, scope: ['src/api/orders.mjs'] });
  eq(got.length, 1, '预筛只滤掉"两边都写了路径且确定不沾边"的');
  eq(got[0].subject, '没写路径的决定', '自己没写范围的决定永远留在清单里');
}

section('3 · 写入点①：已有结论的事项，只收规格取舍与结构矛盾');

{
  const pj = mkProject(), t = mkTask(pj, 1);
  const q = mkQuestion(t, { text: '规格没写 size 超范围怎么办？\n(A) 400  (B) 截断为 100' });
  const id = recordFromQuestion(db, { question: q, finalBody: '按 B：size > 100 截断为 100，total 照常返回', by: owner.userId, at: T0 });
  assert(!!id, '规格取舍记了一条');
  const d = activeDecisions(db, { projectId: pj })[0];
  assert(/size 超范围/.test(d.subject), '主题取事项正文的第一行');
  assert(/截断为 100/.test(d.statement), '决定内容是结论，不是问题');
  eq(d.source_kind, 'question', '来源标对了');
  eq(d.task_id, t, '记得住是哪个任务定的');
}
{
  const pj = mkProject(), t = mkTask(pj, 1);
  for (const type of ['signoff', 'budget', 'egress', 'contract_approval', 'conflict', 'delivery']) {
    const q = mkQuestion(t, { type, text: `${type} 的事项` });
    eq(recordFromQuestion(db, { question: q, finalBody: '接受', by: owner.userId, at: T0 }), null, `${type} 不进清单`);
  }
  eq(activeDecisions(db, { projectId: pj }).length, 0, '这些类型一条都没记进去');
  eq(DECIDING_TYPES.length, 2, '算"决定"的事项类型就两种，加第三种时这条会提醒你去看注释');
}
{
  const pj = mkProject(), t = mkTask(pj, 1);
  const q = mkQuestion(t, { type: 'structural', text: '契约要求引用 DEFAULT_PAGE，但约定里只有 DEFAULT_PAGE_SIZE' });
  recordFromQuestion(db, { question: q, finalBody: '在 shared/contract.mjs 里加 DEFAULT_PAGE', by: owner.userId, at: T0 });
  const d = activeDecisions(db, { projectId: pj })[0];
  assert(d.scope.includes('shared/contract.mjs'), '范围从问题与结论里一起捞');
}

section('4 · 写入点②：批准过的契约，逐条进清单');

{
  const pj = mkProject();
  const spec = {
    title: '后端分页接口', goal: '做出列表接口', scope: 'src/api/ 与 shared/contract.mjs',
    definition_of_done: '接口按 docs/API.md 的行为工作', verify_command: 'npm test',
    constraints: ['不改前端'],
    rules: [
      { rule: 'page 不是正整数时返回 HTTP 400', quote: '不是正整数：HTTP 400，JSON' },
      { rule: '超过末页时返回空数组，total 照常', quote: '超过末页：items 为空数组，total 照常返回' },
      { rule: 'size 缺省为 DEFAULT_PAGE_SIZE', assumption: '规格没写缺省值，按共享常量' },
    ],
  };
  const { taskId } = createTaskFromSpec(db, spec, { userId: owner.userId, projectId: pj, order: 1 });
  const ds = activeDecisions(db, { projectId: pj });
  eq(ds.filter((d) => d.subject.endsWith('行为规则')).length, 3, '三条行为规则各记一条');
  eq(ds.filter((d) => d.subject.endsWith('改动范围')).length, 1, '范围记一条');
  eq(ds.filter((d) => d.subject.endsWith('验收命令')).length, 1, '验收命令记一条');
  eq(ds.length, 5, '目标与完成定义不进清单（有意的取舍）');
  const r1 = ds.find((d) => /正整数/.test(d.statement));
  assert(/〔规格〕出处/.test(r1.statement), '带出处的规则把出处一起带进清单 —— 清单要能自证，不能只剩结论');
  const r3 = ds.find((d) => /缺省/.test(d.statement));
  assert(/〔规划器假设〕/.test(r3.statement), '规划器自己定的那条标明是假设，不冒充规格');
  assert(ds.every((d) => d.task_id === taskId && d.source_kind === 'contract'), '来源与任务都记对了');
}

section('5 · 写入点③④：计划变更与项目目标');

{
  const pj = mkProject(), t = mkTask(pj, 1);
  recordFromRevision(db, { taskId: t, revisionId: 'rv_1', messageId: 'm_1',
    instruction: '改一下：空客户名用 null 表示，不要空字符串（影响 src/api/orders.mjs）',
    patchFields: ['definition_of_done'], userId: owner.userId, at: T0 });
  const d = activeDecisions(db, { projectId: pj })[0];
  assert(/空客户名用 null/.test(d.statement), '记的是人写的那条指令');
  assert(/改了本任务契约的完成定义/.test(d.statement), '顺带说明契约的哪几个字段被改了 —— 字段名翻成人话，并写明是本任务契约的那一份（项目也有「完成定义」）');
  assert(d.scope.includes('src/api/orders.mjs'), '范围从指令里捞');
  eq(d.source_id, 'm_1', '来源指向那条认证消息');
}
{
  const pj = mkProject();
  editProjectGoal(db, { projectId: pj, goal: '把订单查询做出来（第一版）', doneDefinition: '接口跑通且 npm test 全绿', by: owner.userId });
  editProjectGoal(db, { projectId: pj, goal: '把订单查询做出来，并且支持导出', doneDefinition: '接口跑通且 npm test 全绿', by: owner.userId });
  const gs = activeDecisions(db, { projectId: pj }).filter((d) => d.source_kind === 'goal');
  eq(gs.length, 1, '目标只有一份：新的自动取代旧的');
  assert(/支持导出/.test(gs[0].statement), '留下的是新的那份');
  eq(db.all(`SELECT id FROM decision_registry WHERE project_id=? AND source_kind='goal' AND status='void'`, pj).length, 1, '旧那份在库里留着，标为作废');
}
{
  const pj = mkProject();
  const before = db.one(`SELECT count(*) n FROM decision_registry WHERE project_id=?`, pj).n;
  editProjectGoal(db, { projectId: pj, goal: '把订单查询做出来', doneDefinition: '接口跑通且 npm test 全绿', by: owner.userId });
  eq(db.one(`SELECT count(*) n FROM decision_registry WHERE project_id=?`, pj).n, before, '一字没改的"修改"不记');
}

section('6 · 清单文本');

{
  const pj = mkProject(), t = mkTask(pj, 1);
  record(db, { projectId: pj, taskId: t, subject: '错误码前缀', statement: '一律 ERR_',
    scope: ['src/api/'], sourceKind: 'question', at: T0 });
  const txt = renderDecisions(activeDecisions(db, { projectId: pj }));
  assert(/〔答复〕/.test(txt), '标明来源，人一眼看得出这是谁拍的板');
  assert(/范围：src\/api\//.test(txt), '带上范围');
  assert(/^\[dr_/.test(txt), '带编号 —— 规划器要把它写进契约的"相关决定"一节');
}

section('7 · 谁拿全量、谁只拿相关的');

{
  const pj = mkProject(), t = mkTask(pj, 1);
  const global_ = record(db, { projectId: pj, taskId: t, subject: '错误码前缀', statement: '一律用 ERR_ 前缀',
    scope: [], sourceKind: 'question', decidedBy: owner.userId, at: T0 });
  const api = record(db, { projectId: pj, taskId: t, subject: '分页缺省', statement: 'size 缺省 10',
    scope: ['src/api/orders.mjs'], sourceKind: 'question', decidedBy: owner.userId, at: T0 });
  const web = record(db, { projectId: pj, taskId: t, subject: '按钮文案', statement: '写"导出 CSV"',
    scope: ['web/ui.mjs'], sourceKind: 'question', decidedBy: owner.userId, at: T0 });

  const all = activeDecisions(db, { projectId: pj }).map((d) => d.id);
  eq(all.length, 3, '规划器 / 追问器拿完整清单');

  const rel = relevantDecisions(db, { projectId: pj, scope: ['src/api/orders.mjs'] }).map((d) => d.id);
  assert(rel.includes(api), '执行器拿得到范围沾边的那条');
  assert(rel.includes(global_), '执行器拿得到没写范围的项目级通则');
  assert(!rel.includes(web), '执行器拿不到明显在别处的那条');

  const none = relevantDecisions(db, { projectId: pj, scope: [] }).map((d) => d.id);
  eq(none.length, 1, '契约里说不出任何路径时，执行器只拿通则');
  eq(none[0], global_, '拿到的就是那条通则 —— 不能把整张清单塞给它当第二份规格');
  eq(activeDecisions(db, { projectId: pj, scope: [] }).length, 3,
    '同样说不出路径，给人和给规划器的那份仍然是全量：召回优先，两份的取舍方向是相反的');
}
{
  const pj = mkProject();
  eq(decisionsSection(db, { projectId: pj }), '', '清单为空时不留空标题占位 —— 免得模型以为这个项目从来没定过东西');
  const t = mkTask(pj, 1);
  record(db, { projectId: pj, taskId: t, subject: '错误码前缀', statement: '一律 ERR_', sourceKind: 'question', at: T0 });
  const sec = decisionsSection(db, { projectId: pj });
  assert(/仍然有效/.test(sec) && /结构矛盾/.test(sec),
    '抬头写明"仍然有效"与"必须相反就当结构矛盾提出来"，不给模型自己绕过去的口子');
}
{
  // 执行器上下文：真的把相关的那条装进去了，不相关的没进去。
  const pj = mkProject(), t = mkTask(pj, 1);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'做接口','只动 src/api/orders.mjs','接口跑通','[]',?,?)`, newId('c'), t, T0, T0);
  const nid = newId('n');
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at)
          VALUES (?,?,'写接口','在 src/api/orders.mjs 里实现','跑通','ready',5,?)`, nid, t, T0);
  record(db, { projectId: pj, taskId: t, subject: '分页缺省', statement: 'size 缺省 10', scope: ['src/api/orders.mjs'], sourceKind: 'question', at: T0 });
  record(db, { projectId: pj, taskId: t, subject: '按钮文案', statement: '写"导出 CSV"', scope: ['web/ui.mjs'], sourceKind: 'question', at: T0 });
  const asm = assembleExecutor(db, { taskId: t, nodeId: nid, tier: 'standard', vendorId: 'fake' });
  assert(/size 缺省 10/.test(asm.system), '执行器的系统提示里有范围内的那条约定');
  assert(!/导出 CSV/.test(asm.system), '别处的那条没有进去');
  assert(/结构矛盾/.test(asm.system), '并且告诉它：照契约做就必然违反约定时，提出来而不是自己选一边');
}
{
  // 汇报：给签收人的那一份是召回式的 —— 它的意义正是防规划器漏引。
  const pj = mkProject(), t = mkTask(pj, 1);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'做接口','只动 src/api/orders.mjs','接口跑通','[]',?,?)`, newId('c'), t, T0, T0);
  record(db, { projectId: pj, taskId: t, subject: '分页缺省', statement: 'size 缺省 10', scope: ['src/api/orders.mjs'], sourceKind: 'question', at: T0 });
  const txt = renderFacts(gatherSince(db, t, 0));
  assert(/仍然有效的约定/.test(txt), '汇报里列出了本任务范围内仍然有效的约定');
  assert(/size 缺省 10/.test(txt), '内容在');
  assert(/打回/.test(txt) && /计划变更/.test(txt), '并且说清楚：对不上就打回，要改走计划变更');
}

// ════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(72)}`);

section('8 · 批准时的保留意见');
// 负责人批一份计划变更时可能想写下「下限截到 1 那条……他没明确说之前，这条先别当硬规则写进宪法」，
// 若这一页只有批 / 驳两个按钮，他只能改口「不值得为这一条卡住正题 —— 批」。
// **那不是他改主意，是界面上没有地方放那句话。** 这里给它一个地方 —— 仅此而已。
{
  const pj = mkProject(), t = mkTask(pj, 1);
  record(db, { projectId: pj, taskId: t, subject: 'size 下限', statement: 'size 小于 1 时按 1 处理',
    scope: ['src/api/'], sourceKind: 'revision', at: T0 });
  const rid = recordReservation(db, { projectId: pj, taskId: t, subject: '批准计划变更时的保留意见',
    text: '下限截到 1 那条是重规划器自己推的，不是产品原话；他没明说之前别当硬规则。',
    sourceKind: 'revision', sourceId: 'rv_x', by: owner.userId, at: T0 + 1 });
  assert(rid, '记下来了');
  eq(recordReservation(db, { projectId: pj, taskId: t, subject: 's', text: '   ', sourceKind: 'revision' }), null, '空白保留意见不落库');

  const list = activeDecisions(db, { projectId: pj });
  const resv = list.find((d) => d.id === rid);
  eq(resv.reservation, true, '标成保留意见 —— 与约定**机械可分**，不是靠 subject 里加个前缀');
  eq(list.find((d) => d.subject === 'size 下限').reservation, false, '普通决定不受影响');

  // 它进上下文，但必须说清它不是一条要遵守的规则
  const txt = renderDecisions(list);
  assert(/〔保留意见〕/.test(txt), '渲染时一眼分得开');
  assert(/不推翻上面任何一条规则/.test(txt) && /也不要求你照它做/.test(txt),
    '**说清它不是约定** —— 不写清楚，模型会把它当成一条要遵守的东西');
  assert(/标〔保留意见〕的那些是批准时留下的异议，\*\*不是约定\*\*/.test(decisionsSection(db, { projectId: pj })), '清单抬头也说一遍');

  // **那条规则照样生效**：这是这条修法诚实的限度，测试把它钉死，免得将来有人以为它挡住了什么
  eq(list.find((d) => d.subject === 'size 下限').status, 'active', '被保留的那条规则**仍然有效** —— 这条修法买不到"挡住"，只买到"留痕 + 进上下文 + 可统计"');

  // 可统计：审计里认得出来（"记了几条保留意见"是下一跑要量的数）
  const au = db.all(`SELECT payload FROM audit_log WHERE action='decision_registered' AND target_id=?`, pj)
    .map((r) => JSON.parse(r.payload)).filter((x) => x.reservation);
  eq(au.length, 1, '审计里数得出来记了几条');
}

console.log(fail ? `❌ ${pass} 通过，${fail} 失败` : `✅ ${pass} 通过，0 失败`);
console.log('═'.repeat(72));
process.exit(fail ? 1 : 0);
