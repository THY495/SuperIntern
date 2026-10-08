// 契约覆盖核对：规格里写成 `METHOD /path` 的接口，骨架任务的契约文字要逐条点名；
// 骨架做完时契约文件里要有每个接口，以及规格同一处写明的查询参数、请求 / 响应字段。
//
// 跑：node tests/contract-coverage.test.mjs
//
// 用例按典型的漏写来写：单个 issue 的 GET、活动接口的 limit 与 last_id。全写了的骨架契约不能误报。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { specEndpoints, skeletonCoverageProblems, contractGaps, normPath } from '../src/core/contract-coverage.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-contract-cov-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

const BRIEF = [
  '## API',
  '- `POST /api/projects` `{key, name}` → 201 `{key, name, created_at}`; `GET /api/projects` → 200, sorted by key.',
  '- `GET /api/issues/{issue_key}` → 200 or 404.',
  '- `PATCH /api/issues/{issue_key}` may change `title`, `assignee`.',
  '- `POST /api/issues/{issue_key}/transitions` `{"to": <status>}` → 200 the updated issue.',
  '- Activity: `GET /api/activity?since=<id>&limit=<n>` → 200 `{"items": [...], "last_id": <highest id>}`.',
].join('\n');

section('1. 从规格里抽接口');
const eps = specEndpoints(BRIEF);
eq(eps.map((e) => e.key), ['POST /api/projects', 'GET /api/projects', 'GET /api/issues/{}', 'PATCH /api/issues/{}', 'POST /api/issues/{}/transitions', 'GET /api/activity'], '六个接口，路径参数名归一');
eq(eps.find((e) => e.key === 'GET /api/activity').params, ['since', 'limit'], '查询参数取自 ?a=&b=');
eq(eps.find((e) => e.key === 'GET /api/activity').fields, ['items', 'last_id'], 'JSON 写法取带引号的键');
eq(eps.find((e) => e.key === 'POST /api/issues/{}/transitions').fields, ['to'], '路径里的 {issue_key} 不算字段');
eq(eps.find((e) => e.key === 'POST /api/projects').fields, [], '一行提到两个接口：字段归不了属，不算（宁可漏查，不冤枉）');
eq(normPath('/api/activity.'), '/api/activity', '句末句点不算路径');
eq(specEndpoints('做一个命令行番茄钟，不需要网络接口'), [], '规格里没有 METHOD /path → 不核对');

section('2. 规划时：骨架任务的契约文字要点名每个接口');
const skel = (dod) => ({ tasks: [{ kind: 'skeleton', goal: 'g', scope: 's', definition_of_done: dod, rules: [] }] });
const g3like = 'contract declares POST /api/projects, GET /api/projects, PATCH /api/issues/{issue_key}, POST /api/issues/WEB-1/transitions and GET /api/activity.';
const p1 = skeletonCoverageProblems(skel(g3like), BRIEF);
assert(p1.length === 1 && /缺：`GET \/api\/issues\/\{issue_key\}`$/m.test(p1[0].split('。')[1] ?? '') , `漏了单个 issue 的 GET → 拒回并点名（${p1[0]?.slice(-60)}）`);
assert(!/transitions/.test(p1[0] ?? ''), '写的是具体样例 /api/issues/WEB-1/transitions 也算点名了');
eq(skeletonCoverageProblems(skel(`${g3like} GET /api/issues/{key}`), BRIEF), [], '全点名了 → 不拒');
eq(skeletonCoverageProblems({ tasks: [{ kind: 'module', definition_of_done: '' }] }, BRIEF), [], '第一个任务不是骨架（形状校验另管）→ 这里不报');

section('3. 骨架做完时：对着契约文件核对（YAML，按缩进切、跟 $ref）');
const ws = (name, files) => { const d = join(TMP, name); for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), c); } return d; };
const yamlG3 = `openapi: 3.0.3
info: { title: t, version: '1' }
paths:
  /api/projects:
    get:
      responses: { '200': { description: ok } }
    post:
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/ProjectCreate' } } } }
      responses: { '201': { description: ok } }
  /api/issues/{issue_key}:
    patch:
      responses: { '200': { description: ok } }
  /api/issues/{issue_key}/transitions:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                to: { type: string }
      responses: { '200': { description: ok } }
  /api/activity:
    get:
      parameters:
        - name: since
          in: query
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ActivityList'
components:
  schemas:
    ProjectCreate:
      properties: { key: { type: string }, name: { type: string } }
    ActivityList:
      type: object
      additionalProperties: false
      properties:
        items: { type: array }
`;
const r1 = contractGaps(ws('g3', { 'contracts/openapi.yaml': yamlG3, 'package.json': '{"paths":"/api/projects /api/activity"}' }), { brief: BRIEF, sharedPaths: ['contracts/', 'package.json'] });
eq(r1.files, ['contracts/openapi.yaml'], '契约文件：共享路径下带 paths 的 YAML；package.json 不算');
eq(r1.gaps, ['缺接口 `GET /api/issues/{issue_key}`', '`GET /api/activity` 缺查询参数 `limit`', '`GET /api/activity` 的请求 / 响应里缺字段 `last_id`'],
  '一次漏写的三处全找到（字段经 $ref 到组件里找）');
