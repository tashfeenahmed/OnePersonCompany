/**
 * THE VIDEO ROWS, READ AND WRITTEN IN ONE PLACE.
 *
 * Same split the runs store keeps: snake_case stays in SQLite, the shaping
 * functions produce the wire shapes, and null on the wire means "not measured"
 * rather than zero. A duration of null is a file ffprobe could not read, never
 * a zero-second video.
 *
 * THE FILE PATHS DO NOT GO ON THE WIRE AS PATHS. A client is handed
 * `/api/video/<runId>/file`, which is a route this server controls; the row's
 * `path` column is where the bytes actually are and stays on this side. That
 * is the same rule the papers routes keep, and for the same reason: a browser
 * handed a local path can do nothing with it, and a route that took one from a
 * caller would be a way to read any file on the disk.
 *
 * `onDisk` IS CHECKED RATHER THAN ASSUMED. A row survives its file — the data
 * directory can be cleared, an archive can be pruned — and a page that offered
 * a player for a file that is not there would be a broken video element with
 * no explanation. The route's own 404 carries the sentence; this flag lets the
 * page not offer the player at all.
 */
import { existsSync } from "node:fs";
import { db, now, ventureRowById } from "../../db.ts";
import type { Asset } from "./footage.ts";
import type { Script } from "./script.ts";
import { framingRows, shapeFraming, type FramingRow } from "../videoplus/store.ts";

export type JobRow = {
  run_id: string;
  venture_id: string | null;
  format: string;
  ts: string;
  aspect: string;
  width: number | null;
  height: number | null;
  script: string;
  assets: string;
  duration_s: number | null;
  bytes: number | null;
  path: string | null;
  captions: string | null;
  narration: string | null;
  transcript: string | null;
  error: string | null;
};

export type ClipRow = {
  run_id: string;
  idx: number;
  title: string;
  reason: string | null;
  chosen_by: string;
  start_s: number;
  end_s: number;
  duration_s: number | null;
  path: string | null;
  bytes: number | null;
  captions: string | null;
};

const parse = <T>(raw: string, fallback: T): T => {
  try {
    const v = JSON.parse(raw) as unknown;
    return (v ?? fallback) as T;
  } catch {
    /* A hand-edited row costs its manifest, not its video. */
    return fallback;
  }
};

export function jobRow(runId: string): JobRow | undefined {
  return db.prepare("SELECT * FROM video_jobs WHERE run_id = ?").get(runId) as JobRow | undefined;
}

export function clipRows(runId: string): ClipRow[] {
  return db.prepare("SELECT * FROM video_clips WHERE run_id = ? ORDER BY idx").all(runId) as unknown as ClipRow[];
}

export function jobRows(opts: { ventureId?: string | null; format?: string | null; limit?: number }): JobRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.ventureId) {
    where.push("venture_id = ?");
    args.push(opts.ventureId);
  }
  if (opts.format) {
    where.push("format = ?");
    args.push(opts.format);
  }
  args.push(Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50))));
  return db
    .prepare(`SELECT * FROM video_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT ?`)
    .all(...args) as unknown as JobRow[];
}

/** One statement rather than a row per job — a list of fifty videos should
 *  not be fifty selects to find out which have clips. */
export function clipCounts(): Map<string, number> {
  const rows = db
    .prepare("SELECT run_id, COUNT(*) AS n FROM video_clips GROUP BY run_id")
    .all() as unknown as { run_id: string; n: number }[];
  return new Map(rows.map((r) => [r.run_id, r.n]));
}

export function saveJob(job: {
  runId: string;
  ventureId: string | null;
  format: string;
  aspect: string;
  width: number | null;
  height: number | null;
  script: Script | { note: string } | Record<string, unknown>;
  assets: Asset[];
  durationS: number | null;
  bytes: number | null;
  path: string | null;
  captions: string | null;
  narration: string | null;
  transcript: string | null;
  error: string | null;
}) {
  db.prepare(
    `INSERT INTO video_jobs
       (run_id, venture_id, format, ts, aspect, width, height, script, assets,
        duration_s, bytes, path, captions, narration, transcript, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET
       venture_id = excluded.venture_id, format = excluded.format, aspect = excluded.aspect,
       width = excluded.width, height = excluded.height, script = excluded.script,
       assets = excluded.assets, duration_s = excluded.duration_s, bytes = excluded.bytes,
       path = excluded.path, captions = excluded.captions, narration = excluded.narration,
       transcript = excluded.transcript, error = excluded.error`,
  ).run(
    job.runId,
    job.ventureId,
    job.format,
    now(),
    job.aspect,
    job.width,
    job.height,
    JSON.stringify(job.script),
    JSON.stringify(job.assets),
    job.durationS,
    job.bytes,
    job.path,
    job.captions,
    job.narration,
    job.transcript,
    job.error,
  );
}

