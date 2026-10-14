// 单调时钟。
//
// 时间戳（写进库里给人看、排序用的"什么时候"）照旧用墙钟 now()；**时长**（跑了多久、等了多久、超没超时）
// 一律用单调时钟 —— 墙钟会被 NTP 校时、虚拟机休眠恢复、WSL2 的时间同步往回拨或往前跳：
// 往回拨一下，"已用时长"就成了负数；往前跳一下，就凭空撞上"活动时长"上限。原来全仓库 168 处墙钟、0 处单调时钟。

import { performance } from 'node:perf_hooks';

/** 开一个秒表：返回的函数每次调用给出从现在起经过的毫秒数（单调，不受校时影响；带小数，做比较不丢精度 —— 存审计时自己取整）。 */
export function stopwatch() {
  const t0 = performance.now();
  return () => performance.now() - t0;
}

/** 单调时刻（只用来做差，别当时间戳存）。 */
export const monoNow = () => performance.now();
