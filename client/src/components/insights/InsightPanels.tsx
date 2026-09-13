import { Link } from "react-router-dom";
import type { Dormancy, Pace } from "../../../../shared/insights";
import { shiftDay } from "../../../../shared/workJournal";

import { insightNumber } from "@/lib/insightFormat";

function PaceChart({ pace }: { pace: Pace }) {
  const points = pace.points;
  if (points.length < 2) return null;
  const first = Date.parse(points[0]!.day), last = points.at(-1)!;
  const end = pace.projected === null ? Date.parse(last.day) : Date.parse(shiftDay(last.day, pace.horizonDays));
  const values = [...points.map(p => p.value), ...(pace.projected === null ? [] : [pace.projected])];
  const lo = Math.min(...values), hi = Math.max(...values), spread = Math.max(hi - lo, 1);
  const x = (day: string) => 4 + (Date.parse(day) - first) / Math.max(end - first, 1) * 432;
  const y = (n: number) => 78 - (n - lo) / spread * 62;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.day)},${y(p.value)}`).join(" ");
  return <svg viewBox="0 0 440 100" className="mt-3 w-full overflow-visible" role="img" aria-label={`${pace.label}: measured trend${pace.projected === null ? "" : " with a dashed 30-day projection"}`}>
    <path d={path} fill="none" stroke="var(--chart-line-1)" strokeWidth="2" />
    {pace.projected !== null && <path d={`M${x(last.day)},${y(last.value)} L436,${y(pace.projected)}`} fill="none" stroke="var(--chart-line-2)" strokeWidth="2" strokeDasharray="5 4" />}
    <text x="4" y="97" fill="currentColor" opacity="0.55" fontSize="9">{points[0]!.day}</text><text x="436" y="97" textAnchor="end" fill="currentColor" opacity="0.55" fontSize="9">{new Date(end).toISOString().slice(0, 10)}</text>
  </svg>;
}
export function PacePanel({ pace }: { pace: Pace[] }) {
  const ready = pace.filter(p => p.projected !== null), waiting = pace.filter(p => p.projected === null);
  return <div className="space-y-3"><div className="grid gap-4 sm:grid-cols-2">{ready.map(p => <section key={p.id} className="min-w-0 rounded-xl border p-3">
    <h3 className="text-sm font-medium">{p.label}</h3>
    {p.projected !== null ? <><p className="mt-2 text-2xl font-semibold tabular-nums">{insightNumber(p.projected, p.unit)}</p><p className="text-xs text-muted-foreground">In {p.horizonDays} days from {p.through}, at the recent pace</p><p className="mt-1 text-xs">{p.perWeek !== null && `${p.perWeek >= 0 ? "+" : ""}${insightNumber(p.perWeek, p.unit)}/week`} · latest {p.current !== null && insightNumber(p.current, p.unit)}</p></> : <p className="mt-2 text-sm text-muted-foreground">{p.reason}</p>}
    <PaceChart pace={p} />
    <p className="mt-2 text-[11px] text-muted-foreground">{p.samples} measured days. Solid: observed. Dashed: projected if the trend continues.</p>
  </section>)}{!pace.length && <p className="text-sm text-muted-foreground">Connect a revenue or user data source, or <Link className="underline" to="/insights">import daily measurements</Link>, to see projections.</p>}</div>
    {waiting.length > 0 && <details className="rounded-xl border p-3"><summary className="cursor-pointer text-sm">{waiting.length} series waiting for enough reliable history</summary><p className="mt-2 text-xs text-muted-foreground">Projections appear after at least 14 measured days. Missing or stale data never becomes a forecast.</p><div className="mt-3 divide-y">{waiting.map(p => <div key={p.id} className="py-2 text-xs"><p className="font-medium">{p.label} · {p.samples} measured days</p><p className="text-muted-foreground">{p.reason}</p></div>)}</div></details>}
  </div>;
}
export function DormantPanel({ ventures, costs, complete }: { ventures: Dormancy[]; costs: { currency: string; amount: number }[]; complete: boolean }) {
  const dormant = ventures.filter(v => v.status === "dormant"), unknown = ventures.filter(v => v.status === "unknown");
  return <div className="space-y-3">
    <p className="text-sm">{dormant.length} dormant ventures · {costs.length ? costs.map(c => insightNumber(c.amount, c.currency)).join(" + ") : "No priced running costs"}{costs.length ? "/month" : ""}{!complete && " · some costs are unpriced"}</p>
    <details className="rounded-xl border p-3"><summary className="cursor-pointer text-sm">Show dormant ventures</summary><div className="mt-3 space-y-3">{dormant.map(v => <div key={v.id}><p className="font-medium text-sm">{v.name}</p><p className="text-xs text-muted-foreground">{v.reasons.join(" · ")}</p><p className="text-xs">{v.costs.map(c => insightNumber(c.amount, c.currency)).join(" + ") || "No priced costs"}</p></div>)}{!dormant.length && <p className="text-xs text-muted-foreground">No ventures meet the dormancy criteria.</p>}</div></details>
    {unknown.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{unknown.length} ventures need more data</summary>{unknown.map(v => <p className="mt-2" key={v.id}>{v.name}: {v.reasons.join(" · ")}</p>)}</details>}
    <Link className="text-xs underline text-muted-foreground" to="/insights">Configure activity limits and data sources</Link>
  </div>;
}
export type InfrastructureEvent = { key: string; ts: string; title: string; source: string };
export function InfrastructurePanel({ events }: { events: InfrastructureEvent[] }) {
  return <div className="space-y-3"><div className="max-h-96 space-y-3 overflow-y-auto" role="region" aria-label="Recent infrastructure transitions" tabIndex={0}>{events.map(e => <div key={e.key} className="border-l-2 pl-3"><p className="text-sm">{e.title}</p><p className="mt-1 text-xs text-muted-foreground">{new Date(e.ts).toLocaleString()} · {e.source}</p></div>)}{!events.length && <p className="text-sm text-muted-foreground">No infrastructure transitions recorded yet. Connected server, site and workstation collectors record changes automatically.</p>}</div><Link className="inline-block text-xs underline text-muted-foreground" to="/activity/infrastructure">Open infrastructure timeline</Link></div>;
}
