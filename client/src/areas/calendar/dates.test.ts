/**
 * The four pieces of calendar arithmetic that are wrong silently.
 *
 *   ALL-DAY PARSING — `new Date("2026-09-08")` is UTC midnight, which is the
 *   7th in every timezone west of Greenwich. Every holiday on the page moves a
 *   day and nothing throws.
 *   SPANS — a five-night stay that appears only on its first day is a trip
 *   that vanishes from the week you are looking at.
 *   BUSY MINUTES — overlaps merged and never added, matching the server's own
 *   rule, or a Tuesday reports thirty hours.
 *   LANES — two blocks in the same hour drawn on top of each other hide the
 *   clash the page was opened to find.
 *
 * Pure functions of their inputs, so this file touches no component, no fetch
 * and no clock it did not build itself.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { CalendarEvent } from "@/lib/api/reports";
import {
  addDays,
  busyMinutes,
  daysBetween,
  eventDays,
  eventStart,
  isoDay,
  lanes,
  lengthLabel,
  parseISODay,
  startOfWeek,
  untilText,
  weekHeading,
} from "./dates.ts";

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  calendarId: "cal-1",
  calendar: "Work",
  eventId: "e-1",
  summary: "Standup",
  start: null,
  end: null,
  allDay: false,
  status: "confirmed",
  location: null,
  attendees: null,
  organizerSelf: null,
  response: null,
  busy: true,
  minutes: null,
  link: null,
  meetLink: null,
  updated: null,
  ...over,
});

test("an all-day date is LOCAL midnight, not UTC — the bug that moves every holiday", () => {
  const d = parseISODay("2026-09-08");
  assert.ok(d);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 8);
  assert.equal(d.getHours(), 0);
  /* And it round-trips through the page's own day key, which is where a UTC
     parse would show up as an off-by-one. */
  assert.equal(isoDay(d), "2026-09-08");
});

test("a date that is not one is null rather than an Invalid Date drawn as a cell", () => {
  assert.equal(parseISODay("2026-02-30"), null);
  assert.equal(parseISODay("tomorrow"), null);
  assert.equal(parseISODay(null), null);
});

test("a multi-day all-day event touches every day it covers, end exclusive", () => {
  const stay = event({ allDay: true, start: "2026-09-08", end: "2026-09-12" });
  assert.deepEqual(eventDays(stay), [
    "2026-09-08",
    "2026-09-09",
    "2026-09-10",
    "2026-09-11",
  ]);
});

test("a timed event belongs to ONE day even when it runs past midnight", () => {
  const train = event({
    start: "2026-09-08T23:30:00+01:00",
    end: "2026-09-09T00:45:00+01:00",
  });
  assert.equal(eventDays(train).length, 1);
});

test("busy minutes MERGE overlaps rather than adding them", () => {
  const a = event({ eventId: "a", start: "2026-09-08T09:00:00Z", end: "2026-09-08T10:00:00Z" });
  const b = event({ eventId: "b", start: "2026-09-08T09:30:00Z", end: "2026-09-08T11:00:00Z" });
  /* Two hours of wall clock, not two and a half hours of meeting. */
  assert.equal(busyMinutes([a, b]), 120);
  /* Touching but not overlapping still adds. */
  const c = event({ eventId: "c", start: "2026-09-08T11:00:00Z", end: "2026-09-08T11:30:00Z" });
  assert.equal(busyMinutes([a, b, c]), 150);
});

test("a declined, cancelled or all-day entry is no hours of anybody's day", () => {
  const base = { start: "2026-09-08T09:00:00Z", end: "2026-09-08T10:00:00Z" };
  assert.equal(busyMinutes([event({ ...base, response: "declined" })]), 0);
  assert.equal(busyMinutes([event({ ...base, status: "cancelled" })]), 0);
  assert.equal(busyMinutes([event({ allDay: true, start: "2026-09-08", end: "2026-09-09" })]), 0);
  /* But an UNANSWERED invitation still occupies the slot. */
  assert.equal(busyMinutes([event({ ...base, response: "needsAction" })]), 60);
});

test("overlapping blocks get side-by-side lanes and a shared width", () => {
  const got = lanes([
    { start: 540, end: 600 },
    { start: 570, end: 630 },
    { start: 700, end: 730 },
  ]);
  assert.deepEqual(got[0], { lane: 0, of: 2 });
  assert.deepEqual(got[1], { lane: 1, of: 2 });
  /* A block in nobody's way is full width, not a third of one. */
  assert.deepEqual(got[2], { lane: 0, of: 1 });
});

test("a lane is reused once the event holding it has ended", () => {
  const got = lanes([
    { start: 0, end: 60 },
    { start: 30, end: 90 },
    { start: 61, end: 120 },
  ]);
  /* The third overlaps only the second, so it takes the first one's lane back
     — and all three are one cluster, so all three are two wide. */
  assert.equal(got[2]!.lane, 0);
  assert.equal(got[2]!.of, 2);
});

test("weeks start on Monday, whichever day you name", () => {
  for (const day of ["2026-09-07", "2026-09-08", "2026-09-13"]) {
    const monday = startOfWeek(parseISODay(day)!);
    assert.equal(isoDay(monday), "2026-09-07");
  }
});

test("a week heading collapses whatever the two ends share", () => {
  assert.equal(weekHeading(parseISODay("2026-09-07")!), "7 – 13 Sep 2026");
  assert.equal(weekHeading(parseISODay("2026-09-28")!), "28 Sep – 4 Oct 2026");
  assert.equal(weekHeading(parseISODay("2026-12-28")!), "28 Dec 2026 – 3 Jan 2027");
});

test("days between two dates survives a daylight-saving boundary", () => {
  /* Europe's clocks go back on 25 October 2026; that Sunday is 25 hours long
     and millisecond arithmetic rounds the span to 0 or 2. */
  const a = parseISODay("2026-10-24")!;
  const b = parseISODay("2026-10-26")!;
  assert.equal(daysBetween(a, b), 2);
  assert.equal(isoDay(addDays(a, 2)), "2026-10-26");
});

test("how far off the next thing is, in the coarsest unit still true", () => {
  const now = new Date(2026, 8, 8, 14, 0);
  assert.equal(untilText(new Date(2026, 8, 8, 14, 25), now), "in 25 min");
  assert.equal(untilText(new Date(2026, 8, 8, 18, 0), now), "in 4h");
  assert.equal(untilText(new Date(2026, 8, 9, 9, 0), now), "tomorrow");
  assert.equal(untilText(new Date(2026, 8, 11, 9, 0), now), "in 3 days");
  assert.equal(untilText(new Date(2026, 8, 8, 13, 0), now), "now");
});

test("an all-day event is never given a number of hours", () => {
  assert.equal(lengthLabel(event({ allDay: true, minutes: null })), "all day");
  assert.equal(lengthLabel(event({ minutes: null })), "—");
  assert.equal(lengthLabel(event({ minutes: 90 })), "1h 30m");
  assert.equal(lengthLabel(event({ minutes: 45 })), "45m");
});

test("a timed start is parsed with the offset Google sent, not sliced", () => {
  const d = eventStart(event({ start: "2026-09-08T09:00:00+05:00" }))!;
  /* 09:00 in Karachi is 04:00 UTC whatever the reader's clock says — which is
     the fact a grid has to place it by. */
  assert.equal(d.toISOString(), "2026-09-08T04:00:00.000Z");
});
