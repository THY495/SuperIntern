// 修改溯源：每一处改动 → 哪一步 → 契约的哪几条条款 → 谁的哪条指令 / 哪次批准。
//
// 链全在 edges 上（v36 起只增，不能删改）：
//   步骤 —derived_from→ 契约版本（c_…）              规划时：这一步依据的是哪一版
//   步骤 —derived_from→ "<契约 id>#C3"                 这一步落实的是哪几条条款（规划器的 covers + 规则引文落在哪条，机械推出）
//   步骤 —derived_from→ 消息（m_…）                    修正、补充上下文、对本步提问的答复
//   步骤 —derived_from→ "policy:<规则 id>"            系统补的步骤（截图说明、样例数据、契约缺口）是哪条内置规则触发的
//   契约版本 —derived_from→ 想法参数 / 消息 / 项目 / 上一版契约   这一版从哪来
//   契约版本 —concluded_by→ 批准答复的消息（或建任务的人）       这一版由谁、何时批准；版本变了批准不跟着走
//
// 这里只读链、组装成结构；渲染（提交 trailer、PR 溯源表、看板、命令行）各在各处。

import { insertEdge } from '../db/db.mjs';
import { tl } from '../i18n/index.mjs';
import { splitClauses, assignClauseKeys, clausesQuoted } from './clauses.mjs';
import { verifiedGit } from './git-identity.mjs';

