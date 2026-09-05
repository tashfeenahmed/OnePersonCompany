/**
 * Off-site footprint: where each product exists on somebody else's website.
 *
 * Ported from workdash's `collectors/collect_presence.py`. Every other
 * measurement on this box is of something the owner owns — his servers, his
 * Stripe account, his own HTML. This one measures the opposite: whether
 * anybody ELSE has a page about a product, because that is what an answer
 * engine reads when it decides whether a brand is real. A site can pass every
 * SEO check ever written and still be a thing only its owner has mentioned.
 *
 * THREE KINDS OF EVIDENCE, KEPT APART ALL THE WAY INTO THE TABLE.
 *   · `linked` — a record on the directory's own API that NAMES the brand AND
 *     POINTS BACK at one of the product's hosts. The only thing counted as
 *     present from a search-shaped source, and the reason is a live finding
 *     from the original file: half a portfolio's names are two ordinary
 *     English words, and searching them turns up other people's repositories,
 *     other people's apps and a Meta engineering post. A listing that does not
 *     point at us is not evidence that we are listed.
 *   · `named` — names the brand and does not point back. NOT a detection: it
 *     is a CANDIDATE, stored with its url and status `absent` so the owner can
 *     look. Nothing here counts as done until he says it does.
 *   · `page` — the directory's own url for this name answered, and the page
 *     names the brand. First-hand, and only as good as the url convention it
 *     was derived from, which every such row says out loud.
 *
 * `blocked` IS NOT `absent`, AND CONFUSING THEM IS THE MOST DAMAGING THING
 * THIS COLLECTOR COULD DO. A 403 from a WAF, a 429 from a rate limiter or a
 * timeout means we could not look. Recording that as "this product is listed
 * nowhere" would put a page of homework in front of the owner that nobody
 * owes, all of it false. So the status set is closed at four — present,
 * absent, blocked, error — and only an answer that came back produces one of
 * the first two.
 *
 * WHAT IS NOT PORTED: the SearXNG half. The original asks a metasearch
 * instance a `site:` query for fifty-one directories that publish no API, and
 * its own header records what that was worth on 1 Sep 2026 — every backend
 * but Bing lost to CAPTCHAs and suspensions, and Bing answering
 * `site:github.com Overbrilliant` with Polish news stories. It concluded that
 * no query strategy can work through that instance and that the direct probes
 * are better evidence than a search hit ever was. So this port is the probes,
 * plus the three named directories reached at their own conventional url —
 * and where neither is possible (Capterra) the row says `blocked` with the
 * reason, every run, rather than pretending to a verdict.
 *
 * POLITENESS IS PART OF THE DESIGN: one request at a time, a user agent that
 * names the project, a gap between calls, and a ten-second timeout. GitHub's
 * unauthenticated search allows ten requests a minute and gets seven seconds
 * of its own; nothing else here is asked more than once per product per day.
 */

export const UA =
  "onepersoncompany-presence/1.0 (+https://github.com/onepersoncompany; one-person dashboard)";
const TIMEOUT_MS = 10_000;

/** Every source this asks, in the order a matrix should render them. */
export const SOURCES = [
  "wikipedia",
  "wikidata",
  "github",
  "pypi",
  "appstore",
  "hackernews",
  "producthunt",
  "g2",
  "capterra",
] as const;
export type SourceId = (typeof SOURCES)[number];

export const SOURCE_LABEL: Record<SourceId, string> = {
  wikipedia: "Wikipedia",
  wikidata: "Wikidata",
  github: "GitHub",
  pypi: "PyPI",
  appstore: "App Store",
  hackernews: "Hacker News",
  producthunt: "Product Hunt",
  g2: "G2",
  capterra: "Capterra",
};

/** How each source is asked, published on the document so a reader knows what
 *  an `absent` from it is worth. */
export const SOURCE_METHOD: Record<SourceId, string> = {
  wikipedia: "REST summary endpoint for the brand as a title",
  wikidata: "wbsearchentities, accepted only on an exact label match",
  github: "repository search, accepted only when a repo's homepage is the product's host",
  pypi: "the exact-name JSON endpoint, accepted only when a project url is the product's host",
  appstore: "iTunes Search, accepted only when the seller url is the product's host",
  hackernews: "Algolia's HN index, accepted only when a story points at the product's host",
  producthunt: "the conventional product url for this name",
  g2: "the conventional product url for this name",
  capterra: "not asked — see the note on the row",
};

export type Status = "present" | "absent" | "blocked" | "error";
export type Evidence = "linked" | "named" | "page" | null;

export type Finding = {
  status: Status;
  url: string | null;
  evidence: Evidence;
  note: string | null;
};

