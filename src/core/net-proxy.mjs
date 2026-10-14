// 出网代理（2026-10-13，GitHub 登录实际运行验证时撞上）：Node 自带的 fetch 默认不看 HTTPS_PROXY / HTTP_PROXY / NO_PROXY。
// git、curl 都看，所以"推送能通、用 GitHub 登录换令牌却超时"——同一台机器上 github.com 直连不通、api.github.com 直连能通。
// 这里在进程入口按标准环境变量打开 Node 内置的代理支持（fetch 与 http/https 请求都走），和 git 的行为一致。
//
// 本机地址（localhost / 127.0.0.1 / ::1）永远直连：本地模型服务、看板自测都在本机，NO_PROXY 没写全也不该绕到代理上去。
// 不想让 SuperIntern 走代理（代理只给浏览器用）：设 SUPERINTERN_IGNORE_ENV_PROXY=1。
// Node 自己的 NODE_USE_ENV_PROXY=1 / --use-env-proxy 也能开，开了这里就不再重复设。

import http from 'node:http';

const LOCAL = ['localhost', '127.0.0.1', '::1', '[::1]'];
const pick = (env, k) => env[k] ?? env[k.toLowerCase()] ?? '';

/** 代理地址去掉用户名口令再显示（日志里不留凭据） */
export function redactProxy(u) {
  try { const x = new URL(u); x.username = ''; x.password = ''; return x.toString().replace(/\/$/, ''); } catch { return '(unparseable)'; }
}

/** 按环境变量打开出网代理。返回 { enabled, proxy, why } —— proxy 已去掉凭据，供启动日志用。 */
export function useEnvProxy(env = process.env) {
  const proxy = pick(env, 'HTTPS_PROXY') || pick(env, 'HTTP_PROXY');
  if (!proxy) return { enabled: false, proxy: null, why: 'none' };
  if (env.SUPERINTERN_IGNORE_ENV_PROXY === '1') return { enabled: false, proxy: redactProxy(proxy), why: 'ignored' };
  if (env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy')) return { enabled: true, proxy: redactProxy(proxy), why: 'node' };
  if (typeof http.setGlobalProxyFromEnv !== 'function') return { enabled: false, proxy: redactProxy(proxy), why: 'unsupported' };
  const noProxy = [...new Set([...pick(env, 'NO_PROXY').split(',').map((s) => s.trim()).filter(Boolean), ...LOCAL])].join(',');
  try {
    http.setGlobalProxyFromEnv({ HTTPS_PROXY: pick(env, 'HTTPS_PROXY'), HTTP_PROXY: pick(env, 'HTTP_PROXY'), NO_PROXY: noProxy });
    return { enabled: true, proxy: redactProxy(proxy), why: 'env' };
  } catch (e) { return { enabled: false, proxy: redactProxy(proxy), why: `error: ${e.message}` }; }
}
