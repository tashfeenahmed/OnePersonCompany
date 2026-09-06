import { createContext, useContext } from "react";
import type {
  BingReport,
  CloudflareReport,
  CloudflareZone,
  Domain,
  DomainSummary,
  GscReport,
  Github,
  MailReport,
} from "@/lib/api";
import type {
  AuditOverview,
  BacklinksReport,
  BlueskyReport,
  CompetitorsReport,
  FleetReport,
  PresenceReport,
  ProductsReport,
  PypiReport,
  UmamiReport,
  UmamiWebsite,
  UptimeReport,
} from "@/lib/api/reports";
import type { LiveData } from "@/lib/live";
import { WIDGETS } from "@/data/widgets";
import { LIVE_BUILDERS } from "@/lib/liveWidgets";

/**
 * A DASHBOARD INSIDE A VENTURE SEES THAT VENTURE'S DATA.
 *
 * The whole point of a venture board is that "impressions" means impressions
 * for one site, not for twenty-three domains. Nothing on the server
 * knows that: /api/gsc answers with every property, /api/cloudflare with every
 * zone, and neither of them has ever heard of a venture. So the narrowing
 * happens here, on rows that are already in hand, against the venture's HOST.
 *
 * THREE RULES, AND THEY ARE WHAT MAKE THIS HONEST RATHER THAN CONVENIENT.
 *
 *   1. A figure is recomputed only where it can be derived from the rows that
 *      survived the filter. Search Console's totals are the sum of its
 *      properties, so they are recomputed; Cloudflare's `daily` line is one
 *      row per day summed across every zone before it reached this browser and
 *      NOTHING here can split it, so it is left alone and the cards that draw
 *      it are marked portfolio-wide instead.
 *   2. A source with no per-site rows at all — Stripe, Hetzner, OpenAI, the
 *      app stores — is portfolio-wide by nature. Those cards keep the whole
 *      picture and say so in their header, because a venture's share of a
 *      Hetzner bill is not a number anybody has.
 *   3. A scopable card with nothing left after the filter draws an honest
 *      empty body. It must NOT fall back to the catalog's sample values: a
 *      sample on the global board is a placeholder, and the same sample under
 *      a venture's name is a claim about that venture.
 *
 * WHAT THE PORTFOLIO CARDS READ IS THE UNSCOPED DATA, which is why the scope
 * carries `base`. A card tagged "portfolio" that drew from the narrowed
 * document would show a filtered figure under a label promising the opposite.
 *
 * A FOURTH RULE ARRIVED WITH THE LINK TABLE: A STATEMENT BEATS A GUESS.
 *
 * `scopeLive(base, hosts, entities)` now takes the venture's LINKS beside its
 * hosts — the rows the owner wrote by pressing something, each one naming an
 * integration and that integration's own identifier for a thing. Where a
 * source has a link for this venture, the filter should use it and stop; the
 * hostname test is what remains for sources with no link, and for the many
 * ventures nobody has linked anything to yet.
 *
 * It matters most where a hostname cannot work at all. A fleet box has no host
 * on it, so "which of these four machines belongs to which venture" is a
 * question ONLY a link can answer. It matters again where a hostname is nearly right and
 * quietly wrong: `acme.ie` and `acme.so` can be two separate businesses, and a repo
 * whose homepage is one of them must not be counted under the other because
 * `mentions()` is a containment test.
 *
 * `linkedTo(entities, plugin)` is the lookup every per-source filter should
 * use. It returns that integration's entity ids, empty when there are none —
 * and empty must mean "fall back to the host", never "narrow to nothing".
 */

/** One row of the venture's link table: an integration, and that integration's
 *  own identifier for the thing — a Cloudflare zone id, `sc-domain:acme.ie`, an
 *  npm package name, an uptime host. Not a hostname; some of them have none. */
export type LinkedEntity = { plugin: string; entity: string };

/** The entity ids this venture has linked from one integration, lowercased for
 *  comparison. Empty means nothing was linked FROM THAT SOURCE, which is not a
 *  statement that nothing belongs to the venture — the caller falls back to the
 *  hostname test rather than narrowing to nothing. */
export function linkedTo(entities: LinkedEntity[], plugin: string): string[] {
  return entities
    .filter((e) => e.plugin === plugin)
    .map((e) => e.entity.trim().toLowerCase())
    .filter(Boolean);
}

/** The venture's hosts, its links, the label to say them by, and the unnarrowed
 *  data the portfolio-wide cards draw from. */
export type LiveScope = {
  /** Lowercase, no leading "www.". Usually one; the shape is a list because
   *  a venture with two domains is a thing that will happen. */
  hosts: string[];
  /** What the owner has said belongs to this venture, across every
   *  integration. Empty on a venture nobody has linked anything to. */
  entities: LinkedEntity[];
  /** How the cards name it — usually its primary hostname. */
  label: string;
  /** The whole portfolio, for the cards that cannot be narrowed. */
  base: LiveData;
};

/* Null outside a venture board, which is every screen but one. The provider
   that fills it lives in `live.tsx` beside the data it narrows; the context
   itself is here so this file can stay free of components — a module that
   exports both is a module fast refresh cannot reload. */
export const ScopeContext = createContext<LiveScope | null>(null);

/** The scope this card is being drawn inside, or null on a global board. */
export function useScope(): LiveScope | null {
  return useContext(ScopeContext);
}

/**
 * The sources that carry per-site rows, and can therefore be narrowed.
 *
 * Everything not in here is portfolio-wide by nature rather than by omission:
 * Stripe's book, a Hetzner bill, an OpenAI spend, an app store's payout and a
 * search-demand feed have no site on them to filter by. Splitting a €61 ad
 * spend across four ventures would need an allocation nobody has written down.
 */
