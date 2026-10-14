// 厂商熔断、备用模型与共享退避。
//   ① 小件：熔断键、full jitter 的界、Retry-After 两种写法
//   ② 熔断器：连续失败 / 失败率打开；冷却中直接拒；到点放一个试探；试探败了冷却翻倍，成了合上
//   ③ 共享退避：服务商说的等多久照办；只说 429 的按 full jitter；成功一次清掉
//   ④ 换用备用：同一次打开期间只记一次；合上 / 主模型又通了一个窗口后结束
//   ⑤ 客户端：主模型重试用尽 → 换备用；熔断开着 → 主模型一次都不打；备用也挂了带上 fallback；验收员不换到执行器那家
//   ⑥ 重试：Retry-After 至少等那么久；超时只再试一次
//   ⑦ 绑定：备用模型的校验；主模型换成备用时备用清掉；被当备用的模型不许删
//   ⑧ 给人看的：部署健康卡一项、守护进程通知的正文
//
// 跑：node tests/llm-health.test.mjs

import { openDb, ensureOwner } from '../src/db/db.mjs';
import { BREAKER, BACKOFF, healthKey, fullJitter, retryAfterMs, gate, report, noteFallback, healthView, makeHealth } from '../src/llm/health.mjs';
import { LlmClient } from '../src/llm/client.mjs';
import { ProviderError } from '../src/core/errors.mjs';
import { registryFor, setBinding, setFallback, bindingOf, removeModel } from '../src/llm/registry.mjs';
import { llmHealthCheck } from '../src/core/deploy-health.mjs';
import { llmHealthNotice } from '../src/core/notify.mjs';

let pass = 0, fail = 0;
const section = (t) => console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`);
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e ? `\n         ${e}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const audits = (db, action) => db.all(`SELECT target_id, payload FROM audit_log WHERE action=? ORDER BY id`, action).map((r) => ({ key: r.target_id, ...JSON.parse(r.payload) }));
const fresh = () => { const db = openDb(':memory:'); const { userId } = ensureOwner(db); return { db, userId }; };

for (const k of ['ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']) process.env[k] ??= 'test-key-never-sent';

// ── ① ─────────────────────────────────────────────────────────────────────
section('① 熔断键、full jitter、Retry-After');
{
  eq(healthKey({ vendorId: 'deepseek', model: 'deepseek-flash' }), 'deepseek', '直连服务商：整家一个键（限流、故障都是整家的）');
  eq(healthKey({ gateway: true, vendorId: 'openrouter', model: 'moonshotai/kimi-k3' }), 'openrouter/moonshotai/kimi-k3', '网关：按网关 / 模型分（后面每个模型的上游各自挂）');
  const xs = Array.from({ length: 200 }, (_, i) => fullJitter(3, BACKOFF, () => i / 200));
  assert(Math.min(...xs) === 0 && Math.max(...xs) < 8000, `full jitter 在 [0, base·2^n) 里：${Math.min(...xs)}…${Math.max(...xs)}`);
  assert(fullJitter(30, BACKOFF, () => 0.999) < BACKOFF.capMs, '有上限');
  eq(retryAfterMs('3'), 3000, 'Retry-After 秒数');
  eq(retryAfterMs('0.5'), 500, 'Retry-After 小数秒');
  const at = Date.parse('2026-10-14T00:00:00Z');
  eq(retryAfterMs('Wed, 14 Oct 2026 00:00:10 GMT', at), 10_000, 'Retry-After HTTP 日期');
  eq(retryAfterMs('soon'), null, '看不懂的 → null');
  eq(retryAfterMs(null), null, '没有 → null');
}

