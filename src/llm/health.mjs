// 厂商熔断与共享退避。
//
// 原来的重试只在一个进程里：固定 1 / 3 / 9 秒、不加抖动、不看 Retry-After。几个编排器（守护进程拉起的子进程）
// 和看板同时打同一家，撞上限流就一起等同样的秒数、一起再撞；厂商整个挂了，每个进程各自把重试耗完、
// 各自退出，守护进程再按任务退避重新拉起，又各自撞一遍。这里把"这家现在能不能打"放进库里，所有进程共用：
//   共享退避  —— 限流（429 / Retry-After）时记一个"谁都别在这之前打"的时刻，各进程看同一个时刻
//   熔断器    —— 连续失败或近期失败率过线就打开：开着时直接失败（有备用档就换备用档），冷却到了放一个进程去试探，
//                试探成了就合上，没成就再开、冷却翻倍
// 状态与转换都写审计（llm_breaker_opened / llm_breaker_closed），守护进程据此通知管理员；部署健康卡列出没合上的。
//
// 键：直连服务商按服务商（限流、故障都是整家的）；网关按"网关 / 模型"（网关后面每个模型的上游各自挂）。
// 只有"可重试"的失败算数：网络 / 超时 / 408 / 429 / 5xx。400 / 401 / 403 是请求或凭据的问题，不是这家挂了。

import { audit } from '../db/db.mjs';

export const BREAKER = {
  consecutive: 5,          // 连续失败这么多次就打开
  windowMs: 5 * 60_000,    // 失败率按最近这段时间算
  minSamples: 10,          // 窗口里至少这么多次才看失败率
  failRate: 0.5,           // 失败率到这个就打开
  coolMs: 60_000,          // 第一次打开冷却多久
  coolMaxMs: 15 * 60_000,  // 反复打开时冷却翻倍，最多到这
  probeMs: 2 * 60_000,     // 半开时试探者占着的时长（试探者进程死了，到点别人接着试）
  keep: 40,                // recent 里留多少条
};
export const BACKOFF = {
  baseMs: 1000,
  capMs: 60_000,           // 共享退避单次最长
  maxWaitMs: 60_000,       // 调用方愿意原地等的共享退避上限；更长就当这次失败（交给备用档或任务级退避）
};

/** 熔断 / 退避的键 */
export const healthKey = (r) => (r.gateway ? `${r.vendorId}/${r.model}` : r.vendorId);
/** full jitter（AWS Architecture Blog "Exponential Backoff And Jitter"）：[0, min(cap, base·2^n)) 里均匀取 */
export const fullJitter = (n, { baseMs = BACKOFF.baseMs, capMs = BACKOFF.capMs } = {}, rnd = Math.random) => Math.floor(rnd() * Math.min(capMs, baseMs * 2 ** n));
/** Retry-After：秒数或 HTTP 日期 → 毫秒；没有 / 看不懂 → null */
export function retryAfterMs(v, at = Date.now()) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - at) : null;
}

const json = (s) => { try { return JSON.parse(s); } catch { return []; } };
const rowOf = (db, key) => db.one(`SELECT * FROM llm_health WHERE key=?`, key);

/**
 * 打之前问一声。
 * @returns {{ ok: true, probe?: true } | { ok: false, reason: 'open'|'probing', until: number } | { ok: false, reason: 'backoff', wait: number }}
 *   ok:true + probe = 这一次是半开试探（成败都要 report）
 */
export function gate(db, key, at = Date.now()) {
  return db.tx(() => {
    const h = rowOf(db, key);
    if (!h) return { ok: true };
    if (h.state === 'open') {
      if (at < h.opened_at + h.cool_ms) return { ok: false, reason: 'open', until: h.opened_at + h.cool_ms };
      db.run(`UPDATE llm_health SET state='half_open', probe_until=?, updated_at=? WHERE key=?`, at + BREAKER.probeMs, at, key);
      return { ok: true, probe: true };
    }
    if (h.state === 'half_open') {
      if (h.probe_until && at < h.probe_until) return { ok: false, reason: 'probing', until: h.probe_until };
      db.run(`UPDATE llm_health SET probe_until=?, updated_at=? WHERE key=?`, at + BREAKER.probeMs, at, key);
      return { ok: true, probe: true };
    }
    if (h.retry_at && at < h.retry_at) return { ok: false, reason: 'backoff', wait: h.retry_at - at };
    return { ok: true };
  }, { immediate: true });
}

/**
 * 打完报一声。失败只报可重试的那几种。
 * @returns {{ transition: 'opened'|'reopened'|'closed'|null }}
 */
