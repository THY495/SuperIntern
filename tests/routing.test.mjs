// 角色与路由 —— 路由核心。
//
// 跑：node tests/routing.test.mjs
//
// 断言的是六字段表的语义与不变量：六个模板都能过校验；多范围取并集、每链最长匹配；解析器六种；
// 保存校验逐条拒绝；两旋钮是投影；转交是事项级且 Ⅲ 级仍含负责人；授权查表不查 role；历史预演能算出打断次数。

import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { loadTemplates, validateRules, saveRules, applyTemplate, diffFromTemplate, rulesOf, profileOf,
  prefixesOfScope, filesOfScope, matchChains, resolveRecipients, routeQuestion, advanceRoute, transferQuestion, authorize,
  knobsOf, setKnobs, previewRouting, dueAfter, addBusinessDays, setDutyCalendar, onDutyAt, DECISION_TYPES, guessDecisionType, decisionTypeOfQuestion,
  prefixesOf, scopeFilesOf } from '../src/core/routing.mjs';
import { scopePathProblems, normScopePaths } from '../src/core/project.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throwsWith = (fn, re, m) => { try { fn(); bad(m, '没有抛'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `抛了但不是预期：${e.message}`); } };

const db = openDb(':memory:');
const lead = ensureOwner(db, 'lead').userId;
const t0 = now();
const addUser = (name, role, tags = []) => {
  const id = newId('u');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,?,?,?)`, id, name, role, JSON.stringify(tags), t0);
  return id;
};
const alice = addUser('alice', 'member', ['frontend', 'reviewer']);
const bob = addUser('bob', 'member', ['backend', 'reviewer']);
const carol = addUser('carol', 'observer', ['frontend']);
const mkTask = (scope = '.') => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'t','running',?)`, id, lead, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g',?,'d','[]',?,?)`, newId('c'), id, scope, t0, t0);
  return id;
};
const mkQ = (taskId, { level = 2, nodeId = null, text = 'q' } = {}) => {
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
          VALUES (?,?,?,?,'classifier',?,?,?,NULL,'open')`, id, taskId, nodeId, level, text, level === 3 ? null : 'd', t0);
  return id;
};

section('1. 模板：六个都能过校验；占位符与日历是前置');
{
  const tpls = loadTemplates();
  eq(Object.keys(tpls), ['solo', 'by_domain', 'peer_review', 'rotation', 'pm_tl', 'unattended'], '六个模板');
  for (const name of ['solo', 'by_domain', 'peer_review', 'unattended']) {
    eq(validateRules(db, '', tpls[name].rows), [], `模板 ${name} 过校验`);
  }
  throwsWith(() => applyTemplate(db, { key: '', name: 'pm_tl', userId: lead }), /需要先指定：pm/, 'pm_tl 不绑占位符不让存');
  throwsWith(() => applyTemplate(db, { key: '', name: 'rotation', userId: lead }), /值班表为空/, 'rotation 没日历不让存');
  setDutyCalendar(db, { key: '', users: [alice, bob], startAt: t0 - 3 * 86400_000, periodDays: 7, userId: lead });
  eq(validateRules(db, '', tpls.rotation.rows), [], '有日历后 rotation 过校验');
  const rows = applyTemplate(db, { key: '', name: 'pm_tl', bindings: { pm: alice, tl: bob }, userId: lead });
  assert(rows.some((r) => r.decision_type === 'spec_choice' && r.recipients.includes(`user:${alice}`)), '占位符展开成 user:<id>');
  eq(profileOf(db, '').template, 'pm_tl', 'profile 记住了模板');
  eq(diffFromTemplate(db, '').changed.length, 0, '刚选完模板：无差异');
  const d = db.one(`SELECT count(*) n FROM routing_rules WHERE project_id=''`).n;
  eq(d, tpls.pm_tl.rows.length, '行复制进了项目表');
  eq(guessDecisionType('【硬上限触顶】x'), 'budget', '回填：触顶');
  eq(guessDecisionType('【宪法块草案 v1】'), 'contract_approval', '回填：草案');
}

section('2. 触及范围：从 scope 文本抽前缀；最长匹配；多范围并集');
{
  eq(prefixesOfScope('修改 src/core/limits.mjs 与 README.md；新增 test/x.test.mjs。不动 docs/'), ['src/core', 'test'], '文件取目录、根文件不算前缀；否定分句（不动 docs/）里的目录不算触及范围');
  eq(filesOfScope('修改 src/core/limits.mjs 与 README.md；新增 test/x.test.mjs。不动 docs/、CHANGELOG.md'), ['README.md'], '根目录文件单列（越界校验用）；否定分句里的不算');
  { const real = '只新建 shared/contract.mjs、shared/contract.test.mjs、docs/API.md 与根 package.json；不动 README；不建 server/、client/、e2e/；不引入任何第三方依赖，只用 Node 内置模块与 node:test。';
    eq(prefixesOfScope(real), ['shared', 'docs'], '真实范围原文："不建 server/、client/、e2e/" 不再被当成触及范围');
    eq(filesOfScope(real), ['package.json'], '真实范围原文：根 package.json 在允许范围里'); }
  eq(prefixesOfScope('只动 server/ 与根 package.json（只在 scripts 加 start，不删改 scripts.test 及其它字段）'), ['server'], '括注里的"不删改"不让整句作废');
  // 修正之后的范围末句可能把否定词放在句中，只看句首的判断会漏 ——
  // client/ 与 e2e/ 被当成触及范围，签收从"发给后端一人"变成四个人各要一份法定人数。
  { const real2 = "只新建/修改 server/app.mjs、server/seed.mjs，并在根 package.json 的 scripts 中加 'start'（不删改已有 scripts.test 等字段）；不引入第三方依赖。唯一例外：允许修改 shared/contract.mjs 与 shared/contract.test.mjs；不得改动 contract 中其他任何既有导出。除此之外仍不动 shared/、docs/、client/、e2e/、README。";
    eq(prefixesOfScope(real2), ['server', 'shared'], '"除此之外仍不动 …"：否定词不在句首也要认，后半段整段不算');
    eq(filesOfScope(real2), ['package.json'], '同一句里否定词之前的根文件照常算'); }
  eq(prefixesOfScope('原则上不动 client/；本次只改 server/'), ['server'], '"原则上不动 …" 同理');
  eq(prefixesOfScope('改 lib/a.js（先别碰 lib/legacy/），另外改 tools/b.js'), ['lib', 'tools'], '括注里的否定只影响括注内部，括注之后的路径照常算');
  eq(prefixesOfScope('.'), [], '"." 抽不到前缀');
  eq(prefixesOfScope('通过率 1/2 以上；改 lib/a.js'), ['lib'], '比例不算路径');
  const rules = [
    { id: 'a', decision_type: 'spec_choice', scope: '*', position: 0, recipients: ['user:lead'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null },
    { id: 'b', decision_type: 'spec_choice', scope: 'src', position: 0, recipients: ['group:backend'], quorum: '1', conflict_policy: 'block', timeout_action: 'next', timeout_after: '1bd' },
    { id: 'b2', decision_type: 'spec_choice', scope: 'src', position: 1, recipients: ['user:lead'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null },
    { id: 'c', decision_type: 'spec_choice', scope: 'src/web', position: 0, recipients: ['group:frontend'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null },
  ];
  eq(matchChains(rules, { decisionType: 'spec_choice', prefixes: [] }).map((c) => c.scope), ['*'], '无前缀 → * 链');
  eq(matchChains(rules, { decisionType: 'spec_choice', prefixes: ['src/web/x'] }).map((c) => c.scope), ['src/web'], '最长匹配');
  eq(matchChains(rules, { decisionType: 'spec_choice', prefixes: ['src/core', 'src/web'] }).map((c) => c.scope), ['src', 'src/web'], '两个前缀两条链');
  eq(matchChains(rules, { decisionType: 'spec_choice', prefixes: ['docs'] }).map((c) => c.scope), ['*'], '没命中 → *');
  eq(matchChains(rules, { decisionType: 'spec_choice', prefixes: ['src/core'] })[0].chain.map((r) => r.id), ['b', 'b2'], '链按 position 排');
}

section('2b. 「不该你答」那条出路要写在事项正文里');
// 执行器把矛盾抛给负责人，负责人常常知道"这事该问产品"——
// 命令与看板按钮**本来就有**，但若事项正文里不提，就等于没有：正文才是进通知、进摘要、进 CLI 的那一份。
// 同一族问题：人有一个说得出口的正确动作，界面上没有地方做。
{
  const t = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, t, lead, now());
  const mkq = (type) => {
    const id = newId('q');
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,3,'hard_rule','【结构矛盾】规格与契约打架了。',NULL,?,NULL,'open')`, id, t, now());
    routeQuestion(db, { questionId: id, decisionType: type, typeSource: 'hard_rule', at: now() });
    return db.one(`SELECT text FROM questions WHERE id=?`, id).text;
  };
  const txt = mkq('structural');
  assert(txt.includes('不该你答？'), '结构矛盾事项正文里给出这条出路');
  assert(/question transfer/.test(txt), '给出的是可以照抄的那条命令');
  assert(/看板上这条事项右边有「转交」按钮/.test(txt), '也说了图形界面上在哪儿');
  assert(/与「不归我」不是一回事/.test(txt), '**说清它与「不归我」的差别** —— 转交之后这条仍然要有人答');
  assert(txt.startsWith('【结构矛盾】规格与契约打架了。'), '原正文一字不动，只在末尾追加');

  // 幂等：改派 / 转交会再走一遍 routeQuestion，不能把这段追加两遍
  const id2 = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
          VALUES (?,?,NULL,2,'hard_rule','【规格取舍】两种写法选一个。','按第一种',?,NULL,'open')`, id2, t, now());
  routeQuestion(db, { questionId: id2, decisionType: 'spec_choice', typeSource: 'self', at: now() });
  routeQuestion(db, { questionId: id2, decisionType: 'spec_choice', typeSource: 'self', at: now(), stage: 1 });
  const twice = db.one(`SELECT text FROM questions WHERE id=?`, id2).text;
  eq(twice.split('不该你答？').length - 1, 1, '走两遍路由也只追加一次');

  // 冲突事项不给：它的答案空间是封闭的（附议 / 弃权 / 重申），转交只会把裁定甩来甩去
  const id3 = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
          VALUES (?,?,NULL,3,'hard_rule','【冲突】两边说的不一样。',NULL,?,NULL,'open')`, id3, t, now());
  routeQuestion(db, { questionId: id3, decisionType: 'conflict', typeSource: 'hard_rule', at: now() });
  assert(!db.one(`SELECT text FROM questions WHERE id=?`, id3).text.includes('不该你答？'), '冲突事项不给这条 —— 它的答案空间是封闭的三选一');
}


