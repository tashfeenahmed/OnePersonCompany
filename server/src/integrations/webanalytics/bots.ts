/**
 * BOT DIAGNOSTICS — NAMED HEURISTICS, PUBLISHED BESIDE THE RAW FIGURE AND
 * NEVER INSTEAD OF IT.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE. Nothing here subtracts anything.
 * It reads a site's distributions and produces FINDINGS: an id, the
 * fingerprint that matched, the arithmetic that matched it, and the size of
 * the population involved. The route publishes `raw` and `adjusted` in the
 * same object, always, with the heuristic named on the adjusted one. A reader
 * who never looks at this file still sees exactly what /api/umami has always
 * shown; a reader who does can see what a heuristic would take off and why.
 *
 * WHY THESE HEURISTICS ARE WEAKER THAN WORKDASH'S, AND THE HONEST REASON.
 * Workdash's probe reads Umami's POSTGRES: it can group sessions by
 * country × browser × os × device × screen, count pages per session inside a
 * group, and ask what share of one screen SHAPE lives in one country. None of
 * that exists on the HTTP API this box has. `/metrics?type=…` answers ONE
 * dimension at a time with one count per value; there is no cross-tab, no
 * per-group pages-per-session, and no ASN anywhere. So the fingerprints here
 * are SINGLE-DIMENSION, the pages-per-session test is a SITE-WIDE gate rather
 * than a per-group one, and every finding says so in its own evidence rather
 * than borrowing the confidence of a test it did not run.
 *
 * THE POPULATIONS ARE NOT DISJOINT AND ARE THEREFORE NEVER ADDED. A session
 * can be inside a headless screen bucket AND inside a surging country at the
 * same time; adding the two exclusions would subtract it twice. So the
 * adjusted figure subtracts the LARGEST single finding's population for its
 * own population type and names which finding it used. That is deliberately
 * conservative: it under-states the reduction rather than over-stating it, and
 * over-stating it is the error that turns a real audience into a crawler.
 *
 * A FINDING IS NOT A VERDICT. Every threshold below is a judgement about what
 * a human audience does not do, and each one has a way of being wrong — a
 * genuinely viral referrer looks exactly like a referrer surge for a week. The
 * bars are set so that missing a crawler is the likelier error than flagging
 * an audience, which is the direction to be wrong in when something downstream
 * may subtract by the answer.
 */
import type { DimensionRow, SiteWindowRow } from "./store.ts";

/* ------------------------------------------------------------- thresholds */

/**
 * A screen a browser reports when nobody sized a window.
 *
 * 800x600 is headless Chrome's default and 1024x768 is Selenium's. Both were
 * real monitor sizes once, which is why the share bar and the pages-per-visit
 * gate below still have to hold.
 */
export const HEADLESS_SCREENS = new Set(["800x600", "1024x768"]);

/**
 * The width-to-height band that reads as square-ish, which no shipping device
 * is. 1280x1200 is 1.07 and a true square is 1.00; a 16:9 laptop is 1.78, a
 * 4:3 monitor 1.33, a phone in portrait well under 0.6. 1280x1024 is 1.25 and
 * is a real monitor, so the band stops below it.
 */
export const SQUARE_BAND: [number, number] = [0.85, 1.2];

/** A screen fingerprint must be at least this share of the window's screen
 *  rows. A tenth, not a fifth: the screen itself is most of the evidence. */
export const SCREEN_MIN_SHARE = 0.1;
/** And at least this many visitors, so a nine-session site cannot produce a
 *  finding at all. */
export const SCREEN_MIN_VISITORS = 40;
/**
 * The site-wide gate under the screen test: pageviews per VISIT.
 *
 * Workdash applies this per fingerprint because it can. This box cannot, so it
 * is applied to the whole site — which makes it a weaker test and a different
 * one, and the evidence line says exactly that. 1.3 is workdash's own loosened
 * ceiling for the screen trigger: a crawler that follows a link one time in
 * seven still walks under 1.05, and 1.3 is where a reading audience starts.
 */
export const SCREEN_MAX_VIEWS_PER_VISIT = 1.3;

/** A surge is this many times the same value's previous week. */
export const SURGE_MULTIPLE = 5;
/** And it must be this big in absolute terms, so 2 becoming 12 is not news. */
export const SURGE_MIN = 50;
/** And it must be this share of the window it is in, so a busy site's noise
 *  does not produce a finding every week. */
