/**
 * TWO READINGS OF ONE URL, SUBTRACTED, AND ONE WORD FOR WHAT HAPPENED.
 *
 * PURE. No database, no clock, no network, no model — every function here
 * takes its numbers and returns its answer, which is what makes the rule table
 * assertable against fabricated figures rather than only against a fortnight
 * of waiting. Ported in shape from an earlier SEO baselines module whose nine
 * diagnoses and rule ordering were worked out against real properties;
 * the thresholds come with them rather than being re-derived here, because
 * re-deriving a tuned number is inventing a new one.
 *
 * THE LIST IS CLOSED AND THE MODEL DOES NOT GET TO EXTEND IT. `diagnose()`
 * below always runs and always produces a verdict; a model, when one is
 * configured, is asked to CHOOSE from the same closed list with the same
 * numbers in front of it, and its answer is accepted only if it is one of the
 * words and only if it comes with a sentence. Anything else falls back to the
 * table, and the row says which decided. Free text would have produced nine
 * spellings of "improve the page" inside a month.
 *
 * UNMEASURED IS A VERDICT AND IT IS NOT A ZERO. Rule 1 fires whenever either
 * side of the comparison was not measured — a page absent from a capped
 * report, a property that could not be asked, a URL Search Console has no row
 * for. There is no arithmetic on an unmeasured reading anywhere in this file.
 */

/** The nine diagnoses. Every one of them is a different NEXT ACTION; a tenth
 *  that shared an action with an existing one would be a synonym. */
export const DIAGNOSES = [
  /** Google is not showing the page at all, or we cannot tell that it is. */
  "discovery",
  /** The whole property moved the same way. This is not a page problem. */
  "demand",
  /** Shown, and not high enough for anyone to reach it. */
  "ranking",
  /** High enough, and the result does not earn the click. */
  "snippet",
  /** Shown for more things, none of which the page answers. */
  "intent",
  /** Mid-page and staying there: the page does not answer the query. */
  "content",
  /** Search has done its part; what is left is after the click. */
  "conversion",
  /** Ranking, being read, not clicked — an answer box, from here. */
  "cited-no-clicks",
  /** It moved the right way. Do nothing yet. */
  "wait",
] as const;
export type Diagnosis = (typeof DIAGNOSES)[number];

export type Verdict = "up" | "down" | "flat" | "thin" | "unmeasured";

/** EXACTLY ONE next action per diagnosis. A sentence per diagnosis rather than
 *  per page, because the numbers are already on the row and what the row
 *  cannot say is what to do. */
export const NEXT_ACTION: Record<Diagnosis, string> = {
  discovery:
    "Ask Google to index the URL once through URL Inspection, then link to it from the page on this site with the most impressions.",
  demand:
    "Leave the page alone — the whole property moved with it. Pick a query that has recorded impressions instead.",
  ranking:
    "Add depth on the query it already ranks for, and link to it internally from the two pages with the most impressions.",
  snippet:
    "Rewrite the title and meta description around the query it is actually shown for, then re-measure at the next window.",
  intent:
    "Narrow the H1 and the opening paragraph to the one question this page answers, and cut the sections pulling in the other impressions.",
  content:
    "Answer the query outright: one direct answer in the first 160 characters, then the detail underneath it.",
  conversion:
    "Search has done its part on this one. The next gain is on the page after the click, not in the result.",
  "cited-no-clicks":
    "Put something on the page an answer box cannot carry — a table, a calculator, a file to download — and link to it from the first screen.",
  wait: "It moved. Leave it, re-measure at the next window, then make the same change on the next page down the list.",
};

/**
 * The band inside which a change is not a change.
 *
 * TEN PERCENT, deliberately the same number as chief/outcomes.ts's
 * FLAT_BAND_PCT: two features on one box that both answer "did this move" and
 * disagree about what moving means are two features nobody trusts.
 */
export const FLAT_BAND_PCT = 10;

/**
 * Below this many impressions before the change, the comparison is `thin`.
 *
 * Thirty impressions over 28 days is one a day. A percentage change on that is
 * arithmetic on a rounding error dressed up as a finding.
 */
export const MIN_BASELINE_IMPRESSIONS = 30;

/** What a reading looks like to this file. Deliberately smaller than the
 *  stored row: the maths needs five numbers and a flag, and a function that
 *  took the whole row could not be called with a fabricated one in a test. */
