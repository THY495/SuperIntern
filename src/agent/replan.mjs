// 重规划器 —— 修正处理五步流水线的 LLM 子程序部分。
//
// **押注的假设是①的加强版**：模型产出的不是一份新 DAG，而是一份**对既有 DAG
// 的修正**，且要同时满足库层护栏与"不把已完成工作无差别作废"。
//
// ⚠️ 这里有一个**便宜的作弊出口**，整个 schema 都是围着它设计的：
// 把所有已完成节点标成"作废、重做"，重规划就退化成从零规划 ——
// 而那是模型**已经会做的事**。规划器上的教训（给 LLM 子程序只留一个出口，
// "这件事没法合法地做"就只剩伪造这一条路）在这里换了个形状重现：
// 给一个便宜的出口，就会走那个出口。
//
// 三道东西合起来堵它，**都不靠提示词**：
//   ① `impact` 必须**逐一覆盖每个现存节点**，每条带理由 —— 作废要一个个说出口
//   ② 结构校验：非作废节点不得依赖已作废节点 —— 想作废一个就得处理它的下游
//   ③ 确认门按**花费金额**算"要重来"的比例（作废 + 重做），超阈值就得等人批准
// ①③ 让作废有代价，② 让作废有连带工作。
//
// ⚠️ ② 曾经是一条**只有一个出口的护栏**，而上面那条教训正是"只留一个出口就会
// 逼出伪造"。实测中出现过：`changed_nodes`
// 里没有 `depends_on`，于是"这个节点还要做、只是别再依赖那个作废的"无法表达，
// 模型只好把 3 个 pending 节点标作废、再建 3 个一模一样的替身 ——
// 决策日志因此多了三条"此路径因修正作废"的**假记录**。
// 护栏没被违反，它被**绕过**了，代价记在审计轨上。现在 ② 认的是修正**之后**的
// 依赖，`changed_nodes.depends_on` 是那条本来就该有的合法出口。
//
// ⚠️ 原本这里写的是"提示词只负责把这三条讲清楚"。**消融实测推翻了它**：
// 删掉提示词里那三条说明之后，模型对同一条修正给出的
// 策略完全不同 —— 从"加 3 个新节点、旧节点全不动"变成"把 3 个已完成节点全部
// 标 needs_change 退回重做"。提示词不是在防退化，它在**决定模型对"修正"的整体读法**。
// 那比"讲清楚"重得多，也脆得多：护栏能靠校验器兜底，策略不能。

import { withOutputLang, contentLang, tl } from '../i18n/index.mjs';
import { runToolLoop } from '../llm/client.mjs';
import { textOf } from '../llm/canonical.mjs';
import { newId, now, audit } from '../db/db.mjs';
import { validateNodeSet, constitutionText } from './planner.mjs';
import { overruledContractRules, renderOverruled } from '../core/decisions.mjs';

export const IMPACT_MARKS = {
  unaffected: '无关 —— 这条修正不影响它，照原样做/保留',
  needs_change: '需修改 —— 目标不变但规格/验收要改',
  obsolete: '已作废 —— 这条修正之后它不该再存在',
};

export const DISPOSITIONS = {
  keep_all: '产物全保留 —— 它仍然有用',
  partial: '部分可抢救 —— 说清哪部分留、哪部分不算数',
  discard: '彻底放弃 —— **但不删代码**，git 历史保底，只在决策日志记一笔',
};

