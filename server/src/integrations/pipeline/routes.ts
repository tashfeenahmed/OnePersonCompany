/**
 * `/api/pipeline` — the schedule, the ledger and the buttons.
 *
 * THERE IS A PUT FOR THE PER-STAGE OVERRIDES AND NOT FOR THE NIGHT'S SETTINGS,
 * and the split is deliberate. The night's settings — on, hour, zone,
 * blackouts, budgets — are SETTINGS: `PUT /api/plugins/pipeline/config`, where
 * every other non-secret value on this box lives, validated once by the
 * registry that owns them. The per-stage overrides are not settings; there are
 * fourteen of them, they are toggled from a list, and a text box holding
 * `rounds=off,synthesis=weekly` would be a worse form than three columns and a
 * switch. So they get a table and a PATCH, and the night's settings stay where
 * the rest of them are.
 *
 * THE REHEARSAL IS ITS OWN ROUTE AND THE REAL ONE REFUSES THE WORD `dry`.
 * `POST /run` always runs: it dispatches sub-agent runs into the single slot
 * and sends model calls billed to the owner. `POST /plan` always rehearses: it
 * hard-codes `dry: true` and reads nothing about it from the request. Sending
 * `dry` to `/run` is a 400 naming `/plan`.
 *
 * That split is not fastidiousness. The skills proxy sends every parameter as a
 * STRING, so a route testing `body.dry === true` reads `"true"` as FALSE — the
 * bug that published a real Facebook post in wave 1 of this build, and the bug
 * this route had until it was reviewed. With two routes there is no boolean
 * anywhere near the decision that spends money, and no typo can turn one into
 * the other. Every other boolean here goes through `readBool` in params.ts,
 * which refuses what it cannot parse instead of defaulting to false.
 */
import { Hono, type Context } from "hono";
import { LAST_RUN_MEANS } from "./builtins.ts";
import { readBool, refuseDry } from "./params.ts";
import {
  deliver,
  lastCompleted,
  plan,
  runNight,
  runRow,
  runRows,
  shapeRun,
  shapeStageResult,
  stageResultRows,
  PIPELINE_SESSION,
} from "./nightly.ts";
import {
  CADENCES,
  DEFAULT_HOUR,
  DEFAULT_MAX_MINUTES,
  allStages,
  depthOf,
  nextRunAt,
  orderStages,
  prefs,
  settings,
  setPref,
  setSkipDay,
  settled,
  skipDay,
  stage as stageById,
  zoned,
  type Cadence,
} from "./registry.ts";

export const pipelineRoutes = new Hono();

/** A stage window, the same grammar a blackout uses for its span. */
const WINDOW = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/* ------------------------------------------------------------------ stages */

/**
 * THE STAGE GRAPH, in the order the night walks it, with the depth of each
 * stage's dependency chain so a client can indent the list without
 * re-implementing the cycle guard.
 *
 * `lastRun` MEANS TWO DIFFERENT THINGS and the row says which. For a stage the
 * pipeline calls it is the last time it COMPLETED in a real night, out of this
 * area's own ledger. For a self-scheduled stage it is the newest row in that
 * area's own table, and `lastRunMeans` is the sentence explaining exactly which
 * row that is — a pass that ran and found nothing to do therefore reads as
 * older than it is, and saying so on the wire is cheaper than a timestamp that
 * looks more authoritative than it is.
 */
function stageDoc() {
  const stages = allStages();
  const { order, cycle, missing } = orderStages(stages);
  const pref = prefs();
  const s = settings();
  const rows = [...order, ...stages.filter((x) => cycle.includes(x.id))].map((st) => {
    const conf = settled(st, pref.get(st.id));
    const self = !st.run;
    let last: string | null = null;
    try {
      last = self ? (st.lastRun?.() ?? null) : lastCompleted(st.id);
    } catch {
      last = null;
    }
    return {
      ...conf,
      depth: depthOf(st.id, stages),
      inCycle: cycle.includes(st.id),
      lastRun: last,
      lastRunMeans: self
        ? (LAST_RUN_MEANS[st.id] ??
          "the newest row this area writes. It is not a log of the timer waking.")
        : "the last time this stage COMPLETED in a real (non-planned) night.",
    };
  });
  return {
    stages: rows,
    cycle,
    /* A dependency naming a stage that is not registered. Dropped from the
       ordering and published here rather than silently ignored: an area
       removed in a release must not take the stages that mentioned it down,
       and must not do so invisibly either. */
    unknownDeps: missing,
    blackoutErrors: s.blackoutErrors,
    note:
      "A stage with scheduledBy 'self' keeps its own timer in its own area; the pipeline lists " +
      "it and never starts it, so nothing here can make that work happen twice. A stage with " +
      "scheduledBy 'pipeline' is started by the nightly walk and by nothing else.",
  };
}

