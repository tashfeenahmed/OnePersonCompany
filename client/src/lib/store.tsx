import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { PLUGINS } from "@/data/plugins";
import { DASHBOARD_PRESETS, WIDGETS } from "@/data/widgets";

/**
 * Ventures, sessions and dashboards.
 *
 * A VENTURE is one launched thing — an app, a site, a product — with its own
 * domain, its own revenue and its own life. The word is deliberate: these are
 * not folders, and "project" undersold what each of them actually is.
 *
 * SESSIONS ARE NOT FILED UNDER VENTURES. They are one flat list, because most
 * chats are about nothing in particular — a DNS question, a half-remembered
 * error — and forcing every one of them to pick a home is how a rail fills up
 * with folders holding one thing each. A session MAY name a venture, and the
 * ventures page uses that to show what has been asked about it; the rail
 * ignores it and just lists them, newest first.
 *
 * The one nesting that survives is real work rather than filing: a chat that
 * dispatched sub-agent runs owns those runs, so they hang off it.
 *
 * Held in one place and mirrored to localStorage so the prototype behaves like
 * the real thing across reloads. Every mutation returns a new object rather
 * than editing in place — the sidebar and the page it sits beside read the same
 * state, and one of them mutating silently is how they end up disagreeing.
 */

export type Venture = {
  id: string;
  name: string;
  desc: string;
  color: string;
};

export type Session = {
  id: string;
  title: string;
  /** A venture this was about, when it was about one. */
  ventureId?: string | null;
  /** Runs this chat dispatched — sub-agent work, mostly. */
  children?: { id: string; title: string }[];
  /**
   * A SEEDED SESSION THAT HAS NOT YET BEEN CHECKED AGAINST THE SERVER.
   *
   * The rail shipped with twelve invented chats. They named no conversation —
   * the transcripts live in the server's `chat_messages` and none of those
   * twelve had any — so they are removed, and this flag is how that is done
   * SAFELY rather than by deleting twelve ids and hoping.
   *
   * The problem is that `migrate()` runs synchronously against localStorage
   * and cannot know which sessions have real history: that is a fact on the
   * server, one fetch away. And at least one of the seeded ids DOES have
   * history — `s-1` was the store's starting `activeSessionId`, so the first
   * real conversation anybody had on this dashboard was stored under it.
   * Deleting by id would throw that away.
   *
   * So it is two steps. `migrate()` marks; `reconcileSessions()`, which has
   * the server's list in hand, sweeps — dropping the marked ones the server
   * has never heard of and clearing the mark on the ones it has. A rail that
   * cannot reach the API keeps all twelve, which is the correct failure: not
   * knowing whether a chat is real is not a reason to delete it.
   *
   * Absent on every session the owner made, and gone from the seeded ones
   * after the first successful reconcile. It is a migration state, not a
   * property of a chat.
   */
  seeded?: boolean;
};

export type PlacedWidget = {
  id: string;
  /** Key into WIDGETS. */
  type: string;
  /** Column span on the four-column grid: 1, 2 or 4. */
  w: 1 | 2 | 4;
};

export type Dashboard = {
  id: string;
  /**
   * The board's address: /dashboards/<slug>.
   *
   * SET ONCE, AT CREATION, AND NEVER CHANGED BY A RENAME. A dashboard is a
   * thing you link to and come back to — from a bookmark, from a second
   * window, from the browser's own history — and renaming "Morning check" to
   * "Daily" should not quietly break every one of those. The name is what the
   * board is called; the slug is where it lives, and they are allowed to drift.
   */
  slug: string;
  name: string;
  widgets: PlacedWidget[];
};

export type Workspace = {
  /** Shown under the owner's name in the rail. */
  name: string;
  owner: string;
  /** The venture a new chat starts against, or null for none. */
  defaultVentureId: string | null;
};

export type StoreState = {
  /** Which generation of the seeded CONTENT this state has had applied. Bumped
   *  when a new starter dashboard ships, so it can be added without discarding
   *  what the owner has made. */
  seedVersion?: number;
  workspace: Workspace;
  /** Which integrations are connected, by plugin id. The catalog carries the
   *  starting answer; this carries what has been changed since. */
  plugins: Record<string, boolean>;
  ventures: Venture[];
  sessions: Session[];
  dashboards: Dashboard[];
  activeSessionId: string | null;
  /**
   * The Apps strip in the owner's order, by slug. Optional and absent on an
   * older state: the registry's own order is the default, and a slug that no
   * longer exists is dropped at read time rather than migrated away. Apps are
   * code; only their order is the owner's.
   */
  appOrder?: string[];
};

export const VENTURE_COLORS = [
  "#c1663f",
  "#635bff",
  "#2f7d4f",
  "#3b7bd8",
  "#a8446f",
  "#a86524",
  "#4a4842",
];

// v5: plugin connection state moved out of the Plugins page and into here, so
// the index and a plugin's own page cannot disagree about it.
const KEY = "opc-state-v5";

