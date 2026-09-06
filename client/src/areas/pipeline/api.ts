import { call } from "@/lib/api";

/**
 * THE PIPELINE AND THE SYNTHESIS PASS, transcribed from the server's shapes.
 *
 * A FIELD THAT IS NULLABLE ON THE WIRE IS NULLABLE HERE, which matters more in
 * this area than most: `usd` is null on a box that prices no tokens, `lastRun`
 * is null for a stage that has never written anything, and every section of an
 * evidence packet is null-with-a-reason when it is not measured. A type that
 * smoothed any of those into a zero would let the page draw a figure the server
 * refused to state.
 */

export type ScheduledBy = "pipeline" | "self";
export type Cadence = "daily" | "weekly" | "monthly";
export type Outcome = "completed" | "skipped" | "failed" | "over-budget";

export type Stage = {
  id: string;
  area: string;
  title: string;
  about: string;
  deps: string[];
  /** 'pipeline' means the nightly walk starts it. 'self' means that area's own
   *  timer does, and switching it off here does NOT stop it. */
  scheduledBy: ScheduledBy;
  enabled: boolean;
  cadence: Cadence;
  window: string | null;
  maxUsd: number | null;
  maxMinutes: number | null;
  overridden: boolean;
  /** The longest dependency chain behind it, for indenting the list. */
  depth: number;
  inCycle: boolean;
  /** Null means never. What it MEANS differs by kind — see lastRunMeans. */
  lastRun: string | null;
  lastRunMeans: string;
};

export type Blackout = {
  from: string;
  to: string;
  stages: string[];
  days: number[] | null;
  raw: string;
};

export type Schedule = {
  enabled: boolean;
  hour: number;
  timezone: string | null;
  resolvedTimezone: string;
  today: string;
  blackouts: Blackout[];
  blackoutErrors: string[];
  maxUsd: number | null;
  maxMinutes: number | null;
  nextRunAt: string | null;
  skipTonight: { day: string; setAt: string; reason: string | null } | null;
  session: string;
  defaults: { hour: number; maxMinutes: number };
  settingsAt: string;
  notes: { budget: string; cost: string };
};

export type Run = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: string;
  dry: boolean;
  planned: number;
  completed: number;
  skipped: number;
  failed: number;
  overBudget: number;
  /** Null means this box prices no tokens, NOT that the night was free. */
  usd: number | null;
  ms: number | null;
  summary: string;
  note: string | null;
};

export type StageResult = {
  stageId: string;
  area: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: Outcome;
  reason: string | null;
  error: string | null;
  note: string | null;
  ms: number | null;
  usd: number | null;
  counts: Record<string, number>;
};

export type PipelineDoc = {
  schedule: Schedule;
  stages: Stage[];
  cycle: string[];
  unknownDeps: { stage: string; dep: string }[];
  blackoutErrors: string[];
  note: string;
  runs: Run[];
  last: Run | null;
};

export type NightResult = {
  ran: boolean;
  why: string | null;
  run: Run | null;
  stages: StageResult[];
  delivery?: { chat: boolean; telegram: boolean; note: string | null };
  note?: string;
};

export const pipelineApi = {
  all: () => call<PipelineDoc>("/pipeline"),
  run: (body: { dry?: boolean; stage?: string }) =>
    call<NightResult>("/pipeline/run", { method: "POST", body: JSON.stringify(body) }),
  one: (id: string) =>
    call<{ run: Run; stages: StageResult[] }>(`/pipeline/runs/${encodeURIComponent(id)}`),
  setStage: (
    id: string,
    patch: { enabled?: boolean | null; cadence?: Cadence | null; maxUsd?: number | null; maxMinutes?: number | null },
  ) =>
    call<{ stages: Stage[] }>(`/pipeline/stages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  skipTonight: (cancel: boolean) =>
    call<{ skipped: unknown; note: string }>("/pipeline/skip-tonight", {
      method: "POST",
      body: JSON.stringify(cancel ? { cancel: true } : {}),
    }),
  /* The night's settings are SETTINGS and are written where every other one is,
     through the plugin config door — one validator, on the server. */
  save: (plugin: "pipeline" | "synthesis", config: Record<string, string>) =>
    call<{ id: string; config: Record<string, string> }>(`/plugins/${plugin}/config`, {
      method: "PUT",
      body: JSON.stringify({ config }),
    }),
};

/* --------------------------------------------------------------- synthesis */

export type Proposal = {
  id: number;
  runId: string | null;
  at: string;
  ventureId: string;
  /** Null when the venture has since been deleted. The proposal survives it. */
  venture: string | null;
  rank: number;
  title: string;
  why: string;
  evidenceKey: string | null;
  evidenceLine: string | null;
  verdict: "filed" | "dropped";
  /** The gate's own sentence, on every dropped row. */
  reason: string | null;
  cardOrigin: string | null;
  /** The evidence AS IT WAS. A snapshot, never today's figures. */
  packet: unknown;
};

export type SynthesisDoc = {
  config: {
    venturesPerNight: number;
    perVenture: number;
    perNight: number;
    repeatDays: number;
    model: string | null;
    defaults: { venturesPerNight: number; perVenture: number; perNight: number; repeatDays: number };
    settingsAt: string;
  };
  next: { id: string; name: string; lastPassAt: string | null }[];
  coverage: {
    ventureId: string;
    venture: string | null;
    lastPassAt: string | null;
    passes: number;
    proposalsOn: boolean;
  }[];
  proposals: Proposal[];
  filed: number;
  dropped: number;
  notes: { dropped: string; evidence: string; cards: string };
};

export type VenturePass = {
  ventureId: string;
  venture: string;
  ran: boolean;
  why: string | null;
  filed: number;
  dropped: number;
  model: string | null;
  verdicts: { title: string; verdict: "filed" | "dropped"; reason: string | null; evidence: string }[];
  note: string;
};

export const synthesisApi = {
  all: (opts: { ventureId?: string; verdict?: "filed" | "dropped"; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.ventureId) q.set("ventureId", opts.ventureId);
    if (opts.verdict) q.set("verdict", opts.verdict);
    if (opts.limit) q.set("limit", String(opts.limit));
    const s = q.toString();
    return call<SynthesisDoc>(`/synthesis${s ? `?${s}` : ""}`);
  },
  run: (ventureId: string, dry = false) =>
    call<VenturePass>("/synthesis/run", { method: "POST", body: JSON.stringify({ ventureId, dry }) }),
  setProposals: (key: string, proposals: boolean) =>
    call<{ ventureId: string; venture: string; proposals: boolean }>(
      `/synthesis/ventures/${encodeURIComponent(key)}`,
      { method: "PATCH", body: JSON.stringify({ proposals }) },
    ),
};
