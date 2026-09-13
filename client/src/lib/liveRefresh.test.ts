import test from "node:test";
import assert from "node:assert/strict";
import { LiveRefreshGate, mergeReadings } from "./liveRefresh.ts";

test("switching away and back does not refresh again within a minute", () => {
  const gate = new LiveRefreshGate<number>();
  assert.equal(gate.begin(30, 1000), true);
  for (const now of [1100, 5000, 30_000, 60_999]) assert.equal(gate.due(now), false);
  assert.equal(gate.due(61_000), true);
  assert.equal(gate.begin(30, 61_000), false, "background refresh must retain readings");
  assert.equal(gate.due(61_100), false);
});
test("manual refresh retains data; changing the date window invalidates it", () => {
  const gate = new LiveRefreshGate<number | "all">();
  gate.begin(30, 0);
  assert.equal(gate.begin(30, 100), false);
  assert.equal(gate.begin(7, 200), true);
  assert.equal(gate.begin("all", 300), true);
  assert.equal(gate.begin(30, 400), true);
});
test("failed sources retain their reading while successful, empty and disconnected sources replace it", () => {
  const old = { failed: [42], updated: [1], emptied: [2], disconnected: [3] };
  const merged = mergeReadings(old, [["failed", null], ["updated", [4]], ["emptied", []], ["disconnected", []]]);
  assert.deepEqual(merged, { failed: [42], updated: [4] });
  assert.deepEqual(old, { failed: [42], updated: [1], emptied: [2], disconnected: [3] });
  assert.deepEqual(mergeReadings({}, [["failed", null]]), {}, "no old-window data leaks into a failed new window");
});
