// 按角色绑定模型、验收员与执行器异厂商
//
// 跑：node tests/role-binding.test.mjs
//
//   ① 客户端解析：角色单独绑了就用那个模型、不看档位；推理强度优先级；项目追加记在项目规划下；
//   ② 写入：角色闭集（代码与库层 CHECK 两道）、能不能绑与档位同一套校验、取消回到档位、审计；单独绑着的模型 / 服务商不许停用、删除；
//   ③ 验收员用谁：同一家时换一家（先看部署在用的服务商，再看其余有 key 的）；不强求时不换；只有一家时说清；人单独绑的照人的意思；会签时避开第一个；
//   ④ 会签合并：都通过才过；有人打回就打回、理由合并；没人打回但有人没结论 → 按没结论；
//   ⑤ 接进编排器：验收审计里记着用的哪个模型、为什么、执行器是哪家；高风险步骤开会签时请两个验收员，一个打回就打回。

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { MODEL_CATALOG, VENDORS, TIER_BINDING, LLM_ROLES, bindRoleOf } from '../src/llm/canonical.mjs';
import { makerOf } from '../src/llm/canonical.mjs';
import { setRoleBinding, roleBindingOf, pickVerifierModel, registryFor, saveModel, setEndpointEnabled, rolesView } from '../src/llm/registry.mjs';
import { combineVerdicts } from '../src/agent/verifier.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throws = (f, re, m) => { try { f(); bad(m, '没有抛错'); } catch (e) { re.test(e.message) ? ok(m) : bad(m, e.message); } };

