#!/usr/bin/env bash
# 前台启动看板 + 守护进程（Linux）/ Start the web board + daemon in the foreground (Linux)
#   scripts/start.sh                                  单机：只你自己用，开 http://127.0.0.1:7357（远程用 ssh -L 7357:127.0.0.1:7357）
#   scripts/start.sh --public-url https://si.example.lan   团队模式（放在 HTTPS 反向代理之后，见 docs/deploy-team.md）
# 想开机即起、崩了自动拉：scripts/daemon.sh install（见 docs/deploy-linux.md）
set -euo pipefail
cd "$(dirname "$0")/.."
port=7357; url=""
while [ $# -gt 0 ]; do case "$1" in --port) port="$2"; shift 2;; --public-url) url="$2"; shift 2;; *) echo "不认识的参数：$1"; exit 2;; esac; done
args=(--disable-warning=ExperimentalWarning src/cli.mjs web --daemon --port "$port")
[ -n "$url" ] && args+=(--team --public-url "$url")
exec node "${args[@]}"
