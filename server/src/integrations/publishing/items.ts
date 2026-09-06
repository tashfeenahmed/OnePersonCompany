/**
 * THE QUEUE: one thing, going to one place, and every state it was in.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE. Nothing is published that the
 * owner did not approve. `draft` is what a generator may create; `approved`
 * can only be set by `approve()`, which is reachable from the UI and from a
 * skill action marked destructive, and there is no other path in this codebase
 * from a draft to a submission. The scheduler reads only `scheduled` rows, and
 * `schedule()` refuses a row that is not approved. That is three checks in a
 * line rather than one, deliberately: an automation that posted on somebody's
 * behalf is the failure this whole area is shaped around.
 *
 * IDEMPOTENCE IS TWO RULES AND THEY CATCH DIFFERENT MISTAKES. The unique
 * `idempotency_key` — venture, source artefact, destination — catches "queue
 * this post to that Page" being asked twice, whether by a double press, a
 * retried HTTP request or an agent that lost its place. The `external_id`
 * check catches the worse one: an item that HAS been submitted is never
 * submitted again, whatever its status says, which is what protects against a
 * retry that fires after a network timeout on a call that actually succeeded.
 *
 * THE CAPTION IS COPIED, NOT REFERENCED. A Studio post's caption is the
 * Studio's; an item's caption is the thing that will be sent, and the owner
 * edits it here without rewriting the draft it came from. That is a
 * duplication and it is the right one: a caption trimmed to fit Instagram must
 * not silently change what a Facebook item is about.
 *
 * THE MEDIA IS A PATH AND NOT A COPY, for the reason the migration gives: the
 * PNG belongs to the Studio and the mp4 to the video area. A file that has
 * gone is a refusal naming the file, never a publish of nothing.
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { db, now, ventureRowById } from "../../db.ts";
import { destinationRow, readCapabilities, type DestinationRow } from "./destinations.ts";
import { checkLimits, LIMITS, type DestinationKind, type LimitProblem, type MediaKind } from "./limits.ts";
import { settings } from "./settings.ts";

export type ItemStatus =
  | "draft"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled";

export type ItemRow = {
  id: string;
  venture_id: string;
  destination_id: string | null;
  source_kind: string;
  source_id: string | null;
  caption: string | null;
  media_kind: string;
  media_path: string | null;
  status: string;
  scheduled_for: string | null;
  approved_at: string | null;
  approved_by: string | null;
  idempotency_key: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  external_id: string | null;
  permalink: string | null;
  error: string | null;
  note: string | null;
  campaign_id: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export function itemRow(id: string): ItemRow | undefined {
  return db.prepare("SELECT * FROM publish_items WHERE id = ?").get(id) as ItemRow | undefined;
}

/* ------------------------------------------------------------------ media */

/** What a file actually is, from its first bytes. An extension is a claim and
 *  the magic numbers are the fact — and Instagram's JPEG-only rule is decided
 *  on this answer, so a wrong one would be a post that fails at Meta. */
export function sniff(bytes: Uint8Array): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.slice(from, to));
  if (bytes.length > 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length > 6 && ascii(0, 3) === "GIF") return "image/gif";
  if (bytes.length > 12 && ascii(4, 8) === "ftyp") return "video/mp4";
  return null;
}

/** The mime a path claims, for the cases where reading the file is not worth
 *  it. Only ever a fallback: `sniff` wins wherever bytes are already in hand. */
export function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      mp4: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
    }[ext] ?? "application/octet-stream"
  );
}

/* ---------------------------------------------------------------- sources */

export type Source =
  | { kind: "studio_post"; id: string }
  | { kind: "video_job"; id: string }
  | { kind: "manual"; id: null };

export type ResolvedSource = {
  ventureId: string | null;
  caption: string | null;
  mediaKind: MediaKind;
  mediaPath: string | null;
  error: string | null;
};

/**
 * What a source artefact actually is, read once at the moment an item is made.
 *
 * A STUDIO POST'S HASHTAGS ARE PART OF ITS CAPTION HERE and are not a separate
 * field. The Studio keeps them apart because a regenerated caption replaces
 * both; a post going out has one body of text, and joining them at the moment
 * of queueing is the only place the join is unambiguous.
 */
