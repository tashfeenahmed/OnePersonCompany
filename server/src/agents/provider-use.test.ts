import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { ProviderUse } from "./provider-use.ts";
import { activeBackend, registerBackend, setBackendPreparation, setChoiceReader } from "../chat/backend.ts";

test("unchanged provider permits concurrent requests; a changed config waits for every answer", async () => {
  const use = new ProviderUse();
  let configured = "a";
  const enter = (chosen: string) => use.acquire(async idle => {
    if (chosen !== configured) { await idle(); configured = chosen; }
  });
  const first = await enter("a");
  const second = await enter("a");
  let started = false;
  const next = enter("b").then(release => { started = true; return release; });
  await tick(); assert.equal(started, false);
  first(); first(); await tick(); assert.equal(started, false);
  second(); const end = await next;
  assert.equal(configured, "b"); end();
});

test("background reconfiguration cannot interrupt an answer or admit one during a restart", async () => {
  const use = new ProviderUse();
  const end = await use.acquire(async () => {});
  const events: string[] = [];
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const update = use.configure(async () => { events.push("restart"); await waiting; events.push("ready"); });
  const next = use.acquire(async () => { events.push("request"); });
  await tick(); assert.deepEqual(events, []);
  end(); await tick(); assert.deepEqual(events, ["restart"]);
  finish(); await update; const release = await next;
  assert.deepEqual(events, ["restart", "ready", "request"]); release();
});

test("cancelled/failed preparation never leaks a lease or blocks future requests", async () => {
  const use = new ProviderUse();
  const end = await use.acquire(async () => {});
  const abort = new AbortController();
  const next = use.acquire(idle => idle(), abort.signal);
  await tick(); abort.abort(new Error("cancelled"));
  await assert.rejects(next, /cancelled/);
  end();
  await assert.rejects(use.acquire(async () => { throw new Error("provider off"); }), /provider off/);
  const release = await use.acquire(async () => {}); release();
  await use.configure(async () => {});
});

test("central backend wrapper releases after errors and early stream closure", async () => {
  const use = new ProviderUse();
  setChoiceReader(() => "hermes");
  let active = 0;
  let failing = true;
  setBackendPreparation(async () => {
    const end = await use.acquire(async () => {}); active++;
    return () => { active--; end(); };
  });
  registerBackend("hermes", () => ({
    id: "hermes", label: "Test",
    async ask() { throw new Error("upstream failed"); },
    /* `ask` reads the stream when there is one (chat/backend.ts, `askOverStream`),
       so the failure it has to release after is the stream's. */
    async *stream() { if (failing) throw new Error("upstream failed"); yield { type: "delta" as const, text: "hello" }; yield { type: "delta" as const, text: "world" }; },
  }));
  try {
    await assert.rejects(activeBackend()!.ask([]), /upstream failed/);
    assert.equal(active, 0);
    failing = false;
    for await (const event of activeBackend()!.stream!([])) { assert.equal(event.type, "delta"); assert.equal(active, 1); break; }
    assert.equal(active, 0);
    await use.configure(async () => {});
  } finally { setChoiceReader(() => null); setBackendPreparation(async () => () => {}); }
});
