// 多语言（0.2.0）
//
// 跑：node tests/i18n.test.mjs
//
// ① tl / fmt / 回落：中文原样；英文查目录，查不到回落中文；占位符照填
// ② 覆盖率：源码里每条要翻的原文英文目录里都有；目录里没有用不上的条目；占位符两边一致；键是字面量、不含 ${}
// ③ 语言从哪来：部署的内容语言（设置 deploy.content_lang）、每人的界面语言（users.lang，空 = 跟随部署）
// ④ 看板接口：/api/i18n 公开给词表、/api/me 带语言、/api/me/lang 改自己的、报错按 X-SI-Lang 翻

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner } from '../src/db/db.mjs';
import { tl, fmt, I18nError, translateError, contentLang, userLang, CATALOGS, LANGS, CONTENT_LANG_KEY } from '../src/i18n/index.mjs';
import { extractAll, extractFrom, placeholders, sourceFiles } from '../src/i18n/extract.mjs';
import { SETTINGS, setSetting } from '../src/core/settings.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

section('① tl / fmt / 回落');
{
  eq(fmt('{a} 和 {b}', { a: 1, b: 'x' }), '1 和 x', '占位符照填');
  eq(fmt('{a} 和 {b}', { a: 1 }), '1 和 {b}', '漏传的占位符原样留着（看得出漏了什么）');
  eq(tl('zh', '已转交给 {name}', { name: '阿青' }), '已转交给 阿青', '中文：原文');
  eq(tl('en', '这一条目录里肯定没有 {x}', { x: 1 }), '这一条目录里肯定没有 1', '英文查不到 → 回落中文');
  eq(tl('fr', '原文'), '原文', '不认识的语言 → 按中文');
  CATALOGS.en['测试用原文 {n} 条'] = '{n} test items';
  eq(tl('en', '测试用原文 {n} 条', { n: 3 }), '3 test items', '英文查得到 → 译文，占位符照填');
  const e = new I18nError('测试用原文 {n} 条', { n: 2 });
  eq(e.message, '测试用原文 2 条', 'I18nError 的 message 仍是中文（日志、老测试照旧）');
  eq(translateError(e, 'en'), '2 test items', 'I18nError 按模板翻');
  eq(translateError(e, 'zh'), '测试用原文 2 条', '中文不翻');
  CATALOGS.en['固定文字的报错'] = 'A fixed error';
  eq(translateError(new Error('固定文字的报错'), 'en'), 'A fixed error', '普通 Error 整句查目录');
  eq(translateError(new Error('没登记的报错'), 'en'), '没登记的报错', '查不到 → 原样');
  delete CATALOGS.en['测试用原文 {n} 条']; delete CATALOGS.en['固定文字的报错'];
}

