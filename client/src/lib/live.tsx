import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  type CostsReport,
  type Domain,
  type DomainSummary,
  type StockReport,
  type HetznerLoad,
  type HetznerServer,
  type HetznerSummary,
  type HetznerVolume,
  type Github,
  type Npm,
  type MobileReport,
  type StripeReport,
  type AdSenseReport,
  type CloudflareReport,
  type GscReport,
  type BingReport,
  type MetaReport,
  type MailReport,
  type DemandReport,
} from "@/lib/api";
import {
  reports,
  type AuditOverview,
  type BacklinksReport,
  type BlueskyReport,
  type CalendarReport,
  type FleetReport,
  type PresenceReport,
  type ProductsReport,
  type CompetitorsReport,
  type PypiReport,
  type RunsReport,
  type LlmReport,
  type UmamiReport,
  type UptimeReport,
} from "@/lib/api/reports";
import { WIDGETS } from "@/data/widgets";
import { finance as financeApi, type FinanceReport, type PortfolioPnl } from "@/lib/api/finance";
import { inboxApi, type InboxDoc } from "@/lib/api/inbox";
import { ventureApi, type CaptureReport } from "@/lib/api/ventures";
import { activityApi, type LeakageReport, type UsersReport } from "@/lib/api/activity";
import { customersApi, type DisputeDoc, type RecoveryQueue } from "@/lib/api/customers";
import { seoboard, type SeoOpsDocs } from "@/lib/api/seoboard";
import { socialboard, type SocialBoardDocs } from "@/lib/api/socialboard";
import { adsboard, type AdsBoardDocs } from "@/lib/api/adsboard";
import { mobilehealthboard, type MobileHealthDocs } from "@/lib/api/mobilehealthboard";
import { webanalyticsboard, type WebAnalyticsDocs } from "@/lib/api/webanalyticsboard";
import {
  LIVE_BUILDERS,
} from "@/lib/liveWidgets";
import { ScopeContext, scopeLive, type LinkedEntity } from "@/lib/scope";
import { useStore } from "@/lib/store";
import { DEFAULT_WINDOW, daysFor, type WindowValue } from "@/lib/window";

/**
 * Real numbers for the widgets that have them.
 *
 * Fetched ONCE for the whole board rather than per widget: a dashboard can hold
 * the same metric twice, and six cards each opening their own request to the
 * same endpoint is a burst the server does not need to see.
 *
 * A provider that is not connected, or an API that is not running, is not an
 * error here — it is the ordinary case for a catalog of 45 widgets of which two
 * are wired up. Those widgets fall back to their sample values and the card
 * says so, which is the whole point: a dashboard that cannot tell you which
 * numbers are real is worse than one with no numbers.
 */

export type Point = { ts: string; value: number };

