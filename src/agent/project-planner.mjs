// 项目规划器：把一份"完整规划"切成整批契约，人批一次。
//
// 与追问器（elicitor.mjs）同一套形状：模型只有一个出口 `propose_project`；产出被护栏（validateProjectSpec：契约齐全、
// 验收命令不经 shell）拒收就回灌重来；合规的落成任务（无工作区，守护进程不碰）+ 一条 Ⅲ 级批准问题；
// 人回 A / 反馈 / C，判"批准"不经模型（readVerdict）。批准 → 项目 active，advanceProject 现有的"没工作区就建"分支接管。
//
// 项目本身不能挂问题也不能记账（questions.task_id / usage_ledger.task_id 都 NOT NULL），所以每个从规划开始的项目
// 有一个 **order 0 的载体任务**：批准问题挂它、规划器的花费记它。projectTasks 把它滤掉，它不是契约。
//
// 批准前规划器**不提问**（问题要挂任务，而任务在提案之后才有）：拿不准的写进 notes，人在反馈里说。
// 这是目前的形状；要提问就得把载体任务提前建出来，等实际出现"不问就写不出契约"的案例再加。

import { applyEgressDefaults } from '../core/egress.mjs';
import { routeQuestion, specPrefixes } from '../core/routing.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, now, audit } from '../db/db.mjs';
import { toolCallsOf, textOf, truncatedEmpty, TruncatedEmptyError } from '../llm/canonical.mjs';
import { answerOf } from './elicitor.mjs';
import { reservationOf, readApproval, confirmBeforeRevising, feedbackOf, REACHED_LABELS } from './approval.mjs';
import { initProjectRepo, createProjectTasks, validateProjectSpec, renderRules, renderDeps, scopeOverlaps, renderScopeOverlaps, renderScopePaths, SCOPE_PATHS_NOTE, PROJECT_TASK_RUNTIME_MS } from '../core/project.mjs';
import { planAppend, appendStateOf, appendPending, startQueuedAppend } from './project-append.mjs';
import { decisionsSection, recordReservation } from '../core/decisions.mjs';
import { maxOpenOf, DEFAULT_MAX_OPEN } from '../core/project-settings.mjs';
import { getParam, setParam } from '../core/params.mjs';
import { diffSpecs, renderSpecDiff, roundHistory, renderRoundHistory } from './spec-diff.mjs';

const MAX_TASKS = 8;
// 完成 token 预算含推理（DeepSeek：reasoning_tokens ⊂ completion_tokens）。effort=high 曾把 8000 吃光、回空消息。只按实际用量计费。
const MAX_TOKENS = 24000;

