// ── 成员：列表 / 编辑面板 / 交接 ─────────────────────────────────────────
// 负责人管所有人；成员只能动自己那一行（通知通道、令牌、申请交接）。与其他设置分区一样不跟 SSE 重画。
let usersData = null, userEdit = null, userAdd = false, hoState = null, tokenBox = null, userPerm = null;
// 动作的返回带着整份成员视图（另有 ok / result）：整份接住，别漏掉 githubLogin、mailReady 这类附带字段
const usersFrom = ({ ok, result, ...r }) => ({ ...r, settings: r.settings ?? {} });
const CH_KINDS = [['ntfy', 'ntfy'], ['feishu', T('飞书机器人')], ['dingtalk', T('钉钉机器人')], ['wecom', T('企业微信机器人')], ['email', T('邮件')]];
// 邮件通道要部署配了发信服务器才推得出去：没配时在登记的邮箱后面标出来
const chIdle = (c) => (c.kind === 'email' && usersData && !usersData.mailReady ? ` <span class="warn small">${T('（发信没配，还推不出去）')}</span>` : '');
async function usersAct(body, okMsg) {
  const r = await api('/api/users', body);
  // 重发的是自己正在用的令牌：浏览器里存的那枚跟着换，否则下一个请求就认证不过
  if (body.action === 'token' && body.userId === me?.id) {
    // 团队模式：旧令牌作废了，cookie 里那份跟着失效 —— 用新令牌当场重新登录，不把人踢回登录页
    if (teamMode) await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: r.result.plaintext }) });
    else { try { if (localStorage.getItem('si_token')) localStorage.setItem('si_token', r.result.plaintext); } catch { /* 存不了就让他重新贴 */ } }
  }
  usersData = usersFrom(r);
  if (okMsg) toast(okMsg);
  await loadMe();
  return r;
}
// 签收例外批准习惯（只给管理员）：近 30 天每个人签收与方案批准的节奏。很快批、从不打回的挂 ⚠ —— 自动化偏差本人察觉不到，只能让负责人看见。
// 每人两行（名字 + 提醒 / 三个数），不用表格：窄屏下五列挤不下。最近几次逐条可展开、能点进任务 —— 走查：看完只知道"有个提醒"，找不到那几次是什么
const durS = (ms) => (ms == null ? '—' : ms < 60_000 ? T('{n} 秒', { n: Math.max(1, Math.round(ms / 1000)) }) : dur(ms));
const whoName = (id, name) => (me && id === me.id ? T('你') : name);
function habitsHtml(h) {
  if (!h) return '';
  const flagged = h.rows.filter((r) => r.flagged);
  const note = (r) => (r.flagged ? `<b style="color:var(--wait)">⚠ ${T('最近 {n} 次都批准，打开后中位数 {t} 就答', { n: esc(h.rule.streak), t: esc(durS(r.medianOpenMs)) })}</b>`
    : r.fastWithExceptions ? `<span style="color:var(--wait)">${T('{n} 次签收摆着要处理的例外，打开不到 {t} 就接受了', { n: esc(r.fastWithExceptions), t: esc(durS(h.rule.fastMs)) })}</span>` : '');
  const nums = (r) => [
    T('批准 {a} / 共 {n} 次', { a: esc(r.approvals), n: esc(r.decisions) }) + (r.batch ? T('（{n} 次是一次签掉多个）', { n: esc(r.batch) }) : ''),
    T('提出到答复 {t}', { t: esc(durS(r.medianResponseMs)) }),
    r.measured ? T('打开到答复 {t}（{n} 次有记录）', { t: esc(durS(r.medianOpenMs)), n: esc(r.measured) }) : T('打开到答复：没有记录'),
  ].join(' · ');
  const KIND = { signoff: T('签收'), contract_approval: T('方案批准') };
  const one = (d) => `<li>${d.taskId ? `<a href="#${esc(d.taskId)}">${esc(d.title ?? d.taskId)}</a>` : '—'} · ${esc(KIND[d.type] ?? d.type)} · ${d.approve ? esc(T('批准')) : `<b>${esc(T('打回 / 要改'))}</b>`}`
    + ` · ${d.batch ? esc(T('一次签掉多个')) : d.openMs != null ? esc(T('打开后 {t} 就答', { t: durS(d.openMs) })) : esc(T('没有打开记录'))}${d.exceptions ? ` · <span style="color:var(--wait)">${esc(T('签收卡上有 {n} 项例外要处理', { n: d.exceptions }))}</span>` : ''}`
    + ` <span class="mute">${esc(fmtWhen(d.at))}</span></li>`;
  const recent = (r) => (r.recent?.length ? `<details style="margin-top:2px"><summary class="mute">${T('最近 {n} 次', { n: esc(r.recent.length) })}</summary><ul style="margin:2px 0 0 18px;padding:0">${r.recent.map(one).join('')}</ul></details>` : '');
  const rows = h.rows.map((r) => `<div style="margin-top:6px"><b>${esc(whoName(r.userId, r.name))}</b>${note(r) ? ` ${note(r)}` : ''}<div class="mute">${nums(r)}</div>${recent(r)}</div>`).join('');
  return `<details class="small" style="margin-top:14px"${flagged.length ? ' open' : ''}><summary><b>${T('批准习惯')}</b> <span class="mute">${T('近 {d} 天的签收与方案批准', { d: esc(h.rule.windowDays) })}</span>${flagged.length ? ` · <b style="color:var(--wait)">⚠ ${T('{n} 人可能在走过场', { n: esc(flagged.length) })}</b>` : ''}</summary>`
    + (h.rows.length ? rows
      + (flagged.length ? `<div style="margin-top:8px">${T('下一步：展开每人下面的「最近 n 次」，点进任务看改动大小。小改动、没有要处理的例外时快批是正常的；改动大、签收卡上有例外要处理也很快就批的，值得回头再看一遍，必要时和当事人聊一聊。')}</div>` : '')
      + `<div class="mute" style="margin-top:8px">${T('时长都是中位数。"打开"＝第一次在任务页上看到这条事项（页面在前台）。命令行或通知里答的没有打开时间，不参与"很快"的判断 —— 只在那里答的人不会被提醒。')}</div>`
      + `<div class="mute">${T('挂 ⚠ 的条件：最近 {n} 次都是批准，其中至少 {m} 次有打开记录，且打开到答复的中位数不到 {t}。只是提醒，不拦任何操作。', { n: esc(h.rule.streak), m: esc(h.rule.minMeasured), t: esc(durS(h.rule.fastMs)) })}</div>`
      : `<div class="mute" style="margin-top:4px">${T('近 {d} 天没有人做过签收或方案批准', { d: esc(h.rule.windowDays) })}</div>`)
    + '</details>';
}
async function renderUsers(reload = true) {
  if (!me || me.role === 'observer') return;
  if (reload || !usersData) { try { usersData = await api('/api/users'); } catch (e) { $('#users').innerHTML = `<span class="mute">${esc(e.message)}</span>`; return; } }
  const lead = me.role === 'lead', U = usersData.users;
  const chText = (u) => u.channels.map((c) => `${esc(Object.fromEntries(CH_KINDS)[c.kind] ?? c.kind)}${c.host ? ` <span class="mute">${esc(c.host)}</span>` : ''}${chIdle(c)}`).join(T('、')) || `<span class="mute">${T('无')}</span>`;
  const reqs = usersData.requests ?? [], adminOnly = !!usersData.settings?.['deploy.create_admin_only'];
  const contentLang = usersData.settings?.['deploy.content_lang'] ?? 'zh';
  const LANG_NAMES = { zh: I18N.lang === 'zh' ? '中文' : 'Chinese (中文)', en: 'English' };   // 语言名在英文界面带上英文
  $('#users').innerHTML = `
    ${reqs.length ? `<div class="item flag" style="margin-bottom:12px"><b>${T('交接申请')}</b>${reqs.map((r) => `
      <div style="margin-top:8px">${T('{from} 申请将{scope}范围内的职责交接给 {to}', { from: esc(r.fromName), scope: r.scope?.project ? esc(r.scopeText) : T('「{s}」', { s: esc(T(r.scopeText)) }), to: esc(r.toName) })}${r.thenDisable ? T('，交接后停用') : ''} <span class="small mute">${T('{t}前', { t: ago(r.requestedAt) })}</span>${r.note ? `<div class="small">${T('备注：{note}', { note: esc(r.note) })}</div>` : ''}
        ${r.text ? `<pre class="small" style="margin:6px 0">${esc(r.text)}</pre>` : `<div class="small" style="color:var(--bad)">${T('当前无法执行：{error}', { error: esc(r.error ?? '') })}</div>`}
        <div class="row">${r.canDecide ? `${r.needsQuorumConfirm ? `<label class="small"><input type="checkbox" data-rq-drop="${esc(r.id)}" style="width:auto"> ${T('允许降低受影响事项的法定人数')}</label>` : ''}<button class="primary small" data-rq="approve" data-id="${esc(r.id)}">${T('批准并执行')}</button> <button class="small" data-rq="reject" data-id="${esc(r.id)}">${T('驳回')}</button>` : ''}
          ${r.fromUserId === me.id ? `<button class="small" data-rq="withdraw" data-id="${esc(r.id)}">${T('撤回')}</button><span class="small mute">${T('批准前不做任何变更')}</span>` : ''}<span class="small mute">${T('可批准：{who}', { who: esc(r.approver ? T(r.approver) : T('管理员')) })}</span></div></div>`).join('')}</div>` : ''}
    <div class="row small" style="margin-bottom:10px"><label for="uCreatePolicy">${T('新建项目与任务')}</label> <span>${hint(T('创建者即该项目 / 任务的负责人；花费受预算上限约束。旁观者始终不能新建'))}</span>
      ${lead ? `<select id="uCreatePolicy" style="width:auto"><option value="0"${adminOnly ? '' : ' selected'}>${T('成员与管理员均可')}</option><option value="1"${adminOnly ? ' selected' : ''}>${T('仅管理员')}</option></select>` : `<span class="mute">${adminOnly ? T('仅管理员') : T('成员与管理员均可')}</span>`}</div>
    <div class="row small" style="margin-bottom:10px"><label for="uContentLang">${T('内容语言')}</label> <span>${hint(T('写进事项、汇报、约定清单的文字，以及 AI 写给人的问题和草案，用哪种语言。全团队统一：同一条事项所有人看到的是同一份原文。每个人自己的界面语言在页面右上角切换'))}</span>
      ${lead ? `<select id="uContentLang" style="width:auto">${Object.entries(LANG_NAMES).map(([k, n]) => `<option value="${esc(k)}"${k === contentLang ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>` : `<span class="mute">${esc(LANG_NAMES[contentLang] ?? contentLang)}</span>`}</div>
    <table class="rt"><tr><th>${T('名称')}</th><th>${T('角色')}</th><th>${T('标签')}</th><th>${T('通知通道')}</th><th>${T('令牌')} ${hint(T('登录凭据。丢失或泄露时重新生成：这个人的旧令牌和登录全部立即失效。每个人自己的令牌和登录在「登录与令牌」里管'))}</th><th>${T('未结职责')} ${hint(T('所负责的进行中项目 / 任务、决策路由中指定到此成员的行、值班表、未关闭的待决事项。停用或改为旁观者前须先交接'))}</th><th></th></tr>
    ${U.map((u) => `<tr${u.disabledAt ? ' class="off"' : ''}><td>${esc(u.name)}${u.id === me.id ? ` <span class="mute small">${T('（你）')}</span>` : ''}</td><td>${u.disabledAt ? T('已停用') : esc(roleName(u.role))}</td><td>${esc(u.tags.join(T('、'))) || `<span class="mute">${T('无')}</span>`}</td>
      <td>${chText(u)}</td><td class="small">${u.disabledAt ? `<span class="mute">${T('已吊销')}</span>` : u.tokens ? `${T('有效')} · <span class="mute">${T('{t}前签发', { t: ago(u.tokenIssuedAt) })}</span>` : `<span style="color:var(--wait)">${T('无')}</span>`}</td>
      <td class="small">${u.responsibilities.text ? esc(u.responsibilities.text) : `<span class="mute">${T('无')}</span>`}</td>
      <td class="act"><button class="small" data-uperm="${esc(u.id)}" title="${T('角色权限、所负责的项目与任务、在各决策路由中的位置')}">${T('权限')}</button> ${lead || u.id === me.id ? `<button class="small" data-uedit="${esc(u.id)}">${lead ? T('编辑') : T('管理')}</button>` : ''}</td></tr>`).join('')}</table>
    ${lead ? `<div class="row" style="margin-top:8px"><button id="uAddOpen" class="small">${T('添加成员')}</button></div>` : ''}
    ${habitsHtml(usersData.habits)}
    <div id="uToken"></div><div id="uPanel"></div>${lead && teamMode ? '<div id="uInvites"></div>' : ''}`;
  if (lead && teamMode) void renderInvites();
  document.querySelectorAll('button[data-uedit]').forEach((b) => b.onclick = () => { userEdit = b.dataset.uedit; userAdd = false; hoState = null; userPerm = null; renderUserPanel(); });
  document.querySelectorAll('button[data-uperm]').forEach((b) => b.onclick = async () => {
    try { userPerm = await api(`/api/permissions?user=${encodeURIComponent(b.dataset.uperm)}`); userEdit = null; userAdd = false; hoState = null; renderUserPanel(); } catch (e) { toast(e.message, true); }
  });
  if ($('#uAddOpen')) $('#uAddOpen').onclick = () => { userAdd = true; userEdit = null; hoState = null; userPerm = null; renderUserPanel(); };
  onPick($('#uContentLang'), async () => {
    try { await usersAct({ action: 'setting', key: 'deploy.content_lang', value: $('#uContentLang').value }, T('已保存：之后新写的内容用这种语言，已有的不变')); renderUsers(false); } catch (e) { toast(e.message, true); renderUsers(true); }
  });
  onPick($('#uCreatePolicy'), async () => {
    try { await usersAct({ action: 'setting', key: 'deploy.create_admin_only', value: $('#uCreatePolicy').value === '1' }, T('已保存')); renderUsers(false); } catch (e) { toast(e.message, true); renderUsers(true); }
  });
  document.querySelectorAll('button[data-rq]').forEach((b) => b.onclick = async () => {
    const note = b.dataset.rq === 'reject' ? (prompt(T('驳回理由（可选）')) ?? null) : null;
    if (b.dataset.rq === 'reject' && note === null) return;
    try {
      const r = await api('/api/handover', { action: b.dataset.rq, requestId: b.dataset.id, note, allowQuorumDrop: !!document.querySelector(`input[data-rq-drop="${b.dataset.id}"]`)?.checked });
      usersData = usersFrom(r);
      toast({ approved: r.result.notified ? T('交接已执行，已通知接手人') : T('交接已执行；接手人未配置通知通道，需另行告知'), rejected: T('已驳回'), withdrawn: T('已撤回') }[r.result.status]);
      await loadMe(); await loadTasks(); renderUsers(false);
    } catch (e) { toast(e.message, true); }
  });
  renderTokenBox(); renderUserPanel();
}
// ── 登录与令牌：每人管自己的令牌与登录；管理员另看全员、发邀请链接 ─────────────
let tokNew = null, inviteNew = null;
const TOKEN_KIND_NAME = () => ({ session: T('浏览器登录'), cli: T('命令行令牌'), service: T('服务令牌') });
const SCOPE_NAME = () => ({ read: T('只读'), write: T('读写') });
const dayOf = (ts) => fmtWhen(ts, { time: false });
// 还剩多久：过期时刻离现在多远（没过期的才会列出来）
const timeLeft = (ts) => T('还剩 {t}', { t: ago(Date.now() - (ts - Date.now())) });
function tokenRow(t, { owner = null, revoke = 'mine' } = {}) {
  // 浏览器登录另有闲置期限：只写"还剩 6 天"会让人以为 6 天内都不用再登录
  const idle = t.idle_ms ? `<div class="small mute">${T('闲置 {h} 小时即失效', { h: Math.round(t.idle_ms / 3600_000) })}</div>` : '';
  const exp = t.expires_at ? `${t.idle_ms ? T('最迟 {date}', { date: dayOf(t.expires_at) }) : dayOf(t.expires_at)} <span class="mute">${timeLeft(t.expires_at)}</span>${idle}` :(t.kind === 'cli' ? `<span style="color:var(--wait)">${T('不过期')}</span> ${hint(T('没有过期时间的令牌泄露了就一直有效。建议签一枚有期限的新令牌，再吊销这一枚'))}` : T('不过期'));
  const used = t.last_used_at ? `${T('{t}前', { t: ago(t.last_used_at) })}${t.last_ip ? ` <span class="mute">${esc(t.last_ip)}</span>` : ''}` : `<span class="mute">${T('没用过')}</span>`;
  const tag = t.current ? ` <span class="tag">${T('你现在这次登录')}</span>` : t.viaCurrent ? ` <span class="tag">${T('你现在这次登录是用它登的')}</span>` : '';
  const btn = t.current ? `<span class="small mute">${T('要结束它：右上角「退出登录」')}</span>` :`<button class="small" data-trev="${esc(t.id)}" data-via="${t.viaCurrent ? 1 : 0}" data-scope="${esc(revoke)}">${T('吊销')}</button>`;
  // 系统起的名字（浏览器会话、管理员添加时签发……）按界面语言翻；人自己起的名字原样
  return `<tr>${owner !== null ? `<td>${esc(owner)}</td>` : ''}<td>${esc(t.name ? T(t.name) : T('（未命名）'))}${tag}</td><td>${esc(TOKEN_KIND_NAME()[t.kind] ?? t.kind)}</td><td>${esc(SCOPE_NAME()[t.scope] ?? t.scope)}</td>
    <td class="small">${T('{t}前', { t: ago(t.issued_at) })}</td><td class="small">${used}</td><td class="small">${exp}</td><td class="act">${btn}</td></tr>`;
}
async function renderSessions() {
  const box = $('#sessions'); if (!box || !me) return;
  let mine, all = null;
  try { mine = await api('/api/me/tokens'); if (me.role === 'lead') all = await api('/api/admin/tokens'); } catch (e) { box.innerHTML = `<span class="mute">${esc(e.message)}</span>`; return; }
  const head = (withOwner) => `<tr>${withOwner ? `<th>${T('成员')}</th>` : ''}<th>${T('名称')}</th><th>${T('类型')} ${hint(T('浏览器登录：在看板上登录一次就有一个，闲置或到期自动失效、点「退出登录」当场作废。命令行令牌：给命令行、脚本、以及在新电脑上登录用'))}</th><th>${T('权限')} ${hint(T('只读的令牌只能看、不能做任何改动：适合挂在大屏上、给监控脚本用'))}</th><th>${T('签发')}</th><th>${T('最后使用')}</th><th>${T('到期')}</th><th></th></tr>`;
  const others = mine.tokens.filter((t) => !t.current && !t.viaCurrent).length;
  box.innerHTML = `
    <div class="small mute" style="margin-bottom:8px">${T('你现在有效的登录和令牌。觉得哪一枚可能泄露了，就吊销它；吊销一枚令牌，用它登录的浏览器会一起退出。')}</div>
    <table class="rt">${head(false)}${mine.tokens.map((t) => tokenRow(t)).join('')}</table>
    <div class="row" style="margin-top:8px">${others ? `<button class="small" id="tkRevOthers">${T('其余 {n} 个全部吊销（保留你现在这次登录和它用的令牌）', { n: others })}</button>` : ''}</div>
    <h3 id="tkH" style="margin-top:16px">${T('签一枚新令牌')}</h3>
    <div class="small mute" style="margin-bottom:6px">${T('给命令行、脚本用，或者在另一台电脑上登录用。令牌只在签发时显示一次。')}</div>
    <div class="row"><input id="tkName" aria-label="${T('令牌的名字')}" placeholder="${T('名字，比如「笔记本命令行」')}" style="width:200px">
      <select id="tkScope" style="width:auto" aria-label="${T('权限')}"><option value="write">${T('读写')}</option><option value="read">${T('只读')}</option></select>
      <label class="small">${T('有效期')} <input id="tkDays" type="number" min="0" style="width:70px" placeholder="${esc(mine.cliDays)}"> ${T('天')} ${hint(T('留空用部署默认（{n} 天）；0 = 不过期（不建议）', { n: mine.cliDays }))}</label>
      <button class="primary small" id="tkMake">${T('签发')}</button></div>
    ${tokNew ? `<div class="item flag" style="margin-top:10px">${T('<b>{name}</b>：令牌只显示这一次（数据库只存哈希），现在复制保存好。', { name: esc(tokNew.name) })}<div class="mono body" style="user-select:all">${esc(tokNew.plaintext)}</div>
      <div class="small mute">${tokNew.expiresAt ? T('{date} 到期', { date: dayOf(tokNew.expiresAt) }) : T('不过期')}</div><div class="row"><button class="small" id="tkNewClose">${T('我已保存，关闭')}</button></div></div>` : ''}
    ${all ? `<h3 style="margin-top:20px">${T('全部成员')}</h3><div class="small mute" style="margin-bottom:6px">${T('所有成员还有效的登录与令牌。有人离开团队、或者电脑丢了，从这里吊销。')}</div>
      <table class="rt">${head(true)}${all.tokens.map((t) => tokenRow({ ...t, current: t.id === mine.current, viaCurrent: mine.tokens.some((m) => m.id === t.id && m.viaCurrent) }, { owner: t.display_name + (t.user_kind === 'service' ? T('（服务账户）') : ''), revoke: 'admin' })).join('')}</table>` : ''}`;
  document.querySelectorAll('button[data-trev]').forEach((b) => b.onclick = async () => {
    if (b.dataset.via === '1' && !confirm(T('这是你现在这次登录用的令牌：吊销它，你会被退出登录。继续？'))) return;
    try { await api(b.dataset.scope === 'admin' ? '/api/admin/tokens/revoke' : '/api/me/tokens/revoke', { id: b.dataset.trev }); toast(T('已吊销')); if (b.dataset.via === '1') return location.reload(); renderSessions(); } catch (e) { toast(e.message, true); }
  });
  if ($('#tkRevOthers')) $('#tkRevOthers').onclick = async () => {
    const names = mine.tokens.filter((t) => !t.current && !t.viaCurrent).map((t) => (t.name ? T(t.name) : T('（未命名）'))).join(T('、'));
    if (!confirm(`${T('吊销除了现在这次登录以外的全部令牌和登录？其它电脑上会被退出，命令行用的令牌也会失效。')}\n${T('将吊销：{names}', { names })}`)) return;
    try { const r = await api('/api/me/tokens/revoke-others', {}); toast(T('已吊销 {n} 个', { n: r.revoked })); renderSessions(); } catch (e) { toast(e.message, true); }
  };
  $('#tkMake').onclick = async () => {
    const name = $('#tkName').value.trim();
    if (!name) return toast(T('先起个名字：以后才认得出该吊销哪一枚'), true);
    try { const r = await api('/api/me/tokens', { name, scope: $('#tkScope').value, days: $('#tkDays').value === '' ? null : Number($('#tkDays').value) }); tokNew = { name, plaintext: r.plaintext, expiresAt: r.expiresAt }; renderSessions(); } catch (e) { toast(e.message, true); }
  };
  if ($('#tkNewClose')) $('#tkNewClose').onclick = () => { tokNew = null; renderSessions(); };
}
