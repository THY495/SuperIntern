// 修正流水线的**确定性部分**（作废留痕、计划 diff、确认门）。
//
// 分工：模型判"这条修正影响了什么"（那是语义判断，`replan.mjs`），
// 状态机判"这份方案要不要人批准、批准之后怎么落库"（那是比较与写入）。
// 确认门尤其**不能**交给模型：它算的是"作废掉的钱占已完成的钱多少比例"，
// 一次比较就够，而让模型自评"我扔掉的算多吗"等于请它给自己打分。
//
// ⚠️ 一条要记住的警惕：
// **30% 阈值不是安全护栏，是麻烦度阈值。** 它挡"悄悄扔掉大量已完成工作"，
// 挡不住"扔掉少量关键工作"。真正的护栏是逐节点影响标记进 `revisions` 表 ——
// 每一次作废都有出处、有理由、事后查得到。把 30% 当护栏用，
// 就是又造一个"填个数就能满足"的假护栏。

import { routeQuestion, decisionTypeOfQuestion } from './routing.mjs';
import { newId, now, audit, insertEdge } from '../db/db.mjs';
import { markConsumed } from './inbox.mjs';
import { clearNodeBaseline } from './workspace.mjs';
import { patchFields } from '../agent/replan.mjs';
import { recordFromRevision, recordReservation } from './decisions.mjs';
import { normScopePaths } from './project.mjs';
import { RESOLUTION_HOOKS, revisionSide } from './answers.mjs';
import { reservationOf } from '../agent/approval.mjs';

export const DISCARD_THRESHOLD_KEY = 'revision.discard_threshold';
export const DEFAULT_DISCARD_THRESHOLD = 0.30;   // 确认门，"阈值可配置"
// 比例之外的**金额下限**：小任务里同一个文档节点每返工一次，"要重来的占比"
// 就可能过 30%（实测见过 40.3%、46.0%），每次都要负责人批一轮。门本来是拦"悄悄扔掉**大量**已完成工作"的，
// 而"大量"在一个总花费 $0.81 的任务里根本凑不出来 —— 比例算的是相对量，拦的却该是绝对量。
// 所以比例触发器多一个与门条件：受影响的钱要**同时**够得上这个下限。
// 下限只管比例这一路；宪法补丁那一路不受它影响（那是范围问题，不是金额问题，一分钱也要问）。
export const DISCARD_FLOOR_KEY = 'revision.discard_floor_usd';
export const DEFAULT_DISCARD_FLOOR_USD = 0.20;