export const SCOPABLE_SOURCES = new Set([
  "gsc",
  "bing",
  "cf",
  "cloudflare",
  "registrars",
  "dynadot",
  "spaceship",
  "github",
  "resend",
  /*
    THE SECOND WAVE. Eight of the nine carry per-row identity and can be
    narrowed; the ninth is CALENDAR and is deliberately absent.

    A calendar has no site on any row and never will. A Tuesday morning belongs
    to the owner, and splitting three hours of calls between two ventures would
    need an attribution nobody has written down — the same reason a Hetzner
    bill and a Stripe book are portfolio-wide. Its cards therefore wear the
    "portfolio" tag inside a venture rather than drawing an empty body, which
    is the honest half of that trade.
  */
  "umami",
  "pypi",
  "bluesky",
  "uptime",
  "fleet",
  "products",
  "backlinks",
  "presence",
  /*
    THE TWO THIS BOX PRODUCES THAT CARRY A VENTURE ON EVERY ROW.

    An audit row IS a venture — it is a crawl of that venture's own website —
    and a competitor profile names the venture whose market it was found in. So
    both narrow exactly, and "3 errors" on a venture board means three errors
    on that site.

    RUNS IS DELIBERATELY ABSENT, and the reason is the queue rather than the
    data. A run has a venture on it and could be filtered by one; what cannot
    be filtered is the fact the cards are actually about — one run executes at
    a time, ACROSS the whole box, so "nothing is running" on a venture board
    would be a lie the moment another venture's paper was being written. The
    queue is a property of the machine, not of a venture, and the cards say
    "portfolio" for the same reason a Hetzner bill does.
  */
  "audit",
  "competitors",
]);

/**
 * Cards from a scopable source whose figure STILL cannot be narrowed.
 *
 * Each one draws something that was summed across sites before it got here and
 * cannot be taken apart again: a daily line, an account-level budget, a
 * follower count. They are marked portfolio-wide and read the unscoped
 * document — which is better than the alternatives, both of which are lies. A
 * scoped label over a portfolio number is one; an empty card where a real
 * measurement exists is the other.
 */
export const PORTFOLIO_WIDGETS = new Set([
  // One row per day, every zone/property/site already summed into it.
  "cf.daily",
  "cf.visitors",
  "gsc.trend",
  "bing.trend",
  // Demand for phrases, measured in a market, not traffic to a site.
  "bing.keywords",
  // GitHub's account-level and traffic-window figures: stars and followers
  // belong to an account, and the traffic line is summed across repos.
  "github.stars",
  "github.followers",
  "github.views",
  "github.clones",
  "github.traffic",
  "github.referrers",
  "github.paths",
  "github.rate",
  // Resend reports sends against the account, not the domain, everywhere but
  // the domain list itself.
  "resend.sends",
  "resend.bounce",
  "resend.daily",
  "resend.outcomes",
  "resend.dns",
]);

/** Whether this card's numbers are narrowed inside a scope, or portfolio-wide
 *  and labelled as such. */
export function isScopedWidget(type: string): boolean {
  const src = WIDGETS[type]?.src;
  return !!src && SCOPABLE_SOURCES.has(src) && !PORTFOLIO_WIDGETS.has(type);
}

/* ------------------------------------------------------------- matching */

/** A hostname the way this file compares them: lowercase, no trailing dot, no
 *  leading "www." — the same normalisation the server does to a venture's
 *  `host`, so the two ends agree without a shared function. */
function host(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** A name that IS one of these hosts, or a subdomain of one. Used for rows
 *  whose field is a bare hostname: a Cloudflare zone, a registered domain, a
 *  Resend sending domain. */
function isHost(name: string | null | undefined, hosts: string[]): boolean {
  if (!name) return false;
  const n = host(name);
  return hosts.some((h) => n === h || n.endsWith(`.${h}`));
}

/** A row whose field is a URL or a Search Console property string —
 *  "sc-domain:example.com", "https://example.com/" — where containment
 *  is the honest test and parsing would only add ways to get it wrong. */
function mentions(value: string | null | undefined, hosts: string[]): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return hosts.some((h) => v.includes(h));
}

const sum = <T,>(rows: T[], pick: (r: T) => number | null | undefined) =>
  rows.reduce((n, r) => n + (pick(r) ?? 0), 0);

/** A percentage change, or null when the base is nothing — the same rule the
 *  server applies, because a property that went from zero to eight impressions
 *  has not improved by infinity. */
function change(now: number, before: number | null): number | null {
  if (!before) return null;
  return Number((((now - before) / before) * 100).toFixed(1));
}

/** An impression-weighted mean rank, or null when nothing was ranked. Google's
 *  own aggregation, reproduced so a scoped position card means what the
 *  portfolio one means. */
function weightedPosition(
  rows: { position: number | null; impressions: number }[],
): number | null {
  const ranked = rows.filter((r) => r.position !== null && r.impressions > 0);
  const weight = sum(ranked, (r) => r.impressions);
  if (!weight) return null;
  return Number(
    (sum(ranked, (r) => (r.position ?? 0) * r.impressions) / weight).toFixed(1),
  );
}

/* ---------------------------------------------------- the narrowed sources */

/**
 * Search Console, narrowed to the properties this venture owns.
 *
 * The totals ARE the sum of the properties — that is how the route builds them
 * — so they are recomputed exactly, including the impression-weighted position
 * and the previous window the deltas are measured against. What is NOT
 * recomputed is `series`: those rows are one per day with every property
 * already added together, and there is no per-property daily line on the wire
 * to rebuild them from. It is emptied rather than left in place, because a
 * portfolio sparkline under a scoped total is the mixed card this whole file
 * exists to avoid; `gsc.trend`, whose entire job is that line, is marked
 * portfolio-wide instead and draws the unscoped one.
 *
 * No matching property at all returns null: the cards then draw their honest
 * empty body rather than a row of zeroes nobody measured.
 */
