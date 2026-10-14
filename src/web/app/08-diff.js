// ── 改动对比（任务页 / 收件箱签收 / 交付页共用）─────────────
// 直接取自代码（服务端跑 git diff），不是 agent 的自述。默认统一视图，可切左右对照（记在本机）；
// 小文件默认展开，大文件与锁文件等生成物折叠；交付页全部默认折叠。
// 页面每次刷新都整块重写 innerHTML：数据、展开状态、已展开的未改动行都存在这里，重渲染时照原样还原，不重新请求。
// 缓存键由调用方给：内容变了（有了新提交）调用方换一个键。
const DV = { data: new Map(), inflight: new Map(), open: new Map(), gaps: new Map(), scope: new Map() };
let dvMode = (() => { try { return localStorage.getItem('si.diffMode') === 'split' ? 'split' : 'unified'; } catch { return 'unified'; } })();
const DV_OPEN_MAX = 200;
const DV_DETAILS_OPEN = new Set();   // 收件箱签收 / 交付页里点开了"看改动"的那几块（刷新后保持开着）
const DV_ST = { added: Tc('file', '新增'), deleted: Tc('file', '删除'), renamed: Tc('file', '改名') };
// 签收事项正文里贴着的原始 diff（给命令行看的）：网页上有逐行的对比组件，这里只留文件清单，不再重复一份没颜色的原文。
const dvStripPatch = (text, where) => String(text).replace(/```diff\n[\s\S]*?\n```/, T('（逐行改动见{where}）', { where }));
// 事项正文是按命令行写的（"请选一条：(A) 接受：node src/cli.mjs …"、"不该你答？转给…：node src/cli.mjs question transfer …"）。
// 网页上有对应的按钮：签收的三行换成指向按钮的一句，转交提示去掉（事项右边就有「转交」按钮）。
const webQText = (text, type, where = 'task') => {
  let s = String(text ?? '');
  // 正文按内容语言写（中文或英文），两种都认 —— 与 src/i18n/marks.mjs 的 transferHint、deliver.mjs 签收正文的英文译文同一口径
  const i = Math.max(s.indexOf('　　·　不该你答？'), s.indexOf('　　·　Not yours to answer?')); if (i >= 0) s = s.slice(0, i).trimEnd();
  // 结构矛盾的系统附注（"答复改不了契约，要改就作为计划变更提交"）是写给命令行的；网页上答复框下就是那个勾选框，
  // 要点写在勾选框上。整段留着会把冲突原文与要拍的板淹掉（关键一句埋在中间，读两遍才抓到）
  s = s.replace(/\n*——\n\*\*(系统附注（不由模型生成）|System note \(not written by the AI\))\*\*[^\n]*/, '');
  if (type === 'signoff') {
    s = dvStripPatch(s, where === 'task' ? T('下方「改动」卡片') : T('下面的「看改动」'));
    // 「签收前先看这些」那一节网页上按结构单独画在正文上面（excHtml），这里去掉，免得一样的话出现两遍
    s = s.replace(/(^|\n)## (签收前先看这些|Look at these before signing off)[^\n]*(\n[^\n]+)*\n*/, '$1');   // 那一节到第一个空行为止
    s = s.replace(/(请选一条：|Please pick one:)\n\(A\)[^\n]*\n\(B\)[^\n]*\n\(C\)[^\n]*/, where === 'task'
      ? T('点这条事项下面的「接受」或「打回」（打回要写理由：理由会作为修正指令，任务据此重新规划）。想先看这个任务是怎么做的：看「活动」和「报告」。')
      : T('点上面的标题打开任务页，在「待决事项」里点「接受」或「打回」（打回要写理由）。'));
  }
  return s;
};
// 事项正文的 HTML：先整段转义，再把 **加粗** 换成 <b>（正文按命令行写，系统附注靠它标重点；转义后不会再有别的标签）
const mdBold = (text) => esc(text).replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>');
const qBodyHtml = (text, type, where) => mdBold(webQText(text, type, where));
// 拆成第一段与其余（签收卡把「签收前先看这些」插在"任务已完成"那句与产物之间）：在转义后的文本上按空行切，切不出新标签
const qBodySplit = (text, type, where) => { const h = qBodyHtml(text, type, where), i = h.indexOf('\n\n'); return i < 0 ? [h, ''] : [h.slice(0, i), h.slice(i + 2)]; };
// 分段标题后面那段是 git 猜的"所在函数"：对 Python 等常常猜成一行注释 / 文档字符串（规则看不懂、前后不一致）。
// 只在它看起来像一个定义行时才显示，其余不显示 —— 行号已经够定位。
const dvCtx = (c) => (/^\s*(?:export\s+|async\s+|public\s+|private\s+|protected\s+|static\s+)*(?:def|class|function|func|fn|impl|struct|interface|enum|type|const|let|var|module|package|sub|proc)\b/.test(c ?? '') ? String(c).trim() : '');
// scopes：这一块允许切"这一轮 / 全部"（任务页、收件箱签收；返工签收时才真的出现开关）。
function dvSlot(key, url, linesUrl, { allClosed = false, baseLabel = T('接手时的代码'), headLabel = T('现在'), scopes = false } = {}) {
  return `<div class="dv-slot" data-dk="${esc(key)}" data-url="${esc(url)}" data-lurl="${esc(linesUrl)}" data-bl="${esc(baseLabel)}" data-hl="${esc(headLabel)}"${allClosed ? ' data-closed="1"' : ''}${scopes ? ' data-scopes="1"' : ''}></div>`;
}
const dvQ = (u, q) => `${u}${u.includes('?') ? '&' : '?'}${q}`;
// 一块对比当前看的是哪个口径：没选过 = auto（服务端决定：返工签收待决时给这一轮，否则全部）。数据、展开状态都按"块 + 口径"分开存。
const dvVk = (key) => `${key}|${DV.scope.get(key) ?? 'auto'}`;
function dvHydrate(root) {
  root.querySelectorAll('.dv-slot').forEach((el) => {
    const key = el.dataset.dk, vk = dvVk(key), sc = DV.scope.get(key);
    if (DV.data.has(vk)) return dvRender(el);
    el.innerHTML = `<span class="small mute">${T('正在读取改动…')}</span>`;
    if (!DV.inflight.has(vk)) {
      DV.inflight.set(vk, api(sc ? dvQ(el.dataset.url, `scope=${sc}`) : el.dataset.url).then((d) => DV.data.set(vk, d), (e) => DV.data.set(vk, { ok: false, reason: e.message }))
        .then(() => { DV.inflight.delete(vk); dvRenderKey(key); }));
    }
  });
}
const dvRenderKey = (key) => document.querySelectorAll(`.dv-slot[data-dk="${CSS.escape(key)}"]`).forEach((el) => (DV.data.has(dvVk(key)) ? dvRender(el) : dvHydrate(el.parentElement)));
function dvRender(el) {
  const key = el.dataset.dk, vk = dvVk(key), d = DV.data.get(vk);
  if (!d) return;
  // "这一轮 / 全部"：只有返工签收（有上一次签收的头）才有得切
  const round = d.scope === 'round';
  const seg = el.dataset.scopes && d.roundSince
    ? `<span class="dv-seg" title="${T('返工之后的签收：这一轮 = 上次请求签收之后改的；全部 = 从接手时的代码起这个任务改过的全部')}"><button data-dvs="round" class="${round ? 'on' : ''}">${T('这一轮')}</button><button data-dvs="all" class="${round ? '' : 'on'}">${T('全部')}</button></span>` : '';
  const bindScope = () => el.querySelectorAll('[data-dvs]').forEach((b) => b.onclick = () => { DV.scope.set(key, b.dataset.dvs); dvRenderKey(key); });
  if (!d.ok) { el.innerHTML = `${seg ? `<div class="dv-bar small">${seg}</div>` : ''}<div class="small mute">${T('看不到改动：{reason}', { reason: esc(d.reason ?? T('原因不明')) })}</div>`; bindScope(); return; }
  const bl = round ? T('上次请求签收时') : el.dataset.bl, hl = round ? T('现在') : el.dataset.hl;
  const notes = [
    round && d.brought?.length ? T('另有 {n} 个文件是把项目分支合进来带来的，不是这一轮改的，没列在下面：{files}', { n: d.brought.length, files: `${d.brought.slice(0, 6).map(esc).join(T('、'))}${d.brought.length > 6 ? ' …' : ''}` }) : '',
    d.times > 1 ? T('这一步做过 {n} 次，下面是最后一次的改动', { n: esc(d.times) }) : '',
  ].filter(Boolean).map((x) => `<div class="small mute">${x}</div>`).join('');
  const bar = (inner) => `<div class="dv-bar small">${inner}</div>`;
  if (!d.files.length) { el.innerHTML = bar(`<span class="mute">${T('对比：{base} → {head}', { base: esc(bl), head: esc(hl) })}</span><span class="grow"></span>${seg}`) + notes + `<div class="small mute">${T('没有文件变化')}</div>`; bindScope(); return; }
  const viewable = (f) => !f.omitted && !f.binary;
  const openOf = (f) => { const k = `${vk}|${f.path}`; return DV.open.has(k) ? DV.open.get(k) : (!el.dataset.closed && viewable(f) && f.lines <= DV_OPEN_MAX); };
  const allOpen = d.files.filter(viewable).every(openOf);
  el.innerHTML = bar(`<span>${T('{n} 个文件', { n: d.files.length })} <span class="dv-add">+${esc(d.adds)}</span> <span class="dv-del">−${esc(d.dels)}</span></span>
      <span class="mute">${T('对比：{base} → {head}', { base: `${esc(bl)} <span class="mono">${esc(String(d.base).slice(0, 8))}</span>`, head: `${esc(hl)} <span class="mono">${esc(String(d.head).slice(0, 8))}</span>` })}</span>
      <span class="grow"></span>${seg}
      <span class="dv-seg"><button data-dvm="unified" class="${dvMode === 'unified' ? 'on' : ''}">${T('统一')}</button><button data-dvm="split" class="${dvMode === 'split' ? 'on' : ''}">${T('左右对照')}</button></span>
      ${d.files.some(viewable) ? `<button data-dvall class="ghost small">${allOpen ? T('全部折叠') : T('全部展开')}</button>` : ''}`) + notes
    + d.files.map((f, i) => {
      const name = f.status === 'renamed' && f.oldPath ? `${esc(f.oldPath)} → ${esc(f.path)}` : esc(f.path);
      const note = f.binary ? T('二进制文件，不逐行显示') : f.omitted === 'generated' ? T('自动生成的文件（锁文件等），只列行数') : f.omitted === 'too_large' ? T('改动太多（{n} 行），只列行数', { n: esc(f.lines) }) : '';
      const open = viewable(f) && openOf(f);
      return `<div class="dv-file"><div class="dv-fh" data-dvf="${esc(i)}"><span class="mute">${viewable(f) ? (open ? '▾' : '▸') : '·'}</span><span class="p">${name}</span>${DV_ST[f.status] ? `<span class="pill">${DV_ST[f.status]}</span>` : ''}<span class="dv-add">+${esc(f.adds)}</span><span class="dv-del">−${esc(f.dels)}</span>${note ? `<span class="mute">${note}</span>` : ''}</div>`
        + (open ? `<div class="dv-body"><table class="dv">${dvMode === 'split' ? '<colgroup><col style="width:3.4em"><col><col style="width:3.4em"><col></colgroup>' : '<colgroup><col style="width:3.4em"><col style="width:3.4em"><col style="width:1.4em"><col></colgroup>'}${dvRows(vk, f)}</table></div>` : '')
        + '</div>';
    }).join('');
  bindScope();
  el.querySelectorAll('[data-dvm]').forEach((b) => b.onclick = () => { dvMode = b.dataset.dvm; try { localStorage.setItem('si.diffMode', dvMode); } catch { /* 记不住就算了 */ } document.querySelectorAll('.dv-slot').forEach(dvRender); });
  const all = el.querySelector('[data-dvall]');
  if (all) all.onclick = () => { for (const f of d.files) if (viewable(f)) DV.open.set(`${vk}|${f.path}`, !allOpen); dvRenderKey(key); };
  el.querySelectorAll('.dv-fh').forEach((h) => h.onclick = () => { const f = d.files[+h.dataset.dvf]; if (!viewable(f)) return; DV.open.set(`${vk}|${f.path}`, !openOf(f)); dvRenderKey(key); });
  el.querySelectorAll('tr.gap').forEach((tr) => tr.onclick = async () => {
    const f = d.files[+tr.dataset.f];
    tr.firstElementChild.textContent = T('正在读取…');
    try {
      // 取行要和这份数据同一个口径（这一轮 / 全部的新版本是同一个头，但"改过的文件"不同，服务端按口径核对）
      const lu = /[?&]scope=/.test(el.dataset.lurl) ? el.dataset.lurl : dvQ(el.dataset.lurl, `scope=${d.scope ?? 'all'}`);
      const r = await api(dvQ(lu, `path=${encodeURIComponent(f.path)}&from=${tr.dataset.from}&to=${tr.dataset.to}`));
      if (!r.ok) throw new Error(r.reason);
      DV.gaps.set(`${vk}|${f.path}|${tr.dataset.from}`, r.lines);
      dvRenderKey(key);
    } catch (e) { tr.firstElementChild.textContent = T('读不到：{msg}', { msg: e.message }); }
  });
}
/** 一个文件的全部行：hunk 之间、文件头尾是可展开的"未改动"段（新增 / 删除的文件整个都在 hunk 里，没有这一段）。 */
function dvRows(key, f) {
  const fi = DV.data.get(key).files.indexOf(f);
  const canGap = f.status !== 'added' && f.status !== 'deleted';
  const ctx = (o, n, t) => (dvMode === 'split'
    ? `<tr><td class="ln">${esc(o)}</td><td>${esc(t)}</td><td class="ln">${esc(n)}</td><td>${esc(t)}</td></tr>`
    : `<tr><td class="ln">${esc(o)}</td><td class="ln">${esc(n)}</td><td class="mk"></td><td>${esc(t)}</td></tr>`);
  const gap = (from, to, off) => {
    const got = DV.gaps.get(`${key}|${f.path}|${from}`);
    if (got) return got.map((t, j) => ctx(from + j + off, from + j, t)).join('');
    return `<tr class="gap" data-f="${esc(fi)}" data-from="${esc(from)}" data-to="${esc(to ?? '')}"><td colspan="4">${to ? T('⇕ 展开 {n} 行未改动的代码', { n: to - from + 1 }) : T('⇕ 展开到文件末尾的未改动的代码')}</td></tr>`;
  };
  let out = '', nextNew = 1, nextOld = 1;
  for (const h of f.hunks) {
    const hs = h.newLines ? h.newStart : h.newStart + 1, os = h.oldLines ? h.oldStart : h.oldStart + 1;
    if (canGap && hs > nextNew) out += gap(nextNew, hs - 1, os - hs);
    if (canGap) out += `<tr class="hh"><td colspan="4">${T('原第 {old} 行起 → 现第 {new} 行起', { old: esc(h.oldStart), new: esc(h.newStart) })}${dvCtx(h.ctx) ? ` · ${T('所在：{fn}', { fn: esc(dvCtx(h.ctx)) })}` : ''}</td></tr>`;
    let o = h.oldStart, n = h.newStart;
    if (dvMode !== 'split') {
      for (const [k, t] of h.lines) {
        if (k === '-') out += `<tr class="d"><td class="ln">${o++}</td><td class="ln"></td><td class="mk">−</td><td>${esc(t)}</td></tr>`;
        else if (k === '+') out += `<tr class="a"><td class="ln"></td><td class="ln">${n++}</td><td class="mk">+</td><td>${esc(t)}</td></tr>`;
        else out += ctx(o++, n++, t);
      }
    } else {
      const L = h.lines; let i = 0;
      while (i < L.length) {
        if (L[i][0] === ' ') { out += ctx(o++, n++, L[i][1]); i++; continue; }
        const D = [], A = [];
        while (i < L.length && L[i][0] === '-') D.push(L[i++][1]);
        while (i < L.length && L[i][0] === '+') A.push(L[i++][1]);
        for (let j = 0; j < Math.max(D.length, A.length); j++) {
          const l = j < D.length ? `<td class="ln d">${o++}</td><td class="d"><span class="mk">− </span>${esc(D[j])}</td>` : '<td class="ln"></td><td></td>';
          const r = j < A.length ? `<td class="ln a">${n++}</td><td class="a"><span class="mk">+ </span>${esc(A[j])}</td>` : '<td class="ln"></td><td></td>';
          out += `<tr>${l}${r}</tr>`;
        }
      }
    }
    nextNew = h.newLines ? h.newStart + h.newLines : h.newStart + 1;
    nextOld = h.oldLines ? h.oldStart + h.oldLines : h.oldStart + 1;
  }
  // 文件末尾那一段：知道总行数就给确数、没有就不显示；不知道（读不到）才退回"展开到文件末尾"
  if (canGap && f.hunks.length && (f.total == null || f.total >= nextNew)) {
    const got = DV.gaps.get(`${key}|${f.path}|${nextNew}`);
    if (!got || got.length) out += gap(nextNew, f.total ?? null, nextOld - nextNew);
  }
  return out;
}
