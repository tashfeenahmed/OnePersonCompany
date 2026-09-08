/**
 * Google Search Console.
 *
 * EVERY FIGURE ON THIS ROUTE IS SUMMED WHEN IT IS ASKED FOR. The database
 * holds "1,004 impressions on the 12th, on one property" and holds no window
 * total anywhere — the same decision the costs board, the domain countdowns
 * and the npm weeks are built on. A stored "impressions, 28 days" is wrong the
 * next morning and badly wrong after a week of failed collections, which is
 * the week somebody actually opens the page.
 *
 * THE THREE THINGS THIS ROUTE REFUSES TO DO, each of which is a real way to
 * get search reporting wrong:
 *
 *   IT DOES NOT DRAW A PARTIAL DAY. Search Console finalises a day over two to
 *   three days, so the collector never reads closer than three days back and
 *   there is no row here that could be partial. The window's own end is on the
 *   wire as `window.end`, so a card can say "to 1 Sep" rather than leaving a
 *   reader to wonder why the line stops.
 *
 *   IT DOES NOT PRESENT THE SUM OF QUERY ROWS AS A TOTAL. Google withholds
 *   rare queries and caps the rows it returns, so the ranked rows carry
 *   somewhere between 0% and 77% of their own property's impressions on this
 *   account. `coverage` states that fraction, per property and across the
 *   portfolio, and the totals above it come from the daily rows — which DO sum
 *   to Google's own answer, exactly, because a date cannot be anonymised.
 *
 *   IT DOES NOT AVERAGE POSITIONS UNWEIGHTED. Average position is a mean over
 *   IMPRESSIONS, so a day with four impressions must not move a property's
 *   rank as far as a day with four thousand, and a property with eight
 *   impressions must not move the portfolio's. Every position here is
 *   impression-weighted, and it is null rather than zero wherever there were
 *   no impressions to weight by: Google reports 0.0 for a property nobody saw,
 *   and an average position of zero is not a rank.
 */
import { Hono } from "hono";
import {
  accountRows,
  gscDays,
  gscRanked,
  gscSites,
  type GscDayRow,
  type GscSiteRow,
} from "../db.ts";
import { LAG_DAYS, WINDOW_DAYS, QUERY_ROWS } from "../providers/gsc.ts";
import {
  strikingRows,
  STRIKING_MAX_POSITION,
  STRIKING_MIN_POSITION,
} from "../integrations/growth/serp.ts";

export const gscRoutes = new Hono();

/** A property's display name. `sc-domain:` is a Search Console prefix rather
 *  than part of anybody's domain, and a trailing slash on a URL-prefix
 *  property is noise in a column of nineteen. */
