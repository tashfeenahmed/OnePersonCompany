/**
 * THE RULE ENGINE — and the one property worth defending about it.
 *
 * IT HAS NO PRIVATE KNOWLEDGE OF ANY TABLE. Every figure it compares arrives
 * over loopback HTTP from `GET /api/skills/<id>`, which is byte for byte the
 * request the `opc` command makes and the request an agent makes. Nothing here
 * imports a collector, opens a provider's table or knows what Stripe is.
 *
 * That is not purity for its own sake — it is the only way this can be
 * generic. A rule written against a plugin that did not exist when this file
 * was written works, because the rule names a skill, a view and a path, and
 * the skills surface is the contract the whole box already publishes. It also
 * means a rule reads exactly the document the owner would read: if the page
 * says failed payments are 27 and the rule says 27, they cannot have got there
 * by different routes.
 *
 * THE COST IS AN HTTP REQUEST PER RULE PER CYCLE, to ourselves. That is a few
 * milliseconds and one more process's worth of JSON parsing, half an hour
 * apart, and it buys the property above. Rules that read the same skill and
 * view with the same parameters share one read per cycle — that is a cache
 * within a single pass and nothing longer-lived, because a cache across cycles
 * would be the engine reporting a figure the routes have moved past.
 *
 * A RULE THAT CANNOT BE READ IS AN EVENT OF ITS OWN KIND AND NEVER A TRIP.
 * This is the rule the whole area turns on. A Stripe outage must not read as
 * "revenue fell to zero"; a renamed field must not read as "the count dropped
 * to nothing". Both are `unreadable`, with the route's own sentence attached,
 * and the events list draws them differently from a trip.
 */
import { takeSnapshots } from "./catalogue.ts";
import { takeReading, urlFor } from "../../shared/metrics-address.ts";
import {
  insertEvent,
  lastEventAt,
  markRule,
  observationAtOrBefore,
  pruneObservations,
  pruneSnapshots,
  recordObservation,
  rules,
  type EventRow,
  type Operator,
  type RuleRow,
} from "./store.ts";
import { narrate } from "./narrate.ts";
import { captureEventContext } from "./event-context.ts";

/** How long observations and snapshots are kept. Snapshots are the big rows
 *  and only the previous cycle's is ever read; observations are tiny and the
 *  longest window a rule can name is a fortnight. */
const SNAPSHOT_DAYS = 7;
const OBSERVATION_DAYS = 30;

/* ------------------------------------------------------------- reading */

/**
 * A RULE IS AN ADDRESS, and the address lives in `shared/metrics-address.ts`.
 *
 * `skill` + `view` + `params` + `path` is how everything on this box names a
 * figure. The parameter reader, the URL builder, the loopback fetch and the
 * dotted-path resolver are all that module's, alert rules and outcomes both —
 * so `@count(...)` and the `?view=default` sentinel mean one thing here and
 * one thing there. Its header has the rules and why each is what it is.
 */

export { paramsOf as readParams } from "../../shared/metrics-address.ts";

/** The URL a rule reads. Public so the routes can show it: an owner who can
 *  see the request can check the answer themselves with curl. */
export const ruleUrl = (r: Pick<RuleRow, "skill" | "view" | "params">): string =>
  /* The URL is the first three columns of the address; the path picks a field
     out of the answer and has nothing to do with the request. */
  urlFor({ ...r, path: "" });

export type Read =
  | { ok: true; value: number; doc: unknown; url: string }
  | { ok: false; why: string; url: string; doc?: unknown };

/**
 * One rule's figure, read the way anybody else would read it.
 *
 * `docs` is a per-pass cache keyed by URL. Two rules watching two paths in the
 * same Stripe document are one request; the cache lives for one evaluation and
 * is thrown away, because a figure held between cycles is a figure that has
 * stopped being the present.
 */
