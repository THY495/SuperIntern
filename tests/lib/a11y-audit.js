// 无障碍检查（WCAG 2.2 AA 里能机检的那部分）。零依赖：在页面里跑，返回问题清单。
// 测试（tests/a11y.test.mjs）经 CDP 注入；开发时也可以贴进浏览器控制台：__a11yAudit()。
//
// 查的规则（括号里是 WCAG 条款）：
//   name         可操作的控件要有可访问名（4.1.2）—— aria-labelledby / aria-label / <label> / 文字 / title / value
//   label        输入框只有占位文字、没有标签（3.3.2；占位一输入就没了）
//   contrast     文字对比度 ≥ 4.5（大字 ≥ 3）（1.4.3）—— 背景按祖先逐层叠色；有背景图的不判
//   ui-contrast  输入框边框与旁边背景 ≥ 3（1.4.11）
//   target       点击目标 ≥ 24×24，或 24px 圆圈不碰别的目标（2.5.8）；句子里的链接、标签包着的勾选框除外
//   click-focus  有点击处理、光标是手形的元素键盘够不着（2.1.1）
//   live         动态提示（toast）要是 live region（4.1.3）
//   errors       错误提示元素（id 以 Err / Errors 结尾）要是 live region 或被某个控件 aria-describedby 引用（3.3.1）
//   paste        输入框不拦粘贴（3.3.8）—— 令牌、密码要能粘贴
//   reflow       320px 宽时页面不横向滚动（1.4.10）—— 只在 opts.reflow 时查（要先把视口调窄）
// 焦点可见（2.4.7）、焦点不被遮挡（2.4.11）、Tab 顺序走得到每个控件，要真按 Tab，在测试里经 CDP 做（__a11yFocusSnapshot 配合）。
(() => {
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=switch],[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]';
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.closest('[hidden],[aria-hidden=true],.hide')) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
    }
    // 折叠着的 <details> 里除了 summary 都看不见
    for (let d = el.parentElement?.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) {
      const sum = d.querySelector(':scope > summary');
      if (!(sum && (sum === el || sum.contains(el)))) return false;
    }
    return true;
  };
  const sel = (el) => {
    if (el.id) return `#${el.id}`;
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(`#${e.id}`); break; }
      const cls = [...e.classList].slice(0, 2).join('.');
      if (cls) p += `.${cls}`;
      for (const a of ['data-pane', 'data-own', 'data-ownset', 'data-rm', 'name', 'type']) if (e.hasAttribute(a)) { p += `[${a}="${e.getAttribute(a)}"]`; break; }
      parts.unshift(p);
    }
    return parts.join(' > ');
  };
  const text = (el) => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const accName = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text).join(' ').trim(); if (t) return t; }
    const al = el.getAttribute('aria-label'); if (al && al.trim()) return al.trim();
    const tag = el.tagName;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) {
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type) && el.value) return el.value;
      const ls = [...(el.labels ?? [])].map(text).join(' ').trim(); if (ls) return ls;
    } else {
      const t = text(el) || [...el.querySelectorAll('img[alt]')].map((i) => i.alt).join(' ').trim(); if (t) return t;
    }
    const ti = el.getAttribute('title'); if (ti && ti.trim()) return ti.trim();
    return '';
  };
  // 颜色 → [r,g,b,a]（0–255, 0–1）：交给 canvas 解析，color-mix / color(srgb …) 都认
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    if (!c || c === 'transparent') return [0, 0, 0, 0];
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    // getImageData 给的是预乘过的近似；alpha 单独从 fillStyle 读更准
    let a = d[3] / 255;
    const m = /rgba?\([^)]*?,\s*([\d.]+)\)$|\/\s*([\d.]+%?)\s*\)$/.exec(String(cx.fillStyle));
    if (m) { const v = m[1] ?? m[2]; a = v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v); }
    return a > 0 ? [d[0] / (d[3] / 255), d[1] / (d[3] / 255), d[2] / (d[3] / 255), a] : [0, 0, 0, 0];
  };
  const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
  /** 元素背后的实色（逐层叠到不透明为止）；遇到背景图返回 null（判不了） */
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    let acc = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return acc;
  };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const focusable = (el) => el.matches('a[href],button:not(:disabled),input:not([type=hidden]):not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex],[contenteditable=""],[contenteditable=true]') && el.tabIndex >= 0;

  window.__a11yAudit = (opts = {}) => {
    const out = [];
    const add = (rule, el, detail) => out.push({ rule, sel: el ? sel(el) : '', text: el ? (accName(el) || text(el)).slice(0, 60) : '', detail });
    const all = [...document.querySelectorAll('body *')];
    const controls = [...document.querySelectorAll(INTERACTIVE)].filter(visible);

    for (const el of controls) {
      const name = accName(el);
      if (!name) {
        const ph = el.getAttribute('placeholder');
        if (ph && ph.trim()) add('label', el, `只有占位文字「${ph.trim().slice(0, 40)}」`);
        else add('name', el, `<${el.tagName.toLowerCase()}${el.type ? ` type=${el.type}` : ''}> 没有可访问名`);
      }
    }

    // 文字对比度：有直接文字子节点、看得见的元素
    const seen = new Set();
    for (const el of all) {
      if (!visible(el) || seen.has(el)) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      seen.add(el);
      if (el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled=true]')) continue;
      const s = getComputedStyle(el);
      const bg = bgOf(el); if (!bg) continue;
      let fg = rgba(s.color);
      // 祖先的 opacity 会把字和背景一起变淡（等价于字往背景里混）
      let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      fg = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
      const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      const r = ratio(fg, bg);
      if (r < need - 0.005) add('contrast', el, `${r.toFixed(2)} < ${need}（字 ${hex(fg)} / 底 ${hex(bg)}，${size}px）`);
    }

    // 输入框边框（1.4.11）：边框是它唯一的轮廓时，边框与外面的底色要 ≥ 3
    for (const el of controls.filter((e) => e.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),select,textarea'))) {
      const s = getComputedStyle(el);
      const outer = bgOf(el.parentElement) ?? [255, 255, 255, 1];
      const own = rgba(s.backgroundColor);
      const inner = own[3] > 0 ? over(own, outer) : outer;
      const bw = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
      const border = bw > 0 ? over(rgba(s.borderTopColor), outer) : outer;
      if (Math.max(ratio(border, outer), ratio(inner, outer)) < 3 - 0.005) add('ui-contrast', el, `边框 ${hex(border)} / 外面 ${hex(outer)} = ${ratio(border, outer).toFixed(2)} < 3`);
    }

    // 点击目标尺寸（2.5.8）
    const targets = controls.filter((e) => !e.matches('input[type=hidden]'));
    const rects = new Map(targets.map((e) => [e, e.getBoundingClientRect()]));
    const inlineLink = (el) => el.tagName === 'A' && [...el.parentElement.childNodes].some((n) => n !== el && n.nodeType === 3 && n.textContent.trim());
    const labelled = (el) => el.matches('input[type=checkbox],input[type=radio]') && (el.closest('label') || el.labels?.length);
    const small = (r) => r.width < 24 - 0.5 || r.height < 24 - 0.5;
    const center = (r) => [r.left + r.width / 2, r.top + r.height / 2];
    const circleHitsRect = ([x, y], r) => { const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom); return dx * dx + dy * dy < 144; };
    for (const el of targets) {
      const r = rects.get(el);
      if (!small(r) || inlineLink(el) || labelled(el)) continue;
      const c = center(r);
      const clash = targets.find((o) => {
        if (o === el || o.contains(el) || el.contains(o)) return false;
        const q = rects.get(o);
        if (small(q)) { const d = center(q); return Math.hypot(c[0] - d[0], c[1] - d[1]) < 24; }
        return circleHitsRect(c, q);
      });
      if (clash) add('target', el, `${Math.round(r.width)}×${Math.round(r.height)}，离 ${sel(clash)} 太近`);
    }

    // 键盘够不着的点击处理（2.1.1）
    for (const el of all) {
      if (!visible(el) || focusable(el) || el.closest('label') || el.matches('label, option, :disabled')) continue;
      const handler = typeof el.onclick === 'function' || el.hasAttribute('onclick');
      const pointer = getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer');
      if (handler || (pointer && !el.closest(INTERACTIVE))) add('click-focus', el, handler ? '有点击处理但不能获得焦点' : '手形光标但不能获得焦点');
    }

    // 拦粘贴：令牌 / 密码只能手打（3.3.8 无障碍认证）
    for (const el of controls) if (el.matches('input,textarea') && (typeof el.onpaste === 'function' || el.hasAttribute('onpaste'))) add('paste', el, '输入框拦了粘贴');

    // 动态提示与错误提示
    const live = (el) => el.matches('[aria-live]:not([aria-live=off]),[role=status],[role=alert],[role=log]') || !!el.closest('[aria-live]:not([aria-live=off]),[role=status],[role=alert],[role=log]');
    const toastEl = document.getElementById('toast');
    if (toastEl && !live(toastEl)) add('live', toastEl, 'toast 不是 live region，读屏听不到');
    const described = new Set([...document.querySelectorAll('[aria-describedby],[aria-errormessage]')].flatMap((e) => `${e.getAttribute('aria-describedby') ?? ''} ${e.getAttribute('aria-errormessage') ?? ''}`.split(/\s+/)).filter(Boolean));
    for (const el of document.querySelectorAll('[id]')) if (/Err(or)?s?$/.test(el.id) && !live(el) && !described.has(el.id)) add('errors', el, '错误提示没有关联到输入框，也不是 live region');

    if (opts.reflow) {
      const de = document.documentElement;
      if (de.scrollWidth > de.clientWidth + 1) {
        const wide = all.filter((e) => visible(e) && e.getBoundingClientRect().right > de.clientWidth + 1 && !e.closest('pre, table, .scroll-x'))
          .filter((e) => ![...e.children].some((c) => c.getBoundingClientRect().right > de.clientWidth + 1));
        add('reflow', null, `宽 ${de.clientWidth}px 时页面宽 ${de.scrollWidth}px；伸出去的：${[...new Set(wide.slice(0, 6).map(sel))].join('；')}`);
      }
    }
    return out;
  };

  // 焦点：先给每个可聚焦元素记下没聚焦时的样子，测试按 Tab 后对比（2.4.7），并看它是不是整个被挡住（2.4.11）
  const look = (el) => { const s = getComputedStyle(el); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.backgroundColor, s.textDecorationLine].join('|'); };
  window.__a11yFocusBaseline = () => {
    document.activeElement?.blur?.();   // 有的视图一打开就把焦点放进输入框：先移走，记下的才是没聚焦时的样子
    const els = [...document.querySelectorAll(INTERACTIVE)].filter((e) => visible(e) && focusable(e));
    els.forEach((e, i) => { e.dataset.a11yI = String(i); e.dataset.a11yLook = look(e); });
    return els.length;
  };
  window.__a11yFocusSnapshot = () => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    // 焦点在浏览器自带控件的内部（日期框的日历按钮等）：宿主不算 :focus，外观由浏览器画，不归我们管
    if (!el.matches(':focus')) return { i: el.dataset.a11yI ?? null, sel: sel(el), name: accName(el).slice(0, 40), changed: true, shown: true, inner: true };
    const changed = el.dataset.a11yLook !== undefined ? el.dataset.a11yLook !== look(el) : true;
    const r = el.getBoundingClientRect();
    const pts = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.2], [0.5, 0.8]].map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy]);
    const shown = pts.some(([x, y]) => { const h = document.elementFromPoint(x, y); return h && (h === el || el.contains(h) || h.contains(el)); });
    return { i: el.dataset.a11yI ?? null, sel: sel(el), name: accName(el).slice(0, 40), changed, shown, look: changed ? '' : look(el) };
  };
  window.__a11yTabbable = () => [...document.querySelectorAll('[data-a11y-i]')].filter((e) => visible(e) && focusable(e)).map((e) => ({ i: e.dataset.a11yI, sel: sel(e), name: accName(e).slice(0, 40) }));
})();
