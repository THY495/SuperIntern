// 部署健康：给管理员看的一张"这台看板现在怎么样"的清单。
//
// 原来各种状况散在各处：容器运行时掉了有顶部横幅，守护进程没开在待办里有一条，SQLite 版本有问题有提示条；
// 但备份做没做、完整性检查过没过、库和 WAL 多大，只能去翻审计或上服务器看。守护进程不开时备份和检查根本不做，
// 也没有任何地方说。这里把它们收成一份清单：每一项一个级别（ok / warn / bad / unknown），外加判断用到的事实。
// 文字由看板按界面语言写（这里只给结构化的事实），命令行也能读同一份。
//
// 以后的熔断状态、违反中的不变量、重查哨兵都往 checks 里加一项，不另开页面。
//
// 只读：不做任何检查或修复（那些由守护进程的例行维护做，见 db-maintenance.mjs）。查询都走带索引的审计（action, ts）。

import { statSync, statfsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getSetting } from './settings.mjs';
import { sqliteAdvice } from './sqlite-check.mjs';
import { daemonStatus } from './daemon.mjs';
import { listBackups, RETENTION } from '../db/backup.mjs';
import { WAL_CHECKPOINT_BYTES } from './db-maintenance.mjs';
import { calendarHealth } from './calendar.mjs';
import { healthView, healthKey } from '../llm/health.mjs';
import { catalogOf, endpointsOf, bindingOf } from '../llm/registry.mjs';
import { invariantsView, rechecksView } from './invariants.mjs';
import { withheldToolEnv } from './egress.mjs';

