// 路由按目录算、自动环境准备
//
// 跑：node tests/routing-dirs-setup.test.mjs
//
// ① 路由的"碰到了哪些目录"：具体文件按所在目录算（否则可动路径全是文件的任务，签收只落到负责人，管那个目录的成员签不到自己的需求）；
//    执行器的越界校验不跟着放宽
// ③ 自动环境准备：只放 pytest 配置的 pyproject 不 `pip install -e`；Python 那边失败不连累前端的 npm；*.egg-info/ 默认忽略

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { startProjectFromBrief } from '../src/agent/project-planner.mjs';
import { rulesOf, saveRules, routeQuestion, routePrefixesOfPaths, specPrefixes, prefixesOf, matchChains } from '../src/core/routing.mjs';
import { detectSetupCommands, runSetupCommands } from '../src/core/project-settings.mjs';
import { isBuildOutput } from '../src/core/workspace.mjs';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-routedirs-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

section('① 路由：具体文件按所在目录算；越界校验不放宽');
{
  eq(routePrefixesOfPaths(['frontend/src/App.jsx', 'frontend/src/App.css', 'README.md']).join(','), 'frontend/src', '文件 → 所在目录（根目录文件不算）');
  eq(routePrefixesOfPaths(['backend/', 'frontend/src/App.jsx']).sort().join(','), 'backend,frontend/src', '目录与文件混写 → 两边都算');
  eq(specPrefixes([{ scope_paths: ['frontend/src/App.jsx', 'frontend/src/App.test.jsx'] }]).join(','), 'frontend/src', '方案批准的前缀也按文件所在目录算（否则方案只发给负责人）');
  eq(matchChains([{ decision_type: 'signoff', scope: 'frontend/', position: 0 }, { decision_type: 'signoff', scope: '*', position: 0 }], { decisionType: 'signoff', prefixes: ['frontend/src'] })[0].scope, 'frontend/', 'frontend/src 命中 frontend/ 那一行');

  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const SRC = join(TMP, 'src'); mkdirSync(join(SRC, 'frontend'), { recursive: true });
  git(SRC, 'init', '-q', '-b', 'main'); writeFileSync(join(SRC, 'frontend', 'a.txt'), 'x\n');
  git(SRC, 'add', '.'); git(SRC, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'i');
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const lin = addUser(db, { name: '阿青', role: 'member', byUserId: owner.userId });
  const P = startProjectFromBrief(db, { userId: owner.userId, brief: '待办清单', source: SRC, home: join(TMP, 'h') });
  const rows = rulesOf(db, P.projectId).map(({ id, project_id, template, ...r }) => r);
  const base = rows.find((r) => r.decision_type === 'signoff' && r.scope === '*');
  rows.push({ ...base, scope: 'frontend', recipients: [`user:${lin.userId}`, 'user:lead'], quorum: 'all' });
  saveRules(db, { key: P.projectId, rules: rows, userId: owner.userId });
  const t = newId('t'), at = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'T4 标签','done',?,?,4)`, t, owner.userId, at, P.projectId);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at,scope_paths) VALUES (?,?,1,'g','s','d','[]',?,?,?)`,
    newId('c'), t, at, at, JSON.stringify(['frontend/src/App.jsx', 'frontend/src/App.test.jsx']));
  const q = newId('q');
  db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,NULL,3,'hard_rule','【签收】',NULL,?,NULL,'open')`, q, t, at);
  routeQuestion(db, { questionId: q, decisionType: 'signoff', typeSource: 'hard_rule', at });
  const to = JSON.parse(db.one(`SELECT addressed_to FROM questions WHERE id=?`, q).addressed_to);
  assert(to.includes(lin.userId) && to.includes(owner.userId), '只改 frontend/src 下文件的任务，签收送到阿青 + 负责人（不只送负责人）');
  eq(prefixesOf(db, t).length, 0, '执行器的越界校验仍按原样（具体文件不放宽成整个目录）');
}

section('③ 自动环境准备：pytest 配置的 pyproject 不 -e；生态之间互不连累');
{
  const d = join(TMP, 'repo'); mkdirSync(join(d, 'backend'), { recursive: true }); mkdirSync(join(d, 'frontend'));
  writeFileSync(join(d, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["backend/tests"]\n');
  writeFileSync(join(d, 'backend', 'requirements.txt'), 'fastapi\n');
  writeFileSync(join(d, 'frontend', 'package.json'), '{"name":"f"}');
  const a = detectSetupCommands(d).argvs.map((x) => x.join(' '));
  assert(!a.some((x) => x.includes('install -e')), '只放 pytest 配置的根 pyproject 不 pip install -e（否则"多个顶层包"必然失败）');
  assert(a.includes('.venv/bin/pip install -r backend/requirements.txt') && a.some((x) => x.startsWith('npm install') && x.includes('--prefix frontend')), '后端按 requirements 装、前端 npm 照装');
  writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "x"\n');
  assert(detectSetupCommands(d).argvs.some((x) => x.join(' ') === '.venv/bin/pip install -e .'), '声明了包的 pyproject 仍 -e');

  const ran = [];
  const exec = { execute: async ({ file, args }) => { ran.push([file, ...args].join(' ')); return { code: file.includes('pip') ? 1 : 0, stdout: '', stderr: '' }; } };
  const r = await runSetupCommands(exec, d, [['python', '-m', 'venv', '.venv'], ['.venv/bin/pip', 'install', '-r', 'backend/requirements.txt'], ['.venv/bin/pip', 'install', '-e', '.'], ['npm', 'ci', '--prefix', 'frontend']]);
  eq(r.ok, false, 'pip 失败 → 整体标失败（照实报）');
  assert(ran.includes('npm ci --prefix frontend'), 'pip 失败不连累 npm ci（否则前端依赖没装 → 回归里的前端构建 vite: not found）');
  assert(!ran.includes('.venv/bin/pip install -e .') && r.results.find((x) => x.argv.join(' ') === '.venv/bin/pip install -e .')?.skipped, '同一生态失败后的下一步不跑、记为跳过');
  assert(isBuildOutput('UNKNOWN.egg-info/PKG-INFO'), '*.egg-info/ 算构建产物，不算越界改动（否则交接会被判越界）');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
