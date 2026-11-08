// 看板脚本按视图拆在 src/web/app/，按 index.html 里的顺序作为经典脚本执行：顶层的 let / const / function
// 在这些文件之间共用。加载期（顶层、不在函数里）只能用到本文件和前面文件声明的东西 —— tests/ui-script.test.mjs 按顺序真跑一遍。
//
// Trusted Types（支持的浏览器）：页面的 CSP 要求 innerHTML 等入口只收经策略的值。这里建 default 策略 —— 页面里的插值都先过 esc() / T()
// （tests/web-html.test.mjs 扫描），这一层先放行 HTML、拒绝动态脚本；往后要收紧就在这一处。
if (window.trustedTypes?.createPolicy) {
  try { window.trustedTypes.createPolicy('default', { createHTML: (s) => s, createScriptURL: (s) => { const u = new URL(s, location.href); if (u.origin === location.origin && u.pathname.startsWith('/app/')) return s; throw new TypeError('script URL not allowed'); } }); } catch { /* 已经建过 */ }
}
// 多语言（0.2.0）：服务端出页面时把词表放在 <script type="application/json" id="si-i18n">（见 src/i18n/index.mjs localizeHtml）。
// 用法：T(原文, 参数) —— 原文就是键，查不到回落原文；占位符写 {名字}，不要写 ${}（覆盖率测试要抽得出字面量）。
// 同一个中文在不同位置意思不同（"成员"是角色还是分区、"删除"是按钮还是文件状态）：Tc(上下文, 原文) 先查"上下文|原文"，没有再查原文。
const I18N = (() => { try { return JSON.parse(document.getElementById('si-i18n')?.textContent || 'null') ?? { lang: 'zh', catalog: {} }; } catch { return { lang: 'zh', catalog: {} }; } })();
const T = (s, p) => { const hit = I18N.catalog[s] ?? s; return p ? String(hit).replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k] ?? '') : m)) : hit; };
const Tc = (ctx, s, p) => { const k = `${ctx}|${s}`; const hit = I18N.catalog[k] ?? I18N.catalog[s] ?? s; return p ? String(hit).replace(/\{(\w+)\}/g, (m, n) => (n in p ? String(p[n] ?? '') : m)) : hit; };
// 日期时间按界面语言写，不跟浏览器的系统语言走（英文界面里冒出"2026年9月30日 下午9:28"）
const LOCALE = I18N.lang === 'en' ? 'en-US' : 'zh-CN';
// 时刻按看的人的时区写，并标出时区：自己设的 → 部署的（登录后由 /api/me 给）；还没登录 = 浏览器本地。
// 原来一律浏览器本地时间、不标时区，命令行 / 提交 / PR 是 UTC，对照着看差 8 小时。
let VIEW_TZ = null;
const fmtWhen = (ts, { date = true, time = true, zone = true, tz = VIEW_TZ } = {}) => {   // tz：按部署时区定义的东西（值班交接）照部署时区写
  if (ts == null || ts === '') return '';
  const d = new Date(typeof ts === 'string' && !/^\d+$/.test(ts) ? ts : Number(ts));
  if (Number.isNaN(d.getTime())) return '';
  // 与命令行 / 摘要同一个写法：2026-10-12 14:03 UTC+8（toLocaleString 的中文格式会把时区夹在日期和钟点之间，GMT 也不如 UTC 直白）
  let p;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { ...(tz ? { timeZone: tz } : {}), year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).formatToParts(d).map((x) => [x.type, x.value]));
  } catch { return d.toLocaleString(LOCALE); }
  const z = String(p.timeZoneName ?? '').replace(/^GMT/, 'UTC').replace('-', '−');
  return [date ? `${p.year}-${p.month}-${p.day}` : '', time ? `${p.hour}:${p.minute}` : '', time && zone ? z : ''].filter(Boolean).join(' ');
};
// 契约原文里系统写进去的几段固定中文（规则标题、出处标签、那条固定约束）：库里保持中文（执行器、验收员、路由都认这些标记），只在显示时按界面语言换掉
const CONTRACT_FIXED = [T('行为规则（每条带出处：〔规格〕后是规格原文，是最高依据，实现与它矛盾时提问；〔规划器假设〕是规格没写、规划器定的，人批准时已看到，按字面执行）：'), T('既有测试文件只许追加用例；唯一例外是断言了被本契约明确取代的中间行为的用例，可以改那一条并在交接记录里说明；其余一行不许改、不许删'), T('〔规格〕'), T('〔规划器假设〕')];
const CONTRACT_FIXED_ZH = ['行为规则（每条带出处：〔规格〕后是规格原文，是最高依据，实现与它矛盾时提问；〔规划器假设〕是规格没写、规划器定的，人批准时已看到，按字面执行）：', '既有测试文件只许追加用例；唯一例外是断言了被本契约明确取代的中间行为的用例，可以改那一条并在交接记录里说明；其余一行不许改、不许删', '〔规格〕', '〔规划器假设〕'];
const locContract = (s) => (I18N.lang === 'zh' ? String(s ?? '') : CONTRACT_FIXED_ZH.reduce((acc, k, i) => acc.split(k).join(CONTRACT_FIXED[i]), String(s ?? '')));
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (m) => '$' + ((m ?? 0) / 1e6).toFixed(4);
const ago = (ts) => { const s = Math.max(0, (Date.now() - ts) / 1000); return s < 60 ? T('{n} 秒', { n: s | 0 }) : s < 3600 ? T('{n} 分钟', { n: (s / 60) | 0 }) : s < 86400 ? T('{n} 小时', { n: (s / 3600) | 0 }) : T('{n} 天', { n: (s / 86400) | 0 }); };
/** 中文名紧贴前后文，拉丁字母开头或结尾的名字两侧留空格。 */
const sp = (w) => `${/^[\x00-\x7f]/.test(w) ? ' ' : ''}${w}${/[\x00-\x7f]$/.test(w) ? ' ' : ''}`;
const dur = (ms) => { if (ms == null) return '—'; if (ms <= 0) return T('已到期'); const m = ms / 60000; return m < 60 ? T('{n} 分钟', { n: m | 0 }) : m < 1440 ? T('{n} 小时', { n: (m / 60).toFixed(1) }) : T('{n} 天', { n: (m / 1440).toFixed(1) }); };
let cur = null, detail = null, refreshTimer = null, me = null, routingData = null;
// 快速答复：推送里的事项链接 #q/<事项> 打开的单件模式。是任务页的一种显示，答复走同一张卡片、同一个接口
let QUICK = null;

