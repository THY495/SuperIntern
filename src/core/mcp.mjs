// MCP 客户端：把 MCP server 的工具接进执行器。
//
// 参考：MCP 规范 2026-07-28（无状态：没有 initialize，先 server/discover）与旧版
// initialize 两套都认；帧与子进程照官方 TypeScript SDK（换行分隔的 JSON-RPC、10 MB 读缓冲、先关 stdin 再杀）；
// 配置照 Claude Code 的 .mcp.json（{ mcpServers: { 名字: { command, args, env } } }）；工具名 / 指纹 / 环境变量过滤照 Codex 与 Gemini CLI。
//
// 边界：
//   - **server 跑在任务的沙箱里**（stdio，docker exec -i）：它能碰到的网络就是这个任务的出网放行表，凭据照旧只在出口代理里注入。
//     所以这里不另做一套网络 / 凭据隔离 —— 复用沙箱的（最小权限注入的 Rule of Two 收窄照常生效）。
//   - **配置指纹**：命令 + 参数 + 环境变量 + 规范化后的工具清单（名字、说明、入参 schema、annotations）一起算 hash。
//     负责人看过工具清单批准的是这个 hash；跑的时候现算，对不上（换了命令、工具说明被改了 —— MCPoison 那一类）就不给 AI 用。
//   - **annotations 不可信**（规范原话）：readOnlyHint 不作数。每个工具要不要人批由负责人定：auto（直接用）/ ask（每次问人，默认）/ off。
//   - 远程（Streamable HTTP）server：在沙箱里起一个桥（mcp-http-bridge.mjs，node -e 传源码），fetch 经出口代理出去 ——
//     放行表、凭据注入、带凭据时只读收窄都照旧。像凭据的请求头不放进配置（凭据由代理按地址注入）。
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { git, gitRaw } from './git.mjs';
import { lazySandbox } from './hooks.mjs';
import { getProjectParam, writeParam } from './params.mjs';
import { audit } from '../db/db.mjs';
import { I18nError, N_, tl, contentLang } from '../i18n/index.mjs';
import { trySignalOnce } from './signals.mjs';

const W = (msg, params = {}) => ({ msg, params });
export const MCP_PREFIX = 'mcp__';
export const REPO_MCP_FILE = '.mcp.json';
export const PROTOCOL_NEW = '2026-07-28';
export const PROTOCOL_OLD = '2025-06-18';
export const STARTUP_TIMEOUT_MS = 15_000;
export const TOOL_TIMEOUT_MS = 120_000;
export const DISCOVER_TIMEOUT_MS = 5_000;
export const READ_BUFFER_MAX = 10 * 1024 * 1024;
export const OUTPUT_INLINE_MAX = 40_000;     // 超过就落盘，给模型开头一段 + 路径
const NAME_MAX = 64;                         // 厂商的工具名上限（Anthropic / OpenAI 都是 64，且只认 [A-Za-z0-9_-]）
const APPROVED_KEY = 'mcp.approved';         // 项目参数：{ serverId: fingerprint }
const SNAPSHOT_KEY = 'mcp.snapshot';         // 项目参数：{ serverId: { fingerprint, tools, protocol, serverInfo, at } }
const MODES_KEY = 'mcp.tools';               // 项目参数：{ 工具全名: 'auto' | 'ask' | 'off' }
const OFF_KEY = 'mcp.off';                    // 项目参数：{ serverId: true } —— 负责人说"不用这个 server"
const APPROVED_TOOLS_KEY = 'mcp.approved_tools';   // 项目参数：{ serverId: 批准时的规范化工具清单 } —— 变了之后给人看变了哪几个
let bridgeSrc = null;
const bridgeSource = () => (bridgeSrc ??= readFileSync(new URL('./mcp-http-bridge.mjs', import.meta.url), 'utf8'));
export const TOOL_MODES = ['auto', 'ask', 'off'];
// 像凭据的变量名 / 值：不放进 server 的环境（凭据走出口代理注入，不进沙箱）
const SECRET_NAME = /TOKEN|SECRET|PASSW|KEY|CREDENTIAL|AUTH|COOKIE|SESSION/i;
const SECRET_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|^gh[pousr]_[A-Za-z0-9]{20,}|^sk-[A-Za-z0-9_-]{16,}|^xox[abpr]-/;

export const deployMcpFile = () => join(process.env.SUPERINTERN_HOME ?? join(process.cwd(), '.superintern'), 'mcp.json');
export const projectMcpFile = (db, projectId) => {
  const repo = projectId ? db.one(`SELECT repo FROM projects WHERE id=?`, projectId)?.repo : null;
  return repo ? join(dirname(repo), 'mcp.json') : null;
};

