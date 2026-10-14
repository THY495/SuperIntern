// 修改溯源的对外形态：提交 trailer 与 PR 溯源表。
//
// 链在库里（core/provenance.mjs），但读者常常在库外：GitHub 上看到的作者是 SuperIntern、id 不透明；库丢了、或读者没有看板权限，链就断了；
// GitHub 上 squash 合并会把一串提交压成一个。所以：
//   · 每个步骤的提交自带可读出处（git trailer）：哪个任务 / 步骤、契约第几版谁批的、落实哪几条条款、谁的指令、追溯链接；
//   · PR 正文带一张溯源表（步骤 → 条款 → 指令来源 → 提交），加上批准、签收、交付三行 —— squash 也不丢。
// trailer 是给机器和人都读的协议行，键与固定词用英文（与 git 自己的 Co-authored-by / Signed-off-by 一致），人名照原样。

import { gitRaw } from './git.mjs';
import { tl } from '../i18n/index.mjs';
import { getSetting } from './settings.mjs';
import { nodeProvenance, approvalOf, POLICIES } from './provenance.mjs';
import { verifiedGit } from './git-identity.mjs';

const oneLine = (s, max = 200) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');
// 名字后面跟 GitHub 账号：plain（提交 trailer、命令行）写 (@账号)；md（PR 正文）写成代码样式 —— PR 正文里裸的 @账号 会通知到那个人
const who1 = (u, fmt) => (u.github ? (fmt === 'md' ? `${u.name}（\`@${u.github}\`）` : `${u.name} (@${u.github})`) : u.name);
const names = (by, fmt = 'plain') => (by ?? []).map((u) => who1(u, fmt)).join(', ');

