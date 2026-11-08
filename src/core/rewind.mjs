// 从这里重来：让一个做完的步骤回到它开始之前，重做它，以及跟着它的那些步骤。
//
// 和修正流水线的分工：修正是"改需求"——模型判影响、改规格、可能要人批；这里需求不变，只是人看了这一步的结果说"不对，重做"。
// 所以这里没有模型、没有确认门：人点之前先看预览（会退回哪些步骤、丢掉多少已花的钱、哪些文件回到旧样子），确认就生效。
//
// 哪些步骤跟着重做（三条，求闭包）：
//   ① 这一步本身；
//   ② 传递地依赖它的、已经动过的步骤（做完 / 待答复 / 失败……；还没开始的本来就要跑，不算）；
//   ③ 任务分支上排在"这一步最后一次提交"之后的提交里的步骤 —— 代码回到那之前，它们的产物也就不在了。
// 代码：工作区回到这一步最后一次提交的父提交（沿第一父链）。这一步没留下提交（没改文件）时代码不动，只重做步骤。
// 不删东西（与修正流水线"放弃不删代码"同一条）：回退前的头，连同工作区里没提交的改动，存在 `refs/superintern/rewound/<id>` 上。
//
// 不许的：任务正在跑（拿不到任务租约 —— 与编排器互斥，先暂停）；已合并进项目分支（要改就添加任务）；
// 已交付（分支推出去了，回退要改写已推送的历史 —— 发修正）；已中止 / 已归档 / 还在规划。权限：任务负责人。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { newId, now, audit, insertEdge } from '../db/db.mjs';
import { insertDecision } from '../db/constitutions.mjs';
import { transition } from '../db/state.mjs';
import { acquireLease, releaseLease, leaseOf, LeaseHeldError } from '../db/lease.mjs';
import { leadOf } from './routing.mjs';
import { nodesForReplan } from './revision.mjs';
import { clearNodeBaseline, setAsideInflight, rewindWorkspace, workspaceStatus } from './workspace.mjs';
import { getParam, writeParam } from './params.mjs';
import { gitRaw } from './git.mjs';
import { recordMessage, markConsumed } from './inbox.mjs';
import { tl, contentLang, I18nError, N_ } from '../i18n/index.mjs';

export const rewoundRef = (id) => `refs/superintern/rewound/${id}`;
const NODE_LINE = /^node: (n_[0-9a-z]+)$/gm;
const UNTOUCHED = new Set(['pending', 'ready', 'void']);   // 还没动过（或已作废）的步骤：不用跟着重做

/** 任务分支上沿第一父链的提交（新 → 旧），带每个提交说明里的 `node: <id>`。 */
function firstParentCommits(dir) {
  const out = gitRaw(dir, ['log', '--first-parent', '--format=%H%x1f%P%x1f%s%x1f%B%x1e', 'HEAD']);
  return out.split('\x1e').map((s) => s.replace(/^\n/, '')).filter((s) => s.trim()).map((rec) => {
    const [sha, parents, subject, body = ''] = rec.split('\x1f');
    return { sha, parents: parents.split(' ').filter(Boolean), subject, nodes: [...body.matchAll(NODE_LINE)].map((m) => m[1]) };
  });
}

/**
 * 预览：从 nodeId 这一步重来会怎样。不写库、不动工作区。
 * → { ok:false, why, params } | { ok:true, head, base, moves, nodes:[{id,title,status,why,microUsd}], commits, merges, files, dirty, questions, signoff, spentMicro }
 */
