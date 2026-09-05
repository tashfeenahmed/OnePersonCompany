import { useState } from "react";
import { Archive, Plus, Trash2 } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/hooks/useApi";
import {
  api,
  type BoardCard,
  type BoardCardPatch,
  type BoardColumn,
  type BoardDoc,
} from "@/lib/api";
import { useStore, type Venture } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * THE BOARD — the work, laid out sideways.
 *
 * The first app here that is a PLACE TO PUT THINGS rather than a window onto
 * something a collector fetched. Email and Email stats both draw somebody
 * else's data; every card on this page is one the owner typed, and losing one
 * is losing work. That difference is why the rules below are what they are.
 *
 * THE PAGE DOES NOT SCROLL — three things inside it do. The header is fixed,
 * the row of columns scrolls sideways, and each column scrolls itself. A board
 * is the one layout in this app that is wider than any window AND taller than
 * one, and letting either dimension escape into the document would take the
 * sidebar and every other page's alignment with it. The columns are held by
 * flex rather than `position: sticky`: a column is a header that cannot shrink,
 * a card list that is `flex-1 min-h-0 overflow-y-auto`, and a footer that
 * cannot shrink. Sticky would need a scroll container to stick inside and a
 * z-index to win against the cards passing under it; this needs neither, and it
 * cannot come unstuck at a width nobody tested.
 *
 * DRAG STATE LIVES HERE, ON THE PAGE, AND IT HAS TO. A drag crosses columns,
 * and a column cannot see its neighbour: the card being carried starts in one
 * component and is dropped in another, so the only place that can know both
 * ends is the thing that renders both. Every column is handed the drag id and
 * the current drop point and reports back; none of them owns either. This is
 * also why the drop indicator is drawn by the column and decided by the page —
 * two columns each deciding where the line goes is two lines.
 *
 * NATIVE HTML5 DRAG AND DROP, the same machinery the dashboard's widgets use
 * (`Dashboards.tsx` — `dragHandlers`, `dropTarget`, before/after). No library:
 * the whole interaction is `draggable`, four handlers and a `preventDefault`
 * that most of a page's weight would otherwise be spent re-implementing.
 *
 * OPTIMISTIC, AND THE REPLY REPLACES THE GUESS. A drop repaints on the same
 * frame with a locally-spliced board, sends the move, and then throws the
 * guess away in favour of the document the server answers with. It is thrown
 * away rather than reconciled because the server's board is the record and the
 * guess was only ever a guess — a move can renumber cards nobody touched, and
 * a client that merged its guess into the reply would be maintaining a second
 * opinion about where things are. A refused move puts the previous board back
 * and says, in a sentence at the top, what the server said. Never a silent
 * revert: a card that slides back on its own reads as a bug in the drag.
 *
 * A FILTERED BOARD IS STILL A DRAGGABLE BOARD HERE, which is the opposite of
 * what workdash's board does, and the difference is the wire format rather
 * than a change of mind. Its drop sends `{column, index}`, and an index
 * counted over a list with rows hidden inside it is a lie — so it turns
 * dragging off while a search is on. This one sends `{columnId, before}`,
 * naming the CARD to land above. A hidden card cannot make "above that card"
 * mean somewhere else: the card lands exactly where the indicator promised,
 * with whatever is filtered out staying where it already was.
 *
 * WHAT IS DELIBERATELY NOT HERE. No column can be created or deleted — the
 * five the server seeds are the board, and the API has no route for either.
 * Columns are not reorderable by drag on this page yet, though the route and
 * the client call for it exist. And nothing files a card by itself: workdash's
 * board has a backlog filer, an issue ranking and a gardening sweep writing
 * cards into it, and none of that is ported. Those cards come from collectors
 * that read other people's systems; these are the owner's own. The seam is a
 * nullable `origin` on the server (see routes/board.ts) and nothing else.
 */
