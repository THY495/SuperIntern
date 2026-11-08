// 从这里重来：哪些步骤跟着重做（依赖 / 之后的提交 / 闭包）、代码回到哪、先存再回退、撤回事项、签收作废、
// 与编排器互斥（任务租约）、预览之后代码变了就拒、出处（签名消息 + derived_from）、重做时执行器看到什么。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now, insertEdge } from '../src/db/db.mjs';
import { insertQuestion } from '../src/core/questions.mjs';
import { writeParam } from '../src/core/params.mjs';
import { acquireLease, releaseLease } from '../src/db/lease.mjs';
import { rewindPlan, rewindTask, describeRewind, lastRewind } from '../src/core/rewind.mjs';
import { assembleExecutor } from '../src/context/assemble.mjs';
import { roundsOf } from '../src/core/diagnose.mjs';
import { audit } from '../src/db/db.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, m, re) => { try { fn(); bad(m, '期望被拒绝，但成功了'); } catch (e) { (re && !re.test(e.message)) ? bad(m, `报错不对：${e.message}`) : ok(`${m}\n         └ ${String(e.message).split('\n')[0]}`); } };

const TMP = mkdtempSync(join(tmpdir(), 'si-rewind-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
process.env.SUPERINTERN_HOME = join(TMP, 'home');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const put = (ws, rel, text) => { const p = join(ws, ...rel.split('/')); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
const read = (ws, rel) => { try { return readFileSync(join(ws, ...rel.split('/')), 'utf8'); } catch { return null; } };

/**
 * 一个做完了四步的任务：A → B → C（C 依赖 B，B 依赖 A），D 独立。提交顺序 A、B、D、C；E 没改文件（没有提交），依赖 B。
 * 每一步提交的说明里带 `node: <id>`（与编排器一样）。
 */
function fixture(name) {
  const ws = join(TMP, name);
  mkdirSync(ws, { recursive: true });
  git(ws, 'init', '-q'); git(ws, 'config', 'user.email', 't@l'); git(ws, 'config', 'user.name', 't'); git(ws, 'config', 'core.autocrlf', 'false');
  put(ws, 'README.md', '# x\n'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'init');
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const taskId = newId('t'), t0 = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'T','done',?)`, taskId, owner.userId, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'做个小库','只动 src/','测试通过','[]',?,?)`, newId('c'), taskId, t0, t0);
  const ids = {};
  let k = 0;
  for (const key of ['A', 'B', 'C', 'D', 'E']) {
    ids[key] = newId('n');
    db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at,retry_count) VALUES (?,?,?,?,?,'pending','normal','standard',?,2)`,
      ids[key], taskId, `步骤 ${key}`, `做 ${key}`, `${key} 能用`, t0 + (k++));
    db.run(`INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,known_issues,downstream_notes,narrative_ref,validated_at,created_at) VALUES (?,?,1,'[]',?,'[]','',?,?,?)`,
      newId('h'), ids[key], `${key} 的旧接口`, `narratives/${ids[key]}.md`, t0, t0);
    db.run(`UPDATE nodes SET status='done', finished_at=? WHERE id=?`, t0 + 100 + k, ids[key]);
  }
  insertEdge(db, ids.B, ids.A, 'depends_on', t0); insertEdge(db, ids.C, ids.B, 'depends_on', t0); insertEdge(db, ids.E, ids.B, 'depends_on', t0);
  const step = (key, file, text) => { put(ws, file, text); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', `步骤 ${key}\n\nnode: ${ids[key]}`); return git(ws, 'rev-parse', 'HEAD'); };
  const sha = { init: git(ws, 'rev-parse', 'HEAD') };
  sha.A = step('A', 'src/a.js', 'a v1\n');
  sha.B = step('B', 'src/b.js', 'b v1\n');
  sha.D = step('D', 'src/d.js', 'd v1\n');
  sha.C = step('C', 'src/c.js', 'c v1\n');
  // 花费：每步 0.5 美元
  for (const key of Object.keys(ids)) db.run(`INSERT INTO usage_ledger (task_id,node_id,role,model_tier,provider,model_id,input_tokens,output_tokens,micro_usd,billing,ts) VALUES (?,?,'executor','standard','deepseek','deepseek/deepseek-v4-pro',1,1,500000,'computed',?)`, taskId, ids[key], t0);
  return { ws, db, owner, taskId, ids, sha };
}

section('① 预览：这一步本身 + 依赖它的 + 提交排在它后面的；代码回到这一步最后一次提交的父提交');
{
  const f = fixture('plan');
  const p = rewindPlan(f.db, { taskId: f.taskId, nodeId: f.ids.B, workspace: f.ws });
  assert(p.ok, '做完的步骤可以重来');
  eq(p.nodes.map((n) => [n.title, n.why]), [['步骤 B', 'target'], ['步骤 C', 'depends'], ['步骤 D', 'commit'], ['步骤 E', 'depends']], 'B 本身；C、E 依赖它；D 的提交排在 B 之后（代码回去它的产物也没了）；A 不动');
  eq([p.base, p.head, p.moves], [f.sha.A, f.sha.C, true], '代码回到 B 的父提交（A 做完时）');
  eq(p.commits.map((c) => c.sha), [f.sha.C, f.sha.D, f.sha.B], '丢掉的提交：C、D、B');
  eq(p.files.sort(), ['src/b.js', 'src/c.js', 'src/d.js'], '回到旧样子的文件');
  eq(p.spentMicro, 2_000_000, '这几步已花的钱（4 × 0.5）');
  const txt = describeRewind(p, 'zh');
  assert(txt.includes('退回重做的步骤（4 个）') && txt.includes('丢掉 3 个提交') && txt.includes('$2.00') && txt.includes('不删'), '文字版预览：步骤、提交、文件、花费、不删');
  const pe = rewindPlan(f.db, { taskId: f.taskId, nodeId: f.ids.E, workspace: f.ws });
  eq([pe.moves, pe.nodes.map((n) => n.title)], [false, ['步骤 E']], '没改过文件的步骤（E）：代码不动，只重做它（没人依赖它）');
  const pa = rewindPlan(f.db, { taskId: f.taskId, nodeId: f.ids.A, workspace: f.ws });
  eq([pa.base, pa.nodes.length], [f.sha.init, 5], '从第一步重来：回到初始提交，五步全退回');
  // 只读：预览不动库、不动工作区
  eq([f.db.one(`SELECT count(*) n FROM nodes WHERE status='done'`).n, git(f.ws, 'rev-parse', 'HEAD')], [5, f.sha.C], '预览不改库、不动工作区');
}

section('② 不能重来的情形：说清为什么');
{
  const f = fixture('refuse');
  const why = (nodeId, extra) => { extra?.(); return rewindPlan(f.db, { taskId: f.taskId, nodeId, workspace: f.ws }); };
  f.db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,model_tier,created_at) VALUES ('n_pend',?,'没做','x','x','pending','normal','standard',?)`, f.taskId, now());
  assert(/只有做完的步骤/.test(why('n_pend').why), '没做完的步骤：不行');
  assert(/步骤不存在/.test(why('n_nope').why), '不存在的步骤');
  assert(/工作区不在/.test(rewindPlan(f.db, { taskId: f.taskId, nodeId: f.ids.B, workspace: join(TMP, 'gone') }).why), '工作区没了');
  writeParam(f.db, { taskId: f.taskId, key: 'delivery.head', value: f.sha.C, by: { kind: 'user', id: f.owner.userId }, governance: 'constitutional' });
  assert(/已经交付/.test(why(f.ids.B).why), '已交付（分支推出去了）：不行 —— 回退要改写已推送的历史');
  f.db.run(`UPDATE tasks SET merged_at=? WHERE id=?`, now(), f.taskId);
  assert(/合并进项目分支/.test(why(f.ids.B).why), '已合并进项目分支：不行（要改就添加任务）');
  f.db.run(`UPDATE tasks SET merged_at=NULL, status='aborted' WHERE id=?`, f.taskId);
  assert(/已中止/.test(why(f.ids.B).why), '已中止：先恢复');
}

