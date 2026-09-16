import test from "node:test";
import assert from "node:assert/strict";
import { createRelayServer } from "./http.mjs";

test("relay authenticates every operation and exposes only rendering", async t => {
  let starts = 0;
  const key = "private-test-relay-key";
  const engine = {
    reelState: () => ({ items: [{ id: "reel-one", status: "done" }] }),
    reelRunning: () => false,
    reelCapabilities: async () => ({ reachable: false }),
    prepareReelScript: async body => ({ messages: [{ role: "user", content: body.prompt }] }),
    startReel: body => { starts++; return { ok: true, item: { id: "reel-two", script: body.script } }; },
    reelFile: file => file === "reel-one.mp4" ? { type: "video/mp4", bytes: Buffer.from("video") } : null,
  };
  const server = createRelayServer({ engine, key });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body) => fetch(base + path, {
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal((await fetch(base + "/agent/reel")).status, 401);
  assert.equal((await fetch(base + "/agent/reel/start", { method: "POST", body: "{}" })).status, 401);
  const state = await (await request("/agent/reel")).json();
  assert.equal(state.relay, "opc");
  assert.equal(state.externalScript, true);
  assert.equal(state.worker.reachable, false);
  assert.equal((await request("/agent/chat", {})).status, 404);
  assert.equal((await request("/agent/reel/telegram", {})).status, 404);
  assert.equal((await request("/agent/reel/start", { prompt: "Missing script" })).status, 400);
  assert.equal(starts, 0);
  const prepared = await (await request("/agent/reel/prepare-script", { prompt: "A topic" })).json();
  assert.equal(prepared.messages[0].content, "A topic");
  assert.equal((await request("/agent/reel/start", { script: { text: "prepared" } })).status, 200);
  assert.equal(starts, 1);
  const video = await request("/agent/reel/video/reel-one.mp4");
  assert.equal(video.headers.get("content-type"), "video/mp4");
  assert.equal(await video.text(), "video");
  assert.equal((await request("/agent/reel/video/..%2fsecret.mp4")).status, 404);
  assert.equal((await request("/agent/reel/video/missing.mp4")).status, 404);
  assert.equal((await request("/agent/reel/prepare-script", { prompt: "x".repeat(130_000) })).status, 400);
});
