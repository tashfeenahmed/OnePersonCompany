/**
 * READING SOMEBODY ELSE'S PAGE IN CODE, so that nothing has to be eyeballed.
 *
 * WHY THIS IS NOT `ventures/audit.ts`. That file crawls the owner's OWN site
 * and its reader is shaped for that job — it walks links, it counts images
 * without alt text, and it returns a `PageReport` whose fields are the findings
 * the audit publishes. This one reads a stranger's marketing page ONCE, and
 * what it needs out of it is the shape a search engine sees: the heading tree,
 * the word count, the schema types, whether there is a comparison table or an
 * FAQ. Those are different questions, the audit's reader is private to it, and
 * a shared reader would have to answer both badly.
 *
 * EVERY FIELD HERE IS COUNTABLE, and that is the whole design. A model asked
 * "does this page have more depth than ours" writes a paragraph; a model handed
 * "theirs: 2,140 words, 14 h2s, FAQPage schema; ours: 380 words, 2 h2s, none"
 * writes a finding somebody can check. So the numbers are computed here, in
 * code, before any model sees anything, and the model's job is the prose.
 *
 * THE FETCH IS BOUNDED IN FOUR WAYS and refuses rather than guessing: a
 * timeout, a byte cap, a content-type gate, and a redirect walk done by hand so
 * a page that ends up somewhere else is recorded as having done so. A page that
 * comes back as an anti-bot interstitial is marked `thin` — its structure is a
 * fact about the challenge, not about the site — and nothing downstream may
 * compare against a thin page.
 *
 * NOTHING HERE IS STORED FOR ITS OWN SAKE. These are third-party marketing
 * pages read once to answer one question; the structures go into the run's own
 * row and the HTML is dropped.
 */

/** One request's wall. Long enough for a slow marketing page behind a CDN,
 *  short enough that eight of them cannot make a run look hung. */
const TIMEOUT_MS = 15_000;
/** How much of a page is read. A marketing page is tens of kilobytes; past
 *  this it is a JS bundle inlined into the document and reading more of it
 *  buys nothing but memory. */
const MAX_BYTES = 1_500_000;
/** Redirect hops followed by hand. */
const MAX_HOPS = 5;
/** Under this much readable text the "page" is an interstitial or a shell that
 *  never rendered — its structure describes the challenge, not the site. */
const MIN_PAGE_CHARS = 400;

/** An honest User-Agent, for providers/stock.ts's reason: a tool that says
 *  what it is can be complained to. */
const UA = "OnePersonCompany/0.1 (+growth)";

/* --------------------------------------------------------------- hostnames */

/**
 * The registrable domain, so one competitor's three subdomains do not eat the
 * whole sample.
 *
 * The multi-part TLD list is short and explicit rather than a public-suffix
 * dependency: the server has no runtime dependencies beyond hono, and the six
 * below cover every suffix this box has ever seen in a result set. A suffix
 * that is not on the list folds to two labels, which is wrong in the direction
 * that costs a duplicate rather than a wrong comparison.
 */
const MULTI_TLD = ["com.pk", "co.uk", "com.au", "co.nz", "com.br", "co.za", "co.in", "co.jp"];

export function registrable(host: string): string {
  const h = String(host ?? "").trim().toLowerCase().replace(/^www\./, "");
  if (!h.includes(".")) return h;
  const parts = h.split(".");
  const last2 = parts.slice(-2).join(".");
  const take = MULTI_TLD.includes(last2) ? 3 : 2;
  return parts.slice(-take).join(".");
}

export function hostOf(url: string): string | null {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/* ------------------------------------------------- the relevance self-check */

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in",
  "is", "it", "of", "on", "or", "that", "the", "to", "was", "what", "when",
  "where", "which", "who", "why", "with", "you", "your", "can", "do", "does",
]);