export async function readRule(
  r: Pick<RuleRow, "skill" | "view" | "params" | "path">,
  docs?: Map<string, unknown>,
  signal?: AbortSignal,
): Promise<Read> {
  const reading = await takeReading(r, { docs, signal });
  return reading.error === null
    ? { ok: true, value: reading.value as number, doc: reading.doc, url: reading.url }
    : { ok: false, why: reading.error, url: reading.url, doc: reading.doc };
}

/* ---------------------------------------------------------- the comparison */

export type Verdict = {
  tripped: boolean;
  /** The figure the operator compared against — the threshold, the previous
   *  reading, or the reading from the start of the window. Null when there is
   *  none yet, which is the answer for a windowed rule on its first days. */
  against: number | null;
  /** One sentence: the figure, the comparison, and the answer. */
  message: string;
  /** Set when the comparison could not be made at all — not a trip and not a
   *  pass. A windowed rule with no history yet lands here. */
  undecidable: string | null;
};

const round = (n: number) => (Number.isInteger(n) ? n : Math.round(n * 100) / 100);

/**
 * THE COMPARISON THE OWNER CONFIGURED, AND NOTHING ELSE.
 *
 * There is no severity here, no anomaly detection and no learned baseline, and
 * that absence is the product rather than a missing feature. A trip means "the
 * number you named crossed the line you drew", which is a fact the owner can
 * check. Anything cleverer would be this box forming an opinion about a
 * business it has never been told the shape of, and presenting that opinion in
 * the same list as the facts.
 */
export function judge(
  r: Pick<RuleRow, "op" | "threshold" | "window_minutes" | "path" | "name">,
  value: number,
  history: { previous: number | null; windowStart: { ts: string; value: number } | null },
): Verdict {
  const op = r.op as Operator;
  const t = r.threshold;
  const say = (tripped: boolean, against: number | null, tail: string): Verdict => ({
    tripped,
    against,
    message: `${r.path} is ${round(value)} — ${tail}`,
    undecidable: null,
  });

  if (op === "changed") {
    if (history.previous === null)
      return {
        tripped: false,
        against: null,
        message: `${r.path} is ${round(value)} — first reading, so there is nothing to compare it with yet.`,
        undecidable: "no previous reading",
      };
    const moved = history.previous !== value;
    return say(moved, history.previous, moved
      ? `it was ${round(history.previous)} at the previous reading.`
      : `unchanged since the previous reading.`);
  }

  if (op === "dropped_by_pct" || op === "rose_by_pct") {
    if (t === null)
      return { tripped: false, against: null, message: `${r.path} is ${round(value)}.`, undecidable: "no percentage set" };
    const start = history.windowStart;
    if (!start)
      return {
        tripped: false,
        against: null,
        message: `${r.path} is ${round(value)} — nothing was recorded ${r.window_minutes ?? 0} minutes ago, so there is no earlier figure to compare with.`,
        undecidable: "no reading old enough",
      };
    if (start.value === 0)
      return {
        tripped: false,
        against: 0,
        message: `${r.path} is ${round(value)} — it was 0 at the start of the window, and a percentage change from nothing is not a figure this box will compute.`,
        undecidable: "the earlier figure was zero",
      };
    const changePct = ((value - start.value) / Math.abs(start.value)) * 100;
    const tripped = op === "dropped_by_pct" ? -changePct >= t : changePct >= t;
    const dir = changePct < 0 ? "down" : "up";
    return say(
      tripped,
      start.value,
      `${dir} ${Math.abs(Math.round(changePct * 10) / 10)}% from ${round(start.value)} recorded at ${start.ts}` +
        ` (the rule watches for a ${op === "dropped_by_pct" ? "drop" : "rise"} of ${t}% or more).`,
    );
  }

  if (t === null)
    return { tripped: false, against: null, message: `${r.path} is ${round(value)}.`, undecidable: "no threshold set" };

  const tripped =
    op === "<" ? value < t
    : op === "<=" ? value <= t
    : op === ">" ? value > t
    : op === ">=" ? value >= t
    : op === "==" ? value === t
    : value !== t;
  return say(tripped, t, `the rule trips when it is ${op} ${round(t)}, and it ${tripped ? "is" : "is not"}.`);
}

