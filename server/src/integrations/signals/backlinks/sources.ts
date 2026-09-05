/**
 * Link profile, from sources that cost nothing, with the confidence written
 * on every number.
 *
 * Ported from workdash's `collectors/collect_backlinks.py`, whose argument is
 * kept whole: the good backlink sources are all paid APIs, three free ones
 * exist, they disagree about how much they know, and the honest way to use
 * them is to say which one produced each figure and how much that source is
 * worth.
 *
 * THE THREE SOURCES AND WHAT EACH IS WORTH
 *   · THE VERIFICATION CRAWLER — 0.95. It fetches a page that is supposed to
 *     link here and looks. It is the only source that can be WRONG in a way
 *     this box can detect, which is exactly why it scores highest: everything
 *     else is a third party's recollection, this is an observation. It also
 *     answers the one question no index answers — is the link still there,
 *     and is it nofollow.
 *   · BING WEBMASTER TOOLS — 0.70. Free with a verified site, and reached
 *     through the `bing-webmaster` plugin's existing key: no second
 *     credential, no second page to fill in. It names our pages that have
 *     links in (GetLinkCounts) and, per page, the linking urls with their
 *     anchor text (GetUrlLinks). A real index, not Google's, and a sample
 *     rather than a census.
 *   · COMMON CRAWL — 0.50, and it is worth reading why it is only that.
 *
 * WHY COMMON CRAWL CANNOT ANSWER THE QUESTION IT LOOKS LIKE IT ANSWERS.
 * Common Crawl publishes a host-level hyperlink graph. It would be the
 * perfect free in-degree source, and THERE IS NO WAY TO QUERY IT: the graph
 * ships as bulk files — tens of gigabytes for the host-level edges alone —
 * and no HTTP endpoint will say how many hosts link to one domain. What its
 * INDEX gives cheaply is how many pages of a domain the open web actually
 * captured. That is crawl presence, a real signal about whether a site exists
 * as far as the commons is concerned, and it is emphatically not in-degree.
 * So `referring_domains` from this source is null with that sentence attached,
 * on every host, every run, until a queryable source exists.
 *
 * ZERO IS A REAL ANSWER AND IT IS NOT NULL. Common Crawl's index answers HTTP
 * 404 with "No Captures found" for a domain it has never seen — a measurement
 * of zero. A timeout is a null. The two are kept apart in every function here
 * and all the way into the database.
 *
 * WHAT IS DELIBERATELY NOT PORTED: the seven-factor 0-100 score. It merges
 * three sources into one number, and this document's whole contract is that
 * the sources are reported apart because they disagree by design. The
 * confidences are published on every row so a reader — or a phase-2 page —
 * can do the weighting in the open rather than inheriting one made here.
 */
import * as bing from "../../../providers/bing.ts";

/** What each source's word is worth. Multipliers on a factor's weight, not on
 *  its value: a figure from Common Crawl counts for what it says, it just
 *  counts for less than the same figure observed by our own crawler. */
export const CONFIDENCE: Record<Source, number> = {
  verify: 0.95,
  bing: 0.7,
  commoncrawl: 0.5,
};

export const SOURCE_LABEL: Record<Source, string> = {
  verify: "Verification crawler",
  bing: "Bing Webmaster Tools",
  commoncrawl: "Common Crawl index",
};

export type Source = "verify" | "bing" | "commoncrawl";

/** The one thing this file measures nothing about, in one sentence, so a page
 *  can print it rather than leaving a hole where a number should be. */
export const INDEGREE_NOTE =
  "host in-degree — how many distinct sites link to this one across the whole " +
  "web — is not measured. Common Crawl's hyperlink graph is the only free " +
  "source for it and it ships as multi-gigabyte bulk files with no query " +
  "endpoint, so nothing here can ask. What Common Crawl contributes is crawl " +
  "presence: how many pages of the domain its index captured.";

const UA = "onepersoncompany-backlinks/1.0 (+https://github.com/onepersoncompany)";
const TIMEOUT_MS = 25_000;

/** How many of our own linked pages to pull link details for, per host. Each
 *  is one Bing call and yields up to a page of linking urls. */
export const BING_PAGES = 5;
export const BING_DETAIL_URLS = 10;
/** How many linking pages to actually go and look at. The verification
 *  crawler is the slowest and most valuable source; twenty-five at one a
 *  second is twenty-five seconds and a defensible sample. */
export const VERIFY_MAX = 25;
const VERIFY_BYTES = 600_000;
/** Common Crawl's index is asked for one page of results per domain. A full
 *  page back makes the count a FLOOR, and the note says so. */
