// 改动对比：看板上直接看代码的增删，不再只靠 agent 在汇报里的自述。
//
// 两个口径，都是"一个区间的 git diff"，区别只在去哪个仓库、取哪两个端点：
//   - 任务（任务页 / 签收）：任务工作区里，`contributionOf` 的基线 → 任务分支的头。
//     基线就是"接手时的代码"—— 与 GitHub 看 PR 同一个口径；集成带进来的别人的产物不算这个任务的。
//   - 交付（按任务）：项目仓库里，`mergeChainOf` 给的那一段 from → head，即这个任务合并进来时带进来的部分。
//
// 越界被撤销的改动不在这里：它们从没进过提交，只在审计 / 汇报里提一句。
//
// 只读 git，不调模型。读不到就如实返回 reason，页面照实说，不渲染成一个空的"没有改动"。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { contributionOf } from './workspace.mjs';
import { mergeChainOf } from './project.mjs';

const git = (dir, ...a) => execFileSync('git', ['-c', 'core.quotepath=off', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/** 总量上限：超过的文件只给增删行数，不给逐行（页面说"太大，只列行数"）。 */
export const DIFF_LIMITS = { totalLines: 20_000, fileLines: 3_000 };
/** 生成物：永远折叠、只给行数 —— 逐行看它没有意义，还会把真改动淹掉。 */
const GENERATED = [/(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)poetry\.lock$/, /(^|\/)Pipfile\.lock$/,
  /(^|\/)Cargo\.lock$/, /(^|\/)go\.sum$/, /(^|\/)composer\.lock$/, /\.min\.(js|css)$/, /\.map$/];
export const isGenerated = (path) => GENERATED.some((re) => re.test(path));

const unquote = (s) => {
  // core.quotepath=off 之后只剩含空格 / 引号 / 控制字符的路径还带引号
  if (!s.startsWith('"')) return s;
  try { return JSON.parse(s); } catch { return s.slice(1, -1); }
};

/**
 * 解析 `git diff` 的统一格式输出。只认 git 自己的格式（diff --git 开头），不做通用 patch 解析。
 * 返回 [{ path, oldPath, status, binary, adds, dels, hunks: [{ oldStart, oldLines, newStart, newLines, ctx, lines: [[' '|'+'|'-', text]] }] }]
 */
export function parseGitDiff(text) {
  const files = [];
  let f = null, h = null;
  for (const raw of String(text).split('\n').map((l) => l.replace(/\r$/, ''))) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(raw);
      f = { path: m ? unquote(m[2]) : raw.slice(11), oldPath: m ? unquote(m[1]) : null, status: 'modified', binary: false, adds: 0, dels: 0, hunks: [] };
      files.push(f); h = null; continue;
    }
    if (!f) continue;
    if (!h) {
      if (raw.startsWith('new file mode')) { f.status = 'added'; continue; }
      if (raw.startsWith('deleted file mode')) { f.status = 'deleted'; continue; }
      if (raw.startsWith('rename from ')) { f.status = 'renamed'; f.oldPath = raw.slice(12); continue; }
      if (raw.startsWith('rename to ')) { f.path = raw.slice(10); continue; }
      if (raw.startsWith('Binary files ')) { f.binary = true; continue; }
      if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('index ') || raw.startsWith('similarity ') || raw.startsWith('old mode') || raw.startsWith('new mode')) continue;
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(raw);
    if (hm) {
      h = { oldStart: +hm[1], oldLines: hm[2] === undefined ? 1 : +hm[2], newStart: +hm[3], newLines: hm[4] === undefined ? 1 : +hm[4], ctx: hm[5] ?? '', lines: [] };
      f.hunks.push(h); continue;
    }
    if (!h) continue;
    const k = raw[0];
    if (k === '+') { h.lines.push(['+', raw.slice(1)]); f.adds++; }
    else if (k === '-') { h.lines.push(['-', raw.slice(1)]); f.dels++; }
    else if (k === ' ') h.lines.push([' ', raw.slice(1)]);
    else if (raw === '') { /* 输出末尾的空行 */ }
    // '\ No newline at end of file'：不是内容，丢掉
  }
  return files;
}

