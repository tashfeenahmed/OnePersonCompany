/**
 * THE TWO TABLES THIS AREA OWNS, READ AND WRITTEN IN ONE PLACE.
 *
 * Same split video/store.ts keeps: snake_case in SQLite, shaping functions for
 * the wire, and null meaning "not measured" rather than zero.
 *
 * A SPEC ROW CARRIES ITS SCENE COUNT AND LENGTH AS COLUMNS EVEN THOUGH BOTH
 * ARE IN THE JSON. A list of thirty specs would otherwise be thirty JSON
 * parses to draw a table of names and durations, and the two columns are
 * written by the same function that validates the JSON — so they cannot drift
 * from it without somebody writing the column by hand.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { db, now, ventureRowById } from "../../db.ts";
import { readSceneSpec, specSeconds, type SceneSpec, type SpecLimits } from "./scenespec.ts";

/**
 * WHERE A SPEC'S PREVIEW FRAMES LIVE, and it is here rather than in motion.ts
 * because the frames belong to the SPEC and not to the render that drew them.
 * A run's files go when the run does; these have to go when the spec does, and
 * `forgetSpec` is the only place that knows the spec is going.
 *
 * ONE DIRECTORY PER PREVIEW CALL, named by a token, and the URL carries the
 * token. Keying only on the spec id was wrong in a way that is invisible until
 * two people press Preview: the render begins by clearing the directory, so a
 * second call deleted the first call's frames while the first response was
 * still being read, and its image URLs 404ed. A token per call cannot collide;
 * the old ones are swept below rather than left to accumulate.
 */
export const PREVIEW_DIR = resolve(DATA_DIR, "video", "_motion-preview");
export const previewRoot = (specId: string) => resolve(PREVIEW_DIR, specId);
export const previewDir = (specId: string, token: string) => resolve(previewRoot(specId), token);

/** A token for one preview call. Not a uuid: it is a directory name that also
 *  sorts by age, which is what the sweep below needs. */
export const previewToken = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Keep the newest few and drop the rest. Three, because the only readers are
 *  the response that just came back and a page somebody left open. */
