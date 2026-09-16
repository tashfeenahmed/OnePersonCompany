/**
 * THE NOVELTY GATE — a deterministic refusal, before anything is spent.
 *
 * THE PROBLEM IT SOLVES. The autopilot derives a topic by putting the venture
 * record and the last five briefs to a model and asking for a sixth. That is
 * an INSTRUCTION and an instruction is not a constraint: a model handed five
 * subjects and told to pick a different one will, often enough, pick the first
 * one again in different words. When it does, the cost is not a duplicate row
 * — it is a Replicate charge, a few hundred megabytes of Pexels footage and
 * ten minutes of this laptop's CPU spent making a video that already exists.
 * The system this replaces learned this the same way and put a stem-overlap
 * gate in code in front of the model; this is that gate, made durable and
 * made to explain itself.
 *
 * IT RUNS BEFORE ANY PAID GENERATION AND IT IS PURE. Everything in this file
 * is arithmetic over rows: no model, no network, no clock beyond `now`. That
 * is what makes it testable, and it is tested — see socialfeed.test.ts, which
 * is the reason `fingerprint`, `overlap` and `checkTopic`'s decision are
 * separate exported functions rather than one private block.
 *
 * TWO KINDS OF CHECK, BECAUSE THEY ARE TWO DIFFERENT QUESTIONS.
 *
 *   A TOPIC is compared by SIMILARITY over a WINDOW. "AI tutoring for exams"
 *   and "exam prep with an AI tutor" are the same video, and no string
 *   equality will ever say so. The window is a setting because "we have said
 *   this recently" is a judgement about how fast a business moves — a month is
 *   the default, and a topic older than the window is allowed back because a
 *   business is allowed to make the same point twice a year.
 *
 *   A SOURCE VIDEO is compared by IDENTITY and FOREVER. Cutting a second short
 *   out of a talk that has already been cut is not "similar", it is the same
 *   footage, and there is no window after which that stops being true.
 *
 * THE FINGERPRINT IS NORMALISED AND THE NORMALISATION IS THE ALGORITHM.
 * Lower case; URLs removed whole rather than tokenised, because a link in a
 * brief would otherwise dominate every comparison; everything that is not a
 * letter or a digit becomes a space; words of three characters or fewer and
 * an explicit stop list are dropped; what survives is cut to a five-character
 * stem so that "tutoring", "tutors" and "tutor" are one token; the tokens are
 * de-duplicated and SORTED, so word order cannot change a fingerprint.
 *
 * THE OVERLAP IS ASYMMETRIC AND THAT IS DELIBERATE. It is the share of the NEW
 * topic's tokens that the old one already had. A short new brief entirely
 * contained in a long old one scores 1.0 and is refused, which is right: it
 * says nothing the old one did not. The reverse — a long new brief that
 * happens to contain a short old one — scores low and is allowed, which is
 * also right, because it is saying more.
 *
 * EVERY VERDICT IS WRITTEN DOWN, including the ones that allow. A gate that
 * only recorded refusals cannot be told apart from a gate that is not running.
 */
import { configValue, db, now } from "../../db.ts";

export const SOCIALFEED_PLUGIN = "socialfeed";

/** How recently a topic must have been used for a repeat to be refused.
 *  Thirty days: long enough that a daily autopilot cannot loop, short enough
 *  that a quarterly re-make of a good subject is not blocked forever. */
export const DEFAULT_NOVELTY_DAYS = 30;

/** The overlap at or above which two topics are the same piece of work.
 *  0.6 rather than the previous system's 0.5: this gate REFUSES rather than
 *  asking the model to try again, so it is set where a false refusal is rare
 *  and the caller can still ask for a second topic. */
export const DEFAULT_REPEAT_LIMIT = 0.6;

/**
 * Words that carry no subject. Kept short on purpose: a long stop list starts
 * removing the words that distinguish two briefs, and the five-character stem
 * already collapses most inflections.
 */
