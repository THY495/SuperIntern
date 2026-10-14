// 项目表（projects）的写入。状态变化不在这里 —— 经 db/state.mjs 的 transition()。
// 原来 7 个文件各写各的 INSERT / UPDATE（项目规划器、追加、从目标开始、交接、生命周期、成员与可见性、项目模块）。

import { newId, now } from './db.mjs';

/** 新建一个项目。status：proposed（规划器出草案待批）/ active（直接开工）。 */
export function insertProject(db, { id = newId('pj'), ownerId, title, brief = '', goal = '', doneDefinition = '', repo, branch, baseRef, source = null, status, createdAt = now() }) {
  db.run(`INSERT INTO projects (id,owner_id,title,brief,goal,done_definition,repo,branch,base_ref,source,status,draft_version,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`, id, ownerId, title, brief, goal, doneDefinition, repo, branch, baseRef, source == null ? null : String(source), status, createdAt);
  return id;
}

/** 能经这里改的列（状态不在内：经 transition）。 */
const FIELDS = { title: 'title', brief: 'brief', goal: 'goal', doneDefinition: 'done_definition', ownerId: 'owner_id', visibility: 'visibility',
  archivedAt: 'archived_at', draftVersion: 'draft_version', draftQuestion: 'draft_question', draftNotes: 'draft_notes' };

/** 改项目的若干列：只改给了的（undefined = 不动）。 */
export function updateProject(db, projectId, fields) {
  const cols = [], vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (!FIELDS[k]) throw new Error(`updateProject：不能经这里改 ${k}`);
    cols.push(`${FIELDS[k]}=?`); vals.push(v);
  }
  if (cols.length) db.run(`UPDATE projects SET ${cols.join(', ')} WHERE id=?`, ...vals, projectId);
}
