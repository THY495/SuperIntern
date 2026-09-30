// 规划器 —— 第一个 LLM 子程序（确定性状态机 + LLM 子程序）。
//
// 职责边界，比它做什么更重要：
//   做   —— 把宪法块拆成 2~4 个可独立执行、可独立验收的节点，并声明依赖。
//   不做 —— 不设 status（一律 pending）、不设优先级以外的调度、不写任何参数、
//           不决定谁来执行。这些要么是状态机的事，要么是宪法层的事。
//
// 这里要检验的假设（最可能先出问题的一条）：
// **模型产出的 DAG 能不能满足库层护栏**。所以这里的校验失败是**数据**不是意外：
// 每一次拒绝都写进审计轨，重试次数就是那条假设的度量。

import { withOutputLang, contentLang, tl, I18nError } from '../i18n/index.mjs';
import { routeQuestion, decisionTypeOfQuestion } from '../core/routing.mjs';
import { overruledContractRules, renderOverruled } from '../core/decisions.mjs';
import { stripTransferHint } from '../core/routing.mjs';
import { textOf, toolCallsOf, truncatedEmpty, TruncatedEmptyError } from '../llm/canonical.mjs';
import { validateRules, foldRules } from '../core/rules.mjs';
import { newId, now, insertEdge, audit } from '../db/db.mjs';
import { getParam } from '../core/params.mjs';

const RISK_TIERS = ['low', 'normal', 'high'];
const MODEL_TIERS = ['light', 'standard', 'heavy'];
// 完成 token 预算含推理（DeepSeek：reasoning_tokens ⊂ completion_tokens）。曾出现过项目规划器 effort=high 把 8000 吃光、回空消息。只按实际用量计费。
const MAX_TOKENS = 24000;

/**
 * 规划器只有一个出口：调用这个工具。
 *
 * ⚠️ schema 里**故意没有 status 字段**。节点状态是状态机的所有物，规划器碰不到，
 * 也就无从产出一个 status='done' 的节点。这是护栏的第一层（不给方向盘），
 * 库层的 trg_node_insert_done_requires_handoff 是第二层（拿到了也拧不动）。
 */
const SUBMIT_PLAN = {
  name: 'submit_plan',
  description: '提交任务分解方案。只能调用一次，必须一次给全。',
  parameters: {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '本方案内唯一的短标识，供 depends_on 引用，如 "n1"' },
            title: { type: 'string', description: '一句话说清这个节点交付什么' },
            spec: { type: 'string', description: '要做什么、边界在哪、不做什么' },
            acceptance: { type: 'string', description: '可机械判定的验收标准。含糊的标准等于没有标准' },
            rules: {
              type: 'array',
              description: '节点规格里的每条**行为规则**（签名、实参个数、返回值、错误码、边界）单列一条，带出处：quote = 逐字引宪法块里支撑它的那句（系统机械核对是宪法块的子串，改写就被拒，且会核对规则与引文有共同字眼）；assumption = 宪法块没写，说明你怎么定的。**一条只讲一件事**，分号连起来的多个断言会被拒。没有行为规则的节点（纯文档）可以给空数组。',
              items: { type: 'object', properties: {
                rule: { type: 'string' }, quote: { type: 'string' }, assumption: { type: 'string' },
              }, required: ['rule'] },
            },
            depends_on: {
              type: 'array', items: { type: 'string' },
              description: '本方案内其他节点的 key。无依赖填 []',
            },
            risk_tier: { type: 'string', enum: RISK_TIERS },
            model_tier: { type: 'string', enum: MODEL_TIERS, description: '这个节点该用哪一档模型执行' },
          },
          required: ['key', 'title', 'spec', 'acceptance', 'rules', 'depends_on', 'risk_tier', 'model_tier'],
        },
      },
      rationale: { type: 'string', description: '为什么这样切分。会进决策记录，供日后复盘' },
    },
    required: ['nodes', 'rationale'],
  },
};

