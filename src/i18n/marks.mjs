// 事项正文开头的【…】标记，中英两份登记在这里（0.2.0）。
//
// 这些标记不只是给人看的：好几处代码按它认事项（开头是【AI 替你定了几件事】就按过目事项读答复、
// SQL 里 LIKE '【空转】%' 去重……）。所以：
//   - 写：markOf(contentLang(db), id, 参数) —— 按部署的内容语言写；
//   - 读：hasMark(text, id) / markLike(id) —— 两种语言都认。库里的老数据是中文，部署中途换了内容语言也不会读错。
// 英文也用【】括起来：剥标记的正则（/^【[^】]*】/）、界面按【】取标签都不用分语言。

import { fmt, DEFAULT_LANG, normLang } from './index.mjs';

export const MARKS = {
  signoff:            { zh: '【签收】', en: '【Sign-off】' },
  signoffRejected:    { zh: '【签收打回】', en: '【Sign-off rejected】' },
  conflict:           { zh: '【冲突】', en: '【Disagreement】' },
  structural:         { zh: '【结构矛盾】', en: '【Structural conflict】' },
  integrationConflict:{ zh: '【集成冲突】', en: '【Integration conflict】' },
  taskDraft:          { zh: '【宪法块草案 v{version}】', en: '【Task contract draft v{version}】' },
  projectDraft:       { zh: '【项目契约草案 v{version}】', en: '【Project plan draft v{version}】' },
  appendDraft:        { zh: '【项目契约草案 · 追加 v{version}】', en: '【Project plan draft · additions v{version}】' },
  reached:            { zh: '【项目达成确认 v{version}】', en: '【Is the project done? v{version}】' },
  specDiff:           { zh: '【和上一版（v{version}）比】', en: '【Compared with the previous version (v{version})】' },
  autoGateBack:       { zh: '【本该自动开工，但退回给你批】', en: '【Sent back for your approval instead of starting automatically】' },
  confirm:            { zh: '【先确认一下】', en: '【Please confirm first】' },
  choices:            { zh: '【AI 替你定了几件事】', en: '【Things the AI decided for you】' },
  decisionConflict:   { zh: '【决定冲突】', en: '【Conflicts with an earlier decision】' },
  revisionApproval:   { zh: '【修正需要你批准】', en: '【A correction needs your approval】' },
  egress:             { zh: '【请求联网】', en: '【Network access request】' },
  egressLegacy:       { zh: '【请求放行出口白名单】' },   // 旧库里的写法，只读不写
  limit:              { zh: '【硬上限触顶】', en: '【Hard limit reached】' },
  projectBudget:      { zh: '【项目预算闸】', en: '【Project budget gate】' },
  verifyFailed:       { zh: '【验收没过】', en: '【Acceptance check failed】' },
  projectVerifyFailed:{ zh: '【项目验收没过】', en: '【Project acceptance check failed】' },
  mergeBlocked:       { zh: '【合并卡住】', en: '【Merge blocked】' },
  advanceFailed:      { zh: '【合并出错】', en: '【Merge error】' },
  replanFailed:       { zh: '【改计划没成】', en: '【Replanning failed】' },
  stall:              { zh: '【停等】', en: '【Stalled】' },
  loop:               { zh: '【空转】', en: '【Going in circles】' },
  review:             { zh: '【复盘】', en: '【Project review】' },
  // 不在开头：routeQuestion 追加在事项正文末尾的"不该你答？"那一行，机器读正文前要剥掉
  transferHint:       { zh: '　　·　不该你答？', en: '　　·　Not yours to answer?' },
};

const variants = (id) => {
  const m = MARKS[id];
  if (!m) throw new Error(`未登记的标记：${id}`);
  return Object.values(m);
};
/** 模板里 { 之前的那一段：带版本号的标记（草案 v3）按前缀认。 */
const prefixOf = (tpl) => { const i = tpl.indexOf('{'); return i < 0 ? tpl : tpl.slice(0, i); };

/** 按某种语言写出标记（没有这种语言的译法就用中文）。 */
export function markOf(lang, id, params) {
  const m = MARKS[id];
  if (!m) throw new Error(`未登记的标记：${id}`);
  return fmt(m[normLang(lang) ?? DEFAULT_LANG] ?? m[DEFAULT_LANG], params);
}

/** 正文以这个标记开头（任一语言）。 */
export const hasMark = (text, id) => { const s = String(text ?? ''); return variants(id).some((v) => s.startsWith(prefixOf(v))); };

/** 正文里含有这个标记（任一语言），返回最早出现的位置；没有返回 -1。 */
export function indexOfMark(text, id) {
  const s = String(text ?? '');
  const hits = variants(id).map((v) => s.indexOf(prefixOf(v))).filter((i) => i >= 0);
  return hits.length ? Math.min(...hits) : -1;
}

/** SQL 用：`(col LIKE ? OR col LIKE ?)` 与对应参数（任一语言的前缀）。 */
export function markLike(col, id) {
  const pats = variants(id).map((v) => `${prefixOf(v).replace(/[%_]/g, '')}%`);
  return { sql: `(${pats.map(() => `${col} LIKE ?`).join(' OR ')})`, params: pats };
}
