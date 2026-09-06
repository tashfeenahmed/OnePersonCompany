/**
 * DO THESE TWO STRINGS NAME THE SAME SITE.
 *
 * Every area asks it, and answering it three incompatible ways was not a
 * theoretical problem: the same domain was attributed to a venture on one page
 * and to nothing on another, and two collectors in one area disagreed about
 * whether a backlink was ours.
 *
 * WHAT THIS MODULE SETTLED ON
 *
 *   1. `hostOf` is the reducer. A hostname out of whatever a provider stored —
 *      a bare host, a URL, or Search Console's `sc-domain:` prefix — lowercased,
 *      `www.` removed, the port removed and the trailing dot dropped, because
 *      the ventures table stores hosts that way and two spellings of one host
 *      is two things that never match. It returns `null` for anything that is
 *      not host-shaped — returning `""` would make "no host" and "the empty
 *      host" read the same in a `Map` key.
 *
 *   2. `hostMatch` is ONE-DIRECTIONAL, and that is the whole point. A
 *      bidirectional rule (`a.endsWith(b) || b.endsWith(a)`) lets
 *      `blog.example.com` swallow `example.com`: two different businesses
 *      filed under one name the moment somebody runs a blog on a subdomain of
 *      a domain somebody else's venture owns. REJECTED. Ownership runs
 *      downward only.
 *
 *   3. `registrable` is for GROUPING, never for ownership. Reducing to the
 *      registrable domain is bidirectional by construction — `blog.x.com` and
 *      `x.com` both fold to `x.com` — so using it to decide which venture owns
 *      a host reintroduces exactly the bug rule 2 rejects. Use it to stop one
 *      competitor's three subdomains eating a sample, to count referring
 *      domains, to bucket backlinks. Use `hostMatch`/`ventureForHost` to
 *      decide whose something is.
 *
 * There is no public-suffix dependency: the server has no runtime dependencies
 * beyond hono, and a downloaded suffix list is a file that goes stale on a box
 * nobody is watching. The hand-written list below is deliberately broad, and a
 * suffix missing from it folds to two labels — wrong in the direction that
 * costs a duplicate rather than a wrong comparison.
 */

/* ------------------------------------------------------------------ hostOf */

/**
 * A hostname out of anything host-shaped, or `null`.
 *
 * The validating regex is strict on purpose: labels of `[a-z0-9]`/`-`, at
 * least one dot, no leading or trailing hyphen. It rejects `a..b`, `-x.com`
 * and a bare word, all of which a looser rule accepts and then compares
 * against real hosts.
 */
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function hostOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let v = String(raw).trim().toLowerCase();
  if (!v) return null;
  /* Search Console names a domain property `sc-domain:example.com`. It is the
     key gsc_days, gsc_queries and gsc_pages are all stored under, so it
     arrives here far more often than it looks like it would. */
  if (v.startsWith("sc-domain:")) v = v.slice("sc-domain:".length).trim();
  if (v.includes("://")) {
    try {
      v = new URL(v).hostname;
    } catch {
      return null;
    }
  } else {
    /* A bare host may still carry a path or a query when it came out of a
       spreadsheet cell or a pasted address bar. */
    v = v.split("/")[0]!.split("?")[0]!.split("#")[0]!;
  }
  v = v.replace(/\.$/, "").replace(/^www\./, "").replace(/:\d+$/, "");
  return HOST_RE.test(v) ? v : null;
}

/* -------------------------------------------------------------- registrable */

/**
 * Multi-label public suffixes, explicitly.
 *
 * `ie.com` earns its place in the list rather than the label rule below: its
 * last label is `com`, so no ccTLD rule would ever catch it.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "com.pk", "co.uk", "org.uk", "com.au", "co.nz", "com.br",
  "co.za", "co.in", "co.jp", "ie.com",
]);

/**
 * The generic second-level labels — a label set rather than a suffix list, and
 * the only rule that gets `a.b.gov.br` right.
 *
 * Applied ONLY under a two-letter (country-code) TLD. Unconstrained, the label
 * rule reads `mail.net.com` as one registrable domain.
 */
const SECOND_LEVEL_LABELS = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

