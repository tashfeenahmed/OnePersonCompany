import type { MouseEvent } from "react";
import type { CalendarEvent } from "@/lib/api/reports";
import { cn } from "@/lib/utils";
import { clockLabel, dot, eventKey, isoDay, sameDay, tint, titleOf, WEEKDAYS } from "./dates";

/**
 * Month view: is anything on, and roughly when. Up to three entries per day
 * (all-day ones as filled bars, timed ones as a dot and a clock), then
 * "+2 more", which opens the day. Phones get dots instead of titles — a
 * seventh of a phone is not wide enough for a word.
 */

const SHOWN = 3;

export function MonthGrid({
  days,
  month,
  today,
  byDay,
  isHeld,
  colors,
  dark,
  activeKey,
  onOpen,
  onPickDay,
}: {
  /** The 42 days of the grid. */
  days: Date[];
  /** Any day in the month being shown. */
  month: Date;
  today: Date;
  byDay: Map<string, CalendarEvent[]>;
  isHeld: (day: Date) => boolean;
  colors: Map<string, string | null>;
  dark: boolean;
  activeKey: string | null;
  onOpen: (event: CalendarEvent, e: MouseEvent<HTMLElement>) => void;
  onPickDay: (day: string) => void;
}) {
  return (
    <div className="bg-card overflow-hidden rounded-[14px]">
      <div className="border-line-soft grid grid-cols-7 border-b">
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="text-muted-foreground px-2 py-2 text-[11px] tracking-[0.06em] uppercase"
          >
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((date, i) => {
          const day = isoDay(date);
          const events = byDay.get(day) ?? [];
          const inMonth = date.getMonth() === month.getMonth();
          const isToday = sameDay(date, today);
          const held = isHeld(date);
          const more = events.length - SHOWN;
          return (
            <div
              key={day}
              className={cn(
                "border-line-soft flex min-h-[64px] min-w-0 flex-col gap-0.5 p-1 sm:min-h-[112px]",
                i % 7 !== 0 && "border-l",
                i >= 7 && "border-t",
                !inMonth && "bg-muted/35",
              )}
            >
              <button
                type="button"
                onClick={() => onPickDay(day)}
                aria-label={`Open ${day}`}
                className={cn(
                  "hover:bg-accent grid size-7 place-items-center self-start rounded-full text-[12.5px] tabular-nums",
                  !inMonth && "text-muted-foreground",
                  isToday && "bg-primary text-primary-foreground hover:bg-primary/85 font-medium",
                )}
              >
                {date.getDate()}
              </button>

              {!held && (
                <span className="text-muted-foreground/70 hidden px-1 text-[10.5px] sm:block">not read</span>
              )}

              {/* Phones: one dot per entry, up to four. */}
              <span className="flex flex-wrap gap-0.5 px-1 sm:hidden">
                {events.slice(0, 4).map((e) => (
                  <span
                    key={eventKey(e)}
                    className={cn("size-1.5 rounded-full", !dot(colors.get(e.calendarId) ?? null) && "bg-muted-foreground/50")}
                    style={{ backgroundColor: dot(colors.get(e.calendarId) ?? null) }}
                  />
                ))}
              </span>

              <div className="hidden min-w-0 flex-col gap-0.5 sm:flex">
                {events.slice(0, SHOWN).map((e) => {
                  const color = colors.get(e.calendarId) ?? null;
                  const active = activeKey === eventKey(e);
                  const start = e.allDay ? null : e.start ? new Date(e.start) : null;
                  return (
                    <button
                      key={eventKey(e)}
                      type="button"
                      onClick={(ev) => onOpen(e, ev)}
                      style={e.allDay ? { backgroundColor: tint(color, dark) } : undefined}
                      className={cn(
                        "hover:bg-accent flex min-w-0 items-center gap-1 rounded-[4px] px-1 py-px text-left text-[11.5px] leading-tight",
                        e.allDay && !color && "bg-muted",
                        active && "ring-ring ring-2",
                        (e.status === "cancelled" || e.response === "declined") && "opacity-50",
                        e.status === "cancelled" && "line-through",
                      )}
                    >
                      {!e.allDay && (
                        <span
                          className={cn("size-1.5 shrink-0 rounded-full", !dot(color) && "bg-muted-foreground/50")}
                          style={{ backgroundColor: dot(color) }}
                        />
                      )}
                      {start && (
                        <span className="text-muted-foreground shrink-0 tabular-nums">{clockLabel(start)}</span>
                      )}
                      <span className="truncate font-medium">{titleOf(e)}</span>
                    </button>
                  );
                })}
                {more > 0 && (
                  <button
                    type="button"
                    onClick={() => onPickDay(day)}
                    className="text-muted-foreground hover:text-foreground px-1 text-left text-[11px]"
                  >
                    +{more} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
