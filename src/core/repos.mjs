// 新建入口的仓库选择：最近用过的仓库 + 提交前的校验。
//
// "最近用过" = 项目的 source 与从想法起的任务的 draft.source，按最近使用排序去重。不另存一张"已接入仓库"表 ——
// 我们没有"接入"这个动作（别家是 OAuth 装 App），仓库就是一个本机路径或 URL。
// 校验只做便宜且确定的：本机路径必须存在且是 git 仓库；URL 只看形状（真去连要凭证、要出网，留给后面的克隆报错）。

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const looksLikeUrl = (s) => /^(https?|ssh|git|file):\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);

/** 最近用过的仓库：[{ source, lastUsedAt, uses, kind: 'path'|'url', ok }]。`ok`：本机路径现在还在不在（URL 恒 true）。 */
export function knownRepos(db, { limit = 12 } = {}) {
  const rows = [
    ...db.all(`SELECT source AS s, created_at AS t FROM projects WHERE source IS NOT NULL AND source<>''`),
    ...db.all(`SELECT p.value AS s, p.recorded_at AS t FROM params p WHERE p.key='draft.source' AND p.superseded_at IS NULL`)
      .map((r) => { try { return { s: JSON.parse(r.s), t: r.t }; } catch { return { s: r.s, t: r.t }; } }),
  ].filter((r) => typeof r.s === 'string' && r.s.trim())
    // 系统自己的目录不算"用过的仓库"：项目的内部克隆、任务工作区（接续出来的项目 source 就是工作区路径）。
    .filter((r) => !/[/](projects[/]pj_[0-9a-f]+[/]repo|workspaces[/]t_[0-9a-f]+)[/]?$/i.test(r.s.trim().split('\\').join('/')));
  const by = new Map();
  for (const r of rows) {
    const key = looksLikeUrl(r.s) ? r.s.trim() : resolve(r.s.trim()).replace(/\\/g, '/');
    const cur = by.get(key) ?? { source: key, lastUsedAt: 0, uses: 0 };
    cur.lastUsedAt = Math.max(cur.lastUsedAt, r.t ?? 0); cur.uses += 1;
    by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, limit)
    .map((r) => ({ ...r, kind: looksLikeUrl(r.source) ? 'url' : 'path', ok: looksLikeUrl(r.source) ? true : existsSync(r.source) }));
}

/** 提交前校验。不合格就抛（报错直接上屏）。空值：required 才拒。 */
export function checkRepoSource(source, { required = false } = {}) {
  const s = String(source ?? '').trim();
  if (!s) { if (required) throw new Error('目标仓库不能为空'); return null; }
  if (looksLikeUrl(s)) return { kind: 'url', source: s };
  if (!existsSync(s)) throw new Error(`仓库路径不存在：${s}`);
  try {
    execFileSync('git', ['-C', s, 'rev-parse', '--git-dir'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
  } catch { throw new Error(`该路径不是 git 仓库：${s}`); }
  return { kind: 'path', source: s };
}
