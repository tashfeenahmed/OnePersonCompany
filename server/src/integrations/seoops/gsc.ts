/**
 * ONE URL'S SEARCH CONSOLE ROW — which is a different measurement from the one
 * `providers/gsc.ts` collects, and the difference is the whole reason this
 * file exists.
 *
 * THE COLLECTOR ASKS FOR A RANKING; THIS ASKS ABOUT A PAGE. `collectProperty`
 * requests the top 25 pages of a property, sorted by clicks, and stores them.
 * That is exactly right for "which pages matter here" and it is useless for
 * "did the page I rewrote move", because the page I rewrote is usually not in
 * the top 25 — that is often WHY it was rewritten. Reading a missing page as
 * zero would manufacture a catastrophic drop out of a report that simply
 * stopped listing, which is the single worst mistake available in this area
 * and the one the whole thing is arranged around.
 *
 * SO THE PRIMARY READ IS A FILTERED QUERY. `searchAnalytics` with a
 * `dimensionFilterGroups` naming the page and NO dimensions returns Google's
 * own dimensionless total for that one URL: exact, uncapped, and the same
 * arithmetic the property total is. There is no ranking involved and therefore
 * no cap to fall off the end of. It costs one request per reading.
 *
 * THE FALLBACK IS THE STORED TABLE AND IT SAYS SO. With no credential, or when
 * Google will not answer, this reads `gsc_pages` — the capped ranking the
 * collector stored — and a URL absent from it comes back `measured: false`
 * with the sentence about the cap on it. Never a zero. The reading's `source`
 * column says which of the two answered, so a chart drawn from a mixture can
 * say which points are exact.
 *
 * THE PROPERTY IS RESOLVED FROM THE URL'S HOST, and a URL whose host matches
 * no property this box can see is `measured: false` too, with a different
 * sentence: nothing can measure it, which is not the same as measuring nothing.
 */
import * as accounts from "../../accounts.ts";
import { db } from "../../db.ts";
import {
  accessToken,
  readServiceAccount,
  searchAnalytics,
  window as gscWindow,
  type ApiRow,
} from "../../providers/gsc.ts";
import { QUERY_ROWS, WINDOW_DAYS, hostOf, sameHost } from "./settings.ts";

/* ----------------------------------------------------------- the property */

export type PropertyRow = { property: string; account_id: number };

/**
 * WHICH PROPERTY COVERS THIS URL.
 *
 * Two forms and both are matched. `sc-domain:example.com` covers every host
 * under the domain; `https://example.com/docs/` covers only URLs beneath that
 * prefix. Where several match, the LONGEST prefix wins and a URL-prefix
 * property beats a domain one — Search Console's own precedence, and the one
 * whose figures the owner will see if they open the console to check.
 */
export function resolveProperty(url: string, rows: PropertyRow[]): PropertyRow | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const host = hostOf(target.hostname);
  let best: { row: PropertyRow; score: number } | null = null;

  for (const row of rows) {
    let score = -1;
    if (row.property.startsWith("sc-domain:")) {
      const domain = hostOf(row.property.slice("sc-domain:".length));
      if (sameHost(host, domain)) score = 1;
    } else {
      /* A URL-prefix property is a string prefix in Search Console's own
         model, and it is compared as one — with the scheme, because
         http://x.com/ and https://x.com/ are two different properties there. */
      const prefix = row.property.endsWith("/") ? row.property : `${row.property}/`;
      const full = target.href.endsWith("/") ? target.href : `${target.href}/`;
      if (full.startsWith(prefix)) score = 1000 + prefix.length;
    }
    if (score < 0) continue;
    if (!best || score > best.score) best = { row, score };
  }
  return best?.row ?? null;
}

export function propertyRows(): PropertyRow[] {
  try {
    return db
      .prepare("SELECT property, account_id FROM gsc_sites")
      .all() as unknown as PropertyRow[];
  } catch {
    /* No gsc_sites table on a box where the collector has never run. Not a
       failure of this feature; an absence, reported as one. */
    return [];
  }
}

