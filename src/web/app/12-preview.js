// ── 看运行效果：任务页与收件箱签收共用 ──
// AI 验收点验时存的画面：几张小图，点开看原图
function liveShotsHtml(taskId, key, screens) {
  if (!key || !screens?.length) return '';
  const src = (n) => `/api/tasks/${encodeURIComponent(taskId)}/live_img?key=${encodeURIComponent(key)}&file=${encodeURIComponent(String(n).padStart(2, '0'))}.png`;
  return `<div class="pv-grid pv-sm">${screens.map((n) => `<figure><a href="${src(n)}" target="_blank" rel="noopener" title="${T('在新标签页里看原图')}"><img src="${src(n)}" alt="${T('画面 #{n}', { n: esc(n) })}"></a><figcaption>${T('画面 #{n}', { n: esc(n) })}</figcaption></figure>`).join('')}</div>`;
}
// 签收的人看不到运行中的页面（三人都说"没人真点过界面"）：每步最近一次验收逐条点了什么、看到了什么、当时的画面
function liveChecksHtml(taskId, live) {
  if (!live?.length) return '';
  const R = { pass: ['ok', T('通过')], fail: ['bad', T('不对')], not_checked: ['warn', T('没验成')] };
  const row = (s, c) => `<li style="margin-top:6px">${R[c.result] ? `<span class="pill ${esc(R[c.result][0])}">${esc(R[c.result][1])}</span> ` : ''}${esc(c.item)}`
    + `${c.evidence ? `<div class="small mute">${esc(c.result === 'not_checked' ? T('没验成的原因：{why}', { why: c.evidence }) : T('AI 看到：{what}', { what: c.evidence }))}</div>` : ''}`
    + `${c.result === 'not_checked' ? `<div class="small">${T('这条没参与放行，签收前要你自己核对：签收卡「签收前先看这些」里有自己把应用跑起来的命令')}</div>` : ''}`
    + `${liveShotsHtml(taskId, s.key, c.screens)}</li>`;
  return `<div style="margin-top:16px;padding-top:10px;border-top:1px solid var(--line)"><b>${T('AI 验收时在页面上点过的')}</b> <span class="small mute">${T('它把应用启动起来，照每一步的条目点、填一遍；图是它做完那一下时的画面')}</span>`
    + live.map((s) => `<div style="margin-top:6px"><a href="#${esc(taskId)}/node/${esc(s.nodeId)}">${esc(s.title)}</a><ol style="margin:2px 0 0 18px;padding:0">${s.checks.map((c) => row(s, c)).join('')}</ol></div>`).join('') + '</div>';
}
function previewHtml(taskId, pv, { currentHead = null } = {}) {
  if (!pv) return '';
  const live = liveChecksHtml(taskId, pv.live);
  if (pv.skipped) return `<div class="small mute">${T('这一轮没改界面（没有动到界面目录里的文件，也没改截图说明），所以没有截图。请看代码改动和自动测试的结果来判断。')}</div>${live}`;
  const when = fmtWhen(pv.at);
  const stale = currentHead && pv.head && pv.head !== currentHead;
  const head = `<div class="small mute">${pv.head ? T('截于 {when}，对应提交 {commit}。', { when: esc(when), commit: `<span class="mono">${esc(String(pv.head).slice(0, 8))}</span>` }) : T('截于 {when}。', { when: esc(when) })}${live ? T('这几张是页面刚打开的样子；点过、填过之后的样子在下面「AI 验收时在页面上点过的」。') : T('只看得到页面刚打开的样子，不会替你点按钮、填表单。')}${stale ? ` <b class="bad">${T('这是上一版的截图')}</b>${T('：之后代码又改过，下次验收通过后会重截。')}` : ''}</div>`;
  if (!pv.ok) {
    return `${head}<div class="small bad" style="margin-top:4px">${T('这次没截出来：{why}', { why: esc(pv.why ?? T('原因不明')) })}</div>`
      + (pv.log ? `<details class="small"><summary class="mute">${T('服务的输出（尾部）')}</summary><pre class="small">${esc(pv.log)}</pre></details>` : '')
      + `<div class="small mute">${T('截不出来不影响签收：你仍然可以看代码改动和自动测试的结果来决定；也可以打回，要求把页面修到能跑起来。')}</div>${live}`;
  }
  const src = (s) => `/api/tasks/${encodeURIComponent(taskId)}/preview_img?file=${encodeURIComponent(s.file)}&head=${encodeURIComponent(pv.headKey)}`;
  // 截到了 ≠ 页面是好的：系统看出来的可疑之处放在图的上面，签收的人先看到它
  const warn = (pv.warnings ?? []).length ? `<div class="small bad" style="margin-top:4px">${T('截图时发现：{list}', { list: pv.warnings.map(esc).join(T('；')) })}</div>` : '';
  return `${head}${warn}<div class="pv-grid">${pv.shots.map((s) => `<figure><a href="${src(s)}" target="_blank" rel="noopener" title="${T('在新标签页里看原图')}"><img src="${src(s)}" alt="${esc(s.title)}" loading="lazy"></a><figcaption>${esc(s.title)} <span class="mono mute">${esc(s.path)}</span>${(s.warnings ?? []).length ? `<div class="small bad">${T('可能有问题：{list}', { list: s.warnings.map(esc).join(T('；')) })}</div>` : ''}</figcaption></figure>`).join('')}</div>${live}`;
}
function renderPreview() {
  const pv = detail.preview;
  $('#previewCard').classList.toggle('hide', !pv);
  if (!pv) return;
  const html = previewHtml(detail.task.id, pv);
  if ($('#taskPreview').dataset.k !== `${pv.at}`) { $('#taskPreview').innerHTML = html; $('#taskPreview').dataset.k = `${pv.at}`; }
}