// ── 配置 ────────────────────────────────────────────────────────────────────
/** 一份 MCP 配置拆成 server 条目。认不得的字段只警告；远程 server 这一版不接，警告后跳过。 */
export function parseMcpConfig(text, { source, file }) {
  const warnings = [];
  let j;
  try { j = JSON.parse(String(text)); } catch (e) { return { servers: [], warnings: [W(N_('{file} 不是合法的 JSON：{why}'), { file, why: String(e.message).slice(0, 160) })] }; }
  const map = j?.mcpServers ?? j?.mcp_servers;
  if (!map || typeof map !== 'object') return { servers: [], warnings };
  const servers = [];
  for (const [name, c] of Object.entries(map)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) { warnings.push(W(N_('{file}：server 名字 {name} 只能用字母、数字、_ 与 -（最长 32），跳过'), { file, name: String(name).slice(0, 40) })); continue; }
    if (c?.disabled === true) continue;
    const type = c?.type ?? (c?.url ? 'http' : 'stdio');
    const listOf = (x) => (Array.isArray(x) ? x.map(String) : null);
    const common = {
      enabledTools: listOf(c?.enabledTools ?? c?.enabled_tools), disabledTools: listOf(c?.disabledTools ?? c?.disabled_tools),
      startupTimeoutMs: Number.isFinite(Number(c?.startup_timeout_sec)) ? Math.min(120, Math.max(1, Number(c.startup_timeout_sec))) * 1000 : STARTUP_TIMEOUT_MS,
      toolTimeoutMs: Number.isFinite(Number(c?.tool_timeout_sec)) ? Math.min(900, Math.max(1, Number(c.tool_timeout_sec))) * 1000 : TOOL_TIMEOUT_MS };
    if (type === 'http' || type === 'streamable-http') {
      let u = null;
      try { u = new URL(String(c?.url ?? '')); } catch { u = null; }
      if (!u || !['https:', 'http:'].includes(u.protocol) || u.username || u.password) { warnings.push(W(N_('{file}：{name} 的 url 不是 http(s) 地址（或者带着账号口令），跳过'), { file, name })); continue; }
      const headers = {};
      for (const [k, v] of Object.entries(c.headers && typeof c.headers === 'object' ? c.headers : {})) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) continue;
        if (/^(authorization|proxy-authorization|cookie)$/i.test(k) || SECRET_NAME.test(k) || SECRET_VALUE.test(String(v)) || /\$\{/.test(String(v))) {
          // 仓库里的配置已经进了 git 历史：那份令牌要当成泄露了 —— 光说"没放进去"会让人以为系统替他处理好了
          warnings.push(source === 'repo'
            ? W(N_('{file}：{name} 的请求头 {key} 写着像凭据的值。没有用它；但它已经提交进仓库、留在 git 历史里，要当作已经泄露：作废这个令牌、换一个新的，新的由管理员在「联网」里按地址配置（出口代理注入），不要再写进仓库'), { file, name, key: k })
            : W(N_('{file}：{name} 的请求头 {key} 像凭据，没有用它：从配置里删掉，改由管理员在「联网」里按地址配置（出口代理注入）'), { file, name, key: k }));
          continue;
        }
        headers[k] = String(v);
      }
      const url = u.toString();
      if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(u.hostname)) warnings.push(W(N_('{file}：{name} 的 url 指向 {host}：在沙箱里这是沙箱自己，不是服务器 —— 多半写错了，要写 server 真正的地址'), { file, name, host: u.hostname }));
      servers.push({ id: `${source}:${name}`, name, source, file, remote: { url, headers }, command: 'node', args: ['--input-type=module', '-e', bridgeSource(), url, JSON.stringify(headers)], env: {}, ...common });
      continue;
    }
    if (type !== 'stdio') { warnings.push(W(N_('{file}：{name} 用的是 {type} 传输，这里只认 stdio 与 http'), { file, name, type })); continue; }
    if (typeof c?.command !== 'string' || !c.command.trim()) { warnings.push(W(N_('{file}：{name} 没写 command，跳过'), { file, name })); continue; }
    const args = Array.isArray(c.args) ? c.args.map(String) : [];
    const env = {};
    for (const [k, v] of Object.entries(c.env && typeof c.env === 'object' ? c.env : {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (SECRET_NAME.test(k) || SECRET_VALUE.test(String(v))) { warnings.push(W(N_('{file}：{name} 的环境变量 {key} 像凭据，没放进去（凭据由出口代理注入，不进沙箱）'), { file, name, key: k })); continue; }
      env[k] = String(v);
    }
    servers.push({ id: `${source}:${name}`, name, source, file, remote: null, command: c.command.trim(), args, env, ...common });
  }
  return { servers, warnings };
}

/**
 * 一个项目能用的 server：部署 → 项目 → 仓库（从 ref 读 .mcp.json），同名的前面的顶掉后面的（警告）。
 * 仓库的 .mcp.json 从任务开工时的基线 / 项目分支读 —— 执行器改了它，改动也不在这一段生效。
 */
