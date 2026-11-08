/**
 * 策略钩子：在固定的时机跑一段确定性的脚本，返回放行 / 拦下 / 要人确认。
 *
 * 线上格式直接用 Claude Code 与 Codex 已经趋同的那一套，用户现有的钩子能直接搬过来：
 *   - stdin 收一个 JSON：hook_event_name、tool_name、tool_input、cwd……；
 *   - exit 2 = 拦下，理由取 stderr；exit 0 = 看 stdout 的 JSON：hookSpecificOutput.permissionDecision（allow / deny / ask / defer）
 *     + permissionDecisionReason；也认老写法 { decision: 'block' | 'approve', reason } 与 { continue: false, stopReason }；
 *   - 其它退出码、超时、起不来 = 钩子出错 —— 按这个时机的失败策略处理。
 * 多个钩子都匹配时都跑，结论按 deny > ask > allow 合并（defer 当 allow：我们没有别的权限流程可以"交回去"），理由拼起来。
 *
 * 时机：
 *   PreToolUse  执行器每次调工具之前（raise_question / submit_handoff / request_egress 不过钩子：拦住"问人"没有意义）
 *   PreHandoff  执行器交接、机械校验通过之后、验收员之前
 *   PreMerge    签收过的任务合进项目分支之前（gateHooks；仓库钩子从项目分支当前头读，专门起一次沙箱跑）
 *   PreDeliver  推到外面（任务交付 / 项目交付）之前
 * 失败策略：前两个默认放行（fail-open，Claude Code 的 PreToolUse 与 Codex 都是这样），单个钩子写 "onFailure": "block" 就拦；
 * 合并前、交付前一律拦（fail-closed）：钩子出错、没信任、起不来都算拦下 —— 这两道是放东西出去的最后一关。
 *
 * 来源与信任：
 *   - 仓库：`.superintern/hooks.json`，以及 `.claude/settings.json` 里的 hooks（只认 PreToolUse —— 别的事件和我们的时机对不上）。
 *     **配置从任务开工时的基线提交读**（不是工作区）：执行器在这个任务里改了钩子，管不到它自己。只在沙箱里跑、只读挂载。
 *     钩子文件在工作区里被改过（配置或 .superintern/hooks/、.claude/hooks/ 下的脚本）就不跑仓库钩子、当作拦下（不能靠改脚本绕过），
 *     交接时也会打回（同规则文件）。
 *   - 宿主：`<数据目录>/hooks.json`（对所有项目）与 `<数据目录>/projects/<id>/hooks.json`（只对这个项目），只有操作人改得了。
 *     **按内容 hash 信任**：命令 + 命令里点到的脚本文件的内容。`hook trust` 记下 hash；内容一变就不跑，要重新信任（Codex 的做法）。
 *     在宿主上跑：argv 拆分、不经 shell，环境变量只给白名单。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gitRaw } from './git.mjs';
import { splitArgv } from './notify.mjs';
import { spawnCapped } from './executor.mjs';
import { writeParam, getProjectParam } from './params.mjs';
import { audit } from '../db/db.mjs';
import { I18nError, N_, tl, contentLang } from '../i18n/index.mjs';
import { trySignalOnce } from './signals.mjs';

export const EVENTS = ['PreToolUse', 'PreHandoff', 'PreMerge', 'PreDeliver'];
/** 答复里哪些算"同意"（钩子要人确认时）。其余都算不同意 —— 拿不准时不放行。 */
export const HOOK_APPROVE = /^\s*(同意|可以|允许|放行|yes\b|ok\b|okay\b|agree|approve|allow)/i;
export const REPO_HOOK_FILES = ['.superintern/hooks.json', '.claude/settings.json'];
export const REPO_HOOK_DIRS = ['.superintern/hooks/', '.claude/hooks/'];
const DEFAULT_TIMEOUT_S = 30, MAX_TIMEOUT_S = 600, REASON_MAX = 2000, CONTEXT_MAX = 10_000;
const TRUST_KEY = 'hooks.trusted';
const W = (msg, params = {}) => ({ msg, params });

