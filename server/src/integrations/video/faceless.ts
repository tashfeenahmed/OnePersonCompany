/**
 * THE FACELESS PIPELINE — a brief in, an mp4 out, and a receipt for every
 * piece of it.
 *
 * Seven steps, each one a step on the run page with its own label, because
 * this takes minutes and every one of those minutes is spent inside a
 * subprocess that says nothing. A progress list that went quiet for ninety
 * seconds while a 1080x1920 concat ran would be indistinguishable from a hang,
 * and the whole reason `Step` exists on a run row is so it is not.
 *
 * EVERY FAILURE NAMES ITS STEP. "Pexels rejected the stored key" and "the
 * encoder refused the caption card" are two different problems with two
 * different owners, and a run that failed with "Error" would send somebody
 * looking in the wrong place. `fail()` below is the only way out of this file
 * that is not a finished video.
 *
 * THE PIPELINE DEGRADES RATHER THAN REFUSING, ON EVERYTHING EXCEPT FOOTAGE.
 * No typesetter and no drawtext means a video with no burned captions and a
 * sentence saying so. Speech switched off means a silent video and a sentence
 * saying so. A beat whose search terms found nothing is dropped and the video
 * is one shot shorter, and the report says which beat and why. What it will
 * NOT do is produce a file while pretending it has something it does not:
 * every one of those degradations is written onto the row, into the report and
 * onto the page.
 *
 * NO FOOTAGE AT ALL IS THE ONE HARD FAILURE. A faceless video is stock footage
 * with words on it; with no clips there is nothing to put words on, and an end
 * card on its own is not a video. That case ends the run with the reason
 * Pexels gave.
 *
 * NOTHING COPYRIGHTED IS BUNDLED. There is no music bed in this repository and
 * there will not be one: a royalty-free track shipped with a dashboard is a
 * licence question the owner did not agree to and cannot audit. Sound comes
 * from the voice plugin's own endpoint if the owner turned it on, and from
 * nowhere else.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { configValue, type VentureRow } from "../../db.ts";
import { readBrand } from "../../ventures/enrich.ts";
import { settings as voiceSettings, speak } from "../signals/voice/provider.ts";
import type { Step } from "../runs/store.ts";
import { aspectFrame, blurFilter, concat, segment, still, type Fit } from "./assemble.ts";
import { pickCaptioner, stripPath, type CaptionStyle } from "./captions.ts";
import { fetchClip, pexelsKey, type Asset } from "./footage.ts";
import { END_CARD_SECONDS, writeScript, type Beat, type Script } from "./script.ts";
import { saveJob } from "./store.ts";
import { VIDEO_PLUGIN, bytesOf, ffmpegFilters, findFfmpeg, findFfprobe, probeDuration } from "./tools.ts";

/** Where every video this box makes lives, one directory per run. */
export const VIDEO_DIR = resolve(DATA_DIR, "video");

export const runDir = (runId: string) => resolve(VIDEO_DIR, runId);

/**
 * The parts of the executor's `Session` this file uses.
 *
 * A STRUCTURAL TYPE RATHER THAN AN IMPORT, because `Session` is executor.ts's
 * private working state and exporting it would make every area's pipeline a
 * dependency of the executor's internals. What a pipeline needs is the ability
 * to open a step, close it, and write a paragraph into the report; that is
 * three methods and they are named here.
 */
export type RunSession = {
  id: string;
  startStep(tool: string, label: string | null): Step;
  endStep(step: Step, label?: string | null): void;
  say(text: string): void;
};

export class StepError extends Error {
  step: string;
  constructor(step: string, message: string) {
    super(`${step}: ${message}`);
    this.name = "StepError";
    this.step = step;
  }
}

/* --------------------------------------------------------------- the run */

export type FacelessInput = {
  brief: string;
  seconds: number | null;
  aspect: string;
  fit: Fit;
};

