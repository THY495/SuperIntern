// 审批门禁（Approval gates）：项目负责人列出"必须有人点头才能跑"的命令，执行器碰到就停下问人。
//
// 真实团队有这类操作：上线、改数据库结构、往外部系统写（`git push`、`*migrate*`、`kubectl apply`、`terraform apply`）。
// 沙箱已经挡住了大部分外部副作用（联网要放行、推送永远要人点），但放行过的源、带了凭据的出口、进了沙箱的工具链
// 仍可能对外动手；有的团队就是要求这些命令每次都有人看过。
//
// 和别的闸的关系：
//   - 策略钩子（hooks.mjs）是仓库里的脚本、可以写任意判断；门禁是负责人在看板上列的几条模式，不用写代码。
//   - MCP 工具的 ask 模式就是 MCP 那一侧的门禁（mcp.mjs），这里只管命令。
//   - 命中后挂一条"安全审批"事项（决策档、底线锁死、不会被超时替人定）；答「同意」放行这一条（一模一样的再跑不再问）。
//
// 模式：`*` 任意一串、`?` 任意一个字符，整条匹配、不分大小写。命令行按 argv 拼成一行比；`sh -c "..."` 这类包了一层的，
// 也拿里面那段比；`&&` / `||` / `;` / `|` 连起来的，每一段各比一次 —— 不然包一层就绕过去了。

import { audit } from '../db/db.mjs';
import { getProjectParam, setProjectParam } from './params.mjs';
import { I18nError, N_, tl, contentLang } from '../i18n/index.mjs';
import { rulesOf } from './routing.mjs';

