// 编排器子进程的启动器（看板"运行"按钮与守护进程共用）。
//
// 编排器该退出时就退出（挂起、触顶、等批准都是退出），恢复 = 再跑一次 `run`，那是一个新进程，
// 只能看见库里的东西。谁来"再跑一次"就是这个模块的事：看板上人按按钮、守护进程自己判断。
// 两者共用同一张"在跑的子进程"表 —— 否则看板不知道守护进程起了什么、守护进程也会和人按的那次撞车。
//
// 日志落 `.superintern/logs/<task>-<time>.log`，看板拉尾巴用。

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit } from '../db/db.mjs';
import { I18nError } from '../i18n/index.mjs';
import { getSetting } from './settings.mjs';
import { PROC_ENV } from './lifetimes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function makeLauncher(db, { home, runBinds = [], spawnFn = spawn, onExit = () => {} }) {
  const logsDir = join(home, 'logs');
  const runs = new Map();   // taskId -> child
  return {
    /** 起 `node src/cli.mjs run <task>`。同一任务同时只跑一个；起了就记审计（谁起的、为什么）。 */
    launch(taskId, { verb = 'run', iterations, actorKind = 'system', actorId = null, action = 'run_launched', reason = null } = {}) {
      // `project-plan` 的"taskId"是项目 id：起 `project plan <projectId>`（项目规划器）。
      if (!['run', 'draft', 'plan', 'project-plan'].includes(verb)) throw new Error(`启动器只认 run / draft / plan / project-plan，实得 ${verb}`);
      // 部署级急停：所有拉起都经过这里（守护进程、看板「运行」、项目规划），在这一处挡住就挡全了
      if (getSetting(db, 'deploy.paused')) throw new I18nError('管理员暂停了全部自动运行（看板顶栏的「恢复自动运行」，或 cli user setting deploy.paused false）；恢复之后再运行');
      const live = runs.get(taskId);
      if (live && live.exitCode === null) throw new I18nError('任务 {taskId} 已有子进程在跑（pid {pid}）', { taskId, pid: live.pid });
      mkdirSync(logsDir, { recursive: true });
      const logFile = join(logsDir, `${taskId}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      const fd = openSync(logFile, 'a');
      const verbArgv = verb === 'project-plan' ? ['project', 'plan'] : [verb];
      const args = [join(ROOT, 'src', 'cli.mjs'), ...verbArgv, taskId, ...(verb === 'run' && iterations ? ['--iterations', String(iterations)] : []), ...runBinds];
      // detached + windowsHide：子进程自成进程组 / 自带隐藏控制台。守护进程死了（例如计划任务下的守护进程收到
      // 控制台控制事件 0xC000013A 被终止，job object 会把跑到一半的编排器一起带走）子进程也不陪葬 ——
      // 编排器本来就该退出时退出，谁也不该在它写完退出行之前杀它。unref 让守护进程自己退出时不等它们。
      const target = { targetType: verb === 'project-plan' ? 'project' : 'task', targetId: taskId };
      let child;
      try {
        child = spawnFn(process.execPath, args, { cwd: ROOT, env: { ...process.env, SUPERINTERN_HOME: home, [PROC_ENV]: verb }, stdio: ['ignore', fd, fd], detached: true, windowsHide: true });
      } catch (e) {
        audit(db, { actorKind, actorId, action: 'launch_failed', ...target, payload: { error: String(e?.message ?? e).slice(0, 300), code: e?.code ?? null, args: args.slice(1) } });
        throw e;
      } finally {
        // 子进程已经拿到自己那一份；父进程这份不关，守护进程每拉起一次就漏一个描述符（故障注入查出），跑久了 EMFILE
        try { closeSync(fd); } catch { /* 已关 */ }
      }
      // 起不来（EMFILE / EAGAIN / ENOENT）是异步发 'error' 的：没人接就是未处理的 error 事件，整个守护进程连同看板一起退出
      // （故障注入查出）。接住、记审计、当它已退出 —— 守护进程按"起了没活"进退避，下一拍再试。
      child.on?.('error', (e) => {
        try { audit(db, { actorKind: 'system', action: 'launch_failed', ...target, payload: { error: String(e?.message ?? e).slice(0, 300), code: e?.code ?? null, args: args.slice(1) } }); } catch { /* 库出错时至少别崩 */ }
        if (runs.get(taskId) === child) runs.delete(taskId);
        onExit({ taskId, pid: child.pid ?? null, code: null, error: e?.code ?? String(e?.message ?? e) });
      });
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
