/**
 * `/api/journal` — the work the owner did, in his own words.
 *
 * THIS DOCUMENT IS TESTIMONY AND NOT A MEASUREMENT, and every response says so
 * in `definitions`. Nothing in this table was read off a service: somebody
 * typed it. That makes it the only record here of the half of a one-person
 * company that happens away from an API — and it makes every figure derived
 * from it a count of SENTENCES, never of outcomes, revenue or effect.
 *
 * THE COMPOSER IS ONE LINE FOR A REASON. A form with six required fields is a
 * form that gets filled in for a fortnight. So the only two things this route
 * insists on are a kind and a sentence; the venture, the link, the date and the
 * result are all optional and all editable afterwards.
 *
 * `POST /:id/outcome` IS THE JOIN, and it is offered on exactly two kinds. A
 * `shipped` or a `posted` with a URL is a thing the world can now see, so
 * asking "did it do anything" is answerable — this route hands the entry to
 * the outcomes engine, which reads a metric of the owner's choosing now and
 * again at 7, 14 and 30 days. Every other kind has nothing to point a metric
 * at, and offering it there would be inviting a reading of an address nobody
 * chose.
 *
 * THE EXPORT IS THE WHOLE TABLE AND IT IS NOT PAGINATED. A journal somebody
 * cannot take away with them is a journal held hostage by this box, and the
 * whole of five years of it is a few hundred kilobytes.
 */
import { Hono } from "hono";
import { ventureRow, ventureRowById } from "../../db.ts";
import { createOutcomeWithBaseline } from "../chief/outcomes.ts";
import {
  AGENT_BACKDATE_DAYS,
  KINDS,
  MAX_RESULT,
  MAX_TEXT,
  OWNER_SOURCES,
  TRACKABLE,
  addEntry,
  agentFiledCount,
  allEntryRows,
  countsByKind,
  deleteEntry,
  entryCount,
  entryDays,
  entryRow,
  entryRows,
  parseDay,
  setOutcome,
  setResult,
  shape,
  streak,
  today,
} from "./entries.ts";

export const journalRoutes = new Hono();

const DEFINITIONS = {
  source:
    "Every row here was TYPED IN — on the Journal page, from Telegram, or by " +
    "the agent filing something the owner told it. Nothing in this table was " +
    "measured, collected or inferred, and no count derived from it is " +
    "evidence that anything worked.",
  kinds:
    `${KINDS.join(", ")}. Coarse on purpose: the sentence carries the detail, ` +
    `and a taxonomy nobody fills in the same way twice measures the taxonomy.`,
  dates:
    "`at` is a LOCAL DAY and not an instant, because the work is a fact about " +
    "a day. `createdAt` is when the row was written, so `backdated: true` " +
    "marks an entry filed for an earlier day than the one it was typed on.",
  streak:
    "Consecutive days on which the OWNER filed at least one entry. Rows the " +
    `agent filed are NOT counted — \`streak.sources\` is ${OWNER_SOURCES.join(" and ")} ` +
    "and `streak.agentFiled` says how many rows were left out. Today being " +
    "empty does not end the run — it is counted back from today if today has " +
    "an entry and from yesterday if it does not, and `today` says which. It " +
    "measures logging, not work.",
  outcomes:
    "An entry with a link and a kind of " +
    `${TRACKABLE.join(" or ")} can be handed to the outcomes engine, which ` +
    "reads a metric now and again at 7, 14 and 30 days. That is correlation " +
    "and never cause.",
  venture:
    "Nullable, and null is a real answer: a tax return, an accountant, a " +
    "conference belong to no venture, and forcing them into the nearest one " +
    "would be a worse record than none.",
  counts:
    "`counts` and `count` are over the WHOLE window, counted by the database, " +
    "not over the rows `limit` returned. `returned` is how many rows are in " +
    "this response.",
};

const WINDOWS = [7, 30, 90, 365] as const;

