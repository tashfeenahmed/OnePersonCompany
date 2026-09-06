import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

type Item = { key: string; label: string };
type Drag = { key: string; pointerId: number; startY: number; y: number; active: boolean; handle: HTMLButtonElement };

/** A captured pointer supports mouse, pen and touch without making links draggable. */
export function PinnedSection<T extends Item>({ items, onReorder, renderItem }: {
  items: T[];
  onReorder: (keys: string[]) => void;
  renderItem: (item: T, handle: ReactNode) => ReactNode;
}) {
  const list = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ key: string; before: string | null } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const helpId = useId();

  function beforeAt(y: number, key: string): string | null {
    const rows = list.current?.querySelectorAll<HTMLElement>("[data-pin-key]") ?? [];
    for (const row of rows) {
      if (row.dataset.pinKey === key) continue;
      const rect = row.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) return row.dataset.pinKey!;
    }
    return null;
  }

  function reset() {
    const active = drag.current;
    drag.current = null;
    if (active?.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId);
    setPreview(null);
  }

  const dragging = preview !== null;
  useEffect(() => {
    if (!dragging) return;
    let frame: number;
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
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); reset(); setAnnouncement("Reordering cancelled."); }
    };
    window.addEventListener("keydown", cancel);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", cancel); };
  }, [dragging]);

  function finish(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.active) {
      const keys = items.filter(item => item.key !== active.key).map(item => item.key);
      const before = beforeAt(event.clientY, active.key);
      const position = before === null ? keys.length : keys.indexOf(before);
      keys.splice(Math.max(0, position), 0, active.key);
      onReorder(keys);
      setAnnouncement(`${items.find(item => item.key === active.key)?.label ?? "Item"} moved to position ${keys.indexOf(active.key) + 1} of ${keys.length}.`);
    }
    reset();
  }

  return <section aria-label="Pinned" className="mb-2 border-b border-line-soft pb-2">
    <h2 className="px-2 py-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Pinned</h2>
    <p id={helpId} className="sr-only">Drag to reorder, or use Up and Down arrows. Home moves to the top; End moves to the bottom. Escape cancels a drag.</p>
    <span role="status" className="sr-only">{announcement}</span>
    {!items.length && <p className="px-2 pb-1 text-[11.5px] leading-relaxed text-muted-foreground">Pin pages or sessions for quick access.</p>}
    <div ref={list} className="relative space-y-px">
      {items.map((item, index) => <div key={item.key} data-pin-key={item.key} className="relative">
        {preview?.before === item.key && <div className="pointer-events-none absolute inset-x-1 -top-px z-10 h-0.5 rounded-full bg-primary" />}
        <div className={cn(preview?.key === item.key && "opacity-40")}>
          {renderItem(item, <button
            type="button"
            aria-label={`Reorder ${item.label}`}
            aria-describedby={helpId}
            title="Drag to reorder · ↑ / ↓ to move"
            className="sidebar-row-action ml-0.5 grid h-7 w-4 shrink-0 touch-none cursor-grab place-items-center rounded text-muted-foreground transition-opacity hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
            onPointerDown={event => {
              if (event.button !== 0 || !event.isPrimary) return;
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { key: item.key, pointerId: event.pointerId, startY: event.clientY, y: event.clientY, active: false, handle: event.currentTarget };
            }}
            onPointerMove={event => {
              const active = drag.current;
              if (!active || active.pointerId !== event.pointerId) return;
              active.y = event.clientY;
              if (!active.active && Math.abs(active.y - active.startY) < 4) return;
              active.active = true;
              setPreview({ key: active.key, before: beforeAt(active.y, active.key) });
            }}
            onPointerUp={finish}
            onPointerCancel={reset}
            onLostPointerCapture={reset}
            onKeyDown={event => {
              if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              reset();
              const keys = items.map(value => value.key);
              const position = event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1
                : Math.max(0, Math.min(keys.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
              keys.splice(index, 1); keys.splice(position, 0, item.key);
              onReorder(keys);
              setAnnouncement(`${item.label} moved to position ${position + 1} of ${keys.length}.`);
            }}
          ><GripVertical aria-hidden="true" className="size-3" strokeWidth={1.5} /></button>)}
        </div>
      </div>)}
      {preview && preview.before === null && <div className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary" />}
    </div>
  </section>;
}
