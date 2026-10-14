// ── 项目页：仓库与分支、任务顺序与合并进度、推进 / 交付、本项目的决策路由 ─────────
// 项目页的两种视图（2026-09-22）：默认清单（状态 / 签收 / 合并一行一格，最适合管理），可切到依赖图看结构
// （菱形依赖、某个中止的任务挡住了下游哪些）。图与步骤图是同一个组件。选择记在本机浏览器里。
let projView = (() => { try { return localStorage.getItem('si.projView') === 'graph' ? 'graph' : 'list'; } catch { return 'list'; } })();
const projViewBar = (p) => (p.tasks.length > 1 ? `<div class="row small" style="margin-bottom:8px;gap:4px">
    <button class="small${projView === 'list' ? ' primary' : ''}" data-pv="list">${T('清单')}</button><button class="small${projView === 'graph' ? ' primary' : ''}" data-pv="graph">${T('依赖图')}</button></div>` : '');
function projGraphHtml(p, so) {
  const byOrder = new Map(p.tasks.map((t) => [t.project_order, t]));
  const open = p.openIds ?? [p.current];
  const items = p.tasks.map((t) => {
    const waiting = !t.started && !ended(t.status) && (t.waitsFor ?? []).length;
    const color = t.merged_at ? 'var(--ok)' : t.status === 'aborted' ? 'var(--bad)' : t.status === 'done' ? 'var(--wait)'
      : open.includes(t.id) ? 'var(--run)' : 'var(--mute)';
    const state = t.merged_at ? T('已合并') : t.status === 'done' ? T('已完成 · {signoff}', { signoff: so[t.signoff] ?? T('待签收') })
      : open.includes(t.id) ? (t.status === 'running' ? T('执行中') : T('执行中 · {status}', { status: ST_NAME[t.status] ?? t.status })) : waiting ? T('等待 {deps}', { deps: t.waitsFor.map((n) => `#${esc(n)}`).join(' ') })
      : !t.started && !ended(t.status) ? T('排队中') : (ST_NAME[t.status] ?? t.status);
    return { id: t.id, href: `#${t.id}`, title: `#${t.project_order} ${t.title}`, color, line1: esc(state),
      line2: (t.dependsOn ?? []).length ? T('依赖 {deps}', { deps: t.dependsOn.map((n) => `#${esc(n)}`).join(' ') }) : '',
      deps: (t.dependsOn ?? []).map((n) => byOrder.get(n)?.id).filter(Boolean) };
  });
  return vdagHtml(items, { key: 'proj' });
}

