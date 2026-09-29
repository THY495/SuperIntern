// 决定登记：项目级、长期有效的"约定清单"。
//
// 起因：冲突不只是"两个人对同一个问题答得不一样"，
// 还包括**新意见 vs 尚未作废的旧决定**。后者今天完全没人管：三个月前定下"错误码一律用
// ERR_ 前缀"，今天新加的任务描述里写"错误码用数字"，系统会照着新的做，旧的静悄悄失效。
//
// 原则（拍板时定的，别改）：
//   - **多数是正当演进**。系统的职责是把"作废旧决定"这件事**显式化**，不是拦住人。
//   - **"以新为准"必须一键**。误报代价要低 —— 一条误报应该是多点一次，不是多一场会。
//   - **聊天不算**。只有人真的拍过板的才进清单：已有结论的事项、批准过的契约、批准过的变更、
//     改过的项目目标。agent 自己的选择、消息、留言都不算。
//
// 这个文件只管**记**与**查**。比对（三个入口 + 轻档模型）与冲突处理在后面两块。
//
// ⚠️ 与既有的 `decisions` 表不是一回事：那是每个任务的叙事日志，大半由 agent 写。理由见迁移 v15 的注释。

import { newId, now, audit } from '../db/db.mjs';
import { stripTransferHint } from './routing.mjs';

/**
 * 哪些已答的事项算"决定"。
 *
 * 这是一张显式的白名单，漏了的后果是"少比一条"，不是静默停摆 —— 但还是要在这里说清楚
 * 每一种为什么不收，否则下一个人只会看到一个没有解释的数组：
 *   contract_approval  契约本身已经按 source_kind='contract' 逐条记了，再记一条"批准了方案"是重复；
 *   signoff            接受 / 打回是对**这一次产物**的判断，不是对将来的约定；
 *   budget / egress    加钱、放行某个软件源：运维动作，不构成关于产物的约定，进清单只会拉长模型要读的东西；
 *   conflict           结论会回写到原事项，记原事项就够了；
 *   delivery           不生成事项。
 */
export const DECIDING_TYPES = ['spec_choice', 'structural'];

export const SOURCE_NAMES = { question: '答复', contract: '契约', revision: '计划变更', goal: '项目目标' };

const parse = (s, d = []) => { try { const v = JSON.parse(s ?? ''); return v ?? d; } catch { return d; } };
const head = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// ── 预筛材料 ─────────────────────────────────────────────────────────────
/**
 * 从一段文字里捞出可能的路径 / 模块前缀。**召回式**：宁可多捞，不可漏捞。
 *
 * 这一类启发式容易出事（范围解析把否定句当肯定枚举、否定判断只看句首），
 * 所以这里把它的职责压到最小：它**只用来决定"这条旧决定要不要拿给模型看一眼"**，
 * 抽错了最坏是让模型多读几行；抽不到就返回空，而**空 scope 的决定永远进清单**（见 activeDecisions）。
 * 任何需要"照这个范围执法"的地方都不许用它 —— 那种地方要的是规划器结构化给出的路径清单。
 */
export function scopeHints(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const m of s.matchAll(/[A-Za-z0-9_@][A-Za-z0-9_@./-]*\.[A-Za-z0-9]+/g)) out.add(m[0].replace(/[.,;:]$/, ''));
  for (const m of s.matchAll(/[A-Za-z0-9_@][A-Za-z0-9_@.-]*\/[A-Za-z0-9_@./*-]*/g)) out.add(m[0].replace(/[.,;:]$/, ''));
  return [...out].filter((x) => x.length >= 3 && x.length <= 120).slice(0, 20);
}

/** 两组 scope 有没有可能指同一片地方。任一侧为空 = 算命中（召回优先）。 */
export function scopeOverlap(a, b) {
  const A = (a ?? []).map((x) => String(x).toLowerCase()), B = (b ?? []).map((x) => String(x).toLowerCase());
  if (!A.length || !B.length) return true;
  return A.some((x) => B.some((y) => x === y || x.startsWith(y) || y.startsWith(x)));
}