/** 我们的工具名 ↔ Claude Code 的工具名：matcher 写哪个都认，tool_input 两种字段都给。 */
export const TOOL_ALIASES = { run_command: 'Bash', write_file: 'Write', read_file: 'Read', grep: 'Grep', list_dir: 'LS', activate_skill: 'Skill' };
export const HOOKED_TOOLS = Object.keys(TOOL_ALIASES);

/** 这个路径是钩子文件吗（配置或钩子脚本目录下的）。执行器改它们算越界。 */
export const isHookPath = (p) => { const x = String(p).replace(/\\/g, '/').replace(/^\.\//, ''); return REPO_HOOK_FILES.includes(x) || REPO_HOOK_DIRS.some((d) => x.startsWith(d)); };

export const deployHooksFile = () => join(process.env.SUPERINTERN_HOME ?? join(process.cwd(), '.superintern'), 'hooks.json');
export const projectHooksFile = (db, projectId) => {
  const repo = projectId ? db.one(`SELECT repo FROM projects WHERE id=?`, projectId)?.repo : null;
  return repo ? join(dirname(repo), 'hooks.json') : null;
};

/**
 * 一份 hooks 配置（Claude Code 的形状：{ hooks: { 事件: [{ matcher, hooks: [{ type: 'command', command, timeout, onFailure }] }] } }）
 * 拆成平铺的条目。认不得的事件、type 不是 command 的只记警告。
 */
export function parseHooksConfig(text, { source, file, events = EVENTS }) {
  const warnings = [];
  let j;
  try { j = JSON.parse(String(text)); } catch (e) { return { entries: [], warnings: [W(N_('{file} 不是合法的 JSON：{why}'), { file, why: String(e.message).slice(0, 160) })] }; }
  const hooks = j?.hooks;
  if (!hooks || typeof hooks !== 'object') return { entries: [], warnings };
  const entries = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!events.includes(event)) { if (EVENTS.includes(event) || /^Pre|^Post|^Stop|^Session|^User|^Notif/.test(event)) warnings.push(W(N_('{file}：事件 {event} 这里不认，跳过'), { file, event })); continue; }
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => (Array.isArray(g?.hooks) ? g.hooks : []).forEach((h, hi) => {
      if (h?.type !== 'command' || typeof h.command !== 'string' || !h.command.trim()) { warnings.push(W(N_('{file}：{event} 第 {n} 条不是 command 类型的钩子，跳过'), { file, event, n: `${gi + 1}.${hi + 1}` })); return; }
      const timeout = Math.min(MAX_TIMEOUT_S, Math.max(1, Number.isFinite(Number(h.timeout)) ? Number(h.timeout) : DEFAULT_TIMEOUT_S));
      entries.push({ id: `${source}:${file}#${event}.${gi + 1}.${hi + 1}`, source, file, event, matcher: typeof g.matcher === 'string' ? g.matcher : '',
        command: h.command.trim(), timeout, onFailure: h.onFailure === 'block' ? 'block' : 'allow' });
    }));
  }
  return { entries, warnings };
}

/** matcher 只含字母、数字、_ 与 | 时按名字精确匹配，否则当（不锚定的）正则；空 / * 匹配全部。工具名与它的 Claude 别名都试。 */
export function matches(matcher, name) {
  if (!matcher || matcher === '*') return true;
  const names = [name, TOOL_ALIASES[name]].filter(Boolean);
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) { const set = matcher.split('|'); return names.some((n) => set.includes(n)); }
  try { const re = new RegExp(matcher); return names.some((n) => re.test(n)); } catch { return false; }
}

