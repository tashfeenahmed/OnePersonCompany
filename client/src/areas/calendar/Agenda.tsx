import type { CalendarEvent } from "@/lib/api/reports";
import { cn } from "@/lib/utils";
import { dayHeading, dot, eventKey, hoursLabel, rangeLabel, titleOf } from "./dates";

/**
 * The list a grid cannot be.
 *
 * A block in the week is a clock and a truncated title, because that is what
 * fits. Everything else an occurrence carries — the room, which calendar it
 * came off, how many people are on it, and the one link that leads somewhere a
 * read-only page cannot go — lives here.
 *
 * ATTENDEES ARE A COUNT AND THERE IS NO WAY TO MAKE THEM ANYTHING ELSE. This
 * page would happily draw initials; there are none to draw. The collector's
 * field mask asks Google for `attendees(self,responseStatus)` and nothing more,
 * so no name and no address has ever reached this box — see migration 032. A
 * count is not a compromise here, it is the whole of what exists.
 *
 * A LINK IS OPENED, NEVER FOLLOWED FOR YOU. Both addresses come off Google's
 * own fields and were checked for an https scheme before they were stored; the
 * page still opens them in a new tab with `noreferrer`, because this app's
 * address should not travel to a meeting room.
 */

/** A location that is really a URL — a Zoom room pasted into the field, which
 *  is how half the world books a video call. Anything else is text. */
function locationLink(location: string | null): string | null {
  if (!location) return null;
  const first = location.trim().split(/\s+/)[0] ?? "";
  if (!/^https:\/\//i.test(first)) return null;
  try {
    return new URL(first).protocol === "https:" ? first : null;
  } catch {
    return null;
  }
}

/* A LINK AND NOT A BUTTON. Every row carries one, and a page of bordered
   buttons reads as a page of things you are being asked to press — the rows
   are the content, and the way out of one is an aside. */
function OpenLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground/80 hover:text-foreground underline decoration-dotted underline-offset-2"
    >
      {children}
    </a>
  );
}

export function EventRow({
  event,
  color,
  showDay,
}: {
  event: CalendarEvent;
  color: string | null;
  /** The weekday, for the lists that run across several days. */
  showDay?: string;
}) {
  const cancelled = event.status === "cancelled";
  const declined = event.response === "declined";
  const room = locationLink(event.location);

  return (
    <li className="border-line-soft flex gap-2.5 border-b py-2.5 last:border-b-0 last:pb-0">
      <span
        aria-hidden="true"
        style={dot(color) ? { backgroundColor: dot(color)! } : undefined}
        className={cn("mt-1.5 w-[3px] shrink-0 rounded-full", !dot(color) && "bg-muted-foreground/40")}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-muted-foreground font-mono text-[11.5px] tabular-nums">
            {showDay ? `${showDay} · ` : ""}
            {rangeLabel(event)}
          </span>
          <span
            className={cn(
              "min-w-0 text-[13.5px] font-medium",
              cancelled && "line-through opacity-60",
              declined && "opacity-60",
            )}
          >
            {titleOf(event)}
          </span>
          {event.minutes !== null && !event.allDay && (
            <span className="text-muted-foreground text-[11.5px] tabular-nums">
              {hoursLabel(event.minutes)}
            </span>
          )}
        </span>
        <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px]">
          <span className="truncate">{event.calendar}</span>
          {event.location && !room && <span className="truncate">{event.location}</span>}
          {event.attendees !== null && event.attendees > 0 && (
            <span title="A count. No attendee's name or address is stored on this box.">
              {event.attendees} attendee{event.attendees === 1 ? "" : "s"}
            </span>
          )}
          {declined && <span>you declined</span>}
          {cancelled && <span>called off</span>}
          {event.status === "tentative" && <span>tentative</span>}
          {event.response === "needsAction" && <span>unanswered</span>}
          {event.allDay && <span>no hours</span>}
          {event.summary === null && (
            <span title="This calendar is shared with the owner as free/busy only, so Google sends no title for its events. The slot is real; the words are not withheld here, they were never sent.">
              free/busy only — no title sent
            </span>
          )}
          {event.meetLink && <OpenLink href={event.meetLink}>join Meet</OpenLink>}
          {room && <OpenLink href={room}>open room</OpenLink>}
          {event.link && <OpenLink href={event.link}>open</OpenLink>}
        </span>
      </span>
    </li>
  );
}

