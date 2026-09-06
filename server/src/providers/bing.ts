/**
 * Bing Webmaster Tools.
 *
 * ONE KEY, free, issued from Bing Webmaster Tools → Settings → API access, and
 * scoped to the USER rather than to a site: one key covers every site that
 * account has verified, which is why `GetUserSites` is asked once per run and
 * everything else feeds its answer straight back.
 *
 * WHY THIS INTEGRATION EXISTS AT ALL, GIVEN SEARCH CONSOLE IS ALREADY HERE.
 * Search Console is a rear-view mirror. It reports queries a page of ours
 * ALREADY RANKS FOR, and it is very good at that and structurally incapable of
 * anything else — there is no phrase in it that we have no page about. Bing's
 * `GetKeywordStats` answers the other question: how many people typed a phrase,
 * whether or not anything of ours came back. Every other keyword-volume API in
 * existence is a paid product, so there is one source for that number, it is
 * BING's impressions rather than Google's, and it is a shape rather than a
 * census. Nothing in this file or downstream of it ever adds a Bing impression
 * to a Google one.
 *
 * WHAT THIS ACCOUNT'S BING ACTUALLY ANSWERS, probed live on 2026-09-04 against
 * the three verified sites:
 *
 *   GetUserSites             200 · three sites, all verified
 *   GetRankAndTrafficStats   200 · 47 daily rows of impressions and clicks
 *   GetQueryStats            200 · 594 rows, per query PER DAY, with position
 *   GetCrawlStats            200 · 45 daily rows: crawled, in index, in links,
 *                                  errors, and the response-code split
 *   GetLinkCounts            200 · TotalPages 0 and an EMPTY list, on all
 *                                  three sites — see below
 *   GetKeywordStats(weather) 200 · 25 weekly rows, 374,727 impressions
 *
 * THE BACKLINK FINDING, WHICH CHANGED A CARD. `GetLinkCounts` is the endpoint
 * that can name a linking page, and for every site on this account it answers
 * with nothing at all. That is not a failure and it is not null: Bing answered,
 * and what it said was that it knows of no page of ours with a link into it.
 * Meanwhile the crawl statistics for the same site the same day reported 219
 * inbound links. Those are two different measurements — one is an index of
 * link SOURCES, the other is a crawler's count — so they are two fields, and
 * the one that could name a referring domain is the one that is empty. There
 * is therefore no referring-domain count anywhere downstream, because nothing
 * here can produce one.
 *
 * THE `d` ENVELOPE. Bing's JSON flavour wraps every SUCCESSFUL answer in `d` —
 * a list for a list return, an object for a single one — and signals failure as
 * an HTTP 400 with an UNWRAPPED body: `{"ErrorCode":3,"Message":"InvalidApiKey"}`.
 * A body without `d` is not an answer from this API and is never read as an
 * empty result, which is the difference between "the key is wrong" and "this
 * phrase has no data" — the two answers a reader most needs kept apart.
 */
import * as accounts from "../accounts.ts";
import type { Account } from "../accounts.ts";

const BASE = "https://ssl.bing.com/webmaster/api.svc/json";
const TIMEOUT_MS = 30_000;
const USER_AGENT = "onepersoncompany-collector/1.0";

/**
 * The market a keyword volume is FOR.
 *
 * Bing counts impressions per country and per language. "team chat" in
 * us/en-US and in ie/en-GB are two different numbers, and a figure rendered
 * without its market is a figure that will be read as a world total. It is
 * part of the row's key in the database and it is on the card.
 */
export const MARKET = { country: "us", language: "en-US" } as const;
export const MARKET_LABEL = `${MARKET.country}/${MARKET.language}`;

/**
 * The control phrase, and the only reason a zero here can ever be believed.
 *
 * Bing answers `{"d": []}` both for a phrase nobody searches AND for a phrase
 * it has decided not to discuss this minute. The two are indistinguishable
 * from the answer alone, so they are told apart by something outside it: a
 * phrase with large, stable, year-round volume in every market is asked
 * alongside the batch. If Bing says nobody searched for the weather this week,
 * Bing is not answering — and every phrase in that batch is UNMEASURED rather
 * than zero. Recording it as a volume of nothing is how "nobody wants this"
 * gets written next to a phrase that was merely throttled, and roadmaps get
 * made out of that.
 */
export const CONTROL = "weather";

/**
 * A phrase cap, because the calls are the budget.
 *
 * Every other Bing call in this file is one per site — thirteen requests for
 * this account's three sites. Keyword stats is one per PHRASE, so the list is
 * the only thing here that can make a run expensive. Forty at a second apiece
 * is under a minute, and a list longer than forty is a research project rather
 * than a dashboard.
 */
export const MAX_KEYWORDS = 40;