/*
  v5 adds the Costs board. Bumped rather than edited in place because the
  starter dashboards are a GIFT and not a template: migrate() hands over the
  boards a state has never been offered, exactly once, so a board the owner
  deleted stays deleted and one they have reshaped stays reshaped.
*/
/*
  v10 retires the twelve invented sessions. They were the last mock left in the
  rail: titles with no conversation behind them, sitting beside real
  transcripts on the server and indistinguishable from them until you clicked.
  See `Session.seeded` for why removing them takes two steps and a fetch rather
  than a `filter` here.
*/
export const SEED_VERSION = 10;

/**
 * The sessions the seed invented, by id — the exact list, because the removal
 * is by id and a pattern like /^s-\d+$/ would also match a real chat if `uid`
 * ever produced one.
 *
 * The four children are in here too. They are the sub-agent runs nested under
 * two of the twelve, and the NESTING ITSELF STAYS: `Session.children` and the
 * sidebar's indented rendering are kept exactly as they were, because a chat
 * that dispatches sub-agent runs is what the rail is going to want to show
 * next. What goes is the invented data, not the shape that held it.
 */
const SEEDED_SESSION_IDS = new Set([
  "s-1",
  "s-2",
  "s-3",
  "s-3a",
  "s-3b",
  "s-4",
  "s-5",
  "s-6",
  "s-6a",
  "s-6b",
  "s-7",
  "s-8",
  "s-9",
  "s-10",
  "s-11",
  "s-12",
]);

