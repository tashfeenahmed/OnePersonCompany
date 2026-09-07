/**
 * WHAT A COMPETITOR SWEEP REMEMBERS, AND WHAT COUNTS AS SOMETHING HAVING
 * CHANGED.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE MEMORY HALF OF THE COMPETITORS RUN, AND IT IS A LEAF ON PURPOSE.
 * No database, no session, no model — every function here takes what the last
 * sweep left behind and what tonight's sweep says, and returns the register as
 * it now stands. `competitors.ts` next door does the SQL and the two turns;
 * this file does the arithmetic, and it is separated because every rule in it
 * fails as a PLAUSIBLE WRONG ANSWER rather than as a crash. A change note that
 * fires on a synonym swap fills the table with badges nobody reads; one that
 * never fires makes the whole feature look like it is not running. Neither
 * throws, neither shows up in a log, and both are invisible until somebody
 * compares the table against the web by hand. So they are tested exactly, in
 * `competitorsMerge.test.ts`, against strings rather than against a schema.
 *
 * THE RULES ARE PORTED FROM WORKDASH'S COMPETITOR ANALYST, which has run this
 * merge nightly for a year, and they are ported rather than reinvented because
 * the calibration in them was paid for with real data. See `SAME_CLAIM` below
 * for the measurement that set it.
 *
 * THREE RULES, AND THE THIRD IS THE ONE THAT MAKES THE TABLE HONEST:
 *
 *   - A MATCH UPDATES, and records a `changes` entry only when the positioning
 *     or the pricing text ACTUALLY MOVED — see `WHAT COUNTS AS A CHANGE`. That
 *     entry is the sentence the whole report exists to be able to write.
 *   - A NEW DOMAIN arrives with `firstSeen` set to now, and never again.
 *   - A RIVAL TONIGHT'S SWEEP DID NOT MENTION IS KEPT, with its old
 *     `lastVerified` untouched. Deleting it would silently rewrite the market;
 *     the table can say "verified 34 days ago", which is the truth. Silence is
 *     not verification and it is not disappearance either.
 *
 * THE MERGE KEY IS THE DOMAIN, NOT THE NAME. A company renames its product far
 * more often than it moves house, and matching on the name files "Uptime Kuma"
 * and "Kuma" as two rivals with half a history each. The row is still STORED
 * under (venture, name) — that is the primary key the table has always had and
 * the one the owner's edits and the delete button address — so the domain is
 * the key for DECIDING WHAT IS WHAT, and the name is the key for writing it
 * down. Where the two disagree, `mergeRegistry` renames the stored row rather
 * than forking it.
 */

/* ------------------------------------------------------------- the shapes */

/** One recorded movement in a rival's story. `note` is the sentence the badge
 *  prints — "price moved, $9 -> $12" — and it is written here rather than in
 *  the client because the client cannot see the old value. */
export type Change = {
  /** ISO, this box's `now()`. */
  at: string;
  field: "positioning" | "pricing";
  from: string | null;
  to: string;
  note: string;
};

/** A rival as the table holds it, between sweeps. */
export type Known = {
  name: string;
  /** The normalised host. Null on a row recorded before this column existed
   *  and whose URL cannot be read — such a row can never be matched by domain
   *  and falls through to the name, which is the best that can be done for
   *  it. */
  domain: string | null;
  url: string | null;
  positioning: string | null;
  pricing: string | null;
  strengths: string[];
  weaknesses: string[];
  sources: string[];
  /** ISO. Moves ONLY when a sweep named this rival. */
  lastVerified: string;
  /** ISO. Never moves. */
  firstSeen: string;
  changes: Change[];
};

/** A rival as tonight's investigation turn described it. */
export type Found = {
  name: string;
  domain: string | null;
  url: string | null;
  positioning: string | null;
  pricing: string | null;
  strengths: string[];
  weaknesses: string[];
  sources: string[];
};

/** The whole of what the investigation turn is asked to return. */
export type Answer = {
  competitors: Found[];
  /** One entry per item of the PREVIOUS run's focus list: what was found, or
   *  that it could not be established. `note` carries either. */
  focusDone: { title: string; note: string }[];
  /** What the NEXT run should look at. */
  focusNext: { title: string; detail: string }[];
  /** Board-card suggestions, the same shape every other kind emits. Passed
   *  through unvalidated — `readCards` on the client is the judge of a card,
   *  and validating it twice would be two definitions of one. */
  cards: unknown[];
};

/* ------------------------------------------------------------- the domain */