const SUBMIT_REVISION = {
  name: 'submit_revision',
  description: '提交对既有计划的修正方案。**这不是重新规划** —— 你要产出的是一份 diff：'
    + '哪些节点不受影响、哪些要改、哪些作废、要新增什么。\n'
    + '⚠️ 把已完成的节点大批标成作废，是最省事也最坏的做法：它把"修正"变成"推倒重来"，'
    + '扔掉的是真花过钱、真跑过测试的工作。**作废比例按花费金额算，超过阈值会转成'
    + '需要人批准的问题**，而人会看到你给每一条写的理由。',
  parameters: {
    type: 'object',
    properties: {
      impact: {
        type: 'array',
        description: '逐节点影响标记。**必须覆盖每一个现存节点，一个不漏、一个不重**。',
        items: {
          type: 'object',
          properties: {
            node_id: { type: 'string' },
            mark: { type: 'string', enum: Object.keys(IMPACT_MARKS),
              description: Object.entries(IMPACT_MARKS).map(([k, v]) => `${k}=${v}`).join('；') },
            reason: { type: 'string',
              description: '为什么是这个标记。标 obsolete 的要说清**修正里的哪句话**让它不该存在了。' },
          },
          required: ['node_id', 'mark', 'reason'],
        },
      },
      salvage: {
        type: 'array',
        description: '已完成（done）且标记不是 unaffected 的节点，逐个判定产物怎么处置。'
          + '没完成的节点不用填 —— 它们没有产物可抢救。',
        items: {
          type: 'object',
          properties: {
            node_id: { type: 'string' },
            disposition: { type: 'string', enum: Object.keys(DISPOSITIONS),
              description: Object.entries(DISPOSITIONS).map(([k, v]) => `${k}=${v}`).join('；') },
            note: { type: 'string', description: 'partial 必须说清哪部分留、哪部分不算数。' },
          },
          required: ['node_id', 'disposition', 'note'],
        },
      },
      changed_nodes: {
        type: 'array',
        description: '标了 needs_change 的节点的新内容。只写要改的字段。',
        items: {
          type: 'object',
          properties: {
            node_id: { type: 'string' },
            title: { type: 'string' }, spec: { type: 'string' }, acceptance: { type: 'string' },
            depends_on: { type: 'array', items: { type: 'string' },
              description: '**改依赖边用这个。** 给了就是整条替换（不是追加）；里面可以写现存节点的 id，'
                + '也可以写本次新增节点的 key。只想改依赖、不改规格时，只填这一项就够了。\n'
                + '⚠️ 不要为了绕开"没法改依赖"而把一个还要做的节点标成作废、再新建一个内容一样的：'
                + '那会在决策日志里留下一条"此路径因修正作废"的**假记录**，而那条记录事后是查得到的。' },
          },
          required: ['node_id'],
        },
      },
      new_nodes: {
        type: 'array',
        description: '要新增的节点。形状与规划器一致。`depends_on` 里可以写**现存节点的 id**，'
          + '也可以写本次新增节点的 key。',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' }, title: { type: 'string' },
            spec: { type: 'string' }, acceptance: { type: 'string' },
            risk_tier: { type: 'string', enum: ['low', 'normal', 'high'] },
            model_tier: { type: 'string', enum: ['light', 'standard', 'heavy'] },
            depends_on: { type: 'array', items: { type: 'string' } },
          },
          required: ['key', 'title', 'spec', 'acceptance', 'risk_tier', 'model_tier', 'depends_on'],
        },
      },
      constitution_patch: {
        type: 'object',
        description: '**只在这条修正改的是任务本身（目标/范围/完成定义/约束）时才填。**\n'
          + '填了就意味着触及宪法层 —— 那一律要人批准，agent 无权自行改宪法块。\n'
          + '不确定算不算触及时**倾向于填**：多问一次的代价是等人回一句，'
          + '不问的代价是照着一个已经不对的目标继续做下去。',
        properties: {
          goal: { type: 'string' }, scope: { type: 'string' },
          scope_paths: { type: 'array', items: { type: 'string' },
            description: '范围的**路径形式**（越界校验只认这一份）。改了上面那段 scope 散文就几乎一定要连它一起改 —— '
              + '目录写成 src/a/，具体文件写全名；不填 = 沿用旧值。' },
          definition_of_done: { type: 'string' },
          constraints: { type: 'array', items: { type: 'string' } },
        },
      },
      rationale: { type: 'string', description: '整体判断：这条修正到底在改什么，你为什么这样切。' },
    },
    required: ['impact', 'rationale'],
  },
};

/**
 * @param {boolean} ablate  消融臂：删掉那三条硬约束的**说明**（校验器照旧生效）。
 *   它要回答的问题是"**是提示词在起作用，还是模型本来就不会那么做**" ——
 *   两者对设计的含义完全不同：前者说明提示词在扛事（那是最脆的一种护栏），
 *   后者说明校验器与门才是真正起作用的东西。
 *   分不开的话，"模型表现好"这个观察就同时兼容两个互斥的解释。
 */
