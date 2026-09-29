# 沙箱镜像 —— agent 的"手"住在这里面。
#
# **工具链必须构建期烘焙**。
# 运行期容器在 `--network none` 上，装不了任何东西 —— 那正是断网要挡的行为。
# 所以"镜像里有什么"直接等于"agent 在沙箱里能干什么"，这是一份需要产品化的清单，
# 不是随手挑的基础镜像。
#
# 清单按实际需要定：node（跑测试）、git（工作区是 repo）、
# 加上真正只读的那批 coreutils。没有 python、没有 npm 全局包 —— 用不上的工具
# 就是白送的攻击面。
#
# 加了 curl：接上出口代理之后，"能不能出网"成了一个需要**独立于 node** 验证的
# 事实。全靠 node 的话，一个 undici 特有的坑（它不读 HTTP_PROXY）就会被读成
# "沙箱没网"。多一个走不同机制的工具，是排障能力，不是多余。

FROM node:22-slim

# ca-certificates + update-ca-certificates（在 ca-certificates 包里）是派生镜像
# 往系统信任库装 CA 的前提（各工具认 CA 的机制互不相通，
# 靠环境变量逐个覆盖必漏）。
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# 工作区两个视图：rw 给写命令，ro 给声明为只读的命令（见 src/core/container.mjs）。
# 挂载点要预先存在 —— 根文件系统是只读的，运行期建不出来。
RUN mkdir -p /workspace /workspace-ro

# 工作区是 bind mount，属主由宿主决定，容器里的 uid 多半对不上。
# 不加这句，容器内每一条 git 命令都会 fatal: detected dubious ownership。
# 这不是放宽安全边界：边界是容器本身，`safe.directory` 只影响 git 自己的属主检查。
RUN git config --system --add safe.directory /workspace \
 && git config --system --add safe.directory /workspace-ro

WORKDIR /workspace
