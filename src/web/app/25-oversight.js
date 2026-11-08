// ── 监督与审批：项目的监督模式、审批门禁；个人的通知偏好；收件箱里的「通知」 ──
// 介入方式三档：决策（停下来等人拍板，是一条待决事项）/ 通知（不停，推给相关的人）/ 备案（不停、不推，只留记录）。
// 会不会停由项目定（负责人选监督模式）；推不推给我由我自己定（只能在通知和备案之间调，底线是通知的调不了）。

const TIER_TEXT = () => ({ decide: T('决策'), notify: T('通知'), record: T('备案') });
const TIER_HELP = () => ({ decide: T('停下来等人拍板（成为一条待决事项）'), notify: T('不停，推给相关的人'), record: T('不停、不推，只留记录') });
/** 门禁命中后派给谁（服务端从路由表"安全审批"那一行取） */
const gateWho = (r) => (r?.who ?? []).map((w) => esc(w.k === 'lead' ? T('项目负责人 {name}', { name: w.name ?? '' }).trim() : w.k === 'user' ? w.name
  : w.k === 'all' ? T('所有成员') : w.k === 'tag' ? T('标签 {tag} 的成员', { tag: w.tag }) : w.k === 'duty' ? T('值班人') : T('需求提出人'))).join(T('、')) || esc(T('项目负责人'));
const sigTitle = (t) => String(t ?? '').replace(/^\[SuperIntern\]\s*/, '');

