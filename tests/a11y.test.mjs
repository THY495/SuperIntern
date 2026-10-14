// @needs: browser
// 无障碍（WCAG 2.2 AA 里能机检的部分）：在无头 Chromium 里打开看板的每个视图，
// 亮色、暗色各查一遍（tests/lib/a11y-audit.js），再真按 Tab 走一遍（焦点看得见、不被挡住、每个控件都走得到），
// 最后把视口调到 320px 看会不会横向滚动。
//
// 跑：node tests/a11y.test.mjs（要本机有 Chrome / Edge / Chromium；SUPERINTERN_CHROME 可指定）
//     A11Y_REPORT=1 node tests/a11y.test.mjs   → 只打印问题清单，不判失败（修之前摸底用）

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, ensureOwner, newId, now, insertEdge, audit } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { setSetting } from '../src/core/settings.mjs';
import { setDutyCalendar, setDutyOverrides, dutyStartAt } from '../src/core/routing.mjs';
import { startWeb } from '../src/web/server.mjs';
import { findBrowser, launch, openPage } from './lib/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = !!process.env.A11Y_REPORT;
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${String(e).split('\n').join('\n         ')}` : ''}`); };
const section = (t) => console.log(`\n── ${t}`);

const exe = findBrowser();
if (!exe) {
  console.log('  [FAIL] 找不到 Chrome / Edge / Chromium（设 SUPERINTERN_CHROME 指向浏览器，或 node tests/run.mjs --all --without browser 跳过本套）');
  console.log(`\n${'═'.repeat(72)}\n❌ 0 通过，1 失败\n${'═'.repeat(72)}`);
  process.exit(1);
}

// ── 种数据：一个跑着的任务（两步、一个待答事项、一条假设）、一个项目、几个成员、值班表与节假日 ──
const TMP = mkdtempSync(join(tmpdir(), 'si-a11y-'));
const db = openDb(join(TMP, 'state.db'));
const owner = ensureOwner(db, '负责人');
const m1 = addUser(db, { name: '张三', role: 'member', byUserId: owner.userId });
const m2 = addUser(db, { name: '李四', role: 'member', byUserId: owner.userId });
addUser(db, { name: '旁观', role: 'observer', byUserId: owner.userId });
const t0 = now();
const taskId = newId('t'), n1 = newId('n'), n2 = newId('n');
db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'导出 CSV','running',?)`, taskId, owner.userId, t0);
db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'导出订单为 CSV','.','测试全过','["不改数据库结构"]',?,?)`, newId('c'), taskId, t0, t0);
db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'写导出函数','s','a','running',5,?)`, n1, taskId, t0);
db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,priority,created_at) VALUES (?,?,'加命令行入口','s','a','blocked',5,?)`, n2, taskId, t0);
insertEdge(db, n2, n1, 'depends_on', t0);
const qId = newId('q');
db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
        VALUES (?,?,?,1,'classifier','字段里有逗号时要不要加引号？','加引号',?,?,'open')`, qId, taskId, n2, t0, t0 + 30 * 60_000);
db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,verified_against,verification,must_disclose,valid_from,recorded_at)
        VALUES (?,?,?,'csv.encoding','用 UTF-8','confirmed','settled_by_me','规格没写，按惯例',1,?,?)`, newId('a'), taskId, n1, t0, t0);
setSetting(db, { key: 'deploy.timezone', value: 'Asia/Shanghai', userId: owner.userId });
setSetting(db, { key: 'deploy.holidays', value: '2026-10-01..2026-10-07 国庆\n2026-10-11 班\n2027-01-01 元旦', userId: owner.userId });
setDutyCalendar(db, { key: '', users: [m1.userId, m2.userId], startAt: dutyStartAt(db, '2026-10-12', '09:00'), periodDays: 7, userId: owner.userId });
setDutyOverrides(db, { key: '', overrides: [{ from: '2026-10-20', to: '2026-10-21', user: owner.userId, note: '代班' }], userId: owner.userId });