/** One request a second inside a run. Bing publishes no rate limit for this
 *  API; every client library in the wild self-throttles at about ten a second
 *  as a convention, so this sits an order of magnitude under a number nobody
 *  has actually documented. */
const GAP_MS = 1_000;

export class BingError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BingError";
    this.status = status;
  }
}

/* -------------------------------------------------------------------- http */

/**
 * A GET that answers `d` or throws.
 *
 * THE KEY IS IN THE QUERY STRING — Bing takes it no other way — which is why
 * `scrub` exists below and why every error message from this file goes through
 * it before it is stored on a run row that the interface displays.
 */
async function get(key: string, path: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams({ ...params, apikey: key });
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}?${q}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new BingError(
      0,
      err instanceof Error && err.name === "TimeoutError"
        ? "Bing Webmaster did not answer within 30 seconds."
        : "Could not reach Bing Webmaster.",
    );
  }

  const body = (await res.json().catch(() => null)) as
    | { d?: unknown; Message?: string; ErrorCode?: number }
    | null;

  if (!res.ok) {
    // Bing's own sentence where it sent one — "InvalidApiKey" is worth more
    // than "HTTP 400", and it is the difference between a typo and an outage.
    const detail = body?.Message ?? "";
    throw new BingError(res.status, `Bing answered HTTP ${res.status}${detail ? `: ${detail}` : ""}.`);
  }
  if (!body || !("d" in body))
    throw new BingError(res.status, "Bing answered without its `d` envelope, so that is not a result.");
  return body.d;
}

/** Take the key back out of anything Bing said before it is written down. It
 *  travels in the URL, so an error that echoes the URL would otherwise carry
 *  the credential into a run note the page renders. */
export function scrub(text: string, key: string): string {
  return (key.length >= 6 ? text.split(key).join("[redacted]") : text).slice(0, 220);
}

/* ------------------------------------------------------------------- dates */

const DATE_RE = /\/Date\((-?\d+)([+-]\d{4})?\)\//;

/**
 * `/Date(1788246000000-0700)/` → a calendar day.
 *
 * WCF ticks are milliseconds since the epoch with an optional timezone offset
 * that does NOT move the instant — it is a rendering hint about how Microsoft's
 * own console would display it — so it is matched and discarded rather than
 * added. Adding it would shift a day's traffic onto the day before it for
 * anyone west of Greenwich.
 */
export function wcfDay(value: unknown): string | null {
  const m = DATE_RE.exec(String(value ?? ""));
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;

/* ------------------------------------------------------------------- reads */

export type BingSite = { url: string; verified: boolean };

/**
 * The verified sites. ONE call for the whole run.
 *
 * THE EXACT URL STRING MATTERS and is fed straight back into every later call.
 * Microsoft's own documentation disagrees with itself about the trailing slash
 * — the JSON sample returns `http://example.com` and the C# sample on the next
 * page passes `http://example.com/` — so the only spelling guaranteed to match
 * is the one the account itself returned.
 */
export async function userSites(key: string): Promise<BingSite[]> {
  const d = await get(key, "GetUserSites");
  if (!Array.isArray(d)) throw new BingError(200, "GetUserSites answered without a site list.");
  return d
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({ url: String(r.Url ?? "").trim(), verified: r.IsVerified === true }))
    .filter((s) => !!s.url);
}

export type TrafficDay = { day: string; impressions: number | null; clicks: number | null };

/** What Bing showed and what was clicked, per day. */
export async function rankAndTraffic(key: string, site: string): Promise<TrafficDay[]> {
  const d = await get(key, "GetRankAndTrafficStats", { siteUrl: site });
  if (!Array.isArray(d)) return [];
  return d
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({ day: wcfDay(r.Date), impressions: int(r.Impressions), clicks: int(r.Clicks) }))
    .filter((r): r is TrafficDay => r.day !== null);
}

export type CrawlDay = {
  day: string;
  crawledPages: number | null;
  inIndex: number | null;
  inLinks: number | null;
  crawlErrors: number | null;
  blockedRobots: number | null;
  code2xx: number | null;
  code4xx: number | null;
  code5xx: number | null;
};

/**
 * What the crawler did, per day — and where `inLinks` comes from.
 *
 * `InIndex` is how many pages of the site Bing is holding, which is the one
 * index-coverage figure available anywhere here for free. `InLinks` is the
 * crawler's own inbound-link count and is NOT the link endpoint's answer; see
 * this file's header for why the two disagree so loudly on this account.
 */
export async function crawlStats(key: string, site: string): Promise<CrawlDay[]> {
  const d = await get(key, "GetCrawlStats", { siteUrl: site });
  if (!Array.isArray(d)) return [];
  return d
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      day: wcfDay(r.Date),
      crawledPages: int(r.CrawledPages),
      inIndex: int(r.InIndex),
      inLinks: int(r.InLinks),
      crawlErrors: int(r.CrawlErrors),
      blockedRobots: int(r.BlockedByRobotsTxt),
      code2xx: int(r.Code2xx),
      code4xx: int(r.Code4xx),
      code5xx: int(r.Code5xx),
    }))
    .filter((r): r is CrawlDay => r.day !== null);
}

