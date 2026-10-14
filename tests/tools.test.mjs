// 执行器工具（makeHandlers）的边界
//
// 跑：node tests/tools.test.mjs
//
// 曾出现过：read_file 没有上限，一次读 187 KB 的 package-lock.json 把上下文吃光。
// run_command 早有 maxOutputBytes，read_file 是同一个洞的另一扇门。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHandlers, READ_FILE_MAX_CHARS } from '../src/agent/executor.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-tools-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const WS = join(TMP, 'ws'); mkdirSync(WS);
writeFileSync(join(WS, 'small.txt'), 'hello\n');
writeFileSync(join(WS, 'package-lock.json'), '{"x":"' + 'a'.repeat(READ_FILE_MAX_CHARS * 3) + '"}');

console.log('\nread_file 有上限');
{
  const trace = [];
  const h = makeHandlers(new LocalExecutor(), WS, trace);
  eq(await h.read_file({ path: 'small.txt' }), 'hello\n', '小文件原样返回，不加注');
  const big = await h.read_file({ path: 'package-lock.json' });
  assert(big.length < READ_FILE_MAX_CHARS + 400, `大文件截到上限附近（${big.length} 字符）`);
  assert(big.includes('[系统] 文件共') && big.includes('只返回了前'), '截断有说明：总大小、返回了多少');
  assert(big.includes('grep'), '说明里指了条路（grep 定位）');
  assert(big.startsWith('{"x":"aaaa'), '返回的是文件开头，不是空');
  eq(trace.length, 2, '两次调用都留痕');
}

console.log('\ngrep：正则在工作线程里跑、有时限（灾难性回溯原来能卡死整个编排器）');
{
  writeFileSync(join(WS, 'long.txt'), `${'a'.repeat(40)}!\nneedle here\n`);
  const trace = [];
  const h = makeHandlers(new LocalExecutor(), WS, trace);
  const hit = await h.grep({ pattern: 'needle', glob: '.txt' });
  eq(hit, 'long.txt:2:needle here', '正常的正则照常出结果（文件:行号:内容）');
  eq(await h.grep({ pattern: 'nothing-like-this' }), '(无匹配)', '没匹配照旧');
  let syntax = null; try { await h.grep({ pattern: '(' }); } catch (e) { syntax = e; }
  assert(syntax instanceof SyntaxError, '写错的正则照旧当场报（回给模型）');
  // 主线程在等的同时还能干别的：计时器照常走
  let ticks = 0; const tk = setInterval(() => { ticks++; }, 100);
  const t0 = Date.now();
  const slow = await h.grep({ pattern: '^(a+)+$', glob: '.txt' });
  clearInterval(tk);
  const ms = Date.now() - t0;
  assert(/没跑完，已中止/.test(slow), `灾难性回溯的正则被掐断，回一句话让它换写法（${slow.slice(0, 30)}…）`);
  assert(ms < 8000, `有界：${ms} ms`);
  assert(ticks >= 20, `等的时候主线程没被卡住（计时器走了 ${ticks} 次）`);
}

console.log('\nlist_dir / grep：一个条目读不了不连累整个目录（容器建的 .venv 符号链接在 Windows 上 stat 报 EACCES）');
{
  const ws = join(TMP, 'ws-link'); mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.py'), 'needle = 1\n');
  mkdirSync(join(ws, '.venv', 'lib'), { recursive: true }); writeFileSync(join(ws, '.venv', 'lib', 'site.py'), 'needle = 2\n');
  // 断链：stat 跟着链接走、找不到目标 —— 与 EACCES 走同一条路。能建哪种建哪种（Windows 非管理员建不了文件链接，目录联接可以）
  let linked = false;
  try { symlinkSync(join(ws, 'nowhere.txt'), join(ws, 'dangling.txt')); linked = true; } catch {
    try { mkdirSync(join(ws, 'gone')); symlinkSync(join(ws, 'gone'), join(ws, 'dangling'), 'junction'); rmSync(join(ws, 'gone'), { recursive: true }); linked = true; } catch { /* 建不了就只测跳过虚拟环境 */ }
  }
  const h = makeHandlers(new LocalExecutor(), ws, []);
  if (linked) {
    const ls = await h.list_dir({ path: '.' });
    assert(/src\//.test(ls) && /dangling.*读不了/.test(ls), `列目录照常出结果，读不了的那条标出来（${ls.replace(/\n/g, ' | ')}）`);
  } else console.log('  （本机建不了链接，跳过断链一条）');
  eq(await h.grep({ pattern: 'needle' }), 'src/a.py:1:needle = 1', '从根开始搜照常出结果；.venv 不进');
  eq(await h.grep({ pattern: 'needle', path: '.venv' }), '.venv/lib/site.py:1:needle = 2', '显式指进 .venv 的照搜');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
