// 离线场景集的驱动器：一个多人、多任务、并行的项目，从建项目一直跑到全部合并（或跑到时限），
// 模型是假的（tests/scenarios/fake-model.mjs），别的全是真的：
//   - 看板（startWeb）+ 守护进程（startDaemon）在本进程里，人经 HTTP 带各自的令牌做事；
//   - 守护进程用真的启动器拉起真的 `node src/cli.mjs run|plan …` 子进程（--mode fake --fake-module --no-sandbox），
//     子进程之间、子进程与看板之间的并发是真的；
//   - 合并、变基验收在宿主上真跑 git 与 node --test（不起容器）。
// 时间：没有子进程在跑时离散往前跳（clock.mjs），人按自己的作息来看。
//
//   node tests/scenarios/run.mjs                 完整预设（30 个任务 / 8 人 / 同时开 4 个）
//   node tests/scenarios/run.mjs --preset small  小预设（CI 里 tests/scenarios.test.mjs 跑的那个）
//   --keep                                       跑完不删临时目录（看库、看日志）
//   --out <file>                                 报告另存一份 JSON
//
// 零花费、零外发：假模型不出网；子进程不读仓库的 .env（SUPERINTERN_ENV_FILE=none）、环境变量只给白名单里的；
// 本进程与子进程的 fetch 都只放行本机地址（preload.mjs），别的当场报错并记进报告。

import { clock, CLOCK_ENV } from './preload.mjs';   // 必须第一个：时钟偏移 + 出网闸，后面的模块一加载就可能读时间
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openDb, ensureOwner } from '../../src/db/db.mjs';
import { seedBinding } from '../../src/llm/registry.mjs';
import { LlmClient } from '../../src/llm/client.mjs';
import { addUser, setUserChannel } from '../../src/core/users.mjs';
import { createServer } from 'node:http';
import { createProject } from '../../src/core/project.mjs';
import { setParallel, setMaxOpen } from '../../src/core/project-settings.mjs';
import { setMember } from '../../src/core/project-members.mjs';
import { applyTemplate, rulesOf, saveRules } from '../../src/core/routing.mjs';
import { makeLauncher } from '../../src/core/launcher.mjs';
import { startDaemon } from '../../src/core/daemon.mjs';
import { startWeb } from '../../src/web/server.mjs';
import { setWorkerPreload, closeOffThread } from '../../src/core/offthread.mjs';
import { makeHostExec } from './host-exec.mjs';
import { stuckNow } from '../../src/core/liveness.mjs';
import { assessTask } from '../../src/core/daemon.mjs';
import { makeTasks, projectSpec, seedRepo } from './world.mjs';
import { makeHumans } from './humans.mjs';
import scenarioFake from './fake-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const H = 3600_000, M = 60_000;

export const PRESETS = {
  small: {
    tasks: 8, seed: 7, maxOpen: 3, simDays: 6, realMinutes: 8,
    // shared 放在开头两个没有依赖的任务上：一开局就同时开着，合并必撞冲突（放后面的话撞不撞看时序）
    profiles: { 2: 'shared', 3: 'shared', 4: 'scope', 5: 'flaky', 6: 'ask' },
    users: [
      { name: '领队', style: 'controller', lead: true },
      { name: '产品', style: 'delegator', tags: [] },
      { name: '技术', style: 'controller', tags: ['reviewer'] },
      { name: '评审', style: 'sampler', tags: ['reviewer'] },
    ],
  },
  full: {
    tasks: 30, seed: 42, maxOpen: 4, simDays: 14, realMinutes: 40,
    mix: { clean: 6, ask: 1.5, scope: 1, flaky: 1, shared: 1.5 },
    users: [
      { name: '领队', style: 'controller', lead: true },
      { name: '产品', style: 'delegator', tags: [] },
      { name: '技术', style: 'controller', tags: ['reviewer'] },
      { name: '前端甲', style: 'sampler', tags: ['reviewer'] },
      { name: '后端乙', style: 'sampler', tags: ['reviewer'] },
      { name: '测试丙', style: 'absent', tags: ['reviewer'] },
      { name: '运维丁', style: 'delegator', tags: [] },
      { name: '实习戊', style: 'sampler', tags: [] },
    ],
  },
};

