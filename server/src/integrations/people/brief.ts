import { workflowOwns } from "../pipeline/workflow-store.ts";
/**
 * THE WEEKLY RELATIONS BRIEF — who you have stopped writing to, who went
 * quiet, and who is new.
 *
 * TWO HALVES, AND THEY ARE NEVER MIXED. The SKELETON is arithmetic done in
 * plain TypeScript out of people_contacts and people_days: counts, the diff
 * against last week's temperatures, and the widest breaks. The PROSE is one
 * completion which is handed that arithmetic and NOTHING ELSE, and which is
 * thrown away whole if a validator finds a number, an address or a name in it
 * that the arithmetic does not carry. A refused paragraph is not repaired —
 * the brief is then the skeleton, which is a real brief and says so. This is
 * the same discipline the system this replaces used for its own relations
 * brief, and it is the reason the feature is allowed to use a model at all.
 *
 * IDEMPOTENT PER ISO WEEK, AND THE WEEK IS THE PRIMARY KEY. The timer fires at
 * boot and every six hours; the second run of a week finds a row and does
 * nothing. A brief that rewrote itself every six hours would be a different
 * account of the same week every time anybody looked, which is not a record.
 *
 * THE DIFF IS AGAINST LAST WEEK'S STORED SNAPSHOT, not against anything inside
 * today's tables. Each brief stores the temperature of every contact as it
 * stood when it was written, and the next one compares against that. Without
 * it, "who cooled this week" has no this-week to be measured against — and a
 * missing snapshot must never be read as "everybody cooled", so the first
 * brief of an install says in words that it has nothing to compare with.
 *
 * WHAT IT STRUCTURALLY CANNOT SAY. Every figure below is a count or a date off
 * a mail header. Nothing in this box knows what any of these people talked
 * about — there is no subject, snippet or body anywhere in the tables — so the
 * brief may not say why anybody went quiet, and the model is told so in the
 * same words that go on the page.
 */
import { complete } from "../../models/provider.ts";
import { db, now } from "../../db.ts";
import {
  COOLING_RATIO,
  MIN_QUIET_DAYS,
  people,
  settings,
  type Person,
  type Temperature,
} from "./contacts.ts";

/** A paragraph that names fourteen people names nobody. */
const MAX_NAMED = 6;
/** The model gets 400 tokens because the job is one paragraph. */
const MAX_TOKENS_HINT = "3 to 5 sentences";

/* ------------------------------------------------------------------ the week */

/**
 * The ISO-8601 week a moment falls in — "2026-W36", Monday-based.
 *
 * Written out rather than approximated with a division, because the naive
 * `floor(daysSinceEpoch / 7)` disagrees with every calendar a person owns
 * about four weeks a year, and the disagreement is invisible until a brief is
 * filed under a week that has not started.
 */
export function isoWeek(at: Date = new Date()): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  /* Thursday decides the year: ISO weeks belong to whichever year holds their
     Thursday, which is why the last days of December can be week 1. */
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/* --------------------------------------------------------------- the rows */

export type BriefRow = {
  week: string;
  written_at: string;
  model: string | null;
  markdown: string | null;
  figures: string;
  error: string | null;
};

export function briefRow(week?: string): BriefRow | undefined {
  return (
    week
      ? db.prepare("SELECT * FROM people_briefs WHERE week = ?").get(week)
      : db.prepare("SELECT * FROM people_briefs ORDER BY week DESC LIMIT 1").get()
  ) as BriefRow | undefined;
}

export function briefWeeks(limit = 12): { week: string; written_at: string }[] {
  return db
    .prepare("SELECT week, written_at FROM people_briefs ORDER BY week DESC LIMIT ?")
    .all(limit) as unknown as { week: string; written_at: string }[];
}

/** The brief written before `week`, whatever week that was. Gaps are ordinary
 *  — a laptop shut for a fortnight writes one brief when it wakes — so the
 *  comparison is against the last one that exists, and how long ago it was is
 *  published beside the diff. */
