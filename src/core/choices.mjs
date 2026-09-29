// AI 替人定的事，按领域交给那个领域的人过目。
//
// 执行 AI 在规格没写的地方常常自己拍板（settled_by_me：例如优先级中文叫"低 / 中 / 高"、POST 返回 201、
// 未知优先级排最后、uvicorn 不进依赖清单……）。若这些只进汇报里的"强制披露"一节 —— 签收人是负责人，
// 管界面的成员可能整场 0 条事项，路由给她的"规格取舍"一次都不出现。协作要的是"每个角色在自己的领域做过决定"，
// 而这些正是该她 / 他定的事。
//
// 做法：任务做完时，把这一轮新出现的 settled_by_me 按主题分两堆 ——
//   依赖 / 构建 / 仓库结构 / 启动方式 → 结构矛盾（structural）那一行的人；其余（界面、接口行为、业务规则）→ 规格取舍（spec_choice）
// —— 每堆合成**一条**事项（不是一条一件，否则事项数翻倍），走项目的路由表。
//   · Ⅱ 级、带默认"沿用 AI 的选择"：不挡签收、不挡合并；没人答就在超时后按默认了结。
//   · 回 A / 都行 → 这几件记进项目的约定清单（署答复人的名）。
//   · 写要改什么 → 替答复人「添加任务」去改（合没合并都一样，不重开这个任务；排队规则照旧；答复人不必有添加权限 ——
//     这条事项是负责人的路由表派给他的，答复本身就是授权的入口）。项目外的旧式独立任务仍转修正。
//   · 以「说明：」开头 → 只记下来，不引出任何改动（否则一句"这条摘的是旧说法"会被当成要改，把等签收的任务重开）。
// 只收 settled_by_me：own_artifact / 弱凭据那几种是"验证不充分"，该签收人看，不是某个领域的人该拍的板。

import { newId, now, audit, insertEdge } from '../db/db.mjs';
import { getParam, setParam } from './params.mjs';
import { routeQuestion, leadOf } from './routing.mjs';
import { timeoutFor } from './timeouts.mjs';
import { record } from './decisions.mjs';

export const CHOICES_MARK = '【AI 替你定了几件事】';
const REVIEWED_KEY = 'task.choices_reviewed';
const MAX_ITEMS = 8;
const BY = { kind: 'agent', id: 'choices' };

