// 看运行效果（最小版）：任务级验收通过后，在同一个沙箱里把服务起起来、按约定的几页截图，
// 挂到签收事项与任务页上。签收人不肯点交付，常常就卡在一件事上 —— 看不到它跑起来是什么样。
//
// 约定（由 agent 维护，人不用配）：仓库根的 `si-preview.json`
//   {
//     "start": ["node backend/server.js", "npm run dev --prefix frontend -- --port 5173 --host 127.0.0.1"],
//     "url":   "http://127.0.0.1:5173",
//     "ready": ["http://127.0.0.1:8000/api/health"],        // 选填：截图前必须应答（2xx/3xx）的地址，典型是后端
//     "seed":  ["python backend/seed.py"],                  // 选填：服务起来之后、截图之前跑的样例数据命令
//     "pages": [{ "path": "/", "title": "首页" }, { "path": "/todos", "title": "待办列表" }]
//   }
// start / seed 每条一个进程（不经 shell、与验收命令同一条规矩）；url / ready 只许本机；pages 至多 6 页。
//
// 截图用 chromium 自带的 `--headless --screenshot`（沙箱镜像 v0.3-python 里装着）：只看页面加载后的样子，不点、不填。
// 失败不拦签收 —— 截不出来就在签收页上照实说为什么，人照样能签。
//
// 几条要点：
//   - 只看前端地址"有没有应答"（curl 不带 -f，500 也算）不够：后端起不来照样报"截到了"，截到的是一张报错页。
//     所以 url 与 ready 里每个地址都要 2xx/3xx 才开始截；截完再查一遍，中途死掉的也照实说。
//   - 空库截图证明不了功能：seed 让 agent 在截图前放几条样例数据。
//   - 截到了不等于页面是好的：每页再取一次渲染后的 DOM，出现常见报错字样（Failed to fetch、Internal Server Error、
//     Traceback……）或几乎是空白，就在那张图上挂一条"可能有问题"。这是提示不是判决 —— 判断仍是签收人的。
//   - chromium 默认会在后台连 Google（会被出网代理一次次挡下）：关掉后台联网相关的功能。

import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describeChanges, discardChanges } from './workspace.mjs';

export const PREVIEW_FILE = 'si-preview.json';
const OUT_DIR = '.si-preview';           // 截图先落在工作区里（容器能写的地方），再搬到 home/previews；已在 git exclude 里
const MAX_START = 3, MAX_PAGES = 6, MAX_READY = 4, MAX_SEED = 3;

