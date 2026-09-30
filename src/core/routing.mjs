// 角色与路由 —— 权限挂在**决策**上，不挂在人身上。
//
// 代码里没有"负责人 / 介入者"的等级判断，只有一张表：每行六个字段（决策类型、触及范围、收件人、
// 法定人数、同级冲突策略、超时兜底）。模板（routing-templates.json）只是这张表的预填法；
// 两个旋钮（介入者名单、决策类型归属）是表的投影。校验只对表做，模板填出来的与手改的走同一条。
//
// 三条边界：
//   - **解析在事项创建那一刻**：结果落 questions.addressed_to / informed / route；之后改表只影响新事项。
//   - **不变量不进表**：每项目恰一个负责人；结构矛盾 / 方案批准 / 冲突三类的行解析后必含负责人（DECISION_TYPES.level3，按类型不按级别）；负责人覆盖介入者；
//     转交是事项级动作；宪法层只有负责人能动。这些写死在校验或代码里。
//   - **没配过表的部署照旧能跑**：没有任何行时按 solo 模板即时解析（不落库），单用户部署零配置。
//
// "项目"在这里是路由的键：projects 表里的项目用自己的 id；不属于任何项目的任务共用键 ''（默认表）。
// 负责人 = 项目的 owner_id / 独立任务的 owner_id：纯资源级身份，与部署级角色（users.role：lead = 管理员）无关（两者解耦）。
// 只要求是未停用的非旁观者。默认表 '' 下各任务各有各的负责人，表本身没有"负责人"，校验时用占位。

import { N_, tl, contentLang, I18nError, CATALOGS, translateError } from '../i18n/index.mjs';
import { indexOfMark, markOf } from '../i18n/marks.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newId, now, audit } from '../db/db.mjs';
import { getParam } from './params.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 八种决策类型。
 *   `level3`：该类型的行解析后必须含负责人（不变量 2），链末行只能 hang、任何位置禁 default —— 触及项目定义，没人替人决定。
 *   `noDefault`：该类型的行禁配 default（next 仍可：换人不是替人决定）。预算 / 出网 / 签收的事项没有 default_action，
 *     此前"到期按默认走"之所以安全只是因为 applyDefault 碰到空默认会挂起 —— 那是巧合不是规则，这里把它写成规则。
 */
export const DECISION_TYPES = {
  // label 给界面；desc 给人看（只说是什么事，不说系统怎么产生）；from 给开发者。
  spec_choice:       { label: N_('规格取舍'),   level3: false, noDefault: false, desc: N_('执行中发现规格未写明，需要人工选定一种做法'), from: '执行器 / 规划器 / 追问器的提问，判为规格类' },
  structural:        { label: N_('结构矛盾'),   level3: true,  noDefault: true,  desc: N_('规格、方案或依赖之间存在矛盾，需要人工修改后才能继续'), from: '提问判为结构类：模型自报 kind=structural，或正文命中硬规则（与规格原文矛盾、依赖不成立、契约规则冲突）' },
  contract_approval: { label: N_('方案批准'),   level3: true,  noDefault: true,  desc: N_('批准任务方案、项目方案或计划变更'), from: '追问器草案 / 项目规划器整批契约 / 修正提案的确认门' },
  signoff:           { label: N_('签收'),       level3: false, noDefault: true,  desc: N_('任务完成后验收：接受或打回'), from: '任务 done 后的签收' },
  budget:            { label: N_('上限追加'),   level3: false, noDefault: true,  desc: N_('花费或次数达到上限，决定是否追加'), from: '硬上限触顶（on_hit=gate）' },
  egress:            { label: N_('联网放行'),   level3: false, noDefault: true,  desc: N_('沙箱请求访问某类软件源，决定是否放行'), from: '沙箱请求放行某个生态' },
  delivery:          { label: N_('交付'),       level3: false, noDefault: false, desc: N_('将产物推送到远端仓库并创建 PR'), from: 'push / 开 PR（授权，不生成事项）' },
  conflict:          { label: N_('意见不一致'), level3: true,  noDefault: true,  desc: N_('多人答复不一致时，由谁裁定'), from: '冲突检测：同一问题的答复不一致' },
  // 原来这些都走"结构矛盾"（必须含负责人）—— 每条停等报警都要发两个人。分出来，负责人可以只派给管代码的那一位。
  ops:               { label: N_('系统卡住'),   level3: false, noDefault: true,  desc: N_('系统卡住了（合并出错、工作区里有来路不明的改动、改计划没成、长时间没动静），要有人看一眼、决定怎么办'), from: '交回给人的几种卡住（handback）/ 停等报警（liveness）' },
};
/** 已存的路由表里缺某一类时借哪一类的行（加"系统卡住"这一类之前存的表都没有它）：谁管结构矛盾，谁就先管运维。 */
const TYPE_FALLBACK = { ops: 'structural' };
/** 决策类型在某种语言下的名字（label 由 N_ 登记，目录里有译文）；不认识的类型原样返回。 */
const typeLabel = (lang, t) => { const l = DECISION_TYPES[t]?.label; return l ? (lang && lang !== 'zh' ? CATALOGS[lang]?.[l] ?? l : l) : t; };

/**
 * 类型只升不降的兜底（"自报 + 单向升级"）：模型自报 structural 一律采信；没报或报了 spec 但正文命中
 * 结构矛盾的硬规则表述，也按 structural 走（type_source=hard_rule）。不做降级，不调分类器。
 * 正则覆盖面有意收窄：这里只认三类明确表述，宁可漏判（漏判 = 按规格取舍路由，仍会问人）。
 */
