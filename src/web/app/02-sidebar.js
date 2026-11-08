// ── 侧栏：收件箱 / 项目 → 任务 / 独立任务 / 已结束 ───────────────────────────
// 人打开看板先问"哪里在等我"，再问"这个项目到哪了" —— 所以收件箱在最上，项目是树里的一层而不是全部：
// 不属于项目的任务与项目并列；已完成 / 已中止的默认折叠（几十个旧任务不该和正在跑的几个混在一起）。
let tasksCache = [], curProject = null, sideOpen = {};
try { sideOpen = JSON.parse(localStorage.getItem('si_side') || '{}') || {}; } catch { /* 隐私窗口等：不记展开状态 */ }
const saveSide = () => { try { localStorage.setItem('si_side', JSON.stringify(sideOpen)); } catch { /* 同上 */ } };
const ST_NAME = { planning: T('规划中'), running: T('进行中'), waiting: T('待答复'), suspended: T('已暂停'), done: T('已完成'), aborted: T('已中止') };
const PST_NAME = { proposed: T('方案待批准'), active: T('进行中'), done: T('已完成'), stalled: T('已停滞'), aborted: T('已中止') };
const ended = (st) => ['done', 'aborted'].includes(st);
const projectOf = (taskId) => projects.find((p) => p.carrier === taskId || p.tasks.some((t) => t.id === taskId)) ?? null;
/** 每个任务上等"我"处理的事项数（来自收件箱同一份数据）。 */
function mineCounts() {
  const m = {}, d = digestData; if (!d) return m;
  for (const x of [...d.waitingOnMe, ...d.unaddressed, ...d.inConflict.filter((c) => c.canRule)]) m[x.taskId] = (m[x.taskId] ?? 0) + 1;
  return m;
}
function renderSide() {
  const mine = mineCounts(), byId = Object.fromEntries(tasksCache.map((t) => [t.id, t]));
  const taskRow = (t, child, label = '') => `<a class="srow${child ? ' child' : ''}${view === 'task' && cur === t.id ? ' on' : ''}" href="#${esc(t.id)}" title="${esc(t.title)} · ${esc(ST_NAME[t.status] ?? t.status)}"><span class="sdot ${esc(t.status)}"></span><span class="t">${label}${esc(t.title)}</span>${mine[t.id] ? `<span class="badge" title="${T('待你处理')}">${esc(mine[t.id])}</span>` : t.openQuestions ? `<span class="n" title="${T('待决事项（无需你处理）')}">${esc(t.openQuestions)}</span>` : ''}</a>`;
  const projRow = (p) => {
    const kids = [...new Set([p.carrier, ...p.tasks.map((t) => t.id)])].filter((id) => id && byId[id]);
    const open = sideOpen[p.id] ?? !ended(p.status);
    const sum = kids.reduce((n, id) => n + (mine[id] ?? 0), 0);
    return `<div class="srow-p"><button type="button" class="caret" data-caret="${esc(p.id)}" aria-expanded="${open ? 'true' : 'false'}" aria-label="${open ? T('收起 {name} 的任务', { name: esc(p.title) }) : T('展开 {name} 的任务', { name: esc(p.title) })}">${open ? '▾' : '▸'}</button><a class="srow${view === 'project' && curProject === p.id ? ' on' : ''}" href="#p/${esc(p.id)}" aria-label="${esc(T('{name}（{status}，已合并 {m} / 共 {n} 个任务{mine}）', { name: p.title, status: PST_NAME[p.status] ?? p.status, m: p.merged, n: p.tasks.length, mine: sum ? T('，待你处理 {n} 件', { n: sum }) : '' }))}" title="${esc(p.title)} · ${esc(PST_NAME[p.status] ?? p.status)}"><span class="sdot ${esc(p.status)}"></span><span class="t">${esc(p.title)}</span><span class="n" title="${T('已合并 / 任务数')}">${esc(p.merged)}/${p.tasks.length}</span>${sum ? `<span class="badge" title="${T('待你处理')}">${esc(sum)}</span>` : ''}</a></div>`
      + (open ? kids.map((id) => taskRow(byId[id], true, id === p.carrier && !p.tasks.some((t) => t.id === id) ? T('方案 · ') : `${byId[id].project_order ?? ''}. `)).join('') : '');
  };
  // 只看与我有关：我负责的，或有待决事项指到我 / 知会我的。成员默认开，管理员默认关（看全部）；选择记在本机浏览器里。
  const onlyMine = sideOpen._mine ?? (me?.role !== 'lead');
  const keep = (x) => !onlyMine || x.mine;
  const solo = tasksCache.filter((t) => !t.project_id).filter(keep);          // 被重做取代的旧任务（有 project_id、不在链上）不算独立任务，入口在项目页
  const shownP = projects.filter(keep);
  const hiddenN = onlyMine ? (tasksCache.filter((t) => !t.project_id).length - solo.length) + (projects.length - shownP.length) : 0;
  const liveP = shownP.filter((p) => !ended(p.status)), deadP = shownP.filter((p) => ended(p.status) && !p.archived_at), archP = shownP.filter((p) => p.archived_at);
  const liveT = solo.filter((t) => !ended(t.status)), deadT = solo.filter((t) => ended(t.status) && !t.archived_at), archT = solo.filter((t) => t.archived_at);
  const nEnded = deadP.length + deadT.length, openEnded = !!sideOpen._ended, nArch = archP.length + archT.length, openArch = !!sideOpen._arch;
  const act = digestData?.actionable ?? 0;
  if (digestData && act > (renderSide.lastAct ?? act)) announce(T('待你处理的事项：{n} 件', { n: act }));
  if (digestData) renderSide.lastAct = act;
  $('#sideNav').innerHTML = `<a class="srow${view === 'inbox' ? ' on' : ''}" href="#inbox" aria-label="${esc(act ? T('收件箱（待你处理 {n} 件）', { n: act }) : T('收件箱'))}"><span class="t">${T('收件箱')}</span>${act ? `<span class="badge">${esc(act)}</span>` : ''}</a>`
    + `<a class="srow${view === 'report' ? ' on' : ''}" href="#report"><span class="t">${T('状态报告')}</span></a>`
    + (liveP.length ? `<div class="sgrp">${T('项目')}</div>${liveP.map(projRow).join('')}` : '')
    + (liveT.length ? `<div class="sgrp" title="${T('早先创建的、不属于任何项目的任务。现在新建的工作都是项目，这里只会减少不会增加')}">${T('独立任务（旧）')}</div>${liveT.map((t) => taskRow(t, false)).join('')}` : '')
    + (!liveP.length && !liveT.length ? `<div class="small mute" style="padding:10px 8px">${onlyMine ? T('没有与你有关的进行中任务') : T('暂无进行中的任务')}</div>` : '')
    + (nEnded ? `<button type="button" class="srow" data-ended aria-expanded="${openEnded ? 'true' : 'false'}" style="margin-top:12px" title="${T('已完成或已中止的项目与任务')}"><span class="caret" aria-hidden="true">${openEnded ? '▾' : '▸'}</span><span class="t">${T('已结束')}</span><span class="n">${nEnded}</span></button>${openEnded ? deadP.map(projRow).join('') + deadT.map((t) => taskRow(t, false)).join('') : ''}` : '')
    + (nArch ? `<button type="button" class="srow" data-arch aria-expanded="${openArch ? 'true' : 'false'}" title="${T('已结束、且被负责人手动归档的项目与任务。只是从列表收起，状态与记录不变，可随时取消归档')}"><span class="caret" aria-hidden="true">${openArch ? '▾' : '▸'}</span><span class="t">${T('已归档')}</span><span class="n">${nArch}</span></button>${openArch ? archP.map(projRow).join('') + archT.map((t) => taskRow(t, false)).join('') : ''}` : '')
    + `<label class="small mute" style="display:flex;gap:6px;align-items:center;padding:12px 8px 0" title="${T('只显示你负责的、你是项目成员的、或有待决事项需要你答复 / 知会你的项目与任务。仅影响本机浏览器的显示')}"><input type="checkbox" id="sideMine" style="width:auto"${onlyMine ? ' checked' : ''}> ${T('只看与我有关')}${hiddenN ? T('（已隐藏 {n} 项）', { n: hiddenN }) : ''}</label>`;
  document.querySelectorAll('#sideNav button[data-caret]').forEach((el) => el.onclick = () => {
    const id = el.dataset.caret;
    sideOpen[id] = !(sideOpen[id] ?? !ended(projects.find((p) => p.id === id)?.status)); saveSide(); renderSide();
    document.querySelector(`#sideNav button[data-caret="${CSS.escape(id)}"]`)?.focus();   // 重画后焦点留在原处
  });
  const e = document.querySelector('#sideNav [data-ended]'); if (e) e.onclick = () => { sideOpen._ended = !sideOpen._ended; saveSide(); renderSide(); };
  const ar = document.querySelector('#sideNav [data-arch]'); if (ar) ar.onclick = () => { sideOpen._arch = !sideOpen._arch; saveSide(); renderSide(); };
  $('#sideMine').onchange = () => { sideOpen._mine = $('#sideMine').checked; saveSide(); renderSide(); };
}

