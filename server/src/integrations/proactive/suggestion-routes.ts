import { Hono } from "hono";
import { configValue, db, ventureRows } from "../../db.ts";
import { resolveZone, validZone, zoned } from "../../shared/time.ts";
import { runThreadPage } from "../subagents/store.ts";
import { dashboardAlerts } from "./dashboard-alerts.ts";
import { selectSuggestions, type SuggestionContext } from "./suggestions.ts";
import type { HomeSuggestions } from "../../../../shared/homeSuggestions.ts";

export const suggestionRoutes = new Hono();

/** Existing local records only: opening home never starts an agent, contacts
 * a provider, refreshes a collector, or pays for a model completion. */
suggestionRoutes.get("/suggestions", async c => {
  const at = new Date();
  const requestedZone = c.req.query("timezone");
  if (requestedZone && !validZone(requestedZone)) return c.json({ error: "Choose a valid time zone." }, 400);
  const timezone = resolveZone(configValue("briefing", "timezone") || requestedZone);
  const day = zoned(timezone, at).day;
  const ventures = ventureRows();
  const ventureId = c.req.query("venture") || null;
  if (ventureId && !ventures.some(v => v.id === ventureId)) return c.json({ error: "That venture no longer exists." }, 404);
  const recent = new Date(at.getTime() - 7 * 86400_000).toISOString();
  const runSince = recent;
  const filter = ventureId ? "AND c.venture_id = ?" : "";
  const args = ventureId ? [ventureId] : [];
  const cards = db.prepare(`SELECT c.id, c.title, c.venture_id AS ventureId, c.urgency, c.due, b.title AS "column"
    FROM board_cards c JOIN board_columns b ON b.id = c.column_id
    WHERE c.archived_at IS NULL AND c.done_at IS NULL AND b.key != 'done' ${filter}
    ORDER BY c.urgency DESC, c.due IS NULL, c.due, c.updated_at DESC, c.id LIMIT 150`).all(...args) as SuggestionContext["cards"];
  const rawRuns = db.prepare(`SELECT * FROM (
    SELECT r.id, r.kind, r.title, r.venture_id, v.slug AS venture_slug, r.status,
      r.finished_at AS finishedAt, s.name AS agent,
      ROW_NUMBER() OVER (PARTITION BY r.venture_id, r.kind ORDER BY r.queued_at DESC, r.rowid DESC) AS rank
    FROM agent_runs r LEFT JOIN ventures v ON v.id = r.venture_id
    LEFT JOIN subagents s ON s.id = r.subagent_id
    ${ventureId ? "WHERE r.venture_id = ?" : ""})
    WHERE rank = 1 AND status IN ('done','failed') AND finishedAt >= ? ORDER BY finishedAt DESC LIMIT 60`)
    .all(...args, runSince) as { id: string; kind: string; title: string; venture_id: string | null; venture_slug: string | null; status: string; finishedAt: string | null; agent: string | null }[];
  const activity = db.prepare(`SELECT kind, venture_id AS ventureId, COUNT(*) AS count, MAX(ts) AS latest
    FROM activity_events WHERE ts >= ? AND ts <= ? AND kind NOT IN ('run','card','alert','infrastructure')
    ${ventureId ? "AND venture_id = ?" : ""} GROUP BY venture_id, kind ORDER BY latest DESC LIMIT 50`)
    .all(recent, at.toISOString(), ...args) as SuggestionContext["activity"];
  const journal = db.prepare(`SELECT id, text, kind, venture_id AS ventureId, day FROM work_journal
    WHERE day >= ? AND day <= ? AND kind IN ('did','shipped') ${ventureId ? "AND venture_id = ?" : ""}
    ORDER BY day DESC, id DESC LIMIT 30`).all(zoned(timezone, new Date(recent)).day, day, ...args) as SuggestionContext["journal"];
  const agents = db.prepare("SELECT id, name, title, venture_id AS ventureId FROM subagents WHERE enabled = 1 ORDER BY id").all() as SuggestionContext["agents"];
  const { alerts } = await dashboardAlerts();
  const suggestions = selectSuggestions({ day, ventureId, ventures, cards, activity, journal, agents, alerts,
    runs: rawRuns.map(r => ({ ...r, ventureId: r.venture_id, href: runThreadPage(r) })) });
  c.header("Cache-Control", "no-store");
  return c.json({ day, timezone, generatedAt: at.toISOString(), suggestions } satisfies HomeSuggestions);
});
