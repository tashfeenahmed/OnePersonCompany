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
| `npm test` | Run server/client tests with isolated server databases. |
| `npm run check` | Tests, typechecks, production build, lint and widget catalog checks; also used by CI. |

Production startup supports direct navigation to app pages. Unknown API/asset URLs keep their error responses. The server binds to loopback; public hosting and TLS termination require separate deployment configuration.

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

Mail approval/sending, uncertain-delivery resolution and usage-limit changes require owner sign-in. Service credentials cannot access those controls or owner login/password/session-management endpoints. This is an API permission boundary: an unrestricted agent under the same OS account can still modify the database or read credential files. OS-level isolation is not implemented.

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