export async function facelessVideo(opts: {
  runId: string;
  session: RunSession;
  venture: VentureRow | null;
  input: FacelessInput;
  signal?: AbortSignal;
}): Promise<void> {
  const { session: s, venture: v, input, signal } = opts;
  const frame = aspectFrame(input.aspect);
  const dir = runDir(opts.runId);
  mkdirSync(dir, { recursive: true });

  /* --------------------------------------------------------- the tools */
  const ffmpeg = findFfmpeg();
  const ffprobe = findFfprobe();
  if (!ffmpeg.path) throw new StepError("tools", ffmpeg.error ?? "no ffmpeg on this box");
  const filters = await ffmpegFilters(ffmpeg.path);
  const blur = blurFilter(filters);

  const brand = readBrand(v?.brand ?? null);
  const style: CaptionStyle = {
    width: frame.width,
    height: frame.height,
    color: v?.color ?? "#537cc4",
    /* The venture's OWN measured font, first. This is the whole reason a video
       for one business does not look like a video for another. Null where the
       site has never been read, and then the typesetter falls through its own
       list. */
    font: brand.fonts[0] ?? null,
  };

  /* ------------------------------------------------------ 1. the script */
  const scriptStep = s.startStep("script", "writing the script");
  let script: Script;
  let scriptModel: string | null = null;
  try {
    const written = await writeScript({ venture: v, brief: input.brief, seconds: input.seconds, signal });
    script = written.script;
    scriptModel = written.model;
  } catch (err) {
    s.endStep(scriptStep, "the script could not be written");
    throw new StepError("script", err instanceof Error ? err.message : String(err));
  }
  writeFileSync(resolve(dir, "script.json"), JSON.stringify(script, null, 2), "utf8");
  s.endStep(scriptStep, `${script.beats.length} shots${scriptModel ? ` · ${scriptModel}` : ""}`);

  /* ----------------------------------------------------- 2. the footage */
  const key = pexelsKey();
  if ("error" in key) throw new StepError("footage", key.error);

  const footageStep = s.startStep("footage", `finding ${script.beats.length} clips on Pexels`);
  const assets: Asset[] = [];
  const used = new Set<number>();
  /** Beats that found nothing. Dropped from the video and named in the
   *  report — a shot without footage is not a shot. */
  const dropped: { beat: Beat; why: string }[] = [];
  const shots: { beat: Beat; asset: Asset }[] = [];
  for (const [i, beat] of script.beats.entries()) {
    if (signal?.aborted) throw new StepError("footage", "the run was cancelled");
    const got = await fetchClip({
      key: key.key,
      terms: beat.terms,
      want: { width: frame.width, height: frame.height },
      /* Asked for a hair more than the beat holds, so a clip that is exactly
         the beat's length does not run out of frames on the last one. */
      minSeconds: Math.ceil(beat.seconds) + 1,
      dir,
      name: `source-${String(i + 1).padStart(2, "0")}`,
      avoid: used,
      signal,
    });
    if ("error" in got) {
      dropped.push({ beat, why: got.error });
      continue;
    }
    used.add(got.asset.id);
    assets.push(got.asset);
    shots.push({ beat, asset: got.asset });
  }
  writeFileSync(resolve(dir, "assets.json"), JSON.stringify(assets, null, 2), "utf8");
  s.endStep(footageStep, `${shots.length} of ${script.beats.length} shots found`);
  if (!shots.length)
    throw new StepError(
      "footage",
      `no clip was found for any of the ${script.beats.length} shots. ${dropped[0]?.why ?? ""}`.trim(),
    );

  /* --------------------------------------------------- 3. the narration */
  const voice = voiceSettings();
  let narration: string = `none — speech is ${voice.tts === "off" ? "switched off in the voice plugin's settings" : "configured but was not used"}, so the video has no sound.`;
  const voices = new Map<number, string>();
  if (voice.tts !== "off") {
    const speakStep = s.startStep("narration", `speaking ${shots.length} lines`);
    let failed: string | null = null;
    for (const [i, shot] of shots.entries()) {
      try {
        const clip = await speak(shot.beat.voiceover);
        voices.set(i, clip.path);
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    /* ALL OR NOTHING, and the reason is in assemble.ts's header: the concat
       demuxer will not join a segment that has an audio track to one that does
       not. Half a narrated video is not a thing this can produce, so a single
       failure drops the sound from the whole video and says which line broke. */
    if (failed) {
      const spoke = voices.size;
      voices.clear();
      narration = `none — the voice endpoint stopped after ${spoke} of ${shots.length} lines (${failed}), and a video cannot have sound on some shots and not others.`;
      s.endStep(speakStep, "no narration — the voice endpoint refused");
    } else {
      narration = `spoken by the voice plugin's ${voice.tts} endpoint, one clip per shot.`;
      s.endStep(speakStep, `${voices.size} lines spoken`);
    }
  }
  const narrated = voices.size === shots.length && voices.size > 0;

  /* ----------------------------------------------------- 4. the captions */
  const captioner = await pickCaptioner();
  const capStep = s.startStep("captions", `setting ${shots.length} caption cards with ${captioner.id}`);
  const strips = new Map<number, string>();
  if (captioner.id === "typst") {
    for (const [i, shot] of shots.entries()) {
      const png = await captioner.strip(shot.beat.caption, style, stripPath(dir, i + 1), signal);
      if (png) strips.set(i, png);
    }
  }
  s.endStep(
    capStep,
    captioner.id === "none"
      ? "no captions — see the report"
      : captioner.id === "typst"
        ? `${strips.size} cards set`
        : "burned in by ffmpeg",
  );

  /* ----------------------------------------------------- 5. the segments */
  const segStep = s.startStep("assemble", `cutting ${shots.length} shots to ${frame.width}x${frame.height}`);
  const parts: string[] = [];
  for (const [i, shot] of shots.entries()) {
    if (signal?.aborted) throw new StepError("assemble", "the run was cancelled");
    const out = resolve(dir, `seg-${String(i + 1).padStart(2, "0")}.mp4`);
    const strip = strips.get(i);
    const res = await segment({
      ffmpeg: ffmpeg.path,
      source: shot.asset.path,
      out,
      start: 0,
      seconds: shot.beat.seconds,
      width: frame.width,
      height: frame.height,
      fit: input.fit,
      blur,
      pad: v?.color ?? "#537cc4",
      overlays: strip ? [{ png: strip, from: null, to: null }] : [],
      drawtext: captioner.expr(shot.beat.caption, style),
      audio: narrated ? (voices.get(i) ?? null) : null,
      silentTrack: false,
      signal,
    });
    if (!res.ok) {
      s.endStep(segStep, `shot ${i + 1} could not be cut`);
      throw new StepError("assemble", `shot ${i + 1} (${shot.beat.caption}) — ${res.error}`);
    }
    parts.push(res.path);
  }
  s.endStep(segStep, `${parts.length} shots cut`);

  /* ----------------------------------------------------- 6. the end card */
  let endCard: string | null = null;
  if (v) {
    const cardStep = s.startStep("endcard", `${v.name}`);
    const cardPng = await captioner.endCard(
      [v.name, v.host ?? v.website ?? ""],
      style,
      resolve(dir, "endcard.png"),
      signal,
    );
    if (cardPng) {
      const res = await still({
        ffmpeg: ffmpeg.path,
        png: cardPng,
        out: resolve(dir, "seg-end.mp4"),
        seconds: END_CARD_SECONDS,
        width: frame.width,
        height: frame.height,
        silentTrack: narrated,
        signal,
      });
      if (res.ok) {
        endCard = res.path;
        parts.push(res.path);
      }
    }
    s.endStep(cardStep, endCard ? "end card added" : "no end card — nothing on this box can draw one");
  }

  /* --------------------------------------------------------- 7. the file */
  const encStep = s.startStep("encode", `joining ${parts.length} shots`);
  const final = resolve(dir, "final.mp4");
  const joined = await concat({ ffmpeg: ffmpeg.path, parts, out: final, dir, hasAudio: narrated, signal });
  if (!joined.ok) {
    s.endStep(encStep, "the join failed");
    throw new StepError("encode", joined.error);
  }
  const duration = ffprobe.path ? await probeDuration(ffprobe.path, final, signal) : null;
  const bytes = bytesOf(final);
  s.endStep(
    encStep,
    `${duration ? `${duration.toFixed(1)}s` : "length unread"} · ${bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "size unread"}`,
  );

  /* The intermediates. Kept or swept by a setting, because they are the only
     way to work out why a shot looks wrong and they are also a couple of
     hundred megabytes per video. Swept by default; the caption cards stay
     because they are kilobytes and they are the thing most worth looking at. */
  if ((configValue(VIDEO_PLUGIN, "keep") ?? "").trim().toLowerCase() !== "on") sweep(dir, parts, assets);

  saveJob({
    runId: opts.runId,
    ventureId: v?.id ?? null,
    format: "faceless",
    aspect: input.aspect,
    width: frame.width,
    height: frame.height,
    script,
    assets,
    durationS: duration,
    bytes,
    path: final,
    captions: captioner.id,
    narration: narrated ? "tts" : "none",
    transcript: null,
    error: dropped.length ? `${dropped.length} of ${script.beats.length} shots had no footage and were dropped.` : null,
  });

  s.say(report({ venture: v, script, shots, dropped, assets, frame, duration, bytes, captioner: captioner.note, narration, endCard: !!endCard }));
}

/** The raw downloads and the per-shot segments. `final.mp4`, `script.json`,
 *  `assets.json` and the caption cards stay. */
function sweep(dir: string, parts: string[], assets: Asset[]) {
  for (const p of [...parts, ...assets.map((a) => a.path)]) {
    if (!p.startsWith(dir)) continue;
    try {
      rmSync(p, { force: true });
    } catch {
      /* A file that will not delete costs disk, not the video. */
    }
  }
  const list = resolve(dir, "concat.txt");
  if (existsSync(list)) rmSync(list, { force: true });
}

/* -------------------------------------------------------------- the note */

/**
 * WHAT THE RUN'S `output` IS FOR A VIDEO, and it is not the report shape the
 * six document kinds use.
 *
 * A research run's output IS the work. A video run's output is a NOTE ABOUT a
 * file — the same relationship a paper run has to its PDF — so it leads with
 * what was made, then the script, then the credits, then what did not happen.
 * The credits are in the note as well as on the row because the note is what
 * gets copied out of this box, and a credit that only exists in a database is
 * not a credit.
 */
function report(ctx: {
  venture: VentureRow | null;
  script: Script;
  shots: { beat: Beat; asset: Asset }[];
  dropped: { beat: Beat; why: string }[];
  assets: Asset[];
  frame: { width: number; height: number };
  duration: number | null;
  bytes: number | null;
  captioner: string;
  narration: string;
  endCard: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`## ${ctx.script.title}`);
  lines.push("");
  lines.push(
    `A ${ctx.frame.width}×${ctx.frame.height} video${ctx.venture ? ` for **${ctx.venture.name}**` : ""}, ` +
      `${ctx.duration ? `${ctx.duration.toFixed(1)} seconds` : "of a length this box could not read"} long, ` +
      `${ctx.shots.length} shots${ctx.endCard ? " and an end card" : ""}. ` +
      `The file is on the run page above; nothing has been published anywhere.`,
  );
  lines.push("");
  lines.push(`## The script`);
  lines.push("");
  for (const [i, shot] of ctx.shots.entries()) {
    const role = shot.beat.role === "hook" ? "Hook" : shot.beat.role === "cta" ? "Call to action" : `Beat ${i}`;
    lines.push(`**${role} — ${shot.beat.seconds.toFixed(1)}s**`);
    lines.push("");
    lines.push(`> ${shot.beat.caption}`);
    lines.push("");
    if (shot.beat.voiceover !== shot.beat.caption) lines.push(`${shot.beat.voiceover}`);
    lines.push(`*Searched for: ${shot.beat.terms.join(", ")} — used “${shot.asset.term}”.*`);
    lines.push("");
  }

  lines.push(`## Footage, and who to credit`);
  lines.push("");
  lines.push(`| Shot | Clip | Author | Licence |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const [i, shot] of ctx.shots.entries())
    lines.push(
      `| ${i + 1} | [${shot.asset.width}×${shot.asset.height}, ${shot.asset.duration}s](${shot.asset.page}) | ` +
        `[${shot.asset.author}](${shot.asset.authorUrl}) | ${shot.asset.licence} |`,
    );
  lines.push("");
  lines.push(
    `Every clip above is from Pexels under its own licence, which permits commercial use and asks for the photographer to be credited. That credit is this table — copy it with the video.`,
  );
  lines.push("");

  lines.push(`## How it was made`);
  lines.push("");
  lines.push(`- Captions: ${ctx.captioner}`);
  lines.push(`- Narration: ${ctx.narration}`);
  lines.push(
    `- Music: none. Nothing copyrighted is bundled with this dashboard, so a video made here is silent unless the voice plugin's speech endpoint is switched on.`,
  );
  if (!ctx.endCard)
    lines.push(`- End card: none. Neither a typesetter nor an ffmpeg that can draw text was found on this machine.`);
  if (ctx.dropped.length) {
    lines.push("");
    lines.push(`## Shots that were dropped`);
    lines.push("");
    for (const d of ctx.dropped) lines.push(`- **${d.beat.caption}** — ${d.why}`);
    lines.push("");
    lines.push(
      `Those beats are not in the video. The script above is what was actually cut, not what was written.`,
    );
  }
  return lines.join("\n");
}
