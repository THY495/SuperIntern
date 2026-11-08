// ── 交付后回路：交付卡 —— PR 开着没有、CI 过没过、修到哪了、PR 上的意见 ─────────────────
// 任务页与项目页共用。数据是服务端的 prView（守护进程轮询来的，最近一次看到的样子）。
// 认知走查之后的形状：谁授权的写人名；每种状态只说这一种状态下的事（不在每张卡上重复一段规则）；
// 成员的意见与不是成员的分开放；问了人的直接链到那条事项。

const PR_STATE = { open: () => T('开着'), merged: () => T('已合并'), closed: () => T('已关闭（没合并）') };
const PERM_NAME = { 'checks:read': 'Checks', 'statuses:read': 'Commit statuses', 'actions:read': 'Actions', 'pull_requests:read': 'Pull requests' };
// 授权 AI 跟进时问的那一句（交付时、交付后在卡片上授权，同一句）
const autofixAsk = () => T('授权 AI 跟进这个 PR？\n\n确定：CI 没过，AI 自动修，最多 2 轮，还没过就来问你；修好推到同一个 PR（不会合并，合并由人在 GitHub 上做）。另外，有权交付这个任务的成员在 GitHub 上点「Request changes」，也直接交给 AI 改，记在那个成员名下。\n\n取消：不授权。CI 没过、有人要求修改，都先在任务页问你。\n\n两种都能改：任务页「交付的 PR」里随时授权或收回。');
const prWho = (v) => (me && v.pr.by === me.id ? T('你') : esc(v.pr.byName ?? T('交付人')));

