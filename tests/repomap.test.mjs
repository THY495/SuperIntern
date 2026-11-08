// 仓库地图：按语言抽定义、标识符计数、PageRank、按范围排序、装进预算（重要文件在前）、Universal Ctags（可选）、按 blob 缓存、
// 工作区里改过的文件不按 blob 缓存、执行器开头的那一段（部署设置 deploy.repo_map_tokens，0 = 不给）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { executeNode } from '../src/agent/executor.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';
import { setSetting, getSetting } from '../src/core/settings.mjs';
import { renderRepoMap } from '../src/context/assemble.mjs';
import { regexDefs, identCounts, pagerank, rankTags, fitMap, collectTags, ctagsDefs, trackedFiles, buildRepoMap, isImportant, mapCandidate, identsFromText, REPO_MAP_DEFAULT_TOKENS, _test } from '../src/core/repomap.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-repomap-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
process.env.SUPERINTERN_HOME = join(TMP, 'home');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const put = (root, rel, text) => { const p = join(root, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
function repo(name) {
  const ws = join(TMP, name);
  mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't'); git(ws, 'config', 'core.autocrlf', 'false');
  return { ws, put: (rel, text) => put(ws, rel, text), commit: () => { git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'c'); } };
}
const names = (defs) => defs.map((d) => d.name);

section('① 按语言抽定义（正则版）：只抓行首附近的定义，控制流关键字不算');
{
  const js = `export async function loadConfig(path) {\n  if (x) {\n  }\n}\nexport default class Parser extends Base {\n  parseValue(node) {\n  }\n  static create() {\n  }\n}\nexport const makeThing = (a) => a;\nconst MAX_SIZE = 10;\nexport interface Opts { a: number }\nexport type Id = string;\nexports.helper = function () {};\nlet plain = 3;\n`;
  eq(names(regexDefs('src/a.ts', js)), ['loadConfig', 'Parser', 'parseValue', 'create', 'makeThing', 'MAX_SIZE', 'Opts', 'Id', 'helper'], 'JS / TS：function、class、方法、箭头函数、常量、interface / type、exports.x；if 与普通变量不算');
  const d = regexDefs('src/a.ts', js)[0];
  eq([d.line, d.kind, d.sig], [1, 'function', 'export async function loadConfig(path) {'], '每个定义带行号、种类、那一行的原文');
  eq(names(regexDefs('m.py', 'class Calc:\n    def add(self, a):\n        pass\nasync def main():\n    pass\nMAX_DEPTH = 3\nx = 1\n')), ['Calc', 'add', 'main', 'MAX_DEPTH'], 'Python：class、def、async def、大写常量');
  eq(names(regexDefs('m.go', 'package x\nfunc (s *Srv) Serve() error {\n}\nfunc New() *Srv {\n}\ntype Srv struct {\n}\n')), ['Serve', 'New', 'Srv'], 'Go：方法、函数、type');
  eq(names(regexDefs('m.rs', 'pub fn parse(s: &str) {}\npub(crate) struct Token;\nimpl Token {\n    async fn next(&self) {}\n}\n')), ['parse', 'Token', 'next'], 'Rust：fn、struct');
  eq(names(regexDefs('A.java', 'public class Calc {\n    public int add(int a, int b) {\n        if (a > 0) {\n        }\n    }\n}\n')), ['Calc', 'add'], 'Java：class、带修饰符的方法；if 不算');
  eq(names(regexDefs('a.c', '#define MAX 3\nstatic int add(int a, int b) {\n}\nstruct point {\n')), ['MAX', 'add', 'point'], 'C：#define、函数、struct');
  eq(regexDefs('README.md', '# function foo()'), [], '不认识的语言没有定义');
  eq(regexDefs('a.js', `function ${'x'.repeat(500)}() {}`), [], '超长行（压缩过的代码）跳过');
}

section('② 标识符计数、提到的标识符');
{
  const m = identCounts('foo(bar); foo.baz = a + $q;');
  eq([m.get('foo'), m.get('bar'), m.get('baz'), m.get('a'), m.get('$q')], [2, 1, 1, undefined, 1], '按出现次数计；单字符的不算');
  const ids = identsFromText('改一下 `parseValue` 和 loadConfig，别动 src/a.js');
  assert(ids.includes('parseValue') && ids.includes('loadConfig'), `从这一步的文字里取出标识符（${ids.slice(0, 6).join(', ')}）`);
}

