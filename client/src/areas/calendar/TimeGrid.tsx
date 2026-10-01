import { useLayoutEffect, useRef, type MouseEvent } from "react";
import type { CalendarEvent } from "@/lib/api/reports";
import { cn } from "@/lib/utils";
import {
  clockLabel,
  daysBetween,
  dot,
  durationLabel,
  eventDays,
  eventEnd,
  eventKey,
  eventStart,
  lanes,
  minutesInto,
  minutesLabel,
  sameDay,
  tint,
  titleOf,
  WEEKDAYS,
} from "./dates";

/**
 * Day and Week views: a clock down the side, one column per day.
 *
 * The whole 24 hours is drawn at a fixed scale inside its own scroller, the
 * way Google and Notion do it, and the scroller opens on the working morning
 * (or just before now, on a view with today in it) — so a 02:30 flight is
 * there when you scroll up, and a normal day is not squashed to make room
 * for it.
 *
 * Overlapping events sit side by side (`lanes` in dates.ts) — a block that
 * hides another hides exactly the clash you opened the page to find. All-day
 * entries get a strip above the clock and span the columns they cover. Days
 * outside what the collector holds are hatched: a day nobody read is not a
 * free day.
 */

export type DayColumn = {
  day: string;
  date: Date;
  timed: CalendarEvent[];
  allDay: CalendarEvent[];
  busyMinutes: number;
  /** Inside the window the collector reads. */
  held: boolean;
};

const HOUR_PX = 48;
const MIN_BLOCK_MIN = 20;
/** Below this a seven-column week scrolls sideways inside its card. */
const MIN_WEEK_PX = 640;

const hatch = {
  backgroundImage:
    "repeating-linear-gradient(135deg, transparent 0 7px, color-mix(in oklch, var(--muted-foreground) 14%, transparent) 7px 8px)",
};

type OnOpen = (event: CalendarEvent, e: MouseEvent<HTMLElement>) => void;

function Block({
  event,
  lane,
  of,
  color,
  dark,
  now,
  active,
  single,
  onOpen,
}: {
  event: CalendarEvent;
  lane: number;
  of: number;
  color: string | null;
  dark: boolean;
  now: Date;
  active: boolean;
  single: boolean;
  onOpen: OnOpen;
}) {
  const start = eventStart(event)!;
  const end = eventEnd(event);
  const startMin = minutesInto(start);
  const endMin = end && sameDay(end, start) ? minutesInto(end) : 24 * 60;
  const mins = Math.max(endMin - startMin, MIN_BLOCK_MIN);
  const heightPx = (mins / 60) * HOUR_PX;
  const cancelled = event.status === "cancelled";
  const declined = event.response === "declined";
  const past = end ? end.getTime() < now.getTime() : false;
  const roomy = heightPx >= 38;
  const time = `${clockLabel(start)}${end ? ` – ${clockLabel(end)}` : ""}`;

  return (
    <button
      type="button"
      onClick={(e) => onOpen(event, e)}
      aria-label={`${titleOf(event)}, ${time}, ${event.calendar}`}
      style={{
        top: (startMin / 60) * HOUR_PX,
        height: heightPx - 1,
        left: `calc(${(lane / of) * 100}% + 1px)`,
        width: `calc(${100 / of}% - 3px)`,
        backgroundColor: tint(color, dark),
        borderLeftColor: dot(color),
      }}
      className={cn(
        "absolute overflow-hidden rounded-[6px] border-l-[3px] px-1.5 py-0.5 text-left transition-shadow",
        "hover:ring-ring focus-visible:ring-ring hover:z-10 hover:ring-1 focus-visible:ring-2 focus-visible:outline-none",
        !color && "bg-muted border-l-muted-foreground/40",
        active && "ring-ring z-10 ring-2",
        (cancelled || declined) && "opacity-50",
        past && !active && "opacity-70",
      )}
    >
      {roomy ? (
        <>
          <span
            className={cn(
              "block truncate leading-tight font-medium",
              single ? "text-[13px]" : "text-[11.5px]",
              cancelled && "line-through",
            )}
          >
            {titleOf(event)}
          </span>
          <span className="text-muted-foreground block truncate text-[10.5px] leading-tight tabular-nums">
            {time}
            {single && event.location ? ` · ${event.location}` : ""}
          </span>
        </>
      ) : (
        <span className={cn("flex items-baseline gap-1 truncate text-[11px] leading-tight", cancelled && "line-through")}>
          <span className="truncate font-medium">{titleOf(event)}</span>
          <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">{clockLabel(start)}</span>
        </span>
      )}
    </button>
  );
}

