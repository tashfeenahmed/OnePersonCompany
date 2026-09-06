/**
 * THE DEEP UMAMI READ — dimensions, events, event properties and UTM tags.
 *
 * A SECOND COLLECTOR ON THE SAME CREDENTIAL, AND WHY THAT IS RIGHT RATHER THAN
 * A DUPLICATE. `analytics/collect.ts` reads the headline: five figures, a
 * ninety-day line and three top-twenties, six requests a site, every six
 * hours. It is what the dashboard's cards are drawn from and it must stay
 * cheap. This reads roughly FIFTY requests a site — seven dimensions over
 * three windows, the query strings, the event list, then two more requests per
 * event name — and it must therefore be slow, budgeted and rotated. Two jobs
 * with two costs and two clocks is two collectors; one collector doing both
 * would make the cheap half as expensive as the dear half.
 *
 * IT REGISTERS UNDER ITS OWN PLUGIN ID. `manifestCollectors()` merges by
 * plugin id across every area, so an entry under `umami` would SILENTLY
 * REPLACE the collector that keeps the headline figures current. This one is
 * `webanalytics`, which nothing else uses.
 *
 * THE ROTATION IS THE POINT. Each website carries its own clock. A pass takes
 * the `sitesPerPass` sites that are due and least recently read, reads them in
 * full, and stops — so a run never grows with the portfolio, a site added this
 * morning is read on the next tick rather than tomorrow, and the load on
 * somebody's own analytics server is a number the owner sets rather than a
 * consequence of how many sites they have.
 *
 * FAILURE IS PER SITE AND PER READ WITHIN IT. A site whose event-data endpoint
 * refuses keeps its dimensions; a dimension that refuses keeps the rows it had
 * last time, because a refused read is not news that the traffic did not
 * happen. Every refusal is a warning on the run with the endpoint named.
 */
import * as accounts from "../../accounts.ts";
import * as umami from "../analytics/umami.ts";
import type { DimensionRow, SiteWindowRow } from "./store.ts";
import {
  clockAt,
  due,
  forgetEvents,
  markClock,
  noteFinding,
  replaceDimensions,
  replaceUtm,
  writeEvent,
  writeEventProp,
  writeSiteWindow,
} from "./store.ts";
import { findings, type BotInput } from "./bots.ts";
import { SITE_EVERY_HOURS, sitesPerPass, unitFor } from "./settings.ts";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The three windows every dimension is read over, and which dimensions get
 * which.
 *
 * THE 30-DAY WINDOW IS THE DISTRIBUTION and every dimension has one: "who is
 * this audience" is a question about a month, because a week of a small site
 * is a week of noise. THE TWO SEVEN-DAY WINDOWS ARE THE COMPARISON and only
 * the three dimensions the surge heuristics test get them — country, referrer
 * and screen. Reading device, browser, OS and language over three windows
 * instead of one would triple their cost to answer a question nothing asks.
 */
const SURGE_DIMENSIONS: umami.Dimension[] = ["country", "referrer", "screen"];

/** A courtesy gap between requests to somebody's own analytics server. The
 *  same 300 ms the Bluesky collector uses; Umami has no published limit and
 *  this box should not be the reason one gets added. */
const GAP_MS = 120;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * THE CEILING ON ONE PASS, IN REQUESTS RATHER THAN IN SITES.
 *
 * `sitesPerPass` caps sites, and a site is about fifty requests — so the two
 * are the same thing until a site has fifty event names, at which point they
 * are not. This is the number that actually reaches somebody else's server,
 * and it is what stops one badly instrumented site from spending a pass's
 * whole budget. Six times the per-site cost of the default four sites, so it
 * never binds on an ordinary portfolio and always binds on a runaway one.
 */
const MAX_REQUESTS_PER_PASS = 1200;

/**
 * A refusal that must STOP the pass rather than be counted and continued.
 *
 * Every read in this file catches its own failure and carries on, which is
 * right for a 404 on one dimension and exactly wrong for a rate limit: an
 * instance answering 429 receives all ~192 remaining requests of the pass,
 * produces ~192 warnings, and is hit again in thirty minutes. A 429 or a 5xx
 * is the server asking to be left alone, and the honest response is to stop,
 * say so, and NOT mark the clocks — a two-minute outage must not cost a site
 * twelve hours of freshness.
 */
class BackOff extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BackOff";
    this.status = status;
  }
}

