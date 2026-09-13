import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "@/hooks/useApi";
import { call } from "@/lib/api";
import { PageShell, TopBar } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PacePanel, DormantPanel } from "@/components/insights/InsightPanels";
import type { InsightSettings, InsightsReport } from "../../../shared/insights";

const FIELDS: [keyof Omit<InsightSettings, "anomalyEnabled">, string, number, number, number][] = [
  ["baselineDays", "Anomaly baseline days", 14, 90, 1], ["minSamples", "Minimum measured baseline days", 7, 90, 1],
  ["sensitivity", "Anomaly sensitivity (higher means fewer alerts)", 1.5, 10, 0.5], ["minChangePercent", "Minimum change (%)", 0, 1000, 1], ["minAbsoluteChange", "Minimum change (units)", 0, 1000000, 1],
  ["dormantDays", "Dormancy lookback (days)", 7, 90, 1], ["dormantViews", "Active if views reach", 1, 100000000, 1], ["dormantSignups", "Active if signups reach", 1, 1000000, 1],
  ["diskPercent", "Disk timeline threshold (%)", 1, 100, 1], ["gpuBusyPercent", "GPU busy threshold (%)", 1, 100, 1],
];
export function Insights() {
  const { data, error, reload } = useApi(() => call<InsightsReport>("/insights"), []);
  const [settings, setSettings] = useState<InsightSettings | null>(null);
  const [json, setJson] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const current = settings ?? data?.settings;
  async function write(fn: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage("");
    try { await fn(); reload(); setMessage(success); window.dispatchEvent(new Event("opc:data-changed")); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  return <><TopBar label="Insights" /><PageShell title="Workspace insights" sub="Measured trends, quiet ventures and unusual changes from your connected data." wide>
    {error && <p role="alert">{error}</p>}{!data && !error && <p>Loading insights…</p>}
    {data && <div className="space-y-7">
      <nav className="flex flex-wrap gap-4 text-sm"><Link className="underline" to="/alerts">Alert incidents</Link><Link className="underline" to="/activity/journal">Work journal</Link><Link className="underline" to="/activity/infrastructure">Infrastructure timeline</Link></nav>
      <section className="space-y-3"><h2 className="font-medium">At this pace</h2><PacePanel pace={data.pace} /></section>
      <section className="space-y-3"><h2 className="font-medium">Dormant ventures</h2><DormantPanel ventures={data.dormancy} costs={data.dormantCosts} complete={data.dormantCostsComplete} /></section>
      <section className="space-y-3"><h2 className="font-medium">Automatic anomaly detection</h2><p className="text-xs text-muted-foreground">Complete daily traffic, signup and custom measurements are checked after collection. Active incidents retain their original baseline until recovery. Disable individual watches in Alerts.</p>
        <div className="divide-y">{data.anomalies.map(a => <div key={a.id} className="flex flex-wrap gap-3 py-2 text-sm"><span>{a.label}</span><span className="ml-auto text-muted-foreground">{a.result.state} · {a.result.reason ?? `${a.result.value} on ${a.result.day}`}</span></div>)}{!data.anomalies.length && <p className="text-sm text-muted-foreground">Connect analytics or user data, or import a daily series below.</p>}</div>
      </section>
      {current && <form className="space-y-4 rounded-xl border bg-card p-4" onSubmit={e => { e.preventDefault(); void write(async () => { await call("/insights/settings", { method: "PATCH", body: JSON.stringify(current) }); setSettings(null); }, "Settings saved."); }}><h2 className="font-medium">Detection settings</h2>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={current.anomalyEnabled} onChange={e => setSettings({ ...current, anomalyEnabled: e.target.checked })} />Automatically watch daily data for unusual changes</label>
        <div className="grid gap-4 sm:grid-cols-2">{FIELDS.map(([key, label, min, max, step]) => <label key={key} className="space-y-1 text-xs text-muted-foreground"><span>{label}</span><Input type="number" min={min} max={max} step={step} value={current[key]} onChange={e => setSettings({ ...current, [key]: Number(e.target.value) })} required /></label>)}</div>
        <p className="text-xs text-muted-foreground">Dormancy groups ventures with enough measured history, low activity, no tracked work, and no reported revenue. Unknown data stays visible. Revenue checks conservatively include the months touched by the lookback. Existing incident bounds stay fixed when sensitivity changes.</p><Button disabled={busy}>Save settings</Button>
      </form>}
      <section className="space-y-3"><h2 className="font-medium">Connected series</h2><details><summary className="cursor-pointer text-sm">{data.sources.length} daily data sources</summary><div className="divide-y">{data.sources.map(s => <div key={s.id} className="py-2 text-sm"><p>{s.label} <span className="text-muted-foreground">· {s.source} · {s.unit}</span></p><p className="text-xs text-muted-foreground">Complete through {s.completeThrough || "not reported"}{s.unavailable ? ` · ${s.unavailable}` : ""}</p></div>)}</div></details></section>
      <form className="space-y-3 rounded-xl border p-4" onSubmit={e => { e.preventDefault(); void write(async () => { const source = JSON.parse(json); await call("/insights/sources", { method: "POST", body: JSON.stringify(source) }); setJson(""); }, "Daily series imported. The next alert check will evaluate it."); }}>
        <h2 className="font-medium">Bring your own daily data</h2><p className="text-xs text-muted-foreground">Use the same source id for later updates. Metric: mrr, users, signups, pageviews or custom. Supply actual collection time, complete days, and null for missing values. MRR sources each use one currency. Scripts can send the same JSON to POST /api/insights/sources with your normal API authentication.</p>
        <Textarea aria-label="Daily data JSON" rows={9} value={json} onChange={e => setJson(e.target.value)} placeholder={'{"id":"my-product-users","label":"My product users","metric":"users","unit":"users","ventureId":null,"observedAt":"ISO collection timestamp","completeThrough":"YYYY-MM-DD","points":[{"day":"YYYY-MM-DD","value":123}]}'} />
        <Button disabled={busy || !json.trim()}>Import daily series</Button>
      </form>
      {data.notes.length > 0 && <p className="text-xs text-muted-foreground">{data.notes.join(" · ")}</p>}
    </div>}
    {message && <p role="status" className="mt-4 text-sm">{message}</p>}
  </PageShell></>;
}
