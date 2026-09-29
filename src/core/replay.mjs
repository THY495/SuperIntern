// 复盘：**仅凭审计轨 + 状态库**重建整个过程，不看进程日志。
//
// "不看进程日志"是硬要求。它防的是一类很容易犯的错：
// 把关键事实只打印到 stdout，人当时看见了就以为"记下来了"。进程一结束那些就没了，
// 而长期运行的 agent 恰恰是**没人在看**的时候在跑。
//
// 所以本模块的数据源被刻意限死：`audit_log` + 状态表。叙事文件（narratives/*.md）
// 只以路径形式出现，**内容一个字都不读** —— 那是产物不是真相源，而且它是
// agent-generated，拿它复盘等于让被审计者写审计报告。
//
// 完整性自检才是这一条的真正判据。"能打印出一段时间线"证明不了什么，
// 打印得再漂亮也可能漏掉一整类事件。所以下面每一条 check 都在问同一个问题：
// **状态库里有这件事发生过的痕迹，审计轨里找得到对应的记录吗？**
// 找不到就是一个洞，如实报出来，而不是让它安静地不存在。

const fmtUsd = (micro) => `$${(micro / 1e6).toFixed(6)}`;
const fmtTs = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const j = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

/**
 * 拉齐一次任务的全部可复盘素材。
 * @returns {{task, constitution, nodes, lives, events, spend, questions, assumptions, checks}}
 */
export function replay(db, taskId) {
  const task = db.one(`SELECT * FROM tasks WHERE id=?`, taskId);
  if (!task) throw new Error(`没有这个任务：${taskId}`);
  const constitution = db.one(`SELECT * FROM constitutions WHERE task_id=? AND superseded_at IS NULL
                               ORDER BY version DESC LIMIT 1`, taskId);
  const nodes = db.all(`SELECT * FROM nodes WHERE task_id=? ORDER BY rowid`, taskId);
  const nodeIds = new Set(nodes.map((n) => n.id));

  // 本任务相关的全部审计条目。target_id 命中任务或它的任一节点、问题、参数。
  // ⚠️ 按 `id`（AUTOINCREMENT）排序而不是 `ts`：同毫秒写入在 SQLite 里顺序不定。
  //    本项目的约定：**取顺序必须带唯一列**。
  const qIds = new Set(db.all(`SELECT id FROM questions WHERE task_id=?`, taskId).map((r) => r.id));
  const events = db.all(`SELECT * FROM audit_log ORDER BY id`)
    .filter((e) => e.target_id === taskId || nodeIds.has(e.target_id) || qIds.has(e.target_id)
      || j(e.payload).taskId === taskId);

  // 每一次**会花钱的进程寿命**。恢复语义的机械证据就住在这里：
  // 若干段 started…exit，pid 各不相同 —— 一个进程从头跑到尾是证明不了恢复语义的。
  //
  // ⚠️ 规划器也算一段。它此前没有括号，于是"每一分钱都落在某次寿命里吗"这条
  // 自检曾因此报红：一个任务的 planner 花费落在所有区间之外。
  // 松开检查是最容易的做法，也是错的 —— 该补的是括号，不是把尺子改短。
  const OPEN = { orchestrator_started: 'orchestrator', planner_started: 'planner' };
  const SHUT = { orchestrator_exit: 'orchestrator', planner_exit: 'planner' };
  const lives = [];
  for (const e of events) {
    if (OPEN[e.action]) {
      lives.push({ role: OPEN[e.action], pid: j(e.payload).pid, startedTs: e.ts,
        endedTs: null, kind: null, elapsedMs: null, events: [] });
    } else if (SHUT[e.action]) {
      const cur = [...lives].reverse().find((l) => l.role === SHUT[e.action] && l.endedTs === null);
      if (cur) { cur.endedTs = e.ts; cur.kind = j(e.payload).kind; cur.elapsedMs = j(e.payload).elapsedMs ?? null; }
    }
    const cur = lives.at(-1);
    if (cur) cur.events.push(e);
  }

  const spend = db.all(`SELECT role, model_id, node_id, count(*) AS calls, SUM(micro_usd) AS micro
                        FROM usage_ledger WHERE task_id=? GROUP BY role, model_id, node_id
                        ORDER BY MIN(rowid)`, taskId);
  const total = db.one(`SELECT COALESCE(SUM(micro_usd),0) AS m, count(*) AS n
                        FROM usage_ledger WHERE task_id=?`, taskId);

  const questions = db.all(`SELECT * FROM questions WHERE task_id=? ORDER BY rowid`, taskId).map((q) => ({
    ...q,
    answer: db.one(`SELECT m.* FROM messages m JOIN edges e ON e.from_id=m.id
                      AND e.relation='answers' AND e.to_id=?
                    ORDER BY m.rowid DESC LIMIT 1`, q.id) ?? null,
  }));
  const assumptions = db.all(`SELECT * FROM assumptions WHERE task_id=? ORDER BY rowid`, taskId);

  return { task, constitution, nodes, lives, events, spend, total, questions, assumptions,
    checks: integrity(db, { taskId, task, nodes, lives, events, questions }) };
}

