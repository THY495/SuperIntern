// 场景集的预加载：驱动器第一个 import 它，子进程经 `node --import <本文件>` 载入。
//   1. 时钟偏移（clock.mjs）
//   2. 出网闸：只放行本机地址（看板的 HTTP 接口）。别的一律当场报错，并记一行到 <home>/egress-attempts.jsonl ——
//      场景集零花费、零外发，哪条路漏了 fake / 读到了谁的通知配置，报告里看得见，而不是真发出去。

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
export { clock, CLOCK_ENV } from './clock.mjs';

const LOCAL = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  let host = '';
  try { host = new URL(url).hostname; } catch { /* 相对地址之类：照样拦 */ }
  if (LOCAL.has(host)) return realFetch(input, init);
  try {
    const home = process.env.SUPERINTERN_HOME;
    if (home) appendFileSync(join(home, 'egress-attempts.jsonl'), JSON.stringify({ at: Date.now(), pid: process.pid, host, url: url.slice(0, 120), stack: String(new Error().stack).split('\n').slice(2, 6).map((l) => l.trim()) }) + '\n');
  } catch { /* 尽力 */ }
  throw new Error(`场景集不出网：${host || url.slice(0, 60)}`);
};
