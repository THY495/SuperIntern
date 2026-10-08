// 项目级设置：上限三层继承 / 项目预算闸 / 项目级验收命令 / 自动化挡位。
//
// 跑：node tests/project-settings.test.mjs
//
// 这一套断言的是**"当前值来自哪一层"这句话在代码里只有一个出处**。三层继承最容易出的错不是
// 算错数，而是同一个回落顺序被抄了三遍：一处改了、另两处没改，界面上写着"来自项目默认"而
// 实际执行的是部署默认 —— 那种错没有任何测试会自己发现，因为两个数字多数时候恰好相等。

import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { limitChain, limitOf, setLimit, setProjectLimit, projectLimits, LIMITS, contextCapOf, checkLimits } from '../src/core/limits.mjs';
import { getProjectParam, setProjectParam } from '../src/core/params.mjs';
import { getSetting, setSetting } from '../src/core/settings.mjs';
import {
  budgetState, setProjectBudget, raiseProjectBudget, gearOf, setGear, gearPrereqStatus,
  projectVerifyCommand, setProjectVerify, BUDGET_KEY,
} from '../src/core/project-settings.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, re, m) => { try { fn(); bad(m, '没有抛错'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, `错误文本不匹配：${e.message}`); } };

const db = openDb(':memory:');
const owner = ensureOwner(db);
const T0 = now();

const mkProject = (title = 'P') => {
  const id = newId('pj');
  db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at)
          VALUES (?,?,?,'/tmp/r','b','r','active',?)`, id, owner.userId, title, T0);
  return id;
};
const mkTask = (projectId = null, order = null) => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order)
          VALUES (?,?,'T','running',?,?,?)`, id, owner.userId, T0, projectId, order);
  return id;
};

const spend = (taskId, micro) => db.run(
  `INSERT INTO usage_ledger (task_id,role,model_tier,provider,model_id,input_tokens,output_tokens,micro_usd,billing,ts)
   VALUES (?,'executor','light','x','m',0,0,?,'computed',?)`, taskId, micro, T0);

const K = 'limit.budget_micro_usd';

