/**
 * Binary discovery — the part where a wrong answer is silent.
 *
 * Nothing here spawns anything. What is tested is the ORDER (a setting beats a
 * known prefix beats PATH), the refusal (a configured path that is not there
 * is an error, never a quiet fall-through to a different binary), and the one
 * case this file exists to fix: a binary named by TWO plugin settings, found
 * whichever of the two the owner used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setConfig, upsertPlugin } from "../db.ts";
import { findBinary, onPath, type ConfigKey } from "./find-binary.ts";

/** A directory with an executable file in it, standing in for a prefix a
 *  package manager wrote to. */
function prefixWith(name: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "opc-bin-"));
  const file = resolve(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return `${dir}/`;
}

const VIDEO: ConfigKey = { plugin: "test-video", key: "typst", label: "the Video settings" };
const PAPERS: ConfigKey = { plugin: "test-papers", key: "typst", label: "Papers" };

test("a configured path wins, and says which setting named it", () => {
  upsertPlugin(VIDEO.plugin, true, null);
  const prefix = prefixWith("typst");
  const configured = mkdtempSync(resolve(tmpdir(), "opc-bin-"));
  writeFileSync(resolve(configured, "typst"), "");
  setConfig(VIDEO.plugin, VIDEO.key, resolve(configured, "typst"));

  const got = findBinary({ name: "typst", candidates: [prefix], configKeys: [VIDEO] });
  assert.equal(got.found, true);
  assert.equal(got.path, resolve(configured, "typst"), "the setting beats the known prefix");
  assert.equal(got.source, "configured");
  assert.equal(got.via?.label, "the Video settings");
  setConfig(VIDEO.plugin, VIDEO.key, "");
});

test("the same binary is found whichever plugin the path was set under", () => {
  /* FINDING 33, EXACTLY. Typst was discovered under the video plugin's key by
     one area and under Papers' by another, so setting it under Papers left
     every video rendering captionless with a message telling you to install a
     typesetter you already had. One helper, both keys. */
  upsertPlugin(VIDEO.plugin, true, null);
  upsertPlugin(PAPERS.plugin, true, null);
  const dir = mkdtempSync(resolve(tmpdir(), "opc-bin-"));
  const bin = resolve(dir, "typst");
  writeFileSync(bin, "");
  const spec = { name: "typst", candidates: [] as string[], configKeys: [VIDEO, PAPERS] };

  for (const key of [VIDEO, PAPERS]) {
    setConfig(key.plugin, key.key, bin);
    const got = findBinary(spec);
    assert.equal(got.found, true, `set under ${key.label}`);
    assert.equal(got.path, bin);
    assert.equal(got.via?.plugin, key.plugin);
    setConfig(key.plugin, key.key, "");
  }
});

test("a configured path that is not there is an error, not a fall-through", () => {
  upsertPlugin(PAPERS.plugin, true, null);
  const prefix = prefixWith("typst");
  setConfig(PAPERS.plugin, PAPERS.key, "/nowhere/at/all/typst");

  const got = findBinary({ name: "typst", candidates: [prefix], configKeys: [PAPERS] });
  assert.equal(got.found, false, "the one on the prefix must NOT be used instead");
  assert.match(got.error ?? "", /configured under Papers/);
  assert.match(got.error ?? "", /is not there/);
  setConfig(PAPERS.plugin, PAPERS.key, "");
});

test("a candidate ending in a slash is a directory; anything else is a file", () => {
  const prefix = prefixWith("ffmpeg");
  const byPrefix = findBinary({ name: "ffmpeg", candidates: [prefix] });
  assert.equal(byPrefix.path, `${prefix}ffmpeg`);
  assert.equal(byPrefix.source, "known");

  /* The full-path form is how a macOS application bundle is named: its
     basename is nothing this would have composed from the binary's name. */
  const app = `${prefix}ffmpeg`;
  const byFile = findBinary({ name: "chromium", candidates: [app] });
  assert.equal(byFile.path, app);
});

test("aliases are tried in every directory, in order", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "opc-bin-"));
  writeFileSync(resolve(dir, "main"), "");
  const got = findBinary({
    name: "whisper-cli",
    aliases: ["whisper-cpp", "whisper", "main"],
    candidates: [`${dir}/`],
  });
  assert.equal(got.found, true);
  assert.equal(got.path, resolve(dir, "main"));
  /* The name it is still CALLED is the one that was asked for, so the sentence
     downstream does not start naming a hand-built checkout's file. */
  assert.equal(got.name, "whisper-cli");
});

test("nothing anywhere is a sentence naming where it looked and every place it may be set", () => {
  const got = findBinary({
    name: "nosuchtool",
    candidates: ["/nowhere/"],
    configKeys: [VIDEO, PAPERS],
    install: "brew install nosuchtool",
  });
  assert.equal(got.found, false);
  assert.match(got.error ?? "", /\/nowhere\/nosuchtool/);
  assert.match(got.error ?? "", /on PATH/);
  assert.match(got.error ?? "", /brew install nosuchtool/);
  assert.match(got.error ?? "", /the Video settings or Papers/);
});

test("onPath refuses a directory that happens to have the right name", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "opc-bin-"));
  mkdirSync(resolve(dir, "ffprobe"));
  const before = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.equal(onPath("ffprobe"), null, "a directory is not a binary");
    writeFileSync(resolve(dir, "yt-dlp"), "");
    assert.equal(onPath("yt-dlp"), resolve(dir, "yt-dlp"));
  } finally {
    process.env.PATH = before;
  }
});
