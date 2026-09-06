import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../db.ts";
import { budgeted, DEFAULT_BUDGETS, runContext, saveBudgets } from "../runtime/budgets.ts";
const inRun = <T>(id: string, fn: () => Promise<T>, resume = false) => runContext.run({ id, venture: "v", automation: true, signal: new AbortController().signal, sequence: 0, resume }, fn);
function reset() { db.exec("DELETE FROM budget_usage; DELETE FROM run_checkpoints"); assert.equal(saveBudgets(DEFAULT_BUDGETS), null); }
test("parallel requests reserve the daily budget before spending", async () => {
  reset(); saveBudgets({ ...DEFAULT_BUDGETS, dailyCalls: 1 }); let calls = 0;
  const work = () => budgeted("prompt", async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { usage: { prompt: 2, completion: 3 } }; });
  const result = await Promise.allSettled([inRun("a", work), inRun("b", work)]);
  assert.equal(calls, 1); assert.equal(result.filter(r => r.status === "rejected").length, 1);
});
test("uncertain calls retain reservations and missing usage never counts as zero", async () => {
  reset(); await assert.rejects(inRun("a", () => budgeted("prompt", async () => { throw new Error("timeout"); })));
  const row = db.prepare("SELECT tokens,status FROM budget_usage").get() as { tokens: number; status: string };
  assert.ok(row.tokens > 0); assert.equal(row.status, "uncertain");
});
test("configured token limits block unmetered agents before execution", async () => {
  reset(); saveBudgets({ ...DEFAULT_BUDGETS, runTokens: 100000 }); let called = false;
  await assert.rejects(inRun("a", () => budgeted("prompt", async () => { called = true; return { usage: null }; }, true)), /cannot guarantee/);
  assert.equal(called, false);
});
test("safe checkpoints replay completed calls without charging twice", async () => {
  reset(); let calls = 0; const work = () => budgeted("same prompt", async () => { calls++; return { text: "saved", usage: { prompt: 2, completion: 3 } }; });
  const first = await inRun("a", work); const resumed = await inRun("a", work, true);
  assert.deepEqual(resumed, first); assert.equal(calls, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM budget_usage").get() as { n: number }).n, 1);
});
