/**
 * OUTCOMES — did the thing he did actually do anything?
 *
 * THIS BOX IS FULL OF WORK AND FULL OF MEASUREMENTS AND NOTHING JOINED THEM.
 * Cards move to Done, runs produce reports, decisions get taken in a chat; on
 * the other side, thirty collectors write figures every half hour. Between the
 * two there was no line at all, so the question every one-person company
 * actually has — "was that worth doing?" — had no answer here beyond memory.
 *
 * AN OUTCOME IS A LINK, and it is deliberately the thinnest thing that can
 * answer the question: one ACTION with a date, one METRIC with an address, a
 * BASELINE captured when the link was made, and READINGS at 7, 14 and 30 days
 * after the action.
 *
 * THE METRIC IS AN ADDRESS AND NOT A FUNCTION. `skill` + `view` + `params` +
 * `path` is how everything on this box addresses a figure: the skills proxy
 * turns the first three into a document, and the path picks a field out of it.
 * That is what makes this generic — a metric another area ships next month is
 * trackable the day it ships, with no edit here — and it is also what makes it
 * honest, because the document the reading came out of is nameable in the
 * answer.
 *
 * WHAT IT CANNOT DO, SAID EVERY TIME RATHER THAN ONCE IN A HEADER. It cannot
 * establish CAUSE. Two figures either side of a date are two figures either
 * side of a date; one person shipping one thing on one Tuesday is an anecdote
 * with arithmetic on top. What this IS is the arithmetic done consistently, in
 * the same direction, on everything — so that a pattern over months has
 * somewhere to become visible. The verdicts are coarse for that reason: three
 * words and a band, not a p-value dressed up as a finding.
 *
 * A METRIC THAT CANNOT BE READ IS NULL AND NEVER ZERO. A disconnected plugin, a
 * moved field, a route that 500s: all of those record a reading with a null
 * value and the reason beside it. A zero would put a cliff in the chart that
 * the owner would read as a collapse in the business.
 */
import { PORT } from "../../config.ts";
import { serviceHeaders } from "../../auth.ts";
import { db, now, ventureRowById } from "../../db.ts";

/** When the scheduled readings are taken, in days after the ACTION. Seven for
 *  "did anything move at all", fourteen for "is it still moving", thirty for
 *  "did it stick". Beyond a month the world has changed too much for the link
 *  to be worth drawing, and a fourth reading would mostly measure the season. */
export const OFFSETS = [7, 14, 30] as const;

/** How far either side of parity counts as "no change". A small site's traffic
 *  moves this much between Tuesdays for no reason at all, and a band narrower
 *  than the noise reports weather as consequence. */
export const FLAT_BAND_PCT = 10;

export const MAX_TITLE = 200;
export const MAX_ACTION_TEXT = 2_000;

export type OutcomeRow = {
  id: string;
  title: string;
  venture_id: string;
  action_kind: string;
  action_ref: string;
  action_text: string;
  action_at: string;
  skill: string;
  view: string;
  params: string;
  path: string;
  unit: string | null;
  created_at: string;
  closed_at: string | null;
};

export type ReadingRow = {
  id: number;
  outcome_id: string;
  ts: string;
  kind: string;
  day_offset: number | null;
  value: number | null;
  error: string | null;
  raw: string | null;
};

/* ------------------------------------------------------------ the address */

/**
 * WALK A DOTTED PATH INTO A JSON DOCUMENT.
 *
 * `totals.visitors`, `series[0].value`, `currency.combined`. Deliberately not
 * JSONPath: the expression language is the part that would let a caller write a
 * filter whose answer changes shape between two readings, and a metric whose
 * shape can change is not a metric.
 *
 * A MISSING SEGMENT IS `undefined` AND THE CALLER TURNS THAT INTO A NULL
 * READING WITH A REASON. It is never coerced: `null` in the document (asked and
 * not told) and "the path does not exist" (this address is wrong) are different
 * findings and the reading says which.
 */
export function walk(doc: unknown, path: string): { found: boolean; value: unknown } {
  const segments = path
    .split(".")
    .flatMap((s) => s.split(/\[(\d+)\]/).filter(Boolean))
    .map((s) => s.trim())
    .filter(Boolean);
  let cur: unknown = doc;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { found: false, value: undefined };
      cur = cur[i];
      continue;
    }
    if (typeof cur !== "object") return { found: false, value: undefined };
    const obj = cur as Record<string, unknown>;
    if (!(seg in obj)) return { found: false, value: undefined };
    cur = obj[seg];
  }
  return { found: true, value: cur };
}

