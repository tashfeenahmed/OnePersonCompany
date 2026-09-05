/**
 * THE REPORT DOCUMENTS, as the widgets read them.
 *
 * A file of its own rather than nine more blocks in `lib/api.ts`, and the
 * reason is the same one the server gives for splitting its integrations into
 * areas: these are read by exactly one consumer — the dashboard — and a type
 * that only the board uses does not belong in the middle of the plugin
 * vocabulary every page shares. `call` is imported rather than reimplemented,
 * so there is still one fetch, one error class and one base path.
 *
 * WHAT EVERY TYPE HERE IS FAITHFUL TO IS THE NULLS. Six of these documents
 * carry a figure that is null ON PURPOSE and says why beside itself — Umami's
 * combined visitors, Bluesky's combined followers, the fleet's disk total and
 * its load average, the products' cross-endpoint total, the backlinks'
 * referring-domain sum. Typing any of them as `number` would be one optimistic
 * `?? 0` away from a dashboard adding two things nobody can add, so each is
 * `number | null` with the server's own note beside it in the shape.
 *
 * NOTHING HERE NARROWS A SHAPE TO WHAT THE WIDGETS HAPPEN TO DRAW. A field the
 * cards do not use yet still gets a name, because the next card wants it and a
 * type that lags the wire is worse than one that is complete.
 *
 * NINE OF THESE ARE COLLECTORS AND THREE ARE NOT. The last three — the audit
 * overview, the agent runs and the competitor profiles — are this box's own
 * tables rather than somebody else's API, so they have no credential, no
 * connected switch and nothing to gate a fetch on. They are in this file
 * anyway, because what makes a document belong here is that the dashboard is
 * its only reader, and that is as true of a run as it is of a Bluesky handle.
 */
import { call } from "@/lib/api";

/* ------------------------------------------------------------------ umami */

/** One website's window, as the instance counted it. `visitors` is per site
 *  and never added to another site's — see `UmamiPortfolio.visitors`. */
export type UmamiWindow = {
  days: number;
  start: string | null;
  end: string | null;
  pageviews: number | null;
  visitors: number | null;
  visits: number | null;
  bounces: number | null;
  totaltime: number | null;
  /** Umami's own definition: a visit with one pageview. Not GA4's. */
  bounceRate: number | null;
  avgVisitSeconds: number | null;
  seenAt: string | null;
};

export type UmamiPrevious = Omit<UmamiWindow, "days" | "start" | "end" | "seenAt">;

/** A ranking, never a total: the top twenty of a list Umami truncated. */
export type UmamiTopRow = { name: string; count: number };

export type UmamiWebsite = {
  accountId: number;
  account: string;
  /** The key `venture_links` points at — the Umami website id. */
  entity: string;
  websiteId: string;
  name: string | null;
  domain: string | null;
  seenAt: string | null;
  window: UmamiWindow | null;
  previous: UmamiPrevious | null;
  deltas: {
    pageviews: number | null;
    visitors: number | null;
    visits: number | null;
    bounceRate: number | null;
    avgVisitSeconds: number | null;
  } | null;
  /** Days in the INSTANCE's timezone, which this browser does not know. Never
   *  joined to a UTC day from another integration. */
  days: { day: string; pageviews: number; sessions: number }[];
  top: {
    pages: UmamiTopRow[];
    referrers: UmamiTopRow[];
    events: UmamiTopRow[];
  };
};

export type UmamiPortfolio = {
  websites: number;
  answering: number;
  days: { day: string; pageviews: number; sessions: number }[];
  window: Omit<UmamiWindow, "visitors" | "seenAt">;
  previous: { pageviews: number | null; visits: number | null };
  deltas: { pageviews: number | null; visits: number | null };
  /**
   * THE FIGURE THAT IS NULL ON PURPOSE. Umami de-duplicates visitors per
   * website, so one person who read two sites is one visitor on each and one
   * person in the world; there is no endpoint that would join them. Quoted per
   * site, never summed.
   */
  visitors: {
    combined: null;
    perSite: {
      accountId: number;
      account: string;
      entity: string;
      domain: string | null;
      visitors: number | null;
    }[];
    note: string;
  };
};

export type UmamiReport = {
  websites: UmamiWebsite[];
  portfolio: UmamiPortfolio;
  notes: Record<string, string>;
};

/* --------------------------------------------------------------- calendar */

/** One occurrence. There is no description and no guest list on this wire:
 *  `attendees` is a count and `response` is the owner's own answer. */