function previousBrief(week: string): BriefRow | undefined {
  return db.prepare("SELECT * FROM people_briefs WHERE week < ? ORDER BY week DESC LIMIT 1").get(
    week,
  ) as BriefRow | undefined;
}

/* ------------------------------------------------------------- the skeleton */

type Named = {
  address: string;
  name: string | null;
  cadenceDays: number | null;
  quietDays: number | null;
  daysSinceSent: number | null;
  daysSinceReceived: number | null;
  was?: Temperature;
  now?: Temperature;
  ratio?: number | null;
};

export type Figures = {
  week: string;
  computedAt: string;
  windowDays: number;
  staleDays: number;
  minEachWay: number;
  mailboxes: string[];
  counts: { tracked: number; warm: number; cooling: number; cold: number; noRhythm: number; stale: number };
  previousBriefWeek: string | null;
  daysSincePreviousBrief: number | null;
  firstBrief: boolean;
  stoppedWritingTo: Named[];
  wentQuiet: Named[];
  newlyTracked: Named[];
  widestBreaks: Named[];
  /** Every tracked contact's temperature as it stands now. Not shown; it is
   *  what NEXT week's brief diffs against. */
  temps: Record<string, Temperature>;
  cannotSay: string;
};

const named = (p: Person): Named => ({
  address: p.address,
  name: p.name,
  cadenceDays: p.cadenceDays,
  quietDays: p.quietDays,
  daysSinceSent: p.daysSinceSent,
  daysSinceReceived: p.daysSinceReceived,
});

const RANK: Record<string, number> = { warm: 0, cooling: 1, cold: 2 };
/** `null` has no rank. "No rhythm yet" is the absence of a measurement, not a
 *  temperature between two others, and giving it a number is how it ends up
 *  reported as a change. */
const rank = (t: Temperature) => (t && t in RANK ? RANK[t]! : null);

