# 团队模式部署

多人各自从自己的电脑打开看板、各自登录、各做各的事。看板装在团队内网的一台服务器上，放在 **HTTPS 反向代理**之后。**不要放到公网**（原因见文末"它防什么、不防什么"）。

管理员部署一次；之后成员只需要一个地址和一个令牌，不用装任何东西。

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

1. 「设置 → 成员」→ 添加成员（成员 / 旁观者）→ 生成令牌；
2. 把令牌**私下**交给本人（令牌只显示这一次，库里只存哈希）；
3. 本人打开地址、贴令牌登录，之后这台浏览器记住 30 天，右上角「退出登录」。

项目负责人在「项目设置 → 成员与权限」里决定谁能给项目加任务、项目对谁可见。

收回某人的访问：「设置 → 成员」里**停用**他（他的全部令牌立即作废），或给他**重新生成令牌**（旧的立即作废）。

## 4. 管理员在页面上做一次的两件事

- **联网目录**（设置 → 联网目录）：国内服务器建议加上 npm / PyPI 的国内镜像，并勾「新项目默认放行」—— 之后新建的项目一建好就能装依赖，不用每个项目的负责人再勾一次。
- **交付凭证**（设置 → 交付凭证）：要把成果推到 GitHub，就在这里填一个 GitHub 令牌（页面只显示已填 / 未填，值写进服务器的 .env）。推到内网的 Git 服务，用的是服务器上 git 自己的凭证。

## 它防什么、不防什么

**防：**

- **没登录什么都拿不到**：所有 `/api/*` 在路由之前统一要身份（唯一的例外：登录页上显示管理员的显示名，好让新人知道去找谁要令牌）。本机模式里"不带令牌 = 起看板的负责人"这个兜底，在团队模式下**不存在**。
- **别的网站借你的浏览器发请求**：登录 cookie 是 `SameSite=Strict`，写操作还要过 Origin / Sec-Fetch 检查和 JSON content-type；只认 `--public-url` 的主机名（挡 DNS 重绑定，也挡绕过代理直连 IP）。
- **页面脚本偷令牌**：令牌放在 HttpOnly cookie 里，页面脚本读不到。
- **点击劫持**：页面不许被别的站嵌进 iframe。
- **连错令牌刷接口**：同一来源 10 分钟内连错 20 次锁 10 分钟（经代理时按 X-Forwarded-For 算，一个人连错不会锁全员）。
- **权限照旧按人算**：谁能改模型、加人、批方案、签收、交付，都按角色与路由表判，和本机模式同一套。

**不防：**

- **会话就是令牌**：登录 cookie 里放的就是令牌本身，没有另外一份会话。好处是吊销立刻生效；代价是 cookie 被偷等于令牌被偷，没有更短的会话期。
- **页面里真有 XSS 的话**：脚本读不到令牌，但能以当前用户的身份发请求。页面把所有外来文字都转义后才插入，但没有做过专门的 XSS 审计。
- **公网**：没有多因素认证、没有账号锁定策略、没有审计告警、没有针对互联网扫描的防护。所以只放内网。
