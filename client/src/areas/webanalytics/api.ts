import { call } from "@/lib/api";

/**
 * WEB ANALYTICS FROM THIS SIDE.
 *
 * Every type here is transcribed from the server's own shape and NOTHING
 * INVENTS A FIELD IT DOES NOT SEND. Where the server says null this says null,
 * and the page draws the null: a `participants` of null is "not measured" with
 * the server's own sentence beside it, an `excluded` of null is a heuristic
 * that quantifies nothing by design, and a `verdict` of "no-verdict" is an
 * advertisement that did not deliver enough to be judged.
 *
 * `raw` AND `adjusted` ARRIVE TOGETHER AND THE PAGE DRAWS BOTH. The toggle
 * chooses which is emphasised; there is no request that returns one without
 * the other and no component here that renders the adjusted figure alone.
 */

/* ------------------------------------------------------------------ sites */

export type SiteRow = {
  accountId: number;
  websiteId: string;
  name: string | null;
  domain: string | null;
  /** When this site last had its turn in the rotation. Null is "never yet",
   *  which is NOT a site with no traffic. */
  readAt: string | null;
  staleHours: number | null;
  events: number;
  ventures: { id: string; slug: string; name: string }[];
};

export type Sites = {
  windowDays: number;
  everyHours: number;
  sites: SiteRow[];
  notes: string[];
};

/* --------------------------------------------------------------- segments */

export type SegmentValue = {
  value: string;
  count: number;
  /** Of the DIMENSION'S own rows, never of the site's visitors. */
  share: number;
  was: number | null;
  change: number | null;
};

export type SegmentBlock = {
  dimension: string;
  counts: string;
  startDay: string;
  endDay: string;
  /** A FLOOR rather than a total when `capped`. */
  total: number;
  /** Umami answered exactly its row limit, so there is a tail nobody saw and
   *  every share here is against a short denominator. */
  capped: boolean;
  siteTotal: number | null;
  /** Sessions Umami had no value for — `null` on a capped block, where the gap
   *  is the missing tail instead. The page prints `gapReason` either way and
   *  never folds it into the shares. */
  unattributed: number | null;
  gapReason: string | null;
  values: SegmentValue[];
};

export type Heuristic = {
  id: string;
  title: string;
  what: string;
  /** How it can be wrong. Shown with the finding, always. */
  wrong: string;
  population: "visitors" | "views" | null;
};

export type Finding = {
  heuristic: string;
  title: string;
  fingerprint: string;
  dimension: string;
  value: string | null;
  population: "visitors" | "views" | null;
  excluded: number | null;
  windowDays: number;
  offsetDays: number;
  evidence: string[];
  firstSeen: string | null;
};

export type Refusal = {
  heuristic: string;
  dimension: string;
  windowDays: number;
  offsetDays: number;
  /** Why the test could not be run. "No finding" and "not run" are different
   *  sentences and the page prints both. */
  reason: string;
};

export type Adjusted = {
  /** `null` where the raw figure was not measured, OR where the arithmetic was
   *  refused because the exclusion was larger than the figure. Never a floored
   *  zero — `basis` says which. */
  value: number | null;
  heuristic: string | null;
  fingerprint: string | null;
  excluded: number;
  basis: string;
};

export type Segments = {
  site: { websiteId: string; name: string | null; domain: string | null };
  windowDays: number;
  raw: {
    startDay: string | null;
    endDay: string | null;
    pageviews: number | null;
    visitors: number | null;
    visits: number | null;
    bounces: number | null;
  };
  adjusted: { visitors: Adjusted; pageviews: null; note: string };
  findings: Finding[];
  refusals: Refusal[];
  heuristics: Heuristic[];
  segments: SegmentBlock[];
  notes: string[];
  rules: string[];
};

/* ----------------------------------------------------------------- events */

export type EventProperty = {
  property: string;
  type: string;
  records: number;
  distinctValues: number;
  truncated: boolean;
  /** Null means nobody has said what the numbers are IN. */
  unit: string | null;
  numeric: { count: number; sum: number | null; avg: number | null; min: number | null; max: number | null } | null;
  topValues: { value: string; count: number }[] | null;
};

export type WebEvent = {
  event: string;
  startDay: string;
  endDay: string;
  occurrences: number | null;
  /** SESSION IDENTITIES, not people. Null with an error is "not measured". */
  participants: number | null;
  participantsSource: string | null;
  participantsError: string | null;
  perParticipant: number | null;
  properties: EventProperty[];
};

export type Events = {
  windowDays: number;
  sites: { websiteId: string; domain: string | null; name: string | null; events: WebEvent[] }[];
  limits: { detailedEvents: number; propertyValues: number };
  rules: string[];
};

export type FunnelInputs = {
  windowDays: number;
  ventures: {
    venture: { id: string; slug: string; name: string; stage: string };
    websites: string[];
    steps: {
      websiteId: string;
      event: string;
      occurrences: number | null;
      participants: number | null;
      missing: string | null;
    }[];
    note: string | null;
  }[];
  rules: string[];
};

