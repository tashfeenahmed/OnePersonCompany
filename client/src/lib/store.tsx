import { sidebarPins, togglePin, reorderPins, type SidebarPin } from "../../../shared/sidebarPins";
import { isWorkspacePreferences } from "../../../shared/workspace";
import { isPaletteId, type PaletteId } from "./palettes";
import { DEFAULT_WINDOW, isWindowValue, type WindowValue } from "@/lib/window";
import { useWorkspaceSync, saveRecovery, preferences } from "./workspaceSync";
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
import {
  api,
  type Venture,
  type VentureBrand,
  type VentureInput,
  type VenturePatch,
} from "@/lib/api";

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
 * THE VENTURES THEMSELVES ARE THE SERVER'S NOW, and what is held here is a
 * CACHE of them. They were localStorage's until the agent needed to read them
 * — a venture's stage is the whole reason it can give advice worth having —
 * and until the board, which stores a `venture_id` on every card, meant half
 * the fact lived on the server already. So `state.ventures` is what this
 * browser last saw: the rail and the pages draw it immediately, a fetch
 * replaces it wholesale through `reconcileVentures`, and a FAILED fetch leaves
 * it exactly as it is. Not knowing whether a venture still exists is not a
 * reason to delete it — the same rule the session reconcile follows one screen
 * away.
 *
 * Held in one place and mirrored to localStorage so the prototype behaves like
 * the real thing across reloads. Every mutation returns a new object rather
 * than editing in place — the sidebar and the page it sits beside read the same
 * state, and one of them mutating silently is how they end up disagreeing.
 */

/** The venture document, as the server defines it. Re-exported because half
 *  this app imports it from here and a venture is still a store-shaped thing
 *  from a page's point of view. */
export type { Venture, VentureStage } from "@/lib/api";
import type { SessionChild } from "@/lib/api";

/** ONE THING A CHAT SET IN MOTION — a run, not a chat. Declared in
 *  `@/lib/api` beside the document it arrives in, and re-exported because the
 *  rail reads it from the store. */
export type { SessionChild } from "@/lib/api";

export type Session = {
  id: string;
  title: string;
  /** A venture this was about, when it was about one. */
  ventureId?: string | null;
  /**
   * RUNS THIS CHAT DISPATCHED — sub-agent work, filed under the conversation
   * that asked for it.
   *
   * THE SERVER OWNS THIS LIST ENTIRELY, which is the opposite of the rule
   * every other field on a session follows. A title is the owner's and is
   * never overwritten; a venture is the owner's; the children are `agent_runs`
   * rows with `parent_session_id = this chat`, and there is no such thing as a
   * child this browser knows about and the server does not. So the reconcile
   * REPLACES rather than merges — a run cancelled and deleted from another tab
   * has to be able to disappear from this rail.
   *
   * `to` is where the child actually lives, and it is usually NOT a chat: a
   * dispatched run is read at /apps/<app>/<runId>. The field is optional
   * because the rail predates the runs area and a child with no address falls
   * back to being treated as a conversation.
   */
  children?: SessionChild[];
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
   * history — `s-1` was the store's starting `activeSessionId` (a field this
   * state no longer has; see `StoreState`), so the first real conversation
   * anybody had on this dashboard was stored under it.
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
  /**
   * THE VENTURE A PER-PROJECT CARD IS ABOUT, by venture id.
   *
   * Only read on a widget whose catalog entry says `perProject`; every other
   * card ignores it. A per-project card is a scoped card whose scope is
   * chosen on the card rather than by the page it sits on — so the Search
   * board can carry "Search · Example App 1" beside "Search · FreeLLMAPI" without
   * either board belonging to a venture. The card resolves the id to the
   * venture's hosts and narrows the live documents with the same rule a
   * venture board uses (lib/scope.ts), which is why this is an id and never
   * a hostname: a venture whose website changes keeps its cards.
   *
   * Optional and absent on every card placed before it existed, so no
   * migration; the workspace validator (shared/workspace.ts) lets it through
   * by shape. A per-project card with no value says "pick a venture".
   */
  param?: string;
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
  /**
   * THE VENTURE THIS BOARD BELONGS TO, or null/absent for the global set.
   *
   * A dashboard is either one of the owner's own boards — /dashboards/servers,
   * about everything — or one venture's, at /ventures/<slug>/dashboards/<board>
   * and narrowed to that venture's host. Absent on every board made before
   * ventures had dashboards, which is why the pages read `!d.ventureId` rather
   * than `d.ventureId === null`: an older board is a global board.
   *
   * SLUGS ARE UNIQUE PER SCOPE, not globally. Two ventures may both have a
   * "Search" board, because they are two different addresses.
   */
  ventureId?: string | null;
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
  /*
    THERE IS NO `activeSessionId` HERE ANY MORE, and its absence is the point.

    It named the chat that was open, the rail set it and the Chat page read it
    — two copies of one fact, in a store that is written to localStorage, next
    to a URL that also had an opinion. They came apart exactly where you would
    expect: pressing a session from /ventures set the field and left the owner
    on /ventures, lighting a row for a conversation that was nowhere on screen.

    A chat is at `/chat/<id>` now and that address is the only copy. Which also
    settles a question this field could never answer well: an open conversation
    is a fact about where you ARE, and persisting it meant a new tab, or a
    reload a fortnight later, opening whatever was last read as though it had
    been asked for. An older state may still have the key in localStorage; it
    is ignored rather than migrated away, because a stale field nothing reads
    costs less than a migration that rewrites everybody's store to remove it.
  */
  /**
   * The Apps strip in the owner's order, by slug. Optional and absent on an
   * older state: the registry's own order is the default, and a slug that no
   * longer exists is dropped at read time rather than migrated away. Apps are
   * code; only their order is the owner's.
   */
  appOrder?: string[];
  favoritePaths?: string[];
  /** Pages and sessions in one shared, owner-ordered sidebar list. */
  pinnedItems?: SidebarPin[];
  /**
   * WHICH PALETTE THE CHROME WEARS. Optional and absent on an older state,
   * where absent means the default — see lib/palettes.ts.
   *
   * IT IS HERE AND NOT IN localStorage BESIDE THE LIGHT/DARK CHOICE, and the
   * two live in different places on purpose. Light or dark is a fact about the
   * ROOM: the laptop in the sun and the desktop at night want different
   * answers, and syncing it would fight the OS. A palette is a fact about the
   * PRODUCT — somebody who chose Moss chose it for their dashboard, not for
   * this browser — so it rides the workspace preferences and follows them to
   * every browser they open it in.
   */
  palette?: PaletteId;
  /**
   * THE WINDOW EVERY DASHBOARD PAGE IS DRAWN OVER — 7, 30, 90 days or "all".
   * Optional and absent on an older state, where absent means a month, which
   * is what most routes answered before there was a picker (see lib/window).
   *
   * IN THE STORE AND NOT IN THE URL, unlike which board is open. A board's
   * address is a fact about one place; the window is how the owner reads
   * every board and every report tab, and it rides the workspace preferences
   * to every browser for the reason the palette does. One value for the
   * whole Dashboards area rather than one per board, because the point of it
   * is that two cards on two boards can be read against each other.
   */
  dashboardWindow?: WindowValue;
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

/* A plugin's connection state lives in this store rather than on the Plugins
   page, so the index and a plugin's own page cannot disagree about it. */
const KEY = "opc-state-v5";