// 交付按钮旁边的一手证据。负责人不会只看状态栏就点交付：「我要先自己跑一遍看实际输出，
// 不是看状态栏文字就点」，还会说「只贴了代码，没贴跑起来
// 到底几条过几条挂」。所以：把「这次要推什么」和「验收命令最近一次真跑出来什么」摆在按钮上面。
// 两样都不调模型；读不到就如实说读不到，绝不渲染成一个空的"看起来没问题"。
/**
 * 逐任务的验收结果。**精确、零启发式**：每个已合并任务自己那条命令的退出码，
 * 按任务列出来 —— 正好答负责人问的那句「39 条里另外 34 条测的是啥，它没给我看」。
 *
 * ⚠️ 它是**证据，不是闸门**：上面那个"通过 / 没过"仍然只由项目级验收命令决定。
 * 所以这里某一条挂了必须说响 —— 那意味着项目级那条**没覆盖到它**。
 */
function perTaskHtml(list, pid) {
  if (!Array.isArray(list) || !list.length) return '';
  const bad = list.filter((x) => x.ok === false);
  const skipped = list.filter((x) => x.ok === null);
  const rows = list.map((x) => {
    const name = T('#{n}「{title}」', { n: esc(x.order ?? '?'), title: esc(x.title ?? x.taskId) });
    if (x.ok === true) return `<div class="small">${T('{name}：<b>过</b>', { name })} <span class="mute mono">${esc((x.argv ?? []).join(' '))}</span></div>`;
    if (x.ok === false) return `<div class="small bad">${T('{name}：<b>没过</b>（退出码 {code}{timeout}）', { name, code: x.code === null ? T('没跑起来') : esc(x.code), timeout: x.timedOut ? T('，超时') : '' })} <span class="mute mono">${esc((x.argv ?? []).join(' '))}</span></div>`
      + (x.tail ? `<pre class="small" style="white-space:pre-wrap;margin:2px 0 6px">${esc(x.tail)}</pre>` : '');
    const why = { no_command: T('这个任务没有验收命令，无从重跑'), budget: T('这一轮时间用完了，没轮到它'), error: T('跑不起来：{err}', { err: esc(x.error ?? '') }) }[x.why] ?? T('没跑');
    return `<div class="small mute">${T('{name}：没跑 —— {why}', { name, why })}</div>`;
  }).join('');
  const head = bad.length
    ? `<div class="small bad" style="margin-top:8px">${T('⚠ 有 <b>{n}</b> 个任务，<b>自己那条</b>验收命令在这份代码上没过。上面那句"通过"只代表<b>项目级那一条</b>命令 —— 它<b>没有覆盖</b>下面标着「没过」的那几条。', { n: bad.length })}</div>`
      + `<div class="small">${T('要修：到本项目的{link}「添加任务…」加一个任务去修这一处 —— 它从项目分支当前头起，改完照样经你签收、合并，然后回到这一页。<br>也可以<b>知道有这一条仍然推</b>：那是你的判断，但推出去的就是现在这一份。', { link: `<a href="#p/${esc(pid)}">${T('项目页')}</a>` })}</div>`
    : `<div class="small" style="margin-top:8px">${T('另外，每个已合并任务<b>自己那条</b>验收命令也在同一份代码、同一个容器里各跑了一遍{skipped}：', { skipped: skipped.length ? T('（{n} 个没跑，理由逐条写在下面）', { n: skipped.length }) : '' })}</div>`;
  return head + `<div style="margin-top:4px">${rows}</div>`;
}