const SEED: StoreState = {
  seedVersion: SEED_VERSION,
  workspace: { name: "Solo workspace", owner: "Alex", defaultVentureId: null },

  plugins: Object.fromEntries(PLUGINS.map((p) => [p.id, p.connected])),

  ventures: [
    {
      id: "v-example-support",
      name: "Example Support",
      color: "#c1663f",
      desc: "Support chatbot sold as a drop-in widget. Engine, site and pricing.",
    },
    {
      id: "v-example-video",
      name: "Example Video",
      color: "#635bff",
      desc: "Long video in, short-form reels out. Mobile app, API and the marketing site.",
    },
    {
      id: "v-example-app-1",
      name: "Example App 1",
      color: "#2f7d4f",
      desc: "Planning-permission search for Ireland. Subscription, one market.",
    },
    {
      id: "v-example-content",
      name: "example.ie",
      color: "#3b7bd8",
      desc: "The oldest one. Content site, ad revenue, almost no maintenance.",
    },
  ],

  /*
    NO SESSIONS. The rail starts empty and fills with conversations that
    actually happened.

    It used to ship with twelve — "Pricing table variants", "Stripe webhook
    retries", ten more — from when the Chat page was a mock and a title in the
    rail was the whole feature. The page is real now: the transcripts live on
    the server, the rail reconciles against them on load, and a title with no
    conversation behind it is a row that opens onto an empty screen. Worse, it
    is indistinguishable from a real chat until you click one.

    An empty rail on a fresh install is the honest first screen. The greeting
    and the four openers are already there to say what to do with it.
  */
  sessions: [],

  dashboards: [
    {
      id: "d-morning",
      slug: "morning-check",
      name: "Morning check",
      widgets: [
        { id: "w1", type: "stripe.mrr", w: 1 },
        { id: "w2", type: "stripe.churn", w: 1 },
        { id: "w3", type: "hetzner.spend", w: 1 },
        { id: "w4", type: "uptime.status", w: 1 },
        { id: "w5", type: "gsc.clicks", w: 2 },
        { id: "w6", type: "github.commits", w: 2 },
      ],
    },
    {
      id: "d-hetzner",
      slug: "hetzner",
      name: "Hetzner",
      widgets: [
        { id: "hw1", type: "hetzner.spend", w: 2 },
        { id: "hw2", type: "hetzner.serverCount", w: 1 },
        { id: "hw3", type: "hetzner.avgCost", w: 1 },
        { id: "hw4", type: "hetzner.servers", w: 2 },
        { id: "hw5", type: "hetzner.arch", w: 2 },
        { id: "hw6", type: "hetzner.fleet", w: 2 },
        { id: "hw7", type: "hetzner.spendSplit", w: 2 },
        { id: "hw8", type: "hetzner.byPlan", w: 2 },
        { id: "hw9", type: "hetzner.byLocation", w: 2 },
        { id: "hw10", type: "hetzner.specs", w: 2 },
        { id: "hw11", type: "hetzner.age", w: 1 },
        { id: "hw12", type: "hetzner.ipv4", w: 1 },
      ],
    },
    /*
      SERVERS. Modelled on the fleet page in workdash: the four figures first,
      then the fleet's own line, then every box as a meter, then the numbers
      behind the pictures. The difference is what can be measured — Hetzner
      reports from the hypervisor, so this has CPU, network and disk throughput
      and no memory or filesystem meter. Those need something running inside
      the guest, and a meter that cannot be measured is not drawn.
    */
    {
      id: "d-servers",
      slug: "servers",
      name: "Servers",
      widgets: [
        { id: "sv1", type: "hetzner.fleetCpu", w: 1 },
        { id: "sv2", type: "hetzner.busiest", w: 1 },
        { id: "sv3", type: "hetzner.serverCount", w: 1 },
        { id: "sv4", type: "hetzner.spend", w: 1 },
        { id: "sv5", type: "hetzner.load", w: 4 },
        { id: "sv6", type: "hetzner.cpuMeters", w: 2 },
        { id: "sv7", type: "hetzner.servers", w: 1 },
        { id: "sv8", type: "hetzner.arch", w: 1 },
        { id: "sv9", type: "hetzner.figures", w: 4 },
        { id: "sv10", type: "hetzner.traffic", w: 2 },
        { id: "sv11", type: "hetzner.diskWrite", w: 2 },
        { id: "sv12", type: "hetzner.quiet", w: 2 },
        { id: "sv13", type: "hetzner.volumes", w: 2 },
        { id: "sv14", type: "hetzner.specs", w: 2 },
        { id: "sv15", type: "hetzner.age", w: 2 },
      ],
    },
    /*
      DOMAINS. The portfolio as workdash's own page reads it: the counts, then
      the renewal horizon — every name as a length on one axis, which is the
      only way "5 Dec" and "3 Feb" become a distance without arithmetic — then
      the list of what actually wants doing, then the table behind it.

      Merged across both registrars, because "what renews next" is a question
      about the portfolio and answering it from one registrar's rows would be
      answering a different question.
    */
    {
      id: "d-domains",
      slug: "domains",
      name: "Domains",
      widgets: [
        { id: "dm1", type: "registrars.total", w: 1 },
        { id: "dm2", type: "registrars.lapsed", w: 1 },
        { id: "dm3", type: "registrars.expiring", w: 1 },
        { id: "dm4", type: "registrars.autoRenewOff", w: 1 },
        { id: "dm5", type: "registrars.runway", w: 4 },
        { id: "dm6", type: "registrars.attention", w: 2 },
        { id: "dm7", type: "registrars.security", w: 2 },
        { id: "dm8", type: "registrars.table", w: 4 },
        { id: "dm9", type: "registrars.byTld", w: 2 },
        { id: "dm10", type: "registrars.nameservers", w: 2 },
        { id: "dm11", type: "registrars.byRegistrar", w: 2 },
        { id: "dm12", type: "registrars.newest", w: 2 },
      ],
    },
    /*
      COSTS. What the whole operation charges for itself — and the board that
      had to decide what to do about currency.

      IT OFFERS NO SINGLE TOTAL, ON PURPOSE. OpenAI, OpenRouter and Replicate
      bill in US dollars; Hetzner bills in euro, net of VAT. Adding them would
      need a real, dated exchange rate that nothing here fetches, so the
      figures sit beside each other with their own units and the side-by-side
      card says in its last row that no total is offered. Two right numbers
      beat one confident wrong one.

      IT ALSO SHOWS WHAT CANNOT BE ANSWERED. Replicate publishes no billing
      API at all — no spend endpoint, no price on a prediction, no rates on
      its hardware list — so the board carries its compute time in seconds and
      a card listing what was asked about money and what came back. The closing
      card is that evidence, at full width, because a costs page that quietly
      omitted a provider would be read as the whole bill.
    */
    {
      id: "d-costs",
      slug: "costs",
      name: "Costs",
      widgets: [
        { id: "cs1", type: "costs.llm", w: 1 },
        { id: "cs2", type: "hetzner.spend", w: 1 },
        { id: "cs3", type: "openrouter.credits", w: 1 },
        { id: "cs4", type: "replicate.compute", w: 1 },
        { id: "cs5", type: "costs.sideBySide", w: 2 },
        { id: "cs6", type: "costs.byProvider", w: 2 },
        { id: "cs7", type: "costs.limits", w: 2 },
        { id: "cs8", type: "hetzner.spendSplit", w: 2 },
        { id: "cs9", type: "openai.cost", w: 1 },
        { id: "cs10", type: "openrouter.spend", w: 1 },
        { id: "cs11", type: "replicate.runs", w: 1 },
        { id: "cs12", type: "replicate.health", w: 1 },
        { id: "cs13", type: "openai.daily", w: 2 },
        { id: "cs14", type: "openai.projects", w: 2 },
        { id: "cs15", type: "openrouter.models", w: 2 },
        { id: "cs16", type: "openrouter.totals", w: 2 },
        { id: "cs17", type: "openrouter.keys", w: 2 },
        { id: "cs18", type: "openrouter.free", w: 2 },
        { id: "cs19", type: "replicate.models", w: 2 },
        { id: "cs20", type: "replicate.outputs", w: 2 },
        { id: "cs21", type: "replicate.noCost", w: 4 },
      ],
    },
    /*
      REVENUE. What the whole operation actually earns, from four sources that
      report money four different ways.

      THE ORDER IS AN ARGUMENT. Stripe first and at the top, because it is the
      business — $788.87 of MRR against Play's $170 a month and an App Store
      that has never been paid out at all. Putting the four stores on equal
      footing would give three of them a quarter of the page each and flatter
      them enormously.

      ESTIMATE AND PAYOUT SIT SIDE BY SIDE, DELIBERATELY. Apple's daily sales
      report and Google's sales export are previews; Apple's finance report and
      Google's earnings export are the money that lands. They are next to each
      other so the gap between them is legible, and they are never added — see
      `estimateVsPayout` on /api/mobile.

      NO TOTAL IS OFFERED and none should be. Ten currencies appear across these
      cards and this box fetches no exchange rate, so a single "revenue" figure
      would be a confident lie about the one number a reader would trust most.
    */
    {
      id: "d-revenue",
      slug: "revenue",
      name: "Revenue",
      widgets: [
        { id: "rv1", type: "stripe.mrr", w: 1 },
        { id: "rv2", type: "stripe.arr", w: 1 },
        { id: "rv3", type: "stripe.subs", w: 1 },
        { id: "rv4", type: "stripe.churn", w: 1 },
        { id: "rv5", type: "stripe.gross", w: 4 },
        { id: "rv6", type: "stripe.net30", w: 1 },
        { id: "rv7", type: "stripe.fees", w: 1 },
        { id: "rv8", type: "stripe.pending", w: 1 },
        { id: "rv9", type: "stripe.payouts", w: 1 },
        { id: "rv10", type: "mobile.sideBySide", w: 2 },
        { id: "rv11", type: "play.revenue", w: 2 },
        { id: "rv12", type: "appstore.payout", w: 2 },
        { id: "rv13", type: "appstore.proceeds", w: 2 },
        { id: "rv14", type: "stripe.products", w: 2 },
        { id: "rv15", type: "stripe.mix", w: 2 },
        { id: "rv16", type: "stripe.churnNotChurn", w: 2 },
        { id: "rv17", type: "stripe.declines", w: 2 },
        { id: "rv18", type: "play.split", w: 2 },
        { id: "rv19", type: "adsense.earnings", w: 1 },
        // The access card stays even though the money card is beside it now:
        // it is where a silence explains itself. If the Cloud consent screen is
        // still in Testing the refresh token dies in seven days, and this is
        // the card that says so rather than the earnings quietly going flat.
        { id: "rv20", type: "adsense.access", w: 1 },
        { id: "rv21", type: "adsense.rpm", w: 2 },
        { id: "rv22", type: "mobile.presence", w: 2 },
      ],
    },
    /*
      SEARCH. The two engines side by side and never added together.

      Google and Bing count different searches on different networks, so an
      "impressions" total across both would be a number in no unit — the same
      reason the two live behind two routes rather than one. They sit in the
      same row instead, which lets the eye do the comparison the arithmetic
      cannot: 60,912 impressions at 3.75% on Google against 28,732 at 11.68% on
      Bing is a real finding, and it survives only while the two stay apart.

      The coverage card is not decoration. Google's ranked query rows carry
      about a fifth of the impressions the property totals report — it withholds
      queries too rare to anonymise — so a reader who sums the query column and
      trusts it is out by a factor of five. That card is where the discrepancy
      is explained rather than discovered.
    */
    {
      id: "d-search",
      slug: "search",
      name: "Search",
      widgets: [
        { id: "se1", type: "gsc.impressions", w: 1 },
        { id: "se2", type: "gsc.clicks", w: 1 },
        { id: "se3", type: "bing.impressions", w: 1 },
        { id: "se4", type: "bing.clicks", w: 1 },
        { id: "se5", type: "gsc.trend", w: 4 },
        { id: "se6", type: "gsc.position", w: 1 },
        { id: "se7", type: "bing.index", w: 1 },
        { id: "se8", type: "gsc.coverage", w: 2 },
        { id: "se9", type: "gsc.queries", w: 2 },
        { id: "se10", type: "bing.queries", w: 2 },
        { id: "se11", type: "gsc.striking", w: 2 },
        { id: "se12", type: "gsc.movers", w: 2 },
        { id: "se13", type: "gsc.sites", w: 4 },
        { id: "se14", type: "gsc.pages", w: 2 },
        { id: "se15", type: "gsc.sitemaps", w: 2 },
        { id: "se16", type: "bing.keywords", w: 2 },
        { id: "se17", type: "bing.backlinks", w: 2 },
        { id: "se18", type: "bing.sites", w: 4 },
        { id: "se19", type: "bing.trend", w: 2 },
        { id: "se20", type: "bing.crawl", w: 2 },
      ],
    },

    /*
      TRAFFIC & DNS. What the edge actually served, and whether the names in
      front of it point where they should.

      The pairing card gets the full width because it is the one thing on this
      board neither Cloudflare's console nor a registrar's can show: it is a
      JOIN, and it needs both sides connected. Seven zones here are registered
      somewhere this dashboard cannot read, and five registered names have no
      zone at all — findings that are invisible from either end alone.
    */
    {
      id: "d-traffic",
      slug: "traffic",
      name: "Traffic & DNS",
      widgets: [
        { id: "tr1", type: "cf.total", w: 1 },
        { id: "tr2", type: "cf.zones", w: 1 },
        { id: "tr3", type: "cf.bandwidth", w: 1 },
        { id: "tr4", type: "cf.threats", w: 1 },
        { id: "tr5", type: "cf.daily", w: 4 },
        { id: "tr6", type: "cf.visitors", w: 4 },
        { id: "tr7", type: "cf.requests", w: 2 },
        { id: "tr8", type: "cf.responses", w: 2 },
        { id: "tr9", type: "cf.unmatched", w: 4 },
        { id: "tr10", type: "cf.dns", w: 2 },
        { id: "tr11", type: "cf.email", w: 2 },
        { id: "tr12", type: "cf.cacheRatio", w: 1 },
        { id: "tr13", type: "cf.records", w: 1 },
        { id: "tr14", type: "cf.cannot", w: 2 },
        { id: "tr15", type: "cf.table", w: 4 },
      ],
    },
    {
      id: "d-growth",
      slug: "growth",
      name: "Growth",
      /*
        Paid and organic on one board, because the question is the same one:
        where does attention come from. Search demand at the top (Google's own
        report and Bing's, kept apart), then what the ads bought, then what the
        Pages have without paying.

        There is no separate Social board. One ad account spending €61.90 and
        three Pages with 360 followers between them do not fill a page, and a
        board built to look full would be padding — these cards belong beside
        the search ones they compete with for the same attention.
      */
      widgets: [
        { id: "w7", type: "gsc.impressions", w: 2 },
        { id: "w8", type: "bing.keywords", w: 2 },
        { id: "w9", type: "meta.spend", w: 1 },
        { id: "w10", type: "meta.leads", w: 1 },
        { id: "w11", type: "meta.reach", w: 1 },
        { id: "w12", type: "meta.roas", w: 1 },
        { id: "w13", type: "meta.daily", w: 4 },
        { id: "w14", type: "meta.campaigns", w: 4 },
        { id: "w15", type: "meta.pages", w: 2 },
        { id: "w16", type: "instagram.followers", w: 2 },
        { id: "w17", type: "meta.cannot", w: 2 },
        { id: "w18", type: "hn.mentions", w: 2 },
      ],
    },
  ],
  /* Null, and it has to be: there is no session to be active in. The Chat
     page reads null as "a new chat" and creates one on the first message. */
  activeSessionId: null,
};

