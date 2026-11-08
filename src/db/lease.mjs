// 租约与写入防护。
//
// "同一任务只能有一个编排器"靠的是审计里"起了没退 + pid 还活着"。两个窗口它关不上：
//   · pid 复用：进程死了、pid 被别的进程占了，就一直被当成"还活着"，任务卡住（往安全的方向错，但卡住）；
//   · 僵尸写入：一个编排器只是卡住了（不是死了），被判死、另起一个；它醒过来照样写库、推代码 —— 两个人改同一个步骤。
// 租约换一个判据：**按到期时间接管，不看 pid**；接管时代数（epoch）+1。持有者定期续约；关键写入在同一个事务里
// 核对"我的代数仍是最新"，不是就放弃（fencing token，Kleppmann 的论证）。
//
//   resource：'task:<id>'（编排器）、'project:<id>'（合并 / 推进）
//   holder：主机 + pid + 进程起点时刻 —— pid 复用了也认得出不是同一个进程

import { hostname } from 'node:os';
import { isMainThread, threadId } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { now } from './db.mjs';
import { I18nError } from '../i18n/index.mjs';

export const LEASE_TTL_MS = 120_000;      // 两分钟没续约就算放弃（编排器每 30 秒续一次，等模型的时候事件循环是空的，续得上）
export const LEASE_RENEW_MS = 30_000;
// worker 线程（core/offthread.mjs）与主线程同一个 pid、同一个 timeOrigin：不带线程号的话，主线程会把 worker 正持有的租约当成
// 自己的而重入（看板编辑规则文件与 worker 里的项目推进同时动一个项目）。主线程不带后缀，标识与原来一样。
export const HOLDER = `${hostname()}:${process.pid}:${Math.round(performance.timeOrigin)}${isMainThread ? '' : `:t${threadId}`}`;

export class LeaseHeldError extends I18nError {
  constructor(resource, row) {
    super('{resource} 正由另一个进程处理（{holder}，租约到 {until}）：同一时刻只能有一个', { resource, holder: row.holder, until: new Date(row.expires_at).toISOString() });
    this.leaseHeld = true; this.holder = row.holder; this.pid = row.pid;
  }
}
export class LeaseLostError extends I18nError {
  constructor(resource, epoch, row) {
    super('{resource} 的租约已被接管（我的代数 {epoch}，现在 {now}）：这个进程不再有权写，退出', { resource, epoch, now: row?.epoch ?? '—' });
    this.leaseLost = true;
  }
}

/** 当前租约（含是否已过期）。没有就 null。 */
export function leaseOf(db, resource, at = now()) {
  const r = db.one(`SELECT * FROM leases WHERE resource=?`, resource);
  return r ? { ...r, live: r.expires_at > at } : null;
}

/**
 * 取得租约：没人持有、已过期、或本来就是我 → 拿到（换人时代数 +1）；别人持有且没过期 → LeaseHeldError。
 * 在 IMMEDIATE 事务里做，两个进程同时来只有一个能过。
 */
export function acquireLease(db, resource, { ttlMs = LEASE_TTL_MS, at = now(), meta = {}, reclaimDead = null } = {}) {
  return db.tx(() => {
    const cur = db.one(`SELECT * FROM leases WHERE resource=?`, resource);
    // reclaimDead（调用方传 pidAlive）：没到期、但持有者是本机一个已经不在的进程 → 当场接管，不等到期。
    // 死进程写不了库，所以不破坏代数防护；pid 被复用只会判"还活着"、退回按到期。
    // 只给项目推进用：任务租约的到期是崩溃扫描的判据（补收尾、记崩溃），提前接管会把那条记录弄丢
    const deadHolder = !!(cur && reclaimDead && cur.holder !== HOLDER && cur.expires_at > at && cur.pid
      && String(cur.holder).split(':')[0] === hostname() && !reclaimDead(cur.pid));
    if (cur && cur.holder !== HOLDER && cur.expires_at > at && !deadHolder) throw new LeaseHeldError(resource, cur);
    const epoch = cur ? (cur.holder === HOLDER && cur.expires_at > at ? cur.epoch : cur.epoch + 1) : 1;
    db.run(`INSERT INTO leases (resource, holder, pid, epoch, acquired_at, heartbeat_at, expires_at, meta) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(resource) DO UPDATE SET holder=excluded.holder, pid=excluded.pid, epoch=excluded.epoch,
              acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at, meta=excluded.meta`,
      resource, HOLDER, process.pid, epoch, at, at, at + ttlMs, JSON.stringify(meta));
    return { resource, epoch, takeover: !!cur && cur.holder !== HOLDER, deadHolder, previous: cur ? { holder: cur.holder, epoch: cur.epoch, expiredAt: cur.expires_at } : null };
  });
}

/** 续约。代数或持有者对不上 → LeaseLostError（已经被接管了）。 */
export function renewLease(db, resource, epoch, { ttlMs = LEASE_TTL_MS, at = now() } = {}) {
  const r = db.run(`UPDATE leases SET heartbeat_at=?, expires_at=? WHERE resource=? AND epoch=? AND holder=?`, at, at + ttlMs, resource, epoch, HOLDER);
  if (Number(r.changes) !== 1) throw new LeaseLostError(resource, epoch, db.one(`SELECT epoch FROM leases WHERE resource=?`, resource));
}

/** 关键写入前核对：我的代数仍是最新、且是我。放在写入的同一个事务里调。 */
export function assertLease(db, resource, epoch) {
  const r = db.one(`SELECT epoch, holder FROM leases WHERE resource=?`, resource);
  if (!r || r.epoch !== epoch || r.holder !== HOLDER) throw new LeaseLostError(resource, epoch, r);
}

/** 正常退出时交还：到期时刻拨到现在（行留着，代数单调）。 */
export function releaseLease(db, resource, epoch, at = now()) {
  db.run(`UPDATE leases SET expires_at=? WHERE resource=? AND epoch=? AND holder=?`, at, resource, epoch, HOLDER);
}

// ── 本进程的写入防护：编排器拿到租约后登记，transition() 对这个任务的 tasks / nodes 写入逐次核对 ──
const fences = new Map();   // resource → epoch
export function setFence(resource, epoch) { fences.set(resource, epoch); }
export function clearFence(resource) { fences.delete(resource); }
/** transition() 调：这一行属于某个登记了防护的任务 → 核对租约。 */
export function checkFence(db, table, id) {
  if (!fences.size) return;
  let taskId = null;
  if (table === 'tasks') taskId = id;
  else if (table === 'nodes') taskId = db.one(`SELECT task_id FROM nodes WHERE id=?`, id)?.task_id ?? null;
  if (!taskId) return;
  const res = `task:${taskId}`;
  if (fences.has(res)) assertLease(db, res, fences.get(res));
}

/** 定时续约（unref，不挡进程退出）。续不上就记下来，让下一次关键写入去失败。 */
export function startHeartbeat(db, resource, epoch, { everyMs = LEASE_RENEW_MS, ttlMs = LEASE_TTL_MS, onLost = () => {} } = {}) {
  const timer = setInterval(() => {
    try { renewLease(db, resource, epoch, { ttlMs }); } catch (e) { clearInterval(timer); onLost(e); }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
