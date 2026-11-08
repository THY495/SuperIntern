# Linux deployment (including WSL2)

[中文](deploy-linux.md) | **English**

For Windows, see [Deployment](deploy.en.md). This guide covers installation on Linux hosts and WSL2. The following environment has been validated:

| Item | Validated environment |
|---|---|
| Distribution | Ubuntu 24.04 LTS on WSL2 |
| Init system | systemd (`[boot] systemd=true` in `/etc/wsl.conf`) |
| Node | 24.x, official tarball |
| Container runtime | Native docker-ce inside the distribution: cgroup v2, systemd driver, overlayfs. Docker Desktop WSL integration also worked |

## Prerequisites

- Node **≥ 22.13**, for `node:sqlite` without a flag. The nodejs package in apt is too old; use an official tarball or NodeSource.
- git.
- A container runtime: Docker (native dockerd or Docker Desktop WSL integration) or Podman. **The daemon user must have direct access to the Docker socket**, that is, be in the `docker` group.

## Installation

```bash
# 1. Put the code on the Linux filesystem.
#    On WSL2, avoid /mnt/c and /mnt/d: drvfs ownership, permissions and performance differ.
tar xzf superintern-v0.5.0-linux.tar.gz && cd superintern-v0.5.0
#    Alternatively: git clone <repository-url> ~/superintern && cd ~/superintern

# 2. Check prerequisites, create .env (mode 600), build sandbox images.
scripts/setup.sh

# 3. Fill in keys. Check presence without printing values: grep -c '^DEEPSEEK_API_KEY=.' .env
nano .env

# 4. Initialize the database, issue a CLI token (the only plaintext copy is .superintern/cli-token, mode 600) and select models for the keys provided.
node src/cli.mjs init --name <your name>

# 5. Run tests (the container and egress suites need Docker running; the a11y suite needs Chromium, see "Browser for the accessibility (a11y) tests" below; without it, add --without browser).
node tests/run.mjs --all

# 6. Daemon = systemd user unit: starts at boot, restarts 30 seconds after exit, logs in .superintern/logs/daemon.log.
scripts/daemon.sh install          # team mode: scripts/daemon.sh install --public-url https://si.example.lan
scripts/daemon.sh status
```

For a temporary foreground run without installing a unit, use `scripts/start.sh`.

The unit file is `~/.config/systemd/user/superintern-daemon.service`. `install` also runs `loginctl enable-linger`; otherwise logging out or disconnecting SSH stops the user manager together with the daemon.

### Browser for the accessibility (a11y) tests

The a11y suite opens the web UI in headless Chromium and checks it. The tests look for a browser in common locations such as `/usr/bin/chromium`, `/usr/local/bin/chromium` and `google-chrome`; you can also set the path with `SUPERINTERN_CHROME`. On machines without a browser, add `--without browser` to skip it (the skip is listed as such, not counted as a pass).

On Ubuntu 24.04, `chromium` is available only as a snap. In WSL2 (where the kernel does not enable AppArmor), installing Chromium from snap hangs at "Process delayed security backend side effects". Use Chrome for Testing instead: the Chromium build Google publishes for automated testing, shipped as a zip file:

```bash
V=155.0.8059.39   # current stable version: https://googlechromelabs.github.io/chrome-for-testing/
curl -fLO https://storage.googleapis.com/chrome-for-testing-public/$V/linux64/chrome-linux64.zip
sudo mkdir -p /opt/chrome-for-testing && sudo unzip -q chrome-linux64.zip -d /opt/chrome-for-testing/$V
sudo ln -sfn /opt/chrome-for-testing/$V/chrome-linux64/chrome /usr/local/bin/chromium
# System libraries it depends on, plus CJK fonts (without them, Chinese text shows as boxes and button sizes differ from real use)
sudo apt-get install -y libnss3 libasound2t64 libatk-bridge2.0-0t64 libcups2t64 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 fonts-noto-cjk
ldd /opt/chrome-for-testing/$V/chrome-linux64/chrome | grep "not found"   # should print nothing
```

If downloading from storage.googleapis.com is too slow, download the same file from a mirror and compare it with the official checksum: `curl -sI <official URL> | grep x-goog-hash` gives the md5 (base64); compute it locally with `openssl dgst -md5 -binary chrome-linux64.zip | base64`. The two should match.

### When the host cannot reach Docker Hub

Building sandbox images downloads `node:22-slim` and installs apt packages over the network, about 400 MB including Chromium. If the target machine cannot connect, or downloads are too slow, build the images on a connected machine and transfer them:

```bash
# On a connected machine (run setup there first to build the images)
docker save node:22-slim mitmproxy/mitmproxy:latest superintern/sandbox:v0.1 superintern/sandbox:v0.3-python -o images.tar
# On the target machine
docker load -i images.tar
```

### Three deliberate unit settings

- **`KillMode=process`:**
  - **Why:** the daemon exits when its `--iterations` limit is reached and `Restart=always` starts it again; this periodic restart is deliberate. The run subprocesses it starts are detached and must outlive one daemon lifetime. The default control-group mode would kill active tasks whenever the daemon restarts.
  - **Cost:** `daemon.sh stop` does not stop active tasks. To stop tasks, use CLI pause / abort.
- **`ExecStartPre=scripts/wait-docker.sh`:**
  - **Why:** user units cannot see system units, so `After=docker.service` would not help. The unit starts as soon as the distribution starts, when Docker may not be ready yet.
  - **What it does:** before starting, it waits for the runtime to become available, for up to three minutes.
- **The web UI binds only to 127.0.0.1:**
  - **Remote access:** use an SSH tunnel `ssh -L 7357:127.0.0.1:7357 <host>`, or team mode ([Team deployment](deploy-team.en.md)).

### Join the docker group before installing the unit

The systemd user manager (`systemd --user`) starts at the user's first login and fixes its supplementary groups at that point; services it starts later inherit those groups. If the user joins the `docker` group after the user manager is already running:

- the daemon started by `daemon.sh install` cannot reach the socket and reports `permission denied ... docker.sock`;
- yet `docker ps` works in an interactive shell.

How to check: see whether the docker group's GID appears in the output of `grep Groups /proc/$(pgrep -u $USER -x systemd | head -1)/status`.

If it does not, restart the user manager by logging out and back in (disable linger first, or it does not really restart). On WSL2, use `wsl --shutdown`.

**Use this order and the problem does not occur:** add the user to the docker group, log in again, then install the unit.

## WSL2 notes

- **`/etc/wsl.conf`:** set `[boot] systemd=true` and `[user] default=<user>`, then run `wsl --shutdown` to apply the changes.
- **Installing the container runtime inside the distribution is recommended** (docker-ce, `systemctl enable --now docker`):
  - This removes the dependency on any Windows-side software, and the distribution can move to a real Linux host without changes.
  - Docker Desktop WSL integration also works, but Docker Desktop must be running in the Windows login session. The docker-group and startup-order problems described above both come from this integration layer.
  - Do not enable both at once: the integration adds a link at `/usr/bin/docker`. Before installing docker-ce, disable the integration and remove the dangling link.
- **Image downloads fail:** in NAT mode, WSL may not reach a local proxy on Windows, so the distribution cannot connect to Docker Hub. Move the images with save / load as described above.
- **Keeping WSL running:** the distribution does not start automatically at Windows login, and about eight seconds after the last wsl.exe session exits the whole distribution stops, even with systemd enabled; the daemon stops with it.
  - **What to do:** keep a Windows-side session open with `wsl.exe -d Ubuntu-24.04 --exec sleep infinity` (launched in a hidden window). Run this command from a scheduled task triggered at login; that handles both automatic startup and staying running.
  - A real Linux host does not have this problem.
- **Opening the web UI:** open http://127.0.0.1:7357/ directly from Windows (WSL2 forwards localhost). **Do not also install the Windows scheduled-task daemon:** the two would compete for the port and each maintain its own database.
- **Containers run as the host's uid:gid (`--user`):**
  - This is the only code-path difference between a Linux host and Windows.
  - Without it, files the container writes into the workspace (a bind mount) would be owned by root:root, and the daemon's later `git add` or workspace cleanup would fail with EACCES.

## Everyday operations

```bash
scripts/daemon.sh status | start | stop | uninstall
tail -f .superintern/logs/daemon.log
node src/cli.mjs sandbox --reap        # clean up leftover containers
```

## Known limitations

- **Podman and rootless Docker have not been validated.** Cgroup assertions in the container tests may behave differently under rootless runtimes.
- **Proxy images accumulate:** the egress proxy creates a `superintern/sandbox:ca-*` tag for each task, and these are not cleaned up automatically during normal use. They share layers and each adds only a few hundred KB, but the list keeps growing. Clean them up with `node src/cli.mjs sandbox --reap` (it also removes leftover containers).
