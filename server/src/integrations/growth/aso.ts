/**
 * THE STORE LISTING, AUDITED — what a shopper reads before they install.
 *
 * THE GAP. `/api/mobile` has had the app rows, the units and the money for as
 * long as the app-store plugins have been connected, and nothing anywhere asked
 * what the LISTING says. The listing is the page the install rate is measured
 * over, and until this run existed nothing on this box had ever read one.
 *
 * NO MODEL DOES ANY OF THE MEASURING, and the constants are why. Almost
 * everything worth checking here is a hard platform rule, and a model asked
 * about them gets the same three wrong every time:
 *
 *   * APPLE'S KEYWORD FIELD IS 100 BYTES, not 100 characters — and this box
 *     CANNOT READ IT. It lives in App Store Connect's version localisations,
 *     which the collector here does not fetch, so the check is `null` with that
 *     sentence on it rather than a pass by silence. Same for the subtitle.
 *   * PLAY INDEXES THE FULL DESCRIPTION AND APPLE DOES NOT. Apple reads the
 *     name, the subtitle and the keyword field for search and ignores the
 *     description entirely, so the same advice about description length is
 *     right on one store and wrong on the other. Every description check
 *     carries which store it is talking about.
 *   * PLAY'S STORE PAGE CARRIES OTHER APPS BESIDE THIS ONE. The HTML that
 *     comes back holds the titles, ratings and thumbnails of a dozen "similar"
 *     apps, and a reader that counted every image would report a competitor's
 *     screenshots as ours. So nothing is read from Play by counting loosely:
 *     each field is taken from the ONE anchor the page gives this app and no
 *     other — `data-g-id="description"` for the full description, the images
 *     whose alt text is "Screenshot image" (the similar-app cards say
 *     "Icon image" and "Thumbnail image"), the "Updated on" label's own
 *     value, the `itemprop="starRating"` block and its reviews count. The
 *     rating prefers the Play Console export the collector already writes,
 *     which is the developer's own figure; the page's star is the fallback
 *     for a rival. What has no anchor — the short description, the version —
 *     is null with its reason, never a number. See `parsePlayPage`.
 *
 * WHERE THE LISTING COMES FROM, per store:
 *
 *   App Store   the public iTunes lookup — `itunes.apple.com/lookup?id=…` —
 *               which is the shopper's own view: name, description, the
 *               screenshot list, the rating, the current version's release
 *               date. Keyless, public, and the same document the store page
 *               renders from.
 *   Play        the public store page, read at its attributable anchors —
 *               title, full description, screenshot count, update date, the
 *               star rating and its count where the page shows one — plus
 *               play_stats for the developer's own rating. The short
 *               description and the version have no anchor and stay null.
 *
 * THE SCORE IS THIS APP'S RUBRIC AND IS SHOWN WITH ITS PARTS. Weighted
 * dimensions, pass/warn/fail worth 1/0.5/0, N/A excluded from the denominator,
 * and a coverage floor under which a dimension is refused rather than guessed.
 * Under three scorable dimensions the whole grade is refused: a confident B
 * drawn from two checks is the one failure this may not have.
 */
import { db, now, type VentureRow } from "../../db.ts";
import * as searxng from "../../providers/searxng.ts";
import { registrable } from "../../shared/host.ts";
import { fetchHtml, tokens } from "./pages.ts";
import type { RunTools } from "./runs.ts";
import { sanitizeReportHtml } from "../runs/html.ts";
import { saveRunEvidence } from "../runs/artifacts.ts";
import { ANALYSIS_REPLY, analysisHtml, askAnalysis, callout, cardsFence, h, hostLink, page, plainCallout, type Analysis } from "./report.ts";

/* -------------------------------------------------------- hard constants */

/** Apple's app name field, and Play's title field. Both 30. */
const APPLE_NAME_CHARS = 30;
const PLAY_TITLE_CHARS = 30;
/** Play indexes the full description; under this there is not enough of it to
 *  index. Apple does not index it at all — the check says so per store. */
const DESCRIPTION_GOOD_CHARS = 500;
const DESCRIPTION_THIN_CHARS = 250;
/** Both stores. Five is the floor a listing looks unfinished below; eight is a
 *  full set. */
const MIN_SCREENSHOTS = 5;
const GOOD_SCREENSHOTS = 8;
/** A listing nobody has touched in this long reads as abandoned. */
const STALE_DAYS = 90;
const VERY_STALE_DAYS = 180;
/** Play's own line for a good rating. */
const GOOD_RATING = 4.0;
const POOR_RATING = 3.5;
/** Ratings below this many are one bad afternoon rather than a signal. */
const GOOD_RATING_COUNT = 50;
const MIN_RATING_COUNT = 10;
/** Share of the description's own top terms that the title carries. */
const KEYWORD_GOOD = 0.3;
const KEYWORD_POOR = 0.15;
/** Competitor listings read per app. */
const MAX_RIVALS = 3;

/* ------------------------------------------------------------- the rubric */

/**
 * The five dimensions and their weights.
 *
 * Visuals lead at 25 because the screenshots are the only part of a listing
 * most people read. Title carries 25 because on both stores it holds the
 * search weight and it is the one field with a hard character cap. Ratings 20
 * because it is the one signal a shopper trusts more than anything the
 * developer wrote. Description 20 — indexed on Play, decorative on Apple,
 * which is exactly why it is not higher. Freshness 10: evidence about the
 * listing rather than the listing itself.
 */
const DIMENSIONS: Record<string, number> = {
  visuals: 25,
  title: 25,
  ratings: 20,
  description: 20,
  freshness: 10,
};

const VALUE: Record<string, number> = { pass: 1, warn: 0.5, fail: 0 };

/** Below this share of a dimension's checks answered, the subscore is refused.
 *  The one failure this may not have is a confident 100 drawn from one check. */
const COVERAGE_MIN = 0.4;
/** Fewer live dimensions than this and the whole grade is refused. */
const MIN_LIVE_DIMENSIONS = 3;

type CheckId =
  | "screenshot-count"
  | "screenshot-depth"
  | "title-length"
  | "keyword-coverage"
  | "subtitle-present"
  | "rating-level"
  | "rating-volume"
  | "description-length"
  | "description-present"
  | "freshness";

