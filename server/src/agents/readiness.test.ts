import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { ensureManagedReady, waitForPortRelease, type ManagedState } from "./readiness.ts";
import { ProviderUse } from "./provider-use.ts";

const state = (patch: Partial<ManagedState> = {}): ManagedState => ({
  state: "failed", starting: false, hasChild: false, autostart: true, failedStarts: 0,
  lastError: "The previous listener occupied the port.", ...patch,
});

test("a failed autostart recovers once and concurrent requests wait for the same healthy agent", async () => {
  const current = state(), use = new ProviderUse(); let starts = 0;
  const enter = () => use.acquire(() => ensureManagedReady({
    label: "Test agent", read: () => current, signal: AbortSignal.timeout(1000), pollMs: 1,
    start: async () => { starts++; current.hasChild = true; current.state = "starting"; return {ok:true}; },
  }));
  const first = enter(), second = enter();
  await tick(); assert.equal(starts, 1);
  current.state = "running";
  const release = await Promise.all([first,second]); release.forEach(end => end());
  assert.equal(starts, 1);
});

test("startup preparation waits for boot and never launches a second child", async () => {
  const current = state({state:"installed",starting:true});
  const waiting = ensureManagedReady({label:"Test agent",read:()=>current,signal:AbortSignal.timeout(1000),pollMs:1,
    start:async()=>{assert.fail("boot already owns startup");}});
  await tick(); current.hasChild = true; current.state = "running"; current.starting = false;
  await waiting;
});

test("an explicitly stopped agent and an exhausted crash loop stay stopped", async () => {
  for (const current of [state({state:"stopped",autostart:false,lastError:null}),state({failedStarts:5})]) {
    await assert.rejects(ensureManagedReady({label:"Test agent",read:()=>current,signal:AbortSignal.timeout(1000),
      start:async()=>{assert.fail("must not override a stop or crash limit");}}),/not running|previous listener/);
  }
});

test("failed recovery surfaces its cause, and cancelled readiness stops waiting", async () => {
  await assert.rejects(ensureManagedReady({label:"Test agent",read:()=>state(),signal:AbortSignal.timeout(1000),
    start:async()=>({ok:false,error:"Port is still in use by another service."})}),/another service/);
  const abort = new AbortController();
  const wait = ensureManagedReady({label:"Test agent",read:()=>state({state:"starting",hasChild:true}),signal:abort.signal,pollMs:1,
    start:async()=>{assert.fail("already starting");}});
  abort.abort(); await assert.rejects(wait,{name:"AbortError"});
});

test("a previous listener gets time to release its port, while a persistent listener is left alone", async () => {
  let reads = 0;
  assert.equal(await waitForPortRelease(async()=>++reads < 3,AbortSignal.timeout(1000),1),true);
  assert.equal(reads,3);
  assert.equal(await waitForPortRelease(async()=>true,AbortSignal.timeout(10),1),false);
});

test("chat reports managed readiness separately from saved connection credentials", async () => {
  const { chat } = await import("../routes/chat.ts");
  const { registerBackend, setChoiceReader, setBackendReadiness } = await import("../chat/backend.ts");
  registerBackend("hermes", () => ({id:"hermes",label:"Test Hermes",ask:async()=>{assert.fail("status must not send a completion");}}));
  setChoiceReader(()=>"hermes");
  let ready = false;
  setBackendReadiness(()=>({ready,reason:ready ? null : "Test Hermes is starting."}));
  try {
    const pending = await (await chat.request("/backends")).json() as {live:string;readiness:{ready:boolean};why:string|null};
    assert.equal(pending.live,"hermes"); assert.equal(pending.readiness.ready,false); assert.equal(pending.why,"Test Hermes is starting.");
    ready = true;
    const running = await (await chat.request("/backends")).json() as {readiness:{ready:boolean};why:string|null};
    assert.equal(running.readiness.ready,true); assert.equal(running.why,null);
  } finally { setChoiceReader(()=>null); setBackendReadiness(()=>null); }
});