/* -------------------------------------------------------------- campaigns */

export type CampaignLink = {
  platform: string;
  campaignId: string;
  venture: { id: string; name: string | null };
  source: string;
  evidence: string | null;
  createdAt: string;
};

export type CampaignSuggestion = {
  platform: string;
  campaignId: string;
  campaignName: string | null;
  adAccountId: string;
  venture: { id: string; name: string };
  via: string;
  evidence: string;
};

export type CampaignMap = {
  links: CampaignLink[];
  suggestions: CampaignSuggestion[];
  /** Campaigns that matched more than one venture. Nothing is applied. */
  contested: string[];
  rules: string[];
};

export type VentureJoin = {
  venture: { id: string; slug: string; name: string; stage: string };
  windowDays: number;
  startDay: string;
  endDay: string;
  campaigns: {
    campaignId: string;
    name: string | null;
    adAccountId: string;
    currency: string | null;
    source: string;
    evidence: string | null;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    days: number;
  }[];
  spend: { currency: string; amount: number }[];
  clicks: number | null;
  impressions: number | null;
  tagged: {
    campaign: string;
    source: string | null;
    medium: string | null;
    views: number;
    matchedCampaignId: string | null;
  }[];
  taggedViews: number | null;
  conversions: { event: string; participants: number | null; occurrences: number | null; websiteId: string }[];
  notes: string[];
  blended: {
    month: string;
    revenue: { currency: string; gross: number; net: number }[];
    spend: { currency: string; amount: number }[];
    ratio: { currency: string; value: number | null; note: string }[];
    siteReported: {
      event: string;
      property: string;
      sum: number | null;
      count: number | null;
      unit: string | null;
      note: string;
    } | null;
    unavailable: string[];
    rules: string[];
  };
  rules: string[];
};

/* -------------------------------------------------------------- creatives */

export type WindowFigures = {
  startDay: string;
  endDay: string;
  impressions: number | null;
  reach: number | null;
  frequency: number | null;
  clicks: number | null;
  spend: number | null;
  ctr: number | null;
  cpm: number | null;
};

export type AdRow = {
  adId: string;
  adAccountId: string;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  name: string | null;
  status: string | null;
  /** SIGNED AND EXPIRING. Never cached; a 403 is expected eventually. */
  imageUrl: string | null;
  verdict: "fatigued" | "tiring" | "steady" | "no-verdict";
  why: string | null;
  week: WindowFigures | null;
  before: WindowFigures | null;
  ctrChange: number | null;
  frequencyChange: number | null;
  evidence: string[];
  venture: { id: string; name: string | null } | null;
};

export type Creatives = {
  compareDays: number;
  minImpressions: number;
  counts: Record<string, number>;
  adSets: {
    adsetId: string;
    adAccountId: string;
    campaignId: string | null;
    name: string | null;
    status: string | null;
    optimizationGoal: string | null;
    billingEvent: string | null;
    bidStrategy: string | null;
    /** MINOR UNITS of `currency`. */
    dailyBudgetMinor: number | null;
    lifetimeBudgetMinor: number | null;
    currency: string | null;
    startTime: string | null;
    endTime: string | null;
    ads: number;
  }[];
  ads: AdRow[];
  statuses: {
    adId: string;
    name: string | null;
    status: string | null;
    configuredStatus: string | null;
    issues: unknown[];
    mismatched: boolean;
  }[];
  rules: string[];
};

/* ------------------------------------------------------------------- api */

export const webAnalytics = {
  sites: () => call<Sites>("/webanalytics/sites"),
  segments: (websiteId: string, days: 7 | 30) =>
    call<Segments>(`/webanalytics/segments/${encodeURIComponent(websiteId)}?days=${days}`),
  events: (websiteId?: string) =>
    call<Events>(`/webanalytics/events${websiteId ? `?website=${encodeURIComponent(websiteId)}` : ""}`),
  funnelInputs: (venture?: string) =>
    call<FunnelInputs>(
      `/webanalytics/events/funnel-inputs${venture ? `?venture=${encodeURIComponent(venture)}` : ""}`,
    ),
  campaigns: () => call<CampaignMap>("/webanalytics/campaigns"),
  venture: (key: string, days: number) =>
    call<VentureJoin>(`/webanalytics/campaigns/${encodeURIComponent(key)}?days=${days}`),
  link: (campaignId: string, venture: string, platform = "meta") =>
    call<{ ok: boolean; source: string }>("/webanalytics/campaigns/link", {
      method: "POST",
      body: JSON.stringify({ campaignId, venture, platform }),
    }),
  unlink: (campaignId: string, platform = "meta") =>
    call<{ ok: boolean }>("/webanalytics/campaigns/unlink", {
      method: "POST",
      body: JSON.stringify({ campaignId, platform }),
    }),
  creatives: (account?: string) =>
    call<Creatives>(`/webanalytics/creatives${account ? `?account=${encodeURIComponent(account)}` : ""}`),
};
