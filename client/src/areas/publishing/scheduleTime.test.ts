import test from "node:test";
import assert from "node:assert/strict";
import { pastTime } from "./scheduleTime.ts";

/* A LOCAL 12:00 on the day: `datetime-local` values carry no zone and read
   as local time, so the fixture must be local too, whatever zone runs it. */
const NOW = new Date(2026, 8, 25, 12, 0, 0).getTime();

test("an empty picker is not 'in the past' — it is 'not filled in'", () => {
  assert.equal(pastTime("", NOW), false);
});

test("a local value an hour gone refuses to schedule", () => {
  assert.equal(pastTime("2026-09-25T11:00", NOW), true);
});

test("a local value in the future schedules", () => {
  assert.equal(pastTime("2026-09-25T13:00", NOW), false);
});

test("the exact current minute is the past: a schedule that fires on the next tick IS now", () => {
  assert.equal(pastTime("2026-09-25T12:00", NOW), true);
});

test("an unparseable value never reaches the server as a schedule", () => {
  assert.equal(pastTime("not a date", NOW), true);
});

test("the reading is local, matching what the schedule call sends", () => {
  /* The same wall-clock string must read the same way here as `new Date(v)`
     reads it at the call site, whatever zone the browser runs in. */
  const v = "2026-09-25T11:00";
  assert.equal(pastTime(v, NOW), new Date(v).getTime() <= NOW);
});