const CHECKS: Record<CheckId, { dim: string; title: string; fix: string }> = {
  "screenshot-count": {
    dim: "visuals",
    title: "Fewer than five screenshots",
    fix: "Add screenshots until there are at least five. They are the only part of the listing most people read.",
  },
  "screenshot-depth": {
    dim: "visuals",
    title: "The screenshot set is short",
    fix: "Eight is where a set stops looking unfinished. Show the second and third things the app does, not five views of the first.",
  },
  "title-length": {
    dim: "title",
    title: "The title is cut off in search results",
    fix: "Cut it to the store's cap so the name is not truncated mid-word where people scan.",
  },
  "keyword-coverage": {
    dim: "title",
    title: "The title carries none of the words the description sells on",
    fix: "Put the two or three words the description leans on into the name, where both stores weight them.",
  },
  "subtitle-present": {
    dim: "title",
    title: "No subtitle or short description",
    fix: "It is the second line of search weight and the first line a shopper reads under the name.",
  },
  "rating-level": {
    dim: "ratings",
    title: "The rating is under four",
    fix: "Read the one-star reviews for the repeated sentence and fix that. Below four the rating is itself a reason not to install.",
  },
  "rating-volume": {
    dim: "ratings",
    title: "Almost nobody has rated it",
    fix: "Ask for the rating in-app, after a moment the app worked rather than on launch.",
  },
  "description-length": {
    dim: "description",
    title: "The description is thin",
    fix: "On Play the full description is INDEXED — under five hundred characters there is not enough of it to index. On Apple it is not indexed and is still what a shopper reads before deciding.",
  },
  "description-present": {
    dim: "description",
    title: "No description",
    fix: "Write one. It is the only place the listing can answer a question a screenshot raises.",
  },
  freshness: {
    dim: "freshness",
    title: "No update in three months",
    fix: "Ship something, even small. Both stores weight recency and shoppers read the date.",
  },
};

const DIM_TOTAL: Record<string, number> = {};
for (const dim of Object.keys(DIMENSIONS))
  DIM_TOTAL[dim] = Object.values(CHECKS).filter((c) => c.dim === dim).length;

type Result = "pass" | "warn" | "fail" | null;
type CheckRow = { id: CheckId; dim: string; result: Result; detail: string };

/* ---------------------------------------------------------- the listing */

export type Listing = {
  store: "appstore" | "play";
  appId: string;
  name: string | null;
  /** NULL means the field could not be read, with `notes` saying why — never
   *  that the field is empty. */
  subtitle: string | null;
  description: string | null;
  descriptionChars: number | null;
  screenshots: number | null;
  rating: number | null;
  ratingCount: number | null;
  ratingFrom: string | null;
  updatedAt: string | null;
  version: string | null;
  genres: string[];
  url: string | null;
  /** What could not be read, and why. This is part of the reading, not a
   *  footnote: a check that scores around a missing field is a lie. */
  notes: string[];
  error: string | null;
};

const clean = (s: unknown, cap: number): string | null => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t ? t.slice(0, cap) : null;
};

