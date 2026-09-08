/**
 * DASHBOARD WIDGETS.
 *
 * A widget can only come from a service that is actually wired up, so the
 * source list mirrors the plugin catalog. Sample values are fixed rather than
 * generated, so a reload does not repaint the board with different numbers.
 */

import type { WidgetWindow } from "../lib/window.ts";

export type WidgetKind =
  | "metric"
  | "bars"
  | "rows"
  | "statuses"
  | "chart"
  | "meters"
  | "table"
  | "runway"
  | "donut"
  | "ranked"
  | "dumbbell"
  | "profile"
  | "proportion"
  | "waterfall"
  | "feed";

export type StatusTone = "ok" | "warn" | "bad";

/**
 * ONE PUBLISHED THING, DRAWN AS ITSELF — an advertisement, a post, a video.
 *
 * THE FORM EXISTS BECAUSE A ROW OF NUMBERS ABOUT A PICTURE IS NOT A PICTURE.
 * Every other kind in this file draws a quantity: a bar is how much, a table
 * is which, a ranked list is which is biggest. None of them can answer "what
 * did people actually see", and that is the question a creative or a post is
 * on a board to answer — you cannot decide what to change about an
 * advertisement from five figures about a thing you cannot look at.
 *
 * `meta` IS THE NUMBERS AND IT IS ALREADY FORMATTED, for `DonutSlice.text`'s
 * reason: the card does not decide what a euro or a click-through looks like,
 * and a creative's cost per click is quoted in the ad account's own currency
 * which only the builder knows.
 *
 * A MISSING IMAGE IS A FIXED EMPTY BOX, never a collapsed row. Meta's creative
 * urls are signed and expire within days, so a frame that 403s is the normal
 * failure here rather than the exceptional one; a card that reflowed around it
 * would redraw itself as the pictures dropped out, and a broken frame reads as
 * "this advertisement had no picture", which is a claim about the advertisement.
 */
export type FeedItem = {
  /** The headline, or who published it — a Page, a handle, a destination. */
  title: string;
  /** What it said. Null is a post with no words, drawn as such; wrapped and
   *  clamped by the card, not by the builder. */
  text?: string | null;
  /** An image URL. Rendered as a plain lazy `<img>` in a fixed box, with an
   *  alt, and hidden rather than drawn broken when it fails. Never a script,
   *  never an embed. */
  image?: string | null;
  /** Where this thing lives, or where it pointed. Null is an item with no
   *  public address, which the card says rather than drawing a dead link. */
  href?: string | null;
  /** Label/value pairs under the text, already formatted. */
  meta?: [string, string][];
  /** When it was published or last changed — ISO, or already in words. */
  at?: string;
  /** A judgement on the item, drawn as a dot before the title. Absent for an
   *  item nobody is judging — a post is just a post. */
  tone?: StatusTone;
};

/** A line on a chart. Timestamps rather than bare numbers, because the axis
 *  labels and the "is this window long enough to call a trend" question both
 *  need to know when a point was taken. */
export type ChartSeries = {
  label: string;
  points: { ts: string; value: number }[];
};

/**
 * One reading judged against its own pair of limits.
 *
 * The two lines travel WITH the reading rather than with the card, because
 * different metrics are urgent at different heights — the same 80 is a quiet
 * afternoon on a CPU and a bad morning on a disk.
 */
export type Meter = {
  label: string;
  /** 0–100 unless `max` says otherwise. */
  value: number;
  warn: number;
  crit: number;
  /** Small print to the right of the figure: what it is out of, how it moved. */
  note?: string;
};

/**
 * One thing with a deadline, placed on a shared time axis.
 *
 * `days` is a COUNTDOWN and may be negative — a date that has already passed is
 * the single most urgent row a runway can carry, and clamping it to zero on the
 * way in would hide it among the things that merely expire today.
 */
export type RunwayRow = {
  label: string;
  days: number;
  /** Detail on the right of the row: who holds it, whether it renews itself. */
  sub?: string;
  /**
   * The calendar day the countdown is TO, as the provider reported it —
   * "2027-05-31". Only the hover shows it: a column of dates beside a column
   * of distances is the arithmetic the chart exists to have already done, but
   * "18d" is not something you can put in a calendar, and the moment a reader
   * cares about one row they want the actual date.
   */
  at?: string | null;
};

/**
 * One part of a whole, for the donut.
 *
 * `value` is the geometry and `text` is what the legend prints; they are two
 * fields because the builder already knows the currency and the digits, and a
 * chart that formatted money itself would be the second place that decided
 * what a euro looks like. `sub` is the line under the label — "9 boxes",
 * "32 models · 10,684 requests" — the same small print the cost pages put
 * beside every group.
 */
export type DonutSlice = {
  label: string;
  value: number;
  text: string;
  sub?: string;
};

/**
 * One row of a ranked bar chart: a name, a length and the figure at its tip.
 *
 * `sub` sits right-aligned on the name's line — a token count, a run count —
 * so a long bar over a small sub reads as "expensive per unit" without a
 * table. `mark` is a model or provider name for the small mark beside the
 * label; see components/ModelMark.
 */
export type RankedRow = {
  label: string;
  value: number;
  text: string;
  sub?: string;
  mark?: string | null;
  /**
   * The row's own recent line — a few dozen daily values — drawn small
   * beside the name. For a list where the bar says HOW MUCH and the question
   * behind it is WHICH WAY: a property with the second-longest bar and a
   * falling line is a different row from one with the same bar rising. A
   * shape only, no axis and no hover; the figures are in `text` and `sub`.
   */
  spark?: number[];
};

/**
 * One figure on a profile card: a label, the figure, and a word under it.
 *
 * Two to four of these sit in a row at the top of a `profile` — the four
 * tiles Workdash's property card opens with — and every one is already
 * formatted by the builder, for the reason `DonutSlice.text` is: the card
 * does not decide what a click count or a rank looks like.
 */
export type ProfileFigure = {
  label: string;
  value: string;
  sub?: string;
};

/**
 * One row of a dumbbell: a name and TWO magnitudes on one axis, joined.
 *
 * The connector is the finding. A row where `a` and `b` sit close together
 * and a row where they are two decades apart are the same two columns in a
 * table and two different pictures here — which is why this is a kind of its
 * own rather than a ranked bar with a second figure in its sub-line. `text`
 * is what the row prints at the right, already formatted; `sub` is the small
 * print beside the name, the way `RankedRow.sub` is.
 */
export type DumbbellRow = {
  label: string;
  a: number;
  b: number;
  text: string;
  sub?: string;
};

/**
 * One part of a whole, for the proportion bar — the form for two or three
 * parts of something whose size is already on the card: attempts that
 * settled against attempts that failed, the book by state, MRR by plan.
 *
 * `tone` is set only where a part is being JUDGED — "failed" is bad, "past
 * due" is a warning — and a part without one takes the next series colour,
 * so a bar of four plans is four hues and a bar of succeeded-against-failed
 * is green against red. `text` is what the key prints beside the label,
 * already formatted; absent, the key prints the share.
 */
export type ProportionPart = {
  label: string;
  value: number;
  text?: string;
  tone?: StatusTone;
};

/**
 * One step of a waterfall: what was added, what was taken away, what is left.
 *
 * `value` is SIGNED and is the geometry; `text` is what the bar prints above
 * itself, already formatted, because the builder knows the currency and the
 * chart must not decide what a euro looks like. A `total` step is drawn from
 * the baseline to the running sum rather than hanging off the previous bar —
 * the "Net" at the end — and its own `value` is that sum.
 */
export type WaterfallStep = {
  label: string;
  /** The quiet line under the word — "226 subs", "over 30 days". */
  sub?: string;
  value: number;
  text: string;
  total?: boolean;
};


export type WidgetSource = {
  name: string;
  /** Simple Icons slug, or null for a service with no brand mark. */
  icon: string | null;
  mono?: string;
  tint?: string;
  connected: boolean;
};

export type Widget = {
  src: string;
  name: string;
  kind: WidgetKind;
  /**
   * A CARD ABOUT ONE VENTURE, chosen on the card.
   *
   * Every widget draws the whole portfolio unless the board it is on belongs
   * to a venture. A per-project widget is the other way round: it carries
   * its venture with it (`PlacedWidget.param`, a venture id) and draws only
   * that venture's rows wherever it is placed, so a global board can hold
   * "Search · Example App 1" beside "Search · FreeLLMAPI". The card resolves the
   * id to the venture's hosts and narrows the live documents with the rule a
   * venture board uses (lib/scope `narrowLive`) before the builder runs;
   * the builder gets `project` in its inputs and reads the documents as a
   * venture board's card would. In edit mode the card's header carries a
   * venture picker, and the palette asks which venture before adding one.
   */
  perProject?: boolean;
  /**
   * Where the real numbers come from, once the provider is connected:
   * a key in the server's `readings` table, or "summary" for a provider
   * endpoint that reports current state rather than a series.
   *
   * Absent means the sample values below are all there is.
   */
  live?: {
    /** A key in the server's readings table, for the history half. */
    metric?: string;
    /** The domain portfolio, merged across every connected registrar. */
    domains?: boolean;
    /** The stock libraries' remaining request allowance. */
    stock?: boolean;
    /** Current-state endpoints the builder needs. */
    summary?: boolean;
    fleet?: boolean;
    /** Per-server samples: what each box has been DOING over a window. */
    load?: boolean;
    volumes?: boolean;
    /** The repos, their traffic and what is left of the API budget. */
    github?: boolean;
    /** Downloads by day and by ISO week, for the configured packages. */
    npm?: boolean;
    /** The costs report: OpenAI's day-and-project rows, OpenRouter's two
     *  unjoinable cuts, and Replicate's prediction history — which carries no
     *  money at all, and says so. */
    costs?: boolean;
    /** Both app stores: where each app is, what was installed, and the two
     *  kinds of money each store reports — the estimate and the payout, kept
     *  apart and never added. */
    mobile?: boolean;
    /** Stripe: the subscription book, the balance ledger and the payment
     *  attempts, with MRR and churn computed from the rows on every read. */
    stripe?: boolean;
    /** AdSense: ad earnings per site — or, until somebody grants consent in a
     *  browser, the honest reason there are none. Asked for even while the
     *  plugin is not connected, because that state is what its cards say. */
    adsense?: boolean;
    /** Search Console: every verified property, its FINALISED daily line, and
     *  how much of each property the ranked query rows actually cover. */
    gsc?: boolean;
    /** Bing Webmaster: what Bing showed, what it has indexed, what it says
     *  links in — and, for phrases the owner names, how many people search
     *  them whether or not anything of ours ranks. Its own flag beside
     *  Google's, because nothing here adds the two engines together. */
    bing?: boolean;
    /** Cloudflare: the zones, their records, their daily traffic rollups, and
     *  the join between the nameservers Cloudflare assigned and the ones each
     *  registrar actually delegates to. */
    cloudflare?: boolean;
    /** Meta: the Pages, the ad account's window, campaigns and daily line —
     *  and the Instagram answer, which is a FIELD on a Page rather than an API
     *  of its own. One flag serves both sources, because one fetch does: an
     *  `instagram` flag beside this one would be a second thing to keep in step
     *  for a document the first one already has. */
    meta?: boolean;
    /** Reddit, Hacker News and the search node behind both, in one document.
     *  ONE FLAG FOR THREE SOURCES, the way `meta` serves Meta and Instagram,
     *  and for the stronger version of that reason: SearXNG is literally the
     *  tier that answers a Reddit query the Atom feed refuses, so a card about
     *  Reddit's fallback and a card about the node's health read the same
     *  fetch. Threads add across the two social sources; upvotes never do, and
     *  no builder below crosses them. */
    demand?: boolean;
    /** Mail: the mailboxes and the sending domains in one document. ONE FLAG
     *  FOR TWO SOURCES, the way `demand` serves three — not because a figure
     *  spans them, but because the opposite is true and there is nothing to
     *  guard against: an inbox thread waiting on a reply and a transactional
     *  password reset are different kinds of thing, and no builder below adds
     *  one to the other. One fetch, one clock, two blocks. */
    mail?: boolean;
    /** Umami: the websites, their last thirty complete days, and the daily
     *  line. NO PORTFOLIO VISITOR FIGURE — see the source note. */
    umami?: boolean;
    /** Google Calendar: today, the week ahead, and merged busy hours. The one
     *  source on this page with no site on any row, so it is never narrowed to
     *  a venture: a morning belongs to the owner, not to a domain. */
    calendar?: boolean;
    /** PyPI: downloads by day and by ISO week for the configured packages. */
    pypi?: boolean;
    /** Bluesky: the handles, their followers and what their posts carry now.
     *  Followers are never added across handles. */
    bluesky?: boolean;
    /** The uptime probe: what answered, how fast, and how long each
     *  certificate has left. Measured from THIS box, at whatever cadence the
     *  scheduler managed — which is why every percentage travels with its
     *  check count. */
    uptime?: boolean;
    /** The ssh fleet: memory, disks, load per cpu, containers and the owner's
     *  own counters. Memory adds across boxes; disk and load never do.
     *
     *  Called `boxes` and not `fleet`, because `fleet` above is already
     *  Hetzner's server list and the two are different populations: a Hetzner
     *  box with no ssh credential is in one and not the other, and half of
     *  these machines are somebody else's hardware. */
    boxes?: boolean;
    /** Product endpoints: reachability and the figures the owner mapped out of
     *  each one's JSON. Never totalled across endpoints. */
    products?: boolean;
    /** Inbound links, per source, with the confidence on each row and an
     *  explicit refusal to add two sources together. */
    backlinks?: boolean;
    /** The off-site footprint as a matrix, product × directory — where
     *  "blocked" means NOT CHECKED and never "not listed". */
    presence?: boolean;

    /*
      THE THREE THAT ARE NOT PROVIDERS.

      Every flag above names somebody else's API and comes with a plugin that
      is connected or is not. These three name THIS BOX'S OWN TABLES — the
      crawler it runs against its ventures, the agent runs it executes, and the
      rivals those runs accumulated — so there is no credential behind them and
      nothing to connect. A card of theirs showing samples is not an
      unconfigured integration; it is work that has not been done yet, and the
      cards say so in those words.
    */
    /** Every venture's last crawl, one row each. Never the crawl itself: the
     *  full document is a megabyte and this is a column of counts. */
    audit?: boolean;
    /** The run ledger — what is executing, what is queued, what finished. */
    runs?: boolean;
    /** This box's own LLM use — tokens by day, model, kind of work and
     *  venture, from the chat and run ledgers it writes itself. */
    llm?: boolean;
    /** The competitor profiles the sweeps have accumulated, with the date each
     *  one was last VERIFIED rather than last written. */
    competitors?: boolean;
    /** This box's own cost ledger — every recurring bill, per currency, with
     *  the renewals ahead and the electricity model. The rate card behind the
     *  Finance page, drawn as cards. */
    finance?: boolean;
    /*
      THE PAYMENTS BOARD'S THREE COMPANION DOCUMENTS, each computed from the
      Stripe tables on every read and each its own flag, so a card that only
      needs the leakage buckets does not ask for the recovery queue. All three
      are gated on the Stripe plugin in live.tsx — there is no credential
      behind them but Stripe's.
    */
    /** Where money is leaking out: refunds, disputes, declines, past-due
     *  subscriptions, coupons, abandoned checkouts — two totals, never added. */
    leakage?: boolean;
    /** The dispute cases beside the ledger's dispute money, kept apart. */
    disputes?: boolean;
    /** The recovery queue: who has asked to cancel, whose card is failing. */
    queue?: boolean;
    /** The four SEO documents this box computes itself — authority, AI
     *  visibility, follow-ups, IndexNow — asked for as one bundle. */
    seo?: boolean;
    /** The POSTS. The timeline the socialfeed area reads back from Meta every
     *  six hours, and the publishing area's queue beside it — what went out,
     *  how it did, where it went, and what is still waiting. One flag for two
     *  routes because it is one fetch and one question; nothing in it adds a
     *  queued draft to a published post. See lib/api/socialboard. */
    social?: boolean;
    /**
     * The three ads documents this box computes over Meta's own rows: the
     * health rubric, the advertisements with their creatives, and the
     * campaign → venture map. One bundle, three fields, nothing summed
     * across them.
     *
     * ITS OWN FLAG BESIDE `meta`, not a widening of it, and the reason is the
     * fetch rather than the subject. `/api/meta` is one request; this is three
     * more against three different routers, and a board carrying only the
     * spend tile must not pay for a rubric it does not draw. Both are gated on
     * the same Meta plugin in live.tsx, because all four documents come off
     * rows the same collector wrote.
     */
    ads?: boolean;
  };
  /**
   * A WORD ABOUT WHAT KIND OF NUMBER THIS IS, worn as a small mono pill after
   * the name — "measured", "est.", "metered". The cost pages this board
   * is modelled on put one on every line, because a bill and a projection and
   * a metered actual look identical as figures and are three different
   * things to act on. Set by the builder, so it only ever appears on a live
   * card: a sample cannot be "measured". One word, because it shares a line
   * with the name in a one-column tile and the window is already in the name.
   */
  tag?: string;
  /**
   * WHICH WINDOW THE NAME CARRIES — see lib/window. `"selected"` names carry
   * no span here and the card appends the picker's ("Net revenue · 30d");
   * `"now"` is a level the picker does not move and the card says so. A name
   * with a literal span in it ("Repo views · 14d") is a source's own window
   * that cannot follow the picker, and its builder says why.
   */
  window?: WidgetWindow;
  /** metric */
  value?: string;
  /** Colours the reading and puts a word beside it — "watch", "act". Only for
   *  a figure that is being judged against a limit; a revenue number has no
   *  tone, it is just large or small. */
  tone?: StatusTone;
  delta?: number;
  /** true when down is the good direction (churn, spend, latency). */
  invert?: boolean;
  sub?: string;
  series?: number[];
  /**
   * When each `series` value was taken, same order and length.
   *
   * Optional because the catalog's sample series are shapes rather than
   * histories and have no timestamps to give; a sparkline with them says WHEN
   * a point was read on hover, and one without says which sample it was rather
   * than inventing a clock.
   */
  seriesAt?: string[];
  /** bars */
  bars?: number[];
  /** The one-line summary under the bars — "nbg1 4 · fsn1 2 · hel1 1". */
  labels?: string;
  /**
   * One complete phrase per bar, same order as `bars` — "nbg1 · 4 servers".
   *
   * A second field rather than a parse of `labels`, because `labels` is not
   * always a list: half the catalog's bar widgets say something about the set
   * as a whole there ("top 8 zones, 24h"), and splitting that on a separator
   * it does not contain would label every bar with the same sentence. A bar
   * with no phrase hovers as its own value and nothing else.
   */
  barLabels?: string[];
  /**
   * A MODEL OR PROVIDER NAME PER ROW OR BAR, same order, for the small mark
   * drawn beside it — `google/gemini-3.7-flash`, `gpt-5.6-luna`. Null for a
   * row that is not a model. See components/ModelMark: the name stays in
   * text; the mark reinforces it and never replaces it.
   */
  marks?: (string | null)[];
  /** rows */
  rows?: [string, string][];
  /** statuses */
  statuses?: [string, StatusTone][];
  /** chart — one or two lines over time, with what a point IS written under. */
  chart?: ChartSeries[];
  /** What the numbers on a chart or sparkline ARE. See ChartUnit. */
  unit?: "percent" | "bytes" | "count" | "usd";
  caption?: string;
  /** meters */
  meters?: Meter[];
  /** table — headers and rows, scrolled sideways rather than wrapped. */
  headers?: string[];
  table?: string[][];
  /** donut — parts of one whole, with the whole written in the hole and the
   *  legend carrying the figures. Four slices at most; past that the form is
   *  unreadable and `ranked` is the answer. */
  slices?: DonutSlice[];
  /** What the hole says: the total, and what it is per. */
  center?: { value: string; note: string };
  /** ranked — horizontal bars, largest first, the figure at each bar's tip. */
  ranked?: RankedRow[];
  /** ranked — the furthest the axis goes, whatever the rows say. Set it ONLY
   *  for a figure that is already out of something (a score out of 100): with
   *  it, a bar's length is the share of the available credit earned; without
   *  it, the longest row is simply the biggest and four mediocre scores would
   *  draw as one full bar and three nearly-full ones. See charts `Ranked`. */
  rankedMax?: number;
  /**
   * proportion — a figure and the whole it is part of. The hero is `value`
   * and `sub` as on a metric; `parts` is the split bar under it with a key
   * per part; `partsLabel` is the sentence the bar is read as ("Payment
   * attempts over 30d"). A `series` under that is a sparkline with
   * `seriesLabel` naming what it is; `ranked` rows and `rows` after it are
   * the card's detail, and `caption` closes it. Every field but `parts` is
   * optional, so the same kind draws a hero tile with one bar and a card
   * with a bar, a trend and a table of buckets.
   */
  parts?: ProportionPart[];
  partsLabel?: string;
  seriesLabel?: string;
  /** waterfall — signed steps from a baseline, the last one a total. `rows`
   *  under it are the lines the picture does not carry. */
  steps?: WaterfallStep[];
  /** feed — the published things themselves, with their pictures and their
   *  words. `caption` closes the card as it does everywhere else. */
  feed?: FeedItem[];
  /**
   * table — a judgement per row, drawn as a dot before the first cell. Null
   * for a row that is not judged; absent when no row on the table is. A
   * charge list is the case: settled, failed and refunded are three words
   * that are read faster as three colours, and the word stays in its cell.
   */
  rowTones?: (StatusTone | null)[];
  /** dumbbell — two magnitudes per row on one shared axis. `names` labels
   *  the two ends for the legend; `log` puts the axis on decades, which is
   *  the only way a click count and an impression count forty times its size
   *  can share one line without the smaller sitting on the origin. */
  dumbbell?: DumbbellRow[];
  names?: [string, string];
  log?: boolean;
  /**
   * profile — one thing's card: a row of figures, its line, a short list.
   * The tiles are `figures`; the line is `series`/`seriesAt`/`unit` as a
   * metric's sparkline is; the list is `rows` as a rows card's is; and
   * `caption` closes it. Workdash's property card on /search is the model —
   * clicks, impressions, CTR and rank, clicks per day, the top queries —
   * and the audit's per-venture card wears the same shape.
   */
  figures?: ProfileFigure[];
  /** runway — deadlines on one axis, with the two lines they are judged by. */
  runway?: RunwayRow[];
  thresholds?: { warn: number; crit: number };
  /**
   * The furthest the axis will go, whatever the rows say. A pair of names
   * bought until 2029 pushes the axis past six hundred days and collapses
   * everything the chart exists to show — the fortnight, the month — onto the
   * origin. Past the cap a row sits at the right edge and says "400+".
   */
  cap?: number;
};

