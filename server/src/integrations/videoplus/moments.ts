/**
 * WHEN THINGS WERE SAID, WHERE THE CAMERA CUT, AND WHICH WINDOW IS A CLIP.
 *
 * The shorts pipeline already chooses windows out of a transcript. This file
 * is the two measurements that make those windows land in the right place, and
 * one deterministic chooser for when there is no model to ask.
 *
 * 1. WORD TIMINGS, from a local whisper if this box has one. The existing
 *    speech path returns ONE STRING WITH NO TIMES IN IT — shorts.ts's header
 *    says so and marks those clips `speech` for exactly that reason — which
 *    means it can say what was said and not when. whisper.cpp run with
 *    `-ml 1 -sow` emits one segment per WORD with a start and an end in
 *    milliseconds, which turns the weakest timing source into the strongest.
 *    NO MODEL IS BUNDLED and none is downloaded: a ggml model is a file the
 *    owner fetched on purpose, so the path is a setting, and with no setting
 *    the answer is null and a sentence rather than a guess.
 *
 * 2. SCENE BOUNDARIES, from ffmpeg. `select='gt(scene,T)'` scores each frame
 *    against the one before it and passes the ones that differ enough;
 *    `metadata=print` writes the timestamp of every frame that got through. A
 *    cut is the one moment in a video where starting a clip is free — nobody
 *    is mid-word and nothing is mid-gesture — so the windows a model picked
 *    out of the words are SNAPPED to the nearest cut when there is one close
 *    by, and left exactly where the model put them when there is not.
 *
 * 3. A CHOOSER THAT NEEDS NO MODEL. With word timings and cuts, the best
 *    windows can be found by arithmetic: the densest runs of speech that start
 *    at a cut. It is not as good as a model reading the transcript and it is
 *    enormously better than even spacing, and it is labelled `words` so a
 *    reader can tell which of the three they are looking at.
 *
 * EVERYTHING HERE DEGRADES TO NULL WITH A REASON. No whisper, no model file, a
 * whisper that failed, an ffmpeg that timed out on a ninety-minute source —
 * each is a sentence on the run and each leaves the pipeline on the path it
 * had before. Not one of them is allowed to become a silently worse clip.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { findBinary } from "../../tools/find-binary.ts";
import { run, tail } from "../video/tools.ts";
import { VIDEOPLUS_PLUGIN, sceneThreshold, whisperModel } from "./settings.ts";

/* ------------------------------------------------------------ the binary */

/** The names whisper.cpp has shipped its CLI under. `main` is what the older
 *  builds called it and is still what a hand-built checkout produces. */
const WHISPER_NAMES = ["whisper-cpp", "whisper", "main"] as const;

export type WhisperTool = { path: string | null; model: string | null; error: string | null };

/**
 * The local transcriber, or the sentence saying why there is none.
 *
 * BOTH HALVES ARE REQUIRED AND THEY FAIL SEPARATELY. A machine with the binary
 * and no model and a machine with neither are two different problems with two
 * different fixes, and one message covering both would send somebody to
 * install something they already have. So the binary goes through the shared
 * finder — which knows the prefixes, the aliases and the rule that a
 * configured path that is not there is an error — and the MODEL is checked
 * here, because nothing discovers a two-gigabyte file somebody downloaded on
 * purpose.
 */
export function findWhisper(): WhisperTool {
  const bin = findBinary({
    name: "whisper-cli",
    aliases: WHISPER_NAMES,
    configKeys: [{ plugin: VIDEOPLUS_PLUGIN, key: "whisper", label: "the Video extras settings" }],
    install: "brew install whisper-cpp",
  });
  if (!bin.found)
    return {
      path: null,
      model: null,
      error:
        `${bin.error} Without it there are no word timings and the pipeline uses ` +
        "whatever subtitles the site published.",
    };
  const model = whisperModel();
  if (!model)
    return {
      path: bin.path,
      model: null,
      error:
        `whisper is at ${bin.path} but no model file is set. A ggml model is a file you downloaded on purpose — ` +
        `nothing here fetches one — so set \`whisperModel\` under the Video extras settings to its path.`,
    };
  if (!existsSync(model))
    return { path: bin.path, model: null, error: `The whisper model set under the Video extras settings — ${model} — is not there.` };
  return { path: bin.path, model, error: null };
}

