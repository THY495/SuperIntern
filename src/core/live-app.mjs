// 验收员看运行中的应用。
//
// 截图（preview.mjs）是任务做完后给签收人看的：起服务、按约定的几页截一张、关掉。验收员要的更多 ——
// 它得能在页面上点一下、填一个表单、再看结果，才判得了"点添加后列表多一条"这类验收条目。
// 只靠读代码判界面，是让实现给自己背书（与"期望值要有出处"同一个毛病）。
//
// 一次验收一个会话：第一次用到时才起（大多数验收用不上，不白等服务起来），验收完一定关、一定还原工作区。
//   - 服务：与截图同一份约定（si-preview.json），同一套起法、就绪判据、样例数据（preview.mjs 的 startServices）。
//   - 浏览器：沙箱里的 chromium 开远程调试口（只听 127.0.0.1），由 live-app-driver.mjs 在容器里用 node 驱动。
//   - 点、填会改应用的数据：服务往工作区写的东西（sqlite 库、上传目录……）收尾时还原 —— 这一段新冒出来的删掉；
//     执行器本来就改着的文件，被应用又改了的，按开始前的内容写回（restoreWorkspace）。
//
// 截图按模型能力给：收图的模型拿到图片，不收的只给页面文字（工具都不给它）。
// 画面：每次打开 / 点 / 填 / 选之后另存一张当时的画面到宿主（keepDir），不进模型上下文 ——
// 是给签收的人看的：验收员在 ui_checks 里引用画面号，收尾只留被引用的。

import { readFileSync, mkdirSync, rmSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServices, stopServices, snapshotWorkspace, restoreWorkspace, CHROMIUM_FLAGS, LIVE_DIR } from './preview.mjs';
import { tl } from '../i18n/index.mjs';

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), 'live-app-driver.mjs');
const PORT = 9333;
export const MAX_SHOTS = 6;
export const MAX_SCREENS = 40;
const SCREEN_CMDS = new Set(['open', 'click', 'type', 'select']);
/** 画面 n 存成的文件名（看板按它取图） */
export const screenFile = (n) => `${String(n).padStart(2, '0')}.png`;

export class LiveApp {
  /**
   * @param exec  任务的沙箱执行器（必须 isolated）
   * @param dir   工作区（宿主路径）
   * @param spec  readPreviewSpec 校验过的约定
   */
  constructor(exec, dir, spec, { lang = 'zh', readyTimeoutMs = 90_000, keepDir = null, key = null } = {}) {
    Object.assign(this, { exec, dir, spec, lang, readyTimeoutMs, keepDir, key });
    this.state = 'idle';     // idle → up | failed → closed
    this.why = null; this.log = ''; this.warnings = [];
    this.actions = 0; this.shots = 0;
    this.screens = 0; this.saved = new Set(); this.cited = new Set();
  }

  run(argv, timeoutMs = 30_000) { return this.exec.execute({ file: argv[0], args: argv.slice(1) }, this.dir, { mode: 'write', timeoutMs }); }

  /** 起服务 + 起浏览器。幂等；失败一次就记住原因，不反复重起（每次重起要等九十秒） */
  async ensure() {
    if (this.state === 'up') return true;
    if (this.state !== 'idle') return false;
    this.before = snapshotWorkspace(this.dir);
    rmSync(join(this.dir, LIVE_DIR), { recursive: true, force: true });
    mkdirSync(join(this.dir, LIVE_DIR), { recursive: true });
    copyFileSync(DRIVER, join(this.dir, LIVE_DIR, 'drive.mjs'));
    const s = await startServices((a, t) => this.run(a, t), this.spec, { readyTimeoutMs: this.readyTimeoutMs, lang: this.lang });
    this.warnings.push(...(s.warnings ?? [])); this.log += s.log ?? '';
    if (!s.ok) { this.state = 'failed'; this.why = s.why; return false; }
    // 浏览器：与截图分开的配置目录（同时留着上一次的锁会起不来）
    const flags = CHROMIUM_FLAGS.map((f) => (f.startsWith('--user-data-dir=') ? '--user-data-dir=/tmp/si-chrome-live' : f));
    await this.run(['sh', '-c', `setsid chromium ${flags.join(' ')} --remote-debugging-port=${PORT} --remote-debugging-address=127.0.0.1 --window-size=1280,800 about:blank > /tmp/si-browser.log 2>&1 < /dev/null & echo $! >> /tmp/si-preview.pids`], 10_000);
    for (let i = 0; i < 30; i++) {
      if ((await this.run(['curl', '-sf', '-o', '/dev/null', '-m', '2', `http://127.0.0.1:${PORT}/json/version`], 5_000)).code === 0) { this.state = 'up'; return true; }
      await new Promise((ok) => setTimeout(ok, 500));
    }
    this.state = 'failed';
    this.why = tl(this.lang, '应用起来了，但沙箱里的浏览器没起来（镜像里可能没装 chromium）');
    this.log += String((await this.run(['sh', '-c', 'tail -n 5 /tmp/si-browser.log 2>/dev/null'])).stdout ?? '');
    return false;
  }