export type LiveData = {
  metrics: Record<string, Point[]>;
  hetzner: HetznerSummary | null;
  fleet: HetznerServer[];
  /** What the boxes have been doing, over one window for the whole page. */
  load: HetznerLoad | null;
  volumes: HetznerVolume[];
  /** The domain portfolio, merged across every connected registrar. */
  domains: Domain[];
  domainSummary: DomainSummary | null;
  /** The stock libraries' remaining request allowance. */
  stock: StockReport | null;
  /** What the LLM and media providers cost, in one document. */
  costs: CostsReport | null;
  /** The repos, their fourteen-day traffic and the API budget left. */
  github: Github | null;
  /** Downloads by day and by ISO week, for the configured packages. */
  npm: Npm | null;
  /** Both app stores: store presence, installs, and the two kinds of money
   *  each of them reports — kept apart, per currency, never totalled. */
  mobile: MobileReport | null;
  /** What came in: the subscription book, the balance ledger and the
   *  attempts. Never added to the AdSense document below it. */
  stripe: StripeReport | null;
  /** Ad earnings — or the honest reason there are none. This one is fetched
   *  whether or not the plugin is connected, because "not authorised" is the
   *  answer its cards exist to show. */
  adsense: AdSenseReport | null;
  /** The zones, what they served over complete UTC days, and where each of
   *  them actually delegates. The one document on this page that joins two
   *  providers: Cloudflare knows the nameservers it assigned, the registrars
   *  know where the domain points, and neither of them knows the other. */
  cloudflare: CloudflareReport | null;
  /** Search Console: the properties, their finalised daily line, and how much
   *  of each property the ranked query rows actually cover. */
  gsc: GscReport | null;
  /** Bing Webmaster. Its own field beside Google's rather than folded into a
   *  "search" object, because there is no figure that spans the two: they
   *  count different searches on different networks. */
  bing: BingReport | null;
  /** Meta: the Pages, the ad account's window and daily line, and the
   *  Instagram answer — which on this account is "the token works and no
   *  Instagram Business account is linked to any Page". One field rather than
   *  two, because Instagram is a field on a Page and not an API of its own. */
  meta: MetaReport | null;
  /** Reddit, Hacker News and the search node, in ONE document — the opposite
   *  of the split `gsc` and `bing` take, and it passes the same test. A thread
   *  is a thread whichever site it was posted on, so the count spans the
   *  sources; upvotes never do, and the document says which is which. SearXNG
   *  rides along because it is the tier that answers a Reddit query the feed
   *  refuses, so "is the node well" is part of "how good is this Reddit
   *  answer". */
  demand: DemandReport | null;
  /** Mail: the mailboxes and the sending domains in ONE document, because the
   *  Email page asks one question of two ends of the same pipe. It takes the
   *  MobileReport shape rather than the `gsc`/`bing` split, and passes the same
   *  test in the other direction: an inbox thread waiting on a reply and a
   *  transactional password reset are not the same KIND of thing, so there is
   *  no arithmetic anybody would be tempted to perform across them. */
  mail: MailReport | null;

  /*
    THE NINE SECOND-WAVE REPORTS, EACH ITS OWN FIELD.

    Nothing is merged here. `demand` folds three sources into one field because
    they answer one question off one fetch; these are nine fetches from nine
    collectors on nine schedules, and a shared field would be half stale for
    half the page. The pair it is most tempting to join — `uptime` and `boxes`,
    both "is the machine well" — is the pair it would be worst to join: the
    probe asks over the public internet and the fleet asks over ssh, so they
    disagree about a box behind a broken proxy, and that disagreement is the
    finding rather than a conflict for a type to smooth over.
  */
  /** Umami: the websites, their last thirty complete days, the daily line and
   *  the truncated rankings. There is no portfolio visitor count in here and
   *  there cannot be one. */
  umami: UmamiReport | null;
  /** Google Calendar: today, the week ahead, merged busy hours. The one source
   *  on this page with no site on any row, so it is never narrowed. */
  calendar: CalendarReport | null;
  /** PyPI: downloads by day and by ISO week, mirrors excluded. */
  pypi: PypiReport | null;
  /** Bluesky: the handles and what their posts carry now. */
  bluesky: BlueskyReport | null;
  /** The uptime probe: what answered, how fast, and how long each certificate
   *  has left — from this machine, at whatever cadence it managed. */
  uptime: UptimeReport | null;
  /** The ssh fleet. NOT called `fleet`: that field above is Hetzner's server
   *  list, and these are two different populations — a Hetzner box with no ssh
   *  credential is in one and not the other, and half of these are somebody
   *  else's hardware. */
  boxes: FleetReport | null;
  /** Product endpoints and the figures mapped out of their own JSON. */
  products: ProductsReport | null;
  /** Inbound links per source, never summed across sources. */
  backlinks: BacklinksReport | null;
  /** The off-site footprint, product by directory. */
  presence: PresenceReport | null;

  /*
    THE THREE THIS BOX PRODUCES ITSELF.

    Not integrations. There is no credential behind an audit, a run or a
    competitor profile — the crawler runs here, the agent executes here, and
    the profiles are what those runs wrote into this database. Which is why
    they are fetched unconditionally below rather than gated on a plugin: there
    is nothing to connect, so "not connected" is not one of the answers, and a
    card of theirs showing samples means the WORK has not been done rather than
    that a token is missing.
  */
  /** Every venture's last crawl, one row each — never the crawl itself. */
  audit: AuditOverview | null;
  /** The run ledger: what is executing, what is queued, what finished. */
  runs: RunsReport | null;
  /** This box's own LLM use: tokens by day, model, work and venture. */
  llm: LlmReport | null;
  /** The rivals the sweeps accumulated, each with the date it was last
   *  VERIFIED rather than last written. */
  competitors: CompetitorsReport | null;
  /** The cost ledger, the renewals ahead and the electricity model — this
   *  box's own rate card, fetched unconditionally like the three above it. */
  finance: FinanceReport | null;

  /*
    THE THREE DOCUMENTS THE PAYMENTS BOARD READS BESIDE `stripe`, EACH ITS OWN
    FIELD. All three are computed from the Stripe tables on every request —
    the leakage buckets, the dispute cases and the recovery queue — so they
    are gated on the Stripe plugin below, not on a plugin of their own. They
    stay three fields rather than joining `stripe` because they are three
    fetches with three windows, and because two of them carry a figure that
    LOOKS like one on the Stripe document and must never be added to it: the
    dispute cases are dated by the bank, the ledger's dispute debit by the
    posting, and the leakage document says so on every row.
  */
  /** Where money is leaking out, per currency: refunds, disputes, declines,
   *  past-due subscriptions, coupons, abandoned checkouts. `combined: null`. */
  leakage: LeakageReport | null;
  /** The dispute cases beside the ledger's dispute money, kept apart. */
  disputes: DisputeDoc | null;
  /** The recovery queue: who is leaving, whose card is failing. */
  queue: RecoveryQueue | null;
  /** The four SEO documents this box computes itself — authority, AI
   *  visibility, follow-ups, IndexNow — fetched unconditionally like the
   *  ledger, each null on its own failure. See lib/api/seoboard. */
  seo: SeoOpsDocs | null;
  /** THE POSTS: the timeline read back from Meta, and the publishing queue
   *  beside it. Fetched unconditionally like the SEO bundle — both routes
   *  read tables this box writes. See lib/api/socialboard. */
  social: SocialBoardDocs | null;
  /** The three ads documents this box computes over Meta's own rows — the
   *  health rubric, the advertisements with their creatives, and the campaign
   *  → venture map. Gated on the Meta plugin, because all three read tables
   *  the Meta collector wrote. See lib/api/adsboard. */
  ads: AdsBoardDocs | null;
  /*
    THE OVERVIEW BOARD'S THREE, EACH ITS OWN FIELD AND EACH THIS BOX'S OWN.

    No plugin gates any of them, for the reason the audit, the runs and the
    ledger above are ungated: there is no credential behind a join over five
    of this box's tables, a month of its own arithmetic, or a folder of
    photographs it took. An empty answer is a real answer on all three —
    nothing is waiting, nothing has been billed, nothing has been captured —
    and the cards say so in those words.
  */
  /** What is waiting for the owner, actionable first, already filtered of
   *  everything resolved or snoozed. See lib/api/inbox. */
  inbox: InboxDoc | null;
  /** This month's portfolio P&L: every venture's revenue, cost and margin per
   *  currency, and the ledger's unallocated share beside them. */
  profit: PortfolioPnl | null;
  /** The newest photograph of each venture's front page, and the browser that
   *  did or did not take it. */
  capture: CaptureReport | null;
  /**
   * WHO SIGNED UP — one row per product endpoint publishing the users
   * contract, with the daily signup line, the paid split and the lastSeenAt
   * level beside each. Gated on the `users` plugin: there is a credential per
   * product behind it and asking with none connected returns an empty list,
   * which a board would draw as a portfolio with no users in it.
   *
   * ITS OWN FIELD BESIDE `products`, WHICH IS THE `gsc`/`bing` DECISION. The
   * product-stats endpoints publish figures the owner mapped out of their own
   * JSON — one of which is often called "total users" — and those are never
   * comparable with these: this document counts PEOPLE the same way for every
   * product, that one quotes whatever each product's admin page happens to
   * mean by the phrase. One field holding both would be one field away from a
   * card that added them.
   */
  users: UsersReport | null;
  /*
    THE TWO REPORTS THAT BECAME BOARDS.

    Each is a bundle of the documents a fixed tab on the Dashboards page used
    to draw, and each is its OWN field beside the source it sits nearest —
    `mobile` for the app stores' money, `umami` for the visitor counts —
    because they are collected by different collectors on different timers.
    One field for a pair would put one clock on two of them, which is the
    thing `collectedAt` below exists to keep honest.
  */
  /** Crashes, reviews, listing conversion, retention, install segments and
   *  version states. Gated on either store plugin, like `mobile`. */
  mobileHealth: MobileHealthDocs | null;
  /** Who the visitors were, what a bot heuristic would take off, and what the
   *  custom events recorded. Gated on Umami, whose rows it reads. */
  webAnalytics: WebAnalyticsDocs | null;
  /**
   * THE WINDOW EVERY DOCUMENT ABOVE WAS ASKED FOR — the picker's, from the
   * store. Carried here so a card can label itself and a builder can tell
   * "all" from ninety without a second path to the store. What each route
   * actually answered is in its own document (`window.days`, the complete
   * days that landed); see `daysFor` below for what "all" was turned into.
   */
  window: WindowValue;
  /** Which widget types are showing real data right now. */
  sourceStates: Record<string, "loading" | "disconnected" | "ready" | "error">;
  sourceErrors: Record<string, string>;
  loading: boolean;
  error: string | null;
  liveTypes: Set<string>;
  reload: () => void;
};

const LiveContext = createContext<LiveData>({
  metrics: {},
  hetzner: null,
  fleet: [],
  load: null,
  volumes: [],
  domains: [],
  domainSummary: null,
  stock: null,
  costs: null,
  github: null,
  npm: null,
  mobile: null,
  stripe: null,
  adsense: null,
  cloudflare: null,
  gsc: null,
  bing: null,
  meta: null,
  demand: null,
  mail: null,
  umami: null,
  calendar: null,
  pypi: null,
  bluesky: null,
  uptime: null,
  boxes: null,
  products: null,
  backlinks: null,
  presence: null,
  audit: null,
  runs: null,
  llm: null,
  competitors: null,
  finance: null,
  leakage: null,
  disputes: null,
  queue: null,
  seo: null,
  social: null,
  ads: null,
  inbox: null,
  profit: null,
  capture: null,
  users: null,
  mobileHealth: null,
  webAnalytics: null,
  window: DEFAULT_WINDOW,
  sourceStates: {}, sourceErrors: {},
  loading: true,
  error: null,
  liveTypes: new Set(),
  reload: () => {},
});

/**
 * The window the load cards are drawn over.
 *
 * ONE window for the page rather than a control per card. The question the
 * lines answer — "was anything busy last night" — is asked of the fleet, not
 * of a box, and nine per-card range switches is nine presses to compare two
 * machines over the same evening.
 */
export const LOAD_HOURS = 24;

/**
 * The most the ssh fleet's own route will answer, in days.
 *
 * Not a preference: `fleet_samples` is pruned at thirty days (see the retention
 * registry in integrations/ops/fleet.ts) and the route clamps `hours` at 720 to
 * match. "All time" over these boxes IS a month, and a card drawn over it says
 * a month rather than "all time".
 */
export const FLEET_MAX_DAYS = 30;

