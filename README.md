# One Person Company

An operations dashboard for one person.

It connects to the services you already pay for — Stripe, Gmail, Cloudflare,
Search Console, App Store Connect, your host, your analytics — collects from
them on a schedule, keeps the history in a SQLite file on your own machine, and
gives an agent a bounded way to read that history and act on it.

Three things it is not, said plainly:

- **It is not multi-tenant.** One install, one owner. There are no user
  accounts, no roles and no sharing. The password protects the box from the
  network, not one person in it from another. Two people who want this run two
  copies.
- **It is not a hosted product.** It binds to `127.0.0.1` and expects to run on
  a machine you control. Exposing it is your deployment decision, and the
  section on reverse proxies below is the part that will bite you.
- **It is not a data source.** Nothing here invents a figure. A service you
  have not connected reports that it has nothing, and every number on a
  dashboard is either something a collector measured or a stated absence.

React and Vite in `client/`, a Hono API on Node in `server/`, one SQLite
database. No build step on the server — TypeScript runs directly.

## Getting started

You need **Node 24.18 or newer** (`engines` in `package.json` pins
`>=24.18 <27`; `.node-version` names the exact version CI uses) and npm.

```sh
npm run setup    # installs server and client from their lockfiles
npm run dev      # API watcher + Vite, together
```

The development UI is at `http://127.0.0.1:5180` and the API at
`http://127.0.0.1:8787`. The launcher checks both ports and wires the proxy, so
the browser only ever talks to its own origin.

Then, in the app: **Settings → General** runs the setup checks. Pick a model or
connect an agent in **Models**. Set a password in **Security** before you let an
agent anywhere near it. Connect what you actually use in **Integrations**.

`npm run check` is the whole gate — server and client tests, both typechecks,
the production build, lint, and the widget catalog check. CI runs exactly that
and nothing else.

| Command | Purpose |
|---|---|
| `npm run setup` | Install server and client dependencies from their lockfiles. |
| `npm run dev` | Start the API watcher and Vite together. |
| `npm run build` | Typecheck the server and build the production client. |
| `npm start` | Serve the API and the built client on one port. Build first. |
| `npm test` | Server and client tests, each with an isolated database. |
| `npm run check` | Everything CI runs. |
| `npm run doctor` | Runtime, storage, configuration, model and tool availability, build and last backup. Initialises the database if needed. A missing optional tool is not a failure. |
| `npm run install-service` | Print the launchd/systemd unit this machine would get. Installs nothing without `-- --install`. |
| `npm run uninstall-service` | Stop the service and remove its unit. The environment file and the logs stay. |
| `npm run service-status` | What the supervisor says, the measured isolation level, and the tail of the error log. |

## The security model

This is the unusual part, and it is load-bearing. Read it before you deploy
anything.

**One owner, one box.** There is one password. Sessions are browser cookies with
random tokens stored only as hashes; a public session id cannot be used to sign
in. Sessions expire after 30 days, or seven idle days.

**Credentials live in a local vault.** Every connected service's key is
encrypted with AES-256-GCM under a 32-byte key in `server/data/vault.key`, mode
0600, generated on first use. The entry name is the associated data, so a
ciphertext moved to another row fails to open rather than opening as the wrong
secret. No route ever returns a secret. What this buys is that a copy of the
database — a backup, a synced folder, a stray `scp` — carries ciphertext rather
than a live API token. What it does not buy is defence against someone who
already has the data directory, because the key is in it.

**There are two service keys, and they are not equivalent.**

- The **owner key**, `server/data/service-key`, is this process calling itself.
  It opens everything. Anything that can read that file already has the box —
  it sits beside the vault key — so presenting it is not a privilege the API can
  meaningfully withhold.
- The **agent key**, `server/data/agent-home/service-key.agent`, is what gets
  handed out: to the `opc` wrapper the agent types, and to the MCP subprocess.
  It is deliberately weaker.

**`OWNER_SURFACE` is the list of writes an agent may never perform.** It lives
in [`server/src/integrations/security/gate.ts`](server/src/integrations/security/gate.ts),
in one table, and that table is the only statement of the boundary — the
deployment page, `agentRefusal` and `npm run doctor` all read it rather than
restating it. It covers plugin writes, the whole of `/api/backups` (a restore
replaces the live database), and writes to `/api/security`, `/api/agents`,
`/api/models`, `/api/freellmapi`, `/api/searxng`, `/api/workspace`, `/api/setup`
and `/api/runtime`, plus narrower rows for mail approval and sending, nurture
identities, service installation and publishing.

Rows sit at one of three levels:

| Level | Accepts | For |
|---|---|---|
| `proof` | The owner key, a live session, **or** a browser-shaped request | Writes that change what the box *holds* — credentials, backups, which model completes |
| `browser` | Only a browser-shaped request; a key is refused | Writes that put a process on your machine or send something into the world under your name |
| `session` | Only a browser-shaped request that is signed in | Writes where "somebody at this keyboard" is not enough — mailing a list, changing a sending identity, revoking a session |

It is a **deny list, not an allow list**, and that is deliberate: the allow list
already exists in `server/src/skills/registry.ts`, which names every path an
agent may reach and refuses to compose a URL for anything else. `OWNER_SURFACE`
is the second lock for the case the registry cannot cover — an agent with a
shell can `curl` *without* sending the key it was handed. So the check does not
ask which key arrived; it asks whether the caller can show it is the owner. The
price of a deny list is that a route added tomorrow is reachable exactly as it
was yesterday, and that price is paid knowingly.

**The browser test is a heuristic and is documented as one.** It reads `Origin`
and `Sec-Fetch-Site`. Anything that can open a socket to this port can set those
headers, so it is not a cryptographic boundary. What it does is raise the bar
from "send nothing" to "deliberately impersonate a browser" — and at the
`separate-user` isolation level, the process on the other side of that bar also
cannot read the owner key.

Two isolation levels are measured and reported (Settings → Deployment, and
`npm run service-status`):

- **`same-user`** — the default. The agent gateway runs as you, with a built
  rather than inherited environment, its own empty working directory under
  `server/data/agent-home/`, and only the scoped key. The API boundary holds;
  the *filesystem* does not stop it reading `vault.key`.
- **`separate-user`** — name an account in Settings → Deployment, or set
  `OPC_AGENT_USER`, and the gateway is spawned through `sudo -n -u <user>`.
  `deploy/agent-user.sh` is the one-time setup; run it with no arguments to see
  exactly what it would do, `--apply` to perform it. That account owns the agent
  home and nothing else, so the vault key, the database and the owner key are
  unreadable to it.

A container is stronger than both — `deploy/agent.Dockerfile` and
`deploy/agent-compose.yml` are there — but this app does not build, start or
detect it, so it is never *reported* as a level. Moving up a level costs the
agent capability, which is the trade you are making.

## Deploying behind a reverse proxy — read this

**The owner-only routes are browser-only, and there is no CLI fallback for
`POST /api/security/login` or `POST /api/security/password`.** If a proxy in
front of the dashboard breaks the browser test, you cannot sign in and you
cannot change the password. There is no flag, no `--force` and no recovery
command.

Two things must hold.

1. **The proxy must forward the `Origin` header.** Some proxy configurations
   strip it. A request with no `Origin` and no `Sec-Fetch-Site` is
   indistinguishable from a script, and is refused at the `browser` level — which
   is exactly where login and the password change sit.
2. **The origin's port must be one the box recognises.** The allowed set is
   `PORT`, `OPC_UI_PORT`, and `5173` (Vite's default, kept so a fresh checkout
   that has never set `OPC_UI_PORT` still works). The host must be `localhost`
   or `127.0.0.1` over `http`. An `Origin` naming anything else is treated as
   foreign and refused. If your proxy terminates on `https://dash.example.com`
   and forwards that as the `Origin`, sign-in will fail.

The practical shape that works is a proxy that presents the same loopback origin
the browser would — or, more simply, not putting one in front at all and
reaching the box over an SSH tunnel or a private network, which is what
binding to `127.0.0.1` assumes.

**Recovery, if you have locked yourself out.** Stop the server, then against
`server/data/opc.db`:

```sh
sqlite3 server/data/opc.db 'DELETE FROM security_owner WHERE id = 1;'
```

Restart. The box is back in its shipped state — no password, the gate not
installed at all — and you can set a new password from the browser. This clears
the password, not your data.

Note that `GET /api/health` answers with no credential by design, because
`npm run restore` has to be able to ask whether the server is up before it
replaces a database. Once a password is set, an unauthenticated caller gets
liveness only: `ok`, the time, and `status: null` meaning "not run for you". The
full check names absolute paths, disk figures and the agent's last error, and
those describe the machine.

## Plugins

**Nothing is required.** The catalog has 64 integrations across revenue, SEO,
social, infrastructure, AI, comms, media and signals, and you can run this
having connected none of them.

Each is connected with its own credentials on its own page under Integrations.
Every field says which vault entry it writes to and which code reads it, and
those strings are the real ones. A plugin with no credential is **disconnected**,
which is a state the interface draws: its dashboards say so and report nothing.
They do not fail, they do not error, and they never show a sample figure dressed
as a measurement.

Each plugin with a collector has its own **Collect every (minutes)** setting.
Empty means the box default (`OPC_COLLECT_MINUTES`), `0` means never on a
schedule — its Collect button still works. The scheduler is **due-based**, so a
source whose last run is older than its cadence is collected within a minute of
the process starting; that is what lets a box that was asleep catch up. A
collection still running when the next is due does not start twice.