/*
  BUMP THIS RATHER THAN EDITING A SEED IN PLACE. The starter dashboards are a
  GIFT and not a template: `migrate()` hands a state the boards it has never
  been offered, exactly once, so a board the owner deleted stays deleted and
  one they have reshaped stays reshaped. A bump is how a new board reaches a
  state that already exists; editing an existing seed reaches nobody.

  Not every bump is a gift. A shape change is a REPAIR — see `migrate()` — and
  runs whatever version stamp the cached state carries, because an older cache
  has to stay readable.
*/
export const SEED_VERSION = 18;

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
  /* A NAME NOBODY IS. The owner types their own in Settings → General; the
     shipped default must not be one person's first name. */
  workspace: { name: "Solo workspace", owner: "Owner", defaultVentureId: null },

  plugins: Object.fromEntries(PLUGINS.map((p) => [p.id, p.connected])),

  /*
    NO VENTURES. The ones that used to be listed here by name are the
    SERVER's to seed now, and the first fetch puts them in this cache. Seeding
    them here as well would mean two copies of the same rows written by two
    different builds, and
    the moment one of them gained a website or changed stage they would
    disagree — with the local copy winning until a fetch landed, which is the
    worst way round.

    The cost is one render on a first load with the API down: an empty
    ventures page, which is the honest thing to show a browser that has never
    successfully asked.
  */
  ventures: [],

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
      SERVERS. The four figures first,
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
      DOMAINS. The whole portfolio on one page: the counts, then
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
        /*
          THE RATE CARD FIRST — what the portfolio owes, where it goes, then
          the bill line by line — and the metered providers after it, the way
          the money pages order the same subject. A board that opened on the
          LLM bill and never showed the servers, the services or the
          electricity was reading the variable half of the cost and calling it
          the cost.
        */
        { id: "cs22", type: "finance.monthly", w: 1 },
        { id: "cs23", type: "finance.renewals", w: 1 },
        { id: "cs24", type: "finance.unpriced", w: 1 },
        { id: "cs25", type: "finance.groups", w: 2 },
        { id: "cs26", type: "finance.servers", w: 2 },
        { id: "cs27", type: "finance.services", w: 2 },
        { id: "cs28", type: "finance.power", w: 2 },
        { id: "cs29", type: "finance.domains", w: 2 },
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
      PAYMENTS. The Revenue board one level deeper: what came in over the
      window, what is contracted to keep coming in, and where money is
      leaking out — the Workdash Payments page as a board of widgets rather
      than a page, so it can be reshaped like the rest.

      THE HERO ROW IS FOUR LEVELS AND ONE SUM. MRR, ARR and the book are the
      subscription contract as it stands this minute and wear "now"; the
      gross tile beside them is the window's charges, and is the only one of
      the four the window moves. The alerts sit under them at full width
      because a dispute with a deadline is the one thing on this board that
      has to be read before the rest.

      NOTHING HERE IS A SECOND DRAWING OF A REVENUE CARD. Where the two
      boards want the same figure they place the same widget — `stripe.mrr`,
      `stripe.subs`, `stripe.fees`, `stripe.mix`, `stripe.declines`,
      `stripe.payouts` — and the `payments.*` widgets are only what Revenue
      does not draw: the leakage buckets, the fail rate with its fixed
      drift, gross beside net per day, MRR movement, the cancellations still
      billing, the disputes.

      THE APP STORES ARE TWO CARDS AT THE END and are on no Stripe figure.
      Google's and Apple's money settles on its own calendar, one figure a
      month, and never joins the ledger above it.
    */
    /*
      RE-SEEDED IN SEED_VERSION 18 TO FOLLOW WORKDASH'S PAYMENTS PAGE TOP TO
      BOTTOM: the hero row (MRR with its plan bar, gross with its attempts
      bar, the book by state), "Worth a look", "Money on the floor", and
      then the detail — why payments fail, the daily line, the charge list —
      with the narrow cards after. Workdash's two detail columns are one grid
      here, so a row is two half-width cards and each pair is matched by
      HEIGHT rather than by Workdash's column order: the fail-rate card, with
      its bar, its buckets and its trend, sits beside the plan list, and the
      movement waterfall beside the cancellations, so no card ends a screen
      above its neighbour.
    */
    {
      id: "d-payments",
      slug: "payments",
      name: "Payments",
      widgets: [
        { id: "py1", type: "payments.mrr", w: 1 },
        { id: "py2", type: "payments.gross", w: 1 },
        { id: "py3", type: "payments.subs", w: 1 },
        { id: "py4", type: "stripe.arr", w: 1 },
        { id: "py5", type: "payments.alerts", w: 4 },
        { id: "py6", type: "payments.floor", w: 4 },
        { id: "py7", type: "payments.failRate", w: 2 },
        { id: "py13", type: "payments.plans", w: 2 },
        { id: "py9", type: "payments.daily", w: 4 },
        { id: "py25", type: "payments.recent", w: 4 },
        { id: "py11", type: "payments.movement", w: 2 },
        { id: "py12", type: "payments.leaving", w: 2 },
        { id: "py21", type: "play.revenue", w: 2 },
        { id: "py22", type: "appstore.proceeds", w: 2 },
        { id: "py14", type: "stripe.mix", w: 2 },
        { id: "py26", type: "payments.attempts", w: 2 },
        { id: "py16", type: "payments.disputes", w: 2 },
        { id: "py17", type: "stripe.payouts", w: 1 },
        { id: "py18", type: "stripe.pending", w: 1 },
        { id: "py8", type: "stripe.churn", w: 1 },
        { id: "py10", type: "stripe.fees", w: 2 },
        { id: "py15", type: "stripe.declines", w: 2 },
        { id: "py19", type: "payments.attemptDays", w: 2 },
        { id: "py20", type: "payments.ledgerDays", w: 2 },
        { id: "py23", type: "payments.cannot", w: 2 },
        { id: "py24", type: "stripe.limits", w: 2 },
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
    /*
      RE-SEEDED IN SEED_VERSION 17 TO FOLLOW WORKDASH'S ALL-PROPERTIES SEARCH
      PAGE TOP TO BOTTOM: the four tiles, the two lines under them (rank and
      sitemaps), "Portfolio impressions per day" at full width with its clicks
      twin, clicks against impressions, then every property drawn as itself —
      first as the rail (a row and a sparkline each), then as the table and
      the per-property lines — and the quiet ones last. After that the cards
      Workdash's per-property page draws, cut across the portfolio: the
      ranked queries, pages and page-two list, the per-property tables, the
      zero-click floor, the sitemaps. Bing closes, still apart from Google.

      THE PER-PROPERTY CARDS ARE NOT SEEDED HERE, and it is deliberate: they
      take a venture (`PlacedWidget.param`) and the seed cannot know which
      ventures have traffic. The rail shows every property at a glance, and
      the palette adds "Search · <venture>" in one click for the ones that
      deserve a card of their own.

      Three `rows` cards left — `gsc.queries`, `gsc.pages`, `gsc.striking` —
      replaced by their ranked-bar versions, as the SEO re-seed did.
    */
    {
      id: "d-search",
      slug: "search",
      name: "Search",
      widgets: [
        /* Workdash's four tiles, then its two note lines as cards. */
        { id: "se2", type: "gsc.clicks", w: 1 },
        { id: "se1", type: "gsc.impressions", w: 1 },
        { id: "se21", type: "gsc.ctr", w: 1 },
        { id: "se22", type: "gsc.properties", w: 1 },
        { id: "se6", type: "gsc.position", w: 1 },
        { id: "se23", type: "audit.issues", w: 1 },
        { id: "se15", type: "gsc.sitemaps", w: 2 },
        /* The portfolio, drawn: the daily lines and the dumbbell. */
        { id: "se5", type: "gsc.trend", w: 4 },
        { id: "se24", type: "gsc.clicksTrend", w: 4 },
        { id: "se25", type: "gsc.dumbbell", w: 4 },
        /* Every property as itself — the rail first, then the table. */
        { id: "se26", type: "gsc.rail", w: 4 },
        { id: "se13", type: "gsc.sites", w: 4 },
        { id: "se27", type: "gsc.propertyClicks", w: 4 },
        { id: "se28", type: "gsc.propertyImpressions", w: 4 },
        { id: "se29", type: "gsc.quiet", w: 2 },
        { id: "se8", type: "gsc.coverage", w: 2 },
        /* The per-property page's cards, cut across the portfolio. */
        { id: "se30", type: "gsc.queriesRanked", w: 2 },
        { id: "se31", type: "gsc.pagesRanked", w: 2 },
        { id: "se32", type: "gsc.strikingRanked", w: 4 },
        { id: "se33", type: "gsc.propertyQueries", w: 4 },
        { id: "se34", type: "gsc.propertyStriking", w: 4 },
        { id: "se35", type: "gsc.zeroClick", w: 2 },
        { id: "se12", type: "gsc.movers", w: 2 },
        { id: "se36", type: "gsc.sitemapsByProperty", w: 4 },
        { id: "se37", type: "gsc.cannot", w: 4 },
        /* Bing, kept apart from Google as it always was. */
        { id: "se3", type: "bing.impressions", w: 1 },
        { id: "se4", type: "bing.clicks", w: 1 },
        { id: "se7", type: "bing.index", w: 1 },
        { id: "se19", type: "bing.trend", w: 4 },
        { id: "se18", type: "bing.sites", w: 4 },
        { id: "se10", type: "bing.queries", w: 2 },
        { id: "se16", type: "bing.keywords", w: 2 },
        { id: "se17", type: "bing.backlinks", w: 2 },
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
        { id: "w19", type: "pypi.downloads", w: 1 },
        { id: "w20", type: "pypi.last30", w: 1 },
        { id: "w21", type: "pypi.weekly", w: 4 },
        { id: "w22", type: "pypi.packages", w: 4 },
      ],
    },
    /*
      ANALYTICS. What the sites themselves counted.

      A board of its own rather than four more cards on Search & traffic, and
      the reason is that they are not the same measurement. Search Console
      reports impressions on a results page — how often Google showed us —
      and Umami reports arrivals. A reader with both on one board will read
      one as a funnel into the other, and there is no such funnel here: the
      windows differ, the days are bucketed in different timezones, and a
      pageview from a bookmark never touched a search engine.

      Two refusals are on this board rather than hidden behind it. Umami has
      no portfolio visitor count and Bluesky has no combined follower count,
      both because the same person counted on two properties is one person and
      neither API can subtract them again. The two cards that would carry those
      totals say so instead, with the per-site and per-handle figures on the
      tables below them.
    */
    {
      id: "d-analytics",
      slug: "analytics",
      name: "Analytics",
      widgets: [
        { id: "an1", type: "umami.pageviews", w: 1 },
        { id: "an2", type: "umami.visitors", w: 1 },
        { id: "an3", type: "umami.bounce", w: 1 },
        { id: "an4", type: "umami.avgVisit", w: 1 },
        { id: "an5", type: "umami.daily", w: 4 },
        { id: "an6", type: "umami.pages", w: 2 },
        { id: "an7", type: "umami.referrers", w: 2 },
        { id: "an8", type: "umami.events", w: 2 },
        { id: "an9", type: "bluesky.followers", w: 1 },
        { id: "an10", type: "bluesky.engagement", w: 1 },
        { id: "an11", type: "umami.sites", w: 4 },
        { id: "an12", type: "bluesky.handles", w: 4 },
      ],
    },
    /*
      SEO. Everything that decides whether a stranger ever reaches one of these
      sites, from the four sources that can actually say something about it.

      THE CRAWL LEADS, because it is the only thing on this board we control:
      an error on our own page is a fault with an owner and a fix, where a
      ranking is a report of somebody else's decision. Google's verdict sits
      beside it, and then the three wide tables that are the evidence — who
      links in, which directories carry us, and every venture's own crawl. They
      are at full width because not one of them fits in a column: a source per
      row, a directory per column, a venture per line.

      THEN THE NARROW CARDS, and they are the ones with something to do in
      them: the queries a nudge would move, the pages, what Bing has indexed
      and what it could not crawl, the referring-domain counts and the checks
      that were blocked. The board CLOSES on worst-first, which is the only
      card here that is a list of instructions.

      NOTHING ON THIS BOARD IS ADDED TO ANYTHING ELSE ON IT. The audit counts
      faults on pages, Search Console counts impressions on a results page, the
      backlink sources count referring domains and disagree with each other by
      design, and the presence matrix counts directory listings. Four counts of
      four different acts, and the only figure that could span them would be a
      score — which is the number this dashboard exists to refuse.

      A VENTURE WITH NO CRAWL IS NOT A VENTURE WITH NO PROBLEMS, and both audit
      cards are built to say so rather than let an empty column read as a clean
      one.
    */
    /*
      RE-SEEDED IN SEED_VERSION 16 TO FOLLOW WORKDASH'S SEO PAGES TOP TO
      BOTTOM: the totals, then every property drawn as itself, then the
      queries and pages, then indexing and authority. Nothing that was here
      left unless a new card draws the same rows in Workdash's form —
      `gsc.striking` and `gsc.pages` went, replaced by their ranked-bar
      versions; everything else kept its place in the new order.

      NO SCORE, STILL. Workdash opens with a median audit score and ranks
      its sites by one; the audit here refuses a score, so `audit.ranked` is
      errors worst-first and `audit.crawled` beside `audit.issues` is the
      honest pair of tiles. The four documents this box computes itself —
      authority, AI visibility, follow-ups, IndexNow — close the board with
      what Workdash draws from its agent routes.
    */
    {
      id: "d-seo",
      slug: "seo",
      name: "SEO",
      widgets: [
        /* Totals — the four search tiles, the audit pair, the two lines. */
        { id: "seo13", type: "gsc.clicks", w: 1 },
        { id: "seo14", type: "gsc.impressions", w: 1 },
        { id: "seo15", type: "gsc.ctr", w: 1 },
        { id: "seo2", type: "gsc.position", w: 1 },
        { id: "seo16", type: "gsc.properties", w: 1 },
        { id: "seo17", type: "audit.crawled", w: 1 },
        { id: "seo1", type: "audit.issues", w: 1 },
        { id: "seo8", type: "bing.index", w: 1 },
        { id: "seo18", type: "gsc.trend", w: 4 },
        { id: "seo19", type: "gsc.clicksTrend", w: 4 },
        /* Every property, drawn as itself. Full width where a card has one
           row per property: eighteen rows beside a five-row neighbour is a
           card ending a screen above the one next to it. */
        { id: "seo20", type: "gsc.dumbbell", w: 4 },
        { id: "seo21", type: "audit.ranked", w: 2 },
        { id: "seo12", type: "audit.worst", w: 2 },
        { id: "seo22", type: "gsc.propertyClicks", w: 4 },
        { id: "seo23", type: "gsc.propertyImpressions", w: 4 },
        { id: "seo24", type: "gsc.sites", w: 4 },
        { id: "seo5", type: "audit.ventures", w: 4 },
        { id: "seo25", type: "gsc.quiet", w: 2 },
        { id: "seo29", type: "gsc.zeroClick", w: 2 },
        /* Queries and pages. */
        { id: "seo26", type: "gsc.queriesRanked", w: 2 },
        { id: "seo27", type: "gsc.pagesRanked", w: 2 },
        { id: "seo28", type: "gsc.strikingRanked", w: 4 },
        { id: "seo30", type: "gsc.propertyQueries", w: 4 },
        { id: "seo31", type: "gsc.propertyStriking", w: 4 },
        /* Indexing and authority. */
        { id: "seo32", type: "gsc.sitemapsByProperty", w: 4 },
        { id: "seo9", type: "bing.crawl", w: 2 },
        { id: "seo33", type: "indexing.told", w: 2 },
        { id: "seo34", type: "bing.propertyIndex", w: 4 },
        { id: "seo35", type: "authority.ceiling", w: 4 },
        { id: "seo10", type: "backlinks.domains", w: 2 },
        { id: "seo36", type: "geo.mentioned", w: 2 },
        { id: "seo3", type: "backlinks.bySource", w: 4 },
        { id: "seo4", type: "presence.matrix", w: 4 },
        { id: "seo11", type: "presence.blocked", w: 2 },
        { id: "seo37", type: "seoops.moved", w: 2 },
        /*
          PER PROJECT (SEED_VERSION 17). One of each per-project card, with
          no venture chosen: each says "pick a venture" until the owner does,
          in edit mode, from the card's own header — and the palette adds a
          second one for a second venture. Seeded without a venture because
          the seed cannot know which one the owner reads first; seeded at
          all because a card that has to be found in the palette is a card
          nobody finds.
        */
        { id: "seo39", type: "gsc.project", w: 2 },
        { id: "seo40", type: "audit.project", w: 2 },
        { id: "seo41", type: "authority.project", w: 2 },
        { id: "seo42", type: "indexing.project", w: 2 },
        { id: "seo43", type: "seoops.project", w: 2 },
        /* The refusals close the board, the way `meta.cannot` closes Social. */
        { id: "seo38", type: "gsc.cannot", w: 4 },
      ],
    },
    /*
      SOCIAL. The accounts, and what is actually knowable about them.

      A BOARD OF ITS OWN AT LAST, and the argument that kept it off the Growth
      board is the argument for the shape of this one: three Pages with a few
      hundred followers between them do not fill a page with numbers. So this
      board is not built to be full — it is seven cards, it ends on the card
      that says what the APIs will not answer, and it is honest at that size.

      THE PAGES COME FIRST because a follower count is meaningless without
      knowing how many accounts it is spread across. NOTHING ADDS ACROSS
      NETWORKS or across handles: a Bluesky follower and a Facebook follower
      are different people doing different things, and the same person on two
      handles is one person and two rows. `meta.cannot` closes the board for
      the same reason the Costs board ends on Replicate's refusal — a social
      board that quietly omitted organic reach would be read as the whole
      picture.
    */
    {
      id: "d-social",
      slug: "social",
      name: "Social",
      widgets: [
        { id: "so1", type: "meta.pages", w: 2 },
        { id: "so2", type: "instagram.followers", w: 2 },
        { id: "so3", type: "bluesky.followers", w: 1 },
        { id: "so4", type: "meta.reach", w: 1 },
        { id: "so5", type: "bluesky.engagement", w: 2 },
        { id: "so6", type: "bluesky.handles", w: 4 },
        { id: "so7", type: "meta.cannot", w: 2 },
      ],
    },
    /*
      ADS. Money out and money in, and they are not the same trade.

      Meta is what advertising COSTS — one account, a spend, the leads it
      bought. AdSense is what advertising EARNS — somebody else's ads on our
      own pages. Two directions of one business, which is why they are on one
      board and why not one figure crosses between them: a return on ad spend
      and a page RPM share the word "ads" and nothing else.

      SPEND FIRST, THEN WHAT IT BOUGHT, then the daily line and the campaigns
      underneath — because "was this worth it" is answered by the first three
      cards and the rest is where the answer came from. The access card is last
      and stays there even when the earnings are live: if the consent screen is
      still in Testing the token dies in a week, and this is the card that says
      so rather than the earnings quietly going flat.
    */
    {
      id: "d-ads",
      slug: "ads",
      name: "Ads",
      widgets: [
        { id: "ad1", type: "meta.spend", w: 1 },
        { id: "ad2", type: "meta.leads", w: 1 },
        { id: "ad3", type: "meta.roas", w: 2 },
        { id: "ad4", type: "adsense.earnings", w: 1 },
        { id: "ad5", type: "meta.daily", w: 2 },
        { id: "ad6", type: "meta.campaigns", w: 4 },
        { id: "ad7", type: "adsense.rpm", w: 2 },
        { id: "ad8", type: "adsense.access", w: 2 },
      ],
    },
    /*
      DEMAND. What strangers asked for, and how well we were able to hear it.

      THE SECOND HALF OF THIS BOARD IS ABOUT THE MICROPHONE, and that is
      deliberate rather than padding. Reddit's Atom feed refuses more than it
      answers, and when it does the search node is the tier that replies
      instead — so "how was Reddit read" and "is the node well" are not
      infrastructure trivia here, they are the confidence interval on every
      thread above them. A demand board without them invites somebody to read a
      quiet week as a quiet market.

      THREADS ADD ACROSS THE SOURCES AND NOTHING ELSE DOES. A thread is a
      thread whether it was posted on Reddit or Hacker News; an upvote and a
      point are two sites' scoring rules and are never added. Bing's keyword
      volumes sit here rather than on SEO because they measure a MARKET —
      people searching a phrase nothing of ours ranks for — which is demand and
      not traffic.
    */
    {
      id: "d-demand",
      slug: "demand",
      name: "Demand",
      widgets: [
        { id: "de1", type: "demand.new", w: 1 },
        { id: "de2", type: "searxng.latency", w: 1 },
        { id: "de3", type: "reddit.signals", w: 2 },
        { id: "de4", type: "hn.mentions", w: 2 },
        { id: "de5", type: "reddit.subs", w: 2 },
        { id: "de6", type: "bing.keywords", w: 2 },
        { id: "de7", type: "demand.coverage", w: 4 },
        { id: "de8", type: "hn.stories", w: 4 },
        { id: "de9", type: "reddit.tier", w: 2 },
        { id: "de10", type: "searxng.queries", w: 2 },
        { id: "de11", type: "searxng.engines", w: 2 },
      ],
    },
    /*
      DEVELOPMENT. The shop window and the two registries it ships to.

      GitHub says how many people LOOKED; npm and PyPI say how many tarballs
      and wheels went out afterwards. Nothing here turns that into a conversion
      rate and nothing ever should: a view is a person and a download is a
      fetch — a CI job pulling a package four hundred times a day is four
      hundred downloads and nobody at all.

      THE FOUR HEADLINES, THEN THE THREE LINES, THEN THE TABLES BEHIND THEM.
      The three download charts stay as three rather than being merged: npm
      weeks and PyPI weeks are counted by two registries with two definitions
      of a week, and one line holding both would be a line in no unit.

      THE API BUDGET IS THE LAST CARD, and it is not decoration either. A board
      that stops updating should be able to say why, and on this one the reason
      is almost always the same hourly ceiling.
    */
    {
      id: "d-dev",
      slug: "development",
      name: "Development",
      widgets: [
        { id: "dv1", type: "github.stars", w: 1 },
        { id: "dv2", type: "github.views", w: 1 },
        { id: "dv3", type: "npm.downloads", w: 1 },
        { id: "dv4", type: "pypi.downloads", w: 1 },
        { id: "dv5", type: "github.traffic", w: 4 },
        { id: "dv6", type: "npm.weeks", w: 4 },
        { id: "dv7", type: "pypi.weekly", w: 4 },
        { id: "dv8", type: "github.top", w: 2 },
        { id: "dv9", type: "github.referrers", w: 2 },
        { id: "dv10", type: "npm.table", w: 4 },
        { id: "dv11", type: "pypi.packages", w: 4 },
        { id: "dv12", type: "github.rate", w: 2 },
      ],
    },
    /*
      APPS. Presence, installs and ratings — and NOT the money.

      THE MONEY STAYS ON REVENUE, on purpose. Apple's estimate and Google's
      payout are two figures the Revenue board already keeps side by side and
      never adds, and a second copy of them here would be a second place for
      that distinction to be got wrong. What is left is the question this board
      is actually for: is each app on sale, is anybody installing it, and what
      do they say about it afterwards.

      THE TWO STORES ARE MIRRORED ROW FOR ROW — Apple's figure beside Google's,
      never summed — because an install on one store and an install on the
      other are counted by two companies with two definitions of an install and
      two windows to count it in. `mobile.presence` is the one card that spans
      them, and it counts SHOPS an app is in rather than adding anything.

      IT ENDS ON THE TWO REFUSALS. Both stores are asked things they will not
      answer, and a board that omitted them would be read as everything the
      stores know.
    */
    {
      id: "d-mobile",
      slug: "apps",
      name: "Apps",
      widgets: [
        { id: "ap1", type: "appstore.installs", w: 1 },
        { id: "ap2", type: "play.installs", w: 1 },
        { id: "ap3", type: "appstore.rating", w: 1 },
        { id: "ap4", type: "play.rating", w: 1 },
        { id: "ap5", type: "mobile.presence", w: 1 },
        { id: "ap6", type: "appstore.daily", w: 4 },
        { id: "ap7", type: "play.daily", w: 4 },
        { id: "ap8", type: "appstore.store", w: 2 },
        { id: "ap9", type: "appstore.apps", w: 4 },
        { id: "ap10", type: "play.apps", w: 4 },
        { id: "ap11", type: "appstore.limits", w: 2 },
        { id: "ap12", type: "play.limits", w: 2 },
      ],
    },
    /*
      UPTIME & FLEET. Two answers to "is it well", from two sides of the wall.

      THE PROBE ASKS OVER THE PUBLIC INTERNET and the fleet asks over ssh, so
      they can disagree — a box at 12% memory behind a broken reverse proxy is
      healthy to one and dead to the other. THAT DISAGREEMENT IS THE FINDING,
      which is why they share a board and why nothing here reconciles them into
      a single green tick.

      OUTSIDE FIRST, INSIDE SECOND. What answered, how fast, how long the
      certificates have — then memory, disks and load per cpu from within the
      guest, then Hetzner's own hypervisor line beneath them for the boxes it
      bills for. The order is a morning: you find out something is down before
      you find out why.

      MEMORY ADDS ACROSS BOXES AND NOTHING ELSE DOES. Load averages are already
      per machine, and filesystems share pools — so there is a meter per box on
      its fullest mount and no fleet disk total, because adding mounts puts a
      terabyte of free space on a one-terabyte disk.
    */
    {
      id: "d-fleet",
      slug: "uptime-fleet",
      name: "Uptime & fleet",
      widgets: [
        { id: "fl1", type: "uptime.up", w: 1 },
        { id: "fl2", type: "uptime.status", w: 2 },
        { id: "fl3", type: "uptime.availability", w: 2 },
        { id: "fl4", type: "uptime.latency", w: 2 },
        { id: "fl5", type: "uptime.tls", w: 4 },
        { id: "fl6", type: "uptime.incidents", w: 2 },
        { id: "fl7", type: "fleet.memory", w: 2 },
        { id: "fl8", type: "fleet.disk", w: 2 },
        { id: "fl9", type: "fleet.load", w: 2 },
        { id: "fl10", type: "hetzner.load", w: 4 },
        { id: "fl11", type: "fleet.counters", w: 2 },
        { id: "fl12", type: "fleet.containers", w: 4 },
        { id: "fl13", type: "fleet.boxes", w: 4 },
      ],
    },
    /*
      WEEK. The one board that is about the owner rather than about a business.

      Every other board narrows to a venture. This one cannot and should not: a
      Tuesday morning belongs to a person, an inbox thread is not filed under a
      domain, and the agent's queue is one queue for the whole box. That is why
      the calendar is not in SCOPABLE_SOURCES and why the runs cards are
      portfolio-wide — see lib/scope.ts for the argument.

      TODAY, THEN THE WEEK, THEN WHETHER ANYTHING BROKE OVERNIGHT, then what is
      waiting to be answered, and last what the agent has been doing while
      nobody watched. Two mail figures rather than one, because "unread" and
      "waiting on a reply" are different piles and only one of them is work.

      It ends on `mail.cannot` and `runs.recent` for the same reason: both are
      cards about what is NOT knowable from here — Gmail cannot say whether a
      thread was answered by phone, and a run that failed wrote no report.
    */
    {
      id: "d-week",
      slug: "week",
      name: "Week",
      widgets: [
        { id: "wk1", type: "calendar.today", w: 2 },
        { id: "wk2", type: "calendar.next", w: 2 },
        { id: "wk3", type: "calendar.busy", w: 2 },
        { id: "wk4", type: "uptime.up", w: 1 },
        { id: "wk5", type: "gmail.unread", w: 1 },
        { id: "wk6", type: "gmail.inbox", w: 1 },
        { id: "wk7", type: "gmail.volume", w: 4 },
        { id: "wk8", type: "gmail.mailbox", w: 2 },
        { id: "wk9", type: "mail.cannot", w: 2 },
        { id: "wk10", type: "runs.recent", w: 2 },
      ],
    },
  ],
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
  /* A dumbbell has an axis and a label gutter to fit, like a table. */
  if (kind === "dumbbell") return 4;
  /* A proportion is a metric tile with a bar under the figure: one column,
     the way the hero row of the Payments board places three of them. */
  if (kind === "proportion") return 1;
  /* Everything else — and a profile is among them on purpose: four tiles, a
     line and a list fit two columns, like the property cards on Workdash's
     Search page it is modelled on. */
  return 2;
}

