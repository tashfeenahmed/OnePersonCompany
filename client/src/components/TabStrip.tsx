import { useRef, useState, type ComponentType } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * A strip of tabs the owner can drag into their own order.
 *
 * THE SAME STRIP FOR APPS AND DASHBOARDS, because they are navigated the same
 * way — the URL is the selection, each tab is a real link — and a reorder that
 * worked on one and not the other would be a bug the eye finds immediately.
 *
 * CLICK STILL NAVIGATES; HOLD STARTS A DRAG. A tab is a `<Link>`, and a link
 * that stops being clickable because it grew a drag handler is the worst
 * outcome available. So the drag is armed only after the pointer has been held
 * for a moment (`HOLD_MS`) without moving far, and a plain click — down and up
 * inside that window — is left alone for the router. Native HTML5 drag-and-drop
 * carries the reorder itself, the way the dashboard widgets already do it: no
 * library, the same drop-indicator line, the same before/after decision by
 * which half of the target the pointer is over.
 *
 * THE ORDER IS THE CALLER'S TO KEEP. This component reports a new key order and
 * draws whatever it is handed; where that order lives (the store, for both
 * callers) and whether it persists is not its business.
 */
export type Tab = {
  key: string;
  to: string;
  label: string;
  /** A small figure after the label — a dashboard's widget count. */
  count?: number;
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
    "text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg px-2.5 py-1.5 text-[13.5px] whitespace-nowrap",
    active && "bg-accent text-foreground font-medium",
  );
}

export function TabStrip({
  tabs,
  activeKey,
  onReorder,
  className,
}: {
  tabs: Tab[];
  activeKey: string | null;
  onReorder: (keys: string[]) => void;
  className?: string;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; side: "before" | "after" } | null>(null);
  // Which tab is armed for dragging — set by a held pointer, cleared by a
  // click that ended before the hold, and read by `draggable` below.
  const [armed, setArmed] = useState<string | null>(null);
  const holdTimer = useRef<number | null>(null);

  function arm(key: string) {
    clearHold();
    holdTimer.current = window.setTimeout(() => setArmed(key), HOLD_MS);
  }
  function clearHold() {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }

  function finish(targetKey: string) {
    if (!dragKey || !drop || dragKey === targetKey) return;
    const keys = tabs.filter(t => !t.fixed).map((t) => t.key);
    const from = keys.indexOf(dragKey);
    keys.splice(from, 1);
    const to = keys.indexOf(targetKey) + (drop.side === "after" ? 1 : 0);
    keys.splice(to, 0, dragKey);
    onReorder(keys);
  }

  function reset() {
    setDragKey(null);
    setDrop(null);
    setArmed(null);
    clearHold();
  }

  return (
    <div className={cn("flex items-center gap-0.5 overflow-x-auto", className)}>
      <input aria-label="Find a tab" placeholder="Find a tab…" value={query} onChange={e => setQuery(e.target.value)} className="w-[110px] shrink-0 rounded border px-2 py-1.5 text-xs" onKeyDown={e => { if (e.key === "Enter") { const found = tabs.find(t => t.label.toLowerCase().includes(query.toLowerCase())); if (found) { navigate(found.to); setQuery(""); } } }} />
      <select aria-label="Choose any tab" value={activeKey ?? ""} className="max-w-[160px] shrink-0 rounded border p-1.5 text-xs" onChange={e => { const tab = tabs.find(t => t.key === e.target.value); if (tab) navigate(tab.to); }}>
        <option value="" disabled>All tabs…</option>{tabs.filter(t => t.key === activeKey || t.label.toLowerCase().includes(query.toLowerCase())).map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
      <span className="sr-only" role="status">{announcement}</span>
      {tabs.map((t) => {
        const active = t.key === activeKey;
        const Icon = t.icon;
        return (
          <Link
            key={t.key}
            to={t.to}
            aria-current={active ? "page" : undefined}
            title={t.fixed ? undefined : "Alt + Left/Right arrow to reorder"}
            onKeyDown={e => {
              if (t.fixed || !e.altKey || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
              e.preventDefault(); const keys = tabs.filter(x => !x.fixed).map(x => x.key), from = keys.indexOf(t.key), to = Math.max(0, Math.min(keys.length - 1, from + (e.key === "ArrowLeft" ? -1 : 1)));
              keys.splice(from, 1); keys.splice(to, 0, t.key); onReorder(keys);
              const position = tabs.map((tab, index) => tab.fixed ? 0 : index + 1).filter(Boolean)[to];
              setAnnouncement(`${t.label} moved to position ${position}`);
            }}
            draggable={!t.fixed && armed === t.key}
            onPointerDown={() => { if (!t.fixed) arm(t.key); }}
            onPointerUp={clearHold}
            onPointerLeave={clearHold}
            onDragStart={(e) => {
              // A link's default drag carries its URL; a reorder carries the
              // tab. Mark it as a move so the cursor says so.
              e.dataTransfer.effectAllowed = "move";
              setDragKey(t.key);
            }}
            onDragEnd={reset}
            onDragOver={(e) => {
              if (t.fixed || !dragKey || dragKey === t.key) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setDrop({
                key: t.key,
                side: e.clientX > r.left + r.width / 2 ? "after" : "before",
              });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (!t.fixed) finish(t.key);
              reset();
            }}
            onClick={(e) => {
              // A drop landing on a link must not also follow it.
              if (dragKey) e.preventDefault();
            }}
            className={cn(
              tabItemClass(active),
              "relative hidden items-center gap-[7px] select-none sm:flex",
              armed === t.key && "cursor-grab",
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
        "mb-5 flex items-center gap-0.5 overflow-x-auto",
        rule && "border-line-soft border-b pb-2",
        className,
      )}
    >
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
            title={t.title}
            aria-current={active ? "page" : undefined}
            className={shape}
          >
            {inner}
          </Link>
        ) : (
          <button
            key={t.key}
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
