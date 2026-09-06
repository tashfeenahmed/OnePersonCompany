/**
 * FOLLOWING THE SUBJECT WITH NOTHING BUT ffmpeg AND ARITHMETIC.
 *
 * A landscape video cut to 9:16 throws away two thirds of its width. The
 * existing pipeline throws away the outer thirds and keeps the middle, which
 * is right for stock footage and wrong for almost everything a shorts job is
 * pointed at: an interview with two people, a talking head sitting left of
 * frame, a screen share with the speaker in a corner. This file measures where
 * the picture is CHANGING and moves the crop window towards it.
 *
 * WHAT IT IS NOT: there is no face detection here and there must never be a
 * sentence anywhere that says there is. This box has no vision model — the
 * probe in `visionModel()` looks for one and has, on this machine, never found
 * one — and a motion centroid is not a face box. It gets a speaker who moves
 * right and a slide that changes wrong, and the row it writes says which
 * detector produced the path so a reader can tell.
 *
 * HOW THE MEASUREMENT IS TAKEN, and it is deliberately the cheapest thing that
 * could work: ffmpeg decodes the window once at four frames a second into
 * 64×36 GREYSCALE raw bytes — 2,304 bytes a frame, so a forty-second clip is
 * under half a megabyte — and this file diffs consecutive frames and takes the
 * intensity-weighted centre of the difference along x. No filter graph does
 * this, no library is imported, and the whole sample costs about a second of
 * CPU on a laptop.
 *
 * THE PATH IS SMOOTHED BECAUSE A RAW CENTROID IS UNWATCHABLE. Frame-to-frame
 * the centre of motion jumps: a hand moves, a caption appears, somebody
 * blinks. A crop that followed that would be a camera operator having a
 * seizure. Two limits are applied, in this order and for two different
 * reasons: an exponential smoother, which removes the jitter, and a MAXIMUM
 * SPEED in pixels per second, which is what stops a genuine two-person cut
 * from becoming a whip pan. Then the whole path is clamped so the crop window
 * never leaves the frame — an unclamped crop is not a bad shot, it is an
 * ffmpeg error at encode time.
 *
 * THE PATH REACHES ffmpeg AS AN EXPRESSION. `crop=w:h:x:y` evaluates x per
 * frame and accepts `t`, so a piecewise-LINEAR function of t written out as a
 * sum of `between(t,a,b) * (…)` terms gives a continuously moving window with
 * one filter and no sendcmd file. The number of control points is capped so
 * the expression stays a few thousand characters rather than tens of them.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/* ------------------------------------------------------- the raw sampling */

/** The sampling grid. Small on purpose: the centre of a moving person is a
 *  low-frequency fact and 64 columns is a resolution of about thirty pixels on
 *  a 1920-wide source, which is finer than the crop needs to be. */
export const SAMPLE_W = 64;
export const SAMPLE_H = 36;
/** How many samples a second. Four is enough to see a person cross a frame and
 *  is a sixth of the decode of doing it at 24. */
export const SAMPLE_FPS = 4;

/** One process, awaited, with its stdout kept as BYTES. tools.ts's `run` hands
 *  back a string, which is correct for every other caller here and destroys
 *  raw video. */
function runBytes(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ ok: boolean; out: Buffer; error: string | null }> {
  return new Promise((done) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeoutMs, maxBuffer: 64_000_000, signal: opts.signal, encoding: "buffer", killSignal: "SIGKILL" },
      (err, stdout) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
        if (!err) return done({ ok: true, out, error: null });
        done({ ok: false, out, error: err.message.slice(0, 300) });
      },
    );
  });
}

/**
 * The greyscale sample of one window of a source, as one flat buffer.
 *
 * `-ss` before `-i` is the fast seek, the same choice assemble.ts documents:
 * not frame-accurate, and it does not need to be, because everything computed
 * from these frames is a position rather than a moment.
 */
