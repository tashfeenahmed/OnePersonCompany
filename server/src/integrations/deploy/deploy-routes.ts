/**
 * /api/deploy — this box as a MACHINE rather than as a business.
 *
 * Every other route on this server answers something about a venture, a
 * provider or a person. This one answers whether the thing serving those
 * routes is installed as a service, whether it will come back after a reboot,
 * what its own health checks say, when each source is next due to be
 * collected, how tightly the agent is boxed in, and which jobs are currently
 * holding a shared machine. It is what an owner opens when the dashboard was
 * fine yesterday and is silent today.
 *
 * THE THREE WRITES THAT PUT SOMETHING ON THIS MACHINE ARE BROWSER-ONLY.
 * Installing a service puts a supervised process into the owner's account and
 * uninstalling takes it away; neither is something a chat message should be
 * able to do, so `requireBrowser` refuses any caller carrying a service key,
 * arriving through the skills proxy, OR sending no browser origin at all —
 * that last one used to walk straight through, which meant these three were
 * guarded against everything except the plainest possible `curl -XPOST`.
 *
 * THEY ARE ALSO ROWS IN THE GATE'S OWN TABLE (integrations/security/gate.ts),
 * which is what makes them visible to `agentRefusal`, the isolation report and
 * `npm run doctor`. Before that they were invisible to all three, so those
 * three surfaces listed the routes an agent could not reach and left these
 * out. The middleware here is the per-route belt; the table is the statement.
 *
 * The lease writes are NOT gated that way, deliberately: releasing a stale
 * lease is exactly the kind of tidying the agent should be able to do, it is
 * reversible (the job that lost it can take another), and the skill publishes
 * it.
 */
import { Hono } from "hono";
import { COLLECT_MINUTES } from "../../config.ts";
import { isAgentCall, requireBrowser } from "../security/gate.ts";
import { health } from "./health.ts";
import { isolation } from "./isolation.ts";
import * as leases from "./leases.ts";
import { collectorIds, collectorMap, schedulerState, schedules } from "./scheduler.ts";
import { install, logTail, plan, status, uninstall, writeDryRun } from "./service.ts";

export const deployRoutes = new Hono();

/* ------------------------------------------------------------- the overview */

/**
 * Everything the Deployment page opens with, in one document.
 *
 * ONE FETCH RATHER THAN FIVE, because the five answers are read together or
 * not at all and a page that assembled them itself would render four of them
 * beside a spinner. The expensive part is the supervisor call and the health
 * check's agent probe; both are bounded by their own timeouts.
 */
deployRoutes.get("/status", async (c) => {
  const [service, checks] = await Promise.all([status(), health(collectorIds())]);
  return c.json({
    service,
    health: checks,
    isolation: isolation(),
    scheduler: {
      ...schedulerState(),
      defaultMinutes: COLLECT_MINUTES,
      sources: schedules(collectorMap(), COLLECT_MINUTES),
    },
    leases: { live: leases.live(), stale: leases.stale(), wake: leases.wakeOwners() },
    note:
      "`service` is the supervisor's own answer plus what is on disk; `health` is the same document /api/health " +
      "serves. A source with `everyMinutes: null` is deliberately never collected on the schedule — its Collect " +
      "button still works. `leases.live` is what would refuse a sleep right now.",
  });
});

/** The same document the liveness probe answers with, published under this
 *  area's own path so the page has one base URL. */
deployRoutes.get("/health", async (c) => c.json(await health(collectorIds())));

deployRoutes.get("/schedule", (c) =>
  c.json({
    defaultMinutes: COLLECT_MINUTES,
    tickSeconds: 60,
    sources: schedules(collectorMap(), COLLECT_MINUTES),
    scheduler: schedulerState(),
    note:
      "The cadence is a per-plugin setting (`collect_interval_minutes`) on each source's own Integrations page. " +
      "Empty means the box default; 0 means never on a schedule. `nextDueAt` is computed from the last run's " +
      "START, so a slow source does not drift later every cycle.",
  }),
);

deployRoutes.get("/isolation", (c) => c.json(isolation()));

/* ---------------------------------------------------------------- the logs */

deployRoutes.get("/logs", (c) => {
  const which = c.req.query("which") === "err" ? "err" : "out";
  const lines = Math.min(Math.max(Number(c.req.query("lines") ?? 60) || 60, 1), 500);
  return c.json({ which, ...logTail(which, lines) });
});

/* -------------------------------------------------------------- the service */

/** What WOULD be written, without writing anything. The page shows this before
 *  it offers the button, because a unit file is a thing you want to read. */
deployRoutes.get("/plan", (c) => {
  const p = plan();
  return c.json({
    ...p,
    note:
      p.platform === "unsupported"
        ? `There is no service format here for ${process.platform}. Run \`npm start\` under whatever supervisor this system uses.`
        : "Nothing has been written. `unitText` is exactly what would go to `unitPath`; the environment file is " +
          "created only if it is not already there, and is never overwritten.",
  });
});

/** The dry run — the unit and the env template into `deploy/out/`. Safe by
 *  construction: nothing outside the repository is touched. */
deployRoutes.post("/plan/write", requireBrowser, (c) => {
  const written = writeDryRun();
  return c.json({ ok: true, ...written, note: "Written to deploy/out/ for reading. Nothing is installed and no supervisor was told anything." });
});