const PROPOSE_PROJECT = {
  name: 'propose_project',
  description: `提交整批任务契约（首次规划 2 到 ${MAX_TASKS} 个）。任务之间按 depends_on 组织，系统一次执行一个。人会看到全文并批准 / 提修改 / 放弃。`,
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '项目一句话标题' },
      tasks: {
        type: 'array', minItems: 1, maxItems: MAX_TASKS,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '任务标题，带序号感，如 "T1 存储库"' },
            goal: { type: 'string', description: '目标：这一步要交付什么、给后面哪一步用' },
            scope: { type: 'string', description: '范围，写给人和实现方看的一段话：动哪些文件 / 不动哪些、为什么、不引入依赖等' },
            scope_paths: { type: 'array', items: { type: 'string' },
              description: '**同一个范围，用路径再写一遍**，机器按这一份执法。相对仓库根：目录写成 `src/store/`（结尾一条斜杠 = 含其下全部），具体文件写全名如 `package.json`。'
                + '把这个任务**要新建或要改**的都列上（新建的文件也列，不必已存在）；不许写绝对路径、`..`、通配符。'
                + '整个仓库都可能动就写 ["*"]，但那等于不设范围，非必要不要用。'
                + '⚠️ 这一份是**越界校验的判据**：没列上的文件，实现方改了会被机械撤销。宁可把该动的列全，也不要靠上面那段话兜底 —— 那段话不参与执法。' },
            definition_of_done: { type: 'string', description: '完成定义：**接口名写死**（文件名、导出名、子命令、字段名、退出码），可机械判定；后面的任务按这些名字引用' },
            rules: {
              type: 'array', minItems: 1,
              description: '完成定义里的每条**行为规则**单列一条，带出处。**一条只讲一件事**：一条规则里塞进多个分号分隔的断言会被拒，拆开写、各带各的出处。二选一：quote = 逐字引规划 / 规格原文里支撑它的那句（系统会机械核对是子串，且会核对规则与引文有共同字眼，挂一句不相干的原文会被拒）；assumption = 规格没写，说明你怎么定的、为什么。样例的期望串也算规则，同样要出处。',
              items: { type: 'object', properties: {
                rule: { type: 'string', description: '规则本身，一句话' },
                quote: { type: 'string', description: '规划 / 规格原文逐字引文（≥ 8 字）' },
                assumption: { type: 'string', description: '规格没写时：你定的依据' },
              }, required: ['rule'] },
            },
            constraints: { type: 'array', items: { type: 'string' }, description: '约束列表。后面的任务必须含"既有测试文件一行不许改、不许删"' },
            depends_on: { type: 'array', items: { type: 'integer' }, description: '本任务依赖的任务**编号**（它要用到那些任务的产物，它们合并后本任务才开工）。编号 = 任务清单里的序号：本草案的任务从"起始编号"起依次递增，已有任务用给你的清单上的编号。只能写已有任务或本草案里排在前面的任务。**不依赖任何任务就写 []**；不写这个字段 = 依赖前一个编号（线性）。只写真实的依赖：没有依赖关系的任务不要串起来 —— 多余的边会让无关的任务互相等' },
            blocks: { type: 'array', items: { type: 'integer' }, description: '（只在给已有项目添加任务时用，通常不需要）让某个**已有的、还没开工的**任务等本任务：写它的编号。只在人明确要求"先做这个再做那个"，或那个任务不先有本任务就做不成时用。不改那个任务的契约，只改先后' },
            verify_command: { type: 'string', description: '本任务自己的验收命令：**一条**命令，在工作区根目录直接执行（按空白切成 argv，不经 shell：不能有管道、&&、$( )、重定向、多行）。只写本任务新增的测试；前面任务的验收命令系统会自动累加，不要重复' },
          },
          required: ['title', 'goal', 'scope', 'scope_paths', 'definition_of_done', 'rules', 'constraints', 'verify_command'],
        },
      },
      notes: { type: 'string', description: '给人看的说明：你替人拍了哪些板、哪些点拿不准、为什么这样切' },
    },
    required: ['title', 'tasks', 'notes'],
  },
};

// 复盘时多出来的那个出口。**只有复盘用得上它** —— 首次规划与人发起的追加都不会带它进去：
// 那两种场合"已经达成"不是一个合法答案（人刚说了要做什么）。
const GOAL_REACHED = {
  name: 'project_goal_reached',
  description: '声明项目目标已经达成：全部任务已完成并合并，对照项目目标与完成定义已经没有该做的事。只在确实没有剩余工作时调用；完成定义里还有一条没兑现，就改用 propose_project 提下一批任务。',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: '**逐条**对照项目的完成定义说明它为什么已经兑现，每条指出是哪个任务的哪条完成定义兑现了它（用任务编号与契约里写死的名字）' },
      unverified: { type: 'array', items: { type: 'string' },
        description: '你**无法**从契约与完成定义确认的条目 —— 你看不到代码，凡是要读代码才能判断的都写在这里。没有就写 []。这一节会单独呈给人核对，写全比写少好' },
    },
    required: ['reason', 'unverified'],
  },
};

