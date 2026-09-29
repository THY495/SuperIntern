// 行为规则的出处（项目规划器的契约 rules 与任务规划器的节点 rules 共用）。
/**
 * 契约 / 节点的行为规则要有出处（否则失败会集中在人批准过的契约规则句里 —— "跨多行注释不按 standalone"、
 * "非字符串值 String()" 这类规划器臆造、没有出处的规则，人批准时一眼看不出来，实现方又无从质疑）。
 * 每条规则二选一：`quote` 逐字引规划 / 规格原文（机械查：空白归一后必须是规划文本的子串），或 `assumption` 说明为什么规格没写、
 * 规划器怎么定的。批准问题里假设单列一节；落进宪法时带标记，实现方看得到出处，与原文矛盾时提问而不是自己改。
 */

/**
 * 出处之外的两条机械护栏。要堵的是这条链（例）：
 * 规划原文"page **不是正整数**" → 规划器改写成"page 非正整数"、挂的引文是另一句 →
 * 任务内验收员按契约字面较真（"非正整数 = 0 与负整数，1.5 / abc 两者都不是"）→ 执行器把 1.5 / abc
 * 挪进"未约定"，原文明写的"total 照常"又因为契约没带这半句而被当成"无出处推断"删掉。
 * 每一环都守规矩，合起来偏离了人写的规格，被只看汇报的签收人有据打回。
 *
 * 修法**不是**把规划原文附给执行方（两份"规格"打架，会让执行器拿原文做契约没要求的事），
 * 而是让**引文自己**把原文的关键字带到下游眼前：
 *   ① 一条规则只讲一件事 —— 规则文本里有多个分号分隔的独立断言就拒收，要求拆开、各带各的引文。
 *      拆开之后，"page 非正整数"那条必须去引"不是正整数：HTTP 400"，"超末页"那条必须去引含
 *      "total 照常"的整句。验收员提示词里"〔规格〕后是规格原文，是最高依据"那句到这时才真正生效。
 *   ② 规则与其引文要有足够字面重叠 —— 中文分词不可靠，用字符二元组；阈值宁松勿紧。
 *
 * 两处要说实话：
 *   - 上面那条挂错引文的规则重叠率是 **0.188**，阈值 0.20 只比它高一点点 —— ② **不是一个稳健的判别器**，
 *     它挡得住的是 0.0–0.07 那种彻底无关的引文（臆造一条规则、随手挂一句原文）。承重的是 ①。
 *     ② 也只有在拆条之后才有意义：不拆的话，一条规则里总有某个子句和引文重叠得很好。
 *   - 代价是草案变长（例如 10 条规则拆完约 15 条），而负责人本来就不逐条比对引文。
 *     **这两条保护的是下游的机器（验收员、执行器），不是批准的人**，别高估。
 */
export const RULE_QUOTE_MIN_SIM = 0.20;
const CLEAN = /[\s\p{P}\p{S}]+/gu;
const bigrams = (s) => {
  const t = String(s ?? '').replace(CLEAN, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
};
/** 规则与引文的字符二元组重叠率，按**较短**的一方归一：引文常比规则长，按并集算会把好引文判低。 */
export function quoteSim(rule, quote) {
  const A = bigrams(rule), B = bigrams(quote);
  if (!A.size || !B.size) return 1;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}

// 切分句之前先把成对符号里的内容掩掉：JSON 体、代码片段、括注里的分号不是"第二条断言"。
const BT = String.fromCharCode(96);                 // 反引号
const QUOTES = ['"', "'", BT, '“'];                 // 引号类：内部不再认新的开符号
const PAIRS = { '{': '}', '[': ']', '(': ')', '（': '）', '「': '」', '“': '”', '"': '"', "'": "'", [BT]: BT };
function maskSpans(text) {
  const out = [...String(text ?? '')];
  const stack = [];
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    const top = stack[stack.length - 1];
    if (top && c === top.close) { stack.pop(); continue; }
    if (PAIRS[c] && !(top && top.quote)) { stack.push({ close: PAIRS[c], quote: QUOTES.includes(c) }); continue; }
    if (stack.length) out[i] = '·';
  }
  return out.join('');
}
/**
 * 规则文本里的独立断言（按**没被掩掉**的分号切）。返回原文的分句。
 * 只认分号：句号切会把"若 X，则 Y。否则 Z"这种一件事的两句话也拆开，模型未必改得出来，白烧一轮。
 */
export function clausesOf(text) {
  const raw = String(text ?? '');
  const masked = maskSpans(raw);
  const parts = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '；' || masked[i] === ';') { parts.push(raw.slice(start, i)); start = i + 1; }
  }
  parts.push(raw.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.replace(CLEAN, '').length >= 4);   // "……"、"等" 这种尾巴不算一条
}