const paramNum = (db, taskId, key) => {
  const row = db.one(`SELECT value FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL
                      ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, taskId, key);
  return row ? Number(JSON.parse(row.value)) : null;
};
export const thresholdOf = (db, taskId) => {
  const v = paramNum(db, taskId, DISCARD_THRESHOLD_KEY);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_DISCARD_THRESHOLD;
};
/** 金额下限，返回 micro USD。设成 0 就是回到只看比例的旧行为。 */
export const floorMicroOf = (db, taskId) => {
  const v = paramNum(db, taskId, DISCARD_FLOOR_KEY);
  return Math.round((Number.isFinite(v) && v >= 0 ? v : DEFAULT_DISCARD_FLOOR_USD) * 1e6);
};

/**
 * 重规划器要看的任务现状。**每个节点带上它花了多少钱** ——
 * "工作量"口径定为花费金额而非节点数，理由是节点数会把
 * "作废一个跑了三小时的重档节点"与"作废一个五分钟的轻活"算成等重。
 */
export function nodesForReplan(db, taskId) {
  return db.all(`SELECT * FROM nodes WHERE task_id=? ORDER BY created_at, id`, taskId).map((n) => ({
    ...n,
    deps: db.all(`SELECT to_id FROM edges WHERE from_id=? AND relation='depends_on'
                  AND superseded_at IS NULL`, n.id).map((e) => e.to_id),
    microUsd: db.one(`SELECT COALESCE(SUM(micro_usd),0) AS m FROM usage_ledger WHERE node_id=?`, n.id).m,
    artifacts: db.one(`SELECT artifacts FROM handoffs WHERE node_id=?`, n.id)?.artifacts ?? null,
  }));
}

/**
 * 确认门。**纯比较，零 LLM 调用。**
 *
 * 两个独立触发器，强度不同，这一点要说清楚：
 *   - `constitution_patch` 非空 → 触发。这是**模型自己声明**的，它可以不填而绕过 ——
 *     所以它是软信号。但它比一个 `touches_constitution: true` 的布尔强：
 *     补丁是具体内容，写出来就能被人核对，编不出一个"看起来无害"的版本。
 *   - 作废比例超阈值 → 触发。这是**状态机算的**，绕不过去。硬信号。
 *
 * 两个都不触发时方案直接生效并推 diff（"修正仅涉执行层 → diff 推送后直接继续"）。
 */
export function gateOf(db, { taskId, rev, nodes }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const marks = new Map((rev.impact ?? []).map((m) => [m.node_id, m.mark]));
  const salv = new Map((rev.salvage ?? []).map((s) => [s.node_id, s.disposition]));

  const done = nodes.filter((n) => n.status === 'done');
  const doneMicro = done.reduce((s, n) => s + (n.microUsd ?? 0), 0);

  // ⚠️ 口径是"**这条修正让多少已完成的工作要重来**"，不是"多少被删掉"。
  //    这是对原始设计（"作废工作量超过已完成工作量的 30%"）的一处**有意收窄之外的扩张**，
  //    理由是实际出现过：
  //
  //    模型把 3 个已完成节点**全部标成 needs_change**、salvage 全是 keep_all/partial，
  //    于是 applyRevision 把它们统统退回 pending 重做（$4.22 的活），
  //    而只数作废的确认门报的是"**作废 0.0%**" —— 一份提议重做全部已完成工作的方案，
  //    在门这里看起来毫无风险。
  //
  //    **重做和作废花的是同样的钱**，差别只在产物还在不在。只数作废，等于给
  //    "全标 needs_change" 留了一条比 "全标 obsolete" 更划算的绕行路 ——
  //    而那正是这套门本来要堵的那个便宜出口，只是换了个标签。
  //    （与 `verified_against='none'` 被换标签绕过是同一个形状。）
  const discarded = done.filter((n) => marks.get(n.id) === 'obsolete');
  const redone = done.filter((n) => marks.get(n.id) === 'needs_change');
  const discardedMicro = discarded.reduce((s, n) => s + (n.microUsd ?? 0), 0);
  const redoneMicro = redone.reduce((s, n) => s + (n.microUsd ?? 0), 0);
  // `partial` 只作为**披露**，不进分子：它自称留了一部分，而"留了多少"没法机械判定；
  // 算全丢会高估、算没丢会低估，两边都是编数字。条数照报，让人自己看。
  const partials = done.filter((n) => salv.get(n.id) === 'partial');
  const affectedMicro = discardedMicro + redoneMicro;   // 两者互斥：一个节点只有一个标记
  const ratio = doneMicro > 0 ? affectedMicro / doneMicro : 0;
  const threshold = thresholdOf(db, taskId);
  const floorMicro = floorMicroOf(db, taskId);

  const reasons = [];
  // ⚠️ 判空口径从 `Object.keys(patch).length` 换成"真正会被应用的字段有几个"。
  // 前者在补丁是**字符串**时给出它的长度（例如 402），门因此会触发，
  // 但那是凑巧对的。凑巧对的护栏下次会凑巧不对。
  // 另一头留一条兜底：形状不对但非空 → 照样触发门。校验器本该先拦住它，
  // 万一漏过来，宁可多问一次人，也不要让一份看不懂的宪法补丁悄悄生效。
  const patched = patchFields(rev.constitution_patch);
  if (patched.length) {
    reasons.push(`触及宪法层（方案要改 ${patched.join(' / ')}）—— agent 无权自行改宪法块`);
  } else if (rev.constitution_patch) {
    reasons.push('方案带了 constitution_patch 但形状不对（没有一个字段会被应用）—— '
      + '这本身就该人来看一眼，不能当成"没填"放过去');
  }
  // 比例与金额是**与**关系：占比过阈值、且受影响的钱够得上下限，才值得打断一个人。
  const overRatio = ratio > threshold;
  const belowFloor = overRatio && affectedMicro < floorMicro;
  if (overRatio && !belowFloor) {
    reasons.push(`要重来的已完成工作占比 ${(ratio * 100).toFixed(1)}% > 阈值 ${(threshold * 100).toFixed(0)}%`
      + `（作废 $${(discardedMicro / 1e6).toFixed(4)} + 重做 $${(redoneMicro / 1e6).toFixed(4)}`
      + ` / 已完成 $${(doneMicro / 1e6).toFixed(4)}，合计 $${(affectedMicro / 1e6).toFixed(4)} ≥ 下限 $${(floorMicro / 1e6).toFixed(2)}）`);
  }
  return {
    gate: reasons.length ? reasons.join('；') : null,
    doneMicro, discardedMicro, redoneMicro, affectedMicro, ratio, threshold, floorMicro, belowFloor,
    discardedNodes: discarded.map((n) => ({ id: n.id, title: n.title, microUsd: n.microUsd })),
    redoneNodes: redone.map((n) => ({ id: n.id, title: n.title, microUsd: n.microUsd })),
    partialNodes: partials.map((n) => ({ id: n.id, title: n.title })),
    counts: { unaffected: 0, needs_change: 0, obsolete: 0, ...tally([...marks.values()]) },
    newCount: (rev.new_nodes ?? []).length,
    byId,
  };
}
const tally = (xs) => xs.reduce((o, x) => ({ ...o, [x]: (o[x] ?? 0) + 1 }), {});

/** 落一份提案。触发门就挂一条 Ⅲ 级 `hard_rule` 问题并冻结任务，否则原样返回待应用。 */
export function proposeRevision(db, { taskId, message, rev, nodes }) {
  const g = gateOf(db, { taskId, rev, nodes });
  const id = newId('rv');
  const t = now();

  return db.tx(() => {
    let questionId = null;
    if (g.gate) {
      questionId = newId('q');
      const text = `【修正需要你批准】\n\n`
        + `人发来的修正：\n> ${String(message.body).replace(/\n/g, '\n> ')}\n\n`
        + `重规划器给出的方案：\n${renderDiff(g, rev)}\n\n`
        + `为什么要你批：${g.gate}\n\n`
        + `这条问题由**状态机**生成、强制定为 Ⅲ 级（触及安全边界或宪法层的操作`
        + `由 harness 定级，不是模型自评）。\n\n`
        + `请选一条。发给了几个人的，可能要几个人都批才生效 —— 还差谁，看这条事项上方的「待…答复」。负责人在任务页「计划变更」卡片上点批准 / 驳回，就等于在这里答了一次，不用再答：\n`
        + `(A) 批准：回「A」—— 够数后变更生效，任务接着跑\n`
        + `(B) 驳回：回「B：理由」—— 计划原样不动，修正记为已处理；要换个改法，再发一条修正\n`
        + `(C) 先看细节：任务页的「计划变更」卡片（改哪几步、新增哪几步、范围怎么变）\n`
        + `(D) 批准，但留一句保留意见：回「A」，另起一行写「保留：……」。\n`
        + `　　**它不挡任何东西**：这份变更照样全部生效，效果与 (A) 一模一样。它只把你那句话留在项目的\n`
        + `　　约定清单上、标成〔保留意见〕，让下一个碰这一处的人看得到。\n`
        + `　　要**挡住**里面某一条，只能 (B) 驳回并说清哪一条不要，让它重出一版 —— 这份方案不能只批一半。`;
      db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,
                asked_at,timeout_at,status) VALUES (?,?,NULL,3,'hard_rule',?,NULL,?,NULL,'open')`,
      questionId, taskId, text, t);
      // 出处：这条问题**因为那条认证消息而存在**。
      insertEdge(db, questionId, message.id, 'derived_from', t);
      routeQuestion(db, { questionId, decisionType: 'contract_approval', typeSource: 'hard_rule', at: t });
      db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
    }

    db.run(`INSERT INTO revisions (id,task_id,message_id,status,impact,salvage,changed_nodes,new_nodes,
              constitution_patch,rationale,done_micro_usd,discarded_micro_usd,gate,question_id,proposed_at)
            VALUES (?,?,?,'proposed',?,?,?,?,?,?,?,?,?,?,?)`,
    id, taskId, message.id, JSON.stringify(rev.impact ?? []), JSON.stringify(rev.salvage ?? []),
    JSON.stringify(rev.changed_nodes ?? []), JSON.stringify(rev.new_nodes ?? []),
    rev.constitution_patch ? JSON.stringify(rev.constitution_patch) : null,
    rev.rationale, g.doneMicro, g.discardedMicro, g.gate, questionId, t);
    insertEdge(db, id, message.id, 'derived_from', t);

    audit(db, { actorKind: 'agent', actorId: 'replanner', action: 'revision_proposed',
      targetType: 'task', targetId: taskId,
      payload: { revisionId: id, messageId: message.id, gate: g.gate, questionId,
        counts: g.counts, newCount: g.newCount, ratio: Number(g.ratio.toFixed(4)),
        threshold: g.threshold, floorMicro: g.floorMicro, belowFloor: g.belowFloor,
        doneMicro: g.doneMicro, discardedMicro: g.discardedMicro,
        discarded: g.discardedNodes, pid: process.pid } });
    return { revisionId: id, gate: g.gate, questionId, summary: g };
  });
}

