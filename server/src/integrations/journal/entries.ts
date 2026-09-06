/**
 * THE JOURNAL'S STORE — validation, the streak arithmetic, and the shapes.
 *
 * WHY THE VALIDATION IS HERE AND NOT IN THE ROUTE. Four doors write to this
 * table: the Journal page, the skills proxy's `add_entry`, a Telegram `/did`,
 * and the venture tab. A rule enforced in the route would be a rule three of
 * those four could walk around — and the one that matters most, "the agent
 * files what the OWNER said", is exactly the rule an agent would walk around
 * if the gate were somewhere it did not have to pass through.
 *
 * WHAT IS REFUSED VERSUS WHAT IS TRIMMED. A kind this table does not have and
 * a date that is not a date are REFUSED: both would put a row on a timeline
 * that means something other than what it says. A long sentence is TRIMMED,
 * because losing the last few words of a note is a much smaller failure than
 * losing the record that the work happened at all. A URL is refused rather
 * than repaired, for the reason the previous system's own log refuses one: a
 * link is the whole evidence of a post, and one quietly rewritten into something that
 * resolves against this dashboard's origin is worse than no link.
 *
 * THE STREAK IS ARITHMETIC OVER DAYS AND IS NOT A JUDGEMENT. It counts days on
 * which the OWNER filed at least one entry — nothing about effort, nothing
 * about output, and it is worth exactly as much as the honesty of the person
 * typing. It is computed on read, from the days themselves, so a back-dated
 * entry mends a gap the moment it is written and no stored counter can drift
 * away from the rows.
 *
 * AND IT COUNTS ONLY WHAT HE FILED. Rows stamped `source: "agent"` are left
 * out — a stamp on a row is no use to a number computed over all the rows, and
 * a run the agent back-filled is a run he did not do. See `entryDays`.
 */
import { db, now, ventureRowById, ventureRows, type VentureRow } from "../../db.ts";

/**
 * THE KINDS, AND WHY THERE ARE SIX.
 *
 * Five verbs a founder actually uses about a day plus a bucket, ported from
 * the previous system's did/shipped/post set and widened by the three its own
 * log kept pushing into `did`: a meeting, a decision, and everything else. They are
 * deliberately COARSE — a taxonomy with twenty entries is a taxonomy nobody
 * fills in the same way twice, and the text carries the detail anyway.
 */
export const KINDS = ["did", "shipped", "posted", "met", "decided", "other"] as const;
export type Kind = (typeof KINDS)[number];

/** The two kinds where a link is evidence of a thing the world can now see,
 *  and therefore the two where tracking an outcome is offered. */
export const TRACKABLE: readonly Kind[] = ["shipped", "posted"];

export const SOURCES = ["ui", "telegram", "agent"] as const;
export type Source = (typeof SOURCES)[number];

/**
 * THE TWO SOURCES THAT ARE THE OWNER'S OWN HAND: the page in front of him and
 * the phone in his pocket. `agent` is not one of them and never will be, which
 * is why this list exists rather than a `source !== "agent"` written in three
 * places that can come apart.
 */
export const OWNER_SOURCES: readonly Source[] = ["ui", "telegram"];

/**
 * HOW FAR BACK THE AGENT MAY DATE AN ENTRY IT FILES.
 *
 * A person back-dates by days: "that was Tuesday". An agent asked to write up a
 * conversation has no such anchor and will happily take a year from a sentence
 * that mentioned one, and a route with no bound would let a single tidy-up pass
 * rewrite the operating history. Seven days covers every real case — the owner
 * telling it about last week — and anything older is a job for the page, where
 * he can see what he is writing.
 */
export const AGENT_BACKDATE_DAYS = 7;

export const MAX_TEXT = 2_000;
export const MAX_RESULT = 2_000;
export const MAX_URL = 500;
/** The furthest back an entry may be dated. Not a retention rule — rows older
 *  than this are kept forever — it is a typo guard: `2016-09-06` for
 *  `2026-09-06` would otherwise put a lone dot ten years down the timeline. */
export const EARLIEST = "2000-01-01";

export type EntryRow = {
  id: string;
  venture_id: string | null;
  kind: string;
  text: string;
  url: string | null;
  at: string;
  result: string | null;
  outcome_id: string | null;
  source: string;
  created_at: string;
};

/* ------------------------------------------------------------- validation */

const clean = (v: unknown, max: number) =>
  String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * A link, or a refusal. http(s) only: this string is rendered as an href on a
 * page and handed to the outcomes engine as the thing that was shipped.
 */