export type CalendarEvent = {
  calendarId: string;
  calendar: string;
  eventId: string;
  summary: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  status: string | null;
  location: string | null;
  attendees: number | null;
  organizerSelf: boolean | null;
  response: string | null;
  /** Does it occupy the day: not all-day, not cancelled, not declined. */
  busy: boolean;
  minutes: number | null;
  updated: string | null;
};

/** A day of the window. Busy minutes MERGE overlaps rather than adding them,
 *  and an all-day event contributes none. */
export type CalendarDay = {
  day: string;
  events: CalendarEvent[];
  allDay: CalendarEvent[];
  busyMinutes: number;
  busyHours: number;
};

export type CalendarReport = {
  connected: boolean;
  accounts: {
    id: number;
    label: string;
    connected: boolean;
    lastOkAt: string | null;
    lastError: string | null;
    lastReadAt: string | null;
  }[];
  calendars: {
    accountId: number;
    account: string;
    calendarId: string;
    summary: string | null;
    timezone: string | null;
    primary: boolean;
    /** The owner's own tick in Google. An unticked calendar is not read. */
    selected: boolean;
    accessRole: string | null;
    seenAt: string | null;
  }[];
  today: CalendarDay & { next: CalendarEvent | null };
  days: CalendarDay[];
  summary: {
    window: { from: string; to: string; days: number };
    events: number;
    busyMinutes: number;
    busyHours: number;
    allDayEvents: number;
    declined: number;
    cancelled: number;
    heldBefore: number;
  };
  notes: Record<string, string>;
};

/* ------------------------------------------------------------------- pypi */

/** An ISO week, Monday to Sunday. `partial` is derived from the days actually
 *  held — a partial week must never be drawn beside a complete one. */
export type PypiWeek = {
  week: string;
  start: string;
  downloads: number;
  partial: boolean;
};

export type PypiPackage = {
  package: string;
  entity: string;
  version: string | null;
  summary: string | null;
  homePage: string | null;
  projectUrls: Record<string, string> | null;
  /** The package's own site, code forges skipped — the join to a venture. */
  host: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  historyReadAt: string | null;
  /** pypistats' OWN rolling windows, ending yesterday. Never a calendar week
   *  and never compared with `lastCompleteWeek`. */
  recent: {
    lastDay: number | null;
    lastWeek: number | null;
    lastMonth: number | null;
    at: string | null;
    basis: string;
  };
  weeks: PypiWeek[];
  days: { day: string; downloads: number }[];
  lastCompleteWeek: PypiWeek | null;
  currentWeek: PypiWeek | null;
  last30: number;
  total: number;
  from: string | null;
  to: string | null;
};

export type PypiReport = {
  packages: PypiPackage[];
  weeks: PypiWeek[];
  days: { day: string; downloads: number }[];
  summary: {
    configured: number;
    answering: number;
    failing: number;
    lastCompleteWeek: PypiWeek | null;
    currentWeek: PypiWeek | null;
    last30: number;
    total: number;
    byPackage: Record<string, number>;
    from: string | null;
    to: string | null;
    seenAt: string | null;
  };
  notes: Record<string, string>;
};

/* ---------------------------------------------------------------- bluesky */

/** A window over one page of the author feed. `truncated` true means every
 *  figure on it is a FLOOR. */
export type BlueskyWindow =
  | { days: number; held: false }
  | {
      days: number;
      held: true;
      posts: number;
      likes: number;
      reposts: number;
      replies: number;
      quotes: number;
      perPost: number | null;
      truncated: boolean;
      oldestSeen: string | null;
      seenAt: string | null;
    };

export type BlueskyHandle = {
  handle: string;
  entity: string;
  did: string | null;
  displayName: string | null;
  avatar: string | null;
  profile: {
    followers: number | null;
    follows: number | null;
    posts: number | null;
    seenAt: string | null;
  };
  /** `change` is null on a single reading, which is not a flat line. */
  growth: {
    days: number;
    from: number | null;
    to: number | null;
    change: number | null;
    readings: number;
    note: string | null;
  };
  history: { ts: string; followers: number }[];
  windows: BlueskyWindow[];
  lastOkAt: string | null;
  lastError: string | null;
  lastReadAt: string | null;
};

