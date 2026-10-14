// 追溯：从代码倒查回人 —— 文件:行 → git blame → 提交 → 步骤 → 条款 → 指令 / 批准 → 人。
//
// 提交与步骤的对应靠提交信息里的 `node:` / `SuperIntern-Node:` 行（现在每个步骤提交都带；更早的提交也有 `node:`）。
// GitHub 上 squash 合并出来的提交，正文里会并列多步的 `node:` 行 —— 照样都认出来，一并列出。
// 输入（提交号、文件路径）来自人：提交号只收十六进制或 HEAD~n，路径放在 `--` 之后，都不会被 git 当成选项。

import { gitRaw } from './git.mjs';
import { I18nError, tl } from '../i18n/index.mjs';
import { nodeProvenance, POLICIES } from './provenance.mjs';
import { approvalText, kindLabel, iso } from './provenance-render.mjs';

const REV = /^(?:[0-9a-fA-F]{4,64}|HEAD(?:~\d{1,4})?)$/;
const NODE_LINE = /^(?:node|SuperIntern-Node):[ \t]*(n_[0-9a-f]{6,32})[ \t]*$/gm;

/** "abc1234" → 提交；"src/a.mjs:42" → 文件某一行。 */
export function parseTraceQuery(q) {
  const s = String(q ?? '').trim();
  if (REV.test(s)) return { kind: 'commit', rev: s };
  const m = /^(.+):(\d{1,7})$/.exec(s);
  if (m && !m[1].startsWith('-')) return { kind: 'line', file: m[1].replace(/\\/g, '/'), line: Number(m[2]) };
  throw new I18nError('看不懂要追溯什么：给提交号（如 3f2a9c1），或 文件:行号（如 src/api/orders.mjs:42）');
}

/** 不属于哪一步的提交：SuperIntern 建仓库时的空起点（init: <任务 / 项目 id>）、合并提交、其余（人改的或别处来的）。 */
export function noStepNote(L, kind) {
  return {
    init: tl(L, '这是 SuperIntern 建仓库时的空起点提交，不属于哪一步'),
    merge: tl(L, '这是合并提交（把别的分支并进来），本身不属于哪一步；要查某一行，用 文件:行号 查到最初改它的那个提交'),
  }[kind] ?? tl(L, '这个提交不是 SuperIntern 的步骤做的（提交信息里没有步骤编号）：是人改的，或来自别处');
}

/** 某个提交：作者、时间、标题、类型（step / init / merge / other），以及它对应的步骤（各带完整出处）。 */
export function traceCommit(db, { dir, rev }) {
  if (!REV.test(String(rev ?? ''))) throw new I18nError('提交号不对：{rev}', { rev: String(rev ?? '').slice(0, 80) });
  let out;
  try { out = gitRaw(dir, ['log', '-1', '--format=%H%x00%P%x00%an%x00%aI%x00%B', rev, '--']); } catch { throw new I18nError('这个仓库里找不到提交 {rev}', { rev }); }
  const [sha, parents, author, date, ...rest] = out.split('\0');
  const body = rest.join('\0');
  const ids = [...new Set([...body.matchAll(NODE_LINE)].map((m) => m[1]))];
  const nodes = ids.map((id) => nodeProvenance(db, id) ?? { missing: id });
  const subject = body.split('\n')[0];
  const kind = ids.length ? 'step' : /^init: [tp]_[0-9a-f]+$/.test(subject.trim()) && /^superintern$/i.test(author) ? 'init' : parents.trim().split(/\s+/).length > 1 ? 'merge' : 'other';
  return { commit: { sha: sha.trim(), author, date, subject, kind }, nodes };
}

/** 文件某一行：git blame 找到最后改它的提交，再走 traceCommit。按磁盘上的文件对行号（和编辑器里看到的一致），工作区里还没提交的行照实说。 */
export function traceLine(db, { dir, file, line }) {
  if (!file || String(file).startsWith('-') || !(Number.isInteger(line) && line > 0)) throw new I18nError('要给 文件:行号');
  let blame;
  try { blame = gitRaw(dir, ['blame', '--porcelain', '-L', `${line},${line}`, '--', file]); }
  catch { throw new I18nError('git blame 失败：{file} 第 {line} 行（这个仓库里没有这个文件，或文件没有这一行）', { file, line }); }
  const sha = blame.split('\n')[0].split(' ')[0];
  const text = (blame.split('\n').find((l) => l.startsWith('\t')) ?? '').slice(1);
  if (/^0+$/.test(sha)) return { file, line, text, uncommitted: true, commit: null, nodes: [] };
  return { file, line, text, ...traceCommit(db, { dir, rev: sha }) };
}

/** 命令行的文字版。 */
export function renderTrace(t, L) {
  const out = [];
  if (t.file) out.push(tl(L, '{file} 第 {line} 行：{text}', { file: t.file, line: t.line, text: t.text.trim().slice(0, 120) }));
  if (t.uncommitted) { out.push(tl(L, '这一行还没提交（工作区里的改动），没有出处可查')); return out.join('\n'); }
  out.push(tl(L, '提交 {sha}（作者 {author}，{date}）：{subject}', { sha: t.commit.sha.slice(0, 10), author: t.commit.author, date: iso(Date.parse(t.commit.date)), subject: t.commit.subject }));
  if (!t.nodes.length) { out.push(noStepNote(L, t.commit.kind)); return out.join('\n'); }
  for (const p of t.nodes) {
    if (p.missing) { out.push(`  ${tl(L, '步骤 {id} 不在这个库里（别的部署做的，或库换过）', { id: p.missing })}`); continue; }
    out.push('', tl(L, '步骤「{title}」（{id}，任务「{task}」{taskId}）', { title: p.node.title, id: p.node.id, task: p.task.title, taskId: p.task.id }));
    out.push(`  ${approvalText(L, p.constitution, p.task.autoAdded)}${p.constitution && !p.constitution.current ? tl(L, '（之后契约又改过）') : ''}`);
    const req = p.requestedBy ?? p.task.owner;
    if (req) out.push(`  ${tl(L, '发起任务：{owner}', { owner: req.github ? `${req.name} (@${req.github})` : req.name })}`);
    if (p.policy) out.push(`  ${tl(L, '系统按规则加的步骤（不在批准时的计划里）：{why}', { why: POLICIES[p.policy.id]?.(L) ?? p.policy.id })}`);
    if (p.clauses.length) { out.push(`  ${tl(L, '落实的条款：')}`); for (const c of p.clauses) out.push(`    ${c.key}  ${c.text.slice(0, 160)}`); }
    else if (!p.policy) out.push(`  ${tl(L, '落实的条款：没有标到具体条款（只依据整版契约）')}`);
    if (p.instructions.length) {
      out.push(`  ${tl(L, '指令来源：')}`);
      for (const m of p.instructions) out.push(`    ${iso(m.at)}  ${m.senders.map((u) => (u.github ? `${u.name} (@${u.github})` : u.name)).join(', ')}（${m.question ? tl(L, '答“{q}”', { q: m.question.replace(/\s+/g, ' ').slice(0, 60) }) : kindLabel(L, m.kind)}）${m.body.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  return out.join('\n');
}
