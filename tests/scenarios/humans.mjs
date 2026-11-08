// 离线场景集的"真人"：经看板的 HTTP 接口做事（与浏览器里点按钮走同一条路，带各自的令牌），
// 按自己的工作风格来看、来答，并按种子注入真人会犯的错。
//
// 风格：
//   controller 掌控型：上班时间每 20 分钟看一次；每条事项都先打开任务页再答；签收前看改动
//   delegator  授权型：一天看两次（10 点、16 点）；只答点了自己名的；一口气批完，不看任务页
//   sampler    抽查型：每 2 小时看一次；随机打开一两个任务页看看
//   absent     不在：前 absentDays 天完全不看（休假、出差），之后按 sampler
//
// 注入的错（各自按概率，种子固定）：
//   wrong      答错了：先答一个错的选项，过一阵发现了再纠正（重答 → 不行就补一条修正）
//   stale      旧页面：先打开任务页，隔一阵（期间别人可能已经答了）照着旧页面答
//   double     连点两下：同一个答复几乎同时发两次
//   race       抢答：同一条事项有几个合格应答人时，两人在同一瞬间各答一个
//   mind       改主意：对一个正在做的任务发一条修正（掌控型与负责人）
//
// 每个动作的结果都记下来（状态码、报错原文），驱动器汇总成"系统怎么接住真人的错"。

import { rng } from './world.mjs';

const H = 3600_000, M = 60_000;
const WORK_START = 9, WORK_END = 18;

/** 本地钟点（场景里一律按 UTC 算"上班时间"，与部署日历无关 —— 要测的是人什么时候来，不是日历）。 */
const hourOf = (at) => new Date(at).getUTCHours() + new Date(at).getUTCMinutes() / 60;
const working = (at) => { const d = new Date(at).getUTCDay(); const h = hourOf(at); return d !== 0 && d !== 6 && h >= WORK_START && h < WORK_END; };

