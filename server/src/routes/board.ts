/**
 * THE BOARD — columns, and cards in an order somebody chose.
 *
 * This is the first route on this server that owns what the OWNER typed rather
 * than what a provider reported. Every other route here is a window onto a
 * collector's transcript: a row is replaced when the next collection disagrees
 * with it, and the worst thing a bug can do is show a stale number. These rows
 * are the record. A card lost is work lost, so nothing in this file overwrites
 * a row it did not mean to and nothing deletes without being asked twice (once
 * by the page, once by the DELETE).
 *
 * EVERY MUTATION ANSWERS WITH THE WHOLE BOARD, and that is the one contract
 * this file is built around. It mirrors a pattern from the system this
 * replaces, worth copying for a reason that only shows up under a drag: a move
 * changes a card's column, its position, its `updatedAt` and possibly its
 * `doneAt`, and — because positions are shared — it can change the numbers on
 * cards nobody touched. A reply of `{ ok: true }` would leave the page to
 * guess at all of that, and a reply of "the card as it now is" would leave it
 * to guess at the rest of the column. Handing back the document means the
 * client's next state is not derived from anything: it IS the server's answer,
 * applied whole. The board is a set of columns and cards — a few
 * kilobytes — so the cost of that is nothing, and it buys away the entire
 * class of bug where a page and its server disagree about where a card is.
 *
 * WHY THE MOVE TAKES A NEIGHBOUR RATHER THAN AN INDEX. `{ columnId, before }`
 * — "put it in that column, above that card" — where the system this replaces
 * sends `{ column, index }`. Both keep the ORDER on the server, which is the
 * part that matters; the difference is what happens when the client's copy is
 * a few seconds old. An index of 3 means a different slot the moment anything
 * else has been inserted, and it silently means SOMETHING, so a stale drop
 * lands in the wrong place and looks like the drag misfired. A card id either
 * still names a card in that column or it does not, and if it does not this
 * route says so rather than guessing. `before: null` is the honest name for
 * the end of the column, and is what a drop past the last card sends.
 *
 * Custom columns can be created, reordered and removed. Removing one moves
 * every card to Backlog. Backlog and Done keep their structural keys and
 * cannot be removed, even when renamed.
 *
 * THE VENTURES ARE HERE, AND THE ID IS STILL NOT A FOREIGN KEY.
 *
 * A card carries `ventureId`. `021_ventures` put ventures in a table beside
 * these cards, because the agent has to be able to read a venture's STAGE —
 * so `boardDoc()` resolves the ids the cards actually carry and hands over a
 * `ventures` map of name, slug, colour and stage. The page does not have to
 * hold a second copy of the list to draw a chip.
 *
 * `venture_id` IS STILL A BARE TEXT COLUMN WITH NO REFERENCES ON IT, and that
 * is a decision rather than an oversight. A foreign key would force one of
 * two behaviours on a delete and both are worse than the third. ON DELETE
 * CASCADE takes the work with the
 * business, and "I closed that venture" is not "delete the eleven cards about
 * winding it up". ON DELETE SET NULL silently unfiles them, which loses the
 * one fact worth keeping — that this card was about that thing. Leaving the id
 * opaque keeps the third answer: the card is still there, its id resolves to
 * nothing, the map has no entry for it and the page draws it unfiled. That is
 * a real state, it is honest, and it is better than a chip labelled with a
 * business that no longer exists.
 *
 * The map is built at READ TIME from the ids present, not stored and not
 * joined into the card. A card holds one field about a venture; everything
 * else about it belongs to /api/ventures and is only ever borrowed here.
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { db, now, type VentureRow } from "../db.ts";

export const boardRoutes = new Hono();

/* ------------------------------------------------------------------ rules */

/** The step between two neighbouring cards. See `020_board` for the whole
 *  argument; the short version is that a gap of 1000 buys ten drops into the
 *  same slot before anything has to be renumbered, and a move is one UPDATE
 *  rather than a rewrite of two columns. */
const GAP = 1000;

