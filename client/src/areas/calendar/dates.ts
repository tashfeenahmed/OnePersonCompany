import type { CalendarEvent } from "@/lib/api/reports";

/**
 * The arithmetic behind the calendar page, kept out of the render tree.
 *
 * Week grids and "which days does this event touch" are the two things on a
 * calendar that are actually easy to get wrong, and they are pure functions of
 * their inputs — so they live here, where they can be read, reasoned about and
 * tested without a component in the way.
 *
 * THE PAGE DRAWS IN THE BROWSER'S TIMEZONE, AND THAT IS A DEPARTURE FROM THE
 * WIDGETS ON PURPOSE.
 *
 * `liveWidgets.ts` prints a time by SLICING it out of the RFC3339 string, so a
 * row says the hour that is on the invitation whatever offset the reader is
 * in. That is right for a row and wrong for a grid. This page has a vertical
 * axis that IS a clock: with slicing, a 09:00 event on a calendar in Karachi
 * and a 09:00 event on one in Dublin would be drawn in the same row while
 * being four hours apart, and the grid would be reporting a clash that does
 * not exist. The owner's own account already carries calendars in three
 * timezones, so this is not a hypothetical.
 *
 * So every timed event is PARSED — the offset in Google's own string is what
 * makes that unambiguous — and drawn, labelled and bucketed in one clock, the
 * browser's. `TIMEZONE` below is the name of that clock and the page prints
 * it, because a grid that does not say which clock it is in has not answered
 * the question.
 *
 * ALL-DAY EVENTS ARE THE EXCEPTION AND MUST STAY ONE. They arrive as a bare
 * 'YYYY-MM-DD', and `new Date("2026-09-08")` is DEFINED to be UTC midnight —
 * which lands on the 7th for anybody west of Greenwich and moves every holiday
 * a day. `parseISODay` builds a LOCAL midnight instead, and nothing in this
 * file parses a date-only string any other way.
 */

/** Monday, because the owner's week starts on one and so does Workdash's. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const MS_DAY = 86_400_000;

/** The clock this page draws in, as the browser names it. Printed on the page
 *  rather than assumed — see the header. */
export const TIMEZONE: string =
  Intl.DateTimeFormat().resolvedOptions().timeZone || "your browser's timezone";

/* ------------------------------------------------------------------ days */

/** 'YYYY-MM-DD' for a LOCAL date. Never `toISOString().slice(0,10)`, which is
 *  the UTC day and is a different day for half of every evening. */
export function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** LOCAL midnight on a 'YYYY-MM-DD', or null. See the header on why this is
 *  not `new Date(value)`. */
export function parseISODay(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const out = new Date(y, m - 1, d);
  return Number.isNaN(out.getTime()) || out.getMonth() !== m - 1 ? null : out;
}

/** Midnight, n days on. `setDate` rather than adding 86.4e6 ms: an hour of
 *  every spring is missing and arithmetic on milliseconds walks into it. */
export function addDays(day: Date, n: number): Date {
  const out = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  out.setDate(out.getDate() + n);
  return out;
}

/** The Monday of the week containing `d`. */
export function startOfWeek(d: Date): Date {
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (midnight.getDay() + 6) % 7;
  return addDays(midnight, -back);
}

/** Monday to Sunday. */
export function weekDays(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** Whole days between two midnights. Computed through UTC noon on each date so
 *  a daylight-saving boundary inside the span cannot round it to 0 or 2. */
export function daysBetween(a: Date, b: Date): number {
  const at = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const bt = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bt - at) / MS_DAY);
}

/* ---------------------------------------------------------------- events */

/** When it starts, in the browser's clock. All-day events get local midnight
 *  on their own date; timed ones are parsed with the offset Google sent. */
