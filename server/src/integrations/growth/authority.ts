/**
 * A SELF-DECLARED AUTHORITY ESTIMATE, AND THE DIFFICULTY CEILING IT IMPLIES.
 *
 * WHAT THIS IS NOT, first, because the whole file is worthless if this line is
 * ever softened: it is NOT a Domain Rating and it is NOT Domain Authority.
 * Ahrefs, Moz and Semrush each derive theirs from a link index this box does
 * not have and will never buy, and a number that looked like one would be read
 * like one. The field is called `estimate`, the label travels with every
 * answer, and nothing here may be called a DA or a DR by any page or any agent.
 *
 * WHY IT EXISTS ANYWAY. Every SEO suggestion this box can make is
 * difficulty-blind: a forty-page site with two referring domains is told to go
 * after a head term it cannot reach this decade, because nothing anywhere knows
 * how hard a query is or how much site there is to compete with. So this
 * computes, from figures the box ALREADY COLLECTED, a coarse band — and the
 * band's only job is to be a CEILING on what to suggest, never a claim about
 * the site.
 *
 * NO MODEL RUNS HERE. It is a mean of three numbers, and a mean is arithmetic.
 * A model asked for it would produce a different figure every day from the same
 * inputs, which is the one thing a ceiling may not do.
 *
 * THE THREE PARTS, and what each is honestly worth:
 *
 *   links   referring domains, from the backlinks area. THE SOURCES ARE NEVER
 *           ADDED: Common Crawl, Bing and this box's own verification crawler
 *           disagree by design, so the best single source is taken and NAMED,
 *           and the spread — how many distinct domains the verified rows
 *           actually come from — is reported beside it rather than folded in.
 *   pages   how much site there is, from the latest audit's sitemap count or
 *           its crawl. Size is a weak proxy for authority and an honest one: a
 *           search engine cannot rank pages that do not exist. Log-scaled,
 *           because 10 pages to 100 is not the same distance as 1,000 to 1,090.
 *   demand  Search Console impressions over its own window, and Bing's where
 *           Google has none. What a search engine already chose to show is the
 *           only evidence here that comes from a search engine at all.
 *
 * A MISSING PART IS DROPPED, NEVER ZEROED. The estimate is the mean of the
 * parts that could be read, and which ones those were is on the answer. Zero is
 * a real band with a real ceiling on it, and scoring an unmeasured site as zero
 * would hand it a lower ceiling than a site measured to be small.
 *
 * WHICH IS ALSO WHY TWO HOSTS ARE NEVER COMPARED ACROSS DIFFERENT PARTS.
 * `basis` names the parts an estimate was computed from; two hosts whose
 * `basis` differs are two different measurements wearing the same word, and
 * ranking them against each other is the mistake this file is most likely to be
 * used for.
 *
 * COMPUTED ON EVERY READ. There is no authority table and there should not be:
 * the answer is a pure function of rows other collectors already own, and a
 * stored copy would be a third thing that can go stale.
 */
import { db } from "../../db.ts";
import { registrable } from "./pages.ts";

/** The sentence that travels with every estimate, in one place so the page and
 *  the agent cannot drift apart, and so grepping for it finds every claim. */
export const LABEL =
  "this app's own estimate from this box's own collected figures — not a Domain Rating, Domain Authority or any vendor's score";

/**
 * Estimate → keyword-difficulty ceiling.
 *
 * The bands are coarse on purpose: the inputs are three log-scaled proxies, and
 * a ladder with ten rungs on it would be claiming a precision the inputs cannot
 * carry. Above 60 there is no ceiling worth stating — a site scoring that on
 * these three is not being held back by difficulty, and inventing a rung would
 * be putting a number on the absence of a constraint.
 */
const BANDS = [
  { under: 15, kd: 10 },
  { under: 30, kd: 20 },
  { under: 45, kd: 35 },
  { under: 60, kd: 50 },
];

export function ceilingFor(estimate: number | null): number | null {
  if (estimate === null || !Number.isFinite(estimate)) return null;
  for (const b of BANDS) if (estimate < b.under) return b.kd;
  return null;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** A count on a log scale over `decades` powers of ten, as 0–100. Null in,
 *  null out — an unread count is not a count of nothing. */
export function logScore(value: number | null, decades: number): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  if (value === 0) return 0;
  return Number(clamp((100 * Math.log10(1 + value)) / decades, 0, 100).toFixed(1));
}

/* ------------------------------------------------------------- the inputs */

type LinkInput = {
  referringDomains: number | null;
  /** Which source said it. Never a sum of two. */
  from: string | null;
  /** How many distinct registrable domains the stored link rows come from, and
   *  how many of those this box actually verified as live. Reported beside the
   *  count rather than folded into it. */
  spread: number | null;
  verifiedLive: number | null;
  sources: { source: string; ok: number | null; referringDomains: number | null }[];
};

