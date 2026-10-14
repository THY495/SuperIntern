// ── 竖向分层图（步骤图与项目依赖图共用，2026-09-22）──────────────────────────
// 用户试用：横向 SVG 里标题只能单行截断（真库步骤标题中位 40 多字），框一宽就要横向滚动。
// 改成自上而下分层：层号 = 依赖深度，同一层 = 互不依赖；框是普通 HTML（标题能折行，最多三行，悬停看全名），
// 箭头是叠在上面的一层 SVG，按框的实际位置画 —— 所以窗口变宽变窄都跟着重画。
// items: [{ id, title, color, line1, line2, deps: [id], href? }]，按显示顺序给（同一层内保持这个顺序）。
function vdagHtml(items, { key }) {
  const ids = new Set(items.map((x) => x.id));
  const depth = new Map();
  const byId = new Map(items.map((x) => [x.id, x]));
  const d = (id, seen = new Set()) => { if (depth.has(id)) return depth.get(id); if (seen.has(id)) return 0; seen.add(id);
    const v = Math.max(0, ...(byId.get(id)?.deps ?? []).filter((x) => ids.has(x)).map((x) => d(x, seen) + 1)); depth.set(id, v); return v; };
  items.forEach((x) => d(x.id));
  const layers = [];
  for (const x of items) (layers[depth.get(x.id)] ??= []).push(x);
  const node = (x) => `<div class="vnode" role="button" tabindex="0" data-vid="${esc(x.id)}"${x.href ? ` data-href="${esc(x.href)}"` : ''} style="border-color:${esc(x.color)}" title="${esc(x.title)}">
      <div class="t">${esc(x.title)}</div>
      ${x.line1 ? `<div class="m" style="color:${esc(x.color)}">${x.line1}</div>` : ''}${x.line2 ? `<div class="m2">${x.line2}</div>` : ''}</div>`;
  return `<div class="vdag" data-vdag="${esc(key)}" data-edges="${esc(JSON.stringify(items.flatMap((x) => (x.deps ?? []).filter((dd) => ids.has(dd)).map((dd) => [dd, x.id]))))}">
    ${layers.filter(Boolean).map((l) => `<div class="vlayer">${l.map(node).join('')}</div>`).join('')}
    <svg class="vedges"></svg></div>`;
}
/** 画箭头：从被依赖的框底边中点，到依赖它的框顶边中点。容器尺寸一变就重画。 */
function vdagDraw(root) {
  const box = root.querySelector('.vdag'); if (!box) return;
  const svg = box.querySelector('.vedges'); const R = box.getBoundingClientRect();
  const at = (id) => box.querySelector(`.vnode[data-vid="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  let edges = []; try { edges = JSON.parse(box.dataset.edges || '[]'); } catch { /* 没有边 */ }
  svg.setAttribute('width', R.width); svg.setAttribute('height', R.height);
  svg.innerHTML = `<defs><marker id="varr-${esc(box.dataset.vdag)}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--mute)"/></marker></defs>`
    + edges.map(([from, to]) => { const a = at(from), b = at(to); if (!a || !b) return '';
      const x1 = a.left + a.width / 2 - R.left, y1 = a.bottom - R.top, x2 = b.left + b.width / 2 - R.left, y2 = b.top - R.top - 2;
      const my = (y1 + y2) / 2;
      return `<path d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}" fill="none" stroke="var(--mute)" stroke-opacity=".55" stroke-width="1.5" marker-end="url(#varr-${esc(box.dataset.vdag)})"/>`; }).join('');
}
const vdagObservers = new WeakMap();
function vdagMount(root, onClick) {
  vdagDraw(root);                                  // 同步画一次（读框位置会强制排版，此刻就准）
  requestAnimationFrame(() => vdagDraw(root));     // 字体等晚到的排版变化再补一次
  if (!vdagObservers.has(root) && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => vdagDraw(root)); ro.observe(root); vdagObservers.set(root, ro);
  }
  root.querySelectorAll('.vnode').forEach((el) => el.addEventListener('click', () => onClick(el.dataset.vid, el)));
}

