// 重活放到 worker 线程（core/offthread.mjs）：能放就放、放不了照旧在本线程跑；结果、报错、事件与直接调用一样。
//
// 跑：node tests/offthread.test.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner } from '../src/db/db.mjs';
import { createProject } from '../src/core/project.mjs';
import { offThread, inlineReason, closeOffThread, serializeError } from '../src/core/offthread.mjs';
import { I18nError } from '../src/i18n/index.mjs';
import { seedRepo } from './scenarios/world.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-offthread-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });

section('1. 什么时候放、什么时候不放');
{
  const mem = openDb(':memory:');
  eq(inlineReason(mem, {}), 'memory_db', ':memory: 库 → 本线程（worker 开不了同一个内存库）');
  const file = { path: join(TMP, 'x.db') };
  eq(inlineReason(file, { projectId: 'p', onEvent: () => {} }), null, '文件库、只有 onEvent 一个函数 → 放过去（事件经消息转回）');
  eq(inlineReason(file, { fetchFn: globalThis.fetch }), null, '默认的 fetch → 放过去（worker 里是同一个）');
  eq(inlineReason(file, { fetchFn: async () => ({}) }), 'fn:fetchFn', '注入的假 fetch → 本线程（丢掉它会悄悄改掉调用方要的行为）');
  eq(inlineReason(file, { makeExec: async () => ({}) }), 'fn:makeExec', '注入的执行器工厂没说 worker 里怎么重建 → 本线程');
  eq(inlineReason(file, { makeExec: Object.assign(async () => ({}), { workerSpec: { module: 'x', export: 'y' } }) }), null, '带 workerSpec 的执行器工厂 → 放过去');
  mem.close();
}

section('2. 报错原样带回：模板、参数、挂在错误上的字段');
{
  const e = new I18nError('没有这个项目：{id}', { id: 'pj_x' });
  e.taskId = 't_1'; e.leaseHeld = true; e.fn = () => {};
  const s = serializeError(e);
  eq(s.tpl, '没有这个项目：{id}', '模板');
  eq(s.props.taskId, 't_1', '错误上挂的 taskId（守护进程挂"推进反复失败"事项时要用）');
  assert(!('fn' in s.props), '过不了线程边界的字段丢掉');

  const db = openDb(join(TMP, 'a.db'));
  ensureOwner(db);
  let err = null;
  try { await offThread(db, 'advanceProject', { projectId: 'pj_nope', home: join(TMP, 'home-a') }); } catch (x) { err = x; }
  assert(err instanceof I18nError, `worker 里抛的 I18nError 回到主线程还是 I18nError（${err?.constructor?.name}）`);
  eq(err?.tpl, '没有这个项目：{id}', '模板没丢（看板按看的人的语言翻）');
  eq(err?.params?.id, 'pj_nope', '参数没丢');
  db.close();
}

section('3. 真推进一步：结果、事件、库里的写入与直接调用一样');
{
  const home = join(TMP, 'home-b');
  const db = openDb(join(TMP, 'b.db'));
  const owner = ensureOwner(db);
  const seed = seedRepo(join(TMP, 'seed-b'));
  const spec = { title: 'p', tasks: [{ title: 't1', goal: 'g', definition_of_done: 'd', verify_command: 'node -e 0', scope_paths: ['a/'] }] };
  const { projectId } = createProject(db, { userId: owner.userId, spec, source: seed, home });
  const events = [];
  const r = await offThread(db, 'advanceProject', { projectId, home, userId: owner.userId, onEvent: (e) => events.push(e) });
  eq(typeof r?.advanced, 'boolean', `worker 里推进了一步，返回普通对象（${JSON.stringify(r).slice(0, 120)}）`);
  // 建项目时第一个任务已经开工，这一拍在等它 —— 与直接调用同一个结论
  assert(/waiting|blocked|workspace_created/.test(String(r.reason)), `结论与本线程跑一样：${r.reason}`);
  // 同一个库：worker 拿的项目租约、放的项目租约，主线程马上看得见（释放 = 到期时刻改成释放那一刻）
  const lease = db.one(`SELECT * FROM leases WHERE resource=?`, `project:${projectId}`);
  assert(lease && lease.expires_at <= Date.now(), '推进用的项目租约是 worker 拿的、也在 worker 里放了', JSON.stringify(lease));
  // 并发：同时推两次，第二个要么等前一个办完、要么因租约让开 —— 不会两个一起合并
  const both = await Promise.all([offThread(db, 'advanceProject', { projectId, home, userId: owner.userId }), offThread(db, 'advanceProject', { projectId, home, userId: owner.userId })]);
  assert(both.every((x) => typeof x.advanced === 'boolean'), `同时推两次都回来了（${both.map((x) => x.reason).join(' / ')}）`);
  db.close();
}

await closeOffThread();
console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