// ── 记 ───────────────────────────────────────────────────────────────────
/**
 * 登记一条决定。`scope` 不给就从 subject + statement 里捞。
 * `supersedes` 给了就把那条置为作废（"以新为准"那一键走的就是这里）。
 */
export function record(db, { projectId = null, taskId = null, subject, statement, scope = null,
  sourceKind, sourceId = null, decidedBy = null, decidedAt = null, supersedes = null, reservation = false, at = now() }) {
  if (!String(subject ?? '').trim()) throw new Error('决定登记要有 subject（一句话主题）');
  if (!String(statement ?? '').trim()) throw new Error('决定登记要有 statement（定了什么）');
  if (!SOURCE_NAMES[sourceKind]) throw new Error(`决定登记的来源只能是 ${Object.keys(SOURCE_NAMES).join(' / ')}，收到 ${sourceKind}`);
  const id = newId('dr');
  const sc = scope ?? scopeHints(`${subject}\n${statement}`);
  db.run(`INSERT INTO decision_registry (id,project_id,task_id,subject,statement,scope,source_kind,source_id,
            decided_by,decided_at,status,supersedes,reservation,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`,
  id, projectId, taskId, String(subject).trim(), String(statement).trim(), JSON.stringify(sc),
  sourceKind, sourceId, decidedBy, decidedAt ?? at, supersedes, reservation ? 1 : 0, at);
  if (supersedes) voidOne(db, { id: supersedes, by: decidedBy, reason: `被 ${id} 取代`, at, supersededBy: id });
  audit(db, { actorKind: decidedBy ? 'user' : 'system', actorId: decidedBy, action: 'decision_registered',
    targetType: 'project', targetId: projectId ?? taskId, payload: { decisionId: id, sourceKind, sourceId, subject: head(subject, 120), taskId, supersedes, reservation: !!reservation } });
  return id;
}

/** 作废一条。`supersededBy` 只进审计与 void_reason —— 取代关系记在新那条的 supersedes 上，一处真相。 */
export function voidOne(db, { id, by = null, reason = '', at = now(), supersededBy = null }) {
  const row = db.one(`SELECT id, status, subject, project_id FROM decision_registry WHERE id=?`, id);
  if (!row) throw new Error(`决定不存在：${id}`);
  if (row.status === 'void') return { changed: false };
  db.run(`UPDATE decision_registry SET status='void', void_reason=?, voided_at=?, voided_by=? WHERE id=?`,
    String(reason ?? ''), at, by, id);
  audit(db, { actorKind: by ? 'user' : 'system', actorId: by, action: 'decision_voided', targetType: 'project',
    targetId: row.project_id ?? null, payload: { decisionId: id, subject: head(row.subject, 120), reason, supersededBy } });
  return { changed: true };
}

// ── 查 ───────────────────────────────────────────────────────────────────
/**
 * `disputed`：这一条此刻正被争议 —— 有人说了与它相反的话，冲突事项已经挂上但还没有结论。
 *
 * 为什么要这一列：比对**不阻塞**，所以"新说法已经生效"和"旧决定还在清单上"
 * 会同时为真一段时间。不把这段时间标出来，别人（和执行器）读到的是一份看起来毫无争议的清单，
 * 会照着那条其实正在被推翻的约定继续做 —— 而说这话的人以为自己已经改掉了。
 */
const disputedOf = (db, id) => !!db.one(`SELECT 1 FROM questions q JOIN edges e ON e.from_id=q.id
                                         WHERE e.relation='derived_from' AND e.to_id=? AND q.status IN ('open','escalated') LIMIT 1`, id);
const shape = (db, r) => ({ ...r, scope: parse(r.scope), reservation: !!r.reservation, disputed: disputedOf(db, r.id) });

