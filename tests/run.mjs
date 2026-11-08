// 跑一组测试文件，任一失败则非零退出。给任务级验收命令用（它只接受一条命令）。
//
//   node tests/run.mjs inbox web reporter      → tests/inbox.test.mjs tests/web.test.mjs tests/reporter.test.mjs
//   node tests/run.mjs --all                   → tests/*.test.mjs 全部
//   node tests/run.mjs --all --without docker  → 去掉文件头声明了 `// @needs: docker` 的套件（照实列出来，不算通过）
//   node tests/run.mjs --all --except a,b      → 按名字去掉几套
//   --timeout-min N                            → 单个文件的时限（默认 20 分钟），超时杀掉、算失败
//
// 每个文件在独立子进程里跑（它们各自 process.exit），逐个打印通过/失败行与耗时，最后汇总。
//
// ⚠️ 原来的 spawnSync 不带时限 —— 一个套件留下没关的句柄（服务器、子进程、定时器）
// 整套就永远挂着；输出超过默认 1 MB 缓冲也会被截断成失败。现在每个文件有时限、缓冲放大到 256 MB。
// 套件内部打印的"跳过"行会被汇总出来：跳过不是通过（container / egress 两套的守则），至少要看得见。

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flagValue = (name) => { const i = args.indexOf(name); return i >= 0 ? String(args[i + 1] ?? '') : null; };
const valueAt = new Set(['--except', '--without', '--timeout-min'].map((f) => args.indexOf(f)).filter((i) => i >= 0).map((i) => i + 1));
const except = (flagValue('--except') ?? '').split(',').filter(Boolean);
const without = (flagValue('--without') ?? '').split(',').filter(Boolean);
const timeoutMs = Number(flagValue('--timeout-min') ?? 20) * 60_000;

/** 文件头（前 40 行）里的 `// @needs: docker, net` —— 这个套件离开这些条件就没有意义。 */
const needsOf = (text) => {
  const m = text.split('\n').slice(0, 40).join('\n').match(/^\/\/\s*@needs:\s*([a-z, ]+)$/m);
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

const picked = (args.includes('--all')
  ? readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).map((f) => f.replace(/\.test\.mjs$/, ''))
  : args.filter((a, i) => !a.startsWith('--') && !valueAt.has(i))).filter((n) => !except.includes(n));
if (!picked.length) { console.error('用法：node tests/run.mjs <name>... | --all [--without docker,net] [--except a,b] [--timeout-min N]'); process.exit(2); }

const names = [], left = [];
for (const n of picked) {
  let needs = [];
  try { needs = needsOf(readFileSync(join(HERE, `${n}.test.mjs`), 'utf8')); } catch { /* 文件不存在：交给下面的子进程报错 */ }
  const miss = needs.filter((x) => without.includes(x));
  if (miss.length) left.push(`${n}（要 ${miss.join(' / ')}）`); else names.push(n);
}

const fmtSec = (ms) => `${(ms / 1000).toFixed(1)}s`;
let failed = 0;
const skippedInside = [];
const started = Date.now();
for (const n of names) {
  const file = join(HERE, `${n}.test.mjs`);
  const t0 = Date.now();
  // 只有部分小节要 docker / 外网的套件（整套没标 @needs）也要知道"这次不许用"：经环境变量传下去，
  // 由它们自己跳过那几节并打印"跳过"（下面会汇总出来）。Windows 的 CI 机器有 docker 引擎、却只有 Windows 容器，
  // 光探"有没有 docker"会误判成能跑。
  // 套件里拉起的 CLI 子进程不读仓库的 .env（开发者自己的通知通道与 key：读了就会真发通知）
  const env = { ...process.env, SUPERINTERN_ENV_FILE: 'none', ...(without.length ? { SUPERINTERN_TEST_WITHOUT: without.join(',') } : {}) };
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', cwd: join(HERE, '..'), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024, env });
  const ms = Date.now() - t0;
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const lines = out.split('\n');
  const summary = lines.filter((l) => /通过，\d+ 失败|PASS=\d+\s+FAIL=\d+/.test(l)).at(-1) ?? '(没有汇总行)';
  const timedOut = r.error?.code === 'ETIMEDOUT' || (r.signal === 'SIGKILL' && ms >= timeoutMs);
  const ok = r.status === 0 && !timedOut;
  if (!ok) failed++;
  const skips = lines.filter((l) => /（跳过[：:]|\bSKIPPED\b/.test(l)).map((l) => l.trim());
  if (skips.length) skippedInside.push(`${n}: ${skips.slice(0, 3).join(' / ')}`);
  const why = timedOut ? `  (超时 ${fmtSec(timeoutMs)}，已杀掉)` : r.error ? `  (${r.error.code ?? r.error.message})` : ok ? '' : `  (exit ${r.status})`;
  console.log(`${ok ? '✅' : '❌'} ${n}: ${summary.trim()}  [${fmtSec(ms)}]${why}`);
  if (!ok) console.log(lines.filter((l) => l.includes('[FAIL]') || l.includes('Error')).slice(0, 20).map((l) => `     ${l}`).join('\n'));
}
if (skippedInside.length) console.log(`\n⚠️ 下面这些套件里有部分内容跳过了（跳过不等于通过）：\n${skippedInside.map((s) => `   ${s}`).join('\n')}`);
if (left.length) console.log(`\n⚠️ 按 --without 没跑 ${left.length} 套：${left.join('、')}`);
console.log(`\n${failed ? '❌' : '✅'} ${names.length - failed}/${names.length} 个套件通过${left.length ? `（另有 ${left.length} 套没跑）` : ''}  [共 ${fmtSec(Date.now() - started)}]`);
process.exit(failed ? 1 : 0);
