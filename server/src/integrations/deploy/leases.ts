/**
 * THE LEASE REGISTRY — who is using a shared machine, and therefore who must
 * not have it slept out from under them.
 *
 * WHAT PROBLEM THIS SOLVES, stated as WorkDash's dellsession.js states it: a
 * render finishes, schedules a ten-minute sleep, the owner starts a second job,
 * and the first job's timer fires halfway through and powers off the machine
 * the second one is using. Two independent linger timers is a bug with one
 * clear failure. So ownership and busyness are ONE thing, shared, and every
 * caller that starts work on a shared machine takes a lease around it.
 *
 * A LEASE IS A ROW AND NOT A FLAG, and that is a deliberate departure from the
 * predecessor's Map. This process restarts on every source edit under `src`
 * — several times an afternoon while an area is being built — and an
 * in-memory busy flag would be cleared under a forty-minute video. A row
 * survives it. The price is that a lease has to EXPIRE, because a crashed
 * process cannot delete its own row; so every lease carries a deadline and is
 * live only until that deadline passes.
 *
 * THE HEARTBEAT IS THE PROOF OF LIFE. A long job pushes the deadline forward
 * while it works. A job that stops calling stops holding, after at most the
 * lease's TTL. That is the idle-timeout release the gap list asks for, and it
 * is implemented as absence rather than as a timer: nothing has to fire for a
 * lapsed lease to stop counting, which means nothing can fail to fire.
 *
 * WHAT A LEASE IS NOT. It is not a mutex — two leases on one resource are
 * legal and ordinary, because two jobs can share a GPU and this app cannot
 * know whether they should. It is not a queue: nothing here waits, orders or
 * schedules. It is not a permission: `acquire` never refuses. The single
 * question it answers is `busy(resource)`, and the single thing that question
 * blocks is putting the machine to sleep.
 *
 * `resource` IS A STRING THE CALLER CHOOSES and the two that exist today are
 * `local` — this box, where ffmpeg and any local model run — and
 * `workstation:<accountId>` for a desk machine connected under the workstation
 * plugin. It is not an enum because a resource is whatever the owner has
 * connected, and an enum here would be this file deciding what machines exist.
 */
import { randomUUID } from "node:crypto";
import { db, now } from "../../db.ts";

/**
 * WHAT KIND OF WORK HOLDS THE LEASE. Reported verbatim to the owner and to the
 * agent, so it has to read as a sentence fragment: "video is holding the GPU".
 *
 * It is a documented union rather than a free string because the point of the
 * field is that two areas taking a lease for the same reason spell it the same
 * way — `video` and `videos` in one table is two answers to "what is running".
 * Anything not in this list is stored as given and labelled `other`.
 */
export const LEASE_KINDS = ["video", "inference", "studio", "shotsqa", "manual", "other"] as const;
export type LeaseKind = (typeof LEASE_KINDS)[number];

export function readKind(raw: string | null | undefined): LeaseKind {
  const v = (raw ?? "").trim().toLowerCase();
  return (LEASE_KINDS as readonly string[]).includes(v) ? (v as LeaseKind) : "other";
}

/** This machine. The default resource, and the one a video render uses when no
 *  workstation is involved: ffmpeg runs here. */
export const LOCAL = "local";

/**
 * How long a lease lives without a heartbeat.
 *
 * TEN MINUTES, and the number is a trade rather than a preference. Too short
 * and a job that blocks on one long ffmpeg call loses its lease while it is
 * genuinely working; too long and a crashed render holds a machine awake for an
 * hour. Ten minutes is longer than any single step this box takes without
 * returning to its own event loop, and short enough that a lapse costs one
 * idle cycle rather than an evening.
 */
export const DEFAULT_TTL_MINUTES = 10;
/** The ceiling on what a caller may ask for. A twelve-hour lease is a machine
 *  nothing can ever sleep, which is the failure this whole file exists to make
 *  visible rather than to enable. */
export const MAX_TTL_MINUTES = 240;

