/**
 * THE ENCODER — every ffmpeg invocation this area makes, in one file.
 *
 * ONE SEGMENT PER SHOT, THEN A CONCAT. The alternative — one enormous
 * filtergraph with every clip, every caption and every transition in it — was
 * not seriously considered: a graph like that fails as a single opaque error
 * three minutes in, and there is no way to say WHICH shot broke it. Encoding
 * each shot to its own file means a failure names the beat, a partial run
 * leaves inspectable intermediates on the disk, and the memory cost is one
 * decoded frame rather than twenty.
 *
 * THE CONCAT RE-ENCODES AND DOES NOT STREAM-COPY. Segments this server wrote
 * itself have identical parameters, so `-c copy` looks like it should work,
 * and it produces a file with a timestamp discontinuity at every join that
 * plays as a stutter in some players and not in others. Re-encoding a
 * thirty-second 1080x1920 video costs a few seconds of a laptop's CPU and it
 * is the same file everywhere.
 *
 * THREE FLAGS ON THE FINAL OUTPUT ARE NOT NEGOTIABLE, because the file has to
 * play in a `<video>` element on the run page:
 *
 *   -pix_fmt yuv420p    A 10-bit or 4:4:4 H.264 file is a legal mp4 that
 *                       Safari will not decode. Everything here is 8-bit 4:2:0.
 *   -movflags +faststart Without it the moov atom is written at the END of the
 *                       file and a browser cannot start playing until the whole
 *                       thing has downloaded. On a forty-megabyte reel that is
 *                       the difference between a player and a progress bar.
 *   -profile:v high -level 4.0
 *                       What older phones will decode. Costs nothing here.
 *
 * ALL SEGMENTS HAVE AUDIO OR NONE DO, and that is a hard rule rather than a
 * preference: the concat demuxer requires every input to have the same stream
 * layout, and a video where beat three happened to have narration and beat
 * four did not would fail at the join with an error about stream mapping. So
 * narration is all-or-nothing for a whole video, and the end card gets a
 * silent track when the rest of the video has sound.
 *
 * NOTHING HERE IS BUILT BY STRING CONCATENATION INTO A SHELL. Every call is an
 * argument array through `execFile`, which matters because the text going into
 * a caption was written by a model — see captions.ts on the escaping the
 * drawtext path still needs INSIDE the filtergraph, which is a different
 * parser and a separate problem.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, tail, type Ran } from "./tools.ts";

/** The three shapes a video can be, and what they are in pixels. 9:16 is the
 *  default everywhere because it is the only one every short-form platform
 *  takes without re-cropping. */
export const ASPECTS: Record<string, { width: number; height: number; about: string }> = {
  "9:16": { width: 1080, height: 1920, about: "9:16 — a reel, a short, a TikTok. The default." },
  "1:1": { width: 1080, height: 1080, about: "1:1 — a square feed post." },
  "16:9": { width: 1920, height: 1080, about: "16:9 — a landscape video for YouTube or a site." },
};

export const FPS = 30;
/** Encoder settings. `veryfast` rather than `medium`: this runs on the owner's
 *  laptop while they are using it, and the size difference on thirty seconds
 *  of stock footage is a couple of megabytes. */
const V_ARGS = [
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "21",
  "-profile:v", "high",
  "-level", "4.0",
  "-pix_fmt", "yuv420p",
  "-r", String(FPS),
];
const A_ARGS = ["-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2"];

/** How the source is made to fit the frame. */
export type Fit = "cover" | "letterbox";

/**
 * The scale-and-fit graph, from one labelled input to one labelled output.
 *
 * A WHOLE GRAPH FRAGMENT AND NOT A FILTER LIST, because the letterbox needs a
 * `split` and two branches and there is no way to express that as a comma
 * chain. Both modes therefore return the same shape — `[in]…[out]` — and the
 * caller never has to know which one it asked for.
 *
 * `cover` fills the frame and loses the edges: right for stock footage that
 * was shot portrait anyway, and right for a talking head in the middle of a
 * landscape frame. `letterbox` keeps the whole picture and fills the space
 * behind it with a blurred, enlarged copy of the same frame — which is what
 * every platform does, because black bars on a phone read as a broken video.
 * It is the FACE-SAFE option: a two-person interview shot wide loses one of
 * them to a centre crop and loses nothing here.
 *
 * `blur` NAMES A FILTER THAT WAS PROBED FOR. gblur is the good one and it is
 * not in every build; avgblur and boxblur are in more of them and look almost
 * the same at this radius behind a video. Null means none of the three was
 * found, and then the letterbox pads with the venture's colour instead — which
 * is still not black bars, and is honest about what it is.
 */