/** The skills surface, on this box. Composed here rather than imported from
 *  skills/registry.ts for that file's own reason: importing a VALUE out of the
 *  registry from a module the registry transitively imports is the cycle that
 *  crashes the server at boot. The port is the one thing this needs and
 *  config.ts owns it. */
function skillsUrl(o: OutcomeRow): string {
  const qs = new URLSearchParams();
  if (o.view && o.view !== "default") qs.set("view", o.view);
  for (const [k, v] of Object.entries(readParams(o.params))) qs.set(k, String(v));
  const q = qs.toString();
  return `http://127.0.0.1:${PORT}/api/skills/${encodeURIComponent(o.skill)}${q ? `?${q}` : ""}`;
}

export function readParams(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === "string" || typeof v === "number") out[k] = String(v);
    return out;
  } catch {
    return {};
  }
}

export type ReadOut = { value: number | null; error: string | null; raw: string | null };

/**
 * TAKE ONE READING.
 *
 * Every failure mode gets its own sentence, because "the figure is null" is
 * three very different findings — nobody connected the plugin, the address is
 * wrong, the number is genuinely not reported — and a chart with a gap in it
 * should be able to say which.
 *
 * A NON-NUMBER AT THE PATH IS AN ERROR AND NOT A ZERO. A string that happens to
 * parse ("1,204") is accepted, because several documents here publish formatted
 * figures; anything else is refused with what it actually found.
 */
export async function takeReading(o: OutcomeRow, signal?: AbortSignal): Promise<ReadOut> {
  const url = skillsUrl(o);
  let res: Response;
  try {
    /* The service key: this box reading its own skills route, with no cookie
       to offer. See auth.ts. */
    res = await fetch(url, { headers: serviceHeaders(), signal });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { value: null, error: `The metric could not be fetched: ${why}`, raw: null };
  }
  const text = await res.text();
  if (!res.ok) {
    let why = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === "string") why = body.error;
    } catch {
      /* A non-JSON error body is the status and nothing else, which is what
         `why` already says. */
    }
    return { value: null, error: why, raw: text.slice(0, 400) };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { value: null, error: "The skill answered with something that is not JSON.", raw: text.slice(0, 400) };
  }

  const at = walk(doc, o.path);
  if (!at.found)
    return {
      value: null,
      error: `Nothing at "${o.path}" in that document — the field may have moved or been renamed.`,
      raw: null,
    };
  if (at.value === null)
    return {
      value: null,
      /* The document's own null, carried through as itself. This is the case
         the universal rules are about: asked and not told. */
      error: "The document reports null there — asked and not told, which is not zero.",
      raw: "null",
    };
  const n = typeof at.value === "number" ? at.value : Number(String(at.value).replace(/[,\s]/g, ""));
  if (!Number.isFinite(n))
    return {
      value: null,
      error: `The value at "${o.path}" is not a number (${JSON.stringify(at.value).slice(0, 80)}).`,
      raw: JSON.stringify(at.value).slice(0, 400),
    };
  return { value: n, error: null, raw: JSON.stringify(at.value).slice(0, 400) };
}

/* ---------------------------------------------------------------- storage */

export function outcomeRow(id: string): OutcomeRow | undefined {
  return db.prepare("SELECT * FROM chief_outcomes WHERE id = ?").get(id) as OutcomeRow | undefined;
}

export function outcomeRows(ventureId?: string | null): OutcomeRow[] {
  return ventureId
    ? (db
        .prepare("SELECT * FROM chief_outcomes WHERE venture_id = ? ORDER BY action_at DESC, rowid DESC")
        .all(ventureId) as unknown as OutcomeRow[])
    : (db
        .prepare("SELECT * FROM chief_outcomes ORDER BY action_at DESC, rowid DESC")
        .all() as unknown as OutcomeRow[]);
}

export function readingRows(outcomeId: string): ReadingRow[] {
  return db
    .prepare("SELECT * FROM chief_outcome_readings WHERE outcome_id = ? ORDER BY ts ASC, id ASC")
    .all(outcomeId) as unknown as ReadingRow[];
}

