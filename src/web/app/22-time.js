// ── 时间与日历：自己的时区；部署时区与节假日（管理员改，所有人看） ──
const TZ_NAMES = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles']; } })();
const BROWSER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })();
/** 某时区此刻相对 UTC 的分钟数（页面只用 Intl） */
const tzOffsetMin = (tz, at = Date.now()) => {
  try {
    const z = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-])(\d+)(?::(\d+))?/.exec(z);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  } catch { return 0; }
};
const WEEKDAYS = () => [T('周日'), T('周一'), T('周二'), T('周三'), T('周四'), T('周五'), T('周六')];

async function renderTimeCard() {
  const box = $('#timeCard');
  let c;
  try { [c] = await Promise.all([api('/api/calendar'), loadMe()]); } catch (e) { box.innerHTML = `<div class="small bad">${esc(e.message)}</div>`; return; }
  const lead = me?.role === 'lead';
  const own = me?.ownTz ?? '';
  // 自己设的（或跟的部署时区）和这台电脑差了几个小时：多半是设错了，或人在外地 —— 说一声
  const gapMin = BROWSER_TZ ? Math.abs(tzOffsetMin(BROWSER_TZ) - tzOffsetMin(me?.tz ?? c.tz)) : 0;
  const gap = gapMin ? String(Math.round(gapMin / 6) / 10) : '';
  const upcoming = c.upcoming.map((d) => `<div class="small"><span class="mono">${esc(d.day)}</span> ${esc(WEEKDAYS()[d.weekday])} · ${d.work ? `<b>${T('上班')}</b>` : T('放假')}${d.name ? ` · ${esc(d.name)}` : ''}</div>`).join('');
  box.innerHTML = `
    <datalist id="tzList">${TZ_NAMES.map((z) => `<option value="${esc(z)}">`).join('')}</datalist>
    <h3 id="tmOwnH">${T('你的时区')}</h3>
    <div class="small mute">${T('看板上记录下来的时刻（事项、日志、检查时间等）和发给你的推送里的时刻按这个时区显示，都标了时区。它也决定你的工作时间（不紧急的推送只在这段时间里发）和状态报告几点推；超时怎么算不受它影响。值班交接的钟点、代班与节假日的日期按部署时区定，照部署时区写（标着 UTC+8 这样的偏移）。提交记录与 PR 里的时间一律是 UTC。')}</div>
    <div class="row small" style="margin-top:6px"><input id="tmOwn" aria-labelledby="tmOwnH" list="tzList" style="width:220px" value="${esc(own)}" placeholder="${T('留空 = 跟部署时区（{tz}）', { tz: esc(c.tz) })}">
      <button id="tmOwnSave" class="small">${T('保存')}</button>${BROWSER_TZ && BROWSER_TZ !== (own || c.tz) ? ` <button id="tmOwnBrowser" class="small">${T('用这台电脑的时区（{tz}，{off}）', { tz: esc(BROWSER_TZ), off: esc(fmtWhen(Date.now(), { date: false, time: true, tz: BROWSER_TZ }).split(' ')[1] ?? '') })}</button>` : ''}${own ? ` <button id="tmOwnDeploy" class="small">${T('跟部署时区（{tz}）', { tz: esc(c.tz) })}</button>` : ''}</div>
    <div class="small mute">${T('现在显示用的是：{tz}', { tz: esc(me?.tz ?? c.tz) })}</div>
    ${gap ? `<div class="small" style="color:var(--wait)">${T('这台电脑的时区是 {b}，和上面显示用的 {tz} 差 {h} 小时。你人不在 {tz} 的话，点「用这台电脑的时区」改过来。', { b: esc(BROWSER_TZ), tz: esc(me?.tz ?? c.tz), h: esc(gap) })}</div>` : ''}

    <h3 id="tmDeployH" style="margin-top:16px">${T('部署时区')}</h3>
    <div class="small mute">${T('整个部署按这个时区算：路由表里超时时间写「1bd」（一个工作日）时什么时候算超时、值班表几点交接、月度预算哪天翻篇。「1bd」= 下一个工作日的同一钟点：周五 15:00 发出的事项，下周一 15:00 超时；周六发出的也是下周一同一钟点。')}</div>
    <div class="small" style="margin-top:6px">${c.set ? T('现在是 <b>{tz}</b>（那里此刻 {now}）。', { tz: esc(c.tz), now: esc(c.now) }) : T('<b>没设</b>，按 UTC 算（此刻 {now}）。服务器本机的时区是 {sys}。', { now: esc(c.now), sys: esc(c.systemTz) })}</div>
    ${lead ? `<div class="row small" style="margin-top:6px"><input id="tmDeploy" aria-labelledby="tmDeployH" list="tzList" style="width:220px" value="${c.set ? esc(c.tz) : ''}" placeholder="${T('如 Asia/Shanghai；留空 = UTC')}"> <button id="tmDeploySave" class="small">${T('保存')}</button></div>
    <div class="small mute">${T('改了之后：已经算好的超时时刻不变，之后新算的按新时区；代班与节假日写的日期不变，按新时区的日子算。值班表的起点存的是一个确定的时刻，改时区不会挪动它，只是钟点换个写法（例如北京时间 09:00 在 UTC 下写成 01:00），交接仍在那一刻；想按新时区的某个整点交接，到决策路由里重设起点。')}</div>` : `<div class="small mute">${T('只有管理员能改。')}</div>`}

    <h3 id="tmHolH" style="margin-top:16px">${T('节假日与调休')}</h3>
    <div class="small mute">${T('「1bd」跳过周末和这里写的放假日；写了「班」的日子（调休补班）周末也算工作日。值班表不受影响（放假也有人值班）。保存后新算的超时时刻按新表，已经算好的不变。')}</div>
    ${c.holidays ? (c.holidaysUntil ? `<div class="small" style="margin-top:6px">${T('排到 {last}（表里最后一天）；那以后的日子还没排，按平常算（只跳过周末）。', { last: esc(c.holidaysUntil) })}</div>` : '') : `<div class="small" style="margin-top:6px">${T('还没有：只跳过周末。')}</div>`}
    ${c.holidaysUntil && c.holidaysUntil < c.today ? `<div class="small" style="color:var(--wait)">${T('表里最后一天已经过去了：之后的节假日都会当成工作日。把明年的补上。')}</div>` : ''}
    ${lead ? `<textarea id="tmHol" aria-labelledby="tmHolH" rows="8" style="width:100%;margin-top:6px;font-family:var(--mono, monospace)" placeholder="${T('2026-10-01..2026-10-07 国庆\n2026-10-11 班 国庆调休\n2027-01-01 元旦')}">${esc(c.holidays)}</textarea>
    <div class="small mute">${T('一行一条：一个日期或「起..止」（也可以写 ~），后面可跟名字；补班的日子加一个「班」字。# 之后是注释。一段最多 62 天。')}</div>
    <div class="row small" style="margin-top:6px"><button id="tmHolSave" class="small primary">${T('保存节假日表')}</button></div>`
    : c.holidays ? `<details class="small" style="margin-top:6px"><summary>${T('看原文')}</summary><pre style="white-space:pre-wrap">${esc(c.holidays)}</pre></details>` : ''}
    <div style="margin-top:10px"><b class="small">${T('接下来 120 天里与平常不同的日子')}</b>${upcoming || `<div class="small mute">${T('没有：都是周一到周五上班。')}</div>`}
      ${c.ending ? `<div class="small" style="color:var(--wait)">${T('节假日表只排到 {last}，还剩 {n} 天：那以后的放假日「1bd」会当工作日算。安排出来后补上。', { last: esc(c.holidaysUntil), n: esc(c.daysLeft) })}</div>` : ''}</div>`;

  const saveOwn = async (tz) => {
    try { const r = await api('/api/me/tz', { tz }); VIEW_TZ = r.tz; toast(T('已保存')); await renderTimeCard(); } catch (e) { toast(e.message, true); }
  };
  $('#tmOwnSave').onclick = () => saveOwn($('#tmOwn').value.trim());
  if ($('#tmOwnBrowser')) $('#tmOwnBrowser').onclick = () => saveOwn(BROWSER_TZ);
  if ($('#tmOwnDeploy')) $('#tmOwnDeploy').onclick = () => saveOwn('');
  const setting = async (key, value, done) => {
    try { const r = await api('/api/users', { action: 'setting', key, value }); usersData = usersFrom(r); toast(done); await loadMe(); await renderTimeCard(); } catch (e) { toast(e.message, true); }
  };
  if ($('#tmDeploySave')) $('#tmDeploySave').onclick = () => {
    const v = $('#tmDeploy').value.trim();
    if (v !== (c.set ? c.tz : '') && !confirm(T('把部署时区从 {from} 改成 {to}？之后新算的「1bd」超时时刻、值班交接的钟点写法、月度预算哪天翻篇都按新时区。', { from: c.set ? c.tz : T('UTC（没设）'), to: v || T('UTC（没设）') }))) return;
    void setting('deploy.timezone', v, T('部署时区已保存'));
  };
  if ($('#tmHolSave')) $('#tmHolSave').onclick = () => setting('deploy.holidays', $('#tmHol').value, T('节假日表已保存'));
}
