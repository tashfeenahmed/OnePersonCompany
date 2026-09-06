/**
 * The pure halves of this area, tested without a browser, an encoder or a
 * model.
 *
 * THREE THINGS ARE WORTH A TEST HERE and they are the three where being wrong
 * is invisible: a validator that let a scene kind through would render the
 * wrong card, a moment chooser that drifted would cut clips nobody asked for,
 * and a crop path that was not clamped would make ffmpeg refuse a filter at
 * the last minute of a long render. Everything else in this area is a
 * subprocess, and a test of a subprocess is a test of this machine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, defaultSeconds, readSceneSpec, specSeconds } from "./scenespec.ts";
import { chooseMoments, parseSceneCuts, parseWhisperJson, snapToCut, tidyWindows, type Word } from "./moments.ts";
import { cropXExpr, drift, motionCentroids, SAMPLE_H, SAMPLE_W, smoothPath, thin, visionModel } from "./track.ts";
import { readDialogue, estimateSeconds, readUrls, refusedHost } from "./reel.ts";
import { readModelJson } from "./json.ts";

/* ------------------------------------------------------------- scene spec */

const titleScene = { kind: "title", title: "A short line", seconds: 3 };

test("a spec with no scenes is refused rather than rendered empty", () => {
  const a = readSceneSpec({ title: "x" });
  assert.equal(a.spec, null);
  assert.match(a.problems.join(" "), /no `scenes`/);
  const b = readSceneSpec("not an object");
  assert.equal(b.spec, null);
});

test("an unknown scene kind is DROPPED and named, never rendered as another kind", () => {
  const read = readSceneSpec({ scenes: [titleScene, { kind: "quote", text: "hello", seconds: 3 }] });
  assert.equal(read.spec?.scenes.length, 1);
  assert.equal(read.spec?.scenes[0]?.kind, "title");
  assert.match(read.problems.join(" "), /no template for that/);
});

test("strings are clamped to length and lists to six items, with a sentence each", () => {
  const read = readSceneSpec({
    scenes: [{ kind: "list", heading: "H".repeat(200), items: Array.from({ length: 9 }, (_, i) => `item ${i}`), seconds: 5 }],
  });
  const scene = read.spec!.scenes[0]!;
  assert.equal(scene.kind, "list");
  if (scene.kind !== "list") return;
  assert.equal(scene.heading.length, 90);
  assert.equal(scene.items.length, 6);
  assert.match(read.problems.join(" "), /six is what fits/);
});

test("a scene longer than the ceiling becomes the ceiling and says so", () => {
  const read = readSceneSpec({ scenes: [{ ...titleScene, seconds: 40 }] });
  assert.equal(read.spec!.scenes[0]!.seconds, DEFAULT_LIMITS.maxSceneSeconds);
  assert.match(read.problems.join(" "), /scenes here run between/);
});

test("the total is trimmed from the END so surviving scenes keep their pacing", () => {
  const scenes = Array.from({ length: 8 }, (_, i) => ({ ...titleScene, title: `Scene ${i}`, seconds: 8 }));
  const read = readSceneSpec({ scenes }, { ...DEFAULT_LIMITS, maxTotalSeconds: 20 });
  assert.equal(read.spec!.scenes.length, 2);
  assert.equal(specSeconds(read.spec!), 16);
  assert.equal(read.spec!.scenes[0]!.seconds, 8, "the first scene is untouched");
  assert.match(read.problems.join(" "), /past 20s/);
});

test("a stat needs a value and a label, and a value with no digit is flagged not silently accepted", () => {
  assert.equal(readSceneSpec({ scenes: [{ kind: "stat", value: "9" }] }).spec, null);
  const read = readSceneSpec({ scenes: [{ kind: "stat", value: "many", label: "customers" }] });
  assert.equal(read.spec!.scenes.length, 1);
  assert.match(read.problems.join(" "), /has no digit in it/);
});

