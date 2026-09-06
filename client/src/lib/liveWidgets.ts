import type {
  CloudflareAlignment,
  CloudflareReport,
  CloudflareZone,
  CostsReport,
  MobileReport,
  Domain,
  DomainSummary,
  Github,
  Npm,
  HetznerLoad,
  HetznerServer,
  HetznerSummary,
  HetznerVolume,
  LoadPoint,
  ServerLoad,
  StockReport,
  StripeReport,
  AdSenseReport,
  GscReport,
  BingReport,
  MetaReport,
  MetaAdAccount,
  DemandReport,
  MailReport,
  Mailbox,
  MailLabel,
  SendingDomain,
  DemandQuery,
  DemandSignal,
} from "@/lib/api";
import type {
  AgentRun,
  AuditOverview,
  BacklinksReport,
  BlueskyReport,
  CalendarEvent,
  CalendarReport,
  CompetitorsReport,
  FleetBox,
  FleetReport,
  PresenceReport,
  ProductsReport,
  PypiReport,
  RunsReport,
  UmamiReport,
  UmamiWebsite,
  UptimeReport,
} from "@/lib/api/reports";
import type { Meter, RunwayRow, StatusTone, Widget } from "@/data/widgets";
/* EVERY FIGURE ON THESE CARDS IS DRAWN BY `@/lib/format`. A private formatter
   here drifts from the panel showing the same number — 1.5M on this card, 1.5m
   on that one, 1,500,000 on a third — and nothing catches it. The adapters
   below only bridge a calling convention (a percent the server already scaled,
   a currency this box always quotes in); none of them computes a rendering. */
/* RELATIVE, AND WITH THE EXTENSION, unlike the `@/` alias the rest of this
   client uses. `scripts/catalog-check.ts` imports this module under bare node
   to join the widget catalog to its builders, and node resolves the specifier
   itself with no bundler and no tsconfig paths in front of it. Everything else
   this file imports is a type and is stripped; this one is real code. */
import { DASH, ago, bytes, compact, count, duration, inDays, money, pct } from "./format.ts";

/**
 * How each live widget turns collected data into the shape its card draws.
 *
 * One builder per widget id, kept apart from the card so adding a building
 * block is a function here plus a catalog entry — not a new branch inside the
 * renderer. Every builder returns a PARTIAL widget that is merged over the
 * catalog entry, so the sample definition still supplies the name, the kind and
 * the width, and a builder that cannot answer returns null and lets the sample
 * stand rather than inventing a zero.
 */

export type LiveInputs = {
  points: { ts: string; value: number }[];
  summary: HetznerSummary | null;
  fleet: HetznerServer[];
  load: HetznerLoad | null;
  volumes: HetznerVolume[];
  domains: Domain[];
  domainSummary: DomainSummary | null;
  /**
   * The three document-shaped sources: a whole report each, rather than the
   * pre-chewed fields the older inputs above carry.
   *
   * They arrive as PARAMETERS like everything else. They were briefly module
   * state written by the provider before any builder ran — which worked, and
   * was one forgotten call away from a card drawing last refresh's numbers
   * under this refresh's live dot. A builder's inputs are its arguments; a
   * hidden one is a bug waiting for a second writer.
   */
  github: Github | null;
  npm: Npm | null;
  costs: CostsReport | null;
  stock: StockReport | null;
  /** Both app stores in one document — each store's estimate and its payout,
   *  kept apart and never added.
   *
   *  Optional where the others are required, and only because this one arrived
   *  last: a renderer that has not been taught to pass it still compiles, and
   *  every builder below returns null without it — which shows a sample rather
   *  than a wrong number, exactly as an unconnected provider does. */
  mobile?: MobileReport | null;
  /** The Stripe board: the book, the ledger, the attempts and the balance.
   *  Optional the way `mobile` is, so a caller that has not fetched it is a
   *  builder returning null rather than a type error. */
  stripe?: StripeReport | null;
  /** AdSense — including, and especially, its not-authorised state. */
  adsense?: AdSenseReport | null;
  /** Cloudflare: the zones, what they served over complete UTC days, and the
   *  join between the nameservers Cloudflare assigned and the ones each
   *  registrar actually delegates to. Optional the way `mobile` is, so a
   *  renderer that has not been taught to pass it draws samples rather than
   *  failing to compile. */
  cloudflare?: CloudflareReport | null;
  /**
   * The two search engines, as two fields rather than one.
   *
   * There is no `search` object here and there deliberately never will be:
   * Google's impressions and Bing's count different searches by different
   * people on different networks under different anonymisation rules, and one
   * field holding both is one field away from a card that adds them. Only one
   * of the two can answer what people search for that nothing of ours ranks
   * for, which is a different question again.
   */
  gsc?: GscReport | null;
  bing?: BingReport | null;
  /**
   * Meta — the Pages, the ad account, and Instagram.
   *
   * ONE FIELD FOR BOTH SOURCES, which is the opposite of the decision `gsc` and
   * `bing` above take, and for the opposite reason. Those are two engines
   * measuring two populations and one field holding both would be one field
   * away from a card that adds them. Instagram is not a second measurement of
   * anything: it is a FIELD on a Facebook Page, read in the same call with the
   * same token, and a second field here would only be a second thing to forget
   * to pass. Every Instagram card below reads `meta.instagram`.
   */
  meta?: MetaReport | null;
  /**
   * Reddit, Hacker News and the search node — ONE FIELD FOR THREE SOURCES.
   *
   * The same call `meta` makes for Meta and Instagram, and for a stronger
   * reason. Those two share a token; these three share a QUESTION and a
   * failure mode: SearXNG is the tier that answers a Reddit query the Atom
   * feed refuses, so a card about Reddit's fallback and a card about the
   * node's engines are two readings of one fetch. What no builder below does
   * is add an upvote to a Hacker News point — threads add across the sources
   * because a thread is a thread, and nothing else does.
   */
  demand?: DemandReport | null;
  /**
   * Mail — the mailboxes and the sending domains.
   *
   * ONE FIELD FOR TWO SOURCES, which is the `demand` decision rather than the
   * `gsc`/`bing` one — and it passes that test from the other side. Google and
   * Bing are split because one field holding both would be one field away from
   * a card that adds them. Nothing here is that shape: an inbox thread waiting
   * on a reply and a transactional password reset are not the same kind of
   * thing, so no builder below could be tempted to cross them, and a second
   * field would only be a second thing to forget to pass.
   */
  mail?: MailReport | null;

  /*
    THE NINE SECOND-WAVE REPORTS, AS NINE FIELDS.

    No merging this time, and the rule that decided it is the one `gsc`/`bing`
    were split on rather than the one `demand` was joined on: each of these is
    a separate FETCH from a separate collector on a separate schedule, so a
    single field holding two of them would be a field that is half stale for
    half the page. `fleet` and `uptime` are the pair most tempting to fold
    together — both are "is the box well" — and they are the pair it would be
    worst to fold: the probe reaches a host over the public internet and the
    fleet reaches it over ssh, so they disagree about a box behind a broken
    reverse proxy, and that disagreement is a finding rather than a conflict to
    be resolved by a shape.

    Optional, like every field added after the first release, so a caller that
    has not been taught to pass one draws samples rather than failing to
    compile.
  */
  umami?: UmamiReport | null;
  calendar?: CalendarReport | null;
  pypi?: PypiReport | null;
  bluesky?: BlueskyReport | null;
  uptime?: UptimeReport | null;
  /**
   * The ssh fleet. Called `boxes` and not `fleet`, because `fleet` above is
   * already Hetzner's server list and these are not the same set: a Hetzner
   * server this account pays for may have no ssh credential, and half the ssh
   * boxes are somebody else's hardware. One name for two populations is a
   * builder averaging across both within a month.
   */
  boxes?: FleetReport | null;
  products?: ProductsReport | null;
  backlinks?: BacklinksReport | null;
  presence?: PresenceReport | null;

  /*
    THE THREE THIS BOX PRODUCES ITSELF, AND THEY ARE STILL THREE FIELDS.

    Every field above is somebody else's API. These are the audit crawler, the
    run ledger and the competitor profiles those runs accumulated — all three
    of them tables in the same database, read in the same second, and it is
    tempting to hand them over as one object because of it. They stay apart for
    the reason `gsc` and `bing` stay apart: the moment two things share a
    field, something adds them. A run is a piece of work, a crawl is a
    measurement of a website, and a rival is a company — and the only figure
    that could be built across them is a "health score", which is the exact
    number this dashboard refuses to invent.
  */
  audit?: AuditOverview | null;
  runs?: RunsReport | null;
  competitors?: CompetitorsReport | null;
};

/**
 * The two lines every CPU reading on this dashboard is judged against, in one
 * place, because two cards must never disagree about when a box is busy.
 *
 * They apply to a percentage OF THE BOX — the load route divides Hetzner's
 * per-core sum by the core count before anything here sees it, so 90 means
 * ninety percent of the machine whether it has two cores or four.
 */
export const CPU_LIMITS = { warn: 75, crit: 90 } as const;

export function cpuTone(pct: number): StatusTone {
  if (pct >= CPU_LIMITS.crit) return "bad";
  if (pct >= CPU_LIMITS.warn) return "warn";
  return "ok";
}

const eur = (n: number, dp = 2) => money(n, "EUR", { digits: dp });

/** A server's full monthly cost: the plan plus its own primary IPv4, the way
 *  Hetzner bills them — separately. */
const cost = (s: HetznerServer) =>
  (s.monthlyEur ?? 0) + (s.ipv4MonthlyEur ?? 0);

/** Bytes per second at human size. Rates, not totals: the /s is part of the
 *  unit and is never dropped, because "4.2 MB" and "4.2 MB/s" are different
 *  claims and only one of them is what the hypervisor measured. Base 1000
 *  because a network figure is quoted in the decimal units the interface is
 *  sold in, and the lower-case `kB` says so. */
const rate = (bytesPerSecond: number | null): string =>
  bytesPerSecond === null ? DASH : `${bytes(bytesPerSecond, { base: 1000 })}/s`;

/**
 * A PERCENTAGE THE SERVER HAS ALREADY SCALED TO 0–100.
 *
 * Named apart from `@/lib/format`'s `pct`, which takes a 0–1 fraction and is
 * the only convention allowed to travel: three exported functions called `pct`
 * once shared the signature `(number) => string` and disagreed about their
 * input, so an editor's auto-import decided whether a card said 0.4% or 40%.
 * The division happens here, once, in a name that says which convention it
 * takes — never in a second export anybody can reach by accident.
 */
const percent = (n: number | null, dp = 1) =>
  pct(n === null ? null : n / 100, { digits: dp });

/** How long a series actually spans, said in words. A card that draws 24
 *  hours must not be captioned "24h" when the collector has been up for two. */
function span(points: LoadPoint[]): string {
  if (points.length < 2) return "not enough samples yet";
  const ms = Date.parse(points[points.length - 1]!.ts) - Date.parse(points[0]!.ts);
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** Boxes that reported anything at all in the window. A box with no samples is
 *  not a box at 0% — it is a box the metrics endpoint had nothing for. */
const sampled = (load: HetznerLoad | null): ServerLoad[] =>
  (load?.servers ?? []).filter((s) => s.samples > 0);

function months(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - Date.parse(iso)) / (30.44 * 86_400_000);
}

/**
 * "across 2 accounts", or nothing at all when there is only one.
 *
 * A FIGURE THAT QUIETLY BECAME A SUM IS A FIGURE THAT CHANGED MEANING. The
 * moment a second Hetzner project or a second registrar login is connected,
 * every total on these boards is an addition across accounts — and a card that
 * does not say so is inviting the reader to go looking for €63.47 in one
 * console. One account needs no caption, because there is nothing to disclose.
 */
function across(n: number | undefined): string {
  return n && n > 1 ? `across ${n} accounts` : "";
}

/** Two clauses joined only if both exist, so nothing ever reads " · ". */
const also = (a: string, b: string) => [a, b].filter(Boolean).join(" · ");

function age(iso: string | null): string {
  const m = months(iso);
  if (m === null) return "—";
  if (m < 1) return `${Math.max(1, Math.round(m * 30.44))}d`;
  return m < 12 ? `${Math.round(m)}mo` : `${(m / 12).toFixed(1)}y`;
}

/* ------------------------------------------------------------ cloudflare */

/** The PROVIDER a set of nameservers belongs to, not the individual servers:
 *  `hydrogen.ns.hetzner.com` and `oxygen.ns.hetzner.com` are one answer to
 *  "who runs this domain's DNS", and printing both is printing it twice. */
function nsProvider(hosts: string[]): string {
  const providers = new Set(
    hosts.map((h) => h.split(".").slice(-2).join(".") || h),
  );
  return [...providers].join(", ");
}

/**
 * One word for a delegation state, for the table column.
 *
 * FIVE WORDS RATHER THAN A TICK, because three of these are neither yes nor no.
 * "unknown" is a registrar that would not say; "no registrar" is a name held
 * somewhere this dashboard cannot read; "other CF" is delegated to Cloudflare
 * and not to this zone. Collapsing any of them into "no" would report a
 * problem that has not been established.
 */
function delegationWord(state: CloudflareAlignment["state"]): string {
  switch (state) {
    case "aligned":
      return "here";
    case "off-cloudflare":
      return "ELSEWHERE";
    case "elsewhere-on-cloudflare":
      return "other CF";
    case "unknown":
      return "unknown";
    default:
      return "no registrar";
  }
}

export const LIVE_BUILDERS: Record<
  string,
  (d: LiveInputs) => Partial<Widget> | null
