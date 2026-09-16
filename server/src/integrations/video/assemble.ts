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

/**
 * THE FRAME SHAPES THIS BOX RENDERS, and what they are in pixels.
 *
 * THE ONE LIST. Everything that accepts, validates, names or draws a shape
 * asks this map rather than repeating its keys: a hardcoded copy in the
 * motion-spec reader or the Studio's format list would drift from this one
 * and silently render 9:16 for a shape it does not recognise, so both are
 * checked against these keys instead. Adding a fourth entry here is meant to
 * be the whole change.
 */
export const ASPECTS: Record<string, { width: number; height: number; about: string }> = {
  "9:16": { width: 1080, height: 1920, about: "9:16 — a reel, a short, a TikTok. The default." },
  "1:1": { width: 1080, height: 1080, about: "1:1 — a square feed post." },
  "16:9": { width: 1920, height: 1080, about: "16:9 — a landscape video for YouTube or a site." },
};

/** 9:16, because it is the only shape every short-form platform takes without
 *  re-cropping. Named rather than typed at each of the eight places that fall
 *  back to it. */
export const DEFAULT_ASPECT = "9:16";

/** The frame for an aspect, or the default frame. `ASPECTS[x] ?? ASPECTS["9:16"]!`
 *  was written out at every pipeline entry point, non-null assertion included. */
export const aspectFrame = (aspect: string | null | undefined) =>
  ASPECTS[aspect ?? ""] ?? ASPECTS[DEFAULT_ASPECT]!;

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
 *
 * `track` IS A THIRD MODE AND IT ARRIVES AS AN EXTRA PARAMETER RATHER THAN AS
 * A THIRD `Fit`. A tracked crop is not a different way of fitting a picture to
 * the frame — it is a crop taken BEFORE the fit, with a left edge that is a
 * function of `t`, and the fit that follows it is still `cover`. Keeping it off
 * the `Fit` union means every existing caller, every stored run input and the
 * run kind's own select list all keep meaning exactly what they meant.
 * `x` and `y` are ffmpeg expressions built by videoplus/track.ts; the commas
 * inside them are escaped there, because this string is a filtergraph and the
 * filtergraph parser reads an unescaped comma as the next filter.
 */
export type Track = { cropW: number; cropH: number; x: string; y: string };