export type BlueskyReport = {
  handles: BlueskyHandle[];
  portfolio: {
    handles: number;
    answering: number;
    failing: number;
    /** NULL ON PURPOSE: one person following two accounts is one person, and
     *  the public API cannot de-duplicate them. Quoted per handle. */
    followers: {
      combined: null;
      perHandle: Record<string, number | null>;
      note: string;
    };
    /** These DO add — a post belongs to one account, a like to one post — and
     *  `anyTruncated` is what makes the sum quotable. */
    last30: {
      posts: number | null;
      likes: number | null;
      reposts: number | null;
      replies: number | null;
      anyTruncated: boolean;
    };
  };
  notes: Record<string, string>;
};

/* ----------------------------------------------------------------- uptime */

export type UptimeAvailability = {
  hours: number;
  checks: number;
  ok: number;
  failed: number;
  /** Null rather than 100 when nothing was measured. */
  percent: number | null;
  /** False below six checks: a percentage over fewer is a rumour. */
  enough: boolean;
};

export type UptimeIncident = {
  start: string;
  /** The first check that SUCCEEDED again — not the last failure. */
  end: string | null;
  ongoing: boolean;
  checks: number;
  status: number | null;
  error: string | null;
};

export type UptimeHost = {
  host: string;
  url: string;
  current: {
    ts: string;
    ok: boolean;
    status: number | null;
    latencyMs: number | null;
    bytes: number | null;
    finalUrl: string | null;
    error: string | null;
  } | null;
  availability: {
    window: UptimeAvailability;
    day: UptimeAvailability;
    week: UptimeAvailability;
  };
  latency: {
    unit: string;
    basis: string;
    p50: number | null;
    p95: number | null;
    samples: number;
  };
  /** `daysLeft` may be negative — an expired certificate is the most urgent
   *  row a runway can carry. Null is "never read", not "expired". */
  tls: { daysLeft: number | null; measuredAt: string | null; note: string | null };
  redirectsToHttps: boolean | null;
  incidents: UptimeIncident[];
  note: string | null;
};

export type UptimeReport = {
  window: { hours: number; cadence: string; checkedFrom: string };
  hosts: UptimeHost[];
  summary: {
    configured: number;
    up: number;
    down: number;
    /** Configured but never checked. Not "down": nobody has asked yet. */
    unknown: number;
    soonestTlsExpiry: number | null;
    lastCheckedAt: string | null;
  };
};

/* ------------------------------------------------------------------ fleet */

/** used / (used + available), which is what `df` calls Capacity. */
export type FleetMeter = {
  used: number;
  free: number;
  percent: number;
  level: "ok" | "warn" | "critical";
};

export type FleetBox = {
  accountId: number;
  label: string;
  target: string | null;
  hostname: string | null;
  kernel: string | null;
  seenAt: string | null;
  okAt: string | null;
  error: string | null;
  sample: {
    ts: string;
    uptimeSeconds: number | null;
    cpus: number | null;
    load: { one: number | null; five: number | null; fifteen: number | null };
    /** The only load figure comparable between boxes. */
    loadPerCpu: number | null;
    memory: FleetMeter | null;
    memoryTotal: number | null;
    swap: FleetMeter | null;
  } | null;
  disks: {
    mount: string;
    size: number | null;
    used: number | null;
    avail: number | null;
    meter: FleetMeter | null;
  }[];
  containers: {
    name: string;
    image: string | null;
    status: string | null;
    since: string | null;
  }[];
  /** Null means the probe never reached the box; `installed: false` means
   *  docker is not there, which is not "no containers running". */
  docker: { installed: boolean; running: number } | null;
  counters: {
    label: string;
    command: string;
    latest: { ts: string; value: number } | null;
    series: { ts: string; value: number }[];
    /** Said out loud, because no reading looks exactly like a reading of
     *  zero on a chart that draws nothing. */
    note: string | null;
  }[];
  samples: {
    ts: string;
    load1: number | null;
    memUsed: number | null;
    memTotal: number | null;
    swapUsed: number | null;
  }[];
};

export type FleetReport = {
  window: { hours: number; unit: string };
  thresholds: { warn: number; critical: number; basis: string };
  boxes: FleetBox[];
  totals: {
    boxes: number;
    answering: number;
    /** THIS ADDS: a byte of RAM here and a byte there are two bytes paid for. */
    memoryBytes: { total: number; used: number } | null;
    /** THIS DOES NOT. Filesystems share pools, so their sizes are not
     *  addable — read `fullestDisk` and each box's own mounts. */
    diskBytes: { combined: null; note: string };
    containers: number;
    /** NOR THIS. A load average is already relative to a machine's cores. */
    load: { combined: null; note: string; boxesOverOnePerCpu: number };
    fullestDisk: { box: string; mount: string; percent: number | null } | null;
    seenAt: string | null;
  };
};

