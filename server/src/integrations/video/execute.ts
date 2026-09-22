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
import { shortsClipCount } from "../../../../shared/studioInputs.ts";
import { rmSync } from "node:fs";
import type { VentureRow } from "../../db.ts";
import { facelessVideo, runDir, StepError, type RunSession } from "./faceless.ts";
import { shortsVideo } from "./shorts.ts";
import { ASPECTS, DEFAULT_ASPECT, type Fit } from "./assemble.ts";
import { clipRows, forgetJob, jobRow } from "./store.ts";
import { deleteThumbnails } from "./thumbnails.ts";
import * as leases from "../deploy/leases.ts";
import { carouselRun, forgetCarousel } from "../videoplus/carousel.ts";
import { carouselSize } from "../../../../shared/carousel.ts";
import { motionVideo } from "../videoplus/motion.ts";
import { reelVideo } from "../videoplus/reel.ts";
import { stewieVideo } from "../videoplus/stewie.ts";
import { forgetFraming } from "../videoplus/store.ts";
import { forgetSocialfeed } from "../socialfeed/forget.ts";

/* `ugc` was added by the socialfeed area, 2026-09-06. It is a FORMAT rather
   than a run kind for the reason this file exists: the executor knows one door
   per area, and a third pipeline behind the same door is one branch here
   instead of a new member of the RunKind union, a new page and a new entry in
   three shared files. `reel` and `motion` were added by the videoplus area on
   the same argument and on the same day: all five produce one video_jobs row,
   under one lease, on one queue. `carousel` (2026-09-22) is the one format
   that makes no video at all — six PNGs — and is here for the same reason:
   it is minutes of browser renders and model calls, and the queue, the lease
   and the rail's polling were already built for exactly that. It writes no
   video_jobs row; videoplus/carousel.ts keeps its own. */
export const FORMATS = ["faceless", "shorts", "ugc", "reel", "motion", "stewie", "carousel"] as const;
export type Format = (typeof FORMATS)[number];