// ── 签收前先看这些：过程里不是一次就顺利过的地方，置顶在签收卡上 ──
// 签收事项正文里也有一节同样内容（给命令行 / 通知），网页上按结构画这一份，正文里那节去掉（webQText）。
// 分三档（src/core/signoff-exceptions.mjs 的 tierOf）：要你拍板 / 要你核对 / 仅告知。仅告知默认收起 —— 走查：八条平铺、不分轻重，
// 签收人把"打回过、最后已通过"的历史当成眼下的问题，分不清哪条要自己动手。同一步的打回经过挂在要处理的那条下面（核对时的背景）。
const EXC_TIER = () => ({
  decide: [T('要你拍板'), T('规格没写或没人答，AI 替你定了；不同意就打回，写明你要哪种')],
  check: [T('要你核对'), T('系统没能替你确认，接受前自己看一眼；接受就是连同它们一起接受')],
  info: [T('仅告知'), T('过程中出过问题，最后已通过检查与 AI 验收，不用你处理')],
});
// 收件箱一行：只露要处理的两档条数（应用没起来单独点名），仅告知放最后、不加粗
function excLineHtml(tiers, href) {
  if (!tiers) return '';
  const n = (t) => tiers.filter((x) => x === t).length, L = EXC_TIER();
  const info = n('info') ? `<span class="mute">${T('另有 {n} 条仅告知', { n: esc(n('info')) })}</span>` : '';
  // 两行可横比：都按档计数，应用没起来只作核对档的注脚
  const chk = n('check') + n('app_down');
  const todo = [n('decide') && `${esc(L.decide[0])} ${esc(n('decide'))}`, chk && `${esc(L.check[0])} ${esc(chk)}${n('app_down') ? `<b>${T('（应用在沙箱里没起来）')}</b>` : ''}`].filter(Boolean);
  if (!todo.length) return `<div class="small" style="color:var(--ok)">✓ ${n('info') ? T('没有要你处理的例外') : T('没有例外')} ${info}</div>`;
  return `<div class="small">⚠ ${todo.join(' · ')}${info ? ` · ${info}` : ''} · <a href="${href}">${T('到任务页看')}</a></div>`;
}
function excHtml(ex, taskId) {
  if (!ex) return '';
  const { list, run } = ex;
  if (!list.length) return `<div class="small" style="margin:6px 0"><b style="color:var(--ok)">✓ ${T('没有例外')}</b> <span class="mute">${T('每一步都一次过了检查与 AI 验收，没有替你定的事，没动原有测试，页面检查都做了')}</span></div>`;
  const step = (e) => (e.nodeId ? `<a href="#${esc(taskId)}/node/${esc(e.nodeId)}" title="${T('打开这一步')}">${esc(e.title ?? e.nodeId)}</a>` : '');
  const at = (e) => (e.nodeId ? `${step(e)}${T('：')}` : '');
  const paths = (ps) => ps.map((p) => `<span class="mono">${esc(p)}</span>`).join(T('、'));
  const HOW = { settled: T('规格没写，它自己选的'), circular: T('拿自己的产物当依据'), weak: T('依据不具体') };
  const K = TG_KIND();
  // 自己把应用跑起来：一段能整段复制的命令（与签收截图同一份 si-preview.json；装依赖取沙箱里装好时跑的那几条）
  const script = run ? [`# ${T('Linux / macOS 终端；Windows 用 WSL')}`, /^[A-Za-z]:\\/.test(run.dir) ? `cd "$(wslpath '${esc(run.dir)}')"` : `cd ${esc(run.dir)}`,   // 看板在 Windows 上：WSL 里认不了 C:\ 路径
    ...((run.setup ?? []).length ? [`# ${T('装依赖')}`, ...run.setup.map(esc)] : []),
    `# ${T('起服务（在后台跑）')}`, ...run.start.map((c) => `SI_PREVIEW=1 ${esc(c)} &`),
    ...(run.seed.length ? [`# ${T('等服务起来，再灌样例数据')}`, `# ${T('命令前面的 SI_PREVIEW=1 表示"这是看效果用的一份"：样例数据脚本没有它就不写数据（退出并说明），免得把示例数据写进真在用的库')}`, ...run.seed.map((c) => `SI_PREVIEW=1 ${esc(c)}`)] : []),
    `# ${T('浏览器打开 {url}；看完停掉：kill %1 %2', { url: esc(run.url) })}`].join('\n') : '';
  const runHtml = run ? `<details style="margin-top:2px"><summary>${T('自己把应用跑起来看')}</summary><pre class="small">${script}</pre></details>` : '';
  const ROW = {
    self_decided: (e) => `${at(e)}${esc(e.statement)} <span class="mute">（${esc(HOW[e.how])}${e.conflicted ? T('；和别处的说法对不上') : ''}）</span>`,
    defaulted: (e) => `${T('没人答，按默认走了：')}${esc(e.text)} <span class="mute">→ ${esc(e.defaultAction)}${e.askedOf?.length ? T('（问的是 {who}，{when}）', { who: esc(e.askedOf.join(T('、'))), when: esc(fmtWhen(e.askedAt)) }) : ''}</span>`,
    tests: (e) => `${at(e)}${T('改了任务开始前就有的测试')} ${paths(e.paths)} <span class="mute">（${e.kinds.map((k) => esc(K[k] ?? k)).join(T('、'))}${e.allowed ? T('，人已放行') : ''}）</span>${e.nodeId ? ` · <a href="#${esc(taskId)}/node/${esc(e.nodeId)}">${T('看改前改后')}</a>` : ''}`,
    ui_unverified: (e) => (e.appDown
      ? `${at(e)}<b>${T('应用在沙箱里没起来')}</b>${T('，这一步的页面检查一项都没做：')}`
      : `${at(e)}${T('{total} 项页面检查里有 {n} 项没做成：', { total: esc(e.total ?? e.items.length), n: esc(e.items.length) })}`)
      + `<ol style="margin:2px 0 0 18px;padding:0">${e.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ol>`
      + (e.why ? `<div class="mute">${T('原因：{why}', { why: esc(e.why) })}</div>` : '')
      + (e.appDown ? `<div>${T('自己跑起来、这几项都对，就接受；跑不起来，就打回，理由写「应用起不来」')}</div>` : '')
      + (e.log ? `<details><summary class="mute">${T('起服务时的输出（尾部）')}</summary><pre class="small">${esc(e.log)}</pre></details>` : '') + runHtml,
    scope: (e) => `${at(e)}${T('改了范围外的文件')} ${paths(e.paths)} <span class="mute">${e.passed ? T('（被拒后撤回了）') : T('（被拒，还没撤回）')}</span>`,
    rejections: (e) => `${step(e)} · ${e.passedAt ? T('打回 {n} 次，最后一次验收通过', { n: esc(e.mech + e.verifier) }) : T('打回 {n} 次，还没通过', { n: esc(e.mech + e.verifier) })}`
      + (e.said.length ? `<div class="mute">${T('当时的问题：{said}', { said: e.said.map(esc).join(T('；')) })}</div>` : ''),
  };
  // 同一步的打回经过：挂在要处理的那条下面
  const hist = (e) => (!e.history ? '' : `<div class="mute">${e.history.said.length ? T('这一步之前被检查打回过 {n} 次，最后一次验收通过；当时的问题：{said}',{ n: esc(e.history.n), said: e.history.said.map(esc).join(T('；')) })
    : T('这一步之前被检查打回过 {n} 次，最后一次验收通过', { n: esc(e.history.n) })}</div>`);
  const TI = EXC_TIER();
  const tier = (t) => { const xs = list.filter((e) => e.tier === t && ROW[e.kind]); if (!xs.length) return '';
    const head = `<b>${esc(TI[t][0])} · ${esc(xs.length)}</b> <span class="mute">${esc(TI[t][1])}</span>`;
    const ul = `<ul style="margin:2px 0 0 18px;padding:0">${xs.map((e) => `<li style="margin-top:4px">${ROW[e.kind](e)}${hist(e)}</li>`).join('')}</ul>`;
    return t === 'info' ? `<details class="small" style="margin-top:6px"><summary>${head}</summary>${ul}</details>` : `<div class="small" style="margin-top:6px">${head}${ul}</div>`; };
  const todo = list.filter((e) => e.tier !== 'info').length;
  return `<div class="exc" style="margin:6px 0;padding:6px 8px;border-left:3px solid var(${todo ? '--wait' : '--line'})"><b>${todo ? `⚠ ${T('签收前先看这些 · {n} 项要你处理', { n: esc(todo) })}` : T('签收前先看这些 · 没有要你处理的')}</b>`
    + ['decide', 'check', 'info'].map(tier).join('') + '</div>';
}