test("a cta url that is not http is dropped from the card rather than drawn", () => {
  const read = readSceneSpec({ scenes: [{ kind: "cta", headline: "Try it", action: "Start", url: "javascript:alert(1)" }] });
  const scene = read.spec!.scenes[0]!;
  assert.equal(scene.kind, "cta");
  if (scene.kind !== "cta") return;
  assert.equal(scene.url, null);
  assert.match(read.problems.join(" "), /not an http address/);
});

test("an accent that is not a hex colour falls back to the venture's own and says so", () => {
  const read = readSceneSpec({ accent: "red", scenes: [titleScene] });
  assert.equal(read.spec!.accent, null);
  assert.match(read.problems.join(" "), /six-digit hex/);
  assert.equal(readSceneSpec({ accent: "#AABBCC", scenes: [titleScene] }).spec!.accent, "#aabbcc");
});

test("a list's default length grows with its items", () => {
  assert.ok(defaultSeconds("list", 5) > defaultSeconds("list", 2));
  assert.equal(defaultSeconds("cta"), 3);
});

/* ---------------------------------------------------------------- moments */

test("whisper's JSON becomes words in seconds, and its empty silences are dropped", () => {
  const words = parseWhisperJson(
    JSON.stringify({
      transcription: [
        { offsets: { from: 0, to: 320 }, text: "" },
        { offsets: { from: 320, to: 400 }, text: " And" },
        { offsets: { from: 400, to: 690 }, text: " so" },
        { offsets: { from: 900, to: 500 }, text: " backwards" },
      ],
    }),
  );
  assert.deepEqual(words, [
    { start: 0.32, end: 0.4, text: "And" },
    { start: 0.4, end: 0.69, text: "so" },
  ]);
  assert.deepEqual(parseWhisperJson("not json"), []);
});

test("scene cuts are read off ffmpeg's metadata and near-duplicates collapse", () => {
  const cuts = parseSceneCuts(
    ["frame:12 pts:100 pts_time:4.004", "lavfi.scene_score=0.51", "frame:13 pts:104 pts_time:4.104", "frame:99 pts:900 pts_time:30.5"].join("\n"),
  );
  assert.deepEqual(cuts, [4.004, 30.5]);
});

test("a window snaps to a nearby cut and refuses a distant one", () => {
  assert.equal(snapToCut(10, [9.2, 40], 1.5), 9.2);
  assert.equal(snapToCut(10, [30, 40], 1.5), 10);
});

const words: Word[] = Array.from({ length: 120 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4, text: `w${i}` }));

test("tidying moves a window onto a cut and trims its end to the last whole word", () => {
  const { windows, moved } = tidyWindows({
    windows: [{ title: "t", reason: "", start: 10.3, end: 40 }],
    cuts: [9.5],
    words,
    duration: 60,
    maxSeconds: 45,
  });
  assert.equal(moved, 1);
  assert.equal(windows[0]!.start, 9.5);
  assert.ok(windows[0]!.end <= 40, "the end never grows past what was asked for");
  assert.ok(windows[0]!.end >= 39, "and it is not pulled back further than one word");
});

test("tidying never moves a window further than the tolerance", () => {
  const { windows } = tidyWindows({
    windows: [{ title: "t", reason: "", start: 20, end: 45 }],
    cuts: [0.1],
    words: [],
    duration: 60,
    maxSeconds: 45,
  });
  assert.equal(windows[0]!.start, 20);
});