export const CC_LIMIT = 1_000;
export const MAX_ROWS = 60;

/* -------------------------------------------------------------- the hosts */

/** Strip a leading `www.` and nothing else — workdash's rule, kept because
 *  every comparison downstream has to use the same one. */
export function registrable(host: string | null | undefined): string {
  const h = (host ?? "").toLowerCase().trim().replace(/\.$/, "");
  return h.startsWith("www.") ? h.slice(4) : h;
}

/** The configured list, from one text field. Commas or newlines, because both
 *  are what a person pastes. A url is accepted and reduced to its host: the
 *  owner pastes what is in the address bar. */
export function parseHosts(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const host = hostOf(part.trim());
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

/** One entry as a hostname, or "" when it is not one. */
export function hostOf(value: string): string {
  if (!value) return "";
  let candidate = value;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).hostname;
    } catch {
      return "";
    }
  }
  const host = registrable(candidate.split("/")[0]);
  // A hostname, not a path, not a sentence: labels of letters, digits and
  // hyphens with at least one dot. Checked here so that nothing that is not a
  // host can ever reach a url this file builds.
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
    ? host
    : "";
}

const sameHost = (candidate: string, host: string) =>
  candidate === host || candidate.endsWith(`.${host}`);

/* -------------------------------------------------------------- transport */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A gap that is MEASURED rather than slept blindly: the wait is what is left
 *  of it since the last call, so a slow response has already paid part of it. */
export class Pace {
  private last = 0;
  private readonly gap: number;
  constructor(gap: number) {
    this.gap = gap;
  }
  async wait() {
    if (this.gap <= 0) return;
    const left = this.gap - (Date.now() - this.last);
    if (left > 0) await sleep(left);
    this.last = Date.now();
  }
}

type Fetched<T> = { ok: true; data: T } | { ok: false; error: string; status: number | null };

async function getJson<T>(url: string, accept = "application/json"): Promise<Fetched<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return {
      ok: false,
      status: null,
      error: name === "TimeoutError" ? "no answer within 25 seconds" : `unreachable (${name})`,
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: `HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}` };
  }
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, status: res.status, error: "the answer was not JSON" };
  }
}

/* ---------------------------------------------------------- Common Crawl */

const CC_COLLINFO = "https://index.commoncrawl.org/collinfo.json";

export type CrawlIndex = { api: string; id: string | null };

/**
 * The newest index, asked ONCE PER RUN rather than once per host.
 *
 * `collinfo.json` is a JSON array, newest first, and every entry carries its
 * `cdx-api` base verbatim. Reading it rather than composing a crawl id by
 * hand is what stops this breaking the week Common Crawl changes its naming.
 */
export async function latestIndex(): Promise<{ index: CrawlIndex | null; error: string | null }> {
  const got = await getJson<{ "cdx-api"?: string; id?: string }[]>(CC_COLLINFO);
  if (!got.ok) return { index: null, error: got.error };
  const first = Array.isArray(got.data) ? got.data[0] : null;
  const api = String(first?.["cdx-api"] ?? "").trim();
  if (!api.startsWith("http"))
    return { index: null, error: "the newest index carried no cdx-api url" };
  return { index: { api, id: first?.id ?? null }, error: null };
}

export type CrawlPresence = { pages: number; atLeast: boolean };

/**
 * Captured pages for one domain.
 *
 * THE 404 IS AN ANSWER. The index replies HTTP 404 with "No Captures found
 * for: …" when it has never seen the domain, and that is a measurement of
 * zero rather than a fault. Every other failure is a null.
 */
