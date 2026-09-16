import { test } from "node:test";
import assert from "node:assert/strict";
import { models } from "../../routes/models.ts";
import { complete, registerProvider } from "../../models/provider.ts";
import { writeSceneSpec } from "./motion.ts";
import { DEFAULT_LIMITS } from "./scenespec.ts";

test("Motion recovers a reasoning-only answer with one validated correction, without changing ordinary chat", async () => {
  const original = globalThis.fetch;
  const sent: Record<string, unknown>[] = [];
  const valid = { title: "A short introduction", scenes: [{ kind: "title", title: "Meet your workspace", seconds: 2 }] };
  let replies: (string | null)[] = [];
  let abortAfterReply: AbortController | null = null;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    const content = replies.shift() ?? null;
    abortAfterReply?.abort();
    return Response.json({ model: body.model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 6 } });
  };
  const opts = { venture: null, brief: "Introduce the workspace", aspect: "9:16", limits: DEFAULT_LIMITS };
  try {
    registerProvider("freellmapi", () => ({ id: "freellmapi", label: "Test", defaultModel: "test-model", endpoints: [{ baseUrl: "https://motion.invalid/v1", key: null, label: "Test" }], policy: { mode: "parallel", concurrency: 4, balance: "round-robin", timeoutMs: 1000 } }));
    const saved = await models.request("/provider", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "freellmapi" }) });
    assert.equal(saved.status, 200);

    replies = ["First, I need to create a JSON object. Let me think about the cards.", JSON.stringify(valid)];
    assert.deepEqual((await writeSceneSpec(opts)).raw, valid);
    assert.equal(sent.length, 2);
    assert.match(JSON.stringify(sent[1]!.messages), /previous answer was rejected:.*not an object/i);
    assert.deepEqual(sent[0]!.response_format, { type: "json_object" });
    assert.equal(sent[0]!.reasoning_effort, "none");
    assert.equal(sent[0]!.reasoning, undefined);
    assert.equal(sent[0]!.chat_template_kwargs, undefined);
    assert(sent.every(body => body.model === "test-model" && Number(body.max_tokens) > 0));

    sent.length = 0; replies = [JSON.stringify(valid)];
    await writeSceneSpec(opts);
    assert.equal(sent.length, 1);

    sent.length = 0; replies = [null, JSON.stringify({ scenes: [{ kind: "unknown" }] })];
    await assert.rejects(writeSceneSpec(opts), /after two attempts.*No rendering was started/);
    assert.equal(sent.length, 2);

    sent.length = 0; replies = ["Still thinking"];
    abortAfterReply = new AbortController();
    await assert.rejects(writeSceneSpec({ ...opts, signal: abortAfterReply.signal }), { name: "AbortError" });
    assert.equal(sent.length, 1);
    abortAfterReply = null;

    sent.length = 0; replies = ["Ordinary chat"];
    assert.equal((await complete([{ role: "user", content: "hello" }])).text, "Ordinary chat");
    assert.equal(sent[0]!.response_format, undefined);
    assert.equal(sent[0]!.reasoning_effort, undefined);
    assert.equal(sent[0]!.reasoning, undefined);
    assert.equal(sent[0]!.chat_template_kwargs, undefined);
  } finally { globalThis.fetch = original; }
});