export const SOURCES: Record<string, WidgetSource> = {
  stripe: { name: "Stripe", icon: "stripe", connected: true },
  /*
    NOT CONNECTED, AND THERE IS NO COLLECTOR FOR IT. `connected` here means a
    credential can exist and something reads it — not that the integration was
    planned. A sample presented as a measurement is the one thing this project
    refuses, so this stays false and the earnings cards fall back to their
    samples with no live dot.
  */
  adsense: { name: "Google AdSense", icon: "googleadsense", connected: false },
  appstore: { name: "App Store Connect", icon: "appstore", connected: true },
  play: { name: "Google Play", icon: "googleplay", connected: true },
  /*
    THE TWO STORES AT ONCE, WHICH BELONG TO NEITHER OF THEM.

    "What did the apps make this month" is a question about both stores, and
    answering it from Apple's card while Google holds all of the money would be
    answering a different one. So the cross-store cards sit under a source named
    for what they are — the same move the merged domain portfolio makes under
    "Registrars" and the whole bill makes under "Costs".
  */
  mobile: {
    name: "App stores",
    icon: null,
    mono: "A",
    tint: "#5a6b7d",
    connected: true,
  },
  gsc: {
    name: "Google Search Console",
    icon: "googlesearchconsole",
    connected: true,
  },
  bing: { name: "Bing Webmaster", icon: "microsoftbing", connected: true },
  cf: { name: "Cloudflare", icon: "cloudflare", connected: true },
  uptime: {
    name: "Uptime",
    icon: null,
    mono: "U",
    tint: "#2f7d4f",
    connected: true,
  },
  meta: { name: "Meta", icon: "meta", connected: true },
  instagram: { name: "Instagram", icon: "instagram", connected: true },
  hetzner: { name: "Hetzner Cloud", icon: "hetzner", connected: true },
  dynadot: {
    name: "Dynadot",
    icon: null,
    mono: "D",
    tint: "#3b7bd8",
    connected: true,
  },
  spaceship: { name: "Spaceship", icon: "spaceship", connected: true },
  /*
    THE MERGED PORTFOLIO, which belongs to neither registrar.

    "How many domains do I hold" and "what renews next" are questions about the
    whole portfolio, and answering them from Dynadot's card while Spaceship
    holds two of the names would be answering a different question. So the
    cross-registrar widgets sit under a source named for where they come
    from — the registrars, both of them — rather than being filed under
    whichever one happens to hold the most.
  */
  pexels: { name: "Pexels", icon: "pexels", connected: true },
  pixabay: { name: "Pixabay", icon: "pixabay", connected: false },
  registrars: {
    name: "Registrars",
    icon: null,
    mono: "R",
    tint: "#6e6c65",
    connected: true,
  },
  github: { name: "GitHub", icon: "github", connected: true },
  npm: { name: "npm", icon: "npm", connected: true },
  openai: { name: "OpenAI", icon: "openai", connected: true },
  openrouter: { name: "OpenRouter", icon: "openrouter", connected: true },
  replicate: { name: "Replicate", icon: "replicate", connected: true },
  /*
    THE WHOLE BILL, WHICH BELONGS TO NO ONE VENDOR.

    "What is this operation costing me" spans three USD providers and one that
    charges in euro, and answering it from OpenAI's card would be answering a
    smaller question. So the cross-provider cards sit under a source named for
    what they are — the same move the merged domain portfolio makes under
    "Registrars" — rather than being filed under whichever vendor is dearest
    this month.
  */
  costs: {
    name: "Costs",
    icon: null,
    mono: "$",
    tint: "#4a4842",
    connected: true,
  },
  gmail: { name: "Gmail", icon: "gmail", connected: true },
  resend: { name: "Resend", icon: "resend", connected: true },
  /*
    THE ONE CARD THAT BELONGS TO NEITHER OF THEM.

    "What can these APIs not tell me about my mail" is a question about both
    ends of the pipe at once — Gmail cannot say whether a thread was answered by
    phone, and Resend cannot say whether anybody opened anything — and filing
    that under whichever of the two happens to have more cards would be filing
    it under the wrong one half the time. The same move the merged portfolio
    makes under "Registrars" and the whole bill under "Costs".
  */
  mail: {
    name: "Mail",
    icon: null,
    mono: "@",
    tint: "#5c6b8a",
    connected: true,
  },
  telegram: { name: "Telegram", icon: "telegram", connected: true },
  searxng: { name: "SearXNG", icon: "searxng", connected: true },
  reddit: { name: "Reddit", icon: "reddit", connected: false },
  hn: { name: "Hacker News", icon: "ycombinator", connected: true },
  /*
    WHAT STRANGERS SAID, WHICH BELONGS TO NEITHER SITE.

    "Is anybody asking for this" is a question about both sources at once, and
    answering it from Reddit's card alone would be answering a smaller one. So
    the cards that span them sit under a source named for what they are — the
    move the merged domain portfolio makes under "Registrars" and the whole
    bill makes under "Costs" — rather than being filed under whichever site
    happened to be louder this week.
  */
  demand: {
    name: "Demand",
    icon: null,
    /* A question mark rather than an initial, which is the one place this
       list breaks its own convention: "D" is Dynadot's tile already, and what
       these cards hold is literally the questions strangers asked. */
    mono: "?",
    tint: "#3f6b63",
    connected: true,
  },

  /*
    THE NINE THAT ARRIVED WITH THE SECOND WAVE OF INTEGRATIONS.

    Every one of them takes a MONOGRAM rather than a brand mark, and that is a
    statement about `data/brandIcons.ts` rather than about these services. That
    file inlines path data so a tile can carry a real brand colour without a
    network request; it holds the twenty-six marks the first wave needed and
    nothing else. A slug here that the file has never heard of renders as the
    monogram anyway — so naming one would be a promise the tile cannot keep,
    and the honest thing is to say `null` and pick a letter.

    TWO LETTERS RATHER THAN ONE, in six of the nine, because the initials have
    run out: "U" is already the uptime probe's, "P" would serve PyPI, presence
    and the product endpoints at once, and a board carrying three identical
    grey P tiles is a board you have to read the label of every time. Calendar
    takes "31" for the reason Google's own icon does.
  */
  umami: {
    name: "Umami",
    icon: null,
    mono: "Um",
    tint: "#2f6f6a",
    connected: true,
  },
  calendar: {
    name: "Google Calendar",
    icon: null,
    mono: "31",
    tint: "#4285f4",
    connected: true,
  },
  pypi: {
    name: "PyPI",
    icon: null,
    mono: "py",
    tint: "#3775a9",
    connected: true,
  },
  bluesky: {
    name: "Bluesky",
    icon: null,
    mono: "bs",
    tint: "#0085ff",
    connected: true,
  },
  /*
    THE POSTS, AS A SOURCE OF THEIR OWN.

    Not `meta`, although the Facebook half is read with Meta's token, and the
    reason is what a source NAMES on this board: `meta` is the ad account and
    the Page identities, collected every six hours by the meta collector, and
    its cards quote that clock. These cards quote a different one — the
    timeline reader's — and they carry Bluesky and the publishing queue as
    well, neither of which Meta has ever heard of. One source per clock is the
    rule `collectedAt` in lib/live is built on.

    CONNECTED, because there is nothing to connect: both routes read tables
    this box writes, the way `audit` and `runs` do. An empty answer here means
    no Page has been mapped to a venture yet, which is work rather than a
    missing credential — and the coverage card says so in those words.
  */
  social: {
    name: "Posts",
    icon: null,
    mono: "Po",
    tint: "#7a5cc4",
    connected: true,
  },
  fleet: {
    name: "Fleet",
    icon: null,
    mono: "Fl",
    tint: "#6b5f8a",
    connected: true,
  },
  products: {
    name: "Product endpoints",
    icon: null,
    mono: "Pr",
    tint: "#8a6a3f",
    connected: true,
  },
  backlinks: {
    name: "Backlinks",
    icon: null,
    mono: "Bl",
    tint: "#4a7c8a",
    connected: true,
  },
  presence: {
    name: "Presence",
    icon: null,
    mono: "Ps",
    tint: "#7d5a6b",
    connected: true,
  },

  /*
    THE THREE THIS BOX PRODUCES ITSELF.

    Every source above is somebody else's service, and `connected` on it is a
    real question with a real answer — is there a token, did anybody paste it.
    These three have no service behind them: the audit is a crawler that runs
    here, a run is agent work that executes here, and a competitor profile is
    what a run wrote into this box's own table. There is nothing to connect, so
    `connected` is true for all three and means only "this exists" — the cards
    fall back to samples when the WORK has not been done rather than when a
    credential is missing, and each one says which in its own words.

    Monograms, because `data/brandIcons.ts` has no mark for a thing that is not
    a brand and never will. "Au" rather than "A", which the app stores hold;
    "Rn" rather than "R", which the registrars hold; "Cp" rather than "C",
    which nothing holds yet and which would be the third grey C-tile the day
    something else wanted it.
  */
  audit: {
    name: "Site audit",
    icon: null,
    mono: "Au",
    tint: "#8a4a4a",
    connected: true,
  },
  runs: {
    name: "Agent runs",
    icon: null,
    mono: "Rn",
    tint: "#5a5f8a",
    connected: true,
  },
  competitors: {
    name: "Competitors",
    icon: null,
    mono: "Cp",
    tint: "#6b7d4a",
    connected: true,
  },
  /* THIS BOX'S OWN LLM USE. Not a plugin: the chat and run ledgers are
     written here, so the source is always connected and never asks for a
     credential. Tokens, because no provider reports a per-call price this box
     can read back; the only dollars are the budget ledger's own. */
  llm: {
    name: "LLM usage",
    icon: null,
    mono: "Tk",
    tint: "#7a5c9e",
    connected: true,
  },
  /* THE LEDGER. Not a plugin either: the rows are seeded from Hetzner and the
     registrars and typed in by the owner, and the Finance page is where they
     are edited. Always connected; a card of its showing nothing means the
     ledger has nothing under that heading yet, and the card says so. */
  finance: {
    name: "Finance",
    icon: null,
    mono: "Fi",
    tint: "#5f6b3f",
    connected: true,
  },
  /* ======================================================================
     SEO BOARD PARITY (Workdash /seo + /search) — four sources this box
     computes itself. None is a plugin: authority is arithmetic over rows
     other collectors wrote, the AI answers are what a run recorded, the
     follow-ups are readings this box took, IndexNow is a log of what it
     sent. Always connected; an empty card is work not yet done, and says so.
     ====================================================================== */
  authority: {
    name: "Authority",
    icon: null,
    mono: "At",
    tint: "#4a6b8a",
    connected: true,
  },
  geo: {
    name: "AI visibility",
    icon: null,
    mono: "Ai",
    tint: "#6b4a8a",
    connected: true,
  },
  seoops: {
    name: "SEO follow-ups",
    icon: null,
    mono: "Fu",
    tint: "#8a6b4a",
    connected: true,
  },
  indexing: {
    name: "IndexNow",
    icon: null,
    mono: "Ix",
    tint: "#4a8a6b",
    connected: true,
  },
};

