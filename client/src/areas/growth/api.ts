import { call } from "@/lib/api";

/**
 * THE GROWTH AREA FROM THIS SIDE.
 *
 * Four documents, four reads and three writes. Every type here is transcribed
 * from the server's own shape and NOTHING INVENTS A FIELD IT DOES NOT SEND —
 * where the server says null this says null, and the pages draw the null: an
 * `estimate` of null is "nothing about this host could be read", a `result` of
 * null on a check is "this was not answered", a `ratio` of null on a funnel
 * transition is "the sample was too small to divide". None of them is a zero
 * and none of them may be drawn as one.
 *
 * THE TWO RUN KINDS ARE NOT HERE. A teardown and a listing audit are runs, and
 * runs are `lib/api/runs.ts`'s business — the pages for them are the shared
 * `RunApp` with a kind string, exactly like the six that came before.
 */

/* ------------------------------------------------------------- authority */

export type AuthorityPart = {
  name: "links" | "pages" | "demand";
  input: number | null;
  from: string | null;
  score: number | null;
  working: string;
};

export type Authority = {
  host: string;
  label: string;
  /** Null means nothing could be read for this host. It is NOT a low score. */
  estimate: number | null;
  /** Null above the top band: difficulty is not the binding constraint at that
   *  size, which is not the same as no limit. */
  ceiling: number | null;
  ceilingMeans: string;
  parts: AuthorityPart[];
  /** Which parts contributed. Two hosts with different bases are not
   *  comparable, and the page must not put them in an order. */
  basis: string[];
  missing: string[];
  arithmetic: string[];
  links: {
    referringDomains: number | null;
    from: string | null;
    spread: number | null;
    verifiedLive: number | null;
    sources: { source: string; ok: number | null; referringDomains: number | null }[];
  };
  note: string | null;
};

export const growthApi = {
  authority: () => call<{ hosts: Authority[]; label: string; note: string }>("/growth/authority"),
  authorityFor: (host: string) => call<Authority>(`/growth/authority/${encodeURIComponent(host)}`),

  cro: (venture: string, stage?: string | null) =>
    call<Cro>(`/growth/cro/${encodeURIComponent(venture)}${stage ? `?stage=${encodeURIComponent(stage)}` : ""}`),
  croStart: (venture: string, experiment: string, stage?: string | null) =>
    call<{ ok: true; experiment: CroLedgerRow }>(`/growth/cro/${encodeURIComponent(venture)}/start`, {
      method: "POST",
      body: JSON.stringify({ experiment, stage }),
    }),
  croFinish: (venture: string, experiment: string, outcome: "done" | "dropped", result: string) =>
    call<{ ok: true; experiment: CroLedgerRow }>(`/growth/cro/${encodeURIComponent(venture)}/finish`, {
      method: "POST",
      body: JSON.stringify({ experiment, outcome, result }),
    }),

  indexing: (host: string, check = false) =>
    call<Indexing>(`/growth/indexing/${encodeURIComponent(host)}${check ? "?check=1" : ""}`),
  submit: (body: { host: string; urls?: string[]; audit?: boolean; sitemap?: boolean; dryRun?: boolean }) =>
    call<SubmitResult>("/growth/indexing/submit", { method: "POST", body: JSON.stringify(body) }),

  ads: () => call<{ accounts: AdsHealth[]; note: string }>("/growth/ads"),
};

/* -------------------------------------------------------------------- cro */

export type Experiment = {
  id: string;
  stage: string;
  dimension: string;
  rank: number;
  hypothesis: string;
  change: string;
  measure: string;
  effort: string;
};

export type CroLedgerRow = {
  experiment: string;
  detail: Experiment | null;
  status: "planned" | "running" | "done" | "dropped";
  stage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: string | null;
  outcomeLink: string | null;
  updatedAt: string;
};

export type Cro = {
  venture: { id: string; slug: string; name: string; host: string | null; stage: string };
  funnel: {
    source: string | null;
    steps: { stage: string; key: string; count: number; from: string }[];
    transitions: { from: string; to: string; ratio: number | null; why: string }[];
    stage: string | null;
    why: string;
    tried: string[];
  };
  stages: { id: string; what: string }[];
  shortlist: Experiment[];
  library: Experiment[];
  refusals: string[];
  experiments: CroLedgerRow[];
  note: string;
};

/* --------------------------------------------------------------- indexing */

export type Indexing = {
  host: string;
  key: string;
  keyLocation: string;
  instruction: string;
  /** Null until the page asks for the check — it is a request to somebody
   *  else's server, so it is never made on a poll. */
  keyFile: { hosted: boolean; status: number | null; url: string; why: string } | null;
  autoSubmit: boolean;
  sitemaps: { url: string; configured: boolean }[];
  audit: { host: string | null; newUrls: string[]; changedUrls: string[]; comparedAt: string | null; why: string };
  submissions: {
    id: number;
    url: string;
    endpoint: string;
    submittedAt: string;
    status: number | null;
    outcome: string;
    response: string | null;
    reason: string;
  }[];
  engines: string;
  google: string;
  means: string;
};

export type SubmitResult = {
  host: string;
  endpoint: string;
  key: string;
  keyFile: { hosted: boolean; status: number | null; url: string; why: string };
  submitted: number;
  urls: string[];
  status: number | null;
  outcome: string;
  response: string | null;
  what: string;
};

/* ------------------------------------------------------------------- ads */

export type AdsCheck = {
  id: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  scope: string;
  /** Null is "not evaluated" and is out of the denominator — never a pass. */
  result: "pass" | "warn" | "fail" | null;
  title: string;
  what: string;
  detail: string;
  fix: string;
  /** The rubric's own estimate of how long the fix takes. Not a measurement,
   *  and it is what decides whether a finding is a quick win. */
  minutes: number;
};

export type AdsHealth = {
  account: {
    id: string;
    name: string | null;
    currency: string | null;
    active: boolean;
    window: { from: string | null; to: string | null; days: number };
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    ctr: number | null;
    reach: number | null;
    frequency: number | null;
    leads: number | null;
    costPerLead: number | null;
    seenAt: string;
  };
  score: number | null;
  grade: string | null;
  coverage: number;
  refusal: string | null;
  categories: Record<string, { weight: number; coverage: number; score: number | null; reason: string | null }>;
  arithmetic: string[];
  killTable: { minDays: number; minClicks: number; minImpressionsToKill: number };
  target: { costPerLead: number | null; basis: string };
  checks: AdsCheck[];
  failing: AdsCheck[];
  /** A `high`-or-worse failure whose fix is under `quickWin.minutes`.
   *  Computed out of `failing` on every read, never a curated list. */
  quickWins: AdsCheck[];
  quickWin: { minutes: number; severity: string; means: string };
  campaigns: {
    id: string;
    name: string | null;
    status: string | null;
    objective: string | null;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    ctr: number | null;
    frequency: number | null;
    leads: number | null;
    costPerLead: number | null;
  }[];
  limitations: string[];
  means: string;
};
