# 更新记录 / Changelog

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
