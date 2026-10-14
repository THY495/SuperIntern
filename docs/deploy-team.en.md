# Team deployment

[中文](deploy-team.md) | **English**

Team members open the web UI from their own computers, log in individually and work on their own items. Deploy it on an intranet server behind an **HTTPS reverse proxy**. **Do not expose it to the public internet**; see "Protection boundaries" at the end of this page for why.

The administrator deploys it once. Members then need only a URL plus an invite link, a token or their own GitHub account, with nothing to install.

## 1. Server

Follow [Linux deployment](deploy-linux.en.md): install Node, Docker (native docker-ce) and the sandbox images, fill in model keys in `.env`, run `node src/cli.mjs init --name <administrator name>`, and run the tests. **Stop after step 5 (running the tests)**, and install the daemon with:

```bash
scripts/daemon.sh install --public-url https://si.example.lan
```

This starts `node src/cli.mjs web --daemon --team --public-url https://si.example.lan`:

- it still listens only on `127.0.0.1:7357`; users connect through the reverse proxy;
- `--public-url` is the address users enter in their browsers. The web UI allows only that hostname (and the local hostname). With https, the login cookie gets the `Secure` attribute.

## 2. Reverse proxy

The proxy must do four things: terminate HTTPS, **preserve `Host`**, append `X-Forwarded-For`, and **disable buffering**. Live page updates use a long-lived `/api/events` connection.

**Caddy** (internal self-signed certificate, the simplest option):

```caddyfile
si.example.lan {
    tls internal
    reverse_proxy 127.0.0.1:7357 {
        flush_interval -1
    }
}
```

Caddy preserves Host and appends X-Forwarded-For by default. `tls internal` uses Caddy's internal CA. Members' computers must trust its root certificate, or you can use an existing company certificate.

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name si.example.lan;
    ssl_certificate     /etc/ssl/si.crt;
    ssl_certificate_key /etc/ssl/si.key;

    location / {
        proxy_pass http://127.0.0.1:7357;
        proxy_set_header Host $host;                                  # required: the web UI checks the origin by Host
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # login rate limits per client, not per proxy
        proxy_buffering off;                                          # long-lived connection for live updates
        proxy_read_timeout 1h;
    }
}
```

Point `si.example.lan` to the server through internal DNS or each person's hosts file.

## 3. Create member accounts

The administrator opens `https://si.example.lan` and logs in with their own token (the first time: the string in `.superintern/cli-token`; read it locally, do not paste it into a chat).

There are two ways; use either:

- **Invite link (recommended):** Settings → Members → "Invitation links" → choose a role (member / observer) → "Create invitation link". Send the link **privately** to that person.
  - A link can be used once and is valid for 24 hours by default (`deploy.invite_hours`).
  - The person opens the link, enters a name and has joined; the browser is logged in on the spot. The page also gives them a CLI token, shown only once, which they need to log in from another computer or to use the CLI.
  - Links that have not been used can be revoked.
- **Add the person directly:** Settings → Members → "Add member" → "Add and generate token", then give the token **privately** to that person (it is shown only this once; the database stores only its hash). The person opens the URL and logs in by pasting the token.

**Sign in with GitHub (optional):** if the team is in one GitHub organization, members can log in with their own GitHub accounts instead of receiving tokens. Only full members of the organization are let in (people invited who have not yet accepted do not count). Membership is rechecked every hour, and people who have left the organization are logged out. Token login keeps working; administrators should keep token login available for themselves.

1. Use the GitHub App you use for delivery (the deployment-wide GitHub App under Settings → Connections). Open that App's settings page on GitHub:
   - **General → Identifying and authorizing users → Redirect URI** (called Callback URL in the older interface): enter `https://si.example.lan/api/auth/github/callback` (the address shown under Settings → Connections → "Sign in with GitHub", exactly as shown). Leave Allow wildcard matching, Request user authorization (OAuth) during installation and Enable Device Flow unchecked;
   - **Client secrets → Generate a new client secret** (on the General page; the newer interface moved it to Credentials on the left): copy it, it is shown only once. The Client ID is in the About section of the General page and looks like `Iv23li…`; it is not the App ID;
   - **Permissions & events → Organization permissions → Members:** Read-only. Afterwards, accept the new permissions on the organization's GitHub Apps installation page.