/** Apple's public lookup — the shopper's own document. */
export async function appleListing(appId: string, storefront: string | null): Promise<Listing> {
  const country = (storefront || "us").toLowerCase();
  const base: Listing = {
    store: "appstore",
    appId,
    name: null,
    subtitle: null,
    description: null,
    descriptionChars: null,
    screenshots: null,
    rating: null,
    ratingCount: null,
    ratingFrom: null,
    updatedAt: null,
    version: null,
    genres: [],
    url: null,
    notes: [
      "Apple's SUBTITLE and its 100-BYTE KEYWORD FIELD are not in any document this box fetches — they live in App Store Connect's version localisations, which the collector does not read. Both are null here and neither is scored.",
      "No review text or review dates are collected by this box, so review recency is not measured. Freshness below is the CURRENT VERSION'S release date.",
    ],
    error: null,
  };
  try {
    const res = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}&country=${encodeURIComponent(country)}`, {
      headers: { Accept: "application/json", "User-Agent": "OnePersonCompany/0.1 (+aso)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ...base, error: `Apple's lookup answered HTTP ${res.status}` };
    const doc = (await res.json()) as { resultCount?: number; results?: Record<string, unknown>[] };
    const r = doc.results?.[0];
    if (!r) return { ...base, error: `Apple's lookup knows no app ${appId} in the ${country} storefront. An app that is not yet released has no public listing to read.` };
    const description = clean(r.description, 20_000);
    const shots = Array.isArray(r.screenshotUrls) ? r.screenshotUrls.length : null;
    return {
      ...base,
      name: clean(r.trackName, 200),
      description,
      descriptionChars: description ? description.length : 0,
      screenshots: shots,
      rating: typeof r.averageUserRating === "number" ? Number(r.averageUserRating.toFixed(2)) : null,
      ratingCount: typeof r.userRatingCount === "number" ? r.userRatingCount : null,
      ratingFrom: "Apple's public storefront figure for this country",
      updatedAt: clean(r.currentVersionReleaseDate, 40),
      version: clean(r.version, 40),
      genres: Array.isArray(r.genres) ? r.genres.filter((g): g is string => typeof g === "string").slice(0, 6) : [],
      url: clean(r.trackViewUrl, 400),
    };
  } catch (err) {
    return { ...base, error: `Apple's lookup could not be reached — ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * WHAT THE PLAY PAGE SAYS ABOUT THIS APP, AND ONLY THIS APP.
 *
 * Pure — HTML in, fields out — so it can be tested against a page saved to
 * disk and so a change in Play's markup shows up as a failing test rather
 * than a run quietly reading null. Every regex below is anchored on markup
 * that exists ONCE on the page and belongs to the app the page is about;
 * nothing is read by position or by "the first number after the title".
 *
 * WHAT WAS CHECKED, 2026-09-21, against three live pages (two of the owner's
 * and one with millions of reviews): the description div occurs once and is
 * the full description; the screenshot images carry alt="Screenshot image"
 * while the similar-app cards carry "Icon image" and "Thumbnail image"; the
 * "Updated on" label is followed by its date; the star block carries the
 * average and, beside it, "N reviews"; the downloads figure sits beside its
 * "Downloads" label. A listing nobody has rated shows NO star block at all,
 * which is why rating and count are null rather than zero for such a page.
 */
export type PlayPage = {
  name: string | null;
  description: string | null;
  screenshots: number | null;
  /** ISO date, from the "Updated on" label. */
  updatedAt: string | null;
  rating: number | null;
  ratingCount: number | null;
  /** Play's bucketed figure as shown — "500+", "1K+" — kept as text because
   *  it is a floor, not a count. */
  downloads: string | null;
  genre: string | null;
  inAppPurchases: boolean;
  containsAds: boolean;
};

const unescapeHtml = (t: string): string =>
  t
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+\n/g, "\n")
    .trim();

/** "244M" → 244000000, "1.2K" → 1200, "37" → 37. Null for anything else. */
export function compactNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /^([\d.,]+)\s*([KMB])?$/i.exec(text.trim());
  if (!m) return null;
  const base = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase()] ?? 1;
  return Math.round(base * mult);
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** "Sep 17, 2026" or "17 Sep 2026" → "2026-09-17", as a date and not an instant. */
export function calendarDate(text: string | null): string | null {
  if (!text) return null;
  const t = text.trim();
  let m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  let month: number | undefined;
  let day: number;
  let year: number;
  if (m) {
    month = MONTHS[m[1]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    day = Number(m[2]);
    year = Number(m[3]);
  } else {
    m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(t);
    if (!m) return null;
    month = MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    day = Number(m[1]);
    year = Number(m[3]);
  }
  if (month === undefined || !(day >= 1 && day <= 31)) return null;
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parsePlayPage(html: string): PlayPage {
  const og = /<meta property="og:title" content="([^"]{0,300})"/i.exec(html)?.[1] ?? null;
  const name = og ? unescapeHtml(og).replace(/\s*-\s*Apps on Google Play\s*$/i, "").trim() || null : null;

  const descMatch = /<div[^>]*data-g-id="description"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const description = descMatch ? unescapeHtml(descMatch[1]!) || null : null;

  const shots = html.match(/<img[^>]+alt="Screenshot image"[^>]*>/gi);
  const screenshots = shots ? shots.length : null;

  const upd = /Updated on<\/div>\s*<div[^>]*>([^<]{4,40})</i.exec(html)?.[1] ?? null;
  /* "Sep 17, 2026" is a calendar date with no zone; parsed as a local time
     and printed as UTC it comes out a day early on any box east of Greenwich.
     So it is read as a date, never as an instant. */
  const updatedAt = calendarDate(upd);

  /* The star block is the ONE rating on the page that is this app's; the
     similar-app cards carry their own stars in a different shape. Both the
     average and the count are read from inside it and nowhere else. */
  let rating: number | null = null;
  let ratingCount: number | null = null;
  const starAt = html.search(/itemprop="starRating"/i);
  if (starAt >= 0) {
    const block = html.slice(starAt, starAt + 800);
    const avg = />\s*([0-5](?:\.\d)?)\s*</.exec(block)?.[1];
    if (avg) rating = Number(avg);
    /* Tags become spaces here, not nothing: "<div>4.3</div><div>1.2K reviews"
       stripped bare reads as "4.31.2K reviews". */
    const count = /(?:^|\s)([\d.,]+[KMB]?)\s*reviews/i.exec(unescapeHtml(block.replace(/<[^>]+>/g, " ")))?.[1];
    ratingCount = compactNumber(count ?? null);
  }

  const downloads = />([\d.,]+[KMB]?\+?)<\/div>\s*<div[^>]*>Downloads</i.exec(html)?.[1] ?? null;
  const genre = /itemprop="genre"[^>]*>(?:<[^>]+>)*([^<]{1,60})</i.exec(html)?.[1]?.trim() ?? null;

  return {
    name,
    description,
    screenshots,
    updatedAt,
    rating,
    ratingCount,
    downloads,
    genre,
    inAppPurchases: /In-app purchases/.test(html),
    containsAds: /Contains ads/.test(html),
  };
}

/**
 * Play, read at its anchors, with the Console export's rating on top.
 *
 * THE RATING PREFERS THE CONSOLE. The page's star is what a shopper sees and
 * is right for a rival; for the owner's own app the Play Console export the
 * collector already writes is the developer's own figure, and it is present
 * for a listing the page shows no star for yet. The COUNT is the page's,
 * because the export has none. A page with no star block is a listing with
 * too few ratings for Play to show one, and both stay null with that said.
 */
export async function playListing(pkg: string): Promise<Listing> {
  const stats = db
    .prepare(
      `SELECT day, rating_total, installs FROM play_stats
        WHERE package = ? AND rating_total IS NOT NULL ORDER BY day DESC LIMIT 1`,
    )
    .get(pkg) as { day: string; rating_total: number | null; installs: number | null } | undefined;

  const base: Listing = {
    store: "play",
    appId: pkg,
    name: null,
    subtitle: null,
    description: null,
    descriptionChars: null,
    screenshots: null,
    rating: stats?.rating_total ?? null,
    ratingCount: null,
    ratingFrom: stats ? `the Play Console export, day ${stats.day}` : null,
    updatedAt: null,
    version: null,
    genres: [],
    url: `https://play.google.com/store/apps/details?id=${pkg}`,
    notes: [
      "Play's SHORT DESCRIPTION and the VERSION have no anchor in the page HTML this box reads — they are null, not empty, and the subtitle check is not scored.",
    ],
    error: null,
  };

  const got = await fetchHtml(base.url!);
  if ("error" in got) return { ...base, error: `The Play listing ${got.error}` };
  const page = parsePlayPage(got.html);
  const notes = [...base.notes];
  if (page.description === null) notes.push("The full description was not found at its anchor on the page, so it is null here — not empty.");
  if (page.screenshots === null) notes.push("No screenshot image was found at its anchor on the page, so the count is null — not zero.");
  if (page.updatedAt === null) notes.push("The 'Updated on' date was not found on the page, so freshness is not measured.");
  if (page.rating === null && base.rating === null) notes.push("The page shows no star block, which is what Play does for a listing too few people have rated to show an average; the Console export carries no rating either. Both rating checks stay unscored.");
  else if (page.rating === null) notes.push("The page shows no star block (Play hides the average until enough people have rated), so the rating here is the Console export's own figure and the count is not measured.");
  if (page.downloads) notes.push(`Play shows ${page.downloads} downloads — its bucketed floor as shoppers see it, not a count.`);
  if (page.inAppPurchases) notes.push("The page is labelled 'In-app purchases'.");
  if (page.containsAds) notes.push("The page is labelled 'Contains ads'.");

  return {
    ...base,
    name: page.name,
    description: page.description,
    descriptionChars: page.description === null ? null : page.description.length,
    screenshots: page.screenshots,
    rating: base.rating ?? page.rating,
    ratingFrom: base.rating !== null ? base.ratingFrom : page.rating !== null ? "the star shown on the Play page" : null,
    ratingCount: page.ratingCount,
    updatedAt: page.updatedAt,
    genres: page.genre ? [page.genre] : [],
    notes,
  };
}