pipelineRoutes.get("/stages", (c) => c.json(stageDoc()));

/**
 * ONE STAGE'S OVERRIDES. Every field is optional and `null` restores the
 * stage's own default — which is a third answer distinct from `false` and from
 * `0`, and is why the table's columns are nullable.
 */
pipelineRoutes.patch("/stages/:id", async (c) => {
  const id = c.req.param("id");
  if (!stageById(id)) return c.json({ error: `There is no stage called "${id}".` }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const patch: Parameters<typeof setPref>[1] = {};
  if ("enabled" in body) {
    /* Through `readBool`, which takes the STRING the skills proxy sends as well
       as a JSON boolean. This route used to demand `typeof === "boolean"` and
       so answered 400 to every call an agent could possibly make. */
    const read = readBool(body.enabled, "enabled", { allowNull: true });
    if (!read.ok) return c.json({ error: read.error }, 400);
    patch.enabled = read.value;
  }
  if ("cadence" in body) {
    const raw = body.cadence;
    const cadence = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
    /* "null" the string as well as null the value, for the proxy's sake. */
    if (cadence === null || cadence === "null" || cadence === "default") patch.cadence = null;
    else if (!CADENCES.includes(cadence as Cadence))
      return c.json({ error: `\`cadence\` is one of ${CADENCES.join(", ")}, or null for the default.` }, 400);
    else patch.cadence = cadence as Cadence;
  }
  if ("window" in body) {
    const raw = body.window;
    const w = typeof raw === "string" ? raw.trim() : raw;
    if (w === null || w === "" || w === "null" || w === "default") patch.window = null;
    else if (typeof w !== "string" || !WINDOW.test(w))
      return c.json(
        { error: "`window` is HH:MM-HH:MM (the part of the night this stage may start in), or null for anywhere." },
        400,
      );
    else patch.window = w;
  }
  for (const key of ["maxUsd", "maxMinutes"] as const) {
    if (!(key in body)) continue;
    /* A number, or a string holding one — the proxy sends `type: "number"`
       params as numbers, but a hand-written client may not. */
    const raw = body[key];
    const v = typeof raw === "string" && raw.trim() ? Number(raw.trim()) : raw;
    /* Zero is refused rather than accepted as "no budget": a cap of zero would
       mean a stage that may never start, which is what `enabled: false` is
       for, and reading it either way would be a guess. */
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v <= 0))
      return c.json({ error: `\`${key}\` is a positive number, or null to restore the default.` }, 400);
    patch[key] = v as number | null;
  }

  setPref(id, patch);
  return c.json(stageDoc());
});

/* ----------------------------------------------------------------- schedule */

function schedule() {
  const s = settings();
  const clock = zoned(s);
  const skip = skipDay();
  return {
    enabled: s.enabled,
    hour: s.hour,
    /** Null means "this machine's own zone", which is a real answer and not a
     *  missing setting. The resolved zone is beside it so a reader is never
     *  guessing which clock the hour is on. */
    timezone: s.timezone,
    resolvedTimezone: s.resolvedTimezone,
    today: clock.day,
    blackouts: s.blackouts.map((b) => ({ from: b.from, to: b.to, stages: b.stages, days: b.days, raw: b.raw })),
    blackoutErrors: s.blackoutErrors,
    maxUsd: s.maxUsd,
    maxMinutes: s.maxMinutes,
    nextRunAt: nextRunAt(s),
    /* The NIGHT's day, not today's — see `dueNight` below. A skip set at
       nine in the evening is for the night that starts after midnight. */
    nextNightDay: dueNight(clock.day, clock.hour, s.hour),
    skipTonight: skip && skip.day === dueNight(clock.day, clock.hour, s.hour) ? skip : null,
    session: PIPELINE_SESSION,
    defaults: { hour: DEFAULT_HOUR, maxMinutes: DEFAULT_MAX_MINUTES },
    settingsAt: "/api/plugins/pipeline/config",
    notes: {
      budget:
        "The dollar budget is checked BEFORE a stage starts and never during it: a stage already " +
        "running is not killed by an accountant. Per-call limits live in the runtime budgets.",
      cost:
        "A night's cost counts the model calls its stages made themselves. Work a stage QUEUED — a " +
        "sub-agent run — is billed to that run, not here. Null means this box prices no tokens.",
    },
  };
}

pipelineRoutes.get("/schedule", (c) => c.json(schedule()));

/* --------------------------------------------------------------- the ledger */

pipelineRoutes.get("/", (c) => {
  const runs = runRows(20).map(shapeRun);
  return c.json({
    schedule: schedule(),
    ...stageDoc(),
    runs,
    /** The last REAL night, not the last planned one: a plan somebody ran at
     *  noon must not read as last night's result. */
    last: runs.find((r) => !r.dry) ?? null,
  });
});

