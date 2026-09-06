/**
 * Umami — the websites, their windows and their rankings, computed on read.
 *
 * THE ONE FIGURE THIS ROUTE REFUSES TO PRODUCE, and it is the headline one:
 * there is NO PORTFOLIO VISITOR COUNT. Umami de-duplicates visitors per
 * website over the window it was asked about, so a person who read the blog
 * and then the docs site is one visitor on each and one person in the world;
 * adding the two would count them twice, and there is no request to any Umami
 * endpoint that would give the honest answer, because the instance does not
 * join identity across sites. `portfolio.visitors.combined` is therefore null
 * with the reason beside it — the same shape `/api/mobile` uses for a currency
 * total it cannot compute. Pageviews and visits DO add: a pageview is a
 * pageview whichever site served it.
 *
 * BOUNCE RATE AND AVERAGE VISIT ARE COMPUTED HERE, NEVER STORED. Umami returns
 * `bounces` and `visits` and `totaltime`; the rate and the average are
 * divisions, and a stored division is a figure that decays and then disagrees
 * with the table beside it. The same rule the npm weeks, the domain countdowns
 * and the Search Console windows are built on.
 *
 * A BOUNCE IS UMAMI'S DEFINITION AND NOT AN INDUSTRY ONE. Umami counts a visit
 * with a single pageview as a bounce; Google Analytics 4 does not have the
 * concept at all and reports "engaged sessions" instead. So a bounce rate here
 * is not comparable to a bounce rate from anywhere else and the document says
 * so in `notes` rather than leaving a reader to assume.
 *
 * DAYS ARE THE INSTANCE'S DAYS. Umami buckets by the timezone its own
 * configuration names, and this box does not know what that is — so
 * `days[].day` is a label from the instance, not a UTC date this code chose,
 * and a figure from it is never joined to a UTC-dated figure from another
 * integration.
 *
 * THE RANKINGS ARE RANKINGS. Top pages, referrers and events are the top
 * twenty of a list Umami truncated: they sum to less than the window's
 * pageviews by an amount nobody here can measure, and `top.*.total` is
 * deliberately absent. Search Console's rows keep the same rule for the same
 * reason.
 */
import { Hono } from "hono";
import { accountRows } from "../../db.ts";
import {
  umamiDaysSince,
  umamiTop,
  umamiWebsites,
  umamiWindows,
  type UmamiWindowRow,
} from "./store.ts";
import { dimensionsOf } from "../webanalytics/store.ts";
import { TOP_LIMIT, WINDOW_DAYS } from "./umami.ts";

export const umamiRoutes = new Hono();

/** How much of the daily line a read may ask for. The collector stores ninety
 *  days; more than that is a window this integration has never held. */
const MAX_DAYS = 90;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A percentage change, or null when there is nothing to divide by. A jump
 *  from zero is not "+100%" and not "+∞"; it is a start, and the caller is
 *  handed `previous: 0` and told to say so. */
function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Umami's own definition: a visit with one pageview. Null rather than zero
 *  when there were no visits to divide by. */
function bounceRate(bounces: number | null, visits: number | null): number | null {
  if (bounces === null || visits === null || visits === 0) return null;
  return Math.round((bounces / visits) * 1000) / 10;
}

/** Seconds, not minutes, and null when there is no visit to average over. */
function avgVisitSeconds(totaltime: number | null, visits: number | null): number | null {
  if (totaltime === null || visits === null || visits === 0) return null;
  return Math.round(totaltime / visits);
}

const shapeWindow = (w: UmamiWindowRow | undefined) =>
  w
    ? {
        days: w.window_days,
        start: w.start_day,
        end: w.end_day,
        pageviews: w.pageviews,
        visitors: w.visitors,
        visits: w.visits,
        bounces: w.bounces,
        totaltime: w.totaltime,
        bounceRate: bounceRate(w.bounces, w.visits),
        avgVisitSeconds: avgVisitSeconds(w.totaltime, w.visits),
        seenAt: w.seen_at,
      }
    : null;

const shapePrevious = (w: UmamiWindowRow | undefined) =>
  w
    ? {
        pageviews: w.prev_pageviews,
        visitors: w.prev_visitors,
        visits: w.prev_visits,
        bounces: w.prev_bounces,
        totaltime: w.prev_totaltime,
        bounceRate: bounceRate(w.prev_bounces, w.prev_visits),
        avgVisitSeconds: avgVisitSeconds(w.prev_totaltime, w.prev_visits),
      }
    : null;