export const GATES_KEY = 'project.approval_gates';
export const MAX_PATTERNS = 50;
/** 看板上给的常见几条（勾选即加），不是默认值：默认清单为空。 */
export const GATE_SUGGESTIONS = [
  { pattern: 'git push*', label: N_('推送到远端') },
  { pattern: '*migrate*', label: N_('数据库结构迁移') },
  { pattern: 'kubectl apply*', label: N_('改集群里的资源') },
  { pattern: 'terraform apply*', label: N_('改云上的基础设施') },
  { pattern: 'npm publish*', label: N_('发布 npm 包') },
  { pattern: '*curl* -X POST*', label: N_('往外部接口写数据') },
];

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'cmd', 'cmd.exe', 'powershell', 'pwsh']);
const globRe = (p) => new RegExp(`^${String(p).trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'is');

export function gatesOf(db, projectId) {
  const v = projectId ? getProjectParam(db, projectId, GATES_KEY) : null;
  return { commands: Array.isArray(v?.commands) ? v.commands.filter((x) => typeof x === 'string' && x.trim()) : [] };
}

/** 这条命令要比的几种写法：整行、包壳里的那段、按连接符切开的每一段。 */
export function commandForms(file, args = []) {
  const base = String(file ?? '').split(/[\\/]/).pop().toLowerCase();
  const whole = [file, ...args].map(String).join(' ').trim();
  const out = [whole];
  const ci = args.findIndex((a) => a === '-c' || a === '/c' || a === '-Command' || a === '/C');
  if (SHELLS.has(base) && ci >= 0 && args[ci + 1] != null) out.push(String(args.slice(ci + 1).join(' ')).trim());
  for (const s of [...out]) for (const seg of s.split(/&&|\|\||;|\|/)) { const t = seg.trim(); if (t && !out.includes(t)) out.push(t); }
  // 同一个工具换个写法也要认得出：去掉开头的环境变量赋值（PGPASSWORD=x psql …、env X=1 psql …）与第一个词的路径（/usr/bin/psql …）
  for (const s of [...out]) { const t = bare(s); if (t && !out.includes(t)) out.push(t); }
  return out;
}
const bare = (s) => {
  let t = String(s).trim().replace(/^env\s+/, '');
  while (/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/.test(t)) t = t.replace(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S*)\s+/, '');
  return t.replace(/^\S*[\\/](?=\S)/, '');
};

/** 命中的第一条模式；没命中 null。 */
export function gateHit(patterns, file, args = []) {
  if (!patterns?.length) return null;
  const forms = commandForms(file, args);
  for (const p of patterns) { const re = globRe(p); if (forms.some((f) => re.test(f))) return p; }
  return null;
}

/** 负责人改门禁清单（整份换）。调用方核过权限。expect = 打开页面时看到的清单（对不上 409，与别处同一套）。 */
export function setGates(db, { projectId, commands, userId, expect = undefined }) {
  const list = [...new Set((commands ?? []).map((x) => String(x).trim()).filter(Boolean))];
  if (list.length > MAX_PATTERNS) throw new I18nError('审批门禁最多 {n} 条', { n: MAX_PATTERNS });
  for (const p of list) if (p.length > 200) throw new I18nError('这一条太长了（最多 200 个字符）：{p}', { p: p.slice(0, 40) });
  if (list.some((p) => /^\*+$/.test(p))) throw new I18nError('「*」会拦下每一条命令，AI 就什么都做不了；写具体一点（例如 git push*）');
  return db.tx(() => {
    const before = gatesOf(db, projectId).commands;
    if (expect !== undefined && JSON.stringify([...expect].sort()) !== JSON.stringify([...before].sort())) {
      const L = contentLang(db);
      const last = db.one(`SELECT l.ts, u.display_name FROM audit_log l LEFT JOIN users u ON u.id=l.actor_id WHERE l.action='approval_gates_set' AND l.target_id=? ORDER BY l.id DESC LIMIT 1`, projectId);
      throw Object.assign(new I18nError('没有保存：你打开这一页之后，{who} 于 {when} 改了审批门禁，现在是：{now}。页面已刷新；仍要改，就在新的清单上再改一次并保存', {
        who: last?.display_name ?? tl(L, '别人'), when: last ? `${new Date(last.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC` : tl(L, '刚才'), now: before.join(tl(L, '、')) || tl(L, '（空）') }), { status: 409, conflict: true });
    }
    setProjectParam(db, { projectId, key: GATES_KEY, value: list.length ? { commands: list } : null, by: { kind: 'user', id: userId }, governance: 'constitutional' });
    audit(db, { actorKind: 'user', actorId: userId, action: 'approval_gates_set', targetType: 'project', targetId: projectId,
      payload: { added: list.filter((p) => !before.includes(p)), removed: before.filter((p) => !list.includes(p)) } });
    return gatesOf(db, projectId);
  });
}

/** 看板上"试一条命令"：按空白切成 argv（引号里的算一段，引号本身去掉），拿给 gateHit 比。不跑任何东西。 */
export function splitCommandLine(line) {
  const out = []; let cur = '', q = null, any = false;
  for (const ch of String(line ?? '')) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}
export function gateTest(patterns, line) {
  const [file, ...args] = splitCommandLine(line);
  return { hit: file ? gateHit(patterns, file, args) : null };
}

/**
 * 命中门禁的事项派给谁：项目路由表里"安全审批"的第一段（* 那一行；旧表没有就借"系统卡住"的行）。
 * 只给看板显示用，返回结构化的收件人（名字由看板按语言拼）；真正派人仍由 routeQuestion 算（值班、需求提出人要到时才定）。
 */
export function gateRouteOf(db, projectId) {
  const row = rulesOf(db, projectId).filter((r) => r.decision_type === 'security' && r.scope === '*').sort((a, b) => a.position - b.position)[0];
  const lead = db.one(`SELECT u.display_name FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=?`, projectId)?.display_name ?? null;
  const name = (id) => db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? null;
  const who = (row?.recipients ?? ['user:lead']).filter((x) => !String(x).startsWith('inform:')).map((x) => {
    if (x === 'user:lead') return { k: 'lead', name: lead };
    if (x.startsWith('user:')) return { k: 'user', name: name(x.slice(5)) };
    if (x === 'group:*') return { k: 'all' };
    if (x.startsWith('group:')) return { k: 'tag', tag: x.slice(6) };
    if (x === 'on_duty') return { k: 'duty' };
    if (x === 'requester') return { k: 'requester' };
    return null;
  }).filter((w) => w && (w.k !== 'user' || w.name));
  return { who: who.length ? who : [{ k: 'lead', name: lead }] };
}