export function fitGraph(opts: {
  fit: Fit;
  width: number;
  height: number;
  blur: string | null;
  pad: string;
  inLabel: string;
  outLabel: string;
}): string {
  const { width: w, height: h, inLabel: i, outLabel: o } = opts;
  const cover = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${FPS}`;
  if (opts.fit === "cover") return `[${i}]${cover}[${o}]`;
  if (!opts.blur)
    return (
      `[${i}]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:${opts.pad},setsar=1,fps=${FPS}[${o}]`
    );
  return [
    `[${i}]split=2[lbA][lbB]`,
    `[lbA]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},${opts.blur}[lbBG]`,
    `[lbB]scale=${w}:${h}:force_original_aspect_ratio=decrease[lbFG]`,
    `[lbBG][lbFG]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS}[${o}]`,
  ].join(";");
}

/** The best blur this build has, as a ready-made filter call, or null when it
 *  has none of the three. Probed rather than assumed — see tools.ts. */
export function blurFilter(filters: Set<string>): string | null {
  if (filters.has("gblur")) return "gblur=sigma=28";
  if (filters.has("avgblur")) return "avgblur=sizeX=20:sizeY=20";
  if (filters.has("boxblur")) return "boxblur=20:2";
  return null;
}

/** One caption image and when it is on screen. `from`/`to` in seconds from the
 *  start of the SEGMENT; null on both means the whole segment. */
export type Overlay = { png: string; from: number | null; to: number | null };

/**
 * Build the video filter graph for one segment.
 *
 * Returned as a `filter_complex` string, so the caller can put the inputs in
 * the right order — an overlay refers to its input by index and getting that
 * wrong composites the wrong picture rather than producing an error.
 */
function videoGraph(opts: {
  width: number;
  height: number;
  fit: Fit;
  blur: string | null;
  pad: string;
  overlays: Overlay[];
  /** A drawtext fragment from captions.ts, or null. Applied AFTER the
   *  overlays, so a drawtext build and a typst build put the words in the same
   *  place relative to everything else. */
  drawtext: string | null;
}): string {
  const parts: string[] = [
    fitGraph({
      fit: opts.fit,
      width: opts.width,
      height: opts.height,
      blur: opts.blur,
      pad: opts.pad,
      inLabel: "0:v",
      outLabel: "v0",
    }),
  ];
  let cur = "v0";
  opts.overlays.forEach((o, i) => {
    const next = `v${i + 1}`;
    /* `enable` takes an expression, and the expression contains commas that
       the filtergraph parser would otherwise read as filter separators.
       Single quotes are what the parser honours; they survive because nothing
       here goes through a shell. */
    const when =
      o.from !== null && o.to !== null
        ? `:enable='between(t,${o.from.toFixed(2)},${o.to.toFixed(2)})'`
        : "";
    parts.push(`[${cur}][${i + 1}:v]overlay=0:0:format=auto${when}[${next}]`);
    cur = next;
  });
  if (opts.drawtext) {
    parts.push(`[${cur}]${opts.drawtext}[vt]`);
    cur = "vt";
  }
  parts.push(`[${cur}]format=yuv420p[vout]`);
  return parts.join(";");
}

export type SegmentResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * One shot, encoded to its own file.
 *
 * `-ss` GOES BEFORE `-i`, which is the fast seek: ffmpeg jumps to the nearest
 * keyframe before decoding rather than decoding from zero and throwing frames
 * away. It is not frame-accurate, and it does not need to be — the difference
 * is at most a second of stock footage or of somebody's sentence, and the
 * accurate version costs a full decode of everything before the cut, which on
 * a forty-minute source is the whole job.
 *
 * `-t` IS APPLIED ON THE OUTPUT AS WELL, because a source shorter than the
 * beat would otherwise produce a segment shorter than the beat, and a video
 * assembled out of segments that are not the length they were asked to be is
 * not the length the owner typed.
 */
export async function segment(opts: {
  ffmpeg: string;
  source: string;
  out: string;
  start: number;
  seconds: number;
  width: number;
  height: number;
  fit: Fit;
  blur: string | null;
  pad: string;
  overlays: Overlay[];
  drawtext: string | null;
  /** A narration file, or null for a segment with no sound. When null and
   *  `silentTrack` is true a silent track is generated instead — see the
   *  header on why a video's segments must agree. */
  audio: string | null;
  silentTrack: boolean;
  signal?: AbortSignal;
}): Promise<SegmentResult> {
  const args: string[] = ["-y", "-v", "error"];
  if (opts.start > 0) args.push("-ss", opts.start.toFixed(3));
  args.push("-t", opts.seconds.toFixed(3), "-i", opts.source);
  for (const o of opts.overlays) args.push("-i", o.png);
  const overlayInputs = opts.overlays.length;

  let audioIndex: number | null = null;
  if (opts.audio) {
    args.push("-i", opts.audio);
    audioIndex = 1 + overlayInputs;
  } else if (opts.silentTrack) {
    args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
    audioIndex = 1 + overlayInputs;
  }

  args.push(
    "-filter_complex",
    videoGraph({
      width: opts.width,
      height: opts.height,
      fit: opts.fit,
      blur: opts.blur,
      pad: opts.pad,
      overlays: opts.overlays,
      drawtext: opts.drawtext,
    }),
    "-map", "[vout]",
  );
  if (audioIndex !== null) {
    args.push("-map", `${audioIndex}:a`);
    /* The narration is padded with silence rather than allowed to end the
       segment. `apad` plus the output `-t` gives every segment exactly the
       length the script asked for, whether the narration ran short or long. */
    args.push("-af", "apad");
    args.push(...A_ARGS);
  } else {
    args.push("-an");
  }
  args.push(...V_ARGS, "-t", opts.seconds.toFixed(3), opts.out);

  const r = await run(opts.ffmpeg, args, { timeoutMs: 300_000, signal: opts.signal });
  return finish(r, opts.out);
}

/**
 * A still frame held for a few seconds — the end card.
 *
 * `-loop 1` on a PNG input with `-t` is how a still becomes a clip. The
 * `format=yuv420p` at the end of the chain matters here more than anywhere:
 * a PNG decodes to RGB and an H.264 stream cannot hold it.
 */
export async function still(opts: {
  ffmpeg: string;
  png: string;
  out: string;
  seconds: number;
  width: number;
  height: number;
  silentTrack: boolean;
  signal?: AbortSignal;
}): Promise<SegmentResult> {
  const args = ["-y", "-v", "error", "-loop", "1", "-t", opts.seconds.toFixed(3), "-i", opts.png];
  if (opts.silentTrack) args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  args.push(
    "-vf",
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=increase,crop=${opts.width}:${opts.height},setsar=1,fps=${FPS},format=yuv420p`,
  );
  if (opts.silentTrack) args.push("-map", "0:v", "-map", "1:a", ...A_ARGS);
  else args.push("-an");
  args.push(...V_ARGS, "-t", opts.seconds.toFixed(3), opts.out);
  const r = await run(opts.ffmpeg, args, { timeoutMs: 120_000, signal: opts.signal });
  return finish(r, opts.out);
}

