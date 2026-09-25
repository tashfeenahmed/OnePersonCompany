import type { BusinessType } from "../../../shared/ventureJourney";
/**
 * The API client.
 *
 * Everything that needs a credential happens on the server: it holds the vault
 * key, it makes the outbound call, and it is the only thing that ever sees a
 * token. This file therefore has no notion of a secret value — it posts one
 * up and never reads one back, which is the same one-way door the server's
 * routes enforce from their side.
 */

/** Where every call in this file goes. EXPORTED because a second module now
 *  opens a stream of its own (`lib/chatRuns.ts` reattaches to a chat run) and
 *  two spellings of the prefix would be two contracts with one server. */
export const BASE = "/api";

/* The run vocabulary is the repo-root `shared/runStatus.ts`'s, on both ends of
   the wire. See that file for why `cancelling` is not one of the five. */
import type { Cancelling, RunStatus } from "../../../shared/runStatus";

export class ApiError extends Error {
  status: number;
  fieldErrors: Record<string, string>;
  constructor(status: number, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

/**
 * ONE REDIRECT, EVER.
 *
 * The dashboard fires a dozen requests when a page opens, and a session that
 * has just been revoked answers 401 to all of them. Twelve calls to
 * `location.replace` is a browser fighting itself, and the `next` that survives
 * is whichever raced last. So the first 401 wins and the rest are ordinary
 * errors the pages already know how to draw.
 */
let redirecting = false;

function goToLogin() {
  if (redirecting) return;
  if (window.location.pathname === "/login") return;
  redirecting = true;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.replace(`/login?next=${encodeURIComponent(next)}`);
}

/** Read-only POST endpoints can opt out of the data-changed broadcast. */
export async function call<T>(path: string, init?: RequestInit, options?: { notifyChange?: boolean }): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    /* 401 IS THE ONE STATUS THIS FILE ACTS ON RATHER THAN REPORTS. It can only
       come from the owner gate — no route here answers 401 for anything else —
       and it means a password was set, or this browser's session was revoked.
       The error is still thrown, so a caller that is already on /login (the
       login form itself) shows the message rather than a blank screen. */
    if (res.status === 401) goToLogin();
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    const rawFields = body && typeof body === 'object' && 'fieldErrors' in body ? body.fieldErrors : null;
    const fieldErrors = rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields)
      ? Object.fromEntries(Object.entries(rawFields).filter(([,v]) => typeof v === 'string')) as Record<string,string> : {};
    throw new ApiError(res.status, message, fieldErrors);
  }
  if (options?.notifyChange !== false && init?.method && !["GET", "HEAD"].includes(init.method) && path !== "/workspace") window.dispatchEvent(new Event("opc:data-changed"));
  return body as T;
}

/* --------------------------------------------------------------- types */

export type RunInfo = {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  note: string | null;
  error: string | null;
};

/**
 * One account of one plugin.
 *
 * A plugin holds a LIST of these because a credential is often scoped to less
 * than a person owns: a Hetzner token covers one project, a registrar key
 * covers one login. Each carries its own connection state and its own last
 * error, which is the point — one dead token should say which one.
 *
 * `secrets` is entry names, fields and dates. There is no value on this type
 * because there is no route that returns one.
 */
export type PluginAccount = {
  id: number;
  label: string;
  connected: boolean;
  createdAt: string;
  /** When the credential last CHANGED — not when it last worked. */
  updatedAt: string;
  /** When this account last answered its provider. Null means it never has
   *  since it was stored, which is not the same as failing. */
  lastOkAt: string | null;
  lastError: string | null;
  secrets: { name: string; field: string; updatedAt: string }[];
};

export type ServerPlugin = {
  id: string;
  /** True when ANY account is connected. */
  connected: boolean;
  updatedAt: string | null;
  lastError: string | null;
  /** Entry names and timestamps across every account. Never values — there is
   *  no route for those. */
  secrets: { name: string; updatedAt: string }[];
  accounts: PluginAccount[];
  collectable: boolean;
  /**
   * Whether the server has a credential door for this plugin at all — which is
   * NOT the same question as `collectable`, and used to be answered by it.
   *
   * Every plugin that could hold a credential also had a collector, so the
   * page took "has a collector" for "is wired to the API". The local-models
   * plugin breaks that: it holds endpoints and there is nothing to collect
   * FROM a model server — a completion is its own health check and happens
   * when somebody asks a question, not on a timer.
   */
  configurable: boolean;
  runs: RunInfo[];
};

export type CollectSummary = {
  ok: boolean;
  servers: number;
  volumes: number;
  monthlyEur: number;
  /** One line per account that was tried, so "it worked" and "it worked for
   *  two of three" are different answers rather than the same one. */
  accounts?: { id: number; label: string; ok: boolean; error?: string }[];
  warnings: string[];
  error?: string;
};

export type HetznerSummary = {
  servers: number;
  running: number;
  volumes: number;
  monthlyEur: number;
  serverMonthlyEur: number;
  volumeMonthlyEur: number;
  byLocation: Record<string, number>;
  /** What the totals above are totals OF. One entry is one account; more than
   *  one means every figure on the fleet page is a sum, and the page says so
   *  rather than letting two projects read as one. */
  accounts: {
    id: number | null;
    label: string;
    servers: number;
    volumes: number;
    monthlyEur: number;
  }[];
  seenAt: string | null;
};

export type HetznerServer = {
  id: number;
  /** The account this box was read through. Null on a row collected before
   *  accounts existed, which lasts exactly one collection. */
  accountId: number | null;
  accountLabel: string;
  name: string | null;
  ipv4: string | null;
  status: string | null;
  plan: string | null;
  specs: string | null;
  location: string | null;
  monthlyEur: number | null;
  ipv4MonthlyEur: number | null;
  createdAt: string | null;
};

/**
 * Three numbers about one metric over the window: the newest sample, the
 * average across it and the highest it reached. Null all through when the box
 * has no samples in the window — a machine created this morning has a bill and
 * a plan and no history, and that is not a zero.
 */
export type LoadStat = {
  now: number | null;
  mean: number | null;
  peak: number | null;
};

export type LoadPoint = { ts: string; value: number };

export type ServerLoad = {
  id: number;
  name: string | null;
  status: string | null;
  plan: string | null;
  location: string | null;
  /** vCPUs, or null when the fleet listing did not say. */
  cores: number | null;
  /** False when cores were unknown, so the CPU figures are Hetzner's raw
   *  per-core sum and can exceed 100. See the load route. */
  cpuScaled: boolean;
  monthlyEur: number;
  /** Percent of the whole box, 0–100. The only per-server series sent whole. */
  cpu: LoadStat & { points: LoadPoint[] };
  /** Bytes per second. */
  netIn: LoadStat;
  netOut: LoadStat;
  diskRead: LoadStat;
  diskWrite: LoadStat;
  samples: number;
};

export type HetznerLoad = {
  hours: number;
  servers: ServerLoad[];
  fleet: {
    /** Mean percent across the boxes reporting at each moment. */
    cpu: LoadPoint[];
    /** Bytes per second, summed across the fleet. */
    netIn: LoadPoint[];
    netOut: LoadPoint[];
    diskWrite: LoadPoint[];
  };
  seenAt: string | null;
  /** The newest sample in the window — which is NOT when the fleet was listed.
   *  Hetzner's metrics lag their own clock; "collected 2m ago" and "sampled 9m
   *  ago" are two true statements about the same collection. */
  sampledAt: string | null;
};

export type HetznerVolume = {
  id: number;
  accountId: number | null;
  accountLabel: string;
  name: string | null;
  sizeGb: number | null;
  location: string | null;
  serverId: number | null;
  /** The server's NAME, resolved server-side — a volume id explains nothing. */
  attachedTo: string | null;
  monthlyEur: number | null;
};

/* --------------------------------------------------------------- domains */

export type Domain = {
  name: string;
  /** The plugin that read it: "dynadot" | "spaceship". */
  source: string;
  /** WHICH LOGIN it was read through. A portfolio can span two accounts at one
   *  registrar, and "where do I go to renew this" is a question only the
   *  account answers. */
  accountId: number;
  account: string;
  registrar: string;
  expiresAt: string | null;
  /**
   * Whole days from today, computed server-side on every read and never
   * stored. Negative means the date has already passed. Null means the
   * registrar did not report a date — not that the name is safe.
   */
  expiresInDays: number | null;
  registeredOn: string | null;
  /** null is "asked and not told", which is not the same as false. */
  autoRenew: boolean | null;
  locked: boolean | null;
  status: string | null;
  /** One lowercase word. "off" is the only value drawn as a warning. */
  privacy: string | null;
  nameservers: string[] | null;
  seenAt: string;
};

export type DomainSummary = {
  total: number;
  byRegistrar: Record<string, number>;
  /** Keyed "Registrar · Account", because two logins at one registrar are two
   *  answers to "where is this name". */
  byAccount: Record<string, number>;
  /** How many accounts the portfolio is the sum of. */
  accounts: number;
  byTld: Record<string, number>;
  /** Already past their date. Counted here and in none of the windows below. */
  lapsed: number;
  expiring7: number;
  expiring30: number;
  expiring90: number;
  autoRenewOff: number;
  autoRenewUnknown: number;
  unlocked: number;
  lockUnknown: number;
  privacyOff: number;
  withoutExpiry: number;
  soonest: { name: string; days: number } | null;
  thresholds: { crit: number; warn: number };
  seenAt: string | null;
};

/* ----------------------------------------------------------------- stock */

/**
 * A stock library's remaining request allowance.
 *
 * Every field is nullable because a header that is absent is not a zero. These
 * two services report nothing else about themselves — no usage history, no
 * spend — so the shape is deliberately small and the `cannot` list travels with
 * it to say why.
 */
export type StockAccount = {
  accountId: number | null;
  label: string | null;
  limit: number | null;
  remaining: number | null;
  used: number | null;
  /** Share of the allowance already spent, 0–100. */
  usedPct: number | null;
  resetsAt: string | null;
  /** Requests a day, measured across the window rather than between the last
   *  two samples, and null until the window is long enough to mean anything. */
  perDay: number | null;
  daysLeft: number | null;
  readings: number;
  seenAt: string | null;
  points: { ts: string; value: number }[];
};

export type StockLibrary = {
  library: string;
  name: string;
  connected: boolean;
  accounts: StockAccount[];
  /** What this service will not tell you, as a property of the service. */
  cannot: string[];
};

export type StockReport = {
  window: { days: number };
  libraries: StockLibrary[];
  note: string;
  generatedAt: string;
};


/* ---------------------------------------------------------------- mobile */

/**
 * The two app stores, in one document.
 *
 * THE SHAPE IS THE ARGUMENT. Each store carries an `estimated` block and a
 * `payout` block, and they are different measurements of different things:
 * Apple's estimated developer proceeds and Google's charged amounts are
 * previews, while Apple's finance report and Google's earnings export are the
 * money that lands. There is no field on this type into which one could be
 * added to the other, and only the payout blocks may be called revenue.
 *
 * Every money figure is PER CURRENCY, because both stores report per currency
 * and nothing here fetches an exchange rate. `currency.combined` is null and
 * says why.
 */
export type Money = { currency: string; amount: number };

export type AppStoreApp = {
  id: string;
  account: string;
  name: string | null;
  bundleId: string | null;
  /** Apple's own version state — READY_FOR_DISTRIBUTION, WAITING_FOR_REVIEW… */
  state: string | null;
  version: string | null;
  /** Null is "the version listing could not be read", never "not live". */
  onStore: boolean | null;
  /** Null with a zero count is "nobody has rated it" — not zero stars. */
  rating: number | null;
  ratingCount: number | null;
  storefront: string | null;
  listed: boolean | null;
  releasedAt: string | null;
  downloads: number;
  updates: number;
  inAppUnits: number;
  estimatedProceeds: Money[];
};

export type MobileReport = {
  window: { days: number; from: string; to: string };
  currency: { seen: string[]; combined: null; note: string };
  estimateVsPayout: string;
  appstore: {
    connected: boolean;
    accounts: number;
    seenAt: string | null;
    /** The identifiers the collector actually sent. Not secrets: they are
     *  printed in Apple's console, and a wrong vendor number is the one
     *  failure here that leaves a board empty with nothing to explain it. */
    identity: {
      accountId: number;
      label: string;
      keyId: string | null;
      issuerId: string | null;
      vendor: string | null;
      apps: number;
    }[];
    apps: AppStoreApp[];
    store: { total: number; live: number; notLive: number; unknown: number };
    downloads: {
      units: number;
      updates: number;
      inAppUnits: number;
      days: { day: string; downloads: number }[];
      daysReported: number;
      daysZero: number;
      /** Days Apple has not generated yet. Left out of `days` rather than
       *  drawn as zero. */
      daysAbsent: number;
      from: string | null;
      to: string | null;
    };
    estimated: { currencies: Money[]; months: { month: string; currencies: Money[] }[]; note: string };
    payout: {
      currencies: Money[];
      months: { month: string; currencies: Money[] }[];
      monthsAsked: number;
      monthsReported: number;
      /** Months Apple issued no report for. NOT months that earned nothing —
       *  the API cannot tell those apart. */
      monthsNone: string[];
      note: string;
    };
    rating: {
      average: number | null;
      ratings: number;
      apps: number;
      storefronts: (string | null)[];
      source: string;
    };
    cannot: { asked: string; answer: string }[];
  };
  play: {
    connected: boolean;
    accounts: number;
    seenAt: string | null;
    identity: {
      accountId: number;
      label: string;
      bucket: string | null;
      serviceAccount: string | null;
      packages: number;
    }[];
    packages: {
      package: string;
      installs: number;
      uninstalls: number;
      /** A current state, never summed over days: it is how many devices have
       *  the app today. */
      activeDevices: number | null;
      activeAt: string | null;
      rating: number | null;
      ratingAt: string | null;
      payout: Money[];
    }[];
    installs: {
      installs: number;
      uninstalls: number;
      days: { day: string; installs: number }[];
      daysReported: number;
      from: string | null;
      to: string | null;
      activeDevices: number;
    };
    rating: { average: number | null; packages: number; at: string | null; note: string };
    payout: {
      currencies: Money[];
      months: {
        month: string;
        currencies: {
          currency: string;
          charged: number;
          refunds: number;
          /** Google's cut, from its own fee rows — never a percentage. */
          fees: number;
          net: number;
          transactions: number;
        }[];
      }[];
      latestMonth: string | null;
      note: string;
    };
    estimated: {
      months: { month: string; settled: boolean; currencies: Money[]; orders: number; refunds: number }[];
      /** Months with orders and no payout yet — Google writes the earnings
       *  export only once a month has closed. */
      running: string[];
      note: string;
    };
    cannot: { asked: string; answer: string }[];
  };
  generatedAt: string;
};

/* --------------------------------------------------------------- calls */

/* ---------------------------------------------------------------- github */

/**
 * One repo, as of the last collection.
 *
 * `traffic` is null when GitHub was never asked about this repo — it lost the
 * ranking against the cap, or the token cannot push to it, which is what the
 * traffic endpoints require. It never means nobody visited: a repo with no
 * visitors and a repo we are not allowed to ask about are different findings,
 * and only one of them is about the repo.
 */
export type GithubRepo = {
  fullName: string;
  owner: string;
  name: string;
  org: boolean;
  private: boolean;
  fork: boolean;
  archived: boolean;
  accountId: number;
  account: string;
  stars: number;
  forks: number;
  /** GitHub's `open_issues_count`, WHICH COUNTS OPEN PULL REQUESTS TOO.
   *  Nothing in the payload separates them without a call per repo. */
  openIssues: number;
  watchers: number;
  language: string | null;
  homepage: string | null;
  defaultBranch: string | null;
  pushedAt: string | null;
  createdAt: string | null;
  traffic: {
    days: number;
    views: number | null;
    /** GitHub's own de-duplicated count for the whole window — NOT the sum of
     *  the daily uniques, which counts a returning visitor twice. */
    uniques: number | null;
    clones: number | null;
    cloneUniques: number | null;
    /** Which of the four traffic calls refused, and why. */
    note: string | null;
    seenAt: string;
    /** True when this window stopped being refreshed — the repo dropped out of
     *  the traffic selection, so its fortnight is not the current one. Kept on
     *  the row and left out of every total and every line. */
    stale: boolean;
  } | null;
  referrers: { name: string; title: string | null; count: number; uniques: number }[];
  paths: { name: string; title: string | null; count: number; uniques: number }[];
};

/**
 * One day of traffic, summed across every repo.
 *
 * `partial` is the day in progress. GitHub's aggregation lags its own clock —
 * today's bucket can still read zero at six in the evening — so the flag is
 * what keeps a line from ending in a cliff that is not there.
 */
export type GithubDay = {
  day: string;
  views: number;
  /** Per-day, per-repo unique visitors ADDED. Not comparable with the window
   *  figure, and never presented as "people". */
  uniques: number;
  clones: number;
  cloneUniques: number;
  /** How many repos are in this day's figure. Repos do not all report the same
   *  fourteen days, and a day fewer of them cover is not comparable with the
   *  days beside it. */
  repos: number;
  partial: boolean;
};

