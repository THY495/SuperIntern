// 跨进程用例的工作进程（tests/egress-consecutive.test.mjs 第 3 节用独立 node 进程跑，
// 保证模块状态全新 —— 计数若被放回模块级变量/进程内存，第 3 节会失败）。
// 用法：node tests/_egden_worker.mjs <dbPath> <auditFile> <workspace>
// 读同一 db + auditFile，orchestrate 一次：节点先跑 1 条 run_command（触发执行器追加
// 一条 denied 观测）再写产物交接。把结果 kind（及触顶 key）打到 stdout。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db/db.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { makeFake } from '../src/llm/providers.mjs';
import { orchestrate } from '../src/core/orchestrator.mjs';
import { LocalExecutor } from '../src/core/executor.mjs';

const [dbPath, auditFile, ws] = process.argv.slice(2);
const db = openDb(dbPath);
const taskId = db.one(`SELECT id FROM tasks ORDER BY created_at LIMIT 1`).id;
mkdirSync(join(ws, '..', `nar-xproc-${process.pid}`), { recursive: true });

class EgressScriptExecutor extends LocalExecutor {
  constructor(auditFile, events) { super(); this.egress = { auditFile }; this.events = events; this.i = 0; }
  async execute(cmd, workspace, limits = {}) {
    if (this.i < this.events.length) {
      const ev = this.events[this.i++];
      writeFileSync(this.egress.auditFile,
        `${JSON.stringify({ ts: Date.now() / 1000, phase: 'request', host: ev.host, allowed: ev.allowed })}\n`,
        { flag: 'a' });
    }
    return { code: 0, stdout: 'ok\n', stderr: '', truncated: false, timedOut: false, durationMs: 1 };
  }
}
const events = [{ host: 'registry.npmjs.org', allowed: false }];
const HANDOFF = {
  artifacts: [{ path: 'out.txt', kind: 'code' }],
  interface_contract: 'out.txt 里是 ok',
  acceptance_evidence: '跑了 cat out.txt，输出 ok',
};
const r = await orchestrate(db, {
  taskId, workspace: ws,
  exec: new EgressScriptExecutor(auditFile, events),
  narrativeDir: join(ws, '..', `nar-xproc-${process.pid}`), maxCycles: 3, commit: false, verify: false,
  makeClient: () => new LlmClient({ mode: 'fake', fake: makeFake([
    { stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'c_1', name: 'run_command', args: { file: 'true', args: ['#1'] } }], usage: { inputTokens: 100, outputTokens: 10 } },
    { stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'c_2', name: 'write_file', args: { path: 'out.txt', content: 'ok' } }], usage: { inputTokens: 100, outputTokens: 10 } },
    { stopReason: 'tool_call', content: [{ type: 'tool_call', id: 'c_3', name: 'submit_handoff', args: HANDOFF }], usage: { inputTokens: 100, outputTokens: 10 } },
  ]), fakePricing: { input: 1, output: 1 } }),
});
console.log(r.kind + (r.breach ? ' ' + r.breach.key : ''));
db.close();