/**
 * The segments, joined.
 *
 * The list file quotes each path and escapes a single quote in it, which is
 * the concat demuxer's own syntax and the one place in this file where a path
 * is written into a text format rather than passed as an argument. `-safe 0`
 * is what lets those paths be absolute.
 */
export async function concat(opts: {
  ffmpeg: string;
  parts: string[];
  out: string;
  dir: string;
  hasAudio: boolean;
  signal?: AbortSignal;
}): Promise<SegmentResult> {
  const list = resolve(opts.dir, "concat.txt");
  writeFileSync(
    list,
    opts.parts.map((p) => `file '${p.split("'").join("'\\''")}'`).join("\n") + "\n",
    "utf8",
  );
  const args = ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, ...V_ARGS];
  if (opts.hasAudio) args.push(...A_ARGS);
  else args.push("-an");
  /* faststart on the FINAL file only. It is a second pass over the written
     file to move the index to the front, and doing it to each segment would be
     paying for it a dozen times for a file nobody streams. */
  args.push("-movflags", "+faststart", opts.out);
  const r = await run(opts.ffmpeg, args, { timeoutMs: 600_000, signal: opts.signal });
  return finish(r, opts.out);
}

function finish(r: Ran, out: string): SegmentResult {
  if (r.ok) return { ok: true, path: out };
  return {
    ok: false,
    error: r.error ?? (tail(r.stderr || r.stdout) || `ffmpeg exited ${r.code ?? "with no code"}`),
  };
}

/** Strip a file's audio out to something the transcription endpoint will take.
 *  Mono 16 kHz, which is what every whisper-shaped model wants and is a tenth
 *  the bytes of the original track. */
export async function extractAudio(opts: {
  ffmpeg: string;
  source: string;
  out: string;
  maxSeconds: number;
  signal?: AbortSignal;
}): Promise<SegmentResult> {
  const r = await run(
    opts.ffmpeg,
    [
      "-y", "-v", "error",
      "-i", opts.source,
      "-t", String(Math.round(opts.maxSeconds)),
      "-vn", "-ac", "1", "-ar", "16000",
      "-c:a", "libmp3lame", "-b:a", "64k",
      opts.out,
    ],
    { timeoutMs: 600_000, signal: opts.signal },
  );
  return finish(r, opts.out);
}
