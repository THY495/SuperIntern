// 离线场景集的时钟：让"过了三天"在几分钟里发生。
//
// 只做**离散跳时**：没有子进程在跑的时候，驱动器把偏移量往前拨一段（人几小时后才来看、Ⅱ级事项超时、退避到点）。
// 有子进程在跑时不拨 —— 租约 TTL 按 Date.now() 判、续约按真实时间的定时器走，连续加速会让活着的进程
// 被判成"两分钟没续约"。子进程起的时候经环境变量拿到当时的偏移，跑完之前偏移不变，与父进程一致。
//
// 用法：驱动器自己先 import 这个模块（第一个 import），子进程经 `node --import <本文件>` 载入。

import { isMainThread } from 'node:worker_threads';

export const CLOCK_ENV = 'SI_SCENARIO_CLOCK_OFFSET';
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
let offset = Number(process.env[CLOCK_ENV] ?? 0) || 0;
// 常驻的 worker 线程（core/offthread.mjs）：每次请求时主线程把当前偏移经环境变量带过来，这里每次现读
const cur = isMainThread ? () => offset : () => Number(process.env[CLOCK_ENV] ?? 0) || 0;

class ScenarioDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(realNow() + cur()); else super(...a); }
  static now() { return realNow() + cur(); }
}
globalThis.Date = ScenarioDate;

export const clock = {
  get offset() { return offset; },
  /** 往前拨 ms 毫秒（只许往前）。 */
  // 同时写进环境变量：之后起的 worker 线程（core/offthread.mjs）拿到的是创建那一刻的环境副本
  advance(ms) { if (ms > 0) { offset += ms; process.env[CLOCK_ENV] = String(offset); } },
  now: () => realNow() + offset,
};