// ═══════════════════════════════════════════════════════════════════════════
section('1. 三层继承：部署默认 → 项目默认 → 任务覆盖');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  const t = mkTask(pj, 1);

  let c = limitChain(db, t, K);
  eq(c.value, LIMITS[K].def, '都没设过 → 部署默认');
  eq(c.source, 'deploy', '来源标 deploy');
  eq(c.project, null, '项目层为空');
  eq(c.task, null, '任务层为空');

  setProjectLimit(db, { projectId: pj, key: K, value: 2_000_000, userId: owner.userId });
  c = limitChain(db, t, K);
  eq(c.value, 2_000_000, '设了项目默认 → 用项目的');
  eq(c.source, 'project', '来源标 project');
  eq(c.deploy, LIMITS[K].def, '部署默认照旧看得见（界面要能说"部署默认是多少"）');

  setLimit(db, { taskId: t, key: K, value: 500_000, userId: owner.userId });
  c = limitChain(db, t, K);
  eq(c.value, 500_000, '任务覆盖压过项目默认');
  eq(c.source, 'task', '来源标 task');
  eq(c.project, 2_000_000, '被压住的那一层仍然看得见');

  eq(limitOf(db, t, K), 500_000, 'limitOf 就是 limitChain().value —— 回落顺序只有一个出处');
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. 不在项目里的任务：项目层恒为空，行为与从前一字不差');
// ═══════════════════════════════════════════════════════════════════════════
{
  const t = mkTask(null, null);
  const c = limitChain(db, t, K);
  eq(c.value, LIMITS[K].def, '独立任务用部署默认');
  eq(c.project, null, '没有项目就没有项目层');
  setLimit(db, { taskId: t, key: K, value: 123_456, userId: owner.userId });
  eq(limitOf(db, t, K), 123_456, '任务覆盖照常');
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 项目层是另一个项目的事，不会串台');
// ═══════════════════════════════════════════════════════════════════════════
{
  const a = mkProject('A'), b = mkProject('B');
  const ta = mkTask(a, 1), tb = mkTask(b, 1);
  setProjectLimit(db, { projectId: a, key: 'limit.llm_calls', value: 7, userId: owner.userId });
  eq(limitOf(db, ta, 'limit.llm_calls'), 7, 'A 的任务拿 A 的项目默认');
  eq(limitOf(db, tb, 'limit.llm_calls'), LIMITS['limit.llm_calls'].def, 'B 的任务不受影响');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 清掉项目默认 = 回落，不是设成 0');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  const t = mkTask(pj, 1);
  setProjectLimit(db, { projectId: pj, key: K, value: 1_000_000, userId: owner.userId });
  eq(limitOf(db, t, K), 1_000_000, '先设上');
  setProjectLimit(db, { projectId: pj, key: K, value: null, userId: owner.userId });
  const c = limitChain(db, t, K);
  eq(c.value, LIMITS[K].def, '清掉后回落到部署默认');
  eq(c.source, 'deploy', '来源跟着回落');
  // 这一条是 D 的形状：Number(null) === 0，少一道判断就会把"没设过"读成"上限 0"，
  // 表现是每个任务一开跑就报"花费已达上限：$0.0000"。
  assert(c.value > 0, '没设过绝不退化成 0（Number(null) 的坑）');
  eq(db.one(`SELECT count(*) n FROM params WHERE project_id=? AND key=?`, pj, K).n, 1, '历史行保留（supersede 不 delete）');
  eq(db.one(`SELECT count(*) n FROM params WHERE project_id=? AND key=? AND superseded_at IS NULL`, pj, K).n, 0, '清掉后没有有效行');
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 项目层与部署级设置互不串台（params 的 task_id 都是 NULL）');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  // 部署级设置与项目层参数的行都是 task_id NULL —— 少一句 project_id IS NULL 就会互相读到对方。
  setSetting(db, { key: 'deploy.create_admin_only', value: true, userId: owner.userId });
  setProjectParam(db, { projectId: pj, key: 'deploy.create_admin_only', value: false, by: { kind: 'user', id: owner.userId }, governance: 'constitutional' });
  eq(getSetting(db, 'deploy.create_admin_only'), true, '部署级读到的还是部署级的值');
  eq(getProjectParam(db, pj, 'deploy.create_admin_only'), false, '项目层读到的是项目层的值');
  setSetting(db, { key: 'deploy.create_admin_only', value: false, userId: owner.userId });
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 校验与越界');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  rejects(() => setProjectLimit(db, { projectId: pj, key: 'limit.nope', value: 1, userId: owner.userId }), /上限项无效/, '不认识的上限项拒收');
  rejects(() => setProjectLimit(db, { projectId: pj, key: K, value: 0, userId: owner.userId }), /正数/, '0 不是"不限"，拒收');
  rejects(() => setProjectLimit(db, { projectId: pj, key: K, value: -5, userId: owner.userId }), /正数/, '负数拒收');
  const row = db.one(`SELECT governance_class g, set_by_kind k, layer l FROM params WHERE project_id=? AND key='limit.llm_calls'`, mkProject());
  assert(!row, '没设过就没有行');
  setProjectLimit(db, { projectId: pj, key: K, value: 9_000_000, userId: owner.userId });
  const r2 = db.one(`SELECT governance_class g, set_by_kind k, layer l FROM params WHERE project_id=? AND key=? AND superseded_at IS NULL`, pj, K);
  eq(r2.g, 'constitutional', '项目默认上限是宪法层参数');
  eq(r2.k, 'user', '只能由人写（库层 CHECK）');
  eq(r2.l, 'project', 'layer=project');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_limit_set' AND target_id=?`, pj).n, 1, '留审计');
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. 设置页要的那张表：每一项都带"当前值 + 来自哪一层"');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  setProjectLimit(db, { projectId: pj, key: K, value: 3_000_000, userId: owner.userId });
  const rows = projectLimits(db, pj);
  eq(rows.length, Object.keys(LIMITS).length, '每个旋钮一行，一个不漏');
  const b = rows.find((r) => r.key === K);
  eq(b.source, 'project', '设过的标 project');
  eq(b.valueText, '$3.0000', '当前值按维度的格式渲染');
  eq(b.deployText, LIMITS[K].fmt(LIMITS[K].def), '部署默认也渲染出来，人才能判断自己改动了多少');
  const other = rows.find((r) => r.key === 'limit.llm_calls');
  eq(other.source, 'deploy', '没设过的标 deploy');
  eq(other.project, null, '没设过的项目层是 null 不是 0');
  assert(rows.some((r) => r.onHit === 'hard_fail'), '硬边界类也列出来（能设，但触顶不给加额）');
}

// ═══════════════════════════════════════════════════════════════════════════
section('8. 上下文那一维：模型封顶与三层的关系不变，只多说一句来自哪层');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  const t = mkTask(pj, 1);
  eq(contextCapOf(db, t, { contextWindow: null }).layer, 'deploy', '没设过 → deploy');
  setProjectLimit(db, { projectId: pj, key: 'limit.context_tokens', value: 120_000, userId: owner.userId });
  const c = contextCapOf(db, t, { contextWindow: null });
  eq(c.cap, 120_000, '项目默认生效');
  eq(c.source, 'param', "对触顶文案来说项目默认也算'人设过的'");
  eq(c.layer, 'project', '具体是哪一层另给一个字段');
  eq(contextCapOf(db, t, { contextWindow: 128_000 }).cap, 96_000, '模型窗口更小仍然压过人设的（封顶只会往小走）');
}