/**
 * **这个任务的契约里，哪几条已经被人判作废了。**
 *
 * 契约条款经 `recordFromContract` 进登记表时 `task_id` 就是那个任务、规则原文就在 statement 里 ——
 * 所以"哪个任务的契约写着这条"是**精确**的，不用从散文里找。答复 / 计划变更来源的决定可能被别的
 * 契约抄过，但抄没抄只能从散文里猜 —— 明说不追。
 *
 * 作废之后 `activeDecisions` 不再给出它，执行器上下文里它就**消失**了；可它还写在契约里（规则经
 * `foldRules` 折进了完成定义），而契约优先 —— 执行器看到的是一份没有异议的契约，照着作废的规则做（静默误读）。
 * 这里不改契约原文（"以新为准"授权的是作废旧的，不是"把这份契约改成这几个字"），只把裁定挂在旁边：
 * 谁、在哪条事项、哪天判的，以什么为准。出处指向那个人亲手答的事项，所以它不是系统替人改契约。
 *
 * @returns {Array<{id, subject, statement, by, at, questionId|null, quote|null}>}
 */
export function overruledContractRules(db, taskId) {
  // 被新的一条取代的（supersedes）不算：那种是契约本身改过了，新条目就在契约里。
  const rows = db.all(`SELECT * FROM decision_registry d WHERE task_id=? AND source_kind='contract' AND status='void' AND reservation=0
                         AND NOT EXISTS (SELECT 1 FROM decision_registry s WHERE s.supersedes=d.id)
                       ORDER BY voided_at, rowid`, taskId);
  return rows.map((d) => {
    // 裁定它的那条冲突事项（出处边 事项 → 决定）；人手工作废的（cli decisions void）没有事项，照样算 —— 那也是人拍的板。
    const q = db.one(`SELECT q.id FROM edges e JOIN questions q ON q.id=e.from_id
                      WHERE e.to_id=? AND e.relation='derived_from' AND q.status NOT IN ('open','escalated')
                      ORDER BY q.resolved_at DESC LIMIT 1`, d.id);
    let quote = null;
    if (q) {
      const raised = db.one(`SELECT payload FROM audit_log WHERE action='decision_conflict_raised' AND target_id=? ORDER BY id DESC LIMIT 1`, q.id);
      try { quote = (JSON.parse(raised?.payload || '{}').hits ?? []).find((h) => h.id === d.id)?.quote ?? null; } catch { /* 取不到就不写 */ }
    }
    return { id: d.id, subject: d.subject, statement: d.statement, by: d.voided_by, at: d.voided_at,
      questionId: q?.id ?? null, quote: quote || null, reason: d.void_reason ?? '' };
  });
}

/** 给执行器 / 规划器 / 重规划器的那一段。清单为空返回空串。 */
export function renderOverruled(db, list) {
  if (!list?.length) return '';
  const nameOf = (u) => (u && db.one(`SELECT display_name FROM users WHERE id=?`, u)?.display_name) || u || '（未记录）';
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '某日');
  const lines = list.map((d) => `- 「${head(d.statement, 300)}」\n  此条已由 ${nameOf(d.by)} ${d.questionId ? `在事项 ${d.questionId}` : '手工'}（${day(d.at)}）判作废，`
    + `${d.quote ? `以新的说法为准：「${head(d.quote, 200)}」` : '以作废之后的约定为准'}。不必再问。`);
  return `## 契约里已被人判作废的条目

下面几条**仍然写在上面的契约里**（也可能已经写进了节点规格和验收标准），但人已经裁定它们作废。
这是人拍过板的结论，与契约同级：**照新的说法做，不要照原文做，也不必为此再问一次。**

${lines.join('\n')}

只有一种情况要提出来：新的说法落到你这一步上**说不清该怎么做** —— 例如它和这一步的验收标准正面冲突
（新说法是"截断"，验收却断言返回 400）。那是一处结构矛盾，按结构矛盾提；不要自己挑一边，也不要改验收去迁就。`;
}

/**
 * 这个任务所在的范围里有没有**能拿来比对**的有效决定（保留意见不算）。便宜的一行查询 ——
 * 修正落库时用它决定要不要标"待比对"：没有可比的，比对器必然零成本跳过，标了只会白等。
 */
