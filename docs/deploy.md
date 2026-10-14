# 部署

同一份代码支持三种部署形态：

| 形态 | 守护进程怎么常驻 | 说明 |
|---|---|---|
| Windows 10/11 + Docker Desktop | 计划任务：`scripts/daemon.ps1` | 本页 |
| Linux 主机 | systemd 用户单元：`scripts/daemon.sh` | [deploy-linux.md](deploy-linux.md) |
| WSL2 | 同 Linux，另外要在 Windows 侧挂一个不退出的 wsl 会话 | [deploy-linux.md](deploy-linux.md#wsl2-特有) |

多人从各自电脑登录（团队模式），见 [deploy-team.md](deploy-team.md)。

## 共同前置

- Node **≥ 22.13**（需要不带 flag 就能用的 `node:sqlite`；在 24.x 与 26.x 上验证过）和 git。**建议选自带 SQLite ≥ 3.51.3 的 Node 发行版**（Node 24.15.0 及以后的 24.x、以及 26.x 都满足；22.x 目前还不满足）：更早的 SQLite 在 WAL 模式下多个进程同时写时，有极小概率把库写坏（见 sqlite.org/wal.html）。看板与守护进程启动时检测到会提示，看板上只给管理员看。
- 容器运行时：docker 或 podman（podman 与 rootless docker 尚未验证）。跑守护进程的用户要能直接访问 docker socket。
- 首次安装：`scripts/setup.ps1` 或 `scripts/setup.sh`。它会做这些事：
  - 检查上面的前置条件；
  - 从 `.env.example` 生成 `.env`；
  - 构建沙箱镜像 `superintern/sandbox:v0.1` 和 `superintern/sandbox:v0.3-python`；
  - 拉取出网代理镜像 `mitmproxy/mitmproxy`。

  每个任务的出网代理镜像 `superintern/sandbox:ca-*` 会在第一次用到时自动构建，可以用 `node src/cli.mjs sandbox --reap` 清理。
- `.env`（权限 600，不要提交）：
  - **模型 key**：至少填一家厂商的 key。
  - **`GITHUB_TOKEN`**：老部署的写法，仍然有效。新部署建议在「设置 → 连接」里配交付用的凭据，见下文[连接](#连接交付用的凭据)。
  - **`NTFY_URL` 等**：部署级的通知通道。每个人自己的通道在「设置 → 成员」里挂。

  检查 key 时只看填没填，不要打印值：`grep -c '^DEEPSEEK_API_KEY=.' .env`。
- 建库：`node src/cli.mjs init --name <管理员名字>`。它会做这些事：
  - 签发 CLI 令牌，写到 `.superintern/cli-token`。这是令牌唯一的明文副本，库里只存哈希。
  - 按 `.env` 里已有的 key 为 light / standard / heavy 三档选模型，也可以用 `--bind heavy=<服务商/模型>` 指定。

  库已经存在时，`init` 只跑迁移。
- 服务商、模型和档位绑定，之后都在看板「设置」里改，或者用 `endpoint` / `catalog` / `bind` 命令改。每次改动都记审计。

## Windows：计划任务

```powershell
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 install
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 status   # 也可以是 start | stop | uninstall
```

- **任务与日志**：任务名是 `SuperIntern Daemon`，登录即启动。另有一个每 5 分钟的「拉活」触发器：进程在跑就忽略，死了才拉起来。日志在 `.superintern/logs/daemon.log`。
- **启动方式**：计划任务经 `wscript.exe` 以隐藏窗口启动 `daemon-launch.vbs`，再由它启动 `node src/cli.mjs web --daemon`，并等待它退出。这样做有两个原因：
  - 不会弹出控制台窗口。如果有窗口，被人关掉时进程会跟着死。
  - 进程不会在计划任务回收时被连带杀掉。
- **Docker Desktop**：要在登录会话里开着。从开机到 docker 就绪之间，第一轮任务会启动失败并进入 5 分钟退避，之后自动恢复。
- **不要同时装两份**：不要在同一台机器上既装 Windows 计划任务版，又装 WSL2 里的 systemd 版。两者会抢同一个端口，还会各自维护一份库。

## 看板

- 本机模式只监听 `127.0.0.1:7357`。远程访问走 SSH 隧道：`ssh -L 7357:127.0.0.1:7357 <host>`，然后在本机打开 http://127.0.0.1:7357/。
- 本机模式下不带令牌的请求，按启动看板的那个管理员执行。其他成员在看板上用自己的令牌登录：「设置 → 成员」里加人时会生成令牌，只显示一次。
- 多人从各自电脑直接访问，请用团队模式：[deploy-team.md](deploy-team.md)。
- **暂停全部（急停）**：管理员在看板顶栏点「暂停全部」，系统不再开始新的步骤，正在进行的步骤做完当前这次操作就停下。不算失败、不计重试，任务也不会被取消；点「恢复自动运行」后自动接着跑。暂停状态存在库里，重启照样生效。命令行：`node src/cli.mjs user setting deploy.paused true`（`false` 恢复）。

## 模型与验收

每次模型调用都属于一个**角色**：规划、执行、验收、写汇报等。每个角色默认用一个**档位**（light / standard / heavy），档位再绑到具体模型。

- **按角色单独绑定**：「设置 → 模型分配」的「各角色用哪个模型」表，或 `node src/cli.mjs bind role <角色> <服务商/模型>`（`bind role <角色> tier` 回到档位）。`bind show` 列出各角色现在用的是什么。
- **验收员换一家**：验收员没有单独绑定、而它的档位与这一步的执行器是同一家出品方时，系统自动换另一家的模型来验收。"同一家"按模型出品方算，经网关调用的模型按名字前缀算（`moonshotai/kimi-k3` 算 moonshotai）。`.env` 里只有一家的 key 时不换。在同一张表下面可以关掉（`deploy.verifier_vendor same`）。
- **两家会签**：同一处还可以让规划时标为高风险的步骤由两家各验一次，都通过才算过（`deploy.verifier_cosign high_risk`，默认关）。
- **备用模型**：每个档位可以配一个备用模型（「模型分配」的「备用」列，或 `bind fallback <档位>=<服务商/模型>`，`none` 去掉）。某家服务商连续出错时，系统暂停调用它一段时间（所有进程共用这个判断，冷却时间逐次加倍、最长 15 分钟），这期间有备用的档位自动换过去，恢复后换回。没有备用的步骤会等着，运行状况的「模型服务商」一项写明在等哪家。
- **原有测试被改弱**：每一步交接时，系统对比这一步对任务开始前就有的测试做了什么：删掉测试文件、加了跳过、用例或断言变少、改了期望值。默认只标出来，交给验收员和签收的人看；想让这种交接直接被打回，运行 `node src/cli.mjs user setting deploy.test_guard reject`（目前没有页面开关）。确实需要改时，答复那一条事项时勾「允许这一步改这些任务开始前就有的测试」，或命令行 `answer <事项> "…" --allow-tests`。目前认得 JavaScript、Python 和 Go 的测试写法。
- **上下文整理**：一次请求的上下文超过「自动整理线」时，系统先整理再接着跑：先把最早的大段工具输出换成一行占位（命令的完整输出另存在工作区的 `.si-outputs/`，不进提交），还不够再让模型写一份简报、按简报重建上下文。同一步整理两次还装不下，会发一条事项建议把这一步拆小。整理线在任务页或项目设置的「预算与上限」里改，默认 120k token，0 = 关闭；实际生效的不会超过上下文上限的 80%。

### 验收员在运行中的应用上点验

改了界面的步骤，规划时会写几条**界面条目**（"点删除后列表少一行"这一类，每步最多 8 条）。验收员会把应用起起来，在页面上打开、点、填、选，逐条给出"通过 / 不通过 / 没验成"，有一条不通过就打回。

- **要满足的条件**：任务在沙箱里跑，用的是带 Chromium 的 Python 镜像（项目默认就是；改成 `project sandbox <id> node` 的项目验不了，会记成"没验成"）；仓库根目录有 `si-preview.json`，写明怎么起服务。这份文件由 AI 自己维护：有界面条目的步骤交接时缺了它或写错，会被打回。
- **`si-preview.json`**：`start`（起服务的命令，最多 3 条）、`url`（只能是 `http://127.0.0.1` 或 `localhost`）必填；`ready`（起好之后要能访问的地址）、`seed`（写样例数据的命令）、`pages`（要看的页面）、`waitMs` 选填。签收前的页面截图用的也是它。
- **`SI_PREVIEW=1`**：系统起服务、写样例数据时都带这个环境变量。样例数据脚本会先检查它，没有就拒绝运行，免得把示例数据写进真在用的库；后端也可以据此换一个预览专用的库。签收卡上"自己把应用跑起来看"的命令也带着它。
- **看得到 AI 点了什么**：每次点、填之后自动存一张画面，验收员下结论时引用的留下（每条最多 3 张），其余删掉。步骤详情的「页面点验」逐条显示结论和画面；签收卡「页面截图」下面有「AI 验收时在页面上点过的」。没验成的条目会进签收卡「签收前先看这些」，要你自己核对。
- 应用起不来时，所有条目记"没验成"并附上原因，不会因此判失败。不支持拖拽、悬停菜单、上传文件和多标签页。截图工具只给收图的模型（模型目录里标了 vision 的；`catalog check --vision` 可以实测），其它模型只读页面文字。

## 连接（交付用的凭据）

交付会把分支推到远端仓库，还可以顺带开 PR。推送和开 PR 用的凭据叫"连接"，在看板「设置 → 连接」里管理，也可以用 `node src/cli.mjs cred` 管理。

- **不挂在项目上**：每次交付时，系统按"远端地址 + 谁点的交付"现场挑一份连接，审计里记下用的是哪一份。同一个组织下的项目不用逐个配置。
- **挑选顺序**：
  1. 点交付的人自己的连接。成员自己的连接只用于本人点的交付，别人点的交付不会借用；
  2. GitHub App；
  3. 部署级的令牌或 SSH 密钥；
  4. `.env` 里的 `GITHUB_TOKEN`（老部署）。

  同一档里有几份都匹配时，适用范围写得越具体越先（`acme/web` 先于 `acme/*`），再按新加的先。过期的连接、推送时被拒（权限不够）的连接会自动跳过，换下一份。连接的适用范围要和它在 GitHub 上实际授权的仓库对上。都用不上时，会试服务器上 git 自己配的凭据（一般没有）。想让 GitHub App 排在最前（PR 一律显示为 bot），管理员在「设置 → 连接」里改，或运行 `node src/cli.mjs user setting deploy.credential_order app_first`。
- **SSH 密钥只管推送**：开 PR 要调 GitHub 接口，系统会按同一仓库的 https 地址另挑一份 GitHub App 或令牌。
- **只支持在 GitHub 上开 PR**：GitLab、Gitea 和内网服务能推送，但不会自动开合并请求。
- **吊销只在本系统里生效**：GitHub 上的令牌或 App 私钥本身仍然有效，要作废请到 GitHub 上撤销。
- **存储**：连接加密存在状态库里（AES-256-GCM）。主密钥是 `.superintern/master.key`，第一次添加连接时生成；也可以用环境变量 `SUPERINTERN_MASTER_KEY` 提供。录入之后任何人都看不到值，页面上只显示末 4 位或密钥指纹。
- **交付前预检**：点交付时，看板会先查会用哪份连接、能不能推送，不通过就先问你。也可以在「设置 → 连接 → 检查一个远端」里单独查，或者运行 `node src/cli.mjs cred check <远端地址>`。
- **到期提醒**：填了到期日的连接，7 天内到期时会出现在主人的待办里；部署级的连接提醒管理员。GitHub 个人令牌没填到期日的话，检查一次之后系统会从 GitHub 读到并记下。
- **成员停用**：成员被停用时，这个成员自己的连接一并吊销。

### 用 GitHub App（仓库集中在一两个组织时推荐）

1. 在组织的 Settings → Developer settings → GitHub Apps → New GitHub App 新建一个 App：
   - Homepage URL：填组织主页，例如 `https://github.com/<组织名>`；
   - Webhook：取消勾选 Active；
   - Repository permissions：Contents、Pull requests 设为 Read and write，Metadata 保持 Read-only。要允许 AI 修改 `.github/workflows/` 下的文件，再把 Workflows 设为 Read and write；
   - Where can this GitHub App be installed：选 Only on this account。
2. 建好后记下 App ID，点 Generate a private key，下载 `.pem` 私钥文件。
3. 在 App 页面左侧点 Install App，装到组织上，选全部仓库或指定仓库。
4. 在看板「设置 → 连接」添加一条 GitHub App 连接，填 App ID、贴入 `.pem` 的全部内容。也可以在服务器上运行：

   ```bash
   node src/cli.mjs cred add github-app --name "<组织名> App" --app-id <App ID> --key-file <pem 文件路径> --repos '<组织名>/*'
   ```

   录入之后可以删掉 `.pem` 文件。

每次推送时，系统用私钥现签一个临时令牌：只覆盖这一个仓库，权限按这次动作给，1 小时后过期。系统不长期保存任何 GitHub 令牌。推送和 PR 会显示为这个 App。

### 推送护栏

不管用哪份连接，系统都只往远端推它自己的分支（`superintern/…` 和 `v0/…`）：

- 不推远端的默认分支，不强推，不删分支；
- 远端分支上有别人推的提交时，停下来说明原因，不覆盖；
- 唯一的例外：远端是空仓库时，会把项目起点推成默认分支，这样 PR 才有目标分支。推之前会再核对一次远端确实是空的。

合并永远由人在 GitHub 上点。GitHub 免费组织的私有仓库设不了分支保护，这道护栏由系统自己把守；如果以后升级到付费套餐，可以在 GitHub 上再设分支保护和必审规则，作为第二道防线。

## 联网源的凭据

私有的 npm / PyPI 源、内网镜像要认证时，凭据配在**源**上，由出网代理在请求里替工具带上；沙箱里的代码看不到它。

```bash
node src/cli.mjs sources cred add <源 id> --key-file <文件>            # 文件里是整个请求头的值，例如 "Bearer <令牌>"
node src/cli.mjs sources cred add <源 id> --key-file <文件> --basic    # 文件里是"用户名:密码"
```

- 源 id 在「设置 → 联网目录」里看。凭据加密存进库（和连接同一把主密钥），录入后谁都看不到原文。
- **默认只读**：配了凭据的源，只在读请求（GET、git clone）上带凭据；并且放行这个源的项目，它放行的所有源都只能读（POST、PUT 一类被拦下），免得任务里的代码借着凭据往外发东西。确实要写的源，加 `--allow-write`。
- 撤销：`sources cred revoke <凭据 id>`。

## 修改溯源：每处改动凭什么

不打开看板也能回答"这处改动是哪一步做的、依据契约的哪一条、谁下的指令、谁批准的"：

- **契约条款有编号**：每版契约切成一条条条款（C1、C2……）。条款文字不变，编号就不变；改了字的条款拿新编号。规划时每一步都记下它落实的是哪几条。
- **提交信息自带出处**：每个步骤的提交信息末尾有几行出处，git 和 GitHub 都把它们识别为 trailer：
  - `SuperIntern-Task` / `SuperIntern-Node`：任务与步骤；
  - `Contract`：契约第几版、谁在什么时候批准的；
  - `Clauses`：这一步落实的条款编号；
  - `Instructed-by`：给这一步下过指令或答过问的人；`Requested-by`：发起人；
  - `Trace`：看板上这一步的链接。只有在「设置 → 连接」里填了看板地址才写。
- **PR 正文带溯源表**：批准、发起、签收、交付各一行，再加一张表，列出每一步落实的条款、指令来源和对应的提交。在 GitHub 上用 squash 合并，这些信息也不会丢。
- **GitHub 账号**：每位成员可以在「成员」里填自己的 GitHub 账号和提交邮箱，也可以用 `node src/cli.mjs user git <id> --github <账号> --email <邮箱>`。管理员在「设置 → 连接」里打开 Co-authored-by 后，提交里会给批准人、下指令的人、发起人各加一行 Co-authored-by，GitHub 会显示他们的头像。这一项默认关，因为它在 GitHub 上的意思是“共同作者”。提交邮箱建议填 GitHub 的 noreply 地址。
- **从代码倒查**：任务的「改动」卡片里有个追溯框，填提交号（`HEAD~1` 这种写法也行）或 `文件:行号`，就能查出这处代码是哪一步做的、依据契约哪几条、谁说过什么、谁批准的。步骤详情里的「这一步的出处」是同一份信息。交付出去的仓库可以在命令行里查：

  ```bash
  node src/cli.mjs trace src/api/orders.mjs:42 --repo <仓库目录>
  ```

  `文件:行号` 查到的是最后改这一行的那个提交。没装 SuperIntern 的人直接看 `git log`，每个提交末尾的出处行就是同样的信息。
- 溯源表里有条款原文和答复摘录，仓库是公开的话，这些也会一起公开。
- 出处记录只能追加，不能删改。

## 备份与恢复

全部状态（任务、审计记录、花费账本、交接记录）都在 `.superintern/state.db` 这一个文件里。

- **自动备份**：守护进程默认每 24 小时备份一次，每 7 天另做一份每周备份。每份做完会当场以只读方式打开核验，核不过的不会留下。默认保留最近 7 份每日备份和 4 份每周备份。间隔可以改（0 = 关闭）：`node src/cli.mjs user setting deploy.backup_every_hours 12`。
- **例行检查**：守护进程每小时做一次快速完整性检查，每天做一次完整检查，外键也一起核对。结果写入审计记录。
- **手动备份**：`node src/cli.mjs db backup`；`db backups` 列出已有的备份。
- **恢复**：
  1. 先停掉看板、守护进程和在跑的任务。还有进程在写这个库时，命令会拒绝执行。
  2. 运行 `node src/cli.mjs db restore <备份文件>`。当前的库会先另存一份，之后再换上备份；如果备份来自旧版本，会顺带升级到当前版本。
  3. 运行 `db check --full` 核一遍。
- **主密钥不在备份里**：`.superintern/master.key` 不会进 `backups/`。把备份或库文件交给别人排查问题时，不会连带交出凭据。反过来，换机器恢复时要把 `master.key` 一起带过去，否则连接解不开，只能重新录入。建议把它另存一份在安全的地方。
- **不要在服务运行时直接复制 `state.db`**：WAL 模式下，最近的提交可能还在 `-wal` 文件里没写进主文件，直接复制会拿到不一致的副本。要用 `db backup`。
- **数据丢失窗口**：使用默认设置时，最多丢失最近一天的数据（取决于备份间隔）。要缩短，就调小间隔，或者把 `backups/` 目录同步到别的机器。只放在同一块盘上的备份防不了盘坏。

## 花费与预算

每一笔模型花费都记在一个人头上。默认记在发起任务的人头上，可以改成项目负责人或批准任务契约的人：`node src/cli.mjs user setting deploy.cost_attribution project_owner`。

预算一共四层，任何一层到了，在跑的那一步都会在下一次调用模型之前停下，并发一条事项给该拍板的人：

| 层 | 在哪里设 | 默认 |
|---|---|---|
| 任务 | 任务页「上限」 | 部署默认 |
| 项目 | 项目设置「预算与上限」 | 不设 |
| 每人每月 | 设置 → 花费（单个人），或 `deploy.person_budget_usd_month`（所有人的默认值） | 不设 |
| 整个部署每月 | `deploy.budget_usd_month` | 不设 |

- **预占**：每次调用模型之前，系统先在一个事务里，按最坏情况的花费预占额度，再连同各层闸门一起判断。几个任务同时在跑时，不会一起越过闸门。
- **月份**：按部署时区切分（见下文「时间与日历」；没设就是 UTC）。
- **公平调度**：`deploy.max_running_per_person` 限制每个人同时在跑的任务数，0 表示不限。守护进程会在不同人之间轮流拉起任务，一个人一次提了很多任务，也不会把别人的任务压在后面。
- **查看花费**：「设置 → 花费」显示每个人本月和上月的花费，以及近 14 天的走势。成员只看得到自己那一行。命令行用 `node src/cli.mjs user spend`。

## 运行状况与公告

- **设置 → 运行状况**（只有管理员看得到）：守护进程、容器运行时、状态库、备份、完整性检查、Node 内置的 SQLite、模型服务商、联网目录里的凭据、时区与节假日、运行期自检，每一项标「正常 / 注意 / 有问题」，有问题的排在前面，并写了要做什么。有「注意」或「有问题」时，侧栏这一项带一个小圆点。
- **运行期自检**：守护进程定期核对几条应该一直成立的事：每个没结束的任务说得出在等谁、花费越过上限时闸门确实拦过、任务的工作区没有罩住状态库和主密钥、占着任务的进程还活着等。有一条不成立就合并成一条通知发给管理员。命令行：`node src/cli.mjs invariants`（加 `--run` 当场查一遍）。
- **值得看一眼的变化**：例如某个模型的上下文窗口偏小、有步骤反复撞自动整理线、原有测试被改弱的次数多起来了。点「知道了」收起；情况消失后再出现会重新提醒。
- **公告**：同一页下方，发给所有人，看板顶部一条横幅。
- **存活探针**：`GET /healthz` 不用登录，进程在、库能读就回 `{"ok":true}`，否则 503。

## 时间与日历

「设置 → 时间与日历」里，管理员设**部署时区**（如 `Asia/Shanghai`）和**节假日与调休**；命令行是 `node src/cli.mjs calendar`。

- 路由表里的超时「1bd」（一个工作日）、值班表几点交接、月度预算哪天翻篇，都按部署时区算。没设就按 UTC，中国的部署会差 8 小时，运行状况会提示。
- 节假日一行一条：`2026-10-01..2026-10-07 国庆`；调休补班写 `2026-10-11 班`。表里的日子快用完时运行状况会提示补下一年。
- 每个人可以在同一页设自己的时区，只影响他看到的时刻。
- 值班代班（某几天整天由某人值）在决策路由的值班表下面添加，或 `routing swap`。

## 日志与追踪

- **给人看的日志**：守护进程写 `.superintern/logs/daemon.log`，每个任务进程写 `.superintern/logs/<任务>-<时刻>.log`，看板上「日志」按钮显示的就是后者的尾部。
- **结构化日志**：守护进程、看板和任务进程还会写一份 JSON 行日志，在 `.superintern/logs/jsonl/` 下，每个进程每天一个文件。每行带这些字段：
  - 时间、级别、原文；
  - 进程种类与 pid；
  - 任务 id 与步骤 id；
  - trace id：守护进程每一拍起一个，它拉起的任务进程沿用同一个。所以同一次拉起的守护进程日志和任务日志，可以按 trace id 对起来。
- **自动清理**：守护进程每天做一次。
  - 删掉超过保留天数的任务日志和 JSON 行日志（默认 14 天，可改：`node src/cli.mjs user setting deploy.log_keep_days 30`）。
  - `daemon.log` 超过 10 MB 时，复制成 `daemon.log.1`，原文件清零。
  - 已合并或已归档的任务，删掉工作区里的依赖目录（`node_modules`、`.venv` 等），并把腾出的空间记进审计。不想删就设 `deploy.clean_merged_deps false`。任务被重新打开时，依赖会重新安装。
- **密钥不落盘**：写进库、日志、模型调用录制的文字，和发出去的通知，都会先去掉密钥，换成 `[redacted]`。认得出的有三类：
  - 常见的密钥形状：API key、GitHub 令牌、AWS key、私钥、JWT 等；
  - `Authorization` 请求头和网址里的口令，只去掉值、保留前缀；
  - 按值认：`.env` 里名字以 `_KEY`、`_TOKEN`、`SECRET`、`PASSWORD` 等结尾的变量的值，以及「设置 → 连接」里录入的凭据。
  - 在对话里贴的 key 也会在存进库之前被去掉，代理和模型都看不到它。密钥请放进「设置 → 连接」或 `.env`，不要贴进对话。
- **OTLP 追踪导出（可选）**：设了 OpenTelemetry 的标准环境变量 `OTEL_EXPORTER_OTLP_ENDPOINT`（或 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`）才会导出，按 OTLP/HTTP JSON 发送。
  - 每个执行步骤一个 span，每次模型调用一个子 span。
  - 模型调用的属性按 OTel GenAI 语义约定填写：模型、token 用量、花费。
  - **不导出提示词和回复内容。**
  - 收集端要认证时，用 `OTEL_EXPORTER_OTLP_HEADERS` 配置请求头。
  - 设 `OTEL_SDK_DISABLED=true` 关闭导出。

## 升级

1. **备份**：迁移前系统会自动把整个库备份到 `.superintern/backups/`。想自己再留一份，就在升级前运行 `node src/cli.mjs db backup`。
2. **换代码**：替换代码，或者 `git pull`。
3. **迁移**：执行一次 `node src/cli.mjs init`（或者任何一条命令）。系统会按 `PRAGMA user_version` 逐级跑迁移，迁移不会删数据。每一级迁移和版本号写在同一个事务里，中途失败就停在原来的版本，库不会只改了一半。如果是已有数据不满足新版本的约束，报错会写明是哪张表、哪条约束、哪几行。
4. **更新镜像**：如果新版本换了沙箱镜像的 tag，重新跑一次 `setup`，把缺的镜像建出来。

**从 0.3.x 升到 0.4.0 要知道的：**

- **安全修复，沙箱容器会重建**：沙箱里的代码原来能往工作区的 `.git` 写钩子，下次宿主机上的 git 操作就会执行它。现在 `.git` 对沙箱只读，宿主机上的 git 不执行仓库里的钩子和 fsmonitor。旧规则起的容器会被自动删掉重建；项目自己的 git 钩子（husky、pre-commit 等）在 SuperIntern 做的提交里不再执行。
- **联网目录里工具配置的凭据不再放进沙箱**：以前放行过这个源的项目，任务里的代码读得到这些凭据。建议先在那个源上换一个新凭据，再按上文「联网源的凭据」配；运行状况会列出哪些源要处理。没处理之前，要认证的安装会失败。
- **库会升级并收紧约束**：迁移中途已有数据不满足新约束时，整个迁移回滚、库停在原来的版本，报错写明哪张表、哪条约束、哪几行。迁移前系统会先自动备份。
- **默认打开的几样**：验收员与执行器同一家时换一家（`.env` 里有多家 key 时花费会跟着变）、上下文整理（120k）、每 24 小时备份、日志保留 14 天、已合并任务的依赖目录自动删除。上文各节写了怎么改。
- **令牌**：新签的命令行令牌默认 90 天过期（`deploy.cli_token_days`，0 = 不过期）；升级前签的不受影响。团队模式的浏览器 cookie 里现在放的是会话，不再是令牌本身。
- 设了 `HTTPS_PROXY` 的机器，模型调用也会走这个代理（`SUPERINTERN_IGNORE_ENV_PROXY=1` 关掉）。

## 日常命令

```bash
node src/cli.mjs digest                 # 我的待办（谁答、等谁、到期）
node src/cli.mjs questions              # 开放的问题一览
node src/cli.mjs answer <qid> "..."     # 答复
node src/cli.mjs say <task> "..."       # 修正 / 新指令 / 补充信息
node src/cli.mjs signoff <task> --accept | --reject "理由"
node src/cli.mjs replay <task>          # 只凭审计记录和状态库复盘
node src/cli.mjs sandbox --reap         # 清理遗留的容器和派生镜像
node src/cli.mjs bind                   # 三档各绑了什么；bind set heavy=<服务商/模型> 改
node src/cli.mjs bind role verifier <服务商/模型>   # 某个角色单独绑；bind fallback standard=<服务商/模型> 配备用
node src/cli.mjs user spend             # 每个人本月花了多少
node src/cli.mjs invariants             # 运行期自检的结果
node src/cli.mjs db check               # 状态库完整性检查；db stats 看体量与慢语句
node src/cli.mjs endpoint               # 服务商与 key 填没填；endpoint test <id> 测试连接
node src/cli.mjs catalog check          # 模型目录漂移检查（守护进程默认每 7 天自动查一次）
```
