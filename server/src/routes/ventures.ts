/**
 * THE VENTURES — the businesses this whole dashboard is about.
 *
 * This is the second route here that owns what the OWNER typed rather than
 * what a provider reported, and it is the one the first one was waiting for.
 * routes/board.ts stores `venture_id` on every card and could never say what
 * one WAS; chat sessions carry a venture id and the agent was never told what
 * it meant. Both of those pointed at a list in the browser's localStorage.
 * They now point here.
 *
 * WHY IT MOVED, IN ONE FIELD: `stage`. An idea, a thing about to ship and a
 * live business want three different kinds of help — validate demand, get to a
 * first release, watch churn — and until this table existed the agent could
 * not know which it was looking at. Everything else on the record (the name,
 * the sentence, the site) is nice to have on the server; the stage is the
 * reason the move was worth doing.
 *
 * THE RECORD IS TWO HALVES AND THEY ARE NEVER MIXED UP. The columns are what
 * the OWNER SAID: name, what it is, the address, the stage, a colour if they
 * picked one. `brand` is what was MEASURED from that address by
 * ventures/enrich.ts — a favicon, a palette, the fonts, and the notes saying
 * what could not be read. Anything quoting the second half should say where it
 * came from, which is why the source is on the document (`colorSource`) rather
 * than inferred from whether a colour happens to look measured.
 *
 * ENRICHMENT NEVER FAILS A REQUEST. A create runs it inline, because a page
 * that shows the icon it just read is worth ten seconds — but a web server
 * that is down, slow or lying must not be able to stop the owner writing a
 * venture down. Every failure lands in `brand.error` or `brand.notes` and the
 * 201 is a 201. That is the same rule the whole enrichment file keeps and it
 * is stated in both places because it is the one that would be quietly broken
 * by a `throw` added later.
 *
 * ABSENT AND NULL ARE DIFFERENT ON THE PATCH, exactly as on the board's, and
 * here it is what makes "I have taken the site down" expressible: a field left
 * out is untouched, `website: null` clears the address AND the measurements
 * taken from it, because a palette read off a site that is gone is a palette
 * about nothing. `name` has no null — a venture with no name is not one.
 *
 * WHAT IS NOT HERE. No archive: a venture is deleted or it is not, and the
 * board's archive exists because a finished card is still a record of work,
 * which a deleted business is not. No cascade either — a deleted venture
 * leaves board cards carrying its id, they resolve to nothing and are drawn
 * unfiled, and routes/board.ts's header argues that at length.
 */
import { Hono } from "hono";
import {
  db,
  now,
  ventureRow,
  ventureRowById,
  ventureRows,
  type VentureRow,
} from "../db.ts";
import { enrichVenture, normaliseWebsite, readBrand } from "../ventures/enrich.ts";

export const ventureRoutes = new Hono();

/* ------------------------------------------------------------------ rules */

export type VentureStage = "idea" | "pre-launch" | "launched";

/**
 * THE THREE STAGES AND WHAT EACH ONE MEANS, once, on the wire.
 *
 * These sentences are shipped rather than kept in the client's copy because
 * three different readers need the same ones: the form that asks the owner to
 * pick, the agent that tailors its advice, and anybody reading the JSON. Three
 * copies of a sentence is three chances for the agent to be working from a
 * different definition than the one the owner chose against.
 */
const STAGES: Record<VentureStage, string> = {
  idea: "Not built yet. Validate demand, size it, decide whether to build.",
  "pre-launch":
    "Being built or about to ship. Get to a first release: launch checklist, landing page, first users.",
  launched:
    "Live and serving people. Grow it, keep it healthy, watch revenue and churn.",
};

const STAGE_KEYS = Object.keys(STAGES) as VentureStage[];

/** The seven the client offers. Duplicated from `client/src/lib/store.tsx`
 *  rather than imported, because the two halves of this app do not share a
 *  module — and this copy is the one that matters, since it is what a venture
 *  created over curl gets. */
