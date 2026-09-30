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
import { tl, userLang, I18nError, CATALOGS } from '../i18n/index.mjs';

// 摘要是按人发的（0.2.0）：用这个人的界面语言 userLang(db, userId)。buildDigest 把语言放进结果（d.lang），渲染照它写。
/** 目录里查一条原文（决策类型的 label 这类由 N_ 登记、在别处定义的原文）。 */
const byCatalog = (lang, zh) => (lang && lang !== 'zh' ? CATALOGS[lang]?.[zh] ?? zh : zh);
const oneLine = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const ageText = (ms, lang = 'zh') => (ms < 0 ? tl(lang, '{n} 分钟', { n: 0 }) : ms < 3_600_000 ? tl(lang, '{n} 分钟', { n: Math.max(1, Math.round(ms / 60_000)) }) : ms < 86_400_000 ? tl(lang, '{n} 小时', { n: (ms / 3_600_000).toFixed(1) }) : tl(lang, '{n} 天', { n: (ms / 86_400_000).toFixed(1) }));

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
  if (!u) throw new I18nError('没有这个用户：{id}', { id: userId });
  const lang = userLang(db, userId);
  const en = lang === 'en';
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
    const first = rest || (tag ? `${tag}${en ? ': ' : '：'}${lines[1] ?? ''}` : '');
    const typeLabel = DECISION_TYPES[q.decision_type]?.label;
    return { questionId: q.id, taskId: q.task_id, taskTitle: q.task_title, nodeId: q.node_id, decisionType: q.decision_type,
      projectId: q.project_id ?? null, projectTitle: q.project_title ?? null, carrier: q.project_order === 0,
      tag, headline: oneLine(first, 90),
      label: (typeLabel ? byCatalog(lang, typeLabel) : null) ?? q.decision_type ?? tl(lang, '事项'), level: q.level, text: oneLine(q.text),
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
        const names = [...(who.has(userId) ? [en ? 'you' : '你'] : []), ...[...who].filter((uid) => uid !== userId).map(nm)];
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
          text: oneLine(a.action === 'answer_overridden' ? (p.dissent ?? []).map((d) => `${nm(d.userId)}${en ? ': ' : '：'}${d.body}`).join(en ? '; ' : '；') : p.body, 120) }; });
  }
  // 模型目录漂移（只给负责人）：最近一次检查有问题、且不超过 30 天就列出来；代答检测（model_drift）取上次摘要以来的。
  let catalog = null;
  if (u.role === 'lead' && projectId === null) {
    const last = lastCatalogCheck(db);
    const drifts = db.all(`SELECT ts, payload FROM audit_log WHERE action='model_drift' AND ts > ? AND ts <= ? ORDER BY ts`, since ?? at - 7 * 86_400_000, at)
      .map((a) => { const p = JSON.parse(a.payload || '{}'); return tl(lang, '{requested} 实际由 {served} 代答（目录键 {key}）', { requested: `${p.requested}`, served: `${p.served}`, key: `${p.key}` }); });
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
  return { userId, name: u.display_name, role: u.role, lang, at, since, projectId, waitingOnMe, inConflict, waitingOnOthers, informed, unaddressed,
    tasksWaiting, unreadReports, unreadReportTasks, dissents, catalog, handoverRequests, stalledProjects, toDeliver, autoBatches, requestsDone, daemonOff: daemonOffItem, total, actionable: waitingOnMe.length + inConflict.length + unaddressed.length + hrActionable + stalledProjects.length + toDeliver.length + (daemonOffItem ? 1 : 0) };
}

/** 任务在等什么（文本与看板同一句）："做完了，等 alice 签收" / "停着，等你、bob 答" / "已暂停"。 */
export function taskWaitText(t, lang = 'zh') {
  if (t.status === 'suspended') return tl(lang, '已暂停');
  const who = t.waitingOn?.length ? t.waitingOn.join(lang === 'en' ? ', ' : '、') : null;
  if (t.status === 'awaiting_signoff') return who ? tl(lang, '做完了，等 {who} 签收', { who }) : tl(lang, '做完了，等签收');
  return who ? tl(lang, '停着，等 {who} 答', { who }) : tl(lang, '停着');
}