/**
 * The host a URL names, folded to the form two sweeps written a month apart
 * will agree on: lower case, no scheme, no `www.`, no port, no path.
 *
 * IT ACCEPTS A BARE HOST TOO, because the investigation turn is asked for a
 * `domain` field and models write "klap.app" into it about as often as they
 * write "https://klap.app". Both are the same answer and rejecting one of them
 * would lose a rival over punctuation.
 *
 * WHAT IT WILL NOT DO IS GUESS. A string with no dot in it is not a host — it
 * is a product name somebody put in the wrong field — and it comes back null
 * rather than becoming a domain nothing can ever match.
 */
export function hostOf(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let host = raw;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    /* Not a URL by the platform's reading. Fall through to the plain fold —
       a hostname with a stray space or a trailing slash still reduces. */
    host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0] ?? "";
  }
  host = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "").trim();
  if (!host.includes(".") || /\s/.test(host)) return null;
  return host;
}

/* ------------------------------------------------- what counts as a change */

/**
 * WHAT COUNTS AS A CHANGE, and why it is not string equality.
 *
 * `positioning` and `pricing` are free prose that a model rewrites from
 * scratch on every sweep, so comparing the strings compares its word choice.
 * Workdash measured this over a week of real sweeps: 69 recorded changes, 40
 * of them with an identical set of numbers on both sides. A rival's pricing
 * "moved" because "50 executions/mo" became "50 executions/month"; another's
 * positioning "moved" because the sentence lost a leading "A". A third of the
 * table wore a badge, and the real moves — a price appearing where there had
 * been none — were indistinguishable from a synonym swap.
 *
 * So the two fields are compared on WHAT THEY ASSERT rather than on how they
 * say it: the money for pricing, the content words for positioning.
 */
const sameText = (a: string | null, b: string | null) =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

const CURRENCY_WORD: Record<string, string> = {
  usd: "$",
  dollars: "$",
  eur: "€",
  euros: "€",
  gbp: "£",
  pounds: "£",
};

/**
 * What a pricing line COSTS, normalised and sorted: money, percentages, and
 * whether it says free.
 *
 * BARE NUMBERS ARE DELIBERATELY LEFT OUT. "50 executions/mo", "500+ models"
 * and "4 free providers" are specifications, not prices, and they are the
 * churn — a model renumbers its own summary of a feature list every sweep and
 * the price has not moved. What a rival CHARGES is written with a currency on
 * it, and that is what this counts.
 *
 * "$0" and the word "free" collapse to one token, so "Free: $0, 25 models" and
 * "Free tier: 25 models" are one claim rather than two. "$1.5k" is $1500. A
 * percentage keeps its sign, so a 5.5% platform fee is not read as the number
 * 5.5.
 */
export function priceSignature(text: string | null): string[] {
  const s = String(text ?? "").toLowerCase();
  const out: string[] = [];
  for (const m of s.matchAll(
    /(?:([$€£])\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b|m\b)?)|(?:(\d[\d,]*(?:\.\d+)?)\s*(usd|eur|gbp|dollars|euros|pounds)\b)/g,
  )) {
    const currency = m[1] ?? CURRENCY_WORD[m[5] ?? ""] ?? "$";
    let n = Number(String(m[2] ?? m[4]).replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    if (m[3] === "k") n *= 1_000;
    if (m[3] === "m") n *= 1_000_000;
    out.push(n === 0 ? "free" : `${currency}${n}`);
  }
  if (/\bfree\b/.test(s)) out.push("free");
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) out.push(`${Number(m[1])}%`);
  return [...new Set(out)].sort();
}

/** The one sentence the badge wants: which numbers moved, and where to. Null
 *  when nothing did, which is the common case and the reason this exists. */
export function priceMove(before: string | null, after: string | null): string | null {
  const a = priceSignature(before);
  const b = priceSignature(after);
  if (a.join("|") === b.join("|")) return null;
  const gone = a.filter((t) => !b.includes(t));
  const came = b.filter((t) => !a.includes(t));
  if (!a.length) return `price published for the first time: ${came.join(", ")}`;
  if (!b.length) return `the published price is gone — it was ${gone.join(", ")}`;
  if (!gone.length) return `price gained ${came.join(", ")}`;
  if (!came.length) return `price dropped ${gone.join(", ")}`;
  return `price moved, ${gone.join(", ")} → ${came.join(", ")}`;
}

/** Articles, prepositions and the connective tissue a rewrite churns. What is
 *  left is what the sentence claims. */
const PROSE_STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "have",
  "in", "into", "is", "it", "its", "of", "on", "or", "own", "that", "the",
  "their", "them", "they", "this", "to", "up", "who", "with", "you", "your",
]);

