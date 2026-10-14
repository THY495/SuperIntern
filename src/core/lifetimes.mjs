// 会花钱的进程，各自在审计轨上留下的起止行，以及"这一笔花费是哪个进程花的"。
//
// 原来这张表住在 daemon.mjs 里，复盘（replay.mjs）自己另抄了一份只含两种进程的 —— 于是追问器、项目规划器的
// 花费在复盘里全成了"落在所有寿命之外"（2026-10-12 拿本机 23 个真实试跑库跑出来 113 条，几乎全是这一类）。
// 合成一份，谁要都从这里取。

/** 四种由启动器拉起的进程：各自的起止审计动作。项目规划器的目标是项目 id，其余是任务 id。 */
export const LIFECYCLE = {
  run: { start: 'orchestrator_started', exit: 'orchestrator_exit', role: 'orchestrator' },
  draft: { start: 'elicitor_started', exit: 'elicitor_exit', role: 'elicitor' },
  plan: { start: 'planner_started', exit: 'planner_exit', role: 'planner' },
  'project-plan': { start: 'project_planner_started', exit: 'project_planner_exit', role: 'project_planner', target: 'project' },
};

/** 起 / 止动作 → 进程角色（复盘按它把审计行配成一段段寿命）。 */
export const LIFE_OPEN = Object.fromEntries(Object.values(LIFECYCLE).map((l) => [l.start, l.role]));
export const LIFE_SHUT = Object.fromEntries(Object.values(LIFECYCLE).map((l) => [l.exit, l.role]));

/**
 * 当前进程是哪一种（记进花费账本，复盘据此把每一笔钱对到具体的进程寿命上）。
 * 启动器拉起子进程时经 SUPERINTERN_PROC 传下来（run / draft / plan / project-plan）；CLI 入口按命令设
 * （web / daemon / 手动的 run 等）；都没有就是 cli。
 */
export const PROC_ENV = 'SUPERINTERN_PROC';
export const procKind = () => process.env[PROC_ENV] || 'cli';