/* ------------------------------------------------------------- the words */

export type Word = { start: number; end: number; text: string };

/**
 * whisper.cpp's JSON, read.
 *
 * The file is `{ transcription: [ { offsets: { from, to }, text } ] }` with the
 * offsets in MILLISECONDS. Run with `-ml 1 -sow` each entry is one word, and
 * whisper emits empty-text entries for the silences between them — those are
 * dropped rather than kept as zero-length words, because a density count that
 * included them would find its densest run in a pause.
 */
export function parseWhisperJson(raw: string): Word[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  const list = (doc as { transcription?: unknown })?.transcription;
  if (!Array.isArray(list)) return [];
  const out: Word[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as { offsets?: { from?: unknown; to?: unknown }; text?: unknown };
    const from = Number(o.offsets?.from);
    const to = Number(o.offsets?.to);
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (!text || !Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
    out.push({ start: from / 1000, end: to / 1000, text });
  }
  return out;
}

/**
 * A source's words, timed, or the reason there are none.
 *
 * The audio is handed over as 16 kHz mono WAV because that is the only thing
 * whisper.cpp reads without a decoder, and it is what the model wants anyway.
 * The caller strips it — assemble.ts owns every ffmpeg call.
 */
export async function whisperWords(opts: {
  tool: WhisperTool;
  wav: string;
  dir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ words: Word[]; note: string }> {
  if (!opts.tool.path || !opts.tool.model) return { words: [], note: opts.tool.error ?? "no local whisper" };
  const out = resolve(opts.dir, "words");
  rmSync(`${out}.json`, { force: true });
  const r = await run(
    opts.tool.path,
    [
      "-m", opts.tool.model,
      "-f", opts.wav,
      /* ONE SEGMENT PER WORD. `-ml 1` caps a segment at one character, which
         whisper resolves to one token, and `-sow` makes it break on words
         rather than on subword pieces — together they are the documented way
         to get word timings out of this binary. */
      "-ml", "1",
      "-sow",
      "-oj",
      "-np",
      "-of", out,
    ],
    { timeoutMs: opts.timeoutMs, signal: opts.signal },
  );
  if (!existsSync(`${out}.json`))
    return { words: [], note: `whisper wrote no output — ${r.error ?? (tail(r.stderr || r.stdout) || "it exited without a JSON file")}.` };
  const words = parseWhisperJson(readFileSync(`${out}.json`, "utf8"));
  if (!words.length) return { words: [], note: "whisper ran and returned no words, so there is nothing timed to choose from." };
  return {
    words,
    note: `${words.length.toLocaleString()} words were timed locally by whisper (${opts.tool.model!.split("/").pop()}), each with its own start and end.`,
  };
}

/** Words rolled up into readable lines, so the model reads sentences rather
 *  than a column of words. The break is on a gap in speech — half a second of
 *  silence is where a person stopped — or on length. */
export function linesFromWords(words: Word[], gap = 0.6, maxChars = 90): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (const w of words) {
    const cur = out[out.length - 1];
    if (cur && w.start - cur.end < gap && cur.text.length + w.text.length + 1 <= maxChars) {
      cur.text += ` ${w.text}`;
      cur.end = w.end;
      continue;
    }
    out.push({ start: w.start, end: w.end, text: w.text });
  }
  return out;
}

/* ------------------------------------------------------------- the cuts */

/**
 * Every timestamp at which the picture changed enough to call it a cut.
 *
 * THE STREAM IS SCALED DOWN FIRST. The scene score is a normalised difference
 * between whole frames, so it is very nearly the same on a 320-wide copy and a
 * tenth of the arithmetic — the decode is the expensive half either way, which
 * is why this is bounded by a timeout and reported as unmeasured when it hits
 * it rather than holding a run open for a ninety-minute source.
 */
export async function sceneCuts(opts: {
  ffmpeg: string;
  source: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ cuts: number[]; note: string }> {
  const t = sceneThreshold();
  const r = await run(
    opts.ffmpeg,
    [
      "-v", "info",
      "-i", opts.source,
      "-an",
      "-vf", `scale=320:-2,select='gt(scene\\,${t})',metadata=print:file=-`,
      "-f", "null",
      "-",
    ],
    { timeoutMs: opts.timeoutMs ?? 300_000, signal: opts.signal },
  );
  const cuts = parseSceneCuts(`${r.stdout}\n${r.stderr}`);
  if (!cuts.length)
    return {
      cuts: [],
      note: r.error
        ? `Scene detection did not finish — ${r.error}. The windows were not snapped to cuts.`
        : `ffmpeg found no scene change above ${t} in this video, so nothing was snapped to a cut. A single unbroken shot is the ordinary reason.`,
    };
  return { cuts, note: `${cuts.length} scene changes were found by ffmpeg at a threshold of ${t}.` };
}

/** `metadata=print` writes `frame:N pts:… pts_time:12.345`. Pure, so the parse
 *  is testable without a video. */
export function parseSceneCuts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && (out.length === 0 || n - out[out.length - 1]! > 0.2)) out.push(Math.round(n * 1000) / 1000);
  }
  return out;
}