/**
 * 完整性自检。每条都是"状态库说发生过 X，审计轨里有 X 吗"。
 * @returns {Array<{ok:boolean, name:string, detail:string}>}
 */
function integrity(db, { taskId, task, nodes, lives, events, questions }) {
  const out = [];
  // ⚠️ `n` 是这条检查**看了几个对象**。0 个不是通过，是没得可查 ——
  // 一条"0 条答复全部合规"打成 ✓ 会读成绿灯，而它什么都没证明。
  // 例如"没翻成什么都问"在一个问题都没提的前提下被记成通过，是虚的。空集要显式标成空集。
  const add = (ok, name, detail, n = 1) => out.push({ ok, name, detail, n, vacuous: n === 0 });
  const actions = events.map((e) => e.action);

  // ① 每次进程寿命都要有收尾。没有 exit = 进程被硬杀（断电 / OOM / Ctrl-C / 余额耗尽）。
  //    这不算 bug，但**必须看得见** —— 这种死法会让节点永远卡在 running。
  const dangling = lives.filter((l) => l.endedTs === null);
  add(dangling.length === 0, '进程寿命都有收尾',
    dangling.length ? `${dangling.length} 次没有 exit（${dangling.map((l) => `${l.role}#${l.pid}`).join('/')}）`
      + ` —— 进程是被硬杀的，那几段里发生的事只能靠其它条目推`
      : `${lives.length} 次寿命全部 started…exit 配对`, lives.length);

  // ② 花掉的每一分钱都要落在某次寿命里。落在外面 = 有代码在没有括号的地方调 LLM。
  const spans = lives.map((l) => [l.startedTs, l.endedTs ?? Infinity]);
  const spendRows = db.one(`SELECT count(*) AS n FROM usage_ledger WHERE task_id=?`, taskId).n;
  const orphanSpend = db.all(`SELECT id, ts, role, micro_usd FROM usage_ledger WHERE task_id=?`, taskId)
    .filter((r) => !spans.some(([a, b]) => r.ts >= a && r.ts <= b));
  add(orphanSpend.length === 0, '花费都落在某次进程寿命内',
    orphanSpend.length ? `${orphanSpend.length} 条落在所有寿命区间之外（如 ${orphanSpend[0].role}@${fmtTs(orphanSpend[0].ts)}）`
      : `全部 ${spendRows} 条都在区间内`, spendRows);

  // ③ done 的节点必须有交接记录。库层触发器已经强制，这里是**独立复核**：
  //    复盘不该相信被复盘对象自己的护栏。
  const doneCount = nodes.filter((n) => n.status === 'done').length;
  const doneNoHandoff = nodes.filter((n) => n.status === 'done'
    && !db.one(`SELECT id FROM handoffs WHERE node_id=?`, n.id));
  add(doneNoHandoff.length === 0, 'done 的节点都有交接记录',
    doneNoHandoff.length ? `${doneNoHandoff.map((n) => n.id).join('/')} 置了 done 却没有交接`
      : `${doneCount} 个 done 节点全部有交接`, doneCount);

  // ④ 每个跑过的节点（started_at 非空）都要在审计轨里留下一个终局。
  //    ⚠️ 这一条是明知会失败也要写的：`pending→running` 目前**没有**审计条目，
  //    只有 nodes.started_at 这一个可变列记着。复盘的数据源是"审计轨 + 状态库"，
  //    所以严格讲不算违规；但状态列会被后续写覆盖，而审计轨不会 ——
  //    真正被硬杀在半途的那次，起跑时刻就只剩一个可能已被覆盖的 started_at。
  const ran = nodes.filter((n) => n.started_at);
  const outcomeActions = new Set(['node_done', 'question_raised', 'node_stalled',
    'node_crashed', 'node_aborted', 'node_reclaimed']);
  const noOutcome = ran.filter((n) => !events.some((e) => e.target_id === n.id && outcomeActions.has(e.action)));
  add(noOutcome.length === 0, '跑过的节点都在审计轨里有终局',
    noOutcome.length ? `${noOutcome.map((n) => `${n.id}(${n.status})`).join('/')} 有 started_at 但审计轨里没有终局条目`
      : `${ran.length} 个跑过的节点都有终局`, ran.length);

  // ⑤ 答复必须挂在认证通道上。没有 token_id 的"答复"不具指令效力。
  const answered = questions.filter((q) => q.status === 'answered');
  const badAuth = answered.filter((q) => !q.answer || q.answer.trust_label !== 'user-authenticated'
    || !q.answer.token_id);
  add(badAuth.length === 0, '答复都经过认证通道',
    badAuth.length ? `${badAuth.map((q) => q.id).join('/')} 标为 answered 但答复不是 user-authenticated`
      : `${answered.length} 条答复全部带 token_id 且 trust_label=user-authenticated`, answered.length);

  // ⑥ 任务置 done 必须有 task_done 审计。状态列可以被任何一条 UPDATE 写成 done，
  //    审计轨是 append-only —— 两边对不上说明有人绕过了编排器。
  add(task.status !== 'done' || actions.includes('task_done'), '置 done 有对应审计',
    task.status === 'done'
      ? (actions.includes('task_done') ? '有 task_done' : '⚠️ 任务是 done 但审计轨里没有 task_done —— 有人绕过了编排器')
      : `任务当前是 ${task.status}，不适用`, task.status === 'done' ? 1 : 0);

  // ⑦ 节点执行都要罩在某段沙箱寿命里。
  //
  //    ⚠️ 它问的**不是**"合不合规"，而是和 ①–⑥ 同一族的完整性问题：
  //    **每一次节点执行，审计轨里都答得出它跑在哪吗**。答案只有两种合格形态：
  //    落在某段 sandbox_started…stopped 里，或者有一条 sandbox_skipped 认领它。
  //    两种都没有 = 审计洞。
  //
  //    这个区分是有意的。"在宿主上跑了"是**策略**问题，由 CLI 的默认值把关
  //    （默认开沙箱，关掉要显式且会打警告）；复盘是镜子不是闸门 ——
  //    把两件事塞进同一条检查，末尾那句"N 项对不上"就同时是两个意思了。
  //    所以宿主跑的次数即便在 ✓ 的情况下也**始终写在详情里**，不藏。
  //
  //    ⚠️ 对引入沙箱之前的任务这一条会红：那时连 sandbox_skipped 都不存在，
  //    审计轨真的答不出"跑在哪"。不做追溯粉饰。
  const sbSpans = [];
  for (const e of events) {
    if (e.action === 'sandbox_started') sbSpans.push([e.ts, Infinity]);
    else if (e.action === 'sandbox_stopped' && sbSpans.length) sbSpans.at(-1)[1] = e.ts;
  }
  const skipSpans = [];
  for (const e of events) {
    if (e.action === 'sandbox_skipped') skipSpans.push([e.ts, j(e.payload).pid]);
  }
  const runEvents = events.filter((e) => outcomeActions.has(e.action) || e.action === 'task_verify_failed');
  const bare = runEvents.filter((e) => !sbSpans.some(([a, b]) => e.ts >= a && e.ts <= b));
  const unaccounted = bare.filter((e) => !skipSpans.some(([ts]) => ts <= e.ts));
  add(unaccounted.length === 0, '每次执行都答得出跑在哪',
    unaccounted.length
      ? `${unaccounted.length}/${runEvents.length} 次既不在任何沙箱寿命内，也没有 sandbox_skipped 认领 ——`
        + ` 审计轨答不出这几次跑在哪`
      : bare.length
        ? `${runEvents.length} 次执行：${runEvents.length - bare.length} 次在沙箱内、`
          + `**${bare.length} 次在宿主机上**（有 sandbox_skipped 认领，是知情的）`
        : `全部 ${runEvents.length} 次都在沙箱寿命内（${sbSpans.length} 段）`, runEvents.length);

  return out;
}