/* ------------------------------------------------- which apps are this venture's */

export type AppRef = { store: "appstore" | "play"; appId: string; name: string | null; storefront: string | null };

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The apps that belong to a venture, matched from what the store collectors
 * already wrote.
 *
 * THREE JOINS, ALL OF THEM MECHANICAL, because there is no id anywhere that
 * links a venture to an app and inventing a settings field for it would be a
 * field nineteen ventures have to fill in by hand:
 *
 *   1. the app's NAME, letters and digits only, equals or contains the
 *      venture's name the same way — "Acme Studio" is acmestudio,
 *   2. a SEGMENT of the bundle id or package equals the venture's host without
 *      its suffix — test.example.mobile against example-app-10.example.test,
 *   3. the whole bundle id contains it — com.acmeapp.app against acmeapp.
 *
 * A venture with no app matches nothing, which is the common case and is not
 * an error.
 */
export function appsForVenture(v: VentureRow): AppRef[] {
  const keys = new Set<string>();
  if (v.name) keys.add(alnum(v.name));
  if (v.host) {
    const reg = registrable(v.host);
    keys.add(alnum(reg.split(".")[0] ?? reg));
  }
  keys.add(alnum(v.slug));
  const wanted = [...keys].filter((k) => k.length >= 4);
  const hit = (...fields: (string | null)[]) =>
    wanted.some((k) =>
      fields.some((f) => {
        if (!f) return false;
        const a = alnum(f);
        if (a === k || a.includes(k)) return true;
        return f.toLowerCase().split(/[.\-_]/).some((seg) => alnum(seg) === k);
      }),
    );

  const out: AppRef[] = [];
  const apple = db.prepare("SELECT app_id, bundle_id, name, storefront FROM appstore_apps").all() as unknown as {
    app_id: string;
    bundle_id: string | null;
    name: string | null;
    storefront: string | null;
  }[];
  for (const a of apple)
    if (hit(a.name, a.bundle_id)) out.push({ store: "appstore", appId: a.app_id, name: a.name, storefront: a.storefront });

  const play = db.prepare("SELECT DISTINCT package FROM play_stats").all() as unknown as { package: string }[];
  for (const p of play) if (hit(p.package)) out.push({ store: "play", appId: p.package, name: null, storefront: null });

  return out;
}

/* ---------------------------------------------------------------- checks */

const ageDays = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null;
};

/**
 * The share of the description's own leading terms that the title carries.
 *
 * The description's top terms are its most frequent content words, which is a
 * mechanical stand-in for "what this listing sells on". A title that carries
 * none of them is a title doing no search work at all — on either store, since
 * both weight the name above everything else.
 */
export function keywordCoverage(title: string | null, description: string | null): { ratio: number | null; matched: string[]; considered: string[] } {
  if (!title || !description) return { ratio: null, matched: [], considered: [] };
  const counts = new Map<string, number>();
  for (const w of description.toLowerCase().split(/[^a-z0-9]+/))
    if (w.length >= 4) counts.set(w, (counts.get(w) ?? 0) + 1);
  const considered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([w]) => w);
  if (!considered.length) return { ratio: null, matched: [], considered: [] };
  const inTitle = new Set(tokens(title));
  const matched = considered.filter((w) => inTitle.has(w));
  return { ratio: Number((matched.length / considered.length).toFixed(2)), matched, considered };
}

/** Every check, in order, with the sentence that says what it was computed
 *  from. A null result carries the reason it could not be answered. */
