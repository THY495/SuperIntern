// 会话能力表（Rule of Two）与联网源凭据。不需要 docker；真容器里的注入 / 收窄在 egress.test.mjs 的 5b 节。
//
// 跑：node tests/capabilities.test.mjs

import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LLM_ROLES } from '../src/llm/canonical.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { TOOLS as EXECUTOR_TOOLS } from '../src/agent/executor.mjs';
import { SESSIONS, TOOL_EFFECTS, assertSessionTools, sandboxCaps, narrowForCredentials, assertRuleOfTwo, staticProblems } from '../src/core/capabilities.mjs';
import { addSourceCredential, revokeSourceCredential, sourceCredentials, credentialInjection } from '../src/core/egress-creds.mjs';
import { secretLike, toolEnvProblems, toolEnvOf, withheldToolEnv, allowlistOf, setEgressGroups, egressContext } from '../src/core/egress.mjs';
import { addUser } from '../src/core/users.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throws = (fn, re, m) => { try { fn(); bad(m, '没有抛'); } catch (e) { assert(re.test(e.message), m, e.message); } };
const section = (s) => console.log(`\n── ${s}`);

section('① 能力表本身');
eq(staticProblems(), [], '每个模型角色都登记了；工具都有效果；不经沙箱的会话没有三样齐、也没有能碰外面的工具');
for (const role of Object.keys(LLM_ROLES)) assert(SESSIONS[role], `角色 ${role} 有登记`);
eq([...EXECUTOR_TOOLS.map((t) => t.name)].sort(), [...SESSIONS.executor.tools].sort(), '执行器真实的工具清单与登记一致');
for (const [k, s] of Object.entries(SESSIONS)) if (s.sensitive !== 'sandbox') assert(!s.tools.some((t) => ['exec', 'app'].includes(TOOL_EFFECTS[t])), `${k}：不经沙箱，没有跑代码 / 操作应用的工具`);

section('② 每次调用前核对（LlmClient.complete）');
throws(() => assertSessionTools('nobody', []), /没在能力表里登记/, '没登记的角色：拒');
throws(() => assertSessionTools('planner', [{ name: 'run_command' }]), /没登记的工具：run_command/, '给规划器塞执行器的工具：拒');
throws(() => assertSessionTools(null, [{ name: 'read_file' }]), /必须带会话角色/, '带工具却不带角色：拒（不然不带角色就能绕过）');
assertSessionTools(null, []); ok('不带工具也不带角色（纯文本调用）：放行');
assertSessionTools('project_append', [{ name: 'propose_project' }]); ok('project_append 按 project_planner 的登记核对');
{
  const client = new LlmClient({ provider: makeFake([]), binding: null });
  let err = null;
  try { await client.complete({ role: 'planner', tier: 'heavy', messages: [], tools: [{ name: 'write_file', parameters: {} }] }); } catch (e) { err = e; }
  assert(err?.capability, `真实的 LlmClient 在发请求之前就拒（${err?.message?.slice(0, 40)}）`);
}

section('③ 沙箱：带凭据就收窄成只读；三样齐又没人在环 → 拒');
{
  const allow = [{ group: 'github', host: 'api.github.com', readOnly: false }, { group: 'npm', host: 'registry.npmjs.org', readOnly: false }, { group: 'docs', host: 'docs.x.com', readOnly: true }];
  const none = narrowForCredentials({ allow, injected: [] });
  eq(none.narrowed, [], '没带凭据：不收窄（沙箱只读不可信输入 + 能写，没有凭据，两样）');
  assertRuleOfTwo(sandboxCaps({ allow: none.allow, injected: [] })); ok('没带凭据：放行');
  const ro = [{ sourceId: 'npm', header: 'Authorization', hosts: ['registry.npmjs.org'], allowWrite: false }];
  const n1 = narrowForCredentials({ allow, injected: ro });
  eq(n1.narrowed.sort(), ['api.github.com', 'registry.npmjs.org'], '带了只读凭据：所有可写的地址都收窄成只读（凭据所在的源也一样）');
  assertRuleOfTwo(sandboxCaps({ allow: n1.allow, injected: ro }), { humanApproved: n1.humanApproved }); ok('收窄之后放行');
  const rw = [{ sourceId: 'npm', header: 'Authorization', hosts: ['registry.npmjs.org'], allowWrite: true }];
  const n2 = narrowForCredentials({ allow, injected: rw });
  eq(n2.narrowed, ['api.github.com'], '管理员允许写的凭据：它的地址保持可写，别的地址照样收窄');
  assertRuleOfTwo(sandboxCaps({ allow: n2.allow, injected: rw }), { humanApproved: n2.humanApproved }); ok('允许写 = 人在环：放行');
  throws(() => assertRuleOfTwo(sandboxCaps({ allow, injected: ro })), /没有人在环/, '跳过收窄直接装配（代码改坏了的样子）：拒');
}

