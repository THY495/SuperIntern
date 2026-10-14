// agent 给的正则不在主线程里跑。
//
// JS 的正则引擎是回溯式的：`(a+)+$` 这一类在一行长文本上能跑几分钟到几小时（Cloudflare 2019 全网故障就是一条 WAF 正则）。
// 原来 grep 工具直接在编排器进程里 `new RegExp(模型给的).test(每一行)` —— 一条坏正则就把编排器卡死，
// 没有时限，存活检查看到的是"进程还活着"。模型会写坏正则，仓库内容里的注入也能诱导它写。
// 现在匹配放进一个工作线程，超时就把线程整个终止，回一句话让模型换写法。

import { Worker } from 'node:worker_threads';

export const GREP_TIMEOUT_MS = 5_000;
export const GREP_MAX_HITS = 200;

export class RegexTimeoutError extends Error {}

/**
 * @param {string} pattern  正则源码（先在主线程编译一次：写错的语法照常当场报，编译本身不会灾难性回溯）
 * @param {{path: string, text: string}[]} files
 * @returns {Promise<string[]>} `路径:行号:内容`
 */
export function grepFiles(pattern, files, { flags = 'gm', timeoutMs = GREP_TIMEOUT_MS, maxHits = GREP_MAX_HITS } = {}) {
  new RegExp(pattern, flags);   // 语法错：同步抛 SyntaxError，与原来的行为一致
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./grep-worker.mjs', import.meta.url), { workerData: { pattern, flags, files, maxHits } });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new RegexTimeoutError(`regex timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    w.once('message', (hits) => { clearTimeout(timer); w.terminate(); resolve(hits); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