export const SURGE_MIN_SHARE = 0.2;

/** The single-view gate: at or under this many pageviews per visit... */
export const FLAT_VIEWS_PER_VISIT = 1.05;
/** ...with at least this share of visits bouncing... */
export const FLAT_BOUNCE_SHARE = 0.9;
/** ...over at least this many visits. */
export const FLAT_MIN_VISITS = 200;

/* --------------------------------------------------------------- the rubric */

export type HeuristicDef = {
  id: string;
  title: string;
  /** What is tested, in the units it is tested in. */
  what: string;
  /** How it can be wrong. Published with the definition, always. */
  wrong: string;
  /** Which population its exclusion is measured in, or null where it produces
   *  no exclusion at all. */
  population: "visitors" | "views" | null;
};

export const HEURISTICS: HeuristicDef[] = [
  {
    id: "headless-screen",
    title: "A screen no device has",
    what:
      `A screen value that is a known headless default (${[...HEADLESS_SCREENS].join(", ")}) ` +
      `or square-ish (width ÷ height between ${SQUARE_BAND[0]} and ${SQUARE_BAND[1]}), holding at ` +
      `least ${Math.round(SCREEN_MIN_SHARE * 100)}% of the window's screen rows and at least ` +
      `${SCREEN_MIN_VISITORS} visitors, on a site averaging at most ` +
      `${SCREEN_MAX_VIEWS_PER_VISIT} pageviews a visit.`,
    wrong:
      "The pages-per-visit gate is SITE-WIDE, not per fingerprint — this API cannot cross-tab a " +
      "screen against a session's pageviews — so a site whose real audience reads one page will " +
      "let a real screen through the gate. And a person on an unusual monitor exists.",
    population: "visitors",
  },
  {
    id: "country-surge",
    title: "One country arrived all at once",
    what:
      `A country whose visitors in the last 7 complete days are at least ${SURGE_MULTIPLE}× the ` +
      `same country's visitors in the 7 days before, with at least ${SURGE_MIN} visitors and at ` +
      `least ${Math.round(SURGE_MIN_SHARE * 100)}% of the week's country rows. The excluded ` +
      "population is the EXCESS over the previous week, not the whole country.",
    wrong:
      "A launch, a newsletter, a post that did well in one market, or a public holiday all look " +
      "like this for exactly one week. The baseline is ONE previous week, not a trailing median " +
      "over many — the HTTP API answers one window per request and a median would cost a request " +
      "a week per dimension per site.",
    population: "visitors",
  },
  {
    id: "referrer-surge",
    title: "One referrer arrived all at once",
    what:
      `The same test on referrers, counted in VIEWS rather than visitors because that is what ` +
      `Umami's referrer metric counts.`,
    wrong:
      "Identical to the country surge, plus one more: a referrer that genuinely sent real people " +
      "this week and none last week is indistinguishable from a scraper here.",
    population: "views",
  },
  {
    id: "flat-single-view",
    title: "The whole site reads like one fetch a session",
    what:
      `Over the 30-day window: at most ${FLAT_VIEWS_PER_VISIT} pageviews per visit, at least ` +
      `${Math.round(FLAT_BOUNCE_SHARE * 100)}% of visits bouncing, over at least ` +
      `${FLAT_MIN_VISITS} visits.`,
    wrong:
      "A one-page site with a real audience is exactly this shape and is not automated. It is why " +
      "this heuristic EXCLUDES NOTHING: it is a diagnostic that says the other findings on this " +
      "site deserve more weight, and it can never move a number on its own.",
    population: null,
  },
];

/* -------------------------------------------------------------- findings */

export type BotFinding = {
  heuristic: string;
  title: string;
  /** `dimension:value`, the key `web_bot_findings` remembers a first sighting
   *  under. `site` where the finding is about the whole site. */
  fingerprint: string;
  dimension: string;
  value: string | null;
  population: "visitors" | "views" | null;
  /** How many of that population the finding covers. `null` where the
   *  heuristic is a diagnostic and quantifies nothing. */
  excluded: number | null;
  windowDays: number;
  offsetDays: number;
  /** The arithmetic, as sentences. Every number that decided the finding. */
  evidence: string[];
};

