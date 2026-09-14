import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { findFfmpeg, findFfprobe, probeDuration, run } from "../video/tools.ts";
import { gameplayLabel, isGameplayName, type GameplayBackground } from "../../../../shared/gameplay.ts";

type Preview = { id: string; file: string };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const scope = (agentUrl: string) => digest(agentUrl.trim().replace(/\/+$/, ""));
export const gameplayPreviewDirectory = (agentUrl: string) => resolve(DATA_DIR, "video", "gameplay-previews", scope(agentUrl));
const directory = gameplayPreviewDirectory;

/** A private, agent-scoped catalogue. No source paths, service keys or full
 * videos are sent to the browser or bundled into the public repository. */
export function readGameplayPreviews(agentUrl: string): Preview[] {
  try {
    const path = resolve(directory(agentUrl), "catalogue.json");
    if (statSync(path).size > 64_000) return [];
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(data) || data.length > 100) return [];
    return data.filter((item): item is Preview => !!item && typeof item === "object"
      && isGameplayName(item.id) && typeof item.file === "string" && /^[a-f0-9]{24}\.jpg$/.test(item.file)
      && existsSync(resolve(directory(agentUrl), item.file)));
  } catch { return []; }
}

export function gameplayBackgrounds(agentUrl: string, liveNames?: string[]): GameplayBackground[] {
  const previews = readGameplayPreviews(agentUrl);
  // A reachable worker's list is authoritative, including an empty list.
  // When it sleeps, the saved catalogue still lets the owner choose footage.
  const names = [...new Set((liveNames ?? previews.map(item => item.id)).filter(isGameplayName))].slice(0, 100);
  return names.map(id => {
    const preview = previews.find(item => item.id === id);
    return { id, label: gameplayLabel(id), thumbnailUrl: preview
      ? `/api/stewie/backgrounds/${encodeURIComponent(id)}/thumbnail?v=${scope(agentUrl)}-${preview.file}` : null };
  });
}

export function gameplayThumbnail(agentUrl: string, id: string): Buffer | null {
  if (!isGameplayName(id)) return null;
  const preview = readGameplayPreviews(agentUrl).find(item => item.id === id);
  if (!preview) return null;
  try {
    const path = resolve(directory(agentUrl), preview.file);
    if (statSync(path).size > 1_000_000) return null;
    return readFileSync(path);
  } catch { return null; }
}

/** Run only when the owner imports/refreshes their footage catalogue. Opening
 * Studio never launches FFmpeg, downloads a video or wakes a render worker. */
export async function importGameplayPreviews(agentUrl: string, sourceDirectory: string): Promise<string[]> {
  const source = resolve(sourceDirectory);
  const names = readdirSync(source).filter(name => name.endsWith(".mp4") && isGameplayName(name.slice(0, -4))).sort();
  if (!names.length) throw new Error("No named MP4 gameplay clips were found in that folder.");
  if (names.length > 100) throw new Error("A gameplay catalogue can contain up to 100 clips.");
  const ffmpeg = findFfmpeg();
  if (!ffmpeg.path) throw new Error(ffmpeg.error ?? "FFmpeg is required to make gameplay thumbnails.");
  const ffprobe = findFfprobe();
  const out = directory(agentUrl);
  mkdirSync(out, { recursive: true });
  const previews: Preview[] = [];
  for (const name of names) {
    const temp = resolve(out, `${randomUUID()}.jpg`);
    try {
      let complete = false;
      // Mid-clip avoids the menus and opening titles at the start of footage.
      const duration = ffprobe.path ? await probeDuration(ffprobe.path, resolve(source, name)) : null;
      for (const seek of [String(duration ? duration / 2 : 3), "0"]) {
        const result = await run(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-y", "-ss", seek,
          "-i", resolve(source, name), "-frames:v", "1", "-vf",
          "scale=272:484:force_original_aspect_ratio=decrease,pad=272:484:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
          "-an", "-c:v", "mjpeg", "-q:v", "4", "-threads", "1", temp], { timeoutMs: 20_000 });
        if (result.ok && existsSync(temp) && statSync(temp).size > 0) { complete = true; break; }
      }
      if (!complete) throw new Error(`Could not read a preview frame from ${name}. The previous catalogue is unchanged.`);
      const file = `${digest(readFileSync(temp))}.jpg`;
      renameSync(temp, resolve(out, file));
      previews.push({ id: name.slice(0, -4), file });
    } finally { rmSync(temp, { force: true }); }
  }
  const manifest = resolve(out, `${randomUUID()}.json`);
  writeFileSync(manifest, JSON.stringify(previews));
  renameSync(manifest, resolve(out, "catalogue.json"));
  // Retain only the current tiny previews; old browser URLs can refetch the
  // latest frame, while failed imports leave the previous catalogue intact.
  const keep = new Set(previews.map(item => item.file));
  for (const file of readdirSync(out)) if (/^[a-f0-9]{24}\.jpg$/.test(file) && !keep.has(file)) rmSync(resolve(out, file), { force: true });
  return previews.map(item => item.id);
}
