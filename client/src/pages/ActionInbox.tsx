import { useState } from "react";
import { Link } from "react-router-dom";
import { when } from "@/lib/format";
import { useApi } from "@/hooks/useApi";
import { call } from "@/lib/api";
import { PageShell, TopBar } from "@/components/PageShell";
type Item = { id: string; source: string; title: string; detail: string; priority: number; at: string; href: string; venture: string | null; resolution: string };
export function ActionInbox() {
  const { data, error, loading, reload } = useApi(() => call<{ items: Item[]; asOf: string }>("/action-inbox"));
  const [query, setQuery] = useState(""), [source, setSource] = useState("");
  const [busy, setBusy] = useState<string | null>(null), [note, setNote] = useState<string | null>(null);
  async function act(item: Item, action: string) {
    setBusy(item.id); setNote(null);
    try { await call(`/action-inbox/${encodeURIComponent(item.id)}/${action}`, { method: "POST", body: "{}" }); setNote(action === "board" ? "Added to the board with a source link." : "Updated."); reload(); }
    catch (error) { setNote(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  }
  const items = data?.items.filter(i => (!source || i.source === source) && `${i.title} ${i.detail}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <><TopBar label="Action inbox" /><PageShell title="Action inbox" sub="Alerts, replies, commitments, failed jobs and payment issues, ordered by urgency.">
    <div className="flex flex-wrap gap-2 mb-4"><input aria-label="Search action inbox" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search actions…" className="border rounded p-2" /><select aria-label="Filter by source" value={source} onChange={e => setSource(e.target.value)} className="border rounded p-2"><option value="">All sources</option>{["Alert", "Email", "Commitment", "Failed job", "Revenue"].map(s => <option key={s}>{s}</option>)}</select><button className="rounded-lg px-3.5 bg-muted hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] transition-colors disabled:opacity-50" disabled={loading} onClick={reload}>Refresh</button></div>
    {(error || note) && <p role="status" className="mb-3 text-sm">{error || note}</p>}
    {loading && !data && <p role="status">Loading actions…</p>}
    {data && !items.length && <p>No open actions match this view.</p>}
    <div className="space-y-3">{items.map(item => <article key={item.id} className="rounded-xl border p-4"><div className="text-xs text-muted-foreground">{item.source} · {item.priority === 1 ? "High priority" : "Normal priority"} · {when(item.at, { year: true })}</div><h2 className="font-medium mt-1">{item.title}</h2><p className="text-sm mt-1">{item.detail}</p><div className="flex flex-wrap gap-3 mt-3 text-sm"><Link className="underline" to={item.href}>Open source</Link><button disabled={busy === item.id} className="underline" onClick={() => void act(item, "resolve")}>{item.resolution}</button><button disabled={busy === item.id} className="underline" onClick={() => void act(item, "snooze")}>Snooze 1 day</button><button disabled={busy === item.id} className="underline" onClick={() => void act(item, "board")}>Add to board</button></div></article>)}</div>
  </PageShell></>;
}