export function rewindPlan(db, { taskId, nodeId, workspace }) {
  const no = (why, params = {}) => ({ ok: false, why, params });
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
  if (!task) return no(N_('任务不存在：{taskId}'), { taskId });
  if (task.archived_at) return no(N_('任务已归档，请先取消归档'));
  if (task.status === 'aborted') return no(N_('任务已中止：先恢复，再从某一步重来'));
  if (task.status === 'planning') return no(N_('任务还在规划，没有做完的步骤'));
  if (task.merged_at) return no(N_('这个任务已经合并进项目分支，回不去了：要改，在项目里添加任务'));
  if (getParam(db, taskId, 'delivery.head')) return no(N_('这个任务已经交付（分支推出去了），回退会改写已推送的历史：要改，向任务发修正'));
  const nodes = nodesForReplan(db, taskId);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const target = byId.get(nodeId);
  if (!target) return no(N_('步骤不存在：{nodeId}'), { nodeId });
  if (target.status !== 'done') return no(N_('只有做完的步骤能从这里重来（这一步现在是「{status}」）'), { status: target.status });
  if (!workspace || !existsSync(join(workspace, '.git'))) return no(N_('任务工作区不在了，没法回退'));

  let commits;
  try { commits = firstParentCommits(workspace); } catch { return no(N_('读不到这个任务的提交历史')); }
  const head = commits[0]?.sha ?? null;
  const dependents = new Map();
  for (const n of nodes) for (const d of n.deps) { if (!dependents.has(d)) dependents.set(d, []); dependents.get(d).push(n.id); }
  const why = new Map([[target.id, 'target']]);
  let cut = -1;   // 要丢掉的最旧那个提交在 commits 里的下标（commits 新 → 旧）；-1 = 代码不动
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...why.keys()]) for (const d of dependents.get(id) ?? []) {
      if (!why.has(d) && !UNTOUCHED.has(byId.get(d)?.status)) { why.set(d, 'depends'); changed = true; }
    }
    for (const id of why.keys()) { const i = commits.findIndex((c) => c.nodes.includes(id)); if (i > cut) { cut = i; changed = true; } }
    for (const c of commits.slice(0, cut + 1)) for (const id of c.nodes) {
      if (!why.has(id) && byId.has(id) && byId.get(id).status !== 'void') { why.set(id, 'commit'); changed = true; }
    }
  }
  const dropped = commits.slice(0, cut + 1);
  const base = cut >= 0 ? dropped.at(-1).parents[0] ?? null : head;
  if (!base) return no(N_('这一步是工作区里的第一个提交，前面没有可以回去的地方'));
  // 回到旧样子的文件；其中 added 是这几步新建的，回退后就没有了（预览要说清这一点）
  let files = [], added = [];
  if (base !== head) {
    try {
      for (const l of gitRaw(workspace, ['diff', '--name-status', '--no-renames', base, head]).split('\n').filter(Boolean)) {
        const [st, path] = l.split('\t');
        files.push(path); if (st === 'A') added.push(path);
      }
    } catch { files = []; added = []; }
  }
  let dirty = [];
  try { dirty = workspaceStatus(workspace).changed; } catch { /* 读不了就当没有 */ }
  // 被点的那一步排最前，其余按步骤顺序
  const list = nodes.filter((n) => why.has(n.id)).map((n) => ({ id: n.id, title: n.title, status: n.status, why: why.get(n.id), microUsd: n.microUsd }))
    .sort((a, b) => (b.why === 'target') - (a.why === 'target'));
  const ids = list.map((n) => n.id);
  const questions = ids.length ? db.all(`SELECT id, node_id, text FROM questions WHERE task_id=? AND status IN ('open','escalated') AND node_id IN (${ids.map(() => '?').join(',')})`, taskId, ...ids)
    .map((q) => ({ id: q.id, nodeId: q.node_id, text: String(q.text).split('\n').find((l) => l.trim())?.slice(0, 120) ?? '' })) : [];
  const signoff = db.one(`SELECT id FROM questions WHERE task_id=? AND decision_type='signoff' AND status IN ('open','escalated') ORDER BY asked_at DESC LIMIT 1`, taskId);
  return {
    ok: true, taskId, taskStatus: task.status, target: { id: target.id, title: target.title }, head, base, moves: base !== head,
    nodes: list, commits: dropped.map((c) => ({ sha: c.sha, subject: c.subject, merge: c.parents.length > 1 })),
    files, added, dirty, questions, signoff: signoff ? { id: signoff.id, accepted: false } : getParam(db, taskId, 'signoff.status') === 'accepted' ? { id: null, accepted: true } : null,
    spentMicro: list.reduce((s, n) => s + (n.microUsd ?? 0), 0),
  };
}

/**
 * 确认：照预览回退。expectHead = 预览时的头（期间有人提交过 → 拒，重新看预览）。
 * note：人写的"这次注意什么"，重做这一步时原样给执行器（人说的话，记在他名下）。
 */
