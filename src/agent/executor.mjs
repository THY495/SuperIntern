// 节点执行器 —— 第二个 LLM 子程序，也是第一个真正会**动手**的角色。
//
// 三件事在这里接上：
//   ① 状态 → 上下文：装配层从库里读，不接受内存传递
//   ③ 脑 → 手：Executor 接口（LocalExecutor，或容器里的 ContainerExecutor）
//   交接：完成的定义不是"模型说做完了"，是产物就绪 + 交接记录过库层触发器
//
// 规划器那边的教训在这里直接落地：**给两个出口**。只留 submit_handoff 一个出口，
// "这个节点做不下去"就只剩伪造完成这一条路——而伪造完成比伪造规划危险得多，
// 它会带着一份假的交接记录污染整条下游链。

import { routeQuestion, decisionTypeOfQuestion, prefixesOf, scopeFilesOf, scopePathsOf } from '../core/routing.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runToolLoop } from '../llm/client.mjs';
import { textOf } from '../llm/canonical.mjs';
import { newId, now, audit, insertEdge } from '../db/db.mjs';
import { assembleExecutor } from '../context/assemble.mjs';
import { LocalExecutor, classifyCommand } from '../core/executor.mjs';
import { raiseEgressQuestion, sourceOf, hostProblem } from '../core/egress.mjs';
import { changedSince, nodeBaseline, clearNodeBaseline, isBuildOutput } from '../core/workspace.mjs';
import { isInfraError } from '../core/errors.mjs';
import { timeoutFor } from '../core/timeouts.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════════════════════

export const TOOLS = [
  { name: 'list_dir', description: '列目录内容。先看再动，不要凭记忆猜工作区里有什么。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作区根的路径，默认 "."' } } } },
  { name: 'read_file', description: '读文件全文。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write_file', description: '写文件（整体覆盖）。目录不存在会自动建。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'] } },
  { name: 'grep', description: '在工作区里按正则搜内容，返回 文件:行号:内容。',
    parameters: { type: 'object', properties: {
      pattern: { type: 'string' }, path: { type: 'string', description: '限定子目录，默认全工作区' },
      glob: { type: 'string', description: '文件名后缀过滤，如 ".mjs"' } }, required: ['pattern'] } },
  { name: 'run_command', description: '在工作区里跑一条命令。参数是 argv 不是 shell 字符串，不做 shell 展开。',
    parameters: { type: 'object', properties: {
      file: { type: 'string', description: '可执行文件名，如 "node"、"git"' },
      args: { type: 'array', items: { type: 'string' } },
      timeout_s: { type: 'integer', description: '这条命令最多跑多少秒，默认 120，最多 600。装依赖（npm install、pip install）这类慢命令才需要调大；到点会被杀掉。' } }, required: ['file'] } },
  { name: 'submit_handoff',
    description: '节点做完时调用，提交交接记录。**产物路径必须真实存在**，会被逐个核对。',
    parameters: { type: 'object', properties: {
      artifacts: { type: 'array', description: '本节点的产出物。'
        + '**本节点该交的东西已经被上游节点做掉了**（不是你偷懒，是计划重叠）时：照样把它们列进来，'
        + '每条加 `already_done: true` 与 `produced_by`（哪个节点 / 哪个 commit 做的），'
        + '并在 acceptance_evidence 里给出你核实它满足本节点验收标准的证据。'
        + '**不要为了凑一个 diff 去做规格没要求的改动。**',
        items: { type: 'object', properties: { path: { type: 'string' }, kind: { type: 'string' },
          already_done: { type: 'boolean', description: '这条产物在本节点开跑前就已存在且满足本节点的验收标准' },
          produced_by: { type: 'string', description: '已存在的产物是谁做的：上游节点标题 / id，或那次提交的 commit' } },
        required: ['path'] } },
      interface_contract: { type: 'string', description: '下游要照着用的契约：导出了什么、签名是什么、行为边界在哪' },
      key_decisions: { type: 'array', description: '关键决策，会进决策日志并挂出处边',
        items: { type: 'object', properties: { summary: { type: 'string' }, rationale: { type: 'string' } },
          required: ['summary', 'rationale'] } },
      assumptions: { type: 'array',
        description: '你做出的假设。**每条都必须交代你打算对着谁查证它** —— '
          + '查得了的东西不许假设，去查；查不了的才是假设。'
          + '查过之后确认根本没有出处的，那不是假设是**选择**：照样记在这里（settled_by_me），'
          + '但要说清你选了什么、代价是什么。真正需要人拍板的（不可逆、对外承诺、规格自相矛盾、契约规则与它所附的〔规格〕原文矛盾）走 raise_question。',
        items: { type: 'object', properties: {
          subject_key: { type: 'string', description: '归一化主题键，如 "sse.parser.location"，冲突比对靠它' },
          statement: { type: 'string' },
          verified_against: { type: 'string',
            enum: ['spec', 'vendor_docs', 'command', 'repo_findings', 'own_artifact', 'blocked', 'settled_by_me'],
            description: '这条陈述的真值对着什么可以查证：'
              + 'spec=外部规范原文；vendor_docs=厂商官方文档；command=跑一条命令就知道（git diff / 跑测试 / node -e）；'
              + 'repo_findings=本仓库已记录的实测结论（grep 仓库里的 FINDINGS.md、docs/ 等实测记录）；'
              + 'own_artifact=只能对着本任务自己造出来的东西验（那是循环论证，不算查证过）；'
              + 'blocked=有真相源但此刻够不着（缺 key、禁网、太贵）；'
              + 'settled_by_me=我查过了，仓库/规格/文档对此**沉默**，所以这不是事实而是我做的一个选择。'
              + '这一条不阻塞、不丢人，但会强制披露给人看——**不要为了躲开它去硬凑一个 command 凭据**，'
              + '拿"测试没覆盖所以随便选都能过"当凭据是不算数的：那验的是测试不覆盖，不是这个选择对。' },
          verification: { type: 'string',
            description: 'spec/vendor_docs/command/repo_findings：写出你**已经跑过**的命令与关键输出，'
              + '或引用到的规范/文档/FINDINGS 原文。blocked：写清卡在什么上、要什么条件才能验。'
              + 'own_artifact：写清你是对着哪个自己造的文件验的。'
              + 'settled_by_me：写清你**查过哪些地方**确认没有出处、你选了什么、以及选错的代价是什么。' },
          must_disclose: { type: 'boolean',
            description: '这条即便不阻塞，人也必须看见吗？覆盖面缺口、与规格不符的已知偏差、'
              + '循环验证的结论，都填 true。' },
        }, required: ['subject_key', 'statement', 'verified_against', 'verification'] } },
      known_issues: { type: 'array', items: { type: 'string' } },
      downstream_notes: { type: 'string' },
      acceptance_evidence: { type: 'string', description: '验收标准成立的机械证据：跑了什么命令、退出码多少、输出关键行' },
    }, required: ['artifacts', 'interface_contract', 'acceptance_evidence'] } },
  { name: 'raise_question',
    description: '节点做不下去时调用：规格自相矛盾、需要人拍板的取舍、缺少你无权决定的信息。'
      + '不要用它问你自己查得到的事。**编一个能过验收的假完成，比停下来问坏得多。**\n'
      + '⚠️ 调用它之后你这次的上下文就没了。人可能几分钟后回答，也可能三天后——'
      + '到那时接手的是一个**全新的你**，只能看见状态库里的东西。'
      + '所以 work_done / plan_after_answer 是写给那个人看的，不是走过场。',
    parameters: { type: 'object', properties: {
      level: { type: 'integer', enum: [1, 2, 3],
        description: 'Ⅰ=有明确默认动作；Ⅱ=可回退的选择，需人拍板；Ⅲ=不可逆或对外承诺，无默认、无限期等待' },
      text: { type: 'string', description: '问题本身，要让没有上下文的人也能回答。'
        + '**不要把"授权我改 scope / 改契约"写成一个答复就能落实的选项**：答复不是契约，scope 只能由人发一条计划变更来改；'
        + '照一句授权去动范围外的文件，交接时会被机械校验判越界并撤销，于是又回到这条问题上。'
        + '要给的是：现有范围内可行的出路，以及（若确实只能改契约）说明要改哪一条、改成什么。' },
      default_action: { type: 'string', description: '仅 Ⅰ/Ⅱ 级填' },
      blocked_by: { type: 'string', description: '被规格/验收标准里的哪一条卡住，原文引用' },
      kind: { type: 'string', enum: ['spec', 'structural'],
        description: 'spec=规格没写清、要人取舍；structural=规格 / 契约 / 依赖之间自相矛盾，改一处才能继续。决定问题路由给谁' },
      // ↓ 复工简报三段。挂起分支不冷冻上下文，这三段就是**全部**留下来的东西。
      work_done: { type: 'string',
        description: '到此刻为止真的做完了什么：读过哪些文件得出什么结论、写了哪些文件、'
          + '跑过什么命令结果如何。已落盘的产物要列路径——复工的人只能看见库和工作区。' },
      plan_after_answer: { type: 'string',
        description: '拿到答案之后打算怎么做。按答案的每种可能分别写，别只写一种。' },
    }, required: ['level', 'text', 'blocked_by', 'work_done', 'plan_after_answer'] } },
  { name: 'request_egress',
    description: '请求联网：要么是联网目录里的某个源（上下文「网络」一节列了可以申请的），要么是一个被拦的具体域名。'
      + '沙箱默认断网；被拦的表现是 403（CONNECT 阶段或请求阶段），或者（完全断网时）DNS 解析失败。\n'
      + '⚠️ 目录里已有覆盖它的源时填源的 id，不要填单个域名 —— 一个生态的出口往往不止一个域（pip 的元数据与下载就分属两个域）。\n'
      + '⚠️ 目录里没有的域名也可以填，但要不要加进目录由管理员决定。\n'
      + '⚠️ 不要用它来"顺手多要一点"：每一次放行都扩大了沙箱内代码能把数据发去的范围。'
      + '先确认这个节点真的做不下去，再要。\n'
      + '⚠️ 调用它之后你这次的上下文就没了，和 raise_question 一样 —— '
      + 'work_done / plan_after_answer 是写给复工时那个全新的你看的。',
    parameters: { type: 'object', properties: {
      group: { type: 'string',
        description: '联网目录里某个源的 id（如 npm、pypi），或一个被拦的具体域名（如 docs.python.org）。' },
      why: { type: 'string',
        description: '为什么这个节点没有它就做不下去。写清你已经试过什么、被拒在哪一步。'
          + '人会拿这段话与审计轨里的被拒记录对照 —— 对不上会被看见。' },
      work_done: { type: 'string', description: '到此刻为止真的做完了什么（同 raise_question）。' },
      plan_after_answer: { type: 'string', description: '放行之后打算怎么做；**以及不放行的话打算怎么做**。' },
    }, required: ['group', 'why', 'work_done', 'plan_after_answer'] } },
];

