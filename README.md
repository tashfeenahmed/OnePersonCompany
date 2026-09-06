# One Person Company

A local, single-owner workspace for ventures, dashboards, conversations, mail and background jobs. React talks to a Hono API backed by SQLite.

## Getting started

Use Node **24.18.0** (pinned in `.node-version`) and npm. From this directory:

```sh
npm run setup
npm run dev
```

Optionally copy `server/.env.example` to `server/.env` before starting; preserve an existing environment file. The development UI runs at `http://127.0.0.1:5180`; the API listens on `127.0.0.1:8787`. The launcher checks both ports and configures the API proxy.

Settings → General shows setup checks. Choose a model or agent in Models, enable owner sign-in in Security, then connect the services you need in Integrations. Disconnected dashboards show connection/data status without sample measurements.

Board has its own sidebar entry. Mail contains Email, Triage and Outbox; Social media contains Studio, Autopilot and Video. SEO & growth contains SEO, SERP, ASO and Growth. Email stats is a fixed report under Dashboards. Sub-agent outputs groups Research, Competitors, Demand, AI visibility and Papers; Ops lives under Manage. Old Apps links redirect to their new destinations, preserving query parameters and run IDs. Navigation sections and sessions share one scroll area, with animated section controls that respect reduced-motion preferences.

| Command | Purpose |
|---|---|
| `npm run setup` | Install server/client dependencies from their lockfiles. |
| `npm run dev` | Start the API watcher and Vite together. |
| `npm run build` | Typecheck the server and build the production client. |
| `npm start` | Serve the API and built client on the API port; build first. |
| `npm run doctor` | Print local runtime, storage, configuration, model/tool availability, build and last-backup information. Initializes the database if needed. Missing optional tools do not make it fail. |
| `npm run install-service` | Print the launchd/systemd unit this machine would get and write it to `deploy/out/`. Installs nothing without `-- --install`. |
| `npm run uninstall-service` | Stop the service and remove its unit. The environment file and the logs stay. |
| `npm run service-status` | What the supervisor says, the isolation level and the last lines of the error log. Exits non-zero when the service is installed and not running. |
| `npm test` | Run server/client tests with isolated server databases. |
| `npm run check` | Tests, typechecks, production build, lint and widget catalog checks; also used by CI. |

Production startup supports direct navigation to app pages. Unknown API/asset URLs keep their error responses. The server binds to loopback; public hosting and TLS termination require separate deployment configuration.

## Running unattended

`npm run dev` is two processes in a terminal; closing the lid stops the collectors, the agent and the nightly work. `npm run install-service` packages the same process as a supervised service for the platform you are on.

It defaults to a **dry run**: the unit and an environment template are written to `deploy/out/` and printed, and nothing is installed. `npm run install-service -- --install` performs it. Settings → Deployment does the same from the browser and shows the unit before offering the button.

| Platform | What is installed | Where |
|---|---|---|
| macOS | A launchd **user agent** with `RunAtLoad` and `KeepAlive: SuccessfulExit=false` — restarted when it dies badly, not when it is stopped deliberately. | `~/Library/LaunchAgents/com.opc.server.plist` |
| Linux | A systemd **user service** with `Restart=on-failure`, `RestartSec=30` and a start-rate cap of four in ten minutes. | `~/.config/systemd/user/opc.service` |

Neither needs root and neither writes outside your account. Both log to `server/data/logs/opc.out.log` and `opc.err.log` and read their environment from `deploy/opc.env`, which the installer creates once and never overwrites.

Two limits are stated rather than worked around. A launchd **agent** runs only while you are logged in; a Mac that must serve this across a reboot with nobody at the keyboard wants a LaunchDaemon, which runs as root before login. A systemd **user** service stops at logout unless you run `sudo loginctl enable-linger <user>`.

`GET /api/health` still answers `ok: true` whenever the process replies — `npm run restore` depends on that — and now also carries a `status` of `ok`/`warn`/`fail` over five checks: the database opens and passes `quick_check`, every migration this build ships is applied, connected sources have collected within their own cadence, the managed agent is in the state it was asked to be in, and there is disk left. Each check reports the figures and thresholds it used. Settings → Deployment draws the same document, plus the service state, a log tail and the schedule.

That probe answers with no credential, because `npm run restore` has to be able to ask whether the server is up before it replaces a database. So once a **password is set**, an unauthenticated caller gets liveness only — `ok`, the time, and `status: null` meaning "not run for you". The checks name absolute paths, disk figures and the agent's last error, and those describe the machine. With no password nothing is withheld, which is the shipped state.

### Per-source collection cadence

`OPC_COLLECT_MINUTES` is now the **default** rather than the only schedule. Every plugin with a collector has a **Collect every (minutes)** setting on its own Integrations page: empty means the box default, `0` means never on a schedule (its Collect button still works), and the scheduler checks once a minute so a cadence is honoured to within a minute. A collection still running when the next is due does not start twice.

