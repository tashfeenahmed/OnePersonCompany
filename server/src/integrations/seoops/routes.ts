/**
 * `/api/seoops` — the off-page half of looking after a small site.
 *
 * FOUR THINGS THAT DO NOT SUM. A URL's Search Console history, a directory
 * checklist, a model's opinion of a screenshot, and a browser's reading of a
 * page's computed styles. They share a route prefix because they are the same
 * WORK and not because any figure here belongs beside any other one; nothing
 * on this route adds a listing to a click.
 *
 * EVERY BOOLEAN ON A WRITE IS PARSED STRICTLY AND REFUSED WHEN IT CANNOT BE.
 * The skills proxy sends every parameter as a STRING, so a route that tested
 * `force === true` would see `"true"` and take the cheap branch — or worse,
 * see `"false"` and take the expensive one, because a non-empty string is
 * truthy. `bool()` below returns null for anything it cannot read and every
 * caller answers 400 on a null. A vision pass is a bill, and a bill spent
 * because a flag arrived as text is the failure this rule exists for.
 */
import { Hono } from "hono";
import { db, ventureRow, ventureRows } from "../../db.ts";
import {
  baselineRow,
  baselineRows,
  createBaseline,
  diagnosisRows,
  doneCards,
  dueFollowUps,
  offsetsOf,
  readingRows,
  runFollowUp,
  shapeBaseline,
  sweep,
  tagged,
  urlsIn,
} from "./followup.ts";
import { DIAGNOSES, FLAT_BAND_PCT, MIN_BASELINE_IMPRESSIONS } from "./diagnose.ts";
import { LISTING_STATES, detect, setListing, shapeLedger } from "./listings.ts";
import {
  ISSUE_KINDS,
  VERDICTS,
  capability,
  latestVision,
  lookAt,
  readIssues,
  storedCapability,
  type VisionResult,
} from "./vision.ts";
import { measureVenture, setOverride, shapeBrand, validateOverride } from "./brand.ts";
import { WINDOW_DAYS, optedIn, settings, venturesFor } from "./settings.ts";
import { activeProvider } from "../../models/provider.ts";

export const seoopsRoutes = new Hono();

/** A boolean off the wire, or null for anything that is not one. See the file
 *  header: a flag that arrives as the string "false" must not read as true. */
function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(s)) return true;
    if (["false", "no", "off", "0", ""].includes(s)) return false;
  }
  if (v === undefined || v === null) return false;
  return null;
}

/* --------------------------------------------------------------- overview */

seoopsRoutes.get("/", (c) => {
  const s = settings();
  const baselines = baselineRows().map(shapeBaseline);
  const due = dueFollowUps();
  const ledger = shapeLedger();
  const p = activeProvider();
  const cap = p ? storedCapability(p.id, p.defaultModel) : null;

  const visionVentures = venturesFor(s.visionVentures);
  const renderedVentures = venturesFor(s.renderedVentures);

  return c.json({
    followUps: {
      tracked: baselines.length,
      measuredBaselines: baselines.filter((b) => b.baseline?.measured).length,
      unmeasuredBaselines: baselines.filter((b) => b.baseline && !b.baseline.measured).length,
      dueNow: due.length,
      offsetsDays: s.offsets,
      windowDays: WINDOW_DAYS,
      tag: s.tag,
      verdicts: countBy(baselines.flatMap((b) => b.diagnoses.map((d) => d.verdict))),
    },
    listings: {
      directories: ledger.catalogue.count,
      detectable: ledger.catalogue.detectable,
      ventures: ledger.ventures.length,
      confirmed: ledger.ventures.reduce((n, v) => n + v.summary.confirmed, 0),
      submitted: ledger.ventures.reduce((n, v) => n + v.summary.submitted, 0),
      detected: ledger.ventures.reduce((n, v) => n + v.summary.detected, 0),
      notListed: ledger.ventures.reduce((n, v) => n + v.summary.notListed, 0),
      errors: ledger.catalogue.errors,
    },
    vision: {
      /** null = never probed. This is not "no". */
      supportsImages: cap?.supports ?? null,
      probedAt: cap?.at ?? null,
      detail: cap?.detail ?? "The active model has never been probed for image input.",
      optedIn: visionVentures.map((v) => v.slug),
      verdicts: countBy(
        visionVentures.map((v) => latestVision(v.id)?.verdict).filter((x): x is string => Boolean(x)),
      ),
    },
    brand: {
      optedIn: renderedVentures.map((v) => v.slug),
      measured: (db.prepare("SELECT COUNT(*) AS n FROM brand_measured").get() as { n: number }).n,
      overridden: (db.prepare("SELECT COUNT(*) AS n FROM brand_overrides").get() as { n: number }).n,
    },
    notes: [
      "Nothing on this route sums across its four halves. A directory row and a " +
        "click are not the same kind of thing.",
      "A page missing from a capped Search Console report is UNMEASURED, never " +
        "zero. Every reading carries `measured` beside its figures.",
      "Detection may only move a listing FORWARD to `detected`. It can never " +
        "un-tick work the owner recorded.",
      "A visual verdict is a MODEL's opinion of a picture and is reported apart " +
        "from the measured checks on the same capture.",
    ],
  });
});

