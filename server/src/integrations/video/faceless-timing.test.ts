import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DATA_DIR } from "../../config.ts";
import { concat, segment } from "./assemble.ts";
import { sceneTiming } from "./timing.ts";
import { findFfmpeg, findFfprobe, probeDuration } from "./tools.ts";

test("faceless shots keep all speech, hold the captioned last frame, and only then advance", async (t) => {
  const ffmpeg = findFfmpeg().path;
  const ffprobe = findFfprobe().path;
  if (!ffmpeg || !ffprobe) return t.skip("FFmpeg and ffprobe are required for this audiovisual regression.");
  const dir = join(DATA_DIR, "faceless-timing"); mkdirSync(dir, { recursive: true });
  const encode = (args: string[]) => execFileSync(ffmpeg, ["-v", "error", "-y", ...args]);
  const firstSource = join(dir, "stock.mp4");
  // The intended cut ends on red. Yellow footage after it must never appear.
  encode(["-f", "lavfi", "-i", "color=blue:s=160x160:r=30:d=2,drawbox=color=red:t=fill:enable='gte(t,0.5)',drawbox=color=yellow:t=fill:enable='gte(t,0.6)'", "-c:v", "libx264", firstSource]);
  const nextSource = join(dir, "short-stock.mp4");
  encode(["-f", "lavfi", "-i", "color=lime:s=160x160:r=30:d=0.2", "-c:v", "libx264", nextSource]);
  const caption = join(dir, "caption.ppm");
  writeFileSync(caption, Buffer.concat([Buffer.from("P6\n32 32\n255\n"), Buffer.alloc(32 * 32 * 3, 255)]));
  const longVoice = join(dir, "long.wav"); const shortVoice = join(dir, "short.wav");
  encode(["-f", "lavfi", "-i", "sine=frequency=440:duration=1.7:sample_rate=24000", longVoice]);
  encode(["-f", "lavfi", "-i", "sine=frequency=880:duration=0.2:sample_rate=24000", shortVoice]);
  const firstTiming = sceneTiming(0.6, (await probeDuration(ffprobe, longVoice))!);
  const nextTiming = sceneTiming(0.6, (await probeDuration(ffprobe, shortVoice))!);
  const first = join(dir, "first.mp4"); const next = join(dir, "next.mp4");
  const common = { ffmpeg, start: 0, width: 160, height: 160, fit: "cover" as const, blur: null,
    pad: "#111111", overlays: [{ png: caption, from: null, to: null }], drawtext: null, silentTrack: false };
  for (const [source, out, audio, timing] of [[firstSource, first, longVoice, firstTiming], [nextSource, next, shortVoice, nextTiming]] as const) {
    const rendered = await segment({ ...common, source, out, audio, seconds: timing.seconds, holdLastFrameAfter: timing.animationSeconds });
    assert(rendered.ok, rendered.ok ? "" : rendered.error);
    const streams = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", out]).toString()).streams;
    for (const stream of streams) assert(Math.abs(Number(stream.duration) - timing.seconds) < 0.05, `${stream.codec_type} ends early`);
  }
  const joined = join(dir, "final.mp4");
  const result = await concat({ ffmpeg, parts: [first, next], out: joined, dir, hasAudio: true });
  assert(result.ok, result.ok ? "" : result.error);
  const pixel = (at: number, crop = "crop=32:32:64:64") => [...encode(["-ss", String(at), "-i", joined, "-frames:v", "1", "-vf", `${crop},scale=1:1`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])];
  assert(pixel(0.1)[2]! > 200, "The stock starts on blue");
  assert(pixel(1.6)[0]! > 200 && pixel(1.6)[1]! < 30, "The planned red final frame holds while narration continues");
  assert(pixel(1.85)[0]! > 200 && pixel(1.85)[1]! < 30, "The last frame stays during the short pause");
  assert(pixel(1.6, "crop=16:16:0:0").every(channel => channel > 230), "Captions remain on the held frame");
  assert(pixel(firstTiming.seconds + 0.35)[1]! > 200, "The next stock clip is also padded when shorter than its shot");
  const rms = (at: number) => {
    const pcm = encode(["-ss", String(at), "-i", joined, "-t", "0.05", "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"]);
    assert(pcm.length > 0, "Audio must exist at the requested time");
    let energy = 0; for (let i = 0; i < pcm.length; i += 2) energy += pcm.readInt16LE(i) ** 2;
    return Math.sqrt(energy / (pcm.length / 2));
  };
  assert(rms(1.6) > 300, "The end of the long voice must survive the original 0.6-second cut");
  assert(rms(1.8) < 60, "The first voice finishes before the next scene");
  assert(rms(firstTiming.seconds + 0.08) > 300, "The next voice starts with its own scene");
  assert(rms(firstTiming.seconds + 0.4) < 60, "A shorter voice is padded with silence");
  const silent = join(dir, "silent.mp4");
  assert((await segment({ ...common, source: nextSource, out: silent, audio: null, seconds: 0.6, holdLastFrameAfter: 0.6 })).ok);
  assert(Math.abs((await probeDuration(ffprobe, silent))! - 0.6) < 0.04, "Silent shots keep their planned length");
});