/** read_file 单次返回上限（字符）。约 12k token：够读任何一个源文件，读不了 lock 文件。 */
export const READ_FILE_MAX_CHARS = 40_000;

/** 工具实现。全部经 Executor 走，路径约束落在一处。 */
export function makeHandlers(exec, workspace, trace) {
  const log = (name, args, result) => { trace.push({ name, args, result: String(result).slice(0, 4000) }); return result; };
  return {
    list_dir: async (a) => log('list_dir', a, exec.listDir(workspace, a.path || '.').join('\n') || '(空目录)'),
    // ⚠️ 读文件有上限。曾出现过 agent 一口气 read_file 了 187 KB 的 package-lock.json，
    // 一轮吃掉约 60k token，第 19 轮撞上 limit.context_tokens（150k）整个节点作废。
    // run_command 早就有 maxOutputBytes（64 KB），read_file 没有 —— 同一个洞，另一扇门。
    read_file: async (a) => {
      const text = exec.readFile(workspace, a.path);
      if (text.length <= READ_FILE_MAX_CHARS) return log('read_file', a, text);
      const head = text.slice(0, READ_FILE_MAX_CHARS);
      return log('read_file', a, `${head}\n\n[系统] 文件共 ${text.length} 字符，只返回了前 ${READ_FILE_MAX_CHARS} 字符。`
        + `这种体量的文件（lock 文件、生成物、数据）整读会把上下文吃光 —— 用 grep 定位，或换更小的目标。`);
    },
    write_file: async (a) => {
      exec.writeFile(workspace, a.path, a.content);
      return log('write_file', { path: a.path, bytes: a.content.length }, `已写入 ${a.path}（${a.content.length} 字节）`);
    },
    grep: async (a) => {
      const re = new RegExp(a.pattern, 'gm');
      const hits = [];
      const walk = (rel) => {
        for (const e of exec.listDir(workspace, rel)) {
          const name = e.replace(/\s+\d+B$/, '').replace(/\/$/, '');
          const child = rel === '.' ? name : `${rel}/${name}`;
          if (e.endsWith('/')) { walk(child); continue; }
          if (a.glob && !name.endsWith(a.glob)) continue;
          let text; try { text = exec.readFile(workspace, child); } catch { continue; }
          text.split('\n').forEach((line, i) => {
            re.lastIndex = 0;
            if (re.test(line) && hits.length < 200) hits.push(`${child}:${i + 1}:${line.trim().slice(0, 200)}`);
          });
        }
      };
      walk(a.path || '.');
      return log('grep', a, hits.join('\n') || '(无匹配)');
    },
    run_command: async (a) => {
      // 写边界的分类。LocalExecutor 里它只留证不拦截；ContainerExecutor 把它
      // 变成真的挂载视图（read-only 的命令跑在只读挂载上，写下去内核直接拒）。
      //
      // ⚠️ 分类**不再在这里写死**。原来这里是 `/^(node|git|ls|cat|type)$/`，
      // 把 `node` 和 `git` 判成只读 —— 通用解释器和通用版本控制什么都能写。
      // 那条规则不接挂载时错了也没人疼，一旦接上挂载就是个真洞。
      // 现在统一走 classifyCommand（默认 write，只有真的干不了写的才免批）。
      // 超时可由 agent 调：固定 120 秒时，经出口代理的一次稍大的 npm install / pip install
      // 会被杀掉，重试多少次都一样。上限 600 秒（与项目级验收同一个数），整体仍受任务时长上限约束。
      const t = Number(a.timeout_s);
      const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(600, Math.max(1, Math.round(t))) * 1000 : undefined;
      const r = await exec.execute({ file: a.file, args: a.args ?? [] }, workspace,
        { mode: classifyCommand(a.file), ...(timeoutMs ? { timeoutMs } : {}) });
      // 只读视图下失败时要说清是哪种失败。不说的话，一个 EROFS 会被读成
      // "我的代码有 bug"，模型就去改代码——而真正的信息是"这条命令被判成了只读"。
      const roNote = r.mode === 'read-only' && r.code !== 0
        ? `\n[系统] 这条命令被判为只读，跑在工作区的**只读视图**上，写操作会失败。`
          + `确实需要写的话，换一个会写的可执行文件（如 node）来做。` : '';
      const body = `exit=${r.code}${r.timedOut ? '（超时被杀）' : ''}${r.truncated ? '（输出被截断）' : ''}${roNote}\n`
        + `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
      return log('run_command', a, body);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 交接记录：校验 → 落库 → 过触发器
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 交接记录校验。**形状之外还核实物**：artifacts 里的每条路径都要在工作区里
 * 真实存在。这是"完成用机械判据"的落点——模型说产出了什么不算数，
 * 文件在不在算数。
 */
export const ALWAYS_IN_SCOPE = new Set(['si-preview.json']);
// 依赖清单与 .gitignore 不受范围限制：曾出现过 AI 发现 requirements.txt 缺 uvicorn、
// frontend/dist/ 被提交进了仓库，两次都因为"边界外"只披露没修 —— 前者让截图拍到报错页、交付的清单起不来后端，
// 后者只能靠人介入。这两类文件是仓库卫生，不是任务的产物；放开它们不放开任何业务代码。
export const alwaysInScope = (p) => ALWAYS_IN_SCOPE.has(p)
  || /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|package\.json|package-lock\.json|\.gitignore)$/.test(p)
  || isBuildOutput(p);   // 把已提交的构建产物从跟踪里摘掉（git rm --cached）也是仓库卫生
export function validateHandoff(args, { exec, workspace, changed, scopePrefixes = null, scopeFiles = [], scopeStructured = false }) {
  const errs = [];
  // scope 机械执法（写边界的任务级形式）：宪法块 scope 里抽得出目录前缀时，相对基线的每一处改动
  // 都必须落在某个前缀之下；越界即打回 —— 撤销这些改动，或用 raise_question 说明为什么必须动它们（那是人来改 scope 的事）。
  // 抽不出前缀（scope 写的是 "." 或没有路径样的词）= 不执法，与路由的 `*` 行同一份判断。
  //
  // 两处只在**结构化范围**（迁移 v17）下才成立的分支：
  //   - 契约只点名了具体文件、一个目录都没有 → 前缀为空，但那**不是"抽不出来"，是"就这几个文件"**，照样执法。
  //     老契约不改口径：散文里抽不出目录就仍然是不执法，那是启发式的已知无能，不是一条规则。
  //   - `*` 是"全仓库"，不是一个叫 `*` 的目录 —— 不当作前缀去匹配，直接不执法。
  const wildcard = Array.isArray(scopePrefixes) && scopePrefixes.includes('*');
  const enforce = !wildcard && ((Array.isArray(scopePrefixes) && scopePrefixes.length) || (scopeStructured && scopeFiles.length));
  if (changed && enforce) {
    // si-preview.json 是系统约定的"怎么把页面跑起来截图"，不是任务的产物 —— 不指望每份契约都点名它
    const inScope = (p) => alwaysInScope(p) || (scopePrefixes ?? []).some((s) => p === s || p.startsWith(`${s}/`)) || scopeFiles.includes(p);   // 范围里点名的文件（package.json 之类）
    const out = [...changed].filter((p) => !inScope(p)).sort();
    if (out.length) {
      errs.push(`越界改动：${out.map((p) => `\`${p}\``).join('、')} 不在宪法块 scope 划定的范围（${[...(scopePrefixes ?? []).map((x) => `${x}/`), ...scopeFiles].join('、')}）里 —— `
        + `撤销这些改动；确实必须动它们的话用 raise_question 说明，由人改 scope，你无权自己扩`);
    }
  }
  const arts = args?.artifacts;
  if (!Array.isArray(arts) || !arts.length) errs.push('artifacts 为空 —— 没有产物的节点不算完成');
  else for (const [i, a] of arts.entries()) {
    if (!a?.path) { errs.push(`artifacts[${i}].path 缺失`); continue; }
    const p = String(a.path).replace(/\\/g, '/').replace(/\/+$/, '');
    if (exec && !exec.exists(workspace, p)) {
      errs.push(`artifacts[${i}] 声称产出了 \`${a.path}\`，但工作区里没有这个东西`); continue;
    }
    if (exec?.isDir(workspace, p)) {
      errs.push(`artifacts[${i}] \`${a.path}\` 是个目录 —— 目录不是产物，列具体文件`); continue;
    }
    // "存在" ≠ "是你产出的"。工作区是 git repo，正是为了能机械地问后一个问题。
    //
    // 例外：**上游节点把下游节点的活干了**，下游节点没有任何规格要求的改动可做。
    // 只有这里的两条规则的话，合起来是一个死锁：列上未改动的文件 → "本节点没有产出它"；交空列表 → "没有产物不算完成"。
    // 执行器两条路都走不通，只剩两个坏出口 —— 编一个假完成，或者去做一处规格没要求的改动来凑 diff
    // （例如它来问人："要不要我加个优雅关停来形成真实 diff"）。而这两个出口正是这套校验要堵的东西。
    // 所以给一条**要说清楚**的正路：承认它已经存在、说明是谁做的，产物照列、审计照记、汇报里看得见。
    // 这不放松"不许空手交差"：路径仍要真实存在，仍要给验收证据，谁做的仍然写在案上。
    if (changed && !changed.has(p)) {
      if (a.already_done === true) {
        if (!String(a.produced_by ?? '').trim()) {
          errs.push(`artifacts[${i}] \`${a.path}\` 标了 already_done 但没说 produced_by —— 是哪个节点 / 哪次提交做的，要写出来`);
        }
      } else {
        errs.push(`artifacts[${i}] \`${a.path}\` 相对基线没有任何改动 —— 本节点没有产出它，不要把现成的东西算作自己的产物。`
          + `若它确实是本节点该交的东西、而上游节点已经做掉了：加 already_done: true 与 produced_by 说明，不要为了凑 diff 去做规格没要求的改动`);
      }
    }
  }
  if (!args?.interface_contract?.trim()) errs.push('interface_contract 为空 —— 下游没法照着用');
  if (!args?.acceptance_evidence?.trim()) errs.push('acceptance_evidence 为空 —— 验收标准是机械判定的，要给出跑了什么、结果如何');
  for (const [i, d] of (args?.key_decisions ?? []).entries()) {
    if (!d?.summary?.trim() || !d?.rationale?.trim()) errs.push(`key_decisions[${i}] 缺 summary 或 rationale`);
  }
  errs.push(...validateAssumptions(args?.assumptions ?? []));
  return errs;
}