export function report(db, key, { ok, status = null, error = null, retryAfter = null, at = Date.now(), rnd = Math.random, pid = process.pid }) {
  return db.tx(() => {
    const h = rowOf(db, key) ?? { key, state: 'closed', fails: 0, recent: '[]', cool_ms: 0, opened_at: null, retry_at: null, probe_until: null, fallback_since: null };
    const recent = [...json(h.recent), [at, ok ? 1 : 0, pid]].filter(([t]) => t > at - BREAKER.windowMs).slice(-BREAKER.keep);
    let { state, fails, cool_ms: cool, opened_at: openedAt, retry_at: retryAt } = h, transition = null;
    if (ok) {
      if (state !== 'closed') { transition = 'closed'; cool = 0; openedAt = null; }
      state = 'closed'; fails = 0; retryAt = null;
    } else {
      fails += 1;
      // 共享退避：服务商说了等多久就照办；只说了 429 没说多久，按连续失败次数 full jitter
      if (retryAfter != null) retryAt = Math.max(retryAt ?? 0, at + Math.min(retryAfter, BACKOFF.capMs));
      else if (status === 429) retryAt = Math.max(retryAt ?? 0, at + fullJitter(fails, BACKOFF, rnd));
      const bad = recent.filter(([, k]) => !k).length;
      const trip = fails >= BREAKER.consecutive || (recent.length >= BREAKER.minSamples && bad / recent.length >= BREAKER.failRate);
      if (state === 'half_open') { state = 'open'; openedAt = at; cool = Math.min(BREAKER.coolMaxMs, Math.max(BREAKER.coolMs, cool * 2)); transition = 'reopened'; }
      else if (state === 'closed' && trip) { state = 'open'; openedAt = at; cool = BREAKER.coolMs; transition = 'opened'; }
    }
    db.run(`INSERT INTO llm_health (key,state,fails,recent,cool_ms,opened_at,retry_at,probe_until,fallback_since,last_status,last_error,updated_at)
      VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET state=excluded.state, fails=excluded.fails, recent=excluded.recent, cool_ms=excluded.cool_ms, opened_at=excluded.opened_at,
        retry_at=excluded.retry_at, probe_until=NULL, fallback_since=excluded.fallback_since,
        last_status=CASE WHEN ? THEN last_status ELSE excluded.last_status END, last_error=CASE WHEN ? THEN last_error ELSE excluded.last_error END, updated_at=excluded.updated_at`,
      // 换用备用这一段：合上时结束；没打开过（重试用尽才换的）就等主模型又打通一次、且离换用过了一个窗口才算结束，免得时好时坏时反复通知
      key, state, fails, JSON.stringify(recent), cool, openedAt, retryAt,
      transition === 'closed' || (ok && h.fallback_since != null && at - h.fallback_since >= BREAKER.windowMs) ? null : h.fallback_since,
      ok ? null : status, ok ? null : String(error ?? '').slice(0, 300), at, ok ? 1 : 0, ok ? 1 : 0);
    // 共享退避新设或延长：记一笔（retry_at 是覆盖写，不记的话事后数不出触发了几次、让所有进程等了多久）
    if (!ok && retryAt != null && retryAt > at && retryAt > (h.retry_at ?? 0)) {
      audit(db, { actorKind: 'system', action: 'llm_backoff_set', targetType: 'llm_endpoint', targetId: key,
        payload: { waitMs: retryAt - at, extendedMs: h.retry_at && h.retry_at > at ? retryAt - h.retry_at : null, status, retryAfter, pid } });
    }
    if (transition === 'opened' || transition === 'reopened') {
      audit(db, { actorKind: 'system', action: 'llm_breaker_opened', targetType: 'llm_endpoint', targetId: key,
        payload: { reopened: transition === 'reopened', fails, coolMs: cool, status, error: String(error ?? '').slice(0, 300), failRate: recent.length ? recent.filter(([, k]) => !k).length / recent.length : null,
          // 打开前 10 秒内失败来自几个进程：并行时一次短暂抖动凑满阈值的"误开"据此判
          procs: new Set(recent.filter(([t, k, p]) => !k && t > at - 10_000 && p != null).map(([, , p]) => p)).size } });
    } else if (transition === 'closed') {
      audit(db, { actorKind: 'system', action: 'llm_breaker_closed', targetType: 'llm_endpoint', targetId: key,
        payload: { openForMs: h.opened_at ? at - h.opened_at : null, usedFallback: h.fallback_since != null } });
    }
    return { transition };
  }, { immediate: true });
}

/** 换到了备用档：同一次打开期间只记一次审计（守护进程据此通知一次）。返回这次是不是第一次 */
export function noteFallback(db, key, { from, to, tier, reason, at = Date.now() }) {
  return db.tx(() => {
    const h = rowOf(db, key);
    if (h?.fallback_since != null) return false;
    if (h) db.run(`UPDATE llm_health SET fallback_since=?, updated_at=? WHERE key=?`, at, at, key);
    else db.run(`INSERT INTO llm_health (key,state,fails,recent,cool_ms,fallback_since,updated_at) VALUES (?, 'closed', 0, '[]', 0, ?, ?)`, key, at, at);
    audit(db, { actorKind: 'system', action: 'llm_fallback_used', targetType: 'llm_endpoint', targetId: key, payload: { from, to, tier, reason } });
    return true;
  }, { immediate: true });
}

/** 看板 / 健康卡 / 命令行：每个键现在怎样（closed 且最近没失败的不列） */
export function healthView(db, at = Date.now()) {
  return db.all(`SELECT * FROM llm_health ORDER BY key`).map((h) => {
    const recent = json(h.recent).filter(([t]) => t > at - BREAKER.windowMs);
    const state = h.state === 'open' && at >= h.opened_at + h.cool_ms ? 'half_open' : h.state;   // 冷却到了、还没人来试：等同半开
    return { key: h.key, state, fails: h.fails, recentFails: recent.filter(([, k]) => !k).length, recentTotal: recent.length,
      openedAt: h.opened_at, reopenAt: h.state === 'open' ? h.opened_at + h.cool_ms : null, backoffUntil: h.retry_at && h.retry_at > at ? h.retry_at : null,
      fallbackSince: h.fallback_since, lastStatus: h.last_status, lastError: h.last_error, updatedAt: h.updated_at };
  }).filter((x) => x.state !== 'closed' || x.backoffUntil || x.recentFails || x.fallbackSince);
}

/** 给 LlmClient 用的一组函数（registryFor(db) 带上它；测试不带就不熔断、不共享退避） */
export const makeHealth = (db) => ({
  gate: (key, at) => gate(db, key, at),
  report: (key, o) => report(db, key, o),
  noteFallback: (key, o) => noteFallback(db, key, o),
});
