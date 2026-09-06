/**
 * THE ONE PLACE THIS AREA READS ITS SETTINGS.
 *
 * A CONFIG-ONLY PLUGIN OF ITS OWN, AND THAT IS NOT TIDINESS. `manifestConfig()`
 * merges every area's `config` BY PLUGIN ID: an entry under `video` written
 * here would replace the video area's own entry wholesale, and the encoder
 * paths would quietly stop being settable. So these live under `videoplus` and
 * the two pages sit next to each other under Integrations.
 *
 * EVERY NUMBER BELOW IS A SETTING AND NOT A CONSTANT, for the reason the shared
 * brief gives: the next person to install this has a different machine, a
 * different whisper build and a different tolerance for how long a laptop may
 * spend on a video. What is NOT a setting is anything that would let a value
 * make the output dishonest — there is no "pretend the crop tracked" switch,
 * and the scene threshold is bounded so it cannot be set to a value that finds
 * a cut in every frame.
 */
import { configValue } from "../../db.ts";
import type { SpecLimits } from "./scenespec.ts";

export const VIDEOPLUS_PLUGIN = "videoplus";

const num = (key: string, fallback: number, lo: number, hi: number): number => {
  const raw = (configValue(VIDEOPLUS_PLUGIN, key) ?? "").trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};

const text = (key: string): string => (configValue(VIDEOPLUS_PLUGIN, key) ?? "").trim();

const onOff = (key: string, fallback: boolean): boolean => {
  const v = text(key).toLowerCase();
  return v === "on" ? true : v === "off" ? false : fallback;
};

/* ----------------------------------------------------------------- motion */

/** The frame rate the SCENES are drawn at, which is not the frame rate of the
 *  finished file — assemble.ts encodes everything at 30 and ffmpeg repeats
 *  frames to get there. Twelve is the trade this box makes: a sheet of eight
 *  frames costs about two and a half seconds of headless Chrome, so thirty
 *  would be two and a half times the render for motion that is already
 *  smooth at twelve on typography. */
export const motionFps = () => Math.round(num("motionFps", 12, 6, 30));

export const specLimits = (): SpecLimits => ({
  maxScenes: Math.round(num("motionScenes", 8, 1, 12)),
  minSceneSeconds: 1.5,
  maxSceneSeconds: num("motionSceneSeconds", 8, 2, 15),
  maxTotalSeconds: num("motionSeconds", 60, 5, 180),
});

/* ------------------------------------------------------------------- reel */

/**
 * The voice names the TTS endpoint should be asked for, one per speaking role.
 *
 * BLANK MEANS ONE VOICE, and a reel made with one voice is a reel where both
 * speakers sound the same. That is reported rather than hidden: reel.ts says
 * which voice each role got and, when there is only one, that the second role
 * is the same voice at a different rate.
 */
export const reelVoices = (): string[] =>
  text("reelVoices")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);

/** How many of the venture's own pages one reel may capture. */
export const reelPages = () => Math.round(num("reelPages", 4, 1, 8));

/** How tall a page capture is, in pixels. See chrome.ts: this is the scroll —
 *  the whole of what the reel can pan down. */
export const reelPageHeight = () => Math.round(num("reelPageHeight", 3600, 1200, 8000));

/* ----------------------------------------------------------------- shorts */

/* Where a local whisper is (`whisper`) is read by moments.ts through the
   shared binary finder, which owns "a configured path that is not there is an
   error" for every binary on the box. It is not read here. */
/** The model file. There is no probe for this one: a ggml model is a two
 *  gigabyte file the owner downloaded on purpose and there is no conventional
 *  place for it. Blank means word timings are simply not available, which is
 *  reported as such rather than worked around. */
export const whisperModel = () => text("whisperModel");

/** The scene-change score above which ffmpeg's `select` calls it a cut.
 *  0.4 is ffmpeg's own commonly used value; below 0.15 a slow pan reads as a
 *  cut and the boundaries become noise, so that is the floor. */
export const sceneThreshold = () => num("sceneThreshold", 0.4, 0.15, 0.9);

/** Whether a shorts clip may follow the subject. Off falls back to the fixed
 *  centre crop, which is what this box did before and is still what happens
 *  when the tracking finds nothing to follow. */
export const trackingOn = () => onOff("tracking", true);

/** A local vision model's path, if the owner has one. Blank is the ordinary
 *  case and means the tracked crop follows measured MOTION rather than a
 *  detected subject — see track.ts, which refuses to describe one as the
 *  other. Nothing here downloads a model. */
export const visionModelPath = () => text("visionModel");
