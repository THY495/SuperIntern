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
  - **Email (optional):** `SMTP_URL`, `MAIL_FROM` (sending), `MAIL_TO` (deployment-wide address), `IMAP_URL`, `MAIL_REPLY_TO` (reply by email); see [Email channel and reply by email](#email-channel-and-reply-by-email) below.

  Check whether a key is set without printing its value: `grep -c '^DEEPSEEK_API_KEY=.' .env`. To read a different environment file, set `SUPERINTERN_ENV_FILE=<path>`; set it to `none` to read no `.env` at all.
- Optional: when Universal Ctags is installed on the host, the repository map (see "Models and review" below) uses it to extract symbols; without it, per-language patterns are used.
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
- **"Pause all" (emergency stop):** an administrator clicks "Pause all" in the web UI's top bar. The system starts no new steps, and a step in progress stops right away: a model call in flight is cancelled, a running command is allowed to finish, and the step's half-done changes are set aside and put back when work resumes. This does not count as a failure or a retry, and tasks are not cancelled; after "Resume automatic runs", work continues automatically. The paused state is stored in the database and survives restarts. CLI: `node src/cli.mjs user setting deploy.paused true` (`false` resumes).
- **Pausing or aborting a task:** takes effect at the AI's next turn, without waiting for the step and its review to finish. Abort cancels a model call in flight. Half-done changes of the interrupted step are saved to `refs/superintern/parked/<step>` and put back when the step runs again; if they cannot be put back, the step says where they are and how to retrieve them. Who can do what: Pause = the owner and people who took part in the task (an item was sent to them, or they answered one); Resume = the owner or whoever paused it; Abort = the owner only. Corrections and new instructions sent with `say --urgent` also interrupt the current step and replan right away; extra information needs no `--urgent` and reaches the AI in the middle of a step.
- **Redo from this step:** the task owner clicks "Redo from this step…" in the step details (finished steps only). That step, the steps that used its results and the steps committed after it all go back to be redone, and the code returns to before that step. A preview comes first: which steps go back, which files revert or are deleted, which items are withdrawn and which sign-offs are voided. The code from before (including uncommitted changes) is kept at `refs/superintern/rewound/<id>`. A running task must be paused first; tasks that are delivered, merged into the project branch, aborted or archived cannot be sent back this way (add a task instead). CLI: `rewind <task> <step> [--note "what to watch out for"] [--yes]`; without `--yes` it only shows the preview.
- **The AI asking to widen its writable paths:** when a handoff is rejected only because it changed files outside the writable paths, the AI can ask to add those paths. The system sends one plan-approval item with the paths, the AI's reason, the writable paths now and after approval, any overlap with other tasks in the project, and the out-of-scope diff. Choosing "Approve" writes the paths into the contract; the step's changes are kept and it does not have to be redone. Any other answer counts as not approved. Shared paths, rules files and hook files cannot be requested this way.

## Models and review

Every model call belongs to a **role**: planning, execution, review, writing reports and so on. Each role uses a **tier** by default (light / standard / heavy), and each tier is bound to a specific model.

- **Binding a role on its own:** use the "Model for each role" table under Settings → Model assignment, or `node src/cli.mjs bind role <role> <provider/model>` (`bind role <role> tier` returns the role to its tier). `bind show` lists what each role currently uses.
- **A reviewer from another vendor:** when the reviewer has no binding of its own and its tier comes from the same vendor as this step's executor, the system automatically uses another vendor's model for review. "Same vendor" means the model's maker; for models called through a gateway, the name prefix counts (`moonshotai/kimi-k3` counts as moonshotai). If `.env` has keys for only one vendor, nothing changes. This can be turned off below the same table (`deploy.verifier_vendor same`).
- **Two-vendor co-sign:** in the same place, steps marked high-risk during planning can be reviewed once by each of two vendors, and pass only if both pass (`deploy.verifier_cosign high_risk`, off by default).
- **Fallback models:** each tier can have a fallback model (the "Backup" column in Model assignment, or `bind fallback <tier>=<provider/model>`; `none` removes it). When a provider keeps returning errors, the system stops calling it for a while (all processes share this decision; the cool-down doubles each time, up to 15 minutes). During that time, tiers with a fallback switch to it, and switch back once the provider recovers. Steps without a fallback wait; the "Model providers" entry in System status says which provider they are waiting for.
- **Weakened pre-existing tests:** at each handoff, the system compares what the step did to tests that existed before the task started: deleted test files, added skips, fewer cases or assertions, changed expected values. By default this is only flagged, for the reviewer and the person signing off. To have such handoffs sent back directly, run `node src/cli.mjs user setting deploy.test_guard reject` (there is no page switch yet). When a change really is needed, tick "Allow this step to change these tests that existed before the task" when answering that item, or use `answer <item> "…" --allow-tests` on the CLI. JavaScript, Python and Go test styles are recognized for now.
- **Context compaction:** when a request's context passes the "Automatic compaction line", the system compacts it and then continues. First it replaces the oldest large tool outputs with a one-line placeholder (the full command output is saved under `.si-outputs/` in the workspace and is not committed). If that is not enough, the model writes a brief and the context is rebuilt from it. If one step still does not fit after two compactions, an item suggests splitting the step. Change the line on the task page or under "Budget & limits" in project settings; the default is 120k tokens, 0 = off. The effective value never exceeds 80% of the context limit.
- **Repository map:** at the start of each step the executor gets a map of files and the symbols they define, ranked by the step's scope and cut to `deploy.repo_map_tokens` (2048 tokens by default, 0 = off). The map shows the repository as it was when the step started and is not refreshed when files change mid-step. Universal Ctags is used if it is installed on the host; otherwise symbols are found with per-language patterns (JS/TS, Python, Go, Rust, the Java family, Ruby, PHP, C/C++).

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
   - Repository permissions: set Contents and Pull requests to Read and write, and keep Metadata at Read-only. To allow the AI to change files under `.github/workflows/`, also set Workflows to Read and write. To let the system watch delivered PRs (see "GitHub loop" below), also set Checks, Commit statuses and Actions to Read-only; for GitHub issue intake, also set Issues to Read-only. After adding permissions to an App that is already installed, accept the new permissions on the organization's GitHub Apps installation page;
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

## GitHub loop

After a delivery opens a PR, the daemon keeps watching it; labeled GitHub issues and schedules can also become new tasks. All of this uses only deployment-level connections (GitHub App first, then a deployment token), never members' own connections; the App permissions needed are listed above.

- **Watching delivered PRs:** the "Delivered PR" card on task and project pages shows the PR's status, CI and review comments. The daemon adjusts its pace: every minute while CI is running, every 5 minutes once it has finished, every 30 minutes for a closed PR (and not at all after 3 days), and it stops once the PR is merged; on errors it backs off step by step. Requests are conditional, so unchanged data does not use up GitHub's rate limit; when fewer than 50 requests remain, it waits for the reset. If the App lacks the CI read permissions, PR status and comments are still watched and the CI column says which permission is missing.
- **AI follow-up:** when a delivery opens a PR, you are asked separately whether to authorize AI follow-up for it (the CLI authorizes it by default; add `--autofix off` to leave it off). Once authorized:
  - When CI fails, the AI works from the failed checks and the tail of the Actions logs, and pushes the fix back to the same PR, at most 2 rounds. Logs are external text, never instructions.
  - "Request changes" on GitHub from a member who may deliver the task becomes a correction directly, together with that review's inline comments; the result is pushed back the same way.
  - Before pushing back, the same checks as delivery apply: tasks that were signed off at delivery, or are high-risk, need the new version signed off too; the pre-delivery hooks and push guardrails apply as usual.
  - It asks a person with an item instead of fixing when: 2 rounds have already been used, the budget gate would be hit, someone else has pushed to the PR branch, or the person who authorized it has been disabled or their token revoked. Answering "no fix needed" leaves the failure on that commit alone; any other answer becomes a correction.
  - The card shows who authorized it; anyone who may deliver can "Withdraw authorization" or "Authorize AI follow-up yourself". Withdrawing affects only what comes next; a round already handed to the AI is finished (pause the task to stop it right away).
  - Merging is always done by a person on GitHub.
- **Review comments:** each comment on the card can be handled with "Have the AI act on this" (in the name of whoever clicks) or "Ignore" (recorded on the board only, nothing goes back to GitHub); "Ignore" can be undone. Comments from non-members are listed separately and never trigger paid work; bots are not listed.
- **Whole-project PRs:** when CI fails, a fix task is drafted under the authorization of the person who delivered (at most 2 rounds, following the project's automation mode); after the fix task merges, someone has to deliver the project again for the PR to update.
- **GitHub issue intake:** the project lead sets a repository and a label under Project settings → Issues & schedules (CLI: `project issues <project> --repo <owner/repo> --label <label>`, `--off` to turn it off). The daemon looks every 5 minutes, and each issue with that label becomes a draft "Add task" request:
  - It always needs a person's approval, even in auto mode. The approval item starts with the source, the author and a link; the issue text is external text and is passed to the AI marked as not being instructions.
  - If the author matches someone in the project, the request is recorded under their name (and they sign it off); otherwise under the person who set up the intake.
  - At most 3 are in progress at once (being drafted, awaiting approval or queued); abandoned ones are not drafted again; closing an issue or removing its label takes it out of the queue.
  - GitHub is only read: no comments and no label changes. The label is the gate that authorizes intake, so do not put it into issue templates.
- **Schedules:** added on the same page, by choosing daily / weekly / monthly or writing a cron expression (five fields, deployment time zone; forms such as `@daily` work too); CLI: `project schedule <project> add --name <name> --cron "0 9 * * 1" --brief "<what to do>"` (`on` / `off` / `rm <id>`). When due, it drafts an "Add task" request that follows the automation mode like a request typed by a person. A missed run is made up only once; if the previous draft has not been approved yet, the run is skipped.

## Credentials for network sources

When a private npm / PyPI source or an internal mirror requires authentication, the credentials are set on the **source**, and the egress proxy adds them to the tool's requests. Code in the sandbox cannot see them.

```bash
node src/cli.mjs sources cred add <source id> --key-file <file>            # the file holds the whole header value, e.g. "Bearer <token>"
node src/cli.mjs sources cred add <source id> --key-file <file> --basic    # the file holds "username:password"
```

- Find the source id under Settings → Network catalog. Credentials are stored encrypted in the database (with the same master key as connections); once entered, nobody can view the original.
- **Read-only by default:** a source with credentials gets them only on read requests (GET, git clone). In addition, for a project that allows such a source, every source it allows becomes read-only (POST, PUT and the like are blocked), so code in a task cannot use the credentials to send things out. For a source that really needs writes, add `--allow-write`.
- Revoke: `sources cred revoke <credential id>`.

## Project rules, skills, hooks and MCP

**Project rules**

- From the repository root down to the directories this step changes, at most one file is taken per level: `AGENTS.override.md`, otherwise `AGENTS.md`, otherwise `CLAUDE.md`. The root comes first and deeper files take precedence, up to 32 KiB in total; when that is exceeded, the deepest level is kept first and the skipped files are named. The committed version is read. When the executor reads or writes in another directory, that level's rules are attached to the tool result.
- Rules are given to the executor and the reviewer, marked as coming from the repository: they cannot override the contract, widen the scope or relax acceptance criteria.
- Rules files are maintained by people: if the executor changes one, the handoff is sent back, unless the contract's writable paths name that file.
- Before each step, if the rules or the decided conventions have changed, the rules are compared against the decided conventions; a conflict becomes an item for the project lead.
- Project settings → Project rules: anyone who can see the project can view them; the lead can create, edit and delete them, and saving commits once to the project branch with the editor as author. Tasks already started do not see the change; it applies from tasks started afterwards.

**Skills**

- A directory with a `SKILL.md` (name, description, body), optionally with reference files.
- Three levels: deployment `.superintern/skills/` (administrators install with `skill add <directory>`), project `.superintern/projects/<project id>/skills/` (`skill add <directory> --project <id>`), and the repository's `.agents/skills/` (or `.claude/skills/` if that is absent). For the same name, deployment > project > repository.
- At each step the AI first sees only names and descriptions (8000 characters in total; beyond that, ranked by relevance to the step); skills named in the task or step are always included; skills with `disable-model-invocation` are included only when named. The AI fetches the full text when it needs it; deployment and project skills are copied with their reference files into `.si-skills/` in the workspace, which is not committed, and their scripts run only in the sandbox.
- Turning off: the lead switches them one by one under Project settings → Skills (this project only), or `skill off <level>:<name> --project <id>`; administrators omit `--project` to turn one off for all projects. Turning one off also turns off same-named ones it was hiding.

**Policy hooks**

- Four points: before a tool call (`PreToolUse`), before handoff (`PreHandoff`), before merge (`PreMerge`) and before delivery (`PreDeliver`).
- The format is the same as Claude Code hooks, so existing hooks work as they are:

  ```json
  {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./.superintern/hooks/check.sh", "timeout": 30}]}]}}
  ```

  The hook gets JSON on stdin (event name, tool name, tool input and so on). Exit 2 = block, with the reason taken from stderr; on exit 0, `hookSpecificOutput.permissionDecision` in stdout is read (`allow` / `deny` / `ask`). When several hooks match, all of them run and the results combine as deny > ask > allow. `matcher` accepts the system's tool names as well as Claude Code's names (`Bash`, `Read`, `Write` and so on); write `mcp__.*` for MCP tools. `timeout` defaults to 30 seconds, at most 600.
- Where they live and how they are trusted:
  - Deployment `.superintern/hooks.json` and project `.superintern/projects/<project id>/hooks.json`: only people with access to the server can change them, and they run on the host. They are approved by content: `hook list` shows them, `hook trust` approves them; when the command or a script it refers to changes, it must be approved again, and unapproved hooks do not run.
  - The repository's `.superintern/hooks.json` and `.claude/settings.json` (only `PreToolUse` is read from the latter): read from the commit the task started from, and run read-only in the sandbox only. If a task changes a hook file or hook script, repository hooks do not run, this counts as blocking, and the handoff is sent back.
- When a hook itself fails: before a tool call and before handoff, the default is to allow (a hook with `"onFailure": "block"` blocks instead); before merge and before delivery, failure always counts as blocking.
- When a hook blocks: before a tool call, the reason goes back to the AI; before handoff, it joins the handoff rejection, and the same block three times in a row becomes a question to a person; before merge, an item is raised and the answer becomes a correction; before delivery, delivery fails and nothing is pushed.
- When a hook asks for confirmation: a "Security approval" item is sent, and answering "agree" allows that one action. When a pre-delivery hook asks, the error carries a confirmation code: confirm in the dialog on the board, or deliver again with `--hook-ack <code>` on the CLI; the code becomes invalid if what the hook says changes.
- Project settings → Hooks (read-only) lists, for each of the four points, what happens when a hook blocks, asks for confirmation or fails, together with the built-in checks and the status of each configured hook.

**MCP**

- Configuration: deployment `.superintern/mcp.json`, project `.superintern/projects/<project id>/mcp.json` and the repository's `.mcp.json`, in the Claude Code format: `{"mcpServers": {"<name>": {"command": "…", "args": […], "env": {…}}}}`; a remote server is `{"type": "http", "url": "https://…"}`. For the same name, the earlier one wins.
- Local servers start inside the task's sandbox, with that sandbox's network and credentials. Remote servers go through a bridge inside the sandbox and the egress proxy, so the server's domain must be allowed under the project's network settings. Do not put tokens for remote servers into the configuration: add a source for the server's address under Settings → Network catalog and set the credential with `sources cred add <source id> … --allow-write` (MCP requests are all POST). Environment variables and headers that look like credentials are never used; any that were committed to a repository should be treated as leaked and replaced.
- Approval: the project lead or an administrator starts the server and reads the original tool descriptions under Project settings → MCP, or with `mcp check --project <id>`, then approves with `mcp approve --project <id>`. When the server's command, arguments, environment, address or tool list changes, the AI loses access until it is approved again; the page shows the approved and current descriptions side by side. `mcp off --server <id> --project <id>` turns a server off (`on` turns it back on).
- Per-tool mode: `ask` (default: every call sends a Security approval item, and answering "agree" allows that one call) / `auto` (always allowed) / `off` (not given to the AI). Change it in the dropdown on the page or with `mcp tool <mcp__…> auto|ask|off --project <id>`. Read-only / write annotations from the tools themselves are not trusted.
- Sandbox only: tasks without a sandbox get no MCP tools. Results over 40,000 characters give the AI only the beginning; the full text is saved under `.si-outputs/` in the workspace.

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
- **Cancelled calls:** a model call cancelled when a task is aborted or everything is paused has no usage report, so it is charged as an estimate (input estimated, output at its maximum) and marked as an estimate.
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
- Each person can set their own time zone on the same page: times on the board are shown in it, and it also sets their working hours and the time of their status reports (see below). If not set, the deployment time zone is used.
- Duty swaps (someone covers whole days) are added below the duty roster in decision routing, or with `routing swap`.

## Oversight modes and approval gates

Every kind of signal the system sends to people has one of three levels of human involvement: **Decide** (a person must decide; it becomes an item), **Notify** (pushed to people without blocking work) and **Record** (only recorded, visible on the board).

- **Oversight mode:** each project picks one under Project settings → Oversight & approvals; projects that have not chosen use the deployment default `deploy.oversight_mode` (`full` / `spot` / `exception`, default `spot`).
  - **Full oversight:** choices the AI makes on its own and plan changes it makes need your approval, and nothing is merged before that; every step's progress is pushed to you.
  - **Spot check** (default): what needs your call waits for you; choices the AI makes and plan changes are sent to you without blocking it; per-step reports are only recorded, while task-level progress is still pushed.
  - **Management by exception:** you are only disturbed when something departs from the norm: level Ⅰ spec choices go ahead with the AI's proposed default and you are told afterwards; day-to-day progress is only recorded.
- **Floors:** contract and plan approvals, sign-offs, disagreements, spending gates, security approvals and failures handed back to people always need a person in every mode. Decisions made for people by the system (timeouts, going ahead with a default), external actions in your name, security boundaries changed by the system and deployment failures are always notified in every mode and cannot be muted.
- **Approval gates:** on the same page, the lead lists commands that need a person's approval before they run, one per line; `*` matches any text and `?` one character, matching the whole command, case-insensitive (for example `git push*`, `*migrate*`, `kubectl apply*`, `psql*`). Each part of a command wrapped in `sh -c "…"` or joined with `&&`, `||`, `;` or `|` is checked, and leading variable assignments and tool paths are stripped first (`PGPASSWORD=x psql` and `/usr/bin/psql` are both recognized). The AI stops before a matching command and sends a "Security approval" item; answering "agree" allows that one command, and the identical command is not asked about again. The list is empty by default, and a lone `*` is not accepted. The page can "try a command" against the unsaved list.
- **Security approval:** approval gate hits, policy hooks asking for confirmation and MCP tools needing approval all send this kind of item. It has no default answer and is never decided by timeout; if nobody answers, work stays stopped. Routing tables without a row for it send it to whoever handles "system stuck"; to route it elsewhere, add a row under Project settings → Decision routing (the built-in templates already have one).
- **Kinds the system never decides for people:** structural conflicts, plan approvals, sign-offs, limit increases, network approvals, disagreements, security approvals and system-stuck items have no default answer; when they time out they are escalated, and if still unanswered they wait while the original recipients and the task owner are told.

## Notifications and pushes

- **Channels:** each person adds their own channels under Settings → Members (ntfy, Feishu, DingTalk, WeCom, email). Deployment-wide channels in `.env` (`NTFY_URL`, `MAIL_TO` and so on) are used only for administrators without a personal channel, and as a fallback when none of an item's recipients can be reached. Without any channel, items are still in the Inbox on the board.
- **"My notifications"** (in Settings): choose per kind of signal between "Push" and "Record only"; kinds with a floor say "always pushed" and cannot be changed. In the notifications card of the Inbox, each entry shows its kind and can stop pushes of that kind with one click (for all projects).
- **Urgency:** urgent items are pushed right away: level Ⅲ items (except sign-offs), security approvals, items already escalated or less than 2 hours from their deadline, external actions in your name, security boundaries changed by the system, and deployment failures. Everything else is not urgent, including sign-offs and items you are only informed about.
- **Working hours:** non-urgent items are pushed only during your working hours, weekdays 9–18 by default, in your own time zone and following the deployment's holidays; shifts across midnight are supported.
- **Digest:** non-urgent items are held and combined into one push at an interval (60 minutes by default), grouped by kind with items from the same project next to each other; if only one item is waiting, it is pushed as is.
- **Rate limit:** the number of times you are interrupted in an hour (a single push and a digest each count once) is 4 by default; after that, further items go to the front of the next digest. Level Ⅲ items (except sign-offs) and deployment failures are exempt.
- Each person changes these under "My notifications → When to push", which also shows how often they were interrupted in the last 7 days. Administrators change the deployment defaults in the same place; they correspond to `deploy.work_start_hour`, `deploy.work_end_hour` (24 = until midnight), `deploy.work_days_only`, `deploy.digest_every_min` (0 = no holding) and `deploy.push_cap_per_hour` (0 = no limit).
- **Item links and Quick reply:** every push ends with a link. A single item's link opens just that item, readable and answerable on a phone (spec choices, structural conflicts, system-stuck items and disagreements); sign-offs, security approvals, plan approvals, limit increases, network approvals and delivery link to the full task page. Digests link to the Inbox. Links use the dashboard address under Settings → Connections (`deploy.board_url`), or else the address the board was started with (`--public-url` in team mode, `127.0.0.1` in local mode); if the daemon runs on its own and no address is set, pushes carry no link. Links contain no credentials, so opening one requires the usual login.
- The daemon's `--digest-every` (periodic full to-do digests) is no longer used; for the full list, see the Inbox or the `digest` command.

## Email channel and reply by email

**Sending:** set `SMTP_URL` and `MAIL_FROM` in `.env` to enable the email channel; members register their own address under Settings → Members (CLI: `user channel <id> --email <address>`), and `MAIL_TO` is the deployment-wide address. Without these two variables, registered addresses are marked as not reachable yet.

- `SMTP_URL` forms: `smtps://user:password@smtp.example.com:465` (direct TLS); `smtp://user:password@smtp.example.com:587` (STARTTLS after connecting; if the server does not support it, nothing is sent, with no downgrade); `smtp://127.0.0.1:25` (local relay; plain text is allowed only for local addresses, and no password is sent over plain text). Write `@ : /` in user names and passwords as `%40 %3A %2F`.
- Certificates are verified as usual; the audit log records only the recipient's domain.

**Reply by email:** also set `IMAP_URL` to let people answer by replying to push emails.

- `IMAP_URL` forms: `imaps://user:password@imap.example.com:993`; the folder is INBOX by default, and another folder goes in the path (`imaps://…/Replies`); `imap://…:143` uses STARTTLS and does not fetch if the server lacks it. The daemon fetches unread mail once a minute, marks it read after processing and never deletes it.
- Replies go to `MAIL_REPLY_TO` (or `MAIL_FROM` if empty), and mail to that address must arrive in the `IMAP_URL` mailbox. If your provider supports plus addressing (Gmail, Outlook, Fastmail, your own Postfix and so on), write `reply+{token}@example.com`; replies from clients that drop In-Reply-To are then recognized too.
- Only spec choices, structural conflicts and system-stuck items can be answered by email, and only by the people who are asked; emails for other items, for people only informed, and digests say up front that replying has no effect.
- Write one line at the top of the reply (for example "B"); there is no need to delete the quoted text. Only the first reply counts, within 72 hours of the push; to change the answer later, do it on the board.
- The reply must come from the registered address; replies the receiving server marks as a DMARC / SPF failure do not count. Replies that do not count (expired, already answered, item not recognized and so on) get an explanation with a link; explanations go only to registered addresses, at most 10 per address per hour. Auto-replies, bounces and bulk mail are ignored.
- When mail cannot be fetched (`IMAP_URL` wrong, server unreachable), administrators are told once, and again once it recovers.

## Status reports

What happened over a period, computed per person without calling a model:

1. **Did anything go wrong:** deployment failures, security boundaries changed by the system, hard failures, stopped projects, timeouts nobody picked up, spending or call limits reached; "nothing went wrong" appears only when all of these are zero.
2. **Decided without waiting for you:** defaults taken on timeout, others changing your items, choices the AI made, plan changes it made, tasks the AI added, automatic model upgrades, external actions in your name, minor system fixes; kinds set to "Record only" are included too, marked as never pushed.
3. **Progress:** which tasks were merged.
4. **Spending**, and how many items are still waiting for you.

- Scope: members see what was sent to them and the projects they take part in; all projects is for administrators only (and their default). Detail: Exceptions only / Summary (at most 5 entries per section) / Full.
- See them any time on the "Status report" page in the sidebar: last 24 hours / 7 days / 30 days / last month, with entries linking to the item, task or project. CLI: `node src/cli.mjs report [--since 24h|7d|<date>] [--detail exceptions|summary|full] [--all] [--user <id|name>]` (`--all` and other people's reports are for administrators only).
- **Scheduled pushes:** each person sets the frequency (off / daily / weekly on a chosen day), time and detail under "My notifications"; otherwise the deployment defaults apply: `deploy.report_every` (`auto` / `off` / `day` / `week`), `deploy.report_day` (1 = Monday … 7 = Sunday), `deploy.report_hour` and `deploy.report_detail` (`auto` / `exceptions` / `summary` / `full`). `auto` follows the default oversight mode: a daily summary under Full oversight, a weekly summary under Spot check, and a weekly exceptions-only report under Management by exception; the default is Monday at 9:00. Times follow each person's time zone, and a day that is not a workday moves to the next workday at the same hour. Each report starts where the previous one ended, so nothing is missed or repeated. Reports are pushed on their own (not in a digest), only during working hours, and count toward the rate limit; long ones are cut, with the full report on the board.
- **"While you were away":** when you come back to the board after 8 hours or more (the page counts as being looked at only while it is visible and you are using it), the top of the Inbox shows how much happened and links to the report for that period.

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

**Upgrading from 0.4.x to 0.5.0:**

- **The database is upgraded automatically after a backup:** the first command you run migrates the database step by step from the 0.4.x version, after backing it up to `.superintern/backups/` (the file name contains `pre-v47`). A few tables (items, routing rules, tokens, the push queue) are rebuilt, so a large database takes a little longer. After the upgrade, 0.4.x code refuses to open the database; to go back, put the old code back and run `node src/cli.mjs db restore <that backup>`. Sandbox images have not changed, so there is no need to rerun `setup`.
- **These repository files now take effect:** `AGENTS.md` (and `AGENTS.override.md`, with `CLAUDE.md` as a fallback) is given in full to the executor and the reviewer; skills in `.agents/skills/` and `.claude/skills/` are offered to the AI; PreToolUse hooks in `.superintern/hooks.json` and `.claude/settings.json` run in the sandbox and may block what the AI does, and hooks before merge and before delivery count as blocking when they fail; servers in `.mcp.json` are only listed and are not given to the AI until the project lead approves them. Before upgrading, check whether your project repositories contain these files and whether their content is what you want the AI to follow. Also, changes the AI makes to rules files and hook files are sent back unless the contract's writable paths name them. See "Project rules, skills, hooks and MCP" above.
- **Fewer and later pushes:** pushes are now queued per person. By default, non-urgent items are pushed only during working hours (weekdays 9–18), combined into one digest every 60 minutes, and nobody is interrupted more than 4 times an hour; urgent items are still pushed right away. Working hours use each person's own time zone, otherwise the deployment time zone, otherwise UTC. Deployments outside UTC should set the deployment time zone under Settings → Time and calendar first, or working hours will be off. A person's own time zone now also sets their working hours and status report time, not only how times are shown. To push everything as soon as it happens, as before: set `deploy.digest_every_min` and `deploy.push_cap_per_hour` to 0, `deploy.work_start_hour` to 0, `deploy.work_end_hour` to 24 and `deploy.work_days_only` to `false`.
- **Deployment-wide notification channels no longer receive every item:** `NTFY_URL` and the others in `.env` are now used only for administrators without a personal channel, and as a fallback when none of the recipients can be reached. Members who relied on a shared deployment channel should add their own channel under Settings → Members.
- **Per-step reports are no longer pushed:** the default oversight mode is Spot check, where per-step reports are only recorded (they are still visible on the board); finished tasks, work waiting for a person and work waiting for delivery are still pushed. To keep getting every step, set the project's oversight mode to Full oversight (Project settings → Oversight & approvals).
- **Weekly status reports start arriving:** `deploy.report_every` defaults to `auto`, which under Spot check means a summary every Monday at 9:00 (in each person's time zone, pushed within working hours). To stop them, each person can turn them off under "My notifications", or an administrator can run `node src/cli.mjs user setting deploy.report_every off`.
- **The daemon's `--digest-every` is ignored:** if your scheduled task or systemd unit still passes it, the daemon prints a note at startup and runs normally; you can remove it from the arguments.
- **Some items no longer close by default:** structural conflicts, plan approvals, sign-offs, limit increases, network approvals, disagreements, security approvals and system-stuck items never have a default answer; when they time out they are escalated and then wait for a person. This also applies to such items still open at upgrade: the migration removes their stored default answer and raises level Ⅰ to level Ⅱ. On the other hand, questions asked during planning now have time limits (they used to wait indefinitely) and are escalated or settled by default according to their level once the limit passes.
- **New decision type "Security approval":** it is used when a hook asks for confirmation, an MCP tool needs approval or an approval gate is hit. Existing routing tables without a row for it send it to whoever handles "system stuck" (or else structural conflicts). To route it elsewhere, add a row under Project settings → Decision routing; the built-in templates already have one.
- **The executor's input gains a repository map:** up to 2048 tokens at the start of each step, so spending rises slightly. To turn it off: `node src/cli.mjs user setting deploy.repo_map_tokens 0`.
- **The GitHub App needs a few more read permissions:** watching PR CI needs read access to Checks, Commit statuses and Actions; GitHub issue intake needs read access to Issues. Add them in the App settings, then accept the new permissions on the organization's installation page. Without them, PR status and comments are still watched and the CI column says which permission is missing. PRs opened before the upgrade are not watched; only PRs opened afterwards are.
- **Delivering from the CLI authorizes AI follow-up by default:** for PRs opened with `deliver … --pr`, the AI fixes failed CI and pushes back to the same PR (at most 2 rounds). Add `--autofix off` if you do not want this; the board asks separately when you deliver.
- **Who can pause a task has changed:** people who took part in a task (an item was sent to them, or they answered one) can also pause it; the owner or whoever paused it can resume; only the owner can abort.
- **Pushes carry item links:** when started with the `start` scripts or `web --daemon`, links use the board's own address (in local mode this is `127.0.0.1`, reachable only through an SSH tunnel). If the daemon runs on its own, or links should use a different address, set the dashboard address under Settings → Connections (`deploy.board_url`); note that this address is also written into provenance links in commits and PRs.
- **New optional configuration:** the email channel and reply by email (`SMTP_URL`, `MAIL_FROM`, `MAIL_TO`, `IMAP_URL`, `MAIL_REPLY_TO` in `.env`; see `.env.example`); deployment-level skills, hooks and MCP configuration (`.superintern/skills/`, `.superintern/hooks.json`, `.superintern/mcp.json`); and the new deployment settings described in the sections above. Everything works without them.

## Everyday commands

```bash
node src/cli.mjs digest                 # my to-dos: who answers, who is pending, deadlines
node src/cli.mjs questions              # open questions
node src/cli.mjs answer <qid> "..."     # answer a question
node src/cli.mjs say <task> "..."       # correction / new instruction / extra information; --urgent interrupts the running step
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
node src/cli.mjs report --since 7d      # status report: what went wrong, what was decided without you, progress, spending
node src/cli.mjs rewind <task> <step>   # redo from a finished step: shows a preview; add --yes to apply
node src/cli.mjs skill list             # skills; hook list / hook trust manage hooks on the host
node src/cli.mjs mcp list --project <id>   # MCP server status; mcp check / mcp approve check and approve them
node src/cli.mjs project issues <id>    # GitHub issue intake; project schedule <id> manages schedules
```