// ── 信任（宿主钩子）─────────────────────────────────────────────────────────
/** 宿主钩子的内容指纹：事件 + matcher + 命令 + 命令里点到的、在宿主上存在的文件的内容。 */
export function hostHookHash(entry) {
  const h = createHash('sha256').update(JSON.stringify([entry.event, entry.matcher, entry.command]));
  const base = dirname(entry.file);
  for (const tok of splitArgv(entry.command)) {
    const p = isAbsolute(tok) ? tok : resolve(base, tok);
    try { if (/[\\/.]/.test(tok) && existsSync(p)) h.update(`\0${tok}\0`).update(readFileSync(p)); } catch { /* 读不了：只按命令文本算 */ }
  }
  return h.digest('hex');
}
const trustedMap = (db, projectId) => {
  const sys = db.one(`SELECT value FROM params WHERE task_id IS NULL AND project_id IS NULL AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, TRUST_KEY);
  let m = {};
  try { m = sys ? JSON.parse(sys.value) ?? {} : {}; } catch { m = {}; }
  const proj = projectId ? getProjectParam(db, projectId, TRUST_KEY) : null;
  return { ...m, ...(proj && typeof proj === 'object' ? proj : {}) };
};

/** 读宿主上的钩子（部署 + 项目），标上信任状态。 */
export function hostHooks(db, { projectId = null, deployFile = deployHooksFile() } = {}) {
  const out = [], warnings = [];
  const trusted = trustedMap(db, projectId);
  for (const [source, file] of [['deploy', deployFile], ['project', projectHooksFile(db, projectId)]]) {
    if (!file || !existsSync(file)) continue;
    const r = parseHooksConfig(readFileSync(file, 'utf8'), { source, file });
    warnings.push(...r.warnings);
    for (const e of r.entries) { const hash = hostHookHash(e); out.push({ ...e, hash, trusted: trusted[e.id] === hash, everTrusted: trusted[e.id] != null }); }
  }
  return { entries: out, warnings };
}

/** 操作人信任当前的宿主钩子（全部，或给定 id 的那几条）。记 hash；之后内容一变就不跑。 */
export function trustHostHooks(db, { projectId = null, ids = null, userId }) {
  const { entries } = hostHooks(db, { projectId });
  const pick = entries.filter((e) => (projectId ? e.source === 'project' : e.source === 'deploy') && (!ids || ids.includes(e.id)));
  if (!pick.length) throw new I18nError('没有要核准的宿主钩子');
  const cur = projectId ? (getProjectParam(db, projectId, TRUST_KEY) ?? {}) : (() => { try { return JSON.parse(db.one(`SELECT value FROM params WHERE task_id IS NULL AND project_id IS NULL AND key=? AND superseded_at IS NULL ORDER BY recorded_at DESC, rowid DESC LIMIT 1`, TRUST_KEY)?.value ?? '{}'); } catch { return {}; } })();
  const next = { ...cur };
  for (const e of pick) next[e.id] = e.hash;
  writeParam(db, { projectId, key: TRUST_KEY, value: next, by: { kind: 'user', id: userId }, governance: 'constitutional', layer: projectId ? 'project' : 'system' });
  audit(db, { actorKind: 'user', actorId: userId, action: 'hooks_trusted', targetType: projectId ? 'project' : 'deploy', targetId: projectId ?? 'deploy', payload: { hooks: pick.map((e) => ({ id: e.id, hash: e.hash.slice(0, 12), command: e.command.slice(0, 200) })) } });
  return pick.map((e) => e.id);
}

// ── 仓库钩子 ────────────────────────────────────────────────────────────────
/** 从 `ref`（任务开工时的基线）读仓库里的钩子配置。非 git 工作区（离线测试）读文件。 */
export function repoHooks(workspace, ref) {
  const out = [], warnings = [];
  const git = existsSync(join(workspace, '.git')) && ref;
  for (const file of REPO_HOOK_FILES) {
    let text = null;
    try { text = git ? gitRaw(workspace, ['show', `${ref}:${file}`]) : (existsSync(join(workspace, file)) ? readFileSync(join(workspace, file), 'utf8') : null); } catch { text = null; }
    if (text == null) continue;
    const r = parseHooksConfig(text, { source: 'repo', file, events: file === '.claude/settings.json' ? ['PreToolUse'] : EVENTS });
    out.push(...r.entries); warnings.push(...r.warnings);
  }
  return { entries: out, warnings };
}
/** 钩子文件在工作区里相对基线改过没有（已提交的改动 + 没提交的 + 新建的）。返回改过的路径。 */
export function tamperedHookFiles(workspace, ref) {
  if (!ref || !existsSync(join(workspace, '.git'))) return [];
  const paths = [...REPO_HOOK_FILES, ...REPO_HOOK_DIRS.map((d) => d.slice(0, -1))];
  try {
    const a = gitRaw(workspace, ['diff', '--name-only', ref, '--', ...paths]).split('\n');
    const b = gitRaw(workspace, ['ls-files', '--others', '--exclude-standard', '--', ...paths]).split('\n');
    return [...new Set([...a, ...b].map((s) => s.trim()).filter(Boolean))];
  } catch { return []; }
}

// ── 跑 ──────────────────────────────────────────────────────────────────────
const SHELLY = /[|&;<>()$`*?{}[\]~]|\\n/;
/** 一条钩子的结论：{ decision: allow|deny|ask, reason, context, failed, why } */
export function readHookResult(r) {
  const err = String(r.stderr ?? '').trim().slice(0, REASON_MAX), out = String(r.stdout ?? '').trim();
  if (r.timedOut) return { decision: null, failed: true, why: W(N_('超时')) };
  if (r.code === 2) return { decision: 'deny', reason: err || null };
  if (r.code !== 0) return { decision: null, failed: true, why: W(N_('退出码 {code}：{err}'), { code: r.code, err: err.slice(0, 300) }) };
  if (!out.startsWith('{')) return { decision: 'allow' };
  let j;
  try { j = JSON.parse(out); } catch { return { decision: null, failed: true, why: W(N_('输出不是合法的 JSON')) }; }
  const hs = j.hookSpecificOutput ?? {};
  const ctx = typeof hs.additionalContext === 'string' ? hs.additionalContext.slice(0, CONTEXT_MAX) : null;
  if (j.continue === false) return { decision: 'deny', reason: String(j.stopReason ?? j.reason ?? '').slice(0, REASON_MAX) || null, context: ctx };
  const pd = hs.permissionDecision ?? (j.decision === 'block' ? 'deny' : j.decision === 'approve' ? 'allow' : null);
  const reason = String(hs.permissionDecisionReason ?? j.reason ?? '').slice(0, REASON_MAX) || null;
  if (pd === 'deny' || pd === 'ask') return { decision: pd, reason, context: ctx };
  return { decision: 'allow', reason, context: ctx };
}

/** 合并：deny > ask > allow；理由按顺序拼。 */
export function mergeDecisions(results) {
  const rank = { deny: 3, ask: 2, allow: 1 };
  let top = 'allow';
  for (const r of results) if ((rank[r.decision] ?? 0) > rank[top]) top = r.decision;
  // failed：拦下全是因为钩子自己出错（没有一条是检查没过）—— 合并前 / 交付前据此告诉人"去修钩子"，而不是"让 AI 改"
  const denies = results.filter((r) => r.decision === 'deny');
  return { decision: top, reasons: results.filter((r) => r.decision === top && top !== 'allow' && r.reason).map((r) => ({ hook: r.hook, reason: r.reason })),
    context: results.map((r) => r.context).filter(Boolean).join('\n\n') || null, failed: top === 'deny' && denies.every((r) => r.failed) };
}

/**
 * 一个任务的钩子会话：开跑时读一次配置（仓库从基线、宿主带信任状态），之后每个时机调 run(event, payload)。
 *   exec / workspace：仓库钩子在这个沙箱里、只读挂载跑；宿主钩子在宿主上、cwd = 工作区。
 * run 返回 { decision, reasons, context, ran } —— 没有匹配的钩子时 ran = 0、decision = allow。
 */
export function makeHookSession(db, { taskId, nodeId = null, projectId = null, workspace, exec, baseRef, failClosed = false, allowTamper = false }) {
  const repo = workspace ? repoHooks(workspace, baseRef) : { entries: [], warnings: [] };
  const host = hostHooks(db, { projectId });
  const all = [...host.entries, ...repo.entries];
  const warned = new Set();
  const note = (action, payload) => { const k = `${action}:${payload.hook}`; if (warned.has(k)) return; warned.add(k); audit(db, { actorKind: 'system', action, targetType: nodeId ? 'node' : 'task', targetId: nodeId ?? taskId, payload }); };
  const cwdIn = exec?.isolated ? '/workspace-ro' : workspace;   // 仓库钩子在只读挂载上跑（容器里的 cwd）

  async function runOne(e, input) {
    if (e.source !== 'repo' && !e.trusted) {
      note('hook_untrusted', { hook: e.id, command: e.command.slice(0, 200) });
      return { failed: true, why: W(N_('宿主钩子还没核准，或核准之后内容改过，没跑：管理员（项目上的钩子也可以是项目负责人）看过之后运行 hook trust 核准')) };
    }
    if (e.source === 'repo') {
      const bad = allowTamper ? [] : tamperedHookFiles(workspace, baseRef);
      if (bad.length) return { decision: 'deny', reason: null, tampered: bad };
      const argv = SHELLY.test(e.command) ? ['sh', '-c', `CLAUDE_PROJECT_DIR="$PWD"; SUPERINTERN_PROJECT_DIR="$PWD"; export CLAUDE_PROJECT_DIR SUPERINTERN_PROJECT_DIR; ${e.command}`] : splitArgv(e.command);
      const r = await exec.execute({ file: argv[0], args: argv.slice(1) }, workspace, { mode: 'read-only', timeoutMs: e.timeout * 1000, maxOutputBytes: 64 * 1024, input });
      return readHookResult(r);
    }
    const argv = splitArgv(e.command);
    const r = await spawnCapped(argv[0], argv.slice(1), { cwd: workspace, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, HOME: process.env.HOME, SUPERINTERN_PROJECT_DIR: workspace, CLAUDE_PROJECT_DIR: workspace },
      timeoutMs: e.timeout * 1000, maxOutputBytes: 64 * 1024, input });
    return readHookResult(r);
  }

  return {
    entries: all, warnings: [...host.warnings, ...repo.warnings],
    has: (event) => all.some((e) => e.event === event),
    async run(event, payload, { tool = null } = {}) {
      const hit = all.filter((e) => e.event === event && (event !== 'PreToolUse' || matches(e.matcher, tool)));
      if (!hit.length) return { decision: 'allow', reasons: [], context: null, tampered: [], ran: 0 };
      const input = JSON.stringify({ hook_event_name: event, session_id: nodeId ?? taskId, task_id: taskId, node_id: nodeId, cwd: cwdIn, ...payload });
      const results = await Promise.all(hit.map(async (e) => {
        let r;
        try { r = await runOne(e, input); } catch (err) { r = { failed: true, why: W(N_('起不来：{why}'), { why: String(err.message).slice(0, 200) }) }; }
        if (r.tampered) return { hook: e.id, decision: 'deny', reason: null, tampered: r.tampered };
        if (r.failed) {
          audit(db, { actorKind: 'system', action: 'hook_failed', targetType: nodeId ? 'node' : 'task', targetId: nodeId ?? taskId, payload: { hook: e.id, event, why: r.why, onFailure: e.onFailure } });
          const block = failClosed || e.onFailure === 'block';
          // 安全边界被系统改了：钩子坏了、照规矩放行 —— 这一段时间里它等于没有。每个任务、每个钩子说一次
          if (!block) { const L = contentLang(db);
            trySignalOnce(db, 'security.hook_failed_open', { to: ['owner'], taskId, ref: taskId + ':' + e.id, title: tl(L, '[SuperIntern] 策略钩子 {hook} 没跑成，按设置放行了', { hook: e.id }),
              text: tl(L, '钩子没跑成（{why}），它的设置是"出错时放行"，所以这段时间它拦不住任何东西。修好钩子，或把它改成"出错时拦下"。', { why: String(r.why ?? '').slice(0, 200) }) }); }
          return { hook: e.id, decision: block ? 'deny' : 'allow', reason: block ? r.why : null, failed: true };
        }
        return { hook: e.id, ...r };
      }));
      const m = mergeDecisions(results);
      const tampered = [...new Set(results.flatMap((r) => r.tampered ?? []))];
      if (m.decision !== 'allow' || tampered.length) {
        audit(db, { actorKind: 'system', action: 'hook_decision', targetType: nodeId ? 'node' : 'task', targetId: nodeId ?? taskId,
          payload: { event, tool, decision: m.decision, reasons: m.reasons, tampered, hooks: hit.map((e) => e.id) } });
      }
      return { ...m, tampered, ran: hit.length };
    },
  };
}

