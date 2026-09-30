// 交接：把一个人名下**还没了结**的责任交给另一个人。换负责人、成员转岗、停用成员走的是同一条路。
//
// 三条边界：
//   - **只影响未来**：已答的答复、已签收的记录、审计、已结束的项目与任务的归属，一律不动（与"迟到的异议只留痕、不改结论"同一原则）。
//     还开着、但交出方已经答过的事项也不转 —— 他那一票已经投了，换成接手人会把这一票从人头里抹掉。
//   - **冲突事项不转立场**：交出方是当事一方、且还在双方商量阶段的冲突事项，直接转下一行（负责人裁定）；接手人没有那个立场。
//   - **预览 = 执行**：预览就是在一个事务里真做一遍再回滚，所以预览列出的每一项与执行时一字不差，校验（路由表、法定人数）也是同一份。
//
// 范围：{ project: <id> } 一个项目 / { soloTasks: true } 不属于项目的任务（路由键 ''）/ { all: true } 这个人的全部（停用前用）。
// 谁能做：管理员可直接执行任意交接（对不是自己负责的项目，这是他唯一的应急权）；项目负责人可直接执行本项目范围内的交接；
// 其余人只能对自己发起申请（handover_requests）：项目范围由该项目负责人批准（管理员也可），其余范围由管理员批准。
// 交接只换归属，不动角色：负责人是资源级身份，与是不是管理员无关。
//
// 本文件不 import users.mjs / digest.mjs（它们反过来依赖这里）。

import { newId, now, audit } from '../db/db.mjs';
import { validateRules, leadOf, advanceRoute, QUORUM_ALL, DECISION_TYPES } from './routing.mjs';
import { tl, contentLang, I18nError } from '../i18n/index.mjs';

const OPEN_PROJECT = `('proposed','active','stalled')`;
const ENDED_TASK = `('done','aborted')`;
const DRY = Symbol('handover-dry-run');

export function normScope(scope) {
  if (scope?.project) return { kind: 'project', project: String(scope.project) };
  if (scope?.soloTasks) return { kind: 'solo' };
  if (scope?.all) return { kind: 'all' };
  throw new I18nError('交接范围无效：应为某个项目、不属于项目的任务或全部');
}
// 范围的说法按内容语言写（它进交接清单、报错与通知正文）
export const scopeText = (db, scope) => {
  const s = normScope(scope);
  const L = contentLang(db);
  if (s.kind === 'project') return tl(L, '项目「{title}」', { title: db.one(`SELECT title FROM projects WHERE id=?`, s.project)?.title ?? s.project });
  return s.kind === 'solo' ? tl(L, '不属于项目的任务') : tl(L, '全部');
};

const userRow = (db, id) => db.one(`SELECT id, display_name, role, disabled_at FROM users WHERE id=?`, id);
const swap = (list, from, to) => [...new Set(list.map((x) => (x === from ? to : x)))];
const oneLine = (s, n = 80) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * 一个人在某范围内还没了结的责任（纯读）。交接按这份清单逐项处理；停用 / 降为旁观者前用它判断"名下还有没有事"。
 */