export function sweepPreviews(specId: string, keep = 3) {
  try {
    const root = previewRoot(specId);
    const dirs = readdirSync(root)
      .map((name) => ({ name, at: statSync(resolve(root, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(keep);
    for (const d of dirs) rmSync(resolve(root, d.name), { recursive: true, force: true });
  } catch {
    /* Nothing previewed yet, or a directory already gone. Neither is a fault. */
  }
}

export function makePreviewDir(specId: string, token: string): string {
  const dir = previewDir(specId, token);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The frame for one scene of one preview call, or null. Takes an INDEX and a
 *  TOKEN rather than a path, so nothing a caller sends can name a file: both
 *  are pattern-checked by the route before they reach here. */
export function previewFrame(specId: string, token: string, index: number): string | null {
  if (!/^[a-z0-9-]{1,40}$/.test(token)) return null;
  const name = `p-${String(index - 1).padStart(3, "0")}.png`;
  const path = resolve(previewDir(specId, token), name);
  return existsSync(path) ? path : null;
}

export type SpecRow = {
  id: string;
  venture_id: string | null;
  name: string;
  spec: string;
  aspect: string;
  scenes: number;
  seconds: number | null;
  source: string;
  created_at: string;
  updated_at: string;
};

export type FramingRow = {
  run_id: string;
  idx: number;
  mode: string;
  detector: string;
  samples: number | null;
  drift_px: number | null;
  note: string | null;
};

/* -------------------------------------------------------------- the specs */

export function specRow(id: string): SpecRow | undefined {
  return db.prepare("SELECT * FROM motion_specs WHERE id = ?").get(id) as SpecRow | undefined;
}

export function specRows(opts: { ventureId?: string | null; limit?: number }): SpecRow[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  if (opts.ventureId)
    return db
      .prepare("SELECT * FROM motion_specs WHERE venture_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(opts.ventureId, limit) as unknown as SpecRow[];
  return db.prepare("SELECT * FROM motion_specs ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as SpecRow[];
}

/**
 * Save a spec, validating it on the way in.
 *
 * VALIDATION HAPPENS HERE AND NOWHERE ELSE, so there is exactly one door into
 * this table and nothing can put a scene kind in it that the renderer has no
 * template for. The caller gets the problems back and shows them; the row that
 * lands is the CLAMPED one, because a row that stored what was typed and
 * clamped at render time would render something different from what the editor
 * shows.
 */
export function saveSpec(opts: {
  id: string;
  ventureId: string | null;
  name: string;
  raw: unknown;
  source: string;
  limits: SpecLimits;
}): { row: SpecRow | null; problems: string[] } {
  const read = readSceneSpec(opts.raw, opts.limits);
  if (!read.spec) return { row: null, problems: read.problems };
  const at = now();
  const seconds = specSeconds(read.spec);
  db.prepare(
    `INSERT INTO motion_specs (id, venture_id, name, spec, aspect, scenes, seconds, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       venture_id = excluded.venture_id, name = excluded.name, spec = excluded.spec,
       aspect = excluded.aspect, scenes = excluded.scenes, seconds = excluded.seconds,
       source = excluded.source, updated_at = excluded.updated_at`,
  ).run(
    opts.id,
    opts.ventureId,
    opts.name.trim().slice(0, 120) || read.spec.title,
    JSON.stringify(read.spec),
    read.spec.aspect,
    read.spec.scenes.length,
    seconds,
    opts.source,
    at,
    at,
  );
  return { row: specRow(opts.id) ?? null, problems: read.problems };
}

/** The row AND the pictures. A previewed-then-deleted spec used to leave its
 *  PNGs on the disk for ever, because a preview belongs to no run and nothing
 *  else was ever going to come looking for them. */
export function forgetSpec(id: string) {
  db.prepare("DELETE FROM motion_specs WHERE id = ?").run(id);
  try {
    rmSync(previewRoot(id), { recursive: true, force: true });
  } catch {
    /* A directory that will not delete costs a few hundred kilobytes, not the
       delete the owner asked for. */
  }
}

/** The stored JSON, back as a spec. A row hand-edited into something invalid
 *  costs its spec and not the page — the caller gets null and says so. */
export function readSpecRow(row: SpecRow, limits: SpecLimits): SceneSpec | null {
  try {
    return readSceneSpec(JSON.parse(row.spec) as unknown, limits).spec;
  } catch {
    return null;
  }
}

export function shapeSpec(row: SpecRow, opts: { full?: boolean } = {}) {
  const v = row.venture_id ? ventureRowById(row.venture_id) : undefined;
  let spec: unknown = undefined;
  if (opts.full) {
    try {
      spec = JSON.parse(row.spec) as unknown;
    } catch {
      spec = null;
    }
  }
  return {
    id: row.id,
    ventureId: row.venture_id,
    ventureName: v?.name ?? null,
    name: row.name,
    aspect: row.aspect,
    scenes: row.scenes,
    /* The length the scene list adds up to. It is what the render WILL be, not
       a measurement of a file — a finished render's duration is read off the
       file with ffprobe and lives on video_jobs. */
    seconds: row.seconds,
    /* `owner` — typed or edited on the page. `model` — written by the model
       from a brief. Kept apart because a spec a model wrote is a draft and a
       spec the owner edited is a decision. */
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(opts.full ? { spec } : {}),
  };
}

/* ------------------------------------------------------------- the framing */

export function saveFraming(f: FramingRow) {
  db.prepare(
    `INSERT INTO videoplus_clip_framing (run_id, idx, mode, detector, samples, drift_px, note)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(run_id, idx) DO UPDATE SET
       mode = excluded.mode, detector = excluded.detector, samples = excluded.samples,
       drift_px = excluded.drift_px, note = excluded.note`,
  ).run(f.run_id, f.idx, f.mode, f.detector, f.samples, f.drift_px, f.note);
}

export function framingRows(runId: string): FramingRow[] {
  return db
    .prepare("SELECT * FROM videoplus_clip_framing WHERE run_id = ? ORDER BY idx")
    .all(runId) as unknown as FramingRow[];
}

export function forgetFraming(runId: string) {
  db.prepare("DELETE FROM videoplus_clip_framing WHERE run_id = ?").run(runId);
}

export function shapeFraming(r: FramingRow) {
  return {
    index: r.idx,
    /* `tracked` — the crop window moved with measured motion. `fixed` — the
       centre of the frame, always, which is the fallback and must be drawn as
       one. */
    mode: r.mode,
    /* What measured the box. NEVER a face model — there is none on this box. */
    detector: r.detector,
    samples: r.samples,
    /* How far the crop travelled, in source pixels. Zero on a fixed crop. */
    driftPx: r.drift_px,
    note: r.note,
  };
}

/** True when the file a row points at is still there. Same reading as
 *  video/store.ts's `onDisk`: a row outlives its file. */
export const onDisk = (path: string | null) => (path ? existsSync(path) : false);