/** A positioning line reduced to the words that carry its claim. */
function prosePart(text: string | null): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !PROSE_STOP.has(w));
}

/**
 * How much of two positioning lines' combined vocabulary they share, 0 to 1.
 * 1 is the same claim in different punctuation; below `SAME_CLAIM` it is a
 * different claim.
 */
export function proseOverlap(a: string | null, b: string | null): number {
  const A = new Set(prosePart(a));
  const B = new Set(prosePart(b));
  if (!A.size && !B.size) return 1;
  const shared = [...A].filter((w) => B.has(w)).length;
  return Number((shared / (A.size + B.size - shared)).toFixed(3));
}

/**
 * Below this share of shared words, the sentence is making a different claim
 * rather than making the same one differently.
 *
 * Calibrated by Workdash against a week of real sweeps. Above it sit the pairs
 * the badge was complained about — a rewrite whose whole change was losing a
 * leading "A", four more that moved no fact. Below it sit the real ones: a
 * rival going from a managed gateway to selling its own hardware, another from
 * observability to governance. Two fifths of the content words is a rewrite
 * the owner should read; less than that is the model choosing its adjectives
 * again.
 */
export const SAME_CLAIM = 0.6;

/** How many movements one rival keeps. Bounded because the row is rewritten
 *  whole on every sweep and an unbounded array grows for as long as the
 *  business does; twelve is more history than any badge ever shows and enough
 *  for the report's "what changed" section to reach back a year. */
export const CHANGES_CAP = 12;

/** How many source URLs one rival keeps. Tonight's pages first, then whatever
 *  was already on file — a rival read twice keeps both readings, and the
 *  newest is the one worth clicking. */
export const SOURCES_CAP = 6;

export function mergeSources(old: string[] | undefined, next: string[] | undefined): string[] {
  const out: string[] = [];
  for (const url of [...(next ?? []), ...(old ?? [])]) {
    if (typeof url !== "string" || !url || out.includes(url)) continue;
    out.push(url);
    if (out.length >= SOURCES_CAP) break;
  }
  return out;
}

/**
 * The movements one rival made between what was on file and what tonight says.
 *
 * AN EMPTY ANSWER IS "I DID NOT LOOK", NOT "IT WENT AWAY". Only a non-empty
 * value that differs is a change — and filling in a blank counts, because
 * learning a price for the first time is exactly what the owner wants to see.
 */
export function changesBetween(old: Known | null, found: Found, at: string): Change[] {
  const out: Change[] = [];
  for (const field of ["positioning", "pricing"] as const) {
    const next = found[field];
    if (!next) continue;
    const was = old?.[field] ?? null;
    if (sameText(next, was)) continue;
    const note = was
      ? field === "pricing"
        ? priceMove(was, next)
        : proseOverlap(was, next) < SAME_CLAIM
          ? `positioning rewritten — ${Math.round((1 - proseOverlap(was, next)) * 100)}% of its words are different`
          : null
      : `${field} recorded for the first time`;
    if (!note) continue;
    out.push({ at, field, from: was, to: next, note });
  }
  return out;
}

/** What one pass of the merge did, in the words the step line uses. */
export type MergeCounts = {
  /** Rivals tonight's sweep named that were already on file. */
  verified: number;
  /** Rivals tonight's sweep named that were not. */
  added: number;
  /** Of the verified ones, how many actually moved. */
  changed: number;
  /** On file, not mentioned tonight, and therefore left exactly as they were. */
  untouched: number;
};

/** A row tonight's sweep wrote. `previousName` is the name the row was STORED
 *  under before the merge, and it is here because the store's primary key is
 *  the name while the merge's key is the domain: a rival that renamed itself
 *  is one UPDATE addressed at the old name, not a second row. Absent on a row
 *  that is new or did not rename. */
export type Touched = Known & { previousName?: string };

export type MergeResult = {
  /** Every rival, merged — the ones tonight touched and the ones it did not.
   *  Newest verification first, which is the order the register reads in. */
  rows: Known[];
  /** Only the rows tonight's sweep actually wrote, so the caller knows which
   *  ones to UPDATE. A row nobody looked at must not be re-written, or its
   *  `lastVerified` becomes a lie the moment somebody adds a trigger. */
  touched: Touched[];
  counts: MergeCounts;
};

