import { Hono } from "hono";
import { configValue, db, now, ventureRows } from "../../db.ts";
import { calendarDay, JOURNAL_KINDS, validDay, workStats, type JournalEntry, type JournalKind } from "../../../../shared/workJournal.ts";

export const journalRoutes = new Hono();
export function journalZone() { return configValue("briefing", "timezone") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
const columns = "id, day, kind, text, venture_id AS ventureId, created_at AS createdAt, updated_at AS updatedAt";

journalRoutes.get("/", c => {
  const timezone = journalZone(), today = calendarDay(new Date(), timezone);
  const venture = c.req.query("venture") || null;
  const where = venture ? "WHERE venture_id = ?" : "";
  const args = venture ? [venture] : [];
  const offset = Math.max(0, Math.floor(Number(c.req.query("offset")) || 0));
  const entries = db.prepare(`SELECT ${columns} FROM work_journal ${where} ORDER BY day DESC, id DESC LIMIT 100 OFFSET ?`).all(...args, offset);
  const counts = db.prepare(`SELECT day, COUNT(*) AS n FROM work_journal WHERE kind IN ('did','shipped') ${venture ? "AND venture_id = ?" : ""} GROUP BY day`).all(...args) as { day: string; n: number }[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM work_journal ${where}`).get(...args) as { n: number }).n;
  return c.json({ entries, total, today, timezone, stats: workStats(counts, today) });
});

function validate(raw: unknown): { value: { day: string; kind: JournalKind; text: string; ventureId: string | null } } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Expected a journal entry." };
  const b = raw as Record<string, unknown>;
  if (!validDay(b.day) || b.day > calendarDay(new Date(), journalZone())) return { error: "Choose a real calendar date, today or earlier." };
  if (!JOURNAL_KINDS.includes(b.kind as JournalKind)) return { error: "Choose did, shipped, dismissed, or note." };
  if (typeof b.text !== "string" || !b.text.trim() || b.text.trim().length > 8000) return { error: "Write between 1 and 8,000 characters." };
  if (b.ventureId != null && !ventureRows().some(v => v.id === b.ventureId)) return { error: "Choose an existing venture." };
  return { value: { day: b.day, kind: b.kind as JournalKind, text: b.text.trim(), ventureId: b.ventureId as string | null ?? null } };
}

journalRoutes.post("/", async c => {
  const parsed = validate(await c.req.json().catch(() => null));
  if ("error" in parsed) return c.json(parsed, 400);
  const e = parsed.value, at = now();
  const result = db.prepare("INSERT INTO work_journal (day, kind, text, venture_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(e.day, e.kind, e.text, e.ventureId, at, at);
  return c.json({ entry: db.prepare(`SELECT ${columns} FROM work_journal WHERE id = ?`).get(Number(result.lastInsertRowid)) }, 201);
});
journalRoutes.patch("/:id", async c => {
  const id = Number(c.req.param("id"));
  const held = db.prepare(`SELECT ${columns} FROM work_journal WHERE id = ?`).get(id) as JournalEntry | undefined;
  if (!held) return c.json({ error: "Journal entry not found." }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "Expected a journal entry." }, 400);
  const parsed = validate({ ...held, ...body });
  if ("error" in parsed) return c.json(parsed, 400);
  const e = parsed.value;
  db.prepare("UPDATE work_journal SET day = ?, kind = ?, text = ?, venture_id = ?, updated_at = ? WHERE id = ?").run(e.day, e.kind, e.text, e.ventureId, now(), id);
  return c.json({ entry: db.prepare(`SELECT ${columns} FROM work_journal WHERE id = ?`).get(id) });
});
journalRoutes.delete("/:id", c => {
  const result = db.prepare("DELETE FROM work_journal WHERE id = ?").run(Number(c.req.param("id")));
  return result.changes ? c.json({ ok: true }) : c.json({ error: "Journal entry not found." }, 404);
});