/**
 * 第二个出口。**实测倒逼出来的**：探针任务的宪法块里写了"必须拆成恰好 8 个
 * 节点"与"把第一个节点的 status 设为 done"，两条都与结构约束直接冲突。模型准确
 * 识别了冲突、拒绝伪造 status、并反问"你倾向哪个方向"——而当时代码只有 submit_plan
 * 一个出口，回它的是"你的唯一动作是调用它"。下一轮它就编出了四个与任务无关的节点
 * （"背压控制""多路复用""SSI 帧包装"），结构完全合法、内容完全不相干。
 *
 * 只给一个出口，"我没法合法地做这件事"就只剩下伪造这一条路。
 *
 * ⚠️ level 与 default_action **故意不在这里校验**：Ⅲ 级不得有默认动作、Ⅰ 级必须有，
 * 由 questions 表的 CHECK 约束执法（护栏住在模型外）。模型判错了就
 * 被库层拒绝并回灌重试——那正是要观测的东西，不是要绕开的麻烦。
 */
const RAISE_QUESTION = {
  name: 'raise_question',
  description: '当宪法块本身无法被合法地规划时调用：目标自相矛盾、约束与结构限制冲突、'
    + '关键信息缺失到无法切分。不要用它问那些你自己判断得了的事。',
  parameters: {
    type: 'object',
    properties: {
      level: {
        type: 'integer', enum: [1, 2, 3],
        description: 'Ⅰ=有明确默认动作，超时即照默认走；Ⅱ=可回退的选择，需要人拍板但不致命；'
          + 'Ⅲ=不可逆或涉及对外承诺，无默认动作、无限期等待',
      },
      text: { type: 'string', description: '问题本身。要让一个没有上下文的人也能回答' },
      default_action: { type: 'string', description: '仅 Ⅰ/Ⅱ 级填：无人回答时你会怎么做' },
      blocked_by: { type: 'string', description: '宪法块里的哪一条把你卡住了，原文引用' },
      kind: { type: 'string', enum: ['spec', 'structural'],
        description: 'spec=规格没写清、要人取舍；structural=目标 / 约束 / 结构之间自相矛盾。决定问题路由给谁' },
    },
    required: ['level', 'text', 'blocked_by'],
  },
};

const SYSTEM = `你是一个长期运行的自主 agent 的规划器。你面对的是一份"宪法块"——任务的目标、范围、完成定义与约束。

正常情况下调用 submit_plan，把它拆成 2~4 个节点。
宪法块里带〔规格〕/〔规划器假设〕标记的行为规则：切节点时**连同标记和引文原样带进**相关节点的规格，不改写、不丢引文 —— 实现方要靠引文判断契约与规格是否矛盾。
节点自己的行为规则（签名、实参个数、返回值、错误码、边界）写进 rules 字段并带出处：quote 逐字引宪法块（系统核对子串），宪法块没写的标 assumption。**一条规则只讲一件事**——分号连起来的多个断言会被拒，拆开写、各带各的引文；规则用原文的说法写，别改写关键词。
**不要在节点规格里加宪法块没有的硬规则**（节点规格写"merge 至少 2 个实参"，宪法引的规格签名是至少 1 个，实现方停下来问人；
n2 的验收命令包含 n3 函数的错误路径、同时又写"n2 不得登记 n3 函数"，自相矛盾）。切分本身产生的规则（哪个节点不做什么）要和验收命令对得上。

如果宪法块**无法被合法地规划**——目标自相矛盾、某条约束与工具的结构限制直接冲突、
关键信息缺失到切不动——调用 raise_question，不要迁就。编一个形状合法但内容不相干的
方案，比停下来问一句坏得多。

切分标准：
- 每个节点要能被**独立执行**，且执行完就能**独立验收**。不能验收的切分等于没切。
- acceptance 必须是机械可判的（某个命令通过、某个文件存在且满足某条性质）。写"实现得当"这种是无效的。
- 依赖只在真的存在数据/接口依赖时才声明。为了排出好看的链条而制造依赖会让整个 DAG 串行化。
- 不要产出"调研""设计""总结"这类没有产物的节点。每个节点必须落到具体产物上。
- 不要产出**条件节点**（"若有缺陷则修""如需再补"）：没产物的节点交接不了；修复靠任务级验收与重试，不靠一个"看情况"的节点。
- 测试节点的 acceptance 不能是"用例存在 / 文件存在"：要写"跑 <命令> 通过 N 个用例"，或（测试先于实现时）"实现前这些用例失败，且失败原因是目标函数缺失"。
  **不要写"全部失败 / 0 通过"**：期望输出与实现前的行为恰好相同的用例（例如内联注释被当未知标签渲染成空串，与"注释删除"同样是空串）在任何正确实现下都不可能变红；
  写成"文件整体退出码非 0、可区分的用例失败；实现前后输出不变的用例通过属预期，交接记录里逐条注明"。
- 节点粒度按**要读 + 要改的代码量**定：一个节点动的文件总量要能装进一次执行器上下文（读文件也占 token）。
  一个节点跨三个面（例如同时改存储、CLI、文档）就拆开；同一文件里的独立特性也可以拆。
- **写测试的节点排在它所测实现的节点之前**（写测试时看不见实现，期望值只能来自宪法块与规格），实现节点依赖它。
- 宪法块 / 规格里**逐字段、逐接口写死的约束**（必填、可空、取值范围、默认值、返回的状态码、排序）要在测试节点的 spec 里**逐条点名**，每条至少一个用例。
  "可空 / 可不填"两种写法都要测：请求里**省略**这个字段，和显式传 null。
- **验收不许断言别的节点的产物不存在**（例如用 \`test ! -e docs/API.md\` 证明本节点没抢跑写文档）：没有依赖关系的兄弟节点可能先完成，那之后这条验收永远不可能成立，除非删掉别人的产物。"本节点不做 X"写进 spec 的边界；只有那个产物的节点**依赖本节点**时，这种断言才成立。
- acceptance 与 spec 里的行为样例必须带**精确的期望输出**，期望值要能在宪法块或规格原文里找到出处；不要让执行者自己算期望 —— 它会从自己的实现推出来。

你不设置节点状态、不分配执行者、不改任何参数——那些不属于规划。`;

