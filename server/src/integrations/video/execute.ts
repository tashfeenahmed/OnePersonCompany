/**
 * THE ONE DOOR THE EXECUTOR KNOWS ABOUT.
 *
 * `runs/executor.ts` gets a single line for this area — a branch on
 * `row.kind === "video"` — and everything behind that line is here: reading
 * the run's inputs, choosing which of the two pipelines is being asked for,
 * and turning a thrown `StepError` into a run failure that names its step.
 *
 * THE INPUTS ARE PARSED HERE AND NOT IN THE PIPELINES, because the run row
 * holds them as strings — a run is a ledger entry and a ledger entry is text —
 * and two pipelines each deciding for themselves what "30" means would be two
 * places for a default to drift. Everything is clamped, and a value outside
 * its range is CLAMPED rather than refused: the run has already been queued
 * and started by the time anybody gets here, and failing a video because
 * somebody typed 400 seconds would be a failure that helps nobody.
 *
 * A CANCELLED RUN'S FILES ARE LEFT WHERE THEY ARE. The executor writes the row
 * and the directory keeps whatever had been downloaded; deleting the run
 * deletes the directory, which is the moment somebody has actually said they
 * want it gone. Half a video on the disk after a cancel is a few hundred
 * megabytes and an accurate record of what happened.
 */
import { rmSync } from "node:fs";
import type { VentureRow } from "../../db.ts";
import { facelessVideo, runDir, StepError, type RunSession } from "./faceless.ts";
import { shortsVideo } from "./shorts.ts";
import { ASPECTS, type Fit } from "./assemble.ts";
import { forgetJob } from "./store.ts";

export const FORMATS = ["faceless", "shorts"] as const;
export type Format = (typeof FORMATS)[number];

export function readFormat(raw: string | undefined): Format {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "shorts" ? "shorts" : "faceless";
}

const clampNumber = (raw: string | undefined, fallback: number, lo: number, hi: number) => {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
};

/** The default length of a faceless video. Thirty seconds is where every
 *  short-form platform stops autoplaying a preview and starts counting a view,
 *  and it is six or seven shots — enough to make one point. */
export const DEFAULT_SECONDS = 30;

export async function videoRun(opts: {
  runId: string;
  session: RunSession;
  venture: VentureRow | null;
  input: Record<string, string>;
  signal?: AbortSignal;
}): Promise<void> {
  const format = readFormat(opts.input.format);
  const aspect = (opts.input.aspect ?? "").trim() in ASPECTS ? opts.input.aspect!.trim() : "9:16";
  const fit: Fit = (opts.input.fit ?? "").trim().toLowerCase() === "letterbox" ? "letterbox" : "cover";
  const brief = (opts.input.brief ?? "").trim();

  if (format === "shorts") {
    const url = (opts.input.url ?? "").trim();
    if (!url) throw new StepError("input", "A shorts job needs a video URL to cut up. There is nothing at the address field.");
    if (!/^https?:\/\//i.test(url))
      throw new StepError("input", `“${url.slice(0, 80)}” is not an http(s) address, so nothing can be fetched from it.`);
    return shortsVideo({
      runId: opts.runId,
      session: opts.session,
      venture: opts.venture,
      input: {
        url,
        brief,
        /* For shorts this is the LONGEST a clip may be, not the length of the
           output — a highlight is as long as the thought in it. */
        seconds: clampNumber(opts.input.seconds, 45, 15, 90),
        aspect,
        fit,
        clips: clampNumber(opts.input.clips, 3, 2, 4),
      },
      signal: opts.signal,
    });
  }

  if (!opts.venture)
    throw new StepError("input", "A faceless video is made out of a venture — its name, its sentence, its stage and its colours. Choose one.");
  return facelessVideo({
    runId: opts.runId,
    session: opts.session,
    venture: opts.venture,
    input: {
      brief,
      seconds: clampNumber(opts.input.seconds, DEFAULT_SECONDS, 10, 120),
      aspect,
      fit,
    },
    signal: opts.signal,
  });
}

/** Everything a deleted run owns. Called from the runs area's delete path via
 *  this area's route; the rows go and so does the directory, because the
 *  files exist only because of that run. */
export function forgetVideo(runId: string) {
  forgetJob(runId);
  try {
    rmSync(runDir(runId), { recursive: true, force: true });
  } catch {
    /* A directory that will not delete costs disk, not correctness. */
  }
}
