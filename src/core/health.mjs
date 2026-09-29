// 运行健康：容器运行时在不在。
//
// 不做这层时：Docker Desktop 掉了，看板一个字没提，守护进程照常每拍去拉任务 —— 每次起沙箱都失败，
// 按退避表（5 / 15 / 45 / 90 分钟）烧掉四次重试之后**放弃、转成等人**。Docker 恢复之后这些任务不会自己接着跑，
// 可它们本来什么都没做错。所以两件事：
//   1. 看板上说出来（谁都看得见：成员也得知道"为什么没动静"）；
//   2. 运行时不在的时候，守护进程**不去拉**要用沙箱的那几步（不烧重试次数），恢复了自己接着拉。
//
// 探测是异步的、带超时（Windows 上 daemon 没起时 docker CLI 可能卡几秒）；结果缓存，调用方拿到的永远是上一次的结论，
// 不会因为探测把请求卡住。

import { execFile } from 'node:child_process';

const probeOne = (cli, timeoutMs) => new Promise((resolve) => {
  execFile(cli, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
    const v = String(stdout ?? '').trim();
    if (!err && v) return resolve({ ok: true, cli, version: v });
    const why = String(stderr || err?.message || '').trim().split('\n')[0].slice(0, 200) || '没有应答';
    resolve({ ok: false, cli, why: err?.code === 'ENOENT' ? `没装 ${cli}` : why });
  });
});

/** 探测一次：docker 优先、podman 其次；都不行就报第一个的原因（通常是 docker）。 */
export async function probeRuntime({ candidates = ['docker', 'podman'], timeoutMs = 8000 } = {}) {
  const tried = [];
  for (const cli of candidates) {
    const r = await probeOne(cli, timeoutMs);
    if (r.ok) return { ...r, checkedAt: Date.now() };
    tried.push(r);
  }
  const first = tried.find((t) => !/^没装/.test(t.why)) ?? tried[0];
  return { ok: false, cli: first?.cli ?? null, why: first?.why ?? '没有可用的容器运行时', checkedAt: Date.now() };
}

/**
 * 带缓存的健康状态。`current()` 立刻返回上一次的结论（第一次之前是 null = 还不知道），
 * 过期了顺手在后台再探一次。`refresh()` 等这一次探完（守护进程每拍用它）。
 */
export function makeRuntimeHealth({ ttlMs = 30_000, probe = probeRuntime } = {}) {
  let last = null, pending = null, downSince = null;
  const refresh = () => {
    // downSince：从哪一刻起不在（页面上写"发现于几点"：没有时间就判断不了是不是已经等太久了）
    const keep = (r) => { downSince = r.ok ? null : (downSince ?? r.checkedAt); last = { ...r, downSince }; return last; };
    if (!pending) pending = probe().then(keep, (e) => keep({ ok: false, why: String(e.message), checkedAt: Date.now() }))
      .finally(() => { pending = null; });
    return pending;
  };
  return {
    current() { if (!last || Date.now() - last.checkedAt > ttlMs) refresh(); return last; },
    async fresh() { if (!last || Date.now() - last.checkedAt > ttlMs) await refresh(); return last; },
    refresh,
  };
}
