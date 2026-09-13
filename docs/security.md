# Security and data ownership


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
in [`server/src/integrations/security/gate.ts`](../server/src/integrations/security/gate.ts),
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


See [deployment and recovery](deployment.md) before exposing an installation, and [SECURITY.md](../SECURITY.md) for vulnerability reporting.