// 原来页面说得出"要推 N 个提交、改了这些文件"，说不出**哪个是哪个任务的**。
// 签收是按任务签的，交付却只给一个总账 —— 人要对得上"这一块是谁签过的"。
function byTaskHtml(bt, pid) {
  if (!bt || (!bt.tasks.length && !bt.broken && !bt.tail)) return '';
  const rows = bt.tasks.map((t) => {
    const files = !t.files.length ? T('没有文件变化') : t.files.length > 4 ? T('共 {n} 个文件，前 4 个：{list}', { n: t.files.length, list: t.files.slice(0, 4).map(esc).join(T('、')) }) : t.files.map(esc).join(T('、'));
    return `<div class="small">${T('#{n}「{title}」', { n: esc(t.order ?? '?'), title: esc(t.title) })}${t.signer ? T('（{name}签收）', { name: esc(t.signer) }) : T('（没有签收记录）')}${T('：{n} 个提交 · {files}', { n: esc(t.commits ?? '?'), files })}`
      + (t.files.length ? (() => { const k = `deliv:${pid}:${t.taskId}:${t.head}`;
        return `<details data-dvopen="${esc(k)}"${DV_DETAILS_OPEN.has(k) ? ' open' : ''}><summary class="small mute">${T('看这个任务带进来的改动（逐行取自代码）')}</summary>${dvSlot(k, `/api/projects/${encodeURIComponent(pid)}/diff/${encodeURIComponent(t.taskId)}`, `/api/projects/${encodeURIComponent(pid)}/diff/${encodeURIComponent(t.taskId)}/lines`, { allClosed: true, baseLabel: T('合并它之前的项目分支'), headLabel: T('合并它之后的项目分支') })}</details>`; })() : '') + '</div>';
  }).join('');
  const broken = bt.broken ? `<div class="small bad">${T('往后的部分分不出是哪个任务的：{why}。上面的总数照样准确，只是这里对不上号。', { why: esc(bt.broken) })}</div>` : '';
  const tail = bt.tail ? `<div class="small bad">${T('⚠ 另有 <b>{n}</b> 个提交不属于任何已合并的任务 —— 最后一次合并之后，有人直接往项目分支上提交过。点交付之前先弄清楚那是什么：', { n: esc(bt.tail.commits) })}<span class="mono">git log ${esc(String(bt.tail.from).slice(0, 8))}..${esc(String(bt.tail.head).slice(0, 8))}</span>${(bt.tail.log || []).length ? `<pre class="small" style="white-space:pre-wrap;margin:4px 0 0">${esc(bt.tail.log.join('\n'))}${bt.tail.commits > bt.tail.log.length ? `\n${T('…（共 {n} 个）', { n: esc(bt.tail.commits) })}` : ''}</pre>` : ''}</div>` : '';
  return `<div class="small" style="margin-top:6px">${T('按任务分（每个任务合并进来时带进来的部分）：')}</div><div style="margin-top:2px">${rows}</div>${broken}${tail}`;
}