// 签收卡正文："任务已完成"那一句 → 签收前先看这些 → 产物与怎么签
function signoffBodyHtml(q) {
  const [head, rest] = qBodySplit(q.text, 'signoff', 'task');
  return `<div class="body">${head}</div>${excHtml(detail.signoffExceptions, detail.task.id)}${rest ? `<div class="body">${rest}</div>` : ''}`;
}

function renderTaskDiff() {
  const t = detail.task;
  if (!detail.workspace) { $('#taskDiff').innerHTML = `<span class="small mute">${T('还没开工，没有改动')}</span>`; return; }
  // 缓存键跟着"可能产生新提交的事"走：步骤完成、交接、合并、变基、工作区重建、签收请求。没变就不动这一块（展开状态原样留着）。
  const mark = Math.max(0, ...detail.audits.filter((a) => /node_done|handoff|merged|rebase|workspace_created|signoff_requested/.test(a.action)).map((a) => a.id));
  const key = `task:${t.id}:${mark}`;
  if ($('#taskDiff .dv-slot')?.dataset.dk === key) return;
  $('#taskDiff').innerHTML = dvSlot(key, `/api/tasks/${t.id}/diff`, `/api/tasks/${t.id}/diff_lines`, { scopes: true });
  dvHydrate($('#taskDiff'));
}

