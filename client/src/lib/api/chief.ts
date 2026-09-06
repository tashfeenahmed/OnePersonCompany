import { call } from "@/lib/api";
import { alertsApi } from "@/lib/api/proactive";

/**
 * THE CHIEF OF STAFF'S FOUR DOCUMENTS — goals, memory, rounds and outcomes.
 *
 * THE TYPES ARE TRANSCRIBED FROM THE SERVER'S SHAPES rather than generated, the
 * way every other file in this directory does it, and the rule is the same: a
 * field that is nullable on the wire is nullable here. That matters more in
 * this area than in most, because three of the four documents carry a null that
 * MEANS something — a goal nobody has written, a note whose venture has been
 * deleted, a metric that could not be read — and a type that smoothed any of
 * them into a zero or an empty string would let the page draw a figure the
 * server refused to state.
 */

/* ------------------------------------------------------------------ goals */

export type GoalDoc = {
  scope: "global" | "venture";
  ventureId: string | null;
  ventureName: string | null;
  ventureSlug: string | null;
  /** The owner's markdown. "" means nothing has been written, which is a real
   *  state and not a missing record. */
  text: string;
  /** Null where nothing has ever been written for this scope. */
  updatedAt: string | null;
  /** What to tailor advice to at this venture's stage. Composed by the server
   *  from the stage the owner chose; null on the global document. */
  tailorTo: string | null;
};

export type GoalsDoc = {
  global: GoalDoc;
  ventures: GoalDoc[];
  summary: { written: number; blank: number };
  note: string;
};