export function hasComparableDecisions(db, taskId) {
  const pid = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;
  return !!db.one(`SELECT 1 FROM decision_registry WHERE ${pid ? 'project_id=?' : 'project_id IS NULL AND task_id=?'}
                     AND status='active' AND reservation=0 LIMIT 1`, pid ?? taskId);
}

/**
 * 某个项目此刻有效的决定清单。
 *   scope 给了就做召回式预筛：**只过滤掉"两边都写了路径且确定不沾边"的**；
 *   自己没写 scope 的决定永远留下 —— 宁可让模型多读，不能替它决定什么不用看。
 */
export function activeDecisions(db, { projectId = null, taskId = null, scope = null, limit = 500 } = {}) {
  const rows = projectId
    ? db.all(`SELECT * FROM decision_registry WHERE project_id=? AND status='active' ORDER BY decided_at, rowid LIMIT ?`, projectId, limit)
    : db.all(`SELECT * FROM decision_registry WHERE project_id IS NULL AND task_id=? AND status='active' ORDER BY decided_at, rowid LIMIT ?`, taskId, limit);
  const out = rows.map((r) => shape(db, r));
  return scope ? out.filter((d) => scopeOverlap(d.scope, scope)) : out;
}

/**
 * 给**执行器**的那一份：比 activeDecisions 严一档。
 *
 * 差别只在"查询方没写出任何路径"时：activeDecisions 会把整张清单给出去（召回优先，给人和给
 * 规划器都对），而执行器不行 —— 给它全量等于给它一份它无权改、又与契约并列的第二份规格，
 * 它会照着做契约没要求的事（与"不把规划原文给执行器"是同一条理由）。
 * 所以这里只留两种：**范围沾边的**，和**自己没写范围的**（那种按定义是项目级通则，例如
 * "错误码一律用 ERR_ 前缀"，它本来就该对每个执行器都生效）。
 */
export function relevantDecisions(db, { projectId = null, taskId = null, scope = null } = {}) {
  const all = activeDecisions(db, { projectId, taskId });
  const q = (scope ?? []).map((x) => String(x).toLowerCase());
  return all.filter((d) => {
    const s = (d.scope ?? []).map((x) => String(x).toLowerCase());
    if (!s.length) return true;                       // 没写范围 = 项目级通则
    if (!q.length) return false;                      // 问的人说不出范围，就只给通则
    return s.some((x) => q.some((y) => x === y || x.startsWith(y) || y.startsWith(x)));
  });
}

/** 一条决定的来龙去脉：它取代了谁、被谁取代。 */
export function chainOf(db, id) {
  const back = [];
  let cur = db.one(`SELECT * FROM decision_registry WHERE id=?`, id);
  if (!cur) return null;
  let p = cur.supersedes;
  while (p) { const r = db.one(`SELECT * FROM decision_registry WHERE id=?`, p); if (!r) break; back.unshift(shape(db, r)); p = r.supersedes; }
  const fwd = [];
  let n = db.one(`SELECT * FROM decision_registry WHERE supersedes=?`, id);
  while (n) { fwd.push(shape(db, n)); n = db.one(`SELECT * FROM decision_registry WHERE supersedes=?`, n.id); }
  return { supersedes: back, self: shape(db, cur), supersededBy: fwd };
}

/** 给模型与人看的清单文本。编号是给规划器写进契约"相关决定"那一节用的。 */
export function renderDecisions(list, { withId = true } = {}) {
  return (list ?? []).map((d, i) => `${withId ? `[${d.id}] ` : `${i + 1}. `}〔${d.reservation ? '保留意见' : SOURCE_NAMES[d.source_kind] ?? d.source_kind}〕${d.subject}：${d.statement}`
    + ((d.scope ?? []).length ? `（范围：${d.scope.slice(0, 6).join('、')}）` : '')
    // 保留意见不是约定：批的人照批了，这句话**不推翻任何一条规则**。不写清楚，模型会把它当成一条要遵守的东西。
    + (d.reservation ? '　（这是批准时留下的**保留意见**，不是约定：它不推翻上面任何一条规则，也不要求你照它做。要动这一处时把它当作"有人对此有过异议"的提示，在结论里说一句你是怎么处理的。）' : '')
    // 正在被争议的照样列出来，但要说明白 —— 不标出来，模型会照着一条其实正在被推翻的约定往下做。
    + (d.disputed ? '　⚠ 这一条**正在被争议**：有人说了与它相反的话，还没有结论。它暂时仍然算数，但不要把它当成板上钉钉的依据；照它做之前先看那条冲突事项。' : '')).join('\n');
}

