// skill（上下文包）：SKILL.md 解析（从宽）、三层来源与同名优先、停用、清单预算与点名、执行器取用（复制进工作区、不算改动）、整理后放回。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { executeNode } from '../src/agent/executor.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { setLimit } from '../src/core/limits.mjs';
import { messageEstimate, fixedEstimate } from '../src/context/compact.mjs';
import { parseFrontmatter, parseSkill, discoverSkills, renderCatalog, setProjectSkill, installSkill, removeSkill, SKILLS_DIR, CATALOG_BUDGET } from '../src/core/skills.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, m, re) => { try { fn(); bad(m, '期望被拒绝，但成功了'); } catch (e) { (re && !re.test(e.message)) ? bad(m, `报错不对：${e.message}`) : ok(`${m}\n         └ ${String(e.message).split('\n')[0]}`); } };

const TMP = mkdtempSync(join(tmpdir(), 'si-skills-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const HOME = join(TMP, 'home');
process.env.SUPERINTERN_HOME = HOME;
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const put = (root, rel, text) => { const p = join(root, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
const skill = (name, desc, body = '照这个做。', extra = '') => `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n${body}\n`;
function repo(name) {
  const ws = join(TMP, name);
  mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't'); git(ws, 'config', 'core.autocrlf', 'false');
  return { ws, put: (rel, text) => put(ws, rel, text), commit: () => { git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'c'); } };
}

section('① SKILL.md 解析：YAML 子集、从宽校验');
{
  const fm = parseFrontmatter(`name: pdf-tools\ndescription: "处理 PDF: 合并、拆分"\nlong: >\n  第一行\n  第二行\nlit: |\n  a\n  b\nmetadata:\n  author: x\n  version: "1.0"\nallowed-tools:\n  - Read\n  - Bash\nflag: true\nurl: http://x.y/z`);
  eq([fm.name, fm.description, fm.long, fm.lit, fm.metadata, fm['allowed-tools'], fm.flag, fm.url],
    ['pdf-tools', '处理 PDF: 合并、拆分', '第一行 第二行', 'a\nb', { author: 'x', version: '1.0' }, ['Read', 'Bash'], true, 'http://x.y/z'], '引号串、折叠 / 字面块、一层映射、列表、布尔；值里的冒号不用加引号');
  const s = parseSkill(skill('Wrong_Name', '描述'), 'demo');
  eq([s.name, s.warnings.length, s.warnings[0]?.msg.includes('与目录名')], ['demo', 1, true], 'name 与目录名不一样：只警告，按目录名');
  eq(parseSkill(skill('demo', ''), 'demo').error?.msg.includes('description 是空的'), true, 'description 空：跳过（AI 靠它决定用不用）');
  eq(parseSkill('没有 frontmatter', 'demo').error?.msg.includes('没有 frontmatter'), true, '没有 frontmatter：跳过');
  const w = parseSkill(`---\ndescription: 做发布\nwhen_to_use: 要打 tag 的时候\ndisable-model-invocation: true\n---\n正文`, 'release');
  eq([w.description, w.invocable, w.body], ['做发布 要打 tag 的时候', false, '正文'], 'when_to_use 并进描述；disable-model-invocation 记下');
  eq(parseSkill(skill('bad--name', 'x'), 'bad--name').warnings.some((x) => x.msg.includes('不合规范')), true, '名字不合规范：警告');
}

section('② 三层来源：部署 > 项目 > 仓库；仓库读提交过的版本；.agents 优先于 .claude；停用');
{
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  // 项目仓库就是这份（看板与 setProjectSkill 从项目仓库的项目分支读仓库层）；执行器读的是工作区，这里两者是同一个目录
  const pj = newId('pj');
  const r = repo(join('home', 'projects', pj, 'repo'));
  r.put('.agents/skills/lint/SKILL.md', skill('lint', '仓库的 lint 做法'));
  r.put('.agents/skills/deploy-app/SKILL.md', skill('deploy-app', '仓库的发布做法'));
  r.put('.claude/skills/lint/SKILL.md', skill('lint', '.claude 里的 lint'));
  r.put('.claude/skills/only-claude/SKILL.md', skill('only-claude', '只在 .claude 里'));
  r.put('.agents/skills/broken/SKILL.md', '---\ndescription:\n---\n');
  r.commit();
  r.put('.agents/skills/uncommitted/SKILL.md', skill('uncommitted', '没提交的'));
  const branch = git(r.ws, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
  db.run(`INSERT INTO projects (id,owner_id,title,repo,branch,base_ref,status,created_at) VALUES (?,?,'P',?,?,'base','active',?)`, pj, userId, r.ws, branch, now());
  put(HOME, 'skills/deploy-app/SKILL.md', skill('deploy-app', '部署装的发布做法'));
  put(HOME, `projects/${pj}/skills/lint/SKILL.md`, skill('lint', '项目装的 lint'));
  put(HOME, `projects/${pj}/skills/lint/scripts/run.sh`, 'echo lint\n');
  const all = discoverSkills(db, { projectId: pj, workspace: r.ws });
  const by = (id) => all.find((s) => s.id === id);
  eq(all.map((s) => s.id), ['deploy:deploy-app', 'project:lint', 'repo:broken', 'repo:deploy-app', 'repo:lint', 'repo:only-claude'], '三层都读到；没提交的不算；.claude 里与 .agents 同名的不再列');
  eq([by('repo:deploy-app').shadowedBy, by('repo:lint').shadowedBy, by('repo:lint').enabled], ['deploy:deploy-app', 'project:lint', false], '同名：部署 > 项目 > 仓库（仓库的不能顶替操作人装的）');
  eq([by('repo:only-claude').enabled, by('repo:only-claude').where], [true, '.claude/skills/only-claude'], '只有 .claude/skills 的也认');
  eq([by('repo:broken').enabled, !!by('repo:broken').error], [false, true], '解析不了的列出来（看板上能看到为什么），不给 AI');
  eq(by('project:lint').files, ['scripts/run.sh'], '参考文件列出来');

  setSetting(db, { key: 'deploy.skills_off', value: ['project:lint'], userId });
  let s2 = discoverSkills(db, { projectId: pj, workspace: r.ws });
  eq([s2.find((s) => s.id === 'project:lint').offBy, s2.find((s) => s.id === 'repo:lint').enabled], ['deploy', true], '停了项目层那份：它不给，也不再占名字 —— 仓库同名的接上（看板上冒出自己的勾，能再关）');
  rejects(() => setProjectSkill(db, { projectId: pj, id: 'project:lint', enabled: true, userId }), '部署停了的，项目里打不开', /管理员/);
  const heir = setProjectSkill(db, { projectId: pj, id: 'deploy:deploy-app', enabled: false, userId });
  s2 = discoverSkills(db, { projectId: pj, workspace: r.ws });
  eq([heir.alsoOff, s2.find((s) => s.id === 'repo:deploy-app').enabled], [['repo:deploy-app'], false], '停掉一份：被它顶着的同名几份一起停（不会悄悄换成仓库那份）');
  setProjectSkill(db, { projectId: pj, id: 'repo:deploy-app', enabled: true, userId });
  s2 = discoverSkills(db, { projectId: pj, workspace: r.ws });
  eq(s2.find((s) => s.id === 'repo:deploy-app').enabled, true, '要换用仓库那份：单独再勾上它');
  setProjectSkill(db, { projectId: pj, id: 'repo:*', enabled: false, userId });
  s2 = discoverSkills(db, { projectId: pj, workspace: r.ws });
  eq(s2.filter((s) => s.layer === 'repo').every((s) => s.offBy === 'project'), true, '项目停掉整层仓库 skill');
  setProjectSkill(db, { projectId: pj, id: 'repo:*', enabled: true, userId });
  eq(db.all(`SELECT action FROM audit_log WHERE action LIKE 'skill_%' ORDER BY id`).map((x) => x.action), ['skill_disabled', 'skill_enabled', 'skill_disabled', 'skill_enabled'], '开关进审计');
  rejects(() => setProjectSkill(db, { projectId: pj, id: 'nope:x', enabled: false, userId }), '层名不对 → 拒', /标识不对/);

  const src = join(TMP, 'pkg', 'fmt-code');
  put(join(TMP, 'pkg'), 'fmt-code/SKILL.md', skill('fmt-code', '格式化'));
  put(join(TMP, 'pkg'), 'fmt-code/node_modules/x.js', 'x');
  const inst = installSkill(db, { src, userId });
  assert(existsSync(join(HOME, 'skills', 'fmt-code', 'SKILL.md')) && !existsSync(join(HOME, 'skills', 'fmt-code', 'node_modules')), '装到部署层（不带 node_modules）');
  eq(inst.name, 'fmt-code', '名字取目录名');
  put(join(TMP, 'pkg'), 'empty-desc/SKILL.md', skill('empty-desc', ''));
  rejects(() => installSkill(db, { src: join(TMP, 'pkg', 'empty-desc'), userId }), '装之前校验：描述空的拒收', /description 是空的/);
  removeSkill(db, { name: 'fmt-code', userId });
  assert(!existsSync(join(HOME, 'skills', 'fmt-code')), '卸掉');
  rejects(() => removeSkill(db, { name: '..', userId }), '名字带 .. → 拒', /名字不对/);
}

section('③ 清单：点名的必给；超预算按相关度排、先截描述再省略；disable-model-invocation 只在点名时给');
{
  const mk = (name, description, extra = {}) => ({ id: `deploy:${name}`, layer: 'deploy', name, description, enabled: true, invocable: true, ...extra });
  const many = Array.from({ length: 80 }, (_, i) => mk(`tool-${i}`, `第 ${i} 号工具的用法说明，`.repeat(8)));
  const list = [...many, mk('csv-report', '生成 CSV 报表：导出订单数据为 csv 文件'), mk('release', '发版流程', { invocable: false })];
  const c = renderCatalog(list, { focus: '把订单导出成 CSV 报表' });
  assert(c.text.length <= CATALOG_BUDGET + 2000, `清单受预算约束（${c.text.length} 字符）`);
  eq(c.listed[0], 'csv-report', '与这一步最相关的排在最前');
  assert(c.omitted.length > 0 && c.text.includes('没列出来'), '放不下的省掉，并说清另有几份');
  assert(!c.names.includes('release'), 'disable-model-invocation 的不给（没点名）');
  const c2 = renderCatalog(list, { focus: '按 release 流程打 tag' });
  assert(c2.names.includes('release') && c2.mentioned.includes('release') && /任务里点名了 `release`/.test(c2.text), '点名了：给、并写明开工前先取用');
  eq(renderCatalog([mk('x', 'y', { enabled: false })]).text, null, '全停用：没有清单');
}

// ── 执行器夹具 ──
const sizeOf = (canon) => fixedEstimate(canon.system, canon.tools) + canon.messages.reduce((s, m) => s + messageEstimate(m), 0);
const call = (canon, name, args) => ({ stopReason: 'tool_call', usage: { inputTokens: canon ? sizeOf(canon) : 10, outputTokens: 5 },
  content: [{ type: 'tool_call', id: `c_${Math.random().toString(36).slice(2, 8)}`, name, args }] });
const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((b) => b.text ?? '').join('\n') : String(m?.content ?? ''));
const lastResults = (canon) => (canon.messages.at(-1)?.results ?? []).map((x) => x.content).join('\n');
function fixture(scope, spec = 'src/add.js 导出 add') {
  const db = openDb(':memory:');
  const { userId } = ensureOwner(db);
  const taskId = newId('t'), nodeId = newId('n'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'加 add()',?,'测试通过','[]',?,?)`, newId('c'), taskId, scope, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
          VALUES (?,?,'写 add',?,'node -e 能调用','pending','normal','standard',?)`, nodeId, taskId, spec, t);
  return { db, taskId, nodeId, userId };
}
const HANDOFF = (paths) => ({ artifacts: paths.map((path) => ({ path, kind: 'code' })), interface_contract: 'add(a,b)', acceptance_evidence: 'node -e', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] });