export type Product = { name: string; host: string; hosts: string[] };

/* ------------------------------------------------------------- the list */

/**
 * The configured products, from one text field: `Name = host` per line.
 *
 * TWO THINGS ARE NEEDED AND NEITHER CAN BE DERIVED FROM THE OTHER. The NAME
 * is what a directory would have called the product and is the only thing
 * worth searching for; the HOST is what proves a record found that way is
 * ours. A list of hosts alone would search for "example-app-1.example.test" and find
 * nothing; a list of names alone would accept any stranger's project of the
 * same name.
 */
export function parseProducts(raw: string | null | undefined): Product[] {
  const out: Product[] = [];
  for (const line of (raw ?? "").split(/[\n,]+/)) {
    const [left, right] = line.split("=");
    const name = (left ?? "").trim();
    const host = hostOf((right ?? "").trim());
    if (!name || !host) continue;
    if (out.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ name, host, hosts: [host] });
  }
  return out;
}

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
  const host = candidate.split("/")[0]!.toLowerCase().trim().replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
    ? host
    : "";
}

/** Two labels, or three where the second-to-last is a known multi-part
 *  suffix. Narrow on purpose: it decides whether a url is ours. */
const MULTI_TLD = new Set(["com.pk", "co.uk", "com.au", "co.nz", "com.br", "co.za", "org.uk", "ie.com"]);
export function registrable(host: string | null | undefined): string {
  const parts = String(host ?? "").toLowerCase().split(".").filter(Boolean);
  if (parts.length < 2) return parts.join(".");
  if (parts.length >= 3 && MULTI_TLD.has(parts.slice(-2).join(".")))
    return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function hostOfUrl(url: string | null | undefined): string {
  try {
    return registrable(new URL(String(url)).hostname);
  } catch {
    return "";
  }
}

/** Is this url on one of the product's own hosts? */
export function ours(url: string | null | undefined, product: Product): boolean {
  const host = hostOfUrl(url);
  return !!host && product.hosts.some((h) => registrable(h) === host);
}

const flat = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The strings that mean "this record is about this brand".
 *
 * The brand run together — "Example App 1" → "example-app-1" — and the host's own
 * stem. NOT the individual WORDS: half a portfolio's names are two ordinary
 * English words, and a needle of "well" would match most of the internet.
 * Anything under four characters is dropped, because a three-letter stem
 * inside an ordinary word is a coin toss and a footprint inflated by a
 * coincidence is worse than one that is honestly low.
 */
export function needles(product: Product): string[] {
  const out = new Set<string>();
  for (const candidate of [product.name, product.host.split(".")[0]]) {
    const f = flat(candidate);
    if (f.length >= 4) out.add(f);
  }
  return [...out];
}

export function namesBrand(text: unknown, ns: string[]): boolean {
  const hay = flat(text);
  return ns.some((n) => hay.includes(n));
}

/** The slug a directory would have minted from this name. Derived, and every
 *  row built on one says so: a product filed under a different slug is not
 *  found, and that is an `absent` about a URL rather than about a site. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/* -------------------------------------------------------------- transport */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

type Got<T> =
  | { kind: "ok"; data: T }
  | { kind: "missing" }                       // a 404, which is an ANSWER
  | { kind: "blocked"; why: string }          // 403, 429, a timeout: we could not look
  | { kind: "error"; why: string };

/** A GET that returns one of four verdicts and never throws. The split
 *  between `missing` and `blocked` is the whole reason this exists. */
async function get(url: string, accept: string): Promise<Got<Response>> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    return name === "TimeoutError"
      ? { kind: "blocked", why: "no answer within 10 seconds" }
      : { kind: "error", why: `unreachable (${name})` };
  }
  if (res.status === 404) return { kind: "missing" };
  if (res.status === 403 || res.status === 429 || res.status === 451)
    return { kind: "blocked", why: `HTTP ${res.status} — the site refused the request` };
  if (res.status >= 500)
    return { kind: "blocked", why: `HTTP ${res.status} — the site is having a bad minute` };
  if (!res.ok) return { kind: "error", why: `HTTP ${res.status}` };
  return { kind: "ok", data: res };
}

async function getJson<T>(url: string): Promise<Got<T>> {
  const got = await get(url, "application/json");
  if (got.kind !== "ok") return got;
  try {
    return { kind: "ok", data: (await got.data.json()) as T };
  } catch {
    return { kind: "error", why: "the answer was not JSON" };
  }
}