export function buildFigures(week: string, at = Date.now()): Figures {
  const s = settings();
  const all = people(at);
  /* THE BRIEF IS ABOUT CORRESPONDENCES, so it reads only contacts that met the
     minimum each way. A brief that counted every address that ever sent a
     receipt would be a brief about a mailbox rather than about people. */
  const tracked = all.filter((p) => p.mutual);

  const counts = {
    tracked: tracked.length,
    warm: tracked.filter((p) => p.temperature === "warm").length,
    cooling: tracked.filter((p) => p.temperature === "cooling").length,
    cold: tracked.filter((p) => p.temperature === "cold").length,
    noRhythm: tracked.filter((p) => p.temperature === null).length,
    stale: tracked.filter((p) => p.stale).length,
  };

  const previous = previousBrief(week);
  let previousTemps: Record<string, Temperature> = {};
  try {
    previousTemps = previous ? ((JSON.parse(previous.figures) as Figures).temps ?? {}) : {};
  } catch {
    /* A figures column that will not parse is a brief from a version that
       stored something else. It is not a reason to fail this week's. */
    previousTemps = {};
  }
  const hasPrevious = Object.keys(previousTemps).length > 0;

  /*
    WHO HE HAS STOPPED WRITING TO — the one bucket that is about HIS half of
    the correspondence, and the reason the sent scan gets its own budget.

    The test is: they wrote more recently than he did, and his own silence is
    past 1.75× the pair's usual gap (and at least a week, so a daily
    correspondence is not reported as broken after two days). A contact with no
    measurable rhythm is not in this list at all — no rhythm, no claim.
  */
  const stoppedWritingTo = tracked
    .filter(
      (p) =>
        p.cadenceDays !== null &&
        p.daysSinceSent !== null &&
        p.daysSinceReceived !== null &&
        p.daysSinceSent > p.daysSinceReceived &&
        p.daysSinceSent >= Math.max(MIN_QUIET_DAYS, COOLING_RATIO * p.cadenceDays),
    )
    .sort(
      (a, b) =>
        (b.daysSinceSent ?? 0) / Math.max(b.cadenceDays ?? 1, 1) -
        (a.daysSinceSent ?? 0) / Math.max(a.cadenceDays ?? 1, 1),
    )
    .slice(0, MAX_NAMED)
    .map(named);

  /*
    WHO WENT QUIET — a CHANGE where there is a previous brief to change from,
    and a STATE where there is not. The two are different claims and the
    document says which one it is making: `firstBrief: true` means nobody
    "cooled this week", because there is no last week here.
  */
  const wentQuiet = hasPrevious
    ? tracked
        .filter((p) => {
          const a = rank(previousTemps[p.address] ?? null);
          const b = rank(p.temperature);
          return a !== null && b !== null && b > a;
        })
        .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
        .slice(0, MAX_NAMED)
        .map((p) => ({
          ...named(p),
          was: previousTemps[p.address] ?? null,
          now: p.temperature,
          ratio: p.ratio,
        }))
    : tracked
        .filter((p) => p.temperature === "cooling" || p.temperature === "cold")
        .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
        .slice(0, MAX_NAMED)
        .map((p) => ({ ...named(p), now: p.temperature, ratio: p.ratio }));

  /*
    WHO IS NEW. Against a previous brief that is an address it had never seen;
    on a first brief it is a first message inside the last seven days, which is
    the only reading of "new" available with nothing to compare against.
  */
  const weekAgo = at - 7 * 86_400_000;
  const newlyTracked = (
    hasPrevious
      ? tracked.filter((p) => !(p.address in previousTemps))
      : tracked.filter((p) => p.firstSeen !== null && Date.parse(p.firstSeen) >= weekAgo)
  )
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_NAMED)
    .map(named);

  const widestBreaks = tracked
    .filter((p) => p.temperature === "cooling" || p.temperature === "cold")
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
    .slice(0, MAX_NAMED)
    .map((p) => ({ ...named(p), now: p.temperature, ratio: p.ratio }));

  const temps: Record<string, Temperature> = {};
  for (const p of tracked) temps[p.address] = p.temperature;

  return {
    week,
    computedAt: new Date(at).toISOString(),
    windowDays: s.windowDays,
    staleDays: s.staleDays,
    minEachWay: s.minEachWay,
    mailboxes: [...new Set(all.map((p) => p.mailbox))].sort(),
    counts,
    previousBriefWeek: previous?.week ?? null,
    daysSincePreviousBrief: previous
      ? Math.max(0, Math.round((at - Date.parse(previous.written_at)) / 86_400_000))
      : null,
    firstBrief: !hasPrevious,
    stoppedWritingTo,
    wentQuiet,
    newlyTracked,
    widestBreaks,
    temps,
    cannotSay:
      "This document is mail METADATA only — addresses, display names, counts " +
      "and timestamps. There is no subject line, snippet or message body " +
      "anywhere in it, so nothing here can say what any of these people talked " +
      "about, why a correspondence went quiet, or whether either side meant " +
      "anything by it.",
  };
}

/* ---------------------------------------------------- the skeleton, in words */

const who = (n: Named) => n.name ?? n.address;

/** The sentences the owner would read if no model existed. They are also what
 *  the model is shown, so that a paragraph it writes is a rephrasing of these
 *  and not an addition to them. */
