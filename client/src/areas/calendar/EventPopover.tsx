import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useWide } from "./useWide";
import { CalendarDays, Clock, ExternalLink, MapPin, Users, Video, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CalendarEvent } from "@/lib/api/reports";
import { cn } from "@/lib/utils";
import {
  dot,
  joinLink,
  locationLink,
  nowStatus,
  responseLabel,
  titleOf,
  whenLabel,
} from "./dates";

/**
 * The event, where it was clicked — Google Calendar's own gesture.
 *
 * Fixed to the viewport rather than absolute in the grid, because the grid
 * scrolls inside its own card and an absolutely placed card would be clipped
 * at that edge. Beside the block when there is room, on the other side when
 * there is not, never past the bottom of the window; below md it is a sheet
 * along the bottom of the screen. Escape, a click outside, or scrolling the
 * grid closes it.
 *
 * Read-only: the collector reads Google with a GET and nothing else, so the
 * only way out of the card is Google's own page for the event.
 */
export type OpenedEvent = {
  event: CalendarEvent;
  rect: { x: number; y: number; w: number; h: number };
};

const CARD_W = 320;


function Row({ icon: Icon, children }: { icon: typeof Clock; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 text-[13px] leading-snug">
      <Icon className="text-muted-foreground mt-px size-4 shrink-0" strokeWidth={1.75} />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function EventPopover({
  opened,
  color,
  freeBusyOnly,
  today,
  now,
  onClose,
}: {
  opened: OpenedEvent;
  color: string | null;
  /** The calendar is shared as free/busy, so Google sends no words at all. */
  freeBusyOnly: boolean;
  today: Date;
  now: Date;
  onClose: () => void;
}) {
  const { event, rect } = opened;
  const wide = useWide();
  const card = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(260);

  useLayoutEffect(() => {
    if (card.current) setHeight(card.current.offsetHeight);
  }, [event]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    /* A card pinned to a block that has scrolled away is pointing at nothing. */
    const onScroll = (e: Event) => {
      if (card.current && e.target instanceof Node && card.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const cancelled = event.status === "cancelled";
  const declined = event.response === "declined";
  const status = nowStatus(event, now);
  const join = joinLink(event);
  const locLink = locationLink(event.location);
  const response = responseLabel(event.response);
  const swatch = dot(color);

  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fitsRight = rect.x + rect.w + gap + CARD_W <= vw - gap;
  const left = fitsRight ? rect.x + rect.w + gap : Math.max(gap, rect.x - gap - CARD_W);
  const top = Math.max(gap, Math.min(rect.y, vh - height - gap));

  return (
    <>
      <button
        type="button"
        aria-label="Close event details"
        tabIndex={-1}
        onClick={onClose}
        className={cn("fixed inset-0 z-30 cursor-default", !wide && "bg-foreground/25")}
      />
      <div
        ref={card}
        role="dialog"
        aria-label={titleOf(event)}
        style={wide ? { position: "fixed", left, top, width: CARD_W } : undefined}
        className={cn(
          "bg-card border-line-soft z-40 flex flex-col gap-3 border p-4 text-left shadow-xl",
          wide
            ? "rounded-[14px]"
            : "fixed inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-[18px] pb-6",
        )}
      >
        <div className="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            style={swatch ? { backgroundColor: swatch } : undefined}
            className={cn("mt-1.5 size-3 shrink-0 rounded-[4px]", !swatch && "bg-muted-foreground/40")}
          />
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                "text-[16px] leading-snug font-medium break-words",
                cancelled && "line-through opacity-60",
              )}
            >
              {titleOf(event)}
            </div>
            <div className="text-muted-foreground mt-0.5 text-[13px]">{whenLabel(event, today)}</div>
            {status && status.kind !== "past" && (
              <div
                className={cn(
                  "mt-1 text-[12.5px] font-medium",
                  status.kind === "now" ? "text-red-600 dark:text-red-400" : "text-foreground/80",
                )}
              >
                {status.text}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:bg-accent hover:text-foreground -mt-1 -mr-1 grid size-7 shrink-0 place-items-center rounded-lg"
          >
            <X className="size-4" strokeWidth={1.75} />
          </button>
        </div>

        {(cancelled || declined || event.status === "tentative") && (
          <div className="flex flex-wrap gap-1.5 text-[11.5px]">
            {cancelled && <span className="bg-muted rounded-md px-1.5 py-0.5">Cancelled</span>}
            {declined && <span className="bg-muted rounded-md px-1.5 py-0.5">You declined</span>}
            {event.status === "tentative" && (
              <span className="bg-muted rounded-md px-1.5 py-0.5">Tentative</span>
            )}
          </div>
        )}

        {join && !cancelled && (
          <Button asChild size="sm" className="self-start">
            <a href={join} target="_blank" rel="noreferrer">
              <Video strokeWidth={1.75} />
              {event.meetLink ? "Join Google Meet" : "Join meeting"}
            </a>
          </Button>
        )}

        <div className="flex flex-col gap-2">
          {event.location && !(locLink && locLink === join) && (
            <Row icon={MapPin}>
              {locLink ? (
                <a href={locLink} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  {event.location}
                </a>
              ) : (
                event.location
              )}
            </Row>
          )}
          {(event.attendees ?? 0) > 0 && (
            <Row icon={Users}>
              {event.attendees} guest{event.attendees === 1 ? "" : "s"}
              {event.organizerSelf ? " · you organised it" : ""}
              {response && <span className="text-muted-foreground"> · {response}</span>}
            </Row>
          )}
          <Row icon={CalendarDays}>
            {event.calendar}
            {freeBusyOnly && (
              <span className="text-muted-foreground block text-[12px]">
                Shared as free/busy only, so Google sends no title or details.
              </span>
            )}
          </Row>
        </div>

        {event.link && (
          <a
            href={event.link}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 self-start text-[12.5px]"
          >
            <ExternalLink className="size-3.5" strokeWidth={1.75} />
            Open in Google Calendar
          </a>
        )}
      </div>
    </>
  );
}
