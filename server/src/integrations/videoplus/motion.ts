/**
 * THE MOTION PIPELINE — a scene spec in, an mp4 out, and every frame accounted
 * for.
 *
 * NO REMOTION. templates.ts says why at length; the short version is that a
 * React render toolchain is a hundred megabytes of dependency to draw six
 * words on a coloured background, and this server has no build step to hang it
 * off. What replaces it is the browser this box already uses for venture
 * screenshots, driven a sheet of frames at a time.
 *
 * THE RENDER IS BOUNDED BEFORE IT STARTS AND THE BOUND IS ARITHMETIC THE OWNER
 * CAN CHECK. Scenes × seconds × frames a second, divided by the tiles that fit
 * in one screenshot, is the number of browser launches — and a browser launch
 * on this machine is about two and a half seconds. That number is reported in
 * the first step of the run, so a spec that is going to take four minutes says
 * so before it takes four minutes rather than after.
 *
 * WHAT FAILS AND WHAT DEGRADES. No browser is fatal: there is no other way to
 * draw these frames and a motion video with no frames is not a video. No
 * `untile` in this ffmpeg build is fatal for the same reason — a sheet that
 * cannot be cut apart is eight frames of nothing. Everything else degrades and
 * says so: no speech endpoint means a silent video, a scene whose narration
 * failed gets a silent track rather than sinking the whole file, and a spec
 * that came back from the model with problems is rendered as the CLAMPED
 * version with the problems on the run page.
 */
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { VentureRow } from "../../db.ts";
import { complete } from "../../models/provider.ts";
import { readModelJson } from "./json.ts";
import { settings as voiceSettings, speak } from "../signals/voice/provider.ts";
import { ASPECTS, aspectFrame, concat, fromFrames, hasUntile, untileSheet } from "../video/assemble.ts";
import { sceneTiming } from "../video/timing.ts";
export { sceneTiming, type SceneTiming } from "../video/timing.ts";
import { StepError, runDir, type RunSession } from "../video/faceless.ts";
import { saveJob } from "../video/store.ts";
import { bytesOf, ffmpegFilters, findFfmpeg, findFfprobe, probeDuration } from "../video/tools.ts";
import { findBrowser, shootSheet, tilesPerSheet } from "./chrome.ts";
import { lookOf, sheetHtml, type Tile } from "./templates.ts";
import {
  readSceneSpec,
  specLines,
  specSeconds,
  type SceneSpec,
  type SpecLimits,
} from "./scenespec.ts";
import { motionFps, specLimits } from "./settings.ts";
import { makePreviewDir, readSpecRow, specRow, sweepPreviews } from "./store.ts";

export type MotionInput = {
  specId: string;
  brief: string;
  aspect: string;
  voiceover: boolean;
};

/* --------------------------------------------------------------- the spec */

/**
 * A scene spec written by the model, from a brief and a venture.
 *
 * IT GOES TO THE RAW PROVIDER, not to an agent, for script.ts's reason: this
 * turn wants ONE JSON OBJECT and nothing else, and an agent asked for an
 * artefact writes it to a file and reports that it did.
 *
 * THE FORBIDDEN THING IS A NUMBER. A `stat` scene is a claim in 200-point type
 * and this box knows a venture's name, its sentence, its stage and its
 * address — not its revenue, its user count or its uptime. So the brief says
 * so twice and says what to do instead: with no number given, write no stat
 * scene.
 */