/* -------------------------------------------------------------- a reading */

export type PageQuery = {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
};

export type PageReading = {
  /** False means Search Console has no row for this URL in this window, or
   *  could not be asked. NEVER rendered as zero. */
  measured: boolean;
  /** 'live-filtered' — Google's own dimensionless total for this one URL.
   *  'stored-capped' — the collector's top-N page ranking, which a page can
   *  fall off the end of. 'none' — nothing answered. */
  source: "live-filtered" | "stored-capped" | "none";
  property: string | null;
  window: { start: string; end: string; days: number };
  clicks: number | null;
  impressions: number | null;
  /** A percentage, like every other rate on this box. Google sends a fraction. */
  ctr: number | null;
  position: number | null;
  siteClicks: number | null;
  siteImpressions: number | null;
  queries: PageQuery[];
  error: string | null;
};

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const real = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function pageFilter(url: string) {
  return {
    dimensionFilterGroups: [
      { filters: [{ dimension: "page", operator: "equals", expression: url }] },
    ],
  };
}

/**
 * The token for the account that owns a property, or a sentence saying why
 * there is none. One account is asked, not all of them: a property belongs to
 * exactly one credential here, and trying the others would be asking Google
 * about somebody else's site.
 */
async function tokenFor(accountId: number): Promise<{ token: string } | { error: string }> {
  const { ready, broken } = accounts.credentialed("gsc", ["json"], "seoops_baseline");
  const mine = ready.find((r) => r.account.id === accountId);
  if (!mine) {
    const missing = broken.find((b) => b.account.id === accountId);
    return {
      error: missing
        ? `The Search Console account that owns this property has no service-account JSON stored.`
        : `The Search Console account that owns this property is no longer connected.`,
    };
  }
  try {
    return { token: await accessToken(readServiceAccount(mine.values.json ?? "")) };
  } catch (err) {
    return {
      error: `Google would not mint a token for that key: ${
        err instanceof Error ? err.message.slice(0, 160) : "unknown error"
      }`,
    };
  }
}