/** A name as a URL segment. Anything that is not a letter, a digit or a dash
 *  becomes a dash, and a name with nothing usable in it still gets an address
 *  rather than an empty one — `fallback` is what it gets, and the server's
 *  ventures use the same rule with "venture" in that slot. */
export function slugify(name: string, fallback = "board"): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
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
  if (!isWorkspacePreferences(v)) return false;
  const s = v as StoreState;
  return !!s.plugins && typeof s.plugins === "object" && !Array.isArray(s.plugins)
    && Object.values(s.plugins).every(v => typeof v === "boolean")
    && Array.isArray(s.ventures) && s.ventures.every(v => v && typeof v === "object" && typeof v.id === "string" && typeof v.name === "string");
}

/**
 * A brand nothing has been read into yet.
 *
 * Every field null and every list empty, which is the difference between "the
 * site has not been read" and "the site has no icon". Only the cache-repair
 * below uses it: a venture that reaches this browser from the server always
 * arrives with a real one.
 */
const EMPTY_BRAND: VentureBrand = {
  favicon: null,
  faviconSource: null,
  title: null,
  description: null,
  ogImage: null,
  themeColor: null,
  lang: null,
  palette: {
    primary: null,
    secondary: null,
    accent: null,
    background: null,
    ink: null,
    ranked: [],
  },
  fonts: [],
  enrichedAt: null,
  error: null,
  notes: [],
};