const VENTURE_COLORS = [
  "#c1663f",
  "#635bff",
  "#2f7d4f",
  "#3b7bd8",
  "#a8446f",
  "#a86524",
  "#4a4842",
];

/** A name is a line. Refused at the door rather than truncated, the same rule
 *  the board keeps: a name silently saved shorter than it was typed is a name
 *  that lost something. */
const MAX_NAME = 80;
const MAX_DESCRIPTION = 4_000;
/** Long enough for a URL with a path on it and short enough that a paste of
 *  something else is refused before it is fetched. */
const MAX_WEBSITE = 500;

const HEX = /^#[0-9a-fA-F]{6}$/;

/* --------------------------------------------------------------- document */

/**
 * One venture as everything reads it.
 *
 * `brand` is parsed here rather than shipped as a string, for the reason
 * chat's `readTools` gives about its own JSON column: a row that somebody
 * hand-edited into invalid JSON should cost its measurements, not the venture
 * — so `readBrand` answers with the empty brand rather than throwing, and the
 * page draws a venture whose site has not been read.
 */
function shapeVenture(r: VentureRow) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    website: r.website,
    host: r.host,
    stage: r.stage as VentureStage,
    color: r.color,
    /* WHERE THE COLOUR CAME FROM, on the document rather than left to be
       guessed at. It decides what the page may offer ("use the site's
       colour"), and it is what stops a re-read overwriting a choice. */
    colorSource: r.color_source as "owner" | "site" | "default",
    position: r.position,
    brand: readBrand(r.brand),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The whole list, plus the two things a reader would otherwise compute for
 *  itself and get subtly wrong: how many are at each stage, and what each
 *  stage MEANS. */
function venturesDoc() {
  const rows = ventureRows();
  const counts: Record<VentureStage, number> = { idea: 0, "pre-launch": 0, launched: 0 };
  for (const r of rows) {
    const stage = r.stage as VentureStage;
    if (stage in counts) counts[stage] += 1;
  }
  return { ventures: rows.map(shapeVenture), counts, stages: STAGES };
}

/* ------------------------------------------------------------- validation */

function readName(v: unknown): { name: string } | { error: string } {
  if (typeof v !== "string") return { error: "A name is required." };
  const name = v.trim();
  if (!name) return { error: "A name is required." };
  if (name.length > MAX_NAME)
    return { error: `A name is at most ${MAX_NAME} characters.` };
  return { name };
}

/** Null and "" are the same answer here and both are stored as "". The
 *  distinction the board draws between them — absent versus cleared — is a
 *  question about the PATCH, not about the column, and "what it is" is a field
 *  that is always asked, so a blank one is an answer given. */
function readDescription(v: unknown): { description: string } | { error: string } {
  if (v === null) return { description: "" };
  if (typeof v !== "string") return { error: "A description is text, or null for none." };
  if (v.length > MAX_DESCRIPTION)
    return { error: `A description is at most ${MAX_DESCRIPTION} characters.` };
  return { description: v.trim() };
}

function readStage(v: unknown): { stage: VentureStage } | { error: string } {
  if (typeof v === "string" && (STAGE_KEYS as string[]).includes(v))
    return { stage: v as VentureStage };
  return {
    error: `A stage is one of ${STAGE_KEYS.join(", ")} — ${STAGE_KEYS.map((k) => `${k}: ${STAGES[k]}`).join(" ")}`,
  };
}

/**
 * A website, normalised, or the sentence saying why it is not one.
 *
 * A bare `support.example.test` is accepted because it is what a person types; the
 * normalisation is `ventures/enrich.ts`'s, so the address stored here and the
 * address fetched are the same string by construction rather than by two
 * functions agreeing.
 */
function readWebsite(
  v: unknown,
): { website: string; host: string } | { website: null; host: null } | { error: string } {
  if (v === null) return { website: null, host: null };
  if (typeof v !== "string")
    return { error: "A website is a URL, or null for a venture with no site yet." };
  if (!v.trim()) return { website: null, host: null };
  if (v.length > MAX_WEBSITE)
    return { error: `A website address is at most ${MAX_WEBSITE} characters.` };
  const norm = normaliseWebsite(v);
  if (!norm)
    return {
      error: `“${v.trim()}” is not a web address. It wants a hostname — support.example.test, or https://support.example.test.`,
    };
  return norm;
}

