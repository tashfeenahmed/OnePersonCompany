/**
 * THE SEO LOOP'S SECOND HALF: what happened after he changed the page.
 *
 * The board is full of finished work and Search Console is full of figures,
 * and until this file nothing joined the two at URL level. chief/outcomes.ts
 * joins an action to a metric ADDRESS — a field in a document — which is
 * exactly right for "did MRR move" and cannot express "did THAT page move",
 * because no document on this box carries a per-URL row for an arbitrary URL.
 * So this captures one, at the moment the work is marked done, and reads it
 * again later.
 *
 * IT IS A SWEEP AND NOT A HOOK, and that is a decision rather than an
 * accident. Hooking `POST /api/board/cards/:id/move` would mean a second
 * author for the board's own rules and a card that could be missed by any
 * other path into Done — an import, a hand-edited row, a future route. The
 * sweep asks the TABLE which finished cards look like SEO work and have no
 * baseline yet, so it is correct after any amount of downtime, cannot double
 * up (the unique index on source+ref+url), and needs nothing running at the
 * moment a card is dragged.
 *
 * A CARD IS SEO WORK IF IT CARRIES THE TAG. One configurable word, `#seo` by
 * default, matched anywhere in the title or the body. Not a column, not an
 * urgency, not a guess from the wording: a heuristic that files baselines for
 * cards the owner did not mean would fill this page with pages nobody touched,
 * and the whole value of the feature is that every row on it is work somebody
 * actually did.
 *
 * THE BASELINE IS TAKEN WHEN THE SWEEP FINDS THE CARD, WHICH IS AFTER THE
 * WORK. That is stated on every row rather than hidden: the "before" window is
 * the 28 days ending three days ago, so a card finished this morning has a
 * baseline that already contains the change. It is still the right comparison
 * — Google needs days to re-crawl and weeks to re-rank, so almost none of the
 * effect is in that window — but it is a compromise and the document says so.
 */
import { db, now, ventureRowById } from "../../db.ts";
import { complete } from "../../models/provider.ts";
import { readUrl, type PageReading } from "./gsc.ts";
import {
  MODEL_SYSTEM,
  NEXT_ACTION,
  diagnose,
  promptFacts,
  validateModelDiagnosis,
  type Diagnosis,
  type Judgement,
  type Side,
} from "./diagnose.ts";
import { WINDOW_DAYS, settings } from "./settings.ts";
import { PORTFOLIO_VENTURE } from "../../runtime/budgets.ts";

/* ------------------------------------------------------------------ rows */

export type BaselineRow = {
  id: string;
  venture_id: string | null;
  source: string;
  source_ref: string | null;
  url: string;
  property: string | null;
  tag: string | null;
  title: string;
  action_at: string;
  offsets: string;
  outcome_id: string | null;
  created_at: string;
  closed_at: string | null;
};

export type ReadingRow = {
  id: number;
  baseline_id: string;
  ts: string;
  kind: string;
  day_offset: number | null;
  measured: number;
  source: string | null;
  window_start: string | null;
  window_end: string | null;
  window_days: number | null;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  site_clicks: number | null;
  site_impressions: number | null;
  queries: string | null;
  error: string | null;
};

export type DiagnosisRow = {
  id: number;
  baseline_id: string;
  day_offset: number;
  ts: string;
  verdict: string;
  diagnosis: string;
  rule: number | null;
  decided_by: string;
  model: string | null;
  next_action: string;
  delta: string;
  model_note: string | null;
  error: string | null;
};