export const WIDGETS: Record<string, Widget> = {
  /*
    STRIPE. Five of these were samples and are now measurements; two of the
    five had to change what they SAY to become one.

    `stripe.churn` was called "Churn rate", which is four different figures
    depending on the denominator nobody named. It is now "Revenue churn · 30d"
    and the card carries the basis, because a rate without its denominator is
    not a measurement.

    `stripe.payouts` said "next payout Friday". Stripe publishes no payout
    schedule, and on this account every payout is pressed by hand, so that
    date could never have been filled from the API. The card keeps its name —
    the balance is real — and says what is actually knowable instead.
  */
  "stripe.mrr": {
    src: "stripe",
    name: "MRR",
    window: "now",
    kind: "metric",
    live: { stripe: true, metric: "stripe.mrr" },
  },
  "stripe.net30": {
    src: "stripe",
    name: "Net revenue",
    window: "selected",
    kind: "metric",
    live: { stripe: true, metric: "stripe.net30" },
  },
  "stripe.subs": {
    src: "stripe",
    name: "Active subscriptions",
    window: "now",
    kind: "metric",
    live: { stripe: true, metric: "stripe.subs" },
  },
  "stripe.churn": {
    src: "stripe",
    name: "Revenue churn",
    window: "selected",
    kind: "metric",
    live: { stripe: true },
    invert: true,
  },
  "stripe.arr": {
    src: "stripe",
    name: "ARR",
    window: "now",
    kind: "metric",
    live: { stripe: true },
  },
  "stripe.churnNotChurn": {
    src: "stripe",
    name: "What is not churn",
    window: "selected",
    kind: "rows",
    live: { stripe: true },
  },
  "stripe.payouts": {
    src: "stripe",
    name: "Payout balance",
    window: "now",
    kind: "metric",
    live: { stripe: true, metric: "stripe.balance" },
  },
  "stripe.gross": {
    src: "stripe",
    name: "Gross charges · daily",
    kind: "chart",
    live: { stripe: true },
    unit: "usd",
  },
  "stripe.fees": {
    src: "stripe",
    name: "What Stripe kept",
    window: "selected",
    kind: "rows",
    live: { stripe: true },
  },
  "stripe.products": {
    src: "stripe",
    name: "MRR by product",
    window: "now",
    kind: "bars",
    live: { stripe: true },
  },
  "stripe.pending": {
    src: "stripe",
    name: "Cancelling, still billing",
    window: "now",
    kind: "metric",
    live: { stripe: true },
  },
  "stripe.declines": {
    src: "stripe",
    name: "Failed payments",
    window: "selected",
    kind: "rows",
    live: { stripe: true },
  },
  "stripe.mix": {
    src: "stripe",
    name: "Subscription mix",
    window: "now",
    kind: "rows",
    live: { stripe: true },
  },
  "stripe.limits": {
    src: "stripe",
    name: "What Stripe will not say",
    kind: "rows",
    live: { stripe: true },
  },
  /*
    ADSENSE. Nothing has ever authorised this, so the two earnings cards below
    keep their samples and wear no live dot — their builders return null in
    every state but `authorised`. The third card is the one that CAN answer
    today: it says which not-authorised state the integration is in and what
    would change it, which is the only honest live thing here.
  */
  "adsense.earnings": {
    src: "adsense",
    name: "Ad earnings",
    window: "selected",
    kind: "metric",
    live: { adsense: true },
  },
  "adsense.rpm": {
    src: "adsense",
    name: "RPM by site",
    kind: "bars",
    live: { adsense: true },
  },
  "adsense.access": {
    src: "adsense",
    name: "AdSense access",
    kind: "rows",
    live: { adsense: true },
  },
  /* ------------------------------------------------------- app store connect
     THE MONEY IS TWO NUMBERS AND THEY ARE NOT ADDED. Apple's daily sales
     report carries its own ESTIMATE of developer proceeds; its monthly finance
     report carries the partner share it actually paid. `appstore.proceeds`
     kept its key — a saved board points at it — and now says which of the two
     it is; `appstore.payout` is the other one, and is the only card here that
     may be read as revenue.

     `appstore.installs` also kept its key and lost the word "installs". Apple
     counts UNITS in its sales report — a first download of the app — and the
     same file counts updates and re-downloads separately. Calling the first
     figure installs and quietly leaving the reader to assume the other two are
     in it is how a funnel gets a wrong number at the top of it.
  */
  "appstore.installs": {
    src: "appstore",
    name: "App Store downloads",
    window: "selected",
    kind: "metric",
    live: { mobile: true, metric: "appstore.downloads" },
  },
  "appstore.daily": {
    src: "appstore",
    name: "Downloads by day",
    kind: "chart",
    live: { mobile: true },
    unit: "count",
  },
  "appstore.proceeds": {
    src: "appstore",
    name: "Estimated proceeds",
    window: "selected",
    kind: "rows",
    live: { mobile: true },
  },
  "appstore.payout": {
    src: "appstore",
    name: "App Store payout",
    kind: "rows",
    live: { mobile: true },
  },
  "appstore.rating": {
    src: "appstore",
    name: "iOS rating",
    window: "now",
    kind: "metric",
    live: { mobile: true },
  },
  "appstore.store": {
    src: "appstore",
    name: "Where each app is",
    kind: "statuses",
    live: { mobile: true },
  },
  "appstore.apps": {
    src: "appstore",
    name: "Apps",
    kind: "table",
    live: { mobile: true },
    headers: ["App", "Where it is", "Downloads", "Updates", "Rating"],
  },
  "appstore.limits": {
    src: "appstore",
    name: "What Apple will not say",
    kind: "rows",
    live: { mobile: true },
  },

  /* ------------------------------------------------------------ google play
     The same split, in Google's vocabulary: `sales/` is what buyers were
     charged in their own currencies, `earnings/` is the merchant amount that
     lands after Google's fee. `play.revenue` is the second one.
  */
  "play.installs": {
    src: "play",
    name: "Android installs",
    window: "selected",
    kind: "metric",
    live: { mobile: true, metric: "play.installs" },
  },
  "play.daily": {
    src: "play",
    name: "Installs by day",
    kind: "chart",
    live: { mobile: true },
    unit: "count",
  },
  "play.revenue": {
    src: "play",
    name: "Play payout",
    kind: "rows",
    live: { mobile: true },
  },
  "play.split": {
    src: "play",
    name: "What Google took",
    kind: "rows",
    live: { mobile: true },
  },
  "play.charged": {
    src: "play",
    name: "Charged to buyers · unsettled",
    kind: "rows",
    live: { mobile: true },
  },
  "play.rating": {
    src: "play",
    name: "Play rating",
    window: "now",
    kind: "metric",
    live: { mobile: true },
  },
  "play.apps": {
    src: "play",
    name: "Packages",
    kind: "table",
    live: { mobile: true },
    headers: ["Package", "Installs", "Active devices", "Rating", "Payout"],
  },
  "play.limits": {
    src: "play",
    name: "What Google will not say",
    kind: "rows",
    live: { mobile: true },
  },

  /* ------------------------------------------------------------- both stores
     THE CARD THE CURRENCY PROBLEM PRODUCED, AGAIN. Apple pays per storefront
     currency and Google's buyers paid in nine of their own; there is no dated
     rate on this box, so the stores sit beside each other with their own units
     and the last row says plainly that no total is offered.
  */
  "mobile.sideBySide": {
    src: "mobile",
    name: "Side by side, not added",
    kind: "rows",
    live: { mobile: true },
  },
  "mobile.presence": {
    src: "mobile",
    name: "On sale",
    kind: "metric",
    live: { mobile: true },
  },
  /*
    SEARCH CONSOLE. Nineteen verified properties, and the two things Google
    will not tell you straight decided what every card here says.

    THE LAST THREE DAYS ARE NOT FINISHED. Search Console finalises a day over
    two to three days, so the collector never reads closer than three days back
    and every card names the day the window actually ends on. "Impressions ·
    28d" was a card that implied a window ending now; the card now says which
    day it ends on, because a three-day reporting lag drawn without one reads
    as a fall in traffic.

    THE QUERY ROWS ARE A SAMPLE OF THE IMPRESSIONS AND NEVER ALL OF THEM.
    Google withholds queries too rare to keep a searcher anonymous and caps how
    many rows it will return, and on these nineteen properties the ranked rows
    carry 19% of the portfolio's impressions — 2% on the busiest one and 77% on
    another. So `gsc.queries` carries that fraction on its face, `gsc.coverage`
    exists to put the two numbers side by side, and no card anywhere sums the
    query column into a total.

    `gsc.position` kept its name and lost its delta. A rank moves in PLACES,
    and the card's own delta renders a percentage — "-25%" over an average
    position is a figure in no unit anybody can act on. The movement is spelled
    out in the subtitle instead, in places, saying which way it went.
  */
  "gsc.impressions": {
    src: "gsc",
    name: "Impressions · Google",
    kind: "metric",
    live: { gsc: true },
  },
  "gsc.clicks": {
    src: "gsc",
    name: "Clicks · Google",
    kind: "metric",
    live: { gsc: true },
  },
  "gsc.position": {
    src: "gsc",
    name: "Average position",
    kind: "metric",
    live: { gsc: true },
    invert: true,
  },
  "gsc.queries": {
    src: "gsc",
    name: "Top queries · Google",
    kind: "rows",
    live: { gsc: true },
  },
  "gsc.pages": {
    src: "gsc",
    name: "Top pages · Google",
    kind: "rows",
    live: { gsc: true },
  },
  /* The whole portfolio as one table, because "which of nineteen properties is
     actually earning" is a question about the set and cannot be read off
     nineteen cards. */
  "gsc.sites": {
    src: "gsc",
    name: "Every property",
    kind: "table",
    live: { gsc: true },
    headers: ["Property", "Impressions", "Clicks", "CTR", "Position", "Δ impressions"],
  },
  "gsc.movers": {
    src: "gsc",
    name: "Biggest movers · 28d",
    kind: "rows",
    live: { gsc: true },
  },
  /* "PORTFOLIO" IS IN THE NAME because the line is every property summed —
     Workdash's "Portfolio impressions per day" — and a reader inside one
     venture's board gets the venture's own sum under that venture's name
     instead; the builder renames it. */
  "gsc.trend": {
    src: "gsc",
    name: "Impressions a day · portfolio",
    kind: "chart",
    live: { gsc: true },
    /* A count, not a percentage: this is a quantity of times a link was shown.
       Clicks are deliberately not a second line — they run about forty times
       smaller, and on a shared axis starting at zero that is a flat line along
       the bottom impersonating a measurement. */
    unit: "count",
  },
  /* Queries already ranking 11th to 20th: visible to Google, one page short of
     the clicks, and usually the cheapest win on the board. */
  "gsc.striking": {
    src: "gsc",
    name: "Striking distance · 11-20",
    kind: "rows",
    live: { gsc: true },
  },
  /* The card that keeps the query cards honest, the way "What is not churn"
     does for the Stripe board: two numbers that look like they should match,
     can never match, and the reason printed between them. */
  "gsc.coverage": {
    src: "gsc",
    name: "What the query rows cover",
    kind: "rows",
    live: { gsc: true },
  },
  /* SUBMITTED, not indexed. The Index Coverage report has no API at all, so
     the number of pages Google is actually holding is not knowable here — the
     card says that rather than letting a submitted count stand in for it. */
  "gsc.sitemaps": {
    src: "gsc",
    name: "Sitemaps",
    kind: "rows",
    live: { gsc: true },
  },
  /*
    BING WEBMASTER. Two catalog samples, and asking the API changed both.

    `bing.keywords` was "Keyword volume" over four invented phrases. The volume
    is real and free — it is the ONE measurement on this whole board that is
    not a rear-view mirror, because it counts people searching a phrase whether
    or not anything of ours ranks for it — but it needs somebody to name the
    phrases, and nothing on this box can guess them. Seeding them from Search
    Console's queries would ask "how much demand is there for the things we
    already rank for", which is the question this endpoint exists NOT to
    answer. So the phrases are a setting on the plugin page, the card names the
    market the impressions were counted in, and with nothing configured it says
    which one step fills it.

    `bing.backlinks` promised "1,847 inbound links · new referring domains: 12"
    and half of that cannot be produced. Bing reports inbound links two ways
    and they disagree completely here: the crawl statistics carry a real count,
    and GetLinkCounts — the only endpoint that could NAME a linking page, and
    therefore the only route to a referring domain — answers HTTP 200 with an
    empty list for every verified site on this account. So the card keeps its
    key, shows the count per site, and says the referring-domain figure is not
    answerable rather than filling it with something adjacent.
  */
  "bing.keywords": {
    src: "bing",
    name: "Search demand · Bing",
    kind: "rows",
    live: { bing: true },
  },
  "bing.backlinks": {
    src: "bing",
    name: "Inbound links · Bing",
    kind: "rows",
    live: { bing: true },
  },
  "bing.impressions": {
    src: "bing",
    name: "Impressions · Bing",
    kind: "metric",
    live: { bing: true },
  },
  "bing.clicks": {
    src: "bing",
    name: "Clicks · Bing",
    kind: "metric",
    live: { bing: true },
  },
  /* Pages Bing is HOLDING, which is a different claim from the sitemap card on
     the Google side: one is what a crawler kept, the other is what we asked a
     crawler to look at. Neither is the other's answer. */
  "bing.index": {
    src: "bing",
    name: "Pages in Bing's index",
    kind: "metric",
    live: { bing: true },
  },
  "bing.crawl": {
    src: "bing",
    name: "Crawl · Bing",
    kind: "rows",
    live: { bing: true },
  },
  /* Bing's own query report — a rear-view mirror like Google's, on a different
     engine. The two lists disagree, which is the interesting part and stops
     being interesting the moment anybody adds them. */
  "bing.queries": {
    src: "bing",
    name: "Top queries · Bing",
    kind: "rows",
    live: { bing: true },
  },
  "bing.sites": {
    src: "bing",
    name: "Verified sites · Bing",
    kind: "table",
    live: { bing: true },
    headers: ["Site", "Impressions", "Clicks", "CTR", "In index", "Inbound links"],
  },
  "bing.trend": {
    src: "bing",
    name: "Impressions a day · Bing",
    kind: "chart",
    live: { bing: true },
    unit: "count",
  },
  /*
    CLOUDFLARE. Two catalog samples became measurements, and both had to change
    what they claim in order to become one.

    "Requests by domain · 24h" is now "Requests by zone · 7d". Cloudflare's free
    analytics is `httpRequests1dGroups` — a DAILY rollup — so there is no
    twenty-four-hour figure to be had that is not either today's half-written
    bucket or yesterday's finished one. Seven complete days is the window that
    exists; captioning it 24h would have been a unit nobody measured.

    "DNS drift" kept its name and changed what it measures, because the thing it
    promised — a stale A record — is not something either side of this can see.
    A record is stale relative to where a service actually lives, and nothing on
    this box knows that. What IS knowable, and is the more serious failure, is
    delegation drift: Cloudflare knows the nameservers it assigned a zone, the
    registrars know where the domain actually points, and neither of them knows
    the other. When those disagree, the records on the card are not the records
    the internet is being served.
  */
  "cf.requests": {
    src: "cf",
    name: "Requests by zone",
    window: "selected",
    kind: "bars",
    live: { cloudflare: true },
  },
  "cf.dns": {
    src: "cf",
    name: "DNS drift",
    window: "now",
    kind: "statuses",
    live: { cloudflare: true },
  },
  "cf.total": {
    src: "cf",
    name: "Requests",
    window: "selected",
    kind: "metric",
    live: { cloudflare: true },
  },
  "cf.daily": {
    src: "cf",
    name: "Requests & page views by day",
    kind: "chart",
    live: { cloudflare: true },
    unit: "count",
  },
  /*
    A SEPARATE CARD FROM THE ONE ABOVE, and not a third line on it. Requests and
    page views are counts of the same thing and add up the same way; visitors do
    not add up at all — Cloudflare de-duplicates them within one zone and one
    day, so any total across zones counts a person who read two of these sites
    twice. Drawn on the same axis as requests it would also be invisible: this
    account serves four hundred thousand requests to eighty thousand visitors.
  */
  "cf.visitors": {
    src: "cf",
    name: "Visitors by day",
    kind: "chart",
    live: { cloudflare: true },
    unit: "count",
  },
  "cf.bandwidth": {
    src: "cf",
    name: "Bandwidth served",
    window: "selected",
    kind: "metric",
    live: { cloudflare: true },
  },
  "cf.threats": {
    src: "cf",
    name: "Threats stopped",
    window: "selected",
    kind: "metric",
    live: { cloudflare: true },
  },
  "cf.zones": {
    src: "cf",
    name: "Zones",
    window: "now",
    kind: "metric",
    live: { cloudflare: true },
  },
  "cf.responses": {
    src: "cf",
    name: "Edge responses",
    window: "selected",
    kind: "bars",
    live: { cloudflare: true },
  },
  "cf.cacheRatio": {
    src: "cf",
    name: "Cached at the edge",
    window: "selected",
    kind: "metric",
    live: { cloudflare: true },
  },
  "cf.email": {
    src: "cf",
    name: "Email hygiene",
    kind: "statuses",
    live: { cloudflare: true },
  },
  "cf.records": {
    src: "cf",
    name: "DNS records",
    kind: "rows",
    live: { cloudflare: true },
  },
  "cf.unmatched": {
    src: "cf",
    name: "Zones and names that do not pair up",
    kind: "rows",
    live: { cloudflare: true },
  },
  "cf.table": {
    src: "cf",
    name: "Zones",
    kind: "table",
    live: { cloudflare: true },
    headers: ["Zone", "Requests", "Cached", "Views", "Records", "Delegation"],
  },
  /*
    THE CARD THAT KEEPS THE OTHERS HONEST — the same shape the costs board
    carries for Replicate and the revenue board for Stripe. The token behind
    this integration is deliberately zone-read-only, so a reader who goes
    looking for a Pages deployment or a WAF figure finds out that it was asked
    for and refused, rather than assuming the collector is broken.
  */
  "cf.cannot": {
    src: "cf",
    name: "What this token will not read",
    kind: "rows",
    live: { cloudflare: true },
  },
  /*
    THE ONE UPTIME CARD THAT PREDATES THE PROBE.

    It shipped as a sample on the Morning check board when nothing was checking
    anything. There is a probe now, so it reads it — same key, same board
    position, same three dots, and the numbers behind them are measurements.
    What it will not do any more is quote "99.97% · 30d": this probe checks
    from one laptop every half hour, so a percentage is only offered once there
    are enough checks to divide by, and the card says the count instead.
  */
  "uptime.status": {
    src: "uptime",
    name: "Uptime",
    kind: "statuses",
    live: { uptime: true },
  },
  /*
    THE META CARDS.

    Four catalog samples described this integration and three of them had to
    change what they claim in order to become measurements. What follows is what
    the token could actually be asked, which is a narrower thing than the
    catalog assumed and a wider one than it drew.

    `meta.reach` PROMISED ORGANIC PAGE REACH AND KEEPS ITS KEY FOR PAID REACH,
    because a saved board points at it and dropping a card is worse than
    renaming one — but the name now says which reach it is. Organic Page reach
    is unavailable twice over: `page_impressions_unique` was retired by Meta in
    November 2025 and answers "not a valid insights metric", and every Page
    metric that still exists needs a Page Access Token this system user's role
    cannot mint (403 #200). The paid figure is real, it is 92,416 people over
    Meta's own thirty-day window, and it is titled for what it is. Both refusals
    are on `meta.cannot`, so a reader looking for the organic number finds the
    two reasons rather than assuming the collector broke.

    `meta.roas` KEPT ITS KEY AND STOPPED BEING A NUMBER. "2.8× · blended, 30d"
    was wrong twice: blended is the one shape a ROAS may never take — it is a
    ratio of two figures that can be in different currencies and on different
    attribution windows — and there is no ROAS on this account to blend.
    `purchase_roas` is asked for on every insights call and is absent from every
    row, because the account buys lead-form submissions and there is no purchase
    for Meta to attach a value to. The card is now what was asked and what came
    back, with the conversion the account DOES buy beside it. It fills itself if
    a purchase campaign ever runs.

    `meta.spend` KEPT ITS NAME AND LOST "4 active campaigns". Fourteen campaigns
    exist and every one of them is paused; five delivered inside the window. The
    subtitle now names the window's own dates and the currency, because Meta's
    `last_30d` ends on the last complete day and a card captioned "30d" over it
    is captioning a window it is not.
  */
  "meta.reach": {
    src: "meta",
    name: "Reached by ads · 30d",
    kind: "metric",
    live: { meta: true },
    /* No sparkline, and its absence is deliberate. The sample carried one, and
       a reach series would have to be a series of rolling thirty-day reaches —
       every point de-duplicated over its own overlapping window, so successive
       points are not comparable and their shape means nothing. Spend and leads
       have sparklines because they are quantities that a window merely bounds;
       reach is not. */
  },
  "meta.spend": {
    src: "meta",
    name: "Ad spend · 30d",
    kind: "metric",
    live: { meta: true, metric: "meta.spend" },
  },
  "meta.leads": {
    src: "meta",
    name: "Leads · 30d",
    kind: "metric",
    live: { meta: true, metric: "meta.leads" },
  },
  "meta.roas": {
    src: "meta",
    name: "Return on ad spend",
    kind: "rows",
    live: { meta: true },
  },
  "meta.daily": {
    src: "meta",
    name: "Daily ad spend",
    kind: "bars",
    live: { meta: true },
  },
  "meta.campaigns": {
    src: "meta",
    name: "Where the ad money went · 30d",
    kind: "table",
    live: { meta: true },
    headers: ["Campaign", "Spend", "Clicks", "Reached", "Status"],
  },
  "meta.pages": {
    src: "meta",
    name: "Facebook Pages",
    kind: "rows",
    live: { meta: true },
  },
  /* The evidence card, the same one the costs board carries for Replicate and
     the traffic board for Cloudflare. It matters more here, because two of its
     lines are the reason a card a reader expects to find is not on the board. */
  "meta.cannot": {
    src: "meta",
    name: "What this token will not read",
    kind: "rows",
    live: { meta: true },
  },
  /*
    INSTAGRAM KEPT ITS KEY AND STOPPED BEING A FOLLOWER COUNT.

    The catalog claimed 9,412 followers on a card that rides on the Meta token.
    The token is fine — it is a live system user token that lists three Pages by
    name — and NOT ONE OF THOSE PAGES HAS AN INSTAGRAM BUSINESS ACCOUNT LINKED.
    That is a third state, and it is neither of the two a metric card can draw:
    "0" would be a measurement of an audience nobody measured, and an error
    would send somebody to re-paste a credential that works.

    So it is three status lines that say which state this is and what one step
    changes it, the same move the AdSense access card makes. It becomes a
    follower count on its own the day an account is linked — the builder reads
    the Pages, and finding one is what switches it.
  */
  "instagram.followers": {
    src: "instagram",
    name: "Instagram accounts",
    kind: "statuses",
    live: { meta: true },
  },
  "hetzner.servers": {
    src: "hetzner",
    name: "Servers",
    kind: "statuses",
    live: { summary: true },
  },
  "hetzner.spend": {
    src: "hetzner",
    name: "Infra spend · month",
    kind: "metric",
    live: { metric: "hetzner.spend" },
    invert: true,
  },
  "hetzner.spendSplit": {
    src: "hetzner",
    name: "Where the spend goes",
    kind: "donut",
    live: { summary: true },
  },
  "hetzner.avgCost": {
    src: "hetzner",
    name: "Average per server",
    kind: "metric",
    live: { summary: true },
  },
  "hetzner.ipv4": {
    src: "hetzner",
    name: "Primary IPv4",
    kind: "metric",
    live: { fleet: true },
  },
  "hetzner.serverCount": {
    src: "hetzner",
    name: "Servers",
    kind: "metric",
    live: { metric: "hetzner.servers", summary: true },
  },
  "hetzner.fleet": {
    src: "hetzner",
    name: "Fleet by cost",
    kind: "rows",
    live: { fleet: true },
  },
  "hetzner.specs": {
    src: "hetzner",
    name: "Fleet specs",
    kind: "rows",
    live: { fleet: true },
  },
  "hetzner.age": {
    src: "hetzner",
    name: "Longest running",
    kind: "rows",
    live: { fleet: true },
  },
  "hetzner.byLocation": {
    src: "hetzner",
    name: "Servers by location",
    kind: "bars",
    live: { summary: true },
  },
  "hetzner.byPlan": {
    src: "hetzner",
    name: "Spend by plan",
    kind: "bars",
    live: { fleet: true },
  },
  "hetzner.arch": {
    src: "hetzner",
    name: "Architecture and regions",
    kind: "statuses",
    live: { fleet: true },
  },

  /* ------------------------------------------------------------------ load
     What the boxes are DOING, as opposed to what they are and what they cost.
     Every one of these is measured by Hetzner's hypervisor, so the fleet has
     CPU, network and disk throughput and has no memory or filesystem meter —
     those live inside the guest. Nothing below invents one.
  */

  "hetzner.fleetCpu": {
    src: "hetzner",
    name: "Fleet CPU",
    kind: "metric",
    live: { load: true },
  },
  "hetzner.busiest": {
    src: "hetzner",
    name: "Busiest box",
    kind: "metric",
    live: { load: true },
  },
  "hetzner.load": {
    src: "hetzner",
    name: "Fleet load",
    kind: "chart",
    live: { load: true },
    unit: "percent",
  },
  "hetzner.cpuMeters": {
    src: "hetzner",
    name: "CPU by box",
    kind: "meters",
    live: { load: true },
  },
  "hetzner.figures": {
    src: "hetzner",
    name: "Every box, in figures",
    kind: "table",
    live: { load: true },
    headers: ["Box", "CPU now", "Mean", "Peak", "Out/s", "€/mo"],
  },
  "hetzner.traffic": {
    src: "hetzner",
    name: "Fleet network",
    kind: "chart",
    live: { load: true },
    unit: "bytes",
  },
  "hetzner.diskWrite": {
    src: "hetzner",
    name: "Disk writes",
    kind: "chart",
    live: { load: true },
    unit: "bytes",
  },
  "hetzner.netNow": {
    src: "hetzner",
    name: "Traffic out",
    kind: "metric",
    live: { load: true },
  },
  "hetzner.quiet": {
    src: "hetzner",
    name: "Doing nothing much",
    kind: "rows",
    live: { load: true },
  },
  "hetzner.volumes": {
    src: "hetzner",
    name: "Volumes",
    kind: "rows",
    live: { volumes: true },
  },

  "dynadot.domains": {
    src: "dynadot",
    name: "Dynadot domains",
    kind: "metric",
    live: { domains: true, metric: "dynadot.domains" },
  },
  "dynadot.renewals": {
    src: "dynadot",
    name: "Renewals due",
    kind: "rows",
    live: { domains: true },
  },

  /* -------------------------------------------------------------- domains
     The portfolio, merged across both registrars. Every one of these reads
     the same single fetch — and every countdown in them is computed against
     today at read time, never stored, because a renewal figure that has gone
     stale is worse than no renewal figure at all.
  */

  "registrars.total": {
    src: "registrars",
    name: "Domains held",
    kind: "metric",
    live: { domains: true },
  },
  "registrars.lapsed": {
    src: "registrars",
    name: "Past their date",
    kind: "metric",
    live: { domains: true },
  },
  "registrars.expiring": {
    src: "registrars",
    name: "Renewing within 30 days",
    kind: "metric",
    live: { domains: true },
  },
  "registrars.autoRenewOff": {
    src: "registrars",
    name: "Auto-renew off",
    kind: "metric",
    live: { domains: true },
  },
  "registrars.runway": {
    src: "registrars",
    name: "Renewal horizon",
    kind: "runway",
    live: { domains: true },
    thresholds: { warn: 30, crit: 7 },
    cap: 400,
  },
  "registrars.attention": {
    src: "registrars",
    name: "Worth a look",
    kind: "rows",
    live: { domains: true },
  },
  "registrars.table": {
    src: "registrars",
    name: "Every domain",
    kind: "table",
    live: { domains: true },
    headers: ["Domain", "Registrar", "Expires", "In", "Renew", "Lock"],
  },
  "registrars.byRegistrar": {
    src: "registrars",
    name: "Where they live",
    kind: "rows",
    live: { domains: true },
  },
  "registrars.byTld": {
    src: "registrars",
    name: "By extension",
    kind: "bars",
    live: { domains: true },
  },
  "registrars.security": {
    src: "registrars",
    name: "Transfer lock and privacy",
    kind: "statuses",
    live: { domains: true },
  },
  "registrars.nameservers": {
    src: "registrars",
    name: "Where the names point",
    kind: "rows",
    live: { domains: true },
  },
  "registrars.newest": {
    src: "registrars",
    name: "Most recently registered",
    kind: "rows",
    live: { domains: true },
  },
  "spaceship.domains": {
    src: "spaceship",
    name: "Spaceship domains",
    kind: "metric",
    live: { domains: true, metric: "spaceship.domains" },
  },

  /*
    GITHUB — AND WHAT WENT, AND WHY.

    Three cards here were samples describing measurements this integration
    cannot make, and a sample that cannot ever become live is a promise the
    catalog has no way to keep:

    * "Commits · 14d" was a bar per day. Commit counts need a call per repo
      against an endpoint that answers 202 while it computes, and the account
      listing carries no such figure at all. What the API DOES say about
      commits is when the last one landed, so the card kept its slot and became
      "Last push" — a real answer to the neighbouring question. The key is
      unchanged because a dashboard somebody already built references it, and
      silently removing a card from a saved board is worse than renaming one.

    * "Open PRs" needed a search call and a different rate limit. GitHub's repo
      listing carries `open_issues_count`, WHICH COUNTS PULL REQUESTS TOO and
      cannot be split without a call per repo — so the card says "issues & PRs"
      and means it, rather than labelling a mixed number as one of its halves.

    * "Actions minutes" is gone outright. The billing endpoints
      (/users/{login}/settings/billing/actions and .../usage) both answer 404
      for this account and token, and there is no other route to the figure.
      A card that can never be filled is worse than no card.

    Everything below is measured: stars and forks from the repo listing,
    traffic from the four per-repo endpoints a token buys, and the API budget
    from the response headers themselves.
  */
  "github.stars": {
    src: "github",
    name: "Stars",
    kind: "metric",
    live: { github: true, metric: "github.stars" },
  },
  "github.views": {
    src: "github",
    name: "Repo views · 14d",
    kind: "metric",
    live: { github: true },
  },
  "github.traffic": {
    src: "github",
    name: "Traffic",
    kind: "chart",
    live: { github: true },
  },
  "github.clones": {
    src: "github",
    name: "Clones · 14d",
    kind: "metric",
    live: { github: true },
  },
  "github.referrers": {
    src: "github",
    name: "Where views come from",
    kind: "rows",
    live: { github: true },
  },
  "github.paths": {
    src: "github",
    name: "Most-read pages",
    kind: "rows",
    live: { github: true },
  },
  "github.top": {
    src: "github",
    name: "Most-viewed repos",
    kind: "rows",
    live: { github: true },
  },
  "github.repos": {
    src: "github",
    name: "Repos by traffic",
    kind: "table",
    live: { github: true },
    headers: ["Repo", "Stars", "Views", "Uniques", "Clones", "Pushed"],
  },
  "github.languages": {
    src: "github",
    name: "Languages",
    kind: "bars",
    live: { github: true },
  },
  /* Was "Commits · 14d" — see the note above. The key is kept because a saved
     board points at it; the name is what the API can actually answer. */

  /* --------------------------------------------------------- stock media
     Pexels and Pixabay are CONSUMPTION APIs, not measurement ones — the video
     workers call them to search for b-roll, and neither keeps a usage history
     or charges anything. The monthly request allowance is the whole of what
     they report about themselves, so it is the whole of what is drawn. There
     is deliberately no "clips used" card: nothing on this box knows.
  */

  "pexels.quota": {
    src: "pexels",
    name: "Pexels allowance left",
    kind: "metric",
    live: { stock: true },
  },
  "pexels.burn": {
    src: "pexels",
    name: "Requests a day",
    kind: "metric",
    live: { stock: true },
  },
  "pexels.meter": {
    src: "pexels",
    name: "Allowance used",
    kind: "meters",
    live: { stock: true },
  },
  "pexels.remaining": {
    src: "pexels",
    name: "Allowance over time",
    kind: "chart",
    live: { stock: true },
    unit: "count",
  },
  "pexels.limits": {
    src: "pexels",
    name: "What the libraries report",
    kind: "rows",
    live: { stock: true },
  },
  "pixabay.quota": {
    src: "pixabay",
    name: "Pixabay allowance left",
    kind: "metric",
    live: { stock: true },
  },

  "github.commits": {
    src: "github",
    name: "Last push, by repo",
    kind: "rows",
    live: { github: true },
  },
  /* Was "Open PRs". GitHub's own count conflates the two and the label says so. */
  "github.prs": {
    src: "github",
    name: "Open issues & PRs",
    kind: "rows",
    live: { github: true },
  },
  "github.rate": {
    src: "github",
    name: "API budget",
    kind: "statuses",
    live: { github: true },
  },
  "github.followers": {
    src: "github",
    name: "Followers",
    kind: "metric",
    live: { github: true, metric: "github.followers" },
  },

  /*
    NPM — DOWNLOADS, AND THE WORD IS THE POINT.

    npm counts HTTP tarball fetches. A CI job installing on every push, a
    Docker layer rebuild, a mirror warming its cache and a person typing
    `npm i -g` are one download each and npm cannot tell them apart. The
    catalog's old card said "npm downloads · 7d" over a rolling seven days;
    these say which ISO week they mean, because the funnel's other stages are
    bucketed Monday to Sunday and two stages on two week definitions is a chart
    that lies quietly.
  */
  "npm.downloads": {
    src: "npm",
    name: "npm downloads · last full week",
    kind: "metric",
    live: { npm: true },
  },
  "npm.last30": {
    src: "npm",
    name: "npm downloads",
    window: "selected",
    kind: "metric",
    live: { npm: true },
  },
  "npm.weeks": {
    src: "npm",
    name: "Downloads by week",
    kind: "chart",
    live: { npm: true },
  },
  "npm.packages": {
    src: "npm",
    name: "By package",
    kind: "rows",
    live: { npm: true },
  },
  "npm.table": {
    src: "npm",
    name: "Packages",
    kind: "table",
    live: { npm: true },
    headers: ["Package", "Last full week", "30d", "Held", "State"],
  },
  /* ------------------------------------------------------------- openai
     The Costs API, grouped by project. Both cuts below sum over the SAME rows,
     so the day total and the project total agree to the cent.

     THERE IS DELIBERATELY NO `openai.models` CARD. The Costs API groups by
     project or by line item and never both, and the line-item cut is a billing
     taxonomy ("GPT-4o input tokens") rather than a model list — so a card
     called "Spend by model" could only ever be filled with a guess.
     `openai.projects` is the split that exists.
  */
  "openai.cost": {
    src: "openai",
    name: "OpenAI spend",
    window: "selected",
    kind: "metric",
    live: { costs: true, metric: "openai.spend" },
    invert: true,
  },
  "openai.daily": {
    src: "openai",
    name: "Spend by day",
    window: "selected",
    kind: "chart",
    live: { costs: true },
    unit: "usd",
  },
  "openai.projects": {
    src: "openai",
    name: "Spend by project",
    kind: "rows",
    live: { costs: true },
  },

  /* --------------------------------------------------------- openrouter
     TWO CUTS THAT DO NOT JOIN, kept on separate cards for the whole length of
     this list: `openrouter.models` is per day per model, `openrouter.keys` is
     per key and lifetime, and there is no per-day-per-key figure anywhere in
     the API to put on a third card between them.
  */
  "openrouter.credits": {
    src: "openrouter",
    name: "OpenRouter credits",
    window: "now",
    kind: "metric",
    live: { costs: true, metric: "openrouter.balance" },
  },
  "openrouter.spend": {
    src: "openrouter",
    name: "OpenRouter spend",
    window: "selected",
    kind: "metric",
    live: { costs: true, metric: "openrouter.spend" },
    invert: true,
  },
  "openrouter.models": {
    src: "openrouter",
    name: "Spend by model",
    window: "selected",
    kind: "ranked",
    live: { costs: true },
  },
  "openrouter.keys": {
    src: "openrouter",
    name: "Spend by key · lifetime",
    kind: "rows",
    live: { costs: true },
  },
  /*
    THE LLM USAGE BOARD'S CARDS, shaped after the page they replace: balance
    and runway, the window's spend and tokens, spend and tokens per day, the
    model table with an observed rate, and the key table with its four
    rolling buckets. Every figure is what OpenRouter reported; the only
    arithmetic is division, and where a divisor is zero the card says so.
  */
  "openrouter.runway": {
    src: "openrouter",
    name: "Runway",
    kind: "metric",
    live: { costs: true },
  },
  "openrouter.tokens": {
    src: "openrouter",
    name: "Tokens",
    window: "selected",
    kind: "metric",
    live: { costs: true },
  },
  "openrouter.daily": {
    src: "openrouter",
    name: "Spend per day",
    kind: "chart",
    live: { costs: true },
    unit: "usd",
  },
  "openrouter.tokensDaily": {
    src: "openrouter",
    name: "Tokens per day",
    kind: "chart",
    live: { costs: true },
    unit: "count",
  },
  "openrouter.modelTable": {
    src: "openrouter",
    name: "Every model",
    window: "selected",
    kind: "table",
    live: { costs: true },
    headers: ["Model", "Spend", "Share", "Requests", "Tokens", "$/M"],
  },
  "openrouter.keyTable": {
    src: "openrouter",
    name: "Every key",
    kind: "table",
    live: { costs: true },
    headers: ["Key", "Lifetime", "This month", "7d", "Today", "Cap"],
  },
  "openrouter.totals": {
    src: "openrouter",
    name: "Three totals, three meanings",
    kind: "rows",
    live: { costs: true },
  },
  "openrouter.free": {
    src: "openrouter",
    name: "Routed for nothing",
    kind: "rows",
    live: { costs: true },
  },

  /* ---------------------------------------------------------- replicate
     THERE IS DELIBERATELY NO `replicate.gpu` CARD — "GPU seconds · 7d, ≈ $19
     at current rates" fails on both counts. Replicate does not report GPU
     seconds (it reports predict time, which is not the same thing and is not
     the billing unit for the per-output models this account runs), and it
     publishes no rates at all, so any "≈ $19" is invented. What is drawn
     instead is compute time in its own unit, and a card that says plainly what
     was asked about money and what came back.
  */
  "replicate.runs": {
    src: "replicate",
    name: "Predictions",
    window: "selected",
    kind: "metric",
    live: { costs: true, metric: "replicate.predictions" },
  },
  "replicate.compute": {
    src: "replicate",
    name: "Compute time",
    window: "selected",
    kind: "metric",
    live: { costs: true, metric: "replicate.compute" },
  },
  "replicate.models": {
    src: "replicate",
    name: "Compute by model",
    kind: "ranked",
    live: { costs: true },
  },
  "replicate.outputs": {
    src: "replicate",
    name: "What came out",
    kind: "rows",
    live: { costs: true },
  },
  "replicate.health": {
    src: "replicate",
    name: "Succeeded and failed",
    kind: "statuses",
    live: { costs: true },
  },
  "replicate.noCost": {
    src: "replicate",
    name: "What Replicate will not say",
    kind: "rows",
    live: { costs: true },
  },

  /* --------------------------------------------------------------- costs
     THE CARDS THAT BELONG TO NO ONE PROVIDER. "What is this whole operation
     costing me" is a question about all of them at once, and the answer is two
     currencies wide — so it is filed under a source of its own rather than
     under whichever vendor happens to charge the most.
  */
  "costs.llm": {
    src: "costs",
    name: "LLM spend",
    window: "selected",
    kind: "metric",
    live: { costs: true },
    invert: true,
  },
  "costs.sideBySide": {
    src: "costs",
    name: "Side by side, not added",
    kind: "rows",
    live: { costs: true, summary: true },
  },
  "costs.byProvider": {
    src: "costs",
    name: "Where the dollars go",
    kind: "donut",
    live: { costs: true },
  },
  "costs.limits": {
    src: "costs",
    name: "What these APIs will not say",
    kind: "rows",
    live: { costs: true, summary: true },
  },
  /* ---------------------------------------------------------------- llm
     THIS BOX'S OWN USE, which no provider's bill can be cut into: what the
     chief of staff and the sub-agents spent, by day, by model, by the kind of
     work and by venture. Tokens the backend reported; a turn that reported
     nothing is counted as a turn and named as unreported rather than drawn as
     free. The budget meters are the one place dollars appear, and only when
     the owner has set a price under Usage limits.
  */
  "llm.today": {
    src: "llm",
    name: "Tokens today",
    kind: "metric",
    live: { llm: true },
  },
  "llm.window": {
    src: "llm",
    name: "Tokens",
    window: "selected",
    kind: "metric",
    live: { llm: true },
  },
  "llm.daily": {
    src: "llm",
    name: "Tokens per day · chat and runs",
    kind: "chart",
    live: { llm: true },
    unit: "count",
  },
  "llm.byModel": {
    src: "llm",
    name: "Tokens by model",
    window: "selected",
    kind: "bars",
    live: { llm: true },
  },
  "llm.byWork": {
    src: "llm",
    name: "Tokens by kind of work",
    window: "selected",
    kind: "rows",
    live: { llm: true },
  },
  "llm.byVenture": {
    src: "llm",
    name: "Tokens by venture",
    window: "selected",
    kind: "rows",
    live: { llm: true },
  },
  "llm.budget": {
    src: "llm",
    name: "Today against the limits",
    kind: "meters",
    live: { llm: true },
  },
  "llm.ledger": {
    src: "llm",
    name: "The budget ledger · today",
    kind: "rows",
    live: { llm: true },
  },

  /*
    THE MAIL CARDS. Two sources reading ONE document (`/api/mail`), which is the
    App-stores shape rather than the Google/Bing one — and it passes the same
    test from the other side. Two search engines needed splitting because one
    field holding both was one field away from a card that added them; nothing
    here is that shape, because an inbox thread waiting on a reply and a
    transactional password reset are not the same KIND of thing and no card
    below crosses them.

    NOT ONE FIGURE ON ANY OF THESE CARDS IS A SUBJECT, A BODY OR A PERSON'S
    NAME, and that is a property of the server rather than a restraint here:
    the tables behind this document cannot hold one. The only addresses that
    reach the client are the owner's own mailbox and the from-addresses of
    domains the owner sends from.
  */
  "gmail.unread": {
    src: "gmail",
    name: "Inbox needing a reply",
    window: "now",
    kind: "metric",
    live: { mail: true, metric: "gmail.needingReply" },
    invert: true,
  },
  /*
    THE UNREAD COUNT IS ITS OWN CARD AND IS NOT THE ONE ABOVE. "Waiting on a
    reply" is a queue of work — somebody wrote last and you have not answered —
    and "unread" is mail nobody has opened, most of which on this mailbox is a
    promotion. They differ by two orders of magnitude here, and a board carrying
    one under the other's name would be describing a crisis that is a mailing
    list.
  */
  "gmail.inbox": {
    src: "gmail",
    name: "Unread in the inbox",
    window: "now",
    kind: "metric",
    live: { mail: true, metric: "gmail.unread" },
  },
  /*
    "New contacts · 30d — first-time senders" was a measurement nothing here can
    make, and it is worth saying why rather than dressing it up. "First-time"
    is a claim about every sender the mailbox has EVER had, which needs the
    97,472 messages behind it read and kept; and counting senders at all makes a
    mailing-list census out of an inbox where 24,901 of 83,299 messages are
    promotions — the exact failure collect_contacts.py refuses with its two-way
    test.

    The card keeps its key, because a saved board points at it, and answers the
    neighbouring question honestly: who you WROTE to. Sent mail gets the
    subscription filter for free — nobody was ever subscribed to a newsletter by
    writing to it — and it is 141 messages over ninety days rather than
    thousands. "New" survives, against a stated lookback: first written to
    inside the window, judged against every day of sent mail on hand.
  */
  "gmail.contacts": {
    src: "gmail",
    name: "People you wrote to",
    window: "selected",
    kind: "metric",
    live: { mail: true },
  },
  /*
    RECEIVED ONLY, ON ITS OWN AXIS. Sent mail runs about twenty times smaller on
    this mailbox — 41 a day arriving against 2 written — and on a shared axis
    starting at zero that is a flat line along the bottom impersonating a
    measurement. It is the same call `gsc.trend` makes about clicks against
    impressions, and the sent figure has its own card rather than a second line
    nobody could read.
  */
  "gmail.volume": {
    src: "gmail",
    name: "Mail arriving, by day",
    kind: "chart",
    live: { mail: true },
    unit: "count",
  },
  "gmail.labels": {
    src: "gmail",
    name: "Where the queue is",
    kind: "table",
    live: { mail: true },
    headers: ["Label", "Threads", "Unread", "Waiting", "Oldest"],
  },
  /*
    THE CARD THAT SAYS WHAT THE CREDENTIAL CAN DO AND WHAT THE CODE DOES.
    The token in the vault carries gmail.modify — archive, label, trash — and a
    dashboard holding it owes the reader that sentence, together with the reason
    it does not matter: the provider has one HTTP entry point, it hard-codes GET
    and takes no body. The same shape as Cloudflare's "What this token will not
    read", pointed the other way: this one is about power that is held and never
    used.
  */
  "gmail.mailbox": {
    src: "gmail",
    name: "The mailbox, and the token",
    kind: "rows",
    live: { mail: true },
  },
  /*
    RESEND'S TWO CATALOG CARDS BOTH SURVIVED, WHICH WAS NOT A GIVEN. Both depend
    on a list endpoint existing, and a plausible reading of Resend's API was
    that only individual emails could be fetched by id — in which case there
    would be no volume figure at all and both would have had to become cards
    saying so. `GET /emails` exists, pages with a cursor, and carries
    `last_event`, so delivered and bounced are countable from real rows.

    The window changed and the name says so: the catalog read "7d", the route
    answers over its own thirty, and a card captioned for a window it is not is
    the quietest way to be wrong.
  */
  "resend.sends": {
    src: "resend",
    name: "Emails sent",
    window: "selected",
    kind: "metric",
    live: { mail: true },
  },
  "resend.daily": {
    src: "resend",
    name: "Sends by day",
    kind: "chart",
    live: { mail: true },
    unit: "count",
  },
  "resend.domains": {
    src: "resend",
    name: "Sending domains",
    kind: "statuses",
    live: { mail: true },
  },
  /*
    THE DNS CARD EXISTS BECAUSE THE LISTING CANNOT SHOW IT. `GET /domains` says
    a domain is "verified"; only `GET /domains/{id}` carries the records, each
    with its OWN status. A domain reading verified while one of its three
    records has gone pending is a domain about to stop sending, and this is the
    only place on the board where that is visible.
  */
  "resend.dns": {
    src: "resend",
    name: "DNS behind the sending",
    kind: "rows",
    live: { mail: true },
  },
  /*
    WHAT ACTUALLY HAPPENED TO THE MAIL, with `suppressed` on its own line rather
    than inside a failure rate. A suppression is Resend declining to send at all
    — the address was already on its own list — so it never reached a mail
    server, and folding it into the bounce denominator would make a domain's
    bounce rate FALL every time Resend refused to try.
  */
  "resend.outcomes": {
    src: "resend",
    name: "What became of the mail",
    window: "selected",
    kind: "rows",
    live: { mail: true },
  },
  "mail.cannot": {
    src: "mail",
    name: "What the mail APIs will not say",
    kind: "rows",
    live: { mail: true },
  },
  "resend.bounce": {
    src: "resend",
    name: "Bounce rate",
    kind: "metric",
    live: { mail: true },
    invert: true,
  },
  "telegram.alerts": {
    src: "telegram",
    name: "Alerts · 24h",
    kind: "rows",
  },
  /*
    THE THREE DEMAND SOURCES, AND THE ONE CATALOG CARD THAT COULD NEVER HAVE
    BEEN FILLED.

    `searxng.queries` was "Agent searches · 24h · 186", and no such number
    exists anywhere. Probed on 2026-09-04: the node's /stats page is HTML only
    (the format parameter is ignored), it counts ENGINES rather than queries,
    and a search response carries no total either — and this box is not the
    only thing that searches through the node, so counting our own calls would
    answer a smaller question under a bigger name. The card KEEPS ITS KEY,
    because a saved board points at it, and stops being a metric: it is now
    the node's own health, which is the thing that was actually worth watching
    all along.

    `reddit.signals` and `hn.mentions` kept their keys and their shape and are
    simply live — the samples described exactly what these APIs can produce.
  */
  "searxng.queries": {
    src: "searxng",
    name: "Search node",
    kind: "statuses",
    live: { demand: true },
  },
  "searxng.engines": {
    src: "searxng",
    name: "Engines behind the node",
    kind: "rows",
    live: { demand: true },
  },
  "searxng.latency": {
    src: "searxng",
    name: "Search response time",
    kind: "metric",
    live: { demand: true, metric: "searxng.latency" },
    invert: true,
  },
  "reddit.signals": {
    src: "reddit",
    name: "Demand signals",
    kind: "rows",
    live: { demand: true },
  },
  "reddit.tier": {
    src: "reddit",
    name: "How Reddit was read",
    kind: "statuses",
    live: { demand: true },
  },
  "reddit.subs": {
    src: "reddit",
    name: "Where the threads are",
    kind: "bars",
    live: { demand: true },
  },
  "hn.mentions": {
    src: "hn",
    name: "Mentions",
    window: "selected",
    kind: "rows",
    live: { demand: true },
  },
  "hn.stories": {
    src: "hn",
    name: "Hacker News threads",
    kind: "table",
    live: { demand: true },
    headers: ["Thread", "Points", "Replies", "Age"],
  },
  "demand.new": {
    src: "demand",
    name: "New to this board",
    kind: "metric",
    live: { demand: true },
  },
  "demand.coverage": {
    src: "demand",
    name: "Every phrase, and what answered",
    kind: "table",
    live: { demand: true },
    headers: ["Phrase", "Reddit", "Hacker News"],
  },

  /* ------------------------------------------------------------------ umami
     Self-hosted analytics: the websites, their last thirty COMPLETE days, and
     the rankings underneath. Two rules run through every card below and both
     come from the route's own header.

     THERE IS NO PORTFOLIO VISITOR COUNT and there cannot be one. Umami
     de-duplicates visitors per website, so a person who read the blog and then
     the docs is one visitor on each and one person in the world; no endpoint
     joins identity across sites. `umami.visitors` therefore quotes a figure
     only when a single site is configured — the case where the portfolio IS
     that site — and otherwise says what it will not add.

     THE RANKINGS ARE RANKINGS. Top pages, referrers and events are the top
     twenty of a list Umami truncated, so they sum to less than the window's
     pageviews by an amount nobody can measure. No card below totals them.
  */
  "umami.pageviews": {
    src: "umami",
    name: "Pageviews",
    window: "selected",
    kind: "metric",
    live: { umami: true },
  },
  "umami.visitors": {
    src: "umami",
    name: "Visitors · 30d",
    kind: "metric",
    live: { umami: true },
  },
  "umami.bounce": {
    src: "umami",
    name: "Bounce rate · 30d",
    kind: "metric",
    live: { umami: true },
    invert: true,
  },
  "umami.avgVisit": {
    src: "umami",
    name: "Average visit",
    kind: "metric",
    live: { umami: true },
  },
  "umami.daily": {
    src: "umami",
    name: "Pageviews and visits",
    kind: "chart",
    live: { umami: true },
    unit: "count",
  },
  "umami.sites": {
    src: "umami",
    name: "Every website",
    kind: "table",
    live: { umami: true },
    headers: ["Site", "Pageviews", "Visitors", "Visits", "Bounce", "Avg visit"],
  },
  "umami.pages": {
    src: "umami",
    name: "Top pages",
    kind: "rows",
    live: { umami: true },
  },
  "umami.referrers": {
    src: "umami",
    name: "Top referrers",
    kind: "rows",
    live: { umami: true },
  },
  "umami.events": {
    src: "umami",
    name: "Top events",
    kind: "rows",
    live: { umami: true },
  },

  /* --------------------------------------------------------------- calendar
     The only source on this dashboard with no site on any row, which is why
     none of these cards is ever narrowed to a venture: a Tuesday morning
     belongs to the owner, not to a domain, and slicing it by host would need
     an attribution nobody has written down.

     BUSY HOURS MERGE RATHER THAN ADD. Two calls booked over the same hour are
     one busy hour, and an all-day event contributes none at all — "Conference"
     across three days is not twenty-four hours and not eight, so all-day
     entries are counted apart and never converted into time.
  */
  "calendar.today": {
    src: "calendar",
    name: "Today",
    kind: "rows",
    live: { calendar: true },
  },
  "calendar.busy": {
    src: "calendar",
    name: "Busy hours",
    kind: "bars",
    live: { calendar: true },
  },
  "calendar.next": {
    src: "calendar",
    name: "Next 7 days",
    kind: "rows",
    live: { calendar: true },
  },

  /* ------------------------------------------------------------------- pypi
     Downloads, never installs: these are CDN file requests, so a CI run, a
     container build and a person are one each. Mirrors are excluded on every
     request, which makes these figures SMALLER than pypistats' own default
     view — a mirror warming its cache is not demand.

     WEEKS ARE ISO WEEKS AND A PARTIAL ONE IS NEVER DRAWN beside a complete
     one; three days of a week next to seven-day weeks is a collapse that did
     not happen. The npm cards next door follow the same rule for the same
     reason, and the two are never added: a tarball fetch and a wheel fetch are
     different packages for different runtimes.
  */
  "pypi.downloads": {
    src: "pypi",
    name: "Downloads · last full week",
    kind: "metric",
    live: { pypi: true },
  },
  "pypi.last30": {
    src: "pypi",
    name: "Downloads",
    window: "selected",
    kind: "metric",
    live: { pypi: true },
  },
  "pypi.weekly": {
    src: "pypi",
    name: "Downloads by week",
    kind: "chart",
    live: { pypi: true },
    unit: "count",
  },
  "pypi.packages": {
    src: "pypi",
    name: "Every package",
    kind: "table",
    live: { pypi: true },
    headers: ["Package", "Last full week", "30d", "Version", "State"],
  },

  /* ---------------------------------------------------------------- bluesky
     THE FOLLOWER COUNT IS PER HANDLE AND IS NEVER ADDED. One person following
     two of these accounts is one person, and the public AppView offers no way
     to de-duplicate them — so `bluesky.followers` quotes a number when a
     single handle is configured, and says what it will not add when there are
     more.

     THE ENGAGEMENT FIGURES ARE WHAT THE POSTS CARRY NOW, not what they earned
     inside the window: an old post gathering new likes moves them. And a
     window computed from one page of the author feed is a FLOOR when it filled
     that page — the cards say "at least" rather than quoting it as a count.
  */
  "bluesky.followers": {
    src: "bluesky",
    name: "Followers",
    kind: "metric",
    live: { bluesky: true },
  },
  "bluesky.engagement": {
    src: "bluesky",
    name: "Engagement · 30d",
    kind: "rows",
    live: { bluesky: true },
  },
  "bluesky.handles": {
    src: "bluesky",
    name: "Every handle",
    kind: "table",
    live: { bluesky: true },
    headers: ["Handle", "Followers", "Posts 30d", "Likes", "Per post", "Growth"],
  },

  /* ----------------------------------------------------------------- uptime
     WHAT THESE CARDS MEASURE IS NARROWER THAN THE WORD SUGGESTS. Availability
     here is the share of THIS BOX'S checks that succeeded, from one machine on
     one connection, roughly every half hour — so an outage shorter than the
     gap between checks is invisible to every card below, and a laptop asleep
     overnight is eight hours nobody asked. The check count therefore travels
     with every percentage, and a window with fewer than six checks is marked
     rather than drawn as a confident 100%.

     LATENCY PERCENTILES ARE OVER SUCCESSFUL CHECKS ONLY. A ten-second timeout
     folded into a p95 turns a connection refused — which took two
     milliseconds — into a "slow site", and the failure is already reported as
     a failure one card over.
  */
  "uptime.up": {
    src: "uptime",
    name: "Hosts up",
    kind: "metric",
    live: { uptime: true },
  },
  "uptime.availability": {
    src: "uptime",
    name: "Availability",
    kind: "bars",
    live: { uptime: true },
  },
  "uptime.latency": {
    src: "uptime",
    name: "Response time",
    kind: "rows",
    live: { uptime: true },
  },
  /*
    CERTIFICATES ON THE SAME AXIS THE DOMAIN RENEWALS USE, and for the same
    reason: "3 December" and "18 February" are not a distance until somebody
    does the arithmetic, and a runway has already done it. A negative row is an
    EXPIRED certificate and is the most urgent thing this dashboard can draw —
    which is exactly why the countdown is never clamped at zero on the way in.
  */
  "uptime.tls": {
    src: "uptime",
    name: "Certificate expiry",
    kind: "runway",
    live: { uptime: true },
    thresholds: { warn: 30, crit: 7 },
    cap: 400,
  },
  "uptime.incidents": {
    src: "uptime",
    name: "Incidents",
    kind: "rows",
    live: { uptime: true },
  },

  /* ------------------------------------------------------------------ fleet
     WHICH OF THESE FIGURES ADD IS THE WHOLE ARGUMENT, and only one of the
     three does. MEMORY ADDS: fifty gigabytes on one box and eight on another
     really is fifty-eight gigabytes of RAM somebody is paying for.

     LOAD DOES NOT. A load average is already relative to a machine's cores, so
     a fleet load average is a number in no unit. What every card below draws
     instead is load PER CPU, as a percentage of one runnable task per core,
     which is comparable between a Pi and a sixteen-core box.

     DISK DOES NOT EITHER, which is less obvious. Filesystems share pools: a
     Mac's `/` and `/System/Volumes/Data` report the same free space out of one
     container, so adding mounts puts a terabyte and a half of free space on a
     one-terabyte disk. There is no fleet disk total; there is a meter per box,
     on that box's fullest mount, which is the figure the page is for.
  */
  "fleet.memory": {
    src: "fleet",
    name: "Memory by box",
    kind: "meters",
    live: { boxes: true },
  },
  "fleet.disk": {
    src: "fleet",
    name: "Disk by box",
    kind: "meters",
    live: { boxes: true },
  },
  "fleet.load": {
    src: "fleet",
    name: "Load per cpu",
    kind: "meters",
    live: { boxes: true },
  },
  "fleet.containers": {
    src: "fleet",
    name: "Containers",
    kind: "table",
    live: { boxes: true },
    headers: ["Box", "Container", "Image", "Status"],
  },
  "fleet.counters": {
    src: "fleet",
    name: "Counters",
    kind: "rows",
    live: { boxes: true },
  },
  "fleet.boxes": {
    src: "fleet",
    name: "Every box",
    kind: "table",
    live: { boxes: true },
    headers: ["Box", "Host", "Memory", "Fullest disk", "Load/cpu", "Containers"],
  },

  /* --------------------------------------------------------------- products
     The owner's own products, asked for their own JSON and read with the
     owner's own mapping. TWO KINDS OF NUMBER LIVE HERE and they are labelled
     apart: the value is the mapped path resolved against the LAST document, so
     it is as fresh as that document, and the series is what the collector
     recorded at the time — a metric added this morning has a value and almost
     no history, which is honest rather than broken.

     A PATH THAT RESOLVES TO NOTHING IS AN ERROR WITH ITS REASON AND NEVER A
     ZERO, and it appears on the row rather than being quietly dropped. There
     is no total across endpoints: "renders" on one product and "renders" on
     another share a word the owner chose and nothing else.
  */
  "products.metrics": {
    src: "products",
    name: "Mapped figures",
    kind: "rows",
    live: { products: true },
  },
  "products.endpoints": {
    src: "products",
    name: "Endpoints",
    kind: "statuses",
    live: { products: true },
  },

  /* -------------------------------------------------------------- backlinks
     NOTHING ON THESE TWO CARDS IS EVER SUMMED ACROSS SOURCES, and that is the
     point of drawing them as a table of sources rather than as a figure. The
     three sources overlap and disagree — a host both Bing and the verification
     crawler know about would be counted twice — and none of them is a census,
     so a "referring domains" total would be a made-up number with a very
     convincing shape. Each row carries the confidence the server assigns it.

     THREE STATES, NOT TWO. `ok: false` is a source that refused, `ok: null` is
     one that was never asked, and a zero with `ok: true` is a real measurement
     of nothing. Host in-degree — how many distinct sites link to a domain
     across the whole web — is not measured by anything here and is never
     implied.
  */
  "backlinks.bySource": {
    src: "backlinks",
    name: "By source",
    kind: "table",
    live: { backlinks: true },
    headers: ["Host", "Source", "Conf.", "Ref. domains", "Backlinks", "State"],
  },
  "backlinks.domains": {
    src: "backlinks",
    name: "Referring domains",
    kind: "rows",
    live: { backlinks: true },
  },

  /* --------------------------------------------------------------- presence
     The off-site footprint as a matrix, product by directory. FOUR STATUSES
     AND THEY MUST NOT COLLAPSE TO TWO: `present` and `absent` are answers,
     `blocked` means the source could not be asked at all — a 403, a rate
     limit, a directory with no keyless lookup — and `error` is the check
     itself breaking. A blocked cell rendered as a grey "no" is a dashboard
     telling somebody to go and get listed where they may already be listed,
     which is why `presence.blocked` exists as a card of its own.

     THERE IS NO SCORE HERE. Three quarters of the original score came from a
     sweep this integration does not carry, and a score built from what is left
     would be a different number wearing the same name.
  */
  "presence.matrix": {
    src: "presence",
    name: "Where each product is listed",
    kind: "table",
    live: { presence: true },
    headers: ["Product"],
  },
  "presence.blocked": {
    src: "presence",
    name: "Could not be checked",
    kind: "statuses",
    live: { presence: true },
  },

  /* ------------------------------------------------------------------ audit
     THE PORTFOLIO'S OWN SITES, one row each, from the crawl this box runs.

     A VENTURE THAT HAS NEVER BEEN AUDITED IS NOT A VENTURE WITH NO PROBLEMS,
     and every card below is built to refuse that reading: the unaudited are
     counted separately, named on their own line, and never folded into a
     figure that would go down when a site is added.

     THE THREE SEVERITIES ARE NEVER ADDED TOGETHER either. An error is a broken
     link or a page that would not render; a notice is a missing meta
     description. One number over the three would let forty notices outweigh a
     dead homepage, and the ordering on `audit.worst` would then be wrong in
     exactly the case somebody opened the board for.
  */
  "audit.issues": {
    src: "audit",
    name: "Errors across the portfolio",
    kind: "metric",
    live: { audit: true },
  },
  "audit.ventures": {
    src: "audit",
    name: "Every venture's last crawl",
    kind: "table",
    live: { audit: true },
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
  },
  "audit.worst": {
    src: "audit",
    name: "Worst first",
    kind: "rows",
    live: { audit: true },
  },
  "audit.https": {
    src: "audit",
    name: "HTTPS and the canonical host",
    kind: "statuses",
    live: { audit: true },
  },

  /* ------------------------------------------------------------------- runs
     WHAT THE AGENT HAS BEEN ASKED TO DO, and how far it got.

     ONE RUN EXECUTES AT A TIME, so "running" is a nought or a one and the
     interesting figure beside it is the queue. Nothing here counts a queued
     run as work done, and nothing adds `done` to `failed`: a failed run wrote
     no report, and a bar chart that stacked the two would say the agent had
     produced twice what it has.
  */
  "runs.running": {
    src: "runs",
    name: "Running now",
    kind: "metric",
    live: { runs: true },
  },
  "runs.recent": {
    src: "runs",
    name: "Recent runs",
    kind: "rows",
    live: { runs: true },
  },
  "runs.byKind": {
    src: "runs",
    name: "Reports written, by kind",
    kind: "bars",
    live: { runs: true },
  },

  /* ------------------------------------------------------------ competitors
     THE RIVALS THE SWEEPS HAVE ACCUMULATED, and — on every row — the date the
     sweep last managed to VERIFY one.

     That date is the card, not decoration. A sweep that does not mention a
     company leaves its profile alone rather than re-stamping it, because
     silence is not verification; so a table with no dates on it would quietly
     present a June reading as this morning's. `competitors.stale` exists to
     make that visible from across the room.
  */
  "competitors.count": {
    src: "competitors",
    name: "Rivals profiled",
    kind: "metric",
    live: { competitors: true },
  },
  "competitors.table": {
    src: "competitors",
    name: "Every rival",
    kind: "table",
    live: { competitors: true },
    headers: [
      "Rival",
      "Venture",
      "Positioning",
      "Pricing",
      "Last verified",
      "First seen",
    ],
  },
  "competitors.stale": {
    src: "competitors",
    name: "Not verified in 60 days",
    kind: "rows",
    live: { competitors: true },
  },

  /* ------------------------------------------------------------ finance
     THE RATE CARD, DRAWN THE WAY THE MONEY PAGES DRAW IT: what the portfolio
     owes a month, where it goes by group, then the bill line by line —
     servers, services, electricity, domains — and the two counts that keep
     the total honest: what renews soon, and what has no price. Every figure
     is per currency and nothing here adds euro to dollars; a card whose
     lines are in two currencies says which one it is drawing.
  */
  "finance.monthly": {
    src: "finance",
    name: "Monthly cost",
    kind: "metric",
    live: { finance: true },
    invert: true,
  },
  "finance.groups": {
    src: "finance",
    name: "Where it goes",
    kind: "donut",
    live: { finance: true },
  },
  "finance.servers": {
    src: "finance",
    name: "Servers",
    kind: "ranked",
    live: { finance: true },
  },
  "finance.services": {
    src: "finance",
    name: "Services",
    kind: "rows",
    live: { finance: true },
  },
  "finance.power": {
    src: "finance",
    name: "Electricity",
    kind: "rows",
    live: { finance: true },
  },
  "finance.domains": {
    src: "finance",
    name: "Domains",
    kind: "rows",
    live: { finance: true },
  },
  "finance.renewals": {
    src: "finance",
    name: "Renewals · 90d",
    kind: "metric",
    live: { finance: true },
  },
  "finance.unpriced": {
    src: "finance",
    name: "Unpriced lines",
    kind: "metric",
    live: { finance: true },
  },
  /* --------------------------------------------------------------- payments
    THE PAYMENTS BOARD — workstream "payments-board", 2026-09-08.

    What the Stripe cards above do not draw, for the board that mirrors
    Workdash's Payments page: the window's gross beside its attempts, the
    alerts, the leakage buckets, the fail rate with its fixed seven-against-
    thirty drift, gross beside net per day, MRR movement, the cancellations
    still billing, MRR by plan, the disputes, the two day tables and the
    honest list of what the board cannot say.

    FILED UNDER STRIPE, because every one reads `/api/stripe` or one of the
    three documents computed from the same tables on every request — the
    leakage buckets, the dispute cases and the recovery queue — and the live
    dot's clock is when Stripe was last read, whichever of the four answered.

    NOTHING HERE IS A SECOND DRAWING OF A CARD THAT EXISTS. MRR, ARR, the
    book, revenue churn, the fees, the mix, blocked-against-declined and the
    payout balance are the `stripe.*` widgets above, and the seeded board
    places those; a builder below that could have printed one of them prints
    the thing beside it instead.

    EVERY WINDOWED NAME IS REWRITTEN BY ITS BUILDER from the document's own
    `days`, so "· 30d" here is the sample's window and not a promise.
  */
  "payments.mrr": {
    src: "stripe",
    name: "MRR",
    window: "now",
    kind: "proportion",
    live: { stripe: true },
  },
  "payments.gross": {
    src: "stripe",
    name: "Gross · 30d",
    kind: "proportion",
    live: { stripe: true },
  },
  "payments.subs": {
    src: "stripe",
    name: "Active subscriptions",
    window: "now",
    kind: "proportion",
    live: { stripe: true },
  },
  "payments.alerts": {
    src: "stripe",
    name: "Worth a look",
    kind: "statuses",
    live: { stripe: true, disputes: true, queue: true },
  },
  "payments.floor": {
    src: "stripe",
    name: "Money on the floor",
    kind: "proportion",
    live: { leakage: true, stripe: true },
  },
  "payments.failRate": {
    src: "stripe",
    name: "Why payments fail · 30d",
    kind: "proportion",
    live: { stripe: true },
    invert: true,
    unit: "percent",
  },
  "payments.daily": {
    src: "stripe",
    name: "Daily revenue · 30d",
    kind: "chart",
    live: { stripe: true },
    unit: "usd",
  },
  "payments.movement": {
    src: "stripe",
    name: "MRR movement · 30d",
    kind: "waterfall",
    live: { stripe: true },
  },
  "payments.leaving": {
    src: "stripe",
    name: "Leaving unless someone writes",
    kind: "rows",
    live: { queue: true },
  },
  "payments.plans": {
    src: "stripe",
    name: "Revenue by plan",
    kind: "ranked",
    live: { stripe: true },
  },
  "payments.disputes": {
    src: "stripe",
    name: "Disputes · 30d",
    kind: "rows",
    live: { disputes: true },
  },
  "payments.attemptDays": {
    src: "stripe",
    name: "Attempts by day · last 14 of 30",
    kind: "table",
    live: { stripe: true },
    headers: ["Day", "Succeeded", "Blocked", "Declined", "Gross"],
  },
  "payments.ledgerDays": {
    src: "stripe",
    name: "Settled by day · last 14 of 30",
    kind: "table",
    live: { stripe: true },
    headers: ["Day", "Gross", "Fees", "Net"],
  },
  "payments.attempts": {
    src: "stripe",
    name: "Payment attempts · 30d",
    kind: "proportion",
    live: { stripe: true },
  },
  "payments.recent": {
    src: "stripe",
    name: "Payments · 30d",
    kind: "table",
    live: { stripe: true },
    headers: ["When", "Amount", "Who", "Status"],
  },
  "payments.cannot": {
    src: "stripe",
    name: "What this board will not say",
    kind: "rows",
    live: { stripe: true, leakage: true },
  },
  /* ======================================================================
     SEO BOARD PARITY (Workdash /seo + /search).

     WHAT WORKDASH DRAWS THAT THIS BOARD DID NOT: the search totals as four
     tiles, a daily line for clicks as well as impressions, one line PER
     PROPERTY, clicks against impressions on one axis, the query and page
     lists as ranked bars, the page-two list, the sitemaps and the top query
     of every property in one table each, the zero-click pages, the audit
     ranked worst first, and the four things this box computes itself —
     authority, AI visibility, follow-ups after SEO work, and IndexNow.

     THREE RULES CARRIED OVER. Nothing here adds Google to Bing. Every window
     is written on the card by the builder, from the route's own window,
     rather than baked into the name. And THERE IS NO SCORE: Workdash ranks
     its sites by an audit score, this box's audit refuses one on purpose, so
     the ranked card here is errors, worst first, and says so in its caption.
     ====================================================================== */
  "gsc.ctr": {
    src: "gsc",
    name: "CTR · Google",
    kind: "metric",
    live: { gsc: true },
  },
  "gsc.properties": {
    src: "gsc",
    name: "Properties",
    kind: "metric",
    live: { gsc: true },
  },
  /* A verified property with nothing shown yet is not a broken one — the
     card Workdash calls "No search data yet". */
  "gsc.quiet": {
    src: "gsc",
    name: "No search data yet",
    kind: "rows",
    live: { gsc: true },
  },
  /* Clicks on their own axis, the way `gsc.trend` keeps impressions on
     theirs: forty times apart, the two cannot share one. */
  "gsc.clicksTrend": {
    src: "gsc",
    name: "Clicks a day · portfolio",
    kind: "chart",
    live: { gsc: true },
    unit: "count",
  },
  /* ONE LINE PER PROPERTY, the busiest four. The rest are on the table
     beside this card rather than summed into a fifth line called "other". */
  "gsc.propertyClicks": {
    src: "gsc",
    name: "Clicks a day, by property",
    kind: "chart",
    live: { gsc: true },
    unit: "count",
  },
  "gsc.propertyImpressions": {
    src: "gsc",
    name: "Impressions a day, by property",
    kind: "chart",
    live: { gsc: true },
    unit: "count",
  },
  /* Two dots per property on one log axis; the distance between them is the
     click-through rate drawn rather than printed. */
  "gsc.dumbbell": {
    src: "gsc",
    name: "Clicks against impressions",
    kind: "dumbbell",
    live: { gsc: true },
    log: true,
  },
  /* The three ranked lists as Workdash draws them: a bar per row, the
     figure at its tip, the property and the rank in the small print. The
     `rows` cards of the same name on the Search board stay as they are. */
  "gsc.queriesRanked": {
    src: "gsc",
    name: "Top queries · Google",
    kind: "ranked",
    live: { gsc: true },
  },
  "gsc.pagesRanked": {
    src: "gsc",
    name: "Top pages · Google",
    kind: "ranked",
    live: { gsc: true },
  },
  "gsc.strikingRanked": {
    src: "gsc",
    name: "Page-two opportunities · 5–20",
    kind: "ranked",
    live: { gsc: true },
  },
  /* EVERY PROPERTY ON ONE TABLE, three times: its own top query, its own
     page-two query, its own sitemap standing. The portfolio lists above are
     one busy property's list wearing the portfolio's name; these are cut per
     property on the route. */
  "gsc.propertyQueries": {
    src: "gsc",
    name: "Top query, every property",
    kind: "table",
    live: { gsc: true },
    headers: ["Property", "Top query", "Clicks", "Impressions", "Position", "Rows cover"],
  },
  "gsc.propertyStriking": {
    src: "gsc",
    name: "Striking distance, every property",
    kind: "table",
    live: { gsc: true },
    headers: ["Property", "Query", "Position", "Impressions", "Clicks"],
  },
  "gsc.sitemapsByProperty": {
    src: "gsc",
    name: "Sitemaps, every property",
    kind: "table",
    live: { gsc: true },
    headers: ["Property", "Sitemaps", "URLs submitted", "Errors", "Warnings", "Last read"],
  },
  /* Shown and never clicked — within the pages Google returned, so a FLOOR. */
  "gsc.zeroClick": {
    src: "gsc",
    name: "Zero-click pages",
    kind: "rows",
    live: { gsc: true },
  },
  /* The route's own `cannot` list as a card, the way `meta.cannot` closes
     the Social board: said here rather than left to be assumed. */
  "gsc.cannot": {
    src: "gsc",
    name: "What Search Console cannot say",
    kind: "rows",
    live: { gsc: true },
  },
  /* Errors, worst first — NOT a score. The audit refuses one, so the bar is
     the error count and the warnings ride in the small print, never added. */
  "audit.ranked": {
    src: "audit",
    name: "Errors by site, worst first",
    kind: "ranked",
    live: { audit: true },
  },
  "audit.crawled": {
    src: "audit",
    name: "Sites audited",
    kind: "metric",
    live: { audit: true },
  },
  /* A LEVEL per day, one line per site: pages Bing is holding. Never
     summed over days, and never on an axis with anything a person did. */
  "bing.propertyIndex": {
    src: "bing",
    name: "Pages in Bing's index, by site",
    kind: "chart",
    live: { bing: true },
    unit: "count",
  },
  /* LISTED BY HOST AND NEVER RANKED. Two hosts whose basis differs are two
     different measurements wearing one word, so the table keeps the route's
     order and the basis column is what makes a row readable. */
  "authority.ceiling": {
    src: "authority",
    name: "Authority · this box's own estimate",
    kind: "table",
    live: { seo: true },
    headers: ["Host", "Estimate", "Aim under difficulty", "Basis", "Ref. domains"],
  },
  /* Mentioned-of-asked per venture, the bar against the venture's OWN
     denominator — a venture asked three times is not compared with one
     asked thirty. */
  "geo.mentioned": {
    src: "geo",
    name: "Measured AI visibility",
    kind: "ranked",
    live: { seo: true },
  },
  /* Workdash's "What moved": a Search Console reading taken after a card was
     finished, against the one taken when it was. The verdict is arithmetic. */
  "seoops.moved": {
    src: "seoops",
    name: "What moved · after SEO work",
    kind: "rows",
    live: { seo: true },
  },
  /* Workdash's "Search engines told": which hosts have told IndexNow
     anything, and the sentence that a receipt is not an indexing. */
  "indexing.told": {
    src: "indexing",
    name: "Search engines told · IndexNow",
    kind: "rows",
    live: { seo: true },
  },

  /* ======================================================================
     SEARCH BOARD + PER-PROJECT WIDGETS (Workdash /search, /search/<site>).

     TWO THINGS ARRIVE TOGETHER. First, the one card Workdash's all-properties
     page had that this board did not: the rail — every property as a row
     with a sparkline, ranked by clicks, so the whole portfolio is read at a
     glance without twenty cards. Second, the PER-PROJECT cards: Workdash's
     property card and its per-property page, each taking a venture on the
     card (`perProject`, `PlacedWidget.param`) and drawing that venture's
     property alone. The SEO side gets the same for its own four documents —
     the audit, the authority estimate, IndexNow and what moved.

     EVERY PER-PROJECT BUILDER READS DOCUMENTS ALREADY NARROWED to the
     venture's hosts — the card does that with lib/scope's rule before the
     builder runs — so a builder below is written exactly as a portfolio
     one is, and declines with null when the venture has nothing in the
     source. The card, not the builder, puts the venture's name on the card.

     THE SAME THREE RULES. Nothing adds Google to Bing. Every window is on
     the card from the route's own window. No score anywhere.
     ====================================================================== */
  /* Workdash's rail: a row per property, a bar against the busiest, the
     property's own daily clicks as a shape beside the name. Ranked by
     clicks because the question is "where is the search traffic". */
  "gsc.rail": {
    src: "gsc",
    name: "Every property, by clicks",
    kind: "ranked",
    live: { gsc: true },
  },
  /* Workdash's SiteCard, one venture: the four tiles, clicks per day, the
     top queries. */
  "gsc.project": {
    src: "gsc",
    name: "Search",
    kind: "profile",
    perProject: true,
    live: { gsc: true },
    unit: "count",
  },
  /* The per-property page's cards, one venture each. Clicks and impressions
     are two charts rather than two lines: forty times apart, they cannot
     share an axis, which is the rule `gsc.trend` keeps. */
  "gsc.projectDaily": {
    src: "gsc",
    name: "Clicks a day",
    kind: "chart",
    perProject: true,
    live: { gsc: true },
    unit: "count",
  },
  "gsc.projectImpressions": {
    src: "gsc",
    name: "Impressions a day",
    kind: "chart",
    perProject: true,
    live: { gsc: true },
    unit: "count",
  },
  "gsc.projectQueries": {
    src: "gsc",
    name: "Top queries",
    kind: "ranked",
    perProject: true,
    live: { gsc: true },
  },
  "gsc.projectPages": {
    src: "gsc",
    name: "Top pages",
    kind: "ranked",
    perProject: true,
    live: { gsc: true },
  },
  "gsc.projectStriking": {
    src: "gsc",
    name: "Page-two opportunities · 5–20",
    kind: "ranked",
    perProject: true,
    live: { gsc: true },
  },
  "gsc.projectSitemaps": {
    src: "gsc",
    name: "Sitemaps",
    kind: "rows",
    perProject: true,
    live: { gsc: true },
  },
  /* The SEO side, one venture each. The audit card is the overview's row
     for the venture — counts, not pages: the page list is the crawl itself,
     a megabyte the board never fetches, and the caption says where it is. */
  "audit.project": {
    src: "audit",
    name: "Audit",
    kind: "profile",
    perProject: true,
    live: { audit: true },
  },
  "authority.project": {
    src: "authority",
    name: "Authority · this box's own estimate",
    kind: "rows",
    perProject: true,
    live: { seo: true },
  },
  "indexing.project": {
    src: "indexing",
    name: "Search engines told · IndexNow",
    kind: "rows",
    perProject: true,
    live: { seo: true },
  },
  "seoops.project": {
    src: "seoops",
    name: "What moved · after SEO work",
    kind: "rows",
    perProject: true,
    live: { seo: true },
  },

  /* ======================================================================
     SOCIAL BOARD PARITY (Workdash /social and /social/<id>) — workstream
     "social-board", 2026-09-08.

     WHAT WORKDASH DRAWS THAT THIS BOARD DID NOT: the posts. All of them —
     the picture, the words, the date, the figures and the link — as the two
     lists it argues for (what worked, and what went out lately), the
     followers hero with its split bar, the views hero with its three
     denominators, the quiet-for tile, views ranked by page, and the page
     table with the collector's own state on the end.

     AND WHAT IT DOES NOT DRAW, ADDED HERE. Workdash matches a Page to a
     project by testing the Page's NAME against a regular expression and
     admits the weakness wherever it shows. This box has the owner's own
     mapping — a destination row under Publishing, typed by a person, written
     onto every post the timeline reader stores — so the per-project cards
     here are exact rather than approximate. There is also a publishing
     QUEUE, which no Workdash page has at all: what has been drafted,
     approved and scheduled is the half of the loop a timeline can never see.

     FOUR RULES CARRIED ACROSS EVERY CARD. "Views" and never "reach" on a
     Facebook post, because `post_media_view` counts renders. A metric that
     is not a key was not reported and draws a dash. A window wider than the
     collection interval is a FLOOR, because twenty-five posts are read per
     Page per pass. And nothing adds across networks — not followers, not
     views, not a Facebook render to an Instagram unique account.
     ====================================================================== */
  "social.followers": {
    src: "social",
    name: "Followers",
    kind: "proportion",
    window: "now",
    live: { social: true, meta: true },
  },
  "social.views": {
    src: "social",
    name: "Views",
    kind: "proportion",
    window: "selected",
    live: { social: true },
  },
  "social.quiet": {
    src: "social",
    name: "Last post",
    kind: "metric",
    window: "now",
    live: { social: true },
  },
  "social.perPost": {
    src: "social",
    name: "Views a post",
    kind: "metric",
    window: "selected",
    live: { social: true },
  },
  "social.cadence": {
    src: "social",
    name: "Posts published",
    kind: "chart",
    window: "selected",
    live: { social: true },
    unit: "count",
  },
  "social.viewsTrend": {
    src: "social",
    name: "Views on what went out",
    kind: "chart",
    window: "selected",
    live: { social: true },
    unit: "count",
  },
  "social.viewsByPage": {
    src: "social",
    name: "Views by Page",
    kind: "ranked",
    window: "selected",
    live: { social: true },
  },
  "social.engagementByPage": {
    src: "social",
    name: "Reactions + comments by Page",
    kind: "ranked",
    window: "selected",
    live: { social: true },
  },
  "social.accounts": {
    src: "social",
    name: "Every account",
    kind: "table",
    live: { social: true, meta: true },
    headers: [
      "Page",
      "Network",
      "Followers now",
      "Posts",
      "Views",
      "Reactions + comments",
      "Last post any age",
      "Collector",
    ],
  },
  "social.top": {
    src: "social",
    name: "Top posts",
    kind: "feed",
    window: "selected",
    live: { social: true },
  },
  "social.latest": {
    src: "social",
    name: "Latest posts",
    kind: "feed",
    window: "selected",
    live: { social: true },
  },
  "social.facebook": {
    src: "social",
    name: "Facebook Pages · latest",
    kind: "feed",
    window: "selected",
    live: { social: true },
  },
  "social.instagram": {
    src: "social",
    name: "Instagram · latest",
    kind: "feed",
    window: "selected",
    live: { social: true, meta: true },
  },
  "social.bluesky": {
    src: "social",
    name: "Bluesky · latest",
    kind: "feed",
    window: "selected",
    live: { social: true, bluesky: true },
  },
  "social.published": {
    src: "social",
    name: "Published from here",
    kind: "feed",
    live: { social: true },
  },
  "social.queue": {
    src: "social",
    name: "Waiting to go out",
    kind: "rows",
    live: { social: true },
  },
  "social.coverage": {
    src: "social",
    name: "What is being read",
    kind: "statuses",
    live: { social: true, meta: true, bluesky: true },
  },
  "social.project": {
    src: "social",
    name: "Posts",
    kind: "feed",
    window: "selected",
    perProject: true,
    live: { social: true },
  },
  "social.projectStats": {
    src: "social",
    name: "Social",
    kind: "profile",
    window: "selected",
    perProject: true,
    live: { social: true, meta: true },
  },
  /* ======================================================================
     ADS BOARD PARITY (Workdash /ads) — workstream "ads-board", 2026-09-08.

     WORKDASH'S ADS PAGE, TOP TO BOTTOM, AS CARDS. Its shape is an argument
     and the board keeps it: the account's window first, then the VERDICT on
     whether any of that spend is working, then who it was for, then THE
     ADVERTISEMENTS THEMSELVES — the picture and the words people actually
     saw — and only then the accounting view of campaigns and days. The
     creatives are not decoration at the bottom of a board of figures; they
     are the thing every figure above them is about, and a page that shows
     five numbers about an advertisement nobody can look at cannot be acted
     on.

     THREE DOCUMENTS BEHIND THEM, none of which is /api/meta: the health
     rubric (`/growth/ads`), the advertisements with their creatives
     (`/webanalytics/creatives`) and the campaign → venture map
     (`/webanalytics/campaigns`). See lib/api/adsboard for why they are one
     bundle and three fields.

     WHAT NOTHING HERE DOES. It never adds two ad accounts' money, never sums
     reach across anything, never averages a frequency, and never divides ad
     spend into revenue and calls the answer a return on ad spend — Meta
     reports no purchase on this account and this box attributes no euro of
     income to a click. `meta.roas` says that in as many words and stays on
     the board for it.
     ====================================================================== */

  /* --- the account, over the window ---------------------------------- */

  "meta.clicks": {
    src: "meta",
    name: "Ad clicks",
    window: "selected",
    kind: "metric",
    live: { meta: true },
  },
  "meta.cpc": {
    src: "meta",
    name: "Cost per click",
    window: "selected",
    kind: "metric",
    live: { meta: true },
  },
  "ads.delivering": {
    src: "meta",
    name: "Ads delivering",
    window: "selected",
    kind: "metric",
    live: { ads: true },
  },

  /* --- is the spend working ------------------------------------------ */

  "ads.health": {
    src: "meta",
    name: "Account health",
    /* A LEVEL, NOT A WINDOW. The rubric is a verdict on the account as it is
       set up now; its inputs carry their own spans and say them. */
    window: "now",
    kind: "profile",
    live: { ads: true },
  },
  "ads.categories": {
    src: "meta",
    name: "Health by category",
    window: "now",
    kind: "ranked",
    live: { ads: true },
  },
  /* THE QUICK WINS ARE A TABLE AND NOT A ROWS LIST, because the FIX is the
     point of the card and a fix is a sentence. A two-column row would carry
     the title and the minutes and drop the only part somebody can act on. */
  "ads.quickWins": {
    src: "meta",
    name: "Quick wins",
    window: "now",
    kind: "table",
    live: { ads: true },
    headers: ["Quick win", "Severity", "Fix takes", "What to do"],
  },
  "ads.failing": {
    src: "meta",
    name: "What failed, worst first",
    window: "now",
    kind: "table",
    live: { ads: true },
    headers: ["Check", "Result", "Severity", "Fix takes", "What it found"],
  },
  "ads.categoryTable": {
    src: "meta",
    name: "How the score was reached",
    window: "now",
    kind: "table",
    live: { ads: true },
    headers: ["Category", "Score", "Weight", "Evaluated", "Why"],
  },

  /* --- what it bought, per venture ------------------------------------ */

  "ads.ventures": {
    src: "meta",
    name: "Ad spend by venture",
    window: "selected",
    kind: "ranked",
    live: { ads: true, meta: true },
  },
  "ads.venture": {
    src: "meta",
    name: "Ad spend",
    window: "selected",
    kind: "profile",
    perProject: true,
    live: { ads: true, meta: true },
  },
  "ads.mapping": {
    src: "meta",
    name: "Which venture each campaign is for",
    window: "now",
    kind: "table",
    live: { ads: true, meta: true },
    headers: ["Campaign", "Venture", "How", "Evidence"],
  },

  /* --- what ran: the advertisements themselves ------------------------ */

  "ads.creatives": {
    src: "meta",
    name: "What ran",
    window: "selected",
    kind: "feed",
    live: { ads: true, meta: true },
  },
  "ads.cpc": {
    src: "meta",
    name: "Cost per click, ad against ad",
    window: "selected",
    kind: "ranked",
    live: { ads: true },
  },
  "ads.table": {
    src: "meta",
    name: "Every advertisement that delivered",
    window: "selected",
    kind: "table",
    live: { ads: true },
    headers: ["Advertisement", "Spend", "Clicks", "Per click", "CTR", "CPM", "Impressions", "Days"],
  },
  "ads.fatigue": {
    src: "meta",
    name: "Creative fatigue",
    window: "now",
    kind: "rows",
    live: { ads: true },
  },
  "ads.issues": {
    src: "meta",
    name: "Advertisements not running as set up",
    window: "now",
    kind: "statuses",
    live: { ads: true },
  },
  "ads.sets": {
    src: "meta",
    name: "Ad sets",
    window: "now",
    kind: "table",
    live: { ads: true },
    headers: ["Ad set", "Status", "Optimising for", "Budget", "Bid strategy", "Ads"],
  },

  /* --- the accounting view -------------------------------------------- */

  "ads.campaignTrend": {
    src: "meta",
    name: "Campaigns, and how each spent",
    window: "selected",
    kind: "ranked",
    live: { ads: true, meta: true },
  },
  /* ACCOUNT-LEVEL DAILY, so `meta` and not `ads`: /api/meta's own day rows are
     authoritative for delivery — the ad-level table is capped and does not
     page — and they are the only place a per-day LEAD count exists. */
  "meta.results": {
    src: "meta",
    name: "What the money bought, a day",
    window: "selected",
    kind: "chart",
    live: { meta: true },
    unit: "count",
  },

  /* --- AdSense, on the same board and never crossed with the above ---- */

  "adsense.daily": {
    src: "adsense",
    name: "AdSense earnings a day",
    window: "selected",
    kind: "chart",
    live: { adsense: true },
    unit: "usd",
  },
  "adsense.sites": {
    src: "adsense",
    name: "AdSense by site",
    window: "selected",
    kind: "table",
    live: { adsense: true },
    headers: ["Site", "Earnings", "RPM", "Page views", "Impressions", "Clicks", "CTR"],
  },
  "adsense.months": {
    src: "adsense",
    name: "AdSense by month",
    kind: "rows",
    live: { adsense: true },
  },
};