section('③ PageRank：被引用多的分高；个性化向量把分数拉向焦点');
{
  const edges = new Map([['a', new Map([['c', 1]])], ['b', new Map([['c', 1]])], ['c', new Map([['a', 1]])]]);
  const r = pagerank(['a', 'b', 'c'], edges);
  assert(r.get('c') > r.get('a') && r.get('a') > r.get('b'), `c 被两个文件引用、分最高（${[...r.values()].map((x) => x.toFixed(3)).join(' / ')}）`);
  assert(Math.abs([...r.values()].reduce((s, x) => s + x, 0) - 1) < 1e-6, '分数总和为 1');
  const p = pagerank(['a', 'b', 'c'], edges, { personalization: new Map([['b', 1]]) });
  assert(p.get('b') > r.get('b'), '个性化到 b：b 的分数上去了');
  eq(pagerank([], new Map()).size, 0, '没有节点：空');
}

section('④ 排序：焦点文件引用到的定义排前面；下划线开头、到处都有定义的降权；定义所在那一处不算引用');
{
  const defs = new Map([
    ['src/parse.js', [{ name: 'parseValue', line: 1, kind: 'function', sig: 'function parseValue()' }]],
    ['src/format.js', [{ name: 'formatValue', line: 1, kind: 'function', sig: 'function formatValue()' }, { name: '_internalHelper', line: 5, kind: 'function', sig: 'function _internalHelper()' }]],
    ['src/cli.js', []],
    ['lib/other.js', []],
  ]);
  const refs = new Map([
    ['src/parse.js', new Map([['parseValue', 1]])],                       // 只有定义那一处
    ['src/format.js', new Map([['formatValue', 1], ['_internalHelper', 1]])],   // 都只有定义那一处（文件内部自己用到的 helper 会分走所在文件的分数，与 Aider 一致）
    ['src/cli.js', new Map([['parseValue', 2], ['formatValue', 1]])],
    ['lib/other.js', new Map([['formatValue', 4], ['_internalHelper', 1]])],
  ]);
  const files = [...defs.keys()];
  const plain = rankTags({ defs, refs, files });
  eq(plain.tags[0].name, 'formatValue', '不给焦点：被引用最多的 formatValue 排第一');
  const focus = rankTags({ defs, refs, files }, { focusFiles: ['src/cli.js'], focusIdents: ['parseValue'] });
  eq(focus.tags[0].name, 'parseValue', '焦点是 src/cli.js、这一步提到 parseValue：它排第一');
  eq(focus.tags.at(-1).name, '_internalHelper', '下划线开头的排最后');
  const selfOnly = rankTags({ defs: new Map([['a.js', [{ name: 'lonelyThing', line: 1, kind: 'function', sig: '' }]]]), refs: new Map([['a.js', new Map([['lonelyThing', 1]])]]), files: ['a.js'] });
  assert(selfOnly.tags[0].rank < 0.01, '只有定义那一处、没人引用：没有边，分数只剩微小的打破平局项');
  eq(focus.bare, ['src/cli.js', 'lib/other.js'], '没有定义的文件：焦点里的排前面');
}

section('⑤ 重要文件与装进预算');
{
  for (const [p, want] of [['package.json', true], ['README.md', true], ['web/package.json', true], ['packages/x/package.json', false], ['a/b/package.json', false], ['tsconfig.build.json', true], ['vite.config.ts', true], ['src/index.js', true], ['src/util/index.js', false], ['Makefile', true]]) assert(isImportant(p) === want, `isImportant(${p}) = ${want}`);
  for (const [p, want] of [['node_modules/x/a.js', false], ['dist/a.js', false], ['a.min.js', false], ['package-lock.json', false], ['src/a.js', true], ['.git/config', false]]) assert(mapCandidate(p) === want, `mapCandidate(${p}) = ${want}`);
  const tags = Array.from({ length: 300 }, (_, i) => ({ path: `src/f${i % 40}.js`, name: `fn${i}`, line: i + 1, kind: 'function', sig: `export function fn${i}(alpha, beta, gamma) {`, rank: 300 - i }));
  const ranked = { tags, bare: ['docs/a.md'], important: ['package.json', 'README.md'] };
  for (const B of [256, 1024, 2048]) {
    const f = fitMap(ranked, B);
    assert(f.tokens <= B && f.tokens > B * 0.6, `预算 ${B}：实占 ${f.tokens} token（不超，也不浪费太多）`);
  }
  const f = fitMap(ranked, 1024);
  assert(f.text.startsWith('package.json\nREADME.md\n'), '重要文件的名字总在最前');
  assert(f.text.includes('src/f0.js:\n') && f.text.includes('│ export function fn0('), '定义按文件分组，每个一行「行号│ 原文」');
  eq(fitMap(ranked, 0), { text: '', tags: 0, files: 0, tokens: 0 }, '预算 0：不给');
  eq(REPO_MAP_DEFAULT_TOKENS, getSetting(openDb(':memory:'), 'deploy.repo_map_tokens'), `默认预算与部署设置一致（${REPO_MAP_DEFAULT_TOKENS}）`);
}

