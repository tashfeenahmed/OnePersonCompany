import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CalendarOff, ChevronLeft, ChevronRight, Keyboard, Plus } from "lucide-react";

import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { calendarEvents, reports, type CalendarEvent, type CalendarReport } from "@/lib/api/reports";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Agenda } from "./Agenda";
import { EventForm, type FormTarget } from "./EventForm";
import { EventPopover, type OpenedEvent } from "./EventPopover";
import { useWide } from "./useWide";
import { MonthGrid } from "./MonthGrid";
import { CalendarLegend, DaySummary, MiniMonth, UpNext } from "./Sidebar";
import { TimeGrid, type DayColumn } from "./TimeGrid";
import {
  addDays,
  addMonths,
  busyMinutes,
  dayHeading,
  durationLabel,
  eventDays,
  eventKey,
  eventStart,
  isoDay,
  isView,
  parseISODay,
  periodDays,
  periodHeading,
  sameDay,
  startOfMonth,
  startOfWeek,
  stepPeriod,
  TIMEZONE,
  titleOf,
  untilText,
  type View,
} from "./dates";

/**
 * CALENDAR — the owner's Google calendars as Day / Week / Month / Agenda
 * views, with create, edit and delete on the calendars the grant can write.
 *
 * THE URL IS THE SELECTION. `/calendar/2026-10-01?view=week` is the week of
 * the 1st; `/calendar` is today in the last view used (Week on a wide screen,
 * Agenda on a phone). Old `/calendar/<day>` links still open that day's week.
 *
 * ONE FETCH covers everything the collector holds (a week back, three ahead),
 * so paging is instant. The bounds come back in `summary.held`; the arrows
 * stop there and days outside it are drawn hatched, because a day nobody
 * read is not a free day.
 *
 * Times are drawn in the browser's clock, the only honest way to draw one
 * grid when the calendars themselves live in several timezones (dates.ts).
 * Busy time merges overlaps and gives all-day entries no hours — the server's
 * own rule, recomputed here so hiding a calendar changes the figure.
 *
 * WRITES, WHERE THEY CAN. A calendar is `writable` when the Google grant has
 * the `calendar` scope and the owner's role on it is owner or writer
 * (migration 037). Then "New event" and a click on an empty slot open the
 * form, and an event's card can edit or delete it. A read-only grant draws
 * the page exactly as before, with one line saying how to turn writes on.
 */

const ASK_DAYS = 60;
const ASK_BACK = 30;

const HIDDEN_KEY = "opc.calendar.hidden";
const VIEW_KEY = "opc.calendar.view";

/** A view preference, remembered in this browser only. Every access is
 *  wrapped: a private window or blocked storage throws. */
function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* nothing to remember it with; it still holds for this visit */
  }
}

function useHiddenCalendars() {
  const [hidden, setHidden] = useState<Set<string>>(() => {
    const parsed: unknown = readStored(HIDDEN_KEY, []);
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  });
  const save = (next: Set<string>) => {
    writeStored(HIDDEN_KEY, [...next]);
    return next;
  };
  const toggle = useCallback((id: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return save(next);
    });
  }, []);
  const showAll = useCallback(() => setHidden(save(new Set())), []);
  return { hidden, toggle, showAll };
}

