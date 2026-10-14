# 团队模式部署

多人各自从自己的电脑打开看板、各自登录、各做各的事。看板装在团队内网的一台服务器上，放在 **HTTPS 反向代理**之后。**不要放到公网**（原因见文末"它防什么、不防什么"）。

管理员部署一次；之后成员只需要一个地址，再加一个邀请链接、一个令牌或自己的 GitHub 账号，不用装任何东西。

## 1. 服务器

按 [deploy-linux.md](deploy-linux.md) 装好：Node、Docker（原生 docker-ce）、沙箱镜像、`.env` 里的模型 key、`node src/cli.mjs init --name <管理员的名字>`，并跑一遍测试。**做到第 5 步（跑测试）为止**，守护进程用下面这条装：

```bash
scripts/daemon.sh install --public-url https://si.example.lan
```

这会起 `node src/cli.mjs web --daemon --team --public-url https://si.example.lan`：

- 仍只监听 `127.0.0.1:7357`，外面的人通过反向代理进来；
- `--public-url` 是大家在浏览器里敲的地址：看板只放行这个主机名（以及本机名），用 https 时登录 cookie 带 `Secure`。

## 2. 反向代理

代理要做四件事：终结 HTTPS、**原样转 `Host`**、追加 `X-Forwarded-For`、**不缓冲**（页面实时刷新靠一条长连接 `/api/events`）。

**Caddy**（内网自签证书，最省事）：

```
si.example.lan {
    tls internal
    reverse_proxy 127.0.0.1:7357 {
        flush_interval -1
    }
}
```

Caddy 默认就原样转 Host、追加 X-Forwarded-For。`tls internal` 用 Caddy 自己的内网 CA；成员的电脑要信任这张根证书（或换成公司已有的证书）。

**nginx**：

```
server {
    listen 443 ssl;
    server_name si.example.lan;
    ssl_certificate     /etc/ssl/si.crt;
    ssl_certificate_key /etc/ssl/si.key;

    location / {
        proxy_pass http://127.0.0.1:7357;
        proxy_set_header Host $host;                                  # 必须：看板按 Host 判来源
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # 登录限速按人算，不按代理算
        proxy_buffering off;                                          # 实时刷新的长连接
        proxy_read_timeout 1h;
    }
}
```

内网 DNS（或各人的 hosts）把 `si.example.lan` 指到这台服务器。

## 3. 给成员开账号

管理员打开 `https://si.example.lan`，用自己的令牌登录（首次：`.superintern/cli-token` 里那一串；只看、不要贴到聊天里）：

两种方式，任选其一：

- **邀请链接（推荐）**：「设置 → 成员」→「邀请链接」→ 选角色（成员 / 旁观者）→ 生成。把链接**私下**发给本人。
  - 链接只能用一次，默认 24 小时内有效（`deploy.invite_hours`）。
  - 本人打开链接、填名字就加入了，浏览器当场登录。页面另给他一枚命令行令牌，只显示一次，换电脑登录或用命令行时要用。
  - 没被用掉的链接可以撤销。
- **直接加人**：「设置 → 成员」→ 添加成员 → 生成令牌，把令牌**私下**交给本人（只显示这一次，库里只存哈希）。本人打开地址、贴令牌登录。

**用 GitHub 登录（可选）**：团队都在一个 GitHub 组织里的话，可以让成员用自己的 GitHub 账号登录，不用发令牌。只放行组织的正式成员（受邀还没接受的不算）。每小时复查一次，离开组织的人会被退出登录。令牌登录照旧可用，管理员自己最好留着令牌登录这条路。

1. 用交付时那个 GitHub App 就行（「设置 → 连接」里的部署级 GitHub App）。在 GitHub 上打开这个 App 的设置页：
   - **General → Identifying and authorizing users → Redirect URI**（旧版界面叫 Callback URL）：填 `https://si.example.lan/api/auth/github/callback`（「设置 → 连接 → 用 GitHub 登录」里显示的那个地址，一字不差）；Allow wildcard matching、Request user authorization (OAuth) during installation、Enable Device Flow 都不勾；
   - **Client secrets → Generate a new client secret**（在 General 页，新版界面挪到了左侧的 Credentials 里）：复制下来，只显示一次。Client ID 在 General 页 About 一栏，形如 `Iv23li…`，不是 App ID；
   - **Permissions & events → Organization permissions → Members**：Read-only。改完到组织的 GitHub Apps 安装页接受新权限。