export const DECISIONS_HEADER = '本项目已经定下的约定（人拍过板的：有结论的事项 / 批准过的契约与变更 / 项目目标；标〔保留意见〕的那些是批准时留下的异议，**不是约定**。'
  + '它们**仍然有效**，除非有人显式作废。你的产出要与它们一致；发现必须与某一条相反才做得下去，'
  + '不要自己绕过去，把它当成一处结构矛盾提出来）：';

/**
 * 给模型上下文用的一段。清单为空就返回空串 —— 不留一个"（无）"的空标题占位，
 * 那只会让模型以为这个项目从来没定过任何东西。
 *
 * 谁拿全量、谁拿相关的（拍板时定的）：规划器 / 追问器拿完整清单（它们在切"要做什么"，
 * 看不全就会切出和旧约定打架的契约）；**执行器只拿相关的**（给它全量等于给它一份
 * 它无权改、又与契约并列的第二份规格，它会照着做契约没要求的事 ——
 * 与"不把规划原文给执行器"是同一条理由）。
 *
 * ⚠️ 上面那句"拿完整清单"并不绝对 —— 这里砍到 `max` 条。砍法要小心：`activeDecisions`
 * 按 `decided_at` 升序取，若用 `slice(0, max)`，留下的是**最老的**那批，被丢掉的恰恰是
 * **刚刚定下的**那些（登记表上百条时，被砍的会全是最近新定的）。
 *
 * 所以：**保新不保旧**（`slice(-max)`，再按原顺序呈现），并把被砍掉的条数与"砍的是最老的"
 * 一起写在那句提示里。彻底的做法是按相关性挑，但"相关性"要么靠模型（又一次调用）、
 * 要么靠 scope 字符串匹配（这类启发式已经多次出事），所以这里只做机械可证的那一步。
 */
export function decisionsSection(db, { projectId = null, taskId = null, scope = null, header = DECISIONS_HEADER, max = 60 } = {}) {
  const list = activeDecisions(db, { projectId, taskId, scope });
  if (!list.length) return '';
  const shown = list.length > max ? list.slice(-max) : list;
  const cut = list.length - shown.length;
  return `${header}\n${renderDecisions(shown)}`
    + (cut ? `\n（共 ${list.length} 条，这里列的是**最近 ${shown.length} 条**；更早的 ${cut} 条没有列出。`
      + `如果你的判断依赖那些更早的条目，就在结论里明说这一点，别当它们不存在。完整清单见 node src/cli.mjs decisions ${projectId ?? taskId}）` : '');
}

// ── 四个写入点 ───────────────────────────────────────────────────────────
const projectOf = (db, taskId) => db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;

/**
 * ⑤ 批准时留下的**保留意见**。
 *
 * 例：负责人批一份计划变更时想写下「下限截到 1 那条……他没明确说之前，这条先别当硬规则写进宪法」，
 * 而这一页只有批 / 驳两个按钮，他只能改口「不值得为这一条卡住正题 —— 批」。
 * **那不是他改主意，是界面上没有地方放那句话。**
 *
 * 这条修法便宜、也诚实地有限：**那条规则照样生效**。保留意见买到的只有三样 ——
 * 它进上下文（下一个碰这一处的 agent 看得到"有人对此有过异议"）、它留在审计里（事后能查）、
 * 它给出一个机械可量的数字（记了几条、其中几条后来真的被人回头改了）。挡不住这一轮，这是知情的取舍。
 *
 * **不参与决定登记的冲突比对**：它不是一条能被违反的规则，拿它去比会把每一次触及都报成冲突。
 */
