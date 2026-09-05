/**
 * THE SEO AUDIT — crawl the venture's own site and say what is wrong with it.
 *
 * WHY THIS IS A VENTURE THING AND NOT AN INTEGRATION. Every other search
 * figure on this box is somebody else's report about the site: Search Console
 * says what Google showed, Bing says what Bing crawled, and both of them are a
 * rear-view mirror on a site whose current state neither describes. This
 * fetches the pages. It is the only thing here that can say "that page has no
 * title today", and it needs no credential to do it, because the site is the
 * owner's and it is public.
 *
 * IT OBEYS ROBOTS.TXT ON THE OWNER'S OWN SITE, and that is not a formality.
 * A disallowed path is usually disallowed for a reason — an admin area, a
 * search results page, an infinite calendar — and a crawler that ignored it
 * would spend its sixty-page budget on the part of the site the owner already
 * decided nobody should index. The user agent is `OnePersonCompany/0.1
 * (+audit)`, which is what the site's own logs will show, and the rules for
 * that agent are read before the rules for `*`.
 *
 * POLITE BY CONSTRUCTION AND CAPPED IN FOUR PLACES. One request at a time, a
 * 300 ms gap between them, ten seconds each, and a wall clock the whole crawl
 * cannot exceed. Sixty pages is a survey rather than a mirror: it is enough to
 * find the pattern — the missing descriptions, the duplicated titles, the
 * thin pages — and it is not enough to be a load on somebody's server. What
 * was not reached is reported as not reached.
 *
 * WHAT IS MEASURED AND WHAT IS INFERRED. Everything per page is measured: the
 * status, the title as it is, its length in characters, the description, how
 * many h1s, the canonical, a noindex, the word count, the links out. The
 * SITE-level findings are inferred from those measurements and each one says
 * what it was inferred from. Nothing here scores the site: a number out of a
 * hundred is a made-up figure that hides which of its inputs moved, and this
 * file's whole argument is that a finding should name its evidence.
 *
 * THE SEARCH CONSOLE JOIN IS THE POINT OF DOING THIS HERE. A missing meta
 * description on a page nobody has ever seen is a chore; the same fault on the
 * page with four thousand impressions is the afternoon's work. The join is
 * over `venture_links` — the plugin `gsc` entities linked to this venture —
 * rather than over a hostname match invented here, because the connection map
 * is where "which property is this venture's" is decided and a second rule
 * would eventually be a different rule.
 */
import { Hono } from "hono";
import { db, now, ventureRow, ventureRows } from "../../db.ts";
import { linkedEntities } from "./links.ts";

export const auditRoutes = new Hono();

const UA = "OnePersonCompany/0.1 (+audit)";

/** Pages fetched, at most. A survey, not a mirror — see the header. */
const PAGE_CAP = 60;
/** Unique internal links HEADed to see whether they answer. */
const LINK_CAP = 150;
/** Between requests. One at a time and a third of a second apart is a load no
 *  server notices and a crawl that takes a minute. */
const GAP_MS = 300;
const REQUEST_MS = 10_000;
/** The crawl's own wall clock. What it has not reached by then is reported as
 *  unreached rather than waited for. */
const CRAWL_MS = 120_000;
/** The link check's, after the crawl. Separate budgets so a slow crawl cannot
 *  eat the check and leave "no broken links" meaning "nothing was tried". */
const LINKS_MS = 45_000;
/** Bytes of one page read. A 2 MB HTML document is a page whose head is in the
 *  first few kilobytes either way. */
const PAGE_CAP_BYTES = 1_500_000;

/** Under this, a page is thin: not enough prose for a search engine to know
 *  what it is about. The number is the one every SEO tool uses and it is a
 *  convention rather than a measurement, which the finding says. */
const THIN_WORDS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Paths that are the CDN's rather than the site's.
 *
 * Cloudflare serves `/cdn-cgi/` off every zone it fronts: the email-protection
 * decoder, the challenge endpoints, and — on a zone with bot management on —
 * one-time `/cdn-cgi/content?id=…` links injected into the HTML that 404 for
 * anything that is not the browser session they were minted for. Crawled, they
 * produce a page-error, a noindex and a broken link EACH, about infrastructure
 * the owner does not control and cannot fix. Measured on example-app-1.example.test on
 * 2026-09-05: fourteen of the first sixty pages were these.
 *
 * So they are skipped, and the count of them is REPORTED rather than silently
 * dropped — a crawler that quietly ignores a fifth of a site's links is a
 * crawler whose "no broken links" means nothing.
 */
const NOT_THE_SITE = /^\/cdn-cgi\//;

/* ------------------------------------------------------------------ http */

type Fetched = {
  url: string;
  status: number;
  chain: string[];
  type: string | null;
  body: string;
  bytes: number;
  ms: number;
  error: string | null;
};