export function rewindTask(db, { taskId, nodeId, workspace, userId, note = null, expectHead = null, plaintextToken = null, at = now() }) {
  if (leadOf(db, taskId) !== userId) throw new I18nError('只有该任务的负责人能让步骤重来');
  // 与编排器互斥：拿这个任务的租约。拿不到 = 有编排器正在跑它
  let lease;
  try { lease = acquireLease(db, `task:${taskId}`, { meta: { kind: 'rewind', userId } }); }
  catch (e) {
    if (!(e instanceof LeaseHeldError)) throw e;
    // 拿着租约的也可能是项目推进正在合并它：那不是"在跑"，暂停也没用
    const op = (() => { try { return JSON.parse(leaseOf(db, `task:${taskId}`)?.meta ?? '{}').op; } catch { return null; } })();
    throw new I18nError(op === 'merge' ? '不能重来：系统正在把这个任务合并进项目，合并之后就不能再从某一步重来了。要改，在项目页用「添加任务…」新加一个任务' : '任务正在跑：先暂停，等它停下（顶上不再显示在跑）再从这里重来');
  }
  try {
    const plan = rewindPlan(db, { taskId, nodeId, workspace });
    if (!plan.ok) throw new I18nError(plan.why, plan.params);
    if (expectHead && plan.head !== expectHead) throw new I18nError('你看预览之后任务的代码又变了：请重新打开预览再确认');
    const L = contentLang(db);
    const id = newId('rw');
    const ref = rewoundRef(id);
    const memo = (note ?? '').trim().slice(0, 4000) || null;
    // 先动工作区（存好再回退），失败就什么都没改；成功了再一个事务改库
    const ws = rewindWorkspace(workspace, { base: plan.base, ref, message: `superintern: rewind ${id} (redo from ${plan.target.id})` });
    const res = db.tx(() => {
      const t = now();
      for (const n of plan.nodes) {
        setAsideInflight(db, { taskId, nodeId: n.id, why: id });
        transition(db, 'nodes', n.id, 'pending', { set: { retry_count: 0 },
          audit: { action: 'node_rewound', actorKind: 'user', actorId: userId, payload: { rewindId: id, target: plan.target.id, cause: n.why, ref, moved: plan.moves, note: memo } } });
        clearNodeBaseline(db, { taskId, nodeId: n.id });
        const did = insertDecision(db, { taskId, nodeId: n.id,
          summary: n.id === plan.target.id ? tl(L, '人让「{title}」从头重做', { title: n.title }) : tl(L, '「{title}」跟着「{target}」重做', { title: n.title, target: plan.target.title }),
          rationale: [
            n.id === plan.target.id ? null : n.why === 'depends' ? tl(L, '它用到了「{target}」的结果。', { target: plan.target.title }) : tl(L, '它在「{target}」之后做，代码退回时它的改动也跟着没了。', { target: plan.target.title }),
            memo ? tl(L, '人写给 AI 的话：{note}', { note: memo }) : null,
            plan.moves ? tl(L, '工作区回到了 {base}；回退前的代码存在 git 的 {ref} 上，没有删。要取回某个文件，在任务工作区里跑 git show {ref}:<路径>。', { base: plan.base.slice(0, 8), ref }) : tl(L, '这一步没有改过文件，代码没动。'),
          ].filter(Boolean).join('\n'),
          actorKind: 'user', actorId: userId, layer: 'execution', at: t });
        insertEdge(db, did, n.id, 'derived_from', t);
      }
      for (const q of plan.questions) transition(db, 'questions', q.id, 'withdrawn', { set: { resolved_at: t }, audit: { action: 'question_withdrawn', actorKind: 'user', actorId: userId, payload: { via: 'rewind', rewindId: id } } });
      if (plan.signoff?.id) transition(db, 'questions', plan.signoff.id, 'withdrawn', { set: { resolved_at: t }, audit: { action: 'question_withdrawn', actorKind: 'user', actorId: userId, payload: { via: 'rewind', rewindId: id } } });
      if (plan.signoff) { writeParam(db, { taskId, key: 'signoff.status', value: 'void', by: { kind: 'user', id: userId }, governance: 'constitutional' }); audit(db, { actorKind: 'user', actorId: userId, action: 'signoff_voided', targetType: 'task', targetId: taskId, payload: { via: 'rewind', rewindId: id } }); }
      // 任务回到执行：还有挡执行的事项开着 → 等人；人暂停着的照旧暂停
      const task = db.one(`SELECT status FROM tasks WHERE id=?`, taskId);
      let to = task.status;
      if (task.status !== 'suspended') {
        const open = db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND status IN ('open','escalated') AND (decision_type IS NULL OR decision_type<>'signoff')`, taskId).n;
        to = open ? 'waiting' : 'running';
        if (to !== task.status) transition(db, 'tasks', taskId, to, { audit: { action: 'task_rewound_status', actorKind: 'user', actorId: userId, payload: { rewindId: id } } });
      }
      // 出处（I9）：「从这里重来」是人对这几步下的指令 —— 记成一条签了名的消息，每一步挂一条 derived_from 到它
      // （打回轮次也从这里重新数，见 diagnose.roundsOf）。说明本身由装配原样给重做的那一步，所以这条消息不进收件箱、不给别的步骤看
      let messageId = null;
      if (plaintextToken) {
        messageId = recordMessage(db, { taskId, kind: 'context', plaintextToken,
          body: memo ? tl(L, '从「{title}」这一步重来。负责人的说明：{note}', { title: plan.target.title, note: memo }) : tl(L, '从「{title}」这一步重来。', { title: plan.target.title }) }).messageId;
        markConsumed(db, { taskId, ids: [messageId], why: 'rewind' });
        for (const n of plan.nodes) insertEdge(db, n.id, messageId, 'derived_from', t);
      }
      audit(db, { actorKind: 'user', actorId: userId, action: 'task_rewound', targetType: 'task', targetId: taskId,
        payload: { rewindId: id, target: plan.target.id, human: tl(L, '从「{title}」这一步重来，退回 {n} 个步骤', { title: plan.target.title, n: plan.nodes.length }), fromHead: plan.head, toBase: plan.base, ref, snapshot: ws?.sha ?? null, dirty: ws?.dirty ?? [],
          nodes: plan.nodes.map((n) => ({ id: n.id, why: n.why })), commits: plan.commits.map((c) => c.sha), files: plan.files.slice(0, 200), nFiles: plan.files.length, messageId,
          questions: plan.questions.map((q) => q.id), signoff: plan.signoff ? (plan.signoff.accepted ? 'accepted' : 'pending') : null, spentMicro: plan.spentMicro, note: memo, at } });
      return { rewindId: id, ref, taskStatus: to };
    }, { immediate: true });
    return { ...res, plan };
  } finally { releaseLease(db, `task:${taskId}`, lease.epoch); }
}

const WHY = { target: N_('这一步本身'), depends: N_('用到了它的结果'), commit: N_('在它之后做的，改动跟着代码一起回退') };
const usd = (m) => `$${((m ?? 0) / 1e6).toFixed(2)}`;
/** 预览的文字版（命令行用；看板自己画）。lang = 读的人的语言 */
export function describeRewind(plan, lang) {
  const L = [tl(lang, '从「{title}」这一步重来：', { title: plan.target.title })];
  L.push(tl(lang, '- 退回重做的步骤（{n} 个）：', { n: plan.nodes.length }));
  for (const n of plan.nodes) L.push(`    · 「${n.title}」 ${tl(lang, WHY[n.why])}`);
  if (plan.moves) {
    const merges = plan.commits.filter((c) => c.merge).length;
    L.push(tl(lang, '- 代码：工作区回到 {base}，丢掉 {n} 个提交，{files} 个文件回到旧样子。', { base: plan.base.slice(0, 8), n: plan.commits.length, files: plan.files.length })
      + (merges ? tl(lang, '其中 {n} 个是把项目分支合进来的，合并时会再合一次。', { n: merges }) : ''));
    L.push(tl(lang, '  回退前的代码存在 git 上，不删。'));
  } else L.push(tl(lang, '- 代码不动（这一步没有改过文件）。'));
  if (plan.dirty.length) L.push(tl(lang, '- 工作区里还没提交的改动（{n} 个文件）一起存到 git 上，不留在工作区。', { n: plan.dirty.length }));
  if (plan.questions.length) L.push(tl(lang, '- 这几步提的 {n} 条事项还开着，一起撤回。', { n: plan.questions.length }));
  if (plan.signoff) L.push(plan.signoff.accepted ? tl(lang, '- 你已经签收过，签收作废：重做完要重新签收。') : tl(lang, '- 等你签收的那条撤回：重做完重新请你签收。'));
  L.push(tl(lang, '- 这几步已经花了 {usd}，不退；重做还要再花。', { usd: usd(plan.spentMicro) }));
  return L.join('\n');
}

/** 执行器装配用：这一步最近一次是因为「从这里重来」退回的（之后还没做完过）→ 那次的情况；否则 null。 */
export function lastRewind(db, nodeId) {
  const r = db.one(`SELECT action, payload FROM audit_log WHERE target_id=? AND action IN ('node_rewound','node_done') ORDER BY id DESC LIMIT 1`, nodeId);
  if (r?.action !== 'node_rewound') return null;
  let p = {}; try { p = JSON.parse(r.payload ?? '{}'); } catch { /* 坏行 */ }
  const target = p.target ? db.one(`SELECT id, title FROM nodes WHERE id=?`, p.target) : null;
  return { cause: p.cause ?? 'target', ref: p.ref ?? null, moved: p.moved !== false, note: p.note ?? null, target, self: p.target === nodeId };
}
