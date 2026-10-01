/**
 * The calendar's writes: they go to Google first, land in the table second,
 * and refuse a calendar that is not writable before anything leaves the box.
 * Google is a stubbed `fetch`; the database is the temp one test/setup.mjs
 * opens.
 */
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "node:test";

import * as accounts from "../../accounts.ts";
import { db } from "../../db.ts";
import { calendarRoutes } from "./calendar-route.ts";
import { findCalendarEvent, replaceCalendarEvents, replaceCalendars } from "./store.ts";

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function seed(writable: boolean) {
  const at = new Date().toISOString();
  db.prepare("DELETE FROM plugin_accounts WHERE plugin_id = 'calendar'").run();
  db.prepare("DELETE FROM calendar_events").run();
  db.prepare("INSERT OR IGNORE INTO plugins (id, connected, updated_at) VALUES ('calendar', 1, ?)").run(at);
  const account = accounts.create("calendar", "owner@example.com");
  accounts.writeCredentials(account, "calendar", ["client-id", "client-secret", "refresh-token"], {
    "client-id": "id",
    "client-secret": "secret",
    "refresh-token": "refresh",
  });
  replaceCalendars(account.id, [
    { id: "primary@example.com", summary: "Me", timezone: "Europe/Dublin", primary: true, selected: true, accessRole: "owner", color: null, writable },
    { id: "holidays", summary: "Holidays", timezone: "Europe/Dublin", primary: false, selected: true, accessRole: "reader", color: null, writable: false },
  ]);
  replaceCalendarEvents(account.id, "primary@example.com", "0000", "9999", [
    {
      id: "ev-1", summary: "Dentist", start: "2026-10-02T10:00:00+01:00", end: "2026-10-02T10:30:00+01:00",
      allDay: false, status: "confirmed", location: null, attendees: null, organizerSelf: true,
      response: null, link: null, meetLink: null, updated: null,
    },
  ]);
  replaceCalendarEvents(account.id, "holidays", "0000", "9999", [
    {
      id: "hol-1", summary: "Bank holiday", start: "2026-10-26", end: "2026-10-27",
      allDay: true, status: "confirmed", location: null, attendees: null, organizerSelf: false,
      response: null, link: null, meetLink: null, updated: null,
    },
  ]);
  return account.id;
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body;
    calls.push({ method, url, body });
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return Response.json({ access_token: "t", scope: "https://www.googleapis.com/auth/calendar" });
    if (method === "DELETE") return new Response(null, { status: 204 });
    const b = (body ?? {}) as { summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } };
    const id = method === "POST" ? "new-1" : decodeURIComponent(new URL(url).pathname.split("/").pop()!);
    return Response.json({
      id,
      summary: b.summary ?? "Dentist",
      status: "confirmed",
      start: b.start ?? { dateTime: "2026-10-02T10:00:00+01:00" },
      end: b.end ?? { dateTime: "2026-10-02T10:30:00+01:00" },
      htmlLink: "https://www.google.com/calendar/event?eid=x",
      organizer: { self: true },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const req = (method: string, path: string, body?: unknown) =>
  calendarRoutes.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("create lands on the primary writable calendar, never emails, and is readable at once", async () => {
  seed(true);
  const res = await req("POST", "/events", { summary: "Call accountant", start: "2026-10-02T15:00:00+01:00" });
  assert.equal(res.status, 201);
  const doc = (await res.json()) as { event: { eventId: string; end: string; calendarId: string } };
  assert.equal(doc.event.eventId, "new-1");
  assert.equal(doc.event.calendarId, "primary@example.com");

  const post = calls.find((c) => c.method === "POST" && c.url.includes("/calendar/v3/"))!;
  assert.match(post.url, /sendUpdates=none/);
  assert.match(post.url, /\/calendars\/primary%40example\.com\/events\?/);
  assert.deepEqual((post.body as { end: unknown }).end, { dateTime: "2026-10-02T15:00:00Z", date: null });
  assert.equal(findCalendarEvent("new-1").length, 1);

  const read = (await (await calendarRoutes.request("/")).json()) as { canWrite: boolean };
  assert.equal(read.canWrite, true);
});

test("a read-only grant is refused before Google is asked", async () => {
  seed(false);
  const res = await req("POST", "/events", { summary: "x", start: "2026-10-02" });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /auth\/calendar scope/);
  assert.equal(calls.length, 0);
});

test("a shared read-only calendar is refused even with a write grant", async () => {
  seed(true);
  const res = await req("DELETE", "/events/hol-1");
  assert.equal(res.status, 409);
  assert.equal(calls.length, 0);
  assert.equal(findCalendarEvent("hol-1").length, 1);
});

test("moving only the start keeps the event's length", async () => {
  seed(true);
  const res = await req("PATCH", "/events/ev-1", { start: "2026-10-02T16:00:00+01:00" });
  assert.equal(res.status, 200);
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual((patch.body as { end: unknown }).end, { dateTime: "2026-10-02T15:30:00Z", date: null });
  assert.equal(findCalendarEvent("ev-1")[0]!.starts_at, "2026-10-02T16:00:00+01:00");
});

test("bad times are refused with the shape they should have", async () => {
  seed(true);
  for (const body of [
    { summary: "x", start: "15:00" },
    { summary: "x", start: "2026-10-02T15:00:00" },
    { summary: "x", start: "2026-10-02", end: "2026-10-02T16:00:00Z" },
    { summary: "x", start: "2026-10-02T15:00:00Z", end: "2026-10-02T14:00:00Z" },
    { start: "2026-10-02" },
  ]) {
    const res = await req("POST", "/events", body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(calls.length, 0);
});

test("delete removes the row after Google does", async () => {
  seed(true);
  const res = await req("DELETE", "/events/ev-1");
  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.includes("/events/ev-1?sendUpdates=none")));
  assert.equal(findCalendarEvent("ev-1").length, 0);
});