const systemPrompt = (ablate = false) => `你是一个长期运行的自主 agent 的**重规划器**。

任务已经有一份计划，其中一些节点已经做完并留下了产物。现在人经认证通道发来了
一条修正指令。你的活是产出一份**计划 diff**，不是产出一份新计划。
${ablate ? '' : `
三条硬约束（不是建议，是结构性的，违反会被校验直接拒回）：

1. **impact 必须覆盖每一个现存节点**，一个不漏、一个不重。
2. **非作废的节点不能依赖已作废的节点。** 你要作废一个节点，就得同时处理它的下游 ——
   要么一起作废，要么用 changed_nodes 的 \`depends_on\` 把它的依赖改掉。
   **不要**把一个还要做的节点标成作废、再新建一个内容一样的替身来绕开这一条：
   那会在决策日志里留下"此路径因修正作废"的假记录。改依赖有专门的字段。
3. **作废已完成的工作是有代价的。** 它按花费金额计比例；超过阈值这份方案就不会
   自动生效，而是转成一条要人批准的问题。所以只在真的必须时作废。
`}
关于"改的是任务本身"：如果这条修正实际上是在改目标、范围、完成定义或约束，
那属于宪法层 —— 填 constitution_patch，让人来批。**你无权自己改宪法块。**

如果这条修正含糊到你无法判断影响范围，用 raise_question 问，不要猜着改。`;

const RAISE_QUESTION = {
  name: 'raise_question',
  description: '修正指令含糊到无法判断影响范围时用。不要用它问你自己看得出来的事。',
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'integer', enum: [1, 2, 3] },
      text: { type: 'string' },
      default_action: { type: 'string', description: '仅 Ⅰ/Ⅱ 级填' },
      blocked_by: { type: 'string', description: '修正里的哪一句让你卡住，原文引用' },
      kind: { type: 'string', enum: ['spec', 'structural'], description: 'spec=修正的意图要人取舍；structural=修正与现有契约 / 结构矛盾。决定问题路由给谁' },
    },
    required: ['level', 'text', 'blocked_by'],
  },
};

/**
 * 方案的结构校验。**纯状态机，不调模型。**
 *
 * 与 `validatePlan` 分工：那个管"一份计划本身合不合法"，这个管"一份 diff 与
 * 既有状态对不对得上"。新增节点部分复用 validateNodeSet —— 新增的东西没有
 * 理由比一开始规划出来的东西宽松。
 */
export function validateRevision(rev, { nodes, constitution = null }) {
  const errs = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const impact = rev?.impact ?? [];

  // ① 覆盖性。漏一个 = 有个节点的命运没人交代；重一个 = 两条互相矛盾的交代。
  const seen = new Map();
  for (const [i, m] of impact.entries()) {
    if (!byId.has(m?.node_id)) { errs.push(`impact[${i}] 的 node_id \`${m?.node_id}\` 不是本任务的节点`); continue; }
    if (!IMPACT_MARKS[m.mark]) { errs.push(`impact[${i}] 的 mark 取值不合法：${m.mark}`); continue; }
    if (!m.reason?.trim()) { errs.push(`impact[${i}] \`${m.node_id}\` 缺 reason —— 每一条影响判断都要说出口`); }
    if (seen.has(m.node_id)) { errs.push(`节点 \`${m.node_id}\` 被标了两次`); continue; }
    seen.set(m.node_id, m.mark);
  }
  const missing = nodes.filter((n) => !seen.has(n.id));
  if (missing.length) {
    errs.push(`impact 漏了 ${missing.length} 个节点：${missing.map((n) => `\`${n.id}\`(${n.title.slice(0, 20)})`).join('、')}`
      + ` —— 必须逐一交代，"没提到"不等于"无关"`);
  }

  // ② 非作废节点不得依赖已作废节点。想作废一个就得处理它的下游。
  //
  // ⚠️ 口径是**修正之后**的依赖，不是库里现在的依赖。原因：
  // `changed_nodes` 原来只能改
  // title/spec/acceptance，**没有 depends_on** —— 于是"这个节点还要做，
  // 只是不该再依赖那个被作废的家伙"在 schema 里根本没有合法说法。
  //
  // 模型自己把这条死路说了出来，并绕了过去：把 3 个 pending 节点标成 obsolete、
  // 再新建 3 个内容一模一样的替身，理由写着"changed_nodes 无法修改依赖边"。
  // 结果是 applyRevision 在决策日志里写下三条"此路径因修正作废" ——
  // **那是假记录**：没有任何路径被放弃，只是边要挪一下。
  // 护栏逼出一条绕行路，绕行路把审计轨写脏了。补 depends_on 是唯一的修法。
  const changedNodes = new Map((rev?.changed_nodes ?? []).map((c) => [c?.node_id, c]));
  const effDeps = (n) => {
    const c = changedNodes.get(n.id);
    return Array.isArray(c?.depends_on) ? c.depends_on : (n.deps ?? []);
  };
  const voided = new Set([...seen].filter(([, m]) => m === 'obsolete').map(([id]) => id));
  for (const n of nodes) {
    const mark = seen.get(n.id);
    if (!mark || mark === 'obsolete') continue;
    for (const dep of effDeps(n)) {
      if (voided.has(dep)) {
        errs.push(`\`${n.id}\` 标了 ${mark}，却依赖已作废的 \`${dep}\` —— `
          + `要作废一个节点，就得同时处理它的下游：一起作废，或用 `
          + `changed_nodes 的 depends_on 改成不依赖它`);
      }
    }
  }

  // ③ 已完成且受影响的节点必须逐个交代产物怎么处置（流水线第 2 步：已完成工作分捡）
  const salv = new Map((rev?.salvage ?? []).map((s) => [s?.node_id, s]));
  for (const n of nodes) {
    const mark = seen.get(n.id);
    if (n.status !== 'done' || !mark || mark === 'unaffected') continue;
    const s = salv.get(n.id);
    if (!s) { errs.push(`\`${n.id}\` 已完成且标了 ${mark}，但 salvage 里没有它 —— 产物怎么处置要说清`); continue; }
    if (!DISPOSITIONS[s.disposition]) errs.push(`salvage \`${n.id}\` 的 disposition 不合法：${s.disposition}`);
    if (s.disposition === 'partial' && !s.note?.trim()) {
      errs.push(`salvage \`${n.id}\` 是 partial 却没说清哪部分留、哪部分不算数`);
    }
  }

  // ④ needs_change 必须给出新内容，否则"要改"是一句空话。
  //    `depends_on` 算一种新内容 —— "只挪一条依赖边"是一次真改动，
  //    不承认它，就等于把模型逼回"作废再重建"那条脏路。
  for (const [id, mark] of seen) {
    if (mark !== 'needs_change') continue;
    const c = changedNodes.get(id);
    if (!c) { errs.push(`\`${id}\` 标了 needs_change，但 changed_nodes 里没有它 —— 要改成什么样？`); continue; }
    if (!c.title?.trim() && !c.spec?.trim() && !c.acceptance?.trim() && !Array.isArray(c.depends_on)) {
      errs.push(`changed_nodes \`${id}\` 一个字段都没给 —— 那不叫"需修改"`);
    }
  }
  // changed_nodes 只对标了 needs_change 的节点有意义。写给别的节点是
  // **一次静默的改动**：它不会出现在 impact 里，人看 diff 时看不到。
  for (const c of rev?.changed_nodes ?? []) {
    const mark = seen.get(c?.node_id);
    if (mark && mark !== 'needs_change') {
      errs.push(`changed_nodes 里有 \`${c.node_id}\`，但它在 impact 里标的是 ${mark} —— `
        + `要改它就标 needs_change，否则这处改动不会出现在给人看的 diff 里`);
    }
  }

  // ⑤ 新增节点走与规划器**同一套**护栏。新增的东西没理由比原规划宽松。
  const news = rev?.new_nodes ?? [];
  if (news.length) {
    const existingIds = new Set(nodes.filter((n) => seen.get(n.id) !== 'obsolete').map((n) => n.id));
    // validateNodeSet 只认本批次内的 key；先把指向现存节点的依赖摘出来单独查，
    // 剩下的交给它 —— 复用而不是复制，两套护栏迟早会分叉。
    const localised = news.map((n) => ({
      ...n, depends_on: (n.depends_on ?? []).filter((d) => !existingIds.has(d)),
    }));
    // 宪法子串核对：新增节点的 rules 与规划器同一条判据 —— 引用的〔规格〕原文必须真在宪法块里。
    errs.push(...validateNodeSet(localised, { constitutionText: constitution ? constitutionText(constitution) : null }).map((e) => `new_nodes: ${e}`));
    for (const n of news) {
      for (const d of n.depends_on ?? []) {
        if (existingIds.has(d)) continue;
        if (voided.has(d)) errs.push(`new_nodes \`${n.key}\` 依赖了已作废的 \`${d}\``);
      }
    }
  }

  // ⑥ 改完依赖之后，整张图还得是一张 DAG。
  //
  // 这条是 ⑤ 的必然代价：一旦允许 changed_nodes 重写依赖边，"新增节点内部无环"
  // 就不够了 —— 环可以横跨新旧。这里按**修正之后**的全图重算一遍：
  // 存活的现存节点（用 effDeps）+ 新增节点（key 可指向现存 id）。
  // 允许改依赖却不查环，比不允许改依赖更糟：前者能造出一张永远没有起点的图。
  {
    const alive = nodes.filter((n) => seen.get(n.id) !== 'obsolete');
    const aliveIds = new Set(alive.map((n) => n.id));
    const newKeys = new Set(news.map((n) => n?.key).filter(Boolean));
    const legal = (d) => aliveIds.has(d) || newKeys.has(d);

    for (const n of alive) {
      if (!Array.isArray(changedNodes.get(n.id)?.depends_on)) continue;   // 没改就没什么可查
      for (const d of effDeps(n)) {
        if (d === n.id) errs.push(`changed_nodes \`${n.id}\` 的 depends_on 里有它自己`);
        else if (!legal(d)) {
          errs.push(`changed_nodes \`${n.id}\` 的 depends_on 指向 \`${d}\` —— `
            + `既不是存活的现存节点，也不是本次新增节点的 key`
            + `${voided.has(d) ? '（它这次被作废了）' : ''}`);
        }
      }
    }
    if (!errs.length) {
      const adj = new Map([
        ...alive.map((n) => [n.id, effDeps(n).filter(legal)]),
        ...news.map((n) => [n.key, (n.depends_on ?? []).filter(legal)]),
      ]);
      const indeg = new Map([...adj].map(([k, ds]) => [k, ds.length]));
      const queue = [...indeg].filter(([, d]) => d === 0).map(([k]) => k);
      let visited = 0;
      while (queue.length) {
        const k = queue.shift(); visited++;
        for (const [id, ds] of adj) {
          if (!ds.includes(k)) continue;
          indeg.set(id, indeg.get(id) - 1);
          if (indeg.get(id) === 0) queue.push(id);
        }
      }
      if (visited !== adj.size) {
        errs.push(`修正之后的依赖图有环，没有可执行的起点 —— `
          + `${[...indeg].filter(([, d]) => d > 0).map(([k]) => `\`${k}\``).join('、')} 卡在环里`);
      }
    }
  }

  // ⑦ 宪法补丁的形状。**这一格原来一条校验都没有**，而它是整个 schema 里最危险的一格。
  //
  // 曾出现过：模型把
  // `constitution_patch` 交成了一个**字符串**，内容是一段
  // `<parameter name="goal">…</parameter>` 的原始工具调用文本。后果连成一串：
  //   - `gateOf` 用 `Object.keys(patch).length` 判空 → 字符串给出 402 → 门触发。
  //     **凑巧对了，但理由是错的**，而凑巧对的护栏下次就会凑巧不对。
  //   - `renderDiff` 逐 entry 打印 → 给人看的是 402 行、每行一个字。
  //   - `applyRevision` 取 `patch.goal ?? cur.goal` → `undefined ?? 旧值` →
  //     宪法**升到 v2、四个字段一字未改**，还记一条"宪法块修订至 v2"的决策。
  //     人批准的是"改目标"，落库的是"什么都没改"，而审计轨说改过了。
  //
  // 最后那一条是真正的问题：**静默的无操作比报错坏得多**。
  // 多厂商是硬约束，各家把嵌套对象参数序列化成什么样并不统一 ——
  // 所以这条校验必须住在模型外，不能指望"换一家就好了"。
  if (rev?.constitution_patch !== undefined && rev.constitution_patch !== null) {
    const p = rev.constitution_patch;
    // scope_paths（v17）是越界校验的判据；改 scope 散文时常常要连它一起改，所以它必须是个可改的字段。
    // 不填就沿用旧值 —— 见 revision.mjs 里那条注释：漏掉它会把判据悄悄清空，而且没有任何报错。
    const FIELDS = { goal: 'string', scope: 'string', scope_paths: 'array', definition_of_done: 'string', constraints: 'array' };
    if (typeof p !== 'object' || Array.isArray(p)) {
      errs.push(`constitution_patch 必须是对象，收到 ${Array.isArray(p) ? 'array' : typeof p}`
        + `${typeof p === 'string' ? `（前 60 字：${p.slice(0, 60)}）` : ''} —— `
        + `要改哪一层就填哪个字段（${Object.keys(FIELDS).join(' / ')}），不要把它整段塞成文本`);
    } else {
      const keys = Object.keys(p);
      if (!keys.length) {
        errs.push('constitution_patch 是空对象 —— 不改宪法就别填这一格，'
          + '填了空对象只会白白触发一次确认门，让人白等一轮');
      }
      for (const k of keys) {
        if (!FIELDS[k]) { errs.push(`constitution_patch 里有不认识的字段 \`${k}\` —— `
          + `只有 ${Object.keys(FIELDS).join(' / ')} 会被应用，写别的等于什么都没改`); continue; }
        const okType = FIELDS[k] === 'array'
          ? Array.isArray(p[k]) && p[k].every((x) => typeof x === 'string')
          : typeof p[k] === 'string' && p[k].trim();
        if (!okType) errs.push(`constitution_patch.${k} 类型不对：应为 ${FIELDS[k] === 'array' ? '字符串数组' : '非空字符串'}`);
      }
    }
  }

  if (!rev?.rationale?.trim()) errs.push('缺 rationale —— 这份 diff 整体在改什么，要说出口');
  return errs;
}