const H = 3600_000;
const PKG = (() => { try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')); } catch { return {}; } })();
export const VERSION = PKG.version ?? 'dev';
// 系统缺陷往哪报（package.json 的 bugs.url）：健康卡上要人"报一条"的地方给出入口
export const ISSUES_URL = typeof PKG.bugs === 'string' ? PKG.bugs : PKG.bugs?.url ?? null;

/** 构建号：版本 + 页面与脚本的内容摘要。看板和服务端对不上 = 服务端换了代码、页面还是旧的。 */
export function buildId(parts) {
  const h = createHash('sha256').update(VERSION);
  for (const p of parts) h.update('\0').update(p);
  return `${VERSION}+${h.digest('hex').slice(0, 10)}`;
}

const LEVELS = ['ok', 'unknown', 'warn', 'bad'];
const worstOf = (xs) => xs.reduce((w, x) => (LEVELS.indexOf(x) > LEVELS.indexOf(w) ? x : w), 'ok');
const size = (f) => { try { return statSync(f).size; } catch { return null; } };
// 所在的盘还剩多少（备份失败最常见的原因是盘满；拿不到就 null）
const diskFree = (dir) => { try { const st = statfsSync(dir); return Number(st.bavail) * Number(st.bsize); } catch { return null; } };

// Windows 的路径不分大小写，别的系统分
const samePath = (a, b) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** 库文件的路径（内存库为 null） */
export const dbFileOf = (db) => db.all(`PRAGMA database_list`).find((r) => r.name === 'main')?.file || null;

function lastAudit(db, action, where = '', ...args) {
  const r = db.one(`SELECT ts, payload FROM audit_log WHERE action=? ${where} ORDER BY ts DESC, id DESC LIMIT 1`, action, ...args);
  if (!r) return null;
  let payload = {}; try { payload = JSON.parse(r.payload || '{}'); } catch { /* 坏的 payload 当没有 */ }
  return { at: r.ts, ...payload };
}

/**
 * 部署健康清单。
 * opts：home（守护进程心跳文件所在）、inProcessDaemon（看板自己带着守护进程）、runtime（容器运行时健康的 current() 结果）、at。
 * 返回 { at, version, build, node, sqlite, schema, worst, checks: [{ key, level, ... }] }。
 */
export function deploymentHealth(db, { home = null, inProcessDaemon = false, runtime = undefined, build = null, at = Date.now() } = {}) {
  const checks = [];
  const unfinished = db.one(`SELECT count(*) n FROM tasks WHERE status IN ('planning','running','waiting') AND archived_at IS NULL`).n;
  const paused = !!getSetting(db, 'deploy.paused');

  // ① 守护进程：没开时不推进任务、不处理超时与通知，也**不做定期备份与完整性检查**（这一条原来哪儿都没说）
  const ds = home ? daemonStatus(home, { at }) : { alive: false, lastBeatAt: null };
  const alive = inProcessDaemon || ds.alive;
  // 管理员暂停了全部自动运行：守护进程在也不推进 —— 算「注意」（标「正常」会被忽略）
  checks.push({ key: 'daemon', level: !alive ? (unfinished ? 'bad' : 'warn') : paused ? 'warn' : 'ok', alive, inProcess: !!inProcessDaemon, lastBeatAt: ds.lastBeatAt ?? null, unfinished, paused });

  // ② 容器运行时：上一次探测的结论（不等探测；还没探过 = unknown）
  if (runtime !== undefined) {
    checks.push(runtime == null ? { key: 'runtime', level: 'unknown' }
      : { key: 'runtime', level: runtime.ok ? 'ok' : 'bad', ok: !!runtime.ok, cli: runtime.cli ?? null, version: runtime.version ?? null, why: runtime.ok ? null : String(runtime.why ?? ''), downSince: runtime.downSince ?? null, checkedAt: runtime.checkedAt ?? null });
  }

  // ③ 状态库：体积、WAL（超过检查点阈值两倍 = 有长时间的读者挡着、维护做不完）、可回收的空页
  const file = dbFileOf(db);
  const pageSize = db.one(`PRAGMA page_size`).page_size, pages = db.one(`PRAGMA page_count`).page_count, free = db.one(`PRAGMA freelist_count`).freelist_count;
  const walBytes = file ? size(`${file}-wal`) ?? 0 : 0;
  checks.push({ key: 'db', level: walBytes > 2 * WAL_CHECKPOINT_BYTES ? 'warn' : 'ok', file, bytes: file ? size(file) : pageSize * pages, walBytes, freeBytes: free * pageSize, walLimit: WAL_CHECKPOINT_BYTES,
    diskFree: file ? diskFree(dirname(file)) : null, daemonAlive: alive,
    schema: db.one(`PRAGMA user_version`).user_version });

  // ④ 备份：间隔设置、最近一次成功 / 失败、备份目录里有几份
  const every = Number(getSetting(db, 'deploy.backup_every_hours'));
  const ok = lastAudit(db, 'db_backup');
  const failed = lastAudit(db, 'db_backup_failed');
  const files = file ? listBackups(file) : [];
  const lastFailedNewer = failed && (!ok || failed.at > ok.at);
  const lastPeriodic = lastAudit(db, 'db_backup', `AND json_extract(payload,'$.tag') IN ('daily','weekly')`);
  const stale = every > 0 && (!lastPeriodic || at - lastPeriodic.at > 2 * every * H + H);
  checks.push({ key: 'backup', level: !file ? 'unknown' : lastFailedNewer ? 'bad' : every === 0 || stale ? 'warn' : 'ok', everyHours: every,
    last: ok ? { at: ok.at, tag: ok.tag ?? null, file: ok.file ?? null, bytes: ok.bytes ?? null } : null,
    lastPeriodicAt: lastPeriodic?.at ?? null,
    lastFailure: lastFailedNewer ? { at: failed.at, why: String(failed.verify?.error ?? failed.verify?.integrity ?? '') } : null,
    count: files.length, retention: RETENTION, diskFree: file ? diskFree(dirname(file)) : null, totalBytes: files.reduce((n, b) => n + (size(b.file) ?? 0), 0), dir: file ? join(dirname(file), 'backups') : null, daemonAlive: alive });

  // ⑤ 完整性检查：最近一次快速检查（每小时）与完整检查（每天）；最近一次失败 = bad；太久没做 = warn（多半守护进程没在跑）
  const lastOf = (kind) => {
    const a = lastAudit(db, 'db_check_ok', `AND json_extract(payload,'$.kind')=?`, kind), b = lastAudit(db, 'db_check_failed', `AND json_extract(payload,'$.kind')=?`, kind);
    const r = !a ? (b && { ...b, ok: false }) : !b ? { ...a, ok: true } : b.at > a.at ? { ...b, ok: false } : { ...a, ok: true };
    return r ? { at: r.at, ok: r.ok, problems: (r.problems ?? []).slice(0, 5), fk: (r.fk ?? []).length } : null;
  };
  const quick = lastOf('quick'), full = lastOf('integrity');
  const failedNow = (quick && !quick.ok) || (full && !full.ok);
  const old = (!quick || at - quick.at > 3 * H) && (!full || at - full.at > 48 * H);
  checks.push({ key: 'integrity', level: !file ? 'unknown' : failedNow ? 'bad' : old ? 'warn' : 'ok', quick, full, daemonAlive: alive });

  // ⑥ 部署时区与节假日表：没设时区而服务器本机不是 UTC = 业务日与换班差了时差；节假日表过期了 = 之后的节假日都当工作日
  checks.push(calendarHealth(db, at));

  // ⑦ 模型服务商：熔断开着的、限流退避中的、最近出过错的；各连着哪几档（主用 / 备用）
  checks.push(llmHealthCheck(db, at));

  // ⑧ 运行期不变量：守护进程按各自周期查，这里只读结果
  checks.push(invariantsCheck(db));

  // 情况变了、值得重新看一眼的（只有出现时才列；点过「知道了」的收起，不算要注意）
  const rechecks = rechecksView(db);
  if (rechecks.length) checks.push({ key: 'recheck', level: rechecks.some((r) => !r.acked) ? 'warn' : 'ok', rows: rechecks });

  // 联网目录里像凭据的工具配置不再放进沙箱 —— 用到它的安装会失败，管理员要改用源的凭据（只有出现时才列）
  const withheld = withheldToolEnv(db);
  if (withheld.length) checks.push({ key: 'egress_secrets', level: 'warn', rows: withheld });

  // ⑨ SQLite 版本有已知缺陷（原来是顶部提示条，这里也列一项）
  const sq = sqliteAdvice(db);
  if (sq) checks.push({ key: 'sqlite', level: 'warn', ...sq });

  const sqliteVersion = db.one(`SELECT sqlite_version() v`).v;
  // home：命令行要带同一个数据目录（SUPERINTERN_HOME），否则守护进程会在别处另开一个空库；logFile：守护进程日志（计划任务 / systemd 重定向进来的）
  return { at, version: VERSION, build, node: process.version, sqlite: sqliteVersion, schema: db.one(`PRAGMA user_version`).user_version, paused,
    home, logFile: home ? join(home, 'logs', 'daemon.log') : null,
    // 库文件不在数据目录下（看板用 --db 指到别处）：命令行除了 SUPERINTERN_HOME 还要带同一个 --db（走查时发现原来只提 SUPERINTERN_HOME）
    dbFile: file, dbInHome: !!(home && file && samePath(dirname(file), home)),
    worst: worstOf(checks.map((c) => c.level)), checks };
}

/** 模型服务商一项：熔断开着、而某一档主用它又没配备用 = bad（那一档的步骤会停下等）；开着但有备用 / 限流退避中 = warn */
export function llmHealthCheck(db, at = Date.now()) {
  const rows = healthView(db, at);
  if (!rows.length) return { key: 'llm', level: 'ok', rows: [] };
  const cat = catalogOf(db), eps = endpointsOf(db);
  const keyOf = (mk) => { const m = cat[mk]; return m ? healthKey({ gateway: !!eps[m.vendor]?.gateway, vendorId: m.vendor, model: m.model }) : null; };
  const b = bindingOf(db);
  const uses = (hk) => Object.keys(b.binding).flatMap((t) => [
    keyOf(b.binding[t]) === hk ? { tier: t, as: 'primary', fallback: b.fallbacks?.[t] ?? null } : null,
    b.fallbacks?.[t] && keyOf(b.fallbacks[t]) === hk ? { tier: t, as: 'fallback' } : null,
  ].filter(Boolean));
  const out = rows.map((h) => {
    const tiers = uses(h.key);
    const down = h.state === 'open' || h.state === 'half_open';
    const level = down ? (tiers.some((u) => u.as === 'primary' && !u.fallback) ? 'bad' : 'warn') : h.backoffUntil ? 'warn' : 'ok';
    return { ...h, tiers, level };
  });
  return { key: 'llm', level: worstOf(out.map((r) => r.level)), rows: out };
}

/** 运行期不变量一项：哪条不成立就取那条的级别；查炸了算注意；一条都没查过 = 还不知道 */
export function invariantsCheck(db) {
  const rows = invariantsView(db);
  const levels = rows.map((r) => (r.violations ? r.level : r.error ? 'warn' : 'ok'));
  const level = rows.every((r) => r.checkedAt == null) ? 'unknown' : worstOf(levels);
  return { key: 'invariants', level, rows, issues: ISSUES_URL };
}

/** 只要最坏的那个级别（设置页「运行状况」上的小圆点用；每次刷新任务列表都会调 —— 上面全是带索引的查询和 stat，够便宜） */
export const healthWorst = (db, opts) => deploymentHealth(db, opts).worst;

export const _test = { worstOf, H };