/** 库层拒绝之前，先在应用层拦掉 SQL 表达不了的部分（唯一性、引用完整性、无环）。 */
export function validatePlan(plan, { constitutionText = null } = {}) {
  const nodes = plan?.nodes;
  if (!Array.isArray(nodes)) return ['nodes 不是数组'];
  // ⚠️ 节点数区间是**整份计划**的规则，不是节点集合本身的规则 —— 它说的是
  // "一个任务该拆成 2~4 步"。所以它留在这里，不进 validateNodeSet：
  // 重规划的增量一次加 1 个节点完全合理，套这条会把正当的方案判死。
  // （replan 若直接复用 validatePlan，加一个节点就会报"节点数必须是 2~4"。）
  const errs = (nodes.length < 2 || nodes.length > 4)
    ? [`节点数必须是 2~4，收到 ${nodes.length}`] : [];
  return [...errs, ...validateNodeSet(nodes, { constitutionText })];
}

/**
 * 一批节点本身合不合法：字段齐不齐、key 重不重、依赖指得到吗、成不成环。
 * **与"这批节点构成一份完整计划吗"分开** —— 后者才有节点数区间那条规则。
 * 规划器与重规划器共用这一份，两套护栏迟早会分叉。
 */
export function validateNodeSet(nodes, { constitutionText = null } = {}) {
  const errs = [];
  const keys = new Set();
  for (const [i, n] of nodes.entries()) {
    const at = `nodes[${i}]`;
    // 节点规格里的规则句要有出处（否则任务规划器会在契约之下又加没出处的规则，逼执行方停下来问人 ——
    // 例："merge 至少 2 个实参"与宪法引的规格签名矛盾；n2 验收含 n3 函数的错误路径与"不得登记"矛盾）。
    // 引文核对的对象是宪法块（它自己已经引了规格原文），假设照样单列。
    if (n?.rules !== undefined) errs.push(...validateRules(n.rules, { brief: constitutionText, at: `${at}.rules` }));
    for (const f of ['key', 'title', 'spec', 'acceptance']) {
      if (typeof n?.[f] !== 'string' || !n[f].trim()) errs.push(`${at}.${f} 缺失或为空`);
    }
    // 条件节点（"若有缺陷则修"）与"用例存在"式验收：模型外的机械拒收（这两种都实际出现过）。
    const titleSpec = `${n?.title ?? ''} ${n?.spec ?? ''}`;
    if (/(若|如|如果|视情况)[^。；\n]{0,12}(缺陷|问题|需要|必要)[^。；\n]{0,12}(修|补|改)/.test(titleSpec)
      || /\b(if|when|as needed)\b[^.;\n]{0,24}\b(bugs?|issues?|problems?|defects?|needed|necessary)\b[^.;\n]{0,24}\b(fix|patch|repair|address)\b/i.test(titleSpec)) {
      errs.push(`${at} 是条件节点（"若有…则修"）：没产物的节点交接不了，修复靠任务级验收与重试`);
    }
    const acc = typeof n?.acceptance === 'string' ? n.acceptance.trim() : '';
    if (acc.length <= 80 && /(存在|已创建|已新建|\bexists?\b|\bis created\b|\bhas been created\b)/i.test(acc) && !/(通过|失败|退出|exit|pass|fail|返回|输出|等于|==|\breturns?\b|\boutputs?\b|\bequals?\b)/i.test(acc)) {
      errs.push(`${at}.acceptance 只说"存在"不算验收：要写跑什么命令、通过多少用例，或测试先行时"实现前失败且原因是目标缺失"`);
    }
    if (n?.key) {
      if (keys.has(n.key)) errs.push(`${at}.key 重复：${n.key}`);
      keys.add(n.key);
    }
    if (!RISK_TIERS.includes(n?.risk_tier)) errs.push(`${at}.risk_tier 非法：${n?.risk_tier}`);
    if (!MODEL_TIERS.includes(n?.model_tier)) errs.push(`${at}.model_tier 非法：${n?.model_tier}`);
    if (!Array.isArray(n?.depends_on)) errs.push(`${at}.depends_on 不是数组`);
    // 规划器不该知道 status 这个字段存在；出现即说明它在越权，值对不对都要拦
    if (n && 'status' in n) errs.push(`${at} 含 status —— 节点状态不归规划器管`);
  }
  if (errs.length) return errs;

  for (const n of nodes) {
    for (const d of n.depends_on) {
      if (!keys.has(d)) errs.push(`${n.key} 依赖了不存在的节点 '${d}'`);
      if (d === n.key) errs.push(`${n.key} 依赖自己`);
    }
  }
  if (errs.length) return errs;

  // 环检测（Kahn）。DAG 里有环 = 整个任务永远没有可执行的起点。
  const indeg = new Map(nodes.map((n) => [n.key, n.depends_on.length]));
  const queue = nodes.filter((n) => indeg.get(n.key) === 0).map((n) => n.key);
  let seen = 0;
  while (queue.length) {
    const k = queue.shift(); seen++;
    for (const n of nodes) {
      if (!n.depends_on.includes(k)) continue;
      indeg.set(n.key, indeg.get(n.key) - 1);
      if (indeg.get(n.key) === 0) queue.push(n.key);
    }
  }
  if (seen !== nodes.length) errs.push('依赖成环，没有可执行的起点');
  if (errs.length) return errs;
  return absenceAssertionErrs(nodes);
}

