// 追问器：把一个模糊想法追问成宪法块草案，人批准后才进规划。
//
// 为什么要有它：`new` 要求人一开始就给出目标 / 范围 / 完成定义 / 验收命令 —— 对"从模糊想法开始"
// 的场景，这些正是人写不出来的东西。设计里宪法块由人定，这一条不变：**追问器只出草案，
// 批准是人的一个 Ⅲ 级答复**，草案在批准之前不会被规划器读到（cli plan 与守护进程都有门）。
//
// 它与规划器同一个形状：一次寿命 = 一次 `cli draft`；停在提问上就退出（任务转 waiting）；
// 答复经 priorAnswers 带回下一次寿命 —— 已经答过的不再问。问题是任务级（node_id NULL），
// 所以规划器后来也看得到这些问答，不必在宪法块里重抄一遍。
//
// 出口只有三个：ask_user（Ⅱ 级、带默认、走超时链）、propose_constitution（→ Ⅲ 级批准问题）、
// 以及人对草案的回复被机械判为"批准 / 放弃 / 要改"。判"批准"不经模型：正则、短句、全匹配 ——
// "好，但是把 X 改成 Y" 不算批准，算反馈。签字这件事不交给分类器。

import { withOutputLang, contentLang, tl, I18nError } from '../i18n/index.mjs';
import { dirLikeTestArgs } from '../core/verify-argv.mjs';
import { markOf } from '../i18n/marks.mjs';
import { routeQuestion, scopePathProblems, normScopePaths, renderScopePaths, SCOPE_PATHS_NOTE, scopePathsNote, specPrefixes } from '../core/routing.mjs';
import { newId, now, audit } from '../db/db.mjs';
import { toolCallsOf, textOf, truncatedEmpty, TruncatedEmptyError } from '../llm/canonical.mjs';
import { priorAnswers } from './planner.mjs';
import { timeoutFor } from '../core/timeouts.mjs';
import { getParam, setParam } from '../core/params.mjs';
import { decisionsSection, recordReservation, recordFromContract } from '../core/decisions.mjs';
import { reservationOf, readApproval, confirmBeforeRevising, feedbackOf } from './approval.mjs';
import { roundHistory, renderRoundHistory } from './spec-diff.mjs';

// 判读搬到了 approval.mjs（回显 + 防循环）；旧的导入路径照旧能用。
export { readVerdict, reservationOf, RESERVATION_RE } from './approval.mjs';

export const DRAFT_STAGES = ['asking', 'proposed', 'approved'];
const MAX_QUESTIONS_PER_ROUND = 3;
const MAX_TOKENS = 16000;   // 含推理；6000 对 effort=high 太紧（规划器 8000 曾被吃光过）

const ASK_USER = {
  name: 'ask_user',
  description: `向人提最多 ${MAX_QUESTIONS_PER_ROUND} 个问题，用来把想法追问成可规划的宪法块。只问你自己判断不了、且答案会改变目标 / 范围 / 完成定义的事。`,
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array', minItems: 1, maxItems: MAX_QUESTIONS_PER_ROUND,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '问题本身。要让一个没看过上下文的人也能答；给出你看到的选项' },
            default_action: { type: 'string', description: '人不答时你会按哪个答案走。必须给：这是 Ⅱ 级问题，超时会按它走' },
            why: { type: 'string', description: '为什么这个答案会改变宪法块（一句话）' },
          },
          required: ['text', 'default_action', 'why'],
        },
      },
    },
    required: ['questions'],
  },
};