// 依赖 / 构建 / 仓库结构 / 启动方式：这些是写代码的人的领域
const STRUCT_RE = /依赖|requirements|package\.json|pyproject|lockfile|lock 文件|gitignore|\bdist\b|构建|打包|目录结构|仓库结构|uvicorn|\bpip\b|\bnpm\b|\bvenv\b|node_modules|测试框架|pytest|vitest|jest|启动命令|端口|\bport\b|si-preview|\bbuild\b|\bdeps?\b|dependency|migration|迁移|数据库文件|\.db\b|sqlite/i;
export const domainOf = (a) => (STRUCT_RE.test(`${a.subject_key}\n${a.statement}`) ? 'structural' : 'spec_choice');
// 提到的顶层目录 → 路由表的范围前缀（frontend/ 的规格取舍可以派给管界面的人）
const prefixesIn = (text) => [...new Set([...String(text).matchAll(/(?:^|[\s`'"（(])((?:frontend|backend|client|server|web|api|ui|app)\/)/gi)].map((m) => m[1].toLowerCase().replace(/\/+$/, '')))];

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/**
 * 任务做完时调用：这一轮新出现的 AI 自选项，按领域各挂一条过目事项。返回挂出的 [{ questionId, domain, count }]。
 * 幂等：挂过的假设记在 task.choices_reviewed，重做之后只挂新的。
 */
export function raiseChoiceReviews(db, { taskId, at = now() }) {
  const task = db.one(`SELECT id, title FROM tasks WHERE id=?`, taskId);
  if (!task) return [];
  const seen = new Set(getParam(db, taskId, REVIEWED_KEY) ?? []);
  const all = db.all(`SELECT id, node_id, subject_key, statement, verification, recorded_at FROM assumptions
                      WHERE task_id=? AND verified_against='settled_by_me' AND superseded_at IS NULL AND status<>'confirmed' ORDER BY recorded_at, rowid`, taskId);
  // 同一步重做过（返工 / 计划变更）：只认它最近一次交接里的说法 —— 前一次的已被取代（例：
  // AI 早先说"冒烟不清理"，后来改成了备份还原，事项不能还摘着旧的）。
  const latestOf = new Map();
  for (const a of all) if (a.node_id) latestOf.set(a.node_id, Math.max(latestOf.get(a.node_id) ?? 0, a.recorded_at));
  const fresh = all.filter((a) => !seen.has(a.id) && (!a.node_id || a.recorded_at === latestOf.get(a.node_id)));
  if (!fresh.length) return [];
  const groups = { spec_choice: [], structural: [] };
  for (const a of fresh) groups[domainOf(a)].push(a);
  const out = [];
  db.tx(() => {
    for (const [domain, items] of Object.entries(groups)) {
      if (!items.length) continue;
      const qid = newId('q');
      const shown = items.slice(0, MAX_ITEMS);
      const what = domain === 'structural' ? '依赖、构建或仓库结构上' : '规格没写、界面或行为上';
      const text = [
        `${CHOICES_MARK}任务「${task.title}」做的时候，${what}有 ${items.length} 件事是 AI 自己定的（规格里没写，它查过之后自己选了一个）。下面是它交接时的原话，系统原样摘出来，没有改写：`,
        '',
        ...shown.flatMap((a, i) => [`${i + 1}. ${clip(a.statement, 220)}`, `   它的依据：${clip(a.verification, 160)}`]),
        ...(items.length > shown.length ? [`……另有 ${items.length - shown.length} 件，见任务页「活动」里的"系统代为决定"。`] : []),
        '',
        '这条不影响任务照常签收、合并。怎么答：',
        '- 都行：回「A」（代表上面几件全部同意，不是选第几条）。这几件记进项目的约定清单，以后的任务照着来。',
        '- 有要改的：直接写改成什么（比如"2 改成：高 / 中 / 低 倒过来显示"）。系统替你「添加任务」去改 —— 这个任务照常签收、合并，改动放在后面单独做、单独批。',
        '- 只想补一句说明、不要求改：以「说明：」开头写。只记下来给后面的人看，不会引出任何改动。',
        '- 不答：到期按"沿用 AI 的选择"了结。',
      ].join('\n');
      const ttl = timeoutFor(db, taskId, 2);
      db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
              VALUES (?,?,NULL,2,'hard_rule',?,?,?,?,'open')`, qid, taskId, text, '沿用 AI 的选择，不改', at, ttl ? at + ttl : null);
      // 主题键的开头也算（frontend.priority.label → frontend）：原话里常常没有路径（只看原话，界面上的取舍会落不到管界面的人手上）
      const keyDirs = items.map((a) => String(a.subject_key).match(/^(frontend|backend|client|server|web|api|ui|app)[._/-]/i)?.[1]?.toLowerCase()).filter(Boolean);
      const pf = [...new Set([...prefixesIn(items.map((a) => `${a.subject_key} ${a.statement}`).join('\n')), ...keyDirs])];
      routeQuestion(db, { questionId: qid, decisionType: domain, typeSource: 'hard_rule', prefixes: pf.length ? pf : null, at });
      leadOnlyInformed(db, { questionId: qid, taskId });
      audit(db, { actorKind: 'system', action: 'choices_review_raised', targetType: 'task', targetId: taskId,
        payload: { questionId: qid, domain, assumptionIds: items.map((a) => a.id), human: `${items.length} 件 AI 自选的事交给${domain === 'structural' ? '结构' : '规格'}那一行的人过目` } });
      out.push({ questionId: qid, domain, count: items.length });
    }
    setParam(db, { taskId, key: REVIEWED_KEY, value: [...new Set([...seen, ...all.map((a) => a.id)])], by: BY, governance: 'execution' });   // 被取代的旧说法也算看过了
  });
  return out;
}

/**
 * 过目事项不挡任何东西，是给领域里的人看的：这一行除了负责人还有别人、且任一人答就算时，负责人改成只知会（仍然可以答）。
 * 否则负责人和成员同时收到，负责人顺手先答了，成员一条都答不上 —— "界面问管界面的人、技术问后端同事"落了空。
 */
function leadOnlyInformed(db, { questionId, taskId }) {
  const q = db.one(`SELECT addressed_to, informed, route FROM questions WHERE id=?`, questionId);
  const lead = leadOf(db, taskId);
  const to = JSON.parse(q.addressed_to || '[]');
  const rows = JSON.parse(q.route || 'null')?.rows ?? [];
  if (!lead || !to.includes(lead) || !to.some((u) => u !== lead) || !rows.every((r) => String(r.quorum) === '1')) return;
  const informed = [...new Set([...JSON.parse(q.informed || '[]'), lead])];
  db.run(`UPDATE questions SET addressed_to=?, informed=? WHERE id=?`, JSON.stringify(to.filter((u) => u !== lead)), JSON.stringify(informed), questionId);
}

/**
 * 过目事项答复的方向：同意（「A」，后面几行附言也算）/ 只是说明 / 要改（其余）。几个人一起过目时按方向归并 ——
 * 例：一人回「A」、一人回「A + 说明：…」，按字面会被判成不一致、生成一条冲突事项（两人其实都同意）。
 */
export const choicesSide = (body) => {
  const b = String(body ?? '').trim();
  return NOTE_RE.test(b) || KEEP_RE.test(b.split('\n')[0]) ? 'keep' : `change:${b.replace(/\s+/g, ' ').toLowerCase()}`;
};
const NOTE_RE = /^\s*(说明|备注)\s*[:：]/;
const KEEP_RE = /^\s*[（(]?(A|都行|都可以|可以|同意|好|好的|没问题|照这样|就这样|ok|okay|行)[)）]?[。！!.\s]*$/i;

/**
 * 过目事项的答复（由 project-append.mjs 注册成答复的前置钩子 —— 已合并时要替人「添加任务」，那是 agent 层的事）。
 * `append(brief)`：替答复人添加任务。返回 { handled, kept?, correction?, appended? }；不是这类事项返回 null。
 */
export function answerChoices(db, { question, finalBody, by, messageId, at = now(), append }) {
  if (!String(question.text ?? '').startsWith(CHOICES_MARK)) return null;
  const taskId = question.task_id;
  const raised = db.one(`SELECT payload FROM audit_log WHERE action='choices_review_raised' AND target_id=? AND payload LIKE ? ORDER BY id DESC LIMIT 1`,
    taskId, `%"questionId":"${question.id}"%`);
  const ids = raised ? JSON.parse(raised.payload).assumptionIds ?? [] : [];
  const items = ids.length ? db.all(`SELECT id, subject_key, statement FROM assumptions WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
  const body = String(finalBody ?? '').trim();
  const task = db.one(`SELECT id, title, project_id, merged_at, status FROM tasks WHERE id=?`, taskId);
  const who = by ? db.one(`SELECT display_name FROM users WHERE id=?`, by)?.display_name ?? by : '系统';
  // 只是说明（只想指出"这条摘的是旧说法"的人，不该让任务被重新打开、要人批计划变更）
  if (NOTE_RE.test(body)) {
    audit(db, { actorKind: 'user', actorId: by, action: 'choices_noted', targetType: 'task', targetId: taskId,
      payload: { questionId: question.id, human: `${who}对 AI 定的事补了一句说明：${body.replace(NOTE_RE, '').slice(0, 200)}` } });
    return { handled: true, noted: true };
  }
  // 第一行是"都行"就是同意；后面几行当作附言，跟约定一起记下
  if (KEEP_RE.test(body.split('\n')[0])) {
    for (const a of items) {
      record(db, { projectId: task.project_id, taskId, subject: a.subject_key, statement: `${a.statement}（AI 定的，${who}过目同意）`,
        sourceKind: 'question', sourceId: question.id, decidedBy: by, at });
    }
    audit(db, { actorKind: 'user', actorId: by, action: 'choices_kept', targetType: 'task', targetId: taskId, payload: { questionId: question.id, count: items.length, human: `${who}同意了 AI 定的 ${items.length} 件事` } });
    return { handled: true, kept: items.length };
  }
  const listing = items.map((a, i) => `${i + 1}. ${a.statement}`).join('\n');
  // 要改：项目里的任务一律替答复人「添加任务」—— 没合并也不重开这个任务（重开会把等签收的任务拉回执行、
  // 旧签收作废、重规划还可能要人批计划变更，一句"这条要改"变成三四条事项）。改动排在后面单独做、单独批。
  if (task.project_id && append) {
    const r = append(`「${task.title}」里 AI 替人定的几件事，${who}要改：\n${body}\n\n—— 当时 AI 定的（系统原样附上）——\n${listing}`);
    audit(db, { actorKind: 'user', actorId: by, action: 'choices_change_appended', targetType: 'task', targetId: taskId,
      payload: { questionId: question.id, queued: !!r?.queued, human: `${who}要改 AI 定的事；任务已合并，替${who}添加了任务${r?.queued ? '（排队）' : ''}` } });
    return { handled: true, appended: true, queued: !!r?.queued };
  }
  // 还没合并：一条修正交给 AI 改这个任务（与"交回给人"那几种同一个形状：答复原文 + 系统附上的原委）
  const tok = messageId ? db.one(`SELECT token_id FROM messages WHERE id=?`, messageId)?.token_id ?? null : null;
  const mid = newId('m');
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
          VALUES (?,?,?,?,'correction','explicit','urgent','explicit','user-authenticated',?,?)`,
  mid, taskId, by, `${CHOICES_MARK}${who}对 AI 替人定的事要改：\n${body}\n\n—— 系统附（不由模型生成）：当时 AI 定的 ——\n${listing}`, tok, at);
  if (messageId) insertEdge(db, mid, messageId, 'derived_from', at);
  if (task.status === 'done') {
    db.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);
    audit(db, { actorKind: 'user', actorId: by, action: 'task_resumed', targetType: 'task', targetId: taskId, payload: { from: 'done', to: 'running', via: 'choices_review' } });
  }
  audit(db, { actorKind: 'user', actorId: by, action: 'message_received', targetType: 'task', targetId: taskId,
    payload: { messageId: mid, kind: 'correction', kindSource: 'explicit', urgency: 'urgent', urgencySource: 'explicit', via: 'choices_review' } });
  return { handled: true, correction: mid };
}
