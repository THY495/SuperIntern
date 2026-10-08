// 项目级设置：预算闸 / 项目级验收命令 / 自动化挡位。
//
// 三个旋钮住在一起，因为它们是**同一条授权链上的三节**：挡位说"AI 能不能自己开工"，
// 预算闸说"自己开工最多花到哪"，项目级验收命令说"凭什么算达成"。草案里写死的四条前提
// （见 GEAR_PREREQS）把这条链钉住：缺任何一节，自动挡就挂不上。
//
// ── 三条边界 ──────────────────────────────────────────────────────────────
// ① **闸门挡的是"再花下一笔"，不是把正在跑的掐死**。撞闸时正在跑的那个任务会在下一轮体检
//    停下来（走 checkLimits 的同一条路），但已经花出去的钱要不回来，也不去 kill 容器 ——
//    半路掐断留下的是一个说不清状态的工作区，比超支几分钱贵。
// ② **闸门不是上限的一种**。上限（LIMITS）按任务算、每个任务各有一份；闸门按项目算总数，
//    跨任务累计。所以它不进 LIMITS 表，只在 checkLimits 末尾追加一道判断 —— 但撞顶之后
//    走的是同一条"强制汇报 + 提问 + 冻住"的路，不另开一套。
// ③ **默认不设**。不设 = 没有闸门 = 自动挡挂不上。这是有意的：让"AI 自己
//    开工"这件事的前提之一是人先说出一个数字，而不是给一个默认值让人忘了它存在。

import { markLike, markOf } from '../i18n/marks.mjs';
import { tl, contentLang, N_, I18nError } from '../i18n/index.mjs';
import { now, newId, audit, insertEdge } from '../db/db.mjs';
import { getParam, getProjectParam, setProjectParam } from './params.mjs';
import { routeQuestion } from './routing.mjs';
import { verifyCommandProblems } from '../agent/elicitor.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';

export const BUDGET_KEY = 'project.budget_micro_usd';
export const VERIFY_KEY = 'project.verify_command';
export const GEAR_KEY = 'project.gear';
export const MAX_OPEN_KEY = 'project.max_open';

// ── 同时开着几个任务 ────────────────────────────────────────────────────
// 默认 2，不是"想开几个开几个"。这个数字**不是吞吐旋钮**：它换来的只有"A 在等人的时候
// B 别干等着"，而每多开一个就多一份变基 + 重跑全部回归义务的代价，还多一份
// "两个任务同时改同一处"的机会。真要提，先有实际运行的数据说明等待时间确实是瓶颈。
export const DEFAULT_MAX_OPEN = 2;
export const MAX_OPEN_CEILING = 4;
// 沙箱镜像的口味（按项目选）：node = 只有 Node；python = 在它之上加 python3 的变体。
export const SANDBOX_KEY = 'project.sandbox';
// 默认带 Python：它是 Node 镜像的超集。默认只有 Node 的话，选 FastAPI 做后端的项目从空仓库起就没有 Python，
// 得有人先去项目设置里换镜像 —— 那就是在让人配环境。只要 Node 的项目仍可选瘦一点的那个。
export const SANDBOX_FLAVORS = { python: N_('Node + Python 3（默认）'), node: N_('只有 Node（镜像小一些）') };
// 用 N_ 登记过的原文（挡位 / 前提的 label、why）按变量查：抽取器只认字面量，所以不写成 tl(L, 变量)。
const tlN = tl;
export const sandboxFlavorOf = (db, projectId) => {
  const v = projectId ? getProjectParam(db, projectId, SANDBOX_KEY) : null;
  return SANDBOX_FLAVORS[v] ? v : 'python';
};
export function setSandboxFlavor(db, { projectId, flavor, userId }) {
  if (!SANDBOX_FLAVORS[flavor]) throw new I18nError('沙箱只有这几种：{list}', { list: Object.keys(SANDBOX_FLAVORS).join(' / ') });
  return writeOne(db, { projectId, key: SANDBOX_KEY, value: flavor, userId, action: 'project_sandbox_set', payload: { flavor } });
}

export const maxOpenOf = (db, projectId) => {
  const n = Number(getProjectParam(db, projectId, MAX_OPEN_KEY));
  return Number.isInteger(n) && n >= 1 && n <= MAX_OPEN_CEILING ? n : DEFAULT_MAX_OPEN;
};