export function recordReservation(db, { projectId = null, taskId = null, subject, text, sourceKind, sourceId = null, by = null, at = now() }) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  return record(db, {
    projectId, taskId, reservation: true,
    subject: head(String(subject ?? '批准时的保留意见').trim(), 120),
    statement: head(body, 600),
    scope: scopeHints(`${subject}\n${body}`),
    sourceKind, sourceId, decidedBy: by, at,
  });
}

/**
 * ① 已有结论的事项。只收 DECIDING_TYPES；**结论文本就是决定本身**，问题正文作主题。
 * 由 answers.mjs 的 resolve() 调用 —— 那是唯一"事项有了结论"的地方。
 */
export function recordFromQuestion(db, { question, finalBody, by = null, at = now() }) {
  const dt = question.decision_type ?? null;
  if (!DECIDING_TYPES.includes(dt)) return null;
  const qtext = stripTransferHint(question.text);
  const q1 = qtext.trim().split('\n').find((l) => l.trim()) ?? '';
  return record(db, {
    projectId: projectOf(db, question.task_id), taskId: question.task_id,
    subject: head(q1.replace(/^【.*?】/, ''), 120),
    statement: head(finalBody, 600),
    scope: scopeHints(`${qtext}\n${finalBody}`),
    sourceKind: 'question', sourceId: question.id, decidedBy: by, at,
  });
}

/**
 * ② 批准过的契约。粒度是**人能对着它说"这条我要改"的东西**：每条行为规则一行、范围一行、验收命令一行。
 * 目标与完成定义不收：它们是这个任务自己的目的，与别的任务冲突时会以"结构矛盾"在执行时冒出来，
 * 放进清单只会让每个任务多两条几乎不会命中的文本（有意的取舍，记在 known-limits）。
 */
export function recordFromContract(db, { taskId, spec, constitutionId = null, userId = null, at = now() }) {
  const projectId = projectOf(db, taskId);
  const title = String(spec?.title ?? '').trim();
  const ids = [];
  const common = { projectId, taskId, sourceKind: 'contract', sourceId: constitutionId, decidedBy: userId, at };
  for (const r of Array.isArray(spec?.rules) ? spec.rules : []) {
    if (!String(r?.rule ?? '').trim()) continue;
    // `approved`：追问器草案里人批过的约束 —— 它本身就是契约原文，没有另外的出处，也不是规划器的假设。
    const src = r.approved ? '〔批准过的草案约束〕' : String(r.quote ?? '').trim() ? `〔规格〕出处：“${head(r.quote, 200)}”` : `〔规划器假设〕${head(r.assumption, 200)}`;
    ids.push(record(db, { ...common, subject: `${title ? `${title}｜` : ''}行为规则`, statement: `${String(r.rule).trim()}（${src}）`,
      scope: scopeHints(`${r.rule}\n${r.quote ?? r.assumption ?? ''}\n${spec?.scope ?? ''}`) }));
  }
  if (String(spec?.scope ?? '').trim() && spec.scope !== '未限定') {
    ids.push(record(db, { ...common, subject: `${title ? `${title}｜` : ''}改动范围`, statement: String(spec.scope).trim() }));
  }
  const vc = typeof spec?.verify_command === 'string' ? spec.verify_command.trim() : Array.isArray(spec?.verify_command) ? spec.verify_command.join(' ') : '';
  if (vc) ids.push(record(db, { ...common, subject: `${title ? `${title}｜` : ''}验收命令`, statement: vc, scope: scopeHints(vc) }));
  return ids;
}

