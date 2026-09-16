import { test } from "node:test";
import assert from "node:assert/strict";
import { shortsClipCount } from "../../../../shared/studioInputs.ts";
import { readScript, readWindows, writeScript, pickWindows } from "./script.ts";
import { registerProvider, setProviderChoiceReader } from "../../models/provider.ts";
import { createPost, studioRoutes, setDefaultReferencePicker, setReferenceResolver } from "../ventures/studio.ts";
import { ventureRoutes } from "../../routes/ventures.ts";
import { socialfeedRoutes } from "../socialfeed/routes.ts";
import { db, upsertPlugin } from "../../db.ts";
import * as accounts from "../../accounts.ts";

const init = (data: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const rawScript = { title: "Lisbon", hook: { caption: "Look beyond the crowds", terms: ["Lisbon"], seconds: 7 }, beats: [{ caption: "Walk the side streets", seconds: 900 }, { caption: "Pause for a view", seconds: -1 }], cta: { caption: "Which would you try?", seconds: 4 } };

test("Shorts honors a single clip and five clips through parsing and window selection", () => {
  assert.equal(shortsClipCount(undefined), 1);
  for (const [raw, expected] of [["1", 1], ["5", 5], ["99", 5], ["bad", 1], [NaN, 1], [-3, 1]] as const)
    assert.equal(shortsClipCount(raw), expected);
  const raw = JSON.stringify({ clips: Array.from({ length: 6 }, (_, i) => ({ start: i * 50, end: i * 50 + 30 })) });
  assert.equal(readWindows(raw, 400, 45, shortsClipCount("1")).length, 1);
  assert.equal(readWindows(raw, 400, 45, shortsClipCount("5")).length, 5);
});

test("automatic faceless timing keeps model pacing within bounds and explicit duration still wins", () => {
  const auto = readScript(JSON.stringify(rawScript), "Lisbon", 10, null)!;
  assert.equal(auto.beats.length, 4);
  assert.deepEqual(auto.beats.map(b => b.seconds), [7, 10, 3, 4]);
  const fixed = readScript(JSON.stringify(rawScript), "Lisbon", 4, 43)!;
  assert.deepEqual(fixed.beats.map(b => b.seconds), [10, 10, 10, 10]);
  const standalone = readScript(JSON.stringify(rawScript), "Lisbon", 4, 40, 0)!;
  assert.equal(standalone.beats.reduce((sum, beat) => sum + beat.seconds, 0), 40);
});

test("automatic inputs use workspace AI, preserve explicit briefs, and queue reference-free UGC without rendering", async (t) => {
  registerProvider("local", () => ({ id: "local", label: "Mock", defaultModel: "mock", endpoints: [{ baseUrl: "https://studio.invalid/v1", key: null, label: "Mock" }], policy: { mode: "series", concurrency: 1, balance: "round-robin", timeoutMs: 1000 } }));
  setProviderChoiceReader(() => "local");
  const calls: { messages: { content: string }[] }[] = [];
  let answer = JSON.stringify(rawScript);
  t.mock.method(globalThis, "fetch", async (url: unknown, req: RequestInit) => {
    assert.equal(String(url), "https://studio.invalid/v1/chat/completions", "No paid generation or other network calls are allowed");
    calls.push(JSON.parse(String(req.body)));
    return Response.json({ choices: [{ message: { content: answer } }], model: "mock" });
  });
  const script = await writeScript({ venture: null, brief: "Hidden corners of Lisbon", seconds: null });
  assert.equal(script.script.title, "Lisbon");
  assert.match(calls.at(-1)!.messages[0]!.content, /Choose 1 to 8/);
  assert.match(calls.at(-1)!.messages[1]!.content, /No business selected/);
  answer = JSON.stringify({ clips: [{ title: "One thought", start: 0, end: 30 }] });
  assert.equal((await pickWindows({ transcript: "0:00 One complete thought", duration: 200, want: 1, maxSeconds: 45, brief: "" })).windows.length, 1);
  assert.match(calls.at(-1)!.messages[0]!.content, /up to 1 clip, at least one/);

  const res = await ventureRoutes.request("/", init({ name: "Input test venture", description: "Makes weekly reading lists", stage: "launched" }));
  assert.equal(res.status, 201);
  const v = await res.json() as { id: string };
  answer = JSON.stringify({ brief: "Introduce the weekly reading list" });
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, req: RequestInit) => {
    assert.equal(String(url), "https://studio.invalid/v1/chat/completions");
    calls.push(JSON.parse(String(req.body)));
    modelCalls++;
    return Response.json({ choices: [{ message: { content: modelCalls === 1 ? answer : "CAPTION:\nA weekly reading list.\nHASHTAGS:\n#reading" } }], model: "mock" });
  });
  const post = await createPost({ ventureId: v.id, brief: "", format: "square" });
  assert.equal(post.ok, true);
  assert.equal(post.post.brief, "Introduce the weekly reading list");
  assert.match(post.post.imagePrompt!, /weekly reading list/);
  assert.equal(modelCalls, 2, "Topic is chosen before writing the caption; no image key is configured");
  await createPost({ ventureId: v.id, brief: "Use my exact topic", format: "square" });
  assert.equal(modelCalls, 3, "An explicit brief must skip topic generation");
  answer = '{"brief":""}'; modelCalls = 0;
  const bad = await createPost({ ventureId: v.id, brief: "" });
  assert.equal(bad.ok, false);
  assert.equal(modelCalls, 1, "Invalid model topic must not continue to paid generation");

  const selections: string[][] = [];
  setDefaultReferencePicker(() => ["rotating-reference"]);
  setReferenceResolver(async (_venture, ids) => {
    selections.push(ids);
    return { dataUrls: [], field: null, many: false, texts: ["Keep the blue hands"], note: "fixture" };
  });
  const auto = await studioRoutes.request("/posts", init({ ventureId: v.id, brief: "Explicit topic" }));
  assert.equal(auto.status, 201);
  assert.deepEqual(selections, [["rotating-reference"]], "Omitted assetIds must reach the automatic picker through HTTP");
  const none = await studioRoutes.request("/posts", init({ ventureId: v.id, brief: "Explicit topic", assetIds: [] }));
  assert.equal(none.status, 201);
  assert.equal(selections.length, 1, "An explicit empty selection opts out");
  setDefaultReferencePicker(() => []);
  modelCalls = 1;

  upsertPlugin("openrouter", true);
  const account = accounts.create("openrouter", "Fake test account");
  accounts.writeCredentials(account, "test", ["chat-key"], { "chat-key": "not-a-real-key" });
  const noPrompt = await socialfeedRoutes.request("/ugc/start", init({ venture: v.id }));
  assert.equal(noPrompt.status, 400);
  assert.match(await noPrompt.text(), /Describe the opening shot/);
  const ugc = await socialfeedRoutes.request("/ugc/start", init({ venture: v.id, brief: "A reader holding a book near a window", assets: [] }));
  assert.equal(ugc.status, 201, await ugc.clone().text());
  const queued = await ugc.json() as { run: { id: string } };
  const row = db.prepare("SELECT input FROM agent_runs WHERE id = ?").get(queued.run.id) as { input: string };
  assert.equal(JSON.parse(row.input).brief, "A reader holding a book near a window");
  assert.equal(modelCalls, 1, "Queueing must not generate an image or video");
  const foreign = await socialfeedRoutes.request("/ugc/start", init({ venture: v.id, brief: "Scene", assets: ["another-ventures-photo"] }));
  assert.equal(foreign.status, 400);
  assert.match(await foreign.text(), /Not assets/);
});
