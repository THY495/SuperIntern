# SuperIntern

**中文** | [English](README.en.md)

一个在你自己的机器或服务器上长期运行的自主编码 agent。你交给它一个想法，它先问清细节，再拆步骤，在容器沙箱里写代码、跑验收，最后交给你签收。**你只需要做四件事：回答它的问题、做取舍、提变更、叫停。** 多人使用时，按一张「决策路由表」决定每类事由谁来拍板。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![version](https://img.shields.io/badge/version-0.1.0-orange)
![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-green)
![deps](https://img.shields.io/badge/npm%20dependencies-0-brightgreen)

---

## 目录

- [适用范围](#适用范围)
- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
  - [Windows](#windows)
  - [Linux](#linux)
  - [第一次打开看板](#第一次打开看板)
- [多人使用](#多人使用)
- [让它常驻运行](#让它常驻运行)
- [命令行](#命令行)
- [费用](#费用)
- [安全须知](#安全须知)
- [运行测试](#运行测试)
- [目录结构](#目录结构)
- [文档](#文档)
- [许可证](#许可证)

## 适用范围

**适合**：个人或小团队，在自己可控的机器上，把边界清晰的中小型开发任务（新建小应用、给现有仓库加功能或测试）交给 agent，自己只做决定。
**不适合**：大型遗留仓库、需要跨天连续推理的任务、放在公网上给陌生人用。

已知的边界与缺口见 [docs/known-limits.md](docs/known-limits.md)。

## 它能做什么

- **从一句想法开始**：追问器先把不清楚的地方问出来，再写出一份「草案」（目标、范围、完成定义、可动路径、验收命令）。你批准之后，agent 改不了它。
- **项目与任务**：一个项目有目标和完成定义，下面是按依赖关系排好的任务，前一个任务合并后下一个才开工。项目交付之后还能继续添加任务、持续迭代。
- **在沙箱里干活**：每一步都在 Docker 容器里执行，默认断网。联网按项目放行，只放行白名单里的域名（npm、PyPI 等，可配国内镜像）。支持 Node 与 Python 项目。
- **机械核对 + 模型验收**：每一步交一份交接记录，系统机械核对它（改动有没有超出可动路径、验收命令是否真的通过），再由另一个模型当验收员打分，不合格就打回重做。
- **不懂就问，不瞎猜**：遇到规格没写清的取舍，它会提问，并只挂起受影响的那一支，其余照常推进。问题带默认选项和到期时间。它自己做的小决定会汇总成「AI 替你定了几件事」，交给对应的人过目。
- **看得见结果**：任务页上有步骤图、系统在沙箱里打开做出来的页面截的图，以及逐行代码改动（统一 / 左右对照）。
- **多人协作**：用「决策路由表」规定每类决定（规格取舍、结构矛盾、方案批准、签收、上限追加、联网放行、交付……）由谁答、要几个人同意、意见不一致怎么办、没人答怎么办。内置六个模板。答复时可以附议、弃权（「不归我」）、转交。签收可以设成需求提出人签，也可以设成多人会签。
- **钱和时间都有上限**：花费、时长、调用次数、重试次数都有硬上限。碰到上限会停下来问人，既不会悄悄停摆，也不会自己接着跑。
- **交付前让你看清楚**：交付前列出要推送的提交、每个任务带进来的改动，并提示风险（比如项目没有项目级验收命令）。可以推到任意 git 远端，也可以在 GitHub 上开 PR。**交付是整套系统里唯一必须由人亲手点的一步。**
- **多厂商模型**：内置 DeepSeek、Anthropic、OpenAI、Gemini、OpenRouter，也可以加任何 OpenAI 兼容的服务商。模型分 light / standard / heavy 三档，每档用哪个模型可以随时换，还能定期检查模型目录（单价、上下文窗口）有没有变化。
- **可复盘**：所有状态都在一个 SQLite 库里，每个动作都记审计。进程随时可以挂掉，重启后接着干。`replay` 只凭审计记录就能复盘一个任务。
- **通知**：ntfy、飞书、钉钉、企业微信，或者任意一条命令，按人发送，也可以定时推送待办摘要。
- **零 npm 依赖**：只用 Node 内置模块（包括 `node:sqlite`）。看板是一个不需要构建的单页。

## 快速开始

### 前置条件

| 需要 | 说明 |
|---|---|
| Node.js **≥ 22.13** | 需要内置的 `node:sqlite`。在 24.x 上验证过 |
| git | |
| Docker（在运行） | Windows 用 Docker Desktop，保持默认的 Linux 容器模式（如果切到过 Windows 容器，在托盘图标右键选 Switch to Linux containers）；Linux 用 docker-ce。**没有容器运行时，任务不会开跑**（不会退回宿主机裸跑） |
| 至少一家模型厂商的 API key | [DeepSeek](https://platform.deepseek.com/) / [Anthropic](https://console.anthropic.com/) / [OpenAI](https://platform.openai.com/) / [Gemini](https://aistudio.google.com/) / [OpenRouter](https://openrouter.ai/)，或任何 OpenAI 兼容的服务商 |

下载：在 [Releases](../../releases) 里下载 `superintern-v0.1.0-windows.zip` 或 `superintern-v0.1.0-linux.tar.gz` 并解压，或者直接 `git clone` 本仓库。不需要 `npm install`。

> 所有命令都在解压出来的目录里执行：运行时的状态（库、令牌、日志、工作区）放在这个目录下的 `.superintern/` 里。

### Windows

```powershell
# 1. 检查前置条件、从 .env.example 生成 .env、构建沙箱镜像（第一次要几分钟）
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

# 2. 在 .env 里填至少一家厂商的 key
notepad .env

# 3. 建库、签发你的管理员令牌，并按已填的 key 选好三档模型
node src/cli.mjs init --name 你的名字

# 4. 启动（看板 + 自动调度任务的后台循环，在这个窗口前台运行，关掉窗口即停止；想开机自启见下文「让它常驻运行」）
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

### Linux

```bash
# 当前用户要能直接用 docker（在 docker 组里；加组后要重新登录）
scripts/setup.sh                        # 1. 检查前置条件、生成 .env、构建沙箱镜像
nano .env                               # 2. 填至少一家厂商的 key（setup 已把权限设成 600）
node src/cli.mjs init --name 你的名字    # 3. 建库、签发管理员令牌、按已填的 key 选模型
scripts/start.sh                        # 4. 启动看板和任务调度（前台运行，Ctrl+C 停止）
```

第一次构建沙箱镜像要从 Docker Hub 和 Debian 软件源下载约 400 MB（含截图用的 Chromium）。网络慢时可能要几十分钟；如果机器连不上这些源，可以在另一台机器上建好镜像再搬过来，方法见 [deploy-linux.md](docs/deploy-linux.md#主机够不着-docker-hub-时)。

`setup` 可以重复运行：不会覆盖已有的 `.env`，不会重建已有的镜像，也不会动已有的库。它检查 `.env` 时只看 key 填没填，不会显示 key 的值。

> 先填 key 再 `init`：`init` 会按 `.env` 里已有的 key 为三档选模型。如果建库之后才填 key，或者换了厂商，请到看板「设置 → 模型分配」里改。

### 第一次打开看板

浏览器打开 **http://127.0.0.1:7357/**。本机模式下不需要登录，你就是管理员。

1. **设置 → 服务商**：确认 key 已填好（也可以在这里粘贴，只会写进 `.env`），点「测试」。
2. **设置 → 模型分配**：确认 light / standard / heavy 三档用的都是你有 key 的那家厂商的模型。
3. **新建**：写下项目目标和完成定义，选一个仓库（新建空仓库、本机路径或 git URL 都可以）。
4. 去**收件箱**回答它的问题、批准草案，然后等它做完来找你签收。
5. 项目达成后，收件箱会提示「等你交付」。在项目页核对后，点「交付项目」。

## 多人使用

有两种方式：

- **本机模式（默认）**：看板只监听 `127.0.0.1`。在「设置 → 成员」里加人会生成令牌，其他人通过 SSH 隧道（`ssh -L 7357:127.0.0.1:7357 <主机>`）打开看板，用自己的令牌登录。
- **团队模式**：看板放在团队内网的一台服务器上，前面加 HTTPS 反向代理，每个人从自己的电脑登录。

  ```bash
  scripts/start.sh --public-url https://si.example.lan
  ```

  反向代理的配置（Caddy / nginx）、开账号的方法，以及它防什么、不防什么，见 [docs/deploy-team.md](docs/deploy-team.md)。**不要放到公网。**

两种模式下，权限都挂在「决策」上，而不是挂在人上：项目设置 → 决策路由，选一个模板再微调。常见做法是：规格取舍给产品，结构矛盾给后端，方案批准要求全员同意，签收交给需求提出人。

## 让它常驻运行

`start` 脚本是前台运行的。如果希望开机即起、崩溃后自动拉起：

- **Windows**：计划任务。`powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 install`（`status | start | stop | uninstall`）
- **Linux**：systemd 用户单元。`scripts/daemon.sh install`（团队模式加 `--public-url https://…`）

细节见 [docs/deploy.md](docs/deploy.md) 和 [docs/deploy-linux.md](docs/deploy-linux.md)（包括 WSL2）。

## 命令行

网页上的所有操作都有对应的命令。`node src/cli.mjs` 不带参数会打印完整用法。常用的有：

```bash
node src/cli.mjs --version
node src/cli.mjs digest                        # 我的待办
node src/cli.mjs questions                     # 所有开放的问题
node src/cli.mjs answer <问题 id> "..."         # 答复
node src/cli.mjs say <任务 id> "..."            # 给任务发修正 / 新指令 / 补充信息
node src/cli.mjs signoff <任务 id> --accept     # 签收（--reject "理由" 打回）
node src/cli.mjs project deliver <项目 id> --remote <git url> [--pr]
node src/cli.mjs replay <任务 id>               # 只凭审计记录复盘
node src/cli.mjs catalog check                 # 检查模型目录（单价、窗口）是否有变化
node src/cli.mjs sandbox --reap                # 清理遗留的沙箱容器
```

## 费用

费用取决于你绑定的模型和任务的大小。建议先用一个小任务试一轮，看清花费再放开。

每个任务都有花费上限（默认 $5）。项目还可以另设一个总预算（默认不设，在「项目设置 → 预算与上限」里填）。碰到上限时，系统会停下来问负责人要不要调高，不会自己接着花钱。任务页顶部一直显示已用金额和上限。

> 价格按模型目录里记的单价估算。DeepSeek 记的是峰时价，谷时实际花费更低。请以厂商账单为准。

## 安全须知

- **它会执行 AI 生成的代码。** 代码只在 Docker 容器里跑：默认断网，内存、进程数和时长都有硬上限，API key 不会进容器。尽管如此，请在你愿意承担这个风险的机器上运行。
- **API key 只存在 `.env` 里**，库里只记变量名。看板只显示「已填 / 未填」。
- **令牌就是身份。** 管理员令牌在 `.superintern/cli-token`，只看，不要贴到聊天或 issue 里。
- **联网默认全关**，按项目放行，只能访问白名单里的域名，名单外的域名在建立连接阶段就被拒绝。
- **交付要你亲手点**，推送前会列出所有要推的内容。
- **不要把看板暴露到公网。** 团队模式也只适合内网，理由见 [docs/deploy-team.md](docs/deploy-team.md)。

发现安全问题请看 [SECURITY.md](SECURITY.md)。

## 运行测试

```bash
npm test                  # 等于 node tests/run.mjs --all：全部离线回归，不花钱
npm run test:no-docker    # 没有 Docker 时跳过需要容器的两套（container、egress）
```

需要容器的两套测试，在没有 Docker 时会**失败**，而不是「跳过即通过」。这是有意设计的。

## 目录结构

| 目录 | 内容 |
|---|---|
| `src/core/` | 编排状态机与协作内核：路由表、多人答复与冲突、上限、联网、交付、修正、项目、守护进程 |
| `src/agent/` | 各个模型角色：追问器、规划器、执行器、验收员、重规划、报告 |
| `src/llm/` | 厂商适配、出厂默认的服务商 / 模型目录 / 档位绑定、目录漂移检查 |
| `src/db/` | SQLite schema 与迁移；`audit_log` 是复盘的唯一依据 |
| `src/web/` | 零依赖看板（单个 HTML + Node http 服务） |
| `sandbox/` | 沙箱镜像（Node、Python + 截图用的 Chromium）与出网代理 |
| `scripts/` | 安装、启动、常驻（Windows 计划任务 / Linux systemd） |
| `tests/` | 离线回归测试；`tests/live/` 是会实际调用模型、会花钱的测试脚本 |
| `docs/` | 部署、已知限制 |

## 文档

- [部署（Windows 与通用）](docs/deploy.md)
- [Linux 与 WSL2 部署](docs/deploy-linux.md)
- [团队模式部署](docs/deploy-team.md)
- [已知限制](docs/known-limits.md)
- [更新记录](CHANGELOG.md)

## 许可证

[MIT](LICENSE) © 2026 THY495
