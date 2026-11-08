// 交付与签收：任务 done 之后，把分支推到远端、开 PR、由人签收。
//
// 设计：agent 提交"完成声明 + 终版报告"，人可接受或打回；**高风险任务强制人工签收**；
// v1 验收场景 = 存量 repo + issue → 测试通过的分支 / PR + 人工签收。
//
// 三条边界：
//   - 只交付 **done** 的任务：done 的定义是"节点全部交接合格 + 任务级验收命令过"，交付不再另判。
//   - 开 PR 是**对外承诺**（强制审批那一类）：含 high 风险节点的任务，没有人签收就不开 PR；push 到分支不算对外承诺。
//   - PR 正文只从真相源来：最近一份 task_done 汇报（模板或模型写的都行）。没有就现场按事实渲染，不另调模型。
//
// 凭据：按"动作 + 远端 + 点交付的人"从连接里现场挑一份（core/credentials.mjs），审计记下用了哪一份；
// 推送只走 core/push.mjs 的护栏。没有能调 GitHub 接口的连接就 push 完停下来，告诉人去哪里加。
// 打回 = 一条 correction 消息（走修正流水线重规划），不是另一条状态机分支 —— 打回的本质就是"要求改"。

import { audit, newId, now, insertEdge } from '../db/db.mjs';
import { insertUserMessage } from '../db/messages.mjs';
import { recordAnswer, RESOLUTION_HOOKS, resolutionOf } from './answers.mjs';
import { routeQuestion, requireAuthorized } from './routing.mjs';
import { gatherSince, renderFacts, renderSelfDecided } from '../agent/reporter.mjs';
import { deferSignoff, deferredSignoffs } from './project-settings.mjs';
import { contributionOf, baseHeadOf } from './workspace.mjs';
import { gateHooks, reasonLines, lazySandbox, askKey } from './hooks.mjs';
import { hasComparableDecisions } from './decisions.mjs';
import { holdForCheck } from './inbox.mjs';
import { tl, contentLang, userLang, I18nError } from '../i18n/index.mjs';
import { markOf } from '../i18n/marks.mjs';

import { git, gitRaw, safePositional } from './git.mjs';
import { HTTP_TIMEOUT_MS } from './http.mjs';
import { transition } from '../db/state.mjs';
import { acquireLease, releaseLease, startHeartbeat } from '../db/lease.mjs';
import { insertQuestion } from './questions.mjs';
import { writeParam } from './params.mjs';
import { resolveCredential, noCredentialText, parseRemote } from './credentials.mjs';
import { taskProvenanceMarkdown } from './provenance-render.mjs';
const userName = (db, id) => (id ? db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? null : null);
import { pushBranch } from './push.mjs';
import { signoffExceptions, renderExceptions } from './signoff-exceptions.mjs';
import { recordDeliveredPr, notePrPushed, prOf, prStateOf } from './pr-watch.mjs';

