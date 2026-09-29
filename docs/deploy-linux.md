# Linux 部署（含 WSL2）

Windows 部署见 [deploy.md](deploy.md)。本页讲 Linux 主机和 WSL2 的安装步骤，下面列出已验证的环境：

| 项 | 验证环境 |
|---|---|
| 发行版 | Ubuntu 24.04 LTS（WSL2） |
| init | systemd（`/etc/wsl.conf` 里 `[boot] systemd=true`） |
| Node | 24.x（官方 tarball） |
| 容器运行时 | 发行版内原生 docker-ce（cgroup v2，systemd 驱动，overlayfs）；也验证过 Docker Desktop 的 WSL 集成 |

## 前置

- Node **≥ 22.13**（需要不带 flag 就能用的 `node:sqlite`）。apt 里的 nodejs 版本太老，请用官方 tarball 或 NodeSource。
- git。
- 容器运行时：docker（原生 dockerd 或 Docker Desktop 的 WSL 集成）或 podman。**跑守护进程的用户必须能直接访问 docker socket**，也就是要在 `docker` 组里。

## 安装

```bash
# 1. 代码放在 Linux 自己的文件系统上
#    WSL2 下不要放在 /mnt/c、/mnt/d：drvfs 的属主、权限语义和性能都不对
tar xzf superintern-v0.1.0-linux.tar.gz && cd superintern-v0.1.0
#    （或者 git clone <本仓库> ~/superintern && cd ~/superintern）

# 2. 检查前置条件、生成 .env（权限 600）、构建沙箱镜像
scripts/setup.sh

# 3. 填 key。检查时只看填没填，不要打印值：grep -c '^DEEPSEEK_API_KEY=.' .env
nano .env

# 4. 建库、签发 CLI 令牌（唯一的明文副本在 .superintern/cli-token，权限 600）、按已填的 key 选模型
node src/cli.mjs init --name <你的名字>

# 5. 跑一遍测试（container 与 egress 两套需要 docker 在跑）
node tests/run.mjs --all

# 6. 守护进程 = systemd 用户单元：开机即起，退出 30 秒后拉起，日志在 .superintern/logs/daemon.log
scripts/daemon.sh install          # 团队模式：scripts/daemon.sh install --public-url https://si.example.lan
scripts/daemon.sh status
```

只想临时跑一下、不装单元的话，用 `scripts/start.sh` 在前台启动即可。

单元文件在 `~/.config/systemd/user/superintern-daemon.service`。`install` 会顺便执行 `loginctl enable-linger`，否则注销或 SSH 断开时，用户实例会连同守护进程一起停掉。

### 主机够不着 Docker Hub 时

构建沙箱镜像需要拉 `node:22-slim` 并联网装 apt 包（约 400 MB，含 Chromium）。如果目标机器联不上，或者下载太慢，就从一台能联网的机器上把镜像打包，再搬过来：

```bash
# 在能联网的机器上（先在那边跑一次 setup，把镜像建好）
docker save node:22-slim mitmproxy/mitmproxy:latest superintern/sandbox:v0.1 superintern/sandbox:v0.3-python -o images.tar
# 在目标机器上
docker load -i images.tar
```

### 单元里有意为之的三处

- **`KillMode=process`**：
  - **为什么**：守护进程按 `--iterations` 到点自然退出，再由 `Restart=always` 拉起，这是有意的定期重生。它启动的 run 子进程是 detached 的，要活过守护进程的一次寿命。默认的 control-group 模式会在每次重生时把正在跑的任务一起杀掉。
  - **代价**：`daemon.sh stop` 不会停止正在跑的任务。要停任务，请用 CLI 的 pause / abort。
- **`ExecStartPre=scripts/wait-docker.sh`**：
  - **为什么**：用户单元看不见系统单元，所以写 `After=docker.service` 没有用。发行版一启动，单元就起来了，这时 docker 可能还没就绪。
  - **做法**：启动前先等运行时可用，最多等 3 分钟。