export const normalizeQuote = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// 子串核对时把空白全部去掉：中英混排里模型会在中文与英文之间多打 / 少打一个空格，那不算改写。
const stripWs = (s) => String(s ?? '').replace(/\s+/g, '');
const occurrences = (hay, needle) => { let n = 0; for (let i = hay.indexOf(needle); needle && i >= 0; i = hay.indexOf(needle, i + 1)) n++; return n; };
export function validateRules(rules, { brief = null, at = 'rules' } = {}) {
  const errs = [];
  if (!Array.isArray(rules)) return [`${at} 要是数组`];
  const nb = brief ? stripWs(brief) : null;
  rules.forEach((r, i) => {
    const p = `${at}[${i}]`;
    if (!r || typeof r !== 'object') { errs.push(`${p} 要是对象 {rule, quote | assumption}`); return; }
    if (!String(r.rule ?? '').trim()) errs.push(`${p} 缺 rule`);
    const q = String(r.quote ?? '').trim(), a = String(r.assumption ?? '').trim();
    if (!q && !a) errs.push(`${p}「${String(r.rule ?? '').slice(0, 40)}」没有出处：要么 quote 逐字引规划 / 规格原文，要么 assumption 说明规格没写、你怎么定的`);
    else if (q && a) errs.push(`${p} quote 与 assumption 只能给一个`);
    // 太短的引文定位不到出处。但拆条（下面 ①）会把「测试须覆盖：①正常转换；②…」拆出只有几个字的原文 ——
    // 在规划原文里**恰好出现一次**的短引文照样能定位，放行；没给原文、找不到、或出现不止一次的照旧拒。
    else if (q && q.length < 8 && !(nb && occurrences(nb, stripWs(q)) === 1)) errs.push(`${p} quote 太短（${q.length} 字），要引到能定位的一句（短引文只在它在原文里恰好出现一次时才收）`);
    else if (q && nb && !nb.includes(stripWs(q))) errs.push(`${p} quote「${q.slice(0, 60)}」在规划文本里找不到：要**逐字**引，不要改写；规格确实没写就改成 assumption`);

    // ① 一条规则只讲一件事（拆条对 quote 与 assumption 两种出处一视同仁）
    const cls = clausesOf(r.rule);
    if (cls.length > 1) {
      errs.push(`${p}「${String(r.rule ?? '').slice(0, 40)}…」一条规则讲了 ${cls.length} 件事`
        + `（${cls.map((c) => `「${c.slice(0, 16)}」`).join('、')}）：请拆成 ${cls.length} 条，每条各带各的出处 —— `
        + `一句引文支撑不了几件事，下游（验收员、执行器）只按规则的字面较真，被省掉的那半句原文就永远到不了它们眼前`);
    } else if (q && cls.length === 1) {
      // ② 规则与引文的字面重叠。两边都太短就不判：二元组太少，噪声大过信号。
      const sim = quoteSim(r.rule, q);
      if (bigrams(r.rule).size >= 6 && bigrams(q).size >= 6 && sim < RULE_QUOTE_MIN_SIM) {
        errs.push(`${p}「${String(r.rule ?? '').slice(0, 40)}」与它的 quote「${q.slice(0, 40)}」几乎没有共同字眼`
          + `（字符二元组重叠 ${sim.toFixed(2)} < ${RULE_QUOTE_MIN_SIM}）：要么换成真正支撑这条规则的那句原文，`
          + `要么把规则改写成贴近原文的说法；规格确实没写就改成 assumption`);
      }
    }
  });
  return errs;
}
export function renderRules(rules) {
  return (rules ?? []).map((r) => (String(r.quote ?? '').trim()
    ? `〔规格〕${r.rule} ← “${normalizeQuote(r.quote)}”`
    : `〔规划器假设〕${r.rule}（${normalizeQuote(r.assumption)}）`));
}
export const RULES_HEADER = '行为规则（每条带出处：〔规格〕后是规格原文，是最高依据，实现与它矛盾时提问；〔规划器假设〕是规格没写、规划器定的，人批准时已看到，按字面执行）：';

/** 把规则连同出处折进一段自由文本（完成定义 / 节点规格）末尾；没有规则原样返回。 */
export function foldRules(text, rules, header = RULES_HEADER) {
  return Array.isArray(rules) && rules.length ? `${text}\n\n${header}\n${renderRules(rules).map((l) => `- ${l}`).join('\n')}` : text;
}