let toastTimer = null;
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.matches('[role=button]:not(button):not(a)')) { e.preventDefault(); e.target.click(); }
});
/**
 * 下拉框"选了就生效"（存设置、加接收人、切语言、换筛选）：鼠标选中立即生效；键盘用方向键浏览时不生效
 * （Windows 上合着的下拉框每按一下方向键就触发一次 change —— 原来按一下就存一次、或者把途经的人都加进接收人、或者整页换语言），
 * 按回车或离开这个框时才生效（WCAG 3.2.2）。生效后要是整块重画了，焦点放回同 id 的元素（或 refocus 给的那个）。
 */
function onPick(sel, fn, { refocus = null } = {}) {
  if (!sel) return;
  let browsing = false, committed = sel.value;
  const run = async () => {
    browsing = false;
    if (sel.value === committed) return;
    committed = sel.value;
    const id = sel.id, had = document.activeElement === sel;
    await fn(sel.value);
    if (had && !sel.isConnected) (refocus?.() ?? (id ? document.getElementById(id) : null))?.focus();
  };
  sel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void run(); }
    else if (/^(Arrow|Page|Home|End)/.test(e.key) || (e.key.length === 1 && e.key !== ' ')) browsing = true;
  });
  sel.addEventListener('change', () => { if (!browsing) void run(); });
  sel.addEventListener('blur', () => { if (browsing) void run(); });
}
/** live region（role=status / alert 的横幅）只在内容真变了才重写：每次刷新都重写，读屏会把同一句话再念一遍（4.1.3），里面展开的「详情」也会被收起 */
const setLive = (el, html) => { if (el._html !== html) { el.innerHTML = html; el._html = html; } };
/**
 * 自动刷新（SSE 推来变化）会整块重画侧栏和面板：重画前记下焦点在哪个控件（id，或 href / data-* / name / aria-label），
 * 重画后放回同一个（2.4.3）。原来焦点掉回页首，键盘用户每来一次变化就得从头 Tab。
 */