export async function sampleGrey(opts: {
  ffmpeg: string;
  source: string;
  start: number;
  seconds: number;
  signal?: AbortSignal;
}): Promise<{ frames: number; bytes: Buffer } | { error: string }> {
  const r = await runBytes(
    opts.ffmpeg,
    [
      "-v", "error",
      "-ss", opts.start.toFixed(3),
      "-t", opts.seconds.toFixed(3),
      "-i", opts.source,
      "-an",
      "-vf", `fps=${SAMPLE_FPS},scale=${SAMPLE_W}:${SAMPLE_H},format=gray`,
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      "-",
    ],
    { timeoutMs: 180_000, signal: opts.signal },
  );
  const frame = SAMPLE_W * SAMPLE_H;
  if (!r.ok && r.out.length < frame * 2) return { error: r.error ?? "ffmpeg produced no frames to measure" };
  const frames = Math.floor(r.out.length / frame);
  if (frames < 2) return { error: "fewer than two frames came back, so there is nothing to compare" };
  return { frames, bytes: r.out };
}

/* ---------------------------------------------------------- the arithmetic */

/**
 * The horizontal centre of MOTION in each pair of consecutive frames, as a
 * fraction of the width, or null for a pair with nothing moving in it.
 *
 * `null` RATHER THAN 0.5 for a still pair, and the difference matters: a
 * clip that is still for two seconds should HOLD the crop where it was, not
 * drift back to the middle and then out again. The smoother below carries the
 * last known position through the nulls.
 *
 * The threshold is on the per-column sum rather than per pixel, because
 * encoder noise is a couple of levels everywhere and a real subject is a lot
 * in one place. A pair whose whole difference is under `floor` is called
 * still.
 */
export function motionCentroids(bytes: Uint8Array, frames: number, floor = 900): (number | null)[] {
  const size = SAMPLE_W * SAMPLE_H;
  const out: (number | null)[] = [];
  for (let f = 1; f < frames; f++) {
    const a = f * size - size;
    const b = f * size;
    let total = 0;
    let weighted = 0;
    for (let x = 0; x < SAMPLE_W; x++) {
      let col = 0;
      for (let y = 0; y < SAMPLE_H; y++) {
        const i = y * SAMPLE_W + x;
        const d = Math.abs((bytes[b + i] ?? 0) - (bytes[a + i] ?? 0));
        /* Noise floor per pixel. Under six levels of 255 is compression, not
           movement, and summing it across 2,304 pixels is how a still frame
           acquires a confident centroid. */
        if (d > 6) col += d;
      }
      total += col;
      weighted += col * (x + 0.5);
    }
    out.push(total < floor ? null : weighted / total / SAMPLE_W);
  }
  return out;
}

export type Sample = { t: number; x: number };

/**
 * A watchable path out of a jittery one.
 *
 * `x` IS IN SOURCE PIXELS, the left edge of the crop window. The three steps
 * are in this order because each one undoes a different problem and doing them
 * the other way round reintroduces it:
 *
 *   1. carry     A null (nothing moved) holds the previous position. Before
 *                the first reading there is nothing to hold, so the path
 *                starts centred.
 *   2. smooth    An exponential moving average, `alpha` of the new reading.
 *                0.18 at four samples a second is a settle of about a second,
 *                which is roughly how fast a human operator pans.
 *   3. limit     A ceiling on pixels per second, applied AFTER smoothing —
 *                applied before, the smoother would just spread a whip pan
 *                over a longer whip pan.
 *
 * Then the clamp, which is not a preference: an x outside `0 … srcW - cropW`
 * makes ffmpeg refuse the filter.
 */
export function smoothPath(opts: {
  centroids: (number | null)[];
  srcWidth: number;
  cropWidth: number;
  fps?: number;
  alpha?: number;
  maxPxPerSecond?: number;
}): Sample[] {
  const fps = opts.fps ?? SAMPLE_FPS;
  const alpha = opts.alpha ?? 0.18;
  const maxStep = (opts.maxPxPerSecond ?? Math.round(opts.srcWidth * 0.14)) / fps;
  const maxX = Math.max(0, opts.srcWidth - opts.cropWidth);
  const centre = maxX / 2;

  let held: number | null = null;
  let smoothed = centre;
  let last = centre;
  const out: Sample[] = [];

  opts.centroids.forEach((c, i) => {
    if (c !== null) held = c;
    /* The crop is centred ON the subject, so the LEFT edge is the subject's
       position minus half a window. */
    const target = held === null ? centre : held * opts.srcWidth - opts.cropWidth / 2;
    smoothed = smoothed + alpha * (Math.max(0, Math.min(maxX, target)) - smoothed);
    const step = Math.max(-maxStep, Math.min(maxStep, smoothed - last));
    last = Math.max(0, Math.min(maxX, last + step));
    out.push({ t: (i + 1) / fps, x: Math.round(last) });
  });
  return out;
}