function scopeGsc(G: GscReport | null, hosts: string[]): GscReport | null {
  if (!G) return null;
  const properties = G.properties.filter(
    (p) => mentions(p.property, hosts) || mentions(p.label, hosts),
  );
  if (!properties.length) return null;

  const names = new Set(properties.map((p) => p.property));
  const clicks = sum(properties, (p) => p.clicks);
  const impressions = sum(properties, (p) => p.impressions);
  const prevClicks = sum(properties, (p) => p.previous.clicks);
  const prevImpressions = sum(properties, (p) => p.previous.impressions);

  const queryImpressions = sum(properties, (p) => p.queryCoverage.impressions);
  const googleImpressions = sum(properties, (p) => p.googleTotal.impressions);

  const reported = properties.filter((p) => p.sitemaps.state === "reported");

  return {
    ...G,
    totals: {
      clicks,
      impressions,
      ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(2)) : null,
      position: weightedPosition(properties),
      /* "Properties with traffic", which is what the route means by this and
         what the card says beside it. */
      properties: properties.filter((p) => p.impressions > 0).length,
    },
    previous: {
      clicks: prevClicks,
      impressions: prevImpressions,
      ctr: prevImpressions
        ? Number(((prevClicks / prevImpressions) * 100).toFixed(2))
        : null,
      position: weightedPosition(
        properties.map((p) => ({
          position: p.previous.position,
          impressions: p.previous.impressions,
        })),
      ),
    },
    delta: {
      impressions: change(impressions, prevImpressions),
      clicks: change(clicks, prevClicks),
      /* Places, not percent, and positive is worse — the route's rule, kept. */
      position: (() => {
        const now = weightedPosition(properties);
        const before = weightedPosition(
          properties.map((p) => ({
            position: p.previous.position,
            impressions: p.previous.impressions,
          })),
        );
        return now !== null && before !== null
          ? Number((now - before).toFixed(1))
          : null;
      })(),
    },
    series: [],
    seriesDays: 0,
    properties,
    queries: G.queries.filter((q) => names.has(q.property)),
    striking: G.striking.filter((q) => names.has(q.property)),
    pages: G.pages.filter((q) => names.has(q.property)),
    coverage: {
      ...G.coverage,
      queryImpressions,
      googleImpressions,
      pct: googleImpressions
        ? Number(((queryImpressions / googleImpressions) * 100).toFixed(1))
        : null,
    },
    sitemaps: {
      properties: reported.length,
      none: properties.filter((p) => p.sitemaps.state === "none").length,
      unreadable: properties.filter((p) => p.sitemaps.state === "failed").length,
      submitted: sum(reported, (p) => p.sitemaps.submitted),
      errors: sum(reported, (p) => p.sitemaps.errors),
      warnings: sum(reported, (p) => p.sitemaps.warnings),
    },
  };
}

/** Bing, narrowed to this venture's verified sites. The index and link figures
 *  are per-site on the wire, so they add back up; the daily series is not, and
 *  is emptied for the reason Search Console's is. */
function scopeBing(B: BingReport | null, hosts: string[]): BingReport | null {
  if (!B) return null;
  const sites = B.sites.filter(
    (s) => mentions(s.site, hosts) || mentions(s.label, hosts),
  );
  if (!sites.length) return null;
  const names = new Set([...sites.map((s) => s.site), ...sites.map((s) => s.label)]);
  const impressions = sum(sites, (s) => s.impressions);
  const clicks = sum(sites, (s) => s.clicks);

  return {
    ...B,
    totals: {
      impressions,
      clicks,
      ctr: impressions ? Number(((clicks / impressions) * 100).toFixed(2)) : null,
      sites: sites.length,
      verified: sites.filter((s) => s.verified === true).length,
    },
    series: [],
    seriesDays: 0,
    sites,
    queries: B.queries.filter((q) => names.has(q.site)),
    index: {
      inIndex: sum(sites, (s) => s.index.inIndex),
      crawledPages: sum(sites, (s) => s.index.crawledPages),
      crawlErrors: sum(sites, (s) => s.index.crawlErrors),
      blockedByRobots: sum(sites, (s) => s.index.blockedByRobots),
      day: B.index.day,
      series: [],
    },
    links: {
      ...B.links,
      inLinks: sum(sites, (s) => s.inLinks),
      namedPages: sum(sites, (s) => s.linkedPages),
      sitesWithNamedLinks: sites.filter((s) => (s.linkedPages ?? 0) > 0).length,
    },
  };
}

/**
 * Cloudflare, narrowed to this venture's zones.
 *
 * The summary is rebuilt from the surviving zones exactly as the route builds
 * it from all of them — including the rules that matter more than the sums: a
 * cache ratio over zero requests is null rather than 0%, one unmeasurable
 * threat count makes the whole total null, and there is never a unique-visitor
 * figure across zones. `daily` is left whole and its two cards are marked
 * portfolio-wide; there is no per-zone daily line on the wire.
 *
 * The alignment lists are filtered by name, which they can be — they are lists
 * OF names, and "which of my domains points somewhere it should not" is
 * exactly the question a venture board should be able to ask.
 */
