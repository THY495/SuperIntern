// ── 刷新时保住正在做的事 ────────────────────────────────────────────────
// 看板随服务端的变化整块重画（别人答了一条、任务换了状态都会触发）。重画会把展开的折叠块收起、把输入框清空、
// 把焦点丢掉 —— 人正写到一半的答复、刚展开的「添加任务…」就这么没了，下一下点击还会落到挪了位置的别的按钮上。
// 所以重画前记下：哪些折叠块开着、哪些有 id 的输入框里有字、焦点和光标在哪；重画后照原样放回。
// 各块自己管状态的（改动对比、截图，见 DV_DETAILS_OPEN）不在这里重复处理。
const uiKey = (d) => {
  if (d.dataset.dvopen || d.dataset.pvopen || d.id === 'nodeDiff') return null;
  if (d.id) return `id:${d.id}`;
  const box = d.parentElement?.closest('[id]');
  const sum = d.querySelector(':scope > summary')?.textContent.trim().slice(0, 80);
  return box && sum ? `${box.id}|${sum}` : null;
};
function snapUi() {
  const open = new Set([...document.querySelectorAll('details[open]')].map(uiKey).filter(Boolean));
  const vals = new Map([...document.querySelectorAll('textarea[id], input[id]:not([type=checkbox]):not([type=radio]):not([type=hidden])')]
    .filter((e) => e.value).map((e) => [e.id, e.value]));
  const checked = new Set([...document.querySelectorAll('input[type=checkbox][data-alsocorr]:checked')].map((e) => e.dataset.alsocorr));
  const a = document.activeElement;
  const focus = a && a !== document.body ? (a.id ? `#${a.id}` : a.dataset?.q ? `textarea[data-q="${esc(a.dataset.q)}"]` : null) : null;
  return { at: location.hash, open, vals, checked, focus, sel: focus && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null };
}
function restoreUi(s) {
  if (s.at !== location.hash) return;   // 换了页面：上一页的输入不能填进这一页同名的框里（任务 A 写的话不该出现在任务 B）
  for (const d of document.querySelectorAll('details')) { const k = uiKey(d); if (k && s.open.has(k)) d.open = true; }
  for (const [id, v] of s.vals) { const e = document.getElementById(id); if (e && !e.value) e.value = v; }
  for (const qid of s.checked) { const e = document.querySelector(`input[data-alsocorr="${qid}"]`); if (e) e.checked = true; }
  if (s.focus) { const e = document.querySelector(s.focus); if (e) { e.focus(); if (s.sel) try { e.setSelectionRange(...s.sel); } catch { /* 不是文本框 */ } } }
}
// 正在写的答复（按事项记，离开任务页再回来也在）：事项被别人先答掉时，答复框会消失 ——
// 草稿留在这里，那条事项下面照实说"谁先答了"，并给出这段话还能去哪（见 renderQuestions）。
const DRAFTS = new Map();
// 刚保存过的那几处：保存后页面整块重画，提示条两秒就消失 —— 在按钮旁边留一个看得见的"已保存"，两分钟内都在
const SAVED = new Map();
const savedMark = (k) => (Date.now() - (SAVED.get(k) ?? 0) < 120_000 ? ` <span class="small" style="color:var(--ok)">✓ ${T('已保存')}</span>` : '');
/** 事项已经答不了了（别人先答、已到期、已撤回），而你在这条下面有没交出去的草稿：照实说，草稿留着，给出去处。 */
function lostDraftHtml(q, canAnswer) {
  const d = DRAFTS.get(q.id);
  if (!d?.text?.trim() || canAnswer) return '';
  if (me && q.answers.some((a) => a.userId === me.id)) { DRAFTS.delete(q.id); return ''; }   // 自己的那条已经记上了
  const firsts = [...new Set(q.answers.filter((a) => a.stance === 'answer' && a.userId && a.userId !== me?.id).map((a) => a.name))];
  const lead = isLead();
  return `<div class="item flag" style="margin-top:8px">
      <div class="small"><b>${T('你正在写的答复没有提交')}</b>${firsts.length ? T('：{who} 先答复了，这条事项已经有了结论（见上面）。你写的草稿还在：', { who: esc(firsts.join(T('、'))) }) : T('：这条事项已经结束了（见上面的状态）。你写的草稿还在：')}</div>
      <textarea data-lost="${esc(q.id)}" rows="2" style="width:100%;margin-top:4px;resize:vertical">${esc(d.text)}</textarea>
      <div class="row" style="margin-top:4px">${lead
        ? `<button data-lostcorr="${esc(q.id)}" class="primary">${T('改为发一条修正（计划变更）…')}</button>`
        : `<button data-lostlate="${esc(q.id)}" class="primary">${T('作为补充意见留下')}</button>`}<button data-lostdrop="${esc(q.id)}">${T('丢弃草稿')}</button></div>
      <div class="small mute" style="margin-top:4px">${lead
        ? T('结论定了之后，答复改不了它。要改，就发一条修正：按钮会把草稿填进下面的「发送」框、类别选好「修正」，你看过再发。修正会变成一份计划变更，碰到契约的要按决策路由批准后才生效，先答的人也看得到。')
        : T('结论不变；这段话会作为你的意见记在这条事项上，负责人和先答的人会收到通知。')}</div></div>`;
}
function bindLostDrafts() {
  const box = $('#questions');
  box.querySelectorAll('textarea[data-lost]').forEach((i) => i.addEventListener('input', () => DRAFTS.set(i.dataset.lost, { text: i.value })));
  box.querySelectorAll('[data-lostdrop]').forEach((b) => b.onclick = () => { DRAFTS.delete(b.dataset.lostdrop); renderQuestions(); });
  box.querySelectorAll('[data-lostlate]').forEach((b) => b.onclick = async () => {
    const qid = b.dataset.lostlate; const body = DRAFTS.get(qid)?.text?.trim(); if (!body) return toast(T('内容不能为空'), true);
    const r = await act('answer', { questionId: qid, body }, T('已作为补充意见留下'));
    if (r) { DRAFTS.delete(qid); renderQuestions(); if (r.result?.late && r.result.note) toast(r.result.note, false, 6000); }
  });
  box.querySelectorAll('[data-lostcorr]').forEach((b) => b.onclick = () => {
    const qid = b.dataset.lostcorr;
    $('#sayBody').value = DRAFTS.get(qid)?.text ?? ''; $('#sayKind').value = 'correction'; $('#sayAbout').value = qid;
    DRAFTS.delete(qid); renderQuestions();
    $('#sayBody').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#sayBody').focus();
    toast(T('草稿已填进「发送」框，类别是「修正」；看一眼再点「发送」'), false, 6000);
  });
}

async function refresh() {
  const ui = snapUi();
  try { await refreshInner(); } finally { restoreUi(ui); }
}
async function refreshInner() {
  if (view === 'task' && cur) {
    detail = await api(`/api/tasks/${cur}`);
    renderHeader(); renderConstitution(); renderDag(); renderPreview(); renderTaskDiff(); renderQuestions(); renderRevision(); renderActivity(); renderInbox(); renderReports(); renderLimits();
  }
  await renderDigest();   // 收件箱本身，也是侧栏上"等你"计数的来源
  renderSide(); renderCtx();
  if (view === 'project') renderProject();
  // 项目设置页不跟着 SSE 重画：它整页都是表单，重画会抹掉正在输入的内容。
  // 只在进入这一页（route）和自己的写操作之后（projAct）画，与全局设置页同一条规矩。
  if (me?.role === 'lead') { api('/api/llm').then((v) => { if (view !== 'settings' || !llm) llm = v; llmDots(); }).catch(() => {});   /* 设置页不重画，见设置区注释 */ }
}