/**
 * 闸门用的沙箱：用到才起。先把这个任务名下的旧容器收掉 —— 它可能挂着别的目录（项目交付借载体任务的名字跑，
 * 载体上一次验收的容器挂的是验收目录），重启旧容器 = 钩子看到的不是要推的那一份。
 */
export const lazySandbox = (db, taskId, home) => async () => {
  const { makeSandbox } = await import('./container.mjs');
  const ex = await makeSandbox(db, { taskId, home });
  try { await disposeExec(ex); } catch { /* 没有旧容器是常态 */ }
  return ex;
};
/** "要人确认"的确认码：同一份理由（与改过的钩子文件）才认，内容变了要重新确认。 */
export const askKey = (r, lines) => createHash('sha256').update(JSON.stringify({ t: r.tampered ?? [], r: lines })).digest('hex').slice(0, 12);

const disposeExec = async (exec) => { if (!exec) return; if (typeof exec.stop === 'function') return exec.stop({ remove: true }); if (typeof exec.dispose === 'function') return exec.dispose(); };

/**
 * 合并前 / 交付前这类"闸门"：一律 fail-closed。仓库钩子要沙箱 —— 只有这个时机真有仓库钩子时才 makeExec() 起一个，跑完收掉。
 *   ref：仓库钩子的配置从哪一版读（合并前 = 项目分支当前头；交付前 = 任务开工时的基线 / 项目分支）
 *   allowTamper：人确认过"这个任务改了钩子文件"之后，照工作区里的新版本跑
 * 返回 null（这个时机没有钩子）或 { decision, reasons, context, tampered, ran }。tampered 非空时仓库钩子一条都没跑。
 */
