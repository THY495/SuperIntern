// 哪些项目在等负责人交付（摘要的「等你交付的项目」与守护进程的交付通知共用这一个口径）。
//
// 没有「等你交付」时，项目达成后负责人收件箱里什么都没有。
// 口径上有两处要注意：
//   - 成员在项目第一次达成后马上加了需求，追加还在起草，项目状态仍是 done，若「等你交付」照挂，负责人照着交付了 ——
//     交付的是没有新需求的版本。→ 项目规划载体还在起草 / 等批（有一轮追加没走完）时不提示交付。
//   - 若按"交付过没有"判：新需求合并、项目第二次达成后收件箱全空，新的那部分永远停在项目分支上。
//     → 改成"上次交付之后有没有新合并的任务"。

/** 在等交付的项目：done、没归档、没有进行中的追加，且有上次交付之后才合并的任务（没交付过就是全部）。 */
export function projectsToDeliver(db, { ownerId = null } = {}) {
  return db.all(
    `SELECT p.id, p.title, p.owner_id,
            (SELECT MAX(ts) FROM audit_log a WHERE a.action='project_delivered' AND a.target_id=p.id) AS delivered_at,
            (SELECT MAX(merged_at) FROM tasks t WHERE t.project_id=p.id) AS merged_max
       FROM projects p
      WHERE p.status='done' AND p.archived_at IS NULL ${ownerId ? 'AND p.owner_id=?' : ''}
        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.project_id=p.id AND c.project_order=0 AND c.status IN ('planning','waiting','running'))
      ORDER BY p.created_at`, ...(ownerId ? [ownerId] : []))
    .filter((p) => p.merged_max && p.merged_max > (p.delivered_at ?? 0))
    .map((p) => ({ projectId: p.id, title: p.title, ownerId: p.owner_id, again: !!p.delivered_at, mergedMax: p.merged_max,
      merged: db.one(`SELECT count(*) n FROM tasks WHERE project_id=? AND merged_at IS NOT NULL`, p.id).n,
      sinceDelivery: p.delivered_at ? db.one(`SELECT count(*) n FROM tasks WHERE project_id=? AND merged_at > ?`, p.id, p.delivered_at).n : null,
      newTitles: p.delivered_at ? db.all(`SELECT title FROM tasks WHERE project_id=? AND merged_at > ? ORDER BY project_order`, p.id, p.delivered_at).map((t) => t.title) : [] }));
}