export async function writeSceneSpec(opts: {
  venture: VentureRow | null;
  brief: string;
  aspect: string;
  limits: SpecLimits;
  signal?: AbortSignal;
}): Promise<{ raw: unknown; model: string | null; text: string }> {
  const system = [
    `You write SHORT MOTION-GRAPHICS VIDEOS: five or six cards of typography, one idea each, read on a phone with the sound off.`,
    ``,
    `ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE. No preamble, no markdown fence, no explanation.`,
    `Do not output reasoning or planning. Put the complete scene list in the final answer immediately.`,
    ``,
    `{`,
    `  "title": "a short working name for this video",`,
    `  "scenes": [ … ]`,
    `}`,
    ``,
    `A SCENE IS ONE OF EXACTLY FIVE KINDS. Any other value for "kind" is thrown away.`,
    ``,
    `  {"kind":"title","title":"under 9 words","subtitle":"one short line, optional","kicker":"tiny label above, optional","say":"what a narrator would read","seconds":3.2}`,
    `  {"kind":"stat","value":"73","unit":"%","label":"what the number is","note":"one line of context, optional","say":"…","seconds":3.4}`,
    `  {"kind":"compare","heading":"optional","left":{"label":"Before","value":"short","points":["up to 3 short points"]},"right":{"label":"After","value":"short","points":["…"]},"say":"…","seconds":4.5}`,
    `  {"kind":"list","heading":"short heading","items":["3 to 5 short items"],"say":"…","seconds":5}`,
    `  {"kind":"cta","headline":"under 8 words","action":"the two or three words on the button","url":"https://…","say":"…","seconds":3}`,
    ``,
    `THE RULES, all binding:`,
    `- Between 4 and ${opts.limits.maxScenes} scenes. Open with a "title" scene and end with a "cta" scene.`,
    `- Use each kind at most twice.`,
    `- \`seconds\` is between ${opts.limits.minSceneSeconds} and ${opts.limits.maxSceneSeconds}, and the whole video must come to less than ${opts.limits.maxTotalSeconds}.`,
    `- Every string is read in about a second. No sentence on a card runs past nine words.`,
    `- \`say\` is what a narrator would read over that card. One sentence. It carries the argument; the card carries the words somebody reads.`,
    `- NEVER INVENT A NUMBER. You are told this business's name, the sentence its owner wrote, its stage and its address. You are NOT told its revenue, its customers, its funding or its results. IF THE BRIEF GIVES YOU NO NUMBER, WRITE NO "stat" SCENE — a stat card is a claim in enormous type and the owner would have to go and make it true.`,
    `- A business at stage "idea" or "pre-launch" has no customers and no results. Do not imply either.`,
    `- No emoji, no hashtags, no quotation marks, no line breaks inside a string.`,
    `- Plain words. No "unlock", no "revolutionise", no "game-changer".`,
  ].join("\n");

  const v = opts.venture;
  const user = [
    `THE BUSINESS`,
    v ? `Name: ${v.name}` : `No venture was chosen, so write for the subject in the brief alone.`,
    ...(v
      ? [
          `What it is: ${v.description || "(the owner has not written a sentence for it)"}`,
          `Stage: ${v.stage}`,
          `Address: ${v.website || "(none recorded)"}`,
        ]
      : []),
    ``,
    `WHAT THIS VIDEO IS ABOUT`,
    opts.brief.trim() || `Nothing in particular was singled out — make the case for ${v?.name ?? "it"} to somebody who has never heard of it.`,
    ``,
    `Write the JSON object now.`,
  ].join("\n");

  // Workdash gave its spec writer one correction attempt. Keep both attempts
  // on the shared provider so cancellation and model budgets still apply.
  let feedback = "";
  let lastText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    opts.signal?.throwIfAborted();
    /* ROOM TO THINK AND STILL ANSWER. A scene list is a few hundred tokens of
       JSON, so 8192 is not about the answer being long — it is about the answer
       arriving at all. `jsonObject` asks the router to turn optional thinking
       off, but a model whose reasoning is not optional spends it first anyway,
       and on the workspace's 4096 default that left run r-c4k493 with a full
       charge and no JSON. runtime/budgets.ts clamps the figure and reserves it,
       so the larger ask is visible to the budget rather than hidden from it. */
    const reply = await complete([
      { role: "system", content: system },
      { role: "user", content: feedback ? `${user}\n\nYour previous answer was rejected: ${feedback}. Send a complete, corrected JSON object only, with no reasoning.` : user },
    ], { signal: opts.signal, jsonObject: true, maxOutputTokens: 8192 });
    lastText = reply.text;
    const raw = readModelJson(reply.text, "scenes");
    const checked = readSceneSpec(raw, opts.limits);
    if (checked.spec) return { raw, model: reply.model, text: reply.text };
    feedback = checked.problems.join(" ").slice(0, 600);
  }
  /* The reply travels with the refusal so the report can show it. "This is not
     an object" about text nobody kept is a failure nobody can diagnose. */
  throw Object.assign(
    new Error(`The model could not produce a usable scene list after two attempts. ${feedback} No rendering was started.`),
    { modelReply: lastText },
  );
}



