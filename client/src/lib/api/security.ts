import { call } from "@/lib/api";

/**
 * THE SECURITY AREA FROM THIS SIDE — the lock, the snapshots, the screenshot
 * QA and the workstation.
 *
 * THE ONE THING THIS FILE NEVER DOES IS HOLD A CREDENTIAL. A password goes UP
 * and is never read back; a session id comes back only as the thing a revoke
 * button addresses; the service key is a path on the server's disk and never a
 * value on the wire. That is the same one-way door lib/api.ts's header
 * describes, kept here for the one route family that is actually about
 * credentials.
 *
 * NOTHING HERE INVENTS A FIELD THE SERVER DOES NOT SEND. Where the server says
 * null the type says null and the pages draw it: `gpus: null` is "nvidia-smi
 * did not answer", `established: null` is "nothing on that box could count
 * sockets", and an `unchecked` verdict is neither a pass nor a failure.
 */

/* --------------------------------------------------------------- the lock */

export type SessionInfo = {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  revokedAt: string | null;
  /** The browser asking. Revoking this one signs you out. */
  current: boolean;
};

export type SecurityStatus = {
  enabled: boolean;
  authenticated: boolean;
  /** How this request proved itself. Null when there is no password at all. */
  how: "cookie" | "service-key" | null;
  passwordSetAt?: string | null;
  passwordChangedAt?: string | null;
  serviceKeyFile?: string | null;
  sessions?: SessionInfo[];
  note?: string;
};

export const securityApi = {
  status: () => call<SecurityStatus>("/security/status"),
  /* No session id comes back — it is in an HttpOnly cookie and the server
     deliberately keeps it out of the body. */
  login: (password: string) =>
    call<{ ok: true; createdAt: string }>("/security/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () => call<{ ok: true; ended: boolean }>("/security/logout", { method: "POST" }),
  setPassword: (password: string, current?: string) =>
    call<{ ok: true; changed: boolean; note: string }>("/security/password", {
      method: "POST",
      body: JSON.stringify({ password, current: current ?? "" }),
    }),
  removePassword: (current: string) =>
    call<{ ok: true; note: string }>("/security/password", {
      method: "DELETE",
      body: JSON.stringify({ current }),
    }),
  revoke: (id: string) =>
    call<{ ok: true; wasCurrent: boolean }>(`/security/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
};

/* ---------------------------------------------------------- the snapshots */

export type SnapshotSummary = {
  id: number;
  accountId: number;
  host: string;
  ts: string;
  reason: string;
  size: number;
  ok: boolean;
};

export type SnapshotHost = {
  id: number;
  label: string;
  target: string;
  lastSnapshotAt: string | null;
};

export type SnapshotIndex = {
  hosts: SnapshotHost[];
  problems: string[];
  filteredTo: { id: number; label: string } | null;
  snapshots: SnapshotSummary[];
  note: string;
};

export type SnapProc = {
  cpu: number | null;
  mem: number | null;
  rssKb: number | null;
  elapsed: string | null;
  user: string | null;
  command: string;
};

export type Snapshot = {
  id: number;
  accountId: number;
  size: number;
  host: string;
  target: string | null;
  ts: string;
  reason: string;
  ok: boolean;
  error: string | null;
  tookMs: number;
  meta: {
    hostname: string | null;
    kernel: string | null;
    boxTimeUtc: string | null;
    uptimeS: number | null;
    loadavg: string | null;
  };
  processes: { byCpu: SnapProc[]; byMem: SnapProc[]; note: string };
  ports: { tool: string | null; lines: string[]; note: string };
  connections: { established: number | null; note: string };
  disks: { lines: string[]; note: string };
  logs: { source: string | null; lines: string[]; note: string };
  docker: { installed: boolean | null; lines: string[]; note: string };
};

export const snapshotsApi = {
  index: (host?: string | null) =>
    call<SnapshotIndex>(`/snapshots${host ? `?host=${encodeURIComponent(host)}` : ""}`),
  one: (id: number) => call<Snapshot>(`/snapshots/${id}`),
  now: (host: string | number, reason?: string) =>
    call<Snapshot & { id: number }>(`/snapshots/${encodeURIComponent(String(host))}/now`, {
      method: "POST",
      body: JSON.stringify({ reason: reason ?? "" }),
    }),
};

/* ------------------------------------------------------------ screenshot QA */

export type QaVerdict = "pass" | "fail" | "unchecked";
export type QaCheck = { key: string; label: string; verdict: QaVerdict; detail: string };

export type QaVenture = {
  ventureId: string;
  venture: string;
  website: string | null;
  shotTs: string | null;
  shotPath: string | null;
  ageDays: number | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  failed: number;
  unchecked: number;
  pixels: {
    width: number;
    height: number;
    sampled: number;
    mean: number;
    stdev: number;
    dominantShare: number;
    distinctColours: number;
  } | null;
  checks: QaCheck[];
};

export type QaPassSummary = {
  runId: string;
  ts: string;
  ventures: number;
  failed: number;
  unchecked: number;
};

export type QaDoc = {
  runId: string | null;
  ts: string | null;
  ventures: QaVenture[];
  passes: QaPassSummary[];
  runs: { id: string; status: string; queuedAt: string; finishedAt: string | null }[];
  note: string;
};

export const shotsqaApi = {
  get: (runId?: string | null) =>
    call<QaDoc>(`/shotsqa${runId ? `?run=${encodeURIComponent(runId)}` : ""}`),
  run: () => call<{ id: string; status: string }>("/shotsqa/run", { method: "POST" }),
};

/* ----------------------------------------------------------- the workstation */

export type Gpu = {
  name: string;
  temperatureC: number | null;
  utilisationPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
};

export type WorkstationMachine = {
  id: number;
  label: string;
  target: string;
  mac: string | null;
  broadcast: string;
  reachable: boolean;
  hostname: string | null;
  os: string | null;
  uptimeS: number | null;
  /** Null is "nvidia-smi did not answer", with the reason in `gpuNote`. It is
   *  never a claim that the machine has no GPU. */
  gpus: Gpu[] | null;
  gpuNote: string | null;
  error: string | null;
  ms: number;
  checkedAt: string;
  history: { ts: string; reachable: boolean; uptimeS: number | null }[];
};

export type WorkstationDoc = {
  machines: WorkstationMachine[];
  problems: string[];
  commands: {
    sleep: string | null;
    shutdown: string | null;
    documented: Record<string, { sleep: string; shutdown: string }>;
    note: string;
  };
  windowHours: number;
  note: string;
};

export type PowerResult = {
  ok: boolean;
  action: "sleep" | "shutdown";
  command: string;
  exit: number | null;
  output: string;
  error: string | null;
  note: string;
};

export const workstationApi = {
  get: (hours = 168) => call<WorkstationDoc>(`/workstation?hours=${hours}`),
  wake: (id: number | string) =>
    call<{ ok: true; sent: number; to: string; mac: string; note: string }>(
      `/workstation/${encodeURIComponent(String(id))}/wake`,
      { method: "POST" },
    ),
  power: (id: number | string, action: "sleep" | "shutdown") =>
    call<PowerResult>(`/workstation/${encodeURIComponent(String(id))}/${action}`, { method: "POST" }),
};