/* --------------------------------------------------------- the snapping */

/** The nearest cut within `tolerance` seconds, or the value unchanged. A
 *  window moved half a minute to reach a cut would be a different clip. */
export function snapToCut(value: number, cuts: number[], tolerance: number): number {
  let best = value;
  let bestGap = tolerance;
  for (const c of cuts) {
    const gap = Math.abs(c - value);
    if (gap <= bestGap) {
      bestGap = gap;
      best = c;
    }
  }
  return best;
}

/** The start of the first word at or after `value`, within tolerance. Used on
 *  a window's START only: a clip that opens mid-word is unusable, and a clip
 *  that ends a fraction early is not. */
export function snapToWordStart(value: number, words: Word[], tolerance: number): number {
  let best = value;
  let bestGap = tolerance;
  for (const w of words) {
    const gap = Math.abs(w.start - value);
    if (gap <= bestGap) {
      bestGap = gap;
      best = w.start;
    }
  }
  return best;
}

export type Moment = { title: string; reason: string; start: number; end: number };

/**
 * Windows tidied against what was actually measured.
 *
 * The order is START to a cut, then START to a word, then the END to the last
 * word that fits — because those are the three things a viewer notices, in the
 * order they notice them. Nothing here MOVES a window more than the tolerance
 * and nothing lengthens one past its ceiling; a window that cannot be improved
 * comes back exactly as it went in.
 */
export function tidyWindows(opts: {
  windows: Moment[];
  cuts: number[];
  words: Word[];
  duration: number;
  maxSeconds: number;
  minSeconds?: number;
  tolerance?: number;
}): { windows: Moment[]; moved: number } {
  const tol = opts.tolerance ?? 1.5;
  const min = opts.minSeconds ?? 8;
  let moved = 0;
  /* IN TIME ORDER FIRST, because the overlap pass below compares each window
     with the one before it and "before" has to mean what it says. The model is
     asked for non-overlapping windows and usually gives them in order; usually
     is not a guarantee to build an invariant on. */
  const ordered = [...opts.windows].sort((a, b) => a.start - b.start);
  const out = ordered.map((w) => {
    let start = w.start;
    if (opts.cuts.length) start = snapToCut(start, opts.cuts, tol);
    if (opts.words.length) start = snapToWordStart(start, opts.words, tol);
    start = Math.max(0, Math.min(start, Math.max(0, opts.duration - min)));

    let end = w.end;
    if (opts.words.length) {
      /* The last word that ENDS inside the window, plus a breath. A clip cut
         mid-word at the end is the same fault as one that opens mid-word, and
         it is cheaper to fix. */
      const inside = opts.words.filter((x) => x.end <= end && x.start >= start);
      const last = inside[inside.length - 1];
      if (last) end = Math.min(end, last.end + 0.25);
    }
    end = Math.min(opts.duration, Math.max(start + min, Math.min(end, start + opts.maxSeconds)));
    if (Math.abs(start - w.start) > 0.05 || Math.abs(end - w.end) > 0.05) moved++;
    return { ...w, start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 };
  });

  /*
    AND NOW PUT BACK THE ONE GUARANTEE THE SNAPPING CAN BREAK.

    Each window's start is nudged BACKWARDS independently by up to the
    tolerance, so two windows the model chose a whisker apart can end up
    overlapping: `[10,25]` and `[25.2,40]` become `[10,24.8]` and `[23.8,40]`,
    and two clips ship a second of identical footage. script.ts guarantees
    non-overlap when the model answers; this restores it after the arithmetic.

    A WINDOW PUSHED PAST ITS OWN END IS DROPPED RATHER THAN SHRUNK TO NOTHING.
    Clamping a start forward can leave less than the minimum, and a two-second
    clip is not a clip; the run reports fewer windows, which is honest, rather
    than a file nobody can post.
  */
  const kept: Moment[] = [];
  for (const w of out) {
    const previous = kept[kept.length - 1];
    if (!previous) {
      kept.push(w);
      continue;
    }
    if (w.start >= previous.end) {
      kept.push(w);
      continue;
    }
    const start = Math.round(previous.end * 100) / 100;
    if (w.end - start < min) {
      moved++;
      continue;
    }
    moved++;
    kept.push({ ...w, start });
  }
  return { windows: kept, moved };
}

