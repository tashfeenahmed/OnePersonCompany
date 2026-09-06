/**
 * FOOTAGE — asking Pexels for b-roll, and keeping the receipt.
 *
 * WHY THIS IS NOT IN providers/stock.ts. That file MEASURES Pexels: it spends
 * one request a quarter of a day to read the quota headers and record how much
 * of the monthly allowance is left. This CONSUMES it: it searches for a term,
 * picks a rendition, and downloads a file. Two different questions of one API,
 * and folding them together would put a collector that must be cheap into the
 * same module as a loop that deliberately is not.
 *
 * THE CREDENTIAL IS THE STOCK PLUGIN'S AND THIS AREA DOES NOT DECLARE ONE.
 * `pexels` is already a plugin with accounts, a verify and a quota collector;
 * a second `video-pexels` credential would be the same key pasted twice and
 * two places for it to be revoked. It is read through `accounts.credentialed`
 * with this area's own reader name, so the vault's audit trail says which
 * feature opened it.
 *
 * ATTRIBUTION IS WRITTEN AT THE MOMENT OF THE FETCH, AND THAT IS THE POINT OF
 * THE MANIFEST. The Pexels licence is generous and it still asks for the
 * photographer to be credited. The only moment the photographer's name is
 * known is when the search result is in hand — chase it later and you have an
 * mp4 and no idea whose it was. So every download returns the id, the page,
 * the author, the author's page, the licence and the term that found it, and
 * that array goes on the row and onto the run page. A video whose sources
 * cannot be named is a video that cannot be published.
 *
 * THE RENDITION IS THE SMALLEST ONE THAT IS BIG ENOUGH, which is
 * materials.py's rule and it is the right one for two reasons. Upscaling is
 * the one direction that visibly costs quality, so anything under the target
 * frame is refused outright. Above it, a 4K rendition is four times the
 * download and four times the decode to produce the same 1080-wide output, so
 * the smallest by area wins. An exact match short-circuits both.
 *
 * A BROWSER USER-AGENT ON THE FILE FETCH, and it is not cosmetic: the search
 * API answers a plain client, and the CDN in front of the mp4s does not.
 */
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import * as accounts from "../../accounts.ts";
import { bytesOf } from "./tools.ts";

const SEARCH_MS = 30_000;
const DOWNLOAD_MS = 240_000;
/** A single stock clip over this is not b-roll, it is somebody's short film,
 *  and downloading it to use four seconds would be rude and slow. */
const MAX_BYTES = 120 * 1024 * 1024;

/** The API family the reels use. The photo endpoint has its own window and
 *  spending it here would spend an allowance nothing else touches. */
const API = "https://api.pexels.com/videos/search";

/** The CDN refuses an unrecognised client. See the header. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type Asset = {
  /** Which library. One value today; the field exists because the licence
   *  sentence differs per library and a manifest that only said "stock" would
   *  not be a credit. */
  library: "pexels";
  id: number;
  /** The page a person can open to see it in context and find the author. */
  page: string;
  author: string;
  authorUrl: string;
  licence: string;
  /** The direct file this box actually fetched. Kept because a manifest that
   *  named the page but not the rendition could not be checked. */
  file: string;
  width: number;
  height: number;
  /** Seconds, as Pexels reports the whole clip — not the length used. */
  duration: number;
  /** The search term that found it, so a manifest also explains the edit. */
  term: string;
  /** Where it landed on this disk. */
  path: string;
  bytes: number;
};

export class FootageError extends Error {}

/** The key of the first connected Pexels account, or a sentence saying there
 *  is none. Several accounts is not a case worth splitting footage across:
 *  they are one library and one quota per key, and picking the first is the
 *  same choice the studio makes with Replicate tokens. */
export function pexelsKey(reader = "video_footage"): { key: string } | { error: string } {
  const { ready, broken } = accounts.credentialed("pexels", ["key"], reader);
  const key = ready[0]?.values.key?.trim();
  if (key) return { key };
  if (broken.length) return { error: "A Pexels account is connected but no key is stored against it." };
  return {
    error:
      "Pexels is not connected, and a faceless video is made of stock footage. " +
      "Add a key under Integrations → Pexels — it is free, and the quota is on the plugin's own page.",
  };
}

type PexelsFile = { link?: unknown; width?: unknown; height?: unknown; file_type?: unknown };
type PexelsVideo = {
  id?: unknown;
  url?: unknown;
  duration?: unknown;
  user?: { name?: unknown; url?: unknown };
  video_files?: unknown;
};

const orientationFor = (w: number, h: number) => (h > w ? "portrait" : w > h ? "landscape" : "square");

/**
 * One search.
 *
 * `orientation` is asked of the API rather than filtered here, because Pexels
 * knows the answer and sending twenty landscape results to be thrown away is
 * twenty results of somebody else's bandwidth. It is checked again on the
 * rendition anyway — the API's orientation is about the VIDEO and a video can
 * carry a rendition in a different shape.
 */
