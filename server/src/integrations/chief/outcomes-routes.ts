/**
 * `/api/outcomes` — link an action to a metric, and read what happened after.
 *
 * THE BASELINE IS TAKEN BY THE POST, SYNCHRONOUSLY, and that is the one place
 * this route waits for anything. A link made without a baseline is a link with
 * no before, and "we will read it on the next tick" means an outcome created at
 * 09:58 and one created at 10:02 have baselines an hour apart for no reason
 * anybody can see. It is one loopback GET of a document this box already
 * serves.
 *
 * A BASELINE THAT COULD NOT BE READ IS STILL RECORDED, with its reason, and the
 * outcome is still created. Refusing the link would be refusing to track
 * something because a plugin was down for a minute; recording a zero would be
 * the lie. The outcome reads `verdict: "unreadable"` until a reading succeeds,
 * which is the honest description of what is known.
 *
 * `POST /:id/read` IS FOR NOW AND NOT FOR A SLOT. A reading taken by hand
 * carries `dayOffset: null`, so it cannot fill one of the scheduled 7/14/30
 * readings — a hand reading on day six is not the day-seven reading, and
 * letting it be one would move the schedule to whenever somebody pressed a
 * button.
 */
import { Hono } from "hono";
import { db, now, ventureRow } from "../../db.ts";
import {
  FLAT_BAND_PCT,
  MAX_ACTION_TEXT,
  MAX_TITLE,
  OFFSETS,
  mintOutcomeId,
  outcomeRow,
  outcomeRows,
  shapeOutcome,
  takeReading,
  writeReading,
} from "./outcomes.ts";

export const outcomeRoutes = new Hono();

const KINDS = ["card", "run", "note"] as const;

outcomeRoutes.get("/", (c) => {
  const key = c.req.query("venture") ?? "";
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);
  const list = outcomeRows(v?.id ?? null).map(shapeOutcome);
  return c.json({
    count: list.length,
    outcomes: list,
    summary: {
      /* Counted by verdict, and `unreadable` is its own bucket rather than
         folded into `flat`. A metric nobody could read is not a metric that
         did not move. */
      up: list.filter((o) => o.verdict === "up").length,
      down: list.filter((o) => o.verdict === "down").length,
      flat: list.filter((o) => o.verdict === "flat").length,
      pending: list.filter((o) => o.verdict === "pending").length,
      unreadable: list.filter((o) => o.verdict === "unreadable").length,
    },
    schedule: { offsetsDays: [...OFFSETS], flatBandPct: FLAT_BAND_PCT },
    note:
      "Correlation, not causation. Every figure here is the same metric read " +
      "before and after a date, with the window stated; nothing controls for " +
      "anything else that happened in it.",
  });
});

outcomeRoutes.get("/:id", (c) => {
  const row = outcomeRow(c.req.param("id"));
  if (!row) return c.json({ error: "No outcome by that id." }, 404);
  return c.json(shapeOutcome(row));
});

outcomeRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const str = (k: string): string => (typeof body[k] === "string" ? (body[k] as string).trim() : "");

  const title = str("title");
  if (!title) return c.json({ error: "An outcome needs a title: what was done, in a few words." }, 400);
  if (title.length > MAX_TITLE) return c.json({ error: `The title is at most ${MAX_TITLE} characters.` }, 413);

  const kind = str("actionKind") || "note";
  if (!KINDS.includes(kind as (typeof KINDS)[number]))
    return c.json({ error: `actionKind is one of ${KINDS.join(", ")}.` }, 400);

  const skill = str("skill");
  const path = str("path");
  if (!skill || !path)
    return c.json(
      {
        error:
          "A metric is an address: `skill` (which document), optional `view`, " +
          "optional `params`, and `path` (the field in it, dotted — `totals.visitors`).",
      },
      400,
    );

  /* THE ACTION'S DATE IS THE ANCHOR AND IS VALIDATED HARDER THAN ANYTHING ELSE
     HERE, because every offset is measured from it. A date in the future would
     make every reading overdue on the day it was created. */
  const rawAt = str("actionAt");
  const at = rawAt ? new Date(rawAt) : new Date();
  if (Number.isNaN(at.getTime()))
    return c.json({ error: `"${rawAt}" is not a date. Use YYYY-MM-DD or an ISO instant.` }, 400);
  if (at.getTime() > Date.now() + 86_400_000)
    return c.json({ error: "The action date is in the future. An outcome measures something that happened." }, 400);

  const ventureKey = str("venture") || str("ventureId");
  const v = ventureKey ? ventureRow(ventureKey) : undefined;
  if (ventureKey && !v) return c.json({ error: `No venture by the id or slug "${ventureKey}".` }, 404);

  const actionText = str("actionText") || title;
  if (actionText.length > MAX_ACTION_TEXT)
    return c.json({ error: `The action description is at most ${MAX_ACTION_TEXT} characters.` }, 413);

  let params = "{}";
  if (body.params !== undefined) {
    if (typeof body.params === "string") {
      try {
        JSON.parse(body.params);
        params = body.params;
      } catch {
        return c.json({ error: "`params` as a string must be JSON: {\"days\":\"30\"}." }, 400);
      }
    } else if (body.params && typeof body.params === "object" && !Array.isArray(body.params)) {
      params = JSON.stringify(body.params);
    } else {
      return c.json({ error: "`params` is an object of the view's parameters, or absent." }, 400);
    }
  }

  const id = mintOutcomeId();
  db.prepare(
    `INSERT INTO chief_outcomes
       (id, title, venture_id, action_kind, action_ref, action_text, action_at,
        skill, view, params, path, unit, created_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    id,
    title,
    v?.id ?? "",
    kind,
    str("actionRef"),
    actionText,
    at.toISOString(),
    skill,
    str("view") || "default",
    params,
    path,
    str("unit") || null,
    now(),
  );

  const row = outcomeRow(id)!;
  const baseline = await takeReading(row);
  writeReading(id, "baseline", null, baseline);

  return c.json(
    {
      outcome: shapeOutcome(outcomeRow(id)!),
      note:
        `The baseline was read now, ${daysBetween(at)} after the action. Readings ` +
        `follow at ${OFFSETS.join(", ")} days after the action. Correlation, not ` +
        `causation — this box will report the two numbers and the window, and ` +
        `nothing about cause.`,
    },
    201,
  );
});

outcomeRoutes.post("/:id/read", async (c) => {
  const row = outcomeRow(c.req.param("id"));
  if (!row) return c.json({ error: "No outcome by that id." }, 404);
  const out = await takeReading(row);
  const reading = writeReading(row.id, "reading", null, out);
  return c.json({
    reading: { at: reading.ts, value: reading.value, error: reading.error, dayOffset: null },
    outcome: shapeOutcome(outcomeRow(row.id)!),
    note:
      "A reading taken by hand does not fill one of the scheduled 7/14/30-day " +
      "slots. Correlation, not causation.",
  });
});

outcomeRoutes.delete("/:id", (c) => {
  const row = outcomeRow(c.req.param("id"));
  if (!row) return c.json({ error: "No outcome by that id." }, 404);
  const gone = shapeOutcome(row);
  /* The readings go with it. They are meaningless without the address and the
     action that gave them a before and an after. */
  db.prepare("DELETE FROM chief_outcome_readings WHERE outcome_id = ?").run(row.id);
  db.prepare("DELETE FROM chief_outcomes WHERE id = ?").run(row.id);
  return c.json({ deleted: gone });
});

/** How long ago, in the plainest words. Used in one sentence, so it is written
 *  once rather than pulled in from a formatting library this server does not
 *  have. */
function daysBetween(at: Date): string {
  const d = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (d <= 0) return "the same day";
  return `${d} day${d === 1 ? "" : "s"}`;
}