/** 对着真相源查证过的四类。own_artifact（循环）与 blocked（够不着）不在其中。 */
const VERIFIABLE = new Set(['spec', 'vendor_docs', 'command', 'repo_findings']);

/**
 * 凭据够不够具体 —— 命令与输出、路径与行号、规范条号、章节。
 *
 * ⚠️ 这是个**启发式**，一定会误判，所以它**不挂在阻塞路径上**：凭据弱只会把
 * 这条假设推去强制披露，不会拒绝交接。曾把它做成拒绝，立刻误伤了一条正当的
 * 文档引用（"厂商文档 streaming 一节"）——而误伤的方向正是这次改动最该避免的
 * "什么都问"。软信号走披露通道，不走阻塞通道。
 */
const hasCitation = (s = '') => s.length >= 10
  && /[`\/§]|\.mjs|\.js|\.json|:\d|exit=|PASS|FAIL|第.{1,4}[节条章]|一节|原文|line \d/.test(s);

/**
 * 假设的认识论校验。
 *
 * 实测：5 次执行，提问 0 次、假设 21 条。人工标注后，21 条里只有 4 条
 * 真的是"我替人做了个决定"；**13 条本来就该去查证**（其中两条 agent 已经知道
 * 答案，却写成了假设）。假设表被当成备注栏用，而提问机制因为有这个免费出口
 * 从未被触发——不是模型偷懒，是激励设反了。
 *
 * 所以这里只做一件事：**把"查得了"和"查不了"分开**。
 * 后果分级（Ⅰ/Ⅱ/Ⅲ 该不该阻塞）是另一个轴，由超时链与计划变更的花费口径决定，
 * 不在本函数内——两个轴压成一个，就会判错。
 *
 * ⚠️ 曾经在这里犯过同一个错，只是换了个方向：它把 `verified_against='none'`
 * 硬拒并强制路由去 raise_question —— 那等于说"凡是查不了的都得问人"，不看后果，
 * 又一次把两个轴压成一个。实测下来的后果是：
 * 模型**没有照做**，而是给不可查证的选择换了个标签绕过去
 * （拿"测试没覆盖 + 全绿"当 `command` 凭据）。那条规则实际从未生效过，
 * 只制造了标签噪声，还让"交接被拒 0 次"被误读成合规。
 *
 * 现在的做法：`settled_by_me` 是一个**准确又不挨罚**的格子，绕行没有动机了。
 * 它不阻塞，靠 classifyAssumption 强制披露 —— 同一份实测还显示，披露通道
 * 接住了阻塞闸漏掉的每一条。**软信号走披露通道，硬规则才走阻塞通道**，
 * 而"这是个选择"是软信号。
 *
 * 这里**故意不加**"有 settled_by_me 就必须写 key_decisions"这类联动校验：
 * 那种规则填一条空话就能满足，属于同一类可被轻易满足的假护栏 —— 它带来的
 * 不是约束，是"已经拦过了"的错觉。
 */
export function validateAssumptions(list) {
  const errs = [];
  for (const [i, a] of list.entries()) {
    const at = `assumptions[${i}]${a?.subject_key ? ` \`${a.subject_key}\`` : ''}`;
    if (!a?.subject_key?.trim() || !a?.statement?.trim()) { errs.push(`${at} 缺 subject_key 或 statement`); continue; }
    const src = a.verified_against;
    if (!src) { errs.push(`${at} 缺 verified_against —— 每条假设都要交代你打算对着谁查证它`); continue; }

    // 老取值。枚举里已经没有它了，但模型仍可能凭旧习惯写出来 —— 与其静默收下
    // 一个语义已变的标签，不如指明新落点。这是重定向，不是"你不该记这条"。
    if (src === 'none') {
      errs.push(`${at} 的 verified_against=none 已废弃。查过之后确认没有出处的，`
        + `填 settled_by_me（那是一个选择，不是事实；不阻塞，但会强制披露）；`
        + `真正需要人拍板的（不可逆、对外承诺、规格自相矛盾、契约规则与它所附的〔规格〕原文矛盾）走 raise_question。`);
      continue;
    }
    if (!a.verification?.trim()) {
      errs.push(`${at} 缺 verification —— 说清你对着什么验的、跑了什么、看到了什么`);
    }
  }
  return errs;
}

/**
 * 一条假设的落库形态。**没有任何取值会阻塞**（validateAssumptions 只管字段齐不齐），
 * 差别在于以什么身份进表、要不要强制人看见。
 *
 * 活跃集因此恰好是"查不动的三种"：
 *   blocked        —— 有真相源，此刻够不着
 *   own_artifact   —— 只能对着自己造的东西验（循环）
 *   settled_by_me  —— 查过了，压根没有出处，这是个选择
 * 这就是双轴模型落到代码里的样子：**轴 1 决定进不进活跃集，
 * 轴 2（后果）决定要不要 raise_question**，后者不在本函数里。
 *
 * ⚠️ 强制披露**只给后两种**，`blocked` 交给模型自选。理由是要让 must_disclose
 * 与 status 保持正交：三种全强制的话，`must_disclose` 就等价于 `status='active'`，
 * 白占一个字段。真正需要强制的是**标签本身会误导人**的那两种 ——
 * own_artifact 看着像验过其实是循环，settled_by_me 是替人做了个决定；
 * 而 blocked 已经如实说了"我够不着"，进活跃集这件事本身就是信号。
 *
 * @returns {{status:'confirmed'|'active', mustDisclose:boolean, weakEvidence:boolean}}
 */
export function classifyAssumption(a) {
  const verified = VERIFIABLE.has(a?.verified_against);
  // 查得了却给不出具体凭据 → 多半是把"我觉得应该是"写成了"我查过"。
  // 不拒绝，但按没查证过对待，并推去披露。
  const weakEvidence = verified && !hasCitation(a?.verification);
  return {
    status: verified && !weakEvidence ? 'confirmed' : 'active',
    // 这三种一律强制披露，不由模型自选：
    // own_artifact 是循环论证的结论，settled_by_me 是"我替你做了个决定"——
    // 后者尤其不能交给模型自选，因为它正是最容易被写成"顺手就定了"的那一类。
    mustDisclose: a?.must_disclose === true || weakEvidence
      || a?.verified_against === 'own_artifact' || a?.verified_against === 'settled_by_me',
    weakEvidence,
  };
}

/**
 * 交接记录落库并把节点置 done。
 * **一个事务**：交接记录、决策及其出处边、假设、节点状态一起成立或一起不成立。
 * 置 done 那一步由 `trg_node_done_requires_handoff` 执法——应用层不自己判，
 * 让库层判，这样绕过应用层也绕不过去（护栏住在模型外）。
 */
export function persistHandoff(db, { taskId, nodeId, args, narrativeRef }) {
  const t = now();
  const hid = newId('h');
  return db.tx(() => {
    db.run(`INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,
              known_issues,downstream_notes,narrative_ref,validated_at,created_at)
            VALUES (?,?,1,?,?,?,?,?,?,?)`,
      hid, nodeId, JSON.stringify(args.artifacts), args.interface_contract,
      JSON.stringify(args.known_issues ?? []), args.downstream_notes ?? '', narrativeRef, t, t);

    for (const d of args.key_decisions ?? []) {
      const did = newId('d');
      db.run(`INSERT INTO decisions (id,task_id,node_id,summary,rationale,actor_kind,actor_id,layer,
                narrative_ref,valid_from,recorded_at) VALUES (?,?,?,?,?,'agent','executor','execution',?,?,?)`,
        did, taskId, nodeId, d.summary, d.rationale, narrativeRef, t, t);
      insertEdge(db, did, nodeId, 'derived_from', t);   // 出处与决策同事务
    }

    // 假设登记表：同 task 同 subject_key 已有 active 的即为冲突。
    // 冲突不阻断本节点——它是给编排器看的信号，不是给执行器的门禁。
    const conflicts = [];
    for (const a of args.assumptions ?? []) {
      const prior = db.one(`SELECT id FROM assumptions WHERE task_id=? AND subject_key=? AND status='active'
                            AND superseded_at IS NULL`, taskId, a.subject_key);
      const aid = newId('as');
      // 已经对着真相源查证过的，入表即 **confirmed**——它不再是一条悬着的假设。
      // 这样"活跃假设摘要"里剩下的才是真正还没落地的东西：
      // 按上面那份实测，21 条里有 13 条属于查得了的，全部会降级，登记表从 21 行瘦到 8 行。
      // ⚠️ 冲突优先：撞了车就是 conflicted，哪怕两边都自称验过——
      //    两条互相矛盾的"已验证"比两条互相矛盾的假设更值得看。
      const cls = classifyAssumption(a);
      db.run(`INSERT INTO assumptions (id,task_id,node_id,subject_key,statement,status,
                verified_against,verification,must_disclose,valid_from,recorded_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        aid, taskId, nodeId, a.subject_key, a.statement, prior ? 'conflicted' : cls.status,
        a.verified_against ?? null, a.verification ?? null, cls.mustDisclose ? 1 : 0, t, t);
      insertEdge(db, aid, nodeId, 'asserted_by', t);
      if (prior) conflicts.push({ subjectKey: a.subject_key, priorId: prior.id, newId: aid });
    }

    // ← 库层触发器在这一行执法：没有 validated_at 的交接记录，这句会被 ABORT
    db.run(`UPDATE nodes SET status='done', finished_at=? WHERE id=?`, t, nodeId);

    audit(db, {
      actorKind: 'agent', actorId: 'executor', action: 'node_done',
      targetType: 'node', targetId: nodeId,
      payload: { handoffId: hid, artifacts: args.artifacts.map((a) => a.path),
        // 上游已经做掉的那些单列出来：这个节点这一轮没有新产出，签收人与汇报都该看得见，
        // 否则"做完了"和"本来就做完了"在记录里长得一模一样。
        alreadyDone: args.artifacts.filter((a) => a.already_done === true)
          .map((a) => ({ path: a.path, producedBy: String(a.produced_by ?? '').slice(0, 120) })),
        evidence: String(args.acceptance_evidence).slice(0, 800), narrativeRef, conflicts },
    });
    return { handoffId: hid, conflicts };
  });
}