/** Is this the instance asking to be left alone? */
function backOff(err: unknown): BackOff | null {
  if (err instanceof BackOff) return err;
  if (err instanceof umami.UmamiError && (err.status === 429 || err.status >= 500))
    return new BackOff(err.status, err.message);
  return null;
}

/** How many characters of joined warnings a run row may carry. A run row is
 *  read on a page; two hundred sentences in one field is a page of noise that
 *  hides the one that mattered. */
export const MAX_ERROR_CHARS = 1000;

export function boundedError(warnings: string[]): string | null {
  if (!warnings.length) return null;
  const joined = warnings.join("; ");
  if (joined.length <= MAX_ERROR_CHARS) return joined;
  const kept: string[] = [];
  let size = 0;
  for (const w of warnings) {
    if (size + w.length + 2 > MAX_ERROR_CHARS - 80) break;
    kept.push(w);
    size += w.length + 2;
  }
  return `${kept.join("; ")}; … and ${warnings.length - kept.length} more warning(s) not shown.`;
}

/** A per-pass request counter, passed down so every read shares one budget. */
type Budget = { spent: number; cap: number };
const spend = (b: Budget) => {
  b.spent++;
  if (b.spent > b.cap)
    throw new BackOff(0, `this pass reached its ceiling of ${b.cap} requests and stopped there`);
};

/**
 * THE HALF THAT READS UMAMI. It opens no run row and closes none.
 *
 * THAT IS DELIBERATE AND IT WAS A BUG BEFORE IT WAS A DECISION. This function
 * used to call `startRun`/`finishRun` itself, and the run row was therefore
 * CLOSED before the Meta half had run — so the ad-level work was invisible on
 * the plugin page even when it had just written a thousand rows. One collector
 * is one run row, so the manifest owns it and both halves report upward.
 */
export type WebOutcome = { ok: boolean; note: string | null; warnings: string[]; websites: number };

export async function collectWebAnalytics(): Promise<WebOutcome> {
  const ready = accounts.credentialed("umami", ["url"], "collect_webanalytics").ready;

  if (!ready.length)
    return {
      ok: false,
      note: null,
      warnings: [
        "No Umami instance is connected. This area reads the same credential the Umami plugin holds; connect one there.",
      ],
      websites: 0,
    };

  const siteBudget = sitesPerPass();
  const budget: Budget = { spent: 0, cap: MAX_REQUESTS_PER_PASS };
  const warnings: string[] = [];
  let read = 0;
  let considered = 0;
  let stopped: string | null = null;

  for (const { account, values } of ready) {
    if (read >= siteBudget || stopped) break;
    let session: umami.Session;
    let sites: umami.Website[];
    try {
      spend(budget);
      session = await umami.open(values as umami.Credentials);
      spend(budget);
      sites = await umami.websites(session);
    } catch (err) {
      const back = backOff(err);
      if (back) {
        stopped = `${account.label}: ${back.message} — the pass stopped and no clock was marked.`;
        warnings.push(stopped);
        break;
      }
      const error = message(err);
      accounts.markFailed(account.id, error);
      warnings.push(`${account.label}: ${error}`);
      continue;
    }
    accounts.markOk(account.id);
    considered += sites.length;

    /* LEAST RECENTLY READ FIRST, never-read first of all. A stable order over
       a rotation is the difference between every site being read eventually
       and the first four being read forever. */
    const queue = sites
      .filter((s) => due("web-site", `${account.id}:${s.id}`, SITE_EVERY_HOURS))
      .sort((a, b) => {
        const at = clockAt("web-site", `${account.id}:${a.id}`) ?? "";
        const bt = clockAt("web-site", `${account.id}:${b.id}`) ?? "";
        return at.localeCompare(bt);
      });

    for (const site of queue) {
      if (read >= siteBudget) break;
      try {
        await collectSite(session, account.id, site, warnings, budget);
        markClock("web-site", `${account.id}:${site.id}`);
        read++;
      } catch (err) {
        const back = backOff(err);
        if (back) {
          /* NO CLOCK ON THIS PATH. A site skipped because the instance asked
             to be left alone has not been read, and marking it would cost it
             twelve hours of freshness for a two-minute outage. */
          stopped =
            `${account.label} · ${site.domain ?? site.id}: ${back.message} — the pass stopped ` +
            `there and no clock was marked for it.`;
          warnings.push(stopped);
          break;
        }
        warnings.push(`${account.label} · ${site.domain ?? site.id}: ${message(err)}`);
        /* The clock IS marked for an ordinary failure: a site that refuses
           every pass would otherwise sit at the head of the queue forever and
           starve the rest of the portfolio of their turn. A back-off is the
           one exception, above. */
        markClock("web-site", `${account.id}:${site.id}`);
        read++;
      }
    }
    if (stopped) break;
  }

  const note =
    (read === 0
      ? "no website was read"
      : `${read} website${read === 1 ? "" : "s"} read in full of ${considered}` +
        (warnings.length ? ` · ${warnings.length} warning(s)` : "")) +
    (stopped ? " · stopped early" : "");
  return { ok: true, note, warnings, websites: read };
}

