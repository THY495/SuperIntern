// git 调用的统一入口。
//
// 原来四份封装各写各的：workspace / deliver 两份没有时限（远端卡住、凭据提示挂起，整个进程就跟着挂）、
// 用 Node 默认的 1 MB 输出缓冲（大 diff 直接报错）；project 一份有 120 s 与禁交互；diffview 一份只放大了缓冲。
// 现在一律：有时限、禁交互（不弹凭据提示）、64 MB 缓冲；参数是 argv 数组，不经 shell。

import { execFileSync } from 'node:child_process';
import { I18nError } from '../i18n/index.mjs';
import { maybeFault } from './faults.mjs';

export const GIT_TIMEOUT_MS = 120_000;
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
// 系统在宿主上跑的 git 一律不执行仓库里的钩子、不调 fsmonitor。工作区的 .git 在沙箱里是只读的，这是第二道：
// 万一 .git 被改过（旧容器、没有沙箱的跑法、人手工放进去的 husky 配置），系统的提交 / status 也不会在宿主上跑仓库里的命令。
// /dev/null 在 Git for Windows 下同样有效（实测）
export const GIT_HARDEN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

/**
 * 原样输出（不 trim：取 blob、读 diff 时行尾不能动）。env 给了就在它之上禁交互；encoding: 'buffer' 取字节。
 * @param {string} cwd
 * @param {string[]} args
 */
export function gitRaw(cwd, args, { env = process.env, timeout = GIT_TIMEOUT_MS, encoding = 'utf8' } = {}) {
  maybeFault('git', { args });   // 故障注入点（不开就是一次判断）
  return execFileSync('git', [...GIT_HARDEN, ...args], { cwd, encoding, stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: GIT_MAX_BUFFER, env: { ...env, ...NO_PROMPT } });
}

/** 去掉首尾空白的输出 —— 取提交号、分支名这类单行结果用。 */
export const git = (cwd, ...args) => gitRaw(cwd, args).trim();
/** 带环境变量（推送用的令牌走 http.extraheader 的那几个变量）。 */
export const gitEnv = (cwd, env, ...args) => gitRaw(cwd, args, { env }).trim();

/**
 * 人或外部给进来、要当 git 位置参数的值（远端地址、源仓库路径）。以 - 开头会被 git 当成选项
 * （`--upload-pack=<命令>`、`--receive-pack=<命令>` 能让 git 在本机执行任意命令）—— 拒收；
 * 调用处还要在它前面放 `--`，两道都要有。
 */
export function safePositional(value, kind = 'remote') {
  const s = String(value ?? '').trim();
  const bad = !s || s.startsWith('-') || /[\r\n\0]/.test(s);
  if (!bad) return s;
  throw kind === 'source'
    ? new I18nError('源仓库地址不对：不能为空、不能以 - 开头（会被 git 当成选项）、不能有换行：{value}', { value: s.slice(0, 80) })
    : new I18nError('远端地址不对：不能为空、不能以 - 开头（会被 git 当成选项）、不能有换行：{value}', { value: s.slice(0, 80) });
}