const STOP = new Set(
  ("the and for with that this from your you are our its into how why what when who will can not " +
    "but all any one two new more most best top use using make made get about have has had them " +
    "they their there here than then which while such very just also only over under between")
    .split(" "),
);

/**
 * Suffixes stripped before a word is truncated, longest first.
 *
 * WHY A SUFFIX LIST AND NOT JUST A TRUNCATION. A five-character truncation was
 * what this file shipped with and it was wrong in BOTH directions at once. It
 * failed to collapse the example this area's own settings hint, header and
 * README all promise — "AI tutoring for exams" against "exam prep with an AI
 * tutor", where `exams` and `exam` are both under five characters and neither
 * is touched — and it silently COLLAPSED words that are not the same word at
 * all: `marketing`/`marker` and `customer`/`custom` both truncate to the same
 * five characters, so a genuinely new topic could be refused at 1.0.
 *
 * Stripping the inflection first and truncating longer afterwards fixes both:
 * `exams`→`exam`, `tutoring`→`tutor`, `tutors`→`tutor`, while `marketing`→
 * `market` stays clear of `marker` and `customer` stays clear of `custom`.
 *
 * ONE SUFFIX PER WORD, NOT A LOOP. Stripping repeatedly is not symmetric:
 * `businesses` loses `es` and `business` loses `s`, and a second pass then
 * takes a different amount off each, so the two never meet. One pass plus the
 * `ss` rule below lands both on `business`.
 *
 * `s` IS NEVER TAKEN OFF A WORD ENDING `ss`, which is Porter's rule and is
 * what makes `business`, `process` and `class` survive intact — and therefore
 * what lets their plurals, which lose `es`, land on top of them.
 *
 * A SUFFIX IS ONLY STRIPPED WHEN FOUR CHARACTERS SURVIVE IT. Without that
 * floor, `cars` becomes `car` and `speed` becomes `spe`, and short words start
 * colliding with each other — which is the failure this list exists to end.
 */
const SUFFIXES = ["ations", "ation", "ings", "ing", "ies", "es", "ed", "s"] as const;

/** How much of a word survives after its inflection is taken off. Eight rather
 *  than five: see SUFFIXES for the two ways five was wrong. */
const STEM_CHARS = 8;

export function stem(word: string): string {
  let w = word;
  for (const suffix of SUFFIXES) {
    if (w.length - suffix.length < 4 || !w.endsWith(suffix)) continue;
    if (suffix === "s" && w.endsWith("ss")) continue;
    w = w.slice(0, -suffix.length);
    /* `stories` → `stor` → `story`, so it meets `story`. Without this the
       plural of every -y noun is a different token from its singular. */
    if (suffix === "ies") w += "y";
    break;
  }
  return w.slice(0, STEM_CHARS);
}

/**
 * The normalised form of a topic. Deterministic, and the same input always
 * gives the same output — there is no clock, no randomness and no model here.
 *
 * IT IS UNICODE-AWARE, AND THAT IS NOT A NICETY. The first version of this
 * function stripped everything outside `a-z0-9`, which does not mean "remove
 * punctuation" — it means REMOVE EVERY LETTER THAT IS NOT ENGLISH. Measured:
 * "Как обрабатывать повторяющиеся вопросы" and "日本語のトピック" both
 * fingerprinted to the empty string, which `judgeTopic` turns into a refusal
 * saying the topic "has no distinctive words left". So on any install whose
 * model answers in a non-Latin script the gate would have refused one hundred
 * per cent of topics, forever, and blamed the brief. Accented Latin was
 * mangled rather than erased, which is worse in its own way: "répétitives"
 * became "titiv".
 *
 * The fix is two steps and they are in this order on purpose. NFKD first,
 * which splits "é" into "e" plus a combining acute, then the combining marks
 * are removed — so "gérer" and "gerer" are one word, which is what somebody
 * typing either of them meant. Then `\p{L}\p{N}` under the `u` flag keeps
 * every letter and digit in every script and drops only real punctuation.
 *
 * A SCRIPT WITH NO SPACES IS ONE TOKEN AND THAT IS HONEST. Japanese and
 * Chinese do not delimit words, so "日本語のトピック" survives as a single
 * token rather than as nothing. It is a weaker fingerprint than an English
 * sentence gets — two different Japanese briefs will rarely overlap — and a
 * weak gate that lets work through is the correct direction to be wrong in.
 * A word segmenter for every language is not something this file can carry.
 */
