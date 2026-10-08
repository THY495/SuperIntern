# Linux deployment (including WSL2)

[中文](deploy-linux.md) | **English**

For Windows, see [Deployment](deploy.en.md). This guide covers Linux hosts and WSL2. The steps were validated in the following environment:

| Item | Validated environment |
|---|---|
| Distribution | Ubuntu 24.04 LTS on WSL2 |
| Init system | systemd (`[boot] systemd=true` in `/etc/wsl.conf`) |
| Node | 24.x, official tarball |
| Container runtime | Native docker-ce inside the distribution: cgroup v2, systemd driver, overlayfs. Docker Desktop WSL integration also worked |

## Prerequisites

- Node **≥ 22.13**, for `node:sqlite` without a flag. The nodejs package in the validated distribution's apt repositories is too old; use an official tarball or NodeSource.
- git.
- Docker (native dockerd or Docker Desktop WSL integration) or Podman. **The daemon user must have direct access to the Docker socket**, typically through membership in the `docker` group. Podman and rootless Docker have not been validated.

## Installation

```bash
# 1. Put the code on the Linux filesystem.
#    On WSL2, avoid /mnt/c and /mnt/d: drvfs ownership, permissions and performance differ.
tar xzf superintern-v0.3.1-linux.tar.gz && cd superintern-v0.3.1
#    Alternatively: git clone <repository-url> ~/superintern && cd ~/superintern

# 2. Check prerequisites, create .env (mode 600), build sandbox images.
scripts/setup.sh

# 3. Fill in keys. Check presence without printing values: grep -c '^DEEPSEEK_API_KEY=.' .env
nano .env

# 4. Initialize the database, issue a CLI token and select models for the keys provided.
#    The only plaintext token copy is .superintern/cli-token (mode 600).
node src/cli.mjs init --name YourName

# 5. Run tests. The container and egress suites need Docker running.
node tests/run.mjs --all

# 6. Install the systemd user unit: starts at boot, restarts 30 seconds after exit.
#    Logs: .superintern/logs/daemon.log
scripts/daemon.sh install          # team mode: scripts/daemon.sh install --public-url https://si.example.lan
scripts/daemon.sh status
```

For a temporary foreground run without installing a unit, use `scripts/start.sh`.

The unit file is `~/.config/systemd/user/superintern-daemon.service`. Installation also runs `loginctl enable-linger`; otherwise logging out or disconnecting SSH stops the user manager and daemon.

### When the host cannot reach Docker Hub

Building sandbox images downloads `node:22-slim` and apt packages, about 400 MB including Chromium. If the target cannot connect, or downloads are too slow, build the images on a connected machine and transfer them:

```bash
# On a connected machine, run setup first to build the images.
docker save node:22-slim mitmproxy/mitmproxy:latest superintern/sandbox:v0.1 superintern/sandbox:v0.3-python -o images.tar
# On the target machine:
docker load -i images.tar
```

### Three deliberate unit settings

- **`KillMode=process`:** the daemon exits when its `--iterations` limit is reached and `Restart=always` starts it again. Detached task subprocesses must survive this periodic restart. The default control-group mode would kill active tasks whenever the daemon restarts. As a result, `daemon.sh stop` does not stop active tasks; use CLI pause / abort for those.
- **`ExecStartPre=scripts/wait-docker.sh`:** user units cannot see system units, so `After=docker.service` would not help. At distribution startup, Docker may not be ready. The pre-start command waits up to three minutes for the runtime.
- **The web UI binds only to 127.0.0.1:** use `ssh -L 7357:127.0.0.1:7357 <host>` for remote access, or [team mode](deploy-team.en.md).

### Join the docker group before installing the unit

The systemd user manager (`systemd --user`) starts at the first login and fixes its supplementary groups at that point. Services it starts inherit those groups. If the user joins `docker` after the manager is already running:

- the daemon started by `daemon.sh install` can fail with `permission denied ... docker.sock`;
- `docker ps` can still work in an interactive shell.

Check whether the Docker group's GID appears in `grep Groups /proc/$(pgrep -u $USER -x systemd | head -1)/status`.

If it does not, restart the user manager by logging out and back in, disabling linger first so the manager really stops. On WSL2, use `wsl --shutdown`.

Use this order: add the user to the docker group, log in again, then install the unit.

## WSL2 notes

- **`/etc/wsl.conf`:** set `[boot] systemd=true` and `[user] default=<user>`, then run `wsl --shutdown` to apply the changes.
- **Installing docker-ce inside the distribution is recommended by this deployment guide** (`systemctl enable --now docker`). This removes the dependency on Windows-side software and lets the distribution move to a Linux host without changes. Docker Desktop WSL integration also works, but Docker Desktop must be running in the Windows login session. The group-membership and startup-order problems described above were observed with that integration.
- **Do not enable both runtimes at once:** the integration adds a link at `/usr/bin/docker`. Before installing docker-ce, disable the integration and remove any dangling link.
- **Image downloads:** in NAT mode, WSL may not reach a local proxy on Windows, preventing access to Docker Hub. Use the save / load procedure above.
- **Keeping WSL running:** in the validated setup, the distribution did not start automatically at Windows login and stopped about eight seconds after the last wsl.exe session exited, even with systemd enabled. Keep a Windows-side session open with `wsl.exe -d Ubuntu-24.04 --exec sleep infinity`, launched in a hidden window by a scheduled task triggered at login. This handles startup and persistence. A native Linux host does not need this step.
- **Opening the web UI:** open http://127.0.0.1:7357/ from Windows; WSL2 forwards localhost. Do not also install the Windows scheduled-task daemon: the two instances would compete for the port and maintain separate databases.
- **Host uid:gid for containers (`--user`):** this is the Linux-specific code path compared with Windows. Without it, files written to bind-mounted workspaces would be owned by root:root, and the daemon could encounter EACCES during `git add` or workspace cleanup.

## Everyday operations

```bash
scripts/daemon.sh status           # also start | stop | uninstall
tail -f .superintern/logs/daemon.log
node src/cli.mjs sandbox --reap     # clean up leftover containers
```

## Known limitations

- **Podman and rootless Docker have not been validated.** Cgroup assertions in the container tests may behave differently under rootless runtimes.
- **Proxy images accumulate:** each task creates a `superintern/sandbox:ca-*` tag and these are not removed automatically. They share layers and each adds only a few hundred KB, but the list grows. To remove them:

  ```bash
  docker images --format '{{.Repository}}:{{.Tag}}' superintern/sandbox | grep ':ca-' | xargs docker rmi
  ```
