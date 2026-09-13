import { call } from "@/lib/api";
import type { DashboardAlertsDoc } from "../../../../shared/dashboardAlerts";

/**
 * ALERTS AND THE BRIEFING, FROM THIS SIDE.
 *
 * TWO FEATURES AND ONE FILE, because they are one idea at two cadences: a
 * comparison the owner wrote down, checked every half hour, and the whole day
 * assembled once. They share a page and they share the badge in the rail, so a
 * second module would be a second place to keep the same types.
 *
 * THE RULE EDITOR DRAWS ITSELF OUT OF `GET /api/skills`. Nothing in this file
 * lists a skill, a view or a parameter: the catalogue does, the server
 * validates against the same document, and an integration added next year
 * appears in the picker with no client release. That is why `SkillCatalogue`
 * below is a transcription of the skills route's own shape rather than a
 * hand-kept list.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND. Where the server says
 * null, this says null and the pages draw it: `lastValue: null` is "nothing has
 * read this yet", `narration: null` with a `narrationNote` is "no model wrote
 * one and here is why", and `value: null` on a test is a document that could
 * not be read — never a zero.
 */

/* -------------------------------------------------------------- catalogue */

export type CatalogueParam = {
  name: string;
  type: "number" | "string";
  required: boolean;
  default: string | number | null;
  in: "query" | "path" | "body";
  about: string;
};

export type CatalogueView = {
  key: string;
  route: string;
  about: string;
  params: CatalogueParam[];
};

export type CatalogueSkill = {
  id: string;
  title: string;
  connected: boolean;
  about: string;
  rules: string[];
  views: CatalogueView[];
};

export type SkillCatalogue = {
  skills: CatalogueSkill[];
  disconnected: { id: string; title: string; needs: string[] }[];
};

/* ------------------------------------------------------------------ rules */

export type Operator =
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!="
  | "changed"
  | "dropped_by_pct"
  | "rose_by_pct";

export type OperatorInfo = {
  op: Operator;
  needsThreshold: boolean;
  needsWindow: boolean;
  about: string;
};

export type AlertRule = {
  id: number;
  name: string;
  skill: string;
  view: string;
  params: Record<string, string>;
  path: string;
  op: Operator;
  threshold: number | null;
  windowMinutes: number | null;
  ventureId: string | null;
  enabled: boolean;
  cooldownMinutes: number;
  /** Suggested by the box on first start rather than chosen by the owner. */
  seeded: boolean;
  createdAt: string;
  updatedAt: string;
  /** Null means no evaluation has ever read it. */
  lastEvaluatedAt: string | null;
  /** The last value READ, not the last that tripped. Null with `lastError` is
   *  the unreadable case; null with no error is a rule nothing has asked yet. */
  lastValue: number | null;
  lastError: string | null;
  /** The exact loopback request the rule makes, so it can be checked by hand. */
  url: string;
};

export type AlertEventKind = "trip" | "unreadable" | "test";

export type AlertEvent = {
  id: number;
  ruleId: number;
  ruleName: string | null;
  skill: string | null;
  path: string | null;
  ventureId: string | null;
  ts: string;
  /** `unreadable` is NOT a trip — it is a document that could not be read. */
  kind: AlertEventKind;
  observed: number | null;
  previous: number | null;
  message: string;
  narration: string | null;
  narrationNote: string | null;
  acknowledgedAt: string | null;
};

export type RuleWrite = {
  name: string;
  skill: string;
  view?: string;
  params?: Record<string, string | number>;
  path: string;
  op: Operator;
  threshold?: number | null;
  windowMinutes?: number | null;
  ventureId?: string | null;
  enabled?: boolean;
  cooldownMinutes?: number;
};

export type TestResult = {
  url: string;
  /** Null when the document or the path could not be read. Never a zero. */
  value: number | null;
  readable: boolean;
  why?: string;
  previous?: number | null;
  against?: number | null;
  wouldTrip: boolean;
  /** Set when the comparison could not be made at all — a windowed rule with
   *  no reading old enough. It is not a pass and it is not a trip. */
  undecidable?: string | null;
  message?: string;
  eventId: number;
};

export type AlertsSummary = {
  rules: { total: number; enabled: number; seeded: number; unreadable: number };
  open: { total: number; trips: number; unreadable: number };
  lastPassAt: string | null;
};

/* -------------------------------------------------------------- briefing */