/** 一份补丁里**真正会被应用**的字段。gateOf / applyRevision 共用，免得两边口径分叉。 */
export const patchFields = (patch) => (
  patch && typeof patch === 'object' && !Array.isArray(patch)
    ? Object.keys(patch).filter((k) => ['goal', 'scope', 'scope_paths', 'definition_of_done', 'constraints'].includes(k))
    : []);

/**
 * 跑一次重规划。返回 `{kind:'revision'|'question'|'failed'}`。
 *
 * 与规划器同构：产出被校验拒回时把错误原样喂回去重试，**不放宽校验**。
 */
/**
 * 这条修正里有说法撞上过仍然有效的旧决定，人已经裁定过了。重规划器必须知道裁定结果，
 * 否则"以旧为准"只是登记表里的一行，修正照样被执行（曾出现过：裁定已结案，几分钟后照样生成了变更）。
 * 以旧为准时只挡**撞上的那一句**：一条打回理由常有三点、只有一点撞了，整条驳回会丢掉另外两点。
 */
export function renderVerdicts(db, verdicts = []) {
  if (!verdicts?.length) return '';
  const nameOf = (u) => (u && db.one('SELECT display_name FROM users WHERE id=?', u)?.display_name) || u || '（未记录）';
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
  const lines = verdicts.map((v) => {
    const ds = v.decisions.map((d) => `「${d.subject}」：${String(d.statement).slice(0, 200)}`).join('\n    ');
    const who = `${nameOf(v.by)}${v.at ? ` ${day(v.at)} ` : ''}`;
    if (v.verdict === 'old') {
      return `- **以旧为准**（${who}裁定）。下面这条旧决定**继续有效**：\n    ${ds}\n  `
        + '上面这条修正里与它相冲的那部分**不要执行**，也不要换个说法绕着执行；修正里其余与它无关的部分照常处理。'
        + '若整条修正只有这一点，就交一份所有节点都是 unaffected 的 diff。';
    }
    if (v.verdict === 'new') return `- **以新为准**（${who}裁定）。下面这条旧决定**已作废**，修正照做：\n    ${ds}`;
    return `- 裁定人认为**不冲突**（${who}）。修正照做；下面这条旧决定仍然有效：\n    ${ds}`;
  });
  return `
# 这条修正撞上过旧决定，已由人裁定

比对器发现这条修正里有说法与项目里仍然有效的决定对不上，挂了冲突事项，人已经给了结论。
**结论具有指令效力**，与修正本身同级：

${lines.join('\n')}
`;
}

