// 交付与签收：任务 done 之后，把分支推到远端、开 PR、由人签收。
//
// 设计：agent 提交"完成声明 + 终版报告"，人可接受或打回；**高风险任务强制人工签收**；
// 典型场景 = 存量 repo + issue → 测试通过的分支 / PR + 人工签收。
//
// 三条边界：
//   - 只交付 **done** 的任务：done 的定义是"节点全部交接合格 + 任务级验收命令过"，交付不再另判。
//   - 开 PR 是**对外承诺**（强制审批那一类）：含 high 风险节点的任务，没有人签收就不开 PR；push 到分支不算对外承诺。
//   - PR 正文只从真相源来：最近一份 task_done 汇报（模板或模型写的都行）。没有就现场按事实渲染，不另调模型。
//
// 令牌：GITHUB_TOKEN 从环境 / .env 来，**只检查在不在，不打印**。没有就 push 完停下来，告诉人去填。
// 打回 = 一条 correction 消息（走修正流水线重规划），不是另一条状态机分支 —— 打回的本质就是"要求改"。

import { execFileSync } from 'node:child_process';
import { audit, newId, now, insertEdge } from '../db/db.mjs';
import { recordAnswer, RESOLUTION_HOOKS } from './answers.mjs';
import { routeQuestion, requireAuthorized } from './routing.mjs';
import { gatherSince, renderFacts, renderSelfDecided } from '../agent/reporter.mjs';
import { deferSignoff, deferredSignoffs } from './project-settings.mjs';
import { contributionOf } from './workspace.mjs';
import { hasComparableDecisions } from './decisions.mjs';
import { holdForCheck } from './inbox.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const setParam = (db, { taskId, key, value, userId }) => {
  const t = now();
  db.run(`UPDATE params SET superseded_at=?, valid_to=? WHERE task_id=? AND key=? AND superseded_at IS NULL`, t, t, taskId, key);
  db.run(`INSERT INTO params (id,task_id,key,value,layer,governance_class,set_by_kind,set_by_id,valid_from,recorded_at)
          VALUES (?,?,?,?,'task','constitutional','user',?,?,?)`, newId('p'), taskId, key, JSON.stringify(value), userId, t, t);
};
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
  throw new Error('未指定远端仓库：首次交付必须填写远端地址（--remote <url>），之后沿用上次的地址');
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
export function signoffEvidence(dir, { since, head, rework = false, contribution = null }) {
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
  const broughtNote = brought.length
    ? `（另有 ${brought.length} 个文件是把项目分支合进来带来的，不是这一轮改的：${brought.slice(0, 8).join('、')}${brought.length > 8 ? ' …' : ''}）`
    : null;
  const what = rework ? `本轮（上次签收 ${since.slice(0, 8)} 之后）的改动` : `本任务的全部改动（自 ${since.slice(0, 8)}）`;
  const end = (lines) => [...lines, ...(broughtNote ? [broughtNote] : [])].join('\n');
  if (mineThisRound && !mineThisRound.length) return end([`## 产物`, `${what}：没有文件变化。`]);
  let stat, churn = Infinity;
  try {
    stat = git(dir, 'diff', '--stat', `${since}..${head}`, ...paths);
  } catch { return ''; }   // 工作区没了 / commit 不在：不编，也不因此挡住签收
  if (!stat.trim()) return end([`## 产物`, `${what}：没有文件变化。`]);
  const m = stat.match(/(\d+) insertions?\(\+\)|(\d+) deletions?\(-\)/g);
  churn = (m ?? []).reduce((s, x) => s + Number(x.match(/\d+/)[0]), 0);
  const L = [`## 产物`, `${what}：`, '```', stat.trim(), '```'];
  if (churn <= DIFF_INLINE_MAX_LINES) {
    try {
      const body = git(dir, 'diff', `${since}..${head}`, ...paths);
      if (body.trim()) L.push('```diff', body.trim(), '```');
    } catch { /* 太大 / 编码问题：上面的 --stat 已经够定位 */ }
  } else {
    L.push(`（改动 ${churn} 行，正文里不贴全文。看全文：git -C ${dir} diff ${since.slice(0, 8)}..${head.slice(0, 8)}${paths.length ? ` -- ${mineThisRound.join(' ')}` : ''}）`);
  }
  return end(L);
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
      payload: { head, branch, why: '预算内自动开工、合并挡：AI 自己加的任务，签收后置到交付前批量做' } });
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
  const evidence = signoffEvidence(dir, { since: rework ? prevHead : contribution.base, head, rework, contribution });
  const text = `【签收】任务「${task?.title ?? taskId}」已完成，产物在 ${branch ?? '工作区分支'} @ ${String(head ?? '').slice(0, 8) || '（未知 commit）'}。\n\n`
    + (prev === 'accepted' && prevHead && prevHead !== head ? `注意：上次签收对应 ${prevHead.slice(0, 8)}，此后产物已变更，该签收已作废，需要重新签收。\n\n` : '')
    + (evidence ? `${evidence}\n\n` : '')
    + `请选一条：\n(A) 接受：点「接受」\n(B) 打回：点「打回…」写理由（理由会作为修正指令，任务据此重新规划）\n(C) 先看清楚：看下面的「改动」「页面截图」，或任务页的「日志」，看完再选`;
  return db.tx(() => {
    if (prev === 'accepted' && prevHead && prevHead !== head) {
      setParam(db, { taskId, key: 'signoff.status', value: 'void', userId: null });
      audit(db, { actorKind: 'system', action: 'signoff_voided', targetType: 'task', targetId: taskId, payload: { signedHead: prevHead, newHead: head } });
    }
    if (cur) db.run(`UPDATE questions SET status='withdrawn', resolved_at=? WHERE id=?`, at, cur.id);
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, id, taskId, text, at);
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
  const reason = String(finalBody).replace(/^(打回|reject(ed)?)[:：]?\s*/i, '').trim() || finalBody;
  // 修正消息复用打回那条答复的令牌（同一人、同一决策、系统代拟）—— 这是边界，不是先例：认证链完整（token_id 指向签收人
  // 亲自签的那条 message），且超时默认永远不会走到这里（签收类型禁配 default，见 DECISION_TYPES.noDefault），
  // 所以不存在"系统替人签名"的路径。别把这个模式推广到任何不是同一人、同一决策的地方。
  const tok = db.one(`SELECT token_id FROM messages WHERE id=?`, messageId)?.token_id ?? null;
  const mid = newId('m');
  db.run(`INSERT INTO messages (id,task_id,sender_id,body,kind,kind_source,urgency,urgency_source,trust_label,token_id,received_at)
          VALUES (?,?,?,?,'correction','explicit','urgent','explicit','user-authenticated',?,?)`, mid, taskId, by, `【签收打回】${reason}`, tok, at);
  insertEdge(db, mid, messageId, 'derived_from', at);
  // 打回理由接下来要和已登记的决定比对（调用方在 recordAnswer 之后跑），比对完之前这条修正先别被拉走。
  // 只在真有可比的决定时才标 —— 否则比对必然跳过，标了只是白等。比对器没跑到（进程死了）时到点自己放行。
  if (hasComparableDecisions(db, taskId)) holdForCheck(db, [mid], { at });
  setParam(db, { taskId, key: 'signoff.status', value: 'rejected', userId: by });
  // 打回 = 还有活要干：任务从 done 放回 running。守护进程只拉 running 的任务 —— 不放回去，这条修正就永远没人处理
  // （否则打回签收后任务一直没有动静；手动模式下人会自己 run，所以不容易暴露）。
  const was = db.one(`SELECT status FROM tasks WHERE id=?`, taskId)?.status;
  if (was === 'done') {
    db.run(`UPDATE tasks SET status='running' WHERE id=?`, taskId);
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
  return { summary: `任务完成：节点 ${JSON.stringify(f.counts)}`, body: `${renderFacts(f)}\n\n${renderSelfDecided(f)}`, source: 'facts' };
}

/**
 * 交付。push 总是做；`pr` 为真时开 PR（要 token、要 GitHub 远端、高风险要签收）。
 * @param {object} o  { taskId, workspace, remote?, branch?, pr?, base?, token?, fetchFn?, userId }
 */
export async function deliverTask(db, { taskId, workspace, remote = null, branch = null, pr = false, base = null,
  token = process.env.GITHUB_TOKEN, fetchFn = globalThis.fetch, userId = null }) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);
  if (task.status !== 'done') {
    throw new Error(`任务状态为 ${task.status}，只能交付已完成（done）的任务`);
  }
  if (userId) requireAuthorized(db, { taskId, decisionType: 'delivery', userId });   // 交付是决策类型之一：查路由表，不查 role
  const target = remoteFor(db, taskId, remote);
  const head = git(workspace, 'rev-parse', 'HEAD');
  const br = branch ?? git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (git(workspace, 'status', '--porcelain')) throw new Error('工作区有未提交的改动，请先处理后再交付');

  // 高风险 + 要开 PR + 没签收 → 拒。push 不拒：分支在远端上不是对外承诺。
  const gh = parseGithub(target);
  const highRisk = hasHighRisk(db, taskId);
  let signoff = signoffOf(db, taskId);
  // 签收挂在 commit 上。签的不是现在要推的这个 head → 那次签收不算数。
  const signedHead = signoffHeadOf(db, taskId);
  if (signoff === 'accepted' && signedHead && signedHead !== head) signoff = 'stale';
  if (pr && highRisk && signoff !== 'accepted') {
    throw new Error(signoff === 'stale'
      ? `签收对应 ${signedHead.slice(0, 8)}，此后产物已变更（当前 ${head.slice(0, 8)}），请重新签收后再创建 PR`
      : '任务包含高风险步骤，创建 PR 前必须先完成签收');
  }

  // 不许交互提示凭据（会挂死一个无人值守的进程），120 秒没推完就算失败。
  // 远端是 GitHub HTTPS 且有 token：push 也用 token（走 http.extraheader，只进环境变量，不进命令行、不进 git config）。
  try {
    execFileSync('git', ['push', '--force-with-lease', target, `HEAD:refs/heads/${br}`],
      { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
        env: pushEnv(target, token) });
  } catch (e) {
    throw new Error(`推送到 ${target} 失败：${String(e.stderr ?? e.message).trim().split('\n').slice(-3).join(' / ')}`);
  }
  const out = { remote: target, branch: br, head, pushedAt: now(), pr: null, prSkipped: null };

  if (pr) {
    if (!gh) out.prSkipped = `远端不是 GitHub（${target}），已推送，未创建 PR`;
    else if (!token) out.prSkipped = '未设置 GITHUB_TOKEN：已推送，未创建 PR。在 .env 中设置后重新交付即可';
    else {
      const report = finalReport(db, taskId);
      const baseBranch = base ?? (await defaultBranch(gh, token, fetchFn));
      const res = await fetchFn(`https://api.github.com/repos/${gh.owner}/${gh.repo}/pulls`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json',
          'user-agent': 'superintern' },
        body: JSON.stringify({ title: task.title, head: br, base: baseBranch,
          body: `${report.summary}\n\n${report.body}\n\n---\n由 SuperIntern 交付：任务 \`${taskId}\`，分支 \`${br}\` @ ${head.slice(0, 8)}。`
            + `正文取自真相源（${report.source}），不是模型现场写的。` }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`创建 PR 失败：HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
      out.pr = { url: json.html_url, number: json.number, base: baseBranch };
      setParam(db, { taskId, key: 'delivery.pr_url', value: json.html_url, userId });
    }
  }
  setParam(db, { taskId, key: 'delivery.remote', value: target, userId });
  setParam(db, { taskId, key: 'delivery.head', value: head, userId });
  audit(db, { actorKind: 'user', actorId: userId, action: 'task_delivered', targetType: 'task', targetId: taskId,
    payload: { ...out, highRisk, signoff } });
  return out;
}

async function defaultBranch(gh, token, fetchFn) {
  const res = await fetchFn(`https://api.github.com/repos/${gh.owner}/${gh.repo}`, {
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
  if (!task) throw new Error(`任务不存在：${taskId}`);
  if (task.status !== 'done') throw new Error(`任务状态为 ${task.status}，只能签收已完成（done）的任务`);
  if (!accept && !reason?.trim()) throw new Error('打回必须填写理由；理由将作为修正指令，任务据此重新规划');
  // 签收是决策事项：谁能签由路由表决定（负责人恒可；同行评审模板下要够法定人数）。
  requireAuthorized(db, { taskId, decisionType: 'signoff', userId });
  // 事项不在（老任务、或 done 时还没有这条机制）就按 done 时的 head 现建一条，再答它。
  let q = openSignoffQuestion(db, taskId);
  if (!q) { raiseSignoffQuestion(db, { taskId, head: doneHeadOf(db, taskId) }); q = openSignoffQuestion(db, taskId); }
  const r = recordAnswer(db, { questionId: q.id, body: accept ? '接受' : `打回：${reason.trim()}`, plaintextToken });
  if (!r.resolved) {
    return { accepted: null, pending: r.pending ?? null, conflictId: r.conflictId ?? null, questionId: q.id,
      note: r.conflictId ? '签收意见不一致，已生成冲突事项'
        : (r.pending ?? []).some((p) => p.requester)
          ? `已记下。这个任务是 ${db.one(`SELECT display_name FROM users WHERE id=?`, r.pending.find((p) => p.requester).requester)?.display_name ?? '需求提出人'} 提的需求，还要等提需求的人自己签收才算数`
          : `尚未达到法定人数：${(r.pending ?? []).map((p) => `${p.have}/${p.need}`).join('、')}` };
  }
  const h = r.hook ?? {};
  return { accepted: !!h.accepted, messageId: h.messageId ?? null, questionId: q.id, how: r.how };
}