// 英文正文（内容语言 en 时模型用英文提问）同一套三类表述。
export const STRUCTURAL_RULE = /规格原文.{0,8}(矛盾|冲突)|与.{0,16}(规格|〔规格〕).{0,8}(矛盾|冲突)|依赖不成立|契约规则.{0,12}(矛盾|冲突)|(规格|契约|方案).{0,6}自相矛盾|\b(contradicts?|conflicts? with|inconsistent with)\b.{0,16}\b(spec|specification|contract)\b|\b(spec|specification|contract|plan)\b.{0,12}\b(contradicts itself|self-contradictory)\b|\bdependency\b.{0,12}\b(does not|doesn't) hold\b/i;
export function decisionTypeOfQuestion({ kind = null, text = '' } = {}) {
  if (kind === 'structural') return { decisionType: 'structural', typeSource: 'self' };
  if (STRUCTURAL_RULE.test(String(text ?? ''))) return { decisionType: 'structural', typeSource: 'hard_rule' };
  return { decisionType: 'spec_choice', typeSource: kind ? 'self' : 'default' };
}
export const QUORUM_ALL = 'all';
export const CONFLICT_POLICIES = ['block', 'latest'];
export const TIMEOUT_ACTIONS = ['hang', 'next', 'default'];
export const DEFAULT_TEMPLATE = 'solo';

let templatesCache = null;
export function loadTemplates() {
  if (!templatesCache) templatesCache = JSON.parse(readFileSync(join(__dirname, 'routing-templates.json'), 'utf8')).templates;
  return templatesCache;
}

// ── 时长 ─────────────────────────────────────────────────────────────────
/** '30m' / '8h' / '1d' / '1bd'（工作日：跳过周六日；不做节假日）→ 到期时刻。 */
export function dueAfter(at, after) {
  const m = /^(\d+)(m|h|d|bd)$/.exec(String(after ?? '').trim());
  if (!m) throw new I18nError('超时无效：{after}（应为 30m / 8h / 1d / 1bd 格式）', { after: `${after}` });
  const n = Number(m[1]);
  if (m[2] === 'm') return at + n * 60_000;
  if (m[2] === 'h') return at + n * 3600_000;
  if (m[2] === 'd') return at + n * 86400_000;
  return addBusinessDays(at, n);
}
export function addBusinessDays(at, n) {
  const d = new Date(at);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d.getTime();
}
export const isValidAfter = (s) => /^(\d+)(m|h|d|bd)$/.test(String(s ?? ''));

// ── 键与负责人 ────────────────────────────────────────────────────────────
/** 任务的路由键：所属项目 id，或 ''（独立任务共用默认表）。 */
export function routingKeyOf(db, taskId) {
  return db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? '';
}
/** 负责人：项目 owner / 任务 owner。不检查 role —— 检查在校验里，这里只回答"是谁"。 */
export function leadOf(db, taskId) {
  const t = db.one(`SELECT owner_id, project_id FROM tasks WHERE id=?`, taskId);
  if (!t) return null;
  if (t.project_id) return db.one(`SELECT owner_id FROM projects WHERE id=?`, t.project_id)?.owner_id ?? t.owner_id;
  return t.owner_id;
}
/** 路由键的负责人：项目 owner；默认表 '' 没有（各任务各有各的 owner）→ null。 */
export function leadOfKey(db, key) {
  if (key) return db.one(`SELECT owner_id FROM projects WHERE id=?`, key)?.owner_id ?? null;
  return null;
}
/** 最早的未停用管理员：部署级通知（模型目录漂移等）找他。与"负责人"无关。 */
export function firstAdmin(db) {
  return db.one(`SELECT id FROM users WHERE role='lead' AND disabled_at IS NULL ORDER BY created_at LIMIT 1`)?.id ?? null;
}
/** 默认表校验时 `user:lead` 的占位（不是真实用户 id）。 */
export const LEAD_PLACEHOLDER = '$lead';

// ── 触及范围 ──────────────────────────────────────────────────────────────
/**
 * 任务触及的目录前缀：从宪法块的 scope 文本里抽路径样的词（含 `/` 或带扩展名），文件取其目录。
 * 与 scope 机械执法共用这份抽取。抽不到 = 只匹配 `*` 行。
 */
// 例：范围写的是"只新建 shared/…与根 package.json；不动 README；不建 server/、client/、e2e/" ——
// 朴素抽取会把否定句里的三个目录也当成触及范围（问题错发给后端与前端、各要一份法定人数），又漏掉没有斜杠的根文件
//（交接校验把 package.json 判成越界，任务卡死）。所以：按分句看，否定的部分不算；根目录文件单列（filesOfScope）。
// 否定词也不一定在句首，例如范围末句写的是
// "除此之外仍不动 shared/、docs/、client/、e2e/、README" —— 只看句首的话 client/ 与 e2e/
// 又被当成触及范围，签收从"发给后端一个人"变成"后端 + 前端 + 产品 + 测试四个人各要一份法定人数"。
// 所以判定是"**分句里从否定词起的后半段不算**"：
// 分句先按成对括号切成若干段（括注里的否定只影响括注内部，如"…加 'start'（不删改已有 scripts.test）"），
// 每段各自在第一个否定词处截断。仍然是启发式，但比只看句首贴近人写范围的方式。
const NEG = /(?:不|别|勿|禁止|严禁|无需|不要|不得|不许|不可|不能|除了|除此之外|除外|do\s+not|don't|never|no\b|not\b|without)/i;
const segmentsOf = (clause) => String(clause).split(/[（()）【】\[\]]/);           // 括注内外各算一段
const cutAtNegation = (seg) => { const m = seg.match(NEG); return m ? seg.slice(0, m.index) : seg; };
const positiveClauses = (scopeText) => String(scopeText ?? '').split(/[；;。\n]+/)
  .map((c) => segmentsOf(c).map(cutAtNegation).join(' '))
  .map((c) => c.trim()).filter(Boolean).join('\n');
/** 范围里点名的根目录文件（没有斜杠、带常见扩展名的词，如 package.json）。只用于越界校验：这些文件允许动。 */
export function filesOfScope(scopeText) {
  const out = new Set();
  for (const m of positiveClauses(scopeText).matchAll(/(?<![\w./-])([\w-][\w.-]*\.(?:json|md|mjs|cjs|js|ts|tsx|jsx|toml|yaml|yml|txt|lock|css|html|sh|py|go|rs))(?![\w/-])/gi)) out.add(m[1]);
  return [...out];
}
export function prefixesOfScope(scopeText) {
  const out = new Set();
  for (const m of positiveClauses(scopeText).matchAll(/(?<![\w-])((?:\.\/)?[\w.-]+(?:\/[\w.-]*)+)(?![\w-])/g)) {
    let p = m[1].replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p.includes('/') && !m[1].endsWith('/')) continue;                // 没有斜杠的词只有写成 docs/ 才算目录
    if (p.split('/').every((seg) => /^\d+$/.test(seg))) continue;          // 1/2 这种是比例不是路径
    if (/\.[a-z]{1,6}$/i.test(p.split('/').at(-1))) p = p.split('/').slice(0, -1).join('/');   // 文件 → 目录
    if (p) out.add(p);
  }
  return [...out];
}
/**
 * 结构化范围的护栏。**纯形状检查，不查仓库里有没有这个路径** ——
 * 任务常常要新建文件，查存在性会把"新建 `src/store/index.mjs`"判成错的。
 *
 * 允许：仓库相对路径。`src/a/` 结尾带斜杠 = 目录前缀（含其下全部），不带 = 具体文件。
 * 不允许：绝对路径、`..`、通配符、空串。`*` 这一个整体值是允许的 —— 路由表里它本来就表示"全仓库"。
 */
export function scopePathProblems(paths) {
  if (paths === undefined || paths === null) return [];
  if (!Array.isArray(paths)) return ['要是字符串数组；没有可写的路径就给 []'];
  const out = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) { out.push(`有一项不是非空字符串（${JSON.stringify(raw)}）`); continue; }
    const p = raw.trim();
    if (p === '*') continue;
    if (p.startsWith('/') || /^[a-z]:[\\/]/i.test(p)) out.push(`「${p}」是绝对路径，要写成相对仓库根目录的路径`);
    else if (p.split('/').includes('..')) out.push(`「${p}」含 ..，范围不许指到仓库外面`);
    else if (/[*?[\]]/.test(p)) out.push(`「${p}」含通配符；目录写成 src/a/（结尾一条斜杠 = 含其下全部），具体文件写全名`);
    else if (p.includes('\\')) out.push(`「${p}」用了反斜杠，一律写 /`);
  }
  return out;
}