export function responsibilitiesOf(db, userId, scope = { all: true }) {
  const s = normScope(scope);
  const inKey = (key) => s.kind === 'all' || (s.kind === 'project' ? key === s.project : key === '');
  const projects = s.kind === 'solo' ? [] : db.all(`SELECT id, title, status FROM projects WHERE owner_id=? AND status IN ${OPEN_PROJECT} ${s.kind === 'project' ? 'AND id=?' : ''} ORDER BY created_at`,
    ...[userId, ...(s.kind === 'project' ? [s.project] : [])]);
  const soloTasks = s.kind === 'project' ? [] : db.all(`SELECT id, title, status FROM tasks t WHERE owner_id=? AND project_id IS NULL
      AND (status NOT IN ${ENDED_TASK} OR EXISTS (SELECT 1 FROM questions q WHERE q.task_id=t.id AND q.status IN ('open','escalated'))) ORDER BY created_at`, userId);
  const names = [`user:${userId}`, `inform:user:${userId}`];
  const routing = db.all(`SELECT id, project_id, decision_type, scope, position, recipients FROM routing_rules ORDER BY project_id, decision_type, scope, position`)
    .filter((r) => inKey(r.project_id)).map((r) => ({ ...r, recipients: JSON.parse(r.recipients || '[]') }))
    .filter((r) => r.recipients.some((x) => names.includes(x)));
  const bindings = db.all(`SELECT project_id, bindings FROM routing_profiles`).filter((r) => inKey(r.project_id))
    .map((r) => ({ key: r.project_id, placeholders: Object.entries(JSON.parse(r.bindings || '{}')).filter(([, v]) => v === userId).map(([k]) => k) })).filter((r) => r.placeholders.length);
  const duty = db.all(`SELECT project_id, users FROM duty_calendar`).filter((r) => inKey(r.project_id))
    .map((r) => ({ key: r.project_id, users: JSON.parse(r.users || '[]') })).filter((r) => r.users.includes(userId));
  const questions = db.all(`SELECT q.*, t.title AS task_title, t.project_id FROM questions q JOIN tasks t ON t.id=q.task_id WHERE q.status IN ('open','escalated') ORDER BY q.asked_at`)
    .filter((q) => inKey(q.project_id ?? ''))
    .map((q) => ({ ...q, to: JSON.parse(q.addressed_to || '[]'), inf: JSON.parse(q.informed || '[]'), routeObj: q.route ? JSON.parse(q.route) : null }))
    .filter((q) => q.to.includes(userId) || q.inf.includes(userId));
  const count = projects.length + soloTasks.length + routing.length + bindings.length + duty.length + questions.length;
  return { projects, soloTasks, routing, bindings, duty, questions, count };
}

/** 一句话清点（报错与界面共用）。lang：内容语言（调用方传 contentLang(db)）。 */
export function responsibilitiesText(r, lang = 'zh') {
  const parts = [];
  if (r.projects.length) parts.push(tl(lang, '负责 {n} 个进行中的项目', { n: r.projects.length }));
  if (r.soloTasks.length) parts.push(tl(lang, '负责 {n} 个不属于项目的任务', { n: r.soloTasks.length }));
  if (r.routing.length) parts.push(tl(lang, '是 {n} 行决策路由的接收人', { n: r.routing.length }));
  if (r.duty.length) parts.push(tl(lang, '在 {n} 张值班表中', { n: r.duty.length }));
  if (r.questions.length) parts.push(tl(lang, '有 {n} 条相关待决事项', { n: r.questions.length }));
  if (r.bindings.length && !r.routing.length) parts.push(tl(lang, '绑定了 {n} 个模板占位符', { n: r.bindings.length }));
  return parts.join(tl(lang, '、'));
}