export function label(property: string): string {
  return property
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

type Agg = { clicks: number; impressions: number; weighted: number };

const blank = (): Agg => ({ clicks: 0, impressions: 0, weighted: 0 });

/** Fold one day into a running total, carrying the impression-weighted
 *  position as a sum that is divided only at the end. */
function add(agg: Agg, row: { clicks: number; impressions: number; position: number | null }) {
  agg.clicks += row.clicks;
  agg.impressions += row.impressions;
  if (row.position !== null) agg.weighted += row.position * row.impressions;
}

/**
 * An aggregate as figures — or as nulls when the window holds no rows at all.
 *
 * ZERO AND "NOT COLLECTED" ARE DIFFERENT WINDOWS. The previous window is only
 * populated once the collector has been running longer than the window is wide;
 * before that there are no rows for those days, and shaping an empty aggregate
 * into `impressions: 0` publishes a measurement nobody took. It reads as "the
 * site had no impressions in July", which is a far stronger and quite possibly
 * false claim than "we were not collecting in July".
 *
 * It self-heals — after four weeks the previous window is real — which is
 * exactly what makes it worth fixing now rather than later: a wrong number that
 * disappears on its own is one nobody ever goes back and checks.
 */
function shape(agg: Agg) {
  return {
    clicks: agg.clicks,
    impressions: agg.impressions,
    /** Clicks over impressions, as a percentage. Never the mean of daily CTRs,
     *  which weights a quiet Sunday as heavily as a launch day. */
    ctr: agg.impressions ? Number(((agg.clicks / agg.impressions) * 100).toFixed(2)) : null,
    position: agg.impressions ? Number((agg.weighted / agg.impressions).toFixed(1)) : null,
  };
}

/**
 * The window BEFORE this one, which may not have been collected at all.
 *
 * Separate from `shape` on purpose: the current window is always measured, and
 * giving it a nullable type to share one function would push a null check into
 * every reader of a figure that can never be null.
 */
function previousShape(agg: Agg, measured: boolean) {
  return measured
    ? { ...shape(agg), measured: true as const }
    : {
        clicks: null,
        impressions: null,
        ctr: null,
        position: null,
        /** No rows for those days — the collector had not run that far back.
         *  Reported as "not measured" rather than as a month of zeroes. */
        measured: false as const,
      };
}

/** A percentage change, or null when the base is nothing. A property that went
 *  from zero to eight impressions has not improved by infinity. */
function change(now: number, before: number | null): number | null {
  if (!before) return null;
  return Number((((now - before) / before) * 100).toFixed(1));
}

gscRoutes.get("/", (c) => {
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 90) || 90, 7), 400);
  const sites = gscSites();
  const rows = gscDays(days);
  const accounts = accountRows("gsc").map((a) => ({
    id: a.id,
    label: a.label,
    connected: a.connected === 1,
    properties: sites.filter((s) => s.account_id === a.id).length,
  }));

  /*
    THE WINDOW COMES FROM THE DATA, not from the clock. Every property was
    asked over the same span, so the newest day any of them reported is the end
    of what has actually been measured — and quoting today's date over a chart
    that stops on Monday is how a three-day reporting lag reads as a collapse.
    With nothing collected yet there is no window and the route says so rather
    than inventing one out of Date.now().
  */
  const lastDay = rows.length ? rows[rows.length - 1]!.day : null;
  const windowEnd = sites.map((s) => s.window_end).filter((d): d is string => !!d).sort().at(-1) ?? lastDay;
  const windowStart = windowEnd
    ? new Date(Date.parse(windowEnd) - (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
    : null;
  /* The window before this one, the same length and ending the day before it
     starts — so "up 18%" is against a like-for-like span rather than against
     whatever happened to be in the table. */
  const prevEnd = windowStart
    ? new Date(Date.parse(windowStart) - 86_400_000).toISOString().slice(0, 10)
    : null;
  const prevStart = prevEnd
    ? new Date(Date.parse(prevEnd) - (WINDOW_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)
    : null;

  const inWindow = (day: string) =>
    !!windowStart && !!windowEnd && day >= windowStart && day <= windowEnd;
  const inPrevious = (day: string) =>
    !!prevStart && !!prevEnd && day >= prevStart && day <= prevEnd;

  /* --------------------------------------------------------- per property */

  /*
    THE RANKED ROWS, CUT PER PROPERTY AS WELL AS ACROSS THE PORTFOLIO. The
    portfolio lists below are forty queries and twenty-five pages ordered by
    clicks, which on this account is one busy property's list wearing the
    portfolio's name — eighteen properties never reach it. A card drawn per
    property needs each property's own top rows, so they are cut here from the
    same stored snapshot. Ten each: enough for a per-project card to be a
    short report rather than a headline — Workdash's per-property page shows
    ten — and still a fraction of the forty the portfolio list carries. The
    same caveats travel: Google's rows are clicks-ordered and capped, so a
    property's "top query" is the top of what Google returned.
  */
  const queryRows = gscRanked("queries");
  const pageRows = gscRanked("pages");
  const PER_PROPERTY = 10;
  const perPropertyQueries = new Map<string, typeof queryRows>();
  for (const r of queryRows) {
    const mine = perPropertyQueries.get(r.property) ?? [];
    if (mine.length < PER_PROPERTY) mine.push(r);
    perPropertyQueries.set(r.property, mine);
  }
  const perPropertyPages = new Map<string, typeof pageRows>();
  const perPropertyZeroClick = new Map<string, typeof pageRows>();
  for (const r of pageRows) {
    const mine = perPropertyPages.get(r.property) ?? [];
    if (mine.length < PER_PROPERTY) mine.push(r);
    perPropertyPages.set(r.property, mine);
    /* Shown and never clicked — within the pages Google returned, which is a
       FLOOR on the real count and is said to be one on the wire. */
    if (r.impressions > 0 && r.clicks === 0) {
      const zero = perPropertyZeroClick.get(r.property) ?? [];
      zero.push(r);
      perPropertyZeroClick.set(r.property, zero);
    }
  }

  const byProperty = new Map<string, { now: Agg; prev: Agg; prevDays: number }>();
  /*
    EACH PROPERTY'S OWN DAILY LINE, beside the portfolio one further down. The
    summed series answers "did the portfolio grow"; it cannot answer "which
    property did", and a card drawn per property has to be drawn from rows
    that were never added together. Same rows, same `days`, so the two lines
    end on the same day and can be read beside each other. Position is the
    day's own impression-weighted figure as the collector stored it, and null
    on a day nobody saw the property.
  */
  const dailyByProperty = new Map<string, { day: string; clicks: number; impressions: number; position: number | null }[]>();
  for (const r of rows) {
    const entry = byProperty.get(r.property) ?? { now: blank(), prev: blank(), prevDays: 0 };
    if (inWindow(r.day)) add(entry.now, r);
    else if (inPrevious(r.day)) {
      add(entry.prev, r);
      entry.prevDays += 1;
    }
    byProperty.set(r.property, entry);
    const line = dailyByProperty.get(r.property) ?? [];
    line.push({ day: r.day, clicks: r.clicks, impressions: r.impressions, position: r.position });
    dailyByProperty.set(r.property, line);
  }

  const properties = sites.map((s: GscSiteRow) => {
    const agg = byProperty.get(s.property) ?? { now: blank(), prev: blank(), prevDays: 0 };
    const now = shape(agg.now);
    const before = previousShape(agg.prev, agg.prevDays > 0);
    return {
      property: s.property,
      label: label(s.property),
      account: s.account_label,
      permission: s.permission,
      ...now,
      previous: before,
      delta: {
        impressions: change(now.impressions, before.impressions),
        clicks: change(now.clicks, before.clicks),
        /* Position moves in ABSOLUTE places, not percent: from 8.0 to 6.0 is
           "two places better", and "-25%" is a sentence nobody can act on.
           Negative is an improvement, which is why every card carrying it
           inverts its tone. */
        position:
          now.position !== null && before.position !== null
            ? Number((now.position - before.position).toFixed(1))
            : null,
      },
      /*
        WHAT GOOGLE ITSELF SAID FOR THE SAME WINDOW, kept beside what was summed
        from the daily rows. They agreed exactly when this was checked, and the
        pair is what lets anybody reading the document check it again rather
        than take the claim on trust.
      */
      googleTotal: {
        clicks: s.total_clicks,
        impressions: s.total_impressions,
        position: s.total_position,
        window: s.window_start && s.window_end ? { start: s.window_start, end: s.window_end } : null,
      },
      /*
        HOW MUCH OF THIS PROPERTY THE RANKED QUERY ROWS ACTUALLY COVER. Google
        withholds queries too rare to anonymise and caps the row count, so this
        runs from 2% to 77% across these nineteen properties. A card that lists
        top queries has to be able to say that, and `capped` says which of the
        two causes is in play: a property returning the full row limit has more
        to give, one returning fewer has been anonymised rather than truncated.
      */
      queryCoverage: {
        rows: s.query_rows,
        impressions: s.query_impressions,
        clicks: s.query_clicks,
        pct:
          s.query_impressions !== null && s.total_impressions
            ? Number(((s.query_impressions / s.total_impressions) * 100).toFixed(1))
            : null,
        capped: s.query_rows !== null ? s.query_rows >= QUERY_ROWS : null,
      },
      sitemaps: {
        /* 'reported' | 'none' | 'failed'. Three states, because a property that
           has submitted nothing and a property whose sitemaps call was refused
           both have no rows and only one of them is a thing to go and fix. */
        state: s.sitemap_state,
        count: s.sitemap_count,
        submitted: s.sitemap_submitted,
        errors: s.sitemap_errors,
        warnings: s.sitemap_warnings,
        pending: s.sitemap_pending,
        lastDownloaded: s.sitemap_downloaded,
      },
      error: s.error,
      seenAt: s.seen_at,
      /* Oldest first, every collected day back to `seriesDays`, not only the
         window: a per-property line is read for its shape. */
      series: dailyByProperty.get(s.property) ?? [],
      topQueries: (perPropertyQueries.get(s.property) ?? []).map((r) => ({
        query: r.query!,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position === null ? null : Number(r.position.toFixed(1)),
      })),
      topPages: (perPropertyPages.get(s.property) ?? []).map((r) => ({
        page: r.page!,
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position === null ? null : Number(r.position.toFixed(1)),
      })),
      /* The same band and floor as the portfolio list — one definition, in
         growth/serp.ts — so this property's page-two list is the portfolio
         list narrowed and never a second opinion. */
      striking: strikingRows(s.property, PER_PROPERTY).map((r) => ({
        query: r.query,
        impressions: r.impressions,
        clicks: r.clicks,
        position: r.position === null ? null : Number(r.position.toFixed(1)),
      })),
      zeroClick: (() => {
        const zero = [...(perPropertyZeroClick.get(s.property) ?? [])].sort(
          (a, b) => b.impressions - a.impressions,
        );
        return {
          count: zero.length,
          /* A floor: only the pages Google returned could be counted. */
          floor: true as const,
          pages: zero.slice(0, 3).map((r) => ({ page: r.page!, impressions: r.impressions })),
        };
      })(),
    };
  });

  properties.sort((a, b) => b.impressions - a.impressions);

  /* ------------------------------------------------------------- portfolio */

  const totalNow = blank();
  const totalPrev = blank();
  let prevDays = 0;
  for (const r of rows) {
    if (inWindow(r.day)) add(totalNow, r);
    else if (inPrevious(r.day)) {
      add(totalPrev, r);
      prevDays += 1;
    }
  }
  const totals = shape(totalNow);
  const previous = previousShape(totalPrev, prevDays > 0);

  /* ---------------------------------------------------------------- series */

  const byDay = new Map<string, { clicks: number; impressions: number; properties: number }>();
  for (const r of rows as GscDayRow[]) {
    const d = byDay.get(r.day) ?? { clicks: 0, impressions: 0, properties: 0 };
    d.clicks += r.clicks;
    d.impressions += r.impressions;
    /* How many properties had anything at all that day. Not a coverage figure
       — every property is asked over the same span — but it is the difference
       between "the portfolio grew" and "one property had a good Tuesday". */
    d.properties += r.impressions > 0 ? 1 : 0;
    byDay.set(r.day, d);
  }
  const series = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, d]) => ({ day, ...d }));

  /* ---------------------------------------------------------------- ranked */

  const named = (property: string) => label(property);
  /* Rounded here rather than at collection time. The database keeps what
     Google sent — 3.5662295081967215 places — because that is the measurement;
     one decimal is a presentation decision, and presentation decisions belong
     on the read where they can change without a migration. */
  const place = (n: number | null) => (n === null ? null : Number(n.toFixed(1)));

  const queries = queryRows.slice(0, 40).map((r) => ({
    query: r.query!,
    property: named(r.property),
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: place(r.position),
  }));

  /*
    STRIKING DISTANCE, FROM THE ONE DEFINITION. `growth/serp.ts` owns the band
    and the impressions floor, with the reasoning for both; this route and the
    SEO teardown read the same rows so one recommendation is one list. It used
    to filter 11–20 with no floor here and 5–20 with a floor there, and the two
    surfaces named different queries as the cheapest win.

    THE HONEST CAVEAT TRAVELS WITH IT. Google sorts the stored rows by CLICKS
    and offers no other order, so this is the best of what a clicks-ordered cap
    returned — a query with ten thousand impressions and no clicks at all can
    be missing from it entirely, and that is exactly the sort of query this
    list is meant to surface. `basis` says so on the wire rather than in a
    comment nobody downstream can read.
  */
  const striking = strikingRows(null, 12).map((r) => ({
    query: r.query,
    property: named(r.property),
    impressions: r.impressions,
    clicks: r.clicks,
    position: place(r.position),
  }));

  const pages = pageRows.slice(0, 25).map((r) => ({
    page: r.page!,
    property: named(r.property),
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: place(r.position),
  }));

  /* -------------------------------------------------------------- coverage */

  const coveredImpressions = properties.reduce(
    (a, p) => a + (p.queryCoverage.impressions ?? 0),
    0,
  );
  const googleImpressions = properties.reduce((a, p) => a + (p.googleTotal.impressions ?? 0), 0);

  const withSitemaps = properties.filter((p) => p.sitemaps.state === "reported");

  return c.json({
    connected: sites.length > 0,
    accounts,
    window: {
      days: WINDOW_DAYS,
      start: windowStart,
      end: windowEnd,
      previousStart: prevStart,
      previousEnd: prevEnd,
      /* Named on the wire so a card can say WHY the line stops short of today
         instead of a reader reading three missing days as a fall. */
      lagDays: LAG_DAYS,
      lagNote:
        "Search Console finalises a day over two to three days, so every window here ends three days back and is asked for as final data. Nothing on this route is a partial day.",
    },
    totals: { ...totals, properties: properties.filter((p) => p.impressions > 0).length },
    previous,
    delta: {
      impressions: change(totals.impressions, previous.impressions),
      clicks: change(totals.clicks, previous.clicks),
      position:
        totals.position !== null && previous.position !== null
          ? Number((totals.position - previous.position).toFixed(1))
          : null,
    },
    series,
    seriesDays: days,
    properties,
    queries,
    striking,
    strikingBasis:
      `Queries at position ${STRIKING_MIN_POSITION} to ${STRIKING_MAX_POSITION}, most impressions first — the same band the SEO teardown works from. ` +
      "Google returns these rows ordered by clicks and offers no other order, so this is the best of what that cap returned — a high-impression query with no clicks can be missing from it.",
    pages,
    coverage: {
      queryImpressions: coveredImpressions,
      googleImpressions,
      pct: googleImpressions
        ? Number(((coveredImpressions / googleImpressions) * 100).toFixed(1))
        : null,
      rowLimit: QUERY_ROWS,
      note:
        "The ranked query rows never sum to the property total: Google withholds queries too rare to anonymise and caps how many rows it will return. Every total on this route comes from the daily rows instead, which do match Google's own figure exactly.",
    },
    sitemaps: {
      properties: withSitemaps.length,
      /* Three counts, because there are three states and folding them gives a
         number too big to act on — the same rule /api/domains keeps between
         auto-renew off and auto-renew unknown. */
      none: properties.filter((p) => p.sitemaps.state === "none").length,
      unreadable: properties.filter((p) => p.sitemaps.state === "failed").length,
      submitted: withSitemaps.reduce((a, p) => a + (p.sitemaps.submitted ?? 0), 0),
      errors: withSitemaps.reduce((a, p) => a + (p.sitemaps.errors ?? 0), 0),
      warnings: withSitemaps.reduce((a, p) => a + (p.sitemaps.warnings ?? 0), 0),
    },
    /*
      What this API will not say, as a property of Search Console rather than a
      gap in the collector — the same block /api/stock and /api/costs carry, so
      a reader who goes looking for a missing figure finds out why instead of
      assuming something is broken.
    */
    cannot: [
      "anything about the last three days — Search Console has not finalised them, and a partial day drawn on a line is a fall that never happened",
      "a true top-queries list: rare queries are withheld to keep searchers anonymous and the row count is capped, so the ranked rows are a sample of the impressions and never all of them",
      "how many pages are indexed — that is the Index Coverage report, which has no API at all; the sitemap figures here are what was SUBMITTED, which is a different claim",
      "why a position moved. Search Console reports the rank, never the reason for it",
    ],
    seenAt: sites.map((s) => s.seen_at).sort().at(-1) ?? null,
    generatedAt: new Date().toISOString(),
  });
});