const PROPOSE = {
  name: 'propose_constitution',
  description: '提交宪法块草案。人会看到全文并批准 / 提修改 / 放弃。信息够了就提，不要为了多问而问。',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '一句话标题' },
      goal: { type: 'string', description: '目标：要达成什么，为什么' },
      scope: { type: 'string', description: '范围，写给人和实现方看的一段话：动哪些东西、不动哪些、为什么' },
      scope_paths: { type: 'array', items: { type: 'string' },
        description: '**同一个范围，用路径再写一遍**，机器按这一份执法。相对仓库根：目录写成 src/store/（结尾一条斜杠 = 含其下全部），具体文件写全名如 package.json。'
          + '把要新建或要改的都列上（新建的也列，不必已存在）；不许写绝对路径、..、通配符。整个仓库都可能动就写 ["*"]，但那等于不设范围。'
          + '⚠️ 这一份是越界校验的判据：没列上的文件，实现方改了会被机械撤销 —— 上面那段话不参与执法。' },
      definition_of_done: { type: 'string', description: '完成定义：可机械判定，含验收命令跑过的结果' },
      constraints: { type: 'array', items: { type: 'string' }, description: '约束列表；没有填 []' },
      verify_command: { type: 'string', description: '任务级验收命令：**一条**命令，在工作区根目录直接执行（按空白切成 argv，**不经 shell**：不能有管道、&&、$( )、重定向、多行）。典型写法 `node xxx.test.mjs` / `npm test` / `npx vitest run`。要跑一段脚本就把脚本本身列进完成定义让实现方交付，这里只写运行它的那一条命令。给不出就留空字符串，并在 notes 里说为什么' },
      notes: { type: 'string', description: '给人看的草案说明：你替人拍了哪些板、哪些点还拿不准' },
    },
    required: ['title', 'goal', 'scope', 'scope_paths', 'definition_of_done', 'constraints', 'verify_command', 'notes'],
  },
};

const SYSTEM = `你是一个长期运行的自主 agent 的"追问器"。人给了你一个想法，可能很模糊。你的任务是把它追问成一份
可以被规划、被机械验收的"宪法块"：目标、范围、完成定义、约束、验收命令。

做法：
- 先看想法本身与已经答过的问题。信息够了就直接调用 propose_constitution，不要为了多问而问。
- 不够就调用 ask_user，一轮最多 ${MAX_QUESTIONS_PER_ROUND} 个问题，每个问题都要给"人不答时你按哪个走"的默认。
  只问会改变目标 / 范围 / 完成定义的事；技术细节里你判断得了的，自己定并写进 notes。
- 人对草案的反馈会以"人的答复"出现在上下文里。收到反馈就按反馈出下一版（再次 propose_constitution），
  除非反馈本身含糊到需要再问一次。
- 完成定义必须机械可判：一条命令、一个退出码。给不出验收命令是可以的，但要在 notes 里说清为什么，
  以及人可以怎么补。
- 完成定义里有"能启动 / 按说明能跑起来"这类条目时，验收要**照交付的 README 写的启动方式原样起一遍**
  （README 写了几种就验几种，包括"在某个子目录下启动"），不能只从一个方便的目录验：
  人照 README 第一种方式起不来，就是没做到。
- 范围要写"不做什么"。约束里写人明确说过的限制，不要自己发明。
- 一份草案就是**一个**任务：几小时内做得完、一条命令验收得了。想法明显比这大时，不要硬塞进一份草案，也不要自己拆成多个任务 ——
  只覆盖能独立交付的第一块，在范围里写明"不做"哪些，并在 notes 里点名："本草案只覆盖 X；Y、Z 建议作为本项目的后续任务添加"（人可以随时在项目页添加任务）。

你不做规划、不拆节点、不写代码。你的产物只有问题和草案。`;

/**
 * 验收命令的形状检查（护栏在模型外）：任务级验收是把命令按空白切成 argv 直接 exec，不经 shell。
 * 曾出现过草案给了一段 20 行的 bash（mktemp / printf / grep / trap），形状合法、根本跑不起来 ——
 * 与其在提示词里求它，不如在这里拒收并回灌。
 */