/* ------------------------------------------------------------- one site */

async function collectSite(
  session: umami.Session,
  accountId: number,
  site: umami.Website,
  warnings: string[],
  budget: Budget,
) {
  const label = site.domain ?? site.name ?? site.id;
  const spans = [
    { days: 30, offset: 0, ...umami.windowAt(30, 0) },
    { days: 7, offset: 0, ...umami.windowAt(7, 0) },
    { days: 7, offset: 7, ...umami.windowAt(7, 7) },
  ];

  /* ---- the site's own figures for each window, which every share needs as
         a denominator and every adjusted figure needs as its raw ---- */
  const windows = new Map<string, SiteWindowRow>();
  for (const span of spans) {
    try {
      spend(budget);
      const s = await umami.stats(session, site.id, span.start, span.end);
      const row = toWindowRow(accountId, site.id, span, s);
      writeSiteWindow(row);
      windows.set(`${span.days}:${span.offset}`, { ...row, source: "web_site_windows" });
      await sleep(GAP_MS);
    } catch (err) {
      if (backOff(err)) throw err;
      warnings.push(`${label}: /stats ${span.days}d+${span.offset} — ${message(err)}`);
    }
  }

  /* ---- the distributions ---- */
  const dimensions = new Map<string, DimensionRow[]>();
  for (const span of spans) {
    /* THE MONTH AND THE CURRENT WEEK GET EVERY DIMENSION, so a segment page
       can put "this week" beside "this month" on one axis. THE WEEK BEFORE
       GETS ONLY THE THREE THE SURGE HEURISTICS TEST: reading device, browser,
       OS and language over a third window would cost four more requests a
       site to answer a question nothing asks. */
    const wanted: readonly umami.Dimension[] = span.offset === 0 ? umami.DIMENSIONS : SURGE_DIMENSIONS;
    for (const dimension of wanted) {
      try {
        spend(budget);
        const { rows, capped } = await umami.breakdown(
          session,
          site.id,
          dimension,
          span.start,
          span.end,
        );
        const counts = umami.DIMENSION_COUNTS[dimension];
        replaceDimensions(
          accountId,
          site.id,
          dimension,
          span.days,
          span.offset,
          { startDay: span.startDay, endDay: span.endDay },
          counts,
          rows,
          capped,
        );
        if (capped)
          warnings.push(
            `${label}: ${dimension} ${span.days}d+${span.offset} came back at the ${umami.DIMENSION_LIMIT}-row ` +
              `limit — the tail is missing, so its shares are against a floor and the bot heuristics ` +
              `on that dimension were not run.`,
          );
        dimensions.set(
          `${dimension}:${span.days}:${span.offset}`,
          toDimensionRows(accountId, site.id, dimension, span, counts, rows, capped),
        );
        await sleep(GAP_MS);
      } catch (err) {
        if (backOff(err)) throw err;
        warnings.push(`${label}: ${dimension} ${span.days}d+${span.offset} — ${message(err)}`);
      }
    }
  }

  /* ---- the bot heuristics, run here so a first sighting gets its date ----
     They are also computed on every read by the route; this pass exists ONLY
     to stamp `first_seen`, which is the one thing a read cannot recover. */
  const input: BotInput = { windows, dimensions };
  for (const f of findings(input))
    noteFinding(accountId, site.id, f.heuristic, f.fingerprint, f.excluded);

  /* ---- UTM tags, out of the raw query strings ---- */
  for (const span of spans.filter((s) => s.offset === 0)) {
    try {
      spend(budget);
      const rows = await umami.queryStrings(session, site.id, span.start, span.end);
      const bucket = new Map<string, { tag: umami.Utm; views: number }>();
      for (const row of rows) {
        const tag = umami.parseUtm(row.name);
        if (!tag.source && !tag.medium && !tag.campaign && !tag.content && !tag.term) continue;
        const k = [tag.source, tag.medium, tag.campaign, tag.content, tag.term].join(" ");
        const at = bucket.get(k);
        if (at) at.views += row.count;
        else bucket.set(k, { tag, views: row.count });
      }
      replaceUtm(
        accountId,
        site.id,
        span.days,
        span.offset,
        { startDay: span.startDay, endDay: span.endDay },
        [...bucket.values()].map(({ tag, views }) => ({
          source: tag.source ?? "",
          medium: tag.medium ?? "",
          campaign: tag.campaign ?? "",
          content: tag.content ?? "",
          term: tag.term ?? "",
          views,
        })),
      );
      await sleep(GAP_MS);
    } catch (err) {
      if (backOff(err)) throw err;
      warnings.push(`${label}: query strings ${span.days}d — ${message(err)}`);
    }
  }

  /* ---- events, participants and properties, over the 30-day window ---- */
  const month = spans[0]!;
  try {
    spend(budget);
    const names = await umami.eventNames(session, site.id, month.start, month.end);
    forgetEvents(accountId, site.id, month.days);
    if (!names.length) return;

    /* One cheap request that decides whether the twelve dear ones are worth
       making: a site that has never sent an event property gets no property
       reads at all, and the absence reads as absence. */
    let hasProperties = true;
    try {
      spend(budget);
      const stats = await umami.eventDataStats(session, site.id, month.start, month.end);
      hasProperties = (stats.properties ?? 0) > 0;
    } catch (err) {
      if (backOff(err)) throw err;
      /* Unreadable is not "none": the property reads still happen and each
         one reports its own refusal. */
    }

    for (const row of names.slice(0, umami.EVENT_DETAIL_LIMIT)) {
      spend(budget);
      const p = await umami.participants(session, site.id, row.name, month.start, month.end);
      writeEvent({
        account_id: accountId,
        website_id: site.id,
        event_name: row.name,
        window_days: month.days,
        start_day: month.startDay,
        end_day: month.endDay,
        occurrences: row.count,
        participants: p.count,
        participants_source: p.count === null ? null : p.endpoint,
        participants_error: p.error,
      });
      await sleep(GAP_MS);

      if (!hasProperties) continue;
      try {
        spend(budget);
        const values = await umami.eventProperties(session, site.id, row.name, month.start, month.end);
        for (const prop of summariseProperties(values))
          writeEventProp({
            account_id: accountId,
            website_id: site.id,
            event_name: row.name,
            property: prop.property,
            data_type: prop.dataType,
            window_days: month.days,
            start_day: month.startDay,
            end_day: month.endDay,
            records: prop.records,
            distinct_values: prop.distinctValues,
            truncated: prop.truncated ? 1 : 0,
            num_count: prop.num?.count ?? null,
            num_sum: prop.num?.sum ?? null,
            num_avg: prop.num?.avg ?? null,
            num_min: prop.num?.min ?? null,
            num_max: prop.num?.max ?? null,
            unit: unitFor(row.name, prop.property),
            top_values: prop.topValues ? JSON.stringify(prop.topValues) : null,
          });
        await sleep(GAP_MS);
      } catch (err) {
        if (backOff(err)) throw err;
        warnings.push(`${label}: properties of ${row.name} — ${message(err)}`);
      }
    }

    /* The events past the detail limit are still recorded with their
       occurrence count and NO participant figure, because a null that says
       "not asked" is better than a missing row that reads as "never fired". */
    for (const row of names.slice(umami.EVENT_DETAIL_LIMIT))
      writeEvent({
        account_id: accountId,
        website_id: site.id,
        event_name: row.name,
        window_days: month.days,
        start_day: month.startDay,
        end_day: month.endDay,
        occurrences: row.count,
        participants: null,
        participants_source: null,
        participants_error: `Past the ${umami.EVENT_DETAIL_LIMIT}-event detail limit for this site; the participant count was not asked for.`,
      });
  } catch (err) {
    if (backOff(err)) throw err;
    warnings.push(`${label}: events — ${message(err)}`);
  }
}