function renderDag() {
  const nodes = detail.nodes, edges = detail.edges;
  const color = (s) => ({ done: 'var(--ok)', running: 'var(--run)', blocked: 'var(--wait)', ready: 'var(--run)', pending: 'var(--mute)', void: 'var(--void)', failed: 'var(--bad)' }[s] ?? 'var(--mute)');
  const RISK = { low: T('低'), normal: T('中'), high: T('高') };
  // "步骤 N"= 服务端按串行执行推演出的先后（taskDetail），与活动栏里的编号是同一个
  const items = nodes.map((n, i) => ({ id: n.id, title: n.title, color: color(n.status),
    line1: `${T('步骤 {n}', { n: i + 1 })} · ${esc(nodeStName(n))}${n.retry_count && !diagLive(n) ? ` · ${T('重试 {n} 次', { n: n.retry_count })}` : ''}${diagShort(n)}${n.compactions ? ` · ${T('整理过 {n} 次', { n: n.compactions })}` : ''}`,
    // 优先级不放在框里（几乎都是 100，每个框写一遍只让人去找'谁不一样'）；点开框在详情里看、改
    line2: T('风险 {level}', { level: RISK[n.risk_tier] ?? esc(n.risk_tier) }),
    deps: edges.filter((e) => e.from_id === n.id).map((e) => e.to_id) }));
  const root = $('#dag');
  root.innerHTML = nodes.length ? vdagHtml(items, { key: 'steps' }) : `<span class="mute">${T('暂无步骤')}</span>`;
  if (nodes.length) vdagMount(root, (id, el) => { root.querySelectorAll('.vnode.sel').forEach((x) => x.classList.remove('sel')); el.classList.add('sel'); showNode(id); });
  if (pendingNode && nodes.some((n) => n.id === pendingNode)) {
    const el = root.querySelector(`[data-vid="${CSS.escape(pendingNode)}"]`); if (el) el.classList.add('sel');
    showNode(pendingNode); pendingNode = null; setTimeout(() => $('#nodeDetail').scrollIntoView({ block: 'center' }), 0);
  }
}
// 诊断：被打回过、还没过的步骤，框里带一个短判词；点开步骤是一张"缺陷 × 第几次交"的格子图 ——
// 停滞是一行连着几格都在，有进展是有的行右边空了，复发是一行中间空了又回来：看图就懂，不靠解释
const DIAG_NAME = () => ({ first: T('第一次被打回'), converging: T('有进展'), stalled: T('停滞'), oscillating: T('复发'), environment: T('环境问题'), passed: T('已通过') });
const DEFECT_CAT = () => ({ acceptance: T('验收标准未满足'), spec: T('偏离规格或契约'), decision: T('该问人的事自己定了'), test: T('测试问题'), quality: T('其他问题'),
  scope: T('越界改动'), shared: T('改了共享路径'), artifact: T('产物不对'), field: T('交接记录缺项'), git: T('算不出改动'), assumption: T('假设'), environment: T('环境问题') });