/**
 * Tonight's validated list, folded into everything already known.
 *
 * MATCHED BY DOMAIN FIRST, THEN BY FOLDED NAME. The domain is the real key —
 * see the file header — and the name is the fallback for the two cases it
 * cannot cover: a row recorded before the domain column existed, and a rival
 * whose URL the model could not produce. The name fold is EXACT once folded to
 * words, never fuzzy: "Uptime Kuma" and "Kuma" are not the same company and no
 * amount of string distance makes them one.
 *
 * A THIN ANSWER MUST NOT ERASE A GOOD ONE. Every field tonight left blank
 * keeps whatever was there; only what the sweep could actually see is
 * refreshed. That is the difference between a sweep that ran out of budget and
 * a sweep that found the rival gone, and this file cannot tell them apart — so
 * it assumes the first, which is the recoverable mistake.
 */
export function mergeRegistry(previous: Known[], found: Found[], at: string): MergeResult {
  const rows = previous.map((p) => ({ ...p }));
  const byDomain = new Map<string, Known>();
  const byName = new Map<string, Known>();
  for (const r of rows) {
    if (r.domain) byDomain.set(r.domain, r);
    byName.set(nameKey(r.name), r);
  }

  const touched: Touched[] = [];
  const counts: MergeCounts = { verified: 0, added: 0, changed: 0, untouched: 0 };
  /* TWO ENTRIES FOR ONE RIVAL IS ONE RIVAL. A sweep that read both the home
     page and the pricing page sometimes lists the company twice, and the
     second entry would otherwise re-merge the row it had just written and
     record a change against its own first pass. The first entry wins, because
     it is the one the model led with. */
  const consumed = new Set<Known>();

  for (const f of found) {
    const old = (f.domain ? byDomain.get(f.domain) : undefined) ?? byName.get(nameKey(f.name));
    if (old && consumed.has(old)) continue;

    if (!old) {
      const row: Known = {
        name: f.name,
        domain: f.domain,
        url: f.url,
        positioning: f.positioning,
        pricing: f.pricing,
        strengths: f.strengths,
        weaknesses: f.weaknesses,
        sources: mergeSources([], f.sources),
        lastVerified: at,
        firstSeen: at,
        /* NO "recorded for the first time" NOTES ON A NEW ROW. Everything
           about a rival nobody had heard of is new, and twelve changes saying
           so on the day it appears is noise standing where the first real
           movement should be. `firstSeen` already says it. */
        changes: [],
      };
      rows.push(row);
      if (row.domain) byDomain.set(row.domain, row);
      byName.set(nameKey(row.name), row);
      consumed.add(row);
      touched.push(row);
      counts.added++;
      continue;
    }
    consumed.add(old);

    const moved = changesBetween(old, f, at);
    if (moved.length) counts.changed++;
    counts.verified++;

    /* THE STORED NAME FOLLOWS THE DOMAIN. When a rival is matched by domain
       and has renamed itself, the row is renamed with it rather than forked —
       which is the whole reason the domain is the key. `previousName` travels
       out so the caller's UPDATE can find the row it is replacing. */
    const previousName = old.name;
    old.name = f.name || old.name;
    old.domain = f.domain ?? old.domain;
    old.url = f.url ?? old.url;
    old.positioning = f.positioning ?? old.positioning;
    old.pricing = f.pricing ?? old.pricing;
    old.strengths = f.strengths.length ? f.strengths : old.strengths;
    old.weaknesses = f.weaknesses.length ? f.weaknesses : old.weaknesses;
    old.sources = mergeSources(old.sources, f.sources);
    old.lastVerified = at;
    old.changes = [...old.changes, ...moved].slice(-CHANGES_CAP);
    touched.push({ ...old, previousName });
  }

  counts.untouched = rows.length - touched.length;
  rows.sort(
    (a, b) => (b.lastVerified < a.lastVerified ? -1 : b.lastVerified > a.lastVerified ? 1 : a.name.localeCompare(b.name)),
  );
  return { rows, touched, counts };
}

/** A name folded to the form two sweeps agree on. Words only, single-spaced —
 *  not the domain fold, which strips the spaces too and would make "copilot"
 *  match inside "copilotstudio". */
const nameKey = (s: string) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* ------------------------------------------------------------- the answer */

