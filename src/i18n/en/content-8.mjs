// 英文目录：内容 8（编排器、截图、改动对比、守护进程、健康提示等）。键是中文原文（逐字），值是英文。
export default {
  // ── orchestrator.mjs ──
  '写页面截图说明（si-preview.json）': 'Write the page screenshot spec (si-preview.json)',
  '给页面截图补样例数据（si-preview.json 的 seed）': 'Add sample data for page screenshots (seed in si-preview.json)',
  '执行器未声明隔离 —— 命令直接跑在宿主机上': 'The executor is not isolated — commands run directly on the host',
  '启动时发现节点停在 running —— 上一个进程死在它手里': 'Found the step stuck in running at startup — the previous process died while running it',
  '{label}是硬边界：撞顶 = 容器被 OOM / pids-limit 掐死，属任务自身失控或泄漏，提高上限不是解法。已记审计，硬失败。':
    '{label} is a hard limit: hitting it means the container was killed by OOM / pids-limit, which points to the task running away or leaking. Raising the limit is not the fix. Logged to the audit trail; hard failure.',
  '｜被拒目标：{hosts}': ' | Blocked targets: {hosts}',
  '任务被人暂停；恢复：cli 或看板 resume': 'The task was paused by a person; to resume: cli or board resume',
  '任务被人中止': 'The task was aborted by a person',
  '有一条修正撞上了仍然有效的旧决定，等那条冲突事项有结论再执行': 'A correction conflicts with an earlier decision that still stands; it will run once that conflict item is resolved',
  '刚到的修正还在对照已有决定，比对完就接着跑': 'The new correction is still being checked against agreed decisions; the run continues once the check is done',
  '所有节点都被作废了 —— 修正把这个任务改没了，需要人重新给方向': 'Every step was voided — the corrections removed this task\'s work entirely; a person needs to give new direction',
  '没有就绪节点，但也不是全部完成 —— 依赖成环或有节点停在非终态': 'No step is ready, but not everything is done — the dependencies form a cycle or a step is stuck in a non-final state',
  'limit.budget_micro_usd（{spent} ≥ {budget}）': 'limit.budget_micro_usd ({spent} ≥ {budget})',
  'limit.runtime_ms（{runtime} ≥ {cap}）': 'limit.runtime_ms ({runtime} ≥ {cap})',
  'limit.context_tokens（上一轮 {tokens} ≥ {cap}{window}）': 'limit.context_tokens (last turn {tokens} ≥ {cap}{window})',
  '，按所绑模型窗口 {window} 的 75% 封顶': ', capped at 75% of the assigned model\'s window of {window}',
  '已随节点 {id} 的上下文读入并落进交接记录': 'Read in with the context of step {id} and recorded in its handoff',
  '轮级闸门掐停：{stopped}': 'Stopped by the per-turn gate: {stopped}',
  '厂商报 context_exceeded：上下文撞的是**模型窗口**，不是本系统的上限（本系统上限 {cap}，实测已到 {seen}）':
    'The provider reported context_exceeded: the context hit the **model window**, not this system\'s limit (system limit {cap}, measured {seen})',
  ' —— 目录里记的窗口 {window} 与厂商实际不符，去核对 MODEL_CATALOG': ' — the window recorded in the catalog ({window}) does not match the provider; check MODEL_CATALOG',
  ' —— 所绑模型没有核实过的 contextWindow，上限退回了常数；给 MODEL_CATALOG 填上经核实的窗口': ' — the assigned model has no verified contextWindow, so the limit fell back to a constant; add a verified window to MODEL_CATALOG',
  '到达 maxCycles={n}': 'Reached maxCycles={n}',
  '[系统] 验收前工作区里就有没提交的改动：{paths} —— 验收只认已提交的版本，这些改动要么提交、要么撤掉':
    '[system] The workspace had uncommitted changes before the acceptance check: {paths} — the acceptance check only counts the committed version; commit these changes or discard them',
  '[系统] 验收重新生成了已提交进仓库的构建产物：{paths} —— 已还原成提交时的样子；构建产物不该进仓库（应写进 .gitignore 并从跟踪里摘掉）':
    '[system] The acceptance check regenerated build output that is committed to the repository: {paths} — restored to the committed version; build output should not be in the repository (add it to .gitignore and untrack it)',
  '[系统] 验收命令改动了工作区：{paths} —— 验收不许留下改动（已撤掉这些改动）':
    '[system] The acceptance command changed the workspace: {paths} — the acceptance check must not leave changes (these changes were discarded)',

  // ── preview.mjs ──
  '{file} 不是合法的 JSON：{msg}': '{file} is not valid JSON: {msg}',
  '{file} 缺 start：怎么把服务起起来（每条一个后台进程）': '{file} is missing start: how to bring the services up (one background process each)',
  '{file} 的 start 最多 {n} 条': '{file} allows at most {n} start entries',
  '{file} 的 url 只能是沙箱里的本机地址（http://127.0.0.1:端口）': 'The url in {file} must be a local address inside the sandbox (http://127.0.0.1:port)',
  '{file} 的 ready 最多 {n} 个地址': '{file} allows at most {n} ready addresses',
  '{file} 的 ready 里「{url}」不是本机地址（http://127.0.0.1:端口/路径）': '"{url}" in the ready list of {file} is not a local address (http://127.0.0.1:port/path)',
  '{file} 的 seed 最多 {n} 条': '{file} allows at most {n} seed entries',
  '首页': 'Home',
  '{file} 的 pages 最多 {n} 页': '{file} allows at most {n} pages',
  '{file} 的 pages 里 path 要以 / 开头': 'Each path in the pages of {file} must start with /',
  '页面上有"连不上"的报错（多半是页面没连上背后的服务）': 'The page shows a "can\'t connect" error (the page probably couldn\'t reach its backend)',
  '页面上有服务器出错的提示（背后的服务出错了）': 'The page shows a server error (the backend failed)',
  '页面上露出了程序报错的原文': 'The page shows a raw program error',
  '这个地址没有对应的页面（页面上写着 Cannot GET）': 'There is no page at this address (the page says Cannot GET)',
  '页面几乎是空白（渲染后没有文字）': 'The page is almost blank (no text after rendering)',
  '{sec} 秒内这些地址一直打不开（服务没起来，或者起来了但出错）：{urls}': 'These addresses did not respond within {sec} seconds (the services did not start, or started with errors): {urls}',
  '样例数据命令「{cmd}」出错了、没跑成，截图里可能是空的': 'The sample data command "{cmd}" failed, so the screenshots may be empty',
  '服务在截图途中挂了 —— 截完再查，这些地址已经打不开：{urls}': 'A service went down during the screenshots — checked again afterwards and these addresses no longer respond: {urls}',
  '服务起来了，但一张都没截出来': 'The services started, but no screenshot could be taken',
  '截图过程出错：{msg}': 'Screenshot capture failed: {msg}',
  '「{title}」{warning}': '"{title}": {warning}',

  // ── diffview.mjs ──
  '仓库目录不在了': 'The repository directory is gone',
  '说不出这个任务从哪一版开始（没有基线记录）': 'Can\'t tell which version this task started from (no baseline recorded)',
  '读不到这一段的提交：{err}': 'Can\'t read the commits in this range: {err}',
  '这个任务还没有工作区（没开工，或已清理）': 'This task has no workspace yet (not started, or already cleaned up)',
  '工作区不是一个可读的 git 仓库': 'The workspace is not a readable git repository',
  '这次签收不是返工，没有"这一轮"可比': 'This sign-off is not a rework, so there is no "this round" to compare',
  '步骤编号不对': 'Invalid step id',
  '读不到这个任务的提交历史': 'Can\'t read this task\'s commit history',
  '这一步没有留下提交（没改文件，或还没做完）': 'This step left no commit (no files changed, or not finished yet)',
  '这个任务还没合并进项目分支': 'This task has not been merged into the project branch yet',
  '读不到这一段的提交': 'Can\'t read the commits in this range',
  '这个文件不在这次的改动里': 'This file is not part of these changes',
  '读不到这个文件': 'Can\'t read this file',

  // ── daemon.mjs ──
  '模型目录有 {n} 项要看一眼': '{n} model catalog entries need a look',
  '目录检查：{msg}': 'Catalog check: {msg}',
  '沙箱用不了：{cli} 没在运行': 'Sandbox unavailable: {cli} is not running',
  '要改代码、跑测试的步骤已暂停（不算失败、不耗重试次数）。在服务器上把 {cli} 启动起来，系统会自己接着跑。':
    'Steps that change code or run tests are paused (this is not a failure and uses no retries). Start {cli} on the server and the system will pick up where it left off.',

  // ── escalate.mjs ──
  'heavy 已是最高档': 'heavy is already the top tier',
  '升档前预算闸门：节点「{title}」已失败 {n} 次，升到 {target} 档重试预计再花 ${estimate}，而剩余预算只有 ${left}。不升档、不重试，先问人。':
    'Budget gate before tier upgrade: step "{title}" has failed {n} times; retrying on the {target} tier is expected to cost another ${estimate}, but only ${left} of budget is left. Not upgrading or retrying; asking a person first.',
  '升档前时长闸门：节点「{title}」上次尝试跑了 {last} 分钟，升到 {target} 档预计 {need} 分钟，而剩余时长只有 {left} 分钟。不升档，先问人。':
    'Run-time gate before tier upgrade: the last attempt at step "{title}" ran {last} minutes; the {target} tier is expected to need {need} minutes, but only {left} minutes are left. Not upgrading; asking a person first.',

  // ── project-start.mjs ──
  '项目目标不能为空：用一两句话写明要做成什么': 'The project goal can\'t be empty: say in a sentence or two what should be achieved',
  '完成定义不能为空：用一两句话写明怎样算做完': 'The definition of done can\'t be empty: say in a sentence or two what counts as done',
  '勾选了"已有规划"，但规划全文为空': '"I already have a plan" is checked, but the plan text is empty',

  // ── health.mjs ──
  '没有应答': 'No response',
  '没装 {cli}': '{cli} is not installed',
  '没有可用的容器运行时': 'No container runtime available',

  // ── ledger.mjs ──
  '请求 {requested} 实际由 {served} 代答 —— 目录键 {key} 可能已退役或改名，跑 node src/cli.mjs catalog check':
    'Requested {requested} but {served} answered — catalog key {key} may have been retired or renamed; run node src/cli.mjs catalog check',
};
