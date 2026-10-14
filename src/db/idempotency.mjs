// 幂等键的存取。语义在 web/server.mjs 的分派器里：同人同键 —— 同一个请求重放上次的结果、
// 不同的请求 422、还在处理 409。只缓存确定的结果（2xx / 4xx）；服务端出错（5xx）的删掉，让重试真的再跑一次。

import { now } from './db.mjs';

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

export const idemGet = (db, userId, key) => db.one(`SELECT * FROM idempotency_keys WHERE user_id=? AND key=?`, userId, key);

/** 占住这个键（pending）。同人同键已经有了就返回 false（并发的两个请求只有一个占得到）。 */
export function idemClaim(db, { userId, key, method, path, reqHash, at = now() }) {
  return db.tx(() => {
    if (idemGet(db, userId, key)) return false;
    db.run(`INSERT INTO idempotency_keys (user_id,key,method,path,req_hash,state,created_at) VALUES (?,?,?,?,?,'pending',?)`, userId, key, method, path, reqHash, at);
    return true;
  });
}

export const idemFinish = (db, { userId, key, status, body }) =>
  db.run(`UPDATE idempotency_keys SET state='done', status=?, body=? WHERE user_id=? AND key=?`, status, body, userId, key);

export const idemDrop = (db, userId, key) => db.run(`DELETE FROM idempotency_keys WHERE user_id=? AND key=?`, userId, key);

/** 删过期的（日常清理）。返回删了几条。 */
export const idemPrune = (db, { at = now(), ttlMs = IDEMPOTENCY_TTL_MS } = {}) => Number(db.run(`DELETE FROM idempotency_keys WHERE created_at < ?`, at - ttlMs).changes);
