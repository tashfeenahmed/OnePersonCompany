/**
 * THE SHORTS PIPELINE — a long video in, two to four vertical clips out.
 *
 * THE ONLY THING THAT MAKES THIS BETTER THAN CUTTING AT RANDOM IS THE
 * TRANSCRIPT, and that is why three quarters of this file is about getting
 * one. A model asked which minute of an hour-long video is the good minute,
 * with nothing but the duration to go on, will answer — fluently, with
 * reasons, and arbitrarily. So the windows are chosen from words that were
 * actually said, and where there are no such words this cuts at EVEN INTERVALS
 * and writes `chosen_by: "spacing"` on every row, which is the difference
 * between a tool and a slot machine.
 *
 * THREE WAYS TO A TRANSCRIPT, in this order:
 *
 *   subtitles  yt-dlp asks the site for them. YouTube has them for almost
 *              everything, automatic or otherwise, and they arrive already
 *              timed — which is the expensive half. Free, instant, and the
 *              right answer when it works.
 *   speech     The voice plugin's transcription endpoint, if the owner has
 *              set one. The audio is stripped to mono 16 kHz mp3 first, which
 *              is what those endpoints want and a tenth of the bytes. This
 *              costs whatever that endpoint costs and is only done because the
 *              owner already connected it for the Telegram bridge.
 *   nothing    Both absent. The run says so in one sentence, cuts at even
 *              intervals, and marks every clip as having been chosen by
 *              spacing rather than by content.
 *
 * A TRANSCRIPTION ENDPOINT RETURNS ONE STRING WITH NO TIMES IN IT, and that
 * matters: it can tell the model WHAT was said and cannot tell it WHEN. So
 * that path feeds the model a transcript with no timestamps and asks for
 * windows anyway — which is weaker than the subtitle path and is recorded as
 * `chosen_by: "speech"` rather than `transcript`, because a reader is entitled
 * to know which of the two they are looking at.
 *
 * THE SOURCE IS NOT KEPT. A downloaded video is somebody else's copyrighted
 * work and this box has no business holding a library of it; it is deleted the
 * moment the clips are cut, and the row records the URL rather than the file.
 * The clips themselves are kept because they are what the run produced.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { configValue, type VentureRow } from "../../db.ts";
import { readBrand } from "../../ventures/enrich.ts";
import { settings as voiceSettings, transcribe } from "../signals/voice/provider.ts";
import { aspectFrame, blurFilter, extractAudio, segment, wavForSpeech, type Fit, type Track } from "./assemble.ts";
import { pickCaptioner, type CaptionStyle } from "./captions.ts";
import { StepError, runDir, type RunSession } from "./faceless.ts";
import { pickWindows, type Window } from "./script.ts";
import { saveClip, saveJob } from "./store.ts";
import {
  VIDEO_PLUGIN,
  bytesOf,
  ffmpegFilters,
  findFfmpeg,
  findFfprobe,
  findYtDlp,
  probeDuration,
  probeSize,
  run,
  tail,
} from "./tools.ts";
import {
  chooseMoments,
  findWhisper,
  linesFromWords,
  sceneCuts,
  tidyWindows,
  whisperWords,
  type Word,
} from "../videoplus/moments.ts";
import { cropXExpr, drift, motionCentroids, sampleGrey, smoothPath, visionModel } from "../videoplus/track.ts";
import { trackingOn, visionModelPath } from "../videoplus/settings.ts";
import { saveFraming } from "../videoplus/store.ts";

/** How long a source may be before this refuses to download it, unless the
 *  owner has raised it. Ninety minutes of 1080p is a couple of gigabytes and
 *  twenty minutes of somebody's connection. */
const DEFAULT_MAX_MINUTES = 90;
/** The longest a single clip may be. Every platform's own limit is at or
 *  above this and a "short" longer than it is not one. */
const MAX_CLIP_SECONDS = 90;

export type ShortsInput = {
  url: string;
  brief: string;
  seconds: number;
  aspect: string;
  fit: Fit;
  clips: number;
};