/**
 * One request, following redirects by hand so the CHAIN survives.
 *
 * `redirect: "follow"` would give the final answer and throw the hops away —
 * and a hop is a finding: a link that goes 301 → 301 → 200 costs every crawler
 * two round trips for ever, and nothing but the chain can show it.
 */
async function get(
  url: string,
  method: "GET" | "HEAD",
  deadline: number,
): Promise<Fetched> {
  const started = Date.now();
  const chain: string[] = [];
  let current = url;

  for (let hop = 0; hop < 6; hop++) {
    if (Date.now() >= deadline)
      return { url: current, status: 0, chain, type: null, body: "", bytes: 0, ms: Date.now() - started, error: "The audit ran out of time before this request." };
    try {
      const res = await fetch(current, {
        method,
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(Math.min(REQUEST_MS, Math.max(1, deadline - Date.now()))),
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { url: current, status: res.status, chain, type: null, body: "", bytes: 0, ms: Date.now() - started, error: `A redirect pointed at “${location}”, which is not a URL.` };
        }
        chain.push(`${res.status} ${current} → ${next}`);
        current = next;
        continue;
      }

      let body = "";
      let bytes = 0;
      if (method === "GET") {
        const buf = new Uint8Array(await res.arrayBuffer());
        bytes = buf.length;
        body = new TextDecoder("utf-8").decode(buf.slice(0, PAGE_CAP_BYTES));
      }
      return {
        url: current,
        status: res.status,
        chain,
        type: res.headers.get("content-type"),
        body,
        bytes,
        ms: Date.now() - started,
        error: null,
      };
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      return {
        url: current,
        status: 0,
        chain,
        type: null,
        body: "",
        bytes: 0,
        ms: Date.now() - started,
        error:
          name === "TimeoutError"
            ? `No answer within ${REQUEST_MS / 1000} seconds.`
            : `Could not be fetched (${name}).`,
      };
    }
  }
  return { url: current, status: 0, chain, type: null, body: "", bytes: 0, ms: Date.now() - started, error: "More than five redirects." };
}

/* --------------------------------------------------------------- robots */

type Robots = {
  present: boolean;
  status: number | null;
  sitemaps: string[];
  /** The group that applied — our own agent's rules, or `*`'s. */
  agent: string | null;
  rules: { allow: boolean; path: string }[];
  note: string | null;
};

/**
 * robots.txt, read the way a crawler is supposed to read it.
 *
 * The most specific matching group wins — our own user agent's rules over
 * `*`'s — and within a group the LONGEST matching pattern decides, with Allow
 * beating Disallow on a tie. That is the rule Google documents, and it is what
 * makes `Disallow: /` plus `Allow: /blog/` mean what its author meant.
 *
 * A MISSING robots.txt IS NOT A CLOSED SITE. 404 means no rules, which means
 * everything is allowed — the opposite of the cautious reading, and the
 * correct one.
 */
function parseRobots(text: string): { agent: string | null; rules: { allow: boolean; path: string }[]; sitemaps: string[] } {
  const groups = new Map<string, { allow: boolean; path: string }[]>();
  const sitemaps: string[] = [];
  let current: string[] = [];
  let seenRule = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (seenRule) {
        current = [];
        seenRule = false;
      }
      current.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
      continue;
    }
    if (field === "allow" || field === "disallow") {
      seenRule = true;
      for (const agent of current)
        groups.get(agent)!.push({ allow: field === "allow", path: value });
    }
  }

  const mine = [...groups.keys()].find((a) => "onepersoncompany/0.1 (+audit)".includes(a) && a !== "*");
  const agent = mine ?? (groups.has("*") ? "*" : null);
  return { agent, rules: agent ? (groups.get(agent) ?? []) : [], sitemaps };
}

