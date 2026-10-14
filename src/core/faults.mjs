// 故障注入。灾难性故障大多出在错误处理路径上（Yuan 等，OSDI'14：92%），而错误路径平时几乎跑不到。
// 生产代码在几个边界上调 maybeFault(点, 上下文)：没登记规则时立刻返回（一次 length 判断，不花钱）；
// 测试用 setFaults 登记"在哪个点、什么条件下、抛什么错、抛几次"，把平时碰不到的失败逼出来，看状态是否仍然一致、能否恢复。
//
// 注入点：
//   git      core/git.mjs 的 gitRaw（ctx: { args }）
//   exec     执行器跑命令（ctx: { file, args }）
//   llm      LlmClient 每次调用模型之前（ctx: { tier }）
//   db.tx    拿写锁开事务之前（ctx: {}）
// 子进程里的注入经环境变量 SUPERINTERN_FAULTS（JSON 数组：[{ point, argsIncludes?, message?, code?, times? }]）。

let rules = [];

/** 登记规则（覆盖旧的）。rule: { point, match?(ctx)→bool, error?(ctx)→Error | message?, after?（先放过几次）, times?（之后抛几次） } */
export function setFaults(list) { rules = (list ?? []).map((r) => ({ ...r, hits: 0, seen: 0 })); }
export function clearFaults() { rules = []; }
/** 某条规则实际触发了几次（测试断言用）。 */
export const faultHits = (point) => rules.filter((r) => r.point === point).reduce((s, r) => s + r.hits, 0);

if (process.env.SUPERINTERN_FAULTS) {
  try {
    setFaults(JSON.parse(process.env.SUPERINTERN_FAULTS).map((r) => ({
      point: r.point, times: r.times,
      match: r.argsIncludes ? (ctx) => (ctx.args ?? []).join(' ').includes(r.argsIncludes) : undefined,
      error: () => Object.assign(new Error(r.message ?? `injected fault at ${r.point}`), r.code ? { code: r.code } : {}),
    })));
  } catch { /* 写错了就当没开 —— 注入只给测试用，不能让生产因为它起不来 */ }
}

export function maybeFault(point, ctx = {}) {
  if (!rules.length) return;
  for (const r of rules) {
    if (r.point !== point) continue;
    if (r.match && !r.match(ctx)) continue;
    if (r.after && r.seen++ < r.after) continue;
    if (r.times != null && r.hits >= r.times) continue;
    r.hits++;
    throw typeof r.error === 'function' ? r.error(ctx) : new Error(r.message ?? `injected fault at ${point}`);
  }
}