// ── 并行开发（默认关）──────────────────────────────────────────────────
// 开着时：规划先出接口契约与"骨架"任务，其余按模块切、范围两两不相交；骨架合并后，共享文件（接口、根依赖清单、
// 根验收脚本……）对模块任务只读；调度"就绪就开"（并发上限内），不再只在都等人时让路。
// 关着时一切与 0.2.0 相同。要在规划前定：规划器的切法取决于它。
export const PARALLEL_KEY = 'project.parallel';
export const parallelOf = (db, projectId) => (projectId ? getProjectParam(db, projectId, PARALLEL_KEY) === true : false);
export function setParallel(db, { projectId, on, userId }) {
  return writeOne(db, { projectId, key: PARALLEL_KEY, value: !!on, userId, action: 'project_parallel_set', payload: { on: !!on } });
}

/** 挡位。default 是 propose —— 沉默的默认永远是"提议"，显式授权才进自动挡。 */
export const GEARS = {
  propose: { label: N_('提议'), blurb: N_('每次签收后，规划器对照项目目标提下一批任务或声明已达成；建任务前都要人批一次。') },
  auto: { label: N_('预算内自动开工、合并'), blurb: N_('在项目预算闸之内：草案直接开工、验收过了直接合并、事后通知、随时可中止。四条前提缺一不可；交付（push）永远要人点。') },
};
export const DEFAULT_GEAR = 'propose';

export const fmtUsd = (micro) => `$${(micro / 1e6).toFixed(4)}`;

/** 项目累计花费（含载体任务上追问 / 规划的钱 —— 那也是这个项目花的）。 */
export const projectSpendMicroUsd = (db, projectId) => db.one(
  `SELECT COALESCE(SUM(l.micro_usd),0) m FROM usage_ledger l JOIN tasks t ON t.id=l.task_id WHERE t.project_id=?`, projectId).m;

/** 闸门的当前状态。`gate === null` = 没设闸门（`over` 恒 false）。 */
export function budgetState(db, projectId) {
  const L = contentLang(db);
  const gate = getProjectParam(db, projectId, BUDGET_KEY);
  const spent = projectSpendMicroUsd(db, projectId);
  const g = Number.isFinite(Number(gate)) && gate !== null ? Number(gate) : null;
  return { gate: g, spent, remaining: g === null ? null : g - spent, over: g !== null && spent >= g,
    human: g === null ? tl(L, '已花 {spent}（没有设预算闸）', { spent: fmtUsd(spent) }) : tl(L, '已花 {spent} / 闸门 {gate}', { spent: fmtUsd(spent), gate: fmtUsd(g) }) };
}

export const gearOf = (db, projectId) => {
  const g = getProjectParam(db, projectId, GEAR_KEY);
  return GEARS[g] ? g : DEFAULT_GEAR;
};

/** 项目级验收命令（argv 数组）；没设就 null。 */
export const projectVerifyCommand = (db, projectId) => {
  const v = getProjectParam(db, projectId, VERIFY_KEY);
  return Array.isArray(v) && v.length ? v : null;
};

// ── 四条前提（草案里写死的，不是建议）────────────────────────────────────
// 第四条"与有效决定清单冲突时退回提议挡"不在这里判：它是**运行时**的一条判断
// （比对命中才成立），由挂挡的那一刻判不了。这里只判它的**装置在不在**——
// 决定登记表里这个项目有没有东西可比。判得出的三条在这里判死，判不出的那条
// 写清楚它在哪儿生效，不假装这里判过。
export const GEAR_PREREQS = [
  { key: 'budget', label: N_('项目预算闸已设'), why: N_('自动挡下 AI 自己开工，爆炸半径就是这个数字') },
  { key: 'verify', label: N_('项目级验收命令已填'), why: N_('没有机械验收，"达成"就只能由人一次次宣布，自动挡没有出口') },
  { key: 'guardrails', label: N_('草案要过现有全部护栏'), why: N_('与提议挡完全同一道检查（契约齐全、规则带出处、验收命令不经 shell）—— 自动挡一条都不放松') },
  { key: 'decisions', label: N_('与已定的约定冲突时退回提议挡'), why: N_('新任务落地前先对着项目页那份「已定的约定」比一遍；撞上任何一条，这一批就退回提议挡等你批') },
];