/**
 * WINDOWS CHOSEN WITHOUT A MODEL, out of word timings and cuts.
 *
 * The score is words per second inside the window — the densest speech in the
 * video, which is the closest thing to "the interesting part" that arithmetic
 * can see. Windows are seeded at CUTS where there are any, because a clip that
 * begins where the camera did is a clip that begins cleanly, and at word
 * starts otherwise. Overlaps are refused rather than merged.
 *
 * THIS IS NOT HIGHLIGHT SELECTION AND THE CALLER LABELS IT `words`. Density
 * finds the part of a video where somebody talked fastest, which is often the
 * good part and is sometimes the disclaimer.
 */
export function chooseMoments(opts: {
  words: Word[];
  cuts: number[];
  duration: number;
  want: number;
  maxSeconds: number;
  minSeconds?: number;
}): Moment[] {
  const min = Math.max(5, opts.minSeconds ?? Math.min(15, opts.maxSeconds));
  if (!opts.words.length || opts.duration < min) return [];
  const seeds = (opts.cuts.length ? opts.cuts : opts.words.map((w) => w.start)).filter(
    (t) => t >= 0 && t + min <= opts.duration,
  );
  /* The whole video's start is always a candidate even when nothing cut
     there — otherwise a single-shot video with no cuts has no seeds at all. */
  if (!seeds.includes(0)) seeds.unshift(0);

  const scored = seeds
    .map((start) => {
      const end = Math.min(opts.duration, start + opts.maxSeconds);
      if (end - start < min) return null;
      const inside = opts.words.filter((w) => w.start >= start && w.end <= end);
      if (inside.length < 5) return null;
      const last = inside[inside.length - 1]!;
      const real = Math.max(min, Math.min(opts.maxSeconds, last.end + 0.25 - start));
      return {
        start,
        end: Math.round((start + real) * 100) / 100,
        score: inside.length / real,
        text: inside.map((w) => w.text).join(" "),
      };
    })
    .filter((x): x is { start: number; end: number; score: number; text: string } => x !== null)
    .sort((a, b) => b.score - a.score);

  const picked: Moment[] = [];
  for (const c of scored) {
    if (picked.length >= opts.want) break;
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue;
    picked.push({
      title: c.text.split(/\s+/).slice(0, 8).join(" ").replace(/[.,;:]$/, "") || stamp(c.start),
      reason:
        `Chosen by arithmetic, not by a model: this window holds ${c.score.toFixed(1)} spoken words a second, ` +
        `which is among the densest in the video, and it starts at ${opts.cuts.length ? "a scene change" : "a word boundary"}.`,
      start: Math.round(c.start * 100) / 100,
      end: c.end,
    });
  }
  return picked.sort((a, b) => a.start - b.start);
}

const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")} in`;