/**
 * A CACHED VENTURE FROM AN OLDER BUILD, brought up to the server's shape.
 *
 * The old row was `{ id, name, desc, color }` and four of them are sitting in
 * every existing browser. This is not a migration in the "improve it" sense —
 * the server's copy replaces all of this the moment a fetch lands — it is
 * about the RENDER BEFORE THAT, where a page reading `venture.description` or
 * `venture.brand.favicon` off an old row would throw on a screen the owner is
 * looking at. So: the owner's words become the description, the stage is
 * `launched` because everything that was in that list was, the brand is empty
 * rather than invented, and the slug comes from the name with the same rule
 * the server uses.
 */
function reviveVenture(raw: unknown, index: number): Venture | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<Venture> & { desc?: string };
  if (!v.id || !v.name) return null;
  /* Already the new shape: handed straight back, identity and all, so a
     reconciled list is not rebuilt on every load. */
  if (v.slug && v.brand && v.stage && typeof v.description === "string")
    return v as Venture;
  const epoch = new Date(0).toISOString();
  return {
    id: v.id,
    slug: v.slug ?? slugify(v.name, "venture"),
    name: v.name,
    description: typeof v.description === "string" ? v.description : (v.desc ?? ""),
    website: v.website ?? null,
    host: v.host ?? null,
    stage: v.stage ?? "launched",
    color: v.color ?? VENTURE_COLORS[index % VENTURE_COLORS.length]!,
    /* A colour that was in this store was one the owner picked from the seven,
       so it is theirs — not something measured from a site nobody has read. */
    colorSource: v.colorSource ?? "owner",
    position: typeof v.position === "number" ? v.position : index,
    brand: v.brand ?? structuredClone(EMPTY_BRAND),
    createdAt: v.createdAt ?? epoch,
    updatedAt: v.updatedAt ?? epoch,
  };
}