/** The inclusive lower bound for a window in days, or null for everything. */
function since(days: number | null, from = new Date()): string | null {
  if (days === null) return null;
  const d = new Date(`${today(from)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

function windowDays(raw: string | undefined): number | null | { error: string } {
  if (raw === undefined || raw.trim() === "") return 90;
  const t = raw.trim().toLowerCase();
  if (t === "all") return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 3_650)
    return { error: `days is a whole number of days between 1 and 3650, or “all” — not “${raw}”.` };
  return n;
}

journalRoutes.get("/", (c) => {
  const key = c.req.query("venture") ?? "";
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: `No venture by the id or slug “${key}”.` }, 404);

  const kind = (c.req.query("kind") ?? "").trim().toLowerCase();
  if (kind && !(KINDS as readonly string[]).includes(kind))
    return c.json({ error: `kind is one of ${KINDS.join(", ")}.` }, 400);

  const days = windowDays(c.req.query("days"));
  if (typeof days === "object" && days !== null) return c.json({ error: days.error }, 400);

  const limit = Math.min(2_000, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
  const from = since(days);
  const query = { ventureId: v?.id ?? null, kind: kind || null, from };
  const rows = entryRows({ ...query, limit });

  /* The streak is over the whole table (or the whole venture), never over the
     window: a fortnight's view showing a fourteen-day maximum would be the
     window measuring itself. */
  const s = streak(entryDays(v?.id ?? null), today(), agentFiledCount(v?.id ?? null));

  /* COUNTED BY THE DATABASE OVER THE WINDOW, not by filtering the rows that
     came back. They are the same until somebody has more than `limit` entries
     in the window, and then the difference is a document that says "for the
     window" while reporting the last two hundred rows. */
  return c.json({
    window: { days: days === null ? null : days, from, to: today() },
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    kind: kind || null,
    count: entryCount(query),
    returned: rows.length,
    limit,
    counts: countsByKind(query),
    streak: s,
    entries: rows.map(shape),
    kinds: [...KINDS],
    windows: [...WINDOWS],
    definitions: DEFINITIONS,
  });
});

journalRoutes.get("/streak", (c) => {
  const key = c.req.query("venture") ?? "";
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: `No venture by the id or slug “${key}”.` }, 404);
  return c.json({
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    streak: streak(entryDays(v?.id ?? null), today(), agentFiledCount(v?.id ?? null)),
    definitions: { streak: DEFINITIONS.streak, source: DEFINITIONS.source },
  });
});

/**
 * THE EXPORT.
 *
 * `format=csv` or `format=json`. CSV because a journal ends up in a spreadsheet
 * more often than in a program, and the quoting is done properly here rather
 * than by joining on commas: a sentence with a comma in it is the common case,
 * not the edge one.
 */
journalRoutes.get("/export", (c) => {
  const format = (c.req.query("format") ?? "json").trim().toLowerCase();
  if (!["json", "csv"].includes(format))
    return c.json({ error: `format is json or csv — not “${format}”.` }, 400);
  const key = c.req.query("venture") ?? "";
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: `No venture by the id or slug “${key}”.` }, 404);

  /* UNBOUNDED, deliberately, and it is the only read here that is. The header
     above says "the whole table" and a silent clamp would make that a lie on
     the one document somebody reaches for when they are leaving. */
  const rows = allEntryRows(v?.id ?? null);
  if (format === "json")
    return c.json({
      exportedAt: new Date().toISOString(),
      venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
      count: rows.length,
      entries: rows.map(shape),
      definitions: DEFINITIONS,
    });

  const cell = (s: unknown) => {
    const t = s === null || s === undefined ? "" : String(s);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const header = ["date", "kind", "venture", "text", "url", "result", "source", "outcome_id", "created_at"];
  const lines = [header.join(",")];
  for (const r of rows) {
    const venture = r.venture_id ? (ventureRowById(r.venture_id)?.name ?? r.venture_id) : "";
    lines.push(
      [r.at, r.kind, venture, r.text, r.url, r.result, r.source, r.outcome_id, r.created_at]
        .map(cell)
        .join(","),
    );
  }
  return c.body(lines.join("\n") + "\n", 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="journal-${today()}.csv"`,
  });
});

