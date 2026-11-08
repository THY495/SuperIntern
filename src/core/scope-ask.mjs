// 越界写入走批准（"写边界越界触发批准"）。
//
// 原来越界只有一条路：机械校验打回 → 执行器撤销，或 raise_question → 人答复 → 人再发一条修正 → 重规划器出计划变更 →
// 确认门 → 人再批一次 → 节点重做。实际运行里这条路是最常见的停摆源：28 个库里越界打回 33 次、和范围有关的结构矛盾 41 条；
// p03-parallel 的 T12 为了往一个测试文件里追加用例挂了 4 条事项（修正生效后仍被拒，又问两次），v6 的 9 次"重试上限触顶"
// 根因也是越界。人要拍的其实只有一件事："这几个文件让不让它动"。
//
// 现在多一条路：执行器在交接里说明要放进范围的路径与理由（submit_handoff 的 scope_request），系统挂**一条**批准事项
// （方案批准类，按路由表派人，收件人必含负责人）。批准 → 系统机械地把这些路径写进契约的「可动路径」（宪法块升一版，
// 出处挂那条答复），不经重规划器、不重做这一步；执行器复工后原样重交就过。不批 → 执行器撤掉范围外的改动，按答复在现有范围内做。
//
// 三条边界：
//   - **只管"能不能动这个文件"**。改行为规则、验收标准仍是计划变更（人发修正），这里不碰；契约里别的字段一字不动。
//   - **只在越界是唯一的拒收理由时开这条路**。共享路径（并行骨架定的）、项目规则文件、钩子文件各有各的规矩，不走这里。
//   - **申请必须盖住每一处越界**：漏一个路径就退回补齐，不许"批一半"—— 批了以后照样被拒，人会以为批准没生效。

import { tl, contentLang } from '../i18n/index.mjs';
import { markOf } from '../i18n/marks.mjs';
import { now, audit, insertEdge } from '../db/db.mjs';
import { writeConstitution, insertDecision } from '../db/constitutions.mjs';
import { scopePathProblems, normScopePaths, scopePathsOf, prefixesOf, scopeFilesOf, renderScopePaths } from './routing.mjs';
import { coveredBy } from './parallel.mjs';
import { bindApproval } from './provenance.mjs';
import { PRE_HOOKS } from './answers.mjs';
import { record } from './decisions.mjs';
import { reservationOf, readApproval } from '../agent/approval.mjs';
import { gitRaw } from './git.mjs';

export const SCOPE_ASK_RAISED = 'scope_ask_raised';
/** 事项正文里贴多少行改动：超了只给统计和一条自己看的命令（与签收正文的 400 行同一个思路，这里更紧：人只要判"该不该动"）。 */
export const SCOPE_DIFF_MAX_LINES = 150;

const list = (L, xs) => xs.map((p) => `\`${p}\``).join(tl(L, '、'));

/**
 * 执行器填的 scope_request 能不能受理。`out` = 这次交接里范围外的改动（机械校验算出来的）。
 * 返回 { paths, why, errs }：errs 非空就退回给执行器补。
 */
export function checkScopeRequest(req, { out, lang = 'zh' }) {
  const L = lang;
  const errs = [];
  const paths = normScopePaths(Array.isArray(req?.paths) ? req.paths : []);
  const why = String(req?.why ?? '').trim();
  if (!paths.length) errs.push(tl(L, 'scope_request.paths 为空 —— 写出要放进范围的路径（文件写全名，目录以 / 结尾）'));
  for (const p of scopePathProblems(paths)) errs.push(tl(L, 'scope_request.paths：{problem}', { problem: p }));
  if (paths.includes('*')) errs.push(tl(L, 'scope_request.paths 不能是 *（整个仓库）—— 只列这一步确实要动的文件或目录'));
  if (why.length < 10) errs.push(tl(L, 'scope_request.why 要写清为什么这一步必须动这些文件（给批准的人看：不动会怎样、为什么不能在现有范围里做）'));
  const uncovered = out.filter((p) => !coveredBy(p, paths));
  if (uncovered.length) errs.push(tl(L, 'scope_request 没有盖住全部越界改动：{paths} 不在申请的路径里。要么一起申请，要么撤销它们', { paths: list(L, uncovered) }));
  return { paths, why, errs };
}