export function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A widget's natural width: a single number reads fine narrow, a list needs
 *  the room, and a chart or a six-column table needs the whole grid. */
export function defaultWidth(type: string): 1 | 2 | 4 {
  const kind = WIDGETS[type]?.kind;
  if (kind === "metric") return 1;
  if (kind === "chart" || kind === "table" || kind === "runway") return 4;
  return 2;
}

/** A name as a URL segment. Anything that is not a letter, a digit or a dash
 *  becomes a dash, and a name with nothing usable in it still gets an address
 *  rather than an empty one. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "board";
}

/** The same, with a numeric suffix when the address is already taken — two
 *  boards may share a name, but they cannot share a URL. */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Enough of a shape check that a hand-edited or foreign file is refused
 *  rather than half-loaded into a blank page. */
export function isStoreState(v: unknown): v is StoreState {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<StoreState>;
  return (
    !!s.workspace &&
    typeof s.workspace.name === "string" &&
    !!s.plugins &&
    typeof s.plugins === "object" &&
    Array.isArray(s.ventures) &&
    Array.isArray(s.sessions) &&
    Array.isArray(s.dashboards)
  );
}

function load(): StoreState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoreState;
      if (isStoreState(parsed)) return migrate(parsed);
    }
  } catch {
    /* unreadable or absent — the seed is a fine starting point */
  }
  return structuredClone(SEED);
}