/** This minute, re-read every 30 seconds so the now-line and "in 25 min"
 *  keep moving while the page is open. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function agoLabel(iso: string | null | undefined, now: Date): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const mins = Math.round((now.getTime() - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const VIEW_LABEL: Record<View, string> = { day: "Day", week: "Week", month: "Month", agenda: "Agenda" };
const VIEW_KEYS: Record<string, View> = { d: "day", w: "week", m: "month", a: "agenda" };

function NotConnected() {
  return (
    <div className="bg-card flex flex-col items-center gap-2 rounded-[14px] px-6 py-14 text-center">
      <CalendarOff className="text-muted-foreground size-8" strokeWidth={1.5} />
      <div className="text-[16px] font-medium">Connect your Google Calendar</div>
      <p className="text-muted-foreground max-w-md text-[13.5px]">
        The calendar needs its own Google grant (the Gmail one can't read calendars).
      </p>
      <Button asChild size="sm" className="mt-1">
        <Link to="/integrations/calendar">Connect Google Calendar</Link>
      </Button>
    </div>
  );
}

export function Calendar() {
  const { day: dayParam } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { resolved } = useTheme();
  const dark = resolved === "dark";
  const wide = useWide();
  const { hidden, toggle, showAll } = useHiddenCalendars();

  const now = useNow();
  const todayKey = isoDay(now);
  const today = useMemo(() => parseISODay(todayKey)!, [todayKey]);

  /* The request is keyed to the day the page opened, not to the ticking
     clock, so it is made once and not every 30 seconds. */
  const [askFrom] = useState(() => isoDay(addDays(new Date(), -ASK_BACK)));
  const report = useApi<CalendarReport>(() => reports.calendar(ASK_DAYS, askFrom), [askFrom]);
  const data = report.data;

  const view: View = useMemo(() => {
    const fromUrl = search.get("view");
    if (isView(fromUrl)) return fromUrl;
    const stored: unknown = readStored(VIEW_KEY, null);
    if (isView(stored)) return stored;
    return wide ? "week" : "agenda";
  }, [search, wide]);

  const anchor = useMemo(() => parseISODay(dayParam ?? null) ?? today, [dayParam, today]);

  const go = useCallback(
    (date: Date, v: View = view) => {
      if (v !== view) writeStored(VIEW_KEY, v);
      navigate(`/calendar/${isoDay(date)}?view=${v}`, { replace: true });
    },
    [navigate, view],
  );

  /* ------------------------------------------------------------ the data */

  const freeBusy = useMemo(
    () => new Set((data?.calendars ?? []).filter((k) => k.accessRole === "freeBusyReader").map((k) => k.calendarId)),
    [data],
  );

  /* Every occurrence once, re-bucketed into the browser's clock (dates.ts).
     A free/busy calendar sends no title, so its slots read "Busy". */
  const { byDay, visible } = useMemo(() => {
    const out = new Map<string, CalendarEvent[]>();
    const all: CalendarEvent[] = [];
    if (!data) return { byDay: out, visible: all };
    const seen = new Set<string>();
    for (const d of data.days)
      for (const raw of [...d.events, ...d.allDay]) {
        const key = eventKey(raw);
        if (seen.has(key) || hidden.has(raw.calendarId)) continue;
        seen.add(key);
        const e = raw.summary === null && freeBusy.has(raw.calendarId) ? { ...raw, summary: "Busy" } : raw;
        all.push(e);
        for (const day of eventDays(e)) {
          const list = out.get(day);
          if (list) list.push(e);
          else out.set(day, [e]);
        }
      }
    for (const list of out.values())
      list.sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return (eventStart(a)?.getTime() ?? 0) - (eventStart(b)?.getTime() ?? 0);
      });
    return { byDay: out, visible: all };
  }, [data, hidden, freeBusy]);

  /* Google's colour per calendar, or a fixed ring by position when it sent
     none, so a calendar wears the same hue on every visit. */
  const colors = useMemo(() => {
    const ring = ["#4f86f7", "#e2725b", "#33a06f", "#c98a1f", "#8b6bd1", "#2aa7b8", "#d95fa0", "#7f8c3a"];
    const out = new Map<string, string | null>();
    let i = 0;
    for (const k of data?.calendars ?? []) out.set(k.calendarId, k.color ?? ring[i++ % ring.length]!);
    return out;
  }, [data]);

  const counts = useMemo(() => {
    const out = new Map<string, number>();
    if (!data) return out;
    const seen = new Set<string>();
    for (const d of data.days)
      for (const e of [...d.events, ...d.allDay]) {
        if (seen.has(eventKey(e))) continue;
        seen.add(eventKey(e));
        out.set(e.calendarId, (out.get(e.calendarId) ?? 0) + 1);
      }
    return out;
  }, [data]);

  const heldFrom = useMemo(() => parseISODay(data?.summary.held.from) ?? today, [data, today]);
  const heldTo = useMemo(() => parseISODay(data?.summary.held.to) ?? today, [data, today]);
  const isHeld = useCallback(
    (d: Date) => d.getTime() >= heldFrom.getTime() && d.getTime() <= heldTo.getTime(),
    [heldFrom, heldTo],
  );

  const days = useMemo(() => periodDays(view, anchor), [view, anchor]);
  const columns: DayColumn[] = useMemo(
    () =>
      days.map((date) => {
        const day = isoDay(date);
        const events = byDay.get(day) ?? [];
        return {
          day,
          date,
          timed: events.filter((e) => !e.allDay),
          allDay: events.filter((e) => e.allDay),
          busyMinutes: busyMinutes(events),
          held: isHeld(date),
        };
      }),
    [days, byDay, isHeld],
  );

  const agendaDays = useMemo(() => {
    const out: { day: string; date: Date; events: CalendarEvent[] }[] = [];
    const start = anchor.getTime() < heldFrom.getTime() ? heldFrom : anchor;
    for (let d = start; d.getTime() <= heldTo.getTime(); d = addDays(d, 1))
      out.push({ day: isoDay(d), date: d, events: byDay.get(isoDay(d)) ?? [] });
    return out;
  }, [anchor, heldFrom, heldTo, byDay]);

  /* The arrows stop where the collector stops. */
  const periodStart =
    view === "week" ? startOfWeek(anchor) : view === "month" ? startOfMonth(anchor) : anchor;
  const periodEnd =
    view === "week"
      ? addDays(startOfWeek(anchor), 6)
      : view === "month"
        ? addDays(startOfMonth(addMonths(anchor, 1)), -1)
        : view === "agenda"
          ? addDays(anchor, 6)
          : anchor;
  const canPrev = periodStart.getTime() > heldFrom.getTime();
  const canNext = periodEnd.getTime() < heldTo.getTime();
  const onToday =
    view === "week"
      ? sameDay(startOfWeek(anchor), startOfWeek(today))
      : view === "month"
        ? sameDay(startOfMonth(anchor), startOfMonth(today))
        : sameDay(anchor, today);

  const periodBusy = columns
    .filter((c) => view !== "month" || c.date.getMonth() === anchor.getMonth())
    .reduce((n, c) => n + c.busyMinutes, 0);

  /* --------------------------------------------------- the event card */

  const [opened, setOpened] = useState<OpenedEvent | null>(null);
  const close = useCallback(() => setOpened(null), [setOpened]);
  const openAt = useCallback((event: CalendarEvent, e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setOpened({ event, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
  }, [setOpened]);
  const activeKey = opened ? eventKey(opened.event) : null;

  /* ------------------------------------------------------------ writes */

  const writable = useMemo(
    () =>
      (data?.calendars ?? [])
        .filter((k) => k.writable)
        .sort((a, b) => Number(b.primary) - Number(a.primary)),
    [data],
  );
  const canWriteTo = useCallback(
    (e: CalendarEvent) => writable.some((k) => k.calendarId === e.calendarId && k.accountId === e.accountId),
    [writable],
  );
  const [form, setForm] = useState<FormTarget | null>(null);
  const canWrite = !!data?.canWrite;
  const reload = report.reload;
  const startAt = (at: Date) => {
    setOpened(null);
    setForm({ mode: "create", at });
  };
  const newEvent = () => startAt(newEventAt(anchor, today, now));

  /* ---------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const key = e.key.toLowerCase();
      if (key === "c" && canWrite) {
        setOpened(null);
        setForm({ mode: "create", at: newEventAt(anchor, today, now) });
        e.preventDefault();
        return;
      }
      if (key === "t") go(today);
      else if ((e.key === "ArrowLeft" || key === "p" || key === "k") && canPrev) go(stepPeriod(view, anchor, -1));
      else if ((e.key === "ArrowRight" || key === "n" || key === "j") && canNext) go(stepPeriod(view, anchor, 1));
      else if (VIEW_KEYS[key]) go(anchor, VIEW_KEYS[key]);
      else return;
      setOpened(null);
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, today, now, view, anchor, canPrev, canNext, canWrite]);

  /* ------------------------------------------------------------ render */

  const sub = `Your Google calendars${data && !data.canWrite ? ", read-only" : ""} · times in ${TIMEZONE}`;

  if (report.error)
    return (
      <PageShell title="Calendar" sub={sub} wide>
        <div className="bg-card rounded-[14px] px-4.5 py-4 text-[14px]">
          Couldn't load the calendar: <span className="text-muted-foreground">{report.error}</span>
          <Button variant="outline" size="xs" className="ml-3" onClick={report.reload}>
            Try again
          </Button>
        </div>
      </PageShell>
    );

  if (!data)
    return (
      <PageShell title="Calendar" sub={sub} wide>
        <div className="bg-card text-muted-foreground animate-pulse rounded-[14px] px-4.5 py-16 text-center text-[14px]">
          Loading your calendar…
        </div>
      </PageShell>
    );

  if (!data.connected)
    return (
      <PageShell title="Calendar" sub={sub} wide>
        <NotConnected />
      </PageShell>
    );

  const read = data.calendars.filter((k) => k.selected);
  /* The busy/free card follows the day in view, or today when today is on screen. */
  const todayShown = days.some((d) => sameDay(d, today) && (view !== "month" || d.getMonth() === anchor.getMonth()));
  const summaryDay = view !== "day" && todayShown ? today : anchor;
  const summaryEvents = byDay.get(isoDay(summaryDay)) ?? [];
  const nextUp = visible
    .filter((e) => !e.allDay && e.status !== "cancelled" && e.response !== "declined")
    .map((e) => ({ e, s: eventStart(e) }))
    .filter((x) => x.s && x.s.getTime() > now.getTime())
    .sort((a, b) => a.s!.getTime() - b.s!.getTime())[0];

  const upNext = (
    <UpNext events={visible} today={today} now={now} colors={colors} onOpen={openAt} />
  );

  return (
    <PageShell title="Calendar" sub={sub} wide>
      {/* Phones: the one line that matters, above everything. */}
      {nextUp && (
        <button
          type="button"
          onClick={(e) => openAt(nextUp.e, e)}
          className="bg-card mb-3 block w-full rounded-[14px] px-4 py-3 text-left text-[14px] lg:hidden"
        >
          <span className="text-muted-foreground">Next: </span>
          <span className="font-medium">{titleOf(nextUp.e)}</span>{" "}
          {untilText(nextUp.s!, now)}
        </button>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_248px]">
        <div className="min-w-0">
          {/* Toolbar */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {data.canWrite && (
              <Button size="sm" onClick={newEvent} title="New event (C)">
                <Plus strokeWidth={1.75} />
                New event
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => go(today)}
              disabled={onToday}
              title="Go to today (T)"
            >
              Today
            </Button>
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!canPrev}
                onClick={() => go(stepPeriod(view, anchor, -1))}
                aria-label={`Previous ${view === "agenda" ? "week" : view}`}
                title={canPrev ? "Previous (←)" : `Nothing is collected before ${dayHeading(heldFrom)}`}
              >
                <ChevronLeft strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!canNext}
                onClick={() => go(stepPeriod(view, anchor, 1))}
                aria-label={`Next ${view === "agenda" ? "week" : view}`}
                title={canNext ? "Next (→)" : `Nothing is collected after ${dayHeading(heldTo)}`}
              >
                <ChevronRight strokeWidth={1.75} />
              </Button>
            </div>
            <h2 className="min-w-0 text-[17px] font-medium tracking-[-0.01em] tabular-nums">
              {periodHeading(view, anchor)}
            </h2>
            {view !== "agenda" && view !== "day" && (
              <span className="text-muted-foreground hidden text-[12.5px] sm:inline">
                {periodBusy > 0 ? `${durationLabel(periodBusy)} busy` : "nothing booked"}
              </span>
            )}
            <div
              role="tablist"
              aria-label="Calendar view"
              className="bg-muted ml-auto flex rounded-lg p-0.5"
            >
              {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => go(anchor, v)}
                  title={`${VIEW_LABEL[v]} (${v[0]!.toUpperCase()})`}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[12.5px]",
                    view === v
                      ? "bg-card text-foreground font-medium shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {VIEW_LABEL[v]}
                </button>
              ))}
            </div>
          </div>

          {(view === "day" || view === "week") && (
            <TimeGrid
              columns={columns}
              today={today}
              now={now}
              colors={colors}
              dark={dark}
              activeKey={activeKey}
              onOpen={openAt}
              onPickDay={(d) => go(parseISODay(d)!, "day")}
              onCreateAt={data.canWrite ? startAt : undefined}
            />
          )}
          {view === "day" && columns[0] && columns[0].held && columns[0].timed.length + columns[0].allDay.length === 0 && (
            <p className="text-muted-foreground mt-2 text-center text-[13px]">
              Nothing on {sameDay(anchor, today) ? "today" : dayHeading(anchor)} — a clear day.
            </p>
          )}
          {view === "month" && (
            <MonthGrid
              days={days}
              month={anchor}
              today={today}
              byDay={byDay}
              isHeld={isHeld}
              colors={colors}
              dark={dark}
              activeKey={activeKey}
              onOpen={openAt}
              onPickDay={(d) => go(parseISODay(d)!, "day")}
            />
          )}
          {view === "agenda" && (
            <Agenda
              days={agendaDays}
              today={today}
              now={now}
              colors={colors}
              activeKey={activeKey}
              heldTo={heldTo}
              onOpen={openAt}
            />
          )}

          <div className="text-muted-foreground mt-3 hidden items-center gap-1.5 text-[12px] md:flex">
            <Keyboard className="size-3.5" strokeWidth={1.75} />
            <Kbd>T</Kbd> today <Kbd>←</Kbd>
            <Kbd>→</Kbd> move <Kbd>D</Kbd>
            <Kbd>W</Kbd>
            <Kbd>M</Kbd>
            <Kbd>A</Kbd> switch view{data.canWrite && <> <Kbd>C</Kbd> new event</>} <Kbd>Esc</Kbd> close
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-3">
          <MiniMonth
            anchor={anchor}
            today={today}
            view={view}
            hasEvents={(d) => (byDay.get(d)?.length ?? 0) > 0}
            isHeld={isHeld}
            onPick={(d) => go(d, view === "month" || view === "agenda" ? "day" : view)}
          />
          <div className="hidden lg:block">{upNext}</div>
          <DaySummary
            date={summaryDay}
            events={summaryEvents}
            busy={busyMinutes(summaryEvents)}
            held={isHeld(summaryDay)}
            today={today}
            now={now}
            colors={colors}
          />
          <CalendarLegend
            calendars={read}
            colors={colors}
            hidden={hidden}
            counts={counts}
            onToggle={toggle}
            onShowAll={showAll}
          />
          <details className="text-muted-foreground px-1 text-[12px] leading-relaxed">
            <summary className="hover:text-foreground cursor-pointer select-none">
              Synced {agoLabel(data.accounts[0]?.lastReadAt, now)} · about this calendar
            </summary>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              <li>
                {data.canWrite ? "Synced with" : "Read-only, from"}{" "}
                {data.accounts.map((a) => a.label).join(", ") || "Google"}. Only calendars ticked in Google
                are read; hiding one here only changes this browser's view.
              </li>
              {!data.canWrite && (
                <li>
                  To add and edit events here (and let the agent do it), reconnect the calendar with a
                  token minted with the full <code>calendar</code> scope — <code>npm run calendar-token</code>.
                </li>
              )}
              <li>
                Covers {dayHeading(heldFrom)} to {dayHeading(heldTo)}. Hatched days are outside that
                window — unknown, not free.
              </li>
              <li>Busy time merges overlaps. All-day entries and declined invitations count as free.</li>
              <li>Guests are shown as a count; names and descriptions are never collected.</li>
            </ul>
          </details>
        </aside>
      </div>

      {opened && (
        <EventPopover
          opened={opened}
          color={colors.get(opened.event.calendarId) ?? null}
          freeBusyOnly={freeBusy.has(opened.event.calendarId)}
          today={today}
          now={now}
          onClose={close}
          onEdit={
            canWriteTo(opened.event)
              ? () => {
                  setForm({ mode: "edit", event: opened.event });
                  setOpened(null);
                }
              : undefined
          }
          onDelete={
            canWriteTo(opened.event)
              ? async () => {
                  await calendarEvents.remove(opened.event.eventId, {
                    calendarId: opened.event.calendarId,
                    account: opened.event.accountId,
                  });
                  setOpened(null);
                  reload();
                }
              : undefined
          }
        />
      )}
      {form && (
        <EventForm
          key={form.mode === "edit" ? eventKey(form.event) : form.at.toISOString()}
          target={form}
          calendars={writable}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            reload();
          }}
        />
      )}
    </PageShell>
  );
}

/** Where "New event" starts: the next whole hour when the day in view is
 *  today, nine in the morning on any other day. */
function newEventAt(anchor: Date, today: Date, now: Date): Date {
  const at = new Date(sameDay(anchor, today) ? now : anchor);
  at.setHours(sameDay(anchor, today) ? now.getHours() + 1 : 9, 0, 0, 0);
  return at;
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="bg-muted text-foreground/80 rounded border px-1 font-sans text-[10.5px]">{children}</kbd>
  );
}