/**
 * 应用一份提案。**这是唯一改 DAG 的地方。**
 *
 * @param {'auto'|'user'} by  auto=没触发门直接生效；user=人批准的
 */
export function applyRevision(db, { taskId, revisionId, by = 'auto', userId = null, reservation = null }) {
  const rv = db.one(`SELECT * FROM revisions WHERE id=? AND task_id=?`, revisionId, taskId);
  if (!rv) throw new Error(`没有这份提案：${revisionId}`);
  if (rv.status !== 'proposed') throw new Error(`提案 ${revisionId} 状态是 ${rv.status}，不能重复应用`);

  const impact = JSON.parse(rv.impact);
  const salvage = new Map(JSON.parse(rv.salvage).map((s) => [s.node_id, s]));
  const changed = new Map(JSON.parse(rv.changed_nodes).map((c) => [c.node_id, c]));
  const news = JSON.parse(rv.new_nodes);
  const patch = rv.constitution_patch ? JSON.parse(rv.constitution_patch) : null;
  const t = now();

  return db.tx(() => {
    const voided = [], respecced = [], added = [], rewired = [];

    // 新增节点的 id **先分配**：改依赖那一步可能指向本次新增的某个 key，
    // 而那一步在下面的 impact 循环里。先分配 id 就不用把循环拆成三趟。
    const idOf = new Map();
    for (const n of news) idOf.set(n.key, newId('n'));

    for (const m of impact) {
      if (m.mark === 'obsolete') {
        db.run(`UPDATE nodes SET status='void' WHERE id=?`, m.node_id);
        voided.push(m.node_id);
        // "编码场景下'放弃'**不删代码**，在工程笔记记录
        // '此路径因修正 #N 作废'，git 历史保底。" 决策日志就是那本工程笔记。
        const s = salvage.get(m.node_id);
        const did = newId('d');
        db.run(`INSERT INTO decisions (id,task_id,node_id,summary,rationale,actor_kind,actor_id,layer,
                  valid_from,recorded_at) VALUES (?,?,?,?,?,'agent','replanner','execution',?,?)`,
        did, taskId, m.node_id, `节点因修正 ${rv.message_id} 作废`,
        `${m.reason}\n\n产物处置：${s ? `${s.disposition} —— ${s.note}` : '（未完成，无产物）'}\n`
          + `⚠️ 产物**没有被删除**：git 历史里仍然在，这条记录是为了让人知道那条路径不再算数。`,
        t, t);
        insertEdge(db, did, rv.message_id, 'derived_from', t);
      } else if (m.mark === 'needs_change') {
        const c = changed.get(m.node_id) ?? {};
        const cur = db.one(`SELECT * FROM nodes WHERE id=?`, m.node_id);
        db.run(`UPDATE nodes SET title=?, spec=?, acceptance=?, status=?, retry_count=0 WHERE id=?`,
          c.title ?? cur.title, c.spec ?? cur.spec, c.acceptance ?? cur.acceptance,
          // 已完成的节点改了规格就得重做。**重试次数归零**：新规格是一件新活，
          // 旧规格下失败过几次不该算在它头上 —— 与"被闸门掐停不计重试"同理。
          cur.status === 'done' ? 'pending' : cur.status, m.node_id);
        respecced.push(m.node_id);
        // 新规格是新的一段工作：产物基线重取，否则旧规格下已提交的东西会被算成这段的产物
        clearNodeBaseline(db, { taskId, nodeId: m.node_id });

        // 出处边（指令必溯至认证消息）。**这一条容易漏。**
        // 新增节点有（下面那行），作废节点靠决策日志有，**被改规格的节点**若不补这一条就什么都没有 ——
        // "这个节点的规格为什么长这样"在库里断了线：它既不是规划器产的原样，
        // 也没有任何东西指向那条把它改掉的消息。而重写一个节点的规格**就是一条指令**。
        // 一个节点一生可以被改多次，所以这里是**追加**不是替换：边表本来就是 append-only，
        // 多条 derived_from 就是它被改过几次的历史。
        insertEdge(db, m.node_id, rv.message_id, 'derived_from', t);

        // 依赖边重挂。**给了就是整条替换**，而且是 supersede 不是 delete ——
        // 与 params 同一条规矩：旧边留着，`superseded_at` 记下它什么时候不算数了。
        // 事后要答的问题是"这个节点当初依赖谁、什么时候被改的"，delete 答不出来。
        if (Array.isArray(c.depends_on)) {
          db.run(`UPDATE edges SET superseded_at=?, valid_to=? WHERE from_id=? AND relation='depends_on'
                  AND superseded_at IS NULL`, t, t, m.node_id);
          for (const d of c.depends_on) insertEdge(db, m.node_id, idOf.get(d) ?? d, 'depends_on', t);
          rewired.push({ node: m.node_id, deps: c.depends_on.map((d) => idOf.get(d) ?? d) });
        }
      }
    }

    // 新增节点。**出处边指向那条认证消息**（指令必溯至认证消息）——
    // 规划器产的节点溯到宪法块，修正产的节点溯到那条消息，两者都要能答
    // "当时被要求了什么"。
    for (const n of news) {
      const nid = idOf.get(n.key);
      db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at)
              VALUES (?,?,?,?,?,'pending',?,?,?)`,
      nid, taskId, n.title, n.spec, n.acceptance, n.risk_tier, n.model_tier, t);
      insertEdge(db, nid, rv.message_id, 'derived_from', t);
      added.push(nid);
    }
    for (const n of news) {
      for (const d of n.depends_on ?? []) {
        insertEdge(db, idOf.get(n.key), idOf.get(d) ?? d, 'depends_on', t);
      }
    }

    // 宪法层修订。只在人批准的路径上会走到这里（gateOf 保证带 patch 必触发门）。
    let newConstitution = null;
    if (patch) {
      // ⚠️ **静默的无操作比报错坏得多。** 模型可能交一个字符串补丁，
      // 于是 `patch.goal ?? cur.goal` 全部退回旧值 —— 宪法升到 v2、
      // 四个字段一字未改，审计轨却记着"宪法块修订至 v2"。
      // 人批准的是"改目标"，落库的是"什么都没改"。这条 assert 让它变成一次响亮的失败。
      const fields = patchFields(patch);
      if (!fields.length) {
        throw new Error(`提案 ${revisionId} 的 constitution_patch 里没有任何会被应用的字段`
          + `（收到 ${Array.isArray(patch) ? 'array' : typeof patch}）。`
          + `\n继续下去会把宪法升一版而内容一字未改 —— 那比直接报错坏得多：`
          + `\n人以为批准的改动生效了，审计轨也说生效了，其实什么都没发生。`);
      }
    }
    if (patch && patchFields(patch).length) {
      const cur = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL
                          ORDER BY version DESC LIMIT 1`, taskId);
      db.run(`UPDATE constitutions SET superseded_at=?, valid_to=? WHERE id=?`, t, t, cur.id);
      newConstitution = newId('c');
      db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,scope_paths,definition_of_done,constraints,
                valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      newConstitution, taskId, cur.version + 1,
      patch.goal ?? cur.goal, patch.scope ?? cur.scope,
      // scope_paths 是越界校验的判据，**必须跟着契约走**：漏了它，改一次 scope 散文就会把判据悄悄清空，
      // 表现是越界校验从此不执法 —— 一个只在"改过契约的任务"上出现、且没有任何报错的洞。
      patch.scope_paths !== undefined ? JSON.stringify(normScopePaths(patch.scope_paths)) : (cur.scope_paths ?? '[]'),
      patch.definition_of_done ?? cur.definition_of_done,
      JSON.stringify(patch.constraints ?? JSON.parse(cur.constraints || '[]')), t, t);
      insertEdge(db, newConstitution, rv.message_id, 'derived_from', t);
      insertEdge(db, newConstitution, cur.id, 'supersedes', t);
      // 宪法层的改动记一条**宪法层**决策 —— layer 这一列存在的意义就是让
      // "谁动了目标"和"谁动了做法"在事后分得开。
      const did = newId('d');
      db.run(`INSERT INTO decisions (id,task_id,summary,rationale,actor_kind,actor_id,layer,
                valid_from,recorded_at) VALUES (?,?,?,?,'user',?,'constitutional',?,?)`,
      did, taskId, `宪法块修订至 v${cur.version + 1}`,
      `因修正 ${rv.message_id}：${rv.rationale}`, userId, t, t);
      insertEdge(db, did, rv.message_id, 'derived_from', t);
    }

    db.run(`UPDATE revisions SET status='applied', resolved_at=? WHERE id=?`, t, revisionId);
    closeRevisionQuestion(db, rv, t);
    markConsumed(db, { taskId, ids: [rv.message_id], why: `已由修正提案 ${revisionId} 处理` });
    // 任务从 waiting 解冻的条件是"没有别的问题还开着"，与 recordAnswer 同一条规矩。
    const stillOpen = db.one(`SELECT count(*) AS n FROM questions WHERE task_id=?
                              AND status IN ('open','escalated')`, taskId).n;
    // 从 waiting **或 done** 回到 running：修正可以重开一个已完成的任务（编排器那头
    // 对应放行了 done 任务上的修正）。跑完会再走一遍 finalize，任务级验收重跑。
    if (!stillOpen) db.run(`UPDATE tasks SET status='running' WHERE id=? AND status IN ('waiting','done')`, taskId);

    audit(db, { actorKind: by === 'user' ? 'user' : 'system', actorId: userId ?? 'orchestrator',
      action: 'revision_applied', targetType: 'task', targetId: taskId,
      payload: { revisionId, by, voided, respecced, added, rewired, newConstitution,
        messageId: rv.message_id, pid: process.pid, reservation: reservation ? String(reservation).slice(0, 200) : null } });
    // 保留意见最常出现在这一格：负责人想写下"这条先别当硬规则写进宪法"，而页面若只有批 / 驳两个按钮，
    // 他只能改口"不值得为这一条卡住正题 —— 批"。那不是他改主意，是没地方放那句话。
    // **它不推翻这份变更里的任何一条** —— 便宜、诚实地有限，见 recordReservation 的注释。
    if (String(reservation ?? '').trim()) {
      try {
        recordReservation(db, { projectId: db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null,
          taskId, subject: '批准计划变更时的保留意见', text: reservation, sourceKind: 'revision', sourceId: revisionId, by: userId ?? null, at: t });
      } catch (e) { audit(db, { actorKind: 'system', action: 'decision_register_failed', targetType: 'task', targetId: taskId, payload: { error: e.message, kind: 'reservation' } }); }
    }
    // 决定登记：变更是人提的、也是人（或沉默默认）放行的，进项目的约定清单。
    // **决定本身是人写的那条指令**，不是重规划器的 rationale —— 清单是拿来跟将来的新意见比的，
    // 比的必须是人说过的话。登记失败不许连累变更：改已经应用了，这一步是记账。
    try {
      const msg = db.one(`SELECT body FROM messages WHERE id=?`, rv.message_id)?.body ?? rv.rationale;
      recordFromRevision(db, { taskId, revisionId, messageId: rv.message_id, instruction: msg,
        patchFields: patch ? patchFields(patch) : [], patch, userId, at: t });
    } catch (e) {
      audit(db, { actorKind: 'system', action: 'decision_register_failed', targetType: 'task', targetId: taskId, payload: { revisionId, error: e.message } });
    }
    return { revisionId, voided, respecced, added, rewired, newConstitution };
  });
}