section('③ 确认：先存再回退；步骤退回待执行、重试归零；事项撤回、签收作废；任务回到执行');
{
  const f = fixture('apply');
  // 这几步提的事项、等签收的事项、一条与它们无关的事项（A 提的）
  const qC = insertQuestion(f.db, { taskId: f.taskId, nodeId: f.ids.C, level: 2, text: 'C 的问题' });
  const qA = insertQuestion(f.db, { taskId: f.taskId, nodeId: f.ids.A, level: 2, text: 'A 的问题' });
  const qS = insertQuestion(f.db, { taskId: f.taskId, level: 3, text: '请签收' });
  f.db.run(`UPDATE questions SET decision_type='signoff' WHERE id=?`, qS);
  writeParam(f.db, { taskId: f.taskId, key: 'signoff.status', value: 'pending', by: { kind: 'user', id: null }, governance: 'constitutional' });
  // 工作区里还有没提交的改动
  put(f.ws, 'src/c.js', 'c 改了一半\n'); put(f.ws, 'notes.txt', '新文件\n');
  rejects(() => rewindTask(f.db, { taskId: f.taskId, nodeId: f.ids.B, workspace: f.ws, userId: 'u_other' }), '不是负责人：拒', /负责人/);
  rejects(() => rewindTask(f.db, { taskId: f.taskId, nodeId: f.ids.B, workspace: f.ws, userId: f.owner.userId, expectHead: f.sha.D }), '预览之后代码变了（头对不上）：拒，重新看预览', /重新打开预览/);
  eq(git(f.ws, 'rev-parse', 'HEAD'), f.sha.C, '被拒时工作区没动');
  const r = rewindTask(f.db, { taskId: f.taskId, nodeId: f.ids.B, workspace: f.ws, userId: f.owner.userId, note: '别用全局变量', expectHead: f.sha.C, plaintextToken: f.owner.plaintext });
  eq(git(f.ws, 'rev-parse', 'HEAD'), f.sha.A, '工作区回到 A 做完时');
  eq([read(f.ws, 'src/a.js'), read(f.ws, 'src/b.js'), read(f.ws, 'src/c.js'), read(f.ws, 'notes.txt')], ['a v1\n', null, null, null], 'B、C、D 的产物和没提交的改动都不在工作区了');
  eq(git(f.ws, 'status', '--porcelain'), '', '工作区干净');
  const snap = git(f.ws, 'rev-parse', r.ref);
  eq(git(f.ws, 'rev-parse', `${r.ref}^`), f.sha.C, '回退前的头存在 ref 上（没提交的改动是挂在它上面的一个提交）');
  eq([git(f.ws, 'show', `${r.ref}:src/c.js`), git(f.ws, 'show', `${r.ref}:notes.txt`), git(f.ws, 'show', `${r.ref}:src/d.js`)], ['c 改了一半', '新文件', 'd v1'], '没提交的改动、D 的产物都能从 ref 取回');
  assert(/^[0-9a-f]{40}$/.test(snap), `ref：${r.ref}`);
  const st = Object.fromEntries(f.db.all(`SELECT title, status, retry_count FROM nodes WHERE task_id=?`, f.taskId).map((n) => [n.title, `${n.status}/${n.retry_count}`]));
  eq(st, { '步骤 A': 'done/2', '步骤 B': 'pending/0', '步骤 C': 'pending/0', '步骤 D': 'pending/0', '步骤 E': 'pending/0' }, '退回的步骤待执行、重试次数归零；A 不动');
  eq([qC, qA, qS].map((id) => f.db.one(`SELECT status FROM questions WHERE id=?`, id).status), ['withdrawn', 'open', 'withdrawn'], 'C 提的事项、签收撤回；A 提的不动');
  eq(JSON.parse(f.db.one(`SELECT value FROM params WHERE task_id=? AND key='signoff.status' AND superseded_at IS NULL`, f.taskId).value), 'void', '签收作废');
  eq(f.db.one(`SELECT status FROM tasks WHERE id=?`, f.taskId).status, 'waiting', '任务回到执行（A 的事项还开着 → 等人）');
  const a = JSON.parse(f.db.one(`SELECT payload FROM audit_log WHERE action='task_rewound'`).payload);
  eq([a.fromHead, a.toBase, a.nodes.length, a.commits.length, a.dirty.sort(), a.note], [f.sha.C, f.sha.A, 4, 3, ['notes.txt', 'src/c.js'], '别用全局变量'], '审计：从哪回到哪、几步、几个提交、存起来的改动、人的说明');
  eq(f.db.one(`SELECT count(*) n FROM decisions WHERE task_id=?`, f.taskId).n, 4, '每一步一条工程笔记（为什么重做、旧代码在哪）');
  // 出处：一条签了名的消息，每步一条 derived_from；不进收件箱
  const m = f.db.one(`SELECT * FROM messages WHERE id=?`, a.messageId);
  assert(m && m.body.includes('别用全局变量') && m.consumed_at, '说明记成签了名的消息，已标消费（不进收件箱、不给别的步骤看）');
  eq(f.db.one(`SELECT count(*) n FROM edges WHERE to_id=? AND relation='derived_from'`, a.messageId).n, 4, '每一步挂一条 derived_from 到那条消息');
  // 租约放掉了
  eq(f.db.one(`SELECT expires_at <= ? AS freed FROM leases WHERE resource=?`, now(), `task:${f.taskId}`).freed, 1, '任务租约用完就放掉（编排器接着能拿）');
}

