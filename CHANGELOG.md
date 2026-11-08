# 更新记录 / Changelog

## v0.5.0 — 2026-11-08

升级前请先读 [docs/deploy.md](docs/deploy.md) 「升级」一节末尾的「从 0.4.x 升到 0.5.0 要知道的」。/ Before upgrading, read "Upgrading from 0.4.x to 0.5.0" at the end of the Upgrading section in [docs/deploy.en.md](docs/deploy.en.md).

**安全与数据修复 / Security and data fixes**

- 交付推的是开头核过签收的那个提交。原来推的是推送那一刻的分支头，签收之后才落下的提交也会被一起推出去。/ Delivery now pushes the exact commit whose sign-off was checked. It used to push the branch head at the moment of pushing, so a commit that landed after the sign-off could go out with it.
- 已做完、还没合并的任务上发修正：原来修正悬着没人接，签收和合并照常，人要的改动就丢了。现在任务重新打开、改完再合并；合并已经开始的，修正自动转成「添加任务」。/ A correction sent to a finished but not yet merged task used to sit unhandled while sign-off and merging went ahead, so the requested change was lost. The task now reopens and is merged only after the correction is done; if merging has already started, the correction becomes an "Add task" request.
- 暂停或中止的任务不会再被系统改回运行。原来暂停期间 AI 提一个问题就会把暂停冲掉；规划途中中止的任务，规划完照样开工花钱。/ Paused or aborted tasks are no longer switched back to running by the system. Previously a question from the AI during a pause cleared the pause, and a task aborted during planning still started work and spent money once planning finished.
- 项目联网保存时按"勾掉了哪些、新勾了哪些"合并到当前名单上。原来整份覆盖，会悄悄删掉别人刚放行的源。/ Saving a project's network settings now merges what you unchecked and newly checked into the current list. It used to overwrite the whole list, silently removing sources someone else had just allowed.
- 一次签收只签页面上列着的任务；打开页面之后才攒下的不会被一起签掉。/ Signing off several tasks at once only signs the tasks listed on the page; tasks that came in after you opened it are not signed with them.
- 系统不再替人拍板：结构矛盾、方案批准、签收、上限追加、联网放行、意见不一致、系统卡住这几类一律没有默认答复，到期只升级，再没人答就一直等着并通知相关的人；升级时还开着的这类事项也一样。原来系统代填的结构矛盾 8 小时后会替人"撤销改动"或"照旧接着做"。/ The system no longer decides for people: structural conflicts, plan approvals, sign-offs, limit increases, network approvals, disagreements and system-stuck items never have a default answer. When they time out they are escalated, and if still unanswered they wait and the people involved are told; this also applies to such items already open at upgrade. Previously, structural conflicts filled in by the system would "revert the changes" or "carry on as before" on their own after 8 hours.
- 超时按默认结案、升级、转走或挂住，现在都会推给原来的收件人和任务负责人（原来前两种不推）。迟到的异议、负责人覆盖、后答取代、弃权现在真的会推给相关的人（原来只记在审计里）。部署出故障的告警推给全体管理员（原来只推给第一个）。/ Items closed by default on timeout, escalated, rerouted or left waiting are now pushed to the original recipients and the task owner (the first two used to send nothing). Late objections, owner overrides, superseded answers and abstentions now actually notify the people concerned (they used to be recorded only in the audit log). Deployment failure alerts go to all administrators instead of only the first.
- 运行测试（`npm test`）不再读 `.env`，不会往你配好的通知通道真发通知。/ Running the test suite (`npm test`) no longer reads `.env`, so it no longer sends real notifications to your configured channels.

**叫停与改方向 / Stopping and changing course**

- 暂停、中止、暂停全部和紧急修正在 AI 的下一轮就生效，不再等这一步连同验收做完。中止和暂停全部会当场取消进行中的模型调用；被取消那一次的花费按估算记账，并标为估算。/ Pause, Abort, Pause all and urgent corrections take effect at the AI's next turn instead of after the current step and its review. Abort and Pause all cancel a model call in flight; the cost of a cancelled call is recorded as an estimate and marked as such.
- 被打断的那一步写到一半的改动不会丢：先存进 `refs/superintern/parked/<步骤>`，下次开跑时放回；放不回时写明在哪、怎么取。/ Half-finished changes of an interrupted step are not lost: they are saved to `refs/superintern/parked/<step>` and put back when the step runs again; if they cannot be put back, the step says where they are and how to retrieve them.
- 补充信息在执行中途就送到 AI 手上，不用等这一步做完；`say --urgent` 发的修正或新指令会打断当前步骤、马上重新规划。/ Extra info reaches the AI in the middle of a step instead of after it; corrections and new instructions sent with `say --urgent` interrupt the current step and replan right away.
- 参与过这个任务的人（事项发给过他，或他答过）也能暂停它；继续由负责人或按暂停的那个人点；中止仍只给负责人。/ People who took part in a task (an item was sent to them, or they answered one) can now pause it; the owner or whoever paused it can resume; only the owner can abort.
- 「从这一步重来…」：把一个做完的步骤，连同用到它结果的步骤一起退回重做，代码回到这一步之前。确认前先看预览：退回哪几步、哪些文件回到旧样子或被删、撤回哪些事项、哪些签收作废。旧代码留在 `refs/superintern/rewound/<id>`，不删。命令行：`rewind <任务> <步骤> [--note "…"] [--yes]`。/ "Redo from this step…": send a finished step back to be redone together with the steps that used its results, with the code returned to before that step. A preview comes first: which steps go back, which files revert or are deleted, which items are withdrawn and which sign-offs are voided. The old code is kept at `refs/superintern/rewound/<id>`. CLI: `rewind <task> <step> [--note "…"] [--yes]`.
- AI 需要改可动路径之外的文件时，可以申请扩大范围：系统发一条批准事项，写明要放进的路径、理由、范围外改动的 diff，以及与同项目其它任务范围的重叠；批了就写进契约，这一步不用重做。/ When the AI needs to change files outside its writable paths, it can ask to widen its scope: the system sends one approval item with the paths, the reason, the out-of-scope diff and any overlap with other tasks in the project; once approved, the paths are added to the contract and the step does not have to be redone.