/**
 * THE INVESTIGATION TURN'S JSON, READ TOLERANTLY AND VALIDATED STRICTLY.
 *
 * TOLERANT ABOUT THE WRAPPING. A model asked for JSON and nothing else answers
 * with a fenced block about a third of the time, with a sentence in front of it
 * rather less often, and with both occasionally. All three are the same answer
 * dressed differently, so the object is dug out of any of them: a fence named
 * anything, or the first balanced `{…}` in the text.
 *
 * STRICT ABOUT THE CONTENTS. A rival with no name is dropped; a rival with no
 * https source is dropped and SAID SO — see `dropped`. Nothing is repaired,
 * nothing is filled in, and a field this cannot read comes back null rather
 * than as a plausible default. The whole point of the two-turn shape is that
 * the register is built from what the model actually retrieved, and a parser
 * that patched a missing URL would be inventing the evidence.
 *
 * THE SOURCE GATE IS THE HONESTY RULE MADE MECHANICAL. Workdash deletes any
 * rival whose domain appears in no tool result of the night; this box does not
 * hold the tool results in a form it can check against, so it does the
 * pragmatic version of the same rule: a rival the model cannot put ONE https
 * URL against is a rival it did not read a page about, and it does not reach
 * the table. The count of what that dropped goes on a step, so a sweep that
 * lost half its findings to it is visible rather than quiet.
 */
export function readAnswer(text: string): { answer: Answer; dropped: string[] } | null {
  const obj = readObject(text);
  if (!obj) return null;

  const str = (v: unknown, cap = 2_000): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : null;
  const list = (v: unknown, cap = 400, max = 12): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && Boolean(x.trim())).map((x) => x.trim().slice(0, cap)).slice(0, max)
      : [];

  const dropped: string[] = [];
  const competitors: Found[] = [];
  for (const item of Array.isArray(obj.competitors) ? obj.competitors : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const name = str(o.name, 120);
    if (!name) continue;
    const url = str(o.url, 500);
    /* HTTPS ONLY, and the `http:` case is not silently upgraded: a page the
       model read over plain http is still a page it read, but a URL this
       cannot verify the scheme of is one it should not be storing as evidence
       either. In practice every pricing page on the web is https, and the rule
       is worth more as a bright line than as a nuance. */
    const sources = mergeSources([], [...list(o.sources, 500, 8), ...(url ? [url] : [])].filter((u) => /^https:\/\//i.test(u)));
    if (!sources.length) {
      dropped.push(name);
      continue;
    }
    competitors.push({
      name,
      domain: hostOf(str(o.domain, 253)) ?? hostOf(url) ?? hostOf(sources[0] ?? null),
      url: url ?? sources[0] ?? null,
      positioning: str(o.positioning),
      pricing: str(o.pricing),
      strengths: list(o.strengths),
      weaknesses: list(o.weaknesses),
      sources,
    });
  }

  const focusDone: { title: string; note: string }[] = [];
  for (const item of Array.isArray(obj.focusDone) ? obj.focusDone : []) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = str(o.title, 300);
    if (!title) continue;
    /* A `focusDone` ENTRY WITH NO NOTE IS STILL AN ANSWER — it says the item
       was looked at — so the note falls back to a sentence saying exactly
       that, rather than the entry being dropped and the item left looking
       ignored. */
    focusDone.push({ title, note: str(o.note, 1_000) ?? "Looked at; nothing was written down about what was found." });
  }

  const focusNext: { title: string; detail: string }[] = [];
  for (const item of Array.isArray(obj.focusNext) ? obj.focusNext : []) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = str(o.title, 300);
    if (!title) continue;
    focusNext.push({ title, detail: str(o.detail, 1_000) ?? "" });
  }

  return {
    answer: { competitors, focusDone, focusNext, cards: Array.isArray(obj.cards) ? obj.cards : [] },
    dropped,
  };
}

/**
 * The JSON object in an answer, however it was wrapped.
 *
 * THE BRACE SCAN IS QUOTE-AWARE, which a regex is not. A positioning line
 * containing `}` — and they do, in "…{price} per seat" style marketing — would
 * end a lazy `\{[\s\S]*\}` match in the wrong place and lose everything after
 * it. So this counts braces, skips anything inside a string, and honours the
 * backslash escape.
 */
function readObject(text: string): Record<string, unknown> | null {
  const bodies: string[] = [];
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) if (m[1]) bodies.push(m[1]);
  bodies.push(text);

  for (const body of bodies) {
    const start = body.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < body.length; i++) {
      const ch = body[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        if (inString) escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth !== 0) continue;
        try {
          const v = JSON.parse(body.slice(start, i + 1)) as unknown;
          if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
        } catch {
          /* Not JSON after all — a prose paragraph with braces in it. Try the
             next candidate body rather than giving up on the answer. */
        }
        break;
      }
    }
  }
  return null;
}

/* --------------------------------------------------------------- the ages */

/** Whole days between two ISO instants, never negative. What "verified N days
 *  ago" counts, computed on the server so two clients cannot disagree about
 *  what day it is. */
export function daysSince(iso: string | null, from: Date = new Date()): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((from.getTime() - at) / 86_400_000));
}