export function writeReading(
  outcomeId: string,
  kind: "baseline" | "reading",
  dayOffset: number | null,
  out: ReadOut,
): ReadingRow {
  const info = db
    .prepare(
      `INSERT INTO chief_outcome_readings (outcome_id, ts, kind, day_offset, value, error, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(outcomeId, now(), kind, dayOffset, out.value, out.error, out.raw);
  return db
    .prepare("SELECT * FROM chief_outcome_readings WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as ReadingRow;
}

/**
 * FILE AN OUTCOME FROM ANOTHER AREA, WITHOUT GOING THROUGH THE ROUTE.
 *
 * outcomes-routes.ts's POST is the door a PERSON comes in through: it parses a
 * body, validates every field for somebody who typed it, and takes the
 * baseline reading itself. An area on this box that already knows its venture,
 * its date and its metric address has none of those problems and should not
 * have to compose an HTTP request to its own process to say so.
 *
 * IT IS IDEMPOTENT ON `action_kind` + `action_ref`, and that is the whole
 * reason it is worth having as a function. A sweep that runs hourly and files
 * an outcome for the same finished card would otherwise leave one row per
 * hour; here the second call finds the first and returns its id. A caller with
 * no ref (`""`) gets a new row every time, which is correct — there is nothing
 * to be the same as.
 *
 * NO BASELINE IS TAKEN HERE. The caller that has its own before-figures —
 * seoops, whose baseline is a Search Console window rather than a field in a
 * document — takes them itself and would be storing them twice. The scheduled
 * readings still run, so the outcome fills in from the first offset onward and
 * `verdict` stays `pending` until then, which is the honest description.
 */
export function createOutcome(input: {
  title: string;
  ventureId?: string | null;
  actionKind: string;
  actionRef?: string;
  actionText?: string;
  actionAt: string;
  skill: string;
  view?: string;
  params?: Record<string, string>;
  path: string;
  unit?: string | null;
}): string | null {
  const title = input.title.trim().slice(0, MAX_TITLE);
  if (!title || !input.skill || !input.path) return null;
  const at = new Date(input.actionAt);
  if (Number.isNaN(at.getTime())) return null;

  const ref = (input.actionRef ?? "").trim();
  if (ref) {
    const held = db
      .prepare("SELECT id FROM chief_outcomes WHERE action_kind = ? AND action_ref = ? AND skill = ? AND path = ?")
      .get(input.actionKind, ref, input.skill, input.path) as { id: string } | undefined;
    if (held) return held.id;
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
    input.ventureId ?? "",
    input.actionKind,
    ref,
    (input.actionText ?? title).slice(0, MAX_ACTION_TEXT),
    at.toISOString(),
    input.skill,
    input.view || "default",
    JSON.stringify(input.params ?? {}),
    input.path,
    input.unit ?? null,
    now(),
  );
  return id;
}

let seq = 0;
export function mintOutcomeId(): string {
  seq = (seq + 1) % 1_000;
  return `oc-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/* ----------------------------------------------------------------- shapes */

export type Verdict = "up" | "down" | "flat" | "pending" | "unreadable";

/**
 * THE OUTCOME AS A READER SEES IT, computed on read rather than stored.
 *
 * COMPUTED, BECAUSE A STORED VERDICT IS A VERDICT THAT CAN GO STALE. Every
 * number below is arithmetic over the readings table, which takes microseconds;
 * a `verdict` column would have to be recomputed on every insert and would
 * disagree with the readings the first time one was taken by hand.
 *
 * `pct` IS NULL WHEN THE BASELINE IS ZERO, and the delta is kept. Zero visitors
 * before and fifty after is an infinite improvement, and the honest rendering
 * of that is a null percentage beside a positive delta — not a division that
 * produces Infinity and gets drawn as a bar.
 *
 * THERE IS NO VERDICT UNTIL THE FIRST SCHEDULED READING EXISTS. Four days of an
 * upward wobble is not an "up", and a verdict that flips back next week teaches
 * the owner to ignore the column.
 */
export function shapeOutcome(o: OutcomeRow) {
  const readings = readingRows(o.id);
  const baseline = readings.find((r) => r.kind === "baseline") ?? null;
  const scheduled = readings.filter((r) => r.kind !== "baseline");
  const latest = [...readings].reverse().find((r) => r.value !== null) ?? null;
  const after = latest && latest.kind !== "baseline" ? latest : null;

  const before = baseline?.value ?? null;
  const now_ = after?.value ?? null;
  const delta = before !== null && now_ !== null ? now_ - before : null;
  const pct = delta !== null && before !== null && before !== 0 ? (delta / before) * 100 : null;

  let verdict: Verdict = "pending";
  if (before === null || (baseline && baseline.value === null && !scheduled.some((r) => r.value !== null)))
    verdict = "unreadable";
  else if (now_ === null) verdict = "pending";
  else if (pct === null) verdict = delta === 0 ? "flat" : delta! > 0 ? "up" : "down";
  else if (pct > FLAT_BAND_PCT) verdict = "up";
  else if (pct < -FLAT_BAND_PCT) verdict = "down";
  else verdict = "flat";

  const v = o.venture_id ? ventureRowById(o.venture_id) : undefined;
  const daysSinceAction = Math.floor((Date.now() - Date.parse(o.action_at)) / 86_400_000);

  return {
    id: o.id,
    title: o.title,
    ventureId: o.venture_id || null,
    /* Null when the venture has been deleted. The claim that the action
       happened survives its business, which is the honest outcome. */
    ventureName: v?.name ?? null,
    action: {
      kind: o.action_kind,
      ref: o.action_ref || null,
      text: o.action_text,
      at: o.action_at,
      daysAgo: Math.max(0, daysSinceAction),
    },
    metric: {
      skill: o.skill,
      view: o.view,
      params: readParams(o.params),
      path: o.path,
      unit: o.unit,
      /* The address, spelled out, so a reader who doubts a figure can fetch
         the same document this did. */
      address: `${o.skill}${o.view && o.view !== "default" ? `?view=${o.view}` : ""} → ${o.path}`,
    },
    createdAt: o.created_at,
    closedAt: o.closed_at,
    baseline: baseline
      ? { at: baseline.ts, value: baseline.value, error: baseline.error }
      : null,
    /* Every reading, including the failed ones. A chart drawn from this must
       show a gap where a value is null and never a zero. */
    readings: readings.map((r) => ({
      at: r.ts,
      kind: r.kind,
      dayOffset: r.day_offset,
      value: r.value,
      error: r.error,
    })),
    before,
    after: now_,
    delta,
    pct,
    verdict,
    /* WHICH SCHEDULED READINGS ARE STILL TO COME, so a "pending" outcome says
       when it will stop being pending rather than looking broken. */
    due: OFFSETS.filter((d) => !scheduled.some((r) => r.day_offset === d)).map((d) => ({
      dayOffset: d,
      dueAt: new Date(Date.parse(o.action_at) + d * 86_400_000).toISOString(),
      overdue: daysSinceAction >= d,
    })),
    /* THE WINDOW, IN WORDS, ON EVERY OUTCOME. A before/after pair with no
       window stated is a number pretending to be a finding. */
    window:
      baseline && after
        ? `Baseline read ${baseline.ts.slice(0, 10)}; latest reading ${after.ts.slice(0, 10)}, ` +
          `${after.day_offset ?? daysSinceAction} days after the action on ${o.action_at.slice(0, 10)}.`
        : `Baseline read ${baseline?.ts.slice(0, 10) ?? "not yet"}; no reading has been taken since the action.`,
    /* SAID ON EVERY OUTCOME, not once in a help page. */
    caveat:
      "This is correlation, not causation: two figures either side of a date. " +
      "Nothing here controls for anything else that happened.",
  };
}

/* ------------------------------------------------------------- the schedule */

/**
 * WHICH READINGS ARE DUE.
 *
 * A reading is due when the action is at least N days old and no reading with
 * that offset has been taken. Offsets are filled in order and a late one is
 * still taken — a box that was off for a week takes the 7-day reading on day
 * nine and records that it did, rather than skipping it and leaving a hole
 * nobody can explain.
 */
export function dueReadings(): { outcome: OutcomeRow; dayOffset: number }[] {
  const out: { outcome: OutcomeRow; dayOffset: number }[] = [];
  for (const o of db
    .prepare("SELECT * FROM chief_outcomes WHERE closed_at IS NULL")
    .all() as unknown as OutcomeRow[]) {
    const age = (Date.now() - Date.parse(o.action_at)) / 86_400_000;
    if (!Number.isFinite(age)) continue;
    const taken = new Set(
      (
        db
          .prepare("SELECT day_offset FROM chief_outcome_readings WHERE outcome_id = ? AND day_offset IS NOT NULL")
          .all(o.id) as unknown as { day_offset: number }[]
      ).map((r) => r.day_offset),
    );
    for (const d of OFFSETS) if (age >= d && !taken.has(d)) out.push({ outcome: o, dayOffset: d });
  }
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * THE READINGS TIMER.
 *
 * Hourly, and it does nothing at all until something is due — which for a box
 * with no outcomes tracked is for ever. Same argument as every other schedule
 * here: the due-ness is asked of the TABLE, so a restart cannot make it take a
 * reading twice, and a laptop that was shut on day seven takes that reading on
 * day nine rather than never.
 *
 * ONE READING PER TICK IS NOT ENFORCED, because a reading is one loopback GET
 * of a document the dashboard serves anyway; twenty of them is the cost of one
 * page load. What IS enforced is that a failure records a row: a metric that
 * could not be read on day seven is a fact about day seven, and retrying it
 * silently until it worked would move the reading to whenever the plugin came
 * back.
 */
export function startReadings() {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      try {
        for (const { outcome, dayOffset } of dueReadings()) {
          const out = await takeReading(outcome);
          writeReading(outcome.id, "reading", dayOffset, out);
        }
      } catch (err) {
        /* Must not throw: a timer with nobody to catch it. */
        console.error("[chief] outcome readings failed", err);
      }
    })();
  }, 60 * 60_000);
  timer.unref?.();
}

