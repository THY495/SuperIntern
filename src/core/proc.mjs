// 进程层的小工具：守护进程（谁该拉起）与编排器（我能不能开跑）都要问"那个 pid 还活着吗"。
// 单独一个文件，免得编排器为了一个三行函数去依赖守护进程（守护进程已经依赖项目层，项目层依赖编排器 —— 会成环）。

/** pid 还活着吗。⚠️ 只查存在，不查是不是编排器；pid 被系统复用会误判"还活着"，那种情形靠人看看板。 */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
