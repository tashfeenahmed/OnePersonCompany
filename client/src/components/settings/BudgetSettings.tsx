import { useEffect, useState } from "react";
import { useApi } from "@/hooks/useApi";
import { call } from "@/lib/api";
const fields = [
  ["runSeconds", "Maximum job runtime (seconds)"], ["runCalls", "Model calls per job"], ["dailyCalls", "Model calls per UTC day"], ["automationDailyCalls", "Scheduled model calls per UTC day"],
  ["maxOutputTokens", "Maximum output tokens per model call"], ["runTokens", "Token budget per job"], ["dailyTokens", "Daily token budget"], ["ventureDailyTokens", "Daily token budget per venture"],
  ["usdPerMillion", "Price ceiling: USD per million tokens"], ["runUsd", "Dollar budget per job"], ["dailyUsd", "Daily dollar budget"], ["ventureDailyUsd", "Daily dollar budget per venture"],
];
type Doc = { budgets: Record<string, number>; usage: {runId: string; calls: number; tokens: number; usd: number; estimatedCalls: number}[] };
export function BudgetSettings() {
  const doc = useApi(() => call<Doc>("/runs/controls"));
  const [form, setForm] = useState<Record<string, number> | null>(null), [note, setNote] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { if (doc.data) setForm(doc.data.budgets); }, [doc.data]);
  return <section className="py-5 space-y-4"><h2 className="text-lg">Job and automation budgets</h2>
    <p className="text-sm max-w-3xl">Limits include requests already in progress. Zero disables a token or dollar limit; zero model calls stops model work. Dollar accounting uses your price ceiling, so set it at least as high as your model's input and output prices. These are estimates, not provider billing totals.</p>
    <p className="text-sm max-w-3xl">Agents with unmetered tools, video jobs and screenshot QA cannot run with token or dollar limits enabled. Their costs cannot be bounded by this app. Failed requests keep their usage reservations. Daily allowances reset at midnight UTC.</p>
    {(doc.error || note) && <p role="status" className="text-sm">{doc.error || note}</p>}
    {form && <form onSubmit={async e => { e.preventDefault(); setBusy(true); try { await call("/runs/controls", { method: "PUT", body: JSON.stringify({ budgets: form }) }); setNote("Limits saved."); doc.reload(); } catch (error) { setNote(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([key, label]) => <label key={key} className="text-sm">{label}<input type="number" min={0} step={key!.toLowerCase().includes("usd") ? "0.01" : "1"} required value={form[key!] ?? 0} onChange={e => setForm(f => ({ ...f, [key!]: Number(e.target.value) }))} className="block w-full border rounded p-2 mt-1" /></label>)}</div><button disabled={busy} className="mt-4 rounded-lg px-4 py-2 bg-muted hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] transition-colors disabled:opacity-50">Save limits</button>
    </form>}
    <h3 className="font-medium">Today's usage</h3><div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr><th>Job</th><th>Calls</th><th>Tokens</th><th>Budgeted USD</th><th>Estimated calls</th></tr></thead><tbody>{doc.data?.usage.map(u => <tr key={u.runId}><td className="py-2">{u.runId}</td><td>{u.calls}</td><td>{u.tokens.toLocaleString()}</td><td>{u.usd.toFixed(4)}</td><td>{u.estimatedCalls}</td></tr>)}</tbody></table></div>
  </section>;
}
