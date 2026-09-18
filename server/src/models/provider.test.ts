/**
 * WHAT A STRUCTURED WRITER PUTS ON THE WIRE.
 *
 * Two things this file pins down, both of which are invisible from the outside
 * until a run fails: the parameters `jsonObject` adds per provider, and how much
 * output a caller is actually allowed to ask for.
 *
 * The failure being defended against is run r-c4k493 — a reasoning model that
 * spent the whole 4096-token default thinking out loud and emitted no JSON, and
 * was charged for it. A regression here does not throw; it quietly produces the
 * same empty answer again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { DEFAULT_BUDGETS, OUTPUT_TOKENS_CEILING, outputAllowance, saveBudgets } from "../runtime/budgets.ts";
import { complete, registerProvider, setProviderChoiceReader, type ProviderId } from "./provider.ts";

const IDS: ProviderId[] = ["freellmapi", "openrouter", "local", "openai"];

/** Every request body the stubbed wire saw, newest last. */
function stub(sent: Record<string, unknown>[], fail = false) {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (fail) throw new Error("the endpoint was unreachable");
    return Response.json({
      choices: [{ message: { role: "assistant", content: '{"scenes":[]}' }, finish_reason: "stop" }],
      model: "test-model",
      usage: { prompt_tokens: 4, completion_tokens: 6 },
    });
  };
  return () => { globalThis.fetch = original; };
}

function use(id: ProviderId) {
  registerProvider(id, () => ({
    id,
    label: id,
    defaultModel: `test-${id}`,
    endpoints: [{ baseUrl: `https://${id}.invalid/v1`, key: null, label: "Test" }],
    policy: { mode: "parallel", concurrency: 4, balance: "round-robin", timeoutMs: 1000 },
  }));
  setProviderChoiceReader(() => id);
}

test("a plain completion is unchanged: the workspace allowance and nothing else", async () => {
  const sent: Record<string, unknown>[] = [];
  const restore = stub(sent);
  try {
    for (const id of IDS) {
      use(id);
      await complete([{ role: "user", content: "hello" }]);
      const body = sent[sent.length - 1]!;
      assert.equal(body.max_tokens, DEFAULT_BUDGETS.maxOutputTokens, id);
      for (const key of ["response_format", "reasoning_effort", "reasoning", "chat_template_kwargs"]) {
        assert.equal(key in body, false, `${id} sent ${key} on a plain completion`);
      }
    }
  } finally { restore(); }
});

test("jsonObject asks for a JSON object and turns each router's thinking off its own way", async () => {
  const sent: Record<string, unknown>[] = [];
  const restore = stub(sent);
  /* The reasoning-off parameter is per router and the values are not
     interchangeable: freellmapi takes the OpenAI effort scale ('none' is on it),
     openrouter takes its own `reasoning` object, a local llama.cpp/vLLM takes a
     chat-template flag, and OpenAI itself is given none of them. */
  const expected: Record<ProviderId, Record<string, unknown>> = {
    freellmapi: { reasoning_effort: "none" },
    openrouter: { reasoning: { enabled: false } },
    local: { chat_template_kwargs: { enable_thinking: false } },
    openai: {},
  };
  try {
    for (const id of IDS) {
      use(id);
      await complete([{ role: "user", content: "write the object" }], { jsonObject: true });
      const body = sent[sent.length - 1]!;
      assert.deepEqual(body.response_format, { type: "json_object" }, id);
      for (const [key, value] of Object.entries(expected[id])) assert.deepEqual(body[key], value, `${id}.${key}`);
      for (const key of ["reasoning_effort", "reasoning", "chat_template_kwargs"]) {
        if (!(key in expected[id])) assert.equal(key in body, false, `${id} should not send ${key}`);
      }
    }
  } finally { restore(); }
});

test("maxOutputTokens raises the cap for one call, clamped at both ends", async () => {
  const sent: Record<string, unknown>[] = [];
  const restore = stub(sent);
  try {
    use("freellmapi");
    for (const [asked, wire] of [
      [8192, 8192],
      // Above the ceiling: clamped, not forwarded — the allowance is also a
      // reservation against the daily budget.
      [1_000_000, OUTPUT_TOKENS_CEILING],
      // Below the workspace default: a caller may not quietly tighten it.
      [100, DEFAULT_BUDGETS.maxOutputTokens],
    ] as [number, number][]) {
      await complete([{ role: "user", content: `ask ${asked}` }], { jsonObject: true, maxOutputTokens: asked });
      assert.equal(sent[sent.length - 1]!.max_tokens, wire, `asked ${asked}`);
    }
  } finally { restore(); }
});

