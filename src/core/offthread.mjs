// 重活放到 worker 线程（场景集查出）。
//
// git 一律是同步调用（core/git.mjs：execFileSync，有时限、禁交互）。一次项目推进（集成、交付到项目仓库、ff 合并）
// 要跑几十条 git，Windows 上每条几十毫秒；推到 GitHub 的那一条还要等网络。看板与守护进程在同一个进程里时
// （`web --daemon`，也就是 npm start），这几秒里事件循环被占住，看板对所有人都不响应 —— 30 个任务的场景里
// 每次合并卡 1–2 秒，最长 2.2 秒。
//
// 这里把这几种操作挪到一个常驻的 worker 线程（每个库文件一个，按到达顺序一件一件做）：worker 自己开一条库连接
// （同一个文件，WAL 下与别的进程并发一样），主线程只等结果。互斥靠的还是原来那几道（项目推进的 project:<id> 租约、
// 交付的幂等检查），与在哪个线程跑无关。常驻而不是每次现起：守护进程每拍都要推进每个项目，现起一个 worker
// 的开销（载入整套模块）比大多数"没事可做"的推进本身还大。
//
// 放不过去的就照旧在本线程跑：库是 :memory:（测试）、调用方注入了函数（假 fetch、测试用的执行器）——
// 函数过不了线程边界，丢掉它们会悄悄改掉调用方要的行为。onEvent 例外：事件经消息转回来。

import { Worker } from 'node:worker_threads';
import { I18nError } from '../i18n/index.mjs';

/** 可以放到 worker 里跑的操作：名字 → [模块（相对本文件）, 导出名]。 */
export const OFF_THREAD_OPS = {
  advanceProject: ['./project.mjs', 'advanceProject'],
  deliverProject: ['./project.mjs', 'deliverProject'],
  deliverTask: ['./deliver.mjs', 'deliverTask'],
};

const preload = [];
const forwardEnv = [];
/**
 * worker 先载入的模块，与每次请求时从主线程带过去的环境变量（测试用：离线场景集的时钟偏移与出网闸 ——
 * 时钟偏移会往前拨，常驻 worker 里那份环境副本是起它那一刻的）。之后新起的 worker 才载入新的模块。
 */
export function setWorkerPreload(urls, { envKeys = [] } = {}) { preload.length = 0; preload.push(...urls); forwardEnv.length = 0; forwardEnv.push(...envKeys); }

/** 为什么这一次只能在本线程跑（null = 可以放过去）。 */
export function inlineReason(db, opts) {
  if (!db?.path || db.path === ':memory:') return 'memory_db';
  for (const [k, v] of Object.entries(opts ?? {})) {
    if (typeof v !== 'function') continue;
    if (k === 'onEvent') continue;
    if (k === 'fetchFn' && v === globalThis.fetch) continue;   // 默认的 fetch：worker 里有同一个
    if (k === 'makeExec' && v.workerSpec) continue;           // 带了"在 worker 里怎么重建"的执行器工厂
    return `fn:${k}`;
  }
  return null;
}

const workers = new Map();   // dbPath -> { w, pending: Map<id, {resolve, reject, onEvent}> }
let seq = 0;

function workerFor(dbPath) {
  let h = workers.get(dbPath);
  if (h) return h;
  const w = new Worker(new URL('./offthread-worker.mjs', import.meta.url), { workerData: { dbPath, preload: [...preload] } });
  w.unref();   // 不拖住进程退出：没有在办的事时进程照常结束
  h = { w, pending: new Map() };
  const fail = (e) => {
    if (workers.get(dbPath) === h) workers.delete(dbPath);
    for (const p of h.pending.values()) p.reject(e);
    h.pending.clear();
  };
  w.on('message', (m) => {
    const p = h.pending.get(m.id);
    if (!p) return;
    if (m.type === 'event') { try { p.onEvent?.(m.event); } catch { /* 事件回调出错不影响操作本身 */ } return; }
    h.pending.delete(m.id);
    if (!h.pending.size) w.unref();
    if (m.type === 'done') p.resolve(m.result);
    else p.reject(rebuildError(m.error));
  });
  w.on('error', fail);
  w.on('exit', (code) => fail(new Error(`offThread: worker 退出（${code}）`)));
  workers.set(dbPath, h);
  return h;
}

/**
 * 跑 OFF_THREAD_OPS[op](db, opts)：能放到 worker 就放过去，不能就在本线程跑。结果与报错与直接调用一样
 * （I18nError 按模板重建，错误上挂的字段 —— taskId、leaseHeld 之类 —— 原样带回）。
 */
export async function offThread(db, op, opts = {}) {
  const spec = OFF_THREAD_OPS[op];
  if (!spec) throw new Error(`offThread: 不认识的操作 ${op}`);
  if (inlineReason(db, opts)) {
    const fn = (await import(spec[0]))[spec[1]];
    return fn(db, opts);
  }
  const { onEvent, makeExec, fetchFn, ...rest } = opts;
  const h = workerFor(db.path);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    h.pending.set(id, { resolve, reject, onEvent });
    h.w.ref();   // 有事在办：进程等它办完
    h.w.postMessage({ id, op, opts: rest, makeExecSpec: makeExec?.workerSpec ?? null, env: Object.fromEntries(forwardEnv.map((k) => [k, process.env[k]])) });
  });
}

/** 关掉所有 worker（测试收尾、进程退出前）。 */
export async function closeOffThread() {
  const all = [...workers.values()];
  workers.clear();
  // 先请它自己关（办完手头的、关库、退出）；5 秒没退再强杀
  await Promise.all(all.map((h) => new Promise((resolve) => {
    const kill = setTimeout(() => { h.w.terminate().catch(() => {}).finally(resolve); }, 5000);
    h.w.once('exit', () => { clearTimeout(kill); resolve(); });
    try { h.w.ref(); h.w.postMessage({ op: '__close' }); } catch { clearTimeout(kill); h.w.terminate().catch(() => {}).finally(resolve); }
  })));
}

/** worker 里抛的错 → 可以跨线程的普通对象。 */
export function serializeError(e) {
  const out = { message: String(e?.message ?? e), name: e?.name ?? 'Error', stack: e?.stack ?? null, tpl: e?.tpl ?? null, params: e?.params ?? null, props: {} };
  for (const [k, v] of Object.entries(e ?? {})) {
    if (['tpl', 'params'].includes(k) || typeof v === 'function') continue;
    try { structuredClone(v); out.props[k] = v; } catch { /* 过不了线程边界的字段丢掉 */ }
  }
  return out;
}

function rebuildError(s) {
  const e = s.tpl ? new I18nError(s.tpl, s.params) : new Error(s.message);
  if (s.name && s.name !== e.name) { try { e.name = s.name; } catch { /* 只读 */ } }
  if (s.stack) e.stack = s.stack;
  Object.assign(e, s.props);
  return e;
}