/** 四条前提的当前状态。返回 [{key,label,why,ok,note}]；`ok` 全真才挂得上自动挡。 */
export function gearPrereqStatus(db, projectId) {
  const b = budgetState(db, projectId);
  const v = projectVerifyCommand(db, projectId);
  return GEAR_PREREQS.map((p) => {
    // note 里的固定文字用 N_ 登记（看板 T(note) 翻）；金额、命令原样
    if (p.key === 'budget') return { ...p, ok: b.gate !== null, note: b.gate === null ? N_('还没设') : fmtUsd(b.gate) };
    if (p.key === 'verify') return { ...p, ok: !!v, note: v ? v.join(' ') : N_('还没填') };
    // 后两条是**机制**，不是旋钮：它们随代码走，挂挡时恒为真，列出来是为了让人看见自动挡到底靠什么兜底。
    // 界面上要明说"不可关闭"——读者从"没有控件"反推不出这是设计，还是功能没做完。
    return { ...p, ok: true, note: N_('随代码生效，不可关闭') };
  });
}

// ── 写 ────────────────────────────────────────────────────────────────────
// 三个旋钮都是宪法层参数（库层 CHECK 只许人写）。权限是项目负责人 —— 调用方保证（看板 / CLI 各自查）。

const BY = (userId) => ({ kind: 'user', id: userId });
const writeOne = (db, { projectId, key, value, userId, action, payload }) => db.tx(() => {
  const id = setProjectParam(db, { projectId, key, value, by: BY(userId), governance: 'constitutional' });
  audit(db, { actorKind: 'user', actorId: userId, action, targetType: 'project', targetId: projectId, payload });
  return id;
});

/** 设预算闸。`microUsd === null` = 撤掉闸门（自动挡会随之掉回提议挡）。 */
export function setProjectBudget(db, { projectId, microUsd, userId }) {
  if (microUsd !== null) {
    const n = Number(microUsd);
    if (!Number.isFinite(n) || n <= 0) throw new I18nError('预算闸要是正数（撤掉闸门请清空，不要填 0 —— 0 的意思是"一分钱都不许花"，那不是"不限"）');
    microUsd = Math.round(n);
  }
  const spent = projectSpendMicroUsd(db, projectId);
  if (microUsd !== null && microUsd < spent) {
    // 不拦。设成比已花的还低是**合法且有用**的动作（人想让它立刻停下来），但要让人知道后果。
    audit(db, { actorKind: 'user', actorId: userId, action: 'project_budget_below_spent', targetType: 'project', targetId: projectId,
      payload: { gate: microUsd, spent } });
  }
  const r = writeOne(db, { projectId, key: BUDGET_KEY, value: microUsd, userId, action: 'project_budget_set', payload: { microUsd, spent } });
  if (microUsd === null && gearOf(db, projectId) === 'auto') setGear(db, { projectId, gear: 'propose', userId, why: tl(contentLang(db), '预算闸被撤掉') });
  return r;
}

/** 设项目级验收命令。`command` 是一条命令的字符串（按空白切成 argv，**不经 shell**），空 = 清掉。 */
export function setProjectVerify(db, { projectId, command, userId }) {
  const s = String(command ?? '').trim();
  if (s) for (const p of verifyCommandProblems(s)) throw new I18nError('项目级验收命令：{problem}', { problem: p });
  const argv = s ? s.split(/\s+/) : null;
  const r = writeOne(db, { projectId, key: VERIFY_KEY, value: argv, userId, action: 'project_verify_set', payload: { argv } });
  if (!argv && gearOf(db, projectId) === 'auto') setGear(db, { projectId, gear: 'propose', userId, why: tl(contentLang(db), '项目级验收命令被清空') });
  return r;
}