export type FleetCounters = {
  window: { days: number };
  format: string;
  rule: string;
  counters: {
    label: string;
    command: string;
    boxes: {
      accountId: number;
      label: string;
      latest: { ts: string; value: number } | null;
      series: { ts: string; value: number }[];
    }[];
  }[];
  note: string | null;
};

/* --------------------------------------------------------------- products */

/** One mapped figure. `value` is the path resolved against the LAST document;
 *  `series` is what the collector recorded, so a metric added this morning has
 *  a value and almost no history — honest rather than broken. */
export type ProductMetric = {
  label: string;
  path: string;
  scope: string;
  value: number | null;
  /** Why there is no value. A path that matches nothing is an error with its
   *  reason, and never a zero. */
  error: string | null;
  recorded: { ts: string; value: number } | null;
  series: { ts: string; value: number }[];
};

export type ProductEndpoint = {
  accountId: number;
  label: string;
  url: string | null;
  /** Null is "never collected", which is not "failing". */
  reachable: boolean | null;
  lastFetchedAt: string | null;
  status: number | null;
  ms: number | null;
  truncated: boolean;
  error: string | null;
  documentBytes: number | null;
  keys: string[] | null;
  metrics: ProductMetric[];
};

export type ProductsReport = {
  window: { days: number; of: string };
  endpoints: ProductEndpoint[];
  /** The list the owner acts on: every path that matches nothing. Empty is
   *  the good state. */
  mappingErrors: { endpoint: string; label: string; path: string; why: string }[];
  summary: {
    configured: number;
    reachable: number;
    failing: number;
    neverCollected: number;
    metrics: number;
    /** No total across endpoints, and there cannot be one: two products'
     *  "renders" share a word the owner chose and nothing else. */
    combined: null;
    note: string;
    lastFetchedAt: string | null;
  };
};

/* -------------------------------------------------------------- backlinks */

export type BacklinkSourceId = "verify" | "bing" | "commoncrawl";

/** One source's answer about one host. `ok: false` refused, `ok: null` was
 *  never asked, and a 0 with `ok: true` is a real measurement of nothing. */
export type BacklinkSource = {
  source: BacklinkSourceId;
  label: string;
  confidence: number;
  ok: boolean | null;
  asked: boolean;
  seenAt: string | null;
  referringDomains: number | null;
  backlinks: number | null;
  linkedPages: number | null;
  crawlPages: number | null;
  verified: { checked: number | null; live: number | null; followed: number | null } | null;
  note: string | null;
  error: string | null;
};

export type BacklinkHost = {
  host: string;
  sources: BacklinkSource[];
  /** NEVER SUMMED. The sources overlap and do not agree, and neither is a
   *  census — `combined: null` is a refusal, not a missing value. */
  referringDomains: {
    bySource: Record<string, number | null>;
    combined: null;
    note: string;
  };
  links: {
    source: string;
    fromDomain: string | null;
    fromUrl: string | null;
    toUrl: string | null;
    anchor: string | null;
    /** Three-valued: an index cannot say whether a link is still on the page. */
    live: boolean | null;
    nofollow: boolean | null;
    error: string | null;
    seenAt: string | null;
  }[];
  seenAt: string | null;
  collected: boolean;
};

export type BacklinksReport = {
  hosts: BacklinkHost[];
  confidence: Record<string, number>;
  sourceLabels: Record<string, string>;
  summary: {
    configured: number;
    collected: number;
    /** Hosts no source has answered for yet — a state, not a fault. */
    pending: string[];
    everyHours: number;
    seenAt: string | null;
  };
  notes: string[];
};

/* --------------------------------------------------------------- presence */

/**
 * FOUR STATUSES AND THEY MUST NOT COLLAPSE TO TWO.
 *
 * `present` and `absent` are answers. `blocked` means we could not look — a
 * WAF, a rate limit, a directory with no keyless lookup — and must be read as
 * NOT CHECKED. `error` is the check itself breaking. Null is "never checked".
 */
export type PresenceStatus = "present" | "absent" | "blocked" | "error";

