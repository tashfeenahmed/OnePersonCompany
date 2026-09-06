/**
 * The clock rules, without waiting for two in the morning.
 *
 * The cases here are the ones the four copies of this code disagreed about or
 * each rediscovered separately: midnight read as hour 24, a schedule whose
 * hour does not exist on a spring-forward day, a schedule whose hour happens
 * twice on a fall-back day, and what an unset timezone setting means.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  dailySchedule,
  dueDay,
  nextRunAt,
  readHour,
  resolveZone,
  systemZone,
  validZone,
  wall,
  zoned,
} from "./time.ts";
import { setConfig, upsertPlugin } from "../db.ts";

test("a zone is real or it is not, and nothing in between throws", () => {
  assert.equal(validZone("Europe/Berlin"), true);
  assert.equal(validZone("UTC"), true);
  for (const bad of ["", "   ", "Mars/Olympus", "GMT+1:xx", null, undefined])
    assert.equal(validZone(bad), false, `expected false for ${JSON.stringify(bad)}`);
});

test("an unset or unusable zone resolves to the machine's own, not to UTC and not to null", () => {
  const machine = systemZone();
  assert.equal(resolveZone(null), machine);
  assert.equal(resolveZone(""), machine);
  assert.equal(resolveZone("  "), machine);
  assert.equal(resolveZone("Mars/Olympus"), machine);
  assert.equal(resolveZone("Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(resolveZone(" Asia/Tokyo "), "Asia/Tokyo");
});

test("midnight is hour 0 — the ICU '24' that made every midnight schedule silent", () => {
  /* 2026-06-15T00:30 in Asia/Tokyo is 15:30 UTC the day before. */
  const at = new Date("2026-06-14T15:30:00Z");
  assert.deepEqual(zoned("Asia/Tokyo", at), { day: "2026-06-15", hour: 0 });
  const w = wall("Asia/Tokyo", at);
  assert.equal(w.hour, 0);
  assert.equal(w.minute, 30);
  assert.equal(w.minutes, 30);
  assert.equal(w.weekday, 1); // a Monday in Tokyo, a Sunday in UTC
});

test("one reading gives the day and the hour from the same instant", () => {
  /* 23:59 in New York is already the next day in UTC — the straddle the
     single-formatter rule exists to prevent. */
  const at = new Date("2026-06-16T03:59:00Z");
  assert.deepEqual(zoned("America/New_York", at), { day: "2026-06-15", hour: 23 });
  assert.deepEqual(zoned("UTC", at), { day: "2026-06-16", hour: 3 });
});

test("the next run is an instant on the hour, in the owner's zone", () => {
  const at = new Date("2026-06-15T08:17:00Z"); // 04:17 EDT
  const next = nextRunAt({ enabled: true, hour: 6, timezone: "America/New_York" }, at);
  /* 06:00 EDT the same morning is 10:00 UTC, and is still ahead. */
  assert.equal(next, "2026-06-15T10:00:00.000Z");
  assert.equal(nextRunAt({ enabled: false, hour: 6, timezone: "America/New_York" }, at), null);
  /* No `enabled` at all means a schedule with no switch, which is still due. */
  assert.equal(nextRunAt({ hour: 6, timezone: "UTC" }, at), "2026-06-16T06:00:00.000Z");
});

test("a schedule set to midnight still fires", () => {
  const at = new Date("2026-06-15T08:00:00Z");
  assert.equal(nextRunAt({ enabled: true, hour: 0, timezone: "UTC" }, at), "2026-06-16T00:00:00.000Z");
});

test("spring forward: an hour that does not exist locally waits for the next day", () => {
  /* America/New_York, 2026-03-08: 01:59 EST is followed by 03:00 EDT, so
     02:00 never happens. Computing an offset would have fired at the wrong
     moment; walking the formatter finds the next real 02:00, more than 24
     hours out — which is why the walk is 48 probes and not 25. */
  const at = new Date("2026-03-08T05:00:00Z"); // 00:00 EST on the 8th
  const next = nextRunAt({ enabled: true, hour: 2, timezone: "America/New_York" }, at);
  assert.equal(next, "2026-03-09T06:00:00.000Z"); // 02:00 EDT on the 9th
  assert.equal(zoned("America/New_York", new Date(next!)).hour, 2);
});

test("fall back: an hour that happens twice fires on the first of them", () => {
  /* America/New_York, 2026-11-01: 01:59 EDT is followed by 01:00 EST. */
  const at = new Date("2026-11-01T03:30:00Z"); // 23:30 EDT on Oct 31
  const next = nextRunAt({ enabled: true, hour: 1, timezone: "America/New_York" }, at);
  assert.equal(next, "2026-11-01T05:00:00.000Z"); // 01:00 EDT, the earlier one
  assert.equal(zoned("America/New_York", new Date(next!)).hour, 1);
});

test("an empty hour setting is the default, not midnight", () => {
  assert.equal(readHour("", 7), 7);
  assert.equal(readHour(null, 7), 7);
  assert.equal(readHour("   ", 7), 7);
  assert.equal(readHour("0", 7), 0);
  assert.equal(readHour("23", 7), 23);
  /* Out of range falls back rather than clamping: 25 is not 23, and pretending
     it is presents an hour the owner never chose as one they did. */
  assert.equal(readHour("25", 7), 7);
  assert.equal(readHour("-1", 7), 7);
  assert.equal(readHour("6.5", 7), 7);
  assert.equal(readHour("six", 7), 7);
});

test("a plugin's schedule comes back with a real zone and says whether one was set", () => {
  /* plugin_config has a foreign key onto the plugins table — a settings row
     cannot outlive the plugin it configures — so the row goes in first. */
  const plugin = "test-daily-schedule";
  upsertPlugin(plugin, true, null);
  const machine = systemZone();
  assert.deepEqual(dailySchedule(plugin, { defaultHour: 7 }), {
    enabled: false,
    hour: 7,
    timezone: machine,
    zoneWasSet: false,
  });
  setConfig(plugin, "enabled", "on");
  setConfig(plugin, "hour", "6");
  setConfig(plugin, "timezone", "Europe/Berlin");
  assert.deepEqual(dailySchedule(plugin, { defaultHour: 7 }), {
    enabled: true,
    hour: 6,
    timezone: "Europe/Berlin",
    zoneWasSet: true,
  });
  /* A typo in the settings field must not take the scheduler down. */
  setConfig(plugin, "timezone", "Mars/Olympus");
  assert.deepEqual(dailySchedule(plugin, { defaultHour: 7 }), {
    enabled: true,
    hour: 6,
    timezone: machine,
    zoneWasSet: false,
  });
});

test("a new schedule waits until its chosen hour", () =>
  assert.equal(dueDay("2026-09-06", 5, 6, null), null));

test("a schedule missed during sleep catches up once", () => {
  assert.equal(dueDay("2026-09-06", 15, 6, "2026-09-04"), "2026-09-06");
  assert.equal(dueDay("2026-09-06", 15, 6, "2026-09-06"), null);
});

test("a missed day can catch up before today's scheduled hour without repeating", () => {
  assert.equal(dueDay("2026-09-06", 5, 6, "2026-09-04"), "2026-09-05");
  assert.equal(dueDay("2026-09-06", 5, 6, "2026-09-05"), null);
});

test("the catch-up day steps back across a month boundary", () =>
  assert.equal(dueDay("2026-03-01", 2, 6, "2026-02-26"), "2026-02-28"));