// ═══════════════════════════════════════════════════════════════════════════
section('9. 预算闸：默认不设；不设 = 没有闸门');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  const t = mkTask(pj, 1);
  spend(t, 4_000_000);           // 顶到任务默认上限以下，单看项目闸门这一维
  const b = budgetState(db, pj);
  eq(b.gate, null, '默认不设闸门');
  eq(b.over, false, '没有闸门就永远撞不到');
  eq(b.remaining, null, '剩余无意义');
  assert(/没有设预算闸/.test(b.human), '人话里说清没设');
  eq(checkLimits(db, t, {}), null, '体检也不报 —— 花了多少都不是撞闸');
}

// ═══════════════════════════════════════════════════════════════════════════
section('10. 预算闸：累计跨任务，撞闸进体检');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  const a = mkTask(pj, 1), b2 = mkTask(pj, 2), carrier = mkTask(pj, 0);
  setProjectBudget(db, { projectId: pj, microUsd: 1_000_000, userId: owner.userId });
  spend(a, 400_000); spend(b2, 300_000); spend(carrier, 100_000);
  let st = budgetState(db, pj);
  eq(st.spent, 800_000, '累计的是整个项目，含载体任务上追问 / 规划的钱');
  eq(st.remaining, 200_000, '剩余算得出');
  eq(st.over, false, '还没撞');
  eq(checkLimits(db, a, {}), null, '没撞就不报');

  spend(b2, 250_000);
  st = budgetState(db, pj);
  eq(st.over, true, '越过闸门');
  const breach = checkLimits(db, a, {});
  assert(breach && breach.scope === 'project', '体检报出来，标成项目范围');
  eq(breach.key, 'project.budget_micro_usd', '键与任务级的 limit.budget_micro_usd 分开 —— 触顶文案不能指错旋钮');
  eq(breach.projectId, pj, '带上是哪个项目');
}

// ═══════════════════════════════════════════════════════════════════════════
section('11. 任务自己的闸门先说话');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  const t = mkTask(pj, 1);
  setProjectBudget(db, { projectId: pj, microUsd: 1_000_000, userId: owner.userId });
  setLimit(db, { taskId: t, key: K, value: 100_000, userId: owner.userId });
  spend(t, 2_000_000);           // 两道闸门同时撞
  const breach = checkLimits(db, t, {});
  eq(breach.key, K, '任务级的排在前面：该改的旋钮是这个任务的上限，不是项目闸门');
  eq(breach.scope, undefined, '任务级的不带 scope');
}