pipelineRoutes.get("/runs", (c) => c.json({ runs: runRows(50).map(shapeRun) }));

pipelineRoutes.get("/runs/:id", (c) => {
  const row = runRow(c.req.param("id"));
  if (!row) return c.json({ error: "No pipeline run by that id." }, 404);
  return c.json({ run: shapeRun(row), stages: stageResultRows(row.id).map(shapeStageResult) });
});

/** WHAT TONIGHT WOULD DO, decided now, writing nothing. The cheap answer: it
 *  applies enablement, cadence, blackouts and the stage windows against this
 *  moment's clock without starting anything or filing a run. For the expensive
 *  answer — one that also asks each stage what it would do — POST /run with
 *  `dry: true`. */
pipelineRoutes.get("/plan", (c) => {
  const s = settings();
  const { planned } = plan(s);
  return c.json({
    at: new Date().toISOString(),
    timezone: s.resolvedTimezone,
    stages: planned.map((p) => ({
      stageId: p.stage.id,
      area: p.stage.area,
      title: p.stage.title,
      scheduledBy: p.settled.scheduledBy,
      wouldRun: p.refusal === null,
      reason: p.refusal?.reason ?? null,
    })),
    note:
      "This is the plan against the clock right now. Dependencies and the night's budget are " +
      "decided during the walk and are not applied here, so a stage marked wouldRun may still be " +
      "skipped for a dependency that did not complete.",
  });
});

/* ---------------------------------------------------------------- the button */

/** Shared by `/run` and `/plan`, which differ in exactly one hard-coded
 *  argument. Neither reads `dry` from anywhere. */
async function walk(c: Context, dry: boolean) {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;

  if (!dry) {
    const refusal = refuseDry(body, "POST /api/pipeline/plan");
    if (refusal) return c.json({ error: refusal }, 400);
  }

  const raw = body?.stage;
  const only = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (only && !stageById(only)) return c.json({ error: `There is no stage called "${only}".` }, 404);

  const out = await runNight({ trigger: only ? "stage" : "manual", dry, only });
  if (!out.ran) return c.json({ error: out.why }, 409);

  /* A night started by hand is delivered like one started by the timer: the
     transcript is the record, and the owner who pressed the button is not the
     only person who reads it. A planned night is never pushed to a phone —
     `deliver` makes that call, not this route. */
  const delivery = await deliver(out);

  return c.json(
    {
      ...out,
      delivery,
      note: dry
        ? "Nothing was run. Each stage was asked what it would do and answered without spending anything."
        : "Stages that dispatch sub-agent runs return as soon as the work is QUEUED. What came of it is in the runs ledger.",
    },
    201,
  );
}

/**
 * RUN IT, FOR REAL. Dispatches sub-agent runs into the single slot and sends
 * model calls billed to the owner. It refuses a `dry` field rather than
 * parsing one — see the file header.
 */
pipelineRoutes.post("/run", (c) => walk(c, false));

/**
 * REHEARSE IT. `dry` is the literal `true` below and comes from nowhere else,
 * so there is no request this route can receive that executes anything.
 */
pipelineRoutes.post("/plan", (c) => walk(c, true));

/**
 * NOT TONIGHT.
 *
 * THE DAY STORED IS THE NIGHT'S DAY, NOT TODAY'S. A night that starts at 02:00
 * belongs to tomorrow's date, so pressing Skip at nine in the evening used to
 * store the 6th while the timer, at two in the morning, asked about the 7th —
 * and the night ran anyway, after a page that had said all evening that it
 * would not. `dueNight()` below is the mirror of `dueDay()` in
 * runtime/schedule.ts: past the start hour the next night is tomorrow's,
 * before it the night is still today's.
 *
 * It does not stop a night somebody starts by hand — that is a person
 * deciding, and this is a note to the timer.
 */
export function dueNight(day: string, hour: number, startHour: number): string {
  if (hour < startHour) return day;
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000);
  return next.toISOString().slice(0, 10);
}

pipelineRoutes.post("/skip-tonight", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const s = settings();
  const clock = zoned(s);
  const night = dueNight(clock.day, clock.hour, s.hour);

  if (body && "cancel" in body) {
    const read = readBool(body.cancel, "cancel");
    if (!read.ok) return c.json({ error: read.error }, 400);
    if (read.value) {
      setSkipDay(null, null);
      return c.json({ skipped: null, note: `The night of ${night} will run on the schedule again.` });
    }
  }

  const reason = typeof body?.reason === "string" ? body.reason.slice(0, 200) : null;
  setSkipDay(night, reason);
  return c.json({
    skipped: skipDay(),
    note:
      `The scheduled night of ${night} (${s.resolvedTimezone}, starting at ${String(s.hour).padStart(2, "0")}:00) ` +
      `will not run. Starting one by hand still works — this is a note to the timer, not a lock.`,
  });
});