export async function replan(db, {
  client, taskId, constitution, message, nodes, tier = 'heavy', maxAttempts = 3, ablatePrompt = false, verdicts = [],
}) {
  const nodeList = nodes.map((n) => `- \`${n.id}\`　[${n.status}]　${n.title}\n`
    + `    规格：${String(n.spec).slice(0, 300)}\n`
    + `    验收：${String(n.acceptance).slice(0, 200)}\n`
    + `    依赖：${n.deps?.length ? n.deps.map((d) => `\`${d}\``).join('、') : '（无）'}`
    + `${n.status === 'done' ? `\n    产物：${n.artifacts ?? '（无记录）'}　花费：$${((n.microUsd ?? 0) / 1e6).toFixed(4)}` : ''}`)
    .join('\n');

  const user = `# 任务宪法（v${constitution.version}）

## 目标
${constitution.goal}

## 范围
${constitution.scope}

## 完成定义
${constitution.definition_of_done}

## 约束
${JSON.parse(constitution.constraints || '[]').map((x) => `- ${x}`).join('\n') || '（无）'}

${((ov) => (ov ? `${ov}\n\n` : ''))(renderOverruled(db, overruledContractRules(db, taskId)))}# 现有计划

${nodeList}

# 人发来的修正指令

> ${String(message.body).replace(/\n/g, '\n> ')}

