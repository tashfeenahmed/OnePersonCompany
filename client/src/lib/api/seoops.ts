import { call } from "@/lib/api";

/**
 * SEO OPS FROM THIS SIDE — four measurements that never sum.
 *
 * THE TYPES CARRY THE ABSENCES, because the pages have to draw them. A reading
 * with `measured: false` is not a reading of zero and the type says so by
 * making every figure nullable beside a boolean; a `verdict: null` on a visual
 * check is "no model looked", not "nothing wrong"; a `method: "none"` on an
 * effective brand field is "nothing measured it and nothing was typed". A type
 * here that flattened any of those into a number would make it impossible to
 * draw the difference, which is the only thing worth drawing.
 */

/* ------------------------------------------------------------- follow-ups */

export type SeoReading = {
  at: string;
  kind: "baseline" | "followup" | string;
  dayOffset: number | null;
  /** FALSE MEANS NOT MEASURED. Never render the figures below as zero. */
  measured: boolean;
  source: "live-filtered" | "stored-capped" | "none" | null;
  window: { start: string | null; end: string | null; days: number | null };
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  siteClicks: number | null;
  siteImpressions: number | null;
  queries: { query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[];
  error: string | null;
};

export type SeoDelta = {
  clicks: number | null;
  clicksPct: number | null;
  impressions: number | null;
  impressionsPct: number | null;
  ctr: number | null;
  /** After minus before. NEGATIVE IS BETTER — position is a rank. */
  position: number | null;
  siteImpressionsPct: number | null;
};

export type SeoVerdict = "up" | "down" | "flat" | "thin" | "unmeasured";

export type SeoDiagnosis = {
  dayOffset: number;
  at: string;
  verdict: SeoVerdict;
  diagnosis: string;
  rule: number | null;
  decidedBy: "rules" | "model" | string;
  model: string | null;
  next: string;
  delta: SeoDelta | null;
  modelNote: string | null;
  note: string | null;
};

export type SeoBaseline = {
  id: string;
  url: string;
  title: string;
  ventureId: string | null;
  ventureName: string | null;
  property: string | null;
  tag: string | null;
  source: { kind: string; ref: string | null };
  actionAt: string;
  daysSinceAction: number;
  outcomeId: string | null;
  createdAt: string;
  closedAt: string | null;
  baseline: SeoReading | null;
  followUps: SeoReading[];
  diagnoses: SeoDiagnosis[];
  due: { dayOffset: number; dueAt: string; overdue: boolean }[];
  /** Offsets whose due day had already passed when the URL was first tracked.
   *  There is no measurement to make for these and there never will be — a
   *  card finished six months ago and swept today can have no 14-day reading. */
  missedOffsets: number[];
  window: string;
  caveat: string;
};

export type FollowUpsDoc = {
  count: number;
  baselines: SeoBaseline[];
  schedule: { offsetsDays: number[]; windowDays: number; tag: string };
  diagnoses: string[];
  thresholds: { flatBandPct: number; minBaselineImpressions: number };
  notes: string[];
};

export type CandidatesDoc = {
  tag: string;
  doneCardsScanned: number;
  tagged: number;
  candidates: {
    cardId: number;
    title: string;
    ventureId: string | null;
    doneAt: string;
    urls: string[];
    tracked: boolean[];
  }[];
  note: string;
};

/* --------------------------------------------------------------- listings */

export type ListingState =
  | "not_listed"
  | "pending"
  | "submitted"
  | "detected"
  | "confirmed"
  | "skipped";

export type ListingCell = {
  directory: string;
  name: string;
  tier: string;
  submitUrl: string;
  detectableBy: string | null;
  note: string;
  state: ListingState;
  ownerNote: string | null;
  url: string | null;
  detectedAt: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  lastChecked: string | null;
  setBy: "owner" | "detection" | null;
};

export type LedgerDoc = {
  ventures: {
    ventureId: string;
    venture: string;
    slug: string;
    host: string | null;
    directories: ListingCell[];
    summary: {
      confirmed: number;
      submitted: number;
      detected: number;
      pending: number;
      skipped: number;
      notListed: number;
      of: number;
      /** Null when every row is skipped — a percentage of nothing. */
      donePct: number | null;
    };
  }[];
  catalogue: {
    count: number;
    tiers: string[];
    detectable: number;
    fromSettings: string[];
    errors: string[];
  };
  states: ListingState[];
  notes: string[];
};

/* ----------------------------------------------------------------- vision */

export type VisionIssue = { kind: string; where: string; confidence: number };

export type VisionDoc = {
  capability: {
    /** null = nothing is known either way. It is NOT a "no". */
    supportsImages: boolean | null;
    provider: string | null;
    model: string | null;
    probedAt: string | null;
    detail: string;
  };
  ventures: {
    ventureId: string;
    venture: string;
    slug: string;
    optedIn: boolean;
    verdict: "ok" | "broken" | "unsure" | null;
    issues: VisionIssue[];
    at: string | null;
    shotTs: string | null;
    model: string | null;
    error: string | null;
  }[];
  verdicts: string[];
  issueKinds: string[];
  notes: string[];
};

/* ------------------------------------------------------------------ brand */

export type BrandField = { value: string | null; method: "override" | "rendered" | "static" | "none" };

export type RenderedBrand = {
  method: "rendered";
  at?: string;
  readAt: string;
  url: string;
  finalUrl: string | null;
  title: string | null;
  bodyFont: string | null;
  headingFont: string | null;
  fonts: { tag: string; family: string; weight: number | null; sizePx: number | null }[];
  colours: { hex: string; kind: string; area: number; share: number }[];
  background: string | null;
  ink: string | null;
  buttons: { hex: string; n: number }[];
  logos: { src: string; kind: "img" | "svg"; alt: string; score: number; widthPx: number | null }[];
  palette: {
    primary: string | null;
    secondary: string | null;
    accent: string | null;
    background: string | null;
    ink: string | null;
    ranked: { hex: string; weight: number }[];
  };
  elementsMeasured: number;
  notes: string[];
  error: string | null;
};

export type BrandDoc = {
  ventureId: string;
  venture: string;
  slug: string;
  website: string | null;
  optedIn?: boolean;
  rendered: RenderedBrand | null;
  renderedError: string | null;
  static: {
    method: "static";
    palette: RenderedBrand["palette"];
    fonts: string[];
    at: string | null;
  } | null;
  override: Record<string, string | null> | null;
  effective: {
    primary: BrandField;
    secondary: BrandField;
    accent: BrandField;
    background: BrandField;
    ink: BrandField;
    bodyFont: BrandField;
    headingFont: BrandField;
    logo: BrandField;
  };
  notes: string[];
};

/* ------------------------------------------------------------------ calls */

export const seoopsApi = {
  overview: () =>
    call<{
      followUps: { tracked: number; measuredBaselines: number; unmeasuredBaselines: number; dueNow: number; offsetsDays: number[]; windowDays: number; tag: string; verdicts: Record<string, number> };
      listings: { directories: number; detectable: number; ventures: number; confirmed: number; submitted: number; detected: number; notListed: number; errors: string[] };
      vision: { supportsImages: boolean | null; probedAt: string | null; detail: string; optedIn: string[]; verdicts: Record<string, number> };
      brand: { optedIn: string[]; measured: number; overridden: number };
      notes: string[];
    }>("/seoops"),

  followUps: (venture?: string) =>
    call<FollowUpsDoc>(`/seoops/followups${venture ? `?venture=${encodeURIComponent(venture)}` : ""}`),
  candidates: () => call<CandidatesDoc>("/seoops/followups/candidates"),
  sweep: () =>
    call<{ scanned: number; candidates: number; created: { id: string; url: string; card: number; measured: boolean; error: string | null }[]; skipped: { card: number; why: string }[]; note: string }>(
      "/seoops/sweep",
      { method: "POST" },
    ),
  track: (body: { url: string; venture?: string; title?: string; actionAt?: string }) =>
    call<{ baseline: SeoBaseline; note: string }>("/seoops/followups", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  runDue: () =>
    call<{ due: number; ran: number; results: unknown[] }>("/seoops/followups/run", { method: "POST", body: "{}" }),
  runOne: (id: string) =>
    call<{ baseline: SeoBaseline; ran: Record<string, unknown> }>(`/seoops/followups/${encodeURIComponent(id)}/run`, {
      method: "POST",
      body: "{}",
    }),
  closeOne: (id: string) =>
    call<{ baseline: SeoBaseline; note: string }>(`/seoops/followups/${encodeURIComponent(id)}/close`, {
      method: "POST",
    }),
  deleteOne: (id: string) =>
    call<{ deleted: SeoBaseline }>(`/seoops/followups/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listings: (venture?: string) =>
    call<LedgerDoc>(`/seoops/listings${venture ? `?venture=${encodeURIComponent(venture)}` : ""}`),
  setListing: (body: { venture: string; directory: string; state: ListingState; note?: string | null; url?: string | null }) =>
    call<{ row: unknown; ledger: LedgerDoc; note: string }>("/seoops/listings/set", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  detectListings: () =>
    call<{ ventures: number; moved: unknown[]; refreshed: number; held: unknown[]; unmatchedProducts: string[]; note: string }>(
      "/seoops/listings/detect",
      { method: "POST" },
    ),

  vision: () => call<VisionDoc>("/seoops/vision"),
  probe: () => call<{ capability: VisionDoc["capability"]; note: string }>("/seoops/vision/probe", { method: "POST" }),
  /* `force` is sent as a real JSON boolean. The server refuses anything it
     cannot parse as one, because a vision pass is a bill. */
  runVision: (venture?: string, force = false) =>
    call<{ ran: number; reused: number; results: VisionDoc["ventures"]; note: string }>("/seoops/vision/run", {
      method: "POST",
      body: JSON.stringify({ venture, force }),
    }),

  brand: (venture: string) => call<BrandDoc>(`/seoops/brand/${encodeURIComponent(venture)}`),
  measureBrand: (venture: string) =>
    call<{ rendered: RenderedBrand; brand: BrandDoc; note: string }>(
      `/seoops/brand/${encodeURIComponent(venture)}/measure`,
      { method: "POST" },
    ),
  setBrandOverride: (venture: string, doc: Record<string, string | null>) =>
    call<{ brand: BrandDoc; note: string }>(`/seoops/brand/${encodeURIComponent(venture)}/override`, {
      method: "POST",
      body: JSON.stringify(doc),
    }),
};