export type Side = {
  measured: boolean;
  clicks: number | null;
  impressions: number | null;
  /** A percentage. */
  ctr: number | null;
  position: number | null;
  siteImpressions: number | null;
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** A percentage change, or null when the base is nothing. Zero to fifty is not
 *  an infinite improvement; it is a delta with no percentage. */
export function pct(after: number | null, before: number | null): number | null {
  const a = num(after);
  const b = num(before);
  if (a === null || b === null || b === 0) return null;
  return Number((((a - b) / b) * 100).toFixed(1));
}

/**
 * Roughly what a click-through rate looks like at a given position, as a
 * PERCENT.
 *
 * Coarse on purpose. It is used for exactly one thing — telling "ranks and is
 * not clicked" apart from "ranks and is clicked about as much as anything
 * there" — and a finer curve would be a claim about click behaviour on small
 * sites that nobody here has measured.
 */
export function expectedCtr(position: number | null): number | null {
  const p = num(position);
  if (p === null) return null;
  if (p <= 1.5) return 25;
  if (p <= 2.5) return 15;
  if (p <= 3.5) return 10;
  if (p <= 5.5) return 6;
  if (p <= 10.5) return 3;
  if (p <= 20.5) return 1;
  return 0.5;
}

export type Deltas = {
  clicks: number | null;
  clicksPct: number | null;
  impressions: number | null;
  impressionsPct: number | null;
  ctr: number | null;
  /** After minus before. NEGATIVE IS AN IMPROVEMENT — position is a rank. */
  position: number | null;
  siteImpressionsPct: number | null;
};

/**
 * THE ARITHMETIC, ON ITS OWN.
 *
 * Split out from the verdict so that "are the subtractions right" and "is the
 * rule table right" are two questions with two tests. Every field is null
 * whenever either side of it was not measured; nothing here substitutes a zero
 * for an absence, and `position` is a rank so its delta is deliberately not
 * flipped into a "better/worse" sign here — the rules read it knowing that.
 */
export function deltas(before: Side, after: Side): Deltas {
  const both = before.measured && after.measured;
  return {
    clicks: both && num(after.clicks) !== null && num(before.clicks) !== null
      ? after.clicks! - before.clicks!
      : null,
    clicksPct: both ? pct(after.clicks, before.clicks) : null,
    impressions:
      both && num(after.impressions) !== null && num(before.impressions) !== null
        ? after.impressions! - before.impressions!
        : null,
    impressionsPct: both ? pct(after.impressions, before.impressions) : null,
    ctr:
      both && num(after.ctr) !== null && num(before.ctr) !== null
        ? Number((after.ctr! - before.ctr!).toFixed(2))
        : null,
    position:
      both && num(after.position) !== null && num(before.position) !== null
        ? Number((after.position! - before.position!).toFixed(1))
        : null,
    siteImpressionsPct: both ? pct(after.siteImpressions, before.siteImpressions) : null,
  };
}

type Ctx = {
  before: Side;
  after: Side;
  d: Deltas;
  band: number;
};

/**
 * THE RULE TABLE. First match wins; every rule names the digits it reads.
 *
 *  1  unmeasured    either side was not measured. NO arithmetic is done.
 *  2  thin          the before window carried fewer than 30 impressions
 *  3  up/conversion clicks up, already top three, clicked at least as much as
 *                   that position normally is — search is finished here
 *  4  up/wait       clicks up beyond the band, anything else
 *  5  down/demand   impressions down beyond the band AND the property down
 *                   beyond the band — not a page problem
 *  6  down/ranking  impressions down beyond the band, property did not move
 *  7  flat/intent   impressions up by more than twice the band, clicks flat,
 *                   position unchanged — shown for more, wanted for none
 *  8  flat/snippet  impressions up, clicks flat, sitting on page one
 *  9  flat/ranking  impressions up, clicks flat, not on page one
 * 10  down/snippet  clicks down beyond the band from page one
 * 11  down/ranking  clicks down beyond the band from below page one
 * 12  flat/cited-no-clicks  nothing moved, top three, clicked well under the
 *                   rate that position normally earns
 * 13  flat/snippet  nothing moved, page one
 * 14  flat/content  nothing moved, page two
 * 15  flat/discovery nothing moved, below page two
 *
 * `conversion` is reachable only through rule 3, and that is deliberate:
 * nothing in Search Console can see past the click, so the only honest way to
 * say "the remaining problem is after the click" is to first prove the search
 * half is done.
 */
const RULES: { id: number; when: (c: Ctx) => boolean; verdict: Verdict; diagnosis: Diagnosis }[] = [
  { id: 1, when: (c) => !c.before.measured || !c.after.measured, verdict: "unmeasured", diagnosis: "discovery" },
  {
    id: 2,
    when: (c) => (c.before.impressions ?? 0) < MIN_BASELINE_IMPRESSIONS,
    verdict: "thin",
    diagnosis: "demand",
  },
  {
    id: 3,
    when: (c) =>
      c.d.clicksPct !== null &&
      c.d.clicksPct > c.band &&
      num(c.after.position) !== null &&
      c.after.position! <= 3.5 &&
      num(c.after.ctr) !== null &&
      c.after.ctr! >= (expectedCtr(c.after.position) ?? Number.POSITIVE_INFINITY),
    verdict: "up",
    diagnosis: "conversion",
  },
  { id: 4, when: (c) => c.d.clicksPct !== null && c.d.clicksPct > c.band, verdict: "up", diagnosis: "wait" },
  {
    id: 5,
    when: (c) =>
      c.d.impressionsPct !== null &&
      c.d.impressionsPct < -c.band &&
      c.d.siteImpressionsPct !== null &&
      c.d.siteImpressionsPct < -c.band,
    verdict: "down",
    diagnosis: "demand",
  },
  {
    id: 6,
    when: (c) => c.d.impressionsPct !== null && c.d.impressionsPct < -c.band,
    verdict: "down",
    diagnosis: "ranking",
  },
  {
    id: 7,
    when: (c) =>
      c.d.impressionsPct !== null &&
      c.d.impressionsPct > 2 * c.band &&
      c.d.clicksPct !== null &&
      c.d.clicksPct <= c.band &&
      c.d.position !== null &&
      Math.abs(c.d.position) <= 1,
    verdict: "flat",
    diagnosis: "intent",
  },
  {
    id: 8,
    when: (c) =>
      c.d.impressionsPct !== null &&
      c.d.impressionsPct > c.band &&
      c.d.clicksPct !== null &&
      c.d.clicksPct <= c.band &&
      num(c.after.position) !== null &&
      c.after.position! <= 10.5,
    verdict: "flat",
    diagnosis: "snippet",
  },
  {
    id: 9,
    when: (c) =>
      c.d.impressionsPct !== null &&
      c.d.impressionsPct > c.band &&
      c.d.clicksPct !== null &&
      c.d.clicksPct <= c.band,
    verdict: "flat",
    diagnosis: "ranking",
  },
  {
    id: 10,
    when: (c) =>
      c.d.clicksPct !== null &&
      c.d.clicksPct < -c.band &&
      num(c.after.position) !== null &&
      c.after.position! <= 10.5,
    verdict: "down",
    diagnosis: "snippet",
  },
  { id: 11, when: (c) => c.d.clicksPct !== null && c.d.clicksPct < -c.band, verdict: "down", diagnosis: "ranking" },
  {
    id: 12,
    when: (c) =>
      num(c.after.position) !== null &&
      c.after.position! <= 3.5 &&
      num(c.after.ctr) !== null &&
      c.after.ctr! < (expectedCtr(c.after.position) ?? 0) / 2,
    verdict: "flat",
    diagnosis: "cited-no-clicks",
  },
  {
    id: 13,
    when: (c) => num(c.after.position) !== null && c.after.position! <= 10.5,
    verdict: "flat",
    diagnosis: "snippet",
  },
  {
    id: 14,
    when: (c) => num(c.after.position) !== null && c.after.position! <= 20.5,
    verdict: "flat",
    diagnosis: "content",
  },
  { id: 15, when: () => true, verdict: "flat", diagnosis: "discovery" },
];

export type Judgement = {
  verdict: Verdict;
  diagnosis: Diagnosis;
  rule: number;
  next: string;
  delta: Deltas;
};

/**
 * One before/after pair to one word.
 *
 * A rule that THROWS on a shape it did not expect is a rule that did not
 * match, and the table ends with a total fallback, so nothing is lost and this
 * function cannot fail.
 */
export function diagnose(before: Side, after: Side): Judgement {
  const d = deltas(before, after);
  const c: Ctx = { before, after, d, band: FLAT_BAND_PCT };
  for (const rule of RULES) {
    let hit = false;
    try {
      hit = Boolean(rule.when(c));
    } catch {
      hit = false;
    }
    if (!hit) continue;
    return { verdict: rule.verdict, diagnosis: rule.diagnosis, rule: rule.id, next: NEXT_ACTION[rule.diagnosis], delta: d };
  }
  /* Unreachable — rule 15 matches everything — and written anyway, because a
     table somebody edits later must not be able to return undefined. */
  return { verdict: "unmeasured", diagnosis: "discovery", rule: 0, next: NEXT_ACTION.discovery, delta: d };
}

/* ------------------------------------------------------- the model's turn */

/**
 * THE MODEL'S ANSWER, VALIDATED THE SAME WAY THE VISION ONE IS.
 *
 * `{ "diagnosis": <one of the nine>, "why": "<one sentence about the numbers>" }`
 * and nothing else. Both fields are required: a word with no reasoning is the
 * table's job and the table is free, so a model that adds nothing is not
 * accepted in its place. A `why` that mentions no digit is rejected too —
 * the one failure mode worth spending a check on is a model that restates the
 * verdict instead of pointing at what produced it.
 */
export type ModelJudgement = { diagnosis: Diagnosis; why: string } | { unreadable: string };

const MAX_WHY = 320;
const MIN_WHY = 20;

export function validateModelDiagnosis(raw: unknown): ModelJudgement {
  let doc: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    /* The first balanced-looking object in the answer. A model that wrapped
       its JSON in a sentence has still answered; a model that wrote a
       paragraph with no object in it has not. */
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return { unreadable: "the answer carried no JSON object" };
    try {
      doc = JSON.parse(text.slice(start, end + 1));
    } catch {
      return { unreadable: "the answer's JSON would not parse" };
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return { unreadable: "the answer was not a JSON object" };

  const obj = doc as Record<string, unknown>;
  const word = typeof obj.diagnosis === "string" ? obj.diagnosis.trim().toLowerCase() : "";
  if (!DIAGNOSES.includes(word as Diagnosis))
    return {
      unreadable: `it answered "${String(obj.diagnosis ?? "nothing").slice(0, 40)}" where the only diagnoses are ${DIAGNOSES.join(", ")}`,
    };

  const why = typeof obj.why === "string" ? obj.why.replace(/\s+/g, " ").trim() : "";
  if (why.length < MIN_WHY) return { unreadable: "it chose a diagnosis and said nothing about the numbers" };
  if (!/\d/.test(why)) return { unreadable: "its reasoning quotes no figure, so nothing in it can be checked" };

  return { diagnosis: word as Diagnosis, why: why.slice(0, MAX_WHY) };
}

/** The numbers, as the model is shown them. Written here rather than in the
 *  caller so that what the model saw and what the table read are provably the
 *  same figures. */
export function promptFacts(url: string, days: number, before: Side, after: Side, d: Deltas): string {
  const n = (v: number | null, unit = "") => (v === null ? "not measured" : `${v}${unit}`);
  return [
    `URL: ${url}`,
    `Window: ${days} days, measured twice — once when the work was marked done, once now.`,
    `BEFORE  clicks ${n(before.clicks)}, impressions ${n(before.impressions)}, ctr ${n(before.ctr, "%")}, average position ${n(before.position)}, whole-property impressions ${n(before.siteImpressions)}`,
    `AFTER   clicks ${n(after.clicks)}, impressions ${n(after.impressions)}, ctr ${n(after.ctr, "%")}, average position ${n(after.position)}, whole-property impressions ${n(after.siteImpressions)}`,
    `DELTA   clicks ${n(d.clicks)} (${n(d.clicksPct, "%")}), impressions ${n(d.impressions)} (${n(d.impressionsPct, "%")}), ctr ${n(d.ctr, " points")}, position ${n(d.position)} (negative is better), property impressions ${n(d.siteImpressionsPct, "%")}`,
  ].join("\n");
}

export const MODEL_SYSTEM =
  "You are given Search Console figures for ONE page before and after a change, " +
  "and you choose ONE diagnosis from a closed list. You have nothing else: no " +
  "traffic beyond these figures, no revenue, no source code, no knowledge of what " +
  "the page says.\n\n" +
  "RULES\n" +
  "1. A figure reported as `not measured` is NOT zero. It means Search Console " +
  "was asked and had no row, or could not be asked. Never treat it as a fall to " +
  "nothing, and never compute a change from it.\n" +
  "2. Average position is a RANK: a negative delta is an improvement.\n" +
  "3. Quote at least one of the figures you were given in your reasoning. Never " +
  "write a number you were not given.\n" +
  "4. If the whole property moved the same way as the page, the diagnosis is " +
  "`demand` — that is not a page problem.\n" +
  `5. The only diagnoses are: ${DIAGNOSES.join(", ")}. Anything else is thrown away whole.\n\n` +
  'Answer with JSON and nothing else: {"diagnosis":"ranking","why":"one sentence quoting the figures"}';
