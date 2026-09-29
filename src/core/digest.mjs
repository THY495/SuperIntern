// 待决事项打包摘要（"会议 = 待决事项定时打包"的最小版）。
//
// 一份摘要 = **某个人**此刻该看的东西，全部从真相源现算，不存正文、不调模型：
//   - 等你答的（addressed_to 含你、你还没答）；等冲突结论的（原事项 escalated）；你答了在等别人的（法定人数未够）；
//   - 只知会你的（inform:）；负责人另有：没人接的（收件人为空）、任务在等人 / 已暂停、未读汇报、上次摘要以来的异议留痕。
// 三种触发：`cli digest`（手动）、守护进程按间隔（scheduled）、值班者换班（handover：接班人收自己范围内的开放事项）。
// 发送记录进 digests 表（只记发过什么、几条、送达情况），下一次间隔与"换班了没有"都从这张表判。
//
// 有意不做（要真实积压才知道形状）：按人统计打断次数并提示、同类问题合并、模型写的摘要。

import { newId, now, audit } from '../db/db.mjs';
import { DECISION_TYPES, leadOf, dutyCalendarOf, onDutyAt, dueAfter, isValidAfter } from './routing.mjs';
import { channelsForUsers } from './users.mjs';
import { notify, channelsFromEnv } from './notify.mjs';
import { answersOf } from './answers.mjs';
import { lastCatalogCheck } from '../llm/catalog-check.mjs';
import { listHandoverRequests, canDecideHandover } from './handover.mjs';
import { projectsToDeliver } from './delivery-due.mjs';

