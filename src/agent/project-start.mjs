// 新建项目：项目是唯一容器，新建的入口只有这一个。
//
// 人给：仓库（或"从零开始"）、目标、完成定义；可选一份已写好的规划。
//   - 没有规划：项目直接 active，第一个任务从"目标 + 完成定义"起草 —— 走追问器（问几个问题 → 契约草案 → 人批准一次），
//     与此前"从想法新建任务"是同一条路，只是任务一出生就在项目里（order 1），工作区从项目分支起。
//     一次性的小活 = 只有这一个任务的项目；之后要加任务走项目页的"添加任务"（project-append.mjs）。
//   - 有规划：项目 proposed，规划器把规划切成多个任务的契约，人批准一次（project-planner.mjs，原样）。
// 仓库在这里就克隆（不再等到契约批准后）：路径 / URL 不对当场报错，而不是几分钟后在守护进程的日志里。
//
// 旧的独立任务（project_id IS NULL）没有新建入口了；`cli new --file` 作为底层 / 测试入口保留。

import { applyEgressDefaults } from '../core/egress.mjs';
import { newId, now, audit } from '../db/db.mjs';
import { initProjectRepo, PROJECT_TASK_RUNTIME_MS } from '../core/project.mjs';
import { setLimit } from '../core/limits.mjs';
import { startFromIdea } from './elicitor.mjs';
import { startProjectFromBrief } from './project-planner.mjs';

/** 项目的"原文"：目标 + 完成定义。追加任务时规划器引文核对的原文之一（projects.brief）。 */
export const goalBrief = (goal, doneDefinition) => `# 项目目标\n${goal}\n\n# 完成定义\n${doneDefinition}`;

export function startProject(db, { userId, goal, doneDefinition, plan = null, title = null, source = null, empty = false, base = null, home }) {
  const g = String(goal ?? '').trim();
  const d = String(doneDefinition ?? '').trim();
  if (!g) throw new Error('项目目标不能为空：用一两句话写明要做成什么');
  if (!d) throw new Error('完成定义不能为空：用一两句话写明怎样算做完');
  const ttl = String(title ?? '').trim() || g.split('\n')[0].trim().slice(0, 80);
  const planText = plan === null ? '' : String(plan).trim();
  if (plan !== null && !planText) throw new Error('勾选了"已有规划"，但规划全文为空');

  if (planText) {
    const r = startProjectFromBrief(db, { userId, brief: planText, source, home, base, title: ttl, empty });
    db.run(`UPDATE projects SET goal=?, done_definition=? WHERE id=?`, g, d, r.projectId);
    return { ...r, firstTaskId: r.carrierId, planned: true };
  }

  const projectId = newId('pj');
  const { repo, branch, baseRef } = initProjectRepo({ home, projectId, source, base, empty });
  db.run(`INSERT INTO projects (id,owner_id,title,brief,goal,done_definition,repo,branch,base_ref,source,status,draft_version,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,'active',0,?)`,
    projectId, userId, ttl, goalBrief(g, d), g, d, repo, branch, baseRef, (source ? String(source) : null), now());
  audit(db, { actorKind: 'user', actorId: userId, action: 'project_created', targetType: 'project', targetId: projectId,
    payload: { title: ttl, repo, branch, baseRef, source: (source ? String(source) : null), fromGoal: true } });
  applyEgressDefaults(db, { projectId, userId });   // 管理员勾过的默认放行源
  const { taskId } = startFromIdea(db, { userId, idea: goalBrief(g, d), title: ttl, projectId, order: 1 });
  // 与规划出来的项目任务同一个运行时长上限（否则从目标起草的第一个任务会用部署默认 45 分钟，返工时容易撞顶、暂停、给负责人一条事项）
  setLimit(db, { taskId, key: 'limit.runtime_ms', value: PROJECT_TASK_RUNTIME_MS, userId });
  return { projectId, firstTaskId: taskId, repo, branch, baseRef, planned: false };
}