export function listServers(db, { projectId = null, workspace = null, ref = null } = {}) {
  const out = [], warnings = [];
  const read = (source, file, text) => { if (text == null) return; const r = parseMcpConfig(text, { source, file }); out.push(...r.servers); warnings.push(...r.warnings); };
  for (const [source, file] of [['deploy', deployMcpFile()], ['project', projectMcpFile(db, projectId)]]) {
    if (file && existsSync(file)) read(source, file, readFileSync(file, 'utf8'));
  }
  if (workspace) {
    let text = null;
    try { text = ref && existsSync(join(workspace, '.git')) ? gitRaw(workspace, ['show', `${ref}:${REPO_MCP_FILE}`]) : (existsSync(join(workspace, REPO_MCP_FILE)) ? readFileSync(join(workspace, REPO_MCP_FILE), 'utf8') : null); } catch { text = null; }
    read('repo', REPO_MCP_FILE, text);
  }
  const seen = new Map(), servers = [];
  for (const s of out) {
    if (seen.has(s.name)) { warnings.push(W(N_('server 名字 {name} 重复：用的是 {kept}，{dropped} 那份没用'), { name: s.name, kept: seen.get(s.name).id, dropped: s.id })); continue; }
    seen.set(s.name, s); servers.push(s);
  }
  return { servers, warnings };
}