export async function shortsVideo(opts: {
  runId: string;
  session: RunSession;
  venture: VentureRow | null;
  input: ShortsInput;
  signal?: AbortSignal;
}): Promise<void> {
  const { session: s, venture: v, input, signal } = opts;
  const frame = aspectFrame(input.aspect);
  const dir = runDir(opts.runId);
  mkdirSync(dir, { recursive: true });

  const ffmpeg = findFfmpeg();
  const ffprobe = findFfprobe();
  const ytdlp = findYtDlp();
  if (!ffmpeg.path) throw new StepError("tools", ffmpeg.error ?? "no ffmpeg on this box");
  if (!ytdlp.path) throw new StepError("tools", ytdlp.error ?? "no yt-dlp on this box");
  const filters = await ffmpegFilters(ffmpeg.path);
  const blur = blurFilter(filters);

  const maxMinutes = numberSetting("maxSource", DEFAULT_MAX_MINUTES, 1, 600);
  /* EXTRA ARGUMENTS FOR yt-dlp ARE A SETTING AND NOT A CONSTANT, and the
     hint on that setting says why: what YouTube requires of a downloader
     changes every few months, the fix is always a flag, and a dashboard that
     needed a release to carry one would be broken for weeks at a time. */
  const extra = readExtraArgs();

  /* --------------------------------------------------------- 1. the probe */
  const probeStep = s.startStep("probe", "asking what is at that address");
  const meta = await run(
    ytdlp.path,
    ["--no-playlist", "--no-warnings", "--skip-download", "--dump-single-json", "--socket-timeout", "30", ...extra, input.url],
    { timeoutMs: 120_000, signal },
  );
  if (!meta.ok) {
    s.endStep(probeStep, "the address could not be read");
    throw new StepError("probe", meta.error ?? (tail(meta.stderr) || "yt-dlp would not describe that URL"));
  }
  let info: { title?: unknown; duration?: unknown; is_live?: unknown; extractor?: unknown; webpage_url?: unknown };
  try {
    info = JSON.parse(meta.stdout) as typeof info;
  } catch {
    s.endStep(probeStep, "the description was not JSON");
    throw new StepError("probe", "yt-dlp answered with something that is not JSON.");
  }
  const title = typeof info.title === "string" ? info.title : input.url;
  const sourceSeconds = typeof info.duration === "number" && info.duration > 0 ? info.duration : null;
  if (info.is_live === true) {
    s.endStep(probeStep, "that is a live stream");
    throw new StepError("probe", "That is a live stream. There is no finished video to cut up.");
  }
  /*
    A DIRECT FILE HAS NO DURATION UNTIL SOMETHING READS IT.

    yt-dlp's generic extractor — the one that handles a plain `.mp4` on
    somebody's server — answers `duration: null`, because it has not opened the
    file. The first version of this refused those outright, which made "cut up
    this video I am hosting" impossible for the commonest possible source.

    So an unknown duration is now allowed THROUGH THE PROBE and caught after
    the download, where ffprobe can read it off the file for real. What
    protects the machine in the meantime is a byte ceiling rather than a time
    one: `--max-filesize` at a generous 30 MB a minute of the configured limit,
    which yt-dlp enforces before it fetches. The minute limit itself is then
    applied to the measured duration below, and a file over it is deleted
    rather than cut up.
  */
  const unknownLength = sourceSeconds === null;
  if (sourceSeconds !== null && sourceSeconds > maxMinutes * 60) {
    s.endStep(probeStep, `${Math.round(sourceSeconds / 60)} minutes — over the limit`);
    throw new StepError(
      "probe",
      `That video is ${Math.round(sourceSeconds / 60)} minutes and the limit is ${maxMinutes}. ` +
        `Raise \`maxSource\` under the Video settings if you meant it — the limit is there because a long ` +
        `download is a long download and nobody is watching.`,
    );
  }
  s.endStep(probeStep, `${title.slice(0, 60)} · ${unknownLength ? "length not reported" : `${Math.round(sourceSeconds! / 60)} min`}`);

  /* ------------------------------------------------------ 2. the download */
  const dlStep = s.startStep(
    "download",
    unknownLength
      ? `fetching — nothing said how long it is, so this is capped at ${Math.min(2048, Math.round(maxMinutes * 30))} MB (best-effort: a fragmented download ignores that) and checked against the ${maxMinutes}-minute limit afterwards`
      : `fetching ${Math.round(sourceSeconds! / 60)} minutes`,
  );
  const dl = await run(
    ytdlp.path,
    [
      "--no-playlist", "--no-warnings", "--no-progress",
      "--socket-timeout", "30",
      /* Capped at the frame's own height. A 4K source is minutes of download
         and minutes of decode to produce a 1080-wide crop; below 1080 there is
         nothing to crop from. */
      "-f", `bv*[height<=1440]+ba/b[height<=1440]/bv*+ba/b`,
      "-S", "res:1440,vcodec:h264,acodec:aac",
      "--merge-output-format", "mp4",
      /* Subtitles if the site has any, automatic ones included. `--convert-subs`
         normalises whatever came back to WebVTT so there is one parser below
         rather than three. */
      "--write-subs", "--write-auto-subs",
      "--sub-langs", "en.*,en",
      "--convert-subs", "vtt",
      "-o", resolve(dir, "source.%(ext)s"),
      /* Only when nothing said how long it is — a known-length source has
         already been checked against the limit above, and a byte cap on top of
         that would refuse a legitimately large short video.

         THE CEILING IS CAPPED ABSOLUTELY as well as derived, because
         `maxMinutes * 30 MB` is 2,700 MB at the default ninety minutes, which
         is not a brake. Two gigabytes is.

         AND IT IS BEST-EFFORT: yt-dlp does not apply `--max-filesize` to a
         FRAGMENTED download (HLS, DASH), which is a fair share of what the
         generic extractor returns. What actually bounds those is the thirty
         minute process timeout and the duration check on the finished file
         below, which deletes it. The step text says so. */
      ...(unknownLength ? ["--max-filesize", `${Math.min(2048, Math.round(maxMinutes * 30))}M`] : []),
      ...extra,
      input.url,
    ],
    { timeoutMs: 1_800_000, signal },
  );
  const source = findFile(dir, /^source\.(mp4|mkv|webm|mov)$/);
  if (!source) {
    s.endStep(dlStep, "nothing was downloaded");
    throw new StepError("download", dl.error ?? (tail(dl.stderr) || "yt-dlp exited without writing a video file"));
  }
  const actual = ffprobe.path ? await probeDuration(ffprobe.path, source, signal) : sourceSeconds;
  const duration = actual ?? sourceSeconds;
  if (duration === null) {
    s.endStep(dlStep, "length unknown");
    rmSync(source, { force: true });
    throw new StepError(
      "download",
      "Neither the site nor ffprobe could say how long that video is, so there is no way to choose a window inside it. " +
        (ffprobe.path ? "The file was downloaded and deleted." : "There is no ffprobe on this box to read it with — set one under the Video settings."),
    );
  }
  if (duration > maxMinutes * 60) {
    s.endStep(dlStep, `${Math.round(duration / 60)} minutes — over the limit`);
    rmSync(source, { force: true });
    throw new StepError(
      "download",
      `That video turned out to be ${Math.round(duration / 60)} minutes and the limit is ${maxMinutes}. Nothing said how long it was before the download, so it was checked after. The file has been deleted.`,
    );
  }
  s.endStep(dlStep, `${((bytesOf(source) ?? 0) / 1024 / 1024).toFixed(0)} MB · ${Math.round(duration)}s`);

  /* ----------------------------------------------------- 3. the transcript */
  const trStep = s.startStep("transcript", "looking for what was said");
  let cues: Cue[] = [];
  /* WORDS WITH THEIR OWN START AND END. Empty on every path except a local
     whisper — the site's subtitles are timed per LINE and the transcription
     endpoint is not timed at all — and what having them buys is on show in two
     places below: a window can be trimmed to the last word that finished
     inside it, and windows can be chosen by arithmetic when no model answers. */
  let words: Word[] = [];
  let plain = "";
  let source_of: "subtitles" | "words" | "speech" | "none" = "none";
  let transcriptNote: string;

  const vtt = findFile(dir, /^source\..*\.vtt$/);
  if (vtt) {
    cues = readVtt(readFileSync(vtt, "utf8"));
    if (cues.length) {
      source_of = "subtitles";
      transcriptNote = `${cues.length} timed lines came from the site's own subtitles.`;
    } else {
      transcriptNote = "the site returned a subtitle file this server could not read.";
    }
  } else {
    transcriptNote = "the site published no subtitles for this video.";
  }

  /*
    A LOCAL WHISPER, IF THIS BOX HAS ONE, BEFORE THE HTTP ENDPOINT.

    The order is: the site's own subtitles (free and instant), then a local
    whisper (slow, costs nothing, and returns WORD timings, which is the best
    timing source there is), then the voice plugin's transcription endpoint
    (fast, costs money, and returns one string with no times in it), then
    nothing. Whisper is second rather than first because a subtitle file that
    already exists is minutes of this laptop that nobody has to spend.

    NO MODEL IS BUNDLED AND NONE IS DOWNLOADED. `findWhisper` wants a binary
    AND a model file the owner pointed at, and the sentence it returns when
    either is missing goes straight into the run's report.
  */
  if (!cues.length) {
    const whisper = findWhisper();
    if (whisper.path && whisper.model) {
      const wav = resolve(dir, "speech.wav");
      const stripped = await wavForSpeech({
        ffmpeg: ffmpeg.path,
        source,
        out: wav,
        maxSeconds: Math.min(duration, maxMinutes * 60),
        signal,
      });
      if (stripped.ok) {
        const got = await whisperWords({ tool: whisper, wav, dir, timeoutMs: 1_800_000, signal });
        words = got.words;
        if (words.length) source_of = "words";
        transcriptNote = `${transcriptNote} ${got.note}`;
      } else {
        transcriptNote = `${transcriptNote} The audio could not be stripped out for whisper: ${stripped.error}.`;
      }
      rmSync(wav, { force: true });
    } else {
      transcriptNote = `${transcriptNote} ${whisper.error}`;
    }
  }

  if (!cues.length && !words.length) {
    const voice = voiceSettings();
    if (voice.sttUrl.trim()) {
      const audio = resolve(dir, "audio.mp3");
      const stripped = await extractAudio({
        ffmpeg: ffmpeg.path,
        source,
        out: audio,
        maxSeconds: Math.min(duration, maxMinutes * 60),
        signal,
      });
      if (stripped.ok) {
        try {
          const got = await transcribe(new Uint8Array(readFileSync(audio)), "audio.mp3", { reader: "video_shorts" });
          plain = got.text;
          if (plain.trim()) {
            source_of = "speech";
            transcriptNote =
              `${transcriptNote} The audio was transcribed by the voice plugin's endpoint instead — ` +
              `${plain.length.toLocaleString()} characters with NO TIMESTAMPS, so the windows below were ` +
              `chosen from what was said and not from when it was said.`;
          }
        } catch (err) {
          transcriptNote = `${transcriptNote} The voice plugin's transcription endpoint was tried and refused: ${err instanceof Error ? err.message : String(err)}.`;
        }
      } else {
        transcriptNote = `${transcriptNote} The audio could not be stripped out for transcription: ${stripped.error}.`;
      }
      rmSync(audio, { force: true });
    } else {
      transcriptNote = `${transcriptNote} No transcription endpoint is configured under the voice plugin either.`;
    }
  }
  s.endStep(
    trStep,
    source_of === "subtitles"
      ? `${cues.length} subtitle lines`
      : source_of === "words"
        ? `${words.length} timed words`
        : source_of === "speech"
          ? "transcribed from the audio"
          : "no transcript",
  );

  /* --------------------------------------------------- 3b. the scene cuts */
  /*
    WHERE THE CAMERA CUT — AND ONLY WHEN IT IS WORTH THE DECODE.

    A window that starts on a cut starts cleanly, so knowing the cuts improves
    every path. What it costs is a FULL DECODE of the source: ffmpeg has to
    look at every frame to score it against the one before, and on a
    ninety-minute video that is minutes of the single run slot on this laptop.

    So it is skipped when the site's own subtitles already timed the lines.
    That is the commonest path by a long way, its windows are already anchored
    to something measured, and snapping them onto a cut as well is a refinement
    worth a fraction of a second — not minutes of a shared slot. Every other
    path pays for it, because on those the cuts are either the only structure
    there is (no transcript at all) or the difference between a clip that opens
    on a shot and one that opens mid-gesture.

    THE SKIP IS REPORTED IN THE SAME SENTENCE THE MEASUREMENT WOULD HAVE BEEN.
    "No cuts were found" and "nobody looked" are different facts.
  */
  let cuts: number[] = [];
  let cutNote: string;
  if (source_of === "subtitles") {
    cutNote =
      "Scene detection was SKIPPED. It reads every frame of the source, which is minutes of this machine on a long video, and " +
      "the site's own subtitles had already timed these lines — so the windows below were snapped to word boundaries rather than to camera cuts.";
  } else {
    const cutStepId = s.startStep("scenes", "finding the scene changes");
    const found = await sceneCuts({ ffmpeg: ffmpeg.path, source, signal });
    cuts = found.cuts;
    cutNote = found.note;
    s.endStep(cutStepId, cuts.length ? `${cuts.length} cuts` : "none found");
  }

  /* ----------------------------------------------------- 4. the highlights */
  /*
    SIX WAYS A WINDOW CAN COME TO EXIST, and `chosenBy` on every clip row says
    which one produced it. They are in descending order of how much they know:

      transcript  the site's own timed subtitles, read by a model
      words       word timings measured on this box by whisper, read by a model
      speech      a transcription with NO timestamps, read by a model
      density     word timings and arithmetic — no model answered, so the
                  densest runs of speech that start at a cut were taken
      scenes      no transcript at all, but the camera cuts were found, so the
                  windows start where the picture changed
      spacing     nothing was known, so the video was cut at even intervals

    The last three are not highlight selection and nothing downstream is
    allowed to draw them as though they were. The first three are a model's
    opinion about words it was shown, which is a different thing again and is
    also not a prediction of how a clip will perform.
  */
  const pickStep = s.startStep("highlights", "choosing the moments");
  const want = Math.max(2, Math.min(4, Math.round(input.clips || 3)));
  const maxClip = Math.max(15, Math.min(MAX_CLIP_SECONDS, Math.round(input.seconds || 45)));
  let windows: Window[] = [];
  let chosenBy: "transcript" | "words" | "speech" | "density" | "scenes" | "spacing" = "spacing";
  let pickNote: string;

  /* What the SNAPPING is allowed to move a window onto. Real word starts when
     whisper timed them; whole subtitle cues otherwise, which are a coarser but
     still measured boundary. Never both — a mixture would let a window snap to
     a boundary that was interpolated rather than measured. */
  const timed: Word[] = words.length
    ? words
    : cues.map((c) => ({ start: c.start, end: c.end, text: c.text }));

  if (source_of !== "none") {
    const text =
      source_of === "subtitles"
        ? renderCues(cues)
        : source_of === "words"
          ? linesFromWords(words)
              .map((l) => `[${Math.floor(l.start)}] ${l.text}`)
              .join("\n")
              .slice(0, 60_000)
          : plain.slice(0, 40_000);
    try {
      const picked = await pickWindows({
        transcript: text,
        duration,
        want,
        maxSeconds: maxClip,
        brief: input.brief,
        signal,
      });
      windows = picked.windows;
      chosenBy = source_of === "subtitles" ? "transcript" : source_of === "words" ? "words" : "speech";
    } catch (err) {
      pickNote = err instanceof Error ? err.message : String(err);
      windows = [];
    }
  }

  /* THE MODEL SAID ROUGHLY WHERE; THE MEASUREMENTS SAY EXACTLY. A window is
     nudged at most a second and a half onto the nearest camera cut and then
     onto the nearest word start, and its end is pulled back to the last word
     that finished inside it. Nothing is MOVED further than that: a window
     dragged half a minute to reach a cut would be a different clip. */
  let moved = 0;
  if (windows.length && (cuts.length || timed.length)) {
    const tidied = tidyWindows({ windows, cuts, words: timed, duration, maxSeconds: maxClip });
    windows = tidied.windows;
    moved = tidied.moved;
  }

  if (!windows.length && words.length) {
    /* NO MODEL ANSWERED, BUT THE WORDS ARE TIMED. Density is arithmetic and it
       is labelled as arithmetic — it finds where somebody talked fastest,
       which is often the good part and is sometimes the disclaimer. */
    const found = chooseMoments({ words, cuts, duration, want, maxSeconds: maxClip });
    if (found.length) {
      windows = found;
      chosenBy = "density";
    }
  }

  if (!windows.length && cuts.length) {
    /* NO WORDS AT ALL, BUT THE CAMERA CUTS ARE KNOWN. Starting each window at
       a real cut is strictly better than starting it at an arbitrary second,
       and it is still not highlight selection. The cuts are spread across the
       video so three clips do not all come out of the first minute. */
    const usable = cuts.filter((c) => c >= 5 && c + maxClip / 2 <= duration);
    const step = Math.max(1, Math.floor(usable.length / want));
    for (let i = 0; i < want && i * step < usable.length; i++) {
      const from = usable[i * step]!;
      const to = Math.min(duration - 1, from + maxClip);
      if (to - from < maxClip / 2) continue;
      if (windows.some((w) => from < w.end && to > w.start)) continue;
      windows.push({
        title: `${Math.floor(from / 60)}:${String(Math.floor(from % 60)).padStart(2, "0")} — from a scene change`,
        reason: "",
        start: Math.round(from * 100) / 100,
        end: Math.round(to * 100) / 100,
      });
    }
    if (windows.length) chosenBy = "scenes";
  }

  if (!windows.length) {
    /* EVEN SPACING, AND IT IS LABELLED. See the header: this is not highlight
       selection and nothing downstream is allowed to draw it as though it
       were. The windows avoid the first and last twenty seconds, which on
       almost every long video are an intro and an outro. */
    chosenBy = "spacing";
    const usable = Math.max(0, duration - 40);
    const step = usable / want;
    for (let i = 0; i < want && step > maxClip / 2; i++) {
      const start = 20 + i * step;
      windows.push({
        title: `${Math.round(start / 60)}:${String(Math.round(start % 60)).padStart(2, "0")} into the video`,
        reason: "",
        start: Math.round(start * 100) / 100,
        end: Math.round(Math.min(start + maxClip, duration - 1) * 100) / 100,
      });
    }
  }

  pickNote =
    chosenBy === "transcript"
      ? `The model read the site's own timed subtitles and chose these windows.${moved ? ` ${moved} of them were then nudged onto a scene change or a word boundary — at most a second and a half.` : ""} The reason on each one is its own sentence, not a score.`
      : chosenBy === "words"
        ? `The model read a transcript this box timed WORD BY WORD with whisper, and chose these windows.${moved ? ` ${moved} of them were then nudged onto a scene change or a word boundary — at most a second and a half — and trimmed to the last word that finished inside them.` : ""} The reason on each one is its own sentence, not a score.`
        : chosenBy === "speech"
          ? `The model read a transcript with NO timestamps and chose these windows, which is the weakest of the ways this can go.${moved ? ` ${moved} of them were nudged onto a scene change.` : ""}`
          : chosenBy === "density"
            ? `No model answered${pickNote! ? ` (${pickNote!})` : ""}, so these windows were chosen by ARITHMETIC on the word timings: the densest runs of speech that begin at a scene change. That is not a judgement about what is interesting.`
            : chosenBy === "scenes"
              ? `There was no transcript${pickNote! ? `, and no model answered (${pickNote!})` : ""}, so nothing here knows what was said. The windows begin at real SCENE CHANGES spread through the video — they are cuts that start cleanly, not highlights.`
              : source_of === "none"
                ? "No transcript existed and no scene changes were found, so no model was asked which moments are good ones. These windows are EVENLY SPACED through the video — they are cuts, not highlights, and nothing here claims otherwise."
                : `The model was given the transcript and did not return usable windows${pickNote! ? ` (${pickNote!})` : ""}, so the video was cut at even intervals instead. These are cuts, not highlights.`;

  s.endStep(pickStep, `${windows.length} windows · ${chosenBy}`);

  if (!windows.length) throw new StepError("highlights", `That video is ${Math.round(duration)}s — too short to cut ${want} clips of at least ${Math.round(maxClip / 2)}s out of.`);

  /* ---------------------------------------------------------- 5. the cuts */
  const captioner = await pickCaptioner();
  const style: CaptionStyle = {
    width: frame.width,
    height: frame.height,
    color: v?.color ?? "#888888",
    font: v ? (readBrand(v.brand).fonts[0] ?? null) : null,
  };

  /*
    THE FRAMING, AND WHY IT IS MEASURED PER CLIP RATHER THAN ONCE.

    A tracked crop follows the horizontal centre of MOTION, and where that is
    depends entirely on which forty seconds of the video you are looking at.
    So each clip gets its own sample, its own smoothed path and its own row in
    videoplus_clip_framing — and a clip whose sample found nothing moving falls
    back to the fixed centre crop with that written down beside it.

    IT ONLY APPLIES TO A CENTRE CROP. A letterbox keeps the whole picture, so
    there is nothing being thrown away for a tracker to choose between; asking
    for one and getting a moving crop would be this box overriding what the
    owner picked.
  */
  const vision = visionModel(visionModelPath());
  const size = ffprobe.path ? await probeSize(ffprobe.path, source, signal) : { width: null, height: null };
  const tracking = trackingOn() && input.fit === "cover";
  /* The widest crop with the output's aspect ratio that still fits the source,
     rounded to an even number because a yuv420p plane cannot be odd. */
  const cropH = size.height ?? 0;
  const cropW = cropH ? Math.max(2, Math.round((cropH * frame.width) / frame.height / 2) * 2) : 0;
  const roomToPan = !!size.width && cropW > 0 && cropW <= size.width - 16;

  const cutStep = s.startStep("cut", `cutting ${windows.length} clips to ${frame.width}x${frame.height}`);
  const made: { window: Window; path: string; seconds: number | null; bytes: number | null; captions: string; framing: string }[] = [];
  for (const [i, w] of windows.entries()) {
    if (signal?.aborted) throw new StepError("cut", "the run was cancelled");
    const seconds = Math.max(5, w.end - w.start);

    let track: Track | null = null;
    let framingMode = "fixed";
    let detector = "none";
    let samples: number | null = null;
    let travelled: number | null = null;
    let framingNote: string;
    if (!tracking) {
      framingNote =
        input.fit === "letterbox"
          ? "Letterbox keeps the whole picture, so there is nothing to follow — the frame shows everything the source showed."
          : "Subject tracking is switched off under the Video extras settings, so this is a FIXED CENTRE CROP: anything outside the middle of the source is not in this clip.";
    } else if (!roomToPan) {
      framingNote = size.width
        ? `The source is ${size.width}×${size.height}, which is barely wider than the output's own shape, so there is nothing to pan across and the crop is fixed.`
        : "The source's dimensions could not be read, so the crop is the fixed centre one.";
    } else {
      const sample = await sampleGrey({ ffmpeg: ffmpeg.path, source, start: w.start, seconds, signal });
      if ("error" in sample) {
        framingNote = `The motion sample failed (${sample.error}), so this is a FIXED CENTRE CROP.`;
      } else {
        const centres = motionCentroids(sample.bytes, sample.frames);
        const measured = centres.filter((c) => c !== null).length;
        if (!measured) {
          framingNote = `Nothing moved enough to measure across ${sample.frames} sampled frames, so this is a FIXED CENTRE CROP.`;
        } else {
          const path = smoothPath({ centroids: centres, srcWidth: size.width!, cropWidth: cropW });
          const maxX = Math.max(0, size.width! - cropW);
          track = { cropW, cropH, x: cropXExpr(path, maxX), y: "0" };
          framingMode = "tracked";
          detector = "motion";
          samples = measured;
          travelled = drift(path);
          framingNote =
            `The crop window followed the horizontal centre of MOTION, measured on ${measured} of ${centres.length} sampled frame pairs and smoothed; ` +
            `it travelled ${travelled} source pixels. This is not face tracking — ${vision.found ? "a vision model is configured but this pipeline does not use it yet" : "there is no vision model on this box"}.`;
        }
      }
    }

    /* THE CAPTIONS ARE THE SOURCE'S OWN WORDS AND ONLY WHERE THEY ARE TIMED.
       A transcript with no timestamps cannot be burned onto a clip at the
       right moment, and burning it at the wrong moment is worse than burning
       nothing — so the speech path produces clips with no captions and the
       report says which path it took. Word timings measured here are as
       burnable as the site's own subtitles, and are grouped the same way. */
    const inWindow =
      source_of === "subtitles"
        ? groupCues(cues, w.start, w.end)
        : source_of === "words"
          ? groupCues(linesFromWords(words), w.start, w.end)
          : [];
    const overlays: { png: string; from: number; to: number }[] = [];
    if (captioner.id === "typst")
      for (const [j, g] of inWindow.entries()) {
        const png = await captioner.strip(g.text, style, resolve(dir, `cap-${i + 1}-${String(j + 1).padStart(2, "0")}.png`), signal);
        if (png) overlays.push({ png, from: Math.max(0, g.start - w.start), to: Math.min(seconds, g.end - w.start) });
      }

    const out = resolve(dir, `clip-${String(i + 1).padStart(2, "0")}.mp4`);
    const res = await segment({
      ffmpeg: ffmpeg.path,
      source,
      out,
      start: w.start,
      seconds,
      width: frame.width,
      height: frame.height,
      fit: input.fit,
      blur,
      pad: v?.color ?? "#111111",
      overlays,
      /* drawtext cannot be timed per cue without one filter per cue and a
         graph nobody can debug, so on a drawtext box a clip carries the
         window's title rather than a rolling transcript. Stated in the note. */
      drawtext: captioner.id === "drawtext" ? captioner.expr(w.title, style) : null,
      track,
      audio: null,
      silentTrack: false,
      signal,
    });
    if (!res.ok) {
      s.endStep(cutStep, `clip ${i + 1} could not be cut`);
      throw new StepError("cut", `clip ${i + 1} (${w.title}) — ${res.error}`);
    }
    const cut = ffprobe.path ? await probeDuration(ffprobe.path, out, signal) : null;
    const captions = overlays.length
      ? `${overlays.length} lines from ${source_of === "words" ? "the words this box timed" : "the subtitles"}, set by typst`
      : captioner.id === "drawtext"
        ? "the window's title, drawn by ffmpeg"
        : "none";
    made.push({ window: w, path: out, seconds: cut, bytes: bytesOf(out), captions, framing: framingNote });
    saveFraming({
      run_id: opts.runId,
      idx: i + 1,
      mode: framingMode,
      detector,
      samples,
      drift_px: travelled,
      note: framingNote,
    });
    saveClip({
      runId: opts.runId,
      idx: i + 1,
      title: w.title,
      reason: w.reason || null,
      chosenBy,
      startS: w.start,
      endS: w.end,
      durationS: cut,
      path: out,
      bytes: bytesOf(out),
      captions,
    });
  }
  s.endStep(cutStep, `${made.length} clips written`);

  /* THE SOURCE GOES. See the header — this box does not keep a library of
     other people's video. The subtitle file goes with it; its contents are on
     the row. */
  rmSync(source, { force: true });
  if (vtt) rmSync(vtt, { force: true });

  saveJob({
    runId: opts.runId,
    ventureId: v?.id ?? null,
    format: "shorts",
    aspect: input.aspect,
    width: frame.width,
    height: frame.height,
    script: { source: input.url, title, sourceSeconds: duration, chosenBy, windows, cuts: cuts.length, wordTimed: words.length > 0 },
    assets: [],
    durationS: made.reduce((sum, m) => sum + (m.seconds ?? 0), 0) || null,
    bytes: made.reduce((sum, m) => sum + (m.bytes ?? 0), 0) || null,
    /* NO `path` ON A SHORTS JOB. There is no single file — there are two to
       four of them, each on its own row — and a column pointing at one of them
       would make `/api/video/<id>/file` answer with an arbitrary clip. */
    path: null,
    captions: captioner.id,
    narration: "the source's own audio, kept as it was",
    transcript:
      source_of === "subtitles"
        ? renderCues(cues).slice(0, 200_000)
        : source_of === "words"
          ? linesFromWords(words)
              .map((l) => `[${Math.floor(l.start)}] ${l.text}`)
              .join("\n")
              .slice(0, 200_000)
          : plain.slice(0, 200_000) || null,
    error: null,
  });

  s.say(
    shortsReport({
      title,
      url: input.url,
      duration,
      made,
      chosenBy,
      transcriptNote,
      pickNote,
      cutNote,
      visionNote: vision.note,
      captioner: captioner.note,
      frame,
    }),
  );
}