const argvOf = (s) => (Array.isArray(s) ? s.map(String) : String(s).trim().split(/\s+/)).filter(Boolean);
const localUrl = (raw) => { try { const u = new URL(String(raw ?? '')); return ['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol === 'http:' ? u : null; } catch { return null; } };

/**
 * 仓库看起来有界面吗：根目录或第一层目录里的 package.json 依赖了常见前端框架 / 构建工具，或者有 index.html。
 * 只用来决定"没写 si-preview.json 要不要补一步"（有前端的任务不写它，签收人就看不到页面，只能打回）。
 */
const UI_DEPS = ['vite', 'react', 'react-dom', 'vue', 'svelte', 'next', 'nuxt', 'preact', '@angular/core', 'solid-js', 'astro', 'webpack', 'parcel'];
export function hasUi(dir) {
  const dirs = ['.', ...(() => { try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map((d) => d.name); } catch { return []; } })()];
  for (const d of dirs) {
    if (existsSync(join(dir, d, 'index.html'))) return true;
    const pj = join(dir, d, 'package.json');
    if (!existsSync(pj)) continue;
    try { const j = JSON.parse(readFileSync(pj, 'utf8')); const deps = { ...j.dependencies, ...j.devDependencies };
      if (UI_DEPS.some((k) => k in deps)) return true; } catch { /* 坏的 package.json 不算 */ }
  }
  return false;
}

/** 读并校验 si-preview.json。返回 { spec } 或 { error }；文件不存在返回 null。 */
export function readPreviewSpec(dir) {
  const f = join(dir, PREVIEW_FILE);
  if (!existsSync(f)) return null;
  let j;
  try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return { error: `${PREVIEW_FILE} 不是合法的 JSON：${e.message}` }; }
  const start = (Array.isArray(j.start) ? j.start : j.start ? [j.start] : []).map(argvOf).filter((a) => a.length);
  if (!start.length) return { error: `${PREVIEW_FILE} 缺 start：怎么把服务起起来（每条一个后台进程）` };
  if (start.length > MAX_START) return { error: `${PREVIEW_FILE} 的 start 最多 ${MAX_START} 条` };
  const url = localUrl(j.url);
  if (!url) return { error: `${PREVIEW_FILE} 的 url 只能是沙箱里的本机地址（http://127.0.0.1:端口）` };
  const readyRaw = Array.isArray(j.ready) ? j.ready : j.ready ? [j.ready] : [];
  if (readyRaw.length > MAX_READY) return { error: `${PREVIEW_FILE} 的 ready 最多 ${MAX_READY} 个地址` };
  const ready = [];
  for (const r of readyRaw) { const u = localUrl(r); if (!u) return { error: `${PREVIEW_FILE} 的 ready 里「${r}」不是本机地址（http://127.0.0.1:端口/路径）` }; ready.push(u.href); }
  const seed = (Array.isArray(j.seed) ? j.seed : j.seed ? [j.seed] : []).map(argvOf).filter((a) => a.length);
  if (seed.length > MAX_SEED) return { error: `${PREVIEW_FILE} 的 seed 最多 ${MAX_SEED} 条` };
  const pages = (Array.isArray(j.pages) && j.pages.length ? j.pages : [{ path: '/', title: '首页' }])
    .map((p) => (typeof p === 'string' ? { path: p, title: p } : { path: String(p.path ?? '/'), title: String(p.title ?? p.path ?? '/') }));
  if (pages.length > MAX_PAGES) return { error: `${PREVIEW_FILE} 的 pages 最多 ${MAX_PAGES} 页` };
  if (pages.some((p) => !p.path.startsWith('/'))) return { error: `${PREVIEW_FILE} 的 pages 里 path 要以 / 开头` };
  return { spec: { start, url: url.origin, ready: [`${url.origin}/`, ...ready.filter((r) => r !== `${url.origin}/`)], seed, pages, waitMs: Math.min(Number(j.waitMs) || 3000, 15000) } };
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;   // sh 单引号转义：只用来把 argv 原样交给 setsid，不做任何展开

// 关掉 chromium 的后台联网（组件更新、翻译、安全浏览、指标上报……）：沙箱出网只放行白名单，它们只会撞墙、留一串拒绝记录。
export const CHROMIUM_FLAGS = ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir=/tmp/si-chrome', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--disable-default-apps', '--disable-extensions', '--disable-client-side-phishing-detection', '--metrics-recording-only', '--safebrowsing-disable-auto-update',
  // 不走沙箱的出网代理：页面只在 127.0.0.1 上；它自己在后台连 Google 时直接连不上，不会在出网记录里留一串"被拒"，
  // 更不会被算进任务的"联网连续被拒"上限（光靠关后台联网的开关挡不干净，拒绝次数曾把任务顶到上限、暂停）
  '--no-proxy-server', '--disable-domain-reliability', '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater'];

// 渲染后的页面里出现这些，多半是没连上后端 / 后端报错（提示，不是判决）
const PAGE_TROUBLE = [
  [/Failed to fetch|NetworkError|Network Error|ERR_CONNECTION_REFUSED|ECONNREFUSED/i, '页面上有"连不上"的报错（多半是页面没连上背后的服务）'],
  [/Internal Server Error|\b50[0234]\b[^<]{0,20}(Error|错误)|Bad Gateway/i, '页面上有服务器出错的提示（背后的服务出错了）'],
  [/Traceback \(most recent call last\)|Uncaught \w*Error|TypeError:|ReferenceError:/, '页面上露出了程序报错的原文'],
  [/Cannot (GET|POST) \//, '这个地址没有对应的页面（页面上写着 Cannot GET）'],
];
export function pageTrouble(dom) {
  const s = String(dom ?? '');
  const out = PAGE_TROUBLE.filter(([re]) => re.test(s)).map(([, why]) => why);
  const text = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  if (text.length < 8) out.push('页面几乎是空白（渲染后没有文字）');
  return out;
}

/**
 * 在沙箱里起服务、截图、关服务。exec 是任务的沙箱执行器（ContainerExecutor），dir 是工作区（宿主路径）。
 * 截图搬到 outDir。返回 { ok, shots: [{ title, path, file, warnings? }], why?, log?, warnings? }。
 *   ok      = 至少截到一张（截到了 ≠ 页面是好的 —— 看 warnings）
 *   warnings = 整体的问题（样例数据没放成、截完服务已经不应答了）；每张图自己的问题在 shot.warnings
 *   restored = 截图这一段往工作区里新写出来、已经还原掉的路径
 *
 * 截图起的服务会往工作区写东西（sqlite 库、上传目录、日志……）。不还原，合并时就撞"工作区有未提交的改动" ——
 * 整条链就此卡死。只还原这一段新冒出来的，之前就有的不碰。
 */
export async function capturePreview(exec, dir, spec, { outDir, readyTimeoutMs = 90_000 } = {}) {
  const run = (argv, timeoutMs = 30_000) => exec.execute({ file: argv[0], args: argv.slice(1) }, dir, { mode: 'write', timeoutMs });
  const shots = [], warnings = [];
  let log = '';
  const before = new Set(describeChanges(dir).map((c) => c.path));
  const restored = [];
  const probe = async (u) => (await run(['curl', '-sf', '-o', '/dev/null', '-m', '3', u], 10_000)).code === 0;
  const tail = async () => String((await run(['sh', '-c', 'tail -n 20 /tmp/si-preview-*.log 2>/dev/null'])).stdout ?? '').slice(-2000);
  try {
    rmSync(join(dir, OUT_DIR), { recursive: true, force: true });
    mkdirSync(join(dir, OUT_DIR), { recursive: true });
    // 每条 start 放进自己的进程组（setsid），关的时候整组杀 —— npm run dev 会再起 node / vite，只杀 npm 杀不干净
    for (const [i, argv] of spec.start.entries()) {
      await run(['sh', '-c', `setsid ${argv.map(q).join(' ')} > /tmp/si-preview-${i}.log 2>&1 < /dev/null & echo $! >> /tmp/si-preview.pids`], 10_000);
    }
    // 就绪：每个地址都要 2xx/3xx（curl -f）。只看"有没有应答"会把后端的 500、前端的 404 都当成起来了。
    const ready = spec.ready ?? [`${spec.url}/`];
    const t0 = Date.now();
    let pending = [...ready];
    while (pending.length && Date.now() - t0 < readyTimeoutMs) {
      const still = [];
      for (const u of pending) if (!(await probe(u))) still.push(u);
      pending = still;
      if (pending.length) await new Promise((ok) => setTimeout(ok, 1500));
    }
    if (pending.length) {
      log = await tail();
      return { restored, ok: false, shots, why: `${Math.round(readyTimeoutMs / 1000)} 秒内这些地址一直打不开（服务没起来，或者起来了但出错）：${pending.join('、')}`, log };
    }
    // 样例数据：失败不拦截图，但照实说（空库的截图证明不了功能，签收的人得知道）
    for (const argv of spec.seed ?? []) {
      const r = await run(argv, 60_000);
      if (r.code !== 0) {
        warnings.push(`样例数据命令「${argv.join(' ')}」出错了、没跑成，截图里可能是空的`);
        log += `\n[seed ${argv.join(' ')}] ${String(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim().split('\n').slice(-5).join(' ')}`;
      }
    }
    for (const [i, p] of spec.pages.entries()) {
      const file = `${String(i + 1).padStart(2, '0')}.png`;
      const r = await run(['timeout', '60', 'chromium', ...CHROMIUM_FLAGS, '--window-size=1280,800', `--virtual-time-budget=${spec.waitMs}`,
        `--screenshot=${OUT_DIR}/${file}`, spec.url + p.path], 90_000);
      if (existsSync(join(dir, OUT_DIR, file))) {
        mkdirSync(outDir, { recursive: true });
        copyFileSync(join(dir, OUT_DIR, file), join(outDir, file));
        const d = await run(['timeout', '60', 'chromium', ...CHROMIUM_FLAGS, `--virtual-time-budget=${spec.waitMs}`, '--dump-dom', spec.url + p.path], 90_000);
        const w = d.code === 0 ? pageTrouble(d.stdout) : [];
        shots.push({ title: p.title, path: p.path, file, ...(w.length ? { warnings: w } : {}) });
      } else {
        log += `\n[${p.path}] ${String(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim().split('\n').slice(-3).join(' ')}`;
      }
    }
    // 截完再查一遍：截图途中死掉的服务（常见：后端第一次查库就崩），图上看不出来
    const dead = [];
    for (const u of ready) if (!(await probe(u))) dead.push(u);
    if (dead.length) { warnings.push(`服务在截图途中挂了 —— 截完再查，这些地址已经打不开：${dead.join('、')}`); log = `${log}\n${await tail()}`.trim(); }
    const extra = { ...(warnings.length ? { warnings } : {}), ...(log.trim() ? { log: log.trim() } : {}) };
    return shots.length ? { restored, ok: true, shots, ...extra } : { restored, ok: false, shots, why: '服务起来了，但一张都没截出来', ...extra };
  } catch (e) {
    return { restored, ok: false, shots, why: `截图过程出错：${e.message}`, log, ...(warnings.length ? { warnings } : {}) };
  } finally {
    await run(['sh', '-c', 'for p in $(cat /tmp/si-preview.pids 2>/dev/null); do kill -TERM -- -$p 2>/dev/null || kill -TERM $p 2>/dev/null; done; rm -f /tmp/si-preview.pids'], 10_000).catch(() => {});
    try { rmSync(join(dir, OUT_DIR), { recursive: true, force: true }); } catch { /* 下次开头会再清 */ }
    try {
      const left = describeChanges(dir).map((c) => c.path).filter((p) => !before.has(p));
      if (left.length) { discardChanges(dir, left); restored.push(...left); }
    } catch { /* 还原失败：合并前的干净检查会把它变成一条事项 */ }
  }
}

/** 一次截图的结论有没有该让签收人先看一眼的问题（整体或任何一张图）。 */
export const previewTroubles = (r) => [...(r?.warnings ?? []), ...(r?.shots ?? []).flatMap((s) => (s.warnings ?? []).map((w) => `「${s.title}」${w}`))];
