// 交付与签收（push + PR + 人工签收）
//
// 跑：node tests/deliver.test.mjs
//
// 远端是本地裸库；GitHub API 用假 fetch。断言的是边界：只交付 done；高风险没签收不开 PR；
// 没 token 只 push 不开 PR 且说清楚；PR 正文来自真相源；打回 = 一条认证的紧急修正。

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner, newId, now } from '../src/db/db.mjs';
import { deliverTask, signOff, signoffOf, parseGithub, remoteFor, finalReport, raiseSignoffQuestion, signoffEvidence } from '../src/core/deliver.mjs';
import { contributionOf, baseHeadOf } from '../src/core/workspace.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m) => (c ? ok(m) : bad(m));
const eq = (a, b, m) => (a === b ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const rejects = (fn, m, re = null) => fn().then(() => bad(m, '没有抛'), (e) => (re && !re.test(e.message) ? bad(m, e.message) : ok(m)));

const TMP = mkdtempSync(join(tmpdir(), 'si-deliver-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力 */ } });
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture({ status = 'done', risk = 'normal', name }) {
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const taskId = newId('t'), t = now();
  db.run(`INSERT INTO tasks (id,owner_id,title,status,created_at) VALUES (?,?,'加 ESM 配置',?,?)`, taskId, owner.userId, status, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), taskId, t, t);
  db.run(`INSERT INTO nodes (id,task_id,title,spec,acceptance,status,risk_tier,created_at) VALUES (?,?,'n','s','a','pending',?,?)`, newId('n'), taskId, risk, t);
  // 工作区：一个提交在 v0/<task> 分支上；远端：裸库
  const ws = join(TMP, `${name}-ws`); mkdirSync(ws);
  git(ws, 'init', '-q', '-b', 'main'); writeFileSync(join(ws, 'a.txt'), '1\n'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'base');
  git(ws, 'checkout', '-q', '-b', `v0/${taskId}`); writeFileSync(join(ws, 'a.txt'), '2\n'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'agent work');
  const bare = join(TMP, `${name}-remote.git`); git(TMP, 'init', '-q', '--bare', bare);
  return { db, taskId, owner, ws, bare, head: git(ws, 'rev-parse', 'HEAD') };
}
const fakeGithub = (calls) => async (url, init = {}) => {
  calls.push({ url, init });
  if (url.endsWith('/pulls')) return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/o/r/pull/7', number: 7 }) };
  return { ok: true, status: 200, json: async () => ({ default_branch: 'master' }) };
};

// ═══════════════════════════════════════════════════════════════════════════
section('1. push 到远端；只交付 done；工作区脏了不交付');
// ═══════════════════════════════════════════════════════════════════════════
{
  const { db, taskId, owner, ws, bare, head } = fixture({ name: 'a' });
  const r = await deliverTask(db, { taskId, workspace: ws, remote: bare, userId: owner.userId, token: null });
  eq(r.head, head, '记下推的 HEAD');
  eq(git(bare, 'rev-parse', `refs/heads/v0/${taskId}`), head, '远端上有这条分支，指向同一提交');
  assert(r.pr === null && r.prSkipped === null, '没给 --pr：不开 PR，也不算跳过');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='task_delivered' AND target_id=?`, taskId).n, 1, '审计 task_delivered');
  eq(JSON.parse(db.one(`SELECT value FROM params WHERE task_id=? AND key='delivery.head' AND superseded_at IS NULL`, taskId).value), head, '参数 delivery.head');

  const nd = fixture({ name: 'b', status: 'running' });
  await rejects(() => deliverTask(nd.db, { taskId: nd.taskId, workspace: nd.ws, remote: nd.bare, userId: nd.owner.userId }), '任务不是 done → 拒', /只能交付已完成/);
  writeFileSync(join(ws, 'dirty.txt'), 'x');
  await rejects(() => deliverTask(db, { taskId, workspace: ws, remote: bare, userId: owner.userId }), '工作区有未提交改动 → 拒', /未提交/);
  db.close(); nd.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('2. PR：要 GitHub 远端、要 token、高风险要签收；正文来自真相源');
// ═══════════════════════════════════════════════════════════════════════════
{
  eq(JSON.stringify(parseGithub('git@github.com:o/r.git')), '{"owner":"o","repo":"r"}', 'ssh 形式');
  eq(JSON.stringify(parseGithub('https://github.com/o/r')), '{"owner":"o","repo":"r"}', 'https 无 .git');
  eq(parseGithub('/tmp/x.git'), null, '本地路径不是 GitHub');

  // 非 GitHub 远端 + --pr：push 照做，PR 说清为什么没开
  let f = fixture({ name: 'c' });
  let r = await deliverTask(f.db, { taskId: f.taskId, workspace: f.ws, remote: f.bare, pr: true, token: 'x', userId: f.owner.userId, fetchFn: fakeGithub([]) });
  assert(r.pr === null && /不是 GitHub/.test(r.prSkipped), '非 GitHub 远端：只 push，说明原因');
  f.db.close();

  // GitHub 远端但没 token：假远端 URL 推不动，所以这里把 push 目标换成裸库、GitHub 判定用 parseGithub 单测覆盖 ——
  // token 缺失的分支单独验：远端字符串是 GitHub 形状时 push 会失败，用 fetch 前的判断顺序保证 token 判定在 push 之后。
  f = fixture({ name: 'd' });
  const calls = [];
  // 高风险 + 没签收 → 拒，而且是在 push **之前**拒（远端上不该出现分支）
  const hi = fixture({ name: 'e', risk: 'high' });
  await rejects(() => deliverTask(hi.db, { taskId: hi.taskId, workspace: hi.ws, remote: 'https://github.com/o/r.git', pr: true, token: 'x',
    userId: hi.owner.userId, fetchFn: fakeGithub(calls) }), '高风险任务没签收 → 不开 PR', /必须先完成签收/);
  eq(calls.length, 0, '没碰 GitHub API');
  // 签收之后放行（远端换成裸库以便 push 成功；GitHub 判定改走 parseGithub 已单测，此处用 fetch 假装成功）
  signOff(hi.db, { taskId: hi.taskId, accept: true, plaintextToken: hi.owner.plaintext, userId: hi.owner.userId });   // 接受也是一条认证答复
  eq(signoffOf(hi.db, hi.taskId), 'accepted', '签收记为 accepted');
  hi.db.close(); f.db.close();

  // 终版报告：有 task_done 汇报就用它；没有就按事实渲染，都不调模型
  f = fixture({ name: 'f' });
  let rep = finalReport(f.db, f.taskId);
  eq(rep.source, 'facts', '没有汇报 → 按事实渲染');
  assert(rep.body.includes('自作主张'), '事实渲染含自作主张段');
  f.db.run(`INSERT INTO reports (id,task_id,trigger,trigger_ref,since_report_id,since_ts,summary,body,facts,generated_by,gaps,trust_label,created_at)
            VALUES (?,?,'task_done',NULL,NULL,0,'做完了','正文','{}','template','[]','agent-generated',?)`, newId('rp'), f.taskId, now());
  rep = finalReport(f.db, f.taskId);
  assert(rep.source.startsWith('report:') && rep.summary === '做完了', '有 task_done 汇报 → 用它');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('3. 开 PR 的请求形状（假 GitHub）');
// ═══════════════════════════════════════════════════════════════════════════
{
  // push 到裸库、但把"远端是 GitHub"这一判定通过 remote 字符串满足：用一个指向裸库的 GitHub 形状 URL 做不到，
  // 所以这里直接测 PR 那一段：先 push 到裸库，再用 GitHub 形状的 remote 重跑并让 git push 打到同一裸库 ——
  // 通过 git 的 url.<base>.insteadOf 把假 GitHub URL 重写到裸库。
  const f = fixture({ name: 'g' });
  git(f.ws, 'config', 'url.' + f.bare.replace(/\\/g, '/') + '.insteadOf', 'https://github.com/o/r.git');
  const calls = [];
  const r = await deliverTask(f.db, { taskId: f.taskId, workspace: f.ws, remote: 'https://github.com/o/r.git', pr: true, token: 'tok',
    userId: f.owner.userId, fetchFn: fakeGithub(calls) });
  eq(r.pr?.url, 'https://github.com/o/r/pull/7', '拿到 PR url');
  eq(r.pr?.base, 'master', 'base 取仓库默认分支');
  const post = calls.find((c) => c.url.endsWith('/pulls'));
  const body = JSON.parse(post.init.body);
  eq(body.head, `v0/${f.taskId}`, 'head 是任务分支');
  eq(body.title, '加 ESM 配置', '标题 = 任务标题');
  assert(body.body.includes('由 SuperIntern 交付') && body.body.includes('自作主张'), '正文含终版报告与交付说明');
  eq(post.init.headers.authorization, 'Bearer tok', 'token 只进请求头');
  eq(JSON.parse(f.db.one(`SELECT value FROM params WHERE task_id=? AND key='delivery.pr_url' AND superseded_at IS NULL`, f.taskId).value),
    'https://github.com/o/r/pull/7', '参数 delivery.pr_url');
  eq(git(f.bare, 'rev-parse', `refs/heads/v0/${f.taskId}`), f.head, '分支真的推到了远端');
  // 没 token：push 照做、PR 跳过并说明
  const calls2 = [];
  const r2 = await deliverTask(f.db, { taskId: f.taskId, workspace: f.ws, remote: 'https://github.com/o/r.git', pr: true, token: '',
    userId: f.owner.userId, fetchFn: fakeGithub(calls2) });
  assert(/GITHUB_TOKEN/.test(r2.prSkipped) && calls2.length === 0, '没 token：不碰 API，提示去填 .env');
  f.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. 签收：接受记参数；打回 = 一条认证的紧急修正');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture({ name: 'h' });
  const nd = fixture({ name: 'i', status: 'running' });
  try { signOff(nd.db, { taskId: nd.taskId, accept: true, userId: nd.owner.userId }); bad('非 done 不能签收'); } catch (e) { ok('非 done 不能签收'); }
  try { signOff(f.db, { taskId: f.taskId, accept: false, reason: '', plaintextToken: f.owner.plaintext, userId: f.owner.userId }); bad('打回要理由'); } catch (e) { ok('打回要理由'); }
  const r = signOff(f.db, { taskId: f.taskId, accept: false, reason: 'README 没更新', plaintextToken: f.owner.plaintext, userId: f.owner.userId });
  eq(r.accepted, false, '打回');
  const m = f.db.one(`SELECT * FROM messages WHERE id=?`, r.messageId);
  assert(m && m.kind === 'correction' && m.urgency === 'urgent' && m.trust_label === 'user-authenticated', '打回是一条 user-authenticated 的紧急 correction');
  assert(m.body.includes('README 没更新'), '理由在正文里');
  eq(signoffOf(f.db, f.taskId), 'rejected', 'signoff.status=rejected');
  eq(f.db.one(`SELECT count(*) n FROM audit_log WHERE action='task_signed_off' AND target_id=?`, f.taskId).n, 1, '审计 task_signed_off');
  f.db.close(); nd.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('5. 签收正文带产物证据：第一次比工作区起点，返工比上次签收的 commit');
// ═══════════════════════════════════════════════════════════════════════════
{
  const f = fixture({ name: 'j' });
  const base = git(f.ws, 'rev-parse', 'HEAD~1');
  // 工作区起点进审计（实际运行时由 ensureWorkspace 写）
  f.db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,'system',NULL,'workspace_created','task',?,?)`,
    now(), f.taskId, JSON.stringify({ dir: f.ws, head: base }));

  const first = raiseSignoffQuestion(f.db, { taskId: f.taskId, head: f.head, branch: `v0/${f.taskId}`, dir: f.ws });
  const t1 = f.db.one(`SELECT text FROM questions WHERE id=?`, first.questionId).text;
  assert(t1.includes('## 产物') && t1.includes('本任务的全部改动'), '第一次签收：正文带本任务全部改动');
  assert(t1.includes('a.txt') && t1.includes('+2'), '贴了文件名与实际行 —— 签收人不用去猜"改没改"');

  // 返工：再提交一次，重新进签收
  writeFileSync(join(f.ws, 'docs.md'), 'page 不是正整数：HTTP 400\n');
  git(f.ws, 'add', '-A'); git(f.ws, 'commit', '-q', '-m', 'rework');
  const head2 = git(f.ws, 'rev-parse', 'HEAD');
  const second = raiseSignoffQuestion(f.db, { taskId: f.taskId, head: head2, branch: `v0/${f.taskId}`, dir: f.ws });
  const t2 = f.db.one(`SELECT text FROM questions WHERE id=?`, second.questionId).text;
  assert(t2.includes('本轮（上次签收'), '返工后的签收：口径是"这一轮改了什么"，不是从头再看一遍');
  assert(t2.includes('page 不是正整数：HTTP 400'), '**最终口径的原文直接贴出来** —— 签收人要看的就是这个');
  assert(!t2.includes('a.txt'), '上一轮已签收过的改动不再重复出现');

  // 没有工作区目录（老任务 / 已清理）→ 不编、也不挡签收
  const g = fixture({ name: 'k' });
  const none = raiseSignoffQuestion(g.db, { taskId: g.taskId, head: g.head, dir: null });
  assert(!g.db.one(`SELECT text FROM questions WHERE id=?`, none.questionId).text.includes('## 产物'), '拿不到工作区就不带证据段，签收照常进行');
  eq(signoffEvidence(f.ws, { since: f.head, head: f.head }), '', '起点与终点相同 → 空');
  f.db.close(); g.db.close();
}

// ═══════════════════════════════════════════════════════════════════════════
section('6. 归属基线 = 与项目分支的 merge-base：集成之前严格等价，集成之后不混别人的产物');
// ═══════════════════════════════════════════════════════════════════════════
// 起因：任务分支把项目分支合进来解冲突之后，"这个任务产出了什么"如果用
// **工作区建立时的头**算，会把同期别的任务合进来的文件算到它头上。
{
  // 项目仓库 P（分支 superintern/<pid>）→ clone 出任务工作区 ws
  const db = openDb(':memory:');
  const owner = ensureOwner(db);
  const projectId = newId('pj'), taskId = newId('t'), t = now();
  const P = join(TMP, 'proj-repo'); mkdirSync(P);
  const branch = `superintern/${projectId}`;
  git(P, 'init', '-q', '-b', branch);
  writeFileSync(join(P, 'a.txt'), '1\n'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'base');
  const P0 = git(P, 'rev-parse', 'HEAD');

  const ws = join(TMP, 'contrib-ws');
  git(TMP, 'clone', '-q', P, ws);
  git(ws, 'checkout', '-q', '-b', `v0/${taskId}`);
  writeFileSync(join(ws, 'mine.txt'), 'task work\n'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'mine 1');
  const H1 = git(ws, 'rev-parse', 'HEAD');

  db.run(`INSERT INTO projects (id,owner_id,title,brief,repo,branch,base_ref,source,status,created_at) VALUES (?,?,'P','',?,?,?,'x','active',?)`,
    projectId, owner.userId, P, branch, P0, t);
  db.run(`INSERT INTO tasks (id,owner_id,project_id,project_order,title,status,created_at) VALUES (?,?,?,1,'T','done',?)`, taskId, owner.userId, projectId, t);
  db.run(`INSERT INTO constitutions (id,task_id,version,goal,scope,definition_of_done,constraints,valid_from,recorded_at)
          VALUES (?,?,1,'g','.','d','[]',?,?)`, newId('c'), taskId, t, t);
  db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,'system',NULL,'workspace_created','task',?,?)`,
    t, taskId, JSON.stringify({ dir: ws, head: P0 }));

  // ── (a) 集成之前：merge-base 就是工作区起点，渲染出来必须一字不差 ─────────────
  const c1 = contributionOf(db, { taskId, dir: ws, head: H1 });
  eq(c1.via, 'merge-base', '(a) 拿得到项目分支 → 走 merge-base 口径');
  eq(c1.base, baseHeadOf(db, taskId), '(a) 集成之前：merge-base == 工作区建立时的头');
  // 走真实入口，比的是**真正发出去的那段正文**，不是重算一遍公式
  const q1 = raiseSignoffQuestion(db, { taskId, head: H1, branch: `v0/${taskId}`, dir: ws });
  const body1 = db.one(`SELECT text FROM questions WHERE id=?`, q1.questionId).text;
  const old1 = signoffEvidence(ws, { since: baseHeadOf(db, taskId), head: H1, rework: false });
  assert(old1 && body1.includes(old1), '(a) **严格泛化**：集成之前发出去的证据段与改动之前一字不差');

  // ── (b) 集成之后：项目分支上有了别人的文件，合进来 ────────────────────────────
  mkdirSync(join(P, 'client'), { recursive: true });
  writeFileSync(join(P, 'client', 'x.js'), 'other task\n'); git(P, 'add', '-A'); git(P, 'commit', '-q', '-m', 'T3 的产物');
  const P1 = git(P, 'rev-parse', branch);
  git(ws, 'fetch', '-q', P, branch); git(ws, 'merge', '-q', '--no-edit', 'FETCH_HEAD');
  const H2 = git(ws, 'rev-parse', 'HEAD');

  const oldFiles = git(ws, 'diff', '--name-only', `${P0}..${H2}`).split('\n').filter(Boolean);
  assert(oldFiles.includes('client/x.js'), '(b) 现状公式确实会混进别人的产物（这就是要修的那个 bug）');
  const c2 = contributionOf(db, { taskId, dir: ws, head: H2 });
  eq(c2.base, P1, '(b) 基线跟着项目分支走到了 P1');
  eq(JSON.stringify(c2.files), JSON.stringify(['mine.txt']), '(b) 只剩这个任务自己的产物');

  // ── (c) 返工那一档按 (C)：这一轮 ∩ 自己的贡献，集成带进来的单独记一行 ──────────
  writeFileSync(join(ws, 'mine.txt'), 'task work\nround 2\n'); git(ws, 'add', '-A'); git(ws, 'commit', '-q', '-m', 'mine 2');
  const H3 = git(ws, 'rev-parse', 'HEAD');
  const c3 = contributionOf(db, { taskId, dir: ws, head: H3 });
  const ev = signoffEvidence(ws, { since: H1, head: H3, rework: true, contribution: c3 });
  assert(ev.includes('round 2'), '(c) 这一轮自己改的东西照贴');
  assert(!ev.includes('other task'), '(c) 集成带进来的内容不进 diff —— 签收人要判的是这一轮');
  assert(/另有 1 个文件是把项目分支合进来带来的/.test(ev) && ev.includes('client/x.js'), '(c) 但要明说"另有 N 个文件是集成带来的"，不是悄悄藏掉');

  // ── (d) 没有项目（旧的独立任务）→ 回落，行为与改动之前完全一致 ────────────────
  const solo = fixture({ name: 'contrib-solo' });
  const soloBase = git(solo.ws, 'rev-parse', 'HEAD~1');
  solo.db.run(`INSERT INTO audit_log (ts,actor_kind,actor_id,action,target_type,target_id,payload) VALUES (?,'system',NULL,'workspace_created','task',?,?)`,
    now(), solo.taskId, JSON.stringify({ dir: solo.ws, head: soloBase }));
  const c4 = contributionOf(solo.db, { taskId: solo.taskId, dir: solo.ws, head: solo.head });
  eq(c4.via, 'workspace_created', '(d) 没有项目分支 → 回落到工作区起点');
  eq(c4.base, soloBase, '(d) 回落值就是现状公式的值');

  db.close(); solo.db.close();
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exitCode = fail ? 1 : 0;