One thing genuinely differs from the old single timer: the schedule is now **due-based**, so a source whose last run is already older than its cadence is collected within a minute of the process starting, where before the first collection was always a full interval after boot. That is what makes a box that was asleep catch up. On a development box under `node --watch`, where saving a file restarts the server, it also means a sweep shortly after most restarts; `OPC_COLLECT_MINUTES=0` turns the scheduler off if that is unwanted.

`npm start` serves the built client from `client/dist` on the API port, so one supervised process is the whole app. Build first.


## Configuration

The API and development launcher load `server/.env`, or the file named by `OPC_ENV_FILE`. Existing process environment values take precedence. Relative data paths resolve from the `server` directory regardless of the startup working directory.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | API/production website port. |
| `OPC_UI_PORT` | `5180` | Development UI port; must differ from `PORT`. |
| `OPC_DATA_DIR` | `./data` | Database, keys and artifacts, relative to `server`. |
| `OPC_COLLECT_MINUTES` | `30` | Collection interval; `0` disables this scheduler. Other enabled automations have separate schedules. |
| `OPC_RETAIN_DAYS` | `400` | Reading retention. |
| `OPC_LOAD_RETAIN_DAYS` | `30` | Server-load reading retention. |

Port, interval and retention values are validated at startup. Setup checks report local readiness; they do not validate every external credential through paid requests.

## Workspace and recovery

Dashboard layouts, session labels/associations, workspace details, app order and sidebar pins synchronize to the server with revision checks. Pages and sessions share the Pinned section at the top of the sidebar; hover or focus a row to pin it, then drag its handle to reorder (or use Up/Down, Home/End). Existing favorites become page pins. The browser keeps a cache. Conflicting edits show a choice between server and browser versions, with a recovery copy saved first. Theme and unsent chat/mail drafts remain browser-local.

Settings → Data exports/imports preferences. Imports are validated and confirmed before replacement. Reset restores workspace/layout defaults while keeping server ventures, chats and accounts. **Restore previous preferences** recovers the preceding snapshot. The recovery screen can export or clear invalid cached state.

Settings → Server manages full backups. A shared manifest covers the database, vault/service/SSH keys, screenshots, Studio images, videos, papers and supported Hermes configuration/skills. Restore relocates stored artifact paths when the data directory changes. A preferences JSON export is not a full backup.

Stop the server before restoring:

```sh
npm --prefix server run restore -- /absolute/path/opc-YYYYMMDD-HHMMSS.tar.gz
```

Replaced files are moved aside with a `.replaced-<timestamp>` suffix. Archives contain credential keys and need the same access restrictions as the data directory. Old archives cannot restore files they never contained.

## Owner controls and mail

Set the owner password before enabling agents. Browser sessions have separate random cookie tokens, stored only as hashes; public session IDs cannot sign in. Sessions expire after 30 days or seven idle days. Migration revokes old-format sessions, so existing browsers may need to sign in again.

Mail approval/sending, uncertain-delivery resolution and usage-limit changes require owner sign-in. Service credentials cannot access those controls or owner login/password/session-management endpoints.

### What the agent can and cannot reach

There are two service keys, not one. The **owner key** (`server/data/service-key`) is this process calling itself and opens everything. The **agent key** (`server/data/agent-home/service-key.agent`) is what is handed out — to the `opc` wrapper the agent types and to the MCP subprocess.

A small set of paths is the **owner surface**: `/api/plugins` writes, the whole of `/api/backups` (a restore replaces the live database), and writes to `/api/security`, `/api/agents`, `/api/models`, `/api/freellmapi`, `/api/searxng`, `/api/workspace` and `/api/setup`. A request there is refused with a 403 naming the reason **unless it can show it is the owner's**: it carries the owner key, it carries a signed-in session, or it is shaped like a request from your own browser (a loopback `Origin`, or `Sec-Fetch-Site: same-origin`). Sending no credential at all is refused, which is the case that matters — an agent with a shell does not have to send the key it was given. Anything re-issued by the skills proxy is refused there too, whichever key it carries.

The browser test is a **heuristic**, not a cryptographic boundary: anything that can open a socket to this port can set those headers. What it does is raise the bar from "send nothing" to "deliberately impersonate a browser", and at `separate-user` the thing on the other side of that bar also cannot read the owner key. This applies whether or not a password is set, because a box with no password is the shipped state.

Settings → Deployment reports the **measured** isolation level and `npm run service-status` prints it:

- **same-user** — the default. The gateway runs as you, with a built (not inherited) environment, its own empty working directory under `server/data/agent-home/<agent>/`, and only the scoped key. The API boundary above holds; the **filesystem** does not stop it reading `vault.key` or the database.
- **separate-user** — name an account in Settings → Deployment (or `OPC_AGENT_USER`) and the gateway is spawned through `sudo -n -u <user>`. `deploy/agent-user.sh` is the one-time setup: run it with no arguments to see exactly what it would do, `--apply` to perform it. That account owns the agent home and nothing else, so `vault.key`, the database and the owner key are unreadable to it.
Those are the only two levels, because they are the only two anything here can measure. **A container is stronger than both** — `deploy/agent.Dockerfile` and `deploy/agent-compose.yml` run only the gateway, with nothing mounted — but this app does not build it, start it or detect it, so it is never reported as a level; the isolation report carries a `containerPath` that says exactly that. It also needs the API reachable from a container, which it is not: the server binds `127.0.0.1` deliberately. `deploy/agent-compose.yml` sets out the two real options and what each costs.

`deploy/agent-user.sh` grants exactly two commands (`hermes gateway run`, `openclaw gateway run`) through a `visudo`-checked sudoers file, and leaves the scoped key **owned by you** and group-readable by the agent — the API has to be able to rewrite that file, and the agent only has to read it.

Moving up a level costs the agent capabilities: at `separate-user` it can no longer read your files, and in a container it has no shell on your machine at all. Read `deploy/agent.Dockerfile` before choosing the last one.

Approval captures the exact account, sender, recipient, subject, text and signature. Editing invalidates approval. An atomic send claim prevents concurrent delivery and reserves daily capacity. Interrupted or ambiguous sends become **Check delivery** items. Inspect that account's Gmail Sent folder before marking a message as not sent and retrying; uncertain deliveries are never automatically retried.

Mailbox/Triage **Draft reply** carries account/thread context. The composer offers From/venture selection, local draft persistence and a conversation backlink. Outbox views are paginated.

## Jobs, budgets and daily work

Sub-agents → Queue controls pauses the queue, holds waiting jobs and changes their order. Pausing allows the running job to finish. Failed/cancelled jobs can be retried from saved inputs as new jobs, preserving their reports. **AI visibility** also resumes saved model steps. Other job types use retry because their tools/external effects cannot be replayed safely by a generic resume mechanism. Missed daily rounds coalesce into one catch-up run.

Settings → Usage limits controls job runtime, model calls, output tokens, and job/daily/per-venture token or estimated-dollar allowances. Defaults: 900 seconds per job, 100 calls per job, 1,000 daily calls, 100 scheduled/direct-background calls and 4,096 output tokens per call. Token/dollar caps start disabled; zero model calls stops model work.

Capacity is reserved before managed requests, including concurrent ones. Provider-reported usage settles reservations; ambiguous/missing usage remains estimated. Dollar accounting uses an owner-configured price ceiling, not provider billing. Unmetered agents, video and screenshot QA are blocked when token/dollar limits are enabled. Arbitrary tools, external subscriptions and other processes remain outside the ledger.

The Action inbox combines alerts, commitments, reply triage, failed jobs and revenue follow-ups. Open the source, snooze, send an item to a board, or resolve it. Resolution updates the source's completion state where available; dismissing a failed job preserves its report.

## App-store revenue tools

Connecting App Store Connect or Google Play enables the agent's `mobile` skill. Hermes receives the `app-store-revenue` skill pack; OpenClaw receives the read-only `opc_mobile` tool. Managed agents synchronize their available tools after plugin connections change, with a one-minute settle window before restarting an active agent.

Use `opc mobile revenue --store appstore --month 2026-08` or `opc mobile revenue --store playstore --month 2026-08`. The MCP equivalent is `opc_mobile` with `view: "revenue"`, `store`, and `month`. Omit the month for the latest financial report available per store, or use `store=all` for both. The HTTP view is `/api/skills/mobile?view=revenue&store=all&month=2026-08`.

Results separate currencies, accounts and apps, identify missing reports and partial coverage, and include collection dates and errors. They read collected reports and do not trigger a fresh collection. A missing report is never revenue of zero. Apple's fiscal months and Google Play's report months can differ; net proceeds are not proof of a bank deposit. Sales estimates remain separate in the default mobile view. Report sources: [Apple financial reports](https://developer.apple.com/help/app-store-connect/getting-paid/download-financial-reports/) and [Google Play financial exports](https://support.google.com/googleplay/android-developer/answer/6135870?hl=en).

## Verification

[PROJECT_REVIEW.md](PROJECT_REVIEW.md) is the original audit. [FIX_PROGRESS.md](FIX_PROGRESS.md) maps all 33 findings to changes and verification. CI includes full server strict checking and an incremental client strict target. Desktop/mobile browser checks used temporary data; real email delivery and paid jobs were not used for verification.