export type PresenceCell = {
  source: string;
  label: string;
  method: string;
  status: PresenceStatus | null;
  url: string | null;
  /** linked · named · page. `named` on an `absent` row is a CANDIDATE for the
   *  owner to judge, not a listing. */
  evidence: string | null;
  note: string | null;
  checkedAt: string | null;
};

export type PresenceProduct = {
  product: string;
  host: string;
  sources: PresenceCell[];
  candidates: { source: string; url: string | null; note: string | null }[];
  summary: {
    present: number;
    absent: number;
    blocked: number;
    errored: number;
    unchecked: number;
    of: number;
  };
  checkedAt: string | null;
};

export type PresenceReport = {
  products: PresenceProduct[];
  sources: { id: string; label: string; method: string }[];
  summary: {
    configured: number;
    checked: number;
    everyHours: number;
    checkedAt: string | null;
  };
  notes: string[];
};

/* ------------------------------------------------------------------ audit */

/**
 * THE PORTFOLIO OVERVIEW, which the per-venture audit route cannot give.
 *
 * `/api/audit/:key` answers with one crawl in full — every page, every finding,
 * every URL behind it. That is the right document for one venture and the wrong
 * one for a board: twelve of them is a megabyte to answer "which site is worst".
 * So the index is one ROW per venture, and the row carries only what a column
 * can hold.
 *
 * A VENTURE THAT HAS NEVER BEEN CRAWLED HAS `ts: null`, and every figure beside
 * it is then meaningless rather than zero. Nothing below counts it as a site
 * with no errors — an unaudited site is unmeasured, which is the one reading a
 * clean-looking dashboard must never give it.
 */
export type AuditVentureRow = {
  id: string;
  name: string;
  slug: string;
  host: string | null;
  /** When this venture was last crawled. Null is NEVER, not "long ago". */
  ts: string | null;
  /** How many pages that crawl actually reached. Every issue count below is
   *  relative to it: three errors over four pages is not three over forty.
   *
   *  NULL RATHER THAN ZERO on a venture nobody has crawled, which is the wire
   *  being careful in the way this file exists to preserve: a nought here
   *  would be a measurement of a site that has never been looked at. */
  pages: number | null;
  /** The audit's own three severities, kept apart. A total across them would
   *  weigh a missing meta description like a broken link. Null for the same
   *  reason `pages` is. */
  issues: { error: number; warning: number; notice: number } | null;
  /** Whether plain http redirected to https when the crawler asked. Null is
   *  "could not be established", never "no". */
  https: boolean | null;
  /** The sitemap the crawler found, or null for none found at any of the
   *  addresses it tried. */
  sitemap: string | null;
  /** Whether robots.txt answered. A MISSING robots.txt IS NOT A CLOSED SITE —
   *  the audit's own note says so — so `false` here is an absence and not a
   *  fault, and no card below colours it red. */
  robots: boolean | null;
  /** WHERE THE SITE ACTUALLY ANSWERED, as a URL and not a hostname —
   *  "https://support.example.test/" — because that is what the crawler followed the
   *  redirects to. Anything comparing it to a venture's `host` has to take the
   *  hostname out of it first; `hostOf` in lib/liveWidgets.ts is that. Null
   *  when nothing answered. */
  canonicalHost: string | null;
};

export type AuditOverview = {
  ventures: AuditVentureRow[];
  note: string;
};

/* ------------------------------------------------------------------- runs */

export type AgentRunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * One piece of long agent work, as the ledger holds it.
 *
 * `AgentRun` and not `RunSummary`, which is what the wire calls it: the Runs
 * app has its own client module for driving a run — starting one, polling it,
 * cancelling it — and two modules exporting one name for two slightly different
 * jobs is an import somebody eventually gets wrong. This shape is the board's:
 * enough to draw a row, and nothing of the output.
 */
export type AgentRun = {
  id: string;
  kind: string;
  ventureId: string | null;
  ventureName: string | null;
  title: string;
  status: AgentRunStatus;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** How long it took. Null while it is still going — a run in flight has a
   *  duration nobody can quote yet, and quoting the elapsed time as `ms` would
   *  make a running row look finished. */
  ms: number | null;
  /** `hermes`, `openclaw`, `provider:<id>` — or null on a run that never got
   *  as far as choosing one. The distinction matters on the card: a report
   *  written by a raw provider had no tools and no web. */
  backend: string | null;
  model: string | null;
  steps: number;
  outputChars: number;
  error: string | null;
};

