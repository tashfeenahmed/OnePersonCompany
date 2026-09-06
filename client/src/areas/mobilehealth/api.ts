import { call } from "@/lib/api";
import { qs } from "@/lib/qs";

/**
 * MOBILE HEALTH FROM THIS SIDE — what the apps DO, beside /api/mobile's money.
 *
 * Every type here is transcribed from the server's own shape and NOTHING
 * INVENTS A FIELD IT DOES NOT SEND. Where the server says null this says null,
 * and the page draws the null: a `rate` of null is "the cohort was empty", a
 * `window` crash rate of null is "no rate was measured", `measured: false` on
 * retention is "the report is not in the bucket" with the sentence beside it.
 * None of them is a zero and none may be drawn as one.
 *
 * `unit` AND `metricKind` TRAVEL WITH EVERY SERIES and the page prints both.
 * Google counts devices, users and events in one file; a table that showed
 * three integers under one heading would be the exact mistake the server's
 * columns exist to prevent.
 */

/* ------------------------------------------------------------- readiness */

export type Probe = {
  store: string;
  accountId: number;
  probe: string;
  ok: boolean;
  status: number | null;
  /** The provider's OWN refusal sentence, unedited. */
  error: string | null;
  checkedAt: string;
};

export type ReportState = {
  store: string;
  app: string;
  report: string;
  state: string;
  detail: string | null;
  rows: number | null;
  period: string | null;
  checkedAt: string;
};

export type Readiness = {
  stores: { play: { connected: boolean }; appstore: { connected: boolean } };
  lastCollected: { store: string; at: string | null }[];
  collecting: boolean;
  probes: Probe[];
  counts: Record<string, number>;
  reports: ReportState[];
  states: Record<string, string>;
  note: string;
};

/* -------------------------------------------------------------- segments */

export type SegmentSlice = {
  value: string;
  amount: number;
  days?: number;
  at?: string;
  share: number | null;
};

export type SegmentGroup = {
  store: string;
  app: string;
  dimension: string;
  metric: string;
  metricKind: "event" | "level";
  unit: string | null;
  total: number;
  slices: number;
  top: SegmentSlice[];
  /** What the published slices do NOT account for. Null for a level, where
   *  there is no remainder to have. */
  other: number | null;
};

export type Segments = {
  window: { days: number; from: string; to: string; clampedFrom: number | null };
  available: { store: string; app: string; dimension: string; days: number }[];
  groups: SegmentGroup[];
  units: Record<string, string>;
  rules: string[];
};

/* ------------------------------------------------------------ conversion */

export type ConversionRow = {
  value: string;
  visitors: number | null;
  acquisitions: number | null;
  rate: number | null;
};

export type Conversion = {
  window: { days: number; from: string; to: string; clampedFrom: number | null };
  measured: boolean;
  reason: string | null;
  /** Which cut of the report `apps` and `days` were summed from — the slices
   *  of two cuts are the same visitors twice, so only one may be totalled. */
  totalsFrom: string | null;
  cuts: string[];
  apps: { app: string; visitors: number | null; acquisitions: number | null; rate: number | null }[];
  days: { day: string; visitors: number | null; acquisitions: number | null; rate: number | null }[];
  by: Record<string, ConversionRow[]>;
  source: string;
  rules: string[];
};

export type Retention = {
  window: { days: number; from: string; to: string; clampedFrom: number | null };
  measured: boolean;
  reason: string | null;
  apps: {
    app: string;
    curve: { day: number; retained: number; installers: number; rate: number | null }[];
  }[];
  source: string;
};

/* ------------------------------------------------------------- stability */

export type StabilityCount = {
  store: string;
  app: string;
  source: string;
  metric: string;
  unit: string;
  total: number;
  days: { day: string; amount: number }[];
  byVersion: { version: string; amount: number }[];
};

export type StabilityRate = {
  store: string;
  app: string;
  metric: string;
  days: { day: string; rate: number }[];
  /** Weighted by the distinct users each day had. Null when nothing measured. */
  window: number | null;
  weightedBy: string;
};

export type Stability = {
  window: { days: number; from: string; to: string };
  vitalsWindowDays: number;
  alerting: {
    worstCrashRate: number | null;
    worstCrashRateApp: { store: string; app: string } | null;
    crashCount: number | null;
    note: string;
  };
  counts: StabilityCount[];
  rates: StabilityRate[];
  readiness: { store: string; app: string; report: string; state: string; detail: string | null; period: string | null }[];
  sources: Record<string, string>;
  rules: string[];
};

/* --------------------------------------------------------------- reviews */

