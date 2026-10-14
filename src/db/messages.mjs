// 消息表（messages）的写入。原来 7 个文件各写一份 11 列的 INSERT（答复、会签合并、选择项修正、
// 签收打回、交回、计划变更、超时默认），外加消费 / 暂扣的 UPDATE。"认证来源必须带令牌与发送人"由库层 CHECK 执法。

import { newId, now } from './db.mjs';

/**
 * 新建一条消息。kind：instruction / correction / context / answer；trustLabel：user-authenticated（必须带 senderId 与 tokenId）/
 * agent-generated / observed-untrusted。来源默认 explicit（人明说的），分类器判的传 'classifier'。
 */
export function insertMessage(db, { id = newId('m'), taskId, senderId = null, body, kind, kindSource = 'explicit', urgency = 'normal', urgencySource = 'explicit',
  trustLabel, tokenId = null, receivedAt = now() }) {
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, taskId, senderId, body, kind, kindSource, urgency, urgencySource, trustLabel, tokenId, receivedAt);
  return id;
}

/** 人经认证通道发的消息（答复、修正）。 */
export const insertUserMessage = (db, { id, taskId, senderId, tokenId, body, kind, urgency = 'normal', receivedAt }) =>
  insertMessage(db, { id, taskId, senderId, tokenId, body, kind, urgency, trustLabel: 'user-authenticated', receivedAt });

/** 标成已处理（只标还没处理的；处理过的不改时刻）。 */
export const markMessageConsumed = (db, id, at = now()) => db.run(`UPDATE messages SET consumed_at=? WHERE id=? AND consumed_at IS NULL`, at, id);

/** 暂扣到某时刻（只扣还没处理的修正 / 新指令）。 */
export const holdMessage = (db, id, until) => db.run(`UPDATE messages SET held_until=? WHERE id=? AND consumed_at IS NULL AND kind IN ('correction','instruction')`, until, id);

export const releaseMessageHold = (db, id) => db.run(`UPDATE messages SET held_until=NULL WHERE id=?`, id);