export function saveClip(clip: {
  runId: string;
  idx: number;
  title: string;
  reason: string | null;
  chosenBy: string;
  startS: number;
  endS: number;
  durationS: number | null;
  path: string | null;
  bytes: number | null;
  captions: string | null;
}) {
  db.prepare(
    `INSERT INTO video_clips (run_id, idx, title, reason, chosen_by, start_s, end_s, duration_s, path, bytes, captions)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id, idx) DO UPDATE SET
       title = excluded.title, reason = excluded.reason, chosen_by = excluded.chosen_by,
       start_s = excluded.start_s, end_s = excluded.end_s, duration_s = excluded.duration_s,
       path = excluded.path, bytes = excluded.bytes, captions = excluded.captions`,
  ).run(
    clip.runId,
    clip.idx,
    clip.title,
    clip.reason,
    clip.chosenBy,
    clip.startS,
    clip.endS,
    clip.durationS,
    clip.path,
    clip.bytes,
    clip.captions,
  );
}

/* ---------------------------------------------------------------- shaping */

export function shapeClip(r: ClipRow) {
  return {
    runId: r.run_id,
    index: r.idx,
    title: r.title,
    /* The model's sentence for choosing this window, quoted. Not a score and
       not a prediction — see the migration. */
    reason: r.reason,
    /* `transcript` means the window came out of words that were said.
       `spacing` means there was no transcript and the source was cut at even
       intervals, which is not highlight selection. */
    chosenBy: r.chosen_by,
    startS: r.start_s,
    endS: r.end_s,
    durationS: r.duration_s,
    bytes: r.bytes,
    captions: r.captions,
    file: r.path ? `/api/video/${r.run_id}/clips/${r.idx}/file` : null,
    onDisk: r.path ? existsSync(r.path) : false,
  };
}

/**
 * One job on the wire.
 *
 * NO CLIPS, NO FRAMING LOOKUP. How a clip was framed has to travel with it — a
 * page that drew a tracked crop and a fixed centre crop identically would be
 * claiming this box followed a subject it never looked for — but this was
 * reading `videoplus_clip_framing` unconditionally, so `GET /api/video?limit=50`
 * issued fifty extra selects to build fifty maps, and forty-odd of them were
 * empty: only a shorts job has clips at all, and the LIST passes `clips: []`
 * because it draws none of them. Now the list costs nothing and the detail
 * route costs one read. `framingFor` lets a caller that already has the rows
 * hand them in rather than have them fetched again.
 */
export function shapeJob(r: JobRow, clips?: ClipRow[], framingFor?: FramingRow[]) {
  const v = r.venture_id ? ventureRowById(r.venture_id) : undefined;
  const rows = clips ?? clipRows(r.run_id);
  const framing = new Map(
    (framingFor ?? (rows.length ? framingRows(r.run_id) : [])).map((f) => [f.idx, shapeFraming(f)]),
  );
  return {
    runId: r.run_id,
    ventureId: r.venture_id,
    ventureName: v?.name ?? null,
    format: r.format,
    ts: r.ts,
    aspect: r.aspect,
    width: r.width,
    height: r.height,
    script: parse<Record<string, unknown>>(r.script, {}),
    /* THE ATTRIBUTION, and it is on every shape of this row rather than
       behind a second request. A page that showed a video without the credits
       beside it would be a page that makes it easy to publish something
       uncredited. */
    assets: parse<Asset[]>(r.assets, []),
    durationS: r.duration_s,
    bytes: r.bytes,
    /* Which machine drew the words, or the sentence saying none did. */
    captions: r.captions,
    /* `tts` when a voice endpoint spoke the script, `none` and a reason when
       it did not. Never silently absent. */
    narration: r.narration,
    transcript: r.transcript,
    error: r.error,
    file: r.path ? `/api/video/${r.run_id}/file` : null,
    onDisk: r.path ? existsSync(r.path) : false,
    clips: rows.map((c) => ({ ...shapeClip(c), framing: framing.get(c.idx) ?? null })),
  };
}

/** Delete the rows a run owns. The FILES are the run directory's and go with
 *  it — see routes.ts, which removes the directory when a run is deleted. */
export function forgetJob(runId: string) {
  db.prepare("DELETE FROM video_clips WHERE run_id = ?").run(runId);
  db.prepare("DELETE FROM video_jobs WHERE run_id = ?").run(runId);
}
