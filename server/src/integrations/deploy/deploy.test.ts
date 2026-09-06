/**
 * The deploy area's tests — the arithmetic and the refusals, not the machine.
 *
 * NOTHING HERE INSTALLS A SERVICE OR TALKS TO A SUPERVISOR. `launchctl` and
 * `systemctl` change the machine the test suite is running on, so the service
 * half is tested at the level that can be: the generated unit text, which is a
 * pure function of the plan and is the artefact somebody actually reads.
 *
 * The lease tests are the ones that matter. Every one of them is a claim the
 * power routes now depend on: that an expired lease stops being live without
 * anything firing, that a release is idempotent, that a heartbeat cannot
 * resurrect a released lease, and that sleeping is refused for the two
 * separate reasons with the two separate words.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { db } from "../../db.ts";
import * as leases from "./leases.ts";
import { intervalMinutes, withCollectCadence, CADENCE_KEY } from "./cadence.ts";
import { dueNow, schedules } from "./scheduler.ts";
import { launchdPlist, systemdUnit, plan, envText } from "./service.ts";
import { isolation } from "./isolation.ts";
import { setConfig, upsertPlugin } from "../../db.ts";

/* ------------------------------------------------------------------ leases */

test("a lease is live until it expires, and then is not", () => {
  const l = leases.acquire({ kind: "video", resource: "test:1", note: "unit test" });
  assert.equal(l.live, true);
  assert.equal(leases.busy("test:1").busy, true);

  /* Reach into the row rather than waiting ten minutes. Nothing fires when a
     lease lapses — that is the design — so moving the deadline is the whole
     of what "time passed" means here. */
  db.prepare("UPDATE job_leases SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), l.id);

  assert.equal(leases.busy("test:1").busy, false);
  assert.equal(leases.live("test:1").length, 0);
  assert.equal(leases.stale().some((s) => s.id === l.id), true);
});

test("release is idempotent and a released lease cannot be heartbeated back", () => {
  const l = leases.acquire({ kind: "studio", resource: "test:2" });
  const first = leases.release(l.id, "done");
  assert.equal(first?.releasedAt !== null, true);
  const second = leases.release(l.id, "done again");
  assert.equal(second?.releaseReason, "done", "the first reason stands; a second release does not rewrite it");
  assert.equal(leases.heartbeat(l.id), null);
});

test("a heartbeat pushes the deadline forward", () => {
  const l = leases.acquire({ kind: "video", resource: "test:3", ttlMinutes: 1 });
  const before = Date.parse(l.expiresAt);
  const after = leases.heartbeat(l.id, 30);
  assert.ok(after, "a live lease can be heartbeated");
  assert.ok(Date.parse(after.expiresAt) > before, "the deadline moved");
  leases.release(l.id);
});

test("a TTL is clamped rather than refused", () => {
  const l = leases.acquire({ kind: "video", resource: "test:4", ttlMinutes: 100_000 });
  const minutes = (Date.parse(l.expiresAt) - Date.parse(l.acquiredAt)) / 60_000;
  assert.ok(minutes <= leases.MAX_TTL_MINUTES + 1, `clamped to ${leases.MAX_TTL_MINUTES} minutes, got ${minutes}`);
  leases.release(l.id);
});

test("an unknown lease kind becomes `other` rather than being stored raw", () => {
  const l = leases.acquire({ kind: "mining-bitcoin", resource: "test:5" });
  assert.equal(l.kind, "other");
  leases.release(l.id);
});

test("sleep is refused while a lease is live, and the refusal names the holder", () => {
  const l = leases.acquire({ kind: "video", resource: "test:sleep", note: "a render" });
  const check = leases.sleepCheck("test:sleep");
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "busy");
  assert.match(check.refusal ?? "", /video/);
  assert.match(check.refusal ?? "", /a render/);
  leases.release(l.id);
  assert.equal(leases.sleepCheck("test:sleep").allowed, true);
});

test("a machine found awake is never slept by this app until the wake is handed back", () => {
  leases.recordWake({ resource: "test:guest", by: "the test", foundState: "awake" });
  const guest = leases.sleepCheck("test:guest");
  assert.equal(guest.allowed, false);
  assert.equal(guest.reason, "not-ours");

  leases.releaseWake("test:guest");
  assert.equal(leases.sleepCheck("test:guest").allowed, true);
});

test("a machine this app woke may be slept", () => {
  const wake = leases.recordWake({ resource: "test:ours", by: "the test", foundState: "asleep" });
  assert.equal(wake.owns, true);
  assert.equal(leases.sleepCheck("test:ours").allowed, true);
});