test("a raised workspace default is never lowered by a caller's smaller request", () => {
  try {
    assert.equal(saveBudgets({ ...DEFAULT_BUDGETS, maxOutputTokens: 20_000 }), null);
    assert.equal(outputAllowance(8192), 20_000);
    assert.equal(outputAllowance(64_000), 20_000);
    assert.equal(outputAllowance(undefined), 20_000);
  } finally {
    assert.equal(saveBudgets(DEFAULT_BUDGETS), null);
  }
  assert.equal(outputAllowance(undefined), DEFAULT_BUDGETS.maxOutputTokens);
  assert.equal(outputAllowance(0), DEFAULT_BUDGETS.maxOutputTokens);
  assert.equal(outputAllowance(Number.NaN), DEFAULT_BUDGETS.maxOutputTokens);
  assert.equal(outputAllowance(8192.7), 8192);
});

test("the budget reserves what the call actually asks for, not the default", async () => {
  const sent: Record<string, unknown>[] = [];
  const restore = stub(sent, true);
  try {
    use("freellmapi");
    db.exec("DELETE FROM budget_usage");
    await assert.rejects(complete([{ role: "user", content: "x" }]));
    const plain = db.prepare("SELECT tokens FROM budget_usage").get() as { tokens: number };
    db.exec("DELETE FROM budget_usage");
    await assert.rejects(complete([{ role: "user", content: "x" }], { maxOutputTokens: 8192 }));
    const raised = db.prepare("SELECT tokens FROM budget_usage").get() as { tokens: number };
    /* The extra allowance, plus the handful of bytes the raised figure itself
       adds to the shape the reservation is measured from. */
    const extra = raised.tokens - plain.tokens;
    assert.ok(extra >= 8192 - DEFAULT_BUDGETS.maxOutputTokens, `reserved only ${extra} more`);
    assert.ok(extra < 8192 - DEFAULT_BUDGETS.maxOutputTokens + 100, `reserved ${extra} more than expected`);
  } finally {
    restore();
    db.exec("DELETE FROM budget_usage");
  }
});

test("document turns thinking off the way jsonObject does, asks for the ceiling, and never asks for JSON", async () => {
  const sent: Record<string, unknown>[] = [];
  const restore = stub(sent);
  try {
    for (const id of IDS) {
      use(id);
      await complete([{ role: "user", content: "write the page" }], { document: true });
      const body = sent[sent.length - 1]!;
      assert.equal(body.max_tokens, OUTPUT_TOKENS_CEILING, `${id} did not get the ceiling`);
      assert.equal("response_format" in body, false, `${id} asked for JSON on a document`);
      if (id === "freellmapi") assert.equal(body.reasoning_effort, "none");
      if (id === "openrouter") assert.deepEqual(body.reasoning, { enabled: false });
      if (id === "local") assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
      if (id === "openai") for (const key of ["reasoning_effort", "reasoning", "chat_template_kwargs"]) assert.equal(key in body, false, `openai was sent ${key}`);
    }
    /* A caller's own number still wins over the ceiling. */
    use("local");
    await complete([{ role: "user", content: "write the page" }], { document: true, maxOutputTokens: 6000 });
    assert.equal(sent[sent.length - 1]!.max_tokens, 6000);
  } finally { restore(); }
});

test("a document is asked for as a stream first, and an endpoint that will not stream gets the plain request", async () => {
  const sent: Record<string, unknown>[] = [];
  const restore = stub(sent); /* the stub answers JSON, which is a 406 to the stream reader */
  try {
    use("local");
    const reply = await complete([{ role: "user", content: "write the page" }], { document: true });
    assert.equal(reply.text, '{"scenes":[]}', "the plain request's answer came back");
    const [streamed, plain] = sent.slice(-2);
    assert.equal(streamed!.stream, true);
    assert.deepEqual(streamed!.stream_options, { include_usage: true });
    assert.deepEqual(streamed!.chat_template_kwargs, { enable_thinking: false });
    assert.notEqual(plain!.stream, true, "the fallback is not a stream");
    assert.equal(plain!.max_tokens, OUTPUT_TOKENS_CEILING);
  } finally { restore(); }
});