export function fingerprint(text: string): string {
  return [
    ...new Set(
      String(text ?? "")
        .toLowerCase()
        /* URLs whole, before punctuation stripping turns one into fifteen
           tokens of host and path that would swamp every other word. */
        .replace(/https?:\/\/\S+/g, " ")
        .normalize("NFKD")
        /* ONLY THE LATIN/GREEK/CYRILLIC DIACRITICS, by code point, and not
           every combining mark. `\p{M}` would also take Japanese dakuten,
           turning ピ into ヒ — a different sound and a different word. This
           range is the accents; the NFC below puts back together anything that
           was decomposed and not stripped. */
        .replace(/[\u0300-\u036f]/g, "")
        .normalize("NFC")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOP.has(w))
        .map(stem),
    ),
  ]
    .sort()
    .join(" ");
}

/** The tokens of a fingerprint, as a set. */
const tokens = (fp: string) => new Set(fp.split(" ").filter(Boolean));

/**
 * How much of `fresh` is already in `old`, 0..1.
 *
 * ASYMMETRIC — see the header. An empty fresh fingerprint scores 0: a topic
 * made entirely of stop words is not a repeat of anything, it is a topic this
 * gate cannot judge, and refusing it would be refusing on no evidence.
 */
export function overlap(freshFp: string, oldFp: string): number {
  const a = tokens(freshFp);
  if (!a.size) return 0;
  const b = tokens(oldFp);
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n / a.size;
}

/* ------------------------------------------------------------- the settings */