// ── ② ─────────────────────────────────────────────────────────────────────
section('② 熔断器：打开、冷却、试探、翻倍、合上');
{
  const { db } = fresh();
  const K = 'deepseek', t0 = 1_000_000;
  eq(gate(db, K, t0), { ok: true }, '没记录：放行');
  for (let i = 0; i < BREAKER.consecutive - 1; i++) report(db, K, { ok: false, status: 503, error: 'overloaded', at: t0 + i });
  eq(gate(db, K, t0 + 10).ok, true, `连续 ${BREAKER.consecutive - 1} 次：还不开`);
  eq(report(db, K, { ok: false, status: 503, error: 'overloaded', at: t0 + 10 }).transition, 'opened', `第 ${BREAKER.consecutive} 次：打开`);
  eq(audits(db, 'llm_breaker_opened').length, 1, '打开记一条审计');
  eq(audits(db, 'llm_breaker_opened')[0].procs, 1, '审计记下打开前 10 秒的失败来自几个进程（这里是一个）');
  const { db: dp } = fresh();
  for (let i = 0; i < BREAKER.consecutive; i++) report(dp, K, { ok: false, status: 502, at: 100 + i, pid: 9000 + (i % 3) });
  eq(audits(dp, 'llm_breaker_opened')[0]?.procs, 3, '三个编排器同时撞上：procs = 3（判"并行时误开"用）');
  const g = gate(db, K, t0 + 20);
  assert(!g.ok && g.reason === 'open' && g.until === t0 + 10 + BREAKER.coolMs, '冷却中：直接拒，说到几点');
  const probe = gate(db, K, t0 + 10 + BREAKER.coolMs);
  eq(probe, { ok: true, probe: true }, '冷却到了：放一个去试探');
  eq(gate(db, K, t0 + 10 + BREAKER.coolMs + 1).reason, 'probing', '别的进程：有人在试，先别打');
  eq(gate(db, K, t0 + 10 + BREAKER.coolMs + BREAKER.probeMs + 1).probe, true, '试探者死了（占位到期）：别人接着试');
  const tr = report(db, K, { ok: false, status: 503, at: t0 + 100_000 });
  eq(tr.transition, 'reopened', '试探失败：再开');
  eq(db.one(`SELECT cool_ms FROM llm_health WHERE key=?`, K).cool_ms, BREAKER.coolMs * 2, '冷却翻倍');
  assert(audits(db, 'llm_breaker_opened')[1]?.reopened === true, '再开的审计标了 reopened（守护进程据此不重复通知）');
  eq(gate(db, K, t0 + 100_000 + BREAKER.coolMs * 2).probe, true, '翻倍的冷却到了：再试');
  eq(report(db, K, { ok: true, at: t0 + 300_000 }).transition, 'closed', '试探成了：合上');
  const closed = audits(db, 'llm_breaker_closed')[0];
  assert(closed && closed.openForMs === 300_000 - 100_000, `合上记审计，带开了多久（${closed?.openForMs}）`);
  const row = db.one(`SELECT state, fails, cool_ms FROM llm_health WHERE key=?`, K);
  eq([row.state, row.fails, row.cool_ms], ['closed', 0, 0], '合上后计数、冷却归零');
  // 反复打开：冷却封顶
  const { db: d2 } = fresh();
  let at = 0;
  for (let i = 0; i < BREAKER.consecutive; i++) report(d2, K, { ok: false, status: 500, at: at++ });
  for (let i = 0; i < 10; i++) { at += BREAKER.coolMaxMs + 1; gate(d2, K, at); report(d2, K, { ok: false, status: 500, at }); }
  eq(d2.one(`SELECT cool_ms FROM llm_health WHERE key=?`, K).cool_ms, BREAKER.coolMaxMs, `冷却最多 ${BREAKER.coolMaxMs / 60000} 分钟`);
  // 失败率：没有连续 5 次，但近 5 分钟一半以上失败
  const { db: d3 } = fresh();
  let tr3 = null;
  for (let i = 0; i <= BREAKER.minSamples; i++) tr3 = report(d3, K, { ok: i % 2 === 1, status: i % 2 ? null : 502, at: 5000 + i }).transition ?? tr3;
  eq(tr3, 'opened', `近期 ${BREAKER.minSamples} 次里一半失败（时好时坏，从没连续 ${BREAKER.consecutive} 次）：也打开`);
  // 窗口外的旧失败不算
  const { db: d4 } = fresh();
  for (let i = 0; i < 4; i++) report(d4, K, { ok: false, status: 502, at: i });
  report(d4, K, { ok: true, at: 10 });
  for (let i = 0; i < 6; i++) report(d4, K, { ok: i % 3 !== 0, at: BREAKER.windowMs + 100 + i });
  eq(d4.one(`SELECT state FROM llm_health WHERE key=?`, K).state, 'closed', '窗口外的失败不进失败率');
}

