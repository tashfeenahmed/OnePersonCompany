import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Copy, Plus, Search, Trash2 } from "lucide-react";
import { moveTo, slotFor, type Rect } from "@/lib/dragOrder";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandTile } from "@/components/BrandTile";
import { WidgetCard } from "@/components/WidgetCard";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  defaultWidth,
  uid,
  useStore,
  type Dashboard,
  type PlacedWidget,
} from "@/lib/store";
import { collectedAt, useLive } from "@/lib/live";
import { widgetName, windowWords } from "@/lib/window";
import { SOURCES, WIDGETS } from "@/data/widgets";

/**
 * ONE DASHBOARD, WHEREVER IT LIVES.
 *
 * Two pages draw a board — the global set at /dashboards/<board> and a
 * venture's at /ventures/<slug>/dashboards/<board> — and they are the SAME
 * BOARD: the same grid, the same edit panel, the same drag, the same delete.
 * Five hundred lines is too many to keep two of in step.
 *
 * WHAT THE CALLER OWNS is the chrome above it: the tab strip (the global page's
 * is a strip of boards; a venture's is Overview plus its boards) and the
 * "New dashboard" control that goes with it. Those genuinely differ, so they
 * are the caller's, and everything below the title line is here.
 *
 * `basePath` is what makes the links work in both places, and `ventureId` is
 * what a copy or a new board is filed under. The narrowing itself is NOT done
 * here: the venture page wraps this in a `ScopeProvider` and the cards read it
 * through the live context, which is why nothing below knows a venture exists.
 */

/** 1 → 2 → 4 → 1. Four is the full width of the grid. */
function nextWidth(w: 1 | 2 | 4): 1 | 2 | 4 {
  return w === 1 ? 2 : w === 2 ? 4 : 1;
}

