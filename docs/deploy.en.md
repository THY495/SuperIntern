# Deployment

[中文](deploy.md) | **English**

The same code supports three deployment setups:

| Setup | Persistent daemon | Guide |
|---|---|---|
| Windows 10/11 + Docker Desktop | Scheduled task: `scripts/daemon.ps1` | This page |
| Linux host | systemd user unit: `scripts/daemon.sh` | [Linux deployment](deploy-linux.en.md) |
| WSL2 | Same as Linux, plus a Windows-side WSL session that stays open | [WSL2 notes](deploy-linux.en.md#wsl2-notes) |

For people logging in from their own computers (team mode), see [Team deployment](deploy-team.en.md).

## Shared prerequisites

- Node **≥ 22.13** (for `node:sqlite` without a flag; validated on 24.x and 26.x) and git. **Prefer a Node release that bundles SQLite ≥ 3.51.3** (Node 24.15.0 and later 24.x, and 26.x, qualify; 22.x does not yet). With older SQLite versions, several processes writing at the same time in WAL mode have a very small chance of corrupting the database (see sqlite.org/wal.html). The web UI and the daemon detect this at startup and warn; in the web UI the warning is shown to administrators only.
- A container runtime: Docker or Podman. Podman and rootless Docker have not been validated. The daemon user must have direct access to the Docker socket.
- First installation: run `scripts/setup.ps1` or `scripts/setup.sh`. It:
  - checks the prerequisites above;
  - creates `.env` from `.env.example`;
  - builds the sandbox images `superintern/sandbox:v0.1` and `superintern/sandbox:v0.3-python`;
  - pulls the egress proxy image `mitmproxy/mitmproxy`.

  Per-task egress images named `superintern/sandbox:ca-*` are built automatically on first use. Clean them up with `node src/cli.mjs sandbox --reap`.
- Configure `.env` (mode 600; do not commit it):
  - **Model keys:** provide a key for at least one vendor.
  - **`GITHUB_TOKEN`:** the older way to configure delivery; it still works. For new deployments, set up delivery credentials under Settings → Connections instead; see [Connections](#connections-delivery-credentials) below.
  - **`NTFY_URL` and similar variables:** deployment-wide notification channels. Individual channels are configured under Settings → Members.

  Check whether a key is set without printing its value: `grep -c '^DEEPSEEK_API_KEY=.' .env`.
- Initialize the database: `node src/cli.mjs init --name <administrator name>`. It:
  - issues a CLI token and writes it to `.superintern/cli-token`. This is the token's only plaintext copy; the database stores only a hash.
  - chooses light / standard / heavy models based on the keys present in `.env`. Override a binding with `--bind heavy=<provider/model>`.

  If the database already exists, `init` only runs migrations.
- Later, change providers, models and tier bindings in Settings or through the `endpoint`, `catalog` and `bind` commands. Every change is audited.

## Windows: Task Scheduler

```powershell
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 install
powershell -ExecutionPolicy Bypass -File scripts\daemon.ps1 status   # also start | stop | uninstall
```

- **Task and logs:** the task is named `SuperIntern Daemon` and starts at login. A second trigger runs every five minutes: it does nothing if the process is running, and restarts it if it has died. Logs are in `.superintern/logs/daemon.log`.
- **Launch method:** the scheduled task uses `wscript.exe` to launch `daemon-launch.vbs` in a hidden window. That script starts `node src/cli.mjs web --daemon` and waits for it to exit. This has two purposes:
  - No console window appears. If there were one, closing it would kill the process.
  - The process is not killed when Task Scheduler releases the task.
- **Docker Desktop:** keep it running in the logged-in session. If the first task starts before Docker is ready, it fails and enters a five-minute backoff, then recovers automatically.
- **Use one daemon installation per machine:** do not install both the Windows scheduled task and the WSL2 systemd unit on the same machine. They compete for the same port and each maintains its own database.

## Web UI

- Local mode listens only on `127.0.0.1:7357`. For remote access, use an SSH tunnel: `ssh -L 7357:127.0.0.1:7357 <host>`, then open http://127.0.0.1:7357/ locally.
- In local mode, requests without a token act as the administrator who started the web UI. Other members log in with their own tokens. Adding a person under Settings → Members generates a token that is shown once.
- For direct access from multiple computers, use team mode: [Team deployment](deploy-team.en.md).
- **"Pause all" (emergency stop):** an administrator clicks "Pause all" in the web UI's top bar. The system starts no new steps, and a step in progress stops after its current operation. This does not count as a failure or a retry, and tasks are not cancelled; after "Resume automatic runs", work continues automatically. The paused state is stored in the database and survives restarts. CLI: `node src/cli.mjs user setting deploy.paused true` (`false` resumes).

## Models and review

Every model call belongs to a **role**: planning, execution, review, writing reports and so on. Each role uses a **tier** by default (light / standard / heavy), and each tier is bound to a specific model.

- **Binding a role on its own:** use the "Model for each role" table under Settings → Model assignment, or `node src/cli.mjs bind role <role> <provider/model>` (`bind role <role> tier` returns the role to its tier). `bind show` lists what each role currently uses.
- **A reviewer from another vendor:** when the reviewer has no binding of its own and its tier comes from the same vendor as this step's executor, the system automatically uses another vendor's model for review. "Same vendor" means the model's maker; for models called through a gateway, the name prefix counts (`moonshotai/kimi-k3` counts as moonshotai). If `.env` has keys for only one vendor, nothing changes. This can be turned off below the same table (`deploy.verifier_vendor same`).
- **Two-vendor co-sign:** in the same place, steps marked high-risk during planning can be reviewed once by each of two vendors, and pass only if both pass (`deploy.verifier_cosign high_risk`, off by default).
- **Fallback models:** each tier can have a fallback model (the "Backup" column in Model assignment, or `bind fallback <tier>=<provider/model>`; `none` removes it). When a provider keeps returning errors, the system stops calling it for a while (all processes share this decision; the cool-down doubles each time, up to 15 minutes). During that time, tiers with a fallback switch to it, and switch back once the provider recovers. Steps without a fallback wait; the "Model providers" entry in System status says which provider they are waiting for.
- **Weakened pre-existing tests:** at each handoff, the system compares what the step did to tests that existed before the task started: deleted test files, added skips, fewer cases or assertions, changed expected values. By default this is only flagged, for the reviewer and the person signing off. To have such handoffs sent back directly, run `node src/cli.mjs user setting deploy.test_guard reject` (there is no page switch yet). When a change really is needed, tick "Allow this step to change these tests that existed before the task" when answering that item, or use `answer <item> "…" --allow-tests` on the CLI. JavaScript, Python and Go test styles are recognized for now.
- **Context compaction:** when a request's context passes the "Automatic compaction line", the system compacts it and then continues. First it replaces the oldest large tool outputs with a one-line placeholder (the full command output is saved under `.si-outputs/` in the workspace and is not committed). If that is not enough, the model writes a brief and the context is rebuilt from it. If one step still does not fit after two compactions, an item suggests splitting the step. Change the line on the task page or under "Budget & limits" in project settings; the default is 120k tokens, 0 = off. The effective value never exceeds 80% of the context limit.

### The reviewer checks the running app

For steps that change the UI, planning writes a few **UI checks** (of the kind "after clicking Delete the list has one row fewer"; at most 8 per step). The reviewer starts the app, opens pages, clicks, types and selects, and gives a verdict per check: pass / fail / not checked. If any check fails, the step is sent back.

- **Requirements:** the task runs in the sandbox with the Python image that includes Chromium (the project default; projects changed with `project sandbox <id> node` cannot be checked and record "not checked"); `si-preview.json` at the repository root says how to start the services. The AI maintains this file itself: a handoff for a step with UI checks is sent back if the file is missing or wrong.
- **`si-preview.json`:** `start` (commands that start the services, at most 3) and `url` (only `http://127.0.0.1` or `localhost`) are required; `ready` (an address that must respond once the services are up), `seed` (commands that write sample data), `pages` (pages to look at) and `waitMs` are optional. Page screenshots before sign-off use it too.
- **`SI_PREVIEW=1`:** the system sets this environment variable when it starts services and writes sample data. Sample-data scripts check it first and refuse to run without it, so sample data never gets written into a database in real use; the backend can also use it to switch to a preview-only database. The "run the app yourself" command on the sign-off card includes it too.
- **Seeing what the AI clicked:** a screen is saved automatically after each click or input. The ones the reviewer cites in its verdicts are kept (at most 3 per check) and the rest are deleted. "Page checks" in the step details shows each verdict with its screens; on the sign-off card, "What the AI review did in the running app" appears under "Page screenshots". Checks that could not be done appear in "Look at these before signing off" on the sign-off card, for you to verify yourself.
- If the app cannot start, all checks are recorded as "not checked" with the reason, and the step does not fail because of it. Drag and drop, hover menus, file uploads and multiple tabs are not supported. The screenshot tool is given only to models that accept images (marked vision in the model catalog; `catalog check --vision` tests this); other models read only the page text.

## Connections (delivery credentials)

Delivery pushes a branch to a remote repository and can also open a PR. The credentials used to push and open PRs are called "connections". Manage them under Settings → Connections in the web UI, or with `node src/cli.mjs cred`.

- **Not attached to projects:** at each delivery, the system picks a connection on the spot based on the remote address and who started the delivery, and the audit log records which one was used. Projects in the same organization do not need to be configured one by one.
- **Selection order:**
  1. Connections of the person who started the delivery. A member's own connections are used only for deliveries that member starts; other people's deliveries never borrow them;
  2. GitHub App;
  3. Deployment-wide token or SSH key;
  4. `GITHUB_TOKEN` in `.env` (older deployments).

  When several connections at the same level match, the one with the more specific scope comes first (`acme/web` before `acme/*`), then the most recently added. Expired connections and connections rejected on push (insufficient permissions) are skipped automatically in favor of the next one. A connection's scope should match the repositories it is actually authorized for on GitHub. If none can be used, the server's own git credentials are tried (usually there are none). To put the GitHub App first (PRs always shown as the bot), an administrator changes this under Settings → Connections, or runs `node src/cli.mjs user setting deploy.credential_order app_first`.
- **SSH keys only push:** opening a PR calls the GitHub API, so the system picks a separate GitHub App or token for the https address of the same repository.
- **PRs only on GitHub:** GitLab, Gitea and internal services can be pushed to, but no merge request is opened automatically.
- **Revocation applies only within this system:** the token or App private key itself stays valid on GitHub. To invalidate it, revoke it on GitHub.
- **Storage:** connections are stored encrypted in the state database (AES-256-GCM). The master key is `.superintern/master.key`, created when the first connection is added; it can also be provided through the environment variable `SUPERINTERN_MASTER_KEY`. Once entered, a value cannot be viewed by anyone; the page shows only the last 4 characters or the key fingerprint.
- **Pre-delivery check:** when you click deliver, the web UI first checks which connection will be used and whether it can push; if the check fails, it asks you first. You can also check separately under Settings → Connections → "Check a remote", or run `node src/cli.mjs cred check <remote address>`.
- **Expiry reminders:** a connection with an expiry date appears in its owner's to-dos when it expires within 7 days; deployment-wide connections remind the administrators. For a GitHub personal token without an expiry date, the system reads the date from GitHub after one check and records it.
- **Disabled members:** when a member is disabled, that member's own connections are revoked as well.

### Using a GitHub App (recommended when repositories are in one or two organizations)

1. Create an App under the organization's Settings → Developer settings → GitHub Apps → New GitHub App:
   - Homepage URL: the organization's home page, for example `https://github.com/<organization>`;
   - Webhook: clear Active;
   - Repository permissions: set Contents and Pull requests to Read and write, and keep Metadata at Read-only. To allow the AI to change files under `.github/workflows/`, also set Workflows to Read and write;
   - Where can this GitHub App be installed: choose Only on this account.
2. After it is created, note the App ID, click Generate a private key and download the `.pem` private key file.
3. Click Install App on the left of the App page, install it on the organization, and choose all repositories or selected ones.
4. Add a GitHub App connection under Settings → Connections in the web UI, entering the App ID and pasting the full content of the `.pem` file. Alternatively, run on the server:

   ```bash
   node src/cli.mjs cred add github-app --name "<organization> App" --app-id <App ID> --key-file <path to pem file> --repos '<organization>/*'
   ```

   After it is entered, the `.pem` file can be deleted.

For each push, the system uses the private key to sign a short-lived token on the spot: it covers only that one repository, has only the permissions this action needs, and expires after 1 hour. The system does not keep any GitHub token long-term. Pushes and PRs appear as this App.

### Push guardrails

Whichever connection is used, the system only pushes its own branches (`superintern/…` and `v0/…`) to the remote:

- it does not push the remote's default branch, does not force-push, and does not delete branches;
- when the remote branch has commits pushed by someone else, it stops and explains why instead of overwriting them;
- the only exception: when the remote is an empty repository, it pushes the project's starting point as the default branch, so that PRs have a target branch. It checks once more that the remote really is empty before pushing.

Merging is always done by a person on GitHub. Private repositories in free GitHub organizations cannot use branch protection, so the system enforces this guardrail itself. If you later move to a paid plan, you can add branch protection and required reviews on GitHub as a second line of defense.

## Credentials for network sources

When a private npm / PyPI source or an internal mirror requires authentication, the credentials are set on the **source**, and the egress proxy adds them to the tool's requests. Code in the sandbox cannot see them.

```bash
node src/cli.mjs sources cred add <source id> --key-file <file>            # the file holds the whole header value, e.g. "Bearer <token>"
node src/cli.mjs sources cred add <source id> --key-file <file> --basic    # the file holds "username:password"
```

- Find the source id under Settings → Network catalog. Credentials are stored encrypted in the database (with the same master key as connections); once entered, nobody can view the original.
- **Read-only by default:** a source with credentials gets them only on read requests (GET, git clone). In addition, for a project that allows such a source, every source it allows becomes read-only (POST, PUT and the like are blocked), so code in a task cannot use the credentials to send things out. For a source that really needs writes, add `--allow-write`.
- Revoke: `sources cred revoke <credential id>`.

## Change provenance: what each change is based on

Without opening the web UI, you can answer "which step made this change, which contract clause it is based on, who gave the instruction and who approved it":

- **Contract clauses are numbered:** each contract version is split into clauses (C1, C2, …). A clause keeps its number as long as its text does not change; a clause whose text changes gets a new number. During planning, each step records which clauses it implements.
- **Commit messages carry their provenance:** each step's commit message ends with a few provenance lines, which git and GitHub recognize as trailers:
  - `SuperIntern-Task` / `SuperIntern-Node`: task and step;
  - `Contract`: the contract version, and who approved it when;
  - `Clauses`: the numbers of the clauses this step implements;
  - `Instructed-by`: people who gave instructions or answered questions for this step; `Requested-by`: the requester;
  - `Trace`: a link to this step in the web UI. Written only when the "Dashboard address" is set under Settings → Connections.
- **PR descriptions include a provenance table:** one line each for approval, request, sign-off and delivery, plus a table listing each step's clauses, instruction sources and commits. This information survives a squash merge on GitHub.
- **GitHub accounts:** each member can enter their GitHub account and commit email under Members, or with `node src/cli.mjs user git <id> --github <account> --email <email>`. When an administrator turns on Co-authored-by under Settings → Connections, commits get one Co-authored-by line each for the approver, the people who gave instructions and the requester, and GitHub shows their avatars. This is off by default, because on GitHub it means "co-author". The GitHub noreply address is recommended as the commit email.
- **Tracing back from code:** the "Changes" card of a task has a trace box. Enter a commit (forms like `HEAD~1` work) or `file:line` to find which step made that code, which contract clauses it is based on, who said what and who approved it. "Where this step comes from" in the step details shows the same information. For a delivered repository, query it from the CLI:

  ```bash
  node src/cli.mjs trace src/api/orders.mjs:42 --repo <repository directory>
  ```

  `file:line` finds the commit that last changed that line. People without SuperIntern can read `git log`: the provenance lines at the end of each commit carry the same information.
- The provenance table includes the clause text and excerpts from answers. If the repository is public, these become public too.
- Provenance records are append-only; they cannot be deleted or changed.

## Backup and restore

All state (tasks, audit records, the spending ledger, handoff records) lives in one file: `.superintern/state.db`.

- **Automatic backups:** by default the daemon backs up every 24 hours, and makes a separate weekly backup every 7 days. Each backup is opened read-only and verified right after it is made; one that fails verification is not kept. By default the 7 most recent daily backups and 4 weekly backups are kept. The interval can be changed (0 = off): `node src/cli.mjs user setting deploy.backup_every_hours 12`.
- **Routine checks:** the daemon runs a quick integrity check every hour and a full check every day, including foreign keys. Results are written to the audit log.
- **Manual backup:** `node src/cli.mjs db backup`; `db backups` lists existing backups.
- **Restore:**
  1. Stop the web UI, the daemon and running tasks first. The command refuses to run while any process is still writing to the database.
  2. Run `node src/cli.mjs db restore <backup file>`. The current database is saved separately first, then replaced by the backup; a backup from an older version is upgraded to the current version along the way.
  3. Run `db check --full` to verify.
- **The master key is not in backups:** `.superintern/master.key` never goes into `backups/`. Handing a backup or the database file to someone for troubleshooting does not hand over credentials. Conversely, when restoring on another machine, bring `master.key` along; otherwise connections cannot be decrypted and must be entered again. Keep a copy of it somewhere safe.
- **Do not copy `state.db` directly while the service is running:** in WAL mode, recent commits may still be in the `-wal` file and not yet in the main file, so a direct copy can be inconsistent. Use `db backup`.
- **Data-loss window:** with default settings, at most the most recent day of data is lost (depending on the backup interval). To shorten it, lower the interval, or sync the `backups/` directory to another machine. Backups on the same disk do not protect against disk failure.

## Spending and budgets

Every model cost is charged to one person. By default it is charged to the person who started the task; it can be changed to the project owner or the person who approved the task's contract: `node src/cli.mjs user setting deploy.cost_attribution project_owner`.

There are four budget levels. When any level is reached, the running step stops before its next model call, and an item goes to the person who should decide:

| Level | Where to set it | Default |
|---|---|---|
| Task | "Limits" on the task page | Deployment default |
| Project | "Budget & limits" in project settings | Not set |
| Per person per month | Settings → Spend (one person), or `deploy.person_budget_usd_month` (default for everyone) | Not set |
| Whole deployment per month | `deploy.budget_usd_month` | Not set |

- **Reservation:** before each model call, the system reserves the worst-case cost in one transaction and checks it against all the gates together. When several tasks run at once, they cannot pass a gate together.
- **Months:** split by the deployment time zone (see "Time and calendar" below; UTC if not set).
- **Fair scheduling:** `deploy.max_running_per_person` limits how many tasks each person can have running at once; 0 means no limit. The daemon takes turns between people when starting tasks, so one person submitting many tasks at once does not push other people's tasks to the back.
- **Viewing spending:** Settings → Spend shows each person's spending for this month and last month, and the trend over the last 14 days. Members see only their own row. CLI: `node src/cli.mjs user spend`.

## System status and announcements

- **Settings → System status** (visible to administrators only): the daemon, container runtime, state database, backups, integrity checks, Node's bundled SQLite, model providers, credentials in the network catalog, time zone and holidays, and the runtime self-check. Each is marked "OK / Attention / Problem", problems come first, and each says what to do. When anything is at "Attention" or "Problem", its entry in the side menu shows a small dot.
- **Runtime self-check:** the daemon regularly checks a few things that should always hold: every unfinished task can say whom it is waiting for, the gate really stopped work when spending passed a limit, task workspaces do not cover the state database or the master key, the process holding a task is still alive, and so on. If any fails, they are combined into one notification to the administrators. CLI: `node src/cli.mjs invariants` (add `--run` to check right away).
- **"Changes worth a look":** for example, a model's context window is on the small side, some steps keep hitting the compaction line, or weakened pre-existing tests are becoming more frequent. Click "Got it" to dismiss one; if the situation goes away and comes back, it is shown again.
- **Announcements:** lower on the same page; sent to everyone as a banner at the top of the web UI.
- **Liveness probe:** `GET /healthz` needs no login. It returns `{"ok":true}` when the process is up and the database can be read, otherwise 503.

## Time and calendar

Under Settings → Time and calendar, an administrator sets the **deployment time zone** (such as `Asia/Shanghai`) and **holidays and make-up workdays**; the CLI is `node src/cli.mjs calendar`.

- The "1bd" (one business day) timeout in the routing table, the duty roster's hand-over time and the day monthly budgets roll over all follow the deployment time zone. If it is not set, UTC is used, which is 8 hours off for a deployment in China; System status warns about this.
- Holidays, one per line: `2026-10-01..2026-10-07 国庆`; make-up workdays are written `2026-10-11 班`. When the listed days are about to run out, System status reminds you to add the next year.
- Each person can set their own time zone on the same page; it affects only the times they see.
- Duty swaps (someone covers whole days) are added below the duty roster in decision routing, or with `routing swap`.

## Logs and tracing

- **Logs for people:** the daemon writes `.superintern/logs/daemon.log`, and each task process writes `.superintern/logs/<task>-<time>.log`. The "Log" button in the web UI shows the tail of the latter.
- **Structured logs:** the daemon, the web UI and task processes also write JSON-lines logs under `.superintern/logs/jsonl/`, one file per process per day. Each line has these fields:
  - time, level, message text;
  - process kind and pid;
  - task id and step id;
  - trace id: the daemon starts a new one on every tick, and the task processes it starts reuse it. So daemon logs and task logs from the same start can be matched by trace id.
- **Automatic cleanup:** the daemon does this once a day.
  - It deletes task logs and JSON-lines logs older than the retention period (14 days by default; change with `node src/cli.mjs user setting deploy.log_keep_days 30`).
  - When `daemon.log` exceeds 10 MB, it is copied to `daemon.log.1` and the original is emptied.
  - For merged or archived tasks, dependency directories in the workspace (`node_modules`, `.venv` and so on) are deleted, and the space freed is recorded in the audit log. To keep them, set `deploy.clean_merged_deps false`. When a task is reopened, its dependencies are installed again.
- **Secrets are not written to disk:** text written to the database, logs and model-call recordings, and notifications sent out, have secrets removed first and replaced with `[redacted]`. Three kinds are recognized:
  - common secret shapes: API keys, GitHub tokens, AWS keys, private keys, JWTs and so on;
  - `Authorization` request headers and passwords in URLs: only the value is removed, the prefix is kept;
  - by value: values of `.env` variables whose names end in `_KEY`, `_TOKEN`, `SECRET`, `PASSWORD` and similar, and credentials entered under Settings → Connections.
  - Keys pasted into a conversation are also removed before being stored in the database; neither the agent nor the model sees them. Put keys in Settings → Connections or `.env`, not in a conversation.
- **OTLP trace export (optional):** traces are exported only when the standard OpenTelemetry environment variable `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set, and are sent as OTLP/HTTP JSON.
  - One span per execution step, and one child span per model call.
  - Model-call attributes follow the OTel GenAI semantic conventions: model, token usage, cost.
  - **Prompts and replies are not exported.**
  - When the collector requires authentication, set request headers with `OTEL_EXPORTER_OTLP_HEADERS`.
  - Set `OTEL_SDK_DISABLED=true` to turn export off.

## Upgrading

1. **Back up:** before migrating, the system automatically backs up the whole database to `.superintern/backups/`. To keep a copy of your own, run `node src/cli.mjs db backup` before upgrading.
2. **Replace the code:** install the new code or run `git pull`.
3. **Migrate:** run `node src/cli.mjs init` once, or any CLI command. Migrations run step by step using `PRAGMA user_version` and do not delete data. Each migration step and its version number are written in the same transaction, so a failure leaves the database at its previous version, never half-changed. If existing data does not satisfy a constraint of the new version, the error names the table, the constraint and the rows.
4. **Update images:** if the new version changes sandbox image tags, rerun `setup` to build missing images.

**Upgrading from 0.3.x to 0.4.0:**

- **Security fix; sandbox containers are recreated:** code in the sandbox could write hooks into the workspace `.git`, and the next git operation on the host would run them. Now `.git` is read-only to the sandbox, and git on the host does not run hooks or fsmonitor from the repository. Containers started under the old rules are deleted and recreated automatically. The project's own git hooks (husky, pre-commit and so on) no longer run on commits SuperIntern makes.
- **Credentials in tool settings in the network catalog are no longer put into the sandbox:** code in tasks of projects that allowed such a source could read these credentials. Set a new credential on that source first, then configure it as described in "Credentials for network sources" above; System status lists the sources that need attention. Until this is done, installs that need authentication fail.
- **The database is upgraded and constraints are tightened:** if existing data does not satisfy a new constraint during migration, the whole migration rolls back and the database stays at its previous version; the error names the table, the constraint and the rows. The system backs up automatically before migrating.
- **Turned on by default:** using another vendor when the reviewer and the executor are from the same one (spending changes accordingly when `.env` has keys for several vendors), context compaction (120k), backups every 24 hours, 14-day log retention, and automatic deletion of dependency directories of merged tasks. The sections above say how to change them.
- **Tokens:** newly issued CLI tokens expire after 90 days by default (`deploy.cli_token_days`, 0 = never); tokens issued before the upgrade are not affected. In team mode, the browser cookie now holds a session instead of the token itself.
- On machines with `HTTPS_PROXY` set, model calls also go through that proxy (`SUPERINTERN_IGNORE_ENV_PROXY=1` turns this off).

## Everyday commands

```bash
node src/cli.mjs digest                 # my to-dos: who answers, who is pending, deadlines
node src/cli.mjs questions              # open questions
node src/cli.mjs answer <qid> "..."     # answer a question
node src/cli.mjs say <task> "..."       # correction / new instruction / extra information
node src/cli.mjs signoff <task> --accept | --reject "reason"
node src/cli.mjs replay <task>          # reconstruct from the audit log and state database only
node src/cli.mjs sandbox --reap         # clean up leftover containers and derived images
node src/cli.mjs bind                   # what each of the three tiers is bound to; change with bind set heavy=<provider/model>
node src/cli.mjs bind role verifier <provider/model>   # bind one role on its own; bind fallback standard=<provider/model> sets a fallback
node src/cli.mjs user spend             # how much each person spent this month
node src/cli.mjs invariants             # runtime self-check results
node src/cli.mjs db check               # state database integrity check; db stats shows size and slow statements
node src/cli.mjs endpoint               # providers and key status; endpoint test <id> checks connectivity
node src/cli.mjs catalog check          # catalog drift check; the daemon runs it every 7 days by default
```