/** One day, in full — the view a `/calendar/<day>` link means. */
export function DayInFull({
  date,
  events,
  busyMinutes,
  colors,
}: {
  date: Date;
  events: CalendarEvent[];
  busyMinutes: number;
  colors: Map<string, string | null>;
}) {
  return (
    <div className="bg-card rounded-[14px] px-4.5 py-3.5">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] font-medium">{dayHeading(date)}</span>
        <span className="text-muted-foreground text-[12.5px] tabular-nums">
          {events.length === 0
            ? "nothing on this day"
            : `${events.length} entr${events.length === 1 ? "y" : "ies"} · ${hoursLabel(busyMinutes)} busy`}
        </span>
      </div>
      {events.length === 0 ? (
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          A clear day, as far as the calendars this box reads are concerned — and
          only those: a calendar you have hidden below, or one never ticked in
          Google, is not read at all.
        </p>
      ) : (
        <ul className="flex flex-col">
          {events.map((e) => (
            <EventRow key={eventKey(e)} event={e} color={colors.get(e.calendarId) ?? null} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** What is coming, day by day, for as far as this box has read. */
export function Coming({
  days,
  colors,
  weekdayOf,
  limit,
}: {
  days: { day: string; date: Date; events: CalendarEvent[] }[];
  colors: Map<string, string | null>;
  weekdayOf: (d: Date) => string;
  /** How many days with something on them to draw before the list is cut. */
  limit: number;
}) {
  /*
    ONE ROW PER OCCURRENCE, ON THE FIRST DAY IT APPEARS.

    The grid deliberately draws a five-night stay on all five of its columns —
    that is what makes it visible in the week you are looking at. A LIST does
    not have that problem and gets the opposite one: five identical "Stay at
    Brewers Inn" rows read as five bookings. So the list keeps the first
    sighting and drops the repeats, and the row's own range says how long it
    runs.
  */
  const seen = new Set<string>();
  const withSomething: typeof days = [];
  for (const d of days) {
    const fresh = d.events.filter((e) => !seen.has(eventKey(e)));
    for (const e of fresh) seen.add(eventKey(e));
    if (fresh.length) withSomething.push({ ...d, events: fresh });
  }
  const shown = withSomething.slice(0, limit);
  const hidden = withSomething.length - shown.length;

  if (!withSomething.length)
    return (
      <div className="bg-card rounded-[14px] px-4.5 py-3.5">
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          Nothing ahead in the days this box holds. That is a measurement of the
          calendars it reads, not a promise about the ones it does not.
        </p>
      </div>
    );

  return (
    <div className="bg-card rounded-[14px] px-4.5 py-3.5">
      <ul className="flex flex-col">
        {shown.flatMap((d) =>
          d.events.map((e, i) => (
            <EventRow
              key={eventKey(e)}
              event={e}
              color={colors.get(e.calendarId) ?? null}
              showDay={i === 0 ? `${weekdayOf(d.date)} ${d.date.getDate()}` : undefined}
            />
          )),
        )}
      </ul>
      {hidden > 0 && (
        <p className="text-muted-foreground mt-2 text-[12px]">
          {hidden} further day{hidden === 1 ? "" : "s"} with something on{" "}
          {hidden === 1 ? "it is" : "them are"} held and not drawn here — page
          the grid forward to reach {hidden === 1 ? "it" : "them"}.
        </p>
      )}
    </div>
  );
}
