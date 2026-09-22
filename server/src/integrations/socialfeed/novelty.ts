/**
 * THE NOVELTY GATE — a model's judgment, before anything is spent.
 *
 * THE PROBLEM IT SOLVES. The autopilot derives a topic by putting the venture
 * record and the last five briefs to a model and asking for a sixth. That is
 * an INSTRUCTION and an instruction is not a constraint: a model handed five
 * subjects and told to pick a different one will, often enough, pick the first
 * one again in different words. When it does, the cost is not a duplicate row
 * — it is a Replicate charge, a few hundred megabytes of Pexels footage and
 * ten minutes of this laptop's CPU spent making a video that already exists.
 * So something has to decide, before the money is spent, whether this is the
 * same piece of work as something already made.
 *
 * WHY THAT DECIDER IS NO LONGER A WORD LIST. This file shipped as arithmetic:
 * fifty-seven stop words, eight suffix rules, an eight-character stem, and a
 * refusal whenever 60% of a new topic's stems had been used before. It was the
 * most carefully tuned word list in this codebase and it was still a word list
 * deciding a matter of MEANING — which the owner ruled out on 2026-09-21, after
 * exactly this class of rule kept being wrong in both directions at once. Its
 * own test pinned the shape of the failure: it asserted that "exam prep with an
 * AI tutor" IS the same piece of work as "AI tutoring for exams" because two
 * stems matched, and that "marketing automation" is NOT the same as "marker
 * automation" because two stems did not. Neither of those is a fact about the
 * words; both are judgments about the work, and the arithmetic was reaching
 * them by counting. Tuning only moved which half was wrong: at 0.5 it refused
 * genuinely new topics, at 0.6 it let reworded ones through, and no stemmer can
 * tell "our pricing, explained" from "why we changed our pricing".
 *
 * SO A MODEL READS THE CANDIDATE AGAINST THE HISTORY AND ANSWERS ONE WORD.
 * `repeat` or `fresh`, through models/judge.ts, which owns the round trip, the
 * closed vocabulary, the all-or-nothing parse, the fail-open and the record in
 * `gate_verdicts`. ONE CALL PER CHECK: the candidate is the item and the whole
 * recent history is the context, because "is this one of these" is a single
 * question — asking it once per history row would cost forty round trips and
 * would stop the model from seeing that two old entries are one subject.
 *
 * IT LEANS FRESH, AND THE ASYMMETRY IS THE POINT. This gate REFUSES rather than
 * warning, so a wrong refusal is not noise: it is the owner's autopilot quietly
 * producing nothing, night after night, with no error anywhere for somebody to
 * read. A wrong allow costs one duplicate video. The question text says that in
 * as many words, and an unreachable model allows too — see `judgeTopic`.
 *
 * TWO KINDS OF CHECK, BECAUSE THEY ARE TWO DIFFERENT QUESTIONS.
 *
 *   A TOPIC is a MATTER OF MEANING over a WINDOW, so a model decides it. The
 *   window is a setting because "we have said this recently" is a judgement
 *   about how fast a business moves — a month is the default, and a topic older
 *   than the window is never even shown to the judge, because a business is
 *   allowed to make the same point twice a year.
 *
 *   A SOURCE VIDEO is a matter of IDENTITY and is FOREVER, so CODE decides it.
 *   Cutting a second short out of a talk that has already been cut is not
 *   "similar", it is the same footage, an id equals an id, and a model asked
 *   that question would add latency and doubt and nothing else.
 *
 * ONE PIECE OF CODE SURVIVES ON THE TOPIC PATH, AND IT IS A FACT. Two topics
 * whose normalised text is character-for-character equal are the same topic;
 * that is string equality, not similarity, and it is answered here for free
 * before a model is woken. `normalise` is that comparison and NOTHING ELSE — no
 * stop words, no stems, no scores. The moment a rule here starts counting how
 * MANY words two topics share, the word list is back.
 *
 * EVERY VERDICT IS WRITTEN DOWN TWICE, including the ones that allow: in
 * `novelty_checks` as the sentence a person reads, and in `gate_verdicts` as the
 * judge's own word, reason and model. A gate that only recorded refusals cannot
 * be told apart from a gate that is not running, and a MODEL gate that recorded
 * nothing could not be told apart from one whose GPU has been down a week.
 */