> = {
  /* ------------------------------------------------------------ spend */

  "hetzner.spend": ({ points, summary }) => {
    const latest = points.at(-1);
    if (!latest) return null;
    return {
      value: eur(latest.value),
      sub: also("net of VAT", across(summary?.accounts.length)),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  "hetzner.spendSplit": ({ summary }) => {
    if (!summary) return null;
    return {
      rows: [
        ["Servers", eur(summary.serverMonthlyEur)],
        ["Volumes", eur(summary.volumeMonthlyEur)],
        ["Total, net of VAT", eur(summary.monthlyEur)],
      ],
    };
  },

  "hetzner.avgCost": ({ summary }) => {
    if (!summary?.servers) return null;
    return {
      value: eur(summary.monthlyEur / summary.servers),
      sub: also(
        `across ${summary.servers} servers`,
        summary.accounts.length > 1 ? `in ${summary.accounts.length} accounts` : "",
      ),
    };
  },

  "hetzner.ipv4": ({ fleet }) => {
    if (!fleet.length) return null;
    const withIp = fleet.filter((s) => s.ipv4MonthlyEur !== null);
    const total = withIp.reduce((n, s) => n + (s.ipv4MonthlyEur ?? 0), 0);
    return {
      value: eur(total),
      sub: `${withIp.length} primary IPv4, billed apart from the plan`,
    };
  },

  /* ------------------------------------------------------------ fleet */

  "hetzner.servers": ({ summary }) => {
    if (!summary) return null;
    const statuses: [string, StatusTone][] = [
      [`${summary.running} running`, "ok"],
    ];
    const stopped = summary.servers - summary.running;
    if (stopped > 0) statuses.push([`${stopped} not running`, "warn"]);
    if (summary.volumes)
      statuses.push([
        `${summary.volumes} volume${summary.volumes === 1 ? "" : "s"}`,
        "ok",
      ]);
    return { statuses };
  },

  "hetzner.serverCount": ({ points, summary }) => {
    if (!summary) return null;
    return {
      value: String(summary.servers),
      sub: also(`${summary.running} running`, across(summary.accounts.length)),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  "hetzner.fleet": ({ fleet }) => {
    if (!fleet.length) return null;
    // Most expensive first: the question this answers is "what is the money
    // going on", and alphabetical order answers a different one.
    const rows = [...fleet]
      .sort((a, b) => cost(b) - cost(a))
      .slice(0, 8)
      .map((s) => [s.name ?? `#${s.id}`, eur(cost(s))] as [string, string]);
    return { rows };
  },

  "hetzner.specs": ({ fleet }) => {
    if (!fleet.length) return null;
    const rows = [...fleet]
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
      .slice(0, 8)
      .map((s) => [s.name ?? `#${s.id}`, s.specs ?? "—"] as [string, string]);
    return { rows };
  },

  "hetzner.age": ({ fleet }) => {
    if (!fleet.length) return null;
    const rows = [...fleet]
      .filter((s) => s.createdAt)
      .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!))
      .slice(0, 6)
      .map((s) => [s.name ?? `#${s.id}`, age(s.createdAt)] as [string, string]);
    return { rows };
  },

  /* --------------------------------------------------------- grouping */

  "hetzner.byLocation": ({ summary }) => {
    if (!summary) return null;
    const entries = Object.entries(summary.byLocation).sort(
      (a, b) => b[1] - a[1],
    );
    if (!entries.length) return null;
    return {
      bars: entries.map(([, n]) => n),
      labels: entries.map(([k, n]) => `${k} ${n}`).join(" · "),
      // The bars are three pixels apart on a one-column card, so the summary
      // line under them cannot say which is which — the hover has to.
      barLabels: entries.map(
        ([k, n]) => `${k} · ${n} server${n === 1 ? "" : "s"}`,
      ),
    };
  },

  "hetzner.byPlan": ({ fleet }) => {
    if (!fleet.length) return null;
    const byPlan = new Map<string, number>();
    for (const s of fleet) {
      const k = s.plan ?? "?";
      byPlan.set(k, (byPlan.get(k) ?? 0) + cost(s));
    }
    const entries = [...byPlan].sort((a, b) => b[1] - a[1]);
    return {
      bars: entries.map(([, v]) => v),
      labels: entries.map(([k, v]) => `${k} ${eur(v, 0)}`).join(" · "),
      // Two decimals in the hover where the summary line has none: the line is
      // a scale and the hover is the answer, and plan costs are cents.
      barLabels: entries.map(([k, v]) => `${k} · ${eur(v)}/mo`),
    };
  },

  /* ------------------------------------------------------------- load */

  "hetzner.fleetCpu": ({ load }) => {
    const points = load?.fleet.cpu ?? [];
    if (!points.length) return null;
    const values = points.map((p) => p.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const peak = Math.max(...values);
    return {
      value: percent(mean),
      tone: cpuTone(mean),
      sub: `mean over ${span(points)} · peak ${percent(peak, 0)}`,
      // The line under the figure is the fleet's own, so the card shows the
      // shape of the window it is quoting the average of. The timestamps ride
      // along so hovering it can say WHEN the spike was, which is the one
      // thing a mean can never tell you.
      series: values,
      seriesAt: points.map((p) => p.ts),
      unit: "percent",
    };
  },

  "hetzner.busiest": ({ load }) => {
    const boxes = sampled(load).filter((s) => s.cpu.now !== null);
    if (!boxes.length) return null;
    // Highest reading wins outright: every figure here is already a percentage
    // of its own box, so they are directly comparable in a way raw per-core
    // sums are not.
    const top = boxes.reduce((a, b) => ((b.cpu.now ?? 0) > (a.cpu.now ?? 0) ? b : a));
    return {
      value: percent(top.cpu.now),
      tone: cpuTone(top.cpu.now ?? 0),
      sub: `${top.name ?? top.id} · ${top.cores ?? "?"} vCPU, act at ${CPU_LIMITS.crit}%`,
      series: top.cpu.points.map((p) => p.value),
      seriesAt: top.cpu.points.map((p) => p.ts),
      unit: "percent",
    };
  },

  "hetzner.load": ({ load }) => {
    const points = load?.fleet.cpu ?? [];
    if (points.length < 2) return null;
    const boxes = sampled(load).length;
    return {
      chart: [{ label: "Fleet mean CPU", points }],
      unit: "percent",
      caption:
        `mean across the ${boxes} box${boxes === 1 ? "" : "es"} reporting, ` +
        `${span(points)} at fifteen-minute grain — a mean and not a total, ` +
        `because adding percentages of differently sized machines gives a ` +
        `number in no unit`,
    };
  },

  "hetzner.cpuMeters": ({ load }) => {
    const boxes = sampled(load).filter((s) => s.cpu.now !== null);
    if (!boxes.length) return null;
    const meters: Meter[] = [...boxes]
      // Busiest first: a column of meters is scanned from the top, and the one
      // worth seeing is the one nearest its line.
      .sort((a, b) => (b.cpu.now ?? 0) - (a.cpu.now ?? 0))
      .map((s) => ({
        label: s.name ?? `#${s.id}`,
        value: s.cpu.now ?? 0,
        warn: CPU_LIMITS.warn,
        crit: CPU_LIMITS.crit,
        note: `mean ${percent(s.cpu.mean, 0)} · peak ${percent(s.cpu.peak, 0)}`,
      }));
    return { meters };
  },

  "hetzner.figures": ({ load }) => {
    const boxes = load?.servers ?? [];
    if (!boxes.length) return null;
    return {
      headers: ["Box", "CPU now", "Mean", "Peak", "Out/s", "€/mo"],
      table: boxes.map((s) => [
        s.name ?? `#${s.id}`,
        // A box with no samples says so rather than showing a dash that could
        // be read as nought.
        s.samples ? percent(s.cpu.now, 0) : "no data",
        s.samples ? percent(s.cpu.mean, 0) : "—",
        s.samples ? percent(s.cpu.peak, 0) : "—",
        s.samples ? rate(s.netOut.mean) : "—",
        eur(s.monthlyEur),
      ]),
    };
  },

  "hetzner.traffic": ({ load }) => {
    const out = load?.fleet.netOut ?? [];
    const inn = load?.fleet.netIn ?? [];
    if (out.length < 2) return null;
    return {
      chart: [
        { label: "Out", points: out },
        { label: "In", points: inn },
      ],
      unit: "bytes",
      caption: `summed across the fleet, ${span(out)} — bytes a second, which do add up`,
    };
  },

  "hetzner.diskWrite": ({ load }) => {
    const points = load?.fleet.diskWrite ?? [];
    if (points.length < 2) return null;
    return {
      chart: [{ label: "Written", points }],
      unit: "bytes",
      caption: `throughput, not capacity — Hetzner measures the disk from outside the guest, so how FULL it is is not knowable from here`,
    };
  },

  "hetzner.netNow": ({ load }) => {
    const out = load?.fleet.netOut ?? [];
    const inn = load?.fleet.netIn ?? [];
    if (!out.length) return null;
    return {
      value: rate(out[out.length - 1]!.value),
      sub: `out, fleet total · in ${rate(inn[inn.length - 1]?.value ?? null)}`,
      series: out.map((p) => p.value),
      seriesAt: out.map((p) => p.ts),
      // The sparkline is bytes a second, like the figure above it. Without
      // this the hover would print 134582 and let the reader guess.
      unit: "bytes",
    };
  },

  "hetzner.quiet": ({ load }) => {
    const boxes = sampled(load);
    if (!boxes.length) return null;
    /*
      The money question this page cannot ask any other way: which machines are
      being paid for and doing nothing. Five percent of a box averaged over the
      whole window is idle by any reading — a busy box does not average that —
      and they are ordered by what they cost, because that is the size of the
      finding rather than the size of the number.
    */
    const idle = boxes
      .filter((s) => (s.cpu.mean ?? 100) < 5)
      .sort((a, b) => b.monthlyEur - a.monthlyEur);
    if (!idle.length)
      return {
        rows: [[`All ${boxes.length} boxes averaged over 5%`, "—"]] as [string, string][],
      };
    const total = idle.reduce((n, s) => n + s.monthlyEur, 0);
    return {
      rows: [
        ...idle.map(
          (s) =>
            // One decimal, not none: the cut is at five percent, and a box
            // averaging 4.9 rounded to "5%" beside a rule that says "under 5"
            // reads as a bug in the filter.
            [`${s.name ?? s.id} · ${percent(s.cpu.mean)}`, eur(s.monthlyEur)] as [
              string,
              string,
            ],
        ),
        [`${idle.length} idle, together`, eur(total)] as [string, string],
      ],
    };
  },

  "hetzner.volumes": ({ volumes }) => {
    if (!volumes.length) return null;
    return {
      rows: volumes.map(
        (v) =>
          [
            `${v.name ?? v.id} · ${v.sizeGb ?? "?"} GB`,
            `${v.attachedTo ?? "unattached"} · ${eur(v.monthlyEur ?? 0)}`,
          ] as [string, string],
      ),
    };
  },

  "hetzner.arch": ({ fleet }) => {
    if (!fleet.length) return null;
    // ARM is cheaper per core here, so the split is worth seeing rather than
    // buried in the specs string.
    const arm = fleet.filter((s) => s.specs?.includes("ARM")).length;
    const x86 = fleet.length - arm;
    const statuses: [string, StatusTone][] = [];
    if (x86) statuses.push([`${x86} x86`, "ok"]);
    if (arm) statuses.push([`${arm} ARM`, "ok"]);
    const places = Object.keys(
      fleet.reduce<Record<string, true>>((acc, s) => {
        if (s.location) acc[s.location] = true;
        return acc;
      }, {}),
    );
    if (places.length) statuses.push([places.join(", "), "ok"]);
    return { statuses };
  },
};

/* ------------------------------------------------------------- domains */

/**
 * A renewal date in words.
 *
 * "in 92 days" is a distance and "5 Dec" is a date, and a renewal list needs
 * both: the distance is what makes it urgent, the date is what goes in the
 * calendar. Past dates say so in plain words rather than as a negative number
 * with a minus sign that is easy to skim over.
 */
const untilWord = (days: number | null) => inDays(days, { nullText: "no date" });

/** 2026-12-05 → "5 Dec 2026". The registrar's own date, readably. */
function dateWord(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Soonest first, with the undated at the back — a name whose registrar did
 *  not report a date is unknown, not safe, but it cannot be placed on an axis. */
function bySoonest(a: Domain, b: Domain): number {
  if (a.expiresInDays === null) return b.expiresInDays === null ? 0 : 1;
  if (b.expiresInDays === null) return -1;
  return a.expiresInDays - b.expiresInDays;
}

const yesNo = (v: boolean | null, yes: string, no: string) =>
  v === null ? "unknown" : v ? yes : no;

/**
 * How many registrars actually answered, so a partial portfolio says so — and
 * how many ACCOUNTS the count is the sum of, once that is more than one per
 * registrar. "all from Dynadot" is a complete answer for one login and a
 * misleading one for two.
 */
function registrarWord(summary: DomainSummary): string {
  const names = Object.keys(summary.byRegistrar);
  if (!names.length) return "no registrar answered";
  const who = names.length === 1 ? `all from ${names[0]}` : names.join(" and ");
  return summary.accounts > names.length
    ? `${who} · ${summary.accounts} accounts`
    : who;
}

Object.assign(LIVE_BUILDERS, {
  "registrars.total": ({ domainSummary }: LiveInputs) => {
    if (!domainSummary) return null;
    return {
      value: String(domainSummary.total),
      sub: registrarWord(domainSummary),
    };
  },

  "registrars.lapsed": ({ domainSummary }: LiveInputs) => {
    if (!domainSummary) return null;
    const n = domainSummary.lapsed;
    return {
      value: String(n),
      tone: n > 0 ? ("bad" as StatusTone) : ("ok" as StatusTone),
      // Nought is the good answer here and deserves a sentence, not a blank.
      sub: n
        ? "the registrar may still hold these — check today"
        : "nothing has lapsed",
    };
  },

  "registrars.expiring": ({ domainSummary }: LiveInputs) => {
    if (!domainSummary) return null;
    const { expiring30, expiring7, thresholds } = domainSummary;
    return {
      value: String(expiring30),
      tone: expiring7 > 0 ? ("bad" as StatusTone) : expiring30 > 0 ? ("warn" as StatusTone) : ("ok" as StatusTone),
      sub: expiring7
        ? `${expiring7} inside ${thresholds.crit} days`
        : `nothing inside ${thresholds.crit} days`,
    };
  },

  "registrars.autoRenewOff": ({ domainSummary }: LiveInputs) => {
    if (!domainSummary) return null;
    const { autoRenewOff, autoRenewUnknown, total } = domainSummary;
    return {
      value: String(autoRenewOff),
      tone: autoRenewOff > 0 ? ("warn" as StatusTone) : ("ok" as StatusTone),
      /*
        "Off" and "not reported" are kept apart. Folding them together turns a
        list of things to fix into a number too big to act on, and it is the
        difference between a domain that will lapse and a domain nobody can
        vouch for.
      */
      sub:
        `of ${total}` +
        (autoRenewUnknown ? ` · ${autoRenewUnknown} not reported` : ""),
    };
  },

  "registrars.runway": ({ domains, domainSummary }: LiveInputs) => {
    if (!domains.length || !domainSummary) return null;
    const dated = [...domains]
      .filter((d) => d.expiresInDays !== null)
      .sort(bySoonest);
    const LIMIT = 14;
    const rows: RunwayRow[] = dated.slice(0, LIMIT).map((d) => ({
      label: d.name,
      days: d.expiresInDays!,
      sub: `${d.registrar} · ${yesNo(d.autoRenew, "auto-renews", "auto-renew OFF")}`,
      // The date behind the countdown, for the row's hover. Never drawn on the
      // axis: fourteen dates beside fourteen distances is the conversion the
      // chart was built to save.
      at: d.expiresAt,
    }));
    if (!rows.length) return null;

    /*
      A trimmed list says what it left out. Soonest-first means the rows that
      are missing are the furthest away — the least urgent — but a chart that
      quietly shows two thirds of a portfolio is a chart you cannot count off,
      and the full list is one card below.
    */
    const hidden = dated.length - rows.length;
    const undated = domains.length - dated.length;
    const notes = [
      hidden ? `${hidden} further out not drawn` : null,
      undated
        ? `${undated} without a date from the registrar — unknown, not safe`
        : null,
    ].filter(Boolean);

    return {
      runway: rows,
      thresholds: domainSummary.thresholds,
      caption: notes.length
        ? `Soonest ${rows.length} of ${domains.length} · ${notes.join(" · ")}`
        : `All ${rows.length}, soonest first`,
    };
  },

  "registrars.attention": ({ domains }: LiveInputs) => {
    /*
      The one thing a sorted list cannot say: WHY this name is here. A domain
      that lapsed on Tuesday and a domain that renews itself in March look
      identical in a list ordered by date — a sort is a hint, this is a
      sentence.
    */
    if (!domains.length) return null;
    const rows: [string, string][] = [];
    for (const d of [...domains].sort(bySoonest)) {
      const why: string[] = [];
      if (d.expiresInDays !== null && d.expiresInDays < 0) why.push("lapsed");
      else if (d.expiresInDays !== null && d.expiresInDays <= 30)
        why.push(`renews in ${d.expiresInDays}d`);
      if (d.autoRenew === false && (d.expiresInDays ?? 999) <= 120)
        why.push("auto-renew off");
      if (d.locked === false) why.push("not locked");
      if (d.privacy === "off") why.push("no privacy");
      if (d.expiresAt === null) why.push("no expiry reported");
      if (why.length) rows.push([d.name, why.join(" · ")]);
      if (rows.length >= 6) break;
    }
    return {
      rows: rows.length
        ? rows
        : ([["Nothing needs attention", "—"]] as [string, string][]),
    };
  },

  "registrars.table": ({ domains }: LiveInputs) => {
    if (!domains.length) return null;
    return {
      headers: ["Domain", "Registrar", "Expires", "In", "Renew", "Lock"],
      table: [...domains]
        .sort(bySoonest)
        .map((d) => [
          d.name,
          d.registrar,
          dateWord(d.expiresAt),
          untilWord(d.expiresInDays),
          yesNo(d.autoRenew, "auto", "OFF"),
          yesNo(d.locked, "locked", "OPEN"),
        ]),
    };
  },

  "registrars.byRegistrar": ({ domainSummary }: LiveInputs) => {
    if (!domainSummary) return null;
    const entries = Object.entries(domainSummary.byRegistrar).sort(
      (a, b) => b[1] - a[1],
    );
    if (!entries.length) return null;
    return {
      rows: entries.map(([k, n]) => [k, String(n)] as [string, string]),
    };
  },

  "registrars.byTld": ({ domainSummary }: LiveInputs) => {
    if (!domainSummary) return null;
    const entries = Object.entries(domainSummary.byTld)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (!entries.length) return null;
    return {
      bars: entries.map(([, n]) => n),
      labels: entries.map(([k, n]) => `.${k} ${n}`).join(" · "),
      barLabels: entries.map(
        ([k, n]) => `.${k} · ${n} name${n === 1 ? "" : "s"}`,
      ),
    };
  },

  "registrars.security": ({ domainSummary }: LiveInputs) => {
    if (!domainSummary) return null;
    const { total, unlocked, lockUnknown, privacyOff } = domainSummary;
    const statuses: [string, StatusTone][] = [];
    const locked = total - unlocked - lockUnknown;
    if (locked) statuses.push([`${locked} transfer-locked`, "ok"]);
    if (unlocked) statuses.push([`${unlocked} not locked`, "warn"]);
    if (lockUnknown) statuses.push([`${lockUnknown} lock unknown`, "warn"]);
    if (privacyOff) statuses.push([`${privacyOff} without privacy`, "warn"]);
    else statuses.push(["privacy on throughout", "ok"]);
    return { statuses };
  },

  "registrars.nameservers": ({ domains }: LiveInputs) => {
    /*
      Where each name actually delegates, grouped by the provider running it.
      This is the question a registrar list cannot answer and a DNS dashboard
      needs: a name still pointing at its old host is serving records nobody on
      this dashboard is looking at.
    */
    const withNs = domains.filter((d) => d.nameservers?.length);
    if (!withNs.length) return null;
    const byHost = new Map<string, number>();
    for (const d of withNs) {
      const host = d.nameservers![0]!;
      // The provider, not the individual server: brenda.ns.cloudflare.com and
      // mitch.ns.cloudflare.com are one answer, not two.
      const parts = host.split(".");
      const provider = parts.slice(-2).join(".") || host;
      byHost.set(provider, (byHost.get(provider) ?? 0) + 1);
    }
    const rows = [...byHost]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => [k, String(n)] as [string, string]);
    const silent = domains.length - withNs.length;
    if (silent)
      rows.push([`${silent} not reported`, "—"] as [string, string]);
    return { rows };
  },

  "registrars.newest": ({ domains }: LiveInputs) => {
    const dated = domains.filter((d) => d.registeredOn);
    if (!dated.length) return null;
    return {
      rows: dated
        .sort((a, b) => Date.parse(b.registeredOn!) - Date.parse(a.registeredOn!))
        .slice(0, 6)
        .map((d) => [d.name, dateWord(d.registeredOn)] as [string, string]),
    };
  },

  /* --------------------------------------------------- per registrar */

  "dynadot.domains": ({ domains, points }: LiveInputs) => {
    const mine = domains.filter((d) => d.source === "dynadot");
    if (!mine.length) return null;
    const off = mine.filter((d) => d.autoRenew === false).length;
    return {
      value: String(mine.length),
      sub: off ? `${off} without auto-renew` : "all set to auto-renew",
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  "spaceship.domains": ({ domains, points }: LiveInputs) => {
    const mine = domains.filter((d) => d.source === "spaceship");
    if (!mine.length) return null;
    const off = mine.filter((d) => d.autoRenew === false).length;
    return {
      value: String(mine.length),
      sub: off ? `${off} without auto-renew` : "all set to auto-renew",
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  "dynadot.renewals": ({ domains }: LiveInputs) => {
    if (!domains.length) return null;
    return {
      rows: [...domains]
        .filter((d) => d.expiresInDays !== null)
        .sort(bySoonest)
        .slice(0, 6)
        .map((d) => [d.name, dateWord(d.expiresAt)] as [string, string]),
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ------------------------------------------------------- github and npm */

/**
 * TWO DOCUMENTS HELD BESIDE THE INPUTS RATHER THAN INSIDE THEM.
 *
 * Every builder is handed one `LiveInputs`, and the card that renders a widget
 * builds that object itself. Threading two more fetches through it would mean
 * every CPU meter on the servers board carrying a repo list and a package list
 * it will never read. So the GitHub and npm documents are published here, once,
 * before any builder runs — the same arrangement the costs report uses, for the
 * same reason.
 *
 * Null is the ordinary state: the provider is not connected, or the API is not
 * running. Every builder below returns null in that case and the card keeps its
 * placeholder, which is what stops a widget wearing the live dot over a figure
 * nobody measured.
 */

/** A calendar day at midnight UTC, as a chart wants it. The days GitHub and
 *  npm report are days, not instants; this is the one place that decides which
 *  moment of the day they are drawn at. */
const at = (day: string) => `${day}T00:00:00Z`;

/** "owner/name" → "name" when the owner is the account itself, because a
 *  column of the account's own name repeated as a prefix says nothing. The
 *  org-owned rows keep their prefix, which is the case where it means
 *  something. */
function shortRepo(fullName: string, logins: Set<string>): string {
  const [owner, name] = fullName.split("/");
  return owner && name && logins.has(owner) ? name : fullName;
}

const logins = (doc: Github) =>
  new Set(doc.summary.accounts.map((a) => a.login).filter(Boolean) as string[]);

Object.assign(LIVE_BUILDERS, {
  "github.stars": ({ points, github: githubDoc }: LiveInputs) => {
    if (!githubDoc?.summary.repos) return null;
    const s = githubDoc.summary;
    return {
      value: count(s.stars),
      sub: also(
        `${s.public} public repo${s.public === 1 ? "" : "s"}`,
        across(s.accounts.length),
      ),
      // The only history GitHub gives of this is the one this dashboard has
      // been keeping: today's number and nothing else comes back from the API.
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  "github.followers": ({ points, github: githubDoc }: LiveInputs) => {
    const accounts = githubDoc?.summary.accounts.filter((a) => a.followers !== null);
    if (!accounts?.length) return null;
    const total = accounts.reduce((n, a) => n + (a.followers ?? 0), 0);
    return {
      value: count(total),
      sub: accounts.length === 1 ? `@${accounts[0]!.login}` : across(accounts.length),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  "github.views": ({ github: githubDoc }: LiveInputs) => {
    if (!githubDoc?.summary.trafficRepos) return null;
    const s = githubDoc.summary;
    /*
      THE TWO FIGURES ARE NOT THE SAME KIND OF NUMBER and the caption says so.
      Views add up — across days, across repos, always. The uniques beside it
      are GitHub's own per-repo counts ADDED, so somebody who read two repos is
      in there twice; GitHub offers no cross-repo de-duplication at all, so the
      honest options are to say this or not to show it.
    */
    const line = githubDoc.daily.filter((d) => !d.partial);
    return {
      value: count(s.views),
      sub: `${count(s.uniquesSummed)} unique visitors, summed per repo · ${s.trafficDays}d`,
      series: line.length > 1 ? line.map((d) => d.views) : undefined,
      seriesAt: line.length > 1 ? line.map((d) => at(d.day)) : undefined,
    };
  },

  "github.clones": ({ github: githubDoc }: LiveInputs) => {
    if (!githubDoc?.summary.trafficRepos) return null;
    const s = githubDoc.summary;
    const line = githubDoc.daily.filter((d) => !d.partial);
    return {
      value: count(s.clones),
      sub: `${count(s.cloneUniquesSummed)} unique cloners, summed per repo · ${s.trafficDays}d`,
      series: line.length > 1 ? line.map((d) => d.clones) : undefined,
      seriesAt: line.length > 1 ? line.map((d) => at(d.day)) : undefined,
    };
  },

  "github.traffic": ({ github: githubDoc }: LiveInputs) => {
    /*
      THE DAY IN PROGRESS IS LEFT OFF THE LINE. GitHub's traffic aggregation
      lags its own clock — at half past six in the evening, today's bucket on a
      repo taking twelve thousand views a day still read zero. Drawn, that is a
      cliff, and a cliff is the one shape a reader always believes.
    */
    const days = (githubDoc?.daily ?? []).filter((d) => !d.partial);
    if (days.length < 2) return null;
    return {
      chart: [
        { label: "Views", points: days.map((d) => ({ ts: at(d.day), value: d.views })) },
        {
          label: "Unique visitors",
          points: days.map((d) => ({ ts: at(d.day), value: d.uniques })),
        },
      ],
      caption:
        `summed across the ${githubDoc!.summary.trafficRepos} repos with traffic, ` +
        `over the ${days.length} days every one of them was measured — today is ` +
        `left off because GitHub's counts lag its own clock, and so are the odd ` +
        `earlier days it hands back for a quiet repo · uniques are counted per ` +
        `repo per day and do not add up the way views do`,
    };
  },

  "github.referrers": ({ github: githubDoc }: LiveInputs) => {
    const refs = githubDoc?.summary.topReferrers ?? [];
    if (!refs.length) return null;
    return {
      rows: refs
        .slice(0, 8)
        .map((r) => [r.name, count(r.count)] as [string, string]),
    };
  },

  "github.paths": ({ github: githubDoc }: LiveInputs) => {
    const paths = githubDoc?.summary.topPaths ?? [];
    if (!paths.length) return null;
    return {
      rows: paths.slice(0, 6).map((p) => {
        // The title GitHub gives is "Overview" for a repo's front page and the
        // path for everything else — which is exactly backwards for a list
        // spanning several repos, where "Overview" names nothing. So the repo
        // is put back in front of it.
        const where = p.title && p.title !== p.path ? p.title : p.path;
        const repo = p.repo.split("/")[1] ?? p.repo;
        return [`${repo} · ${where}`, count(p.count)] as [string, string];
      }),
    };
  },

  "github.top": ({ github: githubDoc }: LiveInputs) => {
    if (!githubDoc) return null;
    // Current windows only, so this list and the totals above it are of the
    // same set of repos over the same fortnight.
    const withTraffic = githubDoc.repos.filter(
      (r) => r.traffic && !r.traffic.stale && r.traffic.views !== null,
    );
    if (!withTraffic.length) return null;
    const short = logins(githubDoc);
    return {
      rows: withTraffic
        .sort((a, b) => (b.traffic!.views ?? 0) - (a.traffic!.views ?? 0))
        .slice(0, 8)
        .map(
          (r) =>
            [shortRepo(r.fullName, short), count(r.traffic!.views)] as [string, string],
        ),
    };
  },

  "github.repos": ({ github: githubDoc }: LiveInputs) => {
    if (!githubDoc) return null;
    const withTraffic = githubDoc.repos.filter((r) => r.traffic && !r.traffic.stale);
    if (!withTraffic.length) return null;
    const short = logins(githubDoc);
    return {
      headers: ["Repo", "Stars", "Views", "Uniques", "Clones", "Pushed"],
      table: withTraffic
        .sort((a, b) => (b.traffic!.views ?? 0) - (a.traffic!.views ?? 0))
        .map((r) => [
          shortRepo(r.fullName, short),
          count(r.stars),
          count(r.traffic!.views),
          count(r.traffic!.uniques),
          count(r.traffic!.clones),
          ago(r.pushedAt),
        ]),
    };
  },

  "github.languages": ({ github: githubDoc }: LiveInputs) => {
    const by = githubDoc?.summary.byLanguage ?? {};
    const entries = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!entries.length) return null;
    return {
      bars: entries.map(([, n]) => n),
      labels: entries.map(([k, n]) => `${k} ${n}`).join(" · "),
      barLabels: entries.map(
        ([k, n]) => `${k} · ${n} repo${n === 1 ? "" : "s"}`,
      ),
    };
  },

  /* Was "Commits · 14d". The repo listing carries no commit count — that needs
     a call per repo against an endpoint that answers 202 while it computes —
     but it does carry when the last one landed, which is the neighbouring
     question and one this can answer honestly. */
  "github.commits": ({ github: githubDoc }: LiveInputs) => {
    if (!githubDoc) return null;
    const pushed = githubDoc.repos.filter((r) => r.pushedAt);
    if (!pushed.length) return null;
    const short = logins(githubDoc);
    return {
      rows: pushed
        .sort((a, b) => Date.parse(b.pushedAt!) - Date.parse(a.pushedAt!))
        .slice(0, 8)
        .map(
          (r) => [shortRepo(r.fullName, short), ago(r.pushedAt)] as [string, string],
        ),
    };
  },

  /* Was "Open PRs". GitHub's open_issues_count INCLUDES open pull requests and
     nothing in the listing separates them, so the card counts both and says
     both — a mixed number under one of its two names would be a quiet lie. */
  "github.prs": ({ github: githubDoc }: LiveInputs) => {
    if (!githubDoc) return null;
    const open = githubDoc.repos.filter((r) => r.openIssues > 0);
    if (!open.length)
      return {
        rows: [["Nothing open, issues or PRs", "—"]] as [string, string][],
      };
    const short = logins(githubDoc);
    return {
      rows: open
        .sort((a, b) => b.openIssues - a.openIssues)
        .slice(0, 8)
        .map(
          (r) =>
            [shortRepo(r.fullName, short), `${r.openIssues} open`] as [string, string],
        ),
    };
  },

  "github.rate": ({ github: githubDoc }: LiveInputs) => {
    const rate = githubDoc?.summary.rate;
    if (!rate || rate.remaining === null) return null;
    const statuses: [string, StatusTone][] = [];
    /*
      A SPENT BUDGET IS THE THING THIS CARD EXISTS FOR. The first symptom of
      crossing GitHub's ceiling is a dashboard that quietly stops updating, at
      three in the morning, for a reason nothing else on the page can state.
      Past its reset the stored figure describes an hour that is over — the
      budget has refilled — so the number is not quoted at all rather than
      raising an alarm about a limit that no longer applies.
    */
    if (rate.expired) {
      statuses.push([`budget refilled since the last run`, "ok"]);
    } else {
      const left = rate.remaining;
      const limit = rate.limit ?? 0;
      const tone: StatusTone = left < limit * 0.1 ? "bad" : left < limit * 0.25 ? "warn" : "ok";
      statuses.push([`${count(left)} of ${count(limit)} left this hour`, tone]);
    }
    if (rate.requests !== null)
      statuses.push([`${count(rate.requests)} spent by the last run`, "ok"]);
    const s = githubDoc?.summary;
    if (s?.trafficSeenAt)
      statuses.push([
        `traffic read ${ago(s.trafficSeenAt)} for ${s.trafficRepos} of ${s.repos} repos`,
        "ok",
      ]);
    /* A repo that has dropped out of the traffic selection keeps the fortnight
       it was last measured over, and that fortnight is not this one — so it is
       in no total on this board, and this is where the page says so rather than
       leaving the reader to wonder why a repo they remember is missing. */
    if (s?.trafficStale)
      statuses.push([
        `${s.trafficStale} no longer in the traffic selection, left out of the totals`,
        "warn",
      ]);
    return { statuses };
  },

  /* ------------------------------------------------------------- npm */

  "npm.downloads": ({ npm: npmDoc }: LiveInputs) => {
    const s = npmDoc?.summary;
    if (!s?.lastCompleteWeek) return null;
    const weeks = (npmDoc?.weeks ?? []).filter((w) => !w.partial);
    const current = s.currentWeek;
    return {
      value: count(s.lastCompleteWeek.downloads),
      /*
        THE WORD IS LOAD-BEARING. npm counts HTTP tarball fetches: a CI job, a
        Docker rebuild, a mirror and a person are one each and npm cannot tell
        them apart. The week is named because npm's own "last week" is a
        ROLLING seven days ending yesterday and would disagree with this by a
        few percent for no reason anybody could find later.
      */
      sub: also(
        `${s.lastCompleteWeek.week}, downloads not installs`,
        current ? `${count(current.downloads)} so far this week` : "",
      ),
      series: weeks.length > 1 ? weeks.map((w) => w.downloads) : undefined,
      seriesAt: weeks.length > 1 ? weeks.map((w) => at(w.start)) : undefined,
    };
  },

  "npm.last30": ({ npm: npmDoc }: LiveInputs) => {
    const s = npmDoc?.summary;
    if (!s || !s.configured) return null;
    return {
      value: count(s.last30),
      sub: also(
        `${s.answering} of ${s.configured} package${s.configured === 1 ? "" : "s"}`,
        s.failing ? `${s.failing} not answering` : "",
      ),
    };
  },

  "npm.weeks": ({ npm: npmDoc }: LiveInputs) => {
    // Complete weeks only: three days of a week drawn beside seven-day weeks
    // is a collapse in demand that did not happen.
    const weeks = (npmDoc?.weeks ?? []).filter((w) => !w.partial);
    if (weeks.length < 2) return null;
    const current = npmDoc!.summary.currentWeek;
    return {
      chart: [
        {
          label: "Downloads",
          points: weeks.map((w) => ({ ts: at(w.start), value: w.downloads })),
        },
      ],
      caption:
        `ISO weeks, Monday to Sunday, across ${npmDoc!.summary.configured} ` +
        `package${npmDoc!.summary.configured === 1 ? "" : "s"} · downloads are ` +
        `tarball fetches, so CI and mirrors are in here with people` +
        (current
          ? ` · ${current.week} is still running and is not drawn`
          : ""),
    };
  },

  "npm.packages": ({ npm: npmDoc }: LiveInputs) => {
    const byPackage = npmDoc?.summary.byPackage ?? {};
    const entries = Object.entries(byPackage).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return null;
    return {
      rows: entries.map(([k, n]) => [k, count(n)] as [string, string]),
    };
  },

  "npm.table": ({ npm: npmDoc }: LiveInputs) => {
    const packages = npmDoc?.packages ?? [];
    if (!packages.length) return null;
    return {
      headers: ["Package", "Last full week", "30d", "Held", "State"],
      table: packages.map((p) => [
        p.package,
        p.lastCompleteWeek ? count(p.lastCompleteWeek.downloads) : "—",
        count(p.days.slice(-30).reduce((n, d) => n + d.downloads, 0)),
        `${p.days.length}d`,
        // A package npm would not answer for keeps the figures it already has
        // and says why they stopped moving, rather than reading as a quiet week.
        p.lastError ? p.lastError.slice(0, 40) : `ok · ${ago(p.lastOkAt)}`,
      ]),
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* --------------------------------------------------------------- costs */

/**
 * The costs report, held here rather than passed in.
 *
 * Every other input a builder needs is one of a fixed handful the card hands
 * over per call. This one is a single document — three providers' answers in
 * one fetch — read by widgets filed under four different sources, and putting
 * it in the argument list would mean every caller of every builder, including
 * the one drawing a CPU meter, carrying OpenRouter's ledger to do it.
 *
 * There is exactly ONE writer: the provider in live.tsx publishes the document
 * as it arrives, before any builder runs, so what the cards draw and what
 * decided which cards wear the live dot are the same document and not two
 * fetches apart.
 */

/** Dollars. Two places, because that is what an invoice has — and never a
 *  currency symbol chosen by locale: these figures are US dollars whoever is
 *  reading them, and a € in front of an OpenAI bill would be a lie of typography. */
const usd = (n: number, dp = 2) => money(n, "USD", { digits: dp });

/**
 * Seconds as time. Compute is measured in seconds and read in hours: 29,208
 * is arithmetic a reader should not have to do to find out that it is eight
 * hours of machine time.
 */
function hoursMinutes(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "2026-09-03" → "3 Sep". The year is dropped: every date on these cards is
 *  inside the same month-long window, and repeating 2026 twelve times down a
 *  hover column says nothing. */
function dayShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** The vendor prefix dropped for a bar's summary line, kept for its hover.
 *  "google/gemini-3.7-flash" is the name; "gemini-3.7-flash" is what fits. */
const shortModel = (model: string) => model.split("/").at(-1) ?? model;

Object.assign(LIVE_BUILDERS, {
  /* ----------------------------------------------------------- openai */

  "openai.cost": ({ points, costs: COSTS }: LiveInputs) => {
    const o = COSTS?.openai;
    // null is "never collected", which must keep the sample and the missing
    // live dot. A zero here would be a claim about a month nobody has read.
    if (!o || o.usd === null) return null;
    return {
      value: usd(o.usd),
      sub: also(
        `${o.projects.length} project${o.projects.length === 1 ? "" : "s"} · ` +
          `settled to ${dayShort(o.completeThrough)}`,
        across(o.accounts),
      ),
      // The window total over time, from readings — not the daily series. The
      // daily shape is its own card; a sparkline of one and a percentage of
      // the other on one card is two claims wearing each other's label.
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
      seriesAt: points.length > 1 ? points.map((p) => p.ts) : undefined,
    };
  },

  "openai.daily": ({ costs: COSTS }: LiveInputs) => {
    const o = COSTS?.openai;
    if (!o?.days.length) return null;
    const total = o.days.reduce((n, d) => n + d.usd, 0);
    return {
      bars: o.days.map((d) => d.usd),
      labels:
        `${o.days.length} days to ${dayShort(o.days.at(-1)!.day)} · ${usd(total)} · ` +
        `the last bucket lags and is partial`,
      /*
        THE PARTIAL BUCKETS SAY SO, ONE BAR AT A TIME. OpenAI aggregates into
        UTC days and the recent ones take about a day to fill, so the newest
        bar is always short and would otherwise read as a quiet Tuesday. It is
        labelled rather than dropped: the spend is real, it is just not all
        there yet.
      */
      barLabels: o.days.map(
        (d) =>
          `${dayShort(d.day)} · ${usd(d.usd)}` +
          (d.day > o.completeThrough ? " · still settling" : ""),
      ),
    };
  },

  "openai.projects": ({ costs: COSTS }: LiveInputs) => {
    const o = COSTS?.openai;
    if (!o?.projects.length) return null;
    const rows: [string, string][] = o.projects.map((p) => [p.name, usd(p.usd)]);
    /*
      The total is a sum over the SAME rows the day chart sums, which is the
      one thing this API's grouping buys: the two cards agree to the cent by
      construction rather than by both being right.
    */
    rows.push([`Total, ${COSTS!.window.days} days`, usd(o.usd ?? 0)]);
    return { rows };
  },

  /* ------------------------------------------------------- openrouter */

  "openrouter.credits": ({ costs: COSTS }: LiveInputs) => {
    const or = COSTS?.openrouter;
    const c = or?.credits;
    if (!c) return null;

    /*
      HOW LONG THE BALANCE LASTS, AND ON WHAT ASSUMPTION. The rate is the
      activity window's own average — what OpenRouter charged over the last
      thirty days, divided by the days it charged over — and the sentence says
      so, because a runway is a forecast and a forecast without its assumption
      is a guess in a confident font. No activity to average means no runway
      claim at all, not an infinite one.
    */
    const perDay =
      or!.activity.usd !== null && or!.activity.dayCount
        ? or!.activity.usd / or!.activity.dayCount
        : null;
    const daysLeft = perDay && perDay > 0 ? Math.floor(c.balance / perDay) : null;

    return {
      value: usd(c.balance),
      tone:
        daysLeft === null
          ? undefined
          : daysLeft < 7
            ? ("bad" as StatusTone)
            : daysLeft < 21
              ? ("warn" as StatusTone)
              : ("ok" as StatusTone),
      sub: also(
        `left of ${usd(c.purchased)} bought`,
        daysLeft === null
          ? `${usd(c.spentLifetime)} spent, lifetime`
          : `≈${daysLeft}d at the last ${or!.activity.dayCount} days' rate`,
      ),
    };
  },

  "openrouter.spend": ({ points, costs: COSTS }: LiveInputs) => {
    const a = COSTS?.openrouter.activity;
    if (!a || a.usd === null) return null;
    return {
      value: usd(a.usd),
      sub:
        `${a.models.length} models · ${count(a.requests)} requests` +
        // BYOK is inference OpenRouter routed and did NOT bill for. It is
        // named beside the figure rather than added to it.
        (a.byokUsd > 0 ? ` · ${usd(a.byokUsd)} more on your own keys` : ""),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
      seriesAt: points.length > 1 ? points.map((p) => p.ts) : undefined,
    };
  },

  "openrouter.models": ({ costs: COSTS }: LiveInputs) => {
    const a = COSTS?.openrouter.activity;
    if (!a?.models.length) return null;
    // Half a cent, not zero: a model that cost $0.0004 draws a bar nobody can
    // see and hovers as "$0.00", which reads as a bug in a spend chart. The
    // free-tier traffic has its own card, where the zero is the point.
    const top = a.models.filter((m) => m.usd >= 0.005).slice(0, 8);
    if (!top.length) return null;
    return {
      bars: top.map((m) => m.usd),
      labels: top
        .slice(0, 4)
        .map((m) => `${shortModel(m.model)} ${usd(m.usd, 2)}`)
        .join(" · "),
      barLabels: top.map(
        (m) =>
          `${m.model} · ${usd(m.usd)} · ${count(m.requests)} requests · ` +
          `${compact(m.promptTokens)} in, ${compact(m.completionTokens)} out`,
      ),
    };
  },

  "openrouter.keys": ({ costs: COSTS }: LiveInputs) => {
    const k = COSTS?.openrouter.keys;
    if (!k?.list.length) return null;
    const rows: [string, string][] = k.list
      .slice(0, 7)
      .map((key) => [
        key.name + (key.disabled ? " · disabled" : ""),
        usd(key.usd),
      ]);
    /*
      What this sum is a sum OF, said on its own row. It covers the keys that
      still EXIST — a key deleted at OpenRouter takes its spend out of this
      figure and leaves it in the lifetime one — which is exactly why the two
      disagree, and why neither is captioned "spent".
    */
    rows.push([`${k.count} keys that still exist`, usd(k.total)]);
    return { rows };
  },

  "openrouter.totals": ({ costs: COSTS }: LiveInputs) => {
    const or = COSTS?.openrouter;
    if (!or?.credits || or.activity.usd === null) return null;
    /*
      THE CARD THAT EXISTS BECAUSE THE THREE FIGURES DISAGREE. Every one of
      them is true and they measure three different things, so each row is
      labelled with what it is a total of rather than left to be read as three
      attempts at one number.
    */
    return {
      rows: [
        ["Lifetime · every key ever", usd(or.credits.spentLifetime)],
        [`Keys that still exist · ${or.keys.count}`, usd(or.keys.total)],
        [`Activity · last ${or.activity.dayCount} days`, usd(or.activity.usd)],
        ["They do not add up", "three different things"],
      ] as [string, string][],
    };
  },

  "openrouter.free": ({ costs: COSTS }: LiveInputs) => {
    const a = COSTS?.openrouter.activity;
    if (!a?.models.length) return null;
    /*
      THE TRAFFIC THAT COSTS NOTHING — TODAY. Free-tier and preview models are
      priced at zero until they are not, and this account routes most of its
      tokens through them. The card exists because that volume is invisible on
      every spend card by definition, and it is the thing that becomes a bill
      the day a preview ends.
    */
    const free = a.models
      .filter((m) => m.usd === 0 && m.promptTokens > 0)
      .sort((x, y) => y.promptTokens - x.promptTokens);
    if (!free.length) return null;
    const freeTokens = free.reduce((n, m) => n + m.promptTokens, 0);
    const allTokens = a.promptTokens || 1;
    const rows: [string, string][] = free
      .slice(0, 5)
      .map((m) => [
        shortModel(m.model),
        `${compact(m.promptTokens)} tokens · ${count(m.requests)} calls`,
      ]);
    rows.push([
      "Share of all prompt tokens",
      `${Math.round((freeTokens / allTokens) * 100)}% · $0.00`,
    ]);
    return { rows };
  },

  /* -------------------------------------------------------- replicate */

  "replicate.runs": ({ costs: COSTS }: LiveInputs) => {
    const r = COSTS?.replicate;
    if (!r?.runs) return null;
    const rate = r.runs ? (r.failed / r.runs) * 100 : 0;
    return {
      value: count(r.runs),
      tone: rate >= 20 ? ("bad" as StatusTone) : rate >= 5 ? ("warn" as StatusTone) : undefined,
      sub: `${count(r.succeeded)} succeeded · ${count(r.failed)} failed (${Math.round(rate)}%)`,
    };
  },

  "replicate.compute": ({ costs: COSTS }: LiveInputs) => {
    const r = COSTS?.replicate;
    if (!r?.runs) return null;
    return {
      value: hoursMinutes(r.predictSeconds),
      /*
        The whole point of this card, in its own subtitle. Replicate reports
        the time; it publishes no rate anywhere in its API, and the models this
        account runs are billed per output rather than per second in any case.
        So this is compute, and it is not money, and the card says which.
      */
      sub: "predict time · Replicate publishes no rate, so no cost follows",
    };
  },

  "replicate.models": ({ costs: COSTS }: LiveInputs) => {
    const r = COSTS?.replicate;
    if (!r?.models.length) return null;
    const top = r.models.slice(0, 8);
    return {
      bars: top.map((m) => m.seconds),
      labels: top
        .slice(0, 3)
        .map((m) => `${shortModel(m.model)} ${hoursMinutes(m.seconds)}`)
        .join(" · "),
      barLabels: top.map(
        (m) =>
          `${m.model} · ${hoursMinutes(m.seconds)} · ${count(m.runs)} run` +
          `${m.runs === 1 ? "" : "s"}` +
          (m.failed ? `, ${count(m.failed)} failed` : ""),
      ),
    };
  },

  "replicate.outputs": ({ costs: COSTS }: LiveInputs) => {
    const r = COSTS?.replicate;
    if (!r?.runs) return null;
    /*
      What actually came out, in the units the models report. Only the counters
      a model reported are drawn: an image model reports no seconds of video,
      and a zero on that row would read as "made none" rather than "does not
      make those".
    */
    const rows: [string, string][] = [];
    if (r.outputs.images) rows.push(["Images", count(r.outputs.images)]);
    if (r.outputs.videoSeconds)
      rows.push(["Video", hoursMinutes(r.outputs.videoSeconds)]);
    if (r.outputs.tokens) rows.push(["Output tokens", compact(r.outputs.tokens)]);
    rows.push(["Predictions", count(r.runs)]);
    return { rows };
  },

  "replicate.health": ({ costs: COSTS }: LiveInputs) => {
    const r = COSTS?.replicate;
    if (!r?.runs) return null;
    const statuses: [string, StatusTone][] = [
      [`${count(r.succeeded)} succeeded`, "ok"],
    ];
    if (r.failed)
      statuses.push([
        `${count(r.failed)} failed`,
        r.failed / r.runs >= 0.2 ? "bad" : "warn",
      ]);
    /*
      A prediction with no time reported is neither. It never ran, or it had
      not finished when it was read — and counting it as a success or as zero
      seconds would be a claim about a job whose outcome is not known yet.
    */
    if (r.unreported)
      statuses.push([`${count(r.unreported)} without a time`, "warn"]);
    return { statuses };
  },

  "replicate.noCost": ({ costs: COSTS }: LiveInputs) => {
    const r = COSTS?.replicate;
    // A statement about an API nobody has connected is a leaflet, not a
    // reading — it keeps the sample and the dot stays off.
    if (!r?.connected || !r.cannot.asked.length) return null;
    /*
      THE EVIDENCE, NOT THE VERDICT. Each row is a request that was actually
      made and the answer that came back, so a reader can check the claim
      rather than take "Replicate has no billing API" on trust — and so the day
      Replicate ships one, the card that changes is this one.
    */
    const rows: [string, string][] = r.cannot.asked.map((a) => [a.asked, a.answer]);
    rows.push(["Checked", dateWord(r.cannot.checkedOn)]);
    return { rows };
  },

  /* ------------------------------------------------------------ costs */

  "costs.llm": ({ costs: COSTS }: LiveInputs) => {
    if (!COSTS) return null;
    /*
      TWO PROVIDERS ADDED, AND THE THIRD NAMED FOR ITS ABSENCE. OpenAI and
      OpenRouter both report US dollars over the same window, so their sum is
      one currency measuring one thing and is a figure worth having. Replicate
      is NOT in it and the subtitle says so: an "LLM spend" total that quietly
      left out the media bill would be exactly the kind of confident number
      this board exists to not print.
    */
    const parts: { name: string; usd: number }[] = [];
    if (COSTS.openai.usd !== null)
      parts.push({ name: "OpenAI", usd: COSTS.openai.usd });
    if (COSTS.openrouter.activity.usd !== null)
      parts.push({ name: "OpenRouter", usd: COSTS.openrouter.activity.usd });
    if (!parts.length) return null;
    return {
      value: usd(parts.reduce((n, p) => n + p.usd, 0)),
      sub: `${parts.map((p) => p.name).join(" + ")} · Replicate is not in this: it reports no spend`,
    };
  },

  "costs.byProvider": ({ costs: COSTS }: LiveInputs) => {
    if (!COSTS) return null;
    const parts: { name: string; usd: number }[] = [];
    if (COSTS.openai.usd !== null)
      parts.push({ name: "OpenAI", usd: COSTS.openai.usd });
    if (COSTS.openrouter.activity.usd !== null)
      parts.push({ name: "OpenRouter", usd: COSTS.openrouter.activity.usd });
    if (!parts.length) return null;
    return {
      bars: parts.map((p) => p.usd),
      // Hetzner is absent from these bars on purpose: it charges in euro, and
      // a euro bar beside two dollar bars is a comparison of two rulers.
      labels:
        parts.map((p) => `${p.name} ${usd(p.usd, 0)}`).join(" · ") +
        ` · ${COSTS!.window.days} days, USD` +
        (COSTS!.replicate.connected ? " · Replicate reports no spend" : ""),
      barLabels: parts.map((p) => `${p.name} · ${usd(p.usd)}`),
    };
  },

  "costs.sideBySide": ({ summary, costs: COSTS }: LiveInputs) => {
    if (!COSTS) return null;
    /*
      THE CARD THE CURRENCY PROBLEM PRODUCED.

      Everything above is dollars; Hetzner's bill is euro, net of VAT. There is
      no rate on this box and no dated one on this page, so the two are set
      down beside each other with their own units and the last row says plainly
      that no total is offered. Converting silently — at a rate nobody wrote
      down, on a day nobody recorded — would turn four honest figures into one
      confident wrong one.
    */
    const rows: [string, string][] = [];
    /*
      The LLM row names the providers actually in it. With both connected that
      is "LLM APIs"; with one of them missing, a row still called "LLM APIs"
      would quietly present half the bill as all of it.
    */
    const llm: { name: string; usd: number }[] = [];
    if (COSTS.openai.usd !== null)
      llm.push({ name: "OpenAI", usd: COSTS.openai.usd });
    if (COSTS.openrouter.activity.usd !== null)
      llm.push({ name: "OpenRouter", usd: COSTS.openrouter.activity.usd });
    if (llm.length)
      rows.push([
        `${llm.length > 1 ? "LLM APIs" : llm[0]!.name} · ${COSTS.window.days} days`,
        usd(llm.reduce((n, p) => n + p.usd, 0)),
      ]);
    if (COSTS.replicate.runs)
      rows.push([
        `Media · Replicate, ${COSTS.window.days} days`,
        "no price published",
      ]);
    if (summary)
      rows.push([
        `Infrastructure · Hetzner, month`,
        `${eur(summary.monthlyEur)} net of VAT`,
      ]);
    if (!rows.length) return null;
    rows.push(["One total across both", "not offered — two currencies"]);
    return { rows };
  },

  "costs.limits": ({ summary, costs: COSTS }: LiveInputs) => {
    if (!COSTS) return null;
    /*
      WHAT NONE OF THIS ANSWERS, ON THE BOARD RATHER THAN IN A COMMENT. Each
      line is a question a reader will eventually ask of these cards, answered
      before they go looking for a number that is not there — which is the
      difference between a limit and a bug.

      Only the providers actually connected get a line. A limit of an API
      nobody has connected is trivia, and the card would be claiming to have
      read something it has not.
    */
    const rows: [string, string][] = [];
    if (COSTS.openai.connected)
      rows.push(["OpenAI · per-model split", "not in the Costs API"]);
    if (COSTS.openrouter.connected)
      rows.push([
        "OpenRouter · which key, which model",
        "no per-day-per-key figure",
      ]);
    if (COSTS.replicate.connected)
      rows.push(["Replicate · what it cost", "no billing endpoint at all"]);
    if (summary)
      rows.push(["Hetzner · added to the dollars", "no — euro, and no dated rate"]);
    return rows.length ? { rows } : null;
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* -------------------------------------------------------------- stock media */

/**
 * Pexels and Pixabay report ONE thing: how much of a monthly request allowance
 * is left. No spend (both are free at this tier), no usage history (neither
 * keeps one), and nothing on this box records what the video workers actually
 * downloaded — so there is no "clips used" builder below, and its absence is
 * the point rather than an omission.
 */

/** One library's first account, which is the only one these cards draw. A
 *  second key is a second allowance and gets its own row on the meter. */
const library = (stock: StockReport | null, id: string) =>
  stock?.libraries.find((l) => l.library === id) ?? null;

const firstAccount = (stock: StockReport | null, id: string) =>
  library(stock, id)?.accounts[0] ?? null;

/** "resets in 12d" for an allowance whose refill is a date rather than a
 *  countdown. Past-due reads "resets today" — a reset date that has gone by
 *  means the quota is already back, not that it is overdue. */
function untilReset(iso: string | null): string | null {
  const days = iso ? Math.round((Date.parse(iso) - Date.now()) / 86_400_000) : Number.NaN;
  if (Number.isNaN(days)) return null;
  return days <= 0 ? "resets today" : `resets ${inDays(days)}`;
}

/** The allowance card for one library, since both read identically. */
function quotaCard(stock: StockReport | null, id: string): Partial<Widget> | null {
  const acc = firstAccount(stock, id);
  if (!acc || acc.remaining === null) return null;
  const parts = [
    acc.limit === null ? null : `of ${count(acc.limit)}`,
    untilReset(acc.resetsAt),
  ].filter(Boolean);
  return {
    value: count(acc.remaining),
    // Amber once four fifths of the month's allowance is gone — the point at
    // which a pipeline that still has three weeks to run is worth looking at.
    tone:
      acc.usedPct === null
        ? undefined
        : acc.usedPct >= 90
          ? ("bad" as StatusTone)
          : acc.usedPct >= 80
            ? ("warn" as StatusTone)
            : ("ok" as StatusTone),
    sub: parts.join(" · ") || "requests left this month",
    series: acc.points.length > 1 ? acc.points.map((p) => p.value) : undefined,
  };
}

Object.assign(LIVE_BUILDERS, {
  "pexels.quota": ({ stock }: LiveInputs) => quotaCard(stock, "pexels"),
  "pixabay.quota": ({ stock }: LiveInputs) => quotaCard(stock, "pixabay"),

  "pexels.burn": ({ stock }: LiveInputs) => {
    const acc = firstAccount(stock, "pexels");
    if (!acc) return null;
    /*
      A rate needs a window. Two readings six hours apart can differ by the one
      request the collector itself made, and calling that "4 a day" would be
      reporting the observer rather than the workers — so the server returns
      null until the readings span half a day, and this says which it is.
    */
    if (acc.perDay === null)
      return {
        value: "—",
        sub:
          acc.readings <= 1
            ? "one reading so far — a rate needs a second"
            : "not enough history yet to call it a rate",
      };
    return {
      value: count(acc.perDay),
      sub:
        acc.daysLeft === null
          ? `measured over ${acc.readings} readings`
          : `at this rate the allowance lasts ${acc.daysLeft}d`,
    };
  },

  "pexels.meter": ({ stock }: LiveInputs) => {
    const meters: Meter[] = [];
    for (const id of ["pexels", "pixabay"]) {
      for (const acc of library(stock, id)?.accounts ?? []) {
        if (acc.usedPct === null) continue;
        meters.push({
          label: `${id === "pexels" ? "Pexels" : "Pixabay"}${acc.label && acc.label !== "Account 1" ? ` · ${acc.label}` : ""}`,
          value: acc.usedPct,
          warn: 80,
          crit: 90,
          note: `${count(acc.used)} of ${count(acc.limit)}`,
        });
      }
    }
    return meters.length ? { meters } : null;
  },

  "pexels.remaining": ({ stock }: LiveInputs) => {
    const acc = firstAccount(stock, "pexels");
    if (!acc || acc.points.length < 2) return null;
    return {
      chart: [{ label: "Requests left", points: acc.points }],
      // Requests, not a proportion: this line was briefly drawn as "percent",
      // which put "25000%" on the axis for an allowance of 25,000.
      unit: "count",
      caption:
        `sampled every six hours — each reading spends one request from the ` +
        `allowance it reports, which is why it is not read more often`,
    };
  },

  "pexels.limits": ({ stock }: LiveInputs) => {
    if (!stock) return null;
    const rows: [string, string][] = [];
    for (const lib of stock.libraries) {
      const acc = lib.accounts[0];
      if (!lib.connected) {
        rows.push([lib.name, "not connected"]);
        continue;
      }
      // A connected library whose headers said nothing is a real state and is
      // named as such — "not reported" rather than a zero nobody measured.
      rows.push([
        lib.name,
        acc?.remaining === null || acc?.remaining === undefined
          ? "quota not reported"
          : `${count(acc.remaining)} of ${count(acc.limit)}`,
      ]);
    }
    return rows.length ? { rows } : null;
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ------------------------------------------------------------- app stores */

/**
 * Apple and Google, and the one rule every card below keeps.
 *
 * EACH STORE REPORTS TWO KINDS OF MONEY AND THEY ARE NEVER ADDED. Apple's
 * daily sales report carries its own ESTIMATE of developer proceeds and its
 * monthly finance report carries the payout; Google's sales export carries
 * what buyers were charged and its earnings export carries what landed. Every
 * card here says which of the two it is drawing, in its own name where there
 * was room and in its rows where there was not — because "App Store proceeds"
 * on a money board, read as revenue, is a number nobody was ever paid.
 *
 * AND NOTHING IS ADDED ACROSS CURRENCIES. This account took money in nine
 * buyer currencies in one month. Where a card carries more than one, it says
 * so and offers no total — the same last row `costs.sideBySide` carries, for
 * the same reason.
 */

/** The row that closes any card carrying more than one currency. */
function noTotalRow(currencies: unknown[]): [string, string][] {
  return currencies.length > 1
    ? [["One total across the currencies", "not offered — no dated rate"]]
    : [];
}

/** Apple's version vocabulary, in words a person uses. Two vocabularies
 *  actually — appVersionState and the older appStoreState — and both arrive on
 *  the same field, so they are mapped together. */
function whereItIs(state: string | null, onStore: boolean | null): string {
  if (state === null) return onStore ? "on sale" : "state not known";
  const words: Record<string, string> = {
    READY_FOR_SALE: "on sale",
    READY_FOR_DISTRIBUTION: "on sale",
    WAITING_FOR_REVIEW: "waiting for review",
    IN_REVIEW: "in review",
    PENDING_DEVELOPER_RELEASE: "approved, not released",
    PENDING_APPLE_RELEASE: "approved, awaiting Apple",
    PREPARE_FOR_SUBMISSION: "not submitted",
    READY_FOR_REVIEW: "ready to submit",
    PROCESSING_FOR_DISTRIBUTION: "processing",
    REJECTED: "rejected",
    DEVELOPER_REJECTED: "withdrawn",
    METADATA_REJECTED: "metadata rejected",
    INVALID_BINARY: "invalid binary",
  };
  return words[state] ?? state.toLowerCase().replace(/_/g, " ");
}

/** A package id with its reverse-domain prefix dropped, which is the half that
 *  identifies the app: `com.acme.BetIndex` becomes `acme.BetIndex` and
 *  `co.acme.app` becomes `acme.app`. Only the FIRST segment goes — taking the
 *  last one instead collapses `co.acme.app` and `com.acme.android` to "app"
 *  and "android", which name nothing. */
const shortPackage = (pkg: string) =>
  /^(com|co|io|net|org|dev|app)\./.test(pkg) ? pkg.slice(pkg.indexOf(".") + 1) : pkg;

/** "5 Aug – 21 Aug", the span a card is actually drawn over — which is not
 *  always the window that was asked for. Google's install export stops when
 *  Google stops writing it, and a card captioned "30d" over seventeen days is
 *  a card that has quietly changed meaning. */
function spanOf(from: string | null, to: string | null): string {
  if (!from || !to) return "no days reported yet";
  return from === to ? dayShort(from) : `${dayShort(from)} – ${dayShort(to)}`;
}

Object.assign(LIVE_BUILDERS, {
  /* ----------------------------------------------------- app store connect */

  "appstore.installs": ({ points, mobile: M }: LiveInputs) => {
    const a = M?.appstore;
    if (!a?.connected || !a.downloads.days.length) return null;
    const d = a.downloads;
    return {
      value: count(d.units),
      /*
        THE DAYS APPLE ANSWERED, NOT THE DAYS ASKED FOR. A window is only as
        long as the reports in it, and a day Apple has not generated yet is
        named separately so a figure that is short can say why rather than
        reading as a quiet week.
      */
      sub: also(
        `first-time downloads · ${spanOf(d.from, d.to)}` +
          (d.daysAbsent ? ` · ${d.daysAbsent} day(s) not generated yet` : ""),
        across(a.accounts),
      ),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
      seriesAt: points.length > 1 ? points.map((p) => p.ts) : undefined,
    };
  },

  "appstore.daily": ({ mobile: M }: LiveInputs) => {
    const a = M?.appstore;
    if (!a?.downloads.days.length) return null;
    const d = a.downloads;
    return {
      chart: [
        {
          label: "Downloads",
          points: d.days.map((x) => ({ ts: at(x.day), value: x.downloads })),
        },
      ],
      unit: "count" as const,
      caption:
        `${d.daysZero} of these days Apple reported no sales at all, which is a zero and is drawn` +
        (d.daysAbsent
          ? ` · ${d.daysAbsent} day(s) Apple has not generated are left out rather than drawn as zero`
          : ""),
    };
  },

  "appstore.proceeds": ({ mobile: M }: LiveInputs) => {
    const a = M?.appstore;
    if (!a?.connected || !a.downloads.days.length) return null;
    const rows: [string, string][] = a.estimated.currencies.map((c) => [
      c.currency,
      money(c.amount, c.currency),
    ]);
    /*
      NO ROWS IS A MEASUREMENT HERE, NOT AN ABSENCE. Apple reported these days
      and every unit in them was a free download — which is a different fact
      from "no report arrived", and the card says which one it is.
    */
    if (!rows.length)
      rows.push(["No paid units in the window", "every unit was a free download"]);
    rows.push(...noTotalRow(a.estimated.currencies));
    rows.push(["This is not the payout", "Apple's own estimate, before settlement"]);
    return { rows };
  },

  "appstore.payout": ({ mobile: M }: LiveInputs) => {
    const a = M?.appstore;
    if (!a?.connected) return null;
    const rows: [string, string][] = [];
    for (const m of a.payout.months)
      for (const c of m.currencies)
        rows.push([`${m.month} · ${c.currency}`, money(c.amount, c.currency)]);

    if (!rows.length) {
      /*
        AND THIS IS WHY IT IS NOT A ZERO. Apple's finance endpoint answers the
        same 404 for a month that settled, the month still running and a month
        in the future — so "no report" is the whole of what can be read, and a
        payout card showing $0.00 would be inventing the half Apple withheld.
      */
      rows.push([`Months asked for`, String(a.payout.monthsAsked)]);
      rows.push(["Financial reports issued", "none"]);
      rows.push([
        "Read that as zero?",
        "no — the same 404 covers a settled month and one in the future",
      ]);
      return { rows };
    }
    rows.push(...noTotalRow(a.payout.currencies));
    return { rows };
  },

  "appstore.rating": ({ mobile: M }: LiveInputs) => {
    const a = M?.appstore;
    if (!a?.connected || !a.apps.length) return null;
    const listed = a.apps.filter((x) => x.listed === true).length;
    if (a.rating.average === null)
      return {
        // Zero stars is not the average of no ratings, so the figure is a dash
        // and the sentence beside it is the finding.
        value: "—",
        sub: `no ratings yet · ${listed} app${listed === 1 ? "" : "s"} on the store`,
      };
    return {
      value: a.rating.average.toFixed(1),
      sub: `${count(a.rating.ratings)} rating${a.rating.ratings === 1 ? "" : "s"} across ${a.rating.apps} app${a.rating.apps === 1 ? "" : "s"} · from the public listing`,
    };
  },

  "appstore.store": ({ mobile: M }: LiveInputs) => {
    const a = M?.appstore;
    if (!a?.apps.length) return null;
    /*
      THE FINDING THE MONEY CANNOT EXPRESS. Four of the six apps on this
      account are not on sale, and "no proceeds" on a card beside them would
      read as a market verdict about apps nobody could buy.
    */
    const statuses: [string, StatusTone][] = a.apps.map((app) => [
      `${app.name ?? app.bundleId} · ${whereItIs(app.state, app.onStore)}`,
      app.onStore
        ? ("ok" as StatusTone)
        : app.state?.includes("REJECT") || app.state === "INVALID_BINARY"
          ? ("bad" as StatusTone)
          : ("warn" as StatusTone),
    ]);
    return { statuses };
  },

  "appstore.apps": ({ mobile: M }: LiveInputs) => {
    const a = M?.appstore;
    if (!a?.apps.length) return null;
    return {
      table: a.apps.map((app) => [
        app.name ?? app.bundleId ?? app.id,
        whereItIs(app.state, app.onStore),
        count(app.downloads),
        count(app.updates),
        app.rating === null
          ? app.listed === false
            ? "not listed"
            : "no ratings"
          : `${app.rating.toFixed(1)} (${count(app.ratingCount ?? 0)})`,
      ]),
    };
  },

  "appstore.limits": ({ mobile: M }: LiveInputs) => {
    const a = M?.appstore;
    if (!a?.connected) return null;
    return { rows: a.cannot.map((c) => [c.asked, c.answer] as [string, string]) };
  },

  /* ---------------------------------------------------------- google play */

  "play.installs": ({ points, mobile: M }: LiveInputs) => {
    const p = M?.play;
    if (!p?.connected || !p.installs.days.length) return null;
    return {
      value: count(p.installs.installs),
      /*
        DEVICE INSTALLS, AND THE SPAN GOOGLE ACTUALLY WROTE. The console's
        export stops when Google stops writing it — on this account it ends
        weeks before today — so the caption is the real range rather than the
        window that was asked for.
      */
      sub: also(
        `device installs · ${spanOf(p.installs.from, p.installs.to)} · ${p.packages.length} package${p.packages.length === 1 ? "" : "s"}`,
        across(p.accounts),
      ),
      series: points.length > 1 ? points.map((x) => x.value) : undefined,
      seriesAt: points.length > 1 ? points.map((x) => x.ts) : undefined,
    };
  },

  "play.daily": ({ mobile: M }: LiveInputs) => {
    const p = M?.play;
    if (!p?.installs.days.length) return null;
    return {
      chart: [
        {
          label: "Installs",
          points: p.installs.days.map((d) => ({ ts: at(d.day), value: d.installs })),
        },
      ],
      unit: "count" as const,
      caption: `device installs across ${p.packages.length} package${p.packages.length === 1 ? "" : "s"} · ${spanOf(p.installs.from, p.installs.to)}, which is as far as Google's export goes`,
    };
  },

  "play.revenue": ({ mobile: M }: LiveInputs) => {
    const p = M?.play;
    if (!p?.connected) return null;
    if (!p.payout.currencies.length) {
      if (!p.estimated.months.length) return null;
      return {
        rows: [
          ["No settled month yet", "Google writes the earnings export once a month closes"],
        ] as [string, string][],
      };
    }
    /*
      A ROW PER MONTH, and a total across them only when there is more than one
      month to add. With a single settled month the two lines would be the same
      figure under two labels, which reads as two payments.
    */
    const rows: [string, string][] = [];
    for (const m of p.payout.months)
      for (const c of m.currencies)
        rows.push([`${m.month} · ${c.currency}`, money(c.net, c.currency)]);
    if (p.payout.months.length > 1)
      for (const c of p.payout.currencies)
        rows.push([`${c.currency} · all ${p.payout.months.length} settled months`, money(c.amount, c.currency)]);
    rows.push(...noTotalRow(p.payout.currencies));
    return { rows };
  },

  "play.split": ({ mobile: M }: LiveInputs) => {
    const p = M?.play;
    const latest = p?.payout.months.at(-1);
    if (!latest?.currencies.length) return null;
    const rows: [string, string][] = [];
    for (const c of latest.currencies) {
      rows.push([`Charged · ${latest.month}`, money(c.charged, c.currency)]);
      if (c.refunds) rows.push(["Refunded", money(c.refunds, c.currency)]);
      /*
        GOOGLE'S FEE IS A ROW IN THE EXPORT, NOT A RATE APPLIED TO A TOTAL.
        The percentage beside it is arithmetic on two measured figures rather
        than the 15% or 30% a reader might assume — this account's mix of
        subscription tiers lands between them.
      */
      rows.push([
        "Google's fee",
        `${money(c.fees, c.currency)}${c.charged ? ` · ${Math.abs((c.fees / c.charged) * 100).toFixed(1)}%` : ""}`,
      ]);
      rows.push(["Net, and paid out", money(c.net, c.currency)]);
    }
    return { rows };
  },

  "play.charged": ({ mobile: M }: LiveInputs) => {
    const p = M?.play;
    if (!p?.connected) return null;
    /*
      THE MONTH THAT HAS NO PAYOUT YET. Google writes the earnings export only
      once a month has closed, so this is the only figure that exists for the
      one still running — and it is what BUYERS were charged, tax included and
      before Google's cut, which is not what will land.
    */
    const running = p.estimated.months.filter((m) => !m.settled);
    if (!running.length) return null;
    const rows: [string, string][] = [];
    for (const m of running)
      for (const c of m.currencies)
        rows.push([`${m.month} · ${c.currency}`, money(c.amount, c.currency)]);
    if (!rows.length) return null;
    rows.push([
      "What will land",
      "less — this is gross of tax and Google's fee, and unsettled",
    ]);
    return { rows };
  },

  "play.rating": ({ mobile: M }: LiveInputs) => {
    const p = M?.play;
    if (!p?.connected || !p.packages.length) return null;
    if (p.rating.average === null)
      return { value: "—", sub: `no package has a rating in the export yet` };
    return {
      value: p.rating.average.toFixed(1),
      /*
        NO COUNT, AND SO NO WEIGHTING. This era's export carries the running
        average and not the number of ratings behind it, so an average across
        packages cannot be weighted — the card says how many packages are in it
        rather than implying a population.
      */
      sub: `${p.rating.packages} package${p.rating.packages === 1 ? " reports" : "s report"} one · as of ${p.rating.at ? dayShort(p.rating.at) : "—"} · the export carries no rating count`,
    };
  },

  "play.apps": ({ mobile: M }: LiveInputs) => {
    const p = M?.play;
    if (!p?.packages.length) return null;
    return {
      table: p.packages.map((pkg) => [
        shortPackage(pkg.package),
        count(pkg.installs),
        // Active devices is a current state and is dated for that reason.
        pkg.activeDevices === null ? "—" : count(pkg.activeDevices),
        pkg.rating === null ? "—" : pkg.rating.toFixed(1),
        pkg.payout.length
          ? pkg.payout.map((c) => money(c.amount, c.currency)).join(" · ")
          : "—",
      ]),
    };
  },

  "play.limits": ({ mobile: M }: LiveInputs) => {
    const p = M?.play;
    if (!p?.connected) return null;
    return { rows: p.cannot.map((c) => [c.asked, c.answer] as [string, string]) };
  },

  /* ------------------------------------------------------------ both stores */

  "mobile.sideBySide": ({ mobile: M }: LiveInputs) => {
    if (!M) return null;
    const rows: [string, string][] = [];

    /*
      FOUR FIGURES THAT LOOK LIKE ONE AND ARE NOT. Two stores, and within each
      an estimate and a payout — so the rows are labelled by store AND by which
      of the two they are, and the card closes on the sentence that stops the
      reader adding them.
    */
    if (M.appstore.connected) {
      if (M.appstore.payout.currencies.length)
        for (const c of M.appstore.payout.currencies)
          rows.push(["App Store · payout", money(c.amount, c.currency)]);
      else rows.push(["App Store · payout", "no financial report issued"]);
      rows.push([
        "App Store · estimated proceeds",
        M.appstore.estimated.currencies.length
          ? M.appstore.estimated.currencies
              .map((c) => money(c.amount, c.currency))
              .join(" · ")
          : "no paid units in the window",
      ]);
    }

    if (M.play.connected) {
      const latest = M.play.payout.months.at(-1);
      rows.push([
        `Play · payout${latest ? `, ${latest.month}` : ""}`,
        latest
          ? latest.currencies.map((c) => money(c.net, c.currency)).join(" · ")
          : "no settled month yet",
      ]);
      const running = M.play.estimated.months.filter((m) => !m.settled);
      const charged = running.flatMap((m) => m.currencies);
      if (running.length)
        rows.push([
          `Play · charged to buyers, ${running.map((m) => m.month).join(", ")}`,
          /* Up to three currencies fit as amounts; nine — which is what one
             month of this account looks like — do not, and a row that tried
             would be unreadable rather than informative. */
          charged.length <= 3
            ? charged.map((c) => money(c.amount, c.currency)).join(" · ") || "no orders yet"
            : `${charged.length} currencies, unsettled`,
        ]);
    }

    if (!rows.length) return null;
    rows.push([
      "One total across both stores",
      `not offered — ${M.currency.seen.length} currencies, and an estimate is not a payout`,
    ]);
    return { rows };
  },

  "mobile.presence": ({ mobile: M }: LiveInputs) => {
    /*
      ONLY APPLE ANSWERS THIS QUESTION, so the card needs Apple to be
      connected and returns nothing without it. Google's report bucket says
      which packages it has written statistics for, which is not the same
      question as whether a listing is published — counting those as "on sale"
      would be claiming a store state Google never sent. Play's side is named
      beside the figure for what it actually is.
    */
    const a = M?.appstore;
    if (!a?.apps.length) return null;
    const p = M!.play;
    return {
      value: `${a.store.live} of ${a.apps.length}`,
      sub: [
        "on the App Store",
        p.packages.length
          ? `${p.packages.length} package${p.packages.length === 1 ? "" : "s"} have Play data, which does not say whether they are published`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* --------------------------------------------------------------- revenue */

/**
 * Stripe and AdSense: what came in, and what is contracted to keep coming in.
 *
 * NOTHING BELOW ADDS THE TWO. Stripe measures settled card money; AdSense
 * measures an ad network's own estimate of what a day earned, revised for days
 * afterwards. There is no builder here that reads both, and there is no card
 * with a figure spanning them — the same rule the costs board keeps between
 * euro and dollars, for a stronger reason: these are not the same kind of
 * number at all.
 *
 * EVERY MONEY FIGURE ON THE WIRE IS A LIST KEYED BY CURRENCY, so every builder
 * takes the FIRST row and names its currency rather than summing the list. A
 * second currency then shows up as a card that says "usd" beside a figure that
 * is only the dollar half — which is visible and wrong in a way somebody will
 * fix, rather than invisible and wrong in a way nobody can see.
 */

/** One row of a per-currency list, or null. Named rather than inlined because
 *  eight builders make the same move and they must make it identically. */
function firstCurrency<T extends { currency: string }>(rows: T[] | null | undefined) {
  return rows && rows.length ? rows[0]! : null;
}

/** Money in the currency the row says it is in, rather than in a symbol
 *  hardcoded here. An account that starts billing in euro should read as euro
 *  on the card the day it does. */
const inCurrency = (n: number, currency: string, dp = 2) =>
  money(n, currency, { digits: dp });

/** The churn row for one window, in the first currency. */
const churnRow = (s: StripeReport | null | undefined, days: number) =>
  s?.churn.find((r) => r.days === days) ?? null;

Object.assign(LIVE_BUILDERS, {
  /* ------------------------------------------------------------- stripe */

  "stripe.mrr": ({ points, stripe: S }: LiveInputs) => {
    const m = firstCurrency(S?.mrr);
    if (!m) return null;
    /*
      THE NORMALISATION IS ON THE CARD, not only in the API. An annual plan
      counted as a twelfth is the standard convention and it is still
      arithmetic performed on somebody's cash flow — a reader who does not know
      that 359 of these 364 subscriptions are annual would read this figure as
      money that arrives every month, and it is not.
    */
    const annual = m.byInterval.annual;
    return {
      value: inCurrency(m.amount, m.currency, 0),
      /* `across` because every figure here is grouped by CURRENCY and not by
         account: two Stripe accounts billing in dollars are one total, and a
         total that quietly became a sum is a total that changed meaning. */
      sub: also(
        also(
          `${count(m.subscriptions)} billing subscription${m.subscriptions === 1 ? "" : "s"}`,
          annual.subscriptions
            ? `${count(annual.subscriptions)} annual, counted as a twelfth a month`
            : "",
        ),
        across(S?.accounts.length),
      ),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
      seriesAt: points.length > 1 ? points.map((p) => p.ts) : undefined,
    };
  },

  "stripe.arr": ({ stripe: S }: LiveInputs) => {
    const m = firstCurrency(S?.mrr);
    if (!m) return null;
    return {
      value: inCurrency(m.arr, m.currency, 0),
      sub: "MRR × 12 — the same contracted revenue, not a forecast",
    };
  },

  "stripe.net30": ({ points, stripe: S }: LiveInputs) => {
    const r = firstCurrency(S?.revenue);
    if (!r) return null;
    /*
      THE LEDGER'S NET AND NOTHING ELSE. Gross minus refunds, disputes and
      everything Stripe held back, off the balance ledger — never the charge
      walk's gross with a fee subtracted from it, which would be two
      measurements dated differently and subtracted anyway.
    */
    return {
      value: inCurrency(r.net, r.currency, 0),
      sub: also(
        `after ${inCurrency(r.fees, r.currency, 0)} of Stripe's fees, refunds and disputes · sales tax withheld is counted apart`,
        across(S?.accounts.length),
      ),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
      seriesAt: points.length > 1 ? points.map((p) => p.ts) : undefined,
    };
  },

  "stripe.subs": ({ points, stripe: S }: LiveInputs) => {
    const s = S?.subscriptions;
    if (!s) return null;
    /*
      "Active" here means BILLING. A trial is live and has never sent a cent,
      and a past-due subscription is billing and failing; both are named beside
      the figure rather than folded into it — a headline that quietly included
      either would be a headline that changes meaning without moving.
    */
    const aside = [
      s.trialing ? `${count(s.trialing)} trialing` : "",
      s.pastDue ? `${count(s.pastDue)} past due` : "",
    ].filter(Boolean);
    return {
      value: count(s.billing),
      sub: also(
        aside.length
          ? `billing now · ${aside.join(" · ")}, counted apart`
          : "billing now · no trials, none past due",
        across(S?.accounts.length),
      ),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
      seriesAt: points.length > 1 ? points.map((p) => p.ts) : undefined,
    };
  },

  "stripe.churn": ({ stripe: S }: LiveInputs) => {
    const c = churnRow(S, 30);
    if (!c || c.ratePct === null) return null;
    /*
      THE DENOMINATOR IS ON THE CARD, because there are four defensible ones
      and a percentage without its own is not a measurement. This is REVENUE
      churn: MRR the window opened with that has since gone, over the book it
      opened with — reconstructed, hence approximate, and the card says so in
      as many words rather than in a tooltip nobody opens.
    */
    /*
      THE NUMERATOR ON THE CARD IS THE ONE THE RATE USED. `churnedMrr` is
      everything that churned in the window and is the bigger figure; the rate
      counts only what was in the book when the window opened, because a
      subscription that arrived and left inside it was never part of what the
      percentage is of. Printing the larger number over the same denominator
      would put arithmetic on the card that contradicts the figure above it —
      so the rest is a second clause, named for what it is.
    */
    const alsoLost = c.churnedMrr - c.churnedFromStartMrr;
    return {
      value: `${c.ratePct.toFixed(1)}%`,
      tone: c.ratePct >= 5 ? ("warn" as StatusTone) : ("ok" as StatusTone),
      sub: also(
        `${inCurrency(c.churnedFromStartMrr, c.currency, 0)} lost of a ` +
          `${inCurrency(c.startBookMrr, c.currency, 0)} starting book, reconstructed`,
        alsoLost > 0.005
          ? `${inCurrency(alsoLost, c.currency, 0)} more started and ended inside the window`
          : "",
      ),
    };
  },

  "stripe.churnNotChurn": ({ stripe: S }: LiveInputs) => {
    const c = churnRow(S, 90);
    if (!c) return null;
    /*
      THE CARD THAT KEEPS THE CHURN FIGURE HONEST. Of this account's dead
      subscriptions over ninety days, the great majority never collected a
      penny: checkouts that expired before they activated, and free trials that
      were cancelled. Neither lost any revenue, because neither ever earned
      any — counting them cost $415 of a reported $430 monthly churn on the system
      this replaces.
      They are two different problems in two different parts of the funnel, so
      they are two rows and not one.
    */
    const rows: [string, string][] = [
      [
        "Real churn",
        `${count(c.churnedSubs)} · ${inCurrency(c.churnedMrr, c.currency, 0)} of MRR`,
      ],
      [
        "Trials cancelled",
        `${count(c.notChurn.trialNonConversion.subscriptions)} · never billed, a conversion problem`,
      ],
      [
        "Checkouts that expired",
        `${count(c.notChurn.failedActivation.subscriptions)} · never billed, an acquisition problem`,
      ],
    ];
    if (c.involuntary)
      rows.push([
        "Of the real churn, involuntary",
        `${count(c.involuntary)} · a card failed or was disputed`,
      ]);
    if (S?.subscriptions.unresolvedCancellations)
      rows.push([
        "Not yet checked for a payment",
        `${count(S.subscriptions.unresolvedCancellations)} · counted as real churn until they are`,
      ]);
    return { rows };
  },

  "stripe.payouts": ({ points, stripe: S }: LiveInputs) => {
    const b = firstCurrency(S?.balance);
    if (!b) return null;
    /*
      WHAT IS KNOWABLE, WHICH IS NOT THE NEXT PAYOUT DATE. Stripe publishes no
      payout schedule, and every payout on this account is pressed by hand —
      the sample card's "next payout Friday" could never have been filled from
      the API. Available and pending are two different facts and are never
      added: one is what could leave today, the other is what Stripe is holding.
    */
    const last = S?.payouts.last;
    return {
      value: inCurrency(b.available, b.currency, 0),
      sub: also(
        `${inCurrency(b.pending, b.currency, 0)} pending`,
        also(
          last
            ? `last payout ${inCurrency(last.amount, last.currency, 0)} on ${dayShort(last.arrivalDate)}${last.automatic ? "" : ", sent by hand"}`
            : "",
          across(S?.accounts.length),
        ),
      ),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
      seriesAt: points.length > 1 ? points.map((p) => p.ts) : undefined,
    };
  },

  "stripe.gross": ({ stripe: S }: LiveInputs) => {
    const c = firstCurrency(S?.charges);
    if (!c?.series.length) return null;
    return {
      chart: [
        {
          label: `Gross, ${c.currency.toUpperCase()}`,
          points: c.series.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.gross })),
        },
      ],
      unit: "usd" as const,
      /*
        Succeeded charges, dated by the charge — which is NOT the ledger's net
        and is not captioned as if it were. It includes one-off payments, which
        is the whole reason it can be several times MRR on a good day: this
        account sells $3,000 research studies beside a $19 subscription.
      */
      caption:
        `succeeded charges over ${c.days} days · one-off payments included, so this is ` +
        `not MRR · refunds are not deducted here`,
    };
  },

  "stripe.fees": ({ stripe: S }: LiveInputs) => {
    const r = firstCurrency(S?.revenue);
    if (!r) return null;
    /*
      THE SPLIT THAT STOPS AN 8% COST READING AS 15%. Withheld sales tax is
      money Stripe collects as merchant of record and remits to a tax
      authority: real money off the top, and not the business's at any point.
      It gets its own row, below the total, and the percentage above it is
      derived from the fee ex-tax — which is the only figure a blended rate may
      ever come from.
    */
    const money = (n: number) => inCurrency(n, r.currency);
    const rows: [string, string][] = [];
    if (r.feeBreakdown.processing) rows.push(["Card processing", money(r.feeBreakdown.processing)]);
    if (r.feeBreakdown.managedPayments)
      rows.push(["Merchant of record", money(r.feeBreakdown.managedPayments)]);
    if (r.feeBreakdown.disputes) rows.push(["Dispute fees", money(r.feeBreakdown.disputes)]);
    if (r.feeBreakdown.billing) rows.push(["Billing usage", money(r.feeBreakdown.billing)]);
    if (r.feeBreakdown.other) rows.push(["Other", money(r.feeBreakdown.other)]);
    rows.push([
      "Stripe's cut",
      r.feeRatePct === null
        ? money(r.fees)
        : `${money(r.fees)} · ${r.feeRatePct.toFixed(1)}% of gross`,
    ]);
    if (r.taxWithheld)
      rows.push([
        "Withheld sales tax",
        `${money(r.taxWithheld)} · remitted onward, not a cost`,
      ]);
    return { rows };
  },

  "stripe.products": ({ stripe: S }: LiveInputs) => {
    const products = (S?.products ?? []).filter((p) => p.mrr > 0).slice(0, 8);
    if (!products.length) return null;
    /*
      MRR by product, which is SUBSCRIPTIONS ONLY. A one-off payment has no
      subscription and therefore no product line here, however large it was —
      the label says "MRR" and the caption says which money is missing, rather
      than the bars quietly meaning "revenue" for one product and "MRR" for
      the rest.
    */
    return {
      bars: products.map((p) => p.mrr),
      labels:
        `${products.length} product${products.length === 1 ? "" : "s"} · ` +
        `subscriptions only, one-off payments are not in these`,
      barLabels: products.map(
        (p) =>
          `${p.name} · ${inCurrency(p.mrr, p.currency)}/mo · ${count(p.subscribers)} subscriber${p.subscribers === 1 ? "" : "s"}`,
      ),
    };
  },

  "stripe.pending": ({ stripe: S }: LiveInputs) => {
    const p = S?.subscriptions.pendingCancellation;
    if (!p) return null;
    const mrr = firstCurrency(p.mrr);
    const soon = firstCurrency(p.endingSoon.mrr);
    /*
      STILL BILLING, AND STILL IN MRR. An annual subscription that switched off
      auto-renew stays paid for months, so counting all of these as "leaving"
      would be an alarm about something that has not happened. The ones ending
      inside sixty days are the ones somebody could still write to, and they
      are the second half of the subtitle rather than a second card.
    */
    return {
      value: count(p.count),
      tone: p.endingSoon.count > 0 ? ("warn" as StatusTone) : undefined,
      sub: also(
        mrr ? `${inCurrency(mrr.amount, mrr.currency)}/mo, still counted in MRR` : "",
        p.endingSoon.count
          ? `${count(p.endingSoon.count)} within ${p.endingSoon.days} days${soon ? ` (${inCurrency(soon.amount, soon.currency)}/mo)` : ""}`
          : "none ending soon",
      ),
    };
  },

  "stripe.declines": ({ stripe: S }: LiveInputs) => {
    const c = firstCurrency(S?.charges);
    if (!c) return null;
    /*
      TWO NUMBERS THAT LOOK ALIKE AND ARE NOT. A blocked attempt is Radar
      stopping card testing before a bank ever saw it — the system working, and
      nothing anybody can act on. A decline is a real customer's bank saying
      no. On this account they are roughly half the attempts between them, and
      one figure covering both would read as a business whose payments are
      failing rather than as an attack being repelled. They never share a
      denominator, so the rate below counts only what a bank actually saw.
    */
    const rows: [string, string][] = [
      ["Blocked by Radar", `${count(c.blocked)} · never reached a bank`],
      ["Declined by the bank", count(c.declined)],
      [
        "Of the attempts a bank saw",
        c.declineRatePct === null
          ? "no attempts yet"
          : `${c.declineRatePct.toFixed(1)}% declined`,
      ],
    ];
    if (c.refunds)
      rows.push([
        `Refunds, ${c.days}d`,
        `${count(c.refunds)} · ${inCurrency(c.refunded, c.currency)}`,
      ]);
    return { rows };
  },

  "stripe.mix": ({ stripe: S }: LiveInputs) => {
    const s = S?.subscriptions;
    if (!s) return null;
    /*
      Six states, kept apart because each means something different and three
      of them are routinely mistaken for churn. `incompleteExpired` in
      particular is a checkout that expired before its first payment ever
      succeeded — never a customer, and 182 of them on this account.
    */
    return {
      rows: [
        ["Billing", count(s.billing)],
        ["Trialing", count(s.trialing)],
        ["Past due", count(s.pastDue)],
        ["Cancelling at period end", count(s.pendingCancellation.count)],
        ["Cancelled", count(s.canceled)],
        ["Checkouts that expired", count(s.incompleteExpired)],
      ] as [string, string][],
    };
  },

  "stripe.limits": ({ stripe: S }: LiveInputs) => {
    if (!S?.connected) return null;
    /*
      WHAT THIS INTEGRATION WILL NOT ANSWER, on the board rather than in a
      comment. Each line is a question a reader will eventually ask of the
      cards above, answered before they go looking for a figure that is not
      there — which is the difference between a limit and a bug. The history
      line is here because a ninety-day ledger drawn over a year-long window
      would be a floor presented as a total.
    */
    const rows: [string, string][] = [
      ["MRR as Stripe's own figure", "it publishes none — this one is computed"],
      ["Revenue by product, beyond subscriptions", "a one-off payment has no plan"],
      [
        "When the next payout lands",
        S.payouts.automatic === false
          ? "no schedule — these are pressed by hand"
          : "Stripe publishes no schedule",
      ],
      ["Churn to the cent", "the starting book is reconstructed, so it is approximate"],
    ];
    if (!S.history.complete && S.history.from)
      rows.push([
        "Daily history so far",
        `back to ${dayShort(S.history.from)} · still filling ${S.history.chunkDays} days a run`,
      ]);
    return { rows };
  },

  /* ------------------------------------------------------------ adsense */

  "adsense.earnings": ({ adsense: A }: LiveInputs) => {
    /*
      NULL UNTIL SOMEBODY GRANTS CONSENT, which is the whole point. `earnings`
      is null in every state but `authorised` — no rows and no successful
      collection is "asked and not told", not zero — so this card keeps its
      sample and wears no live dot rather than printing a confident $0 for an
      integration nobody has authorised.
    */
    if (A?.state !== "authorised" || A.earnings === null) return null;
    const currency = A.currency ?? "USD";
    /*
      CENTS SURVIVE ON A SMALL FIGURE. Rounding to whole units is right for a
      four-figure month and a lie for this one: $0.58 rendered as "$1" is not a
      tidier version of the number, it is 72% larger than the number. Ten is the
      line — below it the decimals are most of the value, above it they are
      noise on a card this size.
    */
    return {
      value: inCurrency(A.earnings, currency, A.earnings < 10 ? 2 : 0),
      sub: also(
        also(
          `${count(A.sites.length)} site${A.sites.length === 1 ? "" : "s"} · ${A.window.days} days`,
          "estimated — Google revises recent days",
        ),
        across(A.accounts.length),
      ),
      series: A.days.length > 1 ? A.days.map((d) => d.usd) : undefined,
      seriesAt: A.days.length > 1 ? A.days.map((d) => `${d.day}T00:00:00Z`) : undefined,
    };
  },

  "adsense.rpm": ({ adsense: A }: LiveInputs) => {
    if (A?.state !== "authorised") return null;
    const sites = A.sites.filter((s) => s.rpm !== null).slice(0, 8);
    if (!sites.length) return null;
    /*
      RPM is divided out of each site's OWN earnings and impressions on the
      read. It is never an average of daily RPMs: those are not equally
      weighted, and the average of them is a figure no report of Google's would
      agree with. A site that served nothing has no RPM and is left off rather
      than drawn at zero.
    */
    return {
      bars: sites.map((s) => s.rpm!),
      labels: `${sites.length} site${sites.length === 1 ? "" : "s"} · earnings per thousand impressions, ${A.window.days} days`,
      barLabels: sites.map(
        (s) =>
          `${s.site} · ${inCurrency(s.rpm!, A.currency ?? "USD")} RPM · ${inCurrency(s.usd, A.currency ?? "USD")} over ${A.window.days} days`,
      ),
    };
  },

  "adsense.access": ({ adsense: A }: LiveInputs) => {
    if (!A) return null;
    /*
      THE ONE ADSENSE CARD THAT CAN ANSWER TODAY, and the reason the route is
      fetched even while the plugin is disconnected. "Not authorised" is a
      state, not a failure — minting a refresh token needs a human at a Google
      consent screen and no process can do it — so this says WHICH state, in
      Google's own words where there are any, and what would change it. A card
      that shows the fix beats one that paraphrases the failure.
    */
    if (A.state === "authorised") {
      const rows: [string, string][] = [
        ["State", "authorised"],
        ["Reporting currency", A.currency ?? "not reported"],
        [
          "Latest complete month",
          A.latestMonth
            ? `${A.latestMonth.month} · ${inCurrency(A.latestMonth.usd, A.currency ?? "USD")}${A.latestMonth.complete ? "" : " · month to date, not a full month"}`
            : "none yet",
        ],
      ];
      return { rows };
    }
    const rows: [string, string][] = [
      [
        "State",
        A.state === "not-connected" ? "not connected" : "the stored grant was refused",
      ],
      ["Why", A.hint ?? "no reason was reported"],
    ];
    // The steps only belong here while there is nothing to connect with. A
    // refused grant already has Google's own sentence above, which is more
    // specific than a list of five things the owner has already done.
    if (A.state === "not-connected" && A.connect?.length)
      rows.push(["First step", A.connect[0]!], ["Then", A.connect[1]!]);
    return { rows };
  },

  /* -------------------------------------------------------- cloudflare */

  /*
    THE ONE RULE THESE BUILDERS SHARE: null is not zero, and the difference is
    visible on the card. A zone Cloudflare would not answer for has a
    `trafficNote` and no traffic object; a zone that was measured and served
    nothing has a traffic object full of zeroes. The first is left out of every
    figure below and counted separately; the second is a real zero and is drawn
    as one. Folding them together would put "no visitors" under a zone nobody
    ever asked about.
  */

  "cf.zones": ({ cloudflare: C }: LiveInputs) => {
    if (!C) return null;
    const s = C.summary;
    const plans = Object.entries(s.byPlan)
      .sort((a, b) => b[1] - a[1])
      .map(([plan, n]) => `${n} on ${plan}`)
      .join(" · ");
    return {
      value: count(s.zones),
      sub: also(
        s.paused ? `${s.active} active, ${s.paused} paused` : `all ${s.active} active`,
        plans,
      ),
    };
  },

  "cf.total": ({ cloudflare: C }: LiveInputs) => {
    if (!C || !C.summary.withTraffic) return null;
    /* The sparkline is the window's own complete days — today is in the
       document and deliberately not on the line, because a bucket Cloudflare
       is still filling in draws as a collapse that never happened. */
    const done = C.daily.filter((d) => !d.partial);
    const blind = C.summary.withoutTraffic;
    return {
      value: compact(C.summary.requests),
      sub: also(
        `${C.summary.withTraffic} zone${C.summary.withTraffic === 1 ? "" : "s"} · ${C.window.days} complete days to ${dayShort(C.window.through)}`,
        blind ? `${blind} not measured` : "",
      ),
      series: done.length > 1 ? done.map((d) => d.requests) : undefined,
      seriesAt: done.length > 1 ? done.map((d) => at(d.day)) : undefined,
    };
  },

  "cf.requests": ({ cloudflare: C }: LiveInputs) => {
    const measured = (C?.zones ?? []).filter((z) => z.traffic);
    if (!measured.length) return null;
    const top = [...measured]
      .sort((a, b) => b.traffic!.requests - a.traffic!.requests)
      .slice(0, 8);
    const rest = measured.length - top.length;
    const blind = (C?.zones.length ?? 0) - measured.length;
    return {
      bars: top.map((z) => z.traffic!.requests),
      labels: also(
        `top ${top.length} of ${measured.length} zones · ${C!.window.days} complete days`,
        blind ? `${blind} without analytics` : rest ? `${rest} smaller` : "",
      ),
      barLabels: top.map(
        (z) =>
          `${z.name} · ${count(z.traffic!.requests)} requests · ${count(z.traffic!.pageViews)} page views · ${pct(z.traffic!.cacheRatio ?? 0)} cached`,
      ),
    };
  },

  "cf.daily": ({ cloudflare: C }: LiveInputs) => {
    /* Today is left off the LINE and named in the caption instead. Both series
       are counts of requests at the edge, so they share an axis honestly — page
       views are the subset Cloudflare classifies as a page rather than an
       asset, which is why one is always under the other. */
    const done = (C?.daily ?? []).filter((d) => !d.partial);
    if (done.length < 2) return null;
    const withViews = done.every((d) => d.pageViews !== null);
    const chart = [
      { label: "requests", points: done.map((d) => ({ ts: at(d.day), value: d.requests })) },
      ...(withViews
        ? [
            {
              label: "page views",
              points: done.map((d) => ({ ts: at(d.day), value: d.pageViews! })),
            },
          ]
        : []),
    ];
    const partial = C!.daily.find((d) => d.partial);
    return {
      chart,
      unit: "count" as const,
      caption: also(
        `${done.length} complete UTC days across ${C!.summary.zones} zones`,
        partial ? `${dayShort(partial.day)} still settling, not drawn` : "",
      ),
    };
  },

  "cf.visitors": ({ cloudflare: C }: LiveInputs) => {
    /*
      A CARD OF ITS OWN, AND THE CAPTION IS HALF OF IT. Cloudflare de-duplicates
      visitors within one zone and one day and nowhere else, so a figure across
      twenty-three zones counts somebody who read two of these sites twice.
      There is no identity that spans zones to fix that with, and inventing one
      would be worse than saying so — which is the same rule GitHub's unique
      visitors follow on the code board.
    */
    const done = (C?.daily ?? []).filter((d) => !d.partial && d.uniquesByZone !== null);
    if (done.length < 2) return null;
    return {
      chart: [
        {
          label: "visitors",
          points: done.map((d) => ({ ts: at(d.day), value: d.uniquesByZone! })),
        },
      ],
      unit: "count" as const,
      caption: `summed per zone across ${C!.summary.zones} zones — anyone who read two of these sites is in it twice`,
    };
  },

  "cf.bandwidth": ({ cloudflare: C }: LiveInputs) => {
    if (!C || !C.summary.withTraffic) return null;
    return {
      value: bytes(C.summary.bytes, { base: 1000 }),
      sub: `served from the edge over ${C.window.days} complete days, ${C.summary.withTraffic} zones`,
    };
  },

  "cf.threats": ({ cloudflare: C }: LiveInputs) => {
    /* Null when any zone's window came back from a field set that could not ask
       for threats: an undercount presented as a count is worse than a sample. */
    if (!C || C.summary.threats === null) return null;
    const share = C.summary.requests
      ? (C.summary.threats / C.summary.requests) * 100
      : null;
    return {
      value: count(C.summary.threats),
      sub: also(
        `Cloudflare's own count over ${C.window.days} complete days`,
        share === null ? "" : `${percent(share, 2)} of requests`,
      ),
    };
  },

  "cf.cacheRatio": ({ cloudflare: C }: LiveInputs) => {
    /* A ratio over zero requests is unknowable rather than 0%, which is why
       this returns null instead of drawing a confident nothing. */
    if (!C || C.summary.cacheRatio === null) return null;
    return {
      value: pct(C.summary.cacheRatio),
      sub: `${count(C.summary.cached)} of ${count(C.summary.requests)} requests answered at the edge · ${C.summary.proxied ?? "—"} of ${C.summary.records ?? "—"} records are proxied`,
    };
  },

  "cf.responses": ({ cloudflare: C }: LiveInputs) => {
    const measured = (C?.zones ?? []).filter((z) => z.traffic);
    if (!measured.length) return null;
    /* One null anywhere makes the whole split unknown. A 5xx count that quietly
       omitted the zones whose query landed on a thinner field set would be the
       most reassuring wrong number on the board. */
    const classes: [string, (t: NonNullable<CloudflareZone["traffic"]>) => number | null][] = [
      ["2xx", (t) => t.status.s2xx],
      ["3xx", (t) => t.status.s3xx],
      ["4xx", (t) => t.status.s4xx],
      ["5xx", (t) => t.status.s5xx],
    ];
    const totals: number[] = [];
    for (const [, pick] of classes) {
      let sum = 0;
      for (const z of measured) {
        const v = pick(z.traffic!);
        if (v === null) return null;
        sum += v;
      }
      totals.push(sum);
    }
    const all = totals.reduce((n, v) => n + v, 0);
    if (!all) return null;
    return {
      bars: totals,
      labels: classes
        .map(([name], i) => `${name} ${pct(totals[i]! / all, { digits: 0 })}`)
        .join(" · "),
      barLabels: classes.map(
        ([name], i) => `${name} · ${count(totals[i]!)} responses · ${pct(totals[i]! / all)}`,
      ),
    };
  },

  "cf.dns": ({ cloudflare: C }: LiveInputs) => {
    /*
      THE JOIN, AS A VERDICT PER LINE.

      Cloudflare knows which nameservers it ASSIGNED a zone; the registrars know
      which ones the domain actually DELEGATES to. Where those disagree the
      records on every other card here are not the records the internet is being
      served — which is the one failure this dashboard is uniquely placed to
      catch, because it is the only place both halves are on hand at once.

      Five lines rather than "clean / not clean", because three of the states
      are neither. A registrar that would not report nameservers is unknown, a
      zone whose domain is registered somewhere with no API here has nothing to
      compare against, and a name pointed at a DIFFERENT pair of Cloudflare
      nameservers is on Cloudflare and still not on this zone.
    */
    if (!C) return null;
    const a = C.alignment;
    const statuses: [string, StatusTone][] = [];
    if (a.aligned.length)
      statuses.push([`${a.aligned.length} delegated to their own zone`, "ok"]);
    if (a.offCloudflare.length)
      statuses.push([
        `${a.offCloudflare.length} pointed off Cloudflare: ${a.offCloudflare.map((z) => z.name).join(", ")}`,
        "bad",
      ]);
    if (a.elsewhereOnCloudflare.length)
      statuses.push([
        `${a.elsewhereOnCloudflare.length} on other Cloudflare nameservers: ${a.elsewhereOnCloudflare.map((z) => z.name).join(", ")}`,
        "bad",
      ]);
    if (a.unknown.length)
      statuses.push([
        `${a.unknown.length} whose registrar did not report nameservers`,
        "warn",
      ]);
    if (a.zoneOnly.length)
      statuses.push([
        `${a.zoneOnly.length} zone${a.zoneOnly.length === 1 ? "" : "s"} no connected registrar holds`,
        "warn",
      ]);
    if (a.registrarOnly.length)
      statuses.push([
        `${a.registrarOnly.length} registered name${a.registrarOnly.length === 1 ? "" : "s"} with no zone here`,
        "warn",
      ]);
    if (a.claimedTwice.length)
      statuses.push([`${a.claimedTwice.length} claimed by two registrars`, "warn"]);
    return statuses.length ? { statuses } : null;
  },

  "cf.unmatched": ({ cloudflare: C }: LiveInputs) => {
    /*
      THE TWO GAPS, NAMED RATHER THAN COUNTED. Both are invisible everywhere
      else on this board: a zone no registrar holds has no renewal date on the
      domains page, and a registered name with no zone has no DNS anywhere here.
      A count would say there is something to look at; the names say what.
    */
    if (!C) return null;
    const a = C.alignment;
    if (!a.zoneOnly.length && !a.registrarOnly.length) return null;
    const rows: [string, string][] = [];
    if (a.zoneOnly.length)
      rows.push([
        `${a.zoneOnly.length} zones no connected registrar holds`,
        a.zoneOnly.slice(0, 4).join(", ") + (a.zoneOnly.length > 4 ? ", …" : ""),
      ]);
    for (const d of a.registrarOnly.slice(0, 6))
      rows.push([
        d.name,
        also(
          `${d.registrar}, no Cloudflare zone`,
          d.nameservers?.length
            ? `→ ${nsProvider(d.nameservers)}`
            : "nameservers not reported",
        ),
      ]);
    if (a.registrarOnly.length > 6)
      rows.push([`${a.registrarOnly.length - 6} more registered names`, "with no zone"]);
    return { rows };
  },

  "cf.email": ({ cloudflare: C }: LiveInputs) => {
    /*
      COUNTED OVER THE ZONES THAT CARRY MAIL, not over all of them. A zone with
      no MX and no SPF is not badly configured for failing to defend a mailbox
      it does not have, and putting it in the denominator turns a tidy portfolio
      into a wall of warnings nobody can act on.

      p=none is called out on its own line because a DMARC record that monitors
      and enforces nothing is the most common way to believe you are protected.
    */
    const e = C?.email;
    if (!e || !e.zones) return null;
    const statuses: [string, StatusTone][] = [];
    statuses.push([
      `${e.sending} of ${e.zones} zones carry mail`,
      "ok",
    ]);
    const noSpf = e.sending - e.spf;
    statuses.push(
      noSpf > 0 ? [`${noSpf} of those without SPF`, "warn"] : ["SPF on every one", "ok"],
    );
    const noDmarc = e.sending - e.dmarc;
    if (noDmarc > 0) statuses.push([`${noDmarc} without DMARC`, "warn"]);
    if (e.dmarcMonitorOnly)
      statuses.push([`${e.dmarcMonitorOnly} DMARC records at p=none — monitoring only`, "warn"]);
    if (e.dkimMissing)
      statuses.push([`${e.dkimMissing} sending zones with no DKIM selector`, "warn"]);
    if (e.unreadable)
      statuses.push([`${e.unreadable} zones whose records could not be read`, "warn"]);
    return { statuses };
  },

  "cf.records": ({ cloudflare: C }: LiveInputs) => {
    const s = C?.summary;
    if (!s || s.records === null) return null;
    const rows: [string, string][] = [
      ["Records", `${count(s.records)} across ${s.zones - s.recordsUnreadable} zones`],
      [
        "Proxied through Cloudflare",
        `${count(s.proxied)} · ${pct(s.records ? (s.proxied ?? 0) / s.records : null, { digits: 0 })}`,
      ],
      /* The only trace of a Pages project this token can see: the Pages API
         itself answers 403, so this counts CNAMEs to *.pages.dev rather than
         projects, and says so. */
      ["Zones with a CNAME to pages.dev", String(s.onPages)],
    ];
    if (s.recordsUnreadable)
      rows.push([`${s.recordsUnreadable} zones unreadable`, "counted nowhere above"]);
    if (s.silent.length)
      rows.push([
        `${s.silent.length} zones served nothing`,
        s.silent.slice(0, 3).join(", ") + (s.silent.length > 3 ? ", …" : ""),
      ]);
    return { rows };
  },

  "cf.table": ({ cloudflare: C }: LiveInputs) => {
    if (!C?.zones.length) return null;
    return {
      headers: ["Zone", "Requests", "Cached", "Views", "Records", "Delegation"],
      table: [...C.zones]
        .sort((a, b) => (b.traffic?.requests ?? -1) - (a.traffic?.requests ?? -1))
        .map((z) => [
          z.name,
          /* An em dash rather than a zero for a zone nobody could measure. The
             zone beside it that really did serve nothing prints 0. */
          z.traffic ? count(z.traffic.requests) : "—",
          z.traffic ? pct(z.traffic.cacheRatio ?? 0) : DASH,
          z.traffic ? count(z.traffic.pageViews) : "—",
          z.records === null ? "—" : String(z.records),
          delegationWord(z.alignment.state),
        ]),
    };
  },

  "cf.cannot": ({ cloudflare: C }: LiveInputs) => {
    /*
      THE EVIDENCE, NOT THE VERDICT — the same card the costs board carries for
      Replicate. The token behind this integration is deliberately zone-read-
      only, so a reader who goes looking for a Pages deployment, a WAF figure or
      an account-wide total finds out that it was asked for and refused, rather
      than assuming the collector is broken and going to re-paste a perfectly
      good credential.
    */
    if (!C) return null;
    const rows: [string, string][] = C.cannot.asked.map(
      (a) => [a.asked, a.answer] as [string, string],
    );
    rows.push(["Checked", C.cannot.checkedOn]);
    return { rows };
  },

} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ------------------------------------------------------------------ search */

/**
 * The two search engines' cards.
 *
 * NOTHING BELOW ADDS A GOOGLE FIGURE TO A BING ONE, and no card draws from
 * both objects. They count different searches by different people on different
 * networks under different anonymisation rules; the pair of impression totals
 * on this board are two measurements of two things that happen to share a
 * word, and one card holding both would be inviting exactly the sum this
 * codebase refuses everywhere else.
 *
 * THREE SENTENCES THESE CARDS HAVE TO SAY OUT LOUD, because the numbers cannot
 * say them alone:
 *
 *   THE LINE STOPS THREE DAYS SHORT OF TODAY. Search Console finalises a day
 *   over two to three days, so every Google card here is captioned with the
 *   last finalised day rather than with "28d" — a window whose end is not
 *   stated reads as a window ending now, and the missing days read as a fall.
 *
 *   THE QUERY ROWS ARE A SAMPLE. They carry 19% of this portfolio's
 *   impressions, and between 2% and 77% depending on the property. Every card
 *   that lists queries carries that fraction on its face, and no card anywhere
 *   sums them into a total.
 *
 *   BING'S KEYWORD VOLUMES ARE BING'S. They are one engine's impressions for
 *   one market, and the card names the market rather than letting a reader
 *   take them for a world figure or for Google's.
 */

/** A movement, said as a phrase rather than as a bare percent. `null` when
 *  the window before was empty: going from nothing to eight impressions is not
 *  an infinite improvement, and a card that says so is a card nobody trusts
 *  twice. */
function movedBy(delta: number | null, days: number): string {
  if (delta === null) return "no comparable window before it";
  const rounded = Math.abs(delta) >= 10 ? Math.round(delta) : Number(delta.toFixed(1));
  return `${rounded > 0 ? "+" : ""}${rounded}% on the previous ${days}d`;
}

/** A rank, at one decimal and never as a percentage. */
const place = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : n.toFixed(1);

/** A URL as the part of it anybody reads. The host is the property, which is
 *  already the row above it or the column beside it. */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? `${u.hostname}/` : u.pathname;
  } catch {
    return url;
  }
}

Object.assign(LIVE_BUILDERS, {
  /* --------------------------------------------------- search console */

  "gsc.impressions": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.window.end) return null;
    return {
      value: count(G.totals.impressions),
      /*
        THE WINDOW'S END IS ON THE CARD. "28d" alone reads as "the 28 days
        ending now", and these end three days back because Google has not
        finished the ones after that. Naming the day is the difference between
        a reader seeing a lag and a reader seeing a decline.
      */
      sub: also(
        also(
          `${G.totals.properties} of ${G.properties.length} properties with traffic`,
          movedBy(G.delta.impressions, G.window.days),
        ),
        `${G.window.days}d to ${dayShort(G.window.end)}`,
      ),
      series: G.series.length > 1 ? G.series.map((d) => d.impressions) : undefined,
      seriesAt: G.series.length > 1 ? G.series.map((d) => at(d.day)) : undefined,
    };
  },

  "gsc.clicks": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.window.end) return null;
    return {
      value: count(G.totals.clicks),
      /* CTR is clicks over impressions across the whole window, never the mean
         of the daily rates — a quiet Sunday and a launch day are not equal
         halves of anything. */
      sub: also(
        also(
          G.totals.ctr === null ? "" : `CTR ${percent(G.totals.ctr, 2)} of ${count(G.totals.impressions)} impressions`,
          movedBy(G.delta.clicks, G.window.days),
        ),
        `${G.window.days}d to ${dayShort(G.window.end)}`,
      ),
      series: G.series.length > 1 ? G.series.map((d) => d.clicks) : undefined,
      seriesAt: G.series.length > 1 ? G.series.map((d) => at(d.day)) : undefined,
    };
  },

  "gsc.position": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || G.totals.position === null) return null;
    /*
      POSITION MOVES IN PLACES, NOT PERCENT, so the movement is spelled out
      here rather than handed to the card's own delta — "-25%" over a rank is a
      figure in no unit. Positive is worse, which is why the phrase says which
      way it went instead of relying on a sign a reader has to interpret.
    */
    const moved = G.delta.position;
    const drift =
      moved === null || moved === 0
        ? "no change on the previous window"
        : `${Math.abs(moved).toFixed(1)} ${moved > 0 ? "worse" : "better"} than the previous ${G.window.days}d`;
    return {
      value: place(G.totals.position),
      sub: also(
        `impression-weighted across ${G.totals.properties} properties`,
        drift,
      ),
    };
  },

  "gsc.queries": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.queries.length) return null;
    const rows: [string, string][] = G.queries
      .slice(0, 6)
      .map((q) => [q.query, `${count(q.clicks)} clicks · #${place(q.position)}`]);
    /*
      THE LAST ROW IS THE POINT OF THE CARD. Google withholds queries too rare
      to keep a searcher anonymous and caps the rows it will return at all, so
      these six sit inside a fifth of the impressions the properties actually
      had. Without that line, a reader adds the column up and gets a number
      that is wrong by a factor of five.
    */
    rows.push([
      "These rows cover",
      G.coverage.pct === null
        ? "an unknown share of impressions"
        : `${percent(G.coverage.pct)} of impressions`,
    ]);
    return { rows };
  },

  "gsc.pages": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.pages.length) return null;
    return {
      rows: G.pages
        .slice(0, 6)
        .map((p) => [pathOf(p.page), `${count(p.clicks)} clicks`] as [string, string]),
    };
  },

  "gsc.sites": ({ gsc: G }: LiveInputs) => {
    const seen = (G?.properties ?? []).filter((p) => p.impressions > 0);
    if (!seen.length) return null;
    const shown = seen.slice(0, 12);
    const rest = seen.slice(shown.length);
    const table = shown.map((p) => [
      p.label,
      count(p.impressions),
      count(p.clicks),
      p.ctr === null ? "—" : percent(p.ctr, 2),
      place(p.position),
      /* A property with nothing in the window before it gets a word rather than
         a percentage off a base of zero. */
      p.delta.impressions === null
        ? "new"
        : `${p.delta.impressions > 0 ? "+" : ""}${Math.round(p.delta.impressions)}%`,
    ]);
    /*
      A TRIMMED LIST SAYS WHAT IT LEFT OUT, and says it with the figures rather
      than with a count — the reader's question about the tail is "does any of
      it matter", and four properties worth ninety impressions between them
      answers it where "+4 more" does not. The columns that cannot be summed
      across properties (a CTR, a rank) are dashes on that row rather than an
      average nobody asked for.
    */
    if (rest.length)
      table.push([
        `+${rest.length} smaller propert${rest.length === 1 ? "y" : "ies"}`,
        count(rest.reduce((a, p) => a + p.impressions, 0)),
        count(rest.reduce((a, p) => a + p.clicks, 0)),
        "—",
        "—",
        "—",
      ]);
    return {
      headers: ["Property", "Impressions", "Clicks", "CTR", "Position", "Δ impressions"],
      table,
    };
  },

  "gsc.movers": ({ gsc: G }: LiveInputs) => {
    /*
      A MOVER NEEDS A BASE WORTH MOVING FROM. Eleven impressions becoming
      thirty-three is a 200% rise and is noise; without a floor this card is a
      list of the quietest properties on the account, every time. Fifty
      impressions in the window before is the floor, and the card says so.
    */
    const moved = (G?.properties ?? [])
      .filter((p) => p.delta.impressions !== null && p.previous.impressions >= 50)
      .sort((a, b) => Math.abs(b.delta.impressions!) - Math.abs(a.delta.impressions!))
      .slice(0, 5);
    if (!moved.length) return null;
    const rows: [string, string][] = moved.map((p) => [
      p.label,
      `${p.delta.impressions! > 0 ? "+" : ""}${Math.round(p.delta.impressions!)}% · ${count(p.impressions)} impr`,
    ]);
    rows.push(["Floor", `50+ impressions in the previous ${G!.window.days}d`]);
    return { rows };
  },

  "gsc.trend": ({ gsc: G }: LiveInputs) => {
    if (!G || G.series.length < 2) return null;
    return {
      chart: [
        {
          label: "impressions",
          points: G.series.map((d) => ({ ts: at(d.day), value: d.impressions })),
        },
      ],
      unit: "count" as const,
      /* Clicks are NOT drawn beside this. They run about forty times smaller on
         this portfolio, and on a shared axis starting at zero they would be a
         flat line along the bottom pretending to be a measurement. */
      caption: G.window.end
        ? `daily, every property summed · ends ${dayShort(G.window.end)}, three days back, because Google has not finalised the days after it`
        : "daily, every property summed",
    };
  },

  "gsc.striking": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.striking.length) return null;
    const rows: [string, string][] = G.striking
      .slice(0, 6)
      .map((q) => [q.query, `#${place(q.position)} · ${count(q.impressions)} impr`]);
    /*
      THE CAVEAT IS PART OF THE CARD BECAUSE IT IS PART OF THE MEASUREMENT.
      Google returns these rows ordered by CLICKS and offers no other order, so
      the zero-click, high-impression query — which is exactly the kind of row
      this card exists to surface — can be missing entirely.
    */
    rows.push(["Drawn from", "Google's clicks-ordered rows, so some are missing"]);
    return { rows };
  },

  "gsc.coverage": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.totals.impressions) return null;
    /*
      THE CARD THAT KEEPS THE QUERY CARDS HONEST — the same job "What is not
      churn" does for the Stripe board. Two numbers that look like they should
      match and never can, with the reason between them.
    */
    const worst = [...G.properties]
      .filter((p) => p.queryCoverage.pct !== null && p.impressions > 0)
      .sort((a, b) => a.queryCoverage.pct! - b.queryCoverage.pct!)[0];
    const rows: [string, string][] = [
      ["Impressions, every property", count(G.totals.impressions)],
      [
        "Inside the ranked query rows",
        `${count(G.coverage.queryImpressions)} · ${G.coverage.pct === null ? "—" : percent(G.coverage.pct)}`,
      ],
      ["Rows Google will return", `${G.coverage.rowLimit} per property, ordered by clicks`],
      ["The rest", "queries too rare to anonymise, and the tail past the cap"],
    ];
    if (worst)
      rows.push([`Thinnest — ${worst.label}`, `${percent(worst.queryCoverage.pct!)} covered`]);
    return { rows };
  },

  "gsc.sitemaps": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.properties.length) return null;
    const s = G.sitemaps;
    const rows: [string, string][] = [
      ["Properties reporting one", `${s.properties} of ${G.properties.length}`],
      ["URLs submitted", count(s.submitted)],
      ["Errors", count(s.errors)],
      ["Warnings", count(s.warnings)],
    ];
    /*
      THREE STATES AND NOT TWO. "Has submitted no sitemap" is a thing to go and
      fix; "the sitemaps call was refused" is a thing nobody can vouch for, and
      folding them together turns the first into a number too big to act on —
      the rule /api/domains keeps between auto-renew off and auto-renew unknown.
      Each is named only when it is not zero, so the card stays four rows on the
      ordinary day.
    */
    if (s.none) rows.push(["None submitted", `${s.none} propert${s.none === 1 ? "y" : "ies"}`]);
    if (s.unreadable) rows.push(["Could not be read", `${s.unreadable} — not the same as none`]);
    rows.push(["Submitted, not indexed", "Search Console publishes no index count by API"]);
    return { rows };
  },

  /* ------------------------------------------------------------- bing */

  "bing.impressions": ({ bing: B }: LiveInputs) => {
    if (!B?.connected || !B.window.end) return null;
    return {
      value: count(B.totals.impressions),
      sub: also(
        `${B.totals.verified} verified site${B.totals.verified === 1 ? "" : "s"}`,
        `${B.window.days}d to ${dayShort(B.window.end)}`,
      ),
      series: B.series.length > 1 ? B.series.map((d) => d.impressions) : undefined,
      seriesAt: B.series.length > 1 ? B.series.map((d) => at(d.day)) : undefined,
    };
  },

  "bing.clicks": ({ bing: B }: LiveInputs) => {
    if (!B?.connected || !B.window.end) return null;
    return {
      value: count(B.totals.clicks),
      sub: also(
        B.totals.ctr === null
          ? ""
          : `CTR ${percent(B.totals.ctr, 2)} of ${count(B.totals.impressions)} impressions`,
        `${B.window.days}d to ${dayShort(B.window.end)}`,
      ),
      series: B.series.length > 1 ? B.series.map((d) => d.clicks) : undefined,
      seriesAt: B.series.length > 1 ? B.series.map((d) => d.day).map(at) : undefined,
    };
  },

  "bing.index": ({ bing: B }: LiveInputs) => {
    if (!B?.connected || !B.index.day) return null;
    return {
      value: count(B.index.inIndex),
      /* Pages HELD, not pages submitted. The sitemap figure on the Google side
         of this board is the other one, and they are not comparable: one is
         what we asked a crawler to look at, this is what a crawler kept. */
      sub: also(
        `pages Bing is holding across ${B.totals.sites} site${B.totals.sites === 1 ? "" : "s"}`,
        `crawled ${count(B.index.crawledPages)} on ${dayShort(B.index.day)}`,
      ),
    };
  },

  "bing.crawl": ({ bing: B }: LiveInputs) => {
    if (!B?.connected || !B.index.day) return null;
    return {
      rows: [
        ["In Bing's index", count(B.index.inIndex)],
        ["Pages crawled", count(B.index.crawledPages)],
        ["Crawl errors", count(B.index.crawlErrors)],
        ["Blocked by robots.txt", count(B.index.blockedByRobots)],
        ["As reported on", dayShort(B.index.day)],
      ] as [string, string][],
    };
  },

  "bing.queries": ({ bing: B }: LiveInputs) => {
    if (!B?.connected || !B.queries.length) return null;
    const rows: [string, string][] = B.queries
      .slice(0, 6)
      .map((q) => [q.query, `${count(q.impressions)} impr · #${place(q.position)}`]);
    /*
      NAMED AS BING'S OWN REPORT, because the card next to it is Google's and
      the two lists disagree — that is the interesting part and it stops being
      interesting the moment a reader assumes they measure the same thing.
      This is still a rear-view mirror: it can only contain phrases a page of
      ours already ranks for. The keyword card is the other question.
    */
    rows.push(["From", `Bing's own query report · ${B.window.days}d`]);
    return { rows };
  },

  "bing.sites": ({ bing: B }: LiveInputs) => {
    if (!B?.sites.length) return null;
    return {
      headers: ["Site", "Impressions", "Clicks", "CTR", "In index", "Inbound links"],
      table: B.sites.map((s) => [
        s.label,
        count(s.impressions),
        count(s.clicks),
        s.ctr === null ? "—" : percent(s.ctr, 2),
        count(s.index.inIndex),
        count(s.inLinks),
      ]),
    };
  },

  "bing.trend": ({ bing: B }: LiveInputs) => {
    if (!B || B.series.length < 2) return null;
    return {
      chart: [
        {
          label: "impressions",
          points: B.series.map((d) => ({ ts: at(d.day), value: d.impressions })),
        },
      ],
      unit: "count" as const,
      caption: B.window.end
        ? `daily, every verified site summed · Bing's own newest day is ${dayShort(B.window.end)}`
        : "daily, every verified site summed",
    };
  },

  "bing.backlinks": ({ bing: B }: LiveInputs) => {
    if (!B?.connected || !B.sites.length) return null;
    /*
      THE CARD THAT CHANGED WHEN THE API WAS ASKED. The catalog's sample said
      "1,847 inbound links, new referring domains: 12". Bing reports inbound
      links two ways and they disagree completely on this account: the crawl
      statistics carry a real count, and GetLinkCounts — the only endpoint that
      could NAME a linking page, and therefore the only route to a referring
      domain — answers HTTP 200 with an empty list for every verified site.
      So the count is here, the list is not, and the referring-domain figure is
      gone rather than filled with something adjacent.
    */
    const rows: [string, string][] = B.sites.map((s) => [
      s.label,
      `${count(s.inLinks)} inbound`,
    ]);
    rows.push([
      "Linking pages Bing will name",
      B.links.namedPages === 0 ? "none, on any site" : count(B.links.namedPages),
    ]);
    rows.push(["Referring domains", "not answerable — the link list is empty"]);
    return { rows };
  },

  "bing.keywords": ({ bing: B }: LiveInputs) => {
    if (!B?.connected) return null;
    /*
      THE ONE CARD ON THIS BOARD THAT IS NOT A REAR-VIEW MIRROR. Search Console
      and Bing's query report can only ever list phrases a page of ours already
      ranks for. This measures how many people typed a phrase whether or not
      anything of ours came back — and it cannot guess which phrases those are,
      because seeding it from what already ranks would ask the very question it
      exists not to answer.

      So an empty list is not a broken card, it is an unconfigured one, and it
      says which one step fixes it — the same choice the AdSense access card
      makes, and for the same reason: a card that shows the fix beats a card
      showing a sample.
    */
    if (!B.keywords.configured)
      return {
        rows: [
          ["No phrases named yet", "—"],
          ["What it measures", "demand for phrases you have no page for"],
          ["Where to set them", "Bing Webmaster → Settings → Keyword phrases"],
        ] as [string, string][],
      };

    const word = (k: (typeof B.keywords.phrases)[number]) => {
      if (k.volume !== null) return `${count(k.volume)}/wk`;
      /* Three different reasons for a blank, and only one of them is about
         demand. "Bing reported none" is a finding; "unmeasured" is a throttle,
         and printing either as 0 would be a claim nobody made. */
      if (k.status === "na") return "Bing reported none";
      if (k.status === "void") return "unmeasured this run";
      return "could not be read";
    };
    const rows: [string, string][] = B.keywords.phrases.slice(0, 6).map((k) => [k.phrase, word(k)]);
    rows.push(["Bing impressions", `${B.keywords.market} · exact phrase, latest week`]);
    return { rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ------------------------------------------------------------------ social */

/**
 * The Meta and Instagram cards.
 *
 * THREE PAGES AND ONE AD ACCOUNT IS MODEST MATERIAL, so this is a handful of
 * cards that each answer something rather than a grid of tiles. What it is
 * modest in is not the same as what it is short of: the ad account carries a
 * full thirty-day window, a campaign cut and a daily line, and the Pages carry
 * follower counts and nothing else — because nothing else about a Page is
 * readable with this token, which is itself one of the cards.
 *
 * FOUR THINGS THESE CARDS SAY OUT LOUD, because the numbers cannot say them:
 *
 *   ORGANIC PAGE REACH IS NOT AVAILABLE, TWICE OVER. The metric a "Page reach"
 *   card would be built on — `page_impressions_unique` — was retired by Meta in
 *   November 2025 and now answers "not a valid insights metric"; the page
 *   metrics that DO still exist need a Page Access Token this system user's
 *   role cannot mint. Two independent reasons, and the access card names both,
 *   because a reader told only "unavailable" would go and fix the wrong one.
 *
 *   THE REACH THAT IS HERE IS PAID, AND ITS CARD SAYS SO IN ITS NAME. Ad reach
 *   and Page reach are two measurements of two things; the card is titled for
 *   the one it draws rather than letting a reader take a paid figure for an
 *   organic one.
 *
 *   ROAS CANNOT BE COMPUTED AND THE CARD IS THE EVIDENCE FOR THAT. Return on ad
 *   spend is revenue over spend, and this account buys lead-form submissions —
 *   there is no purchase event, no `action_values`, and `purchase_roas` is
 *   absent from every row Meta returns. The catalog's "2.8× blended, 30d" was a
 *   sample of a figure that could not exist, and blended across accounts is the
 *   one shape it may never take even when it does.
 *
 *   THE MONEY IS EUR AND NO TOTAL SPANS IT. Every money card here names the
 *   currency, and the one card that could invite a cross-currency sum says in
 *   its last row that none is offered — the same closing line the costs board
 *   and the app-store board carry, for the same reason.
 */

/** The window figure for the ad accounts that share one currency, or null when
 *  they do not. A spend total across two currencies is not a number. */
function oneCurrency(M: MetaReport): { currency: string; accounts: MetaAdAccount[] } | null {
  const active = M.adAccounts.filter((a) => a.active && a.currency);
  if (!active.length) return null;
  const currencies = [...new Set(active.map((a) => a.currency!))];
  return currencies.length === 1
    ? { currency: currencies[0]!, accounts: active }
    : null;
}

/** "5 Aug", one day at human size. Used where a card has to state the edge of a
 *  window rather than its span — "sent mail back to 6 Jun" is a claim about how
 *  far the history reaches, and a card making it has to name the date. */
function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "5 Aug – 3 Sep", from Meta's own window dates. A card captioned "30d" over a
 *  window that closed yesterday is captioning a window it is not. */
function windowSpan(from: string | null | undefined, to: string | null | undefined): string {
  const day = (d: string | null | undefined) =>
    d
      ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        })
      : null;
  const a = day(from);
  const b = day(to);
  return a && b ? `${a} – ${b}` : (a ?? b ?? "window not stated");
}

/** A campaign name Meta generated. Its auto-named campaigns are a date stamp
 *  and a whole URL — "[8/4/2026] Promoting https://acme.example/?utm_source=…"
 *  — which is forty wasted characters before the only distinguishing part. The
 *  stamp goes, the URL loses its scheme and its query, and a name somebody
 *  actually typed is left exactly as they typed it. */
function campaignName(name: string | null): string {
  if (!name) return "unnamed campaign";
  const bare = name
    .replace(/^\[\d+\/\d+\/\d+\]\s*/, "")
    .replace(/^Promoting\s+/i, "")
    .replace(/^https?:\/\//, "")
    .replace(/\?.*$/, "")
    .replace(/\/$/, "")
    .trim();
  const short = bare || name.trim();
  /* An ellipsis rather than a bare cut, so a name that was shortened does not
     read as a name that happens to end mid-word — and the trailing punctuation
     a cut lands on goes with it. */
  return short.length > 42 ? `${short.slice(0, 41).replace(/[\s,.:;-]+$/, "")}…` : short;
}

Object.assign(LIVE_BUILDERS, {
  "meta.spend": ({ meta: M, points }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    if (!one) return null;
    const spend = one.accounts.reduce((n, a) => n + (a.window?.spend ?? 0), 0);
    const w = one.accounts[0]?.window;
    /* The window's own dates rather than "30d". Meta's `last_30d` ends on the
       last complete day, so the figure is never about a window ending today —
       and a caption that implies it is turns a settled total into a running
       one. */
    return {
      value: inCurrency(spend, one.currency),
      sub: also(
        windowSpan(w?.from, w?.to),
        one.accounts.length > 1
          ? `${one.accounts.length} ad accounts, all ${one.currency}`
          : `1 ad account, ${one.currency}`,
      ),
      /* The rolling window figure, sampled every collection. A single reading
         is a dot rather than a line and is left off, so the card never draws a
         "trend" over one measurement. */
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  "meta.reach": ({ meta: M }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    /*
      ONE AD ACCOUNT'S REACH, NEVER A SUM OF SEVERAL. Meta de-duplicates reach
      inside each row's window and nowhere else, so two ad accounts' reaches
      cannot be added — the same person in both would be counted twice. With
      more than one account this card names the largest rather than inventing a
      portfolio figure that does not exist.
    */
    const withReach = (one?.accounts ?? M.adAccounts)
      .filter((a) => a.window?.reach !== null && a.window?.reach !== undefined)
      .sort((a, b) => (b.window!.reach ?? 0) - (a.window!.reach ?? 0));
    const top = withReach[0];
    if (!top?.window) return null;
    const w = top.window;
    return {
      value: count(w.reach),
      sub: also(
        `${windowSpan(w.from, w.to)} · ${w.frequency === null ? "" : `seen ${w.frequency.toFixed(2)}× each`}`.replace(
          / · $/,
          "",
        ),
        withReach.length > 1
          ? `${top.name ?? top.id} only — reach cannot be added across accounts`
          : "de-duplicated over the window; never added to another row's",
      ),
    };
  },

  "meta.leads": ({ meta: M, points }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    if (!one) return null;
    /* Leads DO add up where reach does not: a lead is one form submission and
       two campaigns cannot submit the same one. Null stays null — an account
       whose actions field never answered has not produced zero leads. */
    const rows = one.accounts.filter((a) => a.window?.leads !== null && a.window?.leads !== undefined);
    if (!rows.length) return null;
    const leads = rows.reduce((n, a) => n + (a.window!.leads ?? 0), 0);
    const spend = rows.reduce((n, a) => n + (a.window?.spend ?? 0), 0);
    /* Meta's own cost per lead where there is exactly one account to take it
       from; divided here only when several accounts have to be pooled, and
       then it is our arithmetic rather than Meta's and is not labelled as its
       figure. */
    const own = rows.length === 1 ? rows[0]!.window!.costPerLead : null;
    const each = own ?? (leads ? spend / leads : null);
    return {
      value: count(leads),
      sub: also(
        each === null ? "no cost per lead" : `${inCurrency(each, one.currency)} each`,
        M.attribution,
      ),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  /*
    RETURN ON AD SPEND — THE CARD THAT SAYS WHY THERE IS NO NUMBER.

    The catalog sample read "2.8× · blended, 30d" and both halves were wrong:
    blended is the one shape a ROAS may never take (it is a ratio of two figures
    that can be in different currencies and on different attribution windows),
    and there is no ROAS here at all to blend. `purchase_roas` is asked for on
    every insights call and this account has never returned it, because it buys
    lead forms — there is no purchase and therefore no revenue to divide by.

    So the card keeps its key, because a saved board points at it, and becomes
    the evidence rather than the verdict: what was asked, what came back, and
    what this account measures instead. The same move the Replicate cost card
    and Cloudflare's token card make. It fills itself the day a purchase
    campaign runs — `roas` is read from the payload, not hard-coded — and until
    then it says so.
  */
  "meta.roas": ({ meta: M }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    const reported = M.adAccounts.filter(
      (a) => a.window?.roas !== null && a.window?.roas !== undefined,
    );
    if (reported.length) {
      /* A real ROAS, per account and never blended: two accounts' ratios are
         over two spends in two possible currencies on their own windows. */
      const rows: [string, string][] = reported.map((a) => [
        a.name ?? a.id,
        `${a.window!.roas!.toFixed(2)}× · ${windowSpan(a.window!.from, a.window!.to)}`,
      ]);
      rows.push(["Attribution", M.attribution]);
      rows.push(["Per account", "never blended — two spends, two currencies"]);
      return { rows };
    }
    const leads = one?.accounts.reduce((n, a) => n + (a.window?.leads ?? 0), 0) ?? null;
    const rows: [string, string][] = [
      ["purchase_roas", "absent from every row"],
      ["action_values (revenue)", "absent from every row"],
      ["What this account buys", "lead-form submissions, not purchases"],
    ];
    if (leads !== null && one)
      rows.push([
        `Leads · ${M.attribution}`,
        `${count(leads)} at ${inCurrency(
          one.accounts.reduce((n, a) => n + (a.window?.spend ?? 0), 0) / (leads || 1),
          one.currency,
        )} each`,
      ]);
    rows.push(["Why no ratio", "ROAS needs a revenue figure Meta was never given"]);
    return { rows };
  },

  /*
    THE DAILY LINE, AND THE DAYS THAT ARE NOT IN IT.

    Meta returns a row only for a day that delivered, so the twelve bars here
    are twelve days out of a thirty-day window rather than a series with
    eighteen zeroes in it. That distinction is the card: the spend did not fall
    away gradually, it stopped — and a chart that drew the silent days as
    measured zeroes would show a decline nobody chose. The caption says how many
    days of the window actually carried delivery.

    BARS RATHER THAN A LINE, for the reason the costs board's spend charts are
    bars: the `chart` kind draws a labelled axis in percent, bytes, count or
    USD, and this money is EUR. A euro series on a dollar axis would be
    captioned in a unit nobody measured.
  */
  "meta.daily": ({ meta: M }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    if (!one) return null;
    /* One account's own series. With several, this would be a sum across
       accounts in one currency, which is legitimate — but only in one
       currency, which `oneCurrency` has already established. */
    const byDay = new Map<string, number>();
    for (const a of one.accounts)
      for (const d of a.daily)
        if (d.spend !== null) byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.spend);
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (!days.length) return null;
    const label = (day: string) =>
      new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      });
    return {
      bars: days.map(([, v]) => v),
      barLabels: days.map(([d, v]) => `${label(d)} · ${inCurrency(v, one.currency)}`),
      labels:
        `${days.length} day${days.length === 1 ? "" : "s"} delivered of ` +
        `${M.windowDays} · ${label(days[0]![0])} to ${label(days.at(-1)![0])}` +
        (days.length < M.windowDays ? " · the rest of the window had none" : ""),
    };
  },

  /*
    WHERE THE MONEY WENT, as a table rather than as a bar per campaign.

    "Which of these was worth running" is a question about the set, and the
    columns that answer it — spend, clicks and the people they reached — cannot
    be read off bar heights. The last row names what was left out WITH its
    figures, the way the Search Console properties table does: fourteen
    campaigns of which five delivered is a fact about the account, and "+9 more"
    would hide it.

    REACH IS A COLUMN AND NEVER A TOTAL. Its footer row carries a dash rather
    than a sum for exactly the reason the wire's `reachNote` gives: two
    campaigns that reached the same person each counted them once.
  */
  "meta.campaigns": ({ meta: M }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    if (!one) return null;
    const all = one.accounts.flatMap((a) => a.campaigns);
    if (!all.length) return null;
    const delivered = all
      .filter((c) => (c.window?.spend ?? 0) > 0)
      .sort((a, b) => (b.window?.spend ?? 0) - (a.window?.spend ?? 0));
    const shown = delivered.slice(0, 6);
    const table = shown.map((c) => [
      campaignName(c.name),
      inCurrency(c.window?.spend ?? 0, one.currency),
      count(c.window?.clicks ?? null),
      count(c.window?.reach ?? null),
      /* effective_status in the words a person reads. "CAMPAIGN_PAUSED" and
         "PAUSED" are the same fact to somebody looking at a campaign row. */
      (c.status ?? "—").replace(/^CAMPAIGN_/, "").toLowerCase(),
    ]);
    const idle = all.length - delivered.length;
    if (idle > 0 || delivered.length > shown.length)
      table.push([
        `${all.length} campaigns in all · ${idle} spent nothing in the window`,
        delivered.length > shown.length
          ? inCurrency(
              delivered.slice(shown.length).reduce((n, c) => n + (c.window?.spend ?? 0), 0),
              one.currency,
            )
          : "—",
        "—",
        /* Not a sum. Reach de-duplicates per row and adding these would count
           the same person once per campaign they were in. */
        "never summed",
        "",
      ]);
    return { headers: ["Campaign", "Spend", "Clicks", "Reached", "Status"], table };
  },

  /*
    THE PAGES, WHICH IS ALL A PAGE CAN SAY HERE.

    Followers is the only Page figure this token can measure — reach, views and
    post engagement are all gone or all behind a Page Access Token — so this is
    a follower count per Page and honest about being one. Followers DO add up
    across Pages, unlike everything on the ads side: a follower follows exactly
    one Page, so there is no de-duplication to get wrong.
  */
  "meta.pages": ({ meta: M }: LiveInputs) => {
    if (!M?.pages.length) return null;
    const rows: [string, string][] = M.pages
      .slice(0, 6)
      .map((p) => [
        p.name ?? p.id,
        /* Null is not nought. A Page whose count Meta did not report gets a
           dash, and a Page with one follower says one. */
        p.followers === null
          ? "not reported"
          : `${count(p.followers)} follower${p.followers === 1 ? "" : "s"}`,
      ]);
    const known = M.pages.filter((p) => p.followers !== null);
    if (known.length > 1)
      rows.push([
        `${M.pages.length} Pages`,
        `${count(known.reduce((n, p) => n + (p.followers ?? 0), 0))} followers in all`,
      ]);
    return { rows };
  },

  /*
    WHAT THIS TOKEN WILL NOT READ — the card that keeps the others honest, the
    same shape the costs board carries for Replicate and the traffic board for
    Cloudflare.

    It matters more here than in either of those, because two of its lines are
    the reason a card a reader expects to find is missing. Somebody looking for
    Page reach finds that the metric was retired and that the Page endpoints
    need a token this system user cannot mint — rather than concluding the
    collector is broken and re-pasting a credential that works perfectly.
  */
  "meta.cannot": ({ meta: M }: LiveInputs) => {
    if (!M) return null;
    const rows: [string, string][] = M.cannot.asked.map(
      (a) => [a.asked, a.answer] as [string, string],
    );
    rows.push(["Checked", `${M.cannot.checkedOn} · Graph ${M.graphVersion}`]);
    return { rows };
  },

  /*
    INSTAGRAM: CONNECTED, AND THERE IS NOTHING TO READ.

    This is the card the whole Instagram integration turns on, and it exists
    because that sentence is a THIRD state. The credential is not missing and it
    is not refused — it is a live system user token that lists three Pages by
    name — and every one of those Pages reports no linked Instagram Business
    account. Drawn as "0 followers" that is a measurement of an audience that
    was never measured; drawn as an error it sends somebody to re-paste a
    perfectly good token. It is drawn as what it is, with the one step that
    changes it.

    The card keeps the key `instagram.followers` because a saved board may point
    at it, and stops being a metric: there is no number here, and a metric card
    showing a dash says less than three lines saying which state this is.
  */
  "instagram.followers": ({ meta: M }: LiveInputs) => {
    if (!M) return null;
    const ig = M.instagram;
    if (ig.state === "linked") {
      const statuses: [string, StatusTone][] = ig.accounts.slice(0, 4).map((a) => [
        `${a.username ? `@${a.username}` : (a.pageName ?? "linked account")} · ${
          a.followers === null ? "followers not reported" : `${count(a.followers)} followers`
        }`,
        "ok",
      ]);
      statuses.push([
        `${ig.accounts.length} of ${ig.pagesChecked} Pages have one`,
        "ok",
      ]);
      return { statuses };
    }
    if (ig.state === "none-linked")
      return {
        statuses: [
          ["Meta token connected and working", "ok"],
          /* The pair of counts, not a boolean. "0 of 3" is the measurement:
             every Page was asked and every Page answered no. "No Instagram"
             alone could equally mean nobody looked. */
          [`No Instagram Business account on any of ${ig.pagesChecked} Pages`, "warn"],
          ["Fix: link one to a Page in Meta Business Suite", "warn"],
        ] as [string, StatusTone][],
      };
    if (ig.state === "no-pages")
      return {
        statuses: [
          ["Meta token connected", "ok"],
          ["It lists no Pages, so no Page could be asked", "warn"],
          ["Assign the Pages to the system user in Business settings", "warn"],
        ] as [string, StatusTone][],
      };
    return null;
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ------------------------------------------------------------------ demand */

/**
 * The three sources that measure what strangers said.
 *
 * EVERY BUILDER HERE HAS THE SAME JOB BESIDE ITS OWN: keeping "nobody is
 * talking about this" apart from "nobody would let us look". Both produce no
 * rows, and only one of them is a finding — so a card here never prints a
 * count without the status behind it, and a phrase that was throttled or
 * deferred is named on the card rather than quietly missing from a total.
 *
 * WHAT NO CARD DOES is add a Reddit upvote to a Hacker News point. Threads add
 * across the two sources, because a thread is a thread; engagement does not,
 * because two crowds' currencies have no exchange rate. `demand.new` is the
 * only card that spans them and it counts THREADS.
 */

/** "3d", "5h", "just now" — an age from days, for a row that has one. Null
 *  where the tier could not date the thread, which is a state and not a zero. */
function ageShort(days: number | null): string {
  if (days === null) return "undated";
  if (days < 1 / 24) return "just now";
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 90) return `${Math.round(days)}d`;
  return `${Math.round(days / 30.44)}mo`;
}

/** A thread's engagement as its own source reported it, or the reason there
 *  is none. NEVER "0 pts": a comment Algolia does not score and a thread SearXNG
 *  merely found are unmeasured, and a zero would be the only invented number on
 *  the card. */
function engagement(sig: DemandSignal): string {
  if (sig.points === null)
    return sig.tier === "searxng"
      ? "unscored (web index)"
      : sig.context === "comment"
        ? "comments carry no score"
        : "unscored";
  const replies =
    sig.comments === null ? "" : ` · ${count(sig.comments)} repl${sig.comments === 1 ? "y" : "ies"}`;
  return `${count(sig.points)} pts${replies}`;
}

/** What a phrase's answer was, in a word a table cell can hold. */
function queryCell(q: DemandQuery | undefined): string {
  if (!q) return "—";
  switch (q.status) {
    case "ok":
      /* Zero is a real answer here and is printed as one. It is the whole
         reason the status travels beside the count. */
      return q.items === 0 ? "0 — nobody" : count(q.items);
    case "throttled":
      return "throttled";
    case "skipped":
      return "next in line";
    case "unasked":
      return "not asked yet";
    default:
      return "failed";
  }
}

const shorten = (text: string, n = 52) =>
  text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text;

Object.assign(LIVE_BUILDERS, {
  /*
    REDDIT'S THREADS, NEWEST FIRST — and the row under them that says what the
    list is a list OF.

    A card showing five titles and nothing else invites the reading that five
    is the number, so the last row carries the real count and the phrases it
    came from. Where a tier could not date or score a thread the row says so in
    the place a number would have been, because "unscored (web index)" and
    "0 pts" are opposite claims.
  */
  "reddit.signals": ({ demand: D }: LiveInputs) => {
    if (!D?.reddit.seenAt) return null;
    const signals = D.reddit.signals
      .slice()
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const rows: [string, string][] = signals
      .slice(0, 5)
      .map((s) => [
        shorten(s.title),
        `${s.context ?? "reddit"} · ${engagement(s)} · ${ageShort(s.ageDays)}`,
      ]);

    if (!rows.length)
      rows.push([
        /* ASKED AND NOTHING CAME BACK IS A FINDING, and it is drawn as one
           rather than as an empty card — but only when the phrases really were
           asked, which the statuses below distinguish. */
        `Nothing posted in ${D.windowDays} days for ${D.terms.length} phrase${
          D.terms.length === 1 ? "" : "s"
        }`,
        "asked and answered",
      ]);

    const unanswered = D.reddit.queries.filter((q) => q.status !== "ok");
    rows.push([
      `${count(D.reddit.threads)} thread${D.reddit.threads === 1 ? "" : "s"} · ${D.windowDays}d`,
      unanswered.length
        ? `${unanswered.length} phrase${unanswered.length === 1 ? "" : "s"} unanswered`
        : `${D.reddit.queries.length} phrases answered`,
    ]);
    if (D.reddit.unaged)
      rows.push([
        `${count(D.reddit.unaged)} more found through SearXNG`,
        "undated, so in no window",
      ]);
    return { rows };
  },

  /*
    HOW REDDIT WAS READ, WHICH IS PART OF WHAT THE NUMBERS ABOVE MEAN.

    Twelve threads from the Atom feed and twelve from a web index are different
    claims about the same twelve links: one set is dated and scored, the other
    is neither. This card is where that lives, along with the two facts that
    decide how much of the watch list gets asked at all — whether the account's
    feed token is lifting the one-a-minute throttle, and how many phrases were
    left for the next run because it is not.
  */
  "reddit.tier": ({ demand: D }: LiveInputs) => {
    if (!D?.reddit.seenAt) return null;
    const statuses: [string, StatusTone][] = D.reddit.tiers.map((t) => [
      `${t.queries} phrase${t.queries === 1 ? "" : "s"} · ${t.label}`,
      /* The fallback is not a failure and not a success. It is the safety net
         doing its job, and a card that coloured it green would be saying the
         unscored rows are as good as the scored ones. */
      t.tier === "searxng" ? "warn" : "ok",
    ]);

    statuses.push(
      D.reddit.token.held
        ? ["Feed token in use — no anonymous throttle", "ok"]
        : ["No feed token — one query a minute, so one phrase a collection", "warn"],
    );

    const deferred = D.reddit.queries.filter((q) => q.status === "skipped");
    const refused = D.reddit.queries.filter(
      (q) => q.status === "throttled" || q.status === "failed",
    );
    if (deferred.length)
      statuses.push([
        `${deferred.length} phrase${deferred.length === 1 ? "" : "s"} left for the next run: ${deferred
          .map((q) => q.term)
          .slice(0, 3)
          .join(", ")}`,
        "warn",
      ]);
    if (refused.length)
      statuses.push([
        `${refused.length} refused — ${shorten(refused[0]!.error ?? "no reason given", 60)}`,
        "bad",
      ]);
    if (!deferred.length && !refused.length)
      statuses.push([`Every phrase answered · asked every ${D.everyHours}h`, "ok"]);
    return { statuses };
  },

  /*
    WHERE THE THREADS ARE.

    A subreddit is the closest thing this data has to an audience, and the
    shape of the list is the finding: one busy subreddit is a place to be, and
    fifteen with one thread each is a phrase that is too general. Counted in
    THREADS rather than rows, because two watch phrases finding the same thread
    is one conversation.
  */
  "reddit.subs": ({ demand: D }: LiveInputs) => {
    const subs = D?.reddit.subreddits ?? [];
    if (!subs.length) return null;
    const shown = subs.slice(0, 8);
    return {
      bars: shown.map((s) => s.threads),
      barLabels: shown.map(
        (s) => `${s.name} · ${s.threads} thread${s.threads === 1 ? "" : "s"}`,
      ),
      labels: `${subs.length} subreddit${subs.length === 1 ? "" : "s"} · ${D!.windowDays}d${
        subs.length > shown.length ? ` · top ${shown.length} shown` : ""
      }`,
    };
  },

  /*
    HACKER NEWS, NEWEST FIRST, STORIES AND COMMENTS TOGETHER.

    The comments are why this source is here — they are where somebody says
    what they wish existed — and they are also why no count on this card is a
    score: Algolia's index does not publish a comment's points, so those rows
    say so in the place the number would be rather than carrying a zero that
    would rank them below every story forever.
  */
  "hn.mentions": ({ demand: D }: LiveInputs) => {
    if (!D?.hn.seenAt) return null;
    const rows: [string, string][] = D.hn.signals
      .slice()
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, 5)
      .map((s) => [
        shorten(`${s.context === "comment" ? "comment · " : ""}${s.title}`),
        `${engagement(s)} · ${ageShort(s.ageDays)}`,
      ]);
    if (!rows.length)
      rows.push([
        `Nothing in ${D.windowDays} days for ${D.terms.length} phrase${
          D.terms.length === 1 ? "" : "s"
        }`,
        "asked and answered",
      ]);
    rows.push([
      `${count(D.hn.threads)} in ${D.windowDays}d`,
      `${D.hn.stories} stor${D.hn.stories === 1 ? "y" : "ies"}, ${D.hn.comments} comment${
        D.hn.comments === 1 ? "" : "s"
      }`,
    ]);
    return { rows };
  },

  /*
    THE HACKER NEWS THREADS AS A TABLE, ordered by the one figure this source
    actually publishes.

    "Which of these is worth reading" is a question about the set, and points
    beside replies beside age is what answers it — three columns that cannot be
    read off a list of titles. The last row names what was left out WITH its
    figures, the way the Search Console properties table does, and it names the
    comments separately because they are not in the ranking at all: a row with
    no score cannot be ordered against rows that have one.
  */
  "hn.stories": ({ demand: D }: LiveInputs) => {
    if (!D?.hn.seenAt) return null;
    const scored = D.hn.signals
      .filter((s) => s.points !== null)
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
    if (!scored.length && !D.hn.comments) return null;
    const shown = scored.slice(0, 6);
    const table = shown.map((s) => [
      shorten(s.title, 46),
      count(s.points),
      count(s.comments),
      ageShort(s.ageDays),
    ]);
    const rest = scored.length - shown.length;
    if (rest > 0 || D.hn.comments)
      table.push([
        [
          rest > 0 ? `${rest} more scored thread${rest === 1 ? "" : "s"}` : "",
          D.hn.comments
            ? `${D.hn.comments} comment${D.hn.comments === 1 ? "" : "s"} — the index carries no score for those`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
        rest > 0 ? count(scored.slice(shown.length).reduce((n, s) => n + (s.points ?? 0), 0)) : "—",
        "—",
        "—",
      ]);
    return { headers: ["Thread", "Points", "Replies", "Age"], table };
  },

  /*
    THE SEARCH NODE — the card that used to promise a number nobody counts.

    "Agent searches · 24h · 186" was a sample describing a measurement that
    does not exist: the node publishes no query counter anywhere, its /stats
    page is HTML and counts engines, and this box is not the only thing that
    searches through it. What IS measurable is whether a search made right now
    comes back with anything and which engines served it — and that turns out
    to be the more important question, because a node down to one engine still
    answers ten links and still looks perfectly healthy.
  */
  "searxng.queries": ({ demand: D }: LiveInputs) => {
    const node = D?.searxng;
    if (!node?.probe) return null;
    const probe = node.probe;
    const statuses: [string, StatusTone][] = [];

    if (!probe.ok) {
      statuses.push([`The node did not answer — ${shorten(probe.error ?? "no reason given", 60)}`, "bad"]);
      statuses.push([node.url.replace(/^https?:\/\//, ""), "warn"]);
      statuses.push(["Every agent search goes through this node", "warn"]);
      return { statuses };
    }

    const total = (probe.enginesOk ?? 0) + (probe.enginesRefused ?? 0);
    statuses.push([
      `${count(probe.results)} results in ${count(probe.ms)}ms for “${probe.query ?? "a probe"}”`,
      "ok",
    ]);
    statuses.push([
      `${probe.enginesOk} of ${total} engines answered`,
      /* One engine is not a metasearch node, however healthy the response
         looks. Two is thin. Everything else is fine. */
      (probe.enginesOk ?? 0) <= 1 ? "bad" : (probe.enginesOk ?? 0) <= 2 ? "warn" : "ok",
    ]);
    /*
      TEN RESULTS IS NOT TEN ANSWERS, and this is the line that says so. The
      probe is a site:reddit.com search — the query Reddit's fallback tier
      actually makes — and on the day this was written it came back with ten
      links about free browser games, because the one engine still answering
      had ignored the site restriction and the query with it. A results count
      reads that as perfect health; this reads it as what it is, and it is a
      harder failure than a refusing engine because the node still looks well.
    */
    statuses.push([
      probe.onSite === null
        ? `Relevance not measured on this probe`
        : probe.onSite === 0 && (probe.results ?? 0) > 0
          ? `NONE of ${count(probe.results)} results were on ${probe.site} — the engines are ignoring site:, so Reddit's fallback cannot answer`
          : `${count(probe.onSite)} of ${count(probe.results)} results on ${probe.site}, which is what the Reddit fallback needs`,
      probe.onSite === null
        ? "warn"
        : probe.onSite === 0 && (probe.results ?? 0) > 0
          ? "bad"
          : "ok",
    ]);
    statuses.push([
      node.standIns
        ? `Stood in for Reddit on ${node.standIns} phrase${node.standIns === 1 ? "" : "s"} — those rows are unscored`
        : "Reddit has not needed the fallback",
      node.standIns ? "warn" : "ok",
    ]);
    /* The line that replaces the card's old promise. It is a permanent
       property of the API rather than a state, so it is drawn every time. */
    statuses.push([
      `Query volume: not published — /stats is HTML and counts engines (${node.cannot.checkedOn})`,
      "warn",
    ]);
    return { statuses };
  },

  /*
    WHICH ENGINES ARE ACTUALLY SERVING, in the node's own words.

    This is the measurement nothing else on the box can make. On the probe that
    built this card brave answered "Suspended: too many requests", duckduckgo
    answered with a CAPTCHA and qwant answered "access denied" — so every
    result came from Bing alone, and every agent search made through this node
    is a Bing search wearing a metasearch coat. The reasons are kept verbatim
    because they are different problems: a CAPTCHA is an IP that has been
    noticed, a suspension is a budget that will come back on its own.
  */
  "searxng.engines": ({ demand: D }: LiveInputs) => {
    const engines = D?.searxng.engines ?? [];
    if (!engines.length) return null;
    const rows: [string, string][] = engines
      .slice(0, 6)
      .map((e) => [
        e.engine,
        e.refused
          ? `refused — ${shorten(e.refused, 34)}`
          : `${count(e.results)} result${e.results === 1 ? "" : "s"}`,
      ]);
    const answering = engines.filter((e) => !e.refused).length;
    rows.push([
      `${answering} of ${engines.length} answering`,
      /* Only the engines this probe HEARD FROM are here — the node has 244
         configured and asks a handful per query, so this is never a census of
         what it could use. */
      "on the last probe, not a full list",
    ]);
    return { rows };
  },

  /*
    HOW LONG THE NODE TAKES, which is the one series any of these three
    sources can honestly produce.

    Everything else here is a count over a window and is computed on the read;
    this is a single instantaneous figure about the node as it stands, sampled
    once a collection, so a series of it means something. It is drawn with no
    threshold and no verdict: what "slow" is for a metasearch node depends on
    which engines answered, and the card beside it is where that lives.
  */
  "searxng.latency": ({ demand: D, points }: LiveInputs) => {
    const probe = D?.searxng.probe;
    if (!probe?.ok || probe.ms === null) return null;
    return {
      value: `${count(probe.ms)}ms`,
      sub: also(
        `${count(probe.results)} results, ${probe.enginesOk} engine${probe.enginesOk === 1 ? "" : "s"}`,
        points.length > 1 ? `${points.length} probes` : "",
      ),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
      seriesAt: points.length > 1 ? points.map((p) => p.ts) : undefined,
    };
  },

  /*
    NEW TO THIS BOARD — the one figure that spans both social sources, and it
    counts THREADS because a thread is a thread whichever site it was posted
    on. Upvotes are not added across them anywhere, here least of all.
    
    IT IS "NEW TO US" AND NOT "NEW". A thread posted in March and first seen
    this morning is genuinely new to this dashboard and genuinely not news, so
    the caption says how long we have been looking — and on the first day,
    when everything is new, it says that instead of implying a spike.
  */
  "demand.new": ({ demand: D }: LiveInputs) => {
    if (!D || (!D.reddit.seenAt && !D.hn.seenAt)) return null;
    const since = D.collectingSince ? Date.parse(D.collectingSince) : null;
    const days = since === null ? null : (Date.now() - since) / 86_400_000;
    const young = days !== null && days < D.windowDays;
    return {
      value: count(D.totals.newHere),
      sub: young
        ? /* On the first morning this figure is every thread the sources have
             ever handed back, and saying "new" about it without saying that
             would draw a spike out of the moment collection started. */
          `every thread found so far — collection began ${ageShort(days)}${
            days !== null && days < 1 / 24 ? "" : " ago"
          } · ${count(D.totals.threads)} of them posted inside ${D.windowDays}d`
        : `first seen here in ${D.windowDays}d · ${count(D.totals.threads)} threads posted in that window`,
    };
  },

  /*
    EVERY PHRASE, AND WHAT ANSWERED — the card that keeps the others honest,
    the same job "What the query rows cover" does for Search Console.

    A count with no status behind it cannot tell "nobody is talking about this"
    from "nobody would let us look", and those are the two answers this whole
    integration exists to keep apart. So every phrase is a row whatever
    happened to it, a zero is printed as "0 — nobody" rather than as a blank,
    and a phrase that was throttled or deferred says which.
  */
  "demand.coverage": ({ demand: D }: LiveInputs) => {
    if (!D?.terms.length) return null;
    const reddit = new Map(D.reddit.queries.map((q) => [q.term, q] as const));
    const hn = new Map(D.hn.queries.map((q) => [q.term, q] as const));
    const table = D.terms
      .slice(0, 8)
      .map((term) => [shorten(term, 34), queryCell(reddit.get(term)), queryCell(hn.get(term))]);
    if (D.terms.length > 8)
      table.push([`${D.terms.length - 8} more phrases`, "—", "—"]);
    table.push([
      `${count(D.totals.threads)} threads in ${D.windowDays}d`,
      /* Threads, not rows, and per source — the two columns are never added
         together on this card even though the board's total does add them:
         here they are two answers about two crowds. */
      count(D.reddit.threads),
      count(D.hn.threads),
    ]);
    return { headers: ["Phrase", "Reddit", "Hacker News"], table };
  },

  /* ---------------------------------------------------------------- mail */

  /*
    WHAT IS WAITING ON A REPLY, WHICH IS NOT WHAT IS UNREAD.

    The catalog card was already named for the right thing and now draws it:
    threads whose last message came from somebody else and has neither a reply
    nor a draft against it, over a thirty-day window, with Gmail's Promotions,
    Social and Forums excluded in the query. On this mailbox that is a handful
    against 263 unread — which is exactly why the two are separate cards.

    THE COUNT SAYS WHEN IT IS A FLOOR. The per-thread read is the only way to
    learn who wrote last, so the run carries a budget; a scan that hit it
    reports "at least N" rather than N, because a queue quietly capped at 250 is
    a queue somebody stops trusting the day they find out.
  */
  "gmail.unread": ({ mail: M, points }: LiveInputs) => {
    if (!M?.connected.gmail) return null;
    const { needingReply, oldestWaitingDays, scanned, floor } = M.inbox;
    if (needingReply === null) return null;
    return {
      value: floor ? `${count(needingReply)}+` : count(needingReply),
      tone: needingReply === 0 ? "ok" : needingReply > 20 ? "warn" : undefined,
      sub: also(
        oldestWaitingDays === null
          ? "no age reported"
          : oldestWaitingDays === 0
            ? "oldest arrived today"
            : `oldest is ${oldestWaitingDays}d old`,
        floor
          ? `a floor — ${count(scanned)} of the newest threads were checked`
          : `${count(scanned)} threads checked`,
      ),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  /*
    THE UNREAD COUNTER, AND IT IS GMAIL'S OWN RATHER THAN A SEARCH.

    `labels.get` answers with exact counters for one request. The obvious
    alternative — a search for `is:unread in:inbox` — returns a
    `resultSizeEstimate`, and on this mailbox that estimate said 201 against a
    true 263. Threads rather than messages, because a thread is one thing to
    deal with and a forty-message thread is not forty of them; the message count
    goes in the subtitle so the card says which it drew.
  */
  "gmail.inbox": ({ mail: M, points }: LiveInputs) => {
    if (!M?.connected.gmail) return null;
    const { unreadThreads, unreadMessages, mailboxes } = M.inbox;
    if (unreadThreads === null && unreadMessages === null) return null;
    return {
      value: count(unreadThreads ?? unreadMessages),
      sub: also(
        unreadThreads !== null && unreadMessages !== null
          ? `threads — ${count(unreadMessages)} messages`
          : "Gmail's own counter",
        mailboxes > 1 ? `across ${mailboxes} mailboxes` : "",
      ),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
    };
  },

  /*
    PEOPLE YOU WROTE TO, COUNTED FROM SENT MAIL.

    The sample promised first-time SENDERS, which needs every sender the mailbox
    has ever had — 97,472 messages of history — and would make a mailing-list
    census out of an inbox that is 30% promotions. Sent mail answers the
    neighbouring question and answers it cleanly: nobody was ever subscribed to
    a newsletter by writing to it.

    "NEW" IS ONLY AS GOOD AS THE HISTORY IT IS NEW AGAINST, so the card says how
    far back that history goes. On a first collection the lookback is ninety
    days of sent mail and every contact in the window is new against it; the
    caption states the span rather than letting the figure imply a lifetime.
  */
  "gmail.contacts": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.gmail) return null;
    const { people, new: fresh, historyFrom, windowDays } = M.outreach;
    if (!M.mailboxes.length) return null;
    return {
      value: count(people),
      sub: also(
        `${count(fresh)} first written to in these ${windowDays}d`,
        historyFrom
          ? `judged against sent mail back to ${shortDay(historyFrom)}`
          : "no sent-mail history yet",
      ),
    };
  },

  /*
    MAIL ARRIVING, ON ITS OWN AXIS AND WITHOUT TODAY.

    Sent mail runs about twenty times smaller here, so it is not a second line —
    on a shared axis starting at zero it would be a flat line along the bottom
    impersonating a measurement, which is the call `gsc.trend` makes about
    clicks. And today is left off: the mailbox will receive more of it after
    this reading, so drawn beside finished days it is a cliff that never
    happened.
  */
  "gmail.volume": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.gmail) return null;
    const days = M.volume.byDay.filter((d) => !d.partial && d.received !== null);
    if (days.length < 2) return null;
    const total = days.reduce((n, d) => n + (d.received ?? 0), 0);
    return {
      unit: "count" as const,
      chart: [
        {
          label: "Received",
          points: days.map((d) => ({
            ts: `${d.day}T00:00:00Z`,
            value: d.received ?? 0,
          })),
        },
      ],
      caption: also(
        `${count(total)} over ${days.length} complete days`,
        M.volume.sent === null
          ? "sent mail not counted"
          : `${count(M.volume.sent)} sent over the same days — counted apart, never added`,
      ),
    };
  },

  /*
    THE QUEUE, PER LABEL — AND THE FOOTER ROW IS THE POINT.

    A thread can carry INBOX and a hand-made label at once, so these rows DO NOT
    ADD UP and the table says so instead of carrying a total that double-counts.
    It is the rule GitHub's unique visitors and Cloudflare's visitors follow, in
    a place it is much easier to get wrong because labels look like folders.

    A label the scan never reached prints a dash rather than a zero: nobody
    looked is not the same as nothing is waiting.
  */
  "gmail.labels": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.gmail) return null;
    const labels = M.mailboxes.flatMap((m) => m.labels);
    if (!labels.length) return null;
    const rank = (l: MailLabel) =>
      (l.needingReply ?? -1) * 1000 + (l.threadsUnread ?? 0);
    const shown = [...labels]
      .sort((a, b) => (a.id === "INBOX" ? -1 : b.id === "INBOX" ? 1 : rank(b) - rank(a)))
      .slice(0, 10);
    const table = shown.map((l) => [
      l.name,
      count(l.threadsTotal),
      count(l.threadsUnread),
      l.needingReply === null
        ? "—"
        : l.truncated
          ? `${count(l.needingReply)}+`
          : count(l.needingReply),
      l.oldestWaitingDays === null ? "—" : `${l.oldestWaitingDays}d`,
    ]);
    table.push([
      labels.length > shown.length
        ? `${labels.length - shown.length} more · rows never add up`
        : "rows never add up",
      "—",
      "—",
      "a thread can carry two labels",
      "—",
    ]);
    return { headers: ["Label", "Threads", "Unread", "Waiting", "Oldest"], table };
  },

  /*
    THE MAILBOX, AND THE SENTENCE THIS DASHBOARD OWES ITS READER.

    The token in the vault carries `gmail.modify` — archive, label, trash — and
    a card that quietly omitted that would be hiding the most consequential fact
    about the credential. It says so, and then says why it does not matter: the
    provider has one HTTP entry point, it hard-codes GET, and it takes no body,
    so the extra power is a property of the token and never of what happens to
    the mail. The same evidence shape Cloudflare's token card takes, pointed the
    other way — that one is about power the token lacks.
  */
  "gmail.mailbox": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.gmail) return null;
    const box: Mailbox | undefined = M.mailboxes[0];
    if (!box) return null;
    const scopes = box.scopes.map((s) => s.split("/").pop() ?? s);
    const rows: [string, string][] = [
      ["Mailbox", box.address ?? "not reported"],
      [
        "Held",
        `${count(box.messagesTotal)} messages · ${count(box.threadsTotal)} threads`,
      ],
      ["Labels", count(box.labelsTotal)],
      ["Token scopes", scopes.join(", ") || "not reported"],
      [
        scopes.some((s) => s === "gmail.modify")
          ? "gmail.modify can write"
          : "This dashboard",
        "reads only — one GET-only entry point, no body, no send path",
      ],
    ];
    if (M.mailboxes.length > 1)
      rows.push(["Other mailboxes", `${M.mailboxes.length - 1} more connected`]);
    return { rows };
  },

  /*
    RESEND'S VOLUME CARD, WHICH ONLY EXISTS BECAUSE THE LIST ENDPOINT DOES.

    `GET /emails` pages with a cursor and carries `last_event`, so this is a
    count of real rows rather than an inference. Had it not existed there would
    have been no send figure at all and this card would have had to say so — the
    move `replicate.gpu` made about GPU seconds.
  */
  "resend.sends": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.resend) return null;
    const s = M.sending;
    if (!M.sendingDomains.length) return null;
    return {
      value: s.floor ? `${count(s.sent)}+` : count(s.sent),
      sub: also(
        `${s.domains} sending domain${s.domains === 1 ? "" : "s"}, ${s.verified} verified`,
        `${count(s.delivered)} delivered`,
      ),
      series: s.byDay.length > 1 ? s.byDay.map((d) => d.sent) : undefined,
      seriesAt: s.byDay.length > 1 ? s.byDay.map((d) => `${d.day}T00:00:00Z`) : undefined,
    };
  },

  /*
    THE BOUNCE RATE, WITH ITS DENOMINATOR NAMED.

    There are three defensible ones and they disagree. This is over mail that
    actually reached a mail server — delivered + bounced + complained — and NOT
    over everything sent, because `suppressed` is Resend declining to send at
    all to an address already on its own list. Counting suppressions in the
    denominator would make a domain's bounce rate FALL every time Resend refused
    to try, which is the wrong direction for a number somebody acts on.
  */
  "resend.bounce": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.resend) return null;
    const s = M.sending;
    if (s.bounceRate === null) return null;
    const worst = [...M.sendingDomains]
      .filter((d) => d.sends.bounceRate !== null && d.sends.attempted >= 10)
      .sort((a, b) => (b.sends.bounceRate ?? 0) - (a.sends.bounceRate ?? 0))[0];
    return {
      value: percent(s.bounceRate, 1),
      tone: s.bounceRate >= 5 ? "bad" : s.bounceRate >= 2 ? "warn" : "ok",
      sub: also(
        `${count(s.bounced)} of ${count(s.attempted)} that reached a server`,
        worst && worst.sends.bounceRate !== null
          ? `worst: ${worst.name} at ${percent(worst.sends.bounceRate, 1)}`
          : "",
      ),
    };
  },

  "resend.daily": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.resend) return null;
    const days = M.sending.byDay;
    if (days.length < 2) return null;
    return {
      unit: "count" as const,
      chart: [
        {
          label: "Sent",
          points: days.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.sent })),
        },
      ],
      /* No partial-bucket caveat here, and the difference from Gmail's line is
         real: an email Resend has accepted is a row the moment it exists, so
         today's bar is complete for everything sent so far. What can still
         change is each row's own last_event, which a re-read corrects. */
      caption: also(
        `${count(M.sending.sent)} over ${days.length} days, ${M.sending.domains} domains`,
        "bounces are counted apart — see the bounce card",
      ),
    };
  },

  /*
    EVERY SENDING DOMAIN, WITH RESEND'S OWN WORD FOR ITS STATE.

    Not a green/red pair: "pending" is a domain part-way through verification
    and "failed" is one that will not send, and only the second is a thing to go
    and fix tonight. A domain that is verified but has an unverified DNS record
    under it reads as a warning here rather than as fine, because that is a
    domain about to stop sending.
  */
  "resend.domains": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.resend || !M.sendingDomains.length) return null;
    const tone = (d: SendingDomain): StatusTone =>
      d.status !== "verified"
        ? d.status === "pending"
          ? "warn"
          : "bad"
        : d.dns.unhealthy.length
          ? "warn"
          : "ok";
    const statuses: [string, StatusTone][] = M.sendingDomains
      .slice(0, 12)
      .map((d) => [
        `${d.name} · ${d.status ?? "state not reported"}${
          d.dns.unhealthy.length ? ` · ${d.dns.unhealthy.length} DNS record pending` : ""
        }`,
        tone(d),
      ]);
    if (M.sendingDomains.length > statuses.length)
      statuses.push([
        `${M.sendingDomains.length - statuses.length} more domains`,
        "ok",
      ]);
    return { statuses };
  },

  /*
    DNS HEALTH, WHICH THE LISTING ENDPOINT CANNOT SHOW.

    `GET /domains` says "verified"; only the per-domain call carries the records
    and their individual statuses. This is the only place on the board where a
    domain that is verified today and has a pending DKIM record is visible as
    such. A domain whose records could not be read prints as unread rather than
    as zero records, which is a different and much more alarming claim.
  */
  "resend.dns": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.resend || !M.sendingDomains.length) return null;
    const rows: [string, string][] = [
      [
        "Records verified",
        M.dns.records === null
          ? "—"
          : `${count(M.dns.verified)} of ${count(M.dns.records)} across ${M.dns.domains} domains`,
      ],
    ];
    for (const bad of M.dns.unhealthy.slice(0, 4))
      rows.push([bad.domain, `${bad.records.join(", ")} — ${bad.status.join(", ")}`]);
    if (!M.dns.unhealthy.length)
      rows.push(["Nothing pending", "every record Resend named is verified"]);
    if (M.dns.unread)
      rows.push([
        `${M.dns.unread} domain${M.dns.unread === 1 ? "" : "s"} not read`,
        "records unavailable — not zero records",
      ]);
    const regions = M.sending.regions.filter((r): r is string => !!r);
    if (regions.length) rows.push(["Sending regions", regions.join(", ")]);
    return { rows };
  },

  /*
    WHAT BECAME OF THE MAIL, with `suppressed` on its own line.

    Resend reports the LATEST event rather than a history, so these buckets are
    mutually exclusive and every email is in exactly one — which is what makes
    them addable at all. Anything Resend has not finished with is `in flight`
    rather than a failure, because a queued email has not gone wrong.

    Opens and clicks are named as absent rather than left off, because their
    absence is a measurement: tracking is switched off on every domain here, so
    Resend never writes an `opened` event and an open rate would be a figure
    about a feature nobody turned on.
  */
  "resend.outcomes": ({ mail: M }: LiveInputs) => {
    if (!M?.connected.resend || !M.sendingDomains.length) return null;
    const s = M.sending;
    const tracked = M.sendingDomains.filter((d) => d.tracking.open === true).length;
    const rows: [string, string][] = [
      ["Delivered", `${count(s.delivered)} · ${percent(s.deliveryRate, 1)}`],
      ["Bounced", `${count(s.bounced)} · ${percent(s.bounceRate, 1)}`],
      ["Spam complaints", `${count(s.complained)} · ${percent(s.complaintRate, 2)}`],
      [
        "Suppressed before sending",
        `${count(s.suppressed)} — never reached a server, so in no rate above`,
      ],
    ];
    if (s.inFlight) rows.push(["Still in flight", count(s.inFlight)]);
    rows.push([
      "Opened / clicked",
      tracked
        ? `tracking on for ${tracked} domain${tracked === 1 ? "" : "s"}`
        : "not measurable — tracking is off on every domain",
    ]);
    return { rows };
  },

  /*
    THE CARD THAT KEEPS THE OTHERS HONEST, the same shape the costs board
    carries for Replicate and the traffic board for Cloudflare. A reader who
    goes looking for an open rate or a monthly send allowance finds the request
    that was made and the answer that came back, with the date it was checked,
    rather than assuming the collector is broken and re-pasting a good key.
  */
  "mail.cannot": ({ mail: M }: LiveInputs) => {
    if (!M) return null;
    if (!M.connected.gmail && !M.connected.resend) return null;
    const rows: [string, string][] = M.cannot
      .slice(0, 5)
      .map((c) => [c.what, `${c.answer.split(".")[0]!.trim()} (${c.asked})`]);
    rows.push(["Checked", M.cannot[0]?.checked ?? "—"]);
    return { rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ================================================================ umami ==
   Self-hosted analytics. Two refusals travel through every builder below and
   both are the route's own: there is NO portfolio visitor count, because Umami
   de-duplicates per website and no endpoint joins identity across them; and
   the top-N lists are RANKINGS of a list Umami already truncated, so nothing
   here totals them or presents them as a share of anything.
*/

/** The name a site is known by on a card: its domain first, because that is
 *  what a reader recognises and what a venture link matches on. */
const siteName = (w: UmamiWebsite) => w.domain ?? w.name ?? w.entity;

/** Seconds as a duration a person reads — "1m 47s". Never decimal minutes:
 *  "1.8 minutes" is a number nobody has ever said out loud. */
function secs(n: number | null): string {
  if (n === null) return "—";
  const s = Math.round(n);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The top N of a set of per-site rankings, merged.
 *
 * MERGED AND NOT ADDED, which is the whole care in this function. Each row
 * belongs to exactly one website — a path is a path on one site — so putting
 * two sites' rows in one list and ordering by count is a legitimate ranking of
 * rows. What would not be legitimate is summing rows that share a name across
 * sites: "/pricing" on two different products is two different pages, so the
 * site is prefixed onto the label rather than being collapsed away.
 */
function mergedTop(
  websites: UmamiWebsite[],
  pick: (w: UmamiWebsite) => { name: string; count: number }[],
  limit = 8,
): [string, string][] {
  const many = websites.length > 1;
  return websites
    .flatMap((w) =>
      pick(w).map((r) => ({
        label: many ? `${siteName(w)} ${r.name}` : r.name,
        count: r.count,
      })),
    )
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((r) => [r.label, count(r.count)] as [string, string]);
}

Object.assign(LIVE_BUILDERS, {
  "umami.pageviews": ({ umami: U }: LiveInputs) => {
    const p = U?.portfolio;
    if (!p?.answering || p.window.pageviews === null) return null;
    return {
      value: count(p.window.pageviews),
      sub: also(
        `${p.answering} of ${p.websites} site${p.websites === 1 ? "" : "s"} answering`,
        movedBy(p.deltas.pageviews, p.window.days),
      ),
      series: p.days.length > 1 ? p.days.map((d) => d.pageviews) : undefined,
      seriesAt: p.days.length > 1 ? p.days.map((d) => at(d.day)) : undefined,
    };
  },

  /*
    THE CARD THAT REFUSES TO ADD, and keeps its key while doing it.

    Umami counts a visitor once per website per window. Two sites' figures are
    therefore two answers about overlapping populations, and the only honest
    portfolio total is the one that exists when there is a single site — where
    "the portfolio" and "the site" are the same thing. With more than one, the
    card stops being a number and says which figures it is holding instead;
    every one of them is on `umami.sites` a row below. The same move
    `meta.roas` makes, for the same reason: a key a saved board points at is
    worth more than a card, and a wrong number is worth less than neither.
  */
  "umami.visitors": ({ umami: U }: LiveInputs) => {
    const p = U?.portfolio;
    if (!p?.answering) return null;
    const sites = p.visitors.perSite.filter((s) => s.visitors !== null);
    if (!sites.length) return null;
    if (sites.length === 1) {
      const only = sites[0]!;
      return {
        value: count(only.visitors),
        sub: `${only.domain ?? only.entity} · de-duplicated over ${p.window.days} days`,
      };
    }
    const biggest = [...sites].sort((a, b) => (b.visitors ?? 0) - (a.visitors ?? 0))[0]!;
    return {
      value: "—",
      sub:
        `not added across ${sites.length} sites — one reader of two of them is ` +
        `one person, and no Umami endpoint can say so. Largest is ` +
        `${biggest.domain ?? biggest.entity} at ${count(biggest.visitors)}`,
    };
  },

  "umami.bounce": ({ umami: U }: LiveInputs) => {
    const w = U?.portfolio.window;
    if (!w || w.bounceRate === null) return null;
    return {
      value: percent(w.bounceRate),
      /* Computed from the SUMS rather than averaged across sites: an average
         of two percentages weights four visits like four thousand. */
      sub: `a visit with one pageview, Umami's own definition · ${count(w.bounces)} of ${count(w.visits)} visits`,
    };
  },

  "umami.avgVisit": ({ umami: U }: LiveInputs) => {
    const w = U?.portfolio.window;
    if (!w || w.avgVisitSeconds === null) return null;
    return {
      value: secs(w.avgVisitSeconds),
      sub: `total time ÷ ${count(w.visits)} visits, over ${w.days} days`,
    };
  },

  "umami.daily": ({ umami: U }: LiveInputs) => {
    const days = U?.portfolio.days ?? [];
    if (days.length < 2) return null;
    return {
      chart: [
        { label: "Pageviews", points: days.map((d) => ({ ts: at(d.day), value: d.pageviews })) },
        { label: "Visits", points: days.map((d) => ({ ts: at(d.day), value: d.sessions })) },
      ],
      unit: "count" as const,
      caption:
        `${days.length} days across ${U!.portfolio.websites} site` +
        `${U!.portfolio.websites === 1 ? "" : "s"} · bucketed in the INSTANCE's ` +
        `timezone, which this browser does not know — so these are not UTC days ` +
        `and are never lined up against another integration's`,
    };
  },

  "umami.sites": ({ umami: U }: LiveInputs) => {
    const sites = U?.websites.filter((w) => w.window) ?? [];
    if (!sites.length) return null;
    return {
      headers: ["Site", "Pageviews", "Visitors", "Visits", "Bounce", "Avg visit"],
      table: [...sites]
        .sort((a, b) => (b.window!.pageviews ?? 0) - (a.window!.pageviews ?? 0))
        .map((w) => [
          siteName(w),
          count(w.window!.pageviews),
          count(w.window!.visitors),
          count(w.window!.visits),
          percent(w.window!.bounceRate),
          secs(w.window!.avgVisitSeconds),
        ]),
    };
  },

  "umami.pages": ({ umami: U }: LiveInputs) => {
    const rows = mergedTop(U?.websites ?? [], (w) => w.top.pages);
    return rows.length ? { rows } : null;
  },

  "umami.referrers": ({ umami: U }: LiveInputs) => {
    const rows = mergedTop(U?.websites ?? [], (w) => w.top.referrers);
    return rows.length ? { rows } : null;
  },

  "umami.events": ({ umami: U }: LiveInputs) => {
    const rows = mergedTop(U?.websites ?? [], (w) => w.top.events);
    return rows.length ? { rows } : null;
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ============================================================= calendar ==
   TIMES ARE PRINTED FROM THE STRING, NOT FROM A DATE OBJECT. Google returns
   RFC3339 with the offset the event was created in, and the route deliberately
   normalises none of it — so slicing "14:30" out of the timestamp shows the
   time the event says it is, whereas parsing it would show what that instant
   is in whatever timezone this browser happens to be in. For a calendar those
   are two different answers and only the first one is on the invitation.
*/

/** "14:30" out of an RFC3339 stamp, or null for a date-only (all-day) value. */
function clockOf(iso: string | null): string | null {
  if (!iso || iso.length <= 10) return null;
  return iso.slice(11, 16);
}

/** "Fri 5" — a bar label wants the weekday, not the year. */
function weekdayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
}

/** How long an event runs, or the honest word for one that has no length. */
function eventLength(e: CalendarEvent): string {
  if (e.allDay) return "all day";
  if (e.minutes === null) return "—";
  return e.minutes < 60
    ? `${e.minutes}m`
    : `${Math.floor(e.minutes / 60)}h${e.minutes % 60 ? ` ${e.minutes % 60}m` : ""}`;
}

const eventTitle = (e: CalendarEvent) => e.summary ?? "(no title)";

Object.assign(LIVE_BUILDERS, {
  "calendar.today": ({ calendar: C }: LiveInputs) => {
    if (!C?.connected) return null;
    const t = C.today;
    const rows: [string, string][] = [
      ...t.events.map(
        (e) =>
          [`${clockOf(e.start) ?? "—"} ${eventTitle(e)}`, eventLength(e)] as [string, string],
      ),
      /* All-day entries are listed and never converted into hours. Three days
         of "Conference" is not twenty-four hours and not eight. */
      ...t.allDay.map((e) => [eventTitle(e), "all day"] as [string, string]),
    ];
    if (!rows.length) rows.push(["Nothing in the calendar today", "0h busy"]);
    else
      rows.push([
        "Busy",
        `${t.busyHours}h · overlaps merged, not added`,
      ]);
    return { rows };
  },

  "calendar.busy": ({ calendar: C }: LiveInputs) => {
    const days = C?.days ?? [];
    if (!C?.connected || !days.length) return null;
    return {
      bars: days.map((d) => d.busyHours),
      barLabels: days.map(
        (d) =>
          `${weekdayOf(d.day)} · ${d.busyHours}h` +
          (d.allDay.length ? ` · ${d.allDay.length} all-day, no hours` : ""),
      ),
      labels:
        `${C.summary.busyHours}h over ${days.length} days · overlapping events ` +
        `count once` +
        (C.summary.allDayEvents
          ? ` · ${C.summary.allDayEvents} all-day entr${C.summary.allDayEvents === 1 ? "y" : "ies"} contribute none`
          : ""),
    };
  },

  "calendar.next": ({ calendar: C }: LiveInputs) => {
    if (!C?.connected) return null;
    const today = C.today.day;
    const rows: [string, string][] = [];
    for (const d of C.days) {
      if (d.day === today) continue;
      for (const e of [...d.events, ...d.allDay]) {
        if (rows.length >= 8) break;
        rows.push([
          `${weekdayOf(d.day)} ${clockOf(e.start) ?? "all day"} ${eventTitle(e)}`,
          eventLength(e),
        ]);
      }
    }
    if (!rows.length)
      rows.push([
        `Nothing booked to ${C.summary.window.to}`,
        `${C.calendars.filter((k) => k.selected).length} calendars read`,
      ]);
    return { rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ================================================================= pypi ==
   Downloads and never installs: CDN file requests, with mirrors excluded on
   every request — so these figures are smaller than pypistats' own default
   view, and deliberately. A partial ISO week is never drawn beside a complete
   one, which is the rule the npm cards already keep; and the two sources are
   never added, because a wheel and a tarball are different artefacts for
   different runtimes.
*/

Object.assign(LIVE_BUILDERS, {
  "pypi.downloads": ({ pypi: P }: LiveInputs) => {
    const s = P?.summary;
    if (!s?.lastCompleteWeek) return null;
    const complete = (P!.weeks ?? []).filter((w) => !w.partial);
    return {
      value: count(s.lastCompleteWeek.downloads),
      sub: also(
        `${s.lastCompleteWeek.week} · ${s.configured} package${s.configured === 1 ? "" : "s"}`,
        s.currentWeek ? `${s.currentWeek.week} still running, not counted` : "",
      ),
      series: complete.length > 1 ? complete.map((w) => w.downloads) : undefined,
      seriesAt: complete.length > 1 ? complete.map((w) => at(w.start)) : undefined,
    };
  },

  "pypi.last30": ({ pypi: P }: LiveInputs) => {
    const s = P?.summary;
    if (!s || !P?.days.length) return null;
    return {
      value: count(s.last30),
      /* Rolling from the days HELD, which is not a calendar month and not
         pypistats' own `last_month` window. Saying which is the difference
         between a figure and a figure somebody can check. */
      sub: `rolling 30 days of ${P.days.length} held · mirrors excluded`,
    };
  },

  "pypi.weekly": ({ pypi: P }: LiveInputs) => {
    const weeks = (P?.weeks ?? []).filter((w) => !w.partial);
    if (weeks.length < 2) return null;
    const current = P!.summary.currentWeek;
    return {
      chart: [
        {
          label: "Downloads",
          points: weeks.map((w) => ({ ts: at(w.start), value: w.downloads })),
        },
      ],
      unit: "count" as const,
      caption:
        `ISO weeks, Monday to Sunday, across ${P!.summary.configured} ` +
        `package${P!.summary.configured === 1 ? "" : "s"} · CDN file requests, ` +
        `so CI and containers are in here with people, and mirrors are not` +
        (current ? ` · ${current.week} is still running and is not drawn` : ""),
    };
  },

  "pypi.packages": ({ pypi: P }: LiveInputs) => {
    const packages = P?.packages ?? [];
    if (!packages.length) return null;
    return {
      headers: ["Package", "Last full week", "30d", "Version", "State"],
      table: packages.map((p) => [
        p.package,
        p.lastCompleteWeek ? count(p.lastCompleteWeek.downloads) : "—",
        count(p.last30),
        p.version ?? "—",
        // A package pypistats would not answer for keeps the figures it has and
        // says why they stopped moving, rather than reading as a quiet week.
        p.lastError ? p.lastError.slice(0, 40) : `ok · ${ago(p.lastOkAt)}`,
      ]),
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ============================================================== bluesky ==
   The public AppView, unauthenticated. Followers are Bluesky's own totals and
   are quoted PER HANDLE; the engagement figures are what the posts carry now
   rather than what they earned inside the window; and a window computed from
   one page of the author feed is a floor when it filled that page, which every
   card below says out loud rather than quoting as a count.
*/

/** The thirty-day window, if it is held. `held: false` is a handle the
 *  collector has not reached yet — not a handle that posted nothing. */
const bsky30 = (h: BlueskyReport["handles"][number]) => {
  const w = h.windows.find((x) => x.days === 30);
  return w && w.held ? w : null;
};

Object.assign(LIVE_BUILDERS, {
  /*
    THE SAME REFUSAL `umami.visitors` MAKES, from the other side of the
    dashboard. One person following two of these accounts is one person, and
    the public API offers nothing that would let anybody subtract them again —
    so a single handle gets its number and several get the sentence, with every
    figure on `bluesky.handles` a card below.
  */
  "bluesky.followers": ({ bluesky: B }: LiveInputs) => {
    const answering = (B?.handles ?? []).filter((h) => h.profile.followers !== null);
    if (!answering.length) return null;
    if (answering.length === 1) {
      const h = answering[0]!;
      return {
        value: count(h.profile.followers),
        sub: also(
          `@${h.handle}`,
          h.growth.change === null
            ? (h.growth.note ?? "no growth figure yet")
            : `${h.growth.change > 0 ? "+" : ""}${count(h.growth.change)} over ${h.growth.readings} readings`,
        ),
        series: h.history.length > 1 ? h.history.map((p) => p.followers) : undefined,
        seriesAt: h.history.length > 1 ? h.history.map((p) => p.ts) : undefined,
      };
    }
    const biggest = [...answering].sort(
      (a, b) => (b.profile.followers ?? 0) - (a.profile.followers ?? 0),
    )[0]!;
    return {
      value: "—",
      sub:
        `not added across ${answering.length} handles — one person following two ` +
        `of them is one person, and the public API cannot say so. Largest is ` +
        `@${biggest.handle} at ${count(biggest.profile.followers)}`,
    };
  },

  "bluesky.engagement": ({ bluesky: B }: LiveInputs) => {
    const p = B?.portfolio;
    if (!p || p.last30.posts === null) return null;
    const rows: [string, string][] = [
      ["Posts", count(p.last30.posts)],
      ["Likes", count(p.last30.likes)],
      ["Reposts of ours", count(p.last30.reposts)],
      ["Replies", count(p.last30.replies)],
    ];
    /*
      THE ROW THAT CHANGES WHAT THE FOUR ABOVE MEAN. A window built from one
      page of the feed that filled that page is a floor, so "42 posts" is "at
      least 42" — and a reader who is not told treats it as a count.
    */
    rows.push([
      p.last30.anyTruncated ? "At least — the feed page filled" : "Complete window",
      p.last30.anyTruncated ? "there were more" : `${p.answering} of ${p.handles} answering`,
    ]);
    rows.push([
      "Counted now, not earned then",
      "an old post gathering likes moves these",
    ]);
    return { rows };
  },

  "bluesky.handles": ({ bluesky: B }: LiveInputs) => {
    const handles = B?.handles ?? [];
    if (!handles.length) return null;
    return {
      headers: ["Handle", "Followers", "Posts 30d", "Likes", "Per post", "Growth"],
      table: handles.map((h) => {
        const w = bsky30(h);
        return [
          `@${h.handle}`,
          count(h.profile.followers),
          w ? `${w.truncated ? "≥" : ""}${count(w.posts)}` : "—",
          w ? count(w.likes) : "—",
          w?.perPost === null || w === null ? "—" : String(w.perPost),
          // Null on a single reading, which is not a flat line and never a zero.
          h.growth.change === null
            ? "not enough readings"
            : `${h.growth.change > 0 ? "+" : ""}${count(h.growth.change)}`,
        ];
      }),
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* =============================================================== uptime ==
   Everything here is measured from ONE machine on ONE connection at roughly
   half-hour intervals, and every card carries the consequence rather than
   hiding it: percentages travel with their check count, a window with fewer
   than six checks is marked instead of being drawn as a confident 100%, and an
   outage shorter than the gap between checks is invisible to all of it.
*/

const ms = (n: number | null) => (n === null ? "—" : `${Math.round(n)} ms`);

Object.assign(LIVE_BUILDERS, {
  "uptime.up": ({ uptime: U }: LiveInputs) => {
    const s = U?.summary;
    if (!s?.configured) return null;
    const measured = s.up + s.down;
    return {
      value: `${s.up} of ${measured || s.configured} up`,
      tone: s.down ? ("bad" as const) : undefined,
      sub: also(
        s.unknown ? `${s.unknown} never checked` : `last checked ${ago(s.lastCheckedAt)}`,
        s.soonestTlsExpiry === null
          ? ""
          : `soonest certificate ${s.soonestTlsExpiry}d`,
      ),
    };
  },

  /*
    THE THREE DOTS ON THE MORNING BOARD. What it will not say any more is
    "99.97% · 30d": this probe holds a week and checks from a laptop, so the
    third dot is the certificate — a number this collector can actually stand
    behind — and the count of checks is what makes the first two readable.
  */
  "uptime.status": ({ uptime: U }: LiveInputs) => {
    const s = U?.summary;
    if (!s?.configured) return null;
    const statuses: [string, StatusTone][] = [
      [`${s.up} of ${s.configured} up`, s.down ? "bad" : "ok"],
    ];
    if (s.down) statuses.push([`${s.down} down`, "bad"]);
    if (s.unknown) statuses.push([`${s.unknown} never checked`, "warn"]);
    const day = U!.hosts.filter((h) => h.availability.day.enough);
    statuses.push(
      day.length
        ? [
            `${percent(Math.min(...day.map((h) => h.availability.day.percent ?? 100)))} worst · 24h`,
            "ok",
          ]
        : ["too few checks to quote a percentage", "warn"],
    );
    if (s.soonestTlsExpiry !== null)
      statuses.push([
        `certificate ${s.soonestTlsExpiry}d`,
        s.soonestTlsExpiry < 7 ? "bad" : s.soonestTlsExpiry < 30 ? "warn" : "ok",
      ]);
    return { statuses };
  },

  "uptime.availability": ({ uptime: U }: LiveInputs) => {
    const hosts = (U?.hosts ?? []).filter((h) => h.availability.window.checks > 0);
    if (!hosts.length) return null;
    const thin = hosts.filter((h) => !h.availability.window.enough).length;
    return {
      bars: hosts.map((h) => h.availability.window.percent ?? 0),
      /*
        THE CAVEAT TRAVELS WITH THE BAR rather than sitting under the set. A
        line saying "some of these are thin" leaves the reader to work out
        which, and a 100% bar over three checks is exactly the one that would
        be believed.
      */
      barLabels: hosts.map(
        (h) =>
          `${h.host} · ${percent(h.availability.window.percent)} of ` +
          `${h.availability.window.checks} check${h.availability.window.checks === 1 ? "" : "s"}` +
          (h.availability.window.enough ? "" : " — too few to quote"),
      ),
      labels: also(
        `${U!.window.hours}h · ${U!.window.cadence}`,
        thin ? `${thin} host${thin === 1 ? "" : "s"} below six checks` : "",
      ),
    };
  },

  "uptime.latency": ({ uptime: U }: LiveInputs) => {
    const hosts = (U?.hosts ?? []).filter((h) => h.latency.samples > 0);
    if (!hosts.length) return null;
    const rows: [string, string][] = [...hosts]
      .sort((a, b) => (b.latency.p95 ?? 0) - (a.latency.p95 ?? 0))
      .map((h) => [
        h.host,
        `p50 ${ms(h.latency.p50)} · p95 ${ms(h.latency.p95)} · ${h.latency.samples}`,
      ]);
    /* Said once for the column: a timeout folded into a p95 turns a connection
       refused, which took two milliseconds, into a slow site. */
    rows.push(["Over successful checks only", "failures are one card over"]);
    return { rows };
  },

  "uptime.tls": ({ uptime: U }: LiveInputs) => {
    const hosts = (U?.hosts ?? []).filter((h) => h.tls.daysLeft !== null);
    if (!hosts.length) return null;
    const runway: RunwayRow[] = [...hosts]
      .sort((a, b) => a.tls.daysLeft! - b.tls.daysLeft!)
      .map((h) => ({
        label: h.host,
        // Never clamped: a negative row is an expired certificate, and it is
        // the most urgent thing this dashboard can draw.
        days: h.tls.daysLeft!,
        sub: `read ${ago(h.tls.measuredAt)}`,
      }));
    const unread = (U!.hosts.length - hosts.length);
    return {
      runway,
      thresholds: { warn: 30, crit: 7 },
      cap: 400,
      caption: unread
        ? `${runway.length} of ${U!.hosts.length} · ${unread} certificate${unread === 1 ? "" : "s"} never read — unknown, not expired`
        : `All ${runway.length}, soonest first`,
    };
  },

  "uptime.incidents": ({ uptime: U }: LiveInputs) => {
    if (!U?.hosts.length) return null;
    const rows: [string, string][] = [];
    for (const h of U.hosts)
      for (const i of h.incidents) {
        if (rows.length >= 8) break;
        rows.push([
          `${h.host} · ${ago(i.start)}`,
          /* `end` is the first check that SUCCEEDED again, which is the
             earliest moment this box can honestly say the site was back. */
          i.ongoing
            ? `still failing · ${i.checks} check${i.checks === 1 ? "" : "s"}`
            : `${i.checks} check${i.checks === 1 ? "" : "s"} · back by ${ago(i.end)}`,
        ]);
      }
    if (!rows.length)
      rows.push([
        `No failed check in ${U.window.hours}h`,
        `an outage shorter than the gap between checks is invisible`,
      ]);
    return { rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ================================================================ fleet ==
   The ssh boxes. Memory adds across them and nothing else does: a load average
   is already relative to a machine's cores, and filesystems share pools, so
   the meters below are per box and there is no fleet total for either.
*/

/** The box's fullest mount — the figure a disk page is actually for. */
function fullestMount(b: FleetBox) {
  return (
    [...b.disks]
      .filter((d) => d.meter)
      .sort((a, b2) => (b2.meter!.percent ?? 0) - (a.meter!.percent ?? 0))[0] ?? null
  );
}

Object.assign(LIVE_BUILDERS, {
  "fleet.memory": ({ boxes: F }: LiveInputs) => {
    const withMemory = (F?.boxes ?? []).filter((b) => b.sample?.memory);
    if (!withMemory.length) return null;
    const meters: Meter[] = [...withMemory]
      .sort((a, b) => (b.sample!.memory!.percent ?? 0) - (a.sample!.memory!.percent ?? 0))
      .map((b) => ({
        label: b.label,
        value: b.sample!.memory!.percent,
        warn: F!.thresholds.warn,
        crit: F!.thresholds.critical,
        /* USED IS TOTAL MINUS AVAILABLE, done at the probe: Linux's page cache
           is not memory anybody is short of, and "94% used" that is mostly
           cache is how a dashboard learns to cry wolf. */
        note: `${bytes(b.sample!.memory!.used)} of ${bytes(b.sample!.memoryTotal)}`,
      }));
    return { meters };
  },

  "fleet.disk": ({ boxes: F }: LiveInputs) => {
    const rows = (F?.boxes ?? [])
      .map((b) => ({ box: b, disk: fullestMount(b) }))
      .filter((r) => r.disk);
    if (!rows.length) return null;
    const meters: Meter[] = rows
      .sort((a, b) => (b.disk!.meter!.percent ?? 0) - (a.disk!.meter!.percent ?? 0))
      .map((r) => ({
        label: r.box.label,
        value: r.disk!.meter!.percent,
        warn: F!.thresholds.warn,
        crit: F!.thresholds.critical,
        /* The MOUNT is named, because "the disk" is not a thing on a box with
           six filesystems and this is only ever the fullest of them. The
           percentage is used / (used + available) — what `df` calls Capacity —
           and not used / size, which calls a 62%-full Mac 2% full. */
        note: `${r.disk!.mount} · ${bytes(r.disk!.avail)} free`,
      }));
    return { meters };
  },

  "fleet.load": ({ boxes: F }: LiveInputs) => {
    const withLoad = (F?.boxes ?? []).filter((b) => b.sample?.loadPerCpu !== null && b.sample);
    if (!withLoad.length) return null;
    const meters: Meter[] = [...withLoad]
      .sort((a, b) => (b.sample!.loadPerCpu ?? 0) - (a.sample!.loadPerCpu ?? 0))
      .map((b) => ({
        label: b.label,
        /*
          LOAD PER CPU AS A PERCENTAGE OF ONE RUNNABLE TASK PER CORE, which is
          the only reading that means the same thing on a Pi and on a
          sixteen-core box. 100% is exactly saturated, and a box above it shows
          above it rather than being clamped — the bar stops at the end of the
          track and the figure does not.
        */
        value: (b.sample!.loadPerCpu ?? 0) * 100,
        warn: 100,
        crit: 150,
        note: `load ${b.sample!.load.one ?? "—"} over ${b.sample!.cpus ?? "?"} cores`,
      }));
    return { meters };
  },

  "fleet.containers": ({ boxes: F }: LiveInputs) => {
    const rows = (F?.boxes ?? []).flatMap((b) =>
      b.containers.map((ct) => [b.label, ct.name, ct.image ?? "—", ct.status ?? "—"]),
    );
    if (!rows.length) {
      /* A box where docker is not installed is a different answer from a box
         running nothing, and a box the probe never reached is a third. */
      const asked = (F?.boxes ?? []).filter((b) => b.docker !== null);
      if (!asked.length) return null;
      return {
        headers: ["Box", "Container", "Image", "Status"],
        table: asked.map((b) => [
          b.label,
          b.docker!.installed ? "none running" : "docker not installed",
          "—",
          "—",
        ]),
      };
    }
    return { headers: ["Box", "Container", "Image", "Status"], table: rows };
  },

  "fleet.counters": ({ boxes: F }: LiveInputs) => {
    const boxes = F?.boxes ?? [];
    const rows: [string, string][] = [];
    for (const b of boxes)
      for (const c of b.counters) {
        if (rows.length >= 10) break;
        rows.push([
          boxes.length > 1 ? `${b.label} · ${c.label}` : c.label,
          /* NEVER ZERO for a counter with no reading: a command that has not
             run and a command that printed 0 look identical on a chart, and
             only one of them is a measurement. */
          c.latest ? count(c.latest.value) : "no value yet — not zero",
        ]);
      }
    if (!rows.length) return null;
    return { rows };
  },

  "fleet.boxes": ({ boxes: F }: LiveInputs) => {
    const boxes = F?.boxes ?? [];
    if (!boxes.length) return null;
    return {
      headers: ["Box", "Host", "Memory", "Fullest disk", "Load/cpu", "Containers"],
      table: boxes.map((b) => {
        const disk = fullestMount(b);
        return [
          b.label,
          b.hostname ?? b.target ?? "—",
          b.sample?.memory ? percent(b.sample.memory.percent, 0) : "no sample",
          disk ? `${disk.mount} ${percent(disk.meter!.percent, 0)}` : "—",
          b.sample?.loadPerCpu === null || !b.sample ? "—" : String(b.sample.loadPerCpu),
          b.docker === null ? "not reached" : String(b.docker.running),
        ];
      }),
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ============================================================= products ==
   The owner's own endpoints, read with the owner's own mapping. A path that
   resolves to nothing is an error with its reason on the row and never a zero,
   and there is no total across endpoints: two products' "renders" share a word
   somebody chose and nothing else.
*/

Object.assign(LIVE_BUILDERS, {
  "products.metrics": ({ products: P }: LiveInputs) => {
    const endpoints = P?.endpoints ?? [];
    const many = endpoints.length > 1;
    const rows: [string, string][] = [];
    for (const e of endpoints)
      for (const m of e.metrics) {
        if (rows.length >= 10) break;
        rows.push([
          many ? `${e.label} · ${m.label}` : m.label,
          m.error ? m.error.slice(0, 44) : count(m.value),
        ]);
      }
    if (!rows.length) return null;
    if (P!.mappingErrors.length)
      rows.push([
        `${P!.mappingErrors.length} path${P!.mappingErrors.length === 1 ? "" : "s"} match nothing`,
        "the endpoint's own keys are on its panel",
      ]);
    return { rows };
  },

  "products.endpoints": ({ products: P }: LiveInputs) => {
    const endpoints = P?.endpoints ?? [];
    if (!endpoints.length) return null;
    const statuses: [string, StatusTone][] = endpoints.map((e) => [
      /* Three states and not two. `null` is never collected — nobody has asked
         yet — which is not the same failure as an endpoint that refused. */
      e.reachable === null
        ? `${e.label} · never collected`
        : e.reachable
          ? `${e.label} · ${e.status ?? 200}${e.ms === null ? "" : ` in ${e.ms} ms`}`
          : `${e.label} · ${e.error?.slice(0, 30) ?? "unreachable"}`,
      e.reachable === null ? "warn" : e.reachable ? "ok" : "bad",
    ]);
    if (P!.summary.metrics)
      statuses.push([
        `${P!.summary.metrics} mapped figure${P!.summary.metrics === 1 ? "" : "s"}, never totalled`,
        "ok",
      ]);
    return { statuses };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ============================================================ backlinks ==
   Three sources that overlap, disagree and are each partial. Nothing below
   adds two of them: a host both Bing and the verification crawler know about
   would be counted twice, and neither is a census. Confidence rides on every
   row so a reader can weight them by hand, which is the only honest way to
   combine them.
*/

/** What a source's answer IS, in one phrase. Four states rather than two: a
 *  refusal, a source nobody asked, a real measurement of nothing, and a count. */
function backlinkState(s: {
  ok: boolean | null;
  asked: boolean;
  error: string | null;
  referringDomains: number | null;
  backlinks: number | null;
}): string {
  if (s.ok === false) return s.error ? s.error.slice(0, 30) : "refused";
  if (s.ok === null) return s.asked ? "asked, no answer" : "never asked";
  /* ANSWERED IS NOT THE SAME AS COUNTED. Bing answers and still has no
     referring-domain figure to give — it reports linked pages instead — and a
     row saying "answered" beside an em dash invites the reader to fill the dash
     in with a nought. Only one of the two is a measurement of nothing. */
  return s.referringDomains === null && s.backlinks === null
    ? "answered, no domain count"
    : "answered";
}

Object.assign(LIVE_BUILDERS, {
  "backlinks.bySource": ({ backlinks: B }: LiveInputs) => {
    const hosts = B?.hosts ?? [];
    if (!hosts.length) return null;
    return {
      headers: ["Host", "Source", "Conf.", "Ref. domains", "Backlinks", "State"],
      /* ONE ROW PER SOURCE PER HOST, deliberately — the alternative is a row
         per host with the sources in columns, which invites the eye to add
         along the row. There is no total column here and there never will be. */
      table: hosts.flatMap((h) =>
        h.sources.map((s) => [
          h.host,
          s.label,
          s.confidence.toFixed(2),
          count(s.referringDomains),
          count(s.backlinks),
          backlinkState(s),
        ]),
      ),
    };
  },

  "backlinks.domains": ({ backlinks: B }: LiveInputs) => {
    const hosts = B?.hosts ?? [];
    if (!hosts.length) return null;
    const many = hosts.length > 1;
    const rows: [string, string][] = [];
    for (const h of hosts)
      for (const s of h.sources) {
        if (rows.length >= 9) break;
        rows.push([
          many ? `${h.host} · ${s.label}` : s.label,
          `${s.referringDomains === null ? backlinkState(s) : count(s.referringDomains)} · conf ${s.confidence.toFixed(2)}`,
        ]);
      }
    /* The row that stops the column above being read down and added. */
    rows.push(["Combined", "not summed — the sources overlap and disagree"]);
    return { rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ============================================================= presence ==
   Product × directory, with FOUR statuses that must not collapse to two. A
   blocked cell means the source could not be asked — a 403, a rate limit, a
   directory with no keyless lookup — and rendering it as a grey "no" would be
   telling somebody to go and get listed where they may already be listed.
*/

/** One cell, in one character, with the word in the header row above it.
 *  `·` is deliberately not a dash: a dash reads as "no". */
function presenceMark(status: string | null, evidence: string | null): string {
  switch (status) {
    case "present":
      return "yes";
    case "absent":
      /* AN ABSENT ROW THAT NAMED THE BRAND IS A CANDIDATE, not a no. The
         source found something carrying the name and it did not point back
         here — which is the owner's judgement to make, and rendering it as a
         flat "no" is the dashboard making it for them. */
      return evidence === "named" ? "no · candidate" : "no";
    case "blocked":
      return "BLOCKED";
    case "error":
      return "error";
    default:
      return "unchecked";
  }
}

Object.assign(LIVE_BUILDERS, {
  "presence.matrix": ({ presence: P }: LiveInputs) => {
    const products = P?.products ?? [];
    if (!products.length || !P?.sources.length) return null;
    return {
      headers: ["Product", ...P.sources.map((s) => s.label)],
      table: products.map((p) => [
        p.product,
        ...P.sources.map((s) => {
          const cell = p.sources.find((c) => c.source === s.id);
          return presenceMark(cell?.status ?? null, cell?.evidence ?? null);
        }),
      ]),
    };
  },

  "presence.blocked": ({ presence: P }: LiveInputs) => {
    const products = P?.products ?? [];
    if (!products.length) return null;
    const statuses: [string, StatusTone][] = [];
    for (const p of products)
      for (const c of p.sources) {
        if (statuses.length >= 8) break;
        if (c.status === "blocked" || c.status === "error")
          statuses.push([
            `${products.length > 1 ? `${p.product} · ` : ""}${c.label} · ${c.status === "blocked" ? "not checked" : "check failed"}`,
            c.status === "blocked" ? "warn" : "bad",
          ]);
      }
    if (!statuses.length) {
      const unchecked = products.reduce((n, p) => n + p.summary.unchecked, 0);
      statuses.push(
        unchecked
          ? [`${unchecked} cell${unchecked === 1 ? "" : "s"} not checked yet`, "warn"]
          : ["Every source answered", "ok"],
      );
    }
    /* The sentence the card exists for, on the card rather than in a tooltip. */
    statuses.push(["blocked is NOT a report of not listed", "warn"]);
    return { statuses };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ================================================================ audit ==
   THE PORTFOLIO'S OWN SITES, one row each, from the crawl this box runs.

   ONE RULE DECIDES EVERY CARD BELOW: A SITE NOBODY CRAWLED IS NOT A CLEAN SITE.
   A venture with no audit has no error count, not a zero, so it is kept out of
   every sum and named separately — because the alternative is a board whose
   headline figure IMPROVES when a venture is added, which is the precise
   opposite of what it is for.

   THE THREE SEVERITIES ARE NEVER ADDED. An error is a page that would not
   render or a link that goes nowhere; a notice is a missing meta description.
   A single "issues" figure lets forty notices outrank a dead homepage, and the
   ordering on `audit.worst` — the one thing somebody opens this board to
   read — would then be wrong in exactly the case that matters.
*/

/**
 * The ventures the crawler has actually reached, with their counts in hand.
 *
 * `ts` AND `issues` BOTH, because the wire is careful in a way that would be
 * easy to throw away here: a venture nobody has crawled carries nulls rather
 * than noughts, and a `?? 0` anywhere below would turn "never looked at" into
 * "came back clean" — the single reading every card in this block is built to
 * refuse.
 */
const audited = (A: AuditOverview | null | undefined) =>
  (A?.ventures ?? []).filter(
    (v): v is typeof v & { issues: NonNullable<typeof v.issues> } =>
      !!v.ts && !!v.issues,
  );

/**
 * The bare hostname inside whatever the audit answered with.
 *
 * `canonicalHost` is a URL — "https://example.com/" — because it is where
 * the crawler's redirects ended up, and a venture's `host` is a bare name. A
 * string comparison between the two is `false` for every venture on the
 * portfolio, which would draw an apex/www warning on all of them and teach the
 * reader to ignore the card.
 */
function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * What the http → https test established, in three words rather than two.
 *
 * `null` is "could not be established" — the crawler asked and got no usable
 * answer — and rendering it as "no" would report a fault nobody has found.
 */
const httpsWord = (v: boolean | null) =>
  v === null ? "not established" : v ? "redirects to https" : "no https redirect";

/** Whole days since a timestamp, or null when there is none. */
function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 86_400_000);
}

Object.assign(LIVE_BUILDERS, {
  "audit.issues": ({ audit: A }: LiveInputs) => {
    const rows = audited(A);
    if (!rows.length) return null;
    const errors = rows.reduce((n, v) => n + v.issues.error, 0);
    const warnings = rows.reduce((n, v) => n + v.issues.warning, 0);
    const notices = rows.reduce((n, v) => n + v.issues.notice, 0);
    const never = (A?.ventures.length ?? 0) - rows.length;
    return {
      value: count(errors),
      tone: errors ? ("bad" as StatusTone) : ("ok" as StatusTone),
      sub: also(
        /* The other two severities ride along in the small print so nobody
           reads the headline as "everything that is wrong" — but they are
           written out separately, never summed into it. */
        `${count(warnings)} warnings · ${count(notices)} notices, not added in · ${rows.length} site${rows.length === 1 ? "" : "s"} crawled`,
        never ? `${never} never crawled` : "",
      ),
    };
  },

  "audit.ventures": ({ audit: A }: LiveInputs) => {
    const ventures = A?.ventures ?? [];
    if (!ventures.length) return null;
    return {
      headers: [
        "Venture",
        "Pages",
        "Errors",
        "Warnings",
        "Notices",
        "HTTPS",
        "Sitemap",
        "robots.txt",
        "Crawled",
      ],
      /* THE UNCRAWLED ARE ON THE TABLE, with em dashes rather than noughts.
         Leaving them off would make the portfolio look smaller than it is and
         would hide the one row somebody can act on immediately. */
      table: ventures.map((v) =>
        v.ts && v.issues
          ? [
              v.name,
              count(v.pages),
              count(v.issues.error),
              count(v.issues.warning),
              count(v.issues.notice),
              v.https === null ? "not established" : v.https ? "yes" : "no",
              v.sitemap ? "found" : "none found",
              /* A MISSING robots.txt IS NOT A CLOSED SITE — no rules means
                 everything is allowed, which is the correct reading and the
                 reason this column says "none" and not "missing". */
              v.robots ? "yes" : "none",
              ago(v.ts),
            ]
          : [v.name, "—", "—", "—", "—", "—", "—", "—", "never"],
      ),
    };
  },

  "audit.worst": ({ audit: A }: LiveInputs) => {
    const rows = audited(A);
    if (!rows.length) return null;
    /* Errors first and warnings only as the tie-break, which is the ordering
       the severities exist for. A site with one broken page outranks a site
       with thirty missing descriptions, and it should. */
    const worst = [...rows]
      .sort(
        (a, b) =>
          b.issues.error - a.issues.error || b.issues.warning - a.issues.warning,
      )
      .slice(0, 8);
    const out: [string, string][] = worst.map((v) => [
      /* The page count travels with the row, because three errors over four
         pages and three over forty are different findings. */
      `${v.name} · ${v.pages} page${v.pages === 1 ? "" : "s"}`,
      v.issues.error || v.issues.warning
        ? `${v.issues.error} error${v.issues.error === 1 ? "" : "s"} · ${v.issues.warning} warning${v.issues.warning === 1 ? "" : "s"}`
        : v.issues.notice
          ? `nothing above a notice · ${v.issues.notice} notice${v.issues.notice === 1 ? "" : "s"}`
          : /* A REAL MEASUREMENT OF NOTHING, and it is worth the words: this
               row and the "never crawled" row at the bottom of the card look
               identical if both of them just say nought. */
            `clean over ${v.pages ?? 0} page${v.pages === 1 ? "" : "s"}`,
    ]);
    const never = (A?.ventures.length ?? 0) - rows.length;
    if (never)
      out.push([
        `${never} venture${never === 1 ? "" : "s"} never crawled`,
        "unmeasured, which is not the same as clean",
      ]);
    return { rows: out };
  },

  "audit.https": ({ audit: A }: LiveInputs) => {
    const rows = audited(A);
    if (!rows.length) return null;
    const statuses: [string, StatusTone][] = [];
    for (const v of rows) {
      if (statuses.length >= 8) break;
      statuses.push([
        `${v.name} · ${httpsWord(v.https)}`,
        v.https === null ? "warn" : v.https ? "ok" : "bad",
      ]);
    }
    /*
      THE APEX/WWW QUESTION, and it is a WARNING rather than a fault.

      A site asked for on one host and answering on another is normally a
      redirect somebody set up on purpose. What makes it worth a line is that
      every other measurement on this board — Search Console properties,
      backlink hosts, the uptime probe — is keyed by the host somebody typed,
      and a portfolio where half the ventures answer somewhere else is a
      portfolio whose figures are filed under the wrong names.
    */
    for (const v of rows) {
      if (statuses.length >= 11) break;
      const answered = hostOf(v.canonicalHost);
      const asked = v.host?.toLowerCase().replace(/^www\./, "") ?? null;
      if (answered && asked && answered !== asked)
        statuses.push([`${v.name} answers on ${answered}`, "warn"]);
    }
    const never = (A?.ventures.length ?? 0) - rows.length;
    if (never)
      statuses.push([
        `${never} venture${never === 1 ? "" : "s"} never crawled — not tested`,
        "warn",
      ]);
    return { statuses };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ================================================================= runs ==
   WHAT THE AGENT WAS ASKED TO DO AND HOW FAR IT GOT.

   ONE RUN EXECUTES AT A TIME, by design, so "how many are running" is a nought
   or a one and the figure worth drawing beside it is the queue. Nothing here
   adds `done` to `failed`: a failed run produced no report, and a bar that
   stacked the two would say the agent had written twice what it has.
*/

/** A kind's own name, or the raw key if the server has not described it — a
 *  ledger row for a kind the catalog has forgotten is still a real run. */
const kindWord = (R: RunsReport | null | undefined, kind: string) =>
  R?.kinds.find((k) => k.kind === kind)?.name ?? kind;

/** What became of a run, in one phrase. Five statuses and none of them
 *  collapses: a cancelled run is not a failure, and a queued one is not work. */
function runOutcome(r: AgentRun): string {
  switch (r.status) {
    case "done":
      return `done · ${duration(r.ms, { nullText: "still going" })} · ${count(r.outputChars)} chars`;
    case "failed":
      return `failed · ${shorten(r.error ?? "no reason recorded", 34)}`;
    case "running":
      return `running · ${r.steps} step${r.steps === 1 ? "" : "s"} so far`;
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
  }
}

Object.assign(LIVE_BUILDERS, {
  "runs.running": ({ runs: R }: LiveInputs) => {
    if (!R) return null;
    const r = R.running;
    return {
      /* A WORD RATHER THAN A NUMBER, because the number is always 0 or 1 and
         says nothing. What somebody wants from across the room is WHICH piece
         of work is in flight. */
      value: r ? kindWord(R, r.kind) : "idle",
      sub: r
        ? `${r.ventureName ?? "no venture"} · started ${ago(r.startedAt)}${R.queued ? ` · ${R.queued} queued` : ""}`
        : R.queued
          ? `${R.queued} queued, none started`
          : /* NOT a count of the ledger. The route answers with the newest
               `limit` runs, so `runs.length` is a page and printing it as
               "14 runs" would be a truncation wearing a total's clothes. What
               is true of the page is when its newest finished run finished. */
            also(
              "nothing queued",
              (() => {
                const last = R.runs.find((r) => r.finishedAt);
                return last ? `last run ${ago(last.finishedAt)}` : "";
              })(),
            ),
    };
  },

  "runs.recent": ({ runs: R }: LiveInputs) => {
    const runs = R?.runs ?? [];
    if (!runs.length) return null;
    return {
      rows: runs.slice(0, 8).map(
        (r) =>
          [
            `${kindWord(R, r.kind)} · ${r.ventureName ?? "no venture"}`,
            runOutcome(r),
          ] as [string, string],
      ),
    };
  },

  "runs.byKind": ({ runs: R }: LiveInputs) => {
    const kinds = R?.kinds ?? [];
    /* Reports WRITTEN, so only `done` is counted. A failed run and a queued one
       are both real things that happened and neither of them is a report. */
    const written = kinds.filter((k) => k.counts.done > 0);
    if (!written.length) return null;
    const failed = kinds.reduce((n, k) => n + k.counts.failed, 0);
    return {
      bars: written.map((k) => k.counts.done),
      barLabels: written.map(
        (k) => `${k.name} · ${k.counts.done} report${k.counts.done === 1 ? "" : "s"}`,
      ),
      labels: also(
        written.map((k) => `${k.name} ${k.counts.done}`).join(" · "),
        failed ? `${failed} failed, not counted` : "",
      ),
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ========================================================== competitors ==
   THE RIVALS THE SWEEPS ACCUMULATED, AND THE DATE EACH WAS LAST VERIFIED.

   That date is the point of the table rather than a column on it. A sweep that
   does not mention a company LEAVES ITS PROFILE ALONE — silence is not
   verification — so without the date a reading from June is indistinguishable
   from one taken this morning, and a positioning line nobody has re-checked in
   a season is exactly the thing somebody would quote in a pitch.
*/

/** How stale a profile is, in words, with "never verified" kept apart from
 *  "verified today": a row a sweep has never confirmed is not a fresh one. */
function verifiedWord(iso: string | null): string {
  const days = daysSince(iso);
  if (days === null) return "never verified";
  if (days <= 0) return "today";
  return `${days}d ago`;
}

/** The line past which a profile is quoted at your own risk. Sixty days is the
 *  brief's own number, and it is one place rather than three so the metric, the
 *  table and the list cannot disagree about what stale means. */
const STALE_DAYS = 60;

Object.assign(LIVE_BUILDERS, {
  "competitors.count": ({ competitors: C }: LiveInputs) => {
    if (!C) return null;
    const profiles = C.profiles;
    if (!profiles.length && !C.runs) return null;
    const ventures = new Set(profiles.map((p) => p.ventureId)).size;
    return {
      value: count(profiles.length),
      sub: also(
        `across ${ventures} venture${ventures === 1 ? "" : "s"} · ${C.runs} sweep${C.runs === 1 ? "" : "s"}`,
        C.lastRun ? `last ${ago(C.lastRun)}` : "",
      ),
    };
  },

  "competitors.table": ({ competitors: C }: LiveInputs) => {
    const profiles = C?.profiles ?? [];
    if (!profiles.length) return null;
    return {
      headers: [
        "Rival",
        "Venture",
        "Positioning",
        "Pricing",
        "Last verified",
        "First seen",
      ],
      table: [...profiles]
        .sort(
          (a, b) =>
            (a.ventureName ?? "").localeCompare(b.ventureName ?? "") ||
            a.name.localeCompare(b.name),
        )
        .map((p) => [
          p.name,
          p.ventureName ?? "—",
          /* NOT ESTABLISHED, never an empty cell. A sweep that could not find
             a price and a rival that publishes none are the same blank on a
             table and are not the same finding — and the honest one of the two
             is the one that does not claim to know. */
          p.positioning ? shorten(p.positioning, 60) : "not established",
          p.pricing ? shorten(p.pricing, 32) : "not established",
          verifiedWord(p.lastVerified),
          p.firstSeen ? ago(p.firstSeen) : "—",
        ]),
    };
  },

  "competitors.stale": ({ competitors: C }: LiveInputs) => {
    const profiles = C?.profiles ?? [];
    if (!profiles.length) return null;
    const stale = profiles
      .map((p) => ({ p, days: daysSince(p.lastVerified) }))
      /* Null sorts as stale rather than fresh: a profile no sweep has ever
         confirmed is the least verified row on the table, not the most. */
      .filter((r) => r.days === null || r.days >= STALE_DAYS)
      .sort((a, b) => (b.days ?? Number.MAX_SAFE_INTEGER) - (a.days ?? Number.MAX_SAFE_INTEGER));
    const rows: [string, string][] = stale
      .slice(0, 8)
      .map((r) => [
        `${r.p.name} · ${r.p.ventureName ?? "no venture"}`,
        verifiedWord(r.p.lastVerified),
      ]);
    if (!rows.length)
      rows.push([
        `All ${profiles.length} profile${profiles.length === 1 ? "" : "s"} verified inside ${STALE_DAYS} days`,
        "—",
      ]);
    /* The sentence the card exists for, on the card. */
    rows.push([
      "A sweep that did not name a rival",
      "left its date alone — silence is not verification",
    ]);
    return { rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);