const SYSTEM = `你是一个长期运行的自主 agent 的"项目规划器"。人给了你一份规划（可能很完整，也可能只是几段话）和目标仓库的文件清单。
你的任务是把它切成若干份任务契约，并用 depends_on 写明它们之间的依赖。每份契约会被独立地规划、执行、机械验收、由人签收，然后合进项目分支；
一个任务要等它依赖的任务都合并后才开工，开工时从项目分支当时的头起（看得到此前已合并的全部代码）。系统一次只执行一个任务。

切法的规矩：
- 2 到 ${MAX_TASKS} 个任务，每个是一个实现方几小时内能做完、能用一条命令验收的单位。按"消费方"切：先做被依赖的库 / 接口，再做用它的东西。
- **接口名写死**：文件名、导出名、子命令名、字段名、退出码都写进完成定义。后面的任务只按这些名字引用前面的产物 —— 实现方看得到前面任务的代码，但契约不能靠"看代码猜"。
- **依赖要如实写**（depends_on，任务编号从 1 起）：B 用到 A 的接口 / 文件 → B 依赖 A；互不相干的任务（例如各自独立的模块、前端与后端各按同一份接口约定实现）**不要**互相依赖，写 []
  或只依赖它们共同的前置。把它们汇到一起的任务（集成 / 端到端）依赖它们全部。不确定就写上依赖 —— 多一条边只是慢，少一条边会让任务在缺东西的仓库上开工。
- 每个任务的 verify_command 只写自己新增的测试；任务开工时，系统会把当时已合并的全部任务的验收命令累加成它的回归义务。
- 从第二个任务起，约束里必须有这一条（原文照抄）："既有测试文件只许追加用例；唯一例外是断言了被本契约明确取代的中间行为的用例，可以改那一条并在交接记录里说明；其余一行不许改、不许删"。
- **不要把"尚未实现的行为"写进完成定义**（例如"本任务 X 节点抛 Error，下一任务再实现"）：实现方会把它写进测试，下一任务实现 X 时就与既有测试冲突。没实现的东西不提；要提也只放在说明里，明说"不要为它写断言"。
- 范围要写两遍：scope 用一段话写明动哪些、不动哪些、为什么；scope_paths 用路径把同一件事再写一遍（机器只认后者去执法，前者不参与）。不引入第三方依赖除非规划明说。
- **scope_paths 要把这个任务真正要碰的都列全**：要新建的文件也列（不必已存在）。目录写成 src/store/（结尾一条斜杠 = 含其下全部），具体文件写全名。两个互不依赖的任务尽量不要都列上同一个文件 —— 它们可能同时开着，撞在一起要回头问人取哪一侧。实在避不开（比如都要往根 package.json 的 scripts 里加一条），照实列，批准页会把这种重叠指出来让人决定。
- 完成定义里的每个行为样例都要带**精确的期望输出**（完整字符串 / 退出码 / 返回值），期望值要能在规格原文里找到出处。
  只给输入不给期望，实现方就会从自己的实现算期望写进测试，测试全绿而规格是错的。
- 样例**有上限**：每个任务 3 到 8 个，优先挑规格原文明确给出的、和容易做错的边角（行尾 \\r\\n、空输入、缺键、非字符串值……）。
  **不要穷举规格**，其余行为由实现方按规格原文写测试。规划是切任务、定接口、挑关键样例，不是替实现方把全部用例算一遍
  （按"先列全部前置 / 后置 / 边角"的版本，DeepSeek-v4-pro 的推理两次撞到 65536 上限、一个字都没写出来）。
- **每条行为规则要有出处**（rules 字段）：规格原文支撑的，quote 逐字引那句（系统会核对是规划文本的子串）；规格没写的，assumption 说明你怎么定的。
- 规划里**逐字段、逐接口写死的硬约束**（必填、可空、取值范围、默认值、状态码、排序）每一条都要落成一条规则，引那句原文；
  "可空"就写"可以省略，也可以传 null"（否则可空字段容易被实现成必填）。
- **一条规则只讲一件事**：宁可多列几条，也不要把"缺省值、非法值、边界"塞进一条用分号连起来 —— 一句引文支撑不了几件事，而执行方与验收员只看得到规则的字面，你省掉的那半句原文就永远到不了它们眼前。规则用原文的说法写，别改写关键词（原文写"不是正整数"就不要写成"非正整数"）。
  人批准时假设会单列一节。不要把自己的推断写成规格口吻的硬规则（"跨多行注释不按 standalone 处理"、
  "非字符串值用 String()"、"不要求支持 {{ name }}"，规格里没有一句支持，实现方照做，人批准时也没看出来）。规格没写又不影响接口的，宁可不写规则。
- 不切条件任务（"若有缺陷则修"）：修复靠每个任务的验收与重试。
- 拿不准的不要猜成硬约束：写进 notes，让人在反馈里定。
- 只调用 propose_project，不要输出别的文字。人对上一版的反馈会以"人的反馈"出现，按反馈出下一版。`;