function countBy(list: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of list) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/* ------------------------------------------------------------- follow-ups */

seoopsRoutes.get("/followups", (c) => {
  const key = c.req.query("venture") ?? "";
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);
  const s = settings();
  const list = baselineRows(v?.id ?? null).map(shapeBaseline);
  return c.json({
    count: list.length,
    baselines: list,
    schedule: { offsetsDays: s.offsets, windowDays: WINDOW_DAYS, tag: s.tag },
    diagnoses: [...DIAGNOSES],
    thresholds: { flatBandPct: FLAT_BAND_PCT, minBaselineImpressions: MIN_BASELINE_IMPRESSIONS },
    notes: [
      "`measured: false` on a reading means Search Console was asked and gave " +
        "this URL no row, or could not be asked at all. It is NOT a zero and no " +
        "delta is computed from it — the verdict is `unmeasured`.",
      "A reading whose `source` is `stored-capped` came from the collector's top-25 " +
        "page ranking rather than a filtered query, describes that collection's " +
        "window rather than this one, and is a floor rather than a total.",
      "The baseline was captured AFTER the work was marked done, so its window " +
        "already contains the change. Google needs days to re-crawl and weeks to " +
        "re-rank, which is why that is a compromise rather than a mistake.",
      "`verdict` is arithmetic and is never decided by a model. A model may " +
        "choose WHICH of the nine diagnoses fits, from the same numbers, and its " +
        "answer is thrown away whole unless it is one of the nine with a sentence " +
        "quoting a figure. `decidedBy` says which decided.",
      "Correlation, not causation. Nothing here controls for anything else that " +
        "happened in the window.",
    ],
  });
});

seoopsRoutes.get("/followups/candidates", (c) => {
  const s = settings();
  const cards = doneCards(200);
  const rows = cards
    .map((card) => {
      const text = `${card.title}\n${card.body ?? ""}`;
      return { card, isTagged: tagged(text, s.tag), urls: urlsIn(text) };
    })
    .filter((r) => r.isTagged);
  return c.json({
    tag: s.tag,
    doneCardsScanned: cards.length,
    tagged: rows.length,
    candidates: rows.map((r) => ({
      cardId: r.card.id,
      title: r.card.title,
      ventureId: r.card.venture_id,
      doneAt: r.card.done_at,
      urls: r.urls,
      tracked: r.urls.map(
        (u) =>
          !!db
            .prepare("SELECT id FROM seo_baselines WHERE source = 'card' AND source_ref = ? AND url = ?")
            .get(String(r.card.id), u),
      ),
    })),
    note:
      `A finished card counts as SEO work when its title or body carries ${s.tag} ` +
      "and it names at least one http(s) URL. Both are required: the tag says the " +
      "owner meant it, the URL says which page to measure.",
  });
});

seoopsRoutes.get("/followups/:id", (c) => {
  const row = baselineRow(c.req.param("id"));
  if (!row) return c.json({ error: "No baseline by that id." }, 404);
  return c.json(shapeBaseline(row));
});

