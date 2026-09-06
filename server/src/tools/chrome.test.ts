/**
 * The parts of the browser launcher that can be tested without a browser.
 *
 * NOTHING HERE SPAWNS CHROME. The machine running this may not have one — that
 * is the whole reason `findBrowser` returns a sentence rather than throwing —
 * and a test that needed one would fail on exactly the box the feature is
 * written to degrade gracefully on. What IS tested is everything either side
 * of the process: the flags, the profile directory's cleanup on BOTH paths out
 * of a run, the stderr filter, and the header reader whose five copies
 * measured the same picture three different ways.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../config.ts";
import {
  SHOT_FLOOR,
  SHOT_VIEWPORT,
  baseArgs,
  imageDimensions,
  reason,
  withProfile,
} from "./chrome.ts";

/* --------------------------------------------------------------- the flags */

test("the flags are the union of the four copies, and the window is the viewport", () => {
  const args = baseArgs({ profile: "/tmp/p" });
  for (const flag of [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-crash-reporter",
  ])
    assert.ok(args.includes(flag), `missing ${flag}`);
  assert.ok(args.includes(`--window-size=${SHOT_VIEWPORT.width},${SHOT_VIEWPORT.height}`));
  assert.ok(args.includes("--user-data-dir=/tmp/p"), "a profile of its own is not optional");
  /* The sheet renderer's addition: without it the file's pixel size is not the
     window size that was asked for, which is the thing the dimensions below
     are read to check. */
  assert.ok(args.includes("--force-device-scale-factor=1"));
});

test("a page with no network in it can turn off virtual time; a print asks for no header", () => {
  const local = baseArgs({ profile: "/tmp/p", virtualTimeMs: 0 });
  assert.ok(!local.some((a) => a.startsWith("--virtual-time-budget")));
  assert.ok(!local.includes("--no-pdf-header-footer"));

  const printed = baseArgs({ profile: "/tmp/p", printing: true, timeoutMs: 20_000 });
  assert.ok(printed.includes("--no-pdf-header-footer"));
  assert.ok(printed.includes("--timeout=20000"), "Chrome's own timeout follows the caller's budget");
});

/* ------------------------------------------------------------- the profile */

test("the profile directory is deleted on the way out — and on the way out through a throw", async () => {
  /* FINDING 31'S ACTUAL LEAK. One copy used a named directory keyed on the
     document's id and deleted it never, so a box that had printed four hundred
     papers carried four hundred Chrome profiles. */
  const base = resolve(DATA_DIR, "chrome-profile");
  const before = existsSync(base) ? readdirSync(base).length : 0;

  let kept = "";
  const got = await withProfile(async (dir) => {
    kept = dir;
    assert.ok(existsSync(dir), "the directory exists while the callback runs");
    return "done";
  });
  assert.equal(got, "done");
  assert.ok(!existsSync(kept), "gone after a success");

  let threwPath = "";
  await assert.rejects(
    withProfile(async (dir) => {
      threwPath = dir;
      throw new Error("the browser fell over");
    }),
    /the browser fell over/,
  );
  assert.ok(!existsSync(threwPath), "gone after a throw, which is the path that leaked");

  assert.equal(
    existsSync(base) ? readdirSync(base).length : 0,
    before,
    "no profile directory survives either run",
  );
});

test("two profiles at once are two directories, because Chrome locks one", () => {
  /* Chrome puts a ProcessSingleton lock in a profile and refuses to start a
     second instance against it. A shared directory is not tidiness, it is a
     capture that hangs until the wall-clock kill. */
  const seen: string[] = [];
  return Promise.all([
    withProfile(async (d) => void seen.push(d)),
    withProfile(async (d) => void seen.push(d)),
  ]).then(() => {
    assert.equal(new Set(seen).size, 2);
  });
});

/* ------------------------------------------------------------ the stderr */