/**
 * Bring older state forward without discarding it.
 *
 * TWO STEPS THAT RUN ON DIFFERENT SCHEDULES, which is why they are not one
 * `if`. Giving every board an address is a REPAIR: it has to run on any state
 * that reaches here without one, whatever version stamp it carries, or a board
 * saved by an older build has no URL and cannot be opened. Offering a new
 * starter dashboard is a GIFT and must happen exactly once — appending it on
 * every load would resurrect a board the owner had deliberately deleted, and
 * `seedVersion` is the record that it has already been offered.
 */
function migrate(state: StoreState): StoreState {
  let dashboards = state.dashboards;

  // Repair: an address for every board, unique across the set. Existing slugs
  // are claimed first so a board that already has one keeps it.
  if (dashboards.some((d) => !d.slug)) {
    const taken = new Set(dashboards.map((d) => d.slug).filter(Boolean));
    dashboards = dashboards.map((d) => {
      if (d.slug) return d;
      const slug = uniqueSlug(d.name, taken);
      taken.add(slug);
      return { ...d, slug };
    });
  }

  if ((state.seedVersion ?? 0) >= SEED_VERSION)
    return dashboards === state.dashboards ? state : { ...state, dashboards };

  /*
    MARK THE TWELVE INVENTED SESSIONS FOR REMOVAL — mark, not delete, and the
    difference is the whole safety of this step.

    This function runs against localStorage before anything has been fetched,
    so it cannot answer the only question that matters: does this session have
    a real conversation in it? At least one of them does. `s-1` was the seed's
    own `activeSessionId`, which means the first thing anybody ever said on
    this dashboard was stored under that id and is sitting in the server's
    transcript table right now. A `filter` by id here would take the title off
    a real chat and leave the words orphaned.

    So this only sets a flag, and `reconcileSessions` — which has the server's
    list — does the sweeping. It is gated on `seedVersion` like every other
    gift-or-repair here, so a chat the owner has since renamed to one of these
    titles, or a session marked once and kept because it had history, is never
    marked again.

    RENAMED SESSIONS ARE LEFT ALONE ENTIRELY. A seeded id whose title no longer
    matches the seeded title is a row the owner has touched, and a row the
    owner has touched is theirs whatever it started as.
  */
  const sessions = state.sessions.map((s) =>
    SEEDED_SESSION_IDS.has(s.id) && SEEDED_SESSION_TITLES.get(s.id) === s.title
      ? { ...s, seeded: true }
      : s,
  );

  // Gift: whichever starter boards this state has never been offered.
  const have = new Set(dashboards.map((d) => d.id));
  const taken = new Set(dashboards.map((d) => d.slug));
  const added = SEED.dashboards
    .filter((d) => !have.has(d.id))
    .map((d) => {
      const board = structuredClone(d);
      // The owner may have made their own "Servers" board already; the seed
      // does not get to take an address that is in use.
      board.slug = uniqueSlug(board.slug, taken);
      taken.add(board.slug);
      return board;
    });

  /*
    TOPPING UP A BOARD THE OWNER ALREADY HAS.

    The gift above only adds boards whose id is ABSENT, which is right — it is
    what stops a deleted board coming back every load. But it means editing a
    seed never reaches anyone who already received it, and that is exactly the
    case here: the Revenue board was seeded while AdSense was unconnected, so it
    carried a card explaining the absence and none of the earnings.

    So: a named, ADDITIVE top-up. It only ever appends widgets that are missing,
    never removes, reorders or resizes anything — an arrangement somebody has
    moved around is theirs, and the worst this can do is put a card at the end
    that they are free to delete. It is gated by the same seedVersion, so it
    runs once and a card removed on purpose stays removed.
  */
  const topped = (added.length ? [...dashboards, ...added] : dashboards).map((d) => {
    const wanted = TOP_UPS[d.id];
    if (!wanted) return d;
    const have = new Set(d.widgets.map((w) => w.type));
    const missing = wanted.filter((type) => !have.has(type));
    if (!missing.length) return d;
    return {
      ...d,
      widgets: [
        ...d.widgets,
        ...missing.map((type) => ({ id: uid("w"), type, w: defaultWidth(type) })),
      ],
    };
  });

  return {
    ...state,
    seedVersion: SEED_VERSION,
    sessions,
    dashboards: topped,
  };
}