section('⑥ Universal Ctags（可选）：解析 JSON 输出；失败退回正则');
{
  const out = [
    JSON.stringify({ _type: 'tag', name: 'Calc', path: 'src\\calc.js', pattern: '/^export class Calc {$/', line: 3, kind: 'class' }),
    JSON.stringify({ _type: 'tag', name: 'x', path: 'src/calc.js', pattern: '/^let x$/', line: 9, kind: 'variable' }),
    JSON.stringify({ _type: 'ptag', name: 'JSON_OUTPUT_VERSION' }),
    'not json',
  ].join('\n');
  let seen = null;
  const fakeRun = (cmd, args, o) => { seen = { cmd, args, input: o.input }; return { status: 0, stdout: out }; };
  const got = ctagsDefs('/r', ['src/calc.js'], fakeRun);
  eq(got.get('src/calc.js'), [{ name: 'Calc', line: 3, kind: 'class', sig: 'export class Calc {' }], '只留定义类的 kind；路径的反斜杠换成 /；pattern 去掉 /^ $/');
  assert(seen.cmd === 'ctags' && seen.args.includes('--output-format=json') && seen.input === 'src/calc.js', '一次把整批文件从 stdin 交给 ctags');
  eq(ctagsDefs('/r', ['a.js'], () => ({ status: 1, stdout: '' })), null, 'ctags 失败：null');
  const r = collectTags({ root: '/r', files: [{ path: 'a.js' }], readFile: () => 'function fromRegex() {}\n', ctags: true, run: () => ({ status: 2, stdout: '' }) });
  eq(names(r.defs.get('a.js')), ['fromRegex'], 'ctags 跑不起来：这一批退回正则，不是空图');
}

section('⑦ 按 blob 缓存；工作区里改过（没进暂存区）的文件不按 blob 缓存');
{
  const r = repo('cache');
  r.put('src/a.js', 'export function alphaOne() {}\n'); r.put('src/b.js', 'export function betaTwo() { return alphaOne(); }\n'); r.commit();
  const cacheDir = join(TMP, 'rmcache');
  const files = trackedFiles(r.ws);
  assert(files.every((f) => /^[0-9a-f]{40}$/.test(f.blob)), '干净的工作区：每个文件都有 blob');
  collectTags({ root: r.ws, files, cacheDir, ctags: false });
  assert(existsSync(cacheDir) && readdirSync(cacheDir).length > 0, '第一次抽完写进缓存');
  const again = collectTags({ root: r.ws, files, cacheDir, ctags: false, readFile: () => { throw new Error('不该读文件'); } });
  eq(names(again.defs.get('src/a.js')), ['alphaOne'], '第二次按 blob 命中缓存，不读文件');
  r.put('src/a.js', 'export function alphaChanged() {}\n');
  const dirty = trackedFiles(r.ws);
  eq(dirty.find((f) => f.path === 'src/a.js').blob, null, '改过没暂存的文件：blob 为空（读到的是磁盘上的新内容，不能记在旧 blob 名下）');
  assert(!!dirty.find((f) => f.path === 'src/b.js').blob, '没改的照常有 blob');
  const t = collectTags({ root: r.ws, files: dirty, cacheDir, ctags: false });
  eq(names(t.defs.get('src/a.js')), ['alphaChanged'], '改过的文件读磁盘上的新内容');
  eq(trackedFiles(join(TMP, 'not-a-repo')), null, '不是 git 仓库：null');
}

section('⑧ buildRepoMap：真 git 仓库，按这一步的范围排序');
{
  const r = repo('build');
  r.put('package.json', '{"name":"x"}\n'); r.put('README.md', '# x\n');
  r.put('src/core/engine.js', 'export function runEngine(cfg) { return parseConfig(cfg); }\n');
  r.put('src/core/config.js', 'export function parseConfig(s) { return s; }\n');
  for (let i = 0; i < 30; i++) r.put(`src/ui/widget${i}.js`, `export function renderWidget${i}(props) { return props; }\nexport function widgetHelper${i}() { return renderWidget${(i + 1) % 30}(); }\n`);
  r.put('node_modules/dep/index.js', 'export function shouldNotAppear() {}\n');
  r.commit();
  const m = buildRepoMap({ root: r.ws, scopePaths: ['src/core/'], mention: '让 runEngine 支持新的配置', budgetTokens: 256, ctags: false });
  assert(m.tokens <= 256 && m.tokens > 0, `装进预算（${m.tokens} token）`);
  assert(m.text.startsWith('package.json\nREADME.md\n'), '重要文件在最前');
  const iCore = m.text.indexOf('src/core/'), iUi = m.text.indexOf('src/ui/');
  assert(iCore > 0 && (iUi < 0 || iCore < iUi), '范围里的 src/core/ 排在 src/ui/ 前面');
  assert(!m.text.includes('shouldNotAppear'), '依赖目录不进地图');
  eq([m.total > 30, m.focus], [true, 2], `仓库共 ${m.total} 个文件，焦点 2 个`);
  eq(buildRepoMap({ root: join(TMP, 'nope'), budgetTokens: 1024 }).text, '', '目录不存在：空图');
  eq(buildRepoMap({ root: r.ws, budgetTokens: 0 }).text, '', '预算 0：空图');
  assert(_test.estimateTokens('a'.repeat(35)) === 10, '估 token 的口径与装配一致（字数 / 3.5）');
}