function readColor(v: unknown): { color: string } | { error: string } {
  if (typeof v !== "string" || !HEX.test(v.trim()))
    return { error: "A colour is a hex like #635bff, or null to take the site's own." };
  return { color: v.trim().toLowerCase() };
}

/* -------------------------------------------------------------- identity */

/**
 * The URL segment, from the name, by the client's own rule.
 *
 * IT IS SET ONCE AND A RENAME DOES NOT MOVE IT, which is the same decision
 * `board_columns` makes with `key` beside `title` and for the same reason: a
 * link somebody kept to /ventures/example-support must not break the day the
 * business is renamed. The rule is duplicated from `client/src/lib/store.tsx`
 * — the two halves of this app share no module — and the fallback differs on
 * purpose: the client's is "board", this one's is "venture".
 */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "venture";
}

/** The same, with a numeric suffix when the address is already taken. Two
 *  ventures may share a name; they cannot share a URL. */
function uniqueSlug(name: string): string {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (db.prepare("SELECT 1 FROM ventures WHERE slug = ?").get(slug)) {
    slug = `${base.slice(0, 44)}-${n}`;
    n += 1;
  }
  return slug;
}

/** `v-` and six base36 characters, matching the four seeded ids in shape if
 *  not in spelling. Retried on the (astronomically unlikely) collision rather
 *  than trusted, because the whole point of the id is that a board card can
 *  hold it for years. */
function newId(): string {
  for (;;) {
    const id = `v-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
    if (!ventureRowById(id)) return id;
  }
}

/** The colour a venture gets when nobody has chosen one and no site has been
 *  read: the seven in order, so four ventures created in a row are four
 *  different colours rather than four rolls of the same die. */
function defaultColor(position: number): string {
  return VENTURE_COLORS[position % VENTURE_COLORS.length]!;
}

/* ------------------------------------------------------------------ reads */

ventureRoutes.get("/", (c) => c.json(venturesDoc()));

/* ------------------------------------------------------------------ order */

/**
 * The owner's order, sent whole.
 *
 * REGISTERED BEFORE `/:key`, because Hono matches in the order routes are
 * declared and `reorder` is a perfectly good key.
 *
 * A PARTIAL LIST IS ACCEPTED AND THE REST KEEP THEIR ORDER BEHIND IT. The
 * client sends what it can see, and what it can see is a page that may be a
 * few seconds old — a venture created in another tab must not lose its place
 * because the list that arrived had never heard of it. Ids that name nothing
 * are ignored for the same reason: a deleted venture in the payload is a stale
 * page, not a bad request.
 */
ventureRoutes.post("/reorder", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!body || !Array.isArray(body.ids))
    return c.json({ error: "Expected { ids: string[] } — the ventures in the order you want them." }, 400);

  const wanted = body.ids.filter((id): id is string => typeof id === "string");
  const rows = ventureRows();
  const named = wanted
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is VentureRow => r !== undefined);
  const rest = rows.filter((r) => !named.includes(r));

  db.exec("BEGIN");
  try {
    const stmt = db.prepare("UPDATE ventures SET position = ? WHERE id = ?");
    [...named, ...rest].forEach((r, i) => stmt.run(i, r.id));
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return c.json(venturesDoc());
});

/* ----------------------------------------------------------------- writes */

/**
 * Write a venture down.
 *
 * THE SITE IS READ INLINE AND THAT IS A DELIBERATE TEN SECONDS. The owner has
 * just typed an address and pressed a button; the page they land on shows the
 * icon and the colours that were read off it, which is the whole feature. Read
 * in the background instead and the first thing they see is a grey square that
 * fills in later — the same data, arriving after the moment it meant
 * something. The budget is enforced inside `enrich()`, every step of it fails
 * softly, and none of it can turn this into anything but a 201.
 */
ventureRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    description?: unknown;
    website?: unknown;
    stage?: unknown;
    color?: unknown;
  } | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const name = readName(body.name);
  if ("error" in name) return c.json({ error: name.error }, 400);

  let description = "";
  if (body.description !== undefined) {
    const d = readDescription(body.description);
    if ("error" in d) return c.json({ error: d.error }, 400);
    description = d.description;
  }

  let website: string | null = null;
  let host: string | null = null;
  if (body.website !== undefined) {
    const w = readWebsite(body.website);
    if ("error" in w) return c.json({ error: w.error }, 400);
    website = w.website;
    host = w.host;
  }

  /* Idea is the default because it is where a venture that is being written
     down for the first time usually is, and because it is the stage whose
     advice does the least harm if it is wrong. */
  let stage: VentureStage = "idea";
  if (body.stage !== undefined) {
    const s = readStage(body.stage);
    if ("error" in s) return c.json({ error: s.error }, 400);
    stage = s.stage;
  }

  const last = db.prepare("SELECT MAX(position) AS p FROM ventures").get() as {
    p: number | null;
  };
  const position = (last.p ?? -1) + 1;

  let color = defaultColor(position);
  let colorSource: "owner" | "default" = "default";
  if (body.color !== undefined && body.color !== null) {
    const col = readColor(body.color);
    if ("error" in col) return c.json({ error: col.error }, 400);
    color = col.color;
    colorSource = "owner";
  }

  const id = newId();
  const ts = now();
  db.prepare(
    `INSERT INTO ventures
       (id, slug, name, description, website, host, stage, color, color_source,
        position, brand, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
  ).run(
    id,
    uniqueSlug(name.name),
    name.name,
    description,
    website,
    host,
    stage,
    color,
    colorSource,
    position,
    ts,
    ts,
  );

  if (website) await enrichVenture(id);

  return c.json(shapeVenture(ventureRowById(id)!), 201);
});

