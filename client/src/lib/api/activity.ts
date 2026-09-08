/**
 * THE ACTIVITY AREA'S THREE DOCUMENTS, typed off the routes that answer them.
 *
 * WHY THE NULLS ARE LOAD-BEARING HERE TOO. `new7d: number | null` is not
 * defensive typing: a product publishing the counts-only form of the users
 * contract has no rows to bucket, so it has no seven-day window at all, and a
 * type that widened it to `number` would invite a `?? 0` in a card — which
 * would draw "0 signups this week" for a product that never said so. The same
 * goes for every `amount: number | null` on the leakage buckets: a decline has
 * no amount because the charge-day table records attempts as counts, and a zero
 * there would read as "cost us nothing".
 *
 * `combined: null` IS TYPED AS EXACTLY `null`, the way this file's neighbours
 * do it, so a component that reaches for a portfolio total has to render the
 * note instead. That is the point of the field.
 */
import { call } from "@/lib/api";

/* ------------------------------------------------------------------ users */

export type UserVenture = {
  id: string;
  slug: string;
  name: string;
  /** How this product was filed. "setting" and "link" are somebody's decision;
   *  "host" is a hostname that looked alike, and is a guess. */
  matchedBy: "setting" | "link" | "host";
};

export type UserProduct = {
  accountId: number;
  product: string;
  /** Which form of the contract it publishes. Null before a first collection. */
  shape: "users" | "counts" | null;
  url: string | null;
  /** Three-valued: null is "never collected", not "down". */
  reachable: boolean | null;
  lastFetchedAt: string | null;
  generatedAt: string | null;
  status: number | null;
  ms: number | null;
  error: string | null;
  /** The contract validator's own sentences about the last document. */
  problems: string[];
  venture: UserVenture | null;
  /** The product's own count. Beats `rowsHeld`, which is a floor. */
  total: number | null;
  rowsHeld: number;
  partialList: boolean;
  /** Null for a counts-only product: it has no rows to bucket, which is not
   *  the same as nobody having signed up. */
  new7d: number | null;
  new30d: number | null;
  /** What a counts-only product said, in the window IT chose. */
  newWindow: { days: number; n: number } | null;
  paid: number | null;
  free: number | null;
  paidUnknown: number | null;
  /** An address on file. NOT an audience — see `contactPermitted`. */
  withEmail: number | null;
  /** People whose own product recorded them agreeing to be written to. The
   *  only one of the two that sizes a campaign; nothing infers it from the
   *  other. */
  contactPermitted: number | null;
  /**
   * Rows whose `lastSeenAt` falls inside `window.days`.
   *
   * NULL IS "THIS PRODUCT PUBLISHES NO lastSeenAt" and is the reason the field
   * is three-valued rather than a number: a product that has said nothing
   * about who came back has not said nobody did, and a `?? 0` here would draw
   * the most misleading tile on the board.
   */
  active: number | null;
  /** Rows carrying no `lastSeenAt` — absent from `active`, not inactive. */
  lastSeenUnknown: number | null;
  /** Signups inside the window seen again a day or more later. The FIRST
   *  POINT of a retention curve and not the curve: the contract publishes one
   *  `lastSeenAt` per person, so week two and week three are one field. */
  returned: number | null;
  /** Who these people are to the business — customer, participant, admin,
   *  trial, internal. A missing population is `customer`, resolved by the
   *  route. Null for a counts-only product. */
  populations: Record<string, number> | null;
  /** This product's plans, largest first. NEVER comparable across products:
   *  two owners chose the word "pro" independently. */
  plans: { value: string; n: number }[];
  /** Countries, largest first. These DO compare — IE is IE — and the route
   *  still does not add them. */
  countries: { value: string; n: number }[];
  /** The oldest and newest signup this box holds. Both floors: an endpoint
   *  that lists its newest hundred has an older first signup than this sees. */
  firstSignupAt: string | null;
  lastSignupAt: string | null;
  days: { day: string; signups: number | null; total: number | null; source: string }[];
};

/** One of the newest signups anywhere in the portfolio. THERE IS NO ADDRESS
 *  ON IT and there cannot be: the domain is what is stored, and the product's
 *  own id is opaque to this box. */
export type RecentSignup = {
  accountId: number;
  product: string;
  id: string;
  emailDomain: string | null;
  createdAt: string;
  plan: string | null;
  paid: boolean | null;
  country: string | null;
};

export type UsersReport = {
  window: { days: number; of: string };
  products: UserProduct[];
  /** The newest signups across every product, merged by the route: five from
   *  each of four products is not the newest twenty overall. */
  recentSignups: RecentSignup[];
  summary: {
    configured: number;
    answering: number;
    failing: number;
    neverCollected: number;
    countsOnly: number;
    totalUsers: number;
    /** Null with nothing connected — a claim about an empty list. */
    complete: boolean | null;
    new7d: number;
    new30d: number;
    /** How many products have no window at all and are absent from the two
     *  above rather than counted as zero. */
    windowsMissing: number;
    /* THE PAID SPLIT, THREE-VALUED PORTFOLIO-WIDE TOO. There is deliberately
       no conversion rate on this document: `paidUnknown` is the size of the
       guess, and a reader that wants a rate has to see it first. */
    paid: number;
    free: number;
    paidUnknown: number;
    withEmail: number;
    contactPermitted: number;
    /** Summed only across the products that can answer — see
     *  `activeMissing`, which is how many are absent rather than zero. */
    active: number;
    returned: number;
    activeMissing: number;
    /** Added across products because a customer of one and a customer of
     *  another are two people — the argument `totalUsers` rests on. */
    populations: Record<string, number>;
    lastFetchedAt: string | null;
    note: string;
  };
};

