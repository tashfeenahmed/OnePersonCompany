import { FPS } from "./assemble.ts";

export type SceneTiming = {
  animationSeconds: number;
  narrationSeconds: number | null;
  seconds: number;
  holdSeconds: number;
};

/** Keep the animation's pacing; only its last frame waits for a longer voice.
 * Round up to an output frame and leave a short breath after the last word. */
export function sceneTiming(animationSeconds: number, narrationSeconds: number | null): SceneTiming {
  if (!(animationSeconds > 0) || !Number.isFinite(animationSeconds)
    || (narrationSeconds !== null && (!(narrationSeconds > 0) || !Number.isFinite(narrationSeconds))))
    throw new Error("Cannot time a scene without a valid animation and narration duration.");
  const seconds = narrationSeconds === null ? animationSeconds
    : Math.ceil(Math.max(animationSeconds, narrationSeconds + 0.25) * FPS) / FPS;
  return { animationSeconds, narrationSeconds, seconds, holdSeconds: Math.max(0, seconds - animationSeconds) };
}