/* ------------------------------------------------------------- the frames */

export type SheetPlan = { sheets: number; frames: number; tiles: number };

/** What a spec is going to cost, before anything is spawned. Pure, so the
 *  editor page can show it and a test can check it. */
export function plan(spec: SceneSpec, fps: number, size: { width: number; height: number }): SheetPlan {
  const tiles = tilesPerSheet(size.width, size.height);
  const frames = spec.scenes.reduce((n, s) => n + Math.max(1, Math.round(s.seconds * fps)), 0);
  return { tiles, frames, sheets: Math.ceil(frames / tiles) };
}


/**
 * Every frame of one scene, drawn.
 *
 * The frames are numbered from zero inside the scene's own directory, so
 * `fromFrames` can take them with one printf pattern and a scene that failed
 * half way leaves the frames it did draw on the disk for somebody to look at.
 */
export async function drawScene(opts: {
  browser: string;
  ffmpeg: string;
  spec: SceneSpec;
  index: number;
  dir: string;
  fps: number;
  holdLastFrame?: boolean;
  size: { width: number; height: number };
  look: ReturnType<typeof lookOf>;
  signal?: AbortSignal;
}): Promise<{ frames: number } | { error: string }> {
  const scene = opts.spec.scenes[opts.index]!;
  const total = Math.max(1, Math.round(scene.seconds * opts.fps));
  const per = tilesPerSheet(opts.size.width, opts.size.height);
  mkdirSync(opts.dir, { recursive: true });

  for (let from = 0; from < total; from += per) {
    if (opts.signal?.aborted) return { error: "the run was cancelled" };
    const count = Math.min(per, total - from);
    const tiles: Tile[] = [];
    for (let i = 0; i < count; i++) tiles.push({ scene, t: (from + i) / opts.fps, holdLastFrame: opts.holdLastFrame });
    const name = `sheet-${String(from).padStart(5, "0")}`;
    const sheet = {
      browser: opts.browser,
      html: sheetHtml(tiles, opts.look, opts.size),
      dir: opts.dir,
      name,
      width: opts.size.width * count,
      height: opts.size.height,
      signal: opts.signal,
    };
    /* ONE MORE TRY BEFORE THE VIDEO IS LOST. A sheet is the same local file
       either time, so a failure is the machine — a small box that was busy for
       twenty seconds — and not the page. Run r-gc062x drew 98 frames and was
       thrown away over the 99th; the second launch costs seconds. */
    let shot = await shootSheet(sheet);
    if (!shot.ok && !opts.signal?.aborted) shot = await shootSheet(sheet);
    if (!shot.ok) return { error: `the browser could not draw frames ${from}–${from + count - 1}: ${shot.error}` };
    const cut = await untileSheet({
      ffmpeg: opts.ffmpeg,
      sheet: shot.path,
      dir: opts.dir,
      pattern: "f-%05d.png",
      tiles: count,
      start: from,
      height: opts.size.height,
      signal: opts.signal,
    });
    if (!cut.ok) return { error: `the sheet of frames ${from}–${from + count - 1} could not be cut apart: ${cut.error}` };
    /* The sheet is a 1.4 MB PNG that has already been turned into frames.
       Keeping one per eight frames would be most of the disk this render
       uses, for a picture nobody looks at. */
    rmSync(shot.path, { force: true });
  }
  return { frames: total };
}

/* ------------------------------------------------------------- the render */