/** The presets offered when a new dashboard is created. */
export const DASHBOARD_PRESETS: {
  id: string;
  label: string;
  note: string;
  widgets: string[];
}[] = [
  {
    id: "blank",
    label: "Blank dashboard",
    note: "place your own",
    widgets: [],
  },
  {
    id: "money",
    label: "Money",
    note: "Stripe, AdSense, App Store, infra spend",
    widgets: [
      "stripe.mrr",
      "stripe.churn",
      "adsense.earnings",
      "appstore.proceeds",
      "hetzner.spend",
      "openai.cost",
    ],
  },
  /*
    COSTS. Everything that charges for itself, in the units it charges in.
    The order is the reading order of the seeded board: what it costs, then
    each provider's own answer, then — last — what none of these APIs will
    tell you, because that is the card that stops the rest from being read as
    the whole bill.
  */
  {
    id: "costs",
    label: "Costs",
    note: "LLM, media and infrastructure — each in its own currency",
    widgets: [
      "finance.monthly",
      "finance.renewals",
      "finance.unpriced",
      "finance.groups",
      "finance.servers",
      "finance.services",
      "finance.power",
      "finance.domains",
      "costs.llm",
      "hetzner.spend",
      "openrouter.credits",
      "replicate.compute",
      "costs.sideBySide",
      "costs.byProvider",
      "openai.cost",
      "openai.daily",
      "openai.projects",
      "openrouter.spend",
      "openrouter.models",
      "openrouter.totals",
      "openrouter.keys",
      "openrouter.free",
      "replicate.runs",
      "replicate.health",
      "replicate.models",
      "replicate.outputs",
      "replicate.noCost",
      "hetzner.spendSplit",
      "costs.limits",
    ],
  },
  /*
    LLM USAGE. Shaped after the page Workdash draws for it: the balance and
    what it buys, then the window's bill and volume, then the two daily lines,
    then where it went by model and by key — and, below OpenRouter's account
    of the money, this box's own account of the work: which chat, which run,
    which venture, and how today stands against the limits.
  */
  {
    id: "llm",
    label: "LLM usage",
    note: "OpenRouter's bill, and what this box's own chat and runs consumed",
    widgets: [
      "openrouter.credits",
      "openrouter.runway",
      "openrouter.spend",
      "openrouter.tokens",
      "openrouter.daily",
      "openrouter.tokensDaily",
      "openrouter.models",
      "openrouter.modelTable",
      "openrouter.keyTable",
      "openrouter.free",
      "llm.today",
      "llm.window",
      "llm.daily",
      "llm.byModel",
      "llm.byWork",
      "llm.byVenture",
      "llm.budget",
      "llm.ledger",
      "costs.llm",
      "costs.limits",
    ],
  },
  {
    id: "traffic",
    label: "Search & traffic",
    note: "Search Console, Bing and Cloudflare",
    widgets: [
      "gsc.impressions",
      "gsc.clicks",
      "bing.impressions",
      "bing.clicks",
      "gsc.trend",
      "gsc.queries",
      "bing.queries",
      "gsc.coverage",
      "cf.total",
      "cf.daily",
      "cf.requests",
      "cf.dns",
    ],
  },
  {
    id: "hetzner",
    label: "Hetzner",
    note: "every block the collector fills",
    widgets: [
      "hetzner.spend",
      "hetzner.serverCount",
      "hetzner.avgCost",
      "hetzner.ipv4",
      "hetzner.servers",
      "hetzner.arch",
      "hetzner.fleet",
      "hetzner.spendSplit",
      "hetzner.byPlan",
      "hetzner.byLocation",
      "hetzner.specs",
      "hetzner.age",
    ],
  },
  {
    id: "servers",
    label: "Servers",
    note: "load, status and cost, box by box",
    widgets: [
      "hetzner.fleetCpu",
      "hetzner.busiest",
      "hetzner.serverCount",
      "hetzner.spend",
      "hetzner.load",
      "hetzner.cpuMeters",
      "hetzner.servers",
      "hetzner.figures",
      "hetzner.traffic",
      "hetzner.diskWrite",
      "hetzner.quiet",
      "hetzner.volumes",
      "hetzner.specs",
      "hetzner.age",
    ],
  },
  {
    id: "domains",
    label: "Domains",
    note: "the portfolio and what renews next",
    widgets: [
      "registrars.total",
      "registrars.lapsed",
      "registrars.expiring",
      "registrars.autoRenewOff",
      "registrars.runway",
      "registrars.attention",
      "registrars.security",
      "registrars.table",
      "registrars.byTld",
      "registrars.byRegistrar",
      "registrars.nameservers",
      "registrars.newest",
    ],
  },
  /*
    THE SHOP WINDOW AND THE THING IT SELLS, on one board.

    GitHub and npm are two halves of one question — somebody reads the repo,
    then installs the package — and they are the two ends of it that can
    actually be measured: GitHub says how many people looked and where they
    came from, npm says how many tarballs went out afterwards. Nothing joins
    them into a conversion rate, and nothing here pretends to: the counts are
    of different things (a view is a person, a download is a fetch), so they
    sit beside each other as two shapes over the same weeks rather than as a
    numerator and a denominator.

    Ordered the way the questions get asked: the four figures first, then where
    the attention came from, then the two lines over time, then the tables
    behind both pictures — with the API budget in among them, because a board
    that stops updating should be able to say why.
  */
  {
    id: "code",
    label: "Code & packages",
    note: "stars, repo traffic and npm downloads",
    widgets: [
      "github.stars",
      "github.views",
      "github.clones",
      "npm.downloads",
      "github.traffic",
      "github.referrers",
      "github.top",
      "github.paths",
      "npm.weeks",
      "npm.packages",
      "pypi.downloads",
      "pypi.weekly",
      "pypi.packages",
      "github.commits",
      "github.prs",
      "github.languages",
      "github.rate",
      "github.repos",
      "npm.table",
    ],
  },
  /*
    ANALYTICS. What the sites themselves counted, which is a different question
    from what a search engine showed — Search Console reports impressions on
    result pages, Umami reports people who arrived. The two live on separate
    boards for that reason and nothing here adds them.

    Bluesky is on this board rather than on Growth because it is the only other
    source whose numbers are counted by us about us: an account's own posts and
    its own followers, read from the public AppView. The two refusals — no
    portfolio visitor count, no combined follower count — are stated on the
    cards that would otherwise carry them.
  */
  {
    id: "analytics",
    label: "Analytics",
    note: "Umami's own counts, and the Bluesky accounts beside them",
    widgets: [
      "umami.pageviews",
      "umami.visitors",
      "umami.bounce",
      "umami.avgVisit",
      "umami.daily",
      "umami.sites",
      "umami.pages",
      "umami.referrers",
      "umami.events",
      "bluesky.followers",
      "bluesky.engagement",
      "bluesky.handles",
    ],
  },
  /*
    THE BOXES THAT ARE NOT HETZNER'S, and the probe that says whether anything
    is answering. Hetzner reports from the hypervisor and can therefore say
    nothing about memory or filesystems; the ssh fleet reports from inside the
    guest and can say nothing about the bill. Two halves of one machine, and
    they are on one board because that is how a morning goes.
  */
  {
    id: "boxes",
    label: "Boxes & uptime",
    note: "memory, disks and load from inside the guest — and what is answering",
    widgets: [
      "uptime.up",
      "uptime.tls",
      "fleet.memory",
      "fleet.disk",
      "fleet.load",
      "uptime.availability",
      "uptime.latency",
      "uptime.incidents",
      "fleet.counters",
      "fleet.containers",
      "fleet.boxes",
    ],
  },
  /*
    OFF-SITE. Everything about a product that is written down somewhere else:
    who links to it, which directories carry it, and what its own endpoint says
    about itself. Not one figure on this board is added to another — the
    backlink sources overlap and disagree, and two products' metrics share only
    a word the owner chose.
  */
  {
    id: "offsite",
    label: "Links & listings",
    note: "inbound links, directory presence and each product's own endpoint",
    widgets: [
      "backlinks.bySource",
      "backlinks.domains",
      "presence.matrix",
      "presence.blocked",
      "products.endpoints",
      "products.metrics",
    ],
  },
  /*
    WHAT THE AGENT DID, AND WHAT IT FOUND OUT THERE.

    A preset rather than a starter board, and the distinction is the point: a
    board is a gift handed to every install, and these cards are empty until
    somebody has actually run something. The three runs cards are about the
    machine — one run at a time, whose turn it is, how many reports exist — and
    the three competitor cards are what the sweeps accumulated. They share a
    preset because they share a cause, not a figure: nothing here adds a run to
    a rival, and the only thing the two halves have in common is that a run
    wrote the profile.

    The queue first, because "is it busy" is the question somebody has while
    waiting. Then the rivals, and the staleness list LAST — which is where a
    reader arrives after reading a positioning line and wondering when anybody
    last checked it.
  */
  {
    id: "agent",
    label: "Agent runs & rivals",
    note: "the run queue, and the competitor profiles those runs accumulated",
    widgets: [
      "runs.running",
      "competitors.count",
      "runs.byKind",
      "runs.recent",
      "competitors.table",
      "competitors.stale",
    ],
  },
  {
    id: "stock",
    label: "Stock footage",
    note: "what is left of the monthly search allowance",
    widgets: [
      "pexels.quota",
      "pexels.burn",
      "pexels.meter",
      "pexels.remaining",
      "pexels.limits",
    ],
  },
  {
    id: "revenue",
    label: "Revenue",
    note: "Stripe, the two app stores and AdSense",
    widgets: [
      "stripe.mrr",
      "stripe.arr",
      "stripe.subs",
      "stripe.churn",
      "stripe.gross",
      "stripe.net30",
      "stripe.fees",
      "mobile.sideBySide",
      "play.revenue",
      "appstore.payout",
      "appstore.proceeds",
      "stripe.products",
      "adsense.earnings",
      "adsense.rpm",
    ],
  },
  {
    id: "build",
    label: "Build health",
    note: "GitHub, uptime, alerts",
    widgets: [
      "github.commits",
      "github.prs",
      "uptime.status",
      "hetzner.servers",
      "telegram.alerts",
    ],
  },
];