function allowed(robots: Robots, path: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of robots.rules) {
    if (r.path === "") continue; // `Disallow:` with nothing after it allows all
    const pattern = r.path.replace(/\*+/g, "*");
    const matches = pattern.includes("*")
      ? new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}`).test(path)
      : path.startsWith(pattern);
    if (!matches) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

/* -------------------------------------------------------------- the page */

const tagsOf = (html: string, name: string) =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => m[0]!);

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>\`]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export type PageReport = {
  url: string;
  status: number;
  redirects: string[];
  ms: number;
  https: boolean;
  title: string | null;
  titleLength: number | null;
  description: string | null;
  descriptionLength: number | null;
  h1: number;
  h1Text: string | null;
  canonical: string | null;
  canonicalSelf: boolean | null;
  noindex: boolean;
  words: number;
  internalLinks: number;
  externalLinks: number;
  imagesWithoutAlt: number;
  images: number;
  error: string | null;
};

function readPage(res: Fetched, origin: string): { report: PageReport; links: string[] } {
  const html = res.body;
  const base = (() => {
    try {
      return new URL(res.url);
    } catch {
      return null;
    }
  })();

  const title = /<title[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(html)?.[1];
  const titleText = title ? decode(title).replace(/\s+/g, " ").trim() : null;

  let description: string | null = null;
  let noindex = false;
  for (const tag of tagsOf(html, "meta")) {
    const name = (attr(tag, "name") ?? "").toLowerCase();
    const content = attr(tag, "content") ?? "";
    if (name === "description" && description === null)
      description = decode(content).replace(/\s+/g, " ").trim();
    if ((name === "robots" || name === "googlebot") && /\bnoindex\b/i.test(content))
      noindex = true;
  }

  let canonical: string | null = null;
  for (const tag of tagsOf(html, "link")) {
    if (!/(^|\s)canonical(\s|$)/i.test(attr(tag, "rel") ?? "")) continue;
    const href = attr(tag, "href");
    if (!href || !base) continue;
    try {
      canonical = new URL(href, base).toString();
    } catch {
      canonical = href;
    }
    break;
  }

  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]{0,400}?)<\/h1>/gi)];
  const imgs = tagsOf(html, "img");

  /* Prose only: script and style are not words on the page, and a site with a
     large inline bundle would otherwise never read as thin. */
  const text = decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
  const words = text.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length;

  const links: string[] = [];
  let internal = 0;
  let external = 0;
  for (const tag of tagsOf(html, "a")) {
    const href = (attr(tag, "href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) continue;
    if (!base) continue;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    abs.hash = "";
    if (sameHost(abs.hostname, origin)) {
      internal += 1;
      links.push(abs.toString());
    } else external += 1;
  }

  return {
    report: {
      url: res.url,
      status: res.status,
      redirects: res.chain,
      ms: res.ms,
      https: res.url.startsWith("https://"),
      title: titleText || null,
      titleLength: titleText ? titleText.length : null,
      description: description || null,
      descriptionLength: description ? description.length : null,
      h1: h1s.length,
      h1Text: h1s[0] ? decode(h1s[0][1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null : null,
      canonical,
      canonicalSelf: canonical === null ? null : sameUrl(canonical, res.url),
      noindex,
      words,
      internalLinks: internal,
      externalLinks: external,
      images: imgs.length,
      imagesWithoutAlt: imgs.filter((t) => attr(t, "alt") === null).length,
      error: res.error,
    },
    links,
  };
}

const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
const sameHost = (a: string, b: string) => bare(a) === bare(b);

function sameUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return (
      bare(x.hostname) === bare(y.hostname) &&
      x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, "") &&
      x.search === y.search
    );
  } catch {
    return a === b;
  }
}

/* ------------------------------------------------------------- findings */

export type Finding = {
  severity: "error" | "warning" | "notice";
  code: string;
  what: string;
  /** The pages it is about, capped so one bad template does not produce a
   *  finding with sixty URLs in it. `count` is the real number. */
  count: number;
  pages: string[];
  /** What the verdict was computed FROM, so it can be argued with. */
  evidence: string;
};

/* ------------------------------------------------------------- the crawl */

export type AuditDoc = {
  ts: string;
  venture: { id: string; slug: string; name: string; website: string; host: string | null };
  userAgent: string;
  limits: { pages: number; links: number; gapMs: number; requestMs: number; crawlMs: number; linksMs: number };
  robots: Robots;
  sitemap: {
    checked: string[];
    found: string | null;
    urls: number | null;
    note: string;
  };
  https: { httpRedirectsToHttps: boolean | null; note: string };
  canonicalHost: { requested: string; answered: string | null; note: string };
  pages: PageReport[];
  crawl: {
    reached: number;
    queuedButNotReached: number;
    blockedByRobots: string[];
    /** Links to the CDN's own paths, skipped. See NOT_THE_SITE. */
    infrastructureSkipped: number;
    stoppedBecause: string;
    ms: number;
  };
  links: {
    checked: number;
    broken: { url: string; status: number; error: string | null; linkedFrom: string[] }[];
    note: string;
  };
  search: {
    property: string | null;
    note: string;
    /** Pages Google has shown, that this crawl found something wrong with,
     *  ranked by the impressions they are actually earning. */
    ranked: {
      page: string;
      impressions: number;
      clicks: number;
      position: number | null;
      issues: string[];
    }[];
  };
  findings: Finding[];
};

export async function runAudit(key: string): Promise<AuditDoc | { error: string }> {
  const v = ventureRow(key);
  if (!v) return { error: "No venture by that id or slug." };
  if (!v.website)
    return { error: `${v.name} has no website to audit. Add one and this has something to crawl.` };

  const started = Date.now();
  const startUrl = new URL(v.website);
  const origin = startUrl.hostname;

  /* --- robots.txt ---------------------------------------------------- */
  const robotsRes = await get(new URL("/robots.txt", startUrl).toString(), "GET", started + 15_000);
  const parsed =
    robotsRes.status >= 200 && robotsRes.status < 300 && /disallow|allow|user-agent|sitemap/i.test(robotsRes.body)
      ? parseRobots(robotsRes.body)
      : { agent: null, rules: [], sitemaps: [] };
  const robots: Robots = {
    present: robotsRes.status >= 200 && robotsRes.status < 300,
    status: robotsRes.status || null,
    sitemaps: parsed.sitemaps,
    agent: parsed.agent,
    rules: parsed.rules,
    note:
      robotsRes.status >= 200 && robotsRes.status < 300
        ? parsed.agent
          ? `Obeying the rules for “${parsed.agent}” — ${parsed.rules.length} of them.`
          : "robots.txt answered but names no group this crawler is in, so nothing is disallowed."
        : robotsRes.error
          ? `robots.txt could not be read — ${robotsRes.error} Nothing is treated as disallowed.`
          : `robots.txt answered ${robotsRes.status}. No rules means everything is allowed, which is the correct reading.`,
  };
  await sleep(GAP_MS);

  /* --- sitemap ------------------------------------------------------- */
  const sitemapCandidates = [
    ...robots.sitemaps,
    new URL("/sitemap.xml", startUrl).toString(),
    new URL("/sitemap_index.xml", startUrl).toString(),
  ];
  let sitemapFound: string | null = null;
  let sitemapUrls: number | null = null;
  let sitemapNote = "";
  const sitemapChecked: string[] = [];
  for (const candidate of [...new Set(sitemapCandidates)].slice(0, 4)) {
    sitemapChecked.push(candidate);
    const res = await get(candidate, "GET", started + 30_000);
    await sleep(GAP_MS);
    if (res.status < 200 || res.status >= 300 || !res.body.includes("<")) continue;
    const isIndex = /<sitemapindex/i.test(res.body);
    const locs = [...res.body.matchAll(/<loc>\s*([^<\s]{1,2000})\s*<\/loc>/gi)].map((m) => m[1]!);
    sitemapFound = candidate;
    if (isIndex) {
      /* A sitemap index names other sitemaps. Two children are read and the
         rest are counted as unread rather than as zero URLs — a floor with a
         sentence beats a total that is wrong. */
      let total = 0;
      const children = locs.slice(0, 2);
      for (const child of children) {
        const c = await get(child, "GET", started + 45_000);
        await sleep(GAP_MS);
        total += [...c.body.matchAll(/<loc>/gi)].length;
      }
      sitemapUrls = total;
      sitemapNote =
        `A sitemap INDEX naming ${locs.length} sitemaps. ${children.length} of them were ` +
        `read and hold ${total} URLs between them — a floor, not the site's total.`;
    } else {
      sitemapUrls = locs.length;
      sitemapNote = `${locs.length} URLs listed.`;
    }
    break;
  }
  if (!sitemapFound)
    sitemapNote =
      "No sitemap answered at any of the addresses tried, and robots.txt names none. " +
      "That is not fatal — Google finds pages by following links — but it is the " +
      "cheapest thing on this list to fix.";

  /* --- http → https --------------------------------------------------- */
  let httpRedirects: boolean | null = null;
  let httpsNote: string;
  if (startUrl.protocol === "https:") {
    const httpRes = await get(`http://${origin}/`, "HEAD", started + 55_000);
    await sleep(GAP_MS);
    httpRedirects = httpRes.chain.some((h) => h.includes("→ https://"));
    httpsNote = httpRedirects
      ? `http://${origin}/ redirects to https, as it should.`
      : httpRes.error
        ? `http://${origin}/ could not be checked — ${httpRes.error}`
        : `http://${origin}/ answered ${httpRes.status} without redirecting to https. ` +
          "Every link anybody ever wrote without a scheme goes to the insecure one.";
  } else {
    httpsNote = "The venture's own address is http://, so there is no https to redirect to.";
  }

  /* --- the crawl ------------------------------------------------------ */
  const deadline = started + CRAWL_MS + 60_000;
  const queue: string[] = [startUrl.toString()];
  const seen = new Set<string>([canon(startUrl.toString())]);
  const pages: PageReport[] = [];
  const linkSources = new Map<string, Set<string>>();
  const blocked: string[] = [];
  let infrastructure = 0;
  let stopped = "the site was crawled to its end";

  while (queue.length && pages.length < PAGE_CAP) {
    if (Date.now() > deadline) {
      stopped = `the ${CRAWL_MS / 1000}-second crawl budget ran out`;
      break;
    }
    const url = queue.shift()!;
    let path = "/";
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch {
      continue;
    }
    if (NOT_THE_SITE.test(path)) {
      infrastructure += 1;
      continue;
    }
    if (!allowed(robots, path)) {
      blocked.push(url);
      continue;
    }

    const res = await get(url, "GET", deadline);
    const ct = (res.type ?? "").toLowerCase();
    if (res.status >= 200 && res.status < 300 && ct && !ct.includes("html")) {
      /* Not a page. Counted as reached and not parsed — a PDF has no title tag
         and reporting it as a page with no title would be a finding about
         this crawler rather than about the site. */
      await sleep(GAP_MS);
      continue;
    }

    const { report, links } = readPage(res, origin);
    pages.push(report);

    for (const l of links) {
      const c = canon(l);
      if (!linkSources.has(c)) linkSources.set(c, new Set());
      linkSources.get(c)!.add(res.url);
      if (!seen.has(c) && queue.length + pages.length < PAGE_CAP * 4) {
        seen.add(c);
        queue.push(l);
      }
    }
    await sleep(GAP_MS);
  }
  if (pages.length >= PAGE_CAP) stopped = `the ${PAGE_CAP}-page cap was reached`;
  const crawlMs = Date.now() - started;

  /* --- broken internal links ------------------------------------------ */
  const crawled = new Map(pages.map((p) => [canon(p.url), p]));
  const toCheck = [...linkSources.keys()]
    .filter((u) => !crawled.has(u))
    .filter((u) => {
      try {
        return !NOT_THE_SITE.test(new URL(u).pathname);
      } catch {
        return false;
      }
    })
    .slice(0, LINK_CAP);
  const linkDeadline = Date.now() + LINKS_MS;
  const broken: AuditDoc["links"]["broken"] = [];
  let checked = 0;

  for (const url of toCheck) {
    if (Date.now() > linkDeadline) break;
    let path = "/";
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch {
      continue;
    }
    if (!allowed(robots, path)) continue;
    const res = await get(url, "HEAD", linkDeadline);
    checked += 1;
    /* A HEAD that is refused is not a broken link — plenty of servers answer
       405 to one — so only a 4xx/5xx that is not 405 counts, and a transport
       failure counts with its own sentence. */
    if ((res.status >= 400 && res.status !== 405) || res.error)
      broken.push({
        url,
        status: res.status,
        error: res.error,
        linkedFrom: [...(linkSources.get(url) ?? [])].slice(0, 5),
      });
    await sleep(GAP_MS);
  }

  /* --- the findings ---------------------------------------------------- */
  const ok = pages.filter((p) => p.status >= 200 && p.status < 300 && !p.error);
  const findings: Finding[] = [];
  const add = (
    severity: Finding["severity"],
    code: string,
    what: string,
    urls: string[],
    evidence: string,
  ) => {
    if (!urls.length) return;
    findings.push({ severity, code, what, count: urls.length, pages: urls.slice(0, 10), evidence });
  };

  add("error", "page-error", "Pages that did not answer with a 2xx.",
    pages.filter((p) => p.status >= 400 || p.error).map((p) => p.url),
    "The status this crawl got, following redirects.");

  add("error", "no-title", "Pages with no <title> at all.",
    ok.filter((p) => !p.title).map((p) => p.url),
    "No <title> element in the HTML that was served.");

  add("error", "noindex", "Pages that tell search engines not to index them.",
    ok.filter((p) => p.noindex).map((p) => p.url),
    "A <meta name=robots> or <meta name=googlebot> carrying `noindex`. On a page you want found, this is the whole problem.");

  add("error", "broken-link", "Internal links that do not answer.",
    broken.map((b) => b.url),
    `HEAD on each unique internal link once, up to ${LINK_CAP}. A 405 is not counted — plenty of servers refuse HEAD.`);

  /* Duplicate titles: the same string on more than one page. A template that
     forgot to vary its title is the single most common finding on a small
     site, and it is invisible page by page. */
  const byTitle = new Map<string, string[]>();
  for (const p of ok) if (p.title) byTitle.set(p.title, [...(byTitle.get(p.title) ?? []), p.url]);
  const dupes = [...byTitle.entries()].filter(([, urls]) => urls.length > 1);
  add("warning", "duplicate-title",
    `Titles used on more than one page (${dupes.length} title${dupes.length === 1 ? "" : "s"}).`,
    dupes.flatMap(([, urls]) => urls),
    `Compared as exact strings across the ${ok.length} pages crawled. Two pages with one title compete with each other.`);

  add("warning", "no-description", "Pages with no meta description.",
    ok.filter((p) => !p.description).map((p) => p.url),
    "Google writes its own snippet when there is none, out of whatever text it finds.");

  add("warning", "thin", `Pages with fewer than ${THIN_WORDS} words of prose.`,
    ok.filter((p) => p.words < THIN_WORDS).map((p) => p.url),
    `Script and style stripped, tags removed, whitespace-separated tokens counted. ${THIN_WORDS} is the convention every tool uses, not a measurement.`);

  add("warning", "h1", "Pages with no h1, or with more than one.",
    ok.filter((p) => p.h1 !== 1).map((p) => p.url),
    "Counted from the HTML as served. One h1 is a convention rather than a rule since HTML5, which is why this is a warning.");

  add("warning", "no-canonical", "Pages with no canonical link.",
    ok.filter((p) => !p.canonical).map((p) => p.url),
    "Without one, every query-string variant of a URL is a separate page to a crawler.");

  add("warning", "canonical-elsewhere", "Pages whose canonical points at a different URL.",
    ok.filter((p) => p.canonical && p.canonicalSelf === false).map((p) => p.url),
    "Deliberate on a duplicate and a disaster on a page you want ranked — this cannot tell which, so it reports the fact.");

  add("warning", "alt", "Pages with images that have no alt attribute.",
    ok.filter((p) => p.imagesWithoutAlt > 0).map((p) => p.url),
    "An <img> with no alt attribute at all. An empty alt is deliberate and is not counted.");

  add("notice", "title-length", "Titles under 15 or over 60 characters.",
    ok.filter((p) => p.title && (p.titleLength! < 15 || p.titleLength! > 60)).map((p) => p.url),
    "Google truncates around 60 characters on a desktop result. A convention, measured in characters rather than pixels, which is what actually decides it.");

  add("notice", "description-length", "Meta descriptions under 50 or over 160 characters.",
    ok.filter((p) => p.description && (p.descriptionLength! < 50 || p.descriptionLength! > 160)).map((p) => p.url),
    "Same convention, same caveat.");

  add("notice", "redirect", "Pages reached through a redirect.",
    pages.filter((p) => p.redirects.length).map((p) => p.url),
    "Every link to the old address costs a round trip for ever. Fine once; worth fixing in your own links.");

  if (httpRedirects === false)
    findings.push({
      severity: "error", code: "http-no-https", count: 1,
      what: `http://${origin}/ does not redirect to https.`,
      pages: [`http://${origin}/`],
      evidence: httpsNote,
    });

  if (!sitemapFound)
    findings.push({
      severity: "warning", code: "no-sitemap", count: 1,
      what: "No sitemap could be found.", pages: sitemapChecked, evidence: sitemapNote,
    });

  if (!robots.present)
    findings.push({
      severity: "notice", code: "no-robots", count: 1,
      what: "No robots.txt.", pages: [new URL("/robots.txt", startUrl).toString()],
      evidence: robots.note ?? "robots.txt could not be read at all.",
    });

  /* --- the Search Console join ---------------------------------------- */
  const properties = linkedEntities(v.id, "gsc");
  const issuesByPage = new Map<string, string[]>();
  for (const f of findings)
    for (const url of f.pages) {
      if (f.code === "redirect" || f.code === "title-length" || f.code === "description-length") continue;
      issuesByPage.set(canon(url), [...(issuesByPage.get(canon(url)) ?? []), f.code]);
    }

  const ranked: AuditDoc["search"]["ranked"] = [];
  let searchNote: string;
  if (!properties.length) {
    searchNote =
      "No Search Console property is linked to this venture, so nothing here is " +
      `ranked by what Google actually shows. Link one at POST /api/venture-links/${v.slug} ` +
      "and run the audit again — it is the difference between a list of faults and a list of priorities.";
  } else {
    const rows = db
      .prepare(
        `SELECT page, clicks, impressions, position FROM gsc_pages
          WHERE property IN (${properties.map(() => "?").join(",")})
          ORDER BY impressions DESC`,
      )
      .all(...properties) as unknown as {
      page: string;
      clicks: number;
      impressions: number;
      position: number | null;
    }[];
    let reachedRanked = 0;
    for (const r of rows) {
      if (crawled.has(canon(r.page))) reachedRanked += 1;
      const issues = issuesByPage.get(canon(r.page));
      if (!issues?.length) continue;
      ranked.push({
        page: r.page,
        impressions: r.impressions,
        clicks: r.clicks,
        position: r.position,
        issues: [...new Set(issues)],
      });
    }
    searchNote =
      `Joined against ${properties.join(", ")}. Search Console has ranked ${rows.length} pages; ` +
      `this crawl reached ${reachedRanked} of them and found something wrong with ${ranked.length}. ` +
      (reachedRanked < rows.length
        ? `The other ${rows.length - reachedRanked} ranked pages were not crawled — the crawl is a ` +
          `${PAGE_CAP}-page survey from the home page outwards, and a page Google ranks may simply ` +
          "be further in. Their absence here is not a clean bill of health. "
        : "") +
      "Impressions and clicks are Search Console's own figures over ITS window, not this " +
      "crawl's; they say which fault is worth the afternoon.";
  }

  const doc: AuditDoc = {
    ts: now(),
    venture: { id: v.id, slug: v.slug, name: v.name, website: v.website, host: v.host },
    userAgent: UA,
    limits: { pages: PAGE_CAP, links: LINK_CAP, gapMs: GAP_MS, requestMs: REQUEST_MS, crawlMs: CRAWL_MS, linksMs: LINKS_MS },
    robots,
    sitemap: { checked: sitemapChecked, found: sitemapFound, urls: sitemapUrls, note: sitemapNote },
    https: { httpRedirectsToHttps: httpRedirects, note: httpsNote },
    canonicalHost: {
      requested: v.website,
      answered: pages[0]?.url ?? null,
      note:
        pages[0] && !sameUrl(pages[0].url, v.website)
          ? `The address on the venture is ${v.website} and the site answered at ${pages[0].url}. ` +
            "Whichever of www and the apex is the real one, the other should redirect to it — and the venture should name the real one."
          : "The address on the venture is the one that answered.",
    },
    pages,
    crawl: {
      reached: pages.length,
      queuedButNotReached: queue.length,
      blockedByRobots: blocked.slice(0, 20),
      infrastructureSkipped: infrastructure,
      stoppedBecause: stopped,
      ms: crawlMs,
    },
    links: {
      checked,
      broken,
      note:
        !toCheck.length
          ? `Every internal link found points at a page this crawl had already fetched, so there was nothing left to check separately. ${linkSources.size} distinct internal links were seen.`
          : checked < toCheck.length
            ? `${checked} of ${toCheck.length} unique internal links were checked before the ${LINKS_MS / 1000}-second budget ran out. The rest are unknown, not sound.`
            : `Every one of the ${checked} unique internal links found off the crawled pages was checked.`,
    },
    search: { property: properties[0] ?? null, note: searchNote, ranked: ranked.slice(0, 25) },
    findings: findings.sort(
      (a, b) =>
        rank(a.severity) - rank(b.severity) || b.count - a.count || a.code.localeCompare(b.code),
    ),
  };

  db.prepare(
    "INSERT INTO venture_audits (venture_id, ts, doc, pages, issues) VALUES (?, ?, ?, ?, ?)",
  ).run(v.id, doc.ts, JSON.stringify(doc), pages.length, findings.reduce((n, f) => n + f.count, 0));

  return doc;
}

