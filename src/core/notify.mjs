// 通知适配器：让人不用盯着终端。
//
// 设计：notifier 接口 + 站内基底；适配器 ntfy + 飞书 / 钉钉 / 企微 webhook；
// 每用户绑定通道；送达 / 已读回执入库，供超时标定。
//
// 目前做的：五种通道（本地命令、ntfy、飞书、钉钉、企微），通道从 .env 读（用户自填，只查在不在），
// 送达回执记进 audit_log（`notification_sent`：通道种类、HTTP 状态、成没成功）。"已读"回执要各家的回调，
// 单机部署没有回调入口，目前不做 —— 超时链现在按送达时刻计，不按已读。
//
// 两条纪律：
//   - webhook URL 里带密钥，**只记种类和主机名**，URL 本身不进审计、不进日志。
//   - 通知失败不抛：它是旁路，任何一条通道挂了都不能让编排器停下来。失败记回执，人看审计。

import { spawnSync } from 'node:child_process';
import { audit } from '../db/db.mjs';

export const CHANNEL_ENV = {
  ntfy: 'NTFY_URL',              // 例：https://ntfy.sh/<topic>
  feishu: 'FEISHU_WEBHOOK',      // 飞书自定义机器人 webhook
  dingtalk: 'DINGTALK_WEBHOOK',  // 钉钉自定义机器人 webhook
  wecom: 'WECOM_WEBHOOK',        // 企业微信群机器人 webhook
  cmd: 'NOTIFY_CMD',             // 本地命令：<cmd> <title> <taskId> <ref>
};

/** 从环境读通道。空值跳过。`extraCmd` 是 CLI 的 --notify <cmd>。 */
export function channelsFromEnv(env = process.env, extraCmd = null) {
  const out = [];
  for (const [kind, key] of Object.entries(CHANNEL_ENV)) {
    const v = String(env[key] ?? '').trim();
    if (v) out.push({ kind, target: v });
  }
  if (extraCmd) out.push({ kind: 'cmd', target: String(extraCmd) });
  return out;
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return '?'; } };

/** 把一行命令拆成 argv：按空白拆，双引号内保留空白。不做变量展开。 */
export function splitArgv(line) {
  const out = []; let cur = ''; let q = false;
  for (const c of String(line).trim()) {
    if (c === '"') { q = !q; continue; }
    if (!q && /\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** 各家的请求形状。返回 {url, init}。 */
export function buildRequest(channel, { title, text }) {
  const body = `${title}\n${text}`;
  switch (channel.kind) {
    case 'ntfy':
      return { url: channel.target, init: { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8', title: encodeURIComponent(title) }, body: text } };
    case 'feishu':
      return { url: channel.target, init: { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text: body } }) } };
    case 'dingtalk':
    case 'wecom':
      return { url: channel.target, init: { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: body } }) } };
    default:
      throw new Error(`不认识的通道：${channel.kind}`);
  }
}

/**
 * 发一条通知到全部通道，回执进审计。**不抛**。
 * @param {object} o { taskId, kind, title, text, ref, channels, fetchFn, spawn }
 * @returns {Promise<Array<{kind, ok, status?, error?}>>}
 */
export async function notify(db, { taskId, kind, title, text, ref = null, channels, fetchFn = globalThis.fetch, spawn = spawnSync }) {
  const receipts = [];
  for (const ch of channels ?? []) {
    let r;
    if (ch.kind === 'cmd') {
      // 命令可以带参数（`node C:/x/sink.cjs`），末尾追加 <title> <taskId> <ref>。不经 shell。
      // ⚠️ Windows 上 .cmd/.bat 不经 shell 起不来（Node 拒 EINVAL）；包成 node 脚本或 exe。
      const [file, ...pre] = splitArgv(ch.target);
      const out = spawn(file, [...pre, title, taskId ?? '', ref ?? ''], { stdio: 'inherit', shell: false, timeout: 30_000 });
      r = { kind: 'cmd', ok: !out.error && out.status === 0, status: out.status ?? null, error: out.error?.message ?? null };
    } else {
      try {
        const { url, init } = buildRequest(ch, { title, text });
        const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(15_000) });
        let ok = res.ok;
        // 飞书 / 钉钉 / 企微 都是 HTTP 200 + 正文里的 code 表示成败
        if (ok && ch.kind !== 'ntfy') {
          const j = await res.json().catch(() => null);
          if (j && ((j.code ?? j.errcode ?? 0) !== 0)) ok = false;
          r = { kind: ch.kind, ok, status: res.status, error: ok ? null : String(j?.msg ?? j?.errmsg ?? '').slice(0, 120) || null };
        } else r = { kind: ch.kind, ok, status: res.status, error: ok ? null : `HTTP ${res.status}` };
      } catch (e) {
        r = { kind: ch.kind, ok: false, status: null, error: String(e.message).slice(0, 120) };
      }
      r.host = hostOf(ch.target);
    }
    receipts.push(r);
    audit(db, { actorKind: 'system', action: 'notification_sent', targetType: 'task', targetId: taskId,
      payload: { channel: r.kind, host: r.host ?? null, ok: r.ok, status: r.status, error: r.error, notifyKind: kind, ref } });
  }
  return receipts;
}

