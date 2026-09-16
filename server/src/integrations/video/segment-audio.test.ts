import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { segment } from "./assemble.ts";

const available = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

test("Shorts keeps source audio aligned with the cut; other segments and silent sources stay silent", { skip: !available }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opc-segment-audio-"));
  const exec = (bin: string, args: string[]) => {
    const result = spawnSync(bin, args);
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  };
  const streams = (file: string) => JSON.parse(exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file]).toString()) as {
    streams: { codec_type: string }[]; format: { duration: string };
  };
  try {
    const source = join(dir, "source.mp4");
    // The first second is silent, so an incorrectly unseeked audio track fails the RMS assertion.
    exec("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x160:r=30:d=3",
      "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=3", "-af", "volume=0:enable='lt(t,1)'",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source]);
    const options = { ffmpeg: "ffmpeg", source, start: 1.5, seconds: 0.5, width: 160, height: 160,
      fit: "cover" as const, blur: null, pad: "#111111", overlays: [], drawtext: null, audio: null, silentTrack: false };
    const audible = join(dir, "audible.mp4");
    assert.equal((await segment({ ...options, out: audible, keepSourceAudio: true })).ok, true);
    const info = streams(audible);
    assert.ok(info.streams.some(s => s.codec_type === "audio"));
    assert.ok(Math.abs(Number(info.format.duration) - 0.5) < 0.1);
    const pcm = exec("ffmpeg", ["-v", "error", "-i", audible, "-map", "0:a", "-f", "f32le", "-ac", "1", "pipe:1"]);
    let energy = 0;
    for (let i = 0; i + 4 <= pcm.length; i += 4) energy += pcm.readFloatLE(i) ** 2;
    assert.ok(Math.sqrt(energy / (pcm.length / 4)) > 0.03, "The retained audio must be audible and seek with the video");

    const muted = join(dir, "muted.mp4");
    assert.equal((await segment({ ...options, out: muted })).ok, true);
    assert.ok(streams(muted).streams.every(s => s.codec_type !== "audio"));
    const silent = join(dir, "silent-source.mp4");
    exec("ffmpeg", ["-y", "-v", "error", "-i", source, "-c:v", "copy", "-an", silent]);
    const silentCut = join(dir, "silent-cut.mp4");
    assert.equal((await segment({ ...options, source: silent, out: silentCut, keepSourceAudio: true })).ok, true);
    assert.ok(streams(silentCut).streams.every(s => s.codec_type !== "audio"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