import { configValue, db, now } from "../../db.ts";
import { judge } from "../../models/judge.ts";

export const SOCIALFEED_PLUGIN = "socialfeed";

/** How recently a topic must have been used for a repeat to be refused.
 *  Thirty days: long enough that a daily autopilot cannot loop, short enough
 *  that a quarterly re-make of a good subject is not blocked forever. */
export const DEFAULT_NOVELTY_DAYS = 30;

/** This gate's name in `gate_verdicts`. Stable and lowercase: it is what the
 *  owner greps when he wants to know why nothing was made last night. */
export const NOVELTY_GATE = "socialfeed.novelty";

/**
 * The two words the judge may answer with, and the only two.
 *
 * `repeat` is the refusal, `fresh` is the allow. Two rather than three on
 * purpose: a middle word ("maybe", "close") would have to be resolved into one
 * of these two by code, and that code is exactly where a tuned threshold would
 * quietly grow back.
 */
export const NOVELTY_WORDS = ["repeat", "fresh"] as const;
export type NoveltyWord = (typeof NOVELTY_WORDS)[number];

/** How many past entries the judge is shown. Forty is about a daily
 *  autopilot's month, which is the window it is being asked about; past that
 *  the context stops being "recently" and starts being a bill. */
const HISTORY_SHOWN = 40;

/** How much of each past topic goes into the context. A brief is a sentence or
 *  two; what comes after that is art direction, which is not the subject. */
const TOPIC_SHOWN = 220;

/**
 * THE QUESTION. It is the whole of the rule, which is why it is a constant a
 * person can read rather than a string assembled at the call site.
 *
 * IT STATES THE LEAN, because leaning is the caller's decision and never the
 * model's default. This gate refuses outright and before the money: wrong
 * towards `repeat` stops the owner's production and reports no error anywhere,
 * wrong towards `fresh` costs one duplicate video. The last paragraph is
 * load-bearing, not politeness.
 */
const QUESTION =
  "You are the novelty gate for a one-person company's social content. You are given ONE proposed " +
  "topic, and separately the list of what this business has already made recently in the same " +
  "format. Decide whether the proposal is THE SAME PIECE OF WORK as one of those entries.\n\n" +
  "`repeat` — it is the same piece of work: the same subject making the same point, however " +
  "differently it is worded. A rewording, a translation, a re-ordering or the same argument under a " +
  "new title is a repeat.\n" +
  "`fresh` — it is a different piece of work: a different subject, a different angle on a shared " +
  "subject, a different question answered, a real update, or a part two that says something the " +
  "earlier one did not. Sharing a topic AREA is not enough to be a repeat — a business talks about " +
  "its own product every week and those are not one video.\n\n" +
  "LEAN `fresh` WHEN IT IS GENUINELY UNCLEAR, and say so in `why`. A wrong `repeat` makes this " +
  "business produce NOTHING tonight and tells nobody it happened; a wrong `fresh` costs one " +
  "duplicate video. Answer `repeat` only when you can name the entry it repeats.";

