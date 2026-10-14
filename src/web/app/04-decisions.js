// ── 已定的约定（5c · 决定登记）────────────────────────────────────────
// 只读：这是**约定**不是配置 —— 人批准过、有取代关系、改要走流程。所以它留在项目主区、
// 不进设置页，也没有任何编辑按钮：要改一条，去对应的任务页提变更或在答复里说，
// 系统比对到冲突会生成一条让人拍板的事项（以新为准 / 以旧为准）。
async function loadDecisions(projectId) {
  const box = $('#projDec'), tag = $('#projDecTag');
  let data;
  // 每次重画都现拉：两条带索引的 SELECT，比维护一份会过期的缓存便宜 —— 而清单过期
  // 正是这个功能最不能出的错（"以新为准"点完了，页面上旧的还在，人会以为没生效）。
  try { data = await api(`/api/projects/${projectId}/decisions`); }
  catch (e) { box.innerHTML = `<span class="mute small">${esc(e.message)}</span>`; tag.textContent = ''; return; }
  const { active, voided, sources } = data;
  tag.textContent = active.length ? `${T('{n} 条仍然有效', { n: active.length })}${voided.length ? T('，{n} 条已作废', { n: voided.length }) : ''}` : T('还没有');
  const row = (d, dead = false) => `<div class="item${dead ? ' off' : ''}" style="margin-top:6px"><div class="small mute">${T('〔{kind}〕', { kind: esc(T(sources[d.source_kind] ?? d.source_kind)) })}${esc(d.subject)}${d.byName ? ` · ${esc(d.byName)}` : ''} · ${T('{t}前', { t: ago(d.decided_at) })}${(d.scope ?? []).length ? ` · ${T('范围 {list}', { list: d.scope.slice(0, 4).map(esc).join(T('、')) })}` : ` · ${T('全项目')}`}${d.task_id ? ` · ${T('出自 {link}', { link: `<a href="#${esc(d.task_id)}" title="${T('这条约定是在这个任务里定下来的（与左边的「范围」无关：范围说的是它管哪些文件）。要改它，去那个任务页提变更或在答复里写新的说法')}">${esc(d.taskTitle ?? d.task_id)}</a>` })}` : ''}</div>${d.disputed ? `<div class="small" style="color:var(--wait)">${T('⚠ 正在被争议：有人说了与它相反的话，还没有结论。在定下来之前它仍然算数，但别把它当成板上钉钉的依据 —— 去那个任务页把冲突事项选一条。')}</div>` : ''}
    <div class="body" style="white-space:pre-wrap">${esc(d.statement)}</div>${dead ? `<div class="small mute">${d.supersededBy
      ? `${T('已作废：{t}前起改以「{s}」为准', { t: ago(d.supersededBy.decided_at), s: `${esc(String(d.supersededBy.statement).split('\n')[0].slice(0, 60))}${String(d.supersededBy.statement).length > 60 ? '…' : ''}` })}${d.supersededBy.byName ? T('（{name} 定的）', { name: esc(d.supersededBy.byName) }) : ''}${/事项|\bitem\b/i.test(d.void_reason ?? '') ? T(' · 经冲突事项判定「以新为准」') : ''}`
      : `${T('已作废')}${d.void_reason ? `${T('：')}${esc(d.void_reason)}` : ''}`}</div>` : ''}</div>`;
  box.innerHTML = (active.length
    ? `<div class="small mute">${T('下面这些是人拍过板的约定，<b>仍然有效</b>：系统起草新方案、执行、验收时都照它们来。这里只读。')}<br>
       ${T('要改其中一条：去它右边那个任务页提变更、或在答复里直接写新的说法。系统比对到冲突会生成一条事项，由人选「以新为准」还是「以旧为准」。')}
       ${T('<b>这条事项不会拦住任何事</b> —— 你这次说的当场就生效了，而旧的那条在你选定之前仍然算数，下面会给它标上「正在被争议」。')}
       ${T('两条都在的这段时间里，别人和 AI 看到的也是这个标记，所以尽快选一条。')}<br>
       ${T('与上面折叠的「原文」不一样：原文是建项目 / 添加任务时的<b>输入</b>，起草方案时逐字引用；这张清单是<b>此刻的结论</b>，两者对不上时以清单为准。')}</div>
       ${active.map((d) => row(d)).join('')}`
    : `<div class="small mute">${T('还没有任何约定。有结论的待决事项、批准过的契约与计划变更、改过的项目目标都会自动进来。')}</div>`)
    + (voided.length ? `<details style="margin-top:10px"><summary class="small mute">${T('已作废的 {n} 条（保留记录）', { n: voided.length })}</summary>${voided.map((d) => row(d, true)).join('')}</details>` : '');
}

/** 项目层的写操作都走这里：一次请求 + 刷新侧栏、收件箱与当前页。 */
async function projAct(projectId, action, body, msg) {
  try { await api(`/api/projects/${projectId}/${action}`, body); toast(msg); await loadTasks(); await renderDigest(); refresh(); if (view === 'projset') renderProjSet(); return true; }
  catch (e) { toast(e.message, true); return false; }
}

// ── 项目设置（#p/<id>/settings）────────────────────────────────────────
// 只放"人写的、变化慢、影响将来"的配置，以及不可逆的动作。项目页那边是状态与日常动作，两者不混。
// 非负责人进来只读，且看不到决策路由与危险区。
let psPane = 'general';
