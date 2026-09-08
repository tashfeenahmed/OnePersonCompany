/**
 * Google Calendar — what is on today, what is coming, and how much of the week
 * is already spoken for.
 *
 * BUSY HOURS ARE COMPUTED ON EVERY READ AND ARE NEVER STORED, for the reason
 * every derived figure on this server is: a stored "12.5 hours of meetings on
 * Thursday" is wrong the moment somebody accepts an invitation, and the row it
 * was computed from is right. So the events table holds occurrences and this
 * file does the arithmetic.
 *
 * OVERLAPPING MEETINGS ARE MERGED, NOT ADDED. Two calls booked over the same
 * hour are one busy hour of one person's day — adding them would report a
 * thirty-hour Tuesday, which is not a thing. The intervals are merged first
 * and the merged length is the figure. This is also why "busy hours" is never
 * called "meeting hours": it is how much of the day is unavailable, not how
 * much meeting there is.
 *
 * A DECLINED MEETING IS NOT AN HOUR OF ANYBODY'S DAY. `response` is the
 * owner's own responseStatus, and busy counts `accepted`, `tentative` and
 * `needsAction` — an invitation not yet answered still occupies the slot on
 * the calendar the owner is looking at — but never `declined`. A `cancelled`
 * event is out entirely: it is on the page because it was called off, which is
 * news, and it is not a commitment.
 *
 * AN ALL-DAY EVENT HAS NO HOURS AND IS NOT GIVEN ANY. "Conference" across
 * three days is not twenty-four hours of meetings and not eight either; there
 * is no honest number, so all-day events are listed and counted and excluded
 * from every hours figure. The document says so beside the figure rather than
 * leaving a reader to wonder why Friday is empty.
 *
 * TIMES ARE THE EVENT'S OWN, NOT UTC. Google returns RFC3339 with the offset
 * the event was created in, and that is what is stored and what is on the wire
 * — see migration 032. So the DAY an event belongs to is the date in its own
 * string, which is what a person means by "Thursday". The one place that meets
 * this box's own clock is the word "today", and the note says which clock that
 * is.
 */
import { Hono } from "hono";
import { accountRows } from "../../db.ts";
import { AHEAD_DAYS, BACK_DAYS } from "./calendar.ts";
import {
  calendarEventsBetween,
  calendars,
  clockAt,
  type CalendarEventRow,
} from "./store.ts";

export const calendarRoutes = new Hono();

/** How far ahead the "next" view reaches. Seven, because that is the week the
 *  question is about; the collector holds three weeks and `?days=` can ask for
 *  them. */
const DEFAULT_DAYS = 7;

/**
 * The widest `days` this route will serve, which is the whole window the
 * collector maintains and not one day more.
 *
 * IT USED TO BE `AHEAD_DAYS`, AND THAT WAS RIGHT WHILE THE ONLY CALLER LOOKED
 * FORWARD. The calendar PAGE looks at a week at a time and pages backwards as
 * well as forwards, so it asks for the whole held window in one document and
 * slices its own weeks out of it — which is a span of BACK_DAYS + AHEAD_DAYS
 * whenever `?from=` starts behind today. Asking for more than the collector
 * holds is not refused so much as pointless: the days past the edge would
 * come back empty and read as free time, which is the one lie this file is
 * built to avoid.
 */
const MAX_DAYS = BACK_DAYS + AHEAD_DAYS;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The local date this box is having, as 'YYYY-MM-DD'. Deliberately LOCAL and
 *  not UTC: "what is on today" is a question about the owner's morning, and at
 *  01:00 in Dublin the UTC date is still yesterday's for another hour in the
 *  other direction of the year. */
function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The day an event belongs to: the date inside its own timestamp. */
const dayOf = (e: CalendarEventRow) => (e.starts_at ?? "").slice(0, 10);

/** Does this occurrence occupy the owner's day? See the header. */
function isBusy(e: CalendarEventRow): boolean {
  if (e.all_day) return false;
  if (e.status === "cancelled") return false;
  if (e.response === "declined") return false;
  return !!e.starts_at && !!e.ends_at;
}

/**
 * Merged busy minutes over a set of occurrences.
 *
 * A day with no meetings is a real 0 rather than a null, and that is safe
 * here in a way it would not be elsewhere: the caller only ever passes days
 * INSIDE the window the collector maintains, so "nothing on that day" is a
 * measurement and not an absence of one. A day outside the window is not
 * offered by this route at all.
 */