/**
 * The titles the seeded sessions shipped with, keyed by id.
 *
 * Kept as data rather than read out of `SEED.sessions`, because the seed no
 * longer HAS these sessions — it ships an empty rail now. A migration has to
 * be able to recognise what an older build wrote long after the current build
 * has stopped writing it, which is the same reason a database migration never
 * refers to the current schema.
 */
const SEEDED_SESSION_TITLES = new Map<string, string>([
  ["s-1", "Pricing table variants"],
  ["s-2", "Stripe webhook retries"],
  ["s-3", "Competitor sweep before the rewrite"],
  ["s-3a", "Competitors — AI video tools"],
  ["s-3b", "Demand — what r/editing asked for"],
  ["s-4", "Domain DNS check"],
  ["s-5", "Render queue backpressure"],
  ["s-6", "Why is example.ie sliding on brand terms"],
  ["s-6a", "SEO — crawl and Search Console"],
  ["s-6b", "AI visibility — what the models say"],
  ["s-7", "Council CSV import"],
  ["s-8", "Widget bundle size"],
  ["s-9", "Notes on onboarding"],
  ["s-10", "Weekly digest cron"],
  ["s-11", "App Store review notes"],
  ["s-12", "Hero copy rewrite"],
]);


/**
 * Widgets a seeded board should have gained since it was first handed out.
 *
 * Keyed by board id, appended only if absent. Add to a list here when a newly
 * connected provider means an existing board is now missing something real —
 * not to redesign a board somebody is already using.
 */