function scopeCloudflare(
  C: CloudflareReport | null,
  hosts: string[],
): CloudflareReport | null {
  if (!C) return null;
  const zones = C.zones.filter((z) => isHost(z.name, hosts));
  if (!zones.length) return null;

  const measured = zones.filter((z) => z.traffic);
  const traffic = (z: CloudflareZone) => z.traffic!;
  const requests = sum(measured, (z) => traffic(z).requests);
  const cached = sum(measured, (z) => traffic(z).cached);
  const withRecords = zones.filter((z) => z.records !== null);
  const busiest =
    [...measured].sort((a, b) => traffic(b).requests - traffic(a).requests)[0] ??
    null;
  const withEmail = zones.filter((z) => z.email);

  return {
    ...C,
    zones,
    summary: {
      ...C.summary,
      zones: zones.length,
      active: zones.filter((z) => z.status === "active" && !z.paused).length,
      paused: zones.filter((z) => z.paused).length,
      byPlan: zones.reduce<Record<string, number>>((acc, z) => {
        const key = z.plan ?? "not reported";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      withTraffic: measured.length,
      withoutTraffic: zones.length - measured.length,
      requests,
      cached,
      cacheRatio: requests ? Number((cached / requests).toFixed(3)) : null,
      bytes: sum(measured, (z) => traffic(z).bytes),
      /* One zone that could not be asked makes the total unknowable. An
         undercount presented as a count is worse than no count. */
      threats: measured.some((z) => traffic(z).threats === null)
        ? null
        : sum(measured, (z) => traffic(z).threats),
      pageViews: measured.some((z) => traffic(z).pageViews === null)
        ? null
        : sum(measured, (z) => traffic(z).pageViews),
      uniques: null,
      records: withRecords.length ? sum(withRecords, (z) => z.records) : null,
      proxied: withRecords.length ? sum(withRecords, (z) => z.proxied) : null,
      recordsUnreadable: zones.filter((z) => z.records === null).length,
      onPages: zones.filter((z) => z.onPages === true).length,
      busiest: busiest && {
        name: busiest.name,
        requests: traffic(busiest).requests,
      },
      silent: measured.filter((z) => traffic(z).requests === 0).map((z) => z.name),
    },
    email: {
      /* Counted over the zones whose records could be READ, the way the route
         counts them: a zone with an unreadable listing has no mail posture to
         report and putting it in the denominator turns it into a finding. */
      zones: withEmail.length,
      unreadable: zones.length - withEmail.length,
      sending: withEmail.filter((z) => z.email!.mx || z.email!.spf).length,
      mx: withEmail.filter((z) => z.email!.mx).length,
      spf: withEmail.filter((z) => z.email!.spf).length,
      dmarc: withEmail.filter((z) => z.email!.dmarc).length,
      dmarcMonitorOnly: withEmail.filter((z) => z.email!.dmarcPolicy === "none")
        .length,
      dkim: withEmail.filter((z) => z.email!.dkim === true).length,
      dkimMissing: withEmail.filter((z) => z.email!.dkim === false).length,
      dkimUnknown: withEmail.filter((z) => z.email!.dkim === null).length,
    },
    alignment: {
      ...C.alignment,
      zones: zones.length,
      aligned: C.alignment.aligned.filter((n) => isHost(n, hosts)),
      offCloudflare: C.alignment.offCloudflare.filter((z) => isHost(z.name, hosts)),
      elsewhereOnCloudflare: C.alignment.elsewhereOnCloudflare.filter((z) =>
        isHost(z.name, hosts),
      ),
      unknown: C.alignment.unknown.filter((z) => isHost(z.name, hosts)),
      zoneOnly: C.alignment.zoneOnly.filter((n) => isHost(n, hosts)),
      registrarOnly: C.alignment.registrarOnly.filter((d) => isHost(d.name, hosts)),
      claimedTwice: C.alignment.claimedTwice.filter((n) => isHost(n, hosts)),
    },
  };
}

/** The registrar summary, rebuilt from the domains that survived — every
 *  figure on it is a count over the list, including the three-state
 *  auto-renew and lock counts, which are kept apart here exactly as the route
 *  keeps them apart. */
function scopeDomainSummary(
  base: DomainSummary | null,
  domains: Domain[],
): DomainSummary | null {
  if (!base || !domains.length) return null;
  const dated = domains.filter((d) => d.expiresInDays !== null);
  const within = (days: number) =>
    dated.filter((d) => d.expiresInDays! >= 0 && d.expiresInDays! <= days).length;
  const byRegistrar: Record<string, number> = {};
  const byAccount: Record<string, number> = {};
  const byTld: Record<string, number> = {};
  for (const d of domains) {
    byRegistrar[d.registrar] = (byRegistrar[d.registrar] ?? 0) + 1;
    const key = `${d.registrar} · ${d.account}`;
    byAccount[key] = (byAccount[key] ?? 0) + 1;
    const dot = d.name.lastIndexOf(".");
    const tld = dot > 0 ? d.name.slice(dot + 1).toLowerCase() : "";
    if (tld) byTld[tld] = (byTld[tld] ?? 0) + 1;
  }
  const soonest =
    [...dated].sort((a, b) => a.expiresInDays! - b.expiresInDays!)[0] ?? null;

  return {
    ...base,
    total: domains.length,
    byRegistrar,
    byAccount,
    accounts: Object.keys(byAccount).length,
    byTld,
    /* Lapsed is counted here and in none of the windows — a name whose date has
       passed is a different morning from one renewing on Friday. */
    lapsed: dated.filter((d) => d.expiresInDays! < 0).length,
    expiring7: within(base.thresholds.crit),
    expiring30: within(base.thresholds.warn),
    expiring90: within(90),
    autoRenewOff: domains.filter((d) => d.autoRenew === false).length,
    autoRenewUnknown: domains.filter((d) => d.autoRenew === null).length,
    unlocked: domains.filter((d) => d.locked === false).length,
    lockUnknown: domains.filter((d) => d.locked === null).length,
    privacyOff: domains.filter((d) => d.privacy === "off").length,
    withoutExpiry: domains.length - dated.length,
    soonest: soonest && { name: soonest.name, days: soonest.expiresInDays! },
  };
}

/**
 * GitHub, narrowed by the one field a repo carries that names a site: its
 * homepage. There is no other join — a repo is not named after the product it
 * builds often enough to guess from — so a venture whose repos have no
 * homepage set sees no repo cards, which is the truth about what is knowable.
 *
 * `byLanguage` is recomputed because it is nothing but a count over the repos.
 * The rest of the summary is account-level or traffic-window work that cannot
 * be split, and its cards are marked portfolio-wide.
 */
function scopeGithub(G: Github | null, hosts: string[]): Github | null {
  if (!G) return null;
  const repos = G.repos.filter((r) => mentions(r.homepage, hosts));
  if (!repos.length) return null;
  const byLanguage = repos.reduce<Record<string, number>>((acc, r) => {
    if (r.language) acc[r.language] = (acc[r.language] ?? 0) + 1;
    return acc;
  }, {});
  return { ...G, repos, summary: { ...G.summary, byLanguage } };
}

/** Mail: the sending domains that belong to this venture. Everything else in
 *  the document is counted against the account rather than the domain, so it
 *  is left whole and those cards are marked portfolio-wide. */
function scopeMail(M: MailReport | null, hosts: string[]): MailReport | null {
  if (!M) return null;
  return {
    ...M,
    sendingDomains: M.sendingDomains.filter((d) => isHost(d.name, hosts)),
  };
}

/* ------------------------------------------------------------------ scope */

/**
 * The whole live document, narrowed to a venture's hosts.
 *
 * `liveTypes` is REBUILT by re-running the builders over the narrowed inputs
 * rather than copied, and that is what makes the empty cards honest: a widget
 * is "live" exactly when its builder can answer from what is here, so a
 * Search Console card for a venture with no property drops out of the set and
 * the card knows to say so instead of wearing a live dot over a sample.
 *
 * `metrics` is emptied. Every one of those series is a stored count for the
 * whole portfolio — total domains, total stars — with no site on it to filter
 * by, so inside a scope they would be a portfolio sparkline under a narrowed
 * headline. The cards that exist to draw one are portfolio-wide and read the
 * unscoped document.
 */
export function scopeLive(
  base: LiveData,
  hostList: string[],
  /* The venture's LINKS — see the note on `LinkedEntity` above. Threaded in
     here so each per-source filter below can prefer an explicit statement over
     the hostname guess; a filter that has no use for one simply ignores it. */
  entities: LinkedEntity[] = [],
): LiveData {
  const hosts = hostList.map(host).filter(Boolean);
  if (!hosts.length && !entities.length) return base;

  const domains = base.domains.filter((d) => isHost(d.name, hosts));

  const scoped: Omit<LiveData, "liveTypes"> = {
    ...base,
    metrics: {},
    domains,
    domainSummary: scopeDomainSummary(base.domainSummary, domains),
    gsc: scopeGsc(base.gsc, hosts),
    bing: scopeBing(base.bing, hosts),
    cloudflare: scopeCloudflare(base.cloudflare, hosts),
    github: scopeGithub(base.github, hosts),
    mail: scopeMail(base.mail, hosts),
    /*
      THE SECOND WAVE. Each takes the links as well as the hosts, and prefers
      them — see `linkedSet`. Two of the eight take no hosts at all: a Bluesky
      handle that looks like the venture's domain is a coincidence of the
      verification scheme, and an ssh box's hostname is where the machine is
      rather than what it serves.

      CALENDAR IS ABSENT AND STAYS ABSENT. It is not in SCOPABLE_SOURCES either,
      so its cards read `base` and wear the portfolio tag; there is no site on
      an event and splitting a morning between two ventures is an attribution
      nobody has written down.
    */
    umami: scopeUmami(base.umami, hosts, entities),
    pypi: scopePypi(base.pypi, hosts, entities),
    bluesky: scopeBluesky(base.bluesky, entities),
    uptime: scopeUptime(base.uptime, hosts, entities),
    boxes: scopeFleet(base.boxes, entities),
    products: scopeProducts(base.products, hosts, entities),
    backlinks: scopeBacklinks(base.backlinks, hosts, entities),
    presence: scopePresence(base.presence, hosts, entities),
    /* The two this box produces that carry a venture on every row. `runs` is
       absent on purpose and stays whole — see SCOPABLE_SOURCES. */
    audit: scopeAudit(base.audit, hosts),
    /* The AUDIT document goes in beside the hosts, because it is the map: a
       profile names its venture by id and the scope is a set of hosts. See
       `scopeCompetitors`. The UNNARROWED one, so the map is complete however
       few of its rows survived the filter above. */
    competitors: scopeCompetitors(base.competitors, hosts, base.audit),
  };

  const liveTypes = new Set<string>();
  for (const type of Object.keys(WIDGETS)) {
    const build = LIVE_BUILDERS[type];
    if (!build) continue;
    const patch = build({
      points: [],
      summary: scoped.hetzner,
      fleet: scoped.fleet,
      load: scoped.load,
      volumes: scoped.volumes,
      domains: scoped.domains,
      domainSummary: scoped.domainSummary,
      github: scoped.github,
      npm: scoped.npm,
      costs: scoped.costs,
      stock: scoped.stock,
      mobile: scoped.mobile,
      stripe: scoped.stripe,
      adsense: scoped.adsense,
      cloudflare: scoped.cloudflare,
      gsc: scoped.gsc,
      bing: scoped.bing,
      meta: scoped.meta,
      demand: scoped.demand,
      mail: scoped.mail,
      umami: scoped.umami,
      /* Passed unnarrowed on purpose: calendar is portfolio-wide, and the
         builders are asked with it so the cards keep their live dot inside a
         venture rather than reading as a source that stopped answering. */
      calendar: scoped.calendar,
      pypi: scoped.pypi,
      bluesky: scoped.bluesky,
      uptime: scoped.uptime,
      boxes: scoped.boxes,
      products: scoped.products,
      backlinks: scoped.backlinks,
      presence: scoped.presence,
      audit: scoped.audit,
      competitors: scoped.competitors,
      /* Passed unnarrowed, like the calendar above and for the same shape of
         reason: the queue belongs to the box rather than to a venture. */
      runs: scoped.runs,
    });
    if (patch) liveTypes.add(type);
  }

  return { ...scoped, liveTypes };
}

/* ------------------------------------------- the second wave, narrowed */

/**
 * A LINK BEATS A GUESS, EVERY TIME.
 *
 * The eight filters below all take the venture's links as well as its hosts,
 * and the rule is the same in all of them: if the owner has linked ANY entity
 * of this plugin to this venture, that list is the answer and the hostname
 * heuristic is not consulted at all. Not "linked entities plus anything that
 * looks right" — a link is a statement, and a heuristic that keeps adding rows
 * after somebody has said which rows they meant is a heuristic overruling its
 * owner.
 *
 * Only when there is no link for a plugin does the host test run, which is what
 * makes a venture useful before anybody has opened the Connections tab.
 *
 * TWO OF THE EIGHT HAVE NO HEURISTIC AT ALL and fall back to nothing:
 *
 *   BLUESKY, because a handle is a domain and reading it as one is the trap.
 *   `alice.bsky.social` is a name Bluesky issued, and a custom handle like
 *   a venture's own domain is the same string as its host by coincidence of
 *   the verification scheme rather than because the account is the site — so
 *   auto-matching would file a personal account under a business the day
 *   somebody verified a handle with a company domain. The server's own
 *   `/entities` returns `host: null` for exactly this reason.
 *
 *   FLEET, because a box is not a website. Its ssh hostname is where the
 *   machine is reachable, not what it serves, and one box serves twenty
 *   ventures — so matching a venture's host against a box would put a shared
 *   server's memory meter under whichever venture happened to share its name.
 *   The entity is the ACCOUNT ID, which is what survives a rename and a move.
 *
 * NULL AND NOT AN EMPTY SET is the return, and the difference is the whole
 * fallback: an empty set would filter every row away, which is the one reading
 * of "nothing linked" that is certainly wrong. Null means "nobody has said",
 * and the caller then guesses by hostname — or, for the two above, declines to.
 */
function linkedSet(entities: LinkedEntity[], plugin: string): Set<string> | null {
  const mine = linkedTo(entities, plugin);
  return mine.length ? new Set(mine) : null;
}

/** A row's own id, compared the way `linkedTo` hands the linked ones over. */
const sameId = (ids: Set<string>, id: string) => ids.has(id.trim().toLowerCase());

/**
 * Umami, narrowed to this venture's websites.
 *
 * EVERY PORTFOLIO FIGURE IS RECOMPUTED, which this source can do where
 * Cloudflare and Search Console cannot: the per-site daily rows are on the wire
 * beside the totals, so the portfolio's own line is rebuilt by adding the
 * surviving sites' days rather than being emptied. Pageviews, visits, bounces
 * and total time add across sites; the RATES are then computed from those sums
 * rather than averaged, because an average of two percentages weights a site
 * with four visits like one with four thousand.
 *
 * What is not recomputed, because it cannot be and must not be, is a combined
 * visitor count. It is null on the portfolio for the same reason it is null on
 * the whole document, and narrowing does not change the arithmetic.
 */
function scopeUmami(
  U: UmamiReport | null,
  hosts: string[],
  entities: LinkedEntity[],
): UmamiReport | null {
  if (!U) return null;
  const ids = linkedSet(entities, "umami");
  const websites = U.websites.filter((w) =>
    ids ? sameId(ids, w.entity) : isHost(w.domain, hosts) || mentions(w.name, hosts),
  );
  if (!websites.length) return null;

  const withWindow = websites.filter((w) => w.window);
  const pick = (f: (w: UmamiWebsite) => number | null) => {
    const values = withWindow.map(f).filter((v): v is number => v !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const pageviews = pick((w) => w.window!.pageviews);
  const visits = pick((w) => w.window!.visits);
  const bounces = pick((w) => w.window!.bounces);
  const totaltime = pick((w) => w.window!.totaltime);
  const prevPageviews = pick((w) => w.previous?.pageviews ?? null);
  const prevVisits = pick((w) => w.previous?.visits ?? null);

  const perDay = new Map<string, { pageviews: number; sessions: number }>();
  for (const w of websites)
    for (const d of w.days) {
      const held = perDay.get(d.day) ?? { pageviews: 0, sessions: 0 };
      held.pageviews += d.pageviews;
      held.sessions += d.sessions;
      perDay.set(d.day, held);
    }

  const rate = (a: number | null, b: number | null) =>
    a === null || !b ? null : Number(((a / b) * 100).toFixed(1));
  const per = (a: number | null, b: number | null) =>
    a === null || !b ? null : Math.round(a / b);
  const delta = (now: number | null, before: number | null) =>
    now === null || !before ? null : Number((((now - before) / before) * 100).toFixed(1));

  return {
    ...U,
    websites,
    portfolio: {
      ...U.portfolio,
      websites: websites.length,
      answering: withWindow.length,
      days: [...perDay.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, v]) => ({ day, ...v })),
      window: {
        ...U.portfolio.window,
        start: withWindow[0]?.window?.start ?? null,
        end: withWindow[0]?.window?.end ?? null,
        pageviews,
        visits,
        bounces,
        totaltime,
        bounceRate: rate(bounces, visits),
        avgVisitSeconds: per(totaltime, visits),
      },
      previous: { pageviews: prevPageviews, visits: prevVisits },
      deltas: {
        pageviews: delta(pageviews, prevPageviews),
        visits: delta(visits, prevVisits),
      },
      visitors: {
        ...U.portfolio.visitors,
        perSite: U.portfolio.visitors.perSite.filter((s) =>
          websites.some((w) => w.entity === s.entity),
        ),
      },
    },
  };
}

/**
 * PyPI, narrowed by link or by the package's own home page.
 *
 * The host on a package comes from its home page and project URLs with code
 * forges skipped, which is the server's doing and the right call: github.com is
 * where a hundred packages live and is about none of them, so matching on it
 * would file every package under whichever venture happens to own a repo.
 *
 * The weeks and the daily line are rebuilt from the surviving packages, because
 * they are nothing but sums over the per-package days that are already here.
 * `partial` is carried from the whole-portfolio week of the same start, since
 * whether a week is complete is a property of the calendar and not of a filter.
 */
function scopePypi(
  P: PypiReport | null,
  hosts: string[],
  entities: LinkedEntity[],
): PypiReport | null {
  if (!P) return null;
  const ids = linkedSet(entities, "pypi");
  const packages = P.packages.filter((p) =>
    ids ? sameId(ids, p.entity) : isHost(p.host, hosts),
  );
  if (!packages.length) return null;

  const perDay = new Map<string, number>();
  for (const p of packages)
    for (const d of p.days) perDay.set(d.day, (perDay.get(d.day) ?? 0) + d.downloads);
  const days = [...perDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, downloads]) => ({ day, downloads }));

  const partialByStart = new Map(P.weeks.map((w) => [w.start, w.partial]));
  const perWeek = new Map<string, { week: string; downloads: number }>();
  for (const p of packages)
    for (const w of p.weeks) {
      const held = perWeek.get(w.start) ?? { week: w.week, downloads: 0 };
      held.downloads += w.downloads;
      perWeek.set(w.start, held);
    }
  const weeks = [...perWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([start, v]) => ({
      week: v.week,
      start,
      downloads: v.downloads,
      partial: partialByStart.get(start) ?? true,
    }));
  const complete = weeks.filter((w) => !w.partial);

  return {
    ...P,
    packages,
    weeks,
    days,
    summary: {
      ...P.summary,
      configured: packages.length,
      answering: packages.filter((p) => p.days.length && !p.lastError).length,
      failing: packages.filter((p) => p.lastError).length,
      lastCompleteWeek: complete.at(-1) ?? null,
      currentWeek: weeks.at(-1)?.partial ? (weeks.at(-1) ?? null) : null,
      last30: days.slice(-30).reduce((n, d) => n + d.downloads, 0),
      total: days.reduce((n, d) => n + d.downloads, 0),
      byPackage: Object.fromEntries(
        packages.map((p) => [p.package, p.lastCompleteWeek?.downloads ?? 0]),
      ),
      from: days[0]?.day ?? null,
      to: days.at(-1)?.day ?? null,
    },
  };
}