2. 在「设置 → 连接 → 用 GitHub 登录」里填组织名、Client ID、Client secret。Client secret 和 App 私钥一样加密存进库，之后谁都看不到原文。命令行：
   ```bash
   node src/cli.mjs user setting deploy.github_login_org <组织名>
   node src/cli.mjs cred oauth <App 连接 id> --client-id <Client ID> --secret-file <存着 secret 的文件>
   node src/cli.mjs cred member <某个成员的 GitHub 账号>
   ```
   最后一条不开浏览器就能验证配置：App 装没装在组织上、有没有 Members 权限、这个账号算不算成员。
3. 认人：管理员在「设置 → 成员」里替人填的 GitHub 账号，第一次用 GitHub 登录时直接绑上；成员**自己**填的不算数（不然谁都能把别人的账号填在自己名下），要本人先用令牌登录，在「成员」里点「用 GitHub 验证并绑定」走一遍授权。绑上之后按 GitHub 的内部编号认人，对方在 GitHub 上改名不影响；管理员把某人的 GitHub 账号改成别的，就解除绑定。对不上任何成员的人默认拒绝登录，也可以设成自动建为成员或旁观者（自动建的账号没有命令行令牌）。「设置 → 连接 → 用 GitHub 登录」的状态行会提示还有几个人登不进来。

**登录的期限**：

- 登录之后，浏览器里存的是一个"会话"，不是令牌本身。会话闲置 12 小时失效，最长 7 天（`deploy.session_idle_hours` / `deploy.session_max_days`）。
- 点右上角「退出登录」，这次登录当场作废。
- 新签发的命令行令牌默认 90 天过期（`deploy.cli_token_days`，0 = 不过期）。升级前签发的令牌不过期，页面上会提示建议换新。

**自己的令牌和登录**：每个人都可以在「设置 → 登录与令牌」里管理自己的令牌和登录。

- 能看到每一枚的类型、权限、最后使用的时间和来源地址。
- 能签新令牌，可选只读（只读的只能看，适合大屏和监控脚本）。
- 能逐个吊销，或一键吊销现在这次登录以外的全部。吊销一枚令牌，用它登录的浏览器会一起退出。
- 管理员在同一页还能看到并吊销所有人的。

命令行：`token list | new | revoke`、`invite new | list | revoke`。

项目负责人在「项目设置 → 成员与权限」里决定谁能给项目加任务、项目对谁可见。不想让全员看到的项目，在「新建项目」里就选「仅本项目成员可见」（命令行 `project new … --visibility members`）：建好再改的话，这之间全员都看得到它的标题与目标。

收回某人的访问：「设置 → 成员」里**停用**他（他的全部令牌和登录立即作废），或给他**重新生成令牌**（旧的立即作废）。

## 4. 管理员在页面上做一次的两件事

- **联网目录**（设置 → 联网目录）：国内服务器建议加上 npm / PyPI 的国内镜像，并勾「新项目默认放行」—— 之后新建的项目一建好就能装依赖，不用每个项目的负责人再勾一次。
- **连接**（设置 → 连接）：要把成果推到 GitHub，就在这里加一份 GitHub App（推荐）或令牌。值加密存进库，页面只显示末几位 / 指纹。推到内网的 Git 服务，可以加令牌或 SSH 密钥；都不加时用服务器上 git 自己的凭证。详见 deploy.md「连接」一节。

## 5. 看运行状况、发公告