/* ------------------------------------------------ the same, with a baseline */

/**
 * `createOutcome` AND THE FIRST READING, IN ONE CALL.
 *
 * WHAT THIS IS FOR. `createOutcome` above creates the row and stops. That is
 * right for a caller that wants to decide separately whether a baseline is
 * worth reading — and the two callers that exist BOTH want one, which is
 * exactly why the "create, then read, then guard against reading twice"
 * sequence should be written once rather than twice.
 *
 * (An earlier version of this comment said seoops deliberately takes no
 * baseline because it holds its own before-figures. That was wrong about
 * seoops: `followup.ts::linkOutcome` reads one through `takeReading` behind the
 * same "does one already exist" guard implemented below. The two paths were
 * written independently and agree; that agreement is what this function is
 * for, and its own note is corrected here rather than left to be believed.)
 *
 * A JOURNAL ENTRY HAS NOTHING OF ITS OWN — "shipped the new pricing page" is a
 * sentence and a link — so its before is whatever the metric says at the moment
 * the owner asks to track it, and it has to be read THEN. `/api/outcomes`'s own
 * POST makes the same argument for itself: "we will read it on the next tick"
 * makes two links made four minutes apart incomparable.
 *
 * A BASELINE THAT COULD NOT BE READ STILL LEAVES THE OUTCOME STANDING, with
 * its reason recorded, so a plugin that was down for a minute does not cost
 * the owner the link. The outcome then reads `verdict: "unreadable"` until a
 * reading succeeds, which is the honest description of what is known.
 *
 * IT INHERITS `createOutcome`'S IDEMPOTENCE AND ADDS ITS OWN, and the second
 * one is the part that had to be a transaction. The check and the insert used
 * to be two statements, so two calls racing — a double-clicked "Take the
 * baseline", a sweep overlapping itself — could both find no baseline and both
 * write one. An outcome with two befores has no before at all: `shapeOutcome`
 * takes `readings.find(kind === "baseline")`, so which of the two numbers the
 * verdict is measured against would be an accident of insertion order. The
 * reading is taken OUTSIDE the transaction (it is a network call and must never
 * hold a write lock) and the claim is staked inside one.
 */