// 不许调模型：分类器一被叫就报错
const noLlm = () => { throw new Error('a11y 测试不调模型'); };
const w = await startWeb(db, { home: TMP, port: 0, tokenPlain: owner.plaintext, pollMs: 150, makeClassifierClient: noLlm, runtime: { current: () => ({ ok: true, cli: 'docker' }) } });
const base = `http://127.0.0.1:${w.port}`;
const proj = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: '订单系统', doneDefinition: '上线', empty: true }) })).json();
const projectId = proj.result?.projectId;
// 团队模式的登录页另起一个
const wt = await startWeb(db, { home: TMP, port: 0, tokenPlain: owner.plaintext, pollMs: 60_000, team: true, publicUrl: 'http://localhost', runtime: { current: () => ({ ok: true, cli: 'docker' }) } });

const AUDIT = readFileSync(join(HERE, 'lib', 'a11y-audit.js'), 'utf8');
const browser = await launch(exe);
const page = await openPage(browser.port);
const { send, evaluate } = page;
await send('Page.enable'); await send('Runtime.enable');
// 无头窗口没有系统焦点时 :focus 不匹配（element.focus() 了也不算）：让页面始终当作有焦点
await send('Emulation.setFocusEmulationEnabled', { enabled: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scheme = (v) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
const viewport = (width, height = 900) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
/** 等页面安静下来：没有进行中的请求、DOM 0.4 s 没变 */
const settle = async () => {
  await evaluate(`new Promise((res) => { let t; const done = () => { mo.disconnect(); res(true); }; const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 400); }); mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); t = setTimeout(done, 400); setTimeout(done, 6000); })`);
};
const go = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 100; i++) { if (await evaluate('document.readyState === "complete" && !!document.body').catch(() => false)) break; await sleep(50); }
  await settle();
  await evaluate(AUDIT);
};
const VIEWS = [
  ['收件箱', `${base}/#inbox`],
  ['新建项目', `${base}/#new`],
  ['任务', `${base}/#${taskId}`],
  ['项目', `${base}/#p/${projectId}`],
  ...['general', 'members', 'routing', 'budget', 'auto', 'net', 'danger'].map((p) => [`项目设置 · ${p}`, `${base}/#p/${projectId}/settings`, `document.querySelector('#psnav button[data-ps="${p}"]')?.click()`]),
  ...['bind', 'ep', 'conn', 'egress', 'model', 'routing', 'users', 'sessions', 'spend', 'time', 'health'].map((p) => [`设置 · ${p}`, `${base}/#settings/${p}`]),
  ['登录页（团队模式）', `http://localhost:${wt.port}/`],
];

const issues = new Map();   // rule → Map(key → { view, sel, text, detail })
const note = (view, it) => {
  if (!issues.has(it.rule)) issues.set(it.rule, new Map());
  const k = `${it.sel}|${it.detail.replace(/\d+(\.\d+)?/g, '#')}`;
  const m = issues.get(it.rule);
  if (!m.has(k)) m.set(k, { ...it, views: [view] }); else if (!m.get(k).views.includes(view)) m.get(k).views.push(view);
};

