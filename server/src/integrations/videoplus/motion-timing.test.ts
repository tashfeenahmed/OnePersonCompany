import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";
import { fromFrames, concat } from "../video/assemble.ts";
import { findFfmpeg, findFfprobe, probeDuration } from "../video/tools.ts";
import { sceneTiming } from "./motion.ts";

test("narration timing keeps animation speed and never cuts a longer utterance", () => {
  assert.deepEqual(sceneTiming(3, null), { animationSeconds: 3, narrationSeconds: null, seconds: 3, holdSeconds: 0 });
  assert.equal(sceneTiming(3, 1).seconds, 3);
  const long = sceneTiming(3, 11.81);
  assert.equal(long.animationSeconds, 3);
  assert(long.seconds >= 12.06, "Include all audio and the short pause");
  assert(long.holdSeconds > 9, "Do not cap speech at the scene's animation limit");
  for (const invalid of [NaN, Infinity, -1, 0]) assert.throws(() => sceneTiming(3, invalid));
});

test("encoded scenes hold their last frame through the full voice before the next scene", async (t) => {
  const ffmpeg = findFfmpeg().path;
  const ffprobe = findFfprobe().path;
  if (!ffmpeg || !ffprobe) return t.skip("FFmpeg and ffprobe are required for the audiovisual regression test.");
  const dir = join(DATA_DIR, "motion-timing"); mkdirSync(dir, { recursive: true });
  const encode = (args: string[]) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);
  // Five blue frames and a red final frame, then a green scene. PPM makes the
  // source frames exact and independent of browser/font differences.
  for (const [name, color] of [["first", [0, 0, 255]], ["next", [0, 255, 0]]] as const) {
    mkdirSync(join(dir, name));
    for (let i = 0; i < 6; i++) {
      const rgb = name === "first" && i === 5 ? [255, 0, 0] : color;
      const pixels = Buffer.alloc(64 * 64 * 3);
      for (let pixel = 0; pixel < 64 * 64; pixel++) for (let c = 0; c < 3; c++) pixels[pixel * 3 + c] = rgb[c]!;
      writeFileSync(join(dir, name, `f-${String(i).padStart(5, "0")}.ppm`), Buffer.concat([Buffer.from("P6\n64 64\n255\n"), pixels]));
    }
  }
  const audio = join(dir, "long.wav");
  const nextAudio = join(dir, "short.wav");
  encode(["-f", "lavfi", "-i", "sine=frequency=440:duration=1.7:sample_rate=24000", audio]);
  encode(["-f", "lavfi", "-i", "sine=frequency=880:duration=0.2:sample_rate=24000", nextAudio]);
  const timing = sceneTiming(0.6, (await probeDuration(ffprobe, audio))!);
  const first = join(dir, "first.mp4"); const next = join(dir, "next.mp4");
  for (const [name, out, seconds, sound] of [["first", first, timing.seconds, audio], ["next", next, 0.6, nextAudio]] as const) {
    const result = await fromFrames({ ffmpeg, dir: join(dir, name), pattern: "f-%05d.ppm", out, fps: 10, seconds, audio: sound, silentTrack: false });
    assert(result.ok, result.ok ? "" : result.error);
  }
  const duration = (await probeDuration(ffprobe, first))!;
  assert(Math.abs(duration - timing.seconds) < 0.06);
  const joined = join(dir, "joined.mp4");
  const combined = await concat({ ffmpeg, parts: [first, next], out: joined, dir, hasAudio: true });
  assert(combined.ok, combined.ok ? "" : combined.error);
  const pixel = (at: number) => [...encode(["-ss", String(at), "-i", joined, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])];
  assert(pixel(0.1)[2]! > 200, "Animation starts on blue");
  assert(pixel(1.5)[0]! > 200, "Hold the final red frame while the long voice continues");
  assert(pixel(1.85)[0]! > 200, "Keep that frame during the brief pause after speech");
  assert(pixel(duration + 0.1)[1]! > 200, "Advance to green only after narration and its pause");
  const rms = (at: number) => {
    const pcm = encode(["-ss", String(at), "-i", joined, "-t", "0.05", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"]);
    let energy = 0; for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
    return Math.sqrt(energy / (pcm.length / 2));
  };
  assert(rms(1.5) > 300, "Narration beyond the original 0.6-second scene is retained");
  assert(rms(1.8) < 60, "The first voice finishes before the next scene");
  assert(rms(duration + 0.08) > 300, "The next voice starts with the next scene");
  const silent = join(dir, "silent.mp4");
  assert((await fromFrames({ ffmpeg, dir: join(dir, "next"), pattern: "f-%05d.ppm", out: silent, fps: 10, seconds: 0.6, audio: null, silentTrack: false })).ok);
  assert(Math.abs((await probeDuration(ffprobe, silent))! - 0.6) < 0.04, "Silent scenes keep their original duration");
});