/** 从规划文本建 proposed 项目：克隆仓库、开分支、建载体任务（order 0）。不调模型。 */
export function startProjectFromBrief(db, { userId, brief, source = null, home, base = null, title = null, empty = false }) {
  const text = String(brief ?? '').trim();
  if (!text) throw new Error('规划文本为空');
  const projectId = newId('pj');
  const { repo, branch, baseRef } = initProjectRepo({ home, projectId, source, base, empty });
  const t = now();
  const ttl = title?.trim() || text.split('\n')[0].trim().slice(0, 80);
  const carrierId = newId('t');
  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,draft_version,created_at) VALUES (?,?,?,?,?,?,?,?,'proposed',0,?)`,
    projectId, userId, ttl, text, repo, branch, baseRef, (source ? String(source) : null), t);
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at,project_id,project_order) VALUES (?,?,?,'planning',?,?,0)`,
    carrierId, userId, `项目规划：${ttl}`, t, projectId);
  audit(db, { actorKind: 'user', actorId: userId, action: 'project_created', targetType: 'project', targetId: projectId,
    payload: { title: ttl, repo, branch, baseRef, source: (source ? String(source) : null), proposed: true, carrier: carrierId, briefBytes: text.length } });
  applyEgressDefaults(db, { projectId, userId });   // 管理员勾过的默认放行源
  return { projectId, carrierId, repo, branch, baseRef };
}

export const carrierTask = (db, projectId) => db.one(`SELECT * FROM tasks WHERE project_id=? AND project_order=0`, projectId);

/** 仓库速览给模型：文件清单（最多 300 行）+ README 开头。规划器没有沙箱，看不到代码本身。 */
function repoGlance(repo) {
  let files = '';
  try { files = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).trim(); } catch { files = ''; }
  const list = files ? files.split('\n') : [];
  const shown = list.slice(0, 300).join('\n') + (list.length > 300 ? `\n… 共 ${list.length} 个文件` : '');
  let readme = '';
  for (const n of ['README.md', 'readme.md', 'README']) {
    const p = join(repo, n);
    if (existsSync(p)) { readme = readFileSync(p, 'utf8').split('\n').slice(0, 80).join('\n'); break; }
  }
  return `## 目标仓库文件清单\n${shown || '（空仓库）'}${readme ? `\n\n## README 开头\n${readme}` : ''}`;
}

/**
 * 批准页上那句调度规则。**这是它唯一一次主动出现在人眼前的地方** ——
 * 人正是在这一页上批准依赖关系，而"并列的两个任务会不会同时做"直接影响他怎么看那张图。
 * 所以它必须跟着同时开着的上限走：上限 > 1 时还写"同一时间只执行一个"，就是把错的那句给了负责人。
 */
export const schedLine = (maxOpen) => (maxOpen > 1
  ? `同时最多开着 ${maxOpen} 个任务：平时一次只做一个，只有开着的任务全都在等人（等你答题、等你签收）时，系统才会让独立的下一个先跑起来。`
  : '同一时间只执行一个任务。');