export function makeHumans({ users, base, clock, seed, errorRates = {}, absentDays = 2, log }) {
  const r = rng(seed ^ 0x5eed);
  const rate = { wrong: 0.1, stale: 0.1, double: 0.08, race: 0.5, mind: 0.03, ...errorRates };
  const stats = new Map(users.map((u) => [u.userId, { name: u.name, style: u.style, checkins: 0, interrupted: 0, answered: 0, signoffs: 0, pageViews: 0, waits: [], errors: [] }]));
  const startedAt = clock.now();
  const next = new Map(users.map((u) => [u.userId, startedAt]));
  const pendingFix = [];   // { at, user, q, body } 答错了、过一阵再纠正
  const pendingStale = []; // { at, user, q, body } 打开了页面、过一阵照旧页面答
  const http = [];         // { route, ms, status }
  const outcomes = [];     // { kind, user, q, status, error }

  const req = async (u, method, path, body = null, headers = {}) => {
    const t0 = performance.now();
    let status = 0, json = null;
    try {
      const res = await fetch(`${base}${path}`, { method, headers: { 'x-superintern-token': u.token, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      status = res.status;
      try { json = await res.json(); } catch { json = null; }
    } catch (e) { json = { error: String(e?.message ?? e) }; }
    http.push({ route: `${method} ${path.replace(/\/(t|pj|q|n)_[0-9a-f]{12}/g, '/:id').replace(/\?.*$/, '')}`, ms: performance.now() - t0, status });
    return { status, json };
  };
  const errText = (j) => { const e = j?.error; return typeof e === 'string' ? e : e?.message ?? (e ? JSON.stringify(e) : null); };

  /** 这个人此刻该答的事项（库里按 addressed_to 取 —— 与看板"我的待办"同一口径）。 */
  const mine = (db, userId) => db.all(`SELECT q.id, q.task_id, q.text, q.level, q.asked_at, q.addressed_to FROM questions q
      JOIN tasks t ON t.id=q.task_id WHERE q.status IN ('open','escalated') ORDER BY q.asked_at`)
    .filter((q) => { const to = JSON.parse(q.addressed_to || '[]'); return !to.length || to.includes(userId); })
    .filter((q) => !db.one(`SELECT 1 FROM answers WHERE question_id=? AND user_id=? LIMIT 1`, q.id, userId));

  /** 一条事项该怎么答（按标记分）。返回 { how: 'answer'|'signoff', body }。 */
  const decide = (q, { wrong = false } = {}) => {
    const t = q.text;
    if (t.startsWith('【签收】')) return { how: 'signoff', accept: true };
    if (t.startsWith('【验收没过】')) return { how: 'answer', body: '接着修：看输出是数值算错了' };
    // 合并冲突：两边各自新加了行时该选 D（都留）；答错的人选 A（取任务这一侧）—— 另一边新加的东西就丢了
    if (/合不进项目分支：合并有冲突/.test(t)) return { how: 'answer', body: wrong ? 'A' : t.includes('(D) **两边都保留') ? 'D' : 'B' };
    if (t.startsWith('【合并卡住】') || t.startsWith('【集成冲突】')) return { how: 'answer', body: 'A' };
    if (t.startsWith('【停等】') || t.startsWith('【空转】')) return { how: 'answer', body: '接着做' };
    return { how: 'answer', body: wrong ? 'B' : 'A' };
  };

  const answer = async (u, q, d, kind = 'answer', headers = {}) => {
    const res = d.how === 'signoff'
      ? await req(u, 'POST', `/api/tasks/${q.task_id}/signoff`, { accept: d.accept, reason: d.reason ?? null }, headers)
      : await req(u, 'POST', `/api/tasks/${q.task_id}/answer`, { questionId: q.id, body: d.body }, headers);
    // 抢答 / 连点 / 旧页面：成功了也记下回给人的是什么（输的那一方被告知了没有）
    const said = kind !== 'answer' && res.status < 400 ? JSON.stringify(res.json?.result ?? null).slice(0, 300) : null;
    outcomes.push({ kind, user: u.name, q: q.id, mark: (q.text.match(/^【[^】]+】/) ?? ['(无标记)'])[0], status: res.status, error: res.status >= 400 ? errText(res.json) : null, said });
    return res;
  };

  /** 一个人此刻来看一次。 */
  async function visit(db, u, at) {
    const s = stats.get(u.userId);
    s.checkins++;
    // 打开看板首页（每个人每次来都会先看一眼列表）
    await req(u, 'GET', '/api/tasks');
    // 改主意：对一个正在做的任务发一条修正（掌控型与负责人才会这么干）
    if ((u.style === 'controller' || u.lead) && r() < rate.mind) {
      const t = db.one(`SELECT id, title FROM tasks WHERE status IN ('running','waiting') AND project_order > 0 ORDER BY random() LIMIT 1`);
      if (t) {
        const res = await req(u, 'POST', `/api/tasks/${t.id}/say`, { body: `改一下「${t.title}」：value 的算式旁边加一行注释，写清是哪几个模块相加。`, kind: 'correction' });
        outcomes.push({ kind: 'mind', user: u.name, q: t.id, mark: '(改主意)', status: res.status, error: res.status >= 400 ? errText(res.json) : null, said: JSON.stringify(res.json?.result ?? null).slice(0, 300) });
        log?.(`改主意 ${t.title}（${u.name}）：${res.status}`);
      }
    }
    const items = mine(db, u.userId);
    if (!items.length) return;
    s.interrupted++;
    if (u.style === 'sampler' || u.style === 'absent') {
      for (const tid of [...new Set(items.map((q) => q.task_id))].slice(0, 2)) { await req(u, 'GET', `/api/tasks/${tid}`); s.pageViews++; }
    }
    for (const q of items) {
      // 抢答：这条有好几个合格应答人、而另一个人也在线 → 两人同一瞬间各答一个
      const to = JSON.parse(q.addressed_to || '[]');
      if (u.style === 'controller') { await req(u, 'GET', `/api/tasks/${q.task_id}`); s.pageViews++; }
      if (to.length > 1 && r() < rate.race) {
        const other = users.find((x) => x.userId !== u.userId && to.includes(x.userId));
        if (other && !db.one(`SELECT 1 FROM answers WHERE question_id=? AND user_id=?`, q.id, other.userId)) {
          const d1 = decide(q), d2 = d1.how === 'answer' && /^[AB]$/.test(d1.body) ? { ...d1, body: d1.body === 'A' ? 'B' : 'A' } : d1;
          const [r1, r2] = await Promise.all([answer(u, q, d1, 'race'), answer(other, q, d2, 'race')]);
          s.answered++; stats.get(other.userId).answered++;
          s.waits.push(at - q.asked_at);
          log?.(`抢答 ${q.id}：${u.name}=${d1.body ?? 'signoff'}(${r1.status}) ${other.name}=${d2.body ?? 'signoff'}(${r2.status})`);
          continue;
        }
      }
      // 旧页面：先打开，过 15–90 分钟再照着答
      if (r() < rate.stale) {
        await req(u, 'GET', `/api/tasks/${q.task_id}`); s.pageViews++;
        pendingStale.push({ at: at + (15 + Math.floor(r() * 75)) * M, user: u, q, d: decide(q) });
        continue;
      }
      const wrong = (/^(?!【)/.test(q.text) || /合不进项目分支：合并有冲突/.test(q.text)) && r() < rate.wrong;   // 普通的 A/B 取舍与合并冲突上答错
      const d = decide(q, { wrong });
      const dbl = r() < rate.double;
      if (dbl) {
        const key = `dbl-${q.id}-${u.userId}`;
        const [r1, r2] = await Promise.all([answer(u, q, d, 'double', { 'idempotency-key': key }), answer(u, q, d, 'double', { 'idempotency-key': key })]);
        log?.(`连点 ${q.id}（${u.name}）：${r1.status} / ${r2.status}`);
      } else await answer(u, q, d);
      if (d.how === 'signoff') s.signoffs++; else s.answered++;
      s.waits.push(at - q.asked_at);
      if (wrong) pendingFix.push({ at: at + (20 + Math.floor(r() * 100)) * M, user: u, q, d: decide(q) });
    }
  }

  /** 到点的纠正与旧页面答复。 */
  async function followUps(db, at) {
    for (const list of [pendingFix, pendingStale]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const f = list[i];
        if (f.at > at) continue;
        list.splice(i, 1);
        if (list === pendingStale) {
          const st = db.one(`SELECT status FROM questions WHERE id=?`, f.q.id)?.status;
          const res = await answer(f.user, f.q, f.d, 'stale');
          log?.(`旧页面 ${f.q.id}（${f.user.name}，事项此刻 ${st}）：${res.status}${res.status >= 400 ? ' ' + errText(res.json) : ''}`);
          if (res.status < 400) stats.get(f.user.userId).answered++;
        } else {
          // 纠正：先试着重答；系统不让重答（已答过）就发一条修正，点着这条事项说
          const res = await answer(f.user, f.q, f.d, 'reanswer');
          let fix = null;
          if (res.status >= 400) {
            fix = await req(f.user, 'POST', `/api/tasks/${f.q.task_id}/say`, { body: `刚才那条（${f.q.id}）我选错了，应该是 A：照字面加。`, kind: 'correction', about: f.q.id });
            outcomes.push({ kind: 'correction', user: f.user.name, q: f.q.id, mark: '(纠正)', status: fix.status, error: fix.status >= 400 ? errText(fix.json) : null });
          }
          log?.(`纠正 ${f.q.id}（${f.user.name}）：重答 ${res.status}${fix ? `，修正 ${fix.status}` : ''}`);
        }
      }
    }
  }

  const due = (u, at) => {
    if (u.style === 'absent' && at < startedAt + absentDays * 24 * H) return false;
    if (!working(at)) return false;
    return at >= next.get(u.userId);
  };
  const schedule = (u, at) => {
    const gap = u.style === 'controller' ? 20 * M : u.style === 'delegator' ? null : 2 * H;
    if (gap) { next.set(u.userId, at + gap); return; }
    // 授权型：下一个 10 点或 16 点
    const d = new Date(at); const h = hourOf(at);
    const target = h < 10 ? 10 : h < 16 ? 16 : 34;
    next.set(u.userId, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + target * H);
  };

  return {
    stats, http, outcomes,
    async step(db, at) {
      await followUps(db, at);
      for (const u of users) {
        if (!due(u, at)) continue;
        await visit(db, u, at);
        schedule(u, at);
      }
    },
    /** 下一件人要做的事在什么时候（驱动器跳时用：不跳过人该来的时刻）。 */
    nextEventAt(at) {
      const ts = [...pendingFix, ...pendingStale].map((f) => f.at);
      for (const u of users) ts.push(Math.max(next.get(u.userId), at));
      return Math.min(...ts.filter((t) => t > at), Infinity);
    },
    pending: () => pendingFix.length + pendingStale.length,
  };
}