export type GithubRate = {
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  /** True when the hour the figure describes has already ended, so the number
   *  beside it describes a budget that has since refilled. */
  expired: boolean;
  /** What the last run spent. */
  requests: number | null;
  checkedAt: string | null;
};

export type GithubAccount = {
  id: number;
  label: string;
  login: string | null;
  name: string | null;
  followers: number | null;
  publicRepos: number | null;
  connected: boolean;
  lastError: string | null;
  lastOkAt: string | null;
  rate: GithubRate;
  trafficAt: string | null;
};

export type GithubSummary = {
  repos: number;
  public: number;
  private: number;
  forks: number;
  archived: number;
  stars: number;
  forkCount: number;
  /** Issues AND open pull requests, summed. */
  openIssues: number;
  byLanguage: Record<string, number>;
  /** How many repos have CURRENT traffic, how many hold a window that has
   *  stopped being refreshed, and the cap that decides which get asked. */
  trafficRepos: number;
  trafficStale: number;
  trafficCap: number;
  trafficDays: number;
  views: number;
  /** Per-repo uniques added together. A person who looked at two repos is in
   *  here twice; GitHub offers no cross-repo de-duplication at all. */
  uniquesSummed: number;
  clones: number;
  cloneUniquesSummed: number;
  topReferrers: { name: string; count: number; uniques: number }[];
  topPaths: {
    repo: string;
    path: string;
    title: string | null;
    count: number;
    uniques: number;
  }[];
  mostViewed: { fullName: string; views: number | null } | null;
  accounts: GithubAccount[];
  rate: GithubRate | null;
  /** The orgs the owner asked for. Empty means none were walked — a setting,
   *  not a silence. */
  orgs: string[];
  /** Two dates, because the repo facts and the traffic are collected on two
   *  cadences and one date would be wrong for half the page. */
  seenAt: string | null;
  trafficSeenAt: string | null;
  chartFrom: string;
  chartTo: string;
};

export type Github = {
  repos: GithubRepo[];
  daily: GithubDay[];
  summary: GithubSummary;
};

/* ------------------------------------------------------------------- npm */

/** One ISO week, Monday to Sunday. `partial` is the week in progress, a
 *  history that starts mid-week, or a week with a day missing — never drawn
 *  beside complete weeks without saying so. */
export type NpmWeek = {
  week: string;
  start: string;
  downloads: number;
  partial: boolean;
};

export type NpmPackage = {
  package: string;
  endpoint: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  lastError: string | null;
  lastOkAt: string | null;
  weeks: NpmWeek[];
  days: { day: string; downloads: number }[];
  lastCompleteWeek: NpmWeek | null;
  currentWeek: NpmWeek | null;
  total: number;
};

/**
 * DOWNLOADS, NEVER INSTALLS. npm counts HTTP tarball fetches: a CI job, a
 * Docker rebuild, a mirror and a person are one each and npm cannot tell them
 * apart. Every field here is named for what it is, and so is every card that
 * draws one.
 */
export type Npm = {
  packages: NpmPackage[];
  weeks: NpmWeek[];
  days: { day: string; downloads: number }[];
  summary: {
    configured: number;
    answering: number;
    failing: number;
    lastCompleteWeek: NpmWeek | null;
    currentWeek: NpmWeek | null;
    last30: number;
    total: number;
    byPackage: Record<string, number>;
    counts: string;
    from: string | null;
    to: string | null;
    seenAt: string | null;
  };
};

/** A plugin's non-secret settings — npm's package list, GitHub's orgs. Values
 *  come BACK from this one, which is the whole difference between it and the
 *  vault: a list you maintain by hand has to be readable to be corrected. */
export type PluginConfig = {
  id: string;
  config: Record<string, string>;
  keys: {
    key: string;
    label: string;
    hint: string;
    ph: string | null;
    value: string;
  }[];
};

/* ----------------------------------------------------------------- costs */

/**
 * What the LLM and media habit costs, from the three providers that answer
 * about it — and the shape of the answer is different for each, because the
 * three APIs are not the same API.
 *
 * NOTHING HERE IS ADDED ACROSS CURRENCIES. Every figure on this type is US
 * dollars; Hetzner's euro lives on `HetznerSummary` and the two are never
 * summed. `currency.combined` is null and carries the sentence saying why,
 * which is what the side-by-side card on the Costs board reads out.
 */
export type CostDay = { day: string; usd: number };

export type CostsReport = {
  window: { days: number; from: string; to: string };
  generatedAt: string;
  currency: {
    usd: string[];
    eur: string[];
    /** Always null. A total across two currencies needs a dated rate this
     *  box does not fetch, and a card must say so rather than show one. */
    combined: null;
    note: string;
  };
  openai: {
    connected: boolean;
    /** Null is "asked and not told" — never collected. Zero is a real, free
     *  month, and the two must not read as each other. */
    usd: number | null;
    currency: "usd";
    days: CostDay[];
    /** The only breakdown the Costs API offers. It has no per-model cut. */
    projects: { id: string; name: string; usd: number }[];
    accounts: number;
    /** The newest day whose bucket is complete; today's always lags. */
    completeThrough: string;
    lag: string;
    noModelSplit: string;
    seenAt: string | null;
  };
  openrouter: {
    connected: boolean;
    currency: "usd";
    /** The account's ledger. `spentLifetime` is every key that ever existed —
     *  which is why it exceeds both other totals on this object. */
    credits: {
      purchased: number;
      spentLifetime: number;
      balance: number;
      accounts: number;
      seenAt: string | null;
    } | null;
    /** Cut one: per day per model. Carries no key, because the API has no
     *  per-day-per-key figure to carry. */
    activity: {
      usd: number | null;
      /** Routed to the owner's own provider keys and billed elsewhere. Never
       *  added to `usd`. */
      byokUsd: number;
      requests: number;
      promptTokens: number;
      completionTokens: number;
      dayCount: number;
      /* Per day: the bill, the calls, and the tokens behind them. */
      days: (CostDay & { requests: number; promptTokens: number; completionTokens: number })[];
      models: {
        model: string;
        usd: number;
        byokUsd: number;
        requests: number;
        promptTokens: number;
        completionTokens: number;
      }[];
      seenAt: string | null;
    };
    /** Cut two: per key, and only the keys that still exist. */
    keys: {
      total: number;
      count: number;
      list: {
        name: string;
        account: string;
        usd: number;
        usdMonth: number;
        usdWeek: number;
        usdDay: number;
        disabled: boolean;
        createdAt: string | null;
        /** Null is "no cap", not a cap of nothing. */
        spendLimit: number | null;
        limitRemaining: number | null;
      }[];
      seenAt: string | null;
    };
    totalsDiffer: string;
    noJoin: string;
    accounts: number;
  };
  replicate: {
    connected: boolean;
    /** ALWAYS NULL. Replicate publishes no billing endpoint, a prediction
     *  carries no hardware or price, and half of what runs here is billed per
     *  output rather than per second. `cannot` says what was asked. */
    cost: null;
    /** What was asked of the API about money, and what came back. The
     *  exchange rather than the conclusion, so a card can show the evidence. */
    cannot: {
      checkedOn: string;
      asked: readonly { asked: string; answer: string }[];
    };
    runs: number;
    failed: number;
    succeeded: number;
    /** Seconds of prediction time — what Replicate measures. The RATE is not
     *  knowable from this API, so no money follows from it. */
    predictSeconds: number;
    /** Predictions that reported no time at all: still running, or never ran.
     *  Counted apart rather than added as zero seconds. */
    unreported: number;
    outputs: { images: number; videoSeconds: number; tokens: number };
    days: { day: string; runs: number; seconds: number }[];
    models: {
      model: string;
      runs: number;
      failed: number;
      seconds: number;
      images: number;
      videoSeconds: number;
      tokens: number;
    }[];
    accounts: number;
    seenAt: string | null;
  };
};



/**
 * STRIPE — what came in, and what is contracted to keep coming in.
 *
 * Every money field is a LIST keyed by currency, even where the account has
 * only ever billed in one. A shape that can hold a single number is a shape
 * that will silently add two the day a second currency appears, and this is
 * the file where that would be hardest to notice.
 */
export type StripeMoney = { currency: string; amount: number };

export type StripeCharge = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  paid: boolean;
  refunded: boolean;
  createdAt: string;
  description: string | null;
  /** Already masked — "t***@gmail.com" — and never anything fuller. */
  email: string | null;
  failure: string | null;
  failureCode: string | null;
  outcomeType: string | null;
};

export type StripeReport = {
  window: { days: number };
  connected: boolean;
  accounts: {
    id: number;
    label: string;
    connected: boolean;
    lastOkAt: string | null;
    lastError: string | null;
  }[];
  /** Null is "asked and not told": nothing collected, ever. An account that
   *  collected fine and holds no subscriptions is an empty book, and that is
   *  a zero. */
  mrr:
    | {
        currency: string;
        amount: number;
        /** MRR annualised — the same contracted revenue over twelve months. */
        arr: number;
        subscriptions: number;
        /** How much of the figure is annual money spread across the year. The
         *  normalisation is a choice, so the split it rests on travels with
         *  it rather than living in a comment. */
        byInterval: Record<
          "monthly" | "annual" | "other",
          { subscriptions: number; amount: number }
        >;
        /** List price not invoiced because of a recurring coupon. Already OUT
         *  of `amount`: this says how much came off, not how much more. */
        discountedAway: number;
        discounted: number;
        /** The sentence a card prints under the figure. */
        basis: string;
      }[]
    | null;
  subscriptions: {
    /** What MRR is built from. Not "live" — a trial is live and is not money. */
    billing: number;
    trialing: number;
    /** Billing and FAILING. Out of MRR and counted here, because it is the
     *  one of these somebody can act on today. */
    pastDue: number;
    canceled: number;
    /** A checkout that expired before its first payment ever succeeded. Never
     *  a customer, and never churn. */
    incompleteExpired: number;
    total: number;
    pendingCancellation: {
      count: number;
      mrr: StripeMoney[];
      endingSoon: { days: number; count: number; mrr: StripeMoney[] };
      note: string;
    };
    /** Cancellations whose invoices have not been checked yet. They count as
     *  real churn until they have been. */
    unresolvedCancellations: number;
  };
  /** MRR on past-due subscriptions: still contracted, failing to collect.
   *  The preventable half of future churn — the customer exists and the card
   *  just needs fixing. Never added to MRR or to pendingCancellation. */
  atRisk: {
    subscriptions: number;
    mrr: StripeMoney[];
    note: string;
  };
  /** One row per window per currency. `ratePct` is REVENUE churn over a
   *  reconstructed starting book — `basis` says exactly which, because a rate
   *  quoted without its denominator is not a measurement. */
  churn: {
    days: number;
    currency: string;
    mrr: number;
    newMrr: number;
    newSubs: number;
    churnedMrr: number;
    churnedSubs: number;
    netMrr: number;
    ratePct: number | null;
    /** The rate's ACTUAL numerator: the part of `churnedMrr` that was in the
     *  book when the window opened. A subscription that started and ended
     *  inside the window is in neither this nor the denominator. */
    churnedFromStartMrr: number;
    churnedFromStartSubs: number;
    startBookMrr: number;
    /** The SaaS quick ratio for the window: MRR gained over MRR lost
     *  (ChartMogul, Baremetrics), NEW-VERSUS-CHURNED ONLY — upgrades and
     *  downgrades leave no trace on the subscription and are not in it.
     *  4+ is the usual healthy line, under 1 the book is shrinking. A
     *  subscription that started and ended in the window is on both sides.
     *  null when nothing churned (x/0 is not a ratio). */
    quickRatio: number | null;
    /** The ratio's numerator: new MRR, including subscriptions that started
     *  in the window and have since ended (unlike `newMrr`). */
    quickRatioInMrr: number;
    /** The ratio's denominator: churned MRR (same as `churnedMrr`). */
    quickRatioOutMrr: number;
    /** The same question asked of heads rather than of money, with its own
     *  denominator. A churned $99 plan and a churned $1 plan are one row each
     *  here and nothing alike above. */
    subRatePct: number | null;
    startSubs: number;
    /** Cancellations that never collected a penny: not churn, and split by
     *  which problem they are. `wouldHaveBeen` is what they would have been
     *  worth — never a loss, because this money never existed. */
    notChurn: Record<
      "trialNonConversion" | "failedActivation",
      { subscriptions: number; wouldHaveBeen: number }
    >;
    involuntary: number;
    byProduct: { product: string; mrr: number; subscriptions: number }[];
    basis: string;
    approximate: boolean;
  }[];
  /** SETTLEMENT, off the balance ledger: the fee Stripe actually took.
   *  `fees` is its cut ex-tax and is the only figure a rate is derived from;
   *  `taxWithheld` is a pass-through and not a cost. */
  revenue: {
    currency: string;
    days: number;
    gross: number;
    fees: number;
    taxWithheld: number;
    feesTotal: number;
    refunds: number;
    disputes: number;
    other: number;
    net: number;
    transactions: number;
    feeBreakdown: Record<
      "processing" | "managedPayments" | "disputes" | "billing" | "other",
      number
    >;
    feeRatePct: number | null;
    taxRatePct: number | null;
    series: { day: string; net: number; gross: number; fees: number }[];
    note: string;
  }[];
  /** ATTEMPTS, dated by the charge: the only cut that can see a failure.
   *  Its `gross` is not the ledger's and the two are never added. */
  charges: {
    currency: string;
    days: number;
    gross: number;
    refunded: number;
    refunds: number;
    succeeded: number;
    failed: number;
    /** Radar stopped it before a bank saw it. Not a payment failure in any
     *  sense a person can act on, and it never shares a denominator with the
     *  next field. */
    blocked: number;
    declined: number;
    declineRatePct: number | null;
    series: {
      day: string;
      gross: number;
      refunded: number;
      succeeded: number;
      failed: number;
      blocked: number;
      declined: number;
    }[];
    note: string;
  }[];
  /**
   * THE CHARGES THEMSELVES, newest first, for the ninety days the collector
   * keeps them — the rows the day series was folded from. Optional because a
   * route older than this field sends none, and a card must then say
   * "nothing collected" rather than draw an empty month. The address is
   * masked in the table and arrives that way; `failure` is Stripe's own
   * sentence for a decline.
   */
  recent?: StripeCharge[];
  /** True when the table held more than the document carries. */
  recentTruncated?: boolean;
  /** How far back the held rows go, so a list under a wider window is
   *  labelled as the span it is rather than read as a quiet year. */
  recentHeld?: { days: number; from: string | null; total: number; note: string };
  products: { name: string; subscribers: number; mrr: number; currency: string }[];
  plans: { name: string; subscribers: number; mrr: number; currency: string }[];
  balance: {
    currency: string;
    /** What could be paid out today. */
    available: number;
    /** Money Stripe has and will not release yet — beside `available`, never
     *  inside it. */
    pending: number;
    account: string;
    seenAt: string | null;
  }[];
  payouts: {
    last: {
      amount: number;
      currency: string;
      arrivalDate: string;
      automatic: boolean;
    } | null;
    inFlight: {
      amount: number;
      currency: string;
      status: string;
      arrivalDate: string;
    }[];
    /** Null until a payout has been seen. False means somebody presses the
     *  button, which is why no card here promises a next payout date. */
    automatic: boolean | null;
    note: string;
  };
  /** How much of the past the day figures cover. A window wider than this is
   *  a FLOOR, not a total. */
  history: {
    from: string | null;
    complete: boolean;
    rewalkDays: number;
    chunkDays: number;
    note: string;
  };
  cannot: string[];
  seenAt: string | null;
  generatedAt: string;
};

/**
 * GOOGLE ADSENSE — and, until somebody grants consent in a browser, an honest
 * account of why there are no figures.
 *
 * `state` is the field to branch on before drawing anything. Everything below
 * it is empty in three of its four values, and that is the integration working
 * correctly rather than failing: minting a refresh token needs a human at a
 * consent screen, and nothing here can fake one.
 */
export type AdSenseReport = {
  window: { days: number };
  connected: boolean;
  state: "authorised" | "refused" | "not-connected";
  accounts: {
    id: number;
    label: string;
    connected: boolean;
    lastOkAt: string | null;
    /** Google's own sentence, with the console link where there was one. */
    lastError: string | null;
  }[];
  error?: "not-authorised";
  hint?: string;
  enableUrl?: string;
  /** How to get a token, in the order it has to happen. */
  connect?: readonly string[];
  /** Null is "asked and not told". */
  earnings: number | null;
  /** The account's reporting currency, as the report header named it. Null
   *  when nothing has been read or when accounts disagree. */
  currency: string | null;
  currencies: string[];
  estimated: string;
  /** Earnings per thousand impressions, divided out on the read. Null where
   *  nothing was served — which is not an RPM of zero. */
  rpm: number | null;
  impressions: number;
  clicks: number;
  pageViews: number;
  days: {
    day: string;
    usd: number;
    impressions: number;
    clicks: number;
    rpm: number | null;
  }[];
  sites: {
    site: string;
    usd: number;
    last7Usd: number;
    pageViews: number;
    impressions: number;
    clicks: number;
    rpm: number | null;
  }[];
  months: { month: string; usd: number; rpm: number | null; complete: boolean }[];
  /** The newest COMPLETE calendar month, decided on the read. A month-to-date
   *  printed as a monthly figure halves it. */
  latestMonth: { month: string; usd: number; rpm: number | null; complete: boolean } | null;
  cannot: string[];
  seenAt: string | null;
  generatedAt: string;
};