export type QueryDay = {
  query: string;
  day: string;
  impressions: number | null;
  clicks: number | null;
  position: number | null;
};

/**
 * Bing's own query report, at the grain Bing reports it: per query PER DAY.
 *
 * `AvgClickPosition` comes back as -1 for a query that was never clicked,
 * which is a sentinel and not a rank; only `AvgImpressionPosition` is read, and
 * it is the one that answers "where does this actually show".
 */
export async function queryStats(key: string, site: string): Promise<QueryDay[]> {
  const d = await get(key, "GetQueryStats", { siteUrl: site });
  if (!Array.isArray(d)) return [];
  return d
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      query: String(r.Query ?? "").trim(),
      day: wcfDay(r.Date),
      impressions: int(r.Impressions),
      clicks: int(r.Clicks),
      position: int(r.AvgImpressionPosition),
    }))
    .filter((r): r is QueryDay => r.day !== null && !!r.query);
}

export type LinkCounts = {
  /** How many of OUR pages Bing knows to have a link into them. A real 0 is a
   *  measurement; null is the call having failed. */
  linkedPages: number | null;
  /** Bing's own pagination total for that list, kept because a walked slice
   *  presented as the whole is the mistake this field prevents. */
  totalPages: number | null;
};

export async function linkCounts(key: string, site: string): Promise<LinkCounts> {
  const d = (await get(key, "GetLinkCounts", { siteUrl: site, page: "0" })) as
    | { TotalPages?: unknown; Links?: unknown[] }
    | null;
  if (!d || typeof d !== "object")
    throw new BingError(200, "GetLinkCounts answered with something other than a link summary.");
  return {
    linkedPages: Array.isArray(d.Links) ? d.Links.length : 0,
    totalPages: int(d.TotalPages),
  };
}

export type KeywordWeek = { week: string; impressions: number | null; broad: number | null };

/**
 * One phrase's weekly series, oldest first.
 *
 * An EMPTY answer is returned as an empty array and NEVER as a zero. The
 * caller turns it into `na` or `void` depending on what the control said,
 * which is the whole reason this function refuses to interpret it.
 */
export async function keywordStats(key: string, phrase: string): Promise<KeywordWeek[]> {
  const d = await get(key, "GetKeywordStats", {
    q: phrase,
    country: MARKET.country,
    language: MARKET.language,
  });
  if (d === null || d === undefined) return [];
  if (!Array.isArray(d)) throw new BingError(200, "GetKeywordStats answered with something other than weekly rows.");
  return d
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      week: wcfDay(r.Date),
      impressions: int(r.Impressions),
      /* `BroadImpressions` counts the phrase plus everything Bing considers a
         broad match of it, so it is several times the exact figure and is a
         DIFFERENT measurement. Its own column, never added to the one beside
         it, and never quietly substituted when the exact figure is small. */
      broad: int(r.BroadImpressions),
    }))
    .filter((r): r is KeywordWeek => r.week !== null)
    .sort((a, b) => a.week.localeCompare(b.week));
}

/* ------------------------------------------------------------------ verify */

/**
 * Is this key real, and has it got anything to look at?
 *
 * ONE call, and it is the one that proves both: `GetUserSites` needs a valid
 * key and answers with the account's whole reason to exist. A key belonging to
 * an account that has verified no site is refused with what to do about it,
 * rather than stored to produce an empty board an hour later.
 */
export async function verify(
  key: string,
): Promise<{ ok: true; sites: number } | { ok: false; error: string }> {
  try {
    const sites = await userSites(key);
    if (!sites.length)
      return {
        ok: false,
        error:
          "The key works, but this Bing account has no verified site. Add and verify a site in Bing Webmaster Tools first.",
      };
    return { ok: true, sites: sites.length };
  } catch (err) {
    return {
      ok: false,
      error: scrub(err instanceof Error ? err.message : "Could not reach Bing Webmaster.", key),
    };
  }
}

/* ----------------------------------------------------------------- collect */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SiteResult = {
  site: string;
  verified: boolean;
  traffic: TrafficDay[];
  crawl: CrawlDay[];
  queries: QueryDay[];
  links: LinkCounts;
  error: string | null;
};

export type KeywordResult = {
  phrase: string;
  status: "ok" | "na" | "void" | "failed";
  weeks: KeywordWeek[];
  error: string | null;
};

export type AccountResult = {
  id: number;
  label: string;
  ok: boolean;
  error?: string;
  sites?: SiteResult[];
  keywords?: KeywordResult[];
  /** True when the control phrase answered, so a reader of the run note can
   *  tell "no volume" from "Bing was not talking to us". */
  controlAnswered?: boolean | null;
};

