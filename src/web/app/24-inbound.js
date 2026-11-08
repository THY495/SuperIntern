// ── 入站：「项目设置 → Issue 与定时任务」 ─────────────────────────────
// 两种从项目外面来的需求，都变成「添加任务」的一轮（起草 → 批准 → 开工），和人在项目页点「添加任务」同一道门。
// 先说"开着没有、会发生什么"，再给改的地方；改只有负责人能改，别人只看。

// 周一排最前（WEEKDAYS 在 22-time.js，下标 0 = 周日）
const SC_WEEKDAYS = () => [1, 2, 3, 4, 5, 6, 0].map((v) => [v, WEEKDAYS()[v]]);
// 表单 ↔ cron：常见的三种用下拉选，别的写 cron
function cronOf(f) {
  const [h, m] = (f.time || '09:00').split(':').map((x) => String(Number(x)));
  if (f.freq === 'daily') return `${m} ${h} * * *`;
  if (f.freq === 'weekly') return `${m} ${h} * * ${f.wd}`;
  if (f.freq === 'monthly') return `${m} ${h} ${f.dom} * *`;
  return f.cron.trim();
}
function formOfCron(cron) {
  const x = /^(\d+) (\d+) (\*|\d+) \* (\*|[0-7])$/.exec(String(cron ?? '').trim());
  const time = x ? `${x[2].padStart(2, '0')}:${x[1].padStart(2, '0')}` : '09:00';
  if (x && x[3] === '*' && x[4] === '*') return { freq: 'daily', time, wd: 1, dom: 1, cron };
  if (x && x[3] === '*') return { freq: 'weekly', time, wd: Number(x[4]) % 7, dom: 1, cron };
  if (x && x[4] === '*' && Number(x[3]) <= 28) return { freq: 'monthly', time, wd: 1, dom: Number(x[3]), cron };
  return { freq: cron ? 'cron' : 'weekly', time, wd: 1, dom: 1, cron: cron ?? '' };
}