const diagStuck = (d) => d.state === 'stalled' || d.state === 'oscillating';
const diagLive = (n) => !!n.diagnosis && n.diagnosis.state !== 'passed' && n.status !== 'done';
// 框里只放一个数：交了几次（「重试 N 次」与「打回 N 次」并排的话，两个计数谁也说不清谁）。
// 重试在格子图里画成「↻ 重试后」；停滞后排队重来的步骤状态写「等重试」，不写「待执行」。
// 卡住的用 ⚠ 加粗 —— 不借颜色：图例里的颜色只表示步骤状态，借橙色会被读成"在等人答复"
const diagShort = (n) => {
  if (!diagLive(n)) return '';
  const d = n.diagnosis, s = `${esc(DIAG_NAME()[d.state] ?? d.state)}${T('（交了 {k} 次）', { k: d.cols.length })}`;
  return ` · ${diagStuck(d) ? `<b>⚠ ${s}</b>` : s}`;
};
const nodeStName = (n) => (n.status === 'pending' && n.retry_count ? T('等重试') : stName(n.status));
// 判词只说"现在怎样、接下来会怎样"，每个数都能在格子图里数出来
function diagSentence(d) {
  const open = d.rows.filter((w) => w.now === 'open').length, subs = d.cols.filter((c) => c.kind === 'mech' || c.kind === 'verifier').length;
  if (d.state === 'first') return T('第一次被打回，{n} 条缺陷', { n: open });
  if (d.state === 'converging') return d.resolved == null ? T('被打回 {r} 次', { r: d.rejections })
    : T('被打回 {r} 次；上一次的缺陷改掉了 {fixed} 条', { r: d.rejections, fixed: d.resolved });
  if (d.state === 'stalled') {
    const m = d.streak + 1, what = m >= subs ? T('{m} 次交都卡在同样的缺陷上', { m }) : T('最近 {m} 次交都卡在同样的缺陷上', { m });
    return d.escalate ? T('{what}，已转给人（见收件箱）', { what }) : T('{what}；再交 {k} 次还这样就转给人', { what, k: d.stallAt - d.streak });
  }
  if (d.state === 'oscillating') return d.escalate ? T('改好的缺陷又回来了 {k} 次，已转给人（见收件箱）', { k: d.returns })
    : T('改好的缺陷又回来了 {k} 次；再回来 {x} 次就转给人', { k: d.returns, x: d.oscAt - d.returns });
  if (d.state === 'environment') return T('最近一次是环境出错（不是 AI 改的问题），不计次数');
  if (d.state === 'passed') return T('被打回 {r} 次后通过', { r: d.rejections });
  return '';
}
// 这一步对测试做了什么（系统比对出来的信号，不是结论 —— 功能变了测试跟着改是正常的）。
// 分两组：原有测试（任务开工时就有的）醒目、默认展开；本任务前面写的测试轻一些
const TG_KIND = () => ({ deleted: T('删了文件'), skip_added: T('加了跳过'), focus_added: T('加了只跑（only）'), tests_down: T('用例变少'), asserts_down: T('断言变少'), expect_changed: T('改了期望值') });
// 改前 / 改后两行只把不一样的那一段标出来（公共前后缀之外），长行横向滚动、不在词中间折断
const tgDiff = (a, b) => {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0; while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  // 按词标，不按字符：'2026-01-05' → '2026/1/5' 标整个值，不是标出 -01-0 / /1/ 两截碎片
  const SEP = /[\s'"`(),[\]{};=:<>]/;
  while (i > 0 && !SEP.test(a[i - 1])) i--;
  while (j > 0 && !SEP.test(a[a.length - j])) j--;
  return [i, j];
};
function testChangesHtml(n) {
  const cs = n.testChanges; if (!cs?.length) return '';
  const K = TG_KIND();
  // 一组代码行：标签一列、代码一列，整组共用一条横向滚动条（改前 / 改后对齐着一起滚，不是各滚各的）。
  // 行 = [标签, 原文, [i, j]?]：[i, j] = 公共前缀长、公共后缀长，中间那段标出来。
  // 相同的前缀太长就从贴着改动的那个词开始显示（窄面板里 mark 不至于被挤到可视区外），整行放 title 里
  // 标签贴左（sticky），读屏顺序仍是"标签、这一行"
  const row = ([label, s, d]) => {
    const [i, j] = d ?? [s.length, 0], marked = i < s.length - j;
    const pre = s.slice(0, i);
    let cut = 0;
    if (marked && pre.length > 24) for (let k = pre.length - 16; k > 0; k--) if (/[\s(,.]/.test(pre[k])) { cut = k + 1; break; }
    const mid = marked ? `<mark>${esc(s.slice(i, s.length - j))}</mark>` : '';
    return `<tr><th scope="row" class="small mute" style="position:sticky;left:0;background:var(--card);font-weight:normal;text-align:left;padding:0 6px 0 0;white-space:nowrap">${esc(label)}</th>`
      + `<td class="mono small" style="white-space:pre;padding:0" title="${esc(s)}">${cut > 0 ? '…' : ''}${esc(pre.slice(cut))}${mid}${esc(s.slice(Math.max(i, s.length - j)))}</td></tr>`;
  };
  const lines = (rows) => `<div style="overflow-x:auto;margin-top:2px"><table style="border-collapse:collapse">${rows.map(row).join('')}</table></div>`;
  const detail = (f) => {
    if (f.kind === 'expect_changed') return lines(f.pairs.flatMap((p) => { const d = tgDiff(p.from, p.to); return [[T('改前'), p.from, d], [T('改后'), p.to, d]]; }))
      + (f.total > f.pairs.length ? `<div class="small mute">${T('另有 {n} 处', { n: f.total - f.pairs.length })}</div>` : '');
    const head = f.before != null ? ` <span class="small">${esc(f.before)} → ${esc(f.after)}</span>` : '';
    const label = f.kind === 'tests_down' || f.kind === 'asserts_down' ? T('没了') : T('加了');
    return head + (f.lines?.length ? lines(f.lines.map((l) => [label, l])) : '');
  };
  // 验收员对同一个文件的缺陷（打回与诊断表里的那几行）就近挂在文件下面：两处说的是一件事，不让人自己去对
  const NOW = { open: `<span class="bad">${T('还没改好')}</span>`, fixed: `<span class="ok">${T('已改好')}</span>` };
  const said = (path) => (n.diagnosis?.rows ?? []).filter((w) => (w.locations ?? []).some((l) => l === path || l.startsWith(`${path}:`)));
  // 没有打回意见时说清是"看过、没意见"还是"还没看"：最近一次交是 AI 验收看的（它的输入里有这份比对），还是系统检查就拦下了
  const lastKind = n.diagnosis?.cols?.at(-1)?.kind;
  const quiet = lastKind === 'verifier' || lastKind === 'pass' || n.status === 'done' ? `<span class="mute">${T('AI 验收看过这处改动，没提意见')}</span>`
    : `<span class="mute">${T('AI 验收还没看过这处改动')}</span>`;
  const file = (c) => { const ws = said(c.path); return `<div style="margin-top:6px"><span class="mono small">${esc(c.path)}</span>${c.allowed ? ` <span class="pill ok">${T('人已允许改')}</span>` : ''}
    ${c.findings.map((f) => `<div style="margin:4px 0 0 12px"><b class="small">${esc(K[f.kind] ?? f.kind)}</b>${detail(f)}</div>`).join('')}
    ${ws.length ? ws.map((w) => `<div class="small" style="margin:4px 0 0 12px">${T('打回意见：{what}', { what: esc(w.summary) })}${NOW[w.now] ? ` · ${NOW[w.now]}` : ''}</div>`).join('') : `<div class="small" style="margin:4px 0 0 12px">${quiet}</div>`}</div>`; };
  const base = cs.filter((c) => c.baseline), own = cs.filter((c) => !c.baseline);
  // 都被人放行过的不再报警、不默认展开
  const alarm = base.some((c) => !c.allowed);
  return `${base.length ? `<details${alarm ? ' open' : ''}><summary>${alarm ? `<b>⚠ ${T('改了任务开始前就有的测试 · {n} 个文件', { n: base.length })}</b>` : T('改了任务开始前就有的测试 · {n} 个文件', { n: base.length })}</summary><div class="body" style="white-space:normal">${base.map(file).join('')}</div></details>` : ''}
    ${own.length ? `<details><summary>${T('改了本任务前几步写的测试 · {n} 个文件', { n: own.length })}</summary><div class="body" style="white-space:normal">${own.map(file).join('')}</div></details>` : ''}`;
}
// 页面点验（库里叫界面条目）：AI 验收把应用启动起来、在页面上逐条点验的结果。还没验收过的只列条目。
// 认知走查（2.5 分）：标签与计数不能共用"看过"（不对的也"看过"）；灰字要分清是 AI 看到的还是没验的原因；
// 块头要说后果 —— 打回在改，还是已放行但有几条没验（那几条签收前要人自己看）。
// 第二轮（3 分）：⚠ 只在轮到人时挂（放行了但有没验成的）；"未验"与"还没验收"太像 → 改叫"没验成"；
// 定义句每种状态都有；打回写清因哪几条；放行写清依据（页面没验成的那几条没参与）
function uiChecksHtml(n) {
  const cs = n.uiChecks; if (!cs?.length) return '';
  const R = { pass: ['ok', T('通过')], fail: ['bad', T('不对')], not_checked: ['warn', T('没验成')] };
  const k = (r) => cs.filter((c) => c.result === r).length;
  const nums = (r) => cs.filter((c) => c.result === r).map((c) => c.n).join(T('、'));
  const run = n.uiRun, live = n.uiLive, down = live && (live.state === 'none' || live.state === 'failed') && live.why;
  const counts = [k('pass') && T('通过 {n}', { n: k('pass') }), k('fail') && T('不对 {n}', { n: k('fail') }), k('not_checked') && T('没验成 {n}', { n: k('not_checked') })].filter(Boolean).join(' · ');
  // 轮到谁：打回 → AI 执行器在改；放行但有没验成的 → 轮到人（签收前自己看）；其余没人要动
  const yours = !!run && run.verdict === 'accept' && k('not_checked') > 0;
  const head = !run ? T('页面点验 · {n} 条，待点验', { n: cs.length })
    : `${T('页面点验')} · ${counts}${run.verdict !== 'accept' ? ` — ${T('AI 执行器修改中')}` : yours ? ` — ${T('签收时要你看')}` : ''}`;
  const outcome = !run ? '' : run.verdict === 'accept'
    ? (k('not_checked') ? T('按代码与测试放行；第 {nums} 条没在页面上验成，没参与判断，留给签收人：任务做完后签收事项会出现在「待决事项」里，签收时请在页面上看一下这几条', { nums: nums('not_checked') }) : '')
    : `${k('fail') ? T('因第 {nums} 条不对打回，AI 执行器正在改，改完会再验一次', { nums: nums('fail') }) : T('打回（原因见下面「打回与诊断」），AI 执行器正在改，改完会再验一次')}${k('not_checked') ? T('；没验成的第 {nums} 条下一次验收会重试', { nums: nums('not_checked') }) : ''}`;
  // 结论放最前：第几次 · 打回 / 放行 · 时间，说明跟在后面
  const when = run ? T('第 {n} 次验收 · {verdict} · {at}', { n: run.round, verdict: run.verdict === 'accept' ? T('已放行') : T('已打回'), at: fmtWhen(run.at) }) : '';
  const row = (c) => `<li style="margin-top:4px">${c.result ? `<span class="pill ${esc(R[c.result][0])}">${esc(R[c.result][1])}</span> ` : ''}${esc(c.item)}`
    + `${c.evidence && !(down && c.evidence === live.why) ? `<div class="small mute">${esc(c.result === 'not_checked' ? T('没验成的原因：{why}', { why: c.evidence }) : T('AI 看到：{what}', { what: c.evidence }))}</div>` : ''}`
    + `${liveShotsHtml(detail.task.id, n.uiScreens, c.screens)}</li>`;   // AI 引用的当时画面
  return `<details${run ? ' open' : ''}><summary>${yours ? `<b>⚠ ${head}</b>` : head}</summary><div class="body" style="white-space:normal">`
    + `<div class="small mute">${T('AI 验收会启动应用，在页面上照下面每一条点一遍、看结果')}</div>`
    + `${run ? `<div class="small"><b>${esc(when)}</b>${outcome ? ` · ${esc(outcome)}` : ''}</div>` : ''}`
    + `${down ? `<div class="small">${T('这次没能启动应用（下面几条都因此没验成）：{why}', { why: esc(live.why) })}</div>` : ''}`
    + `<ol style="margin:4px 0 0 18px;padding:0">${cs.map(row).join('')}</ol></div></details>`;
}
function diagHtml(n) {
  const d = n.diagnosis; if (!d) return '';
  const cats = DEFECT_CAT(), live = diagLive(n);
  // 表头两行：第几次（一整轮用完、从头重来 = 「重试」，标在重来后的第一次上，并画一条分界线）/ 这一次的结果
  const sep = (c) => (c.restart ? ';border-left:2px dashed var(--ink2)' : '');
  const RESULT = { mech: T('系统检查打回'), verifier: T('AI 验收打回'), env: T('环境出错'), pass: T('通过') };
  const RESULT_CLS = { mech: 'bad', verifier: 'bad', env: 'mute', pass: 'ok' };
  const th = 'text-align:center;padding:2px 6px;font-weight:normal;white-space:nowrap';
  const head1 = d.cols.map((c, i) => `<th scope="col" class="small" style="${th}${sep(c)}">${c.restart ? `<span class="mute">${T('↻ 重试后')}</span><br>` : ''}<b>${T('第 {i} 次', { i: i + 1 })}</b></th>`).join('');
  const head2 = d.cols.map((c) => `<td class="small ${RESULT_CLS[c.kind] ?? 'mute'}" style="text-align:center;padding:2px 6px${sep(c)}">${esc(RESULT[c.kind] ?? c.kind)}</td>`).join('');
  // 格子：● 这次有 / · 查了没有 / — 这次没查（环境出错，或系统检查打回、AI 验收没跑）
  // 描述开头重复类别名的（机械校验的原话是「越界改动：…」）去掉那个前缀
  const say = (w) => { const c = cats[w.category] ?? ''; return c && String(w.summary).startsWith(`${c}：`) ? String(w.summary).slice(c.length + 1) : w.summary; };
  // 改好又回来的那一格画成 ↺（复发落在哪一格，看图就知道，不只是判词里一句）
  const cell = (v, back) => (v === true ? (back ? `<span class="bad" aria-hidden="true">↺</span><span class="sr-only">${T('又回来了')}</span>` : `<span class="bad" aria-hidden="true">●</span><span class="sr-only">${T('有')}</span>`)
    : v === false ? `<span class="ok" aria-hidden="true">✓</span><span class="sr-only">${T('没有')}</span>` : `<span class="mute" aria-hidden="true">—</span><span class="sr-only">${T('没查')}</span>`);
  const backs = (cells) => { let seen = false, gap = false; return cells.map((v) => { if (v === null) return false; const b = v && seen && gap; if (v) { seen = true; gap = false; } else if (seen) gap = true; return b; }); };
  const NOW = { open: `<span class="bad">${T('还在')}</span>`, fixed: `<span class="ok">${T('已改好')}</span>`, unknown: `<span class="mute">${T('这次没查')}</span>` };
  const body = d.rows.map((w) => `<tr><th scope="row" style="text-align:left;font-weight:normal;padding:4px 6px"><span class="pill">${esc(cats[w.category] ?? w.category)}</span> ${esc(say(w))}${w.locations?.length ? ` <span class="small mute">${esc(w.locations.join(T('、')))}</span>` : ''}</th>
    ${(() => { const bk = backs(w.cells); return w.cells.map((v, i) => `<td style="text-align:center${sep(d.cols[i])}">${cell(v, bk[i])}</td>`).join(''); })()}
    <td class="small" style="padding:2px 6px;white-space:nowrap;border-left:1px solid var(--line)">${NOW[w.now] ?? ''}</td></tr>`).join('');
  const prefill = [T('关于步骤「{t}」：', { t: n.title }), ...d.rows.filter((w) => w.now === 'open').map((w) => `- ${say(w)} → `)].join('\n');
  const fix = live && d.rows.some((w) => w.now === 'open') ? `<details class="not-observer" data-diagfix="${esc(n.id)}" style="margin-top:6px"><summary><b>${T('发修正，告诉 AI 怎么改')}</b></summary>
    <textarea rows="4" style="width:100%;margin-top:4px" aria-label="${T('修正内容')}">${esc(prefill)}</textarea>
    <div class="row"><button class="primary small" data-diagsend>${T('发送修正')}</button></div></details>` : '';
  return `<details${live ? ' open' : ''}><summary>${T('打回与诊断')} · ${esc(DIAG_NAME()[d.state] ?? d.state)}</summary><div class="body" style="white-space:normal">
    <div>${diagStuck(d) && live ? `<b>⚠ ${esc(diagSentence(d))}</b>` : `<span>${esc(diagSentence(d))}</span>`}</div>
    <div style="overflow-x:auto;margin-top:6px"><table class="small" style="border-collapse:collapse">
      <caption class="sr-only">${T('每条缺陷在第几次交时出现')}</caption>
      <thead><tr><th scope="col" style="text-align:left;padding:2px 6px">${T('缺陷')}</th>${head1}<th scope="col" style="padding:2px 6px;white-space:nowrap;border-left:1px solid var(--line)">${T('现状')}</th></tr>
        <tr><th scope="row" class="small mute" style="text-align:left;padding:2px 6px;font-weight:normal">${T('结果')}</th>${head2}<td style="border-left:1px solid var(--line)"></td></tr></thead>
      <tbody>${body}</tbody></table></div>${fix}
  </div></details>`;
}
// 「发修正」：就地写、就地发，走「向任务发送消息」同一条通道（类别 = 修正），不另做专用入口。
// 发完说清接下来会怎样：自动运行没开时，AI 要等有人点「运行」才会接着做
function bindDiagFix() {
  const box = $('#nodeDetail [data-diagfix]'); if (!box) return;
  box.querySelector('[data-diagsend]').onclick = async () => {
    const body = box.querySelector('textarea').value.trim(); if (!body) return toast(T('内容不能为空'), true);
    const r = await act('say', { body, kind: 'correction' }, daemonOn ? T('修正已发给 AI，下一次交会按它改') : T('修正已发给 AI；自动运行没开，点上方「运行」它才会接着做'));
    if (r) { box.open = false; box.querySelector('[data-diagsend]').disabled = true; }
  };
}
const stName = (s) => ({ done: T('已完成'), running: T('进行中'), blocked: T('待答复'), ready: T('就绪'), pending: T('待执行'), void: T('已作废'), failed: T('失败'), review: T('验收中') }[s] ?? s);
function showNode(id) {
  const n = detail.nodes.find((x) => x.id === id); if (!n) return;
  $('#nodeDetail').innerHTML = `<div class="item"><div class="row"><b>${esc(n.title)}</b> <span class="pill ${esc(n.status)}">${esc(nodeStName(n))}</span>
    <span style="flex:1"></span> ${isLead() ? `<span class="small mute" title="${T('数值越小越先执行')}">${T('优先级')}</span> <input id="prio" type="number" value="${esc(n.priority)}" style="width:70px"> <button id="prioBtn" class="small">${T('保存')}</button>` : ''}</div>
    ${uiChecksHtml(n)}${testChangesHtml(n)}${diagHtml(n)}<details><summary>${T('步骤说明')}</summary><div class="body">${esc(n.spec)}</div></details><details><summary>${T('验收标准')}</summary><div class="body">${esc(n.acceptance)}</div></details>
    <details id="nodeProv"><summary>${T('这一步的出处')}</summary><div class="body" id="nodeProvBody"><span class="mute">${T('读取中…')}</span></div></details>
    ${n.status === 'done' ? `<details id="nodeDiff"${DV_DETAILS_OPEN.has(`node:${esc(n.id)}`) ? ' open' : ''}><summary>${T('这一步的改动（逐行取自代码）')}</summary>${dvSlot(`node:${esc(n.id)}:${esc(n.finished_at ?? '')}`, `/api/tasks/${encodeURIComponent(cur)}/diff?scope=node&node=${encodeURIComponent(n.id)}`, `/api/tasks/${encodeURIComponent(cur)}/diff_lines?scope=node&node=${encodeURIComponent(n.id)}`, { baseLabel: T('这一步开始前'), headLabel: T('这一步做完') })}</details>` : ''}</div>`;
  // 按步骤看改动（第二层）：点开才读；开着的在换步骤 / 刷新后按步骤记住
  const nd = $('#nodeDiff');
  if (nd) { if (nd.open) dvHydrate(nd); nd.ontoggle = () => { if (nd.open) { DV_DETAILS_OPEN.add(`node:${n.id}`); dvHydrate(nd); } else DV_DETAILS_OPEN.delete(`node:${n.id}`); }; }
  bindDiagFix();
  const b = $('#prioBtn'); if (b) b.onclick = () => act('priority', { nodeId: id, priority: Number($('#prio').value) }, T('优先级已保存'));
  const np = $('#nodeProv');
  const loadProv = async () => { try { $('#nodeProvBody').innerHTML = provHtml(await api(`/api/tasks/${cur}/provenance?node=${encodeURIComponent(id)}`)); } catch (e) { $('#nodeProvBody').innerHTML = `<span class="bad">${esc(e.message)}</span>`; } };
  if (np) { if (PROV_OPEN) { np.open = true; loadProv(); } np.ontoggle = () => { PROV_OPEN = np.open; if (np.open) loadProv(); }; }
}
