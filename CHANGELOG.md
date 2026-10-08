# 更新记录 / Changelog

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
