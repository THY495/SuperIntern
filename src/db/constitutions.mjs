// 宪法块（constitutions）与决策日志（decisions）的写入。
// 宪法块原来由 3 个文件写（追问器出草案、建任务、修订改宪法），"旧版作废 + 新版写入"在两处各抄一份；
// 决策日志由 3 个文件写（执行器的关键决定、规划器的分解理由、修订的作废 / 改宪法记录）。

import { newId, now } from './db.mjs';
import { splitClauses, assignClauseKeys, maxClauseNum } from '../core/clauses.mjs';

/**
 * 写一版宪法块。supersedes：要作废的上一版 id（同一事务里先作废、再写新版 —— 与参数同一条规矩：旧版留着，记下何时不算数）。
 * scopePaths / constraints 给数组。条款同时切好、编号（与上一版同文字的沿用旧号）。
 */
export function writeConstitution(db, { id = newId('c'), taskId, version, goal, scope, scopePaths = [], definitionOfDone, constraints = [], supersedes = null, at = now() }) {
  return db.tx(() => {
    const prev = supersedes ? db.one(`SELECT clauses FROM constitutions WHERE id=?`, supersedes) : null;
    const clauses = assignClauseKeys(splitClauses({ goal, scope, definition_of_done: definitionOfDone, constraints }), {
      prev: JSON.parse(prev?.clauses || '[]'),
      maxUsed: maxClauseNum(db.all(`SELECT clauses FROM constitutions WHERE task_id=?`, taskId).map((r) => r.clauses)),
    });
    if (supersedes) db.run(`UPDATE constitutions SET superseded_at=?, valid_to=? WHERE id=?`, at, at, supersedes);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,scope_paths,definition_of_done,constraints,clauses,valid_from,recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, taskId, version, goal, scope, JSON.stringify(scopePaths), definitionOfDone, JSON.stringify(constraints), JSON.stringify(clauses), at, at);
    return id;
  });
}

/** 记一条决策。actorKind：agent / user / meeting；layer：execution / constitutional。 */
export function insertDecision(db, { id = newId('d'), taskId, nodeId = null, summary, rationale, actorKind, actorId = null, layer, narrativeRef = null, at = now() }) {
  db.run(`INSERT INTO decisions (id,task_id,node_id,summary,rationale,actor_kind,actor_id,layer,narrative_ref,valid_from,recorded_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, taskId, nodeId, summary, rationale, actorKind, actorId, layer, narrativeRef, at, at);
  return id;
}