export type UserRow = {
  id: string;
  /** The domain only. There is no address on this document, by design. */
  emailDomain: string | null;
  createdAt: string;
  plan: string | null;
  /** Null means the product does not publish the field. Not "free". */
  paid: boolean | null;
  lastSeenAt: string | null;
  country: string | null;
  seenAt: string;
};

export type StoredDocument = {
  product: string;
  ts: string | null;
  shape: "users" | "counts" | null;
  /** The last document, addresses replaced and arrays cut to three. Null
   *  before anything was ever fetched. */
  document: string | null;
  problems: string[];
  note: string;
};

export type UserList = {
  product: string;
  accountId: number;
  total: number | null;
  rowsHeld: number;
  matching: number;
  page: { limit: number; offset: number; returned: number };
  filters: {
    q: string | null;
    plan: string | null;
    country: string | null;
    paid: string | null;
    days: number | null;
    note: string;
  };
  facets: { plans: string[]; countries: string[]; domains: string[] };
  users: UserRow[];
};

/* --------------------------------------------------------------- activity */

export type ActivityEvent = {
  key: string;
  ts: string;
  /** TRUE: the source published this moment. FALSE: it publishes a UTC day and
   *  this is the start of it — never print a time of day for one. */
  exact: boolean;
  resolution: "moment" | "day";
  kind: string;
  venture: string | null;
  product: string | null;
  title: string;
  detail: Record<string, unknown>;
  source: string;
  firstSeenAt: string;
};

export type ActivityReport = {
  window: { days: number; from: string; of: string };
  filter: {
    venture: { id: string; slug: string; name: string } | null;
    kinds: string[] | null;
    note: string | null;
  };
  events: ActivityEvent[];
  counts: {
    returned: number;
    matching: number;
    truncated: boolean;
    byKind: { kind: string; n: number }[];
    /** Counts of EVENTS per day, never of money. */
    byDay: { day: string; kinds: Record<string, number>; n: number }[];
  };
  coverage: {
    oldest: string | null;
    derivesBackDays: number;
    lastPassAt: string | null;
    exactKinds: string[];
    dayResolutionKinds: string[];
    note: string;
  };
};

/* ---------------------------------------------------------------- leakage */

export type LeakageBucket = {
  id: string;
  label: string;
  /** Null where the source that produced `amount` cannot count what it is
   *  made of — the disputes bucket, whose money is ledger debits while the
   *  cases are a differently-dated population counted in `disputeCases`. Not
   *  zero, and never divided into `amount`. */
  count: number | null;
  /** Null where the source records a count and no money. Not zero. */
  amount: number | null;
  window: string;
  /** Which table, which columns, which window. Printed under the figure. */
  arithmetic: string;
  why: string;
  floor: boolean;
};

export type LeakageCurrency = {
  currency: string;
  buckets: LeakageBucket[];
  totals: {
    window: number;
    windowLabel: string;
    windowIs: string;
    perMonth: number;
    perMonthIs: string;
    /** No single number, and it stays null. */
    combined: null;
    note: string;
  };
  counts: {
    declined: number;
    /** Never added to `declined`. */
    blocked: number;
    failedTotal: number;
    refunds: number;
    pastDue: number;
    abandoned: number;
    /** A hypothetical, in no total. */
    listedIfBilled: number;
  };
  noAmount: string[];
};

export type LeakageReport = {
  window: { days: number; from: string };
  currencies: LeakageCurrency[];
  combined: null;
  coverage: {
    currencies: number;
    chargeDaysFrom: string | null;
    subscriptions: number;
    note: string;
  };
  wrongFigures: { figure: string; why: string }[];
};

/* ------------------------------------------------------------------- calls */

export const activityApi = {
  /** Per product: its own total, the two windows, paid, and the daily series. */
  users: (days = 90) => call<UsersReport>(`/users?days=${days}`),

  /** One product's users. `product` is the account's label or its id. */
  userList: (
    product: string,
    q: { q?: string; plan?: string; country?: string; paid?: string; days?: number; limit?: number; offset?: number } = {},
  ) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(q))
      if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
    const qs = search.toString();
    return call<UserList>(`/users/${encodeURIComponent(product)}${qs ? `?${qs}` : ""}`);
  },

  activity: (q: { days?: number; venture?: string; kind?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(q))
      if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
    const qs = search.toString();
    return call<ActivityReport>(`/activity${qs ? `?${qs}` : ""}`);
  },

  /** Re-run the feed pass now. The page's Collect button, for a derivation
   *  whose collector is not a plugin. */
  refreshActivity: () =>
    call<{ ok: true; inserted: number; bySource: Record<string, number>; notes: string[]; ms: number }>(
      "/activity/refresh",
      { method: "POST" },
    ),

  /** The last stored document for one product — the shape, redacted. */
  userDocument: (product: string) =>
    call<StoredDocument>(`/users/${encodeURIComponent(product)}/document`),

  leakage: (days = 30) => call<LeakageReport>(`/leakage?days=${days}`),
};