function busyMinutes(events: CalendarEventRow[]): number {
  const spans = events
    .filter(isBusy)
    .map((e) => [Date.parse(e.starts_at!), Date.parse(e.ends_at!)] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);

  let total = 0;
  let start: number | null = null;
  let end = 0;
  for (const [a, b] of spans) {
    if (start === null) {
      start = a;
      end = b;
      continue;
    }
    if (a <= end) end = Math.max(end, b);
    else {
      total += end - start;
      start = a;
      end = b;
    }
  }
  if (start !== null) total += end - start;
  return Math.round(total / 60_000);
}

const shape = (e: CalendarEventRow, calendarName: (id: string) => string) => ({
  calendarId: e.calendar_id,
  calendar: calendarName(e.calendar_id),
  eventId: e.event_id,
  summary: e.summary,
  start: e.starts_at,
  end: e.ends_at,
  allDay: e.all_day === 1,
  status: e.status,
  location: e.location,
  /** A COUNT. There is no guest list on this box — see migration 032. */
  attendees: e.attendees,
  organizerSelf: e.organizer_self === null ? null : e.organizer_self === 1,
  response: e.response,
  /* WHERE THE OCCURRENCE CAN BE CHANGED, since it cannot be changed here.
     Null on every row collected before migration 036, and null is drawn as
     "no link" rather than as a broken one. */
  link: e.html_link,
  meetLink: e.hangout_link,
  busy: isBusy(e),
  minutes:
    isBusy(e) && e.starts_at && e.ends_at
      ? Math.max(0, Math.round((Date.parse(e.ends_at) - Date.parse(e.starts_at)) / 60_000))
      : null,
  updated: e.updated_at,
});

/** A 'YYYY-MM-DD' that is really one, or null. Nothing else may become a
 *  window bound: the bounds go into a string comparison against stored starts,
 *  and a bound of "yesterday" would silently match everything. */