/** A verdict that is not an answer, turned into a row. */
function nonAnswer(got: Exclude<Got<unknown>, { kind: "ok" } | { kind: "missing" }>): Finding {
  return {
    status: got.kind === "blocked" ? "blocked" : "error",
    url: null,
    evidence: null,
    note: got.why + (got.kind === "blocked" ? " — read this as NOT CHECKED, never as not listed." : ""),
  };
}

/* --------------------------------------------------------------- the nine */

/** Wikipedia's REST summary. A 404 is an ANSWER — no article — and a
 *  disambiguation page is not an article about this product. */
export async function wikipedia(product: Product): Promise<Finding> {
  const title = encodeURIComponent(product.name.replace(/\s+/g, "_"));
  const got = await getJson<{ type?: string; content_urls?: { desktop?: { page?: string } } }>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`,
  );
  if (got.kind === "missing")
    return { status: "absent", url: null, evidence: null, note: "no article under this exact title" };
  if (got.kind !== "ok") return nonAnswer(got);
  if (got.data.type === "disambiguation")
    return {
      status: "absent",
      url: null,
      evidence: null,
      note: "the title resolves to a disambiguation page, which is not an article about this product",
    };
  return {
    status: "present",
    url: got.data.content_urls?.desktop?.page ?? null,
    evidence: "page",
    note: null,
  };
}

/** Wikidata's `wbsearchentities`, on an EXACT label match only: it is a
 *  prefix search and will happily return "Betamax" for "Betaware", and a
 *  footprint inflated by a coincidence is worse than one that is merely low. */
export async function wikidata(product: Product): Promise<Finding> {
  const q = new URLSearchParams({
    action: "wbsearchentities",
    search: product.name,
    language: "en",
    format: "json",
    limit: "5",
    type: "item",
  });
  const got = await getJson<{ search?: { label?: string; concepturi?: string; url?: string }[] }>(
    `https://www.wikidata.org/w/api.php?${q}`,
  );
  if (got.kind === "missing") return { status: "absent", url: null, evidence: null, note: null };
  if (got.kind !== "ok") return nonAnswer(got);
  const want = flat(product.name);
  for (const row of got.data.search ?? [])
    if (flat(row.label) === want)
      return { status: "present", url: row.concepturi ?? row.url ?? null, evidence: "page", note: null };
  return {
    status: "absent",
    url: null,
    evidence: null,
    note: "no item whose label is exactly this name — a prefix match is not accepted",
  };
}

/** GitHub repository search, gated on the repo's homepage being ours. */
export async function github(product: Product, ns: string[]): Promise<Finding> {
  const got = await getJson<{
    items?: { full_name?: string; description?: string; homepage?: string; html_url?: string }[];
  }>(`https://api.github.com/search/repositories?per_page=8&q=${encodeURIComponent(product.name)}`);
  if (got.kind === "missing") return { status: "absent", url: null, evidence: null, note: null };
  if (got.kind !== "ok") return nonAnswer(got);
  let candidate: string | null = null;
  for (const item of got.data.items ?? []) {
    if (!namesBrand(`${item.full_name} ${item.description} ${item.homepage}`, ns)) continue;
    if (ours(item.homepage, product))
      return { status: "present", url: item.html_url ?? null, evidence: "linked", note: null };
    candidate ??= item.html_url ?? null;
  }
  return candidate
    ? {
        status: "absent",
        url: candidate,
        evidence: "named",
        note:
          "a repository names the brand but its homepage does not point at this " +
          "product's host, so it is a CANDIDATE for you to judge rather than a listing",
      }
    : { status: "absent", url: null, evidence: null, note: null };
}

/** PyPI answers by EXACT project name, so this is a deterministic 200-or-404
 *  rather than a search — and the needles are the only names tried, which is
 *  what keeps a three-letter stem from matching a stranger's package. */
