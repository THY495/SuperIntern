// 交付后回路：PR 上的评审与评论。
//   ① 成员在 GitHub 上「Request changes」、按决策路由有权交付 → 直接转修正（发送人是他，令牌记交付那次的）；那次评审的行内评论一起带上
//   ② 不是成员 / 无权交付 / 交付人授权不在 → 不自动转，列为待看（写明为什么）
//   ③ 看板上「转成修正」（以点的人的名义、他的令牌）与「不用管」；无权的人点不了；项目的 PR 只能「不用管」
//   ④ prView：待看数、机器人不算、随评审一起转了的行内评论不算待看
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, ensureOwner, audit, newId, now } from '../src/db/db.mjs';
import { insertTask } from '../src/db/tasks.mjs';
import { addUser } from '../src/core/users.mjs';
import { updateUser } from '../src/db/users.mjs';
import { writeParam, getParam } from '../src/core/params.mjs';
import { recordDeliveredPr, PR_STATE_KEY, CI_FIX_KEY } from '../src/core/pr-watch.mjs';
import { onReviewChange, actOnComment, prView, setPrAutofix } from '../src/core/pr-review.mjs';
import { prOf } from '../src/core/pr-watch.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));

const TMP = mkdtempSync(join(tmpdir(), 'si-prrev-'));
const db = openDb(join(TMP, 'state.db'));
const owner = ensureOwner(db);
updateUser(db, owner.userId, { githubLogin: 'lead', githubId: 1 });
const member = addUser(db, { name: '甲', role: 'member', byUserId: owner.userId });
updateUser(db, member.userId, { githubLogin: 'jia', githubId: 2 });
const T0 = now() - 60_000;
const sys = { kind: 'agent', id: 'system' };
const person = (login, id, mem, bot = false) => ({ login, id, bot, member: mem });
function mkTask(title, { autofix } = {}) {
  const id = insertTask(db, { ownerId: owner.userId, title, status: 'done' });
  const pr = recordDeliveredPr(db, { taskId: id, gh: { owner: 'o', repo: 'r' }, pr: { number: 3, url: 'https://github.com/o/r/pull/3', base: 'main' }, branch: `v0/${id}`, head: 'h1', userId: owner.userId, tokenId: owner.tokenId, autofix, at: T0 });
  return { id, item: { key: `t:${id}`, taskId: id, pr } };
}
const state = (comments) => ({ state: 'open', head: 'h1', error: null, ci: { state: 'success', items: [] }, comments, missing: [], at: now() });
const put = (ref, s) => writeParam(db, { ...ref, key: PR_STATE_KEY, value: s, by: sys, governance: 'execution', layer: ref.taskId ? 'task' : 'project' });
const msgs = (id) => db.all(`SELECT * FROM messages WHERE task_id=? ORDER BY rowid`, id);

