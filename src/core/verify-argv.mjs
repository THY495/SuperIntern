// 验收命令在执行前的一处机械修正。
//
// `node --test cli/test/` 这种写法在 Node 22 上跑不起来：--test 后面的位置参数按 glob 匹配，不展开目录，
// 结果是"Cannot find module '/workspace/cli/test'"，验收永远不过。规划器照着常见写法写出它，执行器发现后
// 只能提结构矛盾、由人改契约（回答 + 修正 + 负责人裁定，几个人各走两步）。这不是一个需要人拍板的取舍：
// "跑这个目录下的测试"的意思没有歧义，只是写法不被 Node 22 接受。所以在执行那一刻改写成等价的 glob。
//
// 只动这一种形状：命令是 node、带 --test、某个位置参数没有 glob 字符、在工作区里确实是个目录。其余原样。
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const GLOB = /[*?[\]{}]/;
// 带值的选项后面那个词是选项值，不是测试路径（--test-reporter spec）
const VALUED = new Set(['--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern',
  '--test-concurrency', '--test-timeout', '--test-shard', '--import', '--require', '-r', '--loader']);
/** 不看文件系统：`node --test` 后面像目录的位置参数（没有 glob 字符、没有扩展名）。规划时还没有仓库，只能按形状判断。 */
export function dirLikeTestArgs(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'node' || !argv.includes('--test')) return [];
  const rest = argv.slice(argv.indexOf('--test') + 1);
  return rest.filter((a, i) => !a.startsWith('-') && !VALUED.has(rest[i - 1]) && !GLOB.test(a) && !/\.[A-Za-z0-9]+$/.test(a));
}
export function runnableArgv(argv, dir) {
  if (!Array.isArray(argv) || argv[0] !== 'node' || !argv.includes('--test') || !dir) return argv;
  const at = argv.indexOf('--test');
  return argv.map((a, i) => {
    if (i <= at || a.startsWith('-') || GLOB.test(a)) return a;
    const p = join(dir, a);
    try { if (!existsSync(p) || !statSync(p).isDirectory()) return a; } catch { return a; }
    return `${a.replace(/\/+$/, '')}/**/*.test.{cjs,mjs,js}`;
  });
}

/**
 * 验收命令的形状检查（护栏在模型外）：任务级验收是把命令按空白切成 argv 直接 exec，不经 shell。
 * 实际运行第一版草案给了一段 20 行的 bash（mktemp / printf / grep / trap），形状合法、根本跑不起来 ——
 * 与其在提示词里求它，不如在这里拒收并回灌。
 */
export function verifyCommandProblems(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  const errs = [];
  if (/[\r\n]/.test(s)) errs.push('verify_command 是多行脚本 —— 只能是一条命令；把脚本列进完成定义让实现方交付，这里只写运行它的命令');
  const meta = s.match(/(\|\||&&|\||;|\$\(|`|>|<|\bset -e\b|\btrap\b)/);
  if (meta) errs.push(`verify_command 含 shell 语法「${meta[1]}」—— 命令不经 shell 执行，管道 / 串联 / 重定向 / 变量都不生效`);
  // `node --test cli/` 在 Node 22 上不展开目录（Cannot find module）。系统执行时会改写成 glob（verify-argv），
  // 但契约里写着目录形式，执行器、签收的人都会以为它跑不通，于是提问、要求改命令。
  const dirs = dirLikeTestArgs(s.split(/\s+/));
  if (dirs.length) errs.push(`verify_command 里 \`node --test ${dirs[0]}\` 写的是目录 —— Node 22 的 --test 不展开目录。写成 glob，例如 \`${dirs[0].replace(/\/+$/, '')}/*.test.mjs\`；规则里提到测试命令也用同样的写法`);
  return errs;
}