section('② 覆盖率');
{
  const all = extractAll();
  const probs = all.filter((e) => e.problem);
  assert(!probs.length, '要翻的原文都是字面量、不含 ${}', probs.slice(0, 8).map((p) => `${p.file}:${p.line} ${p.problem}`).join('\n         '));
  const keys = new Set(all.filter((e) => e.key).map((e) => e.key));
  const missing = [...keys].filter((k) => !(k in CATALOGS.en));
  assert(!missing.length, `源码里的原文英文目录都有（共 ${keys.size} 条）`, `缺 ${missing.length} 条，例如：${missing.slice(0, 5).map((k) => JSON.stringify(k)).join('、')}（node src/i18n/extract.mjs --missing en 列全）`);
  const corpus = sourceFiles().map((p) => readFileSync(p, 'utf8')).join('\n');
  // 上下文键"ctx|原文"配动态键时抽不出来（Tc('dtype', t.label)）：源码里有这个上下文的 Tc 调用、原文本身也在，就算用上了
  const ctxUsed = (k) => { const i = k.indexOf('|'); return i > 0 && corpus.includes(`Tc('${k.slice(0, i)}'`) && (keys.has(k.slice(i + 1)) || corpus.includes(k.slice(i + 1))); };
  const stale = Object.keys(CATALOGS.en).filter((k) => !keys.has(k) && !corpus.includes(k) && !ctxUsed(k));
  assert(!stale.length, '目录里没有用不上的条目（源码里找不到这句原文）', stale.slice(0, 5).map((k) => JSON.stringify(k)).join('、'));
  const ph = Object.entries(CATALOGS.en).filter(([k, v]) => JSON.stringify(placeholders(k)) !== JSON.stringify(placeholders(v)));
  assert(!ph.length, '每条译文的占位符与原文一致', ph.slice(0, 5).map(([k, v]) => `${k} → ${v}`).join('\n         '));
  const { CATALOG_CONFLICTS } = await import('../src/i18n/index.mjs');
  assert(!CATALOG_CONFLICTS.length, '同一原文在各份目录里的译文一致', CATALOG_CONFLICTS.slice(0, 8).map((c) => `${JSON.stringify(c.key)}：${c.kept.join('=')} ≠ ${c.dropped.join('=')}`).join('\n         '));
  // 看板的译文常被放进 title="…" 属性：HTML 标签之外的英文直双引号会把属性截断（悬浮说明只剩半句）
  const uiFiles = (await import('node:fs')).readdirSync(new URL('../src/i18n/en/', import.meta.url)).filter((f) => /^ui/.test(f));
  const quoted = [];
  for (const f of uiFiles) for (const [k, v] of Object.entries((await import(`../src/i18n/en/${f}`)).default)) if (String(v).split(/<[^>]+>/).some((seg) => seg.includes('"'))) quoted.push(`${f}: ${k}`);
  eq(quoted, [], '看板译文里没有直双引号（用弯引号 “ ”）');
  const empty = Object.entries(CATALOGS.en).filter(([, v]) => !String(v).trim());
  assert(!empty.length, '没有空译文', empty.slice(0, 5).map(([k]) => k).join('、'));
  // 抽取器自己：三种写法、第一个参数带逗号、不是字面量的要报
  const ex = extractFrom("tl(userLang(db, x), '甲 {a}', { a }); new I18nError(`乙`); T('丙'); tl(lang, name); foo.tl('不算');", 'x.html');
  eq(ex.map((e) => e.key), ['甲 {a}', '乙', '丙', null], '抽取器认三种写法；第一个参数里有逗号也能跳过；非字面量是动态键（不抽）');
  eq(extractFrom("Tc('role', '成员')", 'x.html')[0].key, 'role|成员', 'Tc(上下文, 原文) → 键"上下文|原文"');
  eq(extractFrom('tl(l, `有 ${x}`)', 'a.mjs')[0].problem !== null, true, '模板字符串里有 ${} → 报');
}

section('③ 语言从哪来');
{
  const db = openDb(':memory:');
  const o = ensureOwner(db, 'lead');
  eq(SETTINGS[CONTENT_LANG_KEY]?.values, LANGS, '设置项 deploy.content_lang 的可选值与 i18n 支持的语言一致');
  eq([contentLang(db), userLang(db, o.userId)], ['zh', 'zh'], '默认：内容语言 zh，界面跟随');
  setSetting(db, { key: CONTENT_LANG_KEY, value: 'en', userId: o.userId });
  eq([contentLang(db), userLang(db, o.userId)], ['en', 'en'], '部署改成 en → 没选过的人界面也跟着 en');
  db.run(`UPDATE users SET lang='zh' WHERE id=?`, o.userId);
  eq(userLang(db, o.userId), 'zh', '自己选了 zh → 界面用自己的');
  let threw = false; try { setSetting(db, { key: CONTENT_LANG_KEY, value: 'fr', userId: o.userId }); } catch { threw = true; }
  assert(threw, '内容语言只能是 zh / en');
  threw = false; try { db.run(`UPDATE users SET lang='fr' WHERE id=?`, o.userId); } catch { threw = true; }
  assert(threw, '库层 CHECK：users.lang 只能是 zh / en / 空');
}