- **看板只绑 127.0.0.1**：
  - **远程怎么看**：走 SSH 隧道 `ssh -L 7357:127.0.0.1:7357 <host>`，或者用团队模式（[deploy-team.md](deploy-team.md)）。

### 先把用户加进 docker 组，再装单元

systemd 的用户管理器（`systemd --user`）在用户第一次登录时启动，它的附加组在那一刻就定死了，之后由它启动的服务都继承这组。如果用户是在用户实例已经运行之后才加进 `docker` 组的，就会出现下面的情况：

- `daemon.sh install` 起的守护进程拿不到 socket，报 `permission denied ... docker.sock`；
- 但在交互 shell 里 `docker ps` 却正常。

判断方法：`grep Groups /proc/$(pgrep -u $USER -x systemd | head -1)/status` 的输出里有没有 docker 组的 gid。

如果没有，就重启用户实例：注销再登录（linger 要先关掉，才会真的重启）。WSL2 下直接 `wsl --shutdown`。

**按这个顺序就不会遇到**：先把用户加进 docker 组，重新登录，再装单元。

## WSL2 特有

- **`/etc/wsl.conf`**：写上 `[boot] systemd=true` 和 `[user] default=<用户>`，然后 `wsl --shutdown` 让它生效。
- **容器运行时建议装在发行版里**（docker-ce，`systemctl enable --now docker`）：
  - 这样不依赖 Windows 侧的任何软件，发行版原样搬到真 Linux 主机也不用改。
  - Docker Desktop 的 WSL 集成也能用，但它要求 Docker Desktop 在 Windows 登录会话里开着。上面「docker 组」和「开机时序」两个问题，都来自这个集成层。
  - 两者不要同时开：集成层会往 `/usr/bin/docker` 放一个链接。装 docker-ce 之前，先关掉集成，并删掉悬空的链接。
- **拉不到镜像**：在 NAT 模式下，WSL 可能够不着 Windows 上的本机代理，发行版里就连不上 Docker Hub。这时按上面的 save / load 搬镜像。
- **常驻**：发行版不会随 Windows 登录自动启动，而且最后一个 wsl.exe 会话退出后大约 8 秒，发行版就会整个停掉，开着 systemd 也一样，守护进程会跟着停。
  - **做法**：在 Windows 侧挂一个不退出的会话 `wsl.exe -d Ubuntu-24.04 --exec sleep infinity`（用隐藏窗口启动）。用一个登录触发的计划任务跑这条命令，自动启动和常驻两个问题就都解决了。
  - 真 Linux 主机没有这个问题。
- **访问看板**：Windows 侧可以直接打开 http://127.0.0.1:7357/（WSL2 会转发 localhost）。**不要再同时装 Windows 计划任务版的守护进程**：两个会抢端口，还会各自维护一份库。
- **容器以宿主的 uid:gid 运行**（`--user`）：
  - 这是 Linux 宿主和 Windows 之间唯一的代码路径差异。
  - 没有它，容器写进工作区（bind mount）的文件属主会是 root:root，之后守护进程 `git add` 或清理工作区都会报 EACCES。

## 日常

```bash
scripts/daemon.sh status | start | stop | uninstall
tail -f .superintern/logs/daemon.log
node src/cli.mjs sandbox --reap        # 清理遗留的容器
```

## 已知限制

- **podman 和 rootless docker 尚未验证**。container 测试里关于 cgroup 的断言，在 rootless 下可能表现不同。
- **代理镜像会越积越多**：出网代理镜像每个任务生成一个 `superintern/sandbox:ca-*` 标签，不会自动清理。它们共享层，每个只多几百 KB，但列表会越来越长。清理方法：

  ```bash
  docker images --format '{{.Repository}}:{{.Tag}}' superintern/sandbox | grep ':ca-' | xargs docker rmi
  ```
