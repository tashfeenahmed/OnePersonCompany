import { SelectionPill } from "@/components/interactions/SelectionPill";
import { useReorderMotion } from "@/hooks/useReorderMotion";
import { useRef, useState, useEffect, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { AlertBadge } from "@/components/AlertBadge";
import type { AlertSummary } from "@/lib/dashboardAlerts";

/**
 * A strip of tabs the owner can drag into their own order.
 *
 * THE SAME STRIP FOR APPS AND DASHBOARDS, because they are navigated the same
 * way — the URL is the selection, each tab is a real link — and a reorder that
 * worked on one and not the other would be a bug the eye finds immediately.
 *
 * Click follows the link; movement beyond a small threshold reorders it.
 * Touch waits briefly so a scroll does not accidentally move a tab. Pointer
 * events keep a visible destination across wrapped rows; Escape cancels.
 *
 * THE ORDER IS THE CALLER'S TO KEEP. This component reports a new key order and
 * draws whatever it is handed; where that order lives (the store, for both
 * callers) and whether it persists is not its business.
 */
export type Tab = {
  key: string;
  to: string;
  label: string;
  /** Optional ordinary count for non-dashboard tabs. */
  count?: number;
  alerts?: AlertSummary;
  alertsStale?: boolean;
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  fixed?: boolean;
};

/** How long the pointer must rest on a tab before a drag is armed. Short
 *  enough not to feel like a long-press, long enough that a click never
 *  starts one. */
const HOLD_MS = 150;

/**
 * WHAT A TAB LOOKS LIKE, AND WHAT "THIS ONE" LOOKS LIKE — once, for both
 * strips below.
 *
 * Thirteen strips had been hand-rolled across the areas in FOUR different
 * selected-affordances: this filled pill, a bordered card, a background swap
 * and an underline. Sibling pages of one app taught a reader four different
 * ways to see where they were. The pill won because it is what the app bar
 * already uses, so a page has one visual language rather than two.
 */
function tabItemClass(active: boolean): string {
  return cn(
    "text-muted-foreground hover:bg-accent hover:text-foreground selection-control rounded-lg px-2.5 py-1.5 text-[13.5px] whitespace-nowrap",
    active && "text-foreground font-medium",
  );
}

export function TabStrip({
  tabs,
  activeKey,
  onReorder,
  className,
  showOnMobile = false,
}: {
  tabs: Tab[];
  activeKey: string | null;
  onReorder: (keys: string[]) => void;
  className?: string;
  showOnMobile?: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useReorderMotion(strip, tabs.map(t=>t.key).join("|"), "data-tab-key");
  const [announcement, setAnnouncement] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; side: "before" | "after" } | null>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  const swallowClick = useRef(false);
  useEffect(() => () => cancelDrag.current?.(), []);
  function start(e: React.PointerEvent<HTMLAnchorElement>, tab: Tab) {
    if (tab.fixed || e.button !== 0) return;
    cancelDrag.current?.(); swallowClick.current = false;
    let held = e.pointerType !== "touch", moved = false, destination: { key: string; side: "before" | "after" } | null = null;
    const pointer = e.pointerId, startX = e.clientX, startY = e.clientY;
    const timer = setTimeout(() => { held = true; }, HOLD_MS);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      const distance = Math.hypot(ev.clientX-startX, ev.clientY-startY);
      if (!held && distance > 8) { finish(false); return; }
      if (!held || distance < 5) return;
      ev.preventDefault(); moved = true; setDragKey(tab.key);
      const choices = [...(strip.current?.querySelectorAll<HTMLElement>("[data-tab-key]") ?? [])].filter(el => el.dataset.tabKey !== tab.key && !tabs.find(t => t.key === el.dataset.tabKey)?.fixed);
      let nearest: HTMLElement | null = null, best = Infinity;
      for (const el of choices) { const r = el.getBoundingClientRect(); const dx = Math.max(r.left-ev.clientX, 0, ev.clientX-r.right), dy = Math.max(r.top-ev.clientY, 0, ev.clientY-r.bottom); const distance = dx*dx+dy*dy; if(distance<best){best=distance;nearest=el;} }
      if (nearest) { const r = nearest.getBoundingClientRect(); destination = { key: nearest.dataset.tabKey!, side: ev.clientX > r.left+r.width/2 ? "after" : "before" }; setDrop(destination); }
    };
    const finish = (commit: boolean) => {
      clearTimeout(timer); document.removeEventListener("pointermove",move); document.removeEventListener("pointerup",up); document.removeEventListener("pointercancel",cancel); document.removeEventListener("keydown",key); window.removeEventListener("blur",cancel);
      if (moved) swallowClick.current = true;
      if (commit && moved && destination) {
        const keys = tabs.filter(t=>!t.fixed && t.key!==tab.key).map(t=>t.key);
        const to = keys.indexOf(destination.key)+(destination.side === "after" ? 1 : 0);
        keys.splice(to,0,tab.key); onReorder(keys); setAnnouncement(`${tab.label} moved to position ${to+1}`);
      } else if(moved) setAnnouncement("Move cancelled");
      setDragKey(null); setDrop(null); cancelDrag.current = null;
    };
    const up = (ev: PointerEvent) => { if(ev.pointerId === pointer) finish(true); };
    const cancel = () => finish(false);
    const key = (ev: KeyboardEvent) => { if(ev.key === "Escape"){ev.preventDefault();cancel();} };
    cancelDrag.current = cancel;
    document.addEventListener("pointermove",move,{passive:false}); document.addEventListener("pointerup",up); document.addEventListener("pointercancel",cancel); document.addEventListener("keydown",key); window.addEventListener("blur",cancel);
  }

  /* WRAPS RATHER THAN SCROLLS. A strip that scrolled sideways hid every tab
     past the edge, and the find box and the dropdown that stood in for them
     were two controls for a problem the strip should not have. Every tab is
     visible; the row grows a line when it must. */
  return (
    <div ref={strip} className={cn("relative flex flex-wrap items-center gap-0.5", className)}>
      <SelectionPill value={`${activeKey}:${tabs.map(t=>t.key).join("|")}`}/>
      <span className="sr-only" role="status">{announcement}</span>
      {tabs.map((t) => {
        const active = t.key === activeKey;
        const Icon = t.icon;
        return (
          <Link
            key={t.key}
            to={t.to}
            data-tab-key={t.key}
            data-selected={active}
            aria-current={active ? "page" : undefined}
            title={t.fixed ? undefined : "Drag to reorder · Alt + Left/Right arrow with the keyboard"}
            onKeyDown={e => {
              if (t.fixed || !e.altKey || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
              e.preventDefault(); const keys = tabs.filter(x => !x.fixed).map(x => x.key), from = keys.indexOf(t.key), to = Math.max(0, Math.min(keys.length - 1, from + (e.key === "ArrowLeft" ? -1 : 1)));
              keys.splice(from, 1); keys.splice(to, 0, t.key); onReorder(keys);
              const position = tabs.map((tab, index) => tab.fixed ? 0 : index + 1).filter(Boolean)[to];
              setAnnouncement(`${t.label} moved to position ${position}`);
            }}
            draggable={false}
            onDragStart={e => e.preventDefault()}
            onPointerDown={e => start(e,t)}
            onClick={e => { if (swallowClick.current) { e.preventDefault(); swallowClick.current = false; } }}
            className={cn(
              tabItemClass(active),
              "relative items-center gap-[7px] select-none",
              showOnMobile ? "flex" : "hidden sm:flex",
              drop?.key === t.key && "drag-destination",
              dragKey === t.key && "opacity-35",
              drop?.key === t.key &&
                drop.side === "before" &&
                "before:bg-foreground before:absolute before:top-1 before:bottom-1 before:-left-[3px] before:w-0.5 before:rounded-sm before:content-['']",
              drop?.key === t.key &&
                drop.side === "after" &&
                "after:bg-foreground after:absolute after:top-1 after:bottom-1 after:-right-[3px] after:w-0.5 after:rounded-sm after:content-['']",
            )}
          >
            {Icon && <Icon className="size-3.5" strokeWidth={1.6} />}
            {t.label}
            {t.alerts && <AlertBadge summary={t.alerts} stale={t.alertsStale}/>}
            {t.count !== undefined && (
              <span className="text-muted-foreground text-[12px]">{t.count}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------ the sub-tab strip */

/** One choice within a page. `to` when the URL carries the selection, which is
 *  most of them; without it the strip is a set of buttons and `onSelect` is
 *  what moves. */
export type SubTab = {
  key: string;
  label: string;
  to?: string;
  /** A small figure after the label — how many rows the tab would show. */
  count?: number;
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  /** The hover sentence. A tab whose name is a noun the reader has not met
   *  yet is worth explaining before they press it. */
  title?: string;
};

/**
 * THE SAME STRIP, WITHOUT THE DRAG.
 *
 * Sub-tabs are not reorderable and should not pretend to be: the app bar's
 * order is the owner's arrangement of their own work, while a page's tabs are
 * its author's argument about what to read first. So this shares the LOOK and
 * none of the pointer machinery — no hold-to-arm, no drop indicator, no find
 * box and no overflow select, none of which a four-item row needs.
 *
 * `aria-current="page"` IS NOT OPTIONAL and is why this exists as a component
 * rather than as a copied class string. Two of the thirteen strips it replaces
 * set no current marker at all, so a screen reader was read a row of four
 * identical links with nothing saying which page it was already on.
 *
 * The row SCROLLS rather than wraps, because a strip that reflows to two lines
 * moves the content under it every time the window changes width.
 */
export function SubTabs({
  tabs,
  activeKey,
  onSelect,
  rule,
  className,
}: {
  tabs: readonly SubTab[];
  activeKey: string | null;
  /** Called for a tab with no `to`. A tab with one is a link and navigates. */
  onSelect?: (key: string) => void;
  /** A hairline under the row, for pages where the tabs sit directly on top of
   *  the thing they switch and the eye needs the seam. */
  rule?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative mb-5 flex items-center gap-0.5 overflow-x-auto",
        rule && "border-line-soft border-b pb-2",
        className,
      )}
    >
      <SelectionPill value={activeKey}/>
      {tabs.map((t) => {
        const active = t.key === activeKey;
        const Icon = t.icon;
        const inner = (
          <>
            {Icon && <Icon className="size-3.5" strokeWidth={1.6} />}
            {t.label}
            {t.count !== undefined && (
              <span className="text-muted-foreground text-[12px]">{t.count}</span>
            )}
          </>
        );
        const shape = cn(tabItemClass(active), "flex shrink-0 items-center gap-[7px]");

        return t.to ? (
          <Link
            key={t.key}
            to={t.to}
            data-tab-key={t.key}
            data-selected={active}
            title={t.title}
            aria-current={active ? "page" : undefined}
            className={shape}
          >
            {inner}
          </Link>
        ) : (
          <button
            key={t.key}
            data-selected={active}
            type="button"
            title={t.title}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect?.(t.key)}
            className={shape}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}