export function renderProposal(spec, version, notes, { maxOpen = DEFAULT_MAX_OPEN } = {}) {
  const L = [`【项目契约草案 v${version}】`, `项目：${spec.title}`, ''];
  spec.tasks.forEach((t, i) => {
    L.push(`${i + 1}. ${t.title}`, `   依赖：${renderDeps(t, i + 1, 1)}`, `   目标：${t.goal}`, `   范围：${t.scope}`, `   可动路径（判据）：${renderScopePaths(t.scope_paths)}`, `   完成定义：${t.definition_of_done}`);
    if (t.rules?.length) L.push(`   规则：${renderRules(t.rules).map((r) => `\n     - ${r}`).join('')}`);
    if (t.constraints?.length) L.push(`   约束：${t.constraints.map((c) => `\n     - ${c}`).join('')}`);
    L.push(`   验收命令：${t.verify_command}${i > 0 ? '（开工时系统会再累加当时已合并的全部任务的验收命令）' : ''}`, '');
  });
  L.push(SCOPE_PATHS_NOTE, '');
  // 假设单列：这一节是人批准前唯一该逐条核的地方 —— 引了规格原文的规则错不到哪去，臆造的都在这。
  const assumptions = spec.tasks.flatMap((t, i) => (t.rules ?? []).filter((r) => !String(r.quote ?? '').trim()).map((r) => `T${i + 1} · ${r.rule}（${r.assumption}）`));
  if (spec.tasks.some((t) => t.rules?.length)) {
    L.push(assumptions.length ? `⚠ 规划器假设（规格没写、规划器定的，共 ${assumptions.length} 条；批准即认可，不同意就在反馈里改）：${assumptions.map((a) => `\n  - ${a}`).join('')}` : '规划器假设：无（每条规则都引了规格原文）', '');
  }
  // 范围重叠预警。只在上限 > 1（真会同时开着）时给 —— 串行下这条提示是噪声。
  const overlaps = maxOpen > 1 ? renderScopeOverlaps(scopeOverlaps(spec)) : null;
  if (overlaps) L.push(overlaps, '');
  if (notes) L.push(`规划器说明：${notes}`, '');
  L.push(`每个任务的硬上限：累计运行时长 ${Math.round(PROJECT_TASK_RUNTIME_MS / 3600000)} h（其余按默认）；批准后可用 cli limit <taskId> 改。`, '');
  L.push(`批准后会自动逐个规划、执行：一个任务要等它依赖的任务都签收并合并后才开工；每个任务做完你签收一次。${schedLine(maxOpen)}依赖关系不对，直接在反馈里说（例如"3 不依赖 2"）。请回复：`, '(A) 批准 —— 回 "A" 或 "批准"', '(B) 要改 —— 直接写要改什么，会出下一版', '(C) 放弃 —— 回 "C" 或 "放弃"', '(D) 批准，但留一句保留意见 —— **它不挡任何东西**：这一批照样全部生效，效果与 (A) 一模一样。它只把你那句话留在项目的约定清单上、标成〔保留意见〕，让下一个碰这一处的人看得到。要**挡住**其中某一条，只能 (B) 说清哪一条不要、让它重出一版。写法：先回 A，**另起一行**写「保留：…」。');
  return L.join('\n');
}

/**
 * 规划器的一次寿命。返回 { kind: 'proposed'|'approved'|'abandoned'|'noop'|'failed', ... }。
 */