export function resolveSource(source: Source): ResolvedSource {
  if (source.kind === "manual")
    return { ventureId: null, caption: null, mediaKind: "none", mediaPath: null, error: null };

  if (source.kind === "studio_post") {
    const row = db
      .prepare("SELECT venture_id, caption, hashtags, image_path FROM studio_posts WHERE id = ?")
      .get(source.id) as
      | { venture_id: string; caption: string | null; hashtags: string | null; image_path: string | null }
      | undefined;
    if (!row)
      return {
        ventureId: null,
        caption: null,
        mediaKind: "none",
        mediaPath: null,
        error: `There is no Studio post ${source.id}.`,
      };
    const caption = [row.caption ?? "", row.hashtags ?? ""].filter((s) => s.trim()).join("\n\n");
    const onDisk = row.image_path && existsSync(row.image_path);
    return {
      ventureId: row.venture_id,
      caption: caption || null,
      mediaKind: onDisk ? "image" : "none",
      mediaPath: onDisk ? row.image_path : null,
      error: null,
    };
  }

  const job = db
    .prepare("SELECT run_id, venture_id, path FROM video_jobs WHERE run_id = ?")
    .get(source.id) as { run_id: string; venture_id: string | null; path: string | null } | undefined;
  if (!job)
    return {
      ventureId: null,
      caption: null,
      mediaKind: "none",
      mediaPath: null,
      error: `There is no finished video for run ${source.id}.`,
    };
  const run = db.prepare("SELECT title FROM agent_runs WHERE id = ?").get(source.id) as
    | { title: string }
    | undefined;
  const onDisk = job.path && existsSync(job.path);
  return {
    ventureId: job.venture_id,
    /* The run's own title, which is the brief somebody typed. It is a STARTING
       POINT for a caption and the owner edits it — a video's script is not a
       caption and turning one into the other automatically would produce a
       wall of narration under a clip. */
    caption: run?.title ?? null,
    mediaKind: onDisk ? "video" : "none",
    mediaPath: onDisk ? job.path : null,
    error: onDisk ? null : "The video file is no longer on disk.",
  };
}

/* ------------------------------------------------------------------ shape */

export function shapeItem(r: ItemRow) {
  const dest = r.destination_id ? destinationRow(r.destination_id) : undefined;
  const venture = ventureRowById(r.venture_id);
  const facts = mediaFacts(r);
  return {
    id: r.id,
    ventureId: r.venture_id,
    venture: venture ? { id: venture.id, slug: venture.slug, name: venture.name } : null,
    destinationId: r.destination_id,
    destination: dest
      ? {
          id: dest.id,
          kind: dest.kind,
          label: LIMITS[dest.kind as DestinationKind]?.label ?? dest.kind,
          handle: dest.handle,
          enabled: dest.enabled === 1,
          capabilities: readCapabilities(dest.capabilities),
        }
      : null,
    source: { kind: r.source_kind, id: r.source_id },
    caption: r.caption,
    media: {
      kind: r.media_kind as MediaKind,
      /** Present but gone from disk is a real state and the queue draws it. */
      onDisk: facts.onDisk,
      mime: facts.mime,
      bytes: facts.bytes,
      url: r.media_kind === "none" ? null : `/api/publishing/items/${r.id}/media`,
    },
    status: r.status as ItemStatus,
    scheduledFor: r.scheduled_for,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at,
    nextAttemptAt: r.next_attempt_at,
    externalId: r.external_id,
    permalink: r.permalink,
    error: r.error,
    note: r.note,
    campaignId: r.campaign_id,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    /** What would stop this going out right now, computed on every read. It is
     *  never stored: a caption edited to fit is a different answer, and a
     *  stored one would be stale the moment somebody typed. */
    problems: dest ? problemsFor(r, dest) : [{ field: "media" as const, message: "No destination is chosen." }],
  };
}

/**
 * What the file on disk actually is.
 *
 * THE MIME COMES FROM THE FIRST BYTES, NOT FROM THE EXTENSION, and that
 * matters more here than anywhere else on this route: `submit()` uploads with
 * the SNIFFED type, so a `.jpg` that is really a PNG would sail through
 * Instagram's JPEG-only gate on the strength of its name and then die at
 * Meta's fetcher minutes later, as a container that never becomes a post. The
 * check and the upload have to agree about what the file is.
 *
 * SIXTEEN BYTES, NOT THE WHOLE FILE. This runs on every read of the queue and
 * some of these files are videos; a magic-number read is a seek and a handful
 * of bytes. The extension is kept only as the fallback for a file whose bytes
 * name nothing this recognises — where a claim is better than nothing.
 */