// 真做一遍（调用方开事务）。返回逐项清单。
function apply(db, { fromUserId, toUserId, scope, note = null, byUserId, thenDisable = false, allowQuorumDrop = false, requestId = null, at = now() }) {
  const s = normScope(scope);
  const from = userRow(db, fromUserId), to = userRow(db, toUserId);
  if (!from) throw new I18nError('成员不存在：{id}', { id: fromUserId });
  if (!to) throw new I18nError('成员不存在：{id}', { id: toUserId });
  if (from.id === to.id) throw new I18nError('交出方与接手人不能是同一人');
  if (to.disabled_at) throw new I18nError('{name} 已停用，不能接手', { name: to.display_name });
  if (to.role === 'observer') throw new I18nError('{name} 是旁观者，不能接手；请先将其角色改为成员', { name: to.display_name });
  if (s.kind === 'project' && !db.one(`SELECT id FROM projects WHERE id=?`, s.project)) throw new I18nError('项目不存在：{id}', { id: s.project });
  if (thenDisable && s.kind !== 'all') throw new I18nError('选择「交接后停用」时，范围必须为「全部」');
  const L = contentLang(db);

  const resp = responsibilitiesOf(db, from.id, scope);
  const ch = { from: { id: from.id, name: from.display_name }, to: { id: to.id, name: to.display_name }, scope: s, scopeText: scopeText(db, scope), note: note ? String(note).slice(0, 2000) : null,
    projects: [], soloTasks: [], routing: [], bindings: [], duty: [], transferred: [], escalated: [], kept: [], informed: [], quorumDrops: [],
    disabled: false, tokensRevoked: 0, warnings: [], projectTitles: Object.fromEntries(db.all(`SELECT id, title FROM projects`).map((p) => [p.id, p.title])), names: Object.fromEntries(db.all(`SELECT id, display_name FROM users`).map((u) => [u.id, u.display_name])) };

  // ① 归属
  for (const p of resp.projects) {
    db.run(`UPDATE projects SET owner_id=? WHERE id=?`, to.id, p.id);
    db.run(`UPDATE tasks SET owner_id=? WHERE project_id=? AND owner_id=? AND status NOT IN ${ENDED_TASK}`, to.id, p.id, from.id);
    ch.projects.push({ id: p.id, title: p.title, status: p.status });
  }
  for (const t of resp.soloTasks) {
    db.run(`UPDATE tasks SET owner_id=? WHERE id=?`, to.id, t.id);
    ch.soloTasks.push({ id: t.id, title: t.title, status: t.status });
  }

  // ② 路由表（原地改收件人，不换行 id）+ 模板占位绑定
  const keys = [...new Set([...resp.routing.map((r) => r.project_id), ...resp.bindings.map((b) => b.key)])];
  for (const r of resp.routing) {
    let next = [...new Set(r.recipients.map((x) => (x === `user:${from.id}` ? `user:${to.id}` : x === `inform:user:${from.id}` ? `inform:user:${to.id}` : x)))];
    if (next.includes(`user:${to.id}`)) next = next.filter((x) => x !== `inform:user:${to.id}`);
    db.run(`UPDATE routing_rules SET recipients=? WHERE id=?`, JSON.stringify(next), r.id);
    ch.routing.push({ key: r.project_id, decisionType: r.decision_type, label: DECISION_TYPES[r.decision_type]?.label ?? r.decision_type, scope: r.scope, position: r.position,
      before: r.recipients, after: next, merged: next.length < r.recipients.length });
  }
  for (const b of resp.bindings) {
    const row = db.one(`SELECT bindings FROM routing_profiles WHERE project_id=?`, b.key);
    const obj = JSON.parse(row.bindings || '{}');
    for (const k of b.placeholders) obj[k] = to.id;
    db.run(`UPDATE routing_profiles SET bindings=?, updated_at=? WHERE project_id=?`, JSON.stringify(obj), at, b.key);
    ch.bindings.push(b);
  }
  for (const key of keys) {
    const rules = db.all(`SELECT * FROM routing_rules WHERE project_id=? ORDER BY decision_type, scope, position`, key).map((r) => ({ ...r, recipients: JSON.parse(r.recipients || '[]') }));
    if (!rules.length) continue;
    const errs = validateRules(db, key, rules);
    if (errs.length) {
      const list = errs.map((x) => `  - ${x.msg}`).join('\n');
      throw key ? new I18nError('交接后项目「{title}」的决策路由无法通过校验，请先调整决策路由：\n{list}', { title: db.one(`SELECT title FROM projects WHERE id=?`, key)?.title ?? key, list })
        : new I18nError('交接后默认决策路由无法通过校验，请先调整决策路由：\n{list}', { list });
    }
  }

  // ③ 值班表
  for (const d of resp.duty) {
    const next = d.users.includes(to.id) ? d.users.filter((u) => u !== from.id) : d.users.map((u) => (u === from.id ? to.id : u));
    db.run(`UPDATE duty_calendar SET users=?, updated_at=? WHERE project_id=?`, JSON.stringify(next), at, d.key);
    ch.duty.push({ key: d.key, before: d.users, after: next, merged: next.length < d.users.length });
  }

  // ④ 还开着的事项
  for (const q of resp.questions) {
    const brief = { id: q.id, taskId: q.task_id, taskTitle: q.task_title, label: DECISION_TYPES[q.decision_type]?.label ?? q.decision_type ?? tl(L, '事项'), text: oneLine(q.text) };
    if (!q.to.includes(from.id)) {            // 只是知会
      const inf = swap(q.inf, from.id, to.id).filter((u) => !q.to.includes(u));
      db.run(`UPDATE questions SET informed=? WHERE id=?`, JSON.stringify(inf), q.id);
      ch.informed.push(brief); continue;
    }
    if (db.one(`SELECT 1 FROM answers WHERE question_id=? AND user_id=? AND stance='answer'`, q.id, from.id)) { ch.kept.push(brief); continue; }
    const route = q.routeObj;
    if (q.decision_type === 'conflict' && (route?.parties ?? []).includes(from.id) && (route?.stage ?? 0) === 0) {
      const adv = advanceRoute(db, { questionId: q.id, at });
      let toWhom = adv?.answerers ?? null;
      if (!toWhom?.length) {                  // 表里没有下一行：直接给负责人
        const lead = leadOf(db, q.task_id);
        toWhom = lead ? [lead] : [];
        if (route?.rows) for (const r of route.rows) { r.recipients = toWhom; r.quorum = '1'; }
        db.run(`UPDATE questions SET addressed_to=?, route=?, route_due_at=NULL WHERE id=?`, JSON.stringify(toWhom), route ? JSON.stringify(route) : q.route, q.id);
      }
      db.run(`UPDATE questions SET notified_at=NULL WHERE id=?`, q.id);
      audit(db, { actorKind: 'user', actorId: byUserId, action: 'conflict_escalated', targetType: 'question', targetId: q.id, payload: { why: tl(L, '冲突方交接'), party: from.id, to: toWhom } });
      ch.escalated.push({ ...brief, to: toWhom }); continue;
    }
    const nextTo = swap(q.to, from.id, to.id);
    let dropped = null;
    if (route?.rows) {
      for (const r of route.rows) {
        r.recipients = swap(r.recipients ?? [], from.id, to.id);
        const need = r.quorum === QUORUM_ALL ? null : Number(r.quorum);
        if (need !== null && r.recipients.length && need > r.recipients.length) {
          dropped = { from: need, to: r.recipients.length };
          r.quorum = String(r.recipients.length); r.quorum_lowered_by = byUserId;
        }
      }
      route.handed_over = true;
    }
    const inf = q.inf.filter((u) => !nextTo.includes(u));
    db.run(`UPDATE questions SET addressed_to=?, informed=?, route=?, notified_at=NULL WHERE id=?`, JSON.stringify(nextTo), JSON.stringify(inf), route ? JSON.stringify(route) : q.route, q.id);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'question_transferred', targetType: 'question', targetId: q.id, payload: { from: q.to, to: nextTo, via: 'handover', quorum: dropped } });
    if (dropped) ch.quorumDrops.push({ ...brief, ...dropped });
    ch.transferred.push({ ...brief, merged: nextTo.length < q.to.length });
  }
  if (ch.quorumDrops.length) ch.warnings.push(tl(L, '{n} 条事项的接手人已是接收人，合并后接收人数少于法定人数；执行后这些事项的法定人数将降为实际人数', { n: ch.quorumDrops.length }));
  if (ch.kept.length) ch.warnings.push(tl(L, '{n} 条事项 {name} 已答复、仍在等待其他人，不作变更', { n: ch.kept.length, name: from.display_name }));

  // ⑤ 停用
  if (thenDisable) {
    const left = responsibilitiesOf(db, from.id, { all: true });
    const blocking = left.count - left.questions.filter((q) => ch.kept.some((k) => k.id === q.id)).length;
    if (blocking > 0) throw new I18nError('交接后 {name} 仍有未结职责（{what}），未执行停用', { name: from.display_name, what: responsibilitiesText(left, L) });
    ch.tokensRevoked = doDisable(db, { user: from, at });
    ch.disabled = true;
  }

  ch.empty = !(ch.projects.length + ch.soloTasks.length + ch.routing.length + ch.bindings.length + ch.duty.length + ch.transferred.length + ch.escalated.length + ch.informed.length) && !ch.disabled;
  if (ch.quorumDrops.length && !allowQuorumDrop) ch.needsQuorumConfirm = true;
  return ch;
}