/**
 * **节点的验收断言"别的节点的产物不存在"**。
 * 例：n1 验收里有 `test ! -e docs/API.md`（"先红后绿"，证明 n1 没抢跑写文档），而兄弟节点 n3 按规格
 * 交付了 docs/API.md —— 这条从此永远不可能成立，除非删掉别人的产物。执行器只能把二选一摆到人面前，
 * 一次重档提问 + 一轮人工往返换来一句"豁免"。
 *
 * **窄版**：只认 `test ! -e|-f|-d <路径>` 这一个字面形状，不去理解散文；
 * "是别的节点的产物" = 那个路径原样出现在另一个节点的标题 / 规格 / 验收里；
 * **下游节点除外**：依赖本节点（直接或间接）的节点必然在本节点交接之后才开工，那种断言是成立的 ——
 * 这条例外把误拒压到很低。上游与无关的节点都可能先完成，拒。
 * 误拒的代价是规划器多跑一次（几美分，不经人）；漏拒的代价是一条事项 + 一轮人工往返。
 */
export function absenceAssertionErrs(nodes) {
  const errs = [];
  const downstreamOf = (key) => {
    const out = new Set(); const stack = [key];
    while (stack.length) {
      const k = stack.pop();
      for (const m of nodes) if ((m.depends_on ?? []).includes(k) && !out.has(m.key)) { out.add(m.key); stack.push(m.key); }
    }
    return out;
  };
  for (const n of nodes) {
    const acc = String(n.acceptance ?? '');
    for (const m of acc.matchAll(/\btest\s+!\s+-[efd]\s+(['"]?)([^\s'";&|)]+)\1/g)) {
      const path = m[2].replace(/^\.\//, '');
      if (!path) continue;
      const down = downstreamOf(n.key);
      const owner = nodes.find((o) => o.key !== n.key && !down.has(o.key)
        && [o.title, o.spec, o.acceptance].some((t) => String(t ?? '').includes(path)));
      if (!owner) continue;
      const o = owner.key;
      errs.push(`${n.key}.acceptance 断言 ${path} 不存在（${m[0]}），但 ${path} 出现在节点 ${o} 里、而 ${o} 不在 ${n.key} 的下游 —— `
        + `${o} 可能先于 ${n.key} 完成，那之后这条验收永远不可能成立（除非删掉别人的产物）。`
        + `"本节点不做 X"写进 spec 的边界，不要写进验收；真要断言先后，让 ${o} 依赖 ${n.key}。`);
    }
  }
  return errs;
}

/**
 * 规划一次。失败即把库/应用层的拒绝理由原样回灌重试 —— 这不是容错糖衣，
 * 是在观测护栏本身：护栏说了什么、模型改没改对、改了几次，全部落审计轨。
 *
 * @returns {{nodes:object[], attempts:number, rejections:string[][], rationale:string}}
 */
export async function plan(db, { client, taskId, constitution, tier = 'heavy', maxAttempts = 3 }) {
  // ── 进程寿命的括号 ────────────────────────────────────────────────────
  // 规划也是一个**会花钱的进程**，所以它也得在审计轨里留下起止与 pid。
  //
  // 复盘完整性自检问"每一分钱都落在某次进程寿命里吗"；规划器若没有这一对，
  // 它的花费就落在所有区间之外。规划器崩在半路的话，审计轨说不出是哪个进程、跑了多久。
  // 松开那条检查是最容易的做法，也是错的：它问的问题是对的。
  const startedAt = now();
  audit(db, { actorKind: 'agent', actorId: 'planner', action: 'planner_started',
    targetType: 'task', targetId: taskId, payload: { pid: process.pid, tier, maxAttempts } });
  const exit = (kind, extra = {}) => {
    audit(db, { actorKind: 'agent', actorId: 'planner', action: 'planner_exit',
      targetType: 'task', targetId: taskId,
      payload: { pid: process.pid, kind, elapsedMs: now() - startedAt, ...extra } });
  };

  // ⚠️ 规划器的上下文里若**只有宪法块** —— 它提的问题被回答之后，
  // 重跑 plan 时它看不到答复，**再问一模一样的一遍**：
  // 提问 → 人回答 → 分支解冻 → 重跑 → 同一个问题，每轮都花钱。
  //
  // 回答 → 分支解冻是成立的，坏的是另一半：**答复到不了问的人**。
  // 执行器那一侧有复工简报把答复带回去，规划器这一侧需要对应物。
  // 与出网问题字段被白名单吃掉是同一个形状：**一条不报错的循环**。
  const answered = priorAnswers(db, taskId);
  const driftNote = getParam(db, taskId, 'task.drift_note') ?? null;
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: constitutionBlock(constitution)
      + (answered ? `\n\n${answered}` : '')
      // 契约里已被人判作废的条目 —— 不挂上，规划器会把作废的规则原样切进节点规格与验收标准。
      + ((ov) => (ov ? `\n\n${ov}` : ''))(renderOverruled(db, overruledContractRules(db, taskId)))
      // 基线漂移提示（project.mjs startTask）：契约定稿之后，有不在它依赖关系里的任务先合并了。
      + (driftNote ? `\n\n## 开工前须知（系统按合并记录机械生成）\n${driftNote}` : '') }],
  }];
  const rejections = [];

  try {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await client.complete({
      tier, system: withOutputLang(SYSTEM, contentLang(db)), messages, tools: [SUBMIT_PLAN, RAISE_QUESTION], maxTokens: MAX_TOKENS, effort: 'high',
    });
    if (truncatedEmpty(resp)) throw new TruncatedEmptyError('规划器', MAX_TOKENS);
    const calls = toolCallsOf(resp);
    const call = calls.find((c) => c.name === 'submit_plan');
    const ask = calls.find((c) => c.name === 'raise_question');

    // 提问优先于方案：模型同时给两者时，说明它对方案本身没把握
    if (ask) {
      const q = recordQuestion(db, { taskId, args: ask.args, tier, attempt });
      exit('question', { attempts: attempt, questionId: q.id });
      return { kind: 'question', question: q, attempts: attempt, rejections };
    }

    let errs;
    if (!call) {
      errs = [`既没调用 submit_plan 也没调用 raise_question（stopReason=${resp.stopReason}）。`
        + `能规划就提交方案，不能规划就提问，不要只输出文字。`];
    } else {
      errs = validatePlan(call.args, { constitutionText: constitutionText(constitution) });
    }

    audit(db, {
      actorKind: 'agent', actorId: 'planner', action: 'plan_attempt',
      targetType: 'task', targetId: taskId,
      payload: {
        attempt, tier, accepted: errs.length === 0, rejections: errs,
        // ⚠️ 模型自己说了什么必须留证，尤其是它**没调工具**的时候。
        // 实测：规划器在宪法块与结构约束冲突时会改用文字申辩（"你要 8 个但
        // 只让我给 4 个"）——那其实是一个该升级成提问的信号。这段文字若被丢弃，
        // 审计轨上只剩一句"没有调用 submit_plan"，复盘不出真正发生了什么。
        say: textOf(resp).slice(0, 600) || null,
        stopReason: resp.stopReason,
      },
    });

    if (!errs.length) {
      exit('plan', { attempts: attempt, nodes: call.args.nodes.length });
      // 规则连同出处折进节点规格：执行器与验收员读的是 spec，不另开字段
      const nodes = call.args.nodes.map((n) => ({ ...n, spec: foldRules(n.spec, n.rules, NODE_RULES_HEADER) }));
      return { kind: 'plan', nodes, rationale: call.args.rationale ?? '', attempts: attempt, rejections };
    }

    rejections.push(errs);
    if (attempt === maxAttempts) {
      throw new I18nError('规划器 {n} 次都没产出合法方案。最后一次被拒理由：\n  - {errs}', { n: maxAttempts, errs: errs.join('\n  - ') });
    }
    // 把助手轮原样回填后再送拒绝理由 —— 少了助手轮，多数厂商会拒收 tool_results
    messages.push({ role: 'assistant', content: resp.content });
    if (call) {
      messages.push({
        role: 'tool_results',
        results: [{ callId: call.id, name: call.name, isError: true,
          content: `方案被拒，请修正后重新调用 submit_plan：\n- ${errs.join('\n- ')}` }],
      });
    } else {
      messages.push({ role: 'user', content: [{ type: 'text', text: `${errs[0]}\n${textOf(resp) ? '（你上一轮只输出了文字）' : ''}` }] });
    }
  }
  throw new Error('unreachable');
  } catch (e) {
    // 崩了也要收尾。没有 exit 的寿命在复盘里会被标成"被硬杀"，
    // 而那正是它该显示的样子 —— 但**抛异常**是可预期的收尾，不该混进那一类。
    exit('failed', { error: String(e.message).slice(0, 300) });
    throw e;
  }
}