—— 经**认证通道**写入（trust_label=${message.trust_label}），具有指令效力。
它不能改变宪法块本身；若它实际上是在改目标/范围/完成定义/约束，
那要走 constitution_patch 交人批准。
${renderVerdicts(db, verdicts)}
现在产出你的计划 diff。`;

  const rejections = [];
  let messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let out = null;
    const loop = await runToolLoop(client, {
      tier, system: withOutputLang(systemPrompt(ablatePrompt), contentLang(db)), messages, tools: [SUBMIT_REVISION, RAISE_QUESTION],
      maxTokens: 16000, effort: 'high',
    }, {
      submit_revision: async (args) => {
        const errs = validateRevision(args, { nodes, constitution });
        if (errs.length) { out = { kind: 'rejected', errs }; return `方案被拒，修好再交：\n- ${errs.join('\n- ')}`; }
        out = { kind: 'revision', args };
        return '方案已受理。不要再调用任何工具。';
      },
      raise_question: async (args) => { out = { kind: 'question', args }; return '问题已记录。不要再调用任何工具。'; },
    }, { maxIterations: 3, shouldStop: () => out !== null && out.kind !== 'rejected' });

    audit(db, { actorKind: 'agent', actorId: 'replanner', action: 'replan_attempt',
      targetType: 'task', targetId: taskId,
      payload: { attempt, messageId: message.id, tier, kind: out?.kind ?? 'none',
        errs: out?.kind === 'rejected' ? out.errs : undefined, stopped: loop.stopped, pid: process.pid } });

    if (out?.kind === 'revision') return { kind: 'revision', args: out.args, attempts: attempt, rejections };
    if (out?.kind === 'question') return { kind: 'question', args: out.args, attempts: attempt, rejections };
    if (out?.kind === 'rejected') {
      rejections.push(out.errs);
      // 把错误原样喂回去。**不放宽校验** —— 校验说的是结构性事实，
      // 放宽它等于把"模型做不到"翻译成"其实也可以"。
      messages = [...messages,
        { role: 'assistant', content: loop.resp?.content ?? [{ type: 'text', text: '(空)' }] },
        { role: 'user', content: [{ type: 'text', text: `方案没通过校验：\n- ${out.errs.join('\n- ')}\n\n修好重交。` }] }];
      continue;
    }
    return { kind: 'failed', why: loop.stopped, say: textOf(loop.resp ?? { content: [] }).slice(0, 600),
      attempts: attempt, rejections };
  }
  return { kind: 'failed', why: tl(contentLang(db), '{n} 次尝试都没通过校验', { n: maxAttempts }), attempts: maxAttempts, rejections };   // why 会进【改计划没成】事项正文
}