/**
 * ONE FIGURE, FOR chief/outcomes.ts TO READ.
 *
 * The outcomes area addresses a metric as `skill` + `view` + `params` + a
 * dotted `path` into the document it gets back. This is the document: one
 * number at `value`, and `value: null` whenever the reading was not measured —
 * which outcomes.ts already knows how to record as a null reading with a
 * reason rather than as a zero. Nothing over there had to learn what a URL is.
 */
seoopsRoutes.get("/metric", (c) => {
  const id = c.req.query("baseline") ?? "";
  const field = (c.req.query("field") ?? "clicks").toLowerCase();
  const row = baselineRow(id);
  if (!row) return c.json({ error: `No baseline by the id "${id}".` }, 404);
  if (!["clicks", "impressions", "ctr", "position"].includes(field))
    return c.json({ error: "field is one of clicks, impressions, ctr, position." }, 400);

  const readings = readingRows(row.id);
  const latest = [...readings].reverse().find((r) => r.measured === 1) ?? null;
  const value = latest
    ? field === "clicks"
      ? latest.clicks
      : field === "impressions"
        ? latest.impressions
        : field === "ctr"
          ? latest.ctr
          : latest.position
    : null;

  return c.json({
    baseline: row.id,
    url: row.url,
    field,
    /** Null whenever nothing was measured. Never a zero. */
    value: value ?? null,
    measured: Boolean(latest),
    at: latest?.ts ?? null,
    window: latest ? { start: latest.window_start, end: latest.window_end, days: latest.window_days } : null,
    unit: field === "ctr" ? "percent" : field === "position" ? "average rank (lower is better)" : `${field} per ${WINDOW_DAYS} days`,
    why: latest ? null : (readings.at(-1)?.error ?? "No reading of this URL has been measured."),
  });
});

seoopsRoutes.post("/sweep", async (c) => {
  const result = await sweep();
  return c.json({
    ...result,
    note:
      `${result.created.length} baseline(s) created from ${result.scanned} finished card(s). ` +
      "The sweep is idempotent: a card already tracked is skipped, so this can be " +
      "run as often as you like.",
  });
});

seoopsRoutes.post("/followups", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);
  const raw = typeof body.url === "string" ? body.url.trim() : "";
  if (!raw) return c.json({ error: "A baseline needs a `url` — the page whose Search Console row to capture." }, 400);
  let url: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
    url = u.href;
  } catch {
    return c.json({ error: `“${raw}” is not an http(s) URL.` }, 400);
  }

  const key = typeof body.venture === "string" ? body.venture.trim() : "";
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);

  const rawAt = typeof body.actionAt === "string" ? body.actionAt.trim() : "";
  const at = rawAt ? new Date(rawAt) : new Date();
  if (Number.isNaN(at.getTime()))
    return c.json({ error: `"${rawAt}" is not a date. Use YYYY-MM-DD or an ISO instant.` }, 400);
  if (at.getTime() > Date.now() + 86_400_000)
    return c.json({ error: "The action date is in the future. A baseline measures work that happened." }, 400);

  const title = (typeof body.title === "string" ? body.title.trim() : "") || `Work on ${url}`;
  const made = await createBaseline({
    url,
    ventureId: v?.id ?? null,
    source: "manual",
    sourceRef: null,
    title,
    actionAt: at.toISOString(),
    tag: null,
  });
  return c.json(
    {
      baseline: shapeBaseline(baselineRow(made.id)!),
      note: made.reading.measured
        ? `Baseline captured from ${made.reading.source}.`
        : `The baseline could not be measured and was recorded as unmeasured with the reason. That is not a zero.`,
    },
    201,
  );
});

seoopsRoutes.post("/followups/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const useModel = bool(body.model ?? true);
  if (useModel === null) return c.json({ error: "`model` is true or false." }, 400);
  const due = dueFollowUps();
  const done: unknown[] = [];
  for (const { baseline, dayOffset } of due) {
    const r = await runFollowUp(baseline, dayOffset, useModel);
    done.push({
      baseline: r.baselineId,
      url: baseline.url,
      dayOffset: r.dayOffset,
      measured: r.reading.measured,
      verdict: r.judgement.verdict,
      diagnosis: r.judgement.diagnosis,
      decidedBy: r.decidedBy,
    });
  }
  return c.json({ due: due.length, ran: done.length, results: done });
});

