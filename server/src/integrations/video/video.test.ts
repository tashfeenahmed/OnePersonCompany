/**
 * The pure parts of the video area, tested the way this codebase tests
 * anything: the things a model or a website hands over and this server has to
 * read without trusting.
 *
 * NOTHING HERE SPAWNS FFMPEG OR CALLS PEXELS. Those are verified by running a
 * real video — see the README — and a test that shelled out to an encoder
 * would be a test that fails on a machine without one, which is exactly the
 * machine this area is written to degrade gracefully on. What IS tested is
 * every parser between the outside world and a decision: a model's JSON, a
 * website's WebVTT, and the filter listing whose format cost a real bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readScript, readWindows, beatCount } from "./script.ts";
import { readVtt, groupCues, renderCues } from "./shorts.ts";
import { wrap } from "./captions.ts";
import { fitGraph, blurFilter } from "./assemble.ts";
import { readFormat } from "./execute.ts";
import { wall, validZone } from "./autopilot.ts";

/* ------------------------------------------------------------ the script */

const SCRIPT = JSON.stringify({
  title: "A short film",
  hook: { caption: "Nobody reads the paperwork", voiceover: "Long form", terms: ["stack of paper"] },
  beats: [
    { caption: "One", voiceover: "First", terms: ["a", "b"] },
    { caption: "Two", voiceover: "Second", terms: ["c"] },
    { caption: "Three", voiceover: "Third", terms: ["d"] },
  ],
  cta: { caption: "Go to the site", voiceover: "Please", terms: ["mouse click"] },
});

test("a script is read out of a bare object, a fence, or prose around one", () => {
  for (const text of [SCRIPT, "```json script\n" + SCRIPT + "\n```", "Here you go:\n" + SCRIPT + "\nHope that helps."]) {
    const s = readScript(text, "brief", 5, 30);
    assert.ok(s, "should have parsed");
    assert.equal(s.title, "A short film");
    assert.equal(s.beats.length, 5);
    assert.equal(s.beats[0]!.role, "hook");
    assert.equal(s.beats.at(-1)!.role, "cta");
  }
});

test("a script with more beats than were asked for is trimmed, not refused", () => {
  /* The model wrote five middle beats; three were asked for including hook and
     CTA, so one middle beat survives and the video is the length that was
     typed. See readScript. */
  const s = readScript(SCRIPT, "brief", 3, 20);
  assert.ok(s);
  assert.equal(s.beats.length, 3);
  assert.deepEqual(s.beats.map((b) => b.role), ["hook", "beat", "cta"]);
});

test("the length is shared out by this server and never by the model", () => {
  const s = readScript(SCRIPT, "brief", 5, 30)!;
  const total = s.beats.reduce((n, b) => n + b.seconds, 0);
  /* Three seconds of end card come off the top; the rest is split evenly. */
  assert.ok(Math.abs(total - 27) < 0.2, `beats total ${total}s, expected about 27`);
  assert.ok(s.beats.every((b) => b.seconds >= 2), "no beat under two seconds");
});

test("a beat with no terms falls back to its own caption rather than losing the script", () => {
  const s = readScript(
    JSON.stringify({ hook: { caption: "Nobody reads the paperwork" }, beats: [{ caption: "One" }] }),
    "brief",
    3,
    20,
  );
  assert.ok(s);
  assert.deepEqual(s.beats[0]!.terms, ["Nobody reads the"]);
});

test("a reply with no captions anywhere is not a script", () => {
  assert.equal(readScript("I would be happy to help you write a video script!", "b", 5, 30), null);
  assert.equal(readScript(JSON.stringify({ beats: [{ voiceover: "words" }] }), "b", 5, 30), null);
});

test("beatCount follows from the length and is clamped at both ends", () => {
  assert.equal(beatCount(30), 5);
  assert.equal(beatCount(10), 3);
  assert.equal(beatCount(1), 3);
  assert.equal(beatCount(600), 10);
});

/* ----------------------------------------------------------- the windows */

test("windows are clamped to the file rather than trusted", () => {
  const raw = JSON.stringify({
    clips: [
      { title: "A", reason: "because", start: 10, end: 400 },
      { title: "B", reason: "also", start: 500, end: 520 },
    ],
  });
  const w = readWindows(raw, 300, 45, 4);
  assert.equal(w.length, 2);
  /* The first asked for 390 seconds; the cap is 45. */
  assert.equal(w[0]!.end - w[0]!.start, 45);
  /* The second starts past the end of the file and is pulled back inside it. */
  assert.ok(w[1]!.end <= 300, `end ${w[1]!.end} should be inside a 300s file`);
});

test("overlapping windows are dropped, and mm:ss is accepted as well as seconds", () => {
  const w = readWindows(
    JSON.stringify({ clips: [{ title: "A", start: "1:00", end: "1:30" }, { title: "B", start: 70, end: 100 }] }),
    600,
    60,
    4,
  );
  assert.equal(w.length, 1);
  assert.equal(w[0]!.start, 60);
  assert.equal(w[0]!.end, 90);
});

test("a reply with no windows is an empty list, which is what makes the caller cut at intervals", () => {
  assert.deepEqual(readWindows("I could not find any good moments.", 300, 45, 3), []);
});

/* -------------------------------------------------------------- WebVTT */

