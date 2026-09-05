/**
 * THE TEN INTEGRATIONS THE SERVER GREW AFTER lib/api.ts WAS WRITTEN, and the
 * one thing they have in common: every document below was read off the route
 * that answers it rather than imagined from the plugin's name.
 *
 * WHY THE TYPES ARE THIS PEDANTIC ABOUT NULL. Nearly every field here is
 * `number | null`, and the null is load-bearing in each case — it is the
 * server saying it was asked and could not tell. A bounce rate over no visits,
 * a follower count from one reading, a load average from a box that did not
 * answer, an in-degree nobody can measure for free: all of those are null on
 * the wire, and a type that widened them to `number` would be a type that
 * invited a `?? 0` in a panel. Zero is a measurement. Null is not.
 *
 * AND THE FIELDS NAMED `combined: null`. Four of these documents ship one —
 * Umami's visitors, Bluesky's followers, fleet disk, product metrics — each
 * with a `note` saying why the figure cannot be added up. They are typed as
 * `null` exactly, not `number | null`, so a panel that tries to render one has
 * to render the note instead. That is the point of them.
 */
import { call } from "@/lib/api";

/* ------------------------------------------------------------------ umami */

/** One window of Umami's own counting. `visitors` is de-duplicated over the
 *  window, per website, and is the figure that cannot be added across sites. */
export type UmamiWindow = {
  days: number;
  start: string | null;
  end: string | null;
  pageviews: number | null;
  visitors: number | null;
  visits: number | null;
  bounces: number | null;
  totaltime: number | null;
  /** Umami's definition: a visit with one pageview. Not GA4's. */
  bounceRate: number | null;
  avgVisitSeconds: number | null;
  seenAt?: string | null;
};

export type UmamiWebsite = {
  accountId: number;
  account: string;
  /** The key `venture_links` points at. */
  entity: string;
  websiteId: string;
  name: string;
  domain: string | null;
  seenAt: string | null;
  window: UmamiWindow | null;
  previous: Omit<UmamiWindow, "days" | "start" | "end" | "seenAt"> | null;
  deltas: {
    pageviews: number | null;
    visitors: number | null;
    visits: number | null;
    bounceRate: number | null;
    avgVisitSeconds: number | null;
  } | null;
  days: { day: string; pageviews: number; sessions: number }[];
  top: {
    pages: { name: string; count: number }[];
    referrers: { name: string; count: number }[];
    events: { name: string; count: number }[];
  };
};

export type UmamiReport = {
  websites: UmamiWebsite[];
  portfolio: {
    websites: number;
    answering: number;
    days: { day: string; pageviews: number; sessions: number }[];
    window: Omit<UmamiWindow, "visitors" | "seenAt">;
    previous: { pageviews: number | null; visits: number | null };
    deltas: { pageviews: number | null; visits: number | null };
    /** The one that is null on purpose, with the sentence that says why. */
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
  notes: Record<string, string>;
};

/* --------------------------------------------------------------- calendar */

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
  /** A COUNT. No guest is named anywhere on this box. */
  attendees: number | null;
  organizerSelf: boolean | null;
  response: string | null;
  busy: boolean;
  minutes: number | null;
  updated: string | null;
};