/** Bluesky, narrowed BY LINK ONLY — see `linkedTo` for why a handle that looks
 *  like the venture's domain is not evidence of anything. The portfolio's
 *  addable figures are rebuilt from the surviving handles; the follower count
 *  stays null, because narrowing does not make it addable. */
function scopeBluesky(
  B: BlueskyReport | null,
  entities: LinkedEntity[],
): BlueskyReport | null {
  if (!B) return null;
  const ids = linkedSet(entities, "bluesky");
  if (!ids) return null;
  const handles = B.handles.filter((h) => sameId(ids, h.entity));
  if (!handles.length) return null;

  const w30 = (h: (typeof handles)[number]) => {
    const w = h.windows.find((x) => x.days === 30);
    return w && w.held ? w : null;
  };
  const pick = (f: (w: NonNullable<ReturnType<typeof w30>>) => number) => {
    const values = handles.map(w30).filter((w) => w !== null).map((w) => f(w!));
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };

  return {
    ...B,
    handles,
    portfolio: {
      ...B.portfolio,
      handles: handles.length,
      answering: handles.filter((h) => h.profile.followers !== null).length,
      failing: handles.filter((h) => h.lastError).length,
      followers: {
        ...B.portfolio.followers,
        perHandle: Object.fromEntries(
          handles.map((h) => [h.handle, h.profile.followers]),
        ),
      },
      last30: {
        posts: pick((w) => w.posts),
        likes: pick((w) => w.likes),
        reposts: pick((w) => w.reposts),
        replies: pick((w) => w.replies),
        anyTruncated: handles.some((h) => w30(h)?.truncated === true),
      },
    },
  };
}