/** ③ 批准过的计划变更。人写的那条消息是决定本身；宪法补丁改了什么单独说一句。 */
const FIELD_NAMES = { goal: '目标', scope: '范围', definition_of_done: '完成定义', constraints: '约束' };
export function recordFromRevision(db, { taskId, revisionId, messageId = null, instruction = '', patchFields = [], patch = null, userId = null, at = now() }) {
  // 字段名翻成人话，并写明是**本任务契约**的那一份 —— 项目也有"完成定义"，不说清楚会被当成改了项目的。
  const fields = patchFields ?? [];
  const changed = fields.length ? `（改了本任务契约的${fields.map((f) => FIELD_NAMES[f] ?? f).join('、')}）` : '';
  const projectId = projectOf(db, taskId);
  const id = record(db, {
    projectId, taskId,
    subject: head(`计划变更 ${revisionId}`, 120),
    statement: `${head(instruction, 600)}${changed}`,
    scope: scopeHints(instruction),
    sourceKind: 'revision', sourceId: messageId ?? revisionId, decidedBy: userId, at,
  });
  // ⚠️ 上面那条记的是**人写的那句指令**，不是契约最后被改成了什么 —— 两者常常不一样：
  // 重规划器会在人要的那条之外顺手再推一条（例：人只说了"截到上限返回 200"，
  // 它同时写进了"size 小于 1 时按 1 处理"）。只记指令的下场是：**那条已经生效的规则在清单上查不到**，
  // 后来的人只能从一条明确标着"不是约定"的保留意见里间接得知它存在。
  // 所以把补丁的**实际内容**也逐字段记一条。至多四条（goal / scope / scope_paths / 完成定义 / 约束）。
  for (const f of fields) {
    const v = patch?.[f];
    if (v === undefined || v === null) continue;
    const text = Array.isArray(v) ? v.map((x) => String(x)).join('；') : String(v);
    if (!text.trim()) continue;
    record(db, { projectId, taskId, subject: head(`本任务契约的${FIELD_NAMES[f] ?? f}`, 120),
      statement: head(text, 600), scope: scopeHints(text),
      sourceKind: 'revision', sourceId: messageId ?? revisionId, decidedBy: userId, at });
  }
  return id;
}

/** ④ 项目目标 / 完成定义被改。前一条自动作废 —— 目标只有一份，新的一定取代旧的。 */
export function recordGoalChange(db, { projectId, goal, doneDefinition, userId = null, at = now() }) {
  const prev = db.one(`SELECT id FROM decision_registry WHERE project_id=? AND source_kind='goal' AND status='active'
                       ORDER BY decided_at DESC, rowid DESC LIMIT 1`, projectId)?.id ?? null;
  return record(db, { projectId, taskId: null, subject: '项目目标与完成定义',
    statement: `目标：${head(goal, 400)}\n完成定义：${head(doneDefinition, 400)}`,
    // 范围显式留空：目标是**项目级通则**，对每个任务都生效。让它自动抽出几个路径，
    // 反而会被执行器那份按范围过滤的清单挡掉（完成定义里随口提到 docs/API.md 就够了）。
    scope: [], sourceKind: 'goal', sourceId: projectId, decidedBy: userId, supersedes: prev, at });
}

/**
 * 一条**批准过的宪法补丁**，渲染成拿去比对的那段话。
 *
 * 为什么三个入口不够：入口是"人说的话"，而人说的往往只是一阶要求（"size 超范围别报 400"）。
 * 真正把**二阶后果**写死的是重规划器给出、人批准的那份补丁（例如它顺手把 BAD_SIZE 从 ERROR_CODES 里
 * 去掉了）。只比对入口，能命中直接冲突的决定，却会漏掉这种二阶后果 ——
 * 于是清单里写着"ERROR_CODES 深比较等于三个错误码"，而产物里只有两个，**没有任何机械的东西会发现**。
 * （发现它的是执行器自己的汇报"不确定点"，那是披露通道，不是闸门。）
 *
 * 补丁是人批过的（Ⅲ 级门），所以拿它去比对不违反"清单只收人拍过板的东西"那条原则。
 */
export function revisionCheckText(db, { instruction = '', patch = null } = {}) {
  const L = [String(instruction ?? '').trim()].filter(Boolean);
  for (const k of ['definition_of_done', 'scope', 'goal']) {
    if (patch?.[k]) L.push(`${k} 改成：${String(patch[k]).replace(/\s+/g, ' ').slice(0, 600)}`);
  }
  if (Array.isArray(patch?.constraints)) L.push(`constraints 改成：${patch.constraints.join('；').slice(0, 400)}`);
  return L.join('\n');
}
