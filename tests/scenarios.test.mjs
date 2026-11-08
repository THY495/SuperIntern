// 离线场景集 · 小预设：8 个任务 / 4 个人 / 同时开 3 个，假模型、零花费、零外发。
// 驱动器与各部件见 tests/scenarios/（run.mjs 的文件头）；完整预设（30 个任务 / 8 人）单独跑：node tests/scenarios/run.mjs
//
// 跑：node tests/scenarios.test.mjs
//
// 断言的是"整条链在多人、并行、真人出错时还站得住"：全部合并、合出来的代码对、没丢别人的改动、
// 没卡死、没崩、没出网；各剧本对应的那条路（规格提问、越界批准、验收没过、合并冲突、两人签收）真的走到了；
// 真人的错（抢答、旧页面、连点、答错再改）被接住，且回给人的话说得清。

import { runScenario, PRESETS } from './scenarios/run.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const J = (x) => JSON.stringify(x).slice(0, 600);

// 错误注入开满：抢答、旧页面、连点、答错各自有足够的样本（比例是 small 预设里每种都能出现几次的量）
const rep = await runScenario({ preset: { ...PRESETS.small, errorRates: { race: 0.6, stale: 0.25, double: 0.2, wrong: 0.5 } }, log: () => {} });

section('1. 整条链跑完，合出来的代码对');
{
  eq(rep.project.status, 'done', `项目完成（模拟 ${rep.simHours} 小时，真实 ${rep.realSeconds} 秒）`);
  eq(rep.project.merged, rep.project.tasks, `${rep.project.tasks} 个任务全部合并`);
  assert(rep.integrity && !rep.integrity.error, '完整性检查跑得起来', J(rep.integrity));
  eq(rep.integrity.missing?.length, 0, '每个合并了的任务的模块与测试都在项目分支上');
  eq(rep.integrity.testsOk, true, '项目分支上全部测试一起跑得过');
  eq(rep.integrity.lostRegistry?.length, 0, '共享文件里每个任务加的那一行都还在（合并冲突没丢掉别人的改动）');
  eq(rep.integrity.conflictMarkers, false, '共享文件里没有残留的冲突标记');
}

section('2. 没卡死、没崩、没出网');
{
  eq(rep.stuck.length, 0, `跑完没有说不出在等谁的任务 ${rep.stuck.length ? J(rep.stuck) : ''}`);
  eq(rep.invariants.length, 0, `运行期不变量全部成立 ${rep.invariants.length ? J(rep.invariants) : ''}`);
  eq(Object.keys(rep.incidents).length, 0, `没有崩溃 / 拍失败 / 接口出错 / 推进失败 ${J(rep.incidents)}`);
  eq(rep.http5xx, 0, '看板接口没有 5xx');
  eq(rep.egressAttempts.length, 0, `没有出网尝试 ${rep.egressAttempts.length ? J(rep.egressAttempts.slice(0, 2)) : ''}`);
  eq(rep.notificationsSent, 0, '除了本机收件端，没有发出任何通知（场景集不读开发者的 .env）');
  eq(rep.dbBusy?.busy ?? 0, 0, `并发进程之间没有撞上 SQLITE_BUSY（最长等锁 ${rep.dbBusy?.lockMaxMs ?? '?'} ms）`);
}

section('3. 每个剧本对应的那条路都真的走到了');
{
  const m = rep.questions.byMark;
  assert(m['(执行器提问)'] >= 1, 'ask：执行器提了规格取舍，人答了才接着做', J(m));
  assert(m['【扩大范围要你批准】'] >= 1, 'scope：越界改动转成了扩范围批准', J(m));
  assert(m['【验收没过】'] >= 1, 'flaky：验收没过挂了事项，人答"接着修"之后修好', J(m));
  assert(m['【结构矛盾】'] >= 1, 'shared：两个并行任务改同一个文件，合并冲突交给人选', J(m));
  assert(m['【签收】'] >= rep.project.tasks, '每个任务都走了签收（两人评审）', J(m));
  for (const [p, v] of Object.entries(rep.profiles)) eq(v.merged, v.n, `剧本 ${p}：${v.n} 个都合并了`);
  eq(rep.questions.open.length, 0, '跑完没有悬着的事项');
}

section('4. 真人的错被接住，回给人的话说得清');
{
  const he = rep.humanErrors;
  const race = he.race;
  assert(race?.n >= 2, `抢答出现了（${race?.n ?? 0} 次）`);
  assert(!race?.statuses?.['500'], '抢答没有让接口出错');
  const lateNote = (race?.said ?? []).find((s) => /"late":true/.test(s.said));
  if (lateNote) assert(/已有结论/.test(lateNote.said), '抢输的那一方被告知"该事项已有结论"，而不是悄悄被覆盖', lateNote.said);
  else ok('（这一跑抢答都落在签收上，签收按法定人数各算各的，没有"抢输"）');
  const stale = he.stale;
  if (stale?.statuses?.['409']) {
    const msgs = Object.keys(stale.errors ?? {});
    assert(msgs.every((x) => /已由|已经|不再/.test(x)), '旧页面上答已经结了的事项：拒绝，并说清是谁什么时候答的', J(msgs));
  } else ok('（这一跑旧页面答的事项都还开着，照常收下）');
  const dbl = he.double;
  if (dbl) assert(Object.keys(dbl.statuses).every((s) => Number(s) < 500), `连点两下：没有 5xx（${J(dbl.statuses)}）`);
  else ok('（这一跑没有连点）');
  eq(rep.answerFailures.length, 0, `正常答复没有被拒 ${rep.answerFailures.length ? J(rep.answerFailures) : ''}`);
}

section('5. 人的负担与响应');
{
  for (const p of rep.people) console.log(`    ${p.name}（${p.style}）：收到 ${p.received} 条，被打断 ${p.interrupted} 次 / 来看 ${p.checkins} 次，答 ${p.answered}、签收 ${p.signoffs}，等待中位 ${p.waitP50H ?? '-'} h`);
  const worst = Math.max(...Object.values(rep.http).map((h) => h.p95));
  assert(worst < 1000, `看板接口 p95 都在 1 秒内（最慢 ${worst.toFixed(0)} ms）`, J(rep.http));
  console.log(`    守护进程一拍：中位 ${rep.daemonTick.p50} ms，p95 ${rep.daemonTick.p95} ms，最长 ${rep.daemonTick.max} ms`);
  // 看板与守护进程同进程（web --daemon）：合并要跑几十条同步 git，放到 worker 线程之前每次合并卡看板 1–2 秒
  // 修之前每次合并卡 1.8–4 秒、反复出现；修之后偶尔一次几百毫秒的停顿（GC、系统抖动）不算 —— 两条一起看
  assert(rep.eventLoop.maxMs < 1000 && rep.eventLoop.p99Ms < 100, `合并期间看板不卡：事件循环最长延迟 ${rep.eventLoop.maxMs} ms、p99 ${rep.eventLoop.p99Ms} ms`);
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
