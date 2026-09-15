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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLLECT_MINUTES, LOAD_RETAIN_DAYS, RETAIN_DAYS } from "../../config.ts";
import { test } from "node:test";
import { db } from "../../db.ts";
import * as leases from "./leases.ts";
import { intervalMinutes, withCollectCadence, CADENCE_KEY } from "./cadence.ts";
import { dueNow, schedules } from "./scheduler.ts";
import { launchdPlist, systemdUnit, plan, envText } from "./service.ts";
import { healthFor } from "./health.ts";
import { isolation, levelFor } from "./isolation.ts";
import { agentRefusal, authenticatedRequest, browserShaped, levelRefusal, ownerSurfaceRefusal } from "../security/gate.ts";
import { PORT, UI_PORT } from "../../config.ts";
import { agentKey, serviceKey } from "../../auth.ts";
import { foundState } from "../security/workstation.ts";
import { setConfig, upsertPlugin } from "../../db.ts";

/**
 * A REQUEST, WITH ONLY THE FOUR THINGS THE GATE ACTUALLY READS.
 *
 * The alternative is standing a Hono app up and routing through it, which
 * would test Hono. `ownerSurfaceRefusal` reads a method, a path and headers
 * two ways (`c.req.header` and `c.req.raw.headers`), so that is what this
 * builds — and the cast is narrow enough that a change to what the gate reads
 * fails here rather than passing on a stub that no longer resembles a request.
 */
function request(method: string, path: string, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  return {
    req: {
      method,
      path,
      raw: { headers: h },
      header: (name: string) => h.get(name) ?? undefined,
    },
  } as unknown as Parameters<typeof ownerSurfaceRefusal>[0];
}

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
  /* Forced, because a lease taken a millisecond ago is by definition still
     beating and the unforced path now refuses it — which is its own test
     below. */
  const first = leases.release(l.id, "done", { force: true });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.lease.releasedAt !== null, true);
  const second = leases.release(l.id, "done again");
  assert.equal(second.ok && second.lease.releaseReason, "done", "the first reason stands; a second release does not rewrite it");
  assert.equal(leases.heartbeat(l.id), null);
});

test("a heartbeat pushes the deadline forward", () => {
  const l = leases.acquire({ kind: "video", resource: "test:3", ttlMinutes: 1 });
  const before = Date.parse(l.expiresAt);
  const after = leases.heartbeat(l.id, 30);
  assert.ok(after, "a live lease can be heartbeated");
  assert.ok(Date.parse(after.expiresAt) > before, "the deadline moved");
  leases.release(l.id, "test cleanup", { force: true });
});

test("a TTL is clamped rather than refused", () => {
  const l = leases.acquire({ kind: "video", resource: "test:4", ttlMinutes: 100_000 });
  const minutes = (Date.parse(l.expiresAt) - Date.parse(l.acquiredAt)) / 60_000;
  assert.ok(minutes <= leases.MAX_TTL_MINUTES + 1, `clamped to ${leases.MAX_TTL_MINUTES} minutes, got ${minutes}`);
  leases.release(l.id, "test cleanup", { force: true });
});

test("an unknown lease kind becomes `other` rather than being stored raw", () => {
  const l = leases.acquire({ kind: "mining-bitcoin", resource: "test:5" });
  assert.equal(l.kind, "other");
  leases.release(l.id, "test cleanup", { force: true });
});

test("sleep is refused while a lease is live, and the refusal names the holder", () => {
  const l = leases.acquire({ kind: "video", resource: "test:sleep", note: "a render" });
  const check = leases.sleepCheck("test:sleep");
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "busy");
  assert.match(check.refusal ?? "", /video/);
  assert.match(check.refusal ?? "", /a render/);
  leases.release(l.id, "test cleanup", { force: true });
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
  leases.release(alive.id, "test cleanup", { force: true });
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
  assert.equal(text.split("\n").find((line) => line.startsWith("WorkingDirectory=")), `WorkingDirectory=${p.root}`,
    "systemd reads WorkingDirectory as a literal path, so shell quotes make it non-absolute");
});