export type BriefingFacts = {
  day: string;
  timezone: string;
  since: string;
  builtAt: string;
  alerts: {
    included: boolean;
    trips: { ts: string; rule: string; skill: string; message: string; narration: string | null; ventureId: string | null }[] | null;
    unreadable: { ts: string; rule: string; message: string }[] | null;
    openTotal: number | null;
    note: string | null;
  };
  movement: {
    included: boolean;
    skills:
      | { skill: string; from: string; to: string; moved: { path: string; before: number; after: number; changePct: number | null }[] }[]
      | null;
    note: string | null;
  };
  runs: {
    included: boolean;
    finished: { id: string; kind: string; venture: string | null; title: string; status: string; finishedAt: string | null }[] | null;
    note: string | null;
  };
  board: {
    included: boolean;
    overdue: { title: string; due: string; column: string; venture: string | null }[] | null;
    dueSoon: { title: string; due: string; column: string; venture: string | null }[] | null;
    note: string | null;
  };
  ventures: {
    included: boolean;
    lines: { id: string; name: string; stage: string; host: string | null; openAlerts: number; runsFinished: number }[] | null;
    note: string | null;
  };
};

export type Briefing = {
  day: string;
  builtAt: string;
  timezone: string;
  /** Empty with a `note` beside it is a briefing whose facts are real and
   *  whose write-up did not happen. It is not a failed briefing. */
  markdown: string;
  facts: BriefingFacts;
  model: string | null;
  note: string | null;
  delivered: { chat: boolean; telegram: boolean; note: string | null };
};

export type BriefingSettings = {
  hour: number;
  defaultHour: number;
  timezone: string;
  systemTimezone: string;
  telegram: boolean;
  sections: Record<string, boolean>;
  today: { day: string; hour: number; built: boolean };
  session: string;
};

/* ------------------------------------------------------------------- calls */

export const alertsApi = {
  navigation: () => call<DashboardAlertsDoc>("/alerts/navigation"),
  catalogue: () => call<SkillCatalogue>("/skills"),

  summary: () => call<AlertsSummary>("/alerts"),

  rules: () =>
    call<{ count: number; rules: AlertRule[]; operators: OperatorInfo[] }>("/alerts/rules"),

  create: (body: RuleWrite) =>
    call<{ rule: AlertRule }>("/alerts/rules", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** A field left out is untouched; a field sent as null is cleared. */
  update: (id: number, patch: Partial<RuleWrite>) =>
    call<{ rule: AlertRule }>(`/alerts/rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  remove: (id: number) =>
    call<{ deleted: number; name: string; eventsRemoved: number }>(`/alerts/rules/${id}`, {
      method: "DELETE",
    }),

  /** Reads the document now and reports the value. Raises no alert. */
  test: (id: number) =>
    call<TestResult>(`/alerts/rules/${id}/test`, { method: "POST" }),

  /**
   * The same read for a rule that does not exist yet — what the editor's path
   * field shows as you type. It records nothing: no rule, no event, no
   * observation.
   */
  preview: (body: { skill: string; view?: string; params?: Record<string, string | number>; path: string }) =>
    call<{ url: string; readable: boolean; value: number | null; why: string | null }>(
      "/alerts/preview",
      { method: "POST", body: JSON.stringify(body) },
    ),

  events: (opts: { days?: number; limit?: number; open?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.days) q.set("days", String(opts.days));
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.open) q.set("open", "1");
    const qs = q.toString();
    return call<{ count: number; open: number; events: AlertEvent[] }>(
      `/alerts/events${qs ? `?${qs}` : ""}`,
    );
  },

  ack: (id: number) =>
    call<{ event: AlertEvent; open: number; note: string }>(`/alerts/events/${id}/ack`, {
      method: "POST",
    }),

  /** The same pass the timer runs — there is no second code path. */
  evaluate: () =>
    call<{
      evaluated: number;
      tripped: number;
      unreadable: number;
      skipped: number;
      snapshots: number;
      raised: AlertEvent[];
    }>("/alerts/evaluate", { method: "POST" }),
};

export const briefingApi = {
  latest: () => call<{ briefing: Briefing | null; note?: string }>("/briefing/latest"),
  history: (days = 14) => call<{ briefings: Briefing[] }>(`/briefing?days=${days}`),
  settings: () => call<BriefingSettings>("/briefing/settings"),
  now: () =>
    call<{ briefing: Briefing; delivery: { chat: boolean; telegram: boolean; note: string | null } }>(
      "/briefing/now",
      { method: "POST" },
    ),
};
