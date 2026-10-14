// 进程非正常退出：查出来、补上收尾、让人看得见。
//
// 被硬杀的进程（断电、OOM、kill -9、0.3.0 里 9 次 database is locked）没有机会写 *_exit 那一行：审计轨上它的寿命
// 永远"没有收尾"，复盘报红（本机真实库里 22 段），看板上也什么都看不出来 —— 人只看到任务不动了。
// 守护进程每一拍扫一遍：起了没退、而进程确实已经不在了（编排器看租约有没有过期；别的看 pid）→ 替它补一行退出
// （kind: 'crashed'，写明是谁、什么时候查出来的，不冒充进程自己写的），再记一条 process_crashed 给人看。
// 退避重试照旧：守护进程原来就把"起了没退 + pid 不在"当 crashed 处理，补了这行之后口径不变。

import { now, audit } from '../db/db.mjs';
import { LIFECYCLE } from './lifetimes.mjs';
import { leaseOf } from '../db/lease.mjs';
import { pidAlive } from './proc.mjs';

const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

/** 起了没退、进程也不在了的寿命：[{ verb, role, targetId, startId, pid, startedAt }] */
export function findCrashed(db, { at = now(), alive = pidAlive } = {}) {
  const out = [];
  for (const [verb, l] of Object.entries(LIFECYCLE)) {
    // 每个对象最近一次 start，且之后没有 exit
    const rows = db.all(`SELECT a.id, a.target_id, a.ts, a.payload FROM audit_log a
      WHERE a.action=? AND a.id=(SELECT max(c.id) FROM audit_log c WHERE c.target_id=a.target_id AND c.action=?)
        AND NOT EXISTS (SELECT 1 FROM audit_log b WHERE b.target_id=a.target_id AND b.action=? AND b.id>a.id)`, l.start, l.start, l.exit);
    for (const r of rows) {
      const pid = parse(r.payload).pid ?? null;
      let dead;
      if (verb === 'run') {
        const lease = leaseOf(db, `task:${r.target_id}`, at);
        // 有租约按租约判（过期 = 死了，哪怕 pid 被复用了还"活着"）；没有租约行（老版本起的）看 pid
        dead = lease ? !lease.live : !(pid && alive(pid));
      } else dead = !(pid && alive(pid));
      if (dead) out.push({ verb, role: l.role, targetId: r.target_id, targetType: l.target === 'project' ? 'project' : 'task', startId: r.id, pid, startedAt: r.ts });
    }
  }
  return out;
}

/** 补收尾 + 记一条给人看的。返回补了哪些。 */
export function sweepCrashes(db, { at = now(), alive = pidAlive, onEvent = () => {} } = {}) {
  const found = findCrashed(db, { at, alive });
  for (const c of found) {
    db.tx(() => {
      // 事务里再确认一次：别的进程（另一个守护进程 / 看板）可能刚补过
      if (db.one(`SELECT 1 FROM audit_log WHERE target_id=? AND action=? AND id>? LIMIT 1`, c.targetId, LIFECYCLE[c.verb].exit, c.startId)) return;
      audit(db, { actorKind: 'system', actorId: 'daemon', action: LIFECYCLE[c.verb].exit, targetType: c.targetType, targetId: c.targetId,
        payload: { pid: c.pid, kind: 'crashed', detectedBy: 'daemon', detectedAt: at, startedAt: c.startedAt, synthetic: true } });
      audit(db, { actorKind: 'system', actorId: 'daemon', action: 'process_crashed', targetType: c.targetType, targetId: c.targetId,
        payload: { role: c.role, pid: c.pid, startedAt: c.startedAt, ranMs: at - c.startedAt } });
    });
    onEvent({ type: 'process_crashed', ...c });
  }
  return found;
}
