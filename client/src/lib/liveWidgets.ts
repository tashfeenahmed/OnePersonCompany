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
  GscProperty,
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
  LlmReport,
  UmamiReport,
  UmamiWebsite,
  UptimeReport,
} from "@/lib/api/reports";
import type { Meter, ProfileFigure, ProportionPart, RunwayRow, StatusTone, WaterfallStep, Widget } from "@/data/widgets";
import type { Expense, FinanceReport, PortfolioPnl } from "@/lib/api/finance";
import type { InboxDoc, InboxItem } from "@/lib/api/inbox";
import type { CaptureReport } from "@/lib/api/ventures";
import type { LeakageReport } from "@/lib/api/activity";
import type { DisputeDoc, RecoveryCase, RecoveryQueue } from "@/lib/api/customers";
import type { SeoOpsDocs } from "@/lib/api/seoboard";
import type { SocialBoardDocs } from "@/lib/api/socialboard";
import type { SocialPost } from "@/areas/socialfeed/api";
import type { FeedItem } from "@/data/widgets";
import type { AdRow, AdsBoardDocs } from "@/lib/api/adsboard";
import { rateBetween } from "./fx.ts";
import {
  TRAILING_MIN_DAYS,
  attemptBuckets,
  bucketDays,
  chargesInWindow,
  drift,
  failRate,
  planSplit,
  splitLeaving,
  sumMonthly,
  trailingFailRate,
  worthALook,
} from "./payments.ts";
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
import { DASH, ago, bytes, clock, compact, count, day, duration, durationS, inDays, money, pct, when } from "./format.ts";
/* The same relative-with-extension rule as `./format.ts` above: the window
   labels are real code and the catalog check runs this file under bare node. */
import { windowLabel, type WindowValue } from "./window.ts";

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
  /**
   * THE WINDOW THE PICKER ASKED FOR — 7, 30, 90 or "all" — see lib/window.
   * Every document below was fetched over it, so most builders never read
   * this: they caption from the document's own `window.days`, which is what
   * the route actually answered. The ones that do read it are the ones where
   * that would mislead — a route that clamped ("all" over Cloudflare is the
   * ninety days it keeps), a figure that is the source's own fixed window
   * (Umami's thirty complete days), or a rate that has no all-time reading
   * (churn). Optional the way `mobile` is, so a caller that has not been
   * taught to pass it draws the month it always drew.
   */
  window?: WindowValue;
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
  /** This box's own LLM use. */
  llm?: LlmReport | null;
  competitors?: CompetitorsReport | null;
  /** The cost ledger, renewals and electricity model — this box's own rate
   *  card. Optional the way the second-wave reports are. */
  finance?: FinanceReport | null;
  /*
    THE PAYMENTS BOARD'S THREE COMPANION DOCUMENTS, three fields for the
    reason `gsc` and `bing` are two: each carries a figure that looks like
    one on the Stripe document and must never be added to it. The dispute
    cases are dated by the bank and the ledger's dispute debit by the
    posting; the queue's monthly amount is normalised the way MRR is and is
    still not MRR. Optional, like every field added after the first release.
  */
  leakage?: LeakageReport | null;
  disputes?: DisputeDoc | null;
  queue?: RecoveryQueue | null;
  /** The four SEO documents this box computes itself: authority, AI
   *  visibility, follow-ups and the IndexNow log. Four fields, no sums. */
  seo?: SeoOpsDocs | null;
  /**
   * THE POSTS. The timeline the socialfeed area reads back from Meta, and the
   * publishing area's queue beside it.
   *
   * ONE FIELD FOR TWO ROUTES, which is the `demand` decision rather than the
   * `gsc`/`bing` one, and it passes the test from the same side `mail` does:
   * a queued draft and a published post are two ENDS OF ONE LOOP and are
   * joined by Meta's own post id, so the temptation is not to add them — it
   * is to double-count them, and the builders below never put a queue figure
   * and a timeline figure in the same total. One fetch, one clock, two blocks.
   */
  social?: SocialBoardDocs | null;
  /** The three ads documents this box computes over Meta's own rows: the
   *  health rubric, the advertisements with their creatives, and the
   *  campaign → venture map. Three fields, no sums — a score, a cost per
   *  click and a venture's spend are three kinds of thing. */
  ads?: AdsBoardDocs | null;

  /*
    THE OVERVIEW BOARD'S THREE, AS THREE FIELDS.

    Nothing is merged. `profit` is one calendar month of arithmetic over
    collected rows, `finance` above it is the rate card those rows are priced
    against, and the two disagree on purpose — a field holding both would be a
    field away from a card that treated a bill as a measurement. `inbox` is a
    list of unanswered things and `capture` is a set of photographs; neither
    has a figure anything could add to the other.
  */
  /** What is waiting: alerts, commitments, mail, failed runs and payment
   *  failures, joined and already filtered by the route — see lib/api/inbox. */
  inbox?: InboxDoc | null;
  /** The portfolio P&L for the current month, per currency. */
  profit?: PortfolioPnl | null;
  /** The newest good photograph of each venture's front page. */
  capture?: CaptureReport | null;
  /*
    THE PER-PROJECT CONTRACT. A widget whose catalog entry says `perProject`
    is placed with a venture id (`PlacedWidget.param`); the card resolves it
    to the venture and, BEFORE calling the builder, narrows every document
    above to the venture's hosts with the rule a venture board uses
    (lib/scope `narrowLive`). So a per-project builder reads `gsc`, `audit`,
    `seo` and the rest exactly as a card on that venture's board would —
    the venture's properties, the venture's crawl row — and never filters
    for itself. `project` is how it knows it was asked about one venture at
    all: absent on every portfolio call (the fetch layer's live-dot pass,
    a venture board's pass), and a per-project builder returns null then
    rather than draw the portfolio under a venture's name. `param` is the
    raw id, for a builder that needs to say it; the card puts the venture's
    NAME on the card, so builders do not.
  */
  param?: string;
  project?: ProjectScope;
  /*
    THE PER-SERVER CONTRACT, WHICH IS THE SAME MECHANISM AND NOT THE SAME PASS.

    A widget whose catalog entry says `perParam: { kind: "server" }` is placed
    with a FLEET ACCOUNT ID and the card resolves it to one box out of the
    fleet document. NOTHING IS NARROWED on the way in: a venture is a hostname
    every document has to be filtered by, but a box is a row in a list of
    boxes, so the builder gets the whole portfolio — `boxes`, and `fleet` and
    `load` beside it, which is what lets a per-server card join its box to the
    Hetzner row for the same machine — with `server` saying which one it is
    about. `server` is absent on every portfolio call, and a per-server builder
    returns null then rather than draw the fleet under one machine's name.
  */
  server?: ServerScope;
};

/** The venture a per-project card was asked about — see `LiveInputs`. */
export type ProjectScope = {
  id: string;
  name: string;
  /** Lowercase, no leading "www." — what the documents were narrowed to. */
  hosts: string[];
};

/**
 * The box a per-server card was asked about — see `LiveInputs`.
 *
 * The row itself travels rather than an id the builder would have to look up
 * again: the card has already found it, and a second lookup is a second place
 * that can disagree about which box "52" is.
 */