function linksFor(host: string): LinkInput {
  const rows = db
    .prepare("SELECT source, ok, referring_domains FROM backlink_sources WHERE host = ?")
    .all(host) as unknown as { source: string; ok: number | null; referring_domains: number | null }[];
  const named = rows.map((r) => ({ source: r.source, ok: r.ok, referringDomains: r.referring_domains }));
  /* THE BEST SINGLE SOURCE, NOT THE SUM. Two indexes' referring-domain counts
     overlap by an unknown amount; adding them would produce a number in no
     unit at all. The largest is taken and the source is named with it. */
  let best: { source: string; value: number } | null = null;
  for (const r of named)
    if (r.referringDomains !== null && (best === null || r.referringDomains > best.value))
      best = { source: r.source, value: r.referringDomains };

  const spread = db
    .prepare("SELECT COUNT(DISTINCT from_domain) AS n FROM backlink_rows WHERE host = ?")
    .get(host) as { n: number } | undefined;
  const live = db
    .prepare("SELECT COUNT(DISTINCT from_domain) AS n FROM backlink_rows WHERE host = ? AND live = 1")
    .get(host) as { n: number } | undefined;

  return {
    referringDomains: best?.value ?? null,
    from: best?.source ?? null,
    spread: rows.length ? (spread?.n ?? 0) : null,
    verifiedLive: rows.length ? (live?.n ?? 0) : null,
    sources: named,
  };
}

type PagesInput = { pages: number | null; from: string | null };

/** How much site there is: the latest audit's sitemap count first — what the
 *  SITE says it has — and its crawl count second, which is a fact about our own
 *  page budget. Both zero is NULL, not zero: an alias domain that redirects
 *  reaches nothing, and a zero there would hand it the bottom band and a
 *  confident ceiling built out of a crawl that never happened. */
function pagesFor(host: string): PagesInput {
  const row = db
    .prepare(
      `SELECT a.doc AS doc FROM venture_audits a
         JOIN ventures v ON v.id = a.venture_id
        WHERE v.host = ? ORDER BY a.ts DESC LIMIT 1`,
    )
    .get(host) as { doc: string } | undefined;
  if (!row) return { pages: null, from: null };
  try {
    const doc = JSON.parse(row.doc) as { sitemap?: { urls?: number | null }; crawl?: { reached?: number } };
    const sitemap = typeof doc.sitemap?.urls === "number" && doc.sitemap.urls > 0 ? doc.sitemap.urls : null;
    if (sitemap !== null) return { pages: sitemap, from: "the sitemap the last audit read" };
    const reached = typeof doc.crawl?.reached === "number" && doc.crawl.reached > 0 ? doc.crawl.reached : null;
    return reached === null ? { pages: null, from: null } : { pages: reached, from: "the pages the last audit's crawl reached, which is a fact about the crawl's budget as much as about the site" };
  } catch {
    return { pages: null, from: null };
  }
}

type DemandInput = { impressions: number | null; from: string | null; position: number | null; window: string | null };

/** What a search engine already chose to show. Google first because it has a
 *  window on the row; Bing second, whose figure is a running total rather than
 *  a window and is labelled as such. */