/** One venture, by id or by slug — see `ventureRow` in db.ts for why both. */
ventureRoutes.get("/:key", (c) => {
  const row = ventureRow(c.req.param("key"));
  if (!row) return c.json({ error: "No venture by that id or slug." }, 404);
  return c.json(shapeVenture(row));
});

/**
 * Change what a venture says about itself.
 *
 * ABSENT IS UNTOUCHED, NULL IS CLEARED, and the three fields where that is a
 * real distinction each mean something different by it:
 *
 *   website: null   the site is gone, and so are the measurements taken from
 *                   it. A palette read off an address that no longer answers
 *                   is a palette about nothing, so `brand` goes back to empty
 *                   rather than becoming a fossil. A colour the OWNER chose
 *                   survives it; one that was measured cannot, so it falls
 *                   back to a default.
 *   color: null     "use the site's own" — the primary if one was measured,
 *                   otherwise one of the seven. This is how a colour stops
 *                   being the owner's without them having to pick a different
 *                   one.
 *   description: null   the same as "", because that field is always asked.
 *
 * A CHANGED WEBSITE RE-READS THE SITE, inline, on the same ten-second budget
 * the create uses. Not changed — the same string sent again — reads nothing: a
 * PATCH that resent every field would otherwise fetch a website on every
 * keystroke-saving edit, and `POST /:key/enrich` is how a re-read is ASKED
 * for.
 *
 * The slug never moves. See `slugify`.
 */