/**
 * The owner's extra yt-dlp arguments, with the four command-running flags
 * dropped.
 *
 * THE SAME DENY-LIST IS IN THE SETTING'S `check` and it is repeated here on
 * purpose. The check runs when somebody saves; this runs when somebody
 * downloads, and the two are not the same moment — a value written before the
 * check existed, or restored from a backup, or edited into the database by
 * hand, has never been through it. Filtering at the point of USE is the one
 * that decides what actually reaches `execFile`.
 *
 * It is a guard rail rather than a boundary and the setting's hint says so:
 * anything that can write this row can already write anything else here.
 */
export function filterYtdlpArgs(args: string[]): string[] {
  const banned = ["--exec", "--exec-before-download", "--downloader", "--external-downloader"];
  return args.filter((a) => !banned.includes(a.split("=")[0]!.toLowerCase()));
}

const readExtraArgs = () =>
  filterYtdlpArgs((configValue(VIDEO_PLUGIN, "ytdlpArgs") ?? "").trim().split(/\s+/).filter(Boolean)).slice(0, 20);

const numberSetting = (key: string, fallback: number, lo: number, hi: number) => {
  const raw = (configValue(VIDEO_PLUGIN, key) ?? "").trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

function findFile(dir: string, pattern: RegExp): string | null {
  try {
    const name = readdirSync(dir).find((f) => pattern.test(f));
    return name ? resolve(dir, name) : null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- WebVTT */

export type Cue = { start: number; end: number; text: string };

/**
 * A WebVTT file, read.
 *
 * TWENTY LINES RATHER THAN A DEPENDENCY, and the format earns that: a cue is a
 * timing line with `-->` in it followed by one or more text lines, separated
 * by blank lines. Everything else — the WEBVTT header, NOTE blocks, STYLE
 * blocks, cue identifiers — is skipped by the same rule, which is that a block
 * with no timing line is not a cue.
 *
 * YOUTUBE'S AUTOMATIC CAPTIONS REPEAT THEMSELVES, and that is the one thing
 * this has to handle beyond the spec: the rolling two-line display is encoded
 * as overlapping cues where each one restates the previous line. Consecutive
 * cues whose text is a prefix of the next are collapsed, which turns forty
 * minutes of duplicated fragments into readable sentences.
 */
export function readVtt(raw: string): Cue[] {
  const out: Cue[] = [];
  for (const block of raw.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0) continue;
    const m = /(\d{1,2}:)?(\d{1,2}):(\d{1,2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2}[.,]\d{1,3})/.exec(
      lines[timing]!,
    );
    if (!m) continue;
    const start = clock(m[1], m[2]!, m[3]!);
    const end = clock(m[4], m[5]!, m[6]!);
    const text = lines
      .slice(timing + 1)
      /* Inline tags — <c>, <00:00:01.000>, <v Speaker> — are display
         instructions and not words. Entities are the four VTT escapes. */
      .map((l) => l.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && (text.startsWith(prev.text) || prev.text.endsWith(text))) {
      /* The rolling-caption duplicate. The later cue wins its text and the
         pair keeps the earlier start, which is when the first word of it was
         actually said. */
      prev.end = end;
      if (text.length > prev.text.length) prev.text = text;
      continue;
    }
    out.push({ start, end, text });
  }
  return out;
}

const clock = (h: string | undefined, m: string, s: string) =>
  Number((h ?? "0").replace(":", "")) * 3600 + Number(m) * 60 + Number(s.replace(",", "."));

/** The transcript as the model reads it: one line per cue with the second it
 *  starts, so a window it names can be checked against the text it named. */
export function renderCues(cues: Cue[]): string {
  return cues.map((c) => `[${Math.floor(c.start)}] ${c.text}`).join("\n");
}

/**
 * The cues inside one window, grouped into caption cards.
 *
 * ONE CARD PER CUE WOULD FLICKER — automatic captions run two or three words
 * at a time — so cues are accumulated until they reach a readable length or
 * about two and a half seconds, whichever comes first, and the card holds for
 * the span of everything in it.
 */
export function groupCues(cues: Cue[], from: number, to: number, maxChars = 70, maxSeconds = 2.6): Cue[] {
  const out: Cue[] = [];
  let cur: Cue | null = null;
  for (const c of cues) {
    if (c.end <= from || c.start >= to) continue;
    const start = Math.max(c.start, from);
    const end = Math.min(c.end, to);
    if (cur && cur.text.length + 1 + c.text.length <= maxChars && end - cur.start <= maxSeconds) {
      cur.text += ` ${c.text}`;
      cur.end = end;
      continue;
    }
    cur = { start, end, text: c.text };
    out.push(cur);
  }
  return out.slice(0, 60);
}

/* -------------------------------------------------------------- the note */

function shortsReport(ctx: {
  title: string;
  url: string;
  duration: number;
  made: { window: Window; seconds: number | null; bytes: number | null; captions: string; framing: string }[];
  chosenBy: string;
  transcriptNote: string;
  pickNote: string;
  cutNote: string;
  visionNote: string;
  captioner: string;
  frame: { width: number; height: number };
}): string {
  const lines: string[] = [];
  lines.push(`## ${ctx.made.length} clips from “${ctx.title}”`);
  lines.push("");
  lines.push(
    `Cut from [${ctx.url}](${ctx.url}), ${Math.round(ctx.duration)} seconds long, to ${ctx.frame.width}×${ctx.frame.height}. ` +
      `Each clip is its own file on the run page. Nothing has been published anywhere.`,
  );
  lines.push("");
  lines.push(`## The clips`);
  lines.push("");
  for (const [i, m] of ctx.made.entries()) {
    lines.push(`**${i + 1}. ${m.window.title}** — ${stamp(m.window.start)} to ${stamp(m.window.end)}${m.seconds ? ` (${m.seconds.toFixed(1)}s)` : ""}`);
    lines.push("");
    if (m.window.reason) lines.push(`> ${m.window.reason}`);
    else lines.push(`> No reason — this window was not chosen from content. See below.`);
    lines.push("");
    lines.push(`*Captions: ${m.captions}.*`);
    lines.push("");
    lines.push(`*Framing: ${m.framing}*`);
    lines.push("");
  }
  lines.push(`## How the windows were chosen`);
  lines.push("");
  lines.push(`- Transcript: ${ctx.transcriptNote}`);
  lines.push(`- Scene changes: ${ctx.cutNote}`);
  lines.push(`- Windows: ${ctx.pickNote}`);
  lines.push(`- \`chosenBy\` on every clip row is **${ctx.chosenBy}**.`);
  lines.push(`- Captions: ${ctx.captioner}`);
  lines.push("");
  lines.push(`## How the frame was chosen`);
  lines.push("");
  lines.push(ctx.visionNote);
  lines.push("");
  lines.push(
    `Each clip's own framing is written above it and on its row. A **fixed** crop is the middle of the source and nothing else — whatever was at the edges is not in the clip. A **tracked** crop moved with measured motion, which is a real improvement on a wide shot and is still not a face detector.`,
  );
  lines.push("");
  lines.push(
    `## The source\n\nThe downloaded video was deleted as soon as the clips were cut. This dashboard does not keep a copy of somebody else's video, and it makes no claim about whether you are entitled to publish clips of it — that is a licensing question about the source, and it is yours.`,
  );
  return lines.join("\n");
}

const stamp = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
