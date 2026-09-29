// .env 的单变量写入（看板"填 key"用）。凭证只在这里经手一次：写文件（600）、更新本进程 env，**不进库、不进审计正文、不回显**。
// 审计只记变量名（endpoint 页的 key_set），值永远不出这个函数。

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** 写或改一个变量。value 为空字符串 = 清空（保留行，值为空）。返回 { name, existed, present }。 */
export function setEnvVar(path, name, value, { env = process.env } = {}) {
  if (!NAME_RE.test(name)) throw new Error('变量名要是大写字母 / 数字 / 下划线');
  const v = String(value ?? '');
  if (/[\r\n]/.test(v)) throw new Error('值不能含换行');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  let existed = false;
  const out = lines.map((l) => {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(l);
    if (m && m[1] === name) { existed = true; return `${name}=${v}`; }
    return l;
  });
  if (!existed) {
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.splice(out.length - (out[out.length - 1] === '' ? 1 : 0), 0, `${name}=${v}`);
    if (out[out.length - 1] !== '') out.push('');
  }
  writeFileSync(path, out.join('\n'), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows 没有 POSIX 权限位 */ }
  if (v) env[name] = v; else delete env[name];
  return { name, existed, present: !!v };
}

/** 只回答"填了没有"。 */
export const envHas = (name, env = process.env) => !!env[name];
