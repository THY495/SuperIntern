// 重查提醒。
//
// 有几件事现在故意不做（迁到别的数据库、长上下文的结构调整、把"改弱原有测试"做成闸门……），每件都写了"什么情况下该重新考虑"。
// 光写在文档里没用：条件出现时没人会去翻文档。这里把机器看得见的条件登记成一张表，挂在运行期自检同一套机制上：
// 守护进程按周期查，结果进 invariant_state，从"不成立"到"成立"写一条审计 recheck_due、消失时写 recheck_cleared；
// 健康卡显示一条建议，管理员点「知道了」之后收起，条件消失再出现才会重新提醒。
//
// 与不变量的区别：不变量不成立是系统的缺陷；这里成立只是"情况变了，值得看一眼"，不推通知、不算问题。
// 文字一律用产品自己的说法（模型、步骤、整理、写入竞争），不提开发过程。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { registryFor } from '../llm/registry.mjs';
import { compactThresholdOf } from './limits.mjs';
import { getSetting } from './settings.mjs';

const MIN = 60_000, DAY = 24 * 60 * MIN;
const GiB = 1024 ** 3;

/** 阈值。改阈值要说明理由。 */
export const RECHECK_T = {
  smallWindow: 128_000,      // 绑定的模型窗口 ≤ 它：长步骤更容易撞整理线、撞上下文上限
  compactionsPerStep: 3,     // 同一步骤近 30 天整理 ≥ 它次（或整理到顶转过人）：多半是步骤切得太大
  busy: 3,                   // 库忙（SQLITE_BUSY）累计 ≥ 它次
  lockWaitMs: 5_000,         // 或最长一次等写锁 ≥ 它
  dbBytes: 2 * GiB,          // 库文件 ≥ 它
  auditRows: 2_000_000,      // 或审计行数 ≥ 它
  weakenedTests: 5,          // 原有测试被改弱（人没放行）累计 ≥ 它次
};

/** 每个绑定的模型（各档 + 各档备用 + 单独绑给角色的）：窗口多大、用在哪 */
function boundModels(db) {
  const reg = registryFor(db);
  const out = new Map();
  const add = (key, use) => { if (!key) return; const m = out.get(key) ?? { key, window: reg.catalog?.[key]?.contextWindow ?? null, uses: [] }; m.uses.push(use); out.set(key, m); };
  for (const [tier, key] of Object.entries(reg.binding ?? {})) add(key, tier);
  for (const [tier, key] of Object.entries(reg.fallbacks ?? {})) add(key, `${tier}:fallback`);
  for (const [role, b] of Object.entries(reg.roleBinding ?? {})) add(b?.key, `role:${role}`);
  return [...out.values()];
}

export const RECHECKS = [
  {
    // 小窗口的模型：整理线与上下文上限已按窗口自动压低，但长步骤会更常整理。
    // 窗口没登记的不报：默认绑定里就有，每个新部署一上来就亮一条只会让人学会忽略这一项（上限按 150k 常数算，对现在的主流窗口是保守的）
    id: 'recheck_small_window', everyMs: 60 * MIN, advice: true,
    check(db) {
      const ms = boundModels(db).filter((m) => m.window != null);
      const violations = ms.filter((m) => m.window <= RECHECK_T.smallWindow)
        .map((m) => ({ ref: m.key, kind: 'small', window: m.window, uses: m.uses, compactAt: compactThresholdOf(db, null, { contextWindow: m.window }).at }));
      return { checked: ms.length, violations };
    },
  },
  {
    // 同一步骤反复撞整理线：近 30 天里整理 ≥ 3 次，或整理到顶转过人
    id: 'recheck_compaction', everyMs: 60 * MIN, advice: true,
    check(db, { at }) {
      const rows = db.all(`SELECT a.target_id AS node, n.title, n.task_id, t.title AS task, SUM(a.action='context_compacted') AS n, SUM(a.action='compaction_escalated') AS esc
          FROM audit_log a JOIN nodes n ON n.id=a.target_id JOIN tasks t ON t.id=n.task_id
         WHERE a.action IN ('context_compacted','compaction_escalated') AND a.target_type='node' AND a.ts>=?
         GROUP BY a.target_id`, at - 30 * DAY);
      const violations = rows.filter((r) => r.n >= RECHECK_T.compactionsPerStep || r.esc > 0)
        .map((r) => ({ ref: r.node, title: r.title, taskId: r.task_id, task: r.task, n: r.n, escalated: r.esc }));
      return { checked: rows.length, violations };
    },
  },
  {
    // 写入竞争：各进程退出 / 定期写下的库计数（db/metrics.mjs）里库忙的次数与最长等锁
    id: 'recheck_contention', everyMs: 60 * MIN, advice: true,
    check(db, { home }) {
      const dir = home ? join(home, 'metrics') : null;
      let files = [];
      try { files = dir ? readdirSync(dir).filter((n) => n.endsWith('.json')) : []; } catch { files = []; }
      if (!files.length) return { checked: 0, violations: [] };
      let busy = 0, maxWaitMs = 0;
      for (const n of files) { try { const m = JSON.parse(readFileSync(join(dir, n), 'utf8')); busy += m.busy ?? 0; maxWaitMs = Math.max(maxWaitMs, m.lock?.maxMs ?? 0); } catch { /* 写到一半的 */ } }
      const hit = busy >= RECHECK_T.busy || maxWaitMs >= RECHECK_T.lockWaitMs;
      return { checked: files.length, violations: hit ? [{ ref: 'db', busy, maxWaitMs }] : [] };
    },
  },
  {
    // 库变大：备份与完整检查变慢，单机库越过这个量级写入竞争值得盯着
    id: 'recheck_db_size', everyMs: 6 * 60 * MIN, advice: true,
    check(db) {
      const file = db.all(`PRAGMA database_list`).find((r) => r.name === 'main')?.file || null;
      let bytes = null;
      try { bytes = file ? statSync(file).size : null; } catch { bytes = null; }
      const rows = db.one(`SELECT max(id) n FROM audit_log`)?.n ?? 0;   // 只增的表：最大 id ≈ 行数，不用全表计数
      const hit = (bytes ?? 0) >= RECHECK_T.dbBytes || rows >= RECHECK_T.auditRows;
      return { checked: 1, violations: hit ? [{ ref: 'db', bytes, auditRows: rows }] : [] };
    },
  },
  {
    // 原有测试被改弱（人没放行）：攒够了样本，值得考虑让系统直接打回
    id: 'recheck_weakened_tests', everyMs: 6 * 60 * MIN, advice: true,
    check(db) {
      if (getSetting(db, 'deploy.test_guard') === 'reject') return { checked: 0, violations: [], skipped: 'already_reject' };
      let n = 0;
      const tasks = new Set();
      for (const r of db.all(`SELECT a.payload, n.task_id FROM audit_log a JOIN nodes n ON n.id=a.target_id WHERE a.action='handoff_test_changes' AND a.target_type='node'`)) {
        let changes = [];
        try { changes = JSON.parse(r.payload).changes ?? []; } catch { changes = []; }
        const weak = changes.filter((c) => c.baseline && !c.allowed).length;
        if (weak) { n += weak; tasks.add(r.task_id); }
      }
      return { checked: n, violations: n >= RECHECK_T.weakenedTests ? [{ ref: 'tests', n, tasks: tasks.size }] : [] };
    },
  },
];