function load(): StoreState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoreState;
      if (isStoreState(parsed)) return migrate({ ...parsed, ventures: [] });
      localStorage.setItem("opc-invalid-workspace", raw);
    }
  } catch {
    /* unreadable or absent — the seed is a fine starting point */
  }
  return { ...structuredClone(SEED), ventures: [], sessions: [] };
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

  /* Repair: every cached venture in the shape the pages now read. Ungated by
     `seedVersion` for the reason the slug repair below is — a state written by
     an older build has to be readable whatever stamp it carries. */
  const revived = state.ventures
    .map((v, i) => reviveVenture(v, i))
    .filter((v): v is Venture => !!v);
  const ventures = revived.every((v, i) => v === state.ventures[i])
    ? state.ventures
    : revived;

  /* Repair: a window the picker cannot draw — a hand-edited export, a value
     from a build that offered a different set — is dropped back to the
     default rather than carried into every fetch on every board. Ungated by
     `seedVersion` for the same reason the slug repair below is. */
  if (state.dashboardWindow !== undefined && !isWindowValue(state.dashboardWindow))
    state = { ...state, dashboardWindow: undefined };

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
    return dashboards === state.dashboards && ventures === state.ventures
      ? state
      : { ...state, dashboards, ventures };

  /*
    MARK THE TWELVE INVENTED SESSIONS FOR REMOVAL — mark, not delete, and the
    difference is the whole safety of this step.

    This function runs against localStorage before anything has been fetched,
    so it cannot answer the only question that matters: does this session have
    a real conversation in it? At least one of them does. `s-1` was the seed's
    own `activeSessionId` — the field that named the open chat before an
    address did — which means the first thing anybody ever said on this
    dashboard was stored under that id and is sitting in the server's
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
    A GIFTED BOARD LANDS BESIDE ITS SEED NEIGHBOUR, not at the end of the
    strip. Payments (SEED_VERSION 15) is seeded right after Revenue because it
    is that subject one level deeper, and a state that already had Revenue
    should read the same way — appended after twenty boards it would be the
    last tab on a strip nobody scrolls to the end of. The rule is general: a
    new board goes after the nearest seed board BEFORE it that this state
    still has, and only at the end when it has none of them. The owner's own
    order is untouched — one board is inserted, nothing moves.
  */
  const gifted = added.reduce((list, board) => {
    const at = SEED.dashboards.findIndex((d) => d.id === board.id);
    const before = SEED.dashboards.slice(0, at).map((d) => d.id).reverse();
    const anchor = before.map((id) => list.findIndex((d) => d.id === id)).find((i) => i >= 0);
    if (anchor === undefined) return [...list, board];
    return [...list.slice(0, anchor + 1), board, ...list.slice(anchor + 1)];
  }, dashboards);

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
  const topped = gifted.map((d) => {
    const wanted = TOP_UPS[d.id];
    if (!wanted) return d;
    const have = new Set(d.widgets.map((w) => w.type));
    const missing = wanted.filter((type) => !have.has(type));
    if (!missing.length) return d;
    const arriving = missing.map((type) => ({ id: uid("w"), type, w: defaultWidth(type) }));
    /* In front on the boards that say so, at the end everywhere else. A
       top-up is usually more of the same subject and reads fine after what
       is there; the Costs one is the HEADLINE of its board — the bill
       itself, ahead of the metered providers — and a headline appended under
       twenty-one cards is a headline nobody scrolls to.

       A PER-PROJECT CARD NEVER LEADS. It arrives with no venture chosen and
       draws a prompt until one is, and a prompt at the top of a board is
       not a headline whatever board it is on — so those trail even where
       the rest of the top-up leads. */
    const leads = TOP_UP_LEADS.has(d.id) ? arriving.filter((w) => !WIDGETS[w.type]?.perProject) : [];
    const trails = arriving.filter((w) => !leads.includes(w));
    return {
      ...d,
      widgets: [...leads, ...d.widgets, ...trails],
    };
  });

  return {
    ...state,
    seedVersion: SEED_VERSION,
    sessions,
    ventures,
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
  ["s-6", "Why is the site sliding on brand terms"],
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
    /*
      PyPI, folded in here rather than given a board. Growth asks where
      attention comes from, and for a library the answer is partly "people
      installed it" — the same question `hn.mentions` two cards up is asking
      from the other end. Nothing on this board adds a download to an
      impression; they are two counts of two different acts.
    */
    "pypi.downloads",
    "pypi.last30",
    "pypi.weekly",
    "pypi.packages",
  ],
  /*
    The Servers board shipped saying, in its own comment, that it had no memory
    or filesystem meter because Hetzner reports from the hypervisor and those
    live inside the guest. There is an ssh collector inside the guest now, so
    the two absent meters arrive — and the uptime probe with them, because "the
    box is at 40% memory" and "the site it serves is not answering" are the two
    halves of the same morning and only one of them is visible from Hetzner.
  */
  "d-servers": ["fleet.memory", "fleet.disk", "uptime.up", "uptime.tls"],
  /*
    Morning check gains the day's calendar and whether anything went down
    overnight — and now the run ledger with them. A run survives the tab
    closing and executes one at a time on the server, so "what did the agent
    get through overnight" is a real question nobody was being shown an answer
    to, and it belongs on the board somebody already opens at 8am rather than
    on one they would have to remember to visit. `uptime.status` was already
    here as a sample and is a measurement now without being listed: it kept its
    key, so the top-up has nothing to append.
  */
  "d-morning": ["calendar.today", "uptime.up", "runs.recent"],
  /*
    Search shipped as Google beside Bing and nothing about our own pages. Both
    engines report what THEY did with a site; the audit is the only source here
    that reports what the site itself is like, and an error count belongs at the
    top of the board where somebody is already asking why the impressions moved.
    Just the one figure: the SEO board is where the rest of the crawl lives.

    THEN, IN SEED_VERSION 17, WORKDASH'S ALL-PROPERTIES PAGE: the CTR and
    property tiles, the clicks twin of the impressions line, the dumbbell,
    the rail of every property with a sparkline, the per-property lines, and
    the per-property page's cards cut across the portfolio. They LEAD — see
    TOP_UP_LEADS — for the reason the SEO ones did: the first of them are
    tiles, and tiles appended under twenty cards are tiles nobody reads. The
    three `rows` cards they supersede stay where the owner has them.
  */
  "d-search": [
    "audit.issues",
    "gsc.ctr",
    "gsc.properties",
    "gsc.clicksTrend",
    "gsc.dumbbell",
    "gsc.rail",
    "gsc.propertyClicks",
    "gsc.propertyImpressions",
    "gsc.quiet",
    "gsc.queriesRanked",
    "gsc.pagesRanked",
    "gsc.strikingRanked",
    "gsc.propertyQueries",
    "gsc.propertyStriking",
    "gsc.zeroClick",
    "gsc.sitemapsByProperty",
    "gsc.cannot",
  ],
  /*
    Costs shipped as the metered providers alone — LLM, media, Hetzner's
    projection — with the ledger behind the Finance page nowhere on it. The
    rate card's eight cards arrive: the monthly bill, its groups, and the
    servers, services, electricity and domains line by line.
  */
  "d-costs": [
    "finance.monthly",
    "finance.renewals",
    "finance.unpriced",
    "finance.groups",
    "finance.servers",
    "finance.services",
    "finance.power",
    "finance.domains",
  ],
  /*
    SEO gained Workdash's graphs in SEED_VERSION 16: the search totals, the
    daily lines, every property drawn as itself, the ranked query and page
    lists, and the four documents this box computes on its own. They LEAD —
    see TOP_UP_LEADS — because the first of them are the totals the whole
    page is read from, and totals appended under twelve cards are totals
    nobody scrolls to. The two `rows` cards they supersede (`gsc.striking`,
    `gsc.pages`) are left where the owner has them: a top-up never removes.
  */
  "d-seo": [
    "gsc.clicks",
    "gsc.impressions",
    "gsc.ctr",
    "gsc.properties",
    "audit.crawled",
    "gsc.trend",
    "gsc.clicksTrend",
    "gsc.dumbbell",
    "audit.ranked",
    "gsc.propertyClicks",
    "gsc.propertyImpressions",
    "gsc.sites",
    "gsc.quiet",
    "gsc.queriesRanked",
    "gsc.pagesRanked",
    "gsc.strikingRanked",
    "gsc.zeroClick",
    "gsc.propertyQueries",
    "gsc.propertyStriking",
    "gsc.sitemapsByProperty",
    "indexing.told",
    "bing.propertyIndex",
    "authority.ceiling",
    "geo.mentioned",
    "seoops.moved",
    "gsc.cannot",
    /*
      THE PER-PROJECT GROUP (SEED_VERSION 17). These take a venture and
      arrive without one, so they TRAIL the board whatever TOP_UP_LEADS says
      — a "pick a venture" prompt is not a headline; see `migrate()`.
    */
    "gsc.project",
    "audit.project",
    "authority.project",
    "indexing.project",
    "seoops.project",
  ],
  /*
    Payments gained Workdash's graphs in SEED_VERSION 18. The cards that
    were already on the board (`payments.gross`, `payments.floor`,
    `payments.failRate`, `payments.movement`) kept their ids and changed
    KIND in place — a proportion bar under the figure, a waterfall for the
    movement — so a placed board upgrades on its next render with nothing
    to append. What is new is the two hero tiles with their own bars, the
    attempts card and the charge list, and they LEAD (see TOP_UP_LEADS)
    because the first two are the tiles the page is read from. The
    `stripe.mrr` and `stripe.subs` tiles they stand beside are left where
    the owner has them: a top-up never removes.
  */
  "d-payments": ["payments.mrr", "payments.subs", "payments.attempts", "payments.recent"],
};