// ═══════════════════════════════════════════════════════════════════════════
section('12. 撞闸只报一次事项');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  const t = mkTask(pj, 1);
  setProjectBudget(db, { projectId: pj, microUsd: 500_000, userId: owner.userId });
  spend(t, 600_000);
  const q1 = raiseProjectBudget(db, { projectId: pj, taskId: t });
  eq(q1.existed, false, '第一次真的建了一条');
  const row = db.one(`SELECT level, level_source, status, task_id FROM questions WHERE id=?`, q1.questionId);
  eq(row.level, 3, 'Ⅲ 级（无默认动作、无超时）');
  eq(row.level_source, 'hard_rule', '硬规则定级，不是模型判的');
  eq(row.task_id, t, '挂在任务上 —— questions 是任务键的，路由表按项目键，挂哪个任务都解析得对');
  assert(/已花 \$0\.6000 \/ 闸门 \$0\.5000/.test(db.one(`SELECT text FROM questions WHERE id=?`, q1.questionId).text), '正文里两个数都在');
  const q2 = raiseProjectBudget(db, { projectId: pj, taskId: t });
  eq(q2.existed, true, '第二次不再建 —— 每个任务各报一条会把收件箱刷满');
  eq(q2.questionId, q1.questionId, '返回的是同一条');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_budget_breached' AND target_id=?`, pj).n, 1, '审计也只一条');
  // 出处边：这条事项因为哪一行闸门而存在。
  const origin = db.one(`SELECT id FROM params WHERE project_id=? AND key=? AND superseded_at IS NULL`, pj, BUDGET_KEY).id;
  assert(!!db.one(`SELECT 1 FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from'`, q1.questionId, origin), '出处边指向那一行闸门');
}

// ═══════════════════════════════════════════════════════════════════════════
section('13. 预算闸的校验');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  rejects(() => setProjectBudget(db, { projectId: pj, microUsd: 0, userId: owner.userId }), /正数/, '0 不是"不限"，拒收');
  rejects(() => setProjectBudget(db, { projectId: pj, microUsd: -1, userId: owner.userId }), /正数/, '负数拒收');
  const t = mkTask(pj, 1);
  spend(t, 800_000);
  setProjectBudget(db, { projectId: pj, microUsd: 100_000, userId: owner.userId });
  eq(budgetState(db, pj).over, true, '设成比已花的还低 —— 不拦（人想让它立刻停下来是合法动作）');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_budget_below_spent' AND target_id=?`, pj).n, 1, '但留一条审计，别让人以为没发生过');
  setProjectBudget(db, { projectId: pj, microUsd: null, userId: owner.userId });
  eq(budgetState(db, pj).gate, null, '清空 = 撤掉闸门');
}

// ═══════════════════════════════════════════════════════════════════════════
section('14. 挡位：默认提议；自动挡的四条前提缺一不可');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  eq(gearOf(db, pj), 'propose', '默认是提议挡 —— 沉默的默认永远不是自动');
  rejects(() => setGear(db, { projectId: pj, gear: 'auto', userId: owner.userId }), /挂不上自动挡.*预算闸/, '缺预算闸 → 挂不上，并说出缺哪条');
  setProjectBudget(db, { projectId: pj, microUsd: 5_000_000, userId: owner.userId });
  rejects(() => setGear(db, { projectId: pj, gear: 'auto', userId: owner.userId }), /挂不上自动挡.*验收命令/, '缺项目级验收命令 → 仍挂不上');
  setProjectVerify(db, { projectId: pj, command: 'node tests/run.mjs --all', userId: owner.userId });
  const st = gearPrereqStatus(db, pj);
  eq(st.length, 4, '四条前提逐条列出');
  assert(st.every((p) => p.ok), '四条都满足');
  setGear(db, { projectId: pj, gear: 'auto', userId: owner.userId });
  eq(gearOf(db, pj), 'auto', '挂上了');
  rejects(() => setGear(db, { projectId: pj, gear: 'turbo', userId: owner.userId }), /挡位无效/, '不认识的挡位拒收');
}