/** The two columns that mean something to the code rather than to the eye.
 *  They can be renamed — a board that calls its first column "Someday" is
 *  still a board — which is exactly why the key is stored beside the title. */
const BACKLOG = "backlog";
const DONE = "done";
const STRUCTURAL = new Set([BACKLOG, DONE]);

/** A title is a line, a body is a note. Both are refused at the door rather
 *  than truncated: a card silently saved shorter than it was typed is a card
 *  that lost something the owner wrote. */
const MAX_TITLE = 200;
const MAX_BODY = 8_000;

boardRoutes.post("/columns", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > MAX_TITLE)
    return c.json({ error: `A column needs a name of 1–${MAX_TITLE} characters.` }, 400);
  const limit = body.wipLimit ?? null;
  if (limit !== null && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0))
    return c.json({ error: "A WIP limit is a whole number of cards, or null." }, 400);
  tx(() => {
    const columns = columnRows();
    const done = columns.findIndex((col) => col.key === DONE);
    const position = done < 0 ? columns.length : done;
    columns.forEach((col, i) => db.prepare("UPDATE board_columns SET position = ? WHERE id = ?").run(i >= position ? i + 1 : i, col.id));
    db.prepare("INSERT INTO board_columns (key, title, position, wip_limit, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(`custom-${randomUUID()}`, body.title.trim(), position, limit, now());
  });
  return c.json(boardDoc(), 201);
});

// Removing a lane never deletes work, including archived cards in that lane.
boardRoutes.delete("/columns/:id", (c) => {
  const column = columnById(Number(c.req.param("id")));
  if (!column) return c.json({ error: "No column with that id." }, 404);
  if (STRUCTURAL.has(column.key)) return c.json({ error: "Backlog and Done are required columns. You can rename them." }, 400);
  tx(() => {
    const backlog = columnRows().find((col) => col.key === BACKLOG)!;
    const held = db.prepare("SELECT COALESCE(MAX(position), 0) AS tail FROM board_cards WHERE column_id = ?").get(backlog.id) as { tail: number };
    const cards = db.prepare("SELECT id FROM board_cards WHERE column_id = ? ORDER BY position, id").all(column.id) as { id: number }[];
    const move = db.prepare("UPDATE board_cards SET column_id = ?, position = ?, done_at = NULL, updated_at = ? WHERE id = ?");
    cards.forEach((card, i) => move.run(backlog.id, held.tail + (i + 1) * GAP, now(), card.id));
    db.prepare("DELETE FROM board_columns WHERE id = ?").run(column.id);
    columnRows().forEach((col, i) => db.prepare("UPDATE board_columns SET position = ? WHERE id = ?").run(i, col.id));
  });
  return c.json(boardDoc());
});

/** 0 low · 1 normal · 2 high · 3 urgent. The words are the client's; the
 *  server keeps the ORDER, which is the only part of it a query cares about. */
const MAX_URGENCY = 3;

/* ------------------------------------------------------------------ rows */

type ColumnRow = {
  id: number;
  key: string;
  title: string;
  position: number;
  wip_limit: number | null;
  created_at: string;
};

type CardRow = {
  id: number;
  column_id: number;
  position: number;
  title: string;
  body: string | null;
  venture_id: string | null;
  urgency: number;
  due: string | null;
  done_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  origin: string | null;
};

const columnRows = (): ColumnRow[] =>
  db
    .prepare("SELECT * FROM board_columns ORDER BY position, id")
    .all() as unknown as ColumnRow[];

const columnById = (id: number): ColumnRow | undefined =>
  db.prepare("SELECT * FROM board_columns WHERE id = ?").get(id) as
    | ColumnRow
    | undefined;

const cardById = (id: number): CardRow | undefined =>
  db.prepare("SELECT * FROM board_cards WHERE id = ?").get(id) as
    | CardRow
    | undefined;

/** A column's cards as the board reads them: live ones, in order. Archived
 *  rows keep their positions and are never in this list — which is why a
 *  position is not unique and the sort breaks ties on the id. */