test("sweeping stale leases marks them released with a reason, and leaves live ones alone", () => {
  const dead = leases.acquire({ kind: "video", resource: "test:sweep" });
  const alive = leases.acquire({ kind: "video", resource: "test:sweep" });
  db.prepare("UPDATE job_leases SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), dead.id);

  const released = leases.releaseStale();
  assert.ok(released >= 1);
  assert.match(leases.read(dead.id)?.release_reason ?? "", /swept/);
  assert.equal(leases.read(alive.id)?.released_at, null);
  leases.release(alive.id);
});

/* ----------------------------------------------------------------- cadence */

test("an empty cadence setting means the box default, and 0 means never", () => {
  upsertPlugin("test-cadence", true, null);
  assert.equal(intervalMinutes("test-cadence", 30), 30);
  setConfig("test-cadence", CADENCE_KEY, "5");
  assert.equal(intervalMinutes("test-cadence", 30), 5);
  setConfig("test-cadence", CADENCE_KEY, "0");
  assert.equal(intervalMinutes("test-cadence", 30), null, "0 is never, not zero minutes");
  setConfig("test-cadence", CADENCE_KEY, "");
  assert.equal(intervalMinutes("test-cadence", 30), 30);
});

test("the cadence key is added to collectable plugins and to nothing else", () => {
  const registry = withCollectCadence({ alpha: { keys: { existing: { label: "x", hint: "y" } } } }, ["alpha", "beta"], 30);
  assert.ok(registry.alpha?.keys[CADENCE_KEY], "added beside the existing key");
  assert.ok(registry.alpha?.keys.existing, "the existing key survived");
  assert.ok(registry.beta?.keys[CADENCE_KEY], "a plugin with no settings gains a settings page with one key");
  assert.equal(Object.keys(registry).length, 2, "no plugin was invented");
});

test("a cadence check refuses anything that is not a whole number of minutes", () => {
  const key = withCollectCadence({}, ["alpha"], 30).alpha!.keys[CADENCE_KEY]!;
  assert.equal(key.check?.(""), null, "empty is the default and is allowed");
  assert.equal(key.check?.("15"), null);
  assert.ok(key.check?.("15.5"));
  assert.ok(key.check?.("soon"));
  assert.ok(key.check?.("99999"), "longer than a week is not a schedule");
});

/* --------------------------------------------------------------- scheduler */

test("a source is due when it has never run, and not due until its cadence has elapsed", () => {
  upsertPlugin("test-sched", true, null);
  const collectors = { "test-sched": async () => ({ ok: true }) };
  assert.deepEqual(dueNow(collectors, 30), ["test-sched"], "nothing has run, so it is due");

  db.prepare("INSERT INTO runs (plugin_id, started_at) VALUES (?, ?)").run("test-sched", new Date().toISOString());
  assert.deepEqual(dueNow(collectors, 30), [], "just ran, so it is not");

  const row = schedules(collectors, 30)[0]!;
  assert.equal(row.everyMinutes, 30);
  assert.equal(row.custom, false, "nobody typed this cadence");
  assert.ok(row.nextDueAt, "a source that has run knows when it is next due");
});

test("a disconnected source is never collected however due it looks", () => {
  upsertPlugin("test-off", false, null);
  assert.equal(dueNow({ "test-off": async () => ({ ok: true }) }, 30).includes("test-off"), false);
});

/* ----------------------------------------------------------------- service */

test("the generated launchd plist restarts on failure and never unconditionally", () => {
  const p = plan();
  const text = launchdPlist({ node: p.node, entry: p.entry, root: p.root, outLog: p.outLog, errLog: p.errLog, user: p.user });
  assert.match(text, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.doesNotMatch(text, /<key>KeepAlive<\/key>\s*<true\/>/, "a bare KeepAlive would fight a deliberate stop");
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(text.includes(p.outLog) && text.includes(p.errLog));
  assert.ok(text.includes("--experimental-strip-types"));
});

test("the generated systemd unit restarts on failure and caps the retries", () => {
  const p = plan();
  const text = systemdUnit({ node: p.node, entry: p.entry, root: p.root, outLog: p.outLog, errLog: p.errLog, user: p.user });
  assert.match(text, /^Restart=on-failure$/m);
  assert.match(text, /^StartLimitBurst=\d+$/m);
  assert.match(text, /^WantedBy=default\.target$/m);
  assert.ok(text.includes(p.outLog));
});

test("the environment file carries paths and numbers and no credential", () => {
  const text = envText();
  assert.match(text, /^PORT=\d+$/m);
  assert.match(text, /^OPC_DATA_DIR=/m);
  /* Only the ASSIGNMENTS are checked; the comment above them names vault.key
     on purpose, to say where a secret does live. */
  const assignments = text.split("\n").filter((l) => /^[A-Z_]+=/.test(l));
  assert.ok(assignments.length >= 4);
  assert.equal(assignments.some((l) => /KEY|TOKEN|SECRET|PASSWORD/i.test(l)), false);
});

/* --------------------------------------------------------------- isolation */

test("the isolation report measures rather than claims", () => {
  const iso = isolation();
  assert.equal(iso.level, "same-user", "with no agent user configured this is the shipped state");
  assert.ok(iso.summary.includes(iso.runningAs));
  assert.ok(iso.scopedKey.refusedPrefixes.some((r) => r.prefix === "/api/backups"), "restore is on the refused list");
  assert.ok(iso.scopedKey.refusedPrefixes.some((r) => r.prefix === "/api/plugins"), "credentials are on the refused list");
  assert.notEqual(iso.agentHome, iso.files[0]?.path, "the agent home is not a credential file");
});
