// ── 我的待办（跨任务，按当前身份）──────────────────────────────────────
let digestData = null;
async function renderDigest() {
  if (!me || me.role === 'observer') return;
  try { digestData = await api('/api/digest'); } catch (e) { $('#digest').innerHTML = `<span class="mute">${esc(e.message)}</span>`; return; }
  const d = digestData;
  // 收件箱按"你要做的动作"分组，每条一行（用户试用 2026-09-22：原来每条都铺一段正文、同一组里签收 / 批准 / 提问 / 报警混在一起，
  // 几条下来就是一堵字墙，看不出每条要我做什么）。项目筛选只影响这一页，记在本机浏览器里。
  const allItems = [...d.waitingOnMe.map((x) => ({ ...x, src: 'me' })), ...d.inConflict.map((x) => ({ ...x, src: 'conflict' })), ...d.unaddressed.map((x) => ({ ...x, src: 'unaddressed' }))];
  const projOf = (x) => x.projectId ?? '';
  const projName = (x) => x.projectTitle ?? T('独立任务（旧）');
  const projs = new Map();
  for (const x of [...allItems, ...d.waitingOnOthers, ...d.informed]) projs.set(projOf(x), { name: projName(x), n: (projs.get(projOf(x))?.n ?? 0) + (allItems.includes(x) ? 1 : 0) });
  let pf = ''; try { pf = localStorage.getItem('si.inboxProject') ?? ''; } catch { /* 无痕窗口等：不记 */ }
  if (pf && !projs.has(pf)) pf = '';
  const inP = (x) => !pf || projOf(x) === pf;
  const items = allItems.filter(inP);
  $('#digestTag').textContent = d.total ? `${T('{n} 项待你处理', { n: d.actionable })}${d.total > d.actionable ? ` · ${T('{n} 项仅供知悉', { n: d.total - d.actionable })}` : ''}` : T('没有待办');

  const ago2 = (t) => (span(t, d.at) === T('刚刚') ? T('刚刚') : T('{t}前', { t: span(t, d.at) }));
  const due = (x) => (x.dueAt ? (x.dueAt > d.at ? ` · ${T('{t}后到期', { t: span(x.dueAt, d.at) })}` : ` · <span class="bad">${T('已到期')}</span>`) : '');
  // 只有标题一个链接（标题和任务名都是链接、去的是同一处的话，读者分不出两者区别）
  const where = (x) => (x.carrier ? `${esc(projName(x))} · ${T('项目方案（不属于某个任务）')}`
    : `${x.projectId ? `${esc(projName(x))} › ` : ''}${esc(x.taskTitle ?? x.taskId)}`);
  const openHref = (x) => (x.carrier ? `#p/${x.projectId}` : `#${x.taskId}`);
  const said = (x) => ((x.answers ?? []).length ? `<div class="small" style="margin-top:4px">${x.answers.map((a) => `<div><b>${esc(a.name)}</b> <span class="mute">${a.stance === 'agree' ? T('附议') : T('已答复')}</span>${T('：')}${esc(a.text)}</div>`).join('')}</div>` : '');
  const irow = (x) => `<div class="irow">
      <div class="irow-main"><a class="irow-title" href="${openHref(x)}" title="${T('打开所在页面处理')}">${esc(x.headline || String(x.text).slice(0, 90))}</a>
        ${x.src === 'unaddressed' ? `<span class="pill" title="${T('路由表没有匹配到接收人；你是负责人，可以直接处理或转交')}">${T('无人接收')}</span>` : ''}</div>
      <div class="small mute">${where(x)} · ${ago2(x.askedAt)}${due(x)}${x.defaultAction && x.dueAt ? ` · ${T('到期默认：{action}', { action: esc(x.defaultAction.slice(0, 40)) })}` : ''}${x.parties?.length ? ` · ${T('协商方：{names}', { names: esc(x.parties.join(T('、'))) })}` : ''}</div>
      ${x.decisionType === 'signoff' ? excLineHtml(x.exceptions, openHref(x)) : ''}
      <details class="small"><summary class="mute">${T('摘要')}</summary><div class="body" style="margin-top:4px">${qBodyHtml(x.text, x.decisionType, 'inbox')}</div>${said(x)}</details>
      ${x.decisionType === 'signoff' ? (() => { const k = `sig:${esc(x.taskId)}:${esc(x.questionId)}`;
        return `<details class="small" data-pvopen="${esc(x.taskId)}"${DV_DETAILS_OPEN.has(`pv:${esc(x.taskId)}`) ? ' open' : ''}><summary class="mute">${T('看页面截图')}</summary><div class="pv-slot">${T('正在读取…')}</div></details>`
          + `<details class="small" data-dvopen="${esc(k)}"${DV_DETAILS_OPEN.has(k) ? ' open' : ''}><summary class="mute">${T('看改动（逐行取自代码）')}</summary>${dvSlot(k, `/api/tasks/${esc(x.taskId)}/diff`, `/api/tasks/${esc(x.taskId)}/diff_lines`, { scopes: true })}</details>`; })() : ''}
    </div>`;
  const alarm = (x) => ['停等', '空转', 'Stalled', 'Going in circles'].includes(x.tag);   // 标签随内容语言（src/i18n/marks.mjs 的 stall / loop）
  const KINDS = [
    { key: 'approve', title: T('方案待批准'), how: T('批准，或写下要改什么'), test: (x) => x.decisionType === 'contract_approval' },
    { key: 'signoff', title: T('待签收'), how: T('接受，或打回并写明理由'), test: (x) => x.decisionType === 'signoff' },
    { key: 'conflict', title: T('意见冲突'), how: T('选定以哪一方为准（以新为准 / 以旧为准）；列出了协商方的，先和对方谈'), test: (x) => x.src === 'conflict' || x.decisionType === 'conflict' },
    { key: 'alarm', title: T('系统报警'), how: T('不是在等你答题：系统发现某个任务停住了、又说不出它在等谁。请看一眼 —— 中止它，或替它找个接手的人'), test: alarm },
    { key: 'question', title: T('要你回答的问题'), how: T('在所在页面的「待决事项」里答复'), test: (x) => ['spec_choice', 'structural', 'ops'].includes(x.decisionType) },
    { key: 'limit', title: T('上限与联网'), how: T('决定追加额度，或放行 / 拒绝联网'), test: (x) => ['budget', 'egress'].includes(x.decisionType) },
    { key: 'other', title: T('其他'), how: '', test: () => true },
  ];
  const buckets = KINDS.map((k) => ({ ...k, list: [] }));
  for (const x of items) buckets.find((b) => b.test(x)).list.push(x);
  const bucketHtml = buckets.filter((b) => b.list.length).map((b) => `<section class="ibucket">
      <div class="ibucket-head"><b>${esc(b.title)}</b> <span class="badge">${b.list.length}</span>${b.how ? ` <span class="small mute">— ${esc(b.how)}</span>` : ''}</div>
      ${b.list.map(irow).join('')}</section>`).join('');

  const opts = [...projs.entries()].sort((a, b) => b[1].n - a[1].n);
  const bar = opts.length > 1 ? `<div class="row small" style="margin:4px 0 8px"><label class="mute" for="inboxProj">${T('只看')}</label>
      <select id="inboxProj" style="width:auto"><option value="">${T('全部项目（{n}）', { n: allItems.length })}</option>${opts.map(([id, o]) => `<option value="${esc(id)}"${id === pf ? ' selected' : ''}>${esc(o.name)}${T('（{n}）', { n: esc(o.n) })}</option>`).join('')}</select></div>` : '';

  // 不用你动手、只需要知道的：收进一个折叠区，默认收起
  const fyiRow = (x, extra = '') => `<div class="small" style="padding:3px 0">${where(x)} · ${esc(x.headline || '')}${extra}</div>`;
  const fyiParts = [
    (d.requestsDone ?? []).length ? `<div style="margin-top:6px"><b>${T('你提的需求做完了')}</b>${T('（{n}）', { n: d.requestsDone.length })}</div>${d.requestsDone.map((x) => `<div class="small" style="padding:3px 0"><a href="#${esc(x.taskId)}">${esc(x.title)}</a> <span class="mute">· ${esc(x.projectTitle ?? '')} · ${T('已合并进项目分支，{t}前', { t: ago(x.at) })}</span></div>`).join('')}` : '',
    d.waitingOnOthers.filter(inP).length ? `<div style="margin-top:6px"><b>${T('你已答复，还在等别人')}</b>${T('（{n}）', { n: d.waitingOnOthers.filter(inP).length })}</div>${d.waitingOnOthers.filter(inP).map((x) => fyiRow(x, ` <span class="mute">· ${T('待 {names}', { names: esc(x.missing.join(T('、')) || '—') })}</span>`)).join('')}` : '',
    d.informed.filter(inP).length ? `<div style="margin-top:6px"><b>${T('抄送给你的')}</b>${T('（{n}）', { n: d.informed.filter(inP).length })}</div>${d.informed.filter(inP).map((x) => fyiRow(x)).join('')}` : '',
    d.tasksWaiting.length ? `<div style="margin-top:6px"><b>${T('任务状态')}</b></div>${d.tasksWaiting.map((t) => { const who = t.waitingOn?.length ? esc(t.waitingOn.join(T('、'))) : null; const s = t.status === 'suspended' ? T('已暂停') : t.status === 'awaiting_signoff' ? (who ? T('已完成，待{who}签收', { who: sp(who) }) : T('已完成，待签收')) : (who ? T('待{who}答复', { who: sp(who) }) : T('待答复')); return `<div class="small"><a href="#${esc(t.taskId)}">${esc(t.title ?? t.taskId)}</a> ${s}</div>`; }).join('')}` : '',
    d.unreadReports ? `<div class="small" style="margin-top:6px">${T('<b>未读报告</b> {n} 份：', { n: esc(d.unreadReports) })}${(d.unreadReportTasks ?? []).map((t) => `<a href="#${esc(t.taskId)}">${esc(t.title ?? t.taskId)}</a> ${T('{n} 份', { n: esc(t.n) })}`).join(T('，'))}${T('（在任务页「报告」中查看）')}</div>` : '',
    d.catalog ? `<div style="margin-top:6px"><b>${T('模型目录')}</b>${d.catalog.checkedAt ? `<span class="mute">${T('（上次检查 {t}前）', { t: span(d.catalog.checkedAt, d.at) })}</span>` : ''} ${d.catalog.warnings ? T('{n} 项需检查', { n: esc(d.catalog.warnings) }) : ''}${d.catalog.drifts.length ? `${d.catalog.warnings ? T('；') : ''}${T('{n} 处请求由其他模型响应', { n: d.catalog.drifts.length })}` : ''}</div>${[...d.catalog.drifts, ...d.catalog.lines.slice(0, 8)].map((x) => `<div class="small">· ${esc(x)}</div>`).join('')}<div class="small mute">${T('目录仅支持人工修改；完整结果：node src/cli.mjs catalog check')}</div>` : '',
    (d.dissents ?? []).length ? `<div style="margin-top:6px"><b title="${T('结论生效后收到的异议；已记录，结论不变')}">${T('结论之后的异议')}</b>${T('（{n}）', { n: d.dissents.length })}</div>${d.dissents.map((x) => `<div class="small">${esc(x.by)} · <a href="#${esc(x.taskId)}">${esc(x.questionText ?? '')}</a>${T('：')}${esc(x.text)}</div>`).join('')}` : '',
  ].filter(Boolean);
  const fyiCount = (d.requestsDone ?? []).length + d.waitingOnOthers.filter(inP).length + d.informed.filter(inP).length + d.tasksWaiting.length + (d.unreadReports ? 1 : 0) + (d.catalog ? 1 : 0) + (d.dissents ?? []).length;

  $('#digest').innerHTML = [
    (d.daemonOff ? `<div class="item flag" style="margin-top:6px">${T('<b>自动运行未开启</b>：{n} 个未结束的任务不会自动推进，超时与通知也不会处理。', { n: esc(d.daemonOff.unfinished) })}<div class="small mute" style="margin-top:4px">${T('启动守护进程后恢复：node src/cli.mjs web --daemon（或计划任务）。在此之前需在各任务页手动点击「运行」。')}</div></div>` : ''),
    // 可能在走过场的人（只给管理员）。常显、不收进"不需要你动手"：它要负责人去看，但不拦任何操作
    (d.rubberStamps ?? []).length ? `<div class="item flag" style="margin-top:6px"><b>⚠ ${T('可能在走过场')}</b> <span class="small mute">${T('只是提醒，不拦任何操作')} · <a href="#settings/users">${T('看批准习惯')}</a></span>${d.rubberStamps.map((x) => `<div class="small">${T('{name}：最近 {n} 次都批准，打开后中位数 {t} 就答', { name: esc(whoName(x.userId, x.name)), n: esc(x.streak), t: esc(durS(x.medianOpenMs)) })}</div>`).join('')}</div>` : '',
    (d.credentialsExpiring ?? []).length ? `<section class="ibucket"><div class="ibucket-head"><b>${T('快到期的连接')}</b> <span class="badge">${d.credentialsExpiring.length}</span></div>${d.credentialsExpiring.map((c) => `<div class="irow"><div class="irow-main"><a class="irow-title" href="#settings/conn">${esc(c.name)}</a></div><div class="small mute">${c.expired ? T('已过期') : T('{t}后到期', { t: span(Date.now(), c.expiresAt) })} · ${T('到期后交付会推不上去：在「设置 → 连接」加一份新的，再吊销旧的')}</div></div>`).join('')}</section>` : '',
    (d.toDeliver ?? []).length ? `<section class="ibucket"><div class="ibucket-head"><b>${T('等你交付的项目')}</b> <span class="badge">${d.toDeliver.length}</span></div>${d.toDeliver.map((x) => `<div class="irow"><div class="irow-main"><a class="irow-title" href="#p/${esc(x.projectId)}">${esc(x.title)}</a></div><div class="small mute">${x.again ? T('上次交付之后又合并了 {n} 个任务（{titles}），这些改动还没推到你们的仓库。再点一次「交付项目」，会把项目连同这几个新任务一起推上去，之前推过的内容不受影响。', { n: esc(x.sinceDelivery), titles: (x.newTitles ?? []).map((t) => T('「{t}」', { t: esc(t) })).join(T('、')) }) : T('已达成，{n} 个任务都已合进项目分支 —— 这时还只在这套系统里。', { n: esc(x.merged) })}${T('到项目页点「交付项目」，才会推到你们的代码仓库（只能你亲自点，推出去收不回；点之前页面会列出要推的内容）。交付之后这一条自动消失')}</div></div>`).join('')}</section>` : '',
    (d.stalledProjects ?? []).length ? `<section class="ibucket"><div class="ibucket-head"><b>${T('已停滞的项目')}</b> <span class="badge">${d.stalledProjects.length}</span></div>${d.stalledProjects.map((x) => `<div class="irow"><div class="irow-main"><a class="irow-title" href="#p/${esc(x.projectId)}">${esc(x.title)}</a></div><div class="small mute">${x.kind === 'review_shelved' ? T('全部任务都已合并，复盘时选了「先放着」，还没宣布达成 · 点项目名进项目页，可以「重新复盘」、添加任务或中止项目') : `${T('任务「{title}」已中止，剩下的任务都在等它', { title: esc(x.taskTitle ?? '') })}${x.why ? ` · ${T('中止原因：{why}', { why: esc(String(x.why).slice(0, 80)) })}` : ''} · ${T('到项目页恢复或重做该任务')}`}</div></div>`).join('')}</section>` : '',
    (d.handoverRequests ?? []).length ? `<section class="ibucket"><div class="ibucket-head"><b>${T('交接申请')}</b> <span class="badge">${d.handoverRequests.length}</span></div>${d.handoverRequests.map((r) => `<div class="irow"><div>${T('{from} 申请将{scope}范围内的职责交接给 {to}', { from: esc(r.fromName), scope: r.scope?.project ? esc(r.scopeText) : T('「{t}」', { t: esc(r.scopeText) }), to: esc(r.toName) })}${r.thenDisable ? T('，交接后停用') : ''}${r.note ? ` <span class="mute">· ${T('备注：{note}', { note: esc(r.note.slice(0, 80)) })}</span>` : ''}</div><div class="small" style="margin-top:4px">${r.canDecide ? `<a href="#settings" data-gousers="1">${T('前往「设置 → 成员」查看清单并批准 / 驳回')}</a>` : `<span class="mute">${T('待{who}批准；', { who: esc(r.approver ?? T('管理员')) })}</span><a href="#settings" data-gousers="1">${T('可在「设置 → 成员」撤回')}</a>`}</div></div>`).join('')}</section>` : '',
    bar,
    items.length ? bucketHtml : `<div class="mute small" style="margin:8px 0">${pf ? T('这个项目下没有要你处理的事项') : T('没有要你处理的事项')}</div>`,
    fyiParts.length ? `<details class="ifyi" style="margin-top:12px"><summary><b>${T('仅供知悉')}</b> <span class="small mute">${T('（{n} 项：别人还没答的、抄送给你的、任务状态、报告等 —— 不需要你动手）', { n: fyiCount })}</span></summary>${fyiParts.join('')}</details>` : '',
  ].join('');
  const sel = $('#inboxProj');
  if (sel) sel.onchange = () => { try { localStorage.setItem('si.inboxProject', sel.value); } catch { /* 记不住就算了 */ } renderDigest(); };
  // 签收的"看运行效果"：同样点开才读
  $('#digest').querySelectorAll('details[data-pvopen]').forEach((dt) => {
    const load = async () => {
      const slot = dt.querySelector('.pv-slot');
      try {
        const pv = await api(`/api/tasks/${encodeURIComponent(dt.dataset.pvopen)}/preview`);
        slot.innerHTML = pv ? previewHtml(dt.dataset.pvopen, pv) : `<span class="mute">${T('这个任务没有页面截图：仓库里没有说明怎么把页面跑起来（没有界面的任务通常就是这样；如果它明明有界面，那是做的人漏了，可以打回要求补上）。')}</span>`;
      } catch (e) { slot.textContent = T('读不到：{msg}', { msg: e.message }); }
    };
    if (dt.open) load();
    dt.ontoggle = () => { if (dt.open) { DV_DETAILS_OPEN.add(`pv:${dt.dataset.pvopen}`); load(); } else DV_DETAILS_OPEN.delete(`pv:${dt.dataset.pvopen}`); };
  });
  // 签收的"看改动"：点开才读（收件箱里可能一排签收）；开着的那几个在刷新后保持开着
  $('#digest').querySelectorAll('details[data-dvopen]').forEach((dt) => {
    if (dt.open) dvHydrate(dt);
    dt.ontoggle = () => { if (dt.open) { DV_DETAILS_OPEN.add(dt.dataset.dvopen); dvHydrate(dt); } else DV_DETAILS_OPEN.delete(dt.dataset.dvopen); };
  });
}
document.addEventListener('click', (e) => { if (e.target.closest?.('[data-gousers]')) pane = 'users'; }, true);
const span = (ts, base) => { const ms = Math.abs(base - ts); return ms < 60_000 ? T('刚刚') : ms < 3_600_000 ? T('{n} 分钟', { n: Math.round(ms / 60_000) }) : ms < 86_400_000 ? T('{n} 小时', { n: (ms / 3_600_000).toFixed(1) }) : T('{n} 天', { n: (ms / 86_400_000).toFixed(1) }); };