export function runChecks(l: Listing): CheckRow[] {
  const rows: CheckRow[] = [];
  const add = (id: CheckId, result: Result, detail: string) => rows.push({ id, dim: CHECKS[id].dim, result, detail });

  /* visuals */
  if (l.screenshots === null)
    add("screenshot-count", null, l.store === "play" ? "No screenshot was found at its anchor on the Play page." : "The screenshot list was not in the listing document.");
  else
    add(
      "screenshot-count",
      l.screenshots >= MIN_SCREENSHOTS ? "pass" : l.screenshots >= 3 ? "warn" : "fail",
      `${l.screenshots} screenshots; ${MIN_SCREENSHOTS} is the floor, under 3 fails.`,
    );
  if (l.screenshots === null) add("screenshot-depth", null, "no screenshot count to judge depth from");
  else
    add(
      "screenshot-depth",
      l.screenshots >= GOOD_SCREENSHOTS ? "pass" : l.screenshots >= MIN_SCREENSHOTS ? "warn" : "fail",
      `${l.screenshots} screenshots; ${GOOD_SCREENSHOTS} is where a set stops looking unfinished.`,
    );

  /* title */
  const cap = l.store === "appstore" ? APPLE_NAME_CHARS : PLAY_TITLE_CHARS;
  if (!l.name) add("title-length", null, "the title could not be read");
  else add("title-length", l.name.length <= cap ? "pass" : "fail", `“${l.name}” is ${l.name.length} characters; the ${l.store === "appstore" ? "App Store" : "Play"} cap is ${cap}.`);

  const kw = keywordCoverage(l.name, l.description);
  if (kw.ratio === null)
    add("keyword-coverage", null, l.description ? "the title could not be read" : "the description could not be read, so there is nothing to measure the title against");
  else
    add(
      "keyword-coverage",
      kw.ratio >= KEYWORD_GOOD ? "pass" : kw.ratio >= KEYWORD_POOR ? "warn" : "fail",
      `${kw.matched.length} of the description's ${kw.considered.length} most-used words are in the title (${kw.ratio}). They are: ${kw.considered.join(", ")}. In the title: ${kw.matched.join(", ") || "none"}.`,
    );

  add(
    "subtitle-present",
    null,
    l.store === "appstore"
      ? "Apple's subtitle is in App Store Connect's version localisations, which this box does not fetch. Not scored."
      : "Play's short description has no anchor in the page HTML this box reads. Not scored.",
  );

  /* ratings */
  if (l.rating === null || l.rating === 0)
    add(
      "rating-level",
      null,
      l.rating === 0
        ? "the store reports an average of 0, which on both stores means nobody has rated it rather than everybody rating it zero"
        : "no rating figure was available",
    );
  else add("rating-level", l.rating >= GOOD_RATING ? "pass" : l.rating >= POOR_RATING ? "warn" : "fail", `${l.rating} from ${l.ratingFrom ?? "the store"}; ${GOOD_RATING} is the line.`);

  if (l.ratingCount === null) add("rating-volume", null, l.store === "play" ? "Play shows no rating count for this listing — the page hides the star until enough people have rated — and the Console export carries none." : "no rating count was available");
  else
    add(
      "rating-volume",
      l.ratingCount >= GOOD_RATING_COUNT ? "pass" : l.ratingCount >= MIN_RATING_COUNT ? "warn" : "fail",
      `${l.ratingCount} ratings; under ${MIN_RATING_COUNT} is one bad afternoon rather than a signal.`,
    );

  /* description */
  if (l.descriptionChars === null) add("description-present", null, "the description could not be read from this store");
  else add("description-present", l.descriptionChars > 0 ? "pass" : "fail", l.descriptionChars > 0 ? `${l.descriptionChars} characters.` : "there is no description at all.");

  if (l.descriptionChars === null || l.descriptionChars === 0)
    add("description-length", null, l.descriptionChars === 0 ? "there is no description to measure" : "the description could not be read from this store");
  else
    add(
      "description-length",
      l.descriptionChars >= DESCRIPTION_GOOD_CHARS ? "pass" : l.descriptionChars >= DESCRIPTION_THIN_CHARS ? "warn" : "fail",
      `${l.descriptionChars} characters. ${l.store === "play" ? "Play INDEXES this field; under 500 characters there is not enough of it to index." : "Apple does NOT index this field — it is what a shopper reads, not what search reads."}`,
    );

  /* freshness */
  const age = ageDays(l.updatedAt);
  if (age === null) add("freshness", null, l.store === "play" ? "The 'Updated on' date was not found on the Play page." : "no release date was available");
  else
    add(
      "freshness",
      age <= STALE_DAYS ? "pass" : age <= VERY_STALE_DAYS ? "warn" : "fail",
      `the current version was released ${age} days ago (${l.updatedAt}). This is VERSION recency, not review recency — no review dates are collected.`,
    );

  return rows;
}

/* --------------------------------------------------------------- scoring */

export type Scored = {
  score: number | null;
  grade: string | null;
  coverage: number;
  dimensions: Record<string, { weight: number; coverage: number; score: number | null; reason: string | null }>;
  refusal: string | null;
  arithmetic: string[];
};

