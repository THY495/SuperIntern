// ── 联网──────────────────────────────────────
// 两层：设置里的「联网目录」由管理员维护（内置 5 个软件源 + 自己加的镜像 / 私有仓库 / 可信的信息源），
// 项目设置里的「联网」由项目负责人从目录里勾选，项目下所有任务共用。替掉了原来那个"可访问软件源 上限 N 类"。
const KIND_NAME = { package: T('软件源'), info: T('信息源') };
// 连接：交付（推分支、开 PR）用的凭据。项目上不挂凭据：每次交付按"远端地址 + 谁点的交付"现场挑一份。
// 明文只进不出：录入之后谁都看不到值（包括录入的人），列表只显示末几位 / 指纹。
const CONN_KIND = { token: T('令牌'), github_app: 'GitHub App', ssh_key: T('SSH 密钥') };
let connKind = 'github_app';
function connCheckText(c) {
  const who = c.credential ? T('会用「{name}」（{owner}）', { name: esc(c.credential.name), owner: c.credential.ownerName ? T('{name} 自己的连接', { name: esc(c.credential.ownerName) }) : T('部署级连接') })
    : c.local ? T('这是本机路径：用服务器上 git 自己的权限，不需要连接') : T('没有匹配的连接：会试服务器上 git 自己配的凭据（一般没有，多半会失败）');
  const can = c.canRead === false ? `<span class="bad">${T('读不了这个远端')}</span>`
    : c.canPush === true ? `<span class="ok">${T('能读、能推送')}</span> <span class="small mute">${T('（只验证了推送；开 PR、改工作流的权限要到交付时才知道）')}</span>`
      : c.canPush === false ? `<span class="bad">${T('能读，但推不了')}</span> <span class="small">${T('交付时会自动跳过它、换下一份；要根治，给它加上写代码的权限（Contents: Read and write），或把它的仓库范围收窄到它在 GitHub 上真有权限的那几个')}</span>` : T('能读');
  const tried = (c.tried ?? []).length ? `<div class="small mute">${T('没用上的：')}${c.tried.map((x) => `${esc(x.name)} —— ${esc(x.why)}`).join(T('；'))}</div>` : '';
  return `<div>${who}</div><div>${T('结果：')}${can}${c.defaultBranch ? ` <span class="small mute">${T('（默认分支 {b}）', { b: esc(c.defaultBranch) })}</span>` : ''}</div>${c.detail ? `<div class="small mute">${esc(c.detail)}</div>` : ''}${tried}`;
}
// 用 GitHub 登录：先列在 GitHub 上要做的准备，再填组织 / App / Client ID 与 secret；试一个账号；对不上成员时怎么办
function ghLoginHtml(s, admin) {
  const g = s.githubLogin; if (!g) return '';
  const miss = { org: T('组织名'), app: T('一份部署级 GitHub App 连接'), client_id: T('App 的 Client ID'), client_secret: T('App 的 Client secret') };
  const status = !g.team ? `<span class="mute">${T('看板现在是本机模式，不用登录；以团队模式启动后才用得上')}</span>`
    : g.enabled ? `<span class="ok">${T('已开启：登录页上有「用 GitHub 登录」，只放行 {org} 的正式成员', { org: esc(g.org) })}</span>${g.unlinked ? (() => { const names = esc(g.unlinkedNames.join(T('、')) + (g.unlinked > g.unlinkedNames.length ? T(' 等 {n} 人', { n: g.unlinked }) : ''));
      return `<div class="bad" style="margin-top:4px">${g.autocreate === 'off' ? T('这些成员还没绑定 GitHub 账号、也没有管理员替他们填，现在用 GitHub 登录会被拒：{names}', { names }) : T('这些成员还没绑定 GitHub 账号、也没有管理员替他们填；现在用 GitHub 登录会被自动建成一个新账号（同一个人变成两份）：{names}', { names })} ${T('（本人用令牌登录后在「成员」里点「用 GitHub 验证并绑定」，或管理员在「成员」里替他填）')}</div>`; })() : ''}`
    : `<span class="mute">${T('没开。还缺：{what}', { what: g.missing.map((m) => esc(miss[m] ?? m)).join(T('、')) })}</span>`;
  // 部署级 App 有几份时可以挑：在哪份上保存 Client ID / secret，登录就改用哪份
  const apps = (s.rows ?? []).filter((c) => c.kind === 'github_app' && !c.ownerId && !c.fromEnv);
  const label = (c) => `${esc(c.name)}（App ID ${esc(c.appId ?? '')} · ${T('连接 id')} ${esc(c.id)}${c.id === g.app.id && g.enabled ? ` · ${T('登录在用')}` : c.hasClientSecret ? ` · ${T('已填 Client secret')}` : ''}）`;
  const appLine = !g.app ? `<span class="mute">${T('还没有：先在下面「加一条连接」里加一份部署级的 GitHub App')}</span>`
    : apps.length > 1 && admin ? `<select id="ghApp" style="width:auto">${apps.map((c) => `<option value="${esc(c.id)}"${c.id === g.app.id ? ' selected' : ''}>${label(c)}</option>`).join('')}</select>`
    : label({ ...g.app, hasClientSecret: g.app.hasSecret });
  const local = g.callbackUrl && /^https?:\/\/(localhost|127\.|\[::1\])/i.test(g.callbackUrl);
  return `<div class="item" style="margin-top:8px"><b>${T('用 GitHub 登录')}</b> <span class="small">${T('成员用自己的 GitHub 账号登录看板，不用贴令牌；只放行指定 GitHub 组织的正式成员。令牌登录照旧可用。')}</span>
    <div class="small" style="margin-top:6px">${status}</div>
    ${admin ? `<div class="small" style="margin-top:8px"><b>${T('先在 GitHub 上做（App 的设置页）')}</b>
      <ol style="margin:4px 0 0 18px;padding:0">
        <li>${T('把 App 安装到这个组织上：App 设置 → Install App → 选这个组织')}</li>
        <li>${T('Permissions & events → Organization permissions → Members 设为 Read-only；再打开 {url}，在这个 App 上接受新权限', { url: `<code>github.com/organizations/${esc(g.org || '<组织>')}/settings/installations</code>` })}</li>
        <li>${T('General → Identifying and authorizing users → Redirect URI（旧版界面叫 Callback URL）填下面的回调地址；这一节其余选项不用动，都不勾')}</li>
        <li>${T('复制 General 页 About 里的 Client ID；再生成一个 Client secret（General 页的 Client secrets，新版界面在左侧 Credentials 里）复制下来。两样都填到下面')}</li>
      </ol></div>
    <div class="form" style="margin-top:8px">
      <label>${T('回调地址')} ${hint(T('按启动看板时的 --public-url 生成。要改就用新的 --public-url 重启看板，再到 GitHub 上改 Redirect URI'))}</label>
      <div class="small">${g.callbackUrl ? `<code>${esc(g.callbackUrl)}</code>${local ? ` <span class="bad">${T('这是本机地址：成员从别的电脑登录时 GitHub 会跳回他自己的电脑、登录失败。用成员能打开的地址作 --public-url 启动')}</span>` : ''}` : `<span class="mute">${T('团队模式启动（带 --public-url）后才有')}</span>`}</div>
      <label for="ghOrg">${T('GitHub 组织')} ${hint(T('组织在 GitHub 上的名字（github.com/ 后面那段）。登录的人必须是这个组织的正式成员，受邀还没接受的不算；每小时复查一次，离开组织的人会被退出登录。清空就关掉 GitHub 登录'))}</label>
      <div class="row"><input id="ghOrg" value="${esc(g.org)}" placeholder="acme" style="flex:1"> <button id="ghOrgSave" class="small">${T('保存')}</button></div>
      <label>${T('用哪个 App')} ${hint(T('就是下面「连接」里的部署级 GitHub App，交付推代码用的那个也行；它必须装在上面这个组织上。有几份时：选一份、填好 Client ID 与 Client secret 保存，登录就改用它；标着「登录在用」的是现在用的那份'))}</label><div class="small">${appLine}</div>
      ${g.app ? `<label for="ghClientId">Client ID ${hint(T('App 设置页 General → About 一栏里的 Client ID（形如 Iv23li…），不是 App ID'))}</label><input id="ghClientId" value="${esc(g.app.clientId ?? '')}" autocomplete="off" placeholder="Iv23li…">
      <label for="ghClientSecret">Client secret ${hint(T('只显示一次，生成后复制过来。加密存储，存后不再显示'))}</label>
      <input id="ghClientSecret" type="password" autocomplete="off" placeholder="${g.app.hasSecret ? T('已填（要换才填）') : ''}">
      <div class="row"><button id="ghOAuthSave" class="small">${T('保存 Client ID 与 Client secret')}</button></div>` : ''}
      <label for="ghAuto">${T('GitHub 账号对不上看板成员时')} <span class="small mute">${T('（选了就生效）')}</span> ${hint(T('先按数字编号找已绑定的人，再按管理员在「成员」里替人填的 GitHub 账号找。都找不到的，按这里处理。自动建的账号名字就是 GitHub 账号，只能用网页；要用命令行由管理员另发令牌。旁观者只能看、可以发消息，不回答问题、不提需求'))}</label>
      <select id="ghAuto" style="width:auto"><option value="off"${g.autocreate === 'off' ? ' selected' : ''}>${T('拒绝登录（成员先绑好 GitHub 账号，或由管理员替他填）')}</option><option value="member"${g.autocreate === 'member' ? ' selected' : ''}>${T('自动建为成员')}</option><option value="observer"${g.autocreate === 'observer' ? ' selected' : ''}>${T('自动建为旁观者')}</option></select>
      <label for="ghTryLogin">${T('试一个账号')} ${hint(T('不用开浏览器验证配置：App 装没装在组织上、有没有 Members 权限、这个 GitHub 账号算不算正式成员。命令行：node src/cli.mjs cred member <账号>'))}</label>
      <div class="row"><input id="ghTryLogin" placeholder="octocat" autocomplete="off" style="flex:1"> <button id="ghTry" class="small">${T('查')}</button></div>
      <div id="ghTryOut" class="small"></div>
    </div>` : ''}</div>`;
}
async function renderConnections() {
  const box = $('#connBox'); if (!box || !me) return;
  let s; try { s = await api('/api/connections'); } catch (e) { box.innerHTML = `<span class="bad small">${esc(e.message)}</span>`; return; }
  const order = s.order === 'app_first' ? T('GitHub App → 点交付的人自己的 → 部署级的令牌 / 密钥 → 服务器 .env 里的 GITHUB_TOKEN') : T('点交付的人自己的 → GitHub App → 部署级的令牌 / 密钥 → 服务器 .env 里的 GITHUB_TOKEN');
  const exp = (c) => c.fromEnv ? '<span class="mute">—</span>' : c.kind === 'github_app' ? `<span class="small mute">${T('私钥不过期；每次推送现签 1 小时的临时令牌')}</span>`
    : c.expired ? `<span class="bad">${T('已过期')}</span>` : c.expiresAt ? `<span class="${c.expiresAt - Date.now() < 7 * 86400_000 ? 'bad' : ''}">${dayOf(c.expiresAt)}</span>` : `<span class="mute">${T('没填')}</span>`;
  const chk = (c) => !c.lastCheck ? '<span class="mute">—</span>'
    : `<span class="${c.lastCheck.canPush === false || c.lastCheck.canRead === false ? 'bad' : 'ok'}" title="${esc(`${esc(c.lastCheck.remote)}${c.lastCheck.detail ? `\n${esc(c.lastCheck.detail)}` : ''}`)}">${c.lastCheck.canPush ? T('能推送') : c.lastCheck.canRead === false ? T('读不了') : c.lastCheck.canPush === false ? T('推不了') : T('能读')}</span> <span class="small mute">${T('{t}前', { t: ago(c.lastCheck.at) })}</span>`;
  const owner = (c) => c.fromEnv ? T('部署级 · 服务器上的 .env 文件') : !c.ownerId ? T('部署级（所有人点的交付都能用）') : c.mine ? T('我自己（只用于我点的交付）') : T('{name} 的（只用于本人点的交付）', { name: esc(c.ownerName ?? '') });
  const rows = s.rows.map((c) => `<tr><td>${esc(c.name)}</td><td class="small">${CONN_KIND[c.kind] ?? esc(c.kind)}${c.appId ? ` <span class="mute">${esc(c.appId)}</span>` : ''}</td><td class="small">${owner(c)}</td>
    <td class="small mono">${esc(c.host)}/${esc(c.pathGlob)}</td><td class="small mono">${esc(c.hint ?? '—')}</td><td class="small">${exp(c)}</td>
    <td class="small">${c.lastUsedAt ? T('{t}前', { t: ago(c.lastUsedAt) }) : '<span class="mute">—</span>'}</td><td class="small">${chk(c)}</td>
    <td class="act">${c.canRevoke ? `<button class="small" data-crrev="${esc(c.id)}" data-crname="${esc(c.name)}">${c.fromEnv ? T('清掉') : T('吊销')}</button>` : ''}</td></tr>`).join('');
  const admin = me.role === 'lead';
  const KIND_HELP = {
    github_app: T('适合仓库集中在一两个 GitHub 组织里的团队：管理员在组织里建一个 App、装到组织上（步骤见部署文档「连接」一节），把 App ID 和下载的 .pem 私钥整段内容贴进来。App 的权限：Contents、Pull requests 设为 Read and write，Metadata 只读；要让 AI 能改 .github/workflows/ 下的文件，再开 Workflows: Read and write。装的时候没勾的仓库用不上它，点上面的「检查」能看出来。之后组织里的每个仓库都不用再配；每次推送现签一个只管这一个仓库、1 小时过期的令牌。推送和 PR 会显示为这个 App（bot）。'),
    token: T('GitHub：建一个 fine-grained 令牌，只授权要交付的仓库，权限给 Contents 与 Pull requests 的读写（要让 AI 能改 .github/workflows/，再加 Workflows 读写）；到期日填上，快到期时待办里会提醒。GitLab / Gitea / 内网服务：同样贴访问令牌，能推送；开合并请求目前只支持 GitHub。用户名一般留空（GitHub 用 x-access-token、其余用 oauth2），托管要求别的才填。'),
    ssh_key: T('不带口令的 SSH 私钥（整段，以 -----BEGIN OPENSSH PRIVATE KEY----- 开头）。建议专门生成一把，在仓库上加为可写的部署密钥。只用于 git@… 或 ssh://… 形式的远端地址，而且只管推送：开 PR 要调 GitHub 接口，还得另有一份 GitHub App 或令牌（系统会自动配上）。'),
  };
  box.innerHTML = `
    <div class="small mute">${T('交付（把分支推到远端、开 PR）时用的凭据。项目上不挂凭据：每次交付按「远端地址 + 谁点的交付」从下面挑一份，审计里记着用的是哪一份。')}</div>
    <div class="small" style="margin-top:6px">${T('挑选顺序：{order}', { order })} ${hint(T('成员自己的连接只用于本人点的交付，别人点的交付不会借用。同一档里有几份都匹配时，适用范围写得越具体越先（acme/web 先于 acme/*），再按新加的先。过期的、推不上去的会自动跳过、换下一份；都用不上时，会试服务器上 git 自己配的凭据（一般没有）'))}
      ${admin ? `<select id="cnOrder" style="width:auto;margin-left:6px" aria-label="${T('挑选顺序')}"><option value="personal_first"${s.order !== 'app_first' ? ' selected' : ''}>${T('本人的优先（PR 署本人）')}</option><option value="app_first"${s.order === 'app_first' ? ' selected' : ''}>${T('GitHub App 优先（PR 一律显示为 bot）')}</option></select>` : ''}</div>
    <div class="item" style="margin-top:8px"><b>${T('提交与 PR 里的溯源')}</b> <span class="small">${T('每个步骤的提交信息末尾带几行出处（任务、步骤、契约第几版由谁批准、落实的条款编号、谁的指令），PR 正文带一张溯源表，不打开看板也看得懂。提交里只有编号和人名；PR 的溯源表里有条款原文和答复摘录，仓库公开的话这些也一起公开。')}</span>
      <div class="form" style="margin-top:8px"><label for="cnBoardUrl">${T('看板地址')} ${hint(T('写进提交与 PR 的链接，点开直达看板上的那一步。填队友浏览器里打开看板用的地址；空着就不写链接。只影响以后的提交，已有提交里的链接不会变'))}</label>
        ${admin ? `<div class="row"><input id="cnBoardUrl" value="${esc(s.provenance?.boardUrl ?? '')}" placeholder="https://superintern.example.com" style="flex:1"> <button id="cnBoardSave" class="small">${T('保存')}</button></div>` : `<span class="small">${esc(s.provenance?.boardUrl || T('（没填）'))}</span>`}
        <label>Co-authored-by ${hint(T('打开后，提交里给批准契约、发指令、发起这个任务的人各加一行 Co-authored-by，GitHub 会在提交上显示他们的头像，提交也会算进他们在 GitHub 上的贡献记录。它在 GitHub 上的意思是“共同作者”，所以默认关。只给绑定了 GitHub 账号、或管理员替他填了提交邮箱的人加；只影响以后的提交'))}</label>
        ${admin ? `<label class="small" style="font-weight:normal"><input type="checkbox" id="cnCoauthor" style="width:auto"${s.provenance?.coauthor ? ' checked' : ''}> ${T('在提交里加 Co-authored-by 行')}</label>` : `<span class="small">${s.provenance?.coauthor ? T('加') : T('不加')}</span>`}</div></div>
    ${ghLoginHtml(s, admin)}
    <div class="item" style="margin-top:8px"><b>${T('推送护栏')}</b> <span class="small">${T('不论用哪份连接，系统只往远端推它自己的分支（superintern/… 是项目分支，v0/… 是单个任务的分支）：不推默认分支、不强推、不删分支；远端分支上有别人推的提交时，交付会停下来、在报错里说明。合并永远由人在 GitHub 上点。')}</span></div>
    ${s.rows.length ? `<table class="rt" style="margin-top:8px"><tr><th>${T('名称')}</th><th>${T('类型')}</th><th>${T('谁的')}</th><th>${T('适用于')} ${hint(T('主机 / 仓库路径。acme/* 表示 acme 组织下的所有仓库，* 表示这个主机上的全部。这是在本系统里填的范围，要和令牌在 GitHub 上实际授权的仓库对上：填宽了，它会被挑去推它没权限的仓库（会自动换下一份，但报错里会多一行）'))}</th><th>${T('标识')} ${hint(T('值本身谁都看不到；这里只显示末 4 位（令牌）、私钥指纹的开头（App、SSH 密钥，和 GitHub 页面上显示的 SHA256 指纹对得上），用来认出是哪一份'))}</th><th>${T('到期')}</th><th>${T('最近使用')}</th><th>${T('最近检查')}</th><th></th></tr>${rows}</table>`
      : `<div class="small bad" style="margin-top:8px">${T('还没有任何连接：交付到 GitHub 时推不上去、也开不了 PR。')}</div>`}
    <h3 id="ccH" style="margin-top:16px">${T('检查一个远端')}</h3>
    <div class="small mute" style="margin-bottom:6px">${T('填一个远端地址，看你点交付时会用哪份连接、能不能推上去。只做一次试探（不会在远端留下任何东西）。')}</div>
    <div class="row"><input id="ccRemote" aria-labelledby="ccH" placeholder="https://github.com/acme/web.git" style="flex:1"><button class="small" id="ccGo">${T('检查')}</button></div>
    <div id="ccOut" class="small" style="margin-top:6px"></div>
    ${me.role === 'observer' ? '' : `<h3 style="margin-top:16px">${T('添加连接')}</h3>
    <div class="row"><select id="cnKind" style="width:auto" aria-label="${T('连接类型')}">${Object.entries(CONN_KIND).map(([k, v]) => `<option value="${esc(k)}"${k === connKind ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
      <select id="cnScope" style="width:auto" aria-label="${T('谁能用')}"><option value="mine">${T('只给我自己用')}</option>${admin ? `<option value="deployment"${connKind === 'github_app' ? ' selected' : ''}>${T('部署级（所有人的交付都能用）')}</option>` : ''}</select>
      <input id="cnName" aria-label="${T('连接的名字')}" placeholder="${T('名字，比如「acme 组织 App」')}" style="width:200px"></div>
    <div class="small mute" style="margin:6px 0">${KIND_HELP[connKind]}</div>
    <div class="row"><label class="small">${T('主机')} <input id="cnHost" value="github.com" style="width:160px"></label>
      <label class="small">${T('仓库范围')} <input id="cnGlob" placeholder="${T('acme/*；留空 = 全部')}" style="width:140px"></label>
      ${connKind === 'github_app' ? `<label class="small">App ID <input id="cnApp" style="width:100px" inputmode="numeric"></label>` : ''}
      ${connKind === 'token' ? `<label class="small">${T('用户名')} <input id="cnUser" placeholder="${T('留空 = 按托管默认')}" style="width:120px"></label><label class="small">${T('到期日')} <input id="cnExp" type="date" style="width:auto"></label>` : ''}</div>
    ${connKind === 'token' ? `<div class="row" style="margin-top:6px"><input id="cnSecret" type="password" autocomplete="off" aria-label="${T('令牌')}" placeholder="${T('粘贴令牌')}" style="flex:1"></div>`
      : `<div style="margin-top:6px"><textarea id="cnSecret" rows="4" autocomplete="off" spellcheck="false" aria-label="${T('私钥内容')}" placeholder="${connKind === 'github_app' ? T('粘贴 .pem 文件的整段内容（-----BEGIN RSA PRIVATE KEY----- …）') : T('粘贴私钥的整段内容')}" style="width:100%;font-family:monospace"></textarea></div>`}
    <div class="row" style="margin-top:6px"><button class="primary small" id="cnSave">${T('保存')}</button><span class="small mute">${T('保存后加密存进状态库，谁都看不到值（包括你自己）。要换：先加一份新的，再吊销旧的。')}</span></div>`}`;
  document.querySelectorAll('button[data-crrev]').forEach((b) => b.onclick = async () => {
    const env = b.dataset.crrev === 'env:GITHUB_TOKEN';
    if (!confirm(env ? T('从服务器的 .env 文件里删掉 GITHUB_TOKEN？立即生效，重启后也不会回来。之后要用它的交付会改用下一份连接，没有就推不上去。GitHub 上的这个令牌本身仍然有效，要作废请到 GitHub 上撤销。')
      : T('吊销「{name}」？本系统从此不再用它，要用它的交付会改用下一份连接，没有就推不上去。GitHub 上的令牌 / App 私钥本身仍然有效，要作废请到 GitHub 上撤销。', { name: b.dataset.crname }))) return;
    try { await api('/api/connections', { action: 'revoke', id: b.dataset.crrev }); toast(T('已吊销')); renderConnections(); } catch (e) { toast(e.message, true); }
  });
  if ($('#ghOrgSave')) $('#ghOrgSave').onclick = async () => { try { await api('/api/users', { action: 'setting', key: 'deploy.github_login_org', value: $('#ghOrg').value }); toast(T('已保存')); renderConnections(); } catch (e) { toast(e.message, true); } };
  if ($('#ghTry')) $('#ghTry').onclick = async () => {
    const out = $('#ghTryOut'); out.textContent = T('查询中…');
    try {
      const r = (await api('/api/connections', { action: 'member_check', login: $('#ghTryLogin').value })).result;
      out.innerHTML = r.member === true ? `<span class="ok">${T('{login} 是 {org} 的正式成员：配置没问题', { login: esc(r.login), org: esc(r.org) })}</span>`
        : r.member === false ? `<span class="bad">${T('{login} 不是 {org} 的正式成员（受邀还没接受也不算）；App 与权限这一头是通的', { login: esc(r.login), org: esc(r.org) })}</span>`
        : `<span class="bad">${T('查不了：{why}', { why: esc(r.error ?? '') })}</span>`;
    } catch (e) { out.innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  };
  onPick($('#ghAuto'), async () => { try { await api('/api/users', { action: 'setting', key: 'deploy.github_login_autocreate', value: $('#ghAuto').value }); toast(T('已保存')); renderConnections(); } catch (e) { toast(e.message, true); } });
  if ($('#ghOAuthSave')) $('#ghOAuthSave').onclick = async () => {
    const g = (await api('/api/connections')).githubLogin;
    try { await api('/api/connections', { action: 'oauth', id: $('#ghApp')?.value || g.app.id, clientId: $('#ghClientId').value, clientSecret: $('#ghClientSecret').value }); toast(T('已保存')); renderConnections(); } catch (e) { toast(e.message, true); }
  };
  if ($('#cnBoardSave')) $('#cnBoardSave').onclick = async () => { try { await api('/api/users', { action: 'setting', key: 'deploy.board_url', value: $('#cnBoardUrl').value }); toast(T('已保存')); renderConnections(); } catch (e) { toast(e.message, true); } };
  if ($('#cnCoauthor')) $('#cnCoauthor').onchange = async () => { try { await api('/api/users', { action: 'setting', key: 'deploy.commit_coauthor', value: $('#cnCoauthor').checked }); toast(T('已保存')); renderConnections(); } catch (e) { toast(e.message, true); } };
  onPick($('#cnOrder'), async () => { try { await api('/api/users', { action: 'setting', key: 'deploy.credential_order', value: $('#cnOrder').value }); toast(T('已保存')); renderConnections(); } catch (e) { toast(e.message, true); } });
  $('#ccGo').onclick = async () => {
    const remote = $('#ccRemote').value.trim(); if (!remote) return toast(T('先填远端地址'), true);
    $('#ccOut').textContent = T('检查中…');
    try { const r = await api('/api/connections', { action: 'check', remote }); $('#ccOut').innerHTML = connCheckText(r.result); renderConnectionsTableOnly(); } catch (e) { $('#ccOut').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  };
  if (!$('#cnKind')) return;
  onPick($('#cnKind'), () => { connKind = $('#cnKind').value; renderConnections(); });
  $('#cnSave').onclick = async () => {
    const name = $('#cnName').value.trim(); if (!name) return toast(T('先起个名字：以后才认得出是哪一份'), true);
    const secret = $('#cnSecret').value; if (!secret.trim()) return toast(T('没有填凭据内容'), true);
    const expiry = $('#cnExp')?.value ? Date.parse(`${$('#cnExp').value}T23:59:59`) : null;
    try {
      await api('/api/connections', { action: 'add', kind: connKind, scope: $('#cnScope').value, name, host: $('#cnHost').value.trim(), pathGlob: $('#cnGlob').value.trim(),
        appId: $('#cnApp')?.value.trim() || null, username: $('#cnUser')?.value.trim() || null, expiresAt: expiry, secret });
      $('#cnSecret').value = '';
      toast(T('已保存'));
      renderConnections();
    } catch (e) { toast(e.message, true); }
  };
}
// 检查之后"最近检查"一栏要跟着变，但不能把刚填了一半的添加表单清掉：只重画表格那一块
async function renderConnectionsTableOnly() {
  const keep = { remote: $('#ccRemote')?.value, out: $('#ccOut')?.innerHTML, name: $('#cnName')?.value, secret: $('#cnSecret')?.value };
  await renderConnections();
  if ($('#ccRemote')) $('#ccRemote').value = keep.remote ?? '';
  if ($('#ccOut')) $('#ccOut').innerHTML = keep.out ?? '';
  if ($('#cnName')) $('#cnName').value = keep.name ?? '';
  if ($('#cnSecret')) $('#cnSecret').value = keep.secret ?? '';
}
// 交付前的预检：会用哪份连接、能不能推。读不了 / 推不了就先问一句，不让人等到推送失败才知道
async function deliverPreflight(remote) {
  if (!remote) return true;
  let c; try { c = (await api('/api/connections', { action: 'check', remote })).result; } catch { return true; }
  const plain = connCheckText(c).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  if (c.canRead === false || c.canPush === false) return confirm(`${T('交付前检查没通过：')}\n${plain}\n\n${T('多半会推不上去。仍要尝试吗？（连接在「设置 → 连接」里加）')}`);
  toast(plain.split('\n')[0]);
  return true;
}

async function renderEgressCat() {
  const box = $('#egressCat'); if (!box) return;
  let data; try { data = await api('/api/egress/sources'); } catch (e) { box.innerHTML = `<span class="bad small">${esc(e.message)}</span>`; return; }
  const admin = me?.role === 'lead';
  const row = (s) => `<div class="item">
      <div class="row"><b>${esc(T(s.name))}</b> <span class="small mute mono">${esc(s.id)}</span> <span class="pill">${esc(KIND_NAME[s.kind] ?? s.kind)}</span>${s.readOnly ? ` <span class="pill" title="${T('代理只放行 GET / HEAD / OPTIONS：能读，不能往外提交。它收窄了往外送数据的路，但没有封死 —— 少量数据仍可以塞进网址参数里带出去')}">${T('只读')}</span>` : ''}${s.builtin ? ` <span class="small mute">${T('内置')}</span>` : ''}
        <span class="grow"></span>${admin ? `<label class="small" title="${T('新建的项目一建好就放行它，不用负责人再勾、也不会在第一次装依赖时多一条事项')}"><input type="checkbox" data-defsrc="${esc(s.id)}" style="width:auto"${s.isDefault ? ' checked' : ''}> ${T('新项目默认放行')}</label>` : (s.isDefault ? `<span class="pill">${T('新项目默认放行')}</span>` : '')}${admin && !s.builtin ? ` <button class="small" data-rmsrc="${esc(s.id)}">${T('删除')}</button>` : ''}</div>
      <div class="small mono" style="margin-top:4px">${s.hosts.map(esc).join(T('　'))}</div>
      ${Object.entries(s.toolEnv || {}).filter(([, v]) => v !== null).length ? `<div class="small" style="margin-top:2px"><span class="mute">${T('工具配置：')}</span><span class="mono">${Object.entries(s.toolEnv).filter(([, v]) => v !== null).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(T('　'))}</span></div>` : ''}
      ${(s.secretKeys ?? []).map((k) => `<div class="small" style="margin-top:2px;color:var(--wait)">⚠ ${s.toolEnv?.[k] != null ? T('工具配置 <span class="mono">{k}</span> 的网址里存着用户名密码（这里不显示）：这部分已经不再放进沙箱，要认证的安装会失败。', { k: esc(k) }) : T('工具配置 <span class="mono">{k}</span> 像是令牌：已经不再放进沙箱，要认证的安装会失败。', { k: esc(k) })}${T('怎么改：见「运行状况」里「联网目录里的凭据」一项。')}</div>`).join('')}
      ${s.credential ? `<div class="small" style="margin-top:2px"><span class="mute">${T('凭据：')}</span>${T('访问这个源时由出口代理带上 <span class="mono">{h}</span>{hint}，沙箱里的代码看不到值；', { h: esc(s.credential.header), hint: s.credential.hint ? T('（值的末四位 {x}）', { x: esc(s.credential.hint.replace(/^…/, '')) }) : '' })}${s.credential.allowWrite ? `<b>${T('读写请求都带')}</b>` : T('只在读取的请求上带（下载包、查元数据）')}</div>
      <div class="small" style="margin-top:2px">${s.credential.allowWrite ? T('放行这个源的项目，它放行的其余源都变成只读（POST、PUT 这类请求拦下）；这个源本身读写都行（管理员允许的）。') : T('放行这个源的项目，它放行的所有源都变成只读：POST、PUT 这类请求（上传、发布、调接口改东西）一律拦下，GET 和 git clone 照常 —— 防止拿凭据读到的东西被送去别处。交付时的推送在服务器上做，不受影响。')}</div>` : ''}
      ${s.note ? `<div class="small mute" style="margin-top:2px">${esc(T(s.note))}</div>` : ''}${s.needsTool ? `<div class="small bad" style="margin-top:2px">⚠ ${T('沙箱里没有 {tool}，放行了也用不上', { tool: esc(s.needsTool) })}</div>` : ''}
      <div class="small mute" style="margin-top:2px">${s.usedBy.length ? T('在用的项目：{list}', { list: s.usedBy.map((p) => esc(p.title)).join(T('、')) }) : T('没有项目在用')}</div></div>`;
  box.innerHTML = `<div class="small mute">${T('沙箱默认断网。这里列出所有<b>可以被放行</b>的地址；哪个项目真正放行哪几个，由项目负责人在「项目设置 → 联网」里勾选；勾了「新项目默认放行」的，新项目一建好就放行（已有的项目不受影响）。删掉一个正在被项目用的源，那些项目立即访问不了它（删之前会列出是哪些项目）。往这里加一项，等于给所有项目多了一个可选的出口，所以只有管理员能改。')}</div>
    ${data.sources.map(row).join('')}
    ${admin ? `<details style="margin-top:12px"><summary><b>${T('添加一项')}</b></summary>
      <div class="row" style="margin-top:8px"><input id="srcName" aria-label="${T('名称')}" placeholder="${T('名称，例如：清华 PyPI 镜像')}" style="flex:2">
        <select id="srcKind" style="flex:1" aria-label="${T('类型')}"><option value="package">${T('软件源（装依赖用）')}</option><option value="info">${T('信息源（查资料用）')}</option></select></div>
      <div class="row" style="margin-top:6px"><textarea id="srcHosts" rows="3" aria-label="${T('域名')}" placeholder="${T('域名，一行一个，例如：pypi.tuna.tsinghua.edu.cn&#10;可以写 *.example.com；不能写 IP、localhost 或内网地址')}" style="flex:1"></textarea></div>
      <div class="row small" style="margin-top:6px"><label title="${T('代理只放行 GET / HEAD / OPTIONS：能读，不能往外提交。它收窄了往外送数据的路，但没有封死 —— 少量数据仍可以塞进网址参数里带出去。信息源默认只读')}"><input type="checkbox" id="srcRO" style="width:auto"> ${T('只读')}</label></div>
      <div class="row" style="margin-top:6px" id="srcEnvRow"><textarea id="srcEnv" rows="2" aria-label="${T('工具配置（可选）')}" placeholder="${T('工具配置（可选），一行一个 名称=值，例如：PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple&#10;不填的话，工具仍会去连官方地址。不要在这里放密码或令牌')}" style="flex:1"></textarea></div>
      <div class="row" style="margin-top:6px"><input id="srcNote" aria-label="${T('备注（可选）')}" placeholder="${T('备注（可选）：用途、谁维护')}" style="flex:1"><button id="srcAdd" class="primary">${T('添加')}</button></div></details>` : ''}`;
  if (!admin) return;
  const kind = $('#srcKind'), ro = $('#srcRO');
  const sync = () => { ro.checked = kind.value === 'info'; $('#srcEnvRow').classList.toggle('hide', kind.value === 'info'); };
  kind.onchange = sync; sync();
  $('#srcAdd').onclick = async () => {
    const toolEnv = Object.fromEntries($('#srcEnv').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, '']; }));
    try {
      await api('/api/egress/sources', { name: $('#srcName').value, kind: kind.value, hosts: $('#srcHosts').value, readOnly: ro.checked, toolEnv: kind.value === 'info' ? {} : toolEnv, note: $('#srcNote').value });
      toast(T('已加入联网目录')); renderEgressCat();
    } catch (e) { toast(e.message, true); }
  };
  box.querySelectorAll('[data-defsrc]').forEach((c) => c.onchange = async () => {
    try { await api('/api/egress/sources', { action: 'default', id: c.dataset.defsrc, on: c.checked }); toast(c.checked ? T('之后新建的项目会默认放行它') : T('之后新建的项目不再默认放行它（已有的项目不变）')); }
    catch (e) { c.checked = !c.checked; toast(e.message, true); }
  });
  box.querySelectorAll('[data-rmsrc]').forEach((b) => b.onclick = async () => {
    const s = data.sources.find((x) => x.id === b.dataset.rmsrc);
    if (!confirm(`${T('从联网目录删掉「{name}」？', { name: s.name })}${s.usedBy.length ? `\n\n${T('这些项目正在用它，删掉后立即访问不了（正在跑的任务可能因此失败）：')}\n${s.usedBy.map((p) => `· ${p.title}`).join('\n')}` : ''}`)) return;
    try { await api('/api/egress/sources', { action: 'remove', id: s.id }); toast(T('已删除')); renderEgressCat(); } catch (e) { toast(e.message, true); }
  });
}
async function renderPsNet(p) {
  const box = $('#psNet'); if (!box) return;
  let data; try { data = await api('/api/egress/sources'); } catch (e) { box.innerHTML = `<span class="bad small">${esc(e.message)}</span>`; return; }
  const on = new Set(p.egress ?? []);
  box.innerHTML = `<div class="small mute">${T('沙箱默认断网。勾选的地址本项目所有任务都能访问，没勾的一律被拦。任务执行中需要别的地址时，系统会先来问你，不会自己放行。')}</div>
    ${data.sources.map((s) => `<label class="row" style="margin-top:8px;align-items:flex-start;gap:8px" title="${esc(s.hosts.join('\n'))}">
      <input type="checkbox" data-src="${esc(s.id)}" style="width:auto;margin-top:3px"${on.has(s.id) ? ' checked' : ''}>
      <span><b>${esc(T(s.name))}</b> <span class="small mute">${esc(KIND_NAME[s.kind] ?? s.kind)}${s.readOnly ? ` · ${T('只读')}` : ''}</span>${s.needsTool ? ` <span class="small bad">${T('沙箱里没有 {tool}，放行了也用不上', { tool: esc(s.needsTool) })}</span>` : ''}<br><span class="small mono mute">${s.hosts.map(esc).join(T('　'))}</span></span></label>`).join('')}
    <div class="row" style="margin-top:10px"><span class="small mute">${me?.role === 'lead' ? T('要加目录里没有的地址，去「设置 → 联网目录」') : T('要加目录里没有的地址，请管理员在「设置 → 联网目录」里添加')}</span><span class="grow"></span><button id="psNetSave" class="primary">${T('保存')}</button></div>`;
  // 带上打开时看到的名单：服务端只应用你勾掉 / 新勾的，打开之后别人放行的保留（不整份覆盖）
  const nameOf = (id) => T(data.sources.find((s) => s.id === id)?.name ?? id);
  $('#psNetSave').onclick = () => projAct(p.id, 'egress', { sources: [...box.querySelectorAll('input[data-src]:checked')].map((x) => x.dataset.src), base: [...on] },
    (r) => (r?.result?.keptOthers?.length
      ? T('已保存。现在放行的是：{all}。其中 {names} 是你打开这一页之后 {who} 刚放行的，你的保存保留了它；不想放行 {names}，取消勾选后再保存', { all: r.result.sources.map(nameOf).join(T('、')), names: r.result.keptOthers.map(nameOf).join(T('、')), who: [...new Set(r.result.keptOthers.map((id) => r.result.keptBy?.[id] ?? T('别人')))].join(T('、')) })
      : T('项目联网已保存（下一次开工 / 跑验收时生效）')));
}

// 项目规则文件：仓库里的 AGENTS.md 等。看：所有能看项目的人；改：负责人（服务端再判一次）
// 走查：编辑框就地展开在那一行下面（和「查看」一样）；同一时间只开一个，有没保存的改动先问；新建时实时显示要建的文件
async function renderPsRules(p) {
  const box = $('#psRules'); if (!box) return;
  let data; try { data = await api(`/api/projects/${p.id}/rules`); } catch (e) { box.innerHTML = `<span class="bad small">${esc(e.message)}</span>`; return; }
  const row = (f, i) => `<div class="item${f.shadowedBy ? ' off' : ''}" style="margin-top:8px">
      <div class="row"><b class="mono">${esc(f.path)}</b>${f.shadowedBy ? ` <span class="small" style="color:var(--wait)">${T('AI 不读这份：同一目录里只读 {other}', { other: `<span class="mono">${esc(f.shadowedBy)}</span>` })}</span>` : ''}<span class="grow"></span>
        <span class="small mute">${f.at ? T('{who} {ago}前改的', { who: esc(f.author ?? ''), ago: ago(f.at) }) : ''}</span>
        <button class="ghost small" data-rview="${esc(i)}">${T('查看')}</button>${data.canEdit ? `<button class="small" data-redit="${esc(i)}">${T('编辑')}</button>` : ''}</div>
      <pre class="small hide" data-rbody="${esc(i)}" style="white-space:pre-wrap;margin-top:6px">${esc(f.text)}</pre><div data-rslot="${esc(i)}"></div></div>`;
  box.innerHTML = `<div class="small mute">${T('AI 每一步都按这些文件里写的构建、测试、代码风格去做，离要改的文件越近的那份越优先。和任务说明或{link}冲突时以那两样为准：下一步开跑前系统会比一遍，对不上就挂一条事项给负责人，选改规则文件还是改约定。', { link: `<a href="#p/${esc(p.id)}">${T('已定的约定')}</a>` })}</div>
    ${data.files.length ? data.files.map(row).join('') : `<div class="small" style="margin-top:8px">${T('这个项目的仓库里还没有规则文件。')}</div>`}
    ${data.canEdit ? `<div class="row" style="margin-top:10px"><span class="grow"></span><button id="psRuleNew">${T('新建规则文件')}</button></div><div data-rslot="new"></div>` : ''}`;
  box.querySelectorAll('[data-rview]').forEach((b) => b.onclick = () => box.querySelector(`[data-rbody="${b.dataset.rview}"]`).classList.toggle('hide'));
  let openSlot = null, openName = '', orig = '';
  const dirty = () => openSlot && (($('#psRuleText')?.value ?? '') !== orig || !!($('#psRuleDir')?.value ?? '').trim());
  const send = async (body, msg) => { try { await api(`/api/projects/${p.id}/rules`, body); toast(msg); renderPsRules(p); } catch (e) { toast(e.message, true); } };
  const open = (f, slotKey) => {
    if (openSlot === slotKey) return;
    if (dirty() && !confirm(T('{path} 还有没保存的改动，丢掉它？', { path: openName }))) return;
    if (openSlot != null) box.querySelector(`[data-rslot="${openSlot}"]`).innerHTML = '';
    openSlot = slotKey; openName = f?.path ?? T('新建的规则文件'); orig = f?.text ?? '';
    const slot = box.querySelector(`[data-rslot="${slotKey}"]`);
    slot.innerHTML = `<div class="item flag" style="margin-top:8px">
      ${f?.shadowedBy ? `<div class="small" style="color:var(--wait)">${T('AI 不读这份：同一目录里只读 {other}', { other: `<span class="mono">${esc(f.shadowedBy)}</span>` })}</div>` : ''}
      ${f ? '' : `<label class="small">${T('目录（相对仓库根，根目录留空）')} <input id="psRuleDir" class="mono" style="width:14em" placeholder="${T('例如 web')}"></label>
        <div class="small" style="margin-top:4px">${T('将新建：{path}', { path: '<b class="mono" id="psRulePath">AGENTS.md</b>' })} <span class="bad" id="psRuleDup"></span></div>`}
      <label class="small" style="display:block;margin-top:6px">${T('内容（AI 原样读到，Markdown 写法即可）')}</label>
      <textarea id="psRuleText" rows="14" class="mono" style="width:100%">${esc(orig)}</textarea>
      <div class="row" style="margin-top:6px"><span class="small mute">${T('保存＝在项目分支 {branch} 上提交一次。之后开始执行的任务读新版；已经在执行的任务继续用它开始时那一版。', { branch: `<span class="mono">${esc(p.branch ?? '')}</span>` })}</span><span class="grow"></span>
        ${f ? `<button class="ghost danger small" id="psRuleDel">${T('删除这份')}</button>` : ''}<button class="ghost" id="psRuleCancel">${T('取消')}</button><button class="primary" id="psRuleSave">${T('保存')}</button></div></div>`;
    const pathOf = () => { const d = ($('#psRuleDir')?.value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); return d ? `${d}/AGENTS.md` : 'AGENTS.md'; };
    if (!f) {
      const sync = () => { const x = pathOf(); $('#psRulePath').textContent = x; const dup = data.files.some((z) => z.path === x); $('#psRuleDup').textContent = dup ? T('已经有了：在上面的列表里点它的「编辑」') : ''; $('#psRuleSave').disabled = dup; };
      $('#psRuleDir').oninput = sync; sync(); $('#psRuleDir').focus();
    } else $('#psRuleText').focus();
    $('#psRuleCancel').onclick = () => { slot.innerHTML = ''; openSlot = null; };
    $('#psRuleSave').onclick = () => send({ path: f ? f.path : pathOf(), text: $('#psRuleText').value, base: f?.sha ?? null }, T('已保存，提交到了项目分支'));
    if (f) $('#psRuleDel').onclick = () => { if (confirm(T('删除 {path}？会在项目分支上提交一次删除，git 历史里找得回来。', { path: f.path }))) send({ path: f.path, delete: true, base: f.sha }, T('已删除')); };
  };
  box.querySelectorAll('[data-redit]').forEach((b) => b.onclick = () => open(data.files[Number(b.dataset.redit)], b.dataset.redit));
  if (data.canEdit) $('#psRuleNew').onclick = () => open(null, 'new');
}

// skill：按来源分三组；每份一行：名字、一句说明、给不给 AI 用（负责人能开关，只管本项目）、查看正文
async function renderPsSkills(p) {
  const box = $('#psSkills'); if (!box) return;
  let data; try { data = await api(`/api/projects/${p.id}/skills`); } catch (e) { box.innerHTML = `<span class="bad small">${esc(e.message)}</span>`; return; }
  const msg = (w) => esc(T(w.msg, w.params ?? {}));
  const GROUPS = [
    ['deploy', T('服务器上装的（所有项目都能用）'), T('管理员在服务器上用命令 {cmd} 安装。', { cmd: '<code>skill add &lt;目录&gt;</code>' })],
    ['project', T('服务器上给本项目装的'), T('负责人或管理员在服务器上用命令 {cmd} 安装。', { cmd: `<code>skill add &lt;目录&gt; --project ${esc(p.id)}</code>` })],
    ['repo', T('仓库里的'), T('放在仓库的 {a} 或 {b}，提交到项目分支后就会出现。', { a: '<code>.agents/skills/&lt;名字&gt;/SKILL.md</code>', b: '<code>.claude/skills/&lt;名字&gt;/SKILL.md</code>' })],
  ];
  const state = (s) => s.error ? `<span class="bad small">${T('用不了：{why}', { why: msg(s.error) })}</span>`
    : s.shadowedBy ? `<span class="small" style="color:var(--wait)">${T('不给 AI：「{group}」里有同名的，用的是那份。要换用这份：把上面那份取消勾选，再勾上这份。', { group: esc(GROUPS.find(([l]) => l === s.shadowedBy.split(':')[0])?.[1] ?? s.shadowedBy) })}</span>`
    : s.offBy === 'deploy' ? `<span class="small" style="color:var(--wait)">${T('管理员停用了（对所有项目）')}</span>`
    : !s.invocable ? `<span class="small mute">${T('这份 AI 不会自己挑（它的 SKILL.md 里写了 disable-model-invocation: true）：任务描述或步骤里写出它的名字（{name}）时才给。', { name: `<span class="mono">${esc(s.name)}</span>` })}</span>` : '';
  const toggle = (s, i) => (s.error || s.shadowedBy || s.offBy === 'deploy' ? ''
    : `<label class="small"><input type="checkbox" data-sk="${esc(i)}" ${s.enabled ? 'checked' : ''} ${data.canEdit ? '' : 'disabled'}> ${s.invocable ? T('本项目给 AI 用') : T('本项目点名时给 AI')}</label>`);
  const row = (s, i) => `<div class="item${s.error || s.shadowedBy || s.offBy === 'deploy' ? ' off' : ''}" style="margin-top:6px">
      <div class="row"><b class="mono">${esc(s.name)}</b>${s.where ? ` <span class="small mute mono">${esc(s.where)}/SKILL.md</span>` : ''}<span class="grow"></span>${toggle(s, i)}<button class="ghost small" data-skv="${esc(i)}">${T('查看')}</button></div>
      ${s.description ? `<div class="small">${esc(s.description)}</div>` : ''}${state(s) ? `<div>${state(s)}</div>` : ''}
      ${s.warnings.length ? `<div class="small mute">${s.warnings.map((w) => `⚠ ${msg(w)}`).join('<br>')}</div>` : ''}
      <div class="hide" data-skb="${esc(i)}"><div class="small mute" style="margin-top:6px">${s.where ? T('在仓库的 {path}', { path: `<span class="mono">${esc(s.where)}/</span>` }) : ''}${s.files ? ` ${T('另有 {n} 个参考文件', { n: esc(s.files) })}` : ''}</div>
        <pre class="small" style="white-space:pre-wrap;margin-top:4px">${esc(s.body)}</pre></div></div>`;
  box.innerHTML = `<div class="small mute">${T('Skill 是写好的做法说明（怎么用某个工具、按什么流程做某类事）。和「项目规则」不同：规则每一步都整份给 AI；skill 每一步只先给名字和那句说明，AI 用得上时才取全文。')} ${T('新出现的默认给 AI 用；这里的勾只管本项目，改了从之后开始的步骤起生效。')}${data.canEdit ? '' : ` ${T('只有项目负责人能开关。')}`}</div>
    ${GROUPS.map(([layer, title, how]) => { const xs = data.skills.map((s, i) => [s, i]).filter(([s]) => s.layer === layer);
      return `<h3 style="margin-top:14px">${esc(title)}</h3><div class="small mute">${how}</div>${xs.length ? xs.map(([s, i]) => row(s, i)).join('') : `<div class="small" style="margin-top:4px">${T('没有。')}</div>`}`; }).join('')}`;
  box.querySelectorAll('[data-skv]').forEach((b) => b.onclick = () => box.querySelector(`[data-skb="${b.dataset.skv}"]`).classList.toggle('hide'));
  box.querySelectorAll('[data-sk]').forEach((c) => c.onchange = async () => {
    const s = data.skills[Number(c.dataset.sk)];
    try { await api(`/api/projects/${p.id}/skills`, { id: s.id, enabled: c.checked }); const nm = `${s.name}（${({ deploy: T('服务器上装的'), project: T('给本项目装的'), repo: T('仓库里的') })[s.layer] ?? s.layer}）`;
      toast(c.checked ? T('{name} 给 AI 用了（之后开始的步骤生效）', { name: nm }) : T('{name} 不再给 AI（之后开始的步骤生效）', { name: nm })); }
    catch (e) { toast(e.message, true); }
    renderPsSkills(p);
  });
}

// 策略钩子：只读。按"什么时候查"分四段，每段先列系统自带的检查，再列配置的钩子
// 配置示例：一个时机一组；matcher 只在 PreToolUse 有用（工具名，Claude 的名字与我们的都认）；timeout 秒；onFailure 只在前两个时机有用
const HOOK_EXAMPLE = JSON.stringify({ hooks: {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .superintern/hooks/no-rm.mjs', timeout: 10, onFailure: 'block' }] }],
  PreDeliver: [{ hooks: [{ type: 'command', command: 'node .superintern/hooks/check-remote.mjs' }] }],
} }, null, 2);
async function renderPsHooks(p) {
  const box = $('#psHooks'); if (!box) return;
  let data; try { data = await api(`/api/projects/${p.id}/hooks`); } catch (e) { box.innerHTML = `<span class="bad small">${esc(e.message)}</span>`; return; }
  const msg = (w) => esc(T(w.msg, w.params ?? {}));
  const code = (s) => `<code>${esc(s)}</code>`;
  // 每个时机固定三行：拦下 / 要人确认 / 钩子自己出错 —— 各自谁收到、怎么回应
  const FAIL_OPEN = T('默认放行，免得一个坏掉的脚本让 AI 寸步难行；单条钩子写 {k} 就改成拦下', { k: code('"onFailure": "block"') });

  const WHEN = [
    ['PreToolUse', T('AI 每次用工具之前'), T('读写文件、跑命令、取 skill 之前（提问和交接不经过这一关）。'),
      [T('这一下不执行，理由交给 AI，让它换个做法'), T('这一步停下，收件箱里来一条事项；回「同意」放行这条操作（之后一模一样的不再问），回别的都算不同意，AI 换别的做法'), FAIL_OPEN]],
    ['PreHandoff', T('AI 交接一步的时候'), T('AI 说"这一步做完了"、系统自带的检查都过了之后。'),
      [T('打回给 AI，理由一起给它；同一个理由连续三次，转成一条事项给你'), T('这一步停下，收件箱里来一条事项；回「同意」放行，回别的都算不同意，AI 换别的做法'), FAIL_OPEN]],
    ['PreMerge', T('合并进项目分支之前'), T('任务签收以后、合进项目分支之前。'),
      [T('不合并，收件箱里来一条事项；你的答复交给 AI 去改，改完重新签收'), T('不合并，收件箱里来一条事项；回「同意」放行这一版的合并，回别的都当成要 AI 改的意见'),
        T('一律拦下（合进去之后，后面的任务都从它开始）：收件箱里来一条事项，写明是钩子自己坏了；修好钩子后回一句，系统重新检查')]],
    ['PreDeliver', T('推到外面之前'), T('交付任务或交付项目、推到远端仓库之前。'),
      [T('交付报错，不推送'), T('交付先停下，把钩子的话给点交付的人看，确认后才推送。命令行里报错会给一个确认码，同一条命令加 {k} 再交付一次；钩子说的变了，确认码就作废', { k: code('--hook-ack <确认码>') }),
        T('一律拦下（推出去就收不回来）：交付报错、不推送；修好钩子再交付')]],
  ];
  const TOOL = { run_command: T('跑命令'), write_file: T('写文件'), read_file: T('读文件'), grep: T('搜索'), list_dir: T('列目录'), activate_skill: T('取 skill') };
  const from = (h) => h.source === 'repo' ? T('仓库里的 {file}', { file: `<span class="mono">${esc(h.file)}</span>` }) : h.source === 'project' ? T('服务器上的，只管本项目') : T('服务器上的，管所有项目');
  const gate = (ev) => ev === 'PreMerge' || ev === 'PreDeliver';
  const trustCmd = (h) => code(`node src/cli.mjs hook trust${h.source === 'project' ? ` --project ${p.id}` : ''}`);
  const statusText = (h) => h.status === 'on'
    ? `<span class="small" style="color:var(--ok)">${h.source === 'repo' ? T('● 生效：跑的是项目分支上已提交的版本') : T('● 生效：管理员核准过这一版')}</span>`
    : `<span class="small" style="color:var(--wait)">${h.status === 'changed' ? T('○ 没生效：管理员核准之后，命令或它调用的脚本改过了') : T('○ 没生效：新加的，管理员还没核准')}</span>
       <div class="small mute">${(h.source === 'project' ? T('项目负责人或管理员在服务器上运行 {cmd} 核准后才会跑。', { cmd: trustCmd(h) }) : T('管理员在服务器上运行 {cmd} 核准后才会跑。', { cmd: trustCmd(h) }))}${h.event === 'PreMerge' || h.event === 'PreDeliver' ? T('这一关没核准的钩子算出错，会拦下。') : T('没核准的不跑，这一关照常放行。')}</div>`;
  const hookRow = (h) => `<div class="item${h.status === 'on' ? '' : ' off'}" style="margin-top:6px">
      <div class="row"><span class="small">${from(h)}</span>${h.matcher ? ` <span class="small mute">${T('只管 {tools}', { tools: `<span class="mono">${esc(h.matcher)}</span>${h.tool ? `（${esc(TOOL[h.tool])}）` : ''}` })}</span>` : ''}<span class="grow"></span><span class="small mute">${T('超过 {n} 秒算出错', { n: esc(h.timeout) })}</span></div>
      <div>${statusText(h)}</div>
      ${h.command ? `<div class="mono small">${esc(h.command)}</div>` : `<div class="small mute">${T('命令只给项目负责人和管理员看')}</div>`}
      ${!gate(h.event) && h.onFailure === 'block' ? `<div class="small mute">${T('这条钩子出错时拦下（它写了 {k}）', { k: code('"onFailure": "block"') })}</div>` : ''}</div>`;
  const section = ([ev, title, note, [deny, ask, failed]]) => {
    const own = data.builtin.filter((x) => x.event === ev), mine = data.hooks.filter((h) => h.event === ev);
    return `<h3 style="margin-top:16px">${esc(title)} <span class="small mute mono" style="font-weight:400">${esc(ev)}</span></h3><div class="small mute">${esc(note)}</div>
      <ul class="small" style="margin:4px 0 0 18px"><li><b>${T('钩子说拦下')}</b>：${esc(deny)}</li><li><b>${T('钩子说要人确认')}</b>：${ask}</li><li><b>${T('钩子自己出错')}</b>${T('（脚本崩了、超时、输出看不懂）')}：${failed}</li></ul>
      <div class="small" style="margin-top:6px"><b>${T('系统自带的检查')}</b>${T('（一直开着）')}</div><ul class="small" style="margin:2px 0 0 18px">${own.map((x) => `<li>${esc(T(x.what))}</li>`).join('')}</ul>
      <div class="small" style="margin-top:6px"><b>${T('配置的钩子')}</b></div>${mine.length ? mine.map(hookRow).join('') : `<div class="small mute">${T('没有。')}</div>`}`;
  };
  // 四处来源：写在哪、写进去之后怎么生效；读配置时跳过的内容挂在它自己的来源下面
  const SRC = {
    '.superintern/hooks.json': [T('仓库里的 {file}', { file: code('.superintern/hooks.json') }), T('四个时机都认。提交到项目分支后生效，在任务的沙箱里只读地跑（能不能联网同任务）。AI 改钩子文件会被打回；要改就发一条变更、在任务范围里点名这个文件，合并前还会先问你。')],
    '.claude/settings.json': [T('仓库里的 {file}', { file: code('.claude/settings.json') }), T('和 Claude Code 共用的那份：只认其中 PreToolUse（用工具之前）的钩子，其余跳过。它也算钩子文件，AI 改它同样会被打回。')],
    deploy: [T('服务器上的，管所有项目'), T('管理员写在服务器数据目录的 hooks.json 里，核准后才跑。')],
    project: [T('服务器上的，只管本项目'), T('管理员写在服务器上这个项目目录的 hooks.json 里；项目负责人或管理员核准后才跑。')],
  };
  const srcRow = (s) => { const [name, how] = SRC[s.kind === 'repo' ? s.file : s.kind];
    return `<li><b>${name}</b>：${how}${s.warnings.map((w) => `<div style="color:var(--wait)">⚠ ${msg(w)}${T('（这一条没有生效）')}</div>`).join('')}</li>`; };
  box.innerHTML = `<div class="small">${T('钩子是自己写的检查脚本。到了下面某个时机，系统把要做的事（用哪个工具、改了哪些文件、要推到哪）交给它，它回答三种之一：放行、拦下、要人确认。')}</div>
    <div class="small mute" style="margin-top:4px">${T('写法照 Claude Code 的 hooks：脚本从标准输入收到一份 JSON（时机、工具和参数、改了哪些文件、要推到哪……）。退出码 0 = 放行；退出码 2 = 拦下，理由写在标准错误里；其它退出码（包括 1）算钩子自己出错，不是拦下。要人确认或附带说明，就退出码 0、在标准输出打一段 JSON，写 {k}。', { k: code('hookSpecificOutput.permissionDecision: "allow" | "deny" | "ask"') })}
      <button class="ghost small" id="psHookEx">${T('看配置示例')}</button></div>
    <pre class="small hide" id="psHookExBody" style="white-space:pre-wrap;margin-top:4px">${esc(HOOK_EXAMPLE)}</pre>
    <div class="small mute" style="margin-top:4px">${T('这一页只看，不在这里改。')}</div>
    <h3 style="margin-top:12px">${T('钩子写在哪里')}</h3><ul class="small" style="margin:2px 0 0 18px">${data.sources.map(srcRow).join('')}</ul>
    ${WHEN.map(section).join('')}`;
  $('#psHookEx').onclick = () => $('#psHookExBody').classList.toggle('hide');
}

// MCP：server 给 AI 加工具。怎么才给 AI（写配置 → 检查 → 读过说明批准）写在最上面；每个 server 一张卡：状态、变了什么、工具与用法
async function renderPsMcp(p) {
  const box = $('#psMcp'); if (!box) return;
  let data; try { data = await api(`/api/projects/${p.id}/mcp`); } catch (e) { box.innerHTML = `<span class="bad small">${esc(e.message)}</span>`; return; }
  const msg = (w) => esc(T(w.msg, w.params ?? {}));
  const code = (s) => `<code>${esc(s)}</code>`;
  const SRC = {
    repo: [T('仓库里的 {file}', { file: code('.mcp.json') }), T('格式同 Claude Code。提交到项目分支后出现在这里。')],
    project: [T('服务器上的，只管本项目'), T('管理员写在服务器上这个项目目录的 mcp.json 里。')],
    deploy: [T('服务器上的，管所有项目'), T('管理员写在服务器数据目录的 mcp.json 里；每个项目仍要各自批准。')],
  };
  const MODES = [['ask', T('每次调用问人')], ['auto', T('直接用')], ['off', T('不给 AI')]];
  const CHANGE = { added: T('新加的工具'), removed: T('去掉的工具'), changed: T('说明或参数变了') };
  const toolText = (t) => `${t.description || T('（没有说明）')}\n${T('参数：')}${JSON.stringify(t.inputSchema?.properties ?? {})}`;
  // 变了什么：前后两份原文并排（读的就是会进 AI 上下文的东西）
  const changeBlock = (c) => `<div class="item" style="margin-top:6px"><div class="small"><b>${esc(CHANGE[c.kind])}：</b><span class="mono">${esc(c.name)}</span></div>
      ${c.before ? `<div class="small mute" style="margin-top:4px">${T('批准时：')}</div><pre class="small" style="white-space:pre-wrap;margin:2px 0 0">${esc(toolText(c.before))}</pre>` : ''}
      ${c.after ? `<div class="small mute" style="margin-top:4px">${T('现在：')}</div><pre class="small" style="white-space:pre-wrap;margin:2px 0 0">${esc(toolText(c.after))}</pre>` : ''}</div>`;
  // 工具说明是 server 自己报的：去哪查是谁改的，看 server 从哪来
  const WHO = {
    repo: T('仓库里的 server：说明来自它的代码或它读的数据文件，查这些文件在项目分支上的提交记录。'),
    project: T('服务器上的 server：找管理员，查服务器上它的程序和配置是谁换的。'),
    deploy: T('服务器上的 server：找管理员，查服务器上它的程序和配置是谁换的。'),
  };
  // 变了之后：先列"不用"（判断写在按钮上面），再列"批准新版本"
  const decideBad = (s) => data.canEdit ? `<div class="row" style="margin-top:6px;gap:8px"><button class="small" data-mcpoff="${esc(s.id)}">${T('不用这个 server')}</button><button class="small ghost" data-mcpok="${esc(s.id)}" data-seen="${esc(s.seen ?? '')}">${T('看过了，没问题，批准新版本')}</button></div>` : '';
  const decide = (s, okLabel) => data.canEdit ? `<div class="row" style="margin-top:6px;gap:8px"><button class="small" data-mcpok="${esc(s.id)}" data-seen="${esc(s.seen ?? '')}">${okLabel}</button><button class="small" data-mcpoff="${esc(s.id)}">${T('不用这个 server')}</button></div>` : '';
  const statusLine = (s) => ({
    approved: `<span class="small" style="color:var(--ok)">${T('● 已批准：AI 拿得到下面"直接用"和"每次调用问人"的工具')}</span>`,
    new: `<span class="small" style="color:var(--wait)">${T('○ 检查过，还没批准：AI 现在拿不到。读过下面每个工具的说明再决定；下面每个工具的设置，批准时照用')}</span>` + decide(s, T('读过了，批准')),
    changed: `<span class="small" style="color:var(--wait)">${T('○ 批准之后变了，AI 现在拿不到它的任何工具。先看下面变了什么，再决定')}</span>`
      + (s.changes.length ? s.changes.map(changeBlock).join('') : `<div class="small mute">${s.fingerprintOnly ? T('（工具没变，是命令、地址或环境变量变了）') : T('（没有批准时那份清单可比）')}</div>`)
      + `<div class="small" style="margin-top:6px"><b>${T('怎么判断：')}</b>${T('「现在」的说明里要 AI 读密钥、改设置、把东西发出去的，就是被改坏了 —— 选「不用这个 server」，再查是谁改的。')}</div>`
      + `<div class="small mute">${WHO[s.source]}</div>`
      + `<div class="small mute" style="margin-top:4px">${T('发现变了的时候，这个 server 的工具已经都回到了「每次调用问人」（之前设的不延续）。不用：这个 server 一直不给 AI，直到你重新启用。批准新版本：按下面每个工具现在的设置给 AI —— 只想停掉其中一个，先把它改成「不给 AI」，再批准。')}</div>`
      + decideBad(s),
    off: `<span class="small mute">${T('○ 不用：负责人停用了，AI 拿不到它的工具')}</span>${data.canEdit ? `<div style="margin-top:6px"><button class="small" data-mcpon="${esc(s.id)}">${T('重新启用')}</button></div>` : ''}`,
    unchecked: `<span class="small mute">${T('○ 还没检查，AI 现在拿不到：点上面的「检查」')}</span>`,
    error: `<span class="bad small">${T('✗ 检查时起不来，AI 现在拿不到：{why}', { why: !s.error ? '' : typeof s.error === 'string' ? esc(s.error) : msg(s.error) })}</span><div class="small mute">${T('改好之后点上面的「检查」；起得来了还要批准。')}</div>`,
  })[s.status];
  const toolRow = (s, t) => `<div class="item" style="margin-top:6px">
      <div class="row"><b class="mono">${esc(t.name)}</b> <span class="small mute mono">${esc(t.full)}</span><span class="grow"></span>
        <label class="small">${T('给 AI：')}<select data-mcpmode="${esc(t.full)}" ${data.canEdit ? '' : 'disabled'} style="width:auto">${MODES.map(([v, l]) => `<option value="${esc(v)}"${t.mode === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label></div>
      ${s.status !== 'approved' ? `<div class="small mute">${T('这个 server 现在没在用：这里的设置在批准之后照用')}</div>` : ''}
      <pre class="small" style="white-space:pre-wrap;margin-top:4px">${esc(t.description || T('（没有说明）'))}</pre>
      ${t.annotations?.readOnlyHint ? `<div class="small mute">${T('server 自称这个工具只读（它自己说的，不作数）')}</div>` : ''}</div>`;
  const card = (s) => `<div class="item" style="margin-top:10px">
      <div class="row"><b class="mono">${esc(s.name)}</b> <span class="small mute">${s.source === 'repo' ? T('仓库里的') : s.source === 'project' ? T('服务器上的，只管本项目') : T('服务器上的，管所有项目')}${s.remote ? ` · ${T('远程')}` : ''}</span></div>
      ${s.command || s.url ? `<div class="mono small">${esc(s.url ?? s.command)}</div>` : `<div class="small mute">${T('命令只给项目负责人和管理员看')}</div>`}
      ${s.warnings.map((w) => `<div class="small" style="color:var(--wait)">⚠ ${msg(w)}</div>`).join('')}
      <div style="margin-top:4px">${statusLine(s)}</div>
      ${s.tools.length ? `<div class="small" style="margin-top:8px"><b>${T('工具（{n} 个）', { n: esc(s.tools.length) })}</b>${s.checkedAt ? ` <span class="mute">${T('{t}前检查的', { t: esc(ago(Date.parse(s.checkedAt))) })}</span>` : ''}</div>${s.tools.map((t) => toolRow(s, t)).join('')}` : ''}</div>`;
  box.innerHTML = `<div class="small">${T('MCP server 给 AI 加工具（查文档、调内部系统……）。server 在任务的沙箱里跑，能连哪里同任务的「联网」设置。')}</div>
    <h3 style="margin-top:12px">${T('怎样才给 AI 用')}</h3>
    <ol class="small" style="margin:2px 0 0 18px">
      <li>${T('写配置（写在哪里见下）。')}</li>
      <li>${T('检查：系统在沙箱里把 server 起一遍，列出它的工具和每个工具的说明。说明会原样进 AI 的上下文，所以要人读。')}</li>
      <li>${T('负责人读过、批准。之后开始的步骤里 AI 才拿得到。命令、地址或任何一个工具的说明变了，就不再给，要重新检查、批准。')}</li>
    </ol>
    <div class="small mute" style="margin-top:4px">${T('每个工具再单独定给不给 AI：「每次调用问人」（默认）= AI 调用时停下，收件箱里来一条事项，回「同意」放行这一条；「直接用」= 不问；「不给 AI」= AI 看不到它，说明也不进上下文。')}</div>
    <div class="small mute" style="margin-top:4px">${T('这一页的改动点了就保存。正在跑的步骤不受影响，从下一个开始的步骤起生效。')}</div>
    <h3 style="margin-top:12px">${T('配置写在哪里')}</h3>
    <ul class="small" style="margin:2px 0 0 18px">${data.sources.map((x) => `<li><b>${SRC[x.kind][0]}</b>：${SRC[x.kind][1]}${x.warnings.map((w) => `<div style="color:var(--wait)">⚠ ${msg(w)}</div>`).join('')}</li>`).join('')}</ul>
    <div class="small mute" style="margin-top:4px">${T('远程 server 写 {t} 和 {u}。它要的令牌别写进配置：管理员在「联网」里按地址配凭据，出口代理注入；MCP 的请求都是 POST，所以那份凭据要勾上允许写。在沙箱里跑的本地 server（command）拿不到令牌：配置里像凭据的环境变量会被去掉。', { t: code('"type": "http"'), u: code('"url"') })}</div>
    <div class="row" style="margin-top:12px"><h3 style="margin:0">${T('Server（{n} 个）', { n: esc(data.servers.length) })}</h3><span class="grow"></span>${data.canEdit && data.servers.length ? `<button class="small" id="psMcpCheck">${T('检查')}</button>` : ''}</div>
    ${data.canEdit && data.servers.length ? `<div class="small mute">${T('检查要起一次沙箱，可能要十几秒到一分钟。只看、不批准。')}</div>` : ''}
    ${data.servers.length ? data.servers.map(card).join('') : `<div class="small" style="margin-top:4px">${T('没有。')}</div>`}
    ${data.canEdit ? '' : `<div class="small mute" style="margin-top:8px">${T('只有项目负责人能检查、批准、改工具的用法。')}</div>`}`;
  const post = async (body, ok) => { try { await api(`/api/projects/${p.id}/mcp`, body); if (ok) toast(ok); } catch (e) { toast(e.message, true); } renderPsMcp(p); };
  if ($('#psMcpCheck')) $('#psMcpCheck').onclick = () => { $('#psMcpCheck').textContent = T('检查中…'); post({ op: 'check' }, T('检查完了，结果在下面')); };
  box.querySelectorAll('[data-mcpok]').forEach((b) => b.onclick = () => post({ op: 'approve', id: b.dataset.mcpok, seen: b.dataset.seen || null }, T('已批准：之后开始的步骤里生效')));
  box.querySelectorAll('[data-mcpoff]').forEach((b) => b.onclick = () => post({ op: 'off', id: b.dataset.mcpoff }, T('已停用：AI 拿不到它的工具')));
  box.querySelectorAll('[data-mcpon]').forEach((b) => b.onclick = () => post({ op: 'on', id: b.dataset.mcpon }, T('已重新启用：还要是批准过的那一版才给 AI')));
  box.querySelectorAll('[data-mcpmode]').forEach((sel) => sel.onchange = () => post({ op: 'mode', tool: sel.dataset.mcpmode, mode: sel.value }, T('已改：之后开始的步骤里生效')));
}

function setPsPane(x) {
  psPane = x;
  document.querySelectorAll('#psnav button').forEach((b) => b.classList.toggle('on', b.dataset.ps === x));
  document.querySelectorAll('#viewProjSet section.pane').forEach((s) => s.classList.toggle('hide', s.dataset.ps !== x));
  // 路由表是表单，不能跟着 SSE 重画：只在切到这一区时画一次
  if (x === 'routing' && projects.some((z) => z.id === curProject)) { routingCtx = { key: curProject, box: '#projRouting', tag: '#projRoutingTag' }; renderRouting(); }
  else if (routingCtx.box === '#projRouting') routingCtx = { key: '', box: '', tag: '' };
  const p = projects.find((z) => z.id === curProject);
  if (p) ({ rules: renderPsRules, hooks: renderPsHooks, mcp: renderPsMcp, skills: renderPsSkills, inbound: renderPsInbound })[x]?.(p);
}
function renderProjSet() {
  const p = projects.find((x) => x.id === curProject);
  const lead = !!me && me.id === p?.owner_id;
  const admin = !lead && me?.role === 'lead';   // 管理员不是本项目负责人，但可以强制交接
  document.querySelectorAll('.ps-lead').forEach((el) => el.classList.toggle('hide', !lead));
  document.querySelectorAll('.ps-danger').forEach((el) => el.classList.toggle('hide', !lead && !admin));
  if ((!lead && ['routing', 'budget', 'auto', 'net'].includes(psPane)) || (!lead && !admin && psPane === 'danger')) setPsPane('general');
  if (!p) { $('#psGeneral').innerHTML = `<span class="mute">${T('项目不存在')}</span>`; $('#projMembers').innerHTML = ''; $('#psBudget').innerHTML = ''; $('#psAuto').innerHTML = ''; $('#psDanger').innerHTML = ''; return; }
  $('#psBack').href = `#p/${p.id}`;
  if (lead) void renderPsNet(p);
  renderPsOversight(p, lead);
  const ownerName = (me?.users ?? []).find((u) => u.id === p.owner_id)?.display_name ?? p.owner_id;
  const pact = (action, body, msg) => projAct(p.id, action, body, msg);

  // ① 常规：标题（只是显示名）、目标与完成定义（改这里不会改动任何已批准的方案）
  const ro = !lead || p.status === 'aborted';
  $('#psGeneral').innerHTML = `<div class="small mute">${lead ? T('这些文字只影响看板显示与系统起草新方案时的参考；不会改动任何已批准的任务方案。') : T('只有项目负责人可以修改。')}</div>
    <div style="margin-top:10px"><label class="small" for="psTitle">${T('项目标题')} <span class="mute">${T('只是显示名称；分支名与历史记录不变')}</span></label>
      <input id="psTitle" value="${esc(p.title)}" style="width:100%" ${ro ? 'disabled' : ''}></div>
    <div style="margin-top:10px"><label class="small" for="psGoal">${T('项目目标')} <span class="mute">${T('这个项目要达成什么')}</span></label>
      <textarea id="psGoal" rows="3" style="width:100%" ${ro ? 'disabled' : ''}>${esc(p.goal ?? '')}</textarea></div>
    <div style="margin-top:10px"><label class="small" for="psDone">${T('完成定义')} <span class="mute">${T('怎样算做完；项目达成与否照这段话判断')}</span></label>
      <textarea id="psDone" rows="3" style="width:100%" ${ro ? 'disabled' : ''}>${esc(p.done_definition ?? '')}</textarea></div>
    ${ro ? (p.status === 'aborted' ? `<div class="small mute" style="margin-top:10px">${T('项目已中止，不能再修改。')}</div>` : '') : `<div class="row" style="margin-top:10px"><button id="psSaveGeneral" class="primary">${T('保存')}</button>
      <span class="small mute">${T('改了目标或完成定义之后：已批准的任务照旧执行，起草中或待批准的方案也不会自动重写 —— 需要体现新目标时，请到该任务页在方案反馈或消息里说明。')}</span></div>`}
    <div class="kv small" style="margin-top:14px"><span class="mute">${T('仓库')}</span><span class="mono">${esc(p.repo)}</span><span class="mute">${T('分支')}</span><span class="mono">${esc(p.branch)} <span class="mute">← ${esc(p.base_ref)}</span></span>${p.source ? `<span class="mute">${T('来源')}</span><span class="mono">${esc(p.source)}</span>` : ''}</div>
    <div class="small mute" style="margin-top:4px">${T('仓库与分支在新建项目时确定，之后不能改。')}</div>`;
  if ($('#psSaveGeneral')) $('#psSaveGeneral').onclick = async () => {
    const title = $('#psTitle').value.trim(), goal = $('#psGoal').value.trim(), doneDefinition = $('#psDone').value.trim();
    if (!title) return toast(T('项目标题不能为空'), true);
    if (!goal) return toast(T('项目目标不能为空'), true);
    if (!doneDefinition) return toast(T('完成定义不能为空'), true);
    if (title !== p.title) { await projAct(p.id, 'rename', { title }, T('已保存')); }
    if (goal !== (p.goal ?? '') || doneDefinition !== (p.done_definition ?? '')) await projAct(p.id, 'goal', { goal, doneDefinition }, T('已保存'));
    else if (title === p.title) toast(T('没有改动'));
  };

  // ② 成员与权限
  const U = (me?.users ?? []).filter((u) => !u.disabled_at), mem = p.members ?? [];
  const cand = U.filter((u) => u.id !== p.owner_id && !mem.some((m) => m.userId === u.id));
  $('#projMembers').innerHTML = `
    <div><b class="small">${T('可见性')}</b></div>
    <div class="row" style="margin-top:4px"><label for="projVis" class="small mute">${T('谁能看到本项目')}</label>
      ${lead ? `<select id="projVis" style="width:auto"><option value="all"${p.visibility === 'members' ? '' : ' selected'}>${T('全体成员可见（本看板的所有用户）')}</option><option value="members"${p.visibility === 'members' ? ' selected' : ''}>${T('仅本项目成员可见')}</option></select>` : `<span>${p.visibility === 'members' ? T('仅本项目成员可见') : T('全体成员可见（本看板的所有用户）')}</span>`}
      <span class="small mute" title="${T('「仅本项目成员可见」时，能看到本项目及其任务的人：项目负责人、下表中的项目成员、管理员，以及本项目的待决事项指定的答复人')}">${p.visibility === 'members' ? T('负责人、项目成员、管理员、被待决事项指定的人可见') : ''}</span></div>
    <div style="margin-top:14px"><b class="small">${T('项目成员')}</b> <span class="small mute">${T('这份名单只管两件事：谁看得见本项目、谁能添加任务。它不决定待决事项发给谁')}</span></div>
    <table class="rt" style="margin-top:6px"><tr><th>${T('成员')}</th><th title="${T('勾选后，该成员可以在本项目「添加任务…」：只需描述要做什么，方案仍由项目负责人批准')}">${T('可添加任务')}</th><th title="${T('给人看的备注：这个人在本项目里负责什么。不影响任何权限，也不决定待决事项发给谁（那由「决策路由」决定）')}">${T('职能说明（仅备注）')}</th><th></th></tr>
      <tr><td>${esc(ownerName)} <span class="tag">${T('负责人')}</span></td><td class="small mute">${T('是')}</td><td class="small mute">—</td><td></td></tr>
      ${mem.map((m) => `<tr${m.disabled ? ' class="off"' : ''}><td>${esc(m.name)}${m.role === 'observer' ? ` <span class="tag">${T('旁观者')}</span>` : ''}${m.disabled ? ` <span class="tag">${T('已停用')}</span>` : ''}</td>
        <td>${lead ? `<input type="checkbox" data-mem-add="${esc(m.userId)}" style="width:auto"${m.canAddTasks ? ' checked' : ''}${m.role === 'observer' ? ` disabled title="${T('旁观者不能添加任务')}"` : ''}>` : (m.canAddTasks ? T('是') : T('否'))}</td>
        <td class="small">${esc(m.note || '—')}${lead ? ` <button class="small ghost" data-mem-note="${esc(m.userId)}">${T('修改')}</button>` : ''}</td>
        <td>${lead ? `<button class="small ghost" data-mem-del="${esc(m.userId)}">${T('移出')}</button>` : ''}</td></tr>`).join('')}
      ${lead && cand.length ? `<tr><td><select id="memUser" style="width:auto" aria-label="${T('成员')}">${cand.map((u) => `<option value="${esc(u.id)}" data-role="${esc(u.role)}">${esc(u.display_name)}${u.role === 'observer' ? T('（旁观者）') : ''}</option>`).join('')}</select></td>
        <td><input type="checkbox" id="memAdd" style="width:auto" aria-label="${T('可添加任务')}"></td><td><input id="memNote" aria-label="${T('职能说明（仅备注）')}" placeholder="${T('备注，例如：产品，提需求并验收面向用户的行为')}" style="width:100%"></td><td><button id="btnMemAdd" class="small">${T('加入')}</button></td></tr>` : ''}</table>
    <div class="small mute" style="margin-top:6px">${lead ? T('表中的每个人都能看到本项目，与是否勾选「可添加任务」无关；「职能说明」只是备注，不影响任何权限。待决事项由谁答复，在左侧「决策路由」里单独设置。') : T('表中的每个人都能看到本项目，与是否勾选「可添加任务」无关；「职能说明」只是备注，不影响任何权限。待决事项由谁答复，由项目负责人在「决策路由」里单独设置。')}</div>`;
  onPick($('#projVis'), (v) => pact('visibility', { visibility: v }, T('可见性已修改')));
  const memOf = (id) => (p.members ?? []).find((m) => m.userId === id);
  $('#projMembers').querySelectorAll('[data-mem-add]').forEach((c) => c.onchange = () => { const m = memOf(c.dataset.memAdd); pact('member', { userId: m.userId, canAddTasks: c.checked, note: m.note }, T('已修改')); });
  $('#projMembers').querySelectorAll('[data-mem-note]').forEach((b) => b.onclick = () => { const m = memOf(b.dataset.memNote); const note = prompt(T('{name} 在本项目的职能说明', { name: m.name }), m.note || ''); if (note !== null) pact('member', { userId: m.userId, canAddTasks: m.canAddTasks, note }, T('已修改')); });
  $('#projMembers').querySelectorAll('[data-mem-del]').forEach((b) => b.onclick = () => { const m = memOf(b.dataset.memDel); if (confirm(T('将 {name} 移出本项目的成员名单？', { name: m.name }))) pact('member', { userId: m.userId, remove: true }, T('已移出')); });
  if ($('#memUser')) { const syncMem = () => { const ob = $('#memUser').selectedOptions[0]?.dataset.role === 'observer'; $('#memAdd').disabled = ob; if (ob) $('#memAdd').checked = false; $('#memAdd').title = ob ? T('旁观者不能添加任务；加入后他可以看到本项目') : ''; }; $('#memUser').onchange = syncMem; syncMem(); }
  if ($('#btnMemAdd')) $('#btnMemAdd').onclick = () => pact('member', { userId: $('#memUser').value, canAddTasks: $('#memAdd').checked, note: $('#memNote').value }, T('已加入'));


  // ④ 预算与上限：闸门（项目总花费的天花板）与本项目新任务的默认上限。
  //    "用了多少"在项目页，"最多用多少"在这里 —— 状态与配置分开放，互相深链（Vercel / Netlify 的形状）。
  const b = p.budget ?? { gate: null, spent: 0, remaining: null, over: false };
  const psRo = !lead || p.status === 'aborted';
  $('#psBudget').innerHTML = `<div class="small mute">${T('这一区管的是"最多花多少"；"已经花了多少"在<a href="{href}">项目页</a>。', { href: `#p/${esc(p.id)}` })}</div>
    <div style="margin-top:12px"><b class="small">${T('项目预算闸')}</b> <span class="small mute">${T('整个项目的花费上限（所有任务的花费加上起草方案花的钱，一起算）。撞到闸门后：不再有新任务开工，正在跑的任务会在下一轮停下来，并给你一条待决事项。默认不设 —— 不设就没有闸门')}</span></div>
    <div class="row" style="margin-top:6px">
      <label for="psBudgetUsd" class="small mute" style="white-space:nowrap">${T('上限（美元）')}</label>
      <input id="psBudgetUsd" type="number" step="0.01" min="0" placeholder="${T('不填 = 不设闸门')}" value="${b.gate === null ? '' : (b.gate / 1e6).toFixed(2)}" style="width:140px" ${psRo ? 'disabled' : ''}>
      ${psRo ? '' : `<button id="psBudgetSave" class="primary">${T('保存')}</button>${savedMark('gate')}<button id="psBudgetClear" class="ghost">${T('撤掉闸门')}</button>`}
      <span class="small ${b.over ? 'bad' : 'mute'}">${b.gate === null ? T('当前没有闸门：花多少都不会被拦住') : b.over ? T('已花 {spent}，<b>已撞闸</b>', { spent: usd(b.spent) }) : T('已花 {spent}，还剩 {left}', { spent: usd(b.spent), left: usd(b.remaining) })}</span>
    </div>
    <div class="small mute" style="margin-top:4px">${T('把闸门改得比已花的还低是允许的 —— 那是让项目尽快停下来的办法（正在跑的那个任务在它下一轮体检时停，不会被半路掐断）。')}<br>${T('改闸门只影响之后的判断，不动任何已经做完的事。')}</div>
    <div style="margin-top:18px"><b class="small">${T('同时开着的任务')}</b> <span class="small mute">${p.parallel ? T('并行开发已开启：依赖满足的任务<b>同时开工</b>（在下面的上限内）；模块任务改不得共享路径') : T('平时一次只做一个；只有开着的任务<b>全都在等人</b>时，系统才会让独立的下一个先跑起来 —— 那段时间本来是白等的')}</span></div>
    ${p.parallel ? `<div class="row" style="margin-top:6px"><span class="small mute">${T('共享路径（骨架定下，对模块任务只读）：{v}', { v: (p.sharedPaths ?? []).map(esc).join(T('、')) || T('（骨架任务的方案批准后在这里列出）') })}</span>${psRo ? '' : `<button id="psParallelOff" class="ghost">${T('关掉并行，改回让路调度（关掉后不能再打开）')}</button>`}</div>` : ''}
    <div class="row" style="margin-top:6px">
      <label for="psMaxOpen" class="small mute" style="white-space:nowrap">${T('最多同时开')}</label>
      <select id="psMaxOpen" style="width:auto" ${psRo ? 'disabled' : ''}>${[1, 2, 3, 4].map((n) => `<option value="${n}"${(p.maxOpen ?? 2) === n ? ' selected' : ''}>${T('{n} 个', { n })}${n === 1 ? T('（串行，一次只做一个）') : ''}${n === 2 ? T('（默认）') : ''}</option>`).join('')}</select>
    </div>
    <div class="small mute" style="margin-top:4px">${T('这里说的"独立"= 它依赖的任务都已经合并了，所以它不用等任何一个正开着的任务。')}
      <br>${T('两个任务同时做，后完成的那个开工时看到的项目分支已经旧了。合并前系统会先<b>把项目分支合进它的分支</b>（一次 git merge），再重跑它自己的验收命令与<b>此刻</b>的全部回归义务（其他已合并任务的验收命令）。这一步是机械的，不调模型；它<b>不改写</b>这个任务已有的提交，你签收时看的那一版仍然在。')}
      <br>${T('合不上（两个任务改了同一处）—— 那个任务<b>不会合并</b>，产物原样留着，你会收到一条待决事项。事项里有冲突的原文，并写明哪一段是这个任务的、哪一段是项目分支上哪个任务带进来的、由谁签的收。你只有三个选择：<b>取这个任务这一侧</b>、<b>取项目分支这一侧</b>、<b>两边都不对</b>。选一侧是<b>一次性的</b>：这一趟所有冲突处都按那一侧定，不能这处按这边、那处按那边（要那样就只能选"两边都不对"）。选完系统重做一次合并，<b>只在冲突的那几处</b>取你选的那一侧，同一文件里没冲突的部分照常合并、不受影响，重跑验收，然后<b>重新找你签收一次</b> —— 合出来的是一份谁都还没签过字的新东西。<b>系统永远不自己决定合并后长什么样</b>，也不让 AI 决定。')}
      <br>${T('合上之后有哪条命令没过，那是另一回事：事项里给失败输出，出路是打回让它自己改、先看清楚经过、或中止这个任务。')}
      <br>${p.parallel ? T('并行开发开着时，这个上限就是<b>同时干活</b>的任务数：模块任务互不等待、同时开工，所以每多开一个，同时花钱的也多一个、合并时撞上的机会也多一份（共享路径只读就是为了少撞）。设成 1 = 暂时一次只做一个，随时可以调回来，契约与只读规则不变；「关掉并行」则改回让路调度、解除只读规则，而且不能再打开。') : T('所以每多开一个，就多一份这种事发生的机会。<b>这不是吞吐旋钮</b>：它换来的只有"A 在等你的时候 B 别干等着"，不会让任何一个任务本身做得更快。')}</div>
    <div style="margin-top:18px"><b class="small">${T('本项目新任务的默认上限')}</b></div>
    <div class="small mute" style="margin-top:2px">${T('下面这张表管的是<b>单个任务</b>各自的上限，与上面的项目预算闸是两回事：闸门管整个项目合计花多少，这张表管每个任务各自最多花多少、跑多久、调几次。')}<br>${T('这里设的是<b>默认值</b>；任务页单独改过的任务，以任务页为准，不受这里影响。改了之后，正在跑的任务在它下一轮体检时按新值算。')}</div>
    <table class="rt" style="margin-top:6px"><tr><th>${T('上限项')}</th><th>${T('当前生效值')}</th><th>${T('这个值来自哪一层')}</th><th>${T('部署默认值')}</th><th></th></tr>
      ${(p.limits ?? []).map((r) => `<tr><td>${esc(T(r.label))}</td><td>${esc(r.valueText)}</td>
        <td class="small ${r.source === 'project' ? '' : 'mute'}">${esc(T((p.layerNames ?? {})[r.source] ?? r.source))}</td>
        <td class="small mute">${esc(r.deployText)}</td>
        <td>${psRo ? '' : `<button class="small ghost" data-lim="${esc(r.key)}" title="${r.source === 'project' ? T('点开后输入一个新的数值，作为本项目新任务的默认（当前 {value}）', { value: esc(r.valueText) }) : T('点开后输入一个新的数值，作为本项目新任务的默认（现在用的是部署默认 {value}）', { value: esc(r.deployText) })}">${r.source === 'project' ? T('改这个值…') : T('设为本项目默认…')}</button>${savedMark(`plim:${esc(r.key)}`)}${r.source === 'project' ? ` <button class="small ghost" data-limclr="${esc(r.key)}" title="${T('删掉本项目的这个设定，回落到部署默认 {value}', { value: esc(r.deployText) })}">${T('清掉（回到 {value}）', { value: esc(r.deployText) })}</button>` : ''}`}</td></tr>`).join('')}
    </table>
    <div class="small mute" style="margin-top:6px">${T('三层取值：部署默认（代码里的内置天花板，只能改代码）→ 项目默认（这一表）→ 任务覆盖（任务页）。下层设了就压过上层；清掉一层就回落到上一层。上限永远不会变成"不限"。')}<br>${T('填多少由你定：系统只挡住 0 和负数（0 的意思是"一分钱都不许花"，不是"不限"），<b>填得比部署默认高也照收</b> —— 这一层就是用来给特别费的项目放宽的。「自动整理线」不是上限：填 0 是关掉整理。')}</div>`;
  if ($('#psParallelOff')) $('#psParallelOff').onclick = () => confirm(T('关掉之后：任务改回"开着的都在等人时才让路"，模块任务也不再被禁止改共享路径。已经开着的任务不受影响。之后不能再打开。确定？')) && pact('parallel', { on: false }, T('已关掉并行开发'));
  onPick($('#psMaxOpen'), (v) => pact('max_open', { n: Number(v) }, T('同时最多开 {n} 个任务', { n: v })));
  if ($('#psBudgetSave')) $('#psBudgetSave').onclick = () => {
    const v = $('#psBudgetUsd').value.trim();
    if (!v) return toast(T('要撤掉闸门请点「撤掉闸门」；留空不会保存'), true);
    if (!(Number(v) > 0)) return toast(T('预算闸要是正数（0 的意思是一分钱都不许花，那不是"不限"）'), true);
    SAVED.set('gate', Date.now()); pact('budget', { usd: Number(v) }, T('预算闸已保存')).then((ok) => { if (!ok) SAVED.delete('gate'); });
  };
  if ($('#psBudgetClear')) $('#psBudgetClear').onclick = () => { if (confirm(T('撤掉「{title}」的预算闸？撤掉后这个项目的花费没有上限，自动化挡位也会掉回「提议」。', { title: p.title }))) pact('budget', { usd: null }, T('预算闸已撤掉')); };
  $('#psBudget').querySelectorAll('[data-lim]').forEach((btn) => btn.onclick = () => {
    const r = (p.limits ?? []).find((x) => x.key === btn.dataset.lim);
    const v = prompt(T('{label}：本项目新任务的默认值\n（部署默认 {deploy}；留空取消）', { label: T(r.label), deploy: r.deployText }), r.project ?? r.deploy);
    if (v !== null && v.trim()) { SAVED.set(`plim:${r.key}`, Date.now()); pact('limit', { key: r.key, value: Number(v) }, T('已保存')).then((ok) => { if (!ok) SAVED.delete(`plim:${r.key}`); }); }
  });
  $('#psBudget').querySelectorAll('[data-limclr]').forEach((btn) => btn.onclick = () => {
    const r = (p.limits ?? []).find((x) => x.key === btn.dataset.limclr);
    if (confirm(T('清掉「{label}」的项目默认值？本项目的新任务将回落到部署默认 {deploy}。', { label: T(r.label), deploy: r.deployText }))) pact('limit', { key: r.key, value: null }, T('已清掉'));
  });

  // ⑤ 自动化：挡位、项目级验收命令、后置签收。
  //    挡位不是一个开关，是四条前提的合取 —— 所以四条前提逐条列出来，缺哪条就显示缺哪条。
  const gears = p.gears ?? {}, pre = p.gearPrereqs ?? [], missing = pre.filter((x) => !x.ok);
  const vc = (p.verifyCommand ?? []).join(' ');
  const def = p.deferredSignoffs ?? [];
  $('#psAuto').innerHTML = `<div style="margin-top:4px"><b class="small" id="psVerifyH">${T('项目级验收命令')}</b> <span class="small mute">${T('在项目分支的一个干净克隆里跑的一条命令（不经 shell：不能有管道、&amp;&amp;、重定向）。选填 —— 不填时"项目达成"完全由你宣布，没有机械核实')}</span></div>
    <div class="row" style="margin-top:6px">
      <input id="psVerify" aria-labelledby="psVerifyH" value="${esc(vc)}" placeholder='${T('例如：node tests/run.mjs --all')}' style="flex:1" ${psRo ? 'disabled' : ''}>
      ${psRo ? '' : `<button id="psVerifySave" class="primary">${T('保存')}</button>`}
    </div>
    <div style="margin-top:18px"><b class="small" id="psSetupH">${T('环境准备')}</b> <span class="small mute">${T('依赖（node_modules、.venv 等）不进仓库，所以每份新工作区、每次项目级验收用的干净克隆里都要重新装一遍。<b>默认是自动的</b>：系统按仓库里的依赖清单（requirements.txt、pyproject.toml、package.json，仓库根或 frontend/、backend/ 等子目录）自己装，你什么都不用填。')}</span></div>
    <div class="small" style="margin-top:4px">${(p.setupCommands ?? []).length ? `<span class="mute">${T('你在下面填了命令，所以不再自动识别，按你填的跑。清空就回到自动。')}</span>`
      : (p.setupAuto ?? []).length ? T('按现在的依赖清单，系统会依次自动跑（在 Linux 沙箱里跑，所以是 Linux 的路径写法；一条失败就停）：{cmds}', { cmds: p.setupAuto.map((c) => `<span class="mono">${esc(c)}</span>`).join(T('；')) })
        : `<span class="mute">${T('仓库里还没有依赖清单，暂时没有要装的；等任务写出 requirements.txt 或 package.json 之后自动生效。')}</span>`}</div>
    <div class="small mute" style="margin-top:8px">${T('只有自动识别不对的时候才需要自己填。填了就<b>整个替换</b>上面那几条自动识别的命令（前端、后端的一起替换，所以要写全）。一行一条，按顺序跑，一条失败就停；不经 shell —— 不能用 <span class="mono">&amp;&amp;</span>、管道、重定向：')}</div>
    <div class="row" style="margin-top:6px">
      <textarea id="psSetup" rows="3" aria-labelledby="psSetupH" placeholder="${T('例如：&#10;python -m venv .venv&#10;.venv/bin/pip install -r requirements.txt')}" style="flex:1" ${psRo ? 'disabled' : ''}>${esc((p.setupCommands ?? []).join('\n'))}</textarea>
      ${psRo ? '' : `<button id="psSetupSave" class="primary">${T('保存')}</button>`}
    </div>
    <div style="margin-top:18px"><b class="small">${T('AI 自己加任务的挡位')}</b></div>
    <div class="small mute" style="margin-top:2px">${T('项目里所有任务都做完之后，系统会对照项目目标与完成定义复盘一次：要么提出下一批任务，要么声明已达成。挡位决定这一批要不要你先批。')}</div>
    <div style="margin-top:8px">
      ${Object.entries(gears).map(([k, g]) => `<label class="item row" style="margin-top:6px;align-items:flex-start">
        <input type="radio" name="psGear" value="${esc(k)}" style="width:auto;margin-top:3px" ${p.gear === k ? 'checked' : ''} ${psRo || (k === 'auto' && missing.length) ? 'disabled' : ''}>
        <span><b>${esc(T(g.label))}</b>${k === 'propose' ? ` <span class="tag">${T('默认')}</span>` : ''}<div class="small mute">${esc(T(g.blurb))}</div></span></label>`).join('')}
    </div>
    <div class="small mute" style="margin-top:6px">${T('切到「预算内自动开工、合并」之前会先让你确认一次。')}</div>
    <div class="item" style="margin-top:8px"><div class="small"><b>${T('「合并」与「交付」是两件事，别混')}</b></div>
      <div class="small mute" style="margin-top:2px">${T('<b>合并</b>＝把做完的任务并进本机这个项目自己的集成分支（仓库 <span class="mono">{repo}</span> 的 <span class="mono">{branch}</span>）。自动挡下它由系统自己做，不问你。', { repo: esc(p.repo), branch: esc(p.branch) })}
        <br>${T('<b>交付</b>＝把那条分支 push 到远端仓库。<b>它永远要你亲自点</b>（项目页的「交付项目」），自动挡一次也碰不到它。')}
        <br>${T('所以自动挡能改的东西全都停在这台机器上的这一条分支里；预算闸决定在你回来之前那条分支上最多发生多少事。')}</div></div>
    <div style="margin-top:10px"><b class="small">${T('「预算内自动开工、合并」的四条前提')}</b> <span class="small mute">${T('四条全都成立才挂得上；其中任何一条之后被撤掉，挡位当场掉回「提议」')}</span></div>
    <table class="rt" style="margin-top:6px"><tr><th></th><th>${T('前提')}</th><th>${T('当前')}</th><th>${T('为什么要它')}</th></tr>
      ${pre.map((x) => `<tr><td>${x.ok ? '✅' : '❌'}</td><td>${esc(T(x.label))}</td><td class="small ${x.ok ? '' : 'bad'}">${esc(T(x.note))}</td><td class="small mute">${esc(T(x.why))}</td></tr>`).join('')}
    </table>
    ${missing.length ? `<div class="small bad" style="margin-top:6px">${T('还差 {n} 条，现在挂不上「预算内自动开工、合并」。', { n: missing.length })}</div>` : ''}
    <div style="margin-top:14px"><b class="small">${T('怎么把它停下来')}</b></div>
    <div class="small mute" style="margin-top:2px">${T('把挡位切回「提议」：已经开工的任务照常做完（不会半路丢掉），但不会再有新任务自动开工，下一次复盘的结果会重新等你批准。要立刻停掉整个项目：<a href="#" id="psToDanger">危险区 → 中止项目</a> —— 那会把所有未完成的任务一并中止且不可恢复，已经合并的改动同样不回滚。')}
      <br>${T('<b>已经合并进项目分支的改动不会自动回滚</b> —— 那是仓库里的事，要撤只能在仓库里撤。所以预算闸才是自动挡真正的边界：它决定了在你回来看之前，最多能发生多少事。')}</div>
    <div style="margin-top:18px"><b class="small">${T('后置签收')}</b></div>
    <div class="small mute" style="margin-top:2px">${T('自动挡下，<b>系统自己加的</b>任务验收通过就直接合并，不再逐个弹签收给你 —— 它们会列在下面等你<b>一次过目</b>。你自己加的任务不受影响，仍然逐个签收。')}<br>${T('<b>这不是一道能否决的关卡：合并已经发生了。</b>它是交付前的最后一次看：逐个点开看产物，觉得不对就添加一个任务去修，或者中止项目 —— 但这里只有"签收"一个动作。')}</div>
    ${def.length ? `<div class="item" style="margin-top:6px"><div class="small">${T('有 {n} 个任务等你一次签收（系统自己加的，验收已通过、已合并）：', { n: def.length })}</div>
      <ul class="small" style="margin:4px 0 0 18px">${def.map((t) => `<li>#${esc(t.order)} <a href="#${esc(t.id)}">${esc(t.title)}</a></li>`).join('')}</ul>
      <div class="row" style="margin-top:8px">${psRo ? '' : `<button id="psSignAll" class="primary">${T('一次签收这些任务')}</button>`}<span class="small mute">${T('交付（push）之前必须先签收它们 —— 交付是这套系统里唯一必须由人点的动作，点「交付项目」时也会提示你一并签收。')}</span></div></div>`
      : `<div class="small mute" style="margin-top:6px">${T('当前没有等你一次签收的任务。（只有「预算内自动开工、合并」挡下、由系统自己加的任务才会出现在这里。）')}</div>`}`;
  if ($('#psToDanger')) $('#psToDanger').onclick = (e) => { e.preventDefault(); setPsPane('danger'); };
  if ($('#psSetupSave')) $('#psSetupSave').onclick = () => pact('setup', { commands: $('#psSetup').value }, $('#psSetup').value.trim() ? T('环境准备命令已保存') : T('已清空'));
  if ($('#psVerifySave')) $('#psVerifySave').onclick = () => pact('verify', { command: $('#psVerify').value.trim() }, $('#psVerify').value.trim() ? T('已保存') : T('已清空'));
  $('#psAuto').querySelectorAll('input[name=psGear]').forEach((r) => r.onchange = () => {
    if (r.value === 'auto' && !confirm(T('把「{title}」切到「预算内自动开工、合并」？\n\n系统会在复盘后直接建任务并开工，不再等你批准；做完的任务验收通过即合并，签收攒起来等你一次签。\n\n它最多能做到哪一步：整个项目的预算闸 {gate}（花到这里就不再开新任务），单个任务各自的上限见「预算与上限」。交付（push）仍然要你亲自点。\n\n怎么收回：随时切回「提议」—— 已经开工的任务照常做完，但不会再有新任务自动开工。已经合并进项目分支的改动不会自动回滚。', { title: p.title, gate: usd(b.gate) }))) { r.checked = false; document.querySelector('input[name=psGear][value=propose]').checked = true; return; }
    pact('gear', { gear: r.value }, T('挡位已切到「{gear}」', { gear: T(gears[r.value]?.label ?? r.value) }));
  });
  if ($('#psSignAll')) $('#psSignAll').onclick = () => { if (confirm(T('一次签收这 {n} 个任务？\n\n签收表示你接受它们的产物。它们已经合并进项目分支了 —— 签收不会撤销任何东西，签收之后就可以交付。\n\n还没看过就先别签：上面每个任务名都能点开看产物。', { n: def.length }))) pact('signoff_all', { tasks: def.map((t) => t.id) }, (r) => (r?.result?.unseen?.length
    ? T('已签收你看到的 {n} 个任务。另有 {m} 个是你打开这一页之后才做完的，还没有签 —— 页面已刷新，看过再签', { n: r.result.accepted, m: r.result.unseen.length })
    : T('已签收 {n} 个任务', { n: r?.result?.accepted ?? def.length }))); };

  // ⑥ 危险区：不可逆或改变归属的动作
  const canAbort = ['proposed', 'active', 'stalled'].includes(p.status), canHand = !['done', 'aborted'].includes(p.status);
  $('#psDanger').innerHTML = !lead && !admin ? '' : `<div class="small mute">${T('这一区的动作不可逆，或者会改变谁对本项目负责。')}</div>
    ${lead ? `<div class="item" style="margin-top:10px"><div class="row"><span><b>${T('中止项目')}</b><div class="small mute">${T('未完成的任务全部中止，它们的待决事项撤回。不可恢复 —— 其中的任务之后也不能再单独恢复。已签收并合并的任务仍然可以交付。')}</div></span><span class="grow"></span>
      ${canAbort ? `<button id="btnProjAbort" class="danger">${T('中止项目')}</button>` : `<span class="small mute">${T('项目已{status}，无需中止', { status: esc(PST_NAME[p.status] ?? p.status) })}</span>`}</div></div>
    <div class="item" style="margin-top:8px"><div class="row"><span><b>${p.archived_at ? T('取消归档') : T('归档')}</b><div class="small mute">${p.archived_at ? T('重新显示在侧栏的「已结束」中。') : `${ended(p.status) ? '' : T('要等项目结束（完成或中止）之后才能归档。')}${T('连同其任务从侧栏隐藏（移入「已归档」）；状态与记录不变，随时可以取消归档。')}`}</div></span><span class="grow"></span>
      ${ended(p.status) ? `<button id="btnProjArchive" class="ghost">${p.archived_at ? T('取消归档') : T('归档')}</button>` : `<span class="small mute">${T('项目进行中')}</span>`}</div></div>` : ''}
    <div class="item" style="margin-top:8px"><div class="row"><span><b>${lead ? T('交接负责人') : T('强制交接负责人')}</b><div class="small mute">${T('把本项目的负责人职责交给另一位成员：他接手待批准的方案、签收与本项目的各项设置。')}${lead ? '' : T('你不是本项目的负责人；管理员可以强制交接。')}${T('执行前会先给你一份变更预览。')}</div></span><span class="grow"></span>
      ${canHand ? `<button id="btnProjHandover">${lead ? T('交接负责人…') : T('强制交接…')}</button>` : `<span class="small mute">${T('项目已结束，无需交接')}</span>`}</div></div>`;
  if ($('#btnProjAbort')) $('#btnProjAbort').onclick = () => { const why = prompt(T('中止项目「{title}」？未完成的任务将全部中止，且不可恢复。\n中止原因（可选）：', { title: p.title })); if (why !== null) pact('abort', { why }, T('项目已中止')); };
  if ($('#btnProjArchive')) $('#btnProjArchive').onclick = () => pact('archive', { archived: !p.archived_at }, p.archived_at ? T('已取消归档') : T('已归档'));
  if ($('#btnProjHandover')) $('#btnProjHandover').onclick = () => { hoState = { from: p.owner_id, to: '', scope: `p:${p.id}`, note: '', thenDisable: false, result: null }; userEdit = null; userPerm = null; pane = 'users'; location.hash = 'settings'; };
}
/** 顶栏的当前位置：项目 › 任务。 */
function renderCtx() {
  const t = tasksCache.find((x) => x.id === cur), p = view === 'task' ? projectOf(cur) : view === 'project' ? projects.find((x) => x.id === curProject) : null;
  const pj = view === 'projset' ? projects.find((x) => x.id === curProject) : null;
  $('#ctx').innerHTML = view === 'inbox' ? T('收件箱') : view === 'report' ? T('状态报告') : view === 'settings' ? T('设置') : view === 'new' ? T('新建项目')
    : view === 'projset' ? `<a href="#p/${esc(curProject)}">${esc(pj?.title ?? T('项目'))}</a> <span class="mute" style="font-weight:400">›</span> ${T('设置')}`
    : view === 'project' ? esc(p?.title ?? T('项目'))
    : `${p ? `<a href="#p/${esc(p.id)}">${esc(p.title)}</a> <span class="mute" style="font-weight:400">›</span> ` : ''}${esc(t?.title ?? '')}`;
}
async function loadMe() {
  try { me = await api('/api/me'); } catch (e) { me = null; toast(T('身份无效：{msg}', { msg: e.message }), true); }
  VIEW_TZ = me?.tz ?? null;
  $('#who').textContent = me ? `${me.display_name} · ${roleName(me.role)}` : T('身份无效');
  document.querySelectorAll('.lead-only').forEach((el) => el.classList.toggle('hide', !me || me.role !== 'lead'));
  document.querySelectorAll('.can-create').forEach((el) => el.classList.toggle('hide', !me || !me.canCreate));
  document.querySelectorAll('.not-observer').forEach((el) => el.classList.toggle('hide', !me || me.role === 'observer'));
  $('#inboxObserver').classList.toggle('hide', !me || me.role !== 'observer');
}
// 容器运行时不在：Docker Desktop 掉了，看板一个字没提，任务就那么不动了
function renderHealth(rt) {
  const hb = $('#healthBar');
  if (!rt || rt.ok !== false) { hb.classList.add('hide'); return; }
  const since = rt.downSince ? fmtWhen(rt.downSince, { date: false }) : null;
  setLive(hb, `${T('<b>沙箱暂时用不了</b>{since}：跑看板的那台服务器上，{cli} 没有在运行。', { since: since ? `<span class="mute">${T('（发现于 {time}）', { time: esc(since) })}</span>` : '', cli: esc(rt.cli ?? 'Docker') })}<br>`
    + T('要改代码、跑测试的步骤先停着 —— <b>不算失败，也不耗重试次数</b>；起草方案、回答问题、签收照常。')
    + T('需要管理员在服务器上把 Docker 启动起来 —— 如果他还不知道，告诉他一声。Docker 起来之后，最多几分钟系统就会自己接着跑，不用再点什么。')
    + `<details class="small" style="margin-top:4px"><summary class="mute">${T('技术细节（给管理员）')}</summary><span class="mono">${esc(String(rt.why ?? ''))}</span></details>`);
  hb.classList.remove('hide');
}
// 部署级急停：所有人看到横幅，管理员在顶栏有开关（复用成员页的设置接口，服务端只认管理员）
function renderPaused(paused, isAdmin) {
  const pb = $('#pauseBar'), b = $('#btnPauseAll');
  if (paused) {
    setLive(pb, T('<b>管理员暂停了全部自动运行</b>：不会开始新的步骤；正在执行的步骤立即停下（AI 正在写的回复直接作废，正在跑的命令跑完为止），不算失败，没写完的改动先存起来，恢复后放回接着做。任务不会被取消。回答问题、签收、看结果照常。只有管理员能恢复，恢复后系统自己接着跑。'));
    pb.classList.remove('hide');
  } else pb.classList.add('hide');
  b.classList.toggle('hide', !isAdmin);
  b.textContent = paused ? T('恢复自动运行') : T('暂停全部');
  b.title = paused ? T('让所有任务接着自动运行') : T('立即停下所有任务的自动运行（不中止任务，随时可以恢复）');
  b.onclick = async () => {
    if (!paused && !confirm(T('暂停全部自动运行？正在执行的步骤立即停下，不算失败；任务不会被取消，恢复后自动接着跑。'))) return;
    b.disabled = true;
    try { await api('/api/users', { action: 'setting', key: 'deploy.paused', value: !paused }); toast(paused ? T('已恢复自动运行') : T('已暂停全部自动运行')); await loadTasks(); }
    catch (e) { toast(e.message, true); } finally { b.disabled = false; }
  };
}
// 给管理员的运行环境提示（不影响使用，只有管理员能处理）
function renderNotices(sqlite) {
  const nb = $('#noticeBar');
  if (!sqlite) { nb.classList.add('hide'); return; }
  setLive(nb, T('<b>建议升级 Node.js（需管理员处理）</b>：服务器现用的 Node {node} 内置的 SQLite {version} 有已知缺陷，多个程序同时写数据库时有极小概率损坏数据库。升级到内置 SQLite {fixed} 或更高版本的 Node 即可，数据无需迁移。', { node: esc(sqlite.node), version: esc(sqlite.version), fixed: esc(sqlite.fixedIn) }));
  nb.classList.remove('hide');
}
async function loadTasks() {
  const { tasks, projects: projs, daemon, daemonInfo, runtime, sqlite, paused, isAdmin, announcement, health } = await api('/api/tasks');
  renderHealth(runtime);
  renderAnnouncement(announcement);
  renderHealthDot(health);
  renderNotices(sqlite);
  renderPaused(!!paused, !!isAdmin);
  daemonOn = !!daemon;
  $('#daemon').textContent = paused ? T('自动运行：已暂停') : daemon ? T('自动运行：开') : T('自动运行：关');
  $('#daemon').title = daemon ? T('守护进程运行中（{mode}）：答复或批准后自动继续运行，并按时处理超时与通知', { mode: daemonInfo?.inProcess ? T('随看板启动') : T('独立进程') })
    : T('未检测到守护进程{beat}：答复或批准后需手动点击「运行」，超时与通知不会自动处理', { beat: daemonInfo?.lastBeatAt ? T('（最近一次心跳：{ago}前）', { ago: ago(daemonInfo.lastBeatAt) }) : '' });
  $('#daemon').style.color = daemon ? 'var(--ok)' : '';
  tasksCache = tasks;
  projects = projs;   // 与任务同一个接口：带"与我有关"标记
}
