// ── 运行状况：管理员的健康卡、公告横幅、看板升级后的刷新提示 ──
const fmtBytes = (n) => (n == null ? '—' : n === 0 ? T('0') : n < 1024 ** 2 ? T('{n} KB', { n: Math.max(1, Math.round(n / 1024)) }) : n < 1024 ** 3 ? T('{n} MB', { n: (n / 1024 ** 2).toFixed(1) }) : T('{n} GB', { n: (n / 1024 ** 3).toFixed(2) }));
const HEALTH_PILL = () => ({ ok: ['ok', T('正常')], warn: ['warn', T('注意')], bad: ['bad', T('有问题')], unknown: ['', T('还不知道')] });
const HEALTH_RANK = { bad: 0, warn: 1, unknown: 2, ok: 3 };
// 备份的种类（文件名里的标记）按界面语言说
const backupTag = (tag) => (tag === 'daily' ? T('每日') : tag === 'weekly' ? T('每周') : tag === 'manual' ? T('手动') : tag === 'pre-restore' ? T('恢复前另存') : /^pre-v\d+$/.test(tag ?? '') ? T('升级前') : esc(tag ?? '?'));

/** 一行：级别标签 + 标题 + 说明 + 要做什么（title / body / todo 都是 HTML 片段 —— tests/web-html 按每个调用点核过已转义） */
function hrow(c, title, body, todo = '') {
  const pill = HEALTH_PILL()[c.level] ?? HEALTH_PILL().unknown;
  return `<div class="item" style="margin-top:8px"><div class="row"><span class="pill ${esc(pill[0])}">${esc(pill[1])}</span> <b>${title}</b></div>
      <div class="small" style="margin-top:4px">${body}</div>${todo ? `<div class="small" style="margin-top:4px;color:var(${c.level === 'bad' ? '--bad' : '--wait'})">${todo}</div>` : ''}</div>`;
}
const hWhen = (ts) => (ts ? T('{t}前', { t: ago(ts) }) : T('从没有'));
const hPath = (p) => (p ? `<div class="small mute mono" style="word-break:break-all">${esc(p)}</div>` : '');
// 守护进程的日志：服务端给出完整路径（数据目录下 logs/daemon.log）
const HC_LOG = (h) => (h.logFile ? `<span class="mono">${esc(h.logFile)}</span>` : T('数据目录下的 <span class="mono">logs/daemon.log</span>'));
// 排序：同级时先放根因（库坏 → 守护进程 → 沙箱 → 备份 → 库体积 → SQLite 版本）
const HEALTH_ORDER = ['integrity', 'invariants', 'daemon', 'runtime', 'llm', 'egress_secrets', 'backup', 'db', 'calendar', 'sqlite', 'recheck'];

