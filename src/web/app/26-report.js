// ── 状态报告：看板随时看；「你不在时」 ──
// 报告从服务端现算（/api/report）；这里只排版。时段、范围、详略在页面上选，记在本机（只影响这台浏览器）。

let REPORT = { span: '7d', scope: 'mine', detail: 'summary', from: null, to: null };
try { Object.assign(REPORT, JSON.parse(localStorage.getItem('si.report') || '{}'), { from: null, to: null }); } catch { /* 读不到就用默认 */ }
let AWAY = null;

const reportSpan = () => {
  const now = Date.now();
  if (REPORT.from && REPORT.to) return { since: REPORT.from, until: REPORT.to };
  if (REPORT.span === '24h') return { since: now - 864e5, until: now };
  if (REPORT.span === '30d') return { since: now - 30 * 864e5, until: now };
  if (REPORT.span === 'lastmonth') return { span: 'lastmonth' };   // 自然月按你的时区，服务端算
  return { since: now - 7 * 864e5, until: now };
};

/** 一条的链接：事项 → 快速答复；任务 → 任务页；项目 → 项目页。 */
const reportHref = (x) => (x.ref && /^q_/.test(x.ref) ? `#q/${encodeURIComponent(x.ref)}` : x.taskId ? `#${encodeURIComponent(x.taskId)}` : x.projectId ? `#p/${encodeURIComponent(x.projectId)}` : null);
const reportItem = (x, prefix = '') => {
  const href = reportHref(x);
  const t = `${prefix}${esc(x.title)}`;
  return `<li><span class="mute">${esc(fmtWhen(x.at))}</span> ${href ? `<a href="${href}">${t}</a>` : t}</li>`;
};
const reportList = (rows, detail, prefix) => {
  const cap = detail === 'full' ? Infinity : 5;
  return `<ul class="small" style="margin:4px 0 0 0;padding-left:18px">${rows.slice(0, cap).map((x) => reportItem(x, prefix)).join('')}${rows.length > cap
    ? `<li class="mute">${T('另有 {n} 条：详略选「详细」看全部', { n: rows.length - cap })}</li>` : ''}</ul>`;
};
const reportUsd = (micro) => `$${(Number(micro || 0) / 1e6).toFixed(2)}`;