function focusKey(el) {
  if (!el || el === document.body || !el.isConnected) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  const attrs = [...el.attributes].filter((a) => a.name === 'href' || a.name.startsWith('data-') || a.name === 'name' || a.name === 'aria-label');
  return attrs.length ? el.tagName.toLowerCase() + attrs.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('') : null;
}
function restoreFocus(k) {
  if (!k || (document.activeElement && document.activeElement !== document.body)) return;
  try { document.querySelector(k)?.focus({ preventScroll: true }); } catch { /* 选择器不合法：放弃 */ }
}
/** 给读屏的播报（不可见的 polite live region）：同一句不重复念；10 秒内最多一句，多的只念最新的那句 */
let srLast = '', srAt = 0, srTimer = null;
function announce(text) {
  if (!text || text === srLast) return;
  // 念完几秒后清掉（「待你处理 N 件」处理完还挂在页底，读屏 / 读页面文字的人读到的是旧数）
  const go = () => { srLast = text; srAt = Date.now(); const el = $('#srLive'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = text; }, 50);
    setTimeout(() => { if (el.textContent === text) { el.textContent = ''; srLast = ''; } }, 8_000); } };
  clearTimeout(srTimer);
  const wait = srAt + 10_000 - Date.now();
  if (wait <= 0) go(); else srTimer = setTimeout(go, wait);
}
$('#skipMain').onclick = () => {
  const m = [...document.querySelectorAll('#content > main, #newWrap')].find((e) => !e.classList.contains('hide') && e.offsetParent !== null);
  if (!m) return;
  m.tabIndex = -1; m.focus();
};
// 淡出后把字清掉（提示条只是透明度归零，旧回执"系统理解为……"留在页面里，下一次答复后读到的还是上一次的）
function toast(t, bad, ms = 2500) { const e = $('#toast'); e.textContent = t; e.style.background = bad ? 'var(--bad)' : ''; e.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { e.classList.remove('show'); toastTimer = setTimeout(() => { e.textContent = ''; }, 300); }, ms); }
const tokenHeader = () => { const t = localStorage.getItem('si_token'); return { ...(t ? { 'x-superintern-token': t } : {}), 'x-si-lang': I18N.lang }; };
async function api(path, body) {
  // 提交：每次提交一个幂等键；网络断了用同一个键再试一次 —— 服务端认得这个键，不会把签收、答复做两遍。
  // 提交期间把点下去的那个按钮禁用，防双击
  let r, btn = null;
  if (body) {
    const key = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
    const init = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...tokenHeader() }, body: JSON.stringify(body) };
    btn = document.activeElement?.tagName === 'BUTTON' && !document.activeElement.disabled ? document.activeElement : null;
    if (btn) btn.disabled = true;
    try {
      try { r = await fetch(path, init); } catch { await new Promise((ok) => setTimeout(ok, 800)); r = await fetch(path, init); }
    } finally { if (btn) btn.disabled = false; }
  } else r = await fetch(path, { headers: tokenHeader() });
  const j = await r.json();
  if (r.status === 401 && j.login) { showLogin(); throw new Error(T('请先登录')); }   // 团队模式：会话没了（退出 / 令牌被吊销）
  // 别人在你打开之后改过：把这一块重新载入成最新的，让人在它上面重做（提示由调用方 toast）
  // 任务 / 事项上的（上限、转交……）：整页刷新成最新 —— 报错里说的"页面已刷新"就是这一下
  if (r.status === 409 && j.conflict) setTimeout(() => { if (path.startsWith('/api/routing')) renderRouting(); else if (path.startsWith('/api/llm')) renderLlm(true); else if (/^\/api\/(tasks|questions)\//.test(path)) void refresh(); }, 0);
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.data = j; throw e; }   // 报错文字随语言变，要判断的看 e.data 里的字段
  return j;
}
// 交付前的策略钩子要人确认：把钩子的话给人看，同意就带上确认码再发一次。确认码绑着那一份理由，变了服务端会再问
async function withHookAck(send) {
  const acks = [];
  for (;;) {
    try { return await send(acks); }
    catch (e) {
      const k = e.data?.hookAsk;
      if (!k || acks.includes(k) || acks.length >= 3) throw e;
      if (!confirm(`${e.message}\n\n${T('看过没问题，继续交付？')}`)) throw new Error(T('没有交付'));
      acks.push(k);
    }
  }
}
async function act(action, body, msg) {
  if (!cur) return;
  try { const r = await api(`/api/tasks/${cur}/${action}`, body || {}); toast((typeof msg === 'function' ? msg(r) : msg) || T('操作成功')); await refresh(); return r; }
  catch (e) { toast(e.message, true); }
}
const isLead = () => me && detail && me.id === detail.lead;
const roleName = (r) => ({ lead: T('管理员'), member: Tc('role', '成员'), observer: T('旁观者') }[r] ?? r);
const nameOf = (id) => detail?.users?.[id] ?? me?.users?.find((u) => u.id === id)?.display_name ?? id;

let daemonOn = false;
let projects = [];