function liveCards(columnId: number, excludeId?: number): CardRow[] {
  return db
    .prepare(
      `SELECT * FROM board_cards
        WHERE column_id = ? AND archived_at IS NULL AND id IS NOT ?
        ORDER BY position, id`,
    )
    .all(columnId, excludeId ?? null) as unknown as CardRow[];
}

/**
 * A column named by whatever the caller had to hand.
 *
 * The page sends the numeric id it was given in the document. A person with
 * curl has a key — "doing" — and no reason to look one up first. Both are
 * accepted because both are unambiguous: ids are numbers and keys are not, so
 * there is no string that could be either.
 */
function resolveColumn(ref: unknown): ColumnRow | undefined {
  if (typeof ref === "number" && Number.isInteger(ref)) return columnById(ref);
  if (typeof ref === "string" && ref.trim()) {
    const key = ref.trim().toLowerCase();
    if (/^\d+$/.test(key)) return columnById(Number(key));
    return db.prepare("SELECT * FROM board_columns WHERE key = ?").get(key) as
      | ColumnRow
      | undefined;
  }
  return undefined;
}

/** Several statements that must land together or not at all — a renumber and
 *  the move it was making room for, most of the time. `node:sqlite` is
 *  synchronous, so this is a plain try/finally rather than a callback. */
function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/* --------------------------------------------------------------- document */

function shapeCard(r: CardRow) {
  return {
    id: r.id,
    columnId: r.column_id,
    /* The sort key, handed over because the page sorts its own optimistic
       copy with it — see Board.tsx. It means nothing outside this table: 3000
       is not "third", and nothing may ever send one back. */
    position: r.position,
    title: r.title,
    body: r.body,
    ventureId: r.venture_id,
    urgency: r.urgency,
    due: r.due,
    doneAt: r.done_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    /* Null on everything a person typed, which is every card today. See the
       seam at the foot of this file. */
    origin: r.origin,
  };
}

/**
 * The ventures these cards name, as much of each as a chip needs.
 *
 * FOUR FIELDS AND NOT THE WHOLE RECORD. A chip is a colour, a name and — on
 * the Board page, where "what stage is this business at" changes how a card
 * reads — a stage; the slug is there so the chip can be a link. The
 * description, the website, the measured brand and the position are the
 * Ventures page's business, and copying them onto every board read would make
 * this document grow whenever that one did.
 *
 * ONE QUERY WITH THE IDS INLINED, rather than one per card or a join. The list
 * is at most a few dozen and the ids come from rows this function was handed,
 * so nothing here is user input reaching SQL as text: the placeholders are
 * generated from the count and every id is still bound.
 */
function ventureChips(
  cards: CardRow[],
): Record<string, { name: string; slug: string; color: string; stage: string }> {
  const ids = [...new Set(cards.map((c) => c.venture_id).filter((v): v is string => !!v))];
  if (!ids.length) return {};
  const rows = db
    .prepare(
      `SELECT id, name, slug, color, stage FROM ventures
        WHERE id IN (${ids.map(() => "?").join(", ")})`,
    )
    .all(...ids) as unknown as Pick<
    VentureRow,
    "id" | "name" | "slug" | "color" | "stage"
  >[];

  const out: Record<string, { name: string; slug: string; color: string; stage: string }> = {};
  for (const r of rows)
    out[r.id] = { name: r.name, slug: r.slug, color: r.color, stage: r.stage };
  /* Ids with no row are simply absent. See the file header: a card whose
     venture was deleted is drawn unfiled, and an entry saying "unknown" would
     be this document inventing a business. */
  return out;
}

export type BoardDoc = ReturnType<typeof boardDoc>;

/**
 * The whole board, in one read.
 *
 * TWO QUERIES RATHER THAN ONE PER COLUMN. Five columns is five round trips to
 * answer one question, and the join is trivial to do here — but the real
 * reason is that the two statements are a consistent pair under one read,
 * where five would let a card move between the second and the fourth and be
 * drawn twice or not at all.
 */