export function Board() {
  const { state } = useStore();
  const { data, error, loading, setData, reload } = useApi(() => api.board(), []);

  /* WHICH VENTURE'S WORK IS SHOWING — null is "all of it". A venture id
     rather than an index, so the filter survives a venture being renamed and
     falls back to All when one is deleted. */
  const [venture, setVenture] = useState<string | null>(null);

  /* THE DRAG, held here because a drag crosses columns — see the header.
     `drag` is the card being carried; `drop` is where it would land, said as
     "in this column, above this card" (or at the foot, when `before` is
     null) — the exact pair the move endpoint takes, so nothing has to be
     translated at the moment of the drop. */
  const [drag, setDrag] = useState<number | null>(null);
  const [drop, setDrop] = useState<{ columnId: number; before: number | null } | null>(
    null,
  );

  /** The last refused write, in the server's own words. Cleared by the next
   *  successful one, and dismissible — it describes a moment, not a state. */
  const [refused, setRefused] = useState<string | null>(null);

  /** The card whose dialog is open, by id. By id rather than by value, so the
   *  dialog redraws from the board after a save instead of holding a copy that
   *  the reply has already superseded. */
  const [opened, setOpened] = useState<number | null>(null);

  const ventures = new Map(state.ventures.map((v) => [v.id, v]));

  /**
   * Every write on this page goes through here.
   *
   * `optimistic` is the board as it would look if the write lands. Pass one
   * for a move, where the whole point is that the card is under the cursor on
   * the same frame; leave it out for a create or an edit, which happen at the
   * speed of a keystroke on a local API and would only flicker.
   *
   * The reply is the new state, whole. The failure path puts back exactly what
   * was there before rather than trying to undo the guess step by step — the
   * board is one object, and restoring it is one assignment.
   */
  async function mutate(call: () => Promise<BoardDoc>, optimistic?: BoardDoc) {
    const previous = data;
    if (optimistic) setData(optimistic);
    try {
      setData(await call());
      setRefused(null);
    } catch (e) {
      if (optimistic) setData(previous);
      setRefused(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Where the line is, set without repainting the board for saying so twice.
   *
   * `dragover` fires continuously — dozens of times a second while the pointer
   * sits still over one card — and every one of them would otherwise hand
   * React a new object and redraw all five columns. The comparison is the
   * whole optimisation: a drop point that has not changed is not a state
   * change, and a drag over a long column stays smooth because of it.
   */
  function pointAt(columnId: number, before: number | null) {
    setDrop((prev) =>
      prev && prev.columnId === columnId && prev.before === before
        ? prev
        : { columnId, before },
    );
  }

  function onDrop(columnId: number, before: number | null) {
    const id = drag;
    setDrag(null);
    setDrop(null);
    if (id === null || !data) return;
    /* Dropped on itself: nothing to say and nothing to send. The server
       answers this with the board unchanged, but a request for a no-op is a
       request that can fail for no reason. */
    if (before === id) return;
    void mutate(
      () => api.boardMoveCard(id, columnId, before),
      applyMove(data, id, columnId, before),
    );
  }

  /* ---- the three states this page actually has, before any board is drawn */

  if (error)
    return (
      <Empty
        title="The board cannot be read"
        body={`${error}. The API holds every card, so there is nothing to show from here — not even an empty board, which would be a claim rather than a fact.`}
        action={
          <Button variant="outline" onClick={reload}>
            Try again
          </Button>
        }
      />
    );

  if (!data)
    return (
      <Empty
        title="Reading the board…"
        body={loading ? "One request, for every column and every card on it." : ""}
      />
    );

  const cards = data.columns.flatMap((c) => c.cards);
  const openedCard = opened === null ? null : cards.find((c) => c.id === opened) ?? null;
  const filed = cards.filter((c) => c.ventureId && ventures.has(c.ventureId)).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-4 pb-3.5">
        <div className="flex items-end gap-3">
          <div>
            <h1 className="mb-1 text-[25px] font-normal tracking-[-0.025em]">Board</h1>
            <p className="text-muted-foreground text-[13.5px]">
              {data.totals.cards === 0
                ? "Nothing on it yet."
                : `${data.totals.cards} ${data.totals.cards === 1 ? "card" : "cards"} · ${data.totals.done} done · ${filed} filed under a venture`}
              {data.totals.archived > 0 && (
                <>
                  {" · "}
                  <span title="Archived cards are kept and left out of every column. There is no route that reads them back yet.">
                    {data.totals.archived} archived
                  </span>
                </>
              )}
            </p>
          </div>
        </div>

        {/* THE VENTURE FILTER. Chips rather than a dropdown: there are a
            handful of ventures, the answer is worth having on screen, and a
            colour is only useful if it is visible before it is chosen. The
            colours are the store's own, which is what makes a chip here and a
            chip on a card the same fact. */}
        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <Chip active={venture === null} onClick={() => setVenture(null)}>
            All
          </Chip>
          {state.ventures.map((v) => (
            <Chip
              key={v.id}
              active={venture === v.id}
              onClick={() => setVenture(venture === v.id ? null : v.id)}
            >
              <span
                className="size-[7px] shrink-0 rounded-[2px]"
                style={{ background: v.color }}
              />
              {v.name}
            </Chip>
          ))}
        </div>

        {/* A REFUSED WRITE SAYS SO, IN THE SERVER'S OWN WORDS. The board has
            already gone back to what it was; without this line the only
            visible event is a card sliding home, which reads as a bug in the
            drag rather than as an answer. */}
        {refused && (
          <div className="border-destructive/30 bg-destructive/5 text-destructive mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]">
            <span className="min-w-0 flex-1">
              That did not save, so the board is as it was. {refused}
            </span>
            <button
              onClick={() => setRefused(null)}
              className="shrink-0 opacity-70 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* The lanes. This row is the only thing on the page that scrolls
          sideways, and `min-h-0` is what lets each lane scroll itself rather
          than growing the row. */}
      <div className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto px-6 pb-6">
        {data.columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            ventures={ventures}
            filter={venture}
            /* The whole board is empty, as against this column being empty —
               two different sentences, and only the first one is worth an
               explanation of what a board is. */
            boardEmpty={data.totals.cards === 0}
            drag={drag}
            drop={drop?.columnId === column.id ? drop.before : undefined}
            onDragStart={setDrag}
            onDragEnd={() => {
              setDrag(null);
              setDrop(null);
            }}
            onDragOver={(before) => pointAt(column.id, before)}
            onDrop={(before) => onDrop(column.id, before)}
            onOpen={setOpened}
            onAdd={(title) =>
              mutate(() =>
                api.boardAddCard({
                  title,
                  column: column.id,
                  /* A card added while a venture is being looked at belongs to
                     that venture. Anything else means typing the filter's own
                     answer in again, and a card filed nowhere would vanish from
                     the board the moment it was created. */
                  ventureId: venture,
                }),
              )
            }
            onRename={(title) => mutate(() => api.boardEditColumn(column.id, { title }))}
            onLimit={(wipLimit) =>
              mutate(() => api.boardEditColumn(column.id, { wipLimit }))
            }
          />
        ))}
      </div>

      <Dialog open={openedCard !== null} onOpenChange={(o) => !o && setOpened(null)}>
        <DialogContent className="sm:max-w-[480px]">
          {/* Mounted only while it is open, and keyed on the card, so the form
              initialises from the card once. An effect that reset the fields on
              every open would also reset them under the owner's hands the
              moment a reply arrived. */}
          {openedCard && (
            <CardForm
              key={openedCard.id}
              card={openedCard}
              columns={data.columns}
              ventures={state.ventures}
              onSave={async (patch) => {
                await mutate(() => api.boardEditCard(openedCard.id, patch));
                setOpened(null);
              }}
              onArchive={async () => {
                await mutate(() => api.boardArchiveCard(openedCard.id));
                setOpened(null);
              }}
              onDelete={async () => {
                await mutate(() => api.boardDeleteCard(openedCard.id));
                setOpened(null);
              }}
              onCancel={() => setOpened(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ====================================================================== */
/*  The optimistic move                                                   */
/* ====================================================================== */

/**
 * The board as it will look, computed locally, for the tenth of a second
 * before the server's own answer replaces it.
 *
 * IT IS NOT A REIMPLEMENTATION OF THE SERVER'S RULES AND MUST NOT BECOME ONE.
 * It splices one card out of one array and into another, and it keeps the two
 * derived numbers on a column — the count and whether that count is over the
 * limit — in step, because those are drawn right beside the cards it just
 * moved and a stale count is a visible lie. Positions are NOT recomputed:
 * every list here is already in order and stays in order under a splice, so
 * nothing on this page ever sorts by `position` and nothing has to guess at
 * what number a card would be given.
 *
 * `doneAt` is the one field it does set, because Done is the one column whose
 * name is also a claim about the card. Arriving stamps it (keeping an existing
 * stamp — re-ordering within Done is not finishing something twice) and
 * leaving clears it, which is exactly what the server does.
 */
function applyMove(
  doc: BoardDoc,
  id: number,
  columnId: number,
  before: number | null,
): BoardDoc {
  const card = doc.columns.flatMap((c) => c.cards).find((c) => c.id === id);
  if (!card) return doc;

  const columns = doc.columns.map((column) => {
    let list = column.cards.filter((c) => c.id !== id);
    if (column.id === columnId) {
      const found = before === null ? -1 : list.findIndex((c) => c.id === before);
      const at = found < 0 ? list.length : found;
      const moved: BoardCard = {
        ...card,
        columnId,
        doneAt:
          column.key === "done" ? (card.doneAt ?? new Date().toISOString()) : null,
      };
      list = [...list.slice(0, at), moved, ...list.slice(at)];
    }
    return {
      ...column,
      cards: list,
      count: list.length,
      overLimit: column.wipLimit !== null && list.length > column.wipLimit,
    };
  });

  return {
    ...doc,
    columns,
    totals: {
      ...doc.totals,
      done: columns
        .filter((c) => c.key === "done")
        .reduce((n, c) => n + c.cards.length, 0),
    },
  };
}

/* ====================================================================== */
/*  A lane                                                                */
/* ====================================================================== */

function Column({
  column,
  ventures,
  filter,
  boardEmpty,
  drag,
  drop,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onOpen,
  onAdd,
  onRename,
  onLimit,
}: {
  column: BoardColumn;
  ventures: Map<string, Venture>;
  filter: string | null;
  boardEmpty: boolean;
  /** The card being carried, anywhere on the board. */
  drag: number | null;
  /** Where the line goes IN THIS LANE: above this card, at the foot when
   *  null, and nowhere at all when undefined (the drag is over another lane). */
  drop: number | null | undefined;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onDragOver: (before: number | null) => void;
  onDrop: (before: number | null) => void;
  onOpen: (id: number) => void;
  onAdd: (title: string) => void;
  onRename: (title: string) => void;
  onLimit: (limit: number | null) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.title);
  const [limiting, setLimiting] = useState(false);

  /* WHAT THIS LANE IS SHOWING, which is not always what it HOLDS. The filter
     hides cards; the count in the header is the column's own, from the server,
     because "3 in Doing" is a fact about the work rather than about the filter
     somebody has on. When the two disagree the header says so — a lane reading
     "3" over one visible card is otherwise just wrong. */
  const shown = filter
    ? column.cards.filter((c) => c.ventureId === filter)
    : column.cards;
  const hidden = column.cards.length - shown.length;

  /** The next visible card after this one, which is what "drop below this
   *  card" means in the wire's own vocabulary. The dragged card is skipped
   *  because it is about to leave wherever it is. */
  function after(index: number): number | null {
    for (let i = index + 1; i < shown.length; i++) {
      const next = shown[i]!;
      if (next.id !== drag) return next.id;
    }
    return null;
  }

  function commitRename() {
    const next = name.trim();
    setRenaming(false);
    if (!next || next === column.title) return setName(column.title);
    onRename(next);
  }

  return (
    <section
      className="bg-secondary/50 dark:bg-card/40 flex h-full min-h-0 w-[276px] shrink-0 flex-col rounded-[10px] border"
      /* THE LANE IS THE DROP TARGET OF LAST RESORT. Without a
         `preventDefault` somewhere the browser refuses the drop outright, and
         this is also what makes the empty space under the last card mean "the
         foot of this column" rather than nothing. Cards stop their own events
         from reaching here, so their more precise answer wins. */
      onDragOver={(e) => {
        if (drag === null) return;
        e.preventDefault();
        onDragOver(null);
      }}
      onDrop={(e) => {
        if (drag === null) return;
        e.preventDefault();
        onDrop(drop === undefined ? null : drop);
      }}
    >
      <header className="flex shrink-0 items-center gap-1.5 px-2.5 py-2">
        {renaming ? (
          <Input
            value={name}
            autoFocus
            aria-label={`Rename ${column.title}`}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setName(column.title);
                setRenaming(false);
              }
            }}
            className="h-6 px-1.5 text-[12.5px]"
          />
        ) : (
          <button
            onClick={() => {
              setName(column.title);
              setRenaming(true);
            }}
            title="Rename this column"
            className="truncate text-[12.5px] font-medium tracking-tight"
          >
            {column.title}
          </button>
        )}

        <span className="text-muted-foreground ml-auto shrink-0 text-[11.5px]">
          {hidden > 0 ? `${shown.length} of ${column.count}` : column.count}
        </span>

        {/* THE WIP LIMIT, and null is not zero. No limit draws nothing at all;
            a limit draws "/ n" and turns warn when the column is over it. A
            limit of 0 is a column that should hold nothing, which is a real
            instruction and reads correctly here as "0/0 over". */}
        {limiting ? (
          <Input
            type="number"
            min={0}
            autoFocus
            defaultValue={column.wipLimit ?? ""}
            aria-label={`WIP limit for ${column.title}`}
            onBlur={(e) => {
              setLimiting(false);
              const raw = e.target.value.trim();
              const next = raw === "" ? null : Number(raw);
              if (next !== null && (!Number.isInteger(next) || next < 0)) return;
              if (next !== column.wipLimit) onLimit(next);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = String(column.wipLimit ?? "");
                setLimiting(false);
              }
            }}
            className="h-6 w-12 shrink-0 px-1.5 text-[11.5px]"
          />
        ) : (
          <button
            onClick={() => setLimiting(true)}
            title={
              column.wipLimit === null
                ? "No limit on this column. Click to set one — it is never enforced, only reported."
                : `At most ${column.wipLimit}. Clear the box to remove the limit.`
            }
            className={cn(
              "shrink-0 rounded-md px-1 text-[11.5px]",
              column.overLimit ? "text-warn font-medium" : "text-muted-foreground/60",
            )}
          >
            {column.wipLimit === null ? "limit" : `/ ${column.wipLimit}`}
          </button>
        )}
      </header>

      {/* The only part of a lane that scrolls. Everything above and below it is
          `shrink-0`, so forty cards never take the column's name off screen. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-2"
        /* A DRAG CANNOT SCROLL A LIST BY ITSELF, so holding a card near an
           edge nudges it. Without this, a drop point below the fold is
           unreachable: the card is held by the pointer, the wheel is doing
           something else, and the list simply does not move.

           On CAPTURE, so it runs on the way down and the cards' own
           `stopPropagation` cannot swallow it. It neither prevents anything
           nor stops anything itself — it moves the scroll and lets the event
           carry on to whoever was going to answer it. A lane with nothing to
           scroll has no edges to be near, which is what the first line
           checks: without it a short lane's two 56px zones overlap and every
           point in it means "scroll up". */
        onDragOverCapture={(e) => {
          if (drag === null) return;
          const el = e.currentTarget;
          if (el.scrollHeight <= el.clientHeight) return;
          const r = el.getBoundingClientRect();
          const EDGE = 56;
          if (e.clientY < r.top + EDGE) el.scrollTop -= 14;
          else if (e.clientY > r.bottom - EDGE) el.scrollTop += 14;
        }}
      >
        {shown.map((card, i) => (
          <div key={card.id}>
            {drop === card.id && <Insertion />}
            <CardTile
              card={card}
              venture={card.ventureId ? ventures.get(card.ventureId) : undefined}
              dragging={drag === card.id}
              onOpen={() => onOpen(card.id)}
              onDragStart={() => onDragStart(card.id)}
              onDragEnd={onDragEnd}
              onDragOver={(below) => onDragOver(below ? after(i) : card.id)}
              onDrop={(below) => onDrop(below ? after(i) : card.id)}
            />
            {i === shown.length - 1 && drop === null && <Insertion />}
          </div>
        ))}

        {!shown.length && (
          <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-6 text-center text-[12px] leading-relaxed">
            {drop === null && drag !== null ? (
              "Drop it here"
            ) : hidden > 0 ? (
              `Nothing here for this venture. ${hidden} ${hidden === 1 ? "card" : "cards"} hidden by the filter.`
            ) : boardEmpty && column.key === "backlog" ? (
              <>
                Nothing on the board yet. Type the first card below — it lands
                here, and you drag it right as it gets done.
              </>
            ) : (
              "Empty."
            )}
          </div>
        )}
      </div>

      {/* THE COMPOSER, at the FOOT of the lane, because that is where the card
          is going to appear. An "add" at the top would put the new card at the
          other end of the column from the button that made it. */}
      <div className="shrink-0 px-2 pt-1 pb-2">
        {adding ? (
          <Input
            value={title}
            autoFocus
            placeholder="What needs doing?"
            aria-label={`Add a card to ${column.title}`}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const next = title.trim();
                if (!next) return setAdding(false);
                onAdd(next);
                /* The box stays open and empties itself: adding cards is
                   something done in threes, and a form that closed after each
                   one would be a click between every thought. */
                setTitle("");
              }
              if (e.key === "Escape") {
                setTitle("");
                setAdding(false);
              }
            }}
            onBlur={() => {
              /* A half-typed title is not thrown away on a blur — it is saved,
                 because the alternative is losing something the owner typed to
                 a click on the wrong part of the screen. */
              const next = title.trim();
              if (next) onAdd(next);
              setTitle("");
              setAdding(false);
            }}
            className="h-8 text-[12.5px]"
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px]"
          >
            <Plus className="size-3.5" strokeWidth={1.6} />
            Add a card
          </button>
        )}
      </div>
    </section>
  );
}

