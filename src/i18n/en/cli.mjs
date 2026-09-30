// 英文目录：cli。键是中文原文（逐字），值是英文。占位符 {名字} 两边一致。
export default {
  '错误：{msg}': 'Error: {msg}',
  // init
  '--bind 要写成 tier=服务商/模型，实得 {sp}': '--bind must be written as tier=provider/model, got {sp}',
  '按 .env 里已有 key 的 {picked} 选了三档的默认绑定（出厂默认里有的档位那家没填 key）。以后改：node src/cli.mjs bind set 档位=服务商/模型，或看板"设置 → 模型分配"': 'Picked default bindings for all three tiers from {picked}, whose key is already in .env (the factory default provider for some tier has no key). To change later: node src/cli.mjs bind set tier=provider/model, or "Settings → Model assignment" on the board',
  '已建库并创建管理员 {userId}{who}': 'Database created with admin {userId}{who}',
  '（{name}）': ' ({name})',
  '（显示名 local-owner，可用 --name 改）': ' (display name local-owner; change it with --name)',
  'CLI 令牌写入 {file}（库里只有哈希，此文件是唯一副本）': 'CLI token written to {file} (the database only keeps a hash; this file is the only copy)',
  '库已就绪，管理员 {userId} 显示名改为 {name}': 'Database ready; admin {userId} renamed to {name}',
  '库已就绪，管理员 {userId}': 'Database ready; admin {userId}',
  // new / plan
  '无法新建任务：{why}': 'Cannot create a task: {why}',
  '独立任务已取消。请新建项目：node src/cli.mjs project new --goal <目标> --done <完成定义> (--source <仓库> | --empty)\n一次性的小活就是只有一个任务的项目；已有项目里加任务：project append <项目 id> --brief <文本或文件>': 'Standalone tasks are gone. Create a project instead: node src/cli.mjs project new --goal <goal> --done <definition of done> (--source <repo> | --empty)\nA one-off job is just a project with a single task; to add a task to an existing project: project append <project id> --brief <text or file>',
  '缺少 {f}（用 --file 给 JSON，或 --goal / --dod 等参数）': 'Missing {f} (pass JSON with --file, or use --goal / --dod etc.)',
  '任务 {taskId}  宪法块 {constId}\n  {title}': 'Task {taskId}  contract {constId}\n  {title}',
  '  任务级验收命令：{cmd}（宪法层参数，agent 不可自改）': '  Task acceptance command: {cmd} (a contract-level parameter; the agent cannot change it)',
  '  ⚠️ 没给 --verify —— 全部节点完成后没有任务级机械判据，任务会直接置 done': '  ⚠️ No --verify given — once all steps finish there is no mechanical task-level check, and the task goes straight to done',
  '\n下一步：node src/cli.mjs plan {taskId}': '\nNext: node src/cli.mjs plan {taskId}',
  '没有这个任务：{id}': 'No such task: {id}',
  '任务没有生效中的宪法块': 'The task has no active contract',
  '任务已有 {n} 个节点。重规划属五步流水线，不是 plan 的事；确要覆盖请加 --force': 'The task already has {n} steps. Replanning belongs to the five-step pipeline, not to this command; add --force if you really want to overwrite',
  '宪法块草案还没批准（draft.stage={stage}）。在看板答复批准问题，或 node src/cli.mjs draft {taskId}': 'The contract draft is not approved yet (draft.stage={stage}). Answer the approval item on the board, or run node src/cli.mjs draft {taskId}',
  '⛔ 规划前体检不过：{human}': '⛔ Pre-planning check failed: {human}',
  '已生成 Ⅲ 级问题 {qid}（hard_rule），任务转入 waiting。': 'Raised level Ⅲ item {qid} (hard_rule); the task is now waiting.',
  '  加额：node src/cli.mjs limit {taskId} --{key} <新值>': '  Raise the limit: node src/cli.mjs limit {taskId} --{key} <new value>',
  'plan --mode fake 要配 --script <响应脚本.json>（fake 不调模型，按脚本挨个吐响应）': 'plan --mode fake needs --script <responses.json> (fake mode calls no model; it replays the scripted responses one by one)',
  '规划中（档位 {tier}）…': 'Planning (tier {tier})…',
  '记账 {rows} 次调用，{usd}': 'Billed {rows} calls, {usd}',
  '\n规划器提出 Ⅰ/Ⅱ/Ⅲ 级中的第 {level} 级问题，任务转入 waiting：': '\nThe planner raised a level {level} item (of Ⅰ/Ⅱ/Ⅲ); the task is now waiting:',
  '  卡在这条约束上：{c}': '  Blocked on this constraint: {c}',
  '  无人回答时的默认动作：{a}': '  Default action if nobody answers: {a}',
  '  Ⅲ 级问题不得有默认动作，无限期等待（库层强制）': '  Level Ⅲ items may not have a default action; it waits indefinitely (enforced by the database)',
  '  ⚠️ 第 {level} 级却没给默认动作 —— 行为上等同无限期阻塞': '  ⚠️ Level {level}, but no default action given — in practice it blocks indefinitely',
  '\n问题 {id}。回答后重跑 plan。': '\nItem {id}. Run plan again after answering.',
  '\n规划成功：{n} 个节点，第 {attempts} 次尝试通过': '\nPlanned: {n} steps, passed on attempt {attempts}',
  '前 {n} 次被护栏拒绝：': 'The first {n} attempts were rejected by the guardrails:',
  '  第 {i} 次：{errs}': '  Attempt {i}: {errs}',
  '；': '; ',
  // limit / workspace
  '--{flag} 要一个非负数字，实得 {v}': '--{flag} needs a non-negative number, got {v}',
  '任务 {taskId} 的硬上限': 'Hard limits for task {taskId}',
  '　已改 {n} 项': '  changed {n}',
  '  [显式设置]': '  [set explicitly]',
  '  [内置天花板]': '  [built-in ceiling]',
  '\n⛔ 当前已触顶：{human}': '\n⛔ Limit reached: {human}',
  '\n当前未触顶': '\nNo limit reached',
  '已创建工作区 {dir}': 'Created workspace {dir}',
  '已存在工作区 {dir}': 'Workspace already exists: {dir}',
  '  分支 {branch} @ {head}  ← agent 动这里，本进程加载的是 {root}': '  Branch {branch} @ {head}  ← the agent works here; the running process is loaded from {root}',
  '  基线 {ref}（不是当前 HEAD）': '  Baseline {ref} (not the current HEAD)',
  // bind
  '--bind 的档位要是 {tiers}，实得 {tier}': 'The --bind tier must be {tiers}, got {tier}',
  '--bind 的模型 {model}：{why}。可选：\n  {options}': '--bind model {model}: {why}. Options:\n  {options}',
  '--bind 只覆盖本次进程：{specs}（库里是 {db}；常态改用 node src/cli.mjs bind set）': '--bind overrides this process only: {specs} (the database has {db}; for a lasting change use node src/cli.mjs bind set)',
  '⚠ {who} 的 --bind 与库里的绑定一致，已忽略。常态绑定在库里，启动参数里的 --bind 可以删掉（重新 install 一次守护进程）。': '⚠ The --bind given to {who} matches the database binding and was ignored. Bindings live in the database; you can drop --bind from the startup arguments (reinstall the auto-run service once).',
  '{who} 不接 --bind：库里已有绑定（{db}），与启动参数不一致（{diff}）。': '{who} does not accept --bind: the database already has bindings ({db}) that differ from the startup arguments ({diff}). ',
  '要改绑用 node src/cli.mjs bind set {diff}；要保留库里的就把启动参数里的 --bind 删掉（重新 install 一次守护进程）。--bind 只在 plan / run / draft 上是一次性覆盖': 'To rebind, use node src/cli.mjs bind set {diff}; to keep the database bindings, remove --bind from the startup arguments (reinstall the auto-run service once). --bind is a one-off override only for plan / run / draft',
  '[SuperIntern] {who} 没起来：启动参数的 --bind 与库里不一致': '[SuperIntern] {who} did not start: --bind in the startup arguments differs from the database',
  '库里没有绑定行，已按 --bind 写入（以后启动不用再带）：': 'No bindings in the database; wrote them from --bind (no need to pass it on later starts):',
  '档位绑定（库）：': 'Tier bindings (database):',
  '档位绑定（代码默认值，库里还没写）：': 'Tier bindings (code defaults; not yet written to the database):',
  '  推理强度 {effort}': '  reasoning effort {effort}',
  '  （不在目录里）': '  (not in the catalog)',
  '  ⚠ {tier}：{why}': '  ⚠ {tier}: {why}',
  // run
  '工作区不存在。先跑 node src/cli.mjs workspace {taskId}': 'The workspace does not exist. Run node src/cli.mjs workspace {taskId} first',
  '宪法块草案还没批准（draft.stage={stage}），没有可执行的计划。先在看板答复批准问题。': 'The contract draft is not approved yet (draft.stage={stage}), so there is no plan to run. Answer the approval item on the board first.',
  '编排器 pid {pid} · 任务 {taskId} · 工作区 {dir}': 'Orchestrator pid {pid} · task {taskId} · workspace {dir}',
  ' · 通知 {kinds}': ' · notifications {kinds}',
  '⚠️ --no-sandbox：命令直接在**宿主机**上跑，这不是隔离。\n   只有离线自测才该这么用（不得对任何真实用户任务这样运行）。': '⚠️ --no-sandbox: commands run directly on the **host**. This is not isolation.\n   Only use it for offline self-tests (never run a real user task this way).',
  '沙箱 {name}（{how}）· {cli} · {image} · 网络 {network} · 内存 {memory} · PID {pids}': 'Sandbox {name} ({how}) · {cli} · {image} · network {network} · memory {memory} · PID {pids}',
  '  出口白名单：{groups} → {n} 个域，经代理 {proxy}，名单外在 CONNECT 阶段即拒': '  Egress allowlist: {groups} → {n} domains via proxy {proxy}; anything else is refused at CONNECT',
  '  出网：**完全断网**（没配 egress.groups）。要放行按生态加：node src/cli.mjs egress {taskId} --allow npm': '  Network: **fully offline** (no egress.groups set). To allow access, add an ecosystem: node src/cli.mjs egress {taskId} --allow npm',
  '\n── 轮 {cycle} ── 任务 {status}｜节点 {counts}｜待答问题 {open}': '\n── Cycle {cycle} ── task {status} | steps {counts} | open items {open}',
  '↻ 认领 {nodeId}：启动时它还停在 running —— 上一个进程死在它手里，退回 pending 重来': '↻ Reclaimed {nodeId}: it was still running at startup — the previous process died on it; back to pending to retry',
  '⏱ 超时走默认（{level} 级 {qid}）：无人答复，按登记的默认动作放行 —— {action}': '⏱ Timed out, default taken (level {level} {qid}): nobody answered, so the registered default action goes ahead — {action}',
  '⏱ 超时升级（Ⅱ 级 {qid}）：第一段无人答复；再无人答将退保守默认。请尽快：node src/cli.mjs answer {qid} "..."': '⏱ Timed out, escalated (level Ⅱ {qid}): nobody answered in the first window; if nobody answers again it falls back to the conservative default. Please answer soon: node src/cli.mjs answer {qid} "..."',
  '[SuperIntern] Ⅱ 级问题超时升级': '[SuperIntern] Level Ⅱ item escalated after timeout',
  '再无人答将退保守默认。回答：node src/cli.mjs answer {qid} "..."': 'If nobody answers again it falls back to the conservative default. Answer: node src/cli.mjs answer {qid} "..."',
  '⏱ 超时后仍挂起（{qid}）：升级后无人答，且没有默认可退 —— 分支继续等人': '⏱ Still waiting after timeout ({qid}): nobody answered after escalation and there is no default to fall back on — the branch keeps waiting',
  '⬆ 升档 [{nodeId}] {from} → {to}：同一节点已失败 {n} 次，预计再花 {usd}，已过预算与时长闸门': '⬆ Tier up [{nodeId}] {from} → {to}: this step has failed {n} times; estimated extra spend {usd}, within the budget and time gates',
  '执行 [{nodeId}] {title}（档位 {tier}）': 'Running [{nodeId}] {title} (tier {tier})',
  '⏸ 分支等人（问题 {qs}）—— 转去跑不受牵连的就绪节点：{ready}。答复在下一个节点边界被消费。': '⏸ Branch waiting on people (items {qs}) — switching to unaffected ready steps: {ready}. Answers are picked up at the next step boundary.',
  '  轮 {i}: {reason}': '  Turn {i}: {reason}',
  '  记账 {rows} 次调用，{usd}': '  Billed {rows} calls, {usd}',
  '  装配 {id}（{recipe}）{tokens} token｜{cache}': '  Assembly {id} ({recipe}) {tokens} tokens | {cache}',
  '  复工：简报 {briefingId} + 答复 {answerId}': '  Resumed: briefing {briefingId} + answer {answerId}',
  '｜挂起时 {before} token → 重建 {after} token（保留 {pct}%）': ' | {before} tokens at suspend → {after} tokens rebuilt ({pct}% kept)',
  '  叙事 {ref}': '  Narrative {ref}',
  '  交接被拒 {i}：{errs}': '  Handoff rejected {i}: {errs}',
  '  ✅ 交接记录 {id} 已过库层触发器': '  ✅ Handoff record {id} passed the database triggers',
  '  ⚠️ 假设冲突 {key}：与 {prior} 撞车': '  ⚠️ Assumption conflict {key}: clashes with {prior}',
  '计划已按修正改动（未触发确认门，自动生效）　提案 {id}': 'Plan changed per the correction (no approval gate triggered; applied automatically)  proposal {id}',
  '作废 {voided}｜改规格 {respecced}｜重挂依赖 {rewired}｜新增 {added}': 'Voided {voided} | respecced {respecced} | rewired {rewired} | added {added}',
  '要看全文/回溯：node src/cli.mjs revision {taskId} --history': 'Full text / history: node src/cli.mjs revision {taskId} --history',
  '  已提交 {sha}：{files}': '  Committed {sha}: {files}',
  '\n📣 汇报 {id}（{trigger}{tpl}）：{summary}': '\n📣 Report {id} ({trigger}{tpl}): {summary}',
  '，模板': ', template',
  '   自作主张 {n} 条 —— 看 node src/cli.mjs reports {taskId} --show {id}': '   {n} decisions made on its own — see node src/cli.mjs reports {taskId} --show {id}',
  '   ⚠️ 持久化纪律审计：{n} 条 —— {first}…': '   ⚠️ Persistence audit: {n} findings — {first}…',
  '[SuperIntern] 汇报：{summary}': '[SuperIntern] Report: {summary}',
  '任务 {taskId}｜汇报 {id}（{trigger}）': 'Task {taskId} | report {id} ({trigger})',
  '｜自作主张 {n} 条': ' | {n} decisions made on its own',
  '\n任务级验收：{cmd}': '\nTask acceptance check: {cmd}',
  '沙箱 {name} 已删除（复工时从镜像重建，不留热容器）': 'Sandbox {name} removed (rebuilt from the image on resume; no warm containers are kept)',
  '分支挂起，编排器退出（pid {pid}）。完成 {n} 个节点。': 'Branch suspended; orchestrator exiting (pid {pid}). {n} steps completed.',
  '\n第 {level} 级问题 {id}：\n\n  {text}\n': '\nLevel {level} item {id}:\n\n  {text}\n',
  '  挂起时上下文 {tokens} token，已丢弃；复工简报 {briefingId} 留在库里': '  Context at suspend was {tokens} tokens and has been dropped; resume briefing {briefingId} is kept in the database',
  '  ⚠️ 这是**状态机强制定级**的 Ⅲ 级问题（level_source=hard_rule），不是模型自评': '  ⚠️ This is a level Ⅲ item **set by the state machine** (level_source=hard_rule), not the model\'s own rating',
  '  证据核对：{check}': '  Evidence check: {check}',
  '请求与审计轨里的被拒记录对得上': 'the request matches the refusals in the audit trail',
  '**对不上** —— 它要的和它实际撞的墙不是一回事，看正文': '**does not match** — what it asks for is not what it actually hit; read the text',
  '无被拒记录（此前完全断网，本就不产生）': 'no refusals on record (the sandbox was fully offline, which produces none)',
  '\n同意放行（一条命令同时改白名单 + 答复 + 解冻）：': '\nTo allow (one command updates the allowlist, answers, and unfreezes):',
  '不同意：\n  node src/cli.mjs answer {id} "不放行，理由……"': 'To refuse:\n  node src/cli.mjs answer {id} "Not allowed, because…"',
  '\n回答它：\n  node src/cli.mjs answer {id} "你的答复"': '\nAnswer it:\n  node src/cli.mjs answer {id} "your answer"',
  '然后重跑 run —— 那会是一个**新进程**，只能看见库里的东西。': 'Then run again — that will be a **new process** that only sees what is in the database.',
  '任务早已完成，也没有待处理的修正或新指令 —— 本次没有新工作。': 'The task is already done and there are no pending corrections or new instructions — nothing to do this time.',
  '  要再改它：node src/cli.mjs say {taskId} "……" --kind correction   然后再 run': '  To change it again: node src/cli.mjs say {taskId} "…" --kind correction   then run again',
  '  看产物在哪：node src/cli.mjs show {taskId}': '  See where the output is: node src/cli.mjs show {taskId}',
  '任务完成。{n} 个节点，产物在分支 {branch} @ {head}': 'Task done. {n} steps; output is on branch {branch} @ {head}',
  '任务级验收 {cmd} exit={code}': 'Task acceptance check {cmd} exit={code}',
  '⚠️ 未配置任务级验收命令（建任务时的 --verify），完成判据只到节点层': '⚠️ No task acceptance command set (--verify when creating the task); completion is only checked at the step level',
  '⛔ 硬上限触顶，编排器停止（pid {pid}）。完成 {n} 个节点。': '⛔ Hard limit reached; orchestrator stopped (pid {pid}). {n} steps completed.',
  '\n已生成 Ⅲ 级问题 {qid}（定级来源 hard_rule，非模型自评），任务转入 waiting。': '\nRaised level Ⅲ item {qid} (level source hard_rule, not the model\'s own rating); the task is now waiting.',
  '  加额继续：node src/cli.mjs limit {taskId} --{key} <新值>': '  Raise the limit and continue: node src/cli.mjs limit {taskId} --{key} <new value>',
  '  看发生了什么：node src/cli.mjs replay {taskId}': '  See what happened: node src/cli.mjs replay {taskId}',
  '⛔ 硬边界触顶，编排器停止（pid {pid}）。完成 {n} 个节点。': '⛔ Hard boundary reached; orchestrator stopped (pid {pid}). {n} steps completed.',
  '  这一维**不支持加额**。节点已退回 pending（计一次重试）。': '  This limit **cannot be raised**. The step is back to pending (counted as one retry).',
  '  先看它在干什么：node src/cli.mjs replay {taskId}': '  First see what it was doing: node src/cli.mjs replay {taskId}',
  '⛔ 配置问题，编排器停止（pid {pid}）。完成 {n} 个节点。': '⛔ Configuration problem; orchestrator stopped (pid {pid}). {n} steps completed.',
  '\n节点已退回 pending，**不计重试** —— 这不是节点的错，也没有发出请求。': '\nThe step is back to pending, **not counted as a retry** — it is not the step\'s fault, and no request was sent.',
  '  看三档现在绑的什么、哪档用不了：node src/cli.mjs bind': '  See what the three tiers are bound to and which one is unusable: node src/cli.mjs bind',
  '  改绑：node src/cli.mjs bind set {tier}=<服务商/模型>，或看板"设置 → 模型分配"；缺 key 的在"设置 → 服务商"里填': '  Rebind: node src/cli.mjs bind set {tier}=<provider/model>, or "Settings → Model assignment" on the board; fill in missing keys under "Settings → Providers"',
  '  改完再跑：node src/cli.mjs run {taskId}（守护进程在跑的话，它看到改动会自己接着拉）': '  Then run again: node src/cli.mjs run {taskId} (if auto-run is on, it picks the change up by itself)',
  '⛔ 厂商侧错误，编排器停止（pid {pid}）。完成 {n} 个节点。': '⛔ Provider-side error; orchestrator stopped (pid {pid}). {n} steps completed.',
  '（网络）': ' (network)',
  '，重试 {n} 次仍失败': ', still failing after {n} retries',
  '，不可重试': ', not retryable',
  '\n节点已退回 pending，**不计重试** —— 这不是节点的错。': '\nThe step is back to pending, **not counted as a retry** — it is not the step\'s fault.',
  '  换一家接着跑：node src/cli.mjs bind set {tier}=<服务商/模型>（常态，下个节点起生效）': '  Switch providers and carry on: node src/cli.mjs bind set {tier}=<provider/model> (lasting; takes effect from the next step)',
  '  只试这一次：node src/cli.mjs run {taskId} --bind {tier}=<服务商/模型>（模型名打错会列出可绑的）': '  Just this once: node src/cli.mjs run {taskId} --bind {tier}=<provider/model> (a mistyped model name lists the bindable ones)',
  '⏸ 修正的重规划方案要你批准（pid {pid}）。完成 {n} 个节点。': '⏸ The replan for a correction needs your approval (pid {pid}). {n} steps completed.',
  '  为什么要批：{gate}': '  Why it needs approval: {gate}',
  '\n看细节：node src/cli.mjs revision {taskId}': '\nDetails: node src/cli.mjs revision {taskId}',
  '批准：  node src/cli.mjs revision {taskId} --approve': 'Approve: node src/cli.mjs revision {taskId} --approve',
  '驳回：  node src/cli.mjs revision {taskId} --reject': 'Reject:  node src/cli.mjs revision {taskId} --reject',
  '批了但有保留意见：在批准后面再加 --reservation "…" —— 照批，那句话进约定清单、标〔保留意见〕，不改变任何一条': 'Approve with a reservation: add --reservation "…" after approving — it is approved as is; the sentence goes into the agreed decisions marked [Reservation] and changes nothing',
  '⚠️ 重规划器几次都产不出通过校验的方案（pid {pid}）：{why}': '⚠️ The replanner could not produce a valid plan after several tries (pid {pid}): {why}',
  '  第 {i} 次被拒：{errs}': '  Attempt {i} rejected: {errs}',
  '\n那条修正**没有被消费** —— 没处理成就不能标成处理过了，重跑 run 会再试一次。': '\nThat correction was **not consumed** — it cannot be marked handled when it was not; running again will retry.',
  '  修正太含糊的话，换一句更具体的说法：node src/cli.mjs say {taskId} "…" --kind correction': '  If the correction is too vague, say it more specifically: node src/cli.mjs say {taskId} "…" --kind correction',
  '⚠️ 全部节点已完成，但任务级验收没过 —— **任务不置 done**': '⚠️ All steps finished, but the task acceptance check failed — **the task is not marked done**',
  '⚠️ 停在 {kind}：{why}': '⚠️ Stopped at {kind}: {why}',
  // reports
  '没有这份汇报：{id}': 'No such report: {id}',
  '\n—— {by}｜装配自 {n} 条真相源记录': ' — {by} | assembled from {n} source-of-truth records',
  '模型生成摘要': 'model-written summary',
  '模板': 'Template',
  '｜已读': ' | read',
  '任务 {taskId} 没有任何汇报。': 'Task {taskId} has no reports.',
  '任务 {taskId} 没有未读汇报。（--all 看全部）': 'Task {taskId} has no unread reports. (--all shows all)',
  '/模板': '/template',
  '\n已标 {n} 份为已读。': '\nMarked {n} as read.',
  '\n看全文：--show <id>　标已读：--read': '\nFull text: --show <id>  mark as read: --read',
  // egress / sources
  '⚠️ 已放行 {g}，但找不到 CLI 令牌 {file}，问题 {qid} 没能自动答复。': '⚠️ Allowed {g}, but the CLI token {file} was not found, so item {qid} could not be answered automatically.',
  '   手动答：node src/cli.mjs answer {qid} "已放行 {g}"': '   Answer it yourself: node src/cli.mjs answer {qid} "Allowed {g}"',
  '已放行生态 {g}（经 cli egress --allow）。沙箱重启后即可访问该生态的域，其余仍拒。': 'Allowed ecosystem {g} (via cli egress --allow). After the sandbox restarts, that ecosystem\'s domains are reachable; everything else is still refused.',
  '  同时答复了 {qid}：分支解冻': '  Also answered {qid}: branch unfrozen',
  '，另有 {n} 个问题还开着': '; {n} other items are still open',
  '，任务转 running': '; task back to running',
  '⚠️ 已放行 {g}，但答复 {qid} 失败：{err}': '⚠️ Allowed {g}, but answering {qid} failed: {err}',
  '任务 {taskId} 可访问的网络': 'Network access for task {taskId}',
  '（来自项目 {pid} 的联网设置，项目下所有任务共用）': ' (from the network settings of project {pid}, shared by all its tasks)',
  '  （空）—— 沙箱**完全断网**，连代理容器都不起。': '  (empty) — the sandbox is **fully offline**; not even the proxy container starts.',
  '，只读': ', read-only',
  '  合计 {n} 个域，名单外的一律被拦': '  {n} domains in total; everything else is blocked',
  '\n审计轨里被拦过的域：': '\nDomains blocked according to the audit trail:',
  '　←　属于「{name}」（{id}）': '  ←  belongs to "{name}" ({id})',
  '，已放行': ', allowed',
  '，未放行': ', not allowed',
  '　←　**不在联网目录里**': '  ←  **not in the network catalog**',
  '\n有 {n} 条联网请求在等你：{ids}（--allow 对应的源会同时答掉它）': '\n{n} network access requests are waiting for you: {ids} (--allow on the matching source answers them too)',
  '、': ', ',
  '\n联网目录：{ids}（node src/cli.mjs sources 看详情）': '\nNetwork catalog: {ids} (node src/cli.mjs sources for details)',
  '  加：node src/cli.mjs egress {taskId} --allow pypi': '  Add:    node src/cli.mjs egress {taskId} --allow pypi',
  '  减：node src/cli.mjs egress {taskId} --deny pypi': '  Remove: node src/cli.mjs egress {taskId} --deny pypi',
  '·只读': '·read-only',
  '·内置': '·built-in',
  '工具配置：{env}': 'Tool config: {env}',
  '\n加：node src/cli.mjs sources add --name "清华 PyPI 镜像" --host pypi.tuna.tsinghua.edu.cn [--kind package|info] [--read-only|--writable] [--env PIP_INDEX_URL=https://…]': '\nAdd:    node src/cli.mjs sources add --name "Tsinghua PyPI mirror" --host pypi.tuna.tsinghua.edu.cn [--kind package|info] [--read-only|--writable] [--env PIP_INDEX_URL=https://…]',
  '删：node src/cli.mjs sources remove <id>': 'Remove: node src/cli.mjs sources remove <id>',
  '  {id}　{name}（{kind}{ro}）：{hosts}': '  {id}  {name} ({kind}{ro}): {hosts}',
  '已加入联网目录：{id}　{name}（{kind}{ro}）：{hosts}': 'Added to the network catalog: {id}  {name} ({kind}{ro}): {hosts}',
  '  项目要用它：node src/cli.mjs project egress <项目 id> --add {id}': '  To use it in a project: node src/cli.mjs project egress <project id> --add {id}',
  '已从联网目录删掉：{name}': 'Removed from the network catalog: {name}',
  '\n  ⚠ 这些项目原来勾着它，现在访问不了了：{list}': '\n  ⚠ These projects had it checked and can no longer reach it: {list}',
  // revision
  '任务 {taskId} 没有任何修正提案。': 'Task {taskId} has no revision proposals.',
  '门：{gate}': 'gate: {gate}',
  '门未触发（自动生效）': 'gate not triggered (applied automatically)',
  '  修正（{kind}）：{body}': '  Correction ({kind}): {body}',
  '  影响：{marks}': '  Impact: {marks}',
  '｜新增 {n}': ' | added {n}',
  '｜作废金额 {voided} / 已完成 {done}': ' | voided spend {voided} / completed {done}',
  '任务 {taskId} 没有待处理的修正提案。': 'Task {taskId} has no pending revision proposal.',
  '（自动生效过的看 node src/cli.mjs revision {taskId} --history）': '(for ones applied automatically: node src/cli.mjs revision {taskId} --history)',
  '修正提案 {id}　状态 {status}': 'Revision proposal {id}  status {status}',
  '\n人发来的修正（{kind}{urgent}）：': '\nCorrection sent by a person ({kind}{urgent}):',
  '/紧急': '/urgent',
  '\n逐节点影响标记（这才是真护栏 —— 每一次作废都有出处、有理由、事后查得到）：': '\nPer-step impact marks (this is the real guardrail — every void has a source and a reason, and can be traced later):',
  '\n⚠️ 要你批准：{gate}': '\n⚠️ Needs your approval: {gate}',
  '  批准：node src/cli.mjs revision {taskId} --approve': '  Approve: node src/cli.mjs revision {taskId} --approve',
  '  驳回：node src/cli.mjs revision {taskId} --reject': '  Reject:  node src/cli.mjs revision {taskId} --reject',
  '找不到 CLI 令牌 {file}。先跑 node src/cli.mjs init': 'CLI token {file} not found. Run node src/cli.mjs init first',
  '已应用 {id}：作废 {voided}｜改规格 {respecced}｜新增 {added}': 'Applied {id}: voided {voided} | respecced {respecced} | added {added}',
  '  宪法块已修订 → {id}（agent 无权自改，这一步只能由人触发）': '  Contract revised → {id} (the agent cannot change it itself; only a person can trigger this)',
  '  ⚠️ 作废的节点**产物没有被删**：git 历史里仍在，决策日志记了"因修正作废"': '  ⚠️ Output of voided steps **was not deleted**: it is still in git history, and the decision log records "voided by correction"',
  '  保留意见已记进项目的约定清单（标〔保留意见〕）：它不改变这份变更里的任何一条，只是让下一个碰这一处的人看得到。': '  The reservation was added to the project\'s agreed decisions (marked [Reservation]): it changes nothing in this change; it just lets the next person touching this spot see it.',
  '人驳回': 'Rejected by a person',
  '已驳回 {id}。计划原样不动，那条修正记为已处理 —— 否则下一轮又会停在同一处。': 'Rejected {id}. The plan stays as it was, and the correction is marked handled — otherwise the next cycle would stop at the same place.',
  '批准修正提案 {id}（经 cli revision --approve）': 'Approved revision proposal {id} (via cli revision --approve)',
  '驳回修正提案 {id}（经 cli revision --reject）': 'Rejected revision proposal {id} (via cli revision --reject)',
  '  同时答复了 {qid}': '  Also answered {qid}',
  '，任务解冻': '; task unfrozen',
  '⚠️ 状态已改，但答复 {qid} 失败：{err}': '⚠️ The state was changed, but answering {qid} failed: {err}',
  '\n下一步：node src/cli.mjs run {taskId}': '\nNext: node src/cli.mjs run {taskId}',
  // sandbox
  '运行时 {cli} {version} · 镜像 {image}': 'Runtime {cli} {version} · image {image}',
  '没有遗留沙箱，也没有派生镜像与孤儿网络。': 'No leftover sandboxes, derived images, or orphan networks.',
  '  {name}  [{state}] {status}  任务状态 {task}': '  {name}  [{state}] {status}  task status {task}',
  '（库里没有这个任务）': '(task not in the database)',
  '孤儿网络 {n} 张（没有容器挂着）：{list}': '{n} orphan networks (no containers attached): {list}',
  '派生镜像 {n} 个：{list}': '{n} derived images: {list}',
  '\n删掉它们：node src/cli.mjs sandbox --reap': '\nRemove them: node src/cli.mjs sandbox --reap',
  '  已删除 {name}': '  Removed {name}',
  '  已删网络 {n}': '  Removed network {n}',
  '  网络 {n} 没删掉：{err}': '  Could not remove network {n}: {err}',
  '  已删镜像 {tag}': '  Removed image {tag}',
  '  镜像 {tag} 没删掉（可能还有容器在用）：{err}': '  Could not remove image {tag} (a container may still be using it): {err}',
  // say
  '要给正文：node src/cli.mjs say <taskId> "<正文>" [--kind <类别>]': 'Give a message: node src/cli.mjs say <taskId> "<text>" [--kind <kind>]',
  '分类器认为这句话是在回答开着的问题 {qid}。': 'The classifier thinks this is an answer to open item {qid}.',
  '它没有入 messages，也不会自动 recordAnswer —— 答复要挂 answers 边、解冻分支、签你的名字，必须由你显式做：': 'It was not stored as a message and will not be recorded as an answer automatically — an answer links to the item, unfreezes the branch, and carries your name, so you must do it explicitly:',
  '消息已入库：{id}': 'Message stored: {id}',
  '  类别 {kind}（kind_source={source}）｜紧急度 {urgency}': '  kind {kind} (kind_source={source}) | urgency {urgency}',
  '｜附在事项 {qid} 上': ' | attached to item {qid}',
  ' —— 旁观者留言：会被看到，不进决策': ' — observer comment: it will be seen, but does not feed into decisions',
  ' —— 指令效力只授予认证通道（库层 CHECK 强制）': ' — only authenticated channels carry instruction authority (enforced by a database CHECK)',
  '\n下一步：重跑 run。它会进执行器上下文的"收件箱"段（缓存断点**之后**，所以不会让已有缓存作废），节点做完即标记消费。': '\nNext: run again. It goes into the "Inbox" section of the executor context (**after** the cache breakpoint, so existing caches stay valid) and is marked consumed when the step finishes.',
  '\n⚠️ 修正会改变"要做什么"，而那属宪法层，执行器无权自行处置。': '\n⚠️ A correction changes "what to do", which belongs to the contract level; the executor may not handle it on its own.',
  '\n⚠️ 新指令会改变"要做什么"，而那属宪法层，执行器无权自行处置。': '\n⚠️ A new instruction changes "what to do", which belongs to the contract level; the executor may not handle it on its own.',
  '   重跑 run 会先跑重规划流水线：逐节点影响评估 → 已完成工作分捡 →': '   The next run first goes through the replanning pipeline: per-step impact assessment → sorting out completed work →',
  '   计划 diff。若触及宪法层、或作废的已完成工作按**花费金额**超过阈值，': '   plan diff. If it touches the contract, or the completed work it voids exceeds the threshold by **spend**,',
  '   会转成一条要你批准的 Ⅲ 级问题，而不是默默换掉计划。': '   it becomes a level Ⅲ item for you to approve, instead of silently swapping the plan.',
  // questions
  '没有问题': 'No items',
  '没有开放的问题': 'No open items',
  '{n} 分钟': '{n} min',
  '{n} 小时': '{n} h',
  '{level}级': 'level {level}',
  ' 节点 {id}': ' step {id}',
  '  已等 {age}': '  waiting {age}',
  '，{age}后超时': ', times out in {age}',
  '，已超时': ', timed out',
  '答复': 'Answer',
  '附议': 'Second',
  '弃权': 'not mine',
  '系统': 'System',
  '：': ': ',
  '   ｜同意已有那条：--agree [答复 id]': '   | agree with the existing one: --agree [answer id]',
  '   ｜不归你：--abstain': '   | not yours: --abstain',
  '   （默认：{a}）': '   (default: {a})',
  // answer
  '要给答复正文：node src/cli.mjs answer <questionId> "你的答复"\n  同意别人已经写的那条：--agree [答复 id]；这条不归你：--abstain "可选的说明"': 'Give an answer: node src/cli.mjs answer <questionId> "your answer"\n  To agree with one someone already wrote: --agree [answer id]; if it is not yours: --abstain "optional note"',
  '没有这个问题：{id}': 'No such item: {id}',
  '，': ', ',
  '已记：{what}（{id}）': 'Recorded: {what} ({id})',
  '撤回自己的立场': 'Withdrew own position',
  '弃权（这条不归你）': 'not mine (this one is not yours)',
  '  收件人已没有人，事项改派给 {names}': '  No recipients left; the item was reassigned to {names}',
  '  ⚠ 收件人全部弃权且没有下一顺位，事项挂起等人处理（会进摘要）': '  ⚠ Every recipient said "not mine" and there is nobody next in line; the item waits for someone to handle it (it will show up in digests)',
  '  法定人数已按剩余人数重算': '  Quorum recalculated for the remaining people',
  '{what}已写入：{mid}（answers 表 {aid}）': '{what} recorded: {mid} (answers table {aid})',
  '  ⚠ 与他人的答复不一致：两边都没生效，已生成冲突事项 {id}（先双方在那里达成一致，一个工作日内没达成就转负责人）': '  ⚠ Your answer disagrees with someone else\'s: neither took effect, and disagreement item {id} was raised (settle it there together; if not settled within one working day it goes to the owner)',
  '  ⚠ 双方再次不一致：冲突事项转给 {to} 裁定': '  ⚠ Still in disagreement: the disagreement item goes to {to} to decide',
  '（已生效的结论：{body}）': ' (the conclusion in effect: {body})',
  '  还没生效：法定人数未够（{pending}）': '  Not in effect yet: quorum not reached ({pending})',
  '  answers 边 {mid} → {qid}｜trust_label=user-authenticated｜生效方式 {how}': '  answers edge {mid} → {qid} | trust_label=user-authenticated | resolved by {how}',
  '（覆盖了 {n} 条前任答复，已通知）': ' (superseded {n} earlier answers; notified)',
  '；原事项 {id} 按此了结': '; original item {id} settled accordingly',
  '  问题置 answered': '  Item marked answered',
  '，节点 {id} 由 blocked 退回 pending': '; step {id} moved from blocked back to pending',
  '  该任务还开着 {n} 个问题': '  The task still has {n} open items',
  '，任务由 waiting 转 running': '; task moved from waiting to running',
  '（任务已完成，这是完成后的事项）': ' (the task is done; this is a post-completion item)',
  '\n下一步：守护进程在跑的话会自动拉起；没开守护进程就手动：node src/cli.mjs {manual}  ← 新进程，读库重建上下文': '\nNext: if auto-run is on it picks this up by itself; otherwise run it yourself: node src/cli.mjs {manual}  ← a new process that rebuilds its context from the database',
  // 决定比对
  '\n⚠ 这次说的和 {n} 条仍然有效的旧决定对不上': '\n⚠ What you said conflicts with {n} earlier decisions that are still in effect',
  '「{s}」': '“{s}”',
  '\n  已挂事项 {qid}': '\n  Raised item {qid}',
  '给你自己确认': ' for you to confirm',
  '给项目负责人': ' for the project owner',
  '给双方商量': ' for both sides to discuss',
  '：node src/cli.mjs show {taskId}': ': node src/cli.mjs show {taskId}',
  // web
  '团队模式要给对外地址：web --team --public-url https://<看板的内网域名>  （见 docs/deploy-team.md）': 'Team mode needs a public address: web --team --public-url https://<board intranet domain>  (see docs/deploy-team.md)',
  '只有团队模式才能监听本机以外的地址（本机模式不带令牌 = 负责人）：加 --team --public-url …': 'Only team mode may listen on addresses other than this machine (local mode without a token = the owner): add --team --public-url …',
  '看板（团队模式）：监听 http://{host}:{port}/，对外地址 {url}；每个人用自己的令牌登录（Ctrl-C 停）': 'Board (team mode): listening on http://{host}:{port}/, public address {url}; everyone signs in with their own token (Ctrl-C to stop)',
  '看板：http://{host}:{port}/   （只绑本机；Ctrl-C 停）': 'Board: http://{host}:{port}/   (this machine only; Ctrl-C to stop)',
  '  ⚠ 绑定 {tier}（{key}）：{why} —— 看板"设置"里改': '  ⚠ Binding {tier} ({key}): {why} — change it under "Settings" on the board',
  // project
  '无法新建项目：{why}': 'Cannot create a project: {why}',
  'project new --goal <文本或文件> --done <文本或文件> (--source <仓库路径或 URL> | --empty) [--plan <规划文本或文件>] [--base <ref>] [--title <标题>]': 'project new --goal <text or file> --done <text or file> (--source <repo path or URL> | --empty) [--plan <plan text or file>] [--base <ref>] [--title <title>]',
  '项目 {id}\n  仓库 {repo}\n  分支 {branch} @ {base}': 'Project {id}\n  repo {repo}\n  branch {branch} @ {base}',
  '  方案待起草（载体任务 {carrier}）。守护进程会拉规划器；没开守护进程：node src/cli.mjs project plan {id}': '  Plan to be drafted (carrier task {carrier}). Auto-run will start the planner; without auto-run: node src/cli.mjs project plan {id}',
  '  第一个任务 {taskId}（从项目目标起草，会先问你几个问题）。守护进程会自动追问；没开守护进程：node src/cli.mjs draft {taskId}': '  First task {taskId} (drafted from the project goal; it will ask you a few questions first). Auto-run asks them automatically; without auto-run: node src/cli.mjs draft {taskId}',
  '要给项目 id': 'Give a project id',
  '没有这个项目：{id}': 'No such project: {id}',
  '这个项目不是从规划开始的，没有可规划的东西': 'This project did not start from a plan; there is nothing to plan',
  '项目规划中（档位 {tier}）… {id}「{title}」草案 v{version}': 'Planning project (tier {tier})… {id} "{title}" draft v{version}',
  '记账 {rows} 次调用，{usd}（记在载体任务 {carrier}）': 'Billed {rows} calls, {usd} (charged to carrier task {carrier})',
  '要给 --file <项目.json>（整批契约）或 --brief <规划文本或文件>（让规划器切）': 'Give --file <project.json> (a full set of contracts) or --brief <plan text or file> (let the planner split it)',
  '项目 {id}  {title}\n  仓库 {repo}\n  分支 {branch} @ {base}': 'Project {id}  {title}\n  repo {repo}\n  branch {branch} @ {base}',
  '\n第一个任务的工作区已建；守护进程会拉 plan → run。任务 done 后你签收（signoff --accept），守护进程自动合进项目分支并开下一个。': '\nThe first task\'s workspace is ready; auto-run will do plan → run. When a task is done you sign it off (signoff --accept), and auto-run merges it into the project branch and starts the next one.',
  '看进度：node src/cli.mjs project show {id}': 'Progress: node src/cli.mjs project show {id}',
  '项目 {id}  {title}  [{status}]\n  仓库 {repo}\n  分支 {branch}（起点 {base}）': 'Project {id}  {title}  [{status}]\n  repo {repo}\n  branch {branch} (from {base})',
  '  草案 v{version}': '  Draft v{version}',
  '，批准问题 {qid}（answer <qid> "A" / 反馈 / "C"）': ', approval item {qid} (answer <qid> "A" / feedback / "C")',
  '，等规划器': ', waiting for the planner',
  '✅ 已合并': '✅ merged',
  '⏳ 待合并': '⏳ to merge',
  '✋ 待签收': '✋ to sign off',
  '  ← 依赖 {deps}': '  ← depends on {deps}',
  'project append <项目 id> --brief <文本或文件>': 'project append <project id> --brief <text or file>',
  '要给 --brief <文本或文件>：接下来要加什么': 'Give --brief <text or file>: what to add next',
  '已排队（第 {n} 位）：现在有一轮复盘在进行，它结束后这条单独起草、单独批准。': 'Queued (position {n}): a project review is in progress; once it ends, this one is drafted and approved on its own.',
  '已排队（第 {n} 位）：现在有一轮追加在进行，它结束后这条单独起草、单独批准。': 'Queued (position {n}): another addition is in progress; once it ends, this one is drafted and approved on its own.',
  '已记下要追加的内容（载体任务 {carrier}）。守护进程会拉规划器出追加草案，批准前不会新建任何任务；没开守护进程：node src/cli.mjs project plan {id}': 'Noted what to add (carrier task {carrier}). Auto-run will have the planner draft the addition; no task is created before approval. Without auto-run: node src/cli.mjs project plan {id}',
  'project signoff <项目 id> [--accept-all]': 'project signoff <project id> [--accept-all]',
  '项目「{title}」没有被后置的签收。': 'Project "{title}" has no deferred sign-offs.',
  '项目「{title}」有 {n} 个任务的签收被后置了（自动挡下 AI 自己加的，验收过了就合并）：': 'Project "{title}" has {n} tasks with deferred sign-off (added by the AI in auto gear; merged once the acceptance check passed):',
  '  已合并': '  merged',
  '  逐个看：node src/cli.mjs show <taskId>｜一次签掉：project signoff {id} --accept-all': '  One by one: node src/cli.mjs show <taskId> | all at once: project signoff {id} --accept-all',
  '只有该项目的负责人能批量签收': 'Only the project owner can sign off in bulk',
  '已一次签收 {n} 个任务。': 'Signed off {n} tasks at once.',
  'project {sub} <项目 id>': 'project {sub} <project id>',
  '只有该项目的负责人能改项目设置': 'Only the project owner can change project settings',
  '项目「{title}」的预算闸：{human}': 'Budget gate for project "{title}": {human}',
  '｜剩余 {left}': ' | {left} left',
  '　⚠ 已撞闸': '  ⚠ gate hit',
  '  改：--usd <美元> ｜ 撤掉：--clear': '  Change: --usd <dollars> | remove: --clear',
  '预算闸已撤掉（自动挡会随之掉回提议挡）': 'Budget gate removed (auto gear drops back to propose gear with it)',
  '预算闸已设为 {usd}；{human}': 'Budget gate set to {usd}; {human}',
  '项目「{title}」的验收命令：{cmd}': 'Acceptance command for project "{title}": {cmd}',
  '（没填 —— "项目达成"只能由人宣布）': '(none — "project done" can only be declared by a person)',
  '  改：--cmd "<一条命令>" ｜ 清空：--clear': '  Change: --cmd "<a command>" | clear: --clear',
  '项目级验收命令已设为：{cmd}': 'Project acceptance command set to: {cmd}',
  '项目级验收命令已清空（自动挡会随之掉回提议挡）': 'Project acceptance command cleared (auto gear drops back to propose gear with it)',
  '项目「{title}」的挡位：{label}\n  {blurb}': 'Gear for project "{title}": {label}\n  {blurb}',
  '  四条前提：': '  Four prerequisites:',
  '{label}（{note}）—— {why}': '{label} ({note}) — {why}',
  '  改：project gear {id} {gears}': '  Change: project gear {id} {gears}',
  '挡位已设为：{label}': 'Gear set to: {label}',
  '项目「{title}」的环境准备命令（负责人填的；新工作区第一次开跑前、项目级验收之前自动跑）：': 'Setup commands for project "{title}" (set by the owner; run automatically before a new workspace\'s first run and before the project acceptance check):',
  '项目「{title}」的环境准备：自动（按仓库里的依赖清单）。': 'Setup for project "{title}": automatic (based on the dependency manifests in the repo). ',
  '按现在的清单会跑：': 'With the current manifests it would run:',
  '仓库里还没有依赖清单，暂时没有要装的。': 'The repo has no dependency manifest yet, so there is nothing to install for now.',
  '  改：project setup {id} --cmd "python -m venv .venv" --cmd ".venv/bin/pip install -r requirements.txt"　清空：--clear': '  Change: project setup {id} --cmd "python -m venv .venv" --cmd ".venv/bin/pip install -r requirements.txt"  clear: --clear',
  '项目「{title}」的联网（项目下所有任务共用）：': 'Network access for project "{title}" (shared by all its tasks): ',
  '（空）—— 完全断网': '(empty) — fully offline',
  '  可选：{ids}　改：project egress {id} --add <源> --remove <源>': '  Available: {ids}  change: project egress {id} --add <source> --remove <source>',
  '项目「{title}」的沙箱：{flavor}': 'Sandbox for project "{title}": {flavor}',
  '  改：project sandbox {id} {flavors}（下一次开工 / 跑验收时生效，已开着的容器不变）': '  Change: project sandbox {id} {flavors} (takes effect at the next start / acceptance check; running containers are unchanged)',
  '沙箱已设为：{flavor}（下一次开工 / 跑验收时生效）': 'Sandbox set to: {flavor} (takes effect at the next start / acceptance check)',
  '项目「{title}」同时最多开 {n} 个任务': 'Project "{title}" runs at most {n} tasks at a time',
  '（串行）': ' (one at a time)',
  '：只有开着的任务全都在等人时，才会让独立的下一个先跑起来': ': the next independent task only starts when every open task is waiting on people',
  '  改：project concurrency {id} --max <1-4>': '  Change: project concurrency {id} --max <1-4>',
  '同时最多开 {n} 个任务': 'Up to {n} tasks open at a time',
  '项目「{title}」的默认上限（本项目新任务用；任务自己设过的压过它）：': 'Default limits for project "{title}" (used by new tasks in this project; a task\'s own setting overrides them):',
  '（部署默认 {v}）': ' (deployment default {v})',
  '  改：project limits {id} --key <项> --value <数> ｜ 清掉这一层：--key <项> --clear': '  Change: project limits {id} --key <item> --value <number> | clear this layer: --key <item> --clear',
  '{label}：{value}（{layer}）': '{label}: {value} ({layer})',
  '项目「{title}」 可见性：{v}\n  负责人 {owner}': 'Project "{title}"  visibility: {v}\n  owner {owner}',
  '  [可添加任务]': '  [can add tasks]',
  '  [已停用]': '  [disabled]',
  'project member <项目 id> <用户 id> [--add-tasks] [--note <职能说明>] | --remove': 'project member <project id> <user id> [--add-tasks] [--note <role description>] | --remove',
  '已移出项目成员：{id}': 'Removed project member: {id}',
  '已加入项目成员：{id}': 'Added project member: {id}',
  '已更新项目成员：{id}': 'Updated project member: {id}',
  '（可添加任务）': ' (can add tasks)',
  'project visibility <项目 id> {opts}': 'project visibility <project id> {opts}',
  '可见性已改为：{v}': 'Visibility changed to: {v}',
  '可见性没有变化': 'Visibility unchanged',
  'project goal <项目 id> [--goal <文本或文件>] [--done <文本或文件>]': 'project goal <project id> [--goal <text or file>] [--done <text or file>]',
  '项目目标 / 完成定义已更新（任务的契约不受影响）': 'Project goal / definition of done updated (task contracts are not affected)',
  '没有变化': 'No change',
  'project review <项目 id>': 'project review <project id>',
  '已开始重新复盘（载体任务 {carrier}）：已经达成就请你确认，还差东西就提任务，结果进收件箱': 'Started a new project review (carrier task {carrier}): if the goal is met it asks you to confirm; if something is missing it proposes tasks. The result goes to your Inbox',
  '项目没有未合并的任务': 'The project has no unmerged tasks',
  '已恢复任务 {id}（→ {to}）': 'Reopened task {id} (→ {to})',
  '，项目回到进行中': '; the project is back in progress',
  '。想改契约：node src/cli.mjs say {id} "<要改什么>" --kind correction': '. To change the contract: node src/cli.mjs say {id} "<what to change>" --kind correction',
  '已重做第 {order} 个任务：新任务 {newId}（同一份契约），旧任务 {oldId} 退出链，其工作区与分支保留。守护进程会从项目分支建新工作区；没开守护进程：node src/cli.mjs project advance {pid}': 'Redoing task #{order}: new task {newId} (same contract); old task {oldId} leaves the chain, and its workspace and branch are kept. Auto-run creates a new workspace from the project branch; without auto-run: node src/cli.mjs project advance {pid}',
  '项目已中止：中止任务 {n} 个，撤回待决事项 {q} 条。': 'Project aborted: {n} tasks aborted, {q} open items withdrawn. ',
  '已合并的 {n} 个任务仍可交付：node src/cli.mjs project deliver {pid} --remote <url>': 'The {n} merged tasks can still be delivered: node src/cli.mjs project deliver {pid} --remote <url>',
  '没有已合并的任务': 'No merged tasks',
  '项目标题已改为 {title}': 'Project title changed to {title}',
  '标题没变': 'Title unchanged',
  '已归档（连同其任务从列表隐藏；状态不变）': 'Archived (hidden from the list together with its tasks; status unchanged)',
  '已取消归档': 'Unarchived',
  '推进：{reason}': 'Advanced: {reason}',
  ' → 下一个 {id} 工作区已建': ' → workspace for the next task {id} created',
  '；项目 done': '; project done',
  '没动：{reason}': 'No change: {reason}',
  // deliver
  '要推的范围：{range}  {n} 个提交，头 {head}': 'Range to push: {range}  {n} commits, head {head}',
  '（没有差异）': '(no differences)',
  '⚠ 读不到项目仓库（路径不在、不是 git 仓库、或者权限不够），说不出这次要推什么': '⚠ Cannot read the project repo (path missing, not a git repo, or no permission), so cannot tell what this push contains',
  '⚠ 没有填项目级验收命令 —— "达成"完全是人宣布的，一条机械核实都没有': '⚠ No project-level acceptance command — “done” was purely declared by people, with no mechanical check at all',
  '⚠ 验收命令 {cmd} 一次都没跑过': '⚠ Acceptance command {cmd} has never run',
  '验收 {cmd}：{result}': 'Acceptance {cmd}: {result}',
  '通过': 'passed',
  '没过（退出码 {code}）': 'failed (exit code {code})',
  '没跑起来': 'did not start',
  '  跑的就是要推的这一份（{head}）': '  It ran on exactly what is being pushed ({head})',
  '⚠ 那次跑的是 {ran}，和现在要推的 {head} 不是同一份代码 —— 这个"通过"对这次没有效力': '⚠ That run was on {ran}, which is not the same code as {head} being pushed now — that "passed" does not count for this push',
  '未知': 'unknown',
  '  输出尾部：': '  Output tail:',
  '已 push：{remote}  {branch} @ {head}': 'Pushed: {remote}  {branch} @ {head}',
  'PR：{url}（base {base}）': 'PR: {url} (base {base})',
  '未开 PR：{why}': 'No PR opened: {why}',
  '未开 PR（没给 --pr）': 'No PR opened (no --pr given)',
  '不认识的子命令 {sub}：project new | show | advance | deliver': 'Unknown subcommand {sub}: project new | show | advance | deliver',
  // daemon
  '✉ 事项 {qid} 已通知 {n} 人（{ok}/{all} 条送达）': '✉ Item {qid}: notified {n} people ({ok}/{all} delivered)',
  '✗ 通知失败：{err}': '✗ Notification failed: {err}',
  '模型目录检查（{why}）：': 'Model catalog check ({why}): ',
  '首次': 'first run',
  '绑定里有没查过的模型': 'a bound model has not been checked yet',
  '到间隔': 'interval reached',
  '{n} 项要看一眼': '{n} item(s) worth a look',
  '，已通知管理员': '; admins notified',
  '无漂移': 'no drift',
  '；{n} 处拉取失败': '; {n} fetches failed',
  '✉ 定时待办摘要 → {user}（{items} 项，{ok}/{all} 条送达）': '✉ Scheduled to-do digest → {user} ({items} items, {ok}/{all} delivered)',
  '⇄ 换班（{key}）：{from} → {to}，': '⇄ On-call handover ({key}): {from} → {to}, ',
  '默认表': 'default table',
  '已推 {n} 项待办': 'sent {n} to-dos',
  '没有待办，未发': 'nothing pending, not sent',
  '⚠ 停等 {taskId}：静止 {min} 分钟，而系统说不出它在等谁（{why}）。已提事项 {qid} 给负责人': '⚠ Stalled {taskId}: idle for {min} min and the system cannot say who it is waiting for ({why}). Raised item {qid} for the owner',
  '⚠ 空转 {taskId}：{why}，期间没有新信息。已提事项 {qid} 给负责人': '⚠ Spinning {taskId}: {why}, with no new information in the meantime. Raised item {qid} for the owner',
  '▶ 拉起 {taskId}（{reason}）pid {pid} · 日志 {log}': '▶ Started {taskId} ({reason}) pid {pid} · log {log}',
  '✗ 拉不起 {taskId}（{reason}）：{err}': '✗ Could not start {taskId} ({reason}): {err}',
  '⛓ 项目 {pid}：{reason}': '⛓ Project {pid}: {reason}',
  '[SuperIntern] 项目完成 {pid}': '[SuperIntern] Project done {pid}',
  '全部任务已合进项目分支。交付：node src/cli.mjs project deliver {pid} --remote <url> --pr': 'All tasks are merged into the project branch. Deliver: node src/cli.mjs project deliver {pid} --remote <url> --pr',
  '✗ 项目 {pid} 推进失败（第 {n} 次，按退避等）：{err}': '✗ Advancing project {pid} failed (attempt {n}; backing off): {err}',
  '守护进程 pid {pid}：每 {sec}s 扫一次；状态 running 且没在跑、且上次退出后有人动过的任务会被拉起': 'Auto-run pid {pid}: scans every {sec}s; tasks that are running, not currently executing, and touched by someone since their last exit get started',
  '；通知 {kinds}': '; notifications {kinds}',
  '  {taskId}：{due}（{reason}）': '  {taskId}: {due} ({reason})',
  '该拉起': 'start',
  '不拉': 'skip',
  '  首轮：拉起 {n}': '  First pass: started {n}',
  '，退避中 {n}': ', backing off {n}',
  '⏱ {taskId} 超时走默认（{level} 级 {qid}）：{action}': '⏱ {taskId} timed out, default taken (level {level} {qid}): {action}',
  '⏱ {taskId} 超时升级（Ⅱ 级 {qid}）：再无人答将退保守默认。node src/cli.mjs answer {qid} "..."': '⏱ {taskId} timed out, escalated (level Ⅱ {qid}): if nobody answers again it falls back to the conservative default. node src/cli.mjs answer {qid} "..."',
  '⏱ {taskId} 超时后仍挂起（{qid}）：没有默认可退，继续等人': '⏱ {taskId} still waiting after timeout ({qid}): no default to fall back on; still waiting on people',
  '⏱ {taskId} 路由行时限到（{qid}）：转给 {to}': '⏱ {taskId} routing row time limit reached ({qid}): passed to {to}',
  '（空）': '(empty)',
  // draft / tick
  '这个任务不是从想法开始的，没有可追问的东西。直接 node src/cli.mjs plan {taskId}': 'This task did not start from an idea; there is nothing to ask about. Just run node src/cli.mjs plan {taskId}',
  '⛔ 追问前体检不过：{human}\n已生成 Ⅲ 级问题 {qid}（hard_rule），任务转入 waiting。': '⛔ Pre-questioning check failed: {human}\nRaised level Ⅲ item {qid} (hard_rule); the task is now waiting.',
  '追问中（档位 {tier}）… 任务 {taskId}「{title}」': 'Asking follow-up questions (tier {tier})… task {taskId} "{title}"',
  '\n追问器提了 {n} 个 Ⅱ 级问题（带默认，超时链生效），任务转入 waiting：': '\nThe question asker raised {n} level Ⅱ items (with defaults; the timeout chain applies); the task is now waiting:',
  '默认：{a}': 'Default: {a}',
  '\n在看板答，或：node src/cli.mjs answer <qid> "..."。答完守护进程会自动接着追问。': '\nAnswer on the board, or: node src/cli.mjs answer <qid> "...". After you answer, auto-run continues asking by itself.',
  '\n没出新版：连着两次以「A」开头却读成"要改"，先挂了一条确认事项 {qid}：\n': '\nNo new version: twice in a row an answer starting with "A" was read as "change it", so a confirmation item {qid} was raised first:\n',
  '\n宪法块草案 v{version} 已出（Ⅲ 级批准问题 {qid}）：\n': '\nContract draft v{version} is ready (level Ⅲ approval item {qid}):\n',
  '\n回复：node src/cli.mjs answer {qid} "A"   （或直接写要改什么 / "C" 放弃）': '\nReply: node src/cli.mjs answer {qid} "A"   (or just write what to change / "C" to drop it)',
  '\n✅ 草案 v{version} 已批准，宪法块生效。工作区 {dir}（{from}）分支 {branch}': '\n✅ Draft v{version} approved; the contract is in effect. Workspace {dir} ({from}) branch {branch}',
  '克隆自 {source}': 'cloned from {source}',
  '新建空仓库': 'New empty repository',
  '守护进程会自动规划并开跑；没开守护进程就手动：node src/cli.mjs plan {taskId}': 'Auto-run will plan and start it; without auto-run, run it yourself: node src/cli.mjs plan {taskId}',
  '\n已按你的答复放弃：任务 aborted。': '\nDropped as you answered: task aborted.',
  '\n没事可做：{why}': '\nNothing to do: {why}',
  '通知了 {n} 条事项的收件人': 'Notified the recipients of {n} items',
  '处置 {n} 个到期问题：默认 {d}｜升级 {e}｜挂起 {s}': 'Handled {n} due items: default {d} | escalated {e} | still waiting {s}',
  '没有到期的问题': 'No items are due',
  '  任务 {t} 有分支解冻了：node src/cli.mjs run {t}': '  Task {t} has an unfrozen branch: node src/cli.mjs run {t}',
  // decisions
  '人工作废': 'Voided by a person',
  '已作废 {id}': 'Voided {id}',
  '有效的决定 {n} 条': '{n} decisions in effect',
  '（项目 {id}）': ' (project {id})',
  '（独立任务 {id}）': ' (standalone task {id})',
  '  （还没有）': '  (none yet)',
  '\n加 --all 连已作废的一起看；--void <决定 id> "理由" 手工作废一条。': '\nAdd --all to include voided ones; --void <decision id> "reason" voids one by hand.',
  '\n没有已作废的决定': '\nNo voided decisions',
  '\n已作废 {n} 条': '\n{n} voided',
  '作废原因：{why}': 'Voided because: {why}',
  '（已被新的决定取代）': ' (superseded by a newer decision)',
  // stalls
  '没结束的任务 {n} 个：在跑 {self}｜等时钟 {clock}｜等人 {human}｜等上游 {upstream}｜': 'Unfinished tasks: {n} — running {self} | waiting on the clock {clock} | waiting on people {human} | waiting upstream {upstream} | ',
  '⚠ 说不出在等谁 {n}': '⚠ cannot say who it is waiting for {n}',
  '说不出在等谁 0': 'cannot say who it is waiting for 0',
  '　〔守护进程原话：{words}〕': '  [auto-run said: {words}]',
  '\n加 --raise 把这 {n} 条升成给负责人的事项（守护进程在跑时每轮自动做）。': '\nAdd --raise to turn these {n} into items for the owner (auto-run does this every cycle when it is on).',
  '\n⚠ 空转 {n} 处（系统在没有新信息时重复自己）': '\n⚠ {n} spinning (the system repeats itself without new information)',
  // digest
  '没有这个用户：{id}': 'No such user: {id}',
  '只有管理员能看别人的待办': 'Only admins can see other people\'s to-dos',
  '\n已发到 {n} 条通道（{ok} 条送达）': '\nSent to {n} channels ({ok} delivered)',
  '\n没有可用的通知通道（成员用 user channel 挂一条；管理员也可用 .env 的部署级通道），只打印了': '\nNo notification channel available (members add one with user channel; admins can also use the deployment-level channels in .env), so it was only printed',
  '\n发到通知通道：node src/cli.mjs digest --send': '\nSend to your notification channels: node src/cli.mjs digest --send',
  // catalog
  '还没查过：node src/cli.mjs catalog check': 'Not checked yet: node src/cli.mjs catalog check',
  '上次检查 {at}：{n} 项要看一眼': 'Last check {at}: {n} things to look at',
  '（含实调）': ' (with live probes)',
  '，{n} 处拉取失败': ', {n} fetches failed',
  '模型目录（{n} 条；★ = 绑着；○ = 停用）：': 'Model catalog ({n} entries; ★ = bound; ○ = disabled):',
  '缺单价': 'no price',
  '窗口 {n}': 'window {n}',
  '窗口未核实': 'window unverified',
  '推理强度 {efforts}': 'reasoning effort {efforts}',
  '不支持': 'unsupported',
  '  （只能删：node src/cli.mjs catalog remove {key}）': '  (can only be removed: node src/cli.mjs catalog remove {key})',
  '  （用户新增）': '  (added by a user)',
  '  （改过默认值）': '  (default changed)',
  '  （{env} 未填）': '  ({env} not set)',
  '要给模型键（服务商/模型）': 'Give a model key (provider/model)',
  '{key} 已回到代码默认值': '{key} reverted to the code default',
  '{key} 已从目录删除': '{key} removed from the catalog',
  '{key} 已启用': '{key} enabled',
  '{key} 已停用': '{key} disabled',
  '{key} 已在目录里；改用 catalog set': '{key} is already in the catalog; use catalog set instead',
  '已保存 {key}（{vendor} · {model}{price}）': 'Saved {key} ({vendor} · {model}{price})',
  '，{input}/{output} 每百万 token': ', {input}/{output} per million tokens',
  '，缺单价': ', no price',
  '\n  ⚠ 还不能用：{why}': '\n  ⚠ Not usable yet: {why}',
  '用法：node src/cli.mjs catalog [list] | check [--probe] [--vendor <id>] | last | add|set <服务商/模型> --input <$/M> --output <$/M> [--cache-read] [--cache-write] [--window N] [--efforts low,medium,high|none] [--model <发给厂商的名>] | remove|enable|disable <键>': 'Usage: node src/cli.mjs catalog [list] | check [--probe] [--vendor <id>] | last | add|set <provider/model> --input <$/M> --output <$/M> [--cache-read] [--cache-write] [--window N] [--efforts low,medium,high|none] [--model <name sent to the provider>] | remove|enable|disable <key>',
  // bind / endpoint
  '用法：node src/cli.mjs bind [show] | bind set <tier>=<服务商/模型>... [--effort low|medium|high|none]': 'Usage: node src/cli.mjs bind [show] | bind set <tier>=<provider/model>... [--effort low|medium|high|none]',
  '要给 tier=服务商/模型（可多个）': 'Give tier=provider/model (one or more)',
  '要写成 tier=服务商/模型，实得 {sp}': 'Must be written as tier=provider/model, got {sp}',
  '，推理强度 {effort}': ', reasoning effort {effort}',
  '，推理强度清空（各角色自己的默认）': ', reasoning effort cleared (each role uses its own default)',
  '  （下一个节点起生效；正在跑的节点跑完才换）': '  (takes effect from the next step; a running step finishes first)',
  '服务商（● 启用 ○ 停用；key 只看填没填）：': 'Providers (● enabled ○ disabled; keys are only checked for presence):',
  '⚠ 升级后系统里已经没有这个服务商了（只剩以前改过的几项设置）；只能删：node src/cli.mjs endpoint remove {id}': '⚠ After an upgrade the system no longer has this provider (only some settings changed earlier remain); it can only be removed: node src/cli.mjs endpoint remove {id}',
  '已填': 'Set',
  '未填': 'Not set',
  '  聚合平台': '  gateway',
  '  按回报计费': '  billed as reported',
  '  鉴权头 {h}': '  auth header {h}',
  '\n新增：node src/cli.mjs endpoint set <id> --adapter openai-chat|openai-responses|anthropic|gemini --base-url <URL> --key-env <变量名> [--auth-header X --auth-prefix "Bearer "] [--models-path /models] [--gateway] [--billing reported] [--label 名]': '\nAdd: node src/cli.mjs endpoint set <id> --adapter openai-chat|openai-responses|anthropic|gemini --base-url <URL> --key-env <variable name> [--auth-header X --auth-prefix "Bearer "] [--models-path /models] [--gateway] [--billing reported] [--label name]',
  '要给服务商 id': 'Give a provider id',
  '没有这个服务商：{id}': 'No such provider: {id}',
  '拉取失败：{err}': 'Fetch failed: {err}',
  '  不支持推理强度': '  no reasoning effort',
  '\n{n} 个（✓ = 已在目录）。加入：node src/cli.mjs catalog add {id}/<模型> --input <$/M> --output <$/M>': '\n{n} models (✓ = already in the catalog). Add: node src/cli.mjs catalog add {id}/<model> --input <$/M> --output <$/M>',
  '（这个平台的列表带价格，看板上一键加入会带上）': ' (this platform\'s list includes prices; adding with one click on the board brings them along)',
  '（这个平台的列表不带价格，要自己填）': ' (this platform\'s list has no prices; fill them in yourself)',
  '已保存服务商 {id}（{adapter} · {url}；key 在 .env 的 {env}': 'Saved provider {id} ({adapter} · {url}; key in .env as {env}',
  '，已填': ', set',
  '，还没填': ', not set yet',
  '）': ')',
  '{id} 及其模型已删除': '{id} and its models removed',
  '用法：node src/cli.mjs endpoint [list] | set <id> … | enable|disable|remove|test|models <id>': 'Usage: node src/cli.mjs endpoint [list] | set <id> … | enable|disable|remove|test|models <id>',
  '令牌无效或已吊销': 'The token is invalid or has been revoked',
  // deliver / signoff
  '工作区不存在：{dir}': 'The workspace does not exist: {dir}',
  '已开 PR：{url}（base {base}）': 'Opened PR: {url} (base {base})',
  '未开 PR（没给 --pr）。开：node src/cli.mjs deliver {taskId} --pr': 'No PR opened (no --pr given). To open one: node src/cli.mjs deliver {taskId} --pr',
  '签收：{so}': 'Sign-off: {so}',
  '未签收': 'not signed off',
  '  → node src/cli.mjs signoff {taskId} --accept | --reject "<理由>"': '  → node src/cli.mjs signoff {taskId} --accept | --reject "<reason>"',
  '要给 --accept 或 --reject "<理由>"': 'Give --accept or --reject "<reason>"',
  '已记下你的签收意见（事项 {qid}）：{note}': 'Recorded your sign-off opinion (item {qid}): {note}',
  '已签收 {taskId}（{how}）。高风险任务现在可以开 PR：node src/cli.mjs deliver {taskId} --pr': 'Signed off {taskId} ({how}). High-risk tasks can now open a PR: node src/cli.mjs deliver {taskId} --pr',
  '已打回 {taskId}：修正 {mid} 已入 inbox（紧急）。重跑 run 走重规划：node src/cli.mjs run {taskId}': 'Sent back {taskId}: correction {mid} is in the Inbox (urgent). Run again to go through replanning: node src/cli.mjs run {taskId}',
  // user
  '已停用': 'Disabled',
  '标签 {tags}  通道 {channels}  令牌 {token}': 'tags {tags}  channels {channels}  token {token}',
  '有效': 'Valid',
  '无': 'None',
  '      名下：{text}': '      Responsible for: {text}',
  '  值班：{users}，起 {start}，每 {days} 天换': '  On-call: {users}, from {start}, rotating every {days} days',
  '只有管理员能管理成员': 'Only admins can manage members',
  'user add <名字> --role member|observer [--tags a,b] [--out <令牌文件>]': 'user add <name> --role member|observer [--tags a,b] [--out <token file>]',
  '已加用户 {id}（{role}）': 'Added user {id} ({role})',
  '令牌写入 {file}（库里只有哈希，这个文件是唯一副本；交给本人，本人用 --token-file 指向它）': 'Token written to {file} (the database only keeps a hash; this file is the only copy. Give it to the person, who points --token-file at it)',
  '要给用户 id': 'Give a user id',
  '标签已改': 'Tags updated',
  'user setting <键> true|false': 'user setting <key> true|false',
  'user channel <用户 id> --ntfy <url> | --feishu <url> | --dingtalk <url> | --wecom <url> | --remove <种类>': 'user channel <user id> --ntfy <url> | --feishu <url> | --dingtalk <url> | --wecom <url> | --remove <kind>',
  '已删 {kind} 通道': 'Removed the {kind} channel',
  '已挂 {n} 条通道（审计只记种类，不记地址）': 'Added {n} channels (the audit log records only the kind, not the address)',
  '没给通道（--ntfy / --feishu / --dingtalk / --wecom；删除用 --remove <种类>）': 'No channel given (--ntfy / --feishu / --dingtalk / --wecom; to remove: --remove <kind>)',
  'user role <id> lead|member|observer（lead = 管理员）': 'user role <id> lead|member|observer (lead = admin)',
  '角色已改为 {role}': 'Role changed to {role}',
  '角色没变': 'Role unchanged',
  'user rename <id> <新名字>': 'user rename <id> <new name>',
  '已改名为 {name}': 'Renamed to {name}',
  '名字没变': 'Name unchanged',
  'user token <id> [--out <令牌文件>]   重发令牌：旧的立刻失效': 'user token <id> [--out <token file>]   reissue a token: the old one stops working immediately',
  '已重发 {name} 的令牌：吊销旧令牌 {n} 枚，新令牌写入 {file}（库里只有哈希，这个文件是唯一副本）': 'Reissued the token for {name}: revoked {n} old tokens; the new token is written to {file} (the database only keeps a hash; this file is the only copy)',
  '这是你自己的令牌：正在运行的看板 / 守护进程还拿着旧的，要重启它们': 'This is your own token: a running board / auto-run still holds the old one, so restart them',
  '已停用，吊销令牌 {n} 枚。恢复：user enable <id>，再 user token <id> 重发令牌': 'Disabled; revoked {n} tokens. To restore: user enable <id>, then user token <id> to reissue a token',
  '已恢复。令牌在停用时已吊销：user token <id> 重发': 'Restored. Tokens were revoked when disabled: reissue with user token <id>',
  '<接手人 id>': '<new owner id>',
  'user 子命令：list | add | tags | perms | setting | channel | role | rename | token | disable | enable': 'user subcommands: list | add | tags | perms | setting | channel | role | rename | token | disable | enable',
  // handover
  [`handover preview|run --from <id> --to <id> (--project <项目 id> | --solo | --all) [--note "<备注>"] [--disable] [--allow-quorum-drop]
  handover requests | approve <申请 id> [--allow-quorum-drop] | reject <申请 id> [--note] | withdraw <申请 id>
  管理员可直接执行任意交接；项目负责人可直接执行本项目范围内的交接；其余情况 run = 提交申请（项目范围由该项目负责人或管理员批准，其余由管理员批准）；--from 省略 = 自己`]: `handover preview|run --from <id> --to <id> (--project <project id> | --solo | --all) [--note "<note>"] [--disable] [--allow-quorum-drop]
  handover requests | approve <request id> [--allow-quorum-drop] | reject <request id> [--note] | withdraw <request id>
  Admins can run any handover directly; a project owner can run handovers within their project directly; otherwise run = submit a request (project-scoped ones are approved by that project's owner or an admin, the rest by an admin); omitting --from = yourself`,
  '没有等批准的交接申请': 'No handover requests awaiting approval',
  '（{scope}{disable}）': ' ({scope}{disable})',
  '，交接后停用': ', then disable',
  '  备注：{note}': '  note: {note}',
  '    现在执行会失败：{err}': '    Running it now would fail: {err}',
  '已批准并执行': 'Approved and carried out',
  '已驳回': 'Rejected',
  '已撤回': 'Withdrawn',
  '已通知接手人': 'The new owner has been notified',
  '接手人没有配通知通道，请当面告知': 'The new owner has no notification channel; tell them in person',
  '要给范围：--project <项目 id> | --solo | --all': 'Give a scope: --project <project id> | --solo | --all',
  '\n（预览，什么都没改）执行：同样的参数把 preview 换成 run': '\n(preview; nothing changed) To carry it out: same arguments with preview replaced by run',
  '；run 会提交申请，等{approver}批准': '; run submits a request that waits for approval by {approver}',
  '\n已提交交接申请 {id}，等{approver}批准（批准前什么都不会改）。撤回：node src/cli.mjs handover withdraw {id}': '\nSubmitted handover request {id}; it waits for approval by {approver} (nothing changes before that). To withdraw: node src/cli.mjs handover withdraw {id}',
  '\n已执行。': '\nDone. ',
  // routing / question
  '（默认表：不属于项目的任务）': '(default table: tasks outside any project)',
  '（无）': '(none)',
  '类型': 'Type',
  '范围': 'Scope',
  '收件人': 'Recipients',
  '人数  冲突    超时': 'Quorum Conflict Timeout',
  '路由表 {label}：模板 {tpl}': 'Routing table {label}: template {tpl}',
  '（未保存过，按 solo 即时解析）': ' (never saved; resolved on the fly as solo)',
  '；负责人 {lead}': '; owner {lead}',
  '  介入者：{list}': '  Involved: {list}',
  '  与模板 {tpl} 的差异：新增 {a} 行，删去 {r} 行，改动 {c} 行（routing reset 可回到模板）': '  Differences from template {tpl}: {a} rows added, {r} removed, {c} changed (routing reset goes back to the template)',
  '  需指定：{list}': '  needs: {list}',
  '没有这个模板': 'No such template',
  '按{what}回放 {n} 条历史事项：': 'Replaying {n} past items with {what}:',
  '模板 {name}': 'template {name}',
  '当前表': 'the current table',
  '  {u} 会被打断 {n} 次': '  {u} would be interrupted {n} times',
  '（其中 Ⅲ 级 {n} 次）': ' ({n} of them level Ⅲ)',
  '  落空（没人接）：{n} 条': '  Unaddressed (nobody picks it up): {n}',
  '；会成为冲突事项：{n} 条': '; would become disagreement items: {n}',
  '只有这个项目的负责人能改它的路由表': 'Only this project\'s owner can change its routing table',
  '只有管理员能改默认路由表': 'Only admins can change the default routing table',
  'routing template <名字> [--set pm=u_x --set tl=u_y]': 'routing template <name> [--set pm=u_x --set tl=u_y]',
  '已按模板 {name} 写入 {label}': 'Wrote template {name} into {label}',
  'routing owner <类型> <解析器>...   类型：{types}；解析器：user:<id> user:lead group:<标签> group:* on_duty inform:<解析器>': 'routing owner <type> <resolver>...   types: {types}; resolvers: user:<id> user:lead group:<tag> group:* on_duty inform:<resolver>',
  '{type} 归属改为 {recips}；介入者现为 {list}': '{type} now goes to {recips}; involved: {list}',
  '已从所有行去掉；介入者现为 {list}': 'Removed from every row; involved: {list}',
  '值班日历已存：{users}，每 {days} 天换': 'On-call calendar saved: {users}, rotating every {days} days',
  '--file <路径>': '--file <path>',
  '已导出 {f}': 'Exported {f}',
  '路由表没存：\n{errs}': 'Routing table not saved:\n{errs}',
  '已存 {n} 行；按它回放 {q} 条历史事项：落空 {u} 条，打断 {i}': 'Saved {n} rows; replaying {q} past items with it: {u} unaddressed, interruptions {i}',
  'routing 子命令：show | templates | template <名> | reset | owner <类型> <解析器>... | remove <用户> | duty | preview [--template 名] | export --file | import --file': 'routing subcommands: show | templates | template <name> | reset | owner <type> <resolver>... | remove <user> | duty | preview [--template name] | export --file | import --file',
  'question 子命令：transfer <问题 id> --to user:<id> [--to group:<标签>]': 'question subcommands: transfer <item id> --to user:<id> [--to group:<tag>]',
  '要给 --to': 'Give --to',
  '要给问题 id': 'Give an item id',
  '已转交：{from} → {to}': 'Handed over: {from} → {to}',
  // show
  '宪法块 v{version}': 'contract v{version}',
  ' · 依赖 {deps}': ' · depends on {deps}',
  ' · 无依赖': ' · no dependencies',
  '验收: {a}': 'acceptance: {a}',
  '交接 {id}：{files}': 'Handoff {id}: {files}',
  '契约 {c}': 'contract {c}',
  '叙事 {ref}': 'narrative {ref}',
  '\n上下文装配 {n} 次：': '\n{n} context assemblies:',
  '宪法v{v}': 'contract v{v}',
  '条目 {n} 条': '{n} entries',
  '\n假设登记表：': '\nAssumption registry:',
  '\n[?] 第 {level} 级问题 {id}  status={status}': '\n[?] Level {level} item {id}  status={status}',
  '默认动作：{a}': 'Default action: {a}',
  '无默认动作（Ⅲ 级则为库层强制）': 'No default action (enforced by the database for level Ⅲ)',
  '复工简报 {id}': 'Resume briefing {id}',
  '（挂起时上下文 {n} token，已丢弃）': ' (context at suspend was {n} tokens; dropped)',
  '做到哪：{s}': 'Progress: {s}',
  '获答计划：{s}': 'Plan once answered: {s}',
  '答复 {id} by {who}': 'Answer {id} by {who}',
  '\n任务参数：': '\nTask parameters:',
  '由 {kind} 设置': 'set by {kind}',
  '\n花费 {usd}（{n} 次调用）': '\nSpend {usd} ({n} calls)',
  '\n审计轨 {n} 条：': '\nAudit trail, {n} entries:',
  // 入口
  '状态库不存在：{path}\n先跑 node src/cli.mjs init': 'The state database does not exist: {path}\nRun node src/cli.mjs init first',
  '要给任务 id': 'Give a task id',
  '要给项目 id 或任务 id': 'Give a project id or task id',
  '{cmd} <任务 id>': '{cmd} <task id>',
  ' <新标题>': ' <new title>',
  '已恢复（→ {to}）': 'Reopened (→ {to})',
  '，所属项目回到进行中': '; its project is back in progress',
  '标题已改为 {title}': 'Title changed to {title}',
  '已归档（从列表隐藏；状态不变）': 'Archived (hidden from the list; status unchanged)',
  "未知命令 '{cmd}'": "Unknown command '{cmd}'",
  // 用法说明（整段一个键）
  [`superintern {version} —— 服务端长期运行的自主编码 agent（人只答题 / 取舍 / 提变更 / 叫停）

  node src/cli.mjs decisions <项目 id|任务 id> [--all] [--void <决定 id> "理由"]   # 决定登记：此刻仍然有效的约定清单（有结论的事项 / 批准过的契约与变更 / 改过的目标）
  node src/cli.mjs stalls [--raise]                          # 停等账本：每个没结束的任务在等谁（自己 / 时钟 / 某个人 / 上游）；⚠ 那几行是说不出在等谁的缺陷，--raise 升成事项
  node src/cli.mjs digest [--user <id|名字>] [--send]        # 我的待办打包：等我答的 / 等冲突结论的 / 等别人的 / 知会我的；负责人另见没人接的、任务状态、未读汇报、异议
  node src/cli.mjs catalog check [--probe] [--vendor <id>] | last   # 模型目录漂移：还在不在、能不能调（--probe 花极少的钱）、单价与窗口对不对；只报告，目录由人改
  node src/cli.mjs endpoint [list] | set <id> --adapter … --base-url … --key-env … | enable|disable|remove|test|models <id>   # 服务商（直连厂商 / 聚合平台）；key 只在 .env
  node src/cli.mjs catalog [list] | add|set <服务商/模型> --input <$/M> --output <$/M> [--window N] [--efforts …] | remove|enable|disable <键>   # 模型目录（缺单价不能绑）
  node src/cli.mjs bind [show] | bind set <tier>=<服务商/模型>... [--effort low|medium|high|none]   # 档位绑定（进库、记审计；下一个节点起生效）
  node src/cli.mjs init [--name <管理员显示名>] [--bind <tier>=<服务商/模型>]...     # 库已存在时 --name 改显示名；首装时 --bind 写默认绑定
  node src/cli.mjs new "<标题>" --goal <目标> --dod <完成定义> [--scope <范围>]
                                [--constraint <约束>]... [--verify "<任务级验收命令>"]
  node src/cli.mjs new --file <task.json>
  node src/cli.mjs plan <taskId> [--tier light|standard|heavy] [--attempts N] [--force] [--bind <tier>=<服务商/模型>]...   # --bind 只覆盖本次进程；常态用 bind set
  node src/cli.mjs workspace <taskId> [--source <repo>] [--dir <路径>] [--ref <commit>] [--force]
  node src/cli.mjs run <taskId> [--cycles N] [--once] [--tier ...] [--iterations N]
                                [--no-commit] [--no-verify] [--no-sandbox]
  node src/cli.mjs revision <taskId> [--approve | --reject] [--reservation "批了，但这一条我保留意见：…"]
  node src/cli.mjs sandbox [--reap] [--task <taskId>]
  node src/cli.mjs sources [add|remove]                      联网目录（管理员）：内置 5 个软件源，可加镜像 / 私有仓库 / 可信的信息源
  node src/cli.mjs project setup <projectId> [--cmd "<命令>"]... [--clear]   环境准备命令：新工作区与项目级验收前自动先跑（装依赖用）
  node src/cli.mjs project egress <projectId> [--add <源>]... [--remove <源>]...   项目联网：从联网目录里勾选，项目下所有任务共用
  node src/cli.mjs egress <taskId> [--allow <源>]... [--deny <源>]...
  node src/cli.mjs new --idea "<一段话>" [<标题>] [--source <现有仓库路径>]   从模糊想法开始：追问器先问、出草案、你批准后自动规划开跑（要开守护进程）
  node src/cli.mjs draft <taskId> [--bind ...]   追问器的一次寿命（守护进程会自动跑；手动也可）
  node src/cli.mjs say <taskId> "<正文>" [--kind instruction|correction|context] [--urgent] [--about <questionId>] [--mode fake --script <响应脚本.json>]
      # 不给 --kind：系统读正文判断是修正（改要做的事）/ 新指令（加一件事）/ 补充信息（不改要做的事），落库标 kind_source=classifier；给了就一字不改
  node src/cli.mjs answer <questionId> "<答复>" [--token-file <路径>]   多人时按路由表数人头；立场不同会生成冲突事项
  node src/cli.mjs answer <questionId> --agree [答复 id]                 附议已有的那条（不写新文本，计入法定人数）
  node src/cli.mjs answer <questionId> --abstain ["说明"]                弃权：这条不归我（从收件人里去掉自己，人数重算）
  node src/cli.mjs question transfer <questionId> --to user:<id> [--reason "..."]   把一条事项转给别人（事项级，不改表；理由会显示给对方）
  node src/cli.mjs user list | add <名字> --role member|observer [--tags a,b] | tags <id> --tags a,b | channel <id> --ntfy <url> | --remove <种类>
  node src/cli.mjs user role <id> lead|member|observer（lead = 管理员）| perms [<id>]（权限一览）| setting [<键> true|false] | rename <id> <新名字> | token <id>（重发令牌）| disable <id> | enable <id>
  node src/cli.mjs handover preview|run --from <id> --to <id> (--project <id> | --solo | --all) [--note ".."] [--disable]   交接；成员 run = 申请
  node src/cli.mjs handover requests | approve|reject|withdraw <申请 id>
  node src/cli.mjs routing show | templates | template <名> [--set pm=u_x] | reset | owner <类型> <解析器>... | remove <用户> |
                           duty --users u_a,u_b --start 日期 | preview [--template 名] | export --file f | import --file f   [--project <id>]
  node src/cli.mjs tick [taskId] [--notify <cmd>]   扫到期的问题：Ⅰ 级走默认 / Ⅱ 级升级或退默认（给 cron 用）
  node src/cli.mjs deliver <taskId> [--remote <url>] [--branch <名>] [--pr] [--base <分支>]
  node src/cli.mjs project new --file <项目.json> --source <仓库路径或URL> [--base <ref>]   整批契约建项目（守护进程串着跑）
  node src/cli.mjs project new --brief <规划文本或文件> (--source <仓库> | --empty) [--title <名>]   让规划器切整批契约，人批一次
  node src/cli.mjs project plan <projectId> [--bind …]  规划器的一次寿命（守护进程会自动拉）
  node src/cli.mjs project show <projectId>            各任务状态 / 签收 / 合并
  node src/cli.mjs project advance <projectId>         手动推进一步（没开守护进程时用）
  node src/cli.mjs project budget <projectId> [--usd <美元> | --clear]    项目预算闸（默认不设；撞闸 = 不再开新任务 + 一条 Ⅲ 级事项）
  node src/cli.mjs project verify <projectId> [--cmd "<一条命令>" | --clear]   项目级验收命令（选填；没填时"项目达成"只能由人宣布）
  node src/cli.mjs project gear <projectId> [propose|auto]    自动化挡位；不带参数看当前挡与四条前提各自成不成立
  node src/cli.mjs project limits <projectId> [--key <项> --value <数> | --key <项> --clear]   项目默认上限（部署默认 → 项目默认 → 任务覆盖）
  node src/cli.mjs project sandbox <projectId> [node|python]      沙箱镜像（默认只有 Node；python = 在它之上加 Python 3）
  node src/cli.mjs project concurrency <projectId> [--max <1-4>]   同时最多开几个任务（默认 2；只有开着的任务全都在等人时才让路）
  node src/cli.mjs project deliver <projectId> --remote <url> [--pr] [--base <分支>] [--accept-pending]
  node src/cli.mjs project signoff <projectId> [--accept-all]   后置签收：自动挡下 AI 自己加的任务攒着的签收，看清单 / 一次点掉（交付前必须清掉）
                                    push 工作区分支；--pr 在 GitHub 开 PR（要 .env 里的 GITHUB_TOKEN；高风险任务先签收）
  node src/cli.mjs signoff <taskId> --accept | --reject "<理由>"   人工签收；打回 = 一条紧急修正
  node src/cli.mjs web [--port 7357] [--daemon]   看板（只绑 127.0.0.1；--daemon 同时带守护进程；不接 --bind —— 子进程自己读库里的绑定，库空时 --bind 写入一次）
  node src/cli.mjs web --team --public-url https://<内网域名> [--host 127.0.0.1] [--daemon]   团队模式：多人各自登录，放在 HTTPS 反向代理之后（docs/deploy-team.md）
  node src/cli.mjs daemon [--interval 15] [--notify <cmd>] [--digest-every 8h] [--catalog-check 7d|--no-catalog-check]   守护进程：答完题 / 加额 / 批准后自动拉起 run；含 tick；--digest-every 按间隔给每人推待办摘要，换班时自动给接班人推；--catalog-check 按间隔查模型目录漂移（默认 7d，绑定里出现没查过的模型立刻查）
  node src/cli.mjs show <taskId>
  node src/cli.mjs questions [--all]      列开放 / 已升级的问题（--all 含已答复的最近 20 条）；一眼看有没有人要答
  node src/cli.mjs limit <taskId> [--budget_micro_usd N] [--runtime_ms N] [--llm_calls N]
                                  [--node_retries N] [--idle_cycles N] [--context_tokens N]
  node src/cli.mjs replay <taskId>

全局：--db <路径>（默认 .superintern/state.db）
      --mode live|record|replay  --cassette <路径>（录制/回放 LLM 调用）
      --mode fake --script <响应脚本.json>（离线跑状态机；**无视上下文**，不验 agent）

run 一次 = 编排器的一次寿命：能推进多少推进多少，遇到挂起就**退出进程**。
恢复不是另一条路径，就是再跑一次 run（统一恢复语义）。

limit 不带参数只看不改。上限是宪法层参数，agent 结构上改不了（库层 CHECK）。
触顶不会静默死掉：状态机会**不调用任何模型**地生成一条 Ⅲ 级问题，任务转 waiting。

replay 只读 audit_log + 状态库重建全过程，不看进程日志、不读叙事正文，
末尾的完整性自检才是判据 —— 能打印出时间线证明不了什么。

run **默认在容器沙箱里**跑命令。
沙箱起不来就报错退出，不会静默退回宿主机裸跑。--no-sandbox 是给离线自测的，
它会打一行警告：那条路上 agent 生成的代码直接落在你的机器上。

出网默认**完全关闭**（--network none，连代理容器都不起）。要放行就按生态加
（egress --allow npm），名单外的域在 CONNECT 阶段即拒、TLS 都不建立，
每一次出网尝试含被拒的都进审计轨。白名单是宪法层参数，agent 结构上改不了。
`]: `superintern {version} — a long-running, server-side autonomous coding agent (people only answer questions, make trade-offs, request changes, and stop things)

  node src/cli.mjs decisions <project id|task id> [--all] [--void <decision id> "reason"]   # decision registry: the agreed decisions still in effect (settled items / approved contracts and changes / edited goals)
  node src/cli.mjs stalls [--raise]                          # stall ledger: who each unfinished task is waiting for (itself / the clock / a person / upstream); ⚠ rows are defects where it cannot say, --raise turns them into items
  node src/cli.mjs digest [--user <id|name>] [--send]        # my to-do bundle: waiting for my answer / for a disagreement to settle / on others / FYI; owners also see unaddressed items, task status, unread reports, dissent
  node src/cli.mjs catalog check [--probe] [--vendor <id>] | last   # model catalog drift: still there, callable (--probe spends a tiny amount), prices and windows right; report only, people edit the catalog
  node src/cli.mjs endpoint [list] | set <id> --adapter … --base-url … --key-env … | enable|disable|remove|test|models <id>   # providers (direct vendors / gateways); keys live only in .env
  node src/cli.mjs catalog [list] | add|set <provider/model> --input <$/M> --output <$/M> [--window N] [--efforts …] | remove|enable|disable <key>   # model catalog (no price = cannot bind)
  node src/cli.mjs bind [show] | bind set <tier>=<provider/model>... [--effort low|medium|high|none]   # tier bindings (stored in the database, audited; take effect from the next step)
  node src/cli.mjs init [--name <admin display name>] [--bind <tier>=<provider/model>]...     # with an existing database, --name renames; on first install, --bind writes default bindings
  node src/cli.mjs new "<title>" --goal <goal> --dod <definition of done> [--scope <scope>]
                                [--constraint <constraint>]... [--verify "<task acceptance command>"]
  node src/cli.mjs new --file <task.json>
  node src/cli.mjs plan <taskId> [--tier light|standard|heavy] [--attempts N] [--force] [--bind <tier>=<provider/model>]...   # --bind overrides this process only; use bind set for lasting changes
  node src/cli.mjs workspace <taskId> [--source <repo>] [--dir <path>] [--ref <commit>] [--force]
  node src/cli.mjs run <taskId> [--cycles N] [--once] [--tier ...] [--iterations N]
                                [--no-commit] [--no-verify] [--no-sandbox]
  node src/cli.mjs revision <taskId> [--approve | --reject] [--reservation "Approved, but I have a reservation on this one: …"]
  node src/cli.mjs sandbox [--reap] [--task <taskId>]
  node src/cli.mjs sources [add|remove]                      network catalog (admins): 5 built-in package sources; add mirrors / private registries / trusted info sources
  node src/cli.mjs project setup <projectId> [--cmd "<command>"]... [--clear]   setup commands: run automatically before new workspaces and project acceptance checks (for installing dependencies)
  node src/cli.mjs project egress <projectId> [--add <source>]... [--remove <source>]...   project network access: pick from the network catalog; shared by all tasks in the project
  node src/cli.mjs egress <taskId> [--allow <source>]... [--deny <source>]...
  node src/cli.mjs new --idea "<a paragraph>" [<title>] [--source <existing repo path>]   start from a rough idea: the question asker asks first, drafts, and once you approve it plans and runs automatically (needs auto-run)
  node src/cli.mjs draft <taskId> [--bind ...]   one lifetime of the question asker (auto-run does this automatically; you can also run it by hand)
  node src/cli.mjs say <taskId> "<text>" [--kind instruction|correction|context] [--urgent] [--about <questionId>] [--mode fake --script <responses.json>]
      # without --kind: the system reads the text and decides whether it is a correction (changes what to do) / new instruction (adds something) / extra info (does not change what to do), stored with kind_source=classifier; with --kind it is kept as given
  node src/cli.mjs answer <questionId> "<answer>" [--token-file <path>]   with several people, counts heads per the routing table; differing positions raise a disagreement item
  node src/cli.mjs answer <questionId> --agree [answer id]                 second an existing answer (no new text; counts toward quorum)
  node src/cli.mjs answer <questionId> --abstain ["note"]                not mine: this one is not mine (removes you from the recipients; quorum recalculated)
  node src/cli.mjs question transfer <questionId> --to user:<id> [--reason "..."]   hand an item over to someone else (per item, no table change; the reason is shown to them)
  node src/cli.mjs user list | add <name> --role member|observer [--tags a,b] | tags <id> --tags a,b | channel <id> --ntfy <url> | --remove <kind>
  node src/cli.mjs user role <id> lead|member|observer (lead = admin) | perms [<id>] (permissions overview) | setting [<key> true|false] | rename <id> <new name> | token <id> (reissue token) | disable <id> | enable <id>
  node src/cli.mjs handover preview|run --from <id> --to <id> (--project <id> | --solo | --all) [--note ".."] [--disable]   handover; for members, run = request
  node src/cli.mjs handover requests | approve|reject|withdraw <request id>
  node src/cli.mjs routing show | templates | template <name> [--set pm=u_x] | reset | owner <type> <resolver>... | remove <user> |
                           duty --users u_a,u_b --start date | preview [--template name] | export --file f | import --file f   [--project <id>]
  node src/cli.mjs tick [taskId] [--notify <cmd>]   sweep due items: level Ⅰ takes the default / level Ⅱ escalates or falls back to the default (for cron)
  node src/cli.mjs deliver <taskId> [--remote <url>] [--branch <name>] [--pr] [--base <branch>]
  node src/cli.mjs project new --file <project.json> --source <repo path or URL> [--base <ref>]   create a project from a full set of contracts (auto-run runs them in sequence)
  node src/cli.mjs project new --brief <plan text or file> (--source <repo> | --empty) [--title <name>]   let the planner split it into contracts; people approve once
  node src/cli.mjs project plan <projectId> [--bind …]  one lifetime of the planner (auto-run starts it automatically)
  node src/cli.mjs project show <projectId>            status / sign-off / merge of each task
  node src/cli.mjs project advance <projectId>         advance one step by hand (when auto-run is off)
  node src/cli.mjs project budget <projectId> [--usd <dollars> | --clear]    project budget gate (none by default; hitting it = no new tasks + one level Ⅲ item)
  node src/cli.mjs project verify <projectId> [--cmd "<a command>" | --clear]   project acceptance command (optional; without it "project done" can only be declared by a person)
  node src/cli.mjs project gear <projectId> [propose|auto]    automation gear; without an argument shows the current gear and whether each of the four prerequisites holds
  node src/cli.mjs project limits <projectId> [--key <item> --value <number> | --key <item> --clear]   project default limits (deployment default → project default → task override)
  node src/cli.mjs project sandbox <projectId> [node|python]      sandbox image (Node only by default; python = Python 3 on top of it)
  node src/cli.mjs project concurrency <projectId> [--max <1-4>]   how many tasks may be open at once (default 2; the next one only starts when all open tasks are waiting on people)
  node src/cli.mjs project deliver <projectId> --remote <url> [--pr] [--base <branch>] [--accept-pending]
  node src/cli.mjs project signoff <projectId> [--accept-all]   deferred sign-off: sign-offs piled up for tasks the AI added in auto gear; list them / clear them at once (must be cleared before delivery)
                                    push the workspace branch; --pr opens a GitHub PR (needs GITHUB_TOKEN in .env; sign off high-risk tasks first)
  node src/cli.mjs signoff <taskId> --accept | --reject "<reason>"   manual sign-off; send back = one urgent correction
  node src/cli.mjs web [--port 7357] [--daemon]   board (binds to 127.0.0.1 only; --daemon also runs auto-run; no --bind — child processes read bindings from the database; with an empty database --bind is written once)
  node src/cli.mjs web --team --public-url https://<intranet domain> [--host 127.0.0.1] [--daemon]   team mode: everyone signs in separately, behind an HTTPS reverse proxy (docs/deploy-team.md)
  node src/cli.mjs daemon [--interval 15] [--notify <cmd>] [--digest-every 8h] [--catalog-check 7d|--no-catalog-check]   auto-run: starts run after answers / limit raises / approvals; includes tick; --digest-every sends everyone a to-do digest at that interval and the incoming on-call person one at handover; --catalog-check checks model catalog drift at that interval (default 7d; checks at once when a never-checked model shows up in the bindings)
  node src/cli.mjs show <taskId>
  node src/cli.mjs questions [--all]      list open / escalated items (--all includes the 20 most recent answered ones); see at a glance whether anyone needs to answer
  node src/cli.mjs limit <taskId> [--budget_micro_usd N] [--runtime_ms N] [--llm_calls N]
                                  [--node_retries N] [--idle_cycles N] [--context_tokens N]
  node src/cli.mjs replay <taskId>

Global: --db <path> (default .superintern/state.db)
        --mode live|record|replay  --cassette <path> (record / replay LLM calls)
        --mode fake --script <responses.json> (run the state machine offline; **ignores context**, does not test the agent)

One run = one lifetime of the orchestrator: it advances as far as it can and **exits the process** when something is suspended.
Resuming is not a separate path; it is just another run (unified resume semantics).

limit without arguments only shows. Limits are contract-level parameters the agent structurally cannot change (database CHECK).
Hitting a limit never dies silently: the state machine raises a level Ⅲ item **without calling any model**, and the task goes to waiting.

replay rebuilds the whole history from audit_log + the state database only, without process logs or narrative text (criterion 10);
the integrity self-check at the end is what counts — printing a timeline proves nothing.

run executes commands **in a container sandbox by default**.
If the sandbox cannot start, it errors out instead of silently falling back to the bare host. --no-sandbox is for offline self-tests,
and it prints a warning: on that path the code the agent generates lands directly on your machine.

Network access is **fully off** by default (--network none; not even the proxy container starts). To allow it, add by ecosystem
(egress --allow npm); domains outside the list are refused at CONNECT before any TLS is set up,
and every network attempt, refused ones included, goes into the audit trail. The allowlist is a contract-level parameter the agent structurally cannot change.
`,
};