  /** 在容器里跑一条驱动命令，返回驱动打印的那一行 JSON */
  async drive(cmd) {
    if (!(await this.ensure())) return { ok: false, error: this.why };
    this.actions++;
    const n = this.keepDir && SCREEN_CMDS.has(cmd.cmd) && this.screens < MAX_SCREENS ? ++this.screens : null;
    const shot = n ? `${LIVE_DIR}/screen-${n}.png` : null;
    const r = await this.run(['node', `${LIVE_DIR}/drive.mjs`, JSON.stringify({ port: PORT, ...cmd, ...(shot ? { shot } : {}) })], 60_000);
    let res;
    try { res = JSON.parse(String(r.stdout ?? '').trim().split('\n').pop()); }
    catch { return { ok: false, error: tl(this.lang, '驱动浏览器出错：{msg}', { msg: String(`${r.stdout ?? ''}${r.stderr ?? ''}`).trim().slice(-300) || `exit ${r.code}` }) }; }
    if (shot && res?.ok && existsSync(join(this.dir, shot))) {
      try {
        mkdirSync(this.keepDir, { recursive: true });
        copyFileSync(join(this.dir, shot), join(this.keepDir, screenFile(n)));
        rmSync(join(this.dir, shot), { force: true });
        this.saved.add(n); res.screen = n;
      } catch { /* 存不下不影响这一步 */ }
    }
    return res;
  }

  /** 验收员引用的画面号 → 真存下来的那几个（至多 3 个）；记下来，收尾时保留 */
  cite(list) {
    const ns = [...new Set((Array.isArray(list) ? list : []).map(Number).filter((x) => this.saved.has(x)))].slice(0, 3);
    for (const x of ns) this.cited.add(x);
    return ns;
  }

  url(path) { return this.spec.url + (String(path || '/').startsWith('/') ? String(path || '/') : `/${path}`); }

  /** 截当前页面：返回 { ok, data(base64), mediaType } */
  async screenshot({ full = false } = {}) {
    if (this.shots >= MAX_SHOTS) return { ok: false, error: tl(this.lang, '这次验收的截图已经到 {n} 张上限，改用 read_page 看文字', { n: MAX_SHOTS }) };
    const file = `${LIVE_DIR}/shot-${++this.shots}.png`;
    const r = await this.drive({ cmd: 'screenshot', file, full });
    if (!r.ok) return r;
    const p = join(this.dir, file);
    if (!existsSync(p)) return { ok: false, error: tl(this.lang, '截图没写出来') };
    return { ok: true, url: r.url, mediaType: 'image/png', data: readFileSync(p).toString('base64') };
  }

  /** 关服务、关浏览器、还原工作区。返回会话小结（进审计） */
  async close() {
    if (this.state === 'closed') return this.summary;
    const started = this.state !== 'idle';
    if (started) {
      await stopServices((a, t) => this.run(a, t));
      try { rmSync(join(this.dir, LIVE_DIR), { recursive: true, force: true }); } catch { /* 下次开头会再清 */ }
    }
    const restored = started && this.before ? restoreWorkspace(this.dir, this.before) : { removed: [], rewritten: [], kept: [] };
    // 画面只留验收员引用了的（会签的两个验收员共用会话，各自引用的都留）
    if (this.keepDir && existsSync(this.keepDir)) {
      try {
        for (const f of readdirSync(this.keepDir)) if (!this.cited.has(Number(f.replace(/\.png$/, '')))) rmSync(join(this.keepDir, f), { force: true });
        if (!this.cited.size) rmSync(this.keepDir, { recursive: true, force: true });
      } catch { /* 清不掉的留着，不影响验收 */ }
    }
    this.summary = { used: started, up: this.state === 'up', why: this.why, actions: this.actions, shots: this.shots,
      screens: { taken: this.saved.size, kept: [...this.cited].sort((a, b) => a - b) },
      warnings: this.warnings, restored, log: this.log ? this.log.slice(-1500) : null };
    this.state = 'closed';
    return this.summary;
  }
}