export type Review = {
  store: string;
  app: string;
  id: string;
  rating: number | null;
  title: string | null;
  body: string | null;
  author: string | null;
  language: string | null;
  territory: string | null;
  /** Android only — Apple's review resource carries no version at all. */
  appVersion: string | null;
  device: string | null;
  created: string | null;
  updated: string | null;
  /** The reply the STORE already holds. This box cannot write one. */
  reply: string | null;
  filed: boolean;
};

export type Reviews = {
  window: { days: number; from: string; to: string; clampedFrom: number | null };
  counts: { store: string; app: string; n: number; newest: string | null }[];
  inWindow: number;
  /** The aggregates cover at most this many rows. `aggregatesComplete: false`
   *  means every figure below is a floor, not a total. */
  aggregateCap: number;
  aggregatesComplete: boolean;
  /** How many rows the `reviews` list itself carries — a different, smaller
   *  number that the aggregates do not depend on. */
  listed: number;
  stars: Record<string, number>;
  average: number | null;
  perDay: { day: string; stars: Record<string, number> }[];
  byVersion: { version: string; reviews: number; average: number }[];
  reviews: Review[];
  basis: { play: string; appstore: string };
  rules: string[];
};

export type ReviewTrend = Omit<Reviews, "reviews" | "rules"> & {
  read: number;
  themes: { theme: string; sentiment: string; reviewIds: string[] }[];
  themeNote: string | null;
  model: string | null;
  /** True when no model was called — the answer was already held against this
   *  exact set of review ids. */
  cached: boolean;
  rules: string[];
};

/* -------------------------------------------------------------- versions */

export type VersionRow = {
  version: string;
  platform: string | null;
  created: string | null;
  /** Apple's newer vocabulary. */
  state: string | null;
  /** Apple's older one. Both verbatim. */
  storeState: string | null;
  /** DERIVED by the server from the two above. */
  phase: string;
  firstObserved: string;
  lastObserved: string;
  daysObserved: number;
  phasesSeen: { phase: string; days: string[] }[];
};

export type Versions = {
  window: { days: number; from: string; to: string; clampedFrom: number | null };
  measured: boolean;
  apps: { app: string; versions: VersionRow[] }[];
  phases: Record<string, string>;
  rules: string[];
};

/* ---------------------------------------------------------------- writes */

export type CollectResult = {
  ok: boolean;
  runId: number;
  note: string;
  play: {
    account: string;
    ok: boolean;
    error: string | null;
    packages: string[];
    wrote: Record<string, number>;
    probes: { probe: string; ok: boolean; error?: string | null }[];
    notes: string[];
  }[];
  appstore: {
    account: string;
    ok: boolean;
    error: string | null;
    apps: { id: string; name: string }[];
    wrote: Record<string, number>;
    probes: { probe: string; ok: boolean; error?: string | null }[];
    notes: string[];
  }[];
};

export type TriageResult = {
  cardId: number;
  title: string;
  /** Exactly what went onto THIS card. Never overlaps `alreadyFiled`. */
  filed: string[];
  /** Ids left where they were, with the card they are already on. */
  alreadyFiled: { reviewId: string; cardId: number }[];
  notFound: string[];
  note: string;
};

export const mobileHealthApi = {
  readiness: () => call<Readiness>("/mobilehealth/readiness"),
  segments: (o: { days?: number; store?: string; app?: string; dimension?: string; limit?: number } = {}) =>
    call<Segments>(`/mobilehealth/segments${qs(o)}`),
  conversion: (o: { days?: number; app?: string } = {}) =>
    call<Conversion>(`/mobilehealth/conversion${qs(o)}`),
  retention: (o: { days?: number; app?: string } = {}) =>
    call<Retention>(`/mobilehealth/retention${qs(o)}`),
  stability: (o: { days?: number; app?: string; store?: string } = {}) =>
    call<Stability>(`/mobilehealth/stability${qs(o)}`),
  reviews: (o: { days?: number; store?: string; app?: string; minRating?: number; maxRating?: number; limit?: number } = {}) =>
    call<Reviews>(`/mobilehealth/reviews${qs(o)}`),
  trend: (o: { days?: number; store?: string; app?: string; n?: number; themes?: string } = {}) =>
    call<ReviewTrend>(`/mobilehealth/reviews/trend${qs(o)}`),
  versions: (o: { days?: number; app?: string } = {}) =>
    call<Versions>(`/mobilehealth/versions${qs(o)}`),
  collect: () => call<CollectResult>("/mobilehealth/collect", { method: "POST" }),
  sendToBoard: (reviewIds: string[], title?: string) =>
    call<TriageResult>("/mobilehealth/reviews/triage", {
      method: "POST",
      body: JSON.stringify({ reviewIds, title }),
    }),
};