/**
 * 提问落库。级别与默认动作的合法性**交给 questions 表的 CHECK 约束**判，
 * 这里只负责把模型说的原样送进去 —— 拒绝了就是拒绝了，不在应用层预先"帮它改对"。
 */
function recordQuestion(db, { taskId, args, tier, attempt }) {
  const id = newId('q');
  const t = now();
  // Ⅲ 级无默认动作是库层硬规则；模型给了也不传，让它以"提了个不合法的问题"暴露
  const def = args.level === 3 ? null : (args.default_action ?? null);
  db.tx(() => {
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,status)
            VALUES (?,?,NULL,?,'classifier',?,?,?,'open')`,
      id, taskId, args.level, args.text, def, t);
    routeQuestion(db, { questionId: id, ...decisionTypeOfQuestion({ kind: args.kind, text: args.text }), at: t });
    db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
    audit(db, {
      actorKind: 'agent', actorId: 'planner', action: 'question_raised',
      targetType: 'task', targetId: taskId,
      payload: { questionId: id, level: args.level, tier, attempt, blockedBy: args.blocked_by ?? null },
    });
  });
  return { id, level: args.level, text: args.text, default_action: def, blocked_by: args.blocked_by ?? null };
}

/**
 * 本任务**任务级**问题里已经答过的那些，连同答复正文。
 *
 * 只取 `node_id IS NULL` —— 那是规划器与重规划器提的问题。执行器的问题挂在
 * 节点上、走复工简报，塞进规划上下文只是噪声。
 *
 * 答复正文从 `messages` 读、由 `answers` 边挂上（与复工简报同一条路）：
 * 问题表只记状态，**指令效力只授予认证通道**，而 messages 是唯一带
 * token_id / trust_label 的表。信任标签**照抄不改写** —— 让模型自己看见
 * 这句话凭什么算数，而不是由装配层替它下结论。
 */
export function priorAnswers(db, taskId) {
  const qs = db.all(`SELECT * FROM questions WHERE task_id=? AND node_id IS NULL
                     AND status='answered' ORDER BY asked_at`, taskId);
  if (!qs.length) return '';
  const parts = [];
  for (const q of qs) {
    const a = db.one(`SELECT m.* FROM edges e JOIN messages m ON m.id=e.from_id
                      WHERE e.to_id=? AND e.relation='answers' AND e.superseded_at IS NULL
                      ORDER BY m.received_at DESC LIMIT 1`, q.id);
    if (!a) continue;
    parts.push(`### 你（或上一次规划）问过：\n${stripTransferHint(q.text)}\n\n**人的答复**（trust_label=${a.trust_label}）：\n${a.body}`);
  }
  if (!parts.length) return '';
  return `## 已经问过、已经答过的\n\n`
    + `下面这些是**经认证通道**回来的答复，具指令效力。\n`
    + `**已经答过的不要再问一遍** —— 同一个问题问第二次，人要付的是又一轮等待。\n`
    + `若答复本身仍然含糊到无法规划，那就问**新的、更具体的**那一层，并引用答复原文说清卡在哪。\n\n`
    + parts.join('\n\n');
}