function renderProject() {
  const p = projects.find((x) => x.id === curProject);
  if (!p) { $('#projHead').innerHTML = `<span class="mute">${T('项目不存在')}</span>`; $('#projTasks').innerHTML = ''; return; }
  const lead = !!me && me.id === p.owner_id, byId = Object.fromEntries(tasksCache.map((t) => [t.id, t]));
  const ownerName = (me?.users ?? []).find((u) => u.id === p.owner_id)?.display_name ?? p.owner_id;
  const stage = p.status === 'proposed' ? T('方案 v{v}{state}', { v: p.draft_version ?? 1, state: p.draft_question ? T('，待批准') : T('，起草中') }) : T('{m}/{n} 已合并{more}', { m: p.merged, n: p.tasks.length, more: p.awaitingSignoff ? T(' · 有任务待签收') : '' });
  $('#projHead').innerHTML = `<div class="row"><h2 style="font-size:16px;margin:0">${esc(p.title)}</h2> <span class="pill ${p.status === 'active' ? 'running' : p.status === 'proposed' ? 'waiting' : esc(p.status)}">${esc(PST_NAME[p.status] ?? p.status)}</span> <span class="small mute">${esc(stage)}</span><span class="grow"></span>
      ${p.status === 'active' && lead && !daemonOn ? `<button id="btnProjAdvance" title="${T('合并已签收的任务分支并启动下一个任务；无可执行操作时不做变更，不会跳过进行中的任务。自动运行未开启时才需要手动推进')}">${T('推进')}</button>` : ''}
      ${p.delivered && !p.deliverDue && p.lastDelivery ? `<span class="pill done" title="${esc(p.lastDelivery.remote ?? '')}">${T('已交付')}</span> <span class="small mute">${T('{t}前推到 {remote}', { t: ago(p.lastDelivery.at), remote: esc(p.lastDelivery.remote ?? '—') })}</span>` : ''}
      ${p.status === 'done' && lead ? (p.delivered && !p.deliverDue
        ? `<button id="btnProjDeliver" title="${T('合并的内容都已经推出去了。要推到另一个远端、或重推一次时用')}">${T('再交付一次…')}</button>`
        : `<button id="btnProjDeliver" class="primary">${T('交付项目')}</button>`) : ''}
      ${p.status === 'aborted' && p.merged > 0 && lead ? `<button id="btnProjDeliver" title="${T('项目已中止；已签收并合并的任务仍可交付，PR 中会注明范围')}">${T('交付已合并的 {n} 个任务', { n: esc(p.merged) })}</button>` : ''}
      <button id="btnProjSet" class="ghost" title="${lead ? T('本项目的配置：标题与目标、成员与权限、决策路由、预算与上限、自动化，以及中止项目 / 归档 / 交接负责人') : T('查看本项目的配置：标题与目标、成员与权限。只有项目负责人能修改')}">⚙ ${T('项目设置')}</button></div>
    ${(p.abortedTasks ?? []).length && !['aborted', 'done'].includes(p.status) ? `<div class="item flag" style="margin-top:10px"><b>${p.status === 'stalled' ? T('项目已停滞') : T('有已中止的任务')}</b>${T('：')}${p.status === 'stalled' ? T('剩下的任务都在等已中止的任务，项目无法继续。') : T('依赖它的任务不会开工；其他任务照常执行（已中止的任务不占用执行位置）。当剩下的任务都在等已中止的任务时，项目会停滞，等负责人处理。')}${lead ? '' : T('等待项目负责人处理。')}
      ${p.abortedTasks.map((id) => { const at = p.tasks.find((t) => t.id === id); return `<div class="row" style="margin-top:8px"><span>#${esc(at.project_order)} <a href="#${esc(at.id)}">${esc(at.title)}</a> <span class="small mute">${at.began ? T('开工后被中止') : T('尚未开工就被中止（可直接恢复）')}</span></span><span class="grow"></span>${lead ? `
        <button data-stall-reopen="${esc(at.id)}" title="${T('回到中止前的状态，接着已有的进度继续。如需修改方案，恢复后在任务页发送消息提出变更。若它开工之后项目里已有别的任务合并或正在进行，则无法恢复，只能重做')}">${T('恢复')}</button>
        <button data-stall-redo="${esc(at.id)}" title="${T('放弃已有进度：按同一份方案新建任务，轮到它时从项目分支当时的状态重新开始；编号与依赖关系不变，原任务保留记录但不再参与执行')}">${T('重做')}</button>` : ''}</div>`; }).join('')}
      ${lead && p.status === 'stalled' ? `<div class="small mute" style="margin-top:6px">${T('或中止整个项目：')}<a href="#p/${esc(p.id)}/settings">${T('项目设置 → 危险区')}</a></div>` : ''}</div>` : ''}
    ${p.status === 'stalled' && !(p.abortedTasks ?? []).length ? `<div class="item flag" style="margin-top:10px">${T('<b>项目已停滞</b>：全部任务都已合并，复盘时选了「先放着」，项目还没宣布达成。')}${lead ? `
      <div class="row" style="margin-top:8px"><button id="btnProjReview" title="${T('AI 对照目标与完成定义重新判断一次：已经达成就请你确认达成，还差东西就提出新任务 —— 结果照常进你的收件箱')}">${T('重新复盘')}</button>
      <span class="small mute">${T('也可以在下面「添加任务…」写还要做什么，或在 {link}里中止项目', { link: `<a href="#p/${esc(p.id)}/settings">${T('项目设置 → 危险区（中止等不可撤销的操作）')}</a>` })}</span></div>` : T('等待项目负责人处理。')}</div>` : ''}
    ${lead && p.evidence && (!p.delivered || p.deliverDue) ? deliverEvidenceHtml(p) : ''}
    <div class="kv" style="margin-top:10px"><span class="mute">${T('项目负责人')}</span><span>${esc(ownerName)}</span><span class="mute">${T('仓库')}</span><span class="mono">${esc(p.repo)}</span><span class="mute">${T('分支')}</span><span class="mono">${esc(p.branch)} <span class="mute">← ${esc(p.base_ref)}</span></span>${p.source ? `<span class="mute">${T('来源')}</span><span class="mono">${esc(p.source)}</span>` : ''}<span class="mute">${T('累计花费')}</span><span>${usd(p.spendMicro ?? 0)} <span class="mute small">${T('本项目所有花费的总和')}${p.planningMicro ? T('，其中 {usd} 花在起草方案上（项目规划、添加任务、复盘）', { usd: usd(p.planningMicro) }) : ''}</span>${p.budget?.gate === null ? `${lead ? ` · <a href="#p/${esc(p.id)}/settings" title="${T('设一个整个项目的花费上限；撞到后不再开新任务')}">${T('设预算上限')}</a>` : ''}` : ` · ${T('上限 {usd}', { usd: usd(p.budget.gate) })}${p.budget.over ? ` <span class="bad">${T('已撞闸，不再开新任务')}</span>` : ` <span class="mute small">${T('还剩 {usd}', { usd: usd(p.budget.remaining) })}</span>`}${lead ? ` · <a href="#p/${esc(p.id)}/settings">${T('修改')}</a>` : ''}`}</span>
      <span class="mute">${T('自动化')}</span><span>${esc((p.gears ?? {})[p.gear]?.label ? T(p.gears[p.gear].label) : p.gear ?? T('提议'))}<span class="mute small">${T(' —— ')}${p.gear === 'auto' ? T('复盘给出的下一批任务会直接开工，事后通知你；交付仍要你点') : T('所有新任务都要你先批一次')}</span>${lead ? ` · <a href="#p/${esc(p.id)}/settings">${T('修改')}</a>` : ''}</span></div>`;
  const carrier = p.carrier && byId[p.carrier] && !p.tasks.some((t) => t.id === p.carrier) ? byId[p.carrier] : null;
  const so = { accepted: T('已接受'), rejected: T('已打回'), pending: T('待签收'), void: T('需重新签收') };
  $('#projTasks').innerHTML = `${projViewBar(p)}${projView === 'graph' && p.tasks.length > 1 ? projGraphHtml(p, so) : `<table class="rt"><tr><th style="width:36px">#</th><th>${T('任务')}</th><th title="${T('本任务要等这些编号的任务签收并合并后才开工')}">${T('依赖')}</th><th>${T('状态')}</th><th>${T('签收')}</th><th>${T('合并')}</th></tr>
    ${carrier ? `<tr><td class="mute">—</td><td><a href="#${esc(carrier.id)}">${T('项目方案')}</a></td><td></td><td><span class="pill ${esc(carrier.status)}">${esc(ST_NAME[carrier.status] ?? carrier.status)}</span></td><td></td><td></td></tr>` : ''}
    ${p.tasks.map((t) => `<tr${t.id === p.current ? '' : ended(t.status) ? ' class="off"' : ''}><td class="num">${esc(t.project_order)}</td><td><a href="#${esc(t.id)}"${(p.openIds ?? [p.current]).includes(t.id) ? ' style="font-weight:600"' : ''}>${esc(t.title)}</a>${t.requestedBy ? ` <span class="small mute" title="${T('谁用「添加任务」提的这个任务。决策路由里的「需求提出人」就是这个人；任务合并后，收件箱会告诉这个人。没有这个标注的任务（项目开头规划的、复盘给出的）没有需求提出人：路由里的这一项对它自动空缺，只剩同一行的其他人')}">${T('· {name}提的', { name: esc(t.requestedBy) })}</span>` : ''}${(p.openIds ?? [p.current]).includes(t.id) ? ` <span class="pill running" title="${T('这个任务已经开工（有工作区、还没合并）。同时最多开 {n} 个：只有开着的任务全都在等人时，系统才会让路再开一个。是否正在运行，见本行「状态」列', { n: esc(p.maxOpen ?? 1) })}">${T('执行中')}</span>` : ''}</td>
      <td class="small mute">${(t.dependsOn ?? []).length ? t.dependsOn.map((n) => `#${esc(n)}`).join(' ') : '—'}</td>
      <td>${!t.started && !ended(t.status) && ((t.waitsFor ?? []).length || (p.current && p.current !== t.id)) ? `<span class="pill" title="${(t.waitsFor ?? []).length ? T('依赖的任务还没有全部合并') : T('依赖已满足；等当前执行的任务合并后开工（同一时间只执行一个）')}">${(t.waitsFor ?? []).length ? T('等待 {deps}', { deps: t.waitsFor.map((n) => `#${esc(n)}`).join(' ') }) : T('排队中')}</span>` : `<span class="pill ${esc(t.status)}">${esc(ST_NAME[t.status] ?? t.status)}</span>`}</td><td class="small">${t.status === 'done' ? (so[t.signoff] ?? T('待签收')) : ''}</td><td class="small mute">${t.merged_at ? T('{t}前', { t: ago(t.merged_at) }) : ''}</td></tr>`).join('') || (carrier ? '' : `<tr><td colspan="6" class="mute">${T('暂无任务')}</td></tr>`)}</table>`}
    <div class="small mute" style="margin-top:6px">${T('任务按依赖关系执行：一个任务要等它「依赖」的任务都签收并合并后才开工；多个都可以开工时先做编号小的。')}<br>${p.parallel ? T('同时最多开着 {n} 个：并行开发已开启 —— 依赖满足的任务同时开工，模块任务各自只改自己的目录。', { n: esc(p.maxOpen ?? 2) }) : T('同时最多开着 {n} 个{how}。', { n: esc(p.maxOpen ?? 1), how: (p.maxOpen ?? 1) > 1 ? T('：平时一次只做一个，只有开着的任务<b>全都在等人</b>（等你答题、等你签收）时，系统才会让独立的下一个先跑起来 —— 那段时间本来是白等的') : T('（串行，一次只做一个）') })}${lead ? `${T('改：')}<a href="#p/${esc(p.id)}/settings">${T('项目设置 → 预算与上限')}</a>` : ''}</div>
    ${p.append ? (p.append.kind === 'review'
      ? `<div class="item flag" style="margin-top:10px">${T('<b>正在复盘</b>：本项目的任务都已完成并合并，系统正在对照项目目标与完成定义判断还差什么。')}${p.append.stage === 'proposed' ? T('结论 v{v} 待你确认 —— {link}（要么确认项目达成，要么说还差什么）', { v: esc(p.append.version), link: `<a href="#${esc(p.carrier)}">${T('前往查看')}</a>` }) : (daemonOn ? T('通常几分钟内给出结论。') : T('自动运行未开启：请运行 {cmd}', { cmd: `node src/cli.mjs project plan ${esc(p.id)}` }))}</div>`
      : `<div class="item flag" style="margin-top:10px">${T('<b>正在添加任务</b>：')}${p.append.stage === 'proposed' ? T('新任务的方案 v{v} 待批准 —— {link}', { v: esc(p.append.version), link: `<a href="#${esc(p.carrier)}">${T('前往批准 / 提修改 / 放弃')}</a>` }) : (daemonOn ? T('已提交，正在起草新任务的方案（通常几分钟内）') : T('已提交，等待起草新任务的方案。自动运行未开启：请运行 {cmd}', { cmd: `node src/cli.mjs project plan ${esc(p.id)}` }))}${T('。批准前不会新建任何任务，现有任务照常执行。')}</div>`) : ''}
    ${(p.appendQueue ?? []).length ? `<div class="item" style="margin-top:8px">${T('<b>排队中的「添加任务」</b>（{n}）', { n: p.appendQueue.length })}<span class="small mute">${T(' —— 上面这一轮结束后，按先后各自起草方案、各自批准，建出来的任务记在提出人名下')}</span>${p.appendQueue.map((q) => `<div class="small" style="margin-top:4px"><b>${esc(q.by)}</b>${T('：')}${esc(q.brief)}</div>`).join('')}</div>` : ''}
    ${p.canAdd && ['active', 'stalled', 'done'].includes(p.status) && !p.archived_at ? `<details id="projAppend" style="margin-top:10px"><summary title="${T('给本项目添加新的任务。你只需描述要做什么；系统据此起草方案（含它与现有任务的依赖关系），由项目负责人批准后才新建。现有任务的方案不变；新任务开工时，系统会把当时已合并的全部任务的验收命令累加进它的验收')}">${T('添加任务…')}${p.append ? `<span class="small mute">${p.append.kind === 'review' ? T('（现在有一轮复盘在进行，提交后排队）') : T('（现在有一轮添加在进行，提交后排队）')}</span>` : ''}</summary>
      <div class="small mute" style="margin-top:6px">${T('写明还要做什么，以及接口 / 命令 / 文件与验收要求。')}${lead ? '' : T('方案由项目负责人批准。')}${T('系统会判断新任务依赖哪些现有任务：不依赖其他任务的，不必等它们做完；需要先于某个未开工的任务完成的，请写明 —— 系统会让那个任务多等这一个，只改先后，不改它的方案内容。要修改现有任务的方案，请在该任务页发送消息提出变更。')}</div>
      <div class="row" style="margin-top:6px"><textarea id="projAppendText" rows="4" aria-label="${T('还要做什么？')}" placeholder="${T('还要做什么？')}" style="flex:1"></textarea></div>
      <div class="row" style="margin-top:6px"><span class="grow"></span><button id="btnProjAppend" class="primary">${T('提交')}</button></div></details>` : ''}
    ${(p.superseded ?? []).length ? `<div class="small mute" style="margin-top:8px">${T('已被重做取代的任务（保留记录，不参与执行）：')}${p.superseded.map((t) => `<a href="#${esc(t.id)}">${esc(t.title)}</a>`).join(T('、'))}</div>` : ''}`;
  // 交付前的按任务改动：点开才读，开着的刷新后保持开着（与收件箱签收同一套）
  $('#projHead').querySelectorAll('details[data-dvopen]').forEach((dt) => {
    if (dt.open) dvHydrate(dt);
    dt.ontoggle = () => { if (dt.open) { DV_DETAILS_OPEN.add(dt.dataset.dvopen); dvHydrate(dt); } else DV_DETAILS_OPEN.delete(dt.dataset.dvopen); };
  });
  $('#projTasks').querySelectorAll('[data-pv]').forEach((b) => b.onclick = () => { projView = b.dataset.pv; try { localStorage.setItem('si.projView', projView); } catch { /* 记不住就算了 */ } renderProject(); });
  if (projView === 'graph' && p.tasks.length > 1) vdagMount($('#projTasks'), (id, el) => { location.hash = el.dataset.href.slice(1); });
  $('#projBrief2').textContent = p.brief || T('（无）');
  const hasGoal = !!(p.goal || p.done_definition);
  $('#projGoal').innerHTML = hasGoal || lead ? `<div class="kv"><span class="mute">${T('项目目标')}</span><span style="white-space:pre-wrap">${esc(p.goal || T('（未填写）'))}</span>
    <span class="mute">${T('完成定义')}</span><span style="white-space:pre-wrap">${esc(p.done_definition || T('（未填写）'))}</span></div>${lead && p.status !== 'aborted' ? `<div class="small" style="margin-top:6px"><a href="#p/${esc(p.id)}/settings" title="${T('只修改项目级的目标与完成定义文字，留修改记录。各任务的方案不会随之改动：已批准的照旧执行，尚未批准的（起草中或待批准）也不会自动重写 —— 需要体现新目标时，请在该任务的方案反馈或消息里说明')}">✎ ${T('在项目设置中修改目标与完成定义')}</a></div>` : ''}` : '';
  const pact = (action, body, msg) => projAct(p.id, action, body, msg);
  $('#btnProjSet').onclick = () => { location.hash = 'p/' + p.id + '/settings'; };
  // 已定的约定：**只读**。它是"约定"不是"配置" —— 人批准过、有取代关系、改要走流程，
  // 所以不在设置页、也没有编辑按钮：要改一条，去任务页提变更，系统会生成一条让人拍板的冲突事项。
  // 按需拉：清单可能很长，展开了才请求一次。
  loadDecisions(p.id);
  // 提交前先清空输入框（失败再放回去）：刷新会把重画前输入框里的字放回原处，不清的话交出去的那段还留在框里，像是没交上
  if ($('#btnProjAppend')) $('#btnProjAppend').onclick = () => { const box = $('#projAppendText'); const brief = box.value.trim(); if (!brief) return toast(T('内容不能为空'), true); box.value = ''; pact('append', { brief }, p.append ? `${p.append.kind === 'review' ? T('已排队：这一轮复盘结束后单独起草') : T('已排队：这一轮添加结束后单独起草')}${p.append.stage === 'proposed' ? T('；也已挂在正等批准的那条事项下，批的人看得到') : ''}` : daemonOn ? T('已提交，正在起草新任务的方案') : T('已提交')).then((ok) => { if (!ok && $('#projAppendText')) { $('#projAppendText').value = brief; $('#projAppend').open = true; } }); };
  document.querySelectorAll('[data-stall-reopen]').forEach((b) => b.onclick = async () => { try { await api(`/api/tasks/${b.dataset.stallReopen}/reopen`, {}); toast(daemonOn ? Tc('task', '已恢复') : T('已恢复；请到任务页点击「运行」')); await loadTasks(); refresh(); } catch (e) { toast(e.message, true); } });
  if ($('#btnProjReview')) $('#btnProjReview').onclick = () => pact('review', {}, T('已开始重新复盘（通常几分钟），结果会进你的收件箱，不用守在这里'));
  document.querySelectorAll('[data-stall-redo]').forEach((b) => b.onclick = () => { const note = prompt(T('重做该任务：已有进度将被放弃（记录保留）。\n可填写一段说明，作为补充信息交给新任务参考，例如上次的问题；方案本身不变（可选）：')); if (note !== null) pact('redo', { taskId: b.dataset.stallRedo, note }, T('已新建任务重做')); });
  const adv = $('#btnProjAdvance'); if (adv) adv.onclick = async () => { try { const r = await api(`/api/projects/${p.id}/advance`, {}); toast(r.result.advanced ? T('推进：{reason}', { reason: r.result.reason }) : T('未推进：{reason}', { reason: r.result.reason })); await loadTasks(); refresh(); } catch (e) { toast(e.message, true); } };
  const del = $('#btnProjDeliver'); if (del) del.onclick = async () => {
    // 后置签收：这里原来是一个 confirm —— 点"确定"就**一次签掉
    // 全部后置签收并继续交付**。而命令行那边 `deliverProject` 是**直接拒绝**的，错误信息写着
    // "交付前要一次签掉：命令行加 --accept-pending，或先 project signoff --accept-all"。
    // 同一件事，看板顺手替人做了，命令行不肯。
    //
    // 实际运行上负责人当场点破：「这三个凑一块儿正好就是我刚才说的那块没让我看见的东西。它现在想让我
    // 一次性签了，还顺带绑在交付确认里，一个'确定'全兜过去……我不是信不过自动挡干活，是信不过
    // 在我最困最想赶紧点掉的时候被打包塞给我。」
    //
    // 签收 N 个任务的产物、与把分支 push 出去，是**两次不同的决定**，代码注释一直是这么写的
    // （"一次点掉 N 个任务是一次真实的决定，要人在知道 N 是几、都是哪些的前提下做"）。
    // 所以这里改成和命令行同一个口径：不代签，拦住，指过去。
    const pend = p.deferredSignoffs ?? [];
    if (pend.length) {
      alert(`${T('还有 {n} 个任务的签收没做（自动挡下由系统自己加的任务）：', { n: pend.length })}\n${pend.map((t) => `  #${t.order} ${t.title}`).join('\n')}\n\n`
        + `${T('这是两件事：签收＝你认它们的产物，交付＝把分支推出去。先去「项目设置 → 自动化」把产物过一眼再签，签完回来点交付。')}\n\n`
        + T('（想一次签掉：项目设置 → 自动化 → 一次签收这些任务）'));
      location.hash = `#p/${p.id}/settings`;
      return;
    }
    // 证据也塞进这一下点击里。页面上那一块可以被滑过去，这个框滑不过去 ——
    // 而"验收压根没跑过"和"验收跑的是另一份代码"这两句，恰恰是一旦推出去就没法挽回的那种。
    const e = p.evidence;
    if (e) {
      const lines = [e.stat ? T('要推：{range}，{n} 个提交，头 {head}', { range: e.stat.range, n: e.stat.commits, head: String(e.stat.head).slice(0, 8) }) : T('⚠ 读不到项目仓库，说不出这次要推什么')];
      if (!e.command) lines.push(T('⚠ 没有填项目级验收命令 —— "达成"完全是人宣布的，一条机械核实都没有'));
      else if (!e.verify) lines.push(T('⚠ 验收命令 {cmd} 一次都没跑过', { cmd: e.command.join(' ') }));
      else {
        lines.push(T('验收 {cmd}：{result}', { cmd: (e.verify.argv ?? e.command).join(' '), result: e.verify.ok ? T('通过') : T('没过（退出码 {code}）', { code: e.verify.code ?? T('没跑起来') }) }));
        lines.push(e.verify.ranAtHead ? T('  跑的就是要推的这一份') : T('⚠ 那次跑的是 {head}，和现在要推的不是同一份代码 —— 这个"通过"对这次没有效力', { head: String(e.verify.head ?? T('未知')).slice(0, 8) }));
      }
      if (!confirm(`${lines.join('\n')}\n\n${T('push 出去就收不回来了。继续交付？')}`)) return;
    }
    // 上次推到哪儿就预先填哪儿；点了确定却没填，要说出来（原来什么也不发生，人以为点坏了）
    const raw = prompt(T('远端仓库 URL（必填）'), p.lastDelivery?.remote ?? '');
    if (raw === null) return;
    const remote = raw.trim(); if (!remote) return toast(T('没填远端仓库地址，没有交付'), true);
    if (!(await deliverPreflight(remote))) return;
    // PR 只有 GitHub 开得了：别的远端（本机文件夹、内网 git 服务）不问，问了也只会得到"开不了"
    const gh = /github\.com[/:]/i.test(remote);
    const base = gh ? (prompt(T('PR 目标分支（留空 = 仓库默认分支）')) ?? '') : '';
    const pr = gh ? confirm(T('同时创建 PR？')) : false;
    try { const r = await api(`/api/projects/${p.id}/deliver`, { remote, pr, base }); toast(r.result.pr ? T('PR：{url}', { url: r.result.pr.url }) : `${T('已推送 {branch}', { branch: r.result.branch })}${r.result.prSkipped ? `${T('；')}${r.result.prSkipped}` : ''}`); } catch (e) { toast(e.message, true); }
  };
}
