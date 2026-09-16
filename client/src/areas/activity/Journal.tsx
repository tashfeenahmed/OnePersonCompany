import { SelectField, SelectOption } from "@/components/ui/select-field";
import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { call } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { JOURNAL_KINDS, type JournalEntry, type JournalKind, type JournalReport } from "../../../../shared/workJournal";

export function Journal() {
  const { state } = useStore();
  const [venture, setVenture] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, error, reload } = useApi(() => call<JournalReport>(`/journal?offset=${offset}&venture=${encodeURIComponent(venture)}`), [venture, offset]);
  const [editing, setEditing] = useState<JournalEntry | null>(null);
  const [kind, setKind] = useState<JournalKind>("did");
  const [day, setDay] = useState("");
  const [text, setText] = useState("");
  const [entryVenture, setEntryVenture] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [deleting, setDeleting] = useState<number | null>(null);
  const reset = () => { setEditing(null); setText(""); setDay(""); setKind("did"); setEntryVenture(""); };
  async function write(fn: () => Promise<unknown>) {
    setBusy(true); setFailure("");
    try { await fn(); reload(); } catch (e) { setFailure(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  if (!data) return <p className="text-sm text-muted-foreground">{error || "Loading your journal…"}</p>;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4">
      {[ [data.stats.today, "logged today"], [data.stats.current, "day streak"], [data.stats.best, "best streak"] ].map(([value, label]) => <div key={label}><strong className="block text-2xl tabular-nums">{value}</strong><span className="text-xs text-muted-foreground">{label}</span></div>)}
      <label className="ml-auto text-sm">Venture <SelectField className="ml-2 rounded-lg border bg-background p-2" value={venture} onValueChange={(value) => { setVenture(value); setOffset(0); }}><SelectOption value="">All ventures</SelectOption>{state.ventures.map(v => <SelectOption key={v.id} value={v.id}>{v.name}</SelectOption>)}</SelectField></label>
      <div className="w-full"><div className="grid w-fit grid-flow-col auto-cols-[14px] grid-rows-7 gap-1" aria-label="Work logged over the last 91 days">{data.stats.heatmap.map(d => <div key={d.day} title={`${d.day}: ${d.n} work entries`} className="h-3.5 rounded-[3px]" style={{ background: d.n ? "var(--chart-line-1)" : "var(--muted)", opacity: d.n ? Math.min(1, 0.35 + d.n * 0.16) : 1 }} />)}</div><p className="mt-2 text-xs text-muted-foreground">Did and shipped entries count toward streaks. Notes and dismissals stay in the journal. Dates use {data.timezone}; change the workspace time zone in Briefing settings.</p></div>
    </div>
    <form className="space-y-3 rounded-xl border bg-card p-4" onSubmit={e => { e.preventDefault(); void write(async () => { await call(`/journal${editing ? `/${editing.id}` : ""}`, { method: editing ? "PATCH" : "POST", body: JSON.stringify({ day: day || data.today, kind, text, ventureId: entryVenture || null }) }); reset(); }); }}>
      <h2 className="font-medium">{editing ? "Edit journal entry" : "What did you work on?"}</h2>
      <div className="flex flex-wrap gap-2">
        <SelectField aria-label="Entry type" className="rounded-lg border bg-background p-2 text-sm" value={kind} onValueChange={(value) => setKind(value as JournalKind)}>{JOURNAL_KINDS.map(k => <SelectOption key={k} value={k}>{k}</SelectOption>)}</SelectField>
        <Input aria-label="Work date" type="date" className="w-auto" max={data.today} value={day || data.today} onChange={e => setDay(e.target.value)} required />
        <SelectField aria-label="Entry venture" className="rounded-lg border bg-background p-2 text-sm" value={entryVenture} onValueChange={(value) => setEntryVenture(value)}><SelectOption value="">No venture</SelectOption>{state.ventures.map(v => <SelectOption key={v.id} value={v.id}>{v.name}</SelectOption>)}</SelectField>
      </div>
      <Textarea aria-label="Journal entry" placeholder="Shipped a release, talked with a customer, fixed a bug…" maxLength={8000} value={text} onChange={e => setText(e.target.value)} required />
      <Button disabled={busy || !text.trim()} type="submit">{busy ? "Saving…" : editing ? "Save changes" : "Log work"}</Button>{editing && <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>}
    </form>
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
    <div className="divide-y">{data.entries.map(entry => <article key={entry.id} className="py-4">
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{entry.day}</span><span className="font-medium uppercase">{entry.kind}</span><span>{state.ventures.find(v => v.id === entry.ventureId)?.name}</span>
        <button className="ml-auto" onClick={() => { setEditing(entry); setKind(entry.kind); setText(entry.text); setDay(entry.day); setEntryVenture(entry.ventureId ?? ""); }}>Edit</button>
        {deleting === entry.id ? <><button disabled={busy} className="text-destructive" onClick={() => void write(async () => { await call(`/journal/${entry.id}`, { method: "DELETE" }); setDeleting(null); if (editing?.id === entry.id) reset(); })}>Confirm delete</button><button onClick={() => setDeleting(null)}>Cancel</button></> : <button onClick={() => setDeleting(entry.id)}>Delete</button>}
      </div><p className="mt-2 whitespace-pre-wrap break-words text-sm">{entry.text}</p>
    </article>)}{!data.total && <p className="text-sm text-muted-foreground">Your work journal starts with your first entry.</p>}</div>
    <div className="flex gap-2"><Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>Newer</Button><Button variant="outline" disabled={offset + data.entries.length >= data.total} onClick={() => setOffset(offset + 100)}>Older</Button></div>
  </div>;
}