export async function pypi(product: Product, ns: string[]): Promise<Finding> {
  let candidate: string | null = null;
  for (const name of ns) {
    const got = await getJson<{ info?: { home_page?: string; project_urls?: Record<string, string> } }>(
      `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
    );
    if (got.kind === "missing") continue;
    if (got.kind !== "ok") return nonAnswer(got);
    const info = got.data.info ?? {};
    const urls = [info.home_page, ...Object.values(info.project_urls ?? {})];
    if (urls.some((u) => ours(u, product)))
      return { status: "present", url: `https://pypi.org/project/${name}/`, evidence: "linked", note: null };
    candidate ??= `https://pypi.org/project/${name}/`;
  }
  return candidate
    ? {
        status: "absent",
        url: candidate,
        evidence: "named",
        note:
          "a package of this name exists and none of its urls point at this " +
          "product's host — somebody else's package, or yours with no homepage set",
      }
    : { status: "absent", url: null, evidence: null, note: "no package under any of this brand's names" };
}

/** iTunes Search, gated on the SELLER's own url — exactly the field that tells
 *  our app from somebody else's app of the same name, and there are several. */
export async function appstore(product: Product, ns: string[]): Promise<Finding> {
  const got = await getJson<{
    results?: { trackName?: string; sellerUrl?: string; trackViewUrl?: string }[];
  }>(
    `https://itunes.apple.com/search?limit=8&entity=software&term=${encodeURIComponent(product.name)}`,
  );
  if (got.kind === "missing") return { status: "absent", url: null, evidence: null, note: null };
  if (got.kind !== "ok") return nonAnswer(got);
  let candidate: string | null = null;
  for (const r of got.data.results ?? []) {
    if (!namesBrand(r.trackName, ns)) continue;
    if (ours(r.sellerUrl, product))
      return { status: "present", url: r.trackViewUrl ?? null, evidence: "linked", note: null };
    candidate ??= r.trackViewUrl ?? null;
  }
  return candidate
    ? {
        status: "absent",
        url: candidate,
        evidence: "named",
        note: "an app names the brand and its seller url is not this product's host",
      }
    : { status: "absent", url: null, evidence: null, note: null };
}

/** Algolia's Hacker News index. A story POINTING AT the host is the listing; a
 *  story that merely says the words is the candidate. */
export async function hackernews(product: Product, ns: string[]): Promise<Finding> {
  const got = await getJson<{ hits?: { url?: string; title?: string; objectID?: string }[] }>(
    `https://hn.algolia.com/api/v1/search?hitsPerPage=15&query=${encodeURIComponent(product.name)}`,
  );
  if (got.kind === "missing") return { status: "absent", url: null, evidence: null, note: null };
  if (got.kind !== "ok") return nonAnswer(got);
  const hits = got.data.hits ?? [];
  for (const h of hits)
    if (ours(h.url, product))
      return {
        status: "present",
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        evidence: "linked",
        note: null,
      };
  for (const h of hits)
    if (namesBrand(h.title, ns))
      return {
        status: "absent",
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        evidence: "named",
        note: "a story names the brand without linking to it — a mention, not a submission",
      };
  return { status: "absent", url: null, evidence: null, note: null };
}

/**
 * The two directories with a derivable url, read first-hand.
 *
 * NEITHER PUBLISHES A KEYLESS LOOKUP, so the only honest question available is
 * "does the page this name would be at exist, and does it name the brand". An
 * `absent` from here is therefore about A URL and says so: a product filed
 * under a different slug is not found by this, and the note on every row makes
 * that the reader's first sentence rather than a footnote.
 */
async function directoryPage(url: string, ns: string[], about: string): Promise<Finding> {
  const got = await get(url, "text/html");
  if (got.kind === "missing")
    return {
      status: "absent",
      url: null,
      evidence: null,
      note: `no page at ${url} — ${about}, so a listing under a different slug would not be found here`,
    };
  if (got.kind !== "ok") return nonAnswer(got);
  const html = (await got.data.text().catch(() => "")).slice(0, 200_000);
  return namesBrand(html.replace(/<[^>]*>/g, " "), ns)
    ? { status: "present", url, evidence: "page", note: `${about}, and the page names the brand` }
    : {
        status: "absent",
        url,
        evidence: null,
        note: `the page at ${url} answered but does not name the brand — ${about}`,
      };
}

export function producthunt(product: Product, ns: string[]): Promise<Finding> {
  return directoryPage(
    `https://www.producthunt.com/products/${slugOf(product.name)}`,
    ns,
    "the url is derived from the product name",
  );
}

export function g2(product: Product, ns: string[]): Promise<Finding> {
  return directoryPage(
    `https://www.g2.com/products/${slugOf(product.name)}/reviews`,
    ns,
    "the url is derived from the product name",
  );
}

/**
 * Capterra, which cannot be asked at all from here — and says so every run.
 *
 * Its product urls carry a numeric id (`/p/123456/Name/`) that cannot be
 * derived from a name, it publishes no keyless lookup, and its search page is
 * a page that always exists whatever you ask it, so a 200 from it would mean
 * nothing. The row is `blocked` rather than absent, and rather than omitted:
 * a column missing from the matrix is a question the reader does not know was
 * asked, and "we cannot look here" is a finding worth one line.
 */
export async function capterra(): Promise<Finding> {
  return {
    status: "blocked",
    url: null,
    evidence: null,
    note:
      "not checked, and it cannot be from this box: Capterra's product urls " +
      "carry a numeric id that cannot be derived from a name, it publishes no " +
      "keyless lookup, and its search page answers 200 for anything. This is " +
      "NOT a report that the product is unlisted there.",
  };
}
