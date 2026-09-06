/**
 * THE SEGMENT DOCUMENT — who the traffic was, what changed, and what a
 * heuristic would take off if you let it.
 *
 * RAW AND ADJUSTED ARE ALWAYS BOTH PRESENT. There is no request parameter that
 * removes `raw` and no state of the data in which `adjusted` is served alone.
 * The toggle on the page chooses which one is EMPHASISED; the document always
 * carries both, the heuristic that produced the adjustment, the size of the
 * excluded population, and the date this box first saw that fingerprint.
 *
 * SHARES ARE COMPUTED ON THE READ AND AGAINST THE RIGHT DENOMINATOR, which is
 * the sum of the dimension's own rows — NOT the window's visitor count.
 * Umami drops a session from a dimension when the field was null on it, so the
 * two differ by a few percent, and `unattributed` publishes that gap rather
 * than hiding it inside every share.
 *
 * A MOVEMENT IS A COMPARISON OF TWO WINDOWS UMAMI ANSWERED SEPARATELY, never
 * a subtraction of one from a wider one. A visitor figure is de-duplicated
 * over the window it was asked about, so "the last 30 days minus the last 7"
 * is not "the 23 days before" by any amount anybody can compute.
 */
import {
  adjust,
  findings,
  refusals,
  HEURISTICS,
  type BotFinding,
  type BotInput,
  type Refusal,
} from "./bots.ts";
import {
  dimensionsOf,
  findingsOf,
  siteWindows,
  type DimensionRow,
  type SiteWindowRow,
} from "./store.ts";

export type SegmentValue = {
  value: string;
  count: number;
  /** Of the dimension's own rows for that window. */
  share: number;
  /** The same value in the comparison window, and the change. Null where the
   *  comparison window has no rows for this dimension. */
  was: number | null;
  change: number | null;
};

export type SegmentBlock = {
  dimension: string;
  counts: "visitors" | "views" | string;
  startDay: string;
  endDay: string;
  /** The sum of the rows below. A FLOOR rather than a total when `capped`. */
  total: number;
  /** Umami answered exactly the row limit, so there is a tail this box did not
   *  see and every share here is against a short denominator. */
  capped: boolean;
  /** The window figure this dimension's rows should have added up to, and the
   *  gap. Only meaningful for visitor-counted dimensions. */
  siteTotal: number | null;
  /**
   * Sessions the site had that no value here accounted for — which is only a
   * MEANING when the block is complete. On a capped block the gap is the
   * missing tail rather than sessions with no value, so it is `null` and
   * `gapReason` says which.
   */
  unattributed: number | null;
  gapReason: string | null;
  values: SegmentValue[];
};

export type SiteSegments = {
  websiteId: string;
  windowDays: number;
  compareWindow: { days: number; offset: number } | null;
  raw: {
    startDay: string | null;
    endDay: string | null;
    pageviews: number | null;
    visitors: number | null;
    visits: number | null;
    bounces: number | null;
  };
  adjusted: {
    visitors: ReturnType<typeof adjust>;
    /** There is no adjusted pageview figure and there will not be one: no
     *  heuristic here measures a population in pageviews. */
    pageviews: null;
    note: string;
  };
  findings: (BotFinding & { firstSeen: string | null })[];
  /** Heuristics that could not be run at all, with the reason. Never silence. */
  refusals: Refusal[];
  heuristics: typeof HEURISTICS;
  segments: SegmentBlock[];
  notes: string[];
};

const key = (a: string | number, b: number, c: number) => `${a}:${b}:${c}`;

function index(rows: DimensionRow[]): Map<string, DimensionRow[]> {
  const out = new Map<string, DimensionRow[]>();
  for (const r of rows)
    out.set(
      key(r.dimension, r.window_days, r.offset_days),
      [...(out.get(key(r.dimension, r.window_days, r.offset_days)) ?? []), r],
    );
  return out;
}

const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * One site's whole segment reading.
 *
 * `windowDays` picks which distribution is the subject: 30 for "who is this
 * audience", 7 for "who came this week". The comparison is only offered for
 * the 7-day view, because the only second window this area collects is the 7
 * days before — a 30-day distribution has nothing honest to be compared with
 * here and is served without a `was` rather than with a made-up one.
 */