section('3. 解析器：user / lead / group / group:* / on_duty / inform / parties');
{
  const r = resolveRecipients(db, '', ['user:lead', `user:${alice}`, `inform:user:${bob}`, `user:${carol}`], { lead });   // 默认表没有表级负责人：调用方传任务的 owner
  eq(r.answerers, [lead, alice], '旁观者不成为应答人');
  eq(r.informed, [bob], 'inform: 只知会');
  eq(resolveRecipients(db, '', ['group:reviewer']).answerers, [alice, bob], '标签组');
  eq(resolveRecipients(db, '', ['group:*']).answerers, [lead, alice, bob], 'group:* = 所有 lead/member，不含旁观者');
  eq(resolveRecipients(db, '', [`user:${alice}`, `inform:user:${alice}`]).informed, [], '既是应答人就不重复知会');
  const cal = { users: [alice, bob], start_at: t0, period_days: 7 };
  eq(onDutyAt(cal, t0 + 1), alice, '第一周 alice');
  eq(onDutyAt(cal, t0 + 8 * 86400_000), bob, '第二周 bob');
  eq(onDutyAt(cal, t0 + 15 * 86400_000), alice, '第三周轮回');
  eq(resolveRecipients(db, '', ['parties'], { parties: [alice, bob] }).answerers, [alice, bob], 'parties 从参数来');
  // 工作日：周五 12:00 + 1bd = 周一 12:00
  const fri = Date.UTC(2026, 8, 18, 12);   // 2026-09-18 是周五
  eq(new Date(dueAfter(fri, '1bd')).toISOString(), '2026-09-21T12:00:00.000Z', '1bd 跳过周末');
  eq(dueAfter(fri, '8h') - fri, 8 * 3600_000, '8h');
  eq(addBusinessDays(Date.UTC(2026, 8, 19, 9), 1), Date.UTC(2026, 8, 21, 9), '周六起算 +1bd = 周一');
}