const num = (key: string, fallback: number, lo: number, hi: number): number => {
  const raw = (configValue(SOCIALFEED_PLUGIN, key) ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

export function noveltyDays(): number {
  return Math.round(num("noveltyDays", DEFAULT_NOVELTY_DAYS, 0, 3650));
}

export function repeatLimit(): number {
  return num("repeatLimit", DEFAULT_REPEAT_LIMIT, 0.1, 1);
}

/* --------------------------------------------------------------- the rows */

export type HistoryRow = {
  id: number;
  venture_id: string;
  format: string;
  topic: string;
  fingerprint: string;
  source_url: string | null;
  source_id: string | null;
  page_url: string | null;
  asset_kind: string | null;
  asset_ref: string | null;
  created_at: string;
  /** Null is a live entry. A date is one the owner set aside: the gate stops
   *  counting it and every list still shows it. */
  archived_at: string | null;
};

export function historyRows(opts: {
  ventureId?: string | null;
  format?: string | null;
  limit?: number;
  /** Archived entries are INCLUDED by default, because the point of archiving
   *  rather than deleting is that the record survives where somebody can see
   *  it. Pass `false` for the live set the gate compares against. */
  archived?: boolean;
}): HistoryRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.ventureId) {
    where.push("venture_id = ?");
    args.push(opts.ventureId);
  }
  if (opts.format) {
    where.push("format = ?");
    args.push(opts.format);
  }
  if (opts.archived === false) where.push("archived_at IS NULL");
  args.push(Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100))));
  return db
    .prepare(
      `SELECT * FROM content_history ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...args) as unknown as HistoryRow[];
}

/**
 * File a piece of work against its venture and format.
 *
 * CALLED WHEN WORK IS QUEUED, NOT WHEN IT FINISHES. A run that failed still
 * used up its topic; re-deriving the same subject tomorrow morning because
 * last night's encode crashed would be the gate failing open on the one day it
 * was needed.
 */
export function remember(entry: {
  ventureId: string;
  format: string;
  topic: string;
  sourceUrl?: string | null;
  sourceId?: string | null;
  pageUrl?: string | null;
  assetKind?: string | null;
  assetRef?: string | null;
}): HistoryRow {
  const fp = fingerprint(entry.topic);
  const info = db
    .prepare(
      `INSERT INTO content_history
         (venture_id, format, topic, fingerprint, source_url, source_id, page_url, asset_kind, asset_ref, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      entry.ventureId,
      entry.format,
      entry.topic.slice(0, 600),
      fp,
      entry.sourceUrl ?? null,
      entry.sourceId ?? null,
      entry.pageUrl ?? null,
      entry.assetKind ?? null,
      entry.assetRef ?? null,
      now(),
    );
  return db
    .prepare("SELECT * FROM content_history WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as unknown as HistoryRow;
}

/* --------------------------------------------------------------- the gate */

export type Verdict = {
  ok: boolean;
  reason: string;
  fingerprint: string;
  /** The history row that caused a refusal, and how close it was. Null on an
   *  allow — there is nothing to show. */
  matched: { id: number; topic: string; createdAt: string; score: number } | null;
};

/**
 * Decide, given rows. PURE — no database, no clock beyond `at`.
 *
 * Separated from `checkTopic` below so the decision can be tested without a
 * database, which is the only way a rule like this stays trustworthy.
 */
export function judgeTopic(
  topic: string,
  history: Pick<HistoryRow, "id" | "topic" | "fingerprint" | "created_at">[],
  opts: { days: number; limit: number; at?: Date },
): Verdict {
  const fp = fingerprint(topic);
  if (!fp)
    return {
      ok: false,
      reason:
        "There is nothing to compare: after normalisation the topic has no distinctive words left, " +
        "which means it is not a brief. Nothing was spent.",
      fingerprint: fp,
      matched: null,
    };

  const at = (opts.at ?? new Date()).getTime();
  /* A window of zero days switches the topic half of the gate OFF. That is a
     real thing to want — a portfolio making one post a month has no repeats to
     prevent — and it is better expressed as a setting of 0 than as a checkbox
     somewhere else. */
  const cutoff = opts.days > 0 ? at - opts.days * 86_400_000 : null;

  let worst: Verdict["matched"] = null;
  for (const row of history) {
    if (cutoff !== null) {
      const when = Date.parse(row.created_at);
      if (!Number.isFinite(when) || when < cutoff) continue;
    } else continue;
    const score = overlap(fp, row.fingerprint);
    if (score >= opts.limit && (!worst || score > worst.score))
      worst = { id: row.id, topic: row.topic, createdAt: row.created_at, score };
  }

  if (worst)
    return {
      ok: false,
      reason:
        `${Math.round(worst.score * 100)}% of this topic's words were already used on ` +
        `${worst.createdAt.slice(0, 10)} for “${worst.topic.slice(0, 120)}”. ` +
        `The novelty window is ${opts.days} days; nothing was generated.`,
      fingerprint: fp,
      matched: worst,
    };

  return {
    ok: true,
    reason:
      opts.days > 0
        ? `Nothing in the last ${opts.days} days overlaps this topic by ${Math.round(opts.limit * 100)}% or more.`
        : "The topic window is set to zero days, so topics are not compared at all.",
    fingerprint: fp,
    matched: null,
  };
}

/** Decide, and write the verdict down. This is what a caller about to spend
 *  money calls. */
export function checkTopic(ventureId: string, format: string, topic: string): Verdict {
  const days = noveltyDays();
  const limit = repeatLimit();
  /* LIVE ROWS ONLY. An archived entry is one the owner set aside precisely so
     its topic stops being refused; counting it here would make archiving a
     button that does nothing. The row itself is still on every list. */
  const rows = db
    .prepare(
      "SELECT id, topic, fingerprint, created_at FROM content_history WHERE venture_id = ? AND format = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 200",
    )
    .all(ventureId, format) as unknown as Pick<HistoryRow, "id" | "topic" | "fingerprint" | "created_at">[];
  const verdict = judgeTopic(topic, rows, { days, limit });
  writeCheck({
    ventureId,
    format,
    kind: "topic",
    value: topic,
    fingerprint: verdict.fingerprint,
    verdict: verdict.ok ? "allow" : "refuse",
    reason: verdict.reason,
    matchedId: verdict.matched?.id ?? null,
    matched: verdict.matched?.topic ?? null,
    score: verdict.matched?.score ?? null,
  });
  return verdict;
}

/**
 * Has this source video already been cut up?
 *
 * BY ID WHERE THERE IS ONE AND BY URL WHERE THERE IS NOT. A YouTube video has
 * four addresses (watch, youtu.be, shorts, embed) and one id; comparing URLs
 * would let the same talk through four times.
 */
export function checkSource(
  ventureId: string,
  sourceId: string | null,
  url: string,
): Verdict & { usedBy: string | null } {
  /* PER VENTURE, AND THAT CHANGED. It used to ask whether ANY venture on this
     box had cut this source up, which meant two businesses in the same niche
     could never both use the same public talk — a portfolio-scale surprise
     nobody asked for. A source belongs to the business that used it; the
     ledger of what one venture has made is not a rule about another. */
  const row = sourceId
    ? (db
        .prepare(
          "SELECT id, topic, created_at, asset_ref FROM content_history WHERE venture_id = ? AND source_id = ? AND archived_at IS NULL LIMIT 1",
        )
        .get(ventureId, sourceId) as { id: number; topic: string; created_at: string; asset_ref: string | null } | undefined)
    : (db
        .prepare(
          "SELECT id, topic, created_at, asset_ref FROM content_history WHERE venture_id = ? AND source_url = ? AND archived_at IS NULL LIMIT 1",
        )
        .get(ventureId, url) as { id: number; topic: string; created_at: string; asset_ref: string | null } | undefined);

  const verdict: Verdict & { usedBy: string | null } = row
    ? {
        ok: false,
        reason:
          `This source was already cut up on ${row.created_at.slice(0, 10)}` +
          `${row.asset_ref ? ` by run ${row.asset_ref}` : ""}. A second short out of the same footage is the same footage.`,
        fingerprint: "",
        matched: { id: row.id, topic: row.topic, createdAt: row.created_at, score: 1 },
        usedBy: row.asset_ref,
      }
    : {
        ok: true,
        reason: "This venture has never cut this source up. Another venture may have — a source belongs to the business that used it.",
        fingerprint: "",
        matched: null,
        usedBy: null,
      };

  writeCheck({
    ventureId,
    format: "shorts",
    kind: "source",
    value: sourceId ? `${sourceId} (${url})` : url,
    fingerprint: null,
    verdict: verdict.ok ? "allow" : "refuse",
    reason: verdict.reason,
    matchedId: verdict.matched?.id ?? null,
    matched: verdict.matched?.topic ?? null,
    /* Null rather than 1: a source check is an identity test, and a similarity
       score on it would be a number that means nothing. */
    score: null,
  });
  return verdict;
}

/* ------------------------------------------------------------- the record */

export type CheckRow = {
  id: number;
  ts: string;
  venture_id: string | null;
  format: string;
  kind: string;
  value: string;
  fingerprint: string | null;
  verdict: string;
  reason: string | null;
  matched_id: number | null;
  matched: string | null;
  score: number | null;
};

function writeCheck(e: {
  ventureId: string | null;
  format: string;
  kind: "topic" | "source";
  value: string;
  fingerprint: string | null;
  verdict: "allow" | "refuse";
  reason: string;
  matchedId: number | null;
  matched: string | null;
  score: number | null;
}) {
  db.prepare(
    `INSERT INTO novelty_checks (ts, venture_id, format, kind, value, fingerprint, verdict, reason, matched_id, matched, score)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    now(),
    e.ventureId,
    e.format,
    e.kind,
    e.value.slice(0, 600),
    e.fingerprint,
    e.verdict,
    e.reason.slice(0, 600),
    e.matchedId,
    e.matched?.slice(0, 300) ?? null,
    e.score,
  );
}

export function checkRows(opts: { ventureId?: string | null; limit?: number }): CheckRow[] {
  const args: (string | number)[] = [];
  let where = "";
  if (opts.ventureId) {
    where = "WHERE venture_id = ?";
    args.push(opts.ventureId);
  }
  args.push(Math.max(1, Math.min(300, Math.floor(opts.limit ?? 60))));
  return db
    .prepare(`SELECT * FROM novelty_checks ${where} ORDER BY id DESC LIMIT ?`)
    .all(...args) as unknown as CheckRow[];
}

/**
 * A topic that was refused, and is now allowed anyway.
 *
 * THE OWNER OVERRULES THE GATE BY SETTING ONE HISTORY ROW ASIDE, not by adding
 * an exception. An exception list would be a second rule to keep in step with
 * the first; archiving one previous brief is a smaller change and it is
 * visible in the history the next time somebody looks.
 *
 * IT ARCHIVES AND DOES NOT DELETE, AND THAT IS THE WHOLE POINT OF THE COLUMN.
 * This is reachable by an agent, and an agent that hits a refusal can read its
 * own rules, find this door and walk through it to get the job done — which,
 * with a DELETE behind it, destroyed the record of what had already been made
 * with nothing to restore from. Now the row stays, the gate stops counting it,
 * every list still shows it flagged, and `restore` puts it back.
 */
export function forget(id: number): { ok: boolean; error?: string; already?: boolean } {
  const row = db.prepare("SELECT id, archived_at FROM content_history WHERE id = ?").get(id) as
    | { id: number; archived_at: string | null }
    | undefined;
  if (!row) return { ok: false, error: `There is no history entry ${id}.` };
  if (row.archived_at) return { ok: true, already: true };
  db.prepare("UPDATE content_history SET archived_at = ? WHERE id = ?").run(now(), id);
  return { ok: true };
}

/** The undo. Not a separate concept — the same column, the other way. */
export function restore(id: number): { ok: boolean; error?: string } {
  const row = db.prepare("SELECT id FROM content_history WHERE id = ?").get(id);
  if (!row) return { ok: false, error: `There is no history entry ${id}.` };
  db.prepare("UPDATE content_history SET archived_at = NULL WHERE id = ?").run(id);
  return { ok: true };
}

/**
 * Bring every stored fingerprint back into step with the current algorithm.
 *
 * WHY THIS EXISTS AT ALL. `fingerprint` is a pure function of the topic and the
 * column is a CACHE of it — kept because the gate compares hundreds of rows and
 * because a page wants to show what was compared. A cache of a pure function
 * goes stale the moment the function changes, and this one changed twice on the
 * day it was written: once to stop erasing non-Latin letters, once to fix a
 * stem that both under- and over-collapsed. Rows written before either change
 * hold fingerprints the gate would never match, so a topic that IS a repeat
 * would sail through.
 *
 * IDEMPOTENT AND CHEAP: it rewrites only the rows that disagree, and on a box
 * where nothing changed it writes nothing at all. Called once from `onStart`.
 */
export function reindex(): number {
  const rows = db
    .prepare("SELECT id, topic, fingerprint FROM content_history")
    .all() as unknown as { id: number; topic: string; fingerprint: string }[];
  const update = db.prepare("UPDATE content_history SET fingerprint = ? WHERE id = ?");
  let changed = 0;
  for (const row of rows) {
    const fresh = fingerprint(row.topic);
    if (fresh === row.fingerprint) continue;
    update.run(fresh, row.id);
    changed += 1;
  }
  return changed;
}