export async function motionVideo(opts: {
  runId: string;
  session: RunSession;
  venture: VentureRow | null;
  input: MotionInput;
  signal?: AbortSignal;
}): Promise<void> {
  const { session: s, venture: v, input, signal } = opts;
  const dir = runDir(opts.runId);
  mkdirSync(dir, { recursive: true });

  /* ---------------------------------------------------------- 1. tools */
  const toolStep = s.startStep("tools", "checking what this box can draw with");
  const ffmpeg = findFfmpeg();
  const ffprobe = findFfprobe();
  const browser = findBrowser();
  if (!ffmpeg.path) {
    s.endStep(toolStep, "no ffmpeg");
    throw new StepError("tools", ffmpeg.error ?? "no ffmpeg on this box");
  }
  if (!browser.found) {
    s.endStep(toolStep, "no browser");
    throw new StepError(
      "tools",
      `${browser.error} A motion video is drawn BY a browser — there is no other renderer here — so there is nothing this run can fall back to.`,
    );
  }
  const filters = await ffmpegFilters(ffmpeg.path);
  if (!hasUntile(filters)) {
    s.endStep(toolStep, "no untile filter");
    throw new StepError(
      "tools",
      "This ffmpeg build has no `untile` filter, which is what cuts a sheet of frames back into single frames. " +
        "Every frame would have to be its own browser launch, which is minutes per second of video. Install an ffmpeg with `untile` (it is in every ordinary build since 4.3).",
    );
  }
  s.endStep(toolStep, `${browser.path?.split("/").pop() ?? "a browser"} · ffmpeg`);

  /* ----------------------------------------------------------- 2. spec */
  const limits = specLimits();
  const specStep = s.startStep("spec", input.specId ? "reading the saved scene list" : "writing the scene list");
  let spec: SceneSpec | null = null;
  let problems: string[] = [];
  let specModel: string | null = null;
  let specSource: string;

  if (input.specId) {
    const row = specRow(input.specId);
    if (!row) {
      s.endStep(specStep, "no such spec");
      throw new StepError("spec", `There is no saved scene spec with the id ${input.specId}. GET /api/motion lists the ones there are.`);
    }
    spec = readSpecRow(row, limits);
    specSource = `the saved spec “${row.name}” (${row.source === "model" ? "written by a model" : "written or edited by the owner"})`;
    if (!spec) {
      s.endStep(specStep, "the saved spec could not be read");
      throw new StepError("spec", `The saved spec ${input.specId} is not readable as a scene list any more.`);
    }
  } else {
    try {
      const written = await writeSceneSpec({ venture: v, brief: input.brief, aspect: input.aspect, limits, signal });
      specModel = written.model;
      const read = readSceneSpec(written.raw, limits);
      spec = read.spec;
      problems = read.problems;
      specSource = `written for this run by ${written.model ?? "the model provider"}`;
      if (!spec) {
        s.endStep(specStep, "the model did not answer with a scene list");
        throw new StepError(
          "spec",
          `The model did not answer with a scene list this server could read. ${read.problems.join(" ")} What came back starts: ${written.text.slice(0, 300)}`,
        );
      }
    } catch (err) {
      if (err instanceof StepError) throw err;
      s.endStep(specStep, "the scene list could not be written");
      const sent = (err as { modelReply?: unknown } | null)?.modelReply;
      if (typeof sent === "string")
        s.say(`## What the model sent instead of a scene list\n\n\`\`\`\n${sent.slice(0, 4000) || "(nothing at all — an empty reply)"}\n\`\`\`\n`);
      throw new StepError("spec", err instanceof Error ? err.message : String(err));
    }
  }

  /* The aspect on the run's form wins over the one in the spec: the form is
     what the owner touched most recently. */
  const aspect = input.aspect in ASPECTS ? input.aspect : spec.aspect;
  spec = { ...spec, aspect, voiceover: input.voiceover };
  const frame = aspectFrame(aspect);
  const fps = motionFps();
  const cost = plan(spec, fps, frame);
  s.endStep(specStep, `${spec.scenes.length} scenes · ${specSeconds(spec).toFixed(1)}s · ${cost.sheets} browser launches`);

  s.say(
    [
      `## The scene list`,
      ``,
      ...specLines(spec),
      ``,
      `${specSource}. ${cost.frames} frames at ${fps}/s, drawn ${cost.tiles} at a time, so ${cost.sheets} browser launches.`,
      ...(problems.length ? ["", `**What was changed on the way in:**`, ...problems.map((p) => `- ${p}`)] : []),
    ].join("\n"),
  );

  /* ------------------------------------------------------- 3. narration */
  const voice = voiceSettings();
  const narration: (string | null)[] = spec.scenes.map(() => null);
  const timings = spec.scenes.map((scene) => sceneTiming(scene.seconds, null));
  let narrationNote: string;
  if (!spec.voiceover) {
    narrationNote = "Voiceover was not asked for, so this video is silent.";
  } else if (voice.tts === "off") {
    narrationNote =
      "Voiceover was asked for and speech is off in the voice plugin's settings, so this video is SILENT. Choose FreeLLMAPI, an OpenAI-compatible speech endpoint or Piper in Integrations → Voice first.";
  } else {
    if (!ffprobe.path) throw new StepError("voice", "Narration needs ffprobe to measure speech so scenes do not cut it short. Install ffprobe alongside ffmpeg.");
    const vStep = s.startStep("voice", `speaking ${spec.scenes.filter((x) => x.say).length} lines`);
    let spoken = 0;
    let failed: string | null = null;
    for (const [i, scene] of spec.scenes.entries()) {
      if (!scene.say) continue;
      if (signal?.aborted) throw new StepError("voice", "the run was cancelled");
      let clip;
      try {
        clip = await speak(scene.say);
      } catch (err) {
        failed = err instanceof Error ? err.message : String(err);
        break;
      }
      const seconds = await probeDuration(ffprobe.path, clip.path, signal);
      if (seconds === null) {
        s.endStep(vStep, `could not measure scene ${i + 1}'s narration`);
        throw new StepError("voice", `Could not measure scene ${i + 1}'s narration. The video was not rendered with guessed speech timing.`);
      }
      timings[i] = sceneTiming(scene.seconds, seconds);
      narration[i] = clip.path;
      spoken++;
    }
    s.endStep(vStep, failed ? `stopped after ${spoken}` : `${spoken} lines`);
    narrationNote = failed
      ? `The voice endpoint refused after ${spoken} of ${spec.scenes.length} lines: ${failed}. The scenes that did get a voice keep it; the rest are silent.`
      : `${spoken} scenes were narrated by the voice plugin's ${voice.tts} endpoint.`;
  }
  const hasAudio = narration.some((n) => n !== null);
  const heldScenes = timings.filter((timing) => timing.holdSeconds > 0);
  if (heldScenes.length) narrationNote += ` ${heldScenes.length} scene(s) hold their final frame until narration finishes, with a short pause before the next scene.`;

  /* ---------------------------------------------------------- 4. frames */
  const look = lookOf(v, spec.accent);
  const parts: string[] = [];
  for (const [i, scene] of spec.scenes.entries()) {
    if (signal?.aborted) throw new StepError("frames", "the run was cancelled");
    const timing = timings[i]!;
    const sceneDir = resolve(dir, `scene-${String(i + 1).padStart(2, "0")}`);
    const step = s.startStep("frames", `scene ${i + 1} of ${spec.scenes.length} — ${scene.kind}, ${timing.seconds.toFixed(2)}s${timing.holdSeconds > 0 ? " including narration hold" : ""}`);
    const drawn = await drawScene({
      browser: browser.path!,
      ffmpeg: ffmpeg.path,
      spec,
      index: i,
      dir: sceneDir,
      fps,
      holdLastFrame: timing.holdSeconds > 0,
      size: frame,
      look,
      signal,
    });
    if ("error" in drawn) {
      s.endStep(step, "the frames could not be drawn");
      throw new StepError("frames", `scene ${i + 1} (${scene.kind}) — ${drawn.error}`);
    }
    const out = resolve(dir, `scene-${String(i + 1).padStart(2, "0")}.mp4`);
    const encoded = await fromFrames({
      ffmpeg: ffmpeg.path,
      pattern: "f-%05d.png",
      dir: sceneDir,
      out,
      fps,
      seconds: timing.seconds,
      audio: narration[i] ?? null,
      /* All segments carry audio or none do — see assemble.ts's header. A
         scene with nothing to say gets a silent track when its neighbours
         have sound, because the concat demuxer will not join the two. */
      silentTrack: hasAudio && !narration[i],
      signal,
    });
    if (!encoded.ok) {
      s.endStep(step, "the scene could not be encoded");
      throw new StepError("frames", `scene ${i + 1} (${scene.kind}) — ${encoded.error}`);
    }
    parts.push(out);
    /* The PNGs are gone the moment they are a video. A five-second 9:16 scene
       is sixty frames of about 300 KB, and a six-scene spec that kept them all
       would leave a hundred megabytes of stills beside a two-megabyte file. */
    rmSync(sceneDir, { recursive: true, force: true });
    s.endStep(step, `${drawn.frames} frames${timing.holdSeconds > 0 ? ` · last frame held ${timing.holdSeconds.toFixed(2)}s for narration` : ""}`);
  }

  /* ----------------------------------------------------------- 5. join */
  const joinStep = s.startStep("join", `joining ${parts.length} scenes`);
  const out = resolve(dir, "video.mp4");
  const joined = await concat({ ffmpeg: ffmpeg.path, parts, out, dir, hasAudio, signal });
  if (!joined.ok) {
    s.endStep(joinStep, "the scenes could not be joined");
    throw new StepError("join", joined.error);
  }
  const duration = ffprobe.path ? await probeDuration(ffprobe.path, out, signal) : null;
  const bytes = bytesOf(out);
  s.endStep(joinStep, `${duration ? `${duration.toFixed(1)}s · ` : ""}${bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "written"}`);
  for (const p of parts) rmSync(p, { force: true });

  saveJob({
    runId: opts.runId,
    ventureId: v?.id ?? null,
    format: "motion",
    aspect,
    width: frame.width,
    height: frame.height,
    script: { motion: spec, timings, specId: input.specId || null, problems, fps, look: { accent: look.accent, background: look.bg, source: look.source } },
    assets: [],
    durationS: duration,
    bytes,
    path: out,
    /* THE WORDS ARE THE PICTURE HERE. There is no caption renderer in this
       format because there is nothing to caption: every frame is typography
       already, drawn by the browser. Saying `typst` or `none` would be
       answering a question this format does not have. */
    captions: "the scenes themselves — this format is typography, so nothing is burned on top",
    narration: hasAudio ? `tts — ${voice.tts}` : "none",
    transcript: spec.scenes.map((x) => x.say).filter(Boolean).join("\n") || null,
    error: null,
  });

  s.say(
    [
      `## ${spec.title}`,
      ``,
      `${spec.scenes.length} scenes, ${duration ? `${duration.toFixed(1)} seconds` : "length unread"}, ${frame.width}×${frame.height}. The file is on this page. Nothing has been published anywhere.`,
      ``,
      `## How it was drawn`,
      ``,
      `- ${cost.frames} frames at ${fps} a second, ${cost.tiles} to a sheet, so ${cost.sheets} headless browser launches. Each frame is a paused CSS animation at its own timestamp, so the same spec always draws the same pixels.`,
      `- Colours: ${look.source} — accent \`${look.accent}\`, background \`${look.bg}\`.`,
      `- Typeface: ${look.font ? `${look.font}, measured off the venture's own site` : "no font was measured off the venture's site, so the system stack was used"}.`,
      `- Narration: ${narrationNote}`,
      ...(hasAudio ? ["", "## Scene timing", "", ...timings.map((timing, i) =>
        `- Scene ${i + 1}: ${timing.seconds.toFixed(2)}s total · ${timing.narrationSeconds === null ? "no narration" : `${timing.narrationSeconds.toFixed(2)}s narration`}${timing.holdSeconds > 0 ? ` · final frame held ${timing.holdSeconds.toFixed(2)}s` : ""}.`)] : []),
      ...(problems.length ? ["", `## What the validator changed`, "", ...problems.map((p) => `- ${p}`)] : []),
      ``,
      `## The scene list`,
      ``,
      ...specLines(spec),
      ...(specModel ? ["", `The scene list was written by ${specModel}. Every figure on a stat card is a claim about this business — check them before you publish this.`] : []),
    ].join("\n"),
  );
}