/** 系统补步骤的内置规则。id 进出处边（"policy:<id>"），说明给人看。 */
export const POLICIES = {
  contract_coverage: (L) => tl(L, '项目契约写明的接口 / 命令在代码里找不到或对不上 → 加一步把缺口补上'),
  preview_spec: (L) => tl(L, '任务改了界面，仓库里却没有截图说明文件 si-preview.json（写明怎么启动、截哪几页）→ 加一步让 AI 写'),
  preview_seed: (L) => tl(L, '截图前页面要有样例数据才看得出效果 → 加一步让 AI 写造样例数据的脚本'),
};
export const policyRef = (id) => `policy:${id}`;
export const clauseRef = (constitutionId, key) => `${constitutionId}#${key}`;
const parseClauseRef = (s) => { const m = /^(c_[0-9a-f]+)#(C\d+)$/.exec(s); return m ? { constitutionId: m[1], key: m[2] } : null; };

/** 一版契约的条款。老行（v36 之前直接插入、没走 writeConstitution 的）现切现编，不落库。 */
export function clausesOf(db, constitutionId) {
  const c = db.one(`SELECT * FROM constitutions WHERE id=?`, constitutionId);
  if (!c) return [];
  const stored = JSON.parse(c.clauses || '[]');
  return stored.length ? stored : assignClauseKeys(splitClauses(c));
}

/**
 * 一个步骤落实了哪几条条款：规划器明说的 covers（已校验是本版的编号）∪ 规则引文落在哪条。
 * 写出处边；返回编号列表。
 */
export function recordCoverage(db, { nodeId, constitutionId, covers = [], rules = [], at }) {
  const clauses = clausesOf(db, constitutionId);
  const keys = new Set(clauses.map((c) => c.key));
  const out = new Set((covers ?? []).filter((k) => keys.has(k)));
  for (const r of rules ?? []) if (r?.quote) for (const k of clausesQuoted(clauses, r.quote)) out.add(k);
  const sorted = [...out].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  for (const k of sorted) insertEdge(db, nodeId, clauseRef(constitutionId, k), 'derived_from', at);
  return sorted;
}

/** 系统补的步骤：哪条内置规则 + 当时的那一版契约。 */
export function linkSystemNode(db, { nodeId, taskId, policy, at }) {
  const c = db.one(`SELECT id FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);
  if (c) insertEdge(db, nodeId, c.id, 'derived_from', at);
  insertEdge(db, nodeId, policyRef(policy), 'derived_from', at);
}

/** 某一步读进 / 依据了某条消息（补充上下文、对本步提问的答复）。同一对只记一次。 */
export function linkInstruction(db, { nodeId, messageId, at }) {
  if (db.one(`SELECT 1 FROM edges WHERE from_id=? AND to_id=? AND relation='derived_from' AND superseded_at IS NULL`, nodeId, messageId)) return;
  insertEdge(db, nodeId, messageId, 'derived_from', at);
}

/** 追问器出的一版草案从哪来：想法参数、自上一版以来本任务任务级提问的答复（含对上一版的批注）、上一版。 */
export function linkConstitutionSources(db, { constitutionId, taskId, since = 0, supersedes = null, at }) {
  const idea = db.one(`SELECT id FROM params WHERE task_id=? AND key='draft.idea' AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, taskId);
  if (idea) insertEdge(db, constitutionId, idea.id, 'derived_from', at);
  for (const { id } of db.all(`SELECT DISTINCT m.id FROM questions q JOIN edges e ON e.to_id=q.id AND e.relation='answers' AND e.superseded_at IS NULL
                               JOIN messages m ON m.id=e.from_id WHERE q.task_id=? AND q.node_id IS NULL AND m.received_at > ? ORDER BY m.received_at`, taskId, since)) {
    insertEdge(db, constitutionId, id, 'derived_from', at);
  }
  if (supersedes) insertEdge(db, constitutionId, supersedes, 'supersedes', at);
}

/** 契约版本由谁批准：messageId（批准答复）或 userId（建任务的人直接写的契约）。 */
export function bindApproval(db, { constitutionId, messageId = null, userId = null, at }) {
  const to = messageId ?? userId;
  if (!constitutionId || !to) return;
  if (db.one(`SELECT 1 FROM edges WHERE from_id=? AND relation='concluded_by' AND superseded_at IS NULL`, constitutionId)) return;
  insertEdge(db, constitutionId, to, 'concluded_by', at);
}

// github：验证过的 GitHub 账号（已绑定，或管理员替他填的；本人自己填、没验证的不算 —— 不然能冒名，见 core/git-identity.mjs），
// 提交 trailer 与 PR 溯源表里跟在名字后面
const userBrief = (db, id) => { const u = id ? db.one(`SELECT id, display_name FROM users WHERE id=?`, id) : null; return u ? { id: u.id, name: u.display_name, github: verifiedGit(db, u.id).github } : null; };

/** 消息 → { id, kind, at, sender, body }；会签合并的消息再展开到各人的原答复（只一层）。 */
function messageBrief(db, id) {
  const m = db.one(`SELECT id, kind, sender_id, body, received_at, trust_label FROM messages WHERE id=?`, id);
  if (!m) return null;
  const parts = db.all(`SELECT m.sender_id FROM edges e JOIN messages m ON m.id=e.to_id
                        WHERE e.from_id=? AND e.relation='derived_from' AND e.superseded_at IS NULL`, id).map((r) => r.sender_id);
  const senders = [...new Set([m.sender_id, ...parts].filter(Boolean))].map((u) => userBrief(db, u)).filter(Boolean);
  const q = m.kind === 'answer' ? db.one(`SELECT q.text FROM edges e JOIN questions q ON q.id=e.to_id WHERE e.from_id=? AND e.relation='answers' AND e.superseded_at IS NULL ORDER BY e.id LIMIT 1`, id) : null;
  return { id: m.id, kind: m.kind, at: m.received_at, trust: m.trust_label, senders, body: m.body, question: q?.text ?? null };
}

/**
 * 一版契约的批准：
 *   { kind: 'approval' | 'instruction' | 'direct' | 'inherited', by: [{id,name}], at, messageId, fromVersion? } 或 null（没批准过）。
 * approval：在批准事项里答的；instruction：人发的修正直接生效（没触发批准门）；direct：人在命令行 / 卡片上直接确认（建任务时自己写的契约、直接批准的修订），没有答复消息；
 * inherited：重做出来的任务沿用原任务那一版的批准（契约逐字相同才算）。
 */
export function approvalOf(db, constitutionId, depth = 0) {
  const e = db.one(`SELECT to_id, recorded_at FROM edges WHERE from_id=? AND relation='concluded_by' AND superseded_at IS NULL ORDER BY id LIMIT 1`, constitutionId);
  if (e) {
    const m = messageBrief(db, e.to_id);
    if (m) return { kind: m.kind === 'answer' ? 'approval' : 'instruction', by: m.senders, at: m.at, messageId: m.id };
    const u = userBrief(db, e.to_id);
    if (u) return { kind: 'direct', by: [u], at: e.recorded_at, messageId: null };
  }
  if (depth > 3) return null;
  // 重做：新任务的契约 derived_from 原任务那一版，逐字相同就沿用它的批准
  const src = db.all(`SELECT to_id FROM edges WHERE from_id=? AND relation='derived_from' AND superseded_at IS NULL`, constitutionId)
    .map((r) => db.one(`SELECT id, version FROM constitutions WHERE id=?`, r.to_id)).filter(Boolean);
  const same = (a, b) => JSON.stringify(clausesOf(db, a).map((c) => [c.kind, c.text])) === JSON.stringify(clausesOf(db, b).map((c) => [c.kind, c.text]));
  for (const s of src) {
    if (!same(constitutionId, s.id)) continue;
    const a = approvalOf(db, s.id, depth + 1);
    if (a) return { ...a, kind: 'inherited', fromConstitution: s.id, fromVersion: s.version };
  }
  return null;
}

/** 一版契约从哪来：想法、消息（追问答复 / 修正）、项目、上一版。 */
export function constitutionSources(db, constitutionId) {
  const out = { ideas: [], messages: [], projects: [], constitutions: [] };
  for (const { to_id: id } of db.all(`SELECT to_id FROM edges WHERE from_id=? AND relation='derived_from' AND superseded_at IS NULL ORDER BY id`, constitutionId)) {
    const m = messageBrief(db, id);
    if (m) { out.messages.push(m); continue; }
    const p = db.one(`SELECT id, value, set_by_id, recorded_at FROM params WHERE id=?`, id);
    if (p) { out.ideas.push({ id: p.id, by: userBrief(db, p.set_by_id), at: p.recorded_at, text: (() => { try { return JSON.parse(p.value); } catch { return p.value; } })() }); continue; }
    const pr = db.one(`SELECT id, title, owner_id FROM projects WHERE id=?`, id);
    if (pr) { out.projects.push({ id: pr.id, title: pr.title, owner: userBrief(db, pr.owner_id) }); continue; }
    const c = db.one(`SELECT id, task_id, version FROM constitutions WHERE id=?`, id);
    if (c) out.constitutions.push({ id: c.id, taskId: c.task_id, version: c.version });
  }
  return out;
}

/**
 * 一个步骤的完整出处：
 *   { node, task, requestedBy: [用户] | null, constitution: {id, version, current, approval, sources}, clauses: [{key, kind, text}],
 *     instructions: [消息], policy: {id} | null }
 */
export function nodeProvenance(db, nodeId) {
  const node = db.one(`SELECT id, task_id, title, status, created_at FROM nodes WHERE id=?`, nodeId);
  if (!node) return null;
  const task = db.one(`SELECT id, title, owner_id, project_id FROM tasks WHERE id=?`, node.task_id);
  const pv = (key) => { const r = db.one(`SELECT value FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC LIMIT 1`, task.id, key); try { return r ? JSON.parse(r.value) : null; } catch { return null; } };
  const reqId = (() => { const r = db.one(`SELECT value FROM params WHERE task_id=? AND key='task.requested_by' AND superseded_at IS NULL ORDER BY recorded_at DESC LIMIT 1`, task.id); try { return r ? JSON.parse(r.value) : null; } catch { return null; } })();
  const edges = db.all(`SELECT to_id FROM edges WHERE from_id=? AND relation='derived_from' AND superseded_at IS NULL ORDER BY id`, nodeId).map((r) => r.to_id);
  let constitutionId = edges.find((id) => /^c_[0-9a-f]+$/.test(id) && db.one(`SELECT 1 FROM constitutions WHERE id=?`, id)) ?? null;
  const refs = edges.map(parseClauseRef).filter(Boolean);
  constitutionId ??= refs[0]?.constitutionId ?? null;
  const all = constitutionId ? clausesOf(db, constitutionId) : [];
  const clauses = refs.filter((r) => r.constitutionId === constitutionId).map((r) => all.find((c) => c.key === r.key)).filter(Boolean);
  const policy = edges.map((id) => /^policy:(\w+)$/.exec(id)?.[1]).find(Boolean) ?? null;
  // 指令：出处边指向的消息 + 挂在本步上的提问的答复（v36 之前的老数据没有步骤 → 答复的边，从提问那头找）
  const seen = new Set();
  const instructions = [];
  const add = (m) => { if (m && !seen.has(m.id)) { seen.add(m.id); instructions.push(m); } };
  for (const id of edges) add(messageBrief(db, id));
  for (const { from_id: mid } of db.all(`SELECT e.from_id FROM questions q JOIN edges e ON e.to_id=q.id AND e.relation='answers' AND e.superseded_at IS NULL
                                         WHERE q.node_id=? ORDER BY e.id`, nodeId)) add(messageBrief(db, mid));
  instructions.sort((a, b) => a.at - b.at);
  const c = constitutionId ? db.one(`SELECT id, version, superseded_at FROM constitutions WHERE id=?`, constitutionId) : null;
  return {
    // autoAdded：项目自动挡里 AI 自己加的任务 —— 契约没有人批，签收在后
    node, task: { id: task.id, title: task.title, owner: userBrief(db, task.owner_id), projectId: task.project_id, autoAdded: pv('task.auto_added') === true },
    // 一个任务可能同时是几个人提的：给数组，没有 → null
    requestedBy: (() => { const xs = (Array.isArray(reqId) ? reqId : reqId ? [reqId] : []).map((id) => userBrief(db, id)).filter(Boolean); return xs.length ? xs : null; })(),
    constitution: c ? { id: c.id, version: c.version, current: c.superseded_at == null, approval: approvalOf(db, c.id), sources: constitutionSources(db, c.id) } : null,
    clauses, instructions, policy: policy ? { id: policy } : null,
  };
}