**项目规则与扩展 / Project rules and extensions**

- 项目规则：仓库里分层的 `AGENTS.md`（也认 `AGENTS.override.md`，都没有时认 `CLAUDE.md`）交给执行器和验收员，越深的那份越优先，合计 32 KiB。规则文件由人维护，AI 改了会被打回；规则和已定的约定冲突时，挂一条事项给负责人。「项目设置 → 项目规则」所有能看项目的人都能看，负责人能新建、编辑、删除（保存就是在项目分支上提交一次）。/ Project rules: layered `AGENTS.md` files in the repository (also `AGENTS.override.md`, with `CLAUDE.md` as a fallback) are given to the executor and the reviewer; deeper files take precedence, up to 32 KiB in total. Rules files are maintained by people and changes by the AI are sent back; when a rule conflicts with a decided convention, the project lead gets an item. Anyone who can see the project can view them under Project settings → Project rules, and the lead can create, edit and delete them (saving commits to the project branch).
- Skill：部署、项目、仓库三层（仓库里的 `.agents/skills/`，其次 `.claude/skills/`），格式是带 `SKILL.md` 的目录。AI 每一步先只看到名字和说明，用得上时再取全文。「项目设置 → Skill」里负责人逐份开关；命令行 `skill list | add | remove | off | on`。/ Skills at three levels: deployment, project and repository (`.agents/skills/`, or else `.claude/skills/`), each a directory with a `SKILL.md`. At each step the AI first sees only names and descriptions and fetches the full text when it needs it. The lead turns them on and off under Project settings → Skills; CLI: `skill list | add | remove | off | on`.
- 策略钩子：工具调用前、交接前、合并前、交付前四个时机，写法与 Claude Code / Codex 的钩子相同（stdin 传 JSON、exit 2 拦下、`permissionDecision`），现成的钩子可以直接用。仓库里的钩子（`.superintern/hooks.json`，以及 `.claude/settings.json` 里的 PreToolUse）只在沙箱里跑；部署级和项目级的钩子要先核准（`hook trust`），内容一变就要重新核准。合并前、交付前的钩子出错按拦下处理。「项目设置 → 钩子」写明每个时机拦下、要人确认、出错各会怎样。/ Policy hooks at four points: before a tool call, before handoff, before merge and before delivery, in the same format as Claude Code and Codex hooks (JSON on stdin, exit 2 to block, `permissionDecision`), so existing hooks work as they are. Repository hooks (`.superintern/hooks.json`, and PreToolUse in `.claude/settings.json`) run only in the sandbox; deployment and project hooks must be approved first (`hook trust`) and again whenever their content changes. Hooks before merge and before delivery count as blocking when they fail. Project settings → Hooks shows what happens at each point when a hook blocks, asks for confirmation or fails.
- MCP 客户端：本机（stdio）和远程（HTTP）server 都在任务的沙箱里起，远程的经出网代理、受联网放行管。负责人在「项目设置 → MCP」（或 `mcp check` / `mcp approve`）看过工具说明原文再批准；server 的命令、地址或工具清单一变，AI 就拿不到它，等重新批准。每个工具默认每次调用都要人点头，可以改成直接用或不给 AI。/ MCP client: local (stdio) and remote (HTTP) servers run inside the task's sandbox, and remote ones go through the egress proxy under the project's network rules. The lead reviews the tool descriptions under Project settings → MCP (or `mcp check` / `mcp approve`) and approves them; if a server's command, address or tool list changes, the AI loses access until it is approved again. Each tool needs a person's approval on every call by default and can be switched to always allowed or off.
- 仓库地图：执行器每一步开头拿到一张"文件 → 定义的符号"的图，按这一步的范围排序（`deploy.repo_map_tokens`，默认 2048 token，0 = 不给）。主机上装了 Universal Ctags 就用它抽符号。/ Repository map: at the start of each step the executor gets a map of files and the symbols they define, ranked by the step's scope (`deploy.repo_map_tokens`, default 2048 tokens, 0 = off). Universal Ctags is used when it is installed on the host.

**GitHub 闭环 / GitHub loop**