const TMP = mkdtempSync(join(tmpdir(), 'si-roles-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

section('① 客户端解析');
{
  const c = new LlmClient({ mode: 'live', roleBinding: { verifier: { key: 'anthropic/claude-sonnet-5', effort: 'low' }, project_planner: { key: 'openai/gpt-5.6-terra', effort: null } },
    tierEfforts: { standard: 'high' } });
  eq(c.entryFor('standard', 'verifier').key, 'anthropic/claude-sonnet-5', '验收单独绑了：用那个模型，不看 standard 档');
  eq(c.entryFor('standard', 'executor').key, TIER_BINDING.standard, '执行没单独绑：照档位');
  eq(c._resolve({ tier: 'heavy', role: 'project_append_review' }).key, 'openai/gpt-5.6-terra', '项目追加的复核记在项目规划下（与账本同一口径）');
  eq([c._resolve({ tier: 'standard', role: 'verifier' }).roleEffort, c._resolve({ tier: 'heavy', role: 'project_planner' }).roleEffort, c._resolve('standard').roleEffort],
    ['low', null, undefined], '推理强度：单独绑定写了用它；单独绑了没写 = 不看档位那一档的；没单独绑 = 走档位');
  eq(Object.keys(LLM_ROLES).every((r) => bindRoleOf(r) === r), true, '可绑的角色名就是请求里的 role');
}

section('② 写入：校验、取消、审计、在用不许停');
{
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  throws(() => setRoleBinding(db, { role: 'nobody', modelKey: TIER_BINDING.standard, userId }), /角色无效/, '不认识的角色：代码先拦');
  throws(() => db.run(`INSERT INTO llm_role_bindings (role,model_key,updated_at) VALUES ('nobody','x',1)`), /CHECK/, '库层 CHECK 也拦（写进去只会静默不生效）');
  throws(() => setRoleBinding(db, { role: 'verifier', modelKey: 'nope/none', userId }), /无法分配/, '目录里没有的模型：与档位绑定同一套校验');
  throws(() => setRoleBinding(db, { role: 'verifier', modelKey: 'anthropic/claude-haiku-4-5', effort: 'high', userId }), /推理强度/, '模型不支持的推理强度：拦');
  setRoleBinding(db, { role: 'verifier', modelKey: 'anthropic/claude-sonnet-5', effort: 'medium', userId });
  eq(roleBindingOf(db), { verifier: { key: 'anthropic/claude-sonnet-5', effort: 'medium' } }, '写进去了');
  eq(rolesView(db).find((r) => r.role === 'verifier').source, 'role', '设置页能看出来自哪一层');
  eq(registryFor(db).roleBinding.verifier.key, 'anthropic/claude-sonnet-5', '建客户端时带上（每个节点重读库）');
  throws(() => saveModel(db, { key: 'anthropic/claude-sonnet-5', fields: { enabled: false }, userId }), /角色 verifier 单独绑着/, '单独绑着的模型不许停用');
  throws(() => setEndpointEnabled(db, { id: 'anthropic', enabled: false, userId }), /角色 verifier 单独绑着/, '单独绑着的服务商不许停用');
  setRoleBinding(db, { role: 'verifier', modelKey: null, userId });
  eq([roleBindingOf(db), rolesView(db).find((r) => r.role === 'verifier').source], [{}, 'tier'], '取消 = 回到档位');
  eq(db.all(`SELECT action FROM audit_log WHERE action='role_binding_set'`).length, 2, '每次改动记审计 role_binding_set');
  db.close();
}

section('③ 验收员用谁');
{
  // 生效的服务商表（带 enabled 等库层叠加后的字段），不用代码里的原始常量
  const reg = { ...registryFor(openDb(':memory:')), roleBinding: {} };
  const env2 = { DEEPSEEK_API_KEY: 'x', ANTHROPIC_API_KEY: 'x' }, env1 = { DEEPSEEK_API_KEY: 'x' };
  const p1 = pickVerifierModel(reg, { executorVendor: 'deepseek', env: env2 });
  eq([p1.key, p1.source, p1.sameMaker], ['anthropic/claude-sonnet-5', 'policy', false], '执行在 deepseek、验收那档也是 deepseek：换到部署在用的另一家（anthropic 的验收那一档）');
  eq(pickVerifierModel(reg, { executorVendor: 'anthropic', env: env2 }).source, 'tier', '执行在别家：验收照档位，不必换');
  eq(pickVerifierModel(reg, { executorVendor: 'deepseek', policy: 'same', env: env2 }).key, TIER_BINDING.standard, '不强求：不换');
  const p2 = pickVerifierModel(reg, { executorVendor: 'deepseek', env: env1 });
  eq([p2.key, p2.note, p2.sameMaker], [TIER_BINDING.standard, 'only_maker', true], '只有一家有 key：只好同一家，并说清');
  const p3 = pickVerifierModel({ ...reg, roleBinding: { verifier: { key: 'deepseek/deepseek-v4-pro' } } }, { executorVendor: 'deepseek', env: env2 });
  eq([p3.source, p3.note], ['role', 'role_same'], '人单独绑的验收模型：照人的意思，不换（标出同一家）');
  const p4 = pickVerifierModel(reg, { executorVendor: 'deepseek', avoid: ['anthropic'], env: { ...env2, OPENAI_API_KEY: 'x' } });
  eq(p4.key, 'openai/gpt-5.6-terra', '会签的第二个：避开执行器与第一个，换第三家');
}

section('③b 网关：按模型出自哪家比，不按服务商比');
{
  const reg0 = registryFor(openDb(':memory:'));
  const { catalog, vendors } = reg0;
  eq([makerOf(catalog['openrouter/kimi-k3@moonshotai'], vendors), makerOf(catalog['openrouter/claude-opus-5'], vendors),
    makerOf(catalog['anthropic/claude-opus-5'], vendors), makerOf(catalog['gemini/gemini-3.6-flash'], vendors)],
    ['moonshotai', 'anthropic', 'anthropic', 'google'], '网关取模型名前缀；直连就是服务商（gemini 记作 google）');
  eq(makerOf({ vendor: 'openrouter', model: 'x/y', maker: 'acme' }, vendors), 'acme', '目录项写了 maker 就用它');
  const K = 'openrouter/kimi-k3@moonshotai';
  const allOr = { ...reg0, roleBinding: {}, binding: { light: K, standard: K, heavy: K } };
  const orOnly = { OPENROUTER_API_KEY: 'x' };
  const g1 = pickVerifierModel(allOr, { executorKey: K, env: orOnly });
  eq([g1.vendor, g1.maker, g1.source, g1.sameMaker], ['openrouter', 'anthropic', 'policy', false], '全走 OpenRouter、执行与验收都是 Kimi：在同一个网关里换一家出品方');
  const mixed = { ...allOr, binding: { light: K, standard: 'deepseek/deepseek-flash', heavy: K } };
  eq(pickVerifierModel(mixed, { executorKey: K, env: { ...orOnly, DEEPSEEK_API_KEY: 'x' } }).source, 'tier', '执行 Kimi（网关）、验收档是直连 DeepSeek：本来就是两家，不换');
  const g2 = pickVerifierModel({ ...allOr, binding: { light: K, standard: K, heavy: K } }, { executorKey: K, env: { ...orOnly, DEEPSEEK_API_KEY: 'x' } });
  eq(g2.key, 'deepseek/deepseek-flash', '网关里没绑过的模型排在有 key 的直连之后（没跑过，上游可能被拦；目录顺序也不按价位）');
  const g2b = pickVerifierModel({ ...allOr, binding: { light: K, standard: K, heavy: 'openrouter/claude-opus-5' } }, { executorKey: K, env: { ...orOnly, DEEPSEEK_API_KEY: 'x' } });
  eq(g2b.key, 'openrouter/claude-opus-5', '网关里别的档位已绑着的别家模型：算用过，排在没用过的直连之前');
  const viaGw = { ...reg0, roleBinding: {}, binding: { light: K, standard: 'openrouter/claude-opus-5@anthropic', heavy: K } };
  const g3 = pickVerifierModel(viaGw, { executorKey: 'anthropic/claude-opus-5', env: { ...orOnly, ANTHROPIC_API_KEY: 'x' } });
  eq([g3.key, g3.sameMaker], [K, false], '直连 Claude 与经网关的 Claude 是同一家：换走');
  // 地区拦掉的模型由人在模型页停用；停用的不当候选
  const off = { ...allOr, catalog: Object.fromEntries(Object.entries(catalog).map(([k, m]) => [k, m.vendor === 'openrouter' && k !== K ? { ...m, enabled: false } : m])) };
  const g4 = pickVerifierModel(off, { executorKey: K, env: orOnly });
  eq([g4.key, g4.note, g4.sameMaker], [K, 'only_maker', true], '网关里别家的模型都停用了：只好同一家，并说清');
}

section('④ 会签合并');
{
  const A = { verdict: 'accept', reasons: [], defects: [], pushbacks: [], noVerdict: false, evidence: ['a'], llmCalls: 2 };
  const R = { verdict: 'reject', reasons: ['缺 x'], defects: [{ category: 'spec', summary: '缺 x', locations: [] }], pushbacks: [], noVerdict: false, evidence: [], llmCalls: 3 };
  const N = { verdict: 'reject', reasons: ['没结论'], defects: [], pushbacks: [], noVerdict: true, stopped: 'max_iterations', llmCalls: 1 };
  eq([combineVerdicts([A, A]).verdict, combineVerdicts([A, A]).llmCalls], ['accept', 4], '都通过才过');
  const ar = combineVerdicts([A, R]);
  eq([ar.verdict, ar.noVerdict, ar.reasons, ar.defects.length], ['reject', false, ['缺 x'], 1], '有一个打回：打回，理由与缺陷照给执行器');
  eq(combineVerdicts([R, N]).noVerdict, false, '一个打回一个没结论：按打回（有实打实的缺陷）');
  eq([combineVerdicts([A, N]).noVerdict, combineVerdicts([A, N]).stopped], [true, 'max_iterations'], '一个通过一个没结论：按没结论，不拿另一个的通过顶上');
}

section('⑤ 接进编排器');
{
  const saved = { a: process.env.ANTHROPIC_API_KEY, d: process.env.DEEPSEEK_API_KEY, o: process.env.OPENAI_API_KEY, g: process.env.GEMINI_API_KEY };
  // 只在本进程里放两个假的变量（fake 模式不发请求），让"有第二家"成立
  process.env.ANTHROPIC_API_KEY = 'test-only'; process.env.DEEPSEEK_API_KEY = 'test-only'; delete process.env.OPENAI_API_KEY; delete process.env.GEMINI_API_KEY;
  const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  const call = (name, args) => ({ stopReason: 'tool_call', content: [{ type: 'tool_call', id: `c_${name}_${Math.random()}`, name, args }], usage: { inputTokens: 10, outputTokens: 5 } });
  const verdict = (v) => call('submit_verdict', v === 'accept' ? { verdict: 'accept', evidence_checked: ['a.txt'] } : { verdict: 'reject', defects: [{ category: 'spec', summary: '内容不对', locations: ['a.txt'] }], evidence_checked: ['a.txt'] });
  const handoff = { artifacts: [{ path: 'a.txt' }], interface_contract: '-', acceptance_evidence: 'cat a.txt', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] };
  const mk = (db, userId, risk) => {
    const id = newId('t'), t = now();
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'role-binding',?,?)`, id, userId, 'running', t);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'写文件','.','有文件','[]',?,?)`, newId('c'), id, t, t);
    const nid = newId('n');
    db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES (?,?,'写文件','写 a.txt','a.txt 存在','pending',?,'standard',?)`, nid, id, risk, t);
    const ws = join(TMP, 'ws', id); mkdirSync(ws, { recursive: true }); writeFileSync(join(ws, 'README.md'), '# x\n');
    git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init'); git(ws, 'checkout', '-q', '-b', 'v0/t');
    return { id, nid, ws };
  };
  const run = async (db, task, verdicts) => {
    let n = 0;
    const fake = makeRoleFake({
      executor: (canon, i) => (i % 2 === 0 ? call('write_file', { path: 'a.txt', content: `v${i}\n` }) : call('submit_handoff', handoff)),
      verifier: () => verdict(verdicts[n++] ?? 'accept'),
    });
    await orchestrate(db, { taskId: task.id, workspace: task.ws, narrativeDir: join(TMP, 'narr', task.id), verify: false, llmVerify: true, maxCycles: 1, maxIterations: 6,
      makeClient: () => new LlmClient({ mode: 'fake', fake, ...registryFor(db) }) });
    return fake.calls.filter((c) => c.role === 'verifier').length;
  };
  const verified = (db, nid) => db.all(`SELECT payload FROM audit_log WHERE action='handoff_verified' AND target_id=? ORDER BY id`, nid).map((r) => JSON.parse(r.payload));

  {
    const db = openDb(join(TMP, 'a.db')); const { userId } = ensureOwner(db);
    const t = mk(db, userId, 'normal');
    await run(db, t, ['accept']);
    const m = verified(db, t.nid)[0]?.model;
    eq([m?.executorVendor, m?.vendor, m?.executorMaker, m?.maker, m?.source, m?.sameMaker], ['deepseek', 'anthropic', 'deepseek', 'anthropic', 'policy', false], '验收审计记下：执行器在 deepseek → 验收换到 anthropic（策略换的）');
    setSetting(db, { key: 'deploy.verifier_vendor', value: 'same', userId });
    const t2 = mk(db, userId, 'normal');
    await run(db, t2, ['accept']);
    eq(verified(db, t2.nid)[0]?.model?.source, 'tier', '设成不强求：照档位');
    db.close();
  }
  {
    const db = openDb(join(TMP, 'b.db')); const { userId } = ensureOwner(db);
    setSetting(db, { key: 'deploy.verifier_cosign', value: 'high_risk', userId });
    const low = mk(db, userId, 'normal');
    eq(await run(db, low, ['accept']), 1, '会签只对高风险步骤：普通步骤一个验收员');
    const high = mk(db, userId, 'high');
    const calls = await run(db, high, ['accept', 'reject']);
    const vs = verified(db, high.nid);
    eq([calls >= 2, vs[0]?.model?.vendor, vs[1]?.model?.vendor], [true, 'anthropic', 'deepseek'], '高风险步骤：两个验收员，第二个避开第一个（没第三家就回到档位那家）');
    const rej = db.one(`SELECT payload FROM audit_log WHERE action='handoff_rejected' AND target_id=? ORDER BY id LIMIT 1`, high.nid);
    assert(rej && /内容不对/.test(rej.payload), '一个通过一个打回：按打回，执行器拿到打回的理由', rej?.payload?.slice(0, 200));
    db.close();
  }
  for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: saved.a, DEEPSEEK_API_KEY: saved.d, OPENAI_API_KEY: saved.o, GEMINI_API_KEY: saved.g })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
