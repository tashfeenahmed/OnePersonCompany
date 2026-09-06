/**
 * `/api/rounds` — the ledger, the schedule and the button.
 *
 * THERE IS NO PUT HERE, and that is deliberate rather than missing. The
 * schedule is SETTINGS — `PUT /api/plugins/rounds/config` — which is where
 * every other non-secret setting on this box lives, and a second door onto the
 * same values would be a second validator to keep in step with the registry's.
 * `GET /api/rounds/schedule` reads them back with the next run computed, which
 * is the half the config route cannot answer.
 *
 * `POST /api/rounds/now` COSTS REAL MONEY and says so in every surface that
 * publishes it. It dispatches actual runs into the single slot; it is not a dry
 * run and there is no dry run, because a dry run of "which ventures are due"
 * would be a second implementation of the walk and the only thing worth testing
 * is the real one.
 */
import { Hono } from "hono";
import { nextRunAt } from "../../shared/time.ts";
import { ROLES, roleInfos } from "../subagents/store.ts";
import {
  DEFAULT_DAYS,
  DEFAULT_HOUR,
  DEFAULT_MAX,
  ROUNDS_SESSION,
  jobRows,
  roundRows,
  runRound,
  settings,
  shapeJob,
  shapeRound,
} from "./rounds.ts";

export const roundRoutes = new Hono();

function schedule() {
  const s = settings();
  return {
    enabled: s.enabled,
    hour: s.hour,
    /* ALWAYS A REAL ZONE NAME — this machine's own where the owner never typed
       one. `zoneWasSet` carries what the old null carried, so a page can still
       say "using this machine's zone" without a second field repeating the
       answer the first one already gave. */
    timezone: s.timezone,
    zoneWasSet: s.zoneWasSet,
    roles: s.roles,
    maxRuns: s.maxRuns,
    daysBetween: s.daysBetween,
    quietStages: s.quietStages,
    nextRunAt: nextRunAt(s),
    session: ROUNDS_SESSION,
    defaults: { hour: DEFAULT_HOUR, maxRuns: DEFAULT_MAX, daysBetween: DEFAULT_DAYS },
    /* The roles that exist, so a client can offer them without a second
       request and a reader can see that a setting naming something else was
       dropped. */
    availableRoles: roleInfos(),
    settingsAt: "/api/plugins/rounds/config",
  };
}

roundRoutes.get("/", (c) => {
  const rounds = roundRows(20).map(shapeRound);
  return c.json({
    schedule: schedule(),
    rounds,
    last: rounds[0] ?? null,
    /* The whole ledger, newest first, across rounds. It is what answers "has
       anything been dispatched on its own this month", which the rounds list
       alone cannot: a round with nothing in it looks the same as no round. */
    jobs: jobRows(null, 100).map(shapeJob),
    note:
      "A round is queued work, not a report. It dispatches runs into the one " +
      "slot on this box and returns immediately; what came of them is in the " +
      "runs ledger and under the \"" +
      ROUNDS_SESSION +
      "\" conversation.",
  });
});

roundRoutes.get("/schedule", (c) => c.json(schedule()));

roundRoutes.get("/:id", (c) => {
  const row = roundRows(200).find((r) => r.id === c.req.param("id"));
  if (!row) return c.json({ error: "No round by that id." }, 404);
  return c.json({ round: shapeRound(row), jobs: jobRows(row.id, 500).map(shapeJob) });
});

/**
 * WALK NOW.
 *
 * It runs the same walk the timer runs, with `trigger: "manual"` so the ledger
 * can tell the two apart — "it ran twice yesterday" has very different
 * explanations depending on which. It does NOT bypass the cadence, the quiet
 * stages or the cap: those are the owner's settings, and a button that ignored
 * them would be a different feature wearing this one's name.
 */
roundRoutes.post("/now", async (c) => {
  const out = await runRound("manual");
  if (!out.ran) return c.json({ error: out.why }, 409);
  return c.json(
    {
      ...out,
      session: ROUNDS_SESSION,
      note:
        `Dispatched into the single run slot. Each run takes minutes and posts ` +
        `its own report back under the "${ROUNDS_SESSION}" conversation; nothing ` +
        `here is a result.`,
      roles: ROLES.map((r) => r.role),
    },
    201,
  );
});
