// ── 操作 ─────────────────────────────────────────────────────────────────
$('#btnRun').onclick = () => act('run', {}, T('已开始运行'));
$('#btnPause').onclick = () => act('pause', {}, T('已暂停'));
$('#btnResume').onclick = () => act('resume', {}, daemonOn ? T('已继续') : T('已继续；点击「运行」以继续执行'));
$('#btnAbort').onclick = () => { const why = prompt(T('中止会立即停下这个任务。中止原因（可选）；以后可以恢复')); if (why !== null) act('abort', { why }, T('已中止；可随时恢复')); };
$('#btnReopen').onclick = () => act('reopen', {}, daemonOn ? Tc('task', '已恢复') : T('已恢复；点击「运行」以继续执行'));
$('#btnRename').onclick = () => { const title = prompt(T('新标题'), detail?.task?.title ?? ''); if (title !== null && title.trim()) act('rename', { title }, T('标题已修改')); };
$('#btnArchive').onclick = () => act('archive', { archived: !detail?.task?.archived_at }, detail?.task?.archived_at ? T('已取消归档') : T('已归档'));
$('#btnSignoffOk').onclick = () => act('signoff', { accept: true }, T('签收已记录')).then((r) => { if (r?.result?.accepted === null) toast(r.result.note); });
$('#btnSignoffNo').onclick = () => { const reason = prompt(T('打回理由（系统将据此重新规划）')); if (reason) act('signoff', { accept: false, reason }, T('已打回。AI 会按你的理由修改，改好了重新请你签收（不用做别的，等通知）')).then((r) => { if (r?.result?.accepted === null) toast(r.result.note); }); };
$('#btnDeliver').onclick = async () => { const remote = prompt(T('远端仓库 URL（首次必填；之后留空则沿用上次的值）')) ?? null; if (remote === null) return;
  if (remote.trim() && !(await deliverPreflight(remote.trim()))) return;
  // PR 只有 GitHub 开得了；留空沿用上次的远端时不知道是哪儿，照旧问一句
  const pr = remote.trim() && !/github\.com[/:]/i.test(remote) ? false : confirm(T('同时创建 PR？\n\n取消 = 照样交付，只推送分支，不开 PR。'));
  // 开 PR 与授权 AI 跟进分开问（认知走查第三轮：捆在一个框里，想开 PR 又不想授权就没得选）。已经开着 PR 的再交付，沿用当时的选择
  const autofix = pr && !detail?.pr ? confirm(autofixAsk()) : true;
  if (!cur) return;
  try { await withHookAck((hookAck) => api(`/api/tasks/${cur}/deliver`, { remote: remote || null, pr, autofix, hookAck })); toast(T('已交付')); await refresh(); } catch (e) { toast(e.message, true); } };
// 补充信息不分紧急（执行中途就送到），选它时「紧急」灰掉、取消勾选 —— 免得勾了以为它会更快
const syncUrgent = () => { const ctx = $('#sayKind').value === 'context'; $('#sayUrgent').disabled = ctx; if (ctx) $('#sayUrgent').checked = false; };
$('#sayKind').addEventListener('change', syncUrgent);
$('#btnSay').onclick = () => { const body = $('#sayBody').value.trim(); if (!body) return toast(T('内容不能为空'), true);
  const kind = me?.role === 'observer' ? 'context' : $('#sayKind').value;
  const about = $('#sayAbout').value;
  act('say', { body, ...(kind ? { kind } : {}), ...(about ? { about } : {}), urgent: $('#sayUrgent').checked }, (r) => (r?.result?.appended ? T('这个任务已经合并，不会再改了：你这句话已作为一条新需求记在你名下（和项目页「添加任务」一样）{queued}，系统会起草方案请相关的人批', { queued: r.result.append?.queued ? T('，排在正在进行的那一轮后面') : '' }) : r?.result?.appendError ?? T('已发送'))).then((r) => {
    if (r?.result?.questionId && r.result.kind === 'answer') {
      $('#sayAnswer').innerHTML = `<div class="item flag"><div class="small mute">${T('此消息可能是对「{question}」的回答。是否作为正式答复提交？', { question: esc(detail.questions.find((q) => q.id === r.result.questionId)?.text.split('\n')[0] ?? r.result.questionId) })}</div>
        <div class="row"><button id="sayToAnswer" class="primary">${T('作为答复')}</button></div></div>`;
      $('#sayToAnswer').onclick = () => { act('answer', { questionId: r.result.questionId, body }, T('已答复')); $('#sayAnswer').innerHTML = ''; $('#sayBody').value = ''; };
    } else { $('#sayBody').value = ''; $('#sayAnswer').innerHTML = ''; }
  }); };
