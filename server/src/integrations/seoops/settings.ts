/**
 * WHAT THE OWNER TYPES, AND WHAT THIS AREA DOES WITH NOTHING TYPED.
 *
 * Every one of the four features here needs to know something that cannot be
 * derived: which word on a card means "this was SEO work", how long to wait
 * before judging a page, which businesses are worth spending a vision call on,
 * which directories are worth a checklist row. A constant for any of those
 * would be this box deciding for somebody whose ventures it has never seen —
 * so each is a SETTING with a documented default, and the defaults are the
 * ones that cost nothing: no vision, no browser, the tag `#seo`, and the
 * directory list that ships with the area.
 *
 * ONE PSEUDO-PLUGIN, `seoops`, on the pattern `briefing`, `backups` and
 * `agentcore` already keep: no secret, no account, one row in `plugins` so
 * `plugin_config`'s foreign key has something to point at. It is deliberately
 * NOT config on `gsc` or on `presence`: manifest config entries are merged by
 * plugin id across areas, so an area that declared settings on somebody else's
 * plugin would silently clobber theirs.
 */
import { configValue, ventureRows, type VentureRow } from "../../db.ts";
import { WINDOW_DAYS } from "../../providers/gsc.ts";

export const SEOOPS_PLUGIN = "seoops";

/** The default tag. A hash so it is greppable in a card body and cannot be
 *  matched by the ordinary English word "seo" in a sentence about SEO. */
export const DEFAULT_TAG = "#seo";

/**
 * When a follow-up is taken, in days after the card was marked done.
 *
 * FOURTEEN, TWENTY-EIGHT, FIFTY-SIX. Not chief/outcomes.ts's 7/14/30, and the
 * difference is not carelessness: Search Console's own window is 28 days and
 * its reporting lag is three, so a reading at day seven compares a 28-day
 * window containing 21 days of BEFORE against one containing 28 — the change
 * is a quarter of the window and mostly invisible. Fourteen is the earliest
 * point at which the after-window is meaningfully after. Fifty-six is there
 * because a page Google has to re-crawl and re-rank does not finish moving in
 * a month.
 */
export const DEFAULT_OFFSETS = [14, 28, 56];

/**
 * The window each reading measures, in days. Search Console's own, so a figure
 * here and a figure in the owner's console are the same figure.
 *
 * IMPORTED, NOT REPEATED. The provider owns this number because the provider is
 * what asks Search Console for the window; a second copy here was equal and one
 * edit away from a baseline reading and a dashboard both captioned "Search
 * Console's window" over spans of different lengths.
 */
export { WINDOW_DAYS };

/** How many of a page's queries are kept with a reading. Enough to see what
 *  the page is shown for; not so many that a reading row is a document. */
export const QUERY_ROWS = 25;

export type SeoOpsSettings = {
  tag: string;
  offsets: number[];
  visionVentures: string[] | "all";
  renderedVentures: string[] | "all";
  directoriesRaw: string | null;
};

/** A comma/newline list, lower-cased, empty removed. `all` anywhere in the
 *  list means every venture — a word rather than a checkbox because this is a
 *  text field on a settings page. */
export function parseVentureList(raw: string | null | undefined): string[] | "all" {
  const parts = (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes("all")) return "all";
  return parts;
}

export function parseOffsets(raw: string | null | undefined): number[] {
  const parts = (raw ?? "")
    .split(/[\s,]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 365);
  const unique = [...new Set(parts)].sort((a, b) => a - b);
  return unique.length ? unique : [...DEFAULT_OFFSETS];
}

export function settings(): SeoOpsSettings {
  return {
    tag: (configValue(SEOOPS_PLUGIN, "tag") ?? "").trim() || DEFAULT_TAG,
    offsets: parseOffsets(configValue(SEOOPS_PLUGIN, "offsets")),
    visionVentures: parseVentureList(configValue(SEOOPS_PLUGIN, "vision_ventures")),
    renderedVentures: parseVentureList(configValue(SEOOPS_PLUGIN, "rendered_ventures")),
    directoriesRaw: configValue(SEOOPS_PLUGIN, "directories"),
  };
}

/**
 * IS THIS VENTURE OPTED IN.
 *
 * Matched on the slug OR the id, because the owner types what is in the
 * address bar and the address bar carries the slug, while an agent that read
 * the roster has the id. Neither is asked to know which the field wanted.
 */
export function optedIn(list: string[] | "all", v: VentureRow): boolean {
  if (list === "all") return true;
  return list.includes(v.slug.toLowerCase()) || list.includes(v.id.toLowerCase());
}

/** The ventures opted in to one of the two paid passes, in roster order. */
export function venturesFor(list: string[] | "all"): VentureRow[] {
  if (list !== "all" && !list.length) return [];
  return ventureRows().filter((v) => optedIn(list, v));
}