/** 驳回。计划原样不动，但那条修正算处理过了 —— 否则下一轮又会停在同一处。 */
export function rejectRevision(db, { taskId, revisionId, userId = null, why = '' }) {
  const rv = db.one(`SELECT * FROM revisions WHERE id=? AND task_id=?`, revisionId, taskId);
  if (!rv) throw new Error(`没有这份提案：${revisionId}`);
  if (rv.status !== 'proposed') throw new Error(`提案 ${revisionId} 状态是 ${rv.status}`);
  const t = now();
  return db.tx(() => {
    db.run(`UPDATE revisions SET status='rejected', resolved_at=? WHERE id=?`, t, revisionId);
    closeRevisionQuestion(db, rv, t);
    markConsumed(db, { taskId, ids: [rv.message_id], why: `修正提案 ${revisionId} 被驳回` });
    const stillOpen = db.one(`SELECT count(*) AS n FROM questions WHERE task_id=?
                              AND status IN ('open','escalated')`, taskId).n;
    // 从 waiting **或 done** 回到 running：修正可以重开一个已完成的任务（编排器那头
    // 对应放行了 done 任务上的修正）。跑完会再走一遍 finalize，任务级验收重跑。
    if (!stillOpen) db.run(`UPDATE tasks SET status='running' WHERE id=? AND status IN ('waiting','done')`, taskId);
    audit(db, { actorKind: 'user', actorId: userId, action: 'revision_rejected',
      targetType: 'task', targetId: taskId, payload: { revisionId, messageId: rv.message_id, why } });
    return { revisionId };
  });
}