const rank = (s: Finding["severity"]) => (s === "error" ? 0 : s === "warning" ? 1 : 2);

/** One URL, in the one spelling this file compares by: no fragment, no
 *  trailing slash on a path, www treated as the apex. Two spellings of one
 *  page is a page crawled twice and a duplicate title reported against
 *  itself. */
function canon(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = bare(u.hostname);
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return raw;
  }
}

/* ------------------------------------------------------------------ routes */

/**
 * THE WHOLE PORTFOLIO, ONE ROW PER VENTURE — the overview an SEO board needs.
 *
 * REGISTERED BEFORE `/:ventureKey`, because Hono matches in the order routes
 * are declared and a bare GET on this router would otherwise be a venture key.
 * The same rule routes/ventures.ts keeps for `reorder`.
 *
 * IT READS AND NEVER CRAWLS. Every figure here comes out of the newest stored
 * `venture_audits` document; nothing is fetched from anybody's website to
 * answer it. That is what makes it safe to put on a dashboard that polls —
 * `POST /api/audit/:key` is the thing that costs sixty requests to a site, and
 * it stays a deliberate act.
 *
 * A VENTURE WITH NO AUDIT IS ON THE LIST WITH NULLS, not missing from it. The
 * question this answers is "how do my sites look", and a site that has never
 * been crawled is a real and interesting answer to it — dropping the row would
 * make a portfolio of four look like a portfolio of two with no faults. `ts`
 * null is the flag, and every measured field beside it is null for the same
 * reason: null means asked and not told.
 *
 * THE THREE COUNTS ARE RECOMPUTED FROM THE STORED DOCUMENT rather than read
 * off `venture_audits.issues`. That column is the SUM of every finding's count
 * across all three severities — it exists so the history list can say "34
 * issues" without parsing a hundred kilobytes — and splitting it into errors,
 * warnings and notices is not something a total can be asked to do.
 */