/** The boards whose top-up leads rather than trails — see `migrate()`. */
const TOP_UP_LEADS = new Set(["d-costs", "d-seo", "d-search", "d-payments"]);

/** The addresses already taken inside one scope — a venture's boards, or the
 *  global set. Slugs are unique per scope, so this is what `uniqueSlug` is
 *  asked about rather than the whole list. */
function slugsIn(dashboards: Dashboard[], ventureId: string | null): string[] {
  return dashboards
    .filter((d) => (d.ventureId ?? null) === ventureId)
    .map((d) => d.slug);
}

/**
 * The server's ventures into a state, or the same state back.
 *
 * Shared by the provider's load-time fetch and by `reconcileVentures`, so
 * there is one rule for "what does the server's list do to this cache" rather
 * than two that can drift. Identity is preserved when nothing moved, because
 * every page that reads the store re-renders on a new array.
 */
function withVentures(s: StoreState, list: Venture[]): StoreState {
  const next = [...list].sort((a, b) => a.position - b.position);
  const same =
    next.length === s.ventures.length &&
    next.every((v, i) => {
      const had = s.ventures[i];
      return !!had && had.id === v.id && had.updatedAt === v.updatedAt;
    });
  return same ? s : { ...s, ventures: next };
}

type StoreApi = {
  state: StoreState;
  /**
   * THE VENTURE WRITES GO TO THE SERVER FIRST, then into the cache.
   *
   * All five are async, and the cache is only ever updated with the DOCUMENT
   * THE SERVER ANSWERED WITH rather than with what was sent. That matters more
   * than it looks: creating a venture with a website reads the site, so the
   * row that comes back carries a favicon, a palette and possibly a different
   * colour than the one that went up. Writing the request into the cache and
   * calling it done would show the owner a venture that does not exist.
   *
   * A failure REJECTS and changes nothing here. The pages catch it and say so;
   * a cache quietly holding a venture the server refused is the one outcome
   * worth ruling out.
   */
  addVenture: (input: VentureInput) => Promise<Venture>;
  updateVenture: (id: string, patch: VenturePatch) => Promise<Venture>;
  /** Deletes the venture AND its dashboards — they are this app's state, not
   *  the server's, so nothing else would ever collect them. Board cards keep
   *  their `ventureId` and are drawn unfiled, and sessions stop naming it. */
  deleteVenture: (id: string) => Promise<void>;
  /** Read the site again and take whatever it says now. */
  enrichVenture: (id: string) => Promise<Venture>;
  reorderVentures: (ids: string[]) => Promise<void>;
  /**
   * The server's list, wholesale.
   *
   * WHOLESALE IS THE POINT, and it is the opposite of what `reconcileSessions`
   * does one field away. A session can exist only in this browser — an empty
   * draft nobody has spoken into — so that reconcile keeps what the server has
   * never heard of. A venture cannot: every one of them was created through
   * the API, so the server's list IS the list and anything else in this cache
   * is a row that has been deleted somewhere else.
   *
   * A FAILED FETCH NEVER CALLS THIS. Not knowing is not a reason to delete.
   */
  reconcileVentures: (list: Venture[]) => void;
  /**
   * A session may name a venture or none at all. Newest lands first.
   *
   * IT DOES NOT OPEN THE CHAT, and there is nothing here that could: opening
   * one is `navigate("/chat/<id>")`, and the caller that made the session is
   * the caller that knows whether it wants to go there. There is deliberately
   * no `setActiveSession` beside it — see `StoreState` for why
   * one copy of "which chat is open" beats two.
   */
  addSession: (title: string, ventureId?: string | null) => Session;
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
  reconcileSessions: (
    server: { id: string; title: string; children?: SessionChild[] }[],
  ) => void;
  /**
   * WHICH CHATS ARE BEING ANSWERED RIGHT NOW, so the rail can say so.
   *
   * DELIBERATELY NOT PART OF `StoreState`. Everything in that object is
   * mirrored to localStorage on every change, and a "this chat is streaming"
   * flag that survives a reload would be a lie the moment it was written: the
   * stream belongs to a request, the request dies with the tab, and nothing
   * can re-attach to it. A dot that came back after a refresh would report an
   * answer that nobody is receiving.
   *
   * So it lives beside the persisted state instead — same provider, same
   * hook, no migration, and gone on reload, which is the truth. The Chat page
   * sets it when a turn leaves and clears it when the turn ends, including
   * when it ends by being aborted.
   */
  streamingSessions: string[];
  setSessionStreaming: (id: string, streaming: boolean) => void;
  /** A board in one scope: the global set, or a venture's own. */
  addDashboard: (name: string, presetId: string, ventureId?: string | null) => Dashboard;
  /**
   * THE CROSS-POLLINATION: one board's widgets, in another scope.
   *
   * Widgets are copied with FRESH IDS, so dragging a card on the copy cannot
   * move one on the original — a placed widget's id is its identity within a
   * board and two boards sharing one is a bug that only shows up under a
   * reorder. The name defaults to the source's and the slug is made unique
   * inside the TARGET scope, which is what lets "Search" exist once globally
   * and once under every venture.
   */
  copyDashboard: (
    sourceId: string,
    into: { name?: string; ventureId: string | null },
  ) => Dashboard | null;
  /** The boards of one scope, in order: a venture's, or the global set with
   *  `null`. One function so the two pages cannot disagree about what "this
   *  venture's boards" means. */
  dashboardsIn: (ventureId: string | null) => Dashboard[];
  renameDashboard: (id: string, name: string) => void;
  deleteDashboard: (id: string) => void;
  /** The strip's order, as a list of ids. Ids not in the list keep their
   *  relative order at the end, so a stale list can never lose a board. */
  reorderDashboards: (ids: string[]) => void;
  setAppOrder: (slugs: string[]) => void;
  /** The chrome's palette. An unknown id clears it back to the default rather
   *  than storing a name nothing can draw. */
  setPalette: (id: PaletteId) => void;
  /** The window every dashboard page is drawn over. A value the picker cannot
   *  draw clears it back to the default rather than being stored. */
  setDashboardWindow: (w: WindowValue) => void;
  setWidgets: (dashboardId: string, widgets: PlacedWidget[]) => void;
  setWorkspace: (patch: Partial<Workspace>) => void;
  togglePinned: (pin: SidebarPin) => void;
  reorderPinned: (keys: string[]) => void;
  setPluginConnected: (id: string, connected: boolean) => void;
  /** Replace everything — the other half of the export on Settings → Data. */
  importState: (next: StoreState) => void;
  /** Back to the starting set. The only destructive control in Settings. */
  reset: () => void;
};