function renderConstitution() {
  const c = detail.constitution, d = detail.draft;
  const stageText = { asking: T('澄清中，待决事项答复后继续'), proposed: T('草案待批准（见待决事项）'), approved: T('草案已批准，正在规划') };
  $('#constTag').textContent = d ? stageText[d.stage] ?? d.stage : c ? `v${c.version}${(c.overruled || []).length ? ` · ${T('其中 {n} 条已被判作废', { n: c.overruled.length })}` : ''}` : T('（无）');
  const block = c ? `${(c.overruled || []).length ? `<div class="item"><div class="small">${T('<b>⚠ 下面这份任务说明里有 {n} 条已被判作废</b>（原文没改，执行时照新的说法做；读完成标准时以这里为准）：', { n: c.overruled.length })}</div>${c.overruled.map((o) => `<div class="small">· ${T('「{t}」', { t: esc(String(o.statement).slice(0, 200)) })}—— ${esc(nameOf(o.by))} ${o.at ? esc(fmtWhen(o.at, { time: false })) : ''} ${o.viaQuestion ? T('在冲突事项里判了「以新为准」') : T('手工作废')}${o.quote ? T('，新的说法：「{quote}」', { quote: esc(String(o.quote).slice(0, 160)) }) : ''}</div>`).join('')}</div>` : ''}<div class="body">${T('目标：{v}', { v: esc(c.goal) })}\n${T('范围：{v}', { v: esc(c.scope) })}\n${T('完成标准：{v}', { v: esc(locContract(c.definition_of_done)) })}\n${T('约束：{v}', { v: (c.constraints || []).length ?'\n' + c.constraints.map((x) => `  - ${esc(locContract(x))}`).join('\n') : T('（无）') })}${d?.verifyCommand ? `\n${T('验收命令：{v}', { v: esc(d.verifyCommand) })}` : ''}${d?.notes ? `\n\n${T('草案说明：{v}', { v: esc(d.notes) })}` : ''}</div>` : '';
  const idea = d ? `<div class="item"><div class="small mute">${T('原始需求')}${d.source ? ` · ${T('现有仓库 {src}', { src: esc(d.source) })}` : ` · ${T('新仓库')}`}</div><div class="body">${esc(d.idea)}</div></div>` : '';
  $('#constitution').innerHTML = idea + (block || (d ? `<span class="mute">${T('（暂无草案）')}</span>` : `<span class="mute small">${T('无')}</span>`));
}