export type LeaseRow = {
  id: string;
  kind: string;
  resource: string;
  venture_id: string | null;
  note: string | null;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
};

export type Lease = {
  id: string;
  kind: LeaseKind;
  resource: string;
  ventureId: string | null;
  note: string | null;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  /** Live NOW — not released and not expired. Computed on read rather than
   *  stored, because a stored boolean would be wrong the moment the clock
   *  moved and nothing was there to update it. */
  live: boolean;
  /** Seconds until it lapses; negative once it has. */
  expiresInS: number;
};

const clampTtl = (minutes: number | undefined): number => {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_MINUTES;
  return Math.max(1, Math.min(MAX_TTL_MINUTES, Math.round(n)));
};

function shape(r: LeaseRow, at = Date.now()): Lease {
  const expires = Date.parse(r.expires_at);
  const live = r.released_at === null && Number.isFinite(expires) && expires > at;
  return {
    id: r.id,
    kind: readKind(r.kind),
    resource: r.resource,
    ventureId: r.venture_id,
    note: r.note,
    acquiredAt: r.acquired_at,
    heartbeatAt: r.heartbeat_at,
    expiresAt: r.expires_at,
    releasedAt: r.released_at,
    releaseReason: r.release_reason,
    live,
    expiresInS: Number.isFinite(expires) ? Math.round((expires - at) / 1000) : 0,
  };
}

/* ------------------------------------------------------------------ acquire */

/**
 * Take a lease. NEVER REFUSES, and that is the contract other areas are
 * written against: a caller that had to handle "no" would need a queue, and a
 * queue is not what this is. Two live leases on one resource mean two jobs are
 * sharing the machine, which is a fact rather than a fault.
 */
