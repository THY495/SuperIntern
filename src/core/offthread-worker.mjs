// offthread.mjs 的 worker 一侧：常驻，开自己的库连接，按到达顺序一件一件办，结果或报错发回主线程。
// 先载入 preload（测试的时钟偏移）再载入业务模块 —— 业务模块一加载就可能读时间，所以全用动态 import。

import { parentPort, workerData } from 'node:worker_threads';

const { dbPath, preload } = workerData;
for (const m of preload ?? []) await import(m);
const { OFF_THREAD_OPS, serializeError } = await import('./offthread.mjs');
const { openDb } = await import('../db/db.mjs');
const db = openDb(dbPath);

let queue = Promise.resolve();
parentPort.on('message', (m) => {
  // 关闭：等手头的办完、关库、关端口让线程自己退出。被 terminate 强杀时 node:sqlite 的连接还开着，偶发进程级崩溃（0xC0000005）
  if (m?.op === '__close') { queue = queue.then(() => { try { db.close(); } catch { /* 已关 */ } parentPort.close(); }); return; }
  queue = queue.then(() => handle(m));
});

async function handle({ id, op, opts, makeExecSpec, env }) {
  try {
    for (const [k, v] of Object.entries(env ?? {})) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const [mod, name] = OFF_THREAD_OPS[op];
    const fn = (await import(mod))[name];
    const makeExec = makeExecSpec ? (await import(makeExecSpec.module))[makeExecSpec.export] : undefined;
    const result = await fn(db, { ...opts, ...(makeExec ? { makeExec } : {}), onEvent: (event) => parentPort.postMessage({ id, type: 'event', event }) });
    parentPort.postMessage({ id, type: 'done', result });
  } catch (e) {
    try { parentPort.postMessage({ id, type: 'error', error: serializeError(e) }); }
    catch (e2) { parentPort.postMessage({ id, type: 'error', error: serializeError(e2) }); }
  }
}
