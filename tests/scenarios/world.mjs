// 离线场景集的"世界"：一个种子仓库 + 一份 N 个任务的项目 + 每个任务的剧本。
//
// 仓库是真的 git 仓库，任务是真的模块：任务 K 写 mods/mK/index.mjs（导出 value = K + 依赖的 value 之和）
// 和 mods/mK/index.test.mjs。依赖关系是一张随机 DAG（种子固定，同一预设每次一样），所以合并顺序、
// 回归义务（后面的任务要跑前面所有任务的测试）、并行开工都是真实发生的，不是摆设。
//
// 剧本（profile）决定假模型在这个任务上怎么"表现"：
//   clean   照规矩做完
//   ask     第一步先提一个Ⅱ级问题（规格取舍），等人答了再做
//   scope   顺手写了范围外的 docs/mK.md → 交接被判越界 → 走扩范围批准
//   flaky   第一版实现算错，任务级验收不过 → 挂"验收没过"事项 → 人答了再修
//   shared  往共享文件 shared/registry.mjs 末尾加一行 —— 两个并行的 shared 任务合并时撞冲突

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** 可复现的随机数（mulberry32）。 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PROFILES = ['clean', 'ask', 'scope', 'flaky', 'shared'];

/**
 * 生成任务表。`mix` = 各剧本的权重；前两个任务固定 clean（项目得先有地基）。
 * 依赖：每个任务从编号更小的任务里挑 0–maxDeps 个（偏向最近的几个），保证 DAG 有宽度 —— 能并行开工。
 */
export function makeTasks({ n, seed, mix = { clean: 6, ask: 1, scope: 1, flaky: 1, shared: 1 }, maxDeps = 2 }) {
  const r = rng(seed);
  const pickProfile = () => {
    const total = Object.values(mix).reduce((a, b) => a + b, 0);
    let x = r() * total;
    for (const [k, w] of Object.entries(mix)) { if ((x -= w) < 0) return k; }
    return 'clean';
  };
  const tasks = [];
  for (let k = 1; k <= n; k++) {
    const deps = new Set();
    if (k > 1) {
      const want = Math.floor(r() * (maxDeps + 1));
      for (let i = 0; i < want; i++) {
        // 偏向最近的 6 个：真实项目里新任务多半接着最近做的东西
        const lo = Math.max(1, k - 6);
        deps.add(lo + Math.floor(r() * (k - lo)));
      }
    }
    const profile = k <= 2 ? 'clean' : pickProfile();
    tasks.push({ order: k, deps: [...deps].sort((a, b) => a - b), profile });
  }
  // 期望值：value_K = K + Σ value_dep
  const value = new Map();
  for (const t of tasks) { t.value = t.order + t.deps.reduce((s, d) => s + value.get(d), 0); value.set(t.order, t.value); }
  return tasks;
}

/** 项目规格（createProject 吃的那种）。 */
export function projectSpec(tasks, { title = '模块拼装（离线场景）' } = {}) {
  return {
    title,
    brief: '一组小模块：每个模块导出一个数值，等于自己的编号加上它依赖的模块的数值之和。',
    tasks: tasks.map((t) => ({
      title: `模块 m${t.order}`,
      goal: `实现 mods/m${t.order}/index.mjs：导出 value，等于 ${t.order} 加上${t.deps.length ? ` ${t.deps.map((d) => `m${d}`).join('、')} 的 value` : '0'}。`,
      definition_of_done: `node --test mods/m${t.order}/index.test.mjs 通过，断言 value 等于 ${t.value}。`,
      verify_command: `node --test mods/m${t.order}/index.test.mjs`,
      scope: `只动 mods/m${t.order}/${t.profile === 'shared' ? ' 与 shared/registry.mjs' : ''}`,
      scope_paths: [`mods/m${t.order}/`, ...(t.profile === 'shared' ? ['shared/registry.mjs'] : [])],
      depends_on: t.deps,
    })),
  };
}

/** 种子仓库：package.json + 共享文件 + README。返回仓库目录。 */
export function seedRepo(dir) {
  mkdirSync(join(dir, 'shared'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scenario-mods', private: true, type: 'module' }, null, 2) + '\n');
  writeFileSync(join(dir, 'README.md'), '# 模块拼装\n\n每个模块在 mods/mK/ 下。\n');
  writeFileSync(join(dir, 'shared', 'registry.mjs'), '// 登记表：每个登记过的模块一行\nexport const registry = {};\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'add', '-A');
  git('-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'commit', '-q', '-m', 'seed');
  return dir;
}

/** 模块源码：import 依赖、导出 value。`wrong` = 剧本 flaky 的第一版（少加了 1）。 */
export function moduleSource(t, { wrong = false } = {}) {
  const imports = t.deps.map((d) => `import { value as v${d} } from '../m${d}/index.mjs';`).join('\n');
  const sum = [String(t.order), ...t.deps.map((d) => `v${d}`)].join(' + ');
  return `${imports}${imports ? '\n' : ''}export const value = ${sum}${wrong ? ' - 1' : ''};\n`;
}

export function testSource(t) {
  return `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './index.mjs';\n\ntest('m${t.order} 的 value', () => { assert.equal(value, ${t.value}); });\n`;
}
