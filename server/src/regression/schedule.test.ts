import test from "node:test";
import assert from "node:assert/strict";
import { dueDay } from "../runtime/schedule.ts";
test("a new schedule waits until its chosen hour", () => assert.equal(dueDay("2026-09-06", 5, 6, null), null));
test("a schedule missed during sleep catches up once", () => {
  assert.equal(dueDay("2026-09-06", 15, 6, "2026-09-04"), "2026-09-06");
  assert.equal(dueDay("2026-09-06", 15, 6, "2026-09-06"), null);
});
test("a missed day can catch up before today's scheduled hour without repeating", () => {
  assert.equal(dueDay("2026-09-06", 5, 6, "2026-09-04"), "2026-09-05");
  assert.equal(dueDay("2026-09-06", 5, 6, "2026-09-05"), null);
});