- **设置 → 运行状况**（只有管理员看得到）：守护进程在不在、Docker 在不在、库和 WAL 多大、最近一次备份和完整性检查、Node 内置的 SQLite 有没有已知缺陷、模型服务商有没有被暂停调用、联网目录里的凭据、时区与节假日、运行期自检，以及「值得看一眼的变化」。每一项标「正常 / 注意 / 有问题」，并写了要做什么。有「注意」或「有问题」时，侧栏这一项带一个小圆点。定期备份的间隔也在这里改。
- **公告**（同一页下方）：发给所有人，看板顶部一条横幅，按原文显示。各人可以收起；改了内容会再出来。
- **存活探针**：`GET /healthz` 不用登录、不看 Host，进程在、库能读就回 `{"ok":true}`（否则 503），不带版本或别的信息。给负载均衡或监控用。
- **升级之后**：开着的旧页面会在顶部提示「看板已经升级」，让人存好正在填的内容再刷新（页面与服务端各带一个构建号，对不上就提示）。

## 6. 时间与日历

- **设置 → 时间与日历**：管理员设**部署时区**（如 `Asia/Shanghai`）和**节假日与调休**。路由表里超时时间「1bd」（一个工作日）什么时候到、值班表几点交接、月度预算哪天翻篇都按部署时区算；没设就按 UTC，中国部署会差 8 小时 —— 运行状况会提示。
- 节假日一行一条：`2026-10-01..2026-10-07 国庆`；调休补班的日子写 `2026-10-11 班`。每年记得补下一年的（过期了运行状况会提示）。
- 每个成员可以在同一页设**自己的时区**，只影响他看到的时刻；看板上的时刻都标了时区。
- **值班代班**：项目设置（或默认决策路由）的值班表下面，「添加代班」—— 某几天整天由某人值，轮换不受影响。每条代班后面写着它替的是谁（那几天按轮换本该谁），对一下日期。
- 值班表要在路由表里用上才起作用：「按决策类型」那一行的接收人加上「值班人（按值班表）」。

## 它防什么、不防什么

**防：**

- **没登录什么都拿不到**：所有 `/api/*` 在路由之前统一要身份（例外只有登录本身要用的几个：登录与退出、接受邀请、用 GitHub 登录的跳转与回调、界面文字、存活探针 `/healthz`，以及登录页上显示的管理员显示名，好让新人知道去找谁要令牌）。本机模式里"不带令牌 = 起看板的负责人"这个兜底，在团队模式下**不存在**。
- **别的网站借你的浏览器发请求**：登录 cookie 是 `SameSite=Strict`，写操作还要过 Origin / Sec-Fetch 检查和 JSON content-type；只认 `--public-url` 的主机名（挡 DNS 重绑定，也挡绕过代理直连 IP）。
- **页面脚本偷令牌**：令牌放在 HttpOnly cookie 里，页面脚本读不到。
- **cookie 被偷**：cookie 里放的是会话，不是令牌本身。会话会闲置失效、到期失效，退出即作废；吊销它的来源令牌，会话跟着失效。
- **点击劫持**：页面不许被别的站嵌进 iframe。
- **往页面里注入脚本**：页面没有内联脚本，CSP 只许本站的脚本文件、不许插件、不许改 `<base>`，请求只发本站（支持 Trusted Types 的浏览器另开 Trusted Types）。另外，每一处拼进页面的外来文字（任务标题、成员名、模型输出……）有测试逐处核过转义，新加一处没转义的，测试就不过。
- **GitHub 登录被人截走回调**：回调里的 state 要和发起登录那个浏览器里的 cookie 对上，还带 PKCE；GitHub 给的用户令牌只用来问"你是谁"，问完当场作废、不落库。
- **连错令牌刷接口**：同一来源 10 分钟内连错 20 次锁 10 分钟（经代理时按 X-Forwarded-For 算，一个人连错不会锁全员）。
- **权限照旧按人算**：谁能改模型、加人、批方案、签收、交付，都按角色与路由表判，和本机模式同一套。

**不防：**

- **页面里仍漏了 XSS 的话**：脚本读不到令牌，但能以当前用户的身份发请求。上面的 CSP 与转义检查是自己做的，没有经过第三方审计；样式仍允许内联（页面里大量用到），注入的样式能改页面的样子。
- **公网**：没有多因素认证、没有账号锁定策略、没有审计告警、没有针对互联网扫描的防护。所以只放内网。
