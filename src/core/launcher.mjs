// 编排器子进程的启动器（看板"运行"按钮与守护进程共用）。
//
// 编排器该退出时就退出（挂起、触顶、等批准都是退出），恢复 = 再跑一次 `run`，那是一个新进程，
// 只能看见库里的东西。谁来"再跑一次"就是这个模块的事：看板上人按按钮、守护进程自己判断。
// 两者共用同一张"在跑的子进程"表 —— 否则看板不知道守护进程起了什么、守护进程也会和人按的那次撞车。
//
// 日志落 `.superintern/logs/<task>-<time>.log`，看板拉尾巴用。

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../db/db.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function makeLauncher(db, { home, runBinds = [], spawnFn = spawn, onExit = () => {} }) {
  const logsDir = join(home, 'logs');
  const runs = new Map();   // taskId -> child
  return {
    /** 起 `node src/cli.mjs run <task>`。同一任务同时只跑一个；起了就记审计（谁起的、为什么）。 */
    launch(taskId, { verb = 'run', iterations, actorKind = 'system', actorId = null, action = 'run_launched', reason = null } = {}) {
      // `project-plan` 的"taskId"是项目 id：起 `project plan <projectId>`（项目规划器）。
      if (!['run', 'draft', 'plan', 'project-plan'].includes(verb)) throw new Error(`启动器只认 run / draft / plan / project-plan，实得 ${verb}`);
      const live = runs.get(taskId);
      if (live && live.exitCode === null) throw new Error(`任务 ${taskId} 已有子进程在跑（pid ${live.pid}）`);
      mkdirSync(logsDir, { recursive: true });
      const logFile = join(logsDir, `${taskId}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      const fd = openSync(logFile, 'a');
      const verbArgv = verb === 'project-plan' ? ['project', 'plan'] : [verb];
      const args = [join(ROOT, 'src', 'cli.mjs'), ...verbArgv, taskId, ...(verb === 'run' && iterations ? ['--iterations', String(iterations)] : []), ...runBinds];
      // detached + windowsHide：子进程自成进程组 / 自带隐藏控制台。守护进程死了（例如计划任务下的守护进程收到
      // 控制台控制事件 0xC000013A 被终止，job object 会把跑到一半的编排器一起带走）子进程也不陪葬 ——
      // 编排器本来就该退出时退出，谁也不该在它写完退出行之前杀它。unref 让守护进程自己退出时不等它们。
      const child = spawnFn(process.execPath, args, { cwd: ROOT, env: { ...process.env, SUPERINTERN_HOME: home }, stdio: ['ignore', fd, fd], detached: true, windowsHide: true });
      child.unref?.();
      runs.set(taskId, child);
      child.on?.('exit', (code) => onExit({ taskId, pid: child.pid, code }));
      audit(db, { actorKind, actorId, action, targetType: verb === 'project-plan' ? 'project' : 'task', targetId: taskId,
        payload: { pid: child.pid, logFile, args: args.slice(1), ...(reason ? { reason } : {}) } });
      return { pid: child.pid, logFile };
    },
    running(taskId) { const c = runs.get(taskId); return c && c.exitCode === null ? { pid: c.pid } : null; },
    logTail({ taskId, lines = 80 }) {
      if (!existsSync(logsDir)) return { file: null, tail: '' };
      const files = readdirSync(logsDir).filter((f) => f.startsWith(taskId + '-')).map((f) => join(logsDir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (!files.length) return { file: null, tail: '' };
      const text = readFileSync(files[0], 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
      return { file: files[0], tail: text.split('\n').slice(-lines).join('\n') };
    },
  };
}
