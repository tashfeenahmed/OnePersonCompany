import type { MouseEvent } from "react";
import { CalendarCheck, Video } from "lucide-react";

import type { CalendarEvent } from "@/lib/api/reports";
import { cn } from "@/lib/utils";
import {
  clockLabel,
  dayHeading,
  dot,
  durationLabel,
  eventEnd,
  eventKey,
  eventStart,
  isOngoing,
  joinLink,
  relativeDay,
  sameDay,
  titleOf,
} from "./dates";

/**
 * Agenda view: a plain list, day by day, from the day in view to the end of
 * what the collector holds. It is the default on a phone, where a seven-column
 * clock does not fit. A multi-day entry is listed once, on its first day.
 */

export function AgendaRow({
  event,
  color,
  now,
  active,
  onOpen,
}: {
  event: CalendarEvent;
  color: string | null;
  now: Date;
  active: boolean;
  onOpen: (event: CalendarEvent, e: MouseEvent<HTMLElement>) => void;
}) {
  const start = eventStart(event);
  const end = eventEnd(event);
  const cancelled = event.status === "cancelled";
  const declined = event.response === "declined";
  const past = !event.allDay && end ? end.getTime() < now.getTime() : false;
  const live = isOngoing(event, now);
  const join = joinLink(event);
  const swatch = dot(color);

  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={(e) => onOpen(event, e)}
        className={cn(
          "hover:bg-accent/70 flex min-w-0 flex-1 items-start gap-3 rounded-lg px-2 py-2 text-left",
          active && "bg-accent",
          (past || cancelled || declined) && "opacity-60",
        )}
      >
        <span className="text-muted-foreground w-[92px] shrink-0 pt-px text-[12.5px] tabular-nums">
          {event.allDay || !start ? (
            "All day"
          ) : (
            <>
              {clockLabel(start)}
              {end && <span className="text-muted-foreground/70"> – {clockLabel(end)}</span>}
            </>
          )}
        </span>
        <span
          aria-hidden="true"
          style={swatch ? { backgroundColor: swatch } : undefined}
          className={cn("mt-[5px] size-2.5 shrink-0 rounded-full", !swatch && "bg-muted-foreground/40")}
        />
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-[14px] font-medium", cancelled && "line-through")}>
            {titleOf(event)}
          </span>
          <span className="text-muted-foreground block truncate text-[12px]">
            {live && <span className="font-medium text-red-600 dark:text-red-400">Now · </span>}
            {!event.allDay && event.minutes ? `${durationLabel(event.minutes)} · ` : ""}
            {event.location ? `${event.location} · ` : ""}
            {event.calendar}
            {cancelled ? " · cancelled" : declined ? " · you declined" : ""}
          </span>
        </span>
      </button>
      {join && !cancelled && !past && (
        <a
          href={join}
          target="_blank"
          rel="noreferrer"
          className="bg-primary text-primary-foreground hover:bg-primary/85 inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-medium"
        >
          <Video className="size-3.5" strokeWidth={1.75} />
          Join
        </a>
      )}
    </li>
  );
}

export function Agenda({
  days,
  today,
  now,
  colors,
  activeKey,
  heldTo,
  onOpen,
}: {
  days: { day: string; date: Date; events: CalendarEvent[] }[];
  today: Date;
  now: Date;
  colors: Map<string, string | null>;
  activeKey: string | null;
  heldTo: Date;
  onOpen: (event: CalendarEvent, e: MouseEvent<HTMLElement>) => void;
}) {
  const seen = new Set<string>();
  const withSomething: typeof days = [];
  for (const d of days) {
    const fresh = d.events.filter((e) => !seen.has(eventKey(e)));
    for (const e of fresh) seen.add(eventKey(e));
    if (fresh.length) withSomething.push({ ...d, events: fresh });
  }

  if (!withSomething.length)
    return (
      <div className="bg-card flex flex-col items-center gap-2 rounded-[14px] px-6 py-12 text-center">
        <CalendarCheck className="text-muted-foreground size-8" strokeWidth={1.5} />
        <div className="text-[15px] font-medium">Nothing scheduled</div>
        <p className="text-muted-foreground max-w-sm text-[13px]">
          Your calendars are clear through {dayHeading(heldTo)}.
        </p>
      </div>
    );

  return (
    <div className="bg-card rounded-[14px] px-2 py-2 sm:px-3">
      {withSomething.map((d) => {
        const isToday = sameDay(d.date, today);
        return (
          <section key={d.day} className="border-line-soft border-b py-2 last:border-b-0">
            <h3
              className={cn(
                "px-2 pb-1 text-[12.5px] font-medium",
                isToday ? "text-primary" : "text-muted-foreground",
              )}
            >
              {relativeDay(d.date, today)}
              {isToday || relativeDay(d.date, today) === "Tomorrow" ? (
                <span className="text-muted-foreground font-normal">
                  {" · "}
                  {d.date.getDate()} {d.date.toLocaleString("en-GB", { month: "long" })}
                </span>
              ) : null}
            </h3>
            <ul className="flex flex-col">
              {d.events.map((e) => (
                <AgendaRow
                  key={eventKey(e)}
                  event={e}
                  color={colors.get(e.calendarId) ?? null}
                  now={now}
                  active={activeKey === eventKey(e)}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