/** 子进程的环境：白名单（系统路径、临时目录、本部署的 SUPERINTERN_*）。各家 key、通知通道、代理、OTLP 一概不给。 */
const ENV_KEEP = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|TZ|SUPERINTERN_[A-Z_]+)$/i;
function scrubbedEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (ENV_KEEP.test(k) && !/^SUPERINTERN_ENV_FILE$/i.test(k)) out[k] = v;
  return { ...out, SUPERINTERN_ENV_FILE: 'none' };
}

/**
 * 终态完整性：项目分支上的东西对不对 —— 系统说"合并了"不算，要看合出来的代码。
 * 每个已合并任务的模块都在、全部测试一起跑得过、共享登记表里每个 shared 任务的那一行都还在（合并冲突选错一侧会静默丢掉别人的行）。
 */
function integrity({ db, projectId, tasks }) {
  const p = db.one(`SELECT repo, branch FROM projects WHERE id=?`, projectId);
  const merged = new Set(db.all(`SELECT project_order o FROM tasks WHERE project_id=? AND merged_at IS NOT NULL`, projectId).map((r) => r.o));
  const tmp = mkdtempSync(join(tmpdir(), 'si-scen-check-'));
  try {
    execFileSync('git', ['clone', '-q', '--branch', p.branch, p.repo, tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
    const missing = [...merged].filter((k) => !existsSync(join(tmp, 'mods', `m${k}`, 'index.mjs')) || !existsSync(join(tmp, 'mods', `m${k}`, 'index.test.mjs')));
    const files = [...merged].filter((k) => !missing.includes(k)).map((k) => `mods/m${k}/index.test.mjs`);
    let testsOk = true, tail = '';
    if (files.length) {
      try { execFileSync(process.execPath, ['--test', ...files], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { testsOk = false; tail = String(e.stdout ?? '').split('\n').filter((l) => /not ok|✖|fail/i.test(l)).slice(0, 6).join(' | '); }
    }
    const reg = existsSync(join(tmp, 'shared', 'registry.mjs')) ? readFileSync(join(tmp, 'shared', 'registry.mjs'), 'utf8') : '';
    const lostRegistry = tasks.filter((t) => t.profile === 'shared' && merged.has(t.order) && !reg.includes(`registry.m${t.order} = ${t.value};`)).map((t) => t.order);
    const conflictMarkers = /^(<<<<<<<|>>>>>>>|=======$)/m.test(reg);
    return { merged: merged.size, missing, testsOk, failing: tail || null, lostRegistry, conflictMarkers };
  } catch (e) { return { error: String(e?.message ?? e).slice(0, 300) }; }
  finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 尽力 */ } }
}

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** 从 at 起（含）下一个"星期 weekday（UTC，0 = 周日）的 hour 点整"。 */
function nextWeekdayAt(at, weekday, hour) {
  const d = new Date(at);
  d.setUTCHours(hour, 0, 0, 0);
  while (d.getUTCDay() !== weekday || d.getTime() < at) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

export async function runScenario({ preset = 'full', keep = false, log = console.log } = {}) {
  const P = typeof preset === 'string' ? PRESETS[preset] : preset;
  // 模拟起点固定在下一个周三 09:00 UTC：人只在工作日上班时间来，起点跟着跑的那天走的话，周六跑会白等一个周末，
  // 量出来的时长、等待前后没法比（比如周六开跑，一大半时间是周末）
  clock.advance(nextWeekdayAt(clock.now(), 3, 9) - clock.now());
  const dir = mkdtempSync(join(tmpdir(), 'si-scen-'));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  process.env.SUPERINTERN_HOME = home;   // 本进程（与 worker）里被出网闸拦下的也记进这个目录
  const realStart = performance.now();
  const simStart = clock.now();
  const t0 = (at) => `+${((at - simStart) / H).toFixed(1)}h`;

  // ── 世界 ──────────────────────────────────────────────────────────────
  const tasks = makeTasks({ n: P.tasks, seed: P.seed, ...(P.mix ? { mix: P.mix } : {}) });
  for (const [k, prof] of Object.entries(P.profiles ?? {})) { const t = tasks.find((x) => x.order === Number(k)); if (t) t.profile = prof; }
  writeFileSync(join(home, 'scenario.json'), JSON.stringify({ tasks }, null, 2));
  const seed = seedRepo(join(dir, 'seed'));

  const db = openDb(join(home, 'state.db'));
  const owner = ensureOwner(db, P.users.find((u) => u.lead).name);
  seedBinding(db, { overrides: {}, userId: owner.userId });
  const users = [{ ...P.users.find((u) => u.lead), userId: owner.userId, token: owner.plaintext }];
  for (const u of P.users.filter((x) => !x.lead)) {
    const r = addUser(db, { name: u.name, role: 'member', tags: u.tags ?? [], byUserId: owner.userId });
    users.push({ ...u, userId: r.userId, token: r.plaintext });
  }
  const byName = Object.fromEntries(users.map((u) => [u.name, u]));
  // 每人一个通知通道，指到本机的收件端（只回 200）：推送真的走一遍，审计里按人记下 —— 量"每人被推送打断多少次"
  const sink = createServer((rq, rs) => { rq.resume(); rq.on('end', () => { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{}'); }); });
  await new Promise((ok) => sink.listen(0, '127.0.0.1', ok));
  for (const u of users) setUserChannel(db, { userId: u.userId, kind: 'ntfy', target: `http://127.0.0.1:${sink.address().port}/${encodeURIComponent(u.name)}`, byUserId: owner.userId });
  const { projectId } = createProject(db, { userId: owner.userId, spec: projectSpec(tasks), source: seed, home });
  setParallel(db, { projectId, on: true, userId: owner.userId });
  setMaxOpen(db, { projectId, n: P.maxOpen, userId: owner.userId });
  for (const u of users.filter((x) => !x.lead)) setMember(db, { projectId, userId: u.userId, by: owner.userId });
  // 路由：产品管规格取舍，技术 + 负责人管结构与范围，签收两人评审（一个工作日没凑够就交负责人）
  applyTemplate(db, { key: projectId, name: 'pm_tl', bindings: { pm: byName['产品'].userId, tl: byName['技术'].userId }, userId: owner.userId });
  {
    const rules = rulesOf(db, projectId).filter((r) => r.decision_type !== 'signoff');
    rules.push({ decision_type: 'signoff', scope: '*', position: 0, recipients: ['group:reviewer'], quorum: 2, conflict_policy: 'block', timeout_action: 'next', timeout_after: '1bd' });
    rules.push({ decision_type: 'signoff', scope: '*', position: 1, recipients: ['user:lead'], quorum: 1, conflict_policy: 'block', timeout_action: 'hang', timeout_after: null });
    saveRules(db, { key: projectId, rules, userId: owner.userId });
  }

  // ── 子进程：真 CLI + 假模型 + 时钟偏移 ─────────────────────────────────
  const live = new Set();
  const clockUrl = pathToFileURL(join(HERE, 'preload.mjs')).href;
  setWorkerPreload([clockUrl], { envKeys: [CLOCK_ENV, 'SUPERINTERN_HOME'] });   // 推进放到 worker 线程时，worker 也要同一个时钟偏移与出网闸
  const spawnFn = (exe, args, opts) => {
    const child = spawn(exe, ['--disable-warning=ExperimentalWarning', '--import', clockUrl, ...args], { ...opts, env: { ...scrubbedEnv(opts.env ?? {}), SUPERINTERN_HOME: home, [CLOCK_ENV]: String(clock.offset) } });
    live.add(child);
    child.on('exit', () => live.delete(child));
    child.on('error', () => live.delete(child));
    return child;
  };
  const exits = [];
  const launcher = makeLauncher(db, { home, spawnFn, runBinds: ['--mode', 'fake', '--fake-module', join(HERE, 'fake-model.mjs'), '--no-sandbox'],
    onExit: (e) => exits.push({ ...e, at: clock.now() }) });
  const fakeClient = () => new LlmClient({ mode: 'fake', fake: scenarioFake({ db, home }) });

  const web = await startWeb(db, { home, port: 0, tokenPlain: owner.plaintext, launcher, daemon: true, makeClassifierClient: fakeClient, env: {}, runtime: null });
  const base = `http://127.0.0.1:${web.port}`;
  const events = [];
  const daemon = startDaemon(db, { home, launcher, intervalMs: 24 * H, clock: () => clock.now(), runtime: null, prWatcher: null, issueWatcher: null,
    makeExec: makeHostExec, onEvent: (e) => { if (!['sweep'].includes(e.type)) events.push({ at: clock.now(), ...e }); } });
  const humans = makeHumans({ users, base, clock, seed: P.seed, errorRates: P.errorRates ?? {}, log: (m) => log(`  ${t0(clock.now())} ${m}`) });

  // ── 主循环 ────────────────────────────────────────────────────────────
  const tickMs = [], slowTicks = [];
  // 事件循环延迟：看板与守护进程同一个进程（web --daemon），守护进程里的同步操作会让看板整个卡住
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();
  const until = simStart + P.simDays * 24 * H;
  const realLimit = P.realMinutes * M;
  let iter = 0, jumps = 0, lastProgress = '';
  const projStatus = () => db.one(`SELECT status FROM projects WHERE id=?`, projectId).status;
  try {
    while (clock.now() < until && performance.now() - realStart < realLimit) {
      iter++;
      const a = performance.now();
      const tr = await daemon.tick();
      const tms = performance.now() - a;
      tickMs.push(tms);
      if (tms > 1000 && slowTicks.length < 10) slowTicks.push({ ms: Math.round(tms), projects: (tr?.projects ?? []).map((p) => p.reason), launched: (tr?.launched ?? []).length, maintenance: tr?.maintenance ? Object.keys(tr.maintenance) : null, housework: !!tr?.housework });
      await humans.step(db, clock.now());
      const merged = db.one(`SELECT count(*) n FROM tasks WHERE project_id=? AND merged_at IS NOT NULL`, projectId).n;
      const prog = `${merged}/${P.tasks} 合并，${live.size} 个子进程，项目 ${projStatus()}`;
      if (prog !== lastProgress) { log(`${t0(clock.now())} ${prog}`); lastProgress = prog; }
      if (['done', 'aborted'].includes(projStatus())) break;
      if (live.size) { await sleep(120); continue; }
      // 没人在跑：跳到下一件事（人该来看了 / 10 分钟一拍的守护进程），最多跳 10 分钟
      const nextHuman = humans.nextEventAt(clock.now());
      const step = Math.max(M, Math.min(10 * M, nextHuman - clock.now()));
      clock.advance(step); jumps++;
    }
    // 收尾：等还在跑的子进程退出（最多 60 秒真实时间）
    for (let i = 0; i < 300 && live.size; i++) await sleep(200);
  } finally {
    daemon.stop();
    web.close();
    sink.close();
    await closeOffThread();
  }

  // ── 报告 ──────────────────────────────────────────────────────────────
  const at = clock.now();
  const rep = { preset: typeof preset === 'string' ? preset : 'custom', dir, realSeconds: Math.round((performance.now() - realStart) / 1000), simHours: +((at - simStart) / H).toFixed(1), iterations: iter, jumps };
  rep.project = { status: projStatus(), tasks: P.tasks, merged: db.one(`SELECT count(*) n FROM tasks WHERE project_id=? AND merged_at IS NOT NULL`, projectId).n,
    byStatus: Object.fromEntries(db.all(`SELECT status, count(*) n FROM tasks WHERE project_id=? AND project_order>0 GROUP BY status`, projectId).map((r) => [r.status, r.n])) };
  rep.profiles = Object.fromEntries(['clean', 'ask', 'scope', 'flaky', 'shared'].map((p) => {
    const ts = tasks.filter((t) => t.profile === p);
    const ids = ts.map((t) => db.one(`SELECT id, merged_at FROM tasks WHERE project_id=? AND project_order=?`, projectId, t.order));
    return [p, { n: ts.length, merged: ids.filter((x) => x?.merged_at).length }];
  }));
  const qs = db.all(`SELECT q.id, q.text, q.status, q.asked_at, q.resolved_at, q.addressed_to, q.level FROM questions q JOIN tasks t ON t.id=q.task_id WHERE t.project_id=?`, projectId);
  const markOf = (t) => (t.match(/^【[^】]+】/) ?? ['(执行器提问)'])[0];
  rep.questions = { total: qs.length, byStatus: {}, byMark: {}, open: [] };
  for (const q of qs) {
    rep.questions.byStatus[q.status] = (rep.questions.byStatus[q.status] ?? 0) + 1;
    const m = markOf(q.text);
    rep.questions.byMark[m] = (rep.questions.byMark[m] ?? 0) + 1;
    if (['open', 'escalated'].includes(q.status)) rep.questions.open.push({ id: q.id, mark: m, ageH: +((at - q.asked_at) / H).toFixed(1), to: JSON.parse(q.addressed_to).map((id) => users.find((u) => u.userId === id)?.name ?? id) });
  }
  rep.people = [...humans.stats.values()].map((s) => ({ name: s.name, style: s.style, checkins: s.checkins, interrupted: s.interrupted, answered: s.answered, signoffs: s.signoffs, pageViews: s.pageViews,
    received: qs.filter((q) => { const to = JSON.parse(q.addressed_to); const u = users.find((x) => x.name === s.name); return !to.length || to.includes(u.userId); }).length,
    waitP50H: s.waits.length ? +(pct(s.waits, 0.5) / H).toFixed(1) : null, waitMaxH: s.waits.length ? +(Math.max(...s.waits) / H).toFixed(1) : null }));
  // 真人的错，系统怎么接
  rep.humanErrors = {};
  for (const o of humans.outcomes.filter((x) => x.kind !== 'answer')) {
    const k = o.kind;
    rep.humanErrors[k] ??= { n: 0, statuses: {}, errors: {} };
    rep.humanErrors[k].n++;
    rep.humanErrors[k].statuses[o.status] = (rep.humanErrors[k].statuses[o.status] ?? 0) + 1;
    if (o.error) rep.humanErrors[k].errors[String(o.error).slice(0, 120)] = (rep.humanErrors[k].errors[String(o.error).slice(0, 120)] ?? 0) + 1;
    // 成功的那几次回给人的是什么（同一种回复只留一条，最多 6 条）：抢输了的人有没有被告知
    if (o.said && o.mark !== '【签收】') {
      const said = rep.humanErrors[k].said ??= [];
      const key = o.said.replace(/[a-z]{1,3}_[0-9a-f]{12}/g, '…').replace(/\d{13}/g, '…');
      if (said.length < 6 && !said.some((x) => x.key === key)) said.push({ key, user: o.user, mark: o.mark, said: o.said });
    }
  }
  rep.answerFailures = humans.outcomes.filter((x) => x.kind === 'answer' && x.status >= 400).map((x) => ({ user: x.user, mark: x.mark, status: x.status, error: String(x.error).slice(0, 200) }));
  // 看板响应时间（按路由）
  const byRoute = {};
  for (const h of humans.http) (byRoute[h.route] ??= []).push(h.ms);
  rep.http = Object.fromEntries(Object.entries(byRoute).map(([k, xs]) => [k, { n: xs.length, p50: +pct(xs, 0.5).toFixed(1), p95: +pct(xs, 0.95).toFixed(1), max: +Math.max(...xs).toFixed(1) }]));
  rep.http5xx = humans.http.filter((h) => h.status >= 500).length;
  // 慢的那几次请求（看板与守护进程同一个进程：一次慢请求 = 事件循环停顿的嫌疑人）。事件循环最长停顿要能在报告里对上是谁
  rep.httpSlow = humans.http.filter((h) => h.ms > 500).sort((x, y) => y.ms - x.ms).slice(0, 10).map((h) => ({ route: h.route, ms: Math.round(h.ms), status: h.status }));
  rep.daemonTick = { n: tickMs.length, p50: +pct(tickMs, 0.5).toFixed(1), p95: +pct(tickMs, 0.95).toFixed(1), max: +Math.max(...tickMs).toFixed(1), slow: slowTicks };
  loopDelay.disable();
  rep.eventLoop = { p99Ms: Math.round(loopDelay.percentile(99) / 1e6), maxMs: Math.round(loopDelay.max / 1e6) };
  // 出事的痕迹
  const auditN = (action) => db.one(`SELECT count(*) n FROM audit_log WHERE action=?`, action).n;
  rep.incidents = Object.fromEntries(['process_crashed', 'daemon_tick_failed', 'http_error', 'launch_failed', 'project_advance_failed', 'lease_lost', 'handback_raise_failed', 'run_crashed']
    .map((a) => [a, auditN(a)]).filter(([, n]) => n));
  rep.childExits = { n: exits.length, nonZero: exits.filter((e) => e.code !== 0).length };
  rep.stuck = (() => { try { return stuckNow(db, { at, assess: (d2, t, o) => assessTask(d2, t, o), isLive: () => null, hasWorkspace: (id) => existsSync(join(home, 'workspaces', id)) }).map((s) => ({ task: s.title ?? s.taskId, kind: s.kind, why: String(s.why).slice(0, 160) })); } catch (e) { return [{ error: e.message }]; } })();
  rep.invariants = db.all(`SELECT id, violations, sample, error FROM invariant_state WHERE violations > 0 OR error IS NOT NULL`).map((r) => ({ name: r.id, violations: r.violations, sample: String(r.sample ?? r.error ?? '').slice(0, 300) }));
  rep.integrity = integrity({ db, projectId, tasks });
  rep.dbBusy = (() => {
    const mdir = join(home, 'metrics');
    if (!existsSync(mdir)) return null;
    let busy = 0, lockMax = 0, files = 0;
    for (const f of readdirSync(mdir)) { try { const m = JSON.parse(readFileSync(join(mdir, f), 'utf8')); files++; busy += m.busy ?? 0; lockMax = Math.max(lockMax, m.lock?.maxMs ?? 0); } catch { /* 写到一半 */ } }
    return { files, busy, lockMaxMs: Math.round(lockMax) };
  })();
  // 假模型自己没接住的（场景集本身的缺口，不是系统的问题）
  const notes = existsSync(join(home, 'fake-notes.jsonl')) ? readFileSync(join(home, 'fake-notes.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  rep.fakeNotes = { n: notes.length, sample: notes.slice(0, 8) };
  rep.egressAttempts = existsSync(join(home, 'egress-attempts.jsonl')) ? readFileSync(join(home, 'egress-attempts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  // 发到本机收件端以外的通知（场景集不该读到开发者的 .env 往外发）；发给收件端的是有意的，算在 rep.pushes 里
  rep.notificationsSent = db.one(`SELECT count(*) n FROM audit_log WHERE action='notification_sent' AND json_extract(payload, '$.ok') AND NOT (json_extract(payload,'$.userId') IS NOT NULL AND json_extract(payload,'$.host') LIKE '127.0.0.1%')`).n;
  // 每人被推送打断几次：总数、每个模拟日、任意 1 小时里最多几条、下班时间（当地 9–18 点以外 / 周末）几条、按种类
  {
    const rows = db.all(`SELECT ts, json_extract(payload,'$.userId') uid, json_extract(payload,'$.notifyKind') kind FROM audit_log
                         WHERE action='notification_sent' AND json_extract(payload,'$.ok') AND json_extract(payload,'$.userId') IS NOT NULL ORDER BY ts`);
    const days = Math.max(1, (at - simStart) / (24 * H));
    rep.pushes = users.map((u) => {
      const mine = rows.filter((r) => r.uid === u.userId);
      let burst = 0;
      for (let i = 0, j = 0; i < mine.length; i++) { while (mine[i].ts - mine[j].ts > H) j++; burst = Math.max(burst, i - j + 1); }
      const off = mine.filter((r) => { const d = new Date(r.ts); const h = d.getUTCHours(); return d.getUTCDay() === 0 || d.getUTCDay() === 6 || h < 9 || h >= 18; }).length;
      const byKind = Object.entries(mine.reduce((m, r) => { m[r.kind] = (m[r.kind] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
      return { name: u.name, style: u.style, total: mine.length, perDay: +(mine.length / days).toFixed(1), maxPerHour: burst, offHours: off, byKind: Object.fromEntries(byKind) };
    });
  }
  rep.events = Object.entries(events.reduce((m, e) => { m[e.type] = (m[e.type] ?? 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 20);
  db.close();
  if (!keep) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶尔有句柄没放 */ } }
  return rep;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const rep = await runScenario({ preset: val('--preset') ?? 'full', keep: args.includes('--keep') });
  const out = JSON.stringify(rep, null, 2);
  console.log(out);
  if (val('--out')) writeFileSync(val('--out'), out);
  process.exit(0);
}