seoopsRoutes.post("/followups/:id/run", async (c) => {
  const row = baselineRow(c.req.param("id"));
  if (!row) return c.json({ error: "No baseline by that id." }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const useModel = bool(body.model ?? true);
  if (useModel === null) return c.json({ error: "`model` is true or false." }, 400);

  /* WHICH SLOT. The offset given, or the smallest one that is due, or — when
     nothing is due — the largest configured offset, taken as an EXTRA reading
     that does not fill a slot. A hand reading on day six is not the day-14
     reading, and letting it be one would move the schedule to whenever
     somebody pressed a button. */
  const asked = body.dayOffset === undefined ? null : Number(body.dayOffset);
  const offsets = offsetsOf(row);
  /* A SLOT IS ONE OF THIS BASELINE'S OWN OFFSETS AND NOTHING ELSE. Accepting
     any integer let `-5` or `99999` be filled by hand, which would put a
     reading on the chart at a day that is not on the schedule and can never
     come round again. */
  if (asked !== null && !offsets.includes(asked))
    return c.json(
      {
        error:
          `dayOffset must be one of this baseline's own offsets (${offsets.join(", ")}). ` +
          `A reading at any other day is not one of the scheduled slots.`,
      },
      400,
    );
  const taken = new Set(readingRows(row.id).map((r) => r.day_offset).filter((n): n is number => n !== null));
  const age = (Date.now() - Date.parse(row.action_at)) / 86_400_000;
  const nextDue = offsets.find((d) => age >= d && !taken.has(d)) ?? null;
  const slot = asked !== null ? asked : nextDue;
  if (slot === null)
    return c.json(
      {
        error:
          `Nothing is due on that baseline yet: it is ${Math.floor(age)} day(s) old and the ` +
          `follow-ups are at ${offsets.join(", ")} days. Pass \`dayOffset\` to force a slot.`,
      },
      409,
    );
  const diagnosed = new Set(diagnosisRows(row.id).map((d) => d.day_offset));
  /* Same rule as `dueFollowUps` (see followup.ts): a slot with a reading and
     no diagnosis is not finished, so re-running it here reuses the existing
     reading and only asks for the verdict — no second Search Console call. */
  if (taken.has(slot) && diagnosed.has(slot))
    return c.json({ error: `The ${slot}-day reading has already been taken and diagnosed. It is not retaken.` }, 409);

  const r = await runFollowUp(row, slot, useModel);
  return c.json({
    baseline: shapeBaseline(baselineRow(row.id)!),
    ran: {
      dayOffset: r.dayOffset,
      measured: r.reading.measured,
      verdict: r.judgement.verdict,
      diagnosis: r.judgement.diagnosis,
      decidedBy: r.decidedBy,
      model: r.model,
      modelNote: r.modelNote,
      note: r.modelError,
    },
  });
});

seoopsRoutes.post("/followups/:id/close", (c) => {
  const row = baselineRow(c.req.param("id"));
  if (!row) return c.json({ error: "No baseline by that id." }, 404);
  db.prepare("UPDATE seo_baselines SET closed_at = COALESCE(closed_at, ?) WHERE id = ?").run(
    new Date().toISOString(),
    row.id,
  );
  return c.json({
    baseline: shapeBaseline(baselineRow(row.id)!),
    note: "Closed: no further follow-ups will be scheduled. The readings already taken stay.",
  });
});

seoopsRoutes.delete("/followups/:id", (c) => {
  const row = baselineRow(c.req.param("id"));
  if (!row) return c.json({ error: "No baseline by that id." }, 404);
  const gone = shapeBaseline(row);
  db.prepare("DELETE FROM seo_baseline_readings WHERE baseline_id = ?").run(row.id);
  db.prepare("DELETE FROM seo_diagnoses WHERE baseline_id = ?").run(row.id);
  db.prepare("DELETE FROM seo_baselines WHERE id = ?").run(row.id);
  return c.json({ deleted: gone });
});

/* --------------------------------------------------------------- listings */

seoopsRoutes.get("/listings", (c) => {
  const key = c.req.query("venture") ?? "";
  const v = key ? ventureRow(key) : undefined;
  if (key && !v) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);
  return c.json(shapeLedger(v?.id ?? null));
});