/** Words worth counting: three letters or more, not a stop word, de-duplicated. */
export function tokens(text: string): string[] {
  return [
    ...new Set(
      String(text ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    ),
  ];
}

/** Below this share of the query's own words in the results, the engine
 *  answered a different question. */
export const RELEVANCE_FLOOR = 0.3;

export type Relevance = {
  ratio: number | null;
  degraded: boolean;
  matched: number;
  of: number;
};

/**
 * THE SELF-CHECK, and it is the reason a teardown can be trusted at all.
 *
 * A metasearch node asked a long-tail question by an unknown client frequently
 * answers something else: it rewrites the query, or the one engine still
 * answering ignores the terms and passes back ten links about nothing. Ten
 * results is not ten answers. So the query's own words are counted against the
 * titles and snippets that came back, and below the floor NO conclusion is
 * drawn from that query.
 *
 * A query with nothing countable in it is `of: 0`, ratio null, and NOT
 * degraded — an unmeasurable check is not a failed one.
 */
export function relevance(query: string, results: { title: string; content: string | null }[]): Relevance {
  const want = tokens(query);
  if (!want.length) return { ratio: null, degraded: false, matched: 0, of: 0 };
  const have = new Set(tokens(results.map((r) => `${r.title} ${r.content ?? ""}`).join(" ")));
  const matched = want.filter((t) => have.has(t)).length;
  const ratio = Number((matched / want.length).toFixed(2));
  return { ratio, degraded: ratio < RELEVANCE_FLOOR, matched, of: want.length };
}

/**
 * Queries the relevance check cannot measure, named BEFORE a search is spent on
 * them. Returns the sentence to record, or null when the query is a fair one.
 *
 * With one countable word the ratio is 0 or 1 and nothing else, so the floor is
 * not a threshold — it is a coin toss on whether that exact word happened to
 * land in a title. Reporting that as "the engine answered a different question"
 * reads as a finding about the SERP when it is a fact about the query.
 */
export function unmeasurable(query: string): string | null {
  const want = tokens(query);
  if (!want.length)
    return "every word in it is a stop word, so there is nothing to check the results against";
  if (want.length > 1) return null;
  return /\d/.test(want[0]!)
    ? `“${want[0]}” is an identifier rather than a phrase — a page that ranks for it is not answering a question anybody asked in words`
    : `“${want[0]}” is a single word, and over one word the relevance check has only two answers — it would call the results degraded or clean on whether that exact word appears in a title, which measures nothing`;
}

/* ------------------------------------------------------------ reading HTML */

const stripTags = (html: string): string =>
  String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();

const attrOf = (tag: string, name: string): string => {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "") : "";
};

const clean = (s: string, cap: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, cap);

export type PageStructure = {
  url: string;
  domain: string | null;
  title: string | null;
  description: string | null;
  h1: string[];
  h2: string[];
  h3Count: number;
  words: number;
  internalLinks: number;
  externalLinks: number;
  images: number;
  /** Schema.org types declared on the page, from JSON-LD and microdata. This
   *  is the field a "they have FAQ schema and we do not" finding rests on, and
   *  it is read as MARKUP rather than inferred from words. */
  schema: string[];
  faq: boolean;
  table: boolean;
  comparison: boolean;
  /** The opening of the readable text, so a model can see how the page answers
   *  rather than guessing from a heading tree. */
  opening: string | null;
  /** True when there was too little readable text for the structure to be a
   *  fact about the site. Nothing is compared against a thin page. */
  thin: boolean;
  chars: number;
  error: string | null;
};

/** The schema types a page declares, from JSON-LD `@type` and microdata
 *  `itemtype`. De-duplicated and capped; a page that declares forty types is
 *  a page with a CMS, not a page with forty facts. */