/* --------------------------------------------------------------- shaping */

type Span = { days: number; offset: number; startDay: string; endDay: string };

function toWindowRow(
  accountId: number,
  websiteId: string,
  span: Span,
  s: umami.Stats,
): Omit<SiteWindowRow, "source"> {
  return {
    account_id: accountId,
    website_id: websiteId,
    window_days: span.days,
    offset_days: span.offset,
    start_day: span.startDay,
    end_day: span.endDay,
    pageviews: s.pageviews,
    visitors: s.visitors,
    visits: s.visits,
    bounces: s.bounces,
    totaltime: s.totaltime,
    seen_at: "",
  };
}

function toDimensionRows(
  accountId: number,
  websiteId: string,
  dimension: string,
  span: Span,
  counts: string,
  rows: umami.TopRow[],
  capped: boolean,
): DimensionRow[] {
  return rows.map((r) => ({
    account_id: accountId,
    website_id: websiteId,
    dimension,
    value: r.name,
    window_days: span.days,
    offset_days: span.offset,
    start_day: span.startDay,
    end_day: span.endDay,
    count: r.count,
    counts,
    capped: capped ? 1 : 0,
    seen_at: "",
  }));
}

/* ------------------------------------------------- the property aggregate */

export type PropertySummary = {
  property: string;
  dataType: string;
  records: number;
  distinctValues: number;
  truncated: boolean;
  num: { count: number; sum: number; avg: number; min: number; max: number } | null;
  topValues: { value: string; count: number }[] | null;
};