/** 现在的可动路径（结构化的；老契约从散文里抽的也落成同一个形状），授予时在它上面加。 */
export function currentScopePaths(db, taskId) {
  const structured = scopePathsOf(db, taskId);
  if (structured.length) return structured;
  return normScopePaths([...prefixesOf(db, taskId).map((p) => (p === '*' ? p : `${p}/`)), ...scopeFilesOf(db, taskId)]);
}

/** 范围外那几个文件的改动（相对这一步的基线）。未跟踪的新文件 git diff 看不到，按内容贴前几十行。 */
export function scopeDiff({ workspace, baseRef, paths }) {
  if (!workspace || !baseRef || !paths.length) return { stat: '', diff: '', lines: 0 };
  let untracked = [];
  try { untracked = gitRaw(workspace, ['ls-files', '--others', '--exclude-standard', '--', ...paths]).split('\n').filter(Boolean); } catch { /* 当成都跟踪了 */ }
  const tracked = paths.filter((p) => !untracked.includes(p));
  let stat = '', diff = '';
  try {
    if (tracked.length) {
      stat = gitRaw(workspace, ['diff', '--stat', baseRef, '--', ...tracked]).trimEnd();
      diff = gitRaw(workspace, ['diff', baseRef, '--', ...tracked]).trimEnd();
    }
  } catch { /* 取不到证据不挡事项：人照样能批，正文里说清看不到 */ }
  for (const p of paths.filter((x) => untracked.includes(x))) {
    try {
      const body = gitRaw(workspace, ['diff', '--no-index', '--', '/dev/null', p]);
      diff += `${diff ? '\n' : ''}${body.trimEnd()}`;
    } catch (e) {
      // diff --no-index 有差异时退出码是 1：输出在 stdout 里
      const body = String(e?.stdout ?? '');
      if (body) diff += `${diff ? '\n' : ''}${body.trimEnd()}`;
    }
    stat += `${stat ? '\n' : ''} ${p} | new`;
  }
  return { stat, diff, lines: diff ? diff.split('\n').length : 0 };
}

/** 同一项目里还没合并的别的任务，范围也盖住这些路径的（并行时两边同时改，合并会撞）。 */
function overlapsOf(db, taskId, paths) {
  const t = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId);
  if (!t?.project_id) return [];
  const others = db.all(`SELECT id, title, project_order FROM tasks WHERE project_id=? AND id<>? AND project_order>0 AND merged_at IS NULL AND status<>'aborted' ORDER BY project_order`, t.project_id, taskId);
  const out = [];
  for (const o of others) {
    const theirs = currentScopePaths(db, o.id);
    if (!theirs.length || theirs.includes('*')) continue;
    const hit = paths.filter((p) => coveredBy(p, theirs) || theirs.some((q) => coveredBy(q, [p])));
    const started = !!db.one(`SELECT 1 FROM audit_log WHERE action='workspace_created' AND target_id=? LIMIT 1`, o.id);
    if (hit.length) out.push({ order: o.project_order, title: o.title, paths: hit, started });
  }
  return out;
}

/**
 * 批准事项的正文（系统写，不经模型）。`why` 为 null = 系统替执行器提的（同一条越界拒收连续出现），执行器没说理由。
 */