function boardDoc() {
  const columns = columnRows();
  const cards = db
    .prepare(
      `SELECT * FROM board_cards
        WHERE archived_at IS NULL
        ORDER BY column_id, position, id`,
    )
    .all() as unknown as CardRow[];

  const byColumn = new Map<number, CardRow[]>();
  for (const c of cards) {
    const list = byColumn.get(c.column_id);
    if (list) list.push(c);
    else byColumn.set(c.column_id, [c]);
  }

  const archived = db
    .prepare("SELECT COUNT(*) AS n FROM board_cards WHERE archived_at IS NOT NULL")
    .get() as { n: number };

  return {
    /*
      WHAT THE IDS ON THESE CARDS MEAN — the four fields it takes to draw a
      chip, for the ventures the cards actually name and no others.

      Every venture would be the easier query and it would put businesses on a
      board document that has nothing to do with them; the page has
      /api/ventures for the list. An id with no entry here is a venture that
      was deleted, which the page draws as unfiled — see the file header. Read
      after the cards, from the same synchronous connection, so the map and the
      ids it explains are the same instant.
    */
    ventures: ventureChips(cards),
    columns: columns.map((col) => {
      const own = byColumn.get(col.id) ?? [];
      return {
        id: col.id,
        key: col.key,
        title: col.title,
        position: col.position,
        /* Null is not zero here and the two are told apart all the way to the
           screen: no limit set, versus a column nothing is allowed to sit in. */
        wipLimit: col.wip_limit,
        /** Backlog and Done. Named on the document so the page can hide a
         *  control rather than offer a press that would be refused. */
        structural: STRUCTURAL.has(col.key),
        count: own.length,
        /* Computed here rather than on the page because the count and the
           limit are both here, and two places deciding what "over" means is
           how a column ends up drawn calm while its number says otherwise. A
           limit of 0 makes any card over the limit, which is the instruction. */
        overLimit: col.wip_limit !== null && own.length > col.wip_limit,
        cards: own.map(shapeCard),
      };
    }),
    totals: {
      cards: cards.length,
      /* What is finished, by the column it is in rather than by `done_at` —
         they agree, and the column is the thing the eye is counting. */
      done: columns
        .filter((c) => c.key === DONE)
        .reduce((n, c) => n + (byColumn.get(c.id)?.length ?? 0), 0),
      /** Not in the columns above, and not gone either. */
      archived: archived.n,
    },
  };
}

/* -------------------------------------------------------------- positions */

/**
 * Give every live card in a column a fresh number, 1000 apart.
 *
 * THIS IS THE COST OF THE SPARSE SCHEME AND IT IS PAID HERE, once every ten or
 * so drops into one closing gap, instead of on every single drag. Archived
 * rows are renumbered too: they are invisible, but leaving them at old numbers
 * would let one sit at a position a live card is about to be given, and a
 * position that means two different things is the sort of thing that only
 * surfaces the day somebody un-archives something.
 */
function renumber(columnId: number) {
  const rows = db
    .prepare(
      "SELECT id FROM board_cards WHERE column_id = ? ORDER BY position, id",
    )
    .all(columnId) as unknown as { id: number }[];
  const stmt = db.prepare("UPDATE board_cards SET position = ? WHERE id = ?");
  rows.forEach((r, i) => stmt.run((i + 1) * GAP, r.id));
}

/**
 * The number a card needs to land between these two neighbours.
 *
 * Returns `null` when there is no integer left between them — the caller
 * renumbers the column and asks again. It does not renumber itself, because a
 * function that answers a question and also rewrites a table is one nobody can
 * call from inside a loop without reading it first.
 */
function between(prev: CardRow | undefined, next: CardRow | undefined): number | null {
  if (!prev && !next) return GAP;
  if (!prev) return next!.position - GAP;
  if (!next) return prev.position + GAP;
  const mid = Math.floor((prev.position + next.position) / 2);
  return mid > prev.position && mid < next.position ? mid : null;
}

/** Where a new card goes: the foot of the column. A card is typed at the
 *  bottom of a list and appears where it was typed. */
