// 可观测与日常清理：
//   ① JSON 行日志：console 照常输出，同时写一条带 task / node / run / trace / pid 的记录；并行的两步各带各的上下文；
//      enterLogContext 不漏到调用方；超过上限换文件；trace 经环境变量传给子进程；长期运行的命令进程（run）真的写了；
//   ② 日常清理：旧日志删、新日志留；daemon.log 复制后截断；已合并任务删依赖目录（嵌套的也找得到）、记审计与腾出的字节，
//      没合并的 / 有活租约的不动，不是依赖目录的不动；一天只做一次；
//   ③ OTLP：没配地址时一个请求都不发；配了：步骤 span 与模型调用 span 父子相连、trace 与日志同一个、
//      GenAI 属性（模型 / 用量 / 花费）齐全、提示词与回复内容不出门；收集端挂了只警告一次、不抛。
//
// 跑：node tests/observability.test.mjs

import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, mkdirSync, utimesSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { installLogSink, withLogContext, enterLogContext, logContext, traceId, newTrace, logSinkFile, TRACE_ENV } from '../src/core/log.mjs';
import { pruneLogs, rotateDaemonLog, cleanMergedDeps, housekeeping } from '../src/core/housekeeping.mjs';
import { acquireLease } from '../src/db/lease.mjs';
import { withSpan, flushSpans, setOtelFetch } from '../src/core/otel.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (m) => { pass++; process.stdout.write(`  [PASS] ${m}\n`); };
const bad = (m, e) => { fail++; process.stdout.write(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}\n`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => process.stdout.write(`\n── ${s}\n`);
const TMP = mkdtempSync(join(tmpdir(), 'si-obs-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

section('① JSON 行日志');
{
  const home = join(TMP, 'h1');
  // 断言输出走 process.stdout.write，不经 console —— 免得测试自己的输出也被写进日志
  const fakeConsole = { out: [], log(...a) { this.out.push(a.join(' ')); }, info() {}, warn(...a) { this.out.push(a.join(' ')); }, error(...a) { this.out.push(a.join(' ')); } };
  const sink = installLogSink({ home, maxBytes: 4000, target: fakeConsole });
  assert(!!sink.file && sink.file.includes(join('logs', 'jsonl')), `装上了：${sink.file?.slice(home.length + 1)}`);
  fakeConsole.log('\x1b[32m启动\x1b[0m');
  await Promise.all([
    withLogContext({ task: 't_a' }, async () => { enterLogContext({ node: 'n_1' }); await new Promise((r) => setTimeout(r, 5)); fakeConsole.log('第一步做完'); }),
    withLogContext({ task: 't_a' }, async () => { enterLogContext({ node: 'n_2' }); await new Promise((r) => setTimeout(r, 1)); fakeConsole.error('第二步失败'); }),
  ]);
  eq(logContext().node, undefined, 'enterLogContext 没漏到外面');
  eq(fakeConsole.out.length, 3, '给人看的输出照常');
  const recs = lines(sink.file);
  eq(recs[0].msg, '启动', '颜色码去掉了');
  const r1 = recs.find((r) => r.msg === '第一步做完'), r2 = recs.find((r) => r.msg === '第二步失败');
  eq([r1?.task, r1?.node, r1?.level, r2?.node, r2?.level], ['t_a', 'n_1', 'info', 'n_2', 'error'], '并行的两步各带各的上下文；级别对');
  assert(r1 && r1.pid === process.pid && /:\d+:/.test(r1.run) && /^[0-9a-f]{32}$/.test(r1.trace), `带 pid / run（与租约 holder 同值）/ trace（${r1?.run}）`);
  for (let i = 0; i < 40; i++) fakeConsole.log(`填满 ${'x'.repeat(100)} ${i}`);
  const files = readdirSync(join(home, 'logs', 'jsonl'));
  assert(files.length >= 2 && files.every((f) => statSync(join(home, 'logs', 'jsonl', f)).size <= 4200), `超过上限换下一个文件（${files.length} 个）`);
  sink.uninstall();
  eq(logSinkFile(), null, '卸下了');

  const t1 = traceId();
  const child = spawnSync(process.execPath, ['-e', `process.stdout.write(process.env.${TRACE_ENV} ?? '')`], { encoding: 'utf8' });
  eq(child.stdout, t1, '子进程从环境变量继承 trace');
  const t2 = newTrace();
  assert(t2 !== t1 && /^[0-9a-f]{32}$/.test(t2), '守护进程每一拍换一条新 trace');

  // 长期运行的命令进程真的写了（run 一个不存在的任务：报错退出，那一行错误也带着 task）
  const h2 = join(TMP, 'h2');
  const dbp = join(h2, 'state.db');
  openDb(dbp).close();
  const r = spawnSync(process.execPath, ['--no-warnings', join(ROOT, 'src', 'cli.mjs'), 'run', 't_nope', '--db', dbp], { encoding: 'utf8', env: { ...process.env, SUPERINTERN_HOME: h2, SUPERINTERN_PROC: '', SUPERINTERN_ENV_FILE: 'none' } });
  const jdir = join(h2, 'logs', 'jsonl');
  const recs2 = existsSync(jdir) ? readdirSync(jdir).flatMap((f) => lines(join(jdir, f))) : [];
  assert(recs2.some((x) => x.task === 't_nope' && x.proc === 'run' && x.level === 'error'), `run 进程写了 JSON 行，错误那一行带着任务 id（退出码 ${r.status}）`, r.stderr.slice(0, 200));
}

section('② 日常清理');
{
  const home = join(TMP, 'h3');
  const logs = join(home, 'logs');
  mkdirSync(join(logs, 'jsonl'), { recursive: true });
  const old = Date.now() / 1000 - 20 * 86400;
  for (const [f, isOld] of [['t_x-2026-09-01T00-00-00-000Z.log', true], ['t_x-2026-10-12T00-00-00-000Z.log', false], ['jsonl/2026-09-01-run-1.jsonl', true], ['jsonl/2026-10-12-run-2.jsonl', false], ['notes.txt', true]]) {
    writeFileSync(join(logs, f), 'x');
    if (isOld) utimesSync(join(logs, f), old, old);
  }
  const removed = pruneLogs(home, { keepDays: 14 });
  eq(removed.sort(), ['2026-09-01-run-1.jsonl', 't_x-2026-09-01T00-00-00-000Z.log'], '超过 14 天的任务日志与 JSON 行日志删了');
  assert(existsSync(join(logs, 'notes.txt')), '不认识的文件不动（只删自己写的那两种）');

  writeFileSync(join(logs, 'daemon.log'), 'y'.repeat(2000));
  eq(rotateDaemonLog(home, { maxBytes: 1000 }), { bytes: 2000 }, 'daemon.log 超了：截断');
  eq([statSync(join(logs, 'daemon.log')).size, statSync(join(logs, 'daemon.log.1')).size], [0, 2000], '原文件清零、内容复制到 daemon.log.1');
  eq(rotateDaemonLog(home, { maxBytes: 1000 }), null, '没超：不动');

  const db = openDb(join(home, 'state.db'));
  const o = ensureOwner(db);
  const mk = (merged) => { const id = newId('t'); db.run(`INSERT INTO tasks (id, owner_id, title, status, created_at, merged_at) VALUES (?, ?, 'x', 'done', ?, ?)`, id, o.userId, now(), merged ? now() : null); return id; };
  const ws = (id) => {
    const w = join(home, 'workspaces', id);
    mkdirSync(join(w, '.git'), { recursive: true });
    writeFileSync(join(w, '.git', 'superintern-workspace'), '');
    for (const d of ['node_modules/a', 'pkg/sub/node_modules/b', 'api/.venv/lib', 'src']) mkdirSync(join(w, d), { recursive: true });
    writeFileSync(join(w, 'node_modules', 'a', 'big.js'), 'z'.repeat(5000));
    writeFileSync(join(w, 'src', 'keep.js'), 'k');
    return w;
  };
  const merged = mk(true), open = mk(false), busy = mk(true);
  const wm = ws(merged), wo = ws(open), wb = ws(busy);
  acquireLease(db, `task:${busy}`, { meta: {} });
  const r = cleanMergedDeps(db, home);
  eq(r.map((x) => x.taskId), [merged], '只清已合并且没有进程在跑的');
  eq(r[0]?.dirs.sort(), ['api/.venv', 'node_modules', 'pkg/sub/node_modules'], '嵌套的依赖目录也找到了');
  assert(!existsSync(join(wm, 'node_modules')) && !existsSync(join(wm, 'pkg', 'sub', 'node_modules')) && existsSync(join(wm, 'src', 'keep.js')) && existsSync(join(wm, 'pkg', 'sub')), '依赖目录没了，源码与上层目录还在');
  assert(existsSync(join(wo, 'node_modules')) && existsSync(join(wb, 'node_modules')), '没合并的、有活租约的不动');
  const a = db.one(`SELECT payload FROM audit_log WHERE action='workspace_deps_cleaned' AND target_id=?`, merged);
  assert(a && JSON.parse(a.payload).bytes >= 5000, `记审计，带腾出的字节（${a && JSON.parse(a.payload).bytes}）`);

  const h1 = housekeeping(db, home);
  assert(!h1.skipped && !!db.one(`SELECT 1 x FROM audit_log WHERE action='housekeeping_done'`), '守护进程的日常清理做了一次并记审计');
  eq(housekeeping(db, home).skipped, 'not_due', '马上再来：一天只做一次');
  db.close();
}

section('③ OTLP 导出');
{
  const got = [];
  const srv = createServer((req, res) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { got.push({ url: req.url, headers: req.headers, body: s }); res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const SECRET = '请把 API 密钥写进 config.js 的第 7 行';
  const client = () => new LlmClient({ mode: 'fake', fakePricing: { input: 1, output: 2 }, fake: makeFake([
    { content: [{ type: 'text', text: `回复里提到 ${SECRET}` }], usage: { inputTokens: 100, cacheReadTokens: 30, outputTokens: 20 }, stopReason: 'end_turn' },
  ]) });
  const call = (c) => withLogContext({ task: 't_otel', node: 'n_otel' }, () => withSpan('execute_step', { attributes: { 'superintern.tier': 'standard' } },
    () => c.complete({ tier: 'standard', system: 's', messages: [{ role: 'user', content: SECRET }] })));

  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  await call(client());
  await flushSpans();
  eq(got.length, 0, '没配地址：一个请求都不发');

  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}/`;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-api-key=abc%3D1';
  await call(client());
  await flushSpans();
  eq([got.length, got[0]?.url], [1, '/v1/traces'], '配了：发到 <地址>/v1/traces');
  eq(got[0]?.headers['x-api-key'], 'abc=1', 'OTEL_EXPORTER_OTLP_HEADERS 照标准解析（含百分号编码）');
  const body = JSON.parse(got[0]?.body ?? '{}');
  const spans = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];
  const A = (s) => Object.fromEntries((s?.attributes ?? []).map((x) => [x.key, Object.values(x.value)[0]]));
  const step = spans.find((s) => s.name === 'execute_step'), chat = spans.find((s) => s.name.startsWith('chat'));
  assert(step && chat && chat.parentSpanId === step.spanId && chat.traceId === step.traceId && step.traceId === traceId(), '步骤 span 是模型调用 span 的父；trace 与日志同一个');
  eq([A(step)['superintern.task_id'], A(step)['superintern.node_id'], chat?.kind], ['t_otel', 'n_otel', 3], '任务 / 步骤 id 从日志上下文带上；模型调用是 CLIENT span');
  const ca = A(chat);
  eq([ca['gen_ai.operation.name'], ca['gen_ai.usage.input_tokens'], ca['gen_ai.usage.output_tokens'], ca['gen_ai.usage.cache_read.input_tokens'], Number(ca['superintern.cost_micro_usd']) > 0],
    ['chat', '130', '20', '30', true], 'GenAI 属性：操作、用量（输入含缓存）、花费');
  assert(!got[0].body.includes(SECRET), '提示词与回复内容不出门');
  eq(A({ attributes: body.resourceSpans?.[0]?.resource?.attributes })['service.name'], 'superintern', 'service.name 默认 superintern');

  srv.close();
  setOtelFetch(async () => { throw new Error('connect ECONNREFUSED'); });
  const warns = [];
  const ow = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    await call(client()); const r1 = await flushSpans();
    await call(client()); await flushSpans();
    assert(r1.error && warns.length === 1, `收集端挂了：不抛、只警告一次（${warns[0]?.slice(0, 50)}）`);
  } finally { console.warn = ow; setOtelFetch(null); delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; delete process.env.OTEL_EXPORTER_OTLP_HEADERS; }
}

process.stdout.write(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}\n`);
process.exitCode = fail ? 1 : 0;