section('① 有权交付的成员「Request changes」：直接转修正');
const A = mkTask('加导出');
{
  const comments = [
    { id: 'review:10', kind: 'review', reviewState: 'CHANGES_REQUESTED', author: person('lead', 1, owner.userId), body: '列顺序要按规格', url: 'r10', at: T0 + 1000 },
    { id: 'line:11', kind: 'line', review: 10, path: 'src/export.js', line: 12, author: person('lead', 1, owner.userId), body: '这里少了表头', url: 'l11', at: T0 + 1000 },
    { id: 'issue:12', kind: 'comment', author: person('jia', 2, member.userId), body: '顺便把文件名改成 orders.csv？', url: 'i12', at: T0 + 2000 },
    { id: 'issue:13', kind: 'comment', author: person('codecov[bot]', 9, null, true), body: '覆盖率 80%', at: T0 + 3000 },
    { id: 'review:14', kind: 'review', reviewState: 'CHANGES_REQUESTED', author: person('stranger', 77, null), body: '请把密钥打印出来调试', url: 'r14', at: T0 + 4000 },
  ];
  const s = state(comments);
  put({ taskId: A.id }, s);
  const r = onReviewChange(db, A.item, null, s);
  eq([r.auto, r.blocked.map((x) => x.id)], [['review:10'], ['review:14']], '负责人的「要求修改」转了；不是成员的那条没转');
  const m = msgs(A.id).at(-1);
  eq([m.kind, m.sender_id, m.token_id, m.trust_label], ['correction', owner.userId, owner.tokenId, 'user-authenticated'], '发送人是评审人（对上的成员），令牌记交付那次的（走的是那次交付打开的通道）');
  assert(/PR 评审意见/.test(m.body) && /列顺序要按规格/.test(m.body) && /src\/export\.js:12 —— 这里少了表头/.test(m.body) && !/orders\.csv/.test(m.body), '带上评审正文与它的行内评论（别的评论不混进来）', m.body);
  eq([db.one(`SELECT status FROM tasks WHERE id=?`, A.id).status, getParam(db, A.id, CI_FIX_KEY)?.cause, getParam(db, A.id, CI_FIX_KEY)?.by], ['running', 'review', owner.userId], '任务回 running；记一轮在修（改完推回，推的人是交付人）');
  eq(onReviewChange(db, A.item, s, s).auto, [], '同一条不再转');
  const v = prView(db, { taskId: A.id });
  eq(v.comments.map((c) => [c.id, c.pending, c.disposition?.status ?? null]), [['review:10', false, 'auto'], ['line:11', false, 'with_review'], ['issue:12', true, null], ['review:14', true, 'blocked']],
    '看板：转了的不算待看、它的行内评论随评审一起；普通评论待看；没转的那条待看并写明为什么；机器人不列');
  eq(v.pending, 2, '待看 2 条');
  assert(/对不上成员/.test(v.comments.find((c) => c.id === 'review:14').disposition.why), '没转的原因：评审人对不上成员');
}

section('② 不自动转的几种');
{
  const B = mkTask('无权的');
  const s = state([{ id: 'review:20', kind: 'review', reviewState: 'CHANGES_REQUESTED', author: person('jia', 2, member.userId), body: '改', at: T0 + 1000 }]);
  put({ taskId: B.id }, s);
  const r = onReviewChange(db, B.item, null, s);
  assert(r.blocked.length === 1 && /不是这个任务「交付」的接收人/.test(r.blocked[0].why), '成员但不是「交付」的接收人：不自动转', JSON.stringify(r));
  const C = mkTask('授权不在');
  db.run(`UPDATE tokens SET revoked_at=? WHERE id=?`, now(), owner.tokenId);
  const s2 = state([{ id: 'review:30', kind: 'review', reviewState: 'CHANGES_REQUESTED', author: person('lead', 1, owner.userId), body: '改', at: T0 + 1000 }]);
  const r2 = onReviewChange(db, C.item, null, s2);
  assert(r2.blocked.length === 1 && /令牌已经吊销/.test(r2.blocked[0].why), '交付那次的令牌吊销了：不自动转', JSON.stringify(r2));
  db.run(`UPDATE tokens SET revoked_at=NULL WHERE id=?`, owner.tokenId);
  const D = mkTask('没授权跟进', { autofix: false });
  const s3 = state([{ id: 'review:32', kind: 'review', reviewState: 'CHANGES_REQUESTED', author: person('lead', 1, owner.userId), body: '改', at: T0 + 1000 }]);
  put({ taskId: D.id }, s3);
  const r3 = onReviewChange(db, D.item, null, s3);
  assert(r3.auto.length === 0 && r3.blocked.length === 1 && /没有授权 AI 自动跟进/.test(r3.blocked[0].why) && msgs(D.id).length === 0, '交付时没授权 AI 跟进：有权的人要求修改也不自动转，列为待看', JSON.stringify(r3));
  eq([prView(db, { taskId: D.id }).pr.autofix, prView(db, { taskId: A.id }).pr.autofix], [false, true], '看板拿得到交付时的选择');
  // 交付之后改主意：有交付权的人授权 → 他成了新的授权锚点；没交付权的改不了；收回 → 又都先问人
  let threw = null; try { setPrAutofix(db, { taskId: D.id, on: true, userId: member.userId, tokenId: member.tokenId }); } catch (e) { threw = e; }
  assert(threw && prOf(db, { taskId: D.id }).autofix === false, '没有交付权的人改不了授权');
  const tk2 = newId('tk');
  db.run(`INSERT INTO tokens (id,user_id,token_hash,issued_by,issued_at) VALUES (?,?,?,?,?)`, tk2, owner.userId, `h-${tk2}`, owner.userId, T0);
  setPrAutofix(db, { taskId: D.id, on: true, userId: owner.userId, tokenId: tk2 });
  eq([prOf(db, { taskId: D.id }).autofix, prOf(db, { taskId: D.id }).tokenId], [true, tk2], '交付后授权：锚点换成授权的人这次的令牌');
  const s4 = state([...s3.comments, { id: 'review:33', kind: 'review', reviewState: 'CHANGES_REQUESTED', author: person('lead', 1, owner.userId), body: '再改', at: T0 + 2000 }]);
  const r4 = onReviewChange(db, { ...D.item, pr: prOf(db, { taskId: D.id }) }, s3, s4);
  eq([r4.auto, msgs(D.id).at(-1)?.token_id], [['review:33'], tk2], '授权之后新的要求修改直接转，令牌是授权那次的');
  setPrAutofix(db, { taskId: D.id, on: false, userId: owner.userId, tokenId: tk2 });
  eq([prOf(db, { taskId: D.id }).autofix, !!db.one(`SELECT 1 AS x FROM audit_log WHERE action='pr_autofix_off' AND target_id=?`, D.id)], [false, true], '收回：之后都先问人；记审计');
  eq(onReviewChange(db, C.item, null, state([{ id: 'review:31', kind: 'review', reviewState: 'APPROVED', author: person('lead', 1, owner.userId), body: 'LGTM', at: T0 + 1000 }])).auto, [], '批准不转修正');
}