function endOf(columnId: number): number {
  const last = db
    .prepare(
      `SELECT position FROM board_cards
        WHERE column_id = ? AND archived_at IS NULL
        ORDER BY position DESC, id DESC LIMIT 1`,
    )
    .get(columnId) as { position: number } | undefined;
  return last ? last.position + GAP : GAP;
}

/* ------------------------------------------------------------- validation */

/** A trimmed title, or the sentence saying why there isn't one. */
function readTitle(v: unknown): { title: string } | { error: string } {
  if (typeof v !== "string") return { error: "A title is required." };
  const title = v.trim();
  if (!title) return { error: "A title is required." };
  if (title.length > MAX_TITLE)
    return { error: `A title is at most ${MAX_TITLE} characters.` };
  return { title };
}

/**
 * A due date, or null, or a refusal.
 *
 * 'YYYY-MM-DD' AND NOTHING ELSE. Accepting whatever `Date` can parse would let
 * "next tuesday" through as an Invalid Date and "3/4" through as either the
 * third of April or the fourth of March depending on nothing visible. A due
 * date is a day, the client sends a day, and a string that is not one is a bug
 * worth hearing about at the door.
 */
function readDue(v: unknown): { due: string | null } | { error: string } {
  if (v === null) return { due: null };
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim()))
    return { error: "A due date is a day, as YYYY-MM-DD, or null for none." };
  const due = v.trim();
  const [y, m, d] = due.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  )
    return { error: `There is no such date as ${due}.` };
  return { due };
}

function readUrgency(v: unknown): { urgency: number } | { error: string } {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_URGENCY)
    return {
      error: `Urgency is 0 (low), 1 (normal), 2 (high) or 3 (urgent).`,
    };
  return { urgency: v };
}

/** A venture id is an opaque string from the browser's own store, or null for
 *  a card that is not about one of them. There is nothing here to validate it
 *  against — see the file header. */
function readVentureId(v: unknown): { ventureId: string | null } | { error: string } {
  if (v === null) return { ventureId: null };
  if (typeof v !== "string" || !v.trim())
    return { error: "A ventureId is a non-empty string, or null for none." };
  return { ventureId: v.trim() };
}

/* ------------------------------------------------------------------ reads */

boardRoutes.get("/", (c) => c.json(boardDoc()));

/* ------------------------------------------------------------------ cards */

/**
 * Write a card down.
 *
 * `column` is optional and defaults to Backlog, which is the whole reason
 * Backlog is structural: a card typed in a hurry has to have somewhere to go
 * that is not a decision. Passing a column is for the add-a-card box at the
 * foot of a lane, which knows exactly where it is.
 */