export const goalsApi = {
  all: () => call<GoalsDoc>("/goals"),
  setGlobal: (text: string) =>
    call<GoalDoc>("/goals", { method: "PUT", body: JSON.stringify({ text, by: "owner" }) }),
  setVenture: (key: string, text: string) =>
    call<GoalDoc>(`/goals/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ text, by: "owner" }),
    }),
};

/* ----------------------------------------------------------------- memory */

export type MemoryNote = {
  id: string;
  text: string;
  scope: "global" | "venture";
  ventureId: string | null;
  /** Null when the venture has been deleted. The note survives it. */
  ventureName: string | null;
  /** Who formed the belief. `owner` notes are out of the consolidation pass's
   *  reach, which is why the page draws them differently. */
  source: "agent" | "owner";
  createdAt: string;
  lastConfirmedAt: string;
  ageDays: number;
};

export type MemoryPass = {
  week: string;
  ran_at: string;
  notes_before: number;
  notes_after: number;
  merged: number;
  dropped: number;
  model: string | null;
  error: string | null;
};

export type MemoryDoc = {
  count: number;
  total: number;
  notes: MemoryNote[];
  limits: { maxNote: number; maxNotes: number; injectedIntoChat: number };
  week: string;
  passes: MemoryPass[];
  versions: { id: number; takenAt: string; reason: string; week: string | null; notes: number; restoredAt: string | null }[];
  canUndo: { versionId: number; takenAt: string; reason: string } | null;
  note: string;
};

export type ConsolidateResult = {
  ran: boolean;
  week: string;
  why: string | null;
  before: number;
  after: number;
  merged: number;
  dropped: number;
  model: string | null;
  error: string | null;
  canUndo: boolean;
  note: string;
};

export const memoryApi = {
  all: () => call<MemoryDoc>("/memory"),
  add: (text: string, ventureId?: string | null) =>
    call<{ note: MemoryNote; confirmed: boolean }>("/memory", {
      method: "POST",
      /* `source: "owner"` because a note typed on this page is the owner's,
         and an owner's note is exempt from the write gate and from the
         consolidation pass. */
      body: JSON.stringify({ text, venture: ventureId ?? "", source: "owner" }),
    }),
  edit: (id: string, patch: { text?: string; venture?: string | null }) =>
    call<MemoryNote>(`/memory/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    call<{ deleted: MemoryNote; remaining: number }>(`/memory/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  consolidate: (force = true) =>
    call<ConsolidateResult>("/memory/consolidate", {
      method: "POST",
      body: JSON.stringify({ force }),
    }),
  undo: () =>
    call<{ ok: true; restored: number; from: string; total: number; notes: MemoryNote[] }>(
      "/memory/undo",
      { method: "POST" },
    ),
};

/* ----------------------------------------------------------------- rounds */

export type RoundNote = {
  ventureId: string;
  venture: string;
  stage: string;
  outcome: string;
  reason: string;
  roles: string[];
};

export type Round = {
  id: string;
  startedAt: string;
  /** Null while it is walking — which lasts seconds, so a row that stays open
   *  is a crash rather than work in progress. */
  finishedAt: string | null;
  trigger: string;
  ventures: number;
  dispatched: number;
  skipped: number;
  notes: RoundNote[];
};

export type Job = {
  id: number;
  roundId: string | null;
  ts: string;
  ventureId: string | null;
  role: string | null;
  runId: string | null;
  /** dispatched | skipped | refused | failed. `skipped` and `refused` are
   *  decisions, not faults. */
  outcome: string;
  reason: string;
};

export type Schedule = {
  enabled: boolean;
  hour: number;
  timezone: string | null;
  resolvedTimezone: string;
  roles: string[];
  maxRuns: number;
  daysBetween: number;
  quietStages: string[];
  nextRunAt: string | null;
  session: string;
  defaults: { hour: number; maxRuns: number; daysBetween: number };
  availableRoles: { role: string; kind: string; title: string; what: string; app: string }[];
  settingsAt: string;
};

export type RoundsDoc = {
  schedule: Schedule;
  rounds: Round[];
  last: Round | null;
  jobs: Job[];
  note: string;
};

export const roundsApi = {
  all: () => call<RoundsDoc>("/rounds"),
  startNow: () =>
    call<{ ran: boolean; why: string | null; round: Round | null; jobs: Job[]; note: string }>(
      "/rounds/now",
      { method: "POST", body: JSON.stringify({}) },
    ),
  /* The schedule is SETTINGS and is written where every other setting is,
     through the plugin config door — see the server's rounds-routes header for
     why there is no second validator. */
  save: (config: Record<string, string>) =>
    call<{ id: string; config: Record<string, string> }>("/plugins/rounds/config", {
      method: "PUT",
      body: JSON.stringify({ config }),
    }),
};

/* --------------------------------------------------------------- outcomes */

export type Reading = {
  at: string;
  kind: string;
  /** Which scheduled offset this is; null on the baseline and on a reading
   *  taken by hand, which cannot fill a scheduled slot. */
  dayOffset: number | null;
  /** NULL IS NOT ZERO. A reading that could not be taken carries its reason in
   *  `error`, and a chart must draw a gap rather than a floor. */
  value: number | null;
  error: string | null;
};

export type Outcome = {
  id: string;
  title: string;
  ventureId: string | null;
  ventureName: string | null;
  action: { kind: string; ref: string | null; text: string; at: string; daysAgo: number };
  metric: {
    skill: string;
    view: string;
    params: Record<string, string>;
    path: string;
    unit: string | null;
    address: string;
  };
  createdAt: string;
  closedAt: string | null;
  baseline: { at: string; value: number | null; error: string | null } | null;
  readings: Reading[];
  before: number | null;
  after: number | null;
  delta: number | null;
  /** Null when the baseline was zero — a percentage of nothing is not a
   *  percentage — and the delta is still there. */
  pct: number | null;
  verdict: "up" | "down" | "flat" | "pending" | "unreadable";
  due: { dayOffset: number; dueAt: string; overdue: boolean }[];
  window: string;
  caveat: string;
};

export type OutcomesDoc = {
  count: number;
  outcomes: Outcome[];
  summary: { up: number; down: number; flat: number; pending: number; unreadable: number };
  schedule: { offsetsDays: number[]; flatBandPct: number };
  note: string;
};

export type TrackInput = {
  title: string;
  skill: string;
  view?: string;
  params?: Record<string, string>;
  path: string;
  actionAt: string;
  actionKind?: string;
  actionRef?: string;
  actionText?: string;
  venture?: string;
  unit?: string;
};

export const outcomesApi = {
  all: () => call<OutcomesDoc>("/outcomes"),
  track: (input: TrackInput) =>
    call<{ outcome: Outcome; note: string }>("/outcomes", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  read: (id: string) =>
    call<{ reading: Reading; outcome: Outcome; note: string }>(
      `/outcomes/${encodeURIComponent(id)}/read`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  remove: (id: string) =>
    call<{ deleted: Outcome }>(`/outcomes/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/* ------------------------------------------- the catalogue, for the picker */

/*
  GET /skills IS DESCRIBED IN `lib/api/proactive.ts`. It was described here as
  well, and the two had drifted in the direction that costs a reader something:
  this copy had no `about` and no `rules[]`, both of which the server has been
  sending all along, so the page that picks a skill to track could not show the
  sentence describing it or the honesty rules it publishes — and the next field
  the server adds would have reached one consumer of two.

  The alerts picker and the outcome picker read the same document for the same
  reason, so they read the same type.
*/

/** DEPRECATED: import `CatalogueSkill` from @/lib/api/proactive */
export type { CatalogueSkill as SkillSummary } from "@/lib/api/proactive";

/** DEPRECATED: call `alertsApi.catalogue` from @/lib/api/proactive */
export const catalogueApi = { skills: alertsApi.catalogue };
