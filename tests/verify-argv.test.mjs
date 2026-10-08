// 验收命令执行前的机械修正：node --test <目录> → glob（Node 22 不展开目录）
//
// 跑：node tests/verify-argv.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnableArgv, dirLikeTestArgs } from '../src/core/verify-argv.mjs';
import { verifyCommandProblems } from '../src/agent/elicitor.mjs';

let pass = 0, fail = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log(`  [PASS] ${m}`); } else { fail++; console.log(`  [FAIL] ${m}\n         期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`); } };

const D = mkdtempSync(join(tmpdir(), 'si-va-'));
process.on('exit', () => { try { rmSync(D, { recursive: true, force: true }); } catch { /* 尽力 */ } });
mkdirSync(join(D, 'cli', 'test'), { recursive: true });
writeFileSync(join(D, 'cli', 'test', 'a.test.mjs'), '');
writeFileSync(join(D, 'x.test.mjs'), '');

eq(runnableArgv(['node', '--test', 'cli/test/'], D), ['node', '--test', 'cli/test/**/*.test.{cjs,mjs,js}'], '目录（带斜杠）→ glob');
eq(runnableArgv(['node', '--test', 'cli/test'], D), ['node', '--test', 'cli/test/**/*.test.{cjs,mjs,js}'], '目录（不带斜杠）→ glob');
eq(runnableArgv(['node', '--test', 'cli/test/*.test.mjs'], D), ['node', '--test', 'cli/test/*.test.mjs'], '已经是 glob：不动');
eq(runnableArgv(['node', '--test', 'x.test.mjs'], D), ['node', '--test', 'x.test.mjs'], '具体文件：不动');
eq(runnableArgv(['node', '--test', 'nope/'], D), ['node', '--test', 'nope/'], '不存在的路径：不动（让它照常报错）');
eq(runnableArgv(['node', '--test', '--test-reporter', 'spec', 'cli/test'], D), ['node', '--test', '--test-reporter', 'spec', 'cli/test/**/*.test.{cjs,mjs,js}'], '带选项：只改位置参数');
eq(runnableArgv(['python', '-m', 'pytest', 'cli/test'], D), ['python', '-m', 'pytest', 'cli/test'], '不是 node --test：不动');
eq(runnableArgv(['node', 'cli/test'], D), ['node', 'cli/test'], '没有 --test：不动');

// 规划时（还没有仓库）只按形状判断：规划器写出 `node --test importer/` 这种目录写法，执行器 / 人都会以为它跑不通，一个问题要来回好几步
eq(dirLikeTestArgs(['node', '--test', 'cli/']), ['cli/'], '形状判断：目录写法');
eq(dirLikeTestArgs(['node', '--test', '--test-reporter', 'spec', 'cli/*.test.mjs']), [], '形状判断：选项值不算、glob 不算');
eq(dirLikeTestArgs(['node', '--test', 'cli/tw.test.mjs']), [], '形状判断：具体文件不算');
eq(verifyCommandProblems('node --test importer/').length, 1, '规划时拒回目录写法');
eq(verifyCommandProblems('node --test importer/*.test.mjs'), [], 'glob 写法通过');

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