export async function gateHooks(db, { event, taskId, projectId = null, workspace, ref, makeExec = null, payload = {}, allowTamper = false }) {
  const probe = makeHookSession(db, { taskId, projectId, workspace, exec: null, baseRef: ref, failClosed: true, allowTamper });
  const mine = probe.entries.filter((e) => e.event === event);
  if (!mine.length) return null;
  const needsSandbox = mine.some((e) => e.source === 'repo');
  if (needsSandbox && !allowTamper) {
    const bad = tamperedHookFiles(workspace, ref);
    if (bad.length) {
      audit(db, { actorKind: 'system', action: 'hook_decision', targetType: 'task', targetId: taskId, payload: { event, decision: 'ask', tampered: bad, hooks: mine.map((e) => e.id) } });
      return { decision: 'ask', reasons: [], context: null, tampered: bad, ran: 0 };
    }
  }
  let exec = null;
  try {
    if (needsSandbox) {
      if (!makeExec) throw new I18nError('仓库里有{event}钩子，但这里起不了沙箱跑它', { event });
      exec = await makeExec();
    }
    const s = makeHookSession(db, { taskId, projectId, workspace, exec, baseRef: ref, failClosed: true, allowTamper });
    return await s.run(event, payload);
  } catch (e) {
    // 起不来也是拦下（fail-closed）
    const why = W(N_('钩子没能跑起来：{why}'), { why: String(e.message).slice(0, 300) });
    audit(db, { actorKind: 'system', action: 'hook_failed', targetType: 'task', targetId: taskId, payload: { event, why } });
    return { decision: 'deny', reasons: [{ hook: event, reason: why }], context: null, tampered: [], ran: mine.length, failed: true };
  } finally { try { await disposeExec(exec); } catch { /* 清理失败不改结论 */ } }
}

