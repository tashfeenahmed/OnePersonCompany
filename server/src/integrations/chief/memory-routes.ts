/**
 * `/api/memory` — the notes, and the two buttons that tidy them.
 *
 * THE OWNER'S EDITS WIN, and the routes are where that is enforced rather than
 * hoped for. A PATCH from the page stamps the note `owner`, and an owner note
 * is out of the consolidation pass's reach for good. That is the difference
 * between an assistant that keeps notes and one that keeps its own opinion of
 * the owner's corrections.
 *
 * CONSOLIDATE AND UNDO ARE BOTH ROUTES ON PURPOSE. The pass is on a weekly
 * timer, which is where it belongs; the buttons exist because a weekly pass
 * whose only trigger is a timer is a feature nobody can test, and because an
 * undo that is only reachable by waiting a week is not an undo.
 */
import { Hono } from "hono";
import { ventureRow } from "../../db.ts";
import {
  CONTEXT_NOTES,
  MAX_NOTE,
  MAX_NOTES,
  consolidate,
  editNote,
  forget,
  isoWeek,
  noteCount,
  noteRow,
  notes,
  passes,
  remember,
  shapeNote,
  undo,
  undoable,
  versions,
} from "./memory.ts";

export const memoryRoutes = new Hono();

memoryRoutes.get("/", (c) => {
  const scope = c.req.query("scope") ?? undefined;
  const ventureId = c.req.query("venture") ?? undefined;
  const list = notes({ scope, ventureId });
  const v = undoable();
  return c.json({
    count: list.length,
    total: noteCount(),
    notes: list,
    limits: { maxNote: MAX_NOTE, maxNotes: MAX_NOTES, injectedIntoChat: CONTEXT_NOTES },
    week: isoWeek(),
    passes: passes(),
    versions: versions(),
    /* Whether the undo button does anything, said rather than left for a
       client to work out of the version list. */
    canUndo: v ? { versionId: v.id, takenAt: v.taken_at, reason: v.reason } : null,
    note:
      "Every note is a dated belief, not a measurement: who formed it and when " +
      "it was last confirmed are part of the note. Quote one with its age.",
  });
});

memoryRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { text?: unknown; scope?: unknown; venture?: unknown; ventureId?: unknown; source?: unknown }
    | null;
  if (!body) return c.json({ error: "Expected { text }." }, 400);
  const key =
    (typeof body.ventureId === "string" && body.ventureId.trim()) ||
    (typeof body.venture === "string" && body.venture.trim()) ||
    "";
  /* A slug is accepted where an id is, for subagents/routes.ts's reason: a key
     is a key, and refusing one of the two spellings is a 404 that is really a
     vocabulary. */
  const id = key ? resolveVenture(key) : "";
  if (key && !id) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);

  const out = remember({
    text: typeof body.text === "string" ? body.text : "",
    scope: typeof body.scope === "string" ? body.scope : id ? "venture" : "global",
    ventureId: id,
    source: typeof body.source === "string" ? body.source : "agent",
  });
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json({ note: out.note, confirmed: out.confirmed }, out.confirmed ? 200 : 201);
});

memoryRoutes.patch("/:id", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { text?: unknown; scope?: unknown; venture?: unknown; ventureId?: unknown; by?: unknown }
    | null;
  if (!body) return c.json({ error: "Expected { text?, scope?, venture? }." }, 400);
  const key =
    (typeof body.ventureId === "string" && body.ventureId.trim()) ||
    (typeof body.venture === "string" && body.venture.trim()) ||
    "";
  const id = key ? resolveVenture(key) : undefined;
  if (key && !id) return c.json({ error: `No venture by the id or slug "${key}".` }, 404);

  const out = editNote(c.req.param("id"), {
    text: typeof body.text === "string" ? body.text : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    ventureId: id,
    /* Default `owner`, because the page is the overwhelmingly common caller
       and an edit made there is the owner's. An agent correcting its own note
       says so explicitly. */
    by: body.by === "agent" ? "agent" : "owner",
  });
  if (!out.ok) return c.json({ error: out.error }, out.status);
  return c.json(out.note);
});

memoryRoutes.delete("/:id", (c) => {
  const id = c.req.param("id");
  const row = noteRow(id);
  if (!row) return c.json({ error: "No note by that id." }, 404);
  const gone = shapeNote(row);
  forget(id);
  /* The note is returned as it was. A delete that answered `{ ok: true }`
     would make an accidental one unrecoverable even from the response. */
  return c.json({ deleted: gone, remaining: noteCount() });
});

memoryRoutes.post("/consolidate", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { force?: unknown } | null;
  const out = await consolidate({ force: body?.force === true || body?.force === "true" });
  return c.json({
    ...out,
    canUndo: out.versionId !== null,
    note:
      "A pass merges duplicates and drops stale notes; it never touches a note " +
      "the owner wrote or corrected. The whole set as it was is kept, and " +
      "POST /api/memory/undo puts it back.",
  });
});

memoryRoutes.post("/undo", (c) => {
  const out = undo();
  if (!out.ok) return c.json({ error: out.error }, 409);
  return c.json({ ...out, total: noteCount(), notes: notes() });
});

/** A venture id or slug, resolved to an id, or "" for neither. `ventureRow`
 *  takes both spellings, which is why a caller here never has to know which
 *  one it is holding. */
function resolveVenture(key: string): string {
  return ventureRow(key)?.id ?? "";
}