/** The uptime probe, narrowed to this venture's hosts. The entity IS the host
 *  string, which makes this the simplest join in the file — and the summary is
 *  a count over the rows, so all of it is recomputed. */
function scopeUptime(
  U: UptimeReport | null,
  hosts: string[],
  entities: LinkedEntity[],
): UptimeReport | null {
  if (!U) return null;
  const ids = linkedSet(entities, "uptime");
  const rows = U.hosts.filter((h) =>
    ids ? sameId(ids, h.host) : isHost(h.host, hosts),
  );
  if (!rows.length) return null;
  const measured = rows.filter((h) => h.current);
  return {
    ...U,
    hosts: rows,
    summary: {
      ...U.summary,
      configured: rows.length,
      up: measured.filter((h) => h.current!.ok).length,
      down: measured.filter((h) => !h.current!.ok).length,
      unknown: rows.length - measured.length,
      soonestTlsExpiry:
        rows
          .map((h) => h.tls.daysLeft)
          .filter((d): d is number => d !== null)
          .sort((a, b) => a - b)[0] ?? null,
      lastCheckedAt:
        rows
          .map((h) => h.current?.ts)
          .filter((t): t is string => !!t)
          .sort()
          .at(-1) ?? null,
    },
  };
}

/**
 * The ssh fleet, narrowed BY LINK ONLY — see `linkedTo`. A box is not a
 * website and its hostname is not a claim about what it serves.
 *
 * Memory is re-added over the surviving boxes because memory is the one figure
 * on this document that adds. Disk and load stay null with their notes intact:
 * they were not addable across the whole fleet and a smaller fleet does not
 * make them addable.
 */