/** 待批准的那份提案（同一时刻至多一份 —— 编排器见到 proposed 就不往下走）。 */
export const pendingRevision = (db, taskId) => db.one(
  `SELECT * FROM revisions WHERE task_id=? AND status='proposed' ORDER BY rowid DESC LIMIT 1`, taskId);

/** 计划 diff 的人类可读形态（"不默默换计划"）。 */
export function renderDiff(g, rev) {
  const L = [];
  L.push(`影响：无关 ${g.counts.unaffected ?? 0} 个｜需修改 ${g.counts.needs_change ?? 0} 个`
    + `｜**作废 ${g.counts.obsolete ?? 0} 个**｜新增 ${g.newCount} 个`);
  if (g.discardedNodes.length || g.redoneNodes.length) {
    // 两类**分开列**：作废是"这活白干了"，重做是"这活要再干一遍"。
    // 花的钱一样，但人该看见的东西不一样 —— 合成一个数就分不出来了。
    L.push(`受影响的已完成工作（按花费算，这是确认门的口径）：`);
    for (const n of g.discardedNodes) L.push(`  - [作废] ${n.title}　$${(n.microUsd / 1e6).toFixed(4)}`);
    for (const n of g.redoneNodes) L.push(`  - [重做] ${n.title}　$${(n.microUsd / 1e6).toFixed(4)}`);
    L.push(`  作废 $${(g.discardedMicro / 1e6).toFixed(4)} + 重做 $${(g.redoneMicro / 1e6).toFixed(4)}`
      + ` / 已完成 $${(g.doneMicro / 1e6).toFixed(4)}`
      + `　= ${(g.ratio * 100).toFixed(1)}%（阈值 ${(g.threshold * 100).toFixed(0)}%`
      + `，金额下限 $${((g.floorMicro ?? 0) / 1e6).toFixed(2)}）`);
    if (g.belowFloor) L.push(`  占比过了阈值，但受影响的金额 $${(g.affectedMicro / 1e6).toFixed(4)} 不到下限，`
      + `按"不值得为这点钱打断人"处理：方案直接生效，这份 diff 就是通知。`);
  }
  // 原则是"**不默默换计划**"。若这里只列作废与重做 —— 也就是只列
  // **花过钱**的那部分 —— 打出来的 diff
  // 会是这样的：改了 4 个 pending 节点的规格、加了 1 个新节点，
  // 而人看到的只有一行"需修改 4 个｜新增 1 个"，一个标题都没有。
  // 门没触发时这份 diff 就是人唯一的知情来源，"多少个"答不了"改了什么"。
  const changedMap = new Map((rev.changed_nodes ?? []).map((c) => [c.node_id, c]));
  const respecced = (rev.impact ?? [])
    .filter((m) => m.mark === 'needs_change' && g.byId.get(m.node_id)?.status !== 'done');
  if (respecced.length) {
    L.push(`改了规格的未完成节点（没花过钱，所以不进上面的比例，但计划确实变了）：`);
    for (const m of respecced) {
      const c = changedMap.get(m.node_id) ?? {};
      const bits = ['title', 'spec', 'acceptance'].filter((k) => c[k]?.trim());
      if (Array.isArray(c.depends_on)) bits.push('depends_on');
      L.push(`  - ${g.byId.get(m.node_id)?.title ?? m.node_id}　改了 ${bits.join('/') || '（没说改什么）'}`);
    }
  }
  const rewired = (rev.changed_nodes ?? []).filter((c) => Array.isArray(c.depends_on));
  if (rewired.length) {
    L.push(`依赖边重挂 ${rewired.length} 处（旧边 supersede，不删）：`);
    for (const c of rewired) {
      L.push(`  - ${g.byId.get(c.node_id)?.title ?? c.node_id} → 依赖 `
        + `${c.depends_on.map((d) => g.byId.get(d)?.title ?? d).join('、') || '（无）'}`);
    }
  }
  if (g.newCount) {
    L.push(`新增 ${g.newCount} 个节点：`);
    for (const n of rev.new_nodes ?? []) L.push(`  + ${n.title}`);
  }
  if (g.partialNodes.length) {
    L.push(`部分抢救 ${g.partialNodes.length} 个 —— **不计入上面的比例**：`
      + `"留了多少"没法机械判定，算全丢会高估、算没丢会低估，两边都是编数字。自己看：`);
    for (const n of g.partialNodes) L.push(`  - ${n.title}`);
  }
  if (rev.constitution_patch && Object.keys(rev.constitution_patch).length) {
    L.push(`**宪法块改动**（这是要你批的主要理由）：`);
    for (const [k, v] of Object.entries(rev.constitution_patch)) {
      L.push(`  ${k}：${typeof v === 'string' ? v.slice(0, 300) : JSON.stringify(v).slice(0, 300)}`);
    }
  }
  L.push(`理由：${rev.rationale}`);
  return L.join('\n');
}