export function cleanUrl(v: unknown): string | null {
  const raw = String(v ?? "").trim().slice(0, MAX_URL);
  if (!/^https?:\/\/\S+$/i.test(raw)) return null;
  try {
    new URL(raw);
    return raw;
  } catch {
    return null;
  }
}

/** Today where the box is, as a date. The journal's whole axis is the local
 *  day the owner had — a UTC day boundary would file an evening's work in
 *  Ireland as tomorrow's for four months of the year. */
export function today(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A DATE, OR A SENTENCE SAYING WHY NOT.
 *
 * Accepts a bare `YYYY-MM-DD` and an ISO instant. Refuses the future beyond
 * today: an entry is a record of work that has happened, and a journal that
 * accepts tomorrow is a plan pretending to be a history.
 *
 * AN INSTANT IS RESOLVED IN THE BOX'S OWN TIMEZONE, NOT IN UTC, and getting
 * that wrong is a real bug rather than a nicety. The whole table's axis is the
 * LOCAL day the owner had — that is what `today()` returns and what every
 * comparison below is against — so taking `slice(0, 10)` off an ISO string
 * (which is a UTC date) mixes two calendars. West of Greenwich it refuses
 * ten o'clock on a Sunday night as "in the future"; east of it, it files work
 * done just after midnight under yesterday. So an instant is parsed and then
 * asked which LOCAL day it fell on, and a bare `YYYY-MM-DD` is taken as
 * written, because a date with no time in it is already a local day.
 */
export function parseDay(value: unknown, from = new Date()): { day: string } | { error: string } {
  const raw = String(value ?? "").trim();
  if (!raw) return { day: today(from) };
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(raw);
  if (!m) return { error: `“${raw}” is not a date. Use YYYY-MM-DD, or leave it out for today.` };
  const carriesTime = raw.length > 10;
  if (carriesTime) {
    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime()))
      return { error: `“${raw}” is not a real instant. Use YYYY-MM-DD, or leave it out for today.` };
    const local = today(instant);
    if (local > today(from))
      return { error: `${local} is in the future. The journal records work that has happened.` };
    if (local < EARLIEST) return { error: `${local} is before ${EARLIEST}; check the year.` };
    return { day: local };
  }
  const day = m[1]!;
  const probe = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(probe.getTime())) return { error: `“${raw}” is not a real date.` };
  if (probe.toISOString().slice(0, 10) !== day)
    return { error: `“${raw}” is not a real date — check the month and day.` };
  if (day > today(from))
    return { error: `${day} is in the future. The journal records work that has happened.` };
  if (day < EARLIEST) return { error: `${day} is before ${EARLIEST}; check the year.` };
  return { day };
}

/* ---------------------------------------------------------------- storage */

let seq = 0;
export function mintId(): string {
  seq = (seq + 1) % 1_000;
  return `j-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export type AddInput = {
  kind: unknown;
  text: unknown;
  venture?: unknown;
  url?: unknown;
  at?: unknown;
  result?: unknown;
  source: Source;
};

export type AddResult = { entry: EntryRow } | { error: string; status: 400 | 404 | 413 };

/**
 * FILE ONE ENTRY.
 *
 * The one gate every door goes through. It resolves the venture itself rather
 * than taking an id, because the two callers that are not the page — the agent
 * and Telegram — hold a NAME and nothing else, and a lookup done twice in two
 * places is two ideas of what "Northwind" means.
 */
export function addEntry(input: AddInput): AddResult {
  const kind = String(input.kind ?? "").trim().toLowerCase();
  if (!(KINDS as readonly string[]).includes(kind))
    return { error: `kind is one of ${KINDS.join(", ")} — not “${kind || "(nothing)"}”.`, status: 400 };

  const text = clean(input.text, MAX_TEXT);
  if (!text) return { error: "An entry needs a sentence: what you did, in your own words.", status: 400 };

  let ventureId: string | null = null;
  const key = String(input.venture ?? "").trim();
  if (key) {
    const v = resolveVentureLoose(key);
    if (!v) return { error: `No venture by the id, slug or name “${key}”.`, status: 404 };
    ventureId = v.id;
  }

  let url: string | null = null;
  if (input.url !== undefined && input.url !== null && String(input.url).trim()) {
    url = cleanUrl(input.url);
    if (!url) return { error: "url must be an http(s) link, or absent.", status: 400 };
  }

  const day = parseDay(input.at);
  if ("error" in day) return { error: day.error, status: 400 };

  const result = input.result === undefined || input.result === null ? null : clean(input.result, MAX_RESULT) || null;

  const id = mintId();
  db.prepare(
    `INSERT INTO journal_entries (id, venture_id, kind, text, url, at, result, outcome_id, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, ventureId, kind, text, url, day.day, result, input.source, now());

  return { entry: entryRow(id)! };
}