export type BotInput = {
  /** The site's own window figures, keyed `${windowDays}:${offsetDays}`. */
  windows: Map<string, SiteWindowRow>;
  /** Distribution rows, keyed `${dimension}:${windowDays}:${offsetDays}`. */
  dimensions: Map<string, DimensionRow[]>;
};

const key = (a: string | number, b: number, c: number) => `${a}:${b}:${c}`;

const share = (n: number, of: number) => (of > 0 ? n / of : 0);

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Is this screen string one a browser nobody is looking at reports? Returns
 *  the trigger that matched, or null. */
export function screenTrigger(value: string): "headless-default" | "square" | null {
  if (HEADLESS_SCREENS.has(value)) return "headless-default";
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(value);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  const ratio = w / h;
  return ratio >= SQUARE_BAND[0] && ratio <= SQUARE_BAND[1] ? "square" : null;
}

/**
 * Was this block the whole distribution, or the request cap?
 *
 * A capped block's total is a FLOOR, so every share computed against it is too
 * big — which on a bot heuristic means the bar is easier to clear than the
 * rubric says. Every share test below therefore refuses a capped dimension
 * rather than running against an unknown denominator, and `refusals` publishes
 * what it refused and why.
 */
const capped = (rows: DimensionRow[]): boolean => rows.length > 0 && rows[0]!.capped === 1;

export type Refusal = {
  heuristic: string;
  dimension: string;
  windowDays: number;
  offsetDays: number;
  reason: string;
};

/**
 * The heuristics that could not be run, and why.
 *
 * Published beside the findings, always. "No finding" and "the test could not
 * be run" are different sentences and only one of them is about the traffic —
 * an area whose whole point is that an adjustment names itself may not go
 * quiet when its denominator is unknown.
 */
export function refusals(input: BotInput): Refusal[] {
  const out: Refusal[] = [];
  const note = (dimension: string, windowDays: number) =>
    `Umami answered exactly the ${dimension} row limit for the ${windowDays}-day window, so its ` +
    `total is a floor rather than a distribution and every share against it would be too big. ` +
    `A bot heuristic run on that denominator would clear its own bar too easily, so it is not run.`;

  if (capped(input.dimensions.get(key("screen", 30, 0)) ?? []))
    out.push({
      heuristic: "headless-screen",
      dimension: "screen",
      windowDays: 30,
      offsetDays: 0,
      reason: note("screen", 30),
    });
  for (const dimension of ["country", "referrer"] as const)
    for (const [w, o] of [
      [7, 0],
      [7, 7],
    ] as const)
      if (capped(input.dimensions.get(key(dimension, w, o)) ?? []))
        out.push({
          heuristic: `${dimension}-surge`,
          dimension,
          windowDays: w,
          offsetDays: o,
          reason: note(dimension, w),
        });
  return out;
}

/**
 * Every finding for one site.
 *
 * The order is the rubric's order, not a severity ranking — there is no
 * severity here, because these are four different questions and none of them
 * outranks another.
 *
 * A CAPPED DIMENSION PRODUCES NO FINDING AT ALL, and `refusals()` above says
 * so out loud. See its header.
 */