let seq = 0;
export function mintBaselineId(): string {
  seq = (seq + 1) % 1_000;
  return `sb-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export const baselineRow = (id: string): BaselineRow | undefined =>
  db.prepare("SELECT * FROM seo_baselines WHERE id = ?").get(id) as BaselineRow | undefined;

export function baselineRows(ventureId?: string | null): BaselineRow[] {
  return (
    ventureId
      ? db
          .prepare("SELECT * FROM seo_baselines WHERE venture_id = ? ORDER BY action_at DESC, rowid DESC")
          .all(ventureId)
      : db.prepare("SELECT * FROM seo_baselines ORDER BY action_at DESC, rowid DESC").all()
  ) as unknown as BaselineRow[];
}

export const readingRows = (baselineId: string): ReadingRow[] =>
  db
    .prepare("SELECT * FROM seo_baseline_readings WHERE baseline_id = ? ORDER BY ts ASC, id ASC")
    .all(baselineId) as unknown as ReadingRow[];

export const diagnosisRows = (baselineId: string): DiagnosisRow[] =>
  db
    .prepare("SELECT * FROM seo_diagnoses WHERE baseline_id = ? ORDER BY day_offset ASC")
    .all(baselineId) as unknown as DiagnosisRow[];

/** A reading, stored. Every field that could not be read is written as NULL
 *  beside `measured = 0` and the sentence — never as a zero. */
export function writeReading(
  baselineId: string,
  kind: "baseline" | "followup",
  dayOffset: number | null,
  r: PageReading,
): ReadingRow {
  const info = db
    .prepare(
      `INSERT INTO seo_baseline_readings
         (baseline_id, ts, kind, day_offset, measured, source, window_start, window_end,
          window_days, clicks, impressions, ctr, position, site_clicks, site_impressions,
          queries, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      baselineId,
      now(),
      kind,
      dayOffset,
      r.measured ? 1 : 0,
      r.source,
      r.window.start,
      r.window.end,
      r.window.days,
      r.clicks,
      r.impressions,
      r.ctr,
      r.position,
      r.siteClicks,
      r.siteImpressions,
      JSON.stringify(r.queries.slice(0, 25)),
      r.error,
    );
  return db
    .prepare("SELECT * FROM seo_baseline_readings WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as ReadingRow;
}

/** A stored row back in the shape `readUrl` returns, so a reused reading and a
 *  fresh one are the same thing to everything downstream. */
function readingOf(r: ReadingRow): PageReading {
  return {
    measured: r.measured === 1,
    source: (r.source as PageReading["source"]) ?? "none",
    property: null,
    window: { start: r.window_start ?? "", end: r.window_end ?? "", days: r.window_days ?? WINDOW_DAYS },
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
    siteClicks: r.site_clicks,
    siteImpressions: r.site_impressions,
    queries: [],
    error: r.error,
  };
}

const sideOf = (r: ReadingRow | undefined): Side => ({
  measured: r ? r.measured === 1 : false,
  clicks: r?.clicks ?? null,
  impressions: r?.impressions ?? null,
  ctr: r?.ctr ?? null,
  position: r?.position ?? null,
  siteImpressions: r?.site_impressions ?? null,
});

/* ------------------------------------------------------- finding the work */

/**
 * EVERY http(s) URL IN A PIECE OF TEXT, de-duplicated, in order.
 *
 * Trailing punctuation is trimmed because a URL at the end of a sentence
 * collects the full stop, and a URL with a full stop on it matches no page in
 * Search Console — which would present as "unmeasured" for ever with no
 * explanation anybody could find.
 */
export function urlsIn(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(/https?:\/\/[^\s<>"'`)\]]+/gi)) {
    const raw = m[0]!.replace(/[.,;:!?)\]}'"]+$/, "");
    try {
      const u = new URL(raw);
      const href = u.href;
      if (!out.includes(href)) out.push(href);
    } catch {
      /* Not a URL after all. */
    }
  }
  return out;
}

/** Does this card carry the tag? Case-insensitive, matched as a whole token so
 *  `#seo` does not fire on `#seowriting`. */
export function tagged(text: string, tag: string): boolean {
  const t = tag.trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w#-])${escaped}(?![\\w-])`, "i").test(text);
}

export type DoneCard = {
  id: number;
  title: string;
  body: string | null;
  venture_id: string | null;
  done_at: string;
};

/** Finished cards, newest first. Archived ones are included on purpose: work
 *  that was done and then tidied away is still work that was done. */
export function doneCards(limit = 500): DoneCard[] {
  try {
    return db
      .prepare(
        `SELECT c.id, c.title, c.body, c.venture_id, c.done_at
           FROM board_cards c JOIN board_columns k ON k.id = c.column_id
          WHERE k.key = 'done' AND c.done_at IS NOT NULL
          ORDER BY c.done_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as DoneCard[];
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------- the sweep */

export type SweepResult = {
  scanned: number;
  candidates: number;
  created: { id: string; url: string; card: number; measured: boolean; error: string | null }[];
  skipped: { card: number; why: string }[];
};

/**
 * FIND FINISHED SEO CARDS AND GIVE EACH URL ON THEM A BASELINE.
 *
 * Idempotent by the unique index on (source, source_ref, url): running it
 * twice, or in two processes, leaves one baseline per card per URL. A card
 * with three URLs gets three, because three pages were changed and each one
 * moves on its own.
 */
export async function sweep(): Promise<SweepResult> {
  const s = settings();
  const cards = doneCards();
  const out: SweepResult = { scanned: cards.length, candidates: 0, created: [], skipped: [] };

  for (const card of cards) {
    const text = `${card.title}\n${card.body ?? ""}`;
    if (!tagged(text, s.tag)) continue;
    const urls = urlsIn(text);
    if (!urls.length) {
      out.skipped.push({
        card: card.id,
        why: `tagged ${s.tag} and carries no http(s) URL, so there is no page to measure`,
      });
      continue;
    }
    out.candidates += urls.length;
    for (const url of urls) {
      const held = db
        .prepare("SELECT id FROM seo_baselines WHERE source = 'card' AND source_ref = ? AND url = ?")
        .get(String(card.id), url) as { id: string } | undefined;
      if (held) continue;
      const made = await createBaseline({
        url,
        ventureId: card.venture_id,
        source: "card",
        sourceRef: String(card.id),
        title: card.title,
        actionAt: card.done_at,
        tag: s.tag,
      });
      /* A baseline another sweep wrote between the check above and the insert
         is not one this sweep created, and reporting it as one would make the
         idempotency claim false in the other direction. */
      if (made.created)
        out.created.push({ id: made.id, url, card: card.id, measured: made.reading.measured, error: made.reading.error });
    }
  }
  return out;
}

/**
 * ONE BASELINE, WITH ITS READING TAKEN SYNCHRONOUSLY.
 *
 * outcomes-routes.ts's rule and its reason: a link made without a before is a
 * link with no before, and "we will read it on the next tick" makes two
 * baselines created four minutes apart describe windows an hour apart for no
 * reason anybody can see. A reading that FAILED is still stored, with its
 * sentence, and the baseline is still created — refusing to track a page
 * because a credential was missing for a minute would lose the work.
 */
export async function createBaseline(input: {
  url: string;
  ventureId: string | null;
  source: "card" | "manual";
  sourceRef: string | null;
  title: string;
  actionAt: string;
  tag: string | null;
}): Promise<{ id: string; reading: PageReading; created: boolean }> {
  const s = settings();
  const reading = await readUrl(input.url, WINDOW_DAYS);
  const id = mintBaselineId();
  /*
    ON CONFLICT DO NOTHING, BECAUSE THE UNIQUE INDEX IS A RACE AND NOT A LOCK.

    Two sweeps can interleave at the `await readUrl` above — the six-hourly pass
    and the Sweep button are exactly that pair — and a plain INSERT made the
    second one throw `UNIQUE constraint failed` out of POST /sweep and out of
    the nightly stage. The index was always meant to make a re-run a NO-OP,
    which is what the README and the route's own note claim; this is that claim
    made true. The loser re-selects the row the winner wrote and returns it,
    so both callers get a baseline id and neither gets an error.
  */
  const inserted = db
    .prepare(
      `INSERT INTO seo_baselines
         (id, venture_id, source, source_ref, url, property, tag, title, action_at,
          offsets, outcome_id, created_at, closed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,NULL)
       ON CONFLICT(source, source_ref, url) DO NOTHING`,
    )
    .run(
      id,
      input.ventureId,
      input.source,
      input.sourceRef,
      input.url,
      reading.property,
      input.tag,
      input.title.slice(0, 200),
      input.actionAt,
      JSON.stringify(s.offsets),
      now(),
    );

  if (Number(inserted.changes) === 0) {
    /* Somebody else got there first. Their baseline is the baseline; this
       reading is thrown away rather than filed as a second "before". */
    const held = db
      .prepare("SELECT id FROM seo_baselines WHERE source IS ? AND source_ref IS ? AND url = ?")
      .get(input.source, input.sourceRef, input.url) as { id: string } | undefined;
    return { id: held?.id ?? id, reading, created: false };
  }

  writeReading(id, "baseline", null, reading);
  /* The outcome link is best-effort and never blocks the baseline: chief's
     table is another area's and its absence must not lose a measurement. */
  await linkOutcome(id).catch(() => undefined);
  return { id, reading, created: true };
}

/* ------------------------------------------------------------ the schedule */

export function offsetsOf(row: BaselineRow): number[] {
  try {
    const parsed: unknown = JSON.parse(row.offsets);
    if (Array.isArray(parsed)) {
      const ns = parsed.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);
      if (ns.length) return ns;
    }
  } catch {
    /* A row whose offsets column will not parse falls back to the setting. */
  }
  return settings().offsets;
}

export type Due = { baseline: BaselineRow; dayOffset: number };

/**
 * WHICH FOLLOW-UPS ARE DUE.
 *
 * Due when the action is at least N days old and no follow-up with that offset
 * exists. Late ones are still taken and still recorded at their own offset —
 * the box that was off for a week takes the day-14 reading on day sixteen and
 * says so, rather than skipping it and leaving a hole nobody can explain.
 */
export function dueFollowUps(at = Date.now()): Due[] {
  const out: Due[] = [];
  for (const b of db
    .prepare("SELECT * FROM seo_baselines WHERE closed_at IS NULL")
    .all() as unknown as BaselineRow[]) {
    const age = (at - Date.parse(b.action_at)) / 86_400_000;
    if (!Number.isFinite(age)) continue;
    const taken = new Set(
      (
        db
          .prepare(
            "SELECT day_offset FROM seo_baseline_readings WHERE baseline_id = ? AND day_offset IS NOT NULL",
          )
          .all(b.id) as unknown as { day_offset: number }[]
      ).map((r) => r.day_offset),
    );
    /* A SLOT WITH A READING AND NO DIAGNOSIS IS NOT FINISHED — due-ness below
       checks both sets, not the reading alone, so a restart between the two
       (which this box's dev server does on every save) cannot leave an offset
       stuck forever. `runFollowUp` reuses a reading it already has, so coming
       back here costs no second Search Console call. */
    const diagnosed = new Set(
      (
        db
          .prepare("SELECT day_offset FROM seo_diagnoses WHERE baseline_id = ?")
          .all(b.id) as unknown as { day_offset: number }[]
      ).map((r) => r.day_offset),
    );
    for (const d of offsetsOf(b)) {
      if (age < d) continue;
      if (taken.has(d) && diagnosed.has(d)) continue;
      /*
        AN OFFSET THAT ELAPSED BEFORE TRACKING BEGAN IS NOT A FOLLOW-UP.

        `doneCards()` has no date bound on purpose — a card finished six months
        ago and tagged SEO is still work worth a baseline — but its baseline is
        read TODAY, and every offset is then instantly `age >= d`. The first
        nightly would take 14, 28 and 56 out of one identical trailing-28-day
        window: three readings of the same figures, three model calls, and three
        diagnoses filed as a time series that never happened.

        The window a follow-up describes has to START after the baseline was
        captured, so an offset whose due instant is already in the past when the
        baseline is created has no measurement to make and is skipped for good.
        Nothing is lost — there was never anything there to read.
      */
      const dueAt = Date.parse(b.action_at) + d * 86_400_000;
      const trackedFrom = Date.parse(b.created_at);
      if (Number.isFinite(trackedFrom) && dueAt < trackedFrom && !taken.has(d)) continue;
      out.push({ baseline: b, dayOffset: d });
    }
  }
  return out;
}

/**
 * WHICH OFFSETS THIS BASELINE CAN STILL ANSWER, and which elapsed before it
 * was tracked. Exported so the document can say so rather than silently
 * showing three of five slots.
 */
export function reachableOffsets(b: BaselineRow): { reachable: number[]; missed: number[] } {
  const trackedFrom = Date.parse(b.created_at);
  const reachable: number[] = [];
  const missed: number[] = [];
  for (const d of offsetsOf(b)) {
    const dueAt = Date.parse(b.action_at) + d * 86_400_000;
    if (Number.isFinite(trackedFrom) && dueAt < trackedFrom) missed.push(d);
    else reachable.push(d);
  }
  return { reachable, missed };
}

/* ------------------------------------------------------------- the verdict */

export type FollowUpResult = {
  baselineId: string;
  dayOffset: number;
  reading: PageReading;
  judgement: Judgement;
  decidedBy: "rules" | "model";
  model: string | null;
  modelNote: string | null;
  modelError: string | null;
};

/**
 * TAKE ONE FOLLOW-UP READING AND DECIDE WHAT IT MEANS.
 *
 * THE TABLE ALWAYS RUNS AND THE MODEL NEVER OVERRULES A `unmeasured` OR A
 * `thin`. Those two verdicts are statements about whether there is anything to
 * judge at all, and a model handed "not measured" and asked for an opinion
 * will produce one. So the model is asked only when the arithmetic worked, it
 * may change the DIAGNOSIS (which of nine reasons), and it may never change
 * the VERDICT (up, down, flat) — that is subtraction, and subtraction does not
 * need an opinion.
 */
export async function runFollowUp(b: BaselineRow, dayOffset: number, useModel = true): Promise<FollowUpResult> {
  /*
    A READING ALREADY IN THIS SLOT IS REUSED RATHER THAN RETAKEN.

    The only way to get here with one is the interrupted case — a restart
    between the reading and the diagnosis — and taking a second one would spend
    a Search Console call to replace a measurement of a window that has since
    moved. The stored reading is the reading of that slot; what is missing is
    the verdict, so only the verdict is fetched.
  */
  const existing = readingRows(b.id).find((r) => r.kind === "followup" && r.day_offset === dayOffset);
  const reading = existing ? readingOf(existing) : await readUrl(b.url, WINDOW_DAYS);
  const stored = existing ?? writeReading(b.id, "followup", dayOffset, reading);
  const baseline = readingRows(b.id).find((r) => r.kind === "baseline");

  const before = sideOf(baseline);
  const after = sideOf(stored);
  const judgement = diagnose(before, after);

  let decidedBy: "rules" | "model" = "rules";
  let model: string | null = null;
  let modelNote: string | null = null;
  let modelError: string | null = null;
  let diagnosisWord: Diagnosis = judgement.diagnosis;

  if (useModel && judgement.verdict !== "unmeasured" && judgement.verdict !== "thin") {
    try {
      const reply = await complete([
        { role: "system", content: MODEL_SYSTEM },
        {
          role: "user",
          content: `${promptFacts(b.url, WINDOW_DAYS, before, after, judgement.delta)}\n\nChoose one diagnosis.`,
        },
      ], { venture: b.venture_id ?? PORTFOLIO_VENTURE });
      model = reply.model;
      const checked = validateModelDiagnosis(reply.text);
      if ("unreadable" in checked) {
        modelError = `The model's answer was thrown away whole: ${checked.unreadable}. The rule table's diagnosis stands.`;
      } else {
        decidedBy = "model";
        diagnosisWord = checked.diagnosis;
        modelNote = checked.why;
      }
    } catch (err) {
      modelError = `No model diagnosis: ${err instanceof Error ? err.message.slice(0, 200) : "the provider did not answer"}. The rule table's diagnosis stands.`;
    }
  } else if (useModel) {
    modelError = `No model was asked: the arithmetic answered "${judgement.verdict}", which is a statement about whether there is anything to judge rather than a diagnosis to choose.`;
  }

  const final: Judgement = {
    ...judgement,
    diagnosis: diagnosisWord,
    next: NEXT_ACTION[diagnosisWord],
  };

  db.prepare(
    `INSERT INTO seo_diagnoses
       (baseline_id, day_offset, ts, verdict, diagnosis, rule, decided_by, model,
        next_action, delta, model_note, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(baseline_id, day_offset) DO NOTHING`,
    /* DO NOTHING and not DO UPDATE: a slot is diagnosed once. The interrupted
       case reaches here with no row at all, so the insert lands; a genuine
       second run finds the first verdict and leaves it, which is what makes
       two people pressing the button produce one opinion. */
  ).run(
    b.id,
    dayOffset,
    now(),
    final.verdict,
    final.diagnosis,
    final.rule,
    decidedBy,
    model,
    final.next,
    JSON.stringify(final.delta),
    modelNote,
    modelError,
  );

  return { baselineId: b.id, dayOffset, reading, judgement: final, decidedBy, model, modelNote, modelError };
}

/** Every due follow-up, run. Returns what it did, for the stage's note. */
export async function runDue(useModel = true): Promise<FollowUpResult[]> {
  const out: FollowUpResult[] = [];
  for (const { baseline, dayOffset } of dueFollowUps()) out.push(await runFollowUp(baseline, dayOffset, useModel));
  return out;
}

/* ------------------------------------------------------- the outcomes link */

/**
 * FILE THE BASELINE AS A CHIEF OUTCOME, so it appears on the page the owner
 * already reads to answer "did that work".
 *
 * THE METRIC IS THIS AREA'S OWN SKILL, addressed the way every other outcome
 * is: `seo-followup?view=metric&baseline=<id>&field=clicks` → `value`. Nothing
 * about chief/outcomes.ts had to learn what a URL is; it reads a number out of
 * a document, and this area publishes one. That is the whole point of the
 * address-not-a-function design over there, and this is the first caller to
 * use it from outside.
 *
 * GUARDED, and a failure is silent on purpose: chief's table belongs to
 * another area, and a box where it does not exist should still keep the
 * measurement.
 */
async function linkOutcome(baselineId: string): Promise<void> {
  const b = baselineRow(baselineId);
  if (!b) return;
  try {
    const chief = await import("../chief/outcomes.ts");
    const id = chief.createOutcome({
      title: `SEO: ${b.title}`.slice(0, 200),
      ventureId: b.venture_id,
      actionKind: b.source === "card" ? "card" : "note",
      actionRef: b.source_ref ?? "",
      actionText: `SEO work on ${b.url}`,
      actionAt: b.action_at,
      skill: "seo-followup",
      view: "metric",
      params: { baseline: b.id, field: "clicks" },
      path: "value",
      unit: "clicks / 28 days",
    });
    if (!id) return;
    db.prepare("UPDATE seo_baselines SET outcome_id = ? WHERE id = ?").run(id, b.id);
    /*
      AND THE OUTCOME'S OWN BASELINE, TAKEN THE WAY OUTCOMES TAKES ONE.

      `createOutcome` deliberately does not read a metric — most callers have
      their before-figures already. This one publishes its figure at an address,
      so the honest thing is to let chief read it through that address, exactly
      as its own POST route does: one loopback GET of a document this box
      serves. Without it the outcome would sit at `unreadable` — "nobody could
      read this metric" — which is a false claim about a metric that answers.

      Guarded on the reading ALREADY EXISTING so a second link, or a sweep run
      twice, cannot give one outcome two baselines.
    */
    const row = chief.outcomeRow(id);
    if (row && !chief.readingRows(id).some((r) => r.kind === "baseline"))
      chief.writeReading(id, "baseline", null, await chief.takeReading(row));
  } catch {
    /* chief is not present, or refused. The baseline stands on its own. */
  }
}

/* ------------------------------------------------------------- the document */

export function shapeBaseline(b: BaselineRow) {
  const readings = readingRows(b.id);
  const baseline = readings.find((r) => r.kind === "baseline") ?? null;
  const followups = readings.filter((r) => r.kind === "followup");
  const diagnoses = diagnosisRows(b.id);
  const v = b.venture_id ? ventureRowById(b.venture_id) : undefined;
  const ageDays = Math.floor((Date.now() - Date.parse(b.action_at)) / 86_400_000);
  const { reachable, missed } = reachableOffsets(b);

  const shapeReading = (r: ReadingRow) => ({
    at: r.ts,
    kind: r.kind,
    dayOffset: r.day_offset,
    measured: r.measured === 1,
    source: r.source,
    window: { start: r.window_start, end: r.window_end, days: r.window_days },
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
    siteClicks: r.site_clicks,
    siteImpressions: r.site_impressions,
    queries: readQueries(r.queries),
    error: r.error,
  });

  return {
    id: b.id,
    url: b.url,
    title: b.title,
    ventureId: b.venture_id,
    ventureName: v?.name ?? null,
    property: b.property,
    tag: b.tag,
    source: { kind: b.source, ref: b.source_ref },
    actionAt: b.action_at,
    daysSinceAction: Math.max(0, ageDays),
    outcomeId: b.outcome_id,
    createdAt: b.created_at,
    closedAt: b.closed_at,
    baseline: baseline ? shapeReading(baseline) : null,
    followUps: followups.map(shapeReading),
    diagnoses: diagnoses.map((d) => ({
      dayOffset: d.day_offset,
      at: d.ts,
      verdict: d.verdict,
      diagnosis: d.diagnosis,
      rule: d.rule,
      decidedBy: d.decided_by,
      model: d.model,
      next: d.next_action,
      delta: readJson(d.delta),
      modelNote: d.model_note,
      note: d.error,
    })),
    due: reachable
      .filter((d) => !followups.some((r) => r.day_offset === d))
      .map((d) => ({
        dayOffset: d,
        dueAt: new Date(Date.parse(b.action_at) + d * 86_400_000).toISOString(),
        overdue: ageDays >= d,
      })),
    /* OFFSETS THAT ELAPSED BEFORE THIS URL WAS TRACKED. Named rather than
       silently absent: a card finished six months ago and swept today can
       never have a 14-day reading, and a page showing three of five slots with
       no explanation reads as a feature that stopped working. */
    missedOffsets: missed,
    window:
      baseline && followups.length
        ? `Baseline read ${baseline.ts.slice(0, 10)} over the ${baseline.window_days} days ending ${baseline.window_end}; ` +
          `latest follow-up ${followups.at(-1)!.ts.slice(0, 10)}, day ${followups.at(-1)!.day_offset} after the action on ${b.action_at.slice(0, 10)}.`
        : `Baseline read ${baseline?.ts.slice(0, 10) ?? "not yet"}; no follow-up has been taken.`,
    caveat:
      "Correlation, not causation. The baseline window ends three days back and " +
      "was captured AFTER the work was marked done, so it already contains the " +
      "change; Google needs days to re-crawl and weeks to re-rank, which is why " +
      "that is a compromise rather than a mistake.",
  };
}

function readQueries(raw: string | null): { query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as never[]) : [];
  } catch {
    return [];
  }
}

function readJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