/** 复盘的人类可读渲染。 */
export function renderReplay(r) {
  const L = [];
  const p = (s = '') => L.push(s);
  const bar = (c = '─') => p(c.repeat(72));

  bar('═'); p(`复盘 ${r.task.id}  ${r.task.title}`);
  p(`状态 ${r.task.status}｜建于 ${fmtTs(r.task.created_at)}｜宪法 v${r.constitution?.version ?? '?'}`);
  p(`数据源：audit_log + 状态库。**没有读任何进程日志或叙事正文**`); bar('═');

  p(`\n## 进程寿命（${r.lives.length} 次）`);
  for (const [i, l] of r.lives.entries()) {
    const dur = l.endedTs ? `${((l.endedTs - l.startedTs) / 1000).toFixed(1)}s` : '未收尾';
    p(`  ${i + 1}. ${l.role.padEnd(12)} pid ${String(l.pid ?? '?').padEnd(7)} ${fmtTs(l.startedTs)} → `
      + `${l.endedTs ? fmtTs(l.endedTs) : '（无 exit）'}  ${dur}  结局 ${l.kind ?? '⚠️ 被硬杀'}`);
  }
  if (r.lives.length) {
    const pids = new Set(r.lives.map((l) => l.pid));
    p(`  ${pids.size} 个不同的 pid —— "进程真的退出"在这里是机械可查的`);
  } else {
    p(`  （本任务还没跑过任何会花钱的进程）`);
  }

  p(`\n## 时间线`);
  let lastPid = null;
  for (const e of r.events) {
    const pl = j(e.payload);
    if (pl.pid && pl.pid !== lastPid) { p(`  ── pid ${pl.pid} ──`); lastPid = pl.pid; }
    p(`  ${fmtTs(e.ts)} [${e.actor_kind}${e.actor_id ? `/${e.actor_id}` : ''}] ${e.action}`
      + `${e.target_id ? ` → ${e.target_id}` : ''}${summarize(e.action, pl)}`);
  }

  p(`\n## 节点`);
  for (const n of r.nodes) {
    p(`  [${n.status}] ${n.id} 重试 ${n.retry_count}｜${n.risk_tier}/${n.model_tier}｜${n.title}`);
  }

  p(`\n## 花费  ${fmtUsd(r.total.m)}（${r.total.n} 次调用）`);
  for (const s of r.spend) {
    p(`  ${s.role.padEnd(9)} ${s.model_id.padEnd(30)} ${String(s.calls).padStart(3)} 次 ${fmtUsd(s.micro)}`
      + `${s.node_id ? `  ${s.node_id}` : ''}`);
  }

  if (r.questions.length) {
    p(`\n## 问题与答复`);
    for (const q of r.questions) {
      p(`  [${q.status}] ${q.id} Ⅲ/Ⅱ/Ⅰ 第 ${q.level} 级 · 定级来源 ${q.level_source}`);
      p(`      ${q.text.split('\n')[0].slice(0, 100)}`);
      if (q.answer) {
        p(`      ↳ 答复 ${q.answer.id}｜信任标签 ${q.answer.trust_label}｜令牌 ${q.answer.token_id ?? '（无）'}`);
        p(`        ${q.answer.body.split('\n')[0].slice(0, 100)}`);
      }
    }
  }

  const act = r.assumptions.filter((a) => a.status === 'active');
  if (r.assumptions.length) {
    p(`\n## 假设登记表  ${r.assumptions.length} 条，活跃 ${act.length} 条`);
    for (const a of r.assumptions) {
      p(`  [${a.status}${a.must_disclose ? '/须披露' : ''}] ${a.subject_key} ← ${a.verified_against ?? '?'}`);
    }
  }

  p(`\n## 复盘完整性自检`);
  // 空集打 `·` 而不是 `✓`：0 个对象的"全部合规"什么都没证明，打成绿勾会读成绿灯。
  for (const c of r.checks) p(`  ${c.vacuous ? '·' : c.ok ? '✓' : '⚠️'} ${c.name}：${c.detail}`);
  const bad = r.checks.filter((c) => !c.ok).length;
  const vac = r.checks.filter((c) => c.vacuous).length;
  p(`\n  ${bad ? `⚠️ ${bad} 项对不上 —— 复盘在这里是**不成立**的，别当它过了`
    : vac === r.checks.length ? '⚠️ 每一项都是空集 —— 这次复盘什么都没验到，不构成复盘成立的证据'
      : `全部对得上：复盘成立${vac ? `（其中 ${vac} 项是空集，标 \`·\`，不计入证据）` : ''}`}`);
  return L.join('\n');
}