// ── 指纹与批准 ───────────────────────────────────────────────────────────────
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
/** 规范化的工具清单：只留会影响模型行为的字段，按名字排序 */
export const normalizeTools = (tools) => tools.map((t) => sortKeys({ name: String(t.name), description: String(t.description ?? ''), inputSchema: t.inputSchema ?? null, annotations: t.annotations ?? null }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
// 远程 server 按地址与请求头算（不按桥的源码：系统升级换了桥，不该逼人重新批准）
export function fingerprint(server, tools) {
  const how = server.remote ? ['http', server.remote.url, sortKeys(server.remote.headers)] : [server.command, server.args, sortKeys(server.env)];
  return createHash('sha256').update(JSON.stringify([...how, normalizeTools(tools)])).digest('hex');
}
/** 批准时那份清单 → 现在这份：加了 / 去掉 / 说明或参数变了的工具 */
export function diffTools(before = [], after = []) {
  const a = new Map(before.map((t) => [t.name, t])), b = new Map(after.map((t) => [t.name, t]));
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  return [...[...b.keys()].filter((n) => !a.has(n)).map((name) => ({ name, kind: 'added', after: b.get(name) })),
    ...[...a.keys()].filter((n) => !b.has(n)).map((name) => ({ name, kind: 'removed', before: a.get(name) })),
    ...[...b.keys()].filter((n) => a.has(n) && !same(a.get(n), b.get(n))).map((name) => ({ name, kind: 'changed', before: a.get(name), after: b.get(name) }))];
}
export const offOf = (db, projectId) => (projectId ? getProjectParam(db, projectId, OFF_KEY) ?? {} : {});
/** 负责人"不用这个 server"（或重新启用）。停用的不起、不给工具，不管指纹对不对得上 */
export function setServerOff(db, { projectId, id, off, userId }) {
  const next = { ...offOf(db, projectId) };
  if (off) next[id] = true; else delete next[id];
  writeParam(db, { projectId, key: OFF_KEY, value: next, by: { kind: 'user', id: userId }, governance: 'constitutional', layer: 'project' });
  audit(db, { actorKind: 'user', actorId: userId, action: off ? 'mcp_server_off' : 'mcp_server_on', targetType: 'project', targetId: projectId, payload: { id } });
}
export const approvedOf = (db, projectId) => (projectId ? getProjectParam(db, projectId, APPROVED_KEY) ?? {} : {});
export const snapshotOf = (db, projectId) => (projectId ? getProjectParam(db, projectId, SNAPSHOT_KEY) ?? {} : {});
export const modesOf = (db, projectId) => (projectId ? getProjectParam(db, projectId, MODES_KEY) ?? {} : {});

/** 记下一次"看过的工具清单"（mcp check）。批准只能批准看过的那份。 */
export function recordSnapshot(db, { projectId, results, userId = null }) {
  const cur = { ...snapshotOf(db, projectId) };
  for (const r of results) cur[r.server.id] = r.ok
    ? { fingerprint: r.fingerprint, tools: normalizeTools(r.tools), protocol: r.protocol, serverInfo: r.serverInfo ?? null, at: new Date().toISOString() }
    : { error: r.error, at: new Date().toISOString() };
  // 检查是人点的（看板 / 命令行）：记在那个人名下；没有人的（不该有，兜底）记成执行类
  const who = userId ? { by: { kind: 'user', id: userId }, governance: 'constitutional' } : { by: { kind: 'agent', id: 'system' }, governance: 'execution' };
  writeParam(db, { projectId, key: SNAPSHOT_KEY, value: cur, ...who, layer: 'project' });
  // 批准过的 server 这次看到的和批准的不一样：它的工具当场回到默认（每次问人）。之前设的"直接用"是对旧版本做的决定，
  // server 变过一次，没变的工具也不再按原来那么信。放在"看到变化"这一刻而不是"批准"那一刻（第三轮认知走查）：
  // 这样页面上的下拉框显示的就是真实状态，人看过新版本之后再设的（比如只把可疑的那个设成不给 AI）批准时照用
  const approved = approvedOf(db, projectId), modes = { ...modesOf(db, projectId) }, reset = [];
  for (const r of results) {
    if (!r.ok || !approved[r.server.id] || approved[r.server.id] === r.fingerprint) continue;
    const prefix = `${MCP_PREFIX}${r.server.name}__`;
    for (const f of Object.keys(modes)) if (f.startsWith(prefix)) { delete modes[f]; reset.push(f); }
  }
  if (reset.length) {
    writeParam(db, { projectId, key: MODES_KEY, value: modes, ...who, layer: 'project' });
    audit(db, { actorKind: 'system', action: 'mcp_modes_reset', targetType: 'project', targetId: projectId, payload: { tools: reset } });
  }
  return cur;
}

/** 负责人批准：把快照里的指纹记成批准过的。ids 不给 = 快照里全部成功的。 */
/**
 * seen：批准的人看到的那一版的指纹（看板传，前 16 位）。对不上 = 他看过之后又检查过一次、命令或工具说明变了 ——
 * 不能拿他对旧版的"没问题"去批新版（工具说明原样进 AI 的上下文，批的就得是看过的那一份）。
 */
export function approveServers(db, { projectId, ids = null, userId, seen = null }) {
  const snap = snapshotOf(db, projectId);
  const pick = Object.entries(snap).filter(([id, s]) => s.fingerprint && (!ids || ids.includes(id) || ids.includes(id.split(':')[1])));
  if (!pick.length) throw new I18nError('没有可批准的 MCP server：先运行 mcp check 看一遍它们的工具清单');
  if (seen) for (const [id, s] of pick) {
    if (!s.fingerprint.startsWith(String(seen))) throw Object.assign(new I18nError('没有批准：你看过之后，MCP server {name} 又被检查了一次，命令或工具说明和你看过的不一样了。页面已刷新成新的这一版；批准之前 AI 用不到这个 server，看过新的再批准', { name: id.split(':').slice(1).join(':') || id }), { status: 409, conflict: true });
  }
  const next = { ...approvedOf(db, projectId) }, tools = { ...(getProjectParam(db, projectId, APPROVED_TOOLS_KEY) ?? {}) };
  for (const [id, s] of pick) { next[id] = s.fingerprint; tools[id] = s.tools; }
  writeParam(db, { projectId, key: APPROVED_KEY, value: next, by: { kind: 'user', id: userId }, governance: 'constitutional', layer: 'project' });
  writeParam(db, { projectId, key: APPROVED_TOOLS_KEY, value: tools, by: { kind: 'user', id: userId }, governance: 'constitutional', layer: 'project' });
  const off = offOf(db, projectId);
  for (const [id] of pick) if (off[id]) setServerOff(db, { projectId, id, off: false, userId });
  audit(db, { actorKind: 'user', actorId: userId, action: 'mcp_approved', targetType: 'project', targetId: projectId,
    payload: { servers: pick.map(([id, s]) => ({ id, fingerprint: s.fingerprint.slice(0, 12), tools: s.tools.map((t) => t.name) })) } });
  return pick.map(([id]) => id);
}

export function setToolMode(db, { projectId, tool, mode, userId }) {
  if (!TOOL_MODES.includes(mode)) throw new I18nError('工具的用法只能是 auto（直接用）、ask（每次问人）或 off（不给 AI）');
  if (!String(tool).startsWith(MCP_PREFIX)) throw new I18nError('MCP 工具的全名以 mcp__ 开头：{tool}', { tool: String(tool).slice(0, 80) });
  const next = { ...modesOf(db, projectId), [tool]: mode };
  writeParam(db, { projectId, key: MODES_KEY, value: next, by: { kind: 'user', id: userId }, governance: 'constitutional', layer: 'project' });
  audit(db, { actorKind: 'user', actorId: userId, action: 'mcp_tool_mode', targetType: 'project', targetId: projectId, payload: { tool, mode } });
}

// ── 工具名 ──────────────────────────────────────────────────────────────────
/** mcp__<server>__<tool>：只留 [A-Za-z0-9_-]，最长 64；超长或撞名时截断加 sha1 前 8 位 */
export function toolNames(server, tools, taken = new Set()) {
  const out = new Map();
  for (const t of tools) {
    let n = `${MCP_PREFIX}${server}__${String(t.name).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    if (n.length > NAME_MAX || taken.has(n)) {
      const h = createHash('sha1').update(`${server}\0${t.name}`).digest('hex').slice(0, 8);
      n = `${n.slice(0, NAME_MAX - 9)}_${h}`;
    }
    taken.add(n); out.set(n, t.name);
  }
  return out;
}

// ── 协议 ────────────────────────────────────────────────────────────────────
/**
 * 一条 stdio 连接上的 JSON-RPC。proc：{ stdin, stdout, stderr, kill, on }（child_process 的形状）。
 * 新旧两版：先发 server/discover（2026-07-28，无状态，每个请求的 _meta 里带版本与客户端能力）；
 * 回错误或超时就走旧版 initialize + notifications/initialized。
 */
export class McpConnection {
  constructor(proc, { name = 'mcp', onLog = () => {}, bridged = false } = {}) {
    this.proc = proc; this.name = name; this.onLog = onLog; this.bridged = bridged;
    this.next = 1; this.pending = new Map(); this.buf = ''; this.closed = false; this.protocol = null; this.serverInfo = null;
    this.toolsChanged = false; this.stderrTail = '';
    proc.stdout.setEncoding?.('utf8');
    proc.stdout.on('data', (d) => this.#onData(String(d)));
    proc.stderr?.on('data', (d) => { this.stderrTail = (this.stderrTail + String(d)).slice(-2000); });
    proc.on('exit', (code) => this.#fail(new Error(`MCP server ${this.name} 退出了（退出码 ${code}）${this.stderrTail ? `：${this.stderrTail.trim().split('\n').at(-1)}` : ''}`)));
    proc.on('error', (e) => this.#fail(e));
    proc.stdin.on?.('error', () => { /* 对面已经关了：由 exit 报 */ });
  }
  #fail(e) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }
  #onData(s) {
    this.buf += s;
    if (this.buf.length > READ_BUFFER_MAX) { this.buf = ''; this.#fail(new Error(`MCP server ${this.name} 一条消息超过 10 MB`)); return; }
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { this.onLog(line.slice(0, 300)); continue; }   // 不是 JSON 的行当日志
      this.#onMessage(m);
    }
  }
  #onMessage(m) {
    if (m && m.id != null && (m.result !== undefined || m.error !== undefined) && this.pending.has(m.id)) {
      const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.timer);
      // 桥（远程 server）自己的报错带模板，按看的人的语言翻；别的 server 回的 data.si 不认（桥已经剥掉了远程那头的）
      const si = this.bridged && m.error?.data?.si && typeof m.error.data.si.tpl === 'string' ? m.error.data.si : null;
      if (m.error) p.reject(Object.assign(si ? new I18nError(si.tpl, si.params ?? {}) : new Error(String(m.error.message ?? 'error')), { rpc: m.error })); else p.resolve(m.result);
      return;
    }
    if (m?.method && m.id != null) {
      // server 发来的请求：只答 ping；sampling / roots / elicitation 一律不支持（沙箱里的 server 不能借我们的模型、读宿主目录）
      this.#send(m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported by this client' } });
      return;
    }
    if (m?.method === 'notifications/tools/list_changed') this.toolsChanged = true;
  }
  #send(obj) { if (!this.closed) this.proc.stdin.write(`${JSON.stringify(obj)}\n`); }
  #meta() { return this.protocol === PROTOCOL_NEW ? { _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL_NEW, 'io.modelcontextprotocol/clientCapabilities': {} } } : {}; }
  request(method, params = {}, timeoutMs = TOOL_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error(`MCP server ${this.name} 已经关了`));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error(`MCP server ${this.name}：${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`), { timeout: true })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params: { ...params, ...this.#meta() } });
    });
  }
  notify(method, params = {}) { this.#send({ jsonrpc: '2.0', method, params }); }

  async connect({ timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
    try {
      this.protocol = PROTOCOL_NEW;
      const r = await this.request('server/discover', {}, Math.min(DISCOVER_TIMEOUT_MS, timeoutMs));
      this.serverInfo = r?.serverInfo ?? null;
      return { protocol: PROTOCOL_NEW, serverInfo: this.serverInfo };
    } catch (e) {
      if (this.closed) throw e;
      this.protocol = PROTOCOL_OLD;
    }
    const r = await this.request('initialize', { protocolVersion: PROTOCOL_OLD, capabilities: {}, clientInfo: { name: 'superintern', version: '0' } }, timeoutMs);
    this.protocol = typeof r?.protocolVersion === 'string' ? r.protocolVersion : PROTOCOL_OLD;
    if (this.protocol === PROTOCOL_NEW) this.protocol = PROTOCOL_OLD;   // 走了 initialize 就按旧版说话
    this.serverInfo = r?.serverInfo ?? null;
    this.notify('notifications/initialized');
    return { protocol: this.protocol, serverInfo: this.serverInfo };
  }
  async listTools({ timeoutMs = STARTUP_TIMEOUT_MS } = {}) {
    const all = [];
    let cursor;
    for (let page = 0; page < 50; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs);
      for (const t of Array.isArray(r?.tools) ? r.tools : []) if (t && typeof t.name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(t.name)) all.push(t);
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    this.toolsChanged = false;
    return all;
  }
  callTool(name, args, { timeoutMs = TOOL_TIMEOUT_MS } = {}) { return this.request('tools/call', { name, arguments: args ?? {} }, timeoutMs); }
  /** 先关 stdin（stdio server 读到 EOF 就该退），2 秒后还在就杀 */
  async close() {
    if (this.closed && this.proc.exitCode != null) return;
    try { this.proc.stdin.end(); } catch { /* 已关 */ }
    await new Promise((ok) => {
      const t = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* 已退 */ } ok(); }, 2000);
      if (this.proc.exitCode != null) { clearTimeout(t); ok(); return; }
      this.proc.once?.('exit', () => { clearTimeout(t); ok(); });
    });
    this.#fail(new Error('closed'));
  }
}

/** tools/call 的结果 → 给模型的文本。图片 / 音频只报个数与类型；资源给文本或 uri；没有文字就给 structuredContent */
export function renderResult(r, L = 'zh') {
  const parts = [];
  for (const c of Array.isArray(r?.content) ? r.content : []) {
    if (c?.type === 'text') parts.push(String(c.text ?? ''));
    else if (c?.type === 'image' || c?.type === 'audio') parts.push(tl(L, '[{type} {mime}，{n} 字符的 base64，没有展示]', { type: c.type, mime: c.mimeType ?? '', n: String(c.data ?? '').length }));
    else if (c?.type === 'resource') parts.push(c.resource?.text != null ? String(c.resource.text) : `[resource ${c.resource?.uri ?? ''}]`);
    else if (c?.type === 'resource_link') parts.push(`[resource_link ${c.uri ?? ''}${c.name ? ` ${c.name}` : ''}]`);
  }
  if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  return { text: parts.join('\n'), isError: r?.isError === true };
}

// ── 起 server ───────────────────────────────────────────────────────────────
/** 在 exec 里起一个 server 并连上、列出工具。exec 要有 spawnStream（LocalExecutor / ContainerExecutor 都有） */
export async function startServer(server, { exec, workspace, onLog = () => {} }) {
  if (typeof exec?.spawnStream !== 'function') throw new I18nError('这里起不了 MCP server（执行环境不支持长连接的子进程）');
  const proc = await exec.spawnStream({ file: server.command, args: server.args }, workspace, { env: server.env });
  const conn = new McpConnection(proc, { name: server.name, onLog, bridged: !!server.remote });
  try {
    const info = await conn.connect({ timeoutMs: server.startupTimeoutMs });
    let tools = await conn.listTools({ timeoutMs: server.startupTimeoutMs });
    if (server.enabledTools) tools = tools.filter((t) => server.enabledTools.includes(t.name));
    if (server.disabledTools) tools = tools.filter((t) => !server.disabledTools.includes(t.name));
    return { conn, tools, ...info };
  } catch (e) { await conn.close().catch(() => {}); throw e; }
}

/** mcp check：把每个 server 起一遍、看工具清单（不批准）。exec 由调用方给（沙箱），跑完调用方收 */
export async function probeServers(servers, { exec, workspace }) {
  const out = [];
  for (const server of servers) {
    try {
      const s = await startServer(server, { exec, workspace });
      out.push({ server, ok: true, tools: s.tools, protocol: s.protocol, serverInfo: s.serverInfo, fingerprint: fingerprint(server, s.tools) });
      await s.conn.close();
    } catch (e) { out.push({ server, ok: false, error: e instanceof I18nError ? { msg: e.tpl, params: e.params ?? {} } : String(e.message).slice(0, 300) }); }
  }
  return out;
}

// ── 执行器的一段会话 ──────────────────────────────────────────────────────────
/**
 * 执行器开跑时起批准过的 server，给出工具定义与调用入口；收尾时 close()。
 * 指纹对不上（批准之后命令 / 工具清单变了）、起不来的 server：它的工具这一段都不给，记审计 —— 不报错，不挡这一步。
 * 返回 { tools: [工具定义], modeOf(name), call(name, args) → 文本, close(), names: Set }
 */
export async function makeMcpSession(db, { taskId, nodeId = null, projectId = null, workspace, exec, baseRef = null, spill = null }) {
  const empty = { tools: [], names: new Set(), modeOf: () => null, call: async () => '', close: async () => {}, servers: [] };
  if (!projectId) return empty;
  const { servers } = listServers(db, { projectId, workspace, ref: baseRef });
  const approved = approvedOf(db, projectId);
  const off = offOf(db, projectId);
  const wanted = servers.filter((s) => approved[s.id] && !off[s.id]);
  if (!wanted.length) return empty;
  const modes = modesOf(db, projectId);
  const L = contentLang(db);   // 给模型看的话按内容语言写
  const why = (e) => (e instanceof I18nError ? tl(L, e.tpl, e.params ?? {}) : String(e.message));
  const live = [], tools = [], route = new Map(), taken = new Set();
  const target = nodeId ? { targetType: 'node', targetId: nodeId } : { targetType: 'task', targetId: taskId };
  for (const server of wanted) {
    let s;
    try { s = await startServer(server, { exec, workspace }); } catch (e) {
      audit(db, { actorKind: 'system', action: 'mcp_start_failed', ...target, payload: { server: server.id, why: String(e.message).slice(0, 300) } });
      continue;
    }
    const fp = fingerprint(server, s.tools);
    if (fp !== approved[server.id]) {
      audit(db, { actorKind: 'system', action: 'mcp_fingerprint_changed', ...target, payload: { server: server.id, approved: String(approved[server.id]).slice(0, 12), now: fp.slice(0, 12) } });
      // 安全边界被系统改了（底线通知）：每次运行都会再撞上，同一个变化只说一次
      { const L = contentLang(db); const name = server.name ?? server.id;
        trySignalOnce(db, 'security.mcp_changed', { to: [db.one('SELECT owner_id FROM projects WHERE id=?', projectId)?.owner_id].filter(Boolean), projectId, taskId, ref: server.id + ':' + fp.slice(0, 12),
          title: tl(L, '[SuperIntern] MCP server {name} 和批准时不一样了，AI 暂时用不到它', { name }),
          text: tl(L, '它的命令或工具说明和你批准的那一版对不上（可能是升级了，也可能被改过）。在它重新批准之前，AI 用不到它。到项目设置的 MCP 里看过新版本再批准。') }); }
      await s.conn.close().catch(() => {});
      continue;
    }
    live.push({ server, conn: s.conn });
    for (const [full, raw] of toolNames(server.name, s.tools, taken)) {
      const t = s.tools.find((x) => x.name === raw);
      const mode = modes[full] ?? 'ask';
      if (mode === 'off') continue;
      const schema = t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
      tools.push({ name: full, description: `[MCP · ${server.name}]${mode === 'ask' ? tl(L, '（每次调用要人批准）') : ''} ${String(t.description ?? '').slice(0, 1000)}`.trim(), parameters: schema });
      route.set(full, { conn: s.conn, server, tool: raw, mode });
    }
  }
  if (live.length) audit(db, { actorKind: 'system', action: 'mcp_session_started', ...target, payload: { servers: live.map((x) => x.server.id), tools: tools.map((t) => t.name) } });
  return {
    tools, servers: live.map((x) => x.server.id), names: new Set(route.keys()),
    modeOf: (name) => route.get(name)?.mode ?? null,
    async call(name, args) {
      const r = route.get(name);
      if (!r) return tl(L, '没有这个工具：{name}', { name: String(name).slice(0, 80) });
      if (r.conn.closed) return tl(L, '[MCP] {server} 已经断开，这一段用不了它了。', { server: r.server.name });
      let res;
      try { res = await r.conn.callTool(r.tool, args, { timeoutMs: r.server.toolTimeoutMs }); } catch (e) {
        audit(db, { actorKind: 'system', action: 'mcp_call_failed', ...target, payload: { tool: name, why: String(e.message).slice(0, 300) } });
        return tl(L, '[MCP] 调用 {name} 失败：{why}', { name, why: why(e).slice(0, 500) });
      }
      audit(db, { actorKind: 'agent', actorId: 'executor', action: 'mcp_called', ...target, payload: { tool: name, isError: res?.isError === true } });
      // 工具清单中途变了：这一段剩下的时间不再信它（变了的说明可能带着新指令），收掉
      if (r.conn.toolsChanged) {
        audit(db, { actorKind: 'system', action: 'mcp_tools_changed_midrun', ...target, payload: { server: r.server.id } });
        await r.conn.close().catch(() => {});
      }
      const { text, isError } = renderResult(res, L);
      const body = text.length > OUTPUT_INLINE_MAX && spill ? spill(name, text) : text;
      return `${isError ? tl(L, '[MCP 工具报错] ') : ''}${body}`;
    },
    async close() { await Promise.all(live.map((x) => x.conn.close().catch(() => {}))); },
  };
}

// ── 看清单、批准（mcp check / list）────────────────────────────────────────────
/**
 * mcp check：在项目分支的一份干净克隆上、借载体任务的沙箱把每个 server 起一遍，记下工具清单（快照）。
 * 批准只能批准看过的快照 —— 负责人看的是工具说明原文（工具说明就是会进模型上下文的东西）。
 */
export async function checkProject(db, { projectId, home, makeExec = null, userId = null }) {
  const p = db.one(`SELECT id, repo, branch FROM projects WHERE id=?`, projectId);
  if (!p) throw new I18nError('没有这个项目：{id}', { id: projectId });
  const { servers, warnings } = listServers(db, { projectId, workspace: p.repo, ref: p.branch });
  if (!servers.length) return { results: [], warnings };
  const carrier = db.one(`SELECT id FROM tasks WHERE project_id=? AND project_order=0`, projectId)
    ?? db.one(`SELECT id FROM tasks WHERE project_id=? ORDER BY project_order DESC LIMIT 1`, projectId);
  if (!carrier && !makeExec) throw new I18nError('项目里还没有任务，起不了沙箱去看 MCP server');
  const root = join(home, 'mcpcheck'), dir = join(root, projectId);
  rmSync(dir, { recursive: true, force: true });   // 路径是这里拼的（数据目录下固定位置），不是人填的
  mkdirSync(root, { recursive: true });
  let exec = null;
  try {
    git(root, '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-hardlinks', '--branch', p.branch, '--', p.repo, dir);
    exec = await (makeExec ?? lazySandbox(db, carrier.id, home))();
    const results = await probeServers(servers, { exec, workspace: dir });
    recordSnapshot(db, { projectId, results, userId });
    audit(db, { actorKind: userId ? 'user' : 'system', actorId: userId, action: 'mcp_checked', targetType: 'project', targetId: projectId,
      payload: { servers: results.map((r) => ({ id: r.server.id, ok: r.ok, tools: r.ok ? r.tools.length : 0, fingerprint: r.fingerprint?.slice(0, 12) ?? null, error: r.error ?? null })) } });
    return { results, warnings };
  } finally {
    try { if (exec?.stop) await exec.stop({ remove: true }); else if (exec?.dispose) await exec.dispose(); } catch { /* 清理失败不改结论 */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
}

/**
 * 一个项目的 MCP 全貌（命令行 / 看板用）：每个 server 的来源、命令、状态，看过的工具清单与每个工具的用法。
 *   status：approved（批准的就是看过的这份）| changed（批准之后再看，清单或命令变了）| new（看过、没批准）| unchecked（还没看过）| error（看的时候起不来）
 */
export function mcpOverview(db, { projectId, showCommands = true }) {
  const p = db.one(`SELECT repo, branch FROM projects WHERE id=?`, projectId);
  const { servers, warnings } = p ? listServers(db, { projectId, workspace: existsSync(p.repo) ? p.repo : null, ref: p.branch }) : { servers: [], warnings: [] };
  const snap = snapshotOf(db, projectId), approved = approvedOf(db, projectId), modes = modesOf(db, projectId), approvedTools = getProjectParam(db, projectId, APPROVED_TOOLS_KEY) ?? {}, off = offOf(db, projectId);
  const files = { deploy: deployMcpFile(), project: projectMcpFile(db, projectId), repo: REPO_MCP_FILE };
  // 说的是某个 server 的警告挂到那个 server 的卡上（离要做决定的地方近）；剩下的（JSON 坏了、被跳过的 server……）挂在来源下
  const ofServer = (s) => warnings.filter((w) => w.params?.file === s.file && w.params?.name === s.name);
  const claimed = new Set(servers.flatMap(ofServer));
  return { warnings, sources: Object.entries(files).map(([kind, file]) => ({ kind, warnings: warnings.filter((w) => w.params?.file === file && !claimed.has(w)) })),
    servers: servers.map((s) => {
    const sn = snap[s.id];
    const status = off[s.id] ? 'off' : !sn ? 'unchecked' : sn.error ? 'error' : !approved[s.id] ? 'new' : approved[s.id] === sn.fingerprint ? 'approved' : 'changed';
    const names = sn?.tools ? toolNames(s.name, sn.tools) : new Map();
    // 宿主上的配置（部署 / 项目）命令行与地址只给负责人与管理员看：参数里可能带着令牌之类；仓库里的本来就在仓库里
    const visible = showCommands || s.source === 'repo';
    const own = ofServer(s);
    return { id: s.id, name: s.name, source: s.source, remote: !!s.remote, url: visible ? s.remote?.url ?? null : null, command: visible && !s.remote ? [s.command, ...s.args].join(' ') : null,
      env: Object.keys(s.env), status, error: sn?.error ?? null, checkedAt: sn?.at ?? null, warnings: own, seen: sn?.fingerprint?.slice(0, 16) ?? null,
      changes: status === 'changed' && approvedTools[s.id] ? diffTools(approvedTools[s.id], sn.tools) : [], fingerprintOnly: status === 'changed' && approvedTools[s.id] && !diffTools(approvedTools[s.id], sn.tools).length,
      protocol: sn?.protocol ?? null, tools: [...names].map(([full, raw]) => { const t = sn.tools.find((x) => x.name === raw); return { full, name: raw, description: t.description, annotations: t.annotations, mode: modes[full] ?? 'ask' }; }) };
  }) };
}
