// 离线场景集的假模型：CLI 子进程经 `--mode fake --fake-module tests/scenarios/fake-model.mjs` 载入。
//
// 默认导出 ({ db, verb, id, home }) => provider。每个角色按**请求本身 + 库里的状态**现算回复，不按调用次序：
// 子进程随时会被挂起、重来、并发，按次序吐的脚本一错位就全错。剧本（world.mjs 的 profile）从
// <home>/scenario.json 读，按任务的 project_order 对上。
//
// 只模拟"一个守规矩的模型"——要测的是系统在真人和规模下的行为，不是模型的错。模型那一侧的毛病
// （交接写错、越界）只按剧本出现，好让系统的那几条路（越界批准、验收没过、冲突）被真的走到。

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRoleFake } from '../../src/llm/providers.mjs';
import { moduleSource, testSource } from './world.mjs';

const usage = { inputTokens: 1800, outputTokens: 240 };
let seq = 0;
const call = (name, args) => ({ stopReason: 'tool_call', usage, content: [{ type: 'tool_call', id: `c_${process.pid}_${++seq}`, name, args }] });
const text = (t) => ({ stopReason: 'end_turn', usage, content: [{ type: 'text', text: t }] });

export default function scenarioFake({ db, home, id = null }) {
  const scen = JSON.parse(readFileSync(join(home, 'scenario.json'), 'utf8'));
  const byOrder = new Map(scen.tasks.map((t) => [t.order, t]));
  const note = (o) => { try { appendFileSync(join(home, 'fake-notes.jsonl'), JSON.stringify({ at: Date.now(), pid: process.pid, ...o }) + '\n'); } catch { /* 尽力 */ } };
  const taskOf = (taskId) => {
    const t = db.one(`SELECT id, project_order FROM tasks WHERE id=?`, taskId);
    return t ? { ...byOrder.get(t.project_order), taskId: t.id } : null;
  };
  const audits = (action, taskId) => db.one(`SELECT count(*) n FROM audit_log WHERE action=? AND target_id=?`, action, taskId).n;
  const allText = (canon) => [canon.system ?? '', ...(canon.messages ?? []).flatMap((m) => (m.content ?? []).map((b) => b.text ?? '').concat((m.results ?? []).map((r) => String(r.content ?? ''))))].join('\n');
  /** 这个请求是哪个任务的：执行器从 cacheKey 取节点；其次是 CLI 子进程的参数（run / plan <任务 id>）；再次在正文里找任务 id。 */
  const taskFromCanon = (canon) => {
    const nodeId = String(canon.cacheKey ?? '').startsWith('node:') ? canon.cacheKey.slice(5) : null;
    if (nodeId) { const n = db.one(`SELECT task_id FROM nodes WHERE id=?`, nodeId); if (n) return { nodeId, ...taskOf(n.task_id) }; }
    if (id) { const t = taskOf(id); if (t?.order) return t; }
    const ids = [...new Set(allText(canon).match(/\bt_[A-Za-z0-9_-]{6,}/g) ?? [])];
    for (const id of ids) { const t = taskOf(id); if (t?.order) return t; }
    return null;
  };

  const planner = (canon) => {
    const t = taskFromCanon(canon);
    if (!t?.order) { note({ role: 'planner', miss: true }); return call('submit_plan', { nodes: [], rationale: '?' }); }
    const k = t.order;
    return call('submit_plan', {
      rationale: '先实现模块，再写测试把数值钉住。',
      nodes: [
        { key: 'n1', title: `实现 mods/m${k}/index.mjs`, spec: `导出 value = ${k}${t.deps.map((d) => ` + m${d}.value`).join('')}。只动 mods/m${k}/。`,
          acceptance: `node -e "import('./mods/m${k}/index.mjs').then(m => process.exit(m.value === ${t.value} ? 0 : 1))" 退出码 0`,
          rules: [], depends_on: [], risk_tier: 'normal', model_tier: 'standard' },
        { key: 'n2', title: `写 mods/m${k}/index.test.mjs`, spec: `node:test 用例，断言 value 等于 ${t.value}。`,
          acceptance: `node --test mods/m${k}/index.test.mjs 退出码 0，1 个用例通过`,
          rules: [], depends_on: ['n1'], risk_tier: 'normal', model_tier: 'standard' },
      ],
    });
  };

  /** 执行器：一步之内看对话走到哪了（之前调过哪些工具、交接有没有被拒），再决定这一轮。 */
  const executor = (canon) => {
    const t = taskFromCanon(canon);
    if (!t?.order) { note({ role: 'executor', miss: true, cacheKey: canon.cacheKey }); return text('不知道这是哪个任务'); }
    const node = db.one(`SELECT id, title FROM nodes WHERE id=?`, t.nodeId);
    const k = t.order;
    const isImpl = /index\.mjs/.test(node.title) && !/test/.test(node.title);
    const done = (canon.messages ?? []).filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((b) => b.type === 'tool_call').map((b) => b.name));
    const results = (canon.messages ?? []).filter((m) => m.role === 'tool_results').flatMap((m) => m.results);
    const lastSubmit = [...results].reverse().find((r) => r.name === 'submit_handoff');
    const ws = join(home, 'workspaces', t.taskId);

    // 剧本 ask：实现那一步第一次开工先问一个规格取舍（Ⅱ级、带默认）
    if (isImpl && t.profile === 'ask' && !done.length && !db.one(`SELECT 1 FROM questions WHERE task_id=? AND status IN ('answered','defaulted') LIMIT 1`, t.taskId)) {
      return call('raise_question', { level: 2, kind: 'spec',
        text: `m${k} 的 value 要不要把依赖的 value 也加进去？规格写的是"加上依赖的 value"，但依赖模块的 value 本身已经含了它的依赖。A：照字面加（${t.value}）；B：只加编号。`,
        default_action: 'A：照字面加', blocked_by: '完成定义：断言 value 等于 ' + t.value,
        work_done: '读了规格与依赖模块，还没写文件。', plan_after_answer: 'A：照字面写；B：只加编号并在交接里说明与完成定义不符。' });
    }
    if (!done.includes('write_file')) {
      if (!isImpl) return call('write_file', { path: `mods/m${k}/index.test.mjs`, content: testSource(t) });
      // 剧本 flaky：第一版算错（任务级验收会不过）；"验收没过"挂过一次之后改对
      const wrong = t.profile === 'flaky' && !audits('task_verify_failed', t.taskId) && !db.one(`SELECT 1 FROM questions WHERE task_id=? AND text LIKE '【验收没过】%' LIMIT 1`, t.taskId);
      return call('write_file', { path: `mods/m${k}/index.mjs`, content: moduleSource(t, { wrong }) });
    }
    const wrote = done.filter((n) => n === 'write_file').length;
    // 剧本 scope：实现那一步顺手写一份范围外的说明（没被拒过、也没被批准过才写）
    if (isImpl && t.profile === 'scope' && wrote === 1 && !audits('scope_granted', t.taskId) && !audits('scope_declined', t.taskId)) {
      return call('write_file', { path: `docs/m${k}.md`, content: `# m${k}\n\nvalue = ${t.value}\n` });
    }
    // 剧本 shared：实现那一步往共享登记表末尾加一行
    if (isImpl && t.profile === 'shared' && !done.includes('read_file')) return call('read_file', { path: 'shared/registry.mjs' });
    if (isImpl && t.profile === 'shared' && wrote === 1) {
      const cur = existsSync(join(ws, 'shared', 'registry.mjs')) ? readFileSync(join(ws, 'shared', 'registry.mjs'), 'utf8') : 'export const registry = {};\n';
      if (!cur.includes(`registry.m${k} `)) return call('write_file', { path: 'shared/registry.mjs', content: `${cur}registry.m${k} = ${t.value};\n` });
    }
    if (!isImpl && !done.includes('run_command')) return call('run_command', { file: 'node', args: ['--test', `mods/m${k}/index.test.mjs`] });
    if (lastSubmit && !lastSubmit.isError && !/拒|reject|越界|scope/i.test(String(lastSubmit.content))) return text('已交接');
    const rejected = results.filter((r) => r.name === 'submit_handoff').length;
    if (rejected) note({ role: 'executor', task: k, node: node.title, rejected: String(lastSubmit?.content ?? '').slice(0, 600) });
    if (rejected >= 3) return text('交接一直被拒，停下');
    const artifacts = isImpl ? [{ path: `mods/m${k}/index.mjs`, kind: 'source' }] : [{ path: `mods/m${k}/index.test.mjs`, kind: 'test' }];
    if (isImpl && t.profile === 'shared') artifacts.push({ path: 'shared/registry.mjs', kind: 'source' });
    if (isImpl && t.profile === 'scope' && existsSync(join(ws, 'docs', `m${k}.md`))) artifacts.push({ path: `docs/m${k}.md`, kind: 'doc' });
    return call('submit_handoff', {
      artifacts,
      interface_contract: `mods/m${k}/index.mjs 导出 value（数值，等于 ${t.value}）`,
      acceptance_evidence: isImpl ? `value 按 ${k}${t.deps.map((d) => ` + m${d}`).join('')} 算出` : `node --test mods/m${k}/index.test.mjs 退出码 0，1 pass`,
      ...(isImpl && t.profile === 'scope' && rejected ? { scope_request: { paths: [`docs/m${k}.md`], why: `给 m${k} 留一份说明，后面接手的人看得懂这个数怎么来的；现有范围里放不了说明文件。` } } : {}),
    });
  };

  /** 重规划（人对"验收没过"写了"接着修"、或发了修正）：实现那一步标"需修改"重做，别的不动。 */
  const replanner = (canon) => {
    const t = taskFromCanon(canon);
    if (!t?.order) { note({ role: 'replanner', miss: true }); return text('?'); }
    const nodes = db.all(`SELECT id, title, status FROM nodes WHERE task_id=? AND status <> 'void' ORDER BY created_at`, t.taskId);
    const impl = nodes.find((n) => /index\.mjs/.test(n.title) && !/test/.test(n.title)) ?? nodes[0];
    return call('submit_revision', {
      rationale: '验收输出显示数值不对：重做实现那一步，测试不动。',
      impact: nodes.map((n) => ({ node_id: n.id, mark: n.id === impl.id ? 'needs_change' : 'unaffected', reason: n.id === impl.id ? '数值算错了，要改实现' : '测试断言的是规格里的数，不受影响' })),
      salvage: nodes.filter((n) => n.status === 'done' && n.id === impl.id).map((n) => ({ node_id: n.id, disposition: 'partial', note: 'import 部分留着，数值的算式要改' })),
      changed_nodes: [{ node_id: impl.id, spec: `导出 value，必须等于 ${t.value}（上一版少算了 1）。只动 mods/m${t.order}/。` }],
    });
  };

  return makeRoleFake({
    planner,
    replanner,
    executor,
    verifier: () => call('submit_verdict', { verdict: 'accept', evidence_checked: ['交接记录', '验收命令输出'] }),
    reporter: () => call('submit_report', { summary: '按计划推进。', current_state: '模块已实现、测试通过。', next_steps: '等签收。', uncertainties: '无' }),
    'decision-check': () => text('{"hits":[]}'),
    classifier: () => text('{"kind":"context","urgency":"normal","confidence":0.9,"why":"补充信息"}'),
    '*': (canon) => { note({ role: canon.role, unhandled: true }); return text('{}'); },
  });
}