export function findings(input: BotInput): BotFinding[] {
  const out: BotFinding[] = [];
  const month = input.windows.get("30:0");
  const viewsPerVisit =
    month && month.pageviews !== null && month.visits ? month.pageviews / month.visits : null;

  /* ---- headless-screen: the one fingerprint this API can still catch ---- */
  const screens = input.dimensions.get(key("screen", 30, 0)) ?? [];
  const screenTotal = screens.reduce((a, r) => a + r.count, 0);
  if (!capped(screens) && viewsPerVisit !== null && viewsPerVisit <= SCREEN_MAX_VIEWS_PER_VISIT) {
    for (const row of screens) {
      const trigger = screenTrigger(row.value);
      if (!trigger) continue;
      const s = share(row.count, screenTotal);
      if (row.count < SCREEN_MIN_VISITORS || s < SCREEN_MIN_SHARE) continue;
      out.push({
        heuristic: "headless-screen",
        title: "A screen no device has",
        fingerprint: `screen:${row.value}`,
        dimension: "screen",
        value: row.value,
        population: "visitors",
        excluded: row.count,
        windowDays: 30,
        offsetDays: 0,
        evidence: [
          trigger === "headless-default"
            ? `${row.value} is a known headless browser default window size.`
            : `${row.value} is square-ish (ratio ${round(
                Number(row.value.split("x")[0]) / Number(row.value.split("x")[1]),
              )}), which no shipping device is.`,
          `${row.count} of ${screenTotal} visitors with a screen reported ` +
            `(${round(s * 100, 1)}%) over ${month?.start_day} to ${month?.end_day}.`,
          `The site averaged ${round(viewsPerVisit)} pageviews a visit over the same window, ` +
            `at or under the ${SCREEN_MAX_VIEWS_PER_VISIT} gate. THIS GATE IS SITE-WIDE: this ` +
            `API cannot say how many pages the sessions with this screen read.`,
        ],
      });
    }
  }

  /* ---- the two surges ---- */
  for (const [dimension, population] of [
    ["country", "visitors"],
    ["referrer", "views"],
  ] as const) {
    const week = input.dimensions.get(key(dimension, 7, 0)) ?? [];
    const before = input.dimensions.get(key(dimension, 7, 7)) ?? [];
    if (!week.length || !before.length) continue;
    /* Either half capped and the share bar is measured against a floor. */
    if (capped(week) || capped(before)) continue;
    const weekTotal = week.reduce((a, r) => a + r.count, 0);
    const prior = new Map(before.map((r) => [r.value, r.count]));
    for (const row of week) {
      const was = prior.get(row.value) ?? 0;
      const s = share(row.count, weekTotal);
      if (row.count < SURGE_MIN || s < SURGE_MIN_SHARE) continue;
      /* A value absent last week is treated as a surge of unbounded multiple —
         `was` of 0 makes the ratio meaningless, so the test becomes "it was
         not there and now it is most of the week". */
      const multiple = was > 0 ? row.count / was : Infinity;
      if (multiple < SURGE_MULTIPLE) continue;
      out.push({
        heuristic: `${dimension}-surge`,
        title: dimension === "country" ? "One country arrived all at once" : "One referrer arrived all at once",
        fingerprint: `${dimension}:${row.value}`,
        dimension,
        value: row.value,
        population,
        excluded: row.count - was,
        windowDays: 7,
        offsetDays: 0,
        evidence: [
          `${row.value}: ${row.count} ${population} in ${row.start_day}–${row.end_day}, against ` +
            `${was} in the 7 days before.`,
          was > 0
            ? `That is ${round(multiple, 1)}× the previous week, past the ${SURGE_MULTIPLE}× bar.`
            : `It was absent from the previous week entirely.`,
          `It is ${round(s * 100, 1)}% of the week's ${dimension} rows, past the ` +
            `${Math.round(SURGE_MIN_SHARE * 100)}% bar.`,
          `The excluded population is the EXCESS (${row.count - was}), not the whole value: ` +
            `whatever was there last week was there last week.`,
        ],
      });
    }
  }

  /* ---- the diagnostic that excludes nothing ---- */
  if (
    month &&
    viewsPerVisit !== null &&
    month.visits !== null &&
    month.bounces !== null &&
    month.visits >= FLAT_MIN_VISITS &&
    viewsPerVisit <= FLAT_VIEWS_PER_VISIT &&
    share(month.bounces, month.visits) >= FLAT_BOUNCE_SHARE
  ) {
    out.push({
      heuristic: "flat-single-view",
      title: "The whole site reads like one fetch a session",
      fingerprint: "site",
      dimension: "site",
      value: null,
      population: null,
      excluded: null,
      windowDays: 30,
      offsetDays: 0,
      evidence: [
        `${round(viewsPerVisit)} pageviews a visit over ${month.visits} visits ` +
          `(${month.start_day}–${month.end_day}).`,
        `${round(share(month.bounces, month.visits) * 100, 1)}% of visits bounced, on Umami's ` +
          `own definition: a visit with a single pageview.`,
        "THIS EXCLUDES NOTHING. A one-page site with a real audience is this exact shape.",
      ],
    });
  }

  return out;
}

/* -------------------------------------------------------------- adjusted */

export type Adjusted = {
  /** The figure after the largest single finding's population is taken off.
   *  `null` where the raw figure was not measured, or where the arithmetic was
   *  REFUSED — see the function below; it is never a floored zero. */
  value: number | null;
  /** Which finding produced it. */
  heuristic: string | null;
  fingerprint: string | null;
  excluded: number;
  /** How it was computed, in words, on every answer. */
  basis: string;
};

