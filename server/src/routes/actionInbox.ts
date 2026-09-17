/**
 * THE ACTION INBOX — one list of everything on this box waiting for the owner,
 * and one place to answer it from.
 *
 * IT OWNS NOTHING. Every row it draws belongs to an area that already has a
 * table, a reader and a write verb, so the reads and the writes go through
 * those rather than through SQL of its own. Three things went wrong when they
 * did not:
 *
 *   - "An open alert" had three hand-written definitions — the area's, this
 *     file's and the nightly proposal's — which already differed on which
 *     kinds count. Three counts on three surfaces and nothing to say which was
 *     right. `openEvents()` is the definition now.
 *   - Acknowledging, deciding and marking an email handled were re-implemented
 *     here as raw UPDATEs, so anything an area adds to its verb later — a
 *     second column, an audit row, a refusal — silently did not happen when
 *     the same button was pressed from here. The board case always did this
 *     right by importing `fileCard`; the rest now match.
 *   - SNOOZING NOW WRITES THROUGH. This read the mail triage's own snooze
 *     column for visibility but wrote only its own, so snoozing an email here
 *     hid it here for a hard-coded 24 hours and left it fully visible on the
 *     Mail page. Two states, one item, one direction. The source table owns
 *     the state wherever it has one, exactly as resolve already did;
 *     `action_inbox_state` is the fallback for the kinds with nowhere else.
 */
import { undoable, undoAction, UndoError, type UndoReceipt } from "../actions/undo.ts";
import { Hono } from "hono";
import { db, now } from "../db.ts";
import { fileCard } from "./board.ts";
import { runPage } from "../../../shared/runRoutes.ts";
import { ackEvent, openEvents } from "../integrations/proactive/store.ts";
import { commitmentRows, decide } from "../integrations/people/commitments.ts";
import { markThread } from "../integrations/mailflow/triage.ts";

type Item = { id: string; source: string; title: string; detail: string; priority: number; at: string; href: string; venture: string | null; resolution: string };
type Row = Record<string, string | number | null>;
const select = (sql: string) => db.prepare(sql).all() as Row[];

/** How many of any one kind reach the list. A cap rather than everything: this
 *  is a list a person reads, and the ordering below is what decides which of
 *  them they read first. */
const PER_KIND = 500;

/** How long a snooze lasts when the item's own area has no setting for it. */
const SNOOZE_MS = 86_400_000;

export function inboxItems(): Item[] {
  const items: Item[] = [];
  for (const e of openEvents({ limit: PER_KIND }))
    items.push({ id: `alert:${e.id}`, source: "Alert", title: e.message, detail: e.narration ?? "", priority: 1, at: e.ts, href: "/alerts", venture: null, resolution: "Acknowledge" });
  for (const r of commitmentRows("open").slice(0, PER_KIND))
    items.push({ id: `commitment:${r.id}`, source: "Commitment", title: r.what, detail: `To ${r.to_name || r.to_address}${r.due ? ` · Due ${r.due}` : ""}`, priority: r.due && r.due < now() ? 1 : 2, at: r.found_at, href: "/mail/commitments", venture: null, resolution: "Mark done" });
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
actionInboxRoutes.post("/undo/:token", c => {
  try { undoAction(c.req.param("token")); return c.json({ ok: true }); }
  catch (error) { if (error instanceof UndoError) return c.json({ error: error.message }, error.status); throw error; }
});
actionInboxRoutes.post("/:id/:action", async c => {
  const id = c.req.param("id"), action = c.req.param("action");
  if (!["resolve", "snooze", "board"].includes(action)) return c.json({ error: "Unknown action." }, 400);
  const item = inboxItems().find(item => item.id === id);
  if (!item) return c.json({ error: "This item has already changed. Refresh the inbox." }, 409);
  if (action === "board") {
    // Automatic health cards use stable issue IDs; the inbox uses alert event
    // IDs. Both surfaces must recognise the same already-filed work.
    const aliases = item.source === "Alert"
      ? (await (await import("../board/sources.ts")).healthCandidates())
        .filter(candidate => candidate.aliases?.includes(`inbox:${id}`)).map(candidate => candidate.origin)
      : [];
    const result = fileCard({ origin: `inbox:${id}`, aliases, title: item.title, body: `${item.detail}\n\n[Source](${item.href})`, ventureId: item.venture, urgency: item.priority === 1 ? 3 : 1 });
    return c.json({ ok: true, ...result, href: "/board" });
  }
  const ts = now();
  const until = new Date(Date.now() + SNOOZE_MS).toISOString();
  const [kind, ...parts] = id.split(":");
  /* Whether the source table took the state itself. When it did, the inbox's
     own row is left clear rather than written with a second copy that the two
     surfaces could then disagree about. */
  let wroteThrough = false;
  let undo: UndoReceipt | null = null;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (kind === "alert" && action === "resolve") { undo = undoable("alert", [Number(parts[0])], () => ackEvent(Number(parts[0]))).undo; wroteThrough = true; }
    if (kind === "commitment" && action === "resolve") { undo = undoable("commitment", [parts.join(":")], () => decide(parts.join(":"), "done")).undo; wroteThrough = true; }
    /* Mailflow's own verb. An omitted field keeps what is stored, so snoozing
       from here cannot clear a "done" set on the Mail page. */
    if (kind === "triage") {
      undo = undoable("triage", [Number(parts[0]), parts.slice(1).join(":")], () => markThread(Number(parts[0]), parts.slice(1).join(":"), action === "snooze" ? { snoozedUntil: until } : { doneAt: ts })).undo;
      wroteThrough = true;
    }
    if (!wroteThrough)
      undo = undoable("inbox", [id], () => db.prepare("INSERT INTO action_inbox_state (id, resolved_at, snoozed_until) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET resolved_at=excluded.resolved_at, snoozed_until=excluded.snoozed_until")
        .run(id, action === "resolve" ? ts : null, action === "snooze" ? until : null)).undo;
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return c.json({ ok: true, wroteThrough, undo });
});