section('④ 执行器：清单进装配、取用工具带名字；部署层的复制进 .si-skills/，不算这一步的改动');
{
  rmSync(join(HOME, 'skills'), { recursive: true, force: true });
  put(HOME, 'skills/js-style/SKILL.md', skill('js-style', '写 JavaScript 时的代码风格：两空格缩进、具名导出', '# JS 风格\n- 两空格缩进\n- 用具名导出'));
  put(HOME, 'skills/js-style/scripts/check.sh', 'echo ok\n');
  const r = repo('e4');
  r.put('src/.keep', ''); r.put('.agents/skills/repo-notes/SKILL.md', skill('repo-notes', '这个仓库的目录约定')); r.commit();
  const { db, taskId, nodeId } = fixture('只动 src/');
  let first = '', tools = null, act = '', again = '';
  const res = await executeNode(db, {
    client: new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor: (canon, i) => {
      if (i === 0) { first = textOf(canon.messages[0]); tools = canon.tools; return call(null, 'activate_skill', { name: 'js-style' }); }
      if (i === 1) { act = lastResults(canon); return call(null, 'activate_skill', { name: 'js-style' }); }
      if (i === 2) { again = lastResults(canon); return call(null, 'write_file', { path: 'src/add.js', content: 'export const add = (a, b) => a + b;\n' }); }
      return call(null, 'submit_handoff', HANDOFF(['src/add.js']));
    } }) }),
    taskId, nodeId, workspace: r.ws, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, 'nar4'), exec: new LocalExecutor(), maxIterations: 8 });
  assert(first.includes('<available_skills>') && first.includes('<name>js-style</name>') && first.includes('<source>部署</source>') && first.includes('<name>repo-notes</name>'), '装配里有清单（名字、来源、描述），没有正文');
  assert(!first.includes('两空格缩进\n- 用具名导出'), '正文不预先放');
  const t = tools?.find((x) => x.name === 'activate_skill');
  eq(t?.parameters?.properties?.name?.enum?.sort(), ['js-style', 'repo-notes'], 'activate_skill 的 name 只能选清单里的');
  assert(act.includes('<skill_content name="js-style" source="部署">') && act.includes('用具名导出') && act.includes(`${SKILLS_DIR}/js-style/scripts/check.sh`), '取用：正文 + 参考文件在工作区里的路径');
  assert(existsSync(join(r.ws, SKILLS_DIR, 'js-style', 'scripts', 'check.sh')), '参考文件复制进了工作区（沙箱里能读、能跑）');
  assert(/已经取用过了/.test(again), '再取一次：只说一句，不重复塞正文');
  eq(res.kind, 'done', '交接通过：.si-skills/ 不算这一步的改动（不会被当成越界）');
  const ex = readFileSync(join(r.ws, '.git', 'info', 'exclude'), 'utf8');
  assert(ex.includes('.si-skills/'), '.si-skills/ 在工作区的排除清单里（不进提交）');
  eq(db.all(`SELECT payload FROM audit_log WHERE action='skill_activated'`).length, 1, '取用记审计（一次）');
  const asm = db.one(`SELECT items FROM context_assemblies WHERE id=?`, res.assemblyId);
  assert(JSON.parse(asm.items).includes('skill:js-style'), '装配记录里记下列了哪些 skill');
}