/** 退出原因 → 一条通知。只覆盖"需要人做点什么"的那几种；complete 也推，好让人知道可以签收了。 */
export function outcomeNotice(r, taskId) {
  const k = r.kind;
  if (k === 'suspended') {
    const q = r.questions?.[0];
    return { title: `[SuperIntern] 第 ${q?.level ?? '?'} 级问题在等你`, ref: q?.id ?? null,
      text: `${String(q?.text ?? '').slice(0, 400)}\n\n回答：node src/cli.mjs answer ${q?.id} "..."（任务 ${taskId}）` };
  }
  if (k === 'limit_breached') return { title: `[SuperIntern] 硬上限触顶，任务冻结`, ref: r.questionId ?? null,
    text: `${r.breach?.human ?? ''}\n加额：node src/cli.mjs limit ${taskId} --${String(r.breach?.key ?? '').replace('limit.', '')} <新值>` };
  if (k === 'limit_hard_failed') return { title: `[SuperIntern] 硬边界触顶（不支持加额）`, ref: null, text: `${r.breach?.human ?? ''}\n${r.why ?? ''}` };
  if (k === 'provider_error' && r.error?.config) return { title: `[SuperIntern] 模型配置有问题，任务停了`, ref: null,
    text: `${String(r.error.message ?? '').slice(0, 300)}\n没有发出请求，节点不计重试。改绑：node src/cli.mjs bind set ${r.error.tier ?? '<tier>'}=<服务商/模型>，或看板"设置 → 模型分配"` };
  if (k === 'provider_error') {
    // 可重试的（429 / 5xx / 网络，客户端已经重试到耗尽）守护进程会退避再拉，人不一定要动；不可重试的（401 / 403）才是"要人来"。
    // 建议的是 bind set（进库）而不是 run --bind：一次性覆盖不进库，守护进程下次拉起用的还是库里的绑定，会撞同一个错。
    const e = r.error ?? {};
    const head = `${e.vendor}/${e.model}${e.status ? ` HTTP ${e.status}` : '（网络）'}：${String(e.message ?? '').slice(0, 200)}`;
    const rebind = `node src/cli.mjs bind set ${e.tier ?? '<tier>'}=<服务商/模型>，或看板"设置 → 模型分配"（下个步骤起生效）`;
    return e.retryable
      ? { title: `[SuperIntern] 厂商暂时不可用，任务停了`, ref: null,
        text: `${head}\n节点不计重试。开着守护进程的话它会隔一阵自动再拉；一直不好就换一家：${rebind}` }
      : { title: `[SuperIntern] 厂商拒绝了请求，需换绑或检查 key`, ref: null,
        text: `${head}\n节点不计重试；守护进程不会自己重试这种错，改绑或换 key 后它会立刻再拉。检查这家的 key / 权限（看板"设置 → 服务商"的"检查"），或换一家：${rebind}` };
  }
  if (k === 'revision_pending') return { title: `[SuperIntern] 修正方案要你批准`, ref: null,
    text: `${String(r.gate ?? '').slice(0, 300)}\n看：node src/cli.mjs revision ${taskId}` };
  if (k === 'verify_failed') return { title: `[SuperIntern] 任务级验收没过`, ref: null,
    text: `${r.verification?.argv?.join(' ')} exit=${r.verification?.code}\n${String(r.verification?.tail ?? '').split('\n').slice(-5).join('\n')}` };
  // 已经 done 的任务再 run 一次也会以 complete 收尾，但那不是"刚做完"—— 没有工作区快照就不推
  if (k === 'complete' && !r.workspace) return null;
  if (k === 'complete') return { title: `[SuperIntern] 任务完成，等签收`, ref: null,
    text: `${r.completed?.length ?? 0} 个节点，产物在 ${r.workspace?.branch} @ ${r.workspace?.head?.slice(0, 8)}\n签收：node src/cli.mjs signoff ${taskId} --accept | --reject "..."\n交付：node src/cli.mjs deliver ${taskId} --remote <url> [--pr]` };
  return null;
}