ventureRoutes.patch("/:key", async (c) => {
  const row = ventureRow(c.req.param("key"));
  if (!row) return c.json({ error: "No venture by that id or slug." }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  let reread = false;

  if (body.name !== undefined) {
    const n = readName(body.name);
    if ("error" in n) return c.json({ error: n.error }, 400);
    sets.push("name = ?");
    args.push(n.name);
  }
  if (body.description !== undefined) {
    const d = readDescription(body.description);
    if ("error" in d) return c.json({ error: d.error }, 400);
    sets.push("description = ?");
    args.push(d.description);
  }
  if (body.stage !== undefined) {
    const s = readStage(body.stage);
    if ("error" in s) return c.json({ error: s.error }, 400);
    sets.push("stage = ?");
    args.push(s.stage);
  }
  if (body.website !== undefined) {
    const w = readWebsite(body.website);
    if ("error" in w) return c.json({ error: w.error }, 400);
    if (w.website !== row.website) {
      sets.push("website = ?", "host = ?");
      args.push(w.website, w.host);
      if (w.website === null) {
        /* The measurements go with the address they were taken from. */
        sets.push("brand = ?");
        args.push("{}");
        if (row.color_source === "site") {
          sets.push("color = ?", "color_source = ?");
          args.push(defaultColor(row.position), "default");
        }
      } else reread = true;
    }
  }
  if (body.color !== undefined) {
    if (body.color === null) {
      const primary = readBrand(row.brand).palette.primary;
      sets.push("color = ?", "color_source = ?");
      args.push(primary ?? defaultColor(row.position), primary ? "site" : "default");
    } else {
      const col = readColor(body.color);
      if ("error" in col) return c.json({ error: col.error }, 400);
      sets.push("color = ?", "color_source = ?");
      args.push(col.color, "owner");
    }
  }

  if (!sets.length)
    return c.json(
      { error: "Nothing to change. Send name, description, website, stage or color." },
      400,
    );

  sets.push("updated_at = ?");
  args.push(now(), row.id);
  db.prepare(`UPDATE ventures SET ${sets.join(", ")} WHERE id = ?`).run(...args);

  /* AFTER the update, so the enricher reads the new address and sees the new
     `color_source` — a PATCH that changed both the site and "use the site's
     colour" must end with the new site's colour, not the old one's. */
  if (reread) await enrichVenture(row.id);

  return c.json(shapeVenture(ventureRowById(row.id)!));
});

/**
 * Read the site again, now.
 *
 * The one route here that measures rather than stores, and it is a POST
 * because it has an effect: it spends up to ten seconds of somebody else's
 * bandwidth and rewrites the `brand` column. It answers with the venture
 * rather than with the brand, so the caller gets the colour change that may
 * have come with it in the same document.
 */
ventureRoutes.post("/:key/enrich", async (c) => {
  const row = ventureRow(c.req.param("key"));
  if (!row) return c.json({ error: "No venture by that id or slug." }, 404);
  if (!row.website)
    return c.json(
      { error: `${row.name} has no website to read. Add one and this will have something to do.` },
      400,
    );
  const updated = await enrichVenture(row.id);
  return c.json(shapeVenture(updated ?? row));
});

/**
 * Gone.
 *
 * NOTHING CASCADES, and both of the things that point here are deliberately
 * left pointing. A board card keeps the `venture_id` it was filed under and is
 * drawn unfiled — routes/board.ts's header argues why an id that resolves to
 * nothing beats a chip naming a business that no longer exists. Chat sessions
 * are the client's own state and clear themselves. The one thing that would
 * justify a cascade — the venture's dashboards — is client state too, and the
 * page's confirm says how many go with it.
 */
ventureRoutes.delete("/:key", (c) => {
  const row = ventureRow(c.req.param("key"));
  if (!row) return c.json({ error: "No venture by that id or slug." }, 404);
  db.prepare("DELETE FROM ventures WHERE id = ?").run(row.id);
  return c.json({ ok: true });
});

/* -------------------------------------------------------------- for others */

/**
 * The venture a caller named, in the two sentences another part of this server
 * needs: what it is, and what stage it is at.
 *
 * Exported for routes/chat.ts, which prepends it as context, and shaped here
 * rather than there so the stage prose has exactly one author. Null for an id
 * that names nothing — a stale id from a client is not an error anywhere.
 */
export function ventureContext(
  id: string,
): { venture: ReturnType<typeof shapeVenture>; stageMeans: string } | null {
  const row = ventureRow(id);
  if (!row) return null;
  const venture = shapeVenture(row);
  return { venture, stageMeans: STAGES[venture.stage] ?? "" };
}