function mediaFacts(r: ItemRow): { onDisk: boolean; mime: string | null; bytes: number | null } {
  if (!r.media_path) return { onDisk: false, mime: null, bytes: null };
  try {
    const stat = statSync(r.media_path);
    let mime: string | null = null;
    const fd = openSync(r.media_path, "r");
    try {
      const head = Buffer.alloc(16);
      const read = readSync(fd, head, 0, 16, 0);
      mime = sniff(new Uint8Array(head.buffer, head.byteOffset, read));
    } finally {
      closeSync(fd);
    }
    return { onDisk: true, mime: mime ?? mimeFromPath(r.media_path), bytes: stat.size };
  } catch {
    return { onDisk: false, mime: null, bytes: null };
  }
}

/** Everything this app can see wrong with sending this item to its
 *  destination: the platform limits, plus the two things the limits file has
 *  no way to know — whether the destination can post at all, and whether the
 *  file is still there. */
export function problemsFor(r: ItemRow, dest: DestinationRow): LimitProblem[] {
  const kind = dest.kind as DestinationKind;
  const facts = mediaFacts(r);
  const caps = readCapabilities(dest.capabilities);
  const problems: LimitProblem[] = [];

  if (dest.enabled !== 1)
    problems.push({ field: "media", message: "That destination is switched off." });

  const mediaKind = r.media_kind as MediaKind;
  const capable =
    mediaKind === "video" ? caps.video : mediaKind === "image" ? caps.photo : caps.text;
  if (!capable)
    problems.push({
      field: "media",
      message:
        caps.missing.length
          ? `The last probe said this destination cannot post a ${mediaKind === "none" ? "caption" : mediaKind}: missing ${caps.missing.join("; ")}.`
          : `The last probe said this destination cannot post a ${mediaKind === "none" ? "caption" : mediaKind}.`,
    });

  if (r.media_path && !facts.onDisk)
    problems.push({ field: "media", message: "The file this item points at is no longer on disk." });

  problems.push(
    ...checkLimits(kind, {
      caption: r.caption,
      media: {
        kind: mediaKind,
        mime: facts.mime,
        bytes: facts.bytes,
        publicUrl: publicMediaUrl(r.id),
      },
    }),
  );
  return problems;
}

/**
 * The URL Instagram or TikTok would be handed, or null.
 *
 * NULL IS THE COMMON CASE AND IT IS NOT A BUG. This server binds to loopback;
 * nothing on Meta's network can reach it. The owner has to have arranged a
 * public route to this API and typed it into `publicBaseUrl`, and until they
 * have, the two destinations that fetch their own media say so rather than
 * attempting a post that would fail minutes later at somebody else's fetcher.
 */
export function publicMediaUrl(itemId: string): string | null {
  const base = settings().publicBaseUrl;
  return base ? `${base}/api/publishing/items/${itemId}/media` : null;
}

/* ------------------------------------------------------------- the writes */

export type CreateResult =
  | { ok: true; item: ItemRow; created: boolean }
  | { ok: false; error: string };

/**
 * Queue one thing for one place — or hand back the row that already exists.
 *
 * `created: false` IS A SUCCESS. Asking twice is not an error, it is the same
 * request; returning the existing row rather than a 409 is what makes this
 * safe to call from a retry, from an agent and from a button somebody
 * double-pressed.
 */
export function createItem(input: {
  ventureId?: string | null;
  source: Source;
  destinationId?: string | null;
  caption?: string | null;
  campaignId?: string | null;
}): CreateResult {
  const resolved = resolveSource(input.source);
  if (resolved.error && input.source.kind !== "manual") return { ok: false, error: resolved.error };

  const ventureId = input.ventureId ?? resolved.ventureId;
  if (!ventureId) return { ok: false, error: "An item needs a venture." };
  if (!ventureRowById(ventureId)) return { ok: false, error: `There is no venture ${ventureId}.` };

  let destination: DestinationRow | undefined;
  if (input.destinationId) {
    destination = destinationRow(input.destinationId);
    if (!destination) return { ok: false, error: `There is no destination ${input.destinationId}.` };
    if (destination.venture_id !== ventureId)
      return {
        ok: false,
        error: "That destination belongs to a different venture. A post does not cross businesses by accident.",
      };
  }

  const caption = (input.caption ?? resolved.caption ?? "").trim() || null;
  const key = [
    ventureId,
    input.source.kind,
    input.source.id ?? randomUUID(),
    input.destinationId ?? "none",
  ].join("|");

  const existing = db
    .prepare("SELECT * FROM publish_items WHERE idempotency_key = ?")
    .get(key) as ItemRow | undefined;
  if (existing) return { ok: true, item: existing, created: false };

  const id = `pi-${randomUUID().slice(0, 8)}`;
  const ts = now();
  db.prepare(
    `INSERT INTO publish_items
       (id, venture_id, destination_id, source_kind, source_id, caption, media_kind,
        media_path, status, idempotency_key, campaign_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?)`,
  ).run(
    id,
    ventureId,
    input.destinationId ?? null,
    input.source.kind,
    input.source.id,
    caption,
    resolved.mediaKind,
    resolved.mediaPath,
    key,
    input.campaignId ?? null,
    ts,
    ts,
  );
  return { ok: true, item: itemRow(id)!, created: true };
}

