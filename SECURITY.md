# Security / 安全

## 报告漏洞 / Reporting a vulnerability

请**不要**在公开 issue 里贴漏洞细节。请用 GitHub 的 **Security → Report a vulnerability**（私密报告）联系维护者。

Please do **not** post vulnerability details in public issues. Use GitHub's **Security → Report a vulnerability** (private reporting) to contact the maintainer.

报告时请**不要**附上任何真实的 API key、令牌或 `.env` 内容。
Never include real API keys, tokens or `.env` contents in a report.

## 支持的版本 / Supported versions

只有最新的发布版本会收到修复。/ Only the latest release receives fixes.

## 设计上的边界 / Security model in brief

- AI 生成的代码只在 Docker 容器里执行：默认断网，内存、进程数、时长都有硬上限，API key 不进容器。
  AI-generated code runs only inside Docker containers: no network by default, hard limits on memory, process count and time, and no API keys inside.
- 联网按项目放行，只允许白名单里的域名，经一个出网代理，名单外的域名在建立连接阶段就被拒绝。
  Network access is granted per project, to allow-listed domains only, through an egress proxy that refuses other domains when the connection is set up.
- 身份就是令牌，库里只存令牌的哈希。团队模式下，浏览器拿到的是一个会话（HttpOnly + SameSite=Strict cookie），闲置或到期失效，退出即作废；写操作还要检查来源，登录有限速。
  Identity is a token, and only its hash is stored. In team mode the browser holds a session (HttpOnly + SameSite=Strict cookie) that expires when idle or at its time limit and is revoked on logout; writes are origin-checked, and logins are rate-limited.
- 看板页面有严格的内容安全策略（只许本站脚本），拼进页面的外来文字有测试逐处核过转义；沙箱对工作区的 `.git` 只读，宿主机上的 git 不执行仓库里的钩子。
  The board ships a strict Content Security Policy (same-origin scripts only), and every place external text is inserted into the page is checked for escaping by tests. The sandbox mounts the workspace `.git` read-only, and git on the host does not run hooks from the repository.
- **不防**：公网暴露（没有多因素认证、没有针对互联网扫描的防护）；XSS 没有经过第三方审计。详见 [docs/deploy-team.md](docs/deploy-team.md)。
  **Not covered:** public internet exposure (no MFA, no hardening against internet-wide scanning); there has been no third-party XSS audit. See [docs/deploy-team.en.md](docs/deploy-team.en.md).