function schemaTypes(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const t of (m[1] ?? "").matchAll(/"@type"\s*:\s*"([^"]{1,60})"/g)) found.add(t[1]!);
  }
  for (const m of html.matchAll(/itemtype\s*=\s*["']https?:\/\/schema\.org\/([A-Za-z]{1,60})["']/gi))
    found.add(m[1]!);
  return [...found].slice(0, 16);
}

/**
 * One page's structure, read in code.
 *
 * `internalLinks` and `externalLinks` are split on the page's own host rather
 * than counted together, because they answer different questions: internal
 * links are how a site distributes what it has, external ones are who it is
 * willing to point at. A single link count would hide both.
 */
export function extractStructure(html: string, url: string): PageStructure {
  const src = String(html ?? "");
  const head = src.slice(0, 200_000);
  const domain = hostOf(url);

  const titleMatch = /<title[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(head);
  const descMatch =
    /<meta[^>]+name\s*=\s*["']description["'][^>]*>/i.exec(head) ??
    /<meta[^>]+property\s*=\s*["']og:description["'][^>]*>/i.exec(head);

  const heads = (tag: string): string[] =>
    [...src.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]{0,4000}?)</${tag}>`, "gi"))]
      .map((m) => clean(stripTags(m[1] ?? ""), 140))
      .filter(Boolean);

  const text = stripTags(src);
  const words = text ? text.split(/\s+/).length : 0;

  let internal = 0;
  let external = 0;
  for (const a of src.matchAll(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const href = (a[2] ?? a[3] ?? "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    if (/^https?:\/\//i.test(href)) {
      const h = hostOf(href);
      if (h && domain && registrable(h) === registrable(domain)) internal += 1;
      else external += 1;
    } else internal += 1;
  }

  const h1 = heads("h1");
  const h2 = heads("h2");
  const lower = src.toLowerCase();
  const schema = schemaTypes(src);

  return {
    url: clean(url, 400),
    domain,
    title: clean(titleMatch ? stripTags(titleMatch[1] ?? "") : "", 200) || null,
    description: clean(descMatch ? attrOf(descMatch[0], "content") : "", 320) || null,
    h1: h1.slice(0, 3),
    h2: h2.slice(0, 14),
    h3Count: heads("h3").length,
    words,
    internalLinks: internal,
    externalLinks: external,
    images: (src.match(/<img\b/gi) ?? []).length,
    schema,
    /* Markup first, words second. A page with a <table> has a table whatever
       it calls it; a page that says "comparison" and has none does not. */
    faq: schema.some((t) => /faq/i.test(t)) || /<summary\b|\bfrequently asked questions\b/i.test(lower),
    table: /<table\b/i.test(lower),
    comparison: /\bvs\.?\b|\bversus\b|\bcompar(e|ed|es|ison)\b|\balternatives?\b/i.test(
      `${titleMatch ? stripTags(titleMatch[1] ?? "") : ""} ${h1.join(" ")} ${h2.join(" ")}`.toLowerCase(),
    ),
    opening: clean(text, 600) || null,
    thin: text.length < MIN_PAGE_CHARS,
    chars: text.length,
    error: null,
  };
}

/** A structure that could not be read, so a failed fetch is a row with a
 *  reason rather than a missing row. */
export function failedStructure(url: string, error: string): PageStructure {
  return {
    url: clean(url, 400),
    domain: hostOf(url),
    title: null,
    description: null,
    h1: [],
    h2: [],
    h3Count: 0,
    words: 0,
    internalLinks: 0,
    externalLinks: 0,
    images: 0,
    schema: [],
    faq: false,
    table: false,
    comparison: false,
    opening: null,
    thin: true,
    chars: 0,
    error,
  };
}

/**
 * Fetch one page's RAW HTML, bounded.
 *
 * Redirects are followed BY HAND so the final URL is the one recorded — a
 * competitor whose /pricing 301s to /plans is a page at /plans, and reporting
 * the requested URL would be reporting a URL nobody's browser ends up on.
 * Anything that is not HTML is refused rather than read: a PDF stripped of its
 * tags produces a word count, and a word count of a PDF compared against a web
 * page is a comparison of two different things.
 */
export async function fetchHtml(url: string): Promise<{ html: string; url: string } | { error: string }> {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return { error: `not a URL: ${String(url).slice(0, 120)}` };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { error: `${u.protocol} is not a scheme this fetches` };

  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    let res: Response;
    try {
      res = await fetch(u, {
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "Error";
      return {
        error:
          name === "TimeoutError"
            ? `did not answer within ${TIMEOUT_MS / 1000} seconds`
            : `could not be reached — ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { error: `answered ${res.status} with no destination` };
      try {
        u = new URL(location, u);
      } catch {
        return { error: `answered ${res.status} pointing at something that is not a URL` };
      }
      continue;
    }

    if (!res.ok) return { error: `answered HTTP ${res.status}` };
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !type.includes("html") && !type.includes("xml"))
      return { error: `answered ${type.split(";")[0]} rather than HTML` };

    const buf = await res.arrayBuffer().catch(() => null);
    if (!buf) return { error: "the body could not be read" };
    const bytes = buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf;
    return { html: new TextDecoder("utf-8", { fatal: false }).decode(bytes), url: u.toString() };
  }
  return { error: `redirected more than ${MAX_HOPS} times` };
}

/** Read a page and return its structure, whatever happens. */
export async function readPage(url: string): Promise<PageStructure> {
  const got = await fetchHtml(url);
  if ("error" in got) return failedStructure(url, got.error);
  return extractStructure(got.html, got.url);
}

/* ------------------------------------------------------------- the gap list */

export type Gap = {
  field: string;
  /** What the figure means, in the units it is in. */
  what: string;
  ours: number | null;
  /** The MEDIAN of the pages that came back, never the mean: one 12,000-word
   *  glossary in a set of five would move a mean past every real page. */
  theirs: number | null;
  /** How many competitor pages the median was taken over. */
  of: number;
};

export function median(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid]! : Math.round(((xs[mid - 1]! + xs[mid]!) / 2) * 10) / 10;
}