function doDisable(db, { user, at }) {
  const n = db.run(`UPDATE tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, at, user.id).changes;
  db.run(`UPDATE users SET disabled_at=? WHERE id=?`, at, user.id);
  return Number(n);
}

// denied：拒绝时抛的报错（按动作各写一句，英文才翻得通）
const requireLeadRole = (db, byUserId, denied) => {
  const by = userRow(db, byUserId);
  if (!by || by.disabled_at || by.role !== 'lead') throw denied();
  return by;
};

/** 谁能直接执行 / 批准某个范围的交接：管理员恒可；项目范围另加该项目的负责人。 */
export function canDecideHandover(db, { byUserId, scope }) {
  const by = userRow(db, byUserId);
  if (!by || by.disabled_at) return false;
  if (by.role === 'lead') return true;
  const s = normScope(scope);
  return s.kind === 'project' && db.one(`SELECT owner_id FROM projects WHERE id=?`, s.project)?.owner_id === by.id;
}
const deciderText = (scope, lang = 'zh') => (normScope(scope).kind === 'project' ? tl(lang, '该项目的负责人或管理员') : tl(lang, '管理员'));
/** 给界面：这条申请谁能批，带上负责人的名字。 */
export function approverText(db, scope) {
  const s = normScope(scope);
  const L = contentLang(db);
  if (s.kind !== 'project') return tl(L, '管理员');
  const o = db.one(`SELECT u.display_name AS n FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=?`, s.project);
  return o ? tl(L, '该项目的负责人（{name}）或管理员', { name: o.n }) : tl(L, '管理员');
}

/** 预览：真做一遍再回滚。任何人都能看自己的；看别人的要有该范围的执行权。 */
export function previewHandover(db, opts) {
  const by = userRow(db, opts.byUserId);
  if (!by || by.disabled_at) throw new I18nError('成员不存在或已停用');
  const can = canDecideHandover(db, { byUserId: by.id, scope: opts.scope });
  if (!can && by.id !== opts.fromUserId) throw new I18nError('只能预览自己的交接');
  let out = null;
  try {
    db.tx(() => { out = apply(db, { ...opts, allowQuorumDrop: true }); throw DRY; }, { immediate: true });
  } catch (e) { if (e !== DRY) throw e; }
  if (out.quorumDrops.length) out.needsQuorumConfirm = true;
  out.needsApproval = !can;
  out.approver = deciderText(opts.scope, contentLang(db));
  return out;
}

/** 执行（管理员，或项目范围内该项目的负责人）。法定人数会降而没带 allowQuorumDrop → 拒，让人先看预览。 */
export function executeHandover(db, opts) {
  if (!canDecideHandover(db, { byUserId: opts.byUserId, scope: opts.scope })) {
    throw normScope(opts.scope).kind === 'project' ? new I18nError('只有该项目的负责人或管理员能直接执行此交接；你可以提交交接申请') : new I18nError('只有管理员能直接执行此交接；你可以提交交接申请');
  }
  return db.tx(() => {
    const ch = apply(db, opts);
    if (ch.needsQuorumConfirm) throw new I18nError('{n} 条事项的法定人数将因接收人合并而降低（{list}）。如确认，请勾选「允许降低法定人数」后重新执行', { n: ch.quorumDrops.length, list: ch.quorumDrops.map((x) => `${x.id}：${x.from}→${x.to}`).join('、') });
    if (ch.empty) throw new I18nError('{name} 在{scope}范围内没有需要交接的内容', { name: ch.from.name, scope: ch.scopeText });
    audit(db, { actorKind: 'user', actorId: opts.byUserId, action: 'handover_executed', targetType: 'user', targetId: opts.fromUserId, payload: slim(ch, opts.requestId ?? null) });
    return ch;
  }, { immediate: true });
}
const slim = (ch, requestId) => ({ requestId, from: ch.from.id, to: ch.to.id, scope: ch.scope, note: ch.note, disabled: ch.disabled, tokensRevoked: ch.tokensRevoked,
  projects: ch.projects.map((x) => x.id), soloTasks: ch.soloTasks.map((x) => x.id), routing: ch.routing.map((r) => ({ key: r.key, type: r.decisionType, scope: r.scope, position: r.position, before: r.before, after: r.after })),
  bindings: ch.bindings, duty: ch.duty, transferred: ch.transferred.map((x) => x.id), escalated: ch.escalated.map((x) => x.id), kept: ch.kept.map((x) => x.id), informed: ch.informed.map((x) => x.id), quorumDrops: ch.quorumDrops.map((x) => ({ id: x.id, from: x.from, to: x.to })) });

// ── 成员发起的申请 ────────────────────────────────────────────────────────
export function requestHandover(db, { fromUserId, toUserId, scope, note = null, thenDisable = false, byUserId, at = now() }) {
  if (byUserId !== fromUserId) throw new I18nError('只能申请交接自己的职责');
  const pv = previewHandover(db, { fromUserId, toUserId, scope, note, thenDisable, byUserId });   // 走一遍校验；接手人不合适 / 路由校验不过在这里就报
  if (pv.empty) throw new I18nError('你在{scope}范围内没有需要交接的内容', { scope: pv.scopeText });
  if (db.one(`SELECT id FROM handover_requests WHERE from_user=? AND status='open'`, fromUserId)) throw new I18nError('你已有一条待批准的交接申请，请先撤回后再提交');
  const id = newId('hr');
  db.tx(() => {
    db.run(`INSERT INTO handover_requests (id,from_user,to_user,scope,note,then_disable,status,requested_by,requested_at) VALUES (?,?,?,?,?,?,'open',?,?)`,
      id, fromUserId, toUserId, JSON.stringify(scope), note ? String(note).slice(0, 2000) : null, thenDisable ? 1 : 0, byUserId, at);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'handover_requested', targetType: 'user', targetId: fromUserId, payload: { requestId: id, to: toUserId, scope: normScope(scope), thenDisable: !!thenDisable } });
  });
  return { requestId: id, preview: pv };
}

export function listHandoverRequests(db, { status = 'open' } = {}) {
  const names = Object.fromEntries(db.all(`SELECT id, display_name FROM users`).map((u) => [u.id, u.display_name]));
  return db.all(`SELECT * FROM handover_requests ${status ? 'WHERE status=?' : ''} ORDER BY requested_at DESC LIMIT 100`, ...(status ? [status] : []))
    .map((r) => { const scope = JSON.parse(r.scope); return { id: r.id, fromUserId: r.from_user, fromName: names[r.from_user] ?? r.from_user, toUserId: r.to_user, toName: names[r.to_user] ?? r.to_user,
      scope, scopeText: scopeText(db, scope), approver: approverText(db, scope), note: r.note, thenDisable: !!r.then_disable, status: r.status, requestedAt: r.requested_at, decidedBy: r.decided_by, decidedAt: r.decided_at, decideNote: r.decide_note }; });
}

/** 批准（= 立刻执行）/ 驳回：项目范围 = 该项目负责人或管理员，其余范围 = 管理员；撤回：申请人自己。 */
export function decideHandoverRequest(db, { requestId, decision, byUserId, note = null, allowQuorumDrop = false, at = now() }) {
  if (!['approve', 'reject', 'withdraw'].includes(decision)) throw new I18nError('decision 无效：{decision}（应为 approve / reject / withdraw）', { decision });
  return db.tx(() => {
    const r = db.one(`SELECT * FROM handover_requests WHERE id=?`, requestId);
    if (!r) throw new I18nError('交接申请不存在：{id}', { id: requestId });
    if (r.status !== 'open') {
      throw ({ approved: () => new I18nError('该交接申请已批准'), rejected: () => new I18nError('该交接申请已驳回'), withdrawn: () => new I18nError('该交接申请已撤回') }[r.status]
        ?? (() => new Error(`该交接申请已${{ approved: '批准', rejected: '驳回', withdrawn: '撤回' }[r.status]}`)))();
    }
    if (decision === 'withdraw') { if (byUserId !== r.from_user) throw new I18nError('只有申请人能撤回'); } else if (!canDecideHandover(db, { byUserId, scope: JSON.parse(r.scope) })) {
      throw normScope(JSON.parse(r.scope)).kind === 'project' ? new I18nError('只有该项目的负责人或管理员能批准或驳回此交接申请') : new I18nError('只有管理员能批准或驳回此交接申请');
    }
    let ch = null;
    if (decision === 'approve') {
      ch = apply(db, { fromUserId: r.from_user, toUserId: r.to_user, scope: JSON.parse(r.scope), note: r.note, thenDisable: !!r.then_disable, byUserId, allowQuorumDrop, requestId, at });
      if (ch.needsQuorumConfirm) throw new I18nError('{n} 条事项的法定人数将因接收人合并而降低。如确认，请勾选「允许降低法定人数」后重新批准', { n: ch.quorumDrops.length });
      audit(db, { actorKind: 'user', actorId: byUserId, action: 'handover_executed', targetType: 'user', targetId: r.from_user, payload: slim(ch, requestId) });
    }
    const status = { approve: 'approved', reject: 'rejected', withdraw: 'withdrawn' }[decision];
    db.run(`UPDATE handover_requests SET status=?, decided_by=?, decided_at=?, decide_note=? WHERE id=?`, status, byUserId, at, note ? String(note).slice(0, 1000) : null, requestId);
    audit(db, { actorKind: 'user', actorId: byUserId, action: `handover_${status}`, targetType: 'user', targetId: r.from_user, payload: { requestId, note: note ? String(note).slice(0, 300) : null } });
    return { requestId, status, changes: ch };
  }, { immediate: true });
}

// ── 停用 / 恢复 ───────────────────────────────────────────────────────────
/** 名下没有未了结的责任才停用；有就报出清单，让人先交接（handover --all --disable 一步做完）。 */
export function disableUser(db, { userId, byUserId, at = now() }) {
  requireLeadRole(db, byUserId, () => new I18nError('只有管理员能停用成员'));
  return db.tx(() => {
    const u = userRow(db, userId);
    if (!u) throw new I18nError('成员不存在：{id}', { id: userId });
    if (u.disabled_at) throw new I18nError('{name} 已停用', { name: u.display_name });
    if (u.role === 'lead' && !db.one(`SELECT id FROM users WHERE role='lead' AND disabled_at IS NULL AND id<>?`, userId)) throw new I18nError('不能停用最后一位管理员');
    const left = responsibilitiesOf(db, userId, { all: true });
    const mine = left.questions.filter((q) => !db.one(`SELECT 1 FROM answers WHERE question_id=? AND user_id=? AND stance='answer'`, q.id, userId));
    if (left.count - (left.questions.length - mine.length) > 0) {
      const e = new I18nError('{name} 仍有未结职责：{what}。请先交接（范围选「全部」，并勾选「交接后停用」）', { name: u.display_name, what: responsibilitiesText({ ...left, questions: mine }, contentLang(db)) });
      e.needsHandover = true; throw e;
    }
    const n = doDisable(db, { user: u, at });
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_disabled', targetType: 'user', targetId: userId, payload: { tokensRevoked: n } });
    return { userId, tokensRevoked: n };
  }, { immediate: true });
}

/** 恢复：只清停用标记。令牌在停用时已全部吊销，要另外重发。 */
export function enableUser(db, { userId, byUserId }) {
  requireLeadRole(db, byUserId, () => new I18nError('只有管理员能启用成员'));
  const u = userRow(db, userId);
  if (!u) throw new I18nError('成员不存在：{id}', { id: userId });
  if (!u.disabled_at) throw new I18nError('{name} 未停用，无需启用', { name: u.display_name });
  db.tx(() => {
    db.run(`UPDATE users SET disabled_at=NULL WHERE id=?`, userId);
    audit(db, { actorKind: 'user', actorId: byUserId, action: 'user_enabled', targetType: 'user', targetId: userId, payload: {} });
  });
  return { userId };
}
