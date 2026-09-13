import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { finance } from "@/lib/api/finance";
import { journeyApi } from "@/lib/api/ventureJourney";
import type { Venture } from "@/lib/api";
import { useApi } from "@/hooks/useApi";
import { SignalChart } from "./SignalChart";
import { ErrorNotice } from "./JourneyForms";
const amounts = (rows: { currency: string; amount: number }[]) => rows.length ? rows.map(r => `${r.currency} ${r.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`).join(" · ") : "No recorded amount";
export function JourneyPerformance({ venture }: { venture: Venture }) {
  const money = useApi(() => finance.venture(venture.id), [venture.id]);
  const signals = useApi(() => journeyApi.signals(venture.id), [venture.id]);
  const [showAll, setShowAll] = useState(false);
  const doc = money.data, series = signals.data?.series ?? [];
  const anomalies = series.filter(s => s.anomaly.state === "anomaly");
  const unmeasured = series.filter(s => s.anomaly.state === "warming" || s.anomaly.state === "unavailable").length;
  return <section className="mb-6" aria-label="Venture performance">
    <div className="journey-card-header"><div><h2 className="font-medium">The business, at a glance</h2><p className="journey-muted">Recorded figures for {venture.name}. Currencies and source coverage stay separate.</p></div><button aria-label="Refresh venture performance" disabled={money.loading || signals.loading} onClick={() => { money.reload(); signals.reload(); }}><RefreshCw className="size-4" /></button></div>
    <ErrorNotice error={money.error} /><ErrorNotice error={signals.error} />
    <div className="journey-stats">
      <div className="journey-stat"><p className="journey-muted">Net revenue recorded · {doc?.month ?? "this month"}</p><div className="journey-stat-value text-[24px]!">{doc ? amounts(doc.revenue.net.amounts) : money.loading ? "Reading…" : "Unavailable"}</div><p className="journey-muted">{doc?.actual ? "Closed month" : "Month to date"} · {doc?.revenue.unavailable.length ? "Incomplete source coverage" : "From attributed revenue sources"}</p></div>
      <div className="journey-stat"><p className="journey-muted">Monthly costs recorded</p><div className="journey-stat-value text-[24px]!">{doc ? amounts(doc.costs.ledgerTotal.amounts) : money.loading ? "Reading…" : "Unavailable"}</div><p className="journey-muted">Direct + allocated · {doc?.costs.complete ? "Ledger priced" : "Coverage incomplete"}{doc?.modelSpend.usd != null ? ` · Model use separately: USD ${doc.modelSpend.usd.toFixed(2)}` : ""}</p></div>
      <div className="journey-stat"><p className="journey-muted">Signals needing a look</p><div className="journey-stat-value">{signals.loading && !signals.data ? "Reading…" : signals.error && !signals.data ? "Unavailable" : anomalies.length || (series.length && !unmeasured ? "No deviations" : "Not measured")}</div><p className="journey-muted">{series.length ? `${series.length} linked daily series${unmeasured ? ` · ${unmeasured} need more or fresher data` : ""}. This is not an uptime check.` : "Connect a source or import your business metrics."}</p></div>
    </div>
    {doc && (doc.revenue.unavailable.length > 0 || doc.costs.unpriced.length > 0) && <details className="journey-muted mb-4"><summary>What these figures cannot tell us yet</summary><ul className="mt-2 list-disc pl-5">{[...doc.revenue.unavailable, ...doc.costs.unpriced].map((n, i) => <li key={i}>{n}</li>)}</ul><Link className="underline" to="/finance">Review revenue attribution and costs</Link></details>}
    {!!signals.data?.notes.length && <details className="journey-muted mb-4"><summary>Some sources could not be read</summary>{signals.data.notes.map(n => <p key={n}>{n}</p>)}</details>}
    <div className="grid gap-4 lg:grid-cols-2">{(showAll ? series : series.slice(0, 4)).map(({ source, pace, anomaly }) => <article className="journey-card" key={source.id}>
      <div className="journey-card-header"><h2>{source.label}</h2><span className="journey-tag">{source.unit}</span></div>
      <div className="flex flex-wrap items-baseline justify-between gap-2"><span className="journey-stat-value m-0!">{pace.current?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "Not measured"}</span><span className="journey-muted">Last measured · {pace.through ?? "no date"}</span></div>
      <SignalChart points={pace.points} label={source.label} unit={source.unit} />
      <p className="journey-muted">{pace.projected === null ? pace.reason : `At this pace, the daily reading would be ${pace.projected.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${source.unit} in ${pace.horizonDays} days. This assumes the recent trend continues.`}</p>
      {anomaly.state === "anomaly" && <p className="journey-note mt-3">Outside its recent baseline. Review the source and customer context before acting.</p>}
      <details className="journey-muted mt-3"><summary>Source & measured days</summary><p>Source: {source.source} · Collected {source.observedAt ?? "unknown"}</p><div className="mt-2 max-h-44 overflow-y-auto"><table className="w-full text-left"><thead><tr><th scope="col">Day</th><th scope="col">{source.unit}</th></tr></thead><tbody>{pace.points.map(p => <tr key={p.day}><td>{p.day}</td><td>{p.value.toLocaleString()}</td></tr>)}</tbody></table></div></details>
    </article>)}</div>
    {series.length > 4 && <button className="journey-muted mt-3 underline" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer signals" : `Show all ${series.length} signals`}</button>}
    {!series.length && !signals.loading && <div className="journey-card flex flex-wrap items-center justify-between gap-4"><div><h2>Make this dashboard work for your business.</h2><p className="journey-muted mt-2">Link an app or website, or import daily sales, orders, bookings or another measure with this venture’s ID.</p></div><div className="flex gap-4"><Link to={`/ventures/${venture.slug}/connections`} className="flex items-center gap-1 text-sm">Link sources <ArrowUpRight className="size-4" /></Link><Link to="/insights" className="flex items-center gap-1 text-sm">Import metrics <ArrowUpRight className="size-4" /></Link></div></div>}
  </section>;
}