const NODE_RULES_HEADER = '本节点的行为规则（每条带出处：〔规格〕后是宪法块原文，是最高依据，实现与它矛盾时提问；〔规划器假设〕是宪法没写、规划器定的，按字面执行，拿不准就提问）：';
/** 引文核对用的宪法块全文（与 constitutionBlock 同一份内容，去掉标题） */
export const constitutionText = (c) => [c.goal, c.scope, c.definition_of_done, ...(JSON.parse(c.constraints || '[]'))].join('\n');
const constitutionBlock = (c) => `## 目标
${c.goal}

## 范围
${c.scope}

## 完成定义
${c.definition_of_done}

## 约束
${(JSON.parse(c.constraints || '[]')).map((x) => `- ${x}`).join('\n') || '（无）'}`;

/**
 * 方案落库。**一个事务**：节点、依赖边、出处边、决策记录、审计一起成立或一起不成立。
 * 出处边若晚于主记录落库，中间那一刻的数据是无出处的，
 * 而下游装配随时可能读走它 —— 事后巡检不是闸门。
 */
export function persistPlan(db, { taskId, constitutionId, nodes, rationale }) {
  const t = now();
  const idOf = new Map();
  return db.tx(() => {
    for (const n of nodes) idOf.set(n.key, newId('n'));

    for (const n of nodes) {
      const id = idOf.get(n.key);
      db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
              VALUES (?,?,?,?,?,'pending',?,?,?)`,
        id, taskId, n.title, n.spec, n.acceptance, n.risk_tier, n.model_tier, t);
      // 出处：每个节点都源自这一版宪法块。这是"当时依据什么"的锚点
      insertEdge(db, id, constitutionId, 'derived_from', t);
    }
    for (const n of nodes) {
      for (const d of n.depends_on) insertEdge(db, idOf.get(n.key), idOf.get(d), 'depends_on', t);
    }

    const decisionId = newId('d');
    db.run(`INSERT INTO decisions (id,task_id,summary,rationale,actor_kind,actor_id,layer,valid_from,recorded_at)
            VALUES (?,?,?,?,'agent','planner','execution',?,?)`,
      decisionId, taskId, tl(contentLang(db), '任务分解为 {n} 个节点', { n: nodes.length }), rationale, t, t);
    insertEdge(db, decisionId, constitutionId, 'derived_from', t);

    audit(db, {
      actorKind: 'agent', actorId: 'planner', action: 'plan_persisted',
      targetType: 'task', targetId: taskId,
      payload: { nodeIds: [...idOf.values()], count: nodes.length },
    });
    return [...idOf.values()];
  });
}