test("the fault is the last line that is not GPU or font noise, without Chrome's prefix", () => {
  const stderr = [
    "[12345:259:0905/101112.123456:ERROR:gpu_init.cc(123)] Passthrough is not supported",
    "[12345:259:0905/101112.123456:ERROR:cv_display_link_mac.cc(1)] CVDisplayLinkCreate failed",
    "Fontconfig error: Cannot load default config file",
    "[12345:259:0905/101113.000000:ERROR:socket.cc(9)] Failed to create a ProcessSingleton for your profile directory.",
  ].join("\n");
  assert.equal(reason(stderr), "Failed to create a ProcessSingleton for your profile directory.");
});

test("stderr that is only noise reports nothing rather than a misleading line", () => {
  assert.equal(reason("[1:2:0905/1.1:ERROR:gpu_init.cc(1)] no gpu here\n"), null);
  assert.equal(reason(""), null);
});

/* --------------------------------------------------------- the dimensions */

/** A PNG header and nothing else — which is all any of the five copies read. */
function png(width: number, height: number, opts: { chunk?: string; signature?: number[] } = {}) {
  const sig = opts.signature ?? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const bytes = new Uint8Array(33);
  bytes.set(sig, 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([...(opts.chunk ?? "IHDR")].map((c) => c.charCodeAt(0)), 12);
  const be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  bytes.set(be(width), 16);
  bytes.set(be(height), 20);
  return bytes;
}

/** A JPEG with an APP0 segment in front of the frame header, so the walk has
 *  to skip a segment by its declared length rather than scan for 0xffc0. */
function jpeg(width: number, height: number) {
  const app0 = [0xff, 0xe0, 0x00, 0x08, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x00];
  const sof = [
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 255, height & 255,
    (width >> 8) & 255, width & 255,
    0x03,
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0x00, 0x00, 0x00, 0x00]);
}

test("a PNG's real size is read from its IHDR", () => {
  assert.deepEqual(imageDimensions(png(1280, 800)), { width: 1280, height: 800 });
  /* Not the viewport: a device pixel ratio or a page that forced a wider
     layout makes the file disagree with what was asked for, which is the
     entire reason it is measured rather than assumed. */
  assert.deepEqual(imageDimensions(png(2560, 1600)), { width: 2560, height: 1600 });
});

test("a JPEG is read too — four of the five copies could not", () => {
  assert.deepEqual(imageDimensions(jpeg(1080, 1920)), { width: 1080, height: 1920 });
});

test("the strict checks are kept: the whole signature, the IHDR chunk, and a non-zero size", () => {
  /* The loosest copy checked two bytes of the signature, so any file starting
     0x89 0x50 was measured as a PNG. */
  assert.equal(imageDimensions(png(10, 10, { signature: [0x89, 0x50, 0, 0, 0, 0, 0, 0] })), null);
  assert.equal(imageDimensions(png(10, 10, { chunk: "IDAT" })), null);
  assert.equal(imageDimensions(png(0, 800)), null, "a zero dimension is a corrupt header");
  assert.equal(imageDimensions(new Uint8Array(4)), null);
  assert.equal(imageDimensions(new Uint8Array(0)), null);
});

test("a format this cannot read is null and never a guess", () => {
  /* "RIFF....WEBP" — stored with null dimensions rather than with a number
     somebody would later compare against a floor. */
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(imageDimensions(webp), null);
});

test("the QA floor is derived from the viewport rather than typed beside it", () => {
  /* The check that uses it was calibrated against 1280x800 in a comment while
     importing nothing, so raising the viewport left the floor describing a
     window that no longer existed. */
  assert.equal(SHOT_FLOOR.width, SHOT_VIEWPORT.width / 2);
  assert.equal(SHOT_FLOOR.height, SHOT_VIEWPORT.height / 2);
  const shot = imageDimensions(png(SHOT_VIEWPORT.width, SHOT_VIEWPORT.height))!;
  assert.ok(shot.width >= SHOT_FLOOR.width && shot.height >= SHOT_FLOOR.height);
});