section('③′ 事项标记【…】：写按内容语言，读两种都认');
{
  const { MARKS, markOf, hasMark, indexOfMark, markLike } = await import('../src/i18n/marks.mjs');
  eq(markOf('zh', 'signoff'), '【签收】', '中文标记');
  eq(markOf('en', 'reached', { version: 2 }), '【Is the project done? v2】', '英文标记带版本号');
  eq(markOf('en', 'egressLegacy'), '【请求放行出口白名单】', '只有中文的旧标记 → 回落中文');
  assert(hasMark('【签收】任务…', 'signoff') && hasMark('【Sign-off】Task…', 'signoff'), 'hasMark 两种语言都认');
  assert(hasMark('【宪法块草案 v3】…', 'taskDraft') && hasMark('【Task contract draft v12】…', 'taskDraft'), '带版本号的按前缀认');
  assert(!hasMark('【签收打回】…', 'signoff'), '【签收打回】不会被认成【签收】');
  eq(indexOfMark('正文\n\n　　·　Not yours to answer? 转给…', 'transferHint'), 4, 'indexOfMark 找得到正文中间的英文"不该你答？"');
  const missingEn = Object.entries(MARKS).filter(([id, m]) => id !== 'egressLegacy' && !m.en).map(([id]) => id);
  eq(missingEn, [], '每个标记都有英文（旧写法除外）');
  const pre = (v) => { const i = v.indexOf('{'); return i < 0 ? v : v.slice(0, i); };
  const all = Object.entries(MARKS).flatMap(([id, m]) => Object.values(m).map((v) => ({ id, p: pre(v) })));
  const clash = all.flatMap((a) => all.filter((b) => a.id !== b.id && b.p.startsWith(a.p)).map((b) => `${a.id}「${a.p}」⊂ ${b.id}「${b.p}」`));
  eq(clash, [], '任意两个标记的前缀互不包含（否则会认错）');
  const db = openDb(':memory:');
  db.raw.exec(`CREATE TABLE t (text TEXT); INSERT INTO t VALUES ('【空转】a'), ('【Going in circles】b'), ('【停等】c'), ('100%_x')`);
  const L = markLike('text', 'loop');
  eq(db.all(`SELECT text FROM t WHERE ${L.sql} ORDER BY text`, ...L.params).map((r) => r.text[1]), ['G', '空'], 'markLike 两种语言都命中');
  eq(db.all(`SELECT count(*) n FROM t WHERE NOT ${L.sql}`, ...L.params)[0].n, 2, 'NOT markLike 排除两种语言');
}

section('③″ 人写的答复、模型写的内容：中英都认');
{
  const { readVerdict, reservationOf, REACHED_LABELS, REVIEW_LABELS } = await import('../src/agent/approval.mjs');
  const { choicesSide } = await import('../src/core/choices.mjs');
  const { STRUCTURAL_RULE } = await import('../src/core/routing.mjs');
  const { falseDoneClaims } = await import('../src/agent/reporter.mjs');
  const v = (b, l) => readVerdict(b, l);
  eq([v('yes'), v('Approve'), v('LGTM'), v('批准')], ['approve', 'approve', 'approve', 'approve'], '批准：yes / Approve / LGTM / 批准');
  eq(v('A. Looks good overall.'), 'approve', '「A. 说明」不带转折 → 批准');
  eq(v('A, but change the port to 8080'), 'feedback', '「A, but change…」→ 要改（不替人批）');
  eq(v('A. However the API should use /v2'), 'feedback', '「However … should use」→ 要改');
  eq([v('give up'), v('C: not needed, the old one works')], ['abandon', 'abandon'], '放弃：give up / 「C: 理由」');
  eq([v('A\nReservation: keep an eye on TTL'), reservationOf('A\nReservation: keep an eye on TTL')], ['approve', 'keep an eye on TTL'], '另起一行 Reservation: → 批准 + 保留意见');
  eq([v('Approve, caveat: slow on big lists'), reservationOf('Approve, caveat: slow on big lists')], ['approve', 'slow on big lists'], '同一行 caveat: → 批准 + 保留意见');
  eq([v("Confirm it's done", REACHED_LABELS), v('set it aside', REACHED_LABELS), v('Already done', REVIEW_LABELS)], ['approve', 'abandon', 'reached'], '照英文选项名回答也认（不分大小写）');
  eq([choicesSide('Note: fine for now'), choicesSide('sounds good'), choicesSide('说明：先这样')], ['keep', 'keep', 'keep'], '过目事项：Note: / sounds good / 说明： → 同意');
  assert(STRUCTURAL_RULE.test('This conflicts with the spec: section 2 says X') && STRUCTURAL_RULE.test('The contract rules conflict... the spec contradicts itself'), '结构类判定认英文表述');
  assert(STRUCTURAL_RULE.test('与规格原文矛盾') && !STRUCTURAL_RULE.test('Which color should the button be?'), '中文照认；普通问题不误判');
  const standing = [{ project_order: 2, title: 'T2 list page', status: 'running' }, { project_order: 3, title: 'T3 export', status: 'pending' }];
  eq(falseDoneClaims('T2 is done. T3 is next.', standing).map((t) => t.project_order), [2], '英文摘要："T2 is done" 说成完成 → 认出 T2');
  eq(falseDoneClaims('T2 is not done yet, T3 has not been finished', standing).length, 0, '否定说法不误报');
}