section('④ 联网源凭据：只进代理、只读请求上带、库里只有密文');
{
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const member = addUser(db, { name: 'm', role: 'member', byUserId: userId }).userId;
  throws(() => addSourceCredential(db, { sourceId: 'npm', secret: 'Bearer x', byUserId: member }), /只有管理员/, '成员不能配');
  throws(() => addSourceCredential(db, { sourceId: 'npm', header: 'Host', secret: 'x', byUserId: userId }), /请求头名字不对/, 'Host 这类代理自己要管的头：拒');
  throws(() => addSourceCredential(db, { sourceId: 'nope', secret: 'x', byUserId: userId }), /没有这个源/, '没有的源：拒');
  const SECRET = 'Bearer npm_SECRET_VALUE_1234';
  const r = addSourceCredential(db, { sourceId: 'npm', secret: SECRET, byUserId: userId });
  eq(r.hint, '…1234', 'hint 只有末四位');
  throws(() => addSourceCredential(db, { sourceId: 'npm', secret: 'y', byUserId: userId }), /已经有一份凭据在用/, '同一个源同时只有一份');
  assert(!JSON.stringify(db.all(`SELECT * FROM egress_credentials`)).includes('npm_SECRET'), '库里只有密文');
  assert(!JSON.stringify(db.all(`SELECT payload FROM audit_log WHERE action='egress_credential_added'`)).includes('npm_SECRET'), '审计里没有值');
  const inj = credentialInjection(db, ['npm', 'github']);
  eq(inj.credRules, [{ host: 'registry.npmjs.org', path_prefix: '/', header: 'Authorization', env: 'SI_CRED_0', readOnly: true }], '规则只有变量名，默认只在读请求上带');
  eq(inj.credEnv, { SI_CRED_0: SECRET }, '值只进代理容器的环境');
  eq(inj.injected.map((c) => c.sourceId), ['npm'], '没选的源 / 没配凭据的源不注入');
  eq(credentialInjection(db, ['github']).credRules, [], '任务没放行这个源：不注入');
  eq(sourceCredentials(db).npm.header, 'Authorization', '列表有 header、没有值');
  assert(revokeSourceCredential(db, { id: r.id, byUserId: userId }), '吊销');
  eq(credentialInjection(db, ['npm']).credRules, [], '吊销后不再注入');
  db.close();
}

section('⑤ 工具配置不收凭据；以前录入的不再注入、不进提示词');
{
  for (const [k, v, want] of [['PIP_INDEX_URL', 'https://pypi.tuna.tsinghua.edu.cn/simple', false], ['PIP_INDEX_URL', 'https://u:p@x.com/simple', true], ['NPM_TOKEN', 'x', true],
    ['NPM_CONFIG__AUTH', 'x', true], ['GOPRIVATE', 'x', false], ['UV_KEYRING_PROVIDER', 'x', false], ['AWS_SECRET_ACCESS_KEY', 'x', true], ['GOPROXY', 'https://goproxy.cn', false]]) {
    eq(secretLike(k, v), want, `${k}${want ? ' 像凭据' : ' 不像凭据'}`);
  }
  assert(toolEnvProblems({ NPM_TOKEN: 'abc' }).some((e) => /像是凭据/.test(e)), '加源时工具配置里有凭据：拒');
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  // 模拟 最小权限注入以前录入的：直接写库
  db.run(`UPDATE egress_sources SET tool_env=? WHERE id='npm'`, JSON.stringify({ NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com', NPM_TOKEN: 'legacy_SECRET' }));
  eq(toolEnvOf(db, ['npm']), { NPM_CONFIG_REGISTRY: 'https://registry.npmmirror.com' }, '像凭据的那一项不注入沙箱');
  eq(withheldToolEnv(db, ['npm']), [{ sourceId: 'npm', name: 'npm 官方源', key: 'NPM_TOKEN', stripped: false }], '记下没注入的是哪一项（不含值）');
  const taskId = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'t','running',?)`, taskId, userId, now());
  setEgressGroups(db, { taskId, groups: ['npm', 'github'], userId });
  const text = egressContext(db, taskId);
  assert(!text.includes('legacy_SECRET') && text.includes('NPM_CONFIG_REGISTRY'), '给执行器的说明里没有凭据的值，普通配置照常写');
  addSourceCredential(db, { sourceId: 'npm', secret: 'Bearer z', byUserId: userId });
  const text2 = egressContext(db, taskId);
  assert(/代理会替工具带上 Authorization/.test(text2), '配了凭据的源：说明里告诉执行器代理会带上（不用自己配令牌）');
  assert(/api\.github\.com/.test(text2) && /GitHub[^\n]*只读/.test(text2), '带凭据的沙箱里别的源也写成只读');
  eq(allowlistOf(db, ['npm']).length, 1, '放行表照旧');
  // 健康卡：有没注入的像凭据的工具配置 → 注意；给那个源配了凭据 → 那一项自动删掉、提示消失
  db.run(`UPDATE egress_sources SET tool_env=? WHERE id='pypi'`, JSON.stringify({ PIP_INDEX_URL: 'https://u:SECRETPW@pypi.example.com/simple' }));
  const hc = (await import('../src/core/deploy-health.mjs')).deploymentHealth(db, {}).checks.find((c) => c.key === 'egress_secrets');
  assert(hc?.level === 'warn' && hc.rows.some((r) => r.sourceId === 'pypi' && r.key === 'PIP_INDEX_URL'), '健康卡列出没注入的那一项（注意级）');
  assert(!JSON.stringify(hc).includes('SECRETPW'), '健康卡里没有值');
  const r2 = addSourceCredential(db, { sourceId: 'pypi', header: 'Authorization', secret: 'Basic abc', byUserId: userId });
  eq(toolEnvOf(db, ['pypi']), { PIP_INDEX_URL: 'https://pypi.example.com/simple' }, '网址里带用户名密码的：去掉它们照常注入（镜像地址本身不是秘密）');
  eq(r2.dropped, ['PIP_INDEX_URL'], '给源配了凭据：工具配置里的凭据自动清掉');
  eq(JSON.parse(db.one(`SELECT tool_env FROM egress_sources WHERE id='pypi'`).tool_env), { PIP_INDEX_URL: 'https://pypi.example.com/simple' }, '只清掉用户名密码，地址留着');
  eq(withheldToolEnv(db, ['pypi']), [], '之后不再提示');
  assert(db.one(`SELECT 1 FROM audit_log WHERE action='egress_source_tool_env_dropped' AND target_id='pypi'`), '删掉记了审计');
  db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