test("the generated environment carries the existing server/.env across rather than dropping it", () => {
  /* THE BUG THIS PINS. `config.ts` reads OPC_ENV_FILE *or* server/.env, never
     both, and the unit sets OPC_ENV_FILE — so a generated file that did not
     carry the old one across would silently un-set everything in it the
     moment the service was installed. */
  const dir = mkdtempSync(join(tmpdir(), "opc-env-"));
  const existing = join(dir, ".env");
  writeFileSync(
    existing,
    ["# a comment", "", "PORT=9999", "OPC_COLLECT_MINUTES=10", "SOMETHING_ELSE=kept", "MALFORMED"].join("\n"),
  );
  const text = envText(existing);
  const values = Object.fromEntries(
    text.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  assert.equal(values.PORT, "9999", "an existing value wins over the generated default");
  assert.equal(values.OPC_COLLECT_MINUTES, "10", "including the cadence, which was hard-coded to 30 before");
  assert.equal(values.SOMETHING_ELSE, "kept", "a name this app does not define is carried across, not dropped");
  assert.ok("OPC_DATA_DIR" in values, "and the ones it does define are still written");
  assert.match(text, /THIS FILE REPLACES server\/\.env/, "and the file says so, because somebody will edit the wrong one");
  rmSync(dir, { recursive: true, force: true });
});

test("the generated environment reflects live config when there is no existing file", () => {
  const values = Object.fromEntries(
    envText(join(tmpdir(), "opc-no-such-env-file"))
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  assert.equal(values.OPC_COLLECT_MINUTES, String(COLLECT_MINUTES), "from config.ts, not a constant");
  assert.equal(values.OPC_RETAIN_DAYS, String(RETAIN_DAYS));
  assert.equal(values.OPC_LOAD_RETAIN_DAYS, String(LOAD_RETAIN_DAYS));
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
  /* NOT `iso.level === "same-user"` — the first version of this asserted that
     and would have failed on the very machine the feature is for, one with
     OPC_AGENT_USER set. The level is asserted from explicit inputs below. */
  assert.ok(iso.summary.includes(iso.runningAs));
  assert.ok(iso.scopedKey.refusedPrefixes.some((r) => r.prefix === "/api/backups"), "restore is on the refused list");
  assert.ok(iso.scopedKey.refusedPrefixes.some((r) => r.prefix === "/api/plugins"), "credentials are on the refused list");
  assert.notEqual(iso.agentHome, iso.files[0]?.path, "the agent home is not a credential file");
  assert.equal(iso.containerPath.observed, false, "nothing here can observe a container, and the type says so");
});

test("the isolation level is a pure function of the two account names", () => {
  assert.equal(levelFor(null, "example-user").level, "same-user");
  assert.equal(levelFor("", "example-user").level, "same-user");
  const separate = levelFor("opc-agent", "example-user");
  assert.equal(separate.level, "separate-user");
  const sameName = levelFor("example-user", "example-user");
  assert.equal(sameName.level, "same-user", "naming your own account is not isolation");
  assert.match(sameName.problem ?? "", /not isolation/);
});

/* ------------------------------------------------- the owner-surface lock */

test("the owner surface is refused to a request with NO credential at all", () => {
  /* THE REGRESSION THIS FILE EXISTS FOR. The first version bound the refusal
     to a caller that presented the agent key, so an agent with a shell simply
     omitted the header and walked through on a passwordless box — the shipped
     state. */
  const bare = ownerSurfaceRefusal(request("POST", "/api/backups/restore"));
  assert.ok(bare, "no header at all is refused");
  assert.match(bare, /owner control/);

  assert.ok(ownerSurfaceRefusal(request("GET", "/api/backups")), "the whole backups family, reads included");
  assert.ok(ownerSurfaceRefusal(request("POST", "/api/plugins/stripe/accounts")), "credential writes");
  assert.equal(ownerSurfaceRefusal(request("GET", "/api/plugins")), null, "reads of the plugin list are not on the surface");
  assert.equal(ownerSurfaceRefusal(request("GET", "/api/board")), null, "an ordinary route is untouched");
});

test("the owner surface opens for the owner key, a browser-shaped request, and nothing else", () => {
  const path = "/api/backups/restore";
  assert.equal(ownerSurfaceRefusal(request("POST", path, { "x-opc-key": serviceKey() })), null, "the owner key");
  assert.equal(ownerSurfaceRefusal(request("POST", path, { origin: "http://127.0.0.1:8787" })), null, "a same-origin browser");
  assert.equal(ownerSurfaceRefusal(request("GET", "/api/backups", { "sec-fetch-site": "same-origin" })), null, "a browser GET, which sends no Origin");

  assert.ok(ownerSurfaceRefusal(request("POST", path, { "x-opc-key": agentKey() })), "the agent key");
  assert.ok(ownerSurfaceRefusal(request("POST", path, { origin: "https://evil.example" })), "somebody else's origin");
  assert.ok(
    ownerSurfaceRefusal(request("POST", path, { "x-opc-key": serviceKey(), "x-opc-via": "skills" })),
    "the skills proxy carries the OWNER key and must still be refused — otherwise a skill entry pointed here would launder an agent's call",
  );
});

test("an anonymous request is not authenticated, and either key is", () => {
  /* THE BUG THIS PINS. `liveSession` answers `undefined` for a request with no
     cookie, so the first version's `!== null` was true for every anonymous
     caller — which handed the full health document, absolute paths and disk
     figures included, to exactly the caller it was written to withhold it
     from. The type was happy either way; only a curl against a locked box
     found it. */
  assert.equal(authenticatedRequest(request("GET", "/api/health")), false);
  assert.equal(authenticatedRequest(request("GET", "/api/health", { "x-opc-key": serviceKey() })), true);
  assert.equal(authenticatedRequest(request("GET", "/api/health", { "x-opc-key": agentKey() })), true);
  assert.equal(authenticatedRequest(request("GET", "/api/health", { cookie: "unrelated=1" })), false);
});

test("the health probe answers liveness only to an unauthenticated caller on a locked box", async () => {
  const anonymous = await healthFor([], { locked: true, authenticated: false });
  assert.equal(anonymous.ok, true, "restore's probe still sees a live server");
  assert.equal(anonymous.status, null, "`not run for you`, which is not `passed`");
  assert.equal("checks" in anonymous, false);
  assert.equal("collectors" in anonymous, false, "the collector names say which businesses this box is connected to");

  const signedIn = await healthFor([], { locked: true, authenticated: true });
  assert.ok("checks" in signedIn);
  const noPassword = await healthFor([], { locked: false, authenticated: false });
  assert.ok("checks" in noPassword, "with no password nothing is withheld — the shipped state");
});

test("agentRefusal describes the surface without needing a request", () => {
  assert.ok(agentRefusal("POST", "/api/security/password"));
  assert.equal(agentRefusal("GET", "/api/security/status"), null, "reads of the lock's own status are open");
});

/* -------------------------------------------- one browser-shape predicate */

/**
 * THE HEADER-LESS POST. This is the finding, and it is the reason the whole
 * table exists.
 *
 * There used to be two answers to "is this the owner's browser". One said a
 * request with no `Origin` and no `Sec-Fetch-Site` is not a browser; the other
 * only refused what it could SEE — a foreign origin, a presented key — so a
 * request carrying nothing at all fell off the end of it and was allowed. The
 * second one was `requireBrowser`, and `requireBrowser` was the only guard on
 * installing a service, uninstalling one, writing the service plan and
 * publishing a post.
 */
const BROWSER_ONLY = [
  ["POST", "/api/deploy/service/install"],
  ["POST", "/api/deploy/service/uninstall"],
  ["POST", "/api/deploy/plan/write"],
  ["POST", "/api/publishing/items/17/publish"],
  ["POST", "/api/publishing/items/17/retry"],
  ["POST", "/api/security/password"],
] as const;

test("a header-less POST is refused on every browser-only route", () => {
  for (const [method, path] of BROWSER_ONLY) {
    const refusal = ownerSurfaceRefusal(request(method, path));
    assert.ok(refusal, `${method} ${path} must not be reachable with no headers at all`);
    assert.match(refusal, /no browser origin/);
  }
  /* And through the middleware door as well, which is the one the routes
     themselves wear — the two must not be able to disagree again. */
  assert.ok(levelRefusal(request("POST", "/api/deploy/service/install"), "browser"));
});

test("a browser-only route still opens for the dashboard, and never for a key", () => {
  for (const [method, path] of BROWSER_ONLY) {
    assert.equal(ownerSurfaceRefusal(request(method, path, { "sec-fetch-site": "same-origin" })), null, `${path} from the served dashboard`);
    assert.equal(ownerSurfaceRefusal(request(method, path, { origin: `http://localhost:${UI_PORT}` })), null, `${path} from the dev dashboard`);
    assert.equal(ownerSurfaceRefusal(request(method, path, { origin: `http://127.0.0.1:${PORT}` })), null, `${path} from the API's own port`);

    assert.ok(ownerSurfaceRefusal(request(method, path, { "x-opc-key": serviceKey() })), `${path} must refuse even the OWNER key`);
    assert.ok(ownerSurfaceRefusal(request(method, path, { "x-opc-key": agentKey() })), `${path} must refuse the agent key`);
    assert.ok(ownerSurfaceRefusal(request(method, path, { "x-opc-via": "skills", "sec-fetch-site": "same-origin" })), `${path} must refuse the skills proxy however it dresses`);
    assert.ok(ownerSurfaceRefusal(request(method, path, { origin: "https://evil.example" })), `${path} must refuse somebody else's origin`);
  }
});

test("browserShaped is the only answer to “is this the owner's browser”", () => {
  /* One predicate: whatever `browserShaped` says about a set of headers is
     what the browser-level refusal says about the same set. A second copy of
     this rule is what let the two disagree. */
  const cases: Record<string, string>[] = [
    {},
    { origin: "https://evil.example" },
    { origin: `http://127.0.0.1:${PORT}` },
    { origin: `http://localhost:${UI_PORT}` },
    { origin: "http://localhost:9999" },
    { "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-origin", "x-opc-via": "skills" },
  ];
  for (const headers of cases) {
    const r = request("POST", "/api/deploy/service/install", headers);
    assert.equal(
      levelRefusal(r, "browser") === null,
      browserShaped(r),
      `browserShaped and the browser level disagree about ${JSON.stringify(headers)}`,
    );
  }
});

test("the deploy and publishing writes are now IN the report that claims they are refused", () => {
  /* The other half of the finding. These four were guarded only by the weakest
     of the three rules and were invisible to `agentRefusal`, to
     OWNER_SURFACE_PREFIXES, to the isolation report and to `npm run doctor` —
     all of which are read as the list of what an agent cannot reach. */
  for (const [method, path] of BROWSER_ONLY) assert.ok(agentRefusal(method, path), `${method} ${path} must be describable`);
  assert.equal(agentRefusal("GET", "/api/deploy"), null, "the overview is a read and stays open");
  assert.equal(agentRefusal("POST", "/api/deploy/leases/release-stale"), null, "tidying a lapsed lease is the agent's to do");
  assert.equal(agentRefusal("POST", "/api/nurture/sequences/9/enrol"), null, "enrolling is not the same route as writing the sequence");
  assert.ok(agentRefusal("PATCH", "/api/nurture/sequences/9"), "writing the sequence is");
});

/* ------------------------------------------------------------- retention */

test("/api/health reports the retention registry, not a setting that describes some of it", async () => {
  /* See shared/retention.ts for why a registry replaced the old config value. */
  const doc = await healthFor(["fleet"], { locked: false, authenticated: true });
  assert.ok("retention" in doc, "the registry, verbatim");
  const byTable = new Map(doc.retention.map((r) => [r.table, r]));

  for (const table of ["security_snapshots", "security_shotsqa", "backup_runs"])
    assert.ok(byTable.get(table), `${table} had no prune anywhere and must now have a declared window`);
  for (const table of ["uptime_checks", "fleet_samples", "workstation_state", "job_leases"])
    assert.ok(byTable.get(table), `${table} aged on a number nothing reported`);

  assert.equal(byTable.get("readings")?.setting, "OPC_RETAIN_DAYS", "the global setting is IN the registry, not beside it");
  assert.equal(byTable.get("readings")?.days, RETAIN_DAYS);
  assert.equal(byTable.get("hetzner_load")?.days, LOAD_RETAIN_DAYS);
  assert.equal(byTable.get("job_leases")?.where, "released_at IS NOT NULL", "an open lease is a claim, not history");
  for (const entry of doc.retention) assert.ok(entry.days > 0, `${entry.table} has no window`);
});

/* --------------------------------------------- releasing a beating lease */

test("a lease whose holder is still beating cannot be released without force", () => {
  const l = leases.acquire({ kind: "video", resource: "test:beating", note: "a render" });
  const refused = leases.release(l.id, "tidying up");
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "alive");
  assert.match(refused.ok === false ? refused.error : "", /would NOT stop the job/);
  assert.equal(leases.sleepCheck("test:beating").allowed, false, "and the machine is still protected");

  const forced = leases.release(l.id, "the owner said so", { force: true });
  assert.equal(forced.ok, true);
  assert.equal(leases.sleepCheck("test:beating").allowed, true);
});

test("a lease whose holder has stopped beating is ordinary bookkeeping", () => {
  const l = leases.acquire({ kind: "video", resource: "test:quiet" });
  db.prepare("UPDATE job_leases SET heartbeat_at = ? WHERE id = ?").run(
    new Date(Date.now() - leases.ALIVE_WITHIN_MS - 5_000).toISOString(),
    l.id,
  );
  const res = leases.release(l.id, "the job went away");
  assert.equal(res.ok, true, "no force needed once the heartbeat has stopped");
});

test("releaseOwn is the holder's own release and is never refused", () => {
  const l = leases.acquire({ kind: "video", resource: "test:own" });
  leases.releaseOwn(l.id, "the video run ended");
  assert.notEqual(leases.read(l.id)?.released_at, null);
});

/* -------------------------------------------------- unreachable ≠ asleep */

test("an ssh failure that is not silence is `unknown`, not `asleep`", () => {
  const base = {
    id: 1, label: "desk", target: "a@b", mac: null, broadcast: "255.255.255.255",
    hostname: null, os: null, uptimeS: null, gpus: null, gpuNote: null, ms: 1, checkedAt: new Date().toISOString(),
  };
  assert.equal(foundState({ ...base, reachable: true, error: null, unreachable: null }), "awake");
  assert.equal(foundState({ ...base, reachable: false, error: "timed out", unreachable: "silence" }), "asleep");
  /* A rotated key, a changed host key, a wrong hostname, an sshd that answered
     with RST — every one of those is compatible with a machine that is wide
     awake and busy, and reading them as sleep is how this app came to claim it
     may power off machines it never woke. */
  assert.equal(foundState({ ...base, reachable: false, error: "permission denied", unreachable: "refused-or-broken" }), "unknown");
});

test("a wake whose state was unknown owns nothing, and says why in its own words", () => {
  leases.recordWake({ resource: "test:unknown", by: "the test", foundState: "unknown" });
  const check = leases.sleepCheck("test:unknown");
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "not-ours");
  assert.match(check.refusal ?? "", /could not tell what state/);
  assert.doesNotMatch(check.refusal ?? "", /already awake/, "unknown is not the same sentence as awake");
});

test("wake ownership expires, and an expired claim says so rather than claiming the machine was awake", () => {
  const wake = leases.recordWake({ resource: "test:stale-wake", by: "the test", foundState: "asleep" });
  assert.equal(wake.owns, true);
  assert.equal(leases.sleepCheck("test:stale-wake").allowed, true);

  db.prepare("UPDATE wake_ownership SET woke_at = ? WHERE resource = ?").run(
    new Date(Date.now() - (leases.WAKE_OWNERSHIP_HOURS + 1) * 3_600_000).toISOString(),
    "test:stale-wake",
  );
  const aged = leases.wakeOwner("test:stale-wake")!;
  assert.equal(aged.expired, true);
  assert.equal(aged.owns, false, "a claim from yesterday is not a claim");
  const check = leases.sleepCheck("test:stale-wake");
  assert.equal(check.allowed, false);
  assert.match(check.refusal ?? "", /more than 12 hours ago/);
});