/**
 * The count, sum, mean and range of a numeric event property — computed here
 * because Umami does not publish one.
 *
 * `/event-data/events` answers each distinct VALUE with how often it occurred,
 * so the aggregate is over the complete population and is EXACT rather than
 * sampled — the sum is Σ(value × occurrences) and the mean is that over
 * Σ(occurrences), which is the value-weighted mean and not the mean of the
 * distinct values. Those two differ by a lot when one value dominates, and the
 * second one would be wrong.
 *
 * A VALUE THAT WILL NOT PARSE AS A NUMBER IS COUNTED AND EXCLUDED FROM THE
 * ARITHMETIC. `truncated` then says the aggregate does not cover every record,
 * and the aggregate itself is refused rather than published short — a sum that
 * quietly omits rows is worse than no sum.
 *
 * A NON-NUMERIC PROPERTY GETS A RANKING AND NO ARITHMETIC. `topValues` sums to
 * less than `records` whenever there were more distinct values than the cap,
 * and nothing may total it.
 */
export function summariseProperties(values: umami.PropertyValue[]): PropertySummary[] {
  const byProperty = new Map<string, umami.PropertyValue[]>();
  for (const v of values) byProperty.set(v.property, [...(byProperty.get(v.property) ?? []), v]);

  const out: PropertySummary[] = [];
  for (const [property, rows] of byProperty) {
    const dataType = umami.PROPERTY_TYPES[rows[0]!.dataType] ?? String(rows[0]!.dataType);
    const records = rows.reduce((a, r) => a + r.total, 0);
    const distinctValues = rows.length;

    if (dataType === "number") {
      let count = 0;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      let unparsed = 0;
      for (const r of rows) {
        const n = Number(r.value);
        if (!Number.isFinite(n)) {
          unparsed += r.total;
          continue;
        }
        count += r.total;
        sum += n * r.total;
        if (n < min) min = n;
        if (n > max) max = n;
      }
      const truncated = unparsed > 0;
      out.push({
        property,
        dataType,
        records,
        distinctValues,
        truncated,
        num:
          truncated || count === 0
            ? null
            : {
                count,
                sum: round(sum),
                avg: round(sum / count),
                min: round(min),
                max: round(max),
              },
        topValues: null,
      });
      continue;
    }

    out.push({
      property,
      dataType,
      records,
      distinctValues,
      truncated: distinctValues > umami.PROPERTY_VALUE_LIMIT,
      num: null,
      topValues: rows
        .slice()
        .sort((a, b) => b.total - a.total)
        .slice(0, umami.PROPERTY_VALUE_LIMIT)
        .map((r) => ({ value: r.value.slice(0, 120), count: r.total })),
    });
  }
  return out.sort((a, b) => b.records - a.records);
}

/** Four decimal places, which is what Umami stores a numeric property at. */
const round = (n: number) => Math.round(n * 10_000) / 10_000;
