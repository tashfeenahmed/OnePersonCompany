import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { PageShell } from "@/components/PageShell";
import { useApi } from "@/hooks/useApi";
import { reports, type CalendarEvent, type CalendarReport } from "@/lib/api/reports";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Coming, DayInFull } from "./Agenda";
import { WeekGrid, type DayColumn } from "./WeekGrid";
import {
  addDays,
  busyMinutes,
  dayHeading,
  dot,
  eventDays,
  eventKey,
  eventStart,
  hoursLabel,
  isoDay,
  parseISODay,
  sameDay,
  startOfWeek,
  tint,
  TIMEZONE,
  titleOf,
  untilText,
  weekDays,
  weekHeading,
  WEEKDAYS,
} from "./dates";

/** Eight hues for calendars Google gave none — see `colors` in the page. */
const FALLBACK_HUES = ["#4f86f7", "#e2725b", "#33a06f", "#c98a1f", "#8b6bd1", "#2aa7b8", "#d95fa0", "#7f8c3a"];

/**
 * CALENDAR — the hours already spoken for, as a week.
 *
 * Workdash draws this account as a MONTH, and the month is right for the
 * question it asks: is anything on, and roughly when. This page asks the next
 * question down — when am I actually free — and that one needs a clock on the
 * vertical axis, which a month cell does not have room for. Everything else
 * Workdash's page does is here: today marked, blocks in their calendar's own
 * colour, an all-day row, the day in full underneath, what the grid is merged
 * from, and a next-up figure measured against this minute rather than against
 * the window.
 *
 * THE URL IS THE SELECTION, the way every tabbed page here does it.
 * `/calendar/2026-09-08` opens the week containing that day AND selects it, so
 * one parameter carries both and a link to a particular day is a link somebody
 * can keep. `/calendar` is this week.
 *
 * ONE FETCH, EVERY WEEK IT CAN REACH. The route holds a fixed window — a week
 * back, three ahead — and the whole of it arrives in one document, so paging
 * between weeks is instant and cannot show a half-loaded grid. The bounds come
 * back in `summary.held` rather than being assumed here, which is what lets the
 * nav stop at the edge instead of drawing empty weeks.
 *
 * WHAT THIS PAGE WILL NOT SAY, drawn on it rather than left implicit:
 *
 *   A DAY OUTSIDE THE HELD WINDOW IS NOT A FREE DAY. It is a day nobody read,
 *   and the nav refuses to go there rather than showing seven empty columns.
 *   AN ALL-DAY ENTRY IS NEVER GIVEN HOURS. "Conference" across three days is
 *   not twenty-four hours and not eight; there is no honest number, so they
 *   are listed above the clock and counted separately. The server's own rule.
 *   BUSY HOURS MERGE OVERLAPS. Two calls booked over the same hour are one
 *   busy hour of one person's day. Recomputed here rather than taken from the
 *   route, because hiding a calendar has to change the figure.
 *   THERE ARE NO ATTENDEE NAMES TO SHOW. The collector asks Google only
 *   whether the owner is on the guest list and what they answered, so a count
 *   is the whole of what exists — not a redaction of something held.
 */

/** How far a single request reaches. Larger than the collected window on
 *  purpose: the route CLAMPS both bounds to what it holds and reports what it
 *  settled on, so this asks for more than can exist and reads the answer back
 *  rather than hard-coding the collector's numbers in a second place. */
const ASK_DAYS = 60;
const ASK_BACK = 30;

/** Days with something on them in the coming list before it is cut. */
const COMING_DAYS = 8;

const HIDDEN_KEY = "opc.calendar.hidden";

/**
 * WHICH CALENDARS ARE HIDDEN, remembered in this browser and nowhere else.
 *
 * It is a view preference and not a fact about the business, so it does not
 * belong in the workspace document every device shares — hiding the holidays
 * on a laptop should not hide them on a phone. Every read and write is wrapped:
 * a private window, cleared site data or a browser set to block storage all
 * throw on access, and a calendar page that refuses to render because it could
 * not remember a checkbox would be a page nobody forgives.
 */
function useHiddenCalendars(): [Set<string>, (id: string) => void] {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  });

  const toggle = useCallback((id: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      } catch {
        /* nothing to remember it with; the choice still holds for this visit */
      }
      return next;
    });
  }, []);

  return [hidden, toggle];
}