export type CalendarDay = {
  day: string;
  events: CalendarEvent[];
  allDay: CalendarEvent[];
  /** Overlapping events are MERGED, never added. */
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

export type PypiWeek = {
  /** ISO week, Monday to Sunday. */
  week: string;
  start: string;
  downloads: number;
  /** True when a day of the week is missing rather than zero — pypistats
   *  rebuilds daily and the last day or two are often absent. A partial week
   *  must not be compared with a complete one. */
  partial: boolean;
};

export type PypiPackage = {
  package: string;
  entity: string;
  version: string | null;
  summary: string | null;
  homePage: string | null;
  projectUrls: Record<string, string> | null;
  host: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  historyReadAt: string | null;
  /** pypistats' OWN rolling windows, ending yesterday — never calendar weeks
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
      /** True means every figure above is a FLOOR, not a total. */
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
  growth: {
    days: number;
    from: number | null;
    to: number | null;
    /** Null on a single reading — which is not a flat line. */
    change: number | null;
    readings: number;
    note: string | null;
  };
  history: { ts: string; followers: number }[];
  windows: BlueskyWindow[];
  lastOkAt: string | null;
  lastError: string | null;
};

export type BlueskyReport = {
  handles: BlueskyHandle[];
  portfolio: {
    handles: number;
    answering: number;
    failing: number;
    followers: {
      combined: null;
      perHandle: Record<string, number | null>;
      note: string;
    };
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
  percent: number | null;
  /** False means the percentage is over too few checks to quote. */
  enough: boolean;
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
  /** Negative days left means the certificate has already expired. */
  tls: { daysLeft: number | null; measuredAt: string | null; note: string | null };
  /** Null means http:// was never asked for, so nothing is known either way. */
  redirectsToHttps: boolean | null;
  incidents: {
    start: string;
    end: string | null;
    ongoing: boolean;
    checks: number;
    status: number | null;
    error: string | null;
  }[];
  note: string | null;
};

export type UptimeReport = {
  window: { hours: number; cadence: string; checkedFrom: string };
  hosts: UptimeHost[];
  summary: {
    configured: number;
    up: number;
    down: number;
    unknown: number;
    soonestTlsExpiry: number | null;
    lastCheckedAt: string | null;
  };
};

/* ------------------------------------------------------------------ fleet */

/** used + free, and the percentage between them. Null when the box did not
 *  answer — never a zeroed meter, which draws as an empty disk. */
export type Meter = {
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
    memory: Meter | null;
    memoryTotal: number | null;
    swap: Meter | null;
  } | null;
  disks: { mount: string; size: number | null; used: number | null; avail: number | null; meter: Meter | null }[];
  containers: { name: string; image: string | null; status: string | null; since: string | null }[];
  /** Null means the probe never reached the box. `installed: false` means
   *  docker is not there, which is not "no containers running". */
  docker: { installed: boolean; running: number } | null;
  counters: {
    label: string;
    command: string;
    latest: { ts: string; value: number } | null;
    series: { ts: string; value: number }[];
    note: string | null;
  }[];
  samples: { ts: string; load1: number | null; memUsed: number | null; memTotal: number | null; swapUsed: number | null }[];
};

export type FleetReport = {
  window: { hours: number; unit: string };
  thresholds: { warn: number; critical: number; basis: string };
  boxes: FleetBox[];
  totals: {
    boxes: number;
    answering: number;
    /** RAM adds: a byte here and a byte there are two bytes being paid for. */
    memoryBytes: { total: number; used: number } | null;
    /** Disk does not add — filesystems share pools. */
    diskBytes: { combined: null; note: string };
    containers: number;
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

export type ProductMetric = {
  label: string;
  path: string;
  /** "all endpoints", or the one endpoint's label. */
  scope: string;
  value: number | null;
  /** Why there is no value. Null when there is one. */
  error: string | null;
  recorded: { ts: string; value: number } | null;
  series: { ts: string; value: number }[];
};

export type ProductEndpoint = {
  accountId: number;
  label: string;
  url: string | null;
  /** Null means it has never been collected — not that it is down. */
  reachable: boolean | null;
  lastFetchedAt: string | null;
  status: number | null;
  ms: number | null;
  truncated: boolean;
  error: string | null;
  documentBytes: number | null;
  /** The document's own top-level keys, so a mapping can be written without
   *  curling the endpoint by hand. */
  keys: string[] | null;
  metrics: ProductMetric[];
};

export type ProductsReport = {
  window: { days: number; of: string };
  endpoints: ProductEndpoint[];
  /** Every path that matched nothing. Empty is the good state. */
  mappingErrors: { endpoint: string; label: string; path: string; why: string }[];
  summary: {
    configured: number;
    reachable: number;
    failing: number;
    neverCollected: number;
    metrics: number;
    combined: null;
    note: string;
    lastFetchedAt: string | null;
  };
};

/* -------------------------------------------------------------- backlinks */

export type BacklinkSourceRow = {
  source: "verify" | "bing" | "commoncrawl" | string;
  label: string;
  confidence: number;
  /** true answered · false refused · null never asked. A 0 with ok:true is a
   *  real measurement of nothing. */
  ok: boolean | null;
  asked: boolean;
  seenAt: string | null;
  referringDomains: number | null;
  backlinks: number | null;
  linkedPages: number | null;
  crawlPages: number | null;
  verified: { checked: number; live: number | null; followed: number | null } | null;
  note: string | null;
  error: string | null;
};

export type BacklinksReport = {
  hosts: {
    host: string;
    sources: BacklinkSourceRow[];
    referringDomains: {
      bySource: Record<string, number | null>;
      /** Never summed. The sources overlap and disagree by design. */
      combined: null;
      note: string;
    };
    links: {
      source: string;
      fromDomain: string;
      fromUrl: string;
      toUrl: string | null;
      anchor: string | null;
      /** Three-valued from the crawler, null from an index: an index cannot
       *  say whether a link is still on the page. */
      live: boolean | null;
      nofollow: boolean | null;
      error: string | null;
      seenAt: string | null;
    }[];
    seenAt: string | null;
    collected: boolean;
  }[];
  confidence: Record<string, number>;
  sourceLabels: Record<string, string>;
  summary: {
    configured: number;
    collected: number;
    pending: string[];
    everyHours: number;
    seenAt: string | null;
  };
  notes: string[];
};

/* --------------------------------------------------------------- presence */

export type PresenceStatus = "present" | "absent" | "blocked" | "error";

export type PresenceReport = {
  products: {
    product: string;
    host: string;
    sources: {
      source: string;
      label: string;
      method: string;
      /** `blocked` IS NOT `absent` — it means the source could not be asked. */
      status: PresenceStatus;
      url: string | null;
      evidence: string | null;
      note: string | null;
      checkedAt: string | null;
    }[];
    /** Named the brand but did not point back at the host. The owner judges. */
    candidates: { source: string; url: string; note: string }[];
    summary: {
      present: number;
      absent: number;
      blocked: number;
      errored: number;
      unchecked: number;
      of: number;
    };
    checkedAt: string | null;
  }[];
  sources: { id: string; label: string; method: string }[];
  summary: { configured: number; checked: number; everyHours: number; checkedAt: string | null };
  notes: string[];
};

/* ------------------------------------------------------------------ voice */

export type VoiceReport = {
  /** An endpoint is SET. Whether it answers is what the probe says. */
  connected: boolean;
  state: {
    stt: { url: string | null; model: string; keyed: boolean; configured: boolean };
    tts: {
      mode: "off" | "openai" | "piper" | string;
      url: string | null;
      model: string;
      voice: string;
      keyed: boolean;
      ready: boolean;
      why: string | null;
    };
    /** The path ffmpeg was found at, or null — no voice note without it. */
    ffmpeg: string | null;
    replyWithVoice: boolean;
  };
  latency: {
    unit: string;
    transcriptionMedian: number | null;
    lastAt: string | null;
    lastMs: number | null;
  };
  counts: { kind: string; ok: number; failed: number; medianMs: number | null }[];
  runs: { ts: string; kind: string; ms: number | null; bytes: number | null; ok: boolean; error: string | null }[];
  notes: string[];
};

/** What `POST /api/voice/speak` answers. Never audio — a path and a url. */
export type SpokenClip = {
  id: string;
  path: string;
  url: string;
  format: "mp3" | "wav" | "ogg" | string;
  bytes: number;
  ms: number;
  via: string;
};

/* ---------------------------------------------------------- venture links */

/**
 * Everything linked to everything, in one document.
 *
 * `edges[].venture` is the venture's ID (`v-example-app-1`), not its slug — the
 * ventures array carries both, and the slug is what a link to its page needs.
 * `present: false` is an edge whose entity is not in the current entity list:
 * a collector that has not run, or an integration between credentials. It is
 * a real link to a temporarily unlisted thing, not a broken one.
 */
export type VentureMap = {
  ventures: {
    id: string;
    name: string;
    slug: string;
    color: string;
    stage: string;
    host: string | null;
  }[];
  plugins: { id: string; connected: boolean; entities: number }[];
  entities: { plugin: string; entity: string; label: string; host: string | null }[];
  edges: {
    venture: string;
    plugin: string;
    entity: string;
    label: string | null;
    /** `auto` was accepted in bulk; `owner` was linked one at a time. */
    source: "auto" | "owner" | string;
    present: boolean;
  }[];
  unlinked: { plugin: string; entity: string; label: string }[];
  sources: { plugin: string; ok: boolean; entities: number; note: string | null }[];
  note: string;
};

/* ------------------------------------------------------------------ calls */

export const integrations = {
  /** Websites with their own windows, the portfolio, and `visitors.combined:
   *  null` with the sentence that refuses to add them up. */
  umami: (days = 30) => call<UmamiReport>(`/umami?days=${days}`),

  /** Today plus the next `days`. No description and no attendee name is
   *  stored anywhere behind this. */
  calendar: (days = 7) => call<CalendarReport>(`/calendar?days=${days}`),

  pypi: () => call<PypiReport>("/pypi"),

  bluesky: (days = 30) => call<BlueskyReport>(`/bluesky?days=${days}`),

  uptime: (hours = 24) => call<UptimeReport>(`/uptime?hours=${hours}`),

  fleet: (hours = 24) => call<FleetReport>(`/fleet?hours=${hours}`),

  /** The same numbers cut by counter rather than by box. */
  fleetCounters: (days = 7) => call<FleetCounters>(`/fleet/counters?days=${days}`),

  products: (days = 7) => call<ProductsReport>(`/products?days=${days}`),

  backlinks: () => call<BacklinksReport>("/backlinks"),

  presence: () => call<PresenceReport>("/presence"),

  voice: () => call<VoiceReport>("/voice"),

  /** Text in, a clip on this machine out. Refused with a sentence — 409 —
   *  when speech is off, which is the default. */
  speak: (text: string) =>
    call<SpokenClip>("/voice/speak", { method: "POST", body: JSON.stringify({ text }) }),

  /** Every venture, every entity and every edge between them. */
  ventureMap: () => call<VentureMap>("/venture-links/map"),

  /** Link one entity to one venture, by hand. The key is a slug or an id. */
  linkVenture: (ventureKey: string, plugin: string, entity: string, label?: string) =>
    call<{ ok: true }>(`/venture-links/${encodeURIComponent(ventureKey)}`, {
      method: "POST",
      body: JSON.stringify({ plugin, entity, ...(label ? { label } : {}) }),
    }),

  /** Remove one. The entity may contain slashes — the route matches the rest
   *  of the path — so it is encoded whole. */
  unlinkVenture: (ventureKey: string, plugin: string, entity: string) =>
    call<{ ok: true }>(
      `/venture-links/${encodeURIComponent(ventureKey)}/${encodeURIComponent(plugin)}/${encodeURIComponent(entity)}`,
      { method: "DELETE" },
    ),
};
