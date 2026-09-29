// 滚动缓存断点的开关对照测试。
//
// 跑：node tests/live/rolling-cache.mjs        （需要 ANTHROPIC_API_KEY，约 $0.3）
//
// 使用同一段工作负载分别关闭和开启滚动缓存断点，比较缓存使用量与估算费用。
// 滚动断点让累积的工具调用历史成为可复用的稳定前缀。

import { join } from 'node:path';
import { LlmClient, loadEnv, runToolLoop } from '../../src/llm/client.mjs';
import { fmtUsd } from '../../src/llm/canonical.mjs';

loadEnv(new URL('../../.env', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (!process.env.ANTHROPIC_API_KEY) { console.log('无 ANTHROPIC_API_KEY，跳过'); process.exit(0); }

const BINDING = { light: 'anthropic/claude-haiku-4-5', standard: 'anthropic/claude-sonnet-5', heavy: 'anthropic/claude-opus-5' };
const ROUNDS = 6;

// 每轮塞一大段"文件内容"，模拟执行器读文件——真实执行器正是这样把上下文撑大的
const BLOB = (i) => `// chunk ${i}\n` + Array.from({ length: 320 },
  (_, k) => `export const sym_${i}_${k} = ${k}; // 这一行是为了把工具结果撑到真实体量`).join('\n');

const TOOLS = [{
  name: 'read_file', description: '读一个文件',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

async function trial(rollingCache) {
  const client = new LlmClient({ mode: 'live', binding: BINDING });
  let n = 0;
  await runToolLoop(client, {
    tier: 'standard',
    system: '你在审阅一个代码库。每一轮都调用 read_file 读下一个文件，直到读完 file6.mjs 为止，不要提前停。',
    messages: [{ role: 'user', content: [{ type: 'text', text: '从 file1.mjs 开始，依次读到 file6.mjs。' }] }],
    tools: TOOLS, maxTokens: 1024,
  }, { read_file: async () => BLOB(++n) }, { maxIterations: ROUNDS, rollingCache });

  const rows = client.ledger;
  return {
    calls: rows.length,
    input: rows.reduce((s, r) => s + r.inputTokens, 0),
    cacheRead: rows.reduce((s, r) => s + r.cacheReadTokens, 0),
    cacheWrite: rows.reduce((s, r) => s + r.cacheWriteTokens, 0),
    microUsd: rows.reduce((s, r) => s + r.microUsd, 0),
    perRound: rows.map((r) => `${r.inputTokens}/${r.cacheReadTokens}`),
  };
}

// ⚠️ 顺序重要：**先跑开启的**再跑关闭的会让后者白蹭前者写进去的缓存，
// 测出"不挂断点也有命中"这种自相矛盾的结果（跨轮次污染）。
// 先关后开则相反：关的那轮不留任何缓存，开的那轮从冷启动开始。
console.log(`两轮 ${ROUNDS} 次工具调用，每次塞约 5k token 的"文件内容"\n`);
const off = await trial(false);
console.log(`滚动断点 关：${off.calls} 次调用，输入 ${off.input}，缓存读 ${off.cacheRead}，${fmtUsd(off.microUsd)}`);
console.log(`            每轮 输入/缓存读：${off.perRound.join('  ')}`);
const on = await trial(true);
console.log(`滚动断点 开：${on.calls} 次调用，输入 ${on.input}，缓存读 ${on.cacheRead}，写 ${on.cacheWrite}，${fmtUsd(on.microUsd)}`);
console.log(`            每轮 输入/缓存读：${on.perRound.join('  ')}`);

const saved = off.microUsd - on.microUsd;
console.log(`\n差额 ${fmtUsd(saved)}（${(saved / off.microUsd * 100).toFixed(1)}%）`);
console.log(saved > 0
  ? '滚动断点省钱。节点越长、工具结果越大，省得越多——两者都随任务难度增长。'
  : '⚠️ 没省到。要么轮次太少写入费没摊回来（Anthropic 写入 1.25 倍，复用 2 次回本），要么断点没落对位置。');