umamiRoutes.get("/", (c) => {
  const days = clamp(Number(c.req.query("days") ?? MAX_DAYS) || MAX_DAYS, 1, MAX_DAYS);

  const labels = new Map(accountRows("umami").map((a) => [a.id, a.label]));
  const sites = umamiWebsites();
  const windows = umamiWindows();
  const top = umamiTop();
  const dayRows = umamiDaysSince(days);

  const key = (accountId: number, websiteId: string) => `${accountId}:${websiteId}`;

  const windowBy = new Map<string, UmamiWindowRow>();
  for (const w of windows) windowBy.set(key(w.account_id, w.website_id), w);

  const daysBy = new Map<string, { day: string; pageviews: number; sessions: number }[]>();
  for (const d of dayRows) {
    const k = key(d.account_id, d.website_id);
    const held = daysBy.get(k) ?? [];
    held.push({ day: d.day, pageviews: d.pageviews, sessions: d.sessions });
    daysBy.set(k, held);
  }

  const topBy = new Map<string, { name: string; count: number }[]>();
  for (const t of top) {
    const k = `${key(t.account_id, t.website_id)}:${t.kind}`;
    const held = topBy.get(k) ?? [];
    held.push({ name: t.name, count: t.count });
    topBy.set(k, held);
  }

  /**
   * REFERRERS COME FROM THE DEEP TABLE WHERE THERE IS ONE.
   *
   * The same endpoint, the same span and the same population were being read
   * twice: a top-20 ranking on one collector's clock and a 500-row
   * distribution on another's. The shares and the "top referrer" disagreed
   * between two pages with nothing on either saying which read was older. The
   * distribution is the deeper of the two and is the one published; the
   * ranking is the fallback for a website the deep collector's rotation has
   * not reached yet, which is a real state and not an empty list.
   *
   * The `umami_top` referrer rows are now redundant and its collector should
   * stop writing them. They are LEFT IN PLACE rather than dropped: they are
   * the only referrer history a box has until the deep collector has been
   * round every site.
   */
  const referrersOf = (websiteId: string, fallback: { name: string; count: number }[]) => {
    const rows = dimensionsOf(websiteId, WINDOW_DAYS, 0).filter((r) => r.dimension === "referrer");
    if (!rows.length) return { rows: fallback, source: "umami_top", depth: TOP_LIMIT };
    return {
      rows: rows.map((r) => ({ name: r.value, count: r.count })),
      source: "web_dimensions",
      depth: rows.length,
    };
  };

  const websites = sites.map((s) => {
    const k = key(s.account_id, s.website_id);
    const w = windowBy.get(k);
    const window = shapeWindow(w);
    const previous = shapePrevious(w);
    const referrers = referrersOf(s.website_id, topBy.get(`${k}:referrer`) ?? []);
    return {
      accountId: s.account_id,
      account: labels.get(s.account_id) ?? `#${s.account_id}`,
      /** The stable key `venture_links` points at. See `/entities`. */
      entity: s.website_id,
      websiteId: s.website_id,
      name: s.name,
      domain: s.domain,
      seenAt: s.seen_at,
      window,
      previous,
      deltas: window &&
        previous && {
          pageviews: delta(window.pageviews, previous.pageviews),
          visitors: delta(window.visitors, previous.visitors),
          visits: delta(window.visits, previous.visits),
          bounceRate: delta(window.bounceRate, previous.bounceRate),
          avgVisitSeconds: delta(window.avgVisitSeconds, previous.avgVisitSeconds),
        },
      days: daysBy.get(k) ?? [],
      top: {
        pages: topBy.get(`${k}:url`) ?? [],
        referrers: referrers.rows,
        /** Which table the referrer ranking came from, and how deep it goes.
         *  A reader comparing two pages can tell whether they read the same
         *  list. */
        referrersFrom: referrers.source,
        referrersDepth: referrers.depth,
        events: topBy.get(`${k}:event`) ?? [],
      },
    };
  });

  /* THE PORTFOLIO. Two of the five figures add and one of them famously does
     not — see the header. `bounces` and `totaltime` add because both are
     counts of events on one site each; the RATE across sites is computed from
     those sums rather than averaged, because an average of two percentages
     weights a site with four visits like a site with four thousand. */
  const withWindow = websites.filter((w) => w.window);
  const sum = (pick: (w: (typeof websites)[number]) => number | null) => {
    const values = withWindow.map(pick).filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const pageviews = sum((w) => w.window!.pageviews);
  const visits = sum((w) => w.window!.visits);
  const bounces = sum((w) => w.window!.bounces);
  const totaltime = sum((w) => w.window!.totaltime);

  const prevPageviews = sum((w) => w.previous?.pageviews ?? null);
  const prevVisits = sum((w) => w.previous?.visits ?? null);

  /* The daily line for the whole portfolio. Pageviews and sessions add across
     sites for the same reason the window figures do; there is no portfolio
     VISITORS line and there cannot be one. */
  const perDay = new Map<string, { pageviews: number; sessions: number }>();
  for (const d of dayRows) {
    const held = perDay.get(d.day) ?? { pageviews: 0, sessions: 0 };
    held.pageviews += d.pageviews;
    held.sessions += d.sessions;
    perDay.set(d.day, held);
  }
  const portfolioDays = [...perDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, v]) => ({ day, ...v }));

  return c.json({
    websites,
    portfolio: {
      websites: websites.length,
      answering: withWindow.length,
      /** The whole portfolio's daily line. Pageviews and sessions add across
       *  sites for the reason the window figures do; there is no portfolio
       *  visitors line here either, and for the same reason. */
      days: portfolioDays,
      window: {
        days: WINDOW_DAYS,
        start: withWindow[0]?.window?.start ?? null,
        end: withWindow[0]?.window?.end ?? null,
        pageviews,
        visits,
        bounces,
        totaltime,
        bounceRate: bounceRate(bounces, visits),
        avgVisitSeconds: avgVisitSeconds(totaltime, visits),
      },
      previous: { pageviews: prevPageviews, visits: prevVisits },
      deltas: {
        pageviews: delta(pageviews, prevPageviews),
        visits: delta(visits, prevVisits),
      },
      /** THE ONE THAT IS NULL ON PURPOSE. See the header. */
      visitors: {
        combined: null,
        /* A LIST RATHER THAN AN OBJECT KEYED BY WEBSITE ID, because two
           instances can serve the same site and an object would silently keep
           one of the two figures. Each row names the account it came from. */
        perSite: withWindow.map((w) => ({
          accountId: w.accountId,
          account: w.account,
          entity: w.entity,
          domain: w.domain,
          visitors: w.window!.visitors,
        })),
        note:
          "Visitors are de-duplicated per website over the window, so they " +
          "cannot be added across sites: one person who read two of them is " +
          "one visitor on each and one person in the world. No Umami endpoint " +
          "can join identity across websites, so there is no combined figure " +
          "to fetch either. Quote them per site.",
      },
    },
    notes: {
      window:
        `The window figures are the last ${WINDOW_DAYS} COMPLETE days as the ` +
        "instance counted them, against the same length of window immediately " +
        "before. Today is in neither: a partial day drawn beside finished ones " +
        "reads as a collapse.",
      days:
        `The daily line is the last ${days} days held (up to ${MAX_DAYS}). Days ` +
        "are bucketed in the INSTANCE'S timezone, which this box does not know " +
        "— so a day here is not necessarily a UTC day and is never joined to " +
        "one from another integration.",
      bounce:
        "A bounce is Umami's own definition: a visit with a single pageview. " +
        "It is not comparable to GA4, which reports engaged sessions instead.",
      top:
        `Top pages and events are the top ${TOP_LIMIT} of a list the instance ` +
        "truncated. They are a RANKING and never a total — they sum to " +
        "less than the window's pageviews by an amount nothing here can measure. " +
        "Referrers come from the deep distribution where one has been collected " +
        "for the site — `top.referrersFrom` says which table answered and " +
        "`top.referrersDepth` how many rows it holds — and referrer rows count " +
        "VIEWS, which is not the population the visitor figures count.",
      avgVisit: "Average visit is seconds, computed as totaltime ÷ visits at read time.",
    },
  });
});

/**
 * The entities a venture can be linked to: one per website.
 *
 * `host` is the domain Umami has for the site, which is exactly the string a
 * venture's own `host` would match — so a venture at example.com can be
 * auto-linked to its analytics website without anybody typing an id.
 */
umamiRoutes.get("/entities", (c) => {
  const labels = new Map(accountRows("umami").map((a) => [a.id, a.label]));
  return c.json({
    entities: umamiWebsites().map((s) => ({
      plugin: "umami",
      entity: s.website_id,
      label: s.name ?? s.domain ?? s.website_id,
      host: s.domain,
      account: labels.get(s.account_id) ?? `#${s.account_id}`,
    })),
  });
});