function asDay(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

calendarRoutes.get("/", (c) => {
  const days = clamp(Number(c.req.query("days") ?? DEFAULT_DAYS) || DEFAULT_DAYS, 1, MAX_DAYS);
  const today = localDay();

  /*
    WHERE THE `days` ARRAY STARTS, and it is today unless somebody says
    otherwise. `?from=` exists for the calendar page, which draws a WEEK at a
    time and pages in both directions — a grid that could only ever begin on
    the day you happen to be reading it would put Monday in a different column
    every morning.

    IT IS CLAMPED TO THE COLLECTED WINDOW rather than honoured as asked. Days
    behind BACK_DAYS or past AHEAD_DAYS hold no rows on this box, and a route
    that returned them as empty days would be reporting free time it never
    read. Clamping means a caller asking for March gets the earliest week
    there IS, and `summary.window` says which one it got, so the page can tell
    the reader it did not go where they asked.
  */
  const earliest = addDays(today, -BACK_DAYS);
  const latest = addDays(today, AHEAD_DAYS);
  const asked = asDay(c.req.query("from"));
  const start =
    asked === null ? today : asked < earliest ? earliest : asked > latest ? latest : asked;
  const horizon = addDays(start, days);

  const cals = calendars();
  const name = (id: string) => cals.find((x) => x.calendar_id === id)?.summary ?? id;
  const accountLabels = new Map(accountRows("calendar").map((a) => [a.id, a.label]));

  /* The read window starts at the owner's own back-window so "what did I do
     last week" stays answerable from the same document, and ends at whichever
     of the horizon and today reaches further — the `today` block below is
     always the box's own today even when the caller is looking at last week.
     The string bounds work because every stored start begins with a sortable
     date. */
  const from = earliest;
  const rows = calendarEventsBetween(from, addDays(horizon > today ? horizon : today, 1));

  const todays = rows.filter((e) => dayOf(e) === today);
  const upcoming = rows.filter((e) => dayOf(e) >= start && dayOf(e) < horizon);
  const past = rows.filter((e) => dayOf(e) < start);

  const byDay: {
    day: string;
    events: ReturnType<typeof shape>[];
    allDay: ReturnType<typeof shape>[];
    busyMinutes: number;
    busyHours: number;
  }[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    const held = upcoming.filter((e) => dayOf(e) === day);
    const minutes = busyMinutes(held);
    byDay.push({
      day,
      events: held.filter((e) => !e.all_day).map((e) => shape(e, name)),
      allDay: held.filter((e) => e.all_day === 1).map((e) => shape(e, name)),
      busyMinutes: minutes,
      busyHours: Math.round((minutes / 60) * 10) / 10,
    });
  }

  const totalBusy = byDay.reduce((n, d) => n + d.busyMinutes, 0);
  const todayBusy = busyMinutes(todays);

  return c.json({
    connected: accountRows("calendar").some((a) => a.connected === 1),
    accounts: accountRows("calendar").map((a) => ({
      id: a.id,
      label: a.label,
      connected: a.connected === 1,
      lastOkAt: a.last_ok_at,
      lastError: a.last_error,
      lastReadAt: clockAt("calendar", String(a.id)),
    })),
    calendars: cals.map((k) => ({
      accountId: k.account_id,
      account: accountLabels.get(k.account_id) ?? `#${k.account_id}`,
      calendarId: k.calendar_id,
      summary: k.summary,
      timezone: k.timezone,
      primary: k.is_primary === 1,
      /** The owner's own tick in Google. Only selected calendars are read. */
      selected: k.selected === 1,
      accessRole: k.access_role,
      /** Google's own colour for it, so a grid on this box agrees with the
       *  app the owner already knows. Null until the collector next runs. */
      color: k.color,
      seenAt: k.seen_at,
    })),
    today: {
      day: today,
      events: todays.filter((e) => !e.all_day).map((e) => shape(e, name)),
      allDay: todays.filter((e) => e.all_day === 1).map((e) => shape(e, name)),
      busyMinutes: todayBusy,
      busyHours: Math.round((todayBusy / 60) * 10) / 10,
      /** The next thing that has not started yet, or null. */
      next:
        todays
          .filter((e) => isBusy(e) && Date.parse(e.starts_at!) > Date.now())
          .map((e) => shape(e, name))[0] ?? null,
    },
    days: byDay,
    summary: {
      /* WHICH DAYS `days` ACTUALLY COVERS, which is not always the ones asked
         for: `from` is clamped to the collected window, so a caller reads
         this back rather than assuming its own request was honoured. */
      window: { from: start, to: horizon, days },
      /* WHAT THIS BOX HOLDS AT ALL, so a page can say where its grid stops
         being a measurement. Bounds, not a promise that every day inside them
         was read: a calendar the grant cannot see contributes nothing here
         and the plugin's own error says so. */
      held: { from: earliest, to: latest, backDays: BACK_DAYS, aheadDays: AHEAD_DAYS },
      events: upcoming.length,
      busyMinutes: totalBusy,
      busyHours: Math.round((totalBusy / 60) * 10) / 10,
      allDayEvents: upcoming.filter((e) => e.all_day === 1).length,
      declined: upcoming.filter((e) => e.response === "declined").length,
      cancelled: upcoming.filter((e) => e.status === "cancelled").length,
      /** What is behind the window, for the record: the collector keeps a
       *  week of it so "what did I do last week" is answerable here. */
      heldBefore: past.length,
    },
    notes: {
      busy:
        "Busy hours MERGE overlapping events rather than adding them — two " +
        "calls booked over the same hour are one busy hour. It counts " +
        "accepted, tentative and unanswered invitations and never declined " +
        "ones, and never a cancelled event.",
      allDay:
        "An all-day event contributes NO hours. 'Conference' across three days " +
        "is not twenty-four hours and not eight; there is no honest number, so " +
        "they are listed and counted separately.",
      times:
        "Times are Google's own RFC3339 strings, with the offset the event was " +
        "created in. Nothing here is normalised to UTC, and the day an event " +
        "belongs to is the date inside its own timestamp.",
      today: `“Today” is ${today}, this server's local date.`,
      horizon:
        "`?from=` moves the days array; it is CLAMPED to the collected window " +
        "rather than refused, so summary.window.from is the day this document " +
        "actually starts on and summary.held is as far as this box can go.",
      window:
        `The collector maintains ${BACK_DAYS} days back and ${AHEAD_DAYS} ahead ` +
        "across the calendars ticked in Google. Anything outside that is not " +
        "held here, and an unticked calendar is not read at all.",
      privacy:
        "No event description is stored or fetched, and no attendee is named: " +
        "`attendees` is a count and `response` is the owner's own answer.",
    },
  });
});
