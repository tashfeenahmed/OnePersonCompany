import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { integrations, type CalendarEvent } from "@/lib/api/integrations";
import { ago, clock, dayLabel } from "./format";
import { Note, PanelEmpty, PanelSection, Row, Rows, Tiles } from "./Panel";

/** One line of a day. Times are Google's own strings in the offset the event
 *  was created in — nothing here is normalised to UTC. */
function EventLine({ e }: { e: CalendarEvent }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-[13.5px]">
      <span className="text-muted-foreground w-[92px] shrink-0 font-mono text-[12.5px] tabular-nums">
        {clock(e.start)}–{clock(e.end)}
      </span>
      <span className="min-w-0 flex-1 truncate">{e.summary ?? "(no title)"}</span>
      {e.attendees !== null && e.attendees > 1 && (
        <span className="text-muted-foreground text-[12.5px]">
          {e.attendees} people
        </span>
      )}
      {e.response === "tentative" && (
        <Badge variant="secondary" className="font-normal">
          tentative
        </Badge>
      )}
      <span className="text-muted-foreground shrink-0 text-[12.5px]">
        {e.calendar}
      </span>
    </div>
  );
}

/**
 * TODAY, THE NEXT WEEK, AND WHAT AN HOUR OF IT ACTUALLY MEANS.
 *
 * BUSY HOURS MERGE, THEY DO NOT ADD. Two calls booked over the same hour are
 * one busy hour, because that is how many hours of the day they take. Adding
 * them would report a fourteen-hour Tuesday to somebody who had six. The
 * server does the merging; this panel just refuses to re-add anything.
 *
 * AN ALL-DAY EVENT CONTRIBUTES NO HOURS. "Conference" across three days is not
 * seventy-two hours and it is not eight either — there is no honest number, so
 * they are listed separately and counted separately, never folded into the
 * busy figure.
 *
 * AND THE PRIVACY LINE, which is the reason this integration is safe to have
 * at all: no event description is stored or even fetched, and no attendee is
 * ever named. `attendees` is a count and `response` is the owner's own answer.
 * Nothing behind this panel could name a guest if it were asked to.
 */
export function CalendarPanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.calendar(7), []);
  const [collecting, setCollecting] = useState(false);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("calendar");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  if (report.error || !report.data) return null;
  const d = report.data;

  if (!d.calendars.length)
    return (
      <PanelEmpty>
        Connected, and no calendar has been read. Only the calendars ticked in
        Google are collected — an account with everything unticked reads exactly
        like this.
      </PanelEmpty>
    );

  const selected = d.calendars.filter((c) => c.selected);
  const rest = d.days.slice(1);

  return (
    <PanelSection
      title="What it reads"
      meta={`read ${ago(d.accounts[0]?.lastReadAt ?? d.calendars[0]?.seenAt ?? null)}`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          { v: `${d.today.busyHours}h`, k: "busy today, overlaps merged" },
          { v: String(d.today.events.length), k: "events today" },
          { v: `${d.summary.busyHours}h`, k: `busy over ${d.summary.window.days} days` },
          {
            v: d.today.next ? clock(d.today.next.start) : "—",
            k: d.today.next ? "next, today" : "nothing left today",
          },
        ]}
      />

      <Rows>
        <Row first>
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="text-[14px] font-medium">Today</span>
            <span className="text-muted-foreground text-[12.5px]">
              {dayLabel(d.today.day)}
            </span>
            <span className="text-muted-foreground ml-auto text-[12.5px] tabular-nums">
              {d.today.busyHours}h busy
            </span>
          </div>
          {d.today.events.length || d.today.allDay.length ? (
            <div className="flex flex-col gap-1">
              {d.today.events.map((e) => (
                <EventLine key={e.eventId} e={e} />
              ))}
              {d.today.allDay.map((e) => (
                <div
                  key={e.eventId}
                  className="flex items-baseline gap-2 text-[13.5px]"
                >
                  <span className="text-muted-foreground w-[92px] shrink-0 font-mono text-[12.5px]">
                    all day
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {e.summary ?? "(no title)"}
                  </span>
                  <span className="text-muted-foreground shrink-0 text-[12.5px]">
                    no hours counted
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground text-[13px]">Nothing booked.</p>
          )}
        </Row>

        {rest.map((day) => (
          <Row key={day.day}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="w-[110px] shrink-0 text-[13.5px]">
                {dayLabel(day.day)}
              </span>
              <div className="bg-accent h-1.5 min-w-[40px] flex-1 overflow-hidden rounded-full">
                <div
                  className="bg-ok h-full rounded-full"
                  style={{ width: `${Math.min(100, (day.busyHours / 8) * 100)}%` }}
                />
              </div>
              <span className="w-[92px] shrink-0 text-right text-[13px] tabular-nums">
                {day.busyHours ? `${day.busyHours}h busy` : "clear"}
              </span>
              <span className="text-muted-foreground w-[64px] shrink-0 text-right text-[12.5px]">
                {day.events.length + day.allDay.length || "—"}
              </span>
            </div>
            {!!day.allDay.length && (
              <p className="text-muted-foreground mt-1 text-[12.5px]">
                {day.allDay.map((e) => e.summary ?? "(no title)").join(" · ")} —
                all day, no hours counted
              </p>
            )}
          </Row>
        ))}
      </Rows>

      <Note>
        The bar is against an eight-hour day, which is a drawing convention and
        not a target. {d.notes.busy}
      </Note>

      <div className="mt-4">
        <div className="text-muted-foreground mb-2 text-[12px] tracking-[0.06em] uppercase">
          Calendars
        </div>
        <div className="flex flex-wrap gap-1.5">
          {d.calendars.map((c) => (
            <Badge
              key={`${c.accountId}:${c.calendarId}`}
              variant="secondary"
              className={c.selected ? undefined : "opacity-60"}
              title={
                c.selected
                  ? `${c.accessRole ?? "read"} · ${c.timezone ?? "no timezone"}`
                  : "Not ticked in Google, so it is not read at all"
              }
            >
              {c.primary && "★ "}
              {c.summary ?? c.calendarId}
            </Badge>
          ))}
        </div>
        <Note>
          {selected.length} of {d.calendars.length} are ticked in Google and
          therefore read. {d.notes.window}
        </Note>
      </div>

      <Note>
        <b className="text-foreground font-medium">Nothing private is held.</b>{" "}
        {d.notes.privacy}
      </Note>
    </PanelSection>
  );
}