const setParam = (db, { taskId, key, value, userId }) => writeParam(db, { taskId, key, value, by: { kind: 'user', id: userId }, governance: 'constitutional' });
const getParam = (db, taskId, key) => {
  const row = db.one(`SELECT value FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, taskId, key);
  return row ? JSON.parse(row.value) : null;
};

/**
 * 远端：显式给的优先；否则用上次交付记下的 `delivery.remote`。**没有就拒**，不猜。
 *
 * 不猜"来源仓库的 origin"：工作区克隆自第三方仓库时，那会把分支往
 * **第三方上游**推 —— 没凭据时卡在凭据提示上，
 * 但方向本身就是错的：往别人的仓库推分支是对外动作，不该由一个默认值决定。
 */
export function remoteFor(db, taskId, override = null) {
  if (override) return override;
  const prev = getParam(db, taskId, 'delivery.remote');
  if (prev) return prev;
  throw new I18nError('未指定远端仓库：首次交付必须填写远端地址（--remote <url>），之后沿用上次的地址');
}

/** `git@github.com:o/r.git` / `https://github.com/o/r(.git)` → {owner, repo}；不是 GitHub 就 null。 */
export function parseGithub(remote) {
  const m = String(remote).match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * push 用的环境：禁交互；远端是 GitHub HTTPS 且有 token 时，把 token 作为 http.extraheader 只放进环境变量
 * （GIT_CONFIG_* 机制）—— 不进命令行参数、不写 git config、不进 URL，进程列表和审计轨里都看不到它。
 * 其它远端（本机路径、SSH、别的托管）不动：仍走机器上已有的凭据。
 */
export function pushEnv(remote, token = process.env.GITHUB_TOKEN) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const gh = parseGithub(remote);
  if (gh && token && /^https:\/\/github\.com\//i.test(String(remote))) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
  }
  return env;
}

/**
 * 这次交付用哪份连接。`token` 显式给了（测试）就用它、不走解析；否则按连接解析。
 * 返回的东西用完要 cleanup()（SSH 密钥的临时文件）。
 */
export async function connectFor(db, { remote, action, actorId, token = undefined, env = process.env, fetchFn = globalThis.fetch, workflows = false, skip = [] }) {
  if (token !== undefined) {
    return { target: parseRemote(remote), credential: token ? { id: null, name: 'explicit', kind: 'token' } : null, gitEnv: pushEnv(remote, token || undefined),
      apiToken: token || null, apiBase: 'https://api.github.com', tried: [], cleanup: () => {} };
  }
  return resolveCredential(db, { remote, action, actorId, env, fetchFn, workflows, skip });
}

/**
 * 解析连接并推送。两种情况换一份再推：
 *   - 挑中的连接推不上去（鉴权 / 权限不够）：跳过它、换下一份（一份只授权了一两个仓库、范围却填成全部的个人令牌，
 *     原来会把它主人的所有交付都卡死在"推不了"上）。审计记 credential_push_failed。
 *   - GitHub App 推改了 .github/workflows/ 的提交被拒（安装令牌默认不带 workflows 权限）：带上 workflows 权限重签一次再推。
 * @returns {Promise<object>} 连接解析结果（开 PR 要用 apiToken；用完 cleanup）
 */
export async function connectAndPush(db, { dir, remote, src, branch, action, actorId, token, env, fetchFn, internal = false }) {
  const L = contentLang(db);
  const skipped = [];
  let workflows = false;
  let conn = await connectFor(db, { remote, action, actorId, token, env, fetchFn });
  for (let round = 0; ; round++) {
    try {
      pushBranch(db, { dir, remote, src, branch, env: conn.gitEnv, internal, actorId });
      conn.tried = [...skipped.map(({ name, why }) => ({ name, why })), ...conn.tried];
      return conn;
    } catch (e) {
      conn.cleanup();
      const canRetry = token === undefined && round < 6;
      if (e.code === 'WORKFLOW_SCOPE' && canRetry && conn.app && !workflows) {
        workflows = true;
        conn = await connectFor(db, { remote, action, actorId, env, fetchFn, workflows, skip: skipped.map((x) => x.id) });
        if (!conn.app) throw new I18nError('{error}。{why}', { error: e.message, why: noCredentialText(db, conn) });
        continue;
      }
      if (e.code === 'PUSH_AUTH' && canRetry && conn.credential?.id) {
        const why = tl(L, '推不上去（{error}），换下一份', { error: String(e.message).split('：').pop().slice(0, 160) });
        skipped.push({ id: conn.credential.id, name: conn.credential.name, why });
        audit(db, { actorKind: actorId ? 'user' : 'system', actorId, action: 'credential_push_failed', targetType: 'credential', targetId: conn.credential.id,
          payload: { remote, branch, name: conn.credential.name } });
        conn = await connectFor(db, { remote, action, actorId, env, fetchFn, workflows, skip: skipped.map((x) => x.id) });
        conn.tried = [...skipped.map(({ name, why: w }) => ({ name, why: w })), ...conn.tried];
        if (!conn.credential) throw new I18nError('{error}。{why}', { error: e.message, why: noCredentialText(db, conn) });
        continue;
      }
      // 没有连接、用服务器上 git 自己的凭据也没推上：把"试过哪些、去哪里加"一并说出来（护栏拒绝的不加：跟凭据无关）
      if (!conn.credential && conn.target.scheme !== 'local' && !e.pushRefused) {
        throw new I18nError('{error}。{why}', { error: e.message, why: noCredentialText(db, conn) });
      }
      throw e;
    }
  }
}

export const hasHighRisk = (db, taskId) =>
  db.one(`SELECT count(*) AS n FROM nodes WHERE task_id=? AND risk_tier='high' AND status<>'void'`, taskId).n > 0;
export const signoffOf = (db, taskId) => getParam(db, taskId, 'signoff.status');
export const signoffHeadOf = (db, taskId) => getParam(db, taskId, 'signoff.head');

/** 任务 done 那一刻产物所在的 commit（task_done 审计里的 head）。 */
export function doneHeadOf(db, taskId) {
  const row = db.one(`SELECT payload FROM audit_log WHERE action='task_done' AND target_id=? ORDER BY id DESC LIMIT 1`, taskId);
  try { return row ? JSON.parse(row.payload).head ?? null : null; } catch { return null; }
}

/**
 * 签收正文里的**产物证据**。
 *
 * 例：汇报里同时写着"两条修正已应用"和"批准后再改文档"，签收人判断不出文档到底改没改，
 * 只能回"把实际文字贴出来我再签"——产物其实早就对了，白等一轮。签收人手里只有汇报（二手转述），
 * 而**一手的东西（diff）机器本来就有**，没有理由不贴。
 *
 * 两个口径：返工后的签收比 `上次签收的 commit`（人这次真正要看的是"这一轮改了什么"），
 * 第一次签收比 `工作区起点`（这个任务一共产出了什么）。
 * 差异大就只给 --stat 加一条自己看的命令——签收正文会进通知与摘要，不能塞进去几千行。
 */
export const DIFF_INLINE_MAX_LINES = 400;
export function signoffEvidence(dir, { since, head, rework = false, contribution = null, lang = 'zh' }) {
  if (!dir || !head || !since || since === head) return '';
  // 返工那一档要同时受两条线约束：
  //   「这一轮改了什么」= 上次签收..现在    「这个任务自己贡献了什么」= merge-base..现在
  // 集成（把项目分支合进来）带进来的别人的产物只落在前者里。把它从 diff 里摘出去、单独记一行，
  // 而不是混在正文里：签收人要判的是这一轮，而集成不是任何人做的内容决定。
  let mineThisRound = null;
  let brought = [];
  if (rework && contribution?.via === 'merge-base' && Array.isArray(contribution.files)) {
    let round;
    try { round = git(dir, 'diff', '--name-only', `${since}..${head}`).split('\n').filter(Boolean); } catch { return ''; }
    const mine = new Set(contribution.files);
    brought = round.filter((f) => !mine.has(f));
    if (brought.length) mineThisRound = round.filter((f) => mine.has(f));   // 没有带进来的东西 → 与改动前一模一样地渲染
  }
  const paths = mineThisRound ? ['--', ...mineThisRound] : [];
  const L = lang;
  const broughtNote = brought.length
    ? tl(L, '（另有 {n} 个文件是把项目分支合进来带来的，不是这一轮改的：{files}）', { n: brought.length, files: `${brought.slice(0, 8).join(L === 'en' ? ', ' : '、')}${brought.length > 8 ? ' …' : ''}` })
    : null;
  const what = rework ? tl(L, '本轮（上次签收 {since} 之后）的改动', { since: since.slice(0, 8) }) : tl(L, '本任务的全部改动（自 {since}）', { since: since.slice(0, 8) });
  const end = (lines) => [...lines, ...(broughtNote ? [broughtNote] : [])].join('\n');
  if (mineThisRound && !mineThisRound.length) return end([tl(L, '## 产物'), tl(L, '{what}：没有文件变化。', { what })]);
  let stat, churn = Infinity;
  try {
    stat = git(dir, 'diff', '--stat', `${since}..${head}`, ...paths);
  } catch { return ''; }   // 工作区没了 / commit 不在：不编，也不因此挡住签收
  if (!stat.trim()) return end([tl(L, '## 产物'), tl(L, '{what}：没有文件变化。', { what })]);
  const m = stat.match(/(\d+) insertions?\(\+\)|(\d+) deletions?\(-\)/g);
  churn = (m ?? []).reduce((s, x) => s + Number(x.match(/\d+/)[0]), 0);
  const out = [tl(L, '## 产物'), tl(L, '{what}：', { what }), '```', stat.trim(), '```'];
  if (churn <= DIFF_INLINE_MAX_LINES) {
    try {
      const body = git(dir, 'diff', `${since}..${head}`, ...paths);
      if (body.trim()) out.push('```diff', body.trim(), '```');
    } catch { /* 太大 / 编码问题：上面的 --stat 已经够定位 */ }
  } else {
    out.push(tl(L, '（改动 {n} 行，正文里不贴全文。看全文：{cmd}）', { n: churn, cmd: `git -C ${dir} diff ${since.slice(0, 8)}..${head.slice(0, 8)}${paths.length ? ` -- ${mineThisRound.join(' ')}` : ''}` }));
  }
  return end(out);
}

/** 当前开着的签收事项。 */
export const openSignoffQuestion = (db, taskId) => db.one(
  `SELECT * FROM questions WHERE task_id=? AND decision_type='signoff' AND status IN ('open','escalated') ORDER BY asked_at DESC LIMIT 1`, taskId);

/**
 * 任务 done → 一条"签收"决策事项，按路由表找人。**不改任务状态**（done 就是 done）。
 * 签收挂在具体的产物 commit 上。产物在签收后再变（修正流水线、重规划后再 done）→ 旧签收作废、重新进签收事项。
 * 零模型调用；幂等：同一 head 已有开着的签收事项就不再建。
 */
export function raiseSignoffQuestion(db, { taskId, head, branch = null, dir = null, at = now() }) {
  // 后置签收：自动挡下 AI 自己加的任务，验收过了就合并，签收攒到交付前一次做。
  // 判断放在这个唯一的入口里，不放在调用方 —— 调用方有三处，散开写迟早有一处漏掉，
  // 而漏掉的表现是"自动挡下仍然逐个弹签收"，看起来只是啰嗦，实际上挡位就没生效。
  if (deferSignoff(db, taskId)) {
    setParam(db, { taskId, key: 'signoff.head', value: head ?? null, userId: null });
    setParam(db, { taskId, key: 'signoff.status', value: 'deferred', userId: null });
    audit(db, { actorKind: 'system', action: 'signoff_deferred', targetType: 'task', targetId: taskId,
      payload: { head, branch, why: tl(contentLang(db), '预算内自动开工、合并挡：AI 自己加的任务，签收后置到交付前批量做') } });
    return { questionId: null, deferred: true };
  }
  const prev = signoffOf(db, taskId);
  const prevHead = signoffHeadOf(db, taskId);
  // 同一个提交已经签过收：不再问一遍（签收挂在提交上，提交没变签收就还算数）。
  // 走到这里的典型是"合并卡住 → AI 只撤掉了没提交的改动"：签过的那一版一个字没变，再弹一条签收就是白添一条事项。
  if (prev === 'accepted' && head && prevHead === head) return { questionId: null, alreadySigned: true };
  const cur = openSignoffQuestion(db, taskId);
  if (cur && (prevHead === head || !head)) return { questionId: cur.id, reused: true };
  const id = newId('q');
  const task = db.one(`SELECT title FROM tasks WHERE id=?`, taskId);
  const rework = !!(prevHead && prevHead !== head);
  // 归属基线走 contributionOf：第一次签收直接用它的 base；返工那一档 since 仍是上次签收的头，
  // 但把 contribution 一起递进去，好把"集成带进来的"从这一轮的 diff 里摘出去。
  const contribution = contributionOf(db, { taskId, dir, head });
  const L = contentLang(db);
  const evidence = signoffEvidence(dir, { since: rework ? prevHead : contribution.base, head, rework, contribution, lang: L });
  // 选项块的形状（请选一条：/ Please pick one: 起头，紧接 (A)(B)(C) 三行）看板按它换成按钮说明，英文译文必须同形
  const text = `${markOf(L, 'signoff')}${tl(L, '任务「{title}」已完成，产物在 {branch} @ {head}。', { title: task?.title ?? taskId, branch: branch ?? tl(L, '工作区分支'), head: String(head ?? '').slice(0, 8) || tl(L, '（未知 commit）') })}\n\n`
    + (prev === 'accepted' && prevHead && prevHead !== head ? `${tl(L, '注意：上次签收对应 {head}，此后产物已变更，该签收已作废，需要重新签收。', { head: prevHead.slice(0, 8) })}\n\n` : '')
    // 过程里出过的岔子置顶在产物之前（看板按结构另画一份，这里给命令行 / 通知看）
    + `${renderExceptions(signoffExceptions(db, taskId), L)}\n\n`
    + (evidence ? `${evidence}\n\n` : '')
    + tl(L, '请选一条：\n(A) 接受：点「接受」\n(B) 打回：点「打回…」写理由（理由会作为修正指令，任务据此重新规划）\n(C) 先看清楚：看下面的「改动」「页面截图」，或任务页的「日志」，看完再选');
  return db.tx(() => {
    if (prev === 'accepted' && prevHead && prevHead !== head) {
      setParam(db, { taskId, key: 'signoff.status', value: 'void', userId: null });
      audit(db, { actorKind: 'system', action: 'signoff_voided', targetType: 'task', targetId: taskId, payload: { signedHead: prevHead, newHead: head } });
    }
    if (cur) transition(db, 'questions', cur.id, 'withdrawn', { set: { resolved_at: at } });
    insertQuestion(db, { id: id, taskId: taskId, level: 3, text: text, askedAt: at });
    const r = routeQuestion(db, { questionId: id, decisionType: 'signoff', typeSource: 'hard_rule', at });
    setParam(db, { taskId, key: 'signoff.head', value: head ?? null, userId: null });
    // 这一轮从哪儿起（看板改动对比的"这一轮"口径用）：返工 = 上次请求签收时的头；第一次签收显式写 null（不是"没记"）
    setParam(db, { taskId, key: 'signoff.since', value: rework ? prevHead : null, userId: null });
    if (prev !== 'accepted' || prevHead !== head) setParam(db, { taskId, key: 'signoff.status', value: 'pending', userId: null });
    audit(db, { actorKind: 'system', action: 'signoff_requested', targetType: 'task', targetId: taskId, payload: { questionId: id, head, branch, addressedTo: r.answerers } });
    return { questionId: id, reused: false, addressedTo: r.answerers };
  });
}

// 签收事项有结论时（够法定人数且一致 / 负责人裁定 / 冲突了结）：接受 → 写参数；打回 → 一条修正（用签收人的令牌，走修正流水线）。
RESOLUTION_HOOKS.signoff = (db, { question, finalBody, by, messageId, at }) => {
  const taskId = question.task_id;
  const head = signoffHeadOf(db, taskId);
  if (/^(接受|accept)/i.test(String(finalBody).trim())) {
    setParam(db, { taskId, key: 'signoff.status', value: 'accepted', userId: by });
    audit(db, { actorKind: 'user', actorId: by, action: 'task_signed_off', targetType: 'task', targetId: taskId, payload: { accepted: true, head, highRisk: hasHighRisk(db, taskId), questionId: question.id } });
    return { accepted: true };
  }
  // 中英两种写法都认（signoffAnswer 归一成「打回：…」或「Reject: …」；send back 与看板英文按钮同名）
  const reason = String(finalBody).replace(/^(打回|reject(ed)?|send\s+back)[:：]?\s*/i, '').trim() || finalBody;
  // 修正消息复用打回那条答复的令牌（同一人、同一决策、系统代拟）—— 这是边界，不是先例：认证链完整（token_id 指向签收人
  // 亲自签的那条 message），且超时默认永远不会走到这里（签收类型禁配 default，见 DECISION_TYPES.noDefault），
  // 所以不存在"系统替人签名"的路径。别把这个模式推广到任何不是同一人、同一决策的地方。
  const tok = db.one(`SELECT token_id FROM messages WHERE id=?`, messageId)?.token_id ?? null;
  const mid = newId('m');
  insertUserMessage(db, { id: mid, taskId, senderId: by, tokenId: tok, body: `${markOf(contentLang(db), 'signoffRejected')}${reason}`, kind: 'correction', urgency: 'urgent', receivedAt: at });
  insertEdge(db, mid, messageId, 'derived_from', at);
  // 打回理由接下来要和已登记的决定比对（调用方在 recordAnswer 之后跑），比对完之前这条修正先别被拉走。
  // 只在真有可比的决定时才标 —— 否则比对必然跳过，标了只是白等。比对器没跑到（进程死了）时到点自己放行。
  if (hasComparableDecisions(db, taskId)) holdForCheck(db, [mid], { at });
  setParam(db, { taskId, key: 'signoff.status', value: 'rejected', userId: by });
  // 打回 = 还有活要干：任务从 done 放回 running。守护进程只拉 running 的任务 —— 不放回去，这条修正就永远没人处理
  // （否则打回签收后任务一直没有动静；手动模式下人会自己 run，所以不容易暴露）。
  const was = db.one(`SELECT status FROM tasks WHERE id=?`, taskId)?.status;
  if (was === 'done') {
    transition(db, 'tasks', taskId, 'running');
    audit(db, { actorKind: 'user', actorId: by, action: 'task_resumed', targetType: 'task', targetId: taskId, payload: { from: 'done', to: 'running', via: 'signoff_rejected' } });
  }
  audit(db, { actorKind: 'user', actorId: by, action: 'task_signed_off', targetType: 'task', targetId: taskId, payload: { accepted: false, reason, messageId: mid, head, questionId: question.id } });
  audit(db, { actorKind: 'user', actorId: by, action: 'message_received', targetType: 'task', targetId: taskId, payload: { messageId: mid, kind: 'correction', kindSource: 'explicit', urgency: 'urgent', urgencySource: 'explicit', via: 'signoff' } });
  return { accepted: false, messageId: mid };
};

/** PR 正文：最近一份 task_done 汇报；没有就按事实渲染。**不调模型**。 */
export function finalReport(db, taskId) {
  const rep = db.one(`SELECT * FROM reports WHERE task_id=? AND trigger='task_done' ORDER BY created_at DESC, rowid DESC LIMIT 1`, taskId);
  if (rep) return { summary: rep.summary, body: rep.body, source: `report:${rep.id}` };
  const f = gatherSince(db, taskId, (db.one(`SELECT created_at FROM tasks WHERE id=?`, taskId)?.created_at ?? 1) - 1);
  const L = contentLang(db);
  return { summary: tl(L, '任务完成：节点 {counts}', { counts: JSON.stringify(f.counts) }), body: `${renderFacts(f, L)}\n\n${renderSelfDecided(f, L)}`, source: 'facts' };
}

/**
 * 交付前的策略钩子（fail-closed）。拦下 → 抛错，没有推送。要人确认 → 抛错，e.hookAsk = 确认码；
 * 点交付的人看过钩子的话，带上 hookAck: [确认码] 再交付一次。确认码绑着那一份理由：钩子说的变了就要重新确认，
 * 拦下的不认确认码。"任务改了钩子文件"也是要人确认的一种：确认后照改过的版本跑一遍（又要确认就再问一次）。
 */
export async function deliverGate(db, { taskId, projectId = null, workspace, ref, makeExec = null, payload = {}, hookAck = [], userId = null }) {
  const L = contentLang(db);
  const acks = [].concat(hookAck ?? []).map(String);
  const tr = (k, p) => tl(L, k, p);
  // 改过的钩子文件那一问的确认码只看文件列表 —— 先按不放行跑，认得这个码再照新版本跑
  let r = await gateHooks(db, { event: 'PreDeliver', taskId, projectId, workspace, ref, makeExec, payload });
  if (r?.tampered?.length && acks.includes(askKey(r, []))) {
    audit(db, { actorKind: userId ? 'user' : 'system', actorId: userId, action: 'deliver_hook_acked', targetType: 'task', targetId: taskId, payload: { projectId, tampered: r.tampered } });
    r = await gateHooks(db, { event: 'PreDeliver', taskId, projectId, workspace, ref, makeExec, payload, allowTamper: true });
  }
  if (!r || r.decision === 'allow') return r;
  const lines = r.tampered?.length ? [] : reasonLines(r, tr);
  const why = lines.length ? lines.map((x) => `- ${x}`).join('\n') : tl(L, '- （钩子没写理由）');
  if (r.decision === 'deny') {
    throw Object.assign(r.failed
      ? new I18nError('交付前的策略钩子自己没跑成（脚本崩了、超时、输出看不懂，或者没核准），不是检查没过，没有推送：\n{why}\n先把钩子修好再交付', { why })
      : new I18nError('交付前的策略钩子拦下了，没有推送：\n{why}', { why }), { hookDeny: true, hookFailed: !!r.failed });
  }
  const key = askKey(r, lines);
  if (acks.includes(key)) {
    audit(db, { actorKind: userId ? 'user' : 'system', actorId: userId, action: 'deliver_hook_acked', targetType: 'task', targetId: taskId, payload: { projectId, key, reasons: lines } });
    return r;
  }
  throw Object.assign(r.tampered?.length
    ? new I18nError('交付前要你确认：这个任务改了策略钩子文件（{files}），改过的钩子还没有跑。确认后照改过的版本跑一遍再推送', { files: r.tampered.join(tl(L, '、')) })
    : new I18nError('交付前的策略钩子要你确认：\n{why}', { why }), { hookAsk: key });
}
/** 给钩子看的远端地址：去掉 URL 里可能带着的账号口令 */
const bareRemote = (u) => String(u ?? '').replace(/\/\/[^@/]*@/, '//');

/**
 * 交付。push 总是做；`pr` 为真时开 PR（要 token、要 GitHub 远端、高风险要签收）。
 * @param {object} o  { taskId, workspace, remote?, branch?, pr?, base?, token?, fetchFn?, userId }
 */
export async function deliverTask(db, opts) {
  // 项目推进合并时调（internal）：那头已经拿着这个任务的租约
  if (opts.internal) return deliverTaskHeld(db, opts);
  // 人点交付 / CI 修好之后再推：拿这个任务的租约，与编排器（人发来修正、守护进程拉起它）互斥。
  // 交付前的策略钩子可能跑一阵（起沙箱），原来这期间编排器提交的新东西会被一起推出去 —— 推的是推送那一刻的 HEAD，
  // PR 正文写的却是开头读的那个头。现在推的就是开头核过签收的那个提交。
  const res = `task:${opts.taskId}`;
  let lease;
  try { lease = acquireLease(db, res, { meta: { pid: process.pid, op: 'deliver' } }); }
  catch (e) { if (e.leaseHeld) throw Object.assign(new I18nError('没有交付：这个任务正在被处理（AI 在改它，或系统正在把它合并进项目）。等任务页顶上不再显示「在跑」再点交付 —— 交付出去的必须是签收时看过的那一版，不能带上正在改的东西'), { status: 409, busy: true }); throw e; }
  const stop = startHeartbeat(db, res, lease.epoch);
  try { return await deliverTaskHeld(db, opts); }
  finally { stop(); try { releaseLease(db, res, lease.epoch); } catch { /* 会自然到期 */ } }
}

async function deliverTaskHeld(db, { taskId, workspace, remote = null, branch = null, pr = false, base = null,
  token = undefined, env = process.env, fetchFn = globalThis.fetch, userId = null, tokenId = null, autofix = true, internal = false, home = null, makeExec = null, hookAck = [] }) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
  if (!task) throw new I18nError('任务不存在：{id}', { id: taskId });
  if (task.status !== 'done') {
    throw new I18nError('任务状态为 {status}，只能交付已完成（done）的任务', { status: task.status });
  }
  const L = contentLang(db);
  if (userId) requireAuthorized(db, { taskId, decisionType: 'delivery', userId });   // 交付是决策类型之一：查路由表，不查 role
  const target = safePositional(remoteFor(db, taskId, remote));
  const head = git(workspace, 'rev-parse', 'HEAD');
  const br = branch ?? git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (git(workspace, 'status', '--porcelain')) throw new I18nError('工作区有未提交的改动，请先处理后再交付');

  // 高风险 + 要开 PR + 没签收 → 拒。push 不拒：分支在远端上不是对外承诺。
  const gh = parseGithub(target);
  const highRisk = hasHighRisk(db, taskId);
  let signoff = signoffOf(db, taskId);
  // 签收挂在 commit 上。签的不是现在要推的这个 head → 那次签收不算数。
  const signedHead = signoffHeadOf(db, taskId);
  if (signoff === 'accepted' && signedHead && signedHead !== head) signoff = 'stale';
  if (pr && highRisk && signoff !== 'accepted') {
    throw signoff === 'stale'
      ? new I18nError('签收对应 {signed}，此后产物已变更（当前 {head}），请重新签收后再创建 PR', { signed: signedHead.slice(0, 8), head: head.slice(0, 8) })
      : new I18nError('任务包含高风险步骤，创建 PR 前必须先完成签收');
  }

  // 交付前的策略钩子：推到本机项目仓库（internal）不过 —— 那一步前面有合并前钩子
  if (!internal) {
    const ref = baseHeadOf(db, taskId) ?? 'HEAD';
    let changed = [];
    try { changed = git(workspace, 'diff', '--name-only', ref, 'HEAD').split('\n').filter(Boolean); } catch { changed = []; }
    await deliverGate(db, { taskId, projectId: task.project_id ?? null, workspace, ref, hookAck, userId,
      makeExec: makeExec ?? (home ? lazySandbox(db, taskId, home) : null),
      payload: { target: 'task', task: { id: taskId, title: task.title }, remote: bareRemote(target), branch: br, head, pr: !!pr, changed_files: changed } });
  }

  // 推送：连接按"动作 + 远端 + 点交付的人"现场解析；护栏在 core/push.mjs（只推自己的分支、不推默认分支、不强推）。
  // 推到本机的项目仓库（项目推进时）是 internal：系统自己的地盘，不受护栏约束。禁交互、有时限都在 git 封装里。
  const conn = await connectAndPush(db, { dir: workspace, remote: target, src: head, branch: br, action: pr && gh ? 'pr' : 'push', actorId: userId, token, env, fetchFn, internal });
  const out = { remote: target, branch: br, head, pushedAt: now(), pr: null, prSkipped: null, credential: conn.credential };

  conn.cleanup();   // SSH 密钥的临时文件推完就删；开 PR 用的是内存里的 API 令牌
  // 这个分支已经开着 PR（再次交付，比如修 CI 之后）：推送就更新了它，不再开一个（GitHub 会回 422）
  const open = !internal && gh ? openPrFor(db, { taskId }, gh, br) : null;
  if (open) { out.pr = { url: open.url, number: open.number, base: open.base, updated: true }; notePrPushed(db, { taskId, head }); }
  if (pr && !open) {
    if (!gh) out.prSkipped = tl(L, '远端不是 GitHub（{target}），已推送，未创建 PR', { target });
    else if (!conn.apiToken) out.prSkipped = tl(L, '已推送，未创建 PR：没有能调用 GitHub 接口的连接。到「设置 → 连接」加一个 GitHub App 或令牌后重新交付即可');
    else {
      const token = conn.apiToken;
      const report = finalReport(db, taskId);
      const baseBranch = base ?? (await defaultBranch(gh, token, fetchFn, conn.apiBase));
      const res = await fetchFn(`${conn.apiBase}/repos/${gh.owner}/${gh.repo}/pulls`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json',
          'user-agent': 'superintern' },
        body: JSON.stringify({ title: task.title, head: br, base: baseBranch,
          body: `${report.summary}\n\n${report.body}\n\n${tl(L, '## 溯源')}\n\n${taskProvenanceMarkdown(db, taskId, { L, dir: workspace, delivery: { by: userName(db, userId), credential: conn.credential?.name ?? null } })}\n\n---\n`
            + tl(L, '由 SuperIntern 交付：任务 `{taskId}`，分支 `{branch}` @ {head}。正文取自真相源（{source}），不是模型现场写的。', { taskId, branch: br, head: head.slice(0, 8), source: report.source }) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new I18nError('创建 PR 失败：HTTP {status} {body}', { status: res.status, body: JSON.stringify(json).slice(0, 300) });
      out.pr = { url: json.html_url, number: json.number, base: baseBranch };
      setParam(db, { taskId, key: 'delivery.pr_url', value: json.html_url, userId });
      recordDeliveredPr(db, { taskId, gh, pr: out.pr, branch: br, head, userId, tokenId, signed: signoff === 'accepted', autofix });
    }
  }
  setParam(db, { taskId, key: 'delivery.remote', value: target, userId });
  setParam(db, { taskId, key: 'delivery.head', value: head, userId });
  audit(db, { actorKind: 'user', actorId: userId, action: 'task_delivered', targetType: 'task', targetId: taskId,
    payload: { ...out, highRisk, signoff, ...(internal ? { internal } : {}) } });
  return out;
}

/** 这个仓库、这个分支上记着的、还开着（或还没看过）的 PR */
export function openPrFor(db, ref, gh, branch) {
  const p = prOf(db, ref);
  if (!p || p.owner !== gh.owner || p.repo !== gh.repo || p.branch !== branch) return null;
  const st = prStateOf(db, ref)?.state;
  return st === 'merged' || st === 'closed' ? null : p;
}

async function defaultBranch(gh, token, fetchFn, apiBase = 'https://api.github.com') {
  const res = await fetchFn(`${apiBase}/repos/${gh.owner}/${gh.repo}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'superintern' } });
  const json = await res.json().catch(() => ({}));
  return json.default_branch ?? 'main';
}

/**
 * 签收。接受 → 记参数 + 审计；打回 → 一条 correction 消息（人认证的），任务下次 run 走修正流水线重规划。
 * 打回不另开一条状态机分支：打回的本质就是"要求改"，而"要求改"已经有一条完整的路。
 */
export function signOff(db, { taskId, accept, reason = null, plaintextToken, userId }) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
  if (!task) throw new I18nError('任务不存在：{id}', { id: taskId });
  if (task.status !== 'done') throw new I18nError('任务状态为 {status}，只能签收已完成（done）的任务', { status: task.status });
  if (!accept && !reason?.trim()) throw new I18nError('打回必须填写理由；理由将作为修正指令，任务据此重新规划');
  // 签收是决策事项：谁能签由路由表决定（负责人恒可；同行评审模板下要够法定人数）。
  requireAuthorized(db, { taskId, decisionType: 'signoff', userId });
  // 事项不在（老任务、或 done 时还没有这条机制）就按 done 时的 head 现建一条，再答它。
  let q = openSignoffQuestion(db, taskId);
  if (!q) {
    // 这一轮 done 已经签过了：两个人前后脚点签收、或页面没刷新，后到的一方原来会现建一条新的签收事项再签一次 ——
    // 点的是"打回"的话，就把已经签收通过的任务打回去了。签收事项是在最近一次进入 done 之后提的、且已结，就是这一轮签过了。
    const lastDone = db.one(`SELECT max(ts) t FROM audit_log WHERE target_id=? AND action='status_changed' AND json_extract(payload,'$.to')='done'`, taskId)?.t ?? null;
    const prev = db.one(`SELECT * FROM questions WHERE task_id=? AND decision_type='signoff' ORDER BY asked_at DESC, rowid DESC LIMIT 1`, taskId);
    if (prev && !['open', 'escalated'].includes(prev.status) && (lastDone == null || prev.asked_at >= lastDone)) {
      const r = resolutionOf(db, prev);
      throw Object.assign(new I18nError('任务 {id} 这一轮已由 {who} 于 {when} 签收（{body}），不再重复签收', { id: taskId, who: r.who, when: r.when,
        body: String(db.one(`SELECT body FROM answers WHERE question_id=? AND stance='answer' ORDER BY created_at DESC LIMIT 1`, prev.id)?.body ?? r.how).slice(0, 60) }), { status: 409, handled: r });
    }
    raiseSignoffQuestion(db, { taskId, head: doneHeadOf(db, taskId) }); q = openSignoffQuestion(db, taskId);
  }
  // 代人写的答复正文按内容语言（与 signoffAnswer 归一后的形状一致）
  const en = contentLang(db) === 'en';
  const r = recordAnswer(db, { questionId: q.id, body: accept ? (en ? 'Accept' : '接受') : (en ? `Reject: ${reason.trim()}` : `打回：${reason.trim()}`), plaintextToken });
  if (!r.resolved) {
    // 回给签收人本人看的一句话：用他的界面语言
    const UL = userLang(db, userId);
    return { accepted: null, pending: r.pending ?? null, conflictId: r.conflictId ?? null, questionId: q.id,
      note: r.conflictId ? tl(UL, '签收意见不一致，已生成冲突事项')
        : (r.pending ?? []).some((p) => p.requester)
          ? tl(UL, '已记下。这个任务是 {name} 提的需求，还要等提需求的人自己签收才算数', { name: db.one(`SELECT display_name FROM users WHERE id=?`, r.pending.find((p) => p.requester).requester)?.display_name ?? tl(UL, '需求提出人') })
          : tl(UL, '尚未达到法定人数：{list}', { list: (r.pending ?? []).map((p) => `${p.have}/${p.need}`).join(UL === 'en' ? ', ' : '、') }) };
  }
  const h = r.hook ?? {};
  return { accepted: !!h.accepted, messageId: h.messageId ?? null, questionId: q.id, how: r.how };
}
