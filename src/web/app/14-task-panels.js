// ── 留话与消息 + 汇报 ───────────────────────────────────────────────────
function renderInbox() {
  const kindName = (k) => ({ correction: T('修正'), instruction: T('新指令'), context: T('补充信息'), answer: T('答复') }[k] ?? k);
  $('#inbox').innerHTML = detail.messages.filter((m) => m.kind !== 'answer').map((m) => `<div class="item"><div class="small mute"><span class="pill">${esc(kindName(m.kind))}${m.kind_source === 'classifier' ? T('（自动分类）') : ''}</span> ${m.urgency === 'urgent' ? `${T('紧急')} · ` : ''}${m.sender_id ? esc(nameOf(m.sender_id)) : T('系统')}${m.trust_label === 'observed-untrusted' ? T('（旁观者消息，不参与决策）') : ''} · ${T('{t}前', { t: ago(m.received_at) })} · ${m.consumed_at ? T('已处理') : m.held?.why === 'verdict' ? T('<b>暂不执行</b>：其中有说法和项目里仍然有效的约定对不上，已挂事项等人裁定；裁定之后按结论执行') : m.held?.why === 'check' ? T('<b>待处理</b>（正在对照项目里已有的约定，通常几秒）') : `<b>${T('待处理')}</b>`}</div><div class="body small">${esc(m.body).slice(0, 400)}</div></div>`).join('') || `<span class="mute small">${T('无')}</span>`;
}
function renderReports() {
  const rs = [...detail.reports].reverse();
  $('#rpCount').textContent = rs.filter((r) => !r.read_at).length ? T('{n} 未读', { n: rs.filter((r) => !r.read_at).length }) : '';
  const trg = (t) => ({ node_done: T('步骤完成'), revision_applied: T('计划变更已应用'), limit_breached: T('达到上限'), provider_error: T('模型服务错误'), task_done: T('任务完成'), verify_failed: T('验收未通过') }[t] ?? t);
  $('#reports').innerHTML = rs.map((r) => `<div class="item ${r.read_at ? '' : 'flag'}"><div class="small mute">${esc(trg(r.trigger))} · ${T('{t}前', { t: ago(r.created_at) })} ${r.read_at ? '' : `· ${T('未读')}`}</div><div class="body small">${esc(r.summary)}</div><div class="row"><button data-rp="${esc(r.id)}" class="small">${T('全文')}</button></div><pre hidden id="rp-${esc(r.id)}"></pre></div>`).join('') || `<span class="mute small">${T('无')}</span>`;
  $('#reports').querySelectorAll('button[data-rp]').forEach((b) => b.onclick = async () => {
    const pre = $(`#rp-${b.dataset.rp}`); if (!pre.hidden) { pre.hidden = true; return; }
    const r = await api(`/api/tasks/${cur}/report?id=${b.dataset.rp}`); pre.textContent = r.body; pre.hidden = false;
    if (!r.read_at) api(`/api/tasks/${cur}/reportsRead`, { ids: [r.id] }).then(refresh);
  });
}

