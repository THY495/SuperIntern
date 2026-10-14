// 事项换了收件人，新收件人要收到推送（写入收口收口时查出）：
//
// 通知按事项一次性发（notifyPendingQuestions 只挑 notified_at 为空的），而"换收件人"的写入散在 9 个文件里，
// 有的顺手清 notified_at（交接），有的不清（转交、超时转下一行、全员弃权转负责人）—— 不清的那几条路上，
// 新收件人永远收不到推送，只能碰巧在看板或摘要里看见。
//
// 断言：每条换人路径之后，新加进来的人收到一次推送；已经推过的人不重复推；收件人只是变少不推任何人。
//
// 跑：node tests/question-notify.test.mjs

import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { applyTemplate, rulesOf, saveRules, routeQuestion, advanceRoute, transferQuestion } from '../src/core/routing.mjs';
import { notifyPendingQuestions, setUserChannel } from '../src/core/users.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const section = (s) => console.log(`\n── ${s}`);

const db = openDb(':memory:');
const lead = ensureOwner(db, 'lead').userId;
const t0 = now();
const addUser = (name, tags = []) => {
  const id = newId('u');
  db.run(`INSERT INTO users (id,display_name,role,domain_tags,created_at) VALUES (?,?,'member',?,?)`, id, name, JSON.stringify(tags), t0);
  setUserChannel(db, { userId: id, kind: 'ntfy', target: `https://ntfy.example/${name}`, byUserId: lead });
  return id;
};
setUserChannel(db, { userId: lead, kind: 'ntfy', target: 'https://ntfy.example/lead', byUserId: lead });
const alice = addUser('alice', ['frontend']);
const bob = addUser('bob', ['backend']);
const name = { [lead]: 'lead', [alice]: 'alice', [bob]: 'bob' };

// 推送去了谁那里：按 ntfy 地址末段认人
const pushed = [];
const fetchFn = async (url) => { pushed.push(String(url).split('/').pop()); return { ok: true, status: 200, text: async () => '' }; };
const notifyRound = async () => { pushed.length = 0; await notifyPendingQuestions(db, { env: {}, fetchFn }); return [...pushed].sort(); };

applyTemplate(db, { key: '', name: 'solo', userId: lead });
const rules = rulesOf(db, '').map(({ id, project_id, template, created_at, ...r }) => r);
rules.push({ decision_type: 'spec_choice', scope: 'src', position: 0, recipients: ['group:backend'], quorum: '1', conflict_policy: 'block', timeout_action: 'next', timeout_after: '8h' });
rules.push({ decision_type: 'spec_choice', scope: 'src', position: 1, recipients: ['user:lead'], quorum: '1', conflict_policy: 'block', timeout_action: 'hang', timeout_after: null });
saveRules(db, { key: '', rules, userId: lead });
const mkTask = () => {
  const id = newId('t');
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'t','running',?)`, id, lead, t0);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at) VALUES (?,?,1,'g','改 src/x.mjs','d','[]',?,?)`, newId('c'), id, t0, t0);
  return id;
};
const mkQ = (taskId) => {
  const id = newId('q');
  db.run(`INSERT INTO questions (id,task_id,level,level_source,text,default_action,asked_at,status) VALUES (?,?,2,'classifier','q','d',?,'open')`, id, taskId, t0);
  db.tx(() => routeQuestion(db, { questionId: id, decisionType: 'spec_choice', typeSource: 'self', at: t0 }));
  return id;
};

section('① 新事项：收件人收到一次，再来一轮不重复');
const task = mkTask();
const q = mkQ(task);
eq((await notifyRound()).map((x) => x), ['bob'], '路由到 backend 组的 bob：推给 bob');
eq(await notifyRound(), [], '再来一轮：不重复推');

section('② 转交：被转交的人要收到');
transferQuestion(db, { questionId: q, to: [`user:${alice}`], byUserId: lead });
eq(await notifyRound(), ['alice'], '转给 alice：推给 alice（原来不推 —— notified_at 没清）');
eq(await notifyRound(), [], '再来一轮：不重复推');

section('③ 超时转下一行：下一行的人要收到');
const q2 = mkQ(task);
await notifyRound();
db.tx(() => advanceRoute(db, { questionId: q2, at: t0 + 9 * 3600_000 }));
eq(await notifyRound(), ['lead'], '超时 next → lead：推给 lead');

section('④ 收件人只是变少：谁都不推');
const q3 = mkQ(task);
transferQuestion(db, { questionId: q3, to: [`user:${alice}`, `user:${bob}`], byUserId: lead });
await notifyRound();
transferQuestion(db, { questionId: q3, to: [`user:${alice}`], byUserId: lead });
eq(await notifyRound(), [], '从 alice + bob 收窄到 alice：alice 已经推过，不再推');

section('⑤ 升级（v29 → v30）：已经推过的旧事项不重推');
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'si-qn-'));
  try {
    const p = join(dir, 'state.db');
    const old = openDb(p, { migrateTo: 29 });
    old.run(`INSERT INTO users (id, display_name, role, created_at) VALUES ('u_l', 'l', 'lead', 1), ('u_a', 'a', 'member', 1)`);
    old.run(`INSERT INTO user_channels (id, user_id, channel, target) VALUES ('ch1', 'u_a', 'ntfy', 'https://ntfy.example/a')`);
    old.run(`INSERT INTO tasks (id, owner_id, title, status, created_at) VALUES ('t_1', 'u_l', 't', 'running', 1)`);
    old.run(`INSERT INTO questions (id, task_id, level, level_source, text, default_action, asked_at, status, addressed_to, notified_at)
             VALUES ('q_done', 't_1', 2, 'classifier', 'q', 'd', 1, 'open', '["u_a"]', 5), ('q_new', 't_1', 2, 'classifier', 'q', 'd', 1, 'open', '["u_a"]', NULL)`);
    old.close();
    const d = openDb(p);
    eq(JSON.parse(d.one(`SELECT notified_to FROM questions WHERE id='q_done'`).notified_to), ['u_a'], '推过的旧事项：notified_to 回填为当时的收件人');
    pushed.length = 0;
    await notifyPendingQuestions(d, { env: {}, fetchFn });
    eq(pushed, ['a'], '只推了从没推过的那一条，推过的不重推');
    d.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

void name;
db.close();
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