function grade(score: number | null): string | null {
  if (score === null) return null;
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

/**
 * The weighted roll-up, with the working kept so the page can print it.
 *
 * Every check is worth one unit inside its dimension — a store listing has few
 * enough checks that a second weighting axis would be a knob nobody could
 * justify. N/A is excluded from the denominator everywhere: a check that could
 * not be evaluated is not a check that failed.
 */
export function score(rows: CheckRow[]): Scored {
  const dims: Scored["dimensions"] = {};
  const arithmetic: string[] = [];
  for (const [dim, weight] of Object.entries(DIMENSIONS)) {
    let evaluated = 0;
    let earned = 0;
    for (const r of rows) {
      if (r.dim !== dim || r.result === null) continue;
      evaluated += 1;
      earned += VALUE[r.result]!;
    }
    const total = DIM_TOTAL[dim] || 0;
    const coverage = total ? evaluated / total : 0;
    const live = evaluated > 0 && coverage >= COVERAGE_MIN;
    dims[dim] = {
      weight,
      coverage: Math.round(coverage * 100) / 100,
      score: live ? Math.round((100 * earned) / evaluated) : null,
      reason: live
        ? null
        : evaluated === 0
          ? "nothing in this dimension could be checked"
          : `only ${Math.round(coverage * 100)}% of this dimension could be checked; the floor is ${COVERAGE_MIN * 100}%`,
    };
    if (live) arithmetic.push(`${dim}: ${earned} points earned over ${evaluated} checks answered = ${dims[dim]!.score}, weight ${weight}`);
    else arithmetic.push(`${dim}: refused — ${dims[dim]!.reason}`);
  }

  const names = Object.keys(DIMENSIONS);
  const coverage = names.reduce((n, d) => n + DIMENSIONS[d]! * dims[d]!.coverage, 0) / 100;
  const liveNames = names.filter((d) => dims[d]!.score !== null);
  if (liveNames.length < MIN_LIVE_DIMENSIONS)
    return {
      score: null,
      grade: null,
      coverage: Math.round(coverage * 100) / 100,
      dimensions: dims,
      refusal: `only ${liveNames.length} of ${names.length} dimensions could be scored, which is not enough of a listing to grade`,
      arithmetic,
    };
  const weight = liveNames.reduce((n, d) => n + DIMENSIONS[d]!, 0);
  const total = Math.round(liveNames.reduce((n, d) => n + DIMENSIONS[d]! * dims[d]!.score!, 0) / weight);
  arithmetic.push(
    `score = (${liveNames.map((d) => `${DIMENSIONS[d]}×${dims[d]!.score}`).join(" + ")}) ÷ ${weight} = ${total}. The refused dimensions are out of both sides of that division.`,
  );
  return { score: total, grade: grade(total), coverage: Math.round(coverage * 100) / 100, dimensions: dims, refusal: null, arithmetic };
}

/* ----------------------------------------------------------- competitors */

export type RivalListing = { name: string | null; url: string; store: string; screenshots: number | null; descriptionChars: number | null; rating: number | null; titleChars: number | null; note: string | null };

/**
 * What the listings a shopper sees beside ours look like.
 *
 * The search is the app's own leading words, restricted to nothing — the
 * results that happen to be store listings are the ones kept. Apple's are read
 * through the same public lookup as ours, and Play's through the same anchored
 * page read, which makes both like-for-like: a rival's screenshot count was
 * counted the way ours was.
 */
async function rivals(l: Listing): Promise<{ rows: RivalListing[]; note: string | null }> {
  const terms = keywordCoverage(l.name, l.description).considered.slice(0, 3);
  const query = [...terms, "app"].join(" ").trim() || `${l.name ?? ""} app`.trim();
  if (!query) return { rows: [], note: "There was nothing in the listing to build a search from." };

  const borrowed = searxng.borrowKey("aso_audit");
  if (!borrowed) return { rows: [], note: "SearXNG is not connected, so no competitor listings were read." };
  let results: { url: string; title: string }[] = [];
  try {
    const answer = await searxng.ask(borrowed.url, borrowed.key, { query });
    results = answer.results.map((r) => ({ url: r.url, title: r.title }));
  } catch (err) {
    return { rows: [], note: `The search for competitor listings failed — ${err instanceof Error ? err.message : String(err)}` };
  }

  const rows: RivalListing[] = [];
  for (const r of results) {
    if (rows.length >= MAX_RIVALS) break;
    const apple = /apps\.apple\.com\/.*\/id(\d+)/.exec(r.url);
    if (apple) {
      if (apple[1] === l.appId) continue;
      const got = await appleListing(apple[1]!, null);
      rows.push({
        name: got.name,
        url: got.url ?? r.url,
        store: "appstore",
        screenshots: got.screenshots,
        descriptionChars: got.descriptionChars,
        rating: got.rating,
        titleChars: got.name ? got.name.length : null,
        note: got.error,
      });
      continue;
    }
    const play = /play\.google\.com\/store\/apps\/details\?id=([A-Za-z0-9_.]+)/.exec(r.url);
    if (play && play[1] !== l.appId) {
      const got = await playListing(play[1]!);
      rows.push({
        name: got.name ?? r.title,
        url: got.url ?? r.url,
        store: "play",
        screenshots: got.screenshots,
        descriptionChars: got.descriptionChars,
        rating: got.rating,
        titleChars: got.name ? got.name.length : null,
        note: got.error,
      });
    }
  }
  return {
    rows,
    note: rows.length ? `Searched “${query}”; the store listings in the results were read.` : `Searched “${query}” and no store listing came back, so there is nothing to compare against.`,
  };
}

/* --------------------------------------------------------------- the run */

export async function asoRun(runId: string, v: VentureRow, input: Record<string, string>, tools: RunTools): Promise<void> {
  const apps = appsForVenture(v);
  if (!apps.length)
    throw new Error(
      `No app in the App Store Connect or Play tables matches ${v.name}. Apps are matched on the app's name, its bundle id or its package against this venture's name and host — connect the store plugin, or check the venture's host matches the bundle.`,
    );

  const wanted = (input.store ?? "").trim().toLowerCase();
  const chosen = wanted === "appstore" || wanted === "play" ? apps.filter((a) => a.store === wanted) : apps;
  if (!chosen.length) throw new Error(`${v.name} has no ${wanted} app; it has ${apps.map((a) => a.store).join(", ")}.`);

  const audited: { ref: AppRef; listing: Listing; checks: CheckRow[]; scored: Scored; rivals: RivalListing[]; rivalNote: string | null }[] = [];

  for (const ref of chosen) {
    const step = tools.startStep("aso", `${ref.store}: ${ref.name ?? ref.appId}`);
    const listing = ref.store === "appstore" ? await appleListing(ref.appId, ref.storefront) : await playListing(ref.appId);
    const checks = runChecks(listing);
    const scored = score(checks);
    const rv = listing.error ? { rows: [], note: "The listing could not be read, so no comparison was made." } : await rivals(listing);
    audited.push({ ref, listing, checks, scored, rivals: rv.rows, rivalNote: rv.note });
    tools.endStep(step, listing.error ? `not read — ${listing.error}` : `${scored.score ?? "no grade"}${scored.grade ? ` (${scored.grade})` : ""}`);
  }

  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO growth_aso (run_id, venture_id, store, app_id, name, listing, checks, dimensions, score, grade, coverage, refusal, competitors, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, store, app_id) DO UPDATE SET
       listing = excluded.listing, checks = excluded.checks, dimensions = excluded.dimensions,
       score = excluded.score, grade = excluded.grade, coverage = excluded.coverage,
       refusal = excluded.refusal, competitors = excluded.competitors, ts = excluded.ts`,
  );
  for (const a of audited)
    stmt.run(
      runId,
      v.id,
      a.ref.store,
      a.ref.appId,
      a.listing.name ?? a.ref.name,
      JSON.stringify(a.listing),
      JSON.stringify(a.checks),
      JSON.stringify(a.scored.dimensions),
      a.scored.score,
      a.scored.grade,
      a.scored.coverage,
      a.scored.refusal,
      JSON.stringify(a.rivals),
      ts,
    );

  saveRunEvidence(runId, {
    collectedAt: ts,
    brief: input.store ?? "",
    data: renderData(audited),
    note: "Every check and score was computed by this server from the listing documents; the analysis in the report is a model's reading of them.",
  });

  const write = tools.startStep("write", "recommendations");
  const analysis = await askAnalysis(tools, [
    {
      role: "system",
      content: [
        `You are writing the analysis of a store-listing audit for ${v.name}.`,
        ``,
        `THE CHECKLIST AND THE SCORES ARE ALREADY COMPUTED AND WILL BE PRINTED ON THE PAGE ABOVE YOUR WORDS. This server computed every one of them from the listing documents; you did not, and you must not recompute, re-grade or restate them as a table.`,
        ``,
        `RULES, all binding:`,
        `- NEVER INVENT A FIGURE. Only the numbers below exist.`,
        `- A CHECK MARKED "not scored" WAS NOT ANSWERED. It is not a pass and it is not a failure — say what would have to be connected for it to be answerable.`,
        `- APPLE DOES NOT INDEX THE DESCRIPTION and Play does. Never give the same description advice for both stores.`,
        `- A RATING OF 0 MEANS NOBODY HAS RATED IT, not that the app is rated zero.`,
        ``,
        `THE AUDIT:`,
        ``,
        renderData(audited),
        ``,
        `WHAT TO WRITE. The headline names the single biggest finding about the listing${audited.length === 1 ? "" : "s"}. The verdict says it in one sentence before qualifying it. The sections read the checks that failed or warned and the rival listings: what a shopper sees on ours that they do not see on theirs, and the other way round, quoting the figures. The recommendations are ranked, each a change to a NAMED listing field on a named store, with what it costs and which check it would move.`,
        ``,
        ANALYSIS_REPLY,
      ].join("\n"),
    },
    { role: "user", content: `Write the analysis of ${v.name}'s store listing${audited.length === 1 ? "" : "s"}.` },
  ]);
  tools.endStep(write, analysis.failed ? `failed — ${analysis.failed}` : `${analysis.sections.length} sections, ${analysis.recommendations.length} recommendations, ${analysis.cards.length} cards`);

  tools.say(sanitizeReportHtml(asoDocument(v, audited, analysis, ts)) + cardsFence(analysis.cards));
}