export function skeletonLines(f: Figures): string[] {
  const out: string[] = [];
  out.push(
    `${f.counts.tracked} correspondences tracked over the last ${f.windowDays} days ` +
      `(at least ${f.minEachWay} messages each way): ${f.counts.warm} warm, ` +
      `${f.counts.cooling} cooling, ${f.counts.cold} cold, ` +
      `${f.counts.noRhythm} with no measurable rhythm yet.`,
  );
  if (f.firstBrief)
    out.push(
      "First brief — there is no previous one to compare against, so nobody is " +
        "reported as newly cooled. Next week's brief can say what changed.",
    );

  if (f.stoppedWritingTo.length)
    out.push(
      `Written to you more recently than you wrote to them: ` +
        f.stoppedWritingTo
          .map(
            (n) =>
              `${who(n)} (you last wrote ${n.daysSinceSent} days ago, they wrote ${n.daysSinceReceived} days ago; usual gap about ${n.cadenceDays} days)`,
          )
          .join("; ") +
        ".",
    );
  else out.push("Nobody is waiting on a reply that is past their usual gap.");

  if (f.wentQuiet.length)
    out.push(
      (f.firstBrief
        ? "Cooling or cold right now: "
        : `Cooled since the last brief${f.daysSincePreviousBrief === null ? "" : ` (${f.daysSincePreviousBrief} days ago)`}: `) +
        f.wentQuiet
          .map((n) => `${who(n)} (${n.was ? `${n.was} → ` : ""}${n.now}, ${n.quietDays} days quiet)`)
          .join("; ") +
        ".",
    );
  else out.push("Nobody crossed into cooling since the last brief.");

  if (f.newlyTracked.length)
    out.push(
      `New to this document: ` +
        f.newlyTracked.map((n) => `${who(n)} (${n.address})`).join("; ") +
        ".",
    );

  if (f.widestBreaks.length)
    out.push(
      `Widest breaks against their own rhythm: ` +
        f.widestBreaks
          .slice(0, 3)
          .map((n) => `${who(n)} — ${n.quietDays} days against a usual ${n.cadenceDays}`)
          .join("; ") +
        ".",
    );
  return out;
}

/* ---------------------------------------------------------- the validator */

/**
 * Would this paragraph put something on the page the arithmetic does not
 * carry?
 *
 * THREE GATES, all deterministic, all erring towards refusal. A false refusal
 * costs the paragraph and leaves a skeleton-only brief, which is a true brief.
 * A false acceptance puts a person who does not exist into a document about
 * real relationships. The trade is not close.
 *
 *   NUMBERS   every run of digits must appear in the facts.
 *   ADDRESSES every @-token must appear in the facts.
 *   NAMES     every capitalised word must appear in the facts or be an
 *             ordinary English word from the short list below.
 *
 * The name gate is narrower than the previous system's 450-word vocabulary and
 * will refuse more often. That is the safe direction, and the refusal is
 * reported rather than hidden.
 */
/*
  THE ORDINARY-ENGLISH LIST, AND WHY IT IS LONGER THAN IT LOOKS LIKE IT NEEDS
  TO BE.

  The name gate refuses any capitalised word the figures do not carry, and
  English capitalises the first word of every sentence — so "Currently", "Both"
  and "Overall" are all indistinguishable from an invented person unless they
  are written down here. The first live brief was refused for exactly that
  ("Currently"), which is the gate working and the vocabulary being too short.
  It still errs towards refusing: a word missing from this list costs a
  paragraph and leaves a skeleton-only brief, which is a true brief, whereas a
  gap in the other direction puts a person who does not exist into a document
  about real relationships.
*/
const COMMON = new Set(
  (
    "a about above across after again against all almost along already also " +
    "although always am among an and another any anybody anyone anything are " +
    "around as at away back be because been before behind being below beside " +
    "besides best better between beyond both but by came can cannot come " +
    "coming could currently despite did do does doing done down during each " +
    "earlier early either else enough entirely especially even ever every " +
    "everybody everyone everything except far few finally first five for " +
    "four from further generally get gets getting given gives go goes going " +
    "gone good got had half handful has have having he hence her here hers " +
    "herself him himself his how however i if in indeed instead into is it " +
    "its itself just keep kept largely last late later least left less let " +
    "like likely little long longer look looking made mainly make makes " +
    "making many may maybe me mean means meanwhile might mine month monthly " +
    "months more most mostly much must my myself near nearly neither never " +
    "nevertheless new next nine no nobody none nor not nothing notably now " +
    "of off often on once one only or other others otherwise ought our ours " +
    "ourselves out over overall own particularly past per perhaps possibly " +
    "put quite rather really recent recently right said same say says second " +
    "see seem seems seen seven several she should side similarly since six " +
    "slightly so some somebody someone something sometimes somewhat soon " +
    "still such take taken ten than that the their theirs them themselves " +
    "then there therefore these they thing things think third this those " +
    "though three through throughout thus time to together too took toward " +
    "towards two under unless until up upon us usually very was way we week " +
    "weekly weeks well were what when where whereas whether which while who " +
    "whom whose why will with within without worth would year years yet you " +
    "your yours yourself " +
    /* The words this document is made of, so the paragraph may name what it
       is talking about. */
    "brief briefs contact contacts correspondence correspondences cold " +
    "cooling warm quiet quieter stale rhythm gap gaps cadence window windows " +
    "mail email inbox sent received message messages thread threads reply " +
    "replies address addresses domain domains venture ventures tracked " +
    "figures document " +
    "monday tuesday wednesday thursday friday saturday sunday " +
    "january february march april may june july august september october " +
    "november december " +
    /* Number words: a paragraph very often opens with one, and a spelled-out
       count is not a claim the digit gate could check anyway — the digits
       beside it are. */
    "zero one two three four five six seven eight nine ten eleven twelve " +
    "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty " +
    "thirty forty fifty sixty seventy eighty ninety hundred"
  ).split(/\s+/),
);

