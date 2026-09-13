import {
  webAnalytics,
  type Events,
  type Segments,
  type SiteRow,
  type Sites,
} from "@/areas/webanalytics/api";

/**
 * THE DEPTH UNDER THE HEADLINE FIGURES, fetched for the board.
 *
 * `/api/umami` says how many visitors a site had. This says WHO they were —
 * which country, which browser, which device — what a heuristic would take off
 * as automated, and what those visitors actually did once they arrived. Three
 * routes, one bundle, the `seoboard` shape: one failing must not empty the
 * other two, and nothing here is ever added to a figure on an Umami card.
 *
 * ITS OWN SOURCE RATHER THAN MORE UMAMI CARDS, for the rule `collectedAt` is
 * built on: one source per clock. Umami's own collector reads every website in
 * one pass; this area's rotation takes ONE SITE EVERY TWELVE HOURS, so a
 * segment block can be half a day older than the visitor count above it and
 * the two should be able to say so separately.
 *
 * ONE SITE FOR THE SEGMENTS, AND IT IS THE ROTATION'S CHOICE, not this file's.
 * The segments route takes a website id, and a board has no picker; the site
 * chosen is the first one the rotation has actually read, which is exactly
 * what the report page's own site picker defaulted to. Every card built from
 * it NAMES that site, because a country ranking with no site on it would read
 * as the portfolio's — and there is no portfolio ranking to be had here for
 * the same reason there is no portfolio visitor count: Umami de-duplicates per
 * website and nothing joins identity across them.
 */
export type WebAnalyticsDocs = {
  /** Every website the rotation knows, with when each last had its turn. */
  sites: Sites | null;
  /** The site the segments below are about, or null when none has been read. */
  site: SiteRow | null;
  /** Raw and adjusted together, the bot findings, and the per-dimension
   *  rankings — for `site` and for no other. */
  segments: Segments | null;
  /** Custom events for EVERY site, which is what the route answers with no
   *  website named. Occurrences and participants are two populations and the
   *  cards keep them apart. */
  events: Events | null;
  /** When the bundle was assembled — never a source's own clock. */
  fetchedAt: string;
};

const settled = async <T,>(p: Promise<T>): Promise<T | null> => {
  try {
    return await p;
  } catch {
    return null;
  }
};

export const webanalyticsboard = {
  docs: async (days: 7 | 30): Promise<WebAnalyticsDocs> => {
    const [sites, events] = await Promise.all([
      settled(webAnalytics.sites()),
      settled(webAnalytics.events("")),
    ]);
    /* The report page's own default, transcribed: the first site the rotation
       has read, and otherwise the first site at all. A site with no `readAt`
       has not had its turn yet, which is not a site with no traffic — asking
       for its segments would answer with an empty distribution. */
    const site =
      (sites?.sites ?? []).find((s) => s.readAt) ?? (sites?.sites ?? [])[0] ?? null;
    const segments =
      site && site.readAt ? await settled(webAnalytics.segments(site.websiteId, days)) : null;
    return { sites, site, segments, events, fetchedAt: new Date().toISOString() };
  },
};
