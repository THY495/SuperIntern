// 会话能力表（Meta 的 Agents Rule of Two）。
//
// 一个模型会话同时具备下面三样时，被注入的指令就能拿着凭据去外面做事，必须有人在环：
//   [A] untrusted  读不可信的输入（仓库内容、命令输出、网页……被第三方写过的东西）
//   [B] sensitive  持有敏感数据 / 凭据（能用到令牌、密钥）
//   [C] external   能对外改变状态（往外发请求改东西、推送、发布）
// 部署里的成员（登录过的人）写的需求、答复、消息不算不可信输入：他们本来就能直接指挥系统。
//
// 这张表做两件事：
//   1. 静态：每类会话（按 LLM_ROLES 的角色）给什么工具、读什么输入，写在这里；LlmClient.complete 每次调用前核对 ——
//      没登记的角色、给了没登记的工具，直接拒。以后接 MCP / 新工具，不先在这里登记能力就接不上。
//   2. 动态：执行器 / 验收员的沙箱，[B][C] 取决于这次装配（注入了哪些凭据、哪些地址能写）。makeSandbox 装配时算，
//      三样齐了就收窄：带着凭据的沙箱里，所有地址只能读（GET / HEAD / OPTIONS），只有管理员显式允许写的凭据例外 ——
//      那一份允许就是"人在环"，记审计。收窄之后仍三样齐（只可能是代码改坏了）→ 拒绝起沙箱。

import { I18nError } from '../i18n/index.mjs';
import { LLM_ROLES, bindRoleOf } from '../llm/canonical.mjs';

/**
 * 工具的效果。read：只读；workspace：写工作区；exec：在沙箱里跑代码（经出口代理可能出网）；app：操作沙箱里起的应用；
 * record：往系统库里写（计划、交接、裁定、报告……）；ask：给部署里的人挂事项（经部署配置的通知通道）。
 * 只有 exec / app 可能碰到外面 —— 它们的 [C] 由沙箱装配决定。
 */
export const TOOL_EFFECTS = {
  list_dir: 'read', read_file: 'read', grep: 'read',
  write_file: 'workspace', run_command: 'exec',
  submit_handoff: 'record', raise_question: 'ask', request_egress: 'ask',
  submit_verdict: 'record', open_page: 'app', read_page: 'app', click: 'app', type_text: 'app', select_option: 'app', screenshot: 'app',
  submit_plan: 'record', ask_user: 'ask', propose_constitution: 'record',
  propose_project: 'record', project_goal_reached: 'record',
  submit_revision: 'record', submit_report: 'record',
};

/**
 * 每类会话。untrusted：读到的不可信输入（空 = 只读部署里的人写的东西与系统生成的事实）。
 * sensitive / external：'none'，或 'sandbox'（取决于沙箱装配，见 sandboxCaps），或 'human'（经人点了才发生，例如交付）。
 */
export const SESSIONS = {
  executor: { tools: ['list_dir', 'read_file', 'grep', 'write_file', 'run_command', 'submit_handoff', 'raise_question', 'request_egress'],
    untrusted: ['仓库内容', '命令输出', '出网读到的网页与包', '上游步骤的交接'], sensitive: 'sandbox', external: 'sandbox' },
  verifier: { tools: ['list_dir', 'read_file', 'grep', 'submit_verdict', 'open_page', 'read_page', 'click', 'type_text', 'select_option', 'screenshot'],
    untrusted: ['仓库内容', '执行器写的交接', '运行中的应用页面'], sensitive: 'sandbox', external: 'sandbox' },
  planner: { tools: ['submit_plan', 'raise_question'], untrusted: [], sensitive: 'none', external: 'none' },
  elicitor: { tools: ['ask_user', 'propose_constitution'], untrusted: [], sensitive: 'none', external: 'none' },
  project_planner: { tools: ['propose_project', 'project_goal_reached'], untrusted: ['仓库文件清单与 README 开头'], sensitive: 'none', external: 'none' },
  replanner: { tools: ['submit_revision', 'raise_question'], untrusted: ['步骤产物（来自执行器交接）'], sensitive: 'none', external: 'none' },
  // 报告会成为 PR 正文（[C]），但交付由人点、推送用的凭据只在宿主上、确定性代码里用（[B] 不在会话里）
  reporter: { tools: ['submit_report'], untrusted: ['执行器写的交接'], sensitive: 'none', external: 'human' },
  classifier: { tools: [], untrusted: [], sensitive: 'none', external: 'none' },
  // 把执行器的工作记录整理成简报。记录里有仓库内容与命令输出（不可信），但它没有工具、不碰凭据，产出只回到执行器的上下文
  compactor: { tools: [], untrusted: ['执行器的工作记录（仓库内容、命令输出）'], sensitive: 'none', external: 'none' },
  'decision-check': { tools: [], untrusted: [], sensitive: 'none', external: 'none' },
};