const oneLine = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const ageText = (ms) => (ms < 0 ? '0 分钟' : ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟` : ms < 86_400_000 ? `${(ms / 3_600_000).toFixed(1)} 小时` : `${(ms / 86_400_000).toFixed(1)} 天`);

/** 负责人名下的任务：独立任务按 owner，项目任务按项目 owner。 */
function tasksLedBy(db, userId) {
  return db.all(`SELECT t.id, t.title, t.status, t.project_id FROM tasks t
                 WHERE (t.project_id IS NULL AND t.owner_id=?) OR t.project_id IN (SELECT id FROM projects WHERE owner_id=?)
                 ORDER BY t.created_at`, userId, userId);
}

/**
 * 某个人此刻的摘要。`since`：上一次摘要的时刻（异议留痕只取这之后的）；没有就取最近 7 天。
 * `projectId`：只看某个项目 / 默认表（换班交接用；null = 全部）。
 */
export function buildDigest(db, { userId, at = now(), since = null, projectId = null, daemonAlive = null }) {
  const u = db.one(`SELECT id, display_name, role FROM users WHERE id=?`, userId);
  if (!u) throw new Error(`没有这个用户：${userId}`);
  const names = Object.fromEntries(db.all(`SELECT id, display_name FROM users`).map((x) => [x.id, x.display_name]));
  const nm = (id) => names[id] ?? id;
  const inProject = (q) => projectId === null || (q.project_id ?? '') === projectId;
  const open = db.all(`SELECT q.*, t.title AS task_title, t.status AS task_status, t.project_id, p.title AS project_title, t.project_order FROM questions q JOIN tasks t ON t.id=q.task_id LEFT JOIN projects p ON p.id=t.project_id
                       WHERE q.status IN ('open','escalated') AND t.status<>'aborted' ORDER BY q.asked_at`).filter(inProject);   // 已中止任务的事项不进待办（中止可反悔：恢复后重新出现）
  const item = (q) => {
    const dues = [q.timeout_at, q.route_due_at].filter((x) => Number.isFinite(x) && x !== null);
    // headline：收件箱按一行显示用（每条都铺一段正文的话，几条下来就是一堵字墙）。
    // 取正文第一行非空行，去掉开头的【…】标签（类型已经单独显示了）。
    const lines = String(q.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    const tag = lines[0]?.match(/^【([^】]*)】/)?.[1] ?? null;
    // 第一行只有一个【…】标签（方案草案那种）时，标签本身就是标题，再接正文第二行
    const rest = (lines[0] ?? '').replace(/^【[^】]*】\s*/, '');
    const first = rest || (tag ? `${tag}：${lines[1] ?? ''}` : '');
    return { questionId: q.id, taskId: q.task_id, taskTitle: q.task_title, nodeId: q.node_id, decisionType: q.decision_type,
      projectId: q.project_id ?? null, projectTitle: q.project_title ?? null, carrier: q.project_order === 0,
      tag, headline: oneLine(first, 90),
      label: DECISION_TYPES[q.decision_type]?.label ?? q.decision_type ?? '事项', level: q.level, text: oneLine(q.text),
      askedAt: q.asked_at, ageMs: at - q.asked_at, dueAt: dues.length ? Math.min(...dues) : null, defaultAction: q.default_action ?? null,
      // 轮到你的时候，先看得见别人已经说了什么 —— 不然只能各写各的，然后被系统判成"不一致"。
      answers: answersOf(db, q.id).filter((a) => ['answer', 'agree'].includes(a.stance))
        .map((a) => ({ name: nm(a.user_id), stance: a.stance, text: oneLine(a.body).slice(0, 120) })) };
  };
  const waitingOnMe = [], inConflict = [], waitingOnOthers = [], informed = [], unaddressed = [];
  const leadCache = new Map();
  const leadOfTask = (tid) => { if (!leadCache.has(tid)) leadCache.set(tid, leadOf(db, tid)); return leadCache.get(tid); };
  for (const q of open) {
    const to = JSON.parse(q.addressed_to || '[]'), inf = JSON.parse(q.informed || '[]');
    const isLead = leadOfTask(q.task_id) === userId;
    const ans = answersOf(db, q.id);
    // 附议也是表态：附议过的人不该在摘要里还被当成"欠一个答复"。弃权的人已从收件人里去掉。
    const answered = (uid) => ans.some((a) => a.user_id === uid && ['answer', 'agree'].includes(a.stance));
    if (q.status === 'escalated' && q.decision_type !== 'conflict') {
      if (to.includes(userId) || isLead) {
        const c = db.one(`SELECT id, addressed_to FROM questions WHERE origin_question_id=? AND status IN ('open','escalated') ORDER BY asked_at DESC LIMIT 1`, q.id);
        inConflict.push({ ...item(q), conflictId: c?.id ?? null, parties: JSON.parse(c?.addressed_to || '[]').map(nm), canRule: isLead });
      }
      continue;
    }
    if (to.includes(userId)) {
      if (answered(userId)) waitingOnOthers.push({ ...item(q), missing: to.filter((uid) => !answered(uid)).map(nm) });
      else waitingOnMe.push(item(q));
    } else if (inf.includes(userId)) informed.push(item(q));
    else if (isLead && !to.length) unaddressed.push(item(q));
  }
  // 负责人视角：任务状态、未读汇报、异议留痕。成员只有上面那些。
  let tasksWaiting = [], unreadReports = 0, unreadReportTasks = [], dissents = [];
  const led = tasksLedBy(db, userId).filter((t) => projectId === null || (t.project_id ?? '') === projectId);
  if (led.length) {
    tasksWaiting = led.filter((t) => ['waiting', 'suspended'].includes(t.status) || (t.status === 'done' && db.one(`SELECT 1 FROM questions WHERE task_id=? AND decision_type='signoff' AND status IN ('open','escalated')`, t.id)))
      .map((t) => {
        // 在等谁：该任务开放事项的收件人里还没答的人；空收件人 = 等负责人
        const who = new Set(); let unaddressedHere = false;
        for (const q of open.filter((x) => x.task_id === t.id)) {
          const to = JSON.parse(q.addressed_to || '[]');
          if (!to.length) unaddressedHere = true;
          const ans = answersOf(db, q.id);
          to.filter((uid) => !ans.some((a) => a.user_id === uid && ['answer', 'agree'].includes(a.stance))).forEach((uid) => who.add(uid));
        }
        if (unaddressedHere) who.add(userId);
        const names = [...(who.has(userId) ? ['你'] : []), ...[...who].filter((uid) => uid !== userId).map(nm)];
        return { taskId: t.id, title: t.title, status: t.status === 'done' ? 'awaiting_signoff' : t.status, waitingOn: names };
      });
    const ids = led.map((t) => t.id);
    const ph = ids.map(() => '?').join(',');
    unreadReports = db.one(`SELECT count(*) n FROM reports WHERE read_at IS NULL AND task_id IN (${ph})`, ...ids).n;
    unreadReportTasks = db.all(`SELECT task_id, count(*) n FROM reports WHERE read_at IS NULL AND task_id IN (${ph}) GROUP BY task_id`, ...ids)
      .map((r) => ({ taskId: r.task_id, title: led.find((t) => t.id === r.task_id)?.title ?? r.task_id, n: r.n }));
    const from = since ?? at - 7 * 86_400_000;
    dissents = db.all(`SELECT a.ts, a.actor_id, a.action, a.target_id, a.payload FROM audit_log a
                       WHERE a.action IN ('late_dissent_noted','dissent_noted','answer_overridden') AND a.ts > ? AND a.ts <= ?
                         AND a.target_id IN (SELECT id FROM questions WHERE task_id IN (${ph})) ORDER BY a.ts`, from, at, ...ids)
      .map((a) => { const p = JSON.parse(a.payload || '{}'); const q = db.one(`SELECT task_id, text FROM questions WHERE id=?`, a.target_id);
        return { at: a.ts, questionId: a.target_id, taskId: q?.task_id ?? null, questionText: oneLine(q?.text, 60), by: nm(a.actor_id), action: a.action,
          text: oneLine(a.action === 'answer_overridden' ? (p.dissent ?? []).map((d) => `${nm(d.userId)}：${d.body}`).join('；') : p.body, 120) }; });
  }
  // 模型目录漂移（只给负责人）：最近一次检查有问题、且不超过 30 天就列出来；代答检测（model_drift）取上次摘要以来的。
  let catalog = null;
  if (u.role === 'lead' && projectId === null) {
    const last = lastCatalogCheck(db);
    const drifts = db.all(`SELECT ts, payload FROM audit_log WHERE action='model_drift' AND ts > ? AND ts <= ? ORDER BY ts`, since ?? at - 7 * 86_400_000, at)
      .map((a) => { const p = JSON.parse(a.payload || '{}'); return `${p.requested} 实际由 ${p.served} 代答（目录键 ${p.key}）`; });
    const uniq = [...new Set(drifts)];
    if ((last && last.warnings > 0 && at - (last.checkedAt ?? last.ts) < 30 * 86_400_000) || uniq.length) {
      catalog = { checkedAt: last?.checkedAt ?? last?.ts ?? null, warnings: last?.warnings ?? 0, lines: last?.lines ?? [], drifts: uniq };
    }
  }
  // 交接申请：能批准的人看到等批准的（项目范围 = 该项目负责人或管理员，其余 = 管理员）；申请人看到自己还没批的。
  const handoverRequests = projectId !== null ? [] : listHandoverRequests(db, { status: 'open' })
    .map((r) => ({ ...r, mine: r.fromUserId === userId, canDecide: canDecideHandover(db, { byUserId: userId, scope: r.scope }) })).filter((r) => r.canDecide || r.mine);
  const hrActionable = handoverRequests.filter((r) => r.canDecide).length;
  // 自动运行没开、又有没结束的任务：对一个号称"自己跑几天"的系统，调度器没开却没人知道比多一个按钮危险。只给管理员；
  // 调用方知道心跳才传 daemonAlive（看板 / CLI digest）；守护进程自己发的定时摘要不传（它在发，说明它开着）。
  // 注意：守护进程关着时通知本来就推不出去，这一条只有打开收件箱 / 跑 cli digest 才看得到。
  const daemonOff = (daemonAlive === false && u.role === 'lead' && projectId === null)
    ? { unfinished: db.one(`SELECT count(*) n FROM tasks WHERE status IN ('planning','running','waiting') AND archived_at IS NULL`).n } : null;
  const daemonOffItem = daemonOff?.unfinished ? daemonOff : null;
  // 停滞的项目（剩下的任务都被已中止的任务卡住；取编号最小的那个已中止任务）：等负责人三选一 —— 恢复 / 重做 / 中止项目。不是事项（没有自由文本要解析），但要进待办。
  const stalledProjects = projectId !== null ? [] : db.all(`SELECT id, title FROM projects WHERE status='stalled' AND owner_id=? AND archived_at IS NULL ORDER BY created_at`, userId)
    .map((p) => { const cur = db.one(`SELECT id, title FROM tasks WHERE project_id=? AND project_order>0 AND merged_at IS NULL AND status='aborted' ORDER BY project_order LIMIT 1`, p.id);
      const why = (() => { try { return JSON.parse(db.one(`SELECT payload FROM audit_log WHERE action='task_aborted' AND target_id=? ORDER BY id DESC LIMIT 1`, cur?.id ?? '')?.payload || '{}').why ?? null; } catch { return null; } })();
      // 停滞有两种：剩下的任务在等已中止的任务；或全部已合并、复盘时选了「先放着」（后一种不能套"任务「」已中止"的说法）
      return { projectId: p.id, title: p.title, kind: cur ? 'aborted_task' : 'review_shelved', taskId: cur?.id ?? null, taskTitle: cur?.title ?? null, why }; });
  // 已达成、还没交付的项目：交付是这套系统里唯一必须负责人亲自点的一步，也不是事项（没有自由文本要解析，推送不可逆、只能在页面上点）。
  // 否则会签确认达成后负责人收件箱里什么都没有，他那一轮就结束了 —— "达成了、等你交付"必须进待办，交付了才消失。
  const toDeliver = projectId !== null ? [] : projectsToDeliver(db, { ownerId: userId });
  // 自动挡替你开工的那几批：草案里那句"事后通知"落在这里。摘要是这个系统唯一会**主动推给人**
  // 的东西，所以"AI 自己加了任务并且已经在做"必须出现在这里，而不是只躺在审计轨里等人去翻。
  // 不计入 actionable（它不要求你做什么），但计入 total —— 它要求你知道。
  const autoBatches = projectId !== null ? [] : db.all(
    `SELECT a.ts, a.target_id AS project_id, a.payload FROM audit_log a JOIN projects p ON p.id=a.target_id
      WHERE a.action='project_auto_batch' AND p.owner_id=? AND a.ts > ? AND a.ts <= ? ORDER BY a.ts`,
    userId, since ?? at - 7 * 86_400_000, at)
    .map((a) => { const pl = JSON.parse(a.payload || '{}');
      return { at: a.ts, projectId: a.project_id, title: db.one(`SELECT title FROM projects WHERE id=?`, a.project_id)?.title ?? a.project_id,
        titles: pl.titles ?? [], count: (pl.tasks ?? []).length, review: !!pl.review }; });
  // 你提的需求做完了：添加任务的人不一定是签收人，合并了要有人告诉提的人 —— 否则成员提的需求合并了，页面上无从得知。
  // 负责人自己提的不在这里（合并本来就经负责人手）。不计入 actionable，计入 total。
  const requestsDone = db.all(
    `SELECT t.id, t.title, t.merged_at, t.project_id, p.title AS project_title FROM tasks t
       JOIN params pr ON pr.task_id=t.id AND pr.key='task.requested_by' AND pr.superseded_at IS NULL
       JOIN projects p ON p.id=t.project_id
      WHERE pr.value=? AND p.owner_id<>? AND t.merged_at IS NOT NULL AND t.merged_at > ? AND t.merged_at <= ? ORDER BY t.merged_at`,
    JSON.stringify(userId), userId, since ?? at - 7 * 86_400_000, at)
    .filter((t) => projectId === null || t.project_id === projectId)
    .map((t) => ({ taskId: t.id, title: t.title, at: t.merged_at, projectId: t.project_id, projectTitle: t.project_title }));
  const total = requestsDone.length + waitingOnMe.length + inConflict.length + waitingOnOthers.length + informed.length + unaddressed.length + tasksWaiting.length + dissents.length + (unreadReports ? 1 : 0) + (catalog ? 1 : 0) + handoverRequests.length + stalledProjects.length + toDeliver.length + (daemonOffItem ? 1 : 0) + autoBatches.length;
  return { userId, name: u.display_name, role: u.role, at, since, projectId, waitingOnMe, inConflict, waitingOnOthers, informed, unaddressed,
    tasksWaiting, unreadReports, unreadReportTasks, dissents, catalog, handoverRequests, stalledProjects, toDeliver, autoBatches, requestsDone, daemonOff: daemonOffItem, total, actionable: waitingOnMe.length + inConflict.length + unaddressed.length + hrActionable + stalledProjects.length + toDeliver.length + (daemonOffItem ? 1 : 0) };
}

/** 任务在等什么（文本与看板同一句）："做完了，等 alice 签收" / "停着，等你、bob 答" / "已暂停"。 */
export function taskWaitText(t) {
  if (t.status === 'suspended') return '已暂停';
  const who = t.waitingOn?.length ? t.waitingOn.join('、') : null;
  if (t.status === 'awaiting_signoff') return who ? `做完了，等 ${who} 签收` : '做完了，等签收';
  return who ? `停着，等 ${who} 答` : '停着';
}

/** 纯文本（CLI 与通知共用）。每条带它的命令；没有"系统怎么工作"的话。 */
export function renderDigest(d, { at = d.at } = {}) {
  const L = [];
  const line = (x) => `- ${x.label}｜${x.taskTitle}｜${ageText(at - x.askedAt)}前提出${x.dueAt ? `，${x.dueAt > at ? `${ageText(x.dueAt - at)}后` : '已'}到期` : '，一直等到有人答'}\n  ${x.text}\n  → node src/cli.mjs answer ${x.questionId} "..."${x.defaultAction && x.dueAt ? `（到期没人答就按默认：${oneLine(x.defaultAction, 60)}）` : ''}`;
  L.push(`${d.name} 的待办（${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC）`);
  if (!d.total) { L.push('没有等你的事。'); return L.join('\n'); }
  if (d.daemonOff) L.push(`\n自动运行未开启：有 ${d.daemonOff.unfinished} 个未结束的任务不会自动推进，超时与通知也不会处理。启动：node src/cli.mjs web --daemon（或 daemon）`);
  if (d.stalledProjects?.length) {
    L.push(`\n已停滞的项目 ${d.stalledProjects.length} 个（等你决定）：`);
    d.stalledProjects.forEach((p) => L.push(p.kind === 'review_shelved'
      ? `- ${p.title}｜全部任务已合并，复盘时选了「先放着」，还没宣布达成\n    node src/cli.mjs project review ${p.projectId}（重新复盘）｜project append / abort ${p.projectId}`
      : `- ${p.title}｜已中止的任务：${p.taskTitle ?? '无'}${p.why ? `｜中止原因：${oneLine(p.why, 80)}` : ''}\n    node src/cli.mjs project reopen|redo|abort ${p.projectId}`));
  }
  if (d.toDeliver?.length) {
    L.push(`\n已达成、等你交付的项目 ${d.toDeliver.length} 个（任务都已合进项目分支，还只在这套系统里；到项目页点「交付项目」才推到你们的代码仓库 —— 只能你亲自点，推出去收不回）：`);
    d.toDeliver.forEach((p) => L.push(`- ${p.title}｜${p.again ? `上次交付之后又合并了 ${p.sinceDelivery} 个任务（${(p.newTitles ?? []).join('、')}），还没推到你们的仓库，要再交付一次` : `已合并 ${p.merged} 个任务`}`));
  }
  if (d.handoverRequests?.length) {
    L.push(`\n交接申请 ${d.handoverRequests.length} 条：`);
    d.handoverRequests.forEach((r) => L.push(`- ${r.fromName} 申请把${r.scopeText}范围内的责任交给 ${r.toName}${r.thenDisable ? '，交接后停用' : ''}${r.note ? `｜备注：${oneLine(r.note, 80)}` : ''}${r.canDecide ? `\n  → node src/cli.mjs handover requests（看清单后 approve / reject ${r.id}）` : '｜等管理员批准'}`));
  }
  if (d.autoBatches?.length) {
    // 事后通知（自动挡）。放在"等你决定"之前：它不要求你做什么，但你该先知道 AI 已经开始做什么了。
    const n = d.autoBatches.reduce((s, b) => s + b.count, 0);
    L.push(`\n自动挡替你开工了 ${n} 个任务（${d.since ? '上次摘要以来' : '最近 7 天'}；不用你批，随时可中止）：`);
    d.autoBatches.forEach((b) => L.push(`- ${b.title}｜${ageText(at - b.at)}前${b.review ? '（复盘给出的）' : ''}：${b.titles.join('、') || `${b.count} 个任务`}\n  → 要停：node src/cli.mjs project gear ${b.projectId} propose（改回提议挡），或 project abort ${b.projectId}`));
  }
  if (d.requestsDone?.length) { L.push(`\n你提的需求做完并合并了 ${d.requestsDone.length} 个：`); d.requestsDone.forEach((x) => L.push(`- ${x.projectTitle}｜${x.title}｜${ageText(at - x.at)}前合并`)); }
  if (d.waitingOnMe.length) { L.push(`\n等你决定 ${d.waitingOnMe.length} 件：`); d.waitingOnMe.forEach((x) => L.push(line(x))); }
  if (d.inConflict.length) { L.push(`\n答复不一致、等结论 ${d.inConflict.length} 件（${d.inConflict.some((x) => x.canRule) ? '双方先商量；你可以直接裁定' : '双方先商量，谈不拢或到期转负责人裁定'}）：`); d.inConflict.forEach((x) => L.push(`- ${x.label}｜${x.taskTitle}｜${x.text}${x.parties?.length ? `｜在商量的：${x.parties.join('、')}` : ''}${x.canRule && x.conflictId ? `\n  → 直接裁定：node src/cli.mjs answer ${x.conflictId} "..."` : ''}`)); }
  if (d.unaddressed.length) { L.push(`\n没人接的 ${d.unaddressed.length} 件（没有路由到任何人；你答，或在任务页转给别人）：`); d.unaddressed.forEach((x) => L.push(line(x))); }
  if (d.waitingOnOthers.length) { L.push(`\n你答过、还在等别人的 ${d.waitingOnOthers.length} 件：`); d.waitingOnOthers.forEach((x) => L.push(`- ${x.label}｜${x.taskTitle}｜还差：${x.missing.join('、') || '—'}`)); }
  if (d.informed.length) { L.push(`\n只是知会你的 ${d.informed.length} 件（不用你答）：`); d.informed.forEach((x) => L.push(`- ${x.label}｜${x.taskTitle}｜${x.text}`)); }
  if (d.tasksWaiting.length) { L.push(`\n任务状态：`); d.tasksWaiting.forEach((t) => L.push(`- ${t.title}（${t.taskId}）：${taskWaitText(t)}`)); }
  if (d.unreadReports) L.push(`\n未读汇报 ${d.unreadReports} 份：${(d.unreadReportTasks ?? []).map((t) => `${t.title} ${t.n} 份（node src/cli.mjs reports ${t.taskId}）`).join('；')}`);
  if (d.catalog) {
    L.push(`\n模型目录${d.catalog.checkedAt ? `（上次检查 ${ageText(at - d.catalog.checkedAt)}前）` : ''}：${d.catalog.warnings ? `${d.catalog.warnings} 项要看一眼` : ''}${d.catalog.drifts.length ? `${d.catalog.warnings ? '；' : ''}调用时发现 ${d.catalog.drifts.length} 处厂商代答` : ''}`);
    for (const x of d.catalog.drifts) L.push(`- ${x}`);
    for (const x of d.catalog.lines.slice(0, 8)) L.push(`- ${x}`);
    if (d.catalog.lines.length > 8) L.push(`- …还有 ${d.catalog.lines.length - 8} 行`);
    L.push(`  → 全文：node src/cli.mjs catalog check；目录只由人改（src/llm/canonical.mjs）`);
  }
  if (d.dissents.length) { L.push(`\n${d.since ? '上次摘要以来' : '最近 7 天'}的不同意见 ${d.dissents.length} 条（已记录，不改结论）：`); d.dissents.forEach((x) => L.push(`- ${x.by} 对「${x.questionText}」的结论：${x.text}`)); }
  return L.join('\n');
}

const lastDigest = (db, { userId = null, kind, projectId = null }) => db.one(
  `SELECT * FROM digests WHERE kind=? ${userId ? 'AND user_id=?' : ''} ${projectId !== null ? 'AND project_id=?' : ''} ORDER BY sent_at DESC, rowid DESC LIMIT 1`,
  ...[kind, ...(userId ? [userId] : []), ...(projectId !== null ? [projectId] : [])]);

/**
 * 给一个人发摘要（按他自己的通道；负责人没配通道时退到 .env 的部署级通道）。
 * `record`：要不要在 digests 表记一行（换班交接即使没东西可发也记，用来标"这次换班已看过"）。
 * 返回 { digest, text, sent, receipts }。**不抛**网络错误（notify 自己吞）。
 */
export async function sendDigest(db, { userId, kind = 'manual', projectId = '', at = now(), since = null, env = process.env, extraCmd = null, fetchFn = globalThis.fetch, spawn, record = true, onlyIfAny = true }) {
  const digest = buildDigest(db, { userId, at, since, projectId: kind === 'handover' ? projectId : null });
  const text = renderDigest(digest, { at });
  let channels = channelsForUsers(db, [userId]);
  if (!channels.length && digest.role === 'lead') channels = channelsFromEnv(env, extraCmd);
  let receipts = [];
  const shouldSend = channels.length && (!onlyIfAny || digest.total > 0);
  if (shouldSend) {
    const title = `[SuperIntern] ${kind === 'handover' ? '接班：' : ''}${digest.name} 的待办 ${digest.actionable} 件等你${digest.total > digest.actionable ? `，另 ${digest.total - digest.actionable} 项` : ''}`;
    receipts = await notify(db, { taskId: null, kind: 'digest', title, text, ref: `digest:${kind}:${userId}`, channels, fetchFn, ...(spawn ? { spawn } : {}) });
  }
  if (record) {
    db.run(`INSERT INTO digests (id,user_id,kind,project_id,items,sent,sent_at,receipts) VALUES (?,?,?,?,?,?,?,?)`,
      newId('dg'), userId, kind, projectId, digest.total, shouldSend ? 1 : 0, at, JSON.stringify(receipts));
    audit(db, { actorKind: 'system', action: 'digest_sent', targetType: 'user', targetId: userId,
      payload: { kind, projectId, items: digest.total, actionable: digest.actionable, sent: !!shouldSend, channels: channels.map((c) => c.kind), delivered: receipts.filter((r) => r.ok).length } });
  }
  return { digest, text, sent: !!shouldSend, receipts };
}

/**
 * 定时摘要：每个负责人 / 成员，距上一次 scheduled 摘要超过 `every`（30m / 8h / 1d / 1bd）且有东西可发才发。
 * 没东西不记（下一轮再看，查询便宜）。返回发出的列表。
 */
export async function scheduledDigests(db, { every, at = now(), ...opts } = {}) {
  if (!isValidAfter(every)) throw new Error(`摘要间隔写法不对：${every}（可用 30m / 8h / 1d / 1bd）`);
  const out = [];
  for (const u of db.all(`SELECT id FROM users WHERE role IN ('lead','member') AND disabled_at IS NULL ORDER BY created_at`)) {
    const last = lastDigest(db, { userId: u.id, kind: 'scheduled' });
    if (last && at < dueAfter(last.sent_at, every)) continue;
    const r = await sendDigest(db, { userId: u.id, kind: 'scheduled', at, since: last?.sent_at ?? null, record: false, ...opts });
    if (!r.sent) continue;
    db.run(`INSERT INTO digests (id,user_id,kind,project_id,items,sent,sent_at,receipts) VALUES (?,?,?,?,?,?,?,?)`,
      newId('dg'), u.id, 'scheduled', '', r.digest.total, 1, at, JSON.stringify(r.receipts));
    audit(db, { actorKind: 'system', action: 'digest_sent', targetType: 'user', targetId: u.id,
      payload: { kind: 'scheduled', items: r.digest.total, actionable: r.digest.actionable, sent: true, delivered: r.receipts.filter((x) => x.ok).length } });
    out.push({ userId: u.id, items: r.digest.total, receipts: r.receipts });
  }
  return out;
}

/**
 * 换班交接：每个有值班日历的项目，当班的人与上一条 handover 记录不同 → 给接班人发他范围内的开放事项。
 * 第一次看到某个日历只记不发（否则守护进程每次重启都会"交接"一遍）。返回发生的交接。
 */
export async function handoverDigests(db, { at = now(), ...opts } = {}) {
  const out = [];
  for (const row of db.all(`SELECT project_id FROM duty_calendar`)) {
    const key = row.project_id;
    const cal = dutyCalendarOf(db, key);
    const onDuty = onDutyAt(cal, at);
    if (!onDuty) continue;
    const last = lastDigest(db, { kind: 'handover', projectId: key });
    if (last?.user_id === onDuty) continue;
    if (!last) {
      db.run(`INSERT INTO digests (id,user_id,kind,project_id,items,sent,sent_at,receipts) VALUES (?,?,?,?,0,0,?,'[]')`, newId('dg'), onDuty, 'handover', key, at);
      continue;
    }
    const r = await sendDigest(db, { userId: onDuty, kind: 'handover', projectId: key, at, since: last.sent_at, record: true, ...opts });
    audit(db, { actorKind: 'system', action: 'duty_handover', targetType: 'project', targetId: key || '(default)', payload: { from: last.user_id, to: onDuty, items: r.digest.total, sent: r.sent } });
    out.push({ projectId: key, from: last.user_id, to: onDuty, items: r.digest.total, sent: r.sent });
  }
  return out;
}

/** 交接清单的纯文本（CLI 预览、通知共用）。 */
export function renderHandover(ch) {
  const L = [];
  const key = (k) => (k ? `项目「${ch.projectTitles?.[k] ?? k}」` : '默认决策路由');
  const nm = (id) => ch.names?.[id] ?? id;
  const one = (s) => (s === 'group:*' ? '所有成员' : s.startsWith('group:') ? `标签 ${s.slice(6)}` : s === 'on_duty' ? '值班人' : s === 'parties' ? '冲突双方' : s.replace(/user:([A-Za-z0-9_-]+)$/, (m, id) => (id === 'lead' ? '负责人' : nm(id))));
  const rs = (list) => list.map((s) => { const t = String(s); return t.startsWith('inform:') ? `知会 ${one(t.slice(7))}` : one(t); }).join('、');
  L.push(`${ch.from.name} → ${ch.to.name}（范围：${ch.scopeText}）`);
  if (ch.projects.length) L.push(`负责人变更 · 项目 ${ch.projects.length} 个：${ch.projects.map((p) => `${p.title}（${p.id}）`).join('、')}`);
  if (ch.soloTasks.length) L.push(`负责人变更 · 不属于项目的任务 ${ch.soloTasks.length} 个：${ch.soloTasks.map((t) => `${t.title}（${t.id}）`).join('、')}`);
  if (ch.routing.length) { L.push(`决策路由 ${ch.routing.length} 行：`); ch.routing.forEach((r) => L.push(`  - ${key(r.key)}｜${r.label}（范围 ${r.scope}）顺位 ${r.position} 的接收人：${rs(r.before)} → ${rs(r.after)}${r.merged ? '（接手人已在该行，已合并）' : ''}`)); }
  if (ch.duty.length) ch.duty.forEach((d) => L.push(`值班表（${key(d.key)}）：${d.before.map(nm).join(' → ')} 改为 ${d.after.map(nm).join(' → ')}`));
  if (ch.transferred.length) { L.push(`转给接手人的待决事项 ${ch.transferred.length} 条：`); ch.transferred.forEach((q) => L.push(`  - ${q.label}｜${q.taskTitle}｜${q.text}（${q.id}）`)); }
  if (ch.escalated.length) { L.push(`转负责人裁定的冲突事项 ${ch.escalated.length} 条（交出方是冲突方，其立场不随交接转移）：`); ch.escalated.forEach((q) => L.push(`  - ${q.taskTitle}｜${q.text}（${q.id}）`)); }
  if (ch.informed.length) L.push(`知会对象改为接手人的事项 ${ch.informed.length} 条`);
  if (ch.kept.length) L.push(`不作变更 ${ch.kept.length} 条（交出方已答复）`);
  if (ch.disabled) L.push(`交接后停用 ${ch.from.name}：吊销令牌 ${ch.tokensRevoked} 个，通知通道不转移`);
  for (const w of ch.warnings) L.push(`注意：${w}`);
  if (ch.empty) L.push('没有需要交接的内容。');
  L.push('已有的答复与签收记录、审计日志、已结束的项目与任务不受影响。');
  if (ch.note) L.push(`\n交出方备注：${ch.note}`);
  return L.join('\n');
}

/** 交接执行后通知接手人：交接清单 + 他此刻的待办。**不抛**。 */
export async function sendHandoverNotice(db, { changes, at = now(), env = process.env, extraCmd = null, fetchFn = globalThis.fetch, spawn }) {
  const channels = channelsForUsers(db, [changes.to.id]);
  if (!channels.length) return { sent: false, receipts: [] };
  const text = `${renderHandover(changes)}\n\n${renderDigest(buildDigest(db, { userId: changes.to.id, at }), { at })}`;
  const receipts = await notify(db, { taskId: null, kind: 'digest', title: `[SuperIntern] ${changes.from.name} 把${changes.scopeText}范围内的责任交给了你`, text, ref: `handover:${changes.from.id}:${changes.to.id}`, channels, fetchFn, ...(spawn ? { spawn } : {}) });
  return { sent: true, receipts };
}
