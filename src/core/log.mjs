// 结构化日志。
//
// 原来的日志只有给人看的文本：守护进程 / 看板 / 任务进程的 console 输出被计划任务、systemd、启动器重定向进文件，
// 看板直接拉任务日志的尾巴给人看。人看着够用，但对不上号 —— 一行"第 3 步失败"是哪个任务、哪一步、哪个进程、
// 由哪一拍守护进程拉起来的，只能靠时间猜。
//
// 这里不动给人看的那一份（看板照旧显示原文），而是在长期运行的进程里**另写一份 JSON 行**：console 每输出一行，
// 同时往 `.superintern/logs/jsonl/` 写一条 { ts, level, msg, proc, pid, run, trace, task, node, ... }：
//   - run   = 进程寿命标识，与租约的 holder 同一个值（db/lease.mjs 的 HOLDER），租约 / 审计寿命行里的 pid 都对得上；
//   - trace = 一条因果链的标识：守护进程起一个，经环境变量 SUPERINTERN_TRACE 传给它拉起的子进程（启动器继承环境），
//             同一次拉起里的守护进程日志、任务进程日志、OTLP span（core/otel.mjs）共用它；
//   - task / node = 当前在做哪个任务的哪一步，用 AsyncLocalStorage 传（并行执行的几步各是各的）。
// 账本（usage_ledger 有 task / node / proc_pid）与审计（target_id / payload.pid）按这几个键就能和日志对上。
//
// 轮转：每个进程每天一个文件，超过 maxBytes 换下一个；按天数删旧的由守护进程的例行维护做（core/housekeeping.mjs）。

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { HOLDER } from '../db/lease.mjs';
import { redact, redactDeep } from './redact.mjs';
import { procKind } from './lifetimes.mjs';

export const TRACE_ENV = 'SUPERINTERN_TRACE';
const als = new AsyncLocalStorage();
let base = {};
let sink = null;

/** 当前的 trace id（32 位十六进制，与 W3C trace-id 同形）。没有就起一个并放进环境变量，之后拉起的子进程都继承它。 */
export function traceId() {
  let t = process.env[TRACE_ENV];
  if (!/^[0-9a-f]{32}$/.test(t ?? '') || /^0+$/.test(t)) { t = randomBytes(16).toString('hex'); process.env[TRACE_ENV] = t; }
  return t;
}

/** 换一条新的因果链（守护进程每拉起一批活之前调）。 */
export function newTrace() { delete process.env[TRACE_ENV]; return traceId(); }

/** 进程级的上下文（如 run <task> 进程的 task）。 */
export function setLogBase(ctx) { base = { ...base, ...ctx }; }

export const logContext = () => ({ ...base, ...(als.getStore() ?? {}) });

/** 在 fn（及它引出的所有异步续体）里带上 ctx。 */
export const withLogContext = (ctx, fn) => als.run({ ...(als.getStore() ?? {}), ...ctx }, fn);

/**
 * 从这里起、到当前异步函数结束，都带上 ctx（循环里逐个处理步骤时用：不必把循环体改成回调）。
 * 只影响调用方自己和它之后引出的续体，不会漏到调用方的调用方去 —— 前提是调用方是 async 函数、外层用 withLogContext 包过。
 */
export const enterLogContext = (ctx) => als.enterWith({ ...(als.getStore() ?? {}), ...ctx });

const ANSI = /\x1b\[[0-9;]*m/g;

function record(level, msg, extra = {}) {
  const ctx = logContext();
  return { ts: new Date().toISOString(), level, msg, proc: procKind(), pid: process.pid, run: HOLDER, trace: traceId(), ...ctx, ...extra };
}

function write(rec) {
  if (!sink) return;
  const line = JSON.stringify(redactDeep(rec)) + '\n';
  try {
    if (sink.bytes + line.length > sink.maxBytes) roll();
    appendFileSync(sink.file, line);
    sink.bytes += Buffer.byteLength(line);
  } catch { /* 日志写不进去不能拖垮进程（盘满、目录被删）；给人看的那一份照常 */ }
}

function fileFor(n) {
  const day = new Date().toISOString().slice(0, 10);
  return join(sink.dir, `${day}-${sink.proc.replace(/[^\w.-]/g, '_')}-${process.pid}${n ? `.${n}` : ''}.jsonl`);
}

function roll() {
  sink.n++;
  sink.file = fileFor(sink.n);
  sink.bytes = 0;
}

/**
 * 在长期运行的进程里装上 JSON 行日志：console.log / info / warn / error 照常输出，同时各写一条结构化记录。
 * @returns {{file: string, uninstall: () => void}}
 */
export function installLogSink({ home, maxBytes = 20 * 1024 * 1024, target = console } = {}) {
  if (sink) return { file: sink.file, uninstall: sink.uninstall };
  const dir = join(home, 'logs', 'jsonl');
  try { mkdirSync(dir, { recursive: true }); } catch { return { file: null, uninstall: () => {} }; }
  sink = { dir, proc: procKind(), maxBytes, n: 0, bytes: 0, file: null };
  sink.file = fileFor(0);
  try { sink.bytes = statSync(sink.file).size; } catch { /* 新文件 */ }
  const orig = {};
  for (const [m, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    orig[m] = target[m];
    target[m] = (...args) => {
      // 给人看的那一份也脱敏：它被计划任务 / systemd / 启动器重定向进 logs/ 下的文件
      const text = format(...args);
      const safe = redact(text);
      orig[m].apply(target, safe === text ? args : [safe]);
      const msg = safe.replace(ANSI, '');
      if (msg.trim()) write(record(level, msg));
    };
  }
  sink.uninstall = () => { for (const m of Object.keys(orig)) target[m] = orig[m]; sink = null; };
  return { file: sink.file, uninstall: sink.uninstall };
}

/** 只进 JSON 行、不打到 console 的结构化事件（字段原样带上）。没装 sink 时什么都不做。 */
export function logEvent(event, fields = {}, level = 'info') {
  write(record(level, event, { event, ...fields }));
}

/** 当前 sink 的文件（测试用）。 */
export const logSinkFile = () => sink?.file ?? null;