/** Where the card would land. A line rather than a gap that opens up: a gap
 *  moves every card below it and turns a hover into an animation the eye has
 *  to re-read, and it cannot be drawn at all at the foot of an empty lane. */
function Insertion() {
  return <div className="bg-foreground my-1 h-0.5 rounded-full" />;
}

/* ====================================================================== */
/*  A card                                                                */
/* ====================================================================== */

/**
 * URGENCY, AS A COLOUR AND A WORD.
 *
 * The status palette, borrowed on purpose: urgent is the destructive red and
 * high is the same amber a mailbox uses for a domain that is not verified,
 * because a page that spends its alarm colours on two different scales teaches
 * you to read neither. Normal and low are deliberately colourless — most cards
 * are normal, and a board where every chip is lit has no signal in it at all.
 *
 * The venture chip beside it is a different vocabulary and stays one: urgency
 * is a word in a pill and means HOW MUCH OF A HURRY; a venture is a colour and
 * a name and means WHOSE WORK. Only the venture carries the store's own hue.
 */
const URGENCY: { word: string; chip: string }[] = [
  { word: "low", chip: "bg-secondary text-muted-foreground" },
  { word: "normal", chip: "bg-secondary text-muted-foreground" },
  { word: "high", chip: "bg-warn/10 text-warn" },
  { word: "urgent", chip: "bg-destructive/10 text-destructive" },
];

