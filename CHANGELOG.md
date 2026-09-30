# 更新记录 / Changelog

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