/** 项目设置 → 监督与审批。lead = 本项目负责人（能改）；其余人只读。 */
function renderPsOversight(p, lead) {
  const box = $('#psOversight'); if (!box) return;
  const o = p.oversight;
  if (!o) { box.innerHTML = ''; return; }
  const ro = !lead || p.status === 'aborted';
  const tt = TIER_TEXT();
  const modeName = (id) => T(o.modes.find((m) => m.id === id)?.label ?? id);
  const cell = (c, m) => {
    const x = c.cells[m];
    const word = x.note ? esc(T(x.note)) : esc(tt[x.tier]);
    return `<td class="small${m === o.mode ? '' : ' mute'}"${m === o.mode ? ' style="font-weight:600"' : ''}>${word}</td>`;
  };
  const sugg = (p.gateSuggestions ?? []).filter((s) => !(p.gates ?? []).includes(s.pattern));
  box.innerHTML = `
    <h3 id="ovModeH" style="margin-top:0">${T('监督模式')}</h3>
    <div class="small mute">${T('决定系统里发生的事，哪些要停下来等人拍板、哪些只推给相关的人、哪些只留记录。改了之后对之后发生的事生效。')}</div>
    <div role="radiogroup" aria-labelledby="ovModeH" style="margin-top:8px">
      ${o.modes.map((m) => `<label class="row" style="align-items:flex-start;gap:8px;margin-top:6px">
        <input type="radio" name="ovMode" value="${esc(m.id)}" style="width:auto;margin-top:3px"${o.own === m.id ? ' checked' : ''}${ro ? ' disabled' : ''}>
        <span><b>${esc(T(m.label))}</b><br><span class="small mute">${esc(T(m.blurb))}</span></span></label>`).join('')}
      <label class="row" style="align-items:flex-start;gap:8px;margin-top:6px">
        <input type="radio" name="ovMode" value="" style="width:auto;margin-top:3px"${o.own ? '' : ' checked'}${ro ? ' disabled' : ''}>
        <span><b>${T('跟部署默认')}</b><br><span class="small mute">${T('现在是「{mode}」；管理员改了部署默认，这个项目跟着变', { mode: esc(modeName(o.deployDefault)) })}</span></span></label>
    </div>
    <div class="small" style="margin-top:6px">${T('本项目现在用的是：')}<b>${esc(modeName(o.mode))}</b>${ro && !lead ? ` <span class="mute">${T('（只有项目负责人能改）')}</span>` : ''}</div>
    <details style="margin-top:10px"><summary class="small">${T('每一类事在三种模式下怎么处理')}</summary>
      <div class="small mute" style="margin-top:6px">${Object.keys(tt).map((k) => `<b>${esc(tt[k])}</b>${T('：')}${esc(TIER_HELP()[k])}`).join(T('；'))}${T('。')} ${T('标着「底线」的：任何模式、任何人的个人设置都不会低于它。')}</div>
      <table class="rt" style="margin-top:6px"><tr><th>${T('哪一类事')}</th>${o.modes.map((m) => `<th${m.id === o.mode ? ' style="font-weight:700"' : ''}>${esc(T(m.label))}</th>`).join('')}</tr>
        ${o.classes.map((c) => `<tr><td class="small">${esc(T(c.label))}${c.floor ? ` <span class="tag" title="${T('任何模式、任何人的个人设置都不会低于「{tier}」', { tier: esc(tt[c.floor]) })}">${T('底线：{tier}', { tier: esc(tt[c.floor]) })}</span>` : ''}</td>${o.modes.map((m) => cell(c, m.id)).join('')}</tr>`).join('')}
      </table>
      <div class="small mute" style="margin-top:4px">${T('「通知」推给谁：和这件事有关的人（任务负责人、提需求的人、答过这条事项的人……）。每个人可以在「设置 → 我的通知」里把不想被推送的几类改成只留记录。')}</div>
    </details>

    <h3 id="ovGatesH" style="margin-top:18px">${T('审批门禁')}</h3>
    <div class="small mute">${T('AI 在沙箱里自己跑命令之前，先对照这份清单。命中的命令要有人同意才能跑：AI 停在那条命令前，系统发一条「安全审批」待决事项。')}</div>
    <ul class="small" style="margin:6px 0 0 18px;padding:0">
      <li>${T('发给谁：')}<b>${gateWho(p.gateRoute)}</b>${T('（在项目设置的')}<a href="#" id="ovToRouting">${T('「决策路由」')}</a>${T('里「安全审批」那一行改）')}</li>
      <li>${T('没人答：AI 一直停在那条命令前，不会替你放行，也不会替你拒绝。')}</li>
      <li>${T('答「同意」：只放行这一条命令（一模一样的再跑不再问）；答别的都算不同意，AI 换别的做法。')}</li>
      <li>${T('管不到：你在看板上点「交付项目」时由系统推送，不经过这里；MCP 工具的同类设置在「MCP」里（设成每次要批准）。')}</li>
    </ul>
    <div class="small mute" style="margin-top:6px">${T('一行一条，按命令的文字匹配：* 代表任意一串字符，例如 git push* 拦下所有 git push；包在 sh -c "…" 里、或用 && 连在别的命令后面的也拦得住。换了写法的拦不住（比如不用 migrate、直接用 psql 执行 ALTER TABLE）——要稳妥，就把整个工具列上（例如 psql*）。清单为空 = 不拦任何命令。')}</div>
    <textarea id="ovGates" rows="4" aria-labelledby="ovGatesH" style="width:100%;margin-top:6px;font-family:var(--mono)" placeholder="${T('例如：git push*')}"${ro ? ' disabled' : ''}>${esc((p.gates ?? []).join('\n'))}</textarea>
    ${!ro && sugg.length ? `<div class="small" style="margin-top:4px">${T('常见的几条（点一下加进清单）：')}${sugg.map((s) => ` <button class="small ghost" data-gate-add="${esc(s.pattern)}">${esc(T(s.label))}<span class="mute"> · <code>${esc(s.pattern)}</code></span></button>`).join('')}</div>` : ''}
    ${ro ? '' : `<div class="row" style="margin-top:8px;gap:6px"><input id="ovGateTry" placeholder="${esc(T('试一条命令，例如：psql -c "ALTER TABLE users ADD x int"'))}" aria-label="${T('试一条命令')}" style="flex:1;font-family:var(--mono)"><button id="ovGateTryBtn" class="small">${T('会不会被拦')}</button></div>
      <div id="ovGateTryOut" class="small" role="status" style="margin-top:4px"></div>
      <div class="row" style="margin-top:6px"><span class="grow"></span><button id="ovGatesSave" class="primary">${T('保存审批门禁')}</button>${savedMark('gates')}</div>`}`;
  $('#ovToRouting').onclick = (e) => { e.preventDefault(); setPsPane('routing'); };
  if (ro) return;
  box.querySelectorAll('input[name=ovMode]').forEach((r) => r.onchange = () => {
    const v = r.value || null;
    void projAct(p.id, 'oversight', { mode: v }, v ? T('监督模式改成「{mode}」', { mode: modeName(v) }) : T('监督模式改成跟部署默认'));
  });
  box.querySelectorAll('[data-gate-add]').forEach((b) => b.onclick = () => {
    const ta = $('#ovGates');
    ta.value = [...ta.value.split('\n').map((x) => x.trim()).filter(Boolean), b.dataset.gateAdd].join('\n');
    b.remove();
  });
  // 试一条：拿文本框里的清单（可能还没保存）比，不保存、不跑命令
  $('#ovGateTryBtn').onclick = async () => {
    const test = $('#ovGateTry').value.trim(); if (!test) return;
    const commands = $('#ovGates').value.split('\n').map((x) => x.trim()).filter(Boolean);
    try {
      const r = await api(`/api/projects/${p.id}/gates`, { test, commands });
      $('#ovGateTryOut').innerHTML = r.hit ? `<span class="bad">${T('会被拦下：命中「{p}」', { p: esc(r.hit) })}</span>` : `<span>${T('不会被拦：清单里没有一条对得上，AI 直接就跑了')}</span>`;
    } catch (e) { $('#ovGateTryOut').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  };
  $('#ovGateTry').onkeydown = (e) => { if (e.key === 'Enter') $('#ovGateTryBtn').click(); };
  $('#ovGatesSave').onclick = async () => {
    const commands = $('#ovGates').value.split('\n').map((x) => x.trim()).filter(Boolean);
    // 带上打开时看到的清单：别人在这之间改过，服务端拒绝并说清是谁改的（不整份覆盖别人的）
    if (await projAct(p.id, 'gates', { commands, expect: p.gates ?? [] }, commands.length ? T('审批门禁已保存：{n} 条', { n: commands.length }) : T('审批门禁已清空：不拦任何命令'))) SAVED.set('gates', Date.now());
    else { await loadTasks(); renderProjSet(); }
  };
}

/** 设置 → 我的通知：不用我拍板的几类，推给我还是只留记录。 */
/**
 * 设置 → 我的通知 → 什么时候推：工作时间、汇总推送间隔、推送限额。每项可以"跟部署默认"；管理员另能改部署默认。
 * 紧急的（AI 停着等人、等不起的）不受工作时间与汇总间隔影响，马上推。
 */
function renderPushPrefs(push) {
  const box = $('#pushPrefs'); if (!box || !push) return;
  const admin = me?.role === 'lead';
  const hour = (h) => `${String(h).padStart(2, '0')}:00`;
  const everyText = (m) => (m === 0 ? T('不攒，有就推') : m < 60 ? T('每 {n} 分钟', { n: m }) : m % 60 ? T('每 {n} 分钟', { n: m }) : T('每 {n} 小时', { n: m / 60 }));
  const capText = (n) => (n === 0 ? T('不限') : T('每小时最多 {n} 次', { n }));
  const EVERY = [0, 15, 30, 60, 120, 240, 480, 1440], CAP = [0, 2, 3, 4, 6, 8, 12];
  // own：自己设过的那几项；没设 = 跟部署默认（下拉框第一项）
  const sel = (id, key, values, text, own, dflt, label) => `<select id="${id}" aria-label="${esc(label)}" style="width:auto">
      <option value=""${own[key] === undefined ? ' selected' : ''}>${T('跟部署默认（{v}）', { v: esc(text(dflt)) })}</option>
      ${values.map((x) => `<option value="${esc(x)}"${own[key] === x ? ' selected' : ''}>${esc(text(x))}</option>`).join('')}</select>`;
  const hours = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const w = push.week;
  const tzOff = !push.tzOwn && BROWSER_TZ && BROWSER_TZ !== push.tz;
  box.innerHTML = `
    <div class="small mute">${T('紧急的马上推：Ⅲ 级事项（最重的一级）、安全审批、快到时限或已经升级的事项、以你的名义对外动作、安全边界被系统改了、部署出故障（这套系统自己运行出问题）。其余的不紧急，包括签收（不管哪一级）：只在你的工作时间里推，而且攒起来，每隔一段时间合成一条「汇总推送」。一小时里打断你的次数到了下面的「推送限额」，紧急的也改成排进汇总（Ⅲ 级与部署出故障除外）。')}</div>
    <table class="rt" style="margin-top:8px">
      <tr><td class="small" style="white-space:nowrap">${T('工作时间')}</td><td>
        ${sel('ppStart', 'start', hours(0, 23), hour, push.own, push.deploy.start, T('工作时间从'))} ${T('到')} ${sel('ppEnd', 'end', hours(1, 24), hour, push.own, push.deploy.end, T('工作时间到'))}
        <label class="small" style="margin-left:8px"><input type="checkbox" id="ppDays" style="width:auto"${push.prefs.workdaysOnly ? ' checked' : ''}> ${T('只算工作日（按部署的节假日表）')}</label>
        <div class="small mute">${push.tzOwn ? T('按你自己设的时区（{tz}）。', { tz: esc(push.tz) }) : T('按部署时区（{tz}），你没单独设时区。', { tz: esc(push.tz) })}
          <a href="#settings" id="ppTzGo">${T('改时区')}</a>　${T('可以跨午夜（比如 22:00 到 02:00）。工作时间外只推紧急的，其余攒到下一个工作时段开始时一起推。')}
          ${push.working ? T('现在在你的工作时间里。') : push.nextStart ? T('现在不在你的工作时间里，不紧急的攒到 {t} 推。', { t: esc(fmtWhen(push.nextStart)) }) : T('现在不在你的工作时间里。')}</div>
        ${tzOff ? `<div class="small" style="color:var(--wait)">${T('你的浏览器在 {b} 时区，跟这里用的 {tz} 不一样：上面的钟点按 {tz} 算。', { b: esc(BROWSER_TZ), tz: esc(push.tz) })}
          <button id="ppTzBrowser" class="small">${T('我的时区改成 {b}', { b: esc(BROWSER_TZ) })}</button></div>` : ''}</td></tr>
      <tr><td class="small" style="white-space:nowrap">${T('汇总推送')}</td><td>${sel('ppEvery', 'every', EVERY, everyText, push.own, push.deploy.every, T('汇总推送间隔'))}
        <div class="small mute">${T('不紧急的攒起来按这个间隔合成一条，里面按种类分组（同一项目的签收列在一起，仍然逐件签）。攒到只有一件时照原样推那一件。')}</div></td></tr>
      <tr><td class="small" style="white-space:nowrap">${T('推送限额')}</td><td>${sel('ppCap', 'cap', CAP, capText, push.own, push.deploy.cap, T('推送限额'))}
        <div class="small mute">${T('一小时里最多打断你几次（推一件算一次，一条汇总也算一次）。到了限额，再来的紧急事项不单独推，等这一小时的名额空出来，排在那条汇总的最前面；Ⅲ 级事项与部署出故障不受限额。')}</div></td></tr>
    </table>
    <div class="row" style="margin-top:6px"><span class="small mute">${esc(T('最近 7 天打断了你 {n} 次：{s} 次推单件事，{d} 次是汇总推送；这些推送一共带了 {i} 件事。现在还攒着 {p} 件没推。', { n: w.pushes, s: w.singles, d: w.digests, i: w.items, p: push.pending }))}</span>
      <span class="grow"></span><button id="ppSave" class="primary">${T('保存「什么时候推」')}</button></div>
    ${reportPrefsHtml(push.report, push)}
    ${admin ? `<details style="margin-top:10px"><summary class="small">${T('部署默认（管理员）：没单独设的人都用这一套')}</summary>
      <div class="row small" style="margin-top:6px;gap:6px;flex-wrap:wrap">
        ${T('工作时间')} <select id="pdStart" style="width:auto" aria-label="${T('部署默认：工作时间从')}">${hours(0, 23).map((h) => `<option value="${esc(h)}"${h === push.deploy.start ? ' selected' : ''}>${hour(h)}</option>`).join('')}</select>
        ${T('到')} <select id="pdEnd" style="width:auto" aria-label="${T('部署默认：工作时间到')}">${hours(1, 24).map((h) => `<option value="${esc(h)}"${h === push.deploy.end ? ' selected' : ''}>${hour(h)}</option>`).join('')}</select>
        <label><input type="checkbox" id="pdDays" style="width:auto"${push.deploy.workdaysOnly ? ' checked' : ''}> ${T('只算工作日')}</label>
        ${T('汇总推送')} <select id="pdEvery" style="width:auto" aria-label="${T('部署默认：汇总推送间隔')}">${EVERY.map((m) => `<option value="${m}"${m === push.deploy.every ? ' selected' : ''}>${esc(everyText(m))}</option>`).join('')}</select>
        ${T('推送限额')} <select id="pdCap" style="width:auto" aria-label="${T('部署默认：推送限额')}">${CAP.map((n) => `<option value="${n}"${n === push.deploy.cap ? ' selected' : ''}>${esc(capText(n))}</option>`).join('')}</select>
        <button id="pdSave" class="small">${T('保存部署默认')}</button></div>
      ${(push.team ?? []).length ? `<div class="small" style="margin-top:10px"><b>${T('全员最近 7 天被推送打断几次（各人的设置只有本人能改；推得多的，可以提醒本人调汇总间隔或推送限额，或改上面的部署默认）')}</b>
        <table class="rt" style="margin-top:4px"><tr><th>${T('成员')}</th><th>${T('打断次数')}</th><th>${T('单条 / 汇总')}</th><th>${T('一共几件事')}</th></tr>
        ${push.team.map((u) => `<tr><td>${esc(u.name)}${u.me ? ` ${T('（你）')}` : ''}</td><td>${esc(u.pushes)}</td><td class="mute">${esc(u.singles)} / ${esc(u.digests)}</td><td class="mute">${esc(u.items)}</td></tr>`).join('')}</table></div>` : ''}</details>` : ''}`;
  const num = (id) => ($(id).value === '' ? null : Number($(id).value));
  $('#ppTzGo').onclick = (e) => { e.preventDefault(); setPane('time'); };
  if ($('#ppTzBrowser')) $('#ppTzBrowser').onclick = async () => {
    try { const r = await api('/api/me/tz', { tz: BROWSER_TZ }); VIEW_TZ = r.tz; toast(T('已保存')); } catch (e) { toast(e.message, true); }
    void renderSignalPrefs();
  };
  bindReportPrefs(push.report);
  $('#ppSave').onclick = async () => {
    // 勾选框跟部署默认一样就不单独存（部署默认改了也跟着变）
    const days = $('#ppDays').checked;
    const prefs = { start: num('#ppStart'), end: num('#ppEnd'), every: num('#ppEvery'), cap: num('#ppCap'), workdaysOnly: days === push.deploy.workdaysOnly && push.own.workdaysOnly === undefined ? null : days };
    try { await api('/api/me/push-prefs', { prefs }); toast(T('已保存')); } catch (e) { toast(e.message, true); }
    void renderSignalPrefs();
  };
  if ($('#pdSave')) $('#pdSave').onclick = async () => {
    try {
      for (const [key, value] of [['deploy.work_start_hour', Number($('#pdStart').value)], ['deploy.work_end_hour', Number($('#pdEnd').value)], ['deploy.work_days_only', $('#pdDays').checked],
        ['deploy.digest_every_min', Number($('#pdEvery').value)], ['deploy.push_cap_per_hour', Number($('#pdCap').value)]]) await api('/api/users', { action: 'setting', key, value });
      toast(T('部署默认已保存'));
    } catch (e) { toast(e.message, true); }
    void renderSignalPrefs();
  };
}

async function renderSignalPrefs() {
  const box = $('#sigPrefs'); if (!box) return;
  let v; try { v = await api('/api/me/signal-prefs'); } catch (e) { box.innerHTML = `<div class="small bad">${esc(e.message)}</div>`; return; }
  renderPushPrefs(v.push);
  const tt = TIER_TEXT();
  box.innerHTML = `
    <div class="small mute">${T('要你拍板的事（签收、批准方案、意见冲突、花钱的闸、安全审批……）总会推给你，不在这里调。这里调的是不用你拍板、只是让你知道的几类：推送到你的通知通道，还是只留在收件箱的「通知」里，你有空再看。推送的那些什么时候推，照上面「什么时候推」。这张表选了就生效，不用点保存。')}</div>
    <div class="small mute" style="margin-top:4px">${T('「跟项目」= 按事情所在项目的监督模式；表里列的是部署默认模式（{mode}）下的做法。只影响你自己，不影响别人，也不影响 AI 停不停。', { mode: esc(T(v.deployModeLabel)) })}</div>
    ${v.projects?.length ? `<div class="small" style="margin-top:4px">${T('你参与的这几个项目用的不是「{mode}」，那里「跟项目」时的做法以项目设置「监督与审批」里的对照表为准；对照表里标「决策」的几类照样要你答，不受这里影响：', { mode: esc(T(v.deployModeLabel)) })}
      ${v.projects.map((p) => `<a href="#p/${esc(p.id)}/settings">${esc(p.title)}</a>（${esc(T(p.modeLabel))}）`).join(T('、'))}</div>` : ''}
    <table class="rt" style="margin-top:8px"><tr><th>${T('哪一类事')}</th><th>${T('跟项目时')}</th><th>${T('我收到时')}</th></tr>
      ${v.classes.map((c) => `<tr><td class="small">${esc(T(c.label))}</td><td class="small mute">${esc(c.note ? T(c.note) : tt[c.deployTier])}</td>
        <td>${c.floor ? `<span class="small">${T('总会推送，不能关；什么时候推照上面「什么时候推」')} <span class="mute">${T('（不许静默：系统替人做了决定、以你的名义对外动手、改了安全边界、部署出故障，都必须让人知道）')}</span></span>`
          : `<select data-sigpref="${esc(c.id)}" style="width:auto" aria-label="${esc(T(c.label))}">
            <option value=""${c.pref ? '' : ' selected'}>${T('跟项目')}</option>
            <option value="notify"${c.pref === 'notify' ? ' selected' : ''}>${T('推送给我')}</option>
            <option value="record"${c.pref === 'record' ? ' selected' : ''}>${T('不推送，只留记录')}</option></select>${c.always ? `<div class="small mute">${esc(T(c.always))}</div>` : ''}`}</td></tr>`).join('')}
    </table>`;
  box.querySelectorAll('[data-sigpref]').forEach((s) => onPick(s, async (val) => {
    try { await api('/api/me/signal-prefs', { cls: s.dataset.sigpref, tier: val || null }); toast(T('已保存')); } catch (e) { toast(e.message, true); }
    void renderSignalPrefs();
  }));
}

/** 收件箱 → 通知：系统发给我的、不用我拍板的事（最近 30 条）。 */
async function renderSignalFeed() {
  const box = $('#signalFeed'); if (!box) return;
  let v; try { v = await api('/api/me/signals?limit=30'); } catch (e) { box.innerHTML = `<span class="small bad">${esc(e.message)}</span>`; return; }
  $('#signalTag').textContent = v.unread ? T('{n} 条未读', { n: v.unread }) : '';
  if (!v.items.length) { box.innerHTML = `<span class="mute small">${T('还没有通知。系统替人做了决定、别人动了你的事、任务合并了……都会列在这里。')}</span>`; return; }
  const href = (s) => (s.task_id ? `#${s.task_id}` : s.project_id ? `#p/${s.project_id}` : null);
  box.innerHTML = `<div class="small mute">${T('不用你拍板、只是让你知道的事。加粗的是还没点开看过的（点开就算看过）；标着「只记录」的没有推送给你（你在「设置 → 我的通知」里这样设的，或这个项目的监督模式这样定的）。')}</div>
    ${v.items.map((s) => `<details class="irow" style="margin-top:6px" data-sig="${esc(s.id)}"${s.read_at ? '' : ' data-unread="1"'}>
      <summary>${s.read_at ? '' : '<b>'}${esc(sigTitle(s.title))}${s.read_at ? '' : '</b>'}
        <span class="small mute"> · ${s.classLabel ? `${esc(T(s.classLabel))} · ` : ''}${T('{t}前', { t: ago(s.created_at) })}${s.tier === 'record' ? ` · ${T('只记录')}` : ''}</span></summary>
      <div class="body small" style="white-space:pre-wrap;margin-top:4px">${esc(s.text)}</div>
      <div class="row small" style="margin-top:4px;gap:10px">${href(s) ? `<a href="${href(s)}">${s.task_id ? T('打开任务') : T('打开项目')}</a>` : ''}<span class="grow"></span>
        ${s.classLabel && s.tier === 'notify' && !s.floor && v.prefs?.[s.class] !== 'record' ? `<button class="small ghost" data-sig-mute="${esc(s.class)}" data-label="${esc(T(s.classLabel))}">${T('「{label}」这一类以后不推送给我（所有项目）', { label: esc(T(s.classLabel)) })}</button>` : ''}</div>
    </details>`).join('')}
    ${v.unread ? `<div class="row" style="margin-top:8px"><span class="grow"></span><button id="sigReadAll" class="small">${T('全部标为已读')}</button></div>` : ''}`;
  box.querySelectorAll('details[data-unread]').forEach((d) => d.addEventListener('toggle', async () => {
    if (!d.open || !d.dataset.unread) return;
    delete d.dataset.unread;
    try { await api('/api/me/signals/read', { ids: [d.dataset.sig] }); } catch { /* 标不上下次再标 */ }
    const b = d.querySelector('summary b'); if (b) b.outerHTML = b.innerHTML;
  }));
  box.querySelectorAll('[data-sig-mute]').forEach((b) => b.onclick = async () => {
    try { await api('/api/me/signal-prefs', { cls: b.dataset.sigMute, tier: 'record' }); toast(T('「{label}」在所有项目里都不再推送给你，只留在这里；要改回去，到「设置 → 我的通知」', { label: b.dataset.label })); }
    catch (e) { toast(e.message, true); }
    void renderSignalFeed();
  });
  if ($('#sigReadAll')) $('#sigReadAll').onclick = async () => { try { await api('/api/me/signals/read', { all: true }); } catch (e) { toast(e.message, true); } void renderSignalFeed(); };
}

// ── 状态报告：多久一份、几点、详略 ──
const REPORT_EVERY = () => ({ off: T('不推（看板上照样能看）'), day: T('每天'), week: T('每周') });
const REPORT_DETAIL = () => ({ exceptions: T('只报异常'), summary: T('摘要'), full: T('详细') });
const WEEKDAY = () => ['', T('周一'), T('周二'), T('周三'), T('周四'), T('周五'), T('周六'), T('周日')];
const HOURS24 = Array.from({ length: 24 }, (_, h) => h);
const MODE_NAME = () => ({ full: T('逐项审批'), spot: T('抽检'), exception: T('例外管理') });
/** h 点在不在工作时间 [s, e) 里（可以跨午夜；e 最大 24）。 */
const inWorkHours = (h, s, e) => (s === e || (s < e ? h >= s && h < e : h >= s || h < e));
function reportPrefsHtml(rv, push) {
  if (!rv) return '';
  const hour = (h) => `${String(h).padStart(2, '0')}:00`;
  // 部署默认是 auto 时，写出落到了什么、为什么
  const depEvery = rv.deploy.every === 'auto' ? rv.deploy.auto.every : rv.deploy.every;
  const depDetail = rv.deploy.detail === 'auto' ? rv.deploy.auto.detail : rv.deploy.detail;
  const autoNote = (k) => rv.deploy[k] !== 'auto' ? '' : T('，按部署的默认监督模式「{m}」', { m: MODE_NAME()[rv.deploy.mode] ?? rv.deploy.mode });
  const opt = (v, cur, text) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(text)}</option>`;
  const sel = (id, label, own, dfltText, entries) => `<select id="${id}" aria-label="${esc(label)}" style="width:auto">
      <option value=""${own === undefined ? ' selected' : ''}>${T('跟部署默认（{v}）', { v: esc(dfltText) })}</option>
      ${entries.map(([v, t]) => opt(v, own, t)).join('')}</select>`;
  const last = rv.last ? T('上一份在 {at} 推出，覆盖 {from} 到 {to}。', { at: fmtWhen(rv.last.slot_at), from: fmtWhen(rv.last.since), to: fmtWhen(rv.last.until) }) : T('还没推过。');
  const p = rv.prefs;
  // 报告的钟点落在工作时间外：照规矩攒到工作时间开始才推，这里直接说出来
  const off = push && p.every !== 'off' && !inWorkHours(p.hour, push.prefs.start, push.prefs.end)
    ? `<div class="small" style="color:var(--wait);margin-top:4px">${T('{h} 不在你的工作时间（{s}–{e}）里：报告照样在 {h} 生成，推送要等到 {s} 才发。', { h: hour(p.hour), s: hour(push.prefs.start), e: hour(push.prefs.end) })}</div>` : '';
  return `<div style="margin-top:14px"><b class="small">${T('状态报告')}</b>
    <div class="small mute">${T('隔一段时间推一份「这段时间发生了什么」：出事了没有、没等你拍板就定下的（含你调成备案的那几类）、进展、花费。不管推不推，看板左侧「状态报告」随时能看。')}</div>
    <div class="row small" style="gap:6px;flex-wrap:wrap;margin-top:6px">
      ${T('多久一份')} ${sel('rpfEvery', T('状态报告多久一份'), rv.own.every, REPORT_EVERY()[depEvery] + autoNote('every'), Object.entries(REPORT_EVERY()))}
      <span id="rpfDayWrap">${T('每周哪天')} ${sel('rpfDay', T('每周的那份在星期几'), rv.own.day, WEEKDAY()[rv.deploy.day], WEEKDAY().slice(1).map((t, i) => [i + 1, t]))}</span>
      ${T('几点')} ${sel('rpfHour', T('状态报告几点推'), rv.own.hour, hour(rv.deploy.hour), HOURS24.map((h) => [h, hour(h)]))}
      ${T('详略')} ${sel('rpfDetail', T('状态报告详略'), rv.own.detail, REPORT_DETAIL()[depDetail] + autoNote('detail'), Object.entries(REPORT_DETAIL()))}
      ${rv.isLead ? `${T('范围')} <select id="rpfScopeP" aria-label="${esc(T('状态报告的范围'))}" style="width:auto">${opt('all', p.scope, T('全部项目'))}${opt('mine', p.scope, T('与我有关的'))}</select>` : ''}
    </div>
    <div class="small mute" style="margin-top:4px">${esc(T('现在：{every}{when}，{detail}。', { every: REPORT_EVERY()[p.every], when: p.every === 'off' ? '' : p.every === 'week' ? T('（{d} {h}）', { d: WEEKDAY()[p.day], h: hour(p.hour) }) : T('（{h}）', { h: hour(p.hour) }), detail: REPORT_DETAIL()[p.detail] }))}
      ${T('钟点按你的时区（{tz}）。那天不是工作日就顺延：周末那几天的并进下一个工作日的那一份。推送计入你的推送限额。「只报异常」只写出事了没有，没出事也会推一句「没有出事」。', { tz: esc(rv.tz) })} ${esc(last)}</div>
    ${off}
    <div class="row" style="margin-top:6px"><span class="grow"></span><button id="rpfReset" class="small">${T('全部跟部署默认')}</button><button id="rpfSave">${T('保存「状态报告」')}</button></div>
    ${rv.isLead ? `<details style="margin-top:6px"><summary class="small">${T('状态报告的部署默认（管理员）')}</summary>
      <div class="small mute" style="margin-top:4px">${T('改这里：上面某一项选「跟部署默认」的人，那一项跟着变；自己选过的那一项不变。')}</div>
      <div class="row small" style="margin-top:6px;gap:6px;flex-wrap:wrap">
        ${T('多久一份')} <select id="rdEvery" style="width:auto" aria-label="${esc(T('部署默认：状态报告多久一份'))}">${opt('auto', rv.deploy.every, T('按部署的默认监督模式（逐项审批每天，抽检、例外管理每周）'))}${Object.entries(REPORT_EVERY()).map(([v, t]) => opt(v, rv.deploy.every, t)).join('')}</select>
        ${T('每周哪天')} <select id="rdDay" style="width:auto" aria-label="${esc(T('部署默认：每周的那份在星期几'))}">${WEEKDAY().slice(1).map((t, i) => opt(i + 1, rv.deploy.day, t)).join('')}</select>
        ${T('几点')} <select id="rdHour" style="width:auto" aria-label="${esc(T('部署默认：状态报告几点推'))}">${HOURS24.map((h) => opt(h, rv.deploy.hour, hour(h))).join('')}</select>
        ${T('详略')} <select id="rdDetail" style="width:auto" aria-label="${esc(T('部署默认：状态报告详略'))}">${opt('auto', rv.deploy.detail, T('按部署的默认监督模式（例外管理只报异常，其余摘要）'))}${Object.entries(REPORT_DETAIL()).map(([v, t]) => opt(v, rv.deploy.detail, t)).join('')}</select>
        <button id="rdSave" class="small">${T('保存部署默认')}</button></div></details>` : ''}</div>`;
}
function bindReportPrefs(rv) {
  if (!rv || !$('#rpfSave')) return;
  const val = (id, num) => ($(id).value === '' ? null : num ? Number($(id).value) : $(id).value);
  // 「每周哪天」只在实际是每周一份时有用
  const depEvery = rv.deploy.every === 'auto' ? rv.deploy.auto.every : rv.deploy.every;
  const dayVis = () => { $('#rpfDayWrap').classList.toggle('hide', ($('#rpfEvery').value || depEvery) !== 'week'); };
  $('#rpfEvery').onchange = dayVis; dayVis();
  const save = async (prefs) => {
    try { await api('/api/me/push-prefs', { prefs }); toast(T('已保存')); } catch (e) { toast(e.message, true); }
    void renderSignalPrefs();
  };
  $('#rpfSave').onclick = () => {
    const prefs = { reportEvery: val('#rpfEvery'), reportDay: val('#rpfDay', true), reportHour: val('#rpfHour', true), reportDetail: val('#rpfDetail') };
    if ($('#rpfScopeP')) prefs.reportScope = $('#rpfScopeP').value;
    return save(prefs);
  };
  $('#rpfReset').onclick = () => save({ reportEvery: null, reportDay: null, reportHour: null, reportDetail: null, reportScope: null });
  if ($('#rdSave')) $('#rdSave').onclick = async () => {
    try {
      const want = [['every', $('#rdEvery').value], ['day', Number($('#rdDay').value)], ['hour', Number($('#rdHour').value)], ['detail', $('#rdDetail').value]];
      for (const [k, value] of want.filter(([key, v]) => v !== rv.deploy[key])) await api('/api/users', { action: 'setting', key: `deploy.report_${k}`, value });   // 只写改了的
      toast(T('部署默认已保存'));
    } catch (e) { toast(e.message, true); }
    void renderSignalPrefs();
  };
}