const weekdayOf = (d: Date): string => WEEKDAYS[(d.getDay() + 6) % 7]!;

/** A figure with the sentence that makes it checkable under it. */
function Stat({
  figure,
  label,
  note,
  muted,
}: {
  figure: string;
  label: string;
  note: string;
  muted?: boolean;
}) {
  return (
    <div className="bg-card rounded-[14px] px-4.5 py-3.5">
      <div
        className={cn(
          "text-[21px] font-normal tracking-[-0.03em] tabular-nums",
          muted && "text-muted-foreground",
        )}
      >
        {figure}
      </div>
      <div className="mt-0.5 text-[13.5px] font-medium">{label}</div>
      <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{note}</p>
    </div>
  );
}

function NotConnected() {
  return (
    <div className="bg-card rounded-[14px] px-4.5 py-3.5">
      <div className="text-[15px] font-medium">No Google calendar is connected</div>
      <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
        The calendar reads its own Google grant — a refresh token minted with{" "}
        <span className="font-mono text-[12px]">calendar.readonly</span>. It cannot
        share the mailbox's: Google grants scopes at the consent screen and no
        call from this box can widen one, so a Gmail token refreshes perfectly
        and then refuses every calendar request.
      </p>
      <Link
        to="/integrations/calendar"
        className="text-foreground hover:bg-accent mt-2.5 inline-block rounded-lg border px-2.5 py-1 text-[13px]"
      >
        Connect it on the Calendar integration →
      </Link>
    </div>
  );
}

