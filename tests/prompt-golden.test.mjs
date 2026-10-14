// 提示词 golden：关键角色**装配好的**提示词（不是提示词常量 —— 常量改了 git diff 里看得见；
// 装配逻辑改了、提示词悄悄变了才是看不见的）在固定的数据上逐字比对 tests/fixtures/prompts/<角色>.txt。
// 有意改了就 `node tests/prompt-golden.test.mjs --update`，diff 进提交，评审时看得见提示词到底变了什么。
//
// 覆盖：执行器（四段式装配：宪法 + 步骤规格 + 上游交接 + 范围内的约定）、规划器、分类器、决策核对。
// 另有一条静态检查：src 里每个模型调用点都带 role（按角色取回复的假模型、OTLP span、日志都靠它）。
//
// 跑：node tests/prompt-golden.test.mjs [--update]

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureOwner, newId, insertEdge } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeRoleFake } from '../src/llm/providers.mjs';
import { assembleExecutor } from '../src/context/assemble.mjs';
import { plan } from '../src/agent/planner.mjs';
import { classify } from '../src/core/classifier.mjs';
import { checkDecisions } from '../src/core/decision-check.mjs';
import { record } from '../src/core/decisions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'tests', 'fixtures', 'prompts');
const UPDATE = process.argv.includes('--update');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const section = (s) => console.log(`\n── ${s}`);

// ── 固定数据 ──
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
const db = openDb(':memory:');
const owner = ensureOwner(db);
const pj = newId('pj'), taskId = newId('t'), n1 = newId('n'), n2 = newId('n'), cId = newId('c');
db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,goal,done_definition,created_at)
        VALUES (?,?,'订单服务','',?,'superintern/orders','main','src','active','订单接口可用','测试全过',?)`, pj, owner.userId, `/r/${pj}`, T0);
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,'订单导出','running',?,?,1)`, taskId, owner.userId, T0, pj);
db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
        VALUES (?,?,1,'给订单列表加 CSV 导出','只动 src/api/orders.mjs 与 test/orders.test.mjs','node --test 全过','["不引入新依赖","既有测试不许改"]',?,?)`, cId, taskId, T0, T0);
db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at)
        VALUES (?,?,'写导出函数','在 src/api/orders.mjs 里实现 toCsv(rows)，字段按表头顺序','test/orders.test.mjs 里 toCsv 的用例通过','review',5,?)`, n1, taskId, T0);
db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at)
        VALUES (?,?,'接到接口上','GET /orders.csv 返回 toCsv 的结果，content-type 为 text/csv','node --test 全过，且 curl 拿到的首行是表头','ready',5,?)`, n2, taskId, T0);
insertEdge(db, n2, n1, 'depends_on', T0);
db.run(`INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,known_issues,downstream_notes,narrative_ref,trust_label,created_at,validated_at)
        VALUES (?,?,1,'[{"path":"src/api/orders.mjs","kind":"code"}]','export function toCsv(rows: object[]): string','["表头里有逗号时没加引号"]','接口那一步直接 import toCsv','n','agent-generated',?,?)`, newId('h'), n1, T0 + 60_000, T0 + 60_000);
db.run(`UPDATE nodes SET status='done', finished_at=? WHERE id=?`, T0 + 60_000, n1);
record(db, { projectId: pj, taskId, subject: '换行符', statement: 'CSV 一律用 \\r\\n 换行', scope: ['src/api/orders.mjs'], sourceKind: 'question', at: T0 });
record(db, { projectId: pj, taskId, subject: '按钮文案', statement: '写"导出 CSV"', scope: ['web/ui.mjs'], sourceKind: 'question', at: T0 });

// ── 规范化：随机 id、时刻、临时路径换成稳定的占位 ──
function normalize(text) {
  const ids = new Map();
  return String(text)
    .replace(/\b(pj|t|n|q|u|m|a|c|h|dr|r|tok)_[0-9a-f]{12}\b/g, (m, p) => { if (!ids.has(m)) ids.set(m, `${p}_#${[...ids.keys()].filter((k) => k.startsWith(`${p}_`)).length + 1}`); return ids.get(m); })
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?/g, '<时刻>')
    .replace(/\b1[789]\d{11}\b/g, '<毫秒>');
}
const text = (c) => (c?.type === 'text' ? c.text : c?.type ? `<${c.type}>` : JSON.stringify(c));
function render(canon) {
  const out = [`## role: ${canon.role ?? '(无)'}  tier: ${canon.tier}  maxTokens: ${canon.maxTokens ?? '-'}  effort: ${canon.effort ?? '-'}`];
  out.push(`## tools: ${(canon.tools ?? []).map((t) => t.name).join(', ') || '(无)'}`);
  out.push('## system', canon.system ?? '');
  for (const m of canon.messages ?? []) out.push(`## ${m.role}`, Array.isArray(m.content) ? m.content.map(text).join('\n') : String(m.content ?? ''));
  return normalize(out.join('\n')).replace(/[ \t]+$/gm, '') + '\n';
}

