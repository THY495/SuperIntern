#!/usr/bin/env bash
# SuperIntern 守护进程（web --daemon）的 Linux systemd 用户单元：开机即起、崩了自动拉、日志落 .superintern/logs/daemon.log。
# 与 scripts/daemon.ps1 一一对应（那边是 Windows 计划任务）。
#
#   scripts/daemon.sh install [--port 7357] [--iterations 40] [--public-url https://<内网域名>]
#   （给了 --public-url 就是团队模式：多人各自登录，放在 HTTPS 反向代理之后，见 docs/deploy-team.md）
#   （档位绑定不在这里：常态绑定在库里，看板"绑定"页或 node src/cli.mjs bind set 改；守护进程起的子进程自己读库）
#   scripts/daemon.sh start | stop | status | uninstall
#
# 为什么是用户单元（systemctl --user）而不是系统单元：守护进程要用的是**这个用户**的 CLI 令牌、
# 这个用户的 .env、这个用户的 docker 组成员资格；跑在别的 uid 下这三样都对不上。
# 用户单元默认随登录会话起落，所以 install 顺手开 linger（loginctl enable-linger）——
# 没有它，SSH 断开守护进程就跟着死，和当初"寄生在编辑器预览面板里"是同一种错。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME='superintern-daemon'
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME.service"
LOG_DIR="$ROOT/.superintern/logs"
LOG="$LOG_DIR/daemon.log"

ACTION="${1:-status}"; shift || true
PORT=7357
ITERATIONS=40
PUBLIC_URL=
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --iterations) ITERATIONS="$2"; shift 2 ;;
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺 $1" >&2; exit 1; }; }

case "$ACTION" in
  install)
    need systemctl; need node; need loginctl
    # systemd 得是 PID 1 且用户实例可达；WSL2 里要在 /etc/wsl.conf 打开 [boot] systemd=true 再 wsl --shutdown。
    systemctl --user show-environment >/dev/null 2>&1 \
      || { echo "systemd 用户实例不可达（WSL2：/etc/wsl.conf 加 [boot] systemd=true，然后 wsl --shutdown）" >&2; exit 1; }
    NODE="$(command -v node)"
    mkdir -p "$LOG_DIR" "$UNIT_DIR"
    ARGS="src/cli.mjs web --daemon --port $PORT --iterations $ITERATIONS"
    # 团队模式：仍只监听 127.0.0.1（反向代理和看板在同一台机器上），对外地址给 Host 放行与 Secure cookie 用
    [ -n "$PUBLIC_URL" ] && ARGS="$ARGS --team --public-url $PUBLIC_URL"
    # 只绑 127.0.0.1、身份 = 本机 CLI 令牌，与手动起 `node src/cli.mjs web --daemon` 完全同一条路。
    # --iterations 到点自然退出，Restart=always 再拉起：这是有意的定期重生（同 daemon.ps1）。
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=SuperIntern daemon (web dashboard + task daemon)
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
# 用户单元看不见系统单元，After=docker.service 在这里不起作用。WSL2 + Docker Desktop 集成下：发行版一启动
# 单元就起，此时 /usr/bin/docker 还没被集成层链上 —— 守护进程首轮拉起的 run 当场 "spawnSync docker ENOENT"，
# 任务进 5 分钟退避。所以起之前等 docker 可用（最多 3 分钟；等不到就退出，Restart 再来）。
ExecStartPre=$ROOT/scripts/wait-docker.sh
ExecStart=$NODE $ARGS
Restart=always
RestartSec=30
StandardOutput=append:$LOG
StandardError=append:$LOG
# ⚠️ 必须是 process，不能是默认的 control-group：守护进程每 --iterations 轮到点自然退出、由 Restart 拉起
# （有意的定期重生），而它起的 run 子进程是 detached 的、要活过守护进程的一次寿命（launcher.mjs）。
# control-group 会在每次重生时把正在跑的任务连锅端掉 —— 每 10 分钟杀一次所有任务。
# 代价：stop 单元不停正在跑的任务，与 Windows 计划任务的语义一致；要停任务用 cli 的 pause / abort。
KillMode=process
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT_NAME" >/dev/null
    loginctl enable-linger "$USER" 2>/dev/null || echo "⚠ enable-linger 失败：注销后守护进程会停。手动：sudo loginctl enable-linger $USER"
    echo "已安装用户单元 $UNIT_NAME（开机即起；退出 30 s 后自动拉起），已启动。单元：$UNIT_FILE；日志：$LOG"
    ;;
  uninstall)
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload
    echo "已卸载 $UNIT_NAME"
    ;;
  start) systemctl --user start "$UNIT_NAME"; echo "已启动" ;;
  stop) systemctl --user stop "$UNIT_NAME"; echo "已停止" ;;
  status)
    if [ ! -f "$UNIT_FILE" ]; then echo "未安装。安装：scripts/daemon.sh install"; exit 0; fi
    systemctl --user --no-pager status "$UNIT_NAME" 2>/dev/null | sed -n 1,5p || true
    [ -f "$LOG" ] && tail -n 3 "$LOG"
    ;;
  *) echo "用法：scripts/daemon.sh install|uninstall|start|stop|status [--port N] [--iterations N]" >&2; exit 2 ;;
esac
