import { useReorderMotion } from "@/hooks/useReorderMotion";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Item = { key: string; label: string };
type Drag = { key: string; pointerId: number; startY: number; y: number; active: boolean; row: HTMLDivElement };

/** How far the pointer travels before a press becomes a drag. Under this a
 *  press is a click, and the link underneath it is followed as usual. */
const THRESHOLD_PX = 4;

/**
 * A LIST WHOSE ROWS ARE THEIR OWN HANDLES.
 *
 * The pinned list used to carry a grip on every row — a six-dot button that
 * was the one place a drag could start, because the rest of the row is a
 * link and a link that is also a drag surface has to decide, on every press,
 * which of the two it is. The grip was that decision made by layout. The
 * owner would rather drag the row, so the decision is made by distance
 * instead: a press that travels under four pixels is a click and the link
 * fires; one that travels further is a drag, and the click that ends it is
 * swallowed before it reaches the link. Which is what every file manager
 * does, and what the grip was standing in for.
 *
 * THE POINTER IS CAPTURED ONLY ONCE THE DRAG IS REAL. Capturing on pointerdown
 * — the natural place — retargets the pointerup to the capturing row, and the
 * browser then fires the click on the common ancestor of down and up: the
 * row, not the link. Every plain click would stop navigating. So the capture
 * waits for the threshold, and until then the events flow where they always
 * did.
 *
 * Buttons inside a row — pin, more, the session menu — are not drag starts:
 * a press on one is that control's, and it does what it says. The keyboard
 * moves a focused row with Alt and an arrow, Home or End, because a bare
 * arrow on a focused link belongs to the scroll. Escape drops a drag where
 * it started.
 */
export function SortableList<T extends Item>({ items, onReorder, renderItem, describedAs }: {
  items: T[];
  onReorder: (keys: string[]) => void;
  renderItem: (item: T) => ReactNode;
  /** What a row is, for the screen-reader instructions: "page", "pin". */
  describedAs: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useReorderMotion(list, items.map(i=>i.key).join("|"), "data-sort-key");
  const drag = useRef<Drag | null>(null);
  /** Set when a drag has just ended, so the click that closes it is swallowed
   *  rather than followed. Cleared by that click, or the next press. */
  const swallowClick = useRef(false);
  const [preview, setPreview] = useState<{ key: string; before: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const helpId = useId();

  function beforeAt(y: number, key: string): string | null {
    const rows = list.current?.querySelectorAll<HTMLElement>("[data-sort-key]") ?? [];
    for (const row of rows) {
      if (row.dataset.sortKey === key) continue;
      const rect = row.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return row.dataset.sortKey!;
    }
    return null;
  }

  function reset() {
    const active = drag.current;
    drag.current = null;
    if (active?.row.hasPointerCapture(active.pointerId)) active.row.releasePointerCapture(active.pointerId);
    setPreview(null);
  }

  const dragging = preview !== null;
  useEffect(() => {
    if (!dragging) return;
    let frame: number;
    /* Nudge the scroll area when the pointer sits near its edge, so a row can
       be carried further than the viewport shows. */
    const tick = () => {
      const active = drag.current;
      const viewport = list.current?.closest<HTMLElement>("[data-slot=scroll-area-viewport]");
      if (active && viewport) {
        const rect = viewport.getBoundingClientRect();
        const speed = active.y < rect.top + 40 ? -7 : active.y > rect.bottom - 40 ? 7 : 0;
        if (speed) {
          viewport.scrollTop += speed;
          const before = beforeAt(active.y, active.key);
          setPreview(previous => previous?.before === before ? previous : { key: active.key, before });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); reset(); setAnnouncement("Reordering cancelled."); }
    };
    window.addEventListener("keydown", cancel);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", cancel); };
  }, [dragging]);

  function move(key: string, position: number) {
    const keys = items.filter(item => item.key !== key).map(item => item.key);
    keys.splice(Math.max(0, Math.min(keys.length, position)), 0, key);
    onReorder(keys);
    setAnnouncement(`${items.find(item => item.key === key)?.label ?? "Item"} moved to position ${keys.indexOf(key) + 1} of ${keys.length}.`);
  }

  function start(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    /* A control inside the row is that control's press, not a drag start. */
    if ((event.target as HTMLElement).closest("button, input, textarea, [data-no-drag]")) return;
    swallowClick.current = false;
    drag.current = { key: event.currentTarget.dataset.sortKey!, pointerId: event.pointerId, startY: event.clientY, y: event.clientY, active: false, row: event.currentTarget };
  }

  function track(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    active.y = event.clientY;
    if (!active.active) {
      if (Math.abs(active.y - active.startY) < THRESHOLD_PX) return;
      active.active = true;
      active.row.setPointerCapture(event.pointerId);
    }
    setPreview({ key: active.key, before: beforeAt(active.y, active.key) });
  }

  function finish(event: PointerEvent<HTMLDivElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.active) {
      const rest = items.filter(item => item.key !== active.key).map(item => item.key);
      const before = beforeAt(event.clientY, active.key);
      move(active.key, before === null ? rest.length : rest.indexOf(before));
      swallowClick.current = true;
    }
    reset();
  }

  function keyMove(event: KeyboardEvent<HTMLDivElement>, item: T, index: number) {
    if (!event.altKey || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    reset();
    const last = items.length - 1;
    const position = event.key === "Home" ? 0 : event.key === "End" ? last
      : Math.max(0, Math.min(last, index + (event.key === "ArrowUp" ? -1 : 1)));
    move(item.key, position);
  }

  return <>
    <p id={helpId} className="sr-only">Drag a {describedAs} to reorder it, or hold Alt and press Up or Down. Alt with Home moves it to the top; Alt with End moves it to the bottom. Escape cancels a drag.</p>
    <span role="status" className="sr-only">{announcement}</span>
    <div ref={list} className={cn("relative space-y-px", dragging && "cursor-grabbing")}>
      {items.map((item, index) => <div
        key={item.key}
        data-sort-key={item.key}
        aria-describedby={helpId}
        className={cn("relative select-none", preview?.key === item.key && "opacity-40", preview?.before === item.key && "rounded-lg bg-accent/60")}
        onPointerDown={start}
        onPointerMove={track}
        onPointerUp={finish}
        onPointerCancel={reset}
        onLostPointerCapture={reset}
        onDragStart={event => event.preventDefault()}
        onClickCapture={event => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={event => keyMove(event, item, index)}
      >
        {preview?.before === item.key && <div className="pointer-events-none absolute inset-x-1 -top-px z-10 h-0.5 rounded-full bg-primary" />}
        {renderItem(item)}
      </div>)}
      {preview && preview.before === null && <div className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary" />}
    </div>
  </>;
}