/** How far the path travelled, end to end, in source pixels. A drift of a few
 *  pixels over a whole clip is a fixed crop that measured something; the row
 *  records it so a page can say so rather than claiming a pan. */
export function drift(path: Sample[]): number {
  if (path.length < 2) return 0;
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.abs(path[i]!.x - path[i - 1]!.x);
  return Math.round(d);
}

/**
 * The path, thinned to at most `most` control points.
 *
 * EVENLY SPACED RATHER THAN BY CURVATURE. A Douglas–Peucker simplification
 * would keep more of the shape for the same number of points and it would also
 * be forty lines of geometry to save a few hundred characters of filter
 * string. The path is already smoothed, so evenly spaced samples of it are a
 * faithful description of it.
 */
export function thin(path: Sample[], most = 48): Sample[] {
  if (path.length <= most) return path;
  const out: Sample[] = [];
  for (let i = 0; i < most; i++) out.push(path[Math.round((i * (path.length - 1)) / (most - 1))]!);
  return out;
}

/**
 * The path as an ffmpeg expression for `crop`'s x.
 *
 * A SUM OF GATED LINEAR SEGMENTS. `between(t,a,b)` is 1 inside the interval
 * and 0 outside it, so multiplying each segment's line by its own gate and
 * adding them gives a piecewise-linear function with no branching. The first
 * segment's gate starts at −1 and the last one's ends past the clip, so a
 * frame whose t lands a hair outside the measured range still gets a value
 * rather than a zero — an ungated t would put the crop at the left edge for
 * one frame, which reads as a flash.
 *
 * Everything is fixed to whole pixels: an x of 412.7318 is a subpixel crop
 * ffmpeg rounds anyway, and the digits are filter string nobody reads.
 */
export function cropXExpr(path: Sample[], maxX: number): string {
  const pts = thin(path);
  if (!pts.length) return String(Math.round(maxX / 2));
  if (pts.length === 1) return String(clamp(pts[0]!.x, maxX));
  const terms: string[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const from = i === 0 ? -1 : a.t;
    const to = i === pts.length - 2 ? a.t + (b.t - a.t) * 1000 : b.t;
    const dt = Math.max(0.0001, b.t - a.t);
    const x0 = clamp(a.x, maxX);
    const x1 = clamp(b.x, maxX);
    const slope = (x1 - x0) / dt;
    terms.push(
      `between(t\\,${from.toFixed(3)}\\,${to.toFixed(3)})*(${x0}${slope >= 0 ? "+" : "-"}${Math.abs(slope).toFixed(2)}*(t-${a.t.toFixed(3)}))`,
    );
  }
  return terms.join("+");
}

const clamp = (x: number, maxX: number) => Math.max(0, Math.min(maxX, Math.round(x)));

/* ------------------------------------------------------- the vision probe */

/**
 * IS THERE A LOCAL VISION MODEL ON THIS BOX?
 *
 * Asked because the brief for this feature says to use one if there is, and
 * answered honestly: this looks for the two things that would count — a
 * configured model file that exists, or one of the command-line detectors a
 * person would have installed on purpose — and on the machine this was written
 * on it finds NEITHER. So the tracked crop is the motion centroid, the row
 * says `detector: "motion"`, and nothing anywhere claims a face was found.
 *
 * It is a probe rather than a constant so that the answer changes on a box
 * that does have one, and so the readiness document can say what is missing
 * instead of the feature silently being the weaker version everywhere.
 */
export function visionModel(configured: string): { found: boolean; path: string | null; note: string } {
  const path = configured.trim();
  if (path && existsSync(path)) return { found: true, path, note: `A vision model is configured at ${path}.` };
  if (path)
    return {
      found: false,
      path: null,
      note: `The vision model configured under the Video extras settings — ${path} — is not there, so the crop follows measured motion instead.`,
    };
  return {
    found: false,
    path: null,
    note:
      "No local vision model is configured, so there is no face or subject detector on this box. " +
      "The tracked crop follows the horizontal centre of MOTION between sampled frames, which is not the same thing: " +
      "a speaker who sits still while something moves behind them is the case it gets wrong.",
  };
}