export function eventStart(e: CalendarEvent): Date | null {
  if (!e.start) return null;
  if (e.allDay || e.start.length <= 10) return parseISODay(e.start);
  const d = new Date(e.start);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** When it ends. Google's all-day `end` is EXCLUSIVE — a one-day event on the
 *  8th ends on the 9th — and that is kept rather than corrected here, because
 *  every caller below wants the exclusive bound. */
export function eventEnd(e: CalendarEvent): Date | null {
  if (!e.end) return null;
  if (e.allDay || e.end.length <= 10) return parseISODay(e.end);
  const d = new Date(e.end);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Every day this occurrence touches, as 'YYYY-MM-DD'.
 *
 * One entry for a timed event, however late it runs: a call from 23:00 to
 * 00:30 is Tuesday's call, and putting it on Wednesday's column as well would
 * make Wednesday look like it starts with a meeting. All-day events DO span,
 * because "Stay at Brewers Inn, 8th to the 12th" is a fact about five days and
 * showing it only on the 8th is how a trip disappears from the week you are
 * looking at.
 */
export function eventDays(e: CalendarEvent): string[] {
  const start = eventStart(e);
  if (!start) return [];
  if (!e.allDay) return [isoDay(start)];
  const end = eventEnd(e);
  const span = end ? Math.max(1, daysBetween(start, end)) : 1;
  /* CAPPED AT A YEAR. The span comes off a string a calendar provider sent,
     and a typo'd end date in 2130 would otherwise be a loop nobody returns
     from. A hundred-day "event" is already not something this page can draw. */
  return Array.from({ length: Math.min(span, 366) }, (_, i) => isoDay(addDays(start, i)));
}

/** Minutes past this event's own midnight, in the browser's clock. */
export function minutesInto(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Does this occurrence occupy the owner's day?
 *
 * The server's own rule, kept identical on purpose — `isBusy` in
 * calendar-route.ts. An all-day event has no honest number of hours, a
 * cancelled meeting is news rather than a commitment, and a declined
 * invitation is not an hour of anybody's day. An UNANSWERED one is, because it
 * is still sitting in the slot on the calendar the owner is looking at.
 */
export function isBusy(e: CalendarEvent): boolean {
  if (e.allDay) return false;
  if (e.status === "cancelled") return false;
  if (e.response === "declined") return false;
  return !!e.start && !!e.end;
}

/**
 * Busy minutes over a set of occurrences, OVERLAPS MERGED AND NEVER ADDED.
 *
 * Two calls booked over the same hour are one busy hour of one person's day;
 * adding them reports a thirty-hour Tuesday, which is not a thing. The server
 * computes exactly this over every calendar — and the page cannot simply reuse
 * that figure, because hiding a calendar has to change it. Same algorithm,
 * recomputed over what is actually on screen, so the figure and the grid can
 * never disagree.
 */
export function busyMinutes(events: CalendarEvent[]): number {
  const spans = events
    .filter(isBusy)
    .map((e) => [Date.parse(e.start!), Date.parse(e.end!)] as const)
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

/**
 * Side-by-side lanes for events that overlap.
 *
 * A week grid draws a timed event as a block, and two blocks in the same hour
 * on top of each other hide one of them entirely — which is the worst thing a
 * calendar can do, because the hidden one is exactly the clash you opened the
 * page to find. The rule is the one every calendar uses: a run of mutually
 * overlapping events is a CLUSTER, the cluster is as wide as its busiest
 * moment, and every event in it keeps that width so the columns line up.
 */
export function lanes(
  events: { start: number; end: number }[],
): { lane: number; of: number }[] {
  const order = events.map((e, i) => ({ ...e, i })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: { lane: number; of: number }[] = events.map(() => ({ lane: 0, of: 1 }));

  let cluster: typeof order = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (!cluster.length) return;
    const ends: number[] = [];
    for (const e of cluster) {
      let lane = ends.findIndex((t) => t <= e.start);
      if (lane === -1) {
        lane = ends.length;
        ends.push(e.end);
      } else ends[lane] = e.end;
      out[e.i] = { lane, of: 1 };
    }
    for (const e of cluster) out[e.i]!.of = ends.length;
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const e of order) {
    if (cluster.length && e.start >= clusterEnd) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.end);
  }
  flush();
  return out;
}

/* ---------------------------------------------------------------- labels */

const HHMM = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

/** "14:30", in the browser's clock. */
export const clockLabel = (d: Date): string => HHMM.format(d);

/** "09:00 – 10:30", or the honest word for something with no clock. */
export function rangeLabel(e: CalendarEvent): string {
  if (e.allDay) {
    const days = eventDays(e).length;
    return days > 1 ? `all day · ${days} days` : "all day";
  }
  const start = eventStart(e);
  if (!start) return "—";
  const end = eventEnd(e);
  return end ? `${clockLabel(start)} – ${clockLabel(end)}` : clockLabel(start);
}

/** How long it runs. Never a number of hours for an all-day event: there is
 *  no honest one, which is the server's rule too. */
export function lengthLabel(e: CalendarEvent): string {
  if (e.allDay) return "all day";
  if (e.minutes === null) return "—";
  if (e.minutes < 60) return `${e.minutes}m`;
  const h = Math.floor(e.minutes / 60);
  const m = e.minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "12.5h", or "0h" for a day that was read and had nothing on it. */
export function hoursLabel(minutes: number): string {
  return `${Math.round((minutes / 60) * 10) / 10}h`;
}

const HEADING = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
});

/** "Tuesday 8 September". */
export const dayHeading = (d: Date): string => HEADING.format(d);

/** Written down rather than asked of `Intl`, which answers "Sept" for
 *  September under en-GB and "Sep" under en-US — a heading that changes width
 *  with the reader's locale is a heading that reflows the nav beside it. */
export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "8 – 14 Sep 2026", collapsing whatever the two ends share. */
export function weekHeading(monday: Date): string {
  const sunday = addDays(monday, 6);
  const month = (d: Date) => MONTHS[d.getMonth()]!;
  const sameMonth = monday.getMonth() === sunday.getMonth();
  const sameYear = monday.getFullYear() === sunday.getFullYear();
  const left = sameMonth && sameYear ? `${monday.getDate()}` : `${monday.getDate()} ${month(monday)}`;
  const leftYear = sameYear ? "" : ` ${monday.getFullYear()}`;
  return `${left}${leftYear} – ${sunday.getDate()} ${month(sunday)} ${sunday.getFullYear()}`;
}

/**
 * How far off the next thing is, in the coarsest unit that is still true.
 *
 * Minutes for the next hour, hours for the rest of the day, and days after
 * that — "in 2 days" is what anybody does with the figure and "in 51 hours"
 * makes them do the division themselves. Past half a day the unit is the
 * CALENDAR's day rather than a division by 24: thirty hours from 23:00 is the
 * day after tomorrow, and arithmetic on hours would call it tomorrow.
 */
export function untilText(start: Date, now: Date): string {
  const mins = Math.round((start.getTime() - now.getTime()) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins} min`;
  if (mins < 60 * 12) return `in ${Math.round(mins / 60)}h`;
  const days = daysBetween(now, start);
  return days <= 0 ? "later today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

/** The title Google never got. The word is this page's, not the server's —
 *  the route sends null, which is the honest thing for it to send. */
export const titleOf = (e: CalendarEvent): string => e.summary?.trim() || "(no title)";

/** A stable key for one occurrence, since an id is only unique per calendar. */
export const eventKey = (e: CalendarEvent): string => `${e.calendarId}:${e.eventId}`;

/* ---------------------------------------------------------------- colour */

/**
 * Google's own colour for a calendar, softened into a background.
 *
 * The API returns saturated mid-tones chosen against a white page, so they are
 * used at low alpha BEHIND the text rather than under it — that survives dark
 * mode, where a solid chip of Google-indigo would be the brightest thing on
 * the screen. Anything that is not a plain six-digit hex is refused and the
 * chip falls back to the app's own tokens; the collector already refuses one,
 * and this is the second gate because the value ends up in a `style`.
 */
export function tint(color: string | null, dark: boolean): string | undefined {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  return `${color}${dark ? "3d" : "2e"}`;
}

/** The same colour at full strength, for a 6px rule or a legend dot. */
export const dot = (color: string | null): string | undefined =>
  color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;
