import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gameplayBackgrounds, gameplayPreviewDirectory, gameplayThumbnail, importGameplayPreviews, readGameplayPreviews } from "./gameplay-previews.ts";
import { gameplayLabel, isGameplayName } from "../../../../shared/gameplay.ts";
import { DATA_DIR } from "../../config.ts";
import { findFfmpeg, run } from "../video/tools.ts";
import { stewieRoutes } from "./stewie-routes.ts";
import { upsertPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";

const agent = "https://render-agent.example.test";
const file = "a".repeat(24) + ".jpg";
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
function seed() {
  const dir = gameplayPreviewDirectory(agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, file), bytes);
  writeFileSync(resolve(dir, "catalogue.json"), JSON.stringify([{ id: "subway_surfers", file }, { id: "fruit_ninja", file }]));
  return dir;
}

test("the saved catalogue loads without probing the remote render worker", async t => {
  seed();
  upsertPlugin("workdash", true, null);
  const account = accounts.create("workdash", "Test renderer");
  accounts.writeCredentials(account, "workdash", ["url", "key"], { url: agent, key: "test-key" });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("A catalogue read must not contact the worker"); });
  const response = await stewieRoutes.request("/backgrounds");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, max-age=60");
  const body = await response.json() as { backgrounds: { id: string }[] };
  assert.deepEqual(body.backgrounds.map(item => item.id), ["subway_surfers", "fruit_ninja"]);
  const preview = await stewieRoutes.request("/backgrounds/fruit_ninja/thumbnail");
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("Cache-Control")!, /private/);
  accounts.remove(account);
});

test("sleeping workers retain selectable cached footage, served through local authenticated image routes", () => {
  seed();
  const result = gameplayBackgrounds(agent);
  assert.deepEqual(result.map(item => [item.id, item.label]), [["subway_surfers", "Subway Surfers"], ["fruit_ninja", "Fruit Ninja"]]);
  assert.match(result[0]!.thumbnailUrl!, /^\/api\/stewie\/backgrounds\/subway_surfers\/thumbnail\?v=/);
  assert.ok(!JSON.stringify(result).includes(agent));
  assert.deepEqual(gameplayThumbnail(agent, "subway_surfers"), bytes);
  assert.deepEqual(gameplayBackgrounds(agent + "/"), result);
});

test("the live roster overrides cached clips, including an empty roster and a new clip without a preview", () => {
  seed();
  assert.deepEqual(gameplayBackgrounds(agent, []).map(item => item.id), []);
  const result = gameplayBackgrounds(agent, ["new_game", "subway_surfers", "new_game"]);
  assert.deepEqual(result.map(item => item.id), ["new_game", "subway_surfers"]);
  assert.equal(result[0]!.thumbnailUrl, null);
  assert.ok(result[1]!.thumbnailUrl);
});

test("agent catalogues cannot leak into another connection", () => {
  seed();
  const other = "https://another-agent.example.test";
  assert.deepEqual(gameplayBackgrounds(other), []);
  assert.equal(gameplayThumbnail(other, "subway_surfers"), null);
  assert.deepEqual(gameplayBackgrounds(other, ["subway_surfers"]), [{ id: "subway_surfers", label: "Subway Surfers", thumbnailUrl: null }]);
});

test("clip names and catalogue paths cannot traverse out of the preview directory", () => {
  const dir = seed();
  for (const name of ["../vault", "foo/bar", "foo\\bar", "%2fetc", "", ".hidden", "x".repeat(121)]) {
    assert.equal(isGameplayName(name), false);
    assert.equal(gameplayThumbnail(agent, name), null);
  }
  writeFileSync(resolve(dir, "catalogue.json"), JSON.stringify([{ id: "escape", file: "../../vault.key" }]));
  assert.deepEqual(readGameplayPreviews(agent), []);
  assert.equal(gameplayThumbnail(agent, "escape"), null);
});

test("missing or damaged previews fail gracefully instead of exposing a broken image", () => {
  const dir = seed();
  rmSync(resolve(dir, file));
  assert.deepEqual(gameplayBackgrounds(agent, ["subway_surfers"]), [{ id: "subway_surfers", label: "Subway Surfers", thumbnailUrl: null }]);
  writeFileSync(resolve(dir, "catalogue.json"), "broken JSON");
  assert.deepEqual(gameplayBackgrounds(agent), []);
  assert.equal(gameplayThumbnail(agent, "subway_surfers"), null);
});

test("readable labels preserve the exact worker IDs used by the selector", () => {
  assert.equal(gameplayLabel("roblox_obby"), "Roblox Obby");
  assert.equal(gameplayLabel("my-game 2"), "My Game 2");
  assert.equal(isGameplayName("my-game 2"), true);
});

test("thumbnail import handles short clips and preserves the catalogue if a later import fails", async t => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg.path) return t.skip("FFmpeg is not installed on this test host.");
  const source = resolve(DATA_DIR, "gameplay-test-source");
  mkdirSync(source, { recursive: true });
  const clip = await run(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "color=c=blue:s=32x64:d=0.4", "-an", "-c:v", "mpeg4", resolve(source, "custom_clip.mp4")]);
  assert.equal(clip.ok, true, clip.error ?? clip.stderr);
  const importedAgent = "https://custom-worker.example.test";
  assert.deepEqual(await importGameplayPreviews(importedAgent, source), ["custom_clip"]);
  const before = gameplayBackgrounds(importedAgent);
  assert.deepEqual(gameplayThumbnail(importedAgent, "custom_clip")?.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  writeFileSync(resolve(source, "broken.mp4"), "not a video");
  await assert.rejects(importGameplayPreviews(importedAgent, source), /previous catalogue is unchanged/);
  assert.deepEqual(gameplayBackgrounds(importedAgent), before);
});