boardRoutes.post("/cards", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    body?: unknown;
    ventureId?: unknown;
    urgency?: unknown;
    due?: unknown;
    column?: unknown;
  } | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const title = readTitle(body.title);
  if ("error" in title) return c.json({ error: title.error }, 400);

  const column =
    body.column === undefined || body.column === null
      ? resolveColumn(BACKLOG)
      : resolveColumn(body.column);
  if (!column)
    return c.json(
      { error: "No column by that name. Send its id, or its key." },
      400,
    );

  let text: string | null = null;
  if (body.body !== undefined && body.body !== null) {
    if (typeof body.body !== "string")
      return c.json({ error: "A body is text, or null for none." }, 400);
    if (body.body.length > MAX_BODY)
      return c.json({ error: `A body is at most ${MAX_BODY} characters.` }, 400);
    text = body.body.trim() || null;
  }

  let urgency = 1;
  if (body.urgency !== undefined) {
    const u = readUrgency(body.urgency);
    if ("error" in u) return c.json({ error: u.error }, 400);
    urgency = u.urgency;
  }

  let due: string | null = null;
  if (body.due !== undefined) {
    const d = readDue(body.due);
    if ("error" in d) return c.json({ error: d.error }, 400);
    due = d.due;
  }

  let ventureId: string | null = null;
  if (body.ventureId !== undefined) {
    const v = readVentureId(body.ventureId);
    if ("error" in v) return c.json({ error: v.error }, 400);
    ventureId = v.ventureId;
  }

  const ts = now();
  db.prepare(
    `INSERT INTO board_cards
       (column_id, position, title, body, venture_id, urgency, due, done_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    column.id,
    endOf(column.id),
    title.title,
    text,
    ventureId,
    urgency,
    due,
    /* A card typed straight into Done is a thing that was already finished
       when it was written down, so it gets its stamp on the way in rather
       than only on the move that would have put it there. */
    column.key === DONE ? ts : null,
    ts,
    ts,
  );

  return c.json(boardDoc(), 201);
});

/**
 * Change what a card says.
 *
 * ABSENT AND NULL ARE DIFFERENT AND THIS IS THE ROUTE WHERE IT MATTERS MOST.
 * A field left out of the body is untouched; a field sent as `null` is
 * cleared. That is what lets the dialog send one field when one field changed,
 * instead of resending the whole card and overwriting an edit somebody made in
 * another tab a second ago — and it is what lets "remove the due date" be an
 * instruction rather than an omission. There is no way to clear a title,
 * because a card with no title is not a card.
 */
boardRoutes.patch("/cards/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const card = Number.isInteger(id) ? cardById(id) : undefined;
  if (!card) return c.json({ error: "No card with that id." }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  if (body.title !== undefined) {
    const t = readTitle(body.title);
    if ("error" in t) return c.json({ error: t.error }, 400);
    sets.push("title = ?");
    args.push(t.title);
  }
  if (body.body !== undefined) {
    if (body.body === null) {
      sets.push("body = ?");
      args.push(null);
    } else {
      if (typeof body.body !== "string")
        return c.json({ error: "A body is text, or null for none." }, 400);
      if (body.body.length > MAX_BODY)
        return c.json({ error: `A body is at most ${MAX_BODY} characters.` }, 400);
      sets.push("body = ?");
      args.push(body.body.trim() || null);
    }
  }
  if (body.urgency !== undefined) {
    const u = readUrgency(body.urgency);
    if ("error" in u) return c.json({ error: u.error }, 400);
    sets.push("urgency = ?");
    args.push(u.urgency);
  }
  if (body.due !== undefined) {
    const d = readDue(body.due);
    if ("error" in d) return c.json({ error: d.error }, 400);
    sets.push("due = ?");
    args.push(d.due);
  }
  if (body.ventureId !== undefined) {
    const v = readVentureId(body.ventureId);
    if ("error" in v) return c.json({ error: v.error }, 400);
    sets.push("venture_id = ?");
    args.push(v.ventureId);
  }

  if (!sets.length)
    return c.json(
      { error: "Nothing to change. Send title, body, urgency, due or ventureId." },
      400,
    );

  sets.push("updated_at = ?");
  args.push(now(), id);
  db.prepare(`UPDATE board_cards SET ${sets.join(", ")} WHERE id = ?`).run(...args);

  return c.json(boardDoc());
});

/**
 * THE DRAG.
 *
 * `{ columnId, before }` — put this card in that column, immediately above
 * that card, or at the foot of it when `before` is null or left out. See the
 * file header for why it is a neighbour rather than an index.
 *
 * DONE IS A COLUMN AND A TIMESTAMP, AND THE MOVE IS WHERE THEY ARE KEPT IN
 * STEP. Arriving in Done stamps `done_at` if it does not already have one —
 * re-ordering within Done must not restamp it, or "finished on Tuesday" turns
 * into "finished the last time I tidied the column". Leaving Done clears it,
 * because a card that is back in Doing is not a finished card with a date on
 * it, and a stale stamp is exactly the sort of thing a later report would
 * count.
 */
boardRoutes.post("/cards/:id/move", async (c) => {
  const id = Number(c.req.param("id"));
  const card = Number.isInteger(id) ? cardById(id) : undefined;
  if (!card) return c.json({ error: "No card with that id." }, 404);
  if (card.archived_at)
    return c.json({ error: "That card is archived. Nothing can be dropped into an archive." }, 409);

  const body = (await c.req.json().catch(() => null)) as {
    columnId?: unknown;
    before?: unknown;
  } | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const column = resolveColumn(body.columnId);
  if (!column)
    return c.json(
      { error: "No column by that name. Send its id, or its key." },
      400,
    );

  const before =
    body.before === undefined || body.before === null ? null : Number(body.before);
  if (before !== null && !Number.isInteger(before))
    return c.json(
      { error: "`before` is the id of the card to land above, or null for the end." },
      400,
    );

  /* Dropped on itself: the answer is the board, unchanged. This is a real
     event rather than a mistake — a drag that ends where it started — and
     answering it with a 400 would put an error on screen for a no-op. */
  if (before === id) return c.json(boardDoc());

  const neighbours = liveCards(column.id, id);
  const index =
    before === null ? neighbours.length : neighbours.findIndex((n) => n.id === before);
  if (index < 0)
    return c.json(
      {
        error:
          "That card is not in that column any more — the board moved under the drag. Reload and try again.",
      },
      409,
    );

  tx(() => {
    let position = between(neighbours[index - 1], neighbours[index]);
    if (position === null) {
      /* The gap closed. Renumber this column and ask again — the second
         answer cannot fail, because every neighbour is now 1000 apart. */
      renumber(column.id);
      const fresh = liveCards(column.id, id);
      position = between(fresh[index - 1], fresh[index]) ?? endOf(column.id);
    }

    const doneAt =
      column.key === DONE ? (card.done_at ?? now()) : null;

    db.prepare(
      `UPDATE board_cards
          SET column_id = ?, position = ?, done_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(column.id, position, doneAt, now(), id);
  });

  return c.json(boardDoc());
});