section('④ 与编排器互斥：有编排器拿着任务租约时拒；暂停着的任务回退后仍暂停');
{
  const f = fixture('lease');
  // 别的进程拿着：直接写一行没到期的租约
  f.db.run(`INSERT INTO leases (resource, holder, pid, epoch, acquired_at, heartbeat_at, expires_at, meta) VALUES (?,?,?,?,?,?,?,'{}')`, `task:${f.taskId}`, 'otherhost:1:1', 1, 1, now(), now(), now() + 60_000);
  rejects(() => rewindTask(f.db, { taskId: f.taskId, nodeId: f.ids.B, workspace: f.ws, userId: f.owner.userId }), '编排器在跑：拒（先暂停）', /正在跑/);
  eq(git(f.ws, 'rev-parse', 'HEAD'), f.sha.C, '被拒时工作区没动');
  f.db.run(`DELETE FROM leases`);
  f.db.run(`UPDATE tasks SET status='suspended' WHERE id=?`, f.taskId);
  const r = rewindTask(f.db, { taskId: f.taskId, nodeId: f.ids.D, workspace: f.ws, userId: f.owner.userId });
  eq([r.taskStatus, r.plan.nodes.map((n) => n.title)], ['suspended', ['步骤 D', '步骤 C']], '暂停着的任务回退后仍暂停；从 D 重来：D 本身 + 提交在它后面的 C（B 不动）');
  eq(git(f.ws, 'rev-parse', 'HEAD'), f.sha.B, '代码回到 B 做完时');
}

