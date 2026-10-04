/**
 * Off-site footprint: where each product exists on somebody else's website.
 *
 * Ported from the presence collector in the system this replaces. Every other
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
 * `site:github.com <a portfolio brand>` with unrelated foreign-language news. It concluded that
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

import { hostOf, sameSite } from "../../../shared/host.ts";

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
  wikipedia: "REST summary endpoint for the brand as a title; a redirect or a short name counts only when the article mentions the product",
  wikidata: "wbsearchentities, accepted only on an exact label match (and, for a short name, a description that mentions the product)",
  github: "repository search by name and by the host-stem account, accepted only when a repo's homepage is the product's host",
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
 * ours. A list of hosts alone would search for a bare domain and find
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

/**
 * Is this url on one of the product's own hosts? Delegates to `sameSite`
 * (`shared/host.ts`) — see that module's header for why ownership runs
 * downward only rather than by registrable domain.
 */
export function ours(url: string | null | undefined, product: Product): boolean {
  return product.hosts.some((h) => sameSite(h, url));
}

const flat = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The strings that mean "this record is about this brand".
 *
 * The brand run together — "Acme Beacon" → "acmebeacon" — and the host's own
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

/**
 * A name too short to identify anything on its own. "ZB-1" flattens to three
 * characters, and Wikipedia resolves it to the an unrelated article while
 * Wikidata finds a ship called ZB-1 — both exact matches on the name, neither
 * about the product. Under six letters and digits a name is a coincidence
 * waiting to happen, so a record found by it alone is not enough.
 */
export const DISTINCT_NAME_MIN = 6;

export function ambiguousName(product: Product): boolean {
  return flat(product.name).length < DISTINCT_NAME_MIN;
}

/**
 * Does this text tie the record to the product rather than to the name? The
 * product's host (or any of its hosts), or the host's stem when it is long
 * enough to be distinctive — "zebrabyte" for zebrabyte.example — or the
 * name itself when the name is distinctive.
 */
export function corroborates(text: unknown, product: Product): boolean {
  const raw = String(text ?? "").toLowerCase();
  if (product.hosts.some((h) => raw.includes(h.toLowerCase()))) return true;
  const hay = flat(text);
  const stem = flat(product.host.split(".")[0]);
  if (stem.length >= DISTINCT_NAME_MIN && hay.includes(stem)) return true;
  return !ambiguousName(product) && hay.includes(flat(product.name));
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
  const got = await getJson<{
    type?: string;
    title?: string;
    description?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  }>(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`);
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
  /* A REDIRECT IS SOMEBODY ELSE'S ARTICLE. The summary endpoint follows
     redirects silently — "ZB-1" comes back as "Zettabyte" — so an
     article whose own title is not the name asked for, or a name too short to
     identify anything, counts only when the article itself mentions the
     product's host or distinctive name. */
  const redirected = flat(got.data.title) !== flat(product.name);
  const about = `${got.data.title ?? ""} ${got.data.description ?? ""} ${got.data.extract ?? ""}`;
  if ((redirected || ambiguousName(product)) && !corroborates(about, product))
    return {
      status: "absent",
      url: null,
      evidence: null,
      note: redirected
        ? `the title resolves to “${got.data.title}”, an article that does not mention this product`
        : "an article has this title but does not mention this product's host or name",
    };
  return {
    status: "present",
    url: got.data.content_urls?.desktop?.page ?? null,
    evidence: "page",
    note: null,
  };
}

/** Wikidata's `wbsearchentities`, on an EXACT label match only: it is a
 *  prefix search and will happily return "Acmetal Industries" for "Acme", and
 *  a footprint inflated by a coincidence is worse than one merely low. */
export async function wikidata(product: Product): Promise<Finding> {
  const q = new URLSearchParams({
    action: "wbsearchentities",
    search: product.name,
    language: "en",
    format: "json",
    limit: "5",
    type: "item",
  });
  const got = await getJson<{ search?: { label?: string; description?: string; concepturi?: string; url?: string }[] }>(
    `https://www.wikidata.org/w/api.php?${q}`,
  );
  if (got.kind === "missing") return { status: "absent", url: null, evidence: null, note: null };
  if (got.kind !== "ok") return nonAnswer(got);
  const want = flat(product.name);
  /* An exact label on a short name is still a coincidence — a ship called
     ZB-1 is labelled exactly "ZB-1" — so a short name needs its description to
     mention the product too. */
  const short = ambiguousName(product);
  let lookalike = false;
  for (const row of got.data.search ?? []) {
    if (flat(row.label) !== want) continue;
    if (short && !corroborates(row.description, product)) {
      lookalike = true;
      continue;
    }
    return { status: "present", url: row.concepturi ?? row.url ?? null, evidence: "page", note: null };
  }
  if (lookalike)
    return {
      status: "absent",
      url: null,
      evidence: null,
      note: "an item carries this exact label but its description is not about this product — the name is too short to count on its own",
    };
  return {
    status: "absent",
    url: null,
    evidence: null,
    note: "no item whose label is exactly this name — a prefix match is not accepted",
  };
}

/** GitHub repository search, gated on the repo's homepage being ours. */
export async function github(product: Product, ns: string[]): Promise<Finding> {
  type Repo = { full_name?: string; description?: string; homepage?: string; html_url?: string };
  const got = await getJson<{ items?: Repo[] }>(
    `https://api.github.com/search/repositories?per_page=8&q=${encodeURIComponent(product.name)}`,
  );
  if (got.kind === "missing") return { status: "absent", url: null, evidence: null, note: null };
  if (got.kind !== "ok") return nonAnswer(got);
  /* A SHORT NAME IS BURIED IN A NAME SEARCH. "ZB-1" ranks a thousand
     strangers' repos above github.com/Zebrabyte/zb-1, whose homepage is
     zebrabyte.example. The account named after the host's stem is the other
     place the product's own repo would be, so its repos are read too — still
     accepted only on a homepage that is ours. */
  const items: Repo[] = [...(got.data.items ?? [])];
  const stem = product.host.split(".")[0] ?? "";
  if (/^[a-z0-9-]{2,39}$/i.test(stem) && !items.some((i) => ours(i.homepage, product))) {
    const owned = await getJson<{ items?: Repo[] }>(
      `https://api.github.com/search/repositories?per_page=8&q=${encodeURIComponent(`user:${stem}`)}`,
    );
    if (owned.kind === "ok") items.push(...(owned.data.items ?? []));
  }
  let candidate: string | null = null;
  for (const item of items) {
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