export async function crawlPresence(
  index: CrawlIndex,
  host: string,
  limit = CC_LIMIT,
): Promise<{ presence: CrawlPresence | null; error: string | null }> {
  const url =
    `${index.api}?url=${encodeURIComponent(host)}` +
    `&matchType=domain&fl=url&output=json&limit=${limit}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/x-ndjson" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return {
      presence: null,
      error: name === "TimeoutError" ? "no answer within 25 seconds" : `unreachable (${name})`,
    };
  }
  if (res.status === 404) return { presence: { pages: 0, atLeast: false }, error: null };
  if (!res.ok) return { presence: null, error: `HTTP ${res.status}` };

  const body = await res.text();
  // NDJSON, one object per line. A bad line is skipped rather than fatal: a
  // truncated last line is the ordinary shape of a response cut at a limit.
  const seen = new Set<string>();
  let lines = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines += 1;
    try {
      const url = String((JSON.parse(trimmed) as { url?: unknown }).url ?? "").trim();
      if (url) seen.add(url);
    } catch {
      continue;
    }
  }
  return { presence: { pages: seen.size, atLeast: lines >= limit }, error: null };
}

/* ------------------------------------------------------------------- Bing */

/**
 * THE TWO CALLS providers/bing.ts DOES NOT MAKE, AND WHY THEY ARE HERE.
 *
 * That file is the `bing-webmaster` plugin's client and it reads what that
 * plugin's own page shows: traffic, queries, crawl stats, and `GetLinkCounts`
 * reduced to a COUNT — it deliberately keeps no linking urls, because its
 * header records that this account's sites answer that endpoint with nothing
 * at all. This integration needs the urls themselves (they are the only
 * candidates the verification crawler is allowed to look at) and it needs
 * `GetUrlLinks`, which nothing there calls. Rather than widen a shared
 * provider that four areas are editing around, the two extra reads live here
 * — against the same base url, with the same `d` envelope rule and the same
 * `scrub` on the way out, all three imported or copied deliberately.
 */
const BING_BASE = "https://ssl.bing.com/webmaster/api.svc/json";

async function bingGet<T>(key: string, path: string, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams({ ...params, apikey: key });
  let res: Response;
  try {
    res = await fetch(`${BING_BASE}/${path}?${q}`, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(
      err instanceof Error && err.name === "TimeoutError"
        ? "Bing Webmaster did not answer within 30 seconds."
        : "Could not reach Bing Webmaster.",
    );
  }
  const body = (await res.json().catch(() => null)) as { d?: unknown; Message?: string } | null;
  if (!res.ok)
    throw new Error(`Bing answered HTTP ${res.status}${body?.Message ? `: ${body.Message}` : ""}.`);
  // A body without `d` is not an answer from this API and is never read as an
  // empty result — the difference between "the key is wrong" and "there is
  // nothing here", which is the pair a reader most needs kept apart.
  if (!body || !("d" in body))
    throw new Error("Bing answered without its `d` envelope, so that is not a result.");
  return body.d as T;
}

/** Which site string to feed back to Bing for a host, or null when this
 *  account has not verified it. The EXACT string the account returned, never
 *  one composed here: Microsoft's own docs disagree with themselves about the
 *  trailing slash, so the only spelling guaranteed to match is theirs. */
export async function bingSiteFor(key: string, host: string): Promise<string | null> {
  const sites = await bing.userSites(key);
  for (const site of sites) {
    let siteHost = "";
    try {
      siteHost = registrable(new URL(site.url).hostname);
    } catch {
      continue;
    }
    if (siteHost === host) return site.url;
  }
  return null;
}

export type LinkedPage = { url: string; count: number | null };

/**
 * Our own pages that have links into them, walked over at most `pages` pages.
 *
 * Bing pages this zero-based with `TotalPages` in the answer; the docs' own
 * loop is `do {…} while (++page < TotalPages)`. The caller records the
 * shortfall rather than presenting a slice as a total.
 */
export async function bingLinkedPages(
  key: string,
  site: string,
  pace: Pace,
  pages = BING_PAGES,
): Promise<{ rows: LinkedPage[]; totalPages: number | null }> {
  const rows: LinkedPage[] = [];
  let totalPages: number | null = null;
  for (let page = 0; page < pages; page++) {
    await pace.wait();
    const d = await bingGet<{ TotalPages?: unknown; Links?: unknown[] } | null>(
      key,
      "GetLinkCounts",
      { siteUrl: site, page: String(page) },
    );
    if (!d || typeof d !== "object")
      throw new Error("GetLinkCounts answered with something other than a link summary.");
    if (typeof d.TotalPages === "number") totalPages = d.TotalPages;
    for (const raw of d.Links ?? []) {
      const row = raw as { Url?: unknown; Count?: unknown };
      const url = String(row.Url ?? "").trim();
      if (!url) continue;
      rows.push({
        url: url.slice(0, 300),
        count: typeof row.Count === "number" ? Math.round(row.Count) : null,
      });
    }
    if (totalPages === null || page + 1 >= totalPages) break;
  }
  return { rows, totalPages };
}

export type LinkingUrl = { url: string; anchor: string | null; to: string };

/** Who links to one of our urls, with the anchor text. One page of details
 *  per url: the second page of links to a single page of ours buys much less
 *  than the first page of links to a different one, and the calls are the
 *  budget. */
export async function bingLinkingUrls(
  key: string,
  site: string,
  link: string,
  pace: Pace,
): Promise<LinkingUrl[]> {
  await pace.wait();
  const d = await bingGet<{ Details?: unknown[] } | null>(key, "GetUrlLinks", {
    siteUrl: site,
    link,
    page: "0",
  });
  const out: LinkingUrl[] = [];
  for (const raw of (d as { Details?: unknown[] } | null)?.Details ?? []) {
    const row = raw as { Url?: unknown; AnchorText?: unknown };
    const url = String(row.Url ?? "").trim();
    if (!url) continue;
    const anchor = String(row.AnchorText ?? "").split(/\s+/).join(" ").trim().slice(0, 120);
    out.push({ url: url.slice(0, 300), anchor: anchor || null, to: link });
  }
  return out;
}

export const scrub = bing.scrub;

/* ------------------------------------------------- the verification crawler */

/**
 * Every `<a>` on a page that points at one host, with its rel and its text.
 *
 * A SCANNER, NOT A PARSER, and the distinction is deliberate rather than
 * lazy. This server has no HTML parser and takes no dependency to get one;
 * what is needed is three attributes off one element type, and the failure
 * mode of getting it slightly wrong is a link counted or missed on somebody
 * else's page — not a wrong figure about our own data. `rel` is read from an
 * attribute rather than by matching the word anywhere in the tag, because
 * `rel="ugc nofollow"`, `rel=nofollow` and no rel at all are three different
 * answers and the middle one decides whether a link passes authority.
 */
export type Anchor = { href: string; nofollow: boolean; rel: string | null; anchor: string | null };

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]{0,4000}?)<\/a>/gi;
const ATTR_RE = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

export function anchorsTo(html: string, target: string, base: string): Anchor[] {
  const out: Anchor[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(ATTR_RE))
      attrs[a[1]!.toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const href = (attrs.href ?? "").trim();
    if (!href) continue;
    let full: URL;
    try {
      full = new URL(href, base);
    } catch {
      continue;
    }
    if (!sameHost(registrable(full.hostname), target)) continue;
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const text = m[2]!
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .split(/\s+/)
      .join(" ")
      .trim();
    out.push({
      href: full.toString().slice(0, 300),
      // `ugc` and `sponsored` are recorded as the same refusal to pass
      // authority, which is what they mean, rather than as three columns
      // nobody reads.
      nofollow: rel.some((r) => r === "nofollow" || r === "ugc" || r === "sponsored"),
      rel: rel.join(" ") || null,
      anchor: text.slice(0, 120) || null,
    });
  }
  return out;
}

export type Verified = {
  url: string;
  /** THREE-VALUED, and that is the entire point: true means the link is on
   *  the page, false means the page answered and the link is not on it, and
   *  null means we could not look. A 403 from a WAF is a null — it is not a
   *  removed link, and counting it as one would report a profile decaying
   *  every time a publisher put Cloudflare in front of itself. */
  live: boolean | null;
  nofollow: boolean | null;
  anchor: string | null;
  to: string | null;
  error: string | null;
};

/** A bounded HTML read. Bounded because a linking page is somebody else's and
 *  may be a 40 MB single-page app; the link we are looking for is in the
 *  markup or it is not, and reading past the cap buys nothing. */
async function readPage(url: string): Promise<{ html: string | null; error: string | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return { html: null, error: name === "TimeoutError" ? "no answer in time" : `unreachable (${name})` };
  }
  if (!res.ok) return { html: null, error: `HTTP ${res.status}` };
  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (type && !type.includes("html")) return { html: null, error: `not HTML (${type.split(";")[0]})` };
  const buf = await res.arrayBuffer().catch(() => null);
  if (!buf) return { html: null, error: "the body could not be read" };
  return {
    html: new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, VERIFY_BYTES)),
    error: null,
  };
}

/** One supposed linking page, fetched and read. */
export async function verifyLink(url: string, host: string, pace: Pace): Promise<Verified> {
  await pace.wait();
  const { html, error } = await readPage(url);
  if (html === null)
    return { url, live: null, nofollow: null, anchor: null, to: null, error };
  const hits = anchorsTo(html, host, url);
  if (!hits.length) return { url, live: false, nofollow: null, anchor: null, to: null, error: null };
  // A page may link here several times. THE FOLLOWED ONE WINS: what matters
  // is whether any of them passes authority, and reporting the nofollow in
  // the footer while a followed link sits in the body would be wrong.
  const best = [...hits].sort(
    (a, b) => Number(a.nofollow) - Number(b.nofollow) || Number(!a.anchor) - Number(!b.anchor),
  )[0]!;
  return {
    url,
    live: true,
    nofollow: best.nofollow,
    anchor: best.anchor,
    to: best.href,
    error: null,
  };
}
