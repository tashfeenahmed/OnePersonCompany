/**
 * The calendar route's window arithmetic, which is the part of it that can be
 * wrong without anybody noticing.
 *
 * Busy minutes and the privacy line are stated in the route's own header and
 * are easy to read there. `?from=` is not: it moves the `days` array, it is
 * CLAMPED to what the collector holds, and a page that trusted its own request
 * instead of reading `summary.window` back would draw empty days over a
 * fortnight this box never collected — free time that was never measured,
 * which is the one thing this file exists to refuse.
 *
 * These write rows, so they need a database: `npm test` opens a temp one via
 * test/setup.mjs and db.ts refuses the developer's own file outright.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { db } from "../../db.ts";
import { calendarRoutes } from "./calendar-route.ts";
import { AHEAD_DAYS, BACK_DAYS } from "./calendar.ts";
import { replaceCalendarEvents, replaceCalendars } from "./store.ts";

/** The box's own local date, computed the way the route computes it. */
function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** One account, one calendar, and two occurrences a fixed distance from
 *  today — so every assertion below is about the window and not about a date
 *  somebody wrote down in 2026. */
function seed(): number {
  const at = new Date().toISOString();
  db.prepare("DELETE FROM plugin_accounts WHERE plugin_id = 'calendar'").run();
  db.prepare(
    "INSERT OR IGNORE INTO plugins (id, connected, updated_at) VALUES ('calendar', 1, ?)",
  ).run(at);
  db.prepare(
    `INSERT INTO plugin_accounts (plugin_id, label, connected, created_at, updated_at)
     VALUES ('calendar', 'owner@example.com', 1, ?, ?)`,
  ).run(at, at);
  const id = Number(
    (
      db
        .prepare("SELECT id FROM plugin_accounts WHERE plugin_id = 'calendar'")
        .get() as { id: number }
    ).id,
  );

  replaceCalendars(id, [
    {
      id: "cal-1",
      summary: "Work",
      timezone: "Europe/Dublin",
      primary: true,
      selected: true,
      accessRole: "owner",
      color: "#7986cb",
    },
  ]);

  replaceCalendarEvents(id, "cal-1", "0000-01-01", "9999-12-31", [
    {
      id: "e-yesterday",
      summary: "Retro",
      start: `${localDay(-1)}T10:00:00+01:00`,
      end: `${localDay(-1)}T11:00:00+01:00`,
      allDay: false,
      status: "confirmed",
      location: null,
      attendees: 3,
      organizerSelf: true,
      response: "accepted",
      link: "https://www.google.com/calendar/event?eid=abc",
      meetLink: "https://meet.google.com/abc-defg-hij",
      updated: null,
    },
    {
      id: "e-tomorrow",
      summary: "Standup",
      start: `${localDay(1)}T09:00:00+01:00`,
      end: `${localDay(1)}T09:30:00+01:00`,
      allDay: false,
      status: "confirmed",
      location: null,
      attendees: 2,
      organizerSelf: false,
      response: "accepted",
      link: null,
      meetLink: null,
      updated: null,
    },
  ]);
  return id;
}

type Doc = {
  calendars: { color: string | null }[];
  days: { day: string; events: { link: string | null; meetLink: string | null }[] }[];
  summary: {
    window: { from: string; to: string; days: number };
    held: { from: string; to: string; backDays: number; aheadDays: number };
  };
};

const read = async (query: string): Promise<Doc> =>
  (await (await calendarRoutes.request(`/${query}`)).json()) as Doc;

test("with no ?from= the days array still begins today — the widgets' contract", async () => {
  seed();
  const doc = await read("?days=7");
  assert.equal(doc.summary.window.from, localDay());
  assert.equal(doc.days.length, 7);
  assert.equal(doc.days[0]!.day, localDay());
});

test("?from= moves the days array to that day", async () => {
  seed();
  const doc = await read(`?from=${localDay(-3)}&days=7`);
  assert.equal(doc.summary.window.from, localDay(-3));
  assert.equal(doc.days[0]!.day, localDay(-3));
  /* And yesterday's event is IN it, which is the whole point: the old route
     could only ever look forward. */
  const yesterday = doc.days.find((d) => d.day === localDay(-1));
  assert.equal(yesterday?.events.length, 1);
});

test("a ?from= behind the collected window is clamped, and the document says so", async () => {
  seed();
  const doc = await read("?from=2020-01-01&days=7");
  assert.equal(doc.summary.window.from, localDay(-BACK_DAYS));
  assert.equal(doc.summary.held.from, localDay(-BACK_DAYS));
  assert.equal(doc.summary.held.to, localDay(AHEAD_DAYS));
  assert.equal(doc.summary.held.backDays, BACK_DAYS);
});

test("a ?from= that is not a date is ignored rather than becoming a bound", async () => {
  seed();
  for (const bad of ["yesterday", "2026-13-01", "2026-02-30", "'; DROP TABLE"]) {
    const doc = await read(`?from=${encodeURIComponent(bad)}&days=3`);
    assert.equal(doc.summary.window.from, localDay());
  }
});

test("?days= reaches the whole collected window, not just the days ahead", async () => {
  seed();
  const doc = await read(`?from=${localDay(-BACK_DAYS)}&days=99`);
  assert.equal(doc.days.length, BACK_DAYS + AHEAD_DAYS);
});

test("colour and links travel, and a row that never had them is null and not empty string", async () => {
  seed();
  const doc = await read(`?from=${localDay(-1)}&days=3`);
  assert.equal(doc.calendars[0]!.color, "#7986cb");
  const retro = doc.days[0]!.events[0]!;
  assert.equal(retro.link, "https://www.google.com/calendar/event?eid=abc");
  assert.equal(retro.meetLink, "https://meet.google.com/abc-defg-hij");
  const standup = doc.days.find((d) => d.day === localDay(1))!.events[0]!;
  assert.equal(standup.link, null);
  assert.equal(standup.meetLink, null);
});
