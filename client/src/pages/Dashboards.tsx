import { useMemo, useState } from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Plus, Search, Trash2 } from "lucide-react";
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
import { TabStrip } from "@/components/TabStrip";
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

/** 1 → 2 → 4 → 1. Four is the full width of the grid. */
function nextWidth(w: 1 | 2 | 4): 1 | 2 | 4 {
  return w === 1 ? 2 : w === 2 ? 4 : 1;
}

/**
 * THE URL IS THE SELECTION.
 *
 * There is no "which tab is open" state beside the address to fall out of step
 * with it: the bar holds the answer, which is what makes a board linkable,
 * bookmarkable and reachable with the back button.
 *
 * A slug that names nothing is NOT quietly redirected to the first board. A
 * stale bookmark, or a board somebody deleted, is worth being told about —
 * showing a different dashboard's numbers under the URL you asked for is the
 * worst of the answers available.
 *
 * This resolves the address and nothing else; the board itself is a component
 * below, so every hook it holds sits under a board that certainly exists.
 */
export function Dashboards() {
  const { state } = useStore();
  const { slug } = useParams();

  const board = state.dashboards.find((d) => d.slug === slug);
  const first = state.dashboards[0];

  // The bare /dashboards: land on the first board and put its own address in
  // the bar, replacing rather than pushing so Back still leaves the page.
  if (!slug)
    return first ? (
      <Navigate to={`/dashboards/${first.slug}`} replace />
    ) : (
      <Empty
        title="No dashboards yet"
        body="Create one and it gets its own address."
      />
    );

  if (!board)
    return (
      <Empty
        title="No dashboard at this address"
        body={`Nothing here is called “${slug}”. It may have been deleted, or the link may be from another workspace.`}
        boards={state.dashboards}
      />
    );

  // Keyed by board: switching dashboards ends an edit session rather than
  // carrying a half-open widget panel across to a different board.
  return <Board key={board.id} board={board} />;
}

function Board({ board }: { board: Dashboard }) {
  const {
    state,
    addDashboard,
    renameDashboard,
    deleteDashboard,
    reorderDashboards,
    setWidgets,
  } = useStore();
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
  const [creating, setCreating] = useState(false);
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

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 px-4.5">
        {/* Links, not buttons: each tab IS the board's address. Hold and drag
            to reorder — the order lives in the store beside the boards. */}
        <TabStrip
          tabs={state.dashboards.map((d) => ({
            key: d.id,
            to: `/dashboards/${d.slug}`,
            label: d.name,
            count: d.widgets.length,
          }))}
          activeKey={board.id}
          onReorder={reorderDashboards}
        />
        <button
          onClick={() => setCreating(true)}
          className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]"
        >
          <Plus className="size-3.5" strokeWidth={1.6} />
          New dashboard
        </button>
      </header>

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
                        const next = state.dashboards.find((d) => d.id !== board.id);
                        deleteDashboard(board.id);
                        navigate(next ? `/dashboards/${next.slug}` : "/dashboards");
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

      <NewDashboardDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={(name, preset) => {
          const b = addDashboard(name, preset);
          navigate(`/dashboards/${b.slug}`, { state: { editing: true } });
        }}
      />

      {/* Renaming is now only renaming. Deleting moved into edit mode, where
          the rest of "change this board" lives — a destructive control filed
          under "Rename" was somewhere nobody would look for it and everybody
          could hit by accident. */}
      <RenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        value={board.name}
        slug={board.slug}
        onSave={(name) => renameDashboard(board.id, name)}
      />
    </>
  );
}

/**
 * Nothing to show, and why.
 *
 * The list of boards that DO exist is the useful half: somebody who followed a
 * dead link wants the way back more than they want the apology.
 */
/**
 * Nothing to show, and the way out of it.
 *
 * THE CREATE BUTTON IS HERE BECAUSE THE ONE IN THE HEADER IS NOT. Every other
 * control on this page lives inside a board, so deleting the last one used to
 * be a one-way door: no board, no header, no way to make another without
 * editing localStorage. Now that a board can be deleted from edit mode — the
 * last one included — the empty state has to be a place you can leave.
 *
 * The list of boards that DO exist is the other half: somebody who followed a
 * dead link wants the way back more than they want the apology.
 */
function Empty({
  title,
  body,
  boards = [],
}: {
  title: string;
  body: string;
  boards?: Dashboard[];
}) {
  const { addDashboard } = useStore();
  const navigate = useNavigate();
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
          onCreate={(name, preset) => {
            const b = addDashboard(name, preset);
            navigate(`/dashboards/${b.slug}`, { state: { editing: true } });
          }}
        />

        {boards.length > 0 && (
          <div className="mt-4 flex flex-wrap justify-center gap-1.5">
            {boards.map((d) => (
              <Link
                key={d.id}
                to={`/dashboards/${d.slug}`}
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

function NewDashboardDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreate: (name: string, preset: string) => void;
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
  onCreate: (name: string, preset: string) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("blank");

  function create() {
    if (!name.trim()) return;
    onCreate(name.trim(), preset);
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
          <div className="flex flex-col gap-px">
            {DASHBOARD_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                className="hover:bg-accent flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-[12.5px]"
              >
                {p.label}
                <span
                  className={cn(
                    "text-muted-foreground ml-auto text-[10.5px]",
                    p.id === preset && "text-ok",
                  )}
                >
                  {p.id === preset ? "✓" : p.note}
                </span>
              </button>
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
  slug,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  value: string;
  slug: string;
  onSave: (name: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        {open && (
          <RenameForm
            value={value}
            slug={slug}
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
  slug,
  onSave,
  onDone,
}: {
  value: string;
  slug: string;
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
          Lives at <span className="tabular-nums">/dashboards/{slug}</span> —
          renaming does not move it.
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
