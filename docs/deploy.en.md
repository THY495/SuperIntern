# Deployment

[中文](deploy.md) | **English**

The same code supports three deployment setups:

| Setup | Persistent daemon | Guide |
|---|---|---|
| Windows 10/11 + Docker Desktop | Scheduled task: `scripts/daemon.ps1` | This page |
| Linux host | systemd user unit: `scripts/daemon.sh` | [Linux deployment](deploy-linux.en.md) |
| WSL2 | Same as Linux, plus a Windows-side WSL session that stays open | [WSL2 notes](deploy-linux.en.md#wsl2-notes) |

For people logging in from their own computers, see [Team deployment](deploy-team.en.md).

## Shared prerequisites

- Node **≥ 22.13** (for `node:sqlite` without a flag; validated on 24.x) and git.
- A container runtime: Docker or Podman. Podman and rootless Docker have not been validated. The daemon user must have direct access to the Docker socket.
- First installation: run `scripts/setup.ps1` or `scripts/setup.sh`. It checks prerequisites, creates `.env` from `.env.example`, builds `superintern/sandbox:v0.1` and `superintern/sandbox:v0.3-python`, and pulls `mitmproxy/mitmproxy`.

  Per-task egress images named `superintern/sandbox:ca-*` are built automatically on first use. Clean them up with `node src/cli.mjs sandbox --reap`.
- Configure `.env` (mode 600 on Linux; do not commit it):
  - **Model keys:** provide a key for at least one vendor.
  - **`GITHUB_TOKEN`:** needed only to open a PR during delivery.
  - **`NTFY_URL` and similar variables:** deployment-wide notification channels. Individual channels are configured under Settings → Members.

  Check whether a key is set without printing its value: `grep -c '^DEEPSEEK_API_KEY=.' .env`.
- Initialize the database: `node src/cli.mjs init --name YourName`. This issues a CLI token in `.superintern/cli-token`, its only plaintext copy; the database stores a hash. It also chooses light / standard / heavy models based on the keys present in `.env`. Override a binding with `--bind heavy=<provider/model>`.

  If the database already exists, `init` only runs migrations.
- Later, change providers, models and tier bindings in Settings or through the `endpoint`, `catalog` and `bind` commands. Every change is audited.

## Windows: Task Scheduler

```powershell
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 install
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 status   # also start | stop | uninstall
```

- **Task and logs:** the task is named `SuperIntern Daemon` and starts at login. A second trigger runs every five minutes: it does nothing if the process is running, and restarts it if it has died. Logs are in `.superintern/logs/daemon.log`.
- **Launch method:** the scheduled task uses `wscript.exe` to launch `daemon-launch.vbs` in a hidden window. That script starts `node src/cli.mjs web --daemon` and waits for it to exit. This avoids a console window whose closure would kill the process, and avoids the process being killed when Task Scheduler releases the task.
- **Docker Desktop:** keep it running in the logged-in session. If the first task starts before Docker is ready, it fails and enters a five-minute backoff, then recovers automatically.
- **Use one daemon installation per machine:** running both the Windows scheduled task and the WSL2 systemd unit creates a port conflict and two separate databases.

## Web UI

- Local mode listens only on `127.0.0.1:7357`. For remote access, use `ssh -L 7357:127.0.0.1:7357 <host>` and open http://127.0.0.1:7357/ locally.
- In local mode, requests without a token act as the administrator who started the web UI. Other members log in with their own tokens. Adding a person under Settings → Members generates a token that is shown once.
- For direct access from multiple computers, use [Team deployment](deploy-team.en.md).

## Upgrading

1. **Back up:** back up `.superintern/state.db` together with its `-wal` and `-shm` files, since the database uses WAL mode.
2. **Replace the code:** install the new code or run `git pull`.
3. **Migrate:** run `node src/cli.mjs init` once, or any CLI command. Migrations run in order using `PRAGMA user_version` and do not delete data.
4. **Update images:** if the new version changes sandbox image tags, rerun `setup` to build missing images.

## Everyday commands

```bash
node src/cli.mjs digest                 # my to-dos: who answers, who is pending, deadlines
node src/cli.mjs questions              # open questions
node src/cli.mjs answer <qid> "..."      # answer a question
node src/cli.mjs say <task> "..."        # correction / new instruction / extra information
node src/cli.mjs signoff <task> --accept # or --reject "reason"
node src/cli.mjs replay <task>           # reconstruct from the audit log and state database
node src/cli.mjs sandbox --reap         # clean up leftover containers and derived images
node src/cli.mjs bind                   # tier bindings; change with bind set heavy=<provider/model>
node src/cli.mjs endpoint               # providers and key status; endpoint test <id> checks connectivity
node src/cli.mjs catalog check          # catalog drift check; the daemon runs it every 7 days by default
```