export function BoardView({
  board,
  basePath,
  homePath,
  ventureId,
  scopeNote,
}: {
  board: Dashboard;
  /** Where this board's siblings live: "/dashboards" or
   *  "/ventures/<slug>/dashboards". */
  basePath: string;
  /** Where to go when the last board in this scope is deleted. */
  homePath: string;
  /** The venture this board belongs to, or null for the global set. */
  ventureId: string | null;
  /** One clause under the title saying what the numbers were narrowed to —
   *  "scoped to example.com", or why they were not. */
  scopeNote?: string;
}) {
  const { state, renameDashboard, deleteDashboard, copyDashboard, setWidgets } =
    useStore();
  const live = useLive();
  const navigate = useNavigate();
  const { state: nav } = useLocation();
  /*
    A board made a second ago opens with the palette out — a dashboard is
    created in order to put something on it. The signal travels in the
    navigation rather than in a store field, because it is true of one arrival
    at this URL and not of the board: coming back to the same address later, or
    reloading it, should not reopen the panel.
  */
  const [editing, setEditing] = useState(
    (nav as { editing?: boolean } | null)?.editing === true,
  );
  /*
    AND THE SIGNAL IS SPENT ON ARRIVAL. Browsers keep navigation state across
    a reload, so the flag that meant "you just made this board" was still
    there every time the page was refreshed, and the panel opened on a board
    made a month ago. Replacing the entry with no state the moment it has
    been read leaves the address intact and the flag gone.
  */
  useEffect(() => {
    if ((nav as { editing?: boolean } | null)?.editing === true)
      navigate(`${window.location.pathname}${window.location.search}`, { replace: true, state: null });
    // Once, on arrival: the flag is read into state above and never again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [q, setQ] = useState("");
  const [moveNote, setMoveNote] = useState("");
  const [renaming, setRenaming] = useState(false);
  // Reset with the board, so leaving edit mode or switching boards never
  // returns you to a half-armed delete.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const copyTargets = [
    { id: null as string | null, name: "Global dashboards" },
    ...state.ventures.map((v) => ({ id: v.id as string | null, name: v.name })),
  ].filter((target) => target.id !== ventureId);
  /*
    DRAG, BY POINTER, TO ANYWHERE ON THE CANVAS.

    The first drag was the browser's own (`draggable`, dragover, drop): it
    could only land on another card, so the empty half of the canvas and the
    add-widget tile swallowed drops, and on a touch screen it did nothing at
    all. This one is a pointer session: grab a card, and on every move the
    slot under the pointer is computed from the other cards' rectangles
    (lib/dragOrder.ts) — between two cards, at a row's end, below the last
    row — marked with the same indicator, and applied on release. A ghost
    with the card's name follows the pointer so the eye has the thing it is
    moving. Buttons inside a card are not grab handles.
  */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    side: "before" | "after";
  } | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<number | null>(null);

  function grab(e: React.PointerEvent<HTMLDivElement>, id: string) {
    if (!editing || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    e.preventDefault();
    const label = WIDGETS[board.widgets.find((w) => w.id === id)?.type ?? ""]?.name ?? "widget";
    setDragId(id);
    setGhost({ x: e.clientX, y: e.clientY, label });
    slotRef.current = null;

    const rects = (): Rect[] =>
      Array.from(gridRef.current?.querySelectorAll<HTMLElement>("[data-widget-id]") ?? [])
        .filter((el) => el.dataset.widgetId !== id)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { id: el.dataset.widgetId!, left: r.left, top: r.top, width: r.width, height: r.height };
        });

    const move = (ev: PointerEvent) => {
      const slot = slotFor(rects(), ev.clientX, ev.clientY);
      slotRef.current = slot.index;
      setDropTarget(slot.mark);
      setGhost({ x: ev.clientX, y: ev.clientY, label });
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      const at = slotRef.current;
      if (at !== null) setWidgets(board.id, moveTo(board.widgets, id, at));
      setDragId(null);
      setDropTarget(null);
      setGhost(null);
      slotRef.current = null;
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  }

  const sources = useMemo(
    () =>
      new Set(board.widgets.map((w) => WIDGETS[w.type]?.src).filter(Boolean))
        .size,
    [board],
  );

  // How many of this board's widgets are showing measured numbers.
  const liveHere = board.widgets.filter((w) =>
    live.liveTypes.has(w.type),
  ).length;

  /**
   * How fresh this board is, in one clause.
   *
   * A board can draw on four providers read on four schedules, so the honest
   * summary is the STALEST of them — "the oldest reading here is nine minutes
   * old" is a claim about the whole board, where quoting the newest would let a
   * card collected this morning hide behind one collected a minute ago. With a
   * single source it is just that source's time, and with none that report one
   * the clause is omitted rather than guessed at.
   */
  const freshness = useMemo(() => {
    const stamps = [
      ...new Set(
        board.widgets
          .filter((w) => live.liveTypes.has(w.type))
          .map((w) => WIDGETS[w.type]?.src)
          .filter((src): src is string => !!src),
      ),
    ]
      .map((src) => collectedAt(src, live))
      .filter((at): at is string => !!at);

    if (!stamps.length) return null;
    const oldest = stamps.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b));
    return stamps.length > 1
      ? `, oldest collected ${ago(oldest)}`
      : `, collected ${ago(oldest)}`;
  }, [board, live]);

  function mutate(fn: (widgets: PlacedWidget[]) => PlacedWidget[]) {
    setWidgets(board.id, fn(board.widgets));
  }

  /** Where a board in a given scope lives. One function, so a copy always
   *  lands on an address that resolves. */
  function pathFor(target: string | null, slug: string) {
    if (!target) return `/dashboards/${slug}`;
    const venture = state.ventures.find((v) => v.id === target);
    return venture ? `/ventures/${venture.slug}/dashboards/${slug}` : `/dashboards/${slug}`;
  }

  return (
    <>
      <span role="status" className="sr-only">{moveNote}</span>
      <div className="flex min-h-0 flex-1">
        <div className={cn("min-w-0 flex-1 overflow-y-auto px-3 sm:px-6 pt-2", editing ? "pb-[48vh] md:pb-20" : "pb-20")}>
          <div className="mx-auto w-full max-w-[1040px]">
            <div className="mt-2 mb-5 flex flex-wrap items-end gap-3">
              <div>
                <h1 className="mb-1 text-[27px] font-normal tracking-[-0.025em]">
                  {board.name}
                </h1>
                <p className="text-muted-foreground text-[14.5px]">
                  {`${board.widgets.length} ${board.widgets.length === 1 ? "widget" : "widgets"} from ${sources} ${sources === 1 ? "service" : "services"}`}
                  {liveHere > 0 && (
                    <>
                      {" · "}
                      <span className="text-ok">{liveHere} live</span>
                      {freshness ?? ""}
                    </>
                  )}
                  {/* The span every windowed card below is drawn over, from
                      the picker in the strip above. Said here as well because
                      a board is read from its title down, and "last 7 days"
                      is the first thing that changes what the figures mean. */}
                  {" · "}
                  {windowWords(live.window)}
                  {/* What this board's numbers are about. On a venture board it
                      is the most important sentence on the page: every figure
                      below either belongs to that host or wears a "portfolio"
                      tag saying it could not be narrowed. */}
                  {scopeNote && (
                    <>
                      {" · "}
                      {scopeNote}
                    </>
                  )}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                <Button variant="ghost" onClick={live.reload} disabled={live.loading}>Refresh</Button>
                <Button variant="ghost" onClick={() => setRenaming(true)}>
                  Rename
                </Button>
                <Button
                  variant={editing ? "default" : "outline"}
                  onClick={() => {
                    setEditing((e) => !e);
                    setConfirmingDelete(false);
                  }}
                >
                  {editing ? "Done" : "Edit"}
                </Button>
              </div>
            </div>

            <div ref={gridRef} className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
              {!board.widgets.length && (
                <div className="text-muted-foreground col-span-full rounded-[14px] border border-dashed px-5 py-11 text-center">
                  {editing
                    ? "Pick metrics from the panel on the right to build this dashboard."
                    : "Empty dashboard. Hit Edit to add widgets."}
                </div>
              )}

              {board.widgets.map((w) => (
                <WidgetCard
                  key={w.id}
                  placed={w}
                  editing={editing}
                  onMove={direction => { const from = board.widgets.findIndex(x => x.id === w.id); const to = Math.max(0, Math.min(board.widgets.length - 1, from + direction)); setWidgets(board.id, moveTo(board.widgets, w.id, to)); setMoveNote(`${WIDGETS[w.type]?.name ?? "Widget"} moved to position ${to + 1}`); }}
                  dragging={dragId === w.id}
                  dropSide={dropTarget?.id === w.id ? dropTarget.side : null}
                  onCycleWidth={() =>
                    mutate((list) =>
                      list.map((x) =>
                        x.id === w.id ? { ...x, w: nextWidth(x.w) } : x,
                      ),
                    )
                  }
                  onRemove={() =>
                    mutate((list) => list.filter((x) => x.id !== w.id))
                  }
                  dragHandlers={{
                    "data-widget-id": w.id,
                    onPointerDown: (e) => grab(e, w.id),
                  } as React.HTMLAttributes<HTMLDivElement>}
                />
              ))}

              {editing && (
                <button
                  onClick={() => setEditing(true)}
                  className="text-muted-foreground hover:border-line-strong hover:text-foreground flex min-h-[116px] flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed text-[13.5px]"
                >
                  <Plus className="size-4" strokeWidth={1.6} />
                  Add widget
                </button>
              )}
            </div>
          </div>
        </div>

        {ghost && (
          <div
            aria-hidden
            className="bg-card text-foreground pointer-events-none fixed z-50 rounded-[11px] px-3 py-2 text-[13px] shadow-md"
            style={{ left: ghost.x + 12, top: ghost.y + 12 }}
          >
            {ghost.label}
          </div>
        )}
        {/*
          THE CATALOG SLIDES RATHER THAN APPEARING.

          It used to be mounted on `editing` and unmounted off it, which meant
          300px of panel arrived in one frame and the canvas beside it jumped a
          column narrower with no motion to connect the two — the same abrupt
          swap the worker page's settings had. It is kept mounted now and moved:
          off the bottom on a phone, out to nought width on a desktop, with the
          transform and the size on the same transition so the canvas reflows
          alongside it instead of after it.

          `inert` AND `aria-hidden` GO WITH THE TRANSFORM, because a panel that
          is merely off-screen is still in the tab order and still read out. The
          borders go with it too: a zero-width column with a border-left is a
          stray hairline down the middle of a board nobody is editing.
        */}
        <aside
          aria-hidden={!editing}
          inert={!editing || undefined}
          className={cn(
            "bg-sidebar fixed inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden transition-all duration-300 ease-out md:static md:max-h-none md:shrink-0",
            editing
              ? "max-h-[42vh] translate-y-0 border-t md:w-[300px] md:translate-x-0 md:border-t-0 md:border-l"
              : "max-h-0 translate-y-full md:w-0 md:translate-x-full",
          )}
        >
            <div className="border-line-soft border-b px-4 pt-3.5 pb-2.5">
              <div className="text-[14px] font-medium">Add a widget</div>
              <p className="text-muted-foreground mt-0.5 text-[12.5px]">
                Every metric your connected plugins report. Click to place, drag
                on the canvas to reorder.
              </p>
              <div className="relative mt-2.5">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
                  strokeWidth={1.6}
                />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search metrics…"
                  className="h-8 pl-8 text-[13.5px]"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-3 pt-2.5 pb-6">
              {Object.entries(SOURCES).map(([srcId, src]) => {
                const needle = q.trim().toLowerCase();
                const items = Object.entries(WIDGETS).filter(
                  ([, def]) =>
                    def.src === srcId &&
                    (!needle ||
                      `${def.name} ${src.name}`.toLowerCase().includes(needle)),
                );
                if (!items.length) return null;

                return (
                  <div key={srcId} className="mb-3.5">
                    <div className="flex items-center gap-2 px-1 pt-1 pb-1.5">
                      <BrandTile
                        icon={src.icon}
                        name={src.name}
                        mono={src.mono}
                        tint={src.tint}
                        className="size-5 rounded-md"
                        glyphClassName="size-[11px] text-[10px]"
                      />
                      <span className="text-[12.5px]">{src.name}</span>
                      {!src.connected && (
                        <span className="text-muted-foreground ml-auto text-[11.5px]">
                          not connected
                        </span>
                      )}
                    </div>

                    {items.map(([key, def]) => {
                      const added = board.widgets.some((w) => w.type === key);
                      return (
                        <button
                          key={key}
                          disabled={!src.connected}
                          onClick={() =>
                            mutate((list) => [
                              ...list,
                              { id: uid("w"), type: key, w: defaultWidth(key) },
                            ])
                          }
                          className={cn(
                            "hover:bg-accent flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left text-[13.5px]",
                            added && "text-muted-foreground",
                            !src.connected && "pointer-events-none opacity-45",
                          )}
                        >
                          {widgetName(def, live.window)}
                          <span
                            className={cn(
                              "text-muted-foreground ml-auto text-[11.5px]",
                              added && "text-ok",
                            )}
                          >
                            {added ? "added" : def.kind}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/*
              COPY TO — the other half of the cross-pollination.

              The new-dashboard dialog can start FROM an existing board; this
              sends this one the other way, into another venture or into the
              global set. Same operation, two directions, and both are here
              because the arrangement is the work: an owner who has spent ten
              minutes building a Search board for one venture should not spend
              ten more building it again for the next.

              It copies rather than moves, deliberately. A board is an
              arrangement of catalog widgets, not a document — there is nothing
              to lose track of — and "move" would be the one version of this
              that can take a board away from a page somebody has bookmarked.
            */}
            {/*
              FOLDED, because the list is every venture. With nineteen of them
              the open list was seven hundred pixels of footer, and the widget
              catalog above it — the thing this panel is for — was left a
              hundred pixels to scroll in. One row until it is asked for, then
              a list that scrolls inside its own height.
            */}
            <div className="border-line-soft border-t px-4 py-2.5">
              <button
                type="button"
                onClick={() => setCopyOpen((v) => !v)}
                aria-expanded={copyOpen}
                className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 text-[12.5px] transition-colors"
              >
                <Copy className="size-3.5" strokeWidth={1.6} />
                Copy to…
                <span className="ml-auto text-[11.5px]">{copyOpen ? "hide" : `${copyTargets.length} places`}</span>
              </button>
              {copyOpen && (
                <div className="mt-1.5 flex max-h-[32vh] flex-col gap-px overflow-y-auto">
                  {copyTargets.map((target) => (
                    <button
                      key={target.id ?? "global"}
                      onClick={() => {
                        const copy = copyDashboard(board.id, {
                          ventureId: target.id,
                        });
                        if (copy)
                          navigate(pathFor(target.id, copy.slug), {
                            state: { editing: true },
                          });
                      }}
                      className="hover:bg-accent flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left text-[13.5px]"
                    >
                      {target.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/*
              DELETING THE BOARD LIVES HERE, at the foot of edit mode.

              It used to hide inside the rename dialog, which is a strange place
              to keep the one irreversible control on the page — you had to open
              a box called "Rename" to destroy something. Edit mode is where a
              board is changed, and removing it is the largest change there is,
              so it belongs at the bottom of the same panel: reachable, last,
              and out of the way of the thing people are actually doing up
              there.

              It asks first. Everything else in edit mode is undoable by hand —
              a removed widget goes back with one click — and this is not.
            */}
            <div className="border-line-soft border-t px-4 py-3">
              {confirmingDelete ? (
                <div className="flex flex-col gap-2">
                  <p className="text-[12.5px] leading-snug">
                    Delete <span className="font-medium">{board.name}</span> and
                    its {board.widgets.length}{" "}
                    {board.widgets.length === 1 ? "widget" : "widgets"}? The
                    widgets themselves are a catalog — only this arrangement of
                    them goes.
                  </p>
                  <div className="flex gap-1.5">
                    <Button
                      className="bg-destructive hover:bg-destructive/90 text-white"
                      onClick={() => {
                        const next = state.dashboards.find(
                          (d) =>
                            d.id !== board.id &&
                            (d.ventureId ?? null) === ventureId,
                        );
                        deleteDashboard(board.id);
                        navigate(next ? `${basePath}/${next.slug}` : homePath);
                      }}
                    >
                      Delete
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingDelete(true)}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px]"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.6} />
                  Delete this dashboard
                </button>
              )}
            </div>
        </aside>
      </div>

      {/* Renaming is now only renaming. Deleting moved into edit mode, where
          the rest of "change this board" lives — a destructive control filed
          under "Rename" was somewhere nobody would look for it and everybody
          could hit by accident. */}
      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        value={board.name}
        path={`${basePath}/${board.slug}`}
        onSave={(name) => renameDashboard(board.id, name)}
      />
    </>
  );
}

/**
 * Nothing to show, and the way out of it.
 *
 * THE CREATE BUTTON IS HERE BECAUSE THE ONE IN THE HEADER IS NOT. Every other
 * control on a dashboards page lives inside a board, so deleting the last one
 * used to be a one-way door: no board, no header, no way to make another
 * without editing localStorage. Now that a board can be deleted from edit mode
 * — the last one included — the empty state has to be a place you can leave.
 *
 * The list of boards that DO exist is the other half: somebody who followed a
 * dead link wants the way back more than they want the apology.
 */
export function NoBoard({
  title,
  body,
  boards = [],
  basePath,
}: {
  title: string;
  body: string;
  boards?: Dashboard[];
  basePath: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-[380px] text-center">
        <h1 className="text-[20px] font-normal tracking-[-0.02em]">{title}</h1>
        <p className="text-muted-foreground mt-1.5 text-[14px] leading-relaxed">
          {body}
        </p>

        <div className="mt-4 flex justify-center">
          <Button asChild>
            <Link to={`${basePath}/new`}>
              <Plus className="size-3.5" strokeWidth={1.8} />
              New dashboard
            </Link>
          </Button>
        </div>

        {boards.length > 0 && (
          <div className="mt-4 flex flex-wrap justify-center gap-1.5">
            {boards.map((d) => (
              <Link
                key={d.id}
                to={`${basePath}/${d.slug}`}
                className="hover:bg-accent rounded-lg border px-2.5 py-1.5 text-[13.5px]"
              >
                {d.name}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  value,
  path,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  value: string;
  path: string;
  onSave: (name: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        {open && (
          <RenameForm
            value={value}
            path={path}
            onSave={onSave}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  value,
  path,
  onSave,
  onDone,
}: {
  value: string;
  path: string;
  onSave: (name: string) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(value);

  function save() {
    if (!name.trim()) return;
    onSave(name.trim());
    onDone();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename dashboard</DialogTitle>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="rename-board">Name</Label>
        <Input
          id="rename-board"
          value={name}
          autoFocus
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        {/* The address is shown but not edited: it was fixed when the board
            was made, and it stays put so a bookmark survives a rename. */}
        <p className="text-muted-foreground text-[12.5px]">
          Lives at <span className="tabular-nums">{path}</span> — renaming does
          not move it.
        </p>
      </div>
      <DialogFooter className="sm:justify-start">
        <Button onClick={save} disabled={!name.trim()}>
          Save
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </DialogFooter>
    </>
  );
}