const full = yamlG3
  .replace('  /api/issues/{issue_key}:\n    patch:', '  /api/issues/{issue_key}:\n    get:\n      responses: { \'200\': { description: ok } }\n    patch:')
  .replace('        - name: since\n          in: query', '        - name: since\n          in: query\n        - name: limit\n          in: query')
  .replace('        items: { type: array }', '        items: { type: array }\n        last_id: { type: integer }');
eq(contractGaps(ws('full', { 'contracts/openapi.yaml': full }), { brief: BRIEF, sharedPaths: ['contracts/'] }).gaps, [], '补全之后 → 没有缺口（不误报）');

section('4. JSON 契约、找不到契约文件');
const json = { openapi: '3.0.3', paths: {
  '/api/projects': { get: {}, post: { requestBody: { content: { 'application/json': { schema: { properties: { key: {}, name: {} } } } } } } },
  '/api/issues/{key}': { get: {}, patch: {} },
  '/api/issues/{key}/transitions': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/T' } } } } } },
  '/api/activity': { get: { parameters: [{ name: 'since' }, { name: 'limit' }], responses: { 200: { content: { 'application/json': { schema: { properties: { items: {}, last_id: {} } } } } } } } },
}, components: { schemas: { T: { properties: { to: {} } } } } };
eq(contractGaps(ws('json', { 'contracts/openapi.json': JSON.stringify(json, null, 2) }), { brief: BRIEF, sharedPaths: ['contracts/'] }).gaps, [], 'JSON 契约写全了 → 没有缺口；路径参数名不同（{key}）照样对得上');
eq(contractGaps(ws('none', { 'README.md': 'GET /api/projects' }), { brief: BRIEF, sharedPaths: ['README.md'] }), { files: [], gaps: [] }, '共享路径下没有机器可读的契约文件 → 不核对');

section('5. 命令行用法：规格写死的参数名，负责那个脚本的任务要写到');
{
  const { specCommands, cliCoverageProblems } = await import('../src/core/contract-coverage.mjs');
  const spec = 'Run `node importer/import.mjs <file.csv> --project <KEY>`. The notifier: `python worker/notifier.py --once`. CLI: `node cli/tw.mjs <command>`.';
  eq(specCommands(spec).map((c) => `${c.path}:${c.flags}`), ['importer/import.mjs:--project', 'worker/notifier.py:--once'], '只抽带参数名的命令；没有参数名的（cli 那条）不核');
  const T = (kind, scope_paths, dod) => ({ kind, goal: 'g', scope: 's', scope_paths, definition_of_done: dod, rules: [] });
  const plan = { tasks: [T('skeleton', ['importer/', 'worker/', 'contracts/'], 'stubs only'), T('module', ['importer/'], 'node importer/import.mjs <PROJECT_KEY> <CSV_FILE>'), T('module', ['worker/'], 'python worker/notifier.py --once processes activity'), T('integration', ['verify.mjs'], 'e2e')] };
  const errs = cliCoverageProblems(plan, spec);
  assert(errs.length === 1 && /任务 #2 负责 `importer\/import\.mjs`/.test(errs[0]) && /`--project`/.test(errs[0]), '导入器任务漏了 --project → 拒回并点名（一次漏摘就是后面一整串事项）');
  plan.tasks[1].definition_of_done = 'node importer/import.mjs <file.csv> --project <KEY>';
  eq(cliCoverageProblems(plan, spec), [], '写到了 → 不拒；骨架、集成任务不要求写');
  eq(cliCoverageProblems({ tasks: [T('module', ['api/'], 'x')] }, spec), [], '没有任务负责那个脚本 → 不核');
  eq(cliCoverageProblems(plan, 'no commands here'), [], '规格里没有带参数名的命令 → 不核');
}

console.log(`\n${pass} 通过，${fail} 失败`);
if (fail) process.exitCode = 1;