/** 一个区间的结构化 diff。 */
export function diffRange(dir, base, head) {
  if (!dir || !existsSync(dir)) return { ok: false, reason: '仓库目录不在了' };
  if (!base || !head) return { ok: false, reason: '说不出这个任务从哪一版开始（没有基线记录）' };
  if (base === head) return { ok: true, base, head, files: [], adds: 0, dels: 0 };
  let text;
  try { text = git(dir, 'diff', '--no-color', '--no-ext-diff', '-M', '-U3', `${base}..${head}`); }
  catch (e) { return { ok: false, reason: `读不到这一段的提交：${String(e.stderr ?? e.message).trim().split('\n')[0]}` }; }
  const files = parseGitDiff(text);
  let budget = DIFF_LIMITS.totalLines;
  for (const f of files) {
    const n = f.hunks.reduce((a, h) => a + h.lines.length, 0);
    f.generated = isGenerated(f.path);
    f.lines = n;
    // 太大 / 生成物 / 超了总量：只留行数。逐行留着也没人看，还拖慢整页。
    if (f.generated || n > DIFF_LIMITS.fileLines || n > budget) { f.omitted = f.generated ? 'generated' : 'too_large'; f.hunks = []; }
    else budget -= n;
    // 新版本的总行数：页面据此说"文件末尾还有 N 行没改"，而不是放一个点了才知道是空的"展开到文件末尾"
    if (!f.omitted && !f.binary && (f.status === 'modified' || f.status === 'renamed')) {
      try { const t = git(dir, 'show', `${head}:${f.path}`); f.total = t.split('\n').length - (t.endsWith('\n') ? 1 : 0); } catch { f.total = null; }
    }
  }
  return { ok: true, base, head, files, adds: files.reduce((a, f) => a + f.adds, 0), dels: files.reduce((a, f) => a + f.dels, 0) };
}

/** 任务口径：工作区里 基线 → 任务头。 */
export function taskRange(db, { taskId, home }) {
  const dir = join(home, 'workspaces', taskId);
  if (!existsSync(dir)) return { ok: false, reason: '这个任务还没有工作区（没开工，或已清理）' };
  let head;
  try { head = git(dir, 'rev-parse', 'HEAD').trim(); } catch { return { ok: false, reason: '工作区不是一个可读的 git 仓库' }; }
  const c = contributionOf(db, { taskId, dir, head });
  return { ok: true, dir, base: c.base, head, via: c.via };
}

/**
 * 返工那一轮的起点：上次请求签收时的头。发起签收时显式记在 `signoff.since`（第一次签收记 null）；
 * 这个参数出现之前的老数据，从 `signoff.head` 的历史里找上一个不同的头 —— 与发起签收时判"返工"的口径一致。
 */