auditRoutes.get("/", (c) => {
  const rows = ventureRows();
  const ventures = rows.map((v) => {
    const row = db
      .prepare("SELECT ts, doc FROM venture_audits WHERE venture_id = ? ORDER BY ts DESC LIMIT 1")
      .get(v.id) as { ts: string; doc: string } | undefined;

    const base = { id: v.id, name: v.name, slug: v.slug, host: v.host };
    if (!row)
      return {
        ...base,
        ts: null,
        pages: null,
        issues: null,
        https: null,
        sitemap: null,
        robots: null,
        canonicalHost: null,
      };

    let doc: AuditDoc;
    try {
      doc = JSON.parse(row.doc) as AuditDoc;
    } catch {
      /* A row that will not parse costs its figures and keeps its date, which
         is the honest split: something was crawled then, and this cannot say
         what it found. */
      return {
        ...base,
        ts: row.ts,
        pages: null,
        issues: null,
        https: null,
        sitemap: null,
        robots: null,
        canonicalHost: null,
      };
    }

    return {
      ...base,
      ts: doc.ts,
      pages: doc.pages.length,
      issues: {
        error: doc.findings.filter((f) => f.severity === "error").reduce((n, f) => n + f.count, 0),
        warning: doc.findings.filter((f) => f.severity === "warning").reduce((n, f) => n + f.count, 0),
        notice: doc.findings.filter((f) => f.severity === "notice").reduce((n, f) => n + f.count, 0),
      },
      /* `https` AND `canonicalHost` ARE ALLOWED TO BE NULL AND `robots` IS
         NOT, because they are different measurements. A null https means the
         http:// address was never reached at all, and a dashboard that drew
         that as a red cross would be reporting a fault nobody measured; a
         missing robots.txt, on the other hand, IS a measurement — 404 means no
         rules, which means everything is allowed, and `false` says exactly
         that. `sitemap` carries the url that was found, or null for none. */
      https: doc.https.httpRedirectsToHttps,
      sitemap: doc.sitemap.found,
      robots: doc.robots.present,
      canonicalHost: doc.canonicalHost.answered,
    };
  });

  return c.json({
    ventures,
    note:
      "The newest STORED audit for each venture — nothing was crawled to answer " +
      "this. `ts: null` is a venture that has never been audited, which is not " +
      "the same as a site with no faults, and every figure beside it is null for " +
      "that reason. The counts are sums of finding counts, so one bad template " +
      "across sixty pages is sixty; they are a trend line beside `pages`, not a " +
      "score. There is deliberately no score.",
  });
});

