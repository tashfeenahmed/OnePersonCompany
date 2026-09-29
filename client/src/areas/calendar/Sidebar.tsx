import { useState, type MouseEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Video } from "lucide-react";

import type { CalendarEvent, CalendarReport } from "@/lib/api/reports";
import { cn } from "@/lib/utils";
import {
  addMonths,
  clockLabel,
  dot,
  durationLabel,
  eventEnd,
  eventKey,
  eventStart,
  freeWindows,
  isBusy,
  isoDay,
  joinLink,
  minutesInto,
  minutesLabel,
  monthGrid,
  monthHeading,
  relativeDay,
  sameDay,
  startOfMonth,
  startOfWeek,
  titleOf,
  untilText,
  type View,
} from "./dates";

type OnOpen = (event: CalendarEvent, e: MouseEvent<HTMLElement>) => void;

function Panel({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("bg-card rounded-[14px] px-3.5 py-3", className)}>
      {title && (
        <h2 className="text-muted-foreground mb-2 text-[11.5px] font-medium tracking-[0.06em] uppercase">{title}</h2>
      )}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------ mini month */

export function MiniMonth({
  anchor,
  today,
  view,
  hasEvents,
  isHeld,
  onPick,
}: {
  anchor: Date;
  today: Date;
  view: View;
  hasEvents: (day: string) => boolean;
  isHeld: (day: Date) => boolean;
  onPick: (day: Date) => void;
}) {
  const [shown, setShown] = useState(() => startOfMonth(anchor));
  /* Follow the main view when it moves to another month — adjusted during
     render, React's pattern for state derived from a prop. */
  const anchorMonth = startOfMonth(anchor).getTime();
  const [followed, setFollowed] = useState(anchorMonth);
  if (followed !== anchorMonth) {
    setFollowed(anchorMonth);
    setShown(new Date(anchorMonth));
  }

  const weekStart = startOfWeek(anchor).getTime();
  const inSelection = (d: Date) => {
    if (view === "week") {
      const t = startOfWeek(d).getTime();
      return t === weekStart;
    }
    if (view === "month") return false;
    return sameDay(d, anchor);
  };

  return (
    <Panel>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[13px] font-medium">{monthHeading(shown)}</span>
        <span className="flex">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setShown(addMonths(shown, -1))}
            className="hover:bg-accent grid size-6 place-items-center rounded-md"
          >
            <ChevronLeft className="size-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setShown(addMonths(shown, 1))}
            className="hover:bg-accent grid size-6 place-items-center rounded-md"
          >
            <ChevronRight className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      </div>
      <div className="text-muted-foreground grid grid-cols-7 text-center text-[10px]">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i} className="py-0.5">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {monthGrid(shown).map((d) => {
          const key = isoDay(d);
          const inMonth = d.getMonth() === shown.getMonth();
          const sel = inSelection(d);
          const isToday = sameDay(d, today);
          const held = isHeld(d);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onPick(d)}
              aria-label={relativeDay(d, today)}
              aria-pressed={sel}
              className={cn(
                "relative mx-auto grid size-7 place-items-center rounded-full text-[11.5px] tabular-nums",
                "hover:bg-accent",
                !inMonth && "text-muted-foreground/60",
                !held && "text-muted-foreground/50",
                sel && view !== "day" && "bg-accent",
                sel && view === "day" && "bg-primary text-primary-foreground hover:bg-primary/85",
                isToday && !(sel && view === "day") && "text-primary font-semibold",
              )}
            >
              {d.getDate()}
              {hasEvents(key) && !(sel && view === "day") && (
                <span className="bg-muted-foreground/60 absolute bottom-[3px] left-1/2 size-[3px] -translate-x-1/2 rounded-full" />
              )}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------- up next */

function MiniRow({
  event,
  color,
  label,
  strong,
  onOpen,
}: {
  event: CalendarEvent;
  color: string | null;
  label: string;
  strong?: boolean;
  onOpen: OnOpen;
}) {
  const swatch = dot(color);
  return (
    <button
      type="button"
      onClick={(e) => onOpen(event, e)}
      className="hover:bg-accent/70 -mx-1.5 flex w-[calc(100%+12px)] items-start gap-2 rounded-lg px-1.5 py-1 text-left"
    >
      <span
        aria-hidden="true"
        style={swatch ? { backgroundColor: swatch } : undefined}
        className={cn("mt-[5px] size-2 shrink-0 rounded-full", !swatch && "bg-muted-foreground/40")}
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", strong ? "text-[13.5px] font-medium" : "text-[13px]")}>
          {titleOf(event)}
        </span>
        <span className="text-muted-foreground block text-[11.5px] tabular-nums">{label}</span>
      </span>
    </button>
  );
}

function JoinButton({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="bg-primary text-primary-foreground hover:bg-primary/85 mt-1 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium"
    >
      <Video className="size-3.5" strokeWidth={1.75} />
      Join
    </a>
  );
}

/** What is on now, what is next, and the rest of today — measured against
 *  this minute, whatever the grid is showing. */
export function UpNext({
  events,
  today,
  now,
  colors,
  onOpen,
}: {
  /** Every visible occurrence, once each. */
  events: CalendarEvent[];
  today: Date;
  now: Date;
  colors: Map<string, string | null>;
  onOpen: OnOpen;
}) {
  const t = now.getTime();
  const live = events.filter((e) => e.status !== "cancelled" && e.response !== "declined" && !e.allDay);
  const ongoing = live.filter((e) => {
    const s = eventStart(e);
    const en = eventEnd(e);
    return s && en && s.getTime() <= t && en.getTime() > t;
  });
  const upcoming = live
    .filter((e) => (eventStart(e)?.getTime() ?? 0) > t)
    .sort((a, b) => eventStart(a)!.getTime() - eventStart(b)!.getTime());
  const next = upcoming[0];
  const laterToday = upcoming.slice(1).filter((e) => sameDay(eventStart(e)!, today)).slice(0, 4);

  return (
    <Panel title="Up next">
      {ongoing.map((e) => {
        const left = Math.max(1, Math.round((eventEnd(e)!.getTime() - t) / 60_000));
        const join = joinLink(e);
        return (
          <div key={eventKey(e)} className="mb-2">
            <div className="mb-0.5 text-[11.5px] font-medium text-red-600 dark:text-red-400">Happening now</div>
            <MiniRow
              event={e}
              color={colors.get(e.calendarId) ?? null}
              label={`ends in ${durationLabel(left)}`}
              strong
              onOpen={onOpen}
            />
            {join && <JoinButton href={join} />}
          </div>
        );
      })}
      {next ? (
        <div>
          <div className="text-[15px] leading-snug">
            <span className="text-muted-foreground">Next: </span>
            <button
              type="button"
              onClick={(e) => onOpen(next, e)}
              className="font-medium underline-offset-2 hover:underline"
            >
              {titleOf(next)}
            </button>{" "}
            <span className="whitespace-nowrap">{untilText(eventStart(next)!, now)}</span>
          </div>
          <div className="text-muted-foreground text-[12px] tabular-nums">
            {relativeDay(eventStart(next)!, today)}, {clockLabel(eventStart(next)!)}
            {eventEnd(next) ? ` – ${clockLabel(eventEnd(next)!)}` : ""} · {next.calendar}
          </div>
          {joinLink(next) && <JoinButton href={joinLink(next)!} />}
          {laterToday.length > 0 && (
            <div className="border-line-soft mt-2.5 border-t pt-2">
              <div className="text-muted-foreground mb-0.5 text-[11.5px]">Later today</div>
              {laterToday.map((e) => (
                <MiniRow
                  key={eventKey(e)}
                  event={e}
                  color={colors.get(e.calendarId) ?? null}
                  label={`${clockLabel(eventStart(e)!)} · ${untilText(eventStart(e)!, now)}`}
                  onOpen={onOpen}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        !ongoing.length && (
          <p className="text-muted-foreground text-[13px]">Nothing else coming up. Enjoy the quiet.</p>
        )
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------ busy / free */

/** How much of a day is spoken for, as words and a bar from 08:00 to 20:00. */
export function DaySummary({
  date,
  events,
  busy,
  held,
  today,
  now,
  colors,
}: {
  date: Date;
  events: CalendarEvent[];
  busy: number;
  held: boolean;
  today: Date;
  now: Date;
  colors: Map<string, string | null>;
}) {
  const isToday = sameDay(date, today);
  const isPast = date.getTime() < today.getTime();
  const count = events.length;
  const from = 8 * 60;
  const to = 20 * 60;
  const workFrom = isToday ? Math.max(9 * 60, Math.ceil(minutesInto(now) / 15) * 15) : 9 * 60;
  const free = held && !isPast ? freeWindows(events, date, workFrom, 18 * 60) : [];
  const segs = events.filter(isBusy).flatMap((e) => {
    const s = eventStart(e);
    const en = eventEnd(e);
    if (!s || !en || !sameDay(s, date)) return [];
    const a = Math.max(from, minutesInto(s));
    const b = Math.min(to, sameDay(en, s) ? minutesInto(en) : 24 * 60);
    return b > a ? [{ e, a, b }] : [];
  });

  return (
    <Panel title={relativeDay(date, today)}>
      {!held ? (
        <p className="text-muted-foreground text-[13px]">
          This day is outside what the calendar collector reads, so it isn't known whether it's free.
        </p>
      ) : (
        <>
          <div className="text-[14px]">
            {count === 0 ? (
              "Nothing scheduled"
            ) : (
              <>
                {count} event{count === 1 ? "" : "s"}
                <span className="text-muted-foreground"> · </span>
                {busy > 0 ? `${durationLabel(busy)} busy` : "no busy time"}
              </>
            )}
          </div>
          <div className="bg-muted relative mt-2 h-2.5 overflow-hidden rounded-full" aria-hidden="true">
            {segs.map(({ e, a, b }) => (
              <span
                key={eventKey(e)}
                className={cn("absolute inset-y-0", !dot(colors.get(e.calendarId) ?? null) && "bg-muted-foreground/50")}
                style={{
                  left: `${((a - from) / (to - from)) * 100}%`,
                  width: `${((b - a) / (to - from)) * 100}%`,
                  backgroundColor: dot(colors.get(e.calendarId) ?? null),
                }}
              />
            ))}
            {isToday && minutesInto(now) >= from && minutesInto(now) <= to && (
              <span
                className="absolute inset-y-0 w-[2px] bg-red-500"
                style={{ left: `${((minutesInto(now) - from) / (to - from)) * 100}%` }}
              />
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 flex justify-between text-[10px] tabular-nums">
            <span>08:00</span>
            <span>14:00</span>
            <span>20:00</span>
          </div>
          {!isPast && (
            <p className="text-muted-foreground mt-1.5 text-[12.5px] leading-relaxed">
              {free.length === 0
                ? isToday && workFrom >= 18 * 60
                  ? "The working day is over."
                  : "No free half-hour between 09:00 and 18:00."
                : `Free ${free
                    .slice(0, 3)
                    .map((w) => `${minutesLabel(w.start)}–${minutesLabel(w.end)}`)
                    .join(", ")}${free.length > 3 ? " and more" : ""}`}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

/* ----------------------------------------------------------------- legend */

export function CalendarLegend({
  calendars,
  colors,
  hidden,
  counts,
  onToggle,
  onShowAll,
}: {
  calendars: CalendarReport["calendars"];
  colors: Map<string, string | null>;
  hidden: Set<string>;
  counts: Map<string, number>;
  onToggle: (id: string) => void;
  onShowAll: () => void;
}) {
  const anyHidden = calendars.some((k) => hidden.has(k.calendarId));
  return (
    <Panel title="My calendars">
      <ul className="-mx-1.5 flex flex-col">
        {calendars.map((k) => {
          const off = hidden.has(k.calendarId);
          const swatch = dot(colors.get(k.calendarId) ?? null);
          return (
            <li key={k.calendarId}>
              <button
                type="button"
                role="switch"
                aria-checked={!off}
                onClick={() => onToggle(k.calendarId)}
                title={off ? "Show this calendar" : "Hide this calendar"}
                className="hover:bg-accent/70 flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px]"
              >
                <span
                  aria-hidden="true"
                  className="grid size-3.5 shrink-0 place-items-center rounded-[4px] border-2"
                  style={{
                    borderColor: swatch ?? "var(--muted-foreground)",
                    backgroundColor: off ? "transparent" : (swatch ?? "var(--muted-foreground)"),
                  }}
                />
                <span className={cn("min-w-0 flex-1 truncate", off && "text-muted-foreground")}>
                  {k.summary ?? k.calendarId}
                  {k.accessRole === "freeBusyReader" && (
                    <span className="text-muted-foreground text-[11px]"> · free/busy</span>
                  )}
                </span>
                <span className="text-muted-foreground text-[11px] tabular-nums">
                  {off ? "hidden" : (counts.get(k.calendarId) ?? 0)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {anyHidden && (
        <button
          type="button"
          onClick={onShowAll}
          className="text-muted-foreground hover:text-foreground mt-1 text-[12px] underline-offset-2 hover:underline"
        >
          Show all
        </button>
      )}
    </Panel>
  );
}
