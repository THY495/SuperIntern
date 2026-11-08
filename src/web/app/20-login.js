// ── 团队模式：登录 / 退出。身份在服务端种的 HttpOnly cookie 里，页面脚本读不到令牌 ──
let teamMode = false;
function showLogin() {
  $('#shell').classList.add('hide');
  for (const id of ['#btnSide', '#ctx', '#daemon', '#live', '#who', '#btnToken', '#spend', '#taskStatus']) $(id)?.classList.add('hide');
  $('#loginView').classList.remove('hide');
  $('#loginToken').focus();
}
$('#btnGhLogin').onclick = () => { try { if (location.hash) sessionStorage.setItem('si.afterLogin', location.hash); } catch { /* 记不住就回首页 */ } location.href = '/api/auth/github'; };
$('#btnLogin').onclick = async () => {
  const token = $('#loginToken').value.trim();
  if (!token) { $('#loginErr').textContent = T('先贴上令牌'); return; }
  $('#loginErr').textContent = '';
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $('#loginErr').textContent = j.error || T('登录失败'); return; }
  location.reload();
};
$('#loginToken').onkeydown = (e) => { if (e.key === 'Enter') $('#btnLogin').click(); };
$('#loginToken').oninput = () => { $('#loginErr').textContent = ''; };
// 接受邀请：/?invite=<码>。先给人看"以什么角色加入"，填名字 → 建账号 + 登录 + 给一次命令行令牌
async function showInvite(code) {
  $('#shell').classList.add('hide');
  for (const id of ['#btnSide', '#ctx', '#daemon', '#live', '#who', '#btnToken', '#spend', '#taskStatus']) $(id)?.classList.add('hide');
  $('#inviteView').classList.remove('hide');
  const body = $('#inviteBody');
  const r = await fetch(`/api/invites/peek?code=${encodeURIComponent(code)}`).then((x) => x.json().then((j) => ({ ok: x.ok, j }))).catch(() => ({ ok: false, j: {} }));
  if (!r.ok) { body.innerHTML = `<div class="bad">${esc(r.j.error || T('邀请链接无效、已用过、已撤销或已过期；请找管理员重新发一个'))}</div>`; return; }
  body.innerHTML = `<div style="margin-bottom:8px">${T('你被邀请以<b>{role}</b>的身份加入这个看板。', { role: esc(roleName(r.j.role)) })}${r.j.role === 'observer' ? T('旁观者能看到项目进展，但不回答问题、不提需求。') : ''}</div>
    <div class="small mute" style="margin-bottom:8px">${T('这个链接只能用一次，{date} 前有效。', { date: fmtWhen(r.j.expiresAt) })}</div>
    <input id="ivAccName" placeholder="${T('你的名字（团队里其他人看到的名字）')}" value="${esc(r.j.name ?? '')}" style="width:100%;box-sizing:border-box">
    <div class="row" style="margin-top:10px"><button id="ivAccept" class="primary">${T('加入')}</button><span id="ivErr" class="small bad"></span></div>`;
  $('#ivAccept').onclick = async () => {
    const name = $('#ivAccName').value.trim();
    if (!name) { $('#ivErr').textContent = T('填一下名字'); return; }
    const x = await fetch('/api/invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) });
    const j = await x.json().catch(() => ({}));
    if (!x.ok) { $('#ivErr').textContent = j.error || T('加入失败'); return; }
    body.innerHTML = `<div style="margin-bottom:8px">${T('已加入，这台浏览器已经登录。')}</div>
      <div class="item flag">${T('下面是你的<b>命令行令牌</b>，只显示这一次：在另一台电脑上登录、或者用命令行时要用它。现在复制保存好（相当于密码，别发给别人）。')}<div class="mono body" style="user-select:all">${esc(j.cliToken)}</div>
      <div class="small mute">${j.cliExpiresAt ? T('{date} 到期', { date: fmtWhen(j.cliExpiresAt, { time: false }) }) : ''}</div></div>
      <div class="row" style="margin-top:10px"><button id="ivEnter" class="primary">${T('我已保存，进入看板')}</button></div>`;
    $('#ivEnter').onclick = () => { location.replace('/'); };
  };
}
(async () => {
  const inviteCode = new URLSearchParams(location.search).get('invite');
  if (inviteCode) return showInvite(inviteCode);
  let s = { team: false, loggedIn: true };
  // 用 GitHub 登录没成时，看板首页带着 ?login_error=<原因> 回来：交给服务端翻成人话，再从地址栏里去掉
  const sp = new URLSearchParams(location.search);
  const back = new URLSearchParams();
  for (const k of ['login_error', 'gh', 'github_linked']) if (sp.get(k)) back.set(k, sp.get(k));
  if ([...back.keys()].length) try { history.replaceState(null, '', location.pathname + location.hash); } catch { /* 无所谓 */ }
  try { s = await fetch('/api/session' + ([...back.keys()].length ? `?${back}` : ''), { headers: tokenHeader() }).then((r) => r.json()); } catch { /* 连不上就按本机模式往下走，后面的请求会报 */ }
  teamMode = !!s.team;
  if (teamMode) {
    try { localStorage.removeItem('si_token'); } catch { /* 无痕窗口 */ }   // 团队模式不在页面脚本里放令牌
    $('#btnToken').textContent = T('退出登录'); $('#btnToken').title = T('退出后要重新登录');
    $('#btnToken').onclick = async () => { await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); location.reload(); };
  }
  if (!s.loggedIn) {
    if (s.admins?.length) $("#loginAdmins").textContent = T('（{names}）', { names: s.admins.join(T('、')) });
    if (s.github?.enabled) { $('#ghLogin').classList.remove('hide'); $('#ghLoginNote').textContent = T('用你自己的 GitHub 账号登录。只放行 GitHub 组织 {org} 的正式成员。', { org: s.github.org }); }
    if (s.github?.error) { $('#ghLogin').classList.remove('hide'); $('#ghLoginErr').textContent = s.github.error; }
    if (s.limits) $('#loginLimits').textContent = T('登录后这台浏览器会保持登录：闲置 {h} 小时、或登录满 {d} 天，要重新登录。在别人的电脑上用完，记得点右上角「退出登录」。', { h: s.limits.idleHours, d: s.limits.maxDays });
    return showLogin();
  }
  try { const back = sessionStorage.getItem('si.afterLogin'); if (back) { sessionStorage.removeItem('si.afterLogin'); if (!location.hash) history.replaceState(null, '', location.pathname + back); } } catch { /* 无痕窗口 */ }
  await loadMe(); await loadTasks(); await route();
  // 「用 GitHub 验证并绑定」回来：成了就说一声，没成说原因
  if (s.github?.linked) toast(T('已绑定 GitHub 账号 @{login}：以后可以用 GitHub 登录', { login: s.github.linked }));
  else if (s.github?.error) toast(s.github.error, true);
  connect(); setInterval(() => { if (detail) renderQuestions(); }, 30000);
})();