export function verifyCommandProblems(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const errs = [];
  if (/[\r\n]/.test(s)) errs.push('verify_command 是多行脚本 —— 只能是一条命令；把脚本列进完成定义让实现方交付，这里只写运行它的命令');
  const meta = s.match(/(\|\||&&|\||;|\$\(|`|>|<|\bset -e\b|\btrap\b)/);
  if (meta) errs.push(`verify_command 含 shell 语法「${meta[1]}」—— 命令不经 shell 执行，管道 / 串联 / 重定向 / 变量都不生效`);
  // `node --test cli/` 在 Node 22 上不展开目录（Cannot find module）。系统执行时会改写成 glob（verify-argv），
  // 但契约里写着目录形式，执行器、签收的人都会以为它跑不通，于是提问、要求改命令，一个问题要来回好几步。
  const dirs = dirLikeTestArgs(s.split(/\s+/));
  if (dirs.length) errs.push(`verify_command 里 \`node --test ${dirs[0]}\` 写的是目录 —— Node 22 的 --test 不展开目录。写成 glob，例如 \`${dirs[0].replace(/\/+$/, '')}/*.test.mjs\`；规则里提到测试命令也用同样的写法`);
  return errs;
}

/** 草案渲染成人看的正文（也是 Ⅲ 级批准问题的正文）。`lang`：内容语言（调用方传 contentLang(db)；默认中文）。 */
export function renderDraft(c, version, notes, lang = 'zh') {
  const L = lang;
  const cons = Array.isArray(c.constraints) ? c.constraints : [];
  return [
    markOf(L, 'taskDraft', { version }),
    tl(L, '标题：{v}', { v: c.title }),
    tl(L, '目标：{v}', { v: c.goal }),
    tl(L, '范围：{v}', { v: c.scope }),
    tl(L, '可动路径（判据）：{v}', { v: renderScopePaths(c.scope_paths, L) }),
    scopePathsNote(L),
    tl(L, '完成定义：{v}', { v: c.definition_of_done }),
    tl(L, '约束：{v}', { v: cons.length ? '\n' + cons.map((x) => `  - ${x}`).join('\n') : tl(L, '（无）') }),
    tl(L, '验收命令：{v}', { v: c.verify_command ? c.verify_command : tl(L, '（没给 —— 见说明）') }),
    notes ? '\n' + tl(L, '草案说明：{v}', { v: notes }) : '',
    '',
    tl(L, '批准后会自动规划并开跑。请回复：'),
    tl(L, '(A) 批准 —— 回 "A" 或 "批准"'),
    tl(L, '(B) 要改 —— 直接写要改什么，会出下一版'),
    tl(L, '(C) 放弃 —— 回 "C" 或 "放弃"'),
    tl(L, '(D) 批准，但留一句保留意见 —— **它不挡任何东西**：这一批照样全部生效，效果与 (A) 一模一样。它只把你那句话留在项目的约定清单上、标成〔保留意见〕，让下一个碰这一处的人看得到。要**挡住**其中某一条，只能 (B) 说清哪一条不要、让它重出一版。写法：先回 A，**另起一行**写「保留：…」。'),
  ].filter((l) => l !== null).join('\n');
}

/**
 * 从一个想法建任务（`cli new --idea` 与看板"新任务"共用）。没有宪法块 —— 那是追问器要产出的东西。
 * 状态 planning + params draft.*；守护进程看到 draft.stage 不是 approved 就拉 `cli draft`。
 */
export function startFromIdea(db, { userId, idea, title = null, source = null, projectId = null, order = null }) {
  const text = String(idea ?? '').trim();
  if (!text) throw new I18nError('想法不能为空');
  const taskId = newId('t');
  const t = now();
  const by = { kind: 'user', id: userId };
  db.tx(() => {
    // 项目里的任务（projectId + order）—— 仓库住在项目上，不记 draft.source；批准后的工作区从项目分支起。
    db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,?,'planning',?,?,?)`,
      taskId, userId, String(title ?? '').trim() || text.split('\n')[0].slice(0, 60), t, projectId, projectId ? order : null);
    setParam(db, { taskId, key: 'draft.idea', value: text, by, governance: 'constitutional' });
    setParam(db, { taskId, key: 'draft.stage', value: 'asking', by, governance: 'constitutional' });
    if (source) setParam(db, { taskId, key: 'draft.source', value: String(source), by, governance: 'constitutional' });
    audit(db, { actorKind: 'user', actorId: userId, action: 'task_created', targetType: 'task', targetId: taskId,
      payload: { idea: true, source: source ?? null, bytes: text.length, ...(projectId ? { projectId, order } : {}) } });
  });
  return { taskId };
}

const latestConstitution = (db, taskId) => db.one(
  `SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);

export const answerOf = (db, questionId) => db.one(
  `SELECT m.body, m.trust_label, m.received_at, m.sender_id FROM edges e JOIN messages m ON m.id=e.from_id
    WHERE e.to_id=? AND e.relation='answers' AND e.superseded_at IS NULL ORDER BY m.received_at DESC LIMIT 1`, questionId);

/**
 * 追问器的一次寿命。返回 { kind: 'asking'|'proposed'|'approved'|'abandoned'|'noop', ... }。
 *   client   LlmClient
 *   tier     默认 heavy
 */
export async function draft(db, { client, taskId, tier = 'heavy', maxAttempts = 3 }) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
  if (!task) throw new I18nError('没有这个任务：{id}', { id: taskId });
  const idea = getParam(db, taskId, 'draft.idea');
  if (!idea) throw new I18nError('这个任务不是从想法开始的（没有 draft.idea），不需要追问');
  const L = contentLang(db);
  const stage = getParam(db, taskId, 'draft.stage');
  if (stage === 'approved') return { kind: 'noop', why: '草案已批准，下一步是规划' };
  if (['done', 'aborted'].includes(task.status)) return { kind: 'noop', why: `任务 ${task.status}` };
  const open = db.one(`SELECT count(*) n FROM questions WHERE task_id=? AND status IN ('open','escalated')`, taskId).n;
  if (open) return { kind: 'noop', why: `还有 ${open} 个问题没答` };

  const startedAt = now();
  audit(db, { actorKind: 'agent', actorId: 'elicitor', action: 'elicitor_started', targetType: 'task', targetId: taskId,
    payload: { pid: process.pid, tier, stage } });
  const exit = (kind, extra = {}) => {
    audit(db, { actorKind: 'agent', actorId: 'elicitor', action: 'elicitor_exit', targetType: 'task', targetId: taskId,
      payload: { pid: process.pid, kind, elapsedMs: now() - startedAt, ...extra } });
    return { kind, ...extra };
  };
  // 答题把任务从 waiting 翻成 running；追问阶段的任务不该以 running 示人（守护进程会当成可跑的）
  if (task.status === 'running') db.run(`UPDATE tasks SET status='planning' WHERE id=?`, taskId);

  try {
    // ── 人对上一版草案说了什么 ─────────────────────────────────────────────
    let feedback = null;
    const current = latestConstitution(db, taskId);
    if (stage === 'proposed') {
      const qid = getParam(db, taskId, 'draft.approval_question');
      const a = qid ? answerOf(db, qid) : null;
      if (!a) return exit('noop', { why: tl(L, '草案等人批，但找不到答复') });
      const verdict = readApproval(db, { taskId, questionId: qid, body: a.body, userId: a.sender_id, version: current?.version ?? null });
      if (verdict === 'approve') {
        setParam(db, { taskId, key: 'draft.stage', value: 'approved', by: { kind: 'user', id: a.sender_id }, governance: 'constitutional' });
        const vc = getParam(db, taskId, 'draft.verify_command');
        if (vc) {
          setParam(db, { taskId, key: 'task.verify_command', value: String(vc).trim().split(/\s+/), by: { kind: 'user', id: a.sender_id }, governance: 'constitutional' });
        }
        db.run(`UPDATE tasks SET title=?, status='planning' WHERE id=?`, getParam(db, taskId, 'draft.title') ?? task.title, taskId);
        // 批准时带的保留意见有地方放了（不改变任何规则，只是记下来 + 进下一个人的上下文）
        // 契约进决定登记：若只有整批规划那条路（createTaskFromSpec）登记契约，
        // "新建项目"单任务入口批准的草案一条都不进 —— 人在达成确认时明说"我要的是不含空格和换行的"，
        // 直接推翻了契约里的口径，决定比对却只有不相干的决定可比，零命中。约束逐条作为行为规则登记。
        if (current) {
          try {
            recordFromContract(db, { taskId, constitutionId: current.id, userId: a.sender_id,
              spec: { title: getParam(db, taskId, 'draft.title') ?? task.title, scope: current.scope, verify_command: getParam(db, taskId, 'draft.verify_command') ?? undefined,
                rules: JSON.parse(current.constraints || '[]').map((c) => ({ rule: String(c), approved: true })) } });
          } catch (e) { audit(db, { actorKind: 'system', actorId: 'elicitor', action: 'contract_register_failed', targetType: 'task', targetId: taskId, payload: { error: e.message } }); }
        }
        const resv = reservationOf(a.body);
        if (resv) recordReservation(db, { taskId, subject: tl(L, '批准草案 v{version} 时的保留意见', { version: current?.version ?? '?' }), text: resv, sourceKind: 'contract', sourceId: current?.id ?? null, by: a.sender_id });
        audit(db, { actorKind: 'user', actorId: a.sender_id, action: 'draft_approved', targetType: 'task', targetId: taskId,
          payload: { constitution: current?.id ?? null, version: current?.version ?? null, questionId: qid, answer: String(a.body).slice(0, 200), reservation: resv ? resv.slice(0, 200) : null } });
        return exit('approved', { constitution: current, version: current?.version ?? null });
      }
      if (verdict === 'abandon') {
        db.run(`UPDATE tasks SET status='aborted' WHERE id=?`, taskId);
        audit(db, { actorKind: 'user', actorId: a.sender_id, action: 'draft_abandoned', targetType: 'task', targetId: taskId,
          payload: { questionId: qid, answer: String(a.body).slice(0, 200) } });
        return exit('abandoned');
      }
      // 防循环：连着两次以「A」开头却读成"要改" → 先问清楚，不出新版。按 proposed 退出，守护进程等这条答了再拉。
      const cf = confirmBeforeRevising(db, { taskId, questionId: qid, body: a.body, version: current?.version ?? null });
      if (cf) {
        setParam(db, { taskId, key: 'draft.approval_question', value: cf.questionId, by: { kind: 'agent', id: 'elicitor' }, governance: 'execution' });
        exit('proposed', { confirm: true, questionId: cf.questionId, version: current?.version ?? null });
        return { kind: 'proposed', confirm: true, questionId: cf.questionId, version: current?.version ?? null, text: cf.text };
      }
      feedback = feedbackOf(db, { taskId, questionId: qid, body: a.body });
    }

    // ── 模型回合 ───────────────────────────────────────────────────────────
    const source = getParam(db, taskId, 'draft.source')
      ?? (task.project_id ? db.one(`SELECT source FROM projects WHERE id=?`, task.project_id)?.source ?? null : null);
    const parts = [
      `## 人的想法（原文）\n${idea}`,
      `## 工作区\n${source ? `现有仓库：${source}（你看不到里面的代码；需要了解什么就问人）` : '新项目，空仓库'}`,
    ];
    const answered = priorAnswers(db, taskId);
    if (answered) parts.push(answered);
    // 决定登记：追问器也拿**完整**清单 —— 它在把一句想法变成契约，看不全就会写出和旧约定打架的完成定义。
    {
      const dsec = decisionsSection(db, task.project_id ? { projectId: task.project_id } : { taskId });
      if (dsec) parts.push(`## 已经定下的约定\n${dsec}`);
    }
    if (current) {
      parts.push(`## 上一版草案（v${current.version}）\n${renderDraft({ ...current, title: getParam(db, taskId, 'draft.title') ?? task.title,
        constraints: JSON.parse(current.constraints || '[]'), verify_command: getParam(db, taskId, 'draft.verify_command') ?? '' },
      current.version, getParam(db, taskId, 'draft.notes'), L)}`);
    }
    // 这一条线上人说过的每一句：只给最新一条，前面定下的要求会在下一版里悄悄没了
    { const h = renderRoundHistory(roundHistory(db, { carrierId: taskId })); if (h) parts.push(h); }
    if (feedback) parts.push(`## 人对上一版草案的反馈（经认证通道，具指令效力）\n${feedback}\n\n按反馈出下一版；反馈含糊到无法落笔才再问。`);
    const messages = [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] }];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resp = await client.complete({ tier, system: withOutputLang(SYSTEM, contentLang(db)), messages, tools: [ASK_USER, PROPOSE], maxTokens: MAX_TOKENS, effort: 'high' });
      if (truncatedEmpty(resp)) throw new TruncatedEmptyError('追问器', MAX_TOKENS);
      const calls = toolCallsOf(resp);
      const ask = calls.find((c) => c.name === 'ask_user');
      const prop = calls.find((c) => c.name === 'propose_constitution');
      const errs = [];

      if (ask && !prop) {
        const qs = Array.isArray(ask.args?.questions) ? ask.args.questions.slice(0, MAX_QUESTIONS_PER_ROUND) : [];
        if (!qs.length || qs.some((q) => !q?.text?.trim() || !q?.default_action?.trim())) errs.push('ask_user 的每个问题都要有 text 与 default_action');
        else {
          const ids = recordQuestions(db, { taskId, qs, tier });
          setParam(db, { taskId, key: 'draft.stage', value: 'asking', by: { kind: 'agent', id: 'elicitor' }, governance: 'execution' });
          return exit('asking', { questions: ids, attempts: attempt });
        }
      } else if (prop) {
        const c = prop.args ?? {};
        for (const f of ['title', 'goal', 'scope', 'definition_of_done']) if (!String(c[f] ?? '').trim()) errs.push(`草案缺 ${f}`);
        if (!Array.isArray(c.constraints)) errs.push('constraints 要是数组');
        // 结构化范围：与项目规划器同一道门槛，判据不再从散文里抽
        errs.push(...scopePathProblems(c.scope_paths).map((x) => `scope_paths：${x}`));
        if (!normScopePaths(c.scope_paths).length) errs.push('草案缺 scope_paths：范围要用路径再写一遍（目录写成 src/a/，文件写全名），机器按这一份做越界校验；整个仓库都可能动就写 ["*"]');
        errs.push(...verifyCommandProblems(c.verify_command));
        if (!errs.length) {
          const r = recordProposal(db, { taskId, c, current });
          setParam(db, { taskId, key: 'draft.stage', value: 'proposed', by: { kind: 'agent', id: 'elicitor' }, governance: 'execution' });
          return exit('proposed', { ...r, attempts: attempt });
        }
      } else {
        errs.push(`既没调用 ask_user 也没调用 propose_constitution（stopReason=${resp.stopReason}）。信息够就提草案，不够就问，不要只输出文字。`);
      }

      audit(db, { actorKind: 'agent', actorId: 'elicitor', action: 'draft_attempt', targetType: 'task', targetId: taskId,
        payload: { attempt, rejections: errs, say: textOf(resp).slice(0, 600) || null, stopReason: resp.stopReason } });
      if (attempt === maxAttempts) throw new I18nError('追问器 {n} 次都没给出合法动作：{errs}', { n: maxAttempts, errs: errs.join('；') });
      messages.push({ role: 'assistant', content: resp.content });
      const bad = prop ?? ask;
      if (bad) messages.push({ role: 'tool_results', results: [{ callId: bad.id, name: bad.name, isError: true, content: `被拒：\n- ${errs.join('\n- ')}` }] });
      else messages.push({ role: 'user', content: [{ type: 'text', text: errs[0] }] });
    }
    throw new Error('unreachable');
  } catch (e) {
    exit('failed', { error: String(e.message).slice(0, 300) });
    throw e;
  }
}