// ── 环境准备命令 ──────────────────────────────────────────────────────────
// 依赖目录不进仓库（workspace.writeDepExcludes），所以**每一份新工作区都是没装依赖的**：新任务的工作区、
// 项目级验收用的那份干净克隆都一样。项目级验收因此在需要依赖的项目上必挂（"找不到模块"），
// 新任务的 agent 也得每次重装一遍。这里让负责人写下几条命令（如 `python -m venv .venv`、
// `.venv/bin/pip install -r requirements.txt`），系统在新工作区第一次开跑前、项目级验收之前自动先跑。
// 每条一行、不经 shell（与验收命令同一条规矩）；按顺序跑，一条失败就停。
export const SETUP_KEY = 'project.setup_commands';
export const MAX_SETUP_COMMANDS = 8;
export const setupCommandsOf = (db, projectId) => {
  const v = projectId ? getProjectParam(db, projectId, SETUP_KEY) : null;
  return Array.isArray(v) ? v.filter((x) => Array.isArray(x) && x.length) : [];
};
export function setSetupCommands(db, { projectId, commands, userId }) {
  const lines = (Array.isArray(commands) ? commands : String(commands ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean);
  if (lines.length > MAX_SETUP_COMMANDS) throw new I18nError('环境准备命令最多 {max} 条（把多步合进一个脚本文件，再用一条命令跑它）', { max: MAX_SETUP_COMMANDS });
  for (const [i, l] of lines.entries()) for (const p of verifyCommandProblems(l)) throw new I18nError('环境准备命令第 {n} 条：{problem}', { n: i + 1, problem: p.replace(/^verify_command/, tl(contentLang(db), '命令')) });
  const argvs = lines.map((l) => l.split(/\s+/));
  return writeOne(db, { projectId, key: SETUP_KEY, value: argvs, userId, action: 'project_setup_set', payload: { commands: lines } });
}

/**
 * 在某份工作区里按顺序跑环境准备命令（沙箱里、可写、每条最多 10 分钟）。一条失败，**同一生态**后面的就不跑了（venv 建不起来还装什么包），
 * 但不连累别的生态：Python 那边失败，前端的 npm ci 照跑（否则 pip 一失败前端依赖就没装，回归里的前端构建报 vite: not found）。
 */
const familyOf = (argv) => { const f = String(argv[0] ?? '').split('/').pop(); return /^(python\d*(\.\d+)?|pip\d*)$/.test(f) ? 'py' : /^(npm|npx|pnpm|yarn|corepack)$/.test(f) ? 'node' : 'other'; };
export async function runSetupCommands(exec, dir, argvs, lang = 'zh') {
  const results = [], failed = new Set();
  for (const argv of argvs) {
    const fam = familyOf(argv);
    if (failed.has(fam) || failed.has('other')) { results.push({ argv, code: null, timedOut: false, tail: tl(lang, '（前面同类的一步失败了，这条没跑）'), skipped: true }); continue; }
    let r;
    try { r = await exec.execute({ file: argv[0], args: argv.slice(1) }, dir, { mode: 'write', timeoutMs: 600_000 }); }
    catch (e) { r = { code: null, stdout: '', stderr: String(e.message), timedOut: false }; }
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n').slice(-2000);
    results.push({ argv, code: r.code, timedOut: !!r.timedOut, tail });
    if (r.code !== 0) failed.add(fam);
  }
  return { ok: !failed.size, results };
}
/** 这组命令的指纹：命令改了，已经准备过的工作区要重跑一遍。自动识别的还带上依赖清单的内容 —— 清单改了（加了依赖）也要重跑。 */
export const setupFingerprint = (argvs, manifests = null) => JSON.stringify(manifests ? { argvs, manifests } : argvs);

/**
 * 从仓库里的依赖清单机械推出环境准备命令。
 * 支持的栈是写死的（前端 Vite/React 或纯 HTML、后端 Express 或 FastAPI、SQLite），所以这张表够用，不需要模型去猜：
 *   requirements*.txt / pyproject.toml → 仓库根建一个 .venv，装进去（.venv/bin 已在沙箱 PATH 最前）
 *   package.json → 有 package-lock.json 用 npm ci，没有用 npm install；子目录用 --prefix
 * 看仓库根和前后端常见的几个子目录。人在项目设置里填了命令的，以人填的为准（effectiveSetupOf）。
 */
export const SETUP_DIRS = ['', 'frontend', 'backend', 'client', 'server', 'web', 'api', 'app'];
const isPackagePyproject = (file) => { try { return /^\s*\[(project|build-system|tool\.poetry)\]\s*$/m.test(readFileSync(file, 'utf8')); } catch { return false; } };
export function detectSetupCommands(dir) {
  const argvs = [], manifests = {};
  if (!dir || !existsSync(dir)) return { argvs, manifests };
  const has = (rel) => existsSync(join(dir, rel));
  const note = (rel) => { try { manifests[rel] = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex').slice(0, 16); } catch { /* 读不到就不算 */ } };
  const reqs = [], pyprojects = [];
  for (const d of SETUP_DIRS) {
    const inDir = ['requirements.txt', 'requirements-dev.txt'].map((f) => posix.join(d, f)).filter(has);
    reqs.push(...inDir);
    // 只有声明了包的 pyproject 才 `pip install -e`：只放 pytest 配置的那种装不了（例：根目录一份 pytest 用的 pyproject，
    // backend/、frontend/ 并存 → "多个顶层包" 必然失败，还留下 UNKNOWN.egg-info/，并把后面的 npm ci 一起拦住）
    if (!inDir.length && has(posix.join(d, 'pyproject.toml')) && isPackagePyproject(join(dir, d, 'pyproject.toml'))) pyprojects.push(d);
  }
  if (reqs.length || pyprojects.length) {
    argvs.push(['python', '-m', 'venv', '.venv']);
    for (const r of reqs) { argvs.push(['.venv/bin/pip', 'install', '-r', r]); note(r); }
    for (const d of pyprojects) { argvs.push(['.venv/bin/pip', 'install', '-e', d || '.']); note(posix.join(d, 'pyproject.toml')); }
  }
  for (const d of SETUP_DIRS) {
    const pkg = posix.join(d, 'package.json');
    if (!has(pkg)) continue;
    const lock = posix.join(d, 'package-lock.json');
    const prefix = d ? ['--prefix', d] : [];
    // 没有锁文件时 --no-package-lock：环境准备是系统替人跑的，不该在工作区里生成一个没人提交过的锁文件
    // （比如根目录只有 npm workspaces 的 package.json：每个任务的工作区都会冒出 package-lock.json，
    // 验收前被判"有没提交的改动"、合并前被判"签收后还有改动"，一次次给人添事项）。要锁文件的任务自己会生成并提交它。
    argvs.push(has(lock) ? ['npm', 'ci', '--no-audit', '--no-fund', ...prefix] : ['npm', 'install', '--no-audit', '--no-fund', '--no-package-lock', ...prefix]);
    note(pkg); if (has(lock)) note(lock);
  }
  return { argvs, manifests };
}
/** 实际要跑的环境准备命令：人填了用人填的；没填就按这份目录里的依赖清单自动识别。 */
export function effectiveSetupOf(db, projectId, dir) {
  const manual = setupCommandsOf(db, projectId);
  if (manual.length) return { argvs: manual, source: 'manual', manifests: null };
  const d = detectSetupCommands(dir);
  return { argvs: d.argvs, source: 'auto', manifests: d.manifests };
}

/** 设"同时最多开几个任务"。1 = 回到串行。 */
export function setMaxOpen(db, { projectId, n, userId }) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > MAX_OPEN_CEILING) throw new I18nError('同时开着的任务上限要是 1 到 {max} 之间的整数（1 = 串行，一次只做一个）', { max: MAX_OPEN_CEILING });
  return writeOne(db, { projectId, key: MAX_OPEN_KEY, value: v, userId, action: 'project_max_open_set', payload: { n: v } });
}

/** 挂挡。挂自动挡时四条前提逐条查，缺哪条就把哪条的原话报回去。 */
export function setGear(db, { projectId, gear, userId, why = null }) {
  if (!GEARS[gear]) throw new I18nError('挡位无效：{gear}（应为 {list}）', { gear, list: Object.keys(GEARS).join(' / ') });
  if (gear === 'auto') {
    const missing = gearPrereqStatus(db, projectId).filter((p) => !p.ok);
    if (missing.length) {
      // 参数按内容语言填（报错模板由服务端按看的人的语言翻，参数翻不了）
      const L = contentLang(db);
      throw new I18nError('挂不上自动挡，还差 {n} 条前提：{list}', { n: missing.length,
        list: missing.map((m) => tl(L, '{label}（{why}）', { label: tlN(L, m.label), why: tlN(L, m.why) })).join(tl(L, '；')) });
    }
  }
  return writeOne(db, { projectId, key: GEAR_KEY, value: gear, userId, action: 'project_gear_set', payload: { gear, why } });
}

// ── 后置签收────────────────────────────────────────────────────────
// 自动挡下 **AI 自己加的**任务验收通过即合并，签收后置到交付前一次性做；**人加的任务仍逐个签收**。
// 判据每次现算（挡位 + 这个任务是不是 AI 自己加的），不缓存成一个状态位：挡位一掉回提议，
// 下一个完成的任务立刻恢复逐个签收 —— "自动挡"不是一个记在库里的开关，是四条前提的合取。
//
// **交付（push）永远要人点** —— 那是爆炸半径的真正边界，后置签收就挂在那一下上。

export const autoAdded = (db, taskId) => getParam(db, taskId, 'task.auto_added') === true;

/** 这个任务的签收该不该后置。 */
export function deferSignoff(db, taskId) {
  const pid = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;
  if (!pid) return false;
  if (gearOf(db, pid) !== 'auto') return false;
  if (gearPrereqStatus(db, pid).some((p) => !p.ok)) return false;   // 前提缺了就不是自动挡
  return autoAdded(db, taskId);
}

/** 这个项目里已合并、签收被后置、还没批量签掉的任务。 */
export const deferredSignoffs = (db, projectId) => db.all(
  `SELECT id, title, project_order, merged_at FROM tasks WHERE project_id=? AND project_order>0 ORDER BY project_order`, projectId)
  .filter((t) => getParam(db, t.id, 'signoff.status') === 'deferred');

// ── 撞闸 ──────────────────────────────────────────────────────────────────
/** 这个项目此刻有没有一条开着的预算闸事项（撞闸只报一次，别每轮弹一条）。 */
export const openBudgetQuestion = (db, projectId) => { const B = markLike('q.text', 'projectBudget'); return db.one(
  `SELECT q.id FROM questions q JOIN tasks t ON t.id=q.task_id
    WHERE t.project_id=? AND q.status IN ('open','escalated') AND ${B.sql} LIMIT 1`, projectId, ...B.params)?.id ?? null; };

/**
 * 撞闸 → 一条 Ⅲ 级事项。**全程零 LLM 调用**（与硬上限触顶同一条道理：钱花光了还要再花一次钱
 * 才能说出"钱花光了"，那闸门就有一个自指的洞）。已经有一条开着就不再提，返回已有的那条。
 *
 * 事项挂在**某个任务**上而不是项目上：questions 表是任务键的，而路由表按项目键 ——
 * 挂在这个项目的任一任务上，路由解析出来的收件人就是对的。优先挂撞闸的那个任务。
 */
export function raiseProjectBudget(db, { projectId, taskId = null }) {
  const exist = openBudgetQuestion(db, projectId);
  if (exist) return { questionId: exist, existed: true };
  const host = taskId ?? db.one(`SELECT id FROM tasks WHERE project_id=? ORDER BY COALESCE(project_order,0) DESC LIMIT 1`, projectId)?.id;
  if (!host) throw new Error(`项目 ${projectId} 没有任何任务，无处挂预算闸事项`);
  const L = contentLang(db);
  const b = budgetState(db, projectId);
  const p = db.one(`SELECT title FROM projects WHERE id=?`, projectId);
  const gear = gearOf(db, projectId);
  const t = now();
  const id = newId('q');
  const text = `${markOf(L, 'projectBudget')}${tl(L, '项目「{title}」已达预算闸：{state}。', { title: p?.title ?? projectId, state: b.human })}\n\n`
    + `${tl(L, '已经开着的任务会在下一轮停下来，不会再有新任务开工。已经花掉的钱要不回来。')}\n`
    + `${tl(L, '本事项由系统直接生成，未调用模型。')}\n\n`
    + (gear === 'auto' ? `${tl(L, '当前是**预算内自动开工、合并**挡 —— 闸门就是它的边界，撞到这里说明这个项目的目标比当初估的贵。')}\n\n` : '')
    + `${tl(L, '请选一条：')}\n`
    + `(A) ${tl(L, '提高闸门后继续：在项目设置的「预算与上限」里改，或运行 node src/cli.mjs project budget {id} --usd <新值>', { id: projectId })}\n`
    + `(B) ${tl(L, '中止项目：已合并的前缀仍可交付（node src/cli.mjs project deliver {id} --remote …）', { id: projectId })}\n`
    + `(C) ${tl(L, '撤掉闸门：node src/cli.mjs project budget {id} --clear（撤掉后自动挡会掉回提议挡）', { id: projectId })}\n\n`
    + tl(L, '已花 {spent}｜闸门 {gate}', { spent: fmtUsd(b.spent), gate: fmtUsd(b.gate) });
  return db.tx(() => {
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, id, host, text, t);
    // 出处边：这条事项因为哪一行闸门而存在（连带指向设它的人）。
    const origin = db.one(`SELECT id FROM params WHERE project_id=? AND task_id IS NULL AND key=? AND superseded_at IS NULL
                           ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, projectId, BUDGET_KEY)?.id;
    if (origin) insertEdge(db, id, origin, 'derived_from', t);
    routeQuestion(db, { questionId: id, decisionType: 'budget', typeSource: 'hard_rule', at: t });
    audit(db, { actorKind: 'system', action: 'project_budget_breached', targetType: 'project', targetId: projectId,
      payload: { questionId: id, taskId: host, ...b } });
    return { questionId: id, existed: false, text };
  });
}