export function segmentsFor(websiteId: string, windowDays: 7 | 30): SiteSegments {
  const windows = new Map<string, SiteWindowRow>();
  for (const w of siteWindows(websiteId)) windows.set(`${w.window_days}:${w.offset_days}`, w);

  const all = [
    ...dimensionsOf(websiteId, 30, 0),
    ...dimensionsOf(websiteId, 7, 0),
    ...dimensionsOf(websiteId, 7, 7),
  ];
  const byKey = index(all);

  /* The heuristics are recomputed here rather than read out of the findings
     table: the table remembers WHEN, the rubric decides WHETHER, and a stored
     verdict is a verdict about last week's thresholds. */
  const input: BotInput = { windows, dimensions: byKey };
  const found = findings(input);
  const refused = refusals(input);
  const firstSeen = new Map(
    findingsOf(websiteId).map((f) => [`${f.heuristic}|${f.fingerprint}`, f.first_seen]),
  );

  const subject = windows.get(`${windowDays}:0`) ?? null;
  const compare = windowDays === 7 ? { days: 7, offset: 7 } : null;

  const segments: SegmentBlock[] = [];
  const dimensions = [...new Set(all.filter((r) => r.window_days === windowDays && r.offset_days === 0).map((r) => r.dimension))];
  for (const dimension of dimensions.sort()) {
    const rows = byKey.get(key(dimension, windowDays, 0)) ?? [];
    if (!rows.length) continue;
    const total = rows.reduce((a, r) => a + r.count, 0);
    const prior = compare
      ? new Map((byKey.get(key(dimension, compare.days, compare.offset)) ?? []).map((r) => [r.value, r.count]))
      : null;
    const counts = rows[0]!.counts;
    const isCapped = rows[0]!.capped === 1;
    const siteTotal = counts === "visitors" ? (subject?.visitors ?? null) : null;
    segments.push({
      dimension,
      counts,
      startDay: rows[0]!.start_day,
      endDay: rows[0]!.end_day,
      total,
      capped: isCapped,
      siteTotal,
      unattributed: isCapped || siteTotal === null ? null : siteTotal - total,
      gapReason: isCapped
        ? `Umami answered exactly the row limit for this dimension, so these are the largest ` +
          `${rows.length} values and there is a tail this box did not see. The difference between ` +
          `the site's figure and the total below is that MISSING TAIL, not sessions with no ` +
          `${dimension} — and every share here is against a short denominator.`
        : siteTotal === null
          ? null
          : siteTotal - total > 0
            ? `${siteTotal - total} of the window's ${siteTotal} ${counts} have no ${dimension} on ` +
              `their session, so the shares are of ${total} and not of the whole site.`
            : null,
      values: rows
        .slice()
        .sort((a, b) => b.count - a.count)
        .map((r) => {
          const was = prior ? (prior.get(r.value) ?? 0) : null;
          return {
            value: r.value,
            count: r.count,
            share: total > 0 ? round(r.count / total) : 0,
            was,
            change: was !== null && was > 0 ? round((r.count - was) / was) : null,
          };
        }),
    });
  }

  const notes: string[] = [];
  if (!segments.length)
    notes.push(
      "No dimensional rows have been collected for this website yet. The web analytics collector rotates a few sites a pass; this one has not had its turn.",
    );
  for (const s of segments) if (s.gapReason) notes.push(`${s.dimension}: ${s.gapReason}`);
  for (const r of refused) notes.push(`${r.heuristic} was not run — ${r.reason}`);
  if (windowDays === 30)
    notes.push(
      "No week-on-week change is offered for the 30-day view: the only comparison window this area collects is the 7 days before the last 7, and a visitor figure de-duplicated over 30 days cannot have a 7-day one subtracted from it.",
    );

  return {
    websiteId,
    windowDays,
    compareWindow: compare,
    raw: {
      startDay: subject?.start_day ?? null,
      endDay: subject?.end_day ?? null,
      pageviews: subject?.pageviews ?? null,
      visitors: subject?.visitors ?? null,
      visits: subject?.visits ?? null,
      bounces: subject?.bounces ?? null,
    },
    adjusted: {
      /* THE WINDOW IS PASSED, and it is the correctness of this line. A
         finding is a statement about the window it was computed over; the
         30-day screen exclusion is not subtractable from a 7-day figure and
         a 7-day surge is not subtractable from a 30-day one. See adjust(). */
      visitors: adjust(subject?.visitors ?? null, "visitors", found, windowDays, 0),
      pageviews: null,
      note:
        "The adjusted figure is published BESIDE the raw one and never instead of it. Nothing in this box's stored history has been reduced: /api/umami still reports exactly what Umami said.",
    },
    findings: found.map((f) => ({
      ...f,
      firstSeen: firstSeen.get(`${f.heuristic}|${f.fingerprint}`) ?? null,
    })),
    refusals: refused,
    heuristics: HEURISTICS,
    segments,
    notes,
  };
}