/**
 * The exact-match form of a topic. A FACT, and deliberately nothing more.
 *
 * WHY THIS IS NOT THE OLD FINGERPRINT. It does not drop words, it does not stem
 * them, it does not sort them and it never produces a score. Two topics with
 * the same normalised text are one string written with different punctuation,
 * capitals or spacing — checkable, therefore code. Whether two DIFFERENT
 * strings are the same piece of work is a judgment, therefore the model's. If a
 * later edit starts comparing token overlap in here, it has rebuilt the word
 * list this file was converted to be rid of.
 *
 * IT IS UNICODE-AWARE, AND THAT IS NOT A NICETY — it was a measured outage in
 * the code this replaces. That normaliser stripped everything outside
 * `a-z0-9`, which does not mean "remove punctuation": it means REMOVE EVERY
 * LETTER THAT IS NOT ENGLISH. "Как обрабатывать повторяющиеся вопросы" and
 * "日本語のトピック" both came out as the empty string, and an empty string was
 * read as a refusal — so on any install whose model answers in a non-Latin
 * script the gate refused one hundred per cent of topics, forever, and blamed
 * the brief. Accented Latin was mangled rather than erased, which is worse in
 * its own way: "répétitives" became "titiv".
 *
 * The two steps are in this order on purpose. NFKD first, which splits "é" into
 * "e" plus a combining acute, then that one combining range is removed — so
 * "gérer" and "gerer" are one string, which is what somebody typing either of
 * them meant. Then `\p{L}\p{N}` under the `u` flag keeps every letter and digit
 * in every script and collapses only real punctuation and spacing.
 */