section('⑤ 重做时执行器看到什么；打回轮次从回退时重新数');
{
  const f = fixture('assemble');
  audit(f.db, { actorKind: 'system', action: 'handoff_rejected', targetType: 'node', targetId: f.ids.B, payload: { errs: ['旧的一轮'] } });
  // 上一次做 B 时挂起过一次（问了人、答了）：回退之后那份复工简报不该再装进来
  const qOld = insertQuestion(f.db, { taskId: f.taskId, nodeId: f.ids.B, level: 2, text: '旧的问题', status: 'answered' });
  const tb0 = now() - 1000;
  f.db.run(`INSERT INTO briefings (id,task_id,node_id,question_id,work_done,blocked_by,plan_after,context_tokens,narrative_ref,valid_from,recorded_at) VALUES (?,?,?,?,'旧的进度','旧的卡点','旧的计划',NULL,NULL,?,?)`,
    newId('b'), f.taskId, f.ids.B, qOld, tb0, tb0);
  assert(assembleExecutor(f.db, { taskId: f.taskId, nodeId: f.ids.B, tier: 'standard', vendorId: 'fake' }).messages[0].content.some((b) => b.text.includes('# 复工简报')), '回退前：B 的装配里有那份复工简报');
  eq(roundsOf(f.db, f.ids.B).length, 1, '回退前：B 有一轮打回');
  rewindTask(f.db, { taskId: f.taskId, nodeId: f.ids.B, workspace: f.ws, userId: f.owner.userId, note: '接口改成 async\n别动 README', plaintextToken: f.owner.plaintext });
  eq(roundsOf(f.db, f.ids.B).length, 0, '回退后：轮次从这里重新数（不算旧规格那一轮的停滞）');
  const self = lastRewind(f.db, f.ids.B), dep = lastRewind(f.db, f.ids.C);
  eq([self.self, self.moved, dep.self, dep.cause, dep.target.title], [true, true, false, 'depends', '步骤 B'], 'lastRewind：B 是被点的那一步，C 是跟着的');
  const text = (nodeId) => assembleExecutor(f.db, { taskId: f.taskId, nodeId, tier: 'standard', vendorId: 'fake' }).messages[0].content.map((b) => b.text).join('\n');
  const tb = text(f.ids.B), tc = text(f.ids.C);
  assert(!tb.includes('# 复工简报'), '回退后：上一次的复工简报不再装进来（那是旧代码上的事）');
  assert(tb.includes('# 这一步被人退回重做') && tb.includes('> 接口改成 async\n> 别动 README') && tb.includes('refs/superintern/rewound/'), 'B：人让重做、原话引用、旧代码在哪个 ref 上');
  assert(tc.includes('# 这一步跟着重做') && tc.includes('「步骤 B」') && tc.includes('用到了它的结果') && tc.includes('是对那一步说的') && tc.includes('> 接口改成 async'), 'C：因为 B 重做而跟着重做；人的话也给它（标明是对 B 说的）');
  const items = JSON.parse(f.db.one(`SELECT items FROM context_assemblies ORDER BY rowid DESC LIMIT 1`).items);
  assert(items.includes('rewind:depends'), '装配记录里记下');
  // B 重做完：新的交接。下游 C 只看见最新那份（原来新旧两份都列）
  f.db.run(`INSERT INTO handoffs (id,node_id,schema_version,artifacts,interface_contract,known_issues,downstream_notes,narrative_ref,validated_at,created_at) VALUES (?,?,1,'[]','B 的新接口','[]','',?,?,?)`,
    newId('h'), f.ids.B, `narratives/${f.ids.B}-2.md`, now() + 5, now() + 5);
  const tc2 = text(f.ids.C);
  assert(tc2.includes('B 的新接口') && !tc2.includes('B 的旧接口') && tc2.split('## 步骤 B').length === 2, '下游的上游交接：同一步做过两次只列最新那份');
  // 做完一次之后就不再说
  audit(f.db, { actorKind: 'agent', action: 'node_done', targetType: 'node', targetId: f.ids.B, payload: {} });
  eq(lastRewind(f.db, f.ids.B), null, '这一步重做完（node_done）之后不再提');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
