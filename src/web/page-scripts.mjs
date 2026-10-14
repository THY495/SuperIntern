// 看板脚本：index.html 里按顺序引用的 /app/*.js。
// 服务端只发这张表里的文件（不拼任意路径）；测试按同一顺序编译、加载；i18n 抽取器扫同一批文件。
// 表由 index.html 的 <script src="/app/…"> 现读出来，顺序以页面为准 —— 加文件只改页面一处。

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEB_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = join(WEB_DIR, 'app');
const NAME = /^[0-9]{2}-[a-z0-9-]+\.js$/;

/** 页面按顺序引用的脚本：[{ name, path, url }]。只认 /app/<两位数>-<小写名>.js。 */
export function appScripts(html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8')) {
  return [...html.matchAll(/<script src="\/app\/([^"]+)"[^>]*><\/script>/g)].map((m) => {
    if (!NAME.test(m[1])) throw new Error(`index.html 引用了不合规的脚本名：${m[1]}`);
    return { name: m[1], path: join(APP_DIR, m[1]), url: `/app/${m[1]}` };
  });
}

/** 测试用：从跑着的看板取页面，再按页面里的顺序取它引用的每个脚本，拼成一份文本（拆开之前 GET / 就是这么一份）。 */
export async function fetchBoard(base, headers = {}) {
  const page = await fetch(`${base}/`, { headers }).then((r) => r.text());
  const parts = [page];
  for (const s of appScripts(page)) {
    const r = await fetch(base + s.url, { headers });
    if (!r.ok) throw new Error(`${s.url}：${r.status}`);
    parts.push(await r.text());
  }
  return parts.join('\n');
}

/** app/ 目录里实际有的脚本（测试拿来查"有文件没被页面引用"）。 */
export const appFiles = () => readdirSync(APP_DIR).filter((n) => n.endsWith('.js')).sort();