export function acquire(opts: {
  kind: LeaseKind | string;
  resource?: string;
  ventureId?: string | null;
  note?: string | null;
  ttlMinutes?: number;
}): Lease {
  const ttl = clampTtl(opts.ttlMinutes);
  const at = now();
  const id = randomUUID();
  const expires = new Date(Date.now() + ttl * 60_000).toISOString();
  db.prepare(
    `INSERT INTO job_leases (id, kind, resource, venture_id, note, acquired_at, heartbeat_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    readKind(typeof opts.kind === "string" ? opts.kind : String(opts.kind)),
    (opts.resource ?? LOCAL).trim() || LOCAL,
    opts.ventureId ?? null,
    (opts.note ?? "")?.toString().slice(0, 300) || null,
    at,
    at,
    expires,
  );
  return shape(read(id)!);
}

/**
 * Push the deadline forward. Returns null when there is no such lease, and
 * ALSO when the lease has already been released — a heartbeat is not a way to
 * bring one back, because the caller that released it has moved on and a
 * resurrected lease would hold a machine awake with nothing behind it.
 */
export function heartbeat(id: string, ttlMinutes?: number): Lease | null {
  const row = read(id);
  if (!row || row.released_at !== null) return null;
  const ttl = clampTtl(ttlMinutes);
  const at = now();
  const expires = new Date(Date.now() + ttl * 60_000).toISOString();
  db.prepare("UPDATE job_leases SET heartbeat_at = ?, expires_at = ? WHERE id = ?").run(at, expires, id);
  return shape(read(id)!);
}

/**
 * Hand it back. Idempotent: releasing a released lease is not an error,
 * because the release lives in a `finally` and a `finally` can run twice on a
 * path that also threw.
 */
export function release(id: string, reason = "done"): Lease | null {
  const row = read(id);
  if (!row) return null;
  if (row.released_at === null)
    db.prepare("UPDATE job_leases SET released_at = ?, release_reason = ? WHERE id = ?").run(
      now(),
      reason.slice(0, 200),
      id,
    );
  return shape(read(id)!);
}

export function read(id: string): LeaseRow | null {
  return (db.prepare("SELECT * FROM job_leases WHERE id = ?").get(id) as LeaseRow | undefined) ?? null;
}

/* -------------------------------------------------------------------- reads */

/** Every lease that is live right now, newest first. */
export function live(resource?: string): Lease[] {
  const at = Date.now();
  const rows = db
    .prepare(
      `SELECT * FROM job_leases
        WHERE released_at IS NULL AND expires_at > ?
          ${resource ? "AND resource = ?" : ""}
        ORDER BY acquired_at DESC`,
    )
    .all(...(resource ? [now(), resource] : [now()])) as LeaseRow[];
  return rows.map((r) => shape(r, at)).filter((l) => l.live);
}

/** The recent history, live and finished, for the page and the skill. */
export function recent(limit = 50): Lease[] {
  const at = Date.now();
  const n = Math.max(1, Math.min(500, Math.round(limit)));
  const rows = db
    .prepare("SELECT * FROM job_leases ORDER BY acquired_at DESC LIMIT ?")
    .all(n) as LeaseRow[];
  return rows.map((r) => shape(r, at));
}

/**
 * IS ANYTHING USING THIS MACHINE. The one question the whole file exists for.
 *
 * `holders` is the list a refusal quotes verbatim, so the owner reads "video
 * is rendering for Neu" rather than "busy" — WorkDash's gpu.js makes the same
 * point about naming the claimant.
 */
export function busy(resource = LOCAL): { busy: boolean; holders: Lease[] } {
  const holders = live(resource);
  return { busy: holders.length > 0, holders };
}

/**
 * Leases that lapsed without being released — a crashed job's fingerprint.
 *
 * They are not deleted here. `releaseStale` is an ACTION the owner or the
 * agent takes, and it writes `released_at` with a reason saying it was swept,
 * so the difference between "the job finished" and "the job vanished and
 * somebody cleared up after it" stays readable a week later.
 */
export function stale(): Lease[] {
  const at = Date.now();
  const rows = db
    .prepare("SELECT * FROM job_leases WHERE released_at IS NULL AND expires_at <= ? ORDER BY expires_at DESC")
    .all(now()) as LeaseRow[];
  return rows.map((r) => shape(r, at));
}

export function releaseStale(reason = "swept: the lease expired without being released"): number {
  const rows = stale();
  for (const l of rows)
    db.prepare("UPDATE job_leases SET released_at = ?, release_reason = ? WHERE id = ?").run(
      now(),
      reason.slice(0, 200),
      l.id,
    );
  return rows.length;
}

/** Rows older than this are dropped by the collector-side sweep. Sixty days
 *  answers "what has been using the GPU this quarter"; keeping them for ever
 *  would answer nothing better and this table has no cap of its own. */
export const RETAIN_DAYS = 60;

export function prune(days = RETAIN_DAYS): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return Number(
    db.prepare("DELETE FROM job_leases WHERE released_at IS NOT NULL AND released_at < ?").run(cutoff).changes,
  );
}

/* ------------------------------------------------------------ wake ownership */

export type WakeRow = {
  resource: string;
  woke_at: string;
  woke_by: string;
  found_state: string;
  owns: number;
  released_at: string | null;
};

export type Wake = {
  resource: string;
  wokeAt: string;
  wokeBy: string;
  /** What was true when the wake was sent. `awake` means this app did not
   *  actually wake anything and therefore owes nothing. */
  foundState: "asleep" | "awake" | "unknown";
  /** Does this app owe the shutdown? */
  owns: boolean;
  releasedAt: string | null;
};

function shapeWake(r: WakeRow): Wake {
  return {
    resource: r.resource,
    wokeAt: r.woke_at,
    wokeBy: r.woke_by,
    foundState: r.found_state === "asleep" || r.found_state === "awake" ? r.found_state : "unknown",
    owns: r.owns === 1 && r.released_at === null,
    releasedAt: r.released_at,
  };
}

/**
 * RECORD A WAKE. `foundState` is what the caller observed BEFORE it sent the
 * packet, and it is the whole of the ownership decision: a machine found awake
 * is up for somebody else's reasons and this app is a guest that leaves it
 * running.
 *
 * One row per resource, replaced: the question is "who woke it THIS time",
 * and a history of wakes is what the lease table is for.
 */
export function recordWake(opts: {
  resource: string;
  by: string;
  foundState: "asleep" | "awake" | "unknown";
}): Wake {
  db.prepare(
    `INSERT INTO wake_ownership (resource, woke_at, woke_by, found_state, owns, released_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(resource) DO UPDATE SET
       woke_at = excluded.woke_at,
       woke_by = excluded.woke_by,
       found_state = excluded.found_state,
       owns = excluded.owns,
       released_at = NULL`,
  ).run(opts.resource, now(), opts.by.slice(0, 200), opts.foundState, opts.foundState === "asleep" ? 1 : 0);
  return wakeOwner(opts.resource)!;
}

export function wakeOwner(resource: string): Wake | null {
  const r = db.prepare("SELECT * FROM wake_ownership WHERE resource = ?").get(resource) as WakeRow | undefined;
  return r ? shapeWake(r) : null;
}

export function wakeOwners(): Wake[] {
  const rows = db.prepare("SELECT * FROM wake_ownership ORDER BY woke_at DESC").all() as WakeRow[];
  return rows.map(shapeWake);
}

/** Ownership ends when the machine is put back — or when the owner says it
 *  does. After this, nothing here claims the right to sleep that machine. */
export function releaseWake(resource: string): Wake | null {
  const existing = wakeOwner(resource);
  if (!existing) return null;
  db.prepare("UPDATE wake_ownership SET released_at = ?, owns = 0 WHERE resource = ?").run(now(), resource);
  return wakeOwner(resource);
}

/* ------------------------------------------------------------- the refusal */

/**
 * MAY THIS MACHINE BE SLEPT — the single function the power routes call.
 *
 * Two independent reasons to refuse, and they are reported separately because
 * they are fixed differently. BUSY means a job is mid-flight: wait, or release
 * the lease. NOT OURS means the machine was already up when this app found it
 * — WorkDash's rule, kept — and the fix is that the owner sleeps it themselves,
 * because nothing here can know whose work is on it.
 *
 * `force` EXISTS AND IS THE OWNER'S. An owner looking at the page and pressing
 * the button anyway has decided; a refusal that could not be overridden would
 * be this app owning a machine it does not own. The agent does not get it: the
 * skill's sleep action publishes no force parameter.
 */
export function sleepCheck(resource: string): {
  allowed: boolean;
  refusal: string | null;
  reason: "busy" | "not-ours" | null;
  holders: Lease[];
  wake: Wake | null;
} {
  const { busy: isBusy, holders } = busy(resource);
  const wake = wakeOwner(resource);
  if (isBusy) {
    const what = holders
      .map((h) => `${h.kind}${h.note ? ` (${h.note})` : ""}, held for ${Math.max(0, Math.round((Date.now() - Date.parse(h.acquiredAt)) / 60_000))}m`)
      .join("; ");
    return {
      allowed: false,
      reason: "busy",
      refusal:
        `${holders.length} job${holders.length === 1 ? " is" : "s are"} still holding ${resource}: ${what}. ` +
        `Nothing here will sleep a machine somebody is using. Wait for the job, release the lease on the ` +
        `Deployment page, or sleep it by hand if you know better than the registry does.`,
      holders,
      wake,
    };
  }
  if (wake && !wake.owns && wake.releasedAt === null) {
    return {
      allowed: false,
      reason: "not-ours",
      refusal:
        `${resource} was already awake when this app last looked at it (${wake.wokeAt}), so it is up for somebody ` +
        `else's reasons and this app is a guest. We power off exactly what we powered on. Sleep it yourself if it ` +
        `is genuinely idle — or hand the ownership back on Settings → Deployment (POST ` +
        `/api/deploy/wake/${resource}/release), which is this app forgetting the wake rather than a flag on a URL.`,
      holders,
      wake,
    };
  }
  return { allowed: true, reason: null, refusal: null, holders, wake };
}