const VTT = `WEBVTT
Kind: captions
Language: en

NOTE this is not a cue

00:00:01.000 --> 00:00:03.500
<c>Hello</c> and welcome

00:00:03.500 --> 00:00:05.000
Hello and welcome to the show

00:00:06.000 --> 00:00:08.000
Something &amp; something else
`;

test("WebVTT is read, tags and entities are stripped, and rolling duplicates collapse", () => {
  const cues = readVtt(VTT);
  assert.equal(cues.length, 2, "the rolling repeat should have folded into one cue");
  assert.equal(cues[0]!.text, "Hello and welcome to the show");
  assert.equal(cues[0]!.start, 1);
  assert.equal(cues[0]!.end, 5);
  assert.equal(cues[1]!.text, "Something & something else");
});

test("the transcript the model reads carries the second each line starts", () => {
  assert.equal(renderCues(readVtt(VTT)), "[1] Hello and welcome to the show\n[6] Something & something else");
});

test("cues are grouped into readable cards and clipped to the window", () => {
  const cues = [
    { start: 0, end: 1, text: "one" },
    { start: 1, end: 2, text: "two" },
    { start: 2, end: 3, text: "three" },
    { start: 30, end: 31, text: "outside" },
  ];
  const g = groupCues(cues, 0, 10);
  /* The cue outside the window is gone. The first two fit inside 2.6 seconds
     and become one card; the third would push the card to three seconds, which
     is longer than a caption should hold, so it starts a new one. */
  assert.equal(g.length, 2, g.map((c) => c.text).join(" | "));
  assert.equal(g[0]!.text, "one two");
  assert.equal(g[1]!.text, "three");
  assert.ok(g.every((c) => c.end <= 10), "nothing runs past the window");
});

/* ------------------------------------------------------------- captions */

test("wrapping breaks on words, never mid-word, and stops at four lines", () => {
  const lines = wrap("the quick brown fox jumps over the lazy dog and keeps on running for ever and ever", 20);
  assert.ok(lines.length <= 4);
  assert.ok(lines.every((l) => l.length <= 20), lines.join(" | "));
  assert.ok(lines.every((l) => !l.startsWith(" ") && !l.endsWith(" ")));
});

/* -------------------------------------------------------------- ffmpeg */

test("the fit graph is one fragment from a labelled input to a labelled output", () => {
  const cover = fitGraph({ fit: "cover", width: 1080, height: 1920, blur: null, pad: "#111111", inLabel: "0:v", outLabel: "v0" });
  assert.ok(cover.startsWith("[0:v]") && cover.endsWith("[v0]"));
  assert.ok(!cover.includes(";"), "cover is a single chain");

  const box = fitGraph({ fit: "letterbox", width: 1080, height: 1920, blur: "gblur=sigma=28", pad: "#111111", inLabel: "0:v", outLabel: "v0" });
  assert.ok(box.startsWith("[0:v]") && box.endsWith("[v0]"));
  assert.ok(box.includes("split=2") && box.includes("gblur"), "the letterbox splits and blurs");

  /* With no blur filter on the build it pads with the venture's colour rather
     than failing — and it is still one fragment with the same two labels. */
  const flat = fitGraph({ fit: "letterbox", width: 1080, height: 1920, blur: null, pad: "#c1663f", inLabel: "0:v", outLabel: "v0" });
  assert.ok(flat.includes("pad=1080:1920") && flat.includes("#c1663f"));
  assert.ok(!flat.includes("split"));
});

test("the blur filter is whichever of the three the build has, in that order", () => {
  assert.equal(blurFilter(new Set(["gblur", "boxblur"])), "gblur=sigma=28");
  assert.equal(blurFilter(new Set(["boxblur"])), "boxblur=20:2");
  assert.equal(blurFilter(new Set()), null);
});

/* --------------------------------------------------------------- inputs */

test("an unknown format is faceless rather than a failure", () => {
  assert.equal(readFormat("shorts"), "shorts");
  assert.equal(readFormat("SHORTS"), "shorts");
  assert.equal(readFormat(""), "faceless");
  assert.equal(readFormat(undefined), "faceless");
  assert.equal(readFormat("reels"), "faceless");
});

/* ------------------------------------------------------------- the clock */

test("the wall clock is read out of Intl so daylight saving is never modelled here", () => {
  /* Midday UTC on a summer day: one hour ahead in Dublin, five behind in New
     York — and on the New York side that is still the previous calendar day
     only if the instant is early enough, which this one is not. */
  const at = new Date("2026-07-01T12:00:00Z");
  assert.deepEqual(wall("UTC", at), { day: "2026-07-01", hour: 12 });
  assert.deepEqual(wall("Europe/Dublin", at), { day: "2026-07-01", hour: 13 });
  assert.deepEqual(wall("America/New_York", at), { day: "2026-07-01", hour: 8 });
  /* Just after midnight UTC is still the day before in New York. */
  assert.deepEqual(wall("America/New_York", new Date("2026-07-02T01:00:00Z")), { day: "2026-07-01", hour: 21 });
});

test("a time zone this machine does not know is refused rather than silently ignored", () => {
  assert.equal(validZone("Europe/Dublin"), true);
  assert.equal(validZone("Mars/Olympus"), false);
});