/**
 * 重规划器自己提的问题（修正含糊到判不出影响范围时）。
 *
 * 与触顶问题不同，**这条是模型定级的**（`level_source='classifier'`）：
 * "这条修正到底什么意思"是语义判断，不是安全边界 —— 强制 Ⅲ 级的是后者。
 * 把两种混成一种，`level_source` 这一列就白设了。
 */
export function recordReplanQuestion(db, { taskId, message, args }) {
  const id = newId('q');
  const t = now();
  const def = args.level === 3 ? null : (args.default_action ?? null);
  return db.tx(() => {
    db.run(`INSERT INTO questions (id,task_id,node_id,level,level_source,text,default_action,asked_at,status)
            VALUES (?,?,NULL,?,'classifier',?,?,?,'open')`, id, taskId, args.level, args.text, def, t);
    insertEdge(db, id, message.id, 'derived_from', t);
    routeQuestion(db, { questionId: id, ...decisionTypeOfQuestion({ kind: args.kind, text: args.text }), at: t });
    db.run(`UPDATE tasks SET status='waiting' WHERE id=?`, taskId);
    audit(db, { actorKind: 'agent', actorId: 'replanner', action: 'question_raised',
      targetType: 'task', targetId: taskId,
      payload: { questionId: id, level: args.level, levelSource: 'classifier',
        messageId: message.id, blockedBy: args.blocked_by ?? null, pid: process.pid } });
    return { id, level: args.level, text: args.text, default_action: def,
      blocked_by: args.blocked_by ?? null };
  });
}

