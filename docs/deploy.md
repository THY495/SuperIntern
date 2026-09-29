# 部署

同一份代码支持三种部署形态：

| 形态 | 守护进程怎么常驻 | 说明 |
|---|---|---|
| Windows 10/11 + Docker Desktop | 计划任务：`scripts/daemon.ps1` | 本页 |
| Linux 主机 | systemd 用户单元：`scripts/daemon.sh` | [deploy-linux.md](deploy-linux.md) |
| WSL2 | 同 Linux，另外要在 Windows 侧挂一个不退出的 wsl 会话 | [deploy-linux.md](deploy-linux.md#wsl2-特有) |

多人从各自电脑登录（团队模式），见 [deploy-team.md](deploy-team.md)。

## 共同前置

- Node **≥ 22.13**（需要不带 flag 就能用的 `node:sqlite`；在 24.x 上验证过）和 git。
- 容器运行时：docker 或 podman（podman 与 rootless docker 尚未验证）。跑守护进程的用户要能直接访问 docker socket。
- 首次安装：`scripts/setup.ps1` 或 `scripts/setup.sh`。它会做这些事：
  - 检查上面的前置条件；
  - 从 `.env.example` 生成 `.env`；
  - 构建沙箱镜像 `superintern/sandbox:v0.1` 和 `superintern/sandbox:v0.3-python`；
  - 拉取出网代理镜像 `mitmproxy/mitmproxy`。

  每个任务的出网代理镜像 `superintern/sandbox:ca-*` 会在第一次用到时自动构建，可以用 `node src/cli.mjs sandbox --reap` 清理。
- `.env`（权限 600，不要提交）：
  - **模型 key**：至少填一家厂商的 key。
  - **`GITHUB_TOKEN`**：只在交付时开 PR 用。
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

## 升级

1. **备份**：先备份 `.superintern/state.db`。库是 WAL 模式，要连同 `-wal` 和 `-shm` 两个文件一起备份。
2. **换代码**：替换代码，或者 `git pull`。
3. **迁移**：执行一次 `node src/cli.mjs init`（或者任何一条命令）。系统会按 `PRAGMA user_version` 逐级跑迁移，迁移不会删数据。
4. **更新镜像**：如果新版本换了沙箱镜像的 tag，重新跑一次 `setup`，把缺的镜像建出来。

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
node src/cli.mjs endpoint               # 服务商与 key 填没填；endpoint test <id> 测试连接
node src/cli.mjs catalog check          # 模型目录漂移检查（守护进程默认每 7 天自动查一次）
```