// ── 列给人看 ────────────────────────────────────────────────────────────────
/**
 * 系统自带的检查（它们留在原处实现，不改写成钩子 —— 每一条都有专门的测试与事项文案，
 * 搬成钩子只换来形式统一，换掉的是回归风险）。这里只列出来，让人在同一处看到每个时机到底管着什么。
 */
export const BUILTIN_HOOKS = [
  { id: 'sandbox', event: 'PreToolUse', what: N_('命令都在隔离的沙箱里跑：默认断网，只能访问「联网」里放行的地址') },
  { id: 'handoff', event: 'PreHandoff', what: N_('交接记录要写全（产物、接口、验收证据），列出的产物要真的存在') },
  { id: 'scope', event: 'PreHandoff', what: N_('改动要落在任务范围里；越界的打回给 AI') },
  { id: 'shared', event: 'PreHandoff', what: N_('几个任务并行开发时，不能改共享文件（接口契约、根依赖清单与锁文件……）') },
  { id: 'rules', event: 'PreHandoff', what: N_('不能改项目规则文件和钩子文件，除非任务范围里点名了那个文件') },
  { id: 'verify', event: 'PreHandoff', what: N_('交接之后跑任务的验收命令，没过就打回给 AI') },
  { id: 'signoff', event: 'PreMerge', what: N_('合并之前要人签收（例外：自动挡下 AI 自己追加的任务先合并，交付前再一起签收）') },
  { id: 'clean', event: 'PreMerge', what: N_('签收之后工作区里又多出来的改动，先问人怎么处理') },
  { id: 'push', event: 'PreDeliver', what: N_('只推任务自己的分支：不推默认分支、不强推') },
  { id: 'pr', event: 'PreDeliver', what: N_('有高风险步骤的任务，开 PR 前必须签收') },
];