/** 一项检查 → 一行 HTML（文字按界面语言写；服务端只给事实）。h：整份清单（有的建议要看别的项，例如守护进程在不在） */
function healthRow(c, h) {
  const daemonUp = h.checks.find((x) => x.key === 'daemon')?.alive !== false;
  if (c.key === 'daemon') {
    if (c.alive && c.paused) return hrow(c, T('自动运行（守护进程）'), T('在跑，但管理员暂停了全部自动运行：不开始新的步骤，任务不推进。'), T('要恢复：点页面顶栏的「恢复自动运行」。'));
    if (c.alive) return hrow(c, T('自动运行（守护进程）'), T('在跑（{mode}）{beat}', { mode: c.inProcess ? T('随看板启动') : T('独立进程'), beat: c.lastBeatAt && !c.inProcess ? T('，最近一次心跳 {t}', { t: hWhen(c.lastBeatAt) }) : '' }));
    return hrow(c, T('自动运行（守护进程）'),
      (c.unfinished ? T('没在跑：{n} 个未结束的任务不会自动推进（在收件箱和侧栏里能看到是哪些），超时与通知也不处理。', { n: esc(c.unfinished) }) : T('没在跑：现在没有未结束的任务，暂时不影响干活。'))
        + T('定期备份和完整性检查也是它做的 —— 它不在，这两样都不做。'),
      T('不用停看板：照页面顶部的说明另起 <span class="mono">node src/cli.mjs daemon</span>。这样是在前台跑，关掉终端 / 断开 SSH 就停 —— 长期跑请按部署文档装成计划任务或 systemd 服务。下次重启看板时也可以在 <span class="mono">node src/cli.mjs web …</span> 后面加 <span class="mono">--daemon</span>，让它随看板一起起。它起来的第一拍就会补做到点的备份和检查。'));
  }
  if (c.key === 'runtime') {
    if (c.level === 'unknown') return hrow(c, T('沙箱（容器运行时）'), T('还没探测完，稍后再看'));
    if (c.ok) return hrow(c, T('沙箱（容器运行时）'), T('可用：{cli} {version}', { cli: esc(c.cli ?? ''), version: esc(c.version ?? '') }));
    return hrow(c, T('沙箱（容器运行时）'), T('用不了{since}：要改代码、跑测试的步骤先停着（不算失败）。', { since: c.downSince ? T('（发现于 {t}）', { t: hWhen(c.downSince) }) : '' }) + `<div class="small mute mono">${esc(c.why)}</div>`,
      daemonUp ? T('在服务器上把 {cli} 启动起来；起来之后几分钟内系统会自己接着跑。', { cli: esc(c.cli ?? 'Docker') })
        : T('在服务器上把 {cli} 启动起来；「自动运行」也要起起来，否则 {cli} 好了任务也不会动。', { cli: esc(c.cli ?? 'Docker') }));
  }
  if (c.key === 'db') {
    const todo = c.level !== 'warn' ? '' : !c.daemonAlive
      ? T('WAL 超过 {limit} 的两倍：收缩它的例行维护是守护进程做的，它没在跑（见「自动运行」一项）。不会丢数据，只是占盘、变慢。', { limit: fmtBytes(c.walLimit) })
      : T('WAL 超过 {limit} 的两倍还没收缩：例行维护在超过 {limit} 时会收缩它，降不下来多半是有别的程序长时间开着这个库在读（例如开着的 sqlite3 命令行）。关掉它就好；不会丢数据，只是占盘、变慢。', { limit: fmtBytes(c.walLimit) });
    return hrow(c, T('状态库'),
      T('库文件 {size}，WAL {wal}；库结构 v{schema}', { size: fmtBytes(c.bytes), wal: fmtBytes(c.walBytes), schema: esc(c.schema) }) + (c.diskFree != null ? T('；所在的盘还剩 {free}', { free: fmtBytes(c.diskFree) }) : '') + hPath(c.file),
      todo);
  }
  if (c.key === 'backup') {
    if (c.level === 'unknown') return hrow(c, T('备份'), T('内存库，没有备份'));
    const every = c.everyHours ? T('每 {h} 小时一份，保留最近 {d} 份每日的和 {w} 份每周的，旧的自动删（守护进程做）', { h: esc(c.everyHours), d: esc(c.retention?.daily ?? 7), w: esc(c.retention?.weekly ?? 4) }) : T('定期备份关着');
    const last = c.last ? T('最近一次：{t}（{tag}，{size}）', { t: hWhen(c.last.at), tag: backupTag(c.last.tag), size: fmtBytes(c.last.bytes) }) : T('还没有做过备份');
    const files = c.count ? T('备份目录里共 {n} 份，{size}', { n: esc(c.count), size: fmtBytes(c.totalBytes) }) : T('备份目录里还没有文件');
    const disk = c.diskFree != null ? T('；所在的盘还剩 {free}', { free: fmtBytes(c.diskFree) }) : '';
    const todo = c.lastFailure ? T('最近一次备份失败（{t}）：{why}。最常见的原因是盘满（备份目录所在的盘，剩余见上；或系统临时目录所在的盘）；盘不满就看 {log}。', { t: hWhen(c.lastFailure.at), why: esc(c.lastFailure.why || T('原因没记下来')), log: HC_LOG(h) })
      : !c.everyHours ? (c.count ? T('库坏了时只能用备份目录里现有的 {n} 份（升级前自动做的、手动做的）。', { n: esc(c.count) }) : T('现在一份备份都没有：库坏了无从恢复。'))
        + T('在下面把间隔改成大于 0；要马上做一份：<span class="mono">node src/cli.mjs db backup</span>。')
      : c.level === 'warn' ? (c.daemonAlive ? (c.last ? T('最近一次定期备份已经超过设定间隔的两倍，见 {log}。', { log: HC_LOG(h) }) : T('还没有定期备份：守护进程到点会做；一直没有见 {log}。', { log: HC_LOG(h) }))
        : T('超过设定间隔还没有新的定期备份：守护进程没在跑（见「自动运行」一项）。要马上做一份：<span class="mono">node src/cli.mjs db backup</span>。'))
      : '';
    return hrow(c, T('备份'), `${every}。${last}。${files}${disk}${hPath(c.dir)}`, todo);
  }
  if (c.key === 'integrity') {
    if (c.level === 'unknown') return hrow(c, T('完整性检查'), T('内存库，不检查'));
    const one = (r, name) => (r ? T('{name} {t}{res}', { name, t: hWhen(r.at), res: r.ok ? T('，通过') : T('，<b>没通过</b>') }) : T('{name}：还没做过', { name }));
    const failed = [c.quick, c.full].find((r) => r && !r.ok);
    const detail = failed ? [...(failed.problems ?? []), failed.fk ? T('外键问题 {n} 处', { n: failed.fk }) : ''].filter(Boolean).join('\n') : '';
    const todo = failed ? T('<b>库可能已经损坏。</b>① 先确认：跑 <span class="mono">node src/cli.mjs db check --full</span>（看板开着也能跑），也报问题再往下。② 停掉看板和守护进程（前台跑的按 Ctrl-C，装成服务的用服务管理器停）。③ 跑 <span class="mono">node src/cli.mjs db backups</span> 列出备份（时刻按部署时区写）；每份做完都核过完整性，坏库做不出备份，选最近的一份就行。④ 跑 <span class="mono">node src/cli.mjs db restore &lt;文件&gt;</span>：它先把现在这个库另存到备份目录（文件名带 pre-restore），再换上备份。⑤ 重新起看板和守护进程。那份备份之后的改动会丢。详见部署文档「备份与恢复」一节。')
      : c.level === 'warn' ? (!c.daemonAlive ? T('最近没做检查：守护进程没在跑（见「自动运行」一项）。也可以手动跑 <span class="mono">node src/cli.mjs db check --full</span>（看板开着也能跑；库越大越久，期间不影响使用）。')
        : !c.quick && !c.full ? T('还没做过检查：守护进程第一次运行时就会做；一直没有见 {log}。', { log: HC_LOG(h) }) : T('超过一天没做检查，见 {log}。', { log: HC_LOG(h) }))
      : '';
    return hrow(c, T('完整性检查'), `${one(c.quick, T('快速检查（每小时）'))}；${one(c.full, T('完整检查（每天）'))}${detail ? `<details class="small"><summary class="mute">${T('原始报错')}</summary><pre style="white-space:pre-wrap">${esc(detail)}</pre></details>` : ''}`, todo);
  }
  if (c.key === 'llm') {
    if (!c.rows.length) return hrow(c, T('模型服务商'), T('最近 5 分钟没有出错。'));
    const tierName = (u) => (u.as === 'fallback' ? T('{tier} 档的备用', { tier: esc(u.tier) }) : u.fallback ? T('{tier} 档（备用 {fb}）', { tier: esc(u.tier), fb: esc(u.fallback) }) : T('{tier} 档（没配备用）', { tier: esc(u.tier) }));
    const one = (r) => {
      const now = r.state === 'open' ? T('连着出错，系统暂时不调用它；约 {m} 分钟后，第一个要用它的步骤会先试一次，成了就恢复', { m: esc(Math.max(1, Math.ceil((r.reopenAt - Date.now()) / 60_000))) })
        : r.state === 'half_open' ? T('连着出错，系统暂时不调用它；下一个要用它的步骤会先试一次，成了就恢复')
        : r.backoffUntil ? T('被限流，所有进程一起等到 {t}', { t: esc(fmtWhen(r.backoffUntil)) })
        : r.fallbackSince ? T('{t}前换用过备用，主模型现在能用', { t: esc(ago(r.fallbackSince)) })
        : T('最近 5 分钟 {f}/{n} 次出错，还在照常调用', { f: esc(r.recentFails), n: esc(r.recentTotal) });
      const used = r.tiers.length ? T('用在：{list}', { list: r.tiers.map(tierName).join(T('、')) }) : T('现在没有哪一档用它');
      const err = r.lastStatus || r.lastError ? `<div class="small mute mono" style="word-break:break-all">${esc(`${r.lastStatus ? `HTTP ${r.lastStatus} ` : ''}${r.lastError ?? ''}`)}</div>` : '';
      return `<div style="margin-top:4px"><span class="mono">${esc(r.key)}</span>：${now}。${used}${err}</div>`;
    };
    const down = c.rows.some((r) => r.state === 'open' || r.state === 'half_open');
    // 只算服务商那边的错（过载、宕机、限流、网络）—— 说一句，免得人去查 key
    const theirs = down ? `<div class="small mute" style="margin-top:4px">${T('这是服务商那边的问题（过载、宕机、网络），不是你的 key 或配置。')}</div>` : '';
    return hrow(c, T('模型服务商'), c.rows.map(one).join('') + theirs,
      c.level === 'bad' ? T('没配备用的那一档，要用它的步骤会停下等它恢复（不算失败、不耗重试，恢复后自动接着做）。不想等：到「设置 → 模型分配」给那一档配一个别家的备用模型，保存后停着的步骤马上换用它接着做。')
        : down ? T('有备用的档已经自动换过去了，不用做什么；这家恢复后自动换回。') : '');
  }
  if (c.key === 'invariants') return invariantsRow(c);
  if (c.key === 'recheck') return recheckRow(c);
  if (c.key === 'egress_secrets') {
    // 按源分组：网址里带用户名密码的（stripped）用 --basic；名字像令牌的给整个请求头的值
    const bySrc = [...new Set(c.rows.map((r) => r.sourceId))].map((id) => ({ id, name: c.rows.find((r) => r.sourceId === id).name, basic: c.rows.some((r) => r.sourceId === id && r.stripped) }));
    const step = (s) => `<div style="margin-top:4px"><b>${esc(T(s.name))}</b>${T('：把{what}写进一个文件（配好后可以删），在服务器上跑：', { what: s.basic ? T('「用户名:密码」') : T('整个请求头的值（Bearer、一个空格、再接令牌）') })}<div class="mono">node src/cli.mjs sources cred add ${esc(s.id)}${s.basic ? ' --basic' : ''} --key-file &lt;${esc(T('文件'))}&gt;</div></div>`;
    return hrow(c, T('联网目录里的凭据'), T('这些工具配置里存着凭据，凭据部分已经不再放进沙箱：{list}。要认证的安装（例如私有源上的包）会失败。以前放行过这个源的项目，任务里的代码读得到这些凭据：建议先在那个源上换一个新的，再按下面配。', { list: c.rows.map((r) => T('{name} 的 {key}', { name: esc(T(r.name)), key: `<span class="mono">${esc(r.key)}</span>` })).join(T('、')) }),
      `${T('修法：把凭据配到源上，由出口代理在请求里替工具带上，沙箱里看不到。')}${bySrc.map(step).join('')}<div style="margin-top:4px">${T('配好之后：工具配置网址里存着的旧用户名密码会自动删掉；放行这个源的项目，它放行的所有源都变成只读（POST、PUT 这类请求拦下，GET 和 git clone 照常；交付时的推送在服务器上做，不受影响）。')}</div>`);
  }
  if (c.key === 'sqlite') {
    return hrow(c, T('Node.js 内置的 SQLite'), T('这台看板用的 Node {node} 内置 SQLite {version}，有一个已知缺陷：几个进程同时写库时，有极小的概率把库写坏。看板、守护进程、在跑的任务都会写这个库，所以每个部署都在范围内；但概率很低，不必因此停掉或推迟守护进程，定期备份开着就好。', { node: esc(c.node), version: esc(c.version) }),
      T('换成内置 SQLite {fixed} 或更高版本的 Node（例如 24.15.0 起的 24.x）。数据不用迁移，换完重启看板与守护进程即可；命令行用的 node 也换成同一个。', { fixed: esc(c.fixedIn) }));
  }
  if (c.key === 'calendar') {
    const hol = c.holidays ? T('节假日表排到 {last}（表里共 {off} 天放假、{on} 天补班）。', { last: esc(c.holidaysUntil ?? '—'), off: esc(c.holidayDays), on: esc(c.workdays) }) : T('没有节假日表（「1bd」只跳过周末）。');
    const off = (m) => { const a = Math.abs(m); return `UTC${m >= 0 ? '+' : '−'}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, '0')}` : ''}`; };
    const body = (c.set ? T('部署时区 {tz}（那里此刻 {now}）。', { tz: esc(c.tz), now: esc(c.now) })
      : T('部署时区没设，按 UTC 算（此刻 {now}）；服务器本机是 {sys}（{offset}）。', { now: esc(c.now), sys: esc(c.systemTz), offset: off(c.systemOffsetMin) })) + hol;
    const todo = !c.set && c.systemOffsetMin ? T('超时时间「1bd」什么时候到、值班几点交接、月度预算哪天翻篇，现在都按 UTC 算，和本地差了这个时差。到「设置 → 时间与日历」把部署时区设成你们团队所在的时区（多半就是 {sys}）。', { sys: esc(c.systemTz) })
      : c.stale ? T('节假日表的最后一天已经过去了：之后的节假日都会当工作日算。到「设置 → 时间与日历」补上新的一年。')
      : c.ending ? T('节假日表只排到 {last}，还剩 {n} 天：那以后的放假日会当工作日算。安排出来后到「设置 → 时间与日历」补上。', { last: esc(c.holidaysUntil), n: esc(c.daysLeft) }) : '';
    return hrow(c, T('时区与节假日'), body, todo);
  }
  return hrow(c, esc(c.key), '');
}

// ── 运行期自检：服务端给每条不变量的事实，这里按界面语言写 ──
const INV_NAME = () => ({ liveness: T('每个没结束的任务都说得出在等谁'), projection: T('状态与审计轨对得上、库层护栏都在'),
  executor_paths: T('任务里的 AI 碰不到系统自己的数据'), budget: T('花费没有超过上限'), leases: T('标着「正在处理」的任务和项目，都真有进程在处理') });
// 不成立时的标题：直接说出了什么事（规矩本身是肯定句，后面接"不成立"会读反）
const INV_PROBLEM = () => ({ liveness: T('有任务说不出在等谁'), projection: T('状态与审计轨对不上，或库层护栏少了'),
  executor_paths: T('有任务里的 AI 碰得到系统自己的数据'), budget: T('有花费超过了上限、却没被拦下'), leases: T('有任务或项目标着「正在处理」，占着它的进程已经不在了') });
// 每条查的是什么（"查了 20 个"要说 20 个什么）
// 没得可查时说清现在没有什么（"没有可查的"读不出是没事还是不知道）
const INV_EMPTY = () => ({ liveness: T('现在没有没结束的任务'), projection: T('库里还没有东西'), executor_paths: T('现在没有在用的工作区，有了再查'),
  budget: T('还没有花过钱的任务'), leases: T('现在没有「正在处理」标记') });
const INV_UNIT = () => ({ liveness: T('个没结束的任务'), projection: T('处（任务、步骤、事项等的状态，和库里的护栏）'), executor_paths: T('个工作区'), budget: T('个花过钱的任务'), leases: T('个「正在处理」标记') });
// 任务用标题链过去（侧栏里有的），没有就写 id
const invTask = (id) => { const t = (tasksCache ?? []).find((x) => x.id === id); return `<a href="#${esc(id)}">${esc(t?.title ?? id)}</a>`; };
const usdS = (m) => `$${esc(((m ?? 0) / 1e6).toFixed(2))}`;
function invLine(id, v) {
  switch (id) {
    case 'liveness': return v.state === 'reported' ? T('{task}：已挂事项给负责人，还没处理', { task: invTask(v.ref) }) : T('{task}：{min} 分钟没动静，说不出在等谁（守护进程马上会挂事项给负责人）', { task: invTask(v.ref), min: esc(v.idleMin) });
    case 'projection': return v.kind === 'missing_trigger' ? T('库层护栏 <span class="mono">{name}</span> 不见了', { name: esc(v.ref) })
      : v.kind === 'done_without_handoff' ? T('步骤 <span class="mono">{id}</span> 是完成状态，却没有交接记录', { id: esc(v.ref) })
      : T('<span class="mono">{id}</span>：状态是 {status}，审计轨最后记的是 {audited}', { id: esc(v.ref), status: esc(v.status), audited: esc(v.audited) });
    case 'executor_paths': return T('{task} 的工作区 <span class="mono">{dir}</span> 罩住了 {what}', { task: invTask(v.ref), dir: esc(v.dir), what: esc((v.exposes ?? []).map((w) => ({ home: T('数据目录'), db: T('状态库'), master_key: T('主密钥') })[w] ?? w).join(T('、'))) });
    case 'budget': return v.scope === 'task' ? T('{task} 花了 {spent}，任务上限 {limit}。现在：{now}', { task: invTask(v.ref), spent: usdS(v.spent), limit: usdS(v.limit), now: v.live ? `<b>${T('它的运行进程（pid {pid}）还在跑，还在花钱', { pid: esc(v.pid ?? '?') })}</b> → <a href="#${esc(v.ref)}"><b>${T('到任务页点「暂停」')}</b></a>` : esc(ST_NAME[v.status] ?? v.status ?? '?') + T('（没在跑）') })
      : v.scope === 'person' ? T('{who} 本月花了 {spent}，个人预算 {limit}，没被拦下', { who: esc(v.name ?? v.ref), spent: usdS(v.spent), limit: usdS(v.limit) })
      : T('整个部署本月花了 {spent}，预算 {limit}，没被拦下', { spent: usdS(v.spent), limit: usdS(v.limit) });
    case 'leases': { const m = /^(task|project):(.+)$/.exec(v.ref ?? ''); const what = m?.[1] === 'task' ? T('任务 {t}', { t: invTask(m[2]) }) : m?.[1] === 'project' ? T('项目 {t}', { t: `<a href="#p/${esc(m[2])}">${esc(v.title ?? m[2])}</a>` }) : `<span class="mono">${esc(v.ref)}</span>`;
      return v.kind === 'dead_holder' ? T('{what}：占着它的进程（pid {pid}）已经不在了，标记会在 {t} 自动失效', { what, pid: esc(v.pid), t: esc(fmtWhen(v.expiresAt)) }) : T('{what}：任务已经结束，进程（pid {pid}）还占着、也不再续', { what, pid: esc(v.pid) }); }
    default: return esc(JSON.stringify(v));
  }
}
// 不成立时要做什么（每条一句；不是你的操作造成的，就直说）。系统缺陷给出报的入口
const invReport = (url) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${T('SuperIntern 的问题跟踪')}</a>` : T('SuperIntern 的问题跟踪'));
const INV_TODO = (url) => ({
  liveness: T('已经挂成事项给负责人：到收件箱处理。'),
  projection: T('这是系统的缺陷，不是你的操作造成的：在 {issues} 里报一条，附上在服务器上跑 <span class="mono">node src/cli.mjs invariants</span> 的输出（环境变量照本页顶部说的设）。数据本身没坏，可以继续用；护栏少了的，以后的错误写入就拦不住了，尽快报。', { issues: invReport(url) }),
  executor_paths: T('这几个任务里的 AI 读得到系统的库和密钥：先在任务页把它们暂停，再中止、换个位置重建工作区（工作区不要放在数据目录的上级）。'),
  budget: T('这是系统的缺陷（上限本该拦住它）：在 {issues} 里报一条，附上在服务器上跑 <span class="mono">node src/cli.mjs invariants</span> 的输出（环境变量照本页顶部说的设）。已经花掉的不能撤回。', { issues: invReport(url) }),
  leases: T('标记失效前，系统不会去碰它（以为有人在处理）；到点自己失效，不用做什么。过了失效时间它还在这里，再报问题。'),
});
function invariantsRow(c) {
  const N = INV_NAME(), TODO = INV_TODO(c.issues);
  if (c.level === 'unknown') return hrow(c, T('运行期自检'), T('还没查过：守护进程起来后按各条的周期自动查。'));
  const bad = c.rows.filter((r) => r.violations).sort((a, b) => (b.level === 'bad') - (a.level === 'bad')), rest = c.rows.filter((r) => !r.violations);
  const last = Math.max(...c.rows.map((r) => r.checkedAt ?? 0));
  const P = INV_PROBLEM(), U = INV_UNIT();
  const pill = (lv) => { const p = HEALTH_PILL()[lv] ?? HEALTH_PILL().unknown; return `<span class="pill ${esc(p[0])}">${esc(p[1])}</span> `; };
  const one = (r) => `<div style="margin-top:6px">${pill(r.level)}<b>${esc(P[r.id] ?? r.id)}</b>${T('（{n} 处，{t}发现）', { n: esc(r.violations), t: hWhen(r.since) })}
      <ul class="small" style="margin:4px 0 0 18px;padding:0">${r.sample.slice(0, 5).map((v) => `<li>${invLine(r.id, v)}</li>`).join('')}${r.violations > 5 ? `<li class="mute">${T('还有 {n} 处', { n: esc(r.violations - 5) })}</li>` : ''}</ul>
      <div class="small" style="margin-top:2px;color:var(${r.level === 'bad' ? '--bad' : '--wait'})">${TODO[r.id] ?? ''}</div></div>`;
  // 都成立的收起来：点开能看到查的是哪几条、各查了多少（0 个对象不算"成立"，照实写"没有可查的"）
  const okList = rest.map((r) => `<li>${r.error ? '?' : r.checkedAt == null || !r.checked ? '·' : '✓'} ${esc(N[r.id] ?? r.id)}<span class="mute">${r.error ? T('：没查成（{err}）', { err: esc(r.error) }) : r.skipped ? T('：这次跳过（全部自动运行暂停着）') : r.checkedAt == null ? T('：还没查过') : !r.checked ? T('：没得可查（{why}）', { why: esc(INV_EMPTY()[r.id] ?? '') }) : T('：查了 {n} {unit}', { n: esc(r.checked), unit: esc(U[r.id] ?? '') })}${r.baselined ? T('；另有 {n} 处是启用检查之前就有的，不计', { n: esc(r.baselined) }) : ''}</span></li>`).join('');
  const head = bad.length ? '' : T('{n} 条都成立（最近一次 {t}）。', { n: esc(rest.length), t: hWhen(last) });
  const intro = `<div class="small mute">${T('系统定期核对几条任何时候都该成立的规矩；被打破的列在这里。')}</div>`;
  return hrow(c, T('运行期自检'), `${intro}${head}${bad.map(one).join('')}
    ${rest.length ? `<details class="small" style="margin-top:6px"><summary class="mute">${bad.length ? T('另外 {n} 条没查出问题', { n: esc(rest.length) }) : T('查的是哪几条')}</summary><ul style="margin:4px 0 0 18px;padding:0;list-style:none">${okList}</ul></details>` : ''}`);
}

// ── 情况变了、值得看一眼：每条说清看到了什么、可以怎么做；点「知道了」收起，情况消失再出现会重新提醒 ──
const recheckUse = (u) => { const m = /^role:(.+)$/.exec(u), f = /^(.+):fallback$/.exec(u);
  return m ? T('「{role}」单独用的', { role: esc((typeof ROLE_NAME === 'function' ? ROLE_NAME()[m[1]] : null) ?? m[1]) }) : f ? T('{tier} 档的备用', { tier: esc(f[1]) }) : T('{tier} 档', { tier: esc(u) }); };
const kTok = (n) => esc(`${+((n ?? 0) / 1000).toFixed(1)}k`);
function recheckText(r) {
  const s = r.sample ?? [];
  switch (r.id) {
    case 'recheck_small_window': {
      const uses = (v) => v.uses.map(recheckUse).join(T('、'));
      return { title: T('有模型的上下文窗口偏小'), body: s.map((v) => T('<span class="mono">{m}</span>（{uses}）的上下文窗口只有 {w}：自动整理线已经按它压到 {at}，做到一半就整理的步骤会多起来。', { m: esc(v.ref), uses: uses(v), w: kTok(v.window), at: kTok(v.compactAt) })),
        todo: T('步骤卡上常见「整理过 N 次」时，到<a href="#settings/bind">模型分配</a>给这几档换窗口更大的模型。') };
    }
    case 'recheck_compaction': return { title: T('有步骤反复撞自动整理线'), body: s.map((v) => T('{task} 的「{step}」：近 30 天整理了 {n} 次{esc}', { task: invTask(v.taskId), step: esc(v.title ?? v.ref), n: esc(v.n), esc: v.escalated ? T('，转给人问过') : '' })),
      todo: s.some((v) => v.escalated) ? T('多半是规划把步骤切得太大：转过人的那一步，在收件箱里答那条事项时选拆；常见的话，再考虑换窗口更大的模型。')
        : T('多半是规划把步骤切得太大：要拆，在那个任务页的消息框里发一条修正，说清把哪一步拆成哪两步；常见的话，再考虑换窗口更大的模型。') };
    case 'recheck_contention': { const v = s[0] ?? {}; return { title: T('库有写入竞争'), body: [T('库忙（写不进去、要等）累计 {n} 次，最长一次等写锁 {sec} 秒。', { n: esc(v.busy), sec: esc(((v.maxWaitMs ?? 0) / 1000).toFixed(1)) })],
      todo: T('同时开着的任务多时常见：先调低项目的「同时最多开几个任务」。在服务器上跑 <span class="mono">node src/cli.mjs db stats</span> 能看到是哪些语句在等。') }; }
    case 'recheck_db_size': { const v = s[0] ?? {}; return { title: T('状态库变大了'), body: [T('库文件 {size}，审计约 {rows} 行：备份和完整检查会越来越慢。', { size: fmtBytes(v.bytes), rows: esc(Number(v.auditRows ?? 0).toLocaleString()) })],
      todo: T('留意「状态库」「备份」两项里盘还剩多少。') }; }
    case 'recheck_weakened_tests': { const v = s[0] ?? {}; return { title: T('原有测试被改弱的次数多起来了'), body: [T('没经人允许就改弱原有测试（删掉、跳过、断言变少、改期望值）已经出现 {n} 次，涉及 {t} 个任务。现在系统只把它标出来，给验收员和签收的人看。', { n: esc(v.n), t: esc(v.tasks) })],
      todo: T('想让系统在交接时直接打回，在服务器上跑：<span class="mono">node src/cli.mjs user setting deploy.test_guard reject</span>') }; }
    default: return { title: esc(r.id), body: [], todo: '' };
  }
}
function recheckRow(c) {
  const open = c.rows.filter((r) => !r.acked), acked = c.rows.filter((r) => r.acked);
  const one = (r, ack) => { const x = recheckText(r);
    return `<div style="margin-top:6px"><b>${x.title}</b> <span class="small mute">${T('（{t}发现）', { t: hWhen(r.since) })}</span>
      <ul class="small" style="margin:4px 0 0 18px;padding:0">${x.body.map((b) => `<li>${b}</li>`).join('')}</ul>
      <div class="small" style="margin-top:2px${ack ? '' : ';color:var(--wait)'}">${x.todo}</div>
      ${ack ? '' : `<button class="small" data-rack="${esc(r.id)}" style="margin-top:4px">${T('知道了')}</button>`}</div>`; };
  const intro = `<div class="small mute">${T('不是故障：是情况变了，有几处设置或做法值得重新看一眼。点「知道了」收起：情况一直在就不再提醒，消失后再出现会重新提醒。')}</div>`;
  return hrow(c, T('值得看一眼的变化'), `${intro}${open.map((r) => one(r, false)).join('')}
    ${acked.length ? `<details class="small" style="margin-top:6px"><summary class="mute">${T('已经知道的 {n} 条', { n: esc(acked.length) })}</summary>${acked.map((r) => one(r, true)).join('')}</details>` : ''}`);
}

/** 一句话总结：几项有问题、几项要注意，先做哪个 */
function healthSummary(h) {
  const n = (lv) => h.checks.filter((c) => c.level === lv).length;
  const bad = n('bad'), warn = n('warn');
  if (!bad && !warn) return T('一切正常。');
  const integ = h.checks.find((c) => c.key === 'integrity' && c.level === 'bad');
  const daemon = h.checks.find((c) => c.key === 'daemon' && !c.alive);
  // 模型服务商有问题 = 停着的服务商正被某几档主用、又没配备用：说出是哪几档；配备用是看板上一分钟的事，排在起守护进程之前
  const llmBad = h.checks.find((c) => c.key === 'llm' && c.level === 'bad');
  const stuck = llmBad ? [...new Set(llmBad.rows.filter((r) => r.state === 'open' || r.state === 'half_open').flatMap((r) => r.tiers.filter((u) => u.as === 'primary' && !u.fallback).map((u) => u.tier)))] : [];
  const fb = stuck.length ? T('先到「设置 → 模型分配」给 {tiers} 档配一个别家的备用模型（见「模型服务商」一项）。', { tiers: esc(stuck.join(T('、'))) }) : '';
  // 运行期自检里「有问题」级的（AI 碰得到系统数据、花费没被拦下）比守护进程更急：它们在出事
  const invBad = h.checks.find((c) => c.key === 'invariants' && c.level === 'bad');
  const first = integ ? T('先处理「完整性检查」：库可能已经损坏。')
    : invBad ? T('先处理「运行期自检」：{name}。', { name: esc(invBad.rows.filter((r) => r.violations && r.level === 'bad').map((r) => INV_PROBLEM()[r.id] ?? r.id).join(T('；'))) })
    : daemon ? fb + (fb ? T('然后把「自动运行」起起来：任务推进、备份、检查都靠它（标「注意」的几项多半都是因为它没在跑）。') : T('先把「自动运行」起起来：备份、检查、任务推进都靠它。'))
    : fb;
  const count = !warn ? T('{n} 项有问题。', { n: esc(bad) }) : !bad ? T('{n} 项要注意。', { n: esc(warn) }) : T('{bad} 项有问题，{warn} 项要注意。', { bad: esc(bad), warn: esc(warn) });
  return count + first;
}

async function renderHealthCard() {
  const box = $('#healthCard');
  let h;
  try { h = await api('/api/health'); } catch (e) { box.innerHTML = `<div class="small bad">${esc(e.message)}</div>`; return; }
  const ann = announcementNow?.text ?? '';
  // 有问题的排前面（最严重的一项原来排在最后）；同级先放根因
  const ordered = h.checks.map((c, i) => [c, i]).sort((a, b) => (HEALTH_RANK[a[0].level] ?? 2) - (HEALTH_RANK[b[0].level] ?? 2) || (HEALTH_ORDER.indexOf(a[0].key) >>> 0) - (HEALTH_ORDER.indexOf(b[0].key) >>> 0) || a[1] - b[1]).map((x) => x[0]);
  const every = h.checks.find((c) => c.key === 'backup')?.everyHours ?? 24;
  box.innerHTML = `<div class="small mute">${T('这台看板：SuperIntern {version}（构建 {build}）· Node {node} · SQLite {sqlite} · 库结构 v{schema}。检查于 {t}（按你的时区 {tz}）。', { version: esc(h.version), build: esc(h.build ?? '?'), node: esc(h.node), sqlite: esc(h.sqlite), schema: esc(h.schema), t: esc(fmtWhen(h.at)), tz: esc(me?.tz ?? '—') })}
      <button id="hcReload" class="small">${T('重新检查')}</button></div>
    ${h.home ? `<div class="small mute" style="margin-top:4px">${h.dbInHome || !h.dbFile ? T('下面提到的命令都在服务器上 SuperIntern 的目录里跑，并且要让环境变量 <span class="mono">SUPERINTERN_HOME</span> 指向这台看板的数据目录 <span class="mono">{home}</span> —— 指错了，命令行会在别处另开一个空库。', { home: esc(h.home) })
      : T('下面提到的命令都在服务器上 SuperIntern 的目录里跑。这台看板的库不在数据目录里（启动时用了 --db），所以每条命令都要带 <span class="mono">--db {db}</span>，并让环境变量 <span class="mono">SUPERINTERN_HOME</span> 指向 <span class="mono">{home}</span>（守护进程的心跳、日志在那里）—— 少了哪个，命令行都会对着另一个库。', { db: esc(h.dbFile), home: esc(h.home) })}</div>` : ''}
    <div style="margin-top:8px"><b>${healthSummary(h)}</b></div>
    ${ordered.map((c) => healthRow(c, h)).join('')}
    <h3 id="hcEveryH" style="margin-top:16px">${T('定期备份间隔')}</h3>
    <div class="row small"><input id="hcEvery" aria-labelledby="hcEveryH" type="number" min="0" max="168" style="width:80px" value="${esc(every)}"> ${T('小时（0 = 不做定期备份）')} <button id="hcEverySave" class="small">${T('保存')}</button></div>
    <div class="small mute">${T('守护进程的下一拍（默认每 15 秒一拍）就按新的间隔判断；它没在跑时不做。')}</div>
    <h3 id="hcAnnH" style="margin-top:16px">${T('公告')}</h3>
    <div class="small mute">${T('所有人打开看板时，顶部显示一条横幅（不另发通知，只用命令行的人看不到）。按原文显示，链接不能点。不会自动过期，用完记得撤下。每个人可以收起；你改了内容会再出来。最多 500 字。')}</div>
    <textarea id="hcAnn" aria-labelledby="hcAnnH" rows="3" maxlength="500" style="width:100%;margin-top:6px" placeholder="${T('例：今晚 22:00–22:30 升级看板，期间可能连不上')}">${esc(ann)}</textarea>
    <div class="row small" style="margin-top:6px"><button id="hcAnnSave" class="primary small">${T('发布')}</button>${ann ? `<button id="hcAnnClear" class="small">${T('撤下公告')}</button>` : ''}</div>`;
  $('#hcReload').onclick = () => renderHealthCard();
  box.querySelectorAll('[data-rack]').forEach((b) => b.onclick = async () => {
    try { await api('/api/health/recheck', { id: b.dataset.rack }); toast(T('已收起：情况消失后再出现会重新提醒')); await renderHealthCard(); } catch (e) { toast(e.message, true); }
  });
  const setting = async (key, value, done) => {
    try { const r = await api('/api/users', { action: 'setting', key, value }); usersData = usersFrom(r); toast(done); await loadTasks(); await renderHealthCard(); }
    catch (e) { toast(e.message, true); }
  };
  $('#hcEverySave').onclick = () => setting('deploy.backup_every_hours', Number($('#hcEvery').value), T('已保存'));
  $('#hcAnnSave').onclick = () => setting('deploy.announcement', $('#hcAnn').value, $('#hcAnn').value.trim() ? T('公告已发布') : T('公告已撤下'));
  if ($('#hcAnnClear')) $('#hcAnnClear').onclick = () => setting('deploy.announcement', '', T('公告已撤下'));
}

/** 设置页「运行状况」上的小圆点：注意 / 有问题时亮 */
function renderHealthDot(level) {
  const d = $('#healthDot');
  if (!d) return;
  d.textContent = level === 'bad' || level === 'warn' ? '●' : '';
  d.style.color = level === 'bad' ? 'var(--bad)' : '';
  d.title = level === 'bad' ? T('有问题，点开看') : level === 'warn' ? T('有要注意的，点开看') : '';
}

let announcementNow = null;
// 公告横幅：各人收起的是"哪一条"（按发布时刻），管理员改了内容就是新的一条、会再出来
function renderAnnouncement(a) {
  announcementNow = a;
  const bar = $('#announceBar');
  let gone = null; try { gone = localStorage.getItem('si_ann_closed'); } catch { /* 存不了就每次都显示 */ }
  if (!a || (a.at != null && String(a.at) === gone)) { bar.classList.add('hide'); return; }
  setLive(bar, `<div class="row" style="align-items:flex-start"><span><b>${T('管理员公告')}</b>${T('：')}<span style="white-space:pre-wrap">${esc(a.text)}</span>${a.at ? ` <span class="small mute">${T('（{t}前）', { t: ago(a.at) })}</span>` : ''}</span><span class="grow"></span><button id="annClose" class="small" title="${T('收起这条公告（管理员发新的会再出来）')}">${T('收起')}</button></div>`);
  bar.classList.remove('hide');
  $('#annClose').onclick = () => { try { localStorage.setItem('si_ann_closed', String(a.at)); } catch { /* 存不了就只收起这一次 */ } bar.classList.add('hide'); };
}

// 看板升级了、这个页面还是旧的：SSE 的 hello 带服务端的构建号，和页面里的对不上就提示刷新（不自动刷，正在填的东西会丢）
const PAGE_BUILD = document.querySelector('meta[name="si-build"]')?.content ?? null;
function checkBuild(serverBuild) {
  const bar = $('#updateBar');
  if (!serverBuild || !PAGE_BUILD || serverBuild === PAGE_BUILD) { bar.classList.add('hide'); return; }
  setLive(bar, `${T('<b>看板已经升级</b>（{old} → {new}），这个页面还是旧版本：继续用可能报错或点了没反应。正在填写的文字先复制出来（刷新会清空没提交的输入），再刷新。', { old: esc(PAGE_BUILD), new: esc(serverBuild) })} <button id="updReload" class="small primary">${T('刷新页面')}</button>`);
  bar.classList.remove('hide');
  $('#updReload').onclick = () => location.reload();
}