deployRoutes.post("/service/install", requireBrowser, async (c) => {
  const res = await install();
  return c.json(res, res.ok ? 200 : 500);
});

deployRoutes.post("/service/uninstall", requireBrowser, async (c) => {
  const res = await uninstall();
  return c.json(res, res.ok ? 200 : 500);
});

/* -------------------------------------------------------------- the leases */

deployRoutes.get("/leases", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
  return c.json({
    live: leases.live(),
    stale: leases.stale(),
    recent: leases.recent(limit),
    wake: leases.wakeOwners(),
    ttlMinutes: { default: leases.DEFAULT_TTL_MINUTES, max: leases.MAX_TTL_MINUTES },
    note:
      "A LEASE IS NOT A LOCK. Two live leases on one resource mean two jobs are sharing the machine; nothing here " +
      "refuses one. The only thing a live lease blocks is putting that machine to sleep. A lease with no " +
      "heartbeat lapses after its TTL, which is how a crashed job stops holding a machine awake — a lapsed lease " +
      "is `stale` until something releases it, and it counts as not live from the moment it expires.",
  });
});

/** Who woke each machine, and whether this app owes it a shutdown. */
deployRoutes.get("/wake", (c) =>
  c.json({
    wake: leases.wakeOwners(),
    note:
      "We power off exactly what we powered on. `owns: false` means the machine was already awake when this app " +
      "looked, so it is up for somebody else's reasons and nothing here will sleep it.",
  }),
);

/** Take a lease by hand — the "I am about to run something on the Dell, leave
 *  it alone" button. Named `manual` unless a kind is given. */
deployRoutes.post("/leases", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const lease = leases.acquire({
    kind: typeof body.kind === "string" ? body.kind : "manual",
    resource: typeof body.resource === "string" ? body.resource : leases.LOCAL,
    ventureId: typeof body.ventureId === "string" ? body.ventureId : null,
    note: typeof body.note === "string" ? body.note : null,
    ttlMinutes: typeof body.ttlMinutes === "number" ? body.ttlMinutes : undefined,
  });
  return c.json({ ok: true, lease, note: `Nothing will sleep ${lease.resource} while this is live. It lapses at ${lease.expiresAt} unless it is renewed.` });
});

deployRoutes.post("/leases/:id/heartbeat", (c) => {
  const lease = leases.heartbeat(c.req.param("id"));
  if (!lease) return c.json({ error: "No live lease has that id. A released lease cannot be renewed — take a new one." }, 404);
  return c.json({ ok: true, lease });
});

/**
 * RELEASE, AND THE ONE OVERRIDE ON THIS ROUTER.
 *
 * A lease whose holder is still beating is refused with 409 — releasing it
 * does not stop the job, it only removes the reason nothing will sleep the
 * machine under it. `force` lifts that, and two things about it are
 * deliberate: it is parsed as a REAL BOOLEAN (`=== true`, so the string
 * "false" that a hand-written client sends is not truthy here), and it is
 * refused to an agent — the agent key and anything re-issued by the skills
 * proxy — because the `leases` skill publishes no such parameter and a
 * parameter an agent can discover is a parameter an agent will use.
 */
deployRoutes.post("/leases/:id/release", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const wantsForce = body.force === true;
  if (wantsForce && isAgentCall(c))
    return c.json(
      {
        error:
          "`force` is the owner's. Releasing a lease whose job is still beating is a decision made looking at the " +
          "Deployment page, not from a chat turn. Release the lapsed leases instead — that is `release_stale`.",
      },
      403,
    );

  const res = leases.release(c.req.param("id"), typeof body.reason === "string" ? body.reason : "released by hand", {
    force: wantsForce,
  });
  if (!res.ok) return c.json({ error: res.error, reason: res.reason, lease: res.lease }, res.reason === "no-such-lease" ? 404 : 409);
  return c.json({ ok: true, lease: res.lease });
});

deployRoutes.post("/leases/release-stale", (c) => {
  const before = leases.stale().length;
  const released = leases.releaseStale();
  return c.json({
    ok: true,
    released,
    note:
      released === 0
        ? "Nothing had lapsed. A lease that is still within its TTL is a job that is still running as far as anything here can tell."
        : `${released} lapsed lease(s) marked released. They were already not live — this is bookkeeping, and it says on the row that a sweep did it rather than the job. Found ${before} before the sweep.`,
  });
});

/**
 * FORGET A WAKE. The escape hatch for the `not-ours` refusal: a machine this
 * app found already awake can never be slept by it, and this is how the owner
 * says "I know, it is mine now". It is a WRITE WITH A RECORD rather than a
 * `?force=1` on the power route, because the two failures it prevents are
 * different — a force flag is a habit, and this is a decision with a row.
 */
deployRoutes.post("/wake/:resource/release", (c) => {
  const wake = leases.releaseWake(c.req.param("resource"));
  if (!wake) return c.json({ error: `Nothing has been recorded about waking ${c.req.param("resource")}, so there is no ownership to hand back.` }, 404);
  return c.json({ ok: true, wake, note: "This app no longer claims to have woken that machine. Sleeping it is now refused only if something holds a live lease on it." });
});

/** The refusal, asked directly. The workstation power route calls the same
 *  function; this is here so a page can grey a button out rather than press it
 *  and read the error. */
deployRoutes.get("/sleep-check/:resource", (c) => c.json(leases.sleepCheck(c.req.param("resource"))));