/** 看板上这一步的链接（部署设了看板地址才有）。 */
export function traceUrl(db, taskId, nodeId = null) {
  const base = String(getSetting(db, 'deploy.board_url') || '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/#${encodeURIComponent(taskId)}${nodeId ? `/node/${encodeURIComponent(nodeId)}` : ''}`;
}

/** 契约批准写成 trailer 的值（英文，协议行）。 */
function approvalTrailer(c, autoAdded) {
  if (!c) return null;
  const a = c.approval;
  const v = `v${c.version}`;
  if (!a) return `${v} (not approved${autoAdded ? '; added by the agent in auto mode, signed off afterwards' : ''})`;
  const who = oneLine(names(a.by), 120);
  if (a.kind === 'approval') return `${v} (approved-by ${who}; ${iso(a.at)})`;
  if (a.kind === 'direct') return `${v} (approved-by ${who}, direct; ${iso(a.at)})`;
  if (a.kind === 'instruction') return `${v} (changed-by ${who}, correction without approval gate; ${iso(a.at)})`;
  if (a.kind === 'inherited') return `${v} (approved-by ${who}, inherited from v${a.fromVersion}; ${iso(a.at)})`;
  return v;
}

/**
 * 步骤提交的 trailer 段（提交信息的最后一段）。保留原来的 `node:` / `handoff:` 两行 —— 按步骤找提交（diffview、补提交）认的是它们。
 */
export function commitTrailers(db, nodeId, { handoffId = null } = {}) {
  const p = nodeProvenance(db, nodeId);
  const lines = [`node: ${nodeId}`];
  if (handoffId) lines.push(`handoff: ${handoffId}`);
  if (!p) return lines;
  lines.push(`SuperIntern-Task: ${p.task.id}`, `SuperIntern-Node: ${nodeId}`);
  if (handoffId) lines.push(`SuperIntern-Handoff: ${handoffId}`);
  const contract = approvalTrailer(p.constitution, p.task.autoAdded);
  if (contract) lines.push(`Contract: ${contract}`);
  if (p.clauses.length) lines.push(`Clauses: ${p.clauses.map((c) => c.key).join(', ')}`);
  const instructed = [...new Map(p.instructions.flatMap((m) => m.senders).map((u) => [u.id, u])).values()];
  if (instructed.length) lines.push(`Instructed-by: ${oneLine(names(instructed), 160)}`);
  const req = p.requestedBy ?? p.task.owner;
  if (req) lines.push(`Requested-by: ${oneLine(who1(req), 120)}`);
  if (p.policy) lines.push(`Policy: ${p.policy.id}`);
  const url = traceUrl(db, p.task.id, nodeId);
  if (url) lines.push(`Trace: ${url}`);
  // Co-authored-by（部署设置，默认关）：给促成这处改动的人 —— 批准契约的、发指令的、发起的。GitHub 会显示头像；
  // 但它的本意是"共同作者"，所以默认不加。邮箱只用验证过的（core/git-identity.mjs：已绑定 GitHub 的用 noreply 地址，
  // 没绑定的只认管理员填的）—— 自己填别人的 noreply 邮箱就能让提交上显示别人的头像。
  if (getSetting(db, 'deploy.commit_coauthor')) {
    const ids = new Set([...(p.constitution?.approval?.by ?? []), ...instructed, ...(req ? [req] : [])].map((u) => u.id));
    for (const id of ids) {
      const u = db.one(`SELECT display_name FROM users WHERE id=?`, id);
      const email = u ? verifiedGit(db, id).email : null;
      if (email) lines.push(`Co-authored-by: ${oneLine(u.display_name, 80)} <${email}>`);
    }
  }
  return lines;
}

/** 某一步在 dir 的历史里对应哪些提交（短 sha）。 */
export function nodeCommits(dir, nodeId) {
  if (!dir) return [];
  try { return gitRaw(dir, ['log', '--format=%h', `--grep=^node: ${nodeId}$`, 'HEAD']).split('\n').map((s) => s.trim()).filter(Boolean).reverse(); } catch { return []; }
}

const cell = (s, max = 120) => oneLine(s, max).replace(/\|/g, '\\|');
export const kindLabel = (L, k) => ({ correction: tl(L, '修正'), context: tl(L, '补充'), answer: tl(L, '答复'), instruction: tl(L, '指令') }[k] ?? k);

/** 契约批准的一句人话（内容语言）。 */
export function approvalText(L, c, autoAdded = false, fmt = 'plain') {
  if (!c) return tl(L, '没有契约');
  const a = c.approval;
  if (!a) return autoAdded ? tl(L, '契约 v{v}：自动挡里 AI 自己加的任务，没有人批（签收在后）', { v: c.version }) : tl(L, '契约 v{v}：没有批准记录', { v: c.version });
  const who = names(a.by, fmt) || tl(L, '（已不在成员表里）');
  if (a.kind === 'approval') return tl(L, '契约 v{v}：{who} 于 {at} 在待决事项里批准', { v: c.version, who, at: iso(a.at) });
  if (a.kind === 'direct') return tl(L, '契约 v{v}：{who} 于 {at} 直接批准（在看板或命令行上，没走待决事项）', { v: c.version, who, at: iso(a.at) });
  if (a.kind === 'instruction') return tl(L, '契约 v{v}：{who} 于 {at} 发的修正直接生效（没触发批准门）', { v: c.version, who, at: iso(a.at) });
  return tl(L, '契约 v{v}：沿用 v{from} 的批准（{who}，{at}）', { v: c.version, from: a.fromVersion, who, at: iso(a.at) });
}

/** 任务最近一次通过的签收：谁、何时、签的是哪个提交。 */
function signoffOf(db, taskId) {
  const r = db.one(`SELECT actor_id, ts, payload FROM audit_log WHERE action='task_signed_off' AND target_id=? ORDER BY id DESC LIMIT 1`, taskId);
  if (!r) return null;
  const p = JSON.parse(r.payload || '{}');
  if (!p.accepted) return null;
  return { by: db.one(`SELECT display_name FROM users WHERE id=?`, r.actor_id)?.display_name ?? r.actor_id, at: r.ts, head: p.head ?? null };
}

/**
 * 一个任务的溯源段（Markdown）：批准 / 发起 / 签收 / 交付几行 + 步骤表。dir：交付推的那个仓库（按 `node:` 行找各步的提交）。
 * delivery：{ by: 名字, credential: 连接名 }（交付时才有）。
 */
export function taskProvenanceMarkdown(db, taskId, { L, dir = null, delivery = null, maxRows = 60 } = {}) {
  const nodes = db.all(`SELECT id FROM nodes WHERE task_id=? AND status<>'void' ORDER BY created_at, rowid`, taskId);
  const provs = nodes.map((n) => nodeProvenance(db, n.id)).filter(Boolean);
  const task = db.one(`SELECT owner_id FROM tasks WHERE id=?`, taskId);
  const cur = db.one(`SELECT id FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);
  const head = provs[0];
  const facts = [];
  // 批准行说的是"当前这一版"；某些步骤依据的是更早的版本，表里那一列会标出来
  const curProv = cur ? nodeProvenanceOfConstitution(db, cur.id, provs) : null;
  facts.push(`- ${approvalText(L, curProv, head?.task.autoAdded, 'md')}`);
  const ownerU = head?.task.owner ?? (() => { const u = db.one(`SELECT id, display_name FROM users WHERE id=?`, task?.owner_id); return u ? { id: u.id, name: u.display_name, github: verifiedGit(db, u.id).github } : null; })();
  const owner = ownerU ? who1(ownerU, 'md') : null;
  const req = head?.requestedBy && head.requestedBy.id !== ownerU?.id ? who1(head.requestedBy, 'md') : null;
  if (owner) facts.push(`- ${req && req !== owner ? tl(L, '发起：{owner}（需求提出人：{req}）', { owner, req }) : tl(L, '发起：{owner}', { owner })}`);
  const so = signoffOf(db, taskId);
  facts.push(`- ${so ? tl(L, '签收：{who} 于 {at}，签的是 `{head}`', { who: so.by, at: iso(so.at), head: String(so.head ?? '').slice(0, 8) }) : tl(L, '签收：没有签收记录')}`);
  if (delivery) facts.push(`- ${tl(L, '交付：{who}，所用连接：{cred}', { who: delivery.by ?? tl(L, '系统'), cred: delivery.credential ?? tl(L, '无（本机仓库）') })}`);
  const rows = provs.slice(0, maxRows).map((p) => {
    const sys = p.policy ? `<br>${cell(tl(L, '〔系统补的〕') + (POLICIES[p.policy.id]?.(L) ?? p.policy.id), 160)}` : '';
    const older = p.constitution && cur && p.constitution.id !== cur.id ? ` ${tl(L, '（依据 v{v}）', { v: p.constitution.version })}` : '';
    const clauses = p.clauses.map((c) => `${c.key} ${cell(c.text, 60)}`).join('<br>') || '—';
    const ins = p.instructions.map((m) => `${cell(names(m.senders, 'md'), 80)}（${m.question ? tl(L, '答“{q}”', { q: cell(m.question, 40) }) : kindLabel(L, m.kind)}）“${cell(m.body, 60)}”`).join('<br>') || '—';
    const commits = nodeCommits(dir, p.node.id).map((s) => `\`${s}\``).join(' ') || '—';
    return `| ${cell(p.node.title, 80)}${sys} | ${clauses}${older} | ${ins} | ${commits} |`;
  });
  const more = provs.length > maxRows ? `\n${tl(L, '（还有 {n} 步没列出，见看板）', { n: provs.length - maxRows })}` : '';
  return `${facts.join('\n')}\n\n| ${tl(L, '步骤')} | ${tl(L, '落实的条款')} | ${tl(L, '指令来源')} | ${tl(L, '对应提交')} |\n|---|---|---|---|\n${rows.join('\n')}${more}`;
}

/** 当前这一版契约的 { version, approval }（步骤表里各步可能依据更早的版本；批准行只说当前版）。 */
function nodeProvenanceOfConstitution(db, constitutionId, provs) {
  const hit = provs.find((p) => p.constitution?.id === constitutionId);
  if (hit) return hit.constitution;
  const c = db.one(`SELECT version FROM constitutions WHERE id=?`, constitutionId);
  return c ? { id: constitutionId, version: c.version, approval: approvalOf(db, constitutionId) } : null;
}