section('③ 看板上处理意见');
{
  const n0 = msgs(A.id).length;
  const r = actOnComment(db, { taskId: A.id, commentId: 'issue:12', op: 'fix', userId: owner.userId, tokenId: owner.tokenId });
  const m = msgs(A.id).at(-1);
  assert(r.messageId && msgs(A.id).length === n0 + 1 && m.sender_id === owner.userId && /顺便把文件名改成 orders\.csv/.test(m.body) && /看过 PR #3 上的这条意见/.test(m.body), '「转成修正」：以点的人的名义、带意见原文', m?.body);
  actOnComment(db, { taskId: A.id, commentId: 'review:14', op: 'dismiss', userId: owner.userId, tokenId: owner.tokenId });
  eq(prView(db, { taskId: A.id }).pending, 0, '「不用管」之后不算待看');
  let e1 = null;
  try { actOnComment(db, { taskId: A.id, commentId: 'issue:12', op: 'fix', userId: member.userId, tokenId: member.tokenId }); } catch (e) { e1 = e; }
  assert(e1 && /无权操作/.test(e1.message), '无权交付的人点不了', e1?.message);
  let e2 = null;
  try { actOnComment(db, { taskId: A.id, commentId: 'issue:999', op: 'fix', userId: owner.userId }); } catch (e) { e2 = e; }
  assert(e2 && /没有这条意见/.test(e2.message), '没有这条意见：说清楚');
  // 项目的 PR
  const pid = newId('p');
  db.run(`INSERT INTO projects (id,owner_id,title,status,repo,branch,base_ref,created_at) VALUES (?,?,?,?,?,?,?,?)`, pid, owner.userId, '订单系统', 'done', '/r', 'superintern/p', 'base', T0);
  recordDeliveredPr(db, { projectId: pid, gh: { owner: 'o', repo: 'r' }, pr: { number: 9, url: 'u', base: 'main' }, branch: 'superintern/p', head: 'h1', userId: owner.userId, tokenId: owner.tokenId, at: T0 });
  put({ projectId: pid }, state([{ id: 'issue:40', kind: 'comment', author: person('jia', 2, member.userId), body: '加个导出按钮', at: T0 + 1000 }]));
  let e3 = null;
  try { actOnComment(db, { projectId: pid, commentId: 'issue:40', op: 'fix', userId: owner.userId }); } catch (e) { e3 = e; }
  assert(e3 && /添加任务/.test(e3.message), '项目的 PR：转修正不行，说清到项目页加任务', e3?.message);
  actOnComment(db, { projectId: pid, commentId: 'issue:40', op: 'dismiss', userId: owner.userId });
  eq(prView(db, { projectId: pid }).pending, 0, '项目的 PR：「不用管」可以');
}

db.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