function golden(name, actual) {
  const f = join(DIR, `${name}.txt`);
  if (UPDATE) { mkdirSync(DIR, { recursive: true }); writeFileSync(f, actual); ok(`${name}：已写入金样`); return; }
  if (!existsSync(f)) { bad(`${name}：没有金样 —— 跑一次 --update 生成并提交`); return; }
  const want = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  if (want === actual) { ok(`${name}：与金样一致（${actual.length} 字）`); return; }
  const a = want.split('\n'), b = actual.split('\n');
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  bad(`${name}：与金样不一致 —— 有意改的就 --update 并在提交里写明`, `第 ${i + 1} 行起不同：\n           金样：${(a[i] ?? '(结束)').slice(0, 160)}\n           现在：${(b[i] ?? '(结束)').slice(0, 160)}`);
}

/** 拿到某个角色第一次调用的请求（拿到就抛一个哨兵异常，免得把整套流程跑完）。 */
async function firstCanon(role, run) {
  let seen = null;
  const STOP = new Error('captured');
  const client = new LlmClient({ mode: 'fake', fake: makeRoleFake({ [role]: (canon) => { seen = canon; throw STOP; } }) });
  try { await run(client); } catch (e) { if (e !== STOP && !seen) throw e; }
  return seen;
}

section('① 关键角色装配好的提示词');
{
  const asm = assembleExecutor(db, { taskId, nodeId: n2, tier: 'standard', vendorId: 'fake' });
  golden('executor', render({ role: 'executor', tier: 'standard', ...asm }));
  assert(/\\r\\n|\r\n/.test(asm.system) && !/导出 CSV/.test(asm.system), '执行器：范围内的约定装进去了，范围外的没有（金样之外再钉一下语义）');

  const p = await firstCanon('planner', (client) => plan(db, { client, taskId, constitution: db.one(`SELECT * FROM constitutions WHERE id=?`, cId), maxAttempts: 1 }));
  assert(!!p, '规划器发出了请求');
  if (p) golden('planner', render(p));

  const c = await firstCanon('classifier', (llmClient) => classify('导出别用逗号了，改成分号', { openQuestions: [{ id: 'q_000000000001', text: 'CSV 分隔符用什么？' }], llmClient }));
  assert(!!c, '分类器发出了请求');
  if (c) golden('classifier', render(c));

  const d = await firstCanon('decision-check', (llmClient) => checkDecisions('换行改成 \\n 吧', {
    decisions: [{ id: 'dr_000000000001', subject: '换行符', statement: 'CSV 一律用 \\r\\n 换行', source_kind: 'question' }], llmClient }));
  assert(!!d, '决策核对发出了请求');
  if (d) golden('decision-check', render(d));
}

section('② 每个模型调用点都带 role');
{
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs')) files.push(p); } };
  walk(join(ROOT, 'src'));
  const missing = [];
  let n = 0;
  for (const f of files) {
    if (f.endsWith(join('llm', 'client.mjs'))) continue;   // runToolLoop 内部转发调用方的 canon
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\.complete\(\{|runToolLoop\(client, \{/g)) {
      n++;
      // 带 role，或展开一个在别处定义（并带了 role）的 canon（verifier 两段循环共用一个 canon）
      if (!/role: '[\w-]+'|\.\.\.canon\b/.test(s.slice(m.index, m.index + 400))) missing.push(`${f.slice(ROOT.length + 1)}:${s.slice(0, m.index).split('\n').length}`);
    }
  }
  assert(n >= 10, `找到 ${n} 个调用点`);
  assert(missing.length === 0, '都带 role', missing.join('、'));
}

db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