const TOP_UPS: Record<string, string[]> = {
  // AdSense was connected after the Revenue board shipped.
  "d-revenue": ["adsense.earnings", "adsense.rpm"],
  /*
    Growth shipped with four sample cards and one real one. Meta is connected
    now, so the paid side can actually answer — and `meta.cannot` comes with it,
    because the Page reach this board used to promise is gone for two separate
    reasons and a reader hunting for it deserves to be told rather than left
    looking.
  */
  "d-growth": [
    "meta.leads",
    "meta.reach",
    "meta.daily",
    "meta.campaigns",
    "meta.pages",
    "instagram.followers",
    "meta.cannot",
  ],
};

type StoreApi = {
  state: StoreState;
  addVenture: (v: { name: string; desc: string; color: string }) => Venture;
  updateVenture: (id: string, patch: Partial<Omit<Venture, "id">>) => void;
  deleteVenture: (id: string) => void;
  /** A session may name a venture or none at all. Newest lands first. */
  addSession: (title: string, ventureId?: string | null) => Session;
  setActiveSession: (id: string) => void;
  sessionsFor: (ventureId: string) => Session[];
  /** Give a chat a name the owner chose. It sticks: a stored name always beats
   *  the one derived from the first message. */
  renameSession: (id: string, title: string) => void;
  /** Drop a chat from the rail. The transcript on the server is a SEPARATE
   *  deletion, made by the caller — see the Chat page, which does both. */
  removeSession: (id: string) => void;
  /**
   * Bring the rail into line with what the server actually has.
   *
   * THREE RULES, AND THEY ARE NOT SYMMETRIC, because the two sides own
   * different things. The server owns the messages; the store owns the list,
   * the names and the order.
   *
   *   — a session the server has and the store does not is ADDED, with the
   *     derived title. This is how a conversation that started on Telegram, or
   *     on another browser, appears in the rail at all.
   *   — a session the store has and the server does not is KEPT. It is an
   *     empty draft: a chat opened and not yet spoken into, which has no rows
   *     on the server precisely because nothing has been said.
   *   — a session the store already has keeps its TITLE and its venture. A
   *     name the owner typed is not overwritten by the first thing they
   *     happened to say.
   *
   * The one thing it deletes is a `seeded` session the server has never heard
   * of — the twelve invented ones, swept here rather than in `migrate()`
   * because this is the first moment anything knows whether they were real.
   */
  reconcileSessions: (server: { id: string; title: string }[]) => void;
  addDashboard: (name: string, presetId: string) => Dashboard;
  renameDashboard: (id: string, name: string) => void;
  deleteDashboard: (id: string) => void;
  /** The strip's order, as a list of ids. Ids not in the list keep their
   *  relative order at the end, so a stale list can never lose a board. */
  reorderDashboards: (ids: string[]) => void;
  setAppOrder: (slugs: string[]) => void;
  setWidgets: (dashboardId: string, widgets: PlacedWidget[]) => void;
  setWorkspace: (patch: Partial<Workspace>) => void;
  setPluginConnected: (id: string, connected: boolean) => void;
  /** Replace everything — the other half of the export on Settings → Data. */
  importState: (next: StoreState) => void;
  /** Back to the starting set. The only destructive control in Settings. */
  reset: () => void;
};