export function refuse(text: string, figures: Figures): string | null {
  const facts = JSON.stringify(figures).toLowerCase();
  const factWords = new Set(facts.split(/[^a-z0-9'’@.-]+/).filter(Boolean));
  /*
    TIMESTAMPS ARE NOT NUMBERS THE PARAGRAPH MAY QUOTE. An ISO stamp is a dozen
    digit runs — "2026-09-05t21:47:03.882z" contains 47, 88, 202 and 26 — and
    leaving them in the haystack would let almost any two-digit figure through
    a gate whose whole job is to catch one. They are stripped before the digit
    test; the WORD test below still sees them, which is what a date written out
    in words needs.
  */
  const numberFacts = facts.replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, " ");

  for (const m of text.matchAll(/\d[\d,.]*/g)) {
    const n = m[0].replace(/[.,]$/, "");
    if (!numberFacts.includes(n.replace(/,/g, "")))
      return `it uses a number the figures do not carry: ${n}`;
  }
  for (const m of text.matchAll(/[^\s]+@[^\s]+/g)) {
    const a = m[0].toLowerCase().replace(/[.,;:)]+$/, "");
    if (!facts.includes(a)) return `it uses an address the figures do not carry: ${a}`;
  }
  for (const m of text.matchAll(/\b[A-Z][A-Za-zÀ-ÿ'’-]+\b/g)) {
    const w = m[0].toLowerCase().replace(/[’']s$/, "");
    if (COMMON.has(w) || factWords.has(w)) continue;
    /* A capitalised word can also be part of an address or a display name in
       the facts — "Jane" inside "Jane Smith" — so a substring test follows the
       word test rather than replacing it. */
    if (facts.includes(w)) continue;
    return `it uses a name the figures do not carry: ${m[0]}`;
  }
  return null;
}

/* --------------------------------------------------------------- the write */

const SYSTEM =
  "You are writing one short paragraph for the owner of a one-person company " +
  "about his correspondence. THE ONLY THINGS YOU KNOW are the FACTS you are " +
  "given. Every name you use must appear in them. Every number you use must " +
  "appear in them. You may not add a person, a count, a date, a company, a " +
  "product or a reason that is not there — and you may NOT guess why anyone " +
  "went quiet, because nothing in these facts records what was ever said to " +
  "anybody. A validator reads your reply and throws the whole paragraph away " +
  "if it contains a name, a number or an address the facts do not carry; an " +
  `invented detail makes no paragraph at all. Write ${MAX_TOKENS_HINT} of ` +
  "plain prose. No bullet points, no headings, no markdown, no preamble, no " +
  "sign-off, no greeting.";

export type WriteResult = {
  week: string;
  written: boolean;
  reason: string;
  row: BriefRow | undefined;
};

/**
 * Write this week's brief, unless it is already written.
 *
 * `force` rewrites the row for the current week, and exists for one reason: a
 * settings change (a wider window, a different minimum) makes the week's
 * arithmetic different, and the owner should be able to see that without
 * waiting seven days. It never touches an earlier week's row — those are the
 * record.
 */
export async function writeBrief(
  opts: { force?: boolean; at?: number } = {},
): Promise<WriteResult> {
  const at = opts.at ?? Date.now();
  const week = isoWeek(new Date(at));
  const existing = briefRow(week);
  if (existing && !opts.force)
    return { week, written: false, reason: "already written for this week", row: existing };

  const figures = buildFigures(week, at);
  const lines = skeletonLines(figures);
  const skeleton = lines.map((l) => `- ${l}`).join("\n");

  let prose: string | null = null;
  let model: string | null = null;
  let error: string | null = null;

  /*
    THE MODEL AND THE VALIDATOR SEE EXACTLY THE SAME DOCUMENT, and that is the
    point of building it once. `temps` is the diff's raw material — every
    tracked address and its temperature — and sending it would spend the
    context on a map nobody is writing about AND widen the validator's allowed
    set to every address in the book, which is the opposite of what the gate is
    for. What the model was not shown, it may not cite.
  */
  const shown: Figures = { ...figures, temps: {} };

  try {
    const reply = await complete([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          "FACTS (JSON — everything you are allowed to know):\n" +
          JSON.stringify(shown, null, 2) +
          "\n\nTHE SAME FACTS, as the sentences he would otherwise read:\n" +
          lines.map((l) => `- ${l}`).join("\n") +
          "\n\nWrite the paragraph.",
      },
    ]);
    model = `${reply.provider}${reply.model ? `:${reply.model}` : ""}`;
    const text = reply.text.trim();
    const problem = refuse(text, shown);
    if (problem) error = `The paragraph was refused: ${problem}. The figures below are the brief.`;
    else prose = text;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const markdown =
    `## Relations — ${week}\n\n` +
    (prose ? `${prose}\n\n` : "") +
    `### The figures\n\n${skeleton}\n\n` +
    (prose
      ? ""
      : `_No paragraph this week: ${(error ?? "no model answered").replace(/\.\s*$/, "")}. The figures above are measured and stand on their own._\n\n`) +
    `_${figures.cannotSay}_\n`;

  db.prepare(
    `INSERT INTO people_briefs (week, written_at, model, markdown, figures, error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(week) DO UPDATE SET
       written_at = excluded.written_at, model = excluded.model,
       markdown = excluded.markdown, figures = excluded.figures, error = excluded.error`,
  ).run(week, now(), model, markdown, JSON.stringify(figures), error);

  return {
    week,
    written: true,
    reason: opts.force ? "rewritten on request" : "written",
    row: briefRow(week),
  };
}

/* --------------------------------------------------------------- the timer */

/** Six hours. The brief is weekly; the CHECK is six-hourly so that a laptop
 *  shut on Monday writes Monday's brief when it opens on Tuesday, rather than
 *  skipping the week. The week key makes the extra checks free. */
const CHECK_EVERY_MS = 6 * 3_600_000;
/** A brief written before there is anything to write about would be a
 *  paragraph about an empty table. */
const MIN_CONTACTS = 5;

export function startWeekly() {
  const tick = () => {
    void (async () => {
      try {
        if (workflowOwns("relationships")) return;
        if (briefRow(isoWeek())) return;
        const tracked = people().filter((p) => p.mutual).length;
        if (tracked < MIN_CONTACTS) return;
        const r = await writeBrief();
        if (r.written) console.log(`[people] relations brief written for ${r.week}`);
      } catch (e) {
        /* onStart must not throw. A brief that could not be written is next
           tick's problem, and the row it would have written says why. */
        console.error("[people] brief:", e instanceof Error ? e.message : e);
      }
    })();
  };
  /* A minute after boot rather than at it: the contacts collector may still be
     running its first scan, and a brief about a half-scanned table is a brief
     about the scan. */
  setTimeout(tick, 60_000).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}