/**
 * 挂起一个分支：问题 + 复工简报，**同一个事务**。
 *
 * 挂起分支不冷冻上下文——冷冻会复活过时的世界观（答案三天后到达时，
 * 期间的修正与接口变更对冷冻上下文不可见）。所以这里主动把执行上下文扔掉，
 * 只留简报；复工靠"简报 + 答案 + 新鲜装配"重建。
 *
 * 简报与问题必须同事务：只有问题没有简报 = 一个人回答完了但没人知道回答之后
 * 该干什么；只有简报没有问题 = 一个永远不会被唤醒的分支。
 */
/**
 * 结构矛盾事项的系统附注。**不经模型，机械追加。**
 *
 * 出现过的形状：执行器发现契约自相矛盾（"缺省值一律从 contract 引用" vs "不动 shared/"），
 * 给出的两条路里第一条是"授权我改 shared/"；负责人答"走 1，授权"。执行器照做、三条验收全过，
 * 交接却被机械越界校验驳回（答复不是契约，scope 一个字没变），只好撤销改动、再问一遍同一个问题 ——
 * 一个**会无限循环**的卡死：人每次都以为自己授权了，机械护栏每次都不认。
 *
 * 护栏本身是对的（"无权自己扩 scope"正是它存在的理由）。缺的是告诉人：答复改不了契约，
 * 改契约要走计划变更。这段话就写在人读答题界面的地方，比写进提示词有效。
 *
 * ⚠️ **这段附注自己也曾造过一次同样的卡死。** 它对人说"请发一条计划变更"，
 * 但它出现在一条**人会答、执行方也会读**的正文里。负责人照着它答"你发一条 correction，我批"，
 * 执行方当真了 —— 然后发现自己在沙箱里只有工作区：没有 src/、没有 cli.mjs、`node src/cli.mjs`
 * 直接 MODULE_NOT_FOUND。它把这一串实测写进了下一条事项，又问了一遍。
 * 一轮白白的往返，起因只是这段话没说**谁**该去发。所以现在明写"这条得由你来发"。
 */
