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
import type { LiveData } from "@/lib/live";
import { WIDGETS } from "@/data/widgets";
import { LIVE_BUILDERS } from "@/lib/liveWidgets";

/**
 * A DASHBOARD INSIDE A VENTURE SEES THAT VENTURE'S DATA.
 *
 * The whole point of a venture board is that "impressions" means impressions
 * for support.example.test, not for twenty-three domains. Nothing on the server
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
 */

/** The venture's hosts, the label to say them by, and the unnarrowed data the
 *  portfolio-wide cards draw from. */
export type LiveScope = {
  /** Lowercase, no leading "www.". Usually one; the shape is a list because
   *  a venture with two domains is a thing that will happen. */
  hosts: string[];
  /** How the cards name it: "support.example.test". */
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
 *  "sc-domain:support.example.test", "https://support.example.test/" — where containment
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
export function scopeLive(base: LiveData, hostList: string[]): LiveData {
  const hosts = hostList.map(host).filter(Boolean);
  if (!hosts.length) return base;

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
    });
    if (patch) liveTypes.add(type);
  }

  return { ...scoped, liveTypes };
}
