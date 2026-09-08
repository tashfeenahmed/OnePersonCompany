import type { CalendarEvent } from "@/lib/api/reports";
import { cn } from "@/lib/utils";
import {
  clockLabel,
  dot,
  eventEnd,
  eventKey,
  eventStart,
  hoursLabel,
  isoDay,
  lanes,
  minutesInto,
  sameDay,
  tint,
  titleOf,
  WEEKDAYS,
} from "./dates";

/**
 * The week, as a clock with seven columns.
 *
 * WHY A TIME AXIS AND NOT A STACK OF CHIPS. Workdash draws a month, and a
 * month cell has room for a date and three truncated titles — so its chips are
 * a list and the question they answer is "is anything on". A week has seven
 * columns and a whole page of height, and the question changes: when am I
 * free, what runs into what, is Thursday afternoon actually clear. None of
 * those can be read off a list, and all of them are obvious the moment the
 * vertical axis is a clock.
 *
 * THE AXIS DOES NOT SHOW MIDNIGHT TO MIDNIGHT. Twenty-four rows to draw a
 * working day in eight of them makes every block a sliver. The range is the
 * hours the week ACTUALLY uses, widened to whole hours and to at least 08:00 –
 * 20:00 so a quiet week is not drawn at a different scale from a busy one, and
 * the header says the range out loud rather than letting a reader assume the
 * top of the grid is the top of the day.
 *
 * OVERLAPS SIT SIDE BY SIDE, NEVER ON TOP OF EACH OTHER. A block that hides
 * another block hides exactly the clash the page was opened to find. `lanes`
 * in dates.ts does that arithmetic.
 *
 * ALL-DAY ENTRIES GET THEIR OWN ROW ABOVE THE CLOCK, and this is the same
 * refusal the server makes: "Conference" across three days is not twenty-four
 * hours and not eight, so it is never given a height on an axis measured in
 * hours. Holidays land here too, because that is what a holiday feed sends.
 */

/**
 * How tall an hour is — and it has to give, because the range does not.
 *
 * A 02:30 flight and a 23:51 train are one week apart on the same calendar and
 * both have to be drawn, which makes the axis twenty-two hours long whether or
 * not anything happens in the middle of it. At a fixed 46px that is a
 * thousand-pixel grid with a sixteen-hour hole in it, and the reader scrolls
 * past the week to reach the day below it. So the hour SHRINKS as the range
 * grows, to a floor below which a one-hour block stops holding a line of text
 * — the dead hours compress and the week stays one object.
 */
const TARGET_PX = 620;
const HOUR_MAX = 46;
const HOUR_MIN = 27;
const hourHeight = (hours: number): number =>
  Math.min(HOUR_MAX, Math.max(HOUR_MIN, Math.round(TARGET_PX / Math.max(1, hours))));

/** The narrowest a seven-column clock stays legible. Below this the card
 *  scrolls sideways inside itself rather than squeezing the page. */
const MIN_GRID_PX = 680;

/** The range the grid always covers, whatever the week holds. */
const FLOOR_START = 8 * 60;
const FLOOR_END = 20 * 60;

/** The shortest block that still reads as a block. A 10-minute call drawn to
 *  scale is a hairline nobody can click. */
const MIN_BLOCK_MIN = 26;

export type DayColumn = {
  day: string;
  date: Date;
  timed: CalendarEvent[];
  allDay: CalendarEvent[];
  busyMinutes: number;
};

/** The vertical range of the grid, in minutes past midnight. */
function gridRange(columns: DayColumn[]): { from: number; to: number } {
  let from = FLOOR_START;
  let to = FLOOR_END;
  for (const col of columns)
    for (const e of col.timed) {
      const s = eventStart(e);
      const end = eventEnd(e);
      if (s) from = Math.min(from, Math.floor(minutesInto(s) / 60) * 60);
      if (end) {
        /* An event that runs past midnight is clamped to the end of its own
           day rather than extending the axis to 47:00 — it belongs to the day
           it STARTED on, which is the rule dates.ts keeps. */
        const endMin = sameDay(end, s ?? end) ? minutesInto(end) : 24 * 60;
        to = Math.max(to, Math.ceil(endMin / 60) * 60);
      }
    }
  return { from: Math.max(0, from), to: Math.min(24 * 60, Math.max(to, from + 60)) };
}