const readingCache = new Map();
async function showReading(qid, body) {
  const el = () => $(`#questions [data-rd="${qid}"]`);
  const text = String(body ?? '').trim();
  const paint = (r) => { const e = el(); if (!e) return;
    e.textContent = r ? r.text : T('写下答复后，这里会显示系统会怎么理解它。');
    // 以「A」开头却读成要改：人和系统想的不一样，标出来
    e.classList.toggle('mute', !r); e.style.color = r && r.verdict === 'feedback' && r.lead ? 'var(--wait)' : ''; };
  if (!text) return paint(null);
  const k = `${qid}\n${text}`;
  if (readingCache.has(k)) return paint(readingCache.get(k));
  try { const j = await api(`/api/tasks/${cur}/interpret`, { questionId: qid, body: text }); readingCache.set(k, j.result?.reading ?? null); paint(j.result?.reading ?? null); }
  catch { /* 预览失败不挡答复 */ }
}
// 写给我的事项第一次真正露在眼前时告诉服务端（监测走过场的"打开到答复"）。页面在后台时先记着，切回来再报
const SEEN = { sent: new Set(), wait: { taskId: null, ids: [] } };
function noteSeen(taskId, ids) {
  SEEN.wait = { taskId, ids };
  if (document.visibilityState !== 'visible') return;
  const fresh = ids.filter((id) => !SEEN.sent.has(id)); if (!fresh.length) return;
  fresh.forEach((id) => SEEN.sent.add(id));
  api(`/api/tasks/${encodeURIComponent(taskId)}/seen`, { questionIds: fresh }).catch(() => { fresh.forEach((id) => SEEN.sent.delete(id)); });
}
document.addEventListener('visibilitychange', () => { if (SEEN.wait.taskId && SEEN.wait.taskId === cur) noteSeen(SEEN.wait.taskId, SEEN.wait.ids); });

