import assert from "node:assert/strict";
import test from "node:test";
import { readModelJson } from "./json.ts";

test("a bare run of scene objects with no wrapper is still a scene list", async () => {
  const { readSceneSpec } = await import("./scenespec.ts");
  const reply = `{"title":"ScallopBot","subtitle":"Self-hosted","seconds":3.5},
{"kind":"list","heading":"Why","items":["Memory","Routing"],"seconds":4},
{"kind":"cta","headline":"Start","action":"Get it","url":"https://scallopbot.com","seconds":3.5}`;
  const raw = readModelJson(reply, "scenes");
  assert.ok(raw && Array.isArray(raw.scenes) && raw.scenes.length === 3);
  const read = readSceneSpec(raw);
  assert.ok(read.spec);
  assert.deepEqual(read.spec!.scenes.map((s) => s.kind), ["title", "list", "cta"]);
  assert.ok(read.problems.some((p) => /named no kind/.test(p)));
});