try {
  section('0 · 检查器自检：故意做错的页面，每条规则都要报出来');
  {
    await send('Page.navigate', { url: 'about:blank' }); await sleep(200);
    await evaluate(`document.documentElement.lang = 'zh'; document.body.innerHTML = \`
      <div style="background:#fff;color:#bbb;font-size:14px">浅灰字</div>
      <button style="width:14px;height:14px;padding:0"></button><button style="width:14px;height:14px;padding:0">b</button>
      <input placeholder="只有占位"><input id="nopaste" aria-label="令牌"><input style="border:1px solid #eee;background:#fff" aria-label="边框太浅">
      <div id="clicky" style="cursor:pointer">点我</div>
      <span id="saveErrors"></span><div id="toast"></div>
      <div style="width:900px">很宽</div>\`; document.getElementById('clicky').onclick = () => {}; document.getElementById('nopaste').onpaste = (e) => e.preventDefault();`);
    await evaluate(AUDIT);
    const got = new Set((await evaluate('__a11yAudit({ reflow: true })')).map((x) => x.rule));
    await viewport(320, 800);
    for (const x of await evaluate('__a11yAudit({ reflow: true })')) got.add(x.rule);
    await viewport(1280);
    const want = ['contrast', 'name', 'target', 'label', 'ui-contrast', 'click-focus', 'errors', 'live', 'reflow', 'paste'];
    const missed = want.filter((r) => !got.has(r));
    missed.length ? bad('检查器漏报', missed.join('、')) : ok(`检查器 ${want.length} 条规则都能报出问题`);
  }

  section('0b · 键盘用方向键浏览「＋ 添加接收人」不会把途经的人都加进去；回车才加，焦点留在原处');
  {
    await go(`${base}/#settings/routing`);
    const count = `document.querySelector('span[data-own="spec_choice"]').querySelectorAll('.chip').length`;
    const n0 = await evaluate(count);
    await evaluate(`document.querySelector('span[data-own="spec_choice"] .rp-add').focus()`);
    const key = async (k, code, vk) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
    for (let i = 0; i < 3; i++) await key('ArrowDown', 'ArrowDown', 40);
    const n1 = await evaluate(count);
    await key('Enter', 'Enter', 13); await sleep(100);
    const [n2, focused] = await evaluate(`[${count}, document.activeElement?.matches('span[data-own="spec_choice"] .rp-add') ?? false]`);
    n1 === n0 && n2 === n0 + 1 && focused ? ok('方向键只是浏览；回车加一个；焦点还在「＋ 添加」上')
      : bad('键盘选接收人', `原有 ${n0}，按 3 次下箭头后 ${n1}，回车后 ${n2}，焦点在原处：${focused}`);
  }

  section('0c · 自动刷新（SSE）不把键盘焦点弄丢；待你处理的变多了，读屏会念一句');
  {
    await go(`${base}/#inbox`);
    const link = `#sideNav a[href="#${taskId}"]`;
    await evaluate(`document.querySelector('${link}').focus()`);
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status) VALUES (?,?,?,1,'classifier','日期用什么格式？','ISO',?,?,'open')`, newId('q'), taskId, n2, now(), now() + 30 * 60_000);
    audit(db, { actorKind: 'system', action: 'question_opened', targetType: 'task', targetId: taskId, payload: {} });
    await sleep(2500);
    const [still, said] = await evaluate(`[document.activeElement?.matches('${link}') ?? false, document.querySelector('#srLive')?.textContent ?? '']`);
    still ? ok('刷新后焦点还在原来的侧栏链接上') : bad('刷新后焦点丢了', await evaluate('document.activeElement?.outerHTML?.slice(0, 120) ?? null'));
    /待你处理的事项：\d+ 件/.test(said) ? ok(`读屏播报：「${said}」`) : bad('没有播报待你处理的事项', said);
  }

  section('0d · 只用键盘答一个待决事项：Tab 到答复框、打字、Tab 到「答复」、回车');
  {
    await go(`${base}/#${taskId}`);
    await evaluate(`{ const s = document.createElement('span'); s.tabIndex = -1; document.body.prepend(s); s.focus(); s.remove(); }`);
    const tab = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); };
    await tab();
    const skip = await evaluate(`document.activeElement?.id === 'skipMain'`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const inMain = await evaluate(`document.activeElement?.id === 'viewTask'`);
    skip && inMain ? ok('页首第一个 Tab 是「跳到正文」，回车后焦点进了任务视图（2.4.1）') : bad('跳到正文', `第一个 Tab 是它：${skip}；回车后焦点在任务视图：${inMain}`);
    let steps = 0, onBox = false;
    for (; steps < 300 && !onBox; steps++) { await tab(); onBox = await evaluate(`document.activeElement?.matches('textarea[data-q="${qId}"]') ?? false`); }
    if (!onBox) bad('Tab 走不到答复框');
    else {
      await send('Input.insertText', { text: '要加引号' });
      await tab();
      const onBtn = await evaluate(`document.activeElement?.matches('button[data-ans="${qId}"]') ?? false`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });   // 带 text 才会产生 keypress、触发按钮
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      let st = null;
      for (let i = 0; i < 40 && !st; i++) { await sleep(100); st = db.one(`SELECT m.body FROM messages m JOIN edges e ON e.from_id=m.id AND e.to_id=? AND e.relation='answers'`, qId)?.body ?? null; }
      onBtn && st === '要加引号' ? ok(`跳过页首后再按 ${steps} 次 Tab 到答复框；打字、Tab、回车 → 答复记进了库`) : bad('键盘答复', `答复框之后的焦点在「答复」按钮上：${onBtn}；库里的答复：${st}`);
    }
  }

  for (const [name, url, after] of VIEWS) {
    await viewport(1280); await scheme('light');
    await go(url);
    if (after) { await evaluate(after); await settle(); await evaluate(AUDIT); }
    // 折叠里的东西也要查：全部展开
    await evaluate(`document.querySelectorAll('details').forEach((d) => { d.open = true; })`); await settle();
    for (const it of await evaluate('__a11yAudit()')) note(name, it);
    await scheme('dark'); await settle();
    for (const it of await evaluate('__a11yAudit()')) if (it.rule === 'contrast' || it.rule === 'ui-contrast') note(`${name}（暗色）`, { ...it, rule: `${it.rule}-dark` });
    await scheme('light');

    // 键盘：从页首按 Tab 走一圈
    const n = await evaluate('__a11yFocusBaseline()');
    // 顺序导航的起点放回页首（有的视图一打开就把焦点放进输入框；只 blur 的话 Tab 从那里接着走、绕回页首时状态不对）
    await evaluate("document.activeElement?.blur(); window.scrollTo(0, 0); { const s = document.createElement('span'); s.tabIndex = -1; document.body.prepend(s); s.focus(); s.remove(); }");
    const reached = new Set();
    let first = null;
    for (let i = 0; i < n + 20; i++) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      const s = await evaluate('__a11yFocusSnapshot()');
      if (!s) { if (first != null) break; continue; }   // 走出了页面（到了浏览器自己的界面）= 一圈走完
      const key = s.i ?? s.sel;
      if (key === first) break;
      first ??= key;
      if (s.i != null) reached.add(s.i);
      if (!s.changed) note(name, { rule: 'focus-visible', sel: s.sel, text: s.name, detail: `获得焦点时外观没有变化（${s.look}）` });
      if (!s.shown) note(name, { rule: 'focus-obscured', sel: s.sel, text: s.name, detail: '获得焦点时被别的东西整个挡住' });
    }
    for (const t of await evaluate('__a11yTabbable()')) if (!reached.has(t.i)) note(name, { rule: 'tab-order', sel: t.sel, text: t.name, detail: '按 Tab 走不到' });

    // 窄屏
    await viewport(320, 800); await settle();
    for (const it of await evaluate('__a11yAudit({ reflow: true })')) if (it.rule === 'reflow') note(name, it);
    await viewport(1280);
  }
} catch (e) {
  bad('意外异常', e.stack);
}