section('③‴ 模型写给人的文字用内容语言');
{
  const { withOutputLang } = await import('../src/i18n/index.mjs');
  eq(withOutputLang('系统提示', 'zh'), '系统提示', '中文部署：提示词原样');
  const en = withOutputLang('系统提示', 'en');
  assert(en.startsWith('系统提示') && /## Output language/.test(en) && /do not translate quotes/.test(en), '英文部署：末尾追加输出语言说明（引文不翻）');
  // 每个写给人看的模型调用都套了 withOutputLang（分类器只出枚举，不算）
  const { readFileSync: rf } = await import('node:fs');
  const files = ['agent/elicitor.mjs', 'agent/planner.mjs', 'agent/project-append.mjs', 'agent/project-planner.mjs', 'agent/replan.mjs', 'agent/reporter.mjs', 'agent/verifier.mjs', 'context/assemble.mjs', 'core/decision-check.mjs'];
  const raw = files.filter((f) => /\bsystem: (?!withOutputLang\()/.test(rf(new URL(`../src/${f}`, import.meta.url), 'utf8')));
  eq(raw, [], '这些文件里给模型的 system 都经过 withOutputLang');
}

section('④ 看板接口');
{
  const { startWeb } = await import('../src/web/server.mjs');
  const HOME = mkdtempSync(join(tmpdir(), 'si-i18n-'));
  const db = openDb(':memory:');
  const o = ensureOwner(db, 'lead');
  const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: o.plaintext, pollMs: 100 });
  const base = `http://127.0.0.1:${w.port}`;
  const req = (p, { method = 'GET', body, lang } = {}) => fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(lang ? { 'x-si-lang': lang } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  try {
    const i = await req('/api/i18n?lang=en');
    eq([i.lang, typeof i.catalog], ['en', 'object'], '/api/i18n?lang=en 给英文词表');
    eq((await req('/api/i18n?lang=zh')).catalog, {}, '中文不用词表');
    let me = await req('/api/me');
    eq([me.lang, me.ownLang, me.contentLang], ['zh', null, 'zh'], '/api/me 带界面语言、自己选的、部署的内容语言');
    const r = await req('/api/me/lang', { method: 'POST', body: { lang: 'en' } });
    eq([r.ok, r.lang], [true, 'en'], '改自己的界面语言');
    me = await req('/api/me');
    eq([me.lang, me.ownLang], ['en', 'en'], '改完 /api/me 跟着变');
    eq((await req('/api/me/lang', { method: 'POST', body: { lang: 'fr' } })).status, 400, '不认识的语言 → 400');
    await req('/api/me/lang', { method: 'POST', body: { lang: null } });
    eq((await req('/api/me')).ownLang, null, '传 null → 回到跟随部署');
    CATALOGS.en['不支持的操作：{action}'] = 'Unsupported action: {action}';
    const e1 = await req('/api/llm', { method: 'POST', body: { action: 'nope' }, lang: 'en' });
    const e2 = await req('/api/llm', { method: 'POST', body: { action: 'nope' } });
    assert(e1.status >= 400 && e2.status >= 400, '不支持的操作 → 报错');
    assert(e2.error === '不支持的操作：nope', `没带 X-SI-Lang → 中文：${e2.error}`);
    delete CATALOGS.en['不支持的操作：{action}'];
  } finally { w.close(); db.close(); try { rmSync(HOME, { recursive: true, force: true }); } catch { /* Windows 上库文件可能还锁着 */ } }
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(), 200);   // 与 web.test 同：等服务把连接收完再退，直接 exit 在 Windows 上会崩
