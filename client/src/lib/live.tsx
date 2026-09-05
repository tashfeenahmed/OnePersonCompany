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
import { WIDGETS } from "@/data/widgets";
import {
  LIVE_BUILDERS,
} from "@/lib/liveWidgets";
import { ScopeContext, scopeLive } from "@/lib/scope";

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
  /** Which widget types are showing real data right now. */
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

export function LiveProvider({ children }: { children: ReactNode }) {
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
  const [tick, setTick] = useState(0);

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
    };
  }, []);

  useEffect(() => {
    let alive = true;

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
      } catch {
        return; // no API running; samples all round
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
      const tryFetch = async <T,>(want: boolean, get: () => Promise<T>, put: (v: T) => void) => {
        if (!want) return;
        try {
          const v = await get();
          if (alive) put(v);
        } catch {
          /* the cards fall back; a provider having a bad minute is not news */
        }
      };

      await tryFetch(hz && wanted.needsSummary, api.hetznerSummary, setHetzner);
      await tryFetch(hz && wanted.needsFleet, api.hetznerServers, (f) => setFleet(f.servers));
      await tryFetch(hz && wanted.needsLoad, () => api.hetznerLoad(LOAD_HOURS), setLoad);
      await tryFetch(hz && wanted.needsVolumes, api.hetznerVolumes, (v) => setVolumes(v.volumes));
      await tryFetch(libraries && wanted.needsStock, () => api.stock(), setStock);
      await tryFetch(registrars && wanted.needsDomains, api.domains, (d) => {
        setDomains(d.domains);
        setDomainSummary(d.summary);
      });
      /*
        ANY ONE OF THE THREE COST PROVIDERS IS ENOUGH TO ASK. The report is one
        document with a section each, and a section whose provider has never
        collected says so on its own — so fetching it with only OpenRouter
        connected gives a real, partial answer rather than an empty one. The
        window is the route's own default, because "what is this costing me" is
        a question about a month and three cards over three spans cannot be
        read together.
      */
      const spenders =
        connected.has("openai") ||
        connected.has("openrouter") ||
        connected.has("replicate");
      await tryFetch(spenders && wanted.needsCosts, () => api.costs(), setCosts);

      /*
        GitHub and npm are asked separately, because they are separate answers
        to separate questions and one being unconfigured must not empty the
        other's cards. npm in particular has NO CREDENTIAL: "connected" for it
        means a package list has been set, which is the only true reading
        available — with no list there is nothing to ask npm about, and with
        one it works immediately.
      */
      await tryFetch(
        connected.has("github") && wanted.needsGithub,
        () => api.github(),
        setGithub,
      );
      await tryFetch(
        connected.has("npm") && wanted.needsNpm,
        () => api.npm(),
        setNpm,
      );

      /*
        EITHER STORE IS ENOUGH TO ASK. The document has a section each and a
        section whose store has never collected says so on its own, so fetching
        it with only Google Play connected gives a real, partial answer — the
        same rule the costs report follows. An owner who ships on one platform
        is the ordinary case, not a degraded one.
      */
      await tryFetch(
        (connected.has("appstore") || connected.has("playstore")) && wanted.needsMobile,
        () => api.mobile(),
        setMobile,
      );

      await tryFetch(
        connected.has("stripe") && wanted.needsStripe,
        () => api.stripe(),
        setStripe,
      );
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
      await tryFetch(wanted.needsAdsense, () => api.adsense(), setAdsense);

      /*
        CLOUDFLARE IS FETCHED ONLY WHEN IT IS CONNECTED, unlike AdSense above.
        Its cards have nothing to say without a token — there is no
        "not authorised" state worth a card here, only a token that has not been
        pasted — so with none the cards keep their samples and wear no live dot.
        The window is the route's own default, because every zone card on a
        board has to be drawn over the same seven days or they cannot be read
        beside each other.
      */
      await tryFetch(
        connected.has("cloudflare") && wanted.needsCloudflare,
        () => api.cloudflare(),
        setCloudflare,
      );

      /*
        THE TWO SEARCH ENGINES ARE FETCHED SEPARATELY, and one being
        disconnected must not empty the other's cards. They are not two halves
        of one answer: Search Console reports what Google showed for pages that
        already rank, and Bing additionally answers how many people search a
        phrase nothing of ours ranks for. An owner with one of the two
        connected has a real answer to one real question.
      */
      await tryFetch(connected.has("gsc") && wanted.needsGsc, () => api.gsc(), setGsc);
      await tryFetch(
        connected.has("bing-webmaster") && wanted.needsBing,
        () => api.bing(),
        setBing,
      );

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
      await tryFetch(connected.has("meta") && wanted.needsMeta, () => api.meta(), setMeta);

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
      await tryFetch(
        (connected.has("reddit") ||
          connected.has("hackernews") ||
          connected.has("searxng")) &&
          wanted.needsDemand,
        () => api.demand(),
        setDemand,
      );

      /*
        EITHER MAIL PROVIDER IS ENOUGH TO ASK — the rule the costs report and
        both app stores follow. The document has a block each, and a block whose
        provider has never collected says so on its own: fetched with only
        Resend connected it gives every sending domain and an `inbox` whose
        figures are null rather than zero. Somebody who sends transactional mail
        and reads their own inbox elsewhere is an ordinary case, not a degraded
        one.
      */
      await tryFetch(
        (connected.has("gmail") || connected.has("resend")) && wanted.needsMail,
        () => api.mail(),
        setMail,
      );

      const pairs = await Promise.all(
        wanted.series.map(async (m) => {
          try {
            const r = await api.metric(m, 90);
            return [
              m,
              r.points.map((p) => ({ ts: p.ts, value: p.value })),
            ] as const;
          } catch {
            return [m, [] as Point[]] as const;
          }
        }),
      );
      if (alive)
        setMetrics(Object.fromEntries(pairs.filter(([, p]) => p.length)));
    })();

    return () => {
      alive = false;
    };
  }, [wanted, tick]);

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
      liveTypes,
      reload: () => setTick((t) => t + 1),
    };
  }, [
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
 * With no hosts (a venture with no website yet) this is a pass-through: the
 * board shows the whole portfolio and its header says so. Filtering everything
 * away because nobody has typed a URL would be an empty page pretending to be
 * a measurement.
 */
export function ScopeProvider({
  hosts,
  children,
}: {
  hosts: string[];
  children: ReactNode;
}) {
  const base = useLive();
  /* The hosts as a value rather than as an array: the page rebuilds the array
     on every render and only its contents decide whether the narrowing has to
     be done again. Narrowing is a pass over every report the page holds, so
     doing it once per change rather than once per render is the difference
     between a board that drags smoothly and one that does not. */
  const key = hosts.join(",");
  const value = useMemo(() => {
    const list = key ? key.split(",") : [];
    if (!list.length) return null;
    return {
      scope: { hosts: list, label: list.join(", "), base },
      live: scopeLive(base, list),
    };
  }, [base, key]);

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

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
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
    case "costs":
    case "openai":
    case "openrouter":
    case "replicate":
      return live.costs?.generatedAt ?? null;
    default:
      return null;
  }
}