const RULES = { name: '控件有可访问名（4.1.2）', label: '输入框有标签，不只靠占位文字（3.3.2）', contrast: '文字对比度（1.4.3，亮色）', 'contrast-dark': '文字对比度（1.4.3，暗色）',
  'ui-contrast': '输入框边框对比度（1.4.11，亮色）', 'ui-contrast-dark': '输入框边框对比度（1.4.11，暗色）', target: '点击目标 ≥ 24px 或间距够（2.5.8）', 'click-focus': '能点的都能用键盘（2.1.1）',
  live: '动态提示是 live region（4.1.3）', paste: '输入框不拦粘贴（3.3.8）', errors: '错误提示关联到输入框（3.3.1）', 'focus-visible': '焦点看得见（2.4.7）', 'focus-obscured': '焦点不被挡住（2.4.11）', 'tab-order': 'Tab 走得到每个控件（2.1.1）', reflow: '320px 宽不横向滚动（1.4.10）' };
section(`${VIEWS.length} 个视图`);
for (const [rule, label] of Object.entries(RULES)) {
  const m = issues.get(rule);
  const list = m ? [...m.values()] : [];
  const lines = list.slice(0, REPORT ? 400 : 12).map((x) => `${x.sel}${x.text ? `「${x.text}」` : ''}：${x.detail}  ← ${x.views.slice(0, 3).join('、')}${x.views.length > 3 ? ` 等 ${x.views.length} 处` : ''}`);
  if (!list.length) ok(label);
  else if (REPORT) { console.log(`  [${list.length}] ${label}\n         ${lines.join('\n         ')}`); }
  else bad(`${label}：${list.length} 处`, lines.join('\n') + (list.length > 12 ? `\n…另 ${list.length - 12} 处（A11Y_REPORT=1 列全）` : ''));
}

page.close();
await browser.close();
await w.close?.(); await wt.close?.();
db.close();
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 偶尔还占着 */ }
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = REPORT ? 0 : fail ? 1 : 0;