/** 只挑对复盘有意义的字段，别把整个 payload 糊上去。 */
function summarize(action, p) {
  switch (action) {
    case 'plan_persisted': return `  ${p.count} 个节点`;
    case 'handoff_rejected': return `  ${(p.errs ?? []).length} 条错`;
    case 'question_raised': return `  第 ${p.level} 级`;
    case 'limit_breached': return `  ${p.key} 实测 ${p.actual} ≥ 上限 ${p.limit}`;
    case 'limit_set': return `  ${p.key} = ${p.value}`;
    case 'node_aborted': return `  ${p.reason}`;
    case 'node_stalled': return `  ${p.stopped}，${p.iterations} 轮`;
    case 'node_done': return `  产物 ${(p.artifacts ?? []).join(' ')}`;
    case 'node_crashed': return `  ${String(p.error).slice(0, 80)}`;
    case 'orchestrator_exit':
    case 'planner_exit': return `  ${p.kind}${p.elapsedMs != null ? `，${(p.elapsedMs / 1000).toFixed(1)}s` : ''}`;
    case 'task_verify_failed': return `  exit=${p.code}`;
    case 'context_assembled': return `  ${p.role ?? ''} ${p.recipe ?? ''}`;
    case 'workspace_created': return `  ${p.branch}${p.ref ? ` @ ${String(p.ref).slice(0, 8)}` : ''}`;
    default: return '';
  }
}
