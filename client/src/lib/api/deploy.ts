import { call } from "@/lib/api";

/**
 * THE DEPLOY AREA FROM THIS SIDE — the service, its health, its schedule, how
 * boxed-in the agent is, and who is holding a shared machine.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND, which matters more on
 * this area than on most: `running: null` is "the supervisor could not be
 * asked" and is not `false`, `everyMinutes: null` is "deliberately never on the
 * schedule" and is not zero, and a check's `status` is one of three values
 * rather than a boolean. Collapsing any of those into a boolean in this file
 * would put the lie in the type rather than on the page.
 */

export type Verdict = "ok" | "warn" | "fail";

export type Check = {
  key: string;
  status: Verdict;
  detail: string;
  measured?: Record<string, unknown>;
};

export type Health = {
  ok: boolean;
  now: string;
  collectors: string[];
  collectEveryMinutes: number;
  status: Verdict;
  checks: Check[];
  retainDays: { readings: number; load: number };
  note: string;
};

export type ServiceStatus = {
  platform: "darwin" | "linux" | "unsupported";
  label: string;
  unitPath: string;
  installed: boolean;
  supervisor: string | null;
  /** Null means the supervisor could not be asked — not "stopped". */
  running: boolean | null;
  pid: number | null;
  envPath: string;
  envPresent: boolean;
  logs: { out: string; err: string; outBytes: number | null; errBytes: number | null };
  thisProcessPid: number;
  note: string;
};

export type ServicePlan = {
  platform: "darwin" | "linux" | "unsupported";
  label: string;
  unitPath: string;
  unitFile: string;
  unitText: string;
  envPath: string;
  envText: string;
  node: string;
  entry: string;
  root: string;
  outLog: string;
  errLog: string;
  user: string;
  note: string;
};

export type Schedule = {
  pluginId: string;
  connected: boolean;
  /** Null means never on the schedule. Its Collect button still works. */
  everyMinutes: number | null;
  custom: boolean;
  lastStartedAt: string | null;
  nextDueAt: string | null;
  due: boolean;
};

export type FileFacts = {
  path: string;
  present: boolean;
  mode: string | null;
  uid: number | null;
  ownedByThisUser: boolean | null;
  readableByOthers: boolean | null;
};

export type Isolation = {
  level: "same-user" | "separate-user" | "container";
  summary: string;
  runningAs: string;
  configuredAgentUser: string | null;
  problem: string | null;
  agentHome: string;
  files: FileFacts[];
  secretsLocked: boolean;
  scopedKey: { file: string; refusedPrefixes: { prefix: string; methods: string; why: string }[] };
  containerRuntime: string | null;
  nextStep: string;
  note: string;
};

export type Lease = {
  id: string;
  kind: string;
  resource: string;
  ventureId: string | null;
  note: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  live: boolean;
  expiresInS: number;
};

export type Wake = {
  resource: string;
  wokeAt: string;
  wokeBy: string;
  foundState: "asleep" | "awake" | "unknown";
  owns: boolean;
  releasedAt: string | null;
};

export type DeployStatus = {
  service: ServiceStatus;
  health: Health;
  isolation: Isolation;
  scheduler: {
    running: boolean;
    lastTickAt: string | null;
    inFlight: boolean;
    defaultMinutes: number;
    sources: Schedule[];
  };
  leases: { live: Lease[]; stale: Lease[]; wake: Wake[] };
  note: string;
};

export type LogTail = { which: "out" | "err"; path: string; lines: string[]; bytes: number | null; note: string };

export type ActionResult = { ok: boolean; steps: string[]; error: string | null };

export const deployApi = {
  status: () => call<DeployStatus>("/deploy/status"),
  health: () => call<Health>("/deploy/health"),
  plan: () => call<ServicePlan>("/deploy/plan"),
  logs: (which: "out" | "err", lines = 60) => call<LogTail>(`/deploy/logs?which=${which}&lines=${lines}`),
  writePlan: () => call<{ ok: true; unit: string; env: string; note: string }>("/deploy/plan/write", { method: "POST" }),
  install: () => call<ActionResult>("/deploy/service/install", { method: "POST" }),
  uninstall: () => call<ActionResult>("/deploy/service/uninstall", { method: "POST" }),
  releaseLease: (id: string) =>
    call<{ ok: true; lease: Lease }>(`/deploy/leases/${encodeURIComponent(id)}/release`, {
      method: "POST",
      body: JSON.stringify({ reason: "released from Settings → Deployment" }),
    }),
  releaseStale: () => call<{ ok: true; released: number; note: string }>("/deploy/leases/release-stale", { method: "POST" }),
  releaseWake: (resource: string) =>
    call<{ ok: true; wake: Wake; note: string }>(`/deploy/wake/${encodeURIComponent(resource)}/release`, { method: "POST" }),
};