const StoreContext = createContext<StoreApi | null>(null);

/**
 * Whether two children lists say the same thing.
 *
 * BY VALUE, BECAUSE THE SERVER SENDS A NEW ARRAY EVERY POLL. The reconcile
 * decides whether to keep a session's identity by comparing what changed, and
 * a fresh array of identical rows is not a change — without this, every poll
 * would hand the rail a new object for every chat that ever dispatched
 * anything and re-render the whole list. Undefined and empty are the same
 * answer: nothing was dispatched.
 */
function sameChildren(a?: SessionChild[], b?: SessionChild[]): boolean {
  if (a === b) return true;
  if (!a?.length || !b?.length) return !a?.length && !b?.length;
  return (
    a.length === b.length &&
    a.every((c, i) => {
      const d = b[i];
      return c.id === d.id && c.title === d.title && c.to === d.to && c.status === d.status;
    })
  );
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreState>(load);
  const sync = useWorkspaceSync(state, setState, migrate);
  const [storageError, setStorageError] = useState("");

  /* The chats with a turn in flight. Not in `state`, and not persisted — see
     `setSessionStreaming` on the API type for why that is a correctness
     matter rather than a tidiness one. */
  const [streamingSessions, setStreamingSessions] = useState<string[]>([]);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      setStorageError("");
    } catch {
      setStorageError("Browser storage is full or unavailable. Keep this page open until server sync succeeds.");
      /* the session still works without persistence */
    }
  }, [state]);

  /**
   * THE VENTURES, ASKED FOR ONCE, HERE.
   *
   * In the provider rather than on the Ventures page, because every screen
   * reads them: the rail counts them, the chat picker lists them, the board
   * colours its chips with them. A page-level fetch would mean the picker
   * showing a stale name until somebody happened to visit /ventures.
   *
   * ONCE, AND THE REF IS WHY — the same guard the session reconcile uses one
   * page away. Without it this writes state, gets a new render, and asks
   * again forever.
   *
   * A FAILURE IS SILENT AND CHANGES NOTHING. The cache is what this browser
   * last saw and it is still the best knowledge available; replacing it with
   * an empty list because a local API is not running would delete the rail's
   * ventures over a dropped request.
   */
  /*
    THE GUARD AND THE CLEANUP USED TO CANCEL EACH OTHER OUT. Under React's
    StrictMode the effect runs, is cleaned up, and runs again on the same
    mount: the first run set the ref and started the fetch, the cleanup
    flipped `alive` to false so the answer was thrown away, and the second run
    saw the ref and returned — so a browser with an empty cache showed "0
    ventures" until somebody visited /ventures. The ref now records that a
    fetch has LANDED, not that one was started, and the in-flight one is
    simply allowed to land: a second setState with the same list is a cheap
    no-op, and a dropped answer is the failure this effect exists to avoid.
  */
  useEffect(() => {
    let alive = true;
    const refresh = () => { void api.ventures.list().then(doc => { if (alive) setState(s => withVentures(s, doc.ventures)); }).catch(() => {}); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("opc:data-changed", refresh);
    return () => { alive = false; window.removeEventListener("focus", refresh); window.removeEventListener("opc:data-changed", refresh); };
  }, []);

  const store = useMemo<StoreApi>(() => {
    const mapDashboards = (fn: (d: Dashboard) => Dashboard) =>
      setState((s) => ({ ...s, dashboards: s.dashboards.map(fn) }));

    /* The owner's order, which is the server's `position`. Applied on the way
       into the cache so no page has to remember to sort. */
    const byPosition = (a: Venture, b: Venture) => a.position - b.position;

    /** One venture into the cache: replaced if it is already there, appended
     *  if it is new, and the list re-sorted. */
    const cache = (venture: Venture) =>
      setState((s) => ({
        ...s,
        ventures: [...s.ventures.filter((v) => v.id !== venture.id), venture].sort(
          byPosition,
        ),
      }));

    return {
      state,

      async addVenture(input) {
        const venture = await api.ventures.create(input);
        cache(venture);
        return venture;
      },

      async updateVenture(id, patch) {
        const venture = await api.ventures.update(id, patch);
        cache(venture);
        return venture;
      },

      async enrichVenture(id) {
        const venture = await api.ventures.enrich(id);
        cache(venture);
        return venture;
      },

      /*
        A deleted venture does not take its chats with it. They stop naming it
        and stay in the list, which is the whole point of the flat rail.

        ITS DASHBOARDS DO GO, and they are the one thing here that would
        otherwise be orphaned: a board at /ventures/<slug>/dashboards/<board>
        has no address once the venture is gone, and nothing else would ever
        find it to delete it. The confirm on the edit page counts them out loud
        before this is called.
      */
      async deleteVenture(id) {
        await api.ventures.remove(id);
        setState((s) => ({
          ...s,
          ventures: s.ventures.filter((v) => v.id !== id),
          dashboards: s.dashboards.filter((d) => d.ventureId !== id),
          sessions: s.sessions.map((x) =>
            x.ventureId === id ? { ...x, ventureId: null } : x,
          ),
        }));
      },

      async reorderVentures(ids) {
        const { ventures } = await api.ventures.reorder(ids);
        setState((s) => ({ ...s, ventures: [...ventures].sort(byPosition) }));
      },

      reconcileVentures(list) {
        setState((s) => withVentures(s, list));
      },

      addSession(title, ventureId) {
        const session: Session = {
          id: uid("s"),
          title,
          ventureId: ventureId ?? null,
        };
        setState((s) => ({
          ...s,
          sessions: [session, ...s.sessions],
        }));
        return session;
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
        /*
          THE ROW, AND ONLY THE ROW. Deleting the chat somebody is READING
          also has to take them somewhere, and that is a navigation now rather
          than a field being nulled — the rail does it, because the rail is
          where the address is known. See `deleteSession` in `AppSidebar`,
          which also deletes the transcript: two deletions, both required, and
          neither of them this one.
        */
        setState((s) => ({
          ...s,
          sessions: s.sessions.filter((x) => x.id !== id),
          pinnedItems: sidebarPins(s).filter(pin => pin.type !== "session" || pin.sessionId !== id),
        }));
      },

      reconcileSessions(server) {
        setState((s) => {
          const known = new Set(s.sessions.map((x) => x.id));
          const onServer = new Set(server.map((x) => x.id));

          const titles = new Map(server.map((x) => [x.id, x.title]));
          /* The children are the server's, wholesale — see `SessionChild`.
             A session the server did not mention keeps what it has, because
             silence about a chat is not a statement that it dispatched
             nothing. */
          const kids = new Map(server.map((x) => [x.id, x.children]));

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
            .map((x) => {
              const children = onServer.has(x.id) ? kids.get(x.id) : x.children;
              /* Identity is preserved when nothing about this session moved,
                 because the whole list below is compared by reference to
                 decide whether the rail re-renders at all. */
              if (!x.seeded && sameChildren(x.children, children)) return x;
              return {
                ...x,
                ...(x.seeded
                  ? { title: titles.get(x.id) ?? x.title, seeded: undefined }
                  : null),
                children,
              };
            });

          /* New arrivals go on top, in the order the server gave them — which
             is newest activity first, the same order the rail reads in. */
          const added: Session[] = server
            .filter((x) => !known.has(x.id))
            .map((x) => ({
              id: x.id,
              title: x.title,
              ventureId: null,
              children: x.children,
            }));

          if (!added.length && kept.length === s.sessions.length) {
            /* Nothing changed except possibly the marks, and a new array with
               the same contents is a re-render of every page that reads this. */
            const same = kept.every((x, i) => x === s.sessions[i]);
            if (same) return s;
          }

          /* A session that has just been swept is no longer a place to be,
             and nothing here has to say so any more: the Chat page reads the
             address, finds no such conversation in the reconciled list, and
             says that in as many words. Nulling a field was the old way of
             answering the same question one render earlier and one page
             further from where it is asked. */
          return { ...s, sessions: [...added, ...kept] };
        });
      },

      streamingSessions,

      setSessionStreaming(id, streaming) {
        setStreamingSessions((ids) => {
          const has = ids.includes(id);
          /* The same array back when nothing changed: this is called at the
             start and end of every turn, and a fresh array each time would
             re-render every page that reads the store for no reason. */
          if (has === streaming) return ids;
          return streaming ? [...ids, id] : ids.filter((x) => x !== id);
        });
      },

      addDashboard(name, presetId, ventureId = null) {
        const preset = DASHBOARD_PRESETS.find((p) => p.id === presetId);
        const board: Dashboard = {
          id: uid("d"),
          /* Unique WITHIN THE SCOPE it is being made in. A venture's "Search"
             board and the global one are two addresses, and forcing the second
             of them to be "search-2" would be an apology for a collision that
             does not exist. */
          slug: uniqueSlug(name, slugsIn(state.dashboards, ventureId)),
          name,
          ventureId,
          widgets: (preset?.widgets ?? []).map((type) => ({
            id: uid("w"),
            type,
            w: defaultWidth(type),
          })),
        };
        setState((s) => ({ ...s, dashboards: [...s.dashboards, board] }));
        return board;
      },

      copyDashboard(sourceId, into) {
        const source = state.dashboards.find((d) => d.id === sourceId);
        if (!source) return null;
        const name = into.name?.trim() || source.name;
        const board: Dashboard = {
          id: uid("d"),
          slug: uniqueSlug(name, slugsIn(state.dashboards, into.ventureId)),
          name,
          ventureId: into.ventureId,
          /* A DEEP COPY WITH NEW IDS. The types and the widths are the whole
             point of copying a board; the ids are not, and sharing one would
             make a reorder on the copy move a card on the original. */
          widgets: source.widgets.map((w) => ({ ...w, id: uid("w") })),
        };
        setState((s) => ({ ...s, dashboards: [...s.dashboards, board] }));
        return board;
      },

      dashboardsIn(ventureId) {
        return state.dashboards.filter(
          (d) => (d.ventureId ?? null) === ventureId,
        );
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

      setPalette(id) {
        setState((s) => ({ ...s, palette: isPaletteId(id) ? id : undefined }));
      },

      setDashboardWindow(w) {
        setState((s) => ({
          ...s,
          dashboardWindow: isWindowValue(w) && w !== DEFAULT_WINDOW ? w : undefined,
        }));
      },

      togglePinned(pin) {
        setState(s => ({ ...s, pinnedItems: togglePin(s, pin), favoritePaths: undefined }));
      },
      reorderPinned(keys) {
        setState(s => ({ ...s, pinnedItems: reorderPins(s, keys), favoritePaths: undefined }));
      },
      setWorkspace(patch) {
        setState((s) => ({ ...s, workspace: { ...s.workspace, ...patch } }));
      },

      setPluginConnected(id, connected) {
        setState((s) => ({ ...s, plugins: { ...s.plugins, [id]: connected } }));
      },

      importState(next) {
        if (!isStoreState(next)) throw new Error("Invalid workspace export.");
        saveRecovery(state);
        setState(s => ({ ...s, ...preferences(next) }));
      },

      reset() {
        saveRecovery(state);
        setState(s => ({ ...s, workspace: structuredClone(SEED.workspace), dashboards: structuredClone(SEED.dashboards), appOrder: [], favoritePaths: [], pinnedItems: [], seedVersion: SEED_VERSION }));
      },
    };
  }, [state, streamingSessions]);

  return <StoreContext.Provider value={store}>
    {(sync.status || storageError) && <div role="status" className="bg-amber-50 text-black border-b p-2 text-sm flex flex-wrap gap-2 items-center">
      <span>{storageError || sync.status}</span>
      {sync.hasConflict ? <><button className="underline" onClick={() => void sync.resolve(false)}>Use server version</button><button className="underline" onClick={() => void sync.resolve(true)}>Keep this browser version</button></> : <button className="underline" onClick={() => void sync.retry()}>Retry sync</button>}
      <a className="underline" href="/settings?tab=data">Export or recover</a>
    </div>}
    {children}
  </StoreContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