/**
 * A VENTURE BY EXACTLY THE NAME IT HAS: an id, a slug, a name or a host,
 * case-insensitively. No fuzziness at all.
 *
 * This is the one every path uses that is reading a word somebody may not have
 * meant as a venture name — see `resolveVentureLoose` below for the other one,
 * and why the two are separate.
 */
export function resolveVentureExact(key: string): VentureRow | null {
  const k = key.trim();
  if (!k) return null;
  const lower = k.toLowerCase();
  const rows = ventureRows();
  return (
    rows.find((v) => v.id === k) ??
    rows.find((v) => v.slug.toLowerCase() === lower) ??
    rows.find((v) => v.name.toLowerCase() === lower) ??
    rows.find((v) => (v.host ?? "").toLowerCase() === lower) ??
    null
  );
}

/**
 * THE SAME, PLUS A UNIQUE PREFIX — and it is a SEPARATE function rather than a
 * flag because of what happened when it was one.
 *
 * The prefix rule exists so an agent or a person who types `northw` into the
 * API's explicit `venture` parameter gets Northwind: they have said "this is a
 * venture name" by putting it in that field, and the only question left is
 * which one. Applied to the FIRST WORD OF A SENTENCE it is a different and much
 * worse thing — a box with a venture called "Postal" would read
 * `/did post the update` as "post" naming Postal, strip the word, and file
 * "the update" against a business it has nothing to do with. An unambiguous
 * prefix of an ordinary English word is the hazard, and it is not helped by the
 * ambiguity check: "post" matches exactly one venture, confidently and wrongly.
 *
 * So: the explicit parameter resolves loosely, the leading word of a `/did`
 * resolves exactly, and neither can be reached through the other.
 *
 * An ambiguous prefix still resolves to NOTHING rather than to the first match.
 * Filing work against the wrong business is a quiet error nobody catches for a
 * month, and the caller gets a refusal it can act on instead.
 */
export function resolveVentureLoose(key: string): VentureRow | null {
  const exact = resolveVentureExact(key);
  if (exact) return exact;
  const lower = key.trim().toLowerCase();
  if (!lower) return null;
  const starts = ventureRows().filter(
    (v) => v.name.toLowerCase().startsWith(lower) || v.slug.toLowerCase().startsWith(lower),
  );
  return starts.length === 1 ? starts[0]! : null;
}


export function entryRow(id: string): EntryRow | undefined {
  return db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(id) as EntryRow | undefined;
}

export type ListQuery = {
  ventureId?: string | null;
  kind?: string | null;
  /** Inclusive lower bound on `at`, as YYYY-MM-DD. */
  from?: string | null;
  limit?: number;
};

/** The WHERE clause and its arguments, built once so the rows, the per-kind
 *  counts and the total are all answering the same question. Three places
 *  composing the same filter by hand is how `counts` came to be a count of the
 *  page rather than of the window. */
function filter(q: ListQuery): { sql: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.ventureId !== undefined && q.ventureId !== null) {
    where.push("venture_id = ?");
    args.push(q.ventureId);
  }
  if (q.kind) {
    where.push("kind = ?");
    args.push(q.kind);
  }
  if (q.from) {
    where.push("at >= ?");
    args.push(q.from);
  }
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", args };
}

export function entryRows(q: ListQuery = {}): EntryRow[] {
  const { sql, args } = filter(q);
  const limit = Math.min(2_000, Math.max(1, q.limit ?? 200));
  return db
    .prepare(
      `SELECT * FROM journal_entries${sql} ORDER BY at DESC, created_at DESC, id DESC LIMIT ?`,
    )
    .all(...(args as never[]), limit) as unknown as EntryRow[];
}

/**
 * EVERY ROW THE FILTER MATCHES, WITH NO LIMIT — for the export and nothing
 * else.
 *
 * `entryRows` clamps at 2000 because a page that asked for everything would
 * otherwise be able to. The export is the one route where that clamp is a lie:
 * it exists so that a journal is not held hostage by this box, and a silent cut
 * at 2000 takes the OLDEST rows off the one document somebody reaches for when
 * they are leaving. Five and a half years of one entry a day is a few hundred
 * kilobytes; the honest answer is all of it.
 */
export function allEntryRows(ventureId?: string | null): EntryRow[] {
  const { sql, args } = filter({ ventureId: ventureId ?? null });
  return db
    .prepare(`SELECT * FROM journal_entries${sql} ORDER BY at DESC, created_at DESC, id DESC`)
    .all(...(args as never[])) as unknown as EntryRow[];
}