/** Ⅱ 级、带默认、走超时链；任务级（node_id NULL），规划器后来也看得到。 */
function recordQuestions(db, { taskId, qs, tier }) {
  const t = now();
  const ttl = timeoutFor(db, taskId, 2);
  const L = contentLang(db);
  const ids = [];
  db.tx(() => {
    for (const q of qs) {
      const id = newId('q');
      db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
              VALUES (?,?,NULL,2,'classifier',?,?,?,?,'open')`,
        id, taskId, `${q.text.trim()}${q.why ? `\n\n${tl(L, '（为什么问：{why}）', { why: String(q.why).trim() })}` : ''}`, q.default_action.trim(), t, ttl ? t + ttl : null);
      routeQuestion(db, { questionId: id, decisionType: 'spec_choice', typeSource: 'hard_rule', at: t });   // 追问器只问规格
      audit(db, { actorKind: 'agent', actorId: 'elicitor', action: 'question_raised', targetType: 'task', targetId: taskId,
        payload: { questionId: id, level: 2, tier, text: q.text.slice(0, 200), defaultAction: q.default_action.slice(0, 200) } });
      ids.push(id);
    }
    db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
  });
  return ids;
}

/** 草案落成 constitutions 的下一版（旧版作废），并起一条 Ⅲ 级批准问题。 */
function recordProposal(db, { taskId, c, current }) {
  const t = now();
  const version = (current?.version ?? 0) + 1;
  const cid = newId('c');
  const qid = newId('q');
  const by = { kind: 'agent', id: 'elicitor' };
  const constraints = c.constraints.map((x) => String(x));
  const verify = String(c.verify_command ?? '').trim();
  const text = renderDraft({ ...c, constraints, verify_command: verify }, version, c.notes, contentLang(db));
  db.tx(() => {
    if (current) db.run(`UPDATE constitutions SET superseded_at=?, valid_to=? WHERE id=?`, t, t, current.id);
    db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,scope_paths,definition_of_done,constraints,valid_from,recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`, cid, taskId, version, c.goal, c.scope, JSON.stringify(normScopePaths(c.scope_paths)), c.definition_of_done, JSON.stringify(constraints), t, t);
    setParam(db, { taskId, key: 'draft.title', value: String(c.title).trim(), by, governance: 'execution' });
    setParam(db, { taskId, key: 'draft.verify_command', value: verify, by, governance: 'execution' });
    setParam(db, { taskId, key: 'draft.notes', value: String(c.notes ?? ''), by, governance: 'execution' });
    // Ⅲ 级：无默认、无超时（库层 CHECK）。签字这件事永远等人。
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, qid, taskId, text, t);
    routeQuestion(db, { questionId: qid, decisionType: 'contract_approval', typeSource: 'hard_rule', prefixes: specPrefixes([{ scope_paths: c.scope_paths }]).length ? specPrefixes([{ scope_paths: c.scope_paths }]) : null, at: t });
    setParam(db, { taskId, key: 'draft.approval_question', value: qid, by, governance: 'execution' });
    db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
    audit(db, { actorKind: 'agent', actorId: 'elicitor', action: 'draft_proposed', targetType: 'task', targetId: taskId,
      payload: { constitution: cid, version, questionId: qid, title: String(c.title).slice(0, 120), verifyCommand: verify || null } });
  });
  return { constitutionId: cid, version, questionId: qid, text };
}