/* --------------------------------------------------------------- the page */

type Audited = { ref: AppRef; listing: Listing; checks: CheckRow[]; scored: Scored; rivals: RivalListing[]; rivalNote: string | null };

/**
 * THE AUDIT AS A DESIGNED PAGE, composed here — the score with its arithmetic,
 * every check with what it was computed from, the rivals read the same way,
 * and the model's analysis rendered from its JSON. Exported for the tests.
 */
export function asoDocument(v: VentureRow, audited: Audited[], analysis: Analysis, ts: string): string {
  const day = ts.slice(0, 10);
  const read = audited.filter((a) => !a.listing.error);
  const storeName = (s: string) => (s === "appstore" ? "App Store" : "Google Play");
  const finding =
    analysis.headline ??
    (read.length === 0
      ? `No listing of ${v.name} could be read`
      : read.length === 1
        ? `${read[0]!.listing.name ?? v.name} on the ${storeName(read[0]!.ref.store)} scores ${read[0]!.scored.score ?? "no grade"}${read[0]!.scored.grade ? ` (${read[0]!.scored.grade})` : ""} on this app's rubric`
        : `${read.length} listings of ${v.name} audited: ${read.map((a) => `${storeName(a.ref.store)} ${a.scored.score ?? "refused"}`).join(", ")}`);

  const callouts = audited.map((a) =>
    a.listing.error
      ? plainCallout(`${h(storeName(a.ref.store))}<br><span class="nul">not read</span>`, h(a.listing.error))
      : callout(String(a.scored.score ?? "—"), a.scored.grade ? ` ${a.scored.grade}` : "", `${h(storeName(a.ref.store))} · ${h(a.listing.name ?? a.ref.appId)} · coverage ${h(a.scored.coverage)}${a.scored.refusal ? ` · ${h(a.scored.refusal)}` : ""}`),
  );

  const body: string[] = [];
  body.push(
    `<p class="note"><strong>The score is this app's own rubric and it is printed with its parts.</strong> Dimensions are weighted ${Object.entries(DIMENSIONS).map(([d, w]) => `${h(d)} ${w}`).join(", ")}; a check is worth 1 for pass, 0.5 for warn, 0 for fail; a check that could not be answered is out of the denominator entirely, and a dimension under ${COVERAGE_MIN * 100}% coverage is refused rather than guessed. It is not an App Store Optimization industry benchmark of any kind and it may not be compared with anybody else's score.</p>`,
  );

  for (const a of audited) body.push(listingCard(a, storeName(a.ref.store)));

  body.push(analysisHtml(analysis, "audit"));

  body.push(`<h2>Evidence</h2><ul class="plain">`);
  for (const a of audited)
    body.push(
      `<li>${h(a.listing.name ?? a.ref.appId)}: ${a.listing.url ? hostLink(a.listing.url, "the listing") : "no public listing URL"}${a.ref.store === "appstore" ? ", read through Apple's public lookup document" : ", title read from the store page and the rating from the Play Console export"}.</li>`,
    );
  body.push(`</ul>`);

  return page({
    finding,
    dateline: `Store listing audit · ${v.name} · ${audited.length} listing${audited.length === 1 ? "" : "s"} · ${day}`,
    verdict: analysis.verdict,
    callouts,
    body: body.join("\n"),
    footer: `Written ${day} from ${read.length} listing${read.length === 1 ? "" : "s"} this server read and ${audited.reduce((n, a) => n + a.rivals.length, 0)} rival listings read the same way. Every check was computed here; the analysis is a model's reading of those checks.`,
  });
}

