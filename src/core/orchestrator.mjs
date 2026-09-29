// 编排器 —— 任务的执行循环，也是系统里唯一的**确定性状态机**。
//
// 它不调 LLM。选哪个节点、要不要退出、任务算不算完成，全是查询加比较——
// 一个核心设计假设（确定性状态机 + LLM 子程序的切分是对的）的一半就压在这个文件上：
// 这里但凡出现一处"这个判断既不该硬编码也不好独立成一次调用"，切分线就画错了。
//
// **重生在这里是结构，不是功能**：每一轮开头把全部状态从库里重读，
// 循环体之间不传任何东西。所以"编排器重生 = 崩溃恢复 = 冷启动 = 挂起复工"
// 不是四条代码路径共用一个名字，是同一条路径——把 while 换成进程重启，
// 行为一模一样。挂起后进程退出、复工时重新进来，靠的正是后者。

import { raiseSignoffQuestion } from './deliver.mjs';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { effectiveSetupOf, runSetupCommands, setupFingerprint } from './project-settings.mjs';
import { readPreviewSpec, capturePreview, hasUi, PREVIEW_FILE } from './preview.mjs';
import { setParam } from './params.mjs';
import { raiseChoiceReviews, CHOICES_MARK } from './choices.mjs';

/** 这条开着的事项挡不挡执行（见 run 里 pending 那一行）。停等 / 空转的标记与 liveness.mjs 一致（不 import，免得成环）。 */
export const blocksExecution = (q) => q.decision_type !== 'signoff'
  && !['【停等】', '【空转】', CHOICES_MARK].some((m) => String(q.text ?? '').startsWith(m));
import { audit, now, newId } from '../db/db.mjs';
import { tierEntry } from '../llm/canonical.mjs';
import { readyNodes } from '../context/assemble.mjs';
import { executeNode } from '../agent/executor.mjs';
import { flushLedger, taskSpendMicroUsd } from './ledger.mjs';
import { checkLimits, limitOf, contextCapOf, priorRuntimeMs, raiseLimitQuestion, LIMITS } from './limits.mjs';
import { advanceConsecutiveDenials, egressDenialStateOf, resetEgressDenialState } from './egress.mjs';
import { openQuestions, pendingMessages, consumeMessages, heldSteering } from './inbox.mjs';
import { verdictsOn } from './decision-check.mjs';
import { replan } from '../agent/replan.mjs';
import { nodesForReplan, proposeRevision, applyRevision, pendingRevision,
  recordReplanQuestion } from './revision.mjs';
import { workspaceStatus, commitWorkspace, isBuildOutput, discardChanges } from './workspace.mjs';
import { raiseVerifyFailed, raiseReplanFailed } from './handback.mjs';
import { LocalExecutor } from './executor.mjs';
import { isInfraError, HardLimitError } from './errors.mjs';
import { makeReport } from '../agent/reporter.mjs';
import { verifyHandoff } from '../agent/verifier.mjs';
import { sweepTimeouts } from './timeouts.mjs';
import { escalationFor, recordEscalation } from './escalate.mjs';

/** 任务级参数。取当前生效的那条。 */
export const getParam = (db, taskId, key) => db.one(
  `SELECT value FROM params WHERE task_id=? AND key=? AND superseded_at IS NULL
    ORDER BY recorded_at DESC LIMIT 1`, taskId, key)?.value ?? null;

/** finalize 补了一步、要回到主循环接着跑（而不是结束这次运行）。 */
const AGAIN = Symbol('again');
export const PREVIEW_NODE_KEY = 'preview.auto_node';
export const PREVIEW_NODE = {
  title: `写页面截图说明（${PREVIEW_FILE}）`,
  spec: `仓库里有界面（前端），但根目录还没有 ${PREVIEW_FILE}，签收的人因此看不到做出来的页面。按沙箱说明写一份 ${PREVIEW_FILE}：`
    + `start（起后端、起前端的命令，每条一个后台进程，监听 127.0.0.1）、url（前端地址）、ready（后端一个能返回 200 的地址）、`
    + `seed（可选：服务起来后放几条样例数据的命令，每条可写成字符串数组，例如用 curl 调新建接口 —— 空列表证明不了功能）、pages（要截的页，至多 6 页）。`
    + `只改 ${PREVIEW_FILE}（需要样例数据脚本时可以新加一个）；不要自己起浏览器截图，不要提交图片 —— 截图由系统按这份文件做，放到签收页上。`,
  acceptance: `仓库根目录有 ${PREVIEW_FILE}：合法 JSON，start 非空、url 是 http://127.0.0.1:端口、pages 非空；`
    + `在沙箱里按 start 实际起一遍服务，url 与 ready 里每个地址都返回 2xx（交接记录里贴出这几次请求的结果）。`,
};

/** 节点状态直方图。编排器判"接下来该干什么"只需要这一个东西。 */
const census = (db, taskId) => Object.fromEntries(
  db.all(`SELECT status, count(*) AS n FROM nodes WHERE task_id=? GROUP BY status`, taskId)
    .map((r) => [r.status, r.n]));

/**
 * 跑一个任务，直到必须停下来为止。
 *
 * @returns {{kind:'complete'|'suspended'|'stalled'|'limit_breached'|'limit_hard_failed'|'verify_failed'|'empty', ...}}
 *   complete       全部节点完成且任务级验收通过 → 任务置 done
 *   suspended      有分支在等人 → **进程该退出**
 *   stalled        依赖成环或有节点停在非终态 → 交给人
 *   limit_breached 撞上触顶类硬上限或死人开关 → 已生成一条 Ⅲ 级问题，任务冻结
 *   limit_hard_failed 撞上硬边界类上限（容器内存/进程数）→ 已记审计，硬失败，不进提问
 *   verify_failed  节点都完成了但任务级验收命令没过 → **不置 done**
 *   revision_pending 修正的重规划方案要人批准（触及宪法层，或作废比例超阈值）→ 已生成 Ⅲ 级问题
 *   replan_failed  重规划器几次都产不出通过校验的方案 → 交给人，**修正不消费**
 *
 * ⚠️ `limit_breached` 和 `suspended` 都是"在等人"，但**不是一回事**：
 * suspended 是 agent 自己判断需要人拍板；limit_breached 是 harness 掐停它。
 * 前者的问题由模型写（level_source='classifier'），后者由状态机写（'hard_rule'），
 * 后者在预算已经花光时也必须能产生 —— 所以它一次 LLM 都不能调。
 */
