// 写入收口：每张表由哪些文件写，只许减不许增。
//
// 写在哪个目录不是重点（"SQL 都放进 db/"只是搬家）；重点是**每张表的写入有一个主人**，这张表的不变量就只在一处维护。
// 原来最极端的是 questions：22 个文件各写一份 INSERT（列清单、级别 / 默认动作 / 时限的约束、路由都各抄一遍）。
// 这里按源码现算"表 → 写它的文件"，与 BASELINE 比：多出来的（新加了写手）直接红；少了的提示把 BASELINE 收紧。
// 状态列另有 db/state.mjs 的 transition() 独占（tests/state.test.mjs ⑤）。
// 2026-10-12 收口完成：src/db/ 之外每张表恰好一个写手（原来 31 张表 94 对）。收口途中查出两处各写各的不变量：
// 换了收件人新收件人收不到推送（questions.notified_to，v30）、参数"作废 + 写入"一半没包事务（params 唯一现值，v31）。
//
// 跑：node tests/write-owners.test.mjs [--print]（--print 打出当前的表，收紧 BASELINE 时用）

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };

/** 当前允许的写手。收紧时把这里改小；要加写手就得在评审里说清为什么不能经主人模块写。 */
const BASELINE = {
  answers: ['src/core/answers.mjs'],
  assumptions: ['src/agent/executor.mjs'],
  briefings: ['src/agent/executor.mjs'],
  budget_reservations: ['src/core/spend.mjs'],
  context_assemblies: ['src/context/assemble.mjs'],
  credentials: ['src/core/credentials.mjs'],
  decision_registry: ['src/core/decisions.mjs'],
  digests: ['src/core/digest.mjs'],
  duty_calendar: ['src/core/routing.mjs'],
  egress_sources: ['src/core/egress.mjs'],
  handoffs: ['src/agent/executor.mjs'],
  handover_requests: ['src/core/handover.mjs'],
  llm_bindings: ['src/llm/registry.mjs'],
  mail_inbound: ['src/core/mail-reply.mjs'],
  mail_reply_tokens: ['src/core/mail-reply.mjs'],
  status_reports: ['src/core/report.mjs'],
  llm_role_bindings: ['src/llm/registry.mjs'],
  llm_endpoints: ['src/llm/registry.mjs'],
  llm_models: ['src/llm/registry.mjs'],
  params: ['src/core/params.mjs'],
  project_members: ['src/core/project-members.mjs'],
  question_views: ['src/core/approval-habits.mjs'],   // 第一次在任务页看到某条事项（v42）
  llm_health: ['src/llm/health.mjs'],   // 服务商熔断 / 共享退避（v43）
  invariant_state: ['src/core/invariants.mjs'],   // 运行期不变量最近一次查的结果（v44）
  egress_credentials: ['src/core/egress-creds.mjs'],
  signals: ['src/core/signals.mjs'], signal_recipients: ['src/core/signals.mjs'],   // 不阻塞信号的发件箱（v49）   // 联网源的凭据，只进出口代理（v45）
  push_queue: ['src/core/push-queue.mjs'],   // 按人的推送队列（v51）
  questions: ['src/core/questions.mjs'],
  reports: ['src/agent/reporter.mjs'],
  revisions: ['src/core/revision.mjs'],
  routing_profiles: ['src/core/routing.mjs'],
  routing_rules: ['src/core/routing.mjs'],
  usage_ledger: ['src/core/ledger.mjs'],
  tool_calls: ['src/core/ledger.mjs'],     // 工具调用耗时（perf-g4 埋点）与账一起落
  user_channels: ['src/core/users.mjs'],
};

/** 源码里现在的"表 → 写它的文件"（src/db/ 是底层，不计）。 */
function currentOwners() {
  const out = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { if (e !== 'db') walk(p); continue; }
      if (!/\.mjs$/.test(e) || /i18n[\\/]/.test(p)) continue;
      const rel = relative(ROOT, p).split('\\').join('/');
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/(?:INSERT(?: OR (?:IGNORE|REPLACE))? INTO|UPDATE|DELETE FROM) ([a-z_]+)[\s(]/g)) {
        const t = m[1];
        if (['SET', 'of', 'the'].includes(t)) continue;
        (out[t] ??= new Set()).add(rel);
      }
    }
  };
  walk(join(ROOT, 'src'));
  return Object.fromEntries(Object.entries(out).map(([t, s]) => [t, [...s].sort()]));
}

const cur = currentOwners();
if (process.argv.includes('--print')) { console.log(JSON.stringify(cur, null, 2)); process.exit(0); }

console.log('\n── 每张表的写手只许减不许增');
const added = [], shrunk = [];
for (const [t, files] of Object.entries(cur)) {
  const base = new Set(BASELINE[t] ?? []);
  for (const f of files) if (!base.has(f)) added.push(`${t} ← ${f}`);
}
for (const [t, files] of Object.entries(BASELINE)) {
  const now = new Set(cur[t] ?? []);
  const gone = files.filter((f) => !now.has(f));
  if (gone.length) shrunk.push(`${t}：${gone.join('、')} 已不再写它`);
}
added.length ? bad('没有新增写手（新增的要经该表的主人模块写）', added.join('\n         ')) : ok('没有新增写手');
const multi = Object.entries(cur).filter(([, fs]) => fs.length > 1).map(([t, fs]) => `${t} ← ${fs.join('、')}`);
multi.length ? bad('每张表恰好一个写手（src/db/ 之外）', multi.join('\n         ')) : ok('每张表恰好一个写手（src/db/ 之外）：表的不变量只在一处维护');
const pairs = Object.values(cur).reduce((s, f) => s + f.length, 0);
ok(`当前 ${Object.keys(cur).length} 张表、${pairs} 对"表 ← 文件"`);
if (shrunk.length) console.log(`  （可以收紧 BASELINE：\n   ${shrunk.join('\n   ')}）`);

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
