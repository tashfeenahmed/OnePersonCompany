import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { findFfmpeg, run } from "./tools.ts";

type Source = { path: string; key: string };
const directory = join(DATA_DIR, "video", "thumbnails");
const pending = new Map<string, Promise<Buffer | null>>();
let queue: Promise<unknown> = Promise.resolve();

/** Choose an existing output, including the first surviving Shorts clip. */
export function thumbnailSource(paths: (string | null)[]): Source | null {
  for (const path of paths) {
    if (!path) continue;
    try {
      const stat = statSync(path);
      if (!stat.isFile() || !stat.size) continue;
      const key = createHash("sha256").update(`v1:${path}:${stat.size}:${stat.mtimeMs}`).digest("hex");
      return { path, key };
    } catch { /* Missing files keep the format icon. */ }
  }
  return null;
}

export function thumbnailUrl(runId: string, source: Source | null): string | null {
  return source ? `/api/video/${encodeURIComponent(runId)}/thumbnail?v=${source.key}` : null;
}

function readThumbnail(path: string): Buffer | null {
  try {
    const size = statSync(path).size;
    return size > 0 && size < 256_000 ? readFileSync(path) : null;
  } catch { return null; }
}

export function deleteThumbnails(runId: string, paths: (string | null)[]) {
  // Include older versions and previews whose original output is now gone.
  let files: string[] = [];
  try { files = readdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const file of files) {
    if (file.startsWith(`${runId}.`)) rmSync(join(directory, file), { force: true });
  }
  // Remove previews written before cache names included the owning run.
  for (const path of paths) {
    const source = thumbnailSource([path]);
    if (source) rmSync(join(directory, `${source.key}.jpg`), { force: true });
  }
}

/** Lazy, single-frame previews. Only one FFmpeg process runs at a time, and
 * repeated requests share the work. The browser never downloads the video. */
export function videoThumbnail(source: Source, runId: string): Promise<Buffer | null> {
  if (!/^r-[a-zA-Z0-9_-]+$/.test(runId)) return Promise.resolve(null);
  const cacheKey = `${runId}.${source.key}`;
  const target = join(directory, `${cacheKey}.jpg`);
  const cached = readThumbnail(target);
  if (cached) return Promise.resolve(cached);
  const inFlight = pending.get(cacheKey);
  if (inFlight) return inFlight;
  const task = queue.then(async () => {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg.path || thumbnailSource([source.path])?.key !== source.key) return null;
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `${randomUUID()}.jpg`);
    try {
      // A second into the video avoids opening fades; zero also works for
      // still UGC images and clips shorter than a second.
      for (const seek of ["1", "0"]) {
        const result = await run(ffmpeg.path, [
          "-hide_banner", "-loglevel", "error", "-y", "-threads", "1",
          "-protocol_whitelist", "file,pipe", "-ss", seek, "-i", source.path,
          "-frames:v", "1", "-vf", "scale=160:160:force_original_aspect_ratio=decrease,setsar=1",
          "-an", "-c:v", "mjpeg", "-q:v", "5", "-threads", "1", temporary,
        ], { timeoutMs: 12_000 });
        const image = result.ok ? readThumbnail(temporary) : null;
        if (image && thumbnailSource([source.path])?.key === source.key) {
          renameSync(temporary, target);
          return image;
        }
      }
      return null;
    } finally { rmSync(temporary, { force: true }); }
  }).catch(() => null).finally(() => { pending.delete(cacheKey); });
  pending.set(cacheKey, task);
  queue = task;
  return task;
}
