import { test } from "node:test";
import assert from "node:assert/strict";
import { models } from "../routes/models.ts";
import { readModelProvider } from "../routes/pluginConfig.ts";
import { registerProvider, complete, completeTooled, type ProviderId } from "./provider.ts";
import { writeStewieScript } from "../integrations/videoplus/stewie-script.ts";

test("saved workspace choice routes chat, tool calls and Stewie scripts across all four providers", async () => {
  const original = globalThis.fetch;
  const ids: ProviderId[] = ["freellmapi", "openrouter", "local", "openai"];
  let text = "test answer";
  const sent: { url: string; model: string }[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(url), model: body.model });
    return Response.json({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], model: body.model, usage: { prompt_tokens: 4, completion_tokens: 6 } });
  };
  try {
    for (const id of ids) registerProvider(id, () => ({ id, label: id, defaultModel: `test-${id}`, endpoints: [{ baseUrl: `https://${id}.invalid/v1`, key: null, label: "Test" }], policy: { mode: "parallel", concurrency: 4, balance: "round-robin", timeoutMs: 1000 } }));
    for (const id of ids) {
      const saved = await models.request("/provider", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: id }) });
      assert.equal(saved.status, 200); assert.equal(((await saved.json()) as { chosen: string }).chosen, id);
      assert.equal(readModelProvider(), id);
      text = "test answer";
      assert.equal((await complete([{ role: "user", content: "hello" }])).provider, id);
      assert.equal((await completeTooled([{ role: "user", content: "hello" }])).provider, id);
      text = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ character: i % 2 ? "Stewie" : "Peter", text: `Line ${i + 1}.`, image_search: "computer" })));
      const script = await writeStewieScript({ messages: [{ role: "user", content: "Write six lines" }], grounded: false, sources: [] });
      assert.equal(script.provider, id); assert.equal(script.model, `test-${id}`);
      assert(sent.slice(-3).every(call => call.url === `https://${id}.invalid/v1/chat/completions` && call.model === `test-${id}`));
    }
    text = "not a script";
    await assert.rejects(writeStewieScript({ messages: [{ role: "user", content: "write" }], grounded: false, sources: [] }), /No render was started/);
    const count = sent.length;
    const bad = await models.request("/provider", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "unknown" }) });
    assert.equal(bad.status, 400); assert.equal(readModelProvider(), "openai");
    await models.request("/provider", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: null }) });
    await assert.rejects(complete([{ role: "user", content: "hello" }]));
    await assert.rejects(writeStewieScript({ messages: [{ role: "user", content: "write" }], grounded: false, sources: [] }));
    assert.equal(sent.length, count);
  } finally { globalThis.fetch = original; }
});
