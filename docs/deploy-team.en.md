# Team deployment

[中文](deploy-team.md) | **English**

Team members open the web UI from their own computers, log in individually and work on their own items. Deploy it on an intranet server behind an **HTTPS reverse proxy**. **Do not expose it to the public internet**; see the protection boundaries below.

The administrator deploys it once. Members then need only a URL and a token, with nothing to install.

## 1. Server

Follow [Linux deployment](deploy-linux.en.md) through **step 5, running the tests**: install Node, native docker-ce and sandbox images, fill in model keys in `.env`, and run `node src/cli.mjs init --name YourName`. Install the daemon with:

```bash
scripts/daemon.sh install --public-url https://si.example.lan
```

This starts `node src/cli.mjs web --daemon --team --public-url https://si.example.lan`:

- it still listens only on `127.0.0.1:7357`; users connect through the reverse proxy;
- `--public-url` is the address users enter in their browsers. The web UI allows that hostname and local hostnames. HTTPS sets the login cookie's `Secure` attribute.

## 2. Reverse proxy

The proxy must terminate HTTPS, **preserve `Host`**, append `X-Forwarded-For`, and **disable buffering**. Live page updates use a long-lived `/api/events` connection.

**Caddy**, using an internal certificate authority:

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
        proxy_set_header Host $host;                                 # required for host checks
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; # rate limits per client
        proxy_buffering off;                                        # live event stream
        proxy_read_timeout 1h;
    }
}
```

Point `si.example.lan` to the server through internal DNS or each person's hosts file.

## 3. Create member accounts

The administrator opens `https://si.example.lan` and logs in using the token from `.superintern/cli-token`. Read it locally; do not paste it into a chat.

1. Open Settings → Members, add a member or observer, and generate a token.
2. Give the token **privately** to that person. It is shown only once; the database stores only its hash.
3. The member opens the URL and logs in with the token. The browser remembers it for 30 days. Log out using the control at the top right.

The project owner sets who can add tasks and who can see the project under Project settings → Members and permissions.

To revoke access, **disable** the member under Settings → Members, immediately invalidating all their tokens, or **regenerate their token**, immediately invalidating the old one.

## 4. Two administrator settings

- **Network catalog (Settings → Network catalog):** on servers in mainland China, add domestic npm / PyPI mirrors and select the option to allow them by default for new projects. New projects can then install dependencies without each owner enabling those domains separately.
- **Delivery credentials (Settings → Delivery credentials):** enter a GitHub token to push results to GitHub. The UI displays only set / not set; the value is written to the server's `.env`. For an internal Git service, delivery uses the server's Git credentials.

## Protection boundaries

### Protections provided

- **Authentication:** all `/api/*` routes require an identity before routing, except the administrator's display name shown on the login page so newcomers know whom to ask for a token. Team mode does not use local mode's fallback of treating a request without a token as the administrator.
- **Requests from other websites:** the login cookie uses `SameSite=Strict`. Writes also require Origin / Sec-Fetch checks and JSON content type. Host checks use the `--public-url` hostname, protecting against DNS rebinding and direct-IP access that bypasses the proxy.
- **Token access from page scripts:** the token is in an HttpOnly cookie, which page scripts cannot read.
- **Clickjacking:** other sites cannot embed the page in an iframe.
- **Invalid-token attempts:** 20 failed attempts from one source within 10 minutes block that source for 10 minutes. Behind the proxy, the source uses X-Forwarded-For so one user's failures do not block everyone.
- **Permissions:** model changes, adding people, plan approval, sign-off and delivery use the same roles and decision routing as local mode.

### Remaining limitations

- **The session is the token:** the login cookie contains the token itself, with no separate session. Revocation takes effect immediately, but a stolen cookie is a stolen token, without a shorter session lifetime.
- **XSS:** a malicious page script could act as the current user even though it cannot read the token. The UI escapes external text before insertion, but no dedicated XSS audit has been performed.
- **Public internet exposure:** there is no multifactor authentication, account lockout policy, audit alerting or hardening against internet-wide scanning. Deploy on an intranet only.