function renderHeader() {
  const t = detail.task;
  const st = $('#taskStatus'); st.textContent = ({ planning: T('规划中'), running: T('进行中'), waiting: T('待答复'), suspended: T('已暂停'), done: T('已完成'), aborted: T('已中止') })[t.status] ?? t.status; st.className = `pill task-only ${t.status}`;
  const so = ({ accepted: T('已接受'), rejected: T('已打回'), pending: T('待签收'), void: T('需重新签收') })[detail.signoff] ?? (t.status === 'done' ? T('待签收') : '—');
  // 两层预算都写：任务自己的上限，和项目预算闸还剩多少；哪层会先撞到，点明
  const pb = detail.projectBudget, taskCap = detail.limits['limit.budget_micro_usd']?.value;
  const taskLeft = taskCap == null ? null : taskCap - detail.spendMicro;
  const projFirst = pb && (pb.over || taskLeft == null || pb.remaining < taskLeft);
  // 直接写"还能花多少"，括号里只点起作用的那一层（一行写全两层四个数，读不过来）；两层的数都在悬停提示里
  $('#spend').textContent = !pb ? T('本任务花费 {spent} / 上限 {limit} · 签收：{signoff}', { spent: usd(detail.spendMicro), limit: usd(taskCap), signoff: so })
    : pb.over ? T('本任务花费 {spent} · 项目预算 {gate} 已用完，不再开新任务 · 签收：{signoff}', { spent: usd(detail.spendMicro), gate: usd(pb.gate), signoff: so })
    : T('本任务花费 {spent} · 还能花 {left}（{which}） · 签收：{signoff}', { spent: usd(detail.spendMicro), left: usd(Math.max(0, projFirst ? pb.remaining : taskLeft)), signoff: so,
      which: projFirst ? T('项目预算只剩这些') : T('到本任务上限为止') });
  $('#spend').title = pb ? T('本任务上限 {limit}，这个任务还剩 {tleft}：只管这一个任务，在本页「上限」里改。项目预算 {gate}，整个项目还剩 {rem}：所有任务加上起草方案合计，在项目设置里改；别的任务也在花，所以「还能花」会变少', { limit: usd(taskCap), tleft: usd(Math.max(0, taskLeft ?? 0)), gate: usd(pb.gate), rem: usd(pb.remaining) })
    : T('这个任务已用 / 这个任务的预算上限（整个项目的累计花费在项目页）');
  document.querySelectorAll('.task-lead-only').forEach((el) => el.classList.toggle('hide', !isLead()));   // 按任务的负责人，不按全局角色：交接后负责人不止一个
  $('#runState').textContent = detail.running ? (isLead() ? T('运行中（PID {pid}）', { pid: detail.running.pid }) : T('运行中')) : '';
  $('#btnRun').disabled = !!detail.running || ['aborted', 'suspended'].includes(t.status);
  { // 下一步：这件事现在由谁推进、为什么没动。与守护进程同一个判断（detail.schedule）。
    const sc = detail.schedule ?? {}, rs = String(sc.reason ?? ''), VERB = { draft: T('澄清需求'), plan: T('规划步骤'), run: T('执行') }[sc.verb] ?? T('执行');
    const gaveUp = rs.startsWith('gave_up'), needsHuman = rs.startsWith('needs_human');
    let txt = '', warn = false;
    if (detail.running) txt = T('正在{verb}', { verb: VERB });
    else if (t.status === 'waiting') txt = T('等待答复：{n} 条待决事项（见下方）', { n: detail.questions.filter((q) => ['open', 'escalated'].includes(q.status)).length });
    else if (t.status === 'suspended') txt = T('已暂停：点击「继续」后才会推进');
    else if (t.status === 'aborted') txt = '';
    else if (t.status === 'done') txt = '';
    else if (gaveUp) { txt = T('自动运行已停止重试（连续失败 {n} 次）。排查日志后点击「立即重试」', { n: sc.attempts ?? '' }); warn = true; }
    else if (needsHuman) { txt = rs.includes('provider_rejected') ? T('模型服务商拒绝了请求（如密钥无效）：请在「设置」中修正，修正后自动继续') : T('上一次运行已停下，等待处理：查看日志与待决事项，或发送消息说明下一步'); warn = true; }
    else if (rs.startsWith('backoff')) txt = T('上次{verb}失败，{when}自动重试', { verb: VERB, when: sc.readyAt ? T('约 {t}后', { t: span(sc.readyAt, Date.now()) }) : T('稍后') });
    else if (rs === 'no_workspace') { txt = T('尚未建立工作区：所属项目推进到此任务时自动建立'); }
    else if (sc.due) { txt = daemonOn ? T('已排队：自动运行即将开始{verb}', { verb: VERB }) : T('自动运行未开启：点击「运行」开始{verb}', { verb: VERB }); warn = !daemonOn; }
    $('#nextStep').textContent = txt; $('#nextStep').style.color = warn ? 'var(--wait)' : 'var(--mute, #888)';
    // 自动运行开着时人不当调度器：隐藏「运行」，只在放弃重试 / 需要人处理时露出「立即重试」。
    const showRun = !daemonOn || gaveUp || needsHuman;
    $('#btnRun').classList.toggle('hide', !showRun || !isLead());
    $('#btnRun').textContent = daemonOn ? T('立即重试') : T('运行');
    $('#btnRun').title = daemonOn ? T('自动运行已不再重试这一步；排查后手动再试一次') : T('自动运行未开启，需手动启动。当前将{verb}', { verb: VERB }); }
  $('#btnPause').disabled = !['running', 'waiting'].includes(t.status);
  $('#btnResume').disabled = t.status !== 'suspended';
  $('#btnAbort').disabled = ['done', 'aborted'].includes(t.status);
  { const pj = projectOf(cur), superseded = !!t.project_id && t.project_order === null;
    const canReopen = t.status === 'aborted' && !superseded && !(pj && ['aborted', 'done'].includes(pj.status));
    $('#btnReopen').classList.toggle('hide', !canReopen || !isLead());
    $('#btnAbort').classList.toggle('hide', t.status === 'aborted');
    const ab = $('#btnArchive'); const canArch = !t.project_id && ended(t.status);
    ab.classList.toggle('hide', !canArch || !isLead());
    ab.textContent = t.archived_at ? T('取消归档') : T('归档'); ab.title = t.archived_at ? T('重新显示在侧栏的「已结束」中') : T('从侧栏隐藏（移入「已归档」）；任务状态与记录不变');
    if (superseded) $('#runState').textContent = T('已被重做的任务取代'); }
  $('#btnSignoffOk').disabled = $('#btnSignoffNo').disabled = $('#btnDeliver').disabled = t.status !== 'done';
  // 不归你的按钮不显示（原来签收的「接受 / 打回」对非收件人也亮着，收件人以外的人不敢点）：
  // 只有一条开着的签收事项发给了你（或你是负责人）时才显示；项目里的任务在项目页「交付项目」，这里不给「交付」
  //（复盘任务页上点它报"任务工作区不存在"）。
  { const so = detail.questions.find((q) => q.decision_type === 'signoff' && ['open', 'escalated'].includes(q.status));
    $('#btnSignoffOk').parentElement.classList.toggle('hide', !(so && me && (so.addressed_to.includes(me.id) || isLead())));
    // 按钮灰着要说为什么（不说的话，连点几次「接受」没反应，人会以为按钮坏了）
    $('#btnSignoffOk').parentElement.title = t.status === 'done' ? T('任务完成后，由路由表指定的成员签收') : T('现在签不了：这个任务又在改。改完之后系统会按新版本重新请你签收，这一条会自动作废');
    $('#sayBody').placeholder = t.merged_at && t.project_order > 0 ? T('这个任务已经合并，不会再改了。类别选修正 / 新指令（或自动判成这两类）的话，会变成一条新需求、记在你名下，走添加任务的流程；选补充信息只记下来，不引出改动') : T('向任务发送消息：修正、新指令或补充信息');
    if (t.project_id) $('#btnDeliver').classList.add('hide'); }
  const sel = $('#sayAbout');
  sel.innerHTML = `<option value="">${T('不关联事项')}</option>` + detail.questions.slice(0, 20).map((q) => `<option value="${esc(q.id)}">${T('关联事项：{text}…', { text: esc(q.text.replace(/^【[^】]*】/, '').split('\n')[0]).slice(0, 30) })}</option>`).join('');
}
