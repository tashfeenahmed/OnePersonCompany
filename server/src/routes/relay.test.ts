import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { agentKey, SERVICE_HEADER, serviceKey } from "../auth.ts";
import { registerProvider, setProviderChoiceReader, type ModelProvider, type Policy } from "../models/provider.ts";
import { relay } from "./relay.ts";

/**
 * A FAKE UPSTREAM that records how many requests it is serving at once, holds
 * each for a moment, and answers in the OpenAI shape — streamed when asked.
 * The relay's whole claim is that two calls through it on a "series" provider
 * never overlap upstream, so the number this server measures is the test.
 */
let upstream: Server;
let base = "";
let inFlight = 0;
let peak = 0;
let seenModels: string[] = [];
let seenAuth: string[] = [];
const HOLD_MS = 120;

before(async () => {
  upstream = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      seenAuth.push(req.headers.authorization ?? "");
      if (req.url === "/v1/models") {
        inFlight -= 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: "fake-7b" }] }));
        return;
      }
      const body = JSON.parse(raw) as { model?: string; stream?: boolean };
      seenModels.push(body.model ?? "");
      setTimeout(() => {
        inFlight -= 1;
        if (body.stream) {
          res.setHeader("content-type", "text/event-stream");
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " there" } }] })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello" } }], model: body.model }));
        }
      }, HOLD_MS);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const addr = upstream.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}/v1`;
});

after(() => upstream.close());

function fake(policy: Policy): ModelProvider {
  return {
    id: "local",
    label: "Fake local",
    endpoints: [{ label: "fake", baseUrl: base, key: "upstream-secret" }],
    defaultModel: null,
    policy,
  };
}

function useProvider(p: ModelProvider | null) {
  registerProvider("local", () => p);
  setProviderChoiceReader(() => "local");
}

function reset() {
  inFlight = 0;
  peak = 0;
  seenModels = [];
  seenAuth = [];
}

const SERIES: Policy = { mode: "series", concurrency: 1, balance: "round-robin", timeoutMs: 10_000 };
const PARALLEL: Policy = { mode: "parallel", concurrency: 4, balance: "round-robin", timeoutMs: 10_000 };

function post(body: unknown, key = agentKey()) {
  return relay.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

test("the relay takes the agent key or the owner key and nothing else", async () => {
  useProvider(fake(SERIES));
  const none = await relay.request("/v1/chat/completions", { method: "POST", body: "{}" });
  assert.equal(none.status, 401);
  const wrong = await post({ messages: [] }, "not-a-key");
  assert.equal(wrong.status, 401);
  const owner = await relay.request("/v1/models", { headers: { [SERVICE_HEADER]: serviceKey() } });
  assert.equal(owner.status, 200);
  const agent = await relay.request("/v1/models", { headers: { Authorization: `Bearer ${agentKey()}` } });
  assert.equal(agent.status, 200);
  const doc = (await agent.json()) as { data: { id: string }[] };
  assert.deepEqual(doc.data.map((m) => m.id), ["fake-7b"], "the model list is the one model the endpoint serves");
});

test("with no provider chosen the relay says so in the OpenAI error shape", async () => {
  useProvider(null);
  const res = await post({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 503);
  const doc = (await res.json()) as { error: { type: string } };
  assert.equal(doc.error.type, "no_provider");
});

test("a series provider runs two relayed calls one at a time, fills in the model, and sends the upstream's own key", async () => {
  useProvider(fake(SERIES));
  reset();
  const started = Date.now();
  const [a, b] = await Promise.all([
    post({ messages: [{ role: "user", content: "one" }] }),
    post({ messages: [{ role: "user", content: "two" }] }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(peak, 1, "never two upstream requests at once on a series provider");
  assert.ok(Date.now() - started >= HOLD_MS * 2 - 10, "the second waited for the first");
  assert.deepEqual(seenModels, ["fake-7b", "fake-7b"], "a body with no model gets the endpoint's first model");
  assert.ok(seenAuth.every((h) => h === "Bearer upstream-secret"), "the upstream sees its own key, never the agent's");
  const queued = [a, b].map((r) => Number(r.headers.get("x-opc-queued-ms")));
  assert.ok(Math.max(...queued) >= HOLD_MS - 10, "the one that waited says how long");
  const doc = (await a.json()) as { choices: { message: { content: string } }[] };
  assert.equal(doc.choices[0]!.message.content, "hello", "the answer comes back byte for byte");
});

test("a parallel provider lets relayed calls overlap up to its concurrency", async () => {
  useProvider(fake(PARALLEL));
  reset();
  const started = Date.now();
  const all = await Promise.all([1, 2, 3].map((n) => post({ model: "named", messages: [{ role: "user", content: String(n) }] })));
  assert.ok(all.every((r) => r.status === 200));
  assert.equal(peak, 3, "three at once on a parallel provider");
  assert.ok(Date.now() - started < HOLD_MS * 2, "they ran together, not in turn");
  assert.deepEqual(seenModels, ["named", "named", "named"], "a named model is left alone");
});

test("a streamed call is answered at once with keepalive comments while it waits, then the upstream's frames", async () => {
  useProvider(fake(SERIES));
  reset();
  /* One plain call holds the only slot; the streamed one queues behind it. */
  const blocker = post({ messages: [{ role: "user", content: "hold" }] });
  const res = await post({ stream: true, messages: [{ role: "user", content: "stream" }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const text = await res.text();
  await blocker;
  assert.match(text, /^: queued\n\n/, "the first bytes go out before any slot is held");
  assert.match(text, /: slot fake after \d+ms\n\n/, "the wait is stated in the stream");
  assert.match(text, /data: \{"choices":\[\{"delta":\{"content":"hi"\}\}\]\}\n\n/, "the upstream's frames pass through unchanged");
  assert.match(text, /data: \[DONE\]\n\n$/);
  assert.equal(peak, 1, "the stream stood in the same queue as the plain call");
});

test("an upstream that refuses after the headers are out becomes an error frame, and the slot is released", async () => {
  useProvider({ ...fake(SERIES), endpoints: [{ label: "dead", baseUrl: "http://127.0.0.1:1/v1", key: null }] });
  reset();
  const res = await post({ stream: true, messages: [{ role: "user", content: "x" }] });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /data: \{"error":\{"message":"Fake local could not be reached — /);
  assert.match(text, /data: \[DONE\]\n\n$/);
  /* The slot came back: a second call on the same series provider is served
     rather than queued for ever behind a dead one. */
  useProvider(fake(SERIES));
  const again = await post({ messages: [{ role: "user", content: "again" }] });
  assert.equal(again.status, 200);
  assert.ok(Number(again.headers.get("x-opc-queued-ms")) < HOLD_MS, "no leaked slot ahead of it");
});