function scopeFleet(
  F: FleetReport | null,
  entities: LinkedEntity[],
): FleetReport | null {
  if (!F) return null;
  const ids = linkedSet(entities, "fleet");
  if (!ids) return null;
  const boxes = F.boxes.filter((b) => sameId(ids, String(b.accountId)));
  if (!boxes.length) return null;
  const answering = boxes.filter((b) => b.sample);
  return {
    ...F,
    boxes,
    totals: {
      ...F.totals,
      boxes: boxes.length,
      answering: answering.length,
      memoryBytes: answering.length
        ? {
            total: sum(answering, (b) => b.sample?.memoryTotal),
            used: sum(answering, (b) => b.sample?.memory?.used),
          }
        : null,
      containers: boxes.reduce((n, b) => n + b.containers.length, 0),
      load: {
        ...F.totals.load,
        boxesOverOnePerCpu: answering.filter((b) => (b.sample?.loadPerCpu ?? 0) > 1)
          .length,
      },
      fullestDisk:
        boxes
          .flatMap((b) =>
            b.disks.map((d) => ({
              box: b.label,
              mount: d.mount,
              percent: d.meter?.percent ?? null,
            })),
          )
          .filter((d) => d.percent !== null)
          .sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0] ?? null,
      seenAt:
        boxes
          .map((b) => b.seenAt)
          .filter((t): t is string => !!t)
          .sort()
          .at(-1) ?? null,
    },
  };
}

/** Product endpoints, narrowed by link or by the URL's own host. The mapping
 *  errors are filtered with them, because an error names the endpoint it came
 *  from and a venture board listing another product's broken path is a board
 *  telling somebody to go and fix something that is not theirs. */