function listingCard(a: Audited, store: string): string {
  const parts: string[] = [];
  parts.push(`<div class="cardhead"><span class="title">${h(a.listing.name ?? a.ref.appId)}</span><span class="badge badge-accent">${h(store)}</span>`);
  if (!a.listing.error) {
    parts.push(`<span class="pill pill-yes">score ${h(a.scored.score ?? "refused")}${a.scored.grade ? ` · ${h(a.scored.grade)}` : ""}</span>`);
    parts.push(`<span class="pill">coverage ${h(a.scored.coverage)}</span>`);
  }
  parts.push(`</div>`);
  if (a.listing.error) {
    parts.push(`<p class="warn">The listing could not be read: ${h(a.listing.error)}</p>`);
    return `<article class="card">${parts.join("")}</article>`;
  }
  if (a.scored.refusal) parts.push(`<p class="note"><span class="warn">Refused.</span> ${h(a.scored.refusal)}</p>`);
  parts.push(
    `<p class="note">Title ${h(a.listing.name?.length ?? 0)} chars · description ${a.listing.descriptionChars ?? "not read"} chars · screenshots ${a.listing.screenshots ?? "not read"} · rating ${a.listing.rating ?? "not read"}${a.listing.ratingCount === null ? "" : ` over ${a.listing.ratingCount} ratings`} · updated ${h(a.listing.updatedAt ?? "not read")}</p>`,
  );

  parts.push(`<h3>The score, by dimension</h3>`);
  parts.push(`<table><thead><tr><th>Dimension</th><th class="num">Weight</th><th class="num">Score</th><th class="num">Coverage</th><th>Why not</th></tr></thead><tbody>`);
  for (const [d, x] of Object.entries(a.scored.dimensions))
    parts.push(`<tr><td>${h(d)}</td><td class="num">${h(x.weight)}</td><td class="num">${x.score === null ? `<span class="nul">refused</span>` : h(x.score)}</td><td class="num">${h(x.coverage)}</td><td>${x.reason ? h(x.reason) : `<span class="nul">—</span>`}</td></tr>`);
  parts.push(`</tbody></table>`);
  parts.push(`<div class="arith">${a.scored.arithmetic.map((line) => h(line)).join("<br>")}</div>`);

  parts.push(`<h3>Every check</h3>`);
  parts.push(`<table><thead><tr><th>Check</th><th>Result</th><th>Computed from</th></tr></thead><tbody>`);
  for (const c of a.checks)
    parts.push(
      `<tr><td>${h(c.id)}</td><td>${c.result === null ? `<span class="nul">not scored</span>` : c.result === "pass" ? `<span class="yes">pass</span>` : c.result === "warn" ? `<span class="warn">warn</span>` : `<span class="warn">fail</span>`}</td><td>${h(c.detail)}</td></tr>`,
    );
  parts.push(`</tbody></table>`);

  if (a.listing.notes.length) {
    parts.push(`<p class="note">What could not be read, and why — this is part of the reading, not a footnote:</p><ul class="plain">`);
    for (const nn of a.listing.notes) parts.push(`<li>${h(nn)}</li>`);
    parts.push(`</ul>`);
  }

  parts.push(`<h3>Rival listings, read the same way</h3>`);
  if (a.rivals.length) {
    if (a.rivalNote) parts.push(`<p class="note">${h(a.rivalNote)}</p>`);
    parts.push(`<table><thead><tr><th>Listing</th><th>Store</th><th class="num">Title chars</th><th class="num">Screenshots</th><th class="num">Description chars</th><th class="num">Rating</th></tr></thead><tbody>`);
    for (const r of a.rivals)
      parts.push(
        `<tr><td>${hostLink(r.url, r.name)}${r.name ? ` ${h(r.name)}` : ""}</td><td>${h(r.store)}</td><td class="num">${r.titleChars ?? "—"}</td><td class="num">${r.screenshots ?? "—"}</td><td class="num">${r.descriptionChars ?? "—"}</td><td class="num">${r.rating ?? "—"}</td></tr>`,
      );
    parts.push(`</tbody></table>`);
  } else parts.push(`<p class="note">No competitor listing was read. ${h(a.rivalNote ?? "")}</p>`);

  return `<article class="card">${parts.join("")}</article>`;
}

/* ------------------------------------------------------------- rendering */

/* ------------------------------------------------------------- rendering */

function renderData(audited: Audited[]): string {
  const out: string[] = [];
  for (const a of audited) {
    out.push(`APP: ${a.listing.name ?? a.ref.appId} (${a.ref.store}, id ${a.ref.appId})`);
    if (a.listing.error) {
      out.push(`  the listing could not be read: ${a.listing.error}`);
      out.push("");
      continue;
    }
    out.push(
      `  score ${a.scored.score ?? "refused"}${a.scored.grade ? ` (${a.scored.grade})` : ""}${a.scored.refusal ? ` — ${a.scored.refusal}` : ""}`,
      `  title: ${a.listing.name} (${a.listing.name?.length ?? 0} chars); description ${a.listing.descriptionChars ?? "not read"} chars; screenshots ${a.listing.screenshots ?? "not read"}; rating ${a.listing.rating ?? "not read"}${a.listing.ratingCount === null ? "" : ` over ${a.listing.ratingCount} ratings`}; updated ${a.listing.updatedAt ?? "not read"}`,
      ...a.checks.map((c) => `  check ${c.id}: ${c.result ?? "not scored"} — ${c.detail}`),
      ...a.listing.notes.map((nn) => `  note: ${nn}`),
      ...(a.rivals.length
        ? a.rivals.map((r) => `  rival ${r.store} ${r.name ?? r.url}: title ${r.titleChars ?? "?"} chars, ${r.screenshots ?? "?"} screenshots, ${r.descriptionChars ?? "?"} description chars, rating ${r.rating ?? "?"}`)
        : [`  rivals: ${a.rivalNote ?? "none read"}`]),
      ``,
    );
  }
  return out.join("\n");
}

/* -------------------------------------------------------------- the reads */

type StoredAso = {
  run_id: string;
  venture_id: string;
  store: string;
  app_id: string;
  name: string | null;
  listing: string;
  checks: string;
  dimensions: string;
  score: number | null;
  grade: string | null;
  coverage: number | null;
  refusal: string | null;
  competitors: string;
  ts: string;
};

const parse = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

function shape(r: StoredAso) {
  return {
    runId: r.run_id,
    ventureId: r.venture_id,
    store: r.store,
    appId: r.app_id,
    name: r.name,
    listing: parse<Listing | null>(r.listing, null),
    checks: parse<CheckRow[]>(r.checks, []),
    dimensions: parse<Scored["dimensions"]>(r.dimensions, {}),
    score: r.score,
    grade: r.grade,
    coverage: r.coverage,
    refusal: r.refusal,
    competitors: parse<RivalListing[]>(r.competitors, []),
    ts: r.ts,
  };
}

export function asoForRun(runId: string) {
  return (db.prepare("SELECT * FROM growth_aso WHERE run_id = ? ORDER BY rowid").all(runId) as unknown as StoredAso[]).map(shape);
}

export function asoForVenture(ventureId: string, limit: number) {
  return (
    db.prepare("SELECT * FROM growth_aso WHERE venture_id = ? ORDER BY ts DESC, rowid LIMIT ?").all(ventureId, limit) as unknown as StoredAso[]
  ).map(shape);
}

export const ASO_RUBRIC = { dimensions: DIMENSIONS, value: VALUE, coverageFloor: COVERAGE_MIN, minLiveDimensions: MIN_LIVE_DIMENSIONS };