/** 契约里归一化之后的结构化范围（去空白、去重复的斜杠、丢掉重复项）。 */
export const normScopePaths = (paths) => [...new Set((Array.isArray(paths) ? paths : [])
  .filter((p) => typeof p === 'string' && p.trim())
  .map((p) => p.trim().replace(/^\.\//, '').replace(/\/{2,}/g, '/')))];

/**
 * 批准页上「可动路径（判据）」底下那一句。**说清它不证明什么**。
 *
 * 读者看懂了判据是文件粒度，就会自己推出
 * 「范围写"只在 scripts 里加 start、不改已有脚本"，而判据只写 package.json —— 那句关键限制
 * 机器根本拦不住」。这是对的，而"机器按这一份撤销越界改动"这类措辞反倒在暗示它拦得住。
 * 粒度差这一层没打算做（做了就是又一个跑在散文上的启发式），那就必须明说。
 */
/** 按内容语言写（0.2.0）：拼进草案正文的地方传 contentLang(db)。SCOPE_PATHS_NOTE 是中文那份，别处还在引用。 */
export const scopePathsNote = (lang = 'zh') => tl(lang, '「可动路径」是机器唯一认的判据，它只判**能不能动这个文件**：没列上的文件被改了会原样撤销。上面那段「范围」里更细的要求（"只加一条 script、不改已有的"这种）**机器管不了**，只能靠实现方读、靠你签收时看。');
export const SCOPE_PATHS_NOTE = scopePathsNote('zh');

/**
 * 批准页上那一行。**必须露出来** —— 人批准的是机器按这一份判越界，
 * 而不是上面那段散文；判据不给人看，等于让人批一个他没见过的东西。
 */
export function renderScopePaths(paths, lang = 'zh') {
  const list = normScopePaths(paths);
  if (!list.length) return tl(lang, '（这份契约没给路径，判据回落到从上面那段话里抽 —— 精度差，容易漏也容易多）');
  if (list.includes('*')) return tl(lang, '整个仓库（* —— 等于不设范围，越界校验不生效）');
  return list.join(lang === 'en' ? ', ' : '、');
}

/**
 * 契约里的**结构化范围**（迁移 v17）：`['src/a/', 'package.json']`。
 * 带斜杠结尾 = 目录前缀，不带 = 具体文件。为空 = 这份契约是老的 / 规划器没给，判据回落到散文抽取。
 *
 * ⚠️ 这一层存在的全部理由：`prefixesOfScope` 是一个**跑在自由文本上的正则抽取器**，
 * 而它同时是三件事的判据（执行器越界校验、路由"触及范围"、批准页重叠预警）。
 * 它出过两次事（放过了不该放的越界、按范围找错了人）。结构化之后这三件事**同时**变精确。
 */
export function scopePathsOf(db, taskId) {
  const c = db.one(`SELECT scope_paths FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);
  try { const v = JSON.parse(c?.scope_paths || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
/** 结构化范围里点名的**具体文件**（不以 / 结尾的那些）。 */
export const filesOfPaths = (paths) => paths.filter((p) => p !== '*' && !p.endsWith('/'));
/** 结构化范围里的**目录前缀**（去掉结尾的 /，与 prefixesOfScope 的输出形状一致）。 */
export const prefixesOfPaths = (paths) => paths.filter((p) => p === '*' || p.endsWith('/')).map((p) => (p === '*' ? p : p.replace(/\/+$/, '')));

/**
 * **只给路由用**的"碰到了哪些目录"：目录前缀之外，具体文件也按所在目录算（frontend/src/App.jsx → frontend/src）。
 * 否则可动路径全是具体文件的任务 → 算不出 frontend → 方案批准、过目、签收全落到负责人，
 * 提需求的人签不到自己的需求。越界校验（执行器）仍用 prefixesOf —— 那边放宽到整个目录就是扩大了可改范围。
 */
export const routePrefixesOfPaths = (paths) => [...new Set([...prefixesOfPaths(paths),
  ...paths.filter((p) => p !== '*' && !p.endsWith('/') && p.includes('/')).map((p) => p.slice(0, p.lastIndexOf('/')))])];
export function routePrefixesOf(db, taskId) {
  const structured = scopePathsOf(db, taskId);
  if (structured.length) return routePrefixesOfPaths(structured);
  return prefixesOf(db, taskId);
}

export function scopeFilesOf(db, taskId) {
  const structured = scopePathsOf(db, taskId);
  if (structured.length) return filesOfPaths(structured);
  const c = db.one(`SELECT scope FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);
  return filesOfScope(c?.scope);
}
export function prefixesOf(db, taskId) {
  const structured = scopePathsOf(db, taskId);
  if (structured.length) return prefixesOfPaths(structured);
  const c = db.one(`SELECT scope FROM constitutions WHERE task_id=? AND superseded_at IS NULL ORDER BY version DESC LIMIT 1`, taskId);
  return prefixesOfScope(c?.scope);
}
// 两边都去掉结尾斜杠再比：路由表里写 frontend/ 与 frontend 是一回事，前缀由 prefixesOfPaths 给出时不带斜杠
const scopeMatches = (scope, prefix) => { const s = normScope(scope).replace(/\/+$/, ''), p = String(prefix).replace(/\/+$/, ''); return s === '*' || p === s || p.startsWith(`${s}/`); };
/**
 * 路由表里的范围统一成"目录前缀"写法：`frontend/**`、`frontend/*`、`./frontend` → `frontend/`；`**`、空 → `*`。
 * 负责人常照 glob 习惯写 `frontend/**`；保存时不拒收也不换算的话，这一行永远匹配不上，界面上的取舍全落回负责人。
 */
export function normScope(scope) {
  let s = String(scope ?? '').trim().replace(/^\.\//, '').replace(/^\/+/, '');
  if (!s || /^\*+$/.test(s) || s === '/**') return '*';
  s = s.replace(/\/?\*+$/, '');
  return s.endsWith('/') ? s : `${s}/`;
}
/** 一份方案里各任务动到的目录前缀（方案批准按段会签 —— frontend/ 那一段送管界面的人）。 */
export const specPrefixes = (tasks) => [...new Set(routePrefixesOfPaths((tasks ?? []).flatMap((t) => normScopePaths(t.scope_paths))).filter((p) => p !== '*'))];
/**
 * 项目级的确认（达成确认）覆盖整个项目 = 碰到了路由表里为这类决定写过的每一个目录。
 * 否则达成确认不带目录 → 只命中 `*` 行（负责人），按 frontend/、backend/ 分出去的人都收不到 ——
 * 提需求的人在第一版之后再没有待办，"还差什么"没有地方说。
 */
export function wholeProjectPrefixes(db, taskId, decisionType) {
  const rows = rulesOf(db, routingKeyOf(db, taskId)).filter((r) => r.decision_type === decisionType && normScope(r.scope) !== '*');
  return [...new Set(rows.map((r) => normScope(r.scope).replace(/\/+$/, '')))];
}

// ── 表的读写 ──────────────────────────────────────────────────────────────
const rowOut = (r) => ({ ...r, recipients: JSON.parse(r.recipients || '[]') });
/** 项目当前生效的行；没配过就是 solo 模板的即时实例（rule id 为 `tpl:solo:<n>`，不落库）。 */
export function rulesOf(db, key) {
  const rows = db.all(`SELECT * FROM routing_rules WHERE project_id=? ORDER BY decision_type, scope, position`, key).map(rowOut);
  if (rows.length) {
    // 新加的类型在旧表里没有行：按 TYPE_FALLBACK 借来（不落库；下次保存时随整张表一起存下）
    for (const [t, from] of Object.entries(TYPE_FALLBACK)) {
      if (rows.some((r) => r.decision_type === t)) continue;
      rows.push(...rows.filter((r) => r.decision_type === from).map((r) => ({ ...r, id: `derived:${t}:${r.id}`, decision_type: t })));
    }
    return rows;
  }
  return loadTemplates()[DEFAULT_TEMPLATE].rows.map((r, i) => ({ id: `tpl:${DEFAULT_TEMPLATE}:${i}`, project_id: key, template: DEFAULT_TEMPLATE, ...r }));
}
export function profileOf(db, key) {
  return db.one(`SELECT * FROM routing_profiles WHERE project_id=?`, key) ?? { project_id: key, template: DEFAULT_TEMPLATE, bindings: '{}', persisted: 0 };
}

/**
 * 校验（存不进去就不存，错在哪一行说清）。返回 [] 表示通过。
 * 规则：每种类型至少一行 `*`；Ⅲ 级类型每行解析后必含负责人；法定人数 ≤ 解析后的人数；
 * 空收件人只配 hang / default；`next` 必须有下一行且有时限；on_duty 出现时日历非空；`parties` 只在冲突类型；
 * 占位符必须已绑定；范围前缀必须是仓库里存在的目录（给了 repoDirs 才查）。
 */
export function validateRules(db, key, rules, { repoDirs = null, lang = 'zh' } = {}) {
  // lang：报错写给谁看（看板传请求人的界面语言）；默认中文，与原来逐字相同
  const errs = [];
  // 项目表：负责人必须是未停用的非旁观者（与角色是不是管理员无关）。默认表没有单一负责人：`user:lead` 用占位参与校验，
  // 实际解析按任务的 owner（routeQuestion 传 lead）。
  let lead = LEAD_PLACEHOLDER;
  if (key) {
    lead = leadOfKey(db, key);
    const leadRow = lead ? db.one(`SELECT display_name, role, disabled_at FROM users WHERE id=?`, lead) : null;
    if (!leadRow) errs.push({ row: null, msg: tl(lang, '负责人无效：{who}', { who: lead ?? tl(lang, '未设置') }) });
    else if (leadRow.disabled_at || leadRow.role === 'observer') errs.push({ row: null, msg: leadRow.disabled_at ? tl(lang, '负责人无效：{name} 已停用', { name: leadRow.display_name }) : tl(lang, '负责人无效：{name} 是旁观者', { name: leadRow.display_name }) });
  }
  const byType = {};
  rules.forEach((r, i) => {
    const at = (msg) => errs.push({ row: i, msg: tl(lang, '第 {n} 行（{label} / {scope}）：{msg}', { n: i + 1, label: `${typeLabel(lang, r.decision_type)}`, scope: `${r.scope}`, msg }) });
    if (!DECISION_TYPES[r.decision_type]) return at(tl(lang, '决策类型无效：{type}', { type: `${r.decision_type}` }));
    if (typeof r.scope !== 'string' || !r.scope) return at(tl(lang, '范围必须是 * 或目录前缀'));
    if (r.scope !== '*' && (r.scope.startsWith('/') || r.scope.includes('..'))) at(tl(lang, '范围必须是仓库内的相对路径'));
    if (repoDirs && r.scope !== '*' && !repoDirs.includes(r.scope.replace(/\/+$/, ''))) at(tl(lang, '目录 {dir} 在仓库中不存在', { dir: r.scope }));
    if (!Array.isArray(r.recipients)) return at(tl(lang, '接收人必须是列表'));
    if (!(r.quorum === QUORUM_ALL || /^[1-9]\d*$/.test(String(r.quorum)))) at(tl(lang, '法定人数无效：{quorum}（应为正整数或 all）', { quorum: `${r.quorum}` }));
    if (!CONFLICT_POLICIES.includes(r.conflict_policy)) at(tl(lang, '「冲突时」无效：{policy}（应为 block 或 latest）', { policy: `${r.conflict_policy}` }));
    if (!TIMEOUT_ACTIONS.includes(r.timeout_action)) at(tl(lang, '超时动作无效：{action}（应为 hang / next / default）', { action: `${r.timeout_action}` }));
    if (r.timeout_action === 'hang' && r.timeout_after) at(tl(lang, '超时动作为「持续等待」（hang）时不能填写超时'));
    if (r.timeout_action !== 'hang' && !isValidAfter(r.timeout_after)) at(tl(lang, '超时动作为 {action} 时必须填写超时（30m / 8h / 1d / 1bd）', { action: `${r.timeout_action}` }));
    if (r.timeout_action === 'default' && (DECISION_TYPES[r.decision_type].level3 || DECISION_TYPES[r.decision_type].noDefault)) {
      at(tl(lang, '{label}不支持「按默认处理」（default）；请改为「转下一顺位」（next）或「持续等待」（hang）', { label: typeLabel(lang, r.decision_type) }));
    }
    for (const s of r.recipients) {
      const bare = String(s).replace(/^inform:/, '');
      if (/^user:\$/.test(bare)) at(tl(lang, '占位符 {name} 尚未指定成员', { name: bare }));
      else if (!/^(user:[\w-]+|group:[\w*-]+|on_duty|parties|requester)$/.test(bare)) at(tl(lang, '接收人写法无效：{value}', { value: `${s}` }));
      if (bare === 'requester' && r.decision_type === 'conflict') at(tl(lang, '需求提出人不能用于「意见不一致」类型'));
      if (bare === 'parties' && r.decision_type !== 'conflict') at(tl(lang, 'parties 只能用于「意见不一致」类型'));
    }
    (byType[r.decision_type] ??= []).push({ r, i });
    // 解析后的人数与负责人
    let resolved;
    // 需求提出人按任务解析；表上校验时按"有一个人"算（与冲突双方同理）。
    const hasRq = r.recipients.some((x) => String(x).replace(/^inform:/, '') === 'requester');
    try { resolved = resolveRecipients(db, key, r.recipients, { parties: bare(r) ? ['__p1', '__p2'] : [], requester: hasRq ? ['__rq'] : [], lead }); } catch (e) { return at(translateError(e, lang)); }
    const answerers = resolved.answerers;
    if (!answerers.length && r.timeout_action === 'next') at(tl(lang, '接收人为空时，超时动作只能是「持续等待」（hang）或「按默认处理」（default）'));
    if (answerers.length && r.quorum !== QUORUM_ALL && Number(r.quorum) > answerers.length) at(tl(lang, '法定人数 {quorum} 大于接收人实际人数 {n}', { quorum: `${r.quorum}`, n: answerers.length }));
    // 默认表：负责人是占位，`group:*`（所有成员）必然含任何任务的负责人。
    const hasLead = answerers.includes(lead) || (!key && r.recipients.includes('group:*'));
    if (DECISION_TYPES[r.decision_type].level3 && !r.recipients.includes('parties') && lead && !hasLead) {
      // 说清为什么（例：负责人想把结构矛盾只派给某位成员，被拦下却不知道原因，还以为"系统卡住"也不行）
      const why = { structural: tl(lang, '这类事往往要改项目的约定'), contract_approval: tl(lang, '批准方案就是定下项目的约定'), conflict: tl(lang, '意见不一致最后要有人拍板') }[r.decision_type];
      const label = typeLabel(lang, r.decision_type);
      at((why ? tl(lang, '「{label}」的接收人必须包含负责人：{why}，负责人得参与。在这一行的接收人里加上「负责人」再保存（可以和别人一起收）', { label, why })
        : tl(lang, '「{label}」的接收人必须包含负责人。在这一行的接收人里加上「负责人」再保存（可以和别人一起收）', { label }))
        + (r.decision_type === 'structural' ? tl(lang, '。「系统卡住」那一行不受此限，可以只填一个人') : '')
        + (key ? '' : tl(lang, '。默认决策路由由多个任务共用，请使用「负责人」而不是某位成员')));
    }
    if (r.recipients.some((s) => s.replace(/^inform:/, '') === 'on_duty') && !dutyCalendarOf(db, key)?.users?.length) at(tl(lang, '使用了 on_duty，但值班表为空'));
  });
  for (const t of Object.keys(DECISION_TYPES)) {
    const rows = byType[t] ?? [];
    const label = typeLabel(lang, t);
    if (!rows.some(({ r }) => r.scope === '*')) errs.push({ row: null, msg: tl(lang, '{label}：至少需要一行范围为 * 的规则', { label }) });
    // 同一 (类型, 范围) 链：position 连续、next 有下一行、Ⅲ 级类型最后一行只能 hang
    const chains = {};
    for (const x of rows) (chains[x.r.scope] ??= []).push(x);
    for (const [scope, xs] of Object.entries(chains)) {
      xs.sort((a, b) => a.r.position - b.r.position);
      xs.forEach((x, k) => {
        if (x.r.position !== k) errs.push({ row: x.i, msg: tl(lang, '第 {n} 行：{label} / {scope} 的顺位必须从 0 起连续编号', { n: x.i + 1, label, scope }) });
        if (x.r.timeout_action === 'next' && k === xs.length - 1) errs.push({ row: x.i, msg: tl(lang, '第 {n} 行：超时动作为「转下一顺位」（next），但没有下一顺位', { n: x.i + 1 }) });
        if (DECISION_TYPES[t].level3 && k === xs.length - 1 && x.r.timeout_action !== 'hang') errs.push({ row: x.i, msg: tl(lang, '第 {n} 行：{label}的最后一个顺位只能「持续等待」（hang）', { n: x.i + 1, label }) });
      });
    }
  }
  return errs;
}
const bare = (r) => r.recipients.some((s) => String(s).replace(/^inform:/, '') === 'parties');

/** 覆盖式保存：整张项目表换成 rules（校验不过就不动）。记审计。 */
export function saveRules(db, { key, rules, template = null, bindings = {}, userId, repoDirs = null, lang = 'zh' }) {
  rules = rules.map((r) => ({ ...r, scope: normScope(r.scope) }));
  // 交上来的表缺新加的类型（旧页面 / 旧脚本）：与 rulesOf 同一条规则借行补齐，而不是整张表报错
  for (const [t, from] of Object.entries(TYPE_FALLBACK)) {
    if (!rules.some((r) => r.decision_type === t)) rules = [...rules, ...rules.filter((r) => r.decision_type === from).map((r) => ({ ...r, decision_type: t }))];
  }
  const errs = validateRules(db, key, rules, { repoDirs, lang });
  // 逐条的原因已按 lang 写好；外壳这一句由服务端按看的人的界面语言翻
  if (errs.length) { const e = new I18nError('决策路由未保存，校验未通过：\n{list}', { list: errs.map((x) => `  - ${x.msg}`).join('\n') }); e.errors = errs; throw e; }
  const t = now();
  return db.tx(() => {
    db.run(`DELETE FROM routing_rules WHERE project_id=?`, key);
    rules.forEach((r, i) => db.run(`INSERT INTO routing_rules (id,project_id,decision_type,scope,position,recipients,quorum,conflict_policy,timeout_action,timeout_after,template,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, newId('rr'), key, r.decision_type, r.scope, r.position ?? i, JSON.stringify(r.recipients), String(r.quorum), r.conflict_policy, r.timeout_action, r.timeout_after ?? null, template, t));
    db.run(`INSERT INTO routing_profiles (project_id,template,bindings,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(project_id) DO UPDATE SET template=excluded.template, bindings=excluded.bindings, updated_at=excluded.updated_at`,
    key, template, JSON.stringify(bindings), t);
    audit(db, { actorKind: 'user', actorId: userId, action: 'routing_saved', targetType: 'project', targetId: key || '(default)',
      payload: { template, rows: rules.length, bindings: Object.keys(bindings) } });
    return { rows: rules.length };
  });
}

/** 选模板 = 把行复制进项目的表。占位符（user:$pm）由 bindings 绑到用户 id。 */
export function applyTemplate(db, { key, name, bindings = {}, userId, repoDirs = null, lang = 'zh' }) {
  const tpl = loadTemplates()[name];
  if (!tpl) throw new I18nError('模板不存在：{name}（可选：{list}）', { name: `${name}`, list: Object.keys(loadTemplates()).join(' / ') });
  const missing = Object.keys(tpl.placeholders ?? {}).filter((p) => !bindings[p]);
  if (missing.length) throw new I18nError('模板「{label}」需要先指定：{list}', { label: tpl.label, list: missing.map((p) => `${p}（${tpl.placeholders[p]}）`).join('、') });
  const rules = tpl.rows.map((r) => ({ ...r, recipients: r.recipients.map((s) => s.replace(/^(inform:)?user:\$(\w+)$/, (_, inf, p) => `${inf ?? ''}user:${bindings[p]}`)) }));
  saveRules(db, { key, rules, template: name, bindings, userId, repoDirs, lang });
  return rules;
}

/** 项目表相对模板的差异（模板的占位符按 profile 里的 bindings 展开后比）。 */
export function diffFromTemplate(db, key) {
  const prof = profileOf(db, key);
  const tpl = loadTemplates()[prof.template ?? DEFAULT_TEMPLATE];
  if (!tpl) return { template: prof.template, added: [], removed: [], changed: [] };
  const b = JSON.parse(prof.bindings || '{}');
  const norm = (r) => JSON.stringify([r.decision_type, r.scope, r.position, r.recipients, String(r.quorum), r.conflict_policy, r.timeout_action, r.timeout_after ?? null]);
  const tplRows = tpl.rows.map((r) => ({ ...r, recipients: r.recipients.map((s) => s.replace(/^(inform:)?user:\$(\w+)$/, (_, inf, p) => `${inf ?? ''}user:${b[p] ?? `$${p}`}`)) }));
  const cur = rulesOf(db, key);
  const keyOf = (r) => `${r.decision_type}/${r.scope}/${r.position}`;
  const tm = new Map(tplRows.map((r) => [keyOf(r), r])), cm = new Map(cur.map((r) => [keyOf(r), r]));
  const added = cur.filter((r) => !tm.has(keyOf(r)));
  const removed = tplRows.filter((r) => !cm.has(keyOf(r)));
  const changed = cur.filter((r) => tm.has(keyOf(r)) && norm(tm.get(keyOf(r))) !== norm(r)).map((r) => ({ now: r, template: tm.get(keyOf(r)) }));
  return { template: prof.template ?? DEFAULT_TEMPLATE, added, removed, changed };
}

// ── 值班日历 ──────────────────────────────────────────────────────────────
export function dutyCalendarOf(db, key) {
  const r = db.one(`SELECT * FROM duty_calendar WHERE project_id=?`, key);
  return r ? { ...r, users: JSON.parse(r.users || '[]') } : null;
}
export function setDutyCalendar(db, { key, users, startAt, periodDays = 7, userId }) {
  if (!Array.isArray(users) || !users.length) throw new I18nError('值班表不能为空');
  for (const u of users) if (!db.one(`SELECT id FROM users WHERE id=?`, u)) throw new I18nError('值班表中的成员不存在：{id}', { id: `${u}` });
  const t = now();
  db.run(`INSERT INTO duty_calendar (project_id,users,start_at,period_days,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(project_id) DO UPDATE SET users=excluded.users, start_at=excluded.start_at, period_days=excluded.period_days, updated_at=excluded.updated_at`,
  key, JSON.stringify(users), startAt, periodDays, t);
  audit(db, { actorKind: 'user', actorId: userId, action: 'duty_calendar_set', targetType: 'project', targetId: key || '(default)', payload: { users, startAt, periodDays } });
}
/** 目前：用户列表 + 起始日期 + 按 period_days 轮换。不做节假日与换班。 */
export function onDutyAt(cal, at) {
  if (!cal?.users?.length) return null;
  const idx = Math.floor((at - cal.start_at) / (cal.period_days * 86400_000));
  return cal.users[((idx % cal.users.length) + cal.users.length) % cal.users.length];
}

// ── 解析器 ────────────────────────────────────────────────────────────────
/**
 * 收件人解析器列表 → { answerers, informed }。在事项创建那一刻调用。
 *   user:<id> / user:lead / group:<tag> / group:*（所有 member）/ on_duty / parties（冲突双方）/ inform:<以上任一>
 */
/**
 * 需求提出人：这个任务是谁提的（task.requested_by，添加任务时记下）。路由表里写 `requester` 就解析成这个人 ——
 * 典型用法是签收：「需求提出人 + 负责人，法定人数 all」= 提的人验收自己的需求、负责人把最后一道。
 * 任务没有记出处（首批规划、复盘切出来的）或那个人已停用 / 是旁观者 → 解析为空，只剩同一行里的其他人。
 */
export function requesterOf(db, taskId) {
  const id = taskId ? getParam(db, taskId, 'task.requested_by') : null;
  return id && db.one(`SELECT id FROM users WHERE id=? AND role<>'observer' AND disabled_at IS NULL`, id) ? [id] : [];
}

export function resolveRecipients(db, key, resolvers, { parties = [], requester = [], at = now(), lead = undefined } = {}) {
  const answerers = new Set(), informed = new Set();
  // `user:lead` 是谁：有任务在手时调用方传任务的负责人（默认表 '' 下多个独立任务各有各的 owner，
  // 没有表级的负责人）；只有校验 / 旋钮这种没有任务的场合才退到 leadOfKey（默认表下为 null，`user:lead` 解析为空）。
  if (lead === undefined) lead = leadOfKey(db, key);
  const one = (s) => {
    if (s === 'user:lead') return lead ? [lead] : [];
    if (s.startsWith('user:')) { const id = s.slice(5); return db.one(`SELECT id FROM users WHERE id=? AND role<>'observer' AND disabled_at IS NULL`, id) ? [id] : []; }
    if (s === 'group:*') return db.all(`SELECT id FROM users WHERE role IN ('lead','member') AND disabled_at IS NULL ORDER BY created_at`).map((r) => r.id);
    if (s.startsWith('group:')) {
      const tag = s.slice(6);
      return db.all(`SELECT id, domain_tags FROM users WHERE role IN ('lead','member') AND disabled_at IS NULL ORDER BY created_at`)
        .filter((r) => { try { return JSON.parse(r.domain_tags || '[]').includes(tag); } catch { return false; } }).map((r) => r.id);
    }
    if (s === 'on_duty') { const u = onDutyAt(dutyCalendarOf(db, key), at); return u && db.one(`SELECT id FROM users WHERE id=? AND disabled_at IS NULL`, u) ? [u] : []; }
    if (s === 'parties') return parties;
    if (s === 'requester') return requester;
    throw new I18nError('接收人写法无效：{value}', { value: `${s}` });
  };
  for (const s of resolvers) {
    if (s.startsWith('inform:')) one(s.slice(7)).forEach((u) => informed.add(u));
    else one(s).forEach((u) => answerers.add(u));
  }
  for (const u of answerers) informed.delete(u);
  return { answerers: [...answerers], informed: [...informed] };
}

/**
 * 匹配：每个前缀各自按最长范围取一条链（同类型、同范围、按 position 排）；没有前缀或都没命中 → `*` 链。
 * 返回去重后的链列表。CODEOWNERS 同形：多范围时收件人取并集、法定人数按各链分别满足。
 */
export function matchChains(rules, { decisionType, prefixes = [] }) {
  const rows = rules.filter((r) => r.decision_type === decisionType);
  const chainOf = (scope) => rows.filter((r) => r.scope === scope).sort((a, b) => a.position - b.position);
  const picked = new Map();
  const star = chainOf('*');
  const hits = [];
  for (const p of prefixes) {
    const best = rows.filter((r) => r.scope !== '*' && scopeMatches(r.scope, p)).sort((a, b) => b.scope.length - a.scope.length)[0];
    if (best) hits.push(best.scope);
  }
  for (const s of hits) if (!picked.has(s)) picked.set(s, chainOf(s));
  if (!picked.size && star.length) picked.set('*', star);
  return [...picked.entries()].map(([scope, chain]) => ({ scope, chain }));
}

/**
 * 给一条刚插入的事项解析路由并写回。**在调用方的事务里调**（本函数不开事务）。
 * 写回：decision_type / type_source / quorum / conflict_policy / addressed_to / informed / route / route_due_at。
 * route = { stage, chains: [{ scope, rules: [rule_id...] }], rows: [{ rule_id, recipients, quorum, conflict_policy, timeout_action, timeout_after }] }
 * rows 是当前 stage 各链的行。
 */
export function routeQuestion(db, { questionId, decisionType, typeSource, prefixes = null, parties = [], at = now(), stage = 0 }) {
  if (!DECISION_TYPES[decisionType]) throw new I18nError('决策类型无效：{type}', { type: `${decisionType}` });
  const q = db.one(`SELECT task_id, level FROM questions WHERE id=?`, questionId);
  if (!q) throw new I18nError('事项不存在：{id}', { id: questionId });
  const key = routingKeyOf(db, q.task_id);
  const lead = leadOf(db, q.task_id);
  const rules = rulesOf(db, key);
  const pf = prefixes ?? routePrefixesOf(db, q.task_id);
  const chains = matchChains(rules, { decisionType, prefixes: pf });
  const stageRows = [];
  const answerers = new Set(), informed = new Set();
  let due = null;
  for (const { scope, chain } of chains) {
    const rule = chain[Math.min(stage, chain.length - 1)];
    if (!rule) continue;
    const res = resolveRecipients(db, key, rule.recipients, { parties, requester: requesterOf(db, q.task_id), at, lead });
    res.answerers.forEach((u) => answerers.add(u)); res.informed.forEach((u) => informed.add(u));
    const row = { rule_id: rule.id, scope, recipients: res.answerers, quorum: String(rule.quorum), conflict_policy: rule.conflict_policy,
      timeout_action: rule.timeout_action, timeout_after: rule.timeout_after ?? null, last: stage >= chain.length - 1 };
    stageRows.push(row);
    if (rule.timeout_action !== 'hang' && rule.timeout_after) {
      const d = dueAfter(at, rule.timeout_after);
      due = due === null ? d : Math.min(due, d);
    }
  }
  for (const u of answerers) informed.delete(u);
  const route = { stage, chains: chains.map((c) => ({ scope: c.scope, rules: c.chain.map((r) => r.id) })), rows: stageRows, prefixes: pf };
  const quorum = stageRows.map((r) => r.quorum).sort().at(-1) ?? '1';
  const policy = stageRows.some((r) => r.conflict_policy === 'latest') ? 'latest' : 'block';
  db.run(`UPDATE questions SET decision_type=?, type_source=?, quorum=?, conflict_policy=?, addressed_to=?, informed=?, route=?, route_due_at=? WHERE id=?`,
    decisionType, typeSource, quorum, policy, JSON.stringify([...answerers]), JSON.stringify([...informed]), JSON.stringify(route), due, questionId);
  appendTransferHint(db, questionId, decisionType);
  return { key, decisionType, answerers: [...answerers], informed: [...informed], route, dueAt: due };
}

/**
 * 「这事该问别人」那条出路。
 *
 * 执行器把矛盾抛给负责人，负责人常常知道"这事该问产品"—— 而事项正文里从来没提过转交这回事。
 * 命令（`question transfer`）和看板上的按钮**本来就有**，只是读事项的人看不见它们：
 * 事项正文会进通知、进摘要、进 CLI，而那才是人真正读到的地方。
 * 要防的是这一类毛病：**人有一个说得出口的正确动作，界面上没有地方做**。
 *
 * 挂在 `routeQuestion` 里而不是每个 raise 点各写一遍：它是所有事项的唯一必经处，
 * 而"这条发给了谁、不是你的话怎么转"本来就是同一件事。幂等（改派、转交会再走一次）。
 */
export const TRANSFER_HINT_MARK = '　　·　不该你答？';
/**
 * 机器读事项正文之前先剥掉转交那一行：那一行写着 `node src/cli.mjs question transfer …`，
 * 答复登记成决定时范围是从正文里抽路径的，不剥的话一个 Python 项目的约定范围里会冒出 `src/cli.mjs`，
 * 复盘时规划器还会专门把它列成"无法确认的来由"。那一行是给人看的出路，不是事项内容。
 */
export const stripTransferHint = (text) => { const s = String(text ?? ''); const i = indexOfMark(s, 'transferHint'); return i < 0 ? s : s.slice(0, i).trimEnd(); };
// 按内容语言写（0.2.0）：标记走 marks.mjs（读的一侧两种都认），按钮名与看板一致（英文 Hand over / Not mine）
const transferHintFor = (questionId, lang = 'zh') => `

${markOf(lang, 'transferHint')}${tl(lang, '转给知道的人：node src/cli.mjs question transfer {id} --to user:<成员id>（看板上这条事项右边有「转交」按钮）。转交之后你不再是接收人，但**这条仍然要有人答** —— 与「不归我」不是一回事。', { id: questionId })}`;
function appendTransferHint(db, questionId, decisionType) {
  // 交付不生成事项；冲突事项的答案空间是封闭的三选一（附议 / 弃权 / 重申），转交只会把裁定甩来甩去。
  if (decisionType === 'conflict' || decisionType === 'delivery') return;
  const row = db.one(`SELECT text FROM questions WHERE id=?`, questionId);
  if (!row || indexOfMark(row.text, 'transferHint') >= 0) return;
  db.run(`UPDATE questions SET text=? WHERE id=?`, `${row.text}${transferHintFor(questionId, contentLang(db))}`, questionId);
}

/** 转下一行（超时 next）或转交后重算。返回新的解析结果；没有下一行 → null（保持挂起）。 */
export function advanceRoute(db, { questionId, at = now() }) {
  const q = db.one(`SELECT * FROM questions WHERE id=?`, questionId);
  const route = JSON.parse(q.route || 'null');
  if (!route) return null;
  const hasNext = route.chains.some((c) => c.rules.length > route.stage + 1);
  if (!hasNext) return null;
  const parties = route.parties ?? [];
  const r = routeQuestion(db, { questionId, decisionType: q.decision_type, typeSource: q.type_source, prefixes: route.prefixes, parties, at, stage: route.stage + 1 });
  if (parties.length) db.run(`UPDATE questions SET route=json_set(route,'$.parties',json(?)) WHERE id=?`, JSON.stringify(parties), questionId);
  return r;
}

/**
 * 转交 / 下放：事项级，只改这一条的收件人，不改表。两条事项级不变量：
 *   - "必含负责人"只看**类型集合**（DECISION_TYPES.level3），不看事项的 level 列 —— 级别决定等多久，类型决定问谁，两者正交；
 *   - **非负责人不能借转交降法定人数**：新收件人少于原行 quorum 即拒（否则一个评审人把 quorum 2 的签收转给自己就成了单人签收）。
 *     负责人可以降（他本来就能一人定）。
 * 转交后 route_due_at 按各行时限从此刻重算，而不是清零 —— 转交不该让 next / default 兜底失效。
 */
export function transferQuestion(db, { questionId, to, byUserId, reason = null, at = now() }) {
  const q = db.one(`SELECT * FROM questions WHERE id=?`, questionId);
  if (!q) throw new I18nError('事项不存在：{id}', { id: questionId });
  if (!['open', 'escalated'].includes(q.status)) throw new I18nError('事项 {id} 状态为 {status}，无法转交', { id: questionId, status: q.status });
  const key = routingKeyOf(db, q.task_id);
  const lead = leadOf(db, q.task_id);
  const cur = JSON.parse(q.addressed_to || '[]');
  const byLead = byUserId === lead;
  if (!byLead && !cur.includes(byUserId)) throw new I18nError('只有该事项的接收人或负责人能转交');
  const res = resolveRecipients(db, key, to, { at, lead });
  if (!res.answerers.length) throw new I18nError('转交对象中没有可答复的成员');
  if (DECISION_TYPES[q.decision_type]?.level3 && q.decision_type !== 'conflict' && !res.answerers.includes(lead)) {
    throw new I18nError('{label}事项转交后，接收人仍须包含负责人', { label: DECISION_TYPES[q.decision_type].label });
  }
  // 上限事项的出路是"去任务页调上限"：转给改不了上限的人等于给他一条死路（他找不到入口，
  // 只能转回）。谁能改上限查路由表「预算上限」那一行，与 setLimit 同一个口径。
  if (q.decision_type === 'budget') {
    const cannot = res.answerers.filter((u) => !authorize(db, { taskId: q.task_id, decisionType: 'budget', userId: u, at }).ok);
    if (cannot.length) {
      const nm = (id) => db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id;
      // 「上限追加」写死在原文里（与 DECISION_TYPES.budget.label 同一个词），英文目录照译
      throw cannot.length > 1
        ? new I18nError('上限事项只能转给能改上限的人：{names} 改不了上限（路由表「上限追加」那一行里没有他们）。能改上限的人列在设置页决策路由的「上限追加」那一行。可以请懂行的人帮着判断，但调上限、回这条事项还得那一行里的人来', { names: cannot.map(nm).join('、') })
        : new I18nError('上限事项只能转给能改上限的人：{names} 改不了上限（路由表「上限追加」那一行里没有这个人）。能改上限的人列在设置页决策路由的「上限追加」那一行。可以请懂行的人帮着判断，但调上限、回这条事项还得那一行里的人来', { names: cannot.map(nm).join('、') });
    }
  }
  const informed = JSON.parse(q.informed || '[]').filter((u) => !res.answerers.includes(u));
  // 路由快照里的各行换成新收件人，否则答复数人头时还在数旧收件人。
  const route = JSON.parse(q.route || 'null');
  let due = null;
  if (route?.rows) {
    for (const r of route.rows) {
      const need = r.quorum === QUORUM_ALL ? null : Number(r.quorum);
      if (need !== null && need > res.answerers.length) {
        if (!byLead) throw new I18nError('该事项的法定人数为 {need}，转交后接收人只有 {n} 人；请转交给至少 {need} 人，或由负责人转交', { need, n: res.answerers.length });
        r.quorum = String(res.answerers.length);
        r.quorum_lowered_by = byUserId;
      }
      r.recipients = res.answerers;
      if (r.timeout_action !== 'hang' && r.timeout_after) {
        const d = dueAfter(at, r.timeout_after);
        due = due === null ? d : Math.min(due, d);
      }
    }
    route.transferred = true;
  }
  db.run(`UPDATE questions SET addressed_to=?, informed=?, route=?, route_due_at=? WHERE id=?`, JSON.stringify(res.answerers), JSON.stringify(informed), route ? JSON.stringify(route) : q.route, due, questionId);
  audit(db, { actorKind: 'user', actorId: byUserId, action: 'question_transferred', targetType: 'question', targetId: questionId,
    // 转交附一句理由（否则被转交的人不知道为什么转给自己）。可留空。
    payload: { from: cur, to: res.answerers, resolvers: to, dueAt: due, reason: String(reason ?? '').trim().slice(0, 500) || null } });
  return { from: cur, to: res.answerers, dueAt: due };
}

// ── 授权（四种 CLI 动作改查路由表）────────────────────────────────────────
/**
 * 某人能否对某任务做某类决策：负责人恒可；否则要在该类型当前解析出的收件人里。
 * 旁观者恒不可。返回 { ok, why, recipients }。
 */
export function authorize(db, { taskId, decisionType, userId, prefixes = null, at = now() }) {
  const u = db.one(`SELECT role, disabled_at FROM users WHERE id=?`, userId);
  if (!u) return { ok: false, why: '成员不存在', recipients: [] };
  if (u.disabled_at) return { ok: false, why: '该成员已停用', recipients: [] };
  const lead = leadOf(db, taskId);
  if (userId === lead) return { ok: true, why: 'lead', recipients: [lead] };
  if (u.role === 'observer') return { ok: false, why: '旁观者没有决策权限', recipients: [] };
  const key = routingKeyOf(db, taskId);
  const chains = matchChains(rulesOf(db, key), { decisionType, prefixes: prefixes ?? routePrefixesOf(db, taskId) });
  const rec = new Set();
  for (const { chain } of chains) for (const r of chain) resolveRecipients(db, key, r.recipients, { requester: requesterOf(db, taskId), at, lead }).answerers.forEach((x) => rec.add(x));
  const ok = rec.has(userId);
  const nameOf = (id) => db.one(`SELECT display_name FROM users WHERE id=?`, id)?.display_name ?? id;
  const label = DECISION_TYPES[decisionType]?.label ?? decisionType, names = [...rec].map(nameOf).join('、');
  // label / names 给 requireAuthorized 拼可翻的报错用
  return { ok, why: ok ? 'routed' : `${label}的接收人不包含你（接收人：${names || '无'}）`, recipients: [...rec], ...(ok ? {} : { label, names }) };
}
export function requireAuthorized(db, o) {
  const a = authorize(db, o);
  if (!a.ok) {
    // 报错按看的人的界面语言翻（I18nError）：几种原因各写一整句，不把中文原因当参数塞进去
    if (a.why === '成员不存在') throw new I18nError('无权操作：成员不存在。可请接收人或负责人转交，或请负责人调整决策路由');
    if (a.why === '该成员已停用') throw new I18nError('无权操作：该成员已停用。可请接收人或负责人转交，或请负责人调整决策路由');
    if (a.why === '旁观者没有决策权限') throw new I18nError('无权操作：旁观者没有决策权限。可请接收人或负责人转交，或请负责人调整决策路由');
    throw a.names
      ? new I18nError('无权操作：{label}的接收人不包含你（接收人：{names}）。可请接收人或负责人转交，或请负责人调整决策路由', { label: `${a.label}`, names: a.names })
      : new I18nError('无权操作：{label}的接收人不包含你（接收人：无）。可请接收人或负责人转交，或请负责人调整决策路由', { label: `${a.label}` });
  }
  return a;
}

// ── 两个旋钮 = 表的投影 ───────────────────────────────────────────────────
/** 介入者名单 = 各行收件人解析后的并集（去掉负责人）；决策类型归属 = 范围 * 且 position 0 的行的收件人列。 */
export function knobsOf(db, key) {
  const rules = rulesOf(db, key);
  const lead = leadOfKey(db, key);
  const inter = new Set();
  const ownership = {}, ownershipQuorum = {};
  for (const r of rules) {
    const res = resolveRecipients(db, key, r.recipients, { parties: [] });
    [...res.answerers, ...res.informed].forEach((u) => { if (u !== lead) inter.add(u); });
    if (r.scope === '*' && r.position === 0) { ownership[r.decision_type] = r.recipients; ownershipQuorum[r.decision_type] = String(r.quorum); }
  }
  return { interveners: [...inter], ownership, ownershipQuorum, lead };
}
/** 改旋钮 = 改表：决策类型归属写 `*` 行 position 0 的收件人；介入者名单只能删（从所有行里去掉 user:<id>），加人要落到某个类型。 */
export function setKnobs(db, { key, ownership = null, removeInterveners = [], userId, repoDirs = null, lang = 'zh' }) {
  const rules = rulesOf(db, key).map((r) => ({ ...r }));
  if (ownership) for (const [t, recips] of Object.entries(ownership)) {
    const row = rules.find((r) => r.decision_type === t && r.scope === '*' && r.position === 0);
    if (!row) throw new I18nError('{label}缺少范围为 * 的规则', { label: `${DECISION_TYPES[t]?.label ?? t}` });
    row.recipients = recips;
  }
  for (const u of removeInterveners) for (const r of rules) r.recipients = r.recipients.filter((s) => s !== `user:${u}` && s !== `inform:user:${u}`);
  const prof = profileOf(db, key);
  saveRules(db, { key, rules: rules.map(({ id, project_id, template, created_at, ...r }) => r), template: prof.template, bindings: JSON.parse(prof.bindings || '{}'), userId, repoDirs, lang });
  return knobsOf(db, key);
}

// ── 保存前的历史预演 ─────────────────────────────────────────────────────
/**
 * 拿已有事项按一张表回放：每个人会被打断几次、哪些事项没人接、Ⅲ 级事项到谁。
 * 只看 decision_type 已知的事项（迁移已按正文回填）。冲突数在单人历史里必然是 0，如实报。
 */
export function previewRouting(db, { key, rules, limit = 500 }) {
  const tasks = key ? db.all(`SELECT id FROM tasks WHERE project_id=?`, key) : db.all(`SELECT id FROM tasks WHERE project_id IS NULL`);
  const ids = tasks.map((t) => t.id);
  if (!ids.length) return { questions: 0, interruptions: {}, unaddressed: [], level3To: {}, conflicts: 0 };
  // 冲突事项的第一行收件人是当事双方（parties），按表回放没有意义，跳过。
  const qs = db.all(`SELECT id, task_id, level, decision_type, asked_at FROM questions WHERE task_id IN (${ids.map(() => '?').join(',')}) AND decision_type IS NOT NULL AND decision_type<>'conflict' ORDER BY asked_at DESC LIMIT ?`, ...ids, limit);
  const interruptions = {}; const unaddressed = []; const level3To = {};
  const pfCache = new Map(); const leadCache = new Map();
  for (const q of qs) {
    if (!pfCache.has(q.task_id)) { pfCache.set(q.task_id, routePrefixesOf(db, q.task_id)); leadCache.set(q.task_id, leadOf(db, q.task_id)); }
    const chains = matchChains(rules, { decisionType: q.decision_type, prefixes: pfCache.get(q.task_id) });
    const rec = new Set();
    for (const { chain } of chains) if (chain[0]) resolveRecipients(db, key, chain[0].recipients, { parties: [], at: q.asked_at, lead: leadCache.get(q.task_id) }).answerers.forEach((u) => rec.add(u));
    if (!rec.size) unaddressed.push({ id: q.id, decision_type: q.decision_type });
    for (const u of rec) interruptions[u] = (interruptions[u] ?? 0) + 1;
    if (q.level === 3 || DECISION_TYPES[q.decision_type]?.level3) for (const u of rec) level3To[u] = (level3To[u] ?? 0) + 1;
  }
  return { questions: qs.length, interruptions, unaddressed, level3To, conflicts: 0 };
}

/** 迁移与旧数据用：按正文前缀猜决策类型（硬规则生成的问题都有固定前缀）。 */
export function guessDecisionType(text, { nodeId = null } = {}) {
  const s = String(text ?? '');
  if (s.startsWith('【硬上限触顶】')) return 'budget';
  if (s.startsWith('【请求放行出口白名单】')) return 'egress';
  if (s.startsWith('【修正需要你批准】')) return 'contract_approval';
  if (s.startsWith('【宪法块草案') || s.startsWith('【项目契约草案')) return 'contract_approval';
  if (s.startsWith('【签收】')) return 'signoff';
  if (s.startsWith('【冲突】')) return 'conflict';
  // 模型提的问题：旧数据没有自报类型，一律记规格取舍（结构矛盾要模型自报，见 executor 的 raise_question.kind）
  return nodeId ? 'spec_choice' : 'spec_choice';
}
