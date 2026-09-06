import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { call } from "@/lib/api";
import { runPage } from "../../../../shared/runRoutes";
type QueueDoc = { paused: boolean; queue: { id: string; title: string; kind: string; paused: number }[] };
export function QueueControls() {
  const doc = useApi(() => call<QueueDoc>("/runs/controls"));
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { const timer = setInterval(doc.reload, 10000); return () => clearInterval(timer); }, [doc.reload]);
  async function change(path: string, body: unknown, method = "PUT") {
    setBusy(true); setError(null);
    try { await call(path, { method, body: JSON.stringify(body) }); doc.reload(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section className="border rounded-xl p-3 mb-4 space-y-2">
    <div className="flex flex-wrap gap-3 items-center"><h2 className="font-medium text-sm">Queue controls</h2><button className="rounded-lg px-3 py-1.5 text-sm bg-muted hover:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_6%)] transition-colors disabled:opacity-50" disabled={!doc.data || busy} onClick={() => void change("/runs/controls", { paused: !doc.data?.paused })}>{doc.data?.paused ? "Resume queue" : "Pause queue"}</button><Link className="underline text-sm" to="/settings?tab=budgets">Usage limits</Link></div>
    <p className="text-xs text-muted-foreground">Pausing holds waiting jobs; the current job can finish.</p>
    {(error || doc.error) && <p role="alert" className="text-sm text-destructive">{error || doc.error}</p>}
    {doc.data?.queue.map((job, index, jobs) => <div key={job.id} className="flex flex-wrap gap-2 items-center border-t py-2 text-sm"><Link className="flex-1 min-w-0" to={runPage(job.kind, job.id)}>{index + 1}. {job.title}</Link><button disabled={busy} className="underline" onClick={() => void change(`/runs/${job.id}/pause`, { paused: !job.paused }, "POST")}>{job.paused ? "Resume job" : "Hold job"}</button>{[-1, 1].map(direction => <button key={direction} aria-label={`${direction === -1 ? "Move earlier" : "Move later"}: ${job.title}`} disabled={busy || index + direction < 0 || index + direction >= jobs.length} className="border rounded px-2 disabled:opacity-30" onClick={() => { const ids = jobs.map(j => j.id); ids.splice(index, 1); ids.splice(index + direction, 0, job.id); void change("/runs/order", { ids }); }}>{direction === -1 ? "↑" : "↓"}</button>)}</div>)}
  </section>;
}