const StoreContext = createContext<StoreApi | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* the session still works without persistence */
    }
  }, [state]);

  const api = useMemo<StoreApi>(() => {
    const mapVentures = (fn: (v: Venture) => Venture) =>
      setState((s) => ({ ...s, ventures: s.ventures.map(fn) }));

    const mapDashboards = (fn: (d: Dashboard) => Dashboard) =>
      setState((s) => ({ ...s, dashboards: s.dashboards.map(fn) }));

    return {
      state,

      addVenture({ name, desc, color }) {
        const venture: Venture = { id: uid("v"), name, desc, color };
        setState((s) => ({ ...s, ventures: [...s.ventures, venture] }));
        return venture;
      },

      updateVenture(id, patch) {
        mapVentures((v) => (v.id === id ? { ...v, ...patch } : v));
      },

      /* A deleted venture does not take its chats with it. They stop naming it
         and stay in the list, which is the whole point of the flat rail. */
      deleteVenture(id) {
        setState((s) => ({
          ...s,
          ventures: s.ventures.filter((v) => v.id !== id),
          sessions: s.sessions.map((x) =>
            x.ventureId === id ? { ...x, ventureId: null } : x,
          ),
        }));
      },

      addSession(title, ventureId) {
        const session: Session = {
          id: uid("s"),
          title,
          ventureId: ventureId ?? null,
        };
        setState((s) => ({
          ...s,
          activeSessionId: session.id,
          sessions: [session, ...s.sessions],
        }));
        return session;
      },

      setActiveSession(id) {
        setState((s) => ({ ...s, activeSessionId: id }));
      },

      sessionsFor(ventureId) {
        return state.sessions.filter((x) => x.ventureId === ventureId);
      },

      renameSession(id, title) {
        const name = title.trim();
        /* An empty rename is a no-op rather than an unnamed chat. The dialog
           can be dismissed with the field cleared, and a rail full of blank
           rows is not a feature. */
        if (!name) return;
        setState((s) => ({
          ...s,
          sessions: s.sessions.map((x) =>
            x.id === id ? { ...x, title: name, seeded: undefined } : x,
          ),
        }));
      },

      removeSession(id) {
        setState((s) => {
          const sessions = s.sessions.filter((x) => x.id !== id);
          /*
            DELETING THE OPEN CHAT LEAVES NO CHAT OPEN, rather than jumping to
            the next one. Landing the owner in a conversation they did not
            choose, one keystroke after a delete, is how the wrong thing gets
            typed into the wrong chat. Null is the new-chat screen, which is
            where somebody who just deleted something is going anyway.
          */
          return {
            ...s,
            sessions,
            activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
          };
        });
      },

      reconcileSessions(server) {
        setState((s) => {
          const known = new Set(s.sessions.map((x) => x.id));
          const onServer = new Set(server.map((x) => x.id));

          const titles = new Map(server.map((x) => [x.id, x.title]));

          /*
            Kept, minus the invented ones the server has never heard of. The
            mark comes off the survivors: a seeded id with real messages is a
            real chat now and must never be swept again.

            AND A SURVIVOR TAKES THE SERVER'S TITLE, which is the one exception
            to "a name in the store wins". That rule protects names the OWNER
            typed, and a seeded title is not one — it is invented data that
            happens to be sitting on a real conversation, which is exactly the
            situation `s-1` is in on this machine: the seed made it the active
            session, so the first thing anybody said on this dashboard was
            stored under a chat called "Pricing table variants". The first line
            of the actual conversation is a better name than a placeholder, and
            it is the only chance to swap it — after this pass the mark is
            gone and the title is the owner's to change.
          */
          const kept = s.sessions
            .filter((x) => !x.seeded || onServer.has(x.id))
            .map((x) =>
              x.seeded
                ? { ...x, title: titles.get(x.id) ?? x.title, seeded: undefined }
                : x,
            );

          /* New arrivals go on top, in the order the server gave them — which
             is newest activity first, the same order the rail reads in. */
          const added: Session[] = server
            .filter((x) => !known.has(x.id))
            .map((x) => ({ id: x.id, title: x.title, ventureId: null }));

          if (!added.length && kept.length === s.sessions.length) {
            /* Nothing changed except possibly the marks, and a new array with
               the same contents is a re-render of every page that reads this. */
            const same = kept.every((x, i) => x === s.sessions[i]);
            if (same) return s;
          }

          return {
            ...s,
            sessions: [...added, ...kept],
            /* An active session that has just been swept is no longer a place
               to be. Null lands on the new-chat screen rather than on a
               transcript that no longer has a row in the rail. */
            activeSessionId:
              s.activeSessionId &&
              !added.some((x) => x.id === s.activeSessionId) &&
              !kept.some(
                (x) =>
                  x.id === s.activeSessionId ||
                  x.children?.some((c) => c.id === s.activeSessionId),
              )
                ? null
                : s.activeSessionId,
          };
        });
      },

      addDashboard(name, presetId) {
        const preset = DASHBOARD_PRESETS.find((p) => p.id === presetId);
        const board: Dashboard = {
          id: uid("d"),
          slug: uniqueSlug(
            name,
            state.dashboards.map((d) => d.slug),
          ),
          name,
          widgets: (preset?.widgets ?? []).map((type) => ({
            id: uid("w"),
            type,
            w: defaultWidth(type),
          })),
        };
        setState((s) => ({ ...s, dashboards: [...s.dashboards, board] }));
        return board;
      },

      renameDashboard(id, name) {
        mapDashboards((d) => (d.id === id ? { ...d, name } : d));
      },

      deleteDashboard(id) {
        setState((s) => ({
          ...s,
          dashboards: s.dashboards.filter((d) => d.id !== id),
        }));
      },

      setWidgets(dashboardId, widgets) {
        mapDashboards((d) => (d.id === dashboardId ? { ...d, widgets } : d));
      },

      reorderDashboards(ids) {
        setState((s) => {
          const rank = new Map(ids.map((id, i) => [id, i]));
          const ordered = [...s.dashboards].sort(
            (a, b) =>
              (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
          );
          return { ...s, dashboards: ordered };
        });
      },

      setAppOrder(slugs) {
        setState((s) => ({ ...s, appOrder: slugs }));
      },

      setWorkspace(patch) {
        setState((s) => ({ ...s, workspace: { ...s.workspace, ...patch } }));
      },

      setPluginConnected(id, connected) {
        setState((s) => ({ ...s, plugins: { ...s.plugins, [id]: connected } }));
      },

      importState(next) {
        setState(next);
      },

      reset() {
        setState(structuredClone(SEED));
      },
    };
  }, [state]);

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