- 盯交付的 PR：守护进程定期看已交付 PR 的状态、CI 和评审，任务页和项目页有「交付的 PR」卡。要用部署级的 GitHub App（或部署级令牌），并给读检查、提交状态和 Actions 的权限。/ Watching delivered PRs: the daemon checks the status, CI and reviews of delivered PRs, shown on a "Delivered PR" card on task and project pages. This needs a deployment-level GitHub App (or deployment token) with read access to checks, commit statuses and Actions.
- AI 跟进：交付开 PR 时单独问一句要不要授权。授权后，CI 没过由 AI 修，修好推回同一个 PR（最多 2 轮；撞预算闸门、分支上有别人的提交时改为问人）；有交付权的成员在 GitHub 上「Request changes」也会直接转成修正。卡片上随时可以收回授权或由你授权；命令行交付加 `--autofix off` 不授权。合并仍由人在 GitHub 上点。/ AI follow-up: when delivering with a PR you are asked separately whether to authorize it. Once authorized, failed CI is fixed by the AI and pushed back to the same PR (at most 2 rounds; it asks a person instead when the budget gate would be hit or someone else has pushed to the branch), and "Request changes" on GitHub from a member who may deliver the task becomes a correction directly. The authorization can be withdrawn or taken over on the card at any time; on the CLI, deliver with `--autofix off` to leave it off. Merging is still done by a person on GitHub.
- 评审意见：卡片上可以「让 AI 按这条改」或「不用管」；不是成员的意见分开列，不会触发花钱的动作。/ Review comments: on the card you can choose "Have the AI act on this" or "Ignore"; comments from non-members are listed separately and never trigger paid work.
- GitHub issue 入口：负责人设仓库和标签，带这个标签的 issue 每条起草一份添加任务的草稿，一律要人批准（自动挡也一样）；issue 正文按外部文本处理，不当指令。只读 GitHub，不回帖、不改标签。/ GitHub issue intake: the lead sets a repository and a label, and each issue with that label becomes a draft "Add task" request that always needs a person's approval, even in auto mode; issue text is treated as external text, never as instructions. GitHub is only read: no comments or label changes.
- 定时任务：按 cron 到点起草一份添加任务（部署时区），和人提的需求一样走自动化挡位。「项目设置 → Issue 与定时任务」，命令行 `project issues` / `project schedule`。/ Schedules: a cron schedule drafts an "Add task" request when due (deployment time zone) and follows the automation mode like a request typed by a person. Project settings → Issues & schedules; CLI: `project issues` / `project schedule`.
- 项目整体交付的 PR CI 没过时，按交付人的授权起草一份修复任务。/ When CI fails on a whole-project PR, a fix task is drafted under the authorization of the person who delivered it.
- 同一分支已经开着 PR 时再交付，只推送、更新那个 PR，不再报错。/ Delivering again to a branch that already has an open PR now just pushes and updates that PR instead of failing.

**通知与监督 / Notifications and oversight**