/** Out of the way, not gone. The card keeps its column, its position and its
 *  `done_at`; every read of the board filters it out. */
boardRoutes.post("/cards/:id/archive", (c) => {
  const id = Number(c.req.param("id"));
  const card = Number.isInteger(id) ? cardById(id) : undefined;
  if (!card) return c.json({ error: "No card with that id." }, 404);
  if (card.archived_at) return c.json(boardDoc());

  const ts = now();
  db.prepare(
    "UPDATE board_cards SET archived_at = ?, updated_at = ? WHERE id = ?",
  ).run(ts, ts, id);
  return c.json(boardDoc());
});

/** Gone. The one route here with no undo, which is why archive exists beside
 *  it and why the page asks before it calls this. */
boardRoutes.delete("/cards/:id", (c) => {
  const id = Number(c.req.param("id"));
  const card = Number.isInteger(id) ? cardById(id) : undefined;
  if (!card) return c.json({ error: "No card with that id." }, 404);
  db.prepare("DELETE FROM board_cards WHERE id = ?").run(id);
  return c.json(boardDoc());
});

/* ---------------------------------------------------------------- columns */

/**
 * Rename a column, or put a ceiling on it.
 *
 * A WIP LIMIT IS NOT ENFORCED, DELIBERATELY. This route stores it and the
 * document reports `overLimit`; no move is refused because of it. A limit is a
 * thing the owner set to be told about, and a board that physically refuses a
 * drop teaches you to drag the card somewhere dishonest instead — the work is
 * still started, the board just stops describing it. Saying "you now have four
 * in a column you said should hold three" is the whole of what the limit is
 * for.
 */