/** 修订已应用 / 已驳回：它那条批准事项还开着就一并了结（命令行直接批的那条路；走事项答复的那条路此时事项已经结了）。 */
function closeRevisionQuestion(db, rv, t) {
  if (!rv.question_id) return;
  db.run(`UPDATE questions SET status='answered', resolved_at=? WHERE id=? AND status IN ('open','escalated')`, t, rv.question_id);
}

// 计划变更的批准事项够数了 → 在这里应用 / 驳回。若只有负责人卡片上的按钮会应用，
// 事项里几个人的"A"全是摆设：卡片一点就生效（绕过会签），事项还挂着等人再答一遍。
// 所以事项是唯一的路：卡片按钮 = 负责人在这条事项上答一次，够不够数由路由表的法定人数决定。
{
  const prev = RESOLUTION_HOOKS.contract_approval;
  RESOLUTION_HOOKS.contract_approval = (db, ctx) => {
    const rv = db.one(`SELECT * FROM revisions WHERE question_id=? AND status='proposed'`, ctx.question.id);
    if (!rv) return prev ? prev(db, ctx) : null;
    if (revisionSide(ctx.finalBody) === 'approve') {
      applyRevision(db, { taskId: rv.task_id, revisionId: rv.id, by: 'user', userId: ctx.by, reservation: reservationOf(ctx.finalBody) });
      return { revision: 'applied', revisionId: rv.id };
    }
    const why = String(ctx.finalBody ?? '').replace(/^\s*[（(]?\s*(B|驳回)\s*[)）]?[\s：:，,。.、]*/i, '').trim() || '在事项里驳回（未写理由）';
    rejectRevision(db, { taskId: rv.task_id, revisionId: rv.id, userId: ctx.by, why });
    return { revision: 'rejected', revisionId: rv.id };
  };
}