2. Under Settings → Connections → "Sign in with GitHub", enter the organization name, Client ID and Client secret. The Client secret is stored encrypted in the database like the App private key, and nobody can view the original afterwards. CLI:
   ```bash
   node src/cli.mjs user setting deploy.github_login_org <organization>
   node src/cli.mjs cred oauth <App connection id> --client-id <Client ID> --secret-file <file containing the secret>
   node src/cli.mjs cred member <a member's GitHub account>
   ```
   The last command checks the setup without a browser: whether the App is installed on the organization, whether it has the Members permission, and whether this account counts as a member.
3. Matching people: a GitHub account that an administrator entered for someone under Settings → Members is linked the first time that person logs in with GitHub. An account a member entered **themselves** does not count (otherwise anyone could put someone else's account under their own name); the person must first log in with a token and go through authorization with "Verify and link with GitHub" under Members. Once linked, people are matched by GitHub's internal id, so renaming on GitHub does not matter; if an administrator changes someone's GitHub account to a different one, the link is removed. People who match no member are refused by default; this can be set to create them automatically as members or observers (automatically created accounts have no CLI token). The status line under Settings → Connections → "Sign in with GitHub" shows how many people still cannot log in.

**Login lifetimes:**

- After login, the browser holds a "session", not the token itself. A session expires after 12 hours idle, and lasts at most 7 days (`deploy.session_idle_hours` / `deploy.session_max_days`).
- Clicking "Sign out" at the top right invalidates that login on the spot.
- Newly issued CLI tokens expire after 90 days by default (`deploy.cli_token_days`, 0 = never). Tokens issued before the upgrade do not expire; the page suggests replacing them.

**Your own tokens and logins:** everyone can manage their own tokens and logins under Settings → Sign-ins & tokens.

- You see each one's type, permissions, last use and source address.
- You can issue new tokens, optionally read-only (read-only tokens can only view; good for wall displays and monitoring scripts).
- You can revoke them one by one, or revoke everything except the current login in one click. Revoking a token also logs out the browsers that logged in with it.
- On the same page, administrators can also see and revoke everyone's.

CLI: `token list | new | revoke`, `invite new | list | revoke`.

The project owner decides who can add tasks to a project and who can see it under Project settings → Members & permissions. For a project that should not be visible to everyone, choose "Project members only" already in "New project" (CLI: `project new … --visibility members`): if you change it after creating the project, everyone can see its title and goal in the meantime.

To revoke someone's access: **disable** them under Settings → Members (all their tokens and logins are invalidated immediately), or **regenerate their token** (the old one is invalidated immediately).

## 4. Two administrator settings

- **Network catalog (Settings → Network catalog):** on servers in mainland China, add domestic npm / PyPI mirrors and tick "Allowed by default for new projects". New projects can then install dependencies as soon as they are created, without each project owner enabling them separately.
- **Connections (Settings → Connections):** to push results to GitHub, add a GitHub App (recommended) or a token here. Values are stored encrypted in the database; the page shows only the last few characters / the fingerprint. To push to an internal Git service, add a token or SSH key; if none is added, the server's own git credentials are used. See the [Connections](deploy.en.md#connections-delivery-credentials) section in deploy.en.md.

## 5. System status and announcements

- **Settings → System status** (visible to administrators only): whether the daemon is running, whether Docker is running, the size of the database and WAL, the most recent backup and integrity check, whether Node's bundled SQLite has a known defect, whether calls to a model provider are paused, credentials in the network catalog, time zone and holidays, the runtime self-check, and "Changes worth a look". Each is marked "OK / Attention / Problem" and says what to do. When anything is at "Attention" or "Problem", its entry in the side menu shows a small dot. The interval for regular backups is also changed here.
- **Announcements** (lower on the same page): sent to everyone as a banner at the top of the web UI, shown as written. Each person can dismiss it; it comes back if the content changes.
- **Liveness probe:** `GET /healthz` needs no login and ignores Host. It returns `{"ok":true}` when the process is up and the database can be read (otherwise 503), without a version or any other information. Use it for load balancers or monitoring.
- **After an upgrade:** old pages that are still open show "The board has been upgraded" at the top, asking people to save what they are typing and then reload (the page and the server each carry a build number; a mismatch triggers the notice).

## 6. Time and calendar

- **Settings → Time and calendar:** an administrator sets the **deployment time zone** (such as `Asia/Shanghai`) and **holidays and make-up workdays**. When the "1bd" (one business day) timeout in the routing table is due, when the duty roster hands over and the day monthly budgets roll over all follow the deployment time zone. If it is not set, UTC is used, which is 8 hours off for a deployment in China; System status warns about this.
- Holidays, one per line: `2026-10-01..2026-10-07 国庆`; make-up workdays are written `2026-10-11 班`. Remember to add the next year each year (System status warns when the list has run out).
- Each member can set **their own time zone** on the same page; it affects only the times they see. Times in the web UI are labeled with their time zone.
- **Duty swaps:** below the duty roster in project settings (or the default decision routing), use "Add cover": someone covers whole days, and the rotation is not affected. Each cover says whom it replaces (who would have been on duty on those days by rotation), so you can check the dates.
- The duty roster takes effect only when it is used in the routing table: add "On-call (per rotation)" to the recipients of a "By decision type" row.

## Protection boundaries

**Protections provided:**

- **Nothing is available without logging in:** all `/api/*` routes require an identity before routing (the only exceptions are the few needed for logging in itself: login and logout, accepting an invite, the GitHub login redirect and callback, interface text, the liveness probe `/healthz`, and the administrator's display name shown on the login page so newcomers know whom to ask for a token). Local mode's fallback of treating a request without a token as the owner who started the web UI does **not exist** in team mode.
- **Requests from other websites through your browser:** the login cookie uses `SameSite=Strict`. Writes also require Origin / Sec-Fetch checks and JSON content type. Only the `--public-url` hostname is accepted, protecting against DNS rebinding and direct-IP access that bypasses the proxy.
- **Token theft by page scripts:** the token is in an HttpOnly cookie, which page scripts cannot read.
- **Cookie theft:** the cookie holds a session, not the token itself. Sessions expire when idle and at their time limit, and are invalidated on logout; revoking the token a session came from also ends the session.
- **Clickjacking:** other sites cannot embed the page in an iframe.
- **Script injection into the page:** the page has no inline scripts. The CSP allows only this site's script files, no plugins and no changes to `<base>`, and requests go only to this site (browsers that support Trusted Types also get Trusted Types). In addition, every place where outside text (task titles, member names, model output, …) is inserted into the page has a test that checks its escaping; a new place without escaping makes the tests fail.
- **Intercepted GitHub login callbacks:** the state in the callback must match a cookie in the browser that started the login, and PKCE is used as well. The user token GitHub returns is used only to ask "who are you" and is invalidated right after; it is never stored.
- **Invalid-token attempts:** 20 failed attempts from one source within 10 minutes block that source for 10 minutes. Behind the proxy, the source uses X-Forwarded-For, so one user's failures do not block everyone.
- **Permissions are still per person:** who can change models, add people, approve plans, sign off and deliver is decided by roles and the routing table, the same as in local mode.

**Remaining limitations:**

- **If XSS still slips into a page:** a script cannot read the token, but it can send requests as the current user. The CSP and escaping checks above were done in-house, with no third-party audit. Styles still allow inline use (the page relies on it heavily), so injected styles can change how the page looks.
- **Public internet exposure:** there is no multifactor authentication, account lockout policy, audit alerting or hardening against internet-wide scanning. Deploy on an intranet only.