async function renderReport() {
  const box = $('#reportOut'); if (!box) return;
  const admin = me?.role === 'lead';
  if (!admin) REPORT.scope = 'mine';
  const custom = REPORT.from && REPORT.to;
  $('#reportCtl').innerHTML = `<div class="row small" style="gap:8px;flex-wrap:wrap">
      <label>${T('时段')} <select id="rpSpan" style="width:auto">
        ${custom ? `<option value="custom" selected>${esc(T('你不在时：{from} – {to}', { from: fmtWhen(REPORT.from), to: fmtWhen(REPORT.to) }))}</option>` : ''}
        ${[['24h', T('最近 24 小时')], ['7d', T('最近 7 天')], ['30d', T('最近 30 天')], ['lastmonth', T('上个月')]].map(([v, n]) => `<option value="${esc(v)}"${!custom && REPORT.span === v ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      ${admin ? `<label>${T('范围')} <select id="rpScope" style="width:auto"><option value="mine"${REPORT.scope === 'mine' ? ' selected' : ''}>${T('与我有关的')}</option><option value="all"${REPORT.scope === 'all' ? ' selected' : ''}>${T('全部项目')}</option></select></label>` : ''}
      <label>${T('详略')} <select id="rpDetail" style="width:auto">${[['exceptions', T('只报异常')], ['summary', T('摘要')], ['full', T('详细')]].map(([v, n]) => `<option value="${esc(v)}"${REPORT.detail === v ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      <span class="grow"></span>${me?.role !== 'observer' ? `<a href="#settings/notify" class="small">${T('定期推送的设置')}</a>` : ''}</div>`;
  const save = () => { try { localStorage.setItem('si.report', JSON.stringify({ span: REPORT.span, scope: REPORT.scope, detail: REPORT.detail })); } catch { /* 存不了就算了 */ } };
  $('#rpSpan').onchange = () => { const v = $('#rpSpan').value; if (v !== 'custom') { REPORT.span = v; REPORT.from = REPORT.to = null; if (location.hash !== '#report') history.replaceState(null, '', '#report'); } save(); void renderReport(); };
  if ($('#rpScope')) $('#rpScope').onchange = () => { REPORT.scope = $('#rpScope').value; save(); void renderReport(); };
  $('#rpDetail').onchange = () => { REPORT.detail = $('#rpDetail').value; save(); void renderReport(); };

  const sp = reportSpan();
  const span = sp.span ? `span=${sp.span}` : `since=${sp.since}&until=${sp.until}`;
  let v;
  try { v = await api(`/api/report?${span}&scope=${REPORT.scope}&detail=${REPORT.detail}`); }
  catch (e) { box.innerHTML = `<div class="small bad">${esc(e.message)}</div>`; return; }
  const r = v.report, d = REPORT.detail;
  const h3 = (t) => `<h3 style="font-size:14px;margin:14px 0 2px">${t}</h3>`;
  let html = h3(T('① 出事了没有'));
  html += r.quiet ? `<div class="small ok">${T('这段时间没有出事。')}</div>`
    : `<div class="small">${T('出了 {n} 件事：', { n: r.exceptions.length + r.limitHits.length })}</div>${reportList([...r.exceptions, ...r.limitHits.map((x) => ({ ...x, limit: true }))].sort((a, b) => a.at - b.at), d, '')}`;
  html += `<div class="small mute" style="margin-top:4px">${T('算作「出事」的：部署出故障、安全边界被系统改了、任务做不下去（硬失败）、项目停下来、超时链卡住、触到花费或次数上限。')}</div>`;
  if (d !== 'exceptions') {
    html += h3(r.scope === 'all' ? T('② 没等人拍板就定下的') : T('② 没等你拍板就定下的'));
    html += !r.decided.length ? `<div class="small mute">${T('没有。')}</div>`
      : r.decided.map((g) => `<div class="small" style="margin-top:6px"><b>${esc(g.label)}</b> ${esc(T('{n} 条', { n: g.n }))}${g.record ? ` <span class="mute">${esc(T('（其中 {n} 条你调成了备案，没推送过）', { n: g.record }))}</span>` : ''}</div>${reportList(g.items, d, '')}`).join('');
    html += h3(T('③ 进展'));
    html += !r.merged.length && !r.progress.length ? `<div class="small mute">${T('没有。')}</div>` : '';
    if (r.merged.length) html += `<div class="small">${T('合并了 {n} 个任务', { n: r.merged.length })}</div>${reportList(r.merged, d, '')}`;
    if (r.progress.length) html += reportList(r.progress, d, '');
    html += h3(T('④ 花费与还等你的'));
    html += `<div class="small">${T('这段时间花了 {usd}', { usd: reportUsd(r.spend.total) })}${r.spend.byProject.length ? `${T('：')}${r.spend.byProject.map((p) => `${p.projectId ? `<a href="#p/${esc(p.projectId)}">${esc(p.title)}</a>` : esc(T('独立任务'))} ${reportUsd(p.micro)}`).join(T('，'))}` : ''}</div>`;
    html += `<div class="small">${r.spend.budget != null ? T('你本月花了 {usd}，预算 {budget}', { usd: reportUsd(r.spend.month), budget: reportUsd(r.spend.budget) }) : T('你本月花了 {usd}（没设预算）', { usd: reportUsd(r.spend.month) })}</div>`;
  }
  html += `<div class="small" style="margin-top:6px">${r.waiting ? `${esc(T('还有 {n} 件等你答：', { n: r.waiting }))}<a href="#inbox">${T('收件箱')}</a>` : T('没有等你答的事。')}</div>`;
  box.innerHTML = `<div class="small mute">${esc(r.scope === 'all' ? T('全部项目') : T('与你有关的'))} · ${esc(fmtWhen(r.since))} – ${esc(fmtWhen(r.until))}</div>${html}`;
}

// 「你不在时」：页面可见、人有操作时报一次「在看」（最多一分钟一次）；SSE 触发的自动刷新不算
let seenSent = 0;
async function noteSeenNow(force = false) {
  if (!me || document.visibilityState !== 'visible') return;
  if (!force && Date.now() - seenSent < 60_000) return;
  seenSent = Date.now();
  try { AWAY = (await api('/api/me/seen', {})).away; } catch { return; }
  renderAway();
}
function renderAway() {
  const box = $('#awayBar'); if (!box) return;
  const a = AWAY;
  box.classList.toggle('hide', !a);
  if (!a) { box.innerHTML = ''; return; }
  const hours = Math.round((a.to - a.from) / 36e5);
  const bits = [a.quiet ? T('没有出事') : T('出了 {n} 件事', { n: a.exceptions })];
  bits.push(a.decided ? T('没等你拍板就定下的 {n} 条', { n: a.decided }) + (a.record ? T('（其中 {n} 条你调成了备案，没推送过）', { n: a.record }) : '') : T('没有替你定下的事'));
  bits.push(T('合并了 {n} 个任务', { n: a.merged }));
  bits.push(a.waiting ? T('还有 {n} 件等你答', { n: a.waiting }) : T('没有等你答的事'));
  box.innerHTML = `<div class="small"><b>${T('你不在时')}</b> <span class="mute">${esc(fmtWhen(a.from))} – ${esc(fmtWhen(a.to))}${T('（约 {n} 小时）', { n: hours })}</span></div>
    <div class="small" style="margin-top:4px">${bits.map(esc).join(T('；'))}${T('。')}</div>
    <div class="row small" style="gap:8px;flex-wrap:wrap;align-items:baseline;margin-top:4px">
      <a href="#report/${esc(a.from)}-${esc(a.to)}">${T('看这段时间的状态报告')}</a><span class="grow"></span>
      <span class="mute">${T('关掉只是收起这条，等你答的照样在下面的收件箱里。')}</span><button id="awayOk" class="small">${T('关掉这条提示')}</button></div>`;
  $('#awayOk').onclick = async () => { AWAY = null; renderAway(); try { await api('/api/me/away/dismiss', {}); } catch { /* 下次再关 */ } };
}
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => void noteSeenNow(), { passive: true }));
document.addEventListener('visibilitychange', () => void noteSeenNow());