/**
 * The registrable domain — the part somebody actually pays a registrar for.
 *
 * Two labels, or three where the last two are a known multi-part suffix or a
 * generic second-level label under a ccTLD. Approximate on purpose, and only
 * ever used where being approximate costs a duplicate row: see rule 3 in the
 * header for what this must NOT be used for.
 *
 * Takes a host or anything `hostOf` accepts; returns `""` when there is
 * nothing host-shaped, because the callers of this one bucket by its result
 * and a `null` key is not a bucket.
 */
export function registrable(raw: string | null | undefined): string {
  const host = hostOf(raw) ?? String(raw ?? "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 3) return parts.join(".");
  const last = parts[parts.length - 1]!;
  const secondLast = parts[parts.length - 2]!;
  const takeThree =
    MULTI_LABEL_SUFFIXES.has(`${secondLast}.${last}`) ||
    (last.length === 2 && SECOND_LEVEL_LABELS.has(secondLast));
  return parts.slice(takeThree ? -3 : -2).join(".");
}

/* --------------------------------------------------------------- hostMatch */

/** How an entity's host relates to a venture's, or `null` for not at all. */
export type HostRelation = "same" | "sub";

/**
 * Does this entity's host belong to this venture's?
 *
 * EQUAL, OR A SUBDOMAIN OF IT — and in that direction only. `api.example.com`
 * belongs to `example.com`; `example.com` does not belong to
 * `api.example.com`, and neither of them has anything to do with
 * `example.org`. The one-directional rule is the whole of the protection
 * against filing two businesses under one name, and a portfolio only has to
 * contain one pair like that for the bidirectional version to merge them.
 *
 * Both arguments go through `hostOf` first, so a caller may pass a URL, a
 * `sc-domain:` property or a host and get the same answer.
 */
export function hostMatch(
  ventureHost: string | null | undefined,
  entityHost: string | null | undefined,
): HostRelation | null {
  const v = hostOf(ventureHost);
  const e = hostOf(entityHost);
  if (!v || !e) return null;
  if (v === e) return "same";
  if (e.endsWith(`.${v}`)) return "sub";
  return null;
}

/** `hostMatch` as a predicate, for the callers that only want a boolean. */
export const sameSite = (
  ventureHost: string | null | undefined,
  entityHost: string | null | undefined,
): boolean => hostMatch(ventureHost, entityHost) !== null;

/* ---------------------------------------------------------- ventureForHost */

/**
 * The least a venture has to have for this module to place a host against it.
 * Structural rather than `VentureRow` so nothing here has to import the
 * database, and so a caller holding a trimmed projection can still ask.
 */
export type HostBearing = {
  host?: string | null;
  website?: string | null;
};

/**
 * Which venture owns this host, out of the ones there are.
 *
 * `host` is preferred over `website` because the ventures table's `host` is
 * the normalised column and `website` is whatever the owner typed.
 *
 * TWO RULES ABOUT TIES, both of which cost real data before they were written
 * down:
 *
 *   - AN EXACT MATCH BEATS A SUBDOMAIN MATCH, however the list is ordered.
 *     With `example.com` and `shop.example.com` both registered as ventures, a
 *     row for `shop.example.com` belongs to the second one, not to whichever
 *     of them the roster happened to list first.
 *
 *   - AMONG SUBDOMAIN MATCHES THE LONGEST VENTURE HOST WINS, for the same
 *     reason: `a.shop.example.com` is more `shop.example.com`'s than it is
 *     `example.com`'s.
 *
 * Returns `null` when nothing matches — which is a real answer and not a
 * failure. An unattributed host is a host nobody has claimed yet.
 */
export function ventureForHost<V extends HostBearing>(
  host: string | null | undefined,
  ventures: readonly V[],
): V | null {
  const target = hostOf(host);
  if (!target) return null;
  let best: { venture: V; length: number } | null = null;
  for (const venture of ventures) {
    const vhost = hostOf(venture.host ?? venture.website);
    if (!vhost) continue;
    const relation = hostMatch(vhost, target);
    if (!relation) continue;
    if (relation === "same") return venture;
    if (!best || vhost.length > best.length) best = { venture, length: vhost.length };
  }
  return best?.venture ?? null;
}