export async function orchestrate(db, {
  taskId, workspace, makeClient, narrativeDir,
  maxCycles = 12, maxIterations = 20, tierOverride = null,
  commit = true, verify = true, exec = new LocalExecutor(), onEvent = () => {},
  // 主动汇报 / 独立验收员。**这里默认关、CLI 默认开** —— 与 commit/verify
  // 同一个模式：离线测试用脚本化的假模型，多一个会消费脚本的 LLM 角色就得改每个
  // 夹具；而真跑不该有免检通道。测它们的测试显式打开。
  report = false, llmVerify = false,
}) {
  const pid = process.pid;
  audit(db, { actorKind: 'system', action: 'orchestrator_started', targetType: 'task', targetId: taskId,
    payload: { pid, maxCycles, argv: process.argv.slice(1).join(' ') } });

  // "这次的命令跑在哪"必须落在真相源里。
  //
  // 记在这里而不是记在 CLI 里，是因为**这是所有调用方的必经点**：CLI、离线测试、
  // 将来的 Web 后端都从这个函数进来。放在调用方就成了一个"要记得记"的日志 ——
  // 而没记的那次和"根本没在沙箱里跑"的那次，在复盘时长得一模一样。
  // 沙箱侧的 `sandbox_started` 由 ContainerExecutor 自己写（它才知道容器 id 与镜像摘要）。
  if (!exec?.isolated) {
    audit(db, { actorKind: 'system', action: 'sandbox_skipped', targetType: 'task', targetId: taskId,
      payload: { pid, executor: exec?.constructor?.name ?? String(exec),
        why: '执行器未声明隔离 —— 命令直接跑在宿主机上' } });
  }

  // ── 崩溃恢复 ──────────────────────────────────────────────────────────
  // 设计上"重生 = 崩溃恢复 = 冷启动 = 挂起复工，全系统同一条代码路径"。
  // 没有下面这段，那句话只对**优雅退出**成立。进程被硬杀（例如
  // 厂商余额耗尽抛异常，也可以是断电、OOM、Ctrl-C），节点就永远停在 running，
  // 而 readyNodes 只看 pending/ready —— 任务从此谁也捡不起来，不报错，只是不动。
  //
  // 认领条件在单进程、任务内串行时是安全的。启动那一刻还挂着 running
  // 的节点，只可能是上一个进程死在它手里。
  // ⚠️ 一旦有并发编排器，这里必须换成租约 + 心跳，否则会把别人正在干的活抢走。
  //
  // ⚠️ 认领**不计重试**。若这里 `retry_count+1`：厂商连回两次 403，进程
  // 两次死在同一节点手里，两次认领就吃光了 node_retries=2 —— 闸门会叫人，但理由是
  // 错的：那不是节点难，是厂商挂了。重试预算是节点**自己**失败的预算；进程被外部
  // 打死（断电、OOM、Ctrl-C、厂商 5xx）是另一件事，有它自己的维度
  // `limit.node_reclaims`（按 node_reclaimed 审计行数计）—— 连死三次在同一节点上
  // 也该叫人，只是叫人的理由要说对。
  for (const n of db.all(`SELECT id FROM nodes WHERE task_id=? AND status='running'`, taskId)) {
    db.run(`UPDATE nodes SET status='pending' WHERE id=?`, n.id);
    const reclaims = db.one(`SELECT count(*) AS n FROM audit_log WHERE action='node_reclaimed' AND target_id=?`, n.id).n + 1;
    audit(db, { actorKind: 'system', action: 'node_reclaimed', targetType: 'node', targetId: n.id,
      payload: { pid, why: '启动时发现节点停在 running —— 上一个进程死在它手里', reclaims } });
    onEvent({ type: 'reclaimed', nodeId: n.id, reclaims });
  }

  // 本次寿命的起点。`limit.runtime_ms` 累加的是**编排器真在跑**的区间，
  // 不是"建任务到现在"—— 挂起等人是正常状态，按墙上时钟算会惩罚回得慢的人。
  const startedAt = now();
  const finish = (kind, extra = {}) => {
    // elapsedMs 不是给人看的装饰：limits.priorRuntimeMs 真的从这里读。
    // 让一条活着的护栏依赖审计轨，轨烂了当场就会被发现，而不是等到复盘时。
    audit(db, { actorKind: 'system', action: 'orchestrator_exit', targetType: 'task', targetId: taskId,
      payload: { pid, kind, elapsedMs: now() - startedAt, ...extra } });
    return { kind, pid, ...extra };
  };

  /**
   * 触顶分发：按 LIMITS 条目上的类别字段 `on_hit` 决定走哪条路 ——
   * **不用维度名做 if/else**。
   *   gate       触顶类 → 确定性生成一条 Ⅲ 级问题 → 冻结任务 → 退出（零 LLM 调用）
   *   hard_fail  硬边界类 → 先记一条与预算/时长同形的审计事件，随后硬失败，
   *              不调用 advice 生成加额建议、不进入提问/降级分支。
   */
  /**
   * 主动汇报：fire-and-forget，不阻塞、不等确认。
   * 汇报生成器**仅从真相源装配**，账记在 reporter 角色下。
   * `allowLlm=false` 用在"钱花光了"这类场合 —— 汇报必须在钱花光之后仍能说出口，
   * 那就只能是模板（与触顶问题"一次 LLM 都不能调"同一条纪律）。
   */
  const reportOn = async (trigger, triggerRef = null, { allowLlm = true } = {}) => {
    if (!report) return null;
    const rc = allowLlm ? makeClient('light') : null;
    let rep = null;
    try {
      rep = await makeReport(db, { taskId, trigger, triggerRef, client: rc });
    } finally {
      if (rc) {
        const led = flushLedger(db, rc, { taskId, role: 'reporter' });
        if (led.rows) onEvent({ type: 'billed', node: null, role: 'reporter', ...led });
      }
    }
    onEvent({ type: 'report', report: rep });
    return rep;
  };

  const breachOut = async (breach, nodeId = null) => {
    if (LIMITS[breach.key]?.on_hit === 'hard_fail') {
      audit(db, { actorKind: 'system', action: 'limit_breached', targetType: 'task', targetId: taskId,
        payload: { pid, nodeId, ...breach, on_hit: 'hard_fail' } });
      await reportOn('limit_breached', nodeId);
      return finish('limit_hard_failed', { breach, nodeId, completed,
        why: `${breach.label}是硬边界：撞顶 = 容器被 OOM / pids-limit 掐死，`
          + `属任务自身失控或泄漏，提高上限不是解法。已记审计，硬失败。` });
    }
    // 出网连续被拒撞顶：把当前**持久化**的被拒目标集合摘要挂进审计载荷与问题正文
    // （该维度 advice 让人去看"连续撞的是哪些域"，摘要就是落在这里的证据）。
    // 只补证据不改行为：走 gate 提问分支还是 hard_fail 硬失败，仍只由 LIMITS 条目上
    // 的 on_hit 决定 —— 这里不做行为分流，维度名只在"给 payload 补字段"时出现。
    if (breach.key === 'limit.egress.consecutive_denials') {
      const deniedHosts = Object.fromEntries(
        Object.entries(egressDenialStateOf(db, taskId).hosts).sort((a, b) => b[1] - a[1]));
      breach = { ...breach, deniedHosts,
        human: Object.keys(deniedHosts).length
          ? breach.human + '｜被拒目标：' + Object.entries(deniedHosts).map(([h, n]) => h + '×' + n).join('、')
          : breach.human };
    }
    const q = raiseLimitQuestion(db, { taskId, nodeId, breach });
    // 撞顶已作为问题报给人：把持久化计数归零（游标不动）—— 否则复工后第一轮体检会拿同一批旧被拒再触顶一遍。
    // 归零后只有**新的**连续被拒才会再次触顶。
    if (breach.key === 'limit.egress.consecutive_denials') resetEgressDenialState(db, taskId);
    onEvent({ type: 'limit_breached', breach, questionId: q.questionId });
    // 预算 / 调用次数触顶时不调模型：钱花光了还要再花钱才能说"钱花光了"，那是自指的洞。
    // 项目预算闸也在这张"不许调模型"的名单里，与任务花费同一条道理：钱花光了还要再花一次钱
    // 才能说出"钱花光了"，那闸门就有一个自指的洞。
    await reportOn('limit_breached', q.questionId,
      { allowLlm: !['limit.budget_micro_usd', 'project.budget_micro_usd', 'limit.llm_calls'].includes(breach.key) });
    return finish('limit_breached', { breach, questionId: q.questionId, completed });
  };

  const completed = [];
  // 死人开关的计数器：连续多少轮没有任何节点从进行中转为完成。
  // 资源上限抓不住"在花钱但不在前进" —— 每轮都在正常调用工具、正常记账，
  // 只是没有一个节点走到 done。这是"我磨了一下午没进展，该去问人了"的机制化。
  let idleCycles = 0;
  // 本次编排器寿命内见过的上下文峰值。与 idleCycles 同族：**寿命内**的量，不是任务历史量。
  // 不用全任务历史峰值，是因为某个节点峰过一次不该永久毒化这个任务 ——
  // 那和 node_retries 不同，重试次数是节点的持久属性，上下文峰值是一个过去的瞬间。
  let peakContextTokens = 0;

  // ── 出网连续被拒：计数持久化于 params（跨进程累计，进程内不留计数）──────────────
  // LIMITS['limit.egress.consecutive_denials'].read 直读 params。观测源是出口代理写的审计 JSONL
  // （guard.py 每一条出网尝试都落一行 allowed 真假；文件按任务长期追加，不随进程重建）——
  // 编排器每次体检前把自 params 游标起新增的行喂给计数并写回：denied → +1、allowed → 归零。
  // 游标与计数都在 params：复工的新进程续读同一份，旧行不重数。没有代理的任务恒为 0。
  const egressAuditFile = exec?.egress?.auditFile ?? null;
  /** 本次体检的 ctx。每次先推进持久化计数（读 JSONL 新增行 → 写回 params）再取值。 */
  const limitsCtx = () => {
    advanceConsecutiveDenials(db, taskId, egressAuditFile);
    return { startedAt, idleCycles, peakContextTokens };
  };

  // ── 环境准备 ───────────────────────────────────────────────────────
  // 依赖目录不进仓库，所以每份新工作区都没装依赖。项目配了环境准备命令的话，这份工作区第一次真的要干活之前
  // 先跑一遍；跑过的在 .git/si-setup 里记下命令指纹（命令改了就重跑）。失败不拦 —— 结果进审计，
  // 执行器上下文里会说出来（egressContext），agent 可以自己修，修不了再问。
  {
    const pidOfTask = db.one(`SELECT project_id FROM tasks WHERE id=?`, taskId)?.project_id ?? null;
    // 人填了用人填的；没填就按这份工作区里的依赖清单自动识别。清单改了（加了依赖）指纹跟着变，下次开跑重装。
    const { argvs, source: setupSource, manifests } = pidOfTask ? effectiveSetupOf(db, pidOfTask, workspace) : { argvs: [], source: null, manifests: null };
    const hasWork = !!db.one(`SELECT 1 FROM nodes WHERE task_id=? AND status IN ('pending','ready') LIMIT 1`, taskId);
    if (argvs.length && workspace && hasWork && existsSync(join(workspace, '.git'))) {
      const marker = join(workspace, '.git', 'si-setup');
      const fp = setupFingerprint(argvs, manifests);
      let cur = null; try { cur = readFileSync(marker, 'utf8'); } catch { /* 没跑过 */ }
      if (cur !== fp) {
        onEvent({ type: 'env_setup_start', commands: argvs.length });
        const r = await runSetupCommands(exec, workspace, argvs);
        audit(db, { actorKind: 'system', action: r.ok ? 'env_setup_done' : 'env_setup_failed', targetType: 'task', targetId: taskId,
          payload: { pid, source: setupSource, results: r.results.map((x) => ({ cmd: x.argv.join(' '), code: x.code, timedOut: x.timedOut, tail: x.tail.slice(-600) })) } });
        if (r.ok) { try { writeFileSync(marker, fp); } catch { /* 写不进去就下次再跑一遍 */ } }
        onEvent({ type: 'env_setup', ok: r.ok, results: r.results });
      }
    }
  }

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    // ── 重生点 ──────────────────────────────────────────────────────────
    // 这三行是"载入状态"的全部。上一轮留下的任何东西都不在作用域里——
    // 想作弊也没得作弊，这是刻意的结构约束，不是自觉。
    // 超时链先扫一遍：到期的 Ⅰ 级走默认动作、Ⅱ 级升级或退默认。`run` 是唯一的恢复路径，
    // 所以 cron 起一个 run 就等于"30 分钟后有人来看了一眼"。扫完再读状态，免得读到扫之前的。
    sweepTimeouts(db, { taskId, onEvent });
    const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
    if (!task) throw new Error(`没有这个任务：${taskId}`);
    // 不挡执行的事项不算"在等人"（否则会死锁）：签收（任务又被改时，收尾会按新提交撤掉旧的、重新请签）、
    // 「AI 替你定了几件事」（写明了不挡签收、不挡合并）、停等 / 空转报警（本来就是说它没动）。
    // 若把它们算进去，它们一开着，改完的任务就收不了尾，而签收按钮又因任务不是 done 被禁用 —— 两边互等，页面上没有出路。
    const pending = openQuestions(db, taskId).filter(blocksExecution);
    const counts = census(db, taskId);
    onEvent({ type: 'cycle', cycle, status: task.status, counts, openQuestions: pending.length });

    // 已完成的任务**仍然接受修正**：人说"哦对了，再加一样"是最自然的事，修正流程没说
    // 修正到 done 为止。这一行若排在 ⓪′ 之前 —— `say` 把修正写进库、`run` 看到
    // done 直接退出，那条消息永远不被消费，没有任何报错。修正落库之后任务会被
    // applyRevision 重新置 running，节点跑完再走一遍 finalize（任务级验收重跑）。
    const reopen = pendingMessages(db, taskId).some((m) => m.kind === 'correction' || m.kind === 'instruction');
    if (task.status === 'done' && !reopen) {
      return finish('complete', { cycles: cycle - 1, completed, already: true });
    }
    // 人在看板上按了暂停 / 中止（控制杆）：状态就是指令，编排器每轮开头读到就退出。
    // 暂停不是挂起（suspended 由人设、waiting 由问题设），恢复也不是答题 —— 是人再按一次。
    if (task.status === 'suspended') return finish('paused', { cycles: cycle - 1, completed, why: '任务被人暂停；恢复：cli 或看板 resume' });
    if (task.status === 'aborted') return finish('aborted_by_user', { cycles: cycle - 1, completed, why: '任务被人中止' });

    // ⓪ 硬上限体检。**排在挑节点之前**：闸门的意义是不让下一份钱
    //    花出去，放在花完之后检查那叫记账，不叫闸门。
    const breach = checkLimits(db, taskId, limitsCtx());
    if (breach) return breachOut(breach);

    // ⓪′ 人发来的修正/新指令（修正流水线）。**必须在挑节点之前处理。**
    //
    // 为什么不放它过去让执行器自己看着办：那等于让执行器**自行改变任务目标**，
    // 而目标属宪法层，执行层无权动。装配层因此也明写了
    // "改计划是编排器的活，不是你的"。
    //
    // `context` 类不在此列：补充上下文不改变要做什么，进收件箱段给执行器读就行。
    //
    // 流水线的"在途工作处理"一步在串行模型里**是空的**：这里排在挑节点
    // 之前，所以流水线跑起来时不可能有节点在途。如实记着，不假装实现了 ——
    // 一旦有并发执行器它就必须真的做。
    const pendingRev = pendingRevision(db, taskId);
    if (pendingRev) {
      onEvent({ type: 'revision_pending', revision: pendingRev });
      return finish('revision_pending', { cycles: cycle - 1, completed,
        revisionId: pendingRev.id, questionId: pendingRev.question_id, gate: pendingRev.gate });
    }
    const steering = pendingMessages(db, taskId).filter(
      (m) => m.kind === 'correction' || m.kind === 'instruction');
    if (steering.length) {
      const msg = steering[0];               // 一次处理一条：两条修正一起进会分不清哪条造成了哪个改动
      const constitution = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL
                                   ORDER BY version DESC LIMIT 1`, taskId);
      const snapshot = nodesForReplan(db, taskId);
      onEvent({ type: 'replan_start', message: msg, nodes: snapshot.length });

      const rpClient = makeClient('heavy');
      let rp;
      try {
        rp = await replan(db, { client: rpClient, taskId, constitution, message: msg, verdicts: verdictsOn(db, msg.id),
          nodes: snapshot, tier: 'heavy' });
      } finally {
        // 重规划也烧钱，也必须落账 —— 否则预算闸门上多一个洞。
        const led = flushLedger(db, rpClient, { taskId, role: 'replanner' });
        onEvent({ type: 'billed', node: null, ...led });
      }

      if (rp.kind === 'question') {
        const q = recordReplanQuestion(db, { taskId, message: msg, args: rp.args });
        onEvent({ type: 'replan_question', question: q });
        return finish('suspended', { cycles: cycle - 1, completed, questions: [q] });
      }
      if (rp.kind !== 'revision') {
        // **不消费那条消息**：没处理成就不能标成处理过了，否则修正会静默蒸发。
        audit(db, { actorKind: 'agent', actorId: 'replanner', action: 'replan_failed',
          targetType: 'task', targetId: taskId,
          payload: { pid, messageId: msg.id, why: rp.why, attempts: rp.attempts,
            rejections: rp.rejections } });
        // 当场挂一条事项（handback.mjs）：若只退出，那条话原样挂着，人回什么都只会让它拿同一条话再失败一次。
        const hq = raiseReplanFailed(db, { taskId, messageId: msg.id, why: rp.why });
        return finish('replan_failed', { cycles: cycle - 1, completed, messageId: msg.id,
          why: rp.why, rejections: rp.rejections, questionId: hq.questionId });
      }

      const prop = proposeRevision(db, { taskId, message: msg, rev: rp.args, nodes: snapshot });
      onEvent({ type: 'revision_proposed', ...prop, rev: rp.args });
      if (prop.gate) {
        return finish('revision_pending', { cycles: cycle - 1, completed,
          revisionId: prop.revisionId, questionId: prop.questionId, gate: prop.gate });
      }
      // 门没触发 → 直接生效并把 diff 推给人（"不默默换计划"）。
      const applied = applyRevision(db, { taskId, revisionId: prop.revisionId, by: 'auto' });
      onEvent({ type: 'revision_applied', taskId, ...applied, summary: prop.summary, rev: rp.args });
      await reportOn('revision_applied', prop.revisionId);   // 汇报触发之一：重大状态变化
      continue;                              // 重生点会重新读库，改完的计划从下一轮开始生效
    }

    // ⓪″ 有修正被挡着：还在比对，或撞上了旧决定、在等那条冲突事项的结论。
    //    **整个任务停下，不去挑节点**：那条修正多半要改计划，这时接着跑旧计划的节点，
    //    做出来的东西很可能被下一轮的重规划作废 —— 等几秒（比对）或等人一句话（裁定）更便宜。
    //    等裁定时接收者就是那条事项的收件人；待比对时是一个钟点（held_until 到了自己放行）。
    const held = heldSteering(db, taskId);
    if (held.length) {
      const verdict = held.filter((h) => h.why === 'verdict');
      if (verdict.length) {
        const qids = [...new Set(verdict.flatMap((h) => h.questionIds))];
        return finish('awaiting_verdict', { cycles: cycle - 1, completed, messageIds: verdict.map((h) => h.message.id), questionIds: qids,
          why: '有一条修正撞上了仍然有效的旧决定，等那条冲突事项有结论再执行' });
      }
      return finish('awaiting_check', { cycles: cycle - 1, completed, messageIds: held.map((h) => h.message.id),
        until: Math.max(...held.map((h) => h.until ?? 0)), why: '刚到的修正还在对照已有决定，比对完就接着跑' });
    }

    // ① 有人没回答 → 停。最简形态是：一个分支挂起，整个任务停下。
    //    但该去跑其它独立分支（那才是长期运行的价值），这需要区分
    //    "任务级 waiting"与"分支级 waiting"。
    //    分支级挂起：**一个分支等人，不等于整个任务等人**。DAG 存在的理由就是
    //    "某分支等人回答时，agent 转去做其它独立分支"。被问题挡住的节点是 blocked，依赖它的节点
    //    因依赖未 done 不会就绪 —— readyNodes 已经把"受这个问题牵连的分支"排除了。所以规则只有一条：
    //    还有就绪节点就接着跑，一个都没有才 suspended 退出。答复到达后在下一个节点边界被消费。
    const ready = readyNodes(db, taskId);
    if (pending.length && !ready.length) {
      return finish('suspended', { cycles: cycle - 1, completed,
        questions: pending.map((q) => ({ id: q.id, level: q.level, nodeId: q.node_id, text: q.text })) });
    }
    if (pending.length) onEvent({ type: 'branch_waiting', questions: pending.map((q) => q.id), ready: ready.map((n) => n.id) });

    // ② 挑一个就绪节点。没有就绪的，看是全做完了还是卡住了。
    if (!ready.length) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (!total) return finish('empty', { cycles: cycle - 1 });
      // ⚠️  是终态但**不是完成**。引入作废之后，全做完了吗不能再问
      //    done === total —— 那会让任何一次作废把任务永远卡在 stalled，
      //    而报出来的理由是依赖成环或有节点停在非终态，指不到真实原因。
      //    另一半同样要写死：**全是 void 不算完成**，那是这个任务被改没了。
      const terminal = (counts.done ?? 0) + (counts.void ?? 0);
      if (terminal === total && (counts.done ?? 0) > 0) { const fin = await finalize(); if (fin !== AGAIN) return fin; continue; }
      if (terminal === total) {
        return finish('stalled', { cycles: cycle - 1, completed, counts,
          why: '所有节点都被作废了 —— 修正把这个任务改没了，需要人重新给方向' });
      }
      return finish('stalled', { cycles: cycle - 1, completed, counts,
        why: '没有就绪节点，但也不是全部完成 —— 依赖成环或有节点停在非终态' });
    }

    const node = ready[0];
    // 自动升档：重试 ≥2 升一档，升档前过花费 + 时长闸门；`--tier` 显式覆盖时人说了算，不升。
    let tier = tierOverride ?? node.model_tier;
    if (!tierOverride) {
      const probe = makeClient(node.model_tier);
      const esc = escalationFor(db, { taskId, node, binding: probe.binding, catalog: probe.catalog, ctx: limitsCtx() });
      if (esc.blocked) return await breachOut(esc.breach, node.id);
      if (esc.escalated) {
        recordEscalation(db, { taskId, node, esc });
        onEvent({ type: 'escalated', node, from: esc.from, to: esc.tier, estimateMicro: esc.estimateMicro });
        tier = esc.tier;
      }
    }
    const client = makeClient(tier);
    onEvent({ type: 'node_start', cycle, node, tier });

    // 本节点的账，**每一轮工具调用后就落库**，不等节点结束。
    // 进程若被 403 打死，此前每一轮工具调用烧掉的钱会一分没进账本 ——
    // flushLedger 若只在 finally 里跑，进程活不到 finally。预算闸门看不见的钱
    // 就不是钱。每轮落一次，崩了最多丢最后一轮。
    let nodeMicro = 0, nodeRows = 0;
    const flushStep = () => {
      // ⚠️ 峰值要在 flushLedger **之前**取：flush 会把内存账本清空。
      peakContextTokens = Math.max(peakContextTokens, contextPeak(client));
      const led = flushLedger(db, client, { taskId, nodeId: node.id, role: 'executor' });
      nodeMicro += led.microUsd; nodeRows += led.rows;
    };

    let r;
    let infra = null;   // 基础设施错误（厂商 / 硬边界）：不是节点的错，另走一条路
    try {
      r = await executeNode(db, {
        client, taskId, nodeId: node.id, workspace, tier,
        vendorId: tierEntry(tier, client.binding, client.catalog).vendorId,
        narrativeDir: narrativeDir ?? join(workspace, '..', 'narratives'),
        maxIterations, exec,
        // 验收员用自己的 client（新鲜上下文、独立记账），执行器对它一无所知。
        verifier: llmVerify ? async ({ args, changed }) => {
          const vc = makeClient('standard');
          try {
            return await verifyHandoff(db, { client: vc, taskId, nodeId: node.id, workspace, exec, args, changed });
          } finally {
            const led = flushLedger(db, vc, { taskId, nodeId: node.id, role: 'verifier' });
            if (led.rows) onEvent({ type: 'billed', node, role: 'verifier', ...led });
          }
        } : null,
        onStep: (i, resp) => { flushStep(); onEvent({ type: 'step', node, i, resp }); },
        // 轮级闸门。只查按轮增长的几维 —— 其余几维在一个节点内不会变，每轮重查是白费查询。
        // 闸门必须在节点跑到一半时就能掐：单个节点的花费也可能超过预算，
        // 只在节点边界检查等于给每个节点发一张"最多再超一个节点"的免死金牌。
        abort: (i) => {
          if (i === 0) return null;   // 第一轮先让它跑起来，否则触顶后连叙事都没有
          // 已落库 + 还在内存里的（onStep 每轮 flush，内存里通常只剩零头）
          const spent = taskSpendMicroUsd(db, taskId)
            + (client.ledger ?? []).reduce((s, e) => s + e.microUsd, 0);
          const budget = limitOf(db, taskId, 'limit.budget_micro_usd');
          if (spent >= budget) return `limit.budget_micro_usd（${spent} ≥ ${budget}）`;
          const runtime = priorRuntimeMs(db, taskId) + (now() - startedAt);
          const cap = limitOf(db, taskId, 'limit.runtime_ms');
          if (runtime >= cap) return `limit.runtime_ms（${runtime} ≥ ${cap}）`;
          // 上下文体量。读**上一轮实际发出去的**提示词体量，因为下一轮只会更大 ——
          // 发之前拿不到确切数，用上一轮当下界是保守且够用的。
          const ctxTokens = Math.max(peakContextTokens, contextPeak(client));
          const ctx = contextCapOf(db, taskId, { contextWindow: client.catalog?.[client.binding?.[tier]]?.contextWindow ?? null });
          if (ctxTokens >= ctx.cap) return `limit.context_tokens（上一轮 ${ctxTokens} ≥ ${ctx.cap}${ctx.source === 'model' ? `，按所绑模型窗口 ${ctx.window} 的 75% 封顶` : ''}）`;
          return null;
        },
      });
    } catch (e) {
      // 只接基础设施错误。别的异常照旧炸 —— 那是真 bug，不该被"优雅处理"藏起来。
      if (!isInfraError(e)) throw e;
      infra = e;
    } finally {
      flushStep();   // 无论成败都落账。失败的尝试同样烧了钱。
      onEvent({ type: 'billed', node, rows: nodeRows, microUsd: nodeMicro });
    }

    if (infra) {
      // executeNode 已经写了叙事与 node_crashed 审计；节点此时还停在 running。
      if (infra instanceof HardLimitError) {
        // 硬边界（OOM / pids）：**是**节点的错 —— 计一次重试，走 breachOut 的 hard_fail 分支
        // （审计在那里记；容器侧只抛不记，一处记一次）。
        db.run(`UPDATE nodes SET status='pending', retry_count=retry_count+1 WHERE id=?`, node.id);
        return breachOut(infra.breach, node.id);
      }
      // 厂商侧（403 / 重试耗尽的 5xx / 网络）与配置侧（ConfigError：绑定停用 / 缺 key，err.config=true）：
      // **不是**节点的错 —— 退回 pending，不计重试。两者共用 provider_error 这个退出原因（汇报触发、通知、守护进程退避都认它），
      // 靠 err.config 分文案；守护进程对 config 另有一条：注册表改过就立刻再拉（daemon.assessPhase）。
      const err = infra.summary?.() ?? { message: String(infra.message) };
      db.run(`UPDATE nodes SET status='pending' WHERE id=?`, node.id);
      audit(db, { actorKind: 'system', action: 'provider_error', targetType: 'node', targetId: node.id,
        payload: { pid, ...err } });
      onEvent({ type: 'provider_error', node, error: err });
      await reportOn('provider_error', node.id, { allowLlm: false });   // 厂商刚挂了，别再去敲它
      return finish('provider_error', { completed, nodeId: node.id, error: err });
    }
    onEvent({ type: 'node_end', cycle, node, result: r });

    if (r.kind === 'done') {
      // 产物落到分支上。提交与"节点算完成"是两件事：交接记录过了
      // 触发器节点就是 done 了，提交只是让产物可被 git 机械追溯。
      if (commit) {
        const st = workspaceStatus(workspace);
        if (st.dirty) {
          const sha = commitWorkspace(workspace,
            `${node.title}\n\nnode: ${node.id}\nhandoff: ${r.handoffId}`);
          onEvent({ type: 'commit', node, sha, changed: st.changed });
        }
      }
      // 消费本节点读过的补充上下文。**在节点 done 之后**，不在装配之后 ——
      // consumed_at 标的是"这条消息已经改变了系统状态"，而不是"被看过一眼"。
      // 节点失败退回重试时，这些消息必须还在，否则它们会在一次失败里静默蒸发。
      const ctxMsgs = pendingMessages(db, taskId).filter((m) => m.kind === 'context');
      if (ctxMsgs.length) {
        consumeMessages(db, { taskId, ids: ctxMsgs.map((m) => m.id),
          why: `已随节点 ${node.id} 的上下文读入并落进交接记录` });
      }
      await reportOn('node_done', node.id);   // 汇报触发之一：里程碑完成
      completed.push({ nodeId: node.id, title: node.title, handoffId: r.handoffId });
      idleCycles = 0;              // 有节点走到 done，死人开关归零
      continue;
    }
    if (r.kind === 'aborted') {
      // 轮级闸门掐停。节点已回 pending 且**没有**计重试。这里必须走 breachOut：
      // 掐停本身不是结论，"停下来并告诉人"才是（绝不静默死掉）。
      const b = checkLimits(db, taskId, limitsCtx())
        ?? { key: 'limit.budget_micro_usd', label: '任务花费', limit: limitOf(db, taskId, 'limit.budget_micro_usd'),
          actual: taskSpendMicroUsd(db, taskId), human: `轮级闸门掐停：${r.stopped}` };
      return breachOut(b, node.id);
    }
    if (r.kind === 'question') {
      // ← 挂起的落点。分支级挂起：还有不受牵连的就绪节点就转去跑它们，
      //   这一支的答复在下一个节点边界被消费。出口放行（egress）问题例外 —— 白名单没改之前跑别的分支
      //   多半也撞同一堵墙，且 CLI 要把核对证据打给人看，仍立刻返回。内存里照样不留任何东西。
      const others = r.question?.egress ? [] : readyNodes(db, taskId);
      if (others.length) {
        onEvent({ type: 'branch_waiting', questions: [r.question.id], ready: others.map((n) => n.id), nodeId: node.id });
        continue;
      }
      return finish('suspended', { cycles: cycle, completed,
        // ⚠️ 白名单式地挑字段，加一种问题就要记得在这里加一次 —— 而"记得"是不可靠的。
        // 例如漏了 `egress`，表现是 CLI 打出通用提示："answer 一下就行" ——
        // 人照做，分支解冻了，白名单没变，复工的实例撞上同一堵墙再问一遍。
        // 所以整条透传，只在这里显式补上 nodeId（那是编排器才知道的）。
        questions: [{ ...r.question, nodeId: node.id }] });
    }
    // 撞的是**上下文窗口**，不是别的（厂商直接报回来的 `context_exceeded`）。
    //
    // 这不是普通的 stalled：重试一次会构造出同样大的上下文，撞同一堵墙，
    // 白烧一次钱，然后被 `limit.node_retries` 判死 —— 而人拿到的结论会是
    // "这个节点搞不定"，指不到真实原因。所以直接走触顶路径，把维度说清楚。
    //
    // 走到这里说明 `limit.context_tokens` 没拦住：要么所绑模型在 MODEL_CATALOG 里没填
    // contextWindow（退回 150k 常数，对小窗口模型形同虚设），要么填的数不对。
    // 此时用**厂商说的**那个事实覆盖实测值：上限设成实测的一半，意思是"这次的正确上限至少比现在低这么多"。
    if (r.stopped === 'context_exceeded') {
      const seen = Math.max(peakContextTokens, contextPeak(client));
      const ctx = contextCapOf(db, taskId, { contextWindow: client.catalog?.[client.binding?.[tier]]?.contextWindow ?? null });
      return breachOut({
        key: 'limit.context_tokens', label: '单轮上下文体量',
        limit: ctx.cap, actual: seen,
        human: `厂商报 context_exceeded：上下文撞的是**模型窗口**，不是本系统的上限`
          + `（本系统上限 ${ctx.cap}，实测已到 ${seen}）`
          + (ctx.window ? ` —— 目录里记的窗口 ${ctx.window} 与厂商实际不符，去核对 MODEL_CATALOG` : ` —— 所绑模型没有核实过的 contextWindow，上限退回了常数；给 MODEL_CATALOG 填上经核实的窗口`),
      }, node.id);
    }

    // stalled：节点已被 executeNode 退回 pending 并计了一次重试。
    //
    // 重试就是**继续下一轮**（重生点会重新读库、重新装配），
    // 由 `limit.node_retries` 封顶，撞顶走 breachOut。
    //
    // ⚠️ 这里**不做升档**。升档要过预算闸门、要两级阶梯（推理强度 → 换模型），
    // 放在挑节点时统一做（见上面的 escalationFor），不在失败现场临时决定。
    idleCycles += 1;
    onEvent({ type: 'node_retry', node, stopped: r.stopped, idleCycles,
      retries: db.one(`SELECT retry_count FROM nodes WHERE id=?`, node.id).retry_count });
    const after = checkLimits(db, taskId, limitsCtx());
    if (after) return breachOut(after, node.id);
  }
  return finish('stalled', { cycles: maxCycles, completed, why: `到达 maxCycles=${maxCycles}` });

  // ── 任务级验收 ──────────────────────────────────────────────────────────
  async function finalize() {
    const raw = verify ? getParam(db, taskId, 'task.verify_command') : null;
    let verification = null;
    // 项目层的回归义务（project.mjs）：`task.verify_extra` 是前面任务的验收命令清单，全部要过。
    // 逐条跑，第一条不过就停 —— 与主验收同一条判据、同一条审计路径。
    const extraRaw = verify && raw ? getParam(db, taskId, 'task.verify_extra') : null;
    const extra = Array.isArray(extraRaw) ? extraRaw : (typeof extraRaw === 'string' ? JSON.parse(extraRaw) : []);
    const commands = raw ? [JSON.parse(raw), ...extra] : [];
    const verifyFailed = async (v) => {
      // **不置 done**。所有节点都交了合格的交接记录，任务级验收仍可能不过——
      // 那正是它存在的理由：交接记录管的是"这一步做完了"，任务级判据管的是
      // "合起来还成立"。这里放行等于把机械的完成判据换成投票。
      audit(db, { actorKind: 'system', action: 'task_verify_failed', targetType: 'task', targetId: taskId,
        payload: { pid, ...v } });
      // 验收没过当场挂一条事项：若只退出、等停等账本 30 分钟后报一条说不出原因的警，
      // 这 30 分钟里没有任何人收到任何东西。答复这条事项 = 让 AI 带着失败输出接着修（handback.mjs）。
      const q = raiseVerifyFailed(db, { taskId, verification: v });
      await reportOn('verify_failed');
      return finish('verify_failed', { completed, verification: v, questionId: q.questionId });
    };
    // 验收只认**已提交的那一版**。验收前工作区就脏着，"净改动"的比较基准就是脏的：
    // 例如第一次验收把已跟踪的 dist/ 重建了 → 判失败；第二次前后一样脏 → "侥幸通过"，留下的改动又卡死合并。
    // 只剩构建产物的，系统自己撤掉；别的没提交的改动不猜，判失败交给人（人的答复会转给 AI 去处理）。
    if (commands.length && workspace) {
      const pre = safeStatus(workspace)?.changed ?? [];
      const junk = pre.filter(isBuildOutput);
      if (junk.length) {
        discardChanges(workspace, junk);
        audit(db, { actorKind: 'system', action: 'workspace_build_output_discarded', targetType: 'task', targetId: taskId,
          payload: { pid, when: 'before_verify', paths: junk } });
      }
      const rest = pre.filter((p) => !isBuildOutput(p));
      if (rest.length) {
        return verifyFailed({ argv: commands[0], code: null, timedOut: false, mutated: [], dirtyBefore: rest,
          tail: `[系统] 验收前工作区里就有没提交的改动：${rest.join(' ')} —— 验收只认已提交的版本，这些改动要么提交、要么撤掉` });
      }
    }
    for (const [ci, argv] of commands.entries()) {
      onEvent({ type: 'verify', argv, extra: ci > 0 });
      // ⚠️ 不跑在只读视图上（"验收命令不许改工作区"由内核保证）—— 那样不成立：
      // `npx vitest run` 要往 node_modules/.vite-temp 写配置快照，EROFS，三个节点全 done 的任务
      // 会过不了验收。现代测试工具几乎都要在树里落缓存（vitest / jest / coverage）。
      // 做法：跑在可写视图上，前后各取一次 `git status --porcelain`（不含 ignored），
      // 验收命令**净改动**了任何被跟踪或未忽略的文件 → 一样判失败，并把清单记下来。
      // 这比只读弱一档（改了又改回去的抓不到），但把"落缓存"和"改源码"分开了 ——
      // 前者是工具的正常行为，后者才是要防的事。
      const before = safeStatus(workspace)?.changed ?? null;
      const out = await exec.execute({ file: argv[0], args: argv.slice(1) }, workspace,
        { mode: 'write', timeoutMs: 300_000 });
      const after = safeStatus(workspace)?.changed ?? null;
      const touched = before && after ? after.filter((p) => !before.includes(p)) : [];
      // 跑完一律把验收留下的改动撤掉，工作区回到验收前（= 已提交的那一版）。不撤的话下一次验收的基准又是脏的，
      // 判定就看运气；合并与交付也会被这些改动卡住。撤不撤与判不判失败是两件事：撤是为了下一步，判照旧。
      if (touched.length) discardChanges(workspace, touched);
      // 重建了已提交的构建产物不算"改了工作区"：那说明构建产物不该进仓库，不说明代码有问题。照实记一行，不判失败。
      const rebuilt = touched.filter(isBuildOutput);
      const mutated = touched.filter((p) => !isBuildOutput(p));
      verification = { argv, code: out.code, timedOut: out.timedOut, mutated,
        tail: (out.stdout + out.stderr).trim().split('\n').slice(-40).join('\n') };
      if (rebuilt.length) {
        verification.rebuilt = rebuilt;
        verification.tail += `\n[系统] 验收重新生成了已提交进仓库的构建产物：${rebuilt.join(' ')} —— 已还原成提交时的样子；构建产物不该进仓库（应写进 .gitignore 并从跟踪里摘掉）`;
      }
      if (mutated.length) verification.tail += `\n[系统] 验收命令改动了工作区：${mutated.join(' ')} —— 验收不许留下改动（已撤掉这些改动）`;
      onEvent({ type: 'verified', verification });
      if (out.code !== 0 || out.timedOut || mutated.length) return verifyFailed(verification);
    }
    // 有界面却没写 si-preview.json：签收的人看不到页面，只能打回（打回后 AI 还可能把截图提交进仓库
    // —— 越界、改范围、几人会批，平白多出一串事项）。这不该交给人：系统补一步让执行器写，
    // 写完回到这里重新验收、截图、再请签收。每个任务只补一次，补了还是没有就照旧签收（签收页照实说没截图）。
    if (exec?.isolated && workspace && !readPreviewSpec(workspace) && hasUi(workspace) && !getParam(db, taskId, PREVIEW_NODE_KEY)) {
      const nid = newId('n');
      db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES (?,?,?,?,?,'pending','low','standard',?)`,
        nid, taskId, PREVIEW_NODE.title, PREVIEW_NODE.spec, PREVIEW_NODE.acceptance, now());
      setParam(db, { taskId, key: PREVIEW_NODE_KEY, value: nid, by: { kind: 'agent', id: 'orchestrator' }, governance: 'execution' });
      audit(db, { actorKind: 'system', action: 'preview_node_added', targetType: 'task', targetId: taskId, payload: { pid, nodeId: nid } });
      onEvent({ type: 'preview_node_added', nodeId: nid });
      return AGAIN;
    }
    db.run(`UPDATE tasks SET status='done' WHERE id=?`, taskId);
    // 产物落在哪个分支的哪个 commit 上 —— 机械取数口，进审计轨，
    // 这样"任务完成时产物在哪"只凭真相源就能答。
    const ws = safeStatus(workspace);
    audit(db, { actorKind: 'system', action: 'task_done', targetType: 'task', targetId: taskId,
      payload: { pid, nodes: completed.map((c) => c.nodeId), verification,
        branch: ws?.branch ?? null, head: ws?.head ?? null } });
    // 看运行效果：仓库里有 si-preview.json，就在同一个沙箱里起服务、截图，挂到签收页上。
    // 只在真沙箱里做（测试的本地执行器不起服务）；截不出来不拦签收，原因照实记下。
    if (exec?.isolated && workspace) {
      const read = readPreviewSpec(workspace);
      if (read) {
        const outDir = join(resolve(workspace, '..', '..'), 'previews', taskId, String(ws?.head ?? 'nohead').slice(0, 12));
        const r = read.error ? { ok: false, shots: [], why: read.error } : await capturePreview(exec, workspace, read.spec, { outDir });
        audit(db, { actorKind: 'system', action: r.ok ? 'preview_captured' : 'preview_failed', targetType: 'task', targetId: taskId,
          payload: { head: ws?.head ?? null, dir: outDir, shots: r.shots, why: r.why ?? null, warnings: r.warnings ?? [], restored: r.restored ?? [], log: r.log ? String(r.log).slice(-1500) : null } });
        onEvent({ type: 'preview', ok: r.ok, shots: r.shots.length, why: r.why ?? null });
      }
    }
    // 签收是决策事项：done 那一刻按路由表找签收人；产物 commit 记在事项上。零模型调用。
    // dir 传进去，签收正文才贴得出本轮产物的差异 ——签收人手里只有汇报，而 diff 机器本来就有。
    raiseSignoffQuestion(db, { taskId, head: ws?.head ?? null, branch: ws?.branch ?? null, dir: workspace });
    // AI 替人定的事按领域交给那个领域的人过目。不挡签收；记账失败不许连累"做完"。
    try { raiseChoiceReviews(db, { taskId }); }
    catch (e) { audit(db, { actorKind: 'system', action: 'choices_review_failed', targetType: 'task', targetId: taskId, payload: { error: String(e.message).slice(0, 300) } }); }
    await reportOn('task_done');
    return finish('complete', { completed, verification, workspace: ws });
  }
}

const safeStatus = (dir) => { try { return workspaceStatus(dir); } catch { return null; } };

/**
 * 本次节点执行里见过的最大提示词体量（原价 + 缓存读 + 缓存写一起算 ——
 * 缓存只影响价钱，不影响窗口里占多少位置）。
 *
 * 读内存账本而不是 usage_ledger：与预算闸门同理，落库要等节点结束，
 * 而这道闸门必须在节点跑到一半时就能掐。
 */
const contextPeak = (client) => (client?.ledger ?? []).reduce(
  (m, e) => Math.max(m, (e.inputTokens ?? 0) + (e.cacheReadTokens ?? 0) + (e.cacheWriteTokens ?? 0)), 0);
