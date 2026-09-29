#!/usr/bin/env bash
# 首次安装（Linux / macOS）/ First-time setup
#   scripts/setup.sh [--name <管理员名字>]
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then echo "没有 Node.js：请先装 Node 22.13 或更新版本 / Node.js not found: install Node >= 22.13"; exit 1; fi
v="$(node -p 'process.versions.node')"; maj="${v%%.*}"; rest="${v#*.}"; min="${rest%%.*}"
if [ "$maj" -lt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -lt 13 ]; }; then echo "Node $v 太旧，需要 >= 22.13 / Node $v is too old, need >= 22.13"; exit 1; fi
exec node scripts/setup.mjs "$@"