function Block({
  event,
  from,
  to,
  px,
  lane,
  of,
  dark,
  color,
  onOpen,
}: {
  event: CalendarEvent;
  from: number;
  to: number;
  /** Pixels per hour, so a block can tell whether it has room for two lines. */
  px: number;
  lane: number;
  of: number;
  dark: boolean;
  color: string | null;
  onOpen: () => void;
}) {
  const start = eventStart(event);
  if (!start) return null;
  const end = eventEnd(event);
  const startMin = minutesInto(start);
  const endMin = end && sameDay(end, start) ? minutesInto(end) : 24 * 60;
  const span = to - from;
  const top = ((startMin - from) / span) * 100;
  const height = (Math.max(endMin - startMin, MIN_BLOCK_MIN) / span) * 100;
  const cancelled = event.status === "cancelled";
  const declined = event.response === "declined";
  /* TWO LINES OR ONE, decided by the block's own height rather than by a
     breakpoint: a half-hour call on a compressed axis has room for a clock or
     a title and not for both stacked, and a second line clipped mid-glyph
     reads as a rendering fault. */
  const tall = (Math.max(endMin - startMin, MIN_BLOCK_MIN) / 60) * px >= 32;

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${clockLabel(start)}${end ? `–${clockLabel(end)}` : ""} · ${titleOf(event)} · ${event.calendar}`}
      style={{
        top: `${top}%`,
        height: `${height}%`,
        left: `${(lane / of) * 100}%`,
        width: `${100 / of}%`,
        backgroundColor: tint(color, dark),
        borderLeftColor: dot(color),
      }}
      className={cn(
        "absolute overflow-hidden rounded-[5px] border-l-2 px-1 py-0.5 text-left",
        "hover:ring-ring focus-visible:ring-ring hover:ring-1 focus-visible:ring-1 focus-visible:outline-none",
        /* The fallback when Google sent no colour, and the reason the border
           is on EVERY block rather than only the coloured ones: a tinted and
           an untinted block in the same column would otherwise hang their text
           off two different left edges, which reads as a rendering fault. */
        color ? "border-l-transparent" : "bg-muted border-l-current/25",
        (cancelled || declined) && "opacity-55",
      )}
    >
      {tall ? (
        <>
          <span
            className={cn(
              "block truncate text-[11px] leading-tight font-medium",
              cancelled && "line-through",
            )}
          >
            {titleOf(event)}
          </span>
          <span className="text-muted-foreground block truncate font-mono text-[10px] leading-tight tabular-nums">
            {clockLabel(start)}
            {declined ? " · declined" : cancelled ? " · called off" : ""}
          </span>
        </>
      ) : (
        <span
          className={cn(
            "flex items-baseline gap-1 truncate text-[10.5px] leading-tight",
            cancelled && "line-through",
          )}
        >
          <span className="text-muted-foreground shrink-0 font-mono text-[9.5px] tabular-nums">
            {clockLabel(start)}
          </span>
          <span className="truncate font-medium">{titleOf(event)}</span>
        </span>
      )}
    </button>
  );
}

export function WeekGrid({
  columns,
  today,
  selected,
  now,
  colors,
  dark,
  onSelectDay,
}: {
  columns: DayColumn[];
  today: Date;
  /** The day the agenda below is showing, drawn as the grid's own selection. */
  selected: string;
  now: Date;
  /** Calendar id → Google's own colour, or null. */
  colors: Map<string, string | null>;
  dark: boolean;
  onSelectDay: (day: string) => void;
}) {
  const { from, to } = gridRange(columns);
  const hours: number[] = [];
  for (let m = from; m <= to; m += 60) hours.push(m);
  const px = hourHeight((to - from) / 60);
  const height = ((to - from) / 60) * px;
  const allDayRows = Math.max(...columns.map((c) => c.allDay.length), 0);
  const nowMin = minutesInto(now);
  const nowVisible = nowMin >= from && nowMin <= to;

  return (
    <div className="bg-card rounded-[14px] p-3">
      {/* THE CARD SCROLLS, NOT THE PAGE. Seven columns and a gutter have a
          floor below which they stop being legible; at that width the grid
          takes a scrollbar of its own rather than pushing the whole document
          sideways, which would move the sidebar off screen. */}
      <div className="overflow-x-auto">
        <div style={{ minWidth: MIN_GRID_PX }}>
          <div className="grid grid-cols-[46px_repeat(7,minmax(0,1fr))]">
            <div />
            {columns.map((col) => {
              const isToday = sameDay(col.date, today);
              const isSelected = col.day === selected;
              return (
                <button
                  key={col.day}
                  type="button"
                  onClick={() => onSelectDay(col.day)}
                  aria-current={isToday ? "date" : undefined}
                  className={cn(
                    "hover:bg-accent/60 mb-1 rounded-lg px-1 py-1 text-left",
                    isSelected && "bg-accent",
                  )}
                >
                  <span className="text-muted-foreground block text-[10.5px] tracking-[0.08em] uppercase">
                    {WEEKDAYS[(col.date.getDay() + 6) % 7]}
                  </span>
                  <span className="flex items-baseline gap-1.5">
                    <span
                      className={cn(
                        "text-[15px] tabular-nums",
                        /* Today is a ring rather than a filled disc: a solid
                           mark would be the loudest thing on a page whose
                           subject is the blocks, and it reads as a selection
                           rather than as a date. */
                        isToday &&
                          "ring-primary/50 text-foreground grid size-6 place-items-center rounded-full font-medium ring-1",
                      )}
                    >
                      {col.date.getDate()}
                    </span>
                    {col.busyMinutes > 0 && (
                      <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
                        {hoursLabel(col.busyMinutes)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>

          {/* ALL DAY, above the clock and never on it — see the header. The
              row exists even when nothing is in it, so the grid does not jump
              up and down as you page through the weeks. */}
          <div className="border-line-soft grid grid-cols-[46px_repeat(7,minmax(0,1fr))] border-y py-1">
            <div className="text-muted-foreground pr-1.5 text-right text-[10px] leading-5">
              All day
            </div>
            {columns.map((col) => (
              <div
                key={col.day}
                className="border-line-soft flex min-w-0 flex-col gap-0.5 border-l px-0.5"
                style={{ minHeight: allDayRows ? undefined : 20 }}
              >
                {col.allDay.map((e) => {
                  const color = colors.get(e.calendarId) ?? null;
                  return (
                    <button
                      key={eventKey(e)}
                      type="button"
                      onClick={() => onSelectDay(col.day)}
                      title={`${titleOf(e)} · ${e.calendar}`}
                      style={{
                        backgroundColor: tint(color, dark),
                        borderLeftColor: dot(color),
                      }}
                      className={cn(
                        "truncate rounded-[4px] border-l-2 px-1 py-px text-left text-[10.5px] leading-tight",
                        color ? "border-l-transparent" : "bg-muted border-l-current/25",
                        e.status === "cancelled" && "line-through opacity-55",
                      )}
                    >
                      {titleOf(e)}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div
            className="grid grid-cols-[46px_repeat(7,minmax(0,1fr))]"
            style={{ height }}
          >
            <div className="relative">
              {hours.map((m) => (
                <span
                  key={m}
                  style={{ top: `${((m - from) / (to - from)) * 100}%` }}
                  className={cn(
                    "text-muted-foreground absolute right-1.5 font-mono text-[10px] tabular-nums",
                    /* The last label sits ON the bottom edge and would be
                       sliced in half by the card. It hangs above its own line
                       instead — the only one that has to. */
                    m === to ? "-translate-y-full" : "-translate-y-1/2",
                  )}
                >
                  {String(Math.floor(m / 60)).padStart(2, "0")}:00
                </span>
              ))}
            </div>
            {columns.map((col) => {
              const placed = col.timed
                .map((e) => ({ e, start: eventStart(e), end: eventEnd(e) }))
                .filter((x) => x.start !== null);
              const seats = lanes(
                placed.map((x) => {
                  const s = minutesInto(x.start!);
                  const end =
                    x.end && sameDay(x.end, x.start!) ? minutesInto(x.end) : 24 * 60;
                  return { start: s, end: Math.max(end, s + MIN_BLOCK_MIN) };
                }),
              );
              const isToday = sameDay(col.date, today);
              return (
                <div
                  key={col.day}
                  className={cn(
                    "border-line-soft relative border-l",
                    col.day === selected && "bg-accent/35",
                  )}
                >
                  {hours.slice(1).map((m) => (
                    <div
                      key={m}
                      style={{ top: `${((m - from) / (to - from)) * 100}%` }}
                      className="border-line-soft absolute right-0 left-0 border-t"
                    />
                  ))}
                  {placed.map((x, i) => (
                    <Block
                      key={eventKey(x.e)}
                      event={x.e}
                      from={from}
                      to={to}
                      px={px}
                      lane={seats[i]!.lane}
                      of={seats[i]!.of}
                      dark={dark}
                      color={colors.get(x.e.calendarId) ?? null}
                      onOpen={() => onSelectDay(col.day)}
                    />
                  ))}
                  {/* WHERE THE DAY HAS GOT TO, on today's column alone. It is
                      the one mark on this grid that is about this minute
                      rather than about the week, which is why it is a hairline
                      in the brand and not another block. */}
                  {isToday && nowVisible && (
                    <div
                      style={{ top: `${((nowMin - from) / (to - from)) * 100}%` }}
                      className="bg-primary pointer-events-none absolute right-0 left-0 z-10 h-px"
                    >
                      <span className="bg-primary absolute -top-[2.5px] -left-[2.5px] size-[6px] rounded-full" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <p className="text-muted-foreground mt-2 text-[12px]">
        {String(Math.floor(from / 60)).padStart(2, "0")}:00 to{" "}
        {String(Math.floor(to / 60)).padStart(2, "0")}:00 — the hours this week
        uses, never midnight to midnight. All-day entries sit above the clock
        and are given no hours.
      </p>
      <span className="sr-only">
        {columns
          .map((c) => `${isoDay(c.date)}: ${c.timed.length + c.allDay.length} entries`)
          .join(". ")}
      </span>
    </div>
  );
}