/** All-day entries laid out as bars across the columns they cover, each in
 *  the first row where it fits. */
function allDayBars(columns: DayColumn[]) {
  const first = columns[0]?.date;
  if (!first) return { bars: [], rows: 0 };
  const seen = new Set<string>();
  const bars: { event: CalendarEvent; from: number; to: number; row: number }[] = [];
  const rowEnds: number[] = [];
  const all = columns.flatMap((c) => c.allDay);
  for (const e of all) {
    const key = eventKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    const days = eventDays(e);
    const startDay = eventStart(e);
    if (!startDay || !days.length) continue;
    const from = Math.max(0, daysBetween(first, startDay));
    const to = Math.min(columns.length - 1, daysBetween(first, startDay) + days.length - 1);
    if (to < from) continue;
    let row = rowEnds.findIndex((end) => end < from);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(to);
    } else rowEnds[row] = to;
    bars.push({ event: e, from, to, row });
  }
  return { bars, rows: rowEnds.length };
}

export function TimeGrid({
  columns,
  today,
  now,
  colors,
  dark,
  activeKey,
  onOpen,
  onPickDay,
  onCreateAt,
}: {
  columns: DayColumn[];
  today: Date;
  now: Date;
  colors: Map<string, string | null>;
  dark: boolean;
  /** The event whose card is open, drawn with a ring. */
  activeKey: string | null;
  onOpen: OnOpen;
  /** A click on an empty slot starts a new event there, half-hour snapped.
   *  Absent when no calendar can be written to. */
  onCreateAt?: (at: Date) => void;
  /** A click on a day's heading opens that day. */
  onPickDay: (day: string) => void;
}) {
  const single = columns.length === 1;
  const scroller = useRef<HTMLDivElement>(null);
  const todayIndex = columns.findIndex((c) => sameDay(c.date, today));
  const nowMin = minutesInto(now);
  const cols = `52px repeat(${columns.length}, minmax(0, 1fr))`;
  const { bars, rows } = allDayBars(columns);
  const viewKey = columns.map((c) => c.day).join();

  /* Open on the working morning, or an hour and a half before now when
     today is on screen. Only when the days change — never while reading. */
  const hasToday = todayIndex >= 0;
  useLayoutEffect(() => {
    if (!scroller.current) return;
    const n = new Date();
    const target = hasToday ? Math.max(0, n.getHours() * 60 + n.getMinutes() - 90) : 7.5 * 60;
    scroller.current.scrollTop = (target / 60) * HOUR_PX;
  }, [viewKey, hasToday]);

  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <div className="bg-card overflow-hidden rounded-[14px]">
      <div
        ref={scroller}
        className="overflow-auto"
        style={{ maxHeight: "max(440px, calc(100vh - 230px))" }}
      >
        <div style={{ minWidth: single ? undefined : MIN_WEEK_PX }}>
          {/* Day headings and the all-day strip stay put while the clock scrolls. */}
          <div className="bg-card border-line-soft sticky top-0 z-20 border-b">
            <div className="grid" style={{ gridTemplateColumns: cols }}>
              <div />
              {columns.map((col) => {
                const isToday = sameDay(col.date, today);
                return (
                  <button
                    key={col.day}
                    type="button"
                    onClick={() => onPickDay(col.day)}
                    title={single ? undefined : "Open this day"}
                    aria-current={isToday ? "date" : undefined}
                    className={cn(
                      "hover:bg-accent/60 flex items-center gap-2 px-2 pt-2 pb-1.5 text-left",
                      single && "cursor-default hover:bg-transparent",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded-full text-[16px] tabular-nums",
                        isToday && "bg-primary text-primary-foreground font-medium",
                      )}
                    >
                      {col.date.getDate()}
                    </span>
                    <span className="min-w-0 leading-tight">
                      <span
                        className={cn(
                          "block text-[11px] tracking-[0.06em] uppercase",
                          isToday ? "text-primary font-medium" : "text-muted-foreground",
                        )}
                      >
                        {WEEKDAYS[(col.date.getDay() + 6) % 7]}
                      </span>
                      <span className="text-muted-foreground block truncate text-[10.5px] tabular-nums">
                        {!col.held ? "not read" : col.busyMinutes > 0 ? `${durationLabel(col.busyMinutes)} busy` : "free"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <div
              className="grid py-1"
              style={{
                gridTemplateColumns: cols,
                gridTemplateRows: `repeat(${Math.max(rows, 1)}, 22px)`,
                rowGap: 2,
              }}
            >
              <div
                className="text-muted-foreground self-center pr-2 text-right text-[10px]"
                style={{ gridColumn: 1, gridRow: `1 / span ${Math.max(rows, 1)}` }}
              >
                all day
              </div>
              {bars.map(({ event, from, to, row }) => {
                const color = colors.get(event.calendarId) ?? null;
                return (
                  <button
                    key={eventKey(event)}
                    type="button"
                    onClick={(e) => onOpen(event, e)}
                    style={{
                      gridColumn: `${from + 2} / ${to + 3}`,
                      gridRow: row + 1,
                      backgroundColor: tint(color, dark),
                      borderLeftColor: dot(color),
                    }}
                    className={cn(
                      "mx-0.5 truncate rounded-[5px] border-l-[3px] px-1.5 text-left text-[11.5px] leading-[22px] font-medium",
                      "hover:ring-ring focus-visible:ring-ring hover:ring-1 focus-visible:ring-2 focus-visible:outline-none",
                      !color && "bg-muted border-l-muted-foreground/40",
                      activeKey === eventKey(event) && "ring-ring ring-2",
                      event.status === "cancelled" && "line-through opacity-50",
                    )}
                  >
                    {titleOf(event)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="relative grid" style={{ gridTemplateColumns: cols, height: 24 * HOUR_PX }}>
            <div className="relative">
              {hours.slice(1).map((h) => (
                <span
                  key={h}
                  style={{ top: h * HOUR_PX }}
                  className="text-muted-foreground absolute right-2 -translate-y-1/2 text-[10.5px] tabular-nums"
                >
                  {minutesLabel(h * 60)}
                </span>
              ))}
              {todayIndex >= 0 && (
                <span
                  style={{ top: (nowMin / 60) * HOUR_PX }}
                  className="absolute right-1 z-10 -translate-y-1/2 rounded bg-red-500 px-1 text-[10px] font-medium text-white tabular-nums"
                >
                  {clockLabel(now)}
                </span>
              )}
            </div>
            {columns.map((col, i) => {
              const placed = col.timed.filter((e) => eventStart(e) !== null);
              const seats = lanes(
                placed.map((e) => {
                  const s = eventStart(e)!;
                  const en = eventEnd(e);
                  const a = minutesInto(s);
                  const b = en && sameDay(en, s) ? minutesInto(en) : 24 * 60;
                  return { start: a, end: Math.max(b, a + MIN_BLOCK_MIN) };
                }),
              );
              return (
                <div
                  key={col.day}
                  className="border-line-soft relative border-l"
                  style={col.held ? undefined : hatch}
                  title={col.held ? undefined : "Outside the days the calendar collector reads"}
                  onClick={
                    onCreateAt && col.held
                      ? (e) => {
                          if (e.target !== e.currentTarget) return;
                          const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                          const mins = Math.min(23 * 60 + 30, Math.max(0, Math.floor((y / HOUR_PX) * 2) * 30));
                          const at = new Date(col.date);
                          at.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
                          onCreateAt(at);
                        }
                      : undefined
                  }
                >
                  {hours.slice(1).map((h) => (
                    <div
                      key={h}
                      style={{ top: h * HOUR_PX }}
                      className="border-line-soft absolute inset-x-0 border-t"
                    />
                  ))}
                  {placed.map((e, j) => (
                    <Block
                      key={eventKey(e)}
                      event={e}
                      lane={seats[j]!.lane}
                      of={seats[j]!.of}
                      color={colors.get(e.calendarId) ?? null}
                      dark={dark}
                      now={now}
                      active={activeKey === eventKey(e)}
                      single={single}
                      onOpen={onOpen}
                    />
                  ))}
                  {i === todayIndex && (
                    <div
                      style={{ top: (nowMin / 60) * HOUR_PX }}
                      className="pointer-events-none absolute inset-x-0 z-10 h-[2px] -translate-y-1/2 bg-red-500"
                    >
                      <span className="absolute -top-[4px] -left-[5px] size-[10px] rounded-full bg-red-500" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