// ═══════════════════════════════════════════════════════════════════════════
section('15. 前提被撤掉 → 自动挡当场掉回提议挡');
// ═══════════════════════════════════════════════════════════════════════════
{
  const mk = () => {
    const pj = mkProject();
    setProjectBudget(db, { projectId: pj, microUsd: 5_000_000, userId: owner.userId });
    setProjectVerify(db, { projectId: pj, command: 'npm test', userId: owner.userId });
    setGear(db, { projectId: pj, gear: 'auto', userId: owner.userId });
    return pj;
  };
  // 这一条是判据："自动挡"不是一个记在库里的状态，而是四条前提的合取。留着一个前提不成立的
  // 自动挡，等于让 AI 在没有边界的情况下自己开工 —— 那正是挡位要防的事。
  const a = mk();
  setProjectBudget(db, { projectId: a, microUsd: null, userId: owner.userId });
  eq(gearOf(db, a), 'propose', '撤掉预算闸 → 掉回提议挡');
  const b3 = mk();
  setProjectVerify(db, { projectId: b3, command: '', userId: owner.userId });
  eq(gearOf(db, b3), 'propose', '清空项目级验收命令 → 掉回提议挡');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='project_gear_set' AND target_id=?`, b3).n, 2, '挂挡与掉挡各一条审计');
}

// ═══════════════════════════════════════════════════════════════════════════
section('16. 项目级验收命令：与任务级同一道护栏');
// ═══════════════════════════════════════════════════════════════════════════
{
  const pj = mkProject();
  eq(projectVerifyCommand(db, pj), null, '默认没有（选填）');
  rejects(() => setProjectVerify(db, { projectId: pj, command: 'npm test && npm run lint', userId: owner.userId }), /shell 语法/, '不经 shell：&& 拒收');
  rejects(() => setProjectVerify(db, { projectId: pj, command: 'a | b', userId: owner.userId }), /shell 语法/, '管道拒收');
  setProjectVerify(db, { projectId: pj, command: '  node tests/run.mjs  --all ', userId: owner.userId });
  eq(JSON.stringify(projectVerifyCommand(db, pj)), JSON.stringify(['node', 'tests/run.mjs', '--all']), '按空白切成 argv');
  setProjectVerify(db, { projectId: pj, command: '', userId: owner.userId });
  eq(projectVerifyCommand(db, pj), null, '空 = 清掉');
}

section('环境准备：没人填就按依赖清单自动识别');
{
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { detectSetupCommands, effectiveSetupOf, setSetupCommands, setupFingerprint, sandboxFlavorOf } = await import('../src/core/project-settings.mjs');
  const D = mkdtempSync(join(tmpdir(), 'si-setup-'));
  const cmds = () => detectSetupCommands(D).argvs.map((a) => a.join(' '));
  eq(JSON.stringify(cmds()), '[]', '空仓库：没有要装的（等任务写出清单再说）');
  mkdirSync(join(D, 'backend')); mkdirSync(join(D, 'frontend'));
  writeFileSync(join(D, 'backend', 'requirements.txt'), 'fastapi\n');
  writeFileSync(join(D, 'frontend', 'package.json'), '{"name":"web"}');
  writeFileSync(join(D, 'frontend', 'package-lock.json'), '{}');
  writeFileSync(join(D, 'package.json'), '{"name":"root"}');
  eq(JSON.stringify(cmds()), JSON.stringify(['python -m venv .venv', '.venv/bin/pip install -r backend/requirements.txt',
    'npm install --no-audit --no-fund --no-package-lock', 'npm ci --no-audit --no-fund --prefix frontend']),
    '前后端分目录：一个根 venv 装后端依赖；前端有锁文件用 npm ci --prefix；根 package.json 没锁文件用 npm install --no-package-lock（不在工作区里生成没人提交的锁文件）');
  mkdirSync(join(D, 'api')); writeFileSync(join(D, 'api', 'pyproject.toml'), '[project]\nname="api"\n');
  assert(cmds().includes('.venv/bin/pip install -e api'), '只有 pyproject.toml 的目录：pip install -e');
  const fp1 = setupFingerprint(detectSetupCommands(D).argvs, detectSetupCommands(D).manifests);
  writeFileSync(join(D, 'backend', 'requirements.txt'), 'fastapi\nuvicorn\n');
  const fp2 = setupFingerprint(detectSetupCommands(D).argvs, detectSetupCommands(D).manifests);
  assert(fp1 !== fp2, '清单内容变了（加了依赖）→ 指纹变 → 下次开跑重装；命令没变也一样');
  const P = mkProject('setup');
  eq(effectiveSetupOf(db, P, D).source, 'auto', '没人填：自动');
  setSetupCommands(db, { projectId: P, commands: 'make deps', userId: owner.userId });
  const e = effectiveSetupOf(db, P, D);
  eq(`${e.source}|${e.argvs.map((a) => a.join(' ')).join(';')}`, 'manual|make deps', '人填了：以人填的为准，不再自动识别');
  setSetupCommands(db, { projectId: P, commands: '', userId: owner.userId });
  eq(effectiveSetupOf(db, P, D).source, 'auto', '清空就回到自动');
  eq(sandboxFlavorOf(db, P), 'python', '沙箱默认带 Python（选 FastAPI 的项目从空仓库起就能用）');
  try { rmSync(D, { recursive: true, force: true }); } catch { /* Windows */ }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
db.close();
process.exit(fail ? 1 : 0);