export function fitGraph(opts: {
  fit: Fit;
  width: number;
  height: number;
  blur: string | null;
  pad: string;
  inLabel: string;
  outLabel: string;
  track?: Track | null;
}): string {
  const { width: w, height: h, outLabel: o } = opts;
  const cover = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,fps=${FPS}`;
  if (opts.track) {
    const t = opts.track;
    /* The moving crop, then a plain scale — no second crop, because the window
       already has the output's aspect ratio and `increase` would re-crop it. */
    return `[${opts.inLabel}]crop=${t.cropW}:${t.cropH}:${t.x}:${t.y},scale=${w}:${h},setsar=1,fps=${FPS}[${o}]`;
  }
  const i = opts.inLabel;
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
  /** A moving crop applied before the fit, or null for the plain one. */
  track?: Track | null;
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
      track: opts.track ?? null,
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
  /** A moving crop, from videoplus/track.ts, or null for the fixed fit. */
  track?: Track | null;
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
      track: opts.track ?? null,
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

/* ------------------------------------------------------------------------ */
/*  THE THREE ENCODES THE videoplus FORMATS ADDED                            */
/*                                                                           */
/*  They live here rather than in integrations/videoplus/ for the reason at   */
/*  the top of this file: every ffmpeg invocation this area makes is in one   */
/*  place, so the flags that make a file play in a `<video>` element are      */
/*  applied by one set of constants and cannot drift between formats.         */
/* ------------------------------------------------------------------------ */

/**
 * A DIRECTORY OF PNG FRAMES, ENCODED AS ONE SCENE.
 *
 * `-framerate` BEFORE `-i` IS THE INPUT RATE and it is the whole point: it
 * tells ffmpeg how fast the stills arrive. `-r` after would set the output
 * rate and leave the input at 25, which silently changes the length of every
 * scene. The output is then forced to the area's own 30 by V_ARGS, and ffmpeg
 * duplicates frames to get there — which is why the motion renderer can draw
 * twelve frames a second and still write a thirty-frame file.
 *
 * The frames are already the frame's exact size, so there is no scale in the
 * chain; `format=yuv420p` is still needed because a PNG decodes to RGB.
 */
export async function fromFrames(opts: {
  ffmpeg: string;
  /** A printf pattern — `frame-%05d.png` — inside `dir`. */
  pattern: string;
  dir: string;
  out: string;
  fps: number;
  seconds: number;
  /** A narration file, or null. */
  audio: string | null;
  silentTrack: boolean;
  signal?: AbortSignal;
}): Promise<SegmentResult> {
  const args = ["-y", "-v", "error", "-framerate", String(opts.fps), "-start_number", "0", "-i", resolve(opts.dir, opts.pattern)];
  if (opts.audio) args.push("-i", opts.audio);
  else if (opts.silentTrack) args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  // A narrated scene can outlast its animation. Repeat the final frame until
  // the caller's measured duration; -t below bounds the otherwise infinite pad.
  args.push("-vf", "tpad=stop_mode=clone:stop=-1,format=yuv420p", "-map", "0:v");
  if (opts.audio || opts.silentTrack) args.push("-map", "1:a", "-af", "apad", ...A_ARGS);
  else args.push("-an");
  args.push(...V_ARGS, "-t", opts.seconds.toFixed(3), opts.out);
  const r = await run(opts.ffmpeg, args, { timeoutMs: 300_000, signal: opts.signal });
  return finish(r, opts.out);
}

/**
 * A TALL SCREENSHOT, PANNED DOWN — the walkthrough's "scrolling".
 *
 * There is no browser-recording API on this box (chrome.ts says why), so a
 * page scroll is not recorded, it is CONSTRUCTED: Chrome renders the page once
 * into a very tall window, and this moves a viewport-sized crop down that one
 * picture. `crop` evaluates its y per frame and `t` is available in the
 * expression, so the movement is arithmetic — which is both cheaper than a
 * screen recording and smoother than one, because there is no frame rate to
 * drop.
 *
 * THE HOLD AND THE TAIL ARE NOT DECORATION. Starting to move immediately gives
 * a viewer nothing to read at the top of the page, and arriving at the bottom
 * exactly as the shot ends reads as the video stopping mid-gesture. The pan is
 * also allowed NOT to finish: a page four times taller than its shot pans at
 * the same readable speed and simply gets as far as it gets, because the
 * alternative is a blur.
 *
 * A page shorter than the viewport does not move at all, which is correct — a
 * one-screen page has nothing to scroll — and the caller records it as a still.
 */
export async function panStill(opts: {
  ffmpeg: string;
  png: string;
  out: string;
  seconds: number;
  /** The width and height of the viewport being panned. */
  viewW: number;
  viewH: number;
  /** The height of the whole picture. */
  imageH: number;
  hold?: number;
  tail?: number;
  /** Pixels a second. Above about 250 the text is unreadable on a phone. */
  maxSpeed?: number;
  signal?: AbortSignal;
}): Promise<SegmentResult> {
  const maxY = Math.max(0, opts.imageH - opts.viewH);
  const hold = Math.min(opts.hold ?? 0.8, opts.seconds / 3);
  const tail = Math.min(opts.tail ?? 0.4, opts.seconds / 4);
  const travel = Math.max(0.1, opts.seconds - hold - tail);
  const speed = maxY === 0 ? 0 : Math.min(opts.maxSpeed ?? 220, maxY / travel);
  const y = maxY === 0 ? "0" : `min(${maxY}\\,max(0\\,(t-${hold.toFixed(2)})*${speed.toFixed(2)}))`;
  const r = await run(
    opts.ffmpeg,
    [
      "-y", "-v", "error",
      "-loop", "1", "-t", opts.seconds.toFixed(3), "-i", opts.png,
      "-vf", `crop=${opts.viewW}:${opts.viewH}:0:'${y}',setsar=1,fps=${FPS},format=yuv420p`,
      "-an",
      ...V_ARGS,
      "-t", opts.seconds.toFixed(3),
      opts.out,
    ],
    { timeoutMs: 300_000, signal: opts.signal },
  );
  return finish(r, opts.out);
}

/** Audio as 16 kHz mono WAV, which is the one format whisper.cpp reads without
 *  a decoder. Separate from `extractAudio` above, which writes an mp3 for an
 *  HTTP transcription endpoint — the two want different things and a single
 *  function with a format flag would be a function whose callers all pass the
 *  flag. */
export async function wavForSpeech(opts: {
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
      "-c:a", "pcm_s16le",
      opts.out,
    ],
    { timeoutMs: 900_000, signal: opts.signal },
  );
  return finish(r, opts.out);
}

/** Cut a sheet of side-by-side frames back into single frames. `untile` is an
 *  ffmpeg filter rather than N crops, so a sheet of eight is one process; the
 *  output numbering starts at `start` so consecutive sheets extend one
 *  sequence rather than each writing frame zero. */
export async function untileSheet(opts: {
  ffmpeg: string;
  sheet: string;
  dir: string;
  pattern: string;
  tiles: number;
  start: number;
  signal?: AbortSignal;
}): Promise<SegmentResult> {
  const out = resolve(opts.dir, opts.pattern);
  const r = await run(
    opts.ffmpeg,
    ["-y", "-v", "error", "-i", opts.sheet, "-vf", `untile=${opts.tiles}x1`, "-start_number", String(opts.start), out],
    { timeoutMs: 120_000, signal: opts.signal },
  );
  return finish(r, out);
}

/** Whether this build can cut a sheet apart. Probed, because `untile` is not
 *  in every ffmpeg and a motion render on a build without it must say so
 *  rather than write eight frames of nothing. */
export const hasUntile = (filters: Set<string>) => filters.has("untile");

/**
 * THE SAME VOICE, MADE TO SOUND LIKE A DIFFERENT ONE.
 *
 * A dialogue reel needs two speakers. When the voice endpoint has more than
 * one voice the second role simply asks for a different name — see
 * signals/voice/provider.ts — and this is not used. When it has only one, the
 * alternative is a two-hander in which both people sound identical, which
 * reads as a fault rather than as a stylistic choice.
 *
 * `asetrate` RESAMPLES WITHOUT RESAMPLING, which is the trick: playing 44.1 kHz
 * audio as if it were 41.5 kHz lowers the pitch AND slows it, and `atempo`
 * puts the speed back without touching the pitch. The result is the same
 * speaker a few semitones down — recognisably a different person on a phone
 * speaker, and honestly described on the run as one voice at two pitches
 * rather than as two voices.
 *
 * The shift is small on purpose. Past about eight per cent it stops sounding
 * like a person and starts sounding like a processed recording.
 */
export async function shiftVoice(opts: {
  ffmpeg: string;
  source: string;
  out: string;
  /** Below 1 is deeper. 0.94 is about a tone down. */
  ratio: number;
  signal?: AbortSignal;
}): Promise<SegmentResult> {
  const ratio = Math.max(0.9, Math.min(1.1, opts.ratio));
  const r = await run(
    opts.ffmpeg,
    [
      "-y", "-v", "error",
      "-i", opts.source,
      "-af", `asetrate=44100*${ratio.toFixed(3)},aresample=44100,atempo=${(1 / ratio).toFixed(4)}`,
      "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "160k",
      opts.out,
    ],
    { timeoutMs: 120_000, signal: opts.signal },
  );
  return finish(r, opts.out);
}