// 新建：项目是唯一容器。目标 + 完成定义必填；不勾"规划" → 第一个任务从目标起草（先澄清）；勾了 → 规划器整批拆。
let repoList = [];
async function loadRepos() {
  try { repoList = (await api('/api/repos')).repos; } catch { repoList = []; }
  const last = (() => { try { return localStorage.getItem('si_repo') || ''; } catch { return ''; } })();
  const opts = repoList.map((r) => `<option value="${esc(r.source)}"${r.source === last ? ' selected' : ''}${r.ok ? '' : ' disabled'}>${esc(r.source)}${r.ok ? '' : T('（路径已不存在）')}</option>`).join('');
  $('#newRepo').innerHTML = `${repoList.length ? `<optgroup label="${T('最近用过')}">${opts}</optgroup>` : ''}<option value="__new"${!repoList.length || last === '__new' ? ' selected' : ''}>${T('新建空仓库')}</option><option value="__other">${T('其他：输入路径或 URL…')}</option>`;
  syncNewForm();
}
function syncNewForm() {
  const plan = $('#newIsPlan').checked, v = $('#newRepo').value;
  $('#newRepoPath').classList.toggle('hide', v !== '__other');
  $('#newBase').classList.toggle('hide', v === '__new');
  $('#newPlanRow').classList.toggle('hide', !plan);
  $('#newParallelRow').classList.toggle('hide', !plan);
  // 可见性在建的时候就定：原来只能建好再去项目设置改，这之间标题、目标、动态全员都看得到。只有自己一个人的看板不显示
  const many = (me?.users ?? []).filter((u) => !u.disabled_at).length >= 2;
  $('#newVisRow').classList.toggle('hide', !many);
  $('#newVisHelp').classList.toggle('hide', !many || $('#newVis').value !== 'members');
  $('#newHelp').textContent = plan && $('#newParallel').checked ? T('系统先起草一个骨架任务定下接口与共享路径（接口文件、根依赖清单等），再把各模块切成可以同时开发的任务；你批准一次后开始执行，骨架合并后各模块同时开工，每个任务做完你签收一次。')
    : plan ? T('系统把这份规划拆成多个任务，起草整批方案；你批准一次后开始执行，各任务逐个签收。')
    : T('写明项目目标与完成定义。系统据此起草第一个任务：先提问澄清，再出方案，你批准后才开始执行。一次性的小活就是只有一个任务的项目；之后随时可以在项目页添加任务。');
}
$('#newRepo').onchange = syncNewForm; $('#newIsPlan').onchange = syncNewForm; $('#newParallel').onchange = syncNewForm; $('#newVis').onchange = syncNewForm;   // 只切说明，方向键浏览时跟着切无妨
$('#btnCreate').onclick = async () => {
  const goal = $('#newGoal').value.trim(), doneDefinition = $('#newDone').value.trim();
  if (!goal) return toast(T('请填写项目目标'), true);
  if (!doneDefinition) return toast(T('请填写完成定义：怎样算做完'), true);
  const plan = $('#newIsPlan').checked, v = $('#newRepo').value;
  const planText = $('#newText').value.trim();
  if (plan && !planText) return toast(T('已勾选「这是一份已写好的规划」，请粘贴规划全文'), true);
  const empty = v === '__new';
  const source = empty ? '' : v === '__other' ? $('#newRepoPath').value.trim() : v;
  if (v === '__other' && !source) return toast(T('请填写仓库路径或 URL'), true);
  try {
    const r = await api('/api/projects', { goal, doneDefinition, ...(plan ? { plan: planText, parallel: $('#newParallel').checked } : {}), source, empty, base: $('#newBase').value.trim(), title: $('#newTitle').value.trim(), visibility: $('#newVis').value });
    try { localStorage.setItem('si_repo', v === '__other' ? source : v); } catch { /* 隐私窗口 */ }
    toast(T('项目已创建'));
    for (const id of ['#newGoal', '#newDone', '#newText', '#newTitle', '#newRepoPath', '#newBase']) $(id).value = '';
    $('#newIsPlan').checked = false; $('#newParallel').checked = false; $('#newVis').value = 'all'; syncNewForm();
    $('#newWrap').classList.add('hide'); await loadTasks(); location.hash = r.result.firstTaskId;
  } catch (e) { toast(e.message, true); }
};
$('#btnLog').onclick = async () => { const pre = $('#log'); if (!pre.hidden) { pre.hidden = true; return; } const r = await api(`/api/tasks/${cur}/log`); pre.textContent = r.tail || T('（暂无日志）'); pre.hidden = false; };
// 界面语言：记在这台浏览器上（cookie，服务端出页面时读），登录了也记到自己名下（换台电脑照样是这个语言）
$('#langSel').value = I18N.lang;
onPick($('#langSel'), async () => {
  const l = $('#langSel').value;
  document.cookie = `si_lang=${l}; path=/; max-age=31536000; samesite=strict`;
  try { if (me) await api('/api/me/lang', { lang: l }); } catch { /* 没登录也照样切：页面语言看 cookie */ }
  location.reload();
});
$('#btnToken').onclick = async () => { const t = prompt(T('输入令牌（留空则使用本机默认身份）')); if (t === null) return; if (t.trim()) localStorage.setItem('si_token', t.trim()); else localStorage.removeItem('si_token'); await loadMe(); await route(); };

function connect() {
  const es = new EventSource('/api/events');
  let dropped = false;
  es.onopen = () => {
    $('#live').textContent = T('● 已连接'); $('#live').style.color = 'var(--ok)';
    // 断线期间发生的变化没有推过来：重连后整页刷一次，不等下一条变化
    if (dropped) { dropped = false; clearTimeout(refreshTimer); refreshTimer = setTimeout(async () => { await loadTasks(); await refresh(); }, 300); }
  };
  es.onerror = () => { dropped = true; $('#live').textContent = T('● 已断开，正在重连'); $('#live').style.color = 'var(--bad)'; };
  // 令牌被吊销 / 人被停用：服务端发 revoked 后断开。不再重连，回到登录（本机模式下提示换身份）
  es.addEventListener('revoked', () => {
    es.close();
    $('#live').textContent = T('● 身份已失效'); $('#live').style.color = 'var(--bad)';
    if (teamMode) showLogin();
  });
  // 构建号：服务端换了代码、这个页面还是旧的 → 提示刷新
  es.addEventListener('hello', (e) => { try { checkBuild(JSON.parse(e.data).build); } catch { /* 老服务端没有 build */ } });
  es.addEventListener('change', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(async () => { const fk = focusKey(document.activeElement); await loadTasks(); await refresh(); if (!$('#log').hidden) $('#btnLog').onclick(), $('#btnLog').onclick(); restoreFocus(fk); }, 300); });
}