/**
 * 一个项目当前的钩子全貌：系统自带的、配置的（宿主上的带核准状态，仓库里的从项目分支读）、四处来源各自的读配置警告。
 * showCommands 为假时不给宿主钩子的命令行（命令里可能带着令牌之类）。
 *   status：on（会跑）| new（宿主钩子，还没核准过）| changed（核准之后内容变了）
 */
export function hookOverview(db, { projectId, showCommands = false }) {
  const p = db.one(`SELECT repo, branch FROM projects WHERE id=?`, projectId);
  const host = hostHooks(db, { projectId });
  let repo = { entries: [], warnings: [] };
  try { if (p && existsSync(p.repo)) repo = repoHooks(p.repo, p.branch); } catch { /* 读不了仓库：当没有 */ }
  const status = (e) => (e.source === 'repo' || e.trusted ? 'on' : e.everTrusted ? 'changed' : 'new');
  const pick = (e) => ({ id: e.id, source: e.source, file: e.source === 'repo' ? e.file : null, event: e.event, matcher: e.matcher, tool: TOOL_ALIASES_REV[e.matcher] ?? null,
    timeout: e.timeout, onFailure: e.onFailure, command: e.source === 'repo' || showCommands ? e.command : null, status: status(e) });
  const files = { deploy: deployHooksFile(), project: projectHooksFile(db, projectId) };
  const warnOf = (file) => [...host.warnings, ...repo.warnings].filter((w) => w.params?.file === file);
  const sources = [
    ...REPO_HOOK_FILES.map((file) => ({ kind: 'repo', file, warnings: warnOf(file) })),
    { kind: 'deploy', warnings: warnOf(files.deploy) },
    { kind: 'project', warnings: files.project ? warnOf(files.project) : [] },
  ];
  return { builtin: BUILTIN_HOOKS, hooks: [...host.entries, ...repo.entries].map(pick), sources, branch: p?.branch ?? null };
}
const TOOL_ALIASES_REV = Object.fromEntries(Object.entries(TOOL_ALIASES).flatMap(([ours, claude]) => [[ours, ours], [claude, ours]]));

/** 给模型看的工具入参：我们的字段 + Claude Code 的同义字段（file_path、command），现有钩子拿得到它认识的。 */
export function toolInputFor(name, args = {}) {
  const a = args ?? {};
  if (name === 'run_command') return { ...a, command: [a.file, ...(a.args ?? [])].map((x) => (/^[\w./:=@%+-]+$/.test(String(x)) ? String(x) : `'${String(x).replace(/'/g, `'\\''`)}'`)).join(' ') };
  if (name === 'write_file' || name === 'read_file') return { ...a, file_path: a.path };
  return { ...a };
}

/** 一句给人 / 给模型看的理由：每条 "钩子 x：理由"，翻成内容语言由调用方做（hook id 原样）。 */
export const reasonLines = (m, t) => m.reasons.map((r) => `${r.hook}${r.reason ? `：${typeof r.reason === 'string' ? r.reason : t(r.reason.msg, r.reason.params)}` : ''}`);