export type RunKindInfo = {
  kind: string;
  name: string;
  what: string;
  needsVenture: boolean;
  inputs: {
    key: string;
    label: string;
    hint: string;
    kind: "text" | "textarea" | "number";
    required: boolean;
    default: string;
  }[];
  /** Four counts, never added. A failed run wrote no report and a queued one
   *  has not started; only `done` is a piece of work that exists. */
  counts: { done: number; failed: number; running: number; queued: number };
};

export type RunsReport = {
  runs: AgentRun[];
  /** The one run executing right now, because the engine runs one at a time. */
  running: AgentRun | null;
  queued: number;
  kinds: RunKindInfo[];
};

/* ------------------------------------------------------------ competitors */

/**
 * One rival, as the sweeps have accumulated it.
 *
 * THE DATE IS THE WHOLE POINT OF THIS ROW. A profile is not a fact, it is the
 * last thing a sweep was able to establish — so `lastVerified` travels with
 * every one, and a rival the newest sweep did not mention KEEPS ITS OLD DATE
 * rather than being re-stamped. Silence is not verification, and a table that
 * re-dated everything on every run would say the whole market was checked this
 * morning when one company in it was checked in June.
 */
export type CompetitorProfile = {
  ventureId: string;
  /**
   * Whose rival this is. A table of fourteen companies with no venture column
   * is a list nobody can act on, so the name is on every row.
   *
   * THERE IS NO HOST HERE, and that is what makes narrowing this document to a
   * venture board indirect. The scope a board hands its cards is a set of
   * HOSTS; a profile names its venture by id. The audit overview above is a
   * row per venture carrying both — for every venture, crawled or not — so it
   * is the map between them. See `scopeCompetitors` in lib/scope.ts.
   */
  ventureName: string | null;
  name: string;
  url: string | null;
  positioning: string | null;
  pricing: string | null;
  strengths: string[];
  weaknesses: string[];
  /** Null-tolerant on purpose. The column is written on every upsert today, so
   *  the wire never sends a null — and typing it `string` would put a
   *  `new Date(undefined)` and an "Invalid Date" on a card one schema change
   *  from now, for a saving of nothing. */
  lastVerified: string | null;
  firstSeen: string | null;
  runId: string | null;
};

export type CompetitorsReport = {
  profiles: CompetitorProfile[];
  /** How many sweeps have run. One sweep is a first impression; the profiles
   *  are worth what the number of times they have been re-checked is worth. */
  runs: number;
  lastRun: string | null;
};

/* ------------------------------------------------------------------ calls */

export const reports = {
  /** The last 30 complete days per website, plus up to `days` of daily line. */
  umami: (days = 90) => call<UmamiReport>(`/umami?days=${days}`),
  /** Today and the next `days`. The collector holds 7 back and 21 ahead. */
  calendar: (days = 7) => call<CalendarReport>(`/calendar?days=${days}`),
  pypi: () => call<PypiReport>("/pypi"),
  bluesky: (days = 90) => call<BlueskyReport>(`/bluesky?days=${days}`),
  /** Availability is over THIS BOX'S checks, at whatever cadence it managed. */
  uptime: (hours = 24) => call<UptimeReport>(`/uptime?hours=${hours}`),
  fleet: (hours = 24) => call<FleetReport>(`/fleet?hours=${hours}`),
  fleetCounters: (days = 7) => call<FleetCounters>(`/fleet/counters?days=${days}`),
  products: (days = 30) => call<ProductsReport>(`/products?days=${days}`),
  backlinks: () => call<BacklinksReport>("/backlinks"),
  presence: () => call<PresenceReport>("/presence"),

  /*
    THE THREE THAT ARE NOT PLUGINS.

    Everything above is a collector with a credential and a connected/not
    switch behind it. These three are this box's own tables — the crawler it
    runs, the agent runs it executes, the rivals those runs accumulated — so
    there is nothing to connect and nothing to gate the fetch on. They are
    asked for on every load, and an empty answer means the work has not been
    done yet rather than that a provider is missing.
  */
  /** Every venture's last crawl as one row each — never the crawl itself. */
  audit: () => call<AuditOverview>("/audit"),
  /** The ledger, newest first, with what is running and what is waiting. */
  runs: (limit = 50) => call<RunsReport>(`/runs?limit=${limit}`),
  /** Every venture's rivals. The venture filter is the app's, not the board's:
   *  a global board wants the portfolio and a venture board narrows what it
   *  already holds, the way every other source here is narrowed. */
  competitors: () => call<CompetitorsReport>("/competitors"),
};