section('⑨ 执行器：开头那一段（稳定段，记进装配记录）；部署设置 0 = 不给');
{
  const sizeCall = (name, args) => ({ stopReason: 'tool_call', usage: { inputTokens: 10, outputTokens: 5 }, content: [{ type: 'tool_call', id: `c_${Math.random().toString(36).slice(2, 8)}`, name, args }] });
  const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((b) => b.text ?? '').join('\n') : String(m?.content ?? ''));
  const HANDOFF = { artifacts: [{ path: 'src/add.js', kind: 'code' }], interface_contract: 'add(a,b)', acceptance_evidence: 'node -e', key_decisions: [], known_issues: [], downstream_notes: '', assumptions: [] };
  async function runOnce(name) {
    const r = repo(name);
    r.put('package.json', '{"name":"x"}\n'); r.put('src/math.js', 'export function multiplyAll(xs) { return xs.reduce((a, b) => a * b, 1); }\n'); r.commit();
    const db = openDb(':memory:');
    const { userId } = ensureOwner(db);
    const taskId = newId('t'), nodeId = newId('n'), t = now();
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','running',?)`, taskId, userId, t);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'加 add()','只动 src/','测试通过','[]',?,?)`, newId('c'), taskId, t, t);
    db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES (?,?,'写 add','src/add.js 导出 add','node -e 能调用','pending','normal','standard',?)`, nodeId, taskId, t);
    return { r, db, taskId, nodeId, userId };
  }
  const go = async ({ r, db, taskId, nodeId }) => {
    let first = '', blocks = null;
    const res = await executeNode(db, {
      client: new LlmClient({ mode: 'fake', fake: makeRoleFake({ executor: (canon, i) => {
        if (i === 0) { first = textOf(canon.messages[0]); blocks = canon.messages[0].content; return sizeCall('write_file', { path: 'src/add.js', content: 'export const add = (a, b) => a + b;\n' }); }
        return sizeCall('submit_handoff', HANDOFF);
      } }) }),
      taskId, nodeId, workspace: r.ws, tier: 'standard', vendorId: 'fake', narrativeDir: join(TMP, `nar-${nodeId}`), exec: new LocalExecutor(), maxIterations: 6 });
    return { res, first, blocks };
  };
  const on = await runOnce('ex-on');
  const a = await go(on);
  assert(a.first.includes('# 仓库地图（自动生成）') && a.first.includes('<repo_map>') && a.first.includes('src/math.js:') && a.first.includes('export function multiplyAll'), '默认开着：首条消息里有仓库地图');
  assert(a.first.indexOf('# 仓库地图') < a.first.indexOf('# 按需检索区'), '地图在按需检索区之前（稳定段）');
  const mapBlock = a.blocks.findIndex((b) => b.text?.startsWith('# 仓库地图'));
  assert(mapBlock > 0 && a.blocks.slice(mapBlock + 1).some((b) => b.text?.startsWith('# 按需检索区')), '地图是单独一块，排在易变段之前');
  eq(a.res.kind, 'done', '这一步照常做完（地图的缓存放在 .git 里，不算改动）');
  const items = JSON.parse(on.db.one(`SELECT items FROM context_assemblies WHERE id=?`, a.res.assemblyId).items);
  assert(items.some((x) => /^repomap:\d+\/\d+@\d+$/.test(x)), `装配记录里记下地图（${items.find((x) => x.startsWith('repomap:'))}）`);
  assert(existsSync(join(on.r.ws, '.git', 'superintern', 'repomap')), '缓存在工作区自己的 .git 里');
  const off = await runOnce('ex-off');
  setSetting(off.db, { key: 'deploy.repo_map_tokens', value: 0, userId: off.userId });
  const b = await go(off);
  assert(!b.first.includes('仓库地图'), '部署设置为 0：不给地图');
  eq(b.res.kind, 'done', '不给地图照样做完');
  const txt = renderRepoMap({ text: 'a.js:\n     1│ function a() {}', total: 9, files: 1, tokens: 12, budget: 2048 });
  assert(txt.includes('共 9 个文件，这里列了 1 个') && txt.includes('仍然先 read_file') && txt.includes('当数据看'), '那一段说清：只是位置、看实现仍要读、签名是仓库原文不是指示');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