section('4. 保存校验：逐条拒绝、说清哪一行');
{
  const base = loadTemplates().solo.rows.map((r) => ({ ...r }));
  const errsOf = (mut) => { const rs = base.map((r) => ({ ...r, recipients: [...r.recipients] })); mut(rs); return validateRules(db, '', rs).map((e) => e.msg); };
  const has = (errs, re, m) => assert(errs.some((e) => re.test(e)), `${m}：${errs.find((e) => re.test(e)) ?? errs.join(' | ')}`);
  has(errsOf((rs) => { rs.find((r) => r.decision_type === 'structural').recipients = [`user:${alice}`]; }), /必须包含负责人/, 'Ⅲ 级类型行不含负责人');
  has(errsOf((rs) => { rs.find((r) => r.decision_type === 'signoff').quorum = '3'; }), /法定人数 3 大于接收人实际人数 1/, '法定人数超过人数');
  has(errsOf((rs) => { rs.find((r) => r.decision_type === 'signoff').timeout_action = 'next'; rs.find((r) => r.decision_type === 'signoff').timeout_after = '1d'; }), /但没有下一顺位/, 'next 无下一行');
  has(errsOf((rs) => { rs.find((r) => r.decision_type === 'budget').recipients = ['parties']; }), /parties 只能用于「意见不一致」类型/, 'parties 用错类型');
  has(errsOf((rs) => { const r = rs.find((x) => x.decision_type === 'budget'); r.recipients = []; r.timeout_action = 'next'; r.timeout_after = '1d'; }), /接收人为空时，超时动作只能是/, '空收件人配 next');
  has(errsOf((rs) => { rs.splice(rs.findIndex((r) => r.decision_type === 'delivery'), 1); }), /交付：至少需要一行范围为 \* 的规则/, '类型缺 * 行');
  has(errsOf((rs) => { rs.find((r) => r.decision_type === 'signoff').recipients = ['user:$pm']; }), /占位符 user:\$pm 尚未指定成员/, '未绑定的占位符');
  has(errsOf((rs) => { rs.find((r) => r.decision_type === 'signoff').timeout_after = '1d'; }), /（hang）时不能填写超时/, 'hang 带时限');
  has(errsOf((rs) => { rs.find((r) => r.decision_type === 'conflict' && r.position === 1).timeout_action = 'default'; rs.find((r) => r.decision_type === 'conflict' && r.position === 1).timeout_after = '1d'; }), /最后一个顺位只能「持续等待」/, 'Ⅲ 级链末行不能 default');
  eq(validateRules(db, '', base, { repoDirs: ['src'] }), [], 'solo 全 * 行不受 repoDirs 影响');
  const withDir = [...base, { decision_type: 'spec_choice', scope: 'nope', position: 0, recipients: ['user:lead'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null }];
  eq(validateRules(db, '', withDir), [], '不给 repoDirs 就不查目录存在性');
  has(validateRules(db, '', withDir, { repoDirs: ['src'] }).map((e) => e.msg), /目录 nope 在仓库中不存在/, '范围目录不存在');
  throwsWith(() => saveRules(db, { key: '', rules: withDir, userId: lead, repoDirs: ['src'] }), /决策路由未保存/, '校验不过就不存');
  eq(profileOf(db, '').template, 'pm_tl', '没存：profile 还是 pm_tl');
}

section('5. 事项路由：解析写回 questions；next 转下一行；转交事项级');
{
  applyTemplate(db, { key: '', name: 'solo', userId: lead });
  // 加一条 src 范围行给 backend 组，超时 next → lead
  const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
  rules.push({ decision_type: 'spec_choice', scope: 'src', position: 0, recipients: ['group:backend', `inform:user:${carol}`], quorum: '1', conflict_policy: 'block', timeout_action: 'next', timeout_after: '8h' });
  rules.push({ decision_type: 'spec_choice', scope: 'src', position: 1, recipients: ['user:lead'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null });
  saveRules(db, { key: '', rules, userId: lead });
  const task = mkTask('改 src/core/x.mjs');
  const q = mkQ(task);
  const r = db.tx(() => routeQuestion(db, { questionId: q, decisionType: 'spec_choice', typeSource: 'self', at: t0 }));
  eq(r.answerers, [bob], 'src 范围 → backend 组的 bob');
  eq(r.informed, [], 'inform 的旁观者不进 informed（旁观者不收通知）');
  const row = db.one(`SELECT * FROM questions WHERE id=?`, q);
  eq(JSON.parse(row.addressed_to), [bob], 'addressed_to 写回');
  eq(row.decision_type, 'spec_choice', 'decision_type 写回');
  eq(row.route_due_at, t0 + 8 * 3600_000, 'route_due_at = 8h');
  eq(JSON.parse(row.route).stage, 0, 'stage 0');
  const adv = db.tx(() => advanceRoute(db, { questionId: q, at: t0 + 9 * 3600_000 }));
  eq(adv.answerers, [lead], 'next → lead');
  eq(db.one(`SELECT route_due_at FROM questions WHERE id=?`, q).route_due_at, null, '末行 hang：无到期');
  eq(db.tx(() => advanceRoute(db, { questionId: q })), null, '没有下一行 → null');
  // 转交
  throwsWith(() => transferQuestion(db, { questionId: q, to: [`user:${alice}`], byUserId: bob }), /只有该事项的接收人或负责人能转交/, '非收件人不能转交');
  const tr = transferQuestion(db, { questionId: q, to: [`user:${alice}`], byUserId: lead });
  eq(tr.to, [alice], '负责人把事项转给 alice');
  const q3 = mkQ(task, { level: 3 });
  db.tx(() => routeQuestion(db, { questionId: q3, decisionType: 'structural', typeSource: 'self', at: t0 }));
  throwsWith(() => transferQuestion(db, { questionId: q3, to: [`user:${alice}`], byUserId: lead }), /转交后，接收人仍须包含负责人/, 'Ⅲ 级转交仍须含负责人');
  eq(transferQuestion(db, { questionId: q3, to: [`user:${alice}`, 'user:lead'], byUserId: lead }).to, [alice, lead], '带上负责人就行');
  // 无前缀任务走 * 行
  const t2 = mkTask('.');
  const q2 = mkQ(t2);
  eq(db.tx(() => routeQuestion(db, { questionId: q2, decisionType: 'spec_choice', typeSource: 'self' })).answerers, [lead], '无前缀 → * 行 → lead');
}

section('6. 授权：查表不查 role；负责人恒可；旁观者恒不可');
{
  const task = mkTask('改 src/core/x.mjs');
  eq(authorize(db, { taskId: task, decisionType: 'spec_choice', userId: bob }).ok, true, 'bob 在 src 链里');
  eq(authorize(db, { taskId: task, decisionType: 'budget', userId: bob }).ok, false, 'bob 不在预算行');
  eq(authorize(db, { taskId: task, decisionType: 'budget', userId: lead }).ok, true, '负责人恒可');
  eq(authorize(db, { taskId: task, decisionType: 'spec_choice', userId: carol }).ok, false, '旁观者不可');
  assert(/的接收人不包含你/.test(authorize(db, { taskId: task, decisionType: 'budget', userId: bob }).why), '拒绝理由说清收件人');
}

section('7. 两个旋钮是投影；历史预演');
{
  const k = knobsOf(db, '');
  eq(k.lead, null, '默认表没有表级负责人（各任务各有各的 owner；不取"最早的管理员"）');
  eq(k.interveners, [bob], '介入者 = 各行收件人并集（去负责人、去旁观者）');
  eq(k.ownership.spec_choice, ['user:lead'], '归属 = * 行的收件人');
  const k2 = setKnobs(db, { key: '', ownership: { signoff: ['group:reviewer'] }, userId: lead });
  eq(k2.ownership.signoff, ['group:reviewer'], '改旋钮就是改表');
  eq(k2.interveners.sort(), [alice, bob].sort(), 'reviewer 组进了介入者名单');
  const k3 = setKnobs(db, { key: '', removeInterveners: [bob], userId: lead });
  eq(k3.ownership.signoff, ['group:reviewer'], '删介入者只删 user:<id>，组不动');
  throwsWith(() => setKnobs(db, { key: '', ownership: { structural: [`user:${alice}`] }, userId: lead }), /必须包含负责人/, '旋钮也过同一条校验');
  const pv = previewRouting(db, { key: '', rules: rulesOf(db, '') });
  assert(pv.questions >= 3, `预演看到 ${pv.questions} 条事项`);
  assert(pv.interruptions[lead] >= 1, `负责人被打断 ${pv.interruptions[lead]} 次`);
  eq(pv.conflicts, 0, '单人历史冲突数 0（如实）');
  eq(pv.unaddressed.length, 0, '没有落空的事项');
}

section('8. 类型只升不降；禁 default 按类型标记；默认表负责人 = 任务 owner；转交不降法定人数且只看类型集合');
{
  // ① 自报 + 单向升级兜底
  eq(decisionTypeOfQuestion({ kind: 'structural', text: '随便' }), { decisionType: 'structural', typeSource: 'self' }, '自报 structural 一律采信');
  eq(decisionTypeOfQuestion({ kind: 'spec', text: '契约规则 R2 与〔规格〕原文矛盾：规格说保留空行' }), { decisionType: 'structural', typeSource: 'hard_rule' }, '自报 spec 但正文命中硬规则：升为 structural（hard_rule）');
  eq(decisionTypeOfQuestion({ text: '依赖不成立：上游节点没交出 parse()' }), { decisionType: 'structural', typeSource: 'hard_rule' }, '没自报、命中"依赖不成立"');
  eq(decisionTypeOfQuestion({ kind: 'spec', text: '分号还是逗号？' }), { decisionType: 'spec_choice', typeSource: 'self' }, '自报 spec、不命中：规格取舍 self');
  eq(decisionTypeOfQuestion({ text: '分号还是逗号？' }), { decisionType: 'spec_choice', typeSource: 'default' }, '没自报、不命中：规格取舍 default');
  // ⑦ 预算 / 出网 / 签收禁 default（读 DECISION_TYPES.noDefault，不是名单）
  const solo = () => loadTemplates().solo.rows.map((r) => ({ ...r }));
  for (const t of ['budget', 'egress', 'signoff']) {
    const rows = solo(); const r = rows.find((x) => x.decision_type === t); r.timeout_action = 'default'; r.timeout_after = '1h';
    assert(DECISION_TYPES[t].noDefault && validateRules(db, '', rows).some((e) => new RegExp(`${DECISION_TYPES[t].label}不支持「按默认处理」`).test(e.msg)), `${DECISION_TYPES[t].label}行配 default 被拒`);
    r.timeout_action = 'next'; r.timeout_after = '1h'; rows.push({ ...r, position: 1, recipients: ['user:lead'], timeout_action: 'hang', timeout_after: null });
    assert(!validateRules(db, '', rows).some((e) => /不支持「按默认处理」|没有下一顺位/.test(e.msg)), `${DECISION_TYPES[t].label}行配 next 仍可`);
  }
  { const rows = solo(); const r = rows.find((x) => x.decision_type === 'spec_choice'); r.recipients = []; r.timeout_action = 'default'; r.timeout_after = '30m';
    assert(!validateRules(db, '', rows).some((e) => /不支持「按默认处理」/.test(e.msg)), '规格取舍行配 default 不受这条限制'); }
  { const rows = solo(); const r = rows.find((x) => x.decision_type === 'structural'); r.timeout_action = 'default'; r.timeout_after = '1h';
    assert(validateRules(db, '', rows).some((e) => /结构矛盾不支持「按默认处理」/.test(e.msg)), 'Ⅲ 级类型任何位置禁 default'); }

  // ④ 默认表 '' 下多个负责人：user:lead 解析成**该任务**的 owner，不是最早的 lead
  saveRules(db, { key: '', rules: solo(), userId: lead });
  const lead2 = addUser('lead2', 'lead');
  const tOther = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'t2','running',?)`, tOther, lead2, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), tOther, t0, t0);
  const qo = mkQ(tOther);
  eq(db.tx(() => routeQuestion(db, { questionId: qo, decisionType: 'spec_choice', typeSource: 'self', at: t0 })).answerers, [lead2], '默认表：user:lead = 任务 owner（lead2）');
  eq(authorize(db, { taskId: tOther, decisionType: 'budget', userId: lead2 }).ok, true, 'lead2 对自己的任务有权');
  eq(authorize(db, { taskId: tOther, decisionType: 'budget', userId: lead }).ok, false, '最早的 lead 对别人的任务无权');
  eq(previewRouting(db, { key: '', rules: solo() }).interruptions[lead2] >= 1, true, '预演也按各任务的 owner 算');

  // ⑥ 转交不得降法定人数（非负责人）；负责人可降；转交后按新行重算 route_due_at
  const rows = solo();
  const so = rows.find((x) => x.decision_type === 'signoff'); so.recipients = ['group:reviewer']; so.quorum = '2'; so.timeout_action = 'next'; so.timeout_after = '1bd';
  rows.push({ decision_type: 'signoff', scope: '*', position: 1, recipients: ['user:lead'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null });
  saveRules(db, { key: '', rules: rows, userId: lead });
  const task = mkTask('.');
  const qs = mkQ(task);
  db.tx(() => routeQuestion(db, { questionId: qs, decisionType: 'signoff', typeSource: 'hard_rule', at: t0 }));
  throwsWith(() => transferQuestion(db, { questionId: qs, to: [`user:${alice}`], byUserId: alice }), /法定人数为 2，转交后接收人只有 1 人/, 'alice 不能把两人签收转成自己一人');
  const tr1 = transferQuestion(db, { questionId: qs, to: [`user:${bob}`, `user:${alice}`], byUserId: alice, at: t0 + 1000 });
  eq(tr1.to.length, 2, '转给两人可以');
  eq(tr1.dueAt, addBusinessDays(t0 + 1000, 1), '转交后 route_due_at 按行的时限从转交时刻重算，不是清空');
  eq(JSON.parse(db.one(`SELECT route FROM questions WHERE id=?`, qs).route).rows[0].quorum, '2', '法定人数没变');
  const tr2 = transferQuestion(db, { questionId: qs, to: [`user:${alice}`], byUserId: lead, at: t0 + 2000 });
  eq(tr2.to, [alice], '负责人可以转给一人');
  eq(JSON.parse(db.one(`SELECT route FROM questions WHERE id=?`, qs).route).rows[0].quorum, '1', '负责人转交时法定人数封顶到 1');
  // ⑩ "必含负责人"只看类型集合：level 3 的规格取舍事项可以转给不含负责人的人
  const q3 = mkQ(task, { level: 3 });
  db.tx(() => routeQuestion(db, { questionId: q3, decisionType: 'spec_choice', typeSource: 'self', at: t0 }));
  eq(transferQuestion(db, { questionId: q3, to: [`user:${alice}`], byUserId: lead }).to, [alice], 'Ⅲ 级但类型是规格取舍：转交不强制含负责人');
  const q4 = mkQ(task, { level: 2 });
  db.tx(() => routeQuestion(db, { questionId: q4, decisionType: 'contract_approval', typeSource: 'hard_rule', at: t0 }));
  throwsWith(() => transferQuestion(db, { questionId: q4, to: [`user:${alice}`], byUserId: lead }), /方案批准事项转交后，接收人仍须包含负责人/, 'Ⅱ 级但类型是方案批准：仍须含负责人');
}


section('9. 结构化范围（迁移 v17）：契约直接给路径，判据不再从散文里抽');
{
  const mkTask = (scope, paths) => {
    const id = newId('t'), t = now();
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, id, lead, t);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,scope_paths,definition_of_done,constraints,valid_from,recorded_at)
            VALUES (?,?,1,'g',?,?,'d','[]',?,?)`, newId('c'), id, scope, JSON.stringify(paths ?? []), t, t);
    return id;
  };
  // 回落：这一列为空 = 老契约 = 行为与引入结构化范围之前**一字不差**
  const prose = '修改 src/core/limits.mjs 与 README.md；新增 test/x.test.mjs。不动 docs/';
  const old = mkTask(prose, []);
  eq(prefixesOf(db, old), prefixesOfScope(prose), '没给路径 → 前缀仍从散文里抽，与改动之前一字不差');
  eq(scopeFilesOf(db, old), filesOfScope(prose), '文件同理');

  // 结构化：散文写什么都不影响判据
  const now1 = mkTask('随便写点什么，这段话不参与执法', ['src/store/', 'package.json', 'src/web/index.html']);
  eq(prefixesOf(db, now1), ['src/store'], '只有带 / 结尾的才是目录前缀');
  eq(scopeFilesOf(db, now1), ['package.json', 'src/web/index.html'], '不带 / 的是具体文件，子目录里的文件也认');

  // 这正是散文抽取器抽不出来的那一类：子目录里的单个文件
  eq(prefixesOfScope('只改 src/web/index.html'), ['src/web'], '散文抽取器只能退到目录 —— 于是整个 src/web/ 都被放行');
  assert(!prefixesOf(db, now1).includes('src/web'), '结构化之后 src/web/ 不再整个放行，只放行点名的那一个文件');

  // 形状护栏：纯形状，不查仓库里有没有这个路径（任务常常要新建文件）
  eq(scopePathProblems(['src/a/', 'package.json', '*']), [], '正常值、含 * 都过');
  eq(scopePathProblems([]).length, 0, '空数组过（护栏另有一条"规划器必须给"，见 validateProjectSpec）');
  eq(scopePathProblems('src/'), ['要是字符串数组；没有可写的路径就给 []'], '不是数组就拒');
  assert(scopePathProblems(['/etc/passwd'])[0].includes('绝对路径'), '绝对路径拒');
  assert(scopePathProblems(['src/../../etc'])[0].includes('..'), '.. 拒');
  assert(scopePathProblems(['src/**/*.mjs'])[0].includes('通配符'), '通配符拒');
  assert(scopePathProblems(['src\\core'])[0].includes('反斜杠'), '反斜杠拒');
  assert(scopePathProblems([''])[0].includes('非空字符串'), '空串拒');
  eq(normScopePaths([' src//a/ ', './src/a/', 'src/a/']), ['src/a/'], '归一化：去空白、合并重复斜杠、去 ./、去重');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