seoopsRoutes.post("/listings/set", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);
  const key = typeof body.venture === "string" ? body.venture.trim() : "";
  const v = key ? ventureRow(key) : undefined;
  if (!v) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);
  const directoryId = typeof body.directory === "string" ? body.directory.trim().toLowerCase() : "";
  const state = typeof body.state === "string" ? body.state : "";

  const result = setListing({
    ventureId: v.id,
    directoryId,
    state,
    note: body.note === undefined ? undefined : (body.note as string | null),
    url: body.url,
  });
  if ("error" in result) return c.json(result, 400);
  return c.json({
    row: result.row,
    ledger: shapeLedger(v.id),
    note:
      "Set by the owner. Detection can never move this row back — it may only " +
      "ratchet an untouched row forward to `detected`.",
  });
});

seoopsRoutes.post("/listings/detect", (c) => {
  const result = detect();
  return c.json({
    ...result,
    note:
      "Detection reads the presence collector's rows and may only move a row " +
      "forward to `detected`. `blocked` and `error` cells are not findings and " +
      "were ignored; a row the owner has touched was left alone and is listed " +
      "under `held`.",
  });
});

/* ----------------------------------------------------------------- vision */

seoopsRoutes.get("/vision", (c) => {
  const s = settings();
  const p = activeProvider();
  const cap = p ? storedCapability(p.id, p.defaultModel) : null;
  const all = ventureRows();
  return c.json({
    capability: {
      supportsImages: cap?.supports ?? null,
      provider: p?.id ?? null,
      model: p?.defaultModel ?? null,
      probedAt: cap?.at ?? null,
      detail:
        cap?.detail ??
        (p
          ? "The active model has never been probed for image input. Press Probe, or run a pass — it probes once and remembers."
          : "No model provider is the default, so nothing can be asked to look."),
    },
    ventures: all.map((v) => {
      const row = latestVision(v.id);
      return {
        ventureId: v.id,
        venture: v.name,
        slug: v.slug,
        optedIn: optedIn(s.visionVentures, v),
        verdict: row?.verdict ?? null,
        issues: readIssues(row?.issues ?? null),
        at: row?.ts ?? null,
        shotTs: row?.shot_ts ?? null,
        model: row?.model ?? null,
        error: row?.error ?? null,
      };
    }),
    verdicts: [...VERDICTS],
    issueKinds: [...ISSUE_KINDS],
    notes: [
      "A visual verdict is a MODEL's opinion of a picture. It is reported apart " +
        "from the measured checks on the same capture — those are arithmetic over " +
        "the PNG's pixels and cannot be wrong in the way this can.",
      "`broken` always carries at least one issue: an answer calling a page " +
        "broken with nothing to point at is thrown away whole and recorded as an " +
        "unreadable answer, not as a fault.",
      "A verdict is reused for an unchanged capture, keyed on the SHA-256 of the " +
        "file. A weekly capture of a site nobody touched costs nothing.",
      "`supportsImages: null` means nothing is known either way — the probe did " +
        "not complete. It is not a `no`.",
      "Off by default and opt-in per venture: a vision call is a bill.",
    ],
  });
});

seoopsRoutes.post("/vision/probe", async (c) => {
  const cap = await capability({ force: true });
  return c.json({
    capability: cap,
    note:
      "One 1×1 PNG was sent. An answer proves the request shape is accepted; it " +
      "does not prove the model looks carefully, which is what the verdicts and " +
      "their issues are for.",
  });
});

