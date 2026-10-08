# SuperIntern

[中文](README.md) | **English**

SuperIntern is a self-hosted autonomous coding agent that runs for long periods on your own machine or server. You hand it an idea. It asks about anything that is unclear, breaks the work into steps, writes code in a container sandbox and runs the acceptance checks. Then it brings the result to you for sign-off. **You only do four things: answer its questions, make trade-offs, request changes and stop it.** When several people work together, a *decision routing table* decides who gets the final say on each kind of decision.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![version](https://img.shields.io/badge/version-0.2.0-orange)
![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-green)
![deps](https://img.shields.io/badge/npm%20dependencies-0-brightgreen)

> The web UI and the CLI are available in **English and Chinese**. Each person picks their own interface language (top right of the board). An admin sets the team's *content language* under Settings → Members: the language of open items, reports and everything the AI writes for people. Documentation other than this README is in Chinese.

---

## Contents

- [Scope](#scope)
- [What it does](#what-it-does)
- [Quick start](#quick-start)
  - [Windows](#windows)
  - [Linux](#linux)
  - [First visit](#first-visit)
- [Multiple users](#multiple-users)
- [Running it permanently](#running-it-permanently)
- [CLI](#cli)
- [Cost](#cost)
- [Security notes](#security-notes)
- [Tests](#tests)
- [Repository layout](#repository-layout)
- [License](#license)

## Scope

**Good fit:** individuals or small teams handing well-scoped, small-to-medium development tasks to an agent on a machine they control, such as a new small app or features and tests for an existing repo, while they only make decisions.
**Not a good fit:** large legacy codebases, tasks that need several days of continuous reasoning, or exposing it to strangers on the public internet.

See [docs/known-limits.md](docs/known-limits.md) (Chinese) for known gaps.

## What it does

- **Starts from an idea.** An *elicitor* asks about what is unclear, then writes a *draft*: goal, scope, definition of done, allowed paths and acceptance command. Once a human approves the draft, the agent cannot change it.
- **Projects and tasks.** A project has a goal and a definition of done. Its tasks form a dependency graph, and a task starts only after the tasks it depends on are merged. Delivered projects can keep adding tasks and iterating.
- **Parallel development (experimental).** Available when you create a project from a written plan. The system first runs a skeleton task that fixes the interface contract between modules, a stub for each module and the shared files. Once it is merged, the module tasks are developed at the same time, each changing only its own directory; shared files are read-only for them (changing one needs a plan change approved by a person). A final integration task connects the real modules and runs end to end. At planning time the system checks that the skeleton task names every interface in the spec, and it checks the contract file again when the skeleton is done. Off by default; you can turn it off later in project settings (back to one task at a time), but once off it cannot be turned on again.
- **Sandboxed execution.** Every step runs in a Docker container with no network by default. Network access is granted per project, to allow-listed domains only (npm, PyPI and so on; mirrors can be added). Node and Python projects are supported.
- **Mechanical checks plus a model reviewer.** Each step hands over a record that the system checks mechanically: did it touch only allowed paths, and does the acceptance command really pass? A second model then scores the step and sends it back if needed.
- **Asks instead of guessing.** When the spec is silent on a trade-off, the agent raises a question and suspends only the affected branch. Questions carry a default answer and a deadline. The small decisions it makes on its own are collected into an "AI decided a few things for you" review for the right person.
- **Shows the result.** The task page shows the step graph, a screenshot of the built page taken inside the sandbox, and a line-by-line diff (unified or side by side).
- **Multi-user collaboration.** The decision routing table sets, for each kind of decision (spec trade-off, structural conflict, plan approval, sign-off, limit raise, network access, delivery…):
  - who answers;
  - how many must agree;
  - what happens on disagreement;
  - what happens on timeout.

  It ships with six templates. People can second an answer, abstain ("not mine") or hand an item over. Sign-off can go to the person who asked for the feature, or require everyone.
- **Hard limits on money and time.** Cost, wall time, call count and retries all have hard limits. At a limit, it stops and asks a human. It never quietly dies and never quietly continues.
- **A checklist before delivery.** Before pushing, it lists the commits, the changes each task brought in, and risks (for example, no project-level acceptance command). It pushes to any git remote and can open a GitHub PR. **Delivery is the one step a human must always click.**
- **Multiple model vendors.** DeepSeek, Anthropic, OpenAI, Gemini and OpenRouter are built in, and you can add any OpenAI-compatible endpoint. Three tiers (light / standard / heavy) can each be bound to any model. A catalog check detects price and context-window drift.
- **Auditable.** All state lives in one SQLite database, and every action is audited. The process can die at any time and resume. `replay` reconstructs a task from the audit log alone.
- **Notifications.** ntfy, Feishu, DingTalk, WeCom or any shell command, sent per person, plus periodic to-do digests.
- **English and Chinese.** Interface language per person; content language (items, reports, what the AI writes for people) per team. Answers are understood in either language.
- **Zero npm dependencies.** It uses only Node built-ins, including `node:sqlite`. The web UI is a single page with no build step.

## Quick start

### Prerequisites

| Need | Notes |
|---|---|
| Node.js **≥ 22.13** | Needs the built-in `node:sqlite`. Tested on 24.x |
| git | |
| Docker (running) | Docker Desktop on Windows, in its default Linux-containers mode (if you switched to Windows containers, right-click the tray icon → Switch to Linux containers); docker-ce on Linux. **Without a container runtime, tasks will not run.** SuperIntern never falls back to running code on the host |
| An API key for at least one model vendor | [DeepSeek](https://platform.deepseek.com/) / [Anthropic](https://console.anthropic.com/) / [OpenAI](https://platform.openai.com/) / [Gemini](https://aistudio.google.com/) / [OpenRouter](https://openrouter.ai/), or any OpenAI-compatible endpoint |

**Download:** get `superintern-v0.2.0-windows.zip` or `superintern-v0.2.0-linux.tar.gz` from [Releases](../../releases) and extract it, or `git clone` this repo. No `npm install` needed.

> Run every command from the extracted directory. Runtime state (database, tokens, logs, workspaces) lives in `.superintern/` inside it.

### Windows

```powershell
# 1. Check prerequisites, create .env from .env.example, build sandbox images (first time takes a few minutes)
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# 2. Put at least one vendor key in .env
notepad .env
# 3. Create the database, issue your admin token, pick models for the vendor whose key you filled in
node src/cli.mjs init --name YourName
# 4. Start the web UI and the task scheduler loop (foreground; closing the window stops it; to start at login see "Running it permanently")
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
```

### Linux

```bash
# Your user must be able to use docker directly (member of the docker group; log in again after adding)
scripts/setup.sh                        # 1. prerequisites, .env, sandbox images
nano .env                               # 2. at least one vendor key (setup already set mode 600)
node src/cli.mjs init --name YourName   # 3. database, admin token, model tiers
scripts/start.sh                        # 4. web UI + task scheduler, foreground (Ctrl+C stops)
```

The first sandbox image build downloads about 400 MB from Docker Hub and the Debian mirrors (including Chromium for screenshots). On a slow network this can take tens of minutes. If the machine cannot reach them, build the images elsewhere and copy them over; see [deploy-linux.md](docs/deploy-linux.md#主机够不着-docker-hub-时) (Chinese).

`setup` is safe to re-run. It never overwrites `.env`, never rebuilds existing images and never touches an existing database. When it checks `.env`, it only reports which keys are set, never their values.

> Fill in keys **before** `init`: `init` picks the tier models for the vendor whose key is present. If you add keys later or switch vendors, change the models under Settings → 模型分配 (model assignment).

### First visit

Open **http://127.0.0.1:7357/**. In local mode there is no login: you are the admin.

1. **设置 → 服务商** (Settings → Providers): check your key is set (you can also paste it here; it is written only to `.env`) and click 测试 (Test).
2. **设置 → 模型分配** (model assignment): make sure all three tiers use models from a vendor you have a key for.
3. **新建** (New): write the project goal and definition of done, and choose a repository (new empty repo, local path or git URL).
4. In the **收件箱** (inbox), answer its questions and approve the draft. It will come back to you for sign-off.
5. When the project is done, the inbox shows it as waiting for delivery. Review the checklist on the project page and click 交付项目 (Deliver).

## Multiple users

- **Local mode (default).** The web UI listens on `127.0.0.1` only. Add people under Settings → 成员 (Members), which issues tokens. Others connect over an SSH tunnel (`ssh -L 7357:127.0.0.1:7357 <host>`) and log in with their own token.
- **Team mode.** Put the web UI on an intranet server behind an HTTPS reverse proxy, and everyone logs in from their own computer:

  ```bash
  scripts/start.sh --public-url https://si.example.lan
  ```

  For the reverse proxy config (Caddy / nginx), creating accounts, and what team mode does and does not protect against, see [docs/deploy-team.md](docs/deploy-team.md) (Chinese). **Do not expose it to the public internet.**

In both modes, permissions attach to *decisions*, not people. Go to Project settings → 决策路由 (decision routing), pick a template and adjust it.

## Running it permanently

The `start` scripts run in the foreground. To start at login or boot and restart after a crash:

- **Windows:** Task Scheduler. Run `powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 install` (also `status | start | stop | uninstall`).
- **Linux:** a systemd user unit. Run `scripts/daemon.sh install` (add `--public-url https://…` for team mode).

Details, including WSL2, are in [docs/deploy.md](docs/deploy.md) and [docs/deploy-linux.md](docs/deploy-linux.md) (both Chinese).

## CLI

Everything in the web UI is also available as a CLI command. Run `node src/cli.mjs` with no arguments for the full usage. Common ones:

```bash
node src/cli.mjs --version
node src/cli.mjs digest                          # my to-dos
node src/cli.mjs questions                       # open questions
node src/cli.mjs answer <question id> "..."
node src/cli.mjs say <task id> "..."              # correction / new instruction / extra info
node src/cli.mjs signoff <task id> --accept       # or --reject "reason"
node src/cli.mjs project deliver <project id> --remote <git url> [--pr]
node src/cli.mjs replay <task id>                 # reconstruct from the audit log
node src/cli.mjs catalog check                   # model catalog drift check
node src/cli.mjs sandbox --reap                  # clean up leftover sandbox containers
```

## Cost

Cost depends on the models you bind and the size of the task. Try a small task first to see what it costs before handing over larger ones.

Each task has a cost limit ($5 by default). A project can also have an overall budget, which is off by default; set it under Project settings → 预算与上限 (budget and limits). At a limit, SuperIntern asks the owner whether to raise it and never keeps spending on its own.

> Costs are estimated from the catalog prices. For DeepSeek the catalog uses peak prices, so off-peak runs cost less. Your vendor's bill is authoritative.

## Security notes

- **It executes AI-generated code.** That code runs only inside Docker containers, with no network by default, hard limits on memory, process count and time, and no API keys inside. Still, run SuperIntern only on a machine where you accept that risk.
- **API keys live only in `.env`.** The database stores variable names only, and the web UI shows only "set / not set".
- **A token is an identity.** The admin token is in `.superintern/cli-token`. Do not paste it into chats or issues.
- **Network access is off by default.** It is granted per project, to allow-listed domains only. Other domains are refused when the connection is set up.
- **Delivery is always a human click,** and it shows everything that will be pushed first.
- **Do not expose the web UI to the internet.** Team mode is for intranets only.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Tests

```bash
npm test                  # = node tests/run.mjs --all; offline regression suites, no API cost
npm run test:no-docker    # skip the two suites that need containers (container, egress)
```

Without Docker, those two suites **fail** rather than silently "pass by skipping". This is deliberate.

## Repository layout

| Path | Contents |
|---|---|
| `src/core/` | Orchestration state machine and collaboration core: routing, multi-user answers and conflicts, limits, egress, delivery, revisions, projects, daemon |
| `src/agent/` | Model roles: elicitor, planner, executor, verifier, replanner, reporter |
| `src/llm/` | Vendor adapters, default providers / model catalog / tier bindings, drift check |
| `src/db/` | SQLite schema and migrations; `audit_log` is the single source for replay |
| `src/web/` | Zero-dependency web UI (one HTML file + Node http server) |
| `sandbox/` | Sandbox images (Node; Python + Chromium for screenshots) and egress proxy |
| `scripts/` | Setup, start, and run-permanently scripts (Windows Task Scheduler / Linux systemd) |
| `tests/` | Offline regression suites; `tests/live/` holds paid live-model scripts |
| `docs/` | Deployment, known limits |

## License

[MIT](LICENSE) © 2026 THY495
