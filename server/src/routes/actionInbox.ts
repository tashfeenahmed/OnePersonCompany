import { Hono } from "hono";
import { db, now } from "../db.ts";
import { fileCard } from "./board.ts";
import { runPage } from "../../../shared/runRoutes.ts";
type Item = { id: string; source: string; title: string; detail: string; priority: number; at: string; href: string; venture: string | null; resolution: string };
type Row = Record<string, string | number | null>;
const select = (sql: string) => db.prepare(sql).all() as Row[];
export function inboxItems(): Item[] {
  const items: Item[] = [];
  for (const r of select("SELECT * FROM alert_events WHERE acknowledged_at IS NULL AND kind <> 'test' ORDER BY ts DESC LIMIT 500"))
    items.push({ id: `alert:${r.id}`, source: "Alert", title: String(r.message), detail: String(r.narration ?? ""), priority: 1, at: String(r.ts), href: "/alerts", venture: null, resolution: "Acknowledge" });
  for (const r of select("SELECT * FROM people_commitments WHERE status = 'open' ORDER BY due, found_at DESC LIMIT 500"))
    items.push({ id: `commitment:${r.id}`, source: "Commitment", title: String(r.what), detail: `To ${r.to_name || r.to_address}${r.due ? ` · Due ${r.due}` : ""}`, priority: r.due && String(r.due) < now() ? 1 : 2, at: String(r.found_at), href: "/people/commitments", venture: null, resolution: "Mark done" });
  for (const r of select("SELECT * FROM mailflow_triage WHERE score = 'needs_reply' AND done_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= strftime('%Y-%m-%dT%H:%M:%fZ','now')) ORDER BY scored_at DESC LIMIT 500"))
    items.push({ id: `triage:${r.account_id}:${r.thread_id}`, source: "Email", title: "Reply needed", detail: String(r.reason ?? "Review the conversation"), priority: r.urgency === "high" ? 1 : 2, at: String(r.scored_at), href: `/mail/email?thread=${encodeURIComponent(String(r.thread_id))}&account=${r.account_id}`, venture: r.venture as string | null, resolution: "Mark handled" });
  for (const r of select("SELECT * FROM agent_runs WHERE status = 'failed' ORDER BY finished_at DESC LIMIT 500"))
    items.push({ id: `run:${r.id}`, source: "Failed job", title: String(r.title), detail: String(r.error ?? "Review the job before retrying"), priority: 2, at: String(r.finished_at), href: runPage(String(r.kind), String(r.id)), venture: r.venture_id as string | null, resolution: "Dismiss from inbox" });
  for (const r of select("SELECT * FROM activity_events WHERE kind IN ('payment_failed','dispute') ORDER BY ts DESC LIMIT 500"))
    items.push({ id: `revenue:${r.key}`, source: "Revenue", title: String(r.title), detail: String(r.product ?? "Review in Activity"), priority: 1, at: String(r.ts), href: "/activity", venture: r.venture_id as string | null, resolution: "Mark reviewed" });
  const state = new Map(select("SELECT * FROM action_inbox_state").map(r => [String(r.id), r]));
  return items.filter(item => { const row = state.get(item.id); return !row?.resolved_at && (!row?.snoozed_until || String(row.snoozed_until) <= now()); })
    .sort((a, b) => a.priority - b.priority || b.at.localeCompare(a.at));
}
export const actionInboxRoutes = new Hono();
actionInboxRoutes.get("/", c => c.json({ items: inboxItems(), asOf: now() }));
actionInboxRoutes.post("/:id/:action", async c => {
  const id = c.req.param("id"), action = c.req.param("action");
  if (!["resolve", "snooze", "board"].includes(action)) return c.json({ error: "Unknown action." }, 400);
  const item = inboxItems().find(item => item.id === id);
  if (!item) return c.json({ error: "This item has already changed. Refresh the inbox." }, 409);
  if (action === "board") {
    const result = fileCard({ origin: `inbox:${id}`, title: item.title, body: `${item.detail}\n\n[Source](${item.href})`, ventureId: item.venture, urgency: item.priority === 1 ? 3 : 1 });
    return c.json({ ok: true, ...result, href: "/board" });
  }
  const ts = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (action === "resolve") {
      const [kind, ...parts] = id.split(":");
      if (kind === "alert") db.prepare("UPDATE alert_events SET acknowledged_at = ? WHERE id = ?").run(ts, parts[0]!);
      if (kind === "commitment") db.prepare("UPDATE people_commitments SET status = 'done', decided_at = ? WHERE id = ?").run(ts, parts.join(":"));
      if (kind === "triage") db.prepare("UPDATE mailflow_triage SET done_at = ? WHERE account_id = ? AND thread_id = ?").run(ts, parts[0]!, parts[1]!);
    }
    db.prepare("INSERT INTO action_inbox_state (id, resolved_at, snoozed_until) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET resolved_at=excluded.resolved_at, snoozed_until=excluded.snoozed_until")
      .run(id, action === "resolve" ? ts : null, action === "snooze" ? new Date(Date.now() + 86400000).toISOString() : null);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return c.json({ ok: true });
});