function scopeProducts(
  P: ProductsReport | null,
  hosts: string[],
  entities: LinkedEntity[],
): ProductsReport | null {
  if (!P) return null;
  const ids = linkedSet(entities, "product-stats");
  const endpoints = P.endpoints.filter((e) =>
    ids ? sameId(ids, String(e.accountId)) : mentions(e.url, hosts),
  );
  if (!endpoints.length) return null;
  const labels = new Set(endpoints.map((e) => e.label));
  return {
    ...P,
    endpoints,
    mappingErrors: P.mappingErrors.filter((m) => labels.has(m.endpoint)),
    summary: {
      ...P.summary,
      configured: endpoints.length,
      reachable: endpoints.filter((e) => e.reachable === true).length,
      failing: endpoints.filter((e) => e.reachable === false).length,
      neverCollected: endpoints.filter((e) => e.reachable === null).length,
      metrics: endpoints.reduce((n, e) => n + e.metrics.length, 0),
      lastFetchedAt:
        endpoints
          .map((e) => e.lastFetchedAt)
          .filter((t): t is string => !!t)
          .sort()
          .at(-1) ?? null,
    },
  };
}

/** Backlinks, narrowed to this venture's hosts. The host IS the entity here.
 *  Nothing inside a host row is recomputed, because nothing inside one was ever
 *  summed: every figure belongs to one source and stays with it. */
function scopeBacklinks(
  B: BacklinksReport | null,
  hosts: string[],
  entities: LinkedEntity[],
): BacklinksReport | null {
  if (!B) return null;
  const ids = linkedSet(entities, "backlinks");
  const rows = B.hosts.filter((h) =>
    ids ? sameId(ids, h.host) : isHost(h.host, hosts),
  );
  if (!rows.length) return null;
  return {
    ...B,
    hosts: rows,
    summary: {
      ...B.summary,
      configured: rows.length,
      collected: rows.filter((h) => h.collected).length,
      pending: rows.filter((h) => !h.collected).map((h) => h.host),
      seenAt:
        rows
          .map((h) => h.seenAt)
          .filter((t): t is string => !!t)
          .sort()
          .at(-1) ?? null,
    },
  };
}

/** Presence, narrowed to this venture's products. The entity is the product's
 *  host, so a link and the heuristic agree on the ordinary case and the link
 *  wins on the one that matters: two products on subdomains of one name. */
function scopePresence(
  P: PresenceReport | null,
  hosts: string[],
  entities: LinkedEntity[],
): PresenceReport | null {
  if (!P) return null;
  const ids = linkedSet(entities, "presence");
  const products = P.products.filter((p) =>
    ids ? sameId(ids, p.host) : isHost(p.host, hosts),
  );
  if (!products.length) return null;
  return {
    ...P,
    products,
    summary: {
      ...P.summary,
      configured: products.length,
      checked: products.filter((p) => p.checkedAt).length,
      checkedAt:
        products
          .map((p) => p.checkedAt)
          .filter((t): t is string => !!t)
          .sort()
          .at(-1) ?? null,
    },
  };
}

/* ------------------------------------- the two this box produces, narrowed */

/**
 * The audit overview, narrowed to this venture's own sites.
 *
 * THE SIMPLEST JOIN IN THE FILE: a row IS a venture and carries its host, so
 * there is nothing to recompute and nothing that could be recomputed wrongly.
 * The `note` travels with it unchanged, because what it explains — that a
 * venture with no crawl has no figures rather than clean ones — is as true of
 * one row as of twelve.
 *
 * No matching venture returns null, and the cards then draw their honest empty
 * body. That is the right answer for a venture nobody has ever crawled: the
 * portfolio's error count under its name would be a claim about a site that
 * has never been looked at.
 */
function scopeAudit(A: AuditOverview | null, hosts: string[]): AuditOverview | null {
  if (!A) return null;
  const ventures = A.ventures.filter((v) => isHost(v.host, hosts));
  if (!ventures.length) return null;
  return { ...A, ventures };
}

/**
 * The competitor profiles, narrowed to the venture whose market they were
 * found in.
 *
 * THE ONE FILTER IN THIS FILE THAT NEEDS A THIRD DOCUMENT, and it is worth
 * saying why rather than hiding it in a parameter. A profile names its venture
 * by ID; the scope a board hands its cards is a set of HOSTS and LINKS, and
 * there is no venture id anywhere in it. Every other source here carries a
 * hostname on its own rows and joins directly.
 *
 * THE AUDIT OVERVIEW IS THE MAP. It is a row per venture carrying both the id
 * and the host — for EVERY venture, crawled or not, which is what makes it
 * usable as a lookup rather than as a list of things that happen to have been
 * audited. So the join is exact: hosts → venture ids → profiles. No hostname
 * is matched against a company name and no venture NAME is treated as a
 * domain, which is the guess this would otherwise have to make and would get
 * wrong on `acme.ie` and `acme.so` the first time it ran.
 *
 * WITH NO MAP THERE IS NO NARROWING, and the cards then draw their empty body.
 * Both documents come off the same box in the same load, so one arriving
 * without the other is a state that essentially does not happen — and if it
 * did, "we cannot say which of these are yours" is the honest answer.
 *
 * THE TWO COUNTERS CHANGE MEANING AND SAY SO. On the whole document `runs` is
 * how many sweeps have ever run and `lastRun` is when the last one did —
 * figures about the box, with no venture on them, and there is no way to split
 * them. What CAN be derived from the surviving rows is how many distinct
 * sweeps left a mark on this venture and when one last verified anything of
 * its market, so that is what they become here. It is a smaller claim than the
 * portfolio's and it is the one these rows can actually support.
 */
function scopeCompetitors(
  C: CompetitorsReport | null,
  hosts: string[],
  A: AuditOverview | null,
): CompetitorsReport | null {
  if (!C) return null;
  const ids = new Set(
    (A?.ventures ?? []).filter((v) => isHost(v.host, hosts)).map((v) => v.id),
  );
  if (!ids.size) return null;
  const profiles = C.profiles.filter((p) => ids.has(p.ventureId));
  if (!profiles.length) return null;
  return {
    ...C,
    profiles,
    runs: new Set(profiles.map((p) => p.runId).filter(Boolean)).size,
    lastRun:
      profiles
        .map((p) => p.lastVerified)
        .filter((ts): ts is string => !!ts)
        .sort()
        .at(-1) ?? null,
  };
}