export class CapabilityError extends I18nError {
  constructor(tpl, params) { super(tpl, params); this.name = 'CapabilityError'; this.capability = true; }
}

/**
 * LlmClient.complete 调用前核对：角色登记过、给的工具都在这个角色的登记里。不符就拒（不是警告）。
 * 没带 role 的调用（测试里的直接调用）不核对工具以外的东西：带了工具却没带角色同样拒 —— 否则不带角色就能绕过。
 */
export function assertSessionTools(role, tools = []) {
  const names = (tools ?? []).map((t) => t.name);
  if (!role) {
    if (names.length) throw new CapabilityError('给模型工具的调用必须带会话角色（core/capabilities.mjs 按角色核对能力）：{tools}', { tools: names.join(', ') });
    return;
  }
  const key = bindRoleOf(role);
  const s = SESSIONS[key];
  if (!s) throw new CapabilityError('会话角色 {role} 没在能力表里登记（core/capabilities.mjs）：先写清它读什么输入、能不能碰凭据、能不能对外改东西', { role });
  const extra = names.filter((n) => !s.tools.includes(n));
  if (extra.length) throw new CapabilityError('角色 {role} 拿到了没登记的工具：{tools}。先在 core/capabilities.mjs 的 SESSIONS 与 TOOL_EFFECTS 里登记它的效果', { role, tools: extra.join(', ') });
}

/**
 * 沙箱这次装配的能力。allow：出口代理的放行表（[{group, host, readOnly}]）；injected：注入的凭据摘要（egress-creds）；
 * secretEnv：注入沙箱环境的像凭据的变量名（toolEnvOf 已经滤掉，这里只为兜底）。
 * 返回 { untrusted, sensitive, external }：每样是原因列表，空 = 没有。
 */
export function sandboxCaps({ allow = [], injected = [], secretEnv = [] } = {}) {
  return {
    untrusted: SESSIONS.executor.untrusted,
    sensitive: [...injected.map((c) => `凭据 ${c.header} → ${c.hosts.join(', ')}`), ...secretEnv.map((k) => `环境变量 ${k}`)],
    external: [...new Set(allow.filter((a) => !a.readOnly).map((a) => a.host))],
  };
}

/**
 * 三样齐了就收窄：注入了凭据（或环境里有凭据），放行表里所有地址改成只读 —— 允许写的凭据覆盖的地址除外（管理员显式允许 = 人在环）。
 * 返回 { allow, narrowed: [被改成只读的地址], humanApproved: [允许写的凭据] }。
 */
export function narrowForCredentials({ allow = [], injected = [], secretEnv = [] } = {}) {
  if (!injected.length && !secretEnv.length) return { allow, narrowed: [], humanApproved: [] };
  const writeOk = new Set(injected.filter((c) => c.allowWrite).flatMap((c) => c.hosts));
  const narrowed = [];
  const out = allow.map((a) => {
    if (a.readOnly || writeOk.has(a.host)) return a;
    narrowed.push(a.host);
    return { ...a, readOnly: true };
  });
  return { allow: out, narrowed: [...new Set(narrowed)], humanApproved: injected.filter((c) => c.allowWrite) };
}

/** 装配的最后一道：三样齐了、又没有人在环的那份允许 → 拒绝。收窄之后不该走到这里。 */
export function assertRuleOfTwo(caps, { humanApproved = [] } = {}) {
  const writeOk = new Set(humanApproved.flatMap((c) => c.hosts));
  const externalUnapproved = caps.external.filter((h) => !writeOk.has(h));
  if (caps.untrusted.length && caps.sensitive.length && externalUnapproved.length) {
    throw new CapabilityError('沙箱同时读不可信输入、带着凭据（{b}）、又能往这些地址写（{c}）：没有人在环，不起。', { b: caps.sensitive.join('；'), c: externalUnapproved.join(', ') });
  }
}

/** 静态核对：登记表本身不许三样齐（不经沙箱的会话）；角色表里每个角色都有登记。测试与启动自检用。 */
export function staticProblems() {
  const out = [];
  for (const role of Object.keys(LLM_ROLES)) if (!SESSIONS[role]) out.push(`角色 ${role} 没登记`);
  for (const [k, s] of Object.entries(SESSIONS)) {
    for (const t of s.tools) if (!TOOL_EFFECTS[t]) out.push(`${k} 的工具 ${t} 没登记效果`);
    if (s.sensitive === 'sandbox' || s.external === 'sandbox') continue;
    if (s.untrusted.length && s.sensitive !== 'none' && s.external !== 'none' && s.external !== 'human') out.push(`${k} 三样齐了`);
    // 不经沙箱的会话不许有能碰外面的工具
    for (const t of s.tools) if (['exec', 'app'].includes(TOOL_EFFECTS[t])) out.push(`${k} 不经沙箱却有 ${t}`);
  }
  return out;
}