export function Calendar() {
  const { day: dayParam } = useParams();
  const navigate = useNavigate();
  const { resolved } = useTheme();
  const dark = resolved === "dark";
  const [hidden, toggleHidden] = useHiddenCalendars();

  /* ONE CLOCK PER RENDER. Seven columns each calling `new Date()` is seven
     chances to straddle midnight, and the grid would then mark two days as
     today. */
  const now = useMemo(() => new Date(), []);
  const today = useMemo(
    () => new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    [now],
  );

  const askFrom = useMemo(() => isoDay(addDays(today, -ASK_BACK)), [today]);
  const report = useApi<CalendarReport>(
    () => reports.calendar(ASK_DAYS, askFrom),
    [askFrom],
  );

  /* A `/calendar/<not a day>` selects nothing rather than erroring: an address
     somebody mistyped should land on this week, not on a stack trace. */
  const selectedDate = useMemo(
    () => parseISODay(dayParam ?? null) ?? today,
    [dayParam, today],
  );
  const monday = useMemo(() => startOfWeek(selectedDate), [selectedDate]);
  const selectedKey = isoDay(selectedDate);

  /* The nav is a set of links, and pressing one changes the address, which is
     what changes the grid. `replace` so paging through six weeks does not
     leave six entries between the reader and the page they came from. */
  const goTo = useCallback(
    (d: Date) => navigate(`/calendar/${isoDay(d)}`, { replace: true }),
    [navigate],
  );

  const data = report.data;

  /*
    EVERY OCCURRENCE, RE-BUCKETED INTO THE CLOCK THE GRID IS DRAWN IN.

    The route buckets by the date inside the event's own timestamp, which is
    right for a row that prints that timestamp back. This page draws a time
    axis and therefore has to place everything in ONE clock — see dates.ts —
    so the days are rebuilt here from `eventDays`, in the browser's. The two
    agree for every event on a calendar in the reader's own timezone, which is
    most of them, and disagree by a day only where they must.

    A multi-day all-day entry lands on every day it covers; a timed one lands
    on the day it started, however late it runs.
  */
  const byDay = useMemo(() => {
    const out = new Map<string, CalendarEvent[]>();
    if (!data) return out;
    const seen = new Set<string>();
    for (const d of data.days)
      for (const e of [...d.events, ...d.allDay]) {
        const key = eventKey(e);
        if (seen.has(key)) continue;
        seen.add(key);
        if (hidden.has(e.calendarId)) continue;
        for (const day of eventDays(e)) {
          const list = out.get(day);
          if (list) list.push(e);
          else out.set(day, [e]);
        }
      }
    for (const list of out.values())
      list.sort((a, b) => {
        /* All-day first, then by start. A stay that spans the week should not
           push the morning's calls down the column. */
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return (eventStart(a)?.getTime() ?? 0) - (eventStart(b)?.getTime() ?? 0);
      });
    return out;
  }, [data, hidden]);

  /*
    A CALENDAR ALWAYS HAS A COLOUR, GOOGLE'S OR ONE OF OURS. Google publishes
    one per calendar and the collector keeps it; until it has read one — the
    column is new — and for any calendar it never sends one for, the
    calendar takes a hue from a fixed ring by its position in the list, so
    the same calendar wears the same hue on every visit and two calendars
    never share one until the ring runs out. The ring is a set of eight
    distinct, mid-saturation hues that read on both themes at the 18–24%
    alpha the blocks are tinted at.
  */
  const colors = useMemo(() => {
    const out = new Map<string, string | null>();
    let i = 0;
    for (const k of data?.calendars ?? []) {
      out.set(k.calendarId, k.color ?? FALLBACK_HUES[i++ % FALLBACK_HUES.length]!);
    }
    return out;
  }, [data]);

  const columns: DayColumn[] = useMemo(
    () =>
      weekDays(monday).map((date) => {
        const day = isoDay(date);
        const events = byDay.get(day) ?? [];
        return {
          day,
          date,
          timed: events.filter((e) => !e.allDay),
          allDay: events.filter((e) => e.allDay),
          busyMinutes: busyMinutes(events),
        };
      }),
    [monday, byDay],
  );

  /* The next thing that has not started, measured against this minute and
     scanned across everything held rather than across the week on screen —
     paging back to last Tuesday does not change how far away tomorrow is. */
  const next = useMemo(() => {
    let best: { event: CalendarEvent; start: Date } | null = null;
    for (const list of byDay.values())
      for (const e of list) {
        if (e.status === "cancelled" || e.response === "declined" || e.allDay) continue;
        const start = eventStart(e);
        if (!start || start.getTime() <= now.getTime()) continue;
        if (!best || start.getTime() < best.start.getTime()) best = { event: e, start };
      }
    return best;
  }, [byDay, now]);

  /* COUNTED ONCE PER OCCURRENCE, not once per column it touches — otherwise a
     five-night stay makes the week look five entries busier than it is, and
     whichever calendar holds the trips looks like the busy one. */
  const weekEvents = new Set(
    columns.flatMap((c) => c.timed.concat(c.allDay)).map(eventKey),
  );
  const weekBusy = columns.reduce((n, c) => n + c.busyMinutes, 0);
  const busiest = columns.reduce<DayColumn | null>(
    (best, c) => (!best || c.busyMinutes > best.busyMinutes ? c : best),
    null,
  );

  const held = data?.summary.held;
  const heldFrom = useMemo(() => parseISODay(held?.from) ?? today, [held, today]);
  const heldTo = useMemo(() => parseISODay(held?.to) ?? today, [held, today]);
  const canGoBack = monday.getTime() > startOfWeek(heldFrom).getTime();
  const canGoOn = addDays(monday, 6).getTime() < heldTo.getTime();

  const selectedEvents = byDay.get(selectedKey) ?? [];
  const coming = useMemo(() => {
    const out: { day: string; date: Date; events: CalendarEvent[] }[] = [];
    for (let d = new Date(today); d.getTime() <= heldTo.getTime(); d = addDays(d, 1))
      out.push({ day: isoDay(d), date: d, events: byDay.get(isoDay(d)) ?? [] });
    return out;
  }, [today, heldTo, byDay]);

  /* Escape leaves the selected day and returns to today's week — the one
     keyboard gesture a page whose whole state is an address can offer. */
  useEffect(() => {
    if (!dayParam) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") navigate("/calendar", { replace: true });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dayParam, navigate]);

  const sub =
    "Everything on the calendars ticked in Google, as one week. Times are in " +
    `${TIMEZONE} — this browser's clock — because a grid with a clock down its ` +
    "side can only be drawn in one.";

  if (report.error)
    return (
      <PageShell title="Calendar" sub={sub} wide>
        <p className="text-muted-foreground text-[14px]">
          The API is not answering: {report.error}
        </p>
      </PageShell>
    );

  if (!data)
    return (
      <PageShell title="Calendar" sub={sub} wide>
        <p className="text-muted-foreground text-[14px]">Reading the week…</p>
      </PageShell>
    );

  if (!data.connected)
    return (
      <PageShell title="Calendar" sub={sub} wide>
        <NotConnected />
      </PageShell>
    );

  const read = data.calendars.filter((k) => k.selected);
  const shownCalendars = read.filter((k) => !hidden.has(k.calendarId));

  return (
    <PageShell title="Calendar" sub={sub} wide>
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          figure={next ? untilText(next.start, now) : "—"}
          muted={!next}
          label="Next up"
          note={
            next
              ? `${titleOf(next.event)} · ${dayHeading(next.start)}`
              : "Nothing ahead in the days this box holds. Measured against this minute, not against the week on screen."
          }
        />
        <Stat
          figure={String(weekEvents.size)}
          label="Entries this week"
          note={`${weekHeading(monday)}, across ${shownCalendars.length} of ${read.length} calendar${read.length === 1 ? "" : "s"} shown. Measured — one per occurrence, however many days it spans.`}
        />
        <Stat
          figure={hoursLabel(weekBusy)}
          label="Busy this week"
          note="Metered over the seven days on screen. Overlapping meetings count once; all-day entries and declined invitations count for nothing."
        />
        <Stat
          figure={busiest && busiest.busyMinutes > 0 ? hoursLabel(busiest.busyMinutes) : "—"}
          muted={!busiest || busiest.busyMinutes === 0}
          label="Busiest day"
          note={
            busiest && busiest.busyMinutes > 0
              ? dayHeading(busiest.date)
              : "No timed commitment in this week at all."
          }
        />
      </div>

      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            disabled={!canGoBack}
            onClick={() => goTo(addDays(monday, -7))}
            aria-label="Previous week"
            className="hover:bg-accent grid size-7 place-items-center rounded-lg border disabled:opacity-35"
          >
            <ChevronLeft className="size-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            disabled={!canGoOn}
            onClick={() => goTo(addDays(monday, 7))}
            aria-label="Next week"
            className="hover:bg-accent grid size-7 place-items-center rounded-lg border disabled:opacity-35"
          >
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <span className="text-[15px] font-medium tabular-nums">{weekHeading(monday)}</span>
        {!sameDay(startOfWeek(today), monday) && (
          <Link
            to="/calendar"
            className="text-foreground hover:bg-accent rounded-lg border px-2.5 py-1 text-[13px]"
          >
            Today
          </Link>
        )}
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {TIMEZONE} · holds {held?.backDays ?? "—"}d back, {held?.aheadDays ?? "—"}d ahead
        </span>
      </div>

      <WeekGrid
        columns={columns}
        today={today}
        selected={selectedKey}
        now={now}
        colors={colors}
        dark={dark}
        onSelectDay={(d) => navigate(`/calendar/${d}`, { replace: true })}
      />

      <h2 className="text-muted-foreground mt-6 mb-2 text-[12px] tracking-[0.06em] uppercase">
        The day in full
      </h2>
      <DayInFull
        date={selectedDate}
        events={selectedEvents}
        busyMinutes={busyMinutes(selectedEvents)}
        colors={colors}
      />

      <h2 className="text-muted-foreground mt-6 mb-2 text-[12px] tracking-[0.06em] uppercase">
        What is coming
      </h2>
      <Coming days={coming} colors={colors} weekdayOf={weekdayOf} limit={COMING_DAYS} />

      <h2 className="text-muted-foreground mt-6 mb-2 text-[12px] tracking-[0.06em] uppercase">
        What the calendar is merged from
      </h2>
      <div className="bg-card rounded-[14px] px-4.5 py-3.5">
        <p className="text-muted-foreground mb-2.5 text-[13px] leading-relaxed">
          Only the calendars ticked in Google are read at all — a Google account
          carries holiday feeds, birthday feeds and everything anybody ever
          shared, and reading them would triple the events and say nothing about
          the owner's day. Hiding one below removes it from this browser's view
          and from every figure on this page; it does not change what is
          collected, and nothing here can edit a calendar.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {read.map((k) => {
            const off = hidden.has(k.calendarId);
            return (
              <button
                key={k.calendarId}
                type="button"
                onClick={() => toggleHidden(k.calendarId)}
                aria-pressed={!off}
                title={
                  off
                    ? `Show ${k.summary ?? k.calendarId}`
                    : `Hide ${k.summary ?? k.calendarId} — ${k.accessRole ?? "unknown role"}, ${k.timezone ?? "no timezone"}`
                }
                style={off ? undefined : { backgroundColor: tint(colors.get(k.calendarId) ?? null, dark), borderLeftColor: dot(colors.get(k.calendarId) ?? null) }}
                className={cn(
                  "hover:bg-accent flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[12.5px]",
                  off && "text-muted-foreground line-through opacity-60",
                )}
              >
                <span
                  aria-hidden="true"
                  style={dot(k.color) ? { backgroundColor: dot(k.color)! } : undefined}
                  className={cn(
                    "size-2 shrink-0 rounded-[3px]",
                    !dot(k.color) && "bg-muted-foreground/40",
                  )}
                />
                {k.summary ?? k.calendarId}
                {k.primary && <span className="text-muted-foreground">· primary</span>}
                {/* A calendar shared as free/busy sends slots and no words.
                    Saying so beside the name is the difference between "this
                    dashboard lost the titles" and "there were never any". */}
                {k.accessRole === "freeBusyReader" && (
                  <span className="text-muted-foreground">· free/busy</span>
                )}
                <span className="text-muted-foreground tabular-nums">
                  {countIn(byDay, k.calendarId, off)}
                </span>
              </button>
            );
          })}
        </div>
        {read.some((k) => k.color === null) && (
          <p className="text-muted-foreground mt-2.5 text-[12px] leading-relaxed">
            A calendar with no swatch is one whose colour this box has not
            collected yet — the field was added after these rows were written,
            and it fills in on the collector's next run. Its blocks use the
            app's own neutral tone until then rather than a colour invented
            here.
          </p>
        )}
      </div>

      <div className="border-line-soft mt-6 rounded-[14px] border border-dashed px-3.5 py-3">
        <div className="mb-2 text-[12px] tracking-[0.06em] uppercase">
          What this page will not say
        </div>
        <ul className="text-muted-foreground space-y-1.5 text-[13px] leading-relaxed">
          <li>
            · Anything outside {held?.from ?? "—"} to {held?.to ?? "—"}. The
            collector keeps {held?.backDays ?? "—"} days back and{" "}
            {held?.aheadDays ?? "—"} ahead, so the arrows stop at those weeks
            rather than drawing empty columns — a day nobody read is not a free
            day.
          </li>
          <li>
            · How many hours an all-day entry is worth. Three days of
            &ldquo;Conference&rdquo; is not twenty-four hours and not eight, so
            all-day entries sit above the clock, are counted separately, and
            contribute nothing to any figure here.
          </li>
          <li>
            · Who is on a meeting. The collector asks Google only whether the
            owner is on the guest list and what they answered — no name and no
            address has ever reached this box, so an attendee count is the whole
            of what exists rather than a redaction of something held. No event
            description is fetched or stored either.
          </li>
          <li>
            · That a busy hour is a meeting hour. Overlapping bookings are
            merged, so two calls in the same hour are one busy hour; declined
            invitations and called-off events are excluded, and an unanswered
            one is included because it is still holding the slot.
          </li>
          <li>
            · What time it is anywhere else. Every block is placed and labelled
            in {TIMEZONE}, this browser's clock — the calendars themselves run
            in {new Set(read.map((k) => k.timezone).filter(Boolean)).size || 1}{" "}
            different ones, and a grid drawn in more than one clock would report
            clashes that do not exist.
          </li>
          {data.summary.cancelled > 0 && (
            <li>
              · Nothing about the {data.summary.cancelled} called-off event
              {data.summary.cancelled === 1 ? "" : "s"} except that they were
              called off. They are drawn struck through rather than removed,
              because a meeting somebody cancelled is news.
            </li>
          )}
        </ul>
        <p className="text-muted-foreground mt-2.5 text-[12px] leading-relaxed">
          Read {data.accounts.map((a) => a.label).join(", ") || "—"} · last
          collection{" "}
          {data.accounts[0]?.lastReadAt?.slice(0, 16).replace("T", " ") ?? "never"}.
          Read-only: there is no request this page can make that creates, moves
          or cancels anything.
        </p>
      </div>
    </PageShell>
  );
}

/** How many of the events on screen came off one calendar. Counted from what
 *  is DRAWN rather than from the server's own tally, so the figure beside a
 *  name can never disagree with the grid above it. */
function countIn(byDay: Map<string, CalendarEvent[]>, calendarId: string, off: boolean): string {
  if (off) return "hidden";
  const seen = new Set<string>();
  for (const list of byDay.values())
    for (const e of list) if (e.calendarId === calendarId) seen.add(eventKey(e));
  return String(seen.size);
}