export function scopeAskText(db, { taskId, nodeId, paths, out, why, workspace = null, baseRef = null }) {
  const L = contentLang(db);
  const task = db.one(`SELECT title FROM tasks WHERE id=?`, taskId);
  const node = nodeId ? db.one(`SELECT title FROM nodes WHERE id=?`, nodeId) : null;
  const cur = currentScopePaths(db, taskId);
  const d = scopeDiff({ workspace, baseRef, paths: out });
  const lines = [markOf(L, 'scopeAsk'),
    tl(L, '任务「{task}」的步骤「{node}」改了契约范围之外的文件。AI 申请把下面这些路径放进这个任务的范围。', { task: task?.title ?? taskId, node: node?.title ?? nodeId ?? '' }), '',
    tl(L, '要放进范围的路径：'), ...paths.map((p) => `  - ${p}`), '',
    tl(L, '这一步在范围外改了：'), ...out.map((p) => `  - ${p}`), '',
    why ? tl(L, 'AI 给的理由（原话）：') : tl(L, 'AI 没有说理由：它连续几次交了同样的越界改动，系统替它提了这条申请。'),
    ...(why ? [`> ${why.replace(/\n/g, '\n> ')}`] : []), '',
    tl(L, '现在的可动路径：{paths}', { paths: renderScopePaths(cur, L) }),
    tl(L, '批准后的可动路径：{paths}', { paths: renderScopePaths(normScopePaths([...cur, ...paths.filter((p) => !coveredBy(p, cur))]), L) })];
  const ov = overlapsOf(db, taskId, paths);
  if (ov.length) {
    lines.push('', tl(L, '⚠ 同一项目里还没合并的这些任务，范围也包括其中的路径：'),
      ...ov.map((o) => tl(L, '  - #{order}「{title}」（{state}）：{paths}', { order: o.order, title: o.title, state: o.started ? tl(L, '已开工') : tl(L, '还没开工'), paths: o.paths.join(tl(L, '、')) })),
      tl(L, '两边都改同一个文件，后合并的那个任务合并时可能冲突；真冲突了会单独来问你选哪边。'));
  }
  lines.push('');
  if (!d.diff && !d.stat) lines.push(tl(L, '（拿不到这一步的改动内容；要看就到任务工作区里 git diff。）'));
  else if (d.lines <= SCOPE_DIFF_MAX_LINES) lines.push(tl(L, '范围外文件的改动：'), '```diff', d.diff || d.stat, '```');
  else lines.push(tl(L, '范围外文件的改动（{n} 行，太长不贴全文）：', { n: d.lines }), '```', d.stat, '```', tl(L, '要看全文：在任务工作区里 git diff {base} -- {paths}', { base: String(baseRef).slice(0, 12), paths: out.join(' ') }));
  lines.push('', tl(L, '请回复：'),
    tl(L, '(A) 批准 —— 回「A」。这些路径写进这个任务契约的「可动路径」（契约升一版，记下是你批的）。这一步的改动原样保留，不再因为越界被拒；这个任务后面的步骤也能改这些路径。'),
    tl(L, '　　批准但想留一句话：先回 A，另起一行写「保留：…」。路径照样放进范围，那句话留在项目的约定清单上，不挡任何东西。'),
    tl(L, '(B) 不批 —— 写一句为什么，或者在现在的可动路径里该怎么做。AI 会撤掉范围外的改动，按你写的做；做不到会再来问你。'),
    '',tl(L, '可动路径只管"能不能动这个文件"，不管怎么改；要改行为规则或验收标准，发一条修正。'));
  return lines.join('\n');
}

/** 这条事项是不是越界申请；是 → { taskId, nodeId, paths, out, why }。 */
export function scopeAskOf(db, questionId) {
  const r = db.one(`SELECT payload FROM audit_log WHERE action=? AND target_type='question' AND target_id=? ORDER BY id DESC LIMIT 1`, SCOPE_ASK_RAISED, questionId);
  if (!r) return null;
  try { return JSON.parse(r.payload); } catch { return null; }
}

/**
 * 批准之后：契约升一版，「可动路径」= 原来的 ∪ 申请的。别的字段原样抄（散文范围后面补一句，让读散文的人也知道）。
 * 出处挂批准的那条答复（I9）；记一条宪法层决策、进项目的约定清单。
 */
