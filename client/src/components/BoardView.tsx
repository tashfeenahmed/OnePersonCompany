import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Copy, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandTile } from "@/components/BrandTile";
import { WidgetCard } from "@/components/WidgetCard";
import { cn } from "@/lib/utils";
import {
  defaultWidth,
  uid,
  useStore,
  type Dashboard,
  type PlacedWidget,
} from "@/lib/store";
import { ago, collectedAt, useLive } from "@/lib/live";
import { DASHBOARD_PRESETS, SOURCES, WIDGETS } from "@/data/widgets";

/**
 * ONE DASHBOARD, WHEREVER IT LIVES.
 *
 * This was the `Board` component inside pages/Dashboards.tsx, and it moved
 * here the day a venture got dashboards of its own. There are two pages now —
 * the global set at /dashboards/<board> and a venture's at
 * /ventures/<slug>/dashboards/<board> — and they are the SAME BOARD: the same
 * grid, the same edit panel, the same drag, the same delete. Two copies of
 * five hundred lines would have diverged on the first fix.
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
   *  "scoped to support.example.test", or why they were not. */
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
  const [q, setQ] = useState("");
  const [renaming, setRenaming] = useState(false);
  // Reset with the board, so leaving edit mode or switching boards never
  // returns you to a half-armed delete.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    side: "before" | "after";
  } | null>(null);

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

  function drop(targetId: string) {
    if (!dragId || dragId === targetId || !dropTarget) return;
    const list = [...board.widgets];
    const from = list.findIndex((w) => w.id === dragId);
    const [moved] = list.splice(from, 1);
    const to =
      list.findIndex((w) => w.id === targetId) +
      (dropTarget.side === "after" ? 1 : 0);
    list.splice(to, 0, moved);
    setWidgets(board.id, list);
    setDragId(null);
    setDropTarget(null);
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
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-6 pt-2 pb-20">
          <div className="mx-auto w-full max-w-[1040px]">
            <div className="mt-2 mb-5 flex items-end gap-3">
              <div>
                <h1 className="mb-1 text-[25px] font-normal tracking-[-0.025em]">
                  {board.name}
                </h1>
                <p className="text-muted-foreground text-[13.5px]">
                  {`${board.widgets.length} ${board.widgets.length === 1 ? "widget" : "widgets"} from ${sources} ${sources === 1 ? "service" : "services"}`}
                  {liveHere > 0 && (
                    <>
                      {" · "}
                      <span className="text-ok">{liveHere} live</span>
                      {freshness ?? ""}
                    </>
                  )}
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

            <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
              {!board.widgets.length && (
                <div className="text-muted-foreground col-span-full rounded-[10px] border border-dashed px-5 py-11 text-center">
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
                    draggable: editing,
                    onDragStart: () => setDragId(w.id),
                    onDragEnd: () => {
                      setDragId(null);
                      setDropTarget(null);
                    },
                    onDragOver: (e) => {
                      if (!dragId || dragId === w.id) return;
                      e.preventDefault();
                      const r = e.currentTarget.getBoundingClientRect();
                      setDropTarget({
                        id: w.id,
                        side:
                          e.clientX > r.left + r.width / 2 ? "after" : "before",
                      });
                    },
                    onDrop: (e) => {
                      e.preventDefault();
                      drop(w.id);
                    },
                  }}
                />
              ))}

              {editing && (
                <button
                  onClick={() => setEditing(true)}
                  className="text-muted-foreground hover:border-line-strong hover:text-foreground flex min-h-[116px] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed text-[12.5px]"
                >
                  <Plus className="size-4" strokeWidth={1.6} />
                  Add widget
                </button>
              )}
            </div>
          </div>
        </div>

        {editing && (
          <aside className="bg-sidebar flex w-[300px] shrink-0 flex-col border-l">
            <div className="border-line-soft border-b px-4 pt-3.5 pb-2.5">
              <div className="text-[13px] font-medium">Add a widget</div>
              <p className="text-muted-foreground mt-0.5 text-[11.5px]">
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
                  className="h-8 pl-8 text-[12.5px]"
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
                        glyphClassName="size-[11px] text-[9px]"
                      />
                      <span className="text-[11.5px]">{src.name}</span>
                      {!src.connected && (
                        <span className="text-muted-foreground ml-auto text-[10.5px]">
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
                            "hover:bg-accent flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px]",
                            added && "text-muted-foreground",
                            !src.connected && "pointer-events-none opacity-45",
                          )}
                        >
                          {def.name}
                          <span
                            className={cn(
                              "text-muted-foreground ml-auto text-[10.5px]",
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
            <div className="border-line-soft border-t px-4 py-3">
              <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-[11.5px]">
                <Copy className="size-3.5" strokeWidth={1.6} />
                Copy to
              </div>
              <div className="flex flex-col gap-px">
                {[
                  { id: null as string | null, name: "Global dashboards" },
                  ...state.ventures.map((v) => ({ id: v.id as string | null, name: v.name })),
                ]
                  .filter((target) => target.id !== ventureId)
                  .map((target) => (
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
                      className="hover:bg-accent flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px]"
                    >
                      {target.name}
                    </button>
                  ))}
              </div>
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
                  <p className="text-[11.5px] leading-snug">
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
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px]"
                >
                  <Trash2 className="size-3.5" strokeWidth={1.6} />
                  Delete this dashboard
                </button>
              )}
            </div>
          </aside>
        )}
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
  onCreate,
}: {
  title: string;
  body: string;
  boards?: Dashboard[];
  basePath: string;
  onCreate: (name: string, presetId: string | null, copyFromId: string | null) => void;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-[380px] text-center">
        <h1 className="text-[19px] font-normal tracking-[-0.02em]">{title}</h1>
        <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">
          {body}
        </p>

        <div className="mt-4 flex justify-center">
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-3.5" strokeWidth={1.8} />
            New dashboard
          </Button>
        </div>

        <NewDashboardDialog
          open={creating}
          onOpenChange={setCreating}
          onCreate={onCreate}
        />

        {boards.length > 0 && (
          <div className="mt-4 flex flex-wrap justify-center gap-1.5">
            {boards.map((d) => (
              <Link
                key={d.id}
                to={`${basePath}/${d.slug}`}
                className="hover:bg-accent rounded-lg border px-2.5 py-1.5 text-[12.5px]"
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

export function NewDashboardDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Exactly one of `presetId` and `copyFromId` is given. */
  onCreate: (name: string, presetId: string | null, copyFromId: string | null) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        {open && (
          <NewDashboardForm
            onCreate={onCreate}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewDashboardForm({
  onCreate,
  onDone,
}: {
  onCreate: (name: string, presetId: string | null, copyFromId: string | null) => void;
  onDone: () => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  /* One selection, two kinds of thing: a preset id, or "copy:<board id>". A
     single piece of state because they are one choice — "start from" — and two
     would let both be set at once. */
  const [from, setFrom] = useState("blank");

  const copyId = from.startsWith("copy:") ? from.slice(5) : null;

  /*
    EVERY BOARD THAT EXISTS, GROUPED BY WHERE IT LIVES. The global set first
    because it is the one everybody has, then a group per venture in the
    owner's own order. A venture with no boards is not drawn: an empty heading
    is a row that says nothing.
  */
  const groups = [
    { key: "global", name: "Global", boards: state.dashboards.filter((d) => !d.ventureId) },
    ...state.ventures.map((v) => ({
      key: v.id,
      name: v.name,
      boards: state.dashboards.filter((d) => d.ventureId === v.id),
    })),
  ].filter((g) => g.boards.length);

  function create() {
    if (!name.trim()) return;
    onCreate(name.trim(), copyId ? null : from, copyId);
    onDone();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New dashboard</DialogTitle>
        <DialogDescription>
          Widgets come from whatever plugins are connected.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="board-name">Name</Label>
          <Input
            id="board-name"
            value={name}
            autoFocus
            autoComplete="off"
            placeholder="Morning check"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
        </div>

        <div className="grid gap-1.5">
          <Label>Start from</Label>
          <div className="flex max-h-[260px] flex-col gap-px overflow-y-auto">
            {DASHBOARD_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setFrom(p.id)}
                className="hover:bg-accent flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px]"
              >
                {p.label}
                <span
                  className={cn(
                    "text-muted-foreground ml-auto text-[10.5px]",
                    p.id === from && "text-ok",
                  )}
                >
                  {p.id === from ? "✓" : p.note}
                </span>
              </button>
            ))}

            {/*
              COPY AN EXISTING DASHBOARD — the cross-pollination, from this end.

              A board is an arrangement, and an arrangement that took ten
              minutes to get right is worth more than the widgets in it. Being
              able to say "the same as Example Video's Search board, but for
              this one" is the difference between a venture getting a proper
              board and getting whatever somebody had the patience to rebuild.
            */}
            {groups.map((g) => (
              <div key={g.key}>
                <div className="text-muted-foreground px-2 pt-2.5 pb-1 text-[10.5px]">
                  {g.name}
                </div>
                {g.boards.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      setFrom(`copy:${d.id}`);
                      // A copy with no name of its own takes the source's,
                      // which is what somebody copying a board nearly always
                      // wants and can still type over.
                      if (!name.trim()) setName(d.name);
                    }}
                    className="hover:bg-accent flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px]"
                  >
                    {d.name}
                    <span
                      className={cn(
                        "text-muted-foreground ml-auto text-[10.5px]",
                        copyId === d.id && "text-ok",
                      )}
                    >
                      {copyId === d.id
                        ? "✓"
                        : `${d.widgets.length} widget${d.widgets.length === 1 ? "" : "s"}`}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <DialogFooter className="sm:justify-start">
        <Button onClick={create} disabled={!name.trim()}>
          Create
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </DialogFooter>
    </>
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
        <p className="text-muted-foreground text-[11.5px]">
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
