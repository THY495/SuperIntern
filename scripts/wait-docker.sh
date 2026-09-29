#!/bin/sh
# 等容器运行时可用（最多 3 分钟），给 systemd 单元的 ExecStartPre 用（scripts/daemon.sh）。
# WSL2 + Docker Desktop 集成下：发行版一启动用户单元就起，此时 /usr/bin/docker 还没被集成层链上，
# 守护进程首轮拉起的 run 当场 "spawnSync docker ENOENT"，任务进 5 分钟退避。等不到就非零退出，Restart 再来。
i=0
while [ "$i" -lt 90 ]; do
  if docker version >/dev/null 2>&1 || podman version >/dev/null 2>&1; then exit 0; fi
  i=$((i + 1))
  sleep 2
done
echo "容器运行时 3 分钟内没就绪（docker / podman 都不应答）" >&2
exit 1
