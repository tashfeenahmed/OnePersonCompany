import { SelectField, SelectOption } from "@/components/ui/select-field";
import { useUndoActions, type UndoResult } from "@/components/interactions/UndoActions";
import { useState } from "react";
import { Link } from "react-router-dom";
import { when } from "@/lib/format";
import { inboxEmpty } from "@/lib/inboxView";
import { useApi } from "@/hooks/useApi";
import { call } from "@/lib/api";
import { PageShell, TopBar } from "@/components/PageShell";
type Item = { id: string; source: string; title: string; detail: string; priority: number; at: string; href: string; venture: string | null; resolution: string };
export function ActionInbox() {
  const { data, error, loading, reload } = useApi(() => call<{ items: Item[]; asOf: string }>("/action-inbox"));
  const undo = useUndoActions();
  const [query, setQuery] = useState(""), [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  async function act(item: Item, action: string) {
    if (action !== "board") {
      await undo.perform({ key: item.id, label: action === "snooze" ? "Snoozed for one day" : item.resolution,
        run: () => call<UndoResult>(`/action-inbox/${encodeURIComponent(item.id)}/${action}`, { method: "POST" }),
        refresh: reload });
      return;
    }
    setBusy(item.id); setNote(null);
    try { await call(`/action-inbox/${encodeURIComponent(item.id)}/${action}`, { method: "POST", body: "{}" }); setNote(action === "board" ? "Added to the board with a source link." : "Updated."); reload(); }
    catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  }
  const items = data?.items.filter(i => !undo.handled.has(i.id) && (!source || i.source === source) && `${i.title} ${i.detail}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  /* Which empty the page is in, decided by the tested helper: "every source
     is clear" and "your own view hides everything" read the same and are not
     the same fact. */
  const empty = inboxEmpty(items.length, { total: data?.items.length ?? 0, handled: undo.handled.size, filtered: !!query || !!source });
  return <><TopBar label="Action inbox" /><PageShell title="Action inbox" sub="Alerts, replies, commitments, failed jobs and payment issues, ordered by urgency.">
    <div className="flex flex-wrap gap-2 mb-4"><input aria-label="Search action inbox" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search actions…" className="border rounded p-2" /><SelectField aria-label="Filter by source" value={source} onValueChange={(value) => setSource(value)} className="border rounded p-2"><SelectOption value="">All sources</SelectOption>{["Alert", "Email", "Commitment", "Failed job", "Revenue"].map(s => <SelectOption key={s} value={s}>{s}</SelectOption>)}</SelectField><button className="rounded-lg px-3.5 bg-muted hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] transition-colors disabled:opacity-50" disabled={loading} onClick={reload}>Refresh</button></div>
    {(error || note) && <p role="status" className="mb-3 text-sm">{error || note}</p>}
    {loading && !data && <p role="status">Loading actions…</p>}
    {data && empty.kind === "clear" && <div className="rounded-xl bg-card p-6"><p className="font-medium">Nothing is waiting for you.</p><p className="text-sm text-muted-foreground mt-1">No open alerts, replies, commitments, failed jobs or payment issues. New ones appear here as they arrive.</p></div>}
    {data && empty.kind === "view-empty" && <p role="status">{empty.hidden === 0 ? "Nothing left in this view." : (query || source) ? `All ${empty.hidden} open ${empty.hidden === 1 ? "action is" : "actions are"} hidden by your search and filters.` : `You have handled all ${empty.hidden} open ${empty.hidden === 1 ? "action" : "actions"} from this screen.`} {(query || source) && <> <button className="underline" onClick={() => { setQuery(""); setSource(""); }}>Clear the view</button> to see them,</>} <button className="underline" onClick={reload}>refresh</button> for anything new.</p>}
    <div className="space-y-3">{items.map(item => <article key={item.id} className="bg-card rounded-xl p-4"><div className="text-xs text-muted-foreground">{item.source} · {item.priority === 1 ? "High priority" : "Normal priority"} · {when(item.at, { year: true })}</div><h2 className="font-medium mt-1">{item.title}</h2><p className="text-sm mt-1">{item.detail}</p><div className="flex flex-wrap gap-3 mt-3 text-sm"><Link className="underline" to={item.href}>Open source</Link><button disabled={busy === item.id || undo.busy.has(item.id)} className="underline" onClick={() => void act(item, "resolve")}>{item.resolution}</button><button disabled={busy === item.id || undo.busy.has(item.id)} className="underline" onClick={() => void act(item, "snooze")}>Snooze 1 day</button><button disabled={busy === item.id || undo.busy.has(item.id)} className="underline" onClick={() => void act(item, "board")}>Add to board</button></div></article>)}</div>
  </PageShell></>;
}