export function readFormat(raw: string | undefined): Format {
  const v = (raw ?? "").trim().toLowerCase();
  return (FORMATS as readonly string[]).includes(v) ? (v as Format) : "faceless";
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
  /*
    A LEASE ON THIS MACHINE FOR AS LONG AS THE RENDER RUNS.

    ffmpeg, the downloads and any local model all happen HERE, and a video is
    the longest thing this box does — tens of minutes with nothing to show for
    it if the machine goes to sleep in the middle. The lease is what stops
    that: `integrations/deploy/leases.ts` refuses a sleep while any live lease
    exists, and this is the first thing on the box to take one.

    IT IS TAKEN AROUND THE WHOLE RUN AND RELEASED IN A `finally`, because the
    two ways a render ends that are NOT a return are the two that matter — a
    thrown StepError and a cancelled run. A lease left behind by either would
    hold the machine awake, which is why a lease also expires on its own; the
    heartbeat below is what keeps a genuinely long render's lease alive past
    that.
  */
  const lease = leases.acquire({
    kind: "video",
    resource: leases.LOCAL,
    ventureId: opts.venture?.id ?? null,
    note: `${readFormat(opts.input.format)} video, run ${opts.runId}`,
  });
  /* THE HEARTBEAT MUST NOT BE ABLE TO TAKE THE PROCESS DOWN. `heartbeat` is a
     synchronous UPDATE and a SQLITE_BUSY inside a bare interval callback is an
     uncaught exception, which under Node's defaults ends the process — killing
     the render this lease exists to protect. A missed beat costs nothing until
     the TTL, so swallowing it is strictly the smaller failure. */
  const beat = setInterval(() => {
    try {
      leases.heartbeat(lease.id);
    } catch (err) {
      console.error(`[video] the lease heartbeat failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 60_000);
  beat.unref?.();
  try {
    return await renderVideo(opts);
  } finally {
    clearInterval(beat);
    /* `releaseOwn` and not `release`: this IS the holder, so the
       still-beating refusal does not apply to it, and a lease that cannot be
       written back must not throw out of a `finally` and mask the run's own
       error. */
    leases.releaseOwn(lease.id, "the video run ended");
  }
}

async function renderVideo(opts: {
  runId: string;
  session: RunSession;
  venture: VentureRow | null;
  input: Record<string, string>;
  signal?: AbortSignal;
}): Promise<void> {
  const format = readFormat(opts.input.format);
  const aspect = (opts.input.aspect ?? "").trim() in ASPECTS ? opts.input.aspect!.trim() : DEFAULT_ASPECT;
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
        clips: shortsClipCount(opts.input.clips),
      },
      signal: opts.signal,
    });
  }

  if (format === "ugc") {
    /* A GUARDED DYNAMIC IMPORT and not a static one. This module is reached
       from the video manifest's own import graph, and a static import of
       another area's module would pull that area's manifest chain in with it —
       which is how "Cannot access 'MANIFESTS' before initialization" happens
       and the server does not boot. A missing socialfeed area therefore fails
       this one run with a sentence rather than the whole process. */
    let ugcVideo: typeof import("../socialfeed/ugc.ts")["ugcVideo"];
    try {
      ({ ugcVideo } = await import("../socialfeed/ugc.ts"));
    } catch (err) {
      throw new StepError(
        "input",
        `The UGC pipeline is not installed on this server (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    return ugcVideo({
      runId: opts.runId,
      session: opts.session,
      venture: opts.venture,
      input: {
        brief,
        /* Comma or space separated asset ids from the venture's library. Empty
           means "use the library", which the pipeline caps at four. */
        assets: (opts.input.assets ?? "").trim(),
        aspect,
        fit,
        seconds: clampNumber(opts.input.seconds, 5, 1, 20),
      },
      signal: opts.signal,
    });
  }

  if (format === "reel") {
    if (!opts.venture)
      throw new StepError(
        "input",
        "A walkthrough reel is a tour of a venture's own pages, so it needs a venture — its website, its record and its colours. Choose one.",
      );
    return reelVideo({
      runId: opts.runId,
      session: opts.session,
      venture: opts.venture,
      input: {
        urls: (opts.input.url ?? "").trim(),
        brief,
        /* For a reel this is the WHOLE video, and the line count follows from
           it — see reel.ts. Ten seconds is two lines and is the shortest thing
           that is still a conversation. */
        seconds: clampNumber(opts.input.seconds, 30, 10, 120),
        aspect,
        /* NO `fit` — a reel is always letterboxed. reel.ts says why, and the
           short version is that a centre crop of a web page is a walkthrough
           of two thirds of a page. */
      },
      signal: opts.signal,
    });
  }

  if (format === "stewie") {
    /* Rendered by Workdash's reel worker on the Dell, through the Pi — see
       videoplus/stewie.ts. `url` holds the pages in pages mode, as it does
       for a reel; addresses present means pages, none means images. */
    const urls = (opts.input.url ?? "").trim();
    return stewieVideo({
      runId: opts.runId,
      session: opts.session,
      venture: opts.venture,
      input: {
        prompt: brief,
        mode: urls ? "pages" : "images",
        urls,
        background: (opts.input.background ?? "").trim(),
      },
      signal: opts.signal,
    });
  }

  if (format === "carousel") {
    return carouselRun({
      runId: opts.runId,
      session: opts.session,
      venture: opts.venture,
      /* `size` is the carousel's own vocabulary (square, portrait, story,
         landscape) and not `aspect`: 4:5 is a carousel shape and not a video
         one, and ASPECTS above would quietly turn it into 9:16. */
      input: { prompt: brief, size: carouselSize(opts.input.size) },
      signal: opts.signal,
    });
  }

  if (format === "motion") {
    return motionVideo({
      runId: opts.runId,
      session: opts.session,
      venture: opts.venture,
      input: {
        specId: (opts.input.spec ?? "").trim(),
        brief,
        // A saved list keeps its shape unless the owner overrides it.
        aspect: opts.input.spec?.trim() && !opts.input.aspect?.trim() ? "" : aspect,
        /* THE SKILLS PROXY SENDS EVERY PARAMETER AS A STRING, so this is
           parsed from the two spellings a form and an agent actually send and
           is false for anything else. A truthiness check on `"false"` would
           narrate every video. */
        voiceover: ["true", "on", "1", "yes"].includes((opts.input.voiceover ?? "").trim().toLowerCase()),
      },
      signal: opts.signal,
    });
  }

  if (!opts.venture && !brief)
    throw new StepError("input", "Describe the subject of the faceless video, or choose a venture.");
  return facelessVideo({
    runId: opts.runId,
    session: opts.session,
    venture: opts.venture,
    input: {
      brief,
      seconds: opts.input.seconds?.trim() && opts.input.seconds !== "auto" ? clampNumber(opts.input.seconds, DEFAULT_SECONDS, 10, 120) : null,
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
  // Never interpret an id as a path or remove the shared thumbnail directory.
  if (!/^r-[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id for file removal.");
  // Keep all records if file removal fails, so the owner can retry. Remove
  // previews before sources; a concurrent render checks its source again
  // before saving and cannot recreate a deleted preview.
  deleteThumbnails(runId, [jobRow(runId)?.path ?? null, ...clipRows(runId).map((clip) => clip.path)]);
  rmSync(runDir(runId), { recursive: true, force: true });
  forgetJob(runId);
  forgetFraming(runId);
  forgetCarousel(runId);
  /* And the socialfeed area's UGC row, for the `ugc` format. That module
     imports db.ts and nothing else precisely so this line cannot close a
     cycle — see integrations/socialfeed/forget.ts. */
  forgetSocialfeed(runId);
}
