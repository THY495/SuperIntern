// ── 花费：每个人本月 / 上月 / 月度预算 / 近两周每天；管理员看全员、改预算，别人只看自己 ─────────
const usd2 = (m) => `$${(m / 1e6).toFixed(2)}`;
const spark = (xs) => { const max = Math.max(...xs, 1); return xs.map((x) => (x <= 0 ? '·' : '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((x / max) * 7.999))])).join(''); };
async function renderSpend() {
  const box = $('#spend'); if (!box) return;
  let s; try { s = await api('/api/spend'); } catch (e) { box.innerHTML = `<span class="mute">${esc(e.message)}</span>`; return; }
  const ATTR = { requester: T('发起任务的人'), project_owner: T('项目负责人'), approver: T('批准任务契约的人') };
  box.innerHTML = `
    <div class="small mute" style="margin-bottom:8px">${T('本月（{month}，按 {tz} 计）每个人名下的模型花费。记在谁头上：{who}。', { month: esc(s.month), tz: esc(s.tz ?? 'UTC'), who: ATTR[s.attribution] ?? esc(s.attribution) })}
      ${hint(T('一笔花费记在谁头上由部署设置决定（发起任务的人 / 项目负责人 / 批准任务契约的人）；改这项设置只影响之后的花费'))}</div>
    <table class="rt"><tr><th>${T('成员')}</th><th>${T('本月')}</th><th>${T('上月')}</th><th>${T('月度预算（美元 / 月）')} ${hint(T('到了预算，这个人名下在跑的那一步会在下一次调用模型之前停下（所以最多再多花一次调用的钱），并发一条事项给管理员；别人的任务不受影响。调高预算就接着跑，不调就等下个月 1 日（{tz}）。留空 = 用部署默认（{d}）', { tz: esc(s.tz ?? 'UTC'), d: s.personDefault ? `$${esc(s.personDefault)}` : T('不设 = 不限') }))}</th><th>${T('状态')}</th><th>${T('近 14 天（左旧右新）')} ${hint(T('每个字符是一天，最右边是今天；越高花得越多，· 表示那天没花。鼠标停在上面看每天的金额'))}</th></tr>
    ${s.rows.map((r) => {
      const state = !r.budget ? `<span class="mute">${T('不限')}</span>`
        : r.month >= r.budget ? `<span class="bad">${T('已到预算：名下任务已暂停；调高预算或等下月 1 日（{tz}）恢复', { tz: esc(s.tz ?? 'UTC') })}</span>`
          : T('已用 {p}%', { p: Math.round((r.month / r.budget) * 100) });
      const days = r.daily.map((m, i) => `${T('{n} 天前', { n: r.daily.length - 1 - i })}：${usd2(m)}`).join('\n');
      return `<tr><td>${esc(r.name)}${r.kind === 'service' ? T('（服务账户）') : ''}</td><td>${usd2(r.month)}</td><td class="small">${usd2(r.lastMonth)}</td>
      <td class="small">${s.admin ? `$<input type="number" min="0" style="width:70px" data-bud="${esc(r.userId)}" value="${esc(r.ownBudget ?? '')}" placeholder="${esc(s.personDefault ? s.personDefault : T('默认'))}"> <button class="small" data-budsave="${esc(r.userId)}">${T('保存')}</button>`
        : (r.budget ? usd2(r.budget) : T('不设 = 不限'))}</td><td class="small">${state}</td><td class="mono" title="${esc(days)}">${spark(r.daily)}</td></tr>`;
    }).join('')}</table>
    ${s.deployment ? `<div class="small" style="margin-top:8px">${T('整个部署本月：{spent}', { spent: usd2(s.deployment.month) })}${s.deployment.budget ? T('，预算 {b}', { b: usd2(s.deployment.budget) }) : T('，没有设整个部署的月度预算')}${s.perPersonCap ? T('；每人同时最多跑 {n} 个任务，多出来的排队，按人轮流拉起', { n: esc(s.perPersonCap) }) : ''}</div>
      <div class="small mute">${T('部署级的几个数（每人默认预算、整个部署的月度预算、记账口径、每人同时在跑上限）用命令行改：node src/cli.mjs user setting deploy.person_budget_usd_month 50（其余：deploy.budget_usd_month、deploy.cost_attribution、deploy.max_running_per_person）')}</div>` : ''}`;
  document.querySelectorAll('button[data-budsave]').forEach((b) => b.onclick = async () => {
    const v = document.querySelector(`input[data-bud="${b.dataset.budsave}"]`).value.trim();
    try { await api('/api/spend/budget', { userId: b.dataset.budsave, usd: v === '' ? null : Number(v) }); toast(T('已保存')); renderSpend(); } catch (e) { toast(e.message, true); }
  });
}
// 邀请链接（团队模式、管理员）：放在「成员」里，加人就在这里
async function renderInvites() {
  const box = $('#uInvites'); if (!box) return;
  let r; try { r = await api('/api/invites'); } catch (e) { box.innerHTML = `<span class="mute">${esc(e.message)}</span>`; return; }
  const ST = { open: T('等对方接受'), used: T('已加入'), revoked: T('已撤销'), expired: T('已过期') };
  const recent = r.invites.filter((i) => i.status === 'open' || Date.now() - i.created_at < 7 * 86400_000);
  box.innerHTML = `<h3 style="margin-top:16px">${T('邀请链接')} ${hint(T('把链接私下发给要加入的人：他打开链接、填名字就加入了，不用你再转交令牌。链接只能用一次，{h} 小时后失效', { h: r.hours }))}</h3>
    <div class="row"><select id="ivRole" style="width:auto"><option value="member">${T('成员')}</option><option value="observer">${T('旁观者')}</option></select> ${hint(T('成员：能提需求、回答发给自己的问题、签收成果。旁观者：只能看进展。要当管理员的，先以成员加入，再在成员表里改角色'))}
      <input id="ivName" placeholder="${T('名字（可留空，让对方自己填）')}" style="width:220px"><button class="small" id="ivMake">${T('生成邀请链接')}</button></div>
    ${inviteNew ? `<div class="item flag" style="margin-top:10px">${T('邀请链接只显示这一次，请私下发给对方（别发在群里）：')}<div class="mono body" style="user-select:all">${esc(inviteNew.link)}</div>
      <div class="small mute">${T('{date} 前有效、只能用一次', { date: fmtWhen(inviteNew.expiresAt) })}</div><div class="row"><button class="small" id="ivNewClose">${T('关闭')}</button></div></div>` : ''}
    ${recent.length ? `<table class="rt" style="margin-top:8px"><tr><th>${T('角色')}</th><th>${T('名字')}</th><th>${T('发出')}</th><th>${T('状态')}</th><th></th></tr>${recent.map((i) => `<tr><td>${esc(roleName(i.role))}</td><td>${esc(i.used_by_name ?? i.name ?? '')}</td><td class="small">${T('{who}，{t}前', { who: esc(i.created_by_name), t: ago(i.created_at) })}</td><td class="small">${ST[i.status]}</td>
      <td class="act">${i.status === 'open' ? `<button class="small" data-ivrev="${esc(i.id)}">${T('撤销')}</button>` : ''}</td></tr>`).join('')}</table>` : ''}`;
  $('#ivMake').onclick = async () => { try { const x = await api('/api/invites', { role: $('#ivRole').value, name: $('#ivName').value.trim() || null }); inviteNew = x; renderInvites(); } catch (e) { toast(e.message, true); } };
  if ($('#ivNewClose')) $('#ivNewClose').onclick = () => { inviteNew = null; renderInvites(); };
  document.querySelectorAll('button[data-ivrev]').forEach((b) => b.onclick = async () => { try { await api('/api/invites/revoke', { id: b.dataset.ivrev }); toast(T('已撤销')); renderInvites(); } catch (e) { toast(e.message, true); } });
}
function renderTokenBox() {
  const box = $('#uToken'); if (!box) return;
  box.innerHTML = tokenBox ? `<div class="item flag" style="margin-top:10px">${T('<b>{name}</b> 的令牌（{reissued}<b>仅显示一次</b>，数据库只保存哈希）。', { name: esc(tokenBox.name), reissued: tokenBox.reissued ? T('旧令牌已失效；') : '' })}${teamMode ? T('请私下交给本人：他打开这个看板的地址，在登录页贴上它（别发在群里）：') : T('请转交本人，在右上角「切换身份」中粘贴：')}
    <div class="mono body" style="user-select:all">${esc(tokenBox.plaintext)}</div><div class="row"><button class="small" id="uTokenClose">${T('关闭')}</button></div></div>` : '';
  if (tokenBox) $('#uTokenClose').onclick = () => { tokenBox = null; renderTokenBox(); };
}
function renderUserPanel() {
  const box = $('#uPanel'); if (!box) return;
  if (hoState) return renderHandoverPanel(box);
  if (userPerm) return renderPermPanel(box);
  const lead = me.role === 'lead';
  if (userAdd) {
    box.innerHTML = `<div class="item" style="margin-top:10px"><b>${T('添加成员')}</b>
      <div class="form" style="margin-top:10px"><label>${T('名称')}</label><input id="uName">
        <label>${T('角色')} ${hint(T('成员：按决策路由接收待决事项并答复。旁观者：只读，可发消息（不参与决策），不接收待决事项。管理员角色在添加后通过「编辑」授予'))}</label><select id="uRole"><option value="member">${Tc('role', '成员')}</option><option value="observer">${T('旁观者')}</option></select>
        <label>${T('标签')} ${hint(T('决策路由中用 group:<标签> 指定一组成员；多个标签用逗号分隔'))}</label><input id="uTags" placeholder="${T('可选，如 reviewer, frontend')}"></div>
      <div class="row" style="margin-top:12px"><button id="uAdd" class="primary">${T('添加并生成令牌')}</button> <button id="uCancel">${T('取消')}</button></div></div>`;
    $('#uCancel').onclick = () => { userAdd = false; renderUserPanel(); };
    $('#uAdd').onclick = async () => {
      const name = $('#uName').value.trim(); if (!name) return toast(T('名称不能为空'), true);
      try {
        const r = await usersAct({ action: 'add', name, role: $('#uRole').value, tags: $('#uTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) });
        tokenBox = { name, plaintext: r.result.plaintext, reissued: false }; userAdd = false; renderUsers(false);
      } catch (e) { toast(e.message, true); }
    };
    return;
  }
  const u = usersData.users.find((x) => x.id === userEdit);
  if (!u) { box.innerHTML = ''; return; }
  const isLocal = u.id === usersData.local, off = !!u.disabledAt;
  box.innerHTML = `<div class="item" style="margin-top:10px"><div class="row"><b>${lead ? T('编辑 {name}', { name: esc(u.name) }) : T('管理 {name}', { name: esc(u.name) })}</b>${off ? ` <span class="pill aborted">${T('已停用')}</span>` : ''}</div>
    ${lead ? `<div class="form" style="margin-top:10px"><label>${T('名称')}</label><input id="ueName" value="${esc(u.name)}" ${off ? 'disabled' : ''}>
      <label>${T('角色')} ${hint(T('管理员：管理成员、模型、服务商与默认决策路由，可强制交接；不因此获得任何项目的答复权。成员：按决策路由接收待决事项并答复。旁观者：只读，可发消息（不参与决策）。角色与负责哪些项目无关；至少保留一位管理员，改为旁观者前须先交接未结职责'))}</label>
      <select id="ueRole" ${off ? 'disabled' : ''}><option value="lead"${u.role === 'lead' ? ' selected' : ''}>${T('管理员')}</option><option value="member"${u.role === 'member' ? ' selected' : ''}>${Tc('role', '成员')}</option><option value="observer"${u.role === 'observer' ? ' selected' : ''}>${T('旁观者')}</option></select>
      <label>${T('标签')} ${hint(T('决策路由中用 group:<标签> 指定一组成员；多个标签用逗号分隔'))}</label><input id="ueTags" value="${esc(u.tags.join(', '))}" ${off ? 'disabled' : ''}></div>
      <div class="row" style="margin-top:12px"><button id="ueSave" class="primary" ${off ? 'disabled' : ''}>${T('保存')}</button> <button id="ueCancel">${T('取消')}</button></div>
      <hr style="border:0;border-top:1px solid var(--line);margin:12px 0">` : ''}
    <div class="form"><label>${T('通知通道')} ${hint(T('待决事项路由到此成员时，向这些地址发送通知。地址可能含密钥，保存后仅显示类型与主机名；每种类型仅保留一条，再次添加即替换'))}</label>
      <div>${u.channels.map((c) => `<span class="row small" style="margin-bottom:4px">${esc(Object.fromEntries(CH_KINDS)[c.kind] ?? c.kind)} <span class="mute">${esc(c.host ?? '')}</span>${chIdle(c)} <button class="small" data-chrm="${esc(c.kind)}" ${off ? 'disabled' : ''}>${T('删除')}</button></span>`).join('') || `<span class="mute small">${T('未配置')}</span>`}</div>
      <label>${T('添加 / 替换')}</label><div class="row"><select id="ueChKind" style="width:150px">${CH_KINDS.map(([k, n]) => `<option value="${esc(k)}">${esc(n)}</option>`).join('')}</select><input id="ueChTarget" type="password" autocomplete="off" placeholder="${T('ntfy topic 地址或群机器人 webhook 地址')}" style="flex:1"> <button id="ueChAdd" ${off ? 'disabled' : ''}>${T('保存')}</button></div>
      <div id="ueChMail" class="small mute" style="display:none">${usersData.mailReady ? T('推送发到这个邮箱，每封信末尾带事项链接，点开就是那一件。') : T('这个部署还没配发信服务器（.env 的 SMTP_URL 与 MAIL_FROM），邮箱可以先登记，配好之前推不出去。')}</div></div>
    ${lead || u.id === me.id ? `<hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
    <div class="form"><label>${T('GitHub 账号')} ${hint(T('两个用处：写进提交末尾的出处行和 PR 溯源表（名字后面跟 @账号）；开了「用 GitHub 登录」时，用来认人。本人或管理员可以改。管理员填的直接算数；本人自己填的，要点「用 GitHub 验证并绑定」验证过才写进提交、才能用来登录（防止有人把别人的账号填在自己名下）'))}</label><input id="ueGithub" value="${esc(u.github ?? '')}" placeholder="octocat" autocomplete="off" ${off ? 'disabled' : ''}>${u.githubBound ? `<div class="small mute">${T('已绑定：按 GitHub 内部编号认人，这个账号在 GitHub 上改了名也不影响（下次用 GitHub 登录时，这里和提交里的 @账号跟着更新）。这里换成别的账号会解除绑定，之后要重新验证')}</div>`
        : usersData.githubLogin?.enabled && u.id === me.id ? `<div class="row" style="margin-top:4px"><button id="ueGhLink" class="small" ${off ? 'disabled' : ''}>${T('用 GitHub 验证并绑定')}</button> <span class="small mute">${T('跳到 GitHub 授权一次，回来就绑好了，以后可以用 GitHub 登录')}</span></div>`
        : usersData.githubLogin?.enabled && u.github && !lead ? `<div class="small mute">${T('还没验证：本人在这里点「用 GitHub 验证并绑定」后才能用 GitHub 登录')}</div>` : ''}
      <label>${T('提交邮箱')} ${hint(T('只在管理员打开了「设置 → 连接」里的 Co-authored-by 时用到：GitHub 按邮箱认人、显示头像。绑定了 GitHub 账号的人不用填，自动用 GitHub 给的 noreply 地址；没绑定的，这里要由管理员填才生效（防止有人填别人的邮箱冒名）。只有你自己和管理员看得到'))}</label><input id="ueEmail" value="${esc(u.commitEmail ?? '')}" placeholder="12345+octocat@users.noreply.github.com" autocomplete="off" ${off ? 'disabled' : ''}>
      <div class="row"><button id="ueGitSave" ${off ? 'disabled' : ''}>${T('保存')}</button></div></div>` : ''}
    <hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
    <div class="row">${off ? '' : `<button id="ueToken" title="${isLocal ? T('此为启动看板的本机身份，令牌保存在本机令牌文件中；请用命令行 user token 重新生成') : T('生成新令牌，旧令牌立即失效；新令牌仅显示一次')}" ${isLocal ? 'disabled' : ''}>${T('重新生成令牌')}</button>
      <button id="ueHandover" title="${T('将未结职责交接给其他成员；先预览变更，再执行或提交申请')}">${T('交接…')}</button>`}
      ${!lead ? `<button id="ueCancel">${T('关闭')}</button>` : ''}<span class="grow"></span>
      ${lead ? (off ? `<button id="ueEnable" title="${T('启用后需另行重新生成令牌')}">${T('启用')}</button>` : `<button id="ueDisable" class="danger" title="${T('吊销全部令牌，不再接收待决事项；记录保留。存在未结职责时不会停用，而是打开交接面板并预选「交接后停用」')}">${T('停用')}</button>`) : ''}</div></div>`;
  const close = () => { userEdit = null; renderUserPanel(); };
  if ($('#ueCancel')) $('#ueCancel').onclick = close;
  if ($('#ueGitSave')) $('#ueGitSave').onclick = async () => {
    try { await usersAct({ action: 'git_identity', userId: u.id, github: $('#ueGithub').value, email: $('#ueEmail').value }, T('已保存')); renderUsers(false); } catch (e) { toast(e.message, true); }
  };
  if ($('#ueGhLink')) $('#ueGhLink').onclick = () => { location.href = '/api/auth/github';
  };
  if ($('#ueSave')) $('#ueSave').onclick = async () => {
    try {
      const name = $('#ueName').value.trim(), role = $('#ueRole').value, tags = $('#ueTags').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (name !== u.name) await usersAct({ action: 'rename', userId: u.id, name });
      if (role !== u.role) await usersAct({ action: 'role', userId: u.id, role });
      if (tags.join(',') !== u.tags.join(',')) await usersAct({ action: 'tags', userId: u.id, tags });
      toast(T('已保存')); renderUsers(false);
    } catch (e) { toast(e.message, true); renderUsers(true); }
  };
  document.querySelectorAll('button[data-chrm]').forEach((b) => b.onclick = async () => { try { await usersAct({ action: 'channel_remove', userId: u.id, kind: b.dataset.chrm }, T('已删除')); renderUsers(false); } catch (e) { toast(e.message, true); } });
  // 邮件：地址不是密钥，明文显示；其余是 webhook 地址（含密钥），照旧遮住
  $('#ueChKind').onchange = () => {
    const mail = $('#ueChKind').value === 'email', inp = $('#ueChTarget');
    inp.type = mail ? 'email' : 'password'; inp.placeholder = mail ? T('邮箱地址，例 lin@example.com') : T('ntfy topic 地址或群机器人 webhook 地址');
    $('#ueChMail').style.display = mail ? '' : 'none';
  };
  $('#ueChAdd').onclick = async () => {
    const target = $('#ueChTarget').value.trim(); if (!target) return toast(T('地址不能为空'), true);
    try { await usersAct({ action: 'channel_set', userId: u.id, kind: $('#ueChKind').value, target }, T('通知通道已保存')); renderUsers(false); } catch (e) { toast(e.message, true); }
  };
  if ($('#ueToken')) $('#ueToken').onclick = async () => {
    if (!confirm(T('重新生成 {name} 的令牌？旧令牌将立即失效。', { name: u.name }))) return;
    try {
      const r = await usersAct({ action: 'token', userId: u.id });
      tokenBox = { name: u.name, plaintext: r.result.plaintext, reissued: true }; renderUsers(false);
    } catch (e) { toast(e.message, true); }
  };
  if ($('#ueHandover')) $('#ueHandover').onclick = () => { hoState = { from: u.id, to: '', scope: 'all', note: '', thenDisable: false, result: null }; renderUserPanel(); };
  if ($('#ueDisable')) $('#ueDisable').onclick = async () => {
    if (!confirm(T('停用 {name}？其全部令牌将被吊销。', { name: u.name }))) return;
    try { await usersAct({ action: 'disable', userId: u.id }, T('已停用')); renderUsers(false); }
    catch (e) { if (e.data?.needsHandover || /先交接/.test(e.message)) { toast(T('存在未结职责，须先交接'), true); hoState = { from: u.id, to: '', scope: 'all', note: '', thenDisable: true, result: null, why: e.message }; renderUserPanel(); } else toast(e.message, true); }
  };
  if ($('#ueEnable')) $('#ueEnable').onclick = async () => { try { await usersAct({ action: 'enable', userId: u.id }, T('已启用；需另行重新生成令牌')); renderUsers(false); } catch (e) { toast(e.message, true); } };
}
/** 权限一览（只读）：角色权限 + 负责的项目 / 任务 + 在各决策路由中的位置（含经标签、所有成员、值班、负责人间接指定的）。 */
function renderPermPanel(box) {
  const p = userPerm, n = p.owns.projects.length + p.owns.soloTasks.length;
  const modeText = (t) => (t.mode === 'inform' ? T('仅知会') : t.type === 'delivery' ? T('可执行') : T('需答复'));
  box.innerHTML = `<div class="item" style="margin-top:10px"><div class="row"><b>${T('{name} 的权限', { name: esc(p.name) })}</b> <span class="small mute">${T('只读；按当前时刻计算')}</span><span class="grow"></span><button id="upClose" class="small">${T('关闭')}</button></div>
    ${p.disabled ? `<div class="small" style="margin-top:8px">${T('已停用：令牌全部失效，不接收任何事项。')}</div>` : `
    <div class="kv" style="margin-top:10px"><span class="mute">${T('角色')}</span><span>${T('{role}：{caps}', { role: esc(roleName(p.role)), caps: esc(p.roleCaps.map((c) => T(c)).join(T('；'))) })}</span></div>
    <div class="kv"><span class="mute">${T('新建项目与任务')}</span><span>${p.canCreate.ok ? T('可以（创建者即负责人）') : T('不可以：{why}', { why: esc(T(p.canCreate.why)) })}</span></div>
    <div class="kv"><span class="mute">${T('负责')}</span><span>${n ? esc([p.owns.projects.length ? T('项目{list}', { list: p.owns.projects.map((x) => T('「{s}」', { s: x.title })).join(T('、')) }) : '', p.owns.soloTasks.length ? T('不属于项目的任务 {n} 个', { n: p.owns.soloTasks.length }) : ''].filter(Boolean).join(T('；'))) : `<span class="mute">${T('无')}</span>`}
      ${n ? `<div class="small mute">${T('对所负责的项目 / 任务：{caps}', { caps: esc(p.ownerCaps.map((c) => T(c)).join(T('；'))) })}</div>` : ''}</span></div>
    <div class="small mute" style="margin-top:10px">${T('在各决策路由中的位置')} ${hint(T('除直接指定外，也包括经标签、「所有成员」、值班表、「负责人」间接指定到此成员的规则。管理员角色本身不带来任何项目的答复权'))}</div>
    ${p.routing.filter((r) => r.types.length).map((r) => `<table class="rt" style="margin-top:6px"><tr><th colspan="3">${r.key ? T('项目：{title}', { title: esc(r.title) }) : esc(T(r.title))}${r.isOwner ? T('（负责人）') : ''}</th></tr>
      ${r.types.some((t) => t.leadOnly) ? `<tr><td>${esc(r.types.filter((t) => t.leadOnly).map((t) => Tc('dtype', t.label)).join(T('、')))}</td><td>${T('需答复')}</td><td class="small mute">${T('作为负责人')}</td></tr>` : ''}
      ${r.types.filter((t) => !t.leadOnly).map((t) => `<tr><td>${esc(Tc('dtype', t.label))}</td><td>${modeText(t)}</td><td class="small mute">${T('经由 {via}', { via: esc(t.via.map((v) => T(v)).join(T('、'))) })}</td></tr>`).join('')}</table>`).join('') || `<div class="small mute" style="margin-top:6px">${T('不在任何决策路由中')}</div>`}
    ${p.duty.length ? `<div class="kv" style="margin-top:10px"><span class="mute">${T('值班表')}</span><span>${esc(p.duty.map((d) => `${d.key ? d.title : T(d.title)}${d.onDutyNow ? T('（当前值班）') : ''}`).join(T('、')))}</span></div>` : ''}`}</div>`;
  $('#upClose').onclick = () => { userPerm = null; renderUserPanel(); };
}
/** 交接：选接手人与范围 → 预览（服务端真做一遍再回滚）→ 执行 / 提交申请。改了任何一项都要重新预览。 */
function renderHandoverPanel(box) {
  const lead = me.role === 'lead', h = hoState, U = usersData.users;
  const from = U.find((x) => x.id === h.from);
  const cands = U.filter((x) => x.id !== h.from && !x.disabledAt && x.role !== 'observer');
  const openProjects = projects.filter((p) => !['done', 'aborted'].includes(p.status));
  const scopeBody = (v) => (v === 'all' ? { all: true } : v === 'solo' ? { soloTasks: true } : { project: v.slice(2) });
  box.innerHTML = `<div class="item" style="margin-top:10px"><b>${T('交接：{from} → {to}', { from: esc(from?.name ?? h.from), to: esc(U.find((x) => x.id === h.to)?.name ?? T('未选择')) })}</b>
    <div class="small mute" style="margin-top:4px">${T('仅交接未结职责：所负责的项目与任务、决策路由中指定到此成员的行、值班表、未关闭的待决事项。已提交的答复、已签收的记录、已结束的项目与任务保留原成员名称。')}<br>${T('管理员可直接执行任何交接；范围为某个项目时，该项目的负责人也可直接执行。其余情况提交申请：项目范围由该项目的负责人或管理员批准，其他范围由管理员批准。')}</div>
    ${h.why ? `<div class="small" style="margin-top:6px;color:var(--wait)">${esc(h.why)}</div>` : ''}
    <div class="form" style="margin-top:10px">
      <label>${T('接手人')} ${hint(T('仅限成员或管理员；旁观者与已停用成员不可选。交接只变更负责人与接收人，不改变任何人的角色'))}</label><select id="hoTo"><option value="">${T('选择…')}</option>${cands.map((x) => `<option value="${esc(x.id)}"${x.id === h.to ? ' selected' : ''}>${T('{name}（{role}）', { name: esc(x.name), role: esc(roleName(x.role)) })}</option>`).join('')}</select>
      <label>${T('范围')}</label><select id="hoScope"><option value="all"${h.scope === 'all' ? ' selected' : ''}>${T('全部')}</option><option value="solo"${h.scope === 'solo' ? ' selected' : ''}>${T('不属于任何项目的任务（含默认决策路由）')}</option>${openProjects.map((p) => `<option value="p:${esc(p.id)}"${h.scope === `p:${esc(p.id)}` ? ' selected' : ''}>${T('项目：{title}', { title: esc(p.title) })}</option>`).join('')}</select>
      <label>${T('备注')}</label><textarea id="hoNote" rows="2" placeholder="${T('可选；原样附在发给接手人的通知中')}">${esc(h.note)}</textarea>
      ${lead ? `<label>${T('交接后停用')} ${hint(T('仅当范围为「全部」时可选：交接完成后吊销其全部令牌并标记为已停用'))}</label><div><input type="checkbox" id="hoDisable" style="width:auto"${h.thenDisable ? ' checked' : ''}${h.scope === 'all' ? '' : ' disabled'}></div>` : ''}</div>
    <div class="row" style="margin-top:12px"><button id="hoPreview" class="${h.result ? '' : 'primary'}">${T('预览')}</button> <button id="hoCancel">${T('取消')}</button></div>
    ${h.result ? `<pre class="small" style="margin-top:10px">${esc(h.result.text)}</pre>
      ${h.result.changes.empty ? '' : `<div class="row">${h.result.changes.needsQuorumConfirm && !h.result.changes.needsApproval ? `<label class="small"><input type="checkbox" id="hoDrop" style="width:auto"> ${T('允许降低受影响事项的法定人数')}</label>` : ''}
        <button id="hoRun" class="primary">${h.result.changes.needsApproval ? T('提交申请') : T('执行交接')}</button>${h.result.changes.needsApproval ? `<span class="small mute">${T('需{who}批准；批准前不做任何变更', { who: esc(T(h.result.changes.approver)) })}</span>` : ''}</div>`}` : ''}</div>`;
  const sync = () => { h.to = $('#hoTo').value; h.scope = $('#hoScope').value; h.note = $('#hoNote').value; h.thenDisable = !!$('#hoDisable')?.checked && h.scope === 'all'; };
  ['#hoTo', '#hoScope', '#hoDisable'].forEach((id) => { const el = $(id); if (el) el.onchange = () => { sync(); h.result = null; renderHandoverPanel(box); }; });
  $('#hoNote').oninput = () => { h.note = $('#hoNote').value; };
  $('#hoCancel').onclick = () => { hoState = null; renderUserPanel(); };
  const body = (action) => ({ action, from: h.from, to: h.to, scope: scopeBody(h.scope), note: h.note.trim() || null, thenDisable: h.thenDisable });
  $('#hoPreview').onclick = async () => {
    sync(); if (!h.to) return toast(T('请先选择接手人'), true);
    try { const r = await api('/api/handover', body('preview')); h.result = r.result; renderHandoverPanel(box); } catch (e) { toast(e.message, true); }
  };
  if ($('#hoRun')) $('#hoRun').onclick = async () => {
    sync();
    try {
      const r = await api('/api/handover', { ...body('run'), allowQuorumDrop: !!$('#hoDrop')?.checked });
      usersData = usersFrom(r);
      toast(r.result.requested ? T('申请已提交，待{who}批准', { who: r.result.changes?.approver ? T(r.result.changes.approver) : T('管理员') }) : r.result.notified ? T('交接已执行，已通知接手人') : T('交接已执行；接手人未配置通知通道，需另行告知'));
      hoState = null; userEdit = null; await loadMe(); await loadTasks(); renderUsers(false);
    } catch (e) { toast(e.message, true); }
  };
}
