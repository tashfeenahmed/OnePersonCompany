# Deployment, configuration, and backups

Run One Person Company on a machine you control. The standard setup is one owner per installation, served on loopback.

## Production build

```sh
npm run setup
npm run build
npm start
```

Open http://127.0.0.1:8787. The server serves both the API and the built client.

For YouTube Shorts, install a current official yt-dlp executable (or
`yt-dlp[default]` in an isolated Python environment) and set its path in the
Video integration. OPC enables its Node runtime and the official EJS solver
for YouTube downloads, and refreshes extraction once after a media HTTP 403.
An outdated downloader or a system Python dependency conflict can break downloads
even when YouTube search still works. See [yt-dlp's runtime and EJS setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

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


## Reverse proxies and remote access

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


## Usage controls


Settings → Usage limits caps job runtime, model calls, output tokens, and
job/daily/per-venture token or dollar allowances. Defaults are 7,200 seconds
(two hours — a local model on modest hardware needs well over fifteen minutes
for an agent run with tools) and 100 calls per job, 1,000 daily calls, and
4,096 output tokens per call; token and dollar caps start disabled.

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