/**
 * Change the words or the account. AN EDIT UNAPPROVES.
 *
 * The approval on this row means "THIS exact text, with THIS exact picture, to
 * THIS exact account" — that is what the file header claims and what the queue
 * page tells the owner. An edited row is a different document, so leaving the
 * approval standing would mean the scheduler sending text nobody read to an
 * account nobody chose. `mailflow/outbox-routes.ts` keeps the same rule for
 * the same reason and says so in its own header; this is that rule, here.
 *
 * It is the only place in this file where a status moves BACKWARDS, and it
 * moves towards the state where a person has to press the button again.
 */
export function patchItem(
  id: string,
  patch: { caption?: string | null; destinationId?: string | null },
): { ok: true; item: ItemRow; unapproved: boolean } | { ok: false; error: string } {
  const row = itemRow(id);
  if (!row) return { ok: false, error: "No item by that id." };
  if (row.status === "published")
    return { ok: false, error: "That item is published. Editing it here would not change the post." };
  if (row.status === "publishing")
    return { ok: false, error: "That item is being submitted right now." };

  /* What is actually CHANGING, decided before anything is written — an edit
     that sets the caption to the caption it already had is not an edit, and
     unapproving on it would punish somebody for pressing save. */
  const changesDestination =
    patch.destinationId !== undefined && patch.destinationId !== row.destination_id;
  const nextCaption =
    patch.caption === undefined ? undefined : (patch.caption ?? "").trim() || null;
  const changesCaption = nextCaption !== undefined && nextCaption !== row.caption;

  if (patch.destinationId !== undefined && patch.destinationId !== row.destination_id) {
    if (patch.destinationId) {
      const dest = destinationRow(patch.destinationId);
      if (!dest) return { ok: false, error: `There is no destination ${patch.destinationId}.` };
      if (dest.venture_id !== row.venture_id)
        return { ok: false, error: "That destination belongs to a different venture." };
    }
    /* THE KEY MOVES WITH THE DESTINATION. It is composed of the destination,
       so changing one without the other would let the same source be queued
       twice to the same place under two keys — which is the exact thing the
       unique index exists to stop. */
    const key = [row.venture_id, row.source_kind, row.source_id ?? row.id, patch.destinationId ?? "none"].join("|");
    const clash = db.prepare("SELECT id FROM publish_items WHERE idempotency_key = ? AND id != ?").get(key, id) as
      | { id: string }
      | undefined;
    if (clash)
      return {
        ok: false,
        error: `That source is already queued to that destination as ${clash.id}.`,
      };
    db.prepare("UPDATE publish_items SET destination_id = ?, idempotency_key = ? WHERE id = ?").run(
      patch.destinationId ?? null,
      key,
      id,
    );
  }
  if (nextCaption !== undefined)
    db.prepare("UPDATE publish_items SET caption = ? WHERE id = ?").run(nextCaption, id);

  /* The unapproval. `draft` and `cancelled` have no approval to withdraw, so
     they are left where they are; everything else that actually changed goes
     back to `draft` and loses its date, because a date on an unapproved row is
     a slot the scheduler will never look at and the owner might believe in. */
  const unapproved =
    (changesCaption || changesDestination) &&
    row.status !== "draft" &&
    row.status !== "cancelled";
  if (unapproved)
    db.prepare(
      `UPDATE publish_items
          SET status = 'draft', approved_at = NULL, approved_by = NULL,
              scheduled_for = NULL, next_attempt_at = NULL, error = NULL
        WHERE id = ?`,
    ).run(id);

  db.prepare("UPDATE publish_items SET updated_at = ? WHERE id = ?").run(now(), id);
  return { ok: true, item: itemRow(id)!, unapproved };
}

/**
 * THE OWNER'S CONSENT, and the only place it is recorded.
 *
 * Approving does NOT publish. It says this exact text, with this exact
 * picture, may go to this exact account — and then either the owner schedules
 * it or presses publish. Splitting the two is what makes "approve everything
 * in the queue" a safe thing to do.
 */
