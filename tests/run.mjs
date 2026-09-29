// 跑一组测试文件，任一失败则非零退出。给任务级验收命令用（它只接受一条命令）。
//
//   node tests/run.mjs inbox web reporter      → tests/inbox.test.mjs tests/web.test.mjs tests/reporter.test.mjs
//   node tests/run.mjs --all                   → tests/*.test.mjs 全部
//
// 每个文件在独立子进程里跑（它们各自 process.exit），逐个打印通过/失败行，最后汇总。

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
// --except a,b：从 --all 里去掉几套（CI 的 Windows 机器上没有 Linux 容器，container / egress 两套不许"跳过即通过"，只能不跑）
const exceptAt = args.indexOf('--except');
const except = exceptAt >= 0 ? String(args[exceptAt + 1] ?? '').split(',').filter(Boolean) : [];
const names = (args.includes('--all')
  ? readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).map((f) => f.replace(/\.test\.mjs$/, ''))
  : args.filter((a, i) => !a.startsWith('--') && !(exceptAt >= 0 && i === exceptAt + 1))).filter((n) => !except.includes(n));
if (!names.length) { console.error('用法：node tests/run.mjs <name>... | --all'); process.exit(2); }

let failed = 0;
for (const n of names) {
  const file = join(HERE, `${n}.test.mjs`);
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', cwd: join(HERE, '..') });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const summary = out.split('\n').filter((l) => /通过，\d+ 失败|PASS=\d+\s+FAIL=\d+/.test(l)).at(-1) ?? '(没有汇总行)';
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${n}: ${summary.trim()}${ok ? '' : `  (exit ${r.status})`}`);
  if (!ok) console.log(out.split('\n').filter((l) => l.includes('[FAIL]') || l.includes('Error')).slice(0, 20).map((l) => `     ${l}`).join('\n'));
}
console.log(`\n${failed ? '❌' : '✅'} ${names.length - failed}/${names.length} 个套件通过`);
process.exit(failed ? 1 : 0);