function renderQuestions() {
  const open = detail.questions.filter((q) => ['open', 'escalated'].includes(q.status));
  const mine = open.filter((q) => me && q.addressed_to.includes(me.id) && !(q.status === 'escalated' && q.decision_type !== 'conflict') && !q.answers.some((a) => a.userId === me.id && ['answer', 'agree'].includes(a.stance)));
  noteSeen(detail.task.id, mine.map((q) => q.id));
  $('#qCount').textContent = open.length ? `${T('{n} 项待决', { n: open.length })}${mine.length ? ` · ${T('{n} 项待你处理', { n: mine.length })}` : ''}` : '';
  const stName = (s, q) => ({ open: T('待答复'), escalated: q && q.decision_type !== 'conflict' ? T('待冲突结论') : T('待裁定'), answered: T('已决定'), defaulted: T('已按默认处理'), withdrawn: T('已撤回') }[s] ?? s);
  const stanceName = (s) => ({ answer: T('答复'), agree: T('附议'), abstain: T('弃权（不归我）'), dissent: T('异议（已记录）'), comment: T('评论'), withdrawn: T('已撤回'), superseded: T('已被新答复取代') }[s] ?? s);
  const typed = Object.fromEntries([...document.querySelectorAll('#questions textarea[data-q]')].map((i) => [i.dataset.q, i.value]));
  const focused = document.activeElement?.dataset?.q ?? null;
  $('#questions').innerHTML = detail.questions.slice(0, 20).map((q) => {
    const isOpen = ['open', 'escalated'].includes(q.status);
    // 原事项进了冲突处理：答复在冲突事项里收，这里只显示状态（负责人仍可直接裁定）。
    const inConflict = q.status === 'escalated' && q.decision_type !== 'conflict';
    const answeredByMe = me && q.answers.some((a) => a.userId === me.id && ['answer', 'agree'].includes(a.stance));
    const side = sideOnlyOf(q);   // 顺带收到的人不欠这一票、不拍板
    const sideMe = isOpen && !inConflict && me && side.has(me.id) && !answeredByMe;
    const forMe = isOpen && !inConflict && me && q.addressed_to.includes(me.id) && !answeredByMe && !sideMe;
    const waitingOthers = isOpen && !inConflict && answeredByMe && q.addressed_to.filter((u) => !side.has(u) && !q.answers.some((a) => a.userId === u && ['answer', 'agree'].includes(a.stance))).map(nameOf);
    // 能附议的是别人自己写的那几条（附议不是新立场，不能附议附议）。
    const others = q.answers.filter((a) => a.stance === 'answer' && a.userId && (!me || a.userId !== me.id));
    const canAnswer = isOpen && me && me.role !== 'observer' && (forMe || sideMe || isLead());
    const canTransfer = isOpen && !inConflict && me && (forMe || isLead());
    // 已经表态的人不该还留在"待 X 答复"里（明明答了，抬头却还写着待他答复，自相矛盾）
    const acted = new Set(q.answers.filter((a) => ['answer', 'agree'].includes(a.stance) && a.userId).map((a) => a.userId));
    const stillOwed = q.addressed_to.filter((u) => !acted.has(u) && !side.has(u));
    // 已经定案的事项不再列"待 X 答复"（法定人数 1 的事项一人答就定了，页面原来还写着"已决定 · 待某人答复"）
    // 已定的：写谁答的（任一人答即可的事项被别人答掉，另一人只看到"已答复"）
    const who = !isOpen ? (q.status === 'answered' && q.answer?.byName ? T('{name} 答的', { name: esc(q.answer.byName) }) : '') : inConflict ? T('答复不一致，待对应冲突事项的结论')
      : stillOwed.length ? T('待{names}答复', { names: sp(stillOwed.map((u) => esc(nameOf(u))).join(T('、'))) })
        : q.addressed_to.length ? T('接收人都已表态') : T('未指定接收人');
    const kind = q.decisionLabel ? `${Tc('dtype', q.decisionLabel)}` : '';
    const wait = q.level === 3 ? T('无超时') : (q.remainingMs != null ? (q.remainingMs <= 0 ? T('已到期，将按默认处理') : T('{dur}后按默认处理', { dur: dur(q.remainingMs) })) : '');
    const routeWait = q.routeRemainingMs != null ? T('{dur}后转下一顺位', { dur: dur(q.routeRemainingMs) }) : '';
    return `<div class="item ${forMe ? 'mine' : isOpen ? 'flag' : ''}"><div class="row small mute"><span class="pill ${esc(q.status)}"${q.reading ? ` title="${q.reading.final ? T('系统把这条答复读成了「{label}」，并已照此处理', { label: esc(T(q.reading.label)) }) : T('系统把这条答复读成了「{label}」，稍后照此处理', { label: esc(T(q.reading.label)) })}"` : ''}>${q.reading && !isOpen ? T('已答复：{label}', { label: esc(T(q.reading.label)) }) : esc(stName(q.status, q))}</span> ${esc(kind)}${who ? ` · ${who}` : ''} · ${T('{ago}前', { ago: ago(q.asked_at) })}
      ${isOpen ? [wait, routeWait].filter(Boolean).map((x) => `· ${x}`).join(' ') : ''}${q.default_action ? ` · <span title="${q.remainingMs != null ? T('到期仍没有人答复时，系统按这条默认处理，并在下一份报告里标注') : T('这条事项没有设时限，默认动作不会自动执行 —— 只有人答复才会有结论')}">${T('默认：{action}', { action: esc(q.default_action).slice(0, 60) })}${q.remainingMs == null && isOpen ? T('（无时限，不会自动执行）') : ''}</span>` : ''}${forMe ? ` · <b style="color:var(--run)">${T('待你处理')}</b>` : sideMe ? ` · ${T('你可以补充（不必答）')}` : waitingOthers && waitingOthers.length ? ` · ${T('你已答复，待 {names}', { names: esc(waitingOthers.join(T('、'))) })}` : ''}</div>
      ${q.decision_type === 'signoff' && isOpen ? signoffBodyHtml(q) : `<div class="body">${qBodyHtml(q.text, q.decision_type, 'task')}</div>`}
      ${q.decision_type === 'signoff' && isOpen ? `<div class="small" style="margin-top:4px">${detail.preview && !detail.preview.skipped ? `<a href="#previewCard" data-godiff="previewCard">${T('看页面截图 ↓')}</a> · ` : ''}<a href="#diffCard" data-godiff="diffCard">${T('看改动 ↓')}</a> <span class="mute">—— ${detail.preview && !detail.preview.skipped ? T('下方两张卡片：做出来的页面长什么样，和逐行取自代码的改动') : T('下方「改动」卡片，逐行取自代码')}</span></div>` : ''}
      ${q.briefing ? `<details><summary>${T('当前进展')}</summary><div class="body small">${esc(q.briefing.work_done)}\n\n${T('收到答复后：{plan}', { plan: esc(q.briefing.plan_after_answer) })}</div></details>` : ''}
      ${q.answers.length ? `<div class="small" style="margin-top:4px">${q.answers.map((a) => (['agree', 'abstain', 'withdrawn'].includes(a.stance)
        // 这几种的正文本身就说清了是什么（"附议 X 的答复：…"、"弃权：…"），再加一次标签就成了"弃权：弃权：…"
        ? `<div><b>${esc(a.name)}</b> ${esc(a.body).slice(0, 200)}</div>`
        : `<div><b>${esc(a.name)}</b> <span class="mute">${a.stance === 'answer' && side.has(a.userId) ? T('补充（不计数）') : esc(stanceName(a.stance))}</span>${T('：')}${esc(a.body).slice(0, 200)}</div>`)).join('')}</div>` : ''}
      ${q.answer && !q.answers.length ? `<div class="small mute">${T('答复：{body}', { body: esc(q.answer.body).slice(0, 200) })}</div>` : ''}
      ${isOpen && quorumText(q) ? `<div class="small mute">${quorumText(q)}</div>` : ''}
      ${isOpen && forMe && q.decision_type === 'conflict' && !acted.has(me?.id) ? `<div class="small" style="margin-top:4px;color:var(--wait)">${T('你还没在这条冲突事项里表态。上面列的是大家在原事项里的答复；在这里要再选一次：附议对方、撤回自己，或写一句重申 —— 都不选的话，到期后转负责人裁定（到期时间见这条事项上方那一行）。')}</div>` : ''}
      ${canAnswer && q.decision_type === 'signoff' && detail.task.status !== 'done' ? `<div class="small" style="margin-top:6px;color:var(--wait)">${T('现在签不了：这个任务又在改（{status}）。改完之后系统会按新版本重新请你签收，这一条会自动作废 —— 不用做什么，等通知就行。', { status: esc(ST_NAME[detail.task.status] ?? detail.task.status) })}</div>`
        : canAnswer && q.decision_type === 'signoff' ? `<div class="row" style="margin-top:6px"><button data-so="ok" class="primary">${T('接受')}</button><button data-so="no" title="${T('会让你写理由：理由作为修正指令，任务据此重新规划')}">${T('打回…')}</button>${canTransfer ? `<button data-tr="${esc(q.id)}" title="${T('指定另一个人来签；转交后你不再是接收人')}">${T('转交')}</button>` : ''}</div>`
        : canAnswer ? `<div class="row" style="margin-top:6px"><textarea rows="2" aria-label="${T('答复')}" placeholder="${T('输入答复（可以换行）')}" data-q="${esc(q.id)}"${q.interpretable ? ' data-interp="1"' : ''} style="flex:1;min-width:200px;resize:vertical"></textarea><button data-ans="${esc(q.id)}" class="primary">${T('答复')}</button>${
        others.length ? `<button data-agree="${esc(q.id)}" title="${others.length > 1 ? T('同意上面某一条答复，不用再写一遍。计入需要的人数；够数后就按那条定案。自己敲一遍「同意」不算附议，系统会把它当成你自己的一条答复') : T('同意上面那条答复，不用再写一遍。计入需要的人数；够数后就按那条定案。自己敲一遍「同意」不算附议，系统会把它当成你自己的一条答复')}">${T('附议')}</button>` : ''}${
        forMe ? `<button data-abs="${esc(q.id)}" title="${q.decision_type === 'conflict' ? T('撤回自己的立场，以对方为准') : T('这条不归你：把你从接收人里去掉，需要的人数按剩下的人重算')}">${q.decision_type === 'conflict' ? T('撤回') : T('不归我')}</button>` : ''}${
        canTransfer ? `<button data-tr="${esc(q.id)}" title="${T('指定另一个人来答；转交后你不再是接收人。与「不归我」的区别：这条仍然要有人答，只是换个人答')}">${T('转交')}</button>` : ''}</div>${
        q.interpretable ? `<div class="small mute" data-rd="${esc(q.id)}" style="white-space:pre-wrap;margin-top:4px">${T('写下答复后，这里会显示系统会怎么理解它。')}</div>` : ''}${
        // 结构矛盾的出路常常是改契约，而答复本身改不了契约：勾上就把这段话同时作为一条修正提交（一次动作，不用再去下面「发送」）
        q.decision_type === 'structural' && !detail.task.merged_at ? `<label class="small" style="display:block;margin-top:4px" title="${T('答复本身改不了这个任务的契约（范围、规则、验收标准）。勾上之后，这段答复会同时作为一条「修正」提交：系统据此给出计划变更，触及契约的按路由表批准后生效。只是在现有范围内给出路的话，不用勾。勾上等于答完再到下面「发送」里选「修正」发一遍，只是一次做完。')}"><input type="checkbox" data-alsocorr="${esc(q.id)}"> ${T('同时作为计划变更提交 —— 要改范围、规则或验收标准时勾上（光在答复里写，改不了）')}</label>` : ''}${
        // 这一步改了任务开始前就有的测试、还没放行 —— 答复时一并放行（不勾 = 不放行，系统照常标注 / 打回）
        q.testPaths?.length ? `<label class="small" style="display:block;margin-top:4px"><input type="checkbox" data-allowtests="${esc(q.id)}"> ${T('允许这一步改这些任务开始前就有的测试（已经改了的也算放行）：{paths}', { paths: esc(q.testPaths.join(T('、'))) })}<span class="mute">${T('。')}${q.testGuard === 'reject' ? T('不勾：这些改动交上来会被打回；要撤回就在答复里说') : T('不勾：照常交给 AI 验收判断，系统不会自动撤回；要撤回就在答复里说')}</span></label>` : ''}`
        : canTransfer ? `<div class="row" style="margin-top:6px"><button data-tr="${esc(q.id)}" title="${T('指定另一个人来答；转交后你不再是接收人。与「不归我」的区别：这条仍然要有人答，只是换个人答')}">${T('转交')}</button></div>` : ''}${lostDraftHtml(q, canAnswer)}</div>`;
  }).join('') || `<span class="mute small">${T('无')}</span>`;
  for (const i of document.querySelectorAll('#questions textarea[data-q]')) {
    const v = typed[i.dataset.q] || DRAFTS.get(i.dataset.q)?.text;
    if (v) i.value = v;
    if (i.dataset.q === focused) i.focus();
    i.addEventListener('input', () => { if (i.value.trim()) DRAFTS.set(i.dataset.q, { text: i.value }); else DRAFTS.delete(i.dataset.q); });
  }
  bindLostDrafts();
  // 方案批准：边写边显示"系统会理解为…"。判读与状态机是同一个函数，所以这里显示什么，提交后就按什么处理。
  for (const i of document.querySelectorAll('#questions textarea[data-interp]')) {
    const show = () => showReading(i.dataset.q, i.value);
    i.addEventListener('input', () => { clearTimeout(i._rt); i._rt = setTimeout(show, 250); });
    if (i.value.trim()) show();
  }
  // 签收：答案只有两种，给两个按钮，不给自由输入框（输入框看着能随便写，其实只收两种，还要靠报错学格式）
  $('#questions').querySelectorAll('[data-so]').forEach((b) => b.onclick = () => (b.dataset.so === 'ok' ? $('#btnSignoffOk') : $('#btnSignoffNo')).click());
  $('#questions').querySelectorAll('[data-godiff]').forEach((a) => a.onclick = (e) => { e.preventDefault(); $(`#${a.dataset.godiff}`).scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('#questions').querySelectorAll('button[data-ans]').forEach((b) => b.onclick = async () => {
    const body = $(`textarea[data-q="${b.dataset.ans}"]`).value.trim(); if (!body) return toast(T('答复不能为空'), true);
    const alsoCorrection = !!$(`input[data-alsocorr="${b.dataset.ans}"]`)?.checked;
    const allowTests = !!$(`input[data-allowtests="${b.dataset.ans}"]`)?.checked;
    const r = await act('answer', { questionId: b.dataset.ans, body, alsoCorrection, allowTests }, alsoCorrection ? T('已答复，并作为计划变更提交') : allowTests ? T('已答复，并放行了这一步对原有测试的改动') : T('已答复'));
    if (r) DRAFTS.delete(b.dataset.ans);
    if (r?.result?.reading) toast(r.result.reading.text, false, 8000);
    else if (r?.result?.conflictId) toast(T('与其他人的答复不一致，请在新生成的冲突事项中协商'), true);
    else if (r?.result?.late) toast(r.result.note, r.result.stance === 'dissent');
    else if (r && r.result && !r.result.resolved) toast(T('已记录，待其他人答复'));
  });
  $('#questions').querySelectorAll('button[data-agree]').forEach((b) => b.onclick = async () => {
    const q = detail.questions.find((x) => x.id === b.dataset.agree);
    const mine = q.answers.filter((a) => a.stance === 'answer' && a.userId && a.userId !== me?.id);
    let pick = mine[0];
    if (mine.length > 1) {
      const who = prompt(T('附议谁的答复（输入名字）：\n{list}', { list: mine.map((a) => `  ${a.name}：${a.body.slice(0, 60)}`).join('\n') }));
      if (!who) return;
      pick = mine.find((a) => a.name === who.trim());
      if (!pick) return toast(T('没找到这个人的答复'), true);
    }
    const r = await act('answer', { questionId: q.id, stance: 'agree', agreesWith: pick.id }, T('已附议 {name} 的答复', { name: pick.name }));
    if (r && r.result && !r.result.resolved) toast(T('已计入，待其他人表态'));
  });
  $('#questions').querySelectorAll('button[data-abs]').forEach((b) => b.onclick = async () => {
    const q = detail.questions.find((x) => x.id === b.dataset.abs);
    const conflict = q.decision_type === 'conflict';
    const note = prompt(conflict ? T('撤回自己的立场，以对方为准。说明（可留空）：') : T('这条不归你。把你从接收人里去掉，需要的人数按剩下的人重算。说明（可留空）：'));
    if (note === null) return;
    const r = await act('answer', { questionId: q.id, stance: 'abstain', body: note }, conflict ? T('已撤回') : T('已记为不归你'));
    if (r?.result?.reassigned) toast(T('接收人已没有人，事项已改派'));
    else if (r?.result?.unassigned) toast(T('接收人全部弃权且没有下一顺位，事项挂起等人处理'), true);
  });
  $('#questions').querySelectorAll('button[data-tr]').forEach((b) => b.onclick = async () => {
    const users = (me?.users ?? []).filter((u) => u.role !== 'observer');
    const pick = prompt(T('转交给（输入成员名称）：\n{list}', { list: users.map((u) => `  ${u.display_name}（${roleName(u.role)}）`).join('\n') })); if (!pick) return;
    const u = users.find((x) => x.display_name === pick.trim() || x.id === pick.trim()); if (!u) return toast(T('未找到该成员'), true);
    const reason = prompt(T('为什么转给 {name}？（可留空；会显示在这条事项的活动记录里，对方能看到）', { name: u.display_name })); if (reason === null) return;
    try { await api(`/api/questions/${b.dataset.tr}/transfer`, { to: [`user:${u.id}`], reason }); toast(T('已转交给 {name}', { name: u.display_name })); refresh(); } catch (e) { toast(e.message, true); }
  });
}
// 走查：卡片上看不出"批准"点下去是立刻生效还是要等别人 —— 直接写还差谁（与事项上的同一口径）
function rvQuorum(r) {
  const q = r.questionId && detail.questions.find((x) => x.id === r.questionId && ['open', 'escalated'].includes(x.status));
  if (!q) return '';
  return quorumText(q) || T('只等你一个人：你点了就算数');
}
function renderRevision() {
  const r = detail.revision;
  $('#revision').innerHTML = r ? `<div class="item flag"><div>${esc(r.gate ? T('需批准原因：{gate}', { gate: r.gate }) : T('无需批准，将自动应用'))}</div><div class="body small">${esc(r.message)}</div>
    <pre>${mdBold(r.diff)}</pre>${isLead() ? `<div class="row"><button class="primary" id="rvOk">${T('批准')}</button><button id="rvResv" title="${T('照样整份批准；另把你的一句话记进项目约定清单')}">${T('批准，另记保留意见…')}</button><button id="rvRedo" title="${T('写下要怎么改，AI 重出一版再来问你')}">${T('重出一版…')}</button><button class="danger" id="rvNo" title="${T('那条修正作罢，计划原样不动')}">${T('不要这份变更')}</button></div>
    <div class="small" style="margin-top:4px">${rvQuorum(r)}</div>
    <div class="small mute" style="margin-top:2px">${T('要<b>挡住</b>里面某一条，点「重出一版…」写明哪一条不要 —— 这份方案不能只批一半。')}</div>` : ''}</div>` : `<span class="mute small">${T('无')}</span>`;
  // 负责人在这一格写下"这条先别当硬规则写进宪法"，页面只有批 / 驳两个按钮，
  // 他于是改口"不值得为这一条卡住正题 —— 批"。那不是他改主意，是没地方放那句话。
  if (r && isLead()) { $('#rvOk').onclick = () => act('revision', { approve: true }, (r) => (r?.pending ? T('已记下你的批准；还差别人表态（看这条事项上方的「待…答复」），都批了才生效') : T('已批准，变更生效'))); $('#rvNo').onclick = () => act('revision', { approve: false }, (r) => (r?.pending ? T('已记下你的「不要这份变更」；还差别人表态（看这条事项上方的「待…答复」）') : T('这份变更不要了，计划原样不动')));
    // 走查：常驻的保留意见框紧贴「批准」下面，读的人以为"写一句再点批准 = 带条件批准，AI 会照做"。
    // 改成点了才问，问的时候说清这句话去哪儿、不去哪儿。
    $('#rvResv').onclick = () => { const note = prompt(T('整份照批。你的保留意见是？\n（记进项目约定清单、标〔保留意见〕，下一个碰这一处的人看得到；不会交给 AI 改这一版 —— 要 AI 改，取消后点「重出一版…」）')); if (!note?.trim()) return; act('revision', { approve: true, reservation: note.trim() }, (r) => (r?.pending ? T('已记下你的批准和保留意见；还差别人表态（看这条事项上方的「待…答复」），都批了才生效') : T('已批准，变更生效；保留意见已记下'))); };
    $('#rvRedo').onclick = () => { const why = prompt(T('要怎么改？（这段话连同原来那条修正一起交给 AI 重出一版）')); if (!why?.trim()) return; act('revision', { approve: false, why: why.trim() }, (r) => (r?.pending ? T('已记下你的「重出一版」；还差别人表态（看这条事项上方的「待…答复」）') : T('已交给 AI 重出一版，出来再问你'))); }; }
}