export async function createOutcomeWithBaseline(
  input: Parameters<typeof createOutcome>[0],
): Promise<{ id: string; baseline: ReadOut; reused: boolean } | null> {
  const id = createOutcome(input);
  if (!id) return null;

  const existing = (): ReadingRow | undefined =>
    db
      .prepare(
        "SELECT * FROM chief_outcome_readings WHERE outcome_id = ? AND kind = 'baseline' ORDER BY id LIMIT 1",
      )
      .get(id) as ReadingRow | undefined;

  const held = existing();
  if (held)
    return { id, baseline: { value: held.value, error: held.error, raw: held.raw }, reused: true };

  const baseline = await takeReading(outcomeRow(id)!);

  /* The window between the read above and the write below is where the race
     lived. IMMEDIATE takes the write lock up front, so the loser of a race sees
     the winner's row inside its own transaction and keeps it. */
  db.exec("BEGIN IMMEDIATE");
  try {
    const raced = existing();
    if (raced) {
      db.exec("COMMIT");
      return { id, baseline: { value: raced.value, error: raced.error, raw: raced.raw }, reused: true };
    }
    db.prepare(
      `INSERT INTO chief_outcome_readings (outcome_id, ts, kind, day_offset, value, error, raw)
       VALUES (?, ?, 'baseline', NULL, ?, ?, ?)`,
    ).run(id, now(), baseline.value, baseline.error, baseline.raw);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { id, baseline, reused: false };
}