journalRoutes.get("/:id", (c) => {
  const row = entryRow(c.req.param("id"));
  if (!row) return c.json({ error: "No journal entry by that id." }, 404);
  return c.json({ entry: shape(row), definitions: DEFINITIONS });
});

/**
 * FILE AN ENTRY.
 *
 * `source` IS NOT READ FROM THE REQUEST on this route and never can be: it is
 * hard-coded `ui` here, and the skills proxy reaches its own route below which
 * hard-codes `agent`. A caller that could name its own source could file the
 * agent's own work as the owner's, which is the one thing this area's rules
 * forbid.
 */
journalRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);
  const out = addEntry({
    kind: body.kind,
    text: body.text,
    venture: body.venture ?? body.ventureId,
    url: body.url,
    at: body.at,
    result: body.result,
    source: "ui",
  });
  if ("error" in out) return c.json({ error: out.error }, out.status);
  return c.json({ entry: shape(out.entry), definitions: DEFINITIONS }, 201);
});

/**
 * THE AGENT'S DOOR, and it is a SEPARATE ROUTE from the one above for the one
 * reason that matters: the row it writes is stamped `source: "agent"`, so a
 * reader can always tell an entry the owner typed from one the agent filed on
 * his behalf. Same validation, same gate, different provenance — and the skill
 * that reaches it carries the rule that it may only ever be used for what the
 * owner SAID he did.
 */
journalRoutes.post("/agent", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  /*
    HOW FAR BACK THE AGENT MAY REACH, AND WHY ONLY THIS DOOR HAS A BOUND.

    A person back-dating is answering "when was that?" from memory and is
    bounded by the fact that he was there. An agent asked to write up a
    conversation has no such anchor: a sentence that happens to contain "last
    March" is enough for it to file work in March, and a single well-meant
    tidy-up pass with no bound could rewrite a year of the operating history in
    one call. Seven days covers every case this door is actually for — the owner
    telling it about last week — and anything older is a job for the Journal
    page, where he can see what he is writing before it lands.

    Parsed HERE rather than left to `addEntry` because the bound belongs to this
    door and not to the table: the page may still file 2019 if that is the truth.
  */
  const asked = parseDay(body.at);
  if ("error" in asked) return c.json({ error: asked.error }, 400);
  if (asked.day < oldestAgentDay())
    return c.json(
      {
        error:
          `${asked.day} is more than ${AGENT_BACKDATE_DAYS} days ago. You may file ` +
          `what the owner did in the last ${AGENT_BACKDATE_DAYS} days; anything ` +
          `older he files himself on the Journal page, where he can see it. Tell ` +
          `him that rather than moving the date.`,
      },
      400,
    );

  const out = addEntry({
    kind: body.kind,
    text: body.text,
    venture: body.venture ?? body.ventureId,
    url: body.url,
    at: body.at,
    result: body.result,
    source: "agent",
  });
  if ("error" in out) return c.json({ error: out.error }, out.status);
  return c.json(
    {
      entry: shape(out.entry),
      note:
        "Filed as source “agent”. This records what the OWNER said he did. " +
        "Work you did yourself is not a journal entry. Rows filed this way are " +
        "NOT counted towards his streak — see `streak.sources`.",
      definitions: DEFINITIONS,
    },
    201,
  );
});

/** What came of it, written later and only ever by a person. */
journalRoutes.patch("/:id", async (c) => {
  const row = entryRow(c.req.param("id"));
  if (!row) return c.json({ error: "No journal entry by that id." }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || body.result === undefined)
    return c.json({ error: "The only field this route changes is `result` — what came of it, in your words." }, 400);
  const raw = body.result === null ? null : String(body.result);
  if (raw !== null && raw.length > MAX_RESULT)
    return c.json({ error: `The result is at most ${MAX_RESULT} characters.` }, 413);
  return c.json({ entry: shape(setResult(row.id, raw)!), definitions: DEFINITIONS });
});