async function renderPsInbound(p) {
  const box = $('#psInbound'); if (!box) return;
  let d; try { d = await api(`/api/projects/${p.id}/inbound`); } catch (e) { box.innerHTML = `<span class="bad small">${esc(e.message)}</span>`; return; }
  const edit = d.canEdit;
  const post = async (body, ok) => { try { await api(`/api/projects/${p.id}/inbound`, body); if (ok) toast(ok); } catch (e) { toast(e.message, true); } renderPsInbound(p); };
  const iss = d.issues, st = d.state;
  const on = !!iss?.on;
  const whoSet = (id, name) => (me && id === me.id ? T('你') : esc(name ?? ''));

  // ① GitHub issue
  const stLine = !on ? `<div class="small mute">${T('没开。')}</div>`
    : `<div class="small">${T('开着：{repo} 上带「{label}」标签、开着的 issue，每条起草一轮「添加任务」。{who}开的。', { repo: `<a href="https://github.com/${esc(iss.repo)}/issues?q=is%3Aopen+label%3A${encodeURIComponent(iss.label)}" target="_blank" rel="noopener" class="mono">${esc(iss.repo)}</a>`, label: `<span class="mono">${esc(iss.label)}</span>`, who: whoSet(iss.by, iss.byName) })}</div>`
      + (st?.error ? `<div class="small bad" style="margin-top:4px">${esc(T(st.error.msg, st.error.params ?? {}))}</div>`
        : st ? `<div class="small mute" style="margin-top:4px">${T('{t}前看过：开着、带这个标签的有 {n} 条。每 5 分钟看一次（自动运行开着的时候）。', { t: esc(ago(st.at)), n: esc(st.open ?? 0) })}</div>`
        : `<div class="small mute" style="margin-top:4px">${T('还没看过。')}</div>`)
      + `<div class="small mute" style="margin-top:4px">${T('同时最多 {batch} 条在路上 —— 起草中、等你批、排着等起草的都算（现在 {n} 条）；多出来的等前面的批准或放弃之后再起草。', { batch: esc(d.batch), n: esc(d.inFlight) })}</div>`;
  const rules = `<ul class="small" style="margin:6px 0 0 18px">
      <li>${T('issue 是项目外面的人写的：起草时当需求描述看，不当指令；草案<b>一律要你批</b>（项目开了自动挡也一样），批准事项里带 issue 链接。')}</li>
      <li>${T('作者对得上这个项目里的人，做完的任务记在他名下（签收找他）；对不上的记在开这个入口的人名下。')}</li>
      <li>${T('只读 GitHub：不回帖、不改标签。已经起草出来、不想要的：在那条批准事项里回「放弃」（同一条 issue 不会再起草）；还排着没起草的：到 GitHub 上关掉 issue 或摘掉标签，下次看的时候就从队里拿掉。')}</li>
      <li>${T('谁能触发：GitHub 上只有有分类（triage）以上权限的人能给 issue 打标签。别把这个标签写进 issue 模板，不然谁开 issue 都会自动带上。每起草一轮要花一次模型调用的钱，算在项目预算里。')}</li></ul>`;
  const form = edit ? `<div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap">
      <label class="small" for="ibRepo">${T('仓库')}</label><input id="ibRepo" placeholder="owner/repo" value="${esc(iss?.repo ?? '')}" style="width:16em">
      <label class="small" for="ibLabel">${T('标签')}</label><input id="ibLabel" placeholder="superintern" value="${esc(iss?.label ?? '')}" style="width:10em">
      <button id="ibSave" class="${on ? '' : 'primary'}">${on ? T('保存仓库和标签') : T('打开')}</button>
      ${on ? `<button id="ibOff" class="ghost">${T('停用这个入口')}</button><button id="ibPoll" class="ghost">${T('立即看一次')}</button>` : ''}</div>
      <div class="small mute" style="margin-top:4px">${T('读 issue 用的是「设置 → 连接」里的 GitHub App（或部署级令牌），App 要有 Issues 的读权限。')}</div>` : '';
  const seen = d.seen.length ? `<details style="margin-top:8px"><summary class="small">${T('最近的 issue（{n}）', { n: esc(d.seen.length) })}</summary>
      ${d.seen.map((x) => `<div class="small" style="margin-top:4px"><a href="https://github.com/${esc(iss?.repo ?? '')}/issues/${esc(x.number)}" target="_blank" rel="noopener">#${esc(x.number)}</a> ${esc(x.title ?? '')} <span class="mute">· ${x.skipped ? T('没起草：{why}', { why: esc(x.skipped) }) : x.dropped ? T('排着的时候 issue 关了或摘了标签，没起草') : x.queued ? T('排着，等前面的批准或放弃') : T('起草了一轮（批准事项在项目页）')} · ${T('{t}前', { t: esc(ago(x.at)) })}</span></div>`).join('')}</details>` : '';

  // ② 定时任务
  const runText = (r) => !r ? T('还没到过点')
    : r.result === 'skipped' ? `<span style="color:var(--wait)">${T('{t}前到点，没起草：{why}', { t: esc(ago(r.last)), why: esc(r.why ?? '') })}</span>`
    : r.result === 'queued' ? T('{t}前到点，排队起草', { t: esc(ago(r.last)) }) : T('{t}前到点，起草了一轮', { t: esc(ago(r.last)) });
  const schedRow = (s) => `<div class="item${s.on ? '' : ' off'}" style="margin-top:6px">
      <div class="row"><b>${esc(s.name)}</b> <span class="small">${esc(s.when)}</span>${s.when !== s.cron ? ` <span class="small mute mono">${esc(s.cron)}</span>` : ''}<span class="grow"></span>
        ${edit ? `<button class="small ghost" data-scedit="${esc(s.id)}">${T('改')}</button><button class="small ghost" data-sctoggle="${esc(s.id)}">${s.on ? T('停用') : T('启用')}</button><button class="small ghost" data-scdel="${esc(s.id)}">${T('删除')}</button>` : ''}</div>
      <div class="small">${s.on ? T('下一次：{t}', { t: esc(fmtWhen(s.next, { tz: s.tz })) }) + (fmtWhen(s.next) !== fmtWhen(s.next, { tz: s.tz }) ? T('（你这里是 {t}）', { t: esc(fmtWhen(s.next)) }) : '') : `<span class="mute">${T('停用了，不会到点')}</span>`} <span class="mute">· ${T('上一次：')}${runText(s.last)} · ${T('{who}设的', { who: whoSet(s.by, s.byName) })}</span></div>
      <pre class="small" style="white-space:pre-wrap;margin:4px 0 0;max-height:8em;overflow:auto">${esc(s.brief)}</pre></div>`;
  const tz = d.schedules[0]?.tz ?? null;
  const schedForm = edit ? `<details id="scFormWrap" style="margin-top:10px"${d.schedules.length ? '' : ' open'}><summary class="small" id="scFormTitle">${T('加一个定时任务')}</summary>
      <input type="hidden" id="scId">
      <div style="margin-top:6px"><label class="small" for="scName">${T('名字')}</label> <input id="scName" placeholder="${T('比如：每周依赖升级')}" style="width:20em"></div>
      <div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap"><label class="small" for="scFreq">${T('什么时候')}</label>
        <select id="scFreq"><option value="daily">${T('每天')}</option><option value="weekly" selected>${T('每周')}</option><option value="monthly">${T('每月')}</option><option value="cron">${T('自定义（cron）')}</option></select>
        <select id="scWd" aria-label="${T('星期几')}">${SC_WEEKDAYS().map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join('')}</select>
        <select id="scDom" aria-label="${T('几号')}" class="hide">${[...Array(28).keys()].map((i) => `<option value="${esc(i + 1)}">${esc(T('{d} 号', { d: i + 1 }))}</option>`).join('')}</select>
        <input id="scTime" type="time" value="09:00" aria-label="${T('几点')}">
        <input id="scCron" class="hide mono" placeholder="0 9 * * 1" aria-label="cron" style="width:10em">
        ${tz ? `<span class="small mute">${T('按部署时区 {tz}（24 小时制）', { tz: esc(tz) })}<span id="scLocal"></span></span>` : ''}</div>
      <div style="margin-top:6px"><label class="small" for="scBrief">${T('每次让 AI 做什么')}</label>
        <textarea id="scBrief" rows="3" style="width:100%" placeholder="${T('像「添加任务」那样写：要做什么、做到什么程度算完')}"></textarea></div>
      <div class="row" style="margin-top:6px"><button id="scSave" class="primary">${T('保存定时任务')}</button><button id="scCancel" class="ghost hide">${T('不改了')}</button></div></details>` : '';

  const idle = !daemonOn && (on || d.schedules.some((s) => s.on))
    ? `<div class="item flag small" style="margin-top:8px">${T('自动运行没开：issue 不会去看，定时任务也不会到点。要在服务器上用 {cmd} 启动看板（或另起 {cmd2}）；开了之后才会动，定时任务错过的补一次。', { cmd: '<code>node src/cli.mjs web --daemon</code>', cmd2: '<code>node src/cli.mjs daemon</code>' })}</div>` : '';
  box.innerHTML = `<div class="small">${T('从项目外面来的需求，到了就起草一轮「添加任务」—— 和你在项目页点「添加任务」走同一道门：起草方案 → 批准 → 开工。')}</div>
    ${edit ? '' : `<div class="small mute" style="margin-top:4px">${T('只有项目负责人能改。')}</div>`}${idle}
    <h3 style="margin-top:14px">${T('GitHub issue')}</h3>${stLine}${on || edit ? rules : ''}${form}${seen}
    <h3 style="margin-top:18px">${T('定时任务')}</h3>
    <div class="small mute">${T('到点按你写的需求起草一轮。需求是你写的，所以和你自己点「添加任务」一样走挡位。上一次起草的还没批完，这一次就跳过；自动运行关着时错过的，打开后只补一次。')}</div>
    <div class="small" style="margin-top:4px">${d.gear === 'auto' ? T('这个项目现在是<b>自动挡</b>：起草好直接开工，不等你批；这些任务的签收攒到交付前一次签。') : T('这个项目现在是<b>提议挡</b>：起草好等你批，批了才开工。')}${edit ? ` <a href="#p/${esc(p.id)}/settings" data-gopane="auto">${T('改挡位')}</a>` : ''}</div>
    ${d.schedules.length ? d.schedules.map(schedRow).join('') : `<div class="small mute" style="margin-top:6px">${T('没有。')}</div>`}
    ${schedForm}`;

  if (!edit) return;
  $('#ibSave').onclick = () => post({ op: 'issues', repo: $('#ibRepo').value, label: $('#ibLabel').value, on: true }, on ? T('已保存') : T('已打开：马上看一次'));
  if ($('#ibOff')) $('#ibOff').onclick = () => post({ op: 'issues', on: false }, T('已停用：排着还没起草的也不再起草'));
  if ($('#ibPoll')) $('#ibPoll').onclick = (e) => { e.target.disabled = true; e.target.textContent = T('看中…'); post({ op: 'poll' }); };
  const syncFreq = () => { const f = $('#scFreq').value;
    $('#scWd').classList.toggle('hide', f !== 'weekly'); $('#scDom').classList.toggle('hide', f !== 'monthly');
    $('#scTime').classList.toggle('hide', f === 'cron'); $('#scCron').classList.toggle('hide', f !== 'cron'); };
  // 看的人不在部署时区：时间框旁边写换算成他那里是几点（只换钟点；跨天的写"前一天 / 后一天"）
  const tzOff = (z) => { const t = Date.now(); const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000; };
  const localHint = () => {
    const el = $('#scLocal'); if (!el || !tz) return;
    let diff; try { diff = tzOff(VIEW_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone) - tzOff(tz); } catch { diff = 0; }
    if (!diff || $('#scFreq').value === 'cron') { el.textContent = ''; return; }
    const [h, m] = ($('#scTime').value || '00:00').split(':').map(Number);
    const mins = h * 60 + m + Math.round(diff / 60000), day = Math.floor(mins / 1440), mm = ((mins % 1440) + 1440) % 1440;
    const hm = `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
    el.textContent = day < 0 ? T('，你这里是前一天 {t}', { t: hm }) : day > 0 ? T('，你这里是后一天 {t}', { t: hm }) : T('，你这里是 {t}', { t: hm });
  };
  $('#scTime').oninput = localHint;
  $('#scFreq').onchange = () => { syncFreq(); localHint(); };
  const fill = (s) => { const f = formOfCron(s?.cron);
    $('#scId').value = s?.id ?? ''; $('#scName').value = s?.name ?? ''; $('#scBrief').value = s?.brief ?? '';
    $('#scFreq').value = f.freq; $('#scWd').value = String(f.wd); $('#scDom').value = String(f.dom); $('#scTime').value = f.time; $('#scCron').value = f.cron ?? '';
    $('#scFormTitle').textContent = s ? T('改「{name}」', { name: s.name }) : T('加一个定时任务'); $('#scCancel').classList.toggle('hide', !s); syncFreq(); localHint(); };
  $('#scSave').onclick = () => {
    const cron = cronOf({ freq: $('#scFreq').value, wd: $('#scWd').value, dom: $('#scDom').value, time: $('#scTime').value, cron: $('#scCron').value });
    const id = $('#scId').value || null;
    post({ op: 'schedule', id, name: $('#scName').value, cron, brief: $('#scBrief').value, on: id ? d.schedules.find((x) => x.id === id)?.on !== false : true }, id ? T('已保存：从现在起算下一次') : T('已加上'));
  };
  $('#scCancel').onclick = () => fill(null);
  box.querySelectorAll('[data-scedit]').forEach((b) => b.onclick = () => { fill(d.schedules.find((x) => x.id === b.dataset.scedit)); $('#scFormWrap').open = true; $('#scName').focus(); });
  box.querySelectorAll('[data-sctoggle]').forEach((b) => b.onclick = () => { const s = d.schedules.find((x) => x.id === b.dataset.sctoggle);
    post({ op: 'schedule', id: s.id, on: !s.on }, s.on ? T('已停用：排着还没起草的也不再起草') : T('已启用：从现在起算下一次')); });
  box.querySelectorAll('[data-scdel]').forEach((b) => b.onclick = () => { const s = d.schedules.find((x) => x.id === b.dataset.scdel);
    if (confirm(T('删除定时任务「{name}」？已经起草出来的那几轮不受影响。', { name: s.name }))) post({ op: 'schedule_remove', id: s.id }, T('已删除')); });
  syncFreq(); localHint();
  box.querySelectorAll('[data-gopane]').forEach((a) => a.onclick = (e) => { e.preventDefault(); setPsPane(a.dataset.gopane); });
}