## Configuration

The API and the dev launcher load `server/.env`, or the file named by
`OPC_ENV_FILE`. Existing process environment values win. Relative data paths
resolve from `server/` regardless of the working directory. Copy
`server/.env.example` if you want a starting point; the defaults work.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | API and production site port. |
| `OPC_UI_PORT` | `5180` | Development UI port. Must differ from `PORT`. |
| `OPC_DATA_DIR` | `./data` | Database, keys and artifacts, relative to `server/`. |
| `OPC_COLLECT_MINUTES` | `30` | Default collection cadence. `0` disables the scheduler. |
| `OPC_RETAIN_DAYS` | `400` | Reading retention. |
| `OPC_LOAD_RETAIN_DAYS` | `30` | Server-load reading retention. |
| `OPC_AGENT_USER` | unset | Account to run the agent gateway as, for `separate-user` isolation. |
| `OPC_ENV_FILE` | `server/.env` | Where to read the above from. |

Ports, intervals and retention are validated at startup. The setup checks report
local readiness; they do not spend paid requests validating every external
credential.

## Running unattended

`npm run dev` is two processes in a terminal — closing the lid stops the
collectors, the agent and the nightly work. `npm run install-service` packages
the same process as a supervised service.

It defaults to a **dry run**: the unit and an environment template are written
to `deploy/out/` and printed, and nothing is installed.
`npm run install-service -- --install` performs it. Settings → Deployment does
the same from the browser and shows you the unit first.

| Platform | What is installed | Where |
|---|---|---|
| macOS | A launchd **user agent**, `RunAtLoad`, `KeepAlive: SuccessfulExit=false` — restarted when it dies badly, not when you stop it deliberately. | `~/Library/LaunchAgents/com.opc.server.plist` |
| Linux | A systemd **user service**, `Restart=on-failure`, `RestartSec=30`, capped at four starts in ten minutes. | `~/.config/systemd/user/opc.service` |

Neither needs root and neither writes outside your account. Both log to
`server/data/logs/` and read `deploy/opc.env`, which the installer creates once
and never overwrites.

Two limits are stated rather than worked around. A launchd **agent** runs only
while you are logged in; a Mac that must serve this across a reboot with nobody
at the keyboard wants a LaunchDaemon. A systemd **user** service stops at logout
unless you run `sudo loginctl enable-linger <user>`.

## Backups and recovery

Settings → Server manages full backups. One manifest covers the database, the
vault, service and SSH keys, screenshots, generated images, videos, papers and
supported agent configuration. Restore relocates stored artifact paths when the
data directory moves. **A preferences JSON export is not a backup.**

Stop the server first:

```sh
npm --prefix server run restore -- /absolute/path/opc-YYYYMMDD-HHMMSS.tar.gz
```

Replaced files are moved aside with a `.replaced-<timestamp>` suffix. Archives
contain credential keys and need the same access restrictions as the data
directory itself.

Dashboard layouts, session labels, workspace details and sidebar pins sync to
the server with revision checks; the browser keeps a cache and a conflicting
edit offers you both versions after saving a recovery copy. Theme and unsent
drafts stay browser-local. Settings → Data exports and imports preferences,
validated and confirmed before replacement, and **Restore previous preferences**
recovers the snapshot before that.

## Limits worth knowing

Settings → Usage limits caps job runtime, model calls, output tokens, and
job/daily/per-venture token or dollar allowances. Defaults are 900 seconds and
100 calls per job, 1,000 daily calls, and 4,096 output tokens per call; token
and dollar caps start disabled.

Capacity is reserved before a managed request, including concurrent ones, and
provider-reported usage settles the reservation. Dollar accounting uses a price
ceiling **you** configure, not provider billing — it is an estimate and is
labelled as one. Arbitrary tools, external subscriptions and other processes on
the machine are outside the ledger entirely.

Mail approval captures the exact account, sender, recipient, subject, text and
signature; editing invalidates the approval. An atomic send claim prevents a
double delivery. An interrupted or ambiguous send becomes a **Check delivery**
item, and those are never retried automatically — check the account's Sent
folder yourself before marking one as not sent.

## Documentation

- [`docs/shared-modules.md`](docs/shared-modules.md) — the shared layer both
  halves import, its signatures, and the traps that are easy to reintroduce.
- [`docs/roadmap.md`](docs/roadmap.md) — capability gaps, prioritised. Some are
  deliberate simplifications worth keeping.
- `server/README.md` — why the server exists, and why SQLite.

## Licence

**No licence has been chosen yet.** See [`LICENSE`](LICENSE). Until one is set,
the default applies: all rights reserved, and nobody else has permission to use,
copy or distribute this. **A licence must be chosen before this repository is
published.**