auditRoutes.post("/:ventureKey", async (c) => {
  const res = await runAudit(c.req.param("ventureKey"));
  if ("error" in res) return c.json(res, res.error.startsWith("No venture") ? 404 : 400);
  return c.json(summarise(res));
});

auditRoutes.get("/:ventureKey", (c) => {
  const v = ventureRow(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);

  const row = db
    .prepare("SELECT * FROM venture_audits WHERE venture_id = ? ORDER BY ts DESC LIMIT 1")
    .get(v.id) as { ts: string; doc: string; pages: number; issues: number } | undefined;
  if (!row)
    return c.json(
      {
        error: `${v.name} has never been audited. POST /api/audit/${v.slug} to crawl it — it takes a minute or two.`,
      },
      404,
    );

  let doc: AuditDoc;
  try {
    doc = JSON.parse(row.doc) as AuditDoc;
  } catch {
    return c.json({ error: "The stored audit is not readable JSON. Run it again." }, 500);
  }
  return c.json(summarise(doc));
});

auditRoutes.get("/:ventureKey/history", (c) => {
  const v = ventureRow(c.req.param("ventureKey"));
  if (!v) return c.json({ error: "No venture by that id or slug." }, 404);
  const rows = db
    .prepare(
      "SELECT id, ts, pages, issues FROM venture_audits WHERE venture_id = ? ORDER BY ts DESC LIMIT 50",
    )
    .all(v.id) as unknown as { id: number; ts: string; pages: number; issues: number }[];
  return c.json({
    venture: { id: v.id, slug: v.slug, name: v.name },
    runs: rows,
    note:
      "`issues` is the sum of every finding's count — a page with three faults " +
      "contributes three. It is a trend line, not a score, and it moves with how " +
      "many pages were reached: read it beside `pages`.",
  });
});

/**
 * The audit as a reader wants it: the findings grouped by how much they
 * matter, the counts, and every page still there for anything that wants to
 * draw the table.
 */
function summarise(doc: AuditDoc) {
  const bySeverity = {
    error: doc.findings.filter((f) => f.severity === "error"),
    warning: doc.findings.filter((f) => f.severity === "warning"),
    notice: doc.findings.filter((f) => f.severity === "notice"),
  };
  return {
    ...doc,
    summary: {
      pages: doc.pages.length,
      errors: bySeverity.error.reduce((n, f) => n + f.count, 0),
      warnings: bySeverity.warning.reduce((n, f) => n + f.count, 0),
      notices: bySeverity.notice.reduce((n, f) => n + f.count, 0),
      /* No score. See the header: a number out of a hundred hides which of its
         inputs moved, and every finding here already names its evidence. */
      score: null,
      scoreNote:
        "There is deliberately no score. A single number would hide which finding " +
        "moved it, and every finding below names what it was measured from.",
    },
    bySeverity,
  };
}