/* -------------------------------------------------------------- the pass */

export type PassResult = {
  at: string;
  evaluated: number;
  tripped: number;
  unreadable: number;
  skipped: number;
  snapshots: number;
  events: number[];
};

/** Whether a rule may raise another event of this kind yet. */
function inCooldown(r: RuleRow, kind: EventRow["kind"], atMs: number): boolean {
  const last = lastEventAt(r.id, kind);
  if (!last) return false;
  return atMs - Date.parse(last) < r.cooldown_minutes * 60_000;
}

/**
 * ONE EVALUATION OF EVERY ENABLED RULE, plus the snapshots the narrator needs.
 *
 * THE SNAPSHOTS ARE TAKEN FIRST, and before any rule is judged, so that a trip
 * raised in this pass has a "what else was true" to diff against a pass that
 * already happened. Taking them afterwards would leave the first trip of a
 * fresh install with nothing to compare and would make the narration depend on
 * the order the rules happen to be in.
 *
 * NOTHING IN HERE THROWS. It runs on a timer; a pass that took the process
 * down would be an alerting system that switches off the box it is watching.
 */
export async function evaluateAll(signal?: AbortSignal): Promise<PassResult> {
  const at = new Date().toISOString();
  const atMs = Date.parse(at);
  const docs = new Map<string, unknown>();
  const out: PassResult = {
    at,
    evaluated: 0,
    tripped: 0,
    unreadable: 0,
    skipped: 0,
    snapshots: 0,
    events: [],
  };

  const all = rules({ enabledOnly: true });
  out.snapshots = await takeSnapshots(all.map((r) => r.skill), at, signal).catch(() => 0);

  for (const r of all) {
    let got: Read;
    try {
      got = await readRule(r, docs, signal);
    } catch (err) {
      got = { ok: false, url: ruleUrl(r), why: err instanceof Error ? err.message : String(err) };
    }
    out.evaluated += 1;

    if (!got.ok) {
      markRule(r.id, null, got.why);
      out.unreadable += 1;
      /* Cooled down like a trip, and for the same reason: a rule against a
         disconnected plugin would otherwise write forty-eight rows a day
         saying the same thing. */
      if (inCooldown(r, "unreadable", atMs)) {
        out.skipped += 1;
        continue;
      }
      const ev = insertEvent({
        ruleId: r.id,
        kind: "unreadable",
        observed: null,
        previous: r.last_value,
        message: got.why,
        context: captureEventContext(r, got.doc, true),
      });
      out.events.push(ev.id);
      continue;
    }

    markRule(r.id, got.value, null);
    /* READ BEFORE THE INSERT. The newest row in the observations table is the
       PREVIOUS reading only until this pass writes its own; asking afterwards
       would compare a figure with itself and make `changed` never fire. */
    const previous = observationAtOrBefore(r.id, at)?.value ?? null;
    recordObservation(r.id, got.value, at);

    const windowStart =
      r.window_minutes && r.window_minutes > 0
        ? observationAtOrBefore(r.id, new Date(atMs - r.window_minutes * 60_000).toISOString())
        : null;

    const verdict = judge(r, got.value, { previous, windowStart });
    if (!verdict.tripped) continue;
    out.tripped += 1;
    if (inCooldown(r, "trip", atMs)) {
      out.skipped += 1;
      continue;
    }

    const ev = insertEvent({
      ruleId: r.id,
      kind: "trip",
      observed: got.value,
      previous: verdict.against,
      message: `${r.name}: ${verdict.message}`,
      context: captureEventContext(r, got.doc, false),
    });
    out.events.push(ev.id);
    /* The narration is best-effort and comes AFTER the event exists, so a
       model that is slow, down or absent costs a paragraph and never the
       alert. `narrate` throws nothing. */
    await narrate(ev.id, r, got.value, verdict.against, signal);
  }

  pruneObservations(OBSERVATION_DAYS);
  pruneSnapshots(SNAPSHOT_DAYS);
  return out;
}