export function LiveProvider({ children }: { children: ReactNode }) {
  /*
    ONE WINDOW FOR EVERY FETCH BELOW. Each route used to be asked at its own
    default — Stripe thirty, Cloudflare seven, Search Console ninety — so two
    cards side by side were about different fortnights and nothing said so.
    The picker in the Dashboards header writes the store; this reads it, and a
    change refetches everything the boards need over the new span.
  */
  const { state: stored } = useStore();
  const selected: WindowValue = stored.dashboardWindow ?? DEFAULT_WINDOW;
  const [metrics, setMetrics] = useState<Record<string, Point[]>>({});
  const [hetzner, setHetzner] = useState<HetznerSummary | null>(null);
  const [fleet, setFleet] = useState<HetznerServer[]>([]);
  const [load, setLoad] = useState<HetznerLoad | null>(null);
  const [volumes, setVolumes] = useState<HetznerVolume[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domainSummary, setDomainSummary] = useState<DomainSummary | null>(null);
  const [stock, setStock] = useState<StockReport | null>(null);
  const [costs, setCosts] = useState<CostsReport | null>(null);
  const [github, setGithub] = useState<Github | null>(null);
  const [npm, setNpm] = useState<Npm | null>(null);
  const [mobile, setMobile] = useState<MobileReport | null>(null);
  const [stripe, setStripe] = useState<StripeReport | null>(null);
  const [adsense, setAdsense] = useState<AdSenseReport | null>(null);
  const [cloudflare, setCloudflare] = useState<CloudflareReport | null>(null);
  const [gsc, setGsc] = useState<GscReport | null>(null);
  const [bing, setBing] = useState<BingReport | null>(null);
  const [meta, setMeta] = useState<MetaReport | null>(null);
  const [demand, setDemand] = useState<DemandReport | null>(null);
  const [mail, setMail] = useState<MailReport | null>(null);
  const [umami, setUmami] = useState<UmamiReport | null>(null);
  const [calendar, setCalendar] = useState<CalendarReport | null>(null);
  const [pypi, setPypi] = useState<PypiReport | null>(null);
  const [bluesky, setBluesky] = useState<BlueskyReport | null>(null);
  const [uptime, setUptime] = useState<UptimeReport | null>(null);
  const [boxes, setBoxes] = useState<FleetReport | null>(null);
  const [products, setProducts] = useState<ProductsReport | null>(null);
  const [backlinks, setBacklinks] = useState<BacklinksReport | null>(null);
  const [presence, setPresence] = useState<PresenceReport | null>(null);
  const [audit, setAudit] = useState<AuditOverview | null>(null);
  const [runs, setRuns] = useState<RunsReport | null>(null);
  const [llm, setLlm] = useState<LlmReport | null>(null);
  const [competitors, setCompetitors] = useState<CompetitorsReport | null>(null);
  const [finance, setFinance] = useState<FinanceReport | null>(null);
  const [leakage, setLeakage] = useState<LeakageReport | null>(null);
  const [disputes, setDisputes] = useState<DisputeDoc | null>(null);
  const [queue, setQueue] = useState<RecoveryQueue | null>(null);
  const [seo, setSeo] = useState<SeoOpsDocs | null>(null);
  const [social, setSocial] = useState<SocialBoardDocs | null>(null);
  const [ads, setAds] = useState<AdsBoardDocs | null>(null);
  const [inbox, setInbox] = useState<InboxDoc | null>(null);
  const [profit, setProfit] = useState<PortfolioPnl | null>(null);
  const [capture, setCapture] = useState<CaptureReport | null>(null);
  const [users, setUsers] = useState<UsersReport | null>(null);
  const [mobileHealth, setMobileHealth] = useState<MobileHealthDocs | null>(null);
  const [webAnalytics, setWebAnalytics] = useState<WebAnalyticsDocs | null>(null);
  const [tick, setTick] = useState(0);
  const [sourceStates, setSourceStates] = useState<LiveData["sourceStates"]>({});
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setTick(t => t + 1); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("opc:data-changed", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("opc:data-changed", refresh); };
  }, []);

  const wanted = useMemo(() => {
    const series = new Set<string>();
    let needsSummary = false;
    let needsFleet = false;
    let needsLoad = false;
    let needsVolumes = false;
    let needsDomains = false;
    let needsStock = false;
    let needsCosts = false;
    let needsGithub = false;
    let needsNpm = false;
    let needsMobile = false;
    let needsStripe = false;
    let needsAdsense = false;
    let needsCloudflare = false;
    let needsGsc = false;
    let needsBing = false;
    let needsMeta = false;
    let needsDemand = false;
    let needsMail = false;
    let needsUmami = false;
    let needsCalendar = false;
    let needsPypi = false;
    let needsBluesky = false;
    let needsUptime = false;
    let needsBoxes = false;
    let needsProducts = false;
    let needsBacklinks = false;
    let needsPresence = false;
    let needsAudit = false;
    let needsRuns = false;
    let needsLlm = false;
    let needsCompetitors = false;
    let needsFinance = false;
    let needsLeakage = false;
    let needsDisputes = false;
    let needsQueue = false;
    let needsSeo = false;
    let needsSocial = false;
    let needsAds = false;
    let needsInbox = false;
    let needsProfit = false;
    let needsCapture = false;
    let needsUsers = false;
    let needsMobileHealth = false;
    let needsWebAnalytics = false;
    for (const w of Object.values(WIDGETS)) {
      if (w.live?.metric) series.add(w.live.metric);
      if (w.live?.summary) needsSummary = true;
      if (w.live?.fleet) needsFleet = true;
      if (w.live?.load) needsLoad = true;
      if (w.live?.volumes) needsVolumes = true;
      if (w.live?.domains) needsDomains = true;
      if (w.live?.stock) needsStock = true;
      if (w.live?.costs) needsCosts = true;
      if (w.live?.github) needsGithub = true;
      if (w.live?.npm) needsNpm = true;
      if (w.live?.mobile) needsMobile = true;
      if (w.live?.stripe) needsStripe = true;
      if (w.live?.adsense) needsAdsense = true;
      if (w.live?.cloudflare) needsCloudflare = true;
      if (w.live?.gsc) needsGsc = true;
      if (w.live?.bing) needsBing = true;
      if (w.live?.meta) needsMeta = true;
      if (w.live?.demand) needsDemand = true;
      if (w.live?.mail) needsMail = true;
      if (w.live?.umami) needsUmami = true;
      if (w.live?.calendar) needsCalendar = true;
      if (w.live?.pypi) needsPypi = true;
      if (w.live?.bluesky) needsBluesky = true;
      if (w.live?.uptime) needsUptime = true;
      if (w.live?.boxes) needsBoxes = true;
      if (w.live?.products) needsProducts = true;
      if (w.live?.backlinks) needsBacklinks = true;
      if (w.live?.presence) needsPresence = true;
      if (w.live?.audit) needsAudit = true;
      if (w.live?.runs) needsRuns = true;
      if (w.live?.llm) needsLlm = true;
      if (w.live?.competitors) needsCompetitors = true;
      if (w.live?.finance) needsFinance = true;
      if (w.live?.leakage) needsLeakage = true;
      if (w.live?.disputes) needsDisputes = true;
      if (w.live?.queue) needsQueue = true;
      if (w.live?.seo) needsSeo = true;
      if (w.live?.social) needsSocial = true;
      if (w.live?.ads) needsAds = true;
      if (w.live?.inbox) needsInbox = true;
      if (w.live?.profit) needsProfit = true;
      if (w.live?.capture) needsCapture = true;
      if (w.live?.users) needsUsers = true;
      if (w.live?.mobileHealth) needsMobileHealth = true;
      if (w.live?.webAnalytics) needsWebAnalytics = true;
    }
    return {
      series: [...series],
      needsSummary,
      needsFleet,
      needsLoad,
      needsVolumes,
      needsDomains,
      needsStock,
      needsCosts,
      needsGithub,
      needsNpm,
      needsMobile,
      needsStripe,
      needsAdsense,
      needsCloudflare,
      needsGsc,
      needsBing,
      needsMeta,
      needsDemand,
      needsMail,
      needsUmami,
      needsCalendar,
      needsPypi,
      needsBluesky,
      needsUptime,
      needsBoxes,
      needsProducts,
      needsBacklinks,
      needsPresence,
      needsAudit,
      needsRuns,
      needsLlm,
      needsCompetitors,
      needsFinance,
      needsLeakage,
      needsDisputes,
      needsQueue,
      needsSeo,
      needsSocial,
      needsAds,
      needsInbox,
      needsProfit,
      needsCapture,
      needsUsers,
      needsMobileHealth,
      needsWebAnalytics,
    };
  }, []);

  useEffect(() => {
    let alive = true;

    setLoading(true); setError(null); setSourceErrors({}); setSourceStates({});
      setMetrics({});
      setHetzner(null);
      setFleet([]);
      setLoad(null);
      setVolumes([]);
      setDomains([]);
      setDomainSummary(null);
      setStock(null);
      setCosts(null);
      setGithub(null);
      setNpm(null);
      setMobile(null);
      setStripe(null);
      setAdsense(null);
      setCloudflare(null);
      setGsc(null);
      setBing(null);
      setMeta(null);
      setDemand(null);
      setMail(null);
      setUmami(null);
      setCalendar(null);
      setPypi(null);
      setBluesky(null);
      setUptime(null);
      setBoxes(null);
      setProducts(null);
      setBacklinks(null);
      setPresence(null);
      setAudit(null);
      setRuns(null);
      setLlm(null);
      setCompetitors(null);
      setFinance(null);
      setLeakage(null);
      setDisputes(null);
      setQueue(null);
      setSeo(null);
      setAds(null);
      setInbox(null);
      setProfit(null);
      setCapture(null);
    void (async () => {
      /*
        WHICH PROVIDERS ARE ACTUALLY CONNECTED, asked once for the page.

        Asking first is what keeps a disconnected provider showing sample
        values rather than last week's fleet — and asking about all of them in
        ONE call rather than one call per provider is what stops a page with
        three integrations opening three requests before it has drawn anything.

        A provider's data is fetched only if that provider is connected. The
        domain cards do not care whether Hetzner is up, and the fleet cards do
        not care whether a registrar is: coupling them is how one plugin being
        disconnected empties an unrelated dashboard.
      */
      let connected = new Set<string>();
      try {
        const all = await api.plugins();
        connected = new Set(all.plugins.filter((p) => p.connected).map((p) => p.id));
      } catch (e) {
        if (alive) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
        return;
      }
      if (!alive) return;

      const hz = connected.has("hetzner");
      // Either registrar is enough: a portfolio with one of the two connected
      // is a real, partial portfolio, and the cards say how many registrars
      // answered rather than pretending to completeness.
      const registrars = connected.has("dynadot") || connected.has("spaceship");
      // Either library is enough: one connected stock account is a real, partial
      // answer, and the cards name which library they are talking about.
      const libraries = connected.has("pexels") || connected.has("pixabay");

      /** Fetch, or leave the state alone so the cards keep their samples. */
      const tasks: Promise<void>[] = [];
      const tryFetch = <T,>(want: boolean, get: () => Promise<T>, put: (v: T) => void, source: string) => {
        setSourceStates(s => ({ ...s, [source]: want ? "loading" : "disconnected" }));
        if (!want) return;
        tasks.push(Promise.resolve().then(get).then(v => {
          if (alive) { put(v); setSourceStates(s => ({ ...s, [source]: "ready" })); }
        }).catch(e => {
          if (alive) { setSourceStates(s => ({ ...s, [source]: "error" })); setSourceErrors(s => ({ ...s, [source]: e instanceof Error ? e.message : String(e) })); }
        }));
      };

      tryFetch(hz && wanted.needsSummary, api.hetznerSummary, setHetzner, "summary");
      tryFetch(hz && wanted.needsFleet, api.hetznerServers, (f) => setFleet(f.servers), "fleet");
      tryFetch(hz && wanted.needsLoad, () => api.hetznerLoad(LOAD_HOURS), setLoad, "load");
      tryFetch(hz && wanted.needsVolumes, api.hetznerVolumes, (v) => setVolumes(v.volumes), "volumes");
      tryFetch(libraries && wanted.needsStock, () => api.stock(daysFor(selected, 400)), setStock, "stock");
      tryFetch(registrars && wanted.needsDomains, api.domains, (d) => {
        setDomains(d.domains);
        setDomainSummary(d.summary);
      }, "domains");
      /*
        ANY ONE OF THE THREE COST PROVIDERS IS ENOUGH TO ASK. The report is one
        document with a section each, and a section whose provider has never
        collected says so on its own — so fetching it with only OpenRouter
        connected gives a real, partial answer rather than an empty one.

        EVERY WINDOWED ROUTE FROM HERE DOWN IS ASKED FOR THE PICKER'S SPAN,
        through `daysFor`, which turns "all" into the most that route will
        answer — its clamp, found in server/src/routes and the integrations'
        route files. A route whose figures are a LEVEL (a balance, the book)
        ignores the number, and a route whose window is its source's own
        (Meta's `last_30d`, Search Console's 28, GitHub's fourteen) keeps it
        and only widens its daily line; the cards for those say so.
      */
      const spenders =
        connected.has("openai") ||
        connected.has("openrouter") ||
        connected.has("replicate");
      tryFetch(spenders && wanted.needsCosts, () => api.costs(daysFor(selected, 400)), setCosts, "costs");

      /*
        GitHub and npm are asked separately, because they are separate answers
        to separate questions and one being unconfigured must not empty the
        other's cards. npm in particular has NO CREDENTIAL: "connected" for it
        means a package list has been set, which is the only true reading
        available — with no list there is nothing to ask npm about, and with
        one it works immediately.
      */
      tryFetch(
        connected.has("github") && wanted.needsGithub,
        () => api.github(),
        setGithub, "github");
      tryFetch(
        connected.has("npm") && wanted.needsNpm,
        () => api.npm(),
        setNpm, "npm");

      /*
        EITHER STORE IS ENOUGH TO ASK. The document has a section each and a
        section whose store has never collected says so on its own, so fetching
        it with only Google Play connected gives a real, partial answer — the
        same rule the costs report follows. An owner who ships on one platform
        is the ordinary case, not a degraded one.
      */
      tryFetch(
        (connected.has("appstore") || connected.has("playstore")) && wanted.needsMobile,
        () => api.mobile(daysFor(selected, 400)),
        setMobile, "mobile");

      tryFetch(
        connected.has("stripe") && wanted.needsStripe,
        /* "all" goes through as the word: the ledger reaches back to 2021 and
           the route measures that itself rather than taking a cap. */
        () => api.stripe(selected === "all" ? "all" : daysFor(selected, 400)),
        setStripe, "stripe");
      /*
        THE PAYMENTS BOARD'S THREE COMPANION DOCUMENTS, GATED ON STRIPE. Each
        is computed from the Stripe tables on every read — the leakage buckets
        in the Activity area, the dispute cases and the recovery queue in
        Customers — so with no Stripe key there is nothing behind them, and
        asking would return an empty document that reads as a quiet month.
        Their windows are the routes' own defaults, the same thirty days the
        Stripe document is asked for, so a card drawn from one can be read
        beside a card drawn from another.
      */
      tryFetch(
        connected.has("stripe") && wanted.needsLeakage,
        () => activityApi.leakage(daysFor(selected, 400)),
        setLeakage, "leakage");
      tryFetch(
        connected.has("stripe") && wanted.needsDisputes,
        () => customersApi.disputes(daysFor(selected, 400)),
        setDisputes, "disputes");
      tryFetch(
        connected.has("stripe") && wanted.needsQueue,
        () => customersApi.queue({ limit: 200 }),
        setQueue, "queue");
      /*
        ADSENSE IS ASKED WHETHER OR NOT IT IS CONNECTED, which is the one
        exception to the rule above and the reason for it: this route's most
        important answer is the one it gives when nothing has authorised it.
        It says which of three not-authorised states the integration is in and
        what would change that, and a card showing the fix is worth more than
        a card showing a sample. The earnings builders still return null in
        every one of those states, so nothing wears a live dot over numbers
        that were never read.
      */
      tryFetch(wanted.needsAdsense, () => api.adsense(daysFor(selected, 400)), setAdsense, "adsense");

      /*
        CLOUDFLARE IS FETCHED ONLY WHEN IT IS CONNECTED, unlike AdSense above.
        Its cards have nothing to say without a token — there is no
        "not authorised" state worth a card here, only a token that has not been
        pasted — so with none the cards keep their samples and wear no live dot.
        The route caps at ninety days and the document says how many complete
        days actually landed, which is what its cards quote under "all".
      */
      tryFetch(
        connected.has("cloudflare") && wanted.needsCloudflare,
        () => api.cloudflare(daysFor(selected, 90)),
        setCloudflare, "cloudflare");

      /*
        THE TWO SEARCH ENGINES ARE FETCHED SEPARATELY, and one being
        disconnected must not empty the other's cards. They are not two halves
        of one answer: Search Console reports what Google showed for pages that
        already rank, and Bing additionally answers how many people search a
        phrase nothing of ours ranks for. An owner with one of the two
        connected has a real answer to one real question.
      */
      /* Search Console's FIGURES are its own 28-day window ending three days
         back, whatever is asked; `days` only widens the daily line. Bing takes
         no window at all. Both are asked anyway so the line follows the picker
         where there is one. */
      tryFetch(connected.has("gsc") && wanted.needsGsc, () => api.gsc(daysFor(selected, 400)), setGsc, "gsc");
      tryFetch(
        connected.has("bing-webmaster") && wanted.needsBing,
        () => api.bing(),
        setBing, "bing");

      /*
        ONE FETCH FOR META AND INSTAGRAM, and Instagram is why it is gated on
        `meta` being connected rather than on an `instagram` plugin that does
        not exist here. Instagram rides on the same token — it is a field on a
        Page — so "is Instagram connected" has exactly the same answer as "is
        Meta connected", and a second flag would be a second thing to get out
        of step. With nothing connected the Instagram card keeps its sample and
        wears no live dot; with a token it says the true thing, which on this
        account is that no Instagram Business account is linked to any Page.
      */
      /* Meta's window figures are Meta's own `last_30d`; `days` widens the
         daily line only, and the cards say which is which. */
      tryFetch(connected.has("meta") && wanted.needsMeta, () => api.meta(daysFor(selected, 400)), setMeta, "meta");

      /*
        ANY ONE OF THE THREE DEMAND SOURCES IS ENOUGH TO ASK, the rule the
        costs report and the two app stores follow. The document has a section
        each and a section whose source has never collected says so on its own,
        so fetching it with only Hacker News configured gives a real, partial
        answer. The three genuinely do decouple: Hacker News needs no
        credential at all, Reddit's is optional and only lifts a throttle, and
        SearXNG's key is the one real credential of the three — and it is the
        one that keeps Reddit answering the day the Atom feed closes.
      */
      tryFetch(
        (connected.has("reddit") ||
          connected.has("hackernews") ||
          connected.has("searxng")) &&
          wanted.needsDemand,
        () => api.demand(daysFor(selected, 365)),
        setDemand, "demand");

      /*
        EITHER MAIL PROVIDER IS ENOUGH TO ASK — the rule the costs report and
        both app stores follow. The document has a block each, and a block whose
        provider has never collected says so on its own: fetched with only
        Resend connected it gives every sending domain and an `inbox` whose
        figures are null rather than zero. Somebody who sends transactional mail
        and reads their own inbox elsewhere is an ordinary case, not a degraded
        one.
      */
      tryFetch(
        (connected.has("gmail") || connected.has("resend")) && wanted.needsMail,
        () => api.mail(daysFor(selected, 400)),
        setMail, "mail");

      /*
        THE NINE SECOND-WAVE REPORTS.

        ONE FETCH EACH, GATED ON ITS OWN PLUGIN, and none of them coupled to a
        neighbour — the rule the whole block above follows, and the one that
        matters most here because five of the nine have no credential at all.
        "Connected" for PyPI, Bluesky, the uptime probe, the backlink sources
        and the presence checks means A LIST HAS BEEN TYPED: no key exists to
        paste, so a package list or a host list IS the configuration, and with
        one they work immediately. Coupling those five to anything would mean a
        dead Google token emptying a card about a certificate.

        Each windowed one is asked for the picker's span, through the same
        `daysFor` as the block above. Umami's collector stores ninety days of
        daily line and its headline figures are its own thirty complete days;
        the calendar is a look AHEAD and keeps its week; the probe and the
        fleet are asked in hours and keep their day.
      */
      tryFetch(
        connected.has("umami") && wanted.needsUmami,
        () => reports.umami(daysFor(selected, 90)),
        setUmami, "umami");
      tryFetch(
        connected.has("calendar") && wanted.needsCalendar,
        () => reports.calendar(),
        setCalendar, "calendar");
      tryFetch(
        connected.has("pypi") && wanted.needsPypi,
        () => reports.pypi(),
        setPypi, "pypi");
      tryFetch(
        connected.has("bluesky") && wanted.needsBluesky,
        () => reports.bluesky(daysFor(selected, 400)),
        setBluesky, "bluesky");
      tryFetch(
        connected.has("uptime") && wanted.needsUptime,
        () => reports.uptime(),
        setUptime, "uptime");
      /*
        THE FLEET FOLLOWS THE PICKER, IN HOURS. Its route takes `hours` and
        clamps at 720, which is exactly the thirty days `fleet_samples` is
        pruned to — so "all time" here is a month and the document's own
        `window.hours` is what the cards caption from. A half-hourly probe over
        thirty days is a large document and it is the honest one: the per-box
        memory, CPU and load lines are drawn from these rows and nothing else
        holds them.
      */
      tryFetch(
        connected.has("fleet") && wanted.needsBoxes,
        () => reports.fleet(daysFor(selected, FLEET_MAX_DAYS) * 24),
        setBoxes, "boxes");
      /* The plugin id is `product-stats`; the field, the source and the widget
         keys are all `products`. Written out here rather than renamed at either
         end, because the server's id is the server's and a rename in this file
         would be a rename that only this file knows about. */
      tryFetch(
        connected.has("product-stats") && wanted.needsProducts,
        () => reports.products(daysFor(selected, 400)),
        setProducts, "products");
      tryFetch(
        connected.has("backlinks") && wanted.needsBacklinks,
        () => reports.backlinks(),
        setBacklinks, "backlinks");
      tryFetch(
        connected.has("presence") && wanted.needsPresence,
        () => reports.presence(),
        setPresence, "presence");

      /*
        THE THREE THAT ARE ASKED FOR UNCONDITIONALLY.

        Every fetch above is gated on a plugin, because every one of them is
        somebody else's API and asking a provider nobody has authorised is a
        request that can only fail. These three are this box's own tables, so
        there is no plugin id that would gate them and no state where the
        question is unaskable. An empty answer is a real answer here: it means
        nothing has been crawled, run or swept yet, which is a thing the cards
        say in those words rather than falling back to a sample of somebody
        else's numbers.

        They still sit inside the plugins call above, which is deliberate: that
        call is also the page's test for whether there is an API at the other
        end at all. With the server down there is nothing to ask and the whole
        board keeps its samples, which is the honest first screen.
      */
      tryFetch(wanted.needsAudit, () => reports.audit(), setAudit, "audit");
      tryFetch(wanted.needsRuns, () => reports.runs(), setRuns, "runs");
      /* No plugin gates this one: the ledgers are this box's own. */
      tryFetch(wanted.needsLlm, () => reports.llm(daysFor(selected, 400)), setLlm, "llm");
      tryFetch(
        wanted.needsCompetitors,
        () => reports.competitors(),
        setCompetitors, "competitors");
      /* The ledger is this box's own too: seeded from Hetzner and the
         registrars, typed into on the Finance page, and never behind a
         credential of its own. */
      tryFetch(wanted.needsFinance, () => financeApi.report(), setFinance, "finance");
      /* This box's own SEO arithmetic, receipts and verdicts: no plugin gates
         it, and a route of the four failing leaves its field null alone. */
      tryFetch(wanted.needsSeo, () => seoboard.docs(), setSeo, "seo");
      /* The posts and the publishing queue. Ungated for the reason the SEO
         bundle is: both routes read tables this box writes, so there is no
         plugin id in front of them and an empty answer is a real answer —
         "no Page has been mapped to a venture yet", which the cards say in
         those words. */
      tryFetch(wanted.needsSocial, () => socialboard.docs(), setSocial, "social");
      /* THE ADS BUNDLE RIDES ON THE META PLUGIN, because all three of its
         documents are arithmetic over rows the Meta collector wrote. Without
         the token there is nothing to score, no advertisement to draw and no
         campaign to map — and three cards showing samples is the honest state,
         exactly as it is for /api/meta itself. The ad-level daily table is
         retained on the day-grained schedule, so 90 is the most it answers. */
      tryFetch(
        connected.has("meta") && wanted.needsAds,
        () => adsboard.docs(daysFor(selected, 90)),
        setAds,
        "ads",
      );
      /*
        THE OVERVIEW BOARD'S THREE, ASKED FOR UNCONDITIONALLY.

        No plugin gates any of them, for the reason the audit, the run ledger
        and the finance ledger above are ungated: the inbox is a join over
        five of this box's own tables, the P&L is arithmetic over rows it
        already holds, and the captures are pictures it took itself. There is
        no credential to be missing and therefore no "not connected" state to
        draw — an empty answer means nothing is waiting, nothing has been
        billed or nothing has been photographed, which the cards say in words.

        NONE OF THE THREE TAKES A WINDOW, so none is asked for one. The inbox
        is a list of things nobody has answered yet, the P&L answers for one
        calendar month, and a photograph has a date rather than a span; all
        three wear "now" in the catalog and say why.
      */
      tryFetch(wanted.needsInbox, () => inboxApi.open(), setInbox, "inbox");
      tryFetch(wanted.needsProfit, () => financeApi.portfolio(), setProfit, "profit");
      tryFetch(wanted.needsCapture, () => ventureApi.capture(), setCapture, "capture");
      /*
        THE USERS ROLL-UP, GATED ON ITS OWN PLUGIN. One account per product
        endpoint, each with a URL the owner pasted, so with nothing connected
        the route answers an empty product list — which every card on the Users
        board would draw as a portfolio nobody has signed up to. The route
        clamps at 400 days and measures the daily signup line, the active count
        and the returned count over whatever it is asked for; the two `new`
        windows inside it are fixed at 7 and 30 by the contract's own
        vocabulary and the cards that read them say so.
      */
      tryFetch(
        connected.has("users") && wanted.needsUsers,
        () => activityApi.users(daysFor(selected, 400)),
        setUsers,
        "users",
      );

      /*
        THE TWO REPORTS THAT BECAME BOARDS.

        EITHER STORE IS ENOUGH FOR THE FIRST, the rule `mobile` above it
        follows: the bundle has a document per report and a store that has
        never answered says so on its own, so an owner who ships on one
        platform gets a real, partial answer rather than an empty one. This
        area ingests sixty days at most; a wider ask is answered over sixty and
        every card built from it captions the span the route actually returned.

        THE SECOND IS GATED ON UMAMI because it reads Umami's own rows — the
        segments are a second cut of the same sessions, taken by a rotation of
        its own. Its route cuts at SEVEN OR THIRTY DAYS and nothing else (the
        bot heuristics are calibrated to those two), so ninety and "all" are
        drawn over thirty and the cards say so beside the figures.
      */
      tryFetch(
        (connected.has("appstore") || connected.has("playstore")) && wanted.needsMobileHealth,
        () => mobilehealthboard.docs(daysFor(selected, 60)),
        setMobileHealth,
        "mobilehealth",
      );
      tryFetch(
        connected.has("umami") && wanted.needsWebAnalytics,
        () => webanalyticsboard.docs(selected === 7 ? 7 : 30),
        setWebAnalytics,
        "webanalytics",
      );

      await Promise.all(tasks);
      const pairs = await Promise.all(
        wanted.series.map(async (m) => {
          const source = `metric:${m}`;
          if (!connected.has(m.split(".")[0]!)) { if (alive) setSourceStates(s => ({ ...s, [source]: "disconnected" })); return [m, [] as Point[]] as const; }
          if (alive) setSourceStates(s => ({ ...s, [source]: "loading" }));
          try {
            /* The readings table is this box's own and holds what has been
               collected since the metric existed; four hundred days is the
               route's cap and further than any of it goes. */
            const r = await api.metric(m, daysFor(selected, 400));
            if (alive) setSourceStates(s => ({ ...s, [source]: "ready" }));
            return [
              m,
              r.points.map((p) => ({ ts: p.ts, value: p.value })),
            ] as const;
          } catch (error) {
            if (alive) { setSourceStates(s => ({ ...s, [source]: "error" })); setSourceErrors(s => ({ ...s, [source]: error instanceof Error ? error.message : String(error) })); }
            return [m, [] as Point[]] as const;
          }
        }),
      );
      if (alive) { setMetrics(Object.fromEntries(pairs.filter(([, p]) => p.length))); setLoading(false); }
    })();

    return () => {
      alive = false;
    };
  }, [wanted, tick, selected]);

  const value = useMemo<LiveData>(() => {
    // A widget is live when its builder can actually answer with what arrived.
    // Asking the builder rather than guessing from the spec means a widget
    // never wears the live dot while showing its sample values.
    const liveTypes = new Set<string>();
    for (const type of Object.keys(WIDGETS)) {
      const build = LIVE_BUILDERS[type];
      if (!build) continue;
      const patch = build({
        points: metrics[WIDGETS[type]!.live?.metric ?? ""] ?? [],
        summary: hetzner,
        fleet,
        load,
        volumes,
        domains,
        domainSummary,
        github,
        npm,
        costs,
        stock,
        mobile,
        stripe,
        adsense,
        cloudflare,
        gsc,
        bing,
        meta,
        demand,
        mail,
        umami,
        calendar,
        pypi,
        bluesky,
        uptime,
        boxes,
        products,
        backlinks,
        presence,
        audit,
        runs,
        llm,
        competitors,
        finance,
        leakage,
        disputes,
        queue,
        seo,
        social,
        ads,
        inbox,
        profit,
        capture,
        users,
        mobileHealth,
        webAnalytics,
        window: selected,
      });
      if (patch) liveTypes.add(type);
    }
    return {
      metrics,
      hetzner,
      fleet,
      load,
      volumes,
      domains,
      domainSummary,
      costs,
      github,
      npm,
      stock,
      mobile,
      stripe,
      adsense,
      cloudflare,
      gsc,
      bing,
      meta,
      demand,
      mail,
      umami,
      calendar,
      pypi,
      bluesky,
      uptime,
      boxes,
      products,
      backlinks,
      presence,
      audit,
      runs,
      llm,
      competitors,
      finance,
      leakage,
      disputes,
      queue,
      seo,
      social,
      ads,
      inbox,
      profit,
      capture,
      users,
      mobileHealth,
      webAnalytics,
      window: selected,
      sourceStates, sourceErrors, loading, error, liveTypes,
      reload: () => setTick((t) => t + 1),
    };
  }, [
    selected,
    sourceStates, sourceErrors, loading, error,
    metrics,
    hetzner,
    fleet,
    load,
    volumes,
    domains,
    domainSummary,
    costs,
    stock,
    github,
    npm,
    mobile,
    stripe,
    adsense,
    cloudflare,
    gsc,
    bing,
    meta,
    demand,
    mail,
    umami,
    calendar,
    pypi,
    bluesky,
    uptime,
    boxes,
    products,
    backlinks,
    presence,
    audit,
    runs,
    llm,
    competitors,
    finance,
    leakage,
    disputes,
    queue,
    seo,
    social,
    ads,
    inbox,
    profit,
    capture,
    users,
    mobileHealth,
    webAnalytics,
  ]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export const useLive = () => useContext(LiveContext);

/**
 * ONE VENTURE'S SLICE OF ALL OF IT.
 *
 * Wrapped around a venture's dashboard, this re-provides the SAME context the
 * cards already read, holding data narrowed to that venture's hosts — so no
 * widget, no chart and no builder needs to know that scoping exists. That is
 * the whole reason it is done here rather than by passing a filter down: there
 * are ninety widgets, and a prop threaded through all of them would be
 * forgotten by one of them within a week.
 *
 * The unscoped document goes into the scope beside the hosts, because the
 * cards that CANNOT be narrowed — a Hetzner bill, a Cloudflare daily line —
 * draw from it and say "portfolio" in their header. See lib/scope.ts for which
 * those are and why.
 *
 * THE VENTURE'S LINKS COME IN BESIDE ITS HOSTS, and either of them is enough.
 * A link is the owner having said "this zone belongs to that venture", which
 * is a stronger statement than a hostname that happens to match — and the only
 * statement there is for a thing with no hostname at all, like a fleet box. So
 * a venture with links and no website narrows properly instead of falling
 * through to the whole portfolio.
 *
 * With NEITHER (a venture with no website and nothing linked) this is a
 * pass-through: the board shows the whole portfolio and its header says so.
 * Filtering everything away because nobody has typed a URL would be an empty
 * page pretending to be a measurement.
 */
export function ScopeProvider({
  hosts,
  entities = [],
  children,
}: {
  hosts: string[];
  /** The venture's link rows. Optional so a caller with none — and every
   *  caller had none until the link table existed — stays valid. */
  entities?: LinkedEntity[];
  children: ReactNode;
}) {
  const base = useLive();
  /* The hosts and links as VALUES rather than as arrays: the page rebuilds both
     arrays on every render and only their contents decide whether the narrowing
     has to be done again. Narrowing is a pass over every report the page holds,
     so doing it once per change rather than once per render is the difference
     between a board that drags smoothly and one that does not. */
  const key = hosts.join(",");
  const linkKey = entities.map((e) => `${e.plugin} ${e.entity}`).join(",");
  const value = useMemo(() => {
    const list = key ? key.split(",") : [];
    const links: LinkedEntity[] = linkKey
      ? linkKey.split(",").map((pair) => {
          /* Split on the FIRST space only: a plugin id never contains one and
             an entity — a Bing site, a path — may. */
          const at = pair.indexOf(" ");
          return { plugin: pair.slice(0, at), entity: pair.slice(at + 1) };
        })
      : [];
    if (!list.length && !links.length) return null;
    return {
      scope: {
        hosts: list,
        entities: links,
        /* The hosts name the scope wherever there are any: the hostname is
           what the owner calls this, and "7 links" is a count the board's own
           sub-line already carries. A venture with no website is named by the
           only thing it has — what it has been linked to. */
        label:
          list.join(", ") ||
          `${links.length} linked ${links.length === 1 ? "thing" : "things"}`,
        base,
      },
      live: scopeLive(base, list, links),
    };
  }, [base, key, linkKey]);

  if (!value) return <>{children}</>;
  return (
    <ScopeContext.Provider value={value.scope}>
      <LiveContext.Provider value={value.live}>{children}</LiveContext.Provider>
    </ScopeContext.Provider>
  );
}

/**
 * A percentage change, or null when the window is too short to mean anything.
 *
 * Two readings taken a minute apart can differ for reasons that are not a
 * trend — a corrected price, a box rebooting — and rendering that as "+6.4%"
 * is a confident lie. A day is the shortest span this will call a change.
 */
export function deltaOver(points: Point[]): number | null {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const spanMs = Date.parse(last.ts) - Date.parse(first.ts);
  if (spanMs < 86_400_000 || !first.value) return null;
  return Number((((last.value - first.value) / first.value) * 100).toFixed(1));
}

/**
 * When the numbers from one SOURCE were collected.
 *
 * Every source is read on its own schedule — Hetzner's fleet every half hour,
 * GitHub's traffic every six, the registrars whenever they are asked — so one
 * timestamp cannot speak for all of them. Both the live dot on a card and the
 * line under a board's title used to quote Hetzner's on everything, which was
 * right on the servers board and a plain untruth on an OpenRouter card.
 *
 * Null means this source does not report when it was read, and the callers say
 * so rather than borrowing a neighbour's clock: "not reported" is a smaller
 * failure than a confident time belonging to a different provider.
 */
export function collectedAt(src: string, live: LiveData): string | null {
  switch (src) {
    case "hetzner":
      return live.hetzner?.seenAt ?? live.load?.sampledAt ?? null;
    case "registrars":
    case "dynadot":
    case "spaceship":
      return live.domainSummary?.seenAt ?? null;
    case "github":
      return live.github?.summary.seenAt ?? null;
    case "npm":
      return live.npm?.summary.seenAt ?? null;
    case "pexels":
    case "pixabay":
      // The newest reading across the library's accounts. Two keys are read in
      // the same pass, so this is one clock and not an average of two.
      return (
        live.stock?.libraries
          .find((l) => l.library === src)
          ?.accounts.map((a) => a.seenAt)
          .filter((at): at is string => !!at)
          .sort()
          .at(-1) ?? null
      );
    case "appstore":
    case "play":
    case "playstore":
    case "mobile":
      return live.mobile?.generatedAt ?? null;
    case "stripe":
      /* When the book and the balance were last READ, not when this document
         was assembled: the route recomputes every figure on every request, so
         its own timestamp would say "just now" for numbers collected an hour
         ago. */
      return live.stripe?.seenAt ?? null;
    case "adsense":
      return live.adsense?.seenAt ?? null;
    /*
      THE ROLL-UP IS AS FRESH AS ITS STALEST INPUT.

      `revenue` is not a provider — it is Stripe plus both stores plus AdSense
      added up (see the source note in data/widgets), so there is no single
      collector to quote. The OLDEST of the clocks behind it is the honest
      age: a combined figure carrying yesterday's Play export is a figure from
      yesterday however recently Stripe was read, and quoting the newest of
      the four would date the addition to its freshest part.

      Only the sources that actually answered are considered — a store nobody
      has connected is a line in the breakdown saying so, not an infinitely
      old reading that would peg this to the epoch.
    */
    case "revenue":
      return (
        [live.stripe?.seenAt, live.mobile?.generatedAt, live.adsense?.seenAt]
          .filter((at): at is string => !!at)
          .sort()[0] ?? null
      );
    case "cf":
    case "cloudflare":
      /* When the ZONES were last collected, not when this document was built.
         The route recomputes every total per request, so its own timestamp
         would read "just now" over numbers Cloudflare answered six hours ago. */
      return live.cloudflare?.seenAt ?? null;
    case "gsc":
      /* When the properties were last READ, not when this document was
         assembled: the route recomputes every window on every request, so its
         own timestamp would say "just now" over figures collected six hours
         ago — and over days Google finalised three days before that. */
      return live.gsc?.seenAt ?? null;
    case "bing":
      return live.bing?.seenAt ?? null;
    case "meta":
    case "instagram":
      /* Both sources read ONE document, so both quote one clock — and it is
         when Meta was last READ rather than when the route assembled its
         answer, which it does on every request. Instagram is filed here rather
         than getting its own case because there is no second fetch behind it:
         its state is a field on the Pages this timestamp dates. */
      return live.meta?.seenAt ?? null;
    /*
      THE ADS BUNDLE QUOTES META'S CLOCK, not its own. All three of its
      documents are arithmetic over rows the Meta collector wrote, and the
      arithmetic runs on every request — dating a health score to "just now"
      over figures collected six hours ago would be the one thing this case
      exists to prevent. The newest ad account `seenAt` is when Meta was last
      read, which is when any of it last changed.
    */
    case "ads":
      return (
        live.ads?.health?.accounts
          .map((a) => a.account.seenAt)
          .sort()
          .at(-1) ??
        live.meta?.seenAt ??
        null
      );
    case "reddit":
    case "hn":
    case "searxng":
    case "demand":
      /* When a SOURCE was last asked, not when this document was assembled —
         the route recomputes every window per request, so its own timestamp
         would say "just now" over threads read six hours ago. Each of the
         three has its own clock: Reddit's list is spread across runs, Hacker
         News is asked whole, and the node is probed once. So a Reddit card and
         a Hacker News card can honestly disagree about when they were read,
         and they should. */
      return src === "reddit"
        ? (live.demand?.reddit.seenAt ?? null)
        : src === "hn"
          ? (live.demand?.hn.seenAt ?? null)
          : src === "searxng"
            ? (live.demand?.searxng.seenAt ?? null)
            : (live.demand?.generatedAt ?? null);
    case "gmail":
    case "resend":
    case "mail":
      /* Both mail sources read ONE document, so both quote one clock — and it
         is when the mail was last READ rather than when the route assembled its
         answer, which it does on every request. Gmail and Resend are filed
         together here for the reason the two app stores are: one fetch behind
         them, and a second case would be a second thing to keep in step. */
      return live.mail?.seenAt ?? null;
    /*
      THE NINE SECOND-WAVE SOURCES, EACH QUOTING ITS OWN COLLECTOR.

      Every one of these routes recomputes its figures on every request, so the
      document's own timestamp would read "just now" over numbers collected six
      hours ago. What each case returns is when the SOURCE was last read.
    */
    case "umami":
      /* The newest reading across the websites: they are read in one pass, so
         this is one clock rather than an average of several. */
      return (
        live.umami?.websites
          .map((w) => w.seenAt)
          .filter((at): at is string => !!at)
          .sort()
          .at(-1) ?? null
      );
    case "calendar":
      return (
        live.calendar?.accounts
          .map((a) => a.lastReadAt ?? a.lastOkAt)
          .filter((at): at is string => !!at)
          .sort()
          .at(-1) ?? null
      );
    case "pypi":
      return live.pypi?.summary.seenAt ?? null;
    case "bluesky":
      return (
        live.bluesky?.handles
          .map((h) => h.profile.seenAt)
          .filter((at): at is string => !!at)
          .sort()
          .at(-1) ?? null
      );
    case "uptime":
      /* When the last CHECK was made, which is the only clock these cards
         have: there is no collection pass behind them, only observations. */
      return live.uptime?.summary.lastCheckedAt ?? null;
    case "fleet":
      return live.boxes?.totals.seenAt ?? null;
    case "products":
      return live.products?.summary.lastFetchedAt ?? null;
    /* WHEN A PRODUCT ENDPOINT WAS LAST FETCHED, not when the route added the
       figures up — it recomputes every window per request, so its own clock
       would say "just now" over a document a product served this morning. The
       newest fetch across the endpoints, because one stale product does not
       make the whole roll-up stale and the per-product cards say which. */
    case "users":
      return live.users?.summary.lastFetchedAt ?? null;
    case "backlinks":
      return live.backlinks?.summary.seenAt ?? null;
    case "presence":
      return live.presence?.summary.checkedAt ?? null;
    /*
      THE THREE THIS BOX PRODUCES, EACH QUOTING WHEN THE WORK WAS DONE.

      There is no collector behind these and therefore no collection time. What
      each returns is when the last piece of WORK finished — the newest crawl,
      the newest run event, the newest sweep — which is the only clock they
      have and the one a reader means by "how old is this". A route that
      assembled its answer a second ago has not made the June sweep any newer.
    */
    case "audit":
      return (
        live.audit?.ventures
          .map((v) => v.ts)
          .filter((ts): ts is string => !!ts)
          .sort()
          .at(-1) ?? null
      );
    case "llm":
      return live.llm?.generatedAt ?? null;
    case "runs":
      /* A run's own newest event, not the ledger's: a queued run is news, and
         quoting the last FINISHED run would date the card to before the thing
         that is happening now. */
      return (
        live.runs?.runs
          .flatMap((r) => [r.finishedAt, r.startedAt, r.queuedAt])
          .filter((ts): ts is string => !!ts)
          .sort()
          .at(-1) ?? null
      );
    case "competitors":
      /* When a SWEEP last ran, which is not when any one profile was last
         verified — a sweep that did not name a rival left that rival's date
         alone, and the row carries its own. */
      return live.competitors?.lastRun ?? null;
    case "costs":
    case "openai":
    case "openrouter":
    case "replicate":
      return live.costs?.generatedAt ?? null;
    case "finance":
      return live.finance?.summary.generatedAt ?? null;
    /*
      THE FOUR SEO DOCUMENTS, EACH QUOTING ITS OWN CLOCK — never the moment
      the bundle was assembled, which is "just now" for every one of them.
      Authority and IndexNow are computed on the read, so their own stamp is
      the honest one; the AI answers and the follow-ups are dated by the
      newest row, which is when the work was actually done.
    */
    case "authority":
      return live.seo?.authority ? live.seo.fetchedAt : null;
    case "geo":
      return live.seo?.geo?.answers.map((a) => a.ts).sort().at(-1) ?? null;
    case "seoops":
      return (
        live.seo?.followups?.baselines
          .flatMap((b) => [b.baseline?.at ?? null, ...b.followUps.map((f) => f.at)])
          .filter((at): at is string => !!at)
          .sort()
          .at(-1) ?? null
      );
    case "indexing":
      return live.seo?.indexing?.hosts.map((h) => h.last?.at ?? "").filter(Boolean).sort().at(-1) ?? null;
    /*
      THE POSTS, DATED BY WHEN META WAS LAST ASKED — never by when this bundle
      was assembled, which is always "just now". The timeline collector runs on
      its own six-hourly clock, so `lastReadAt` is the honest age of every
      figure on the Social board; a board fetched a second ago over a read from
      this morning is a board from this morning.
    */
    case "social":
      return live.social?.posts?.lastReadAt ?? null;
    /*
      THE TWO REPORTS THAT BECAME BOARDS, each dated by ITS OWN COLLECTOR and
      never by the moment its bundle was assembled — which is "just now" on
      every read, over crash figures Google generated overnight and a country
      ranking taken half a day ago.

      Mobile health quotes the newest of the two stores' collection times, and
      the readiness card is where a reader sees them apart. Web analytics
      quotes the ROTATION'S read of the site its segments were drawn for,
      because that is the figure on the card — the events beside it come from
      every site and are as old as the oldest of them, which is a thing this
      one clock cannot say and the events card says for itself.
    */
    case "mobilehealth":
      return (
        live.mobileHealth?.readiness?.lastCollected
          .map((c) => c.at)
          .filter((at): at is string => !!at)
          .sort()
          .at(-1) ?? null
      );
    case "webanalytics":
      return live.webAnalytics?.site?.readAt ?? null;
    default:
      return null;
  }
}