export type CollectResult = {
  accounts: AccountResult[];
  accountsTried: number;
  warnings: string[];
};

/** One site's four reads. Each degrades on its own: a site whose query report
 *  fails keeps its traffic, its crawl figures and its links. */
async function collectSite(key: string, site: BingSite): Promise<SiteResult> {
  const out: SiteResult = {
    site: site.url,
    verified: site.verified,
    traffic: [],
    crawl: [],
    queries: [],
    links: { linkedPages: null, totalPages: null },
    error: null,
  };
  const problems: string[] = [];
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      problems.push(`${name}: ${scrub(err instanceof Error ? err.message : "failed", key)}`);
    }
    await sleep(GAP_MS);
  };

  await step("traffic", async () => void (out.traffic = await rankAndTraffic(key, site.url)));
  await step("crawl", async () => void (out.crawl = await crawlStats(key, site.url)));
  await step("queries", async () => void (out.queries = await queryStats(key, site.url)));
  await step("links", async () => void (out.links = await linkCounts(key, site.url)));

  out.error = problems.length ? problems.join(" · ").slice(0, 220) : null;
  return out;
}

/**
 * The phrase list, measured, with the control asked first.
 *
 * ONE CONTROL FOR THE RUN rather than one per twenty, because the cap above is
 * forty and a run is under a minute — the batch-and-cooldown discipline this was
 * ported from exists for a rotation that runs for half an hour, and splitting
 * forty phrases into two batches here would buy a second control call and no
 * extra information. The rule it enforces is unchanged: if the control did not
 * answer, nothing measured beside it is a measurement.
 */
async function collectKeywords(
  key: string,
  phrases: string[],
): Promise<{ results: KeywordResult[]; controlAnswered: boolean | null }> {
  if (!phrases.length) return { results: [], controlAnswered: null };

  let controlAnswered: boolean | null = null;
  try {
    controlAnswered = (await keywordStats(key, CONTROL)).length > 0;
  } catch {
    // The control call itself failing is not the same as the control coming
    // back empty, but it has the same consequence: nothing this run can be
    // called a measurement of no demand.
    controlAnswered = null;
  }
  await sleep(GAP_MS);

  const results: KeywordResult[] = [];
  for (const phrase of phrases) {
    try {
      const weeks = await keywordStats(key, phrase);
      if (weeks.length) results.push({ phrase, status: "ok", weeks, error: null });
      else
        results.push({
          phrase,
          status: controlAnswered === true ? "na" : "void",
          weeks: [],
          error: null,
        });
    } catch (err) {
      results.push({
        phrase,
        status: "failed",
        weeks: [],
        error: scrub(err instanceof Error ? err.message : "failed", key),
      });
    }
    await sleep(GAP_MS);
  }
  return { results, controlAnswered };
}

export async function collect(
  phrases: string[],
  reader = "collect_bing",
): Promise<CollectResult> {
  const { ready, broken } = accounts.credentialed("bing-webmaster", ["key"], reader);
  const out: AccountResult[] = [];
  const warnings: string[] = [];

  for (const { account } of broken) {
    out.push({ id: account.id, label: account.label, ok: false, error: "No API key stored." });
    warnings.push(`${account.label}: no key stored`);
  }

  for (const { account, values } of ready) {
    const key = (values.key ?? "").trim();
    try {
      const sites = await userSites(key);
      const results: SiteResult[] = [];
      for (const site of sites) results.push(await collectSite(key, site));
      const { results: keywords, controlAnswered } = await collectKeywords(key, phrases);
      if (controlAnswered === false)
        warnings.push(
          `${account.label}: the control phrase returned nothing, so this run's keyword volumes are unmeasured rather than zero`,
        );
      out.push({
        id: account.id,
        label: account.label,
        ok: true,
        sites: results,
        keywords,
        controlAnswered,
      });
    } catch (err) {
      const message = scrub(err instanceof Error ? err.message : "Error", key);
      out.push({ id: account.id, label: account.label, ok: false, error: message });
      warnings.push(`${account.label}: ${message}`);
    }
  }

  return { accounts: out, accountsTried: ready.length + broken.length, warnings };
}

/**
 * The phrase list, as the owner typed it.
 *
 * Split on commas and newlines but NOT on spaces, because a keyword is a
 * PHRASE — "team chat" is one thing to ask about and two things if the
 * separator is whitespace, which is the bug that would turn a list of ten
 * phrases into thirty meaningless words.
 */
export function parseKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\n]+/)) {
    const phrase = part.trim().replace(/\s+/g, " ").toLowerCase();
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }
  return out.slice(0, MAX_KEYWORDS);
}

export type { Account };