export function normalise(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    /* ONLY THE LATIN/GREEK/CYRILLIC DIACRITICS, by code point, and not every
       combining mark. `\p{M}` would also take Japanese dakuten, turning ピ into
       ヒ — a different sound and a different word. This range is the accents;
       the NFC below puts back together anything that was decomposed and not
       stripped. */
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
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

/* THERE IS NO `repeatLimit` SETTING ANY MORE, and removing it was half the
   point. It was the share of a new topic's stems that had to have been used
   before — a dial on a word list, which asked the owner to express "these two
   are the same video" as a number between 0.1 and 1. The judge answers that
   question in words instead, so there is nothing left to tune: the window below
   decides WHAT the judge is shown, and the judge decides. */

/* --------------------------------------------------------------- the rows */

export type HistoryRow = {
  id: number;
  venture_id: string;
  format: string;
  topic: string;
  /** `normalise(topic)` — the EXACT-match key, not a similarity fingerprint.
   *  See `normalise` and `reindex`. */
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
  /* THE COLUMN HOLDS THE EXACT-MATCH KEY. See `reindex` for what it used to
     hold and why every old row has to be rewritten before the cheap duplicate
     check below can see anything at all. */
  const fp = normalise(entry.topic);
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
  /** The candidate's exact-match key, `normalise(topic)`. Written down so a
   *  person reading the verdict list can see what was compared for EQUALITY —
   *  it is not what the model compared, which was the topics themselves. Empty
   *  on a source check, which compares ids. */
  fingerprint: string;
  /** The history row a refusal can point AT, and only where code knows which
   *  one it was: the exact-duplicate path and the source check. A model's
   *  refusal leaves this null and puts its sentence in `reason` — the judge
   *  answers one word and one clause, and turning its prose into a row id would
   *  be a guess with a foreign key on it. */
  matched: { id: number; topic: string; createdAt: string; score: number } | null;
};

/**
 * Decide, given rows. No database and no clock beyond `at` — but it DOES call a
 * model, which is the whole change: this is a judgment now and not arithmetic.
 *
 * SEPARATED FROM `checkTopic` FOR THE SAME REASON AS BEFORE. The rows come from
 * the caller, so every branch that does NOT need a model — no topic at all, the
 * window switched off, an empty history, an exact duplicate — is testable
 * without a database and without a provider, and those are the branches that
 * decide whether the gate is safe. The model's own similarity verdicts are not
 * asserted anywhere: a test pinning "exam prep with an AI tutor" to `repeat`
 * would be testing the model, would pass against a stub, and is exactly the
 * assertion that made the old stemmer look correct while it was not.
 *
 * THE ORDER OF THE CHECKS IS PART OF THE ANSWER. The free and factual ones run
 * first, so a model is only woken for the question a model is needed for.
 */
export async function judgeTopic(
  topic: string,
  history: Pick<HistoryRow, "id" | "topic" | "fingerprint" | "created_at">[],
  opts: { days: number; at?: Date; signal?: AbortSignal; ventureId?: string | null },
): Promise<Verdict> {
  const key = normalise(topic);
  /* A FACT AND NOT A JUDGMENT: there is no topic here. Punctuation and spaces
     are all that survived normalisation, so there is nothing for anybody —
     model or otherwise — to compare, and `deriveTopic` sent an empty brief. */
  if (!key)
    return {
      ok: false,
      reason:
        "There is no topic to compare: the brief is empty once punctuation and spacing are taken " +
        "off it, so nothing was generated.",
      fingerprint: key,
      matched: null,
    };

  /* A WINDOW OF ZERO DAYS SWITCHES THE TOPIC HALF OF THE GATE OFF. That is a
     real thing to want — a portfolio making one post a month has no repeats to
     prevent — and it is better expressed as a setting of 0 than as a checkbox
     somewhere else. No model is asked, because no question was asked. */
  if (opts.days <= 0)
    return {
      ok: true,
      reason: "The topic window is set to zero days, so topics are not compared at all.",
      fingerprint: key,
      matched: null,
    };

  const cutoff = (opts.at ?? new Date()).getTime() - opts.days * 86_400_000;
  const recent = history.filter((row) => {
    const when = Date.parse(row.created_at);
    /* An unparseable date is not counted. It cannot be placed in or out of the
       window, and inventing a position for it would be inventing a refusal. */
    return Number.isFinite(when) && when >= cutoff;
  });

  if (!recent.length)
    return {
      ok: true,
      reason: `Nothing has been made for this venture and format in the last ${opts.days} days, so there is nothing this could repeat.`,
      fingerprint: key,
      matched: null,
    };

  /* THE ONE CHECK THAT IS STILL CODE: character-for-character equality after
     normalisation. Two identical strings are the same topic — that is a fact,
     not a similarity score — and answering it here costs nothing and names the
     row it clashed with, which a model's one-clause answer cannot.

     THE STORED KEY FIRST, THE TOPIC AS THE TRUTH. The column is a cache of
     `normalise(topic)` and a box that has not restarted since this file changed
     still holds the OLD stem fingerprints (see `reindex`), which would match
     nothing at all. Re-normalising the row is a few microseconds over at most
     two hundred rows and it makes a stale cache impossible to miss. */
  const identical = recent.find((row) => row.fingerprint === key || normalise(row.topic) === key);
  if (identical)
    return {
      ok: false,
      reason:
        `This is word-for-word the topic used on ${identical.created_at.slice(0, 10)} for ` +
        `“${identical.topic.slice(0, 120)}”. Nothing was generated.`,
      fingerprint: key,
      matched: { id: identical.id, topic: identical.topic, createdAt: identical.created_at, score: 1 },
    };

  /* ONE CALL, CANDIDATE AS THE ITEM AND HISTORY AS THE CONTEXT. Not one call
     per history row: that would be forty round trips for one question, and a
     model shown one old topic at a time cannot see that three of them are the
     same subject — which is the thing a person doing this by eye notices first. */
  const result = await judge({
    gate: NOVELTY_GATE,
    question: QUESTION,
    items: [{ key: topic.replace(/\s+/g, " ").slice(0, 120), text: topic }],
    allowed: NOVELTY_WORDS,
    venture: opts.ventureId ?? null,
    context:
      `Already made for this business in this format in the last ${opts.days} days, newest first:\n` +
      recent
        .slice(0, HISTORY_SHOWN)
        .map(
          (row, i) =>
            `${i + 1}. ${row.created_at.slice(0, 10)} — ${row.topic.replace(/\s+/g, " ").slice(0, TOPIC_SHOWN)}`,
        )
        .join("\n"),
    signal: opts.signal,
  });

  const verdict = result.verdicts[0];
  const why = (verdict?.why ?? "").trim();
  const shown = Math.min(recent.length, HISTORY_SHOWN);

  if (verdict?.verdict === "repeat")
    return {
      ok: false,
      reason:
        `A model read this against the ${shown} piece${shown === 1 ? "" : "s"} of work from the last ` +
        `${opts.days} days and judged it the same piece of work` +
        `${why ? `: ${why}` : " as one of them"}. Nothing was generated.`,
      fingerprint: key,
      matched: null,
    };

  /* FAIL OPEN, AND VISIBLY. `unjudged` means no model answered — a busy GPU, a
     missing key, a reply that could not be read twice — and the generation goes
     AHEAD. The direction is deliberate and it is the whole reason the lean is
     stated: a gate that silently stopped the owner's autopilot because a GPU was
     warm costs a night of production and reports nothing, where letting this
     through costs at worst one duplicate video. The word `unjudged` is already
     in `gate_verdicts`, written by the judge itself, so this path is visible
     rather than looking identical to a gate that approves everything. */
  if (!verdict || verdict.verdict === "unjudged")
    return {
      ok: true,
      reason:
        `No model could judge this topic, so it was ALLOWED rather than refused` +
        `${result.why ? ` — ${result.why}` : ""}. The gate fails open on purpose: a duplicate video ` +
        `costs less than an autopilot that stops producing without saying why. Recorded as “unjudged”.`,
      fingerprint: key,
      matched: null,
    };

  return {
    ok: true,
    reason:
      `A model read this against the ${shown} piece${shown === 1 ? "" : "s"} of work from the last ` +
      `${opts.days} days and judged it a different piece of work${why ? `: ${why}` : ""}.`,
    fingerprint: key,
    matched: null,
  };
}

/**
 * Decide, and write the verdict down. This is what a caller about to spend
 * money calls, and it is ASYNC now because the decision is a model's.
 *
 * `signal` IS THE CALLER'S OWN CANCEL. A campaign that the owner cancels must
 * not leave this waiting on a judge; every caller here already holds one.
 */
export async function checkTopic(
  ventureId: string,
  format: string,
  topic: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Verdict> {
  const days = noveltyDays();
  /* LIVE ROWS ONLY. An archived entry is one the owner set aside precisely so
     its topic stops being refused; showing it to the judge would make archiving
     a button that does nothing. The row itself is still on every list. */
  const rows = db
    .prepare(
      "SELECT id, topic, fingerprint, created_at FROM content_history WHERE venture_id = ? AND format = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 200",
    )
    .all(ventureId, format) as unknown as Pick<HistoryRow, "id" | "topic" | "fingerprint" | "created_at">[];
  const verdict = await judgeTopic(topic, rows, { days, signal: opts.signal, ventureId });
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
    /* 1 ON AN EXACT DUPLICATE AND NULL EVERYWHERE ELSE. There is no similarity
       score any more, and writing one a model never computed would be putting a
       number on a judgment — which is what the column used to hold and what
       this conversion removed. */
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
 * Bring every stored key back into step with what the column now MEANS.
 *
 * WHY THIS EXISTS AT ALL. `content_history.fingerprint` is a CACHE of a pure
 * function of the topic, and that function has been replaced. It used to be a
 * similarity fingerprint — stop words dropped, inflections stemmed, tokens
 * de-duplicated and SORTED — and it is now `normalise`, which is the topic's own
 * words with punctuation and capitals taken off. An old row therefore holds a
 * string that the exact-duplicate check in `judgeTopic` can never equal: a topic
 * proposed word-for-word identically to one already made would sail past the one
 * check that is still code, and land on the model as if it were new.
 *
 * SO THE CONVERSION TO A MODEL GATE NEEDED EXACTLY THIS, AND NOTHING ELSE. The
 * verdicts themselves need no migration, because there is no stored similarity
 * score anywhere — the judge reads the topics as written. This is the whole of
 * the data change: rewrite the cached key.
 *
 * IT IS BELT AND BRACES, DELIBERATELY. `judgeTopic` also re-normalises each row
 * it is handed, so a box whose `onStart` threw before reaching this is still
 * correct — just slower by a few microseconds a row. The cache is kept because
 * `content_history_fp` indexes it and because the Sourcing page shows it, not
 * because the gate cannot live without it.
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
    const fresh = normalise(row.topic);
    if (fresh === row.fingerprint) continue;
    update.run(fresh, row.id);
    changed += 1;
  }
  return changed;
}