const SCOPE_NOTE = '\n\n——\n**系统附注（不由模型生成）**：如果这条矛盾的出路是**改契约**（范围 scope / 行为规则 / 验收标准），'
  + '请注意**在这条事项里答复改不了契约**。执行方仍然受宪法块里那份 scope 的机械校验：照你的授权去做，交接时会被判越界并撤销，'
  + '于是又回到这条问题上。要真正改，**这条得由你来发**（做这个任务的 AI 只能改代码，改不了自己的契约）：'
  + '到任务页「发送」，类别选「修正」，写清楚把范围 / 规则改成什么。系统会给出影响评估与计划变更；触及契约的要按路由表批准后才生效。'
  + '如果不想改契约，就在答复里给一条**在现有范围内可行**的出路。';

function recordQuestion(db, { taskId, nodeId, args, narrativeRef, contextTokens }) {
  const id = newId('q');
  const t = now();
  const def = args.level === 3 ? null : (args.default_action ?? null);
  const kind = decisionTypeOfQuestion({ kind: args.kind, text: args.text });
  if (kind.decisionType === 'structural') args = { ...args, text: `${args.text}${SCOPE_NOTE}` };
  // 超时链：Ⅰ/Ⅱ 级从提出那一刻起计时；Ⅲ 级 NULL（库层 CHECK 也不许它有）。
  const ttl = timeoutFor(db, taskId, args.level);
  let bid;
  db.tx(() => {
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,timeout_at,status)
            VALUES (?,?,?,?,'classifier',?,?,?,?,'open')`, id, taskId, nodeId, args.level, args.text, def, t, ttl ? t + ttl : null);
    insertEdge(db, id, nodeId, 'about_node', t);
    // 路由：模型自报 kind 决定决策类型（structural 一律采信）；没报的按正文硬规则单向兜底，否则规格取舍。收件人在此刻解析并写回。
    routeQuestion(db, { questionId: id, ...kind, at: t });

    bid = recordBriefing(db, { taskId, nodeId, questionId: id, args, narrativeRef, contextTokens });

    db.run(`UPDATE nodes SET status='blocked' WHERE id=?`, nodeId);
    db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
    audit(db, { actorKind: 'agent', actorId: 'executor', action: 'question_raised',
      targetType: 'node', targetId: nodeId,
      payload: { questionId: id, briefingId: bid, level: args.level,
        blockedBy: args.blocked_by ?? null, contextTokens: contextTokens ?? null, pid: process.pid } });
  });
  return { id, briefingId: bid, level: args.level, text: args.text,
    default_action: def, blocked_by: args.blocked_by ?? null, contextTokens };
}

/**
 * 复工简报。**每一条挂起都要有一份，无论问题是谁写的。**
 *
 * 抽出来是因为出口放行那条路上，问题正文与定级由状态机写（强制 Ⅲ 级），
 * 但简报仍然只能由执行器写 —— 状态机不知道这个节点做到哪了。
 * 挂起就是挂起，不因为问题是系统生成的就少留一份交代：复工的是一个全新的实例，
 * 它只能看见库里的东西。
 */
function recordBriefing(db, { taskId, nodeId, questionId, args, narrativeRef, contextTokens }) {
  const bid = newId('b');
  const t = now();
  db.run(`INSERT INTO briefings (id,task_id,node_id,question_id,work_done,blocked_by,plan_after,
            context_tokens,narrative_ref,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    bid, taskId, nodeId, questionId, args.work_done ?? '（未填写）', args.blocked_by ?? '（未填写）',
    args.plan_after_answer ?? '（未填写）', contextTokens ?? null, narrativeRef ?? null, t, t);
  insertEdge(db, bid, nodeId, 'about_node', t);
  return bid;
}

// ═══════════════════════════════════════════════════════════════════════════
// 执行一个节点
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @returns {{kind:'done'|'question'|'stalled', ...}}
 */
export async function executeNode(db, {
  client, taskId, nodeId, workspace, tier, vendorId, narrativeDir,
  exec = new LocalExecutor(), maxIterations = 20, onStep, abort,
  // 独立验收员：({args, changed}) => {verdict, reasons}。null = 不验（离线测试默认；
  // CLI 默认开）。放在这里而不是在里面 new 一个 client，是为了让 executeNode 对
  // "验收员用哪家模型、账记在哪"一无所知 —— 那是编排器的事。
  verifier = null,
}) {
  const node = db.one(`SELECT * FROM nodes WHERE id=?`, nodeId);
  const asm = assembleExecutor(db, { taskId, nodeId, tier, vendorId, maxIterations });
  db.run(`UPDATE nodes SET status='running', started_at=? WHERE id=?`, now(), nodeId);
  // 本节点的产物基线：开跑这一刻的 HEAD。非 git 工作区（离线测试）时为 null，
  // 校验退化为只查"存在且不是目录"。
  // ⚠️ 基线**落库**（nodeBaseline）：复工/重试是新进程，但不是新的一段工作 ——
  // 取"这个进程开跑时的 HEAD"会把挂起前已提交的产物判成"相对基线没改动"。
  let baseRef = null;
  try { baseRef = nodeBaseline(db, { taskId, nodeId, workspace }).base; } catch { /* 非 git 工作区 */ }
  // scope 机械执法用的前缀：与路由表的"触及范围"同一份抽取（routing.prefixesOfScope）。
  const scopePrefixes = prefixesOf(db, taskId);
  const scopeFiles = scopeFilesOf(db, taskId);
  // 这份范围是契约里直接给的路径（v17）还是从散文里抽的？两者的"抽不出目录"含义不同，见 validateHandoff。
  const scopeStructured = scopePathsOf(db, taskId).length > 0;

  const trace = [];
  const handlers = makeHandlers(exec, workspace, trace);
  let outcome = null;
  const rejections = [];

  // 出口两个都挂在 handler 上：runToolLoop 只认"工具调用 → 结果"，
  // 所以出口也走工具，收尾由 stopReason 之外的这个 outcome 标记决定。
  handlers.submit_handoff = async (args) => {
    // 每次校验现取一次改动清单：执行器随时可能又写了文件，缓存住会判错。
    // 非 git 工作区（离线测试）时退化为只查存在性与"不是目录"。
    let changed = null;
    if (baseRef) { try { changed = changedSince(workspace, baseRef); } catch { /* 忽略 */ } }
    const errs = validateHandoff(args, { exec, workspace, changed, scopePrefixes, scopeFiles, scopeStructured });
    if (errs.length) {
      rejections.push(errs);
      audit(db, { actorKind: 'agent', actorId: 'executor', action: 'handoff_rejected',
        targetType: 'node', targetId: nodeId, payload: { errs, artifacts: args?.artifacts } });
      return `交接记录被拒，修好再交：\n- ${errs.join('\n- ')}`;
    }
    // schema 过了才轮到验收员（"schema 校验为代码层前置条件"）。它只看交接记录
    // 与产物，不看这个循环里的任何东西。打回走与 schema 拒回**同一条路** ——
    // 执行器看到的是理由，改完再交；几次都过不了就是 stalled，与现在一样。
    if (verifier) {
      const v = await verifier({ args, changed });
      if (v.verdict !== 'accept') {
        const errs = v.reasons.map((r) => `[验收员] ${r}`);
        rejections.push(errs);
        audit(db, { actorKind: 'agent', actorId: 'verifier', action: 'handoff_rejected',
          targetType: 'node', targetId: nodeId, payload: { errs, artifacts: args?.artifacts, by: 'verifier' } });
        return `交接记录被**独立验收员**打回。它只看你的产物与交接记录，不看你的过程：\n- ${errs.join('\n- ')}\n`
          + `按理由改，改完再交。若理由指向的是人该拍板的取舍，用 raise_question 问人，不要自己定。`;
      }
    }
    outcome = { kind: 'done', args };
    return '交接记录已受理。不要再调用任何工具。';
  };
  handlers.raise_question = async (args) => {
    outcome = { kind: 'question', args };
    return '问题已记录，本节点挂起。不要再调用任何工具。';
  };
  // 第三个出口。窄到不能被当成躲避通道用：能填的只有一个闭集里的生态名，
  // 而级别由状态机写死 ——模型对"这件事有多严重"没有发言权。
  handlers.request_egress = async (args) => {
    // 不再是枚举（v20 起可以填目录里的源，也可以填一个被拦的域名）：填错了回给模型改，不能让整个节点崩掉
    const g = String(args?.group ?? '').trim();
    if (!sourceOf(db, g) && hostProblem(g)) {
      return `「${g}」既不是联网目录里的源，也不是合法的域名：${hostProblem(g)}。可申请的源见上下文「网络」一节；填域名时只写域名本身。`;
    }
    outcome = { kind: 'egress', args };
    return '放行请求已记录，本节点挂起等人拍板。不要再调用任何工具。';
  };

  // ⚠️ 崩溃也要留下叙事。曾出现过厂商余额耗尽，异常从 runToolLoop 里穿出去，
  // 20 轮工具调用的记录**一条都没落盘** —— 而复盘要求只凭真相源。
  // 所以 loop 包在 try 里，叙事归档无论成败都写。
  let crashed = null;
  let loop;
  try {
    loop = await runToolLoop(client, {
      tier, system: asm.system, messages: asm.messages, tools: TOOLS,
      maxTokens: 16000, effort: 'high',
      cacheSystem: asm.cacheStable, cacheKey: `node:${nodeId}`,
    }, handlers, {
      maxIterations, onStep, abort, shouldStop: () => outcome !== null,
      // 剩 5 轮开始报数。不是催它快点做完 —— 是逼它在"做不完"和"假装做完了"
      // 之外看见第三条路：还有 raise_question。
      iterationNote: (i, max) => {
        const left = max - i - 1;
        if (left > 5 || left < 0) return null;
        return left === 0
          ? `[系统] 这是最后一轮。现在必须调用 submit_handoff 或 raise_question，否则本节点算未收尾、退回重来。`
          : `[系统] 还剩 ${left} 轮工具调用。收不了尾就调 raise_question 说明卡在哪，`
            + `不要硬撑，也不要去做别的节点的活。`;
      },
    });
  } catch (e) {
    crashed = e;
    loop = { trace: [], stopped: `crashed: ${e.message}` };
  }

  // 叙事归档（兜底）：交接记录是摘要，原文永远可达。
  // 复盘也靠它——只凭真相源复盘，进程日志不算。
  const narrativeRef = join(narrativeDir, `${nodeId}.md`);
  mkdirSync(dirname(narrativeRef), { recursive: true });
  writeFileSync(narrativeRef, renderNarrative({ node, asm, trace, loop, outcome, rejections, crashed }));

  if (crashed) {
    // 崩溃**不是**没收尾，是根本没跑完。退回 pending，理由进审计轨，
    // 然后把异常原样抛给上层 —— 崩溃就该以非零退出码表现，不能伪装成正常收尾。
    //
    // 重试账**分两种**：基础设施错误（厂商挂了 / 容器 OOM，见 core/errors.mjs）
    // 由编排器记 —— 厂商挂了不计、OOM 计一次；这里只收拾状态，不留 running。
    // 别的崩溃（真 bug）照旧在这里计一次。原来这里一律 +1，编排器接住 infra 错误
    // 之后再记一次，就双计了。
    db.run(isInfraError(crashed)
      ? `UPDATE nodes SET status='pending' WHERE id=?`
      : `UPDATE nodes SET status='pending', retry_count=retry_count+1 WHERE id=?`, nodeId);
    audit(db, { actorKind: 'system', action: 'node_crashed', targetType: 'node', targetId: nodeId,
      payload: { error: String(crashed.message).slice(0, 600), toolCalls: trace.length,
        llmCalls: client.ledger?.length ?? null, narrativeRef, pid: process.pid } });
    throw crashed;
  }

  if (outcome?.kind === 'done') {
    const { handoffId, conflicts } = persistHandoff(db, { taskId, nodeId, args: outcome.args, narrativeRef });
    clearNodeBaseline(db, { taskId, nodeId });   // 这一段工作结束；修正若让它重做，下一段重取
    return { kind: 'done', handoffId, conflicts, trace, rejections, assemblyId: asm.assemblyId, narrativeRef, meta: asm.meta };
  }
  if (outcome?.kind === 'egress') {
    // 问题正文与定级由状态机写（`raiseEgressQuestion`），模型只提供"要哪个生态、为什么"。
    // 复工简报仍然要写 —— 挂起就是挂起，不因为问题是系统生成的就少留一份交代。
    const a = outcome.args;
    const last = client.ledger?.at?.(-1);
    const contextTokens = last ? last.inputTokens + last.cacheReadTokens + last.cacheWriteTokens : null;
    const blockedBy = `联网未放行 \`${a.group}\`（沙箱默认断网）`;
    const q = raiseEgressQuestion(db, { taskId, nodeId, group: a.group, why: a.why,
      auditFile: exec?.egress?.auditFile ?? null });
    const briefingId = recordBriefing(db, { taskId, nodeId, questionId: q.questionId, args: {
      work_done: a.work_done, plan_after_answer: a.plan_after_answer, blocked_by: blockedBy,
    }, narrativeRef, contextTokens });
    db.run(`UPDATE nodes SET status='blocked' WHERE id=?`, nodeId);
    audit(db, { actorKind: 'agent', actorId: 'executor', action: 'question_raised',
      targetType: 'node', targetId: nodeId,
      payload: { questionId: q.questionId, briefingId, level: 3, levelSource: 'hard_rule',
        blockedBy, contextTokens, pid: process.pid } });
    return { kind: 'question', question: { id: q.questionId, briefingId, level: 3, text: q.text,
      default_action: null, blocked_by: blockedBy, contextTokens,
      egress: { group: a.group, corroborated: q.corroborated, deniedHosts: q.deniedHosts } },
    trace, rejections, assemblyId: asm.assemblyId, narrativeRef, meta: asm.meta };
  }
  if (outcome?.kind === 'question') {
    // 挂起那一刻上下文有多大：最后一次调用的提示词体量（原价 + 缓存读一起算，
    // 缓存只影响价钱不影响体量）。它是丈量"丢弃了多少"的分母——设计假设说
    // 丢弃后能无损重建，那就得先知道丢的是多少。fake/无账本时为 null。
    const last = client.ledger?.at?.(-1);
    const contextTokens = last ? last.inputTokens + last.cacheReadTokens + last.cacheWriteTokens : null;
    const question = recordQuestion(db, { taskId, nodeId, args: outcome.args, narrativeRef, contextTokens });
    return { kind: 'question', question, trace, rejections, assemblyId: asm.assemblyId, narrativeRef, meta: asm.meta };
  }

  // 被硬上限掐停：节点回 pending，但**不计重试**。
  // 重试次数是"这个节点自己搞不定"的度量；被闸门掐停不是它的问题，
  // 记在它头上会让加额重跑的人凭空少一次机会，还会把 limit.node_retries 那一维污染成
  // "谁先撞上预算谁先被判死"。
  if (loop.stopped?.startsWith('aborted:')) {
    db.run(`UPDATE nodes SET status='pending' WHERE id=?`, nodeId);
    audit(db, { actorKind: 'system', action: 'node_aborted', targetType: 'node', targetId: nodeId,
      payload: { reason: loop.stopped.slice(9), iterations: loop.trace.length,
        toolCalls: trace.length, narrativeRef, pid: process.pid } });
    return { kind: 'aborted', stopped: loop.stopped, trace, rejections,
      assemblyId: asm.assemblyId, narrativeRef, meta: asm.meta };
  }

  // 既没交接也没提问就跑到头了。**不置 done，也不当成功**——
  // 节点回 pending 等重试，失败原因进审计。伪装成正常收尾是最坏的处理。
  db.run(`UPDATE nodes SET status='pending', retry_count=retry_count+1 WHERE id=?`, nodeId);
  audit(db, { actorKind: 'agent', actorId: 'executor', action: 'node_stalled',
    targetType: 'node', targetId: nodeId,
    payload: { stopped: loop.stopped, iterations: loop.trace.length, rejections,
      say: textOf(loop.resp ?? { content: [] }).slice(0, 600) || null } });
  return { kind: 'stalled', stopped: loop.stopped, trace, rejections, assemblyId: asm.assemblyId, narrativeRef, meta: asm.meta };
}

const renderNarrative = ({ node, asm, trace, loop, outcome, rejections, crashed }) => `# 执行叙事：${node.title}

- 节点 \`${node.id}\` · 装配 \`${asm.assemblyId}\` · 宪法 v${asm.meta.constitutionVersion}
- 上下文估算 ${asm.meta.tokenEstimate} token（稳定段 ${asm.meta.stableTokens}）· 缓存：${asm.meta.cacheNote}
${asm.meta.resume ? `- 复工：简报 \`${asm.meta.resume.briefingId}\` + 答复 \`${asm.meta.resume.answerId}\`；挂起时 ${asm.meta.resume.contextTokensAtSuspend} token → 重建 ${asm.meta.resume.rebuiltTokens} token\n` : ''}\
- 收尾：${crashed ? `**崩溃**（${crashed.message.slice(0, 200)}）` : outcome?.kind ?? `未收尾（${loop.stopped}）`} · LLM 轮次 ${loop.trace.length} · 工具调用 ${trace.length}
${rejections.length ? `- 交接被拒 ${rejections.length} 次：${rejections.map((e) => e.join('；')).join(' ||| ')}\n` : ''}
## 工具调用全程

${trace.map((s, i) => `### ${i + 1}. ${s.name}\n\n\`\`\`json\n${JSON.stringify(s.args).slice(0, 1500)}\n\`\`\`\n\n\`\`\`\n${s.result}\n\`\`\``).join('\n\n')}

## 收尾

\`\`\`json
${JSON.stringify(outcome?.args ?? { stopped: loop.stopped }, null, 2)}
\`\`\`
`;
