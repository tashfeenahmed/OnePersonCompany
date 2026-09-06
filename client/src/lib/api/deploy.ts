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
  /**
   * HOW LONG HISTORY IS KEPT, TABLE BY TABLE, verbatim from the registry the
   * prune itself walks. It replaces `retainDays: { readings, load }`, which
   * was read out of config and described neither the uptime checks, the fleet
   * samples, the workstation states nor the job leases — and certainly not the
   * three tables nothing pruned at all. A table ABSENT from this list is a
   * table nothing ages out, which is a fact rather than an absence.
   */
  retention: Retention[];
  note: string;
};

/** One table's window. `days` is already resolved to a number by the server,
 *  so a window that follows a setting cannot be reported stale. */
export type Retention = {
  table: string;
  /** The column the cutoff is compared against. */
  column: string;
  days: number;
  /** `setting` is a number the owner can change, named in `setting`; `area` is
   *  a number the owning area chose, for the reason in `note`. Different
   *  answers to "can I keep more". */
  source: "setting" | "area";
  setting?: string;
  /** `day` means the column is a `YYYY-MM-DD` key rather than an instant. */
  grain?: "instant" | "day";
  /** An extra predicate ANDed onto the cutoff — `job_leases` ages only rows
   *  that were RELEASED, because an open lease is a claim and not history. */
  where?: string;
  note?: string;
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
  /** Wider than this file is meant to be. The agent key is group-readable by
   *  design, so for that row this means a WORLD bit; for the rest it means any
   *  group or world bit. `intended` says which. */
  readableByOthers: boolean | null;
  intended: string;
};

/**
 * ONE RULE OFF THE OWNER SURFACE, as the gate itself holds it.
 *
 * THE LEVEL IS THE INTERESTING HALF and the page draws it: `proof`, `browser`
 * and `session` are three different walls, and "the agent key is refused here"
 * says none of which one. `demands` is the gate's own sentence for that level.
 *
 * `paths` is the exact-route form and null for a prefix rule; `prefix` is the
 * first path in that case, so a caller that only wants a name has one.
 */
export type RefusedRoute = {
  prefix: string;
  paths: string[] | null;
  /** `write` is everything but GET/HEAD/OPTIONS; `all` includes reads. */
  methods: "write" | "all";
  level: "proof" | "browser" | "session";
  demands: string;
  why: string;
};

export type Isolation = {
  /** TWO LEVELS, NOT THREE. A container is a real arrangement and the server
   *  deliberately does not report it as a level, because nothing there can
   *  observe one — see `containerPath`. */
  level: "same-user" | "separate-user";
  summary: string;
  runningAs: string;
  configuredAgentUser: string | null;
  problem: string | null;
  agentHome: string;
  files: FileFacts[];
  secretsLocked: boolean;
  scopedKey: { file: string; refusedPrefixes: RefusedRoute[] };
  /** The agent's key file could not be read or written. The agent is locked
   *  out at the gate until somebody fixes it, and the page must say so. */
  agentKeyProblem: string | null;
  containerPath: { runtime: string | null; observed: false; note: string };
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
  /** Something is demonstrably still working under it — a heartbeat inside the
   *  server's own window. The SERVER decides this, so the button and the route
   *  cannot disagree about which leases need a deliberate override. */
  beating: boolean;
  heartbeatAgeS: number;
};

export type Wake = {
  resource: string;
  wokeAt: string;
  wokeBy: string;
  /** `unknown` is an ssh failure that could be sleep OR a rotated key OR a
   *  firewall. It owns nothing, and it is not the same fact as `awake`. */
  foundState: "asleep" | "awake" | "unknown";
  owns: boolean;
  releasedAt: string | null;
  /** The claim aged out. Reported apart from `owns` because "we woke it, and
   *  that was yesterday" is a different sentence from "it was already awake". */
  expired: boolean;
  expiresAt: string;
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
  /**
   * `force` IS A REAL BOOLEAN AND IT IS THE OWNER'S.
   *
   * The server answers 409 for a lease whose holder beat within the last two
   * minutes, because releasing it would not stop the job — it would only
   * remove the reason nothing will sleep the machine under it. The page catches
   * that 409, says which job, and offers this again with `force`. The agent has
   * no such parameter: the route refuses it for anything the skills proxy
   * re-issued or that carries the agent key.
   */
  releaseLease: (id: string, force = false) =>
    call<{ ok: true; lease: Lease }>(`/deploy/leases/${encodeURIComponent(id)}/release`, {
      method: "POST",
      body: JSON.stringify({ reason: "released from Settings → Deployment", ...(force ? { force: true } : {}) }),
    }),
  releaseStale: () => call<{ ok: true; released: number; note: string }>("/deploy/leases/release-stale", { method: "POST" }),
  releaseWake: (resource: string) =>
    call<{ ok: true; wake: Wake; note: string }>(`/deploy/wake/${encodeURIComponent(resource)}/release`, { method: "POST" }),
};
