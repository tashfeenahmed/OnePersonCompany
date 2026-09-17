# OPC render relay

The relay preserves the existing Stewie worker protocol after retiring Workdash.
Only rendering is served, on loopback port 3014. Telegram, chat, collectors and
schedules run in OPC; this process has none of those endpoints or timers.

The engine was migrated from Workdash. It retains its durable rendering queue,
page capture, worker polling and video download. Script inference happens in
OPC's selected model provider before a render can be queued. Search uses OPC's
SearXNG configuration and vault. It does not read Workdash's data or vault.

## Pi installation

Create `server/data/render-relay/settings.json` with `host`, `mac`, `user`,
`powerKey`, `llmUrl`, `workerUrl`, and optional `chromium`. These are local
deployment settings; do not commit the file or private keys. `powerKey` must name
the existing restricted Dell shutdown key. The relay never automatically shuts
the Dell down after a render.

The existing `workdash` integration ID is retained for database compatibility;
its display name is Render worker. Set its account URL to
`http://127.0.0.1:3014` and store a service key in OPC's encrypted vault. The relay
loads that key from the vault at startup. Restart the relay after rotating it.

Install `deploy/opc-render-relay.service` as a systemd **user** service beside
`opc.service`, then enable and start it. Its example path is `/opt/onepersoncompany`.

State lives in `server/data/render-relay`: `reel.json`, `queue.json`, `joblog.json`,
`videos/`, and `captures/`. Copy only finished legacy reels and their referenced
files when migrating. Never replay the old application's job queue. Keep the old
application files and a database backup for rollback.

Before retiring Workdash, check authenticated status, script preparation, an
existing video download, and worker health. Verify OPC's Telegram bridge has
actually handled a message and sent a Hermes reply. Stop and disable only units
whose executable belongs to Workdash; preserve every unrelated service on the box.

Run checks with `node --import ./server/test/setup.mjs --experimental-strip-types --test 'server/render-relay/*.test.mjs'`.