function CardTile({
  card,
  venture,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  card: BoardCard;
  venture: Venture | undefined;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** True when the pointer is in the bottom half — "below this card". */
  onDragOver: (below: boolean) => void;
  onDrop: (below: boolean) => void;
}) {
  const urgency = URGENCY[card.urgency] ?? URGENCY[1]!;
  const overdue = card.due !== null && card.due < today();
  const dueToday = card.due === today();

  return (
    <div
      draggable
      onClick={onOpen}
      onDragStart={(e) => {
        /* Some browsers refuse to start a drag with an empty payload. The
           value is never read — the card being carried is state on the page,
           not something in the drag's own clipboard. */
        e.dataTransfer.setData("text/plain", String(card.id));
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        /* STOPPED HERE so the lane's "at the foot" answer does not overwrite
           this more precise one. The lane still gets everything that misses a
           card, which is what makes the empty space below the list a target. */
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onDragOver(e.clientY > r.top + r.height / 2);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onDrop(e.clientY > r.top + r.height / 2);
      }}
      className={cn(
        "bg-card hover:border-line-strong my-1 cursor-grab rounded-[9px] border px-2.5 py-2 transition-colors",
        dragging && "opacity-35",
      )}
    >
      <div className="text-[12.5px] leading-snug">{card.title}</div>

      {/* ONE LINE OF THE BODY AND NOT A WORD MORE. A card is a handle on a
          piece of work; the note is for the dialog. `line-clamp-1` rather than
          a substring so a long word cannot break the layout and so nothing is
          cut mid-character. */}
      {card.body && (
        <div className="text-muted-foreground mt-1 line-clamp-1 text-[11.5px]">
          {card.body}
        </div>
      )}

      {(venture || card.urgency !== 1 || card.due) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {venture && (
            <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
              <span
                className="size-[7px] shrink-0 rounded-[2px]"
                style={{ background: venture.color }}
              />
              {venture.name}
            </span>
          )}

          {/* Normal draws nothing. It is the default and most of the board,
              and a chip on every card is a chip that says nothing. */}
          {card.urgency !== 1 && (
            <span
              className={cn(
                "rounded-4xl px-1.5 py-px text-[10.5px] font-medium",
                urgency.chip,
              )}
            >
              {urgency.word}
            </span>
          )}

          {card.due && (
            <span
              className={cn(
                "text-[11px]",
                overdue
                  ? "text-destructive"
                  : dueToday
                    ? "text-warn"
                    : "text-muted-foreground",
              )}
            >
              {overdue ? "overdue · " : ""}
              {formatDay(card.due)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ====================================================================== */
/*  The card dialog                                                       */
/* ====================================================================== */

/**
 * One card, open.
 *
 * IT SENDS ONLY WHAT CHANGED. The patch is built by comparing the fields
 * against the card they came from, and a form with nothing changed saves
 * nothing at all. Resending five fields would overwrite an edit made in
 * another tab a second ago with values this form read before that edit
 * happened — and the server's contract already distinguishes "left out" from
 * "sent as null", so there is no reason to give up that distinction here.
 *
 * ARCHIVE AND DELETE ARE BOTH OFFERED because they are different intentions.
 * Archive keeps the card and takes it off the board; delete is gone. Only one
 * of them asks twice, and it is the one with no undo.
 */
function CardForm({
  card,
  columns,
  ventures,
  onSave,
  onArchive,
  onDelete,
  onCancel,
}: {
  card: BoardCard;
  columns: BoardColumn[];
  ventures: Venture[];
  onSave: (patch: BoardCardPatch) => void;
  onArchive: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body ?? "");
  const [urgency, setUrgency] = useState(card.urgency);
  const [due, setDue] = useState(card.due ?? "");
  const [ventureId, setVentureId] = useState(card.ventureId);
  const [confirming, setConfirming] = useState(false);

  const column = columns.find((c) => c.id === card.columnId);

  function save() {
    const patch: BoardCardPatch = {};
    if (title.trim() && title.trim() !== card.title) patch.title = title.trim();
    if ((body.trim() || null) !== card.body) patch.body = body.trim() || null;
    if (urgency !== card.urgency) patch.urgency = urgency;
    if ((due || null) !== card.due) patch.due = due || null;
    if (ventureId !== card.ventureId) patch.ventureId = ventureId;
    /* Nothing changed: close without a request. A save that writes an
       `updated_at` and nothing else makes the card look edited. */
    if (!Object.keys(patch).length) return onCancel();
    onSave(patch);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Card</DialogTitle>
        <DialogDescription>
          In {column?.title ?? "a column that has gone"} · added{" "}
          {formatStamp(card.createdAt)}
          {card.doneAt && ` · done ${formatStamp(card.doneAt)}`}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor="card-title">Title</Label>
          <Input
            id="card-title"
            value={title}
            autoFocus
            autoComplete="off"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save()}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="card-body">Notes</Label>
          <Textarea
            id="card-body"
            value={body}
            placeholder="What it actually involves, links, whatever the title cannot hold."
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="grid gap-1.5">
            <Label>Urgency</Label>
            <div className="flex gap-1">
              {URGENCY.map((u, i) => (
                <button
                  key={u.word}
                  type="button"
                  aria-pressed={urgency === i}
                  onClick={() => setUrgency(i)}
                  className={cn(
                    "rounded-lg border px-2 py-1 text-[11.5px] capitalize",
                    urgency === i
                      ? "border-foreground/40 font-medium"
                      : "text-muted-foreground border-transparent",
                    urgency === i && i >= 2 && u.chip,
                  )}
                >
                  {u.word}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="card-due">Due</Label>
            {/* A day, not a moment. The server stores 'YYYY-MM-DD' and this
                input speaks exactly that, so nothing has to decide what
                midnight means in which offset. Empty is "no date", which is a
                real answer and not a date of zero. */}
            <Input
              id="card-due"
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label>Venture</Label>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              aria-pressed={ventureId === null}
              onClick={() => setVentureId(null)}
              className={cn(
                "rounded-lg border px-2 py-1 text-[11.5px]",
                ventureId === null
                  ? "border-foreground/40 font-medium"
                  : "text-muted-foreground border-transparent",
              )}
            >
              None
            </button>
            {ventures.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={ventureId === v.id}
                onClick={() => setVentureId(v.id)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px]",
                  ventureId === v.id
                    ? "border-foreground/40 font-medium"
                    : "text-muted-foreground border-transparent",
                )}
              >
                <span
                  className="size-[7px] shrink-0 rounded-[2px]"
                  style={{ background: v.color }}
                />
                {v.name}
              </button>
            ))}
          </div>
          {/* A card can carry a venture id the store no longer has — the
              ventures live in this browser and the card lives on the server.
              Saying so beats drawing nothing and letting it look unfiled. */}
          {card.ventureId && !ventures.some((v) => v.id === card.ventureId) && (
            <p className="text-muted-foreground text-[11.5px]">
              Filed under a venture this browser does not have
              (<code>{card.ventureId}</code>). Choosing another replaces it.
            </p>
          )}
        </div>
      </div>

      <DialogFooter className="sm:justify-start">
        <Button onClick={save}>Save</Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="ghost" onClick={onArchive} className="sm:ml-auto">
          <Archive className="size-[15px]" strokeWidth={1.8} />
          Archive
        </Button>
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => (confirming ? onDelete() : setConfirming(true))}
        >
          <Trash2 className="size-[15px]" strokeWidth={1.8} />
          {confirming ? "Delete for good?" : "Delete"}
        </Button>
      </DialogFooter>
    </>
  );
}

/* ====================================================================== */
/*  Small things                                                          */
/* ====================================================================== */

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px]",
        active
          ? "border-foreground/40 text-foreground font-medium"
          : "text-muted-foreground hover:bg-accent hover:text-foreground border-transparent",
      )}
    >
      {children}
    </button>
  );
}

function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-[420px] text-center">
        <h1 className="text-[19px] font-normal tracking-[-0.02em]">{title}</h1>
        {body && (
          <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">
            {body}
          </p>
        )}
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

/**
 * Today, as the same 'YYYY-MM-DD' the server stores.
 *
 * Built out of the LOCAL date parts and compared as a string. `new
 * Date("2026-09-05")` is midnight UTC, so west of Greenwich it is still
 * yesterday when it is parsed — which would make a card go overdue at a time
 * that depends on nothing the owner can see. Two ISO days compare correctly as
 * text, so there is no arithmetic to get wrong.
 */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** '2026-09-05' as "5 Sep". Read back in UTC because that is how it was
 *  built — anything else can print the day before. */
function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** A server timestamp as a day, in the reader's own zone — this one IS a
 *  moment, so it is read as one. */
function formatStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