section('⑤ 整理之后：取用过的 skill 正文与中途附上的子目录规则放回首条消息（原来跟着工具结果一起丢了）');
{
  rmSync(join(HOME, 'skills'), { recursive: true, force: true });
  put(HOME, 'skills/big-read/SKILL.md', skill('big-read', '读大文件的做法', '大文件先 grep 再分段读'));
  const r = repo('e5');
  r.put('AGENTS.md', '根规则\n'); r.put('lib/AGENTS.md', 'lib 规则：只读不改\n');
  for (const f of ['a', 'b', 'c']) r.put(`lib/${f}.txt`, f.repeat(38_999) + '\n');
  r.put('src/.keep', ''); r.commit();
  const { db, taskId, nodeId, userId } = fixture('只动 src/', '读 lib 下的文件');
  setLimit(db, { taskId, key: 'limit.compact_tokens', value: 30_000, userId });
  const BRIEF = '## 目标\n读文件。\n## 已做\n读了 lib/a.txt。\n## 试过但不行的路\n无\n## 下一步\n接着读。\n## 相关文件\nlib/a.txt';
  let after = null;
  const fake = makeRoleFake({
    executor: (canon, i) => {
      if (i === 0) return call(canon, 'activate_skill', { name: 'big-read' });
      if (i <= 3) return call(canon, 'read_file', { path: `lib/${'abc'[i - 1]}.txt` });
      after = canon.messages;
      return call(canon, 'raise_question', { level: 2, text: '读完了', blocked_by: '无', default_action: '照做', work_done: '读了', plan_after_answer: '按答复' });
    },
    compactor: () => ({ stopReason: 'end', content: [{ type: 'text', text: BRIEF }], usage: { inputTokens: 1000, outputTokens: 200 } }),
  });
  await executeNode(db, { client: new LlmClient({ mode: 'fake', fake }), taskId, nodeId, workspace: r.ws, tier: 'standard', vendorId: 'deepseek', narrativeDir: join(TMP, 'nar5'), exec: new LocalExecutor(), maxIterations: 8 });
  const levels = db.all(`SELECT payload FROM audit_log WHERE action='context_compacted' AND target_id=?`, nodeId).map((x) => JSON.parse(x.payload).level);
  assert(levels.includes(2), `整理过（第 ${levels.join(',')} 级）`);
  const head = textOf(after?.[0]);
  assert(head.includes('<skill_content name="big-read"') && head.includes('大文件先 grep 再分段读'), 'skill 正文放回了首条消息');
  assert(head.includes('lib 规则：只读不改'), '中途附上的 lib/AGENTS.md 也放回了');
  eq((head.match(/<skill_content name="big-read"/g) ?? []).length, 1, '只放一份');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