export function grantScope(db, { taskId, paths, questionId, messageId = null, userId = null, reservation = null, at = now() }) {
  const L = contentLang(db);
  return db.tx(() => {
    // 同一条事项只批一次：答复层已经不会把已决事项再了结一遍，这里再兜一道 —— 契约升两版是改不回来的历史
    const done = questionId ? db.one(`SELECT payload FROM audit_log WHERE action='scope_granted' AND target_id=? AND json_extract(payload, '$.questionId')=? LIMIT 1`, taskId, questionId) : null;
    if (done) return { constitutionId: JSON.parse(done.payload).constitution, added: [], repeated: true };
    const cur = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);
    const before = currentScopePaths(db, taskId);
    const added = paths.filter((p) => !coveredBy(p, before));
    const next = normScopePaths([...before, ...added]);
    const scope = added.length ? `${cur.scope}${tl(L, '（{date} 批准放进范围：{paths}）', { date: new Date(at).toISOString().slice(0, 10), paths: added.join(tl(L, '、')) })}` : cur.scope;
    const cid = writeConstitution(db, { taskId, version: cur.version + 1, supersedes: cur.id, at,
      goal: cur.goal, scope, scopePaths: next, definitionOfDone: cur.definition_of_done, constraints: JSON.parse(cur.constraints || '[]') });
    insertEdge(db, cid, cur.id, 'supersedes', at);
    if (messageId) insertEdge(db, cid, messageId, 'derived_from', at);
    bindApproval(db, { constitutionId: cid, messageId, userId, at });
    const did = insertDecision(db, { taskId, summary: tl(L, '宪法块修订至 v{version}', { version: cur.version + 1 }),
      rationale: tl(L, '批准越界申请 {q}：可动路径加上 {paths}', { q: questionId, paths: added.join(tl(L, '、')) || tl(L, '（已在范围内）') }), actorKind: 'user', actorId: userId, layer: 'constitutional', at });
    if (messageId) insertEdge(db, did, messageId, 'derived_from', at);
    try {
      const title = db.one(`SELECT title FROM tasks WHERE id=?`, taskId)?.title ?? '';
      record(db, { projectId: db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null, taskId,
        subject: tl(L, '{title}｜可动路径', { title }), statement: tl(L, '{paths}（批准越界申请时放进：{added}）', { paths: next.join(tl(L, '、')), added: added.join(tl(L, '、')) || tl(L, '（已在范围内）') }),
        sourceKind: 'contract', sourceId: cid, decidedBy: userId, at });
    } catch (e) { audit(db, { actorKind: 'system', action: 'decision_register_failed', targetType: 'task', targetId: taskId, payload: { error: e.message, kind: 'scope_grant' } }); }
    audit(db, { actorKind: 'user', actorId: userId, action: 'scope_granted', targetType: 'task', targetId: taskId,
      payload: { questionId, paths, added, constitution: cid, version: cur.version + 1, reservation: reservation ? String(reservation).slice(0, 200) : null } });
    return { constitutionId: cid, added, scopePaths: next };
  });
}

// 答复够数 → 在这里落地。按事项认领（PRE_HOOKS），所以不会再登记成一条"答复"约定、也不走方案批准类的别的钩子。
PRE_HOOKS.push((db, { question, finalBody, by, messageId, at }) => {
  if (question.decision_type !== 'contract_approval') return null;
  const ask = scopeAskOf(db, question.id);
  if (!ask) return null;
  const verdict = readApproval(db, { taskId: question.task_id, questionId: question.id, body: finalBody, userId: by, kind: 'scope' });
  if (verdict === 'approve') {
    const g = grantScope(db, { taskId: question.task_id, paths: ask.paths, questionId: question.id, messageId, userId: by, reservation: reservationOf(finalBody), at });
    return { scope: 'granted', ...g };
  }
  audit(db, { actorKind: 'user', actorId: by, action: 'scope_declined', targetType: 'task', targetId: question.task_id,
    payload: { questionId: question.id, paths: ask.paths, body: String(finalBody).slice(0, 300) } });
  return { scope: 'declined' };
});