/* ------------------------------------------------------------ cloudflare */

/**
 * One zone's traffic over the window.
 *
 * Every optional field is nullable because Cloudflare's GraphQL query can land
 * on a thinner field set than it asked for, and a field that could not be asked
 * for is not a field that came back zero. `fields` names the set that answered.
 */
export type CloudflareTraffic = {
  requests: number;
  cached: number;
  /** Null over zero requests: a ratio of nothing is unknowable, not 0%. */
  cacheRatio: number | null;
  bytes: number;
  threats: number | null;
  pageViews: number | null;
  /**
   * Daily unique counts ADDED UP. Cloudflare de-duplicates visitors within one
   * zone and one day and nowhere else, so a returning visitor is in this more
   * than once. The name says so, and so does every card that draws it.
   */
  uniquesByDay: number | null;
  /** The busiest single day's uniques — the one figure here that is a real
   *  headcount, because it never crosses a day boundary. */
  uniquesBusiestDay: number | null;
  status: {
    s2xx: number | null;
    s3xx: number | null;
    s4xx: number | null;
    s5xx: number | null;
  };
  /** Complete days that actually landed. A zone added mid-window has fewer
   *  than the window asked for, and "7d" over three days means something
   *  else. */
  days: number;
  fields: string;
};

/**
 * Where a zone's domain actually delegates, as far as this box can tell.
 *
 * FIVE STATES, NOT A BOOLEAN, because three of them are neither fine nor
 * broken: a registrar that reported no nameservers is unknown, a name held at a
 * registrar with no API here has nothing to compare against, and a name pointed
 * at a DIFFERENT pair of Cloudflare nameservers is on Cloudflare and still not
 * on this zone.
 */
export type CloudflareAlignment = {
  state:
    | "aligned"
    | "off-cloudflare"
    | "elsewhere-on-cloudflare"
    | "unknown"
    | "no-registrar-row";
  note: string;
  registrar: string | null;
  account: string | null;
  nameservers: string[] | null;
};

export type CloudflareEmail = {
  mx: boolean;
  spf: boolean;
  dmarc: boolean;
  /** The `p=` of the record. Null where DMARC is delegated by CNAME and the
   *  policy lives on the reporting provider's side. */
  dmarcPolicy: string | null;
  /** Three states. Null is "nothing to conclude" — a zone with no mail at all
   *  cannot be said to be missing DKIM. */
  dkim: boolean | null;
};

export type CloudflareZone = {
  id: string;
  name: string;
  accountId: number;
  account: string;
  /** Cloudflare's own name for the account the zone lives in. */
  cfAccount: string | null;
  status: string | null;
  paused: boolean;
  plan: string | null;
  /** "full" or "partial". A partial zone serves part of the domain, which
   *  changes what its request count is a count OF. */
  type: string | null;
  createdOn: string | null;
  /** The nameservers Cloudflare ASSIGNED. What the domain delegates to is on
   *  `alignment`, and the gap between the two is the point. */
  nameServers: string[] | null;
  /** Null, never 0 — an unreadable listing says nothing about how many records
   *  a zone has. */
  records: number | null;
  proxied: number | null;
  onPages: boolean | null;
  email: CloudflareEmail | null;
  recordsNote: string | null;
  /** Null with a `trafficNote` beside it means nobody could measure this zone.
   *  Zero requests with no note means it was measured and served nothing. */
  traffic: CloudflareTraffic | null;
  trafficNote: string | null;
  alignment: CloudflareAlignment;
  seenAt: string;
};

export type CloudflareReport = {
  generatedAt: string;
  /** When the zones were last COLLECTED. Every figure is recomputed per
   *  request, so the document's own clock would say "just now" about numbers
   *  read six hours ago. */
  seenAt: string | null;
  window: {
    days: number;
    since: string;
    /** The last COMPLETE UTC day. Every total stops here. */
    through: string;
    collectedDays: number;
    note: string;
  };
  zones: CloudflareZone[];
  daily: {
    day: string;
    requests: number;
    cached: number;
    bytes: number;
    threats: number | null;
    pageViews: number | null;
    /** Summed across ZONES on one day. Somebody who read two of these sites
     *  that morning is in it twice, and there is no identity that spans zones
     *  to fix that with. */
    uniquesByZone: number | null;
    zones: number;
    /** Today, which Cloudflare is still writing. Never in a total. */
    partial: boolean;
  }[];
  summary: {
    zones: number;
    active: number;
    paused: number;
    byPlan: Record<string, number>;
    withTraffic: number;
    withoutTraffic: number;
    requests: number;
    cached: number;
    cacheRatio: number | null;
    bytes: number;
    threats: number | null;
    pageViews: number | null;
    /** Always null, with the reason beside it. There is no honest total. */
    uniques: null;
    uniquesNote: string;
    records: number | null;
    proxied: number | null;
    recordsUnreadable: number;
    onPages: number;
    busiest: { name: string; requests: number } | null;
    /** Measured, and served nothing. Named rather than counted. */
    silent: string[];
    seenAt: string | null;
  };
  email: {
    zones: number;
    unreadable: number;
    /** Zones showing any sign of handling mail. The rest cannot be called badly
     *  configured for not defending a mailbox they do not have. */
    sending: number;
    mx: number;
    spf: number;
    dmarc: number;
    /** `p=none` monitors and enforces nothing, so it is counted apart from
     *  "has DMARC" rather than inside it. */
    dmarcMonitorOnly: number;
    dkim: number;
    dkimMissing: number;
    dkimUnknown: number;
  };
  alignment: {
    registrarDomains: number;
    zones: number;
    aligned: string[];
    offCloudflare: {
      name: string;
      note: string;
      registrar: string | null;
      nameservers: string[] | null;
    }[];
    elsewhereOnCloudflare: {
      name: string;
      note: string;
      registrar: string | null;
      nameservers: string[] | null;
    }[];
    unknown: { name: string; registrar: string | null }[];
    /** A zone here that no connected registrar holds — its renewal date is
     *  invisible to this dashboard, which is the finding. */
    zoneOnly: string[];
    /** A name a registrar holds with no Cloudflare zone at all. */
    registrarOnly: {
      name: string;
      registrar: string;
      account: string;
      expiresAt: string | null;
      expiresInDays: number | null;
      nameservers: string[] | null;
    }[];
    claimedTwice: string[];
    note: string;
  };
  registrar: {
    /** The field that matters. An empty list from an endpoint that ANSWERED is
     *  a measurement; an empty list from one that refused is nothing at all. */
    readable: boolean;
    count: number;
    domains: {
      name: string;
      account: string;
      expiresAt: string | null;
      expiresInDays: number | null;
      autoRenew: boolean | null;
      locked: boolean | null;
      registrar: string | null;
      status: string | null;
    }[];
    note: string;
  };
  accounts: {
    id: number;
    label: string;
    cfAccount: string | null;
    zones: number;
    registrarReadable: boolean;
    registrarCount: number;
    registrarNote: string | null;
    analyticsZones: number;
    analyticsNote: string | null;
    seenAt: string;
  }[];
  cannot: {
    checkedOn: string;
    asked: readonly { asked: string; answer: string }[];
    summary: string;
    graphql: string;
  };
};

/* ------------------------------------------------------------------ search */

/**
 * THE TWO SEARCH ENGINES ARE TWO DOCUMENTS, and nothing on either type below
 * could be added to the other. Google's impressions and Bing's count different
 * searches by different people on different networks; a shared `SearchReport`
 * would be a type inviting a sum that means nothing.
 */