/** The stored ranking, which is a FLOOR and a cap at the same time. */
function storedRow(property: string, url: string): { clicks: number; impressions: number; ctr: number | null; position: number | null } | null {
  try {
    const row = db
      .prepare("SELECT clicks, impressions, ctr, position FROM gsc_pages WHERE property = ? AND page = ?")
      .get(property, url) as { clicks: number; impressions: number; ctr: number | null; position: number | null } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * READ ONE URL OVER THE TRAILING WINDOW.
 *
 * Never throws. Every failure becomes an unmeasured reading carrying the
 * sentence that says which of the four things went wrong — no property, no
 * credential, Google refused, or Google answered and had nothing for this URL.
 * A caller that only looked at `clicks` would see null in all four cases,
 * which is why `measured` and `error` travel with every one of them.
 */
export async function readUrl(url: string, days = WINDOW_DAYS): Promise<PageReading> {
  const w = gscWindow(days);
  const blank: PageReading = {
    measured: false,
    source: "none",
    property: null,
    window: { ...w, days },
    clicks: null,
    impressions: null,
    ctr: null,
    position: null,
    siteClicks: null,
    siteImpressions: null,
    queries: [],
    error: null,
  };

  const property = resolveProperty(url, propertyRows());
  if (!property)
    return {
      ...blank,
      error:
        "No Search Console property this box can see covers that URL. Add the " +
        "site's property to the connected service account, or check the scheme " +
        "— a URL-prefix property for https does not cover an http URL.",
    };

  const got = await tokenFor(property.account_id);
  if ("error" in got) {
    /* THE STORED RANKING, EXPLICITLY LABELLED. It is a worse measurement and
       it is a real one, and saying which it is costs a string. */
    const stored = storedRow(property.property, url);
    return {
      ...blank,
      property: property.property,
      source: stored ? "stored-capped" : "none",
      measured: Boolean(stored),
      clicks: stored?.clicks ?? null,
      impressions: stored?.impressions ?? null,
      ctr: stored?.ctr ?? null,
      position: stored?.position ?? null,
      error: stored
        ? `${got.error} These figures come from the collector's stored page ranking, which is capped at the top 25 pages by clicks and describes the window on gsc_sites rather than this one.`
        : `${got.error} There is no stored row for this URL either, and a page missing from a capped ranking is UNMEASURED, not zero.`,
    };
  }

  let rows: ApiRow[];
  try {
    rows = await searchAnalytics(got.token, property.property, {
      startDate: w.start,
      endDate: w.end,
      rowLimit: 1,
      ...pageFilter(url),
    });
  } catch (err) {
    const stored = storedRow(property.property, url);
    const why = err instanceof Error ? err.message.slice(0, 180) : "Search Console did not answer.";
    return {
      ...blank,
      property: property.property,
      source: stored ? "stored-capped" : "none",
      measured: Boolean(stored),
      clicks: stored?.clicks ?? null,
      impressions: stored?.impressions ?? null,
      ctr: stored?.ctr ?? null,
      position: stored?.position ?? null,
      error: stored
        ? `${why} Falling back to the collector's stored top-25 page ranking, which is capped and describes a different window.`
        : `${why} A page absent from the stored capped ranking is UNMEASURED, not zero.`,
    };
  }

  const row = rows[0];
  if (!row) {
    /*
      GOOGLE ANSWERED AND HAD NO ROW. This is the one case where the honest
      reading is close to a zero and still is not one: a filtered query with no
      row means Search Console recorded no impression for this EXACT URL string
      in the window — which is also what a trailing slash, a different case or
      a canonical the crawler prefers looks like. So it is `measured: false`
      with both possibilities named, and nothing downstream computes a
      percentage from it.
    */
    return {
      ...blank,
      property: property.property,
      source: "live-filtered",
      error:
        "Search Console returned no row for that exact URL in the window. That " +
        "is either no impressions at all, or a URL that differs from the one " +
        "Google indexed (a trailing slash, a case difference, or a canonical " +
        "pointing elsewhere). It is not a measured zero.",
    };
  }

  const impressions = int(row.impressions);
  const reading: PageReading = {
    measured: true,
    source: "live-filtered",
    property: property.property,
    window: { ...w, days },
    clicks: int(row.clicks),
    impressions,
    ctr: real(row.ctr) === null ? null : Number((real(row.ctr)! * 100).toFixed(2)),
    /* Null with no impressions, providers/gsc.ts's rule: Google answers 0.0
       there and an average position of zero is not a rank. */
    position: impressions > 0 ? real(row.position) : null,
    siteClicks: null,
    siteImpressions: null,
    queries: [],
    error: null,
  };

  /* The property's own total over the same window, so a page that fell with
     everything else can be told from a page that fell on its own. Its failure
     costs the site figures and nothing else. */
  try {
    const site = await searchAnalytics(got.token, property.property, {
      startDate: w.start,
      endDate: w.end,
      rowLimit: 1,
    });
    if (site[0]) {
      reading.siteClicks = int(site[0].clicks);
      reading.siteImpressions = int(site[0].impressions);
    }
  } catch {
    /* Degrades alone. */
  }

  /* What the page is shown FOR, which is what turns "impressions up, clicks
     flat" into a sentence somebody can act on. Capped, sorted by clicks by
     Google, and never summed against the page total above. */
  if (impressions > 0) {
    try {
      const q = await searchAnalytics(got.token, property.property, {
        startDate: w.start,
        endDate: w.end,
        dimensions: ["query"],
        rowLimit: QUERY_ROWS,
        ...pageFilter(url),
      });
      reading.queries = q
        .filter((r) => (r.keys ?? []).length > 0)
        .map((r) => ({
          query: r.keys![0]!,
          clicks: int(r.clicks),
          impressions: int(r.impressions),
          ctr: real(r.ctr) === null ? null : Number((real(r.ctr)! * 100).toFixed(2)),
          position: real(r.position),
        }));
    } catch {
      /* Degrades alone. */
    }
  }

  return reading;
}