function demandFor(host: string): DemandInput {
  const want = registrable(host);
  const gsc = db
    .prepare("SELECT property, total_impressions, total_position, window_start, window_end FROM gsc_sites")
    .all() as unknown as {
    property: string;
    total_impressions: number | null;
    total_position: number | null;
    window_start: string | null;
    window_end: string | null;
  }[];
  for (const g of gsc) {
    const name = g.property.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").split("/")[0]!.replace(/^www\./, "");
    if (registrable(name) !== want || g.total_impressions === null) continue;
    return {
      impressions: g.total_impressions,
      from: `Search Console (${g.property})`,
      position: g.total_position,
      window: g.window_start && g.window_end ? `${g.window_start} to ${g.window_end}` : null,
    };
  }
  const bing = db.prepare("SELECT site, in_index FROM bing_sites").all() as unknown as { site: string; in_index: number | null }[];
  for (const b of bing) {
    const name = String(b.site).replace(/^https?:\/\//, "").split("/")[0]!.replace(/^www\./, "");
    if (registrable(name) !== want || b.in_index === null) continue;
    return {
      impressions: null,
      from: `Bing Webmaster reports ${b.in_index} pages in its index for ${b.site}. That is an INDEX COUNT, not impressions, so it is reported here and is NOT used in the estimate.`,
      position: null,
      window: null,
    };
  }
  return { impressions: null, from: null, position: null, window: null };
}

/* ------------------------------------------------------------ the estimate */

export type AuthorityPart = {
  name: "links" | "pages" | "demand";
  /** The raw figure, in its own units. */
  input: number | null;
  /** Where the figure came from, named. */
  from: string | null;
  /** The 0–100 the arithmetic uses. */
  score: number | null;
  /** The arithmetic itself, so it can be checked by hand. */
  working: string;
};

export type Authority = {
  host: string;
  label: string;
  estimate: number | null;
  /** The highest keyword difficulty worth going after at this estimate, on
   *  this app's own coarse ladder. Null above the top band, which means "not
   *  constrained by difficulty at this size" and never "no limit". */
  ceiling: number | null;
  ceilingMeans: string;
  parts: AuthorityPart[];
  /** The parts that actually contributed. Two hosts whose `basis` differs are
   *  not comparable and the rules say so. */
  basis: string[];
  missing: string[];
  arithmetic: string[];
  links: LinkInput;
  note: string | null;
};

/** One host's estimate, computed now. */
export function authorityFor(hostRaw: string): Authority {
  const host = String(hostRaw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0]!.replace(/^www\./, "");
  const links = linksFor(host);
  const pages = pagesFor(host);
  const demand = demandFor(host);

  /* THE DECADES ARE CHOSEN AND SAID OUT LOUD. Referring domains over three
     decades: a thousand is the top of what this scale distinguishes and is far
     past anything a one-person portfolio has. Pages and impressions over six,
     so the top of the scale is a site nobody here owns — topping out at ten
     thousand would give a ten-thousand-page site the reach of Wikipedia. */
  const parts: AuthorityPart[] = [
    {
      name: "links",
      input: links.referringDomains,
      from: links.from ? `${links.from} (never summed with the other sources)` : null,
      score: logScore(links.referringDomains, 3),
      working: `100 × log10(1 + referring domains) ÷ 3, so 9 domains is 33, 99 is 67, 999 is 100`,
    },
    {
      name: "pages",
      input: pages.pages,
      from: pages.from,
      score: logScore(pages.pages, 6),
      working: `100 × log10(1 + pages) ÷ 6, so 10 pages is 17, 1,000 is 50, 1,000,000 is 100`,
    },
    {
      name: "demand",
      input: demand.impressions,
      from: demand.from,
      score: logScore(demand.impressions, 6),
      working: `100 × log10(1 + impressions over the property's own window) ÷ 6`,
    },
  ];

  const live = parts.filter((p) => p.score !== null);
  const missing = parts.filter((p) => p.score === null).map((p) => p.name);
  const arithmetic = parts.map((p) =>
    p.score === null
      ? `${p.name}: not measured — ${p.from ?? "nothing on this box reports it for this host"}. It is dropped from the mean, not counted as zero.`
      : `${p.name}: ${p.input} → ${p.score} (${p.working}); source: ${p.from}`,
  );

  if (!live.length)
    return {
      host,
      label: LABEL,
      estimate: null,
      ceiling: null,
      ceilingMeans: CEILING_MEANS,
      parts,
      basis: [],
      missing,
      arithmetic,
      links,
      note: `Nothing on this box measures ${host}: no backlink rows, no audit and no Search Console property. That is not a low estimate — there is no estimate.`,
    };

  const estimate = Number((live.reduce((n, p) => n + p.score!, 0) / live.length).toFixed(1));
  arithmetic.push(
    `estimate = mean of the ${live.length} part${live.length === 1 ? "" : "s"} that could be read = (${live.map((p) => p.score).join(" + ")}) ÷ ${live.length} = ${estimate}`,
  );
  const ceiling = ceilingFor(estimate);
  arithmetic.push(
    ceiling === null
      ? `ceiling: none. Above 60 this ladder states no ceiling — that means difficulty is not the binding constraint at this size, NOT that there is no limit.`
      : `ceiling: ${ceiling}. The bands are <15→10, <30→20, <45→35, <60→50, and they are this app's own coarse ladder.`,
  );

  return {
    host,
    label: LABEL,
    estimate,
    ceiling,
    ceilingMeans: CEILING_MEANS,
    parts,
    basis: live.map((p) => p.name),
    missing,
    arithmetic,
    links,
    note:
      live.length < parts.length
        ? `Computed from ${live.length} of ${parts.length} parts. An estimate over fewer parts is a coarser one, and it may not be compared with a host measured on a different set.`
        : null,
  };
}

const CEILING_MEANS =
  "The highest keyword difficulty worth going after at this estimate, on this app's own coarse ladder. It is advice about where to spend effort, not a prediction, and it is not anybody's published KD scale.";

/** Every venture's host, with its estimate. Ordered by host so the list is
 *  stable; deliberately NOT sorted by estimate, because a league table across
 *  hosts measured on different parts is exactly what the rules forbid. */
export function authorityAll(): { hosts: Authority[]; label: string; note: string } {
  const rows = db.prepare("SELECT DISTINCT host FROM ventures WHERE host IS NOT NULL AND host <> '' ORDER BY host").all() as unknown as {
    host: string;
  }[];
  return {
    hosts: rows.map((r) => authorityFor(r.host)),
    label: LABEL,
    note:
      "Listed by host and never ranked. Each estimate is the mean of whichever parts could be read for THAT host, so two rows whose `basis` differs are two different measurements and putting them in an order would be inventing a comparison.",
  };
}