- 介入方式与监督模式：系统发出的每类信号分「决策 / 通知 / 备案」三档。每个项目选一种监督模式：逐项审批（AI 自己定的做法和计划自己改的地方都要你点头，点头之前不合并）、抽检（默认）、例外管理（不重要的规格取舍按默认直接走、事后告诉你）。在「项目设置 → 监督与审批」里选，部署默认是 `deploy.oversight_mode`。契约、签收、花钱、安全审批永远要人定；系统替人定了、以你的名义对外动作、安全边界被改、部署故障永远会通知，个人调不掉。/ Human involvement and oversight modes: every kind of system signal is one of Decide, Notify or Record. Each project picks an oversight mode: Full oversight (choices the AI makes on its own and plan changes it makes need your approval, and nothing merges before that), Spot check (default), or Management by exception (minor spec choices go ahead with the default and you are told afterwards). Choose it under Project settings → Oversight & approvals; the deployment default is `deploy.oversight_mode`. Contracts, sign-offs, spending and security approvals always need a person; decisions made for people by the system, external actions in your name, security boundary changes and deployment failures are always notified and cannot be muted.
- 审批门禁：负责人列出必须有人点头才能跑的命令（如 `git push*`、`*migrate*`），AI 跑到这条命令前停下，发一条「安全审批」事项，答「同意」放行这一条。策略钩子要人确认、MCP 工具要批准也都是安全审批：没有默认，不会因超时被替人定。/ Approval gates: the lead lists commands that need a person's approval before they run (such as `git push*` or `*migrate*`); the AI stops before such a command and sends a "Security approval" item, and answering "agree" allows that one command. Policy hooks that ask for confirmation and MCP tools that need approval also become security approvals: they have no default and are never decided by timeout.
- 「我的通知」：每类信号自己选推送还是只留记录；收件箱新增「通知」卡片，每条写明归哪一类，可以一键"这一类以后不推送给我"。/ "My notifications": choose per kind of signal whether to be pushed or only keep a record; the Inbox has a new notifications card that shows each entry's kind and lets you stop pushes of that kind with one click.
- 推送节奏：紧急的马上推；其余只在你的工作时间里推（默认工作日 9–18 点，按你自己的时区和部署的节假日表），每隔 60 分钟攒成一条「汇总推送」；每小时打断你的次数有「推送限额」（默认 4 次；Ⅲ 级事项（签收除外）和部署故障不受限）。在「我的通知 → 什么时候推」里改自己的，管理员在同一处改部署默认。/ Push pacing: urgent items are pushed right away; everything else is pushed only during your working hours (weekdays 9–18 by default, in your own time zone and following the deployment's holidays) and combined into one "Digest" every 60 minutes; a "Rate limit" caps how often you are interrupted per hour (4 by default; level Ⅲ items other than sign-offs, and deployment failures, are exempt). Change your own under "My notifications → When to push"; administrators change the deployment defaults in the same place.
- 收件箱里同类事项按项目排在一起；签收写明"还差谁"；联网被拦和出网时替它带上凭据，按任务攒成一条「系统小修」。/ In the Inbox, items of the same kind are grouped by project; sign-offs show who is still missing; blocked network requests and credentials added on the way out are combined into one "Minor system fixes" entry per task.
- 事项链接与快速答复：每条推送末尾带一个链接，点开只装那一件，手机上也能读能答（签收、安全审批、方案批准等仍到完整任务页）。链接地址取 `deploy.board_url`，没填就用看板自己的地址；链接不带凭据，打开照常登录。/ Item links and Quick reply: every push ends with a link that opens just that item, readable and answerable on a phone (sign-offs, security approvals, plan approvals and similar items still open the full task page). Links use `deploy.board_url`, or the board's own address when it is not set; they carry no credentials, so opening one requires the usual login.
- 邮件通道：在 `.env` 配好 `SMTP_URL` 和 `MAIL_FROM` 后，可以按人推送到邮箱（「设置 → 成员」或 `user channel <id> --email <邮箱>`），`MAIL_TO` 是部署级收件邮箱。远端连接强制 TLS。/ Email channel: with `SMTP_URL` and `MAIL_FROM` set in `.env`, pushes can go to each person's email address (Settings → Members, or `user channel <id> --email <address>`); `MAIL_TO` is the deployment-wide address. TLS is required for remote mail servers.
- 邮件答复：再配上 `IMAP_URL`（可选 `MAIL_REPLY_TO`），规格取舍、结构矛盾、系统卡住这三类事项可以直接回推送邮件来答。每封的答复只算第一次、72 小时内有效，要从登记的邮箱回；没算上的回信会收到一封说明。/ Reply by email: with `IMAP_URL` also set (and optionally `MAIL_REPLY_TO`), spec choices, structural conflicts and system-stuck items can be answered by replying to the push email. Only the first reply counts, within 72 hours, and it must come from the registered address; replies that do not count get an explanation by email.
- 状态报告：一段时间里出事了没有、没等你拍板就定下的、进展、花费，按人现算，不调模型。侧栏「状态报告」页随时看（最近 24 小时 / 7 天 / 30 天 / 上个月）；定期推送默认跟着监督模式（抽检是每周一 9 点一份摘要），在「我的通知」里改频率、钟点和详略；命令行 `report`。/ Status reports: whether anything went wrong, what was decided without waiting for you, progress and spending over a period, computed per person without calling a model. See them any time on the "Status report" page in the sidebar (last 24 hours, 7 days, 30 days or last month); scheduled pushes follow the oversight mode by default (a weekly summary on Mondays at 9:00 under Spot check), and frequency, time and detail can be changed under "My notifications"; CLI: `report`.
- 「你不在时」：离开看板 8 小时以上再回来，收件箱顶上给出那段时间发生了几件事和直达报告的链接。/ "While you were away": when you come back to the board after 8 hours or more, the top of the Inbox shows how much happened and links to the report for that period.
- 守护进程的 `--digest-every` 不再使用，带着它会提示一行并忽略：不紧急的新事项改由汇总推送攒着推，全量清单看收件箱或 `digest`。/ The daemon's `--digest-every` is no longer used; it is ignored with a note. Non-urgent new items now go out in digests, and the full list is in the Inbox or `digest`.

**可靠性 / Reliability**

- 几个人或几个进程同时动同一件事时，结果要么合并、要么拒绝并写明是谁、什么时候改成了什么，不再悄悄丢掉一边。覆盖答复、转交、超时处理、改上限、批准 MCP、改审批门禁、合并、交付和规划；看板在冲突后整块刷新成最新。/ When several people or processes act on the same thing at once, the result is either merged or rejected with who changed it, when and to what, instead of one side being silently lost. This covers answers, transfers, timeout handling, limit changes, MCP approvals, approval gate edits, merging, delivery and planning; after a conflict the board refreshes to the latest state.
- 合并和交付放到后台线程跑，合并时看板不再卡住；看板首页不再随已合并的任务变多而变慢；项目收工后第一次打开不再卡约 2 秒。/ Merging and delivery run in a background thread, so the board no longer freezes during merges; the home page no longer slows down as merged tasks accumulate; and the first visit after a project finishes no longer stalls for about 2 seconds.
- 同一步做过两次（修正改了规格、从这一步重来）时，下游步骤和重新规划拿到的是最新那份交接。/ When a step has been done twice (after a correction changed the spec, or after "Redo from this step"), later steps and replanning use the latest handoff.
- 停守护进程（Ctrl-C）时，后台线程先办完手头的事、关好库再退出。/ Stopping the daemon (Ctrl-C) lets background threads finish what they are doing and close the database before exiting.

**其它 / Other**

- 发布包附带 `THIRD_PARTY_NOTICES.md` 和 `LICENSES/`：仓库地图的排序方法移植自 Aider（Apache-2.0）。/ The release now includes `THIRD_PARTY_NOTICES.md` and `LICENSES/`: the repository map's ranking is ported from Aider (Apache-2.0).

## v0.4.0 — 2026-10-14

升级前请先读 [docs/deploy.md](docs/deploy.md) 「升级」一节末尾的「从 0.3.x 升到 0.4.0 要知道的」。/ Before upgrading, read "Upgrading from 0.3.x to 0.4.0" at the end of the Upgrading section in [docs/deploy.en.md](docs/deploy.en.md).

**安全修复 / Security fixes**

- 沙箱里的代码原来能往工作区的 `.git` 写钩子或 fsmonitor 配置，下一次宿主机上的 git 操作就会以宿主环境执行它。现在 `.git` 对沙箱只读，宿主机上的 git 一律不执行仓库里的钩子和 fsmonitor；旧规则起的沙箱容器会自动重建。/ Code in the sandbox could write git hooks or an fsmonitor setting into the workspace `.git`, which the next git operation on the host would then run with the host's environment. The workspace `.git` is now read-only to the sandbox, and git on the host never runs hooks or fsmonitor from the repository; sandbox containers started under the old rules are recreated automatically.
- 联网目录里工具配置带的凭据不再注入沙箱，改为配在源上、由出网代理替工具带上；配了凭据的源默认只读。以前放行过这些源的项目，任务代码读得到这些凭据，建议轮换。/ Credentials in package-source tool settings are no longer injected into the sandbox; they are now set on the source and added by the egress proxy, and sources with credentials are read-only by default. Projects that allowed those sources could read the credentials before, so rotating them is recommended.
- 看板：修掉多处没转义的插值（其中有反射型和存储型 XSS），上了严格的内容安全策略，脚本全部外置。/ Board: fixed many unescaped insertions (including reflected and stored XSS), added a strict Content Security Policy and moved all scripts out of the page.
- 团队模式：看不见的任务不能再被下指令、暂停或签收；实时推送只推给看得见的人；「仅成员可见」项目的路由表、成员名单和仓库不再列给所有人；请求里引用别的任务的事项一律拒绝。/ Team mode: tasks you cannot see can no longer be instructed, paused or signed off; live updates only go to people who can see them; routing, member lists and repositories of members-only projects are no longer shown to everyone; requests referencing items of another task are rejected.
- 以 `-` 开头的远端地址或源仓库地址会被当成 git 选项，现在拒收。/ Remote or source URLs starting with `-` were taken as git options; they are now rejected.
- 浏览器登录不再把长期令牌放进 cookie，改为会话：闲置或到期失效，退出即作废；吊销令牌、停用成员后，开着的页面立即断开。/ Browser login no longer puts the long-lived token in a cookie; it uses a session that expires when idle or at its time limit and is revoked on logout. Revoking a token or deactivating a member disconnects their open pages at once.
- 推送原来实际上是强推；现在只推系统自己的分支，不推默认分支、不强推、不删分支，远端有别人的提交时停下来说明。/ Pushes were effectively forced; now the system only pushes its own branches, never the default branch, never forces or deletes, and stops to explain when the remote has someone else's commits.
- 写进库、日志、模型调用录制和通知的密钥统一换成 `[redacted]`；贴进对话的 key 在存库之前就去掉，模型也看不到。/ Secrets written to the database, logs, model-call recordings and notifications are replaced with `[redacted]`; keys pasted into a conversation are removed before they are stored, so the model never sees them.
- 其它：交接时算不出改动清单就拒收（原来会跳过范围检查）；`--force` 只删系统自己建的目录；模型给的正则在单独线程里跑、有时限；请求体超过 1 MB 拒收；出错时不再把 SQL 和堆栈返回给页面。/ Other: a handoff is rejected when its change list cannot be computed (the scope check used to be skipped); `--force` only deletes directories the system created; regular expressions from the model run in a separate thread with a time limit; request bodies over 1 MB are rejected; error responses no longer include SQL or stack traces.

**验收与执行 / Review and execution**

- 验收员在运行中的应用上点验：改了界面的步骤带几条界面条目，验收员把应用起起来，在页面上打开、点、填、选，逐条给出结论，有一条不通过就打回。每次操作后自动存一张画面，签收的人能逐条看到。需要仓库根的 `si-preview.json`（AI 自己维护）和带 Chromium 的 Python 沙箱镜像。/ The reviewer checks the running app: steps that change the UI carry a few UI checks, and the reviewer starts the app, opens pages, clicks, types and selects, gives a verdict per check and sends the step back if any fails. A screen is saved after each action, and the person signing off can see them per check. Requires `si-preview.json` at the repository root (maintained by the AI) and the Python sandbox image with Chromium.
- 系统起预览服务和写样例数据时带 `SI_PREVIEW=1`；样例数据脚本没有它就拒绝运行，免得写进真在用的库。/ The system sets `SI_PREVIEW=1` when it starts preview services and writes sample data; sample-data scripts refuse to run without it, so they never write into a live database.
- 按角色绑定模型：规划、执行、验收、汇报等角色可以各自指定模型（「设置 → 模型分配」或 `bind role`）。验收员与执行器落在同一家出品方时，默认换另一家验收；高风险步骤可以设成两家各验一次。/ Models per role: planning, execution, review, reporting and other roles can each get their own model (Settings → Model assignment, or `bind role`). When the reviewer and the executor would come from the same vendor, a different vendor reviews by default; high-risk steps can be set to be reviewed by two vendors.
- 服务商熔断与备用模型：某家连续出错时暂停调用它一段时间（所有进程共用），有备用模型的档位自动换过去，恢复后换回（`bind fallback`）。/ Vendor circuit breaker and fallback models: a vendor that keeps failing is paused for a while (shared across processes); tiers with a fallback switch to it and switch back once the vendor recovers (`bind fallback`).
- 测试保护：交接时比对这一步对原有测试做了什么（删文件、加跳过、用例或断言变少、改期望值），标出来交给验收员和签收的人；可以设成直接打回（`deploy.test_guard reject`）。人可以在答复里放行。/ Test protection: at handoff the system compares what the step did to pre-existing tests (deleted files, added skips, fewer cases or assertions, changed expectations) and flags it for the reviewer and the sign-off; it can be set to reject such handoffs (`deploy.test_guard reject`). A person can allow the change when answering.
- 执行器遇到规格互相矛盾、确实做不到时，可以直接提出来；事项里写明冲突各方的原文和试过的做法。/ When the spec contradicts itself and the task cannot be done, the executor can say so directly; the item quotes each side of the conflict and what was tried.
- 上下文整理：上下文超过自动整理线（默认 120k token，0 = 关）时先整理再接着跑，不再整步作废重来；同一步整理两次还装不下就建议拆步。/ Context compaction: when the context passes the compaction threshold (default 120k tokens, 0 = off), it is compacted and work continues instead of the step being discarded; if one step still does not fit after two compactions, the system suggests splitting it.
- 打回诊断：每次打回判断这一步是在收敛、停滞还是反复，停滞或反复时带着缺陷清单交给人；步骤详情有「打回与诊断」。/ Rejection diagnosis: each rejection is judged as converging, stalled or recurring; stalled or recurring steps go to a person with the list of defects. Step details show the rejection history and diagnosis.

**签收与协作 / Sign-off and collaboration**

- 签收卡开头「签收前先看这些」：AI 替人定的、没人答按默认的、改了原有测试的、页面没验成的、越界的、打回过的，按"要你拍板 / 要你核对 / 仅告知"分档。/ Sign-off cards open with "Look at these before signing off": decisions the AI made, items settled by default, changed pre-existing tests, UI checks that could not be done, out-of-scope changes and rejections, grouped as decide / verify / for information.
- 「设置 → 成员」显示每个人的批准习惯；最近几次都很快全批准时提醒负责人。/ Settings → Members shows each person's approval habits and reminds the owner when someone keeps approving everything within seconds.
- 计划变更的三个选项改为：批准 / 要改、重出一版（你写的话交给 AI）/ 不要这份变更；显示契约改动前后对比。/ Plan changes now offer: approve / revise and resubmit (your words go back to the AI) / drop the change, with a before/after view of the contract.
- 一条达成确认里几个人各提了需求，每个任务记在各自提出人名下，由各自签收。项目达成确认发给整个项目，各目录的人顺带收到、可以补充。/ When several people add requests in one completion review, each task is recorded under the person who asked for it and signed off by them. Project completion reviews go to the whole project; people from each directory also receive them and can add notes.
- 改了路由表或值班表后，还没人表态的事项按新规则改发，设置页列出改发了哪些、没改发的在谁手里。/ After the routing table or duty roster changes, items nobody has responded to yet are re-sent under the new rules, and the settings page lists what was re-sent and who still holds the rest.
- AI 自己定的小事按"谁会在乎"分给人过目：状态码、模块入口这类实现细节不再发给管产品的人。/ Small decisions the AI made are routed by who would care: implementation details such as status codes or module entry points no longer go to the product owner.
- 修改溯源：契约条款有编号；提交信息带出处 trailer，PR 正文带溯源表；看板和 `trace` 命令能从一行代码倒查到步骤、条款、指令和批准人。/ Change provenance: contract clauses are numbered; commits carry provenance trailers and PRs a provenance table; the board and the `trace` command go from a line of code back to the step, clauses, instructions and approver.
- 邀请链接、用 GitHub 登录（限组织成员）、只读令牌与服务账户；命令行令牌默认 90 天过期。/ Invite links, GitHub login (organization members only), read-only tokens and service accounts; CLI tokens now expire after 90 days by default.
- 两个人前后脚处理同一条事项时，后到的一方看到已由谁、何时处理；同时改路由表、服务商时提示冲突。/ When two people act on the same item, the second sees who already handled it and when; concurrent edits to routing or vendors are detected.

**部署与运维 / Deployment and operations**

- 交付用的凭据（连接）：令牌、GitHub App、SSH 密钥，加密存储，按远端和点交付的人现场挑选，交付前预检、到期提醒。/ Delivery credentials (connections): tokens, GitHub Apps and SSH keys, stored encrypted, chosen per remote and per person delivering, with a pre-delivery check and expiry reminders.
- 管理员一键「暂停全部」自动运行，恢复后接着跑。/ Admins can pause all automatic work with one click and resume it later.
- 「设置 → 运行状况」：守护进程、容器、状态库、备份、模型服务商、运行期自检等逐项标出；管理员公告；`/healthz` 存活探针；看板升级后提示刷新。/ Settings → System status lists the daemon, containers, database, backups, model vendors, runtime self-checks and more; admin announcements; a `/healthz` liveness probe; a refresh prompt after the board is upgraded.
- 自动备份（默认每 24 小时）与恢复、例行完整性检查（`db backup` / `restore` / `check`）。/ Automatic backups (every 24 hours by default) and restore, plus routine integrity checks (`db backup` / `restore` / `check`).
- 按人记账、按人和按部署的月度预算、调用前预占额度、按人轮流调度。/ Spending per person, monthly budgets per person and per deployment, pre-reserved budget before each call, and fair scheduling across people.
- 部署时区、节假日与调休、值班代班；「1bd」、值班交接和月度预算按部署时区算。/ Deployment time zone, holidays and make-up workdays, duty swaps; "1bd", duty hand-overs and monthly budgets follow the deployment time zone.
- 结构化日志（JSON 行）、日志自动清理、可选的 OTLP 追踪导出（不含提示词和回复内容）。/ Structured JSON logs, automatic log cleanup and optional OTLP trace export (prompts and replies are never exported).
- 设了 `HTTPS_PROXY` 时模型调用也走代理。/ Model calls go through `HTTPS_PROXY` when it is set.
- 无障碍：键盘可达、焦点可见、对比度、读屏播报、320px 窄屏。/ Accessibility: keyboard access, visible focus, contrast, screen-reader announcements and 320px-wide screens.

**可靠性 / Reliability**

- 状态库并发写入不再报 "database is locked" 崩溃；迁移与版本号同一事务，失败时停在原版本；所有表加了类型与形状约束。/ Concurrent writes no longer crash with "database is locked"; migrations run in one transaction with the version bump and stop at the old version on failure; all tables gained type and shape constraints.
- 同一任务同时只会有一个进程在跑；进程被硬杀后，活动流写明意外退出，已做完没提交的步骤在重启后补提交，并立刻通知人。/ Only one process runs a task at a time; after a process is killed, the activity feed says so, finished-but-uncommitted steps are committed on restart, and a person is told right away.
- 服务商回了 2xx 却是坏回包时按厂商错误重试，不再崩掉；推理模型的空回复不再让决定核对失败。/ A vendor returning a 2xx with a broken body is retried as a vendor error instead of crashing; empty replies from reasoning models no longer make decision checks fail.
- 验收员处理删除前的确认框，不再把浏览器卡死；界面条目多的验收给足轮数。/ The reviewer handles confirmation dialogs such as "Delete?" instead of hanging the browser, and reviews with many UI checks get enough turns.
- 被转交、超时转给下一位的人现在会收到推送。/ People who receive an item by hand-over or timeout now get a notification.
- 时长改用单调时钟，校时或休眠恢复不再误撞上限。/ Durations use a monotonic clock, so clock adjustments or resuming from sleep no longer trip limits.

## v0.3.1 — 2026-10-08

**看板 / Board**

- 页面随别人的操作刷新时，不再清掉你正在写的答复、展开的表单和光标位置。/ When the board refreshes because of someone else's action, it no longer wipes the answer you are writing, open forms or your cursor position.
- 一条事项发给几个人、别人先答了：你没交出去的草稿留在原处，页面写明是谁先答的，并给出去处（负责人可改发修正，其他人可作为补充意见留下）。/ When an item went to several people and someone else answered first, your unsent draft stays where it was; the page says who answered and offers a way forward (the owner can send it as a correction, others can keep it as a comment).
- 结构矛盾的答复框可以勾选"同时作为计划变更提交"，一次做完原来要答复再另发修正的两步。/ Answers to structural conflicts can be ticked "Also submit as a plan change", doing in one step what used to take an answer plus a separate correction.
- 合并冲突新增选项：两边在同一位置各自新加的内容（例如各自追加的测试用例）两边都保留。/ A new merge-conflict option keeps what both sides added at the same spot (for example test cases each side appended).
- 交付：远端地址预填上一次的；没填就确定会提示；远端不是 GitHub 时不再询问 PR；交付后显示"已交付"及推到哪里。/ Delivery: the remote is prefilled with the last one; confirming without one now says so; no PR questions for non-GitHub remotes; after delivery the page shows it was delivered and where.
- 保存预算闸与上限后，按钮旁留一个"已保存"标记。/ Saving the budget gate or a limit leaves a "Saved" mark next to the button.

**规划与执行 / Planning and execution**

- 规格里写死的命令行用法（参数名），规划时核对负责那个脚本的任务有没有写到。/ Command-line usage fixed in the spec (option names) is checked at planning time against the task that owns that script.
- 只有改动碰到界面时才截图；不碰界面的任务签收页说明没有截图的原因。/ Page screenshots are taken only when a change touches the UI; other tasks' sign-off pages say why there is none.
- 并行开发：样例数据只由集成任务补，避免几个同时进行的任务各改一份截图说明。/ Parallel development: only the integration task adds sample data, so tasks running at the same time no longer each edit the screenshot spec.
- 英文部署里几处会显示给人看的中文（交接被拒的原因、系统补的步骤、并行开发说明）改为英文。/ In English deployments, a few texts shown to people (handoff rejection reasons, steps the system adds, the parallel-development notes) are now in English.

## v0.3.0 — 2026-10-08

**并行开发（实验功能）/ Parallel development (experimental)**

- 从写好的规划新建项目时可以勾选「并行开发」：先做骨架任务（接口契约、各模块的桩、共享文件），合并后各模块任务同时开发、各改各的目录，共享文件对模块任务只读，最后由集成任务接起来跑端到端。默认关闭；可以在项目设置里关掉，关掉后不能再打开。
  New option when creating a project from a written plan: a skeleton task first fixes the interface contract, a stub per module and the shared files; once it is merged, module tasks are built at the same time, each in its own directory, with shared files read-only for them; an integration task connects everything end to end. Off by default; it can be turned off in project settings, but not turned on again afterwards.
- 「同时开着的任务数」上限在并行项目里就是同时干活的任务数。/ In parallel projects, the "tasks open at the same time" limit is the number of tasks working at once.
- 契约覆盖核对：规划时骨架任务要点名规格里的每个 `METHOD /path`；骨架做完时对着契约文件核对接口、查询参数与字段，缺了系统补一步让骨架补上。/ Contract coverage check: at planning time the skeleton task must name every `METHOD /path` in the spec; when the skeleton is done, the contract file is checked for those endpoints, query parameters and fields, and the system adds a step to fill any gap.
- 人批准过的计划变更点名的共享文件，对那个模块任务放行。/ Shared files named in a plan change a person approved are opened up for that module task.
- 页面截图的两步按任务能写哪些文件来补：并行项目里截图说明由骨架写、样例数据由集成任务补；样例数据脚本的可放位置写进那一步的说明。/ The two screenshot steps follow what the task may write: in parallel projects the skeleton writes the screenshot spec and the integration task adds sample data; the step says where a sample-data script may go.

**修正 / Fixes**

- 工作区与项目仓库的行尾按仓库原样（在 Windows 宿主机上合并进来的文件不再变成 CRLF）。/ Workspaces and project repositories keep line endings as committed (files merged on a Windows host no longer turn into CRLF).
- 同一条机械拒收连续出现三次，系统直接把问题交给人，不再重交到调用上限。/ When the same mechanical rejection comes back three times in a row, the system hands the question to a person instead of retrying up to the call limit.
- 修正里点名了任务可动路径之外的文件时，重规划要么把它们加进可动路径（交人批准），要么说明不需要改。/ When a correction names files outside a task's allowed paths, the replan must either add them to the allowed paths (sent for approval) or state that they need no change.
- 验收命令里的 `node --test <目录>` 按等价的 glob 执行，规划时也会要求改成文件或 glob 写法。/ `node --test <directory>` in acceptance commands is run as the equivalent glob, and planning asks for a file or glob form.
- 追加任务的可动路径包含它要追加用例的测试文件。/ Appended tasks' allowed paths include the test files they add cases to.
- 集成前按合并后的依赖清单准备环境；集成这一步留下的文件会撤掉；没有锁文件时环境准备不再生成锁文件。/ Before integrating, the environment is prepared from the merged dependency lists; files left by the integration step are removed; environment setup no longer creates a lockfile when the repository has none.
- Windows 上后台任务调用 docker / git 时不再弹出控制台窗口。/ On Windows, background tasks no longer pop up console windows when they call docker or git.
- 英文部署里几处漏出的中文。/ A few places where Chinese leaked into English deployments.

## v0.2.0 — 2026-10-01

**中英双语 / English and Chinese**

- 看板与命令行支持中文和英文。每人在看板右上角选自己的界面语言；管理员在「设置 → 成员」里定团队的内容语言（事项正文、汇报、AI 写给人的文字）。
  The board and the CLI are available in English and Chinese. Each person picks an interface language (top right of the board); an admin sets the team's content language under Settings → Members (open items, reports, and everything the AI writes for people).
- 答复用哪种语言写都能读懂（批准 / 放弃 / 保留意见 / 接受 / 打回 / 中止等）。
  Answers are understood in either language (approve / drop / reservation / accept / send back / abort, …).
- 报错按看的人的界面语言显示；命令行按 `SI_LANG` 或本人的界面语言输出。
  Errors are shown in the viewer's interface language; the CLI follows `SI_LANG` or your own interface language.

**修正 / Fixes**

- 没写标题时，项目标题不再取成目标原文的"目标："标签。/ The default project title no longer becomes the "Goal:" label of the pasted goal.
- 路由表"结构矛盾必须包含负责人"的报错写明原因和改法（「系统卡住」那一行不受此限）。/ The routing-table error for structural conflicts now explains why the owner must be included and how to fix it.
- 转交可以附一句理由；活动记录写清是谁转给了谁。/ Handing over an item can carry a reason; the activity feed says who handed it to whom.
- 项目达成确认里明说"还想加的新需求也写在这里"。/ The "is the project done?" item now says new requests can be written there too.
- 页面截图接了后端却没有样例数据时，系统补一步放样例数据，截图不再是空列表。/ When the page screenshot talks to a backend but has no sample data, the system adds a step to seed some, so screenshots no longer show empty lists.

## v0.1.0 — 2026-09-29

第一个公开版本。/ First public release.

**功能 / Features**

- 从想法开始：先追问，再出草案，人批准后规划、在容器沙箱里执行，经机械核对和验收员打分，最后由人签收。
  Idea → clarifying questions → draft → human approval → planning → sandboxed execution → mechanical checks and a reviewer model → human sign-off.
- 项目与任务依赖图；交付之后可以继续添加任务、持续迭代。
  Projects with a task dependency graph; delivered projects can keep iterating.
- 多人协作：决策路由表（六个模板）、法定人数、冲突处理、附议 / 弃权 / 转交、会签、需求提出人签收、「AI 替你定了几件事」过目。
  Multi-user collaboration: decision routing table (six templates), quorum, conflict handling, second / abstain / hand over, co-sign, requester sign-off, review of decisions the AI made on its own.
- 硬上限（花费、时长、调用次数、重试次数、内存、进程数），碰到上限就停下来问人。
  Hard limits (cost, time, calls, retries, memory, processes) that stop and ask a human.
- 按项目放行的联网白名单与出网代理；Node 和 Python 沙箱，内置截图用的 Chromium。
  Per-project egress allow-list with a proxy; Node and Python sandboxes with Chromium for page screenshots.
- 交付前核对清单，推送到任意 git 远端，可选开 GitHub PR。
  Pre-delivery checklist; push to any git remote, optional GitHub PR.
- 多厂商模型（DeepSeek / Anthropic / OpenAI / Gemini / OpenRouter / 任意 OpenAI 兼容服务商），三档绑定，模型目录漂移检查。
  Multi-vendor models, three tiers, catalog drift check.
- 本机模式与团队模式（放在 HTTPS 反向代理之后）；ntfy / 飞书 / 钉钉 / 企业微信通知。
  Local mode and team mode (behind an HTTPS reverse proxy); ntfy / Feishu / DingTalk / WeCom notifications.
- 跨平台安装与启动脚本（Windows / Linux），`--version`。
  Cross-platform setup and start scripts (Windows / Linux), `--version`.
- 协作规则：提需求的人在签收名单里时必须本人签收（负责人只算一票）；计划变更的提出人不能独自批准自己的改动；路由按文件所在目录找到对应领域的人；事项下写明还在等谁、为什么。
  Collaboration rules: a requester on the sign-off list must sign themselves (the owner counts as one vote); a plan change can't be approved by its proposer alone; routing maps file paths to their directories' owners; items say who they are still waiting for and why.
- 按依赖清单自动准备环境（Python / Node 分别进行，互不连累）；构建产物、测试输出目录默认忽略。
  Automatic environment setup from dependency manifests (Python and Node set up independently); build and test output directories ignored by default.
- 项目复盘：全部任务合并后对照目标判断是否达成、还差什么；卡住时可在项目页「重新复盘」。
  Project review: after all tasks merge, checks the goal and definition of done and proposes what is missing; a "review again" button for stalled reviews.

已知限制见 [docs/known-limits.md](docs/known-limits.md)。/ Known limits: [docs/known-limits.md](docs/known-limits.md) (Chinese).
