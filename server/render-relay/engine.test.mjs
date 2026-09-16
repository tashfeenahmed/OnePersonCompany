import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("only workspace-written scripts enter the isolated durable queue", async () => {
  assert.ok(process.env.OPC_DATA_DIR?.includes("opc-test-"), "Run with server/test/setup.mjs");
  const root = join(process.env.OPC_DATA_DIR, "render-relay");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "settings.json"), JSON.stringify({ host: "127.0.0.1", mac: "00:00:00:00:00:00",
    user: "test", powerKey: "/nonexistent/test-key", llmUrl: "http://127.0.0.1:1/v1", workerUrl: "http://127.0.0.1:1" }));
  const engine = await import("./engine/reel.js");
  assert.equal(engine.startReel({ prompt: "Without script" }).ok, false);
  assert.equal(engine.startReel({ prompt: "Invalid", script: { text: "[]" } }).ok, false);
  assert.equal(engine.reelRunning(), false);
  const lines = Array.from({ length: 6 }, (_, i) => ({ character: i % 2 ? "Stewie" : "Peter", text: `Line ${i + 1}.` }));
  const result = engine.startReel({ prompt: "Verification", mode: "images", script: { text: JSON.stringify(lines), provider: "workspace" } });
  assert.equal(result.ok, true);
  assert.equal(result.item.status, "queued");
  assert.equal(engine.reelRunning(), true);
  assert.equal(engine.startReel({ prompt: "Second", script: { text: JSON.stringify(lines) } }).ok, false);
  const state = JSON.parse(readFileSync(join(root, "queue.json"), "utf8"));
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].kind, "reel");
  assert.equal(state.items[0].status, "pending");
  assert.equal(state.items[0].attempts, 0); // Enqueue does not wake or call the worker.
});