export type ServerScope = {
  /** The fleet account id as a string — `PlacedWidget.param`. */
  id: string;
  /** The owner's own name for the box, which is the account's label. */
  label: string;
  box: FleetBox;
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

/**
 * "30 days", or what was ACTUALLY held when that is the smaller truth.
 *
 * `asked` is the route's own `window.days` — what it clamped the request
 * to; `landed` is how many days of record came back inside it. Under "all"
 * the honest span is the landed one, named as everything the keeper holds,
 * because "all time" over thirty days of Cloudflare rollups is thirty days.
 * Under a number the two usually agree; where they do not — ninety asked of
 * a source that started collecting in July — the card says so rather than
 * captioning a fortnight "90 days".
 */
function heldDays(w: WindowValue | undefined, asked: number, landed: number, keeper: string): string {
  if (w === "all") return `${count(landed)} days — everything ${keeper} holds`;
  if (landed < asked) return `${count(landed)} of ${asked} days held by ${keeper}`;
  return `${asked} days`;
}

/** Whether the picker is on a span this source cannot move to. */
const isAll = (w: WindowValue | undefined) => w === "all";

/** "30 days", or under "all" what the cost ledgers hold — the route caps at
 *  four hundred days and each provider's export goes back as far as it does,
 *  so the honest span is the charged days the OpenAI rows actually cover. */
const costDays = (C: CostsReport, w: WindowValue | undefined) =>
  w === "all" ? `${count(C.openai.days.length)} charged days — everything the exports hold` : `${C.window.days} days`;

/** "7 complete days", or under "all" the complete days Cloudflare's rollups
 *  actually cover on this box — the route caps at ninety and the collector
 *  started in August, so "all time" here is a number of weeks and says so. */
const cfDays = (C: CloudflareReport, w: WindowValue | undefined) =>
  w === "all" || C.window.collectedDays < C.window.days
    ? `${heldDays(w, C.window.days, C.window.collectedDays, "Cloudflare")}`.replace(" days", " complete days")
    : `${C.window.days} complete days`;

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
    /*
      A DONUT WITH THE BILL IN THE HOLE, the way the cost pages draw a bill
      split into its groups: the two parts as arcs, the legend carrying each
      figure and what it is a figure OF, and the total written once in the
      middle rather than as a third row that has to be read as "not another
      part". Net of VAT stays in the note, because it is a fact about every
      number on the card and not about one of them.
    */
    return {
      slices: [
        {
          label: "Servers",
          value: summary.serverMonthlyEur,
          text: eur(summary.serverMonthlyEur),
          sub: `${count(summary.servers)} box${summary.servers === 1 ? "" : "es"}`,
        },
        {
          label: "Volumes",
          value: summary.volumeMonthlyEur,
          text: eur(summary.volumeMonthlyEur),
          sub: `${count(summary.volumes)} volume${summary.volumes === 1 ? "" : "s"}`,
        },
      ],
      center: { value: eur(summary.monthlyEur, 0), note: "per month" },
      caption: also("net of VAT", across(summary.accounts.length)),
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

/** The tail of a daily download line the picker asks for, summed, with how
 *  many days were actually there to sum. "all" is the whole line. */
function sliceDays(line: { day: string; downloads: number }[], w: WindowValue | undefined) {
  const tail = w === "all" || w === undefined ? line : line.slice(-w);
  return { sum: tail.reduce((n, d) => n + d.downloads, 0), days: tail.length };
}

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

  "npm.last30": ({ npm: npmDoc, window: W }: LiveInputs) => {
    const s = npmDoc?.summary;
    if (!s || !s.configured) return null;
    /*
      THE ROUTE TAKES NO WINDOW, SO THE CARD CUTS THE LINE ITSELF. npm's route
      holds a daily line as far back as it has been collected and publishes a
      rolling thirty off it; any other span is the same sum over a different
      tail, and downloads add across days. Where the line is shorter than the
      ask the card says how many days it really summed.
    */
    const cut = sliceDays(npmDoc!.days, W);
    return {
      value: count(W === undefined || W === 30 ? s.last30 : cut.sum),
      sub: also(
        `${s.answering} of ${s.configured} package${s.configured === 1 ? "" : "s"}` +
          (W !== undefined && W !== 30 ? ` · ${heldDays(W, W === "all" ? cut.days : W, cut.days, "the npm line")}` : ""),
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

  "npm.table": ({ npm: npmDoc, window: W }: LiveInputs) => {
    const packages = npmDoc?.packages ?? [];
    if (!packages.length) return null;
    return {
      headers: ["Package", "Last full week", windowLabel(W ?? 30), "Held", "State"],
      table: packages.map((p) => [
        p.package,
        p.lastCompleteWeek ? count(p.lastCompleteWeek.downloads) : "—",
        count(sliceDays(p.days, W ?? 30).sum),
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
      tag: "metered",
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
    /*
      AN AREA OVER THE DAYS, NOT THIRTY-ONE BARS. The quantity is a daily
      magnitude off a zero baseline and a month of them is a series, not
      thirty-one things to compare — the same call the OpenRouter day card
      and the cost pages make. The chart draws the mean as a dashed rule and
      labels the peak and the low itself, which is what the bars' caption
      used to try to say in words.

      THE PARTIAL BUCKETS ARE SAID ONCE, in the caption. OpenAI aggregates
      into UTC days and the recent ones take about a day to fill, so the
      newest point is always short and would otherwise read as a quiet
      Tuesday. It is kept rather than dropped: the spend is real, it is just
      not all there yet.
    */
    const settling = o.days.filter((d) => d.day > o.completeThrough).length;
    return {
      chart: [
        {
          label: "Spend, USD",
          points: o.days.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.usd })),
        },
      ],
      unit: "usd" as const,
      caption:
        `${usd(total)} over ${o.days.length} days to ${dayShort(o.days.at(-1)!.day)}` +
        (settling
          ? ` · the newest ${settling === 1 ? "day is" : `${settling} days are`} still settling`
          : ""),
    };
  },

  "openai.projects": ({ costs: COSTS, window: W }: LiveInputs) => {
    const o = COSTS?.openai;
    if (!o?.projects.length) return null;
    const rows: [string, string][] = o.projects.map((p) => [p.name, usd(p.usd)]);
    /*
      The total is a sum over the SAME rows the day chart sums, which is the
      one thing this API's grouping buys: the two cards agree to the cent by
      construction rather than by both being right.
    */
    rows.push([`Total, ${heldDays(W, COSTS!.window.days, o.days.length, "OpenAI's usage export")}`, usd(o.usd ?? 0)]);
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
      tag: "metered",
      sub:
        `${a.models.length} models · ${count(a.requests)} requests` +
        // BYOK is inference OpenRouter routed and did NOT bill for. It is
        // named beside the figure rather than added to it.
        (a.byokUsd > 0 ? ` · ${usd(a.byokUsd)} more on your own keys` : ""),
      series: points.length > 1 ? points.map((p) => p.value) : undefined,
      seriesAt: points.length > 1 ? points.map((p) => p.ts) : undefined,
    };
  },

  "openrouter.models": ({ costs: COSTS, window: W }: LiveInputs) => {
    const a = COSTS?.openrouter.activity;
    if (!a?.models.length) return null;
    // Half a cent, not zero: a model that cost $0.0004 draws a bar nobody can
    // see and hovers as "$0.00", which reads as a bug in a spend chart. The
    // free-tier traffic has its own card, where the zero is the point.
    const top = a.models.filter((m) => m.usd >= 0.005).slice(0, 8);
    if (!top.length) return null;
    /*
      RANKED BARS WITH THE NAME ON THE ROW, the way the LLM usage page draws
      this: the model in full, its tokens right-aligned beside it, and the
      dollars at the tip of the bar. A long bar over a small token count is
      an expensive model, and the two are read in the same glance — which
      nine upright nubs with a mark under each could not say.
    */
    const priced = a.models.filter((m) => m.usd >= 0.005).length;
    return {
      ranked: top.map((m) => ({
        label: m.model,
        value: m.usd,
        text: usd(m.usd),
        sub: `${compact(m.promptTokens + m.completionTokens)} tokens`,
        mark: m.model,
      })),
      caption:
        `${costDays(COSTS!, W)} · biggest first` +
        (priced > top.length ? ` · top ${top.length} of ${priced} priced models` : "") +
        ` · ${count(a.requests)} requests in all`,
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
      tag: "measured",
      tone: rate >= 20 ? ("bad" as StatusTone) : rate >= 5 ? ("warn" as StatusTone) : undefined,
      sub: `${count(r.succeeded)} succeeded · ${count(r.failed)} failed (${Math.round(rate)}%)`,
    };
  },

  "replicate.compute": ({ costs: COSTS }: LiveInputs) => {
    const r = COSTS?.replicate;
    if (!r?.runs) return null;
    return {
      value: hoursMinutes(r.predictSeconds),
      tag: "measured",
      /*
        The whole point of this card, in its own subtitle. Replicate reports
        the time; it publishes no rate anywhere in its API, and the models this
        account runs are billed per output rather than per second in any case.
        So this is compute, and it is not money, and the card says which.
      */
      sub: "predict time · Replicate publishes no rate, so no cost follows",
    };
  },

  "replicate.models": ({ costs: COSTS, window: W }: LiveInputs) => {
    const r = COSTS?.replicate;
    if (!r?.models.length) return null;
    const top = r.models.slice(0, 8);
    return {
      ranked: top.map((m) => ({
        label: m.model,
        value: m.seconds,
        text: hoursMinutes(m.seconds),
        sub:
          `${count(m.runs)} run${m.runs === 1 ? "" : "s"}` +
          (m.failed ? ` · ${count(m.failed)} failed` : ""),
      })),
      caption:
        `${costDays(COSTS!, W)} · predict time, biggest first` +
        (r.models.length > top.length ? ` · top ${top.length} of ${r.models.length} models` : "") +
        " · Replicate publishes no rate, so no cost follows",
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

  "costs.llm": ({ costs: COSTS, window: W }: LiveInputs) => {
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
      tag: "metered",
      /* Under "all" the name says "all time" and the span that actually
         backs it — the charged days the exports hold — is said here. */
      sub: also(
        `${parts.map((p) => p.name).join(" + ")} · Replicate is not in this: it reports no spend`,
        isAll(W) ? costDays(COSTS, W) : "",
      ),
    };
  },

  "costs.byProvider": ({ costs: COSTS, window: W }: LiveInputs) => {
    if (!COSTS) return null;
    const parts: { name: string; usd: number }[] = [];
    if (COSTS.openai.usd !== null)
      parts.push({ name: "OpenAI", usd: COSTS.openai.usd });
    if (COSTS.openrouter.activity.usd !== null)
      parts.push({ name: "OpenRouter", usd: COSTS.openrouter.activity.usd });
    if (!parts.length) return null;
    /*
      A DONUT, with the dollars in the hole. The two providers are parts of
      one whole — the LLM bill in one currency over one window — and the whole
      is the figure the card exists to show. The legend carries what each
      part is a bill FOR, in the provider's own units.

      Hetzner is absent on purpose: it charges in euro, and a euro slice in a
      dollar ring is a comparison of two rulers. Replicate is absent because
      it reports no spend at all, and the caption says which of the two
      absences is which.
    */
    const o = COSTS.openai;
    const a = COSTS.openrouter.activity;
    const total = parts.reduce((n, p) => n + p.usd, 0);
    const detail: Record<string, string> = {
      OpenAI: `${count(o.projects.length)} project${o.projects.length === 1 ? "" : "s"}`,
      OpenRouter: `${count(a.models.length)} models · ${count(a.requests)} requests`,
    };
    return {
      slices: parts.map((p) => ({
        label: p.name,
        value: p.usd,
        text: usd(p.usd),
        sub: detail[p.name],
      })),
      center: { value: usd(total, total >= 100 ? 0 : 2), note: isAll(W) ? "all time collected" : `per ${COSTS.window.days} days` },
      caption:
        "USD only — Hetzner bills in euro and is on its own card" +
        (COSTS.replicate.connected ? " · Replicate reports no spend" : ""),
    };
  },

  "costs.sideBySide": ({ summary, costs: COSTS, window: W }: LiveInputs) => {
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
        `${llm.length > 1 ? "LLM APIs" : llm[0]!.name} · ${costDays(COSTS, W)}`,
        usd(llm.reduce((n, p) => n + p.usd, 0)),
      ]);
    if (COSTS.replicate.runs)
      rows.push([
        `Media · Replicate, ${costDays(COSTS, W)}`,
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

/** Which of the route's three churn windows the picker lands on. The three
 *  ARE the picker's numbers; "all" takes the widest, because a rate over the
 *  whole record divides by a book that did not exist yet. */
const churnDays = (w: WindowValue | undefined) => (w === "all" ? 90 : w === 7 || w === 90 ? w : 30);

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

  "stripe.net30": ({ points, stripe: S, window: W }: LiveInputs) => {
    const r = firstCurrency(S?.revenue);
    if (!r) return null;
    /* Under "all" the route measured the span itself, from the earliest day
       the history walk has filled — so the card names that day rather than a
       count of days nobody can check. */
    /* With the year: the walk reaches 2021, and "since 30 Oct" reads as this
       year's. */
    const since = isAll(W) && S?.history.from ? `since ${day(S.history.from, { year: true })}` : "";
    /*
      THE LEDGER'S NET AND NOTHING ELSE. Gross minus refunds, disputes and
      everything Stripe held back, off the balance ledger — never the charge
      walk's gross with a fee subtracted from it, which would be two
      measurements dated differently and subtracted anyway.
    */
    return {
      value: inCurrency(r.net, r.currency, 0),
      sub: also(
        also(
          `after ${inCurrency(r.fees, r.currency, 0)} of Stripe's fees, refunds and disputes · sales tax withheld is counted apart`,
          since,
        ),
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

  "stripe.churn": ({ stripe: S, window: W }: LiveInputs) => {
    /*
      CHURN HAS NO ALL-TIME READING. It is MRR lost over the book a window
      OPENED with, and a window that opens at the beginning of the record
      opens with an empty book. The route cuts it at seven, thirty and ninety
      days; the picker's number is one of those, and "all" is drawn over the
      widest — with the name saying ninety, not "all time".
    */
    const days = churnDays(W);
    const c = churnRow(S, days);
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
      ...(isAll(W) ? { name: `Revenue churn · ${days}d` } : {}),
      value: `${c.ratePct.toFixed(1)}%`,
      tone: c.ratePct >= 5 ? ("warn" as StatusTone) : ("ok" as StatusTone),
      sub: also(
        also(
          `${inCurrency(c.churnedFromStartMrr, c.currency, 0)} lost of a ` +
            `${inCurrency(c.startBookMrr, c.currency, 0)} starting book, reconstructed`,
          alsoLost > 0.005
            ? `${inCurrency(alsoLost, c.currency, 0)} more started and ended inside the window`
            : "",
        ),
        isAll(W) ? "a rate, so it has no all-time reading — this is the widest window" : "",
      ),
    };
  },

  "stripe.churnNotChurn": ({ stripe: S, window: W }: LiveInputs) => {
    const days = churnDays(W);
    const c = churnRow(S, days);
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
    return { ...(isAll(W) ? { name: `What is not churn · ${days}d` } : {}), rows };
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

  "stripe.gross": ({ stripe: S, window: W }: LiveInputs) => {
    const c = firstCurrency(S?.charges);
    if (!c?.series.length) return null;
    const span = isAll(W) && S?.history.from ? `since ${day(S.history.from, { year: true })}` : `over ${c.days} days`;
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
        `succeeded charges ${span} · one-off payments included, so this is ` +
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

  "stripe.declines": ({ stripe: S, window: W }: LiveInputs) => {
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
        `Refunds, ${isAll(W) ? "all time" : `${c.days}d`}`,
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

  "adsense.earnings": ({ adsense: A, window: W }: LiveInputs) => {
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
          `${count(A.sites.length)} site${A.sites.length === 1 ? "" : "s"} · ${heldDays(W, A.window.days, A.days.length, "AdSense")}`,
          "estimated — Google revises recent days",
        ),
        across(A.accounts.length),
      ),
      series: A.days.length > 1 ? A.days.map((d) => d.usd) : undefined,
      seriesAt: A.days.length > 1 ? A.days.map((d) => `${d.day}T00:00:00Z`) : undefined,
    };
  },

  "adsense.rpm": ({ adsense: A, window: W }: LiveInputs) => {
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
      labels: `${sites.length} site${sites.length === 1 ? "" : "s"} · earnings per thousand impressions, ${heldDays(W, A.window.days, A.days.length, "AdSense")}`,
      barLabels: sites.map(
        (s) =>
          `${s.site} · ${inCurrency(s.rpm!, A.currency ?? "USD")} RPM · ${inCurrency(s.usd, A.currency ?? "USD")} over ${isAll(W) ? `${A.days.length} days` : `${A.window.days} days`}`,
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

  "cf.total": ({ cloudflare: C, window: W }: LiveInputs) => {
    if (!C || !C.summary.withTraffic) return null;
    /* The sparkline is the window's own complete days — today is in the
       document and deliberately not on the line, because a bucket Cloudflare
       is still filling in draws as a collapse that never happened. */
    const done = C.daily.filter((d) => !d.partial);
    const blind = C.summary.withoutTraffic;
    return {
      value: compact(C.summary.requests),
      sub: also(
        `${C.summary.withTraffic} zone${C.summary.withTraffic === 1 ? "" : "s"} · ${cfDays(C, W)} to ${dayShort(C.window.through)}`,
        blind ? `${blind} not measured` : "",
      ),
      series: done.length > 1 ? done.map((d) => d.requests) : undefined,
      seriesAt: done.length > 1 ? done.map((d) => at(d.day)) : undefined,
    };
  },

  "cf.requests": ({ cloudflare: C, window: W }: LiveInputs) => {
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
        `top ${top.length} of ${measured.length} zones · ${cfDays(C!, W)}`,
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

  "cf.bandwidth": ({ cloudflare: C, window: W }: LiveInputs) => {
    if (!C || !C.summary.withTraffic) return null;
    return {
      value: bytes(C.summary.bytes, { base: 1000 }),
      sub: `served from the edge over ${cfDays(C, W)}, ${C.summary.withTraffic} zones`,
    };
  },

  "cf.threats": ({ cloudflare: C, window: W }: LiveInputs) => {
    /* Null when any zone's window came back from a field set that could not ask
       for threats: an undercount presented as a count is worse than a sample. */
    if (!C || C.summary.threats === null) return null;
    const share = C.summary.requests
      ? (C.summary.threats / C.summary.requests) * 100
      : null;
    return {
      value: count(C.summary.threats),
      sub: also(
        `Cloudflare's own count over ${cfDays(C, W)}`,
        share === null ? "" : `${percent(share, 2)} of requests`,
      ),
    };
  },

  "cf.cacheRatio": ({ cloudflare: C, window: W }: LiveInputs) => {
    /* A ratio over zero requests is unknowable rather than 0%, which is why
       this returns null instead of drawing a confident nothing. */
    if (!C || C.summary.cacheRatio === null) return null;
    return {
      value: pct(C.summary.cacheRatio),
      sub: `${count(C.summary.cached)} of ${count(C.summary.requests)} requests answered at the edge over ${cfDays(C, W)} · ${C.summary.proxied ?? "—"} of ${C.summary.records ?? "—"} records are proxied`,
    };
  },

  "cf.responses": ({ cloudflare: C, window: W }: LiveInputs) => {
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
      labels: also(
        classes.map(([name], i) => `${name} ${pct(totals[i]! / all, { digits: 0 })}`).join(" · "),
        cfDays(C!, W),
      ),
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
    /*
      THE DAILY LINE IS WEIGHTED THE SAME WAY THE HEADLINE IS. The portfolio
      series on the wire carries no position — a day's rank across properties
      is a mean over impressions, so it is folded here from each property's
      own day, and a day nobody saw any property is left out rather than
      drawn as a nought. Lower is better; the sparkline is the shape only.
    */
    const days = new Map<string, { weighted: number; impressions: number }>();
    for (const p of G.properties)
      for (const d of p.series ?? []) {
        if (d.position === null || d.impressions <= 0) continue;
        const e = days.get(d.day) ?? { weighted: 0, impressions: 0 };
        e.weighted += d.position * d.impressions;
        e.impressions += d.impressions;
        days.set(d.day, e);
      }
    const line = [...days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, e]) => ({ day, position: Number((e.weighted / e.impressions).toFixed(1)) }));
    return {
      value: place(G.totals.position),
      sub: also(
        `impression-weighted across ${G.totals.properties} properties`,
        drift,
      ),
      series: line.length > 1 ? line.map((d) => d.position) : undefined,
      seriesAt: line.length > 1 ? line.map((d) => at(d.day)) : undefined,
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

  "gsc.trend": ({ gsc: G, window: W }: LiveInputs) => {
    if (!G || G.series.length < 2) return null;
    return {
      /* "PORTFOLIO" ON THE CARD — Workdash's "Portfolio impressions per
         day" — unless the document was narrowed to one property, in which
         case the property's name is the honest word; see `portfolioLine`. */
      name: `Impressions a day · ${portfolioWord(G)} · ${windowLabel(W ?? G.seriesDays)}`,
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
      caption: portfolioLine(G),
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
  "hn.mentions": ({ demand: D, window: W }: LiveInputs) => {
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
        `Nothing in ${isAll(W) ? `the ${D.windowDays} days the route holds` : `${D.windowDays} days`} for ${D.terms.length} phrase${
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
  "gmail.contacts": ({ mail: M, window: W }: LiveInputs) => {
    if (!M?.connected.gmail) return null;
    const { people, new: fresh, historyFrom, windowDays } = M.outreach;
    if (!M.mailboxes.length) return null;
    return {
      value: count(people),
      sub: also(
        `${count(fresh)} first written to in ${isAll(W) ? `the ${windowDays}d the route holds` : `these ${windowDays}d`}`,
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

/** The last N complete days of a daily line, and the N before them where
 *  the line holds them. Today is dropped: the line is in the instance's
 *  timezone and its last bucket may still be filling. `null` when the line
 *  is too short to say anything. */
function umamiCut(
  line: { day: string; pageviews: number; sessions: number }[],
  w: WindowValue | undefined,
): { now: typeof line; before: typeof line | null } | null {
  const today = new Date().toISOString().slice(0, 10);
  const complete = line.filter((d) => d.day < today);
  if (!complete.length) return null;
  if (w === "all" || w === undefined) return { now: complete, before: null };
  const now = complete.slice(-w);
  const before = complete.length >= 2 * w ? complete.slice(-2 * w, -w) : null;
  return { now, before };
}

/** A percentage change over a sum, or null over nothing. */
const delta = (now: number, before: number) =>
  before > 0 ? Number((((now - before) / before) * 100).toFixed(1)) : null;

/** The clause a fixed-window Umami figure wears when the picker is elsewhere. */
const umamiFixed = (days: number, w: WindowValue | undefined) =>
  w === undefined || w === days ? "" : `Umami's own ${days} complete days — the picker does not move this one`;

Object.assign(LIVE_BUILDERS, {
  "umami.pageviews": ({ umami: U, window: W }: LiveInputs) => {
    const p = U?.portfolio;
    if (!p?.answering || p.window.pageviews === null) return null;
    /*
      THE HEADLINE FOLLOWS THE PICKER OFF THE DAILY LINE. The route's own
      window is the collector's thirty complete days, whatever `days` it was
      asked; the line beside it is up to ninety days and pageviews ADD across
      days, so any other span is a sum over the line — the last N complete
      days against the N before them where the line holds both. At thirty the
      route's figure is used as it always was. Visitors do not add and stay
      on their own card, at Umami's window, saying so.
    */
    const cut = umamiCut(p.days, W);
    if (W !== undefined && W !== p.window.days && cut) {
      return {
        value: count(cut.now.reduce((n, d) => n + d.pageviews, 0)),
        sub: also(
          also(
            `${p.answering} of ${p.websites} site${p.websites === 1 ? "" : "s"} answering`,
            heldDays(W, W === "all" ? cut.now.length : W, cut.now.length, "Umami's daily line"),
          ),
          cut.before
            ? movedBy(
                delta(cut.now.reduce((n, d) => n + d.pageviews, 0), cut.before.reduce((n, d) => n + d.pageviews, 0)),
                cut.now.length,
              )
            : isAll(W) ? "no previous window to compare with" : "no comparable window before it",
        ),
        series: cut.now.length > 1 ? cut.now.map((d) => d.pageviews) : undefined,
        seriesAt: cut.now.length > 1 ? cut.now.map((d) => at(d.day)) : undefined,
      };
    }
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
  "umami.visitors": ({ umami: U, window: W }: LiveInputs) => {
    const p = U?.portfolio;
    if (!p?.answering) return null;
    const sites = p.visitors.perSite.filter((s) => s.visitors !== null);
    if (!sites.length) return null;
    if (sites.length === 1) {
      const only = sites[0]!;
      return {
        value: count(only.visitors),
        /* Visitors are de-duplicated inside Umami's own window and cannot be
           re-cut from a daily line, so this stays at thirty whatever the
           picker says — and says so when they disagree. */
        sub: also(
          `${only.domain ?? only.entity} · de-duplicated over ${p.window.days} days`,
          umamiFixed(p.window.days, W),
        ),
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

  "umami.bounce": ({ umami: U, window: W }: LiveInputs) => {
    const w = U?.portfolio.window;
    if (!w || w.bounceRate === null) return null;
    return {
      value: percent(w.bounceRate),
      /* Computed from the SUMS rather than averaged across sites: an average
         of two percentages weights four visits like four thousand. */
      sub: also(
        `a visit with one pageview, Umami's own definition · ${count(w.bounces)} of ${count(w.visits)} visits`,
        umamiFixed(w.days, W),
      ),
    };
  },

  "umami.avgVisit": ({ umami: U, window: W }: LiveInputs) => {
    const w = U?.portfolio.window;
    if (!w || w.avgVisitSeconds === null) return null;
    return {
      value: secs(w.avgVisitSeconds),
      sub: also(`total time ÷ ${count(w.visits)} visits, over ${w.days} days`, umamiFixed(w.days, W)),
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

  "pypi.last30": ({ pypi: P, window: W }: LiveInputs) => {
    const s = P?.summary;
    if (!s || !P?.days.length) return null;
    /* The same cut `npm.last30` makes, for the same reason: the route takes
       no window and the line is the record. */
    const cut = sliceDays(P.days, W);
    const thirty = W === undefined || W === 30;
    return {
      value: count(thirty ? s.last30 : cut.sum),
      /* Rolling from the days HELD, which is not a calendar month and not
         pypistats' own `last_month` window. Saying which is the difference
         between a figure and a figure somebody can check. */
      sub: thirty
        ? `rolling 30 days of ${P.days.length} held · mirrors excluded`
        : `${heldDays(W, W === "all" ? cut.days : W, cut.days, "the pypistats line")} · mirrors excluded`,
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

  "pypi.packages": ({ pypi: P, window: W }: LiveInputs) => {
    const packages = P?.packages ?? [];
    if (!packages.length) return null;
    return {
      headers: ["Package", "Last full week", windowLabel(W ?? 30), "Version", "State"],
      table: packages.map((p) => [
        p.package,
        p.lastCompleteWeek ? count(p.lastCompleteWeek.downloads) : "—",
        count(W === undefined || W === 30 ? p.last30 : sliceDays(p.days, W).sum),
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

/* ---------------------------------------------------------------- llm usage
   THE LLM USAGE BOARD. The OpenRouter half reads the costs report the Costs
   board already reads — nothing is fetched twice — and the other half reads
   this box's own report of what its chat and runs consumed. Two rules hold
   every card: a figure is what a ledger recorded, and a division with a zero
   under it is written as a sentence rather than as infinity or nought. */

/** Days of balance left before the tile turns amber, then red — the same
 *  two lines the page this board replaces drew. */
const RUNWAY_WARN = 21;
const RUNWAY_CRIT = 7;

/** An OBSERVED rate — dollars charged over tokens processed — and null when
 *  nothing was processed. Never a price list: OpenRouter's bill is the only
 *  price this box has, and this is that bill divided by what it bought. */
const perMillion = (spend: number, tokens: number): string | null =>
  tokens > 0 ? `${usd((spend / tokens) * 1_000_000)}/M` : null;

const tokensOf = (r: { promptTokens: number; completionTokens: number }) =>
  r.promptTokens + r.completionTokens;

/** What a budget ledger status means, in the owner's words. */
const LEDGER_STATUS: Record<string, string> = {
  reported: "Reported by the provider",
  estimated: "Estimated from the request size",
  reserved: "Reserved, still in flight",
  uncertain: "Uncertain — the call timed out",
  "unmetered-agent": "Agent turns, unmetered",
};

Object.assign(LIVE_BUILDERS, {
  "openrouter.runway": ({ costs: COSTS }: LiveInputs) => {
    const or = COSTS?.openrouter;
    const c = or?.credits;
    const a = or?.activity;
    if (!c || !a || a.usd === null) return null;
    if (!a.dayCount || a.usd <= 0)
      return {
        value: "—",
        sub: `${usd(c.balance)} left · nothing spent in ${COSTS!.window.days} days, so no rate to project`,
      };
    /* The window's own average, and the sentence says so: a runway is a
       forecast, and a forecast without its assumption is a guess. */
    const perDay = a.usd / a.dayCount;
    const days = c.balance / perDay;
    return {
      value: `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`,
      tone: days < RUNWAY_CRIT ? "bad" : days < RUNWAY_WARN ? "warn" : "ok",
      sub: `${usd(c.balance)} left at ${usd(perDay)}/day, the mean over ${a.dayCount} charged days`,
    };
  },

  "openrouter.tokens": ({ costs: COSTS }: LiveInputs) => {
    const a = COSTS?.openrouter.activity;
    if (!a || a.usd === null) return null;
    const tokens = a.promptTokens + a.completionTokens;
    const rate = perMillion(a.usd, tokens);
    return {
      value: compact(tokens),
      sub: tokens
        ? `${compact(a.promptTokens)} in, ${compact(a.completionTokens)} out · ${count(a.requests)} requests · ${rate} blended`
        : "nothing processed in the window",
    };
  },

  "openrouter.daily": ({ costs: COSTS }: LiveInputs) => {
    const a = COSTS?.openrouter.activity;
    if (!a?.days.length) return null;
    const total = a.days.reduce((n, d) => n + d.usd, 0);
    return {
      chart: [
        {
          label: "Spend, USD",
          points: a.days.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.usd })),
        },
      ],
      unit: "usd" as const,
      caption:
        `${usd(total)} over ${a.days.length} charged days · mean ${usd(total / a.days.length)}/day · ` +
        `the newest day is still filling`,
    };
  },

  "openrouter.tokensDaily": ({ costs: COSTS }: LiveInputs) => {
    const a = COSTS?.openrouter.activity;
    if (!a?.days.length) return null;
    const total = a.days.reduce((n, d) => n + tokensOf(d), 0);
    const spend = a.days.reduce((n, d) => n + d.usd, 0);
    return {
      chart: [
        { label: "Prompt", points: a.days.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.promptTokens })) },
        { label: "Completion", points: a.days.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.completionTokens })) },
      ],
      unit: "count" as const,
      caption: also(
        `${compact(total)} tokens over ${a.days.length} charged days`,
        perMillion(spend, total) ? `${perMillion(spend, total)} blended across the window` : "",
      ),
    };
  },

  "openrouter.modelTable": ({ costs: COSTS }: LiveInputs) => {
    const a = COSTS?.openrouter.activity;
    if (!a?.models.length) return null;
    /* Share is of the TOP spender, not of the total — a bar scaled to the
       total would make every model but the first look like a rounding error
       on a board where one model does most of the work. */
    const top = a.models[0]!.usd;
    return {
      headers: ["Model", "Spend", "Share", "Requests", "Tokens", "$/M"],
      marks: a.models.map((m) => m.model),
      table: a.models.map((m) => {
        const tokens = tokensOf(m);
        return [
          m.model,
          usd(m.usd),
          top > 0 ? percent((m.usd / top) * 100, 0) : "—",
          count(m.requests),
          compact(tokens),
          perMillion(m.usd, tokens) ?? "no tokens",
        ];
      }),
    };
  },

  "openrouter.keyTable": ({ costs: COSTS }: LiveInputs) => {
    const k = COSTS?.openrouter.keys;
    if (!k?.list.length) return null;
    return {
      headers: ["Key", "Lifetime", "This month", "7d", "Today", "Cap"],
      table: k.list.map((key) => [
        key.name + (key.disabled ? " · disabled" : ""),
        usd(key.usd),
        usd(key.usdMonth),
        usd(key.usdWeek),
        usd(key.usdDay),
        /* Null is "no cap at all", which is a different fact from a cap of
           nothing, and the guard OpenRouter offers is worth naming as absent. */
        key.spendLimit === null
          ? "none"
          : `${usd(key.spendLimit)}${key.limitRemaining !== null ? ` · ${usd(key.limitRemaining)} left` : ""}`,
      ]),
    };
  },

  /* ------------------------------------------------ this box's own use */

  "llm.today": ({ llm: L }: LiveInputs) => {
    if (!L) return null;
    const t = L.today;
    if (!t.calls) return { value: "0", sub: "no chat turn or run has reported usage today" };
    return {
      value: compact(t.tokens),
      sub: `${count(t.calls)} ${t.calls === 1 ? "call" : "calls"} · chat ${compact(t.chatTokens)} · runs ${compact(t.runTokens)}`,
    };
  },

  "llm.window": ({ llm: L, window: W }: LiveInputs) => {
    if (!L) return null;
    const unreported = L.unreported.chatTurns + L.unreported.runs;
    /* The ledgers are this box's own and start when it did; under "all" the
       route caps at four hundred days and the days with anything in them are
       the honest span. */
    const span = heldDays(W, L.window.days, L.days.filter((d) => d.calls > 0).length, "the ledgers");
    if (!L.total.calls) return { value: "0", sub: `nothing reported in ${span}` };
    return {
      value: compact(L.total.tokens),
      sub: also(
        `${count(L.total.calls)} calls over ${span} · ${compact(L.total.promptTokens)} in, ${compact(L.total.completionTokens)} out`,
        /* Named beside the total rather than folded into it as zero: a turn
           that reported nothing cost something, and this figure is short by
           exactly that much. */
        unreported ? `${count(unreported)} reported no usage and are not in this figure` : "",
      ),
    };
  },

  "llm.daily": ({ llm: L }: LiveInputs) => {
    if (!L?.days.length) return null;
    const total = L.days.reduce((n, d) => n + d.chatTokens + d.runTokens, 0);
    if (!total) return null;
    return {
      chart: [
        { label: "Chat", points: L.days.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.chatTokens })) },
        { label: "Runs", points: L.days.map((d) => ({ ts: `${d.day}T00:00:00Z`, value: d.runTokens })) },
      ],
      unit: "count" as const,
      caption: `${compact(total)} tokens the backends reported over ${L.window.days} days · a day with nothing is drawn as nothing`,
    };
  },

  "llm.byModel": ({ llm: L }: LiveInputs) => {
    const models = (L?.models ?? []).filter((m) => m.tokens > 0).slice(0, 8);
    if (!models.length) return null;
    return {
      bars: models.map((m) => m.tokens),
      marks: models.map((m) => m.model),
      labels: models
        .slice(0, 4)
        .map((m) => `${shortModel(m.model)} ${compact(m.tokens)}`)
        .join(" · "),
      barLabels: models.map(
        (m) => `${m.model} · ${compact(m.tokens)} tokens · ${count(m.calls)} calls${m.backend ? ` · ${m.backend}` : ""}`,
      ),
    };
  },

  "llm.byWork": ({ llm: L }: LiveInputs) => {
    const work = (L?.work ?? []).filter((w) => w.calls > 0);
    if (!work.length) return null;
    return {
      rows: work.slice(0, 9).map((w) => [
        w.label,
        `${compact(w.tokens)} · ${count(w.calls)} ${w.calls === 1 ? "call" : "calls"}`,
      ] as [string, string]),
    };
  },

  "llm.byVenture": ({ llm: L }: LiveInputs) => {
    const ventures = L?.ventures ?? [];
    if (!ventures.length) return null;
    return {
      rows: ventures.slice(0, 9).map((v) => [
        v.name,
        `${compact(v.tokens)} · ${count(v.calls)} ${v.calls === 1 ? "run" : "runs"}`,
      ] as [string, string]),
    };
  },

  "llm.budget": ({ llm: L }: LiveInputs) => {
    if (!L) return null;
    const b = L.budget;
    const meter = (label: string, used: number, limit: number, fmt: (n: number) => string): Meter => ({
      label,
      value: Math.min(100, (used / limit) * 100),
      warn: 80,
      crit: 100,
      note: `${fmt(used)} of ${fmt(limit)}`,
    });
    const meters: Meter[] = [meter("Calls today", b.today.calls, b.limits.dailyCalls, count)];
    if (b.limits.automationDailyCalls)
      meters.push(meter("Automation calls", b.today.automation, b.limits.automationDailyCalls, count));
    if (b.limits.dailyTokens) meters.push(meter("Tokens today", b.today.tokens, b.limits.dailyTokens, compact));
    /* A dollar meter only when the owner set a price: without one every usd
       in the ledger is zero, and a meter at zero would read as thrift. */
    if (b.limits.dailyUsd && b.priced) meters.push(meter("Spend today", b.today.usd, b.limits.dailyUsd, (n) => usd(n)));
    return { meters };
  },

  "llm.ledger": ({ llm: L }: LiveInputs) => {
    if (!L) return null;
    const b = L.budget;
    const rows: [string, string][] = b.today.byStatus.map((r) => [
      LEDGER_STATUS[r.status] ?? r.status,
      also(`${count(r.calls)} calls · ${compact(r.tokens)}`, b.priced ? usd(r.usd) : ""),
    ]);
    if (!rows.length) rows.push(["Nothing metered today", "the ledger only counts runs"]);
    rows.push([
      "The price behind every dollar here",
      b.priced
        ? `${usd(b.limits.usdPerMillion)} per million tokens, set under Usage limits`
        : "none set — dollars are not measured, only tokens",
    ]);
    return { rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ============================================================== finance ==
   THE RATE CARD BEHIND THE FINANCE PAGE, DRAWN AS CARDS.

   Every figure here is per currency and nothing adds across them — that is the
   ledger's own rule and these cards keep it. Where a card can only draw ONE
   figure (a total, a ring) it draws the currency most of the bill is in, says
   so, and names what the other currencies hold beside it. A line with no
   price is counted and named, never folded in as zero: "23 domains, none
   priced" is a fact about the bill and a €0.00 slice is not.
   ======================================================================== */

/**
 * The currency that carries most of the monthly bill, with its amount.
 *
 * Null when nothing is priced, which keeps the card a sample rather than
 * printing a "€0.00" that reads as a free portfolio.
 */
function leadCurrency(finance: FinanceReport): { currency: string; amount: number } | null {
  const amounts = finance.summary.monthly.amounts;
  if (!amounts.length) return null;
  return amounts.slice().sort((a, b) => b.amount - a.amount)[0] ?? null;
}

/** Where a ledger row's figure came from, as the row's small print. */
function sourceWord(e: Expense): string {
  if (e.source === "manual") return "typed";
  return e.ownerFields.includes("amount") ? `${e.source} · price typed` : e.source;
}

/**
 * The currency a one-figure card draws in, and the converter into it.
 *
 * The display currency when the owner set one; otherwise the currency most of
 * the bill is in. `into` answers with the converted amount and the rate it
 * used — a typed one first, the ECB's cross rate otherwise — or null when
 * neither can price the pair, in which case the caller draws the figure in
 * its own currency with no share rather than guessing.
 */
function ringCurrency(finance: FinanceReport): string | null {
  return finance.summary.fx.displayCurrency ?? leadCurrency(finance)?.currency ?? null;
}
function converter(finance: FinanceReport, to: string) {
  const { rates, reference } = finance.summary.fx;
  return (amount: number, from: string) => {
    const r = rateBetween(from, to, rates, reference);
    return r ? { amount: amount * r.rate, ...r } : null;
  };
}
/** "at the ECB reference rate of 5 Sept" / "at the rate you typed". */
function rateWords(r: { source: "typed" | "ecb"; asOf: string | null }): string {
  return r.source === "typed"
    ? `at the rate typed on the Finance page${r.asOf ? ` (${r.asOf})` : ""}`
    : `at the ECB reference rate of ${r.asOf ?? "its last file"}`;
}

/** /mo, /yr, once — the bill at the cadence it is actually charged at. */
const cadence = (period: Expense["period"]) =>
  period === "once" ? " once" : period === "yearly" ? "/yr" : "/mo";

Object.assign(LIVE_BUILDERS, {
  "finance.monthly": ({ finance }: LiveInputs) => {
    if (!finance) return null;
    const lead = leadCurrency(finance);
    if (!lead) return null;
    const annual =
      finance.summary.annual.amounts.find((a) => a.currency === lead.currency)?.amount ?? lead.amount * 12;
    const rest = finance.summary.monthly.amounts.filter((a) => a.currency !== lead.currency);
    const unpriced = finance.summary.counts.unpriced;
    /*
      THE HEADLINE IS ONE CURRENCY'S BILL, and the others are named beside it
      with what they come to all together — converted, marked ≈, the rate
      named — when a rate can be had. When it cannot, the other currencies are
      listed and nothing is added.
    */
    const ring = ringCurrency(finance) ?? lead.currency;
    const into = converter(finance, ring);
    const parts = finance.summary.monthly.amounts.map((a) => ({ ...a, conv: into(a.amount, a.currency) }));
    const allIn = parts.every((p) => p.conv !== null)
      ? parts.reduce((n, p) => n + p.conv!.amount, 0)
      : null;
    const rateUsed = parts.map((p) => p.conv).find((c) => c && c.source && c.rate !== 1) ?? null;
    return {
      value: money(lead.amount, lead.currency),
      tag: "rate card",
      sub: also(
        `${money(annual, lead.currency, { digits: 0 })}/yr, each bill at its real cadence`,
        [
          ...rest.map((a) => `+ ${money(a.amount, a.currency)} in ${a.currency}`),
          allIn !== null && rest.length && rateUsed
            ? `≈ ${money(allIn, ring)} all in, ${rateWords(rateUsed)}`
            : "",
          unpriced ? `${count(unpriced)} line${unpriced === 1 ? "" : "s"} unpriced and left out` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    };
  },

  "finance.groups": ({ finance }: LiveInputs) => {
    if (!finance) return null;
    const lead = leadCurrency(finance);
    if (!lead) return null;
    /*
      THE BILL BY GROUP, IN ONE CURRENCY. A donut is a whole and the ledger
      adds nothing across currencies, so the ring is the currency that
      carries most of the bill and the caption names the rest. A group with
      lines and no prices stays in the legend at zero with its count.
    */
    const live = finance.expenses.filter((e) => !e.archived);
    const group = (currency: string, label: string, cats: string[], unit: string) => {
      const rows = live.filter((e) => e.currency === currency && cats.includes(e.category));
      const priced = rows.filter((e) => e.monthly !== null);
      const unpriced = rows.length - priced.length;
      return {
        label,
        currency,
        value: priced.reduce((n, e) => n + (e.monthly ?? 0), 0),
        rows: rows.length,
        sub:
          `${count(rows.length)} ${unit}${rows.length === 1 ? "" : "s"}` +
          (unpriced
            ? unpriced === rows.length
              ? " · none priced"
              : ` · ${count(unpriced)} unpriced`
            : ""),
      };
    };
    const GROUPS: [string, string[], string][] = [
      ["Servers", ["server"], "box"],
      ["Domains", ["domain"], "name"],
      ["Services", ["service", "subscription"], "subscription"],
      ["Other", ["salary", "other"], "line"],
    ];
    /* The ring's currency first, then every other currency the ledger holds,
       so a group billed in euro on a dollar board is a row with its figure
       and no share rather than a line that vanished. */
    const currencies = [
      lead.currency,
      ...[...new Set(live.map((e) => e.currency))].filter((c) => c !== lead.currency).sort(),
    ];
    const groups = currencies.flatMap((c) =>
      GROUPS.map(([label, cats, unit]) => group(c, label, cats, unit)).filter((g) => g.rows > 0),
    );
    const power = finance.power.lines.filter((l) => l.amount !== null);
    for (const c of currencies) {
      const lines = power.filter((l) => l.currency === c);
      if (lines.length)
        groups.push({
          label: "Electricity",
          currency: c,
          value: lines.reduce((n, l) => n + (l.amount ?? 0), 0),
          rows: lines.length,
          sub: `${count(lines.length)} machine${lines.length === 1 ? "" : "s"} · watts estimated`,
        });
    }
    if (!groups.length) return null;
    /*
      ONE RING, ONE CURRENCY, EVERY GROUP ON IT WHEN A RATE CAN BE HAD. A
      euro server bill beside dollar subscriptions is the ordinary case for
      this ledger, and a ring that dropped the servers because they were in
      euro was drawing the bill with its biggest fixed line missing — which is
      what the owner saw. So each foreign group is converted into the ring's
      currency with a typed rate first and the ECB's cross rate otherwise,
      drawn with a ≈ and its native figure on the row, and the caption names
      the rate and its date. A group nobody can price into the ring — no
      typed rate, no ECB leg — stays a row with no share, as before.
    */
    const ringCode = ringCurrency(finance) ?? lead.currency;
    const into = converter(finance, ringCode);
    const drawn = groups.map((g) => {
      const conv = g.currency === ringCode ? { amount: g.value, rate: 1, source: "typed" as const, asOf: null } : into(g.value, g.currency);
      return { ...g, conv };
    });
    const total = drawn.reduce((n, g) => n + (g.conv?.amount ?? 0), 0);
    const converted = drawn.filter((g) => g.currency !== ringCode && g.conv);
    const unconverted = drawn.filter((g) => !g.conv);
    const rateUsed = converted[0]?.conv ?? null;
    return {
      slices: drawn.map((g) => ({
        label: g.label,
        value: g.conv?.amount ?? 0,
        text: g.conv
          ? g.currency === ringCode
            ? money(g.value, ringCode)
            : `≈${money(g.conv.amount, ringCode)}`
          : money(g.value, g.currency),
        sub: g.conv
          ? g.currency === ringCode
            ? g.sub
            : `${money(g.value, g.currency)} · ${g.sub}`
          : `${g.sub} · in ${g.currency}, no rate to draw it at`,
      })),
      center: {
        value: `${converted.length ? "≈" : ""}${money(total, ringCode, { digits: total >= 100 ? 0 : 2 })}`,
        note: "per month",
      },
      caption:
        (converted.length && rateUsed
          ? `${[...new Set(converted.map((g) => g.currency))].join(", ")} lines converted into ${ringCode} ${rateWords(rateUsed)} — approximate, and the native figure is on each row.`
          : `Every line in ${ringCode}.`) +
        (unconverted.length
          ? ` ${[...new Set(unconverted.map((g) => g.currency))].join(", ")} lines have no rate and are listed with no share.`
          : ""),
    };
  },

  "finance.servers": ({ finance }: LiveInputs) => {
    if (!finance) return null;
    const rows = finance.expenses.filter((e) => !e.archived && e.category === "server");
    if (!rows.length) return null;
    const priced = rows
      .filter((e) => e.monthly !== null)
      .sort((a, b) => (b.monthly ?? 0) - (a.monthly ?? 0));
    const currency = priced[0]?.currency ?? rows[0]!.currency;
    const total = priced
      .filter((e) => e.currency === currency)
      .reduce((n, e) => n + (e.monthly ?? 0), 0);
    return {
      ranked: priced.slice(0, 10).map((e) => ({
        label: e.label,
        // A box billed in another currency has no length on this axis; its
        // figure still says what it is.
        value: e.currency === currency ? (e.monthly ?? 0) : 0,
        text: `${money(e.monthly, e.currency)}/mo`,
        sub: sourceWord(e),
      })),
      caption:
        `${count(rows.length)} box${rows.length === 1 ? "" : "es"} · ${money(total, currency)}/mo` +
        (rows.length > priced.length ? ` · ${count(rows.length - priced.length)} unpriced` : "") +
        (priced.length > 10 ? " · top 10 drawn" : ""),
    };
  },

  "finance.services": ({ finance }: LiveInputs) => {
    if (!finance) return null;
    /*
      THE BILLS THAT BUY THE RIGHT TO SHIP RATHER THAN COMPUTE — developer
      programs, AI plans. Each at the cadence it is billed at: a yearly bill
      says /yr and is not spread, a one-off says once and is in neither total.
      Nothing under the heading is a sentence saying where to type one.
    */
    const rows = finance.expenses.filter(
      (e) => !e.archived && (e.category === "service" || e.category === "subscription"),
    );
    if (!rows.length)
      return { rows: [["No services in the ledger yet", "add one under Finance → Ledger"]] };
    const sorted = rows.slice().sort((a, b) => (b.monthly ?? -1) - (a.monthly ?? -1));
    return {
      rows: sorted.slice(0, 8).map((e) => [
        `${e.label}${e.period === "once" ? " · one-time" : e.period === "yearly" ? " · billed yearly" : ""}${
          e.confidence ? ` · ${e.confidence}` : ""
        }`,
        e.amount === null ? "no price yet" : `${money(e.amount, e.currency)}${cadence(e.period)}`,
      ]),
    };
  },

  "finance.power": ({ finance }: LiveInputs) => {
    if (!finance) return null;
    const lines = finance.power.lines;
    if (!lines.length) {
      const rows: [string, string][] = [
        finance.power.machines.length
          ? ["No wattage profile yet", "type idle and busy watts under Finance → Power"]
          : ["No workstation connected", "connect one under Integrations → Workstation"],
      ];
      if (finance.summary.tariff.perKwh === null)
        rows.push(["No price per kWh set", "set the tariff on the Finance integration"]);
      return { rows };
    }
    return {
      // The hours may be metered; the watts never are — see Finance → Power.
      tag: "est.",
      rows: lines.map((l) => [
        `${l.label}${l.confidence ? ` · ${l.confidence} hours` : " · no hours observed"}`,
        l.amount === null
          ? "unpriced — no tariff"
          : `${money(l.amount, l.currency)}/mo${l.kwh !== null ? ` · ${l.kwh} kWh` : ""}`,
      ]),
    };
  },

  "finance.domains": ({ finance }: LiveInputs) => {
    if (!finance) return null;
    const rows = finance.expenses.filter((e) => !e.archived && e.category === "domain");
    if (!rows.length) return null;
    /*
      SOONEST DECISION FIRST. A domain is the one line on this board with a
      date on it, and the date is the half that makes the price something to
      act on. Names with no date go to the back — unknown is not urgent — and
      what was not drawn is counted in the last row.
    */
    const byDate = (e: Expense) => (e.renewalOn ? Date.parse(e.renewalOn) : Number.POSITIVE_INFINITY);
    const sorted = rows.slice().sort((a, b) => byDate(a) - byDate(b) || a.label.localeCompare(b.label));
    const shown = sorted.slice(0, 9);
    const priced = rows.filter((e) => e.monthly !== null).length;
    const out: [string, string][] = shown.map((e) => {
      const renewal = finance.renewals.renewals.find((r) => r.id === e.id);
      const when = renewal
        ? renewal.inDays < 0
          ? `${count(-renewal.inDays)}d past`
          : `renews in ${count(renewal.inDays)}d`
        : e.renewalOn
          ? `renews ${e.renewalOn}`
          : "";
      const price = e.amount === null ? "no price" : `${money(e.amount, e.currency)}${cadence(e.period)}`;
      return [e.label, also(price, when)];
    });
    if (rows.length > shown.length)
      out.push([
        `${count(rows.length - shown.length)} more`,
        priced ? `${count(priced)} of ${count(rows.length)} priced` : "none priced yet",
      ]);
    return { rows: out };
  },

  "finance.renewals": ({ finance }: LiveInputs) => {
    if (!finance) return null;
    const r = finance.summary.renewals;
    return {
      value: count(r.within90Days),
      tone: r.overdue > 0 ? ("bad" as StatusTone) : r.undecided > 0 ? ("warn" as StatusTone) : undefined,
      sub: [
        r.within90Days ? `${count(r.undecided)} undecided` : "nothing renews in 90 days",
        r.overdue ? `${count(r.overdue)} date${r.overdue === 1 ? " has" : "s have"} already passed` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  },

  "finance.unpriced": ({ finance }: LiveInputs) => {
    if (!finance) return null;
    const n = finance.summary.counts.unpriced;
    return {
      value: count(n),
      tone: n > 0 ? ("warn" as StatusTone) : undefined,
      sub: n ? "left out of every total — the bill above is a floor" : "every line in the ledger has a price",
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ================================================================ payments
   THE PAYMENTS BOARD — workstream "payments-board", 2026-09-08.

   One builder per `payments.*` widget in the catalog. The arithmetic they
   share — the fail rate, the fixed 7d-against-30d drift, the alerts and
   their thresholds, the plan split, the sixty-day cut through the queue —
   lives in ./payments.ts, where the test runner can hold it to account.

   THREE DOCUMENTS BESIDE THE STRIPE ONE, AND NOTHING IS ADDED ACROSS THEM.
   The leakage buckets, the dispute cases and the recovery queue are each
   computed from the Stripe tables on every read, and each carries a figure
   that LOOKS like one on the Stripe document: the dispute cases are dated by
   the bank and the ledger's dispute debit by the posting; the queue's monthly
   amount is normalised the way MRR is and is still not MRR. Every builder
   below reads one document per figure and says which.
*/

/** The recovery queue's line for a person: the address when contact access
 *  is on, the domain when it is off, and the product beside it. */
function leavingWho(c: RecoveryCase): string {
  const ctx = (c.context ?? {}) as { product?: string; plan?: string };
  const who = c.contact.address ?? (c.contact.domain ? `someone at ${c.contact.domain}` : "no address on the subscription");
  return also(who, ctx.product ?? ctx.plan ?? "");
}

/** "yearly" or "monthly", from the price's own interval; empty when the
 *  case carries none. Goes in the value column, where nothing truncates. */
function leavingInterval(c: RecoveryCase): string {
  const i = (c.context ?? {}) as { interval?: string };
  return i.interval === "year" ? "yearly" : i.interval === "month" ? "monthly" : (i.interval ?? "");
}

/** "2–8 Sept" inside one month, "26 Aug – 1 Sept" across two, or the one
 *  day when a bucket is a day. Short because the row's other words — the
 *  counts — are the long ones, and the date is what must not truncate. */
function bucketLabel(b: { from: string; to: string }): string {
  if (b.from === b.to) return dayShort(b.from);
  const sameMonth = b.from.slice(0, 7) === b.to.slice(0, 7);
  return sameMonth ? `${Number(b.from.slice(8, 10))}–${dayShort(b.to)}` : `${dayShort(b.from)} – ${dayShort(b.to)}`;
}

/** Succeeded against failed, the split every attempts bar draws. */
const attemptParts = (succeeded: number, failed: number): ProportionPart[] => [
  { label: "succeeded", value: succeeded, text: count(succeeded), tone: "ok" },
  { label: "failed", value: failed, text: count(failed), tone: "bad" },
];

/** THE BANK'S SENTENCE, CUT TO A CLAUSE. Stripe's failure messages run to a
 *  paragraph ("Provide a new payment method to attempt to fulfill this
 *  PaymentIntent…"); a table column holds the first clause and the full text
 *  is on the row's hover, which `Figures` draws from the cell itself. */
function shortReason(text: string): string {
  const clause = text.split(/[.;:—]\s/)[0]!.trim();
  return clause.length > 56 ? `${clause.slice(0, 55).trimEnd()}…` : clause;
}

Object.assign(LIVE_BUILDERS, {
  "payments.mrr": ({ stripe: S }: LiveInputs) => {
    const m = firstCurrency(S?.mrr);
    if (!m) return null;
    const { top, more } = planSplit(S?.plans ?? [], 4);
    /*
      THE BAR IS THE WHOLE MRR, NOT THE TOP FOUR PLANS. Workdash draws the
      four biggest plans and writes "+N more" beside them, which makes the
      bar a split of a number nobody can see; here the remainder is a
      segment of its own, so the four shares are shares of the figure above
      the bar. A one-off payment has no plan and is on the gross tile.
    */
    const drawn = top.reduce((n, p) => n + p.mrr, 0);
    const rest = Math.max(0, m.amount - drawn);
    const parts: ProportionPart[] = top.map((p) => ({
      label: p.name,
      value: p.mrr,
      text: inCurrency(p.mrr, p.currency, 0),
    }));
    if (more && rest > 0.005)
      parts.push({ label: `${count(more)} more plan${more === 1 ? "" : "s"}`, value: rest, text: inCurrency(rest, m.currency, 0) });
    return {
      value: inCurrency(m.amount, m.currency, 0),
      sub: also(
        also(
          `ARR ${inCurrency(m.arr, m.currency, 0)}/yr — this × 12, not a forecast`,
          `${count(m.subscriptions)} billing subscription${m.subscriptions === 1 ? "" : "s"}`,
        ),
        also(
          m.discountedAway > 0.005
            ? `net of ${inCurrency(m.discountedAway, m.currency)}/mo in coupons on ${count(m.discounted)} sub${m.discounted === 1 ? "" : "s"}`
            : "",
          across(S?.accounts.length),
        ),
      ),
      partsLabel: "MRR by plan",
      parts,
    };
  },

  "payments.subs": ({ stripe: S }: LiveInputs) => {
    const s = S?.subscriptions;
    if (!s) return null;
    /*
      THE BOOK BY STATE, AND ONLY THE LIVE STATES. Cancelled and expired
      checkouts are deliberately not in the bar: it is what is billing, what
      is about to, and what is failing to — the three a person can act on.
      "Active" is BILLING, as on the stripe.subs tile: a trial is live and
      has never sent a cent, so it is its own segment rather than folded in.
    */
    const parts: ProportionPart[] = [{ label: "active", value: s.billing, text: count(s.billing), tone: "ok" }];
    if (s.trialing) parts.push({ label: "trialing", value: s.trialing, text: count(s.trialing) });
    if (s.pastDue) parts.push({ label: "past due", value: s.pastDue, text: count(s.pastDue), tone: "warn" });
    const aside = [
      s.trialing ? `${count(s.trialing)} trialing` : "",
      s.pastDue ? `${count(s.pastDue)} past due` : "",
    ].filter(Boolean);
    return {
      value: count(s.billing),
      sub: also(
        aside.length ? `billing now · ${aside.join(" · ")}, counted apart` : "billing now · none trialing, none past due",
        across(S?.accounts.length),
      ),
      partsLabel: "The live subscription book by state",
      parts,
    };
  },

  "payments.gross": ({ stripe: S, window: W }: LiveInputs) => {
    const c = firstCurrency(S?.charges);
    if (!c) return null;
    const r = firstCurrency(S?.revenue);
    const attempts = c.succeeded + c.failed;
    /*
      GROSS IS THE CHARGE WALK, NET IS THE LEDGER, and they sit in one
      sentence without being subtracted from each other: gross is dated by
      the charge and net by the posting, so "gross minus net" would be two
      populations dated differently and subtracted anyway. The fee rate is
      Stripe's cut EX-TAX over gross, the only blended rate this box quotes.
    */
    return {
      name: `Gross · ${windowLabel(W ?? c.days)}`,
      tag: "metered",
      value: inCurrency(c.gross, c.currency, 0),
      sub: also(
        also(
          `${count(c.succeeded)} of ${count(attempts)} attempts settled`,
          c.refunds ? `${inCurrency(c.refunded, c.currency)} refunded` : "",
        ),
        r
          ? `${inCurrency(r.net, r.currency, 0)} net after ${inCurrency(r.feesTotal, r.currency, 0)} in fees and tax withheld` +
              (r.feeRatePct === null ? "" : ` · Stripe's cut ${r.feeRatePct.toFixed(1)}% of gross`)
          : "",
      ),
      partsLabel: `Payment attempts over ${windowLabel(W ?? c.days)}`,
      parts: attemptParts(c.succeeded, c.failed),
    };
  },

  "payments.alerts": ({ stripe: S, disputes: D, queue: Q }: LiveInputs) => {
    const c = firstCurrency(S?.charges);
    if (!S?.connected || !c) return null;
    const d = firstCurrency(D?.currencies);
    const alerts = worthALook({
      days: c.days,
      succeeded: c.succeeded,
      failed: c.failed,
      blocked: c.blocked,
      declined: c.declined,
      pastDue: S.subscriptions.pastDue,
      disputesNeedingResponse: d?.cases.needsResponseNow ?? 0,
      disputesAtStake: d?.cases.openNowAmount ?? 0,
      nextEvidenceDueBy: d?.cases.nextEvidenceDueBy ? dayShort(d.cases.nextEvidenceDueBy.slice(0, 10)) : null,
      failingInvoices: Q?.counts.byKind.payment_failed ?? 0,
      fmtMoney: (n) => inCurrency(n, d?.currency ?? c.currency),
    });
    const statuses: [string, StatusTone][] = alerts.map((a) => [a.text, a.tone]);
    /*
      A DOCUMENT THAT HAS NOT ARRIVED IS SAID, NOT SKIPPED. The alerts above
      default a missing document to zero because the sentence needs a number,
      and a zero that came from "not read" would let a dispute with a deadline
      pass in silence — so the absence is a line of its own.
    */
    if (!D) statuses.push(["The dispute cases have not been read, so no dispute could be raised here.", "warn"]);
    if (!Q) statuses.push(["The recovery queue has not been read, so no failing invoice could be counted here.", "warn"]);
    if (!statuses.length)
      statuses.push([`Nothing needs a look · attempts, disputes, past-due subscriptions and the recovery queue are all quiet over ${c.days} days`, "ok"]);
    return { statuses };
  },

  "payments.floor": ({ leakage: L, stripe: S }: LiveInputs) => {
    const leak = firstCurrency(L?.currencies);
    if (!leak) return null;
    const cur = leak.currency;
    const t = leak.totals;
    const m = firstCurrency(S?.mrr);
    /*
      TWO TOTALS, TWO UNITS, TWO ROWS. The window figure is money that moved
      off the ledger; the per-month figure is a rate — contracted money not
      arriving for as long as it stays that way — and the document's
      `combined: null` exists so nobody adds them. The share of MRR is the
      only arithmetic performed here, and it divides a rate by a rate.
    */
    const months = m && m.amount > 0 && m.currency.toLowerCase() === cur.toLowerCase() ? t.perMonth / m.amount : null;
    /*
      THE BAR DIVIDES ONE TOTAL ONLY. The buckets that make up the window
      figure — refunds, disputes and their fees, all money that moved off the
      ledger — share a unit and a window and can be drawn as parts of it; the
      per-month buckets are rates and the count-only buckets have no money,
      and neither can be a segment of a sum of dollars. They are in the grid
      under the bar, each with its own window written on the row.
    */
    const parts: ProportionPart[] = leak.buckets
      .filter((b) => b.window === t.windowLabel && b.amount !== null)
      .map((b) => ({ label: b.label, value: b.amount!, text: `${inCurrency(b.amount!, cur)}${b.floor ? "+" : ""}` }));
    /*
      A DASH IS A COUNT WITH NO PRICE. A declined card and an abandoned
      checkout are recorded as attempts, never as amounts, so those buckets
      carry a count and no money — and are in neither total, which is why
      both totals are floors. A "+" after a bucket is the bucket's own word
      for being a lower bound, and "floor" on the row is the same word.
    */
    const rows: [string, string][] = leak.buckets.map((b) => [
      b.floor ? `${b.label} · floor` : b.label,
      also(
        also(
          b.amount === null ? DASH : `${inCurrency(b.amount, cur)}${b.floor ? "+" : ""}`,
          b.count === null ? "" : count(b.count),
        ),
        b.window,
      ),
    ]);
    return {
      tag: "floor",
      value: inCurrency(t.window, cur),
      sub: also(
        `at least · left in ${t.windowLabel} — ${t.windowIs}`,
        `and ${inCurrency(t.perMonth, cur)}/mo not arriving${months === null ? "" : ` (${pct(months)} of MRR)`} — ${t.perMonthIs}, kept apart`,
      ),
      partsLabel: `Left in ${t.windowLabel}, by bucket`,
      parts,
      rows,
      caption:
        "Two windows in one card: the money that moved is the last " + t.windowLabel +
        ", the rates are per month, and the abandoned checkouts are lifetime. A dash is a count " +
        "Stripe records no price for and is in neither total; a + is a lower bound.",
    };
  },

  "payments.failRate": ({ stripe: S, window: W }: LiveInputs) => {
    const c = firstCurrency(S?.charges);
    if (!c) return null;
    const rate = failRate(c.succeeded, c.failed);
    const wl = windowLabel(W ?? c.days);
    const name = `Why payments fail · ${wl}`;
    if (rate === null)
      return { name, tag: "metered", value: DASH, sub: "no payment attempts in this window, so there is no rate", parts: [] };
    const d = drift(c.series);
    /*
      THREE PARTS, NOT TWO, because the two words for a failure are not the
      same event: a block is Radar stopping card testing before a bank saw
      it, a decline is a bank saying no to a real customer. An attempt that
      failed with neither word is drawn as its own part rather than guessed
      into one of them. The bucket rows under the bar are the same split by
      week or fortnight, NEWEST FIRST — a time axis is not a ranking, so the
      bar lengths (failed attempts) are not sorted.
    */
    const neither = c.failed - c.blocked - c.declined;
    const parts: ProportionPart[] = [
      { label: "succeeded", value: c.succeeded, text: count(c.succeeded), tone: "ok" },
      { label: "blocked by Stripe's checks", value: c.blocked, text: count(c.blocked), tone: "warn" },
      { label: "declined by the bank", value: c.declined, text: count(c.declined), tone: "bad" },
    ];
    if (neither > 0) parts.push({ label: "failed, no outcome given", value: neither, text: count(neither) });
    const buckets = attemptBuckets(c.series, bucketDays(c.series.length));
    const shown = buckets.slice(0, 8);
    const ranked = shown.map((b) => {
      const r = failRate(b.succeeded, b.failed);
      /* The rate alone at the bar's tip, where the room is short; the
         counts on the label's line, where a short date leaves the width. */
      return {
        label: bucketLabel(b),
        value: b.failed,
        text: r === null ? DASH : pct(r / 100, { digits: 0 }),
        sub: `${count(b.failed)} of ${count(b.succeeded + b.failed)} failed · ${count(b.blocked)} blocked · ${count(b.declined)} declined`,
      };
    });
    /*
      THE TRAILING LINE IS ONLY DRAWN WHERE IT HAS ROOM. Thirty-seven days
      is a thirty-day window plus a week of movement; under 7d and 30d the
      series is shorter than that and the card says which window would show
      it rather than drawing a dot as a trend.
    */
    const trend = trailingFailRate(c.series);
    const first = trend?.[0];
    const last = trend?.[trend.length - 1];
    /*
      THE DRIFT IS A FIXED PAIR. Seven days against thirty, whatever the
      board's window, because the point of the comparison is that it does
      not move with the control; null when the series is shorter than thirty
      days. The fail rate itself counts BOTH of Stripe's words for a failure
      — blocked by its own checks, declined by the bank — which is why it is
      not the decline rate on the `stripe.declines` card beside it, whose
      denominator is only the attempts a bank saw.
    */
    return {
      name,
      tag: "metered",
      value: pct(rate / 100, { digits: 0 }),
      tone: rate >= 25 ? ("bad" as StatusTone) : undefined,
      sub: also(
        `of ${count(c.succeeded + c.failed)} attempts failed in the last ${wl}`,
        d
          ? `7d ${pct(d.short / 100, { digits: 0 })} against 30d ${pct(d.long / 100, { digits: 0 })} — ${d.verdict}, a fixed pair`
          : "",
      ),
      partsLabel: `Payment attempts over ${wl}`,
      parts,
      series: trend ? trend.map((p) => p.rate) : undefined,
      seriesAt: trend ? trend.map((p) => at(p.day)) : undefined,
      seriesLabel:
        trend && first && last
          ? `share of attempts failing, trailing 30 days, over ${count(trend.length)} days · ${pct(first.rate / 100, { digits: 0 })} → ${pct(last.rate / 100, { digits: 0 })}`
          : undefined,
      ranked,
      caption: also(
        also(
          `blocked and declined never share a denominator — a block is Radar stopping card testing before a bank saw it, a decline is a bank saying no`,
          buckets.length > shown.length ? `${count(buckets.length - shown.length)} older bucket${buckets.length - shown.length === 1 ? "" : "s"} not drawn` : "",
        ),
        trend
          ? ""
          : `the trailing-30-day line needs ${TRAILING_MIN_DAYS} days of attempts and this window holds ${count(c.series.length)} — pick 90d or all time to see it`,
      ),
    };
  },

  "payments.daily": ({ stripe: S, window: W }: LiveInputs) => {
    const c = firstCurrency(S?.charges);
    const r = firstCurrency(S?.revenue);
    if (!c?.series.length && !r?.series.length) return null;
    const days = c?.days ?? r?.days ?? 30;
    /*
      TWO LINES BECAUSE THEY ARE TWO CLOCKS. Gross is dated by the charge and
      net by the balance posting, after Stripe's fee, tax withheld, refunds
      and disputes; whatever crossed midnight sits in different days on the
      two, so a single "margin" line drawn between them would be arithmetic
      across two calendars. A yearly plan lands here as one spike and in the
      MRR card as a twelfth of itself — the chart and the figure answer
      different questions.
    */
    const chart = [
      c && {
        label: `Gross charges, ${c.currency.toUpperCase()}`,
        points: c.series.map((p) => ({ ts: at(p.day), value: p.gross })),
      },
      r && {
        label: `Net settled, ${r.currency.toUpperCase()}`,
        points: r.series.map((p) => ({ ts: at(p.day), value: p.net })),
      },
    ].filter((s): s is { label: string; points: { ts: string; value: number }[] } => !!s);
    return {
      name: `Daily revenue · ${windowLabel(W ?? days)}`,
      tag: "metered",
      chart,
      unit: "usd" as const,
      caption:
        `${days} days · gross is dated by the charge and includes one-off payments; ` +
        `net is the ledger, dated by the posting, after fees, tax withheld, refunds and disputes`,
    };
  },

  "payments.movement": ({ stripe: S, window: W }: LiveInputs) => {
    const c = churnRow(S, churnDays(W));
    const p = S?.subscriptions.pendingCancellation;
    if (!c || !p) return null;
    const m = (n: number) => inCurrency(n, c.currency);
    /*
      THE WATERFALL IS THE SUBTRACTION. New hangs from the baseline, churned
      hangs from the top of new, and net is drawn from the baseline again:
      "+$358 new, −$5 churned, +$354 net" as one picture rather than three
      rows a reader has to add. The rows under it are what the picture does
      not carry — what never started, who has asked to leave, the rate.
    */
    const steps: WaterfallStep[] = [
      { label: "New", sub: `${count(c.newSubs)} sub${c.newSubs === 1 ? "" : "s"}`, value: c.newMrr, text: m(c.newMrr) },
      { label: "Churned", sub: `${count(c.churnedSubs)} sub${c.churnedSubs === 1 ? "" : "s"}`, value: -c.churnedMrr, text: m(c.churnedMrr) },
      { label: "Net", sub: `over ${c.days} days`, value: c.netMrr, text: m(Math.abs(c.netMrr)), total: true },
    ];
    const rows: [string, string][] = [];
    if (c.involuntary) rows.push(["Churned because a card failed or was disputed", count(c.involuntary)]);
    const lost = c.byProduct.slice(0, 2);
    if (lost.length)
      rows.push([
        "Lost from",
        lost.map((x) => `${x.product} (${m(x.mrr)})`).join(", ") +
          (c.byProduct.length > lost.length ? ` and ${c.byProduct.length - lost.length} more` : ""),
      ]);
    /*
      WHAT NEVER STARTED IS NOT CHURN AND IS IN NO FIGURE ABOVE. A trial that
      ended without a payment and a checkout that expired before one are the
      two rows here that say "would have billed"; the money never existed, so
      it is never a loss, and each is its own funnel problem.
    */
    const t = c.notChurn.trialNonConversion;
    const f = c.notChurn.failedActivation;
    if (t.subscriptions) rows.push([`Trials cancelled · ${count(t.subscriptions)}`, `${m(t.wouldHaveBeen)}/mo never started`]);
    if (f.subscriptions) rows.push([`Failed checkouts · ${count(f.subscriptions)}`, `${m(f.wouldHaveBeen)}/mo never started`]);
    /*
      ASKED TO CANCEL IS STILL BILLING AND STILL IN MRR. An annual plan that
      switched off auto-renew stays paid for months; only the ones ending
      inside sixty days are the ones somebody could still write to.
    */
    const pending = firstCurrency(p.mrr);
    const soon = firstCurrency(p.endingSoon.mrr);
    rows.push(["Asked to cancel, still billing", count(p.count)]);
    if (p.count) {
      rows.push([
        `ending within ${p.endingSoon.days} days · ${count(p.endingSoon.count)}`,
        soon ? `${m(soon.amount)}/mo` : DASH,
      ]);
      rows.push(["Leaving with them, eventually", pending ? `${m(pending.amount)}/mo` : DASH]);
    }
    rows.push([
      `Revenue churn · ${c.days}d`,
      also(
        c.ratePct === null ? DASH : pct(c.ratePct / 100),
        c.subRatePct === null ? "" : `${pct(c.subRatePct / 100)} of subscriptions`,
      ),
    ]);
    return { name: `MRR movement · ${c.days}d`, tag: "approx", steps, rows };
  },

  "payments.leaving": ({ queue: Q }: LiveInputs) => {
    if (!Q) return null;
    const churn = Q.items.filter((c) => c.kind === "churn");
    if (!churn.length)
      return { tag: "now", rows: [["Nobody is cancelling", "no churn case in the recovery queue"]] as [string, string][] };
    const { soon, later, undated } = splitLeaving(churn);
    const cur = churn[0]?.currency ?? "USD";
    const total = sumMonthly(churn);
    const laterTotal = sumMonthly(later);
    /*
      SOONEST FIRST, AND ONLY THE ONES A LETTER COULD STILL REACH. Everyone
      here is still paying and still in MRR until the date beside their name;
      a renewal declined months out is counted and not listed, because there
      is no deadline to beat. The card sends nothing — preparing a follow-up
      happens in the recovery queue, which writes into the Outbox.
    */
    const shown = soon.slice(0, 6);
    const rows: [string, string][] = shown.map((c) => [
      leavingWho(c),
      also(also(c.amount === null ? DASH : `${inCurrency(c.amount, c.currency ?? cur)}/mo`, leavingInterval(c)), `ends ${inDays(c.daysLeft)}`),
    ]);
    if (soon.length > shown.length) rows.push([`${count(soon.length - shown.length)} more ending within 60 days`, "in the recovery queue"]);
    if (!soon.length) rows.push(["Nothing ends in the next two months", "every cancellation here is a renewal declined well ahead"]);
    if (later.length)
      rows.push([
        `Declined renewal, months out · ${count(later.length)}`,
        `${inCurrency(laterTotal.total, cur)}/mo${laterTotal.unpriced ? " at least" : ""} · still paid up`,
      ]);
    if (undated.length) rows.push([`Already ended, still in the queue · ${count(undated.length)}`, "until somebody resolves them"]);
    rows.push([
      `Leaving with them · ${count(churn.length)} sub${churn.length === 1 ? "" : "s"}`,
      `${inCurrency(total.total, cur)}/mo${total.unpriced ? ` at least · ${count(total.unpriced)} unpriced` : ""}`,
    ]);
    return { tag: "now", rows };
  },

  "payments.plans": ({ stripe: S }: LiveInputs) => {
    const m = firstCurrency(S?.mrr);
    if (!m) return null;
    const { top, more } = planSplit(S?.plans ?? [], 8);
    /*
      A SHARE OF A RUN RATE IS NOT A WINDOW. Each bar is what one plan bills
      as the book stands, and the share is of the whole MRR rather than of
      the bars drawn — so the eight bars need not add to 100%, and the
      caption says how many plans were left off. Subscriptions only: a
      one-off payment has no plan and is on the gross card, not here.
    */
    return {
      tag: "now",
      ranked: top.map((p) => ({
        label: p.name,
        value: p.mrr,
        text: `${inCurrency(p.mrr, p.currency)}/mo`,
        sub: `${count(p.subscribers)} sub${p.subscribers === 1 ? "" : "s"}`,
      })),
      caption: also(
        `shares of the whole MRR, ${inCurrency(m.amount, m.currency)}/mo`,
        more ? `${count(more)} more plan${more === 1 ? "" : "s"} not drawn` : "subscriptions only",
      ),
    };
  },

  "payments.attempts": ({ stripe: S, window: W }: LiveInputs) => {
    const c = firstCurrency(S?.charges);
    if (!c) return null;
    const attempts = c.succeeded + c.failed;
    const wl = windowLabel(W ?? c.days);
    /*
      THE SAME BAR AS THE GROSS TILE, ON PURPOSE. Workdash draws it twice —
      under the money at the top and beside the counts down here — because
      the two cards are read at different moments: one when asking how much
      came in, the other when asking how many tried. The blocked-against-
      declined split is on "Why payments fail", not here; this card is the
      count and the refunds.
    */
    return {
      name: `Payment attempts · ${wl}`,
      tag: "metered",
      value: count(attempts),
      sub: attempts
        ? also(
            `${count(c.succeeded)} succeeded · ${count(c.failed)} failed`,
            c.refunds ? `${count(c.refunds)} refund${c.refunds === 1 ? "" : "s"}, ${inCurrency(c.refunded, c.currency)} refunded` : "no refunds",
          )
        : "no payment attempts in this window",
      partsLabel: `Payment attempts over ${wl}`,
      parts: attemptParts(c.succeeded, c.failed),
    };
  },

  "payments.recent": ({ stripe: S, window: W }: LiveInputs) => {
    /*
      A ROUTE OLDER THAN THIS FIELD HAS NO LIST, and the card must then say
      "nothing collected" rather than draw an empty month: null here is the
      difference between "no charges" and "this server does not keep them".
    */
    const list = S?.recent;
    if (!S || !list) return null;
    const days = W ?? S.window.days;
    const wl = windowLabel(days);
    const name = `Payments · ${wl}`;
    const inWindow = chargesInWindow(list, days, Date.now());
    if (!inWindow.length)
      return { name, tag: "metered", headers: ["When", "Amount", "Who", "Status"], table: [], caption: `No charges in the last ${wl}.` };
    /*
      NEWEST FIRST, FORTY AT MOST, AND THE ADDRESS AS IT ARRIVED — masked in
      the collector, never here, so there is no fuller form on this page to
      leak. The status column carries Stripe's own sentence for a decline
      where it gave one; the dot before the row is the same word as a colour,
      and a refund is the muted dot because it is neither a success nor a
      failure of the attempt.
    */
    const shown = inWindow.slice(0, 40);
    const table = shown.map((c) => [
      `${dayShort(c.createdAt.slice(0, 10))} ${clock(c.createdAt)}`,
      inCurrency(c.amount, c.currency),
      c.email ?? c.description ?? DASH,
      c.refunded ? "refunded" : (c.failure ? shortReason(c.failure) : c.status),
    ]);
    const rowTones = shown.map((c): StatusTone | null =>
      c.refunded ? null : c.paid && c.status === "succeeded" ? "ok" : c.status === "failed" ? "bad" : null,
    );
    const held = S.recentHeld;
    const short = held && (days === "all" || days > held.days);
    return {
      name,
      tag: "metered",
      headers: ["When", "Amount", "Who", "Status"],
      table,
      rowTones,
      caption: also(
        `showing ${count(shown.length)} of ${count(inWindow.length)}${S.recentTruncated ? "+" : ""} charge${inWindow.length === 1 ? "" : "s"} in the last ${wl} · emails masked`,
        short
          ? `the collector keeps ${held.days} days of individual charges${held.from ? `, from ${dayShort(held.from)}` : ""}, so this list is that span and not the ${wl} asked for — the aggregates above are counted over every charge in their window`
          : "",
      ),
    };
  },

  "payments.disputes": ({ disputes: D, window: W }: LiveInputs) => {
    if (!D) return null;
    const c = firstCurrency(D.currencies);
    const cur = c?.currency ?? "USD";
    const days = D.window.days;
    const openNow = c?.cases.openNow ?? D.open.length;
    const rows: [string, string][] = [];
    /*
      CASES AND THE LEDGER ARE TWO POPULATIONS AND ARE NEVER ADDED. A case is
      dated by when the bank opened it and excludes Stripe's fee; the ledger
      is dated by when money moved and includes it. Both are drawn, each
      under its own label, and the last row says why they disagree.
    */
    if (openNow > 0) {
      rows.push(["Open now", `${count(openNow)} · ${inCurrency(c?.cases.openNowAmount ?? 0, cur)} at stake`]);
      if (c?.cases.nextEvidenceDueBy) rows.push(["Next evidence due", dayShort(c.cases.nextEvidenceDueBy.slice(0, 10))]);
    } else rows.push(["Needing a response now", "none"]);
    rows.push([`Opened · ${windowLabel(W ?? days)}`, `${count(c?.cases.opened ?? 0)} · ${inCurrency(c?.cases.openedAmount ?? 0, cur)}`]);
    if (c)
      rows.push([
        `Left the ledger · ${windowLabel(W ?? days)}`,
        `${inCurrency(c.ledger.moneyOut, cur)} · ${inCurrency(c.ledger.disputes, cur)} disputed + ${inCurrency(c.ledger.disputeFees, cur)} in fees`,
      ]);
    const o = D.counts.byOutcome;
    rows.push(["All time", `${count(o.lost)} lost · ${count(o.won)} won · ${count(o.undecided)} undecided`]);
    rows.push(["Cases and the ledger", "two populations, dated apart, never added"]);
    return { name: `Disputes · ${windowLabel(W ?? days)}`, tag: "metered", rows };
  },

  "payments.attemptDays": ({ stripe: S, window: W }: LiveInputs) => {
    const c = firstCurrency(S?.charges);
    if (!c?.series.length) return null;
    const shown = c.series.slice(-14).reverse();
    return {
      name: `Attempts by day · last ${count(shown.length)} of ${windowLabel(W ?? c.days)}`,
      tag: "metered",
      headers: ["Day", "Succeeded", "Blocked", "Declined", "Gross"],
      table: shown.map((d) => [dayShort(d.day), count(d.succeeded), count(d.blocked), count(d.declined), inCurrency(d.gross, c.currency)]),
    };
  },

  "payments.ledgerDays": ({ stripe: S, window: W }: LiveInputs) => {
    const r = firstCurrency(S?.revenue);
    if (!r?.series.length) return null;
    const shown = r.series.slice(-14).reverse();
    return {
      name: `Settled by day · last ${count(shown.length)} of ${windowLabel(W ?? r.days)}`,
      tag: "metered",
      headers: ["Day", "Gross", "Fees", "Net"],
      table: shown.map((d) => [dayShort(d.day), inCurrency(d.gross, r.currency), inCurrency(d.fees, r.currency), inCurrency(d.net, r.currency)]),
    };
  },

  "payments.cannot": ({ stripe: S, leakage: L }: LiveInputs) => {
    if (!S?.connected) return null;
    const leak = firstCurrency(L?.currencies);
    /*
      WHAT THE BOARD WILL NOT SAY, beside `stripe.limits` rather than instead
      of it: that card carries Stripe's own refusals, this one carries what
      the COLLECTOR does not keep and what this board refuses to add. Each
      line is a question a reader will ask of the cards above, answered
      before they go looking for a figure that is not there.
    */
    const rows: [string, string][] = [
      ["Charges older than 90 days", "the collector keeps ninety days of them"],
      ["Decline codes as a breakdown", "each listed charge carries its reason; nothing counts them"],
      [
        "How far back the days go",
        also(S.history.from ? `to ${dayShort(S.history.from)}` : "the first collection", S.history.complete ? "complete" : "still being filled in"),
      ],
    ];
    if (leak?.noAmount.length) rows.push(["Leakage buckets with a count and no amount", leak.noAmount.join(", ")]);
    rows.push(["One figure across stores", "Google's and Apple's money never joins Stripe's"]);
    return { rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);


/* ============================================= seo board parity (workdash) ==
   THE CARDS THE SEO BOARD LACKED AGAINST WORKDASH'S /seo AND /search PAGES.

   Every builder below reads a window off the route and writes it on the
   card's name, so "Clicks · 28d" follows the collector rather than the
   catalog. The per-property cards read `GscProperty.series`, `.topQueries`,
   `.topPages`, `.striking` and `.zeroClick` — cuts the route makes per
   property so that eighteen quiet properties are drawn as themselves rather
   than folded under one busy one. A route older than those fields makes
   these builders return null, which draws "nothing collected" rather than a
   wrong number.
*/

/** A page as a person reads it in a column of many hosts: host and path. The
 *  `pathOf` above drops the host because its cards sit under one property;
 *  these sit under the whole portfolio. */
function pageLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "/" : u.pathname}`;
  } catch {
    return url;
  }
}

/** A URL's tail for a narrow row — the last segment, or the host for a root. */
function tailOf(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).at(-1);
    return seg ? `/${seg}` : `${u.hostname}/`;
  } catch {
    return url;
  }
}

/** "to 5 Sep" — the window's end, which on Search Console is three days
 *  back and is the difference between a lag and a decline. */
const gscEnds = (G: GscReport) => (G.window.end ? `${G.window.days}d to ${dayShort(G.window.end)}` : `${G.window.days}d`);

/** The busiest `n` properties by `by`, of those with a line to draw. */
function busiest(G: GscReport, by: "clicks" | "impressions", n = 4) {
  const withLine = G.properties.filter((p) => (p.series?.length ?? 0) > 1);
  return {
    drawn: [...withLine].sort((a, b) => b[by] - a[by]).slice(0, n),
    of: withLine.length,
  };
}

Object.assign(LIVE_BUILDERS, {
  /* -------------------------------------------------- search totals */

  "gsc.ctr": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || G.totals.ctr === null) return null;
    const prev = G.previous.ctr;
    /* POINTS, NOT PERCENT OF A PERCENT. A CTR that went from 3.3% to 3.8%
       moved half a point; "+15%" over it is a figure in no unit. */
    const moved =
      prev === null
        ? "no comparable window before it"
        : `${G.totals.ctr - prev >= 0 ? "+" : ""}${(G.totals.ctr - prev).toFixed(2)} pts on the previous ${G.window.days}d`;
    return {
      /* NO TAG ON THIS TILE OR THE ONE BELOW: its siblings carry none, and a
         one-column tile has room for a name or a tag, not both. What kind of
         number it is — measured, weighted — is in the sentence under it. */
      name: `CTR · Google · ${G.window.days}d`,
      value: percent(G.totals.ctr, 2),
      sub: also(
        also(`${count(G.totals.clicks)} clicks of ${count(G.totals.impressions)} impressions, weighted across properties`, moved),
        gscEnds(G),
      ),
    };
  },

  "gsc.properties": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.properties.length) return null;
    const quiet = G.properties.filter((p) => p.impressions === 0 && !p.error).length;
    const failed = G.properties.filter((p) => p.error).length;
    return {
      value: count(G.properties.length),
      sub: also(
        also(`${G.totals.properties} with traffic in the ${gscEnds(G)}`, quiet ? `${quiet} quiet` : ""),
        failed ? `${failed} could not be read` : "",
      ),
    };
  },

  "gsc.quiet": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.properties.length) return null;
    const quiet = G.properties.filter((p) => p.impressions === 0);
    const rows: [string, string][] = quiet
      .slice(0, 8)
      .map((p) => [p.label, p.error ? "could not be read" : `no impressions, ${gscEnds(G)}`]);
    if (quiet.length > 8) rows.push([`+${quiet.length - 8} more`, "also quiet"]);
    if (!quiet.length) rows.push(["Every property had impressions", gscEnds(G)]);
    /* THE LAST ROW IS THE READING. A verified property Google has shown to
       nobody yet is not a broken one, and a card that listed it in red would
       send somebody to fix a thing that only needs time. */
    rows.push(["Data accumulates over time", "quiet is not broken"]);
    return { name: `No search data yet · ${G.window.days}d`, rows };
  },

  /* ----------------------------------------------------- daily lines */

  "gsc.clicksTrend": ({ gsc: G, window: W }: LiveInputs) => {
    if (!G || G.series.length < 2) return null;
    return {
      name: `Clicks a day · ${portfolioWord(G)} · ${windowLabel(W ?? G.seriesDays)}`,
      chart: [{ label: "clicks", points: G.series.map((d) => ({ ts: at(d.day), value: d.clicks })) }],
      unit: "count" as const,
      caption: portfolioLine(G),
    };
  },

  "gsc.propertyClicks": ({ gsc: G }: LiveInputs) => {
    if (!G) return null;
    const { drawn, of } = busiest(G, "clicks");
    if (!drawn.length) return null;
    return {
      name: `Clicks a day, by property · ${G.seriesDays}d`,
      chart: drawn.map((p) => ({
        label: p.label,
        points: (p.series ?? []).map((d) => ({ ts: at(d.day), value: d.clicks })),
      })),
      unit: "count" as const,
      /* WHAT IS NOT DRAWN IS SAID. Four lines is what the eye can follow;
         the other properties are on the table beside this, not folded into
         a fifth line called "other". */
      caption: also(
        `${drawn.length} of ${of} properties drawn, busiest by clicks in the ${gscEnds(G)} · the rest are on the property table, not summed`,
        G.window.end ? `ends ${dayShort(G.window.end)}` : "",
      ),
    };
  },

  "gsc.propertyImpressions": ({ gsc: G }: LiveInputs) => {
    if (!G) return null;
    const { drawn, of } = busiest(G, "impressions");
    if (!drawn.length) return null;
    return {
      name: `Impressions a day, by property · ${G.seriesDays}d`,
      chart: drawn.map((p) => ({
        label: p.label,
        points: (p.series ?? []).map((d) => ({ ts: at(d.day), value: d.impressions })),
      })),
      unit: "count" as const,
      caption: also(
        `${drawn.length} of ${of} properties drawn, busiest by impressions in the ${gscEnds(G)} · the rest are on the property table, not summed`,
        G.window.end ? `ends ${dayShort(G.window.end)}` : "",
      ),
    };
  },

  /* ---------------------------------------------- clicks v impressions */

  "gsc.dumbbell": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected) return null;
    const rows = G.properties
      .filter((p) => p.impressions > 0)
      .sort((a, b) => b.impressions - a.impressions)
      .map((p) => ({
        label: p.label,
        a: p.clicks,
        b: p.impressions,
        text: p.ctr === null ? "—" : `${percent(p.ctr, 2)} CTR`,
        sub: p.position === null ? undefined : `#${place(p.position)}`,
      }));
    if (!rows.length) return null;
    return {
      name: `Clicks against impressions · ${G.window.days}d`,
      tag: "measured",
      dumbbell: rows,
      names: ["Clicks", "Impressions"] as [string, string],
      log: true,
      caption: `${rows.length} properties with impressions, most first · ${gscEnds(G)} · the axis is in decades, so a step is tenfold, and a property with no clicks is parked at the floor`,
    };
  },

  /* ------------------------------------------------- the ranked lists */

  "gsc.queriesRanked": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.queries.length) return null;
    return {
      name: `Top queries · ${G.window.days}d · Google`,
      ranked: G.queries.slice(0, 8).map((q) => ({
        label: q.query,
        value: q.clicks,
        text: `${count(q.clicks)} clicks`,
        sub: `${q.property} · ${count(q.impressions)} impr · #${place(q.position)}`,
      })),
      /* THE CAPTION IS THE POINT OF THE CARD, as it is on `gsc.queries`:
         these rows sit inside a fifth of the impressions the properties had. */
      caption:
        G.coverage.pct === null
          ? "Google's clicks-ordered rows — a sample of the impressions, never all of them"
          : `these rows cover ${percent(G.coverage.pct)} of impressions — Google withholds rare queries and caps the rows`,
    };
  },

  "gsc.pagesRanked": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.pages.length) return null;
    return {
      name: `Top pages · ${G.window.days}d · Google`,
      ranked: G.pages.slice(0, 8).map((p) => ({
        label: pageLabel(p.page),
        value: p.clicks,
        text: `${count(p.clicks)} clicks`,
        sub: `${count(p.impressions)} impr · #${place(p.position)}`,
      })),
      caption: "landing pages from search, by clicks · Google's own capped page rows",
    };
  },

  "gsc.strikingRanked": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.striking.length) return null;
    return {
      ranked: G.striking.slice(0, 8).map((q) => ({
        label: q.query,
        /* THE BAR IS IMPRESSIONS, not the rank: what is at stake is how often
           the page is one push from a click, and a rank is not a length. */
        value: q.impressions,
        text: `${count(q.impressions)} impr`,
        sub: `${q.property} · #${place(q.position)} · ${count(q.clicks)} click${q.clicks === 1 ? "" : "s"}`,
      })),
      caption:
        "position 5–20 with 3+ impressions, most impressions first · drawn from Google's clicks-ordered rows, so a high-impression query with no clicks can be missing",
    };
  },

  /* ------------------------------------------- every property, once */

  "gsc.propertyQueries": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.properties.length) return null;
    if (!G.properties.some((p) => p.topQueries)) return null;
    const seen = G.properties.filter((p) => p.impressions > 0);
    const shown = seen.slice(0, 12);
    const table = shown.map((p) => {
      const q = p.topQueries?.[0];
      /* A PROPERTY WITH IMPRESSIONS AND NO QUERY ROW IS NOT A PROPERTY WITH
         NO QUERIES. Google anonymised every one of them, which is the
         reading the coverage column exists to make possible. */
      if (!q)
        return [p.label, "no query rows — every query withheld", "—", "—", "—",
          p.queryCoverage.pct === null ? "—" : percent(p.queryCoverage.pct)];
      return [
        p.label,
        q.query,
        count(q.clicks),
        count(q.impressions),
        place(q.position),
        p.queryCoverage.pct === null ? "—" : percent(p.queryCoverage.pct),
      ];
    });
    if (seen.length > shown.length)
      table.push([`+${seen.length - shown.length} smaller properties`, "—", "—", "—", "—", "—"]);
    return {
      name: `Top query, every property · ${G.window.days}d`,
      headers: ["Property", "Top query", "Clicks", "Impressions", "Position", "Rows cover"],
      table,
    };
  },

  "gsc.propertyStriking": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.properties.length) return null;
    if (!G.properties.some((p) => p.striking)) return null;
    const rows = G.properties
      .filter((p) => p.striking?.length)
      .sort((a, b) => (b.striking?.[0]?.impressions ?? 0) - (a.striking?.[0]?.impressions ?? 0));
    const table = rows.slice(0, 12).map((p) => {
      const q = p.striking![0]!;
      return [p.label, q.query, place(q.position), count(q.impressions), count(q.clicks)];
    });
    const without = G.properties.filter((p) => p.impressions > 0 && !p.striking?.length).length;
    if (without) table.push([`${without} propert${without === 1 ? "y" : "ies"} with traffic`, "nothing at 5–20 with 3+ impressions", "—", "—", "—"]);
    if (!table.length) return { table: [["no property", "nothing sits at position 5–20 with 3+ impressions", "—", "—", "—"]] };
    return {
      headers: ["Property", "Query", "Position", "Impressions", "Clicks"],
      table,
    };
  },

  "gsc.sitemapsByProperty": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.properties.length) return null;
    /* Worst first: the property with errors is the row to act on, and the
       one that submitted nothing is the row after it. */
    const order = (p: GscProperty) =>
      p.sitemaps.state === "reported" ? -((p.sitemaps.errors ?? 0) * 1000 + (p.sitemaps.warnings ?? 0)) : p.sitemaps.state === "none" ? 1 : 2;
    const table = [...G.properties]
      .sort((a, b) => order(a) - order(b) || b.impressions - a.impressions)
      .map((p) => {
        const s = p.sitemaps;
        if (s.state === "reported")
          return [
            p.label,
            count(s.count),
            count(s.submitted),
            count(s.errors),
            count(s.warnings),
            s.lastDownloaded ? dayShort(s.lastDownloaded.slice(0, 10)) : "never read by Google",
          ];
        /* THREE STATES AND NOT TWO — the rule `gsc.sitemaps` keeps. */
        if (s.state === "none") return [p.label, "none submitted", "—", "—", "—", "—"];
        return [p.label, "could not be read", "—", "—", "—", "—"];
      });
    return {
      headers: ["Property", "Sitemaps", "URLs submitted", "Errors", "Warnings", "Last read"],
      table,
    };
  },

  "gsc.zeroClick": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.properties.length) return null;
    if (!G.properties.some((p) => p.zeroClick)) return null;
    const pages = G.properties
      .flatMap((p) => (p.zeroClick?.pages ?? []).map((z) => ({ ...z, property: p.label })))
      .sort((a, b) => b.impressions - a.impressions);
    const total = G.properties.reduce((n, p) => n + (p.zeroClick?.count ?? 0), 0);
    const rows: [string, string][] = pages
      .slice(0, 6)
      .map((z) => [pageLabel(z.page), `${count(z.impressions)} impr · never clicked`]);
    if (!pages.length) rows.push(["No page shown and never clicked", "within the rows Google returned"]);
    else if (total > rows.length) rows.push([`${count(total)} such pages in all`, `${rows.length} drawn`]);
    /* A FLOOR, AND TAGGED AS ONE: only the pages Google's capped page rows
       returned could be counted, and a page past the cap is unmeasured. */
    rows.push(["Within Google's top pages per property", "a floor, not a total"]);
    return { name: `Zero-click pages · ${G.window.days}d`, tag: "floor", rows };
  },

  "gsc.cannot": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected) return null;
    /* THE ROUTE'S OWN LIST, in the short form a row can hold. Each is a
       property of Search Console rather than a gap in the collector; the last
       row says how many the route lists so a reader can go and read them. */
    const rows: [string, string][] = [
      ["The last three days", `not finalised — every window ends ${G.window.lagDays}d back`],
      ["A true top-queries list", "rare queries withheld, rows capped"],
      ["Pages indexed", "no API for the Index Coverage report"],
      ["Why a position moved", "the rank is reported, never the reason"],
      ["Country and device splits", "not collected here — the Search board's cut is by property"],
    ];
    rows.push(["Said by the route", `${G.cannot.length} refusals, on /api/gsc`]);
    return { rows };
  },

  /* ------------------------------------------------------------ audit */

  "audit.ranked": ({ audit: A }: LiveInputs) => {
    const rows = audited(A);
    if (!rows.length) return null;
    const worst = [...rows].sort(
      (a, b) => b.issues.error - a.issues.error || b.issues.warning - a.issues.warning,
    );
    const never = (A?.ventures.length ?? 0) - rows.length;
    return {
      ranked: worst.slice(0, 10).map((v) => ({
        label: v.name,
        value: v.issues.error,
        text: v.issues.error ? `${count(v.issues.error)} error${v.issues.error === 1 ? "" : "s"}` : "clean",
        /* Warnings ride beside the name and are NEVER in the bar: forty
           notices must not outweigh a dead homepage. */
        sub: `${count(v.pages)} page${v.pages === 1 ? "" : "s"} · ${count(v.issues.warning)} warn`,
      })),
      caption: also(
        "errors, worst first — there is no score by design",
        never ? `${never} venture${never === 1 ? "" : "s"} never crawled, not drawn` : "",
      ),
    };
  },

  "audit.crawled": ({ audit: A }: LiveInputs) => {
    const rows = audited(A);
    if (!A) return null;
    const never = A.ventures.length - rows.length;
    const pages = rows.reduce((n, v) => n + (v.pages ?? 0), 0);
    return {
      tag: "measured",
      value: count(rows.length),
      sub: also(
        `of ${A.ventures.length} ventures · ${count(pages)} pages reached in all`,
        never ? `${never} never crawled — unmeasured, not clean` : "",
      ),
    };
  },

  /* ------------------------------------------------------------- bing */

  "bing.propertyIndex": ({ bing: B }: LiveInputs) => {
    if (!B) return null;
    const withLine = B.sites.filter((s) => (s.index.series?.length ?? 0) > 1);
    const drawn = [...withLine].sort((a, b) => (b.index.inIndex ?? 0) - (a.index.inIndex ?? 0)).slice(0, 4);
    if (!drawn.length) return null;
    return {
      name: `Pages in Bing's index, by site · ${B.seriesDays}d`,
      chart: drawn.map((s) => ({
        label: s.label,
        points: (s.index.series ?? [])
          .filter((d) => d.inIndex !== null)
          .map((d) => ({ ts: at(d.day), value: d.inIndex! })),
      })),
      unit: "count" as const,
      caption: `pages Bing is holding, a level per day and never summed over days · ${drawn.length} of ${withLine.length} sites drawn`,
    };
  },

  /* --------------------------------------- this box's own four documents */

  "authority.ceiling": ({ seo }: LiveInputs) => {
    const A = seo?.authority;
    if (!A?.hosts.length) return null;
    return {
      /* AN ESTIMATE, AND TAGGED AS ONE. Not a Domain Rating and not anybody's
         score — the route's own label, kept. */
      tag: "est.",
      headers: ["Host", "Estimate", "Aim under difficulty", "Basis", "Ref. domains"],
      /* The route's order — by host — and NEVER sorted by estimate: two rows
         whose basis differs are two measurements, and an order would invent
         a comparison between them. */
      table: A.hosts.map((h) => [
        h.host,
        h.estimate === null ? "—" : String(Math.round(h.estimate)),
        h.ceiling !== null ? String(h.ceiling) : h.estimate === null ? "—" : "no ceiling — not the constraint at this size",
        h.basis.length ? h.basis.join(" + ") : "nothing could be read",
        h.links.referringDomains === null ? "—" : count(h.links.referringDomains),
      ]),
    };
  },

  "geo.mentioned": ({ seo }: LiveInputs) => {
    const D = seo?.geo;
    if (!D) return null;
    if (!D.answers.length)
      return {
        ranked: [{ label: "Nothing asked yet", value: 0, text: "—", sub: "run a GEO check from a venture's page" }],
        caption: "does a model name these products when asked what to use?",
      };
    const by = new Map<string, { name: string; asked: number; mentioned: number; judged: number; recommended: number }>();
    for (const a of D.answers) {
      const e = by.get(a.ventureId) ?? { name: a.ventureName ?? a.ventureId, asked: 0, mentioned: 0, judged: 0, recommended: 0 };
      e.asked += 1;
      if (a.mentioned) e.mentioned += 1;
      if (a.recommended !== null) e.judged += 1;
      if (a.recommended === true) e.recommended += 1;
      by.set(a.ventureId, e);
    }
    const providers = Object.keys(D.byProvider);
    return {
      tag: "measured",
      ranked: [...by.values()]
        /* AGAINST ITS OWN DENOMINATOR: the bar is the share of this venture's
           own questions, so three of three and thirty of thirty draw alike. */
        .sort((a, b) => b.mentioned / b.asked - a.mentioned / a.asked)
        .slice(0, 8)
        .map((e) => ({
          label: e.name,
          value: Math.round((e.mentioned / e.asked) * 100),
          text: `${e.mentioned} of ${e.asked} mentioned`,
          sub: e.judged ? `${e.recommended} recommended of ${e.judged} judged` : "not judged",
        })),
      caption: also(
        `${providers.join(", ")} · no tools, no web · mentioned means the name or host appeared in the answer`,
        "recommended was judged by a second completion and is null where it did not answer",
      ),
    };
  },

  "seoops.moved": ({ seo }: LiveInputs) => {
    const F = seo?.followups;
    if (!F) return null;
    if (!F.baselines.length)
      return {
        rows: [
          ["Nothing tracked yet", `finish a board card tagged ${F.schedule.tag} naming a URL`],
          ["Then", `readings ${F.schedule.offsetsDays.join(", ")} days after, over ${F.schedule.windowDays}d windows`],
        ] as [string, string][],
      };
    const VERDICT: Record<string, string> = {
      up: "up",
      down: "down",
      flat: "flat",
      thin: "too thin to judge",
      unmeasured: "not measurable",
    };
    const rows: [string, string][] = F.baselines.slice(0, 8).map((b) => {
      const last = b.diagnoses.at(-1);
      const who = b.ventureName ? ` · ${b.ventureName}` : "";
      if (!last) {
        const next = b.due.find((d) => !d.overdue) ?? b.due[0];
        return [`${tailOf(b.url)}${who}`, next ? `${next.dayOffset}d reading due ${dayShort(next.dueAt.slice(0, 10))}` : "no reading due"];
      }
      const d = last.delta;
      const moved =
        d && d.clicks !== null && d.impressions !== null
          ? `${d.clicks >= 0 ? "+" : ""}${count(d.clicks)} clicks · ${d.impressions >= 0 ? "+" : ""}${count(d.impressions)} impr`
          : "";
      return [`${tailOf(b.url)}${who}`, also(`${VERDICT[last.verdict] ?? last.verdict} at ${last.dayOffset}d`, moved)];
    });
    if (F.baselines.length > rows.length) rows.push([`+${F.baselines.length - rows.length} more`, "tracked"]);
    rows.push(["Verdicts are arithmetic", "correlation, not cause"]);
    return { tag: "measured", rows };
  },

  "indexing.told": ({ seo }: LiveInputs) => {
    const I = seo?.indexing;
    if (!I) return null;
    const told = [...I.hosts].filter((h) => h.submissions > 0).sort((a, b) => b.submissions - a.submissions);
    const rows: [string, string][] = told.slice(0, 6).map((h) => [
      h.host,
      also(
        also(`${count(h.received)} received`, h.refused ? `${count(h.refused)} refused` : ""),
        /* A DRY RUN IS THIS BOX'S OWN NO — the key file was not hosted — and
           is kept apart from a refusal, which is IndexNow's. */
        h.dryRun ? `${count(h.dryRun)} held: key file missing` : h.last ? `last ${dayShort(h.last.at.slice(0, 10))}` : "",
      ),
    ]);
    if (!told.length) rows.push(["No host has submitted anything", "submit from a venture's Growth page"]);
    rows.push([`${count(I.never)} of ${count(I.hosts.length)} hosts never submitted`, I.autoSubmit ? "auto-submit on" : "auto-submit off"]);
    /* THE PROTOCOL'S OWN LIMIT, ON THE CARD: a receipt is not a crawl, and
       Google is told nothing by any of this. */
    rows.push(["Google", "not told — it never joined IndexNow"]);
    return { rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);


/* ============================================ search board + per project ==
   WORKDASH'S ALL-PROPERTIES SEARCH PAGE AND ITS PER-PROPERTY PAGE, as cards.

   The rail is the one portfolio card here; everything else takes a venture
   on the card. THE PER-PROJECT BUILDERS FILTER NOTHING: the documents they
   read were narrowed to the venture's hosts by the card before the call —
   see the `project` note on `LiveInputs` — so `G.properties` below is the
   venture's property or properties and `G.totals` is their sum, computed by
   the same code a venture board runs (lib/scope `scopeGsc`). Each declines
   with null when `project` is absent, which is every portfolio pass, so a
   per-project card never wears the live dot over a portfolio figure.

   THE CARD NAMES THE VENTURE. A builder's `name` carries the window and
   nothing else; "Search · 28d" becomes "Search · 28d · Example App 1" on the
   card, and a builder that declines still leaves a card called
   "Search · Example App 1" saying why.
*/

/** "portfolio", or the one property's name when the document holds only
 *  one — a venture board with a single property, where "portfolio" would
 *  be a word for something that is not there. */
function portfolioWord(G: GscReport): string {
  return G.properties.length === 1 ? G.properties[0]!.label : "portfolio";
}

/** The caption under a summed daily line: how many properties are in the
 *  sum, how many days landed, and why it stops short of today. */
function portfolioLine(G: GscReport): string {
  const n = G.properties.length;
  const who = n === 1 ? "one property" : `${n} properties summed, ${G.totals.properties} of them with traffic`;
  return also(
    `daily · ${who} · ${G.series.length} days drawn`,
    G.window.end
      ? `ends ${dayShort(G.window.end)} — the last three days are missing because Google has not finalised them`
      : "",
  );
}

/** A movement in the short form a tile's small print has room for. Null is
 *  "no window before it", never a zero. */
function movedShort(delta: number | null): string {
  if (delta === null) return "no window before";
  const rounded = Math.abs(delta) >= 10 ? Math.round(delta) : Number(delta.toFixed(1));
  return `${rounded > 0 ? "+" : ""}${rounded}% on previous`;
}

/** The day a daily line peaked, for "busiest day" small print. */
function busiestDay<T extends { day: string }>(line: T[], by: (d: T) => number): T | null {
  return line.reduce<T | null>((best, d) => (best === null || by(d) > by(best) ? d : best), null);
}

/** A page's label under one property or under several: the path alone
 *  when the host is the card's, host and path when it is not. */
const pageWord = (G: GscReport) => (G.properties.length > 1 ? pageLabel : pathOf);

/** The ranked rows of every property in the document, one list. On a
 *  one-property venture this is that property's list; on a venture with an
 *  apex and a subdomain it is both, and the property rides in `sub`. */
function acrossProperties<T>(G: GscReport, pick: (p: GscProperty) => T[] | undefined): (T & { property: string })[] {
  return G.properties.flatMap((p) => (pick(p) ?? []).map((row) => ({ ...row, property: p.label })));
}

/** "1 click", "12 clicks". */
const clicksWord = (n: number) => `${count(n)} click${n === 1 ? "" : "s"}`;

/** "on example-app-1.example.test" only when the card holds more than one property. */
const onProperty = (G: GscReport, property: string) => (G.properties.length > 1 ? property : "");

Object.assign(LIVE_BUILDERS, {
  /* ---------------------------------------------------------- the rail */

  "gsc.rail": ({ gsc: G }: LiveInputs) => {
    if (!G?.connected || !G.properties.length) return null;
    const seen = [...G.properties]
      .filter((p) => p.impressions > 0)
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    if (!seen.length) return null;
    const quiet = G.properties.length - seen.length;
    return {
      name: `Every property, by clicks · ${G.window.days}d`,
      tag: "measured",
      ranked: seen.map((p) => ({
        label: p.label,
        /* THE BAR IS CLICKS, against the busiest property rather than the
           sum — Workdash's rail asks "how does this one compare with the
           busiest", and a share of the total draws eighteen invisible bars
           under one full one. */
        value: p.clicks,
        text: clicksWord(p.clicks),
        sub: also(
          also(`${count(p.impressions)} impr`, p.ctr === null ? "" : `${percent(p.ctr, 2)} CTR`),
          p.position === null ? "" : `#${place(p.position)}`,
        ),
        /* The property's OWN daily clicks — rows never added to another
           property's — as a shape beside the name. */
        spark: p.series.length > 1 ? p.series.map((d) => d.clicks) : undefined,
      })),
      caption: also(
        `${seen.length} propert${seen.length === 1 ? "y" : "ies"} with impressions in the ${gscEnds(G)}, busiest first · the line beside each name is its own clicks a day over ${G.seriesDays}d`,
        quiet ? `${quiet} quiet, listed on "No search data yet"` : "",
      ),
    };
  },

  /* ------------------------------------------- one venture's search */

  "gsc.project": ({ gsc: G, project }: LiveInputs) => {
    if (!project || !G?.connected || !G.properties.length) return null;
    const t = G.totals;
    const prevCtr = G.previous.ctr;
    const moved = G.delta.position;
    const top = acrossProperties(G, (p) => p.topQueries)
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 5);
    const pageTwo = G.properties.reduce((n, p) => n + (p.striking?.length ?? 0), 0);
    const peak = busiestDay(G.series, (d) => d.clicks);
    const rows: [string, string][] = top.map((q) => [
      q.query,
      also(`${clicksWord(q.clicks)} · #${place(q.position)}`, onProperty(G, q.property)),
    ]);
    if (!rows.length)
      rows.push(["No query rows", "every query withheld by Google, or none yet"]);
    return {
      name: `Search · ${G.window.days}d`,
      tag: "measured",
      figures: [
        { label: "Clicks", value: count(t.clicks), sub: movedShort(G.delta.clicks) },
        { label: "Impressions", value: count(t.impressions), sub: movedShort(G.delta.impressions) },
        {
          label: "CTR",
          value: t.ctr === null ? DASH : percent(t.ctr, 2),
          /* Points, not percent of a percent — the rule `gsc.ctr` keeps. */
          sub: t.ctr === null || prevCtr === null ? "no window before" : `${t.ctr - prevCtr >= 0 ? "+" : ""}${(t.ctr - prevCtr).toFixed(2)} pts`,
        },
        {
          label: "Position",
          value: place(t.position),
          /* Places, and positive is worse — said in a word rather than a sign. */
          sub: moved === null ? "no window before" : moved === 0 ? "no change" : `${Math.abs(moved).toFixed(1)} ${moved > 0 ? "worse" : "better"}`,
        },
      ],
      series: G.series.length > 1 ? G.series.map((d) => d.clicks) : undefined,
      seriesAt: G.series.length > 1 ? G.series.map((d) => at(d.day)) : undefined,
      unit: "count" as const,
      rows,
      caption: also(
        also(
          `${G.properties.length === 1 ? G.properties[0]!.label : `${G.properties.length} properties`} · ${gscEnds(G)}`,
          peak && G.series.length > 1 ? `clicks a day over ${G.seriesDays}d, busiest ${count(peak.clicks)} on ${dayShort(peak.day)}` : "",
        ),
        also(
          `${pageTwo} quer${pageTwo === 1 ? "y" : "ies"} on page two`,
          G.coverage.pct === null ? "" : `query rows cover ${percent(G.coverage.pct)} of impressions`,
        ),
      ),
    };
  },

  "gsc.projectDaily": ({ gsc: G, project, window: W }: LiveInputs) => {
    if (!project || !G || G.series.length < 2) return null;
    const peak = busiestDay(G.series, (d) => d.clicks);
    const mean = G.series.reduce((n, d) => n + d.clicks, 0) / G.series.length;
    return {
      name: `Clicks a day · ${windowLabel(W ?? G.seriesDays)}`,
      chart: [{ label: "clicks", points: G.series.map((d) => ({ ts: at(d.day), value: d.clicks })) }],
      unit: "count" as const,
      caption: also(
        also(
          `${count(G.totals.clicks)} clicks from ${count(G.totals.impressions)} impressions in the ${gscEnds(G)}`,
          `mean ${mean.toFixed(1)} a day over ${G.series.length} days drawn${peak ? `, busiest ${count(peak.clicks)} on ${dayShort(peak.day)}` : ""}`,
        ),
        G.window.end ? `ends ${dayShort(G.window.end)} — the last three days are missing because Google has not finalised them` : "",
      ),
    };
  },

  "gsc.projectImpressions": ({ gsc: G, project, window: W }: LiveInputs) => {
    if (!project || !G || G.series.length < 2) return null;
    const peak = busiestDay(G.series, (d) => d.impressions);
    const mean = G.series.reduce((n, d) => n + d.impressions, 0) / G.series.length;
    return {
      name: `Impressions a day · ${windowLabel(W ?? G.seriesDays)}`,
      chart: [{ label: "impressions", points: G.series.map((d) => ({ ts: at(d.day), value: d.impressions })) }],
      unit: "count" as const,
      caption: also(
        also(
          `${count(G.totals.impressions)} impressions in the ${gscEnds(G)}`,
          `mean ${Math.round(mean).toLocaleString("en-US")} a day over ${G.series.length} days drawn${peak ? `, busiest ${count(peak.impressions)} on ${dayShort(peak.day)}` : ""}`,
        ),
        G.window.end ? `ends ${dayShort(G.window.end)} — the last three days are missing because Google has not finalised them` : "",
      ),
    };
  },

  "gsc.projectQueries": ({ gsc: G, project }: LiveInputs) => {
    if (!project || !G?.connected || !G.properties.length) return null;
    if (!G.properties.some((p) => p.topQueries)) return null;
    const rows = acrossProperties(G, (p) => p.topQueries)
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 10);
    if (!rows.length)
      return {
        name: `Top queries · ${G.window.days}d`,
        ranked: [{ label: "No query rows", value: 0, text: DASH, sub: "every query withheld, or none yet" }],
        caption: "Google withholds queries too rare to anonymise; a property with impressions and no rows had every query withheld",
      };
    return {
      name: `Top queries · ${G.window.days}d`,
      ranked: rows.map((q) => ({
        label: q.query,
        value: q.clicks,
        text: clicksWord(q.clicks),
        sub: also(`${count(q.impressions)} impr · #${place(q.position)}`, onProperty(G, q.property)),
      })),
      caption:
        G.coverage.pct === null
          ? "Google's clicks-ordered rows — a sample of the impressions, never all of them"
          : `these rows cover ${percent(G.coverage.pct)} of impressions — Google withholds rare queries and caps the rows`,
    };
  },

  "gsc.projectPages": ({ gsc: G, project }: LiveInputs) => {
    if (!project || !G?.connected || !G.properties.length) return null;
    if (!G.properties.some((p) => p.topPages)) return null;
    const rows = acrossProperties(G, (p) => p.topPages)
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 10);
    if (!rows.length) return null;
    const label = pageWord(G);
    return {
      name: `Top pages · ${G.window.days}d`,
      ranked: rows.map((p) => ({
        label: label(p.page),
        value: p.clicks,
        text: clicksWord(p.clicks),
        sub: `${count(p.impressions)} impr · #${place(p.position)}`,
      })),
      caption: "landing pages from search, by clicks · Google's own capped page rows",
    };
  },

  "gsc.projectStriking": ({ gsc: G, project }: LiveInputs) => {
    if (!project || !G?.connected || !G.properties.length) return null;
    if (!G.properties.some((p) => p.striking)) return null;
    const rows = acrossProperties(G, (p) => p.striking)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 10);
    if (!rows.length)
      return {
        ranked: [{ label: "Nothing at position 5–20", value: 0, text: DASH, sub: "with 3+ impressions" }],
        caption: "drawn from Google's clicks-ordered rows, so a high-impression query with no clicks can be missing",
      };
    return {
      ranked: rows.map((q) => ({
        label: q.query,
        /* THE BAR IS IMPRESSIONS, not the rank — the rule `gsc.strikingRanked` keeps. */
        value: q.impressions,
        text: `${count(q.impressions)} impr`,
        sub: also(`#${place(q.position)} · ${clicksWord(q.clicks)}`, onProperty(G, q.property)),
      })),
      caption:
        "position 5–20 with 3+ impressions, most impressions first · drawn from Google's clicks-ordered rows, so a high-impression query with no clicks can be missing",
    };
  },

  "gsc.projectSitemaps": ({ gsc: G, project }: LiveInputs) => {
    if (!project || !G?.connected || !G.properties.length) return null;
    const rows: [string, string][] = [];
    for (const p of G.properties) {
      const s = p.sitemaps;
      const who = onProperty(G, p.label);
      /* THREE STATES AND NOT TWO — the rule `gsc.sitemaps` keeps. */
      if (s.state === "reported") {
        rows.push([also("Submitted", who), `${count(s.count)} sitemap${s.count === 1 ? "" : "s"} · ${count(s.submitted)} URLs`]);
        if (s.errors || s.warnings)
          rows.push([also("Complaints", who), also(s.errors ? `${count(s.errors)} error${s.errors === 1 ? "" : "s"}` : "", s.warnings ? `${count(s.warnings)} warning${s.warnings === 1 ? "" : "s"}` : "")]);
        if (s.pending) rows.push([also("Pending", who), `${count(s.pending)} not yet processed`]);
        rows.push([also("Last read by Google", who), s.lastDownloaded ? dayShort(s.lastDownloaded.slice(0, 10)) : "never"]);
      } else if (s.state === "none") rows.push([also("Submitted", who), "nothing — Google is finding pages by crawling alone"]);
      else rows.push([also("Submitted", who), "could not be read — not the same as none"]);
    }
    rows.push(["Submitted, not indexed", "Search Console publishes no index count by API"]);
    return { rows };
  },

  /* ---------------------------------------------- one venture's SEO */

  "audit.project": ({ audit: A, project }: LiveInputs) => {
    if (!project || !A?.ventures.length) return null;
    /* The overview's row for the venture — the card narrowed the document,
       so the first row is the venture's; a venture with two hosts on two
       rows is drawn from the one crawled most recently. */
    const v = [...A.ventures].sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""))[0]!;
    if (!v.ts || !v.issues)
      return {
        figures: [
          { label: "Errors", value: DASH },
          { label: "Warnings", value: DASH },
          { label: "Pages", value: DASH },
          { label: "Crawled", value: "never" },
        ],
        rows: [["Never crawled", "unmeasured, which is not the same as clean"]] as [string, string][],
        caption: "run an audit from the venture's page",
      };
    const site = hostOf(v.canonicalHost);
    return {
      tag: "measured",
      figures: [
        { label: "Errors", value: count(v.issues.error), sub: v.issues.error ? "faults with an owner" : "none found" },
        { label: "Warnings", value: count(v.issues.warning), sub: `${count(v.issues.notice)} notice${v.issues.notice === 1 ? "" : "s"}` },
        { label: "Pages", value: count(v.pages), sub: "reached by the crawl" },
        { label: "Crawled", value: ago(v.ts), sub: dayShort(v.ts.slice(0, 10)) },
      ],
      rows: [
        ["HTTPS", httpsWord(v.https)],
        ["Sitemap", v.sitemap ? tailOf(v.sitemap) : "none found at any address tried"],
        /* A MISSING robots.txt IS NOT A CLOSED SITE — the audit's own note. */
        ["robots.txt", v.robots === null ? "not established" : v.robots ? "answered" : "none — everything allowed"],
        ["Answered at", site ?? "nothing answered"],
      ] as [string, string][],
      caption: also(
        "the crawl's counts, never a score · three errors over four pages is not three over forty",
        "the page-by-page list is the crawl itself, on the venture's SEO page",
      ),
    };
  },

  "authority.project": ({ seo, project }: LiveInputs) => {
    const hosts = seo?.authority?.hosts;
    if (!project || !hosts?.length) return null;
    const rows: [string, string][] = [];
    for (const h of hosts) {
      const who = hosts.length > 1 ? h.host : "";
      rows.push([also("Estimate", who), h.estimate === null ? "nothing could be read — not a low score" : `${Math.round(h.estimate)} of 100, this box's own`]);
      rows.push([
        also("Aim under difficulty", who),
        h.ceiling !== null ? `KD ${h.ceiling} at most` : h.estimate === null ? DASH : "no ceiling — not the constraint at this size",
      ]);
      rows.push([also("Basis", who), h.basis.length ? h.basis.join(" + ") : "nothing could be read"]);
      if (h.missing.length) rows.push([also("Not read", who), h.missing.join(", ")]);
      rows.push([
        also("Referring domains", who),
        h.links.referringDomains === null ? DASH : also(count(h.links.referringDomains), h.links.from ? `from ${h.links.from}` : ""),
      ]);
    }
    rows.push(["Not a Domain Rating", "nor any vendor's score — see the route's own label"]);
    return { tag: "est.", rows };
  },

  "indexing.project": ({ seo, project }: LiveInputs) => {
    const I = seo?.indexing;
    if (!project || !I?.hosts.length) return null;
    const rows: [string, string][] = [];
    for (const h of I.hosts) {
      const who = I.hosts.length > 1 ? h.host : "";
      if (!h.submissions) {
        rows.push([also("Submitted", who), "nothing yet — submit from the venture's Growth page"]);
        continue;
      }
      rows.push([also("Submitted", who), `${count(h.submissions)} · ${count(h.received)} received`]);
      if (h.refused) rows.push([also("Refused by IndexNow", who), count(h.refused)]);
      /* A DRY RUN IS THIS BOX'S OWN NO — the key file was not hosted. */
      if (h.dryRun) rows.push([also("Held here", who), `${count(h.dryRun)} — key file missing`]);
      if (h.last) rows.push([also("Last", who), `${h.last.outcome} · ${dayShort(h.last.at.slice(0, 10))}`]);
    }
    rows.push(["Auto-submit", I.autoSubmit ? "on" : "off"]);
    /* THE PROTOCOL'S OWN LIMIT: a receipt is not a crawl, and Google is
       told nothing by any of this. */
    rows.push(["Google", "not told — it never joined IndexNow"]);
    return { rows };
  },

  "seoops.project": ({ seo, project }: LiveInputs) => {
    const F = seo?.followups;
    if (!project || !F) return null;
    if (!F.baselines.length)
      return {
        rows: [
          ["Nothing tracked for this venture", `finish a board card tagged ${F.schedule.tag} naming one of its URLs`],
          ["Then", `readings ${F.schedule.offsetsDays.join(", ")} days after, over ${F.schedule.windowDays}d windows`],
        ] as [string, string][],
      };
    const VERDICT: Record<string, string> = {
      up: "up",
      down: "down",
      flat: "flat",
      thin: "too thin to judge",
      unmeasured: "not measurable",
    };
    const rows: [string, string][] = F.baselines.slice(0, 8).map((b) => {
      const last = b.diagnoses.at(-1);
      if (!last) {
        const next = b.due.find((d) => !d.overdue) ?? b.due[0];
        return [tailOf(b.url), next ? `${next.dayOffset}d reading due ${dayShort(next.dueAt.slice(0, 10))}` : "no reading due"];
      }
      const d = last.delta;
      const moved =
        d && d.clicks !== null && d.impressions !== null
          ? `${d.clicks >= 0 ? "+" : ""}${count(d.clicks)} clicks · ${d.impressions >= 0 ? "+" : ""}${count(d.impressions)} impr`
          : "";
      return [tailOf(b.url), also(`${VERDICT[last.verdict] ?? last.verdict} at ${last.dayOffset}d`, moved)];
    });
    if (F.baselines.length > rows.length) rows.push([`+${F.baselines.length - rows.length} more`, "tracked"]);
    rows.push(["Verdicts are arithmetic", "correlation, not cause"]);
    return { tag: "measured", rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ============================================================== SOCIAL BOARD

   WHAT WAS ACTUALLY PUBLISHED, AND WHETHER ANYBODY SAW IT.

   The Social board was seven cards of counts — followers per Page, a paid
   reach figure, and the list of what the token will not read — because that
   was everything `/api/meta` could answer. It was not everything this box
   holds. The socialfeed area reads each mapped Page's TIMELINE back from Meta
   every six hours and stores the words, the picture's address, the permalink
   and Meta's own per-post metrics; the publishing area holds the other end of
   the loop. Neither had a card. These builders are that gap.

   THE FIVE RULES EVERY BUILDER BELOW KEEPS.

   1. "VIEWS", NEVER "REACH", ON A FACEBOOK POST. What Meta returns is
      `post_media_view`, which counts RENDERS — one person scrolling past
      twice is two. The `post_impressions` family, which counted people, was
      retired on 15 November 2025 and answers 400. Instagram's `reach` DOES
      count unique accounts, which is why it is never added to a Facebook
      view: two different quantities under one word is the failure this whole
      file is arranged around not committing.

   2. A METRIC THAT IS NOT A KEY WAS NOT REPORTED. The collector writes what
      came back and nothing else, so an absent key is "Meta did not say" and
      draws a dash. A post Meta measured at zero views is a different fact
      from a post Meta never measured, and they never share a figure.

   3. A WIDE WINDOW IS A FLOOR. Twenty-five posts are read per Page per
      collection, so a Page that published more than that between two reads
      had the rest truncated before any card saw it. Every total over a window
      wider than the collection interval says so.

   4. THE WINDOW IS MEASURED AGAINST TODAY, never against the newest post.
      This is the one arithmetic decision that makes or breaks the board: cut
      relative to the last post and "nothing went out this month" — the
      finding this board exists for — becomes unsayable, because the newest
      post is always inside a window that starts at it.

   5. NOTHING ADDS ACROSS NETWORKS. A Facebook follower, a Bluesky follower
      and an Instagram follower are three people, or one person three times,
      and nothing here can tell which. Followers add across PAGES — a follower
      follows exactly one Page — and stop there.
*/

/** Meta's own metric names. Never renamed here: the key IS the claim. */
const FB_VIEWS = "post_media_view";
const FB_CLICKS = "post_clicks";
const FB_REACTIONS = "reactions.summary.total_count";
const FB_COMMENTS = "comments.summary.total_count";

/** A metric, or null when Meta did not report it. See rule 2: an absent key
 *  is never a zero, and `?? 0` anywhere in this section would be the bug. */
function metricOf(p: SocialPost, key: string): number | null {
  const v = p.metrics[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Views on the platform's OWN terms, or null.
 *
 * Facebook counts renders and Instagram counts unique accounts. The two are
 * read from different keys and are summed only WITHIN a platform — see the
 * per-network splits below, which is why this returns the number and never
 * the word for it.
 */
function postViews(p: SocialPost): number | null {
  return metricOf(p, p.platform === "instagram" ? "reach" : FB_VIEWS);
}

/**
 * Reactions plus comments, or null when neither was reported.
 *
 * NOT "ENGAGEMENT" IN META'S SENSE, AND THE MISSING PIECE IS SHARES. Workdash
 * says "reactions, comments and shares" because its collector read the
 * retired `post_activity` family; what survives on v21.0 is the reaction and
 * comment summaries, which need no insights permission at all, and there is
 * no share count in them. So every card below words it "reactions + comments"
 * rather than borrowing a wider word for a narrower number.
 */
function postEngagement(p: SocialPost): number | null {
  const reactions = metricOf(p, p.platform === "instagram" ? "like_count" : FB_REACTIONS);
  const comments = metricOf(p, p.platform === "instagram" ? "comments_count" : FB_COMMENTS);
  if (reactions === null && comments === null) return null;
  return (reactions ?? 0) + (comments ?? 0);
}

/** Whole days between an ISO stamp and now, or null. */
function daysAgo(at: string | null): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/**
 * THE WINDOW, AS A PREDICATE OVER A POST'S OWN DATE — see rule 4.
 *
 * Measured against TODAY and not against the newest post the collector holds.
 * The difference is the whole board: a window cut relative to the last post
 * always contains it, so "nothing published in the last 7 days" could never
 * be said, and a Page silent since June would read as freshly active.
 */
function within(W: WindowValue | undefined): (p: SocialPost) => boolean {
  const days = W ?? 30;
  return (p) => {
    if (days === "all") return true;
    const d = daysAgo(p.createdTime);
    return d !== null && d <= days;
  };
}

/** A post's date, with the year on it once the post is not from this one. */
function postDay(at: string | null): string {
  if (!at) return DASH;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return DASH;
  const sameYear = new Date(ms).getFullYear() === new Date().getFullYear();
  return day(at, { year: sameYear ? false : "2-digit" });
}

/** The network a post was published on, in the words a person uses. */
const networkWord = (platform: string): string =>
  platform === "instagram" ? "Instagram" : platform === "facebook" ? "Facebook" : platform;

/** The posts the socialfeed collector holds, or an empty list. */
const allPosts = (S: SocialBoardDocs | null | undefined): SocialPost[] => S?.posts?.posts ?? [];

/** One post as a feed row. The figures are formatted here so the card never
 *  decides what a view count looks like — the `DonutSlice.text` contract. */
function feedItem(p: SocialPost): FeedItem {
  const views = postViews(p);
  const engagement = postEngagement(p);
  const meta: [string, string][] = [
    /* "1 views" is the kind of small wrongness that makes a reader stop
       trusting the big figures. One view is a view. */
    [
      p.platform === "instagram" ? (views === 1 ? "account reached" : "accounts reached") : views === 1 ? "view" : "views",
      count(views),
    ],
    ["reactions + comments", count(engagement)],
  ];
  const clicks = metricOf(p, FB_CLICKS);
  if (clicks !== null && clicks > 0) meta.push(["clicks", count(clicks)]);
  return {
    title: p.pageName ?? p.pageId,
    at: postDay(p.createdTime),
    text: p.text,
    image: p.imageUrl,
    href: p.permalink,
    meta,
  };
}

/** What a card says when the window holds nothing but the record does. */
function nothingInWindow(posts: SocialPost[], W: WindowValue | undefined): string {
  const newest = posts
    .map((p) => p.createdTime)
    .filter((at): at is string => !!at)
    .sort()
    .at(-1);
  const words = W === "all" ? "the whole record" : `the last ${W ?? 30} days`;
  return newest
    ? `Nothing published in ${words} — the newest collected post is ${postDay(newest)}. Widen the window to read it.`
    : "No posts collected yet. A Page is read only once it is mapped to a venture under Publishing.";
}

/** Every page that has posts in the document, with its own totals. */
function byPage(posts: SocialPost[]) {
  const pages = new Map<
    string,
    { id: string; name: string; platform: string; posts: SocialPost[] }
  >();
  for (const p of posts) {
    const row = pages.get(p.pageId) ?? {
      id: p.pageId,
      name: p.pageName ?? p.pageId,
      platform: p.platform,
      posts: [],
    };
    row.posts.push(p);
    pages.set(p.pageId, row);
  }
  return [...pages.values()];
}

/** Views summed over the posts Meta actually measured, and the two counts
 *  that qualify it. Null views where nothing was measured — never zero. */
function totals(posts: SocialPost[]) {
  const measured = posts.filter((p) => postViews(p) !== null);
  const engaged = posts.filter((p) => postEngagement(p) !== null);
  return {
    posts: posts.length,
    measured: measured.length,
    views: measured.length ? measured.reduce((n, p) => n + (postViews(p) ?? 0), 0) : null,
    engagement: engaged.length ? engaged.reduce((n, p) => n + (postEngagement(p) ?? 0), 0) : null,
    latest: posts
      .map((p) => p.createdTime)
      .filter((at): at is string => !!at)
      .sort()
      .at(-1) ?? null,
  };
}

/** The floor caveat, in the words every card that sums over a window uses. */
const FLOOR_NOTE =
  "Twenty-five posts are read per Page per collection, so a wide window is a FLOOR rather than a count.";

/** The views caveat, likewise. */
const VIEWS_NOTE =
  "A view is a render, not a person — Meta retired the impressions family in Nov 2025 and what is left is post_media_view.";

/**
 * The buckets a cadence line is drawn over: a day each inside a month, a week
 * each beyond it.
 *
 * A ninety-day line at daily grain is ninety points of which eighty are zero,
 * which draws as noise around an axis; a seven-day line at weekly grain is one
 * point, which is not a line at all. So the grain follows the window and the
 * caption says which one it took.
 */
function buckets(W: WindowValue | undefined, posts: SocialPost[]) {
  const days = W === "all" || W === undefined ? null : W;
  const daily = days !== null && days <= 31;
  const dated = posts.filter((p) => p.createdTime);
  if (!dated.length) return null;
  const key = (at: string) => {
    const d = new Date(at);
    if (daily) return `${d.toISOString().slice(0, 10)}T00:00:00Z`;
    /* The Monday of the post's week, in UTC — one bucket a week, and the
       stamp is a real date the chart's axis can label. */
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    return `${monday.toISOString().slice(0, 10)}T00:00:00Z`;
  };
  const oldest = dated
    .map((p) => p.createdTime!)
    .sort()[0]!;
  /* THE EMPTY BUCKETS ARE DRAWN, and that is the point of this card: a week
     nobody published in is a measured zero, not a gap. The span runs from the
     window's start (or the oldest post, over "all") to today, so a line that
     stops is a habit that stopped rather than a collector that did. */
  const from = days === null ? Date.parse(oldest) : Date.now() - days * 86_400_000;
  const stamps: string[] = [];
  const step = daily ? 86_400_000 : 7 * 86_400_000;
  /* WRITTEN THROUGH `key` AND NOT THROUGH `toISOString`, because the two do
     not agree: one ends "T00:00:00Z" and the other "T00:00:00.000Z", and a
     bucket looked up by a stamp of the second shape misses every time — which
     draws a line of measured zeroes over posts that exist. */
  for (let t = Date.parse(key(new Date(from).toISOString())); t <= Date.now(); t += step)
    stamps.push(key(new Date(t).toISOString()));
  return { stamps, key, grain: daily ? "a day" : "a week" };
}

Object.assign(LIVE_BUILDERS, {
  /*
    FOLLOWERS, AND THE PAGES THEY ARE SPREAD ACROSS.

    Workdash leads its Social page with this and it leads here for the same
    reason: a follower total means nothing without knowing how many accounts
    it is spread over, and three Pages with 350, 9 and 2 followers is a
    different business from one Page with 361.

    THE FIGURE HAS NO WINDOW AND SAYS SO. Meta publishes a follower count and
    no history of it, so this is the audience as it stands whatever the picker
    is set to — the one card on this board the control cannot move.
  */
  "social.followers": ({ meta: M, social: S }: LiveInputs) => {
    if (!M?.pages.length) return null;
    /* Only the Pages whose timelines are actually read: a token can
       administer Pages belonging to businesses this box has never heard of,
       and a follower total over those is a total of somebody else's audience. */
    const read = new Set((S?.posts?.accounts ?? []).map((a) => a.pageId));
    const pages = M.pages.filter((p) => (read.size ? read.has(p.id) : true));
    const known = pages.filter((p) => p.followers !== null);
    if (!known.length) return null;
    const total = known.reduce((n, p) => n + (p.followers ?? 0), 0);
    return {
      tag: "measured",
      value: count(total),
      sub: also(
        `across ${known.length} Facebook Page${known.length === 1 ? "" : "s"}`,
        pages.length > known.length
          ? `${pages.length - known.length} reported no count`
          : "",
      ),
      parts: known
        .filter((p) => (p.followers ?? 0) > 0)
        .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0))
        .map((p) => ({
          label: p.name ?? p.id,
          value: p.followers ?? 0,
          text: count(p.followers),
        })),
      partsLabel: "Followers by Page",
      /* Short, because this is a one-column tile: the argument for why the
         window cannot move this figure belongs on the card that has room for
         it, and `social.accounts` carries it. */
      caption: "No history is published for these, so the window cannot move them. Never added across networks.",
    };
  },

  /*
    VIEWS OVER THE WINDOW, AND THE THREE COUNTS THAT QUALIFY THEM.

    Workdash's second hero, with its denominators kept where it put them —
    under the figure rather than beside it, because "1,204 views" means one
    thing across ten posts and another across one.

    FACEBOOK ONLY, AND THAT IS NOT AN OVERSIGHT. Instagram's `reach` counts
    unique accounts where `post_media_view` counts renders; adding them would
    produce a number in no unit at all. Instagram has its own card.
  */
  "social.views": ({ social: S, window: W }: LiveInputs) => {
    const posts = allPosts(S).filter((p) => p.platform === "facebook");
    if (!S?.posts) return null;
    const inWindow = posts.filter(within(W));
    const t = totals(inWindow);
    const pages = byPage(inWindow)
      .map((g) => ({ ...g, t: totals(g.posts) }))
      .filter((g) => g.t.views !== null)
      .sort((a, b) => (b.t.views ?? 0) - (a.t.views ?? 0));
    return {
      tag: t.measured ? "metered" : "measured",
      value: count(t.views),
      sub: t.posts
        ? `${count(t.measured)} of ${count(t.posts)} post${t.posts === 1 ? "" : "s"} measured`
        : "nothing published in this window",
      parts: pages.map((g) => ({
        label: g.name,
        value: g.t.views ?? 0,
        text: count(g.t.views),
      })),
      partsLabel: "Views by Page",
      rows: [
        ["Posts published", count(t.posts)],
        ["Meta measured", count(t.measured)],
        ["Reactions + comments", count(t.engagement)],
      ],
      caption: `${VIEWS_NOTE} ${FLOOR_NOTE}`,
    };
  },

  /*
    HOW LONG SINCE ANYBODY PUBLISHED — the one number on this board that has
    to be blunt.

    A dormant channel costs nothing visible. There is no figure that goes red
    when you stop posting, which is exactly why this one does: past a
    fortnight it is drawn as a warning.

    IT IGNORES THE WINDOW ON PURPOSE and wears "now" for saying so. Recomputing
    it inside a seven-day window would answer "quiet for 7 days" about a Page
    silent since June, which is the worst answer this board could give.
  */
  "social.quiet": ({ social: S }: LiveInputs) => {
    const posts = allPosts(S);
    if (!S?.posts) return null;
    const t = totals(posts);
    const quiet = daysAgo(t.latest);
    const pages = byPage(posts);
    const cold = pages.filter((g) => {
      const d = daysAgo(totals(g.posts).latest);
      return d !== null && d > 14;
    }).length;
    return {
      tag: "measured",
      value: quiet === null ? DASH : quiet === 0 ? "today" : `${quiet}d ago`,
      tone: quiet !== null && quiet > 14 ? "warn" : undefined,
      sub: also(
        t.latest ? `last post ${postDay(t.latest)}` : "nothing collected",
        pages.length
          ? cold > 0
            ? `${cold} of ${pages.length} Page${pages.length === 1 ? "" : "s"} quiet a fortnight or more`
            : `every Page has published within the fortnight`
          : "",
      ),
    };
  },

  /*
    VIEWS A POST — the rate Workdash puts in a chip, as a tile.

    OUR ARITHMETIC AND NOT META'S, over the posts Meta measured rather than
    over every post published: dividing by the unmeasured ones would quietly
    treat "not reported" as "nobody saw it", which is rule 2 in reverse.
  */
  "social.perPost": ({ social: S, window: W }: LiveInputs) => {
    if (!S?.posts) return null;
    const inWindow = allPosts(S).filter((p) => p.platform === "facebook").filter(within(W));
    const t = totals(inWindow);
    if (!t.measured || t.views === null) return null;
    const each = t.views / t.measured;
    return {
      tag: "computed",
      /* A DECIMAL BELOW TEN. Seven posts sharing one view round to "0", which
         reads as a measurement of nobody and is the opposite of what happened
         — somebody saw one of them. */
      value: each >= 10 ? count(Math.round(each)) : each.toFixed(1),
      sub: `${count(t.views)} view${t.views === 1 ? "" : "s"} across the ${count(t.measured)} post${t.measured === 1 ? "" : "s"} Meta measured`,
      caption: VIEWS_NOTE,
    };
  },

  /*
    THE PUBLISHING HABIT, DRAWN — one line per network, never one line for all
    of them.

    A NETWORK IS A SERIES AND NOT A COLOUR ON A STACK. Two posts on Facebook
    and two on Bluesky are four posts and the sum says nothing: the question
    this card answers is "which channel am I actually feeding", and a total
    hides exactly that. The lines are kept apart for the reason no follower
    count on this board is added to another.

    AN EMPTY BUCKET IS A MEASURED ZERO. A week nobody published in is a fact
    about the week, so the line runs flat along the axis rather than skipping
    to the next post — which is the difference between "the habit stopped" and
    "the collector stopped".
  */
  "social.cadence": ({ social: S, bluesky: B, window: W }: LiveInputs) => {
    if (!S?.posts) return null;
    const posts = allPosts(S).filter(within(W));
    const bskyPosts = (B?.handles ?? []).flatMap((h) =>
      (h.posts ?? []).map((p) => ({ at: p.at, network: "Bluesky" })),
    );
    const rows = [
      ...posts.map((p) => ({ at: p.createdTime, network: networkWord(p.platform) })),
      ...bskyPosts,
    ];
    const shape = buckets(W, posts);
    if (!shape || !rows.length) return null;
    const networks = [...new Set(rows.map((r) => r.network))].sort();
    return {
      tag: "metered",
      unit: "count",
      chart: networks.map((network) => {
        const own = new Map<string, number>();
        for (const r of rows)
          if (r.network === network && r.at)
            own.set(shape.key(r.at), (own.get(shape.key(r.at)) ?? 0) + 1);
        return {
          label: network,
          points: shape.stamps.map((ts) => ({ ts, value: own.get(ts) ?? 0 })),
        };
      }),
      caption:
        `Posts published, ${shape.grain} at a time, one line per network and never a total — two posts on ` +
        `two networks are two habits. A flat stretch is a stretch nobody published in. ${FLOOR_NOTE}`,
    };
  },

  /*
    VIEWS OVER TIME, CREDITED TO THE DAY A POST WENT OUT.

    THIS IS NOT A DAILY VIEW COUNT AND MUST NOT BE READ AS ONE. Meta reports a
    post's views as a running total and publishes no history of them, so there
    is no per-day series to draw. What this line is: the views each week's
    posts have accumulated BY NOW, plotted at the week they were published.
    A tall bar late in the line is not a good week yet — it is a week whose
    posts have had less time to gather what they have.

    One line per network, for `social.cadence`'s reason and one stronger: a
    Facebook render and an Instagram unique account cannot be added at all.
  */
  "social.viewsTrend": ({ social: S, window: W }: LiveInputs) => {
    if (!S?.posts) return null;
    const posts = allPosts(S).filter(within(W)).filter((p) => postViews(p) !== null);
    const shape = buckets(W, posts);
    if (!shape || !posts.length) return null;
    const networks = [...new Set(posts.map((p) => networkWord(p.platform)))].sort();
    return {
      tag: "measured",
      unit: "count",
      chart: networks.map((network) => {
        const own = new Map<string, number>();
        for (const p of posts)
          if (networkWord(p.platform) === network && p.createdTime)
            own.set(
              shape.key(p.createdTime),
              (own.get(shape.key(p.createdTime)) ?? 0) + (postViews(p) ?? 0),
            );
        return {
          label: `${network} · views`,
          points: shape.stamps.map((ts) => ({ ts, value: own.get(ts) ?? 0 })),
        };
      }),
      caption:
        `Views as they stand NOW, plotted at the ${shape.grain === "a day" ? "day" : "week"} each post went ` +
        `out — not a daily view count, which Meta publishes no history for. A recent point is low partly ` +
        `because its posts are young. ${VIEWS_NOTE}`,
    };
  },

  /*
    WHICH PAGE WAS SEEN — Workdash's "Views by page", as ranked bars.

    A PAGE WITH NO MEASURED POST IS LEFT OFF RATHER THAN DRAWN AT ZERO, and
    the caption counts the ones that were. A bar of length nothing is a claim
    that nobody saw it; the truth is that nobody measured it.
  */
  "social.viewsByPage": ({ social: S, meta: M, window: W }: LiveInputs) => {
    if (!S?.posts) return null;
    const inWindow = allPosts(S).filter(within(W));
    const groups = byPage(inWindow)
      .map((g) => ({ ...g, t: totals(g.posts) }))
      .sort((a, b) => (b.t.views ?? -1) - (a.t.views ?? -1));
    const drawn = groups.filter((g) => g.t.views !== null);
    if (!drawn.length) return null;
    const followers = (id: string) => M?.pages.find((p) => p.id === id)?.followers ?? null;
    const silent = groups.length - drawn.length;
    return {
      tag: "metered",
      ranked: drawn.map((g) => ({
        label: g.name,
        value: g.t.views ?? 0,
        text: count(g.t.views),
        sub: `${count(g.t.posts)} post${g.t.posts === 1 ? "" : "s"} · ${count(followers(g.id))} followers`,
      })),
      caption: also(
        `${VIEWS_NOTE} ${FLOOR_NOTE}`,
        silent > 0
          ? `${silent} more Page${silent === 1 ? " published and was" : "s published and were"} not measured on any post, so ${silent === 1 ? "it is" : "they are"} not drawn`
          : "",
      ),
    };
  },

  /*
    WHICH PAGE WAS ANSWERED — the same shape over the other half of a post.

    REACTIONS PLUS COMMENTS, AND THE WORD "ENGAGEMENT" IS AVOIDED ON PURPOSE.
    Meta's engagement family included shares and was retired; what is left are
    the two summaries that need no insights permission. Calling two things by
    the name of three is how a number gets read as bigger than it is.
  */
  "social.engagementByPage": ({ social: S, window: W }: LiveInputs) => {
    if (!S?.posts) return null;
    const inWindow = allPosts(S).filter(within(W));
    const groups = byPage(inWindow)
      .map((g) => ({ ...g, t: totals(g.posts) }))
      .filter((g) => g.t.engagement !== null)
      .sort((a, b) => (b.t.engagement ?? 0) - (a.t.engagement ?? 0));
    if (!groups.length) return null;
    const answered = inWindow.filter((p) => (postEngagement(p) ?? 0) > 0).length;
    return {
      tag: "metered",
      ranked: groups.map((g) => ({
        label: g.name,
        value: g.t.engagement ?? 0,
        text: count(g.t.engagement),
        sub: `${count(g.t.posts)} post${g.t.posts === 1 ? "" : "s"}`,
      })),
      caption:
        `Reactions and comments as those posts carry them now — an old post gathering a new like moves ` +
        `this. SHARES ARE NOT IN IT: the metric that counted them was retired with the impressions family. ` +
        `${answered} post${answered === 1 ? "" : "s"} in this window got any response at all.`,
    };
  },

  /*
    EVERY ACCOUNT, AS A TABLE — Workdash's page tiles and its archive fold,
    both of which are reference rather than a call to act, and a table is what
    reference looks like on a board.

    THE LAST TWO COLUMNS ARE THE COLLECTOR'S OWN STATE. A Page whose read is
    failing keeps the date it last worked, and a dead token therefore reads as
    a dead token rather than as a quiet month — the single most valuable thing
    this table says.
  */
  "social.accounts": ({ social: S, meta: M, window: W }: LiveInputs) => {
    const accounts = S?.posts?.accounts ?? [];
    if (!accounts.length) return null;
    const posts = allPosts(S);
    const table = accounts
      .map((a) => {
        const own = posts.filter((p) => p.pageId === a.pageId);
        const t = totals(own.filter(within(W)));
        const all = totals(own);
        return {
          followers: M?.pages.find((p) => p.id === a.pageId)?.followers ?? null,
          row: [
            a.pageName ?? a.pageId,
            networkWord(a.platform),
            count(M?.pages.find((p) => p.id === a.pageId)?.followers ?? null),
            count(t.posts),
            count(t.views),
            count(t.engagement),
            all.latest ? postDay(all.latest) : DASH,
            a.error ?? a.insightsError ?? (a.lastOkAt ? `read ${ago(a.lastOkAt)}` : "never read"),
          ],
          bad: !!(a.error ?? a.insightsError),
        };
      })
      .sort((a, b) => (b.followers ?? -1) - (a.followers ?? -1));
    return {
      tag: "measured",
      headers: [
        "Page",
        "Network",
        "Followers now",
        `Posts ${windowLabel(W ?? 30)}`,
        "Views",
        "Reactions + comments",
        "Last post any age",
        "Collector",
      ],
      table: table.map((r) => r.row),
      rowTones: table.map((r) => (r.bad ? ("bad" as const) : null)),
      caption:
        `Followers and the last post ignore the window — one has no history and the other is a fact about ` +
        `today. Everything between them follows it. ${FLOOR_NOTE}`,
    };
  },

  /*
    WHAT WORKED — the posts to make more of, as the posts themselves.

    TWO LISTS AND NOT ONE, which is the shape Workdash argues for and the
    argument holds: "what worked" is what to make more of and "what went out"
    is whether the habit is alive, and a single reverse-chronological feed
    answers the second while hiding the first.

    THE BASIS IS WHICHEVER ONE THIS PORTFOLIO ACTUALLY HAS, AND IT IS NAMED.
    Ranking by reactions is the right measure and is useless on a portfolio
    where almost every post has none — every tie would be broken by the order
    the rows came back in, which is a ranking of nothing. So the card ranks by
    response where any post got one and by views otherwise, and the caption
    says which it did. A card that silently swapped its measure would be worse
    than either.
  */
  "social.top": ({ social: S, window: W }: LiveInputs) => {
    if (!S?.posts) return null;
    const all = allPosts(S);
    const inWindow = all.filter(within(W));
    const responded = inWindow.filter((p) => (postEngagement(p) ?? 0) > 0);
    const byResponse = responded.length > 0;
    const ranked = (byResponse ? responded : inWindow.filter((p) => (postViews(p) ?? 0) > 0))
      .slice()
      .sort((a, b) =>
        byResponse
          ? (postEngagement(b) ?? 0) - (postEngagement(a) ?? 0)
          : (postViews(b) ?? 0) - (postViews(a) ?? 0),
      )
      .slice(0, 4);
    if (!ranked.length)
      return {
        tag: "metered",
        feed: [],
        caption: inWindow.length
          ? `${inWindow.length} post${inWindow.length === 1 ? "" : "s"} went out in this window and Meta measured none of them, so none can be ranked.`
          : nothingInWindow(all, W),
      };
    return {
      tag: "metered",
      feed: ranked.map(feedItem),
      caption:
        `Ranked by ${byResponse ? "reactions and comments" : "views"}${
          byResponse
            ? ""
            : " — no post in this window drew a reaction or a comment, so views are the only measure left"
        }. An older post has had longer to gather what it has, so this is a total and not a rate. ${VIEWS_NOTE}`,
    };
  },

  /*
    WHAT WENT OUT LATELY — the habit, in reverse chronological order.

    An empty list here is a fact about the WINDOW and not about the Pages, and
    the two must not read the same: the caption names the newest post there
    actually is rather than leaving a reader to conclude the collector broke.
  */
  "social.latest": ({ social: S, window: W }: LiveInputs) => {
    if (!S?.posts) return null;
    const all = allPosts(S);
    const inWindow = all
      .filter(within(W))
      .slice()
      .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)))
      .slice(0, 5);
    if (!inWindow.length) return { tag: "measured", feed: [], caption: nothingInWindow(all, W) };
    const older = all.filter(within(W)).length - inWindow.length;
    return {
      tag: "measured",
      feed: inWindow.map(feedItem),
      caption: also(
        older > 0 ? `${older} more in this window` : "Everything published in this window",
        `${VIEWS_NOTE} A post generated on this box carries the draft it came from; most were made elsewhere.`,
      ),
    };
  },

  /*
    ONE NETWORK'S FEED — Facebook.

    A per-network card rather than a filter on the card above, because "is
    Facebook alive" and "is anything alive" are different questions and the
    second one hides the first the moment a second network starts publishing.
  */
  "social.facebook": ({ social: S, window: W }: LiveInputs) => {
    if (!S?.posts) return null;
    const all = allPosts(S).filter((p) => p.platform === "facebook");
    const inWindow = all
      .filter(within(W))
      .slice()
      .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)))
      .slice(0, 5);
    if (!all.length) return null;
    if (!inWindow.length) return { tag: "measured", feed: [], caption: nothingInWindow(all, W) };
    const pages = byPage(all.filter(within(W))).length;
    return {
      tag: "measured",
      feed: inWindow.map(feedItem),
      caption: `Across ${pages} Page${pages === 1 ? "" : "s"} in this window. ${VIEWS_NOTE}`,
    };
  },

  /*
    ONE NETWORK'S FEED — Instagram, which on this account is the empty one.

    THE EMPTY STATE IS THE CARD. Instagram is not an API this box talks to: it
    is a FIELD on a Facebook Page, read with the same token in the same call,
    and every Page here answers that nothing is linked. That is a third state —
    not a missing credential, not a refused one — and the caption says which
    step changes it rather than leaving somebody to re-paste a token that
    works perfectly.
  */
  "social.instagram": ({ social: S, meta: M, window: W }: LiveInputs) => {
    if (!S?.posts) return null;
    const all = allPosts(S).filter((p) => p.platform === "instagram");
    const inWindow = all
      .filter(within(W))
      .slice()
      .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)))
      .slice(0, 5);
    if (inWindow.length)
      return {
        tag: "measured",
        feed: inWindow.map(feedItem),
        caption:
          "Instagram's `reach` counts unique ACCOUNTS where a Facebook view counts renders. The two are " +
          "never added, which is why this feed is its own card.",
      };
    const linked = S.posts.coverage.instagramLinked;
    const checked = M?.instagram.pagesChecked ?? S.posts.coverage.pagesMapped;
    return {
      tag: "measured",
      feed: [],
      caption:
        linked === null
          ? "The timelines have never been read, so no Page has been asked whether it has an Instagram account yet."
          : linked === 0
            ? `No Instagram Business account is linked to any of the ${checked} Page${checked === 1 ? "" : "s"} this box reads — every one was asked and every one answered no. That is not an audience of zero and not a broken token. Link one to a Page in Meta Business Suite → Settings → Instagram accounts, and the same credential reads it on the next collection.`
            : `${linked} Instagram account${linked === 1 ? " is" : "s are"} linked and ${nothingInWindow(all, W).toLowerCase()}`,
    };
  },

  /*
    ONE NETWORK'S FEED — Bluesky.

    THE POSTS ARE THE SAME PAGE OF THE AUTHOR FEED THE WINDOW TOTALS ARE
    COMPUTED FROM, kept rather than only counted (see the analytics area's
    migration 035). Every count on them is CURRENT and not earned-in-window,
    exactly as `bluesky.engagement` says of its own figures.
  */
  "social.bluesky": ({ social: S, bluesky: B, window: W }: LiveInputs) => {
    /*
      THE CARD ANSWERS EVEN WITH NO BLUESKY DOCUMENT, and it has to. The
      Bluesky plugin marks itself unconnected when no handle has been typed —
      which is the ordinary state here — so the fetch layer never asks and `B`
      is null. Returning null then would fall back to the catalog's sample
      caption, which claims nothing was collected from the POSTS source; the
      truth is narrower and more useful, so it is said. The board's own
      document is what makes this card live at all.
    */
    if (!S?.posts) return null;
    const days = W ?? 30;
    const rows = (B?.handles ?? [])
      .flatMap((h) => (h.posts ?? []).map((p) => ({ ...p, handle: h.handle })))
      .filter((p) => {
        if (days === "all") return true;
        const d = daysAgo(p.at);
        return d !== null && d <= days;
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 5);
    if (!rows.length)
      return {
        tag: "measured",
        feed: [],
        caption: B?.portfolio.handles
          ? `Nothing from ${B.portfolio.handles} watched handle${B.portfolio.handles === 1 ? "" : "s"} in this window.`
          : "No Bluesky handle is reaching this board. The public AppView needs no key and holds no credential — a list of handles under the Bluesky plugin IS the whole configuration, and with one the author feed is read on the next collection.",
      };
    return {
      tag: "measured",
      feed: rows.map((p) => ({
        title: `@${p.handle}`,
        at: postDay(p.at),
        text: p.text,
        image: p.image,
        href: p.url,
        meta: [
          ["likes", count(p.likes)],
          ["reposts", count(p.reposts)],
          ["replies", count(p.replies)],
        ] as [string, string][],
      })),
      caption:
        "Likes and reposts are what these posts carry NOW, not what they earned inside the window — an old " +
        "post gathering a new like moves them. One page of the author feed is read, so a busy handle's " +
        "window is a floor.",
    };
  },

  /*
    WHAT THIS BOX PUBLISHED, AND WHERE IT LANDED.

    THE ONLY PLACE A LINKEDIN OR TIKTOK URL EXISTS HERE. The timeline reader
    above reads Meta and nothing else, so a post sent to LinkedIn is invisible
    to it; the publishing area recorded the permalink the network handed back
    when it accepted the post, and this card is that record.

    NOTHING ON IT IS ADDED TO A TIMELINE FIGURE. A published item and the post
    it became are the same post seen from two ends, joined by Meta's own id.
  */
  "social.published": ({ social: S }: LiveInputs) => {
    const items = S?.publishing?.items ?? [];
    if (!S?.publishing) return null;
    const sent = items
      .filter((i) => i.status === "published")
      .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
      .slice(0, 5);
    if (!sent.length)
      return {
        tag: "measured",
        feed: [],
        caption:
          "Nothing has been published from this box yet. Everything on the feeds above was posted somewhere " +
          "else and read back — which is most posts, and is why the timeline reader exists.",
      };
    const withLink = sent.filter((i) => i.permalink).length;
    return {
      tag: "measured",
      feed: sent.map((i) => ({
        title: i.destination
          ? `${i.destination.label}${i.destination.handle ? ` · ${i.destination.handle}` : ""}`
          : "no destination",
        at: postDay(i.publishedAt),
        text: i.caption,
        image: i.media.url,
        href: i.permalink,
        meta: [
          ["venture", i.venture?.name ?? DASH],
          ["attempt", count(i.attempts)],
        ] as [string, string][],
        tone: "ok" as const,
      })),
      caption: `${withLink} of ${sent.length} carry the address the network handed back. Nothing here is added to the figures above: a published item and the post it became are one post seen from two ends.`,
    };
  },

  /*
    WHAT IS WAITING — the half of the loop no timeline can see.

    A draft, an approval and a schedule are work IN FLIGHT: they exist only on
    this box, they are the reason the feeds above will or will not have
    anything next week, and a board about publishing that showed only what has
    already gone out would be a board that can never warn anybody.

    A DRAFT WITH A PROBLEM IS THE ROW THAT MATTERS. It cannot be approved and
    therefore cannot be sent, and it will sit there silently for ever.
  */
  "social.queue": ({ social: S }: LiveInputs) => {
    const doc = S?.publishing;
    if (!doc) return null;
    const c = doc.counts;
    const blocked = doc.items.filter((i) => i.status === "draft" && i.problems.length > 0);
    const next = doc.items
      .filter((i) => i.status === "scheduled" && i.scheduledFor)
      .sort((a, b) => String(a.scheduledFor).localeCompare(String(b.scheduledFor)))[0];
    const rows: [string, string][] = [
      ["Drafts", count(c.draft)],
      ["Approved, not scheduled", count(c.approved)],
      ["Scheduled", next ? `${count(c.scheduled)} · next ${when(next.scheduledFor)}` : count(c.scheduled)],
      ["Published", count(c.published)],
    ];
    if (c.failed > 0) rows.push(["Failed", count(c.failed)]);
    if (blocked.length)
      rows.push([
        `${blocked.length} draft${blocked.length === 1 ? "" : "s"} cannot be approved`,
        blocked[0]!.problems[0]?.message ?? "a limit is not met",
      ]);
    return {
      tag: "measured",
      rows,
      caption:
        "Nothing is published that the owner did not approve first. A draft with a problem cannot be " +
        "approved and will wait indefinitely — which is why it is a row here rather than a count.",
    };
  },

  /*
    WHAT IS AND IS NOT BEING READ — the card that keeps the rest honest, the
    same shape `meta.cannot` has and for a different half of the same question.

    `meta.cannot` says what the TOKEN will not answer. This says what this box
    is even ASKING: only Pages the owner has mapped to a venture are read,
    because a token can administer Pages belonging to businesses this box has
    never heard of and reading those would be collecting somebody else's data.
    An unmapped Page is silence, and silence that is a choice must say so.
  */
  "social.coverage": ({ social: S, meta: M, bluesky: B }: LiveInputs) => {
    if (!S?.posts) return null;
    const accounts = S.posts.accounts;
    const failing = accounts.filter((a) => a.error ?? a.insightsError);
    const granted = M?.pages.length ?? null;
    const statuses: [string, StatusTone][] = [];
    statuses.push([
      `${S.posts.coverage.pagesMapped} Page${S.posts.coverage.pagesMapped === 1 ? "" : "s"} mapped to a venture and read${
        granted !== null && granted > S.posts.coverage.pagesMapped
          ? ` · ${granted - S.posts.coverage.pagesMapped} in the grant left alone`
          : ""
      }`,
      S.posts.coverage.pagesMapped > 0 ? "ok" : "warn",
    ]);
    statuses.push([
      S.posts.lastReadAt ? `Timelines last read ${ago(S.posts.lastReadAt)}` : "Timelines have never been read",
      S.posts.lastReadAt ? "ok" : "warn",
    ]);
    statuses.push([
      failing.length ? `${failing.length} Page read is failing` : "Every mapped Page answered",
      failing.length ? "bad" : "ok",
    ]);
    statuses.push([
      S.posts.coverage.instagramLinked === null
        ? "Instagram not yet asked"
        : S.posts.coverage.instagramLinked === 0
          ? "No Page has an Instagram Business account linked"
          : `${S.posts.coverage.instagramLinked} Instagram account${S.posts.coverage.instagramLinked === 1 ? "" : "s"} linked`,
      S.posts.coverage.instagramLinked ? "ok" : "warn",
    ]);
    statuses.push([
      B?.portfolio.handles
        ? `${B.portfolio.handles} Bluesky handle${B.portfolio.handles === 1 ? "" : "s"} watched`
        : "No Bluesky handle configured — a list of handles is the whole configuration",
      B?.portfolio.handles ? "ok" : "warn",
    ]);
    statuses.push(["Shares: no surviving metric reports them", "warn"]);
    return { tag: "measured", statuses };
  },

  /*
    ONE VENTURE'S POSTS.

    THE JOIN IS THE OWNER'S OWN AND NOT A GUESS. Workdash matches a Page to a
    project by testing the Page's NAME against a regular expression, and says
    so wherever it shows — a rename breaks it. This box has a better answer
    already: the publishing area's destination row carries the venture the
    owner TYPED, the timeline collector writes it onto every post it stores,
    and this card reads it. A Page named nothing like its business still lands
    on the right venture.

    So this is per-project by `param` rather than by host: the posts carry a
    venture id, not a hostname, and narrowing the document by the venture's
    domain would throw away the stronger join. See lib/scope.
  */
  "social.project": ({ social: S, project, window: W }: LiveInputs) => {
    if (!project || !S?.posts) return null;
    const own = allPosts(S).filter((p) => p.ventureId === project.id);
    const inWindow = own
      .filter(within(W))
      .slice()
      .sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)))
      .slice(0, 5);
    if (!own.length)
      return {
        tag: "measured",
        feed: [],
        caption: `No Page is mapped to ${project.name} under Publishing, so nothing is read for it. The mapping is the owner's own — a Page is never matched to a venture by its name.`,
      };
    if (!inWindow.length) return { tag: "measured", feed: [], caption: nothingInWindow(own, W) };
    return {
      tag: "measured",
      feed: inWindow.map(feedItem),
      caption: `${own.filter(within(W)).length} post${own.filter(within(W)).length === 1 ? "" : "s"} published in this window · joined to ${project.name} by the mapping the owner typed, not by matching a Page name. ${VIEWS_NOTE}`,
    };
  },

  /*
    ONE VENTURE'S FIGURES, in the shape Workdash's per-account page opens with:
    the tiles, then what landed, in one card rather than a page.
  */
  "social.projectStats": ({ social: S, meta: M, project, window: W }: LiveInputs) => {
    if (!project || !S?.posts) return null;
    const own = allPosts(S).filter((p) => p.ventureId === project.id);
    if (!own.length) return null;
    const pageIds = new Set(own.map((p) => p.pageId));
    const followers = (M?.pages ?? [])
      .filter((p) => pageIds.has(p.id))
      .map((p) => p.followers)
      .filter((n): n is number => n !== null);
    const t = totals(own.filter(within(W)));
    const all = totals(own);
    const quiet = daysAgo(all.latest);
    const best = own
      .filter(within(W))
      .filter((p) => (postViews(p) ?? 0) > 0)
      .sort((a, b) => (postViews(b) ?? 0) - (postViews(a) ?? 0))
      .slice(0, 3);
    return {
      tag: "measured",
      figures: [
        {
          label: "Followers now",
          value: followers.length ? count(followers.reduce((n, v) => n + v, 0)) : DASH,
          sub: `${pageIds.size} Page${pageIds.size === 1 ? "" : "s"}`,
        },
        { label: "Posts", value: count(t.posts), sub: windowLabel(W ?? 30) },
        { label: "Views", value: count(t.views), sub: `${count(t.measured)} measured` },
        {
          label: "Last post",
          value: quiet === null ? DASH : quiet === 0 ? "today" : `${quiet}d ago`,
          sub: "any age",
        },
      ],
      rows: best.length
        ? best.map(
            (p) =>
              [
                `${postDay(p.createdTime)} · ${(p.text ?? "no text").replace(/\s+/g, " ").slice(0, 44)}`,
                `${count(postViews(p))} views`,
              ] as [string, string],
          )
        /* "Nothing measured" would be wrong: a post Meta measured at zero
           views WAS measured. What there is not, is a post anybody saw. */
        : [[t.measured ? "No post here drew a view in this window" : "Nothing measured in this window", DASH]],
      caption: `${VIEWS_NOTE} ${FLOOR_NOTE} Followers have no history and do not follow the window.`,
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);


/* ==========================================================================
   ADS BOARD PARITY (Workdash /ads) — workstream "ads-board", 2026-09-08.

   THE THREE DOCUMENTS THESE READ ARE NOT /api/meta. `meta` publishes what Meta
   SAID; `ads` carries what this box worked out from those same rows — the
   health rubric, the advertisements with their creatives, and the campaign →
   venture map. See lib/api/adsboard.

   FOUR RULES EVERY BUILDER BELOW KEEPS, and each is a way to draw a confident
   figure that is wrong:

     ONE CURRENCY OR NO FIGURE. Every money card runs through `oneCurrency`
     and refuses rather than adds two accounts billing in two currencies.

     REACH AND FREQUENCY ARE NEVER SUMMED AND NEVER AVERAGED. They appear only
     as Meta's own answer for a window Meta was asked about, with the dates.

     A WINDOW FIGURE IS THE SPAN META MEASURED, not the span the picker asked
     for. Meta's account window ends on its last complete day and the ad-level
     rows only exist for days that delivered, so every card here says the days
     it actually has.

     NO RETURN ON AD SPEND. Nothing joins a euro of income to a click, and the
     one card that carries the word says why there is no number — see
     `meta.roas`, which stays on the board for exactly that reason.
   ========================================================================== */

/** The band a score out of a hundred falls in, and the word for it. The
 *  server grades A–F; the board says it in the language the rest of this
 *  dashboard judges things in, so a colour never has to travel alone. */
function adBand(score: number | null): { word: string; tone: StatusTone } | null {
  if (score === null) return null;
  if (score >= 75) return { word: "good", tone: "ok" };
  if (score >= 60) return { word: "fair", tone: "warn" };
  return { word: "poor", tone: "bad" };
}

/** The health reading this board draws. ONE ACCOUNT, NEVER A BLEND: each
 *  account's rubric is scored against its own history and two scores share a
 *  scale and nothing else, so the busiest account is named and the rest are
 *  counted rather than averaged in. */
function oneHealth(A: AdsBoardDocs | null | undefined) {
  const accounts = A?.health?.accounts ?? [];
  if (!accounts.length) return null;
  const ranked = [...accounts].sort((a, b) => (b.account.spend ?? 0) - (a.account.spend ?? 0));
  return { health: ranked[0]!, others: ranked.length - 1 };
}

/** Money at the precision the figure deserves. A cost per click of €0.0119
 *  rounded to two places is €0.01, which is 16% smaller than the number. */
const adMoney = (n: number | null, currency: string) =>
  n === null ? DASH : inCurrency(n, currency, Math.abs(n) < 1 ? 4 : 2);

/** An advertisement's name for a card: the headline people read, then the
 *  creative's name, then the ad's own. Meta's ad names are administrative
 *  ("Promoting website: https://…") and the headline is what ran. */
const adLabel = (ad: AdRow) => ad.title ?? ad.name ?? ad.creativeName ?? ad.adId;

/** effective_status in the words a person reads. "CAMPAIGN_PAUSED" and
 *  "PAUSED" are the same fact to somebody looking at a row. */
const adStatusWord = (s: string | null) =>
  (s ?? "—").replace(/^(CAMPAIGN|ADSET)_/, "").toLowerCase().replaceAll("_", " ");

/**
 * WHICH VENTURE EACH CAMPAIGN IS FOR, filed rows first and suggestions after.
 *
 * A SUGGESTION IS NOT A LINK and the difference is on every row that uses this:
 * a link is something the owner pressed and a suggestion is arithmetic over a
 * URL in a campaign's own name, recomputed on every read. Both are shown,
 * because a board that drew only the filed ones would report a portfolio's ad
 * spend as mostly unattributed while the answer sat one press away — and a
 * board that drew them alike would let a guess harden into a fact.
 *
 * A CONTESTED CAMPAIGN IS LEFT OUT of the suggestions half: it matched two
 * ventures and nothing may pick one for it.
 */
function campaignVentureMap(A: AdsBoardDocs | null | undefined) {
  const map = new Map<string, { id: string; name: string | null; filed: boolean; evidence: string | null }>();
  for (const s of A?.map?.suggestions ?? []) {
    if (A?.map?.contested.includes(s.campaignId)) continue;
    map.set(s.campaignId, { id: s.venture.id, name: s.venture.name, filed: false, evidence: s.evidence });
  }
  for (const l of A?.map?.links ?? [])
    map.set(l.campaignId, { id: l.venture.id, name: l.venture.name, filed: true, evidence: l.evidence });
  return map;
}

Object.assign(LIVE_BUILDERS, {
  /* ---------------------------------------- the account, over the window */

  "meta.clicks": ({ meta: M }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    const rows = (one?.accounts ?? []).filter((a) => a.window?.clicks != null);
    if (!rows.length) return null;
    const clicks = rows.reduce((n, a) => n + (a.window!.clicks ?? 0), 0);
    const impressions = rows.reduce((n, a) => n + (a.window!.impressions ?? 0), 0);
    const w = rows[0]!.window!;
    /* Meta's own rate for a single account; a clicks-over-impressions division
       when several have to be pooled — which is the right weighting and is
       still our arithmetic rather than Meta's, so the caption says whose. */
    const ctr = rows.length === 1 ? w.ctr : impressions ? (100 * clicks) / impressions : null;
    return {
      tag: "metered",
      value: count(clicks),
      sub: also(
        ctr === null ? "" : `${percent(ctr, 2)} click-through${rows.length > 1 ? ", divided here" : ""}`,
        windowSpan(w.from, w.to),
      ),
    };
  },

  "meta.cpc": ({ meta: M }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    const rows = (one?.accounts ?? []).filter((a) => a.window);
    if (!one || !rows.length) return null;
    const clicks = rows.reduce((n, a) => n + (a.window!.clicks ?? 0), 0);
    const spend = rows.reduce((n, a) => n + (a.window!.spend ?? 0), 0);
    const own = rows.length === 1 ? rows[0]!.window!.cpc : null;
    const cpc = own ?? (clicks ? spend / clicks : null);
    if (cpc === null) return null;
    const w = rows[0]!.window!;
    return {
      tag: "metered",
      value: adMoney(cpc, one.currency),
      sub: also(
        own === null ? "spend over clicks, divided here" : "the account's own average, Meta's figure",
        windowSpan(w.from, w.to),
      ),
    };
  },

  "ads.delivering": ({ ads: A }: LiveInputs) => {
    const C = A?.creatives;
    if (!C) return null;
    const delivered = C.ads.filter((a) => a.window.days > 0);
    const live = C.ads.filter((a) => a.status === "ACTIVE");
    return {
      /* NO TAG. "measured" beside a name and its window overflows a
         one-column tile, and the two lines under the figure already say
         exactly what was counted and out of what. */
      value: count(delivered.length),
      sub: also(
        `of ${count(C.ads.length)} advertisement${C.ads.length === 1 ? "" : "s"} in the account`,
        /* Delivering and ELIGIBLE are different states and the gap is the
           finding: an advertisement Meta will run that has been shown to
           nobody is not the same as one somebody paused. */
        live.length
          ? `${count(live.length)} eligible to deliver`
          : "none is eligible to deliver — every parent is paused",
      ),
    };
  },

  /* --------------------------------------------------- is the spend working */

  /*
    THE SCORE, AND EVERYTHING A SCORE ALONE WOULD HIDE.

    Three of these figures exist because the number cannot tell two different
    accounts apart on its own. COVERAGE, because a 100 drawn from 40% of the
    check weight and a 100 drawn from 95% of it are different claims. THE
    REFUSAL, in place of a score, when too little of the account could be
    measured to put a number on it. THE TARGET COST PER LEAD, because a reader
    who does not know what every verdict was measured against cannot check one.

    Nothing here does arithmetic on the score. It is computed on this box by
    `growth/ads.ts`, which prints its own working, so the figure on this card,
    the figure on the Growth page and the figure a skill quotes cannot drift.
  */
  "ads.health": ({ ads: A }: LiveInputs) => {
    const one = oneHealth(A);
    if (!one) return null;
    const h = one.health;
    const cur = h.account.currency ?? "EUR";
    const band = adBand(h.score);
    const critical = h.failing.filter((f) => f.severity === "critical").length;
    const rows: [string, string][] = [];
    if (h.refusal) rows.push(["No score", h.refusal]);
    rows.push(["Target came from", h.target.costPerLead === null ? "nothing — no lead has been costed" : "this account's own cost per lead, never a benchmark"]);
    rows.push(["Kill table", `${h.killTable.minDays} days of delivery and ${h.killTable.minClicks} clicks before any verdict`]);
    rows.push(["Not a Meta figure", "this box's own rubric; the arithmetic is printed on the Growth page"]);
    if (one.others > 0)
      rows.push([`${one.others} other ad account${one.others === 1 ? "" : "s"}`, "scored separately — two scores share a scale and nothing else"]);
    return {
      tag: "rubric",
      name: `Account health · ${h.account.name ?? h.account.id}`,
      figures: [
        {
          label: "Score",
          value: h.score === null ? DASH : String(h.score),
          sub: h.grade ? `grade ${h.grade}${band ? ` · ${band.word}` : ""}` : "refused",
        },
        {
          label: "Coverage",
          value: percent(h.coverage * 100, 0),
          sub: "of the check weight",
        },
        {
          label: "Failing",
          value: count(h.failing.length),
          sub: critical ? `${count(critical)} critical` : "none critical",
        },
        {
          label: "Target cost per lead",
          value: h.account.costPerLead === null ? DASH : adMoney(h.account.costPerLead, cur),
          sub: "the account's own",
        },
      ],
      rows,
      caption:
        "A check that could not be evaluated is out of both sides of the division — never counted as a failure.",
    };
  },

  /*
    THE CATEGORIES, AGAINST A FIXED AXIS OF A HUNDRED.

    `rankedMax: 100` and not the biggest bar: these are scores out of a
    hundred, so a length has to mean "how much of the available credit was
    earned" rather than "how does this compare with the best row here".
    Relative scaling would draw an account failing every category as four full
    bars.

    A CATEGORY THAT COULD NOT BE SCORED IS A REASON, NOT A ZERO. It sits at the
    bottom with an empty bar and its own sentence, because a refused subscore
    and a subscore of nought are opposite findings.
  */
  "ads.categories": ({ ads: A }: LiveInputs) => {
    const one = oneHealth(A);
    if (!one) return null;
    const cats = Object.entries(one.health.categories);
    if (!cats.length) return null;
    const rows = cats
      .sort((a, b) => (b[1].score ?? -1) - (a[1].score ?? -1))
      .map(([name, c]) => {
        const band = adBand(c.score);
        return {
          label: name[0]!.toUpperCase() + name.slice(1),
          value: c.score ?? 0,
          text: c.score === null ? DASH : String(c.score),
          sub: also(band ? band.word : "not scored", `weight ${c.weight} · ${percent(c.coverage * 100, 0)} evaluated`),
        };
      });
    return {
      tag: "rubric",
      ranked: rows,
      rankedMax: 100,
      caption:
        "each out of 100 against a fixed axis, so a short bar is a low score rather than a small one · a category under the 40% coverage floor is refused and draws its reason instead",
    };
  },

  /*
    THE QUICK WINS — a real problem with a small fix, and both halves are
    measured. `high` severity or worse, and a remediation the rubric puts under
    a quarter of an hour. COMPUTED ON THE SERVER out of the failing list rather
    than curated here, so a check whose fix gets cheaper joins the list the
    next time the account is scored and nobody has to remember to move it.
  */
  "ads.quickWins": ({ ads: A }: LiveInputs) => {
    const one = oneHealth(A);
    if (!one) return null;
    const h = one.health;
    if (!h.quickWins.length)
      return {
        tag: "rubric",
        table: [],
        caption: h.failing.length
          ? `Nothing quick: none of the ${count(h.failing.length)} failing checks is ${h.quickWin.severity} or worse with a fix under ${h.quickWin.minutes} minutes.`
          : "Nothing is failing on this account, so there is nothing quick to win.",
      };
    return {
      tag: "rubric",
      headers: ["Quick win", "Severity", "Fix takes", "What to do"],
      table: h.quickWins.map((q) => [q.title, q.severity, `${q.minutes} min`, q.fix]),
      rowTones: h.quickWins.map((q): StatusTone => (q.result === "fail" ? "bad" : "warn")),
      caption: `${h.quickWin.severity} or worse, under ${h.quickWin.minutes} minutes each · the minutes are the rubric's estimate of the fix, not a measurement`,
    };
  },

  "ads.failing": ({ ads: A }: LiveInputs) => {
    const one = oneHealth(A);
    if (!one) return null;
    const h = one.health;
    if (!h.failing.length)
      return {
        tag: "rubric",
        table: [],
        caption: `Nothing failed. ${count(h.checks.filter((c) => c.result === null).length)} of ${count(h.checks.length)} checks could not be evaluated at all, which is not the same as passing.`,
      };
    return {
      tag: "rubric",
      headers: ["Check", "Result", "Severity", "Fix takes", "What it found"],
      table: h.failing.map((f) => [
        f.title,
        f.result ?? DASH,
        f.severity,
        `${f.minutes} min`,
        /* Clipped rather than wrapped: the detail names every campaign it
           found and one of them runs past three hundred characters. The whole
           sentence is on the Growth page, where the card is a page. */
        f.detail.length > 84 ? `${f.detail.slice(0, 83).replace(/[\s,.;:-]+$/, "")}…` : f.detail,
      ]),
      rowTones: h.failing.map((f): StatusTone => (f.result === "fail" ? "bad" : "warn")),
      caption: "worst first, a failure before a warning at the same severity — the order somebody fixing things works in",
    };
  },

  "ads.categoryTable": ({ ads: A }: LiveInputs) => {
    const one = oneHealth(A);
    if (!one) return null;
    const cats = Object.entries(one.health.categories);
    if (!cats.length) return null;
    return {
      tag: "rubric",
      headers: ["Category", "Score", "Band", "Weight", "Evaluated", "Why there is no score"],
      table: cats.map(([name, c]) => [
        name[0]!.toUpperCase() + name.slice(1),
        c.score === null ? DASH : String(c.score),
        adBand(c.score)?.word ?? "not scored",
        String(c.weight),
        percent(c.coverage * 100, 0),
        c.reason ?? DASH,
      ]),
      caption: `the score is the weighted mean of the categories that could be scored — a refused one is out of both sides of that division · ${one.health.coverage < 1 ? `${percent(one.health.coverage * 100, 0)} of the whole check weight was evaluated` : "every check was evaluated"}`,
    };
  },

  /* ------------------------------------------------ what it bought, by venture */

  /*
    AD SPEND PER VENTURE, THROUGH A JOIN THAT IS NAMED ON THE CARD.

    Meta ties nothing to a business. What it gives us is a campaign called
    "[8/4/2026] Promoting https://freellmapi.co/…", and the map behind this
    card reads the host out of that name. So a row here is as good as the
    campaign naming was, and a rename at Meta empties a venture rather than
    quietly moving its money — which is the right way for it to fail.

    THE UNMAPPED ROW IS DRAWN, NOT HIDDEN. Spend that matched no venture is the
    largest single row on this account, and a card that left it out would
    report a portfolio's advertising as fully attributed.
  */
  "ads.ventures": ({ ads: A, meta: M }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    if (!one) return null;
    const map = campaignVentureMap(A);
    const campaigns = one.accounts.flatMap((a) => a.campaigns).filter((c) => (c.window?.spend ?? 0) > 0);
    if (!campaigns.length) return null;
    const buckets = new Map<string, { name: string; spend: number; clicks: number; campaigns: number; filed: number }>();
    for (const c of campaigns) {
      const v = map.get(c.id);
      const key = v?.id ?? "";
      const row = buckets.get(key) ?? {
        name: v?.name ?? "Not filed to a venture",
        spend: 0,
        clicks: 0,
        campaigns: 0,
        filed: 0,
      };
      row.spend += c.window?.spend ?? 0;
      row.clicks += c.window?.clicks ?? 0;
      row.campaigns += 1;
      row.filed += v?.filed ? 1 : 0;
      buckets.set(key, row);
    }
    const rows = [...buckets.entries()].sort((a, b) => b[1].spend - a[1].spend);
    return {
      tag: "metered",
      ranked: rows.map(([key, r]) => ({
        label: r.name,
        value: r.spend,
        text: inCurrency(r.spend, one.currency),
        sub: also(
          `${count(r.campaigns)} campaign${r.campaigns === 1 ? "" : "s"} · ${count(r.clicks)} clicks`,
          key === ""
            ? "no host matched"
            : r.filed === r.campaigns
              ? "filed"
              : `${count(r.filed)} filed, ${count(r.campaigns - r.filed)} suggested`,
        ),
      })),
      caption:
        "spend is joined to a business by CAMPAIGN, and a campaign is matched by the host in its own name · a suggestion is not a link and nothing is filed until somebody presses it, on the venture's page",
    };
  },

  "ads.venture": ({ ads: A, meta: M, project }: LiveInputs) => {
    if (!project || !M) return null;
    const one = oneCurrency(M);
    if (!one) return null;
    const map = campaignVentureMap(A);
    const mine = one.accounts
      .flatMap((a) => a.campaigns)
      .filter((c) => map.get(c.id)?.id === project.id);
    if (!mine.length)
      return {
        figures: [
          { label: "Ad spend", value: DASH },
          { label: "Clicks", value: DASH },
          { label: "Campaigns", value: "0" },
          { label: "Per click", value: DASH },
        ],
        rows: [
          ["No campaign names this venture", "campaigns are matched by the host in their own name"],
          ["Which is a finding either way", "nothing is running for it, or a campaign was renamed and the match broke"],
        ] as [string, string][],
        caption: "this card will not guess: an empty venture invites the question, a card showing somebody else's spend does not",
      };
    const spend = mine.reduce((n, c) => n + (c.window?.spend ?? 0), 0);
    const clicks = mine.reduce((n, c) => n + (c.window?.clicks ?? 0), 0);
    const impressions = mine.reduce((n, c) => n + (c.window?.impressions ?? 0), 0);
    /* Leads add where reach does not: a lead is one form submission and two
       campaigns cannot submit the same one. Null stays null. */
    const counted = mine.filter((c) => c.window?.leads !== null && c.window?.leads !== undefined);
    const leads = counted.length ? counted.reduce((n, c) => n + (c.window!.leads ?? 0), 0) : null;
    const w = mine[0]!.window;
    const filed = mine.filter((c) => map.get(c.id)?.filed).length;
    return {
      tag: "metered",
      figures: [
        { label: "Ad spend", value: inCurrency(spend, one.currency), sub: windowSpan(w?.from, w?.to) },
        { label: "Clicks", value: count(clicks), sub: impressions ? `${percent((100 * clicks) / impressions, 2)} of ${count(impressions)} impressions` : "no impressions reported" },
        { label: "Leads", value: leads === null ? DASH : count(leads), sub: leads ? adMoney(spend / leads, one.currency) + " each" : "the only conversion this account buys" },
        { label: "Per click", value: clicks ? adMoney(spend / clicks, one.currency) : DASH, sub: "divided here" },
      ],
      rows: [
        ...mine
          .slice(0, 5)
          .map((c): [string, string] => [
            campaignName(c.name),
            also(inCurrency(c.window?.spend ?? 0, one.currency), adStatusWord(c.status)),
          ]),
        [
          "How they were matched",
          filed === mine.length ? "all filed by hand or accepted" : `${count(filed)} filed, ${count(mine.length - filed)} suggested by name`,
        ],
      ] as [string, string][],
      caption:
        "REACH IS ABSENT ON PURPOSE: it is de-duplicated per campaign and summing it here would count the same person once per campaign they were in. There is no return on ad spend either — nothing joins a euro of this venture's income to a click.",
    };
  },

  "ads.mapping": ({ ads: A, meta: M }: LiveInputs) => {
    if (!M) return null;
    const map = campaignVentureMap(A);
    const contested = new Set(A?.map?.contested ?? []);
    const campaigns = M.adAccounts
      .filter((a) => a.active)
      .flatMap((a) => a.campaigns)
      .sort((a, b) => (b.window?.spend ?? 0) - (a.window?.spend ?? 0));
    if (!campaigns.length) return null;
    const spending = campaigns.filter((c) => (c.window?.spend ?? 0) > 0);
    const shown = (spending.length ? spending : campaigns).slice(0, 10);
    return {
      headers: ["Campaign", "Venture", "How", "Why"],
      table: shown.map((c) => {
        const v = map.get(c.id);
        return [
          campaignName(c.name),
          v?.name ?? DASH,
          contested.has(c.id) ? "contested" : v ? (v.filed ? "filed" : "suggested") : "nothing matched",
          contested.has(c.id)
            ? "matched more than one venture, so nothing is applied"
            : (v?.evidence ?? "no host in this campaign's name matches a venture"),
        ];
      }),
      rowTones: shown.map((c): StatusTone | null =>
        contested.has(c.id) ? "warn" : map.get(c.id)?.filed ? "ok" : null,
      ),
      caption:
        "a SUGGESTION is recomputed on every read and files nothing; a LINK is a row somebody wrote, and it keeps the sentence that produced it. Accept one on the venture's page.",
    };
  },

  /* ------------------------------------------- what ran: the advertisements */

  /*
    THE CREATIVES. THE REASON THIS BOARD EXISTS.

    Everything above this card is a number about an advertisement; this is the
    advertisement. You cannot decide what to change from a row of figures about
    a thing you cannot look at, which is the whole argument for the `feed` kind
    and for putting it above the campaign tables rather than under them.

    THE PICTURE IS A CHAIN AND NOT A SINGLE TRY. Meta signs `image_url` and
    `thumbnail_url` independently and they expire independently — in this
    account the lead-generation ads' full-size urls 403 while their 64px
    thumbnails load — so the builder hands over the full image with the thumb
    behind it and the card hides a frame that fails rather than drawing it
    broken. A broken frame reads as "this advertisement had no picture", which
    is a claim about the advertisement.

    THE CHEAPEST AND DEAREST CLICK ARE NAMED. In this account the spread runs
    twenty-fold on one budget, and the two ends are the only rows with a
    decision on them today. The word is in the label as well as the tone,
    because the status palette never travels alone.

    THE LINK IS THE DESTINATION, NOT A PERMALINK. Meta publishes no address for
    an advertisement; what an ad has is the page it sent people to, and the
    figure strip says which.
  */
  "ads.creatives": ({ ads: A, meta: M }: LiveInputs) => {
    const C = A?.creatives;
    if (!C) return null;
    const currency = M ? (oneCurrency(M)?.currency ?? null) : null;
    const cur = currency ?? C.adSets.find((s) => s.currency)?.currency ?? null;
    const delivered = C.ads
      .filter((a) => a.window.days > 0)
      .sort((a, b) => (b.window.spend ?? 0) - (a.window.spend ?? 0));
    const idle = C.ads.length - delivered.length;
    if (!delivered.length)
      return {
        feed: [],
        caption: `No advertisement delivered in the last ${C.windowDays} days. ${count(C.ads.length)} are in the account and ${count(C.ads.filter((a) => a.status === "ACTIVE").length)} are eligible to run.`,
      };
    const priced = delivered.filter((a) => a.window.cpc !== null);
    const sorted = [...priced].sort((a, b) => (a.window.cpc ?? 0) - (b.window.cpc ?? 0));
    const best = sorted.length > 1 ? sorted[0] : null;
    const worst = sorted.length > 1 ? sorted.at(-1) : null;
    return {
      tag: "metered",
      feed: delivered.map((ad) => {
        const w = ad.window;
        const extreme = best && ad.adId === best.adId ? " · cheapest" : worst && ad.adId === worst.adId ? " · dearest" : "";
        const figures: [string, string][] = [];
        if (w.spend !== null && cur) figures.push(["spent", inCurrency(w.spend, cur)]);
        figures.push(["clicks", count(w.clicks)]);
        if (w.cpc !== null && cur) figures.push([`per click${extreme}`, adMoney(w.cpc, cur)]);
        if (w.ctr !== null) figures.push(["click-through", percent(w.ctr, 2)]);
        figures.push(["impressions", count(w.impressions)]);
        if (w.leads) figures.push(["leads", count(w.leads)]);
        figures.push([`day${w.days === 1 ? "" : "s"} delivered`, count(w.days)]);
        if (ad.callToAction) figures.push(["button", ad.callToAction.replaceAll("_", " ").toLowerCase()]);
        figures.push(["status", adStatusWord(ad.status)]);
        /* WHEN IT LAST RAN, as a figure rather than as the row's timestamp:
           the date in the corner is when the advertisement was MADE, and a
           card that put "last delivered" there would date every creative to
           the day the account stopped spending. */
        if (w.lastDay) figures.push(["last delivered", dayShort(w.lastDay)]);
        if (ad.venture?.name) figures.push(["", `for ${ad.venture.name}`]);
        return {
          title: adLabel(ad),
          text: ad.body ?? undefined,
          image: ad.imageUrl ?? ad.thumbUrl ?? undefined,
          href: ad.link ?? undefined,
          at: ad.createdTime ?? undefined,
          meta: figures,
          tone:
            best && ad.adId === best.adId
              ? ("ok" as StatusTone)
              : worst && ad.adId === worst.adId
                ? ("bad" as StatusTone)
                : undefined,
        };
      }),
      caption: also(
        also(
          `${count(delivered.length)} delivered over the last ${C.windowDays} days${idle ? `; ${count(idle)} more ran nothing` : ""}`,
          "the link is where the advertisement SENT people — Meta publishes no permalink to an advertisement",
        ),
        "creative images are signed and expire within days; a frame that fails is hidden rather than drawn broken",
      ),
    };
  },

  "ads.cpc": ({ ads: A, meta: M }: LiveInputs) => {
    const C = A?.creatives;
    if (!C) return null;
    const cur = (M ? oneCurrency(M)?.currency : null) ?? C.adSets.find((s) => s.currency)?.currency;
    if (!cur) return null;
    const delivered = C.ads.filter((a) => a.window.days > 0);
    const priced = delivered
      .filter((a) => a.window.cpc !== null)
      .sort((a, b) => (b.window.cpc ?? 0) - (a.window.cpc ?? 0));
    if (priced.length < 2) return null;
    return {
      tag: "metered",
      ranked: priced.map((ad) => ({
        label: adLabel(ad),
        value: ad.window.cpc!,
        text: adMoney(ad.window.cpc, cur),
        sub: `${count(ad.window.clicks)} clicks · ${inCurrency(ad.window.spend ?? 0, cur)}`,
      })),
      caption: `dearest first — the long bars are where the money goes furthest from a click · ${count(priced.length)} of ${count(delivered.length)} delivering advertisements carry a priced click, and one whose clicks carry no price is left out rather than drawn at zero`,
    };
  },

  "ads.table": ({ ads: A, meta: M }: LiveInputs) => {
    const C = A?.creatives;
    if (!C) return null;
    const cur = (M ? oneCurrency(M)?.currency : null) ?? C.adSets.find((s) => s.currency)?.currency;
    if (!cur) return null;
    const delivered = C.ads
      .filter((a) => a.window.days > 0)
      .sort((a, b) => (b.window.spend ?? 0) - (a.window.spend ?? 0));
    if (!delivered.length)
      return { table: [], caption: `No advertisement delivered in the last ${C.windowDays} days.` };
    return {
      tag: "metered",
      headers: ["Advertisement", "Spend", "Clicks", "Per click", "CTR", "CPM", "Impressions", "Leads", "Days"],
      table: delivered.map((ad) => {
        const w = ad.window;
        return [
          adLabel(ad),
          w.spend === null ? DASH : inCurrency(w.spend, cur),
          count(w.clicks),
          adMoney(w.cpc, cur),
          w.ctr === null ? DASH : percent(w.ctr, 2),
          adMoney(w.cpm, cur),
          count(w.impressions),
          w.leads === null ? DASH : count(w.leads),
          `${count(w.days)}`,
        ];
      }),
      caption:
        "summed from each advertisement's own daily rows · REACH AND FREQUENCY ARE NOT COLUMNS HERE: both are de-duplicated over the window Meta was asked about and neither can be recovered from daily rows. The ad-level read is capped and does not page, so every figure is a floor.",
    };
  },

  /*
    FATIGUE IS ONE SHAPE AND ONLY ONE: frequency RISING while click-through
    FALLS, over two matched weeks Meta answered as two separate questions. A
    rising frequency alone is a small audience; a falling click-through alone is
    an auction or a season. Only the two together say the same people are seeing
    the same picture and have stopped responding to it.

    "NO VERDICT" IS THE ANSWER, NOT A GAP. Under the impressions floor in either
    week there is no verdict — not a cautious one, none — and the card prints
    the reason rather than a quiet "steady".
  */
  "ads.fatigue": ({ ads: A }: LiveInputs) => {
    const C = A?.creatives;
    if (!C) return null;
    const rows: [string, string][] = [];
    const named = (verdict: string) =>
      C.ads
        .filter((a) => a.verdict === verdict)
        .slice(0, 3)
        .map((a) => adLabel(a))
        .join(", ");
    rows.push([
      "Fatigued",
      C.counts.fatigued
        ? `${count(C.counts.fatigued)} — ${named("fatigued")}`
        : "none — no advertisement shows both halves of the shape",
    ]);
    rows.push([
      "Tiring",
      C.counts.tiring ? `${count(C.counts.tiring)} — ${named("tiring")}` : "none — one more week would decide it",
    ]);
    rows.push(["Steady", C.counts.steady ? count(C.counts.steady) : "none with enough delivery to say"]);
    const none = C.counts["no-verdict"] ?? 0;
    /* THE VALUES STAY SHORT. A rows card truncates the LABEL when the value
       is long, so a full sentence on the right turns "No verdict" into "N…" —
       the reason belongs in the caption, where it has the width. */
    rows.push(["No verdict", none ? `${count(none)} of ${count(C.ads.length)}` : "none — every advertisement could be judged"]);
    rows.push(["The two weeks", `${C.compareDays}d against the ${C.compareDays}d before`]);
    rows.push(["The floor", `${count(C.minImpressions)} impressions in both`]);
    return {
      tag: "rubric",
      rows,
      caption: also(
        "fatigue is ONE shape — frequency rising while click-through falls, over two weeks Meta answered separately. A rising frequency alone is a small audience; a falling click-through alone is an auction.",
        none
          ? (C.ads.find((a) => a.verdict === "no-verdict")?.why ??
            "under the impressions floor in one of the two weeks there is no verdict — not a cautious one, none")
          : "",
      ),
    };
  },

  "ads.issues": ({ ads: A }: LiveInputs) => {
    const C = A?.creatives;
    if (!C) return null;
    const mismatched = C.statuses.filter((s) => s.mismatched);
    const flagged = C.statuses.filter((s) => s.issues.length);
    const statuses: [string, StatusTone][] = [
      [
        flagged.length
          ? `${count(flagged.length)} carry an issue Meta reported`
          : "no advertisement carries an issue Meta reported",
        flagged.length ? "bad" : "ok",
      ],
      [
        mismatched.length
          ? `${count(mismatched.length)} are configured ACTIVE and are not delivering`
          : "every advertisement configured ACTIVE is delivering",
        mismatched.length ? "warn" : "ok",
      ],
      [
        /* NOT A CLEAN BILL. Meta reports the issues it chooses to, so silence
           is silence — this line is here so nobody reads the green dot above
           as an audit. */
        "an advertisement with no issue is not an advertisement in good standing",
        "ok",
      ],
    ];
    /* ONE ROW PER NAME. This account has six advertisements called "Ongoing
       lead generation ad", and three identical warn lines read as a rendering
       fault rather than as six copies of one ad. */
    const named = new Map<string, number>();
    for (const s of mismatched) {
      const key = `${s.name ?? s.adId} · ${adStatusWord(s.status)}`;
      named.set(key, (named.get(key) ?? 0) + 1);
    }
    for (const [key, n] of [...named.entries()].slice(0, 3))
      statuses.push([n > 1 ? `${key} · ${count(n)} of them` : key, "warn"]);
    return { tag: "measured", statuses };
  },

  "ads.sets": ({ ads: A }: LiveInputs) => {
    const C = A?.creatives;
    if (!C?.adSets.length) return null;
    const sets = [...C.adSets].sort((a, b) => (b.dailyBudgetMinor ?? 0) - (a.dailyBudgetMinor ?? 0));
    return {
      headers: ["Ad set", "Status", "Optimising for", "Budget", "Bid strategy", "Ads"],
      table: sets.map((s) => {
        /* MINOR UNITS, DIVIDED HERE AND SAID SO. Meta sends a budget as a
           quoted string of cents; the caption carries the division rather than
           a card quietly rendering 500 as five euro with no working.

           ONE COLUMN AND NOT TWO. An ad set carries a daily budget or a
           lifetime one, never both, so a second column is empty on every row
           and pushes the ad count off the card — the word says which kind
           this figure is. */
        const budget = (v: number | null) =>
          v === null || v === 0 || !s.currency ? null : inCurrency(v / 100, s.currency);
        const daily = budget(s.dailyBudgetMinor);
        const lifetime = budget(s.lifetimeBudgetMinor);
        return [
          s.name ?? s.adsetId,
          adStatusWord(s.status),
          (s.optimizationGoal ?? DASH).replaceAll("_", " ").toLowerCase(),
          daily ? `${daily} a day` : lifetime ? `${lifetime} lifetime` : DASH,
          (s.bidStrategy ?? DASH).replaceAll("_", " ").toLowerCase(),
          count(s.ads),
        ];
      }),
      caption:
        "budgets arrive from Meta in MINOR UNITS of the account's own currency and are divided by a hundred here · an ad set id does not establish a learning state and does not establish audience overlap: neither the delivery-insights call nor the targeting specification is read by this box",
    };
  },

  /* ------------------------------------------------- the accounting view */

  /*
    CAMPAIGNS BY SPEND, EACH WITH ITS OWN SHAPE.

    THE BAR AND THE LINE COME FROM DIFFERENT GRAINS AND THE CAPTION SAYS SO.
    The bar is the campaign's window spend from the account-level read, which
    is authoritative; the line is the same campaign's ad-level daily rows,
    which are capped and do not page. So the line is a SHAPE — when the money
    went out — and never a total, and the two are not read as one figure.
  */
  "ads.campaignTrend": ({ ads: A, meta: M }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    if (!one) return null;
    const spending = one.accounts
      .flatMap((a) => a.campaigns)
      .filter((c) => (c.window?.spend ?? 0) > 0)
      .sort((a, b) => (b.window?.spend ?? 0) - (a.window?.spend ?? 0));
    if (!spending.length) return null;
    /* Every advertisement's daily rows, folded onto its campaign. A campaign
       with no ad-level row draws no line rather than a flat one. */
    const byCampaign = new Map<string, Map<string, number>>();
    for (const ad of A?.creatives?.ads ?? []) {
      if (!ad.campaignId) continue;
      const days = byCampaign.get(ad.campaignId) ?? new Map<string, number>();
      for (const d of ad.daily) if (d.spend !== null) days.set(d.day, (days.get(d.day) ?? 0) + d.spend);
      byCampaign.set(ad.campaignId, days);
    }
    return {
      tag: "metered",
      ranked: spending.slice(0, 8).map((c) => {
        const days = [...(byCampaign.get(c.id) ?? new Map<string, number>()).entries()].sort((a, b) =>
          a[0].localeCompare(b[0]),
        );
        return {
          label: campaignName(c.name),
          value: c.window?.spend ?? 0,
          text: inCurrency(c.window?.spend ?? 0, one.currency),
          sub: also(
            `${count(c.window?.clicks ?? null)} clicks · ${adMoney(c.window?.clicks ? (c.window.spend ?? 0) / c.window.clicks : null, one.currency)}`,
            days.length ? `${days.length} delivering day${days.length === 1 ? "" : "s"}` : "no ad-level day",
          ),
          spark: days.length > 1 ? days.map(([, v]) => v) : undefined,
        };
      }),
      caption:
        "the bar is the campaign's window spend from the account-level read; the line beside the name is the SHAPE of its advertisements' daily spend, which is capped and is never read as a total",
    };
  },

  /*
    WHAT THE MONEY BOUGHT, DAY BY DAY — and deliberately not the money itself.

    Spend is EUR and this chart's axis is a count, so putting the two on one
    picture would caption a euro series in a unit nobody measured. The spend by
    day is the bars card beside this one, over the same days.

    LEADS AND CLICKS SHARE A COUNT AXIS AND THAT IS THE POINT: eight leads
    against nine hundred clicks is the shape of the account, and drawn on two
    axes it would look like two similar lines.
  */
  "meta.results": ({ meta: M }: LiveInputs) => {
    if (!M) return null;
    const one = oneCurrency(M);
    if (!one) return null;
    const clicks = new Map<string, number>();
    const leads = new Map<string, number>();
    let anyLead = false;
    for (const a of one.accounts)
      for (const d of a.daily) {
        if (d.clicks !== null) clicks.set(d.day, (clicks.get(d.day) ?? 0) + d.clicks);
        if (d.leads !== null) {
          anyLead = true;
          leads.set(d.day, (leads.get(d.day) ?? 0) + d.leads);
        }
      }
    const days = [...clicks.keys()].sort();
    if (days.length < 2) return null;
    const series = [
      { label: "clicks", points: days.map((d) => ({ ts: at(d), value: clicks.get(d) ?? 0 })) },
    ];
    if (anyLead)
      series.push({ label: "leads", points: days.map((d) => ({ ts: at(d), value: leads.get(d) ?? 0 })) });
    return {
      tag: "metered",
      chart: series,
      unit: "count" as const,
      caption: also(
        `${days.length} delivering day${days.length === 1 ? "" : "s"} of ${M.windowDays} · ${dayShort(days[0]!)} to ${dayShort(days.at(-1)!)} — a day Meta reported no row is absent rather than drawn at zero`,
        anyLead ? `leads over ${M.attribution}` : "no lead action reported in this window",
      ),
    };
  },

  /* ------------------- AdSense, on the same board and never crossed with Meta */

  "adsense.daily": ({ adsense: S }: LiveInputs) => {
    if (S?.state !== "authorised" || S.days.length < 2) return null;
    const cur = S.currency ?? "USD";
    const total = S.days.reduce((n, d) => n + d.usd, 0);
    return {
      tag: "est.",
      chart: [{ label: `estimated ${cur}`, points: S.days.map((d) => ({ ts: at(d.day), value: d.usd })) }],
      unit: "usd" as const,
      caption: also(
        `${inCurrency(total, cur, total < 10 ? 2 : 0)} over ${S.days.length} days · ${dayShort(S.days[0]!.day)} to ${dayShort(S.days.at(-1)!.day)}`,
        "Google's ESTIMATE — recent days are revised for some time and none of this is settled money",
      ),
    };
  },

  "adsense.sites": ({ adsense: S }: LiveInputs) => {
    if (S?.state !== "authorised" || !S.sites.length) return null;
    const cur = S.currency ?? "USD";
    const sites = [...S.sites].sort((a, b) => b.usd - a.usd);
    return {
      tag: "est.",
      headers: ["Site", "Earnings", "Last 7d", "RPM", "Page views", "Impressions", "Clicks", "Click rate"],
      table: sites.map((s) => [
        s.site,
        inCurrency(s.usd, cur, s.usd < 10 ? 2 : 0),
        inCurrency(s.last7Usd, cur, s.last7Usd < 10 ? 2 : 0),
        /* RPM is divided out of each site's OWN earnings and impressions. A
           site that served nothing has no RPM — which is not an RPM of zero. */
        s.rpm === null ? DASH : inCurrency(s.rpm, cur),
        count(s.pageViews),
        count(s.impressions),
        count(s.clicks),
        s.impressions ? percent((100 * s.clicks) / s.impressions, 2) : DASH,
      ]),
      caption:
        "estimated earnings per site, never added to Stripe's settled money — one is an ad network's estimate and the other is a bank settlement, and a total of the two would describe neither",
    };
  },

  "adsense.months": ({ adsense: S }: LiveInputs) => {
    if (S?.state !== "authorised" || !S.months.length) return null;
    const cur = S.currency ?? "USD";
    const rows: [string, string][] = [...S.months]
      .sort((a, b) => b.month.localeCompare(a.month))
      .slice(0, 8)
      .map((m) => [
        m.month,
        also(
          inCurrency(m.usd, cur, m.usd < 10 ? 2 : 0),
          m.complete
            ? m.rpm === null
              ? ""
              : `${inCurrency(m.rpm, cur)} RPM`
            : "month to date — not a full month",
        ),
      ]);
    /* THE FIGURE THAT ENTERS ANYTHING MONTHLY IS THE NEWEST COMPLETE MONTH.
       A month-to-date printed as a monthly figure halves it. */
    rows.push([
      "Newest complete month",
      S.latestMonth ? `${S.latestMonth.month} · ${inCurrency(S.latestMonth.usd, cur, S.latestMonth.usd < 10 ? 2 : 0)}` : "none yet",
    ]);
    return { tag: "est.", rows };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ============================================== SERVERS BOARD PARITY ======
   WORKDASH'S /servers, AS CARDS — the per-machine half of it especially, which
   no fleet-wide widget can draw. See the matching banner in data/widgets.ts for
   what the three sources each measure and why nothing here averages them.

   THE ONE RULE THAT GOVERNS EVERY BUILDER BELOW: a figure says which
   instrument took it. "CPU 12%" out of the guest and "CPU 12%" off the
   hypervisor are two different measurements of one machine — they disagree by
   several points on a busy box, because one counts the host's own overhead and
   the other does not — so no card prints one without naming it.
*/

/** Where a fleet reading turns amber and where it turns red, per metric.
 *
 *  READ OFF THE DOCUMENT WHEREVER THE SERVER PUBLISHES IT, so the page, the
 *  alert list and an agent reading /api/fleet cannot end up meaning three
 *  different things by "nearly full". The fallbacks are for a server that
 *  predates the per-metric pairs and are Workdash's own numbers. */
function fleetLimits(F: FleetReport | null | undefined) {
  return {
    disk: F?.thresholds.disk ?? { warn: F?.thresholds.warn ?? 80, critical: F?.thresholds.critical ?? 90 },
    cpu: F?.thresholds.cpu ?? { warn: CPU_LIMITS.warn, critical: CPU_LIMITS.crit },
    memory: F?.thresholds.memory ?? { warn: 80, critical: 92 },
  };
}

/** The address the probe logs in to, out of `user@host[:port]`. Lower case,
 *  because it is compared against a vendor's own record of the same machine. */
function targetHost(box: FleetBox): string | null {
  if (!box.target) return null;
  const at = box.target.indexOf("@");
  const rest = at < 0 ? box.target : box.target.slice(at + 1);
  return rest.split(":")[0]!.toLowerCase() || null;
}

/**
 * The Hetzner row for a box the ssh probe knows, or null.
 *
 * THE JOIN IS THE IP ADDRESS, and the hostname is only a second try. The two
 * populations are keyed by different things on purpose — an ssh account
 * survives a rename and a Hetzner server id survives a move — so nothing
 * upstream can be asked to reconcile them, and the one fact both records carry
 * about the same machine is where it answers. A box Hetzner never sold matches
 * nothing here, which is a real answer and not a failed lookup.
 */
function hetznerRow(box: FleetBox, servers: HetznerServer[]): HetznerServer | null {
  const host = targetHost(box);
  if (host)
    for (const s of servers) if (s.ipv4 && s.ipv4.toLowerCase() === host) return s;
  if (box.hostname)
    for (const s of servers) if (s.name && s.name.toLowerCase() === box.hostname.toLowerCase()) return s;
  return null;
}

/** Whose hardware this is. Three answers and no guessing: Hetzner because its
 *  own listing has the machine, the local network because the address is one
 *  nobody can rent, and otherwise somebody else — which is what "Oracle" and
 *  "a VPS at another provider" both look like from here, and the card says the
 *  vaguer true thing rather than the sharper invented one. */
function providerOf(box: FleetBox, servers: HetznerServer[]): string {
  if (hetznerRow(box, servers)) return "Hetzner";
  const host = targetHost(box);
  if (host && (/^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /\.(local|lan|home|internal)$/.test(host)))
    return "On the local network";
  return "Another provider";
}

/** A box's filesystems, root first and then fullest first. Root leads because
 *  it is the one every box has and the one a reader is looking for; the rest
 *  are ordered by how close they are to being a problem. */
function mountsOf(box: FleetBox) {
  return [...box.disks].sort((a, b) => {
    if (a.mount === "/") return -1;
    if (b.mount === "/") return 1;
    return (b.meter?.percent ?? 0) - (a.meter?.percent ?? 0);
  });
}

/** The mounts that are not the root filesystem — the attached volumes and
 *  second disks, which is what "are there extra disks on this box" means. */
const extraMounts = (box: FleetBox) => box.disks.filter((d) => d.mount !== "/");

/** How long a box has been silent, in milliseconds, or null when it has never
 *  been seen at all. */
function silentFor(box: FleetBox): number | null {
  return box.seenAt ? Date.now() - Date.parse(box.seenAt) : null;
}

/** Has this box missed enough probes to call it? THREE CADENCES, because one
 *  missed run is a slow ssh handshake on a domestic line and two is a
 *  coincidence; three is a machine that has stopped answering. */
function notReporting(box: FleetBox, F: FleetReport | null | undefined): boolean {
  const gap = silentFor(box);
  return gap !== null && gap > (F?.cadenceMinutes ?? 30) * 60_000 * 3;
}

/** A percentage series out of the box's own samples, dropping the rows that
 *  hold no reading. A MISSED SAMPLE IS A GAP AND NEVER A ZERO — a line that
 *  drew nulls as nought would report every collection failure as an idle
 *  machine. */
function sampleSeries(box: FleetBox, of: "cpu" | "memory" | "swap" | "load"): { ts: string; value: number }[] {
  const out: { ts: string; value: number }[] = [];
  for (const s of box.samples) {
    let v: number | null = null;
    if (of === "cpu") v = s.cpuPercent;
    else if (of === "memory") v = s.memTotal && s.memUsed !== null ? (s.memUsed / s.memTotal) * 100 : null;
    else if (of === "swap") v = s.swapTotal && s.swapUsed !== null ? (s.swapUsed / s.swapTotal) * 100 : null;
    else {
      const cores = s.cpus ?? box.sample?.cpus ?? null;
      v = s.load1 !== null && cores ? (s.load1 / cores) * 100 : null;
    }
    if (v === null || !Number.isFinite(v)) continue;
    out.push({ ts: s.ts, value: Math.round(v * 10) / 10 });
  }
  return out;
}

/** The window a run of samples actually covers, in words, for a caption. The
 *  picker may have asked for ninety days of a collector that has been up for
 *  two, and the card says which it drew. */
function sampleSpan(points: { ts: string }[]): string {
  if (points.length < 2) return "not enough samples yet";
  const minutes = (Date.parse(points[points.length - 1]!.ts) - Date.parse(points[0]!.ts)) / 60_000;
  /* MINUTES ARE A REAL ANSWER HERE, and the reason this does not start at
     hours: a column added to the probe has one sample per box per collection,
     so the first afternoon of it is a line covering ninety minutes — and
     rounding that to "0 hours drawn" is a caption that reads like a bug. */
  if (minutes < 90) return `${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * WHAT KIND OF MORNING THIS BOX IS HAVING, in a word and a tone.
 *
 * WORST-OF, and judged per metric against that metric's own pair rather than
 * against one number — 77% of a disk (act at 90) is a quieter morning than 77%
 * of memory (act at 92) is loud, and ranking raw percentages across metrics
 * with different limits is how a page ends up shouting about the wrong box.
 */
function boxState(box: FleetBox, F: FleetReport | null | undefined): { tone: StatusTone; word: string } {
  const L = fleetLimits(F);
  if (notReporting(box, F)) return { tone: "bad", word: "not reporting" };
  if (!box.sample) return { tone: "warn", word: "never sampled" };
  if (box.error) return { tone: "bad", word: "last probe failed" };
  const readings: [number | null, { warn: number; critical: number }][] = [
    [box.sample.cpuPercent, L.cpu],
    [box.sample.memory?.percent ?? null, L.memory],
    ...box.disks.map((d) => [d.meter?.percent ?? null, L.disk] as [number | null, { warn: number; critical: number }]),
  ];
  for (const [v, pair] of readings) if (v !== null && v >= pair.critical) return { tone: "bad", word: "act" };
  if ((box.sample.loadPerCpu ?? 0) > 1) return { tone: "warn", word: "more tasks than cores" };
  for (const [v, pair] of readings) if (v !== null && v >= pair.warn) return { tone: "warn", word: "watch" };
  return { tone: "ok", word: "fine" };
}

Object.assign(LIVE_BUILDERS, {
  /* ---------------------------------------------------------- one machine */

  "server.overview": ({ server: S, boxes: F, fleet: HZ, load: HL }: LiveInputs) => {
    if (!S) return null;
    const box = S.box;
    const L = fleetLimits(F);
    const mem = box.sample?.memory ?? null;
    const root = box.disks.find((d) => d.mount === "/") ?? mountsOf(box)[0] ?? null;
    const hz = hetznerRow(box, HZ ?? []);
    const hzLoad = hz ? (HL?.servers ?? []).find((s) => s.id === hz.id) ?? null : null;

    /* CPU, AND WHICH INSTRUMENT SAW IT. The in-guest reading wins where there
       is one, because it is the one that includes what this machine is
       actually running; the hypervisor's is the fallback and is labelled. */
    const guestCpu = box.sample?.cpuPercent ?? null;
    const hyperCpu = hzLoad?.samples ? hzLoad.cpu.now : null;
    const cpu = guestCpu ?? hyperCpu;
    /* SHORT ENOUGH TO SURVIVE A ONE-COLUMN TILE. The sentence about what a
       one-second sample is belongs in the caption; the tile only has to say
       which instrument, because that is what changes between two boxes. */
    const cpuSub =
      guestCpu !== null ? "in the guest" : hyperCpu !== null ? "hypervisor" : "not measured yet";

    const line = sampleSeries(box, "memory");
    const figures: ProfileFigure[] = [
      { label: "CPU", value: percent(cpu, 0), sub: cpuSub },
      {
        label: "Memory",
        value: percent(mem?.percent ?? null, 0),
        /* USED IS TOTAL MINUS AVAILABLE, done at the probe: Linux's page cache
           is not memory anybody is short of. */
        sub: mem ? `${bytes(mem.used)} of ${bytes(box.sample?.memoryTotal ?? null)}` : "no sample",
      },
      {
        label: "Disk",
        value: percent(root?.meter?.percent ?? null, 0),
        sub: root ? `${root.mount} · ${bytes(root.avail)} free` : "no filesystem reported",
      },
      {
        label: "Load / cpu",
        value: box.sample?.loadPerCpu === null || !box.sample ? DASH : box.sample.loadPerCpu.toFixed(2),
        sub: `${box.sample?.load.one ?? DASH} over ${box.sample?.cpus ?? "?"} cores`,
      },
    ];

    /* THE META LINE AND THEN EVERY FILESYSTEM, which is where uptime lives —
       it is a fact you read once about a machine rather than a reading you
       scan a grid of cards for, and a fifth tile in a two-column card wraps
       onto a row of its own with three empty columns beside it. Attached
       volumes are rows here because "is the disk full" has as many answers as
       the box has mounts and the tile above only carries the root's., attached volumes included, because "is the
    */
    const rows: [string, string][] = [
      ["Up", also(durationS(box.sample?.uptimeSeconds ?? null), box.kernel ?? "")],
      ...(box.docker
        ? ([[
            box.docker.installed ? "Containers" : "Docker",
            box.docker.installed ? `${count(box.docker.running)} running` : "not installed here",
          ]] as [string, string][])
        : []),
      ...mountsOf(box).map<[string, string]>((d) => [
        d.mount === "/" ? "/ (root)" : d.mount,
        `${percent(d.meter?.percent ?? null, 0)} · ${bytes(d.used)} of ${bytes(d.size)}`,
      ]),
    ];
    const extras = extraMounts(box);
    const state = boxState(box, F);

    return {
      tag: "measured",
      figures,
      series: line.map((p) => p.value),
      seriesAt: line.map((p) => p.ts),
      unit: "percent" as const,
      rows,
      caption: also(
        `${state.word} · ${box.hostname ?? DASH} at ${targetHost(box) ?? DASH}`,
        also(
          line.length > 1 ? `the line is memory used over ${sampleSpan(line)}` : "no memory history yet",
          also(
            extras.length
              ? `${extras.length} filesystem${extras.length === 1 ? "" : "s"} beside the root disk`
              : "one filesystem, the root disk",
            also(
              hz ? `${hz.plan ?? "Hetzner"} · ${hz.location ?? DASH}` : "not a box Hetzner sold",
              `disks act at ${L.disk.critical}%, memory at ${L.memory.critical}%, CPU at ${L.cpu.critical}% · probed every ${F?.cadenceMinutes ?? 30} min, last ${ago(box.seenAt)}`,
            ),
          ),
        ),
      ),
    };
  },

  "server.cpu": ({ server: S, boxes: F, fleet: HZ, load: HL, window: W }: LiveInputs) => {
    if (!S) return null;
    const box = S.box;
    const guest = sampleSeries(box, "cpu");
    if (guest.length > 1)
      return {
        tag: "measured",
        chart: [{ label: "CPU busy", points: guest }],
        unit: "percent" as const,
        caption: `Percent of a sampled second in which the cores were not idle, read inside the guest every ${F?.cadenceMinutes ?? 30} min — ${sampleSpan(guest)} drawn. Waiting on a disk counts as idle, so a slow volume does not read as a busy CPU.`,
      };

    /* THE HYPERVISOR IS THE FALLBACK AND RENAMES THE CARD. Hetzner's metrics
       are fetched over a fixed day, so a card drawn from them cannot wear the
       picker's window in its name — it would be promising ninety days of a
       document that holds one. */
    const hz = hetznerRow(box, HZ ?? []);
    const hzLoad = hz ? (HL?.servers ?? []).find((s) => s.id === hz.id) ?? null : null;
    if (hzLoad && hzLoad.cpu.points.length > 1)
      return {
        name: `CPU · ${HL?.hours ?? 24}h`,
        tag: "measured",
        chart: [{ label: "CPU", points: hzLoad.cpu.points }],
        unit: "percent" as const,
        caption: `Hetzner's HYPERVISOR view, not the guest's — this box has no in-guest CPU sample yet, and the probe only began taking one recently. ${hzLoad.cpuScaled ? `Scaled to the whole box over ${hzLoad.cores} cores.` : "Hetzner's raw per-core sum, which can exceed 100: the core count is unknown."} Mean ${percent(hzLoad.cpu.mean, 0)}, peak ${percent(hzLoad.cpu.peak, 0)}.`,
      };

    /* ONE READING IS A FIGURE, NOT A LINE. The in-guest sample began today, so
       for a box Hetzner did not sell there is exactly one point until the next
       collection; a card that said "no reading" under a tile showing 40% would
       be contradicting its neighbour. */
    if (guest.length === 1)
      return {
        tag: "measured",
        chart: [],
        caption: `One in-guest reading so far for ${S.label}: ${percent(guest[0]!.value, 0)} busy. The line starts at the next collection, ${F?.cadenceMinutes ?? 30} min after this one; Hetzner has no view of this box because it is not a machine it sold.`,
      };
    return {
      tag: "measured",
      chart: [],
      caption: `No CPU reading for ${S.label} over ${windowLabel(W ?? 30)}. The ssh probe records one from the box's next collection; Hetzner has none because this is not a machine it sold.`,
    };
  },

  "server.memory": ({ server: S, boxes: F }: LiveInputs) => {
    if (!S) return null;
    const box = S.box;
    const mem = sampleSeries(box, "memory");
    if (mem.length < 2) return null;
    const swap = sampleSeries(box, "swap");
    const L = fleetLimits(F);
    return {
      tag: "measured",
      /* SWAP BESIDE MEMORY AND NEVER ADDED TO IT. They are two pools with two
         meanings — a box at 40% RAM and 99% swap has a problem that adding the
         two would hide behind a comfortable average. */
      chart: [
        { label: "Memory used", points: mem },
        ...(swap.length > 1 ? [{ label: "Swap used", points: swap }] : []),
      ],
      unit: "percent" as const,
      caption: `Used is total minus AVAILABLE, so the page cache is not counted as memory anybody is short of. ${bytes(box.sample?.memory?.used ?? null)} of ${bytes(box.sample?.memoryTotal ?? null)} now, watch at ${L.memory.warn}% and act at ${L.memory.critical}% · ${sampleSpan(mem)} drawn${swap.length > 1 ? `, swap ${percent(box.sample?.swap?.percent ?? null, 0)} of ${bytes((box.sample?.swap?.used ?? 0) + (box.sample?.swap?.free ?? 0))}` : ", no swap on this box"}.`,
    };
  },

  "server.load": ({ server: S }: LiveInputs) => {
    if (!S) return null;
    const box = S.box;
    const points = sampleSeries(box, "load");
    if (points.length < 2) return null;
    const cores = box.sample?.cpus ?? null;
    return {
      tag: "measured",
      chart: [{ label: "Load per cpu", points }],
      unit: "percent" as const,
      /* AS A PERCENTAGE OF ONE RUNNABLE TASK PER CORE, which is the only
         reading that means the same thing on a Pi and on a sixteen-core box.
         100% is exactly saturated and the line goes above it rather than being
         clamped. */
      caption: `The one-minute load average divided by ${cores ?? "the box's"} core${cores === 1 ? "" : "s"}: 100% is one runnable task per core, exactly saturated. Load counts tasks WAITING as well as running, so it climbs on a slow disk while the CPU sits idle — the CPU card is the other half of that sentence. Now ${box.sample?.load.one ?? DASH} / ${box.sample?.load.five ?? DASH} / ${box.sample?.load.fifteen ?? DASH} over 1, 5 and 15 minutes · ${sampleSpan(points)} drawn.`,
    };
  },

  "server.disk": ({ server: S, boxes: F }: LiveInputs) => {
    if (!S) return null;
    const box = S.box;
    const L = fleetLimits(F);
    const mounts = mountsOf(box).filter((d) => d.meter);
    if (!mounts.length) return null;
    const extras = extraMounts(box);
    return {
      tag: "measured",
      meters: mounts.map<Meter>((d) => ({
        label: d.mount === "/" ? "/ (root)" : d.mount,
        value: d.meter!.percent,
        warn: L.disk.warn,
        crit: L.disk.critical,
        note: `${bytes(d.used)} of ${bytes(d.size)} · ${bytes(d.avail)} free`,
      })),
      /* THE PERCENTAGE IS used / (used + available) — what `df` calls Capacity
         — and not used / size. ext4 reserves 5% for root and an APFS container
         shares free space between volumes, so used/size calls a 62%-full Mac
         2% full. */
      caption: `Every filesystem the probe found, as df reports Capacity: used / (used + available), not used / size. ${extras.length ? `${extras.length} beside the root disk — ${extras.map((d) => d.mount).join(", ")}.` : "Only the root disk; nothing else is mounted."} Watch at ${L.disk.warn}%, act at ${L.disk.critical}%.`,
    };
  },

  "server.network": ({ server: S, fleet: HZ, load: HL }: LiveInputs) => {
    if (!S) return null;
    const hz = hetznerRow(S.box, HZ ?? []);
    const hzLoad = hz ? (HL?.servers ?? []).find((s) => s.id === hz.id) ?? null : null;
    /* NOT AN EMPTY CARD: "nobody measures this here" is the finding, and it is
       a different sentence from "the collector has not run". */
    if (!hzLoad || !hzLoad.samples)
      return {
        tag: "measured",
        rows: [
          ["Nothing measures throughput here", hz ? "Hetzner has no samples for this box yet" : "not a machine Hetzner sold"],
          ["The ssh probe cannot see it", "bytes in and out are counted by the hypervisor, outside the guest"],
        ] as [string, string][],
      };
    const three = (s: { now: number | null; mean: number | null; peak: number | null }) =>
      `${rate(s.now)} · peak ${rate(s.peak)}`;
    return {
      tag: "measured",
      rows: [
        ["Network in", three(hzLoad.netIn)],
        ["Network out", three(hzLoad.netOut)],
        ["Disk read", three(hzLoad.diskRead)],
        ["Disk write", three(hzLoad.diskWrite)],
      ] as [string, string][],
      caption: `Hetzner's hypervisor over ${HL?.hours ?? 24}h, ${count(hzLoad.samples)} samples. Its window is Hetzner's own and does not follow the picker. Rates, not totals — the /s is part of the unit.`,
    };
  },

  "server.containers": ({ server: S }: LiveInputs) => {
    if (!S) return null;
    const box = S.box;
    /* THREE DIFFERENT ANSWERS AND THEY ARE NOT ONE. The probe never reached
       the box; docker is not installed on it; docker is there and running
       nothing. Only the last is a fleet with an empty machine in it. */
    if (box.docker === null) return null;
    if (!box.containers.length)
      return {
        tag: "measured",
        headers: ["Container", "Image", "Status", "Up"],
        table: [[box.docker.installed ? "Nothing running" : "Docker is not installed here", DASH, DASH, DASH]],
      };
    const tone = (status: string | null): StatusTone | null =>
      !status ? null : /^up\b/i.test(status) ? "ok" : /paused|restarting/i.test(status) ? "warn" : "bad";
    return {
      tag: "measured",
      headers: ["Container", "Image", "Status", "Up"],
      table: box.containers.map((ct) => [ct.name, ct.image ?? DASH, ct.status ?? DASH, ct.since ?? DASH]),
      rowTones: box.containers.map((ct) => tone(ct.status)),
    };
  },

  "server.counters": ({ server: S }: LiveInputs) => {
    if (!S) return null;
    const counters = S.box.counters;
    /* "NOBODY HAS ASKED THIS BOX ANYTHING" IS THE ANSWER, and it is not the
       same sentence as "the commands ran and measured nothing". Counters are
       the owner's own lines on the fleet plugin's settings page, so an empty
       list is a thing nobody has typed yet rather than a collection that
       failed — and the card says which, with where to type them. */
    if (!counters.length)
      return {
        rows: [
          ["No counters configured", "the owner's own measurements, one per box"],
          ["Where", "the fleet plugin's settings: one line of “label = shell command”"],
        ] as [string, string][],
      };
    return {
      tag: "measured",
      rows: counters.map((c) => [
        c.label,
        /* NEVER ZERO for a counter with no reading: a command that has not run
           and a command that printed 0 look identical as a figure, and only one
           of them is a measurement. */
        c.latest ? count(c.latest.value) : "no value yet — not zero",
      ]) as [string, string][],
      caption: "The owner's own commands, run on every box by the probe. A command that failed has no reading rather than a nought.",
    };
  },

  /* ------------------------------------------------------------- the fleet */

  "fleet.alerts": ({ boxes: F }: LiveInputs) => {
    const boxes = F?.boxes ?? [];
    if (!boxes.length) return null;
    const L = fleetLimits(F);
    const found: [string, StatusTone][] = [];
    const bad: [string, StatusTone][] = [];

    for (const b of boxes) {
      /* A BOX THAT HAS STOPPED ANSWERING LEADS, because every other reading
         about it is now history wearing a present tense. */
      if (notReporting(b, F))
        bad.push([`${b.label} has not reported for ${ago(b.seenAt)}`.replace(" ago", ""), "bad"]);
      else if (b.error) bad.push([`${b.label}: ${b.error.slice(0, 90)}`, "bad"]);
      for (const d of b.disks) {
        const v = d.meter?.percent ?? null;
        if (v === null) continue;
        if (v >= L.disk.critical) bad.push([`${b.label} ${d.mount} is ${percent(v, 0)} full — ${bytes(d.avail)} left`, "bad"]);
        else if (v >= L.disk.warn) found.push([`${b.label} ${d.mount} is ${percent(v, 0)} full — ${bytes(d.avail)} left`, "warn"]);
      }
      const mem = b.sample?.memory?.percent ?? null;
      if (mem !== null && mem >= L.memory.critical) bad.push([`${b.label} memory is ${percent(mem, 0)}`, "bad"]);
      else if (mem !== null && mem >= L.memory.warn) found.push([`${b.label} memory is ${percent(mem, 0)}`, "warn"]);
      const cpu = b.sample?.cpuPercent ?? null;
      if (cpu !== null && cpu >= L.cpu.critical) bad.push([`${b.label} CPU is ${percent(cpu, 0)}`, "bad"]);
      else if (cpu !== null && cpu >= L.cpu.warn) found.push([`${b.label} CPU is ${percent(cpu, 0)}`, "warn"]);
      const perCpu = b.sample?.loadPerCpu ?? null;
      if (perCpu !== null && perCpu > 1)
        found.push([`${b.label} load is ${perCpu.toFixed(2)} per cpu — more runnable tasks than cores`, "warn"]);
      const swap = b.sample?.swap?.percent ?? null;
      if (swap !== null && swap >= L.disk.critical)
        found.push([`${b.label} swap is ${percent(swap, 0)} — the box is paging`, "warn"]);
    }

    const statuses = [...bad, ...found].slice(0, 12);
    const answering = boxes.filter((b) => b.sample).length;
    if (!statuses.length)
      statuses.push([
        `Nothing above its line — ${answering} of ${boxes.length} boxes reporting, fullest disk ${percent(F?.totals.fullestDisk?.percent ?? null, 0)}`,
        "ok",
      ]);
    return {
      tag: "measured",
      statuses,
      caption: `Disks watch at ${L.disk.warn}% and act at ${L.disk.critical}%, memory at ${L.memory.warn} and ${L.memory.critical}, CPU at ${L.cpu.warn} and ${L.cpu.critical}. A box is called silent after three missed probes — ${(F?.cadenceMinutes ?? 30) * 3} minutes.`,
    };
  },

  "fleet.table": ({ boxes: F, fleet: HZ, load: HL }: LiveInputs) => {
    const boxes = F?.boxes ?? [];
    if (!boxes.length) return null;
    return {
      tag: "measured",
      headers: ["Box", "CPU", "Memory", "Fullest disk", "Load/cpu", "Up", "Last seen"],
      table: boxes.map((b) => {
        const disk = fullestMount(b);
        const hz = hetznerRow(b, HZ ?? []);
        const hzLoad = hz ? (HL?.servers ?? []).find((s) => s.id === hz.id) ?? null : null;
        /* The in-guest reading, or the hypervisor's with a mark saying so. A
           column that silently mixed the two would be a column nobody could
           compare down. */
        const cpu =
          b.sample?.cpuPercent !== null && b.sample
            ? percent(b.sample.cpuPercent, 0)
            : hzLoad?.samples
              ? `${percent(hzLoad.cpu.now, 0)} *`
              : DASH;
        return [
          b.label,
          cpu,
          b.sample?.memory ? percent(b.sample.memory.percent, 0) : DASH,
          disk ? `${disk.mount} ${percent(disk.meter!.percent, 0)}` : DASH,
          b.sample?.loadPerCpu === null || !b.sample ? DASH : b.sample.loadPerCpu.toFixed(2),
          durationS(b.sample?.uptimeSeconds ?? null),
          ago(b.seenAt),
        ];
      }),
      rowTones: boxes.map((b) => boxState(b, F).tone),
      caption: `One row per box, as the probe last saw it. A CPU marked * is Hetzner's hypervisor rather than the guest's own reading. Probed every ${F?.cadenceMinutes ?? 30} minutes.`,
    };
  },

  "fleet.mounts": ({ boxes: F }: LiveInputs) => {
    const L = fleetLimits(F);
    const all = (F?.boxes ?? []).flatMap((b) =>
      b.disks.filter((d) => d.meter).map((d) => ({ box: b.label, disk: d, extra: d.mount !== "/" })),
    );
    if (!all.length) return null;
    const shown = [...all].sort((a, b) => b.disk.meter!.percent - a.disk.meter!.percent).slice(0, 12);
    return {
      tag: "measured",
      meters: shown.map<Meter>((r) => ({
        label: `${r.box} · ${r.disk.mount}`,
        value: r.disk.meter!.percent,
        warn: L.disk.warn,
        crit: L.disk.critical,
        note: `${bytes(r.disk.avail)} free${r.extra ? " · extra disk" : ""}`,
      })),
      /* RANKED ACROSS BOXES AND NEVER ADDED. Filesystems share pools — a Mac's
         root and its data volume report one container's free space twice — so
         there is no fleet disk total, and this is the card that replaces one. */
      caption: `${shown.length} of ${all.length} filesystems, fullest first, across ${F?.boxes.length ?? 0} boxes. ${all.filter((r) => r.extra).length} are not a root disk. Sizes are never added: filesystems share pools, so a fleet disk total would count the same free space twice.`,
    };
  },

  "fleet.fullest": ({ boxes: F }: LiveInputs) => {
    const worst = F?.totals.fullestDisk ?? null;
    if (!worst || worst.percent === null) return null;
    const L = fleetLimits(F);
    const disk = (F?.boxes ?? [])
      .flatMap((b) => b.disks.map((d) => ({ b, d })))
      .find((r) => r.b.label === worst.box && r.d.mount === worst.mount);
    return {
      tag: "measured",
      value: percent(worst.percent, 0),
      tone: worst.percent >= L.disk.critical ? "bad" : worst.percent >= L.disk.warn ? "warn" : "ok",
      sub: `${worst.box} · ${worst.mount}${disk ? ` · ${bytes(disk.d.avail)} free` : ""} · act at ${L.disk.critical}%`,
    };
  },

  "fleet.reporting": ({ boxes: F }: LiveInputs) => {
    const boxes = F?.boxes ?? [];
    if (!boxes.length) return null;
    const answering = boxes.filter((b) => b.sample).length;
    const silent = boxes.filter((b) => notReporting(b, F)).length;
    return {
      tag: "measured",
      value: `${answering}/${boxes.length}`,
      tone: silent ? "bad" : answering < boxes.length ? "warn" : "ok",
      sub: also(
        silent ? `${silent} silent for over ${(F?.cadenceMinutes ?? 30) * 3} min` : "all answering",
        `last probe ${ago(F?.totals.seenAt ?? null)}`,
      ),
    };
  },

  "fleet.memoryTotal": ({ boxes: F }: LiveInputs) => {
    const total = F?.totals.memoryBytes ?? null;
    if (!total) return null;
    const answering = F?.totals.answering ?? 0;
    return {
      tag: "measured",
      value: bytes(total.used),
      /* THIS IS THE ONE FIGURE ON THE BOARD THAT ADDS. A byte of RAM on one box
         and a byte on another are two bytes the owner is paying for; disk and
         load are not like that, and neither has a total anywhere here. */
      sub: `of ${bytes(total.total)} across ${answering} box${answering === 1 ? "" : "es"} · used is total minus available`,
    };
  },

  "fleet.providers": ({ boxes: F, fleet: HZ }: LiveInputs) => {
    const boxes = F?.boxes ?? [];
    if (!boxes.length) return null;
    const groups = new Map<string, FleetBox[]>();
    for (const b of boxes) {
      const key = providerOf(b, HZ ?? []);
      groups.set(key, [...(groups.get(key) ?? []), b]);
    }
    const slices = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([label, list]) => ({
        label,
        value: list.length,
        text: String(list.length),
        sub: list.map((b) => b.label).join(", "),
      }));
    return {
      tag: "measured",
      slices,
      center: { value: String(boxes.length), note: boxes.length === 1 ? "box" : "boxes" },
      caption:
        "Whose hardware each box is, joined on the address the probe logs in to. “Another provider” is every machine Hetzner did not sell and that is not on the local network — this dashboard has no vendor list to name them from, and a guess would be worse than the vaguer true answer.",
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);

/* ==========================================================================
   OVERVIEW BOARD (Workdash /overview) — the four builders for the four cards
   nothing else on this dashboard draws.

   EVERY OTHER CARD ON THAT BOARD IS AN EXISTING BUILDER, PLACED. That is the
   whole shape of the work: Workdash's Overview asks for MRR, the net, the
   pageviews, the movement waterfall, the cost donut, the traffic table, the
   fleet meters and the renewal horizon, and this file already had all of them.
   What it did not have is any card that JOINS documents — the inbox is five
   areas in one list, the P&L is revenue against the ledger, the venture table
   is four documents on one host, and the pictures are a document nothing else
   reads at all.
   ========================================================================== */

/** How many waiting things reach the card before it says "and N more". A cap
 *  rather than a scroll: this is the second card on the page the owner opens
 *  first, and a list that fills a screen is a list read as a wall. */
const ATTENTION_ROWS = 12;

/**
 * How much of a waiting thing's own sentence fits on one table row.
 *
 * A TABLE CELL DOES NOT WRAP — that is the form, and it is right for the
 * figures every other table here draws. An alert's message is prose written by
 * whichever rule tripped, and one four-line one would push the three columns
 * beside it off the card for every row under it. So it is cut with an ellipsis
 * and the whole sentence is one click away on the page the row's source names,
 * which is where it is answered anyway.
 */
const ATTENTION_CHARS = 84;
const clip = (text: string) =>
  text.length > ATTENTION_CHARS ? `${text.slice(0, ATTENTION_CHARS - 1).trimEnd()}…` : text;

/** How many front pages the picture card draws before it says how many more.
 *  Nineteen thumbnails is a scroll rather than a glance, and the point of the
 *  card is the glance. */
const SHOT_ITEMS = 9;

/** "3 days", "under a day" — the age of a photograph as the half of a phrase
 *  a feed's meta needs, since it prints the value and then the word for it. */
function ageWords(days: number | null): string {
  if (days === null) return "unknown age";
  const n = Math.round(days);
  return n < 1 ? "under a day" : `${n} day${n === 1 ? "" : "s"}`;
}

/** Sum a per-currency list into a map, so two documents' rows can be added
 *  WITHIN a currency and never across one. */
function byCurrency(rows: readonly { currency: string; amount: number }[] | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows ?? []) {
    const key = r.currency.toUpperCase();
    out.set(key, (out.get(key) ?? 0) + r.amount);
  }
  return out;
}

/**
 * WHICH CURRENCY THE HERO FIGURE IS IN.
 *
 * The largest revenue, and where nothing was earned the largest cost — a
 * portfolio that has not billed anybody this month still has a bill, and a
 * card that picked the currency by revenue alone would draw a dash over a
 * ledger with real numbers in it. Never a total across the two maps.
 */
function pnlCurrency(revenue: Map<string, number>, cost: Map<string, number>): string | null {
  const pick = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0]?.[0] ?? null;
  return pick(revenue) ?? pick(cost);
}

/** "September 2026" out of the P&L's own "2026-09". Built from the key rather
 *  than from today, because a document can answer for a month that has closed. */
function monthName(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? month
    : d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

Object.assign(LIVE_BUILDERS, {
  /*
    WHAT IS WAITING — and nothing here decides what that means.

    `/api/action-inbox` has already read the five areas through their own
    readers and dropped everything resolved or snoozed, so this builder does
    no filtering: a copy of that rule here would be a second definition of
    "still open" for the two surfaces to disagree about, which is the exact
    bug the route's own header says it was written to end.

    THE ORDER IS THE ROUTE'S TOO — priority, then recency — which is what
    "actionable first" means on a document whose two priority bands are
    "answer this" and "when you get to it". The dot is that band; a row
    without one is not urgent rather than not important, and twelve dots would
    say neither.
  */
  "overview.attention": ({ inbox: I }: LiveInputs) => {
    if (!I) return null;
    const shown = I.items.slice(0, ATTENTION_ROWS);
    const more = I.items.length - shown.length;
    const urgent = I.items.filter((i) => i.priority === 1).length;
    return {
      tag: "measured",
      /* THE SENTENCE IS THE FIRST COLUMN because the first column is the only
         one this table draws left-aligned, and a right-aligned paragraph
         beside three short figures reads as a mistake. It also puts the
         urgency dot on the words rather than on the word "Alert". */
      headers: ["What", "Source", "When", "To close it"],
      table: shown.map((i: InboxItem) => [
        clip(i.title),
        i.source,
        when(i.at),
        i.resolution,
      ]),
      rowTones: shown.map((i): StatusTone | null => (i.priority === 1 ? "bad" : null)),
      caption: I.items.length
        ? also(
            `${count(I.items.length)} open${urgent ? `, ${count(urgent)} of them dotted as actionable now` : " — none of them urgent"}${more > 0 ? `; ${count(more)} not shown` : ""}.`,
            "Alerts, commitments, mail scored as needing a reply, failed runs and payment " +
              "failures, in one list. Anything resolved or snoozed was dropped before this " +
              "browser saw it, so a row here is a decision nobody has made yet. Each row is " +
              "answered on the page its source names — Alerts, People, Mail, Runs, Activity.",
          )
        : "Nothing is waiting. Alerts, commitments, mail needing a reply, failed runs and " +
          "payment failures were all asked, and every one of them answered empty — which is " +
          "a measurement rather than a source that failed to load.",
    };
  },

  /*
    WHAT THE MONTH EARNED AGAINST WHAT IT COST.

    TWO MAPS AND NO TOTAL. Revenue and cost are each summed per currency and
    the hero is the difference within ONE of them; a euro server bill is not
    subtracted from a dollar subscription anywhere in here, and the currencies
    that are not the lead one get their own rows rather than being folded in.

    THE COST SIDE IS TWO THINGS AND THE CARD SAYS SO. Every venture's margin
    row already carries its allocated ledger cost with its model spend folded
    in — that is the P&L's own arithmetic — but the SHARED lines nobody has
    allocated are outside every venture, so they are added here and named on
    their own row. Leaving them out would make the portfolio look cheaper than
    the ledger it is built from.

    AND THERE IS NO RUNWAY. A runway is a cash balance divided by a burn, and
    nothing on this box holds a balance: the finance area has a rate card and
    a month of margin. The row says "not computed" rather than dividing two
    numbers that do not answer the question.
  */
  "overview.margin": ({ profit: P, finance: F }: LiveInputs) => {
    if (!P) return null;
    const revenue = new Map<string, number>();
    const allocated = new Map<string, number>();
    for (const v of P.ventures)
      for (const m of v.margin) {
        const key = m.currency.toUpperCase();
        revenue.set(key, (revenue.get(key) ?? 0) + m.revenue);
        allocated.set(key, (allocated.get(key) ?? 0) + m.cost);
      }
    const shared = byCurrency(P.ledger.unallocatedShared.amounts);
    const cost = new Map(allocated);
    for (const [cur, amount] of shared) cost.set(cur, (cost.get(cur) ?? 0) + amount);
    const lead = pnlCurrency(revenue, cost);
    if (!lead) return null;

    const earned = revenue.get(lead) ?? 0;
    const spent = cost.get(lead) ?? 0;
    const kept = earned - spent;
    const month = monthName(P.month);

    /* THE BAR IS THE TWO QUANTITIES SIDE BY SIDE, not a share of one of them.
       At zero revenue it is one segment, which is the honest picture of a
       month that has cost money and made none — and the same bar with a
       "kept" slice would be inventing a proportion of nothing. */
    const parts: ProportionPart[] = [
      { label: "Earned", value: earned, text: inCurrency(earned, lead) },
      { label: "Spent", value: spent, text: inCurrency(spent, lead) },
    ];

    const rows: [string, string][] = [
      ["Net revenue", inCurrency(earned, lead)],
      ["Cost, allocated to a venture", inCurrency(allocated.get(lead) ?? 0, lead)],
    ];
    if ((shared.get(lead) ?? 0) > 0)
      rows.push([
        "Cost, shared and unallocated",
        also(
          inCurrency(shared.get(lead)!, lead),
          `${count(P.ledger.unallocatedLines.length)} line${P.ledger.unallocatedLines.length === 1 ? "" : "s"}`,
        ),
      ]);
    /* MODEL SPEND IS ALREADY INSIDE THE COST ABOVE — it is quoted again only
       because it is the one cost line that moves daily, and the row says so
       rather than reading as a second charge. Null is tokens with no price
       configured, which is never $0. */
    rows.push([
      "of which model spend · in the cost above",
      P.modelSpend.usd === null
        ? also(DASH, `${compact(P.modelSpend.tokens)} tokens, no price configured`)
        : also(inCurrency(P.modelSpend.usd, "USD"), `${compact(P.modelSpend.tokens)} tokens`),
    ]);
    for (const cur of [...new Set([...revenue.keys(), ...cost.keys()])].filter((c) => c !== lead))
      rows.push([
        `Also in ${cur} · not added to the figure above`,
        `${inCurrency(revenue.get(cur) ?? 0, cur)} earned · ${inCurrency(cost.get(cur) ?? 0, cur)} spent`,
      ]);
    if (F?.summary)
      rows.push([
        "Ledger, per month · rate card",
        also(
          F.summary.monthly.amounts.map((a) => inCurrency(a.amount, a.currency)).join(" · ") || DASH,
          F.summary.monthly.unpriced > 0 ? `${count(F.summary.monthly.unpriced)} unpriced` : "",
        ),
      ]);
    rows.push([
      "Runway",
      "not computed — this box holds no cash balance",
    ]);

    return {
      tag: "metered",
      value: inCurrency(kept, lead),
      sub: also(
        `${kept < 0 ? "short" : "kept"} over ${month}${P.actual ? "" : ", a month still being written"}`,
        `${inCurrency(earned, lead)} earned against ${inCurrency(spent, lead)} spent`,
      ),
      partsLabel: `${month}, earned against spent · ${lead}`,
      parts,
      rows,
      caption:
        `Summed over ${month} from the rows that were actually collected, per currency and never across ` +
        `two of them — ${lead} is the largest of ${new Set([...revenue.keys(), ...cost.keys()]).size} here and the rest have their own rows. ` +
        "The cost half is part measurement and part rate card: metered model spend and " +
        "collected provider bills sit beside ledger lines whose price the owner typed, and a " +
        "line nobody has priced is absent rather than free. " +
        (P.actual
          ? "The month has closed, so this is what it did."
          : "The month is still open, so this is what it has done so far and not what it will do.") +
        " There is no runway on this card because nothing here holds a cash balance to divide by a burn.",
    };
  },

  /*
    EVERY VENTURE ON ONE ROW — Workdash's project grid, as a table.

    FOUR DOCUMENTS JOINED ON THE HOST, and the join is the reason this is one
    card. The P&L names the ventures and carries their money; `/api/capture`
    carries the website and the date of its last photograph; Umami answers
    that host's pageviews; the uptime probe answers whether it is answering.
    A venture that is missing from three of the four still gets a row with its
    money in it, because a dash per column says which source is silent and a
    dropped row says nothing at all.

    DOWN FIRST, THEN BY WHAT IT EARNS. Workdash's rule exactly: attention
    floats and inside each band the revenue order stands. Nothing else
    reorders — a table that resorted itself as a probe flapped would be a
    table nobody can find a row in twice.

    THERE IS NO DEPLOY COLUMN. Workdash has one; this box records no
    deployment against a venture anywhere, so the last column is the date of
    the last front-page PHOTOGRAPH and is labelled as that. It is a weaker
    fact and it is a true one.
  */
  "overview.health": ({ profit: P, capture: C, umami: U, uptime: Up }: LiveInputs) => {
    if (!P?.ventures.length) return null;
    const shots = new Map((C?.ventures ?? []).map((v) => [v.id, v]));
    const rows = P.ventures.map((v) => {
      const shot = shots.get(v.venture.id) ?? null;
      const host = hostOf(shot?.website ?? null);
      const site = host ? (U?.websites ?? []).find((w) => hostOf(w.domain) === host) ?? null : null;
      const probe = host ? (Up?.hosts ?? []).find((h) => hostOf(h.host) === host) ?? null : null;
      /* The currency the venture EARNED in where it earned anything, and the
         one it spent the most in where it did not — so a venture with no
         revenue still quotes its cost rather than two dashes. */
      const earnedIn = v.revenueNet[0]?.currency.toUpperCase() ?? null;
      const line =
        (earnedIn ? v.margin.find((m) => m.currency.toUpperCase() === earnedIn) : null) ??
        [...v.margin].sort((a, b) => b.cost - a.cost)[0] ??
        null;
      return {
        venture: v.venture,
        down: probe?.current ? !probe.current.ok : false,
        probed: !!probe?.current,
        revenue: line ? line.revenue : null,
        currency: line?.currency ?? null,
        cost: line ? line.cost : null,
        views: site?.window?.pageviews ?? null,
        siteKnown: !!site,
        hostKnown: !!host,
        shotAt: shot?.picture?.ts ?? null,
        shotWhy: shot?.last?.error ?? null,
      };
    });
    rows.sort((a, b) => Number(b.down) - Number(a.down) || (b.revenue ?? 0) - (a.revenue ?? 0));
    const measured = rows.filter((r) => r.views !== null).length;
    /* UMAMI'S OWN SPAN IN THE COLUMN HEAD, read off the document rather than
       written here. The route follows the picker up to the ninety days the
       instance keeps, so a header that said "30d" would be wrong at every
       other setting — and this is the one column on the table that has a
       window at all. */
    const viewDays = U?.portfolio.window.days ?? null;
    return {
      tag: "measured",
      headers: [
        "Venture",
        "Net revenue",
        "Cost",
        viewDays === null ? "Pageviews" : `Pageviews · ${viewDays}d`,
        "Answering",
        "Last picture",
      ],
      table: rows.map((r) => [
        r.venture.name,
        r.currency && r.revenue !== null ? inCurrency(r.revenue, r.currency) : DASH,
        r.currency && r.cost !== null ? inCurrency(r.cost, r.currency) : DASH,
        r.views === null ? DASH : count(r.views),
        r.probed ? (r.down ? "down" : "up") : DASH,
        r.shotAt ? ago(r.shotAt) : DASH,
      ]),
      rowTones: rows.map((r): StatusTone | null => (r.down ? "bad" : null)),
      caption: also(
        `${count(rows.length)} venture${rows.length === 1 ? "" : "s"} from the ${monthName(P.month)} P&L, joined to Umami, the uptime probe and the screenshot run on each venture's own host; ${count(measured)} of them had traffic to report.`,
        "Money is the venture's own currency and is never added across rows. A dash is a " +
          "source that has nothing for this host — no Umami site, no probe, no photograph " +
          "yet — and never a zero. THE LAST COLUMN IS NOT A DEPLOY: nothing on this box " +
          "records a deployment against a venture, so it is the date of the last front-page " +
          "picture, which is a weaker claim and a true one.",
      ),
    };
  },

  /*
    THE FRONT PAGES THEMSELVES.

    The only card anywhere on this dashboard that answers "what does this
    thing look like" — which is the question a column of figures about a
    website cannot be made to answer, and the reason the `feed` kind exists.

    THE NEWEST GOOD PICTURE, NOT THE NEWEST ATTEMPT. `picture` is the last row
    that actually produced a file and `last` is the last row of any kind, so a
    venture whose site was down on Monday shows last week's photograph with
    last week's date under it rather than an empty frame. The age is on the
    item because the run is weekly: a fortnight means a run was missed or the
    captures are failing, and either way a month-old front page passed off as
    today's is a picture that lies.
  */
  "overview.shots": ({ capture: C }: LiveInputs) => {
    if (!C) return null;
    const withSites = C.ventures.filter((v) => v.website);
    if (!withSites.length) return null;
    const stale = (ts: string | null) =>
      ts !== null && Date.now() - Date.parse(ts) > 2 * C.refreshEveryDays * 86_400_000;
    const shot = withSites.filter((v) => v.picture).length;
    /* PHOTOGRAPHED FIRST, AND INSIDE EACH BAND THE OWNER'S OWN ORDER STANDS.
       The card is capped, and a cap that cut off the pictures in favour of the
       ventures that have none would be a picture card with no pictures on it.
       Nothing else reorders: within each band this is the order the ventures
       are in everywhere else in the app. */
    const ordered = [...withSites.filter((v) => v.picture), ...withSites.filter((v) => !v.picture)];
    const drawn = ordered.slice(0, SHOT_ITEMS);
    const more = ordered.length - drawn.length;
    return {
      tag: "measured",
      feed: drawn.map((v): FeedItem => ({
        title: v.name,
        text: v.picture
          ? v.website
          : (v.last?.error ??
            (C.browser.found
              ? "No picture yet — the weekly run has not reached this one."
              : `No picture: ${C.browser.error ?? "no browser was found on this box"}.`)),
        image: v.picture?.url ?? null,
        href: v.website,
        /* A FEED'S META PRINTS THE VALUE AND THEN THE LABEL — "1,204 views" —
           so the pair here has to read as a phrase in that order rather than
           as a field name with a date after it. */
        meta: v.picture
          ? [
              ["old", ageWords(v.picture.ageDays)] as [string, string],
              ...(v.picture.onDisk
                ? []
                : [["missing from disk", "file"] as [string, string]]),
            ]
          : [],
        /* ALREADY IN WORDS, like every other feed's. The item prints this
           verbatim, so an ISO stamp here would put "2026-09-05T13:48:45.378Z"
           at the top of nine rows — a machine's way of writing a date on a
           card whose whole point is that a person can look at it. */
        at: v.picture ? day(v.picture.ts) : undefined,
        /* Judged only where there is something to judge: a picture older than
           two refresh cycles, or a file the disk no longer has. A venture that
           has simply never been photographed is not a fault of the site's. */
        tone: v.picture && (stale(v.picture.ts) || !v.picture.onDisk) ? "warn" : undefined,
      })),
      caption: also(
        `${count(shot)} of ${count(withSites.length)} site${withSites.length === 1 ? "" : "s"} photographed, at ${C.browser.windowSize}, on a ${count(C.refreshEveryDays)}-day refresh${more > 0 ? `; ${count(more)} not drawn here` : ""}.`,
        "Each frame is the newest picture that actually came out, which is not always the " +
          "newest attempt: a failed run does not delete last week's photograph, so a date " +
          "older than the refresh means a run was missed rather than that the page has not " +
          "changed. Nothing here judges the picture — that is the screenshot QA pass, on the " +
          "Ops page.",
      ),
    };
  },
} satisfies Record<string, (d: LiveInputs) => Partial<Widget> | null>);
