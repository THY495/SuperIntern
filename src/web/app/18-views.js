// ── 视图切换：任务 / 设置 ──
let view = 'inbox', pane = 'bind';
function setPane(p) {
  pane = p;
  document.querySelectorAll('#snav button').forEach((b) => b.classList.toggle('on', b.dataset.pane === p));
  document.querySelectorAll('#viewSettings section.pane').forEach((x) => x.classList.toggle('hide', x.dataset.pane !== p));
  if (p === 'routing') { routingCtx = { key: '', box: '#routing', tag: '#routingTag' }; renderRouting(); }
  else if (p === 'users') renderUsers(); else if (p === 'sessions') void renderSessions(); else if (p === 'spend') void renderSpend(); else if (p === 'egress') void renderEgressCat(); else if (p === 'conn') void renderConnections(); else if (p === 'health') void renderHealthCard(); else if (p === 'time') void renderTimeCard(); else if (p === 'notify') void renderSignalPrefs(); else void renderLlm();
}
function applyView() {
  // 新建项目是一个独立的页（用户试用 2026-09-22）：原来是叠在当前页上方的一块，下面还露着刚才打开的项目 / 收件箱，容易看混。
  for (const [v, id] of [['inbox', '#viewInbox'], ['report', '#viewReport'], ['task', '#viewTask'], ['project', '#viewProject'], ['settings', '#viewSettings'], ['projset', '#viewProjSet'], ['new', '#newWrap']]) $(id).classList.toggle('hide', view !== v);
  $('#sideMain').classList.toggle('hide', view === 'settings' || view === 'projset');
  $('#sideSettings').classList.toggle('hide', view !== 'settings');
  $('#sideProjSet').classList.toggle('hide', view !== 'projset');
  document.querySelectorAll('.task-only').forEach((el) => { el.style.display = view === 'task' ? '' : 'none'; });
  document.body.classList.toggle('quick', view === 'task' && !!QUICK);
  $('#quickBar').classList.toggle('hide', !(view === 'task' && QUICK));
  $('#shell').classList.remove('side-open');
}
/** 地址栏的 # 就是位置：#inbox / #settings / #p/<项目> / #p/<项目>/settings / #<任务>；认不出的回收件箱。 */
async function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  // 快速答复：#q/<事项> → 先问它在哪个任务里；看不见的（或已经没了）回收件箱并说一声
  let qWhere = null;
  const qm = h.match(/^q\/(.+)$/);
  QUICK = null;
  if (qm && me) {
    try { qWhere = (await api(`/api/questions/${encodeURIComponent(qm[1])}/where`)).taskId; QUICK = qm[1]; }
    catch { toast(T('打不开这件事：链接里的事项不存在，或者你不在它所在的项目里（已经处理完的事项照样打得开）。要看的话，请项目负责人把你加进项目'), true); }
  }  const ps = h.match(/^p\/(.+)\/settings$/);
  const sp1 = h.match(/^settings\/(\w+)$/);   // #settings/<页签>：从别处直接跳到设置里的某一页（例如收件箱里"快到期的连接"）
  if (sp1 && me && me.role !== 'observer') { view = 'settings'; pane = sp1[1]; }
  else if (h === 'settings' && me && me.role !== 'observer') { view = 'settings'; if (me.role !== 'lead') pane = 'users'; }
  else if (ps && projects.some((p) => p.id === ps[1])) { view = 'projset'; curProject = ps[1]; }
  else if (h.startsWith('p/') && projects.some((p) => p.id === h.slice(2))) { view = 'project'; curProject = h.slice(2); }
  else if (h === 'new' && me?.canCreate) view = 'new';
  else if (h === 'report' || /^report\/\d+-\d+$/.test(h)) {   // 状态报告；#report/<从>-<到>：「你不在时」那一段
    view = 'report';
    const m = h.match(/^report\/(\d+)-(\d+)$/);
    if (m) { REPORT.from = Number(m[1]); REPORT.to = Number(m[2]); } else { REPORT.from = REPORT.to = null; }
  }
  else if (qWhere) { view = 'task'; if (cur !== qWhere) { detail = null; $('#log').hidden = true; $('#traceOut').innerHTML = ''; } cur = qWhere; }
  else if (tasksCache.some((t) => t.id === h)) { view = 'task'; if (cur !== h) { detail = null; $('#log').hidden = true; $('#traceOut').innerHTML = ''; } cur = h; }
  else if (/^[^/]+\/node\/[^/]+$/.test(h) && tasksCache.some((t) => t.id === h.split('/')[0])) {   // 提交 / PR 里的追溯链接直达某一步
    const [tid, , nid] = h.split('/'); view = 'task'; if (cur !== tid) { detail = null; $('#log').hidden = true; $('#traceOut').innerHTML = ''; } cur = tid; pendingNode = nid; PROV_OPEN = true;
  }
  else view = 'inbox';
  applyView();
  if (view === 'settings') setPane(pane);
  if (view === 'new') { loadRepos(); setTimeout(() => $('#newGoal').focus(), 0); }
  if (view === 'report') void renderReport();
  if (me && !route.seenOnce) { route.seenOnce = true; void noteSeenNow(true); }   // 打开看板本身就算「在看」
  await refresh();
  // 路由表是表单，不能跟着 SSE 重画：进项目设置时按当前分区画一次；离开则解绑
  if (view === 'projset') { renderProjSet(); setPsPane(psPane); }
  else if (routingCtx.box === '#projRouting') routingCtx = { key: '', box: '', tag: '' };
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
document.querySelectorAll('[data-go]').forEach((b) => b.onclick = () => { location.hash = b.dataset.go; });
document.querySelectorAll('#snav button').forEach((b) => b.onclick = () => setPane(b.dataset.pane));
document.querySelectorAll('#psnav button').forEach((b) => b.onclick = () => setPsPane(b.dataset.ps));
$('#btnNew').onclick = () => { location.hash = 'new'; };
// 追溯：任务里给一个提交号或 文件:行号，查回哪一步、哪几条条款、谁的指令、谁批准
async function runTrace() {
  const q = $('#traceQ').value.trim(); if (!q || !cur) return;
  const out = $('#traceOut'); out.innerHTML = `<span class="mute">${T('查询中…')}</span>`;
  try {
    const t = await api(`/api/tasks/${cur}/trace?q=${encodeURIComponent(q)}`);
    const head = t.file ? `<div><code>${esc(t.file)}:${esc(t.line)}</code> <span class="mute">${esc((t.text ?? '').trim().slice(0, 160))}</span></div>` : '';
    if (t.uncommitted) { out.innerHTML = head + `<div>${T('这一行还没提交（工作区里的改动），没有出处可查')}</div>`; return; }
    const c = `<div>${T('提交 {sha}（作者 {author}，{date}）：{subject}', { sha: `<code>${esc(t.commit.sha.slice(0, 10))}</code>`, author: esc(t.commit.author), date: esc(fmtWhen(t.commit.date)), subject: esc(t.commit.subject) })}</div>`;
    const body = !t.nodes.length ? `<div class="mute">${esc(t.note ?? '')}</div>`
      : t.nodes.map((p) => p.missing ? `<div class="mute">${T('步骤 {id} 不在这个库里（别的部署做的，或库换过）', { id: esc(p.missing) })}</div>`
        : p.hidden ? `<div class="mute">${T('步骤 {id} 属于你没有权限查看的任务', { id: esc(p.hidden) })}</div>`
        : `<div class="item" style="margin-top:6px"><b>${esc(p.node.title)}</b> ${p.sameTask ? `<a href="#${esc(p.task.id)}/node/${esc(p.node.id)}">${T('在步骤图里看')}</a>` : `<span class="mute">${T('（任务「{t}」）', { t: esc(p.task.title) })}</span>`}${provHtml(p)}</div>`).join('');
    out.innerHTML = head + c + body;
  } catch (e) { out.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
}
$('#traceGo').onclick = runTrace;
$('#traceQ').onkeydown = (e) => { if (e.key === 'Enter') runTrace(); };
$('#btnNewCancel').onclick = () => { if (history.length > 1) history.back(); else location.hash = 'inbox'; };
$('#btnSide').onclick = () => { const sh = $('#shell'); if (matchMedia('(max-width: 900px)').matches) sh.classList.toggle('side-open'); else { sh.classList.toggle('noside'); try { localStorage.setItem('si_noside', sh.classList.contains('noside') ? '1' : ''); } catch { /* 不记 */ } } };
try { if (localStorage.getItem('si_noside')) $('#shell').classList.add('noside'); } catch { /* 不记 */ }