export function approve(id: string, by: string): { ok: true; item: ItemRow } | { ok: false; error: string } {
  const row = itemRow(id);
  if (!row) return { ok: false, error: "No item by that id." };
  if (row.external_id)
    return { ok: false, error: "That item has already been submitted; approving it again would change nothing." };
  if (row.status !== "draft" && row.status !== "failed" && row.status !== "cancelled")
    return { ok: false, error: `That item is ${row.status}, not a draft.` };
  if (!row.destination_id) return { ok: false, error: "Choose a destination before approving." };
  const dest = destinationRow(row.destination_id);
  if (!dest) return { ok: false, error: "That item's destination no longer exists." };

  const problems = problemsFor(row, dest);
  if (problems.length)
    return {
      ok: false,
      error:
        "This cannot go out as it stands: " + problems.map((p) => p.message).join(" "),
    };

  db.prepare(
    "UPDATE publish_items SET status = 'approved', approved_at = ?, approved_by = ?, error = NULL, attempts = 0, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now(), by.slice(0, 60), now(), id);
  return { ok: true, item: itemRow(id)! };
}

export function schedule(
  id: string,
  whenIso: string,
): { ok: true; item: ItemRow } | { ok: false; error: string } {
  const row = itemRow(id);
  if (!row) return { ok: false, error: "No item by that id." };
  if (row.external_id) return { ok: false, error: "That item has already been submitted." };
  if (row.status !== "approved" && row.status !== "scheduled")
    return {
      ok: false,
      error:
        "Only an approved item can be scheduled. Approve it first — the calendar does not " +
        "carry consent, the approval does.",
    };
  const when = new Date(whenIso);
  if (Number.isNaN(when.getTime())) return { ok: false, error: "That is not a date this can read." };
  db.prepare(
    "UPDATE publish_items SET status = 'scheduled', scheduled_for = ?, next_attempt_at = NULL, error = NULL, updated_at = ? WHERE id = ?",
  ).run(when.toISOString(), now(), id);
  return { ok: true, item: itemRow(id)! };
}

/** Off the calendar; still approved. The date goes and nothing else does. */
export function unschedule(id: string): { ok: true; item: ItemRow } | { ok: false; error: string } {
  const row = itemRow(id);
  if (!row) return { ok: false, error: "No item by that id." };
  if (row.status !== "scheduled")
    return { ok: false, error: `That item is ${row.status}, not scheduled.` };
  db.prepare(
    "UPDATE publish_items SET status = 'approved', scheduled_for = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now(), id);
  return { ok: true, item: itemRow(id)! };
}

/** Cancelled is a resting state, not a deletion: the row stays so the queue
 *  can say a thing was decided against rather than losing it silently. */
export function cancel(id: string): { ok: true; item: ItemRow } | { ok: false; error: string } {
  const row = itemRow(id);
  if (!row) return { ok: false, error: "No item by that id." };
  if (row.status === "published")
    return {
      ok: false,
      error: "That is already published. Cancelling it here would not take the post down.",
    };
  if (row.status === "publishing")
    return { ok: false, error: "That item is being submitted right now." };
  db.prepare(
    "UPDATE publish_items SET status = 'cancelled', scheduled_for = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now(), id);
  return { ok: true, item: itemRow(id)! };
}

export function itemRows(filter: {
  ventureId?: string | null;
  status?: string | null;
  campaignId?: string | null;
  limit?: number;
}): ItemRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.ventureId) {
    where.push("venture_id = ?");
    args.push(filter.ventureId);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.campaignId) {
    where.push("campaign_id = ?");
    args.push(filter.campaignId);
  }
  const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 200)));
  args.push(limit);
  return db
    .prepare(
      `SELECT * FROM publish_items ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY COALESCE(scheduled_for, created_at) DESC LIMIT ?`,
    )
    .all(...args) as unknown as ItemRow[];
}

/** The counts a page draws above the queue. Every status, including the ones
 *  with none, so a zero is visibly a zero rather than a missing row. */
export function statusCounts(ventureId?: string | null): Record<ItemStatus, number> {
  const rows = (
    ventureId
      ? db
          .prepare("SELECT status, COUNT(*) AS n FROM publish_items WHERE venture_id = ? GROUP BY status")
          .all(ventureId)
      : db.prepare("SELECT status, COUNT(*) AS n FROM publish_items GROUP BY status").all()
  ) as unknown as { status: string; n: number }[];
  const out: Record<ItemStatus, number> = {
    draft: 0,
    approved: 0,
    scheduled: 0,
    publishing: 0,
    published: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const r of rows) if (r.status in out) out[r.status as ItemStatus] = r.n;
  return out;
}