// ── ③ ─────────────────────────────────────────────────────────────────────
section('③ 共享退避');
{
  const { db } = fresh();
  report(db, 'openai', { ok: false, status: 429, retryAfter: 3000, at: 1000 });
  eq(gate(db, 'openai', 1500), { ok: false, reason: 'backoff', wait: 2500 }, 'Retry-After 3 秒：所有进程都看到同一个时刻');
  eq(gate(db, 'openai', 4000), { ok: true }, '到点放行');
  report(db, 'openai', { ok: false, status: 429, at: 5000, rnd: () => 0.5 });
  const g = gate(db, 'openai', 5000);
  assert(g.reason === 'backoff' && g.wait > 0 && g.wait < BACKOFF.baseMs * 4, `只说 429 没说多久：按连续失败次数 full jitter（${g.wait} ms）`);
  report(db, 'openai', { ok: false, status: 429, retryAfter: 10 * 60_000, at: 6000 });
  assert(gate(db, 'openai', 6000).wait <= BACKOFF.capMs, '服务商说等 10 分钟：单次封顶，交给熔断 / 任务级退避');
  report(db, 'openai', { ok: true, at: 7000 });
  eq(gate(db, 'openai', 7001), { ok: true }, '成功一次：退避清掉');
  report(db, 'gemini', { ok: false, status: 500, at: 1 });
  eq(gate(db, 'gemini', 2), { ok: true }, '5xx 不设共享退避（那是熔断器的事）');
  eq(db.one(`SELECT last_status, last_error FROM llm_health WHERE key='openai'`), { last_status: 429, last_error: '' }, '成功不覆盖最近一次的错误（看板要看的是上一次为什么错）');
  const set = db.all(`SELECT target_id k, payload FROM audit_log WHERE action='llm_backoff_set' ORDER BY id`).map((r) => ({ k: r.k, ...JSON.parse(r.payload) }));
  eq(set.length, 3, '退避每新设 / 延长一次记一笔审计（retry_at 是覆盖写，不记事后数不出来）');
  assert(set[0].k === 'openai' && set[0].waitMs === 3000 && set[0].retryAfter === 3000, '记下等多久、服务商说的多久');
  assert(set[2].extendedMs > 0, '在退避期间又被延长：记延长了多少');
  eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='llm_backoff_set' AND target_id='gemini'`).n, 0, '5xx 不设退避，也不记');
}

// ── ④ ─────────────────────────────────────────────────────────────────────
section('④ 换用备用：一段只记一次');
{
  const { db } = fresh();
  eq(noteFallback(db, 'deepseek', { from: 'a', to: 'b', tier: 'standard', reason: 'HTTP 503', at: 100 }), true, '第一次换用：记');
  eq(noteFallback(db, 'deepseek', { from: 'a', to: 'b', tier: 'standard', reason: 'HTTP 503', at: 200 }), false, '同一段里再换：不再记');
  eq(audits(db, 'llm_fallback_used').length, 1, '审计只有一条（守护进程只通知一次）');
  report(db, 'deepseek', { ok: true, at: 300 });
  eq(noteFallback(db, 'deepseek', { from: 'a', to: 'b', tier: 'standard', at: 400 }), false, '主模型通了一次但没过一个窗口：仍算同一段（时好时坏时不反复通知）');
  report(db, 'deepseek', { ok: true, at: 100 + BREAKER.windowMs });
  eq(noteFallback(db, 'deepseek', { from: 'a', to: 'b', tier: 'standard', at: 200 + BREAKER.windowMs }), true, '过了一个窗口又通了：这一段结束，下次换用再记');
  // 打开过的：合上即结束
  const { db: d2 } = fresh();
  for (let i = 0; i < BREAKER.consecutive; i++) report(d2, 'x', { ok: false, status: 503, at: i });
  noteFallback(d2, 'x', { from: 'a', to: 'b', tier: 'light', at: 10 });
  gate(d2, 'x', 10 + BREAKER.coolMs);
  report(d2, 'x', { ok: true, at: 20 + BREAKER.coolMs });
  eq(audits(d2, 'llm_breaker_closed')[0]?.usedFallback, true, '合上的审计说了这段期间用过备用');
  eq(d2.one(`SELECT fallback_since FROM llm_health WHERE key='x'`).fallback_since, null, '合上：这一段结束');
  // healthView：一切正常的不列
  const { db: d3 } = fresh();
  report(d3, 'ok-one', { ok: true, at: Date.now() });
  report(d3, 'shaky', { ok: false, status: 502, at: Date.now() });
  eq(healthView(d3).map((h) => h.key), ['shaky'], '健康视图只列有事的（最近出过错 / 没合上 / 在退避 / 用过备用）');
}

// ── ⑤ ─────────────────────────────────────────────────────────────────────
section('⑤ 客户端：重试用尽换备用；熔断开着时主模型一次都不打');
const anthropicOk = { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'primary' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
const chatOk = { id: 'c', object: 'chat.completion', model: 'deepseek-flash', choices: [{ index: 0, message: { role: 'assistant', content: 'backup' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
const realFetch = globalThis.fetch;
// 按主机名分：anthropic 走 codes 脚本，deepseek 走 fb 脚本
const stub = (state) => async (url) => {
  const host = new URL(url).host;
  const which = host.includes('anthropic') ? 'primary' : 'backup';
  state.calls[which]++;
  const status = (which === 'primary' ? state.primary : state.backup).shift() ?? 200;
  const headers = { get: (h) => (h.toLowerCase() === 'retry-after' ? state.retryAfter ?? null : null) };
  return { ok: status < 400, status, headers, json: async () => (status < 400 ? (which === 'primary' ? anthropicOk : chatOk) : { error: { message: `HTTP ${status}` } }) };
};
const call = (c, role = null) => c.complete({ tier: 'standard', role, system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], maxTokens: 8 });
const textOf = (r) => r?.content?.find((b) => b.type === 'text')?.text;
{
  const { db, userId } = fresh();
  setBinding(db, { tier: 'standard', modelKey: 'anthropic/claude-sonnet-5', userId });
  setFallback(db, { tier: 'standard', modelKey: 'deepseek/deepseek-flash', userId });
  const client = () => new LlmClient({ mode: 'live', retryDelays: [0, 0, 0], ...registryFor(db) });
  const st = { calls: { primary: 0, backup: 0 }, primary: [], backup: [] };
  try {
    globalThis.fetch = stub(st);
    eq(textOf(await call(client())), 'primary', '主模型好好的：用主模型');
    st.primary = [503, 503, 503, 503];
    st.calls = { primary: 0, backup: 0 };
    eq(textOf(await call(client())), 'backup', '主模型 503 重试用尽：这一档换备用，调用方拿到结果');
    eq([st.calls.primary, st.calls.backup], [4, 1], '主模型打了 4 次（1 + 3 次重试），备用 1 次');
    const fu = audits(db, 'llm_fallback_used');
    assert(fu.length === 1 && fu[0].key === 'anthropic' && fu[0].to === 'deepseek/deepseek-flash' && fu[0].tier === 'standard', '记了一条换用审计（谁 → 谁、哪一档）');
    // 第 5 次失败打开熔断，之后的重试在门口就被拒
    st.primary = [503, 503, 503, 503];
    st.calls = { primary: 0, backup: 0 };
    eq(textOf(await call(client())), 'backup', '再撞：熔断打开，仍由备用接住');
    eq(st.calls.primary, 1, '第 5 次连续失败打开熔断，后面的重试不再打主模型');
    eq(audits(db, 'llm_breaker_opened').length, 1, '打开审计一条');
    st.calls = { primary: 0, backup: 0 };
    eq(textOf(await call(client())), 'backup', '熔断开着：新的客户端（别的进程）也直接走备用');
    eq(st.calls.primary, 0, '主模型一次都没打');
    eq(audits(db, 'llm_fallback_used').length, 1, '同一段里换用审计不重复');
    // 备用也挂了：错误上带着 fallback，通知据此说"换过了，也失败了"
    st.backup = [500, 500, 500, 500];
    let e = null; try { await call(client()); } catch (x) { e = x; }
    assert(e instanceof ProviderError && e.retryable && e.fallback?.to === 'deepseek/deepseek-flash', '备用也挂了：抛可重试的 ProviderError，带 fallback');
    // 验收员按"换一家"挑的：备用与执行器同一出品方就不换
    const vc = client();
    vc.fallbackAvoidMakers = ['deepseek'];
    st.backup = [];
    st.calls = { primary: 0, backup: 0 };
    e = null; try { await call(vc); } catch (x) { e = x; }
    assert(e instanceof ProviderError && e.blocked === 'open' && st.calls.backup === 0, '验收员：备用与执行器同一家 → 不换过去（宁可停下由任务级退避再拉）');
    // 没配备用：主模型熔断开着 → 直接失败，不发请求
    setFallback(db, { tier: 'standard', modelKey: null, userId });
    st.calls = { primary: 0, backup: 0 };
    e = null; try { await call(client()); } catch (x) { e = x; }
    assert(e instanceof ProviderError && e.retryable && e.blocked === 'open' && st.calls.primary === 0, '没配备用：熔断开着直接失败（可重试，守护进程退避），一个请求都不发');
    // 不可重试的错（403）：不算这家挂了、不换备用
    const { db: d2, userId: u2 } = fresh();
    setBinding(d2, { tier: 'standard', modelKey: 'anthropic/claude-sonnet-5', userId: u2 });
    setFallback(d2, { tier: 'standard', modelKey: 'deepseek/deepseek-flash', userId: u2 });
    const s2 = { calls: { primary: 0, backup: 0 }, primary: [403], backup: [] };
    globalThis.fetch = stub(s2);
    e = null; try { await call(new LlmClient({ mode: 'live', retryDelays: [0, 0, 0], ...registryFor(d2) })); } catch (x) { e = x; }
    assert(e?.status === 403 && s2.calls.backup === 0, '403：不换备用（那是 key / 权限的问题，换了也掩盖问题）');
    eq(d2.one(`SELECT count(*) n FROM llm_health`).n, 0, '403 不进熔断统计');
  } finally { globalThis.fetch = realFetch; }
}

// ── ⑥ ─────────────────────────────────────────────────────────────────────
section('⑥ 重试：Retry-After 至少等那么久；超时只再试一次');
{
  const { db, userId } = fresh();
  setBinding(db, { tier: 'standard', modelKey: 'anthropic/claude-sonnet-5', userId });
  const st = { calls: { primary: 0, backup: 0 }, primary: [429], backup: [], retryAfter: '0.3' };
  try {
    globalThis.fetch = stub(st);
    const t0 = Date.now();
    eq(textOf(await call(new LlmClient({ mode: 'live', retryDelays: [0, 0, 0], ...registryFor(db) }))), 'primary', '429 + Retry-After 0.3 秒 → 等了再打，成功');
    assert(Date.now() - t0 >= 250, `等够了 Retry-After（${Date.now() - t0} ms）`);
    // 超时：单次时限到了只再试一次（原来 4 次 × 30 分钟）
    process.env.SUPERINTERN_LLM_TIMEOUT_MS = '100';
    let calls = 0;
    globalThis.fetch = (url, init) => new Promise((_, reject) => { calls++; init?.signal?.addEventListener('abort', () => reject(init.signal.reason)); });
    const keep = setInterval(() => {}, 1000);
    let e = null; try { await call(new LlmClient({ mode: 'live', retryDelays: [0, 0, 0], ...registryFor(db) })); } catch (x) { e = x; } finally { clearInterval(keep); }
    assert(e instanceof ProviderError && e.retryable, '卡住的连接：可重试的失败');
    eq(calls, 2, '超时只再试一次（1 + 1），不是 1 + 3');
    delete process.env.SUPERINTERN_LLM_TIMEOUT_MS;
  } finally { globalThis.fetch = realFetch; }
}

// ── ⑦ ─────────────────────────────────────────────────────────────────────
section('⑦ 绑定：备用模型的校验与连带');
{
  const { db, userId } = fresh();
  setBinding(db, { tier: 'standard', modelKey: 'anthropic/claude-sonnet-5', userId });
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  assert(/档位无效/.test(err(() => setFallback(db, { tier: 'huge', modelKey: 'deepseek/deepseek-flash', userId })) ?? ''), '档位不对：拒');
  assert(/主模型本身/.test(err(() => setFallback(db, { tier: 'standard', modelKey: 'anthropic/claude-sonnet-5', userId })) ?? ''), '备用 = 主模型：拒');
  assert(/无法分配/.test(err(() => setFallback(db, { tier: 'standard', modelKey: 'nope/nope', userId })) ?? ''), '目录里没有的：拒');
  setFallback(db, { tier: 'heavy', modelKey: 'deepseek/deepseek-v4-pro', userId });
  eq(bindingOf(db).fallbacks.heavy, 'deepseek/deepseek-v4-pro', '还没有库里行的档也能配（连主模型一起写下）');
  assert(bindingOf(db).binding.heavy, 'heavy 的主模型没被弄丢');
  eq(audits(db, 'binding_fallback_set').at(-1)?.to, 'deepseek/deepseek-v4-pro', '记审计');
  assert(/备用模型/.test(err(() => removeModel(db, { key: 'deepseek/deepseek-v4-pro', userId })) ?? ''), '被当备用的模型：不许删（说是哪一档的备用）');
  setBinding(db, { tier: 'heavy', modelKey: 'deepseek/deepseek-v4-pro', userId });
  eq(bindingOf(db).fallbacks.heavy ?? null, null, '把备用提成主模型：备用清掉（不会出现"备用 = 主模型"）');
}

// ── ⑧ ─────────────────────────────────────────────────────────────────────
section('⑧ 给人看的：健康卡一项、守护进程的通知');
{
  const { db, userId } = fresh();
  setBinding(db, { tier: 'standard', modelKey: 'anthropic/claude-sonnet-5', userId });
  setBinding(db, { tier: 'heavy', modelKey: 'deepseek/deepseek-v4-pro', userId });
  eq(llmHealthCheck(db).level, 'ok', '没事：正常');
  for (let i = 0; i < BREAKER.consecutive; i++) report(db, 'anthropic', { ok: false, status: 529, error: 'overloaded', at: Date.now() });
  let c = llmHealthCheck(db);
  const row = c.rows.find((r) => r.key === 'anthropic');
  eq(c.level, 'bad', '主用它的档没配备用：有问题（那一档的步骤停着）');
  assert(row?.tiers.some((u) => u.tier === 'standard' && u.as === 'primary' && !u.fallback), '列出它用在哪一档、有没有备用');
  setFallback(db, { tier: 'standard', modelKey: 'deepseek/deepseek-flash', userId });
  c = llmHealthCheck(db);
  eq(c.level, 'warn', '配了备用：降为注意（已经自动换过去）');
  report(db, 'deepseek', { ok: false, status: 429, retryAfter: 30_000 });
  assert(llmHealthCheck(db).rows.find((r) => r.key === 'deepseek')?.tiers.some((u) => u.tier === 'standard' && u.as === 'fallback'), '备用那家在退避：标出它是谁的备用');

  eq(llmHealthNotice([]), null, '没事不发');
  eq(llmHealthNotice([{ action: 'llm_breaker_opened', targetId: 'x', payload: { reopened: true } }]), null, '再次打开：不发（第一次已经说过）');
  eq(llmHealthNotice([{ action: 'llm_breaker_closed', targetId: 'x', payload: { openForMs: 60_000 } }]), null, '停一分钟就恢复的：不发');
  const n = llmHealthNotice([{ action: 'llm_breaker_opened', targetId: 'anthropic', payload: { coolMs: 60_000, status: 529, error: 'overloaded' } }]);
  assert(n && /anthropic/.test(n.text) && /60 秒/.test(n.text) && /bind fallback/.test(n.text), '打开：说哪家、停多久、怎么配备用');
  const en = llmHealthNotice([{ action: 'llm_fallback_used', targetId: 'anthropic', payload: { tier: 'standard', from: 'a/b', to: 'c/d' } }], 'en');
  assert(en && /switched from a\/b to the backup model c\/d/.test(en.text) && !/bind fallback/.test(en.text), '英文；只换用没打开时不附配置提示');
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
if (fail) process.exitCode = 1;