export async function planProject(db, { client, projectId, tier = 'heavy', maxAttempts = 3 }) {
  const p = db.one(`SELECT * FROM projects WHERE id=?`, projectId);
  if (!p) throw new Error(`没有这个项目：${projectId}`);
  const appending = p.status !== 'proposed' && appendPending(appendStateOf(db, projectId));   // 给在跑的项目追加尾部任务，同一个入口、同一对起止审计
  if (p.status !== 'proposed' && !appending) return { kind: 'noop', why: `项目 ${p.status}` };
  const carrier = carrierTask(db, projectId);
  if (!carrier) throw new Error('这个项目不是从规划开始的（没有载体任务），用 project new --file');

  const startedAt = now();
  audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_planner_started', targetType: 'project', targetId: projectId,
    payload: { pid: process.pid, tier, version: p.draft_version } });
  const exit = (kind, extra = {}) => {
    audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_planner_exit', targetType: 'project', targetId: projectId,
      payload: { pid: process.pid, kind, elapsedMs: now() - startedAt, ...extra } });
    return { kind, ...extra };
  };
  if (carrier.status === 'running') db.run(`UPDATE tasks SET status='planning' WHERE id=?`, carrier.id);

  try {
    if (appending) {
      const r = await planAppend(db, { client, project: p, tier, maxAttempts, tool: PROPOSE_PROJECT, doneTool: GOAL_REACHED, repoGlance });
      // 这一轮结束了（批准 / 放弃）→ 排着队的下一条需求开起来。达成（reached）不在这里出队：
      // 那一步还要 advanceProject 跑项目级验收、宣布完成，先出队会把"达成"盖掉 —— 在那边完成之后再出队。
      if (['approved', 'abandoned'].includes(r.kind)) { const q = startQueuedAppend(db, { projectId }); if (q) r.nextQueued = q; }
      const { kind, text, ...rest } = r;
      exit(kind, { append: true, ...rest });
      return r;
    }
    let feedback = null;
    if (p.draft_question) {
      const q = db.one(`SELECT status FROM questions WHERE id=?`, p.draft_question);
      if (q && ['open', 'escalated'].includes(q.status)) return exit('noop', { why: '草案等人批' });
      const a = answerOf(db, p.draft_question);
      if (!a) return exit('noop', { why: '草案等人批，但找不到答复' });
      const verdict = readApproval(db, { taskId: carrier.id, questionId: p.draft_question, body: a.body, userId: a.sender_id, version: p.draft_version });
      if (verdict === 'approve') {
        db.run(`UPDATE projects SET status='active' WHERE id=?`, projectId);
        db.run(`UPDATE tasks SET status='done' WHERE id=?`, carrier.id);
        // 批准时带的保留意见记进约定清单
        const resv = reservationOf(a.body);
        if (resv) recordReservation(db, { projectId, subject: `批准项目契约草案 v${p.draft_version} 时的保留意见`, text: resv, sourceKind: 'contract', sourceId: p.draft_question, by: a.sender_id });
        audit(db, { actorKind: 'user', actorId: a.sender_id, action: 'project_approved', targetType: 'project', targetId: projectId,
          payload: { version: p.draft_version, questionId: p.draft_question, answer: String(a.body).slice(0, 200), reservation: resv ? resv.slice(0, 200) : null } });
        return exit('approved', { version: p.draft_version });
      }
      if (verdict === 'abandon') {
        db.run(`UPDATE projects SET status='aborted' WHERE id=?`, projectId);
        db.run(`UPDATE tasks SET status='aborted' WHERE project_id=?`, projectId);
        audit(db, { actorKind: 'user', actorId: a.sender_id, action: 'project_abandoned', targetType: 'project', targetId: projectId,
          payload: { version: p.draft_version, questionId: p.draft_question, answer: String(a.body).slice(0, 200) } });
        return exit('abandoned');
      }
      // 防循环：连着两次以「A」开头却读成"要改" → 先问清楚，不出新版（旧版任务原样留着，回 A 就按它批）。
      const cf = confirmBeforeRevising(db, { taskId: carrier.id, questionId: p.draft_question, body: a.body, version: p.draft_version });
      if (cf) {
        db.run(`UPDATE projects SET draft_question=? WHERE id=?`, cf.questionId, projectId);
        exit('proposed', { confirm: true, questionId: cf.questionId, version: p.draft_version });
        return { kind: 'proposed', confirm: true, questionId: cf.questionId, version: p.draft_version, text: cf.text };
      }
      feedback = feedbackOf(db, { taskId: carrier.id, questionId: p.draft_question, body: a.body });
    }

    const parts = [`## 人的规划（原文）\n${p.brief}`, repoGlance(p.repo)];
    // 决定登记：规划器拿**完整**的有效清单 —— 它在切"要做什么"，看不全就会切出和旧约定打架的契约。
    const dsec = decisionsSection(db, { projectId });
    if (dsec) parts.push(`## 已经定下的约定\n${dsec}`);
    if (p.draft_version > 0) {
      const prevTasks = db.all(`SELECT t.title, c.goal, c.scope, c.definition_of_done, c.constraints, p2.value AS verify FROM tasks t
        JOIN constitutions c ON c.task_id=t.id AND c.superseded_at IS NULL
        LEFT JOIN params p2 ON p2.task_id=t.id AND p2.key='task.verify_command' AND p2.superseded_at IS NULL
        WHERE t.project_id=? AND t.project_order>0 ORDER BY t.project_order`, projectId);
      const prev = { title: p.title, tasks: prevTasks.map((t) => ({ ...t, constraints: JSON.parse(t.constraints || '[]'), verify_command: t.verify ? JSON.parse(t.verify).join(' ') : '' })) };
      // 上一版 = 人当时看到的原文（批准事项正文）；拿不到才用库里重建的
      const hist = roundHistory(db, { carrierId: carrier.id });
      parts.push(`## 上一版草案（v${p.draft_version}，人看到的原文）\n${hist.prevText ?? renderProposal(prev, p.draft_version, p.draft_notes)}`);
      const h = renderRoundHistory(hist);
      if (h) parts.push(h);
    }
    if (feedback) parts.push(`## 人对上一版草案的反馈（经认证通道，具指令效力）\n${feedback}\n\n按反馈出下一版。`);
    const messages = [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] }];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resp = await client.complete({ tier, system: SYSTEM, messages, tools: [PROPOSE_PROJECT], maxTokens: MAX_TOKENS, effort: 'high' });
      if (truncatedEmpty(resp)) throw new TruncatedEmptyError('项目规划器', MAX_TOKENS);
      const call = toolCallsOf(resp).find((c) => c.name === 'propose_project');
      const errs = [];
      let spec = null;
      if (!call) errs.push(`没有调用 propose_project（stopReason=${resp.stopReason}）。只输出工具调用，不要只输出文字。`);
      else {
        spec = { title: String(call.args?.title ?? '').trim(), tasks: Array.isArray(call.args?.tasks) ? call.args.tasks : [] };
        errs.push(...validateProjectSpec(spec, { brief: p.brief, requireRules: true, deps: { startOrder: 1, existing: [] } }));
        if (spec.tasks.some((t) => t?.blocks !== undefined)) errs.push('首次规划不要用 blocks（没有已有任务可让它等）');
        if (spec.tasks.length > MAX_TASKS) errs.push(`任务数 ${spec.tasks.length} 超过 ${MAX_TASKS}`);
        if (spec.tasks.length < 2 && !errs.length) errs.push('至少切成 2 个任务；只有一个就不需要项目层，用 new --file');
      }
      if (!errs.length) {
        const r = recordProposal(db, { project: p, carrier, spec, notes: String(call.args?.notes ?? ''), prevSpec: p.draft_version > 0 ? getParam(db, carrier.id, 'plan.spec') : null });
        return exit('proposed', { ...r, attempts: attempt });
      }
      audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_plan_attempt', targetType: 'project', targetId: projectId,
        payload: { attempt, rejections: errs, say: textOf(resp).slice(0, 600) || null, stopReason: resp.stopReason } });
      if (attempt === maxAttempts) throw new Error(`项目规划器 ${maxAttempts} 次都没给出合规契约：${errs.join('；')}`);
      messages.push({ role: 'assistant', content: resp.content });
      if (call) messages.push({ role: 'tool_results', results: [{ callId: call.id, name: call.name, isError: true, content: `被拒：\n- ${errs.join('\n- ')}` }] });
      else messages.push({ role: 'user', content: [{ type: 'text', text: errs[0] }] });
    }
    throw new Error('unreachable');
  } catch (e) {
    exit('failed', { error: String(e.message).slice(0, 300) });
    throw e;
  }
}