// ── 上限：左段只读"已用"，右段"上限"输入 + 保存。名称与提示按 开发计划 定稿。 ─────
const kTokL = (n) => `${+(n / 1000).toFixed(1)}k token`;
const LIM = {
  'limit.budget_micro_usd': { name: T('预算'), hint: T('达到上限后暂停，并询问是否追加'), verb: T('已用'), unit: T('美元'), from: (v) => (v / 1e6).toFixed(2), to: (v) => Math.round(Number(v) * 1e6) },
  'limit.runtime_ms': { name: T('活动时长'), hint: T('仅计实际执行时间，不含等待答复的时间'), verb: T('已用'), unit: T('分钟'), from: (v) => (v / 60000).toFixed(0), to: (v) => Math.round(Number(v) * 60000) },
  'limit.llm_calls': { name: T('模型请求'), hint: T('模型请求总次数'), verb: T('已用'), unit: T('次') },
  'limit.node_retries': { name: T('步骤重试'), hint: T('同一步骤失败后自动重试的次数'), verb: T('已重试'), unit: T('次') },
  'limit.node_reclaims': { name: T('步骤异常恢复'), hint: T('同一步骤的进程异常中断（断电、服务商故障）后恢复执行的次数'), verb: T('已恢复'), unit: T('次') },
  'limit.draft_rounds': { name: T('澄清轮次'), hint: T('系统为澄清需求提问的轮数'), verb: T('已问'), unit: T('轮') },
  'limit.idle_cycles': { name: T('无进展轮次'), hint: T('连续无实质进展达到该轮数后暂停并提问'), verb: T('当前'), unit: T('轮'), live: true },
  'limit.context_tokens': { name: T('单次请求上下文'), hint: T('单次模型请求的输入总量；1k token ≈ 700 汉字'), verb: T('当前'), unit: 'token', live: true,
    note: (v) => (v.effective?.source === 'model' ? T('填的比所绑模型接得住的大，实际按 {cap}（模型窗口 {w} 的 75%）', { cap: kTokL(v.effective.cap), w: kTokL(v.effective.window) }) : '') },
  'limit.compact_tokens': { name: T('自动整理线'), hint: T('单次请求的内容超过这么多时，先自动整理再继续（清掉早先的大段工具输出，不够再把前面的过程写成简报）。填 0 = 关掉：撞到「单次请求上下文」上限，这一步就作废重来'), unit: 'token',
    field: Tc('field', '整理线'), verb: T('已整理'), used: (m) => T('{n} 次', { n: m }),
    note: (v) => (v.effective?.source === 'context' || v.effective?.source === 'model' ? T('填的太高，实际按 {at}：要比「单次请求上下文」实际按的 {cap} 低两成', { at: kTokL(v.effective.at), cap: kTokL(v.effective.cap) }) : '') },
  'limit.egress.consecutive_denials': { name: T('联网连续拦截'), hint: T('沙箱连续访问未放行网络达到该次数后暂停并提问'), verb: T('当前'), unit: T('次'), live: true },
  'limit.memory_bytes': { name: T('沙箱内存 · 超限即终止'), hint: T('沙箱内存；超限直接终止，不提问'), verb: T('当前'), unit: 'GiB', live: true, from: (v) => (v / 1024 ** 3).toFixed(1), to: (v) => Math.round(Number(v) * 1024 ** 3) },
  'limit.pids': { name: T('沙箱进程数 · 超限即终止'), hint: T('沙箱内同时存在的进程数；超限直接终止，不提问'), verb: T('当前'), unit: T('个'), live: true },
};
// 上下文两项（硬上限 + 自动整理线）单独成段：两者的实际值互相牵连，各带一行说明，挤在两栏网格里会被压成窄条
const CTX_LIM = ['limit.context_tokens', 'limit.compact_tokens'];
// 改了路由之后对已发出事项的影响：提示条只说"见上方"，清单留在路由设置上方，点「知道了」才收起
// （走查：一行提示装不下哪几条、从谁改给了谁、没动的为什么、该怎么办）
let lastReroute = null;
function reroutedNote(r) {
  const rr = r?.rerouted;
  if (!rr || (!rr.moved.length && !rr.kept.length)) return '';
  lastReroute = { key: routingCtx.key, ...rr };
  return T('；对已发出事项的影响见上方');
}
function rerouteHtml(RK, uname) {
  const rr = lastReroute; if (!rr || rr.key !== RK) return '';
  const who = (ids) => (ids.length ? ids.map(uname).map(esc).join(T('、')) : T('（没人）'));
  const item = (x) => `<a href="#${esc(x.taskId)}">${esc(x.text || x.id)}</a>`;
  const WHY = { answered: T('已经有人答过，不自动换人'), transferred: T('有人手动转交过，不自动改回') };
  return `<div class="small" style="margin:0 0 10px;padding:6px 8px;border-left:3px solid var(--line)"><b>${T('刚才的修改对已经发出的事项')}</b> <button id="rtRerouteOk" class="small">${T('知道了')}</button>`
    + (rr.moved.length ? `<div style="margin-top:4px">${T('按新规则自动改发了 {n} 条还没人答的（原来的收件人那边不再显示）：', { n: esc(rr.moved.length) })}</div><ul style="margin:2px 0 0 18px;padding:0">${rr.moved.map((x) => `<li>${item(x)}：${who(x.from)} → <b>${who(x.to)}</b></li>`).join('')}</ul>` : '')
    + (rr.kept.length ? `<div style="margin-top:4px">${T('没改发 {n} 条，仍在原来的人那里；要换人就打开事项用「转交」：', { n: esc(rr.kept.length) })}</div><ul style="margin:2px 0 0 18px;padding:0">${rr.kept.map((x) => `<li>${item(x)}：${who(x.at)} <span class="mute">—— ${esc(WHY[x.why] ?? x.why)}</span></li>`).join('')}</ul>` : '')
    + '</div>';
}
function renderLimits() {
  const canEdit = !!detail.can?.budget;   // 按路由表算（上限追加路由到谁），不按身份
  const parts = (k, v) => {
    const L = LIM[k] ?? { name: T(v.label), hint: '', verb: T('已用'), unit: '' };
    const from = L.from ?? ((x) => String(x));
    const used = L.live ? '—' : (detail.measured?.[k] == null ? '—' : L.used ? L.used(detail.measured[k]) : `${from(detail.measured[k])} ${L.unit}`);
    return { L, note: L.note?.(v) ?? '',
      head: `<span class="name"><abbr title="${esc(L.hint)}">${esc(L.name)}</abbr></span>${L.live && L.note ? '' : ` <span class="used small">${esc(L.verb)} ${esc(used)}</span>`}`,
      edit: `<div class="edit"><label for="lim-${esc(k)}">${esc(L.field ?? Tc('field', '上限'))}</label><input id="lim-${esc(k)}" data-lim="${esc(k)}" value="${esc(from(v.value))}" ${canEdit ? '' : 'disabled'}><span class="unit">${esc(L.unit)}</span>${canEdit ? `<button data-limset="${esc(k)}" class="small">${T('保存「{name}」', { name: esc(L.name) })}</button>${savedMark(`lim:${esc(k)}`)}` : ''}</div>` };
  };
  $('#limits').innerHTML = Object.entries(detail.limits).filter(([k]) => !CTX_LIM.includes(k)).map(([k, v]) => { const p = parts(k, v); return `<div>${p.head}</div>${p.edit}`; }).join('');
  const ctx = CTX_LIM.filter((k) => detail.limits[k]);
  $('#ctxLim').innerHTML = ctx.length ? `<div class="small mute" style="margin:16px 0 6px"><b>${T('上下文太长时')}</b> · ${T('先到「自动整理线」：不停下，自动整理后接着做（填 0 不整理）；整理了还到「单次请求上下文」上限，这一步作废重来')}</div>`
    + ctx.map((k) => { const p = parts(k, detail.limits[k]); return `<div class="row" style="margin:4px 0"><span style="min-width:12em">${p.head}</span>${p.edit}${p.note ? `<span class="small mute">${esc(p.note)}</span>` : ''}</div>`; }).join('') : '';
  // 摘要行：用量 ≥ 80% 的维度点名，其余只给个数
  const near = Object.entries(detail.limits).filter(([k, v]) => { const m = detail.measured?.[k]; return !LIM[k]?.used && m != null && v.value > 0 && m / v.value >= 0.8; }).map(([k, v]) => (LIM[k]?.name ?? T(v.label)));
  $('#limTag').innerHTML = near.length ? `<span style="color:var(--wait)">${T('接近上限：{names}', { names: near.map(esc).join(T('、')) })}</span>` : T('{n} 项，均未接近上限', { n: Object.keys(detail.limits).filter((k) => !LIM[k]?.used).length });
  if (near.length) $('#limBox').open = true;
  $('#limBox').querySelectorAll('button[data-limset]').forEach((b) => b.onclick = () => {
    const k = b.dataset.limset; const L = LIM[k] ?? {}; const raw = $(`input[data-lim="${k}"]`).value;
    const value = L.to ? L.to(raw) : Number(raw);
    if (!Number.isFinite(value) || value < 0) return toast(T('请输入非负数'), true);
    SAVED.set(`lim:${k}`, Date.now()); act('limit', { key: k, value, expect: detail.limits[k]?.value ?? null }, L.field ? T('已保存') : T('上限已保存')).then((r) => { if (!r) { SAVED.delete(`lim:${k}`); renderLimits(); } });
  });
}