/* ------------------------------------------------------------ the preview */

export type Preview = { index: number; kind: string; seconds: number; file: string | null; error: string | null };

/**
 * THE FIRST FRAME OF EVERY SCENE, IN ONE BROWSER LAUNCH.
 *
 * A preview is a view rather than an action — it answers "what does this look
 * like" and it must not queue a run to do it — so it has to be fast. Every
 * scene's first frame is an independent tile, so they all go on ONE sheet and
 * one launch draws the lot: a six-scene spec previews in about three seconds
 * rather than eighteen.
 *
 * IT IS DRAWN AT A THIRD OF THE SIZE, and that is free rather than lossy: every
 * dimension in the stylesheet is computed from the tile's width, so a 360-wide
 * tile is the same design at a third of the pixels. What it is NOT is a
 * thumbnail of the finished video — it is the same renderer drawing the same
 * scene, which is the point.
 */
export async function previewSpec(opts: {
  spec: SceneSpec;
  venture: VentureRow | null;
  specId: string;
  /** This call's own directory name. The caller mints it and puts it in the
   *  image URLs, so two previews of the same spec cannot delete each other's
   *  frames — which is what a directory keyed only on the spec id did. */
  token: string;
  /** The REQUEST's signal. A client that navigated away used to leave a
   *  headless Chrome running to its own twenty-second timeout. */
  signal?: AbortSignal;
}): Promise<{ frames: Preview[]; error: string | null }> {
  const frames: Preview[] = opts.spec.scenes.map((s, i) => ({
    index: i + 1,
    kind: s.kind,
    seconds: s.seconds,
    file: null,
    error: null,
  }));
  const browser = findBrowser();
  const ffmpeg = findFfmpeg();
  if (!browser.found) return { frames, error: browser.error };
  if (!ffmpeg.path) return { frames, error: ffmpeg.error };
  const filters = await ffmpegFilters(ffmpeg.path);
  if (!hasUntile(filters)) return { frames, error: "This ffmpeg build has no `untile` filter, so a sheet cannot be cut into frames." };

  const full = aspectFrame(opts.spec.aspect);
  const scale = 3;
  const size = { width: Math.round(full.width / scale), height: Math.round(full.height / scale) };
  const dir = makePreviewDir(opts.specId, opts.token);

  const per = tilesPerSheet(size.width, size.height, 12);
  const look = lookOf(opts.venture, opts.spec.accent);
  for (let from = 0; from < opts.spec.scenes.length; from += per) {
    const count = Math.min(per, opts.spec.scenes.length - from);
    const tiles: Tile[] = [];
    /* t is a fraction of a second in rather than zero: at exactly zero every
       animated element is still at its "from" state and the card is empty,
       which would preview every scene as a blank rectangle. A third of a
       second is after the first element has landed and before the second. */
    for (let i = 0; i < count; i++) tiles.push({ scene: opts.spec.scenes[from + i]!, t: 0.34 });
    const shot = await shootSheet({
      browser: browser.path!,
      html: sheetHtml(tiles, look, size),
      dir,
      name: `sheet-${from}`,
      width: size.width * count,
      height: size.height,
      signal: opts.signal,
    });
    if (!shot.ok) {
      for (let i = 0; i < count; i++) frames[from + i]!.error = shot.error;
      continue;
    }
    const cut = await untileSheet({
      ffmpeg: ffmpeg.path,
      sheet: shot.path,
      dir,
      pattern: "p-%03d.png",
      tiles: count,
      start: from,
      height: size.height,
      signal: opts.signal,
    });
    rmSync(shot.path, { force: true });
    if (!cut.ok) {
      for (let i = 0; i < count; i++) frames[from + i]!.error = cut.error;
      continue;
    }
    for (let i = 0; i < count; i++) frames[from + i]!.file = resolve(dir, `p-${String(from + i).padStart(3, "0")}.png`);
  }
  /* The older calls' directories go now rather than on the next delete: this
     is the only moment anything knows a preview has been superseded. */
  sweepPreviews(opts.specId);
  return { frames, error: null };
}