/**
 * WHERE THE PAGES ABOVE US ARE BIGGER THAN OURS, computed rather than judged.
 *
 * Only the countable fields are here, and only the ones where "more" is a
 * plausible reason a page ranks: length, heading depth, internal linking,
 * illustration, and the three markers (FAQ, table, comparison framing) that
 * distinguish a page written for a comparison query from one that was not.
 * A field where we are ahead is still returned — the report prints both, so
 * "we are longer than all of them and still ninth" is sayable, which is the
 * finding that stops a length recommendation being made by reflex.
 *
 * THIN AND FAILED PAGES ARE EXCLUDED FROM THE MEDIAN. A 403 from a WAF has a
 * word count of nothing, and letting it into the denominator would tell the
 * owner that the pages beating them are shorter than they are.
 */
export function gapsAgainst(ours: PageStructure | null, competitors: PageStructure[]): Gap[] {
  const usable = competitors.filter((c) => !c.error && !c.thin);
  const num = (pick: (p: PageStructure) => number, field: string, what: string): Gap => ({
    field,
    what,
    ours: ours && !ours.error ? pick(ours) : null,
    theirs: median(usable.map(pick)),
    of: usable.length,
  });
  const flag = (pick: (p: PageStructure) => boolean, field: string, what: string): Gap => ({
    field,
    what,
    ours: ours && !ours.error ? (pick(ours) ? 1 : 0) : null,
    theirs: usable.length ? usable.filter(pick).length : null,
    of: usable.length,
  });
  return [
    num((p) => p.words, "words", "readable words on the page"),
    num((p) => p.h2.length, "h2", "section headings (h2)"),
    num((p) => p.h3Count, "h3", "sub-headings (h3)"),
    num((p) => p.internalLinks, "internalLinks", "links to the same site"),
    num((p) => p.externalLinks, "externalLinks", "links off the site"),
    num((p) => p.images, "images", "images"),
    num((p) => p.schema.length, "schemaTypes", "schema.org types declared"),
    flag((p) => p.faq, "faq", "an FAQ (schema or a disclosure list) — count of pages that have one"),
    flag((p) => p.table, "table", "a real <table> — count of pages that have one"),
    flag((p) => p.comparison, "comparison", "comparison framing in the title or headings — count of pages that have it"),
  ];
}