// ── 谁来决定（只有负责人看得到）─────────────────────────────────────────
/**
 * 选人控件：把 user:<id> / group:<标签> / on_duty … 这些解析器写法换成"名字标签 + 下拉添加"。
 * 值仍是解析器字符串数组（el._get()）；认不出的写法（如没绑定的模板占位）原样保留、标红，不会被悄悄丢掉。
 * mode='users'：值是用户 id 的有序列表（值班表用）。
 */
function recPicker(el, value, { users, parties = false, mode = 'resolvers', hasDuty = true, onChange = null, ctx = '' }) {
  const pre = (s) => (ctx ? T('{ctx}：{what}', { ctx, what: s }) : s);   // 读屏名前面带上是哪一类决策（每行的控件同名）
  let val = [...value];
  const live = users.filter((u) => !u.disabled_at && u.role !== 'observer');
  const tags = [...new Set(live.flatMap((u) => u.domain_tags ?? []))].sort();
  const uname = (id) => users.find((u) => u.id === id)?.display_name ?? null;
  const base = (x) => x.replace(/^inform:/, '');
  const label = (x) => {
    if (mode === 'users') return uname(x);
    const b = base(x);
    if (b === 'user:lead') return T('负责人');
    if (b === 'group:*') return T('所有成员');
    if (b === 'on_duty') return T('值班人');
    if (b === 'parties') return T('冲突双方');
    if (b === 'requester') return T('需求提出人');
    if (b.startsWith('group:')) return T('标签 {tag}', { tag: b.slice(6) });
    if (b.startsWith('user:')) { const u = users.find((z) => z.id === b.slice(5)); return u ? `${u.display_name}${u.disabled_at ? T('（已停用）') : u.role === 'observer' ? T('（旁观者）') : ''}` : null; }
    return null;
  };
  const stale = (x) => { if (mode === 'users') return !live.some((u) => u.id === x); const b = base(x); return b.startsWith('user:') && b !== 'user:lead' && !live.some((u) => u.id === b.slice(5)); };
  const draw = () => {
    const opt = (v, t) => `<option value="${esc(v)}">${esc(t)}</option>`;
    const has = (v) => val.some((x) => (mode === 'users' ? x : base(x)) === v);
    const userOpts = live.filter((u) => !has(mode === 'users' ? u.id : `user:${u.id}`)).map((u) => opt(mode === 'users' ? u.id : `user:${u.id}`, u.display_name)).join('');
    const roleOpts = mode === 'users' ? '' : [['user:lead', T('负责人')], ['group:*', T('所有成员')], ['on_duty', hasDuty ? T('值班人（按值班表）') : T('值班人（需先创建值班表）')], ...(parties ? [['parties', T('冲突双方')]] : [['requester', T('需求提出人（谁提的需求就由谁来答 / 签收 —— 按任务自动认人；没人提的任务就跳过这一项）')]])].filter(([v]) => !has(v)).map(([v, t]) => (v === 'on_duty' && !hasDuty ? `<option value="" disabled>${esc(t)}</option>` : opt(v, t))).join('');
    const tagOpts = mode === 'users' ? '' : tags.filter((t) => !has(`group:${t}`)).map((t) => opt(`group:${t}`, T('标签 {tag}（{names}）', { tag: t, names: live.filter((u) => (u.domain_tags ?? []).includes(t)).map((u) => u.display_name).join(T('、')) }))).join('');
    el.classList.add('rp');
    el.innerHTML = `<span class="chips">${val.map((x, i) => { const l = label(x); return `<span class="chip${x.startsWith('inform:') ? ' inf' : ''}${l === null || stale(x) ? ' bad' : ''}" title="${esc(l === null ? T('无法识别的值：{v}', { v: x }) : stale(x) ? T('该成员已停用或为旁观者，不会收到事项') : mode === 'users' || base(x) === 'parties' ? '' : x.startsWith('inform:') ? T('仅知会，无需答复。点击切换为「需答复」') : T('需答复。点击切换为「仅知会」'))}">${mode === 'users' && i ? '<span class="mute" style="margin-right:4px">→</span>' : ''}${mode === 'users' || base(x) === 'parties' ? `<span>${esc(l ?? x)}</span>` : `<button type="button" class="chip-t" data-t="${i}" aria-label="${esc(pre(x.startsWith('inform:') ? T('{name}：仅知会（按一下改为需答复）', { name: l ?? x }) : T('{name}：需答复（按一下改为仅知会）', { name: l ?? x })))}" title="${x.startsWith('inform:') ? T('仅知会，无需答复。点击切换为「需答复」') : T('需答复。点击切换为「仅知会」')}">${x.startsWith('inform:') ? T('知会 ') : ''}${esc(l ?? x)}</button>`}<button type="button" data-x="${i}" title="${T('移除')}" aria-label="${esc(pre(T('移除 {name}', { name: l ?? x })))}">×</button></span>`; }).join('') || `<span class="mute small">${T('未指定')}</span>`}</span>
      <select class="rp-add" aria-label="${esc(pre(mode === 'users' ? T('添加值班的人') : T('添加接收人')))}"><option value="">${mode === 'users' ? T('＋ 添加…') : T('＋ 添加（默认需答复）…')}</option>${roleOpts ? `<optgroup label="${T('按角色')}">${roleOpts}</optgroup>` : ''}${userOpts ? `<optgroup label="${T('成员')}">${userOpts}</optgroup>` : ''}${tagOpts ? `<optgroup label="${T('按标签')}">${tagOpts}</optgroup>` : ''}</select>`;
    el.querySelectorAll('button[data-x]').forEach((b) => b.onclick = () => { val.splice(Number(b.dataset.x), 1); draw(); onChange?.(val); el.querySelector('.rp-add')?.focus(); });
    el.querySelectorAll('button[data-t]').forEach((t) => t.onclick = () => { const i = Number(t.dataset.t); val[i] = val[i].startsWith('inform:') ? base(val[i]) : `inform:${val[i]}`; draw(); onChange?.(val); el.querySelector(`button[data-t="${i}"]`)?.focus(); });
    onPick(el.querySelector('.rp-add'), (v) => {
      if (!v) return;
      val = val.filter((x) => base(x) !== v); val.push(v);
      draw(); onChange?.(val);
    }, { refocus: () => el.querySelector('.rp-add') });
  };
  el._get = () => [...val];
  draw();
}
let routingCtx = { key: '', box: '#routing', tag: '#routingTag' };
async function renderRouting() {
  const RK = routingCtx.key, BOX = $(routingCtx.box);
  for (const b of ['#routing', '#projRouting']) if (b !== routingCtx.box && $(b)) $(b).innerHTML = '';   // 同一套控件 id，只许有一份在页面上
  try { routingData = await api(`/api/routing?project=${encodeURIComponent(RK)}`); } catch (e) { BOX.innerHTML = `<span class="mute">${esc(e.message)}</span>`; return; }
  const R = routingData;
  const uname = (id) => (R.users.find((u) => u.id === id)?.display_name) ?? id;
  $(routingCtx.tag).textContent = `${RK ? T('本项目') : T('适用于无项目的任务')} · ${T('模板：{name}', { name: T(R.templates[R.template]?.label ?? R.template) })}${R.persisted ? '' : T('（默认，未修改）')}`;
  const diffNote = (R.diff.added.length || R.diff.removed.length || R.diff.changed.length) ? T('已基于模板修改（修改 {changed} 行，新增 {added} 行，删除 {removed} 行）', { changed: R.diff.changed.length, added: R.diff.added.length, removed: R.diff.removed.length }) : T('与模板一致');
  const pv = R.preview;
  const pvText = pv.questions ? T('按当前设置回放历史 {n} 个事项：{list}；无人接收 {none} 个', { n: pv.questions, list: Object.entries(pv.interruptions).map(([u, n]) => T('{name} {n} 次', { name: uname(u), n })).join(T('，')) || T('无人需答复'), none: pv.unaddressed.length }) : ''
  // 值班表的结果（此刻谁值、接下来几次交接）与每条代班替的是谁：只列规则时，写着"张三出差"、其实那几天轮到李四，看不出来
  const dv = R.dutyView;
  const coverAhead = !!dv && (R.duty?.overrides ?? []).some((o) => o.to >= dv.today);
  const nextList = dv ? dv.next.map((n) => T('{when} 起 {name}', { when: esc(fmtWhen(n.at, { tz: dv.tz })), name: esc(uname(n.user)) })).join(T('；')) : '';
  const dutyNow = !dv ? '' : `<div style="margin-top:4px">${dv.now.started || dv.now.override
    ? T('此刻值班：<b>{name}</b>', { name: esc(uname(dv.now.user)) }) + (dv.now.override ? T('（代班，到 {to} 当天结束；轮换本该是 {who}）', { to: esc(dv.now.override.to), who: esc(uname(dv.now.rotationUser ?? dv.now.user)) }) : '')
    : T('还没开始')}${dv.next.length ? ` · ${coverAhead ? T('按轮换接下来（代班另见下面，那几天以代班为准）：{list}', { list: nextList }) : T('接下来：{list}', { list: nextList })}` : ''}</div>${dv.used ? ''
    : `<div style="color:var(--wait)">${T('路由表里还没有哪类决策选了「值班人（按值班表）」，所以值班表现在不起作用。要让值班人处理某类决策，到上面「按决策类型」那一行加上它。')}</div>`}`;
  const coverNote = (i, o) => {
    const covers = dv?.covers?.[i] ?? [], was = covers.filter((u) => u !== o.user);
    const named = o.note ? R.users.filter((u) => u.id !== o.user && !covers.includes(u.id) && u.display_name && o.note.includes(u.display_name)) : [];
    const warn = named.length && was.length ? ` <span style="color:var(--wait)">${T('说明里提到 {named}，但那几天轮换排的是 {was}：日期对吗？', { named: named.map((u) => esc(u.display_name)).join(T('、')), was: was.map(uname).map(esc).join(T('、')) })}</span>` : '';
    return (was.length ? ` <span>${T('（替 {names}）', { names: was.map(uname).map(esc).join(T('、')) })}</span>` : (covers.length ? ` <span class="mute">${T('（那几天本来就轮到他）')}</span>` : '')) + warn;
  };
  BOX.innerHTML = `${rerouteHtml(RK, uname)}
    <div class="row small"><label>${T('模板')} <select id="rtTpl">${Object.entries(R.templates).map(([k, t]) => `<option value="${esc(k)}" ${k === R.template ? 'selected' : ''}>${esc(Tc('dtype', t.label))}${T(' —— ')}${esc(T(t.summary))}</option>`).join('')}</select></label>
      <button id="rtApply" title="${T('用所选模板覆盖整张路由表，已修改的行将丢失')}">${T('应用模板')}</button> <span class="mute">${esc(diffNote)}</span></div>
    <div id="rtPlaceholders" class="row small" style="margin-top:6px"></div>
    <div style="margin-top:12px"><b>${T('按决策类型')}</b> <span class="small mute">${T('修改完整路由表中该类型、范围 *、顺位 0 的行；点击名称在「需答复 / 仅知会」间切换')}</span></div>
    <table class="rt"><tr><th>${T('决策类型')}</th><th>${T('接收人')}</th><th></th></tr>
      ${Object.entries(R.types).map(([k, t]) => `<tr><td><abbr title="${esc(T(t.desc))}">${esc(Tc('dtype', t.label))}</abbr></td><td><span data-own="${esc(k)}"></span>${(R.knobs.ownership[k] ?? []).length > 1 && (R.knobs.ownershipQuorum?.[k] ?? '1') === '1' ? `<div class="small mute" style="margin-top:2px">${T('这几个人里<b>任一人</b>答了就算（谁先答算谁的）。要每个人都答：到下面「完整路由表」把这一行的法定人数改成 all')}</div>` : ''}${k === 'signoff' ? `<div class="small mute" style="margin-top:2px">${T('谁提的需求谁签收：提需求的人在这一行里（直接点名，或选「需求提出人」）时，必须提需求的人亲自签了才算数，别人替不了')}</div>` : ''}</td>
        <td class="act"><button data-ownset="${esc(k)}" class="small primary" aria-label="${esc(T('保存「{type}」的接收人', { type: Tc('dtype', t.label) }))}" disabled>${T('保存')}</button></td></tr>`).join('')}
    </table>
    <div class="small" style="margin-top:8px">${T('<b>参与成员</b>（路由表里会收到事项的人，负责人除外）：')}${R.knobs.interveners.length ? R.knobs.interveners.map((u) => `${esc(uname(u))} <button data-rm="${esc(u)}" class="small">${T('移出')}</button>`).join(' ') : `<span class="mute">${T('没有（只有负责人会收到）')}</span>`}</div>
    <div class="small" style="margin-top:8px">${T('<b>值班表</b>：')}${R.duty ? T('{users}：从 {date} {time} 起，每 {n} 天在这个钟点交接给下一位（部署时区 {tz}）', { users: R.duty.users.map(uname).map(esc).join(' → '), date: esc(R.duty.startDay), time: esc(R.duty.startTime), n: esc(R.duty.period_days), tz: esc(R.duty.tz) }) : `<span class="mute">${T('未设置')}</span>`}${dutyNow}
      <div class="row" style="margin-top:4px"><span id="dutyUsers"></span> <span class="mute">${T('起点')}</span> <input id="dutyStart" type="date" value="${esc(R.duty?.startDay ?? '')}" aria-label="${T('起点日期（部署时区）')}"> <input id="dutyTime" type="time" value="${esc(R.duty?.startTime ?? '09:00')}" title="${T('几点交接（部署时区）')}" aria-label="${T('几点交接（部署时区）')}"> <input id="dutyPeriod" type="number" value="${esc(R.duty?.period_days ?? 7)}" style="width:60px" title="${T('轮换周期（天）')}" aria-label="${T('轮换周期（天）')}"> <span class="mute">${T('天轮换')}</span> <button id="dutySet" class="small">${T('保存值班表')}</button></div>
      ${R.duty ? `<div style="margin-top:6px">${T('<b>代班</b>：某几天整天（部署时区 0:00–24:00，含首尾两天）由指定的人值，不管轮换轮到谁；轮换照常往下数。添加、删除立即生效。')}
        ${(R.duty.overrides ?? []).map((o, i) => `<div class="row"><span class="mono">${esc(o.from)}${o.to !== o.from ? ` – ${esc(o.to)}` : ''}</span> ${esc(uname(o.user))}${coverNote(i, o)}${o.note ? ` <span class="mute">${esc(o.note)}</span>` : ''} <button data-swrm="${i}" class="small">${T('删除')}</button></div>`).join('')}
        <div class="row" style="margin-top:4px"><input id="swFrom" type="date" aria-label="${T('代班从哪天')}"> – <input id="swTo" type="date" title="${T('只代一天可以不填')}" aria-label="${T('代到哪天（含这天；只代一天可以不填）')}"> <select id="swUser" aria-label="${T('谁来代班')}">${R.users.filter((u) => u.role !== 'observer' && !u.disabled_at).map((u) => `<option value="${esc(u.id)}">${esc(u.display_name)}</option>`).join('')}</select> <input id="swNote" style="width:140px" maxlength="200" placeholder="${T('说明（可不填）')}" aria-label="${T('说明（可不填）')}"> <button id="swAdd" class="small">${T('添加代班')}</button></div></div>` : ''}</div>
    <div class="small mute" style="margin-top:8px">${esc(pvText)}</div>
    <details style="margin-top:10px"><summary>${T('完整路由表')}</summary>
      <table class="rt" id="rtTable"><tr><th>${T('决策类型')}</th><th title="${T('路径前缀；* = 全部')}">${T('范围')}</th><th title="${T('同类型同范围可有多行，超时按顺位转下一行')}">${T('顺位')}</th><th>${T('接收人')}</th><th title="${T('要几个人表态才算数：1 = 接收人里任一人答了就算；all = 这一行的接收人都要答（会签，比如「需求提出人 + 负责人」都要签）；写数字 = 至少这么多人')}">${T('法定人数（1 / all）')}</th><th>${T('冲突策略')}</th><th>${T('超时动作')}</th><th title="${T('30m 分钟 / 8h 小时 / 1d 天 / 1bd 工作日')}">${T('超时时间')}</th><th></th></tr></table>
      <div class="row" style="margin-top:6px"><button id="rtAddRow" class="small">${T('添加行')}</button><button id="rtCheck" class="small" title="${T('按保存规则校验（每类至少一行范围 *、法定人数不超过接收人数、部分类型必须包含负责人等），不保存')}">${T('校验')}</button><button id="rtSave" class="primary small">${T('保存路由表')}</button><span id="rtErrors" class="small" style="color:var(--bad)" role="alert"></span></div>
    </details>`;
  const tplSel = $('#rtTpl');
  const renderPh = () => { const ph = R.templates[tplSel.value]?.placeholders ?? {}; $('#rtPlaceholders').innerHTML = Object.entries(ph).map(([p, d]) => `<label>${esc(T(d))} <select data-ph="${esc(p)}">${R.users.filter((u) => u.role !== 'observer').map((u) => `<option value="${esc(u.id)}" ${R.bindings?.[p] === u.id ? 'selected' : ''}>${esc(u.display_name)}</option>`).join('')}</select></label>`).join(''); };
  // 选了还没应用时说一声（选了「按目录分工」页面一点没变的话，人会以为下拉框坏了）
  tplSel.onchange = () => { renderPh(); $('#rtApply').textContent = tplSel.value === R.template ? T('应用模板') : T('应用「{name}」（选好了，点这里才生效）', { name: T(R.templates[tplSel.value]?.label ?? tplSel.value) }); };
  renderPh();
  $('#rtApply').onclick = async () => {
    if (!confirm(T('用所选模板覆盖整张路由表？已修改的行将丢失。'))) return;
    const bindings = Object.fromEntries([...document.querySelectorAll('select[data-ph]')].map((s) => [s.dataset.ph, s.value]));
    try { const r = await api('/api/routing', { project: RK, version: R.version, action: 'template', name: tplSel.value, bindings }); toast(T('已应用模板') + reroutedNote(r)); renderRouting(); } catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('span[data-own]').forEach((el) => { const k = el.dataset.own, cur = R.knobs.ownership[k] ?? [];
    recPicker(el, cur, { users: R.users, parties: k === 'conflict', hasDuty: !!R.duty?.users?.length, ctx: Tc('dtype', R.types[k]?.label ?? k), onChange: (v) => { document.querySelector(`button[data-ownset="${k}"]`).disabled = JSON.stringify(v) === JSON.stringify(cur); } }); });
  document.querySelectorAll('button[data-ownset]').forEach((b) => b.onclick = async () => {
    const recipients = document.querySelector(`span[data-own="${b.dataset.ownset}"]`)._get(); if (!recipients.length) return toast(T('至少需要一个接收人'), true);
    try { const r = await api('/api/routing', { project: RK, version: R.version, action: 'owner', type: b.dataset.ownset, recipients }); toast(T('已保存') + reroutedNote(r)); renderRouting(); } catch (e) { toast(e.message, true); }
  });
  document.querySelectorAll('button[data-rm]').forEach((b) => b.onclick = async () => { try { const r = await api('/api/routing', { project: RK, version: R.version, action: 'remove', userId: b.dataset.rm }); toast(T('已移出') + reroutedNote(r)); renderRouting(); } catch (e) { toast(e.message, true); } });
  $('#dutySet').onclick = async () => {
    const users = $('#dutyUsers')._get();
    if (!users.length) return toast(T('值班表至少需要一名成员'), true);
    // 起点按部署时区的日期与钟点交给服务端换算（原来 Date.parse 把日期当 UTC 0 点）；没填日期 = 今天
    const startDay = $('#dutyStart').value || null, startTime = $('#dutyTime').value || '00:00';
    try { const r = await api('/api/routing', { project: RK, version: R.version, action: 'duty', users, ...(startDay ? { startDay, startTime } : { startAt: Date.now() }), periodDays: Number($('#dutyPeriod').value || 7) }); toast(T('值班表已保存') + reroutedNote(r)); renderRouting(); } catch (e) { toast(e.message, true); }
  };
  const saveSwaps = async (overrides, done) => {
    try { const r = await api('/api/routing', { project: RK, version: R.version, action: 'dutyOverrides', overrides }); toast(done + reroutedNote(r)); renderRouting(); } catch (e) { toast(e.message, true); }
  };
  if ($('#swAdd')) $('#swAdd').onclick = () => {
    const from = $('#swFrom').value, to = $('#swTo').value || from;
    if (!from) return toast(T('先选代班的日期'), true);
    void saveSwaps([...(R.duty.overrides ?? []), { from, to, user: $('#swUser').value, note: $('#swNote').value.trim() }], T('代班已添加'));
  };
  document.querySelectorAll('button[data-swrm]').forEach((b) => b.onclick = () => saveSwaps((R.duty.overrides ?? []).filter((_, i) => i !== Number(b.dataset.swrm)), T('代班已删除')));
  recPicker($('#dutyUsers'), R.duty?.users ?? [], { users: R.users, mode: 'users' });
  // 完整表
  const table = $('#rtTable');
  const rowHtml = (r) => `<tr><td><select class="c-type" aria-label="${T('决策类型')}">${Object.entries(R.types).map(([k, t]) => `<option value="${esc(k)}" ${k === r.decision_type ? 'selected' : ''}>${esc(Tc('dtype', t.label))}</option>`).join('')}</select></td>
    <td><input class="c-scope" aria-label="${T('范围')}" value="${esc(r.scope)}" style="width:110px" placeholder="${T('* 或 frontend/')}" title="${T('这一行管哪些文件：* = 全部；写目录名加斜杠，如 frontend/，包括它下面所有子目录（写成 frontend/** 也行，保存时会换成 frontend/）。AI 自己定的事、矛盾事项按涉及的目录找这一行的人')}"></td><td><input class="c-pos" aria-label="${T('顺位')}" type="number" value="${esc(r.position)}" style="width:50px" title="${T('同类型同范围可有多行，超时按顺位转下一行')}"></td>
    <td><span class="c-rec" data-rec="${esc(JSON.stringify(r.recipients))}"></span></td>
    <td><input class="c-quo" aria-label="${T('法定人数（1 / all）')}" value="${esc(r.quorum)}" style="width:50px" placeholder="1 / all" title="${T('1 = 任一人答了就算；all = 这一行的接收人都要答（会签）；写数字 = 至少这么多人')}"></td>
    <td><select class="c-pol" aria-label="${T('冲突策略')}"><option value="block" ${r.conflict_policy === 'block' ? 'selected' : ''}>${T('挂起并生成冲突事项')}</option><option value="latest" ${r.conflict_policy === 'latest' ? 'selected' : ''}>${T('以最新答复为准')}</option></select></td>
    <td><select class="c-to" aria-label="${T('超时动作')}"><option value="hang" ${r.timeout_action === 'hang' ? 'selected' : ''}>${T('持续等待')}</option><option value="next" ${r.timeout_action === 'next' ? 'selected' : ''}>${T('转下一顺位')}</option><option value="default" ${r.timeout_action === 'default' ? 'selected' : ''}>${T('按默认处理')}</option></select></td>
    <td><input class="c-after" aria-label="${T('超时时间')}" value="${esc(r.timeout_after ?? '')}" style="width:60px" placeholder="${T('如 8h / 1bd')}" title="${T('30m 分钟 / 8h 小时 / 1d 天 / 1bd 工作日')}"></td>
    <td><button class="c-del small">${T('删除')}</button></td></tr>`;
  for (const r of R.rows) table.insertAdjacentHTML('beforeend', rowHtml(r));
  const bind = () => { table.querySelectorAll('.c-del').forEach((b) => b.onclick = () => b.closest('tr').remove());
    table.querySelectorAll('.c-rec').forEach((el) => { if (el._get) return; const tr = el.closest('tr'); const mk = () => recPicker(el, el._get ? el._get() : JSON.parse(el.dataset.rec), { users: R.users, parties: tr.querySelector('.c-type').value === 'conflict', hasDuty: !!R.duty?.users?.length }); mk(); tr.querySelector('.c-type').onchange = mk; }); };
  bind();
  $('#rtAddRow').onclick = () => { table.insertAdjacentHTML('beforeend', rowHtml({ decision_type: 'spec_choice', scope: '*', position: 0, recipients: ['user:lead'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null })); bind(); };
  const collect = () => [...table.querySelectorAll('tr')].slice(1).map((tr) => ({ decision_type: tr.querySelector('.c-type').value, scope: tr.querySelector('.c-scope').value.trim() || '*', position: Number(tr.querySelector('.c-pos').value || 0),
    recipients: tr.querySelector('.c-rec')._get(), quorum: tr.querySelector('.c-quo').value.trim() || '1', conflict_policy: tr.querySelector('.c-pol').value, timeout_action: tr.querySelector('.c-to').value, timeout_after: tr.querySelector('.c-after').value.trim() || null }));
  if ($('#rtRerouteOk')) $('#rtRerouteOk').onclick = () => { lastReroute = null; $('#rtRerouteOk').parentElement.remove(); };
  $('#rtCheck').onclick = async () => { try { const r = await api('/api/routing', { project: RK, action: 'validate', rows: collect() }); $('#rtErrors').textContent = r.result.errors.length ? r.result.errors.map((e) => e.msg).join(T('；')) : T('校验通过'); } catch (e) { toast(e.message, true); } };
  $('#rtSave').onclick = async () => { try { const r = await api('/api/routing', { project: RK, version: R.version, action: 'rows', rows: collect() }); toast(T('路由表已保存') + reroutedNote(r)); renderRouting(); } catch (e) { if (e.data?.conflict) return toast(e.message, true); $('#rtErrors').textContent = e.message; toast(T('保存失败，详见错误信息'), true); } };
}