function prCiLine(v) {
  const st = v.state;
  if (!st) return `<span class="mute">${T('还没看过：自动运行开着的话一两分钟内会看；也可以点「立即刷新」')}</span>`;
  const ci = st.ci ?? { state: 'none', items: [] };
  const failed = (ci.items ?? []).filter((x) => x.state === 'failure');
  const missing = (st.missing ?? []).filter((m) => m !== 'pull_requests:read');
  if (ci.state === 'unknown') return `<span style="color:var(--wait)">${T('看不到')}</span><div class="small" style="margin-top:2px">${T('读 PR 用的连接（{c}）没有 {perms} 的读权限，所以 CI 没过也不会自动修。', { c: esc(st.credential ?? '?'), perms: esc(missing.map((m) => PERM_NAME[m] ?? m).join(' / ')) })}</div>`
    + `<div class="small mute">${T('要 GitHub 上管这个 App 的人（一般是组织管理员）做：App 设置 → Permissions 里把这几项设成 Read，再到组织的 GitHub Apps 安装页点「接受新权限」。做完回来点「立即刷新」。')}</div>`;
  if (ci.state === 'failure') return `<span class="bad">${T('✗ 没过：{names}', { names: failed.map((f) => (f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>` : esc(f.name))).join(T('、')) })}</span>`;
  if (ci.state === 'pending') return `<span style="color:var(--wait)">${T('● 在跑（{n} 项）', { n: esc((ci.items ?? []).length) })}</span>`;
  if (ci.state === 'success') return `<span style="color:var(--ok)">${T('✓ 全过了（{n} 项）', { n: esc((ci.items ?? []).length) })}</span>${st.state === 'open' ? `<span class="mute">${T('：合并在 GitHub 上由人来做')}</span>` : ''}`;
  return `<span class="mute">${T('这个提交上没有 CI（仓库没配检查，或者还没开始跑）')}</span>`;
}

// 修到哪了：一句话说清现在是谁在等什么，下一步会发生什么
function prFixLine(v) {
  const f = v.fix;
  if (!f || !f.mode || v.state?.state !== 'open') return '';
  const goto = f.questionId ? ` <a href="#" data-prgoto="${esc(f.questionId)}">${T('去回答')}</a>` : '';
  if (f.mode === 'asked') return `<div class="item flag small" style="margin-top:6px">${T('<b>等你定</b>：没自动修 —— {why}。', { why: esc(f.why ?? '') })}${T('回一句让 AI 接着修（比如"按日志修"），或回「不用修」。')}${goto}</div>`;
  // 项目整体交付的 PR：起草了一轮「添加任务」修它（批准在本页上方那一块；合并之后要再交付一次 PR 才更新）
  if (f.mode === 'drafted') return `<div class="small" style="margin-top:4px">${T('CI 没过，按{who}交付时的授权起草了一轮修复（第 {k}/{max} 轮），在本页上方「正在添加任务」里看 / 批。新任务合并后，再点一次「交付」，PR 才会更新、CI 才会再跑。', { who: prWho(v), k: esc(f.attempts), max: esc(f.max ?? v.max ?? 2) })}</div>`;
  if (f.redeliverError) return `<div class="item flag small" style="margin-top:6px">${T('<b>等你定</b>：改了一轮，没推回 PR —— {why}', { why: esc(f.redeliverError) })}${goto}</div>`;
  const what = f.cause === 'review' ? T('按评审意见改') : T('按 CI 失败修（第 {k}/{max} 次）', { k: esc(f.attempts), max: esc(f.max ?? v.max ?? 2) });
  if (f.redelivered) return `<div class="small" style="margin-top:4px">${T('AI {what}，改好的 {head} 已推回 PR，等 CI 再跑。', { what, head: `<span class="mono">${esc(String(f.redelivered).slice(0, 8))}</span>` })} <a href="#" data-prdiff>${T('看改了什么')}</a></div>`;
  return `<div class="small" style="margin-top:4px">${T('AI 正在{what}，用的是{who}给的授权；改好自动推回同一个 PR，不用你点。', { what, who: prWho(v) })}${v.pr.signed ? T('交付时签过收，所以新版本要再签一次才推。') : ''}`
    + (detail?.can?.pause && ['running', 'waiting'].includes(detail.task.status) ? ` <button class="small ghost" data-prpause title="${T('临时停一下：AI 手上这一下做完就停。没写完的改动先存起来，点「继续」后接着做；不会推半成品')}">${T('暂停任务')}</button>` : '') + '</div>';
}

// AI 跟进：现状一句话 + 开关（任务的 PR；有交付权的人能改）。授权的人成了新的授权锚点，所以按钮上写"由你"
function prAutoLine(v, { canAct }) {
  if (v.state && v.state.state !== 'open') return '';
  const max = v.max ?? 2;
  const text = !v.pr.autofix ? T('AI 跟进：没授权，CI 没过、有人要求修改，都先在本页问你。')
    : max === 0 ? T('AI 跟进（{who}授权的）：项目设成 CI 没过不自动修；有权交付的成员要求修改，直接交给 AI。', { who: prWho(v) })
    : T('AI 跟进（{who}授权的）：CI 没过，AI 自动修，最多 {max} 轮，还没过就来问你；有权交付的成员要求修改，直接交给 AI。', { who: prWho(v), max: esc(max) });
  const btn = !canAct ? ''
    : v.pr.autofix ? ` <button class="small ghost" data-prauto="off" title="${T('之后都先问人；已经交给 AI 的那一轮照旧做完')}">${T('收回授权')}</button>`
    : ` <button class="small" data-prauto="on">${T('由你授权 AI 跟进')}</button>`;
  return `<div class="small" style="margin-top:4px"><span class="${v.pr.autofix ? '' : 'mute'}">${text}</span>${btn}</div>`;
}

const PR_KIND = { review: () => T('评审'), comment: () => T('评论'), line: () => T('行内评论') };
const PR_REVIEW = { CHANGES_REQUESTED: () => T('要求修改'), APPROVED: () => T('批准'), COMMENTED: () => T('评论'), DISMISSED: () => T('已撤销') };

function prCommentRow(c, { canAct, project }) {
  const who = c.authorName ? `${esc(c.authorName)} <span class="mute">@${esc(c.author.login)}</span>` : `@${esc(c.author.login)}`;
  const kind = c.kind === 'review' ? `${esc(PR_KIND.review())} · ${esc((PR_REVIEW[c.reviewState] ?? (() => c.reviewState))())}` : c.kind === 'line' ? `${esc(PR_KIND.line())} · <span class="mono">${esc(c.path ?? '')}:${esc(c.line ?? '')}</span>` : esc(PR_KIND.comment());
  const d = c.disposition;
  const status = !d ? ''
    : d.status === 'auto' ? `<span class="small" style="color:var(--ok)">${T('已交给 AI（评审人有权交付，系统直接转的）')}</span>`
    : d.status === 'fixed' ? `<span class="small" style="color:var(--ok)">${T('已交给 AI')}</span>`
    : d.status === 'dismissed' ? `<span class="small mute">${T('不用管')}</span>${canAct ? ` <button class="small ghost" data-prundo="${esc(c.id)}">${T('撤回')}</button>` : ''}`
    : d.status === 'with_review' ? `<span class="small mute">${T('随评审一起交给了 AI')}</span>`
    : d.status === 'blocked' ? `<span class="small" style="color:var(--wait)">${T('没自动转：{why}', { why: esc(d.why ?? '') })}</span>` : '';
  const fixB = project ? '' : `<button class="small${c.author.member ? '' : ' ghost'}" data-prfix="${esc(c.id)}" title="${T('作为你发的一条修正交给 AI，交出去撤不回；改主意了，在本页下面给任务发一条修正说明不用改了')}">${c.author.member ? T('让 AI 按这条改') : T('看过了，让 AI 按这条改')}</button>`;
  const dropB = `<button class="small${c.author.member ? ' ghost' : ''}" data-prdismiss="${esc(c.id)}" title="${T('只在看板上记下，不回复 GitHub；点错了到「处理过的」里撤回')}">${T('不用管')}</button>`;
  const buttons = canAct && c.pending ? `<span class="row" style="gap:6px">${c.author.member ? fixB + dropB : dropB + fixB}</span>` : '';
  return `<div class="item" style="margin-top:6px"><div class="row small"><span>${who}</span> <span class="mute">${kind}${c.at ? ` · ${T('{t}前', { t: esc(ago(c.at)) })}` : ''}</span>${c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">${T('在 GitHub 上看')}</a>` : ''}<span class="grow"></span>${status}${buttons}</div>
    ${c.body ? `<pre class="small" style="white-space:pre-wrap;margin:4px 0 0;max-height:12em;overflow:auto">${esc(c.body)}</pre>` : ''}</div>`;
}

/** v = prView；project：项目整体交付的 PR（意见只能「不用管」，修要加任务）；canAct：能处理意见的人（有权交付） */
function prCardHtml(v, { canAct = false, project = false } = {}) {
  if (!v) return '';
  const st = v.state;
  const open = !st || st.state === 'open';
  const pending = v.comments.filter((c) => c.pending);
  const members = pending.filter((c) => c.author.member), outsiders = pending.filter((c) => !c.author.member);
  const done = v.comments.filter((c) => !c.pending);
  const opts = { canAct, project };
  return `<div class="item" style="margin-top:10px" data-prcard>
    <div class="row"><b>${T('PR #{n}', { n: esc(v.pr.number) })}</b> ${st?.state ? `<span class="pill ${st.state === 'merged' ? 'done' : st.state === 'closed' ? 'aborted' : 'running'}">${esc((PR_STATE[st.state] ?? (() => st.state))())}</span>` : ''}
      <span class="small mute">${T('{who}在 {t}前交付', { who: prWho(v), t: esc(ago(v.pr.at)) })}</span>
      <a class="small" href="${esc(v.pr.url)}" target="_blank" rel="noopener">${T('在 GitHub 上看')}</a><span class="grow"></span>
      <span class="small mute">${st?.at ? T('{t}前刷新', { t: esc(ago(st.at)) }) : ''}</span> <button class="small ghost" data-prrefresh>${T('立即刷新')}</button></div>
    <div class="small" style="margin-top:4px">${T('CI：')}${prCiLine(v)}</div>
    ${project ? '' : prAutoLine(v, opts)}
    ${open ? prFixLine(v) : ''}
    ${st?.error ? `<div class="small bad" style="margin-top:4px">${esc(T(st.error.msg, st.error.params ?? {}))}</div>` : ''}
    ${open || pending.length ? `<div class="small" style="margin-top:10px"><b>${T('要你看的意见（{n}）', { n: esc(pending.length) })}</b></div>
    ${!pending.length ? `<div class="small mute">${T('没有')}</div>`
      : `<div class="small mute">${project ? T('项目整体交付的 PR 没有能接着改的任务：要按意见改，到下面「添加任务…」把它贴进去。') : T('「让 AI 按这条改」= 这条意见作为你发的修正交给 AI，改好推回同一个 PR。这里的操作只在看板上，不会回复 GitHub 上的人 —— 要回话请到 GitHub 上回。')}</div>`}
    ${members.length ? members.map((c) => prCommentRow(c, opts)).join('') : ''}
    ${outsiders.length ? `<div class="small" style="margin-top:8px;color:var(--wait)"><b>${T('不是成员的人写的（{n}）', { n: esc(outsiders.length) })}</b>${T('：对不上看板里的成员，是外部文本 —— 只有你看过原文、点了才会交给 AI；里面要读密钥、改配置、往外发东西的，别转。')}</div>${outsiders.map((c) => prCommentRow(c, opts)).join('')}` : ''}` : ''}
    ${done.length ? `<details style="margin-top:6px"><summary class="small">${T('处理过的（{n}）', { n: esc(done.length) })}</summary>${done.map((c) => prCommentRow(c, opts)).join('')}</details>` : ''}
  </div>`;
}

/** 任务页：交付过、开了 PR 才显示 */
function renderTaskPr() {
  const v = detail?.pr ?? null;
  $('#prCard').classList.toggle('hide', !v);
  $('#taskPr').innerHTML = v ? prCardHtml(v, { canAct: !!detail.can?.delivery }) : '';
  if (v) bindPrCard($('#taskPr'), { taskId: detail.task.id });
}

/** 卡片上的按钮。ref：{ taskId } 或 { projectId } */
function bindPrCard(root, ref) {
  const card = root?.querySelector('[data-prcard]');
  if (!card) return;
  const post = async (body, ok) => {
    try {
      if (ref.taskId) await api(`/api/tasks/${ref.taskId}/${body.op === 'refresh' ? 'prRefresh' : body.op === 'autofix' ? 'prAutofix' : 'prComment'}`, body);
      else await api(`/api/projects/${ref.projectId}/pr`, body);
      if (ok) toast(ok);
    } catch (e) { toast(e.message, true); }
    refresh();
  };
  card.querySelector('[data-prrefresh]').onclick = (e) => { e.target.disabled = true; e.target.textContent = T('刷新中…'); post({ op: 'refresh' }); };
  card.querySelectorAll('[data-prfix]').forEach((b) => b.onclick = () => post({ op: 'fix', commentId: b.dataset.prfix }, T('已交给 AI：改好推回同一个 PR')));
  card.querySelectorAll('[data-prdismiss]').forEach((b) => b.onclick = () => post({ op: 'dismiss', commentId: b.dataset.prdismiss }, T('记下了：这条不用管（可以在「处理过的」里撤回）')));
  card.querySelectorAll('[data-prundo]').forEach((b) => b.onclick = () => post({ op: 'undo', commentId: b.dataset.prundo }, T('已放回「要你看的意见」')));
  card.querySelectorAll('[data-prauto]').forEach((b) => b.onclick = () => {
    const on = b.dataset.prauto === 'on';
    if (on && !confirm(autofixAsk())) return;
    post({ op: 'autofix', on }, on ? T('已授权：之后 CI 没过、成员要求修改，直接交给 AI') : T('已收回：之后都先在本页问你'));
  });
  card.querySelectorAll('[data-prpause]').forEach((b) => b.onclick = () => $('#btnPause')?.click());
  card.querySelectorAll('[data-prdiff]').forEach((a) => a.onclick = (e) => { e.preventDefault(); $('#diffCard')?.scrollIntoView({ block: 'start' }); });
  // 问了人的那条事项在本页「待决事项」里：滚过去、把输入框交到手上
  card.querySelectorAll('[data-prgoto]').forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    const box = document.querySelector(`#questions textarea[data-q="${a.dataset.prgoto}"]`);
    (box?.closest('.item') ?? $('#questions')).scrollIntoView({ block: 'center' });
    box?.focus();
  });
}