seoopsRoutes.post("/vision/run", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const force = bool(body.force);
  if (force === null) return c.json({ error: "`force` is true or false." }, 400);

  const s = settings();
  const key = typeof body.venture === "string" ? body.venture.trim() : "";
  let targets = venturesFor(s.visionVentures);
  if (key) {
    const v = ventureRow(key);
    if (!v) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);
    if (!optedIn(s.visionVentures, v))
      return c.json(
        {
          error:
            `${v.name} is not opted in to visual QA. Add its slug to "Vision ventures" ` +
            `under Integrations → SEO Ops — a vision call is a bill and nothing is ` +
            `looked at by default.`,
        },
        409,
      );
    targets = [v];
  }
  if (!targets.length)
    return c.json({
      ran: 0,
      results: [],
      note:
        "No venture is opted in to visual QA, so nothing was asked and nothing was " +
        "spent. Add slugs to \"Vision ventures\" under Integrations → SEO Ops.",
    });

  const results: VisionResult[] = [];
  for (const v of targets) results.push(await lookAt(v, { force }));
  return c.json({
    ran: results.length,
    reused: results.filter((r) => r.reused).length,
    results,
    note:
      "Visual verdicts are separate from the measured checks on the same capture. " +
      "A reused verdict cost nothing: the picture had not changed.",
  });
});

/* ------------------------------------------------------------------ brand */

seoopsRoutes.get("/brand/:venture", (c) => {
  const v = ventureRow(c.req.param("venture"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  const doc = shapeBrand(v.id);
  if (!doc) return c.json({ error: "No venture by that id or slug." }, 404);
  return c.json({ ...doc, optedIn: optedIn(settings().renderedVentures, v) });
});

seoopsRoutes.post("/brand/:venture/measure", async (c) => {
  const v = ventureRow(c.req.param("venture"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  /* THE OPT-IN IS ENFORCED HERE TOO, exactly as the vision route enforces its
     own. Driving a headless browser with JavaScript enabled at a URL somebody
     typed is the most powerful thing this area does, and a route that did it
     for any venture made the setting a suggestion. The nightly pass already
     gated it; this is the door a person and an agent come in through. */
  if (!optedIn(settings().renderedVentures, v))
    return c.json(
      {
        error:
          `${v.name} is not opted in to the rendered brand pass. Add its slug to ` +
          `"Rendered-brand ventures" under Integrations → SEO Ops — it drives a ` +
          `headless browser at the site, and nothing is opened by default.`,
      },
      409,
    );
  const doc = await measureVenture(v);
  return c.json({
    rendered: doc,
    brand: shapeBrand(v.id),
    note: doc.error
      ? "The rendered reading failed and was stored with its reason. The static reading is untouched and is still the fallback."
      : "Measured in a headless browser from computed styles. `ventures.brand` — the static reading — was not touched.",
  });
});

seoopsRoutes.post("/brand/:venture/override", async (c) => {
  const v = ventureRow(c.req.param("venture"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);
  const checked = validateOverride(body);
  if ("error" in checked) return c.json(checked, 400);
  setOverride(v.id, checked.doc);
  return c.json({
    brand: shapeBrand(v.id),
    note:
      "The override sits over both readings and neither is erased. Clearing every " +
      "field removes the override entirely and the measurements stand again.",
  });
});

/* ---------------------------------------------------------------- ventures */

/** The plugin's entities, for the venture-links surface every plugin page
 *  offers: this area is about ventures and their sites. */
seoopsRoutes.get("/entities", (c) =>
  c.json({
    entities: ventureRows()
      .filter((v) => v.host || v.website)
      .map((v) => ({
        plugin: "seoops",
        entity: v.id,
        label: `${v.name}${v.host ? ` (${v.host})` : ""}`,
        host: v.host,
      })),
  }),
);

/** Used by the diagnosis list and by the tests: the closed vocabularies this
 *  area refuses to extend at runtime. */
seoopsRoutes.get("/vocabulary", (c) =>
  c.json({
    diagnoses: [...DIAGNOSES],
    listingStates: [...LISTING_STATES],
    visionVerdicts: [...VERDICTS],
    issueKinds: [...ISSUE_KINDS],
    note:
      "Every one of these is closed. A word outside its list is refused rather " +
      "than tidied into the nearest neighbour, on both the owner's writes and a " +
      "model's answers.",
  }),
);