/**
 * `raw` minus the LARGEST single finding OF THE SAME WINDOW, never the sum of
 * them and never one from another window.
 *
 * THE WINDOW FILTER IS THE WHOLE CORRECTNESS OF THIS FUNCTION and it was
 * missing at first, which produced a fabricated zero on a live site: the
 * 30-day `headless-screen` exclusion of 382 was subtracted from a SEVEN-DAY raw
 * of 352, `Math.max(0, …)` hid the negative, and the page published
 * "adjusted visitors 0". A finding is a statement about the window it was
 * computed over — the screen fingerprint over 30 days, a surge over the last 7
 * — and subtracting one from the other is not a smaller number, it is a
 * different question's answer. So a finding may only adjust the window it
 * itself carries.
 *
 * THE POPULATIONS ALSO OVERLAP, so the ones that DO match the window are not
 * added: a session in a surging country may also be reporting a headless
 * screen, and adding the two would subtract it twice. Taking the largest is a
 * floor on the reduction and is stated as one.
 *
 * AND WHERE THE ARITHMETIC WOULD GO NEGATIVE, IT IS REFUSED RATHER THAN
 * FLOORED. `Math.max(0, …)` is how a contradiction becomes a confident zero.
 * An exclusion larger than the raw figure means the two do not describe the
 * same population — a bug, a window mismatch, or Umami answering two questions
 * differently — and the honest output is `null` with the arithmetic printed, so
 * a reader sees the contradiction rather than a measurement of nought.
 */
export function adjust(
  raw: number | null,
  population: "visitors" | "views",
  found: BotFinding[],
  windowDays: number,
  offsetDays = 0,
): Adjusted {
  const candidates = found.filter(
    (f) =>
      f.population === population &&
      f.excluded !== null &&
      f.windowDays === windowDays &&
      f.offsetDays === offsetDays,
  );
  const window = `${windowDays} days ending ${offsetDays === 0 ? "yesterday" : `${offsetDays} days ago`}`;
  if (raw === null)
    return {
      value: null,
      heuristic: null,
      fingerprint: null,
      excluded: 0,
      basis: "The raw figure was not measured, so there is nothing to adjust.",
    };

  if (!candidates.length) {
    /* A finding from ANOTHER window is not silence — it is a finding that
       cannot legally touch this figure, and saying so is more useful than
       "nothing matched", which would read as "this site is clean". */
    const elsewhere = found.filter((f) => f.population === population && f.excluded !== null);
    return {
      value: raw,
      heuristic: null,
      fingerprint: null,
      excluded: 0,
      basis: elsewhere.length
        ? `No heuristic matched a ${population} population over ${window}, so the adjusted figure IS ` +
          `the raw figure. ${elsewhere.length} finding(s) exist on this site over OTHER windows ` +
          `(${[...new Set(elsewhere.map((f) => `${f.heuristic} over ${f.windowDays}d+${f.offsetDays}`))].join(", ")}) ` +
          `and none of them may be subtracted from this one: a window's figure is de-duplicated ` +
          `over that window and no other.`
        : `No heuristic matched a ${population} population on this site, so the adjusted figure IS the raw figure.`,
    };
  }

  const biggest = candidates.reduce((a, b) => ((b.excluded ?? 0) > (a.excluded ?? 0) ? b : a));
  const excluded = biggest.excluded ?? 0;
  const overlap =
    candidates.length > 1
      ? `${candidates.length} findings matched this population and window and they are NOT added: the ` +
        `populations overlap by an amount this API cannot measure, so the largest single one ` +
        `is subtracted and this is a floor on the reduction, not the reduction.`
      : "One finding matched this population and window.";

  if (excluded > raw)
    return {
      value: null,
      heuristic: biggest.heuristic,
      fingerprint: biggest.fingerprint,
      excluded,
      basis:
        `REFUSED: ${raw} − ${excluded} (${biggest.heuristic} · ${biggest.fingerprint}) over ${window} ` +
        `is negative. An exclusion larger than the figure it comes out of means the two do not ` +
        `describe the same population, and a floored nought would report that contradiction as a ` +
        `measurement. The raw figure beside this one is unaffected.`,
    };

  return {
    value: raw - excluded,
    heuristic: biggest.heuristic,
    fingerprint: biggest.fingerprint,
    excluded,
    basis: `${raw} − ${excluded} (${biggest.heuristic} · ${biggest.fingerprint}) over ${window}. ${overlap}`,
  };
}