export type GscProperty = {
  property: string;
  /** Without the `sc-domain:` prefix, which is Search Console's and not the
   *  owner's. */
  label: string;
  account: string;
  permission: string | null;
  clicks: number;
  impressions: number;
  /** Clicks over impressions, as a percentage. Null with no impressions. */
  ctr: number | null;
  /** Impression-weighted. NULL rather than 0 for a property nobody saw —
   *  Google answers 0.0 there, and that is the absence of a rank. */
  position: number | null;
  previous: { clicks: number; impressions: number; ctr: number | null; position: number | null };
  delta: {
    impressions: number | null;
    clicks: number | null;
    /** Places, not percent, and positive is WORSE. */
    position: number | null;
  };
  /** Google's own dimensionless answer for the same window, kept so the summed
   *  figures above can be checked against it rather than trusted. */
  googleTotal: {
    clicks: number | null;
    impressions: number | null;
    position: number | null;
    window: { start: string; end: string } | null;
  };
  /** How much of this property the ranked query rows actually cover — 2% to
   *  77% across these properties. `capped` separates "there is more tail" from
   *  "the rest was anonymised". */
  queryCoverage: {
    rows: number | null;
    impressions: number | null;
    clicks: number | null;
    pct: number | null;
    capped: boolean | null;
  };
  sitemaps: {
    /** 'reported' | 'none' | 'failed' — three states, because "submitted
     *  nothing" and "could not be read" are not the same finding. */
    state: string | null;
    count: number | null;
    submitted: number | null;
    errors: number | null;
    warnings: number | null;
    pending: number | null;
    lastDownloaded: string | null;
  };
  error: string | null;
  seenAt: string;
  /** This property's own finalised daily line, oldest first, over the same
   *  `seriesDays` as the portfolio series — and never added into it here. */
  series: { day: string; clicks: number; impressions: number; position: number | null }[];
  /*
    THE PROPERTY'S OWN CUT OF THE RANKED ROWS — five each — so a card drawn
    per property is drawn from that property's rows and not from the
    portfolio list, which on this account is one busy property's list wearing
    the portfolio's name. Optional on the type because a route that predates
    them answers without them, and a builder then declines rather than draws.
  */
  topQueries?: { query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[];
  topPages?: { page: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[];
  /** Position 5–20 with 3+ impressions — the portfolio definition, narrowed. */
  striking?: { query: string; impressions: number; clicks: number; position: number | null }[];
  /** Shown and never clicked, within the pages Google returned: a FLOOR. */
  zeroClick?: { count: number; floor: true; pages: { page: string; impressions: number }[] };
};

export type GscRanked = {
  query: string;
  property: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
};

export type GscReport = {
  connected: boolean;
  accounts: { id: number; label: string; connected: boolean; properties: number }[];
  window: {
    days: number;
    start: string | null;
    /** The last FINALISED day. Never today: Search Console takes two to three
     *  days to finish one, and drawing the unfinished ones is a fall that
     *  never happened. */
    end: string | null;
    previousStart: string | null;
    previousEnd: string | null;
    lagDays: number;
    lagNote: string;
  };
  totals: {
    clicks: number;
    impressions: number;
    ctr: number | null;
    position: number | null;
    properties: number;
  };
  previous: { clicks: number; impressions: number; ctr: number | null; position: number | null };
  delta: { impressions: number | null; clicks: number | null; position: number | null };
  series: { day: string; clicks: number; impressions: number; properties: number }[];
  seriesDays: number;
  properties: GscProperty[];
  queries: GscRanked[];
  /** Queries ranking 11th to 20th — one page short of the clicks. */
  striking: { query: string; property: string; impressions: number; clicks: number; position: number | null }[];
  strikingBasis: string;
  pages: (Omit<GscRanked, "query"> & { page: string })[];
  coverage: {
    queryImpressions: number;
    googleImpressions: number;
    pct: number | null;
    rowLimit: number;
    note: string;
  };
  sitemaps: {
    properties: number;
    none: number;
    unreadable: number;
    submitted: number;
    errors: number;
    warnings: number;
  };
  cannot: string[];
  seenAt: string | null;
  generatedAt: string;
};

export type BingSite = {
  site: string;
  label: string;
  account: string;
  verified: boolean | null;
  impressions: number;
  clicks: number;
  ctr: number | null;
  index: {
    inIndex: number | null;
    crawledPages: number | null;
    crawlErrors: number | null;
    blockedByRobots: number | null;
    day: string | null;
    /** The site's own crawl history: in-index is a level per day and is never
     *  summed over days. */
    series: {
      day: string;
      inIndex: number | null;
      crawled: number | null;
      errors: number | null;
      blocked: number | null;
    }[];
  };
  /** This site's own daily traffic, oldest first, over `seriesDays`. */
  series: { day: string; impressions: number; clicks: number }[];
  /** The crawler's inbound-link count. */
  inLinks: number | null;
  /** How many of OUR pages the link endpoint could NAME a link into. Zero on
   *  every site here, which is why there is no referring-domain figure. */
  linkedPages: number | null;
  error: string | null;
  seenAt: string;
};

export type BingKeyword = {
  phrase: string;
  /** The country and language the impressions were counted in. Part of the
   *  measurement, not a footnote. */
  market: string;
  /** 'ok' | 'na' | 'void' | 'failed'. `void` means the control phrase came
   *  back empty too, so nothing in that batch is a measurement — and `volume`
   *  is null rather than zero. */
  status: string;
  volume: number | null;
  /** Broad-match impressions: a different and much larger measurement, never
   *  substituted for the exact one. */
  broad: number | null;
  peak: number | null;
  weeks: number;
  trend: "up" | "down" | "flat" | null;
  error: string | null;
  askedAt: string;
};

export type BingReport = {
  connected: boolean;
  accounts: { id: number; label: string; connected: boolean; sites: number }[];
  window: { days: number; start: string | null; end: string | null; note: string };
  totals: {
    impressions: number;
    clicks: number;
    ctr: number | null;
    sites: number;
    verified: number;
  };
  series: { day: string; impressions: number; clicks: number }[];
  seriesDays: number;
  sites: BingSite[];
  queries: {
    query: string;
    site: string;
    impressions: number;
    clicks: number;
    ctr: number | null;
    position: number | null;
  }[];
  index: {
    inIndex: number;
    crawledPages: number;
    crawlErrors: number;
    blockedByRobots: number;
    day: string | null;
    series: { day: string; crawled: number; errors: number; blocked: number }[];
  };
  /** Two inbound-link measurements that disagree, and the sentence saying so. */
  links: {
    inLinks: number;
    namedPages: number;
    sitesWithNamedLinks: number;
    note: string;
  };
  keywords: {
    market: string;
    control: string;
    configured: number;
    max: number;
    measured: number;
    unavailable: number;
    unmeasured: number;
    failed: number;
    phrases: BingKeyword[];
    note: string;
  };
  cannot: string[];
  seenAt: string | null;
  generatedAt: string;
};

/* ------------------------------------------------------------------ meta */

/**
 * One insights window, in Meta's own units — and dated.
 *
 * `from`/`to` are not decoration. Meta's `last_30d` ends on the last complete
 * day rather than on today, so a card captioned "30d" over this figure is
 * captioning a window that closed yesterday-or-before. A window whose end is
 * not stated reads as a window ending now.
 */
export type MetaWindow = {
  from: string | null;
  to: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  cpc?: number | null;
  ctr: number | null;
  /**
   * DE-DUPLICATED OVER THIS ROW'S OWN WINDOW AND NOWHERE ELSE. Two campaigns
   * that both reached the same person each count them once, so adding two
   * campaign reaches counts that person twice — and averaging two frequencies
   * does the same thing in reverse. Nothing in this client sums either.
   */
  reach: number | null;
  frequency: number | null;
  leads: number | null;
  costPerLead: number | null;
  /**
   * ALWAYS NULL ON THIS ACCOUNT, and that is a property of the account rather
   * than a gap in the collector. ROAS is revenue over spend; this account buys
   * lead-form submissions, so there is no purchase event and no value for Meta
   * to divide by. Null is "asked and not told" — never 0×.
   */
  roas?: number | null;
};

export type MetaCampaign = {
  id: string;
  name: string | null;
  /** `effective_status` — an ad left ACTIVE inside a paused campaign is not
   *  running, and only this field folds the parents and Meta's vetoes in. */
  status: string | null;
  objective: string | null;
  window: MetaWindow | null;
};

export type MetaAdAccount = {
  id: string;
  accountId: number;
  accountLabel: string;
  name: string | null;
  /** The account's OWN currency. Every money figure on this object is in it,
   *  and nothing adds two accounts' figures without a dated FX rate. */
  currency: string | null;
  status: number | null;
  active: boolean;
  timezone: string | null;
  createdAt: string | null;
  lifetimeSpend: number | null;
  window: MetaWindow | null;
  note: string | null;
  campaigns: MetaCampaign[];
  /** The days Meta actually reported. A day with no row is a day the account
   *  did not deliver, not a day measured at zero, and it is absent rather than
   *  drawn flat. */
  daily: {
    day: string;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    leads: number | null;
  }[];
  /** Summed from `daily` on the read. These add across days; `reach` and
   *  `frequency` on the window above do not and are not here. */
  totals: {
    days: number;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    leads: number | null;
  };
};

export type MetaPage = {
  id: string;
  accountId: number;
  accountLabel: string;
  name: string | null;
  /** Null is "Meta did not report it", never nought. */
  followers: number | null;
  fans: number | null;
  followersSource: string | null;
  link: string | null;
  category: string | null;
  about: string | null;
  /** A signed, EXPIRING scontent URL — only as good as the last collection. */
  picture: string | null;
  instagram: {
    /** THE FLAG THAT KEEPS TWO ANSWERS APART. `checked: true, id: null` is Meta
     *  saying this Page has no Instagram Business account; without it, that is
     *  indistinguishable from nobody having looked. */
    checked: boolean;
    id: string | null;
    username: string | null;
    followers: number | null;
  };
};

export type MetaReport = {
  generatedAt: string;
  /** When Meta was last READ, not when this document was assembled. */
  seenAt: string | null;
  graphVersion: string;
  everyHours: number;
  windowDays: number;
  /** The attribution window the lead counts were taken over, requested
   *  explicitly rather than inherited from the account's Ads Manager default:
   *  the same twelve leads are a different number at a different window. */
  attribution: string;
  state: {
    accountId: number;
    accountLabel: string;
    user: string | null;
    userId: string | null;
    /** Whether the calls carried `appsecret_proof`. False means no app pair is
     *  stored; the token reads everything either way. */
    proofed: boolean;
    pages: number;
    pagesChecked: number;
    instagramLinked: number;
    adAccounts: number;
    note: string | null;
    seenAt: string;
  }[];
  pages: MetaPage[];
  /**
   * INSTAGRAM'S THREE-STATE ANSWER, and the reason this block exists at all.
   *
   * On this account the credential works, it lists three Pages by name, and
   * every one of them reports no linked Instagram Business account. That is
   * `none-linked` — not an error, and emphatically not "0 followers".
   * `followers` is null rather than 0 for exactly that reason: zero would be a
   * measurement of an audience, and this is the absence of an account to
   * measure. `fix` carries the one step that changes it.
   */
  instagram: {
    state: "no-plugin" | "no-pages" | "none-linked" | "linked";
    pagesChecked: number;
    accounts: {
      pageId: string;
      pageName: string | null;
      id: string | null;
      username: string | null;
      followers: number | null;
    }[];
    followers: number | null;
    fix: string | null;
  };
  adAccounts: MetaAdAccount[];
  spendByCurrency: {
    currency: string;
    adAccounts: number;
    windowSpend: number;
    lifetimeSpend: number;
  }[];
  currency: {
    seen: string[];
    /** Null, always, with the reason beside it — the same contract the costs
     *  and mobile reports keep. A total across currencies needs a dated
     *  exchange rate this box does not fetch. */
    combined: null;
    note: string;
  };
  reachNote: string;
  leadNote: string;
  /** What was asked of the Graph API and what came back, dated — the evidence
   *  rather than the verdict, the same shape Replicate's and Cloudflare's
   *  `cannot` blocks carry. */
  cannot: { checkedOn: string; asked: { asked: string; answer: string }[] };
};

/* ------------------------------------------------------------------ demand */

/**
 * One thing a stranger wrote, as one of the two sources reported it.
 *
 * FOUR OF THESE FIELDS ARE NULLABLE AND THE NULLS ARE THE POINT. A row learned
 * through SearXNG has no date and no score because a web index knows neither;
 * a Hacker News comment has no score because Algolia's index does not carry
 * one. Written as zeroes, both would be measurements nobody made — "posted at
 * the epoch, nobody upvoted it" — so they are nulls all the way to the card.
 */
export type DemandSignal = {
  id: string;
  term: string;
  title: string;
  url: string;
  /** "r/selfhosted" on Reddit; "story" or "comment" on Hacker News. */
  context: string | null;
  createdAt: string | null;
  ageDays: number | null;
  points: number | null;
  comments: number | null;
  /** How this row was learned: the Atom feed, the feed with the account's own
   *  token, SearXNG, or Algolia. On the card, because they are not the same
   *  claim about the same twelve links. */
  tier: string;
  /** When THIS box first saw it, which is the only freshness figure an unaged
   *  row can contribute. */
  firstSeenAt: string;
};

/**
 * What happened when one phrase was put to one source.
 *
 * `ok` with `items: 0` and `throttled` are different answers and this type is
 * where that difference survives the trip to the browser.
 */
export type DemandQuery = {
  term: string;
  status: "ok" | "throttled" | "failed" | "skipped" | "unasked";
  tier: string | null;
  tierLabel: string | null;
  items: number | null;
  error: string | null;
  askedAt: string | null;
};

type DemandSection = {
  connected: boolean;
  signals: DemandSignal[];
  /** Distinct THREADS in the window, never the row count — a thread two
   *  phrases both found is one conversation. */
  threads: number;
  /** Rows whose tier could not date them, so they are in no window at all. */
  unaged: number;
  unscored: number;
  /** Threads first seen by this box inside the window. */
  newHere: number;
  queries: DemandQuery[];
  seenAt: string | null;
};

export type DemandReport = {
  generatedAt: string;
  windowDays: number;
  everyHours: number;
  /** The watch list. Configuration rather than a credential, so it reads
   *  back — which is the whole reason a typo in it can be corrected. */
  terms: string[];
  maxTerms: number;
  /** When this box first saw anything at all. Everything is new on the first
   *  morning, and a card drawing `newHere` has to be able to say so. */
  collectingSince: string | null;
  reddit: DemandSection & {
    token: {
      held: boolean;
      accounts: { id: number; label: string; lastOkAt: string | null; lastError: string | null }[];
      note: string;
    };
    tiers: { tier: string; label: string; queries: number }[];
    subreddits: { name: string; threads: number }[];
  };
  hn: DemandSection & { stories: number; comments: number };
  searxng: {
    connected: boolean;
    /** The endpoint in use — the setting, or the default it falls back to. */
    url: string;
    configured: boolean;
    seenAt: string | null;
    probe: {
      ok: boolean;
      query: string | null;
      results: number | null;
      /** Of those results, how many were on the site the probe restricted
       *  itself to. Ten results with none of them on it is a node answering a
       *  different question, which a count alone reads as perfect health. */
      onSite: number | null;
      site: string;
      ms: number | null;
      enginesOk: number | null;
      enginesRefused: number | null;
      error: string | null;
    } | null;
    /** Per engine, from that probe. `refused` is the node's own words. */
    engines: { engine: string; results: number; refused: string | null }[];
    /** How often the node actually had to stand in for Reddit. */
    standIns: number;
    cannot: { checkedOn: string; asked: { asked: string; answer: string }[] };
  };
  totals: { threads: number; newHere: number; unaged: number; note: string };
  cannot: { checkedOn: string; asked: { asked: string; answer: string }[] };
};

/**
 * THE TELEGRAM BRIDGE, WHICH IS THE ONE INTEGRATION THAT IS A DOOR RATHER THAN
 * A MEASUREMENT.
 *
 * Every other type in this file describes something that was collected. This
 * one describes something that is RUNNING: a long poll inside the API process,
 * paired with exactly one chat, answering it through the same agent the Chat
 * page talks to. Which is why `poller` is on here at all — "connected" is the
 * whole answer for a collector and only half of it for a bot, because a
 * connected token whose loop is being refused by a second process polling the
 * same bot looks identical from the plugin row.
 *
 * COUNTS AND IDS, NEVER A PERSON. There is no field here that could carry a
 * name or a word anybody typed, because there is none on the route.
 */
export type TelegramBot = {
  accountId: number;
  /** The bot's own @name once the poller has asked getMe. Never a person's. */
  label: string;
  username: string | null;
  connected: boolean;
  chat: {
    locked: boolean;
    /** Null is the state a fresh install is in: the bot is live and waiting to
     *  be messaged. It is not an error. */
    chatId: string | null;
    /** The `plugin_config` key holding it — `chatId` for the first bot. */
    key: string;
    turns: number;
    /** Where the conversation lives in the shared transcript. */
    session: string | null;
  };
  poller: {
    state: "starting" | "polling" | "conflict" | "backoff" | "stopped";
    since: string | null;
    failures: number;
    nextAttemptAt: string | null;
    lastError: string | null;
    updates: number;
  };
  messages: {
    handled: number;
    /** Messages from any chat other than the paired one. Nothing was sent back
     *  and nothing reached the agent — this is how often somebody else has
     *  found this bot. */
    ignored: number;
    lastMessageAt: string | null;
    lastIgnoredAt: string | null;
    lastReplyAt: string | null;
  };
  lastError: string | null;
  lastErrorAt: string | null;
};

export type TelegramReport = {
  connected: boolean;
  bots: TelegramBot[];
  /** Whether there is anything on the other end of the bot. A live bridge with
   *  no agent behind it is the one state that looks broken and is not. */
  agent: {
    connected: boolean;
    backends: { id: string; connected: boolean; label: string | null }[];
    label: string | null;
  };
  /** The step only a human can take, or null when there is none. */
  next: string | null;
  cannot: string[];
  generatedAt: string;
};

/**
 * THE SEARCH NODE THIS BOX CAN INSTALL RATHER THAN MERELY CONNECT TO.
 *
 * Every other integration in this file is a credential pointed at somebody
 * else's service. SearXNG has a second way in: the server clones it, builds it
 * into a virtualenv under `data/searxng/` and runs it as a child process on
 * 127.0.0.1:8888 — so what the page has to draw is not "connected or not" but
 * a PROCESS, with an install that takes minutes and a state that changes while
 * you are looking at it.
 *
 * THE STATES ARE SEVEN AND EACH IS A DIFFERENT SENTENCE. `absent` is nothing
 * on disk; `installing` is the long one, and is the reason `step` and `log`
 * exist; `installed` and `stopped` are the same disk with two different
 * histories behind them, and saying "stopped" about something that has never
 * run would be inventing one; `starting` is spawned but not yet answering
 * /healthz; `running` is answering; `failed` is the install or the process
 * giving up, with `lastError` carrying why.
 *
 * `inUse` IS NOT `running`. The instance can be up while the plugin is pointed
 * at the remote node — that is a legitimate state and the panel says so rather
 * than implying the searches have moved.
 *
 * THERE IS NO SECRET ON THIS TYPE. The instance has one — Flask's session key
 * — and it is generated on the server, written to a file at mode 0600 and
 * returned by no route, which is why there is no field here that could hold it.
 */
export type SearxngInstance = {
  state:
    | "absent"
    | "installing"
    | "installed"
    | "starting"
    | "running"
    | "stopped"
    | "failed";
  since: string;
  /** Which install step is running. Null when nothing is installing. */
  step: string | null;
  lastError: string | null;
  url: string;
  port: number;
  /** The exact commit the checkout is pinned to. Null before an install. */
  commit: string | null;
  installedAt: string | null;
  installSeconds: number | null;
  python: { path: string; version: string } | null;
  pid: number | null;
  healthyAt: string | null;
  restarts: number;
  /** Whether searches actually go through this instance. */
  inUse: boolean;
  /** Whether it comes back on its own when the API restarts. */
  autostart: boolean;
  log: string[];
  dir: string;
};

/* -------------------------------------------------------------- freellmapi */

/**
 * THE SECOND THING THIS BOX CAN INSTALL RATHER THAN MERELY CONNECT TO.
 *
 * FreeLLMAPI is an OpenAI-compatible gateway that holds keys for the ~34
 * providers with a free tier and routes each completion to whichever of them
 * can serve it, failing over when one is throttled. There is no hosted one:
 * `freellmapi.co` is a marketing site and `api.freellmapi.co` is its catalog
 * and licence API, neither of which completes a chat turn — so an instance is
 * always somebody's own, and the page has to ask WHICH one.
 *
 * HENCE TWO ACCOUNTS, WHICH IS THE SHAPE OF THIS WHOLE PANEL. One points at an
 * instance already running elsewhere (the owner's is on a Hetzner box); one is
 * installed into `data/freellmapi/` and run as a child process on
 * 127.0.0.1:3001. Both are the same wire, so switching is a click rather than
 * a re-paste — and `inUse` says which is actually answering, which is NOT the
 * same question as which is running.
 *
 * THERE IS NO KEY ON THIS TYPE, and there is no route that would fill one.
 * The managed instance mints its own — the value is read out of the gateway's
 * own database on the server and sealed into the vault without passing through
 * a log, a response or a clipboard — so `hasKey` is a boolean and that is all
 * a page ever needs to know about it.
 */
export type FreeLlmApiInstance = {
  state:
    | "absent"
    | "installing"
    | "installed"
    | "starting"
    | "running"
    | "stopped"
    | "failed";
  since: string;
  /** Which install step is running. Null when nothing is installing. */
  step: string | null;
  lastError: string | null;
  /** Where the managed instance's API answers when it is up. */
  url: string;
  /** Its own web dashboard — where provider keys are added. Same port. */
  dashboardUrl: string;
  port: number;
  /** The exact commit the checkout is pinned to. Null before an install. */
  commit: string | null;
  installedAt: string | null;
  installSeconds: number | null;
  node: { path: string; version: string } | null;
  /** Whether the dashboard bundle was built. False means the API works and
   *  the browser page will not render — a fact, not a failure. */
  dashboard: boolean;
  pid: number | null;
  healthyAt: string | null;
  restarts: number;
  /** Whether a unified key has been minted. Never the key itself. */
  hasKey: boolean;
  /**
   * Whether the two providers that need no key have been switched on.
   *
   * A gateway with no provider keys in it routes to nothing — its catalog is
   * real and every candidate answers "no enabled key for platform" — so the
   * first start switches on the two that work anonymously, once, and records
   * it. Once. After that the gateway's own Keys page owns those switches, and
   * turning one off stays off.
   */
  seeded: boolean;
  /** Whether it comes back on its own when the API restarts. */
  autostart: boolean;
  log: string[];
  dir: string;
};

/** One FreeLLMAPI endpoint the owner has connected. The base URL is shown in
 *  full because it is an address they typed, not a credential. */
export type FreeLlmApiAccount = {
  id: number;
  label: string;
  connected: boolean;
  baseUrl: string | null;
  /** Whether this row is the managed instance on this machine. */
  local: boolean;
  /** Whether a completion sent now would go here. At most one row is true. */
  inUse: boolean;
  lastOkAt: string | null;
  lastError: string | null;
};

export type FreeLlmApiDoc = {
  instance: FreeLlmApiInstance;
  accounts: FreeLlmApiAccount[];
  inUse: { accountId: number; label: string; baseUrl: string; local: boolean } | null;
  /** The owner's explicit choice, which may name an account that is gone —
   *  shown beside `inUse` so "I picked the hosted one and the local one is
   *  answering" is visible rather than mysterious. Null is automatic. */
  chosenAccountId: number | null;
  provider: {
    id: string;
    /** Whether this is the provider every agent inherits. */
    isDefault: boolean;
    /** The pinned model id, or null for "whatever the catalog lists first". */
    model: string | null;
    policy: { mode: string; concurrency: number; balance: string; timeoutMs: number };
  };
  /** What the endpoint in use says it serves. Read live on the server and
   *  cached for a minute, so polling this document costs one request in
   *  thirty rather than one per poll. */
  models: { ids: string[]; count: number; readAt: string; error: string | null };
  /** The placeholder the credential form offers for a hosted instance. Not a
   *  default — nothing is written anywhere until somebody types it. */
  hostedPlaceholder: string;
  localUrl: string;
};

/* -------------------------------------------------------------------- mail */

/**
 * One label in one mailbox.
 *
 * THE COUNTERS ARE GMAIL'S OWN and are exact — they come from `labels.get`, not
 * from a search. Asked for the unread inbox as a query, Gmail answered 201
 * against a true 263 on this mailbox, which is why no estimate is used anywhere
 * behind these numbers.
 *
 * THE TRIAGE HALF IS NULLABLE AND THAT IS LOAD-BEARING. `needingReply: null`
 * means the scan did not reach this label; `0` means it did and found nothing
 * waiting. `scanned` is the denominator the verdict is over — a queue with no
 * denominator is not a measurement — and `truncated` says the count is a FLOOR.
 */
export type MailLabel = {
  id: string;
  name: string;
  kind: string;
  messagesTotal: number | null;
  messagesUnread: number | null;
  threadsTotal: number | null;
  threadsUnread: number | null;
  scanned: number | null;
  needingReply: number | null;
  oldestWaitingDays: number | null;
  truncated: boolean;
  note: string | null;
};

export type MailVolumeDay = {
  day: string;
  received: number | null;
  sent: number | null;
  /** Today, which is still filling. Carried, marked, and in no total. */
  partial: boolean;
  capped: boolean;
};

export type Mailbox = {
  accountId: number;
  accountLabel: string;
  /** The mailbox's own address — the only address on this document, and the
   *  owner's. No correspondent's ever reaches the client. */
  address: string | null;
  messagesTotal: number | null;
  threadsTotal: number | null;
  labelsTotal: number | null;
  historyId: string | null;
  /**
   * What Google says the grant carries. `gmail.modify` is a WRITE scope — it
   * can archive, label and trash — and this is where a reader finds that out.
   * `readOnly` beside it is the answer: the server's provider has one HTTP
   * entry point, it hard-codes GET and takes no body, so the token's extra
   * power is a fact about the credential and never about what this dashboard
   * does with it.
   */
  scopes: string[];
  readOnly: { enforced: boolean; how: string };
  /** Two answers, because Gmail has two and they differ by a fifth here: 263
   *  messages against 252 threads. Every card says which one it drew. */
  unread: { messages: number | null; threads: number | null };
  needingReply: number | null;
  oldestWaitingDays: number | null;
  scanned: number | null;
  floor: boolean;
  labels: MailLabel[];
  volume: {
    byDay: MailVolumeDay[];
    /** Over COMPLETE days only. Received and sent are never added: one is mail
     *  that cost you attention and the other mail that cost you a reply. */
    received: number | null;
    sent: number | null;
    from: string | null;
    to: string | null;
    days: number;
  };
  outreach: {
    people: number;
    new: number;
    known: number;
    /** The earliest sent-mail day this dashboard has on hand. A "new contact"
     *  count is only as good as the history it is new against. */
    historyFrom: string | null;
    lookbackDays: number;
  };
  seenAt: string;
  note: string | null;
};

export type MailDnsRecord = {
  record: string;
  type: string;
  name: string;
  status: string | null;
  priority: number | null;
};

export type SendingDomain = {
  id: string;
  name: string;
  accountId: number;
  accountLabel: string;
  /** Resend's own word — "verified", "pending", "failed" — never reduced to a
   *  boolean: a domain part-way through verification and one that will not send
   *  are different situations and only one is a thing to fix. */
  status: string | null;
  region: string | null;
  createdAt: string | null;
  sending: string | null;
  receiving: string | null;
  /** Both false on every domain here, which is why there is no open rate
   *  anywhere on this board: Resend never writes an `opened` event for a domain
   *  that is not tracking. */
  tracking: { open: boolean | null; click: boolean | null };
  dns: {
    /** Whether the per-domain call carrying the records answered. A domain with
     *  no records READ is not a domain with no records. */
    read: boolean;
    records: MailDnsRecord[];
    total: number | null;
    verified: number | null;
    /** The records that are not verified, named. A domain that reads "verified"
     *  while one of its records has gone pending is a domain about to stop
     *  sending, and the listing endpoint cannot show that. */
    unhealthy: MailDnsRecord[];
  };
  sends: MailSends & {
    windowDays: number;
    byDay: { day: string; sent: number; delivered: number; bounced: number }[];
    /** Which addresses on this domain actually send. Ours, not anybody's. */
    fromAddresses: { address: string; sent: number }[];
    oldest: string | null;
    floor: boolean;
  };
  seenAt: string;
  note: string | null;
};

/**
 * One set of send figures.
 *
 * THE RATE DENOMINATOR IS NAMED BECAUSE THERE ARE THREE DEFENSIBLE ONES. It is
 * mail that actually reached a mail server — delivered + bounced + complained —
 * and NOT everything sent. `suppressed` is Resend declining to send at all, to
 * an address already on its own suppression list: it never reached a server, so
 * counting it in the denominator would make a bounce rate FALL every time
 * Resend refused to try. It gets its own line instead, and it is the more
 * actionable number: a suppression is a list to clean.
 */
export type MailSends = {
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  suppressed: number;
  /** Queued, scheduled, delayed, cancelled — anything Resend has not finished
   *  with. Counted apart rather than folded into a failure. */
  inFlight: number;
  /** Null over nothing attempted, never 0% — the same rule a cache ratio over
   *  zero requests follows. */
  bounceRate: number | null;
  complaintRate: number | null;
  deliveryRate: number | null;
  rateBasis: string;
  attempted: number;
};

/**
 * Mail, in one document: what arrives and what leaves.
 *
 * ONE REPORT FOR TWO PROVIDERS, the way MobileReport is one report for two app
 * stores — and NOT the split GscReport and BingReport take. That split exists
 * because Google's impressions and Bing's count the same KIND of thing about
 * different populations, and one document holding both would be one field away
 * from a card that adds them. Nothing here is that shape: an inbox thread
 * waiting on a reply and a transactional password reset are not the same kind
 * of thing, and there is no arithmetic anybody would be tempted to perform
 * across them. Two `connected` flags, two blocks, and no figure spanning them.
 *
 * NOTHING PRIVATE IS ON THIS TYPE AND NOTHING PRIVATE COULD BE. There is no
 * field here for a subject, a message body, a recipient or a correspondent's
 * name — the server's tables cannot hold one, so the client cannot render one.
 */
export type MailReport = {
  generatedAt: string;
  /** When the mail was last READ, not when the document was assembled: every
   *  figure on it is recomputed per request. */
  seenAt: string | null;
  windowDays: number;
  collectedEveryHours: number;
  connected: { gmail: boolean; resend: boolean };
  mailboxes: Mailbox[];
  /**
   * The triage headline, summed across MAILBOXES and never across labels.
   *
   * A thread can carry INBOX and a hand-made label at once, so adding the
   * per-label queues counts it twice — the same rule GitHub's unique visitors
   * and Cloudflare's visitors follow, in a place it is far easier to get wrong
   * because labels look like folders. Two Google accounts are two separate
   * stores of mail, so across mailboxes the counts genuinely do add.
   */
  inbox: {
    mailboxes: number;
    unreadThreads: number | null;
    unreadMessages: number | null;
    needingReply: number | null;
    oldestWaitingDays: number | null;
    scanned: number | null;
    /** True when a listing or the run's thread budget ran out, which makes
     *  `needingReply` a floor rather than a count. */
    floor: boolean;
    budget: number;
    windowDays: number;
    /** The sentence the count is only interpretable beside. */
    definition: string;
  };
  volume: {
    byDay: {
      day: string;
      received: number | null;
      sent: number | null;
      mailboxes: number;
      partial: boolean;
    }[];
    received: number | null;
    sent: number | null;
    from: string | null;
    to: string | null;
    days: number;
    note: string;
  };
  outreach: {
    people: number;
    new: number;
    known: number;
    historyFrom: string | null;
    windowDays: number;
    lookbackDays: number;
    note: string;
  };
  sendingDomains: SendingDomain[];
  sending: MailSends & {
    domains: number;
    verified: number;
    pending: number;
    failed: number;
    regions: (string | null)[];
    windowDays: number;
    byDay: {
      day: string;
      sent: number;
      delivered: number;
      bounced: number;
      domains: number;
    }[];
    floor: boolean;
    pageCeiling: number;
    walkDays: number;
    oldest: string | null;
    note: string;
  };
  dns: {
    domains: number;
    unread: number;
    records: number | null;
    verified: number | null;
    unhealthy: { domain: string; records: string[]; status: (string | null)[] }[];
  };
  accounts: {
    gmail: {
      id: number;
      label: string;
      address: string | null;
      seenAt: string;
      note: string | null;
    }[];
    resend: {
      id: number;
      label: string;
      domains: number;
      emails: number;
      pages: number;
      oldest: string | null;
      truncated: boolean;
      seenAt: string;
      note: string | null;
    }[];
  };
  /** What was asked and what came back, with the date — the same evidence
   *  block Replicate's and Cloudflare's reports carry. */
  cannot: { what: string; asked: string; answer: string; checked: string }[];
  privacy: string;
};

/* ---------------------------------------------------------------- models */

/**
 * THE LAYER BELOW THE AGENTS, and the distinction is the whole reason there
 * are two sets of types here rather than one.
 *
 * An AGENT (Hermes, OpenClaw) thinks: tools, memory, multi-step work, and
 * exactly one of them answers the Chat page. A PROVIDER completes: turns in,
 * text out, over an OpenAI-shaped wire. Exactly one is the DEFAULT that every
 * agent is pointed at — so "which model" is decided once — and a plain chat
 * with no agent in front of it talks to it directly.
 *
 * A closed union rather than a string, for `ChatBackendId`'s reason: the rule
 * this feature enforces is that one of a known set answers, and that is only
 * checkable if the set is closed.
 */
export type ProviderId = "freellmapi" | "local" | "openai" | "openrouter";

/**
 * How many completions a provider runs at once, and how they are spread.
 *
 * IT IS A SETTING ON THE PROVIDER RATHER THAN ON THE CALLER, because it is a
 * fact about the service: a local model on one GPU wants calls in SERIES —
 * two at once halves the speed of both and can run the card out of memory — and
 * a hosted API wants them in parallel up to a ceiling. Every caller then gets
 * the right behaviour without knowing why.
 */
export type ModelPolicy = {
  mode: "series" | "parallel";
  /** Ignored in series mode. 1 to 64. */
  concurrency: number;
  /** Which endpoint the NEXT call goes to, when there are several. */
  balance: "round-robin" | "least-busy";
  /** Per-call timeout in milliseconds, 5s to 10 minutes. */
  timeoutMs: number;
};

/**
 * One provider, and the six facts that come apart.
 *
 * Connected and not the default; the default and not connected (chosen before
 * a key was pasted); both, which is the only combination that completes. The
 * gate figures are separate because "the model is slow" and "the queue is
 * long" are different complaints with different fixes.
 */
export type ModelProvider = {
  id: ProviderId;
  connected: boolean;
  /** The provider's own name for itself, including which account or how many
   *  endpoints. Null when it is not connected. */
  label: string | null;
  endpoints: number;
  live: boolean;
  default: boolean;
  /** The model id asked for, or null for "whatever the endpoint lists first" —
   *  which is a real answer read from the endpoint, not a blank. */
  model: string | null;
  policy: ModelPolicy;
  /** Whether those four numbers are the owner's or the server's own default.
   *  A page that showed one as the other would be lying quietly. */
  policyIsDefault: boolean;
  policyDefaults: ModelPolicy;
  gate: {
    inFlight: number;
    queued: number;
    /** Only endpoints that have taken a call appear — the gate counts calls,
     *  not endpoints. The panel draws the endpoint list from the plugin and
     *  looks its counter up here. */
    byEndpoint: { baseUrl: string; inFlight: number }[];
  };
};

export type ModelProviders = {
  providers: ModelProvider[];
  chosen: ProviderId | null;
  live: ProviderId | null;
  liveLabel: string | null;
  /** The server's own sentence for "nothing will complete". */
  why: string | null;
};

/** One local endpoint and what it is serving right now — asked live, because a
 *  model is pulled and deleted by a person at a terminal and a list written
 *  down at connect time would be wrong within a day. */
export type LocalEndpoint = {
  accountId: number;
  label: string;
  baseUrl: string;
  /** Whether a bearer is being sent. Never the bearer. */
  hasKey: boolean;
  models: string[];
  /** Why this endpoint could not be asked. A laptop that is closed does not
   *  take the GPU box's model list off the page. */
  error: string | null;
};

export type LocalModels = {
  endpoints: LocalEndpoint[];
  model: string | null;
};

/** One completion, straight through the default provider under its policy. */
export type ProviderReply = {
  text: string;
  provider: ProviderId;
  /** Which endpoint answered — the account's own label. */
  endpoint: string;
  model: string | null;
  usage: { prompt: number; completion: number } | null;
  ms: number;
  /** How long it waited for a slot. Visible, because "the model is slow" and
   *  "the queue is long" want different fixes. */
  queuedMs: number;
};

/* ------------------------------------------------------------------- chat */

/**
 * The agent's two ids. A union rather than a string, because the whole rule
 * this feature enforces — exactly one of these answers — is only checkable if
 * the set is closed.
 */
export type ChatBackendId = "hermes" | "openclaw";

/**
 * WHAT WROTE A MESSAGE DOWN, which is a wider set than what can be an AGENT.
 *
 * When no agent is live but a model provider is, the server answers through
 * the provider directly — a plain chat, with nothing thinking in front of it —
 * and stamps the row `provider:<id>` rather than with an agent's name. A
 * transcript read six weeks later must not attribute a bare completion to
 * Hermes and its tools.
 */
export type ProviderBackendId = `provider:${ProviderId}`;

export type MessageBackendId = ChatBackendId | ProviderBackendId;

/**
 * One message of a transcript, as the server stored it.
 *
 * `backend` is null on the owner's own messages, which is the one place null
 * here means "not applicable" rather than "asked and not told". `model`,
 * `usage` and `ms` are null whenever the agent did not report them — an agent
 * that counts no tokens has not told us the turn was free.
 */
/**
 * ONE TOOL CALL THE AGENT MADE WHILE WRITING AN ANSWER.
 *
 * THERE IS NO RESULT FIELD AND THERE CANNOT BE ONE. The agent's stream carries
 * the tool's name, a one-line label ("date", "ls /etc") and running/completed —
 * and nothing about what came back. A page that drew an output panel here
 * would be drawing an empty box that looks broken, so it draws what is known:
 * what ran, what it was called with, and how long it took.
 *
 * `finishedAt` is null while a call is still going and STAYS null on a turn
 * that was cut off mid-call. `offset` is how many characters of the answer had
 * been written when it started, which is what lets a reloaded transcript put
 * the grey line back between the right two paragraphs instead of in a pile at
 * the end.
 */
export type ChatToolCall = {
  toolCallId: string;
  tool: string;
  label: string | null;
  emoji: string | null;
  startedAt: string;
  finishedAt: string | null;
  offset: number;
};

export type ChatMessage = {
  report?: import("../../../shared/chatReport").ChatReport | null;
  id: number;
  ts: string;
  role: "user" | "assistant" | "system";
  content: string;
  backend: MessageBackendId | null;
  channel: string;
  model: string | null;
  usage: { prompt: number; completion: number } | null;
  ms: number | null;
  /** Null when the turn made no tool calls, and equally when it was not
   *  streamed. The two are the same drawing, so the page does not distinguish
   *  them. */
  tools: ChatToolCall[] | null;
  /**
   * The answer was cut off before the agent finished writing it.
   *
   * Stored rather than dropped, and drawn with the flag showing rather than as
   * a complete reply. Half an answer that the owner watched arrive is real;
   * the two dishonest options are to delete it and to pretend it is whole.
   */
  partial: boolean;
};

/**
 * Who could answer, who is chosen, and who is live — three facts, because they
 * come apart.
 *
 * A backend can be connected and not chosen ("ready, not live"), chosen and
 * not connected (picked before the key was pasted), or both, which is the only
 * combination that answers a message. `why` is the server's own sentence for
 * the cases where nothing will answer, so the page states the reason rather
 * than inferring one from the flags.
 */
/* ------------------------------------------------------ the managed agents */

export type AgentId = "hermes" | "openclaw";

export type AgentInstanceState =
  | "absent"
  | "installing"
  | "installed"
  | "starting"
  | "running"
  | "stopped"
  | "failed";

/**
 * What the agent was last configured to talk to.
 *
 * THERE IS NO KEY ON THIS TYPE AND THERE CANNOT BE ONE. The server writes the
 * provider's bearer into the agent's own config file at mode 0600 and returns
 * this instead — the label, the endpoint and the model, which is everything a
 * page needs to say "pointed at FreeLLMAPI, local instance" and nothing that
 * would be a credential in a browser.
 */
export type AgentPointedAt = {
  provider: string;
  providerLabel: string;
  endpoint: string;
  endpointUrl: string;
  model: string;
  at: string;
  /** The door the agent actually calls: this box's relay, which forwards to
   *  `endpointUrl` through the provider's gate, so the provider's series or
   *  parallel policy binds the agent's calls too. Absent on an agent pointed
   *  before the relay existed. */
  relay?: string;
};

/**
 * One managed agent: what is on disk, what is running, and what it is pointed
 * at.
 *
 * `state` and `live` are two different facts and the panel says both. An agent
 * can be running and not chosen — perfectly legitimate, and the only way to
 * try one without switching the Chat page over to it — and it can be chosen
 * and stopped, which is what the owner sees a moment after pressing Stop.
 *
 * `mode` is the third: which CREDENTIAL answers. A plugin can hold a pasted
 * remote agent and this managed one at the same time, and nothing in "which is
 * connected" can decide between them, so it is a setting rather than a guess.
 */
export type AgentReport = {
  id: AgentId;
  label: string;
  state: AgentInstanceState;
  since: string;
  /** Which install step is running, while installing. Null otherwise. */
  step: string | null;
  /** The last thing that went wrong, or the reason for the current wait. */
  lastError: string | null;
  /** Where it answers when it is up. Loopback, always. */
  url: string;
  port: number;
  /** The model name it advertises on its own endpoint — `hermes-agent`,
   *  `openclaw/default`. Reported by the server, never guessed here. */
  advertises: string;
  version: string | null;
  /** Hermes tracks a branch, so its real version is the commit that landed.
   *  Null for OpenClaw, whose npm version IS the pin. */
  commit: string | null;
  installedAt: string | null;
  installSeconds: number | null;
  dir: string;
  pid: number | null;
  healthyAt: string | null;
  restarts: number;
  /** What the owner last asked for, which survives a restart of the API. */
  autostart: boolean;
  mode: "managed" | "remote";
  managedAccount: number | null;
  pointed: AgentPointedAt | null;
  live: boolean;
  log: string[];
};

/** Both agents, plus the two facts that are about the pair rather than either
 *  of them: which is live, and whether there is a model provider to point one
 *  at in the first place. */
export type AgentsDoc = {
  agents: AgentReport[];
  live: AgentId | null;
  /** Which one has a child process. Not the same question as `live`. */
  running: AgentId | null;
  provider: {
    id: string;
    label: string;
    endpoints: { label: string; baseUrl: string }[];
    defaultModel: string | null;
  } | null;
  why: string | null;
};

export type ChatBackends = {
  readiness?: { ready: boolean; reason: string | null } | null;
  backends: {
    id: ChatBackendId;
    connected: boolean;
    label: string | null;
    live: boolean;
  }[];
  chosen: ChatBackendId | null;
  live: ChatBackendId | null;
  liveLabel: string | null;
  /**
   * Who takes the message when no AGENT is live — the model provider, asked
   * directly. Deliberately its own field rather than folded into `live`:
   * `live` means an agent is thinking, and a raw completion is not one. Null
   * here as well as in `live` is the only state that refuses a message.
   */
  fallback: { provider: ProviderId; label: string; endpoints: number } | null;
  why: string | null;
};

/**
 * WHETHER THIS CONVERSATION IS STILL BEING ANSWERED, as the server sees it.
 *
 * A chat turn is the server's work now (see server/src/chat/runs.ts), so a page
 * that has just reloaded can find one in progress and reattach to it rather
 * than showing the partial row and calling it cut off. `attachable` is the
 * field that decides: it means the events are still buffered and
 * `GET /chat/runs/<id>/events` will replay them. A finished run past its
 * retention window is still reported — with its status and, if it failed, the
 * reason — because "this ended twenty minutes ago" and "there has never been a
 * run here" are different things for a page to draw.
 */
/** What a cancel answers. `cancelling` and NOT a run status: the run has been
 *  ASKED, it still has a partial row to write, and the authority on what
 *  actually happened is the terminal frame on the stream. One participle for
 *  one state — `cancelling`, not `stopping`, because its past tense is the
 *  status it leads to — and it is declared by a type so the two cancel paths
 *  cannot pick different words. */
export type ChatCancelled = { runId: string; status: Cancelling };

export type ChatRunState = {
  runId: string;
  status: RunStatus;
  /** The highest sequence number the run has emitted. A client that has read
   *  up to N asks for the rest with `since=N`. */
  lastSeq: number;
  attachable: boolean;
  startedAt: string;
  error: string | null;
};

export type ChatSession = ChatBackends & {
  sessionId: string;
  messages: ChatMessage[];
  /** Null when nothing has ever answered this conversation. */
  run: ChatRunState | null;
};

/**
 * A conversation the SERVER knows about, which is not the same list as the
 * rail.
 *
 * The rail is the browser's: it holds names the owner typed, chats that have
 * been started and not yet spoken into, and an order. This is the other half —
 * every session id that has a message in it — and the page reconciles the two
 * on load. `title` is a DERIVATION and not a name: the first thing the owner
 * said in that conversation, which is the best guess available to something
 * that was never told what to call it. A name held in the store always wins.
 *
 * `channels` says which doors the conversation came in by. A `telegram:…`
 * session is a real transcript with the same agent and appears here for that
 * reason — hiding it would rebuild the amnesia the shared table exists to
 * prevent.
 */
export type ChatSessionSummary = {
  sessionId: string;
  title: string | null;
  messages: number;
  firstAt: string;
  lastAt: string;
  channels: string[];
  /**
   * RUNS THIS CONVERSATION DISPATCHED — `agent_runs` rows whose
   * `parent_session_id` is this session, newest first. The chief of staff
   * sends a sub-agent to do something mid-chat and the work is filed under the
   * chat that asked for it; the rail nests these under the conversation.
   *
   * OPTIONAL, and that is a statement about deployment rather than about the
   * data. A server built before the sub-agents area simply does not send the
   * field, and a rail that showed nothing is exactly right there — where a
   * required field would have made this client refuse to typecheck against
   * half the servers it has to talk to.
   */
  children?: SessionChild[];
};

/**
 * ONE RUN SHOWN UNDER A CHAT.
 *
 * The same seven fields the server's `RunChild` publishes, from both of its
 * doors — the polled session list and the live SSE frame — and declared HERE
 * rather than in the store, because it arrives off the wire and the store is
 * the second reader of it, not the first. It was typed three times: the SSE
 * frame carried four of the fields, this list carried seven, and the store
 * carried two of them optionally, so a rail drawing a live child could not
 * link it and threw the payload away to re-poll.
 *
 * `to` and `status` are NOT OPTIONAL. A child is a run, a run has a page and a
 * run has a state; the store's copy had both as `?` from a time when a child
 * could be another chat, and that optionality is what made the rail invent a
 * `/chat/<id>` fallback for a URL the server always sends.
 */
export type SessionChild = {
  /** `run:<runId>`, so it can never collide with a session id. */
  id: string;
  runId: string;
  title: string;
  kind: string;
  app: string;
  status: RunStatus;
  /** The exact worker conversation, or its Outputs page when it has no worker. */
  to: string;
};

export type ChatSessionsDoc = {
  sessions: ChatSessionSummary[];
  total: number;
};

/* ------------------------------------------------------ the streamed turn */

/**
 * What arrives while the agent is writing.
 *
 * ONE HANDLER OBJECT RATHER THAN AN ASYNC ITERATOR the caller pumps. The page
 * is a React component: every event ends in a state update, and a `for await`
 * in an event handler is a loop the component cannot be unmounted out of. The
 * callbacks are called synchronously as frames arrive, and `chatStream`
 * resolves when the turn is over, which is the shape the composer wants —
 * `await` it, then re-enable the button.
 *
 * `onDone` AND `onError` ARE EXCLUSIVE and exactly one fires per turn, which
 * is the server's guarantee and not this file's. Both are emitted only after
 * the row they describe has been written, so a caller that has seen either can
 * reload and find the same words.
 */
export type ChatStreamHandlers = {
  onStart?: (e: {
    sessionId: string;
    userMessageId: number;
    user: ChatMessage;
    backend: MessageBackendId;
    backendLabel: string | null;
    /** The server-owned run this turn belongs to. What the stop button cancels,
     *  and what a page that reloads mid-answer reattaches to. */
    runId?: string;
  }) => void;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** A sub-agent run was filed under this conversation mid-answer. The rail
   *  re-reads on it; nothing about the answer itself changes. */
  onChild?: (e: { runId: string; kind: string; title: string; status: string }) => void;
  onTool?: (e: {
    toolCallId: string;
    tool: string;
    label: string | null;
    emoji: string | null;
    status: "running" | "completed";
    at: string;
    offset: number;
  }) => void;
  onDone?: (e: {
    messageId: number;
    message: ChatMessage;
    text: string;
    model: string | null;
    usage: { prompt: number; completion: number } | null;
    ms: number;
    tools: ChatToolCall[];
    /**
     * How long this turn waited for a model slot before it was sent.
     *
     * OPTIONAL, AND HONESTLY SO. The provider layer measures it — it is on
     * `ProviderReply` above and the Models page already shows it — but the
     * chat stream's `done` frame does not carry it today, so a page that
     * assumed a number here would be drawing one it was never given. Read
     * when it is there, ignored when it is not: `ms` is how long the model
     * took, this is how long the queue was, and they want different fixes.
     */
    queuedMs?: number;
  }) => void;
  /** The turn failed. `partial` says whether the words already on screen were
   *  stored — the difference between "that is now in the transcript, marked
   *  incomplete" and "nothing was kept". `cancelled` is the owner's own stop,
   *  which is not a failure and must not be drawn as one. */
  onError?: (e: {
    message: string;
    messageId: number | null;
    partial: boolean;
    cancelled?: boolean;
  }) => void;
};

/** What a sent message comes back as: both rows, plus the reply's own facts
 *  at the top level for a caller that wants the answer and not the row. */
export type ChatReply = {
  sessionId: string;
  user: ChatMessage;
  reply: ChatMessage;
  backend: MessageBackendId;
  model: string | null;
  usage: { prompt: number; completion: number } | null;
  ms: number;
};

/* ------------------------------------------------------- the mailbox app */

/*
  THESE ARE THE ONLY TYPES IN THIS FILE THAT CAN HOLD A SUBJECT OR A BODY, AND
  THAT IS A DECISION RATHER THAN AN OVERSIGHT.

  Everything above reads a document a collector wrote, out of tables whose
  schema has no column for a message — which is what lets `MailReport` claim
  that nothing private is on its wire without having to redact anything. This
  block reads a live mailbox, so the private data IS the product: a thread list
  that hid the sender would be a list of nothing.

  What replaces the schema as the guarantee is that these objects have no
  destination. They are fetched, rendered, and dropped when the page unmounts;
  nothing here is written to `localStorage`, and the store in `lib/store.tsx`
  has no field that could hold one. The server keeps the other half of the same
  rule — see `routes/mailbox.ts`.
*/

/** Which venture mailbox a thread arrived at: a bare domain, `"gmail"`, or
 *  null. NULL IS "NONE OF OURS" HERE — a mailing list, a Bcc, mail that reached
 *  the account some other way — because this server always looks. An earlier
 *  version of this field had a third reading, "the server never said", which
 *  this one cannot: there is no build of this API that omits it. */
export type MailboxKey = string | null;

export type MailboxChip = {
  /** What `?mailbox=` takes. A domain, or "gmail". */
  key: string;
  kind: "gmail" | "domain";
  domain: string | null;
  address: string | null;
  /** THE DOMAIN'S OWN NAME. The server deliberately does not name a chip after
   *  a venture: ventures live in this browser's store and carry no domain
   *  field, so the match is made on the page — and a domain matching no venture
   *  keeps this label rather than being given an invented one. */
  label: string;
  accountId: number;
  accountLabel: string;
  status: string | null;
};

export type MailboxChips = {
  connected: boolean;
  gmail: MailboxChip | null;
  accounts: { id: number; label: string }[];
  mailboxes: MailboxChip[];
  labelling: string;
};

export type MailThread = {
  id: string;
  subject: string;
  from: string;
  fromName: string;
  to: string;
  /** Unix milliseconds. Null when Gmail reported no date for any message. */
  at: number | null;
  snippet: string;
  unread: boolean;
  labels: string[];
  /** How many messages the conversation holds — the "(3)" Gmail shows. */
  messages: number;
  mailbox: MailboxKey;
};

export type MailThreadPage = {
  readAt?: string;
  accountId: number;
  accountLabel: string;
  address: string | null;
  /** The Gmail query that actually ran. Shown on an empty result, because "no
   *  mail" and "the chip and the box asked for something impossible" look
   *  identical without it. */
  query: string;
  mailbox: string | null;
  mailboxIgnored: string | null;
  threads: MailThread[];
  /** Gmail's own opaque cursor, not an ordinal. */
  nextPage: string | null;
  dropped: number;
  limit: number;
};

export type MailAttachment = {
  filename: string;
  mimeType: string;
  size: number | null;
};

export type MailMessage = {
  id: string;
  /** The RFC 5322 `Message-ID` header — what a reply must reference. Gmail's
   *  own id threads replies inside this mailbox and means nothing to the
   *  recipient's mail client. */
  messageId: string | null;
  from: string;
  fromName: string;
  to: string;
  cc: string;
  subject: string;
  at: number | null;
  unread: boolean;
  labels: string[];
  text: string;
  /** A COMPLETE DOCUMENT, sanitised on the server and carrying its own CSP.
   *  It goes straight into a sandboxed frame's `srcDoc`; nothing on this side
   *  parses it, rewrites it, or wraps it in anything. */
  html: string | null;
  /** How many remote images are being withheld. Zero means the button to load
   *  them is not drawn, which is most personal mail. */
  remoteImages: number;
  imagesLoaded: boolean;
  attachments: MailAttachment[];
};

export type MailThreadDoc = {
  id: string;
  accountId: number;
  mailbox: MailboxKey;
  subject: string;
  messages: MailMessage[];
};

export type SentByApp = {
  id: string;
  domain: string;
  /** ISO instant. Resend's own stamp, normalised. */
  at: string;
  from: string;
  to: string[];
  subject: string;
  lastEvent: string | null;
};

export type SentPage = {
  domain: string | null;
  emails: SentByApp[];
  /** Only a single-domain view has a cursor: each key sees its own domain, so
   *  there is no cursor that means anything across ten independent lists. */
  nextPage: string | null;
  pageable: boolean;
  domains: (string | null)[];
  domainsRead: number;
  /** Keys restricted to sending since they were pasted — their domain can send
   *  and cannot be read back, which is not "this domain sent nothing". */
  restricted: string[];
  truncated: number;
};

export type SentEmailDoc = {
  id: string;
  domain: string;
  at: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  lastEvent: string | null;
  messageId: string | null;
  text: string;
  html: string | null;
  remoteImages: number;
  imagesLoaded: boolean;
  /** Always empty: Resend returns no attachment bytes and lists none. The
   *  field exists so one reader component renders both sides. */
  attachments: MailAttachment[];
};

/* --------------------------------------------------------- the board app */

/**
 * A card, exactly as the server hands it over.
 *
 * `ventureId` and nothing else about the venture. The server has never seen a
 * venture — they live in lib/store.tsx and are mirrored to localStorage — so
 * the document cannot carry a name or a colour and does not pretend to. The
 * page looks the id up in the store; one that resolves to nothing is drawn as
 * unfiled, which is the truth about a card whose venture was deleted.
 */
/* -------------------------------------------------------------- ventures */

/**
 * THE VENTURES LIVE ON THE SERVER NOW, and this is their wire shape.
 *
 * They were a list in localStorage — four names, four colours — for as long as
 * nothing but this browser needed them. Two things ended that. The agent has
 * to be able to read them (a venture's STAGE is the whole reason it can give
 * advice worth having, and an idea and a launched product want opposite
 * answers), and the board already stores a `venture_id` on every card, so half
 * the fact was on the server and half of it was in one browser.
 *
 * Any seeded ids are preserved across that move, because cards and chats
 * already name them.
 */
export type VentureStage = "idea" | "pre-launch" | "launched";

/**
 * WHAT WAS MEASURED FROM THE SITE, and what could not be.
 *
 * Every field is nullable and `notes` carries the reasons, because this is a
 * reading of somebody else's HTML: a site with no icon link, a stylesheet on
 * another origin, a favicon too big to store. A null favicon means the site
 * could not be read for one — never that it has none — and the pages say so
 * in those words rather than drawing a blank square.
 */
export type VentureBrand = {
  /** A data: URL, so it survives the site going down. Null when none was
   *  found or it was too big to keep. */
  favicon: string | null;
  /** Where it was fetched from — the evidence behind the picture. */
  faviconSource: string | null;
  title: string | null;
  description: string | null;
  /** An absolute URL, deliberately NOT downloaded. */
  ogImage: string | null;
  themeColor: string | null;
  lang: string | null;
  palette: {
    primary: string | null;
    secondary: string | null;
    accent: string | null;
    background: string | null;
    ink: string | null;
    /** The top eight colours the roles above were assigned FROM, with the
     *  weight each carried. Shown on the venture's Brand card so a reader can
     *  see the evidence rather than the verdict. */
    ranked: { hex: string; weight: number }[];
  };
  fonts: string[];
  /** ISO. Null means the site has never been read. */
  enrichedAt: string | null;
  /** Why the last read failed OUTRIGHT — the site was unreachable. Null when
   *  it worked, including when it worked and found nothing. */
  error: string | null;
  /** What could not be measured, and why. */
  notes: string[];
};

export type Venture = {
  businessType?: BusinessType | null;
  businessTypes?: BusinessType[];
  id: string;
  /**
   * The URL segment: /ventures/<slug>. SET ONCE AT CREATION and never moved by
   * a rename — the same rule a dashboard's slug follows, for the same reason.
   */
  slug: string;
  name: string;
  /** "What it is", in the owner's own words. "" when none — never null, so
   *  nothing has to decide what an absent description means. */
  description: string;
  website: string | null;
  /** The hostname without a leading "www.". This is what a venture dashboard
   *  narrows its data to. */
  host: string | null;
  stage: VentureStage;
  color: string;
  /** Whether the colour was typed by the owner, measured from the site, or one
   *  of the seven defaults. The Brand card says which. */
  colorSource: "owner" | "site" | "default";
  position: number;
  brand: VentureBrand;
  createdAt: string;
  updatedAt: string;
};

/** What `GET /api/ventures` answers: the list in the owner's order, the counts
 *  by stage, and the sentence each stage means — the server owns that copy so
 *  the agent and this app cannot drift about what "pre-launch" is. */
export type VentureList = {
  ventures: Venture[];
  counts: Record<VentureStage, number>;
  stages: Record<VentureStage, string>;
};

/**
 * The three stages and what each one means, as this client will say it when
 * the server has not answered yet.
 *
 * A COPY OF THE SERVER'S SENTENCES, ON PURPOSE, and the form prefers the ones
 * that arrive on the wire. The alternative is a "New venture" page that cannot
 * describe its own choices until a fetch lands, which is the one moment those
 * sentences are actually being read.
 */
export const VENTURE_STAGES: { id: VentureStage; label: string; note: string }[] = [
  {
    id: "idea",
    label: "Idea",
    note: "Not built yet. Validate demand, size it, decide whether to build.",
  },
  {
    id: "pre-launch",
    label: "Pre-launch",
    note: "Being built or about to ship. Get to a first release: launch checklist, landing page, first users.",
  },
  {
    id: "launched",
    label: "Launched",
    note: "Live and serving people. Grow it, keep it healthy, watch revenue and churn.",
  },
];

/** A create body. Only the name is required — a venture typed in a hurry has
 *  to be able to exist before it has a website. */
export type VentureInput = {
  businessType?: BusinessType | null;
  businessTypes?: BusinessType[];
  name: string;
  description?: string;
  website?: string | null;
  stage?: VentureStage;
  color?: string | null;
};

/** A partial edit: a field left out is untouched, a field sent as `null` is
 *  CLEARED. The same contract the board's card patch keeps, and what makes
 *  "forget the website" an instruction rather than an omission. */
export type VenturePatch = {
  businessType?: BusinessType | null;
  businessTypes?: BusinessType[];
  expectedUpdatedAt?: string;
  stageChangeNote?: string;
  name?: string;
  description?: string | null;
  website?: string | null;
  stage?: VentureStage;
  /** A hex sets `colorSource: "owner"`; null reverts to the site's measured
   *  primary, or a default when nothing was measured. */
  color?: string | null;
};

export type BoardCard = {
  id: number;
  columnId: number;
  /** The server's sparse sort key within its column. Nothing here sorts by
   *  it — the cards arrive in order and stay in order under an optimistic
   *  splice — and nothing ever sends one back: a move says which NEIGHBOUR the
   *  card landed above, and the server works out what number that means. */
  position: number;
  title: string;
  body: string | null;
  ventureId: string | null;
  /** 0 low · 1 normal · 2 high · 3 urgent. An order, so it is a number. */
  urgency: number;
  /** A day, 'YYYY-MM-DD', or null for a card with no date. Null is "not
   *  given", which is why it is not an empty string. */
  due: string | null;
  /** When it reached Done. Set by the move that put it there and cleared by
   *  one that takes it out. */
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Non-null only on a card something FILED rather than somebody typing it.
   *  Nothing files today; see the seam at the foot of routes/board.ts. */
  origin: string | null;
};

export type BoardColumn = {
  id: number;
  /** The stable name the code means, which a rename does not change. */
  key: string;
  /** The visible name, which a rename does. */
  title: string;
  position: number;
  /** Null is no limit set — a real third answer beside a limit of 0, which is
   *  a column nothing may sit in. */
  wipLimit: number | null;
  /** Backlog and Done. Named so the page can hide a control rather than offer
   *  a press the server would refuse. */
  structural: boolean;
  count: number;
  /** Decided on the server, where the count and the limit both are. Two places
   *  deciding what "over" means is how a column ends up drawn calm while its
   *  own number says otherwise. */
  overLimit: boolean;
  cards: BoardCard[];
};

/**
 * The whole board in one document — which is also what EVERY mutation answers
 * with, so a write never needs a second fetch to find out what it did.
 *
 * That is the contract the optimistic drag on the Board page rests on: apply
 * the guess, send the move, replace the guess with the reply. A move can
 * change the positions of cards nobody touched, so a reply of "the card as it
 * now is" would leave the page to guess at the rest of the column.
 */
export type BoardDoc = {
  columns: BoardColumn[];
  /**
   * The ventures the cards on this board actually name, resolved at read time.
   *
   * OPTIONAL, because a server that has not shipped this yet is an ordinary
   * thing for a page to meet and the store's own cache is the fallback. When
   * it is here it WINS: it is resolved from the ventures table on the same
   * request that returned the cards, where the store's copy is whatever this
   * browser last fetched. A card whose venture was deleted resolves to nothing
   * and is drawn unfiled, which is the behaviour that was already true.
   */
  ventures?: Record<
    string,
    { name: string; slug: string; color: string; stage: VentureStage }
  >;
  totals: {
    cards: number;
    done: number;
    /** Out of the way, not gone — not in `columns` above, and not deleted. */
    archived: number;
  };
};

/** A partial edit. A field left out is untouched; a field sent as `null` is
 *  cleared. That is what lets the dialog send the one field that changed
 *  rather than resending a whole card over somebody else's edit — and what
 *  makes "remove the due date" an instruction rather than an omission. */
export type BoardCardPatch = {
  title?: string;
  body?: string | null;
  urgency?: number;
  due?: string | null;
  ventureId?: string | null;
};

export const api = {
  health: () =>
    call<{ ok: boolean; collectors: string[]; collectEveryMinutes: number }>(
      "/health",
    ),

  plugins: () =>
    call<{ plugins: ServerPlugin[]; configurable: string[] }>("/plugins"),

  plugin: (id: string) => call<ServerPlugin>(`/plugins/${id}`),

  /** The single-account door: the first account, or the only one. The server
   *  refuses it once there are several, because "the credential" has no
   *  referent then. */
  connect: (id: string, fields: Record<string, string>) =>
    call<
      ServerPlugin & { verified: boolean; collected: CollectSummary | null }
    >(`/plugins/${id}`, { method: "PUT", body: JSON.stringify({ fields }) }),

  /** Every account of this plugin, forgotten. */
  disconnect: (id: string) =>
    call<ServerPlugin>(`/plugins/${id}`, { method: "DELETE" }),

  addAccount: (id: string, label: string, fields: Record<string, string>) =>
    call<ServerPlugin & { verified: boolean; accountId: number }>(
      `/plugins/${id}/accounts`,
      { method: "POST", body: JSON.stringify({ label, fields }) },
    ),

  /** Rename an account, replace its credentials, or both. A field left out of
   *  `fields` keeps the value already in the vault — which is what makes
   *  "change just the secret" a thing that can be verified as a pair. */
  updateAccount: (
    id: string,
    accountId: number,
    body: { label?: string; fields?: Record<string, string> },
  ) =>
    call<ServerPlugin & { verified: boolean }>(
      `/plugins/${id}/accounts/${accountId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  removeAccount: (id: string, accountId: number) =>
    call<ServerPlugin>(`/plugins/${id}/accounts/${accountId}`, {
      method: "DELETE",
    }),

  collect: (id: string) =>
    call<ServerPlugin & { collected: CollectSummary }>(
      `/plugins/${id}/collect`,
      {
        method: "POST",
      },
    ),

  hetznerSummary: () => call<HetznerSummary>("/hetzner/summary"),

  hetznerServers: () =>
    call<{ servers: HetznerServer[]; seenAt: string | null }>(
      "/hetzner/servers",
    ),

  hetznerLoad: (hours = 24) => call<HetznerLoad>(`/hetzner/load?hours=${hours}`),

  hetznerVolumes: () =>
    call<{ volumes: HetznerVolume[]; seenAt: string | null }>(
      "/hetzner/volumes",
    ),

  stock: (days = 30) => call<StockReport>(`/stock?days=${days}`),

  domains: () =>
    call<{ domains: Domain[]; summary: DomainSummary }>("/domains"),

  /** The whole costs board in one fetch — three providers, three shapes of
   *  answer, and no total across the two currencies in play. */
  costs: (days = 30) => call<CostsReport>(`/costs?days=${days}`),

  /** The whole GitHub board in one fetch: the repos, the daily traffic line
   *  and the summary — including what is left of the hour's API budget. */
  github: () => call<Github>("/github"),

  /** Downloads by day and by ISO week, bucketed server-side on every read. */
  npm: () => call<Npm>("/npm"),

  /** A plugin's non-secret settings. Unlike a credential, these read back. */
  pluginConfig: (id: string) => call<PluginConfig>(`/plugins/${id}/config`),

  savePluginConfig: (id: string, config: Record<string, string>) =>
    call<PluginConfig & { connected: boolean; collected: unknown }>(
      `/plugins/${id}/config`,
      { method: "PUT", body: JSON.stringify({ config }) },
    ),

  /** Both app stores in one fetch — estimates and payouts kept apart, every
   *  figure in the currency it was earned in, and no total across them. */
  mobile: (days = 30) => call<MobileReport>(`/mobile?days=${days}`),

  /** The whole Stripe board in one fetch: the book, the ledger, the attempts
   *  and the balance. Two currencies would arrive as two rows, never as one
   *  sum. */
  /** `"all"` is the ledger's own reach — the route measures it from the
   *  earliest history any account holds, which on this box is 2021. */
  stripe: (days: number | "all" = 30) => call<StripeReport>(`/stripe?days=${days}`),

  /** AdSense, which answers even when nothing has authorised it — the
   *  not-authorised state is the point, not an error to swallow. */
  adsense: (days = 30) => call<AdSenseReport>(`/adsense?days=${days}`),

  /** The zones, what they served over complete UTC days, and the join between
   *  the nameservers Cloudflare assigned and the ones the registrar actually
   *  delegates to. Today is in the document and in none of its totals. */
  cloudflare: (days = 7) => call<CloudflareReport>(`/cloudflare?days=${days}`),

  /** Search Console: every verified property, its finalised daily line, and
   *  what fraction of it the ranked query rows actually cover. */
  gsc: (days = 90) => call<GscReport>(`/gsc?days=${days}`),

  /** Bing Webmaster, on its own route rather than beside Google's — the two
   *  count different searches on different networks and nothing adds them. */
  bing: (days = 90) => call<BingReport>(`/bing?days=${days}`),

  /** The Pages, the ad account and what it spent — and, in the same document,
   *  the Instagram answer, because Instagram is a field on a Page rather than
   *  an API of its own. There is deliberately no `api.instagram()`. */
  meta: (days = 30) => call<MetaReport>(`/meta?days=${days}`),

  /** Reddit, Hacker News and the search node behind both, in one document —
   *  because a thread is a thread whichever site it was posted on, and that
   *  count is the one figure that legitimately spans them. Upvotes are not:
   *  the document says so rather than leaving it to be inferred. */
  demand: (days = 30) => call<DemandReport>(`/demand?days=${days}`),

  /** Mail: the mailboxes and the sending domains in ONE document, because the
   *  Email page asks one question of two ends of the same pipe. There is
   *  deliberately no `api.gmail()` and no `api.resend()` — a page that fetched
   *  two documents and joined them is a page that eventually joins them
   *  wrongly. No figure on it spans the two halves. */
  mail: (days = 30) => call<MailReport>(`/mail?days=${days}`),

  /* ------------------------------------------------------- the mailbox app */

  /*
    A SECOND SET OF MAIL CALLS BESIDE `mail()`, AND THEY ARE NOT THE SAME KIND
    OF CALL. `api.mail()` reads a collected document and is cheap, cacheable
    and safe to fire on every page load. Everything below reaches Gmail or
    Resend inside the request: it costs real quota, it takes a second or two,
    and its answer is a person's mail. They are kept apart here so that
    nothing accidentally puts a thread body on a dashboard.
  */

  /** The chips: every connected Resend domain, plus the Gmail account itself.
   *  Cheap — it reads account rows and collected domain rows and touches no
   *  provider — so the page asks for it before it asks for any mail. */
  mailboxes: () => call<MailboxChips>("/mailbox/mailboxes"),

  /**
   * One page of threads.
   *
   * `mailbox` is a Gmail QUERY on the server and never a filter over rows
   * already fetched — filtering 25 rows in the browser would report "3
   * threads" for a venture with hundreds. `page` is Gmail's own opaque cursor
   * from the previous answer, not an ordinal.
   */
  mailboxThreads: (opts: {
    q?: string;
    mailbox?: string | null;
    page?: string | null;
    account?: number;
    limit?: number;
    refresh?: boolean;
  } = {}) => {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.mailbox) p.set("mailbox", opts.mailbox);
    if (opts.page) p.set("page", opts.page);
    if (opts.account) p.set("account", String(opts.account));
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.refresh) p.set("refresh", "1");
    const qs = p.toString();
    return call<MailThreadPage>(`/mailbox/threads${qs ? `?${qs}` : ""}`);
  },

  /**
   * One thread, whole.
   *
   * `images` names the ONE message whose remote pictures should be fetched, or
   * "all". It re-reads the thread rather than unhiding something already
   * delivered, because the only way to be sure the browser cannot load a
   * tracking pixel is for the URL never to reach it.
   */
  mailboxThread: (id: string, opts: { images?: string; account?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.images) p.set("images", opts.images);
    if (opts.account) p.set("account", String(opts.account));
    const qs = p.toString();
    return call<MailThreadDoc>(
      `/mailbox/threads/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`,
    );
  },

  /**
   * Mark a thread read, or unread. THE ONE WRITE THIS DASHBOARD MAKES.
   *
   * It reaches a function in the server's Gmail provider that can only ever
   * add or remove the UNREAD label — there is no archive, trash or send behind
   * it, and no argument here that could find one. It exists because an opened
   * thread that stays bold is a mail client nobody believes.
   */
  mailboxMarkRead: (id: string, unread = false, account?: number) =>
    call<{ threadId: string; unread: boolean }>(
      `/mailbox/threads/${encodeURIComponent(id)}/read`,
      { method: "POST", body: JSON.stringify({ unread, account }) },
    ),

  /** What the products sent people. Without a domain it merges one page from
   *  each connected key, newest first; with one it reads that key alone and
   *  can be paged. */
  mailboxSent: (opts: { domain?: string | null; page?: string | null } = {}) => {
    const p = new URLSearchParams();
    if (opts.domain) p.set("domain", opts.domain);
    if (opts.page) p.set("page", opts.page);
    const qs = p.toString();
    return call<SentPage>(`/mailbox/sent${qs ? `?${qs}` : ""}`);
  },

  /** One sent email, body and all. The domain is part of the address because
   *  each Resend key can see only its own domain — "which key" is not a hint,
   *  it is where the resource lives. */
  mailboxSentEmail: (domain: string, id: string, images = false) =>
    call<SentEmailDoc>(
      `/mailbox/sent/${encodeURIComponent(domain)}/${encodeURIComponent(id)}${images ? "?images=1" : ""}`,
    ),

  /** The Telegram bridge: which bot, which chat it is paired with, whether the
   *  poller is actually running, and how many messages from other chats it has
   *  thrown away. The one integration whose interesting state is not a
   *  collection but a loop. */
  telegram: () => call<TelegramReport>("/telegram"),

  /** Un-pair a bot so it can be handed to a different chat. The next message
   *  it receives, from anyone, pairs it again — and the previous chat's
   *  conversation is forgotten with the pairing. Omit `accountId` when there
   *  is one bot; with several the server refuses and names them rather than
   *  guessing which pairing to break. */
  telegramUnlock: (accountId?: number) =>
    call<{ accountId: number; unlocked: boolean; forgot: number; next: string }>(
      accountId === undefined ? "/telegram/lock" : `/telegram/lock/${accountId}`,
      { method: "DELETE" },
    ),

  /* ------------------------------------------------------ the search node */

  /** What is installed under `data/searxng/` and what is running, including
   *  the install's step and the tail of its output — which is the only thing
   *  a page can honestly show during four minutes of compiling. */
  searxngInstance: () => call<SearxngInstance>("/searxng/instance"),

  /** Begin the install. Answers 202 with the state as it stands: nothing is
   *  installed yet when this returns, and the panel polls until it is. */
  searxngInstall: () =>
    call<SearxngInstance>("/searxng/instance/install", { method: "POST" }),

  /** Spawn it. Comes back as soon as the process exists — `running` arrives
   *  when /healthz answers, which is a second or two later. */
  searxngStart: () =>
    call<SearxngInstance>("/searxng/instance/start", { method: "POST" }),

  /** Stop it, and stop it coming back at the next API boot. SIGTERM, then
   *  SIGKILL after a grace: the server never leaves a child on the port. */
  searxngStop: () =>
    call<SearxngInstance>("/searxng/instance/stop", { method: "POST" }),

  /* ------------------------------------------------------ the model gateway */

  /** The whole FreeLLMAPI picture in one document: what is installed under
   *  `data/freellmapi/`, what is running, both accounts, which one a
   *  completion would go to, and what that endpoint says it can serve. One
   *  fetch because the panel wants all of it at once and a page that asked
   *  twice would render a running instance beside a stale account list. */
  freellmapi: () => call<FreeLlmApiDoc>("/freellmapi"),

  /** Begin the install: a clone, eight hundred packages, two builds and the
   *  migration that mints the key. Answers 202 — nothing is installed when it
   *  returns, and the panel polls `step` and `log` until it is. */
  freellmapiInstall: () =>
    call<FreeLlmApiDoc>("/freellmapi/instance/install", { method: "POST" }),

  /** Spawn it. Comes back as soon as the process exists; `running` arrives
   *  when /livez answers, and the local account is connected at that moment
   *  with a key read from the gateway's own database. */
  freellmapiStart: () =>
    call<FreeLlmApiDoc>("/freellmapi/instance/start", { method: "POST" }),

  /** Stop it, and stop it coming back at the next API boot. SIGTERM, then
   *  SIGKILL after a grace: the server never leaves a child on 3001. */
  freellmapiStop: () =>
    call<FreeLlmApiDoc>("/freellmapi/instance/stop", { method: "POST" }),

  /** Re-read the managed instance's key and re-seal it — the one button for
   *  "I rotated it on its own Keys page". There is nothing to paste: the value
   *  is already on this machine and never travels through the browser. */
  freellmapiReconnect: () =>
    call<FreeLlmApiDoc>("/freellmapi/instance/reconnect", { method: "POST" }),

  /** Choose which endpoint answers, or `null` for automatic — the local
   *  instance while it is running, the hosted one otherwise. Comes back with
   *  the whole document, so a choice that turns out not to be connected says
   *  so without a second request. */
  freellmapiUseAccount: (accountId: number | null) =>
    call<FreeLlmApiDoc>("/freellmapi/account", {
      method: "PUT",
      body: JSON.stringify({ accountId }),
    }),

  /**
   * Make FreeLLMAPI the provider every agent completes through.
   *
   * IT WRITES THE SEAM'S SETTING RATHER THAN ONE OF ITS OWN — the same
   * `PUT /api/models/provider` the models page uses, because there is exactly
   * one default and two ways of setting it would be two settings. The reply is
   * deliberately untyped here: this call cares only that it succeeded, and the
   * panel re-reads its own document afterwards. Typing the models page's
   * document is that page's business.
   */
  freellmapiMakeDefault: () =>
    call<unknown>("/models/provider", {
      method: "PUT",
      body: JSON.stringify({ provider: "freellmapi" }),
    }),

  metric: (name: string, days = 30) =>
    call<{ metric: string; points: { ts: string; value: number }[] }>(
      `/metrics/${name}?days=${days}`,
    ),

  /* ----------------------------------------------------------------- chat */

  /** Which agents could answer and which one will. Cheap on the server — no
   *  credential is decrypted to answer it — so the Chat page is free to ask on
   *  every load. */
  chatBackends: () => call<ChatBackends>("/chat/backends"),

  /** Choose the one that answers, or `null` for none. Comes back with the
   *  whole state, so a choice that turns out not to be connected says so
   *  without a second request. */
  setChatBackend: (backend: ChatBackendId | null) =>
    call<ChatBackends>("/chat/backend", {
      method: "PUT",
      body: JSON.stringify({ backend }),
    }),

  /** One conversation's stored messages, oldest first, with the backend state
   *  alongside — both are wanted at the same moment and this is one fetch. */
  chatSession: (sessionId: string) =>
    call<ChatSession>(`/chat/${encodeURIComponent(sessionId)}/messages`),

  /**
   * Say something.
   *
   * The MESSAGE goes up, not the transcript: the server holds the history so
   * that this page and the Telegram bridge are two doors onto one
   * conversation rather than two conversations. A 503 here means no agent is
   * live and carries the sentence to show; a 502 means the agent was reached
   * and failed.
   */
  chatSend: (sessionId: string, message: string, ventureId?: string | null) =>
    call<ChatReply>("/chat", {
      method: "POST",
      body: JSON.stringify({ sessionId, message, ventureId: ventureId ?? null }),
    }),

  /**
   * Say something, and watch it being written.
   *
   * WHY THIS IS `fetch` AND NOT `EventSource`. EventSource is the browser's
   * built-in SSE client and it is the wrong one here for three separate
   * reasons, any of which would be enough: it can only issue a GET, so the
   * message would have to go in the URL; it cannot set a header; and it
   * RECONNECTS on its own, which on a chat endpoint means silently asking the
   * same question again and paying for it twice. So: a POST, a readable body,
   * and the frame parser below.
   *
   * The `AbortSignal` is the stop button. Aborting closes the body, which
   * closes the connection, which the server sees as a disconnect and turns
   * into an aborted call to the agent — the whole chain, from a click to the
   * gateway giving up, is that one signal. What has already been said is
   * stored as a partial answer at the far end, so stopping loses nothing that
   * was on screen.
   */
  chatStream: async (
    sessionId: string,
    message: string,
    handlers: ChatStreamHandlers,
    signal?: AbortSignal,
    /**
     * WHICH VENTURE THIS QUESTION IS ABOUT, when it is about one.
     *
     * Context rather than instruction: the server turns it into one system
     * turn naming the venture, its stage and what the owner said it is, so
     * "how is it doing this month" has a referent. It is not stored with the
     * message — the venture a chat is filed under can change, and a transcript
     * that carried last week's answer to that question would be wrong twice.
     * An id the server does not recognise is ignored rather than refused: a
     * stale id in this browser is not a reason to lose the message.
     */
    ventureId?: string | null,
  ): Promise<void> => {
    const res = await fetch(`${BASE}/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ sessionId, message, ventureId: ventureId ?? null }),
      signal,
    });

    /*
      A REFUSAL IS STILL AN ORDINARY HTTP ERROR. "No agent is connected" and
      "that message is too long" are decided before the stream opens and come
      back as JSON with a status, so they throw an ApiError exactly like every
      other call in this file and the page's existing error handling catches
      them unchanged. Only failures that happen AFTER the agent was reached
      arrive as an `error` event.
    */
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      throw new ApiError(
        res.status,
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`,
      );
    }
    if (!res.body) throw new ApiError(502, "The API opened a stream with nothing in it.");

    /*
      THE SAME PARSER THE SERVER USES ON THE AGENT'S STREAM, for the same
      reasons and with the same two traps. `res.body` is BYTES: a chunk can end
      mid-character (TextDecoder with `stream: true` holds the split one until
      the rest arrives) and mid-frame (only a blank line dispatches). The naive
      `split("\n\n")` version works until the first answer with an emoji in it
      lands on a buffer boundary.
    */
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event: string | null = null;
    let data: string[] = [];

    const dispatch = () => {
      if (data.length) {
        const raw = data.join("\n");
        data = [];
        const name = event;
        event = null;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* A malformed frame is one lost event, not a lost turn. The answer
             so far is still real and the next frame is probably fine. */
          return;
        }
        switch (name) {
          case "start":
            handlers.onStart?.(parsed as Parameters<
              NonNullable<ChatStreamHandlers["onStart"]>
            >[0]);
            break;
          case "delta":
            handlers.onDelta?.((parsed as { text: string }).text);
            break;
          case "reasoning":
            handlers.onReasoning?.((parsed as { text: string }).text);
            break;
          case "child":
            handlers.onChild?.(parsed as Parameters<NonNullable<ChatStreamHandlers["onChild"]>>[0]);
            break;
          case "tool":
            handlers.onTool?.(parsed as Parameters<
              NonNullable<ChatStreamHandlers["onTool"]>
            >[0]);
            break;
          case "done":
            handlers.onDone?.(parsed as Parameters<
              NonNullable<ChatStreamHandlers["onDone"]>
            >[0]);
            break;
          case "error":
            handlers.onError?.(parsed as Parameters<
              NonNullable<ChatStreamHandlers["onError"]>
            >[0]);
            break;
          /* An event this build does not know about is skipped rather than
             guessed at. A newer server may say more than an older page reads. */
        }
      } else {
        event = null;
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));

          if (line === "") {
            dispatch();
            continue;
          }
          /* A comment — servers send these to keep an idle proxy from hanging
             up, and they are not events. */
          if (line.startsWith(":")) continue;

          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value2 = colon === -1 ? "" : line.slice(colon + 1);
          /* Exactly one leading space is stripped, per the spec: `data:  x`
             carries a value that starts with a space. */
          if (value2.startsWith(" ")) value2 = value2.slice(1);

          if (field === "event") event = value2;
          else if (field === "data") data.push(value2);
        }
      }
      /* A stream that ends without a trailing blank line still has a frame in
         hand, and it is usually the `done`. */
      dispatch();
    } finally {
      await reader.cancel().catch(() => {});
    }
  },

  /** Every conversation the server has messages for. The rail reconciles
   *  against this on load — see `ChatSessionSummary` for which half of a
   *  session each side owns. */
  chatSessions: () => call<ChatSessionsDoc>("/chat/sessions"),

  /** Forget one conversation, on the server. The store's own entry is removed
   *  separately, by the caller: the two are different facts and deleting one
   *  is not deleting the other. */
  deleteChatSession: (sessionId: string) =>
    call<{ sessionId: string; deleted: number }>(
      `/chat/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),

  /* --------------------------------------------------------------- models */

  /** Every provider, whether each is connected, which is the default, and what
   *  the limiter is doing right now. Cheap on the server — no credential is
   *  decrypted to answer it — so a settings page may poll it. */
  modelProviders: () => call<ModelProviders>("/models/providers"),

  /** Choose the default, or `null` for none. Comes back with the whole state,
   *  so a choice that turns out not to be connected says so without a second
   *  request. */
  setModelProvider: (provider: ProviderId | null) =>
    call<ModelProviders>("/models/provider", {
      method: "PUT",
      body: JSON.stringify({ provider }),
    }),

  /** Change one provider's policy. A PARTIAL body is the normal case — a
   *  concurrency box that has just been changed sends one field — because a
   *  form that resends everything overwrites what somebody changed in another
   *  tab a second ago. */
  setModelPolicy: (id: ProviderId, patch: Partial<ModelPolicy>) =>
    call<{ id: ProviderId } & ModelProviders>(`/models/${id}/policy`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  /** Forget the four keys, so the provider's own default stands again. Offered
   *  as a button rather than making the owner retype four numbers they never
   *  chose. */
  clearModelPolicy: (id: ProviderId) =>
    call<{ id: ProviderId } & ModelProviders>(`/models/${id}/policy`, {
      method: "DELETE",
    }),

  /** What each local endpoint is serving, asked live. */
  localModels: () => call<LocalModels>("/models/local/models"),

  /** One completion through the DEFAULT provider, under its policy — the same
   *  path a plain chat takes, which is why it is worth a button. It writes no
   *  row: this is the one chat-shaped call that leaves no transcript. */
  complete: (message: string, model?: string) =>
    call<ProviderReply>("/models/complete", {
      method: "POST",
      body: JSON.stringify({ message, ...(model ? { model } : {}) }),
    }),

  /** Forget one conversation, on the server. The session itself lives in the
   *  browser's store and is not touched by this. */
  chatClear: (sessionId: string) =>
    call<{ sessionId: string; deleted: number }>(
      `/chat/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),

  /* --------------------------------------------------------------- agents */

  /**
   * Both agents as PROCESSES — installed, running, pointed at, live.
   *
   * ONE CALL FOR THE PAIR rather than one per agent, because every question
   * this answers is a question about both: which is running (at most one),
   * which is live (at most one), and whether there is a model provider to
   * point either at. Two calls would be two half-answers that a page would
   * have to join.
   */
  agents: () => call<AgentsDoc>("/agents"),

  agent: (id: AgentId) => call<AgentReport>(`/agents/${id}`),

  /** Begin an install. Answers 202 and a state to poll: a clone, a virtualenv
   *  and a compiled dependency tree take minutes, and a request that waited
   *  for them would time out somewhere with nothing to show. */
  agentInstall: (id: AgentId) =>
    call<AgentReport>(`/agents/${id}/install`, { method: "POST" }),

  /** Configure it from the active model provider, then spawn it. Refused with
   *  a sentence when there is no provider, when it is not installed, or when
   *  the other agent is already running. */
  agentStart: (id: AgentId) =>
    call<AgentReport>(`/agents/${id}/start`, { method: "POST" }),

  agentStop: (id: AgentId) =>
    call<AgentReport>(`/agents/${id}/stop`, { method: "POST" }),

  /** Rewrite its provider config now. A running agent is restarted, because
   *  neither agent re-reads its config file. */
  agentReconfigure: (id: AgentId) =>
    call<AgentReport>(`/agents/${id}/reconfigure`, { method: "POST" }),

  /** Make it the agent that answers. The same `chat.backend` switch the Chat
   *  page flips — there is one, and this is the door on the plugin page. */
  agentMakeLive: (id: AgentId) =>
    call<AgentsDoc>(`/agents/${id}/make-live`, { method: "POST" }),

  /** Which credential this plugin uses: the instance spawned here, or a pasted
   *  remote one. Both can be connected at once, which is why it is a setting. */
  agentMode: (id: AgentId, mode: "managed" | "remote") =>
    call<AgentReport>(`/agents/${id}/mode`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),

  /* ---------------------------------------------------------- ventures */

  /**
   * The ventures, and the vocabulary that goes with them.
   *
   * NESTED RATHER THAN FLAT — the one object in this client that is — because
   * this is a small CRUD surface over one resource and `api.ventures.update`
   * reads as what it does where a seventh `updateVenture` in a list of ninety
   * functions would not. Everything else here is a verb against a report.
   */
  ventures: {
    list: () => call<VentureList>("/ventures"),

    /** `key` is an id or a slug: the server resolves either, so a page that
     *  has the URL segment does not have to look the id up first. */
    get: (key: string) => call<Venture>(`/ventures/${encodeURIComponent(key)}`),

    /**
     * Make one. With a website this READS THE SITE before it answers —
     * favicon, colours, title — which is why the form shows a busy state
     * saying so. A site that cannot be read never fails the create: the
     * reason lands in `brand.error` and the venture exists anyway.
     */
    create: (body: VentureInput) =>
      call<Venture>("/ventures", { method: "POST", body: JSON.stringify(body) }),

    update: (key: string, patch: VenturePatch) =>
      call<Venture>(`/ventures/${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),

    /** The venture, and nothing else. Board cards keep their `ventureId` and
     *  are drawn unfiled; this app deletes the venture's dashboards itself,
     *  because they are its own state. */
    remove: (key: string) =>
      call<{ ok: true }>(`/ventures/${encodeURIComponent(key)}`, {
        method: "DELETE",
      }),

    /** Read the site again. The one write whose whole purpose is to replace
     *  measurements with fresher measurements. */
    enrich: (key: string) =>
      call<Venture>(`/ventures/${encodeURIComponent(key)}/enrich`, {
        method: "POST",
      }),

    reorder: (ids: string[]) =>
      call<{ ventures: Venture[] }>("/ventures/reorder", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
  },

  /* ------------------------------------------------------- the board app */

  /**
   * The board: every column with its cards in order, archived ones left out.
   *
   * ONE FETCH FOR THE WHOLE PAGE, and every call below answers with the same
   * document — so the page has exactly one shape of state and a mutation's
   * reply replaces it whole. Nothing here returns a fragment that would have
   * to be merged into something.
   */
  board: () => call<BoardDoc>("/board"),

  /** Write a card down. `column` is its id or its key; left out, it lands in
   *  Backlog — a card typed in a hurry has to have somewhere to go that is
   *  not a decision. */
  boardAddCard: (input: {
    title: string;
    body?: string | null;
    ventureId?: string | null;
    urgency?: number;
    due?: string | null;
    column?: number | string;
  }) =>
    call<BoardDoc>("/board/cards", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  boardEditCard: (id: number, patch: BoardCardPatch) =>
    call<BoardDoc>(`/board/cards/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  /**
   * THE DRAG. "Put it in that column, above that card" — `before` is the id of
   * the card to land on top of, or null for the foot of the column.
   *
   * A NEIGHBOUR RATHER THAN AN INDEX, which is the one place this differs from
   * the usual board API, and the difference is worth having: an index of 3 means a
   * different slot the moment anything else has been inserted, and it silently
   * means SOMETHING, so a stale drop lands in the wrong place and reads as a
   * misfire. A card id either still names a card in that column or it does
   * not, and the server says so rather than guessing. It is also what lets the
   * page stay draggable while a venture filter is on: a hidden card cannot
   * make "above that card" mean somewhere else.
   */
  boardMoveCard: (id: number, columnId: number, before: number | null) =>
    call<BoardDoc>(`/board/cards/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ columnId, before }),
    }),

  /** Out of the way, not gone. It keeps its column and its place; the board
   *  stops returning it. */
  boardArchiveCard: (id: number) =>
    call<BoardDoc>(`/board/cards/${id}/archive`, { method: "POST" }),

  /** Gone, with no undo — which is why archive exists beside it and why the
   *  dialog asks before it calls this. */
  boardDeleteCard: (id: number) =>
    call<BoardDoc>(`/board/cards/${id}`, { method: "DELETE" }),

  /** Rename a column, or put a ceiling on it. `wipLimit: null` removes the
   *  ceiling; 0 is a column nothing should sit in, and they are different. The
   *  limit is never enforced — it is a thing to be told about, and a board
   *  that refuses a drop teaches you to put the card somewhere dishonest. */
  boardEditColumn: (id: number, patch: { title?: string; wipLimit?: number | null }) =>
    call<BoardDoc>(`/board/columns/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  boardAddColumn: (title: string) => call<BoardDoc>("/board/columns", { method: "POST", body: JSON.stringify({ title }) }),
  boardDeleteColumn: (id: number) => call<BoardDoc>(`/board/columns/${id}`, { method: "DELETE" }),

  /** Reorder the columns, in the same vocabulary a card moves in. Nothing on
   *  the page calls this yet — the board draws its five in the order the
   *  server gives them — and it is here because the route is. */
  boardMoveColumn: (id: number, before: number | null) =>
    call<BoardDoc>(`/board/columns/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ before }),
    }),
};
