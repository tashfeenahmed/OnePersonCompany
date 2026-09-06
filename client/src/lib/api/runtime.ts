import { call } from "@/lib/api";

/**
 * THE AGENT RUNTIME, FROM THIS SIDE — two questions, one route family.
 *
 * "Does connecting this model give me a chat that can check my business data?"
 * and "what is my agent scheduled to do, and did it happen?" are the same
 * subject: what the runtime behind chat actually is. Both are read-only; the
 * two POSTs are buttons the owner presses (measure this model now; walk the
 * job stores now) and neither is reachable by an agent.
 *
 * NOTHING HERE INVENTS A FIELD. `mode: null` is "never measured" and is drawn
 * as that rather than as text-only; `readable: false` on a runtime carries the
 * `note` saying exactly what was looked for and where, and the panel prints it
 * instead of an empty list. A store that could not be read is not an empty
 * schedule.
 */

/** What the connection GIVES. `error` is not a verdict about the model — it
 *  means the measurement could not be taken. */
export type ToolMode = "tools" | "text" | "error";

export type RuntimeSettings = {
  tools: boolean;
  actions: boolean;
  maxToolCalls: number;
  toolSeconds: number;
  catalogBytes: number;
  turnUsd: number;
  relay: boolean;
  jobsPerPass: number;
  jobsBodyChars: number;
};

export type ToolCapability = {
  provider: string | null;
  label?: string | null;
  model: string | null;
  /** Null = never measured. */
  mode: ToolMode | null;
  measuredAt: string | null;
  stale: boolean;
  detail: string | null;
  settings: RuntimeSettings;
  /** The server's own sentence for what this connection is. Printed rather
   *  than reassembled here, so the page and the API cannot disagree. */
  why: string;
};

export type NativeJob = {
  runtime: "hermes" | "openclaw";
  id: string;
  name: string | null;
  schedule: string | null;
  enabled: boolean | null;
  state: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  nextRunAt: string | null;
  outputRef: string | null;
  /** The run whose OUTPUT this box actually read — which is a different record
   *  from `lastStatus`, and the disagreement is information. */
  lastSeen: {
    ref: string;
    at: string | null;
    status: string | null;
    delivered: boolean;
    suppressedBy: string | null;
    deliveryError: string | null;
  } | null;
};

export type JobsReading = {
  runtime: "hermes" | "openclaw";
  label: string;
  readable: boolean;
  note: string;
  store: string;
  jobs: NativeJob[];
};

export type JobsDoc = {
  runtimes: JobsReading[];
  counts: { seen: number; delivered: number; pending: number; suppressed: number };
  settings: RuntimeSettings;
  passMinutes: number;
  maxDeliveryAttempts: number;
  scheduling: string;
  generatedAt: string;
};

export type JobResult = {
  id: string;
  runtime: string;
  jobId: string;
  jobName: string | null;
  ref: string;
  at: string | null;
  status: string | null;
  chars: number | null;
  body: string | null;
  seenAt: string;
  deliveredAt: string | null;
  deliveryError: string | null;
  attempts: number;
  suppressedBy: string | null;
  deferredUntil: string | null;
};

export type ResultsDoc = {
  count: number;
  results: JobResult[];
  counts: JobsDoc["counts"];
  generatedAt: string;
};

export const runtimeApi = {
  tools: () => call<ToolCapability>("/runtime/tools"),
  probe: () => call<ToolCapability & { fromCache: boolean }>("/runtime/tools/probe", { method: "POST" }),
  jobs: () => call<JobsDoc>("/runtime/jobs"),
  results: (limit = 20) => call<ResultsDoc>(`/runtime/results?limit=${limit}`),
  refresh: () =>
    call<{ found: number; delivered: number; deferred: number; held: number; failed: number }>(
      "/runtime/jobs/refresh",
      { method: "POST" },
    ),
};