boardRoutes.patch("/columns/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const column = Number.isInteger(id) ? columnById(id) : undefined;
  if (!column) return c.json({ error: "No column with that id." }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    wipLimit?: unknown;
  } | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim())
      return c.json({ error: "A column needs a name." }, 400);
    if (body.title.trim().length > MAX_TITLE)
      return c.json({ error: `A name is at most ${MAX_TITLE} characters.` }, 400);
    sets.push("title = ?");
    args.push(body.title.trim());
  }
  if (body.wipLimit !== undefined) {
    if (body.wipLimit === null) {
      sets.push("wip_limit = ?");
      args.push(null);
    } else if (
      typeof body.wipLimit !== "number" ||
      !Number.isInteger(body.wipLimit) ||
      body.wipLimit < 0
    ) {
      return c.json(
        { error: "A WIP limit is a whole number of cards, or null for no limit." },
        400,
      );
    } else {
      sets.push("wip_limit = ?");
      args.push(body.wipLimit);
    }
  }

  if (!sets.length)
    return c.json({ error: "Nothing to change. Send title or wipLimit." }, 400);

  args.push(id);
  db.prepare(`UPDATE board_columns SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return c.json(boardDoc());
});

/**
 * Move a column, in the same vocabulary a card moves in: `{ before }`, the id
 * of the column to land in front of, or null for the far right.
 *
 * THE COLUMNS ARE RENUMBERED DENSELY, 0..n-1, on every one of these. That is
 * the scheme the cards deliberately avoid — and it is right here for the
 * reason `020_board` gives: there are five columns and this happens about
 * once, so five UPDATEs is cheaper than a sparse scheme nobody can see the
 * benefit of. It also means the positions on the document keep reading as
 * "first, second, third", which is what a reader would assume of five.
 */
boardRoutes.post("/columns/:id/move", async (c) => {
  const id = Number(c.req.param("id"));
  const column = Number.isInteger(id) ? columnById(id) : undefined;
  if (!column) return c.json({ error: "No column with that id." }, 404);

  const body = (await c.req.json().catch(() => null)) as { before?: unknown } | null;
  const before =
    !body || body.before === undefined || body.before === null
      ? null
      : Number(body.before);
  if (before !== null && !Number.isInteger(before))
    return c.json(
      { error: "`before` is the id of the column to land in front of, or null for the end." },
      400,
    );
  if (before === id) return c.json(boardDoc());

  const others = columnRows().filter((col) => col.id !== id);
  const index = before === null ? others.length : others.findIndex((col) => col.id === before);
  if (index < 0) return c.json({ error: "No column with that id to land before." }, 400);

  const ordered = [...others.slice(0, index), column, ...others.slice(index)];
  tx(() => {
    const stmt = db.prepare("UPDATE board_columns SET position = ? WHERE id = ?");
    ordered.forEach((col, i) => stmt.run(i, col.id));
  });

  return c.json(boardDoc());
});

/* ------------------------------------------------------------------- seam */

/**
 * THE DOOR A FILER COMES IN THROUGH.
 *
 * Two callers today — the synthesis pass and the action inbox — and the
 * expensive half of it is the idempotency, not the INSERT. `origin` is the
 * derivation's own id with a namespace on it — `inbox:disk-dell`,
 * `synthesis:<proposal>` — and the unique index in `020_board` is what lets a
 * sweep run twice, or in two tabs, and leave one card behind rather than two. A
 * caller that had to do that itself would have to read the board first, which
 * is a race it cannot win.
 *
 * Automatic filing receipts survive deletion. Check those as well so filing
 * the same source through another surface cannot undo the owner's decision.
 * Aliases are explicit source identities, never a fuzzy title match.
 */
export function fileCard(input: {
  origin: string;
  title: string;
  body?: string | null;
  ventureId?: string | null;
  urgency?: number;
  aliases?: string[];
}): { filed: boolean } {
  const column = resolveColumn(BACKLOG);
  if (!column) throw new Error("The board has no Backlog column to file into.");

  const ts = now();
  const origins = JSON.stringify([input.origin, ...(input.aliases ?? [])]);
  const res = db
    .prepare(
      `INSERT INTO board_cards
         (column_id, position, title, body, venture_id, urgency, due, done_at,
          created_at, updated_at, origin)
       SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM board_cards WHERE origin IN (SELECT value FROM json_each(?)))
         AND NOT EXISTS (SELECT 1 FROM board_automation_filings WHERE origin IN (SELECT value FROM json_each(?)))
       ON CONFLICT(origin) DO NOTHING`,
    )
    .run(
      column.id,
      endOf(column.id),
      input.title.trim().slice(0, MAX_TITLE),
      input.body?.trim() || null,
      input.ventureId ?? null,
      input.urgency ?? 1,
      ts,
      ts,
      input.origin,
      origins,
      origins,
    );
  return { filed: Number(res.changes) > 0 };
}