function deliverEvidenceHtml(p) {
  const e = p.evidence, v = e.verify;
  const range = e.stat
    ? `<div class="small">${T('要推出去的是 {range}：<b>{n}</b> 个提交，头 {head}', { range: `<span class="mono">${esc(e.stat.range)}</span>`, n: esc(e.stat.commits), head: `<span class="mono">${esc(String(e.stat.head).slice(0, 8))}</span>` })}</div>
       <details style="margin-top:4px"><summary class="small">${T('改了哪些文件')}</summary><pre class="small" style="white-space:pre-wrap;margin:6px 0 0">${esc(e.stat.diffstat || T('（没有差异）'))}</pre></details>${byTaskHtml(e.byTask, p.id)}`
    : e.pending ? `<div class="small mute">${T('正在读这次要推出去的改动（项目刚收工或刚重启时第一次要算一会儿，几秒后自动刷新出来）')}</div>`
    : `<div class="small bad">${T('读不到项目仓库（路径不在、不是 git 仓库、或者权限不够）—— 说不出这次要推的是什么。先别点，去机器上看一眼 {repo}', { repo: `<span class="mono">${esc(p.repo)}</span>` })}</div>`;
  // ⚠「通过」两个字的可信度不能建立在**沉默**上。既然不一致时会报警，
  // 一致时就该把这个判断正面打出来 —— 否则人是在用"没看见警告"推断"大概是一份"。
  const blocked = `<div class="small mute">${T('交付按钮还是能点：点下去会把这几句再问你一次，但它<b>拦不住你</b> —— 这一步的判断是你的。')}</div>`;
  let verify;
  if (!e.command) {
    verify = `<div class="small bad">${T('这个项目<b>没有填项目级验收命令</b>——"达成"完全是人宣布的，一条机械核实都没有。')}</div>`
      + `<div class="small mute">${T('（各任务自己那条验收在合并前都跑过了；这里说的是全部合并之后、在项目分支上再跑一遍的那一条。）')}</div>`
      + `<div class="small">${T('{link}，或者你自己先在 {repo} 上跑一遍再点。', { link: `<a href="#p/${esc(p.id)}/settings">${T('去填一条')}</a>`, repo: `<span class="mono">${esc(p.repo)}</span>` })}</div>${blocked}`;
  } else if (!v) {
    verify = `<div class="small bad">${T('验收命令 {cmd} <b>一次都没跑过</b>。', { cmd: `<span class="mono">${esc(e.command.join(' '))}</span>` })}</div>${blocked}`;
  } else {
    const when = fmtWhen(v.at);
    verify = `<div class="small">${T('验收命令 {cmd}：', { cmd: `<span class="mono">${esc(v.argv ? v.argv.join(' ') : e.command.join(' '))}</span>` })}`
      + `${v.ok ? `<b>${T('通过')}</b>` : `<b class="bad">${T('没过')}</b>${T('（退出码 {code}{timeout}）', { code: v.code === null ? T('没跑起来') : esc(v.code), timeout: v.timedOut ? T('，超时') : '' })}`}`
      + ` <span class="mute">${esc(when)}</span></div>`
      + (v.ranAtHead
        ? `<div class="small mute">${T('跑的就是你现在要推的这一份（{head}），不是更早的某一版。', { head: `<span class="mono">${esc(String(v.head ?? '').slice(0, 8))}</span>` })}</div>`
        : `<div class="small bad">${T('⚠ 那一次跑的是 {ran}，和你现在要推的 {now} <b>不是同一份代码</b> —— 这个"通过"对这次要推的东西没有效力。', {
          ran: `<span class="mono">${esc(String(v.head ?? T('未知')).slice(0, 8))}</span>`,
          now: `<span class="mono">${esc(String(e.stat?.head ?? T('未知')).slice(0, 8))}</span>` })}</div>${blocked}`)
      + (v.tail ? `<details style="margin-top:4px"><summary class="small">${T('那次跑出来的输出（尾部；它证明命令跑过并且过了，<b>不</b>证明测的是要紧的东西 —— 那要看用例本身）')}</summary><pre class="small" style="white-space:pre-wrap;margin:6px 0 0">${esc(v.tail)}</pre></details>` : '')
      + perTaskHtml(v.perTask, p.id);
  }
  return `<div class="item" style="margin-top:10px"><div class="small">${T('<b>交付前先看这几样</b> —— push 出去就收不回来了，这一步是这套系统里唯一必须你亲自点的')}</div>
    <div style="margin-top:8px">${range}</div><div style="margin-top:8px">${verify}</div></div>`;
}