/** 纯文本（CLI 与通知共用）。每条带它的命令；没有"系统怎么工作"的话。 */
export function renderDigest(d, { at = d.at } = {}) {
  const L = [];
  const lang = d.lang ?? 'zh', en = lang === 'en';
  const age = (ms) => ageText(ms, lang);
  const bar = en ? ' | ' : '｜', colon = en ? ': ' : '：';
  const list = (xs) => xs.join(en ? ', ' : '、');
  const line = (x) => `- ${x.label}${bar}${x.taskTitle}${bar}${tl(lang, '{age}前提出', { age: age(at - x.askedAt) })}${x.dueAt ? (x.dueAt > at ? tl(lang, '，{age}后到期', { age: age(x.dueAt - at) }) : tl(lang, '，已到期')) : tl(lang, '，一直等到有人答')}\n  ${x.text}\n  → node src/cli.mjs answer ${x.questionId} "..."${x.defaultAction && x.dueAt ? tl(lang, '（到期没人答就按默认：{action}）', { action: oneLine(x.defaultAction, 60) }) : ''}`;
  L.push(tl(lang, '{name} 的待办（{time} UTC）', { name: d.name, time: new Date(at).toISOString().slice(0, 16).replace('T', ' ') }));
  if (!d.total) { L.push(tl(lang, '没有等你的事。')); return L.join('\n'); }
  if (d.daemonOff) L.push(`\n${tl(lang, '自动运行未开启：有 {n} 个未结束的任务不会自动推进，超时与通知也不会处理。启动：node src/cli.mjs web --daemon（或 daemon）', { n: d.daemonOff.unfinished })}`);
  if (d.stalledProjects?.length) {
    L.push(`\n${tl(lang, '已停滞的项目 {n} 个（等你决定）：', { n: d.stalledProjects.length })}`);
    d.stalledProjects.forEach((p) => L.push(p.kind === 'review_shelved'
      ? `- ${p.title}${bar}${tl(lang, '全部任务已合并，复盘时选了「先放着」，还没宣布达成\n    node src/cli.mjs project review {id}（重新复盘）｜project append / abort {id}', { id: p.projectId })}`
      : `- ${p.title}${bar}${tl(lang, '已中止的任务：{title}', { title: p.taskTitle ?? (en ? 'none' : '无') })}${p.why ? `${bar}${tl(lang, '中止原因：{why}', { why: oneLine(p.why, 80) })}` : ''}\n    node src/cli.mjs project reopen|redo|abort ${p.projectId}`));
  }
  if (d.toDeliver?.length) {
    L.push(`\n${tl(lang, '已达成、等你交付的项目 {n} 个（任务都已合进项目分支，还只在这套系统里；到项目页点「交付项目」才推到你们的代码仓库 —— 只能你亲自点，推出去收不回）：', { n: d.toDeliver.length })}`);
    d.toDeliver.forEach((p) => L.push(`- ${p.title}${bar}${p.again ? tl(lang, '上次交付之后又合并了 {n} 个任务（{titles}），还没推到你们的仓库，要再交付一次', { n: p.sinceDelivery, titles: list(p.newTitles ?? []) }) : tl(lang, '已合并 {n} 个任务', { n: p.merged })}`));
  }
  if (d.handoverRequests?.length) {
    L.push(`\n${tl(lang, '交接申请 {n} 条：', { n: d.handoverRequests.length })}`);
    d.handoverRequests.forEach((r) => L.push(`- ${tl(lang, '{from} 申请把{scope}范围内的责任交给 {to}', { from: r.fromName, scope: r.scopeText, to: r.toName })}${r.thenDisable ? tl(lang, '，交接后停用') : ''}${r.note ? `${bar}${tl(lang, '备注：{note}', { note: oneLine(r.note, 80) })}` : ''}${r.canDecide ? `\n  → ${tl(lang, 'node src/cli.mjs handover requests（看清单后 approve / reject {id}）', { id: r.id })}` : `${bar}${tl(lang, '等管理员批准')}`}`));
  }
  if (d.autoBatches?.length) {
    // 事后通知（自动挡）。放在"等你决定"之前：它不要求你做什么，但你该先知道 AI 已经开始做什么了。
    const n = d.autoBatches.reduce((s, b) => s + b.count, 0);
    L.push(`\n${tl(lang, '自动挡替你开工了 {n} 个任务（{when}；不用你批，随时可中止）：', { n, when: d.since ? tl(lang, '上次摘要以来') : tl(lang, '最近 7 天') })}`);
    d.autoBatches.forEach((b) => L.push(`- ${b.title}${bar}${tl(lang, '{age}前', { age: age(at - b.at) })}${b.review ? tl(lang, '（复盘给出的）') : ''}${colon}${list(b.titles) || tl(lang, '{n} 个任务', { n: b.count })}\n  → ${tl(lang, '要停：node src/cli.mjs project gear {id} propose（改回提议挡），或 project abort {id}', { id: b.projectId })}`));
  }
  if (d.requestsDone?.length) { L.push(`\n${tl(lang, '你提的需求做完并合并了 {n} 个：', { n: d.requestsDone.length })}`); d.requestsDone.forEach((x) => L.push(`- ${x.projectTitle}${bar}${x.title}${bar}${tl(lang, '{age}前合并', { age: age(at - x.at) })}`)); }
  if (d.waitingOnMe.length) { L.push(`\n${tl(lang, '等你决定 {n} 件：', { n: d.waitingOnMe.length })}`); d.waitingOnMe.forEach((x) => L.push(line(x))); }
  if (d.inConflict.length) { L.push(`\n${tl(lang, '答复不一致、等结论 {n} 件（{how}）：', { n: d.inConflict.length, how: d.inConflict.some((x) => x.canRule) ? tl(lang, '双方先商量；你可以直接裁定') : tl(lang, '双方先商量，谈不拢或到期转负责人裁定') })}`); d.inConflict.forEach((x) => L.push(`- ${x.label}${bar}${x.taskTitle}${bar}${x.text}${x.parties?.length ? `${bar}${tl(lang, '在商量的：{names}', { names: list(x.parties) })}` : ''}${x.canRule && x.conflictId ? `\n  → ${tl(lang, '直接裁定：{cmd}', { cmd: `node src/cli.mjs answer ${x.conflictId} "..."` })}` : ''}`)); }
  if (d.unaddressed.length) { L.push(`\n${tl(lang, '没人接的 {n} 件（没有路由到任何人；你答，或在任务页转给别人）：', { n: d.unaddressed.length })}`); d.unaddressed.forEach((x) => L.push(line(x))); }
  if (d.waitingOnOthers.length) { L.push(`\n${tl(lang, '你答过、还在等别人的 {n} 件：', { n: d.waitingOnOthers.length })}`); d.waitingOnOthers.forEach((x) => L.push(`- ${x.label}${bar}${x.taskTitle}${bar}${tl(lang, '还差：{names}', { names: list(x.missing) || '—' })}`)); }
  if (d.informed.length) { L.push(`\n${tl(lang, '只是知会你的 {n} 件（不用你答）：', { n: d.informed.length })}`); d.informed.forEach((x) => L.push(`- ${x.label}${bar}${x.taskTitle}${bar}${x.text}`)); }
  if (d.tasksWaiting.length) { L.push(`\n${tl(lang, '任务状态：')}`); d.tasksWaiting.forEach((t) => L.push(`- ${t.title}${en ? ` (${t.taskId})` : `（${t.taskId}）`}${colon}${taskWaitText(t, lang)}`)); }
  if (d.unreadReports) L.push(`\n${tl(lang, '未读汇报 {n} 份：', { n: d.unreadReports })}${(d.unreadReportTasks ?? []).map((t) => tl(lang, '{title} {n} 份（{cmd}）', { title: t.title, n: t.n, cmd: `node src/cli.mjs reports ${t.taskId}` })).join(en ? '; ' : '；')}`);
  if (d.catalog) {
    L.push(`\n${tl(lang, '模型目录')}${d.catalog.checkedAt ? tl(lang, '（上次检查 {age}前）', { age: age(at - d.catalog.checkedAt) }) : ''}${colon}${d.catalog.warnings ? tl(lang, '{n} 项要看一眼', { n: d.catalog.warnings }) : ''}${d.catalog.drifts.length ? `${d.catalog.warnings ? (en ? '; ' : '；') : ''}${tl(lang, '调用时发现 {n} 处厂商代答', { n: d.catalog.drifts.length })}` : ''}`);
    for (const x of d.catalog.drifts) L.push(`- ${x}`);
    for (const x of d.catalog.lines.slice(0, 8)) L.push(`- ${x}`);
    if (d.catalog.lines.length > 8) L.push(`- ${tl(lang, '…还有 {n} 行', { n: d.catalog.lines.length - 8 })}`);
    L.push(`  → ${tl(lang, '全文：node src/cli.mjs catalog check；目录只由人改（src/llm/canonical.mjs）')}`);
  }
  if (d.dissents.length) { L.push(`\n${tl(lang, '{when}的不同意见 {n} 条（已记录，不改结论）：', { when: d.since ? tl(lang, '上次摘要以来') : tl(lang, '最近 7 天'), n: d.dissents.length })}`); d.dissents.forEach((x) => L.push(`- ${tl(lang, '{by} 对「{question}」的结论：{text}', { by: x.by, question: x.questionText, text: x.text })}`)); }
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
    const lang = digest.lang ?? 'zh';
    const title = `[SuperIntern] ${kind === 'handover' ? tl(lang, '接班：') : ''}${tl(lang, '{name} 的待办 {n} 件等你', { name: digest.name, n: digest.actionable })}${digest.total > digest.actionable ? tl(lang, '，另 {n} 项', { n: digest.total - digest.actionable }) : ''}`;
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
  if (!isValidAfter(every)) throw new I18nError('摘要间隔写法不对：{every}（可用 30m / 8h / 1d / 1bd）', { every: `${every}` });
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
export function renderHandover(ch, lang = 'zh') {
  const L = [];
  const en = lang === 'en';
  const bar = en ? ' | ' : '｜';
  const list = (xs) => xs.join(en ? ', ' : '、');
  const paren = (x) => (en ? ` (${x})` : `（${x}）`);
  const key = (k) => (k ? tl(lang, '项目「{title}」', { title: ch.projectTitles?.[k] ?? k }) : tl(lang, '默认决策路由'));
  const nm = (id) => ch.names?.[id] ?? id;
  const one = (s) => (s === 'group:*' ? tl(lang, '所有成员') : s.startsWith('group:') ? tl(lang, '标签 {tag}', { tag: s.slice(6) }) : s === 'on_duty' ? tl(lang, '值班人') : s === 'parties' ? tl(lang, '冲突双方') : s.replace(/user:([A-Za-z0-9_-]+)$/, (m, id) => (id === 'lead' ? tl(lang, '负责人') : nm(id))));
  const rs = (xs) => list(xs.map((s) => { const t = String(s); return t.startsWith('inform:') ? tl(lang, '知会 {who}', { who: one(t.slice(7)) }) : one(t); }));
  L.push(`${ch.from.name} → ${ch.to.name}${paren(tl(lang, '范围：{scope}', { scope: ch.scopeText }))}`);
  if (ch.projects.length) L.push(tl(lang, '负责人变更 · 项目 {n} 个：{list}', { n: ch.projects.length, list: list(ch.projects.map((p) => `${p.title}${paren(p.id)}`)) }));
  if (ch.soloTasks.length) L.push(tl(lang, '负责人变更 · 不属于项目的任务 {n} 个：{list}', { n: ch.soloTasks.length, list: list(ch.soloTasks.map((t) => `${t.title}${paren(t.id)}`)) }));
  if (ch.routing.length) { L.push(tl(lang, '决策路由 {n} 行：', { n: ch.routing.length })); ch.routing.forEach((r) => L.push(`  - ${key(r.key)}${bar}${tl(lang, '{label}（范围 {scope}）顺位 {position} 的接收人：{before} → {after}', { label: byCatalog(lang, r.label), scope: r.scope, position: r.position, before: rs(r.before), after: rs(r.after) })}${r.merged ? tl(lang, '（接手人已在该行，已合并）') : ''}`)); }
  if (ch.duty.length) ch.duty.forEach((d) => L.push(tl(lang, '值班表（{key}）：{before} 改为 {after}', { key: key(d.key), before: d.before.map(nm).join(' → '), after: d.after.map(nm).join(' → ') })));
  if (ch.transferred.length) { L.push(tl(lang, '转给接手人的待决事项 {n} 条：', { n: ch.transferred.length })); ch.transferred.forEach((q) => L.push(`  - ${byCatalog(lang, q.label)}${bar}${q.taskTitle}${bar}${q.text}${paren(q.id)}`)); }
  if (ch.escalated.length) { L.push(tl(lang, '转负责人裁定的冲突事项 {n} 条（交出方是冲突方，其立场不随交接转移）：', { n: ch.escalated.length })); ch.escalated.forEach((q) => L.push(`  - ${q.taskTitle}${bar}${q.text}${paren(q.id)}`)); }
  if (ch.informed.length) L.push(tl(lang, '知会对象改为接手人的事项 {n} 条', { n: ch.informed.length }));
  if (ch.kept.length) L.push(tl(lang, '不作变更 {n} 条（交出方已答复）', { n: ch.kept.length }));
  if (ch.disabled) L.push(tl(lang, '交接后停用 {name}：吊销令牌 {n} 个，通知通道不转移', { name: ch.from.name, n: ch.tokensRevoked }));
  for (const w of ch.warnings) L.push(tl(lang, '注意：{warning}', { warning: w }));
  if (ch.empty) L.push(tl(lang, '没有需要交接的内容。'));
  L.push(tl(lang, '已有的答复与签收记录、审计日志、已结束的项目与任务不受影响。'));
  if (ch.note) L.push(`\n${tl(lang, '交出方备注：{note}', { note: ch.note })}`);
  return L.join('\n');
}

/** 交接执行后通知接手人：交接清单 + 他此刻的待办。**不抛**。 */
export async function sendHandoverNotice(db, { changes, at = now(), env = process.env, extraCmd = null, fetchFn = globalThis.fetch, spawn }) {
  const channels = channelsForUsers(db, [changes.to.id]);
  if (!channels.length) return { sent: false, receipts: [] };
  const lang = userLang(db, changes.to.id);
  const text = `${renderHandover(changes, lang)}\n\n${renderDigest(buildDigest(db, { userId: changes.to.id, at }), { at })}`;
  const receipts = await notify(db, { taskId: null, kind: 'digest', title: `[SuperIntern] ${tl(lang, '{from} 把{scope}范围内的责任交给了你', { from: changes.from.name, scope: changes.scopeText })}`, text, ref: `handover:${changes.from.id}:${changes.to.id}`, channels, fetchFn, ...(spawn ? { spawn } : {}) });
  return { sent: true, receipts };
}