export async function search(
  key: string,
  term: string,
  want: { width: number; height: number },
  signal?: AbortSignal,
): Promise<PexelsVideo[]> {
  const orientation = orientationFor(want.width, want.height);
  const url = `${API}?query=${encodeURIComponent(term)}&orientation=${orientation}&per_page=20`;
  const res = await fetch(url, {
    headers: { Authorization: key, Accept: "application/json", "User-Agent": "onepersoncompany-video/1.0" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(SEARCH_MS)]) : AbortSignal.timeout(SEARCH_MS),
  });
  if (res.status === 401) throw new FootageError("Pexels rejected the stored key.");
  if (res.status === 429)
    throw new FootageError("Pexels is rate-limiting this key — the monthly quota may be spent. The Pexels plugin page has the counter.");
  if (!res.ok) throw new FootageError(`Pexels answered HTTP ${res.status} for “${term}”.`);
  if (!(res.headers.get("content-type") ?? "").includes("json"))
    throw new FootageError("Pexels answered with a page rather than JSON — usually a bot challenge in front of the API.");
  const body = (await res.json()) as { videos?: unknown };
  return Array.isArray(body.videos) ? (body.videos as PexelsVideo[]) : [];
}

type Rendition = { link: string; width: number; height: number };

/** The smallest rendition that is at least the target frame and is the right
 *  shape. Null when the clip has nothing big enough — see the header on why
 *  upscaling is refused rather than accepted. */
function bestRendition(v: PexelsVideo, want: { width: number; height: number }): Rendition | null {
  const files = Array.isArray(v.video_files) ? (v.video_files as PexelsFile[]) : [];
  const shape = orientationFor(want.width, want.height);
  const usable: Rendition[] = [];
  for (const f of files) {
    const link = typeof f.link === "string" ? f.link : null;
    const width = typeof f.width === "number" ? f.width : 0;
    const height = typeof f.height === "number" ? f.height : 0;
    if (!link || !width || !height) continue;
    if (typeof f.file_type === "string" && !f.file_type.includes("mp4")) continue;
    if (orientationFor(width, height) !== shape) continue;
    if (width < want.width || height < want.height) continue;
    usable.push({ link, width, height });
  }
  if (!usable.length) return null;
  const exact = usable.find((r) => r.width === want.width && r.height === want.height);
  if (exact) return exact;
  return usable.sort((a, b) => a.width * a.height - b.width * b.height)[0]!;
}

/**
 * Find a clip for one beat and put it on the disk.
 *
 * THE TERMS ARE TRIED IN ORDER AND THE FIRST THAT WORKS WINS. The model gives
 * two to four search terms per beat precisely because a term can return
 * nothing usable — "quarterly churn cohort" is a phrase no stock library has
 * footage of — and a pipeline that gave up on the first miss would fail a
 * whole video over one bad noun.
 *
 * `avoid` IS THE IDS ALREADY USED IN THIS VIDEO. The same waterfall three
 * beats running is the tell of an automated reel, and it is free to avoid: the
 * search returned twenty results and only the first was taken.
 */
export async function fetchClip(opts: {
  key: string;
  terms: string[];
  want: { width: number; height: number };
  minSeconds: number;
  dir: string;
  name: string;
  avoid: Set<number>;
  signal?: AbortSignal;
}): Promise<{ asset: Asset } | { error: string }> {
  const tried: string[] = [];
  for (const term of opts.terms) {
    if (!term.trim()) continue;
    tried.push(term);
    let videos: PexelsVideo[];
    try {
      videos = await search(opts.key, term.trim(), opts.want, opts.signal);
    } catch (err) {
      /* A key that has been rejected or a quota that is spent is not a fact
         about this term, so it stops the whole search rather than moving on
         to the next word and failing again nineteen more times. */
      if (err instanceof FootageError) return { error: err.message };
      return { error: `Pexels could not be reached for “${term}” (${err instanceof Error ? err.name : "error"}).` };
    }

    for (const v of videos) {
      const id = typeof v.id === "number" ? v.id : null;
      if (id === null || opts.avoid.has(id)) continue;
      const duration = typeof v.duration === "number" ? v.duration : 0;
      if (duration < opts.minSeconds) continue;
      const r = bestRendition(v, opts.want);
      if (!r) continue;

      const path = resolve(opts.dir, `${opts.name}.mp4`);
      const bytes = await download(r.link, path, opts.signal);
      if ("error" in bytes) continue;

      return {
        asset: {
          library: "pexels",
          id,
          page: typeof v.url === "string" ? v.url : `https://www.pexels.com/video/${id}/`,
          author: typeof v.user?.name === "string" ? v.user.name : "unknown",
          authorUrl: typeof v.user?.url === "string" ? v.user.url : "",
          /* Named rather than described. The Pexels licence permits
             commercial use and asks for a credit; that sentence is what the
             owner needs beside the file. */
          licence: "Pexels licence — free to use, credit the photographer",
          file: r.link,
          width: r.width,
          height: r.height,
          duration,
          term: term.trim(),
          path,
          bytes: bytes.bytes,
        },
      };
    }
  }
  return {
    error: `No portrait clip of at least ${opts.want.width}x${opts.want.height} and ${opts.minSeconds}s was found for ${tried.map((t) => `“${t}”`).join(", ") || "any term"}.`,
  };
}

/** Stream a file to disk. Streamed rather than buffered because a 1080x1920
 *  rendition is routinely forty megabytes and holding twenty of those in the
 *  heap to write them out again is the kind of thing that kills a laptop. */
async function download(url: string, path: string, signal?: AbortSignal): Promise<{ bytes: number } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "video/mp4,*/*" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)]) : AbortSignal.timeout(DOWNLOAD_MS),
    });
    if (!res.ok || !res.body) return { error: `HTTP ${res.status}` };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) return { error: `${Math.round(declared / 1024 / 1024)} MB is over the cap` };
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(path));
    const bytes = bytesOf(path);
    if (!bytes) return { error: "the file arrived empty" };
    return { bytes };
  } catch (err) {
    return { error: err instanceof Error ? err.name : "download failed" };
  }
}