export function roundSinceOf(db, taskId) {
  const explicit = db.one(`SELECT value FROM params WHERE task_id=? AND key='signoff.since' ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, taskId);
  if (explicit) { try { return JSON.parse(explicit.value) ?? null; } catch { return null; } }
  const heads = db.all(`SELECT value FROM params WHERE task_id=? AND key='signoff.head' ORDER BY recorded_at DESC, rowid DESC`, taskId)
    .map((r) => { try { return JSON.parse(r.value); } catch { return null; } });
  const cur = heads[0] ?? null;
  return cur ? (heads.find((h) => h && h !== cur) ?? null) : null;
}

/**
 * 这一轮：上次请求签收时的头 → 任务头。把项目分支合进来带进来的文件摘出去单列（与签收正文同一个口径：
 * 签收人要判的是这一轮做了什么，集成不是任何人的内容决定）。
 */
export function roundRange(db, { taskId, home }) {
  const t = taskRange(db, { taskId, home });
  if (!t.ok) return t;
  const since = roundSinceOf(db, taskId);
  if (!since) return { ok: false, reason: '这次签收不是返工，没有"这一轮"可比' };
  const c = contributionOf(db, { taskId, dir: t.dir, head: t.head });
  return { ok: true, dir: t.dir, base: since, head: t.head, via: 'round', keep: c.via === 'merge-base' && Array.isArray(c.files) ? c.files : null };
}

/** 某一步：这一步完成时的那个提交（提交信息里写着 `node: <id>`）。做过几次的，给最后一次。 */
export function nodeRange(db, { taskId, home, nodeId }) {
  const t = taskRange(db, { taskId, home });
  if (!t.ok) return t;
  if (!/^n_[0-9a-z]+$/.test(String(nodeId ?? ''))) return { ok: false, reason: '步骤编号不对' };
  let shas;
  try { shas = git(t.dir, 'log', '--format=%H', `--grep=^node: ${nodeId}$`, 'HEAD').split('\n').filter(Boolean); }
  catch { return { ok: false, reason: '读不到这个任务的提交历史' }; }
  if (!shas.length) return { ok: false, reason: '这一步没有留下提交（没改文件，或还没做完）' };
  const sha = shas[0];
  let base;
  try { base = git(t.dir, 'rev-parse', `${sha}^`).trim(); } catch { base = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; }   // 根提交：和空树比
  return { ok: true, dir: t.dir, base, head: sha, via: 'node', times: shas.length };
}

/** 接口用：按口径取区间。scope 不给 = 有返工那一轮就给这一轮，否则给全部。 */
export function rangeFor(db, { taskId, home, scope = null, node = null }) {
  if (scope === 'node') return nodeRange(db, { taskId, home, nodeId: node });
  if (scope === 'round') return roundRange(db, { taskId, home });
  if (scope === 'all') return taskRange(db, { taskId, home });
  const r = roundSinceOf(db, taskId) ? roundRange(db, { taskId, home }) : null;
  return r?.ok ? r : taskRange(db, { taskId, home });
}

/** 交付口径：项目仓库里这个任务合并进来的那一段。 */
export function deliveryRange(db, { projectId, taskId }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
  if (!p) return { ok: false, reason: '项目不存在' };
  const bt = mergeChainOf(db, p);
  const t = bt.tasks.find((x) => x.taskId === taskId);
  if (!t) return { ok: false, reason: bt.broken ?? '这个任务还没合并进项目分支' };
  return { ok: true, dir: p.repo, base: t.from, head: t.head };
}

export function viewOf(range, { roundSince = null } = {}) {
  if (!range.ok) return range;
  const v = { ...diffRange(range.dir, range.base, range.head), via: range.via ?? null, times: range.times ?? null, roundSince };
  if (v.ok && range.keep) {
    const keep = new Set(range.keep);
    v.brought = v.files.filter((f) => !keep.has(f.path)).map((f) => f.path);
    v.files = v.files.filter((f) => keep.has(f.path));
    v.adds = v.files.reduce((a, f) => a + f.adds, 0);
    v.dels = v.files.reduce((a, f) => a + f.dels, 0);
  }
  return v;
}

/**
 * "展开 N 行未改动"：取**新版本**里的一段行。只许取这个区间里真的变过的文件（不是任意读仓库）。
 * 行号从 1 起，闭区间；to 给 null 取到文件尾。
 */
export function linesOf(range, { path, from, to = null }) {
  if (!range.ok) return range;
  let changed;
  try { changed = git(range.dir, 'diff', '--name-only', '-M', `${range.base}..${range.head}`).split('\n').filter(Boolean); }
  catch { return { ok: false, reason: '读不到这一段的提交' }; }
  if (!changed.includes(path) || (range.keep && !range.keep.includes(path))) return { ok: false, reason: '这个文件不在这次的改动里' };
  let text;
  try { text = git(range.dir, 'show', `${range.head}:${path}`); } catch { return { ok: false, reason: '读不到这个文件' }; }
  const all = text.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const a = Math.max(1, Number(from) || 1), b = Math.min(all.length, to === null || to === undefined || to === '' ? all.length : Number(to));
  return { ok: true, from: a, to: b, total: all.length, lines: b >= a ? all.slice(a - 1, b) : [] };
}
