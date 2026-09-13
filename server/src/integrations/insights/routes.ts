import { Hono } from "hono";
import { db, ventureRows } from "../../db.ts";
import { validDay } from "../../../../shared/workJournal.ts";
import type { MetricSeries } from "../../../../shared/insights.ts";
import { importedSources, insightsReport } from "./data.ts";
import { insightSettings, saveSettings, validateSettings } from "./settings.ts";

export const insightRoutes = new Hono();
insightRoutes.get("/", async c => c.json(await insightsReport()));
insightRoutes.get("/settings", c => c.json(insightSettings()));
insightRoutes.patch("/settings", async c => {
  const body = await c.req.json().catch(() => null), problem = validateSettings(body);
  if (problem) return c.json({ error: problem }, 400);
  return c.json(saveSettings(body));
});
insightRoutes.get("/sources", c => c.json({ sources: importedSources() }));

/** A bounded upsert contract for external integrations, scripts, and the data import form. */
export function validateSeries(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Expected a source with daily points.";
  const s = raw as MetricSeries;
  if (typeof s.id !== "string" || !/^[a-zA-Z0-9._:-]{1,120}$/.test(s.id)) return "Source id: 1–120 letters, digits, dots, colons, dashes or underscores.";
  if (typeof s.label !== "string" || !s.label.trim() || s.label.length > 200) return "A label of 1–200 characters is required.";
  if (!["mrr", "users", "signups", "pageviews", "custom"].includes(s.metric)) return "Metric must be mrr, users, signups, pageviews, or custom.";
  if (typeof s.unit !== "string" || !s.unit.trim() || s.unit.length > 30) return "A unit is required (for example USD, users, views).";
  if (s.metric === "mrr" && !/^[A-Z]{3}$/.test(s.unit)) return "MRR uses one uppercase currency code per source, such as EUR.";
  if (s.ventureId != null && !ventureRows().some(v => v.id === s.ventureId)) return "ventureId must name an existing venture, or be null.";
  if (!validDay(s.completeThrough) || s.completeThrough >= new Date().toISOString().slice(0, 10)) return "completeThrough must be a completed calendar day before today.";
  if (typeof s.observedAt !== "string" || !Number.isFinite(Date.parse(s.observedAt)) || Date.parse(s.observedAt) > Date.now() + 60000) return "observedAt must be the actual collection timestamp, not a future date.";
  if (!Array.isArray(s.points) || s.points.length > 400 || !s.points.length) return "Supply 1–400 daily observations.";
  const days = new Set<string>();
  for (const p of s.points) {
    if (!p || !validDay(p.day) || p.day > s.completeThrough || days.has(p.day)) return "Each point needs a unique date at or before completeThrough.";
    if (p.value !== null && (typeof p.value !== "number" || !Number.isFinite(p.value) || (s.metric !== "custom" && p.value < 0))) return "Values must be finite numbers, or null for an unavailable measurement; counts and MRR cannot be negative.";
    days.add(p.day);
  }
  return null;
}
insightRoutes.post("/sources", async c => {
  const body = await c.req.json().catch(() => null), problem = validateSeries(body);
  if (problem) return c.json({ error: problem }, 400);
  const s = body as MetricSeries, id = s.id.startsWith("import:") ? s.id : `import:${s.id}`;
  const held = db.prepare("SELECT metric, unit, venture_id, observed_at FROM insight_sources WHERE id = ?").get(id) as { metric: string; unit: string; venture_id: string | null; observed_at: string } | undefined;
  if (held && (held.metric !== s.metric || held.unit !== s.unit || held.venture_id !== (s.ventureId ?? null))) return c.json({ error: "Changing a source's metric, unit or venture would mix histories. Use a new source id." }, 409);
  if (held && Date.parse(held.observed_at) > Date.parse(s.observedAt!)) return c.json({ error: "This upload is older than the latest collected source." }, 409);
  db.exec("BEGIN");
  try {
    db.prepare(`INSERT INTO insight_sources (id,label,source,venture_id,metric,unit,observed_at,complete_through) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, observed_at=excluded.observed_at, complete_through=excluded.complete_through`)
      .run(id, s.label.trim(), "insights", s.ventureId ?? null, s.metric, s.unit, s.observedAt, s.completeThrough);
    const insert = db.prepare("INSERT INTO insight_points (source_id,day,value) VALUES (?,?,?) ON CONFLICT(source_id,day) DO UPDATE SET value=excluded.value");
    for (const p of s.points) insert.run(id, p.day, p.value);
    db.prepare("DELETE FROM insight_points WHERE source_id = ? AND day < date(?, '-400 days')").run(id, s.completeThrough);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return c.json({ id, received: s.points.length }, 201);
});
insightRoutes.delete("/sources/:id", c => {
  const id = c.req.param("id");
  if (!id.startsWith("import:")) return c.json({ error: "Built-in sources are managed by their integration." }, 400);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM insight_points WHERE source_id = ?").run(id);
    db.prepare("DELETE FROM insight_sources WHERE id = ?").run(id);
    // Keep incident evidence; stop evaluating a deliberately removed source.
    db.prepare("UPDATE alert_rules SET enabled = 0 WHERE managed_source = ?").run(id);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return c.json({ ok: true });
});