/**
 * HOW MANY OF EACH KIND THE FILTER MATCHES — counted by the database over the
 * WHOLE window, not by filtering the rows that were returned.
 *
 * The two are the same until somebody has more than `limit` entries in the
 * window, and then they are silently different: the document says "for the
 * window" and would have been reporting the last two hundred rows. Counting in
 * SQL is also the only version that stays right when the limit changes.
 */
export function countsByKind(q: ListQuery = {}): Record<string, number> {
  const { sql, args } = filter(q);
  const rows = db
    .prepare(`SELECT kind, count(*) AS n FROM journal_entries${sql} GROUP BY kind`)
    .all(...(args as never[])) as unknown as { kind: string; n: number }[];
  const out: Record<string, number> = {};
  for (const k of KINDS) out[k] = 0;
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

/** How many rows the filter matches, whatever the limit returned. */
export function entryCount(q: ListQuery = {}): number {
  const { sql, args } = filter(q);
  return (
    db.prepare(`SELECT count(*) AS n FROM journal_entries${sql}`).get(...(args as never[])) as {
      n: number;
    }
  ).n;
}

/**
 * EVERY DISTINCT DAY THE OWNER HIMSELF PUT SOMETHING ON, newest first — the
 * streak's whole input.
 *
 * `source = 'agent'` IS EXCLUDED, and that exclusion is the point rather than a
 * detail. This area's first rule is that the agent files what the owner SAID
 * and never its own work, and the `source` stamp is what makes that checkable;
 * but a stamp on a row does nothing for a number computed over all the rows. A
 * streak is read as "how many days running have I shown up", and an agent that
 * back-filled a week — helpfully, wrongly, or because it was asked to tidy up —
 * would have handed the owner a run he did not do, in the one table whose
 * entire value is that a person vouched for every row. So the run is counted
 * over what he typed here and what he sent from his phone, and the document
 * publishes the agent-filed count separately so nothing is hidden either.
 *
 * Kept as a separate read from the rows because a streak over two years of
 * entries must not have to load two years of sentences.
 */
export function entryDays(ventureId?: string | null): string[] {
  const marks = OWNER_SOURCES.map(() => "?").join(", ");
  return (
    ventureId
      ? (db
          .prepare(
            `SELECT DISTINCT at FROM journal_entries WHERE venture_id = ? AND source IN (${marks}) ORDER BY at DESC`,
          )
          .all(ventureId, ...OWNER_SOURCES) as unknown as { at: string }[])
      : (db
          .prepare(
            `SELECT DISTINCT at FROM journal_entries WHERE source IN (${marks}) ORDER BY at DESC`,
          )
          .all(...OWNER_SOURCES) as unknown as { at: string }[])
  ).map((r) => r.at);
}

/** How many rows in the whole journal (or one venture's) the AGENT filed. The
 *  number the streak leaves out, published so that leaving it out is visible. */
export function agentFiledCount(ventureId?: string | null): number {
  return (
    ventureId
      ? (db
          .prepare("SELECT count(*) AS n FROM journal_entries WHERE venture_id = ? AND source = 'agent'")
          .get(ventureId) as { n: number })
      : (db.prepare("SELECT count(*) AS n FROM journal_entries WHERE source = 'agent'").get() as {
          n: number;
        })
  ).n;
}

export function setOutcome(id: string, outcomeId: string | null): EntryRow | undefined {
  db.prepare("UPDATE journal_entries SET outcome_id = ? WHERE id = ?").run(outcomeId, id);
  return entryRow(id);
}

export function setResult(id: string, result: string | null): EntryRow | undefined {
  db.prepare("UPDATE journal_entries SET result = ? WHERE id = ?").run(
    result === null ? null : clean(result, MAX_RESULT) || null,
    id,
  );
  return entryRow(id);
}

/**
 * DELETE ONE ENTRY — AND ITS EVENT ON THE ACTIVITY FEED.
 *
 * THE SECOND STATEMENT IS THE WHOLE REASON THIS IS A FUNCTION AND NOT A LINE IN
 * THE ROUTE. `activity/feed.ts` derives an event per entry, keyed `journal:<id>`,
 * and that pass only ever UPSERTS what still exists — it has no way to notice a
 * row that has gone. Without this, deleting an entry removed it from the
 * journal, answered 200, and left the sentence, its venture and its link on the
 * timeline for ever. The one thing somebody deleting an entry is trying to do is
 * make it stop being anywhere, and "met the buyer about the sale" surviving the
 * trash icon is the exact failure a delete button is supposed to prevent.
 *
 * `activity_events` IS THE ACTIVITY AREA'S TABLE and may be absent on a tree
 * that has not run its migrations, so the delete is guarded: losing the journal
 * row because a foreign table was missing would be the worse of the two
 * failures, and the event is re-derivable while the entry is not.
 *
 * The OUTCOME an entry created is deliberately NOT deleted with it — those
 * readings are a record of what a metric did and stand on their own — and the
 * route says so in its response.
 */
export function deleteEntry(id: string): boolean {
  const gone = db.prepare("DELETE FROM journal_entries WHERE id = ?").run(id).changes > 0;
  try {
    db.prepare("DELETE FROM activity_events WHERE key = ?").run(`journal:${id}`);
  } catch {
    /* No activity_events table on this box. Nothing derived the event either. */
  }
  return gone;
}

/* ------------------------------------------------------------- the streak */

export type Streak = {
  current: number;
  longest: number;
  lastDay: string | null;
  /** True when the current run includes today. False with a positive `current`
   *  means yesterday was the last day — the run is alive and today is empty. */
  today: boolean;
  days: number;
  /** Which sources the days above were counted over. Published rather than
   *  implied: a streak is a claim about who did something, and a reader is
   *  entitled to know that the agent's rows are not in it. */
  sources: readonly Source[];
  /** How many rows the AGENT filed that this run therefore does not count. */
  agentFiled: number;
};

/** One day earlier, in the date-only arithmetic the whole table uses. Noon UTC
 *  so a DST shift can never move the answer to the previous day. */
export function dayBefore(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * CONSECUTIVE DAYS WITH AT LEAST ONE ENTRY THE OWNER FILED.
 *
 * The source filter is `entryDays`'s and not this function's — this is pure
 * arithmetic over a list of days, which is what makes it testable — but it is
 * the same claim, so `sources` and `agentFiled` are carried out with the answer
 * rather than left for a caller to remember to say.
 *
 * TODAY BEING EMPTY DOES NOT BREAK THE RUN, and that is the one judgement in
 * this function. A streak that resets at midnight would read as broken every
 * morning for the whole of a working day that has not happened yet, so the run
 * is counted back from today if today has an entry and from YESTERDAY if it
 * does not. `today: false` with a positive `current` is how a caller tells the
 * difference, and every surface that draws the number says which it is.
 *
 * Two days with nothing in them ends it. There is no grace for weekends: a
 * weekend rule would be this file deciding what a working week is for
 * somebody whose whole arrangement is that nobody decides that for them.
 *
 * Pure, and takes the day list and today as arguments, because the arithmetic
 * is the part worth testing and a function that reads the clock cannot be.
 */
export function streak(days: string[], todayDay: string, agentFiled = 0): Streak {
  const set = new Set(days);
  const sorted = [...set].sort();
  const provenance = { sources: OWNER_SOURCES, agentFiled };
  if (!sorted.length)
    return { current: 0, longest: 0, lastDay: null, today: false, days: 0, ...provenance };

  const hasToday = set.has(todayDay);
  const yesterday = dayBefore(todayDay);
  let cursor = hasToday ? todayDay : set.has(yesterday) ? yesterday : null;
  let current = 0;
  while (cursor && set.has(cursor)) {
    current += 1;
    cursor = dayBefore(cursor);
  }

  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    run = previous !== null && dayBefore(day) === previous ? run + 1 : 1;
    if (run > longest) longest = run;
    previous = day;
  }

  return {
    current,
    longest,
    lastDay: sorted[sorted.length - 1]!,
    today: hasToday,
    days: sorted.length,
    ...provenance,
  };
}

/* ---------------------------------------------------------------- shaping */

export function shape(r: EntryRow) {
  const v = r.venture_id ? ventureRowById(r.venture_id) : undefined;
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    url: r.url,
    at: r.at,
    result: r.result,
    outcomeId: r.outcome_id,
    source: r.source,
    createdAt: r.created_at,
    ventureId: r.venture_id,
    venture: v ? { id: v.id, slug: v.slug, name: v.name } : null,
    /* Stated rather than inferred by every reader: the same two-kind rule the
       outcomes hook enforces, published so a client does not re-derive it. */
    trackable: !r.outcome_id && !!r.url && (TRACKABLE as readonly string[]).includes(r.kind),
    /* A back-dated row is visibly back-dated. The instant is kept for exactly
       this: a streak nobody can check is a streak worth nothing. Compared in
       LOCAL days, because `at` is a local day and `created_at` is a UTC
       instant — comparing the two strings directly would call an entry made at
       half past eleven at night a back-dated one. */
    backdated: today(new Date(r.created_at)) !== r.at,
  };
}
