// 执行器工具（makeHandlers）的边界
//
// 跑：node tests/tools.test.mjs
//
// 曾出现过：read_file 没有上限，一次读 187 KB 的 package-lock.json 把上下文吃光。
// run_command 早有 maxOutputBytes，read_file 是同一个洞的另一扇门。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