/** 草案落库：旧契约任务作废并脱钩，新一批建好（无工作区），Ⅲ 级批准问题挂载体任务。 */
function recordProposal(db, { project, carrier, spec, notes, prevSpec = null }) {
  const t = now();
  const version = project.draft_version + 1;
  const qid = newId('q');
  let text = renderProposal(spec, version, notes, { maxOpen: maxOpenOf(db, project.id) });
  // 和上一版逐字比对：少了的任务 / 约束 / 规则写在标题行下面
  if (prevSpec) { const i = text.indexOf('\n'); text = `${text.slice(0, i + 1)}${renderSpecDiff(diffSpecs(prevSpec, spec), { prevVersion: project.draft_version })}${text.slice(i + 1)}`; }
  const old = db.all(`SELECT id FROM tasks WHERE project_id=? AND project_order>0`, project.id).map((r) => r.id);
  if (old.length) {
    db.run(`UPDATE tasks SET status='aborted', project_id=NULL, project_order=NULL WHERE project_id=? AND project_order>0`, project.id);
    audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_tasks_voided', targetType: 'project', targetId: project.id,
      payload: { version: project.draft_version, tasks: old } });
  }
  const taskIds = createProjectTasks(db, { projectId: project.id, userId: project.owner_id, tasks: spec.tasks });
  db.tx(() => {
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`, qid, carrier.id, text, t);
    routeQuestion(db, { questionId: qid, decisionType: 'contract_approval', typeSource: 'hard_rule', prefixes: specPrefixes(spec.tasks).length ? specPrefixes(spec.tasks) : null, at: t });
    db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, carrier.id);
    db.run(`UPDATE projects SET title=?, draft_version=?, draft_question=?, draft_notes=? WHERE id=?`, spec.title, version, qid, notes, project.id);
    setParam(db, { taskId: carrier.id, key: 'plan.spec', value: spec, by: { kind: 'agent', id: 'project_planner' }, governance: 'execution' });   // 下一版逐字比对用
    audit(db, { actorKind: 'agent', actorId: 'project_planner', action: 'project_proposed', targetType: 'project', targetId: project.id,
      // 报过哪几对范围重叠也进审计：这条预警**不是闸门**，所以"它有没有被略过"只能事后查 ——
      // 拿这里记下的对，对着人的批准答复看有没有对应的动作。
      payload: { version, questionId: qid, title: spec.title.slice(0, 120), tasks: taskIds, overlapsWarned: scopeOverlaps(spec) } });
  });
  return { version, questionId: qid, text, tasks: taskIds };
}

/**
 * `planProject` 一次寿命的人看得懂的输出。
 *
 * 为什么是一个**被测函数**而不是 cli.mjs 里的几行 console.log：那几行是这些返回形状的
 * **唯一读者**，没有任何测试读它们。例如 `decisionId` 改成 `decisionIds` 后，
 * cli 那一行还在读旧名；又如 `kind:'proposed'` 从新建项目那条路来时带
 * `tasks`，从追加 / 复盘那条路来时不带，而 cli 无条件读 `r.tasks.length`。
 * 结果：**追加与复盘每出一版草案，`project plan` 必崩**，而且崩得完全看不出来 ——
 * 库里该写的都写完了、事项也发出去了，只有那一行打印炸掉，退出码非零。
 *
 * 所以这里一律走 `??` 与显式分支，并且 `reached`（达成确认）与 `proposed`（契约草案）
 * 不能印同一句话 —— 达成确认里本来就没有任务。
 */
export function renderPlanOutcome(r, { projectId }) {
  const out = [];
  if (r.kind === 'proposed' && r.confirm) {
    out.push(`\n没出新版：连着两次以「A」开头却读成"要改"，先挂了一条确认事项 ${r.questionId}：\n`);
    out.push(String(r.text ?? '').split('\n').map((l) => `  ${l}`).join('\n'));
  } else if (r.kind === 'proposed' && r.reached) {
    out.push(`\n项目达成确认 v${r.version} 已出（Ⅲ 级批准问题 ${r.questionId}）：\n`);
    out.push(String(r.text ?? '').split('\n').map((l) => `  ${l}`).join('\n'));
    out.push(`\n回复：node src/cli.mjs answer ${r.questionId} "A"   （确认达成；或直接写还差什么 / "C" 先放着）`);
  } else if (r.kind === 'proposed') {
    const n = r.tasks?.length ?? null;
    out.push(`\n项目契约草案 v${r.version} 已出（${n === null ? '任务清单见下' : `${n} 个任务`}；Ⅲ 级批准问题 ${r.questionId}）：\n`);
    out.push(String(r.text ?? '').split('\n').map((l) => `  ${l}`).join('\n'));
    out.push(`\n回复：node src/cli.mjs answer ${r.questionId} "A"   （或直接写要改什么 / "C" 放弃）`);
  } else if (r.kind === 'approved') {
    out.push(`\n✅ ${r.review ? '复盘给出的这一批' : `草案 v${r.version}`}已批准${r.auto ? '（自动挡，没经人手）' : ''}，项目 active。`
      + `守护进程会建第一个工作区并规划开跑；没开守护进程：node src/cli.mjs project advance ${projectId}`);
    if (r.auto && r.tasks?.length) out.push(`  自动开工的任务：${r.tasks.length} 个，从 #${r.startOrder ?? '?'} 起。签收会攒着，交付前一次签掉。`);
  } else if (r.kind === 'reached') {
    out.push(`\n✅ 项目达成已确认。接下来会跑项目级验收命令，过了才宣布完成。`);
  } else if (r.kind === 'abandoned') {
    out.push(`\n已按你的答复放弃：${r.why ?? '项目 aborted'}。`);
  } else {
    out.push(`\n没事可做：${r.why ?? r.kind}`);
  }
  return out;
}