journalRoutes.delete("/:id", (c) => {
  const row = entryRow(c.req.param("id"));
  if (!row) return c.json({ error: "No journal entry by that id." }, 404);
  const gone = shape(row);
  deleteEntry(row.id);
  return c.json({
    deleted: gone,
    /* Said explicitly because a delete that leaves something behind is the one
       kind of delete a person needs to be told about. The feed event goes; the
       outcome does not. */
    alsoRemoved: ["its event on the activity feed"],
    note: gone.outcomeId
      ? `The outcome ${gone.outcomeId} this entry created is NOT deleted with it: its readings are a record of what a metric did, and they stand on their own.`
      : null,
  });
});

/**
 * TRACK WHAT CAME OF IT.
 *
 * The metric is an ADDRESS the caller supplies — which skill, which view, which
 * dotted path — exactly as `/api/outcomes` takes it, because only the person
 * looking at a document knows which field in it is the one this entry should
 * have moved. Nothing is guessed here: a default address would produce a
 * baseline against a figure nobody chose and a verdict about it a month later.
 */
journalRoutes.post("/:id/outcome", async (c) => {
  const row = entryRow(c.req.param("id"));
  if (!row) return c.json({ error: "No journal entry by that id." }, 404);
  if (row.outcome_id)
    return c.json(
      { error: `That entry is already tracked as outcome ${row.outcome_id}. Read it at /api/outcomes/${row.outcome_id}.` },
      409,
    );
  if (!(TRACKABLE as readonly string[]).includes(row.kind))
    return c.json(
      {
        error:
          `Only a ${TRACKABLE.join(" or ")} entry can be tracked: those are the ` +
          `kinds where something exists in the world for a metric to have moved. This one is “${row.kind}”.`,
      },
      400,
    );
  if (!row.url)
    return c.json(
      { error: "That entry has no link on it, so there is nothing to point a measurement at. Add the URL first." },
      400,
    );

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string).trim() : "");
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

  const params: Record<string, string> = {};
  if (body?.params !== undefined && body.params !== null) {
    const raw = typeof body.params === "string" ? safeJson(body.params) : body.params;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return c.json({ error: "`params` is an object of the view's parameters, or absent." }, 400);
    for (const [k, val] of Object.entries(raw as Record<string, unknown>))
      if (typeof val === "string" || typeof val === "number") params[k] = String(val);
  }

  const created = await createOutcomeWithBaseline({
    title: row.text.slice(0, 120),
    ventureId: row.venture_id,
    /* `note` rather than a kind of its own: the outcomes table's kinds are
       card, run and note, and a journal entry is the owner's own note about
       something he did. `actionRef` carries the id, so the outcome can always
       be traced back to the sentence that made it. */
    actionKind: "note",
    actionRef: row.id,
    actionText: row.url ? `${row.text} — ${row.url}` : row.text,
    /* Noon on the entry's own day. The action anchors every offset, and a
       midnight instant would make a same-day 7-day reading land twelve hours
       early. */
    actionAt: new Date(`${row.at}T12:00:00Z`).toISOString(),
    skill,
    view: str("view") || "default",
    params,
    path,
    unit: str("unit") || null,
  });

  /* `createOutcomeWithBaseline` returns null only when it refused the input,
     and every field it validates was validated above — so this is a 500 rather
     than a 400: it means this route and that function disagree, which is a bug
     here and not a mistake the caller made. */
  if (!created)
    return c.json({ error: "The outcome could not be created from this entry." }, 500);

  setOutcome(row.id, created.id);
  return c.json(
    {
      entry: shape(entryRow(row.id)!),
      outcomeId: created.id,
      baseline: { value: created.baseline.value, error: created.baseline.error },
      note:
        "The baseline was read just now; readings follow at 7, 14 and 30 days " +
        "after the entry's date. Correlation, not causation — this box reports " +
        "two numbers and a window and nothing about cause.",
    },
    201,
  );
});

/** The earliest day `POST /agent` will accept, as a local date. */
function oldestAgentDay(from = new Date()): string {
  const d = new Date(`${today(from)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - AGENT_BACKDATE_DAYS);
  return d.toISOString().slice(0, 10);
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Exported so the skill can state the same limits this route enforces. */
export const LIMITS = { maxText: MAX_TEXT, maxResult: MAX_RESULT };
