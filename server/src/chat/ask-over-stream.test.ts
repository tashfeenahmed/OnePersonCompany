import assert from "node:assert/strict";
import test from "node:test";
import { activeBackend, registerBackend, setChoiceReader, type ChatStreamEvent } from "./backend.ts";
import { registerProvider, setProviderChoiceReader } from "../models/provider.ts";

test("the non-streaming door reads the agent's stream, and a timeout hangs up on it", async () => {
  /* A workspace model allowed 5s a completion… but never less than the 60s floor,
     so the deadline is driven by the caller's own signal here. */
  registerProvider("local", () => ({
    id: "local", label: "Local", endpoints: [{ baseUrl: "http://127.0.0.1:1/v1", key: null, label: "x" }],
    defaultModel: "m", policy: { mode: "series", concurrency: 1, balance: "round-robin", timeoutMs: 5_000 },
  }) as never);
  setProviderChoiceReader(() => "local");

  let hungUp = false;
  let plainAsks = 0;
  let slow = false;
  registerBackend("hermes", () => ({
    id: "hermes",
    label: "Hermes · test",
    async ask() { plainAsks++; return { text: "plain", backend: "hermes", model: null, usage: null, ms: 1 }; },
    async *stream(_turns, opts): AsyncGenerator<ChatStreamEvent> {
      yield { type: "delta", text: "Dis" };
      if (slow) {
        await new Promise<void>((_, reject) => opts?.signal?.addEventListener("abort", () => { hungUp = true; reject(new Error("aborted")); }));
      }
      yield { type: "delta", text: "patched." };
      yield { type: "done", text: "Dispatched.", model: "m", usage: { prompt: 3, completion: 2 }, ms: 7 };
    },
  }));
  setChoiceReader(() => "hermes");

  const reply = await activeBackend()!.ask([{ role: "user", content: "go" }]);
  assert.deepEqual([reply.text, reply.model, reply.backend], ["Dispatched.", "m", "hermes"]);
  assert.equal(plainAsks, 0);

  slow = true;
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  await assert.rejects(activeBackend()!.ask([{ role: "user", content: "go" }], { signal: stop.signal }));
  assert.equal(hungUp, true);
});