test("tidying never lets two clips overlap, however far a start was snapped back", () => {
  /* The exact scenario from the review: #1's end is trimmed to the last whole
     word and #2's start snaps back onto a cut that is now inside #1. */
  const said: Word[] = [];
  for (let t = 10; t < 40; t += 0.5) said.push({ start: t, end: t + 0.3, text: "w" });
  const { windows } = tidyWindows({
    windows: [
      { title: "one", reason: "", start: 10, end: 25 },
      { title: "two", reason: "", start: 25.2, end: 40 },
    ],
    cuts: [23.8],
    words: said,
    duration: 60,
    maxSeconds: 45,
    minSeconds: 8,
  });
  assert.equal(windows.length, 2, "both survive — neither is shorter than the minimum after the clamp");
  assert.ok(windows[0]!.end <= windows[1]!.start, `${windows[0]!.end} must not run past ${windows[1]!.start}`);
});

test("a window squeezed under the minimum by the overlap clamp is dropped, not shipped short", () => {
  const { windows } = tidyWindows({
    windows: [
      { title: "one", reason: "", start: 0, end: 30 },
      { title: "two", reason: "", start: 29, end: 34 },
    ],
    cuts: [],
    words: [],
    duration: 60,
    maxSeconds: 45,
    minSeconds: 8,
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.title, "one");
});

test("tidying returns windows in time order even when the model did not", () => {
  const { windows } = tidyWindows({
    windows: [
      { title: "late", reason: "", start: 40, end: 55 },
      { title: "early", reason: "", start: 5, end: 20 },
    ],
    cuts: [],
    words: [],
    duration: 60,
    maxSeconds: 45,
  });
  assert.deepEqual(windows.map((w) => w.title), ["early", "late"]);
});

test("moments are chosen by density, do not overlap, and come back in time order", () => {
  const dense: Word[] = [];
  for (let t = 0; t < 120; t += 1) dense.push({ start: t, end: t + 0.5, text: "slow" });
  /* A burst of fast speech between 60 and 80 — the part a density chooser must
     find, and the only part of this transcript that differs from the rest. */
  for (let t = 60; t < 80; t += 0.2) dense.push({ start: t, end: t + 0.15, text: "fast" });
  dense.sort((a, b) => a.start - b.start);

  const picked = chooseMoments({ words: dense, cuts: [0, 30, 60, 95], duration: 120, want: 2, maxSeconds: 20 });
  assert.equal(picked.length, 2);
  assert.ok(picked.some((p) => p.start === 60), "the densest window is one of the two chosen");
  assert.ok(picked[0]!.start < picked[1]!.start, "they come back in time order, not score order");
  assert.ok(picked[0]!.end <= picked[1]!.start, "and they do not overlap");
  assert.match(picked[0]!.reason, /arithmetic, not by a model/);
});

test("with no words at all nothing is chosen — density never invents a window", () => {
  assert.deepEqual(chooseMoments({ words: [], cuts: [1, 2], duration: 60, want: 3, maxSeconds: 30 }), []);
});

/* ------------------------------------------------------------------ track */

/** A sampled clip in which a bright block moves left to right, plus one frame
 *  pair in which nothing at all changes. */
function movingBlock(frames: number, stillAt: number[] = []): Uint8Array {
  const size = SAMPLE_W * SAMPLE_H;
  const bytes = new Uint8Array(size * frames);
  for (let f = 0; f < frames; f++) {
    const x = stillAt.includes(f) ? Math.round(((f - 1) / (frames - 1)) * (SAMPLE_W - 8)) : Math.round((f / (frames - 1)) * (SAMPLE_W - 8));
    for (let y = 10; y < 26; y++) for (let i = 0; i < 8; i++) bytes[f * size + y * SAMPLE_W + x + i] = 255;
  }
  return bytes;
}

test("the motion centroid tracks a moving block and reports a still pair as null", () => {
  const frames = 12;
  const bytes = movingBlock(frames, [6]);
  const centres = motionCentroids(bytes, frames);
  assert.equal(centres.length, frames - 1);
  assert.equal(centres[5], null, "frame 6 is identical to frame 5, so that pair measured nothing");
  const measured = centres.filter((c): c is number => c !== null);
  assert.ok(measured[0]! < measured[measured.length - 1]!, "the centre of motion moves right over the clip");
});

test("the smoothed path stays inside the frame and never jumps faster than the limit", () => {
  const centroids = [0.05, 0.95, 0.05, 0.95, 0.5, 0.5, 0.5, null, null, 0.9];
  const path = smoothPath({ centroids, srcWidth: 1920, cropWidth: 608, fps: 4, maxPxPerSecond: 200 });
  const maxX = 1920 - 608;
  for (const p of path) {
    assert.ok(p.x >= 0 && p.x <= maxX, `x ${p.x} is inside 0..${maxX}`);
  }
  for (let i = 1; i < path.length; i++) {
    /* 200 px a second at four samples a second is 50 px a step, plus a pixel
       of rounding. */
    assert.ok(Math.abs(path[i]!.x - path[i - 1]!.x) <= 51, "no step is faster than the ceiling");
  }
});

test("a null centroid holds the last position rather than drifting back to the middle", () => {
  const path = smoothPath({ centroids: [0.9, 0.9, 0.9, null, null, null], srcWidth: 1920, cropWidth: 608, fps: 4 });
  assert.equal(path[3]!.x >= path[2]!.x, true, "the crop keeps travelling towards where the subject was");
  assert.ok(path[5]!.x > path[0]!.x);
});

test("drift is zero for a path that never moved and positive for one that did", () => {
  assert.equal(drift([{ t: 0, x: 100 }, { t: 1, x: 100 }]), 0);
  assert.equal(drift([{ t: 0, x: 100 }, { t: 1, x: 140 }, { t: 2, x: 120 }]), 60);
});

test("the crop expression is gated, clamped and thinned to a bounded length", () => {
  const path = Array.from({ length: 400 }, (_, i) => ({ t: i / 4, x: i * 10 - 500 }));
  assert.equal(thin(path).length, 48);
  const expr = cropXExpr(path, 1312);
  assert.match(expr, /^between\(t\\,-1\.000\\,/, "the first segment is gated from before zero, so frame one is never unmatched");
  assert.ok(!/[^\\],/.test(expr), "every comma inside the expression is escaped for the filtergraph parser");
  for (const m of expr.matchAll(/\)\*\((-?\d+)/g)) {
    const x = Number(m[1]);
    assert.ok(x >= 0 && x <= 1312, `control point ${x} is inside the frame`);
  }
  assert.equal(cropXExpr([], 600), "300", "an empty path is the centre, not the left edge");
});

test("the vision probe reports what is actually there and never claims a face detector", () => {
  const none = visionModel("");
  assert.equal(none.found, false);
  assert.match(none.note, /centre of MOTION/);
  const missing = visionModel("/nowhere/model.bin");
  assert.equal(missing.found, false);
  assert.match(missing.note, /is not there/);
});

/* ------------------------------------------------------------------- reel */

test("a dialogue is read with roles normalised and page numbers clamped into range", () => {
  const script = readDialogue(
    JSON.stringify({
      title: "A walkthrough",
      lines: [
        { role: "Host", text: "Host: this is the pricing page.", page: 1 },
        { role: "Interviewer", text: "Why would I pay for it?", page: 9 },
        { role: "", text: "", page: 1 },
      ],
    }),
    2,
    6,
  );
  assert.equal(script?.lines.length, 2);
  assert.equal(script?.lines[0]?.role, "host");
  assert.equal(script?.lines[0]?.text, "this is the pricing page.", "the speaker prefix is metadata and never reaches the caption");
  assert.equal(script?.lines[1]?.role, "guest", "an unrecognised role alternates from the line before it");
  assert.equal(script?.lines[1]?.page, 2, "a page number outside the list is clamped, not dropped");
});

test("a reply with fewer than two usable lines is not a dialogue", () => {
  assert.equal(readDialogue("no json here", 2, 6), null);
  assert.equal(readDialogue(JSON.stringify({ lines: [{ role: "host", text: "alone" }] }), 1, 6), null);
});

test("an estimated line length is floored and capped", () => {
  assert.equal(estimateSeconds("one"), 2.2);
  assert.ok(estimateSeconds("word ".repeat(200)) <= 9);
});

test("a reel refuses every address that resolves inside this network", () => {
  const inside = [
    "http://127.0.0.1:8787/api/plugins",
    "http://localhost:5180/",
    "http://10.0.0.4/",
    "http://192.168.1.9/admin",
    "http://172.16.4.1/",
    "http://100.101.102.103/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fe80::1]/",
  ];
  for (const u of inside) assert.ok(refusedHost(new URL(u)), `${u} must be refused`);
  for (const u of ["https://example-app-1.example.test/", "https://example.com:8443/x", "http://93.184.216.34/"])
    assert.equal(refusedHost(new URL(u)), null, `${u} must be allowed`);
});

test("the refusal happens in readUrls, is named in the note, and covers the venture record too", () => {
  const typed = readUrls("https://example.com/a http://127.0.0.1:8787/api/plugins", null, 4);
  assert.deepEqual(typed.urls, ["https://example.com/a"]);
  assert.match(typed.note, /REFUSED/);
  assert.match(typed.note, /127\.0\.0\.1/);

  /* TYPED AND ALL REFUSED IS A REFUSAL. Falling through to the venture's
     website here would make a video of a page nobody asked for. */
  const allRefused = readUrls("http://127.0.0.1:8787/api/plugins", { website: "https://example-app-1.example.test" } as never, 4);
  assert.deepEqual(allRefused.urls, []);
  assert.match(allRefused.note, /Every address on the form was refused/);
  assert.doesNotMatch(allRefused.note, /No addresses were typed/);

  /* THE OWNER'S OWN FIELD GETS THE SAME CHECK. "The owner typed it" is not a
     reason to screenshot a LAN box and send the picture to a model endpoint. */
  const lanVenture = readUrls("", { website: "http://192.168.1.50:3000" } as never, 4);
  assert.deepEqual(lanVenture.urls, []);
  assert.match(lanVenture.note, /will not capture/);
});

test("reel urls come from the form, else the venture, else nowhere — never from nothing", () => {
  const venture = { website: "example.com" } as never;
  assert.deepEqual(readUrls("  ", venture, 4).urls, ["https://example.com"]);
  const typed = readUrls("example.com/a\nhttps://example.com/b, javascript:bad", venture, 4);
  assert.deepEqual(typed.urls, ["https://example.com/a", "https://example.com/b"]);
  assert.deepEqual(readUrls("", { website: "" } as never, 4).urls, []);
  assert.equal(readUrls("a.com b.com c.com", null, 2).urls.length, 2, "the cap is obeyed");
});

/* ------------------------------------------------------------ model JSON */

test("the object is found even when the model reasoned in prose, with braces, first", () => {
  const reply =
    'First I need an object like {x} with the lines. Let me think.\n' +
    '{"title":"A walkthrough","lines":[{"role":"host","text":"one","page":1}]}\n' +
    "That should do it.";
  const o = readModelJson(reply, "lines");
  assert.equal(o?.title, "A walkthrough");
  assert.equal((o?.lines as unknown[]).length, 1);
});

test("a fenced block and a bare array are both accepted", () => {
  const fencedReply = '```json\n{"scenes":[{"kind":"title","title":"x"}]}\n```';
  assert.ok(readModelJson(fencedReply, "scenes"));
  const bare = 'here you go:\n[{"role":"host","text":"one"}]';
  assert.equal((readModelJson(bare, "lines")?.lines as unknown[]).length, 1);
});

test("nothing is repaired — a truncated object is null, not a guess", () => {
  assert.equal(readModelJson('{"lines":[{"role":"host",', "lines"), null);
  assert.equal(readModelJson("I could not do that", "lines"), null);
});
